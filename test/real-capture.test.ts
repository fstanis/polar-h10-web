/**
 * Replay tests against verbatim wire traffic captured from a real Polar H10
 * (see helpers/captured.ts). Where a decoded expectation is asserted, it is the
 * value the library produced live against the physical sensor, hand-verified
 * against the raw bytes.
 */
import { describe, expect, test } from 'bun:test';
import { fromBinary } from '@bufbuild/protobuf';
import { connect } from '../src/device.js';
import { PftpError } from '../src/errors.js';
import { bytes } from './helpers/bytes.js';
import * as U from '../src/gatt/uuids.js';
import { parseHrMeasurement } from '../src/gatt/hrClient.js';
import { systemIdToHex } from '../src/gatt/deviceInfo.js';
import {
  buildGetSettings,
  buildStartMeasurement,
  buildStopMeasurement,
  parseControlPointResponse,
} from '../src/pmd/controlPoint.js';
import { decodeAccFrame, decodeEcgFrame, parsePmdFrameHeader } from '../src/pmd/frame.js';
import { parseSettings } from '../src/pmd/settings.js';
import { PmdControlPointStatus, PmdMeasurementType, PmdSettingType } from '../src/pmd/types.js';
import {
  PbPFtpSetLocalTimeParamsSchema,
  PbPFtpRequestStartRecordingParamsSchema,
} from '../src/proto/gen/pftp_request_pb.js';
import { PbSampleType } from '../src/proto/gen/types_pb.js';
import { FakeDevice } from './helpers/fakeDevice.js';
import {
  ACC_50HZ_2G,
  ACC_200HZ_8G,
  BATTERY_READ,
  DIS_READS,
  ECG_EXPECTED,
  ECG_FRAMES,
  ECG_STREAM_CONTROL,
  HR_EXPECTED,
  HR_NOTIFICATIONS,
  PMD_FEATURE_READ,
  PSFTP_EXCHANGES,
  SDK_MODE_REJECTIONS,
  SETTINGS_EXCHANGES,
  stats,
  type CapturedAccStream,
  type CapturedExchange,
} from './helpers/captured.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const hex = (data: Uint8Array) =>
  Array.from(data, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * Script the PMD control point with captured exchanges: each host write must
 * byte-match a captured command, and is answered with the captured response.
 */
function installCapturedPmd(fake: FakeDevice, exchanges: CapturedExchange[]): void {
  const cp = fake.char(U.PMD_SERVICE, U.PMD_CONTROL_POINT_CHAR);
  cp.readBytes = bytes(PMD_FEATURE_READ);
  const byWrite = new Map(exchanges.map((exchange) => [exchange.write, exchange.response]));
  cp.onWrite = (written) => {
    const response = byWrite.get(hex(written));
    if (!response) {
      throw new Error(`unscripted PMD command: ${hex(written)}`);
    }
    queueMicrotask(() => cp.notify(bytes(response)));
  };
}

/**
 * Script PSFTP with captured transactions keyed by the reassembled request
 * envelope. Time-setting envelopes embed the current clock, so those match on
 * their 2-byte query id instead of the full envelope.
 */
function installCapturedPsftp(
  fake: FakeDevice,
  exchanges: Iterable<(typeof PSFTP_EXCHANGES)[keyof typeof PSFTP_EXCHANGES]>,
): void {
  const mtu = fake.char(U.PSFTP_SERVICE, U.PSFTP_MTU_CHAR);
  const byEnvelope = new Map<string, readonly string[]>();
  const byQueryId = new Map<string, readonly string[]>();
  for (const exchange of exchanges) {
    byEnvelope.set(exchange.envelope, exchange.responseFrames);
    byQueryId.set(exchange.envelope.slice(0, 5), exchange.responseFrames);
  }
  let pending: string[] = [];
  mtu.onWrite = (packet) => {
    const status = (packet[0]! >> 1) & 0x03;
    if (status === 0) return; // host cancel
    pending.push(hex(packet.subarray(1)));
    if (status !== 0x01) return; // MORE — keep buffering
    const envelope = pending.join(' ');
    pending = [];
    const frames = byEnvelope.get(envelope) ?? byQueryId.get(envelope.slice(0, 5));
    if (!frames) {
      throw new Error(`unscripted PSFTP envelope: ${envelope}`);
    }
    queueMicrotask(() => {
      for (const frame of frames) mtu.notify(bytes(frame));
    });
  };
}

function connectedFake(options: { psftp?: Iterable<(typeof PSFTP_EXCHANGES)[keyof typeof PSFTP_EXCHANGES]> } = {}) {
  const fake = new FakeDevice();
  fake.buildServices();
  installCapturedPmd(fake, [
    SETTINGS_EXCHANGES.ecg,
    SETTINGS_EXCHANGES.acc,
    ECG_STREAM_CONTROL.start,
    ECG_STREAM_CONTROL.stop,
    ACC_50HZ_2G.control.start,
    ACC_50HZ_2G.control.stop,
    ACC_200HZ_8G.control.start,
    ACC_200HZ_8G.control.stop,
  ]);
  if (options.psftp) {
    installCapturedPsftp(fake, options.psftp);
  }
  return fake;
}

describe('PMD control point against captured traffic', () => {
  test('command builders emit the exact bytes seen on the wire', () => {
    expect(hex(buildGetSettings(PmdMeasurementType.Ecg))).toBe(SETTINGS_EXCHANGES.ecg.write);
    expect(hex(buildGetSettings(PmdMeasurementType.Acc))).toBe(SETTINGS_EXCHANGES.acc.write);
    expect(hex(buildStopMeasurement(PmdMeasurementType.Ecg))).toBe(ECG_STREAM_CONTROL.stop.write);
    expect(
      hex(
        buildStartMeasurement(PmdMeasurementType.Ecg, {
          [PmdSettingType.SampleRate]: 130,
          [PmdSettingType.Resolution]: 14,
        }),
      ),
    ).toBe(ECG_STREAM_CONTROL.start.write);
    expect(
      hex(
        buildStartMeasurement(PmdMeasurementType.Acc, {
          [PmdSettingType.SampleRate]: 200,
          [PmdSettingType.Resolution]: 16,
          [PmdSettingType.Range]: 8,
        }),
      ),
    ).toBe(ACC_200HZ_8G.control.start.write);
  });

  test('the real ECG settings response parses to 130 Hz / 14-bit', () => {
    const response = parseControlPointResponse(bytes(SETTINGS_EXCHANGES.ecg.response));
    expect(response.status).toBe(PmdControlPointStatus.Success);
    const settings = parseSettings(response.parameters);
    expect(settings.get(PmdSettingType.SampleRate)).toEqual([130]);
    expect(settings.get(PmdSettingType.Resolution)).toEqual([14]);
  });

  test('the real ACC settings response parses to full rate/range matrix', () => {
    const response = parseControlPointResponse(bytes(SETTINGS_EXCHANGES.acc.response));
    const settings = parseSettings(response.parameters);
    expect(settings.get(PmdSettingType.SampleRate)).toEqual([25, 50, 100, 200]);
    expect(settings.get(PmdSettingType.Resolution)).toEqual([16]);
    expect(settings.get(PmdSettingType.Range)).toEqual([2, 4, 8]);
  });

  test('the feature read advertises ECG and ACC only', () => {
    const features = bytes(PMD_FEATURE_READ);
    expect(features[1]).toBe(0x05);
    expect(features.subarray(2).every((byte) => byte === 0)).toBe(true);
  });

  test('every SDK-mode command is rejected by H10 firmware', () => {
    const expectedStatus = {
      getSdkModeAccSettings: PmdControlPointStatus.ErrorInvalidOpCode,
      getSdkModeStatus: PmdControlPointStatus.ErrorInvalidOpCode,
      enableSdkMode: PmdControlPointStatus.ErrorInvalidMeasurementType,
      disableSdkMode: PmdControlPointStatus.ErrorInvalidMeasurementType,
    } as const;
    for (const [name, exchange] of Object.entries(SDK_MODE_REJECTIONS)) {
      const response = parseControlPointResponse(bytes(exchange.response));
      expect(response.status).toBe(expectedStatus[name as keyof typeof expectedStatus]);
      expect(response.parameters).toHaveLength(0);
    }
  });
});

describe('ECG stream replay', () => {
  test('captured frames are uncompressed type 0', () => {
    for (const frame of ECG_FRAMES) {
      const header = parsePmdFrameHeader(bytes(frame));
      expect(header.measurementType).toBe(PmdMeasurementType.Ecg);
      expect(header.frameType).toBe(0);
      expect(header.compressed).toBe(false);
    }
  });

  test('frame decoder reproduces the live µV values', () => {
    const microVolts = ECG_FRAMES.flatMap((frame) => decodeEcgFrame(bytes(frame)).microVolts);
    expect(stats(microVolts)).toEqual({ count: ECG_EXPECTED.count, ...ECG_EXPECTED.microVolts });
    expect(microVolts.slice(0, ECG_EXPECTED.first.length)).toEqual(ECG_EXPECTED.first.map((s) => s.microVolts));
  });

  test('full stream replay reproduces samples and timestamps exactly', async () => {
    const fake = connectedFake();
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    const iterator = h10.streamEcg();
    const first = iterator.next();
    await tick();
    for (const frame of ECG_FRAMES) {
      fake.char(U.PMD_SERVICE, U.PMD_DATA_CHAR).notify(bytes(frame));
    }
    const samples = [await (await first).value!];
    while (samples.length < ECG_EXPECTED.count) {
      samples.push((await iterator.next()).value!);
    }
    await iterator.return!();

    expect(stats(samples.map((s) => s.microVolts))).toEqual({ count: ECG_EXPECTED.count, ...ECG_EXPECTED.microVolts });
    for (const [index, expected] of ECG_EXPECTED.first.entries()) {
      expect(samples[index]).toEqual(expected);
    }
    expect(samples.slice(-ECG_EXPECTED.last.length)).toEqual(ECG_EXPECTED.last);
  });
});

describe('ACC stream replay', () => {
  test('captured frames are RAW type 1 — not delta-compressed', () => {
    for (const frame of [...ACC_50HZ_2G.frames, ...ACC_200HZ_8G.frames]) {
      const header = parsePmdFrameHeader(bytes(frame));
      expect(header.measurementType).toBe(PmdMeasurementType.Acc);
      expect(header.frameType).toBe(1);
      expect(header.compressed).toBe(false);
      expect(decodeAccFrame(bytes(frame), 1).samples).toHaveLength(36);
    }
  });

  const replay = (captured: CapturedAccStream, config: { sampleRate: number; range: number }) =>
    test(`full ${config.sampleRate} Hz / ${config.range} G replay reproduces samples and timestamps`, async () => {
      const fake = connectedFake();
      const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

      const iterator = h10.streamAcc(config);
      const first = iterator.next();
      await tick();
      for (const frame of captured.frames) {
        fake.char(U.PMD_SERVICE, U.PMD_DATA_CHAR).notify(bytes(frame));
      }
      const samples = [await (await first).value!];
      while (samples.length < captured.expected.count) {
        samples.push((await iterator.next()).value!);
      }
      await iterator.return!();

      expect(stats(samples.map((s) => s.x))).toEqual({ count: captured.expected.count, ...captured.expected.x });
      expect(stats(samples.map((s) => s.y))).toEqual({ count: captured.expected.count, ...captured.expected.y });
      expect(stats(samples.map((s) => s.z))).toEqual({ count: captured.expected.count, ...captured.expected.z });
      for (const [index, expected] of captured.expected.first.entries()) {
        expect(samples[index]).toEqual(expected);
      }
    });

  replay(ACC_50HZ_2G, { sampleRate: 50, range: 2 });
  replay(ACC_200HZ_8G, { sampleRate: 200, range: 8 });
});

describe('HR measurement replay', () => {
  test('twelve consecutive real notifications parse to the live values', () => {
    expect(HR_NOTIFICATIONS).toHaveLength(HR_EXPECTED.length);
    for (const [index, notification] of HR_NOTIFICATIONS.entries()) {
      const parsed = parseHrMeasurement(bytes(notification));
      const expected = HR_EXPECTED[index]!;
      expect(parsed.hr).toBe(expected.hr);
      expect(parsed.rrMs).toEqual(expected.rrMs);
      expect(parsed.rrRaw).toEqual(expected.rrRaw);
      expect(parsed.contactSupported).toBe(false);
      expect(parsed.contactDetected).toBe(false);
      expect(parsed.energyExpended).toBeUndefined();
    }
  });
});

describe('device information replay', () => {
  test('real DIS bytes decode to the H10 identity', async () => {
    const fake = connectedFake();
    fake.char(U.DIS_SERVICE, U.DIS_MODEL_NUMBER_CHAR).readBytes = bytes(DIS_READS.modelNumber.hex);
    fake.char(U.DIS_SERVICE, U.DIS_MANUFACTURER_NAME_CHAR).readBytes = bytes(DIS_READS.manufacturerName.hex);
    fake.char(U.DIS_SERVICE, U.DIS_HARDWARE_REVISION_CHAR).readBytes = bytes(DIS_READS.hardwareRevision.hex);
    fake.char(U.DIS_SERVICE, U.DIS_FIRMWARE_REVISION_CHAR).readBytes = bytes(DIS_READS.firmwareRevision.hex);
    fake.char(U.DIS_SERVICE, U.DIS_SOFTWARE_REVISION_CHAR).readBytes = bytes(DIS_READS.softwareRevision.hex);
    fake.char(U.DIS_SERVICE, U.DIS_SYSTEM_ID_CHAR).readBytes = bytes(DIS_READS.systemId.hex);
    fake.char(U.BATTERY_SERVICE, U.BATTERY_LEVEL_CHAR).readBytes = bytes(BATTERY_READ.hex);

    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });
    const info = await h10.readDeviceInfo();
    expect(info.modelNumber).toBe(DIS_READS.modelNumber.value);
    expect(info.manufacturerName).toBe(DIS_READS.manufacturerName.value);
    expect(info.hardwareRevision).toBe(DIS_READS.hardwareRevision.value);
    expect(info.firmwareRevision).toBe(DIS_READS.firmwareRevision.value);
    expect(info.softwareRevision).toBe(DIS_READS.softwareRevision.value);
    expect(info.systemId).toBe(DIS_READS.systemId.value);
    expect(await h10.readBattery()).toBe(BATTERY_READ.value);
  });

  test('systemId renders reverse-order hex', () => {
    expect(systemIdToHex(bytes(DIS_READS.systemId.hex))).toBe(DIS_READS.systemId.value);
  });
});

describe('PSFTP recording lifecycle replay', () => {
  test('status: idle, recording, and stopped-with-retained-identifier', async () => {
    const fake = connectedFake({ psftp: [PSFTP_EXCHANGES.statusOff] });
    const h10 = await connect(fake.asBluetoothDevice());
    expect(await h10.recordings.status()).toEqual({ recording: false, identifier: '' });

    installCapturedPsftp(fake, [PSFTP_EXCHANGES.statusOn]);
    expect(await h10.recordings.status()).toEqual({ recording: true, identifier: 'tracer-session' });

    installCapturedPsftp(fake, [PSFTP_EXCHANGES.statusStopped]);
    expect(await h10.recordings.status()).toEqual({ recording: false, identifier: 'tracer-session' });
  });

  test('list: factory file system yields no recordings', async () => {
    const fake = connectedFake({ psftp: [PSFTP_EXCHANGES.listRootEmpty] });
    const h10 = await connect(fake.asBluetoothDevice());
    expect(await h10.recordings.list()).toEqual([]);
  });

  test('list → fetch → remove replays the captured session', async () => {
    const fake = connectedFake({
      psftp: [
        PSFTP_EXCHANGES.listRootWithRecording,
        PSFTP_EXCHANGES.listSessionDir,
        PSFTP_EXCHANGES.fetchSamples,
        PSFTP_EXCHANGES.removeSamples,
      ],
    });
    const h10 = await connect(fake.asBluetoothDevice());

    const entries = await h10.recordings.list();
    expect(entries).toEqual([{ path: '/tracer-session/SAMPLES.BPB', identifier: 'tracer-session', sizeBytes: 17 }]);

    const data = await h10.recordings.fetch(entries[0]!);
    expect(data).toEqual({
      intervalSeconds: 1,
      type: 'hr',
      samples: [0, 68, 69, 69, 71, 71, 70, 70, 70, 70, 71],
    });

    await h10.recordings.remove(entries[0]!);
  });

  test('start/stop recording emit byte-identical envelopes to the capture', async () => {
    const fake = connectedFake({ psftp: [PSFTP_EXCHANGES.startRecording, PSFTP_EXCHANGES.stopRecording] });
    const h10 = await connect(fake.asBluetoothDevice());
    await h10.recordings.start('tracer-session', { type: 'hr', interval: 1 });
    await h10.recordings.stop();
  });

  test('RR and 5 s-interval recordings replay the captured session', async () => {
    const fake = connectedFake({
      psftp: [PSFTP_EXCHANGES.startRecordingRrFiveSeconds, PSFTP_EXCHANGES.fetchRrSamples],
    });
    const h10 = await connect(fake.asBluetoothDevice());
    const entry = { path: '/tracer-session/SAMPLES.BPB', identifier: 'tracer-session', sizeBytes: 15 };

    // Byte-matches the captured RR @ 5 s envelope (sample type 16, interval 5).
    await h10.recordings.start('tracer-session', { type: 'rr', interval: 5 });
    expect(await h10.recordings.fetch(entry)).toEqual({
      intervalSeconds: 1,
      type: 'rr',
      samples: [720, 743, 769],
    });

    installCapturedPsftp(fake, [PSFTP_EXCHANGES.fetchHrFiveSecondInterval]);
    expect(await h10.recordings.fetch(entry)).toEqual({
      intervalSeconds: 5,
      type: 'hr',
      samples: [85],
    });
  });

  test('single-slot semantics: start while stored and stop while idle → 106', async () => {
    const fake = connectedFake({
      psftp: [PSFTP_EXCHANGES.startWhileSlotOccupied, PSFTP_EXCHANGES.stopWhileIdle],
    });
    const h10 = await connect(fake.asBluetoothDevice());

    // Byte-matches the captured RR @ 1 s envelope (sample type 16), then the real 106.
    const start = h10.recordings.start('tracer-session', { type: 'rr', interval: 1 });
    await expect(start).rejects.toBeInstanceOf(PftpError);
    await expect(start).rejects.toMatchObject({ errorId: 106 });

    const stop = h10.recordings.stop();
    await expect(stop).rejects.toBeInstanceOf(PftpError);
    await expect(stop).rejects.toMatchObject({ errorId: 106 });
  });

  test('setTime sends only SET_LOCAL_TIME', async () => {
    // Only the SET_LOCAL_TIME exchange is scripted — a stray SET_SYSTEM_TIME
    // write (which the H10 answers with 201) would throw as unscripted.
    const fake = connectedFake({ psftp: [PSFTP_EXCHANGES.setLocalTime] });
    const h10 = await connect(fake.asBluetoothDevice());
    await h10.setTime(new Date());
  });

  test('captured time and start-recording payloads decode with our protobuf codecs', () => {
    const localTime = fromBinary(
      PbPFtpSetLocalTimeParamsSchema,
      bytes(PSFTP_EXCHANGES.setLocalTime.envelope).subarray(2),
    );
    expect(localTime.date).toMatchObject({ year: 2026, month: 7, day: 18 });
    expect(localTime.time).toMatchObject({ hour: 22, minute: 36, seconds: 20, millis: 173 });
    expect(localTime.tzOffset).toBe(120);

    const startParams = fromBinary(
      PbPFtpRequestStartRecordingParamsSchema,
      bytes(PSFTP_EXCHANGES.startRecording.envelope).subarray(2),
    );
    expect(startParams.sampleDataIdentifier).toBe('tracer-session');
    expect(startParams.sampleType).toBe(PbSampleType.SAMPLE_TYPE_HEART_RATE);
    expect(startParams.recordingInterval?.seconds).toBe(1);
  });
});

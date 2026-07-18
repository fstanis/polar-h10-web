import { describe, expect, test } from 'bun:test';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { connect } from '../src/device.js';
import { ControlPointError, DisconnectedError, InvalidStateError } from '../src/errors.js';
import { PmdSettingType } from '../src/pmd/types.js';
import { bytes } from './helpers/bytes.js';
import * as U from '../src/gatt/uuids.js';
import {
  cpResponse,
  FakeDevice,
  installPmdResponder,
  installPsftpResponder,
  setDisString,
} from './helpers/fakeDevice.js';
import { PbPFtpOperationSchema, PbPFtpOperation_Command } from '../src/proto/gen/communications_pftp_request_pb.js';
import { PbPFtpQuery } from '../src/proto/gen/pftp_request_pb.js';
import {
  PbPFtpDirectorySchema,
  PbPFtpEntrySchema,
  PbRequestRecordingStatusResultSchema,
} from '../src/proto/gen/pftp_response_pb.js';
import { PbExerciseSamplesSchema } from '../src/proto/gen/exercise_samples_pb.js';
import { PbDurationSchema } from '../src/proto/gen/types_pb.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function freshFake(): FakeDevice {
  const fake = new FakeDevice();
  fake.buildServices();
  return fake;
}

/** A PSFTP responder that emulates the H10 recording file system + queries. */
function recordingResponder(env: Uint8Array): Uint8Array {
  const isQuery = (env[1]! & 0x80) !== 0;
  if (isQuery) {
    const id = env[0]! | ((env[1]! & 0x7f) << 8);
    if (id === PbPFtpQuery.REQUEST_RECORDING_STATUS) {
      return toBinary(
        PbRequestRecordingStatusResultSchema,
        create(PbRequestRecordingStatusResultSchema, { recordingOn: true, sampleDataIdentifier: 'session-42' }),
      );
    }
    return new Uint8Array(0); // start/stop/set-time → empty ack
  }
  // REQUEST (file op)
  const headerSize = env[0]! | (env[1]! << 8);
  const op = fromBinary(PbPFtpOperationSchema, env.subarray(2, 2 + headerSize));
  if (op.command === PbPFtpOperation_Command.REMOVE) return new Uint8Array(0);
  // GET
  if (op.path === '/') {
    return toBinary(
      PbPFtpDirectorySchema,
      create(PbPFtpDirectorySchema, { entries: [create(PbPFtpEntrySchema, { name: '577007856J/', size: 0n })] }),
    );
  }
  if (op.path === '/577007856J/') {
    return toBinary(
      PbPFtpDirectorySchema,
      create(PbPFtpDirectorySchema, { entries: [create(PbPFtpEntrySchema, { name: 'SAMPLES.BPB', size: 12n })] }),
    );
  }
  if (op.path === '/577007856J/SAMPLES.BPB') {
    return toBinary(
      PbExerciseSamplesSchema,
      create(PbExerciseSamplesSchema, {
        recordingInterval: create(PbDurationSchema, { seconds: 1 }),
        heartRateSamples: [60, 61, 62, 63],
      }),
    );
  }
  const err = new Error('no such file') as Error & { errorId: number };
  err.errorId = 103;
  throw err;
}

describe('connect + device info', () => {
  test('connects, reads battery and device information', async () => {
    const fake = freshFake();
    installPmdResponder(fake);
    installPsftpResponder(fake, recordingResponder);
    fake.char(U.BATTERY_SERVICE, U.BATTERY_LEVEL_CHAR).readBytes = new Uint8Array([87]);
    setDisString(fake, U.DIS_MODEL_NUMBER_CHAR, 'H10');
    setDisString(fake, U.DIS_FIRMWARE_REVISION_CHAR, '3.1.1');

    const h10 = await connect(fake.asBluetoothDevice());
    expect(h10.connected).toBe(true);
    expect(await h10.readBattery()).toBe(87);
    const info = await h10.readDeviceInfo();
    expect(info.modelNumber).toBe('H10');
    expect(info.firmwareRevision).toBe('3.1.1');
  });
});

describe('live streams', () => {
  test('ECG stream yields decoded µV samples', async () => {
    const fake = freshFake();
    const pmd = installPmdResponder(fake);
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    const it = h10.streamEcg();
    const first = it.next();
    await tick();
    pmd.emitData(bytes('00 00 94 35 77 00 00 00 00 00 02 80 FF 02 80 00'));
    const { value } = await first;
    expect(value!.microVolts).toBe(-32766);
    // Stopping sends STOP; verify a stop command was written.
    await it.return!();
    const cpWrites = fake.char(U.PMD_SERVICE, U.PMD_CONTROL_POINT_CHAR).writes;
    expect(cpWrites.some((w) => w[0] === 0x03 && w[1] === 0x00)).toBe(true);
  });

  test('ACC stream yields mG samples', async () => {
    const fake = freshFake();
    const pmd = installPmdResponder(fake);
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    const it = h10.streamAcc({ sampleRate: 50, range: 8 });
    const first = it.next();
    await tick();
    // Compressed ACC type 1, realistic frame timestamp so reconstruction succeeds.
    pmd.emitData(bytes('02 00 94 35 77 00 00 00 00 81 F1 FF 14 00 F0 03 06 01 7B 0F 08'));
    const { value } = await first;
    expect(value).toMatchObject({ x: -15, y: 20, z: 1008 });
    await it.return!();
  });

  test('HR stream yields beats and RR intervals', async () => {
    const fake = freshFake();
    installPmdResponder(fake);
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    const it = h10.streamHeartRate();
    const first = it.next();
    await tick();
    fake.char(U.HR_SERVICE, U.HR_MEASUREMENT_CHAR).notify(bytes('10 3C FF FF'));
    const { value } = await first;
    expect(value!.hr).toBe(60);
    expect(value!.rrMs).toEqual([63999]);
    await it.return!();
  });

  test('device-initiated measurement stop fails the stream', async () => {
    const fake = freshFake();
    const pmd = installPmdResponder(fake);
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    const it = h10.streamEcg();
    const first = it.next();
    await tick();
    pmd.emitData(bytes('00 00 94 35 77 00 00 00 00 00 02 80 FF'));
    await first;
    // Unsolicited ONLINE_MEASUREMENT_STOPPED notification for ECG (type 0).
    fake.char(U.PMD_SERVICE, U.PMD_CONTROL_POINT_CHAR).notify(bytes('01 00'));
    await expect(it.next()).rejects.toBeInstanceOf(InvalidStateError);
  });

  test('control-point rejection surfaces as ControlPointError', async () => {
    const fake = freshFake();
    const pmd = installPmdResponder(fake);
    pmd.setFailStart(8); // ERROR_INVALID_SAMPLE_RATE
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });
    await expect(h10.streamEcg().next()).rejects.toBeInstanceOf(ControlPointError);
  });

  test('a stale control-point response with the wrong opcode is discarded', async () => {
    const fake = freshFake();
    installPmdResponder(fake);
    const cp = fake.char(U.PMD_SERVICE, U.PMD_CONTROL_POINT_CHAR);
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    const respond = cp.onWrite!;
    cp.onWrite = (written) => {
      cp.notify(cpResponse(0x03, 0x02, 0x00)); // stray STOP echo from an earlier command
      respond(written);
    };
    const settings = await h10.getEcgSettings();
    expect(settings.get(PmdSettingType.SampleRate)).toEqual([130]);
  });

  test('non-stop device-initiated notifications leave the stream running', async () => {
    const fake = freshFake();
    const pmd = installPmdResponder(fake);
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    const it = h10.streamEcg();
    const first = it.next();
    await tick();
    pmd.emitData(bytes('00 00 94 35 77 00 00 00 00 00 02 80 FF'));
    await first;
    // Unsolicited notification with a command other than ONLINE_MEASUREMENT_STOPPED.
    fake.char(U.PMD_SERVICE, U.PMD_CONTROL_POINT_CHAR).notify(bytes('02 00'));
    const second = it.next();
    pmd.emitData(bytes('00 00 94 35 78 00 00 00 00 00 02 80 FF'));
    expect((await second).value!.microVolts).toBe(-32766);
    await it.return!();
  });
});

describe('recording flow', () => {
  test('start → status → list → fetch → remove → set time', async () => {
    const fake = freshFake();
    installPmdResponder(fake);
    installPsftpResponder(fake, recordingResponder);
    const h10 = await connect(fake.asBluetoothDevice());

    await h10.recordings.start('session-42', { type: 'hr', interval: 1 });
    const status = await h10.recordings.status();
    expect(status).toEqual({ recording: true, identifier: 'session-42' });

    const list = await h10.recordings.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe('/577007856J/SAMPLES.BPB');
    expect(list[0]!.identifier).toBe('577007856J');

    let progressSeen = 0;
    const data = await h10.recordings.fetch(list[0]!, (n) => (progressSeen = n));
    expect(data.type).toBe('hr');
    expect(data.intervalSeconds).toBe(1);
    expect(data.samples).toEqual([60, 61, 62, 63]);
    expect(progressSeen).toBeGreaterThan(0);

    await h10.recordings.remove(list[0]!);
    const removeWrite = fake.char(U.PSFTP_SERVICE, U.PSFTP_MTU_CHAR).writes;
    expect(removeWrite.length).toBeGreaterThan(0);

    await h10.setTime(new Date());
  });
});

describe('disconnect handling', () => {
  test('dropping the link terminates streams and fires disconnect', async () => {
    const fake = freshFake();
    installPmdResponder(fake);
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    let disconnectFired = false;
    h10.addEventListener('disconnect', () => (disconnectFired = true));

    const it = h10.streamHeartRate();
    const first = it.next();
    await tick();

    fake.gatt.disconnect();

    await expect(first).rejects.toBeInstanceOf(DisconnectedError);
    expect(disconnectFired).toBe(true);
    expect(h10.connected).toBe(false);
  });

  test('aborting a stream stops it gracefully', async () => {
    const fake = freshFake();
    installPmdResponder(fake);
    const h10 = await connect(fake.asBluetoothDevice(), { skipRecording: true });

    const controller = new AbortController();
    const received: number[] = [];
    const loop = (async () => {
      for await (const beat of h10.streamHeartRate({ signal: controller.signal })) {
        received.push(beat.hr);
      }
    })();
    await tick();
    fake.char(U.HR_SERVICE, U.HR_MEASUREMENT_CHAR).notify(bytes('00 50'));
    await tick();
    controller.abort();
    await loop; // resolves without throwing
    expect(received).toEqual([80]);
  });
});

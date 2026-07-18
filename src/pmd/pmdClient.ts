/**
 * PMD service client: control-point request/response and delta-decoded data
 * streaming for ECG and accelerometer.
 * @packageDocumentation
 */

import { ControlPointError, InvalidStateError, TimeoutError } from '../errors.js';
import type { CharacteristicChannel, GattContext } from '../gatt/transport.js';
import { PMD_SERVICE, PMD_CONTROL_POINT_CHAR, PMD_DATA_CHAR } from '../gatt/uuids.js';
import { AsyncQueue, Mutex, withTimeout } from '../util/async.js';
import { concatBytes } from '../util/bytes.js';
import {
  buildGetSettings,
  buildStartMeasurement,
  buildStopMeasurement,
  isControlPointResponse,
  ONLINE_MEASUREMENT_STOPPED,
  parseControlPointNotification,
  parseControlPointResponse,
  type PmdControlPointResponse,
} from './controlPoint.js';
import { decodeAccFrame, decodeEcgFrame } from './frame.js';
import { getTimeStamps } from './timestamp.js';
import { parseFactor, parseSettings, type PmdSettingsMap, type SelectedSettings } from './settings.js';
import {
  controlPointStatusName,
  PmdControlPointStatus,
  PmdMeasurementType,
  PmdSettingType,
  type AccSample,
  type EcgSample,
} from './types.js';

const ECG_SAMPLE_RATE_HZ = 130;
const ECG_RESOLUTION_BITS = 14;
const ACC_RESOLUTION_BITS = 16;
const CP_TIMEOUT_MS = 30_000;

/** ECG streams at a fixed 130 Hz / 14-bit. */
export interface EcgStreamConfig {
  signal?: AbortSignal;
}

export interface AccStreamConfig {
  /** Sample rate in Hz: 25, 50, 100, or 200. */
  sampleRate: number;
  /** Range in G: 2, 4, or 8. */
  range: number;
  signal?: AbortSignal;
}

/** A live measurement stream's hooks into the shared data/notification plumbing. */
interface ActiveStream {
  handleFrame: (frame: Uint8Array) => void;
  fail: (error: Error) => void;
}

export class PmdClient {
  private cpChannel!: CharacteristicChannel;
  private dataChannel!: CharacteristicChannel;
  private readonly cpQueue = new AsyncQueue<Uint8Array>();
  private readonly cpMutex = new Mutex();
  private readonly activeStreams = new Map<number, ActiveStream>();

  constructor(private readonly gatt: GattContext) {}

  /** Discover characteristics and enable notifications. */
  async init(): Promise<void> {
    this.cpChannel = await this.gatt.requireChannel(PMD_SERVICE, PMD_CONTROL_POINT_CHAR);
    this.dataChannel = await this.gatt.requireChannel(PMD_SERVICE, PMD_DATA_CHAR);

    await this.cpChannel.listen((bytes) => {
      if (isControlPointResponse(bytes)) {
        this.cpQueue.push(bytes);
        return;
      }
      const note = parseControlPointNotification(bytes);
      if (note.command !== ONLINE_MEASUREMENT_STOPPED) return;
      for (const type of note.stoppedTypes) {
        this.failStream(type & 0x3f, new InvalidStateError('measurement stopped by the device'));
      }
    });

    // The PMD setup sequence reads the control point once before any command (see PROTOCOL.md §3).
    try {
      await this.cpChannel.read();
    } catch {}

    await this.dataChannel.listen((bytes) => {
      if (bytes.length < 10) return;
      this.activeStreams.get(bytes[0]! & 0x3f)?.handleFrame(bytes);
    });
  }

  private failStream(type: number, error: Error): void {
    const stream = this.activeStreams.get(type);
    if (!stream) return;
    this.activeStreams.delete(type);
    stream.fail(error);
  }

  /** Fail all pending control-point and stream waiters. */
  handleDisconnect(error: Error): void {
    this.cpQueue.fail(error);
    for (const stream of this.activeStreams.values()) stream.fail(error);
    this.activeStreams.clear();
  }

  /** Send a control-point command and reassemble the (possibly multi-packet) response. */
  private sendCommand(command: Uint8Array): Promise<PmdControlPointResponse> {
    return this.cpMutex.run(async () => {
      this.cpQueue.clear();
      await this.cpChannel.writeWithResponse(command);
      const opCode = command[0]!;
      const first = await this.nextCpResponse(opCode);
      const chunks = [first.parameters];
      let response = first;
      while (response.more) {
        response = await this.nextCpResponse(opCode);
        chunks.push(response.parameters);
      }
      return { ...first, more: false, parameters: concatBytes(...chunks) };
    });
  }

  /** Await the next response echoing `opCode`, discarding stale frames from earlier commands. */
  private async nextCpResponse(opCode: number): Promise<PmdControlPointResponse> {
    while (true) {
      const frame = await withTimeout(
        this.cpQueue.next(),
        CP_TIMEOUT_MS,
        () => new TimeoutError('PMD control point timed out'),
      );
      const response = parseControlPointResponse(frame);
      if (response.opCode === opCode) return response;
    }
  }

  private static throwOnError(response: PmdControlPointResponse): void {
    if (response.status !== PmdControlPointStatus.Success) {
      throw new ControlPointError(response.status, controlPointStatusName(response.status));
    }
  }

  /** Query available online stream settings. */
  async getSettings(type: PmdMeasurementType): Promise<PmdSettingsMap> {
    const response = await this.sendCommand(buildGetSettings(type));
    PmdClient.throwOnError(response);
    return parseSettings(response.parameters);
  }

  /** Stream ECG samples (µV) at 130 Hz. */
  streamEcg(config: EcgStreamConfig = {}): AsyncIterableIterator<EcgSample> {
    const selected: SelectedSettings = {
      [PmdSettingType.SampleRate]: ECG_SAMPLE_RATE_HZ,
      [PmdSettingType.Resolution]: ECG_RESOLUTION_BITS,
    };
    return this.stream<EcgSample>(
      PmdMeasurementType.Ecg,
      buildStartMeasurement(PmdMeasurementType.Ecg, selected),
      () => {
        let prevTs = 0n;
        return (frame, push) => {
          const decoded = decodeEcgFrame(frame);
          if (decoded.microVolts.length === 0) return;
          const timestamps = getTimeStamps(prevTs, decoded.timeStampNs, decoded.microVolts.length, ECG_SAMPLE_RATE_HZ);
          prevTs = decoded.timeStampNs;
          decoded.microVolts.forEach((microVolts, i) => push({ microVolts, timeStampNs: timestamps[i]! }));
        };
      },
      config.signal,
    );
  }

  /** Stream accelerometer samples (mG). */
  streamAcc(config: AccStreamConfig): AsyncIterableIterator<AccSample> {
    const selected: SelectedSettings = {
      [PmdSettingType.SampleRate]: config.sampleRate,
      [PmdSettingType.Resolution]: ACC_RESOLUTION_BITS,
      [PmdSettingType.Range]: config.range,
    };
    return this.stream<AccSample>(
      PmdMeasurementType.Acc,
      buildStartMeasurement(PmdMeasurementType.Acc, selected),
      (factor) => {
        let prevTs = 0n;
        return (frame, push) => {
          const decoded = decodeAccFrame(frame, factor);
          if (decoded.samples.length === 0) return;
          const timestamps = getTimeStamps(prevTs, decoded.timeStampNs, decoded.samples.length, config.sampleRate);
          prevTs = decoded.timeStampNs;
          decoded.samples.forEach((s, i) => push({ ...s, timeStampNs: timestamps[i]! }));
        };
      },
      config.signal,
    );
  }

  private async *stream<T>(
    type: PmdMeasurementType,
    start: Uint8Array,
    makeDecoder: (factor: number) => (frame: Uint8Array, push: (value: T) => void) => void,
    signal?: AbortSignal,
  ): AsyncIterableIterator<T> {
    if (signal?.aborted) return;
    if (this.activeStreams.has(type)) {
      throw new InvalidStateError(`a ${PmdMeasurementType[type]} stream is already active`);
    }

    const response = await this.sendCommand(start);
    PmdClient.throwOnError(response);
    const factor = parseFactor(response.parameters);

    const queue = new AsyncQueue<T>();
    const decode = makeDecoder(factor);
    this.activeStreams.set(type, {
      handleFrame: (frame) => {
        try {
          decode(frame, (value) => queue.push(value));
        } catch {
          // Skip malformed frames rather than tearing down the whole stream.
        }
      },
      fail: (error) => queue.fail(error),
    });

    const onAbort = () => queue.close();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      yield* queue.consume(signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeStreams.delete(type);
      // Best-effort stop; ignore errors (link may already be gone).
      try {
        await this.sendCommand(buildStopMeasurement(type));
      } catch {}
    }
  }
}

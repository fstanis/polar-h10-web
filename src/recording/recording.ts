/**
 * H10 internal exercise-recording management and device-time control, layered on
 * the PSFTP client and generated PFTP protobuf codecs.
 * @packageDocumentation
 */

import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { NotSupportedError, PftpError } from '../errors.js';
import type { ProgressCallback, PsftpClient } from '../psftp/psftpClient.js';
import { PbPFtpOperationSchema, PbPFtpOperation_Command } from '../proto/gen/communications_pftp_request_pb.js';
import {
  PbPFtpQuery,
  PbPFtpRequestStartRecordingParamsSchema,
  PbPFtpSetLocalTimeParamsSchema,
} from '../proto/gen/pftp_request_pb.js';
import { PbPFtpDirectorySchema, PbRequestRecordingStatusResultSchema } from '../proto/gen/pftp_response_pb.js';
import { PbExerciseSamplesSchema } from '../proto/gen/exercise_samples_pb.js';
import { PbSampleType, PbDateSchema, PbTimeSchema, PbDurationSchema } from '../proto/gen/types_pb.js';

/** What the H10 records into its internal memory. */
export type RecordingType = 'hr' | 'rr';

/** Recording sample interval in seconds (HR only; ignored for RR). */
export type RecordingInterval = 1 | 5;

/** Options for {@link RecordingApi.start}. */
export interface StartRecordingOptions {
  /** Whether to record heart rate or RR intervals. Defaults to `"hr"`. */
  type?: RecordingType;
  /** Sample interval in seconds for HR recordings. Defaults to `1`. */
  interval?: RecordingInterval;
}

/** Current internal-recording status. */
export interface RecordingStatus {
  /** Whether the sensor is currently recording. */
  recording: boolean;
  /** The recording identifier in use, or `""` when not recording. */
  identifier: string;
}

/** A stored exercise recording listed on the sensor. */
export interface RecordingEntry {
  /** File-system path on the H10, e.g. `/577007856J/SAMPLES.BPB`. */
  path: string;
  /** Exercise identifier parsed from the path. */
  identifier: string;
  /** File size in bytes, if reported by the directory listing. */
  sizeBytes?: number;
}

/** A fetched and parsed exercise recording. */
export interface RecordingData {
  /** Recording sample interval in seconds; `0` when the device omitted the field. */
  intervalSeconds: number;
  /** Whether the payload is heart-rate (bpm) samples or RR intervals (ms). */
  type: RecordingType;
  /** HR samples in bpm (for `type === "hr"`) or RR intervals in ms (`type === "rr"`). */
  samples: number[];
}

const SAMPLES_FILE = 'SAMPLES.BPB';
const NO_SUCH_FILE_OR_DIRECTORY = 103;

/** Encode a `PbPFtpOperation` for a file command at `path`. */
function operation(command: PbPFtpOperation_Command, path: string): Uint8Array {
  return toBinary(PbPFtpOperationSchema, create(PbPFtpOperationSchema, { command, path }));
}

export class RecordingApi {
  constructor(private readonly psftp: PsftpClient) {}

  /** Start an internal recording under `exerciseId` (1–64 chars). */
  async start(exerciseId: string, options: StartRecordingOptions = {}): Promise<void> {
    if (exerciseId.length < 1 || exerciseId.length > 64) {
      throw new NotSupportedError('recording identifier must be 1–64 characters');
    }
    const type = options.type ?? 'hr';
    const params = create(PbPFtpRequestStartRecordingParamsSchema, {
      sampleType: type === 'rr' ? PbSampleType.SAMPLE_TYPE_RR_INTERVAL : PbSampleType.SAMPLE_TYPE_HEART_RATE,
      recordingInterval: create(PbDurationSchema, { seconds: options.interval ?? 1 }),
      sampleDataIdentifier: exerciseId,
    });
    await this.psftp.query(
      PbPFtpQuery.REQUEST_START_RECORDING,
      toBinary(PbPFtpRequestStartRecordingParamsSchema, params),
    );
  }

  async stop(): Promise<void> {
    await this.psftp.query(PbPFtpQuery.REQUEST_STOP_RECORDING);
  }

  async status(): Promise<RecordingStatus> {
    const body = await this.psftp.query(PbPFtpQuery.REQUEST_RECORDING_STATUS);
    const result = fromBinary(PbRequestRecordingStatusResultSchema, body);
    return { recording: result.recordingOn, identifier: result.sampleDataIdentifier };
  }

  /** List stored exercise recordings by walking the H10 file system from `/`. */
  list(): Promise<RecordingEntry[]> {
    return this.walk('/', 0);
  }

  private async walk(path: string, depth: number): Promise<RecordingEntry[]> {
    if (depth > 3) return []; // recordings live at /<id>/SAMPLES.BPB — guard against cyclic listings
    let body: Uint8Array;
    try {
      body = await this.psftp.request(operation(PbPFtpOperation_Command.GET, path));
    } catch (error) {
      if (error instanceof PftpError && error.errorId === NO_SUCH_FILE_OR_DIRECTORY) return [];
      throw error;
    }
    const dir = fromBinary(PbPFtpDirectorySchema, body);
    const entries: RecordingEntry[] = [];
    for (const entry of dir.entries) {
      const name = entry.name;
      if (name.endsWith('/')) {
        entries.push(...(await this.walk(path + name, depth + 1)));
      } else if (name === SAMPLES_FILE) {
        const components = path.split('/').filter(Boolean);
        entries.push({
          path: path + name,
          identifier: components[0] ?? path,
          sizeBytes: entry.size !== undefined ? Number(entry.size) : undefined,
        });
      }
    }
    return entries;
  }

  async fetch(entry: RecordingEntry, onProgress?: ProgressCallback): Promise<RecordingData> {
    const body = await this.psftp.request(operation(PbPFtpOperation_Command.GET, entry.path), undefined, onProgress);
    const samples = fromBinary(PbExerciseSamplesSchema, body);
    const intervalSeconds = samples.recordingInterval?.seconds ?? 0;
    if (samples.rrSamples) {
      return { intervalSeconds, type: 'rr', samples: samples.rrSamples.rrIntervals };
    }
    return { intervalSeconds, type: 'hr', samples: samples.heartRateSamples };
  }

  /** Delete a stored recording, freeing the sensor's single recording slot. */
  async remove(entry: RecordingEntry): Promise<void> {
    await this.psftp.request(operation(PbPFtpOperation_Command.REMOVE, entry.path));
  }

  /** Set the device clock (local wall clock + UTC offset) so recordings carry correct timestamps. */
  async setTime(when: Date = new Date()): Promise<void> {
    const tzOffsetMinutes = -when.getTimezoneOffset();
    const localDate = create(PbDateSchema, {
      year: when.getFullYear(),
      month: when.getMonth() + 1,
      day: when.getDate(),
    });
    const localTime = create(PbTimeSchema, {
      hour: when.getHours(),
      minute: when.getMinutes(),
      seconds: when.getSeconds(),
      millis: when.getMilliseconds(),
    });
    await this.psftp.query(
      PbPFtpQuery.SET_LOCAL_TIME,
      toBinary(
        PbPFtpSetLocalTimeParamsSchema,
        create(PbPFtpSetLocalTimeParamsSchema, { date: localDate, time: localTime, tzOffset: tzOffsetMinutes }),
      ),
    );
  }
}

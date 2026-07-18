/**
 * PMD (Polar Measurement Data) shared types and constants for the H10.
 * @packageDocumentation
 */

/** PMD measurement type ids (6-bit, mask `0x3F`). */
export enum PmdMeasurementType {
  Ecg = 0,
  Acc = 2,
}

/** PMD control-point opcodes (client → service). */
export enum PmdControlPointCommand {
  GetMeasurementSettings = 0x01,
  RequestMeasurementStart = 0x02,
  StopMeasurement = 0x03,
}

/** PMD control-point response status / error codes. */
export enum PmdControlPointStatus {
  Success = 0,
  ErrorInvalidOpCode = 1,
  ErrorInvalidMeasurementType = 2,
  ErrorNotSupported = 3,
  ErrorInvalidLength = 4,
  ErrorInvalidParameter = 5,
  ErrorAlreadyInState = 6,
  ErrorInvalidResolution = 7,
  ErrorInvalidSampleRate = 8,
  ErrorInvalidRange = 9,
  ErrorInvalidMtu = 10,
  ErrorInvalidNumberOfChannels = 11,
  ErrorInvalidState = 12,
  ErrorDeviceInCharger = 13,
  ErrorDiskFull = 14,
  ErrorInvalidSourceMeasurementType = 15,
  ErrorInvalidSourceMeasurementRate = 16,
  ErrorInvalidDerivedMeasurementSettingsGroup = 17,
  ErrorInvalidDerivedMeasurementMethod = 18,
}

/** Human-readable name for a control-point status code (`"UNKNOWN_ERROR"` if outside the enum). */
export function controlPointStatusName(status: number): string {
  return PmdControlPointStatus[status] ?? 'UNKNOWN_ERROR';
}

/** PMD setting type ids. */
export enum PmdSettingType {
  SampleRate = 0,
  Resolution = 1,
  Range = 2,
  Factor = 5,
}

/** Polar time epoch: 2000-01-01T00:00:00Z expressed as Unix milliseconds. */
export const POLAR_EPOCH_UNIX_MS = 946684800000;

/** Convert a Polar nanosecond timestamp (since 2000-01-01Z) to Unix epoch milliseconds. */
export function polarNanosToUnixMs(ns: bigint): number {
  return POLAR_EPOCH_UNIX_MS + Number(ns / 1_000_000n);
}

/** A single ECG sample (H10 raw frame type 0). */
export interface EcgSample {
  /** Signal amplitude in microvolts (µV). */
  microVolts: number;
  /** Reconstructed timestamp, Polar nanoseconds since 2000-01-01Z. */
  timeStampNs: bigint;
}

/** A single accelerometer sample, axes in milli-G (mG). */
export interface AccSample {
  x: number;
  y: number;
  z: number;
  /** Reconstructed timestamp, Polar nanoseconds since 2000-01-01Z. */
  timeStampNs: bigint;
}

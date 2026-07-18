/**
 * PMD control-point command building and response parsing. Pure functions.
 * @packageDocumentation
 */

import { PmdControlPointCommand, PmdControlPointStatus, PmdMeasurementType } from './types.js';
import { serializeSelected, type SelectedSettings } from './settings.js';
import { concatBytes } from '../util/bytes.js';

/** Constant first byte of a control-point *response* notification. */
export const CONTROL_POINT_RESPONSE_CODE = 0xf0;

/** Command id of the only defined device-initiated control-point notification. */
export const ONLINE_MEASUREMENT_STOPPED = 0x01;

export interface PmdControlPointResponse {
  /** The opcode being answered. */
  opCode: number;
  /** Echoed measurement-type byte. */
  measurementType: number;
  status: PmdControlPointStatus | number;
  /** Whether more response packets follow (multi-packet parameters). */
  more: boolean;
  /** Parameter bytes (settings TLV, status bytes, …); empty on error. */
  parameters: Uint8Array;
}

/** A device-initiated (unsolicited) control-point notification. */
export interface PmdControlPointNotification {
  /** Command id; only {@link ONLINE_MEASUREMENT_STOPPED} is defined. */
  command: number;
  /** For `ONLINE_MEASUREMENT_STOPPED`, the measurement-type ids the device stopped. */
  stoppedTypes: number[];
}

/** Whether a control-point notification is a response to a command (`0xF0` prefix). */
export function isControlPointResponse(frame: Uint8Array): boolean {
  return frame.length > 0 && frame[0] === CONTROL_POINT_RESPONSE_CODE;
}

/** Parse a `0xF0`-prefixed control-point response frame. */
export function parseControlPointResponse(frame: Uint8Array): PmdControlPointResponse {
  const status = (frame.length > 3 ? frame[3]! : 0) as PmdControlPointStatus;
  const success = status === PmdControlPointStatus.Success;
  return {
    opCode: frame.length > 1 ? frame[1]! : 0,
    measurementType: frame.length > 2 ? frame[2]! : 0,
    status,
    more: success && frame.length > 4 && frame[4]! !== 0,
    parameters: success && frame.length > 5 ? frame.subarray(5) : new Uint8Array(0),
  };
}

/** Parse a device-initiated control-point notification (first byte ≠ `0xF0`). */
export function parseControlPointNotification(frame: Uint8Array): PmdControlPointNotification {
  return {
    command: frame.length > 0 ? frame[0]! : 0,
    stoppedTypes: Array.from(frame.subarray(1)),
  };
}

export function buildGetSettings(type: PmdMeasurementType): Uint8Array {
  return new Uint8Array([PmdControlPointCommand.GetMeasurementSettings, type & 0x3f]);
}

export function buildStartMeasurement(type: PmdMeasurementType, selected: SelectedSettings): Uint8Array {
  return concatBytes(
    new Uint8Array([PmdControlPointCommand.RequestMeasurementStart, type & 0x3f]),
    serializeSelected(selected),
  );
}

export function buildStopMeasurement(type: PmdMeasurementType): Uint8Array {
  return new Uint8Array([PmdControlPointCommand.StopMeasurement, type & 0x3f]);
}

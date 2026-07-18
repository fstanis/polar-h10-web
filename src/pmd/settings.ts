/**
 * PMD settings TLV codec (`PmdSetting`). Pure functions.
 * @packageDocumentation
 */

import { ProtocolError } from '../errors.js';
import { readIntLE, readFloatLE } from '../util/bytes.js';
import { PmdSettingType } from './types.js';

/** A parsed settings blob: for each present setting type, the list of supported values. */
export type PmdSettingsMap = Map<number, number[]>;

/** On-wire value byte width per setting type. */
const FIELD_SIZES: Readonly<Record<number, number>> = {
  [PmdSettingType.SampleRate]: 2,
  [PmdSettingType.Resolution]: 2,
  [PmdSettingType.Range]: 2,
  [PmdSettingType.Factor]: 4,
};

/** @throws {ProtocolError} on a type id without a known field size — guessing one would desync the TLV stream. */
function settingFieldSize(type: number): number {
  const size = FIELD_SIZES[type];
  if (size === undefined) {
    throw new ProtocolError(`unknown PMD setting type ${type}`);
  }
  return size;
}

/**
 * Parse a PMD settings TLV blob into a map of setting type → value list. In a
 * query response, value lists may hold several supported options; in a start
 * response each list has one value. FACTOR (type 5) values are stored as raw
 * integer bit-patterns here; use {@link parseFactor} to read the float.
 */
export function parseSettings(blob: Uint8Array): PmdSettingsMap {
  const map: PmdSettingsMap = new Map();
  let offset = 0;
  while (offset + 2 <= blob.length) {
    const type = blob[offset++]!;
    const count = blob[offset++]!;
    const fieldSize = settingFieldSize(type);
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + fieldSize > blob.length) break;
      values.push(readIntLE(blob, offset, fieldSize));
      offset += fieldSize;
    }
    map.set(type, values);
  }
  return map;
}

/**
 * Extract the FACTOR setting (type 5) as an IEEE-754 float from a settings blob,
 * scanning TLV records. Returns `1` when absent (the safe default scaling).
 */
export function parseFactor(blob: Uint8Array): number {
  let offset = 0;
  while (offset + 2 <= blob.length) {
    const type = blob[offset++]!;
    const count = blob[offset++]!;
    const fieldSize = settingFieldSize(type);
    if (type === PmdSettingType.Factor && count >= 1 && offset + 4 <= blob.length) {
      return readFloatLE(blob, offset);
    }
    offset += count * fieldSize;
  }
  return 1;
}

/** A chosen setting value to write in a measurement-start request. */
export type SelectedSettings = Partial<Record<PmdSettingType, number>>;

/**
 * Serialize chosen settings into TLV bytes for a start request: each record is
 * `[type][0x01][value little-endian, fieldSize bytes]`. FACTOR is response-only
 * and skipped.
 */
export function serializeSelected(selected: SelectedSettings): Uint8Array {
  const records: number[] = [];
  for (const [typeStr, value] of Object.entries(selected)) {
    const type = Number(typeStr);
    if (value === undefined || type === PmdSettingType.Factor) continue;
    const fieldSize = settingFieldSize(type);
    records.push(type, 0x01);
    for (let i = 0; i < fieldSize; i++) {
      records.push((value >> (8 * i)) & 0xff);
    }
  }
  return new Uint8Array(records);
}

import { describe, expect, test } from 'bun:test';
import { bytes } from './helpers/bytes.js';
import { ProtocolError } from '../src/errors.js';
import { getTimeStamps } from '../src/pmd/timestamp.js';
import { parseSettings, parseFactor, serializeSelected } from '../src/pmd/settings.js';
import { PmdSettingType } from '../src/pmd/types.js';
import {
  parseControlPointResponse,
  parseControlPointNotification,
  isControlPointResponse,
} from '../src/pmd/controlPoint.js';

describe('timestamp reconstruction (getTimeStamps)', () => {
  test('F1: frequency-based, previousTimeStamp = 0', () => {
    const ts = getTimeStamps(0n, 10_000_000_000n, 10, 1);
    expect(ts).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n].map((n) => n * 1_000_000_000n));
  });

  test('F2: single sample, frequency-based', () => {
    expect(getTimeStamps(0n, 1_000_000_000n, 1, 1)).toEqual([1_000_000_000n]);
  });

  test('F3: previous-timestamp-based, integer delta', () => {
    const ts = getTimeStamps(1_000_000_000n, 11_000_000_000n, 10, 1);
    expect(ts).toEqual([2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n].map((n) => n * 1_000_000_000n));
  });

  test('F4: previous-timestamp-based, fractional delta rounds', () => {
    const ts = getTimeStamps(100n, 2_000_000_000n, 3, 1);
    expect(ts).toEqual([666_666_733n, 1_333_333_367n, 2_000_000_000n]);
  });

  test('F5: error cases', () => {
    expect(() => getTimeStamps(0n, 100_000n, 100, 0)).toThrow();
    expect(() => getTimeStamps(0n, 100_000n, 100, 52)).toThrow();
  });

  test('F6: keeps ns precision at realistic Polar timestamps (> 2^53)', () => {
    const prev = 820_000_000_000_000_123n;
    const frame = prev + 1_000_000_000n;
    const ts = getTimeStamps(prev, frame, 10, 130);
    expect(ts[0]).toBe(prev + 100_000_000n);
    expect(ts[8]).toBe(prev + 900_000_000n);
    expect(ts[9]).toBe(frame);
  });

  test('F7: a non-increasing frame timestamp is rejected', () => {
    expect(() => getTimeStamps(2_000_000_000n, 2_000_000_000n, 10, 130)).toThrow(ProtocolError);
    expect(() => getTimeStamps(2_000_000_000n, 1_000_000_000n, 10, 130)).toThrow(ProtocolError);
  });
});

describe('settings TLV', () => {
  test('E1: sample rate / resolution / range list', () => {
    const m = parseSettings(bytes('00 01 34 00 01 01 10 00 02 04 F5 00 F4 01 E8 03 D0 07'));
    expect(m.get(PmdSettingType.SampleRate)).toEqual([52]);
    expect(m.get(PmdSettingType.Resolution)).toEqual([16]);
    expect(m.get(PmdSettingType.Range)).toEqual([245, 500, 1000, 2000]);
    expect(m.size).toBe(3);
  });

  test('an unknown setting type id throws instead of desyncing the TLV stream', () => {
    // Type 4 (CHANNELS) is not produced by the H10 and has no known field size here.
    expect(() => parseSettings(bytes('04 01 03'))).toThrow(ProtocolError);
    expect(() => parseFactor(bytes('04 01 03 05 01 00 00 80 3F'))).toThrow(ProtocolError);
  });

  test('parseFactor reads the FACTOR float; defaults to 1', () => {
    // FACTOR (type 5), count 1, value 1.0f = 00 00 80 3F
    expect(parseFactor(bytes('05 01 00 00 80 3F'))).toBeCloseTo(1.0, 6);
    expect(parseFactor(bytes('00 01 82 00'))).toBe(1);
  });

  test('serializeSelected emits chosen settings, skipping FACTOR', () => {
    const out = serializeSelected({
      [PmdSettingType.SampleRate]: 130,
      [PmdSettingType.Resolution]: 14,
      [PmdSettingType.Factor]: 15,
    });
    // 00 01 82 00 (rate=130) then 01 01 0E 00 (res=14); factor omitted
    expect(Array.from(out)).toEqual([0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
  });
});

describe('control-point response parsing', () => {
  test('D3: high error id, 5-byte frame', () => {
    const r = parseControlPointResponse(bytes('F0 02 0F 11 00'));
    expect(r.status).toBe(17);
    expect(r.parameters.length).toBe(0);
  });

  test('D4: unknown error id does not throw', () => {
    const r = parseControlPointResponse(bytes('F0 02 0F 7F 00'));
    expect(r.status).toBe(0x7f);
  });

  test('D5: device-initiated stop notification', () => {
    expect(isControlPointResponse(bytes('01 01 02'))).toBe(false);
    const n = parseControlPointNotification(bytes('01 01 02'));
    expect(n.command).toBe(1);
    expect(n.stoppedTypes).toEqual([1, 2]);
  });
});

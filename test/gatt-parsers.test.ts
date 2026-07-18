import { describe, expect, test } from 'bun:test';
import { bytes } from './helpers/bytes.js';
import { parseHrMeasurement } from '../src/gatt/hrClient.js';
import { systemIdToHex } from '../src/gatt/deviceInfo.js';

// Shapes the H10 emits rarely or never; the common paths are covered by the
// real-capture replay suite.
describe('HR measurement parsing (BleHrClientTest vectors)', () => {
  test('D2: uint16 HR (LE)', () => {
    expect(parseHrMeasurement(bytes('01 80 80')).hr).toBe(32896);
    expect(parseHrMeasurement(bytes('01 7F 7F')).hr).toBe(32639);
  });

  test('D3: sensor contact bits', () => {
    expect(parseHrMeasurement(bytes('06 00'))).toMatchObject({ contactDetected: true, contactSupported: true });
    expect(parseHrMeasurement(bytes('04 00'))).toMatchObject({ contactDetected: false, contactSupported: true });
    expect(parseHrMeasurement(bytes('02 00')).contactSupported).toBe(false);
  });

  test('D4: energy expended (uint16 LE)', () => {
    expect(parseHrMeasurement(bytes('09 00 00 FF FF')).energyExpended).toBe(65535);
    expect(parseHrMeasurement(bytes('08 00 7F 80')).energyExpended).toBe(32895);
  });
});

describe('SYSTEM_ID hex (reverse byte order)', () => {
  test('F: 01 02 03 04 → 04030201', () => {
    expect(systemIdToHex(bytes('01 02 03 04'))).toBe('04030201');
  });
});

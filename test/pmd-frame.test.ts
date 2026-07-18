import { describe, expect, test } from 'bun:test';
import { bytes } from './helpers/bytes.js';
import { ProtocolError } from '../src/errors.js';
import { parseDeltaFrames, decodeEcgFrame, decodeAccFrame, parsePmdFrameHeader } from '../src/pmd/frame.js';

describe('PMD frame header', () => {
  test('parses type, timestamp, frame type and compressed flag', () => {
    const h = parsePmdFrameHeader(bytes('02 65 00 00 00 00 00 00 00 81 F1 FF'));
    expect(h.measurementType).toBe(2);
    expect(h.timeStampNs).toBe(101n);
    expect(h.frameType).toBe(1);
    expect(h.compressed).toBe(true);
    expect(Array.from(h.content)).toEqual([0xf1, 0xff]);
  });
});

describe('ECG decode', () => {
  test('raw type 0 — 3-byte signed LE µV per sample', () => {
    const d = decodeEcgFrame(bytes('00 00 94 35 77 00 00 00 00 00 02 80 FF 02 80 00'));
    expect(d.microVolts).toEqual([-32766, 32770]);
    expect(d.timeStampNs).toBe(0x77_35_94_00n);
  });

  test('rejects compressed frames', () => {
    expect(() => decodeEcgFrame(bytes('00 00 94 35 77 00 00 00 00 80 00 00'))).toThrow(ProtocolError);
  });

  test('rejects frame types other than 0', () => {
    expect(() => decodeEcgFrame(bytes('00 00 94 35 77 00 00 00 00 01 02 80 FF 80 02 00'))).toThrow(ProtocolError);
  });
});

describe('delta-frame core (parseDeltaFrames)', () => {
  test('C1: reference sample, resolution 16, 4 channels', () => {
    const samples = parseDeltaFrames(bytes('FF FF 00 00 FF 7F 00 80'), 4, 16);
    expect(samples).toEqual([[-1, 0, 32767, -32768]]);
  });

  test('C3: multi-block, resolution 16, 3 channels — ref, first delta, total count', () => {
    const content = bytes(`
      C9 FF 12 00 11 00 03 09 41 FE 2B 0F 9C 0B BF 15 00 4F 00 04
      1E F1 EF 00 F0 C1 23 E4 ED F4 D1 F1 F1 F5 FF 22 DE 31 00 F1
      FE 21 02 1F 0E 2B 1F 00 E2 20 00 0E 02 E1 1E 20 FF F1 F1 02
      C5 D0 02 E0 E1 02 03 0A 31 2E FB BA 90 2B AA 0E 23 40 9E 03
      04 14 E3 EF F3 0F 02 1F 01 E0 0F 04 9E 13 E2 D0 04 E2 22 E2
      C2 0E 20 0F 20 02 FE 00 0F 1C 32 EE 03 0A 89 00 07 08 7C 00
      CE 2F E8 3A 9E 03 04 1E 01 00 11 19 4F 00 2F 12 FD 13 FF 0E
      10 00 00 F1 C0 12 E4 EF 21 00 00 01 F1 FF FF 02 10 10 2B 51
      0B 4E 31 FC 2E BF 31 14 EC 0E 2F 52 EF 03 0A 06 9E 04 0E 02
      A8 88 EE E0 07 9A 00 04 0A 1F 21 1E 4E 2E FE C6 C0 02 EF 03
      01 02 EE 11 03 0A F8 13 00 00 F0 40 BF A5 E7 00 76 00`);
    const samples = parseDeltaFrames(content, 3, 16);
    expect(samples[0]).toEqual([-55, 18, 17]);
    expect(samples[1]).toEqual([-54, 18, 18]);
    expect(samples.length).toBe(140);
  });
});

describe('ACC decode', () => {
  test('raw type 1 — 2-byte signed LE mG per axis', () => {
    const d = decodeAccFrame(bytes('02 65 00 00 00 00 00 00 00 01 0A 00 14 00 1E 00 F6 FF EC FF E2 FF'), 1.0);
    expect(d.samples).toEqual([
      { x: 10, y: 20, z: 30 },
      { x: -10, y: -20, z: -30 },
    ]);
    expect(d.timeStampNs).toBe(101n);
  });

  test('compressed type 1, factor 1.0 — mG raw', () => {
    const d = decodeAccFrame(bytes('02 65 00 00 00 00 00 00 00 81 F1 FF 14 00 F0 03 06 01 7B 0F 08'), 1.0);
    expect(d.samples).toEqual([
      { x: -15, y: 20, z: 1008 },
      { x: -20, y: 17, z: 1008 },
    ]);
    expect(d.timeStampNs).toBe(101n);
  });

  test('rejects frame types other than 1', () => {
    expect(() => decodeAccFrame(bytes('02 00 94 35 77 00 00 00 00 80'), 1.0)).toThrow(ProtocolError);
    expect(() => decodeAccFrame(bytes('02 00 94 35 77 00 00 00 00 02 01 02 03'), 1.0)).toThrow(ProtocolError);
  });
});

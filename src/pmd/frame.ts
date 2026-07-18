/**
 * Pure PMD data-frame decoders: bytes in, decoded samples out. No I/O, no
 * device state.
 * @packageDocumentation
 */

import { ProtocolError } from '../errors.js';
import { readIntLE, readU64LE } from '../util/bytes.js';
import { PmdMeasurementType } from './types.js';

/** Header common to every PMD data-characteristic notification (always 10 bytes). */
export interface PmdFrameHeader {
  /** Measurement type (low 6 bits of byte 0). */
  measurementType: number;
  /** 64-bit Polar-epoch timestamp (ns) of the last sample in the frame. */
  timeStampNs: bigint;
  /** Frame type (low 7 bits of byte 9). */
  frameType: number;
  /** Whether the frame is delta-compressed (bit 7 of byte 9). */
  compressed: boolean;
  /** The data content after the 10-byte header. */
  content: Uint8Array;
}

/** Split a raw PMD data notification into its header fields and content. */
export function parsePmdFrameHeader(frame: Uint8Array): PmdFrameHeader {
  if (frame.length < 10) {
    throw new ProtocolError(`PMD frame too short: ${frame.length} bytes`);
  }
  const frameTypeByte = frame[9]!;
  return {
    measurementType: frame[0]! & 0x3f,
    timeStampNs: readU64LE(frame, 1),
    frameType: frameTypeByte & 0x7f,
    compressed: (frameTypeByte & 0x80) !== 0,
    content: frame.subarray(10),
  };
}

/** Sign-extend the low `bits` of `value` (two's complement). `bits` must be 1..32. */
function signExtend(value: number, bits: number): number {
  if (bits >= 32) {
    return value | 0;
  }
  const signBit = 1 << (bits - 1);
  return value & signBit ? value - (1 << bits) : value;
}

/**
 * Decode a delta-compressed frame body into per-channel sample vectors:
 * a reference sample of `channels` values (`ceil(resolution/8)` LE bytes each),
 * then `[bitWidth][sampleCount]` blocks of packed two's-complement deltas,
 * unpacked LSB-first across and within bytes and added cumulatively.
 */
export function parseDeltaFrames(content: Uint8Array, channels: number, resolution: number): number[][] {
  const bytesPerChannel = Math.ceil(resolution / 8);
  const samples: number[][] = [];
  let offset = 0;

  const reference: number[] = [];
  for (let ch = 0; ch < channels; ch++) {
    reference.push(readIntLE(content, offset, bytesPerChannel));
    offset += bytesPerChannel;
  }
  samples.push(reference);
  let previous = reference;

  while (offset < content.length) {
    const deltaSize = content[offset++]!;
    const sampleCount = content[offset++]!;
    if (deltaSize === 0 || sampleCount === 0) continue;

    const totalBits = sampleCount * deltaSize * channels;
    const byteLen = Math.ceil(totalBits / 8);
    const packed = content.subarray(offset, offset + byteLen);
    offset += byteLen;

    let bitPos = 0;
    const readBits = (n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const bit = (packed[bitPos >> 3]! >> (bitPos & 7)) & 1;
        v |= bit << i;
        bitPos++;
      }
      return v >>> 0;
    };

    for (let s = 0; s < sampleCount; s++) {
      const current = new Array<number>(channels);
      for (let ch = 0; ch < channels; ch++) {
        const delta = signExtend(readBits(deltaSize), deltaSize);
        current[ch] = (previous[ch]! + delta) | 0;
      }
      samples.push(current);
      previous = current;
    }
  }
  return samples;
}

/** ECG samples (µV) decoded from one frame, plus the frame's own timestamp. */
export interface DecodedEcgFrame {
  microVolts: number[];
  timeStampNs: bigint;
}

/** Decode an ECG frame: raw frame type 0, 3-byte signed LE µV per sample. */
export function decodeEcgFrame(frame: Uint8Array): DecodedEcgFrame {
  const header = parsePmdFrameHeader(frame);
  if (header.measurementType !== PmdMeasurementType.Ecg) {
    throw new ProtocolError(`not an ECG frame (type ${header.measurementType})`);
  }
  if (header.compressed || header.frameType !== 0) {
    throw new ProtocolError(
      `unsupported ECG frame type ${header.frameType}${header.compressed ? ' (compressed)' : ''}`,
    );
  }
  const content = header.content;
  const microVolts: number[] = [];
  for (let i = 0; i + 3 <= content.length; i += 3) {
    microVolts.push(readIntLE(content, i, 3));
  }
  return { microVolts, timeStampNs: header.timeStampNs };
}

/** Accelerometer samples (mG) decoded from one frame, plus the frame's timestamp. */
export interface DecodedAccFrame {
  samples: { x: number; y: number; z: number }[];
  timeStampNs: bigint;
}

/**
 * Decode an accelerometer frame (type 1) into mG samples. Raw frames carry
 * 2 signed LE bytes per axis; delta-compressed frames are decoded at 16-bit
 * resolution and scaled by `factor` from the stream's start response.
 */
export function decodeAccFrame(frame: Uint8Array, factor: number): DecodedAccFrame {
  const header = parsePmdFrameHeader(frame);
  if (header.measurementType !== PmdMeasurementType.Acc) {
    throw new ProtocolError(`not an ACC frame (type ${header.measurementType})`);
  }
  if (header.frameType !== 1) {
    throw new ProtocolError(`unsupported ACC frame type ${header.frameType}`);
  }
  const content = header.content;
  const samples: { x: number; y: number; z: number }[] = [];
  if (header.compressed) {
    for (const [x, y, z] of parseDeltaFrames(content, 3, 16) as [number, number, number][]) {
      samples.push({
        x: Math.trunc(x * factor),
        y: Math.trunc(y * factor),
        z: Math.trunc(z * factor),
      });
    }
  } else {
    for (let i = 0; i + 6 <= content.length; i += 6) {
      samples.push({
        x: readIntLE(content, i, 2),
        y: readIntLE(content, i + 2, 2),
        z: readIntLE(content, i + 4, 2),
      });
    }
  }
  return { samples, timeStampNs: header.timeStampNs };
}

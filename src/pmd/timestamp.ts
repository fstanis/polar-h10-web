/**
 * Per-sample timestamp reconstruction for PMD data frames.
 * @packageDocumentation
 */

import { ProtocolError } from '../errors.js';

/**
 * Reconstruct per-sample timestamps for one frame.
 *
 * The frame carries only the timestamp of its **last** sample. Earlier samples
 * are back-calculated: the first frame after a stream starts uses the nominal
 * sample rate; subsequent frames interpolate against the previous frame's
 * timestamp of the same type. The last returned timestamp is always exactly the
 * frame timestamp.
 *
 * @param prevFrameTs - Timestamp of the previous frame of the same measurement +
 *   frame type, or `0n` for the first frame after start.
 * @param frameTs - This frame's timestamp (last sample).
 * @param samplesSize - Number of samples in this frame.
 * @param sampleRate - Nominal sample rate in Hz (used only for the first frame).
 * @returns One Polar-nanosecond timestamp per sample, oldest first.
 * @throws {ProtocolError} when `frameTs` is not strictly greater than `prevFrameTs` —
 *   interpolating against a non-increasing device timestamp would corrupt sample times.
 */
export function getTimeStamps(prevFrameTs: bigint, frameTs: bigint, samplesSize: number, sampleRate: number): bigint[] {
  if (samplesSize <= 0) {
    throw new ProtocolError('cannot reconstruct timestamps for an empty frame');
  }
  if (prevFrameTs !== 0n && frameTs <= prevFrameTs) {
    throw new ProtocolError(`frame timestamp ${frameTs} is not after the previous frame's ${prevFrameTs}`);
  }

  let stepNs: number;
  if (prevFrameTs === 0n) {
    if (sampleRate <= 0) {
      throw new ProtocolError('cannot reconstruct timestamps: both previous timestamp and sample rate are zero');
    }
    stepNs = 1e9 / sampleRate;
    if (frameTs < BigInt(Math.round(stepNs * samplesSize))) {
      throw new ProtocolError('reconstructed timestamps would be negative');
    }
  } else {
    stepNs = Number(frameTs - prevFrameTs) / samplesSize;
  }

  // Offsets are computed relative to frameTs in bigint: converting the full
  // ~2^60 ns timestamp to a JS number would lose sub-microsecond precision.
  const out = new Array<bigint>(samplesSize);
  for (let i = 0; i < samplesSize - 1; i++) {
    out[i] = frameTs - BigInt(Math.round(stepNs * (samplesSize - 1 - i)));
  }
  out[samplesSize - 1] = frameTs;
  return out;
}

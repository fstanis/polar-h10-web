/**
 * Small byte-manipulation helpers shared by the protocol decoders. All are pure.
 * @packageDocumentation
 */

/**
 * Read `size` little-endian bytes from `data` at `offset` as an unsigned
 * integer. `size` must be 1..4 (result fits a JS number without precision loss).
 */
export function readUIntLE(data: Uint8Array, offset: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) {
    value |= (data[offset + i]! & 0xff) << (8 * i);
  }
  // `>>> 0` normalises the 32-bit case back to unsigned.
  return value >>> 0;
}

/** Read `size` little-endian bytes as a two's-complement signed integer. `size` must be 1..4. */
export function readIntLE(data: Uint8Array, offset: number, size: number): number {
  const unsigned = readUIntLE(data, offset, size);
  const bits = size * 8;
  if (bits >= 32) return unsigned | 0;
  const signBit = 1 << (bits - 1);
  return unsigned & signBit ? unsigned - (1 << bits) : unsigned;
}

export function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]! & 0xff) << BigInt(8 * i);
  }
  return value;
}

/** Read a 32-bit little-endian IEEE-754 float. */
export function readFloatLE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, true);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

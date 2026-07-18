/**
 * Parse a whitespace/`0x`/comma tolerant hex string into a `Uint8Array`, for
 * concise fixtures, e.g. `bytes("F0 01 02 00")`.
 */
export function bytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error(`hex string has odd length: "${hex}"`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

import { describe, expect, test } from 'bun:test';
import { concatBytes } from '../src/util/bytes.js';
import { bytes } from './helpers/bytes.js';
import {
  parseRfc76Packet,
  buildRfc76Packets,
  Rfc76Reassembler,
  Rfc76Status,
  buildRequestEnvelope,
  buildQueryEnvelope,
} from '../src/psftp/framing.js';
import { PftpError } from '../src/errors.js';

describe('RFC76 header parsing (BlePsFtpUtilsTest vectors)', () => {
  test('A1: first frame, MORE, next=0, seq=0', () => {
    const h = parseRfc76Packet(bytes('06 0A 06 08 02 10 04 18 03 12 06 08 00 10 09 18 05 1A 06 08'));
    expect(h.next).toBe(0);
    expect(h.status).toBe(Rfc76Status.More);
    expect(h.sequenceNumber).toBe(0);
    expect(h.payload!.length).toBe(19);
  });

  test('A2: middle frame, MORE, next=1, seq=9', () => {
    const h = parseRfc76Packet(bytes('97 22 0A 03 47 50 53 1A 1B 08 01 10 00 18 00 22 13 61 32 30'));
    expect(h.next).toBe(1);
    expect(h.status).toBe(Rfc76Status.More);
    expect(h.sequenceNumber).toBe(9);
  });

  test('A3: last frame, LAST, next=1, seq=12', () => {
    const h = parseRfc76Packet(bytes('C3 5A 48 5F 4A 41 10 09'));
    expect(h.next).toBe(1);
    expect(h.status).toBe(Rfc76Status.Last);
    expect(h.sequenceNumber).toBe(12);
    expect(h.payload!.length).toBe(7);
  });
});

describe('RFC76 build round-trip', () => {
  test('splits a stream and reassembles it identically', () => {
    const stream = new Uint8Array(50).map((_, i) => i);
    const packets = buildRfc76Packets(stream, 20);
    // first packet next=0, rest next=1
    expect(parseRfc76Packet(packets[0]!).next).toBe(0);
    expect(parseRfc76Packet(packets[1]!).next).toBe(1);
    const asm = new Rfc76Reassembler();
    let body: Uint8Array | undefined;
    for (const p of packets) body = asm.push(p)?.body ?? body;
    expect(Array.from(body!)).toEqual(Array.from(stream));
  });

  test('empty stream yields a single LAST terminator', () => {
    const packets = buildRfc76Packets(new Uint8Array(0), 20);
    expect(packets.length).toBe(1);
    expect(parseRfc76Packet(packets[0]!).status).toBe(Rfc76Status.Last);
  });
});

describe('full multi-frame reassembly (BlePsFtpClientTest 13-frame fixture)', () => {
  const frames = [
    '06 0A 06 08 02 10 04 18 03 12 06 08 00 10 09 18 05 1A 06 08',
    '17 02 10 00 18 07 32 08 41 31 34 37 38 43 32 43 3A 0E 50 6F',
    '27 50 6F 6C 61 72 20 49 4E 57 33 4E 5F 42 0B 30 30 37 38 35',
    '37 30 30 37 38 35 36 4A 06 43 6F 70 70 65 72 52 06 55 6E 69',
    '47 55 6E 69 5A 10 41 30 39 45 31 41 46 46 46 45 41 31 34 37',
    '57 41 30 62 14 C1 A8 78 D5 02 4B 46 1D C6 6D 38 ED 0E 53 B5',
    '67 C1 A8 78 D5 02 6A 06 08 03 10 0B 18 00 72 10 0A 06 42 6C',
    '77 42 6C 65 41 1A 06 08 09 10 00 18 00 72 17 0A 0D 42 6C 65',
    '87 42 6C 65 42 6F 6F 74 6C 6F 61 1A 06 08 04 10 01 18 00 72',
    '97 22 0A 03 47 50 53 1A 1B 08 01 10 00 18 00 22 13 61 32 30',
    'A7 61 32 30 30 32 30 5F 66 34 64 33 38 36 38 5F 31 78 01 82',
    'B7 82 08 0A 06 08 03 10 00 18 02 8A 01 0D 0A 09 5A 48 5F 4A',
    'C3 5A 48 5F 4A 41 10 09',
  ].map(bytes);

  test('reassembles to the concatenation of payloads (header dropped)', () => {
    const expected = concatBytes(...frames.map((f) => f.subarray(1)));
    const asm = new Rfc76Reassembler();
    let body: Uint8Array | undefined;
    for (const f of frames) body = asm.push(f)?.body ?? body;
    expect(Array.from(body!)).toEqual(Array.from(expected));
  });
});

describe('single-frame LAST response (request round-trip fixture C)', () => {
  test('device response 02 22 yields payload [0x22]', () => {
    const asm = new Rfc76Reassembler();
    const res = asm.push(bytes('02 22'));
    expect(res).not.toBeNull();
    expect(Array.from(res!.body)).toEqual([0x22]);
  });
});

describe('reassembler error handling', () => {
  test('non-zero ERROR_OR_RESPONSE throws PftpError', () => {
    const asm = new Rfc76Reassembler();
    // status 0 frame (byte0 = 0x00), error 103 = NO_SUCH_FILE_OR_DIRECTORY (LE 67 00)
    expect(() => asm.push(bytes('00 67 00'))).toThrow(PftpError);
  });

  test('sequence gap throws', () => {
    const asm = new Rfc76Reassembler();
    asm.push(bytes('06 AA')); // seq 0, MORE
    // next packet should be seq 1; feed seq 2 instead (byte0 = next1|MORE|seq2 = 1|6|0x20 = 0x27)
    expect(() => asm.push(bytes('27 BB'))).toThrow();
  });
});

describe('RFC60 envelopes', () => {
  test('query envelope sets bit 15 of the id', () => {
    // id 16 (REQUEST_RECORDING_STATUS), no params
    expect(Array.from(buildQueryEnvelope(16))).toEqual([0x10, 0x80]);
  });

  test('request envelope prefixes little-endian header size', () => {
    const header = bytes('08 00 12 03 2F 55 30'); // 7-byte fake operation
    const env = buildRequestEnvelope(header);
    expect(Array.from(env.subarray(0, 2))).toEqual([7, 0]);
    expect(Array.from(env.subarray(2))).toEqual(Array.from(header));
  });
});

/**
 * Pure PSFTP framing: RFC60 request/query/notification envelopes, the RFC76
 * air-packet stream layer, and a stateful reassembler for incoming response
 * packets. No I/O.
 * @packageDocumentation
 */

import { ProtocolError, PftpError } from '../errors.js';
import { concatBytes } from '../util/bytes.js';
import { pftpErrorName } from '../recording/pftpErrors.js';

/** RFC76 packet status, as recovered by `(header >> 1) & 0x03`. */
export enum Rfc76Status {
  /** Terminator / error frame; bytes 1..2 are a 16-bit LE error code (0 = success). */
  ErrorOrResponse = 0x00,
  /** Final data frame of a message. */
  Last = 0x01,
  /** Data frame; more packets follow. */
  More = 0x03,
}

/** Minimum air-packet size (ATT MTU 23 − 3). Payload per packet = size − 1. */
export const DEFAULT_AIR_PACKET_SIZE = 20;

/** Parsed RFC76 air-packet header. */
export interface Rfc76Header {
  next: number;
  status: Rfc76Status;
  sequenceNumber: number;
  /** Present for LAST/MORE frames — the bytes after the 1-byte header. */
  payload?: Uint8Array;
  /** Present for ERROR_OR_RESPONSE frames — 16-bit LE error code (0 = success). */
  error?: number;
}

/** Decode a single incoming RFC76 air packet. */
export function parseRfc76Packet(packet: Uint8Array): Rfc76Header {
  if (packet.length < 1) throw new ProtocolError('empty RFC76 packet');
  const b0 = packet[0]!;
  const next = b0 & 0x01;
  const status = ((b0 >> 1) & 0x03) as Rfc76Status;
  const sequenceNumber = (b0 >> 4) & 0x0f;
  if (status === Rfc76Status.ErrorOrResponse) {
    const lo = packet.length > 1 ? packet[1]! : 0;
    const hi = packet.length > 2 ? packet[2]! : 0;
    return { next, status, sequenceNumber, error: (lo | (hi << 8)) & 0xffff };
  }
  return { next, status, sequenceNumber, payload: packet.subarray(1) };
}

/**
 * Split a complete logical message stream into RFC76 air packets of at most
 * `airPacketSize` bytes each (1-byte header + up to `airPacketSize − 1` payload).
 * The sequence counter is a 4-bit ring; the first packet has `next = 0`, all
 * subsequent packets `next = 1`.
 */
export function buildRfc76Packets(stream: Uint8Array, airPacketSize = DEFAULT_AIR_PACKET_SIZE): Uint8Array[] {
  const maxPayload = airPacketSize - 1;
  const packets: Uint8Array[] = [];
  let offset = 0;
  let seq = 0;
  let next = 0;
  do {
    const remaining = stream.length - offset;
    const more = remaining > maxPayload;
    const take = more ? maxPayload : remaining;
    const statusRaw = more ? 0x06 : 0x02; // MORE=0x03<<1, LAST=0x01<<1
    const packet = new Uint8Array(1 + take);
    packet[0] = next | statusRaw | (seq << 4);
    packet.set(stream.subarray(offset, offset + take), 1);
    packets.push(packet);
    offset += take;
    seq = (seq + 1) & 0x0f;
    next = 1;
  } while (offset < stream.length);
  return packets;
}

/** The three-byte packet that cancels an in-flight stream (`next=0, status=0, seq=0, error=0`). */
export const RFC76_CANCEL_PACKET: Uint8Array = new Uint8Array([0x00, 0x00, 0x00]);

/**
 * Reassembles a PSFTP response from incoming RFC76 packets. Feed each packet via
 * {@link push}; when it returns a `body`, the response is complete. Throws
 * {@link ProtocolError} on a sequence gap or stream desync, and {@link PftpError}
 * when the device terminates with a non-zero error code.
 */
export class Rfc76Reassembler {
  private expectedSeq = 0;
  private expectedNext = 0;
  private readonly chunks: Uint8Array[] = [];

  /**
   * @returns `{ body }` when the message is complete, otherwise `null` if more
   *   packets are expected.
   */
  push(packet: Uint8Array): { body: Uint8Array } | null {
    const header = parseRfc76Packet(packet);
    if (this.expectedSeq !== header.sequenceNumber) {
      throw new ProtocolError(`air packet lost: expected seq ${this.expectedSeq}, got ${header.sequenceNumber}`);
    }
    this.expectedSeq = (this.expectedSeq + 1) & 0x0f;

    if (this.expectedNext !== header.next) {
      throw new ProtocolError('PSFTP stream out of sync');
    }
    this.expectedNext = 1;

    switch (header.status) {
      case Rfc76Status.More:
        this.chunks.push(header.payload!);
        return null;
      case Rfc76Status.Last:
        this.chunks.push(header.payload!);
        return { body: concatBytes(...this.chunks) };
      case Rfc76Status.ErrorOrResponse:
        if (header.error) {
          throw new PftpError(header.error, pftpErrorName(header.error));
        }
        return { body: concatBytes(...this.chunks) };
      default:
        throw new ProtocolError(`unknown RFC76 status ${header.status}`);
    }
  }
}

/**
 * Build the RFC60 REQUEST envelope for a file operation: a 2-byte little-endian
 * header-size prefix (bit 15 = 0), the protobuf operation bytes, then optional
 * bulk file data.
 */
export function buildRequestEnvelope(header: Uint8Array, data?: Uint8Array): Uint8Array {
  const size = header.length;
  const prefix = new Uint8Array([size & 0xff, (size >> 8) & 0x7f]);
  return data ? concatBytes(prefix, header, data) : concatBytes(prefix, header);
}

/**
 * Build the RFC60 QUERY envelope: a 2-byte header carrying the 15-bit query id
 * with bit 15 set, followed by optional protobuf parameter bytes.
 */
export function buildQueryEnvelope(id: number, params?: Uint8Array): Uint8Array {
  const prefix = new Uint8Array([id & 0xff, ((id >> 8) & 0x7f) | 0x80]);
  return params ? concatBytes(prefix, params) : prefix;
}

/**
 * Build the RFC60 NOTIFICATION envelope (host → device): a 1-byte notification
 * id followed by optional protobuf parameter bytes.
 */
export function buildNotificationEnvelope(id: number, params?: Uint8Array): Uint8Array {
  const prefix = new Uint8Array([id & 0xff]);
  return params ? concatBytes(prefix, params) : prefix;
}

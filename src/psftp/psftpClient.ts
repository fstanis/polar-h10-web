/**
 * PSFTP transport client: sends REQUEST/QUERY messages over the MTU
 * characteristic and reassembles the RFC76 response stream.
 * @packageDocumentation
 */

import { PftpError, TimeoutError } from '../errors.js';
import type { CharacteristicChannel, GattContext } from '../gatt/transport.js';
import { PSFTP_SERVICE, PSFTP_MTU_CHAR } from '../gatt/uuids.js';
import { AsyncQueue, Mutex, withTimeout } from '../util/async.js';
import {
  buildQueryEnvelope,
  buildRequestEnvelope,
  buildRfc76Packets,
  DEFAULT_AIR_PACKET_SIZE,
  RFC76_CANCEL_PACKET,
  Rfc76Reassembler,
} from './framing.js';

const PROTOCOL_TIMEOUT_MS = 90_000;

/** Progress callback for in-flight transfers, reporting bytes received so far. */
export type ProgressCallback = (bytesReceived: number) => void;

/** Options for constructing a {@link PsftpClient}. */
export interface PsftpOptions {
  /**
   * Outbound air-packet size in bytes (header + payload). Defaults to 20 for
   * guaranteed correctness on any link; can be raised for throughput. Inbound
   * packet sizes are read dynamically and are unaffected.
   */
  airPacketSize?: number;
}

export class PsftpClient {
  private mtu!: CharacteristicChannel;
  private readonly mtuQueue = new AsyncQueue<Uint8Array>();
  private readonly mutex = new Mutex();
  private readonly airPacketSize: number;

  constructor(
    private readonly gatt: GattContext,
    options: PsftpOptions = {},
  ) {
    this.airPacketSize = options.airPacketSize ?? DEFAULT_AIR_PACKET_SIZE;
  }

  /** Discover the MTU characteristic and subscribe to its response notifications. */
  async init(): Promise<void> {
    this.mtu = await this.gatt.requireChannel(PSFTP_SERVICE, PSFTP_MTU_CHAR);
    await this.mtu.listen((bytes) => this.mtuQueue.push(bytes));
  }

  /** Fail any in-flight request. */
  handleDisconnect(error: Error): void {
    this.mtuQueue.fail(error);
  }

  /**
   * Perform a file REQUEST (GET/PUT/REMOVE). `header` is the encoded
   * `PbPFtpOperation`; `data` is optional bulk payload for PUT.
   */
  request(header: Uint8Array, data?: Uint8Array, onProgress?: ProgressCallback): Promise<Uint8Array> {
    return this.transact(buildRequestEnvelope(header, data), onProgress);
  }

  /** Perform a QUERY (recording control, set/get time, …). */
  query(id: number, params?: Uint8Array, onProgress?: ProgressCallback): Promise<Uint8Array> {
    return this.transact(buildQueryEnvelope(id, params), onProgress);
  }

  private transact(stream: Uint8Array, onProgress?: ProgressCallback): Promise<Uint8Array> {
    return this.mutex.run(async () => {
      this.mtuQueue.clear();
      const packets = buildRfc76Packets(stream, this.airPacketSize);
      for (const packet of packets) {
        await this.mtu.write(packet);
      }
      return this.readResponse(onProgress);
    });
  }

  private async readResponse(onProgress?: ProgressCallback): Promise<Uint8Array> {
    const reassembler = new Rfc76Reassembler();
    let received = 0;
    try {
      while (true) {
        const packet = await withTimeout(
          this.mtuQueue.next(),
          PROTOCOL_TIMEOUT_MS,
          () => new TimeoutError('PSFTP response timed out'),
        );
        received += Math.max(0, packet.length - 1);
        onProgress?.(received);
        const done = reassembler.push(packet);
        if (done) return done.body;
      }
    } catch (error) {
      // A PftpError already terminated the stream device-side; cancel otherwise.
      if (!(error instanceof PftpError)) {
        try {
          await this.mtu.write(RFC76_CANCEL_PACKET);
        } catch {}
      }
      throw error;
    }
  }
}

/**
 * Thin wrappers over the Web Bluetooth GATT objects, making a `BluetoothDevice`
 * the library's single injected seam.
 * @packageDocumentation
 */

import { DisconnectedError } from '../errors.js';

function toBytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

/**
 * Wraps a single GATT characteristic, providing reads, writes, and a fan-out
 * notification listener registry. Notifications are started lazily on first
 * `listen()`.
 */
export class CharacteristicChannel {
  private readonly handlers = new Set<(bytes: Uint8Array) => void>();
  private isNotifying = false;
  private shouldPreferNoResponseWrite = true;

  constructor(private readonly characteristic: BluetoothRemoteGATTCharacteristic) {}

  private readonly onEvent = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (!target.value) return;
    const bytes = toBytes(target.value);
    for (const handler of this.handlers) handler(bytes);
  };

  /** Register a notification handler; returns an unsubscribe function. */
  async listen(handler: (bytes: Uint8Array) => void): Promise<() => void> {
    if (!this.isNotifying) {
      this.characteristic.addEventListener('characteristicvaluechanged', this.onEvent);
      await this.characteristic.startNotifications();
      this.isNotifying = true;
    }
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async read(): Promise<Uint8Array> {
    return toBytes(await this.characteristic.readValue());
  }

  async writeWithResponse(data: Uint8Array): Promise<void> {
    await this.characteristic.writeValueWithResponse(data as unknown as BufferSource);
  }

  async writeWithoutResponse(data: Uint8Array): Promise<void> {
    await this.characteristic.writeValueWithoutResponse(data as unknown as BufferSource);
  }

  /** Write, falling back to acknowledged writes where write-without-response is unsupported. */
  async write(data: Uint8Array): Promise<void> {
    if (this.shouldPreferNoResponseWrite) {
      try {
        await this.writeWithoutResponse(data);
        return;
      } catch {
        this.shouldPreferNoResponseWrite = false;
      }
    }
    await this.writeWithResponse(data);
  }
}

/**
 * Resolves and caches the services/characteristics the library uses on a single
 * connected `BluetoothDevice`. Missing optional services resolve to `undefined`
 * so the library degrades gracefully on firmware that lacks them.
 */
export class GattContext {
  private readonly services = new Map<string, BluetoothRemoteGATTService | null>();
  private readonly channels = new Map<string, CharacteristicChannel>();

  constructor(private readonly server: BluetoothRemoteGATTServer) {}

  private async service(uuid: string): Promise<BluetoothRemoteGATTService | null> {
    if (this.services.has(uuid)) return this.services.get(uuid)!;
    let svc: BluetoothRemoteGATTService | null = null;
    try {
      svc = await this.server.getPrimaryService(uuid);
    } catch {
      svc = null;
    }
    this.services.set(uuid, svc);
    return svc;
  }

  /** Get a channel for a characteristic, or `undefined` if its service/char is absent. */
  async channel(serviceUuid: string, characteristicUuid: string): Promise<CharacteristicChannel | undefined> {
    const key = `${serviceUuid}/${characteristicUuid}`;
    if (this.channels.has(key)) return this.channels.get(key);
    const svc = await this.service(serviceUuid);
    if (!svc) return undefined;
    try {
      const char = await svc.getCharacteristic(characteristicUuid);
      const ch = new CharacteristicChannel(char);
      this.channels.set(key, ch);
      return ch;
    } catch {
      return undefined;
    }
  }

  /** Like {@link channel} but throws {@link DisconnectedError} when absent (required characteristics). */
  async requireChannel(serviceUuid: string, characteristicUuid: string): Promise<CharacteristicChannel> {
    const ch = await this.channel(serviceUuid, characteristicUuid);
    if (!ch) {
      throw new DisconnectedError(
        `required characteristic ${characteristicUuid} is unavailable (service ${serviceUuid})`,
      );
    }
    return ch;
  }
}

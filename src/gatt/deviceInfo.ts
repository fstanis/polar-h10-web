/**
 * Battery Service and Device Information Service reads.
 * @packageDocumentation
 */

import type { GattContext } from './transport.js';
import {
  BATTERY_SERVICE,
  BATTERY_LEVEL_CHAR,
  DIS_SERVICE,
  DIS_MODEL_NUMBER_CHAR,
  DIS_MANUFACTURER_NAME_CHAR,
  DIS_HARDWARE_REVISION_CHAR,
  DIS_FIRMWARE_REVISION_CHAR,
  DIS_SOFTWARE_REVISION_CHAR,
  DIS_SYSTEM_ID_CHAR,
} from './uuids.js';

/** Decoded Device Information Service fields; each is absent when the firmware omits it. */
export interface DeviceInfo {
  modelNumber?: string;
  manufacturerName?: string;
  hardwareRevision?: string;
  firmwareRevision?: string;
  softwareRevision?: string;
  /** SYSTEM_ID rendered as reverse-order hex. */
  systemId?: string;
}

const utf8 = new TextDecoder();

/** Render SYSTEM_ID bytes as reverse-order uppercase hex, e.g. `01 02 03 04` → `"04030201"`. */
export function systemIdToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = bytes.length - 1; i >= 0; i--) {
    hex += bytes[i]!.toString(16).toUpperCase().padStart(2, '0');
  }
  return hex;
}

export class BatteryClient {
  constructor(private readonly gatt: GattContext) {}

  /** Read the battery level as a percentage, or `undefined` if unavailable/out of range. */
  async read(): Promise<number | undefined> {
    const channel = await this.gatt.channel(BATTERY_SERVICE, BATTERY_LEVEL_CHAR);
    if (!channel) return undefined;
    const bytes = await channel.read();
    if (bytes.length < 1) return undefined;
    const level = bytes[0]!;
    return level >= 0 && level <= 100 ? level : undefined;
  }
}

export class DeviceInfoClient {
  constructor(private readonly gatt: GattContext) {}

  private async readString(char: string): Promise<string | undefined> {
    const channel = await this.gatt.channel(DIS_SERVICE, char);
    if (!channel) return undefined;
    try {
      return utf8.decode(await channel.read()).replace(/\0+$/, '');
    } catch {
      return undefined;
    }
  }

  private async readSystemId(): Promise<string | undefined> {
    const channel = await this.gatt.channel(DIS_SERVICE, DIS_SYSTEM_ID_CHAR);
    if (!channel) return undefined;
    try {
      return systemIdToHex(await channel.read());
    } catch {
      return undefined;
    }
  }

  async read(): Promise<DeviceInfo> {
    const [modelNumber, manufacturerName, hardwareRevision, firmwareRevision, softwareRevision, systemId] =
      await Promise.all([
        this.readString(DIS_MODEL_NUMBER_CHAR),
        this.readString(DIS_MANUFACTURER_NAME_CHAR),
        this.readString(DIS_HARDWARE_REVISION_CHAR),
        this.readString(DIS_FIRMWARE_REVISION_CHAR),
        this.readString(DIS_SOFTWARE_REVISION_CHAR),
        this.readSystemId(),
      ]);

    return {
      modelNumber,
      manufacturerName,
      hardwareRevision,
      firmwareRevision,
      softwareRevision,
      systemId,
    };
  }
}

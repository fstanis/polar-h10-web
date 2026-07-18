/**
 * Standard Heart Rate Service client.
 * @packageDocumentation
 */

import type { GattContext } from './transport.js';
import { HR_SERVICE, HR_MEASUREMENT_CHAR } from './uuids.js';

/** One Heart Rate Measurement notification, decoded. */
export interface HrSample {
  /** Heart rate in beats per minute. */
  hr: number;
  /** True only when both sensor-contact bits are set. */
  contactDetected: boolean;
  /** Whether the sensor reports contact-detection support. */
  contactSupported: boolean;
  /** RR intervals in milliseconds (may be empty; oldest first). */
  rrMs: number[];
  /** RR intervals in raw 1/1024-second units. */
  rrRaw: number[];
  /** Energy expended in kJ, if present in this notification. */
  energyExpended?: number;
}

/** Parse a Heart Rate Measurement (0x2A37) notification payload. */
export function parseHrMeasurement(data: Uint8Array): HrSample {
  const flags = data[0]!;
  const hrFormat = flags & 0x01;
  const contactDetected = (flags & 0x06) >> 1 === 0x03;
  const contactSupported = (flags & 0x04) !== 0;
  const energyPresent = (flags & 0x08) !== 0;
  const rrPresent = (flags & 0x10) !== 0;

  let hr: number;
  let offset: number;
  if (hrFormat === 1) {
    hr = (data[1]! | (data[2]! << 8)) & 0xffff;
    offset = 3;
  } else {
    hr = data[1]! & 0xff;
    offset = 2;
  }

  let energyExpended: number | undefined;
  if (energyPresent) {
    energyExpended = (data[offset]! & 0xff) | ((data[offset + 1]! & 0xff) << 8);
    offset += 2;
  }

  const rrRaw: number[] = [];
  const rrMs: number[] = [];
  if (rrPresent) {
    while (offset + 1 < data.length) {
      const raw = (data[offset]! & 0xff) | ((data[offset + 1]! & 0xff) << 8);
      rrRaw.push(raw);
      rrMs.push(Math.round((raw / 1024.0) * 1000.0));
      offset += 2;
    }
  }

  return { hr, contactDetected, contactSupported, rrMs, rrRaw, energyExpended };
}

export class HrClient {
  constructor(private readonly gatt: GattContext) {}

  /** Start HR notifications; returns an unsubscribe function. */
  async listen(onSample: (sample: HrSample) => void): Promise<() => void> {
    const channel = await this.gatt.requireChannel(HR_SERVICE, HR_MEASUREMENT_CHAR);
    return channel.listen((bytes) => {
      if (bytes.length >= 2) onSample(parseHrMeasurement(bytes));
    });
  }
}

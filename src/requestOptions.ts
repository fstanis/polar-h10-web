/**
 * Ready-made `navigator.bluetooth.requestDevice()` options for the H10. The
 * chooser requires a user gesture, so opening it belongs to the app.
 * @packageDocumentation
 */

import { ChooserCancelledError, UnsupportedBrowserError } from './errors.js';
import { isWebBluetoothAvailable } from './featureDetect.js';
import { HR_SERVICE, BATTERY_SERVICE, DIS_SERVICE, PMD_SERVICE, PSFTP_SERVICE } from './gatt/uuids.js';

/**
 * Filters on the standard Heart Rate service (which the H10 advertises) and
 * declares the PMD, PSFTP, battery, and device-information services as optional
 * so they can be accessed after connecting.
 *
 * @param namePrefix - When provided, additionally filters by device name prefix
 *   (e.g. `"Polar H10"`).
 */
export function requestOptions(namePrefix?: string): RequestDeviceOptions {
  const filters: BluetoothLEScanFilter[] = [{ services: [HR_SERVICE] }];
  if (namePrefix) filters.push({ namePrefix });
  return {
    filters,
    optionalServices: [PMD_SERVICE, PSFTP_SERVICE, BATTERY_SERVICE, DIS_SERVICE],
  };
}

/**
 * Convenience wrapper around `navigator.bluetooth.requestDevice()` using
 * {@link requestOptions}. Must be called from a user gesture. Throws
 * {@link UnsupportedBrowserError} when Web Bluetooth is unavailable and
 * {@link ChooserCancelledError} when the user dismisses the chooser.
 */
export async function requestH10(namePrefix?: string): Promise<BluetoothDevice> {
  if (!isWebBluetoothAvailable()) {
    throw new UnsupportedBrowserError();
  }
  try {
    return await navigator.bluetooth.requestDevice(requestOptions(namePrefix));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new ChooserCancelledError();
    }
    throw error;
  }
}

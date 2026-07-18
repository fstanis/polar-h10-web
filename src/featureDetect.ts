/**
 * Runtime feature detection for Web Bluetooth and its optional sub-features.
 * @packageDocumentation
 */

/** Whether `navigator.bluetooth` and GATT are available in this context (Chromium, HTTPS). */
export function isWebBluetoothAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.bluetooth !== 'undefined' &&
    typeof navigator.bluetooth.requestDevice === 'function'
  );
}

/**
 * Whether `getDevices()` (re-acquiring previously granted devices without the
 * chooser) is available. Requires the experimental permissions backend on some
 * builds.
 */
export function isGetDevicesAvailable(): boolean {
  return isWebBluetoothAvailable() && typeof navigator.bluetooth.getDevices === 'function';
}

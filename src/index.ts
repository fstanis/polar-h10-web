/**
 * `polar-h10-web` — full access to the Polar H10 chest-strap sensor over Web
 * Bluetooth: ECG, accelerometer, heart rate / RR, and internal
 * exercise-recording management.
 *
 * The app obtains a `BluetoothDevice` from `navigator.bluetooth.requestDevice()`
 * (using {@link requestOptions}) and passes it to {@link connect}. See the
 * package README and PROTOCOL.md for the wire-level details.
 *
 * @packageDocumentation
 */

export {
  connect,
  reacquireDevices,
  H10Device,
  type ConnectOptions,
  type StreamOptions,
  type DisconnectEventDetail,
} from './device.js';

export { requestOptions, requestH10 } from './requestOptions.js';

export { isWebBluetoothAvailable, isGetDevicesAvailable } from './featureDetect.js';

export {
  PolarError,
  UnsupportedBrowserError,
  ChooserCancelledError,
  DisconnectedError,
  TimeoutError,
  InvalidStateError,
  NotSupportedError,
  ControlPointError,
  PftpError,
  ProtocolError,
  type PolarErrorCode,
} from './errors.js';

export type { HrSample } from './gatt/hrClient.js';
export type { DeviceInfo } from './gatt/deviceInfo.js';

export {
  PmdMeasurementType,
  PmdControlPointStatus,
  PmdSettingType,
  polarNanosToUnixMs,
  POLAR_EPOCH_UNIX_MS,
  type EcgSample,
  type AccSample,
} from './pmd/types.js';
export type { EcgStreamConfig, AccStreamConfig } from './pmd/pmdClient.js';
export type { PmdSettingsMap, SelectedSettings } from './pmd/settings.js';

export type {
  RecordingApi,
  RecordingType,
  RecordingInterval,
  RecordingStatus,
  RecordingEntry,
  RecordingData,
  StartRecordingOptions,
} from './recording/recording.js';
export type { ProgressCallback, PsftpOptions } from './psftp/psftpClient.js';

export * as uuids from './gatt/uuids.js';

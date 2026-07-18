/**
 * The public H10 device handle and the `connect()` entry point.
 * @packageDocumentation
 */

import { DisconnectedError, InvalidStateError } from './errors.js';
import { isGetDevicesAvailable } from './featureDetect.js';
import { GattContext } from './gatt/transport.js';
import { HrClient, type HrSample } from './gatt/hrClient.js';
import { BatteryClient, DeviceInfoClient, type DeviceInfo } from './gatt/deviceInfo.js';
import { PmdClient, type AccStreamConfig, type EcgStreamConfig } from './pmd/pmdClient.js';
import { PmdMeasurementType, type AccSample, type EcgSample } from './pmd/types.js';
import type { PmdSettingsMap } from './pmd/settings.js';
import { PsftpClient, type PsftpOptions } from './psftp/psftpClient.js';
import { RecordingApi } from './recording/recording.js';
import { AsyncQueue } from './util/async.js';

/** Options for {@link connect}. */
export interface ConnectOptions extends PsftpOptions {
  /** Skip PSFTP setup; recording features become unavailable and the file-transfer service is left untouched. */
  skipRecording?: boolean;
}

/** Options common to the live streams. */
export interface StreamOptions {
  /** Abort to stop the stream. */
  signal?: AbortSignal;
}

/** Detail of the `"disconnect"` event dispatched by {@link H10Device}. */
export interface DisconnectEventDetail {
  /** Whether the disconnect was requested via {@link H10Device.disconnect}. */
  requested: boolean;
}

/**
 * A connected Polar H10. Obtain one via {@link connect}. A dropped link fires a
 * `"disconnect"` event and rejects active streams with a {@link DisconnectedError}.
 *
 * @remarks Device-state rules: the H10 has a single internal recording slot, and
 * it drops the BLE link ~45 s after being removed from the strap, which can abort
 * long downloads.
 */
export class H10Device extends EventTarget {
  private gatt!: GattContext;
  private pmd!: PmdClient;
  private psftp?: PsftpClient;
  private hr!: HrClient;
  private battery!: BatteryClient;
  private dis!: DeviceInfoClient;
  private recordingApi?: RecordingApi;
  private readonly streamQueues = new Set<{ fail: (error: Error) => void }>();
  private isDisconnectRequested = false;
  private isConnected = false;

  /** @internal Use {@link connect}. */
  private constructor(
    readonly device: BluetoothDevice,
    private readonly options: ConnectOptions,
  ) {
    super();
  }

  /** @internal */
  static async open(device: BluetoothDevice, options: ConnectOptions): Promise<H10Device> {
    const handle = new H10Device(device, options);
    device.addEventListener('gattserverdisconnected', handle.onGattDisconnected);
    await handle.establish();
    return handle;
  }

  private readonly onGattDisconnected = (): void => {
    if (!this.isConnected) return;
    this.isConnected = false;
    const error = new DisconnectedError();
    this.pmd?.handleDisconnect(error);
    this.psftp?.handleDisconnect(error);
    for (const queue of this.streamQueues) queue.fail(error);
    this.streamQueues.clear();
    this.dispatchEvent(
      new CustomEvent<DisconnectEventDetail>('disconnect', {
        detail: { requested: this.isDisconnectRequested },
      }),
    );
  };

  /** Connect the GATT server (if needed) and (re)build the protocol clients. */
  private async establish(): Promise<void> {
    if (!this.device.gatt) {
      throw new DisconnectedError('device has no GATT server');
    }
    const server = this.device.gatt.connected ? this.device.gatt : await this.device.gatt.connect();
    this.gatt = new GattContext(server);
    this.pmd = new PmdClient(this.gatt);
    this.hr = new HrClient(this.gatt);
    this.battery = new BatteryClient(this.gatt);
    this.dis = new DeviceInfoClient(this.gatt);
    await this.pmd.init();
    if (!this.options.skipRecording) {
      this.psftp = new PsftpClient(this.gatt, this.options);
      await this.psftp.init();
      this.recordingApi = new RecordingApi(this.psftp);
    }
    this.isDisconnectRequested = false;
    this.isConnected = true;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /** @throws {InvalidStateError} when connected with `skipRecording`. */
  get recordings(): RecordingApi {
    if (!this.recordingApi) {
      throw new InvalidStateError('recording features are unavailable (connected with skipRecording)');
    }
    return this.recordingApi;
  }

  /** Read the battery level as a percentage (0..100), or `undefined` if unavailable. */
  readBattery(): Promise<number | undefined> {
    return this.battery.read();
  }

  readDeviceInfo(): Promise<DeviceInfo> {
    return this.dis.read();
  }

  streamHeartRate(options: StreamOptions = {}): AsyncIterableIterator<HrSample> {
    return this.makeStream<HrSample>((push) => this.hr.listen(push), options.signal);
  }

  /** Stream raw ECG at 130 Hz (µV). Ending the iteration stops the measurement on the device. */
  streamEcg(config: EcgStreamConfig = {}): AsyncIterableIterator<EcgSample> {
    return this.pmd.streamEcg(config);
  }

  /** Stream accelerometer data at the chosen sample rate/range (mG). Ending the iteration stops the measurement on the device. */
  streamAcc(config: AccStreamConfig): AsyncIterableIterator<AccSample> {
    return this.pmd.streamAcc(config);
  }

  getEcgSettings(): Promise<PmdSettingsMap> {
    return this.pmd.getSettings(PmdMeasurementType.Ecg);
  }

  getAccSettings(): Promise<PmdSettingsMap> {
    return this.pmd.getSettings(PmdMeasurementType.Acc);
  }

  /** Set the device clock so internal recordings carry correct timestamps. */
  setTime(when?: Date): Promise<void> {
    return this.recordings.setTime(when);
  }

  /**
   * Re-establish a dropped link on this same handle without re-running the
   * chooser. Active streams from before the disconnect are not resumed.
   */
  async reconnect(): Promise<void> {
    if (this.isConnected) return;
    await this.establish();
  }

  /** Fires a `"disconnect"` event with `requested: true`. */
  disconnect(): void {
    this.isDisconnectRequested = true;
    this.device.gatt?.disconnect();
  }

  private async *makeStream<T>(
    subscribe: (push: (value: T) => void) => Promise<() => void>,
    signal?: AbortSignal,
  ): AsyncIterableIterator<T> {
    if (signal?.aborted) return;
    const queue = new AsyncQueue<T>();
    this.streamQueues.add(queue);
    let unsubscribe: (() => void) | undefined;
    const onAbort = () => queue.close();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      unsubscribe = await subscribe((value) => queue.push(value));
      yield* queue.consume(signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      unsubscribe?.();
      this.streamQueues.delete(queue);
    }
  }
}

/**
 * Establish the GATT connection and set up the protocol clients. Does not open
 * the device chooser — pass a `BluetoothDevice` from the app's own
 * `requestDevice()` call or {@link reacquireDevices}.
 *
 * @example
 * ```ts
 * const device = await navigator.bluetooth.requestDevice(requestOptions());
 * const h10 = await connect(device);
 * for await (const beat of h10.streamHeartRate()) console.log(beat.hr);
 * ```
 */
export function connect(device: BluetoothDevice, options: ConnectOptions = {}): Promise<H10Device> {
  return H10Device.open(device, options);
}

/**
 * Re-acquire previously granted H10 devices via `navigator.bluetooth.getDevices()`,
 * so returning users skip the chooser. Returns an empty array where unsupported.
 * The returned devices are not yet connected — pass one to {@link connect}.
 */
export async function reacquireDevices(): Promise<BluetoothDevice[]> {
  if (!isGetDevicesAvailable()) return [];
  return navigator.bluetooth.getDevices();
}

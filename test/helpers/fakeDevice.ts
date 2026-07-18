/**
 * A fake `BluetoothDevice` implementing the minimal GATT subset the library
 * uses. This is the ONLY test double in the codebase; it sits at the platform
 * boundary (a real `requestDevice()` affordance) and is scripted with byte
 * exchanges. Higher-level responders model the H10's PMD and PSFTP behaviour.
 */

import { buildRfc76Packets, parseRfc76Packet, Rfc76Status } from '../../src/psftp/framing.js';
import { concatBytes } from '../../src/util/bytes.js';
import * as U from '../../src/gatt/uuids.js';

const enc = new TextEncoder();

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  readBytes: Uint8Array = new Uint8Array(0);
  readonly writes: Uint8Array[] = [];
  onWrite?: (bytes: Uint8Array) => void;
  isNotifying = false;

  constructor(readonly uuid: string) {
    super();
  }

  async readValue(): Promise<DataView> {
    this.value = new DataView(this.readBytes.buffer.slice(0));
    return this.value;
  }

  async writeValueWithResponse(data: BufferSource): Promise<void> {
    this.record(data);
  }
  async writeValueWithoutResponse(data: BufferSource): Promise<void> {
    this.record(data);
  }
  private record(data: BufferSource): void {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength,
          );
    const copy = new Uint8Array(bytes);
    this.writes.push(copy);
    this.onWrite?.(copy);
  }

  async startNotifications(): Promise<FakeCharacteristic> {
    this.isNotifying = true;
    return this;
  }
  async stopNotifications(): Promise<FakeCharacteristic> {
    this.isNotifying = false;
    return this;
  }

  notify(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class FakeService {
  readonly characteristics = new Map<string, FakeCharacteristic>();
  constructor(readonly uuid: string) {}
  async getCharacteristic(uuid: string): Promise<FakeCharacteristic> {
    const c = this.characteristics.get(uuid.toLowerCase());
    if (!c) throw new DOMException(`characteristic ${uuid} not found`, 'NotFoundError');
    return c;
  }
}

class FakeServer {
  connected = false;
  readonly services = new Map<string, FakeService>();
  constructor(readonly device: FakeDevice) {}
  async connect(): Promise<FakeServer> {
    this.connected = true;
    return this;
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.device.dispatchEvent(new Event('gattserverdisconnected'));
  }
  async getPrimaryService(uuid: string): Promise<FakeService> {
    const s = this.services.get(uuid.toLowerCase());
    if (!s) throw new DOMException(`service ${uuid} not found`, 'NotFoundError');
    return s;
  }
}

export class FakeDevice extends EventTarget {
  readonly id = 'fake-h10';
  readonly name = 'Polar H10 FAKE';
  readonly gatt: FakeServer;
  constructor() {
    super();
    this.gatt = new FakeServer(this);
  }
  char(service: string, characteristic: string): FakeCharacteristic {
    return this.gatt.services.get(service.toLowerCase())!.characteristics.get(characteristic.toLowerCase())!;
  }
  private addService(uuid: string, chars: string[]): void {
    const svc = new FakeService(uuid.toLowerCase());
    for (const c of chars) svc.characteristics.set(c.toLowerCase(), new FakeCharacteristic(c.toLowerCase()));
    this.gatt.services.set(uuid.toLowerCase(), svc);
  }
  /** Populate the full H10 service/characteristic layout. */
  buildServices(): void {
    this.addService(U.HR_SERVICE, [U.HR_MEASUREMENT_CHAR]);
    this.addService(U.BATTERY_SERVICE, [U.BATTERY_LEVEL_CHAR]);
    this.addService(U.DIS_SERVICE, [
      U.DIS_MODEL_NUMBER_CHAR,
      U.DIS_MANUFACTURER_NAME_CHAR,
      U.DIS_FIRMWARE_REVISION_CHAR,
      U.DIS_HARDWARE_REVISION_CHAR,
      U.DIS_SOFTWARE_REVISION_CHAR,
      U.DIS_SYSTEM_ID_CHAR,
    ]);
    this.addService(U.PMD_SERVICE, [U.PMD_CONTROL_POINT_CHAR, U.PMD_DATA_CHAR]);
    this.addService(U.PSFTP_SERVICE, [U.PSFTP_MTU_CHAR]);
  }
  asBluetoothDevice(): BluetoothDevice {
    return this as unknown as BluetoothDevice;
  }
}

/** Control-point response builder: `F0 opcode type status more ...params`. */
export function cpResponse(
  opcode: number,
  type: number,
  status: number,
  params: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return concatBytes(new Uint8Array([0xf0, opcode, type, status, 0x00]), params);
}

/**
 * Install a default PMD responder on the fake, mirroring real H10 behavior:
 * GET_SETTINGS answers the captured ECG settings TLV, START answers
 * `F0 02 xx 00 00 01` (no FACTOR TLV), STOP succeeds, and any other opcode is
 * rejected with ErrorInvalidOpCode. The returned controller lets tests force
 * errors and emit data frames.
 */
export function installPmdResponder(fake: FakeDevice): {
  emitData: (frame: Uint8Array) => void;
  setFailStart: (status: number | undefined) => void;
} {
  const cp = fake.char(U.PMD_SERVICE, U.PMD_CONTROL_POINT_CHAR);
  const data = fake.char(U.PMD_SERVICE, U.PMD_DATA_CHAR);
  // Feature bitmask read: ECG (bit0) + ACC (bit2) in data[1].
  cp.readBytes = new Uint8Array([0x0f, 0x05, 0x00]);
  let failStart: number | undefined;

  cp.onWrite = (bytes) => {
    const opcode = bytes[0]!;
    const type = bytes[1] ?? 0;
    queueMicrotask(() => {
      switch (opcode) {
        case 0x01: // GET_MEASUREMENT_SETTINGS
          cp.notify(cpResponse(0x01, type, 0x00, new Uint8Array([0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00])));
          break;
        case 0x02: // REQUEST_MEASUREMENT_START
          if (failStart !== undefined) {
            cp.notify(cpResponse(0x02, type, failStart));
          } else {
            cp.notify(cpResponse(0x02, type, 0x00, new Uint8Array([0x01])));
          }
          break;
        case 0x03: // STOP_MEASUREMENT
          cp.notify(cpResponse(0x03, type, 0x00));
          break;
        default:
          cp.notify(cpResponse(opcode, type, 0x01)); // ERROR_INVALID_OP_CODE
      }
    });
  };

  return {
    emitData: (frame) => data.notify(frame),
    setFailStart: (status) => {
      failStart = status;
    },
  };
}

/**
 * Install a PSFTP responder that reassembles inbound request/query streams and
 * replies with the body produced by `respond(envelope)`. `envelope` is the RFC60
 * stream (2-byte header + payload); `respond` returns the response body bytes,
 * or throws with an `errorId` to signal a device error.
 */
export function installPsftpResponder(fake: FakeDevice, respond: (envelope: Uint8Array) => Uint8Array): void {
  const mtu = fake.char(U.PSFTP_SERVICE, U.PSFTP_MTU_CHAR);
  let inbound: Uint8Array[] = [];
  mtu.onWrite = (packet) => {
    const header = parseRfc76Packet(packet);
    if (header.status === Rfc76Status.ErrorOrResponse) {
      inbound = [];
      return;
    }
    inbound.push(header.payload!);
    if (header.status === Rfc76Status.Last) {
      const envelope = concatBytes(...inbound);
      inbound = [];
      let body: Uint8Array;
      try {
        body = respond(envelope);
      } catch (e) {
        const errorId = (e as { errorId?: number }).errorId ?? 200;
        queueMicrotask(() => mtu.notify(new Uint8Array([0x00, errorId & 0xff, (errorId >> 8) & 0xff])));
        return;
      }
      queueMicrotask(() => {
        for (const p of buildRfc76Packets(body, 20)) mtu.notify(p);
      });
    }
  };
}

export function setDisString(fake: FakeDevice, charUuid: string, value: string): void {
  fake.char(U.DIS_SERVICE, charUuid).readBytes = enc.encode(value);
}

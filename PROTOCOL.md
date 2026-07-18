# Polar H10 BLE Protocol Reference

A self-contained distillation of the wire protocols the Polar H10 speaks, as
implemented by `polar-h10-web`. It is derived from the official Polar BLE SDK
(Android/Kotlin sources) and verified against wire traces of a real H10
(firmware 5.0.0; software 3.3.1 and 4.2.0 behaved byte-identically). All
multi-byte integers are **little-endian** unless noted.

- [1. GATT services](#1-gatt-services)
- [2. Standard GATT: HR, Battery, Device Information](#2-standard-gatt)
- [3. PMD — Polar Measurement Data (ECG, ACC)](#3-pmd)
- [4. PSFTP — file transfer (RFC60 + RFC76)](#4-psftp)
- [5. H10 internal recording flows](#5-recording)
- [6. Error codes](#6-errors)
- [7. Known hardware quirks](#7-quirks)

---

## 1. GATT services

| Service            | UUID                                   | Purpose                        |
| ------------------ | -------------------------------------- | ------------------------------ |
| Heart Rate         | `0000180D-…`                           | HR + RR notifications          |
| Battery            | `0000180F-…`                           | battery level read             |
| Device Information | `0000180A-…`                           | firmware/hardware/model        |
| PMD                | `FB005C80-02E7-F387-1CAD-8ACD2D8DF0C8` | ECG/ACC streaming              |
| PSFTP (RFC77)      | `0000FEEE-…`                           | file transfer, recording, time |

PMD characteristics: control point `FB005C81-…`, data `FB005C82-…`. PSFTP
characteristics: MTU pipe `FB005C51-…` (the device also exposes device→host
`FB005C52-…` and host→device `FB005C53-…` notification pipes, but no H10 flow
uses them).

The H10 advertises the standard Heart Rate service, so a chooser filter on
`180D` finds it; the PMD, PSFTP, battery, and DIS services must be listed as
`optionalServices` at `requestDevice()` time.

<a name="2-standard-gatt"></a>

## 2. Standard GATT

### Heart Rate Measurement (`0x2A37`, notify)

Byte 0 is a flags field:

| Bit | Meaning                                       |
| --- | --------------------------------------------- |
| 0   | HR value format: `0` = uint8, `1` = uint16 LE |
| 1   | sensor contact status                         |
| 2   | sensor contact supported                      |
| 3   | energy expended present (adds uint16 LE)      |
| 4   | RR intervals present                          |

Contact is reported detected only when **both** bits 1 and 2 are set
(`(flags & 0x06) >> 1 === 3`). HR follows the flags (1 or 2 bytes). If bit 3 is
set, a uint16 LE energy field follows. If bit 4 is set, the remaining bytes are
uint16 LE RR intervals in units of **1/1024 s**; convert with
`ms = round(raw / 1024 * 1000)`.

### Battery Level (`0x2A19`, read/notify)

Single byte = percentage 0..100. Values outside that range are invalid.

### Device Information (`0x180A`, read)

Model `0x2A24`, manufacturer `0x2A29`, hardware revision `0x2A27`, firmware
revision `0x2A26`, software revision `0x2A28` — all UTF-8 strings. `SYSTEM_ID`
(`0x2A23`) is binary, rendered to hex in **reverse** byte order (`01 02 03 04` →
`"04030201"`). The serial-number characteristic (`0x2A25`) exists on the device
but is on the Web Bluetooth blocklist, so no browser can read it.

<a name="3-pmd"></a>

## 3. PMD

Setup: enable notifications on the control point, **read** the control point
once (returns the feature bitmask), enable notifications on the data
characteristic. Only then write control-point commands (write-with-response).
Each command yields one or more control-point response notifications;
measurement samples arrive as data notifications.

### 3.1 Feature bitmask (control-point read)

`data[1]` bit 0 = ECG, bit 2 = ACC (plus PPG/PPI/etc. on other sensors). The
real H10 answers `0F 05 00 …` — ECG and ACC only, every other feature byte zero.

### 3.2 Control-point commands (client → service)

| Opcode | Command                   |
| ------ | ------------------------- |
| `0x01` | GET_MEASUREMENT_SETTINGS  |
| `0x02` | REQUEST_MEASUREMENT_START |
| `0x03` | STOP_MEASUREMENT          |

The protocol also defines opcodes `0x04` (GET_SDK_MODE_MEASUREMENT_SETTINGS),
`0x05` (GET_MEASUREMENT_STATUS), and `0x06` (GET_SDK_MODE_STATUS), but H10
firmware rejects all three with error 1 (invalid op code), and start/stop of the
SDK_MODE pseudo-type `9` with error 2 (invalid measurement type) — SDK mode is a
Verity Sense feature.

Measurement type ids: ECG `0`, ACC `2`. Many commands carry a
`(recordingType << 7) | typeId` byte; for online H10 streaming the recording bit
is 0 (ECG → `0x00`, ACC → `0x02`).

- **Get settings**: `[0x01][typeByte]`. Response parameters = a settings TLV
  list.
- **Start**: `[0x02][typeByte][settings TLV…]`. Response parameters echo a
  settings TLV list; read the `FACTOR` setting (used to scale ACC) when present
  — the traced H10 answers with a single parameter byte and no FACTOR TLV.
- **Stop**: `[0x03][plain typeId]` (no recording bit).

### 3.3 Settings TLV

Concatenated records: `[settingType][count][value×count]`, each value
`fieldSize` bytes LE. Field sizes for the types the H10 emits: SAMPLE_RATE(0)=2,
RESOLUTION(1)=2, RANGE(2)=2, FACTOR(5)=4 (IEEE-754 float). An unknown type id is
a hard parse error — guessing a field size would silently desync the stream. In
a query response, `count` may be >1 (supported options). In a start request,
`count`=1 and `FACTOR` is omitted (response-only).

H10 ECG start: `SAMPLE_RATE=130`, `RESOLUTION=14` (`00 01 82 00  01 01 0E 00`).
ACC adds `RANGE` (2/4/8 G) and `RESOLUTION=16`.

### 3.4 Control-point response frame

`[0xF0][opcode][typeByte][status][more][params…]`. On success, `more` (byte 4)
non-zero means further response notifications follow; append their `bytes[5..]`.
On error, no params. Any control-point notification whose first byte is **not**
`0xF0` is device-initiated; `0x01` = ONLINE_MEASUREMENT_STOPPED, remaining bytes
are the stopped type ids.

Status codes: 0 success; 1 invalid op code; 2 invalid measurement type; 3 not
supported; 4 invalid length; 5 invalid parameter; 6 already in state; 7 invalid
resolution; 8 invalid sample rate; 9 invalid range; 10 invalid MTU; 11 invalid
channel count; 12 invalid state; 13 device in charger; 14 disk full; 15–18
derived.

### 3.5 Data frame format

`[typeByte][8-byte timestamp LE][frameTypeByte][content…]` — a 10-byte header.
`typeByte & 0x3F` = measurement type. `frameTypeByte & 0x80` = delta-compressed
flag; `& 0x7F` = frame type. The 8-byte timestamp is **nanoseconds since
2000-01-01T00:00:00Z**, and is the timestamp of the **last** sample in the
frame.

**Delta decompression** (compressed frames): the content begins with a reference
sample of `channels` values, each `ceil(resolution/8)` bytes LE (sign-extended
for signed encodings). Then repeating blocks: `[bitWidth][sampleCount]` followed
by `ceil(sampleCount·bitWidth·channels / 8)` bytes of packed two's-complement
deltas. Deltas are unpacked **LSB-first** across bytes and within each field,
sign-extended at `bitWidth`, and added cumulatively to the previous sample.

**ECG** (type 0): raw frame type 0 — 3-byte signed LE µV per sample. The library
rejects any other ECG frame type.

**ACC** (type 2, 3 channels x/y/z, mG): frame type 1. Raw frames carry 2 signed
LE bytes per channel = mG directly (the format in the wire traces); delta-
compressed frames decode at 16-bit resolution to mG, multiplied by `FACTOR` and
truncated. The library rejects any other ACC frame type.

### 3.6 Per-sample timestamps

Given `prevFrameTs` (0 for the first frame of a type after start), `frameTs`,
`samplesSize`, and `sampleRate`:

- delta =
  `prevFrameTs == 0 ? 1e9/sampleRate : (frameTs − prevFrameTs)/samplesSize`.
- If `prevFrameTs == 0` and `frameTs < delta·samplesSize`, the frame is invalid.
- A `frameTs` not strictly greater than `prevFrameTs` is invalid — interpolating
  against it would corrupt sample times.
- Sample `i` (0..n−2): `round(frameTs − delta·(n−1−i))` when `prevFrameTs == 0`,
  else `round(prevFrameTs + delta·(i+1))`. The last sample equals `frameTs`.

Sample rates: ECG fixed 130 Hz; ACC 25/50/100/200 Hz; ACC range 2/4/8 G.

<a name="4-psftp"></a>

## 4. PSFTP

A request/response file protocol on two stacked framing layers over the MTU
characteristic (`FB005C51`). Host writes request air-packets; the device replies
with response air-packets as notifications on the **same** characteristic.

### 4.1 RFC60 envelope

Prepended to the payload before RFC76 framing:

- **REQUEST** (GET/PUT/MERGE/REMOVE file ops): 2-byte LE header-size prefix with
  bit 15 = 0, then the protobuf `PbPFtpOperation` bytes, then optional bulk
  data.
- **QUERY** (recording, time): 2 bytes = 15-bit query id with bit 15 set, then
  optional protobuf parameter bytes.
- **NOTIFICATION** (host→device): 1-byte id, then optional parameters.

### 4.2 RFC76 air packets

Each packet = 1 header byte + up to `size−1` payload bytes. Header bits: `bit0`
= next (0 on first packet, 1 after), `bits1–2` = status, `bits4–7` = 4-bit
sequence ring (0..15). Status values as parsed via `(b0>>1)&3`: `0x03` MORE,
`0x01` LAST, `0x00` ERROR_OR_RESPONSE. When writing, the status field is emitted
pre-shifted (`0x06` MORE, `0x02` LAST).

### 4.3 Reassembly

Read packets, verifying the sequence increments and the `next` alternation. MORE
and LAST payloads (`bytes[1..]`) are concatenated; LAST terminates the message.
An ERROR_OR_RESPONSE frame carries a 16-bit LE error code in bytes 1–2 — `0` =
success terminator, non-zero ⇒ a `PbPFtpError`. A sequence gap is a lost packet;
cancel an in-flight stream by writing `[0x00,0x00,0x00]`.

### 4.4 MTU

Web Bluetooth does not expose the negotiated ATT MTU. The SDK's pre-negotiation
default air-packet size is 20 (payload 19). This library defaults outbound
packets to 20 for guaranteed correctness and reads inbound packet lengths
dynamically; the outbound size is configurable for throughput. Protocol timeout
is 90 s.

<a name="5-recording"></a>

## 5. H10 internal recording flows

All over PSFTP. Queries use the QUERY envelope; file operations use
`PbPFtpOperation` (command GET=0 / PUT=1 / REMOVE=3, string path) in a REQUEST
envelope.

Query ids: SET_LOCAL_TIME=3, REQUEST_START_RECORDING=14,
REQUEST_STOP_RECORDING=15, REQUEST_RECORDING_STATUS=16. The protocol also
defines SET_SYSTEM_TIME=1 and GET_LOCAL_TIME=4, but the H10 answers both with
201 NOT_IMPLEMENTED — the device clock can be set, never read.

- **Start**: QUERY 14 with
  `PbPFtpRequestStartRecordingParams { sample_type, recording_interval (PbDuration seconds, HR only), sample_data_identifier }`.
  `sample_type` = `SAMPLE_TYPE_HEART_RATE(1)` or `SAMPLE_TYPE_RR_INTERVAL(16)`.
  Starting while a recording is already stored fails with PFTP error 106 — the
  H10 has a single recording slot.
- **Stop**: QUERY 15, no params. Stopping while idle also answers 106.
- **Status**: QUERY 16 →
  `PbRequestRecordingStatusResult { recording_on, sample_data_identifier }`.
- **List**: recursively GET directories from `/`, parsing
  `PbPFtpDirectory { repeated PbPFtpEntry { name, size } }`. Names ending `/`
  are subdirectories. The recording lives at `/<exerciseId>/SAMPLES.BPB`.
- **Fetch**: GET `/<exerciseId>/SAMPLES.BPB` → `PbExerciseSamples`. If
  `rr_samples` is present, the payload is `rr_samples.rr_intervals` (ms);
  otherwise `heart_rate_samples` (bpm), evenly spaced by
  `recording_interval.seconds`.
- **Remove**: REMOVE `/<exerciseId>/SAMPLES.BPB`.
- **Set time**: QUERY SET_LOCAL_TIME (local `PbDate`/`PbTime` + `tz_offset` in
  minutes).

Progress: the transfer reports cumulative payload bytes as air packets arrive.

<a name="6-errors"></a>

## 6. `PbPFtpError` codes

0 success, 1 rebooting, 2 try again; 100 host error, 101 invalid command, 102
invalid parameter, 103 no such file/dir, 104 dir exists, 105 file exists, 106
not permitted, 107 no such user, 108 timeout; 200 device error, 201 not
implemented, 202 system busy, 203 invalid content, 204 checksum failure, 205
disk full, 206 prerequisite not met, 207 insufficient buffer, 208 wait for
idling, 209 battery too low. Codes 300–399 are communication-layer synthetic
(e.g. 303 air packet lost).

<a name="7-quirks"></a>

## 7. Known hardware quirks

- The H10 drops the BLE link **~45 s after being removed from the strap**, which
  can abort long recording downloads — keep it worn during transfers.
- There is **one** internal recording slot; free it by deleting before recording
  (starting while occupied answers PFTP 106).
- **The device clock cannot be read**: GET_LOCAL_TIME and SET_SYSTEM_TIME answer
  201 NOT_IMPLEMENTED; only SET_LOCAL_TIME works.
- **SDK mode is not supported by H10 firmware** — every related control-point
  command is rejected (see §3.2). ACC 200 Hz / 8 G streams without it.
- The DIS **serial-number characteristic is browser-blocklisted**; identify a
  sensor via SYSTEM_ID instead.
- Web Bluetooth requires HTTPS + a user gesture for the chooser, gives no MTU
  visibility, and no background operation (the tab must stay open).

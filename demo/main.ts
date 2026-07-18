import * as lib from '../src/index.js';

// The snippets are rendered from Function.prototype.toString(); the bundler
// rewrites import bindings and renames colliding top-level names, so the
// snippets reach the library through this uniquely-named const (property
// accesses survive bundling verbatim).
const polar = lib;

const logElement = document.getElementById('log')!;

function log(line: string) {
  logElement.textContent += line + '\n';
  logElement.scrollTop = logElement.scrollHeight;
}

let device: lib.H10Device;
let heartRateAbort = new AbortController();
let ecgAbort = new AbortController();
let accAbort = new AbortController();

async function onConnectButtonClick() {
  log('Requesting Polar H10...');
  const bluetoothDevice = await polar.requestH10('Polar H10');

  log('Connecting...');
  device = await polar.connect(bluetoothDevice);
  device.addEventListener('disconnect', () => log('Disconnected.'));

  const info = await device.readDeviceInfo();
  log('> Name:     ' + bluetoothDevice.name);
  log('> Model:    ' + info.modelNumber);
  log('> Firmware: ' + info.firmwareRevision);
  log('> Battery:  ' + (await device.readBattery()) + '%');
}

function onDisconnectButtonClick() {
  device.disconnect();
}

async function onHeartRateButtonClick() {
  heartRateAbort = new AbortController();
  log('Starting heart rate stream...');
  for await (const sample of device.streamHeartRate({ signal: heartRateAbort.signal })) {
    log('> HR: ' + sample.hr + ' bpm, RR: [' + sample.rrMs.join(', ') + '] ms');
  }
  log('Heart rate stream stopped.');
}

function onHeartRateStopButtonClick() {
  heartRateAbort.abort();
}

async function onEcgButtonClick() {
  ecgAbort = new AbortController();
  log('Starting ECG stream...');
  let count = 0;
  for await (const sample of device.streamEcg({ signal: ecgAbort.signal })) {
    count += 1;
    if (count % 130 === 0) {
      log('> ECG: ' + sample.microVolts + ' µV (' + count + ' samples)');
    }
  }
  log('ECG stream stopped.');
}

function onEcgStopButtonClick() {
  ecgAbort.abort();
}

async function onAccButtonClick() {
  accAbort = new AbortController();
  log('Starting accelerometer stream...');
  let count = 0;
  for await (const sample of device.streamAcc({ sampleRate: 50, range: 4, signal: accAbort.signal })) {
    count += 1;
    if (count % 50 === 0) {
      log('> ACC: x=' + sample.x + ' y=' + sample.y + ' z=' + sample.z + ' mG');
    }
  }
  log('Accelerometer stream stopped.');
}

function onAccStopButtonClick() {
  accAbort.abort();
}

function wireButton(id: string, handler: () => unknown, options: { needsDevice?: boolean } = {}) {
  document.getElementById(id)!.addEventListener('click', async () => {
    if (options.needsDevice && !device) {
      log('Connect to an H10 first.');
      return;
    }
    try {
      await handler();
    } catch (error) {
      log('Error: ' + error);
    }
  });
}

function dedent(source: string): string {
  const [first, ...rest] = source.split('\n');
  const indents = rest.filter((line) => line.trim()).map((line) => line.match(/^ */)![0].length);
  if (indents.length === 0) {
    return source;
  }
  const trim = Math.min(...indents);
  return [first, ...rest.map((line) => line.slice(trim))].join('\n');
}

function showSnippet(id: string, functions: Array<() => unknown>) {
  const source = functions.map((fn) => dedent(fn.toString())).join('\n\n');
  document.getElementById(id)!.textContent = source.replace(/new (\w+);/g, 'new $1();');
}

wireButton('connect', onConnectButtonClick);
wireButton('disconnect', onDisconnectButtonClick, { needsDevice: true });
wireButton('heart-rate', onHeartRateButtonClick, { needsDevice: true });
wireButton('heart-rate-stop', onHeartRateStopButtonClick);
wireButton('ecg', onEcgButtonClick, { needsDevice: true });
wireButton('ecg-stop', onEcgStopButtonClick);
wireButton('acc', onAccButtonClick, { needsDevice: true });
wireButton('acc-stop', onAccStopButtonClick);

showSnippet('connect-snippet', [onConnectButtonClick, onDisconnectButtonClick]);
showSnippet('heart-rate-snippet', [onHeartRateButtonClick, onHeartRateStopButtonClick]);
showSnippet('ecg-snippet', [onEcgButtonClick, onEcgStopButtonClick]);
showSnippet('acc-snippet', [onAccButtonClick, onAccStopButtonClick]);

if (!polar.isWebBluetoothAvailable()) {
  log('Web Bluetooth API is not available. Use Chrome or Edge on desktop or Android, over HTTPS or localhost.');
}

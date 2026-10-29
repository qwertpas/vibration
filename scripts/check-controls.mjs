import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Run the actual page and serial transport against a simulated USB board.
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      value: '0', checked: false, hidden: false, textContent: '',
      classList: { toggle() {} }, setAttribute() {}, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
    });
  }
  return elements.get(id);
}
const document = {
  ...element('document'), getElementById: element, body: element('body'),
  hasFocus: () => true, querySelector: () => null,
};
const window = { ...element('window'), isSecureContext: true };
const packets = [];
const commands = [];
let board, closed = false, ignore = false;
const bleListeners = {};
let holdReplies = false, heldReplies = [], blockWrite = false, blockedWrite;
let updateBytes = 0, expectedSize = 0, updateComplete = false, corrupt = false, cancel = false;
const firmware = new Uint8Array([0xe9, 1, 2, 3, ...new Array(1024).fill(4)]);
const sha256 = Buffer.from(await webcrypto.subtle.digest('SHA-256', firmware)).toString('hex');
const bleReply = {
  addEventListener(type, fn) { bleListeners[type] = fn; },
  removeEventListener(type) { delete bleListeners[type]; },
  async startNotifications() {},
};
const bleCommand = {
  async writeValueWithResponse(bytes) {
    if (blockWrite) await new Promise((resolve, reject) => { blockedWrite = { resolve, reject }; });
    const [command, id, ...args] = new TextDecoder().decode(bytes).trim().split(' ');
    commands.push(command);
    let motors = [0, 0];
    if (command === 'SET') { motors = args.map(Number); packets.push(motors); }
    if (command === 'BEGIN') { expectedSize = Number(args[0]); updateBytes = 0; }
    if (command === 'FINISH') { assert.equal(updateBytes, expectedSize); updateComplete = true; }
    const response = new TextEncoder().encode(`${JSON.stringify({app: 'vibration', id: Number(id), motors, error: ''})}\n`);
    const deliver = () => {
      for (let offset = 0; offset < response.length; offset += 20) {
        const chunk = response.slice(offset, offset + 20);
        bleListeners.characteristicvaluechanged({ target: { value: new DataView(chunk.buffer) } });
      }
    };
    if (holdReplies) heldReplies.push(deliver);
    else deliver();
  },
};
const bleUpdate = {
  async writeValueWithResponse(bytes) {
    updateBytes += bytes.length;
    if (cancel) element('update-ble').listeners.click();
  },
};
const device = {
  addEventListener(type, fn) { bleListeners[type] = fn; },
  removeEventListener(type) { delete bleListeners[type]; },
  gatt: {
    connected: false,
    async connect() { this.connected = true; return this; },
    disconnect() { this.connected = false; },
    async getPrimaryService() { return { async getCharacteristic(id) {
      return id.startsWith('6e400002') ? bleCommand : id.startsWith('6e400003') ? bleReply : bleUpdate;
    } }; },
  },
};
const port = {
  async open() {
    this.readable = new ReadableStream({ start(controller) { board = controller; } });
    this.writable = new WritableStream({ write(bytes) {
      const [command, id, ...values] = new TextDecoder().decode(bytes).trim().split(' ');
      const motors = command === 'STOP' ? [0, 0] : values.map(Number);
      packets.push(motors);
      if (!ignore) board.enqueue(new TextEncoder().encode(`${JSON.stringify({
        app: 'vibration', id: Number(id), motors, error: '',
      })}\n`));
    } });
  },
  async close() { closed = true; this.readable = this.writable = null; },
};
const context = vm.createContext({
  document, window, navigator: {
    serial: { requestPort: async () => port },
    bluetooth: { requestDevice: async () => device },
  },
  TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
  MutationObserver: class { observe() {} },
  crypto: webcrypto,
  fetch: async (url) => ({ ok: true,
    json: async () => ({ md5: '0123456789abcdef0123456789abcdef', sha256: corrupt ? 'bad' : sha256 }),
    arrayBuffer: async () => firmware.buffer,
  }),
});
vm.runInContext(await readFile(new URL('../docs/app.js', import.meta.url), 'utf8'), context);
const last = () => packets.at(-1);
async function event(target, type, fields = {}) {
  await target.listeners[type]({ preventDefault() {}, ...fields });
  await delay(5);
}
async function slide(n, value) {
  element(`motor-${n}`).value = String(value);
  await event(element(`motor-${n}`), 'input');
}
const key = (type, value, fields) => event(document, type, { key: value, ...fields });

try {
  assert.equal(element('keyboard').checked, false);
  await event(element('connect'), 'click');
  assert.deepEqual(last(), [0, 0]);
  await slide(1, -43);
  await slide(2, 67);
  assert.deepEqual(last(), [-43, 67]);
  element('keyboard').checked = true;
  await event(element('keyboard'), 'change');
  assert.deepEqual(last(), [0, 0]);
  await slide(1, -31);
  await slide(2, 52);
  assert.deepEqual(last(), [0, 0], 'Keyboard sliders must not start motors');
  await key('keydown', 'ArrowRight');
  assert.deepEqual(last(), [31, 0]);
  await key('keydown', 'ArrowUp');
  assert.deepEqual(last(), [31, 52]);
  await key('keydown', 'ArrowLeft');
  assert.deepEqual(last(), [0, 52], 'Opposing keys must cancel');
  await key('keyup', 'ArrowRight');
  assert.deepEqual(last(), [-31, 52]);
  await key('keyup', 'ArrowUp');
  await key('keydown', 'ArrowDown');
  assert.deepEqual(last(), [-31, -52]);
  await slide(1, 22);
  assert.deepEqual(last(), [-22, -52]);
  await event(window, 'blur');
  assert.deepEqual(last(), [0, 0]);
  await key('keydown', 'ArrowLeft', { repeat: true });
  assert.deepEqual(last(), [0, 0], 'Repeated keydown must not restart after blur');
  await key('keydown', 'ArrowRight');
  document.hidden = true;
  await event(document, 'visibilitychange');
  assert.deepEqual(last(), [0, 0]);
  document.hidden = false;
  await key('keydown', 'ArrowDown');
  await key('keydown', 'Escape');
  assert.deepEqual(last(), [0, 0]);
  assert.equal(Number(element('motor-1').value), 0);
  assert.equal(Number(element('motor-2').value), 0);
  await slide(1, 45);
  element('keyboard').checked = false;
  await event(element('keyboard'), 'change');
  assert.deepEqual(last(), [0, 0], 'Leaving keyboard mode must stop');
  await slide(1, 19);
  await event(window, 'blur');
  assert.deepEqual(last(), [0, 0]);
  assert.equal(Number(element('motor-1').value), 0);
  await event(element('connect'), 'click');
  assert.equal(closed, true);
  closed = false;
  await event(element('connect'), 'click');
  assert.deepEqual(last(), [0, 0], 'Reconnect must start stopped');
  ignore = true;
  await slide(1, 20);
  await delay(1400);
  assert.equal(closed, true, 'Missing USB acknowledgement must close the port');
  ignore = false;
  await event(element('connect-ble'), 'click');
  assert.equal(device.gatt.connected, true);
  await slide(1, -27);
  await slide(2, 32);
  assert.deepEqual(last(), [-27, 32], 'BLE must drive both motors');
  element('keyboard').checked = true;
  await event(element('keyboard'), 'change');
  await key('keydown', 'ArrowLeft');
  await key('keydown', 'ArrowUp');
  assert.deepEqual(last(), [-27, 32]);
  await key('keyup', 'ArrowLeft');
  assert.deepEqual(last(), [0, 32]);
  await key('keyup', 'ArrowUp');
  assert.deepEqual(last(), [0, 0]);
  holdReplies = true;
  await key('keydown', 'ArrowRight');
  await key('keyup', 'ArrowRight');
  assert.deepEqual(last(), [0, 0], 'Key release must not wait for an earlier status reply');
  holdReplies = false;
  heldReplies.forEach((deliver) => deliver());
  heldReplies = [];
  assert.equal(element('state-1').textContent, 'Stopped', 'Old acknowledgements must not restore stale UI state');
  blockWrite = true;
  await key('keydown', 'ArrowUp');
  await key('keyup', 'ArrowUp');
  await delay(650);
  assert.equal(device.gatt.connected, false, 'A stalled GATT write must disconnect without waiting for its promise');
  blockWrite = false;
  await event(element('connect-ble'), 'click');
  blockedWrite.reject(new Error('Old connection closed'));
  await delay(5);
  assert.equal(device.gatt.connected, true, 'A failed write from an old connection must not disconnect a new one');
  corrupt = true;
  await event(element('update-ble'), 'click');
  assert.equal(commands.includes('BEGIN'), false, 'Reject a corrupt firmware download before flashing');
  corrupt = false;
  cancel = true;
  await event(element('update-ble'), 'click');
  assert.equal(commands.at(-1), 'ABORT');
  assert.equal(updateComplete, false);
  cancel = false;
  await event(element('update-ble'), 'click');
  assert.equal(updateComplete, true);
  assert.equal(device.gatt.connected, false);
  assert.equal(element('update-state').textContent, 'Updated · Reconnect BLE');
  await event(element('connect-ble'), 'click');
  bleListeners.gattserverdisconnected();
  await delay(5);
  assert.equal(device.gatt.connected, false);
  console.log('PASS: USB/BLE sliders and keys, simultaneous/opposing keys, release, mode changes, focus loss, Escape, reconnect, USB/BLE loss, OTA checksum, cancellation, and transfer');
} finally {
  await vm.runInContext('disconnect()', context);
}

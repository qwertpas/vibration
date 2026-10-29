const $ = (id) => document.getElementById(id);
const sliders = [1, 2].map((n) => $(`motor-${n}`));
const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'up' };
const held = new Set();
const supported = 'serial' in navigator && window.isSecureContext;
const bleSupported = 'bluetooth' in navigator && window.isSecureContext;
const serviceId = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const commandId = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const replyId = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const updateId = '6e400004-b5a3-f393-e0a9-e50e24dcca9e';
let port, reader, writer, reading, waiting, heartbeat;
let device, bleCommand, bleReply, bleUpdate;
let transport = 'usb', bleBuffer = '', updating = false, cancelUpdate = false;
let connected = false, opening = false, closing = false, sending = false;
let pending = null, sequence = 0;
let connection = 0, lastControl = 0, lastAck = 0, lastReplyAt = 0;

function message(text = '') {
  $('message').textContent = text;
  $('message').hidden = !text;
}

function render() {
  const installing = !!document.querySelector('ewt-install-dialog');
  for (const [id, kind, available] of [['connect', 'usb', supported], ['connect-ble', 'ble', bleSupported]]) {
    $(id).textContent = transport === kind && opening ? 'Connecting…' : connected && transport === kind ? 'Disconnect' : `Connect ${kind.toUpperCase()}`;
    $(id).disabled = !available || opening || closing || updating || installing || (connected && transport !== kind);
  }
  $('install').disabled = connected || opening || closing || updating;
  $('update-ble').disabled = !connected || transport !== 'ble' || closing;
  $('update-ble').textContent = updating ? 'Cancel update' : 'Update via BLE';
  $('connection').textContent = connected ? `Connected · ${transport.toUpperCase()}` : opening ? 'Connecting…' : 'Disconnected';
  $('dot').classList.toggle('connected', connected);
  document.body.classList.toggle('keyboard-on', $('keyboard').checked);
  $('hint').textContent = $('keyboard').checked ? 'Hold arrows to run' : 'Sliders drive motors directly';
  $('key-note').hidden = !$('keyboard').checked;
  for (const [key, id] of Object.entries(arrows)) $(id).classList.toggle('pressed', held.has(key));
  sliders.forEach((slider, i) => {
    slider.disabled = updating;
    const value = Number(slider.value);
    $(`value-${i + 1}`).value = value > 0 ? `+${value}` : value;
    slider.setAttribute('aria-valuetext', `${value}%`);
  });
}

function showMotors(values) {
  values.forEach((value, i) => {
    const state = $(`state-${i + 1}`);
    state.textContent = value ? `${value > 0 ? 'Forward' : 'Reverse'} · ${Math.abs(value)}%` : 'Stopped';
    state.classList.toggle('active', value !== 0);
  });
}

function speeds() {
  const values = sliders.map((slider) => Number(slider.value));
  if (!$('keyboard').checked) return values;
  return [
    Math.abs(values[0]) * (Number(held.has('ArrowRight')) - Number(held.has('ArrowLeft'))),
    Math.abs(values[1]) * (Number(held.has('ArrowUp')) - Number(held.has('ArrowDown'))),
  ];
}

function receive(line) {
  let data;
  try { data = JSON.parse(line); } catch { return; }
  if (data.app !== 'vibration') return;
  if (!waiting || data.id !== waiting.id) {
    if (!connected || updating || data.id <= lastAck || data.id > lastControl) return;
    lastAck = data.id;
    lastReplyAt = Date.now();
    if (data.error) { message(data.error); void disconnect(false); }
    else if (data.id === lastControl) showMotors(data.motors);
    return;
  }
  const { resolve, reject, timer } = waiting;
  waiting = null;
  clearTimeout(timer);
  if (data.error) reject(new Error(data.error));
  else {
    showMotors(data.motors);
    resolve(data);
  }
}

async function read() {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        receive(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 4096) throw new Error('Invalid board response.');
    }
  } catch (error) {
    if (!closing) message(`USB: ${error.message}`);
  } finally {
    reader.releaseLock();
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('USB connection ended.'));
      waiting = null;
    }
    // Defer cleanup until this read task has returned.
    if (!closing) setTimeout(() => void disconnect(false), 0);
  }
}

async function request(values) {
  const id = ++sequence;
  let command = values ? `SET ${id} ${values[0]} ${values[1]}` : `STOP ${id}`;
  if (typeof values === 'string') {
    const [verb, ...args] = values.split(' ');
    command = `${verb} ${id} ${args.join(' ')}`.trim();
  }
  const response = new Promise((resolve, reject) => {
    waiting = { id, resolve, reject, timer: setTimeout(() => {
      waiting = null;
      reject(new Error('Board did not respond. Install Motor Control firmware, then reconnect.'));
    }, updating ? 10000 : 1200) };
  });
  // Attach a rejection handler before awaiting the USB write.
  const write = writeBytes(new TextEncoder().encode(`${command}\n`));
  try {
    const [, data] = await Promise.all([write, response]);
    return data;
  } catch (error) {
    if (waiting?.id === id) {
      clearTimeout(waiting.timer);
      waiting = null;
    }
    throw error;
  }
}

async function send(values = speeds()) {
  if (!connected || closing || updating) return;
  pending = values;
  if (sending) return;
  sending = true;
  const current = connection;
  try {
    while (pending && connected && !closing && current === connection) {
      const next = pending;
      pending = null;
      if (lastAck === lastControl) lastReplyAt = Date.now();
      lastControl = ++sequence;
      // Keep one GATT write in flight and only the latest desired value pending.
      // Status notifications must not block a newer slider value or key release.
      await writeBytes(new TextEncoder().encode(`SET ${lastControl} ${next[0]} ${next[1]}\n`));
    }
  } catch (error) {
    if (current === connection) { message(error.message); await disconnect(false); }
  } finally { if (current === connection) sending = false; }
}

function stop(reset = true) {
  held.clear();
  if (reset) sliders.forEach((slider) => { slider.value = 0; });
  render();
  void send([0, 0]);
}

function writeBytes(bytes) {
  return transport === 'ble' ? bleCommand.writeValueWithResponse(bytes) : writer.write(bytes);
}

function receiveBLE(event) {
  bleBuffer += new TextDecoder().decode(event.target.value);
  let end;
  while ((end = bleBuffer.indexOf('\n')) >= 0) {
    receive(bleBuffer.slice(0, end));
    bleBuffer = bleBuffer.slice(end + 1);
  }
  if (bleBuffer.length > 4096) { message('Invalid BLE response.'); void disconnect(false); }
}

function bleDisconnected() {
  message(updating ? 'BLE disconnected during update. Reconnect to check firmware.' : 'BLE disconnected.');
  void disconnect(false);
}

function startHeartbeat() {
  lastControl = lastAck = 0;
  lastReplyAt = Date.now();
  heartbeat = setInterval(() => {
    if (lastAck < lastControl && Date.now() - lastReplyAt >= 500) {
      message(`${transport.toUpperCase()} stopped responding.`);
      void disconnect(false);
      return;
    }
    if (!sending && !document.hidden && document.hasFocus()) void send();
  }, 100);
}

async function connect(kind = 'usb') {
  transport = kind;
  opening = true;
  stop();
  render();
  message();
  try {
    if (kind === 'ble') {
      device = await navigator.bluetooth.requestDevice({ filters: [{ name: 'Vibration' }], optionalServices: [serviceId] });
      device.addEventListener('gattserverdisconnected', bleDisconnected);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(serviceId);
      bleCommand = await service.getCharacteristic(commandId);
      bleReply = await service.getCharacteristic(replyId);
      bleUpdate = await service.getCharacteristic(updateId);
      bleBuffer = '';
      bleReply.addEventListener('characteristicvaluechanged', receiveBLE);
      await bleReply.startNotifications();
    } else {
      port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
      await port.open({ baudRate: 115200 });
      writer = port.writable.getWriter();
      reader = port.readable.getReader();
      reading = read();
    }
    await request(null);
    connected = true;
    // SET packets are also the lease; never queue heartbeat packets behind writes.
    startHeartbeat();
  } catch (error) {
    if (error.name !== 'NotFoundError') message(error.message);
    await disconnect(false);
  } finally { opening = false; render(); }
}

async function disconnect(finalStop = true) {
  if (closing) return;
  closing = true;
  connection++;
  clearInterval(heartbeat);
  connected = false;
  sending = false;
  pending = null;
  held.clear();
  sliders.forEach((slider) => { slider.value = 0; });
  render();
  if ((writer || bleCommand) && finalStop) {
    try { await writeBytes(new TextEncoder().encode(`STOP ${++sequence}\n`)); }
    catch { /* The firmware lease also expires on USB loss. */ }
  }
  if (device) {
    device.removeEventListener('gattserverdisconnected', bleDisconnected);
    bleReply?.removeEventListener('characteristicvaluechanged', receiveBLE);
    device.gatt.disconnect();
  }
  if (waiting) {
    clearTimeout(waiting.timer);
    waiting.reject(new Error('Connection closed.'));
    waiting = null;
  }
  if (reader) {
    try { await reader.cancel(); await reading; } catch { /* USB already lost. */ }
  }
  if (writer) writer.releaseLock();
  if (port?.readable || port?.writable) {
    try { await port.close(); } catch (error) { message(error.message); }
  }
  port = reader = writer = reading = null;
  device = bleCommand = bleReply = bleUpdate = null;
  showMotors([0, 0]);
  closing = false;
  render();
}

$('connect').addEventListener('click', () => connected ? disconnect() : connect());
$('connect-ble').addEventListener('click', () => connected ? disconnect() : connect('ble'));
$('update-ble').addEventListener('click', async () => {
  if (updating) { cancelUpdate = true; return; }
  stop();
  while (sending) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!connected) return;
  updating = true;
  cancelUpdate = false;
  clearInterval(heartbeat);
  render();
  message();
  $('progress').hidden = false;
  $('progress').value = 0;
  $('update-state').textContent = 'Loading firmware…';
  try {
    const manifestResponse = await fetch('firmware/manifest.json', { cache: 'no-store' });
    if (!manifestResponse.ok) throw new Error('Cannot load firmware manifest.');
    const manifest = await manifestResponse.json();
    const response = await fetch(`firmware/app.bin?${manifest.sha256}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Cannot load firmware.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
    if (hash !== manifest.sha256) throw new Error('Firmware checksum mismatch.');
    await request(`BEGIN ${bytes.length} ${manifest.md5}`);
    for (let offset = 0; offset < bytes.length; offset += 512) {
      if (cancelUpdate) throw new Error('Update cancelled.');
      await bleUpdate.writeValueWithResponse(bytes.subarray(offset, offset + 512));
      const progress = Math.round(Math.min(offset + 512, bytes.length) * 100 / bytes.length);
      $('progress').value = progress;
      $('update-state').textContent = `Updating · ${progress}%`;
    }
    $('update-state').textContent = 'Verifying…';
    await request('FINISH');
    $('update-state').textContent = 'Updated · Reconnect BLE';
    await disconnect(false);
  } catch (error) {
    $('update-state').textContent = error.message;
    if (device?.gatt.connected) {
      try { await request('ABORT'); } catch { await disconnect(false); }
    }
  } finally {
    updating = false;
    $('progress').hidden = true;
    if (connected) startHeartbeat();
    render();
  }
});
$('stop').addEventListener('click', () => stop());
$('keyboard').addEventListener('change', () => stop($('keyboard').checked ? false : true));
sliders.forEach((slider, i) => {
  slider.addEventListener('input', () => { render(); void send(); });
  $(`zero-${i + 1}`).addEventListener('click', () => { slider.value = 0; render(); void send(); });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); stop(); return; }
  if (!$('keyboard').checked || !(event.key in arrows) || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  if (event.repeat || !connected) return;
  held.add(event.key);
  render();
  void send();
});
document.addEventListener('keyup', (event) => {
  if (!held.delete(event.key)) return;
  event.preventDefault();
  render();
  void send();
});
window.addEventListener('blur', () => stop(!$('keyboard').checked));
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(!$('keyboard').checked); });
window.addEventListener('pagehide', () => {
  stop();
  if (writer || bleCommand) void writeBytes(new TextEncoder().encode(`STOP ${++sequence}\n`)).catch(() => {});
});
// The installer holds its USB port until its dialog closes.
new MutationObserver(render).observe(document.body, { childList: true });
render();
if (!supported && !bleSupported) message('USB and BLE control are unavailable in this browser.');

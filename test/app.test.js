// -----------------------------------------------------------------------------
// ArcamApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake Arcam device on the loopback
// interface. The background round and the heartbeat never fire: the tests
// drive them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ArcamApp, isLanAddress, parseVolumeCommand } from '../src/app.js';
import { CC, encodeAnswer, ANSWER } from '../src/arcam/protocol.js';
import { DeviceLink } from '../src/arcam/link.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { startFakeDevice } from './fixtures/fakeArcam.js';

const SELECTOR = 'arcam';

/** No background round, no heartbeat; real (short) timeouts. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const FAST = {
  ...TIMINGS,
  connectTimeout: 500,
  requestTimeout: 300,
  identifyTimeout: 200,
  reconnectBase: 40,
  reconnectMax: 200,
  stableAfter: 10_000,
  publishDelay: 5,
  persistDelay: 5,
  wakeRead: 20,
  wakeCheckDelay: 30,
  scanSeconds: 1,
};

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t, { deviceOptions, config, scanResults = {}, timings = {}, ...rest } = {}) {
  const device = await startFakeDevice(deviceOptions);
  t.after(() => device.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${device.port}` },
    scanResults,
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const store = new MemoryStore();
  const app = new ArcamApp({
    gladys,
    logger,
    store,
    timers,
    timings: { ...FAST, ...timings },
    ...rest,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  const id = (key) => `ext:${SELECTOR}:arcam:127.0.0.1_${device.port}${key ? `:${key}` : ''}`;
  return { device, gladys, app, logs, store, id };
}

async function discovered(gladys, id) {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id()),
    'the device in the Discovery tab',
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id());
}

async function createDevice(gladys, id) {
  const device = await discovered(gladys, id);
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id('power')) !== undefined, 'the power state');
  return device;
}

const set = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id.endsWith(`:${key}`)),
    value,
  );

const writes = (fake, cc) =>
  fake.commands.filter((c) => c.cc === cc && !(c.data.length === 1 && c.data[0] === 0xf0));

test('a typed address becomes a Gladys device; its states once created', async (t) => {
  const { gladys, id } = await setup(t);
  const device = await discovered(gladys, id);
  assert.match(device.name, /^Arcam AVR20 \(127\.0\.0\.1:\d+\)$/);
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '127.0.0.1' }]);
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'power_on',
    'standby',
    'volume',
    'mute',
    'source',
    'audio_mode',
  ]);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch, nothing an "everything on / off" could command; the power is read only.
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  assert.deepEqual([byKey.power.category, byKey.power.read_only], ['unknown', true]);
  assert.deepEqual([byKey.power_on.category, byKey.power_on.type], ['button', 'push']);
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual(
    [byKey.volume.category, byKey.volume.type, byKey.volume.min, byKey.volume.max],
    ['music', 'volume', 0, 99],
  );
  assert.equal(byKey.volume.unit, undefined, 'no unit for the music category');
  assert.deepEqual([byKey.mute.category, byKey.mute.type], ['television', 'volume-mute']);
  assert.ok(
    byKey.source.supported_options.some((o) => o.value === 'UHD'),
    'the HDA sources',
  );
  assert.ok(byKey.audio_mode.supported_options.some((o) => o.value === '2CH_STEREO'));
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');

  await createDevice(gladys, id);
  await waitFor(() => gladys.fake.lastState(id('audio_mode')) !== undefined, 'the audio mode');
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('volume')), 30);
  assert.equal(gladys.fake.lastState(id('mute')), 0);
  assert.equal(gladys.fake.lastState(id('source')), 'BD');
  assert.equal(gladys.fake.lastState(id('audio_mode')), '2CH_STEREO');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.connectionStatus.message, undefined);
});

test('changes made on the device are pushed to Gladys', async (t) => {
  const { gladys, device: fake, id } = await setup(t);
  await createDevice(gladys, id);
  fake.change(CC.VOLUME, 'volume', 55);
  await waitFor(() => gladys.fake.lastState(id('volume')) === 55, 'the new volume');
  fake.change(CC.MUTE, 'mute', 0x00);
  await waitFor(() => gladys.fake.lastState(id('mute')) === 1, 'the mute');
  fake.change(CC.CURRENT_SOURCE, 'source', 'NET');
  await waitFor(() => gladys.fake.lastState(id('source')) === 'NET', 'the source');
  // A multi-channel signal: the multi-channel decode mode is the one shown.
  fake.change(CC.INCOMING_AUDIO_FORMAT, 'format', 0x16);
  await waitFor(
    () => gladys.fake.lastState(id('audio_mode')) === 'MCH_MULTI_CHANNEL',
    'the multi-channel mode',
  );
  fake.change(CC.POWER, 'power', 0);
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'the standby');
});

test('volume: set, capped by the configuration, validated before anything is sent', async (t) => {
  const { gladys, device: fake, app, id } = await setup(t);
  const device = await createDevice(gladys, id);
  assert.equal((await set(gladys, device, 'volume', 25)).success, true);
  assert.equal(fake.state.volume, 25);
  await waitFor(() => gladys.fake.lastState(id('volume')) === 25, 'the volume answered');
  // Default cap: 40.
  assert.equal((await set(gladys, device, 'volume', 90)).success, true);
  assert.equal(fake.state.volume, 40);
  // A lower cap saved in the configuration applies to the next command.
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, max_volume: 20 });
  assert.equal(app.config.maxVolume, 20);
  assert.equal((await set(gladys, device, 'volume', '35')).success, true);
  assert.equal(fake.state.volume, 20);
  assert.equal((await set(gladys, device, 'volume', 10)).success, true);
  assert.equal(fake.state.volume, 10);
  const before = fake.commands.length;
  for (const bad of [null, '', ' ', -1, 100, 12.5, '12abc', true, NaN, Infinity, '1e2', {}]) {
    assert.equal((await set(gladys, device, 'volume', bad)).success, false, String(bad));
  }
  assert.equal(fake.commands.length, before, 'no invalid volume reached the device');
  assert.ok(
    writes(fake, CC.VOLUME).every((c) => c.data[0] <= 40),
    'never above the cap',
  );
});

test('parseVolumeCommand accepts integers 0..99 only', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand(99), 99);
  assert.equal(parseVolumeCommand(' 7 '), 7);
  for (const bad of [null, undefined, '', -1, 100, 1.5, '1.5', '0x10', true, [], {}]) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
});

test('mute: each press reads the mute and sets the opposite, explicitly', async (t) => {
  const { gladys, device: fake, id } = await setup(t);
  const device = await createDevice(gladys, id);
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.equal(fake.state.mute, 0x00, 'muted');
  assert.deepEqual(writes(fake, CC.SIMULATE_RC5).at(-1).data, [16, 26], 'the explicit mute code');
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.equal(fake.state.mute, 0x01, 'unmuted');
  assert.deepEqual(writes(fake, CC.SIMULATE_RC5).at(-1).data, [16, 120]);
});

test('unmuting lowers a volume above the cap first', async (t) => {
  const {
    gladys,
    device: fake,
    id,
  } = await setup(t, {
    deviceOptions: { state: { mute: 0x00, volume: 70 } },
  });
  const device = await createDevice(gladys, id);
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.equal(fake.state.volume, 40);
  assert.equal(fake.state.mute, 0x01);
  const volumeAt = fake.commands.indexOf(writes(fake, CC.VOLUME).at(-1));
  const unmuteAt = fake.commands.indexOf(writes(fake, CC.SIMULATE_RC5).at(-1));
  assert.ok(volumeAt < unmuteAt, 'the volume before the unmute');
});

test('power on and standby are buttons; power on brings the volume back to the cap', async (t) => {
  const {
    gladys,
    device: fake,
    id,
  } = await setup(t, {
    deviceOptions: { state: { power: 0, volume: 80 } },
  });
  const device = await createDevice(gladys, id);
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  assert.equal(fake.state.power, 1);
  await waitFor(() => fake.state.volume === 40, 'the volume back to the cap');
  await waitFor(() => gladys.fake.lastState(id('power')) === 1, 'power 1');
  assert.equal((await set(gladys, device, 'standby')).success, true);
  assert.equal(fake.state.power, 0);
  assert.deepEqual(writes(fake, CC.SIMULATE_RC5).at(-1).data, [16, 124]);
});

test('source and audio mode: among the options, the audio mode checked against the signal', async (t) => {
  const { gladys, device: fake, id } = await setup(t);
  const device = await createDevice(gladys, id);
  assert.equal((await set(gladys, device, 'source', 'UHD')).success, true);
  assert.equal(fake.state.source, 'UHD');
  await waitFor(() => gladys.fake.lastState(id('source')) === 'UHD', 'the source pushed');
  const before = fake.commands.length;
  for (const bad of ['PHONO', '__proto__', '', 3, null]) {
    assert.equal((await set(gladys, device, 'source', bad)).success, false, String(bad));
  }
  assert.equal(fake.commands.length, before, 'nothing sent for an unknown source');
  assert.equal((await set(gladys, device, 'audio_mode', '2CH_DTS_NEURAL_X')).success, true);
  assert.equal(fake.state.mode2ch, 0x0a);
  // A multi-channel mode on a stereo signal: refused after the read, nothing sent.
  const sent = writes(fake, CC.SIMULATE_RC5).length;
  const ack = await set(gladys, device, 'audio_mode', 'MCH_MULTI_CHANNEL');
  assert.equal(ack.success, false);
  assert.equal(writes(fake, CC.SIMULATE_RC5).length, sent);
});

test('an SA amplifier: direct writes of the power, the mute and the source', async (t) => {
  const {
    gladys,
    device: fake,
    id,
  } = await setup(t, {
    deviceOptions: { model: 'SA30', state: { source: 'CD' } },
  });
  const device = await createDevice(gladys, id);
  await waitFor(() => gladys.fake.lastState(id('source')) === 'CD', 'the source');
  assert.equal(
    device.features.find((f) => f.external_id.endsWith(':audio_mode')).supported_options.length,
    0,
    'no audio mode on an amplifier',
  );
  assert.equal((await set(gladys, device, 'source', 'PHONO')).success, true);
  assert.equal(fake.state.source, 'PHONO');
  assert.deepEqual(writes(fake, CC.CURRENT_SOURCE).at(-1).data, [0x01]);
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.deepEqual(writes(fake, CC.MUTE).at(-1).data, [0x00], 'the direct mute');
  assert.equal((await set(gladys, device, 'standby')).success, true);
  assert.deepEqual(writes(fake, CC.POWER).at(-1).data, [0x00], 'the direct standby');
  assert.equal(fake.state.power, 0);
  assert.equal(writes(fake, CC.SIMULATE_RC5).length, 0, 'no RC5 code');
});

test('a power amplifier has no volume: refused, nothing sent', async (t) => {
  const { gladys, device: fake, id } = await setup(t, { deviceOptions: { model: 'PA720' } });
  const device = await createDevice(gladys, id);
  assert.equal((await set(gladys, device, 'volume', 10)).success, false);
  assert.equal(writes(fake, CC.VOLUME).length, 0);
});

test('a command to a device in standby is refused by the device, said so', async (t) => {
  const { gladys, device: fake, id, logs } = await setup(t);
  const device = await createDevice(gladys, id);
  fake.change(CC.POWER, 'power', 0);
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'the standby');
  assert.equal((await set(gladys, device, 'volume', 10)).success, false);
  assert.ok(logs.some((l) => /Refused by the device: command invalid at this time/.test(l)));
});

test('a silent device: "sent, without confirmation", within the budget', async (t) => {
  const {
    gladys,
    device: fake,
    id,
    logs,
  } = await setup(t, {
    timings: { commandBudget: 400 },
  });
  const device = await createDevice(gladys, id);
  fake.silent = true;
  const started = Date.now();
  const ack = await set(gladys, device, 'volume', 10);
  assert.equal(ack.success, false);
  assert.ok(Date.now() - started < 1_500, 'answered within the budget');
  assert.ok(logs.some((l) => /Sent, without confirmation/.test(l)));
});

test('a device that does not answer: power 0, named in the status, nothing sent', async (t) => {
  const { gladys, device: fake, app, id } = await setup(t);
  const device = await createDevice(gladys, id);
  await fake.close();
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'power 0');
  await app.updateStatus();
  assert.match(gladys.fake.connectionStatus.message.en, /Not connected/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const ack = await set(gladys, device, 'standby');
  assert.equal(ack.success, false, 'standby on a device not connected is not "done"');
});

test('the reconnection is spaced out; the count resets after a stable connection', () => {
  let now = 0;
  const link = new DeviceLink({
    address: { host: '127.0.0.1', port: 1 },
    timings: TIMINGS,
    now: () => now,
  });
  const delays = Array.from({ length: 7 }, () => link.backoff());
  assert.deepEqual(delays, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  link.connectedAt = 0;
  now = 5_000;
  assert.equal(link.backoff(), 300_000);
  link.connectedAt = 0;
  now = 60_000;
  assert.equal(link.backoff(), 10_000);
});

test('a reconnection to Gladys keeps the link, republishes the status and the devices', async (t) => {
  const { gladys, device: fake, app, id } = await setup(t);
  await createDevice(gladys, id);
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await app.start(gladys.fake.config, { connected: true });
  assert.equal(fake.connections(), 1, 'the connection is not reopened');
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.ok(gladys.fake.bodies('POST', '/discovered_device').length > discoveries);
});

test('a typed address that does not answer is named in the status', async (t) => {
  const { gladys } = await setup(t, { config: { addresses: '127.0.0.1:1, nope!' } });
  await waitFor(
    () => /127\.0\.0\.1:1/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    'the silent address',
  );
  assert.match(gladys.fake.connectionStatus.message.en, /nope!/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('something that is not an Arcam device never becomes one', async (t) => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', () => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { gladys, app } = await setup(t, {
    config: { addresses: `127.0.0.1:${server.address().port}` },
  });
  await waitFor(() => [...app.links.values()][0]?.lastError, 'the failed attempt');
  assert.match([...app.links.values()][0].lastError.message, /Not an Arcam device/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('hostile bytes are ignored; a flood closes the connection, spaced out', async (t) => {
  const {
    gladys,
    device: fake,
    app,
    id,
  } = await setup(t, {
    timings: { floodFrames: 20, floodWindow: 10_000 },
  });
  await createDevice(gladys, id);
  fake.broadcast(Buffer.from('garbage \x00\x21\x01\x0d\x00\x01\x63\x07 AB'));
  fake.broadcast(encodeAnswer(2, CC.VOLUME, ANSWER.OK, [99]));
  fake.broadcast(encodeAnswer(1, CC.VOLUME, ANSWER.OK, [200]));
  await settle();
  assert.equal(gladys.fake.lastState(id('volume')), 30, 'zone 2 and junk ignored');
  assert.equal(Object.getPrototypeOf(app.data.devices), null);
  const link = [...app.links.values()][0];
  const failures = link.failures;
  for (let i = 0; i < 30; i += 1) {
    fake.change(CC.VOLUME, 'volume', i);
  }
  await waitFor(() => link.failures > failures, 'the flood closed the connection');
  await waitFor(() => link.connected, 'connected again');
  const before = link.failures;
  fake.broadcast(Buffer.alloc(5_000, 0x21));
  await waitFor(() => link.failures > before, 'too many bytes closed the connection');
});

test('"Find the devices": SSDP answers probed on port 50000, local addresses only', async (t) => {
  let fakePort;
  const asked = [];
  const {
    gladys,
    device: fake,
    app,
  } = await setup(t, {
    config: { addresses: '' },
    scanResults: {
      ssdp: [
        { source_ip: '192.168.1.40', source_port: 1900, headers: 'HTTP/1.1 200 OK' },
        { source_ip: '8.8.8.8', source_port: 1900, headers: '' },
        { source_ip: '169.254.169.254', source_port: 1900, headers: '' },
        { source_ip: 'nope', source_port: 1900, headers: '' },
      ],
    },
    // Every connection goes to the fake device on the loopback interface: the
    // tests never leave it, whatever address the SSDP answer gives.
    connect: (options) => {
      asked.push(`${options.host}:${options.port}`);
      return net.createConnection({ host: '127.0.0.1', port: fakePort });
    },
  });
  fakePort = fake.port;
  const ack = await gladys.fake.action('find_devices');
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /Found: Arcam AVR20 \(192\.168\.1\.40\)/);
  assert.match(ack.data.message.fr, /Trouvés/);
  assert.deepEqual([...new Set(asked)], ['192.168.1.40:50000']);
  assert.ok(app.data.devices['192.168.1.40_50000']);
  await waitFor(
    () =>
      gladys.fake.discoveredDevices.some(
        (d) => d.external_id === 'ext:arcam:arcam:192.168.1.40_50000',
      ),
    'the found device in the Discovery tab',
  );
});

test('"Check the devices" reports each device and the cap', async (t) => {
  const { gladys, id } = await setup(t);
  await createDevice(gladys, id);
  const ack = await gladys.fake.action('check_devices');
  assert.match(ack.data.message.en, /connected, on, volume 30/);
  assert.match(ack.data.message.en, /Volume cap: 40/);
  assert.match(ack.data.message.fr, /Plafond de volume : 40/);
});

test('the known devices are kept in /data; a model given once is kept', async (t) => {
  const { gladys, store, device: fake, id } = await setup(t);
  await createDevice(gladys, id);
  await waitFor(() => Object.keys(store.data.devices ?? {}).length === 1, 'the save');
  const saved = Object.values(store.data.devices)[0];
  assert.equal(saved.host, '127.0.0.1');
  assert.equal(saved.model, 'AVR20');
  assert.ok(saved.sourceOptions.length > 5);
  // A restart where the device does not answer the AMX request: the saved model is used.
  const gladys2 = createFakeGladys({
    selector: SELECTOR,
    config: { addresses: `127.0.0.1:${fake.port}` },
  });
  fake.amx = false;
  const app2 = new ArcamApp({
    gladys: gladys2,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    store,
    timers,
    timings: FAST,
  });
  registerHandlers(gladys2, app2);
  t.after(() => app2.stop());
  await gladys2.connect();
  await discovered(gladys2, id);
  const link = [...app2.links.values()][0];
  await waitFor(() => link.connected, 'connected');
  assert.equal(link.family, 'hda');
  assert.equal(gladys2.fake.discoveredDevices[0].name, `Arcam AVR20 (127.0.0.1:${fake.port})`);
});

test('isLanAddress: local IPv4 only', () => {
  for (const ok of ['10.1.2.3', '172.16.0.9', '192.168.1.40', '100.64.0.1', '169.254.1.1']) {
    assert.equal(isLanAddress(ok), true, ok);
  }
  for (const bad of [
    '8.8.8.8',
    '127.0.0.1',
    '0.0.0.0',
    '192.168.1.255',
    '224.0.0.1',
    '169.254.169.254',
    'fe80::1',
    'host',
    undefined,
  ]) {
    assert.equal(isLanAddress(bad), false, String(bad));
  }
});

// -----------------------------------------------------------------------------
// The integration: the Arcam devices it knows (typed addresses, optional SSDP
// search through Gladys), one persistent TCP connection per address
// (src/arcam/link.js: pushed updates, reconnection spaced out), the Gladys
// devices built from them, the commands (validated before anything is sent,
// the volume capped by the configuration, serialized per device, each within
// the 5 s Gladys waits for its ack) and the configuration buttons. index.js
// only wires the SDK handlers to it (src/handlers.js).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, platformId } from './config.js';
import { DEFAULT_PORT, FEATURES, LIMITS, TIMINGS, VOLUME } from './constants.js';
import { DeviceError, ERROR_KINDS } from './arcam/connection.js';
import { DeviceLink, identify as defaultIdentify } from './arcam/link.js';
import {
  CC,
  QUERY,
  REQUESTS,
  SOURCE_LABELS,
  audioModesOf,
  decodeFormat,
  decodeMute,
  decodePower,
  decodeVolume,
  familyOf,
  isTwoChannel,
  sourcesOf,
  supports,
} from './arcam/protocol.js';
import { T } from './i18n.js';
import {
  audioModeOptions,
  buildDevice,
  deviceName,
  featureKey,
  idsOf,
  sourceOptions,
  stateList,
} from './model.js';
import { FileStore, emptyData, isOptionValue } from './store.js';

const BUTTONS = new Set([FEATURES.POWER_ON, FEATURES.STANDBY, FEATURES.MUTE]);

/** Commands that go before the ones waiting: quieting down never waits behind the rest. */
const URGENT = new Set([FEATURES.STANDBY, FEATURES.MUTE]);

/**
 * Whether an address answered by SSDP may be connected to: an IPv4 address
 * of a local network (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 but
 * the cloud metadata address 169.254.169.254). Public, loopback, "this
 * network" (0/8), broadcast and multicast addresses are never asked. The
 * addresses typed by the user are not filtered: they are the user's choice.
 */
export function isLanAddress(host) {
  if (typeof host !== 'string' || isIP(host) !== 4) {
    return false;
  }
  const [a, b, c, d] = host.split('.').map(Number);
  if (host === '169.254.169.254' || d === 255 || (a === 255 && b === 255 && c === 255)) {
    return false;
  }
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * The volume of a command, validated strictly: an integer 0..99 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= VOLUME.min && volume <= VOLUME.max
    ? volume
    : undefined;
}

/** Runs `task` over `items`, `limit` at a time. */
async function mapLimit(items, limit, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const short = (value) => String(value).slice(0, 32);

/** Adds the options missing from `into` (by value); true when it grew. */
function mergeOptions(into, options) {
  let changed = false;
  for (const option of options) {
    if (!into.some((o) => o.value === option.value) && into.length < LIMITS.options) {
      into.push({ value: option.value, label: option.label });
      changed = true;
    }
  }
  return changed;
}

export class ArcamApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'arcam' }),
    store = new FileStore(),
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    connect,
    identify = defaultIdentify,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.connect = connect;
    this.identifyAt = identify;
    this.config = normalizeConfig();
    this.data = undefined;
    /** addressKey -> DeviceLink */
    this.links = new Map();
    /** device id -> command queue */
    this.queues = new Map();
    /** ids of the devices created in Gladys */
    this.created = new Set();
    /** The last `getDevices` failed: asked again at every round until it works. */
    this.createdStale = false;
    /** device id -> timer of the grouped publication of its states */
    this.publishTimers = new Map();
    /** device id -> { timer }: the one wake-up check chain of a device (after Power on) */
    this.wakeChecks = new Map();
    this.scanning = undefined;
    this.generation = 0;
    this.tickTimer = undefined;
    this.persistTimer = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. The links to the devices are kept (a
   * reconnection to Gladys never drops them); what this app remembered as
   * "already published" is forgotten, since the core forgot it too.
   */
  async start(raw = {}, { connected = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.timings.tick);
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/arcam.json moved to arcam.json.bad');
      }
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    // A configuration save asks the silent links again (never sooner than the
    // base interval); a reconnection to Gladys does not: Gladys flapping must
    // never make the devices asked faster.
    await this.step('open the links', () => this.syncLinks({ retry: !connected }));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the states', () => this.publishAllStates());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const link of this.links.values()) {
      link.stop();
    }
    this.links.clear();
    for (const handle of this.publishTimers.values()) {
      this.timers.clearTimeout(handle);
    }
    this.publishTimers.clear();
    for (const id of [...this.wakeChecks.keys()]) {
      this.cancelWakeCheck(id);
    }
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  /** The background round: the created devices if unread, the status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => (this.createdStale ? this.refreshCreated() : undefined))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /**
   * The command queue of one device: one command at a time. An `urgent`
   * command (standby, mute) goes before the commands still waiting (after
   * the other urgent ones), never before the one already running.
   */
  enqueue(id, task, { urgent = false } = {}) {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(id, queue);
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, urgent };
      if (urgent) {
        const index = queue.items.findIndex((i) => !i.urgent);
        queue.items.splice(index === -1 ? queue.items.length : index, 0, item);
      } else {
        queue.items.push(item);
      }
      this.drain(queue);
    });
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    queue.running = false;
  }

  // --- Known devices -----------------------------------------------------------

  get devices() {
    return Object.values(this.data?.devices ?? {});
  }

  deviceOf(gladysDevice) {
    return this.devices.find((d) => idsOf(this.gladys, d).device === gladysDevice?.external_id);
  }

  linkOf(device) {
    return this.links.get(addressKey(device));
  }

  /** The link of `device` when it is connected, else undefined. */
  connectedLink(device) {
    const link = this.linkOf(device);
    return link?.connected ? link : undefined;
  }

  /**
   * What is known of a device: the link state when connected, null when it
   * does not answer, undefined when nothing is known yet (first connection
   * in progress, or a connection just lost).
   */
  deviceState(device) {
    const link = this.linkOf(device);
    if (link?.connected) {
      return link.state;
    }
    // A connection just lost is not "off" yet: only a failed attempt says so.
    return link && link.lastError && !link.connected ? null : undefined;
  }

  /** One link per typed address and per known device. */
  syncLinks({ retry = false } = {}) {
    if (!this.started) {
      return;
    }
    const wanted = new Map();
    for (const address of this.config.addresses) {
      wanted.set(addressKey(address), address);
    }
    for (const device of this.devices) {
      wanted.set(addressKey(device), { host: device.host, port: device.port });
    }
    for (const [key, link] of this.links) {
      if (!wanted.has(key)) {
        link.stop();
        this.links.delete(key);
      }
    }
    for (const [key, address] of wanted) {
      const existing = this.links.get(key);
      if (existing) {
        if (retry) {
          existing.retrySoon();
        }
        continue;
      }
      const link = new DeviceLink({
        address,
        logger: this.logger,
        timings: this.timings,
        timers: this.timers,
        now: this.now,
        connect: this.connect,
        onEvent: (event, source) => this.linkEvent(event, source),
      });
      link.setModelHint(this.data?.devices?.[platformId(address)]?.model);
      this.links.set(key, link);
      link.start();
    }
  }

  linkEvent(event, link) {
    if (this.links.get(link.key) !== link) {
      return;
    }
    const id = platformId(link);
    if (event === 'up') {
      const device = this.remember({ host: link.host, port: link.port }, link.info);
      if (device) {
        link.setModelHint(device.model);
        this.logger.info(`${deviceName(device)} connected`);
        this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
        this.schedulePublish(device.id, 0);
      }
    } else if (event === 'update') {
      if (this.data.devices[id]) {
        this.schedulePublish(id);
      }
    } else if (event === 'failed') {
      // The device known at this address does not answer: power 0.
      if (this.data.devices[id]) {
        this.schedulePublish(id, 0);
      }
    }
    this.updateStatus().catch(() => {});
  }

  /**
   * Remembers the device answering at `address`, with the model it gave
   * (kept when it gives none this time), and grows its dropdowns with the
   * options of its family.
   */
  remember(address, info = {}) {
    const table = this.data.devices;
    const id = platformId(address);
    let device = Object.hasOwn(table, id) ? table[id] : undefined;
    if (!device) {
      if (Object.keys(table).length >= LIMITS.devices) {
        this.warnOnce('devices', `More than ${LIMITS.devices} devices: the next ones are ignored`);
        return undefined;
      }
      device = {
        id,
        host: address.host,
        port: address.port,
        model: undefined,
        revision: undefined,
        sourceOptions: [],
        audioModeOptions: [],
      };
      table[id] = device;
      this.persist();
    }
    let changed = false;
    for (const field of ['model', 'revision']) {
      if (info[field] && info[field] !== device[field]) {
        device[field] = info[field];
        changed = true;
      }
    }
    if (this.mergeFamilyOptions(device) || changed) {
      this.persist();
    }
    return device;
  }

  /** The dropdowns only grow: the options of the device's family are added. */
  mergeFamilyOptions(device) {
    const family = familyOf(device.model);
    const sources = sourceOptions(device);
    const modes = audioModeOptions(device);
    const grew =
      mergeOptions(
        sources,
        sourcesOf(family).map((name) => ({ value: name, label: SOURCE_LABELS[name] ?? name })),
      ) | mergeOptions(modes, audioModesOf(family));
    if (grew) {
      device.sourceOptions = sources;
      device.audioModeOptions = modes;
    }
    return Boolean(grew);
  }

  /**
   * The options of the device created in Gladys (`gladys.devices`, kept up
   * to date by the SDK), merged into the known device: options seen before a
   * reset of /data are never dropped from the created device.
   */
  mergeCreatedOptions(device) {
    const ids = idsOf(this.gladys, device);
    const created = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === ids.device,
    );
    const features = Array.isArray(created?.features) ? created.features : [];
    let changed = false;
    for (const [key, field] of [
      [FEATURES.SOURCE, 'sourceOptions'],
      [FEATURES.AUDIO_MODE, 'audioModeOptions'],
    ]) {
      const feature = features.find((f) => f?.external_id === ids.feature(key));
      const options = (
        Array.isArray(feature?.supported_options) ? feature.supported_options : []
      ).filter((o) => isOptionValue(o?.value));
      const current = (field === 'sourceOptions' ? sourceOptions : audioModeOptions)(device);
      if (
        mergeOptions(
          current,
          options.map((o) => ({
            value: o.value,
            label: typeof o.label === 'string' ? o.label.slice(0, LIMITS.name) : o.value,
          })),
        )
      ) {
        device[field] = current;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const devices = this.devices;
    devices.forEach((device) => this.mergeCreatedOptions(device));
    await this.gladys.publishDiscoveredDevices(devices.map((d) => buildDevice(this.gladys, d)));
  }

  /**
   * The devices created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works.
   */
  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      list = this.gladys.devices;
    }
    const byExternalId = new Map(this.devices.map((d) => [idsOf(this.gladys, d).device, d.id]));
    this.created = new Set(
      (Array.isArray(list) ? list : [])
        .map((d) => byExternalId.get(d?.external_id))
        .filter(Boolean),
    );
  }

  // --- States --------------------------------------------------------------------

  /** The states of a device, grouped: at most one publication per `publishDelay`. */
  schedulePublish(id, delay = this.timings.publishDelay) {
    if (this.publishTimers.has(id)) {
      if (delay > 0) {
        return;
      }
      this.timers.clearTimeout(this.publishTimers.get(id));
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.publishTimers.delete(id);
      if (generation !== this.generation) {
        return;
      }
      const device = this.data?.devices?.[id];
      if (device) {
        this.publishStates(device).catch(() => {});
      }
    }, delay);
    this.publishTimers.set(id, handle);
  }

  async publishStates(device) {
    if (!this.created.has(device.id)) {
      return;
    }
    const states = stateList(this.gladys, device, this.deviceState(device));
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(`Could not publish the states of ${deviceName(device)}: ${err.message}`);
    }
  }

  async publishAllStates() {
    for (const device of this.devices) {
      await this.publishStates(device);
    }
  }

  // --- Search ----------------------------------------------------------------------

  /**
   * The optional SSDP search through Gladys: each local address that answers
   * is asked, on port 50000, whether it is an Arcam device. One search at a
   * time (a second request joins the running one); the answers are asked
   * `scanConcurrency` at a time, none started after `scanBudget`.
   */
  scan() {
    if (!this.scanning) {
      this.scanning = this.runScan().finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  async runScan() {
    const deadline = this.now() + this.timings.scanBudget;
    const generation = this.generation;
    const stopped = () => generation !== this.generation || !this.data;
    let results = [];
    try {
      results = await this.gladys.scanNetwork('ssdp', { timeoutSeconds: this.timings.scanSeconds });
    } catch (err) {
      // Optional: the typed addresses work without it.
      this.logger.warn(`SSDP search failed: ${err.message}`);
    }
    const known = new Set(this.devices.map((d) => d.host));
    const hosts = [];
    for (const result of (Array.isArray(results) ? results : []).slice(0, LIMITS.scanResults)) {
      const host = result?.source_ip;
      if (isLanAddress(host) && !known.has(host) && !hosts.includes(host)) {
        hosts.push(host);
      }
    }
    let changed = false;
    await mapLimit(hosts, this.timings.scanConcurrency, async (host) => {
      if (this.now() >= deadline || stopped()) {
        return;
      }
      const address = { host, port: DEFAULT_PORT };
      try {
        const info = await this.identifyAt({
          address,
          timings: this.timings,
          connect: this.connect,
        });
        if (!stopped() && this.remember(address, info)) {
          changed = true;
        }
      } catch (err) {
        this.logger.debug?.(`${host} is not an Arcam device: ${err.message}`);
      }
    });
    if (stopped()) {
      return this.devices;
    }
    this.syncLinks({ retry: true });
    if (changed) {
      await this.publishDevices();
    }
    return this.devices;
  }

  // --- Commands --------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(device, key, value) {
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new Error(`Invalid volume "${short(value)}": an integer from 0 to 99`);
      }
      return volume;
    }
    if (key === FEATURES.SOURCE || key === FEATURES.AUDIO_MODE) {
      const options = key === FEATURES.SOURCE ? sourceOptions(device) : audioModeOptions(device);
      if (typeof value !== 'string' || !options.some((o) => o.value === value)) {
        throw new Error(
          `Unknown ${key === FEATURES.SOURCE ? 'source' : 'audio mode'} "${short(value)}"`,
        );
      }
      return value;
    }
    if (BUTTONS.has(key)) {
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  async setValue(gladysDevice, feature, value) {
    const device = this.deviceOf(gladysDevice);
    if (!device) {
      throw new Error(`Unknown device ${short(gladysDevice?.external_id)}`);
    }
    const key = featureKey(gladysDevice.external_id, feature?.external_id);
    const checked = this.validate(device, key, value);
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    let late = false;
    // Set just before a command frame leaves: from then on, it may have
    // reached the device, whatever happens next.
    const context = { mayHaveSent: false };
    const run = this.enqueue(
      device.id,
      async () => {
        if (late || this.remaining(started) < 50) {
          // Gladys stopped waiting while this command was queued: dropped, never sent late.
          late = true;
          throw new DeviceError(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
        }
        return this.command(device, key, checked, started, context);
      },
      { urgent: URGENT.has(key) },
    );
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          reject(
            context.mayHaveSent
              ? new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
                  sent: true,
                })
              : new DeviceError(
                  ERROR_KINDS.BUDGET,
                  'No time left for this command (device busy), nothing sent',
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /**
   * Sends one command frame and waits for its answer. A frame that may have
   * reached the device is never reported as "not sent": "sent, without
   * confirmation" (the pushed state shows what the device did).
   */
  async send(device, link, { cc, data }, started, context) {
    context.mayHaveSent = true;
    try {
      return await link.request(cc, data, this.remaining(started), { urgent: true });
    } catch (err) {
      if (err.kind === ERROR_KINDS.TIMEOUT || err.kind === ERROR_KINDS.CLOSED) {
        throw new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
          sent: true,
        });
      }
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.BUDGET) {
        context.mayHaveSent = false;
        throw new DeviceError(
          err.kind,
          err.kind === ERROR_KINDS.BUDGET
            ? 'No time left for this command, nothing sent'
            : `${deviceName(device)} is not connected: nothing sent`,
        );
      }
      throw err;
    }
  }

  /** A state read just before a command: whatever goes wrong, nothing was sent. */
  async readBefore(device, link, what, cc, started) {
    const budget = Math.min(this.timings.preRead, this.remaining(started));
    try {
      return await link.request(cc, [QUERY], budget, { urgent: true });
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        throw new DeviceError(err.kind, `${deviceName(device)} is not connected: nothing sent`);
      }
      if (err.kind === ERROR_KINDS.REFUSED) {
        throw new DeviceError(err.kind, `${what} not readable (${err.message}): nothing sent`);
      }
      throw new DeviceError(ERROR_KINDS.BUDGET, `${what} not read in time: nothing sent`);
    }
  }

  unsupported(device) {
    return new Error(`${deviceName(device)}: not available on this model, nothing sent`);
  }

  async command(device, key, value, started, context) {
    const link = this.connectedLink(device);
    if (!link) {
      // Standby included: a device just disconnected may still be on, so
      // "already in standby" would be a guess. Nothing sent, said so.
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(device)} is not connected (standby without network, off or unreachable): nothing sent`,
      );
    }
    const family = link.family;
    const send = (request) => this.send(device, link, request, started, context);
    switch (key) {
      case FEATURES.POWER_ON: {
        // A new press starts over: the check chain of the previous one stops.
        this.cancelWakeCheck(device.id);
        await send(REQUESTS.power(family, true));
        if (!supports(family, CC.VOLUME)) {
          return undefined;
        }
        // A device wakes up at the volume it had: brought back to the cap.
        // Within what is left of this command first, then in the background
        // while the device is still waking up. The ack never depends on it.
        const done = await this.capVolume(device, link, () =>
          Math.min(this.timings.preRead, this.remaining(started) - 100),
        ).catch(() => false);
        if (!done) {
          this.capAfterWake(device, 1);
        }
        return undefined;
      }
      case FEATURES.STANDBY:
        await send(REQUESTS.power(family, false));
        return undefined;
      case FEATURES.VOLUME: {
        const request = REQUESTS.volume(family, 0);
        if (!request) {
          throw this.unsupported(device);
        }
        // The cap is read here, just before the frame leaves: a configuration
        // saved while the command waited in the queue applies.
        const cap = this.config.maxVolume;
        const target = Math.min(value, cap);
        if (target < value) {
          this.logger.info(`${deviceName(device)}: volume ${value} capped to ${cap}`);
        }
        await send(REQUESTS.volume(family, target));
        return undefined;
      }
      case FEATURES.MUTE: {
        // Gladys sends a press, not a target: the mute is read from the
        // device just before, and the opposite is set explicitly (no toggle).
        const mute = decodeMute(
          await this.readBefore(device, link, 'Mute state', CC.MUTE, started),
        );
        if (mute === undefined) {
          throw new Error(`${deviceName(device)}: mute state unknown, nothing sent`);
        }
        if (mute && supports(family, CC.VOLUME)) {
          // Unmuting never makes the device play above the cap: the volume
          // read just now decides, and is lowered first when above it.
          const volume = decodeVolume(
            await this.readBefore(device, link, 'Volume', CC.VOLUME, started),
          );
          if (volume === undefined) {
            throw new Error(`${deviceName(device)}: volume unknown, nothing sent`);
          }
          const cap = this.config.maxVolume;
          if (volume > cap) {
            this.logger.info(
              `${deviceName(device)}: volume ${volume} lowered to ${cap} before unmuting`,
            );
            await send(REQUESTS.volume(family, cap));
          }
        }
        await send(REQUESTS.mute(family, !mute));
        return undefined;
      }
      case FEATURES.SOURCE: {
        const request = REQUESTS.source(family, value);
        if (!request) {
          throw this.unsupported(device);
        }
        await send(request);
        return undefined;
      }
      case FEATURES.AUDIO_MODE: {
        const request = REQUESTS.audioMode(family, value);
        if (!request) {
          throw this.unsupported(device);
        }
        // The modes depend on the signal (2-channel or multi-channel), read
        // again just before: a mode of the other kind would do something else.
        const format = decodeFormat(
          await this.readBefore(
            device,
            link,
            'Incoming audio format',
            CC.INCOMING_AUDIO_FORMAT,
            started,
          ),
        );
        const twoChannel = isTwoChannel(format);
        if (value.startsWith('2CH_') !== twoChannel) {
          throw new Error(
            `${deviceName(device)}: "${value}" is not available for the current ${
              twoChannel ? '2-channel' : 'multi-channel'
            } signal, nothing sent`,
          );
        }
        await send(request);
        return undefined;
      }
      default:
        throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
  }

  /**
   * Reads the power and the volume, and lowers the volume to the cap when
   * the device is on and above it. True when settled (lowered, or nothing to
   * lower), false when the device cannot tell yet (waking up).
   */
  async capVolume(device, link, budget) {
    if (budget() <= 0 || !link.connected) {
      return false;
    }
    const power = decodePower(await link.request(CC.POWER, [QUERY], budget(), { urgent: true }));
    if (power !== true || budget() <= 0) {
      return false;
    }
    const volume = decodeVolume(await link.request(CC.VOLUME, [QUERY], budget(), { urgent: true }));
    if (volume === undefined) {
      return false;
    }
    const cap = this.config.maxVolume;
    if (volume <= cap) {
      return true;
    }
    if (budget() <= 0) {
      return false;
    }
    this.logger.info(`${deviceName(device)}: woke up at volume ${volume}, lowered to ${cap}`);
    const request = REQUESTS.volume(link.family, cap);
    await link.request(request.cc, request.data, budget(), { urgent: true });
    return true;
  }

  /** Cancels the wake-up check chain of a device, if any. */
  cancelWakeCheck(id) {
    const chain = this.wakeChecks.get(id);
    if (chain) {
      this.timers.clearTimeout(chain.timer);
      this.wakeChecks.delete(id);
    }
  }

  /**
   * After a Power on: the cap checked again every `wakeCheckDelay`,
   * `wakeChecks` times at most. One chain per device: a new chain (another
   * Power on) replaces the running one, which stops at its next step.
   */
  capAfterWake(device, attempt, chain = { timer: undefined }) {
    if (attempt === 1) {
      this.cancelWakeCheck(device.id);
      this.wakeChecks.set(device.id, chain);
    }
    const current = () => this.wakeChecks.get(device.id) === chain;
    if (attempt > this.timings.wakeChecks) {
      this.wakeChecks.delete(device.id);
      this.logger.info(`${deviceName(device)}: volume not confirmed after waking up`);
      return;
    }
    const generation = this.generation;
    chain.timer = this.timers.setTimeout(() => {
      if (generation !== this.generation || !current()) {
        return;
      }
      this.enqueue(device.id, async () => {
        const link = this.connectedLink(device);
        if (!link || !current()) {
          return !current();
        }
        return this.capVolume(device, link, () => this.timings.preRead);
      })
        .catch(() => false)
        .then((done) => {
          if (!current()) {
            return;
          }
          if (done) {
            this.wakeChecks.delete(device.id);
          } else {
            this.capAfterWake(device, attempt + 1, chain);
          }
        });
    }, this.timings.wakeCheckDelay);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(gladysDevice) {
    const device = this.deviceOf(gladysDevice);
    if (!device) {
      return;
    }
    this.created.add(device.id);
    // The SDK forgot what was published for this device: everything again.
    await this.publishStates(device);
    await this.updateStatus();
  }

  async deviceDeleted(gladysDevice) {
    const device = this.deviceOf(gladysDevice);
    if (device) {
      this.created.delete(device.id);
      await this.updateStatus();
    }
  }

  // --- Configuration screen buttons -------------------------------------------------

  async findDevices() {
    const devices = await this.scan();
    await this.updateStatus();
    return T.found(devices.map(deviceName));
  }

  async checkDevices() {
    if (this.devices.length === 0) {
      return T.noDevice;
    }
    const lines = this.devices.map((device) =>
      T.checkLine(deviceName(device), this.connectedLink(device)?.state),
    );
    return T.check(lines, this.config.maxVolume);
  }

  // --- Status ---------------------------------------------------------------------

  /** The typed addresses where no Arcam device answers yet. */
  silentAddresses() {
    return this.config.addresses
      .filter((a) => !Object.hasOwn(this.data.devices, platformId(a)))
      .filter((a) => {
        const link = this.links.get(addressKey(a));
        return link && !link.connected && link.lastError;
      })
      .map(addressKey);
  }

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const silent = this.silentAddresses();
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const off = this.devices
      .filter((d) => this.created.has(d.id) && this.deviceState(d) === null)
      .map(deviceName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const status = { connected: true };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}

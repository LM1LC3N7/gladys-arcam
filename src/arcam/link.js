// -----------------------------------------------------------------------------
// The persistent link with the device at one address: the TCP connection
// opened, the model asked (AMX), the state of zone 1 read, the pushed updates
// merged, the power asked every 10 s (no frame at all in 25 s closes the
// connection), the full state read again every 5 minutes and after the
// device turned on, and the reconnection spaced out (10 s, then doubled each
// time up to 5 minutes; the count is only reset by a connection that stayed
// up a minute).
//
// The link knows nothing of Gladys: it reports to the app through `onEvent`
// ('up', 'update', 'down', 'failed').
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, TIMINGS, ZONE } from '../constants.js';
import { DeviceError, ERROR_KINDS, openSession } from './connection.js';
import {
  ANSWER,
  CC,
  QUERY,
  decodeFormat,
  decodeMute,
  decodePower,
  decodeSource,
  decodeVolume,
  familyOf,
  isTwoChannel,
  decodeAudioMode,
  supports,
} from './protocol.js';

/** The state codes read at connection, in this order. */
export const SNAPSHOT = Object.freeze([
  CC.POWER,
  CC.VOLUME,
  CC.MUTE,
  CC.CURRENT_SOURCE,
  CC.INCOMING_AUDIO_FORMAT,
  CC.DECODE_MODE_2CH,
  CC.DECODE_MODE_MCH,
]);

/**
 * The state of zone 1 from the raw answers: every field undefined when
 * unknown (not read yet, refused, or not understood).
 */
export function deriveState(family, raw) {
  const format = decodeFormat(raw.get(CC.INCOMING_AUDIO_FORMAT));
  const twoChannel = isTwoChannel(format);
  return {
    power: decodePower(raw.get(CC.POWER)),
    volume: supports(family, CC.VOLUME) ? decodeVolume(raw.get(CC.VOLUME)) : undefined,
    mute: decodeMute(raw.get(CC.MUTE)),
    source: supports(family, CC.CURRENT_SOURCE)
      ? decodeSource(family, raw.get(CC.CURRENT_SOURCE))
      : undefined,
    audioMode: supports(family, CC.DECODE_MODE_2CH)
      ? decodeAudioMode(twoChannel, raw.get(twoChannel ? CC.DECODE_MODE_2CH : CC.DECODE_MODE_MCH))
      : undefined,
    twoChannel,
  };
}

export class DeviceLink {
  constructor({
    address,
    onEvent = () => {},
    logger,
    timings = TIMINGS,
    timers = globalThis,
    now = Date.now,
    connect,
  }) {
    this.host = address.host;
    this.port = address.port ?? DEFAULT_PORT;
    this.onEvent = onEvent;
    this.logger = logger;
    this.timings = timings;
    this.timers = timers;
    this.now = now;
    this.connectFn = connect;
    this.session = undefined;
    this.connecting = false;
    this.stopped = false;
    this.failures = 0;
    this.connectedAt = undefined;
    this.lastAttempt = -Infinity;
    this.retryTimer = undefined;
    this.heartbeatTimer = undefined;
    this.refreshTimer = undefined;
    this.wakeTimer = undefined;
    this.frames = [];
    /** The read chain running: { session, promise } */
    this.reading = undefined;
    /** The last error of a connection attempt (shown by "Check"). */
    this.lastError = undefined;
    /** The AMX identification: { make, model, revision }. */
    this.info = {};
    this.modelHint = undefined;
    /** cc -> data of the last good answer (zone 1). */
    this.raw = new Map();
    this.state = deriveState(this.family, this.raw);
  }

  get key() {
    return this.port === DEFAULT_PORT ? this.host : `${this.host}:${this.port}`;
  }

  /** The family of the model the device gave, else of the model saved for this address. */
  get family() {
    return familyOf(this.info?.model ?? this.modelHint);
  }

  /** The model saved for this address (used when the device does not answer the AMX request). */
  setModelHint(model) {
    if (model !== this.modelHint) {
      this.modelHint = model;
      this.state = deriveState(this.family, this.raw);
    }
  }

  get connected() {
    return Boolean(this.session?.open) && this.connectedAt !== undefined;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.timers.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.stopTimers();
    const session = this.session;
    this.session = undefined;
    session?.close();
  }

  /**
   * A reconnection asked now (configuration saved, "Find" button): skips the
   * backoff, never the base interval since the last attempt.
   */
  retrySoon() {
    if (this.stopped || this.connected || this.connecting) {
      return;
    }
    const wait = Math.max(0, this.lastAttempt + this.timings.reconnectBase - this.now());
    this.schedule(wait);
  }

  schedule(ms) {
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, ms);
  }

  backoff() {
    if (
      this.connectedAt !== undefined &&
      this.now() - this.connectedAt >= this.timings.stableAfter
    ) {
      this.failures = 0;
    }
    this.connectedAt = undefined;
    this.failures += 1;
    return Math.min(
      this.timings.reconnectMax,
      this.timings.reconnectBase * 2 ** Math.min(this.failures - 1, 16),
    );
  }

  async connect() {
    if (this.stopped || this.connecting || this.session) {
      return;
    }
    this.connecting = true;
    this.lastAttempt = this.now();
    let session;
    try {
      session = await openSession({
        host: this.host,
        port: this.port,
        timeoutMs: this.timings.connectTimeout,
        connect: this.connectFn,
        onAnswer: (frame) => this.answer(session, frame),
        onClose: () => this.closed(session),
        onFrame: (source) => this.frame(source),
      });
      if (this.stopped) {
        session.close();
        return;
      }
      this.session = session;
      this.raw = new Map();
      const info = await session.amx(this.timings.identifyTimeout);
      this.info = { ...info };
      // The power answers on every Arcam model: an answer (even a refusal)
      // in the Arcam framing tells it is one.
      try {
        await session.request(ZONE, CC.POWER, [QUERY], this.timings.requestTimeout);
      } catch (err) {
        if (err.kind !== ERROR_KINDS.REFUSED) {
          throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not an Arcam device (no answer)');
        }
      }
      await this.readSnapshot(session, { skipPower: true });
      if (!session.open) {
        throw new DeviceError(ERROR_KINDS.UNREACHABLE, 'Connection closed while reading');
      }
      this.connectedAt = this.now();
      this.lastError = undefined;
      this.startTimers(session);
      this.state = deriveState(this.family, this.raw);
      this.onEvent('up', this);
    } catch (err) {
      this.lastError = err;
      if (session) {
        // Opened, then not a usable Arcam device: closed, spaced out.
        this.session = undefined;
        session.onClose = undefined;
        session.close();
      }
      if (!this.stopped) {
        const delay = this.backoff();
        this.logger?.debug?.(`${this.key}: ${err.message}, next attempt in ${delay / 1000} s`);
        this.schedule(delay);
        this.onEvent('failed', this, err);
      }
    } finally {
      this.connecting = false;
    }
  }

  /** Asks every state of zone 1 the family knows; the answers land in `answer`. */
  readSnapshot(session, options) {
    // One read chain at a time: a second one (wake read, 5-minute refresh)
    // joins the one running.
    if (this.reading?.session === session) {
      return this.reading.promise;
    }
    const promise = this.runSnapshot(session, options).finally(() => {
      if (this.reading?.promise === promise) {
        this.reading = undefined;
      }
    });
    this.reading = { session, promise };
    return promise;
  }

  async runSnapshot(session, { skipPower = false } = {}) {
    for (const cc of SNAPSHOT) {
      if ((skipPower && cc === CC.POWER) || !supports(this.family, cc) || !session.open) {
        continue;
      }
      try {
        await session.request(ZONE, cc, [QUERY], this.timings.requestTimeout);
      } catch {
        // Refused (standby) or silent: that state stays unknown.
      }
    }
  }

  answer(session, frame) {
    if (session !== this.session || frame.zone !== ZONE) {
      return;
    }
    const before = this.state;
    if (frame.ac === ANSWER.OK) {
      if (frame.cc === CC.SIMULATE_RC5) {
        return;
      }
      this.raw.set(frame.cc, frame.data);
    } else if (this.raw.has(frame.cc) && frame.cc !== CC.SIMULATE_RC5) {
      // A refused read (standby, nothing to decode): unknown, as arcam-fmj.
      this.raw.delete(frame.cc);
    } else {
      return;
    }
    this.state = deriveState(this.family, this.raw);
    if (this.connectedAt === undefined) {
      // Still connecting: 'up' reports the whole state.
      return;
    }
    if (before.power !== true && this.state.power === true) {
      // Turned on: what was refused in standby can be read now.
      this.scheduleWakeRead(session);
    }
    this.onEvent('update', this);
  }

  scheduleWakeRead(session) {
    if (this.wakeTimer) {
      return;
    }
    this.wakeTimer = this.timers.setTimeout(() => {
      this.wakeTimer = undefined;
      if (session === this.session && session.open) {
        this.readSnapshot(session, { skipPower: true }).catch(() => {});
      }
    }, this.timings.wakeRead);
  }

  /**
   * Every frame, counted before it is used: a device flooding the
   * connection is closed, then asked again spaced out.
   */
  frame(session) {
    const now = this.now();
    this.frames.push(now);
    while (this.frames.length > 0 && now - this.frames[0] > this.timings.floodWindow) {
      this.frames.shift();
    }
    if (this.frames.length > this.timings.floodFrames) {
      this.logger?.warn?.(`${this.key}: too many frames, connection closed`);
      this.frames = [];
      session.close();
    }
  }

  closed(session) {
    if (session !== this.session) {
      return;
    }
    this.session = undefined;
    this.stopTimers();
    this.timers.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (this.stopped || this.connectedAt === undefined) {
      // Closed while connecting: connect() fails and spaces the next attempt.
      return;
    }
    const delay = this.backoff();
    this.schedule(delay);
    this.logger?.info?.(`${this.key}: connection lost, next attempt in ${delay / 1000} s`);
    this.onEvent('down', this);
  }

  startTimers(session) {
    this.stopTimers();
    this.heartbeatTimer = this.timers.setInterval(() => {
      if (session !== this.session) {
        return;
      }
      if (Date.now() - session.lastFrame > this.timings.silence) {
        this.logger?.info?.(`${this.key}: no answer, connection closed`);
        session.close();
        return;
      }
      session.request(ZONE, CC.POWER, [QUERY], this.timings.requestTimeout).catch(() => {});
    }, this.timings.heartbeat);
    this.refreshTimer = this.timers.setInterval(() => {
      if (session === this.session && session.open) {
        this.readSnapshot(session).catch(() => {});
      }
    }, this.timings.refresh);
  }

  stopTimers() {
    this.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.timers.clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** A request on the open session; UNREACHABLE (nothing sent) without one. */
  request(cc, data, timeoutMs, options) {
    if (!this.connected) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'),
      );
    }
    return this.session.request(ZONE, cc, data, timeoutMs, options);
  }
}

/**
 * Asks the device at `address` whether it is an Arcam device, on a
 * connection of its own closed right after. Resolves with its AMX
 * identification ({} when it has none but answers the Arcam protocol);
 * throws a DeviceError otherwise.
 */
export async function identify({ address, timings = TIMINGS, connect }) {
  const session = await openSession({
    host: address.host,
    port: address.port ?? DEFAULT_PORT,
    timeoutMs: timings.connectTimeout,
    connect,
  });
  try {
    const info = await session.amx(timings.identifyTimeout);
    try {
      await session.request(ZONE, CC.POWER, [QUERY], timings.requestTimeout);
    } catch (err) {
      if (err.kind !== ERROR_KINDS.REFUSED) {
        throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not an Arcam device (no answer)');
      }
    }
    return info;
  } finally {
    session.close();
  }
}

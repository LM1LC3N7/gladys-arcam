// -----------------------------------------------------------------------------
// One TCP session with an Arcam device (port 50000), as the client of
// arcam-fmj (MIT, see THIRD_PARTY_NOTICES.md): one request on the wire at a
// time, its answer matched by zone and command code, every answer frame (the
// pushed updates included) handed to `onAnswer`.
//
// Bounded: 4 KB waiting to be framed at most (src/arcam/protocol.js), 32
// requests waiting, each with its own deadline; a request that cannot start
// before its deadline is dropped, never sent late. Commands go before the
// state reads waiting.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS } from '../constants.js';
import { AMX_REQUEST, ANSWER, FrameParser, answerText, encodeCommand } from './protocol.js';

export const ERROR_KINDS = Object.freeze({
  /** No connection: nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Sent, no answer in time: the device may have done it. */
  TIMEOUT: 'timeout',
  /** The connection closed while the answer was awaited: the device may have done it. */
  CLOSED: 'closed',
  /** The device answered with an error code. */
  REFUSED: 'refused',
  /** Something answered, but not as an Arcam device. */
  PROTOCOL: 'protocol',
  /** No time left: nothing was sent. */
  BUDGET: 'budget',
});

export class DeviceError extends Error {
  constructor(kind, message, { sent = false, ac } = {}) {
    super(message);
    this.name = 'DeviceError';
    this.kind = kind;
    this.sent = sent;
    this.ac = ac;
  }
}

/** The default connection factory (the tests redirect it to the loopback interface). */
export const createTcpConnection = (options) => net.createConnection(options);

/**
 * Opens a session. Rejects with UNREACHABLE when nothing accepts the
 * connection within `timeoutMs`.
 */
export function openSession({
  host,
  port,
  timeoutMs,
  connect = createTcpConnection,
  onAnswer,
  onAmx,
  onClose,
  onFrame,
  staleMs = 2_000,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
      socket?.destroy();
    };
    const timer = setTimeout(
      () => fail(new DeviceError(ERROR_KINDS.UNREACHABLE, 'No connection (timeout)')),
      timeoutMs,
    );
    try {
      socket = connect({ host, port });
    } catch (err) {
      fail(new DeviceError(ERROR_KINDS.UNREACHABLE, `Cannot connect: ${err.message}`));
      return;
    }
    socket.once('error', (err) => {
      fail(new DeviceError(ERROR_KINDS.UNREACHABLE, `No connection (${err.code ?? err.message})`));
    });
    socket.once('connect', () => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(new Session(socket, { onAnswer, onAmx, onClose, onFrame, staleMs }));
    });
  });
}

export class Session {
  constructor(socket, { onAnswer, onAmx, onClose, onFrame, staleMs = 2_000 } = {}) {
    this.socket = socket;
    this.onAnswer = onAnswer;
    this.onAmx = onAmx;
    this.onClose = onClose;
    this.onFrame = onFrame;
    this.staleMs = staleMs;
    this.parser = new FrameParser();
    this.closed = false;
    /** The request on the wire: { key, resolve, reject, timer } */
    this.current = undefined;
    /** Requests waiting their turn. */
    this.waiting = [];
    /** zone:cc -> until when the first answer is a late one (not matched) */
    this.stale = new Map();
    /** Waiters of the AMX answer. */
    this.amxWaiters = [];
    this.lastFrame = Date.now();
    socket.on('error', () => {
      // 'close' follows: handled there.
    });
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('close', () => this.closedByPeer());
  }

  get open() {
    return !this.closed && !this.socket.destroyed;
  }

  receive(chunk) {
    if (this.closed) {
      return;
    }
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch {
      this.close();
      return;
    }
    for (const frame of frames) {
      this.lastFrame = Date.now();
      this.onFrame?.(this);
      if (this.closed) {
        return;
      }
      if (frame.type === 'amx') {
        const waiters = this.amxWaiters;
        this.amxWaiters = [];
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame.info);
        }
        this.onAmx?.(frame.info);
        continue;
      }
      this.match(frame);
      this.onAnswer?.(frame);
    }
  }

  /** Settles the request on the wire when `frame` answers it (same zone and command code). */
  match(frame) {
    const key = `${frame.zone}:${frame.cc}`;
    const staleUntil = this.stale.get(key);
    if (staleUntil !== undefined) {
      this.stale.delete(key);
      if (Date.now() < staleUntil) {
        // The late answer of a request that timed out: never the answer of the next one.
        return;
      }
    }
    const current = this.current;
    if (!current || current.key !== key) {
      return;
    }
    this.current = undefined;
    clearTimeout(current.timer);
    if (frame.ac === ANSWER.OK) {
      current.resolve(frame.data);
    } else {
      current.reject(
        new DeviceError(ERROR_KINDS.REFUSED, `Refused by the device: ${answerText(frame.ac)}`, {
          ac: frame.ac,
        }),
      );
    }
    this.next();
  }

  /**
   * Sends one command frame and resolves with the data of its answer.
   * UNREACHABLE or BUDGET: nothing was sent. After the frame left, TIMEOUT
   * or CLOSED mark a request that may have reached the device (`sent: true`).
   * `urgent` requests (commands) go before the reads waiting. A request
   * still waiting at its deadline is dropped then (its own timer), never
   * written. `onWrite` is called just before the frame is written: from then
   * on, it may have reached the device.
   */
  request(zone, cc, data, timeoutMs, { urgent = false, onWrite } = {}) {
    if (!this.open) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'),
      );
    }
    if (this.waiting.length >= LIMITS.pending) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.BUDGET, 'Too many requests waiting: nothing sent'),
      );
    }
    if (!(timeoutMs > 0)) {
      return Promise.reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
    }
    return new Promise((resolve, reject) => {
      const item = {
        key: `${zone}:${cc}`,
        frame: encodeCommand(zone, cc, data),
        deadline: Date.now() + timeoutMs,
        urgent,
        onWrite,
        resolve,
        reject,
        timer: undefined,
      };
      // Waiting behind the request on the wire: dropped at its own deadline.
      item.timer = setTimeout(() => {
        const index = this.waiting.indexOf(item);
        if (index !== -1) {
          this.waiting.splice(index, 1);
          reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
        }
      }, timeoutMs);
      if (urgent) {
        const index = this.waiting.findIndex((w) => !w.urgent);
        this.waiting.splice(index === -1 ? this.waiting.length : index, 0, item);
      } else {
        this.waiting.push(item);
      }
      this.next();
    });
  }

  next() {
    while (!this.current && this.waiting.length > 0 && this.open) {
      const item = this.waiting.shift();
      clearTimeout(item.timer);
      const left = item.deadline - Date.now();
      if (left <= 0) {
        item.reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
        continue;
      }
      this.current = item;
      item.timer = setTimeout(() => {
        if (this.current !== item) {
          return;
        }
        this.current = undefined;
        this.stale.set(item.key, Date.now() + this.staleMs);
        item.reject(
          new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without answer from the device', {
            sent: true,
          }),
        );
        this.next();
      }, left);
      try {
        item.onWrite?.();
        this.socket.write(item.frame);
      } catch (err) {
        clearTimeout(item.timer);
        this.current = undefined;
        item.reject(new DeviceError(ERROR_KINDS.UNREACHABLE, `Not sent: ${err.message}`));
      }
    }
  }

  /** Asks the AMX identification (model, revision). Resolves with {} when nothing answers. */
  amx(timeoutMs) {
    if (!this.open) {
      return Promise.resolve({});
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.amxWaiters = this.amxWaiters.filter((w) => w !== waiter);
        resolve({});
      }, timeoutMs);
      this.amxWaiters.push(waiter);
      try {
        this.socket.write(AMX_REQUEST);
      } catch {
        // The answer never comes: the timer resolves.
      }
    });
  }

  closedByPeer() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const current = this.current;
    this.current = undefined;
    if (current) {
      clearTimeout(current.timer);
      current.reject(
        new DeviceError(ERROR_KINDS.CLOSED, 'Connection closed before the answer', {
          sent: true,
        }),
      );
    }
    for (const item of this.waiting.splice(0)) {
      clearTimeout(item.timer);
      item.reject(new DeviceError(ERROR_KINDS.UNREACHABLE, 'Connection closed: nothing sent'));
    }
    for (const waiter of this.amxWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve({});
    }
    this.onClose?.();
  }

  close() {
    try {
      this.socket.destroy();
    } catch {
      // Already closed.
    }
    this.closedByPeer();
  }
}

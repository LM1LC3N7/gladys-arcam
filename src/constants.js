// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <host>_<port>)`. */
export const DEVICE_TYPE = 'arcam';

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 in standby (or unreachable). */
  POWER: 'power',
  /** Push button: wakes the device up (network standby only). */
  POWER_ON: 'power_on',
  /** Push button: puts the device in standby. */
  STANDBY: 'standby',
  /** 0..99 (the scale of the device display), capped by the `max_volume` option. */
  VOLUME: 'volume',
  /** Push button: each press sets the opposite of the mute read from the device. */
  MUTE: 'mute',
  /** The input of zone 1. */
  SOURCE: 'source',
  /** The decode mode of zone 1 (AVR and processors only). */
  AUDIO_MODE: 'audio_mode',
});

export const ACTIONS = Object.freeze({
  FIND: 'find_devices',
  CHECK: 'check_devices',
});

/** The SSDP search target Home Assistant matches Arcam devices with. */
export const SSDP_ST = 'urn:schemas-upnp-org:device:MediaRenderer:1';

/** The Arcam IP control port. */
export const DEFAULT_PORT = 50000;

/** Zone 1 only (the main zone). */
export const ZONE = 1;

/** The volume cap of the configuration, in device steps (0..99 on the display). */
export const VOLUME = Object.freeze({ min: 0, max: 99 });
export const MAX_VOLUME = Object.freeze({ min: 1, max: 99, default: 40 });

export const TIMINGS = Object.freeze({
  /** Opening the TCP connection. */
  connectTimeout: 5_000,
  /** One read while connecting or polling. */
  requestTimeout: 1_500,
  /** The AMX identification (model) while connecting. */
  identifyTimeout: 2_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * per-device queue and every request included) gets `commandBudget`, a
   * state read just before a mute press or an audio mode `preRead` of it.
   */
  commandBudget: 3_500,
  preRead: 1_200,
  /**
   * Reconnection: first after `reconnectBase`, then doubled each time up to
   * `reconnectMax`. The count is only reset by a connection that stayed up
   * `stableAfter`.
   */
  reconnectBase: 10_000,
  reconnectMax: 5 * 60_000,
  stableAfter: 60_000,
  /**
   * The power of zone 1 asked every `heartbeat` (as arcam-fmj, slower); no
   * frame at all within `silence` closes the connection.
   */
  heartbeat: 10_000,
  silence: 25_000,
  /** The full state read again this often (the pushed updates do the rest). */
  refresh: 5 * 60_000,
  /** After the power turned on, the full state read again after this. */
  wakeRead: 1_500,
  /**
   * After a Power on whose volume could not be checked in the command
   * budget: the cap is checked again every `wakeCheckDelay`, `wakeChecks` times.
   */
  wakeCheckDelay: 2_500,
  wakeChecks: 6,
  /**
   * After a Power on of Gladys: for this long, the first update that shows
   * the device on with its volume known lowers it to the cap when above
   * (a device slower to wake up than the checks above).
   */
  wakeWindow: 120_000,
  /** The states of one device are published at most this often (a knob turned fast). */
  publishDelay: 1_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** The background round: status, created devices read again. */
  tick: 30_000,
  /** SSDP listening time of a search. */
  scanSeconds: 5,
  /** No answer of a search is probed after this (counted from its start). */
  scanBudget: 35_000,
  scanConcurrency: 4,
  /** More frames than this within `floodWindow`: the connection is closed. */
  floodFrames: 300,
  floodWindow: 10_000,
});

export const LIMITS = Object.freeze({
  devices: 20,
  addresses: 20,
  /** Bytes waiting to be framed on one connection (a frame is 261 bytes at most). */
  buffer: 4 * 1024,
  /** Length of an AMX answer line. */
  amx: 512,
  /** Requests waiting on one connection. */
  pending: 32,
  /** SSDP answers kept from one search. */
  scanResults: 50,
  /** Length of a name or a model. */
  name: 64,
  /** Options of a select kept for one device. */
  options: 40,
});

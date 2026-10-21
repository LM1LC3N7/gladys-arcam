// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, MAX_VOLUME } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  max_volume: MAX_VOLUME.default,
};

/**
 * The address of a device typed by the user: an IPv4 address, with an
 * optional port (50000 by default; a pasted URL is reduced to its
 * host and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^(?:https?|tcp):\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  // IPv4 only: the address is the identity of a device, and a host name
  // next to its IP address would give the same device twice.
  return isIP(host) === 4 ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/**
 * The platform id of the device at an address (the external id): the
 * Arcam protocol gives no serial number, so the address is the identity.
 */
export const platformId = ({ host, port }) => `${host}_${port}`;

/** The volume cap: an integer 1..99; anything unreadable gives the default. */
export function parseMaxVolume(raw) {
  const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (raw === null || raw === undefined || typeof raw === 'boolean' || !Number.isFinite(value)) {
    return MAX_VOLUME.default;
  }
  return Math.min(MAX_VOLUME.max, Math.max(MAX_VOLUME.min, Math.round(value)));
}

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry.slice(0, 100));
    } else if (
      !addresses.some((a) => addressKey(a) === addressKey(address)) &&
      addresses.length < LIMITS.addresses
    ) {
      addresses.push(address);
    }
  }
  return { addresses, invalid, maxVolume: parseMaxVolume(c.max_volume) };
}

// -----------------------------------------------------------------------------
// Known devices -> Gladys devices and states (pure). One Gladys device per
// address (the Arcam protocol gives no serial number), zone 1.
//
// The categories and types are the ones of the Gladys core: `music/volume`
// like the core Sonos service, `television/volume-mute` for the mute press
// (music has no mute type), `text/select` for the source and the audio mode,
// `button/push` for "Power on" and "Standby", and the power state read only
// (`unknown/binary`): no switch, nothing an "everything on / off" (voice
// assistants, scenes) could turn into a command. No unit: the core lists none
// for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { addressKey, platformId } from './config.js';
import { DEVICE_TYPE, FEATURES, VOLUME } from './constants.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: VOLUME.min,
    max: VOLUME.max,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.AUDIO_MODE]: {
    name: 'Audio mode',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
});

const copyOptions = (options) =>
  (Array.isArray(options) ? options : []).map(({ value, label }) => ({ value, label }));

/** The options of the "Source" dropdown: every source this device has offered. */
export const sourceOptions = (device) => copyOptions(device.sourceOptions);
/** The options of the "Audio mode" dropdown. */
export const audioModeOptions = (device) => copyOptions(device.audioModeOptions);

export function deviceName(device) {
  return `Arcam ${device.model ?? ''} (${addressKey(device)})`.replace('  ', ' ');
}

export const idsOf = (gladys, device) => gladys.externalIds(DEVICE_TYPE, platformId(device));

export function buildDevice(gladys, device) {
  const ids = idsOf(gladys, device);
  return {
    name: deviceName(device),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: device.host }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE ? { supported_options: sourceOptions(device) } : {}),
      ...(key === FEATURES.AUDIO_MODE ? { supported_options: audioModeOptions(device) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a device. `state` is the link state of a connected device,
 * `null` for a device that does not answer (power 0 only), undefined for
 * "nothing known" (nothing published). A field unknown is not published.
 */
export function stateList(gladys, device, state) {
  if (state === undefined) {
    return [];
  }
  const ids = idsOf(gladys, device);
  const id = (key) => ids.feature(key);
  if (state === null) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const states = [];
  if (typeof state.power === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.POWER), state: state.power ? 1 : 0 });
  }
  if (Number.isInteger(state.volume)) {
    states.push({ device_feature_external_id: id(FEATURES.VOLUME), state: state.volume });
  }
  if (typeof state.mute === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: state.mute ? 1 : 0 });
  }
  if (sourceOptions(device).some((option) => option.value === state.source)) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: state.source });
  }
  if (audioModeOptions(device).some((option) => option.value === state.audioMode)) {
    states.push({ device_feature_external_id: id(FEATURES.AUDIO_MODE), text: state.audioMode });
  }
  return states;
}

// -----------------------------------------------------------------------------
// The Arcam IP control protocol (TCP port 50000), ported from arcam-fmj (MIT,
// see THIRD_PARTY_NOTICES.md): the frames, the command and answer codes, the
// model families, the source and decode mode tables, and the RC5 codes the
// models without a direct write need. Zone 1 only. Pure: no socket here.
//
// A command is `0x21 Zn Cc Dl Data… 0x0D`; an answer (or a pushed update) is
// `0x21 Zn Cc Ac Dl Data… 0x0D`. `0xF0` as the only data byte asks a state.
// The AMX discovery answer is an ASCII line `AMXB<Key=Value>…\r` (some
// devices start it with `\x01^`).
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export const STR = 0x21;
export const ETR = 0x0d;
/** The data byte that asks the state of a command code. */
export const QUERY = 0xf0;

export const CC = Object.freeze({
  POWER: 0x00,
  SIMULATE_RC5: 0x08,
  VOLUME: 0x0d,
  MUTE: 0x0e,
  DECODE_MODE_2CH: 0x10,
  DECODE_MODE_MCH: 0x11,
  CURRENT_SOURCE: 0x1d,
  INCOMING_AUDIO_FORMAT: 0x43,
});

export const ANSWER = Object.freeze({
  OK: 0x00,
  ZONE_INVALID: 0x82,
  COMMAND_NOT_RECOGNISED: 0x83,
  PARAMETER_NOT_RECOGNISED: 0x84,
  COMMAND_INVALID_AT_THIS_TIME: 0x85,
  INVALID_DATA_LENGTH: 0x86,
});

const ANSWER_TEXT = {
  [ANSWER.ZONE_INVALID]: 'zone invalid',
  [ANSWER.COMMAND_NOT_RECOGNISED]: 'command not recognised',
  [ANSWER.PARAMETER_NOT_RECOGNISED]: 'parameter not recognised',
  [ANSWER.COMMAND_INVALID_AT_THIS_TIME]: 'command invalid at this time (standby?)',
  [ANSWER.INVALID_DATA_LENGTH]: 'invalid data length',
};

export const answerText = (ac) =>
  ANSWER_TEXT[ac] ?? `answer 0x${Number(ac).toString(16).padStart(2, '0')}`;

// --- Model families -------------------------------------------------------------

/** The product families of arcam-fmj (`ApiModel`). */
export const FAMILY = Object.freeze({
  A450: '450',
  A860: '860',
  HDA: 'hda',
  SA: 'sa',
  PA: 'pa',
  ST: 'st',
});

const MODELS = {
  [FAMILY.A450]: ['AVR380', 'AVR450', 'AVR750'],
  [FAMILY.A860]: ['AV860', 'AVR850', 'AVR550', 'AVR390', 'SR250', 'RV-6', 'RV-9', 'MC-10'],
  [FAMILY.HDA]: [
    'AVR5',
    'AVR10',
    'AVR20',
    'AVR30',
    'AV40',
    'AVR11',
    'AVR21',
    'AVR31',
    'AV41',
    'SDP-55',
    'SDP-58',
  ],
  [FAMILY.SA]: ['SA10', 'SA20', 'SA30', 'SA750'],
  [FAMILY.PA]: ['PA720', 'PA240', 'PA410'],
  [FAMILY.ST]: ['ST60'],
};

const FAMILY_BY_MODEL = new Map(
  Object.entries(MODELS).flatMap(([family, models]) => models.map((m) => [m, family])),
);

/** The family of an AMX model string; the 450 series for an unknown model, as arcam-fmj. */
export const familyOf = (model) => FAMILY_BY_MODEL.get(model) ?? FAMILY.A450;

export const isKnownModel = (model) => FAMILY_BY_MODEL.has(model);

const AVR = new Set([FAMILY.A450, FAMILY.A860, FAMILY.HDA]);
const AVR_SA_ST = new Set([...AVR, FAMILY.SA, FAMILY.ST]);
/** Families that take a direct write of the power and the mute (else RC5). */
const DIRECT_POWER_MUTE = new Set([FAMILY.SA, FAMILY.PA, FAMILY.ST]);

/** Which command codes a family knows (the `version` gates of arcam-fmj). */
export function supports(family, cc) {
  switch (cc) {
    case CC.POWER:
    case CC.MUTE:
      return true;
    case CC.VOLUME:
    case CC.CURRENT_SOURCE:
    case CC.SIMULATE_RC5:
      return AVR_SA_ST.has(family);
    case CC.DECODE_MODE_2CH:
    case CC.DECODE_MODE_MCH:
    case CC.INCOMING_AUDIO_FORMAT:
      return AVR.has(family);
    default:
      return false;
  }
}

// --- Sources ---------------------------------------------------------------------

export const SOURCE_LABELS = Object.freeze({
  CD: 'CD',
  BD: 'BD (Blu-ray)',
  AV: 'AV',
  SAT: 'SAT',
  PVR: 'PVR',
  VCR: 'VCR',
  AUX: 'AUX',
  DISPLAY: 'Display',
  FM: 'FM',
  DAB: 'DAB',
  NET: 'Network',
  USB: 'USB',
  STB: 'STB',
  GAME: 'Game',
  PHONO: 'Phono',
  ARC_ERC: 'ARC / eARC',
  UHD: 'UHD',
  BT: 'Bluetooth',
  DIG1: 'Digital 1',
  DIG2: 'Digital 2',
  DIG3: 'Digital 3',
  DIG4: 'Digital 4',
});

/** Source -> state byte of CURRENT_SOURCE (0x1D), per family (zone 1). */
const DEFAULT_SOURCE_BYTES = {
  CD: 0x01,
  BD: 0x02,
  AV: 0x03,
  SAT: 0x04,
  PVR: 0x05,
  VCR: 0x06,
  AUX: 0x08,
  DISPLAY: 0x09,
  FM: 0x0b,
  DAB: 0x0c,
  NET: 0x0e,
  USB: 0x0f,
  STB: 0x10,
  GAME: 0x11,
  PHONO: 0x12,
  ARC_ERC: 0x13,
};
const SOURCE_BYTES = {
  [FAMILY.A450]: DEFAULT_SOURCE_BYTES,
  [FAMILY.A860]: DEFAULT_SOURCE_BYTES,
  [FAMILY.HDA]: {
    CD: 0x01,
    BD: 0x02,
    AV: 0x03,
    SAT: 0x04,
    PVR: 0x05,
    UHD: 0x06,
    AUX: 0x08,
    DISPLAY: 0x09,
    FM: 0x0b,
    DAB: 0x0c,
    NET: 0x0e,
    USB: 0x0f,
    STB: 0x10,
    GAME: 0x11,
    BT: 0x12,
  },
  // NET and USB share 0x0B on the SA series: the state reads as NET.
  [FAMILY.SA]: {
    PHONO: 0x01,
    AUX: 0x02,
    PVR: 0x03,
    AV: 0x04,
    STB: 0x05,
    CD: 0x06,
    BD: 0x07,
    SAT: 0x08,
    GAME: 0x09,
    NET: 0x0b,
    USB: 0x0b,
    ARC_ERC: 0x0d,
  },
  // 0x05 is "NET / USB" on the ST60: not one of the selectable sources.
  [FAMILY.ST]: { DIG1: 0x01, DIG2: 0x02, DIG3: 0x03, DIG4: 0x04 },
};

/** Source -> RC5 code that selects it (zone 1), for the families without a direct write. */
const RC5_SOURCE = {
  [FAMILY.A450]: {
    STB: [16, 1],
    AV: [16, 2],
    DAB: [16, 72],
    FM: [16, 54],
    BD: [16, 4],
    GAME: [16, 5],
    VCR: [16, 6],
    CD: [16, 7],
    AUX: [16, 8],
    DISPLAY: [16, 9],
    SAT: [16, 0],
    PVR: [16, 34],
    USB: [16, 18],
    NET: [16, 11],
  },
  [FAMILY.A860]: {
    STB: [16, 100],
    AV: [16, 94],
    DAB: [16, 72],
    FM: [16, 28],
    BD: [16, 98],
    GAME: [16, 97],
    VCR: [16, 119],
    CD: [16, 118],
    AUX: [16, 99],
    DISPLAY: [16, 58],
    SAT: [16, 27],
    PVR: [16, 96],
    USB: [16, 93],
    NET: [16, 92],
  },
  [FAMILY.HDA]: {
    STB: [16, 100],
    AV: [16, 94],
    DAB: [16, 72],
    FM: [16, 28],
    BD: [16, 98],
    GAME: [16, 97],
    UHD: [16, 125],
    CD: [16, 118],
    AUX: [16, 99],
    DISPLAY: [16, 58],
    SAT: [16, 27],
    PVR: [16, 96],
    NET: [16, 92],
    BT: [16, 122],
  },
  [FAMILY.SA]: {
    PHONO: [16, 117],
    CD: [16, 118],
    BD: [16, 98],
    SAT: [16, 27],
    PVR: [16, 96],
    AV: [16, 94],
    AUX: [16, 99],
    STB: [16, 100],
    NET: [16, 92],
    USB: [16, 93],
    GAME: [16, 97],
    ARC_ERC: [16, 125],
  },
  [FAMILY.ST]: {
    DIG1: [21, 94],
    DIG2: [21, 98],
    DIG3: [21, 27],
    DIG4: [21, 97],
    USB: [21, 93],
    NET: [21, 92],
  },
};

/** The selectable sources of a family, in the order of arcam-fmj (`get_source_list`). */
export const sourcesOf = (family) => Object.keys(RC5_SOURCE[family] ?? {});

/** The source name of a CURRENT_SOURCE state, or undefined. */
export function decodeSource(family, data) {
  const byte = singleByte(data);
  if (byte === undefined) {
    return undefined;
  }
  const table = SOURCE_BYTES[family] ?? {};
  return Object.keys(table).find((name) => table[name] === byte);
}

// --- Decode modes (the audio mode) --------------------------------------------------

const MODES_2CH = {
  STEREO: 0x01,
  DOLBY_PLII_IIX_MOVIE: 0x02,
  DOLBY_PLII_IIX_MUSIC: 0x03,
  DOLBY_SURROUND: 0x04,
  DOLBY_PLII_IIX_GAME: 0x05,
  DOLBY_PL: 0x06,
  DTS_NEO_6_CINEMA: 0x07,
  DTS_NEO_6_MUSIC: 0x08,
  MCH_STEREO: 0x09,
  DTS_NEURAL_X: 0x0a,
  DTS_VIRTUAL_X: 0x0c,
  DOLBY_VIRTUAL_HEIGHT: 0x0d,
  AURO_NATIVE: 0x0e,
  AURO_MATIC_3D: 0x0f,
  AURO_2D: 0x10,
};
const MODES_MCH = {
  STEREO_DOWNMIX: 0x01,
  MULTI_CHANNEL: 0x02,
  DOLBY_D_EX_OR_DTS_ES: 0x03,
  DOLBY_PLII_IIX_MOVIE: 0x04,
  DOLBY_PLII_IIX_MUSIC: 0x05,
  DOLBY_SURROUND: 0x06,
  DTS_VIRTUAL_X: 0x0c,
  DOLBY_VIRTUAL_HEIGHT: 0x0d,
  AURO_NATIVE: 0x0e,
  AURO_MATIC_3D: 0x0f,
  AURO_2D: 0x10,
};

const MODE_LABELS = {
  STEREO: 'Stereo',
  DOLBY_PLII_IIX_MOVIE: 'Dolby PLII/IIx Movie',
  DOLBY_PLII_IIX_MUSIC: 'Dolby PLII/IIx Music',
  DOLBY_SURROUND: 'Dolby Surround',
  DOLBY_PLII_IIX_GAME: 'Dolby PLII/IIx Game',
  DOLBY_PL: 'Dolby Pro Logic',
  DTS_NEO_6_CINEMA: 'DTS Neo:6 Cinema',
  DTS_NEO_6_MUSIC: 'DTS Neo:6 Music',
  MCH_STEREO: 'Multi-channel stereo',
  DTS_NEURAL_X: 'DTS Neural:X',
  DTS_VIRTUAL_X: 'DTS Virtual:X',
  DOLBY_VIRTUAL_HEIGHT: 'Dolby Virtual Height',
  AURO_NATIVE: 'Auro Native',
  AURO_MATIC_3D: 'Auro-Matic 3D',
  AURO_2D: 'Auro 2D',
  STEREO_DOWNMIX: 'Stereo downmix',
  MULTI_CHANNEL: 'Multi-channel',
  DOLBY_D_EX_OR_DTS_ES: 'Dolby D EX / DTS-ES',
};

/** Decode mode -> RC5 code (zone 1), per family: [2-channel table, multi-channel table]. */
const RC5_MODES = {
  [FAMILY.A450]: [
    {
      STEREO: [16, 107],
      DOLBY_PLII_IIX_MOVIE: [16, 103],
      DOLBY_PLII_IIX_MUSIC: [16, 104],
      DOLBY_PLII_IIX_GAME: [16, 102],
      DOLBY_PL: [16, 110],
      DTS_NEO_6_CINEMA: [16, 111],
      DTS_NEO_6_MUSIC: [16, 112],
      MCH_STEREO: [16, 69],
    },
    {
      STEREO_DOWNMIX: [16, 107],
      MULTI_CHANNEL: [16, 106],
      DOLBY_D_EX_OR_DTS_ES: [16, 118],
      DOLBY_PLII_IIX_MOVIE: [16, 103],
      DOLBY_PLII_IIX_MUSIC: [16, 104],
    },
  ],
  [FAMILY.A860]: [
    {
      STEREO: [16, 107],
      DTS_NEURAL_X: [16, 113],
      DTS_VIRTUAL_X: [16, 115],
      DOLBY_PL: [16, 110],
      DTS_NEO_6_CINEMA: [16, 111],
      DTS_NEO_6_MUSIC: [16, 112],
      MCH_STEREO: [16, 69],
    },
    {
      STEREO_DOWNMIX: [16, 107],
      MULTI_CHANNEL: [16, 106],
      // 0x03 is DTS Neural:X on the 860 and HDA series.
      DOLBY_D_EX_OR_DTS_ES: [16, 113],
      DOLBY_SURROUND: [16, 110],
      DTS_VIRTUAL_X: [16, 115],
    },
  ],
  [FAMILY.HDA]: [
    {
      STEREO: [16, 107],
      DOLBY_SURROUND: [16, 110],
      DTS_NEO_6_CINEMA: [16, 111],
      DTS_NEO_6_MUSIC: [16, 112],
      MCH_STEREO: [16, 69],
      DTS_NEURAL_X: [16, 113],
      DOLBY_VIRTUAL_HEIGHT: [16, 115],
      AURO_NATIVE: [16, 103],
      AURO_MATIC_3D: [16, 71],
      AURO_2D: [16, 104],
    },
    {
      STEREO_DOWNMIX: [16, 107],
      MULTI_CHANNEL: [16, 106],
      DOLBY_D_EX_OR_DTS_ES: [16, 113],
      DOLBY_SURROUND: [16, 110],
      DOLBY_VIRTUAL_HEIGHT: [16, 115],
      AURO_NATIVE: [16, 103],
      AURO_MATIC_3D: [16, 71],
      AURO_2D: [16, 104],
    },
  ],
};

const modeLabel = (family, name) =>
  name === 'DOLBY_D_EX_OR_DTS_ES' && family !== FAMILY.A450
    ? MODE_LABELS.DTS_NEURAL_X
    : MODE_LABELS[name];

/**
 * The audio mode options of a family: `2CH_<mode>` (stereo signals) then
 * `MCH_<mode>` (multi-channel signals), as the select values.
 */
export function audioModesOf(family) {
  const tables = RC5_MODES[family];
  if (!tables) {
    return [];
  }
  return [
    ...Object.keys(tables[0]).map((name) => ({
      value: `2CH_${name}`,
      label: `${modeLabel(family, name)} (2 ch)`,
    })),
    ...Object.keys(tables[1]).map((name) => ({
      value: `MCH_${name}`,
      label: `${modeLabel(family, name)} (multi-ch)`,
    })),
  ];
}

/** Incoming audio formats decoded as stereo (arcam-fmj `get_2ch`): PCM, analogue direct, undetected. */
const TWO_CHANNEL_FORMATS = new Set([0x00, 0x01, 0x15]);

/** Whether the incoming signal is 2-channel; an unknown format counts as 2-channel, as arcam-fmj. */
export const isTwoChannel = (format) => format === undefined || TWO_CHANNEL_FORMATS.has(format);

/** The audio mode value (`2CH_…` / `MCH_…`) of a decode mode state, or undefined. */
export function decodeAudioMode(twoChannel, data) {
  const byte = singleByte(data);
  if (byte === undefined) {
    return undefined;
  }
  const table = twoChannel ? MODES_2CH : MODES_MCH;
  const name = Object.keys(table).find((n) => table[n] === byte);
  return name === undefined ? undefined : `${twoChannel ? '2CH' : 'MCH'}_${name}`;
}

/** The RC5 code of an audio mode value for a family, or undefined. */
export function audioModeCode(family, value) {
  const tables = RC5_MODES[family];
  const match = /^(2CH|MCH)_([A-Z0-9_]{1,40})$/.exec(String(value));
  if (!tables || !match) {
    return undefined;
  }
  const table = tables[match[1] === '2CH' ? 0 : 1];
  return Object.hasOwn(table, match[2]) ? table[match[2]] : undefined;
}

// --- Commands ---------------------------------------------------------------------

/** One command frame. */
export function encodeCommand(zone, cc, data) {
  const bytes = [...data];
  if (bytes.length > 255) {
    throw new Error('Data too long');
  }
  return Buffer.from([STR, zone, cc, bytes.length, ...bytes, ETR]);
}

/** One answer frame (the fake device of the tests). */
export function encodeAnswer(zone, cc, ac, data) {
  const bytes = [...data];
  return Buffer.from([STR, zone, cc, ac, bytes.length, ...bytes, ETR]);
}

export const AMX_REQUEST = Buffer.from('AMX\r', 'ascii');

/**
 * The request that does what is asked on a family: `{ cc, data }`, or
 * undefined when the family cannot do it. `on` for power and mute is the
 * wanted state (mute: true mutes).
 */
export const REQUESTS = Object.freeze({
  power(family, on) {
    if (DIRECT_POWER_MUTE.has(family)) {
      return { cc: CC.POWER, data: [on ? 0x01 : 0x00] };
    }
    return { cc: CC.SIMULATE_RC5, data: on ? [16, 123] : [16, 124] };
  },
  mute(family, mute) {
    if (DIRECT_POWER_MUTE.has(family)) {
      // The MUTE byte is 0x00 for muted, 0x01 for not muted.
      return { cc: CC.MUTE, data: [mute ? 0x00 : 0x01] };
    }
    if (family === FAMILY.A450) {
      return { cc: CC.SIMULATE_RC5, data: mute ? [16, 119] : [16, 120] };
    }
    return { cc: CC.SIMULATE_RC5, data: mute ? [16, 26] : [16, 120] };
  },
  volume(family, volume) {
    return supports(family, CC.VOLUME) ? { cc: CC.VOLUME, data: [volume] } : undefined;
  },
  source(family, name) {
    if (family === FAMILY.SA) {
      const table = SOURCE_BYTES[FAMILY.SA];
      return Object.hasOwn(table, name)
        ? { cc: CC.CURRENT_SOURCE, data: [table[name]] }
        : undefined;
    }
    const table = RC5_SOURCE[family];
    return table && Object.hasOwn(table, name)
      ? { cc: CC.SIMULATE_RC5, data: table[name] }
      : undefined;
  },
  audioMode(family, value) {
    const code = audioModeCode(family, value);
    return code ? { cc: CC.SIMULATE_RC5, data: code } : undefined;
  },
});

// --- States --------------------------------------------------------------------------

function singleByte(data) {
  return data && data.length === 1 ? data[0] : undefined;
}

export function decodePower(data) {
  const byte = singleByte(data);
  return byte === 0x01 ? true : byte === 0x00 ? false : undefined;
}

export function decodeMute(data) {
  const byte = singleByte(data);
  // 0x00 muted, 0x01 not muted (arcam-fmj `get_mute`).
  return byte === 0x00 ? true : byte === 0x01 ? false : undefined;
}

export function decodeVolume(data) {
  const byte = singleByte(data);
  return byte !== undefined && byte <= 99 ? byte : undefined;
}

export function decodeFormat(data) {
  return data && data.length >= 1 && data.length <= 2 ? data[0] : undefined;
}

// --- Framing (untrusted input) ---------------------------------------------------------

/** Printable ASCII only, cut. */
export function cleanAscii(text, max) {
  if (typeof text !== 'string') {
    return undefined;
  }
  const clean = text
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, max);
  return clean === '' ? undefined : clean;
}

const AMX_TAG = /<([A-Za-z-]{1,40})=([^<>\r]{0,80})>/g;
const AMX_KEYS = {
  'Device-Make': 'make',
  'Device-Model': 'model',
  'Device-Revision': 'revision',
  'Device-SDKClass': 'sdkClass',
};

/** The fields of an AMX answer line (`AMXB<Key=Value>…`), only the known keys. */
export function parseAmx(line) {
  const info = {};
  for (const [, key, value] of line.slice(0, LIMITS.amx).matchAll(AMX_TAG)) {
    if (Object.hasOwn(AMX_KEYS, key)) {
      const clean = cleanAscii(value, LIMITS.name);
      if (clean !== undefined) {
        info[AMX_KEYS[key]] = clean;
      }
    }
  }
  return info;
}

/**
 * Cuts a byte stream into frames, as arcam-fmj `_read_delimited`, bounded and
 * linear: every byte is looked at a bounded number of times, a byte that
 * starts nothing known is skipped, a frame whose end byte is wrong is
 * dropped (the scan starts again one byte later), and more than
 * `LIMITS.buffer` bytes waiting means the peer is not an Arcam device.
 */
export class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.invalid = 0;
  }

  /**
   * @returns {Array<{ type: 'answer', zone: number, cc: number, ac: number, data: Buffer } | { type: 'amx', info: object }>}
   */
  push(chunk) {
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > LIMITS.buffer) {
      this.buffer = Buffer.alloc(0);
      throw new Error('Too many bytes without a frame');
    }
    const frames = [];
    const buf = this.buffer;
    let i = 0;
    while (i < buf.length) {
      const start = buf[i];
      if (start === STR) {
        if (buf.length - i < 6) {
          break;
        }
        const length = buf[i + 4];
        const total = 6 + length;
        if (buf.length - i < total) {
          break;
        }
        if (buf[i + total - 1] !== ETR) {
          this.invalid += 1;
          i += 1;
          continue;
        }
        frames.push({
          type: 'answer',
          zone: buf[i + 1],
          cc: buf[i + 2],
          ac: buf[i + 3],
          data: Buffer.from(buf.subarray(i + 5, i + 5 + length)),
        });
        i += total;
      } else if (start === 0x41 || start === 0x01) {
        // "AMX…\r", or "\x01^AMX…\r": the header is checked first, so a
        // stray byte never holds the frames behind it.
        const header = start === 0x01 ? '\x01^AMX' : 'AMX';
        const seen = buf.subarray(i, i + header.length).toString('latin1');
        if (!header.startsWith(seen)) {
          this.invalid += 1;
          i += 1;
          continue;
        }
        if (seen.length < header.length) {
          break;
        }
        const limit = i + LIMITS.amx;
        const found = buf.subarray(i, Math.min(buf.length, limit + 1)).indexOf(ETR);
        const end = found === -1 ? -1 : i + found;
        if (end === -1) {
          if (buf.length >= limit) {
            this.invalid += 1;
            i += 1;
            continue;
          }
          break;
        }
        const line = buf.subarray(start === 0x01 ? i + 2 : i, end).toString('latin1');
        if (line.startsWith('AMXB')) {
          frames.push({ type: 'amx', info: parseAmx(line.slice(4)) });
        }
        i = end + 1;
      } else {
        // 0x00 (sent by some devices) or junk.
        if (start !== 0x00) {
          this.invalid += 1;
        }
        i += 1;
      }
    }
    this.buffer = i >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(i));
    return frames;
  }
}

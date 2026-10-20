// -----------------------------------------------------------------------------
// The protocol port (src/arcam/protocol.js): framing of untrusted bytes,
// decoding, and the requests each model family needs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/constants.js';
import {
  ANSWER,
  CC,
  FAMILY,
  FrameParser,
  REQUESTS,
  audioModeCode,
  audioModesOf,
  decodeAudioMode,
  decodeMute,
  decodePower,
  decodeSource,
  decodeVolume,
  encodeAnswer,
  encodeCommand,
  familyOf,
  isTwoChannel,
  parseAmx,
  sourcesOf,
} from '../src/arcam/protocol.js';

test('a command frame: STR Zn Cc Dl Data ETR', () => {
  assert.deepEqual([...encodeCommand(1, CC.VOLUME, [0xf0])], [0x21, 0x01, 0x0d, 0x01, 0xf0, 0x0d]);
  assert.throws(() => encodeCommand(1, CC.VOLUME, new Array(256).fill(0)));
});

test('answers are framed across chunks, junk and wrong end bytes skipped', () => {
  const parser = new FrameParser();
  const frame = encodeAnswer(1, CC.VOLUME, ANSWER.OK, [42]);
  assert.deepEqual(parser.push(frame.subarray(0, 3)), []);
  const frames = parser.push(
    Buffer.concat([
      frame.subarray(3),
      Buffer.from([0x00, 0x99, 0x21, 0x01, 0x0e, 0x00, 0x01, 0x05, 0x07]),
      encodeAnswer(1, CC.MUTE, ANSWER.OK, [0]),
    ]),
  );
  assert.deepEqual(
    frames.map((f) => [f.type, f.cc, [...f.data]]),
    [
      ['answer', CC.VOLUME, [42]],
      ['answer', CC.MUTE, [0]],
    ],
  );
  assert.ok(parser.invalid > 0);
  assert.equal(parser.buffer.length, 0);
});

test('AMX answers, with or without the \\x01^ prefix; unknown keys dropped', () => {
  const parser = new FrameParser();
  const frames = parser.push(
    Buffer.concat([
      Buffer.from('AMXB<Device-Make=ARCAM><Device-Model=AVR20><Evil=1><Device-Revision=2.1>\r'),
      Buffer.from('\x01^AMXB<Device-Model=SA30>\r', 'latin1'),
      encodeAnswer(1, CC.POWER, ANSWER.OK, [1]),
    ]),
  );
  assert.deepEqual(frames[0], {
    type: 'amx',
    info: { make: 'ARCAM', model: 'AVR20', revision: '2.1' },
  });
  assert.deepEqual(frames[1].info, { model: 'SA30' });
  assert.equal(frames[2].cc, CC.POWER);
  assert.deepEqual(parseAmx('<__proto__=x><constructor=y>'), {});
  assert.equal(Object.getPrototypeOf(parseAmx('<Device-Model=AVR5>')), Object.prototype);
});

test('a stray "A" never holds the frames behind it', () => {
  const parser = new FrameParser();
  const frames = parser.push(
    Buffer.concat([Buffer.from('AB'), encodeAnswer(1, CC.POWER, ANSWER.OK, [1])]),
  );
  assert.equal(frames.length, 1);
});

test('bounded: too many bytes without a frame throws (the connection is closed)', () => {
  const parser = new FrameParser();
  // A header that announces data never sent, then more and more bytes.
  assert.deepEqual(parser.push(Buffer.from([0x21, 0x01, 0x00, 0x00, 0xff])), []);
  assert.throws(() => parser.push(Buffer.alloc(LIMITS.buffer, 0x21)));
  // An AMX line without its end is dropped after 512 bytes, linearly.
  const amx = new FrameParser();
  const frames = amx.push(
    Buffer.concat([
      Buffer.from('AMXB'),
      Buffer.alloc(600, 0x41),
      encodeAnswer(1, CC.POWER, ANSWER.OK, [0]),
    ]),
  );
  assert.deepEqual(
    frames.map((f) => f.type),
    ['answer'],
  );
});

test('states decoded strictly', () => {
  assert.equal(decodePower(Buffer.from([1])), true);
  assert.equal(decodePower(Buffer.from([0])), false);
  assert.equal(decodePower(Buffer.from([2])), undefined);
  assert.equal(decodePower(Buffer.from([1, 1])), undefined);
  assert.equal(decodeMute(Buffer.from([0])), true, '0x00 is muted');
  assert.equal(decodeMute(Buffer.from([1])), false);
  assert.equal(decodeVolume(Buffer.from([99])), 99);
  assert.equal(decodeVolume(Buffer.from([100])), undefined);
  assert.equal(decodeVolume(undefined), undefined);
  assert.equal(decodeSource(FAMILY.HDA, Buffer.from([0x06])), 'UHD');
  assert.equal(decodeSource(FAMILY.A860, Buffer.from([0x06])), 'VCR');
  assert.equal(decodeSource(FAMILY.SA, Buffer.from([0x0b])), 'NET');
  assert.equal(decodeSource(FAMILY.HDA, Buffer.from([0x7f])), undefined);
  assert.equal(decodeAudioMode(true, Buffer.from([0x01])), '2CH_STEREO');
  assert.equal(decodeAudioMode(false, Buffer.from([0x02])), 'MCH_MULTI_CHANNEL');
  assert.equal(decodeAudioMode(false, Buffer.from([0x7f])), undefined);
  assert.equal(isTwoChannel(0x00), true);
  assert.equal(isTwoChannel(undefined), true);
  assert.equal(isTwoChannel(0x16), false, 'Dolby Atmos');
});

test('families: the model of the AMX answer, the 450 series for an unknown one', () => {
  assert.equal(familyOf('AVR20'), FAMILY.HDA);
  assert.equal(familyOf('SA30'), FAMILY.SA);
  assert.equal(familyOf('PA720'), FAMILY.PA);
  assert.equal(familyOf('ST60'), FAMILY.ST);
  assert.equal(familyOf('AV860'), FAMILY.A860);
  assert.equal(familyOf(undefined), FAMILY.A450);
  assert.equal(familyOf('__proto__'), FAMILY.A450);
});

test('requests: direct writes on SA/PA/ST, RC5 codes on the AVRs', () => {
  assert.deepEqual(REQUESTS.power(FAMILY.HDA, true), { cc: CC.SIMULATE_RC5, data: [16, 123] });
  assert.deepEqual(REQUESTS.power(FAMILY.HDA, false), { cc: CC.SIMULATE_RC5, data: [16, 124] });
  assert.deepEqual(REQUESTS.power(FAMILY.SA, true), { cc: CC.POWER, data: [1] });
  assert.deepEqual(REQUESTS.mute(FAMILY.SA, true), { cc: CC.MUTE, data: [0] });
  assert.deepEqual(REQUESTS.mute(FAMILY.A450, true), { cc: CC.SIMULATE_RC5, data: [16, 119] });
  assert.deepEqual(REQUESTS.mute(FAMILY.HDA, true), { cc: CC.SIMULATE_RC5, data: [16, 26] });
  assert.deepEqual(REQUESTS.mute(FAMILY.HDA, false), { cc: CC.SIMULATE_RC5, data: [16, 120] });
  assert.deepEqual(REQUESTS.volume(FAMILY.ST, 20), { cc: CC.VOLUME, data: [20] });
  assert.equal(REQUESTS.volume(FAMILY.PA, 20), undefined, 'no volume on a power amplifier');
  assert.deepEqual(REQUESTS.source(FAMILY.SA, 'PHONO'), { cc: CC.CURRENT_SOURCE, data: [1] });
  assert.deepEqual(REQUESTS.source(FAMILY.HDA, 'BT'), { cc: CC.SIMULATE_RC5, data: [16, 122] });
  assert.equal(REQUESTS.source(FAMILY.HDA, 'PHONO'), undefined);
  assert.equal(REQUESTS.source(FAMILY.PA, 'CD'), undefined);
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.equal(REQUESTS.source(FAMILY.HDA, key), undefined, key);
    assert.equal(REQUESTS.audioMode(FAMILY.HDA, `2CH_${key}`), undefined, key);
  }
});

test('the dropdowns of each family', () => {
  assert.ok(sourcesOf(FAMILY.HDA).includes('UHD'));
  assert.ok(sourcesOf(FAMILY.SA).includes('PHONO'));
  assert.deepEqual(sourcesOf(FAMILY.PA), []);
  const modes = audioModesOf(FAMILY.HDA);
  assert.ok(modes.some((m) => m.value === '2CH_STEREO' && m.label === 'Stereo (2 ch)'));
  assert.ok(modes.some((m) => m.value === 'MCH_DOLBY_D_EX_OR_DTS_ES' && /Neural:X/.test(m.label)));
  assert.ok(
    audioModesOf(FAMILY.A450).some(
      (m) => m.value === 'MCH_DOLBY_D_EX_OR_DTS_ES' && /EX/.test(m.label),
    ),
  );
  assert.deepEqual(audioModesOf(FAMILY.SA), []);
  assert.deepEqual(audioModeCode(FAMILY.HDA, 'MCH_MULTI_CHANNEL'), [16, 106]);
  assert.equal(audioModeCode(FAMILY.HDA, 'nope'), undefined);
  for (const option of [...modes, ...sourcesOf(FAMILY.HDA).map((value) => ({ value }))]) {
    assert.match(option.value, /^[A-Z0-9][A-Z0-9_]{0,47}$/);
  }
});

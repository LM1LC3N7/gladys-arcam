// -----------------------------------------------------------------------------
// A fake Arcam device on 127.0.0.1 (a random port): the AMX answer, the
// state reads of zone 1, the direct writes and the RC5 codes the
// integration sends, the pushed updates, a standby that refuses the reads, a
// silent mode and raw bytes for the hostile input tests.
// -----------------------------------------------------------------------------

import net from 'node:net';
import {
  ANSWER,
  CC,
  ETR,
  FAMILY,
  QUERY,
  REQUESTS,
  STR,
  audioModesOf,
  decodeSource,
  encodeAnswer,
  familyOf,
  sourcesOf,
} from '../../src/arcam/protocol.js';

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function startFakeDevice({
  model = 'AVR20',
  port = 0,
  amx = true,
  silent = false,
  delays = {},
  silentCodes = [],
  refuse = [],
  bootMs = 0,
  state: initial = {},
} = {}) {
  const family = familyOf(model);
  const state = {
    power: 1,
    volume: 30,
    // MUTE byte: 0x00 muted, 0x01 not muted.
    mute: 0x01,
    source: 'BD',
    format: 0x00,
    mode2ch: 0x01,
    modeMch: 0x02,
    ...initial,
  };
  const sourceByte = (name) => {
    for (let b = 0; b < 0x20; b += 1) {
      if (decodeSource(family, [b]) === name) {
        return b;
      }
    }
    return 0xff;
  };
  const sockets = new Set();
  const commands = [];
  let connections = 0;

  const valueOf = (cc) => {
    switch (cc) {
      case CC.POWER:
        return [state.power];
      case CC.VOLUME:
        return [state.volume];
      case CC.MUTE:
        return [state.mute];
      case CC.CURRENT_SOURCE:
        return [sourceByte(state.source)];
      case CC.INCOMING_AUDIO_FORMAT:
        return [state.format, 0x00];
      case CC.DECODE_MODE_2CH:
        return [state.mode2ch];
      case CC.DECODE_MODE_MCH:
        return [state.modeMch];
      default:
        return undefined;
    }
  };

  const broadcast = (bytes) => {
    for (const socket of sockets) {
      socket.write(bytes);
    }
  };
  const push = (cc) => broadcast(encodeAnswer(1, cc, ANSWER.OK, valueOf(cc)));

  function rc5(code) {
    const is = (request) => request && sameBytes(request.data, code);
    if (is(REQUESTS.power(family, true))) {
      state.power = 1;
      return [CC.POWER];
    }
    if (is(REQUESTS.power(family, false))) {
      state.power = 0;
      return [CC.POWER];
    }
    if (is(REQUESTS.mute(family, true))) {
      state.mute = 0x00;
      return [CC.MUTE];
    }
    if (is(REQUESTS.mute(family, false))) {
      state.mute = 0x01;
      return [CC.MUTE];
    }
    for (const name of sourcesOf(family)) {
      if (is(REQUESTS.source(family, name))) {
        state.source = name;
        return [CC.CURRENT_SOURCE];
      }
    }
    for (const { value } of audioModesOf(family)) {
      if (is(REQUESTS.audioMode(family, value))) {
        const twoChannel = value.startsWith('2CH_');
        const byte = { STEREO: 0x01, DTS_NEURAL_X: 0x0a, MULTI_CHANNEL: 0x02 }[value.slice(4)];
        if (twoChannel) {
          state.mode2ch = byte ?? 0x09;
          return [CC.DECODE_MODE_2CH];
        }
        state.modeMch = byte ?? 0x06;
        return [CC.DECODE_MODE_MCH];
      }
    }
    return undefined;
  }

  function handle(socket, zone, cc, data) {
    commands.push({ zone, cc, data: [...data], at: Date.now() });
    if (fake.silent || fake.silentCodes.has(cc)) {
      return;
    }
    const delay = fake.delays[cc] ?? 0;
    if (delay > 0) {
      setTimeout(() => {
        if (!socket.destroyed) {
          respond(socket, zone, cc, data);
        }
      }, delay);
      return;
    }
    respond(socket, zone, cc, data);
  }

  function respond(socket, zone, cc, data) {
    const answer = (ac, bytes) => socket.write(encodeAnswer(zone, cc, ac, bytes));
    if (data.length === 1 && data[0] === QUERY && fake.refuse.has(cc)) {
      answer(ANSWER.COMMAND_INVALID_AT_THIS_TIME, []);
      return;
    }
    if (
      cc === CC.SIMULATE_RC5 &&
      fake.bootMs > 0 &&
      sameBytes(REQUESTS.power(family, true).data, [...data])
    ) {
      // A slow wake-up: the code is acknowledged now, the power comes later.
      answer(ANSWER.OK, data);
      setTimeout(() => {
        state.power = 1;
        push(CC.POWER);
      }, fake.bootMs);
      return;
    }
    if (zone !== 1) {
      answer(ANSWER.ZONE_INVALID, []);
      return;
    }
    if (data.length === 1 && data[0] === QUERY) {
      const value = valueOf(cc);
      if (value === undefined) {
        answer(ANSWER.COMMAND_NOT_RECOGNISED, []);
      } else if (state.power === 0 && cc !== CC.POWER && cc !== CC.MUTE) {
        answer(ANSWER.COMMAND_INVALID_AT_THIS_TIME, []);
      } else {
        answer(ANSWER.OK, value);
      }
      return;
    }
    if (cc === CC.SIMULATE_RC5) {
      const changed = rc5(data);
      if (!changed) {
        answer(ANSWER.PARAMETER_NOT_RECOGNISED, []);
        return;
      }
      answer(ANSWER.OK, data);
      changed.forEach(push);
      return;
    }
    if (cc === CC.VOLUME && data.length === 1) {
      if (state.power === 0) {
        answer(ANSWER.COMMAND_INVALID_AT_THIS_TIME, []);
        return;
      }
      state.volume = data[0];
      answer(ANSWER.OK, valueOf(CC.VOLUME));
      return;
    }
    if ((cc === CC.POWER || cc === CC.MUTE) && family !== FAMILY.HDA && data.length === 1) {
      if (cc === CC.POWER) {
        state.power = data[0];
      } else {
        state.mute = data[0];
      }
      answer(ANSWER.OK, valueOf(cc));
      return;
    }
    if (cc === CC.CURRENT_SOURCE && family === FAMILY.SA && data.length === 1) {
      state.source = decodeSource(family, data) ?? state.source;
      answer(ANSWER.OK, valueOf(cc));
      return;
    }
    answer(ANSWER.COMMAND_NOT_RECOGNISED, []);
  }

  function attach(socket) {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === 'AMX\r') {
          buffer = buffer.subarray(4);
          if (fake.amx && !fake.silent) {
            socket.write(
              `AMXB<Device-SDKClass=Receiver><Device-Make=ARCAM><Device-Model=${model}><Device-Revision=2.1.0>\r`,
            );
          }
          continue;
        }
        if (buffer.length >= 5 && buffer[0] === STR) {
          const total = 5 + buffer[3];
          if (buffer.length < total) {
            return;
          }
          if (buffer[total - 1] === ETR) {
            handle(socket, buffer[1], buffer[2], buffer.subarray(4, total - 1));
          }
          buffer = buffer.subarray(total);
          continue;
        }
        if (buffer.length > 0 && buffer[0] !== STR && buffer[0] !== 0x41) {
          buffer = buffer.subarray(1);
          continue;
        }
        return;
      }
    });
  }

  const server = net.createServer(attach);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const fake = {
    port: server.address().port,
    state,
    commands,
    amx,
    silent,
    /** cc -> answer delay in ms */
    delays: { ...delays },
    /** codes never answered */
    silentCodes: new Set(silentCodes),
    /** codes whose read is refused (invalid at this time) */
    refuse: new Set(refuse),
    /** > 0: the RC5 power on is acknowledged, the power turns on this much later */
    bootMs,
    connections: () => connections,
    /** Changes a state on the device (front panel, remote) and pushes it. */
    change(cc, field, value) {
      state[field] = value;
      push(cc);
    },
    /** Raw bytes to every connection. */
    broadcast,
    /** Closes every connection (the server keeps listening). */
    drop() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}

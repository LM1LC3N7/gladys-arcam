// -----------------------------------------------------------------------------
// One session (src/arcam/connection.js) on a fake socket: the deadline of a
// request waiting behind another one, the late answers, and the commands
// going before the reads waiting.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ERROR_KINDS, Session } from '../src/arcam/connection.js';
import { ANSWER, encodeAnswer } from '../src/arcam/protocol.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.written = [];
  }

  write(bytes) {
    this.written.push([...bytes]);
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  setNoDelay() {}
}

const answer = (socket, cc, data) => socket.emit('data', encodeAnswer(1, cc, ANSWER.OK, data));

test('a request waiting behind a silent one is dropped at its own deadline, never written', async (t) => {
  const socket = new FakeSocket();
  const session = new Session(socket);
  t.after(() => session.close());
  session.request(1, 0x43, [0xf0], 1_500).catch(() => {});
  let written = false;
  const started = Date.now();
  const err = await session
    .request(1, 0x0d, [40], 300, { urgent: true, onWrite: () => (written = true) })
    .then(
      () => undefined,
      (e) => e,
    );
  assert.equal(err.kind, ERROR_KINDS.BUDGET);
  assert.match(err.message, /nothing sent/);
  assert.ok(Date.now() - started < 700, `dropped at its deadline (${Date.now() - started} ms)`);
  assert.equal(written, false, 'never marked as written');
  assert.equal(socket.written.length, 1, 'only the read on the wire was written');
});

test('the late answer of a request that timed out never answers the next one', async (t) => {
  const socket = new FakeSocket();
  const session = new Session(socket);
  t.after(() => session.close());
  const first = await session.request(1, 0x0d, [0xf0], 50).then(
    () => undefined,
    (e) => e,
  );
  assert.equal(first.kind, ERROR_KINDS.TIMEOUT);
  assert.equal(first.sent, true);
  const second = session.request(1, 0x0d, [0xf0], 1_000);
  answer(socket, 0x0d, [11]); // the late answer of the first request
  answer(socket, 0x0d, [22]);
  assert.deepEqual([...(await second)], [22]);
});

test('commands go before the reads waiting, after the other commands', async (t) => {
  const socket = new FakeSocket();
  const session = new Session(socket);
  t.after(() => session.close());
  const onWire = session.request(1, 0x43, [0xf0], 1_000);
  const read = session.request(1, 0x10, [0xf0], 1_000);
  const command1 = session.request(1, 0x0e, [0], 1_000, { urgent: true });
  const command2 = session.request(1, 0x08, [16, 124], 1_000, { urgent: true });
  answer(socket, 0x43, [0, 0]);
  await onWire;
  answer(socket, 0x0e, [0]);
  await command1;
  answer(socket, 0x08, [16, 124]);
  await command2;
  answer(socket, 0x10, [1]);
  await read;
  assert.deepEqual(
    socket.written.map((frame) => frame[2]),
    [0x43, 0x0e, 0x08, 0x10],
  );
});

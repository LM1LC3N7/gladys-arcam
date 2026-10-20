import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress, parseMaxVolume, platformId } from '../src/config.js';
import { MAX_VOLUME } from '../src/constants.js';

test('the defaults: no address, the default cap', () => {
  assert.deepEqual(normalizeConfig(), {
    addresses: [],
    invalid: [],
    maxVolume: MAX_VOLUME.default,
  });
});

test('addresses: IPv4 or host name, port 50000 by default, duplicates and junk set aside', () => {
  const config = normalizeConfig({
    addresses: '192.168.1.40, 192.168.1.40:50000; avr.local:6000 tcp://10.0.0.2/x nope! 999.1.1.1',
  });
  assert.deepEqual(config.addresses, [
    { host: '192.168.1.40', port: 50000 },
    { host: 'avr.local', port: 6000 },
    { host: '10.0.0.2', port: 50000 },
  ]);
  assert.deepEqual(config.invalid, ['nope!', '999.1.1.1']);
  assert.equal(parseAddress(''), undefined);
  assert.equal(parseAddress('host:0'), undefined);
  assert.equal(parseAddress('host:70000'), undefined);
  assert.equal(parseAddress('[::1]'), undefined);
});

test('the platform id of an address is stable and has no separator of the external ids', () => {
  assert.equal(platformId({ host: '192.168.1.40', port: 50000 }), '192.168.1.40_50000');
  assert.ok(!platformId({ host: 'avr.local', port: 6000 }).includes(':'));
});

test('the volume cap: an integer 1..99, the default for anything unreadable', () => {
  assert.equal(parseMaxVolume('30'), 30);
  assert.equal(parseMaxVolume(12.6), 13);
  assert.equal(parseMaxVolume(0), 1);
  assert.equal(parseMaxVolume(150), 99);
  for (const bad of [null, undefined, '', ' ', 'abc', true, NaN]) {
    assert.equal(parseMaxVolume(bad), MAX_VOLUME.default, String(bad));
  }
});

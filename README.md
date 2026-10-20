# gladys-arcam

[Gladys Assistant](https://gladysassistant.com) external integration for
**Arcam** AV receivers, processors and amplifiers, on the local network:
power on, standby, volume (capped by an option), mute, source and audio mode
of zone 1, through the IP control of the devices (TCP port 50000), without
any cloud. Unofficial, not affiliated with Arcam.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake device only,
> never with a real Arcam device.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (ArcamApp)
                                   ├─ src/arcam/link.js        one address: TCP, AMX model, state of zone 1, heartbeat, spaced reconnection
                                   ├─ src/arcam/connection.js  one session: one request at a time, answers matched by zone and code
                                   ├─ src/arcam/protocol.js    frames, codes, model families, sources, decode modes, RC5 codes (ported)
                                   ├─ src/model.js             known devices -> Gladys devices and states (pure)
                                   └─ src/store.js             /data/arcam.json: known devices, their model and options
```

- **Devices** are added by IP address (configuration), or found with
  `gladys.scanNetwork('ssdp')` (search target
  `urn:schemas-upnp-org:device:MediaRenderer:1`, optional: a failure never
  blocks), each local address that answers being asked on port 50000. The
  protocol gives no serial number: a device is identified by its address
  (external id `arcam:<host>_<port>`).
- **One TCP connection per address**, kept open: on connection the model is
  asked (AMX), then the state of zone 1 (power, volume, mute, source,
  incoming audio format, decode modes); every pushed update is published
  (grouped, at most once a second per device). The power is asked every 10
  s; no frame at all in 25 s closes the connection. The full state is read
  again every 5 minutes and after the device turned on. Reconnection after
  10 s, then doubled after each failure up to 5 minutes; the count is only
  reset by a connection that stayed up one minute.
- **Commands**: validated first (volume an integer 0..99, source and audio
  mode among the dropdown options), the volume capped by `max_volume` (read
  just before sending), serialized per device, each within a 3.5 s budget
  (Gladys acks in 5 s), dropped when they cannot start in time. Direct writes
  on the SA, ST and PA series, RC5 codes on the AVRs, as arcam-fmj. Mute is a
  press: the state is read just before and the explicit code sent; unmuting
  (and Power on) first brings a volume above the cap back to it. The audio
  mode is checked against the incoming signal read just before. Standby and
  mute go before the commands waiting. A frame that may have reached the
  device is reported "sent, without confirmation".
- **Features**: `music/volume` like the core Sonos service,
  `television/volume-mute`, `text/select` (source, audio mode), `button/push`
  (power on, standby) and a read-only `unknown/binary` power state. No
  switch.
- **Bounded input**: 4 KB waiting to be framed at most, frames cut linearly
  (a byte that starts nothing known is skipped), an AMX line 512 bytes at
  most and only its known keys kept, 32 requests waiting at most, more than
  300 frames in 10 s closes the connection.

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake device)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeArcam.js` is a fake Arcam device on 127.0.0.1 (AMX, state
reads, direct writes and RC5 codes, pushed updates, standby, silent mode).
The end-to-end tests run the real handlers against the SDK's fake Gladys.

## Credits

- [`arcam-fmj`](https://github.com/elupus/arcam_fmj) 3.0.1.post1 by Joakim
  Plate (MIT), the library behind the Home Assistant Arcam FMJ integration:
  the protocol, codes, tables and client behaviour are ported from it to
  JavaScript.
- The Home Assistant Arcam FMJ integration (Apache-2.0) was consulted for the
  discovery and the volume scale.
- The app structure follows
  [LM1LC3N7/gladys-cambridge-audio](https://github.com/LM1LC3N7/gladys-cambridge-audio)
  and [LM1LC3N7/gladys-denon-avr](https://github.com/LM1LC3N7/gladys-denon-avr)
  (same author, Apache-2.0).

Arcam is a trademark of its owner, used here only to name the compatible
products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (arcam-fmj, MIT):
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

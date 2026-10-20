# TODO — Arcam v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control of zone 1** (2026-10-20): devices added
      by IP address or found by SSDP (`scanNetwork('ssdp')`, optional, then
      a probe on port 50000); one persistent TCP connection per address with
      the AMX model, the state of zone 1, pushed updates, heartbeat and
      spaced reconnection; power state, power on, standby, volume capped by
      `max_volume`, mute, source and audio mode dropdowns; "Find" and
      "Check" buttons; docs en/fr. Tested against a fake device on the
      loopback interface only, never with a real device. The store validator
      could not be run from the development session (no access to it there):
      to run before the first release.
- [ ] **Milestone 2 — real devices** (testers with an AVR, SA or ST). To
      check first:
  - whether the device accepts more than one IP control client at a time
    (the integration keeps one connection open);
  - the AMX answer of each model (`Device-Model` as in the tables of
    arcam-fmj), and what a device without it answers;
  - the pushed updates (which codes, also in standby), and what is refused
    in standby with the network on;
  - the volume scale (0..99 on the AVRs and SA, other ranges?) and whether a
    "maximum volume" set on the device answers the volume write;
  - the answer to an RC5 code (`0x08`): the code echoed, or nothing;
  - the SSDP answers of each model (`MediaRenderer:1`), and whether the
    UPnP description (`http://<ip>:8080/dd.xml`, as Home Assistant) could
    give a stable id (see Decisions: the address is the id today);
  - the rendering on the Gladys dashboard (not checked here): the two
    `button/push`, the `television/volume-mute` press, the two
    `text/select`, the `unknown/binary` power.
- [ ] **Milestone 3 — more**: zone 2 (a second Gladys device), the radio
      (presets, DAB station, RDS), volume up/down buttons (capped), the
      incoming audio format as a text, the "Network / USB" source of the
      ST60, a "forget a device" action.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: elupus/arcam_fmj `arcam-fmj` 3.0.1.post1 (MIT, PyPI release of
  2026-10-11, the library of the Home Assistant Arcam FMJ integration;
  LICENSE file read: MIT, Joakim Plate) is Python (asyncio), so its framing,
  codes, model families, source and decode mode tables, RC5 codes and client
  behaviour (one request at a time, answers matched by zone and code, the
  power as heartbeat) are ported to JavaScript (`src/arcam/`); MIT notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image. No runtime dependency but
  the SDK (`node:net`).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- **Identity: the address.** The Arcam protocol has no serial number; Home
  Assistant reads the UPnP description on port 8080 for one, which would add
  an HTTP/XML client and an id that may change between two answers. v1:
  `gladys.externalIds('arcam', '<host>_<port>')`, documented ("fixed IP
  address"; a new address gives a new device). Feature keys are frozen:
  `power`, `power_on`, `standby`, `volume`, `mute`, `source`, `audio_mode`;
  option values too (`BD`, `UHD`…, `2CH_STEREO`, `MCH_MULTI_CHANNEL`…).
  Every publication carries the full, fixed feature list (a device published
  again never loses a feature), the same for every model (an amplifier has
  an empty "Audio mode" dropdown); only the options grow (merged with the
  `supported_options` of the created device).
- **Power: read-only state + two `button/push` ("Power on", "Standby"), not a
  `switch`.** Lesson of lot 6: an "everything on / off" (voice assistants,
  `switch.*` scenes) must not wake an amplifier up nor cut it. The power state
  is `unknown/binary`, read only (0 also when the device does not answer
  after a failed connection attempt, not on a simple drop). Standby on a
  device that is not connected is an error ("… nothing sent"), never a
  success.
- **Volume cap** (`max_volume`, 1..99, default 40 on the 0..99 display
  scale): a higher volume asked from Gladys is set to the cap (clamped,
  logged), not refused, so a scene "volume 80" still does something. The cap
  is read inside the queued task, just before the frame leaves. The feature
  range stays 0..99 (frozen at creation). A volume set on the device itself
  above the cap is shown, not lowered, except by the two commands of Gladys
  that would make it heard: unmute (the volume read just before decides;
  above the cap, the volume is set to the cap first; unknown: refused,
  nothing sent) and Power on (power and volume read again after the
  wake-up, then every 2.5 s, 6 times at most, one chain per device, through
  the device queue; the ack never depends on it). A PA power amplifier has
  no volume: refused, nothing sent. Default 40 rather than 50: the scale is
  steps of the device, not a percentage, and an AVR at 50 is loud.
- Volume validated strictly before queueing: an integer 0..99 as a number or
  a string of digits; null, '', booleans, 12.5, '12abc', NaN refused.
- Mute is a push: the MUTE state is read just before (1.2 s at most) and the
  explicit code sent (direct write 0x00/0x01 on SA/PA/ST, RC5 mute on / mute
  off on the AVRs), never a toggle. Unknown mute state: nothing sent.
- Model families (`familyOf`): from the AMX `Device-Model`, the 450 series
  for an unknown model as arcam-fmj; the model is saved in `/data` and used
  when the AMX request gets no answer. Direct writes of power and mute on
  SA/PA/ST, of the source on SA; RC5 codes otherwise (zone 1 tables of
  arcam-fmj).
- Source: the select values are the source names of arcam-fmj
  (`get_source_list`: the RC5 table of the family), labels readable names.
  The state maps the CURRENT_SOURCE byte with the family table; on the SA
  series NET and USB share 0x0B (shown as NET); the ST60 "NET / USB" (0x05)
  is not one of its selectable sources and is not published.
- Audio mode: both decode mode tables of the family as one select
  (`2CH_…` and `MCH_…`), the state from the table matching the incoming
  audio format (PCM, analogue direct, undetected or unknown: 2-channel, as
  arcam-fmj `get_2ch`). A command reads the incoming audio format again just
  before, and a mode of the other kind is refused, nothing sent.
- Bluetooth: "BT" is an input of the HDA receivers selected by an RC5 code;
  the integration itself uses no Bluetooth.
- Commands: serialized per device, budget 3.5 s from the Gladys request (the
  wait in the queue included), each request bounded by what is left; a
  command still queued at its deadline is dropped, never sent late. Inside
  the connection, one request on the wire at a time, commands before the
  state reads waiting. A frame that may have reached the device (sent, then
  no answer or connection closed) is answered "sent, without confirmation";
  a device that is not connected gets "nothing sent"; an answer code of the
  device is answered "Refused by the device: <reason>". Standby and Mute go
  before the commands still waiting (after the other urgent ones).
- Late answers: after a request timed out, the first answer with its zone
  and code within 2 s is not taken as the answer of the next request (it
  still updates the state, being what the device says). Known limit of the
  protocol (answers matched by zone and code only, as arcam-fmj): a pushed
  update with the code of the request on the wire settles it.
- Connection: one TCP connection per address (typed addresses and known
  devices), kept across reconnections to Gladys (`connected` only clears the
  status cache and `forgetPublishedStates`, then republishes the status, the
  devices and the states). On connection: AMX (2 s), then the power, which
  must be answered in the Arcam framing (else "Not an Arcam device"), then
  the other states of zone 1 the family knows. Heartbeat: the power every
  10 s (arcam-fmj: 5 s; slower here), no frame at all within 25 s closes the
  connection; the full state read again every 5 minutes, and 1.5 s after the
  power turned on (what standby refused). Reconnection after 10 s, doubled
  after each failure up to 5 minutes; the count is only reset by a
  connection that stayed up 60 s. A configuration save or a search asks for
  a reconnection, but never sooner than 10 s after the last attempt; a
  reconnection to Gladys does not. Not persisted in /data: there is no rate
  limit nor credential to protect.
- Hostile input: at most 4 KB waiting to be framed (else the connection is
  closed), frames cut linearly (a byte that starts nothing known is skipped;
  a frame whose end byte is wrong is dropped and the scan starts again one
  byte later; an "A" or "\x01" not followed by the AMX header is skipped at
  once), an AMX line 512 bytes at most and only `Device-Make`,
  `Device-Model`, `Device-Revision`, `Device-SDKClass` kept (printable ASCII,
  64 characters); zone 2 answers ignored; states decoded strictly (one byte,
  known values, volume 0..99); option values plain upper-case identifiers;
  20 devices, 50 SSDP answers, 32 requests waiting; more than 300 frames in
  10 s closes the connection. The device table of `/data` has no prototype
  and keeps only entries whose key is the platform id of a valid address.
- SSDP answers: only IPv4 addresses of a local network are probed (10/8,
  172.16/12, 192.168/16, 100.64/10, 169.254/16 but 169.254.169.254); public,
  loopback, 0/8, broadcast and multicast never. The probe is the AMX request
  and the power read on port 50000, on a connection closed right after.
  Typed addresses are not filtered.
- Publication: grouped per device (at most one `publishChangedStates` per
  second), only the created devices; a state unknown is not published.
- Categories and types from the core only (`server/utils/constants.js`):
  `music/volume` (as the core Sonos service), `television/volume-mute` (music
  has no mute type), `text/select`, `button/push`, `unknown/binary`. No unit:
  `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists none for music, television, text,
  button or unknown. Store category `multimedia`.
- Zone 1 only in v1, as the main zone of every model.

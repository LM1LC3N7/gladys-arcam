# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-21

### Added

- Arcam AV receivers, processors and amplifiers over their local IP control
  (TCP port 50000), without any cloud: added by IP address, or found with an
  optional SSDP search through Gladys.
- Zone 1: power state (read only), "Power on" and "Standby" buttons, volume
  (0 to 99, the display scale, validated strictly, capped by the new
  `max_volume` option, 40 by default), mute (each press reads the mute and
  sets the opposite), a "Source" dropdown and an "Audio mode" dropdown (decode
  modes, checked against the incoming signal), read and set. Every command is
  answered to Gladys within 4 seconds, or dropped, never sent late.
- The model is read from the device (AMX) and picks the sources, the audio
  modes and how each command is sent (direct writes on the SA, ST and PA
  series, RC5 codes on the AVRs), as arcam-fmj; it is kept in `/data` for a
  device that does not answer the AMX request.
- Changes made on the device, its remote or its app are pushed to Gladys
  (grouped, at most once a second per device).
- A device in standby without network, off or unreachable shows its power at
  0 and is named in the integration status; the connection is opened again
  after 10 s, then at intervals doubled up to 5 minutes.
- "Find the devices" and "Check the devices" buttons.
- Unmuting lowers a volume above the cap to the cap first; Power on brings
  the volume back to the cap after the wake-up, however slow (up to 2
  minutes after the press, until the device reports its volume).
- Only the devices typed, created in Gladys or found by the last search keep
  a connection (some Arcam devices accept a single IP control client).

### Fixed

- A command waiting behind a silent read is dropped at its own deadline and
  reported "nothing sent", never "sent, without confirmation".
- Standby ends the wake-up checks of a Power on; a wake-up check holds the
  device queue 1.2 s at most.
- One read of the full state at a time per device.
- Addresses ending in .255 found by the search are probed (hosts of a /16).

### Changed

- Addresses are IPv4 only (a host name next to the IP address gave the same
  device twice).
- Standby and mute go before the commands waiting for a device.

### Security

- Frames are cut linearly from at most 4 KB waiting; an AMX line is 512 bytes
  at most and only its known keys are kept; a connection flooded with frames
  is closed. The device table of `/data` has no prototype, and a value of a
  dropdown that is not a plain identifier is refused.
- The SSDP search only connects to local network addresses (no public,
  loopback, broadcast, multicast or cloud metadata address).

[Unreleased]: https://github.com/LM1LC3N7/gladys-arcam/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-arcam/releases/tag/v0.1.1

# Third-party notices

This integration ports to JavaScript the logic of the following project: the
Arcam IP control framing (`0x21 … 0x0D` commands and answers, the AMX
identification), the command and answer codes, the model families, the
source and decode mode tables, the RC5 codes of the models without a direct
write, the request-per-answer client and the heartbeat (`src/arcam/`).
Nothing of it is installed at runtime; its notice is reproduced below.

## arcam-fmj 3.0.1.post1

<https://github.com/elupus/arcam_fmj> (the library behind the Home Assistant
Arcam FMJ integration), version `3.0.1.post1` of 2026-10-11

```
MIT License

Copyright (c) 2016 Joakim Plate

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, Arcam FMJ integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/arcam_fmj>
(Apache License 2.0): only consulted, no code copied. The SSDP search target
it matches (`urn:schemas-upnp-org:device:MediaRenderer:1`), the port 50000,
and the volume on the 0..99 scale of the device are reused as facts.

## LM1LC3N7/gladys-cambridge-audio and LM1LC3N7/gladys-denon-avr

The structure of the app, the `/data` store, the volume cap and the handler
wiring follow integrations of the same author, under the Apache License 2.0
of this repository.

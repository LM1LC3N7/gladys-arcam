// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a warm dark gradient, the
// front of a black AV receiver (an amber display with a volume bar, a row of
// input buttons, a large volume knob) and a network link to a small house.
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
/** Antialiased coverage of a signed distance (negative inside). */
const inside = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance to the segment (ax, ay)-(bx, by). */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

const DARK = [16, 12, 10];
const WARM = [58, 40, 30];
const FRONT = [34, 34, 38];
const FRONT_EDGE = [70, 70, 78];
const PANEL = [12, 12, 14];
const DISPLAY = [20, 14, 8];
const AMBER = [255, 170, 60];
const KNOB = [52, 52, 58];
const KNOB_LIGHT = [150, 150, 160];
const LINK = [255, 196, 120];

const BODY = { cx: 360, cy: 250, w: 290, h: 100, r: 12 };
const KNOB_C = { x: 560, y: 250, r: 62 };

function pixel(x, y) {
  let color = mix(DARK, WARM, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // Soft shadow under the receiver.
  const shadow = Math.hypot((x - BODY.cx) / 320, (y - 380) / 16);
  color = mix(color, [0, 0, 0], (1 - shadow) * 0.75);
  // The black front plate, with a lighter edge.
  const body = roundRect(x, y, BODY.cx, BODY.cy, BODY.w, BODY.h, BODY.r);
  color = mix(color, FRONT_EDGE, inside(body));
  const brushed = ((x * 5 + Math.floor(y / 2) * 11) % 13) / 13;
  color = mix(color, mix(FRONT, PANEL, brushed * 0.25), inside(body + 3));
  // The display: an amber text line and a volume bar.
  color = mix(color, DISPLAY, inside(roundRect(x, y, 230, 222, 130, 40, 6)));
  color = mix(color, AMBER, inside(roundRect(x, y, 200, 206, 90, 6, 6)) * 0.95);
  for (let i = 0; i < 12; i += 1) {
    const bx = 120 + i * 18;
    const lit = i < 7 ? 0.95 : 0.25;
    color = mix(color, AMBER, inside(roundRect(x, y, bx, 238, 6, 8, 2)) * lit);
  }
  // A row of input buttons under the display.
  for (let i = 0; i < 7; i += 1) {
    color = mix(color, FRONT_EDGE, inside(roundRect(x, y, 120 + i * 37, 300, 13, 6, 5)));
  }
  // The power led.
  color = mix(color, AMBER, inside(Math.hypot(x - 96, y - 300) - 4));
  // The volume knob: a ring, a cap with a sheen, a marker.
  const d = Math.hypot(x - KNOB_C.x, y - KNOB_C.y);
  color = mix(color, PANEL, inside(d - KNOB_C.r - 6));
  const angle = Math.atan2(y - KNOB_C.y, x - KNOB_C.x);
  const sheen = 0.5 + 0.5 * Math.cos(angle * 2 + 0.9);
  color = mix(
    color,
    mix(KNOB, KNOB_LIGHT, sheen * (1 - d / KNOB_C.r) + 0.15),
    inside(d - KNOB_C.r),
  );
  const mx = KNOB_C.x + Math.cos(-2.4) * 42;
  const my = KNOB_C.y + Math.sin(-2.4) * 42;
  color = mix(color, AMBER, inside(Math.hypot(x - mx, y - my) - 5));
  // A dotted network link to a small house, bottom right.
  const link = segment(x, y, 640, 330, 700, 420);
  const along = Math.hypot(x - 640, y - 330) % 22;
  color = mix(color, LINK, inside(link - 3) * (along < 12 ? 0.9 : 0));
  const roof = Math.max(segment(x, y, 670, 440, 700, 412), 0) - 4;
  const roof2 = segment(x, y, 700, 412, 730, 440) - 4;
  color = mix(color, LINK, Math.max(inside(roof), inside(roof2)));
  color = mix(color, LINK, inside(roundRect(x, y, 700, 462, 24, 20, 3)));
  color = mix(color, WARM, inside(roundRect(x, y, 700, 468, 8, 14, 2)));
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);

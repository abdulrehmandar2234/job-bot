// Draws the extension icons (a white briefcase on a green rounded square) as PNGs, with no dependencies.
// Run from the repo root: node extension/icons/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

function png(size) {
  const px = (x, y) => {
    const u = (x + 0.5) / size,
      v = (y + 0.5) / size; // 0..1
    const r = 0.2,
      dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - r)),
      dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - r));
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0]; // outside the rounded square
    const body = u > 0.2 && u < 0.8 && v > 0.36 && v < 0.78;
    const handle = u > 0.38 && u < 0.62 && v > 0.24 && v < 0.36 && !(u > 0.44 && u < 0.56 && v > 0.29);
    const seam = v > 0.52 && v < 0.56;
    return (body && !seam) || handle ? [255, 255, 255, 255] : [4, 120, 87, 255];
  };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(px(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) writeFileSync(new URL(`icon${size}.png`, import.meta.url), png(size));

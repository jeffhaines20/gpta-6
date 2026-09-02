// Crop and optionally magnify a capture, so a finding can be LOOKED at at the
// scale it was measured at. crop.mjs <png> <x> <y> <w> <h> [scale] [out]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readPNG } from './png.mjs';

let CRC = null;
function crc32(buf) {
  if (!CRC) { CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; } }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
export function writePNG(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) { raw[p++] = 0; raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), p); p += w * 3; }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// Also imported as a module for writePNG(), so the CLI half only runs when this
// file is the entry point. Without the guard an `import { writePNG }` executes
// the argv parse below and dies on readPNG(undefined).
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/crop.mjs');
if (isMain) {
const [file, X, Y, W, H, S = '1', out] = process.argv.slice(2);
const png = readPNG(file);
const x0 = +X, y0 = +Y, cw = +W, chh = +H, s = +S;
const ow = cw * s, oh = chh * s;
const rgb = Buffer.alloc(ow * oh * 3);
for (let y = 0; y < oh; y++) {
  for (let x = 0; x < ow; x++) {
    const sx = Math.min(png.width - 1, x0 + ((x / s) | 0)), sy = Math.min(png.height - 1, y0 + ((y / s) | 0));
    const i = (sy * png.width + sx) * png.channels, o = (y * ow + x) * 3;
    rgb[o] = png.data[i]; rgb[o + 1] = png.data[i + 1]; rgb[o + 2] = png.data[i + 2];
  }
}
const dst = out ?? file.replace(/\.png$/, `.crop${x0}_${y0}.png`);
writePNG(dst, ow, oh, rgb);
console.log(dst, `${ow}x${oh}`);
}

// Generates the Sky Glider PWA PNG icons from scratch (no native deps).
// Draws a sky-gradient square with a simple bird, then encodes RGBA -> PNG.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("../icons/", import.meta.url);
mkdirSync(OUT, { recursive: true });

// ---- tiny PNG encoder (truecolor + alpha, 8-bit) --------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 10,11,12 = compression, filter, interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing --------------------------------------------------------------
function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function draw(size, { padding }) {
  const buf = Buffer.alloc(size * size * 4);
  const top = [0x4a, 0xa6, 0xe2];
  const bot = [0x9f, 0xd4, 0xf0];
  const cx = size / 2, cy = size * 0.55;
  const R = size * (padding ? 0.30 : 0.235); // bird radius (smaller w/ maskable safe zone)

  const set = (x, y, r, g, b, a = 255) => {
    const i = (y * size + x) * 4;
    const ia = a / 255;
    buf[i]     = Math.round(lerp(buf[i], r, ia));
    buf[i + 1] = Math.round(lerp(buf[i + 1], g, ia));
    buf[i + 2] = Math.round(lerp(buf[i + 2], b, ia));
    buf[i + 3] = Math.max(buf[i + 3], a);
  };

  for (let y = 0; y < size; y++) {
    const sky = mix(top, bot, y / size);
    for (let x = 0; x < size; x++) {
      set(x, y, sky[0], sky[1], sky[2], 255);
    }
  }

  // bird body (filled circle w/ darker outline) + eye + beak
  const eyeX = cx + R * 0.42, eyeY = cy - R * 0.38;
  const beakTipX = cx + R * 1.5, beakY = cy;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d <= R) {
        // body
        if (d > R - size * 0.022) set(x, y, 0xa8, 0x65, 0x0a, 255); // outline
        else set(x, y, 0xfb, 0xbf, 0x24, 255);                      // fill
      }
      // beak (triangle to the right)
      if (x > cx + R * 0.6 && x < beakTipX) {
        const prog = (x - (cx + R * 0.6)) / (beakTipX - (cx + R * 0.6));
        const half = R * 0.28 * (1 - prog);
        if (Math.abs(y - beakY) < half) set(x, y, 0xef, 0x6c, 0x1a, 255);
      }
      // eye white + pupil
      const de = Math.hypot(x - eyeX, y - eyeY);
      if (de <= R * 0.3) set(x, y, 0xff, 0xff, 0xff, 255);
      if (Math.hypot(x - (eyeX + R * 0.08), y - eyeY) <= R * 0.13) set(x, y, 0x0f, 0x17, 0x2a, 255);
    }
  }
  return buf;
}

function write(name, size, opts) {
  const png = encodePNG(size, size, draw(size, opts));
  writeFileSync(new URL(name, OUT), png);
  console.log("wrote", name, png.length, "bytes");
}

write("icon-192.png", 192, { padding: false });
write("icon-512.png", 512, { padding: false });
write("icon-maskable-512.png", 512, { padding: true }); // smaller bird for safe zone

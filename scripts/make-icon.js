// make-icon.js — generates build/icon.png (256x256) and build/icon.ico from
// scratch (no native deps). The .ico embeds a PNG, which Windows Vista+ accepts.
// Run manually when the look should change: `node scripts/make-icon.js`.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 256;

function px(x, y) {
  // Rounded-square background with a diagonal blue→green gradient, plus a white
  // "play" triangle = a simple, recognizable TV/stream mark.
  const r = 46; // corner radius
  const inset = 8;
  const inRounded = (() => {
    const x0 = inset, y0 = inset, x1 = SIZE - inset, y1 = SIZE - inset;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
  })();
  if (!inRounded) return [0, 0, 0, 0];

  const t = (x + y) / (2 * SIZE);
  const rC = Math.round(79 + (106 - 79) * t);
  const gC = Math.round(140 + (210 - 140) * t);
  const bC = Math.round(255 + (139 - 255) * t);

  // Play triangle
  const tri = (() => {
    const ax = 100, ay = 78, bx = 100, by = 178, cxp = 186, cyp = 128;
    const area = (x1, y1, x2, y2, x3, y3) => Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
    const A = area(ax, ay, bx, by, cxp, cyp);
    const A1 = area(x, y, bx, by, cxp, cyp);
    const A2 = area(ax, ay, x, y, cxp, cyp);
    const A3 = area(ax, ay, bx, by, x, y);
    return Math.abs(A - (A1 + A2 + A3)) < 400;
  })();
  if (tri) return [255, 255, 255, 255];
  return [rC, gC, bC, 255];
}

function buildPng() {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  let o = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0; // filter type none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = px(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([tb, data])) >>> 0, 0);
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildIco(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; // 0 => 256
  entry[2] = 0; entry[3] = 0; entry[4] = 1; entry[5] = 0;
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

const outDir = path.resolve(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = buildPng();
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(png));
console.log(`[make-icon] wrote build/icon.png (${png.length} B) and build/icon.ico`);

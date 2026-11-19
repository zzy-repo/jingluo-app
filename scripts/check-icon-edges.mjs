#!/usr/bin/env node
// #266 应用图标白边检查：取每张图标四边各 2px，统计 (r>245 && g>245 && b>245) 的像素数，必须为 0。
//
// 零依赖：自己解 PNG（IHDR + IDAT + zlib inflate + unfilter），支持 8bit RGB / RGBA。
//
//   node scripts/check-icon-edges.mjs        # 或 pnpm run check:icon
//
// 两套口径都会打印：
//   strict   —— 完全按 issue 定义，只看 RGB（transparent 区域也照算）
//   rendered —— 只有 alpha>=8 的像素才算白（即实际画出来的白）
// 两者都必须是 0，才算通过。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');
const DOCS_ICON = join(ROOT, 'docs', 'ui', 'app-icon', 'icon-512.png');
const EDGE = 2;

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG');
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!ihdr) throw new Error('缺少 IHDR');
  const { width, height, depth, colorType, interlace } = ihdr;
  if (depth !== 8) throw new Error(`只支持 8bit，实际 ${depth}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`只支持 RGB/RGBA，实际 colorType=${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 0xff;
          break;
        }
        default: throw new Error(`未知 filter ${filter}`);
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

function countEdges(png) {
  const { width, height, channels, data } = png;
  const isWhite = (x, y, needAlpha) => {
    const i = (y * width + x) * channels;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (needAlpha) {
      if (channels < 4) return false;
      if (data[i + 3] < 8) return false;
    }
    return r > 245 && g > 245 && b > 245;
  };
  const bands = {
    top: (cb) => { for (let y = 0; y < Math.min(EDGE, height); y += 1) for (let x = 0; x < width; x += 1) cb(x, y); },
    bottom: (cb) => { for (let y = Math.max(0, height - EDGE); y < height; y += 1) for (let x = 0; x < width; x += 1) cb(x, y); },
    left: (cb) => { for (let x = 0; x < Math.min(EDGE, width); x += 1) for (let y = 0; y < height; y += 1) cb(x, y); },
    right: (cb) => { for (let x = Math.max(0, width - EDGE); x < width; x += 1) for (let y = 0; y < height; y += 1) cb(x, y); },
  };
  const result = {};
  for (const [name, walk] of Object.entries(bands)) {
    let strict = 0;
    let rendered = 0;
    walk((x, y) => {
      if (isWhite(x, y, false)) strict += 1;
      if (isWhite(x, y, true)) rendered += 1;
    });
    result[name] = { strict, rendered };
  }
  return result;
}

function targets() {
  const list = [];
  for (const ent of readdirSync(RES, { withFileTypes: true })) {
    if (!ent.isDirectory() || !ent.name.startsWith('mipmap-') || ent.name === 'mipmap-anydpi-v26') continue;
    for (const f of readdirSync(join(RES, ent.name))) {
      if (f.endsWith('.png')) list.push(join(RES, ent.name, f));
    }
  }
  list.sort();
  if (existsSync(DOCS_ICON)) list.push(DOCS_ICON);
  return list;
}

const files = targets();
if (files.length === 0) {
  console.error('[check-icon] 没找到任何图标 PNG');
  process.exit(1);
}

let failed = 0;
console.log(`[check-icon] 四边各 ${EDGE}px，统计 (r>245 && g>245 && b>245) 像素数`);
console.log('[check-icon] 文件'.padEnd(64) + 'top  bottom  left  right');
for (const file of files) {
  const png = decodePng(readFileSync(file));
  const edges = countEdges(png);
  const totalStrict = Object.values(edges).reduce((s, e) => s + e.strict, 0);
  const totalRendered = Object.values(edges).reduce((s, e) => s + e.rendered, 0);
  if (totalStrict !== 0 || totalRendered !== 0) failed += 1;
  const row = [edges.top, edges.bottom, edges.left, edges.right]
    .map((e) => `${e.strict}/${e.rendered}`.padStart(6))
    .join('  ');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const flag = totalStrict === 0 && totalRendered === 0 ? 'OK' : 'FAIL';
  console.log(`[check-icon] ${rel.padEnd(50)} ${row}  ${flag} (${png.width}×${png.height})`);
}

if (failed > 0) {
  console.error(`[check-icon] 失败：${failed}/${files.length} 张图标四边残留白像素`);
  process.exit(1);
}
console.log(`[check-icon] 通过：${files.length} 张图标四边白像素均为 0`);

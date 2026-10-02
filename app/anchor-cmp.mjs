// 通用锚点对比工具：任意组之间比较脸/白领子的位置与比例
// 用法: node anchor-cmp.mjs name=path name=path ... pair:nameA,nameB ...
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const sets = {}, pairs = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('pair:')) { const [x, y] = a.slice(5).split(','); pairs.push([x, y]); }
  else { const i = a.indexOf('='); sets[a.slice(0, i)] = a.slice(i + 1); }
}
const IMG = /\.(png|jpe?g|webp|avif)$/i;
const numOf = (f) => { const m = f.match(/(\d+)(?=\.[a-z]+$)/i); return m ? Number(m[1]) : NaN; };
const list = (d) => fs.readdirSync(d).filter((f) => IMG.test(f))
  .map((f) => ({ n: numOf(f), full: path.join(d, f) })).sort((a, b) => a.n - b.n);

async function anchors(p) {
  const meta = await sharp(p).metadata();
  const { data, info } = await sharp(p).resize({ width: 512, fit: 'inside' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const box = { skin: [1e9, 1e9, -1, -1, 0], white: [1e9, 1e9, -1, -1, 0] };
  const add = (b, x, y) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; b[4]++; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * c, R = data[i], G = data[i + 1], B = data[i + 2];
    const lum = 0.299 * R + 0.587 * G + 0.114 * B;
    if (y / h < 0.42 && R > 150 && G > 110 && B > 85 && R - B > 22 && R - G > 8 && lum > 120) add(box.skin, x, y);
    if (lum > 195 && Math.abs(R - B) < 26) add(box.white, x, y);
  }
  const f = (v, t) => +(v / t * 100).toFixed(2);
  const o = { dim: `${meta.width}x${meta.height}` };
  for (const [k, b] of Object.entries(box)) {
    o[k] = b[2] < 0 ? null : { wPct: f(b[2] - b[0], w), hPct: f(b[3] - b[1], h), cx: f((b[0] + b[2]) / 2, w), cy: f((b[1] + b[3]) / 2, h) };
  }
  return o;
}

const A = {};
for (const [k, dir] of Object.entries(sets)) {
  if (!fs.existsSync(dir)) { console.log(`[${k}] MISSING ${dir}`); continue; }
  A[k] = {};
  for (const it of list(dir)) A[k][it.n] = await anchors(it.full);
}
for (const k of Object.keys(A)) {
  console.log(`\n[${k}]  n | dim | 脸 cx,cy w×h | 白 cx,cy w×h`);
  for (const [n, a] of Object.entries(A[k])) {
    console.log(`  ${n} | ${a.dim.padEnd(9)} | ${a.skin ? `${a.skin.cx},${a.skin.cy} ${a.skin.wPct}×${a.skin.hPct}` : '-'} | ${a.white ? `${a.white.cx},${a.white.cy} ${a.white.wPct}×${a.white.hPct}` : '-'}`);
  }
}
for (const [x, y] of pairs) {
  console.log(`\n--- ${x} → ${y} ---`);
  for (const n of Object.keys(A[x] || {})) {
    const a = A[x][n], b = (A[y] || {})[n];
    if (!a || !b) { console.log(`  ${n}: 缺`); continue; }
    const s = (a.skin && b.skin) ? `脸scale=${(b.skin.wPct / a.skin.wPct).toFixed(3)} Δcx=${(b.skin.cx - a.skin.cx).toFixed(2)} Δcy=${(b.skin.cy - a.skin.cy).toFixed(2)}` : '脸未检出';
    const wh = (a.white && b.white) ? `白scale=${(b.white.wPct / a.white.wPct).toFixed(3)} Δcx=${(b.white.cx - a.white.cx).toFixed(2)}` : '白未检出';
    console.log(`  ${n}: ${s} | ${wh}   (${a.dim} vs ${b.dim})`);
  }
}

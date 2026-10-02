// 五官锚点测量：肤色（脸）与白领子（衣服）在各图里的位置/尺寸
// 目的：判断"同编号换图"需要的缩放/平移量，以及姿态是否根本不同
// 用法: node analyze-papercut-anchor.mjs
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SETS = {
  idle:      'E:\\《赛博女友》剪纸',
  mouth:     'E:\\《赛博女友》张嘴素材_剪纸',
  blink:     'E:\\《赛博女友》闭眼素材_剪纸',
  think:     'E:\\《赛博女友》思考素材_剪纸',
  thinkBlink:'E:\\《赛博女友》思考素材_剪纸_闭眼',
};
const IMG = /\.(png|jpe?g|webp|avif)$/i;
const numOf = (f) => { const m = f.match(/(\d+)(?=\.[a-z]+$)/i); return m ? Number(m[1]) : NaN; };
const list = (d) => fs.readdirSync(d).filter((f) => IMG.test(f))
  .map((f) => ({ n: numOf(f), full: path.join(d, f) })).sort((a, b) => a.n - b.n);

const W = 512;
async function anchors(p) {
  const { data, info } = await sharp(p).resize({ width: W, fit: 'inside' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const box = { skin: [1e9, 1e9, -1, -1, 0], white: [1e9, 1e9, -1, -1, 0] };
  const add = (b, x, y) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; b[4]++; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * c, R = data[i], G = data[i + 1], B = data[i + 2];
    const lum = 0.299 * R + 0.587 * G + 0.114 * B;
    const yTop = y / h < 0.42;               // 脸只在上半部找
    const isSkin = yTop && R > 150 && G > 110 && B > 85 && R - B > 22 && R - G > 8 && lum > 120;
    const isWhite = lum > 195 && Math.abs(R - B) < 26;  // 白领子（也含头箍）
    if (isSkin) add(box.skin, x, y);
    if (isWhite) add(box.white, x, y);
  }
  const f = (v, t) => +(v / t * 100).toFixed(2);
  const out = {};
  for (const [k, b] of Object.entries(box)) {
    if (b[2] < 0) { out[k] = null; continue; }
    out[k] = {
      n: b[4], x0: f(b[0], w), x1: f(b[2], w), y0: f(b[1], h), y1: f(b[3], h),
      wPct: f(b[2] - b[0], w), hPct: f(b[3] - b[1], h),
      cx: f((b[0] + b[2]) / 2, w), cy: f((b[1] + b[3]) / 2, h),
    };
  }
  return out;
}

const A = {};
for (const [k, dir] of Object.entries(SETS)) {
  if (!fs.existsSync(dir)) continue;
  A[k] = {};
  for (const it of list(dir)) A[k][it.n] = await anchors(it.full);
}

const show = (k) => {
  console.log(`\n[${k}]  n | 脸 cx,cy  w×h | 白 cx,cy w  (均为画面百分比)`);
  for (const [n, a] of Object.entries(A[k] || {})) {
    const s = a.skin, wh = a.white;
    console.log(`  ${n} | ${s ? `${s.cx},${s.cy}  ${s.wPct}×${s.hPct}` : '未检出'.padEnd(22)} | ${wh ? `${wh.cx},${wh.cy} w=${wh.wPct}` : '未检出'}`);
  }
};
console.log('===== 锚点 =====');
for (const k of Object.keys(A)) show(k);

const rel = (a, b, label) => {
  console.log(`\n--- ${label}（以左为基准；scale=右/左，Δ=右-左，单位%）---`);
  console.log('  n | 脸 scaleW  Δcx    Δcy  | 白 scaleW  Δcx   Δcy  | 判读');
  for (const n of Object.keys(A[a] || {})) {
    const x = A[a][n], y = (A[b] || {})[n];
    if (!x || !y || !x.skin || !y.skin) { console.log(`  ${n} | 无法比较（未检出）`); continue; }
    const sw = y.skin.wPct / x.skin.wPct, dcx = +(y.skin.cx - x.skin.cx).toFixed(2), dcy = +(y.skin.cy - x.skin.cy).toFixed(2);
    const swh = x.white && y.white ? (y.white.wPct / x.white.wPct).toFixed(3) : '-';
    const whx = x.white && y.white ? +(y.white.cx - x.white.cx).toFixed(2) : NaN;
    const why = x.white && y.white ? +(y.white.cy - x.white.cy).toFixed(2) : NaN;
    const worst = Math.max(Math.abs(sw - 1) * 100, Math.abs(dcx), Math.abs(dcy));
    const v = worst < 1.5 ? '✅ 直接换图基本不跳' : worst < 4 ? '🟡 需轻微校正' : '❌ 姿态/景别不同，换图会跳';
    console.log(`  ${n} | ${sw.toFixed(3)}  ${String(dcx).padStart(6)} ${String(dcy).padStart(6)} | ${String(swh).padStart(6)}  ${Number.isNaN(whx) ? '  -  ' : String(whx).padStart(6)} ${Number.isNaN(why) ? '  -  ' : String(why).padStart(6)} | ${v}`);
  }
};
console.log('\n===== 跨组比对 =====');
rel('idle', 'blink', 'idle → blink');
rel('idle', 'mouth', 'idle → mouth');
rel('think', 'thinkBlink', 'think → thinkBlink');

// 主体包围盒对齐分析：判断跨文件夹同编号图能否直接替换而不跳位
// 用法: node analyze-papercut-align.mjs
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
const list = (dir) => fs.readdirSync(dir).filter((f) => IMG.test(f))
  .map((f) => ({ file: f, n: numOf(f), full: path.join(dir, f) }))
  .sort((a, b) => (a.n - b.n) || a.file.localeCompare(b.file));

// 统一重采样到宽 512 的 canvas，按亮度阈值找主体包围盒
async function probe(p, { thr = 45, W = 512 } = {}) {
  const { data, info } = await sharp(p).resize({ width: W, fit: 'inside' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * c;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum > thr) { count++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  const f = (v, t) => +(v / t * 100).toFixed(2);
  return {
    canvas: `${w}x${h}`, subjPct: +(count / (w * h) * 100).toFixed(1),
    x0: f(x0, w), y0: f(y0, h), x1: f(x1, w), y1: f(y1, h),
    widthPct: f(x1 - x0, w), heightPct: f(y1 - y0, h),
    cx: f((x0 + x1) / 2, w), cy: f((y0 + y1) / 2, h),
  };
}

console.log('===== 主体包围盒（占画面百分比，阈值 lum>45）=====');
const probes = {};
for (const [k, dir] of Object.entries(SETS)) {
  if (!fs.existsSync(dir)) continue;
  probes[k] = {};
  console.log(`\n[${k}]`);
  for (const it of list(dir)) {
    const p = await probe(it.full);
    probes[k][it.n] = p;
    console.log(`  #${it.n}  canvas=${p.canvas} subj=${p.subjPct}%  bbox x[${p.x0}→${p.x1}] y[${p.y0}→${p.y1}]  w=${p.widthPct}% h=${p.heightPct}%  center=(${p.cx},${p.cy})`);
  }
}

const cmpRow = (a, b, label) => {
  const A = probes[a], B = probes[b];
  if (!A || !B) return;
  console.log(`\n--- ${label} ---`);
  console.log('  n |  Δcx   Δcy   Δw    Δh   | 判读');
  for (const n of Object.keys(A)) {
    const x = A[n], y = B[n];
    if (!y) continue;
    const d = (p, q) => +(p - q).toFixed(2);
    const dx = d(x.cx, y.cx), dy = d(x.cy, y.cy), dw = d(x.widthPct, y.widthPct), dh = d(x.heightPct, y.heightPct);
    const worst = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
    const verdict = worst < 1 ? '✅ 几乎同位' : worst < 2.5 ? '🟡 轻微偏移' : '❌ 明显错位/缩放差';
    console.log(`  ${n} | ${String(dx).padStart(6)} ${String(dy).padStart(6)} ${String(dw).padStart(6)} ${String(dh).padStart(6)} | ${verdict}`);
  }
};
cmpRow('idle', 'blink', 'idle ↔ blink（待机换闭眼）');
cmpRow('idle', 'mouth', 'idle ↔ mouth（待机换张嘴）');
cmpRow('think', 'thinkBlink', 'think ↔ thinkBlink（思考换闭眼）');

console.log('\n===== 组内姿态位移（基帧之间，判断动画幅度）=====');
const within = (set, ns, label) => {
  const P = probes[set]; if (!P) return;
  console.log(`\n--- ${label} ---`);
  for (let i = 0; i < ns.length - 1; i++) {
    const a = P[ns[i]], b = P[ns[i + 1]]; if (!a || !b) continue;
    console.log(`  #${ns[i]}→#${ns[i + 1]}: Δcx=${(b.cx - a.cx).toFixed(2)} Δcy=${(b.cy - a.cy).toFixed(2)} Δw=${(b.widthPct - a.widthPct).toFixed(2)} Δh=${(b.heightPct - a.heightPct).toFixed(2)}`);
  }
};
within('idle', [1, 2, 3, 4, 5, 6], 'idle 全序列');
within('think', [1, 2, 3], 'think 全序列');

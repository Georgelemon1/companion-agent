// 分析 E:\《赛博女友》剪纸系列素材：真实格式/尺寸/背景/跨文件夹对齐
// 用法: node analyze-papercut.mjs
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

function list(dir) {
  return fs.readdirSync(dir).filter((f) => IMG.test(f))
    .map((f) => ({ file: f, n: numOf(f), full: path.join(dir, f) }))
    .sort((a, b) => (a.n - b.n) || a.file.localeCompare(b.file));
}

async function meta(p) {
  const m = await sharp(p).metadata();
  return { fmt: m.format, w: m.width, h: m.height, ch: m.channels, alpha: m.hasAlpha, space: m.space };
}

async function small(p, size = 384) {
  const { data, info } = await sharp(p).resize(size, size, { fit: 'inside' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}

// 背景采样：四角 5x5 均值 + 边缘带众数
async function bg(p) {
  const { data, info } = await sharp(p).resize(96, 96, { fit: 'inside' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const px = (x, y) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2]]; };
  const avg = (pts) => {
    const s = [0, 0, 0];
    for (const [x, y] of pts) { const q = px(x, y); s[0] += q[0]; s[1] += q[1]; s[2] += q[2]; }
    return s.map((v) => Math.round(v / pts.length));
  };
  const block = (x0, y0) => {
    const pts = [];
    for (let y = y0; y < y0 + 5; y++) for (let x = x0; x < x0 + 5; x++) pts.push([x, y]);
    return avg(pts);
  };
  const corners = {
    tl: block(0, 0), tr: block(W - 5, 0), bl: block(0, H - 5), br: block(W - 5, H - 5),
  };
  // 边缘带（最外 3px）颜色直方图，量化到 16 级
  const hist = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x > 2 && x < W - 3 && y > 2 && y < H - 3) continue;
    const q = px(x, y).map((v) => v >> 4).join(',');
    hist.set(q, (hist.get(q) || 0) + 1);
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k.split(',').map((n) => (Number(n) << 4)).join('/')}×${v}`);
  return { corners, edgeTop: top, edgeUnique: hist.size };
}

function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { err: `size ${a.w}x${a.h} vs ${b.w}x${b.h}` };
  let sum = 0, n = 0, diffPx = 0;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const i = (y * a.w + x) * a.ch;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    sum += d; n++;
    if (d > 16) { diffPx++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  const bbox = x1 < 0 ? 'none' : `${(x0 / a.w * 100).toFixed(1)}%,${(y0 / a.h * 100).toFixed(1)}% → ${(x1 / a.w * 100).toFixed(1)}%,${(y1 / a.h * 100).toFixed(1)}%`;
  return { meanAbs: +(sum / n).toFixed(2), pctDiff: +(diffPx / n * 100).toFixed(1), bbox };
}

const out = {};
for (const [k, dir] of Object.entries(SETS)) {
  if (!fs.existsSync(dir)) { out[k] = { err: 'MISSING' }; continue; }
  const items = list(dir);
  const metas = [];
  for (const it of items) metas.push({ n: it.n, file: it.file, ...(await meta(it.full)) });
  out[k] = { dir, count: items.length, files: metas };
}

console.log('===== 1. 文件与真实格式 =====');
for (const [k, v] of Object.entries(out)) {
  console.log(`\n[${k}] ${v.dir}  count=${v.count}`);
  if (v.err) { console.log('  ' + v.err); continue; }
  for (const f of v.files) console.log(`  n=${String(f.n).padStart(2)}  ${f.file.padEnd(20)} ${f.fmt} ${f.w}x${f.h} ch=${f.ch} alpha=${f.alpha}`);
}

console.log('\n===== 2. 背景 =====');
for (const [k, dir] of Object.entries(SETS)) {
  if (!fs.existsSync(dir)) continue;
  const items = list(dir);
  const b = await bg(items[0].full);
  console.log(`[${k}] ${items[0].file}`);
  console.log(`   corners tl=${b.corners.tl} tr=${b.corners.tr} bl=${b.corners.bl} br=${b.corners.br}  edgeColors=${b.edgeUnique} top=${b.edgeTop.join(' | ')}`);
}

console.log('\n===== 3. 跨文件夹同编号对齐（384px 归一化后的像素差）=====');
const cmp = async (aDir, bDir, label, idxs) => {
  const A = list(aDir), B = list(bDir);
  for (const i of idxs) {
    const a = A.find((x) => x.n === i), b = B.find((x) => x.n === i);
    if (!a || !b) { console.log(`  ${label} #${i}: 缺 ${!a ? 'A' : 'B'}`); continue; }
    const d = diff(await small(a.full), await small(b.full));
    console.log(`  ${label} #${i}: ${JSON.stringify(d)}`);
  }
};
await cmp(SETS.idle, SETS.blink, 'idle↔blink', [1, 2, 3, 4, 5, 6]);
await cmp(SETS.idle, SETS.mouth, 'idle↔mouth', [1, 2, 3, 4, 5, 6]);
await cmp(SETS.think, SETS.thinkBlink, 'think↔thinkBlink', [1, 2, 3]);

console.log('\n===== 4. 组内基准差（判断姿态变化幅度）=====');
const pairs = [
  [SETS.idle, 1, SETS.idle, 3, 'idle1↔idle3(基帧间)'],
  [SETS.idle, 3, SETS.idle, 5, 'idle3↔idle5(基帧间)'],
  [SETS.idle, 5, SETS.idle, 1, 'idle5↔idle1(基帧间)'],
  [SETS.idle, 1, SETS.idle, 2, 'idle1↔idle2(中间帧)'],
  [SETS.think, 1, SETS.think, 2, 'think1↔think2'],
  [SETS.think, 1, SETS.think, 3, 'think1↔think3(基帧间)'],
];
for (const [ad, ai, bd, bi, label] of pairs) {
  const A = list(ad), B = list(bd);
  const a = A.find((x) => x.n === ai), b = B.find((x) => x.n === bi);
  const d = diff(await small(a.full), await small(b.full));
  console.log(`  ${label}: ${JSON.stringify(d)}`);
}

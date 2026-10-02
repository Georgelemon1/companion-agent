// 素材批次体检：尺寸 / 格式 / 边缘底色 / 像素块大小
//
// 换批次前后各跑一次，用来决定两件事：
//   ① #stage 底色该设成什么（取边缘带中位数 —— 不跟着改就会露出一圈接缝）
//   ② 该用什么缩放方式（真像素画要 pixelated + 尽量整数倍；插画则用默认平滑）
//
// 用法：
//   node analyze-batch.mjs idle="E:\path" blink="E:\path" think="E:\path" think-blink="E:\path" mouth="E:\path"
import sharp from 'sharp'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const sets = {}
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=')
  if (i > 0) sets[a.slice(0, i)] = a.slice(i + 1)
}
if (Object.keys(sets).length === 0) throw new Error('至少要给一个 set=path')
const IMG = /\.(png|jpe?g|webp|avif)$/i
const numOf = (f) => Number((f.match(/(\d+)(?=\.[a-z]+$)/i) ?? [])[1])

/** 边缘带（最外 3px）平均色 */
async function borderColor(p) {
  const { data, info } = await sharp(p).resize({ width: 200, fit: 'inside' }).removeAlpha()
    .raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  let r = 0, g = 0, b = 0, n = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x > 2 && x < W - 3 && y > 2 && y < H - 3) continue
    const i = (y * W + x) * C
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
  }
  return [r / n, g / n, b / n].map((v) => Math.round(v))
}

/**
 * 像素块大小估计：沿三条横向扫描线统计同色游程的中位数。
 * 真像素画（放大保存的）会有明显长游程；插画/照片级约 1–2px。
 */
async function blockSize(p) {
  const { data, info } = await sharp(p).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  const runs = []
  for (const frac of [0.25, 0.45, 0.7]) {
    const y = Math.floor(H * frac)
    const key = (x) => { const i = (y * W + x) * C; return `${data[i]},${data[i + 1]},${data[i + 2]}` }
    let run = 1
    for (let x = 1; x < W; x++) {
      if (key(x) === key(x - 1)) run++
      else { runs.push(run); run = 1 }
    }
    runs.push(run)
  }
  runs.sort((a, b) => a - b)
  return runs[Math.floor(runs.length / 2)]
}

const allBg = []
let rows = 0
for (const [set, dir] of Object.entries(sets)) {
  console.log(`== ${set}  ${dir}`)
  const files = readdirSync(dir).filter((f) => IMG.test(f))
    .map((f) => ({ f, n: numOf(f) })).filter((x) => Number.isFinite(x.n)).sort((a, b) => a.n - b.n)
  for (const { f, n } of files) {
    const p = join(dir, f)
    const m = await sharp(p).metadata()
    const bg = await borderColor(p)
    const blk = await blockSize(p)
    allBg.push(bg)
    rows++
    console.log(`  n=${String(n).padStart(2)}  ${f.padEnd(16)} ${String(m.format).padEnd(5)} ${(m.width + 'x' + m.height).padEnd(11)} 边缘 rgb(${bg.join(',')})  像素块≈${blk}px`)
  }
}
const med = (i) => { const v = allBg.map((p) => p[i]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
const mm = [med(0), med(1), med(2)]
const hex = mm.map((v) => v.toString(16).padStart(2, '0')).join('')
console.log(`\n共 ${rows} 张`)
console.log(`边缘底色中位数 rgb(${mm.join(',')}) = #${hex}   ← #stage 的 background 要用这个值`)

// 表演分析 —— 逐帧看表情弧线，重点判"保持"段是否真的停住
//
// 为什么要专门测这个：立绘片段要求"保持状态 N 秒"以便循环。
// 若模型理解成"持续演化"，那一整段都在动，就没有可以拿来做循环的稳定区间。
//
// 低帧率动漫风格下，微小位移不易察觉；但**持续演化**是另一回事——
// 它会让片段找不到稳定帧，这才是真正的硬伤。
//
// 用法：node app/performance-check.mjs <帧目录>

import sharp from 'sharp'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 抽取一帧的"表情特征"：脸部区域的亮度分布与边缘密度。
 *
 * 不用人脸识别（不装依赖）：表情变化主要体现为眉眼与嘴角区域的明暗与边缘变化，
 * 用整脸区域的灰度直方图 + 水平梯度能量，足够反映"表情变了多少"。
 */
async function expressionSignature(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info

  // 先定位肤色，取脸部包围盒
  let minX = width, maxX = -1, minY = height, maxY = -1
  const skinAt = (x, y) => {
    const i = (y * width + x) * channels
    const r = data[i], g = data[i + 1], b = data[i + 2]
    return r > 150 && r - b > 30 && r - g > 8 && g > 90
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (!skinAt(x, y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null

  // 在脸部区域内统计：平均灰度、灰度标准差、水平梯度能量（边缘多=细节多=表情丰富）
  let sum = 0, sumSq = 0, n = 0, grad = 0
  const gray = (x, y) => {
    const i = (y * width + x) * channels
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const g = gray(x, y)
      sum += g; sumSq += g * g; n++
      if (x > minX) grad += Math.abs(g - gray(x - 1, y))
    }
  }
  const mean = sum / n
  const sd = Math.sqrt(sumSq / n - mean * mean)
  return {
    box: { minX, maxX, minY, maxY },
    faceH: maxY - minY,
    faceW: maxX - minX,
    mean,
    sd,
    grad: grad / n,
    /** 归一化梯度：与脸大小无关，越大多细节 */
    gradNorm: grad / n / (sd || 1),
  }
}

const dir = process.argv[2]
if (dir === undefined) {
  console.error('用法：node app/performance-check.mjs <帧目录>')
  process.exit(1)
}
const files = readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).sort()
const sigs = []
for (const f of files) {
  const s = await expressionSignature(join(dir, f))
  if (s !== null) sigs.push({ f, ...s })
}

console.log(`共 ${sigs.length} 帧\n`)
console.log('【① 表情强度弧线】（gradNorm 越高 = 面部细节越多 = 表情越用力）')
const maxGrad = Math.max(...sigs.map((s) => s.gradNorm))
for (const s of sigs) {
  const bar = '█'.repeat(Math.round((s.gradNorm / maxGrad) * 32))
  console.log(`  ${s.f}  脸高${String(s.faceH).padStart(3)}px  grad=${s.gradNorm.toFixed(3)}  ${bar}`)
}

console.log('\n【② 逐帧变化量】（相邻帧差异，用于找"停住"的区段）')
const deltas = []
for (let i = 1; i < sigs.length; i++) {
  const a = sigs[i - 1], b = sigs[i]
  const d = Math.abs(b.mean - a.mean) + Math.abs(b.sd - a.sd) * 1.5 + Math.abs(b.gradNorm - a.gradNorm) * 30
  deltas.push({ f: b.f, d, from: a.f })
}
const maxD = Math.max(...deltas.map((x) => x.d))
for (const x of deltas) {
  const bar = '█'.repeat(Math.round((x.d / maxD) * 32))
  console.log(`  ${x.from}→${x.f}  ${x.d.toFixed(3)}  ${bar}`)
}

console.log('\n【③ 用户关心的核心：有没有可用的"稳定区间"】')
// 连续低变化帧的区段 = 可用于循环的稳定区间
const threshold = maxD * 0.25
let runStart = null
const stableRuns = []
for (let i = 0; i < deltas.length; i++) {
  if (deltas[i].d <= threshold) {
    if (runStart === null) runStart = i
  } else if (runStart !== null) {
    stableRuns.push([runStart, i - 1])
    runStart = null
  }
}
if (runStart !== null) stableRuns.push([runStart, deltas.length - 1])

if (stableRuns.length === 0) {
  console.log('  ❌ 没有任何稳定区间——整段都在演化，找不到可循环的帧')
} else {
  for (const [a, b] of stableRuns) {
    const frames = deltas.slice(a, b + 1).map((x) => x.f)
    console.log(`  ✅ 稳定区间：${deltas[a].from} → ${deltas[b].f}（${frames.length + 1} 帧，约 ${((frames.length + 1) / 4).toFixed(2)} 秒）`)
  }
}
const totalStable = stableRuns.reduce((s, [a, b]) => s + (b - a + 2), 0)
console.log(`\n  稳定帧合计 ${totalStable}/${sigs.length}（${(totalStable / sigs.length * 100).toFixed(0)}%）`)
console.log(`  → 判读 ${totalStable / sigs.length > 0.35 ? '✅ 有足够稳定帧可供循环' : totalStable / sigs.length > 0.15 ? '🟡 稳定帧偏少，循环区间会很短' : '❌ 稳定帧太少，难以做无缝循环'}`)

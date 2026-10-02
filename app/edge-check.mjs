// 边缘留白检查 —— 判断人物是否贴边
//
// 为什么需要：立绘要抠像后叠在舞台上，如果人物（尤其是深色衣服）
// 顶到画面边缘、四周没有背景余量，抠掉的背景就只剩几个像素，
// 叠上去会看到衣服直接切在画面边界上，很难看。
//
// 做法：按帧切出四条边带，统计其中"绿色像素（背景）"的占比。
// 占比低说明该边被人物占满。
//
// 用法：node app/edge-check.mjs <帧文件>

import sharp from 'sharp'
import { existsSync } from 'node:fs'

const frame = process.argv[2]
if (frame === undefined || !existsSync(frame)) {
  console.error('用法：node app/edge-check.mjs <帧文件>')
  process.exit(1)
}

const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true })
const { width, height, channels } = info

/** 绿色主导度：背景为正，人物（皮肤/深蓝衣服/头发）接近 0 或为负。 */
const greenness = (i) => data[i + 1] - (data[i] + data[i + 2]) / 2

/**
 * 统计一个矩形区域内绿色像素占比。
 * @param x0 起始 x（含）
 * @param y0 起始 y（含）
 * @param w 宽
 * @param h 高
 */
function greenRatio(x0, y0, w, h) {
  let green = 0
  let total = 0
  for (let y = y0; y < Math.min(height, y0 + h); y += 2) {
    for (let x = x0; x < Math.min(width, x0 + w); x += 2) {
      const i = (y * width + x) * channels
      if (greenness(i) > 25) green += 1
      total += 1
    }
  }
  return total === 0 ? 0 : green / total
}

console.log(`帧：${frame}  ${width}×${height}\n`)
console.log('【四条边带的背景余量】（绿=背景占比，越高说明该边留白越足）')

const BAND = 24
const edges = [
  ['上边', 0, 0, width, BAND],
  ['下边', 0, height - BAND, width, BAND],
  ['左边', 0, 0, BAND, height],
  ['右边', width - BAND, 0, BAND, height],
]
const results = []
for (const [label, x, y, w, h] of edges) {
  const ratio = greenRatio(x, y, w, h)
  results.push({ label, ratio })
  const bar = '█'.repeat(Math.round(ratio * 20)).padEnd(20, '·')
  const verdict = ratio > 0.9 ? '✅ 余量充足' : ratio > 0.5 ? '🟡 部分被占' : '❌ 基本被人物占满'
  console.log(`  ${label}  ${bar} ${(ratio * 100).toFixed(0).padStart(3)}%  ${verdict}`)
}

// 逐行扫：找出"从上往下第一次出现非背景"的位置
let firstSolidRow = height
for (let y = 0; y < height; y += 2) {
  const ratio = greenRatio(0, y, width, 2)
  if (ratio < 0.35) { firstSolidRow = y; break }
}
console.log(`\n  从上往下，第 ${firstSolidRow}px 开始出现明显非背景内容（占画面高 ${(firstSolidRow / height * 100).toFixed(0)}%）`)
console.log(`  → 背景可用高度约 ${firstSolidRow}px`)

console.log('\n【判读】')
const worst = results.reduce((a, b) => (a.ratio < b.ratio ? a : b))
console.log(`  最紧的一条边是「${worst.label}」（背景占比 ${(worst.ratio * 100).toFixed(0)}%）`)
if (results.every((r) => r.ratio > 0.9)) {
  console.log('  ✅ 四条边都有充足背景余量，抠像后可直接叠到舞台上。')
} else if (worst.ratio > 0.5) {
  console.log('  🟡 有用余量但偏紧。抠像可行，但叠上去后人物会显得"顶格"，')
  console.log('     建议在舞台上给容器留内边距（padding），或改用 object-fit: contain。')
} else {
  console.log('  ❌ 人物顶到画面边缘、该边几乎没有背景。影响：')
  console.log('     · 抠像后这一侧没有透明余量，衣服会直接切在画面边界上')
  console.log('     · 舞台上无法做缩放/位移（一动就露馅）')
  console.log('     建议重生成这一条，把提示词里的景别放宽（见任务单的改进建议）。')
}

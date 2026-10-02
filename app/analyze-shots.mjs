// 对比两张手机截图，回答两个问题（像素级，不靠肉眼）：
//   ① 底色是不是纯黑、上下留的底色带在哪、颜色精确值多少
//   ② 键盘弹出前后，**立绘的包围盒有没有变**（变了＝UI 变形）
//
// 用法: node analyze-shots.mjs <A无键盘.png> <B有键盘.png>
import sharp from 'sharp'

const [pathA, pathB] = process.argv.slice(2)

async function load(p) {
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height, ch: info.channels }
}

/** 某个像素是否“几乎是黑的”（底色判定；JPEG/缩放会留 1-2 级噪声） */
const isBlackish = (r, g, b) => r <= 3 && g <= 3 && b <= 3

/** 统计每一行里非黑像素的数量 → 用于找立绘的上下边界 */
function rowProfile(img) {
  const rows = new Array(img.h).fill(0)
  for (let y = 0; y < img.h; y++) {
    let n = 0
    for (let x = 0; x < img.w; x += 2) {
      const i = (y * img.w + x) * img.ch
      if (!isBlackish(img.data[i], img.data[i + 1], img.data[i + 2])) n++
    }
    rows[y] = n
  }
  return rows
}

const px = (img, x, y) => {
  const i = (y * img.w + x) * img.ch
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}

const A = await load(pathA)
console.log(`A(无键盘) ${A.w}x${A.h}   B(有键盘) ${(await load(pathB)).w}x${(await load(pathB)).h}`)
const B = await load(pathB)

console.log('\n=== ① 底色采样（A：默认状态）===')
const probes = [
  ['屏幕左上角', 2, 2], ['顶部中间', Math.floor(A.w / 2), 160],
  ['左侧边缘中部', 2, Math.floor(A.h * 0.35)], ['右侧边缘中部', A.w - 3, Math.floor(A.h * 0.35)],
  ['她头顶上方(中部)', Math.floor(A.w / 2), 200],
]
for (const [label, x, y] of probes) {
  const v = px(A, x, y)
  const hex = '#' + v.map((n) => n.toString(16).padStart(2, '0')).join('')
  console.log(`  ${label.padEnd(18)} (${x},${y})  rgb(${v.join(',')})  ${hex}`)
}

console.log('\n=== ② 立绘包围盒（非黑内容的上下边界）===')
const profA = rowProfile(A)
const profB = rowProfile(B)
// 阈值：一行里超过 5% 宽度有非黑像素才算“有内容”
const th = Math.floor(A.w / 2 * 0.05)
const bounds = (prof) => {
  let top = -1, bottom = -1
  for (let y = 0; y < prof.length; y++) if (prof[y] > th) { top = y; break }
  for (let y = prof.length - 1; y >= 0; y--) if (prof[y] > th) { bottom = y; break }
  return { top, bottom }
}
const ba = bounds(profA)
const bb = bounds(profB)
console.log(`  A: 内容从 y=${ba.top} 到 y=${ba.bottom}   高度 ${ba.bottom - ba.top}px`)
console.log(`  B: 内容从 y=${bb.top} 到 y=${bb.bottom}   高度 ${bb.bottom - bb.top}px`)
console.log(`  差值：上边界 ${bb.top - ba.top}px  下边界 ${bb.bottom - ba.bottom}px  高度 ${(bb.bottom - bb.top) - (ba.bottom - ba.top)}px`)

console.log('\n=== ③ 几何判据：她「彩色像素」的包围盒（对动画免疫）===')
// 为什么不用逐像素差异：她是**动的**（序列帧每 2 秒换帧、随机眨眼、说话张口），
// 相隔几秒的两张截图必然大面积不同 —— 那测的是动画，不是变形（我第一版就栽在这）。
// 稳的判据是**几何**：她身上是彩色（肤色/蓝裙），背景与顶栏都是近黑中性色，
// 所以"彩色像素的包围盒"就是她的轮廓。键盘若让 UI 缩放，这个盒子必然明显变化。
const STAGE_TOP = 200, STAGE_BOTTOM = 2100
function silhouette(img) {
  let top = -1, bottom = -1, left = 1e9, right = -1, count = 0
  for (let y = STAGE_TOP; y < Math.min(STAGE_BOTTOM, img.h); y++) {
    for (let x = 0; x < img.w; x += 2) {
      const i = (y * img.w + x) * img.ch
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
      const sat = Math.max(r, g, b) - Math.min(r, g, b)
      const lum = (r + g + b) / 3
      if (sat > 20 && lum > 30) {                     // 彩色且不太暗 = 她
        count++
        if (top < 0) top = y
        bottom = y
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  return { top, bottom, left, right, h: bottom - top, w: right - left, count }
}
const sa = silhouette(A)
const sb = silhouette(B)
const show = (n, s) => console.log(`  ${n}: 高 ${s.h}px  宽 ${s.w}px  y ${s.top}→${s.bottom}  x ${s.left}→${s.right}  彩色像素 ${s.count}`)
show('A(无键盘)', sa)
show('B(有键盘)', sb)
const dh = Math.abs(sb.h - sa.h), dw = Math.abs(sb.w - sa.w), dy = Math.abs(sb.top - sa.top)
console.log(`  差：高 ${dh}px（${(dh / sa.h * 100).toFixed(1)}%）  宽 ${dw}px  顶边位移 ${dy}px`)
const ok = dh / sa.h < 0.05 && dy < 30
console.log(`\n  结论：${ok ? '✅ 她的尺寸与位置基本不变 → 键盘没有让 UI 变形' : '❌ 她的尺寸/位置明显变了 → 仍在变形'}`)
console.log('  （注：序列帧换姿势会让包围盒有几像素抖动，属正常）')

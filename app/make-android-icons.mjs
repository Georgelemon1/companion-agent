// 从参考图生成安卓启动图标（5 档密度 × 方形/圆形 = 10 个 PNG）
//
// 为什么另起一个而不是改 make-icons.mjs：那个是**手写 PNG 生成器**（逐像素画渐变+心形），
// 设计就是"不依赖图像库"。现在要用真实插画当图标，绘图那套用不上了；
// 而 sharp 在本项目里本来就有（import-papercut.mjs 等在用），直接用它做缩放与圆形遮罩最省事。
// 两个脚本都留着：make-icons.mjs 仍可生成占位图标（无素材时用）。
//
// 源图：deploy/android/icon-source.png（用户给的参考图，2048×2048）
// 产物：deploy/android/apk/res/mipmap-<density>/ic_launcher(_round).png
//
// ⚠️ 本脚本必须放在 app/ 下：Node 的裸模块名解析是按**脚本所在目录**向上找 node_modules，
//    放到 deploy/android/ 下会 `Cannot find module 'sharp'`（已实测踩过）。
import sharp from 'sharp'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'deploy/android/icon-source.png')
const RES = join(ROOT, 'deploy/android/apk/res')

/** 安卓各密度下 launcher 图标的边长（px） */
const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]

if (!existsSync(SRC)) throw new Error(`找不到源图：${SRC}`)

const meta = await sharp(SRC).metadata()
console.log(`源图 ${meta.width}×${meta.height} ${meta.format}`)

/** 圆形遮罩：按边长生成一个实心圆 SVG，用 dest-in 裁掉圆外像素 */
const circleMask = (size) =>
  Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  )

for (const [density, size] of DENSITIES) {
  const dir = join(RES, `mipmap-${density}`)
  mkdirSync(dir, { recursive: true })

  // 方形：按短边 cover 裁切后缩放，保留整张插画的构图
  const square = await sharp(SRC)
    .resize(size, size, { fit: 'cover', position: 'attention' })
    .png({ compressionLevel: 9 })
    .toBuffer()
  await sharp(square).toFile(join(dir, 'ic_launcher.png'))

  // 圆形：同样内容，再叠一层圆形遮罩（launchers 请求 roundIcon 时用这个）
  const round = await sharp(SRC)
    .resize(size, size, { fit: 'cover', position: 'attention' })
    .composite([{ input: circleMask(size), blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer()
  await sharp(round).toFile(join(dir, 'ic_launcher_round.png'))

  console.log(`  mipmap-${density}  ${size}×${size}  ✅`)
}

console.log('图标已生成（方形 + 圆形，共 10 个）')

// 剪纸/其他风格的立绘素材导入管线
//
// 把一个风格的 5 个源目录统一成舞台要的契约：
//   app/public/papercut/<set>/<n>.jpg   （24 张，全部 JPEG）
//
// 为什么必须过一道转码：
//   源素材是 PNG/JPEG 混装，甚至同一目录里两种都有（且常有 .png 后缀装真 JPEG 的）。
//   平台契约只认 `<n>.jpg` 一个后缀，所以统一转成 JPEG（q94，肉眼无损）。
//   顺带把超过 1600px 宽的长边压到 1600 —— 舞台最大显示尺寸约 420×748（手机框 contain），
//   再大只是白烧内存带宽（原来单张 4 MB 的 PNG，转完约 0.5 MB）。
//
// 用法：
//   node import-papercut.mjs papercut     # 剪纸风格（默认）
//   node import-papercut.mjs plain        # 非剪纸源素材
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 各风格的源目录。键名 = 导入时传给脚本的 <style>，也是写进 version.json 的风格标记。 */
const STYLES = {
  papercut: {
    idle: 'E:\\《赛博女友》剪纸',
    blink: 'E:\\《赛博女友》闭眼素材_剪纸',
    think: 'E:\\《赛博女友》思考素材_剪纸',
    'think-blink': 'E:\\《赛博女友》思考素材_剪纸_闭眼',
    mouth: 'E:\\《赛博女友》张嘴素材_剪纸',
  },
  plain: {
    idle: 'E:\\《赛博女友》',
    blink: 'E:\\《赛博女友》闭眼素材',
    think: 'E:\\《赛博女友》思考素材',
    'think-blink': 'E:\\《赛博女友》思考素材_闭眼',
    mouth: 'E:\\《赛博女友》张嘴素材',
  },
  pixel: {
    idle: 'E:\\《赛博女友》像素',
    blink: 'E:\\《赛博女友》闭眼素材_像素',
    think: 'E:\\《赛博女友》思考素材_像素',
    // ⚠️ 注意命名：像素批次的思考闭眼是 `..._闭眼_像素`，不是 `..._像素_闭眼`
    'think-blink': 'E:\\《赛博女友》思考素材_闭眼_像素',
    mouth: 'E:\\《赛博女友》张嘴素材_像素',
  },
}

/**
 * 各风格要不要用最近邻缩放（`image-rendering: pixelated`）。
 * 由 version.json 带给渲染层，渲染层照着设 —— 风格是素材的属性，不该写死在 CSS 里。
 */
const PIXELATED = { pixel: true }

const style = process.argv[2] ?? 'papercut'
const sources = STYLES[style]
if (sources === undefined) throw new Error(`未知风格: ${style}（可选：${Object.keys(STYLES).join(' / ')}）`)

const OUT = 'public/papercut'
const MAX_W = 1600
const IMG = /\.(png|jpe?g|webp|avif)$/i
const numOf = (f) => Number((f.match(/(\d+)(?=\.[a-z]+$)/i) ?? [])[1])

let total = 0
const report = []
// 像素批次：先把整批的**画布宽统一**成同一值再输出。
//
// 为什么：像素画在浏览器里用最近邻缩放（pixelated），采样相位取决于"源宽/显示宽"。
// 各帧源宽只要差几个像素（实测 1529 / 1534 / 1541），相位就跟着漂——
// 换帧时块边缘会轻微抖。统一画布宽后所有帧共用同一相位，这个变量就没了。
// 代价：不足 1% 的重采样（lanczos），肉眼不可见。
const widths = []
if (PIXELATED[style] === true) {
  for (const dir of Object.values(sources)) {
    for (const f of readdirSync(dir).filter((x) => IMG.test(x))) {
      const m = await sharp(join(dir, f)).metadata()
      if (m.width) widths.push(m.width)
    }
  }
}
const canvasW = widths.length > 0 ? Math.max(...widths) : null
if (canvasW !== null) console.log(`像素批次：统一画布宽 → ${canvasW}px（源宽 ${Math.min(...widths)}–${canvasW}）`)

for (const [set, dir] of Object.entries(sources)) {
  mkdirSync(join(OUT, set), { recursive: true })
  const files = readdirSync(dir).filter((f) => IMG.test(f))
    .map((f) => ({ f, n: numOf(f), full: join(dir, f) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n)

  for (const { f, n, full } of files) {
    const meta = await sharp(full).metadata()
    let pipe = sharp(full)
    if (canvasW !== null) pipe = pipe.resize({ width: canvasW })
    else if (meta.width > MAX_W) pipe = pipe.resize({ width: MAX_W })
    const out = join(OUT, set, `${n}.jpg`)
    await pipe.jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toFile(out)
    const kb = Math.round(statSync(out).size / 1024)
    total += kb
    report.push(`  ${set.padEnd(12)} ${String(n).padStart(2)}  ${f.padEnd(16)} ${meta.format.padEnd(5)} ${meta.width}x${meta.height}  →  ${kb} KB`)
  }
}
console.log(`风格 ${style} → ${OUT}/`)
console.log(report.join('\n'))
console.log(`共 ${report.length} 张，${(total / 1024).toFixed(1)} MB`)

// 供前端/验收读取的真实尺寸表（导入后各张分辨率不同，写下来便于排查"哪张糊"）
const dims = {}
for (const [set] of Object.entries(sources)) {
  dims[set] = {}
  for (const f of readdirSync(join(OUT, set))) {
    if (f === 'dims.json' || f === 'version.json') continue
    const m = await sharp(join(OUT, set, f)).metadata()
    dims[set][numOf(f)] = `${m.width}x${m.height}`
  }
}
writeFileSync(join(OUT, 'dims.json'), `${JSON.stringify(dims, null, 2)}\n`)
console.log('尺寸表已写入 public/papercut/dims.json')

// 批次版本号：前端拿它给素材 URL 加 `?v=`，于是**换批次即自动失效浏览器缓存**。
//
// 为什么必须有（踩过的坑）：图片按 `papercut/<set>/<n>.jpg` 命名，换批次不改名，
// 而图片走长缓存（max-age=86400）——用户刷新后看到的还是上一批画的画风。
// 版本号取"所有文件的 名字:大小"哈希，同一批内容不变（不会白刷缓存），换批次必变。
const sig = createHash('sha1')
for (const set of Object.keys(sources).sort()) {
  for (const f of readdirSync(join(OUT, set)).sort()) {
    if (f === 'dims.json' || f === 'version.json') continue
    sig.update(`${set}/${f}:${statSync(join(OUT, set, f)).size};`)
  }
}
const version = sig.digest('hex').slice(0, 12)
writeFileSync(
  join(OUT, 'version.json'),
  `${JSON.stringify({ v: version, style, pixelated: PIXELATED[style] === true, at: new Date().toISOString(), files: report.length }, null, 2)}\n`,
)
console.log(`批次版本 ${version} → public/papercut/version.json（风格=${style}，前端据此给素材 URL 加 ?v=${version}）`)

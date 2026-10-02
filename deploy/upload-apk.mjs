// 把 APK 传到 0x0.st（免登录的公开临时文件托管），拿到一个"点开就下载、后缀还是 .apk"的链接。
//
// 为什么需要它：微信在**接收端**把 .apk 改名成 .apk.1（客户端行为，文件本身改不了）。
// 但"发链接"不受影响 —— 接收方点链接走浏览器下载，保存下来就是 .apk，可以直接点安装。
//
// ⚠️ 这是**公开**托管：任何拿到链接的人都能下载这个 APK。这份 APK 里**内嵌了 API key**
//    （用户明确要求保留），所以链接一旦外传，key 就等于公开了。用户已知悉并要求这样做。
//
// 用法: node deploy/upload-apk.mjs
import { readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APK = join(HERE, '..', 'dist', 'android', 'companion-agent.apk')

const buf = readFileSync(APK)
const mb = (buf.length / 1024 / 1024).toFixed(1)
console.log(`  上传 ${basename(APK)}（${mb} MB）→ https://0x0.st …`)

const form = new FormData()
form.append('file', new Blob([buf], { type: 'application/vnd.android.package-archive' }), 'companion-agent.apk')
// 0x0.st 要求带 User-Agent，否则 403；Expires 让它多留一段时间
form.append('expires', '720')   // 小时（约 30 天；超过服务端上限会被自动下调）

const t0 = Date.now()
try {
  const r = await fetch('https://0x0.st', {
    method: 'POST',
    headers: { 'user-agent': 'companion-agent-dist/1.0 (+local build)' },
    body: form,
  })
  const text = (await r.text()).trim()
  console.log(`  HTTP ${r.status}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (r.ok && text.startsWith('http')) {
    console.log(`  ✅ 下载链接: ${text}`)
    console.log(`     任何人点这个链接 → 浏览器下载 ${text.split('/').pop()} → 直接点安装`)
  } else {
    console.log(`  ❌ 上传失败，服务端回复: ${text.slice(0, 300)}`)
  }
} catch (e) {
  console.log(`  ❌ 上传异常: ${e.name} ${e.message}`)
}

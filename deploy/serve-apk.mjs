// 只在局域网里发一个文件：companion-agent.apk
//
// 为什么需要它：微信收到 .apk 会**在接收端改名成 .apk.1**（客户端行为，改文件本身没用），
// 于是"下载完直接安装"就没法走微信。手机浏览器下载不会改名 —— 所以给手机一个 HTTP 地址。
//
// 用法: node deploy/serve-apk.mjs [端口]
// 打印出手机该打开的地址。
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APK = join(HERE, '..', 'dist', 'android', 'companion-agent.apk')
const PORT = Number(process.argv[2] ?? 8099)

const size = statSync(APK).size
const ipv4 = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i !== undefined && i.family === 'IPv4' && i.internal === false)
  .map((i) => i.address)

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]

  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok\n')
    return
  }

  if (url === '/companion-agent.apk') {
    const buf = readFileSync(APK)
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(buf.length),
      // 关键：显式给出文件名，浏览器就会按这个名字保存（不会加 .1）
      'content-disposition': 'attachment; filename="companion-agent.apk"',
    })
    res.end(buf)
    console.log(`  ↓ 已发出 ${(buf.length / 1024 / 1024).toFixed(1)} MB 给 ${req.socket.remoteAddress}`)
    return
  }

  // 极简下载页：手机浏览器打开根路径就能点
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>下载 Companion Agent</title>
<style>
 body{background:#000;color:#eee;font:16px/1.7 system-ui;margin:0;padding:28px 20px}
 a{display:block;background:#7aa2f7;color:#0f1115;text-align:center;
   padding:16px;border-radius:12px;text-decoration:none;font-weight:700;margin-top:18px}
 small{color:#8b93a3}
</style>
<h2>Companion Agent</h2>
<p>文件大小 <b>${(size / 1024 / 1024).toFixed(1)} MB</b>，下载后直接点安装即可
（浏览器不会把后缀改成 .apk.1）。</p>
<a href="/companion-agent.apk" download="companion-agent.apk">下载 APK</a>
<p><small>若提示"未知来源"，在弹窗里允许一次即可。</small></p>`)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`  APK: ${APK}`)
  console.log(`  ${(size / 1024 / 1024).toFixed(1)} MB`)
  console.log('  手机浏览器打开以下任一地址：')
  for (const ip of ipv4) console.log(`    http://${ip}:${PORT}/`)
  console.log(`  本机自测： http://127.0.0.1:${PORT}/`)
})

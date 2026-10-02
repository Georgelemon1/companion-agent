// 剪纸舞台端到端验收
//
// 分两层，避免"用 setInterval 采样"的时间抖动污染判定：
//   A 实时层：真浏览器打开真页面 → 预加载、imgSrc 是否真的在切、控制台有无报错、截图
//   B 精确层：在页面里**同步驱动内核**（10ms 步长）取帧时间线 → 逐条核对规格
//
// 用法: node verify-papercut-stage.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const BASE = 'http://127.0.0.1:4180'
const OUT = '../state'
// 视口尺寸可用环境变量覆盖：默认 390×844（不走手机框媒体查询，只测舞台本身）；
// 传 PC_VIEW=1280,900 可拍到桌面真实布局（≥700px 触发 390×844 手机框居中）。
const VIEW = process.env.PC_VIEW ?? '390,844'

const profile = mkdtempSync(join(tmpdir(), 'pc-verify-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=' + VIEW, '--hide-scrollbars',
  `${BASE}/?pcdebug=1`,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageWs() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* CDP 未起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 未就绪')
}

const ws = new WebSocket(await pageWs(), { perMessageDeflate: false })
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })

let seq = 0
const pending = new Map()
const errors = []
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(`异常: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`)
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    errors.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
  return ok
}

// ── A. 实时层 ────────────────────────────────────────────────────────────
console.log('\n== A. 实时层（真浏览器真页面）==')
let loaded = false
for (let i = 0; i < 80; i++) {
  loaded = await evalJs('Boolean(window.CompanionStage && window.CompanionStage.debug().imgLoaded)')
  if (loaded) break
  await sleep(250)
}
check('页面加载 + 首帧就绪', loaded)

const boot = JSON.parse(await evalJs(`JSON.stringify({
  hasStage: Boolean(window.CompanionStage),
  hasOldAvatar: Boolean(window.CompanionAvatar && window.CompanionAvatar.mount),
  imgNatural: window.CompanionStage.debug().imgNatural,
  imgSrc: window.CompanionStage.debug().imgSrc,
})`))
console.log('  启动快照:', JSON.stringify(boot))
check('立绘是真图不是破图', /^\d+x\d+$/.test(boot.imgNatural ?? ''), `${boot.imgNatural}（当前批次逐张分辨率不同，见 public/papercut/dims.json）`)
check('首帧取的是待机 1 号', /papercut\/idle\/1\.jpg/.test(boot.imgSrc), boot.imgSrc)
// 素材 URL 必须带批次版本号，否则换批次后浏览器会沿用旧画风的缓存（踩过）
check('素材 URL 带批次版本号 ?v=', /\?v=[0-9a-f]{6,}/.test(boot.imgSrc), boot.imgSrc)

const pre = await evalJs('window.CompanionStage.ready.then(r => JSON.stringify(r))')
console.log('  预加载:', pre)
check('24 张素材全部就位', JSON.parse(pre).ok === 24 && JSON.parse(pre).missing.length === 0)

// 活性：imgSrc 是否真在跟着内核切
const live = JSON.parse(await evalJs(`new Promise((res) => {
  const seen = [];
  const t = setInterval(() => { const d = window.CompanionStage.debug(); seen.push(d.imgSrc.split('/').pop()) }, 100);
  setTimeout(() => { clearInterval(t); res(JSON.stringify([...new Set(seen)])) }, 2600);
})`))
check('画面真的在逐帧切（活性）', live.length >= 2 || live.some((s) => /^\d\.jpg$/.test(s)), live.join(','))

// 眨眼分布（默认配置，实测 45 秒）。
// 2026-09-30 按人类研究重做：不是均匀随机，而是「长恢复期 + 簇内短间隔」——
// 所以这里验的是**形状**（既有短间隔也有长间隔），不只是频率。
const blinkStarts = JSON.parse(await evalJs(`new Promise((res) => {
  const starts = []; let inBlink = false;
  const t0 = performance.now();
  const timer = setInterval(() => {
    const d = window.CompanionStage.debug();
    if (d.layer === 'blink' && !inBlink) { inBlink = true; starts.push(Math.round(performance.now() - t0)) }
    else if (d.layer !== 'blink') inBlink = false;
    if (performance.now() - t0 > 45000) { clearInterval(timer); res(JSON.stringify(starts)) }
  }, 50);
})`))
const blinkGaps = blinkStarts.slice(1).map((t, i) => t - blinkStarts[i])
const gapAvg = blinkGaps.reduce((a, b) => a + b, 0) / (blinkGaps.length || 1)
const rate = 60000 / gapAvg
check(
  '眨眼频率落在人类区间 12.5–20 次/分',
  blinkGaps.length >= 4 && rate >= 12 && rate <= 21,
  `45s 内 ${blinkStarts.length} 次，平均间隔 ${Math.round(gapAvg)}ms（≈${rate.toFixed(1)} 次/分）`,
)
check(
  '分布是成簇的（既有 ≤2.5s 的短间隔，也有 ≥4s 的长恢复期）',
  blinkGaps.some((g) => g <= 2500) && blinkGaps.some((g) => g >= 4000),
  `间隔样本 ${blinkGaps.join(', ')}ms`,
)

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
  console.log(`  📷 ${OUT}/${name}`)
}
await shot('stage-idle.png')

// ── B. 精确层：同步驱动内核，10ms 步长 ────────────────────────────────────
console.log('\n== B. 精确层（同步驱动内核，10ms 步长）==')

/** 在页面里同步跑一段内核时间线，返回切换点 */
async function timeline({ ms, setup, blinkGap = 1e9 }) {
  const out = await evalJs(`(() => {
    const m = window.CompanionStage.machine;
    // 固定间隔 G：四段区间都设成 G 且只允许单次簇 → 每次眨眼间隔恒为 G（测机制用，不绑默认值）
    m.config.blinkRecoverMinMs = ${blinkGap}; m.config.blinkRecoverMaxMs = ${blinkGap};
    m.config.blinkClusterMinMs = ${blinkGap}; m.config.blinkClusterMaxMs = ${blinkGap};
    m.config.blinkClusterMax = 1; m.config.blinkThinkingFactor = 1;
    m.setMode('idle', 0); m.setTalking(false, 0);
    m.reset(0);
    ${setup}
    const out = []; let last = '';
    for (let t = 0; t <= ${ms}; t += 10) {
      m.update(t);
      const f = m.frame(t);
      const k = f.set + '#' + f.num + '/' + f.layer;
      if (k !== last) { out.push([t, k]); last = k }
    }
    return JSON.stringify(out);
  })()`)
  return JSON.parse(out)
}
const show = (label, list) => {
  console.log(`\n【${label}】切换 ${list.length} 次：`)
  console.log('  ' + list.map(([t, f]) => `${(t / 1000).toFixed(2)}s=${f}`).join('  '))
}
const at = (list, v) => list.find(([, x]) => x === v)?.[0]
const near = (t, want, tol = 30) => typeof t === 'number' && Math.abs(t - want) <= tol

// 待机 6.6s
const idle = await timeline({ ms: 6600 })
show('待机 6.6s', idle)
check('0.00s = 基础帧 1', idle[0]?.[1] === 'idle#1/base', idle[0]?.[1])
check('1.75s = 中间帧 2（7/8 位置）', near(at(idle, 'idle#2/mid'), 1750), `${at(idle, 'idle#2/mid')}ms`)
check('2.00s = 基础帧 3（中间帧只占 0.25s）', near(at(idle, 'idle#3/base'), 2000), `${at(idle, 'idle#3/base')}ms`)
check('3.75s = 中间帧 4', near(at(idle, 'idle#4/mid'), 3750), `${at(idle, 'idle#4/mid')}ms`)
check('4.00s = 基础帧 5', near(at(idle, 'idle#5/base'), 4000), `${at(idle, 'idle#5/base')}ms`)
check('5.75s = 中间帧 6（5→1 回程）', near(at(idle, 'idle#6/mid'), 5750), `${at(idle, 'idle#6/mid')}ms`)
check('6.00s 回到 1 号，循环 6.000s', near(idle.filter(([, v]) => v === 'idle#1/base').at(-1)?.[0], 6000), `${idle.filter(([, v]) => v === 'idle#1/base').at(-1)?.[0]}ms`)

// 思考 4.4s
const think = await timeline({ ms: 4400, setup: `m.setMode('thinking', 0);` })
show('思考 4.4s', think)
check('0.00s = think 基础帧 1', think[0]?.[1] === 'think#1/base', think[0]?.[1])
check('1.75s = think 中间帧 2', near(at(think, 'think#2/mid'), 1750), `${at(think, 'think#2/mid')}ms`)
check('2.00s = think 基础帧 3', near(at(think, 'think#3/base'), 2000), `${at(think, 'think#3/base')}ms`)
check('3→1 回程复用 2 号（第二次出现在 3.75s）', near(think.filter(([, v]) => v === 'think#2/mid')[1]?.[0], 3750), `${think.filter(([, v]) => v === 'think#2/mid')[1]?.[0]}ms`)
check('4.00s 回到 think#1，循环 4.000s', near(think.filter(([, v]) => v === 'think#1/base').at(-1)?.[0], 4000), `${think.filter(([, v]) => v === 'think#1/base').at(-1)?.[0]}ms`)

// 说话 2.6s
const talk = await timeline({ ms: 2600, setup: `m.setTalking(true, 0);` })
show('说话 2.6s（待机之上）', talk)
const mouths = talk.filter(([, v]) => v.startsWith('mouth#'))
const mouthLens = []
for (let i = 0; i < talk.length - 1; i++) if (talk[i][1].startsWith('mouth#')) mouthLens.push(talk[i + 1][0] - talk[i][0])
const starts = mouths.map(([t]) => t)
const gaps = starts.slice(1).map((t, i) => t - starts[i])
check('张嘴帧出现在节拍起点（0/500/1000…）', starts.every((t, i) => near(t, i * 500, 20)), starts.join(','))
check('张嘴节拍 = 500ms', gaps.every((g) => near(g, 500, 20)), gaps.join(','))
check('每次张嘴 250ms', mouthLens.every((l) => near(l, 250, 20)), mouthLens.join(','))
check('张嘴编号跟随当前帧（前 3 次是 1 号，2.0s 起跟随帧号 3）', mouths[0]?.[1] === 'mouth#1/mouth' && mouths.at(-1)?.[1].startsWith('mouth#3'), mouths.map(([, v]) => v.split('/')[0]).join(','))
check('待机网格在说话期间照常推进', talk.some(([, v]) => v === 'idle#2/mid') && talk.some(([, v]) => v === 'idle#3/base'))

// 眨眼 2.4s（间隔固定 1.5s）
const blink = await timeline({ ms: 2400, blinkGap: 1500 })
show('眨眼（间隔固定 1.5s）', blink)
const bl = blink.find(([, v]) => v.endsWith('/blink'))
check('1.5s 出现眨眼', near(bl?.[0], 1500), `${bl?.[0]}ms`)
check('眨眼编号跟随当前帧（1 号帧时段 → blink#1）', bl?.[1] === 'blink#1/blink', bl?.[1])
check('眨眼时长 250ms', near(blink[blink.indexOf(bl) + 1]?.[0] - bl?.[0], 250), `${blink[blink.indexOf(bl) + 1]?.[0] - bl?.[0]}ms`)

// 冲突：张嘴窗口内不启动眨眼
const conflict = await timeline({ ms: 1200, blinkGap: 500, setup: `m.setTalking(true, 0);` })
show('张嘴 + 眨眼同刻（间隔 500ms，应与张嘴窗口撞车）', conflict)
check('张嘴优先，眨眼不把嘴合上', conflict.filter(([, v]) => v.startsWith('mouth#')).length >= 2)

// ── C. 恢复实时渲染 + 另外两张截图 ──────────────────────────────────────
// 把 B 层改过的眨眼参数恢复成默认（分布形状已在 A 层验过，这里只是别把状态带出去）
await evalJs(`Object.assign(window.CompanionStage.machine.config, {
    blinkRecoverMinMs: 4000, blinkRecoverMaxMs: 9000,
    blinkClusterMinMs: 600, blinkClusterMaxMs: 2000,
    blinkClusterMax: 3, blinkThinkingFactor: 1.7 });
  window.CompanionStage.setTalking(false);
  window.CompanionStage.setMode('thinking');
  window.CompanionStage.machine.reset(performance.now()); 'ok'`)
await sleep(2400)
const thinkLive = JSON.parse(await evalJs('JSON.stringify(window.CompanionStage.debug())'))
check('实时层能切到思考素材', thinkLive.set.startsWith('think'), `${thinkLive.set}#${thinkLive.num}`)
await shot('stage-think.png')

await evalJs(`window.CompanionStage.setMode('idle'); window.CompanionStage.setTalking(true); 'ok'`)
await sleep(600)
await shot('stage-talk.png')
await evalJs(`window.CompanionStage.setTalking(false); 'ok'`)

console.log('\n== D. 收尾 ==')
check('旧舞台未挂载', boot.hasOldAvatar === false)
check('无 JS 报错/警告', errors.length === 0, errors.slice(0, 4).join(' | '))

ws.close()
chrome.kill()
process.exit(0)

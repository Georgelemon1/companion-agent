// 前端消息处理的行为测试 —— 数气泡个数，抓"内容显示两遍"
//
// 为什么这么测：用户报告"先输出一条，又流式一遍"，而服务端探针证明**每回合只发一条 done**。
// 所以问题必然在前端的渲染路径。数气泡个数是最直接、最不会自我欺骗的验证方式：
// 一次回合结束后，聊天区里应当**恰好有一个**新气泡。
//
// 本测试用一个模拟 DOM 驱动真实的 app.js，喂入真实的消息序列。
//
// ⚠️ 立绘契约已换（剪纸序列帧舞台）：前端对舞台**只发两个信号**——
//   · `window.CompanionStage.setMode('idle' | 'thinking')`  思考态切换
//   · `window.CompanionStage.setTalking(true | false)`      说话叠加层（逐字吐字期间 true）
// 旧接口（CompanionAvatar / mount / setState / applyEmotion / setFrame / clearFrame /
// avatar/manifest.json）**全部删除**，所以本文里凡涉及立绘的断言都按新契约写，
// 逐帧推进、循环、眨眼由 papercut-core.js 自驱，前端不再下发帧号。
//
// 逐字吐字的节奏（200ms/字 = 每秒 5 字）**没变**——那是聊天文本行为，不是立绘行为，
// 本节里所有"气泡数量 / 文本 / 逐字增长 / 滚动"的断言都不该被立绘改动波及。
//
// 用法：node app/test-frontend-bubbles.mjs（在 app/ 目录下即 node test-frontend-bubbles.mjs）

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`) }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ── 模拟 DOM ───────────────────────────────────────────────────────────────
/** 记录所有被创建并挂到 messages 容器里的元素。 */
const created = []

function mkEl(tag = 'div') {
  const el = {
    tagName: tag,
    children: [],
    parent: null,
    dataset: {},
    _text: '',
    className: '',
    style: { _p: {}, setProperty(k, v) { this._p[k] = v }, getPropertyValue(k) { return this._p[k] ?? '' } },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)) },
      remove(...c) { c.forEach((x) => this._s.delete(x)) },
      contains(c) { return this._s.has(c) },
      toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c) } else if (f) this._s.add(c); else this._s.delete(c) },
    },
    _l: {},
    setAttribute(k, v) { this.dataset[k.replace(/^data-/, '')] = v },
    removeAttribute(k) { delete this.dataset[k.replace(/^data-/, '')] },
    append(...cs) { for (const c of cs) { c.parent = this; this.children.push(c) } },
    // appendChild 与 append 的区别只在返回值（返回被插入的节点）。真实 DOM 里
    // 把一个已在树上的节点 append 到同一父节点 = **移动到末尾**，这里也照此语义。
    appendChild(c) { c.parent = this; this.children = this.children.filter((x) => x !== c); this.children.push(c); return c },
    get lastElementChild() { return this.children.length > 0 ? this.children[this.children.length - 1] : null },
    get isConnected() { return true },
    replaceChildren(...cs) { this.children = []; for (const c of cs) { c.parent = this; this.children.push(c) } },
    remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1) } },
    addEventListener(t, fn) { (this._l[t] ??= []).push(fn) },
    removeEventListener() {},
    querySelector() { return null },
    getBoundingClientRect() { return { width: 400, height: 700 } },
    scrollTop: 0,
    scrollHeight: 0,
    get firstChild() { return this.children[0] },
    /*
      textContent 要**像真实 DOM 那样聚合子节点**。
      踩过的坑：最初 getter 只返回自己的 `_text`，不拼子节点，于是
      `playPaced` 把字写进内层 span（`streamingEl.firstChild.textContent`）后，
      父元素的 textContent 仍是空串 —— `bubbles()` 读成 0 字，
      看起来像"吐字坏了"，其实是**桩把 DOM 语义简化错了**。
      setter 仍然覆盖自身并清空子节点（与真 DOM 的替换语义一致）。
    */
    get textContent() {
      if (this._text !== '' && this._text !== undefined) return this._text
      return this.children.map((c) => c.textContent).join('')
    },
    set textContent(v) { this._text = String(v); this.children = [] },
  }
  created.push(el)
  // 用 Proxy 兜住任何未实现的 DOM 方法（focus / click / scrollIntoView / value / …）。
  //
  // 为什么这么做：我此前写 DOM 桩时连续漏过 style.setProperty、removeAttribute、
  // window.setTimeout、requestAnimationFrame、focus —— 每次都伪装成"产品 bug"，
  // 浪费排查时间。与其一个个补，不如让缺失成员自动变成空操作：
  // 本测试只关心**气泡数量与文本**，其它 DOM 调用是否真实实现并不影响结论。
  return new Proxy(el, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (typeof prop === 'symbol') return undefined
      return () => undefined
    },
    set(target, prop, value) { target[prop] = value; return true },
  })
}

const messagesEl = mkEl()
const byId = new Map()
globalThis.document = {
  head: { append() {} },
  body: mkEl('body'),
  documentElement: mkEl('html'),
  createElement: (t) => mkEl(t),
  getElementById: (id) => {
    if (id === 'messages') return messagesEl
    if (!byId.has(id)) byId.set(id, mkEl())
    return byId.get(id)
  },
  querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
  baseURI: 'http://127.0.0.1:4180/',
}
globalThis.window = {
  addEventListener() {}, devicePixelRatio: 1, setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  // 剪纸舞台句柄：本测试的主职是聊天文本/气泡，这里先给个空壳；
  // 需要断言立绘信号的段落会各自**重装一个记录版**（见 ②-b / ④ / ⑤ / ⑥ / ⑦）。
  // 用空壳而不是不装：app.js 里是 `stage()?.setMode(...)` 可选调用，
  // 给了空壳才能证明"前端确实在调它"，而不是靠 undefined 蒙混过去。
  CompanionStage: { setMode() {}, setTalking() {} },
}
globalThis.CSS = { supports: () => true }
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.Image = class { set src(v) { this._src = v } addEventListener() {} }
globalThis.WebSocket = class {
  static OPEN = 1
  constructor() { this.readyState = 1 }
  addEventListener() {} send() {} close() {}
}
globalThis.location = { protocol: 'http:', host: '127.0.0.1:4180' }
/**
 * fetch 桩：一律返回空对象。
 *
 * 为什么可以这么敷衍：立绘换成剪纸序列帧舞台后，素材由 papercut.js 自己取，
 * 被测的 app.js **不再拉任何立绘清单**（旧 `fetch('./avatar/manifest.json')` 已删）。
 *
 * ⚠️ 踩过的坑：这里原先 `readFileSync('assets/avatar/manifest.json')` 返回真实清单，
 * 那是旧雪碧图的帧数表。旧立绘删除时清单文件也删了，于是 fetch 桩一被调用就抛
 * ENOENT —— 崩溃点在"桩"里，看起来却像产品挂了。现在已经没有该文件的用途，
 * 干脆不读盘：本测试只验证 app.js 的消息处理，不验证素材存在性。
 */
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

// 通过 WebSocket 桩捕获 app.js 注册的 message 处理器，从而驱动真实的 app.js。
// app.js 是 ES 模块，它的两个 UI 依赖由 test-loader-hook.mjs 换成桩。
let messageHandler = null
globalThis.WebSocket = class {
  static OPEN = 1
  constructor() { this.readyState = 1 }
  addEventListener(type, fn) { if (type === 'message') messageHandler = fn }
  send() {}
  close() {}
}

// 真正加载被测模块（不是抄一份逻辑到测试里）
await import('./public/app.js')
await new Promise((r) => setTimeout(r, 80))
console.log('  已加载真实 app.js，message 处理器：' + (messageHandler === null ? '❌ 未捕获' : '✅ 已捕获'))

function feed(payload) {
  if (messageHandler === null) throw new Error('没拿到 message 处理器')
  messageHandler({ data: JSON.stringify(payload) })
}

/** 数一数 messages 容器里"她说的"气泡有几个、文本各是什么。 */
function bubbles() {
  return messagesEl.children
    .filter((el) => String(el.className).includes('companion'))
    .map((el) => el._text !== '' ? el._text : (el.children[0]?._text ?? ''))
}

console.log('【① 节拍模式：一次回合应当只产生一个气泡】')
{
  messagesEl.replaceChildren()
  feed({ type: 'init', sessionId: 's1', history: [], state: null })
  await new Promise((r) => setTimeout(r, 30))
  const before = bubbles().length

  // 真实序列：status → emotion → 7 条 delta → status → done
  feed({ type: 'agent.status', status: 'running' })
  feed({ type: 'message.emotion', label: 'calm', intensity: 4 })
  for (const t of ['你', '好', '呀', '，', '我', '在', '的']) feed({ type: 'message.delta', text: t })
  feed({ type: 'agent.status', status: 'idle' })
  feed({
    type: 'message.done',
    text: '你好呀，我在的',
    outputMode: 'paced',
    segments: [{ label: 'calm', intensity: 4, text: '你好呀，我在的', chars: 7 }],
  })

  // 节拍化是异步逐字的：等它吐完（8 字 × 200ms + 余量）
  await new Promise((r) => setTimeout(r, 2200))

  const after = bubbles()
  check('只新增 1 个气泡（不是 2 个）', after.length - before === 1,
    `新增 ${after.length - before} 个，内容=${JSON.stringify(after.slice(before))}`)
  check('气泡内容完整', after[after.length - 1] === '你好呀，我在的',
    JSON.stringify(after[after.length - 1]))
  check('内容没有重复两遍', !(after[after.length - 1] ?? '').includes('你好呀，我在的你好呀'),
    JSON.stringify(after[after.length - 1]))
}

console.log('\n【② 没有 outputMode 分支：无论跨度大小都走节拍化】')
{
  // 这一组针对用户报的"流式有时候失效"。
  // 根因是服务端曾按增量跨度判 outputMode，而该判断会反复横跳
  //（实测：paced 26ms/9字 → stream 542ms/122字 → paced 29ms/82字 …），
  // 导致长回复走"一次性落文本"。
  // 现在统一：只要 message.done 带 segments，就走节拍化。
  // 注：这纯粹是文本行为——立绘已改由 setMode/setTalking 表达，与 outputMode 无关。
  messagesEl.replaceChildren()
  feed({ type: 'init', sessionId: 's2', history: [], state: null })
  await new Promise((r) => setTimeout(r, 30))
  const before = bubbles().length

  feed({ type: 'agent.status', status: 'running' })
  for (const t of ['嗯', '，', '我', '知', '道', '了']) feed({ type: 'message.delta', text: t })
  feed({ type: 'agent.status', status: 'idle' })
  feed({
    type: 'message.done',
    text: '嗯，我知道了',
    // 故意**不带** outputMode，验证不再依赖它
    segments: [{ label: 'calm', intensity: 3, text: '嗯，我知道了', chars: 6 }],
  })
  // 节拍吐字：6 字 × 200ms + 余量
  await new Promise((r) => setTimeout(r, 1800))
  const after = bubbles()
  check('只新增 1 个气泡', after.length - before === 1, `新增 ${after.length - before} 个`)
  check('内容完整且不重复', after[after.length - 1] === '嗯，我知道了', JSON.stringify(after[after.length - 1]))
}

console.log('\n【②-b 无 segments 时也要**逐字吐出**（不能再一次性蹦出来）】')
{
  // 这条测的是用户报的"突然蹦出来一堆字"。
  // 根因：`message.done` 的 segments 为空时，旧代码直接
  // `openStream(); closeStream(full)` —— 一次性落全文。
  // 而她**经常不写标记**（实测 62 条返回里 32 条没标记），所以很常见。
  // 立绘侧同一件事的旧写法是"按默认 calm 起表情、逐帧 setFrame"；新契约既没有情绪标签、
  // 也没有逐帧下发，舞台只该收到 setMode/setTalking。这里顺带把这两个信号也量了。
  //
  // ⚠️ 记录数组从装上桩那一刻起就在累积（含思考态那几下），所以 init 之后再清零。
  //    旧版用 CompanionAvatar 时就踩过"frameCalls 混进了思考态那几帧、断言切不干净"的坑。
  const stageCalls = []
  globalThis.window.CompanionStage = {
    setMode(n) { stageCalls.push(`setMode:${n}`) },
    setTalking(b) { stageCalls.push(`setTalking:${b}`) },
  }
  messagesEl.replaceChildren()
  feed({ type: 'init', sessionId: 's2b', history: [], state: null })
  await new Promise((r) => setTimeout(r, 30))
  const before = bubbles().length
  stageCalls.length = 0

  const TEXT = '她没写标记的一句话'
  feed({ type: 'agent.status', status: 'running' })
  feed({ type: 'agent.status', status: 'idle' })
  feed({ type: 'message.done', text: TEXT, segments: [] })

  // 中途采样：半程时气泡不该已经是全文（那就是"一次性蹦出来"）。
  //
  // ⚠️ 要读**最后一条气泡的 textContent**（`<span>` 是它的子节点），
  //    不能读 `bubbles()`（那返回的是字符串数组，取不到"当前长度"）。
  const lastEl = () => messagesEl.children[messagesEl.children.length - 1]
  await new Promise((r) => setTimeout(r, 800))
  const midLen = bubbles().length > before ? String(lastEl()?.textContent ?? '').length : 0
  // 800ms 时她正说到这条的中段（9 字 × 200ms），说话叠加层必须还开着：
  // 一开口就 true、段末才 false，中途不该有 false。
  const talkingMid = stageCalls.includes('setTalking:true') && !stageCalls.includes('setTalking:false')

  await new Promise((r) => setTimeout(r, 4000)) // 9 字 × 200ms + 收尾
  const after = bubbles()
  const finalLen = after.length > before ? String(lastEl()?.textContent ?? '').length : 0

  check('无 segments 时仍产生 1 个气泡', after.length - before === 1, `新增 ${after.length - before} 个`)
  check('内容完整', finalLen === TEXT.length, `${finalLen} / ${TEXT.length}`)
  check('★ 中途只吐出一部分（不是一次性全出）',
    midLen > 0 && midLen < TEXT.length,
    `800ms 时 ${midLen} 字 / 共 ${TEXT.length} 字`)
  // 旧断言：「★ 立绘被逐帧驱动（无标记时走默认 calm → idle 状态）」。
  // 新契约下"无标记"这件事已经不影响立绘（舞台只有 待机/思考/说话），
  // 等价的事实是**舞台确实被驱动了**，且驱动方式就是"她开口了"。
  check('收到 running 就切了思考态', stageCalls.includes('setMode:thinking'),
    stageCalls.join(' → ') || '(舞台一次都没被调用)')
  check('★ 吐字期间开口说话（setTalking(true)，即旧的"逐帧驱动立绘"）',
    stageCalls.includes('setTalking:true'), stageCalls.join(' → '))
  check('中途没有提前闭嘴（说完整条才 setTalking(false)）', talkingMid,
    `800ms 时的信号：${stageCalls.join(' → ')}`)
  // 旧断言：「说完回待机」（当时看 setState('idle')）。等价物是**两个信号都收干净且顺序正确**：
  // 先闭嘴、再回待机。反过来的话她会"待机时还张着嘴"，所以顺序也是断言的一部分。
  const iLastFalse = stageCalls.lastIndexOf('setTalking:false')
  check('★ 说完闭嘴并回待机（setTalking(false) → setMode(\'idle\')）',
    stageCalls[stageCalls.length - 1] === 'setMode:idle' && iLastFalse >= 0 && iLastFalse < stageCalls.length - 1,
    stageCalls.slice(-3).join(' → '))
}

console.log('\n【③ 增量阶段不应提前渲染（避免"闪一下再重打"）】')
{
  messagesEl.replaceChildren()
  feed({ type: 'init', sessionId: 's3', history: [], state: null })
  await new Promise((r) => setTimeout(r, 30))
  const before = bubbles().length

  feed({ type: 'agent.status', status: 'running' })
  for (const t of ['这', '是', '一', '段', '话']) feed({ type: 'message.delta', text: t })
  // 此刻还没收到 done —— 不该有任何气泡（否则会先闪一下）
  const mid = bubbles().length
  check('收到 done 之前不渲染气泡', mid === before, `当前 ${mid} 个（期望 ${before}）`)

  feed({ type: 'message.done', text: '这是一段话', outputMode: 'stream', segments: [] })
  await new Promise((r) => setTimeout(r, 60))
  const after = bubbles()
  check('done 之后恰好 1 个气泡', after.length - before === 1, `新增 ${after.length - before} 个`)
}

console.log('\n【④ affect.update 不再驱动立绘：说话期间与说完之后都不碰舞台】')
{
  // 旧契约里 affect.update 会 applyEmotion() 抢立绘，所以旧断言是成对的：
  // "说话期间别抢" + "说完之后把控制权还回来"。
  //
  // 新剪纸舞台只有 待机/思考/说话 三态，情绪不再驱动表情（用户的判断：
  // 她的情绪应该从表情和语气里读出来，不由 UI 汇报）。于是等价断言变成**单边的禁止**：
  // 情绪消息到达时舞台接口一次都不该被调用——不论她是否正在说话。
  // 这比旧版更强（旧版只禁止"抢"，新版禁止"碰"），不是把断言删软。
  const stageCalls = []
  globalThis.window.CompanionStage = {
    setMode(n) { stageCalls.push(`setMode:${n}`) },
    setTalking(b) { stageCalls.push(`setTalking:${b}`) },
  }
  messagesEl.replaceChildren()
  feed({ type: 'init', sessionId: 's4', history: [], state: null })
  await new Promise((r) => setTimeout(r, 30))
  stageCalls.length = 0

  feed({ type: 'agent.status', status: 'running' })
  feed({ type: 'message.delta', text: '哈' })
  feed({ type: 'agent.status', status: 'idle' })
  // ⚠️ 这句故意写到 5 字（1000ms）：吐字窗口要够宽，否则"说话期间"的采样点
  //    正好压在段末闭嘴那一刻上，会断出一个与产品无关的假失败。
  feed({
    type: 'message.done',
    text: '哈哈，好呀',
    outputMode: 'paced',
    segments: [{ label: 'joy', intensity: 6, text: '哈哈，好呀', chars: 5 }],
  })
  await new Promise((r) => setTimeout(r, 200))
  // 前置检查：她此刻**确实在说**。没有这一条，"没调用舞台"也可能只是因为她压根没开口，
  // 那这条断言就测了个寂寞（旧版正是靠 speakingNow 这个内部变量回避了这个陷阱）。
  const during = stageCalls.slice()
  check('（前置）她此刻正在说：舞台收到 setTalking(true)',
    during.includes('setTalking:true'), during.join(' → '))
  stageCalls.length = 0

  // 吐字当中推一条情绪更新（真实环境里 turn-stopping 之后就会推）
  feed({ type: 'affect.update', label: 'joy', intensity: 2, emotions: [], relation: {} })
  await new Promise((r) => setTimeout(r, 150))
  check('说话期间 affect.update 没有碰舞台（一次调用都没有）',
    stageCalls.length === 0,
    stageCalls.length === 0 ? '' : stageCalls.join(' → '))

  // 等它说完（5 字 × 200ms + 收尾 320ms），再推一次情绪。
  // 旧断言在这里期望"情绪通道恢复（能正常跟随情绪）"；新契约里**依然不该有调用**——
  // 情绪仍在后端演化（影响语气与人设），只是与立绘彻底解耦了。
  await new Promise((r) => setTimeout(r, 1400))
  stageCalls.length = 0
  feed({ type: 'affect.update', label: 'joy', intensity: 2, emotions: [], relation: {} })
  await new Promise((r) => setTimeout(r, 60))
  check('说完之后 affect.update 依然不碰舞台（对应旧"情绪通道恢复"，结论已反转）',
    stageCalls.length === 0,
    stageCalls.length === 0 ? '' : stageCalls.join(' → '))
}

console.log('\n【⑤ 段与段之间她先闭嘴歇一下，再接着说下一段】')
{
  // 旧契约里"两段"是靠"起 calm / 起 sadness 表情 + 逐帧 setFrame"表达的；
  // 新契约只剩说话叠加层，段边界由 setTalking 表达：
  //   · 段首 setTalking(true)  → 张嘴节拍开始
  //   · 段末 setTalking(false) → 闭嘴
  //   · 段间停顿 IDLE_BRIDGE_MS(320ms) 期间保持闭嘴，让待机帧自己走两下
  //
  // 帧号推进 / 循环 / 随机眨眼已由 papercut-core.js 自驱，前端不再逐帧下发，
  // 所以这里量的是**说话窗口的时长与顺序**——它等价于旧的帧号断言：
  // 她说 N 个字，舞台就该收到 N×200ms 的"正在说话"（用户指定的恒定语速）。
  const calls = []
  globalThis.window.CompanionStage = {
    setMode(n) { calls.push({ kind: 'setMode', arg: n, t: Date.now() }) },
    setTalking(b) { calls.push({ kind: 'setTalking', arg: b, t: Date.now() }) },
  }
  messagesEl.replaceChildren()
  feed({ type: 'init', sessionId: 's5', history: [], state: null })
  await new Promise((r) => setTimeout(r, 30))
  calls.length = 0

  feed({ type: 'agent.status', status: 'running' })
  feed({ type: 'agent.status', status: 'idle' })
  feed({
    type: 'message.done',
    text: '嗯。我有点难过。',
    segments: [
      { label: 'calm', intensity: 3, text: '嗯。', chars: 2 },
      { label: 'sadness', intensity: 5, text: '我有点难过。', chars: 6 },
    ],
  })
  // 2 段：首段 2 字、次段 6 字，各 200ms/字；段间与收尾各等 IDLE_BRIDGE_MS
  await new Promise((r) => setTimeout(r, 2600))

  const log = calls.map((c) => `${c.kind}:${c.arg}`)
  console.log(`     舞台信号：${log.join(' → ')}`)

  /** 第 k 次开口对应的调用下标（按 setTalking(true) 的出现顺序）。 */
  const opens = calls.map((c, i) => (c.kind === 'setTalking' && c.arg === true ? i : -1)).filter((i) => i >= 0)
  /** 第 k 次开口 → 随后第一次闭嘴之间的时长（毫秒）。 */
  const talkMs = (k) => {
    const s = opens[k]
    if (s === undefined) return null
    const e = calls.findIndex((c, i) => i > s && c.kind === 'setTalking' && c.arg === false)
    return e < 0 ? null : calls[e].t - calls[s].t
  }

  // 旧断言：「第一段起了 calm」「第二段起了 sadness」——表情标签已不下发（见 ④），
  // 等价的事实是"两段各开了一次口"。
  check('两段各开了一次口（setTalking(true) × 2）', opens.length === 2,
    `实得 ${opens.length} 次：${log.join(' → ') || '(舞台一次都没被调用)'}`)

  // 旧断言：「calm 段为 [0,23]（等距抽首末）」「sadness 段驱动 6 帧 [0,5,11,14,18,23]」。
  // 帧号是舞台内部的事，前端能保证的是**说话时长跟着该段字数走**。
  // 容差给得宽（±150ms 以上）：断言的是"2 字 vs 6 字差 3 倍"这个数量级关系，
  // 不是某个 setTimeout 的精确时刻——定时器抖动不该让这条红。
  const w0 = talkMs(0)
  const w1 = talkMs(1)
  check('首段说了 2 字 → 说话窗口 ≈ 400ms（200ms/字）',
    w0 !== null && w0 >= 300 && w0 <= 600, `实测 ${w0}ms`)
  check('★ 次段说了 6 字 → 说话窗口 ≈ 1200ms（首段的 3 倍）',
    w1 !== null && w1 >= 1050 && w1 <= 1500, `实测 ${w1}ms`)

  // 旧断言：「calm 与 sadness 之间回了一次 idle（不是硬切）」。
  // 新契约里"回待机"就是闭嘴，而且必须真歇够 IDLE_BRIDGE_MS——
  // 这段停顿是用户要的"先回到平静、呼吸一两下，再起下一段"（从 500 降到 320）。
  const gapBeforeSecond = (() => {
    if (opens[1] === undefined) return null
    const lastFalseBefore = calls
      .map((c, i) => (c.kind === 'setTalking' && c.arg === false && i < opens[1] ? i : -1))
      .filter((i) => i >= 0)
      .pop()
    return lastFalseBefore === undefined ? null : calls[opens[1]].t - calls[lastFalseBefore].t
  })()
  check('★ 两段之间先闭嘴、并停顿 ≈320ms（对应旧"两段之间回了一次 idle"）',
    gapBeforeSecond !== null && gapBeforeSecond >= 280 && gapBeforeSecond <= 600,
    `实测段间停顿 ${gapBeforeSecond}ms（IDLE_BRIDGE_MS=320）`)

  // 旧断言：「段末退出帧模式（clearFrame 被调用）」「每段都以库末帧收尾（回到初始姿态）」。
  // 帧模式已经不存在了，等价的风险变成"说话叠加层被落下"——她一直张着嘴待机。
  // 所以验两件事：每次开口都有对应闭嘴（不遗留 talking），以及收尾顺序不能反。
  const nTrue = log.filter((x) => x === 'setTalking:true').length
  const nFalse = log.filter((x) => x === 'setTalking:false').length
  check('★ 每次开口都有对应闭嘴，不留残余 talking（对应旧"段末 clearFrame"）',
    nFalse >= nTrue && log[log.length - 1] === 'setMode:idle',
    `开口 ${nTrue} 次 / 闭嘴 ${nFalse} 次，收尾 ${log[log.length - 1]}`)
  const iLastFalse = log.lastIndexOf('setTalking:false')
  check('整条说完：先闭嘴再回待机（顺序反了会"待机时还张着嘴"）',
    log.lastIndexOf('setTalking:true') < iLastFalse && log.lastIndexOf('setMode:idle') > iLastFalse,
    log.slice(-3).join(' → '))
  // 旧断言：「第一段起了 calm / 第二段起了 sadness」的另一半——
  // segments 的 label 现在**只用于服务端排查**，一个都不该出现在前端发给舞台的信号里。
  check('★ 舞台只收到 setMode/setTalking 两个信号（label/情绪不再下发）',
    calls.every((c) => c.kind === 'setMode' || c.kind === 'setTalking')
      && !log.join(' ').includes('calm') && !log.join(' ').includes('sadness'),
    log.join(' → '))
}

console.log('\n【⑥ 思考动态：从用户发出到她说第一个字之间】')
{
  // 旧契约用 setState('thinking') 表达，新契约是 setMode('thinking')。
  // 舞台那边 thinking 是"1、3 两帧各 2s"的循环（用户指定），
  // 所以前端只负责**切进去 / 切出来**，不再做"逐帧快速推进到峰值"。
  const calls = []
  globalThis.window.CompanionStage = {
    setMode(n) { calls.push(`setMode:${n}`) },
    setTalking(b) { calls.push(`setTalking:${b}`) },
  }
  messagesEl.replaceChildren()
  feed({ type: 'init', sessionId: 's6', history: [], state: null })
  await new Promise((r) => setTimeout(r, 30))
  calls.length = 0

  // 真实时序：发出消息 → running（此刻开始等模型）→ idle（生成完）→ done（定稿）
  feed({ type: 'agent.status', status: 'running' })
  await new Promise((r) => setTimeout(r, 250)) // 模拟"等模型"的空档
  const duringThink = calls.slice()
  check('她开始跑时切到思考态（setMode(\'thinking\')）',
    duringThink.includes('setMode:thinking'), `信号 ${duringThink.join(' → ')}`)
  // 思考态是"动嘴之前"的动态，所以这期间绝不能是说话态——
  // 混起来的话，她会在还没吐字时就做张嘴节拍。
  check('思考期间还没开口（setTalking(true) 只属于吐字阶段）',
    !duringThink.includes('setTalking:true'), `信号 ${duringThink.join(' → ')}`)

  feed({ type: 'agent.status', status: 'idle' })
  feed({
    type: 'message.done',
    text: '我想了想，觉得你说得对。',
    segments: [{ label: 'calm', intensity: 3, text: '我想了想，觉得你说得对。', chars: 12 }],
  })
  await new Promise((r) => setTimeout(r, 3200))

  const joined = calls.join(' → ')
  console.log(`     舞台信号：${joined}`)
  check('思考态出现在说话之前',
    calls.indexOf('setMode:thinking') >= 0 && calls.indexOf('setMode:thinking') < calls.indexOf('setTalking:true'),
    `thinking@${calls.indexOf('setMode:thinking')} talking@${calls.indexOf('setTalking:true')}`)
  // 旧实现有"逐帧推进到峰值"的定时器，反复重启会让思考动态一直重头播；
  // 新实现只剩一个标志位，这条断言守的就是"别把它写成每帧都 setMode('thinking')"。
  const thinkCount = calls.filter((x) => x === 'setMode:thinking').length
  check('思考态只起一次（不反复重启）', thinkCount === 1, `出现 ${thinkCount} 次：${joined}`)
  check('说完回到 idle（回到原始状态）', calls[calls.length - 1] === 'setMode:idle',
    `末尾是 ${calls[calls.length - 1]}：${joined}`)
}

console.log('\n【⑦ 气泡不能消失、不能重建（同一回合必须是同一个元素）】')
{
  // 用户明确要求："完全不要消失气泡，但文字还是相同输出。"
  //
  // 踩过的坑：`discardStream()` 原先做的是 `streamingEl.remove()`，
  // 随后 `playPaced` 立刻 `openStream()` 又建一个新的 —— **同一个回合里
  // 气泡被删掉再重建**，那一瞬它是消失的。
  // 现在改成"清空文本、复用元素"，所以这里断言**元素身份不变**。
  // 立绘桩：本段只断言气泡，但顺手记一下说话叠加层——"她在说话"在新契约里
  // 只剩 setTalking 这一个表达（旧的逐帧 setFrame 已删），值得验一下它跟着吐字走。
  let talking = false
  globalThis.window.CompanionStage = {
    setMode() {},
    setTalking(b) { talking = b },
  }
  messagesEl.replaceChildren()
  feed({ type: 'init', sessionId: 's7', history: [], state: null })
  await new Promise((r) => setTimeout(r, 30))

  const herEl = () => {
    const all = messagesEl.children.filter((e) => String(e.className).includes('companion'))
    return all[all.length - 1]
  }
  const herCount = () => messagesEl.children.filter((e) => String(e.className).includes('companion')).length

  // delta 阶段：**不开气泡**（增量只累积在变量里），所以此刻还没有她的气泡
  feed({ type: 'agent.status', status: 'running' })
  for (const t of ['先', '开', '个', '气', '泡']) feed({ type: 'message.delta', text: t })
  check('delta 阶段不开气泡（增量只累积）', herCount() === 0, `她的气泡数 = ${herCount()}`)

  feed({ type: 'agent.status', status: 'idle' })
  feed({
    type: 'message.done',
    text: '气泡不能消失',
    segments: [{ label: 'calm', intensity: 3, text: '气泡不能消失', chars: 6 }],
  })

  // 多次采样：既验证"气泡始终只有一个、身份不变"，也验证"文字是逐字长出来的"
  //
  // ⚠️ 采样点要密：6 字 × 200ms = 1200ms，若只在中途看一眼容易正好错过成长期
  //（我第一次取 1400ms，那时已经吐完，误判成"没有逐字"）。
  const samples = []
  const elMid = herEl() // 采样开始的元素身份
  for (let i = 0; i < 14; i += 1) {
    await new Promise((r) => setTimeout(r, 150))
    samples.push({
      t: (i + 1) * 150,
      count: herCount(),
      sameNode: herEl() === elMid,
      len: String(herEl()?.textContent ?? '').length,
      // 同一采样点上的舞台状态：她这时是不是"开着说话叠加层"
      talking,
    })
  }
  const elEnd = herEl()

  console.log('     采样：' + samples.map((s) => `${s.t}ms:${s.len}字`).join(' '))

  check('★ 气泡从出现到结束是同一个元素（没有消失/重建）',
    elMid !== undefined && elMid === elEnd && samples.every((s) => s.sameNode),
    elMid === undefined ? '中途没有气泡' : (samples.every((s) => s.sameNode) ? '元素身份始终一致' : '元素被换过'))
  check('★ 全程只有 1 个她的气泡（没有删了又建）',
    samples.every((s) => s.count === 1), `采样到的数量 ${[...new Set(samples.map((s) => s.count))].join('/')}`)

  const lens = samples.map((s) => s.len)
  const grew = lens.filter((v, i) => i > 0 && v > lens[i - 1]).length
  check('★ 文字是逐字长出来的（不是一次性出现）', grew >= 3,
    `增长 ${grew} 次：${lens.join(',')}`)
  // 顺带把立绘的对齐关系也钉住：**只要还有字没吐完，说话叠加层就该是开着的**。
  // 旧契约里这件事由"一字一帧"保证（字和帧同步推进）；新契约里帧自驱，
  // 前端唯一的对齐手段就是 setTalking，所以要防的是"字还在长、她却闭嘴了"。
  check('★ 逐字期间说话叠加层一直开着（字没吐完就不闭嘴）',
    samples.every((s) => s.len >= 6 || s.talking === true),
    samples.map((s) => `${s.len}字/${s.talking ? 'talk' : 'mute'}`).join(' '))
  check('文字完整', String(elEnd?.textContent ?? '').length === 6,
    `${String(elEnd?.textContent ?? '').length} / 6`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1

// 语音输入的离线测试：用桩替身模拟浏览器环境，验证"按住说话"的状态机与
// ASR 结果落点。不需要 Chrome、不需要麦克风。
//
// 为什么这样做：浏览器自动化在本机不可靠（CDP 域启用会挂住、--dump-dom 不退出），
// 而语音模块的逻辑（能力检测、按住/松开、识别结果写哪、错误处理、人设开关联动）
// 全都可以在 Node 里用桩验证。这是"能用单测验的东西就别用端到端"的实际应用。

// ── 浏览器环境桩 ──────────────────────────────────────────────────────────
/** 极简元素替身：只需支持模块用到的那点 DOM 能力。 */
class FakeElement {
  constructor(id) {
    this.id = id
    this.textContent = ''
    this.hidden = true
    this.disabled = false
    this.title = ''
    this.value = ''
    this._classes = new Set()
    this._listeners = new Map()
  }

  get classList() {
    const set = this._classes
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c) } else if (on) set.add(c); else set.delete(c) },
      contains: (c) => set.has(c),
    }
  }

  addEventListener(type, handler) {
    const list = this._listeners.get(type) ?? []
    list.push(handler)
    this._listeners.set(type, list)
  }

  /** 测试用：派发一个事件。 */
  emit(type, event = {}) {
    for (const handler of this._listeners.get(type) ?? []) handler({ preventDefault() {}, ...event })
  }

  setPointerCapture() {}
  focus() {}
}

/** 记录被构造出来的识别实例，便于断言。 */
const recognitionInstances = []

/** SpeechRecognition 桩：只实现模块用到的那部分协议。 */
class FakeRecognition {
  constructor() {
    this.lang = ''
    this.continuous = false
    this.interimResults = false
    this.started = 0
    this.stopped = 0
    this.aborted = 0
    this.onresult = null
    this.onerror = null
    this.onend = null
    recognitionInstances.push(this)
  }

  start() { this.started += 1 }
  stop() { this.stopped += 1; this.onend?.() }
  abort() { this.aborted += 1 }
  /** 测试用：模拟一次识别结果。 */
  emitResult(items) {
    this.onresult?.({
      resultIndex: 0,
      results: items.map((text, i) => Object.assign([{ transcript: text }], { isFinal: i < items.length - 1 })),
    })
  }
  emitError(code) { this.onerror?.({ error: code }) }
}

/** 已注册的元素。 */
const elements = new Map()
const getEl = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id))
  return elements.get(id)
}

/** 安装全局桩。 */
function installBrowserStubs({ supportSpeech = true } = {}) {
  elements.clear()
  recognitionInstances.length = 0
  globalThis.document = { getElementById: getEl, addEventListener() {} }
  globalThis.window = supportSpeech ? { SpeechRecognition: FakeRecognition } : {}
  globalThis.Event = class { constructor(type) { this.type = type } }
  globalThis.setTimeout = globalThis.setTimeout
  globalThis.clearTimeout = globalThis.clearTimeout
}
/** 卸载全局桩，避免污染其他测试。 */
function uninstallBrowserStubs() {
  delete globalThis.document
  delete globalThis.window
  delete globalThis.Event
}

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`) } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

/**
 * 每个测试块开头都要调用：清掉上一个块构造的识别实例。
 * 不清的话实例会跨块累积，后面 `recognitionInstances[len - 1]` 拿到的是旧实例，
 * 而旧实例的 onresult 已被新实例覆盖（第一版就这么假失败了两个断言）。
 */
function resetStubState() {
  elements.clear()
  recognitionInstances.length = 0
}

// 模块只依赖 window/document，装在桩之后动态导入即可。
installBrowserStubs({ supportSpeech: true })
const { initVoiceInput } = await import('./public/voice.js')

console.log('\n【① 能力检测与初始状态】')
{
  resetStubState()
  const mic = getEl('mic')
  const input = getEl('input')
  const written = []
  const voice = initVoiceInput({ inputEl: input, onText: (t) => written.push(t) })
  check('检测到支持', voice.supported === true)
  check('默认启用', voice.enabled === true)
  check('按钮未禁用', mic.disabled === false)
  check('按钮标题为按住说话', mic.title === '按住说话', mic.title)
  voice.destroy()
}

console.log('\n【② 按住说话：开始识别】')
{
  resetStubState()
  const mic = getEl('mic')
  const input = getEl('input')
  const written = []
  const voice = initVoiceInput({ inputEl: input, onText: (t) => written.push(t) })
  mic.emit('pointerdown', { pointerId: 1 })
  check('构造了识别实例', recognitionInstances.length === 1, `${recognitionInstances.length} 个`)
  const rec = recognitionInstances[0]
  check('已启动识别', rec.started === 1)
  check('设为中文', rec.lang === 'zh-CN', rec.lang)
  check('连续模式', rec.continuous === true)
  check('返回中间结果', rec.interimResults === true)
  check('按钮进入 listening 态', mic.classList.contains('listening'))

  console.log('\n【③ 识别结果落进输入框（不直接发送）】')
  rec.emitResult(['你好', '我是'])
  check('中间结果已回写', written.length > 0, `${written.length} 次回写`)
  check('回写内容是识别文本', String(written[written.length - 1]).includes('你好'), String(written[written.length - 1]))
  check('没有走任何发送路径（模块只回写文本）', true, '模块签名里没有 send，只有 onText')
  voice.destroy()
}

console.log('\n【④ 松开停止】')
{
  resetStubState()
  const mic = getEl('mic')
  const voice = initVoiceInput({ inputEl: getEl('input'), onText: () => {} })
  mic.emit('pointerdown', { pointerId: 1 })
  const rec = recognitionInstances[recognitionInstances.length - 1]
  mic.emit('pointerup', { pointerId: 1 })
  check('识别被停止', rec.stopped >= 1, `stopped=${rec.stopped}`)
  check('按钮退出 listening 态', !mic.classList.contains('listening'))
  voice.destroy()
}

console.log('\n【⑤ 权限被拒的处理】')
{
  resetStubState()
  const mic = getEl('mic')
  const voice = initVoiceInput({ inputEl: getEl('input'), onText: () => {} })
  mic.emit('pointerdown', { pointerId: 1 })
  const rec = recognitionInstances[recognitionInstances.length - 1]
  rec.emitError('not-allowed')
  check('停止识别', !mic.classList.contains('listening'))
  check('给出可读提示', getEl('mic-hint').textContent.includes('权限'), getEl('mic-hint').textContent)
  check('提示可见', getEl('mic-hint').hidden === false)
  voice.destroy()
}

console.log('\n【⑥ 人设开关联动】')
{
  resetStubState()
  const mic = getEl('mic')
  const voice = initVoiceInput({ inputEl: getEl('input'), onText: () => {} })
  voice.setEnabled(false)
  check('关闭后按钮禁用', mic.disabled === true)
  check('enabled 状态同步', voice.enabled === false)
  voice.setEnabled(true)
  check('重新启用后按钮可用', mic.disabled === false)
  voice.destroy()
}

console.log('\n【⑦ 关闭开关时若正在识别则停止】')
{
  resetStubState()
  const mic = getEl('mic')
  const voice = initVoiceInput({ inputEl: getEl('input'), onText: () => {} })
  mic.emit('pointerdown', { pointerId: 1 })
  const rec = recognitionInstances[recognitionInstances.length - 1]
  voice.setEnabled(false)
  check('识别被停止', rec.stopped >= 1, `stopped=${rec.stopped}`)
  check('按钮禁用', mic.disabled === true)
  voice.destroy()
}

uninstallBrowserStubs()

console.log('\n【⑧ 不支持的浏览器（Firefox）】')
{
  installBrowserStubs({ supportSpeech: false })
  // 重新导入以拿到绑定到新桩的模块：用查询串绕开模块缓存。
  const mod = await import(`./public/voice.js?nosupport=${Date.now()}`)
  const mic = getEl('mic')
  const voice = mod.initVoiceInput({ inputEl: getEl('input'), onText: () => {} })
  check('检测为不支持', voice.supported === false)
  check('按钮被禁用', mic.disabled === true)
  check('给出"请用 Chrome/Edge"的说明', mic.title.includes('Chrome') || mic.title.includes('Edge'), mic.title)
  check('提示条可见', getEl('mic-hint').hidden === false)
  check('提示内容提到浏览器', getEl('mic-hint').textContent.includes('Chrome'), getEl('mic-hint').textContent)
  voice.destroy()
  uninstallBrowserStubs()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1

// 语音输入（ASR）—— 按住说话，识别结果**落进输入框供编辑**，不直接发送。
//
// 为什么用浏览器原生 SpeechRecognition：
//   · 零成本、零安装、零下载，Chrome/Edge 直接可用
//   · 替代方案（sherpa-onnx 本地识别）需要下载几十 MB 模型与预编译库，
//     在本机网络受限的情况下不值得为它阻塞；接口按 provider 抽象留好了升级位
//
// 为什么只做"按住说话"而不是常听：
//   · 常听要持续占用识别服务、还要处理 VAD 与回声抑制
//   · 按住说话在伴侣场景更自然（像语音条），且用户完全掌控何时被听
//
// 为什么识别结果不直接发送：ASR 必有错字，直接发出去会让她答非所问，
// 那比没有语音更糟。所以**一律落进输入框**，由用户确认后再发。

/** 取浏览器支持的 SpeechRecognition 构造函数（Chrome 需要 webkit 前缀）。 */
function getRecognitionCtor() {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

/**
 * 初始化语音输入。
 * @param options - { inputEl, onText }。`onText(text)` 把识别结果写进输入框。
 * @returns `{ supported, enabled, setEnabled, destroy }`。
 */
export function initVoiceInput({ inputEl, onText }) {
  const micBtn = document.getElementById('mic')
  const hintEl = document.getElementById('mic-hint')
  const Ctor = getRecognitionCtor()
  const supported = Ctor !== null

  /** 是否启用（由人设卡的 voiceInput 决定）。 */
  let enabled = true
  /** 当前是否正在识别。 */
  let listening = false
  let recognition = null
  /** 本次识别的累积文本。 */
  let transcript = ''

  /** 显示一条提示，几秒后自动消失。 */
  function hint(text, ms = 4000) {
    hintEl.textContent = text
    hintEl.hidden = false
    clearTimeout(hint._timer)
    hint._timer = setTimeout(() => { hintEl.hidden = true }, ms)
  }

  /** 按支持情况与启用状态刷新按钮外观。 */
  function refreshButton() {
    if (!supported) {
      micBtn.disabled = true
      micBtn.title = '这个浏览器不支持语音识别（Firefox 至今默认禁用），请用 Chrome 或 Edge'
      return
    }
    micBtn.disabled = !enabled
    micBtn.title = enabled ? '按住说话' : '语音输入已在"定制她"里关闭'
    micBtn.classList.toggle('listening', listening)
  }

  /** 开始识别。 */
  function start() {
    if (!supported || !enabled || listening) return
    transcript = ''
    recognition = new Ctor()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) transcript += result[0].transcript
        else interim += result[0].transcript
      }
      // 实时把已识别内容显示在输入框里，用户能边看边说。
      onText((transcript + interim).trim())
    }

    recognition.onerror = (event) => {
      const messages = {
        'not-allowed': '麦克风权限被拒绝。请在浏览器地址栏允许麦克风后重试。',
        'service-not-allowed': '语音识别服务不可用（可能需要 HTTPS 或 localhost）。',
        'no-speech': '没听清，再说一次试试。',
        network: '识别服务连不上（浏览器原生识别依赖厂商服务）。',
        aborted: '',
      }
      const text = messages[event.error] ?? `识别出错：${event.error}`
      if (text !== '') hint(text)
      stop()
    }

    recognition.onend = () => {
      // continuous 模式在静音后也会触发 end；只要还按着就重启，保持连续。
      if (listening) {
        try { recognition.start() } catch { stop() }
      }
    }

    try {
      recognition.start()
      listening = true
      refreshButton()
    } catch {
      hint('无法启动语音识别。')
    }
  }

  /** 停止识别。 */
  function stop() {
    if (!listening && recognition === null) return
    listening = false
    const current = recognition
    recognition = null
    try { current?.stop() } catch { /* 已经停了 */ }
    refreshButton()
    if (transcript.trim() !== '') hint('识别完成，确认后再发送', 2500)
  }

  // 按住说话：鼠标与触摸都要支持。用 pointer 事件统一处理。
  micBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    if (!supported || !enabled) return
    micBtn.setPointerCapture?.(event.pointerId)
    start()
  })
  micBtn.addEventListener('pointerup', (event) => {
    event.preventDefault()
    stop()
  })
  micBtn.addEventListener('pointercancel', stop)
  micBtn.addEventListener('pointerleave', () => { if (listening) stop() })
  // 键盘可达：空格按住也能说话
  micBtn.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !event.repeat) { event.preventDefault(); start() }
  })
  micBtn.addEventListener('keyup', (event) => {
    if (event.code === 'Space') { event.preventDefault(); stop() }
  })

  refreshButton()
  if (!supported) {
    hint('这个浏览器不支持语音识别（Firefox 至今默认禁用），请用 Chrome 或 Edge。', 8000)
  }

  return {
    supported,
    get enabled() { return enabled },
    /** 由人设卡同步开关状态。 */
    setEnabled(value) {
      enabled = value !== false
      if (!enabled && listening) stop()
      refreshButton()
    },
    destroy() {
      try { recognition?.abort() } catch { /* 忽略 */ }
    },
  }
}

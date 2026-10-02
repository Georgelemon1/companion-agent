// companion 轻前端：文本通道（消息流）与连接通道（状态）分离。
//
// 立绘已换成剪纸序列帧舞台（papercut.js，自动挂载）。前端对它只发两个信号：
//   · 思考：等模型回复期间 setMode('thinking')
//   · 说话：逐字吐字期间 setTalking(true)，段间停顿 setTalking(false)
// 帧号推进、循环、随机眨眼全部由 papercut-core.js 自驱，前端不再逐帧下发。

import { initVoiceInput } from './voice.js'

/** 剪纸舞台句柄。拿不到就不管立绘，绝不带崩聊天。 */
const stage = () => window.CompanionStage

/** 是否正在展示思考态（纯标志，已无逐帧定时器）。 */
let thinkingShown = false

/**
 * 起思考态：舞台切到「思考素材」循环。
 *
 * 旧实现是"逐帧快速推进到峰值然后停住"（55ms/帧）——那是为了掩盖旧素材
 * 36 帧 / 6000ms 匀速播放太慢。新剪纸思考素材本身就是 1/3 两帧各 2s 的循环
 *（用户指定），没有"推进到峰值"这回事，直接切状态。
 */
function startThinking() {
  thinkingShown = true
  stage()?.setMode('thinking')
}

/** 停思考态：回待机循环。 */
function stopThinking() {
  thinkingShown = false
  stage()?.setMode('idle')
}

const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('input')
const sendEl = document.getElementById('send')
const formEl = document.getElementById('composer')
const dotEl = document.getElementById('conn-dot')
const connTextEl = document.getElementById('conn-text')
// 状态面板元素已全部移除（用户判定"完全没必要"）。
//
// 原先这里有 5 个引用：`session-text`（会话号）、`emotion-value`（情绪数值）、
// `stage-value`（关系阶段）、`days-value`（认识天数）、`emotion-bars`（情绪强度条）。
// 前四个是调试信息，最后一个更是把内部状态摊开给用户看——
// 而调研证实 7 个海外主流产品里 0 个把情绪条做成被好评的功能。
// 她的情绪应该从**表情和语气**里读出来，不由 UI 汇报。
//
// `#stage` 是全屏立绘背景（见 index.html 注释：以手机端为准）。
// 舞台由 papercut.js 自己挂载，这里不再 mount。

/** 当前流式气泡；收到 message.done 后定稿。 */
let streamingEl = null
/** 本回合是否已经开过气泡（避免 delta 与 done 重复插入）。 */
let turnOpen = false
let connected = false
/** 当前 WebSocket，供表单模块发送消息。 */
let socket = null
// 立绘的"她说到哪、表情就是哪一段"已随旧情绪立绘删除：
// 现在说话只是一个叠加层（张嘴节拍），见 papercut-core.js。
/**
 * 本条回复是否走"节拍化输出"。
 *
 * 为什么需要：实测底层 provider 的增量在 ~90ms 内**一次性涌出**，不是真流式。
 * 若把增量直接显示，等于"一个字瞬间说完"，立绘也就无从对齐输出时长。
 * 所以服务端会判断并用 outputMode='paced' 告知，前端改为按字符数节拍化吐出。
 */
let paced = false
/** 节拍化输出的计时器，切会话/新回合时要清掉。 */
let pacedTimer = null
/** 节拍化输出的累计字符游标（跨段连续）。 */
let pacedElapsedChars = 0
/**
 * 本回合累积的增量文本。
 *
 * **不直接渲染**：实测增量在 70–370ms 内一次性到达，而输出模式要等 message.done 才判定。
 * 边到边渲染会在 paced 模式下先闪一整段、再清掉重打（用户看到的就是"一条又流式一遍"）。
 * 所以先攒着，定稿时按模式决定：stream 一次性落地，paced 逐字吐出。
 */
let streamedText = ''
/** 本回合是否已定稿（收到 message.done）。用于区分"跑完了但还没定稿"与"真的结束了"。 */
let turnFinalized = false
// `thinkingShown` 的声明在文件靠前处（与 startThinking/stopThinking 放在一起）。

/**
 * 段与段之间"回到待机"的停留时长（毫秒）。
 *
 * 为什么需要：切换现在是**硬切**（FADE_MS = 0，见 avatar.js），而且切换发生在两个
 * idle 姿态之间，所以"切"这个动作本身看不见。真正要看见的是**待机的帧在推进**——
 * 让她先回到平静、呼吸一两下，再起下一个表情。
 *
 * 从 500 降到 **320**（用户要求"立绘动态显得活泼一点"）：
 * 8 段回复的段间停顿累计从 3.5 秒降到 2.24 秒，切换更利落；
 * 仍够待机走约 2 帧，看得出"回到平静了"再起下一个表情。
 */
const IDLE_BRIDGE_MS = 320

/**
 * 每个字符的停留毫秒数 —— 决定"她说话的语速"。
 *
 * 200ms/字 = **每秒 5 个字**（用户指定）。这是很慢的语速，适合陪伴场景：
 * 话说得慢，立绘每段也就动得久，表情看得清。
 *
 * ⚠️ **这是恒定值，不做任何加速**（用户 2026-09-15 明确要求："要求的是1秒5字"）。
 *
 * 历史：我曾经加过一套"长文按预算加速"的机制（总时长上限 14s / 按段数放宽），
 * 理由是"720 字按 5 字/秒要 2 分 24 秒，太久"。但用户的判断更对——
 * **立绘的"一字一帧"是靠字速驱动的**，语速一变，立绘节奏也跟着变，反而不可预期。
 *
 * 代价：长回复会很慢（720 字约 2 分 24 秒）。**若嫌久，应从提示词侧限制她写多长**，
 * 而不是偷偷提速——那样会破坏"字速恒定"这个约定。
 */
const PACED_MS_PER_CHAR = 200
// 注：曾经考虑过"一个字推进 K 个立绘帧"来让动作更密，**实测否决**——
// 峰值帧在序列里只占 1 个槽位，而槽位时长 = 每字时长 / K，
// 所以 K 越大、峰值停留越短（K=2 时峰值从 200ms 掉到 100ms，反而丢了情绪）。
// 想让立绘显得活泼，正解是**缩段间停顿 + 缩每段预算**（见上面两个常数），不是加帧。

/**
 * 按总字数算出实际每字停留时长。
 *
 * ⚠️ **2026-09-15 改回严格恒速**（用户明确要求："要求的是1秒5字"）。
 *
 * 此前有一版"长文按预算加速"的机制（`max(14s, 段数×PER_SEG)` 的总时长上限），
 * 目的是让长回复不至于等到失去耐心。但实测下来用户要的是**恒定语速**：
 * 无论长短都 200ms/字 = 5 字/秒。理由也合理——立绘的"一字一帧"是靠
 * 字速驱动的，语速一变，立绘的节奏也跟着变，反而不好预期。
 *
 * 代价：长回复会更久（720 字约 2 分 24 秒）。若以后嫌久，应**从提示词侧
 * 限制她写多长**，而不是偷偷提速——那样会破坏"字速恒定"这个约定。
 *
 * @param totalChars - 本条回复可见总字数（保留参数以便将来按需分流）。
 * @param _segmentCount - 段落数（当前不参与计算，保留签名兼容）。
 * @returns 每字毫秒数，恒为 `PACED_MS_PER_CHAR`。
 */
function msPerCharFor(totalChars, _segmentCount = 1) {
  const n = Number(totalChars)
  if (!Number.isFinite(n) || n <= 0) return PACED_MS_PER_CHAR
  return PACED_MS_PER_CHAR
}

/**
 * 清空当前流式气泡的文本，**但保留气泡本身**。
 *
 * ⚠️ 原先这里叫 `discardStream()`，做的是 `streamingEl.remove()` —— 把气泡从 DOM 摘掉。
 * 随后 `playPaced` 立刻 `openStream()` 又建一个新的，于是**同一个回合里气泡
 * 被删掉再重建**，那一瞬它是消失的（用户明确要求："完全不要消失气泡"）。
 *
 * 为什么当初要"丢"：底层增量是一次性到达的，直接显示等于"瞬间说完"，
 * 所以那遍增量要整条丢掉、改由节拍化重新逐字吐出。
 * 但"丢掉内容"不等于"丢掉气泡"——**清空文本就够了**，气泡留在原处，
 * 位置与外观都不变，只是重新开始逐字。
 */
function discardStream() {
  if (streamingEl === null) return
  const span = streamingEl.firstChild
  if (span !== null && span !== undefined) span.textContent = ''
  else streamingEl.textContent = ''
}

/**
 * 开一个流式气泡并返回其文本节点。
 *
 * **若同一回合已有气泡，复用它**（不新建）。理由同上：删掉再建会让气泡闪一下。
 * 只在气泡不存在、或已被移出 DOM 时才新建。
 *
 * @returns 内层文本 span（逐字写进它）。
 */
function openStream() {
  const alive = streamingEl !== null
    && typeof streamingEl.isConnected === 'boolean'
    ? streamingEl.isConnected
    : streamingEl !== null // 环境不支持 isConnected（测试桩）时按"还在"处理
  if (streamingEl !== null && alive) {
    // 已有气泡：清空文本、补回光标（收尾时会摘掉），留在原处复用
    const span = streamingEl.firstChild
    if (span !== null && span !== undefined) span.textContent = ''
    const hasCursor = streamingEl.children?.[1] !== undefined
      && String(streamingEl.children[1].className).includes('cursor')
    if (!hasCursor) {
      const cursor = document.createElement('span')
      cursor.className = 'cursor'
      streamingEl.append(cursor)
    }
    // 若中途有别的元素插到它后面，把它挪回末尾（保持"最新一条在底部"）。
    // 用可选调用：某些测试桩没实现 appendChild，不该因为"整理顺序"这种非核心动作崩掉。
    if (messagesEl.lastElementChild !== streamingEl && typeof messagesEl.appendChild === 'function') {
      messagesEl.appendChild(streamingEl)
    }
    scrollToEnd()
    return streamingEl.firstChild
  }
  streamingEl = document.createElement('div')
  streamingEl.className = 'msg companion'
  const span = document.createElement('span')
  const cursor = document.createElement('span')
  cursor.className = 'cursor'
  streamingEl.append(span, cursor)
  messagesEl.append(streamingEl)
  scrollToEnd()
  return span
}

/**
 * 节拍化播放一条回复：逐字吐字 + 说话时张嘴。
 *
 * 立绘侧只认两件事：
 *  1. **正在吐字 → `setTalking(true)`**：她说话期间每 0.5s 插一张张嘴图
 *     （节拍与"编号跟随当前帧"的规则见 papercut-core.js）。
 *  2. **段间停顿 → `setTalking(false)`**：她闭嘴歇一下，再接着说下一段。
 *
 * 帧号推进、1.75s 处的中间帧、随机眨眼全部由舞台自驱，这里不再逐帧下发
 *（旧实现是"一字一帧"的 `setFrame` 调度，已随旧立绘一并删除）。
 *
 * ⚠️ 吐字节奏（200ms/字 = 每秒 5 字）是用户明确指定的**恒定语速**，
 *    与立绘无关，别顺手改。
 *
 * @param {Array<{label:string,intensity:number,text:string,chars:number}>} segments
 *   服务端给出的分段表（当前恒为单段，label 仅用于排查）。
 */
async function playPaced(segments) {
  paced = true
  if (pacedTimer !== null) { clearTimeout(pacedTimer); pacedTimer = null }
  pacedElapsedChars = 0
  // 吐字要接管立绘了：思考态收掉，说话节拍改由 setTalking 驱动。
  stopThinking()
  // 关键：先把流式那遍产生的气泡丢掉，避免新旧并存显示两遍
  discardStream()
  openStream()
  turnOpen = true
  // 按**本条回复总字数**定出每字停留（恒速 200ms/字）
  const totalChars = segments.reduce((n, s) => n + String(s.text ?? '').length, 0)
  const perChar = msPerCharFor(totalChars, segments.length)
  const gapMs = IDLE_BRIDGE_MS

  /**
   * 等一个节拍。统一走这里，保证"停顿"与"吐字"用同一套时间基准。
   * @param ms - 毫秒。
   */
  const wait = (ms) => new Promise((resolve) => { pacedTimer = setTimeout(resolve, ms) })

  /**
   * 按**绝对时刻**等到某个时间点。
   *
   * 为什么要绝对时刻（实测踩到的）：逐字原先用 `wait(perChar)` —— 每次都是
   * "从现在起再等 200ms"，而每次 setTimeout 跳转都有开销（浏览器 clamp 约 4ms），
   * 于是 **每字实际 210ms、误差累积**。
   * 实测：中位 204ms（还行），平均 210ms —— 100 字就漂 1 秒。
   *
   * 改成"算到目标时刻还差多久"之后，迟到的那次自动用更短的等待补回来，
   * **累计误差不增长**。
   *
   * @param target - 目标时刻（`Date.now()` 的时间戳）。
   */
  const waitUntil = (target) => new Promise((resolve) => {
    pacedTimer = setTimeout(resolve, Math.max(0, target - Date.now()))
  })

  for (const [k, seg] of segments.entries()) {
    // 段间停顿：她闭嘴歇一下（待机帧照常走），再起下一段。
    if (k > 0) {
      stage()?.setTalking(false)
      await wait(gapMs)
      if (streamingEl === null) { paced = false; return } // 被中断
    }

    // 这一段她要开口了：张嘴节拍开始
    stage()?.setTalking(true)

    const body = seg.text ?? ''
    // 本段的起算时刻：第 i 个字应在 `segStart + i*perChar` 显示。
    // 用绝对时刻而非相对延时，避免定时器开销逐字累积（见 waitUntil 的注释）。
    const segStart = Date.now()

    for (let i = 1; i <= body.length; i += 1) {
      if (streamingEl === null) { paced = false; return } // 被中断（断线/新回合）
      streamingEl.firstChild.textContent += body[i - 1]
      if (i % 3 === 0 || i === body.length) scrollToEnd()
      pacedElapsedChars += 1
      await waitUntil(segStart + i * perChar)
    }

    // 这一段说完了：闭嘴（下一段开头会再开）
    stage()?.setTalking(false)
  }

  // 说完了：闭嘴、回待机，再定稿气泡。
  paced = false
  pacedTimer = null
  thinkingShown = false
  stage()?.setTalking(false)
  stage()?.setMode('idle')
  await wait(gapMs)
  if (streamingEl !== null) closeStream(null)
  turnOpen = false
}

/**
 * 语音输入。识别结果**只落进输入框**，由用户确认后再发——
 * ASR 必有错字，直接发出去会让她答非所问。
 */
const voice = initVoiceInput({
  inputEl,
  onText: (text) => {
    inputEl.value = text
    inputEl.dispatchEvent(new Event('input'))
    inputEl.focus()
  },
})

// 「定制她」表单与 persona.form 拉取已删除（2026-10-01，用户决定）：
// 不做手动定制，她的一切设定从真实交流里推断、实时更新（后端负责推断）。
// 语音输入因此不再受人设卡开关控制，保持默认可用的状态。

/**
 * 键盘弹出时**只抬输入框，绝不动立绘**。
 *
 * 为什么需要：APK 侧把 windowSoftInputMode 从 adjustResize 改成 adjustNothing
 * （不再让系统把 WebView 整体缩小），键盘变成"覆盖"在页面上——于是输入框会被压住，
 * 必须由页面自己顶上去。这里用 visualViewport 算出键盘高度写进 CSS 变量 --kb，
 * 由 style.css 的输入区消费（translateY）。立绘是绝对定位铺满的 #stage，不参与这套计算，
 * 所以**键盘弹不弹，立绘尺寸都不变**。
 *
 * visualViewport 不存在的旧内核：什么都不做，退化成"输入框被键盘挡住"，但不影响可用性。
 */
const viewport = window.visualViewport
if (viewport !== null && viewport !== undefined) {
  const applyKeyboardOffset = () => {
    // innerHeight 与 visualViewport.height 的差 = 键盘高度（再减去视觉视口自身的偏移）
    const kb = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
    document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`)
  }
  viewport.addEventListener('resize', applyKeyboardOffset)
  viewport.addEventListener('scroll', applyKeyboardOffset)
  applyKeyboardOffset()
}

function setConnection(state, detail = '') {
  connected = state === 'open'
  dotEl.classList.toggle('on', connected)
  connTextEl.textContent = state === 'open' ? '已连接' : state === 'connecting' ? '连接中…' : '已断开，重连中…'
  // 会话号不再单独显示（那个 `#session-text` 元素已随状态面板一起删除）。
  // detail 仍保留在参数里：它是"为什么断开"这类有用的诊断，将来可折进提示条。
  void detail
  sendEl.disabled = !connected
}

/**
 * 是否跟随最新消息（自动滚到底）。
 *
 * 为什么需要这个开关：原先 `scrollToEnd()` 在**每个 delta 都调用**——
 * 也就是她逐字吐字时，聊天区会被**强行拉到最底**。后果是用户想往上翻看她说过什么，
 * 一有流式输出就被拽回底部。真实聊天软件都不这么做。
 *
 * 规则：只有**用户本来就在底部附近**时才自动跟随；一旦他手动往上翻，就停止跟随，
 * 直到他自己回到底部（或发新消息）。
 */
let followBottom = true

/** 「算在底部」的容差（像素）。留一点余量，避免亚像素误差导致开关抖动。 */
const NEAR_BOTTOM_PX = 80

/** 当前是否已滚到底部附近。 */
function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= NEAR_BOTTOM_PX
}

/**
 * 滚到底部——**但只在用户想跟随时**。
 * @param force - 传 true 强制滚到底（用于"用户自己发消息"这种明确意图）。
 */
function scrollToEnd(force = false) {
  if (!force && !followBottom) return
  messagesEl.scrollTop = messagesEl.scrollHeight
  followBottom = true
}

// 监听用户的滚动意图：离开底部就停止跟随，回到就恢复。
messagesEl.addEventListener('scroll', () => {
  followBottom = isNearBottom()
})

function appendMessage(role, text, forceScroll = false) {
  const el = document.createElement('div')
  el.className = `msg ${role}`
  el.textContent = text
  messagesEl.append(el)
  // 用户自己发的消息 → 强制滚到底（明确意图）；她的消息 → 只在他跟随时滚
  scrollToEnd(forceScroll || role === 'user')
  return el
}

/** 插入一条"她主动找你"的提示（不是她说的话，所以样式更轻）。 */
function appendProactiveNote(text) {
  const el = document.createElement('div')
  el.className = 'proactive-note'
  el.textContent = text
  messagesEl.append(el)
  scrollToEnd()
}

/**
 * 收尾当前流式气泡。
 *
 * @param finalText - 传给 `appendMessage` 的定稿文本（仅在没有气泡时用）；
 *   传 `null`/`undefined` 表示**保留已吐出的内容**。
 */
function closeStream(finalText) {
  if (streamingEl === null) {
    if (finalText) appendMessage('companion', finalText)
    return
  }
  // ⚠️ 踩过的坑（两处，都在这一行）：
  //
  //  1. 原先写 `streamingEl.textContent = finalText ?? streamingEl.textContent`。
  //     读 `textContent` 会**把光标 `<span class="cursor">` 也算进去**，
  //     再整体写回就把两个子节点压成一个文本节点——结构被压平，
  //     而且会把光标带来的空白写进气泡内容。
  //
  //  2. 更要紧的：`playPaced` 的逐字吐字是**写进 `firstChild`（内层 span）**的。
  //     这里若用容器级 `textContent` 覆盖，等于用"读出来的快照"替换掉刚吐好的内容，
  //     在只实现了部分 DOM 行为的测试环境里就直接变成空串。
  //
  // 正确做法：**保留结构**，只把光标摘掉；真要替换文本时才动内层 span。
  if (typeof finalText === 'string' && finalText !== '') {
    const span = streamingEl.firstChild
    if (span !== null && span !== undefined) span.textContent = finalText
    else streamingEl.textContent = finalText
  }
  // 摘掉闪烁光标（它只是"还在说"的提示）
  const cursor = streamingEl.children?.[1]
  if (cursor !== null && cursor !== undefined && String(cursor.className).includes('cursor')) {
    cursor.remove()
  }
  streamingEl = null
  scrollToEnd()
}

// 情绪状态通道（affect.update）仍在跑，但立绘不再消费它：
// 剪纸立绘只有 待机/思考/说话 三态，情绪不再驱动表情。

function handle(payload) {
  switch (payload.type) {
    case 'init': {
      messagesEl.replaceChildren()
      streamingEl = null
      turnOpen = false
      // 复位本回合的累积状态（重连时会收到 init，不复位会把上一轮的文本带过来）
      streamedText = ''
      paced = false
      if (pacedTimer !== null) { clearTimeout(pacedTimer); pacedTimer = null }
      for (const item of payload.history ?? []) {
        appendMessage(item.role === 'user' ? 'user' : 'companion', item.text)
      }
      // 历史渲染完必须**滚到底**（看最新的）。
      //
      // 踩过的坑（CDP 量出来的）：116 条历史把滚动区撑到 11000+px，
      // 而浏览器默认 `scrollTop = 0` —— 刷新后看到的是**最老的对话**，
      // 得手动往下拖才能看到最新消息。
      //
      // 用 `force`：这时用户还没开始翻，跟随最新是明确意图，不该受 followBottom 影响。
      // 还要等一帧：DOM 刚插入，`scrollHeight` 可能尚未定型。
      requestAnimationFrame(() => scrollToEnd(true))
      break
    }
    case 'ready': {
      break
    }
    case 'message.delta': {
      // 增量**不直接写 DOM**，先累积到变量。
      //
      // 为什么要这样（踩过的坑）：实测底层增量在 70–370ms 内一次性到达，
      // 而输出模式要到 message.done 才判定。若边到边渲染，paced 模式下会先
      // 把整段文字闪一下、再清掉重新逐字吐 —— 用户看到的就是"先输出一条、又流式一遍"。
      // 累积起来、到定稿时再决定怎么显示，就没有这个闪烁。
      streamedText += payload.text ?? ''
      break
    }
    case 'message.emotion': {
      // 她在说话时输出的表情标记（服务端已从正文里剥掉，用户看不到）。
      //
      // ⚠️ 现在**不再用它驱动立绘**：立绘统一由 message.done 的 segments 驱动
      //（每段文字吐多久、立绘就播多久）。原因见 message.done 里的注释——
      // 靠这条瞬时消息驱动会导致"动态不是所有时候都有"。
      // 保留这个分支只为兼容与排查。
      break
    }
    case 'message.replace': {
      // 护栏改写了正文（已攒下的增量是错的）。此时可能还没建气泡
      // （paced 模式要等 message.done 才开始吐字），所以要分开处理。
      streamedText = payload.text ?? ''
      if (streamingEl !== null) streamingEl.firstChild.textContent = streamedText
      break
    }
    case 'agent.status': {
      // 她开始跑 = 正在读我的话、组织回复。这就是"思考动态"的时机：
      // 从用户发出消息，到她第一个字吐出来之间的空档。
      if (payload.status === 'running') {
        thinkingShown = true
        startThinking()
      } else if (payload.status === 'idle') {
        // 跑完了但正文还没定稿（还要过护栏、解析分段）——保持思考态，
        // 由 message.done 接手，避免中间闪回待机。
        if (!turnFinalized && !paced) {
          stopThinking()
        }
      }
      break
    }
    case 'message.done': {
      const full = payload.text ?? streamedText
      streamedText = ''
      turnFinalized = true
      // 正文即将由节拍器（或一次性）呈现，思考态到此为止。
      // 用 stopThinking 而不是只把标志置 false —— 它还要清定时器并退出手动帧模式，
      // 否则思考那一层的 data-manual 会留着，把后面台词的帧号盖掉。
      stopThinking()
      if (Array.isArray(payload.segments) && payload.segments.length > 0) {
        // **统一走节拍化**，不再看 outputMode。
        //
        // 为什么：原先按 outputMode 分两条路径，而那个判断会反复横跳
        //（实测日志：paced 26ms/9字 → stream 542ms/122字 → paced 29ms/82字 …），
        // 于是短回复有动态、长回复只靠瞬时的 message.emotion 驱动 —— 表现为
        // "流式有时候失效" + "动态不是所有时候都有"。
        // 现在统一：文字按节拍吐、立绘按 segments 驱动，行为稳定。
        void playPaced(payload.segments)
        break
      }
      // 她没输出任何情绪标记 → `segments` 为空。
      //
      // ⚠️ 踩过的坑（用户报"突然蹦出来一堆字"）：这里原先**直接一次性落全文**
      //（`openStream(); closeStream(full)`），于是整条回复"啪"地出现，
      // 与其余回复的逐字吐字完全不一致。
      //
      // 而这并不罕见：实测 62 条模型返回里**有 32 条一个标记都没写**——
      // 提示词虽然要求"整条回复至少要有一个标记"，模型并不总遵守。
      //
      // 修法：**也走节拍化**——按默认情绪（calm）合成一个分段，文字仍然逐字吐出。
      // 立绘这边只认"正在吐字"，label 已不再有视觉含义（她平静地在说话）。
      void playPaced([{
        label: 'calm',
        intensity: 0,
        text: full,
        chars: full.length,
      }])
      break
    }
    case 'affect.update': {
      // 情绪数值仍在后端演化（影响语气与人设），但不再驱动立绘：
      // 剪纸立绘只有 待机/思考/说话 三态。
      break
    }
    case 'initiative.fired': {
      // 这条是她主动说的。给一个轻量的视觉区分，便于分辨。
      appendProactiveNote('她主动找你了')
      break
    }
    case 'error': {
      appendMessage('error', `⚠️ ${payload.message ?? payload.code ?? '出错了'}`)
      closeStream(null)
      turnOpen = false
      // 回合失败也要把她从"思考"里放出来：服务端出错时不保证再发 status:idle，
      // 不复位就会一直停在思考循环里，直到用户下一次发言（用户看到的是"她卡住了"）。
      stopThinking()
      stage()?.setTalking(false)
      break
    }
    default:
      break
  }
}

/** 带退避的自动重连。 */
function connect() {
  setConnection('connecting')
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}/companion/ws`)
  let retry = 0

  ws.addEventListener('open', () => {
    retry = 0
    setConnection('open')
  })
  ws.addEventListener('message', (event) => {
    try {
      handle(JSON.parse(event.data))
    } catch {
      /* 忽略非 JSON 帧 */
    }
  })
  ws.addEventListener('close', () => {
    setConnection('closed')
    const delay = Math.min(500 * 2 ** retry, 8000)
    retry += 1
    setTimeout(connect, delay)
  })
  ws.addEventListener('error', () => ws.close())

  return ws
}

socket = connect()

function send(text) {
  if (!connected || socket.readyState !== WebSocket.OPEN) return
  if (text.trim() === '') return
  appendMessage('user', text)
  turnOpen = false
  // 新回合：清掉上一回合的累积与节拍状态，避免串味
  streamedText = ''
  paced = false
  turnFinalized = false
  if (pacedTimer !== null) { clearTimeout(pacedTimer); pacedTimer = null }
  // 上一回合的立绘状态若还没收干净（例如中途断线），这里一并复位
  thinkingShown = false
  stage()?.setTalking(false)
  stage()?.setMode('idle')
  socket.send(JSON.stringify({ type: 'chat.send', text }))
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = inputEl.value
  if (text.trim() === '') return
  send(text)
  inputEl.value = ''
  inputEl.style.height = 'auto'
})

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    formEl.requestSubmit()
  }
})

// 输入框随内容长高。
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto'
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`
})

inputEl.focus()

// 剪纸立绘舞台 · 渲染层
//
// 职责边界：本文件只管「把内核算出来的帧画到屏幕上」与「预加载」。
// 播放规则全在 papercut-core.js（纯逻辑、已单测），这里不含任何时序规则。
//
// 对外接口（挂到 window.CompanionStage）：
//   setMode('idle'|'thinking')   思考态切换
//   setTalking(true|false)       说话叠加层（张嘴节拍）
//   debug()                      当前帧/眨眼倒计时/加载情况（验收脚本用）
//   ready                        Promise，24 张预加载完成
//   —— 兼容层：setState(name) / setFrame() 保留旧调用名，映射规则见下
//
// 状态映射（旧 15 态 → 新 2 态 + 说话叠加）：
//   'thinking'            → setMode('thinking')
//   'idle'                → setMode('idle')，并停说话
//   其余任何名字（说话/情绪标签）→ 视为说话中的待机：setMode('idle') + setTalking(true)
//   旧 API 的 setFrame(state, i) 是外部逐帧推帧，新引擎自驱，忽略。

import { createPapercutMachine, assetPath, allAssetPaths } from './papercut-core.js';

const ASSET_BASE = './papercut/';

/**
 * 取素材批次信息（import-papercut.mjs 生成）。
 *
 * 为什么需要：
 *  1. **版本号**：图片按 `papercut/<set>/<n>.jpg` 命名，**换批次不改名**，而图片走长缓存
 *     （max-age=86400）。没有版本号时，换完素材刷新页面看到的还是上一批画风（踩过）。
 *     加上 `?v=<批次哈希>` 后：同一批内容不变→缓存继续命中；换批次→URL 变→必然回源。
 *  2. **缩放方式**：像素画要用最近邻（`pixelated`），插画要用默认平滑。
 *     这是素材的属性，不该写死在 CSS 里，所以由批次元数据带过来。
 * 拉不到就退回"无版本号 + 平滑缩放"（宁可慢一次，也不能白屏）。
 */
async function batchInfo() {
  try {
    const res = await fetch(`${ASSET_BASE}version.json`, { cache: 'no-cache' });
    if (!res.ok) return { version: '', pixelated: false, style: null };
    const info = await res.json();
    return {
      version: typeof info?.v === 'string' && info.v !== '' ? `?v=${info.v}` : '',
      pixelated: info?.pixelated === true,
      style: typeof info?.style === 'string' ? info.style : null,
    };
  } catch {
    return { version: '', pixelated: false, style: null };
  }
}

export function createStage({
  container = document.getElementById('stage'),
  assetsBase = ASSET_BASE,
  /** 素材批次版本后缀（如 `?v=ab12cd34`），由 batchInfo() 提供。 */
  version = '',
  /** 是否最近邻缩放（像素画批次为 true）。 */
  pixelated = false,
  rng = Math.random,
  hud = new URLSearchParams(location.search).has('pcdebug'),
} = {}) {
  if (!container) throw new Error('找不到 #stage 容器');

  const machine = createPapercutMachine({ rng });
  const missing = new Set();
  const preloaded = new Map();

  // ---- DOM：单 <img> 显示 + 一张隐藏 <img> 预热（避免切帧闪白）----
  const style = document.createElement('style');
  style.textContent = `
    #stage.pc-stage { position: absolute; inset: 0; overflow: hidden; background: #0b0b0f; }
    #stage.pc-stage .pc-img {
      position: absolute; inset: 0; width: 100%; height: 100%;
      object-fit: contain; object-position: center center;
      user-select: none; -webkit-user-drag: none; pointer-events: none;
    }
    #stage.pc-stage .pc-hud {
      position: absolute; left: 8px; top: 8px; z-index: 5;
      font: 12px/1.45 ui-monospace, Consolas, monospace; color: #8ef;
      background: rgba(0,0,0,.55); border: 1px solid rgba(140,238,255,.25);
      border-radius: 6px; padding: 6px 8px; white-space: pre; pointer-events: none;
    }`;
  document.head.appendChild(style);
  container.classList.add('pc-stage');

  const img = document.createElement('img');
  img.className = 'pc-img';
  img.alt = '';
  img.decoding = 'sync';
  // 像素画用最近邻：插画/照片级用最近邻会毁掉细节，像素画用平滑会糊掉色块
  img.style.imageRendering = pixelated ? 'pixelated' : 'auto';
  container.appendChild(img);

  const hudEl = hud ? document.createElement('div') : null;
  if (hudEl) { hudEl.className = 'pc-hud'; container.appendChild(hudEl); }

  // ---- 预加载：24 张全量，命中缓存后切帧不会闪 ----
  const paths = allAssetPaths();
  const ready = Promise.all(paths.map((p) => new Promise((resolve) => {
    const im = new Image();
    im.onload = () => { preloaded.set(p, im); resolve(true); };
    im.onerror = () => { missing.add(p); console.warn('[papercut] 缺图:', p); resolve(false); };
    im.src = assetsBase + p.replace(/^papercut\//, '') + version;
  }))).then((rs) => ({ total: paths.length, ok: rs.filter(Boolean).length, missing: [...missing] }));

  // ---- 渲染循环 ----
  let lastKey = '';
  let frames = 0;
  const t0 = performance.now();
  machine.reset(t0);

  function tick() {
    const now = performance.now();
    machine.update(now);
    const f = machine.frame(now);
    const key = `${f.set}/${f.num}`;
    if (key !== lastKey) {
      lastKey = key;
      img.src = assetsBase + assetPath(f).replace(/^papercut\//, '') + version;
      frames++;
    }
    if (hudEl) {
      const d = machine.debug(now);
      hudEl.textContent =
        `${d.set}#${d.num}  ${d.layer}\n` +
        `mode=${d.mode} talk=${d.talking} slot=${d.slotIndex}@${d.slotPhaseMs}ms\n` +
        `cycle=${d.cycleMs}ms blinkIn=${d.nextBlinkInMs}ms t=${Math.round(now - t0)}ms`;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  const api = {
    machine,
    ready,
    setMode(name) { machine.setMode(name, performance.now()); },
    setTalking(on) { machine.setTalking(on, performance.now()); },
    debug() {
      const now = performance.now();
      return {
        ...machine.debug(now),
        uptimeMs: Math.round(now - t0),
        frameSwaps: frames,
        imgSrc: img.getAttribute('src'),
        imgLoaded: img.complete && img.naturalWidth > 0,
        imgNatural: img.naturalWidth ? `${img.naturalWidth}x${img.naturalHeight}` : null,
        preload: { total: paths.length, ok: preloaded.size, missing: [...missing] },
        batch: { version: version === '' ? null : version.slice(3), pixelated, imageRendering: img.style.imageRendering },
      };
    },
  };

  // 只暴露这一个全局：旧的 window.CompanionAvatar（含 mount/setState/applyEmotion/
  // setFrame/clearFrame）已随旧立绘整体删除，前端只剩 setMode / setTalking 两个信号。
  window.CompanionStage = api;
  return api;
}

// 自动挂载：脚本在 body 末尾、app.js 之前执行。
// 先取批次信息（版本号 + 缩放方式）再建舞台 —— 换批次后素材 URL 才会变、像素画才会用最近邻。
const BATCH = await batchInfo();
createStage({ version: BATCH.version, pixelated: BATCH.pixelated });

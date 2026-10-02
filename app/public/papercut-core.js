// 剪纸立绘 · 播放内核（权威副本；浏览器与 Node 共用）
//
// 契约（来自用户口述规格，2026-09-30）：
//   待机：循环播放「剪纸」1/3/5 图，每张 2s；2/4/6 依次是 1→3、3→5、5→1 的中间帧，
//         中间帧落在该帧的 7/8 位置，即起始帧播满 1.75s 后显示 0.25s。
//   思考：同速循环「思考素材_剪纸」1/3 图，2 为其中间帧（同为 1.75s 后显示 0.25s）。
//         回程 3→1 复用 2（用户确认，避免硬切）。
//   说话：在待机动态之上，每 0.5s 插入（替换）一张「张嘴素材」中与当前帧编号相同的图，
//         播放 0.25s。
//   眨眼：任何时候可随机把当前帧替换为「闭眼素材」中编号相同的图，0.25s。
//         思考态用「思考素材_剪纸_闭眼」。
//
// 已定的默认（用户未反对即生效）：
//   · 网格刚性：所有覆盖帧吃掉网格内时间，不推迟下一帧 → 待机循环恒为 6.000s。
//   · 张嘴窗口内不启动眨眼（否则嘴会突然合上）；眨眼被推迟到窗口结束后。
//   · 优先级：张嘴 > 眨眼 > 中间帧 > 基础帧。
//
// 注：`app/companion/papercut-core.js` 是本文件的转发出口，后端要用请从那里 import；
//     浏览器只能取 public 下的模块，所以权威副本放在这里。

/** 素材集合标识（对应 app/public/papercut/<set>/<num>.jpg） */
export const SETS = {
  idle: 'idle',
  think: 'think',
  blink: 'blink',
  thinkBlink: 'think-blink',
  mouth: 'mouth',
};

export const DEFAULT_CONFIG = {
  slotMs: 2000,       // 基础帧时长
  midNumer: 7,        // 中间帧位置 = 基础帧的 7/8
  midDenom: 8,
  midMs: 250,         // 中间帧显示时长
  thinkSlots: [       // 思考：基础帧 1 → 3，中间帧都是 2（回程复用）
    { base: 1, mid: 2 },
    { base: 3, mid: 2 },
  ],
  idleSlots: [        // 待机：基础帧 1/3/5，中间帧 2/4/6 覆盖 5→1 的回程
    { base: 1, mid: 2 },
    { base: 3, mid: 4 },
    { base: 5, mid: 6 },
  ],
  talkPeriodMs: 500,  // 张嘴节拍
  talkMouthMs: 250,   // 张嘴显示时长

  // ── 眨眼 ────────────────────────────────────────────────────────────────
  // 单次时长**固定 250ms**：用户明确要求"一次眨眼的时间保持不变"（改成变化的会白白增加
  // 前端每次眨眼的调度分支），且 250ms 正落在文献的 150–400ms 区间内（多数眨眼 150–400ms，
  // 完全闭合仅约 50ms）——所以"固定"并不牺牲真实感。
  blinkMs: 250,
  blinkDeferMs: 40,       // 撞上张嘴窗口时的重试步长
  //
  // 间隔**不是均匀随机**。依据（2026-09-30 重做时查的文献，见文末 §眨眼依据）：
  //   · 实测 20 名健康受试者平均 12.55 次/分；清醒 16.33 次/分；成人稳定在约 20 次/分
  //   · 间隔分布：**多数落在 0.5–2s，少数超过 5s**（Ponder & Kennedy 1927，31 人）
  //   · 对话是所有活动里眨眼率最高的；眨眼**成簇**出现在话语单元结束处
  // 于是用「长恢复期 + 簇内短间隔」复现这个形状：
  //
  // 2026-10-01 用户反馈「眨眼再多一点」：**只压恢复期**，簇行为（0.6–2s、1–3 次）一字不动——
  // 那是按人类数据校准过的"突发"形状，动了就不再像人。
  // 恢复期 4000–9000 → 3400–7000（均值 6.5s→5.2s）：解析频率 15.4 → 18.5 次/分，
  // 10 分钟模拟实测约 19.2 次/分（仍落在人类区间 12.5–20 内，不越上沿）。
  // 说明：第一次试的是 3000–6800，模拟跑出 20.1 次/分、越过了测试里那条"人类区间"不变式，
  // 于是往回收了一档——**宁可少一点，也不要为了"更多"把不变式放宽**。
  blinkRecoverMinMs: 3400,   // 恢复期（一段不眨的长间隔）
  blinkRecoverMaxMs: 7000,
  blinkClusterMinMs: 600,    // 簇内相邻两次眨眼的间隔（对应文献里 0.5–2s 的短间隔）
  blinkClusterMaxMs: 2000,
  blinkClusterMax: 3,        // 一簇最多几次（1–3 均匀，均值 2 次/簇）
  blinkThinkingFactor: 1.7,  // 高认知负荷 → 眨眼变少（思考态所有间隔乘这个系数）
  // 解析期望：一簇 = 恢复期(均值 4.9s) + 1 段短间隔(均值 1.3s)，簇长均值 2 → 约 19.4 次/分。
};


/**
 * 创建播放内核。时间一律由调用方传入（无内部时钟），便于单测与验收。
 * @param {object} [opts]
 * @param {object} [opts.config] 覆盖 DEFAULT_CONFIG 的部分字段
 * @param {() => number} [opts.rng] 0..1 随机源
 */
/**
 * 时间戳守卫：缺失/非有限的时间戳会让网格相位算成 NaN，最后在 `slot.base` 上崩，
 * 而报错点离真正的调用点很远（实测踩到过）。这里就地响亮失败。
 * @param now - 调用方传入的时间戳。
 * @param api - 出错的接口名，用于报错信息。
 */
const assertNow = (now, api) => {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError(`papercut: ${api}() 需要一个有限的时间戳（传 performance.now()），收到 ${String(now)}`)
  }
}

export function createPapercutMachine({ config = {}, rng = Math.random } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const midAtMs = (cfg.slotMs * cfg.midNumer) / cfg.midDenom;

  let mode = 'idle';        // 'idle' | 'thinking'
  let talking = false;
  let modeSince = 0;
  let talkSince = 0;
  let nextBlinkAt = Infinity;
  let blinkUntil = -Infinity;
  let blinkNum = null;
  /** 眨眼节奏相位：'recover' = 处在长恢复期之后、即将起一簇；'cluster' = 簇内还要补几次 */
  let blinkPhase = 'recover';
  /** 本簇还要补几次快眨（0 = 这是一次单独眨眼） */
  let blinkLeft = 0;

  const slotsOf = (m) => (m === 'thinking' ? cfg.thinkSlots : cfg.idleSlots);
  const cycleMs = (m) => slotsOf(m).length * cfg.slotMs;

  const lerp = (lo, hi) => lo + rng() * Math.max(0, hi - lo);

  /**
   * 抽下一次眨眼的间隔。
   *
   * 形状来自人类数据（多数间隔 0.5–2s、少数超过 5s，且成簇），用
   * 「一段长恢复期 → 一簇 1–3 次、簇内短间隔」复现：
   *   ……长间隔 → 眨眼 → (短间隔 → 眨眼)×(簇长-1) → 长间隔 → ……
   * 高认知负荷（思考态）把所有间隔乘以 blinkThinkingFactor（人越费脑子眨得越少）。
   */
  function nextBlinkGap() {
    const factor = mode === 'thinking' ? cfg.blinkThinkingFactor : 1;
    if (blinkPhase === 'recover') {
      // 起新的一簇：0..max-1 次"追加"，所以簇长 1..blinkClusterMax
      blinkLeft = Math.floor(rng() * cfg.blinkClusterMax);
      blinkPhase = blinkLeft > 0 ? 'cluster' : 'recover';
      return lerp(cfg.blinkRecoverMinMs, cfg.blinkRecoverMaxMs) * factor;
    }
    blinkLeft -= 1;
    if (blinkLeft <= 0) blinkPhase = 'recover';
    return lerp(cfg.blinkClusterMinMs, cfg.blinkClusterMaxMs) * factor;
  }

  /** 回到"等待起新簇"的初始相位（模式切换/重置时用，避免相位跨状态残留） */
  function resetBlinkPhase() {
    blinkPhase = 'recover';
    blinkLeft = 0;
  }

  function mouthWindow(now) {
    if (!talking) return null;
    const phase = (now - talkSince) % cfg.talkPeriodMs;
    return phase < cfg.talkMouthMs ? phase : null;
  }

  function gridFrame(now) {
    const slots = slotsOf(mode);
    const cyc = cycleMs(mode);
    const t = ((now - modeSince) % cyc + cyc) % cyc;
    const idx = Math.floor(t / cfg.slotMs);
    const slot = slots[Math.min(idx, slots.length - 1)];
    const phase = t - idx * cfg.slotMs;
    const isMid = phase >= midAtMs;
    return {
      set: mode === 'thinking' ? SETS.think : SETS.idle,
      num: isMid ? slot.mid : slot.base,
      layer: isMid ? 'mid' : 'base',
      slotIndex: idx,
      slotPhaseMs: Math.round(phase),
    };
  }

  const machine = {
    get config() { return cfg; },
    get mode() { return mode; },
    get talking() { return talking; },

    /**
     * 锚定起点：网格相位与首次眨眼时刻都对齐到 now。
     * 渲染层初始化时必须调用一次，否则首次眨眼时刻取决于第一次 update 的时刻。
     */
    reset(now) {
      assertNow(now, 'reset')
      modeSince = now;
      talkSince = now;
      blinkUntil = -Infinity;
      blinkNum = null;
      resetBlinkPhase();
      nextBlinkAt = now + nextBlinkGap();
    },

    /** 切换状态：'idle' | 'thinking'（说话是叠加层，见 setTalking） */
    setMode(next, now) {
      if (next !== 'idle' && next !== 'thinking') throw new Error(`未知状态: ${next}`);
      assertNow(now, 'setMode')
      if (next === mode) return;
      mode = next;
      modeSince = now;
      blinkUntil = -Infinity;
      blinkNum = null;
      resetBlinkPhase();
      // 注意顺序：mode 已更新，nextBlinkGap() 才会按新状态套用思考系数
      nextBlinkAt = now + nextBlinkGap();
    },

    /** 说话叠加层开关 */
    setTalking(on, now) {
      assertNow(now, 'setTalking')
      const next = !!on;
      if (next === talking) return;
      talking = next;
      if (next) {
        talkSince = now;
        if (mode === 'thinking') { mode = 'idle'; modeSince = now; }  // 防御：边想边说不可能
      }
    },

    /** 推进眨眼调度；渲染循环每帧调用一次，必须在 frame() 之前 */
    update(now) {
      assertNow(now, 'update')
      if (!Number.isFinite(nextBlinkAt)) nextBlinkAt = now + nextBlinkGap();
      if (now >= nextBlinkAt) {
        const mw = mouthWindow(now);
        if (mw !== null) {
          // 张嘴窗口中不启动眨眼（否则嘴会突然合上，看着像说话断了）。
          // 这条约束恰好贴近人类：眨眼倾向落在话语单元结束处，而不是说话中间。
          nextBlinkAt = now + (cfg.talkMouthMs - mw) + cfg.blinkDeferMs;
        } else {
          const g = gridFrame(now);
          blinkNum = g.num;
          blinkUntil = now + cfg.blinkMs;
          nextBlinkAt = now + nextBlinkGap();
        }
      }
    },

    /** 查询当前应显示的帧 */
    frame(now) {
      assertNow(now, 'frame')
      const g = gridFrame(now);
      const mw = mouthWindow(now);
      if (mw !== null) return { ...g, set: SETS.mouth, num: g.num, layer: 'mouth', mode, talking };
      if (now < blinkUntil && blinkNum !== null) {
        return {
          ...g,
          set: mode === 'thinking' ? SETS.thinkBlink : SETS.blink,
          num: blinkNum,
          layer: 'blink',
          mode,
          talking,
        };
      }
      return { ...g, mode, talking };
    },

    /** 诊断快照 */
    debug(now) {
      const f = machine.frame(now);
      return {
        ...f,
        cycleMs: cycleMs(mode),
        nextBlinkInMs: Number.isFinite(nextBlinkAt) ? Math.round(nextBlinkAt - now) : null,
        blinkRemainMs: Math.max(0, Math.round(blinkUntil - now)),
      };
    },
  };
  return machine;
}

/** 帧 → 静态资源路径（相对 app/public/） */
export function assetPath(frame) {
  return `papercut/${frame.set}/${frame.num}.jpg`;
}

/** 预加载清单：所有可能出现的帧（24 张） */
export function allAssetPaths() {
  const out = [];
  for (const n of [1, 2, 3, 4, 5, 6]) out.push(`papercut/${SETS.idle}/${n}.jpg`);
  for (const n of [1, 2, 3, 4, 5, 6]) out.push(`papercut/${SETS.blink}/${n}.jpg`);
  for (const n of [1, 2, 3, 4, 5, 6]) out.push(`papercut/${SETS.mouth}/${n}.jpg`);
  for (const n of [1, 2, 3]) out.push(`papercut/${SETS.think}/${n}.jpg`);
  for (const n of [1, 2, 3]) out.push(`papercut/${SETS.thinkBlink}/${n}.jpg`);
  return out;
}

/** 帧级时间线（供验收脚本比对） */
export function timeline(machine, fromMs, toMs, stepMs = 50) {
  const out = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    machine.update(t);
    const f = machine.frame(t);
    out.push({ t, set: f.set, num: f.num, layer: f.layer });
  }
  return out;
}

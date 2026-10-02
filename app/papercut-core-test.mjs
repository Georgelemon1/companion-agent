// 剪纸播放内核验收：逐条核对用户口述规格 + 已定默认
// 用法: node papercut-core-test.mjs
import { createPapercutMachine, DEFAULT_CONFIG } from './public/papercut-core.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${a}\n       want ${b}`); }
};
const at = (m, t) => { m.update(t); const f = m.frame(t); return `${f.set}#${f.num}/${f.layer}`; };

console.log('\n== 1. 待机：1/3/5 各 2s，中间帧 2/4/6 落在 7/8（1.75s）处显示 0.25s ==');
{
  // 眨眼推到很远，先测纯网格：rng=1 → 间隔取上限，再乘大系数
  const m = createPapercutMachine({ rng: () => 1, config: { blinkRecoverMinMs: 1e9, blinkRecoverMaxMs: 1e9, blinkClusterMax: 1 } });
  m.reset(0);
  eq('t=0      → 基础帧 1', at(m, 0), 'idle#1/base');
  eq('t=1749   → 仍是基础帧 1', at(m, 1749), 'idle#1/base');
  eq('t=1750   → 中间帧 2', at(m, 1750), 'idle#2/mid');
  eq('t=1999   → 仍是中间帧 2', at(m, 1999), 'idle#2/mid');
  eq('t=2000   → 基础帧 3', at(m, 2000), 'idle#3/base');
  eq('t=3750   → 中间帧 4', at(m, 3750), 'idle#4/mid');
  eq('t=4000   → 基础帧 5', at(m, 4000), 'idle#5/base');
  eq('t=5750   → 中间帧 6（5→1 的回程）', at(m, 5750), 'idle#6/mid');
  eq('t=6000   → 回到基础帧 1（循环 6.000s）', at(m, 6000), 'idle#1/base');
  eq('t=12000  → 第二圈同位', at(m, 12000), 'idle#1/base');
}

console.log('\n== 2. 思考：1/3 各 2s，2 为中间帧；回程 3→1 复用 2（用户确认） ==');
{
  // 关掉眨眼（间隔拉到极大）：这段测的是网格，眨眼会随机落在采样点上把断言打红
  const m = createPapercutMachine({ rng: () => 0.5, config: { blinkRecoverMinMs: 1e9, blinkRecoverMaxMs: 1e9, blinkClusterMax: 1 } });
  m.setMode('thinking', 0);
  eq('t=0      → think 1', at(m, 0), 'think#1/base');
  eq('t=1750   → think 2（1→3 中间帧）', at(m, 1750), 'think#2/mid');
  eq('t=2000   → think 3', at(m, 2000), 'think#3/base');
  eq('t=3750   → think 2（3→1 回程复用）', at(m, 3750), 'think#2/mid');
  eq('t=4000   → 回到 think 1（循环 4.000s）', at(m, 4000), 'think#1/base');
}

console.log('\n== 3. 说话：每 0.5s 插入当前编号的张嘴图，显示 0.25s ==');
{
  const m = createPapercutMachine({ rng: () => 0.5, config: { blinkRecoverMinMs: 1e9, blinkRecoverMaxMs: 1e9, blinkClusterMax: 1 } });
  m.reset(0);
  m.setTalking(true, 0);
  eq('t=0    → 张嘴 1（此时网格是基础帧 1）', at(m, 0), 'mouth#1/mouth');
  eq('t=249  → 仍是张嘴 1', at(m, 249), 'mouth#1/mouth');
  eq('t=250  → 回到基础帧 1（张嘴只占节拍前 250ms）', at(m, 250), 'idle#1/base');
  eq('t=500  → 张嘴 1（第二个节拍）', at(m, 500), 'mouth#1/mouth');
  eq('t=1500 → 张嘴 1（网格仍在基础帧 1 的时段）', at(m, 1500), 'mouth#1/mouth');
  eq('t=1750 → 节拍间隙，中间帧 2 显出', at(m, 1750), 'idle#2/mid');
  eq('t=2000 → 网格基础帧 3 上插张嘴 3', at(m, 2000), 'mouth#3/mouth');
  eq('t=2250 → 回到底层基础帧 3', at(m, 2250), 'idle#3/base');
  m.setTalking(false, 2300);
  eq('t=2300 → 停说后立即回待机网格', at(m, 2300), 'idle#3/base');
}

console.log('\n== 4. 眨眼：随机间隔、0.25s、编号跟随当前帧 ==');
{
  // 间隔显式固定成 4s：测的是"机制"，不绑默认值（默认值一改这里就红过一次）
  const m = createPapercutMachine({ rng: () => 0, config: { blinkRecoverMinMs: 4000, blinkRecoverMaxMs: 4000, blinkClusterMinMs: 4000, blinkClusterMaxMs: 4000, blinkClusterMax: 1 } });
  m.reset(0);
  eq('t=3999 → 无眨眼（中间帧 4 时段）', at(m, 3999), 'idle#4/mid');
  eq('t=4000 → 眨眼，编号=当前帧 5', at(m, 4000), 'blink#5/blink');
  eq('t=4249 → 仍在眨眼', at(m, 4249), 'blink#5/blink');
  eq('t=4250 → 眨眼结束，回网格（不重启该帧）', at(m, 4250), 'idle#5/base');
  eq('t=6000 → 网格未漂移（眨眼吃掉网格内时间）', at(m, 6000), 'idle#1/base');
}

console.log('\n== 5. 眨眼编号跟随「中间帧」 ==');
{
  const m = createPapercutMachine({ rng: () => 0, config: { blinkRecoverMinMs: 1800, blinkRecoverMaxMs: 1800, blinkClusterMinMs: 1800, blinkClusterMaxMs: 1800, blinkClusterMax: 1 } });
  m.reset(0);
  eq('t=1800 → 眨眼落在中间帧 2 上', at(m, 1800), 'blink#2/blink');
}

console.log('\n== 6. 冲突：张嘴窗口内不启动眨眼，起点被推迟到窗口之后 ==');
{
  const m = createPapercutMachine({ rng: () => 0, config: { blinkRecoverMinMs: 4000, blinkRecoverMaxMs: 4000, blinkClusterMinMs: 4000, blinkClusterMaxMs: 4000, blinkClusterMax: 1 } });
  m.reset(0);
  m.setTalking(true, 0);
  m.update(4000);                                  // t=4000 处在张嘴窗口（相位 0）
  eq('t=4000 → 让位，显示张嘴 5', `${m.frame(4000).set}#${m.frame(4000).num}/${m.frame(4000).layer}`, 'mouth#5/mouth');
  eq('t=4250 → 张嘴窗口结束，回底层', `${m.frame(4250).set}#${m.frame(4250).num}/${m.frame(4250).layer}`, 'idle#5/base');
  eq('t=4290 → 眨眼推迟到此刻开始', `${(m.update(4290), m.frame(4290).set)}#${m.frame(4290).num}/${m.frame(4290).layer}`, 'blink#5/blink');
}

console.log('\n== 7. 思考态的眨眼用「思考素材_闭眼」 ==');
{
  // blinkThinkingFactor 显式设 1：这段只测"思考态用哪套素材"，负荷系数另有专测
  const m = createPapercutMachine({ rng: () => 0, config: { blinkRecoverMinMs: 1000, blinkRecoverMaxMs: 1000, blinkClusterMinMs: 1000, blinkClusterMaxMs: 1000, blinkClusterMax: 1, blinkThinkingFactor: 1 } });
  m.setMode('thinking', 0);
  eq('t=1000 → think-blink#1（此时思考网格是 1）', at(m, 1000), 'think-blink#1/blink');
}

console.log('\n== 8. 配置自洽 ==');
{
  const c = DEFAULT_CONFIG;
  eq('中间帧时长 = 2000×7/8 之后的余量（250ms）', c.slotMs - (c.slotMs * c.midNumer) / c.midDenom, c.midMs);
  eq('待机循环 = 3 槽 × 2s = 6000ms', c.idleSlots.length * c.slotMs, 6000);
  eq('思考循环 = 2 槽 × 2s = 4000ms', c.thinkSlots.length * c.slotMs, 4000);
  // 眨眼：单次时长固定（用户要求"一次眨眼的时间保持不变"），间隔是"长恢复期 + 簇内短间隔"
  eq('单次眨眼时长固定 250ms（用户要求，且落在文献 150–400ms 内）', c.blinkMs, 250);
  eq('间隔下限（簇内）0.6–2.0s —— 对应文献"多数间隔 0.5–2s"', [c.blinkClusterMinMs, c.blinkClusterMaxMs], [600, 2000]);
  eq('恢复期 3.4–7s（2026-10-01 用户要求"眨眼再多一点"：压恢复期，簇行为不动）', [c.blinkRecoverMinMs, c.blinkRecoverMaxMs], [3400, 7000]);
  eq('一簇最多 3 次（1–3 均匀，均值 2 次/簇）', c.blinkClusterMax, 3);
  {
    // 解析期望率：每簇 = 1 段恢复期(均值 6.5s) + (k-1) 段短间隔(均值 1.3s)，k 均匀取 1..3
    const recover = (c.blinkRecoverMinMs + c.blinkRecoverMaxMs) / 2
    const short = (c.blinkClusterMinMs + c.blinkClusterMaxMs) / 2
    const perCycleMs = recover + 1 * short      // E[k-1] = 1
    const rate = (2 / perCycleMs) * 60000       // E[k] = 2 次眨眼
    eq('解析期望率落在人类区间 12.5–20 次/分', rate >= 12.5 && rate <= 20, true)
    console.log(`     （解析值：${rate.toFixed(1)} 次/分，均值间隔 ${(perCycleMs / 2 / 1000).toFixed(2)}s）`)
  }
}

console.log('\n== 9. 时间戳守卫（缺失 now 要就地响亮失败，不能一路 NaN 到 slot.base） ==');
{
  const m = createPapercutMachine({ rng: () => 0 });
  const throws = (label, fn) => {
    try { fn(); fail++; console.log(`  ❌ ${label}（没抛）`); }
    catch (e) { pass++; console.log(`  ✅ ${label} — ${e.constructor.name}: ${String(e.message).slice(0, 60)}…`); }
  };
  throws('setMode 缺 now', () => m.setMode('thinking'));
  throws('setTalking 缺 now', () => m.setTalking(true));
  throws('reset 缺 now', () => m.reset());
  throws('update 缺 now', () => m.update(NaN));
  throws('frame 缺 now', () => m.frame(undefined));
  throws('未知状态名', () => m.setMode('sleepy', 0));
}

// ── 眨眼分布统计（2026-09-30 按人类研究重做后的核心验收）───────────────
/** 确定性 PRNG（mulberry32）：分布测试必须可复现，不能用 Math.random */
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
/** 跑 minutes 分钟，返回每次眨眼的起始时刻与实测时长 */
const runBlinks = (minutes, { thinking = false, seed = 7 } = {}) => {
  const m = createPapercutMachine({ rng: seeded(seed) })
  m.reset(0)
  if (thinking) m.setMode('thinking', 0)
  const blinks = []
  let inBlink = false, start = 0
  for (let t = 0; t <= minutes * 60000; t += 5) {
    m.update(t)
    const f = m.frame(t)
    if (f.layer === 'blink') {
      if (!inBlink) { inBlink = true; start = t }
    } else if (inBlink) { inBlink = false; blinks.push({ at: start, ms: t - start }) }
  }
  return blinks
}

console.log('\n== 10. 眨眼分布：成簇 + 长恢复期（模拟 10 分钟）==');
{
  const blinks = runBlinks(10)
  const gaps = blinks.slice(1).map((b, i) => b.at - blinks[i].at)
  const rate = blinks.length / 10
  const shortShare = gaps.filter((g) => g <= 2500).length / gaps.length
  const longShare = gaps.filter((g) => g >= 4000).length / gaps.length
  const durations = blinks.map((b) => b.ms)
  console.log(`     眨眼 ${blinks.length} 次 = ${rate.toFixed(1)} 次/分；间隔：最短 ${Math.min(...gaps)}ms 最长 ${Math.max(...gaps)}ms`)
  console.log(`     短间隔(≤2.5s) 占 ${(shortShare * 100).toFixed(0)}%，长间隔(≥4s) 占 ${(longShare * 100).toFixed(0)}%`)
  eq('频率落在人类区间 12.5–20 次/分', rate >= 12.5 && rate <= 20, true)
  eq('成簇（短间隔占比 ≥ 25%）', shortShare >= 0.25, true)
  eq('有长恢复期（长间隔占比 ≥ 25%）', longShare >= 0.25, true)
  eq('存在连续快眨（最短间隔 < 1s）', Math.min(...gaps) < 1000, true)
  eq('单次时长恒定（用户要求保持不变）', Math.max(...durations) - Math.min(...durations) <= 5, true)
  eq('单次时长 = 250ms（含采样误差 5ms）', Math.min(...durations) >= 250 && Math.max(...durations) <= 255, true)
}

console.log('\n== 11. 思考态（高认知负荷）眨眼变少 ==');
{
  const idle = runBlinks(10, { seed: 11 })
  const think = runBlinks(10, { thinking: true, seed: 11 })
  const idleRate = idle.length / 10, thinkRate = think.length / 10
  console.log(`     待机 ${idleRate.toFixed(1)} 次/分  vs  思考 ${thinkRate.toFixed(1)} 次/分（系数 ${DEFAULT_CONFIG.blinkThinkingFactor}）`)
  eq('思考态明显少于待机（< 待机的 80%）', thinkRate < idleRate * 0.8, true)
  eq('思考态仍在正常人类区间内（不是完全不动）', thinkRate >= 5 && thinkRate <= 20, true)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

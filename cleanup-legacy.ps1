# 删除旧立绘 / 表情决策器 / 情绪流 的一切（2026-09-30）
#
# 背景：立绘换成剪纸序列帧（app/public/papercut*.js），用户明确要求"以前的全部删除"。
#
# 删除范围
#   · 旧立绘舞台：avatar.js（15 情绪状态序列帧 + CSS steps 播放）、frame-scheduler.js、
#     avatar-preview.html，以及 15 态帧池（assets/avatar、avatar-v1、frames-24fps、
#     frames-thinking、loopcheck、keytest、inspect/ui-shots）
#   · 表情决策器：public/expression-decider.js + companion/expression-decider.js（转发壳）
#   · 情绪流：companion/emotion-stream.js（标记剥离与分段）
#   · 上述三者的测试 / 构建 / 诊断脚本，以及旧素材管线脚本
#
# 有意保留（不在本脚本内，删了不可逆或还有用）
#   · assets/raw/            6 个源视频，13.6 MB —— **唯一母本**
#   · assets/avatar-unnormalized/  15 张原始立绘 —— 唯一母本
#   · state/                 会话与数据库（记忆/人设/主动搭话都在这）
#   · 后端情绪数值引擎 state.js / affect.js / appraisal.js / persona.js / memory.js /
#     initiative.js / guard.js / clock.js / questionnaire.js —— 与立绘无关，聊天的人味靠它们
#   · 聊天相关验收脚本（acceptance / e2e-verify / guard / memory / initiative /
#     questionnaire / voice / ws / 打字速度 / 气泡）
#   · start-companion.ps1、status-companion.ps1
#
# 用法：pwsh -File cleanup-legacy.ps1

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath 'E:\deepseek harness workspace1\projects\companion-agent'

$keep = @'
保留：assets/raw（源视频母本）、assets/avatar-unnormalized（15 张原始立绘）、
      state/、后端情绪数值引擎（state/affect/appraisal/persona/memory/initiative/guard/clock）、
      聊天类验收脚本、start-companion.ps1、status-companion.ps1
'@

$files = @(
  # ── 旧立绘舞台 ──
  'app\public\avatar.js'
  'app\public\avatar-preview.html'
  'app\public\frame-scheduler.js'
  # ── 表情决策器（两份）──
  'app\public\expression-decider.js'
  'app\companion\expression-decider.js'
  # ── 情绪流 ──
  'app\companion\emotion-stream.js'
  # ── 它们的测试 ──
  'app\expression-decider-test.mjs'
  'app\frame-scheduler-test.mjs'
  'app\emotion-stream-test.mjs'
  'app\test-avatar-runtime.mjs'
  'app\test-fade-timing.mjs'
  'app\verify-stage.mjs'
  'app\test-history-strip.mjs'
  'app\emotion-regression.mjs'
  'app\expression-breakdown.mjs'
  'app\measure-emotion-demo.mjs'
  'app\segment-length-tradeoff.mjs'
  # ── 旧素材构建 / 拆帧 / 抠像 / 诊断脚本 ──
  'app\build-avatar.mjs'
  'app\build-manifest.mjs'
  'app\build-preview.mjs'
  'app\make-sprites.mjs'
  'app\make-contact-sheet.mjs'
  'app\analyze-motion.mjs'
  'app\analyze-thinking-video.mjs'
  'app\asset-inspect.mjs'
  'app\bg-gradient.mjs'
  'app\find-neutral.mjs'
  'app\green-specks.mjs'
  'app\diagnose-avatar-crop.mjs'
  'app\diagnose-avatar-jump.mjs'
  'app\diagnose-css.mjs'
  'app\diagnose-drift.mjs'
  'app\diagnose-head-crop.mjs'
  'app\diagnose-position-jump.mjs'
  'app\diagnose-scale.mjs'
  'app\measure-cross-correlation.mjs'
  'app\measure-lateral-jitter.mjs'
  'app\measure-pixel-drift.mjs'
  'app\measure-render-headroom.mjs'
  'app\measure-sprite-alignment.mjs'
  'app\measure-sprite-bounds.mjs'
  'app\pool-compat.mjs'
  'app\plan-segments.mjs'
  'app\probe-keycolor.mjs'
  'app\probe-image-download.mjs'
  'app\trace-motion.mjs'
  'app\verify-key.mjs'
  'app\verify-loop.mjs'
  'app\verify-sprite-math.mjs'
  'app\verify-thinking-asset.mjs'
  # ── 旧素材管线脚本（项目根）──
  'run-pipeline.ps1'
  'inspect-asset.ps1'
  'rerun-one.ps1'
  # ── 旧分段计划（给旧立绘排的）──
  'assets\segment-plan.json'
  'assets\segments.manual.json'
  'assets\segments.v2.json'
)

$dirs = @(
  'assets\avatar'
  'assets\avatar-v1'
  'assets\frames-24fps'
  'assets\frames-thinking'
  'assets\loopcheck'
  'assets\keytest'
  'assets\inspect'
  'assets\ui-shots'
  'assets\papercut-src'   # 分析用的临时拷贝，正式素材已在 app/public/papercut
)

$nFile = 0; $nDir = 0; $freed = 0
foreach ($f in $files) {
  if (Test-Path -LiteralPath $f) {
    $freed += (Get-Item -LiteralPath $f).Length
    Remove-Item -LiteralPath $f -Force
    $nFile++
  }
}
foreach ($d in $dirs) {
  if (Test-Path -LiteralPath $d) {
    $freed += (Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    Remove-Item -LiteralPath $d -Recurse -Force
    $nDir++
  }
}

# 旧素材侧文档归档（知识留着，但从根目录挪走，免得看起来还作数）
if (-not (Test-Path -LiteralPath 'docs-legacy')) { New-Item -ItemType Directory -Path 'docs-legacy' | Out-Null }
foreach ($doc in @('立绘素材任务单.md', '帧池清点与缺口.md', '最终状态映射.md')) {
  if (Test-Path -LiteralPath $doc) { Move-Item -LiteralPath $doc -Destination 'docs-legacy\' -Force }
}

"删除：文件 $nFile 个 + 目录 $nDir 个，释放 $([math]::Round($freed / 1MB, 1)) MB"
''
$keep
''
'--- 项目根 ---'
Get-ChildItem -LiteralPath '.' | Select-Object -ExpandProperty Name | Sort-Object | ForEach-Object { "  $_" }
''
'--- assets 剩余 ---'
Get-ChildItem -LiteralPath 'assets' | ForEach-Object {
  $mb = if ($_.PSIsContainer) { [math]::Round(((Get-ChildItem -LiteralPath $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB, 1) } else { [math]::Round($_.Length / 1MB, 1) }
  "  {0,-24} {1} MB" -f $_.Name, $mb
}

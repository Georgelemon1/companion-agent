# companion-agent 状态查询 —— 一条命令看清全部可观测面。
#
# 用法：
#   .\status-companion.ps1              完整状态
#   .\status-companion.ps1 -Brief       只显示健康与进程
#   .\status-companion.ps1 -Log 30      额外显示最近 30 行日志
#
# 这是"方便监测"的主入口：不需要我自己在线，任何人随时都能跑。

param(
  [switch]$Brief,
  [int]$Log = 0,
  [int]$Port = 4180
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$AppDir = Join-Path $Root 'app'
$StateDir = Join-Path $Root 'state'
$LogFile = Join-Path $StateDir 'companion.log'

function Section($title) { Write-Host ""; Write-Host "── $title " -ForegroundColor Cyan -NoNewline; Write-Host ("─" * [Math]::Max(1, 60 - $title.Length)) -ForegroundColor DarkGray }

# ── 1. 进程与端口 ─────────────────────────────────────────────────────────
Section '进程与端口'
$listenerPid = $null
$line = netstat -ano | Select-String ":$Port\s+.*LISTENING" | Select-Object -First 1
if ($line) {
  $fields = ($line.Line -split '\s+') | Where-Object { $_ -ne '' }
  $listenerPid = [int]$fields[-1]
  $proc = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
  $uptimeMin = if ($proc) { [math]::Round(((Get-Date) - $proc.StartTime).TotalMinutes, 1) } else { $null }
  Write-Host ("  状态      : {0}" -f "运行中".PadRight(20)) -ForegroundColor Green
  Write-Host ("  pid       : {0}" -f $listenerPid)
  Write-Host ("  进程      : {0}" -f $proc.ProcessName)
  Write-Host ("  启动时间  : {0}" -f $proc.StartTime)
  Write-Host ("  运行时长  : {0} 分钟" -f $uptimeMin)
  Write-Host ("  内存      : {0} MB" -f [math]::Round($proc.WorkingSet64 / 1MB, 1))
} else {
  # 端口没监听**不等于**没在跑：启动要 20–30 秒，期间端口尚未 bind。
  # 只看端口会把"正在启动"误报成"未运行"（实测就是这样自相矛盾的）。
  # 所以这里再探一次 health：能应答就说明进程活着。
  $alive = $false
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/companion/health" -TimeoutSec 3 -UseBasicParsing
    $alive = $true
  } catch { $alive = $false }

  if ($alive) {
    Write-Host ("  状态      : {0}" -f "启动中（端口尚未就绪）".PadRight(20)) -ForegroundColor Yellow
  } else {
    Write-Host "  状态      : 未运行（端口 $Port 无监听，health 也无应答）" -ForegroundColor Yellow
  }
}

# ── 2. 健康检查 ───────────────────────────────────────────────────────────
Section '健康检查'
$health = $null
try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/companion/health" -TimeoutSec 6 -UseBasicParsing
  $health = $resp.Content | ConvertFrom-Json
  Write-Host ("  HTTP      : 200") -ForegroundColor Green
  Write-Host ("  ok        : {0}" -f $health.ok)
  Write-Host ("  status    : {0}" -f $health.status)
  Write-Host ("  会话      : {0}" -f $health.sessionId)
  Write-Host ("  已连接客户端: {0}" -f $health.clients)
  if ($health.error) { Write-Host ("  错误      : {0}" -f $health.error) -ForegroundColor Red }
} catch {
  Write-Host ("  无响应    : {0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

if ($Brief) { return }

# ── 3. 插件加载情况（读日志里的"就绪"行）──────────────────────────────────
Section '插件'
$expected = @{
  'companion-affect'  = '情感骨骼'
  'companion-guard'   = '安全护栏'
  'companion-persona' = '人设层'
  'companion-clock'   = '时钟'
  'companion-web'     = '前端通道'
}
$logText = if (Test-Path $LogFile) { Get-Content $LogFile -Raw } else { '' }
foreach ($key in $expected.Keys | Sort-Object) {
  $pattern = "\[$key\].*就绪"
  $hit = $logText -match $pattern
  $mark = if ($hit) { '✅' } else { '❓' }
  $color = if ($hit) { 'Gray' } else { 'Yellow' }
  Write-Host ("  {0} {1,-20} {2}" -f $mark, $key, $expected[$key]) -ForegroundColor $color
}

# ── 4. 运行时状态（SQLite 由 Node 助手读）──────────────────────────────────
Section '运行时状态'
$json = & node (Join-Path $AppDir 'status-json.mjs') $StateDir 2>$null | Out-String
$st = $null
try { $st = $json | ConvertFrom-Json } catch { Write-Host "  读取失败（无法解析助手输出）" -ForegroundColor Yellow }

if ($st) {
  if ($st.persona) {
    Write-Host ("  角色      : {0}  立场={1}  来源={2}" -f $st.persona.name, $st.persona.relationKey, $st.persona.source)
  }
  if ($st.affect) {
    $emo = ($st.affect.emotions.PSObject.Properties | Sort-Object Value -Descending | Select-Object -First 4 |
      ForEach-Object { "$($_.Name)=$([math]::Round($_.Value,1))" }) -join '  '
    if (-not $emo) { $emo = '（无情绪，平静）' }
    Write-Host ("  情绪      : {0}" -f $emo)
    Write-Host ("  心情 PAD  : p={0} a={1} d={2}" -f $st.affect.mood.p, $st.affect.mood.a, $st.affect.mood.d)
  }
  if ($st.relation) {
    Write-Host ("  关系      : {0}  信任={1}  亲密={2}  热络={3}  聊过={4}轮  认识={5}天" -f `
      $st.relation.stage, $st.relation.trust, $st.relation.intimacy, $st.relation.rapport, $st.relation.turns, $st.relation.days)
  }
  Write-Host ("  记忆卡片  : {0} 张" -f $st.memory.count)
  foreach ($c in $st.memory.cards | Select-Object -First 5) {
    Write-Host ("      [{0}] {1}  (提过 {2} 次)" -f $c.importance, $c.content, $c.told)
  }
  if ($st.initiative) {
    Write-Host ("  主动性    : 今日已发 {0} 条  连续未回应 {1} 次  空闲 {2} 小时" -f `
      $st.initiative.sentToday, $st.initiative.missStreak, $st.initiative.idleHours)
    foreach ($r in $st.initiative.recent | Select-Object -First 3) {
      $when = [DateTimeOffset]::FromUnixTimeMilliseconds($r.at).LocalDateTime
      Write-Host ("      {0}  {1}  score={2}  {3}" -f $when.ToString('MM-dd HH:mm'), $r.kind, $r.score, $r.content)
    }
  }
  Write-Host ("  数据库    : db={0} KB  WAL={1} KB  shm={2} KB" -f `
    [math]::Round($st.files.db / 1KB, 1), [math]::Round($st.files.wal / 1KB, 1), [math]::Round($st.files.shm / 1KB, 1))
  # WAL 健康提示：超过 1MB 就值得看一眼
  if ($st.files.wal -gt 1MB) {
    Write-Host ("     ⚠ WAL 偏大（{0} KB）。周期 checkpoint 应能压住；持续增长说明维护没生效。" -f [math]::Round($st.files.wal / 1KB)) -ForegroundColor Yellow
  }
}

# ── 5. 可选：日志尾部 ─────────────────────────────────────────────────────
if ($Log -gt 0) {
  Section "最近 $Log 行日志"
  if (Test-Path $LogFile) {
    Get-Content $LogFile -Tail $Log | ForEach-Object { Write-Host "  $_" }
  } else {
    Write-Host "  日志文件不存在：$LogFile" -ForegroundColor Yellow
  }
}

Write-Host ""

# companion-agent 启动 / 停止 / 重启 / 状态
#
# 用法：
#   .\start-companion.ps1              前台启动（Ctrl+C 停止；父进程=当前终端）
#   .\start-companion.ps1 -Detach      后台常驻启动（父进程=计划任务，终端关掉也不停）
#   .\start-companion.ps1 -Stop        停止（优先走 pid 文件，端口兜底）
#   .\start-companion.ps1 -Restart     先停再启动（前台）
#   .\start-companion.ps1 -Status      查看状态（等同 .\status-companion.ps1）
#
# 完整可观测面入口：.\status-companion.ps1
#
# 为什么要 -Detach：前台模式下"这个启动脚本"就是应用的父进程，
# 终端一关、或 agent 会话一结束，应用跟着死。计划任务启动让父进程脱离终端。
#
# 踩过的坑：
#   · 端口被"孤儿 node"占住时 Get-NetTCPConnection 查不到，必须用 netstat 取 pid
#   · 应用把 SQLite 连接常开，所以数据文件（含 -wal/-shm）在运行期间不能随便删

param(
  [switch]$Stop,
  [switch]$Restart,
  [switch]$Status,
  [switch]$Detach,
  [int]$Port = 4180
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$AppDir = Join-Path $Root 'app'
$StateDir = Join-Path $Root 'state'
$Launcher = Join-Path $AppDir 'launcher.mjs'
$PidFile = Join-Path $StateDir 'companion.pid'
$TaskName = 'companion-agent'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Get-ListenerPid {
  param([int]$P)
  $line = netstat -ano | Select-String ":$P\s+.*LISTENING" | Select-Object -First 1
  if (-not $line) { return $null }
  $fields = ($line.Line -split '\s+') | Where-Object { $_ -ne '' }
  return [int]$fields[-1]
}

function Stop-Instance {
  param([int]$P)
  $stopped = $false

  # 优先用 pid 文件：它记的是我们真正启动的那个进程。
  if (Test-Path $PidFile) {
    $recorded = (Get-Content $PidFile -Raw).Trim()
    if ($recorded -match '^\d+$') {
      $proc = Get-Process -Id ([int]$recorded) -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "停止进程 pid=$recorded（来自 pid 文件）"
        Stop-Process -Id ([int]$recorded) -Force -ErrorAction SilentlyContinue
        $stopped = $true
        Start-Sleep -Seconds 2
      }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }

  # 端口兜底：可能还有孤儿进程占着。
  for ($i = 0; $i -lt 5; $i++) {
    $listener = Get-ListenerPid -P $P
    if ($null -eq $listener) { break }
    Write-Host "停止监听 $P 的进程 pid=$listener"
    Stop-Process -Id $listener -Force -ErrorAction SilentlyContinue
    $stopped = $true
    Start-Sleep -Seconds 1
  }

  # 计划任务也要清掉（Detach 模式注册的）。
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已移除计划任务 $TaskName"
  }

  if (-not $stopped) { Write-Host "本来就没有在运行。" }
}

if ($Stop) {
  Stop-Instance -P $Port
  Write-Host "已停止。" -ForegroundColor Green
  exit 0
}

if ($Restart) {
  Stop-Instance -P $Port
  Start-Sleep -Seconds 1
}

if ($Status) {
  & (Join-Path $Root 'status-companion.ps1') -Port $Port
  exit 0
}

# 已经在跑就别再起一个（否则 EADDRINUSE）。
$existing = Get-ListenerPid -P $Port
if ($null -ne $existing) {
  Write-Host "端口 $Port 已被 pid=$existing 占用，可能已有实例在跑。" -ForegroundColor Yellow
  & (Join-Path $Root 'status-companion.ps1') -Brief -Port $Port
  Write-Host "如要重启：.\start-companion.ps1 -Restart" -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path $Launcher)) { throw "找不到启动器：$Launcher" }
$nodeExe = (Get-Command node -ErrorAction Stop).Source

# ── 应用专用凭据注入（state\companion.env，可选）────────────────────────────
#
# 为什么要单独一份 key：DEEPSEEK_API_KEY 在 dsh-credentials-local 里是**分层**的 ——
#     继承的进程环境变量  >  $DSH_HOME/.credentials.yaml  >  <cwd>/.env  >  $DSH_HOME/.env
# 环境变量最优先（插件注释：那是"本次运行的显式意图"）。所以只给本应用的进程注入，
# "她"就用一把独立的 key，而**全局凭据与其它 DSH 会话不受任何影响**。
#
# 为什么不用 .env 文件：两个 .env 位置都在分层里**输给**受管凭据库，起不到覆盖作用。
#
# 格式：KEY=VALUE，一行一项，# 开头是注释。文件是明文凭据，别提交、别入库。
$envFile = Join-Path $StateDir 'companion.env'
if (Test-Path $envFile) {
  $injected = @()
  foreach ($line in Get-Content -LiteralPath $envFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    $v = $t.Substring($eq + 1).Trim().Trim('"')
    Set-Item -Path "env:$k" -Value $v
    # 日志里只留脱敏尾巴，避免凭据落进 stdout.log
    $masked = if ($v.Length -gt 14) { $v.Substring(0, 8) + '…' + $v.Substring($v.Length - 4) } else { '***' }
    $injected += "$k=$masked"
  }
  if ($injected.Count -gt 0) {
    Write-Host "已注入应用专用凭据：$($injected -join ', ')  （来自 state\companion.env）" -ForegroundColor DarkCyan
  }
}

if ($Detach) {
  # 用 Start-Process 分离启动：不依赖 CIM，父进程随本脚本退出而消失，
  # 应用成为独立进程（关掉终端、结束 agent 会话都不影响）。
  #
  # 为什么不用计划任务：本机 CIM 被禁（Get-CimInstance 一直拿不到命令行就是这个原因），
  # 而 Register-ScheduledTask 依赖 CIM，实测直接报"无法从客户端中访问 CIM 资源"。
  #
  # ⚠️ 在 **agent 工具的 pwsh 里**不要用这条：工具把命令跑在 Windows Job 对象里，
  #    这里起的子进程会随 Job 一起被收走（表现为"应用莫名消失"）。
  #    那种场合请用计划任务：schtasks /run /tn companion-agent（见 凭据与启动.md）。
  $stdoutLog = Join-Path $StateDir 'stdout.log'

  $proc = Start-Process -FilePath $nodeExe -ArgumentList "`"$Launcher`"" `
    -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError (Join-Path $StateDir 'stderr.log')

  Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII
  Write-Host "已分离启动（pid=$($proc.Id)，关终端不影响）。" -ForegroundColor Cyan

  # 等端口就绪
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if (-not $proc.HasExited -and $null -ne (Get-ListenerPid -P $Port)) { break }
    if ($proc.HasExited) { break }
  }

  if ($proc.HasExited) {
    Write-Host "进程已退出（exit=$($proc.ExitCode)）。看这两个文件：" -ForegroundColor Red
    Write-Host "  $StateDir\companion.log"
    Write-Host "  $StateDir\stderr.log"
  } else {
    $listener = Get-ListenerPid -P $Port
    if ($null -ne $listener) {
      Write-Host "已监听 http://127.0.0.1:$Port" -ForegroundColor Green
    } else {
      Write-Host "进程活着但端口未就绪，看 $StateDir\companion.log" -ForegroundColor Yellow
    }
  }
  Write-Host "停止：.\start-companion.ps1 -Stop    状态：.\status-companion.ps1"
  exit 0
}

Write-Host "前台启动 companion-agent ..." -ForegroundColor Cyan
Write-Host "  应用目录：$AppDir"
Write-Host "  状态目录：$StateDir"
Write-Host "  打开    ：http://127.0.0.1:$Port"
Write-Host "  Ctrl+C 停止；或另开终端跑 .\start-companion.ps1 -Stop"
Write-Host "  想关掉终端也不停：.\start-companion.ps1 -Detach"
Write-Host ""

# 记录自己的 pid，方便 -Stop 精确停止。
$nodeProc = Start-Process -FilePath $nodeExe -ArgumentList "`"$Launcher`"" `
  -WorkingDirectory $Root -NoNewWindow -PassThru
Set-Content -Path $PidFile -Value $nodeProc.Id -Encoding ASCII
$nodeProc.WaitForExit()
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
exit $nodeProc.ExitCode

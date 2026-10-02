# companion-agent · 前台运行入口（供计划任务调用，不分离进程）
#
# 与 start-companion.ps1 -Detach 的区别：
#   -Detach 用 Start-Process 起子进程后脚本即退出。在"命令跑在 Windows Job 对象里"的
#   调用方（例如 agent 工具）下，子进程会随 Job 一起被收走 —— 应用就莫名其妙消失。
#   本脚本**不做分离**：它自己就是那个长驻进程的父，由计划任务持有，因此活在工具 Job 之外。
#
# 职责只有两件：① 注入 state\companion.env 里的应用专用凭据；② 前台跑 node。
# 启停请用：schtasks /run /tn companion-agent 与 schtasks /end /tn companion-agent
param([int]$Port = 4180)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$StateDir = Join-Path $Root 'state'
$Launcher = Join-Path $Root 'app\launcher.mjs'
$PidFile = Join-Path $StateDir 'companion.pid'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# ① 应用专用凭据（分层里"继承的环境变量"优先，详见 凭据与启动.md）
$envFile = Join-Path $StateDir 'companion.env'
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    Set-Item -Path "env:$($t.Substring(0, $eq).Trim())" -Value $t.Substring($eq + 1).Trim().Trim('"')
  }
}

$nodeExe = $null
try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch { }
if (-not $nodeExe) {
  # 计划任务的环境变量和我们交互式终端不一样：PATH 里未必有 node（本机它在 D:\node.exe）。
  foreach ($cand in @('D:\node.exe', 'C:\Program Files\nodejs\node.exe', "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path -LiteralPath $cand) { $nodeExe = $cand; break }
  }
}
$foregroundLog = Join-Path $StateDir 'companion-foreground.log'
if (-not $nodeExe) {
  "找不到 node 可执行文件（PATH 与常见路径都没有）" | Out-File -FilePath $foregroundLog -Append -Encoding UTF8
  exit 127
}
"=== 启动 $(Get-Date -Format o)  node=$nodeExe  pid=$PID" | Out-File -FilePath $foregroundLog -Append -Encoding UTF8
Set-Content -Path $PidFile -Value $PID -Encoding ASCII

# ② 前台跑（本进程不退，应用就是它的子进程）；输出落到 state\ 便于事后诊断
& $nodeExe $Launcher 1>> (Join-Path $StateDir 'stdout.log') 2>> (Join-Path $StateDir 'stderr.log')
$code = $LASTEXITCODE
"=== 退出 $(Get-Date -Format o)  exit=$code" | Out-File -FilePath $foregroundLog -Append -Encoding UTF8
exit $code

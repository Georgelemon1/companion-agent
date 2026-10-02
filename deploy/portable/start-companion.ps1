# companion-agent · 便携版启动器（面向"下载即用"的用户）
#
# 设计原则：**不改动对方电脑的任何东西**。
#   · node 用包里自带的 .\node.exe，不要求对方装 Node
#   · DSH_HOME 指向包内的 .\dsh-home，不碰对方的 ~/.dsh（也就不会污染他已有的 DSH 配置）
#   · 首次运行才创建 state\companion.env 并要求填自己的 API key（包里不含任何人的凭据）
#
# 兼容性：按 Windows PowerShell 5.1 写（系统自带），只用 5.1 也支持的语法。
#           本文件必须保存为 UTF-8 **带 BOM**，否则 5.1 会把中文读成乱码。

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

$NodeExe = Join-Path $Root 'node.exe'
$Launcher = Join-Path $Root 'app\launcher.mjs'
$StateDir = Join-Path $Root 'state'
$EnvFile = Join-Path $StateDir 'companion.env'
$DshHome = Join-Path $Root 'dsh-home'

Write-Host ""
Write-Host "  ==============================================" -ForegroundColor Cyan
Write-Host "   companion-agent 便携版" -ForegroundColor Cyan
Write-Host "  ==============================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path -LiteralPath $NodeExe)) { throw "缺少 node.exe —— 包没解压完整？" }
if (-not (Test-Path -LiteralPath $Launcher)) { throw "缺少 app\launcher.mjs —— 包没解压完整？" }

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $DshHome | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $StateDir 'sessions') | Out-Null

# ── 首次运行：引导填自己的 API key ─────────────────────────────────────────
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Write-Host "  第一次运行，需要填入你自己的 DeepSeek API key。" -ForegroundColor Yellow
  Write-Host "  （她靠这个 key 调用模型说话；key 只存在本目录 state\companion.env 里，不会外传）"
  Write-Host "  申请地址：https://platform.deepseek.com/" -ForegroundColor DarkGray
  Write-Host ""
  $key = Read-Host "  请粘贴 API key（sk- 开头，回车确认）"
  $key = $key.Trim()
  if ($key -eq '') {
    Write-Host "  没有填 key，先退出。下次运行会再问一次。" -ForegroundColor Red
    exit 1
  }
  $lines = @(
    '# companion-agent 便携版凭据（自己填的那把 key）',
    '# 由启动器注入进程环境变量；明文文件，别外传。',
    "DEEPSEEK_API_KEY=$key"
  )
  $lines | Set-Content -LiteralPath $EnvFile -Encoding UTF8
  Write-Host "  已保存到 state\companion.env" -ForegroundColor Green
  Write-Host ""
}

# ── 注入凭据 + 便携 DSH_HOME ───────────────────────────────────────────────
foreach ($line in Get-Content -LiteralPath $EnvFile) {
  $t = $line.Trim()
  if ($t -eq '' -or $t.StartsWith('#')) { continue }
  $eq = $t.IndexOf('=')
  if ($eq -lt 1) { continue }
  Set-Item -Path ("env:" + $t.Substring(0, $eq).Trim()) -Value $t.Substring($eq + 1).Trim().Trim('"')
}
Set-Item -Path 'env:DSH_HOME' -Value $DshHome

Write-Host "  界面地址： http://127.0.0.1:4180" -ForegroundColor Green
Write-Host "  停止：     直接关掉这个窗口（或按 Ctrl+C）"
Write-Host ""

# ── 起浏览器（等服务起来再开，避免白页）────────────────────────────────────
Start-Job -ScriptBlock {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest 'http://127.0.0.1:4180/companion/health' -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:4180'; break }
    } catch { }
  }
} | Out-Null

# ── 前台跑（窗口关掉 = 她下班）─────────────────────────────────────────────
& $NodeExe $Launcher
$code = $LASTEXITCODE
Write-Host ""
Write-Host "  她已停止（exit=$code）。重新运行请再双击 启动.cmd" -ForegroundColor DarkGray
Read-Host "  按回车关闭窗口"
exit $code

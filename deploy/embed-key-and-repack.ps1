# 把本项目的 API key 装进**已经打好的**便携包里，并重新打包
#
# 用途：自己实验时希望"解压就能用"，不想每次手填 key。
#
# ⚠️ 含 key 的包 = 含凭据。只留给自己用；一旦转给别人，等于把 key 也给了对方。
#    默认的打包脚本（make-portable-*.ps1）**刻意不装 key** —— 面向分发时用默认的。
#
# 做法：启动器（Windows 的 start-companion.ps1 / macOS 的 启动.command）都只在
#       `state/companion.env` **不存在**时才要 key。所以把该文件预先放进去，就能跳过引导。
#
# 用法: pwsh -File deploy\embed-key-and-repack.ps1 [-Which all|win|mac-arm64|mac-x64]
param([ValidateSet('all', 'win', 'mac-arm64', 'mac-x64')][string]$Which = 'all')

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Dist = Join-Path $Root 'dist'
$EnvSrc = Join-Path $Root 'state\companion.env'
if (-not (Test-Path -LiteralPath $EnvSrc)) { throw "项目里没有 state\companion.env，先从哪儿拿 key？" }
$keyLine = (Get-Content -LiteralPath $EnvSrc | Where-Object { $_ -match '^DEEPSEEK_API_KEY=' })
if (-not $keyLine) { throw "state\companion.env 里没有 DEEPSEEK_API_KEY" }
$masked = $keyLine -replace '(sk-.{6}).*', '$1…'
Write-Host "将装入：$masked" -ForegroundColor Yellow
Write-Host ""

$targets = @()
if ($Which -in @('all', 'win')) { $targets += @{ Kind = 'win'; Dir = 'companion-agent-win-x64' } }
if ($Which -in @('all', 'mac-arm64')) { $targets += @{ Kind = 'mac'; Dir = 'companion-agent-mac-arm64' } }
if ($Which -in @('all', 'mac-x64')) { $targets += @{ Kind = 'mac'; Dir = 'companion-agent-mac-x64' } }

foreach ($t in $targets) {
  $tree = Join-Path $Dist $t.Dir
  if (-not (Test-Path -LiteralPath $tree)) { Write-Host "跳过 $($t.Dir)（不存在）" -ForegroundColor DarkGray; continue }
  if (-not (Test-Path (Join-Path $tree 'app\node_modules'))) { Write-Host "跳过 $($t.Dir)（依赖没装全，像是半成品）" -ForegroundColor DarkGray; continue }

  Write-Host "== $($t.Dir) =="
  $stateDir = Join-Path $tree 'state'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  # 与启动器期望的格式一致：一行 KEY=VALUE，附带说明注释
  @(
    '# companion-agent 便携版凭据（已预置，实验自用）',
    '# 明文文件：不要把这个包转给别人，否则等于把 key 一起给了对方。',
    $keyLine
  ) | Set-Content -LiteralPath (Join-Path $stateDir 'companion.env') -Encoding UTF8
  Write-Host "  已写入 state\companion.env"

  if ($t.Kind -eq 'win') {
    $zip = Join-Path $Dist "$($t.Dir).zip"
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    & tar -a -cf $zip -C $Dist $t.Dir
    if ($LASTEXITCODE -ne 0) { throw "压缩失败" }
    $inZip = & tar -tf $zip | Where-Object { $_ -eq "$($t.Dir)/state/companion.env" }
    Write-Host ("  {0}  {1:N1} MB  包内凭据: {2}" -f (Split-Path $zip -Leaf), ((Get-Item $zip).Length / 1MB), $(if ($inZip) { '✅' } else { '❌' }))
  } else {
    $plain = Join-Path $Dist "$($t.Dir).tar"
    $gz = Join-Path $Dist "$($t.Dir).tar.gz"
    if (Test-Path -LiteralPath $plain) { Remove-Item -LiteralPath $plain -Force }
    if (Test-Path -LiteralPath $gz) { Remove-Item -LiteralPath $gz -Force }
    & tar -cf $plain -C $Dist $t.Dir
    if ($LASTEXITCODE -ne 0) { throw "tar 失败" }
    & node (Join-Path $PSScriptRoot 'fix-tar-mode.mjs') $plain $gz '启动.command' 'node'
    if ($LASTEXITCODE -ne 0) { throw "改写权限位失败" }
    Remove-Item -LiteralPath $plain -Force
    Write-Host "  权限位回读校验："
    & node (Join-Path $PSScriptRoot 'verify-tar-mode.mjs') $gz '启动.command' 'node' | ForEach-Object { "  $_" }
    $inGz = & tar -tzf $gz | Where-Object { $_ -eq "$($t.Dir)/state/companion.env" }
    Write-Host ("  {0}  {1:N1} MB  包内凭据: {2}" -f (Split-Path $gz -Leaf), ((Get-Item $gz).Length / 1MB), $(if ($inGz) { '✅' } else { '❌' }))
  }
}
Write-Host ""
Write-Host "完成。这些包现在解压即可用（启动器发现 state\companion.env 已存在，不再提示填 key）。" -ForegroundColor Green

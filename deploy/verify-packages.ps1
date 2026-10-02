# 四份产物的统一终检：凭据、个人数据、入口文件、node 架构、可执行权限
#
# 为什么要有这个脚本：产物是"构建脚本自述"不可尽信 —— 实测踩过三次
#   ① tar 的 --exclude 写法不对，把 253 MB 的 node_modules 打进包（136 MB）
#   ② 归档条目名带顶层目录前缀，权限位匹配失败（0 个被改写）
#   ③ PAX 头条目被算进权限改写数，触发误报
# 所以终检**只读最终产物**，不看构建日志。
#
# 用法: pwsh -File deploy\verify-packages.ps1
$ErrorActionPreference = 'Stop'
# tar 是**原生命令**：不显式把控制台输出编码设成 UTF-8，中文条目名（启动.cmd / 启动.command）
# 会按代码页解码成乱码，导致"入口列全是 ❌"的假警报（实测踩过）。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path $PSScriptRoot -Parent
$Dist = Join-Path $Root 'dist'
$tmp = Join-Path $env:TEMP 'pkg-verify'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$macMagic = @{ arm64 = 0x0100000C; x64 = 0x01000007 }

function Get-Entries([string]$file) {
  if ($file.EndsWith('.zip')) { return & tar -tf $file }
  return & tar -tzf $file
}

# 从归档里抽出 node 二进制，验 Mach-O magic 与 cputype（PowerShell 注释用 #，不是 JS 的 /** */）
function Test-Macho([string]$file, [string]$entryGlob, [int]$wantCpu) {
  $out = Join-Path $tmp 'node-probe'
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  & tar -xzf $file -C $tmp $entryGlob 2>$null
  $found = Get-ChildItem $tmp -Recurse -File -Filter 'node' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { return '抽不出来' }
  $b = [System.IO.File]::ReadAllBytes($found.FullName)[0..7]
  $magic = ($b[0..3] | ForEach-Object { $_.ToString('X2') }) -join ''
  $cpu = [BitConverter]::ToUInt32($b, 4)
  $ok = ($magic -eq 'CFFAEDFE' -and $cpu -eq $wantCpu)
  Remove-Item $found.FullName -Force -ErrorAction SilentlyContinue
  return $(if ($ok) { "Mach-O ✅ ($([math]::Round($found.Length/1MB,1)) MB)" } else { "❌ magic=$magic cpu=0x$($cpu.ToString('X8'))" })
}

$targets = @(
  # AllowDb：手机包**故意**带记忆库快照（迁移她的记忆），桌面便携包必须不带（那是别人的干净起点）
  @{ Name = 'Windows x64 (zip)'; File = (Join-Path $Dist 'companion-agent-win-x64.zip'); Entry = '启动.cmd'; AllowDb = $false },
  @{ Name = 'macOS arm64 (tar.gz)'; File = (Join-Path $Dist 'companion-agent-mac-arm64.tar.gz'); Entry = '启动.command'; Arch = 'arm64'; AllowDb = $false },
  @{ Name = 'macOS x64 (tar.gz)'; File = (Join-Path $Dist 'companion-agent-mac-x64.tar.gz'); Entry = '启动.command'; Arch = 'x64'; AllowDb = $false },
  @{ Name = 'Android/Termux (tgz)'; File = (Join-Path $Root 'companion-phone.tgz'); Entry = 'deploy/termux-install.sh'; AllowDb = $true }
)

$rows = @()
foreach ($t in $targets) {
  if (-not (Test-Path -LiteralPath $t.File)) { $rows += [pscustomobject]@{ 产物 = $t.Name; 大小 = '-'; 条目 = 0; 凭据 = '缺文件'; 记忆库 = '-'; 入口 = '-'; 架构 = '-' }; continue }
  $entries = Get-Entries $t.File
  $mb = [math]::Round((Get-Item -LiteralPath $t.File).Length / 1MB, 1)

  $hasKey = @($entries | Where-Object { $_ -match 'state/companion\.env$' }).Count -gt 0
  $hasDb = @($entries | Where-Object { $_ -match 'state/companion\.db' }).Count -gt 0
  # 中文条目名（启动.cmd / 启动.command）**不在这里判**：tar 是原生命令，它的 stdout 会被
  # 按 OEM 代码页解码，PowerShell 侧怎么设 [Console]::OutputEncoding 都匹配不上（实测假警报）。
  # 所以：zip 只验 ASCII 后缀（*.cmd），tar.gz 的中文名校验交给 Node 直接读归档字节
  # （见下方 verify-tar-mode.mjs 的输出，那里会逐条打 ✅/❌ 并以退出码表态）。
  $hasEntry = $null
  if ($t.Entry -notmatch '[\u4e00-\u9fff]') {
    $hasEntry = @($entries | Where-Object { $_ -match ([regex]::Escape($t.Entry) + '$') }).Count -gt 0
  } elseif ($t.File.EndsWith('.zip')) {
    $hasEntry = @($entries | Where-Object { $_ -like '*.cmd' }).Count -gt 0
  }
  $arch = if ($t.Arch) { Test-Macho $t.File "*/node" $macMagic[$t.Arch] } else { '（非 Mach-O）' }

  $rows += [pscustomobject]@{
    产物   = $t.Name
    大小   = "$mb MB"
    条目   = $entries.Count
    凭据   = $(if ($hasKey) { '有（预置）' } else { '无（首启手填）' })
    记忆库 = $(if ($hasDb) { if ($t.AllowDb) { '有（迁移用）' } else { '⚠️ 不该有' } } else { if ($t.AllowDb) { '⚠️ 缺失' } else { '无 ✅' } })
    入口   = $(if ($null -eq $hasEntry) { '见权限校验' } elseif ($hasEntry) { '✅' } else { '❌' })
    架构   = $arch
  }
}
$rows | Format-Table -AutoSize | Out-String -Width 160

Write-Host "macOS 包的可执行权限（必须 0755，否则双击不了）："
foreach ($f in @('companion-agent-mac-arm64.tar.gz', 'companion-agent-mac-x64.tar.gz')) {
  $p = Join-Path $Dist $f
  if (Test-Path -LiteralPath $p) {
    Write-Host "  -- $f"
    & node (Join-Path $PSScriptRoot 'verify-tar-mode.mjs') $p '启动.command' 'node' | ForEach-Object { "  $_" }
  }
}
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

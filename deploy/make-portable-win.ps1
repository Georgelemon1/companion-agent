# 打"便携版"：一个 zip，别人下载解压双击就能用（Windows x64）
#
# 与手机端的区别：
#   · 手机端是把 app 代码交给 Termux 自己 npm install（包只有 13 MB）
#   · 便携版要**自带运行时与依赖**，所以体积大得多（node.exe 86 MB + DSH 依赖树）
#
# 关键设计（都在 deploy\portable\ 里）：
#   · 自带 node.exe，不要求对方装 Node
#   · DSH_HOME 指向包内 dsh-home，不碰对方的 ~/.dsh
#   · 不含任何人的 API key；首次运行引导对方填自己的（state\companion.env）
#   · 不含任何个人数据（记忆库 / 会话 / 截图都不打进去）
#
# 用法: pwsh -File deploy\make-portable-win.ps1
param(
  [string]$NodeExe = 'D:\node.exe',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Dist = Join-Path $Root 'dist'
$Target = Join-Path $Dist 'companion-agent-win-x64'

if (-not (Test-Path -LiteralPath $NodeExe)) { throw "找不到 node.exe：$NodeExe" }

Write-Host "== 清理旧产物 =="
if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Target | Out-Null

Write-Host "== 复制应用代码（排除 node_modules 与 npm junction）=="
# robocopy 的 /XD 按目录名排除：node_modules 是 Windows 依赖，npm 是指向本机 DSH 的 junction
& robocopy (Join-Path $Root 'app') (Join-Path $Target 'app') /E /XD node_modules npm /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（exit=$LASTEXITCODE）" }

Write-Host "== 放入 node.exe 与启动器 =="
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $Target 'node.exe') -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'portable\*') -Destination $Target -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'phone-package.json') -Destination (Join-Path $Target 'app\package.json') -Force

# 便携版不需要我这边的开发脚本与 Windows 专用脚本
Remove-Item -Path (Join-Path $Target 'app\*.ps1') -Force -ErrorAction SilentlyContinue

if (-not $SkipInstall) {
  Write-Host "== 安装依赖（最慢的一步；--ignore-scripts 避免原生编译）=="
  Push-Location (Join-Path $Target 'app')
  try {
    & npm install --ignore-scripts --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败（exit=$LASTEXITCODE）" }
  } finally { Pop-Location }
}

# ── 瘦身：删掉"已 disabled 的插件"所带的包 ──────────────────────────────────
# npm 按 package.json 装包，不看 cordis.patch.yml 里的 disabled —— 于是包里塞进了一整套
# 用不到的东西。实测（2026-09-30）：删掉下面这批，**解压体积 275.6 → 157.8 MB**，
# 压缩包 100.3 → 64.6 MB，且冒烟测试（起服务 + 真实回话）照常通过。
#   @img/sharp     ← 图像卸载（image-offload 已关）
#   node-pty       ← 持久终端（tool-pwsh / tool-bash 已关）
#   @opentelemetry ← 遥测（session-telemetry-otel 已关）
#   @google/openai/@anthropic-ai/@mistralai/@aws-sdk ← 其它模型供应商（llm-pi-ai 已关）
# ⚠️ 动过这个列表就**必须重跑冒烟测试**（脚本末尾有步骤）：删错一个包会让它在别人机器上起不来。
Write-Host "== 瘦身：删除运行时用不到的包 =="
$unused = @(
  '@img', 'sharp', 'node-pty', '@opentelemetry',
  '@google', '@anthropic-ai', '@mistralai', '@aws-sdk', '@aws-crypto',
  '@huggingface', '@xenova', 'openai', 'web-streams-polyfill',
  'onnxruntime-node', 'onnxruntime-common', 'onnx-proto'
)
$nm = Join-Path $Target 'app\node_modules'
$freedMb = 0
$removed = @()
foreach ($u in $unused) {
  $p = Join-Path $nm $u
  if (Test-Path -LiteralPath $p) {
    $freedMb += ((Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB
    Remove-Item -LiteralPath $p -Recurse -Force
    $removed += $u
  }
}
Write-Host ("  删除 {0} 项，释放 {1:N1} MB：{2}" -f $removed.Count, $freedMb, ($removed -join ', '))

# ── 清本地状态：分发包绝不能带个人数据 ─────────────────────────────────────
# 打包前若在本目录跑过冒烟测试，会留下 state\（她的记忆库/会话）与 dsh-home\（DSH 状态）。
Write-Host "== 清理本地状态（state\ 与 dsh-home\）=="
foreach ($p in @('state', 'dsh-home')) {
  $full = Join-Path $Target $p
  if (Test-Path -LiteralPath $full) {
    Remove-Item -LiteralPath $full -Recurse -Force
    Write-Host "  已删 $p\"
  }
}

Write-Host "== 写使用说明 =="
$readme = @'
companion-agent 便携版 —— 使用说明
==================================

一、怎么用
  1. 把整个文件夹解压到任意位置（路径别太深，也**别放在 C:\Program Files 下**，那里写入受限）
  2. 双击  启动.cmd
  3. 第一次会请你粘贴自己的 DeepSeek API key（申请：https://platform.deepseek.com/ ）
     —— 这不是我的 key，每个人用自己的；key 只存在本目录 state\companion.env 里
  4. 浏览器会自动打开 http://127.0.0.1:4180 ，她就站在那儿了
  5. 停止：关掉那个黑色窗口

二、她是什么
  一个住在你电脑里的陪伴型 AI：有立绘（序列帧动画，会眨眼、会张嘴说话）、
  有情绪与关系状态、会记住你说过的事，也会偶尔主动找你说话。
  数据全在本目录里（state\ 与 dsh-home\），不上传任何服务器——除了调用模型本身。

三、常见问题
  · 窗口一闪就没了？
      右键 启动.cmd → 编辑，或改用：在文件夹空白处 Shift+右键 →「在此处打开 PowerShell 窗口」，
      然后运行  .\start-companion.ps1   看报错原文。
  · 提示端口被占用？
      说明已经有一个实例在跑，先关掉那个窗口。
  · 怎么换 key？
      编辑 state\companion.env 里 DEEPSEEK_API_KEY= 那一行，然后重启。
  · 能换形象吗？
      能，但需要重做素材（app\public\papercut\）。换素材后要重新量一个背景色，见项目文档。

四、体积说明
  包里有 node.exe（约 86 MB）与一份完整的依赖树，所以解压后约 300 MB 左右。
  这是"下载即用、不装任何东西"的代价。
'@
$readme | Set-Content -LiteralPath (Join-Path $Target '使用说明.txt') -Encoding UTF8

Write-Host "== 自检 =="
$problems = @()
if (-not (Test-Path (Join-Path $Target 'node.exe'))) { $problems += '缺 node.exe' }
if (-not (Test-Path (Join-Path $Target '启动.cmd'))) { $problems += '缺 启动.cmd' }
if (-not (Test-Path (Join-Path $Target 'app\launcher.mjs'))) { $problems += '缺 app\launcher.mjs' }
if (-not (Test-Path (Join-Path $Target 'app\public\papercut\version.json'))) { $problems += '缺立绘素材' }
if (Test-Path (Join-Path $Target 'app\node_modules\@deepseek-ai\dsh')) {
  $it = Get-Item (Join-Path $Target 'app\node_modules\@deepseek-ai\dsh')
  if ($it.LinkType) { $problems += "app\node_modules 里还有 junction（$($it.LinkType)）" }
}
# 个人数据一个都不该带出去
foreach ($p in @('state\companion.db','state\companion.env','state\sessions','dsh-home\.credentials.yaml')) {
  if (Test-Path (Join-Path $Target $p)) { $problems += "不该包含个人数据：$p" }
}
$depCount = 0
if (Test-Path (Join-Path $Target 'app\node_modules')) {
  $depCount = (Get-ChildItem (Join-Path $Target 'app\node_modules') -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
}
Write-Host ("  node_modules 顶层目录数：{0}" -f $depCount)
if ($problems.Count -gt 0) {
  Write-Host "  ❌ 自检未过：" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "     - $_" -ForegroundColor Red }
  exit 1
}
Write-Host "  ✅ 结构自检通过（无 junction、无个人数据）" -ForegroundColor Green

Write-Host "== 压缩成一个文件 =="
$zip = Join-Path $Dist 'companion-agent-win-x64.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
& tar -a -cf $zip -C $Dist 'companion-agent-win-x64'
if ($LASTEXITCODE -ne 0) { throw "压缩失败（exit=$LASTEXITCODE）" }

$dirMb = [math]::Round(((Get-ChildItem -LiteralPath $Target -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
$zipMb = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "  解压后：$dirMb MB"
Write-Host "  一个文件：$zip  ($zipMb MB)" -ForegroundColor Green
Write-Host ""
Write-Host "  下一步（冒烟测试，需临时停掉本机主实例）：" -ForegroundColor Yellow
Write-Host "    1) .\start-companion.ps1 -Stop"
Write-Host "    2) 解压 zip 到临时目录，双击 启动.cmd，看 http://127.0.0.1:4180 是否正常"
Write-Host "    3) 测完关掉它，再 .\start-companion.ps1 -Detach 把主实例起回来"

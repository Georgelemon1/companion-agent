# 打"便携版 · macOS"：一个 .tar.gz，对方解压后双击 启动.command 就能用
#
# ⚠️ 本脚本在 **Windows 上交叉构建** macOS 包。因此必须清醒：
#    这个包**没法在本机跑冒烟测试**（Windows 跑不了 Mach-O）。能离线核验的都核验了：
#      · node 二进制来自 nodejs.org 官方 tar，magic/cputype 验过是真 arm64 Mach-O
#      · 依赖用 `npm install --os=darwin --cpu=<arch>` 按 macOS 解析（含 darwin 专用可选依赖）
#      · 启动脚本用 bash -n 过语法
#    剩下"能不能起来、能不能回话"只能由 Mac 用户实测 —— 报告里要如实说明。
#
# 为什么是 .tar.gz 而不是 zip：macOS 上 `启动.command` 必须有 Unix 执行位才能双击，
# 而 Windows 打的 zip/tar 一律是 0644。本脚本在压缩后**改写 tar 头里的 mode 字段为 0755**
# （deploy/fix-tar-mode.mjs），所以解压出来就是可执行的。
#
# 用法: pwsh -File deploy\make-portable-mac.ps1 [-Arch arm64|x64] [-SkipInstall]
param(
  [ValidateSet('arm64', 'x64')][string]$Arch = 'arm64',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Dist = Join-Path $Root 'dist'
$Target = Join-Path $Dist "companion-agent-mac-$Arch"
$Work = Join-Path $Dist '_mac-build'
$NodeVersion = 'v24.13.0'          # 与 Windows 便携版同版本
$NodeTgz = Join-Path $Work "node-v24.13.0-darwin-$Arch.tar.gz"

New-Item -ItemType Directory -Force -Path $Work | Out-Null
New-Item -ItemType Directory -Force -Path $Dist | Out-Null

Write-Host "== 清理旧产物（$Target）=="
if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Target | Out-Null

Write-Host "== 取 macOS 版 node（官方 tar）=="
if (-not (Test-Path -LiteralPath $NodeTgz)) {
  $url = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-darwin-$Arch.tar.gz"
  Write-Host "  下载 $url"
  $url | ForEach-Object {
    node -e "const fs=require('node:fs');(async()=>{const r=await fetch(process.argv[1]);if(!r.ok){console.error('HTTP '+r.status);process.exit(1)}fs.writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))})()" $_ $NodeTgz
  }
  if ($LASTEXITCODE -ne 0) { throw "下载 node 失败" }
}
& tar -xzf $NodeTgz -C $Work "node-$NodeVersion-darwin-$Arch/bin/node"
$srcNode = Join-Path $Work "node-$NodeVersion-darwin-$Arch\bin\node"
if (-not (Test-Path -LiteralPath $srcNode)) { throw "没解出 bin/node" }

# 验二进制架构：Mach-O 64 位小端 magic = CFFAEDFE；cputype arm64 = 0x0100000C / x86_64 = 0x01000007
$b = [System.IO.File]::ReadAllBytes($srcNode)[0..7]
$magic = ($b[0..3] | ForEach-Object { $_.ToString('X2') }) -join ''
$cpu = [BitConverter]::ToUInt32($b, 4)
$wantCpu = if ($Arch -eq 'arm64') { 0x0100000C } else { 0x01000007 }
if ($magic -ne 'CFFAEDFE' -or $cpu -ne $wantCpu) { throw "node 二进制不是预期的 Mach-O $Arch（magic=$magic cpu=0x$($cpu.ToString('X8'))）" }
Copy-Item -LiteralPath $srcNode -Destination (Join-Path $Target 'node') -Force
Write-Host ("  ✅ node: Mach-O {0}，{1:N1} MB" -f $Arch, ((Get-Item $srcNode).Length / 1MB))

Write-Host "== 复制应用代码（排除 node_modules 与 npm junction）=="
& robocopy (Join-Path $Root 'app') (Join-Path $Target 'app') /E /XD node_modules npm /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（exit=$LASTEXITCODE）" }
Copy-Item -Path (Join-Path $PSScriptRoot 'portable-mac\*') -Destination $Target -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'phone-package.json') -Destination (Join-Path $Target 'app\package.json') -Force
Remove-Item -Path (Join-Path $Target 'app\*.ps1') -Force -ErrorAction SilentlyContinue

if (-not $SkipInstall) {
  Write-Host "== 按 macOS 解析依赖（--os=darwin --cpu=$Arch，--ignore-scripts 免原生编译）=="
  # --prefer-offline：能用缓存就用缓存（arm64 那份已把大部分包拉进本地缓存了）
  # --fetch-timeout/--fetch-retries：实测踩过一次 npm 卡 30 分钟不动（网络挂住），
  #   把超时与重试压小，卡住时宁可快点失败重来，也别让整条流水线僵在那儿。
  Push-Location (Join-Path $Target 'app')
  try {
    & npm install --os=darwin --cpu=$Arch --ignore-scripts --no-audit --no-fund --loglevel=error `
      --prefer-offline --fetch-timeout=120000 --fetch-retries=2
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败（exit=$LASTEXITCODE）" }
  } finally { Pop-Location }
}

Write-Host "== 瘦身（同 Windows 版：删掉已 disabled 插件所带的包）=="
$unused = @(
  '@img', 'sharp', 'node-pty', '@opentelemetry',
  '@google', '@anthropic-ai', '@mistralai', '@aws-sdk', '@aws-crypto',
  '@huggingface', '@xenova', 'openai', 'web-streams-polyfill',
  'onnxruntime-node', 'onnxruntime-common', 'onnx-proto',
  '@vscode/ripgrep-win32-x64', '@koromix/koffi-win32-x64', '@deepseek-ai/dsh-win32-process'
)
$nm = Join-Path $Target 'app\node_modules'
$freed = 0; $removed = @()
foreach ($u in $unused) {
  $p = Join-Path $nm $u
  if (Test-Path -LiteralPath $p) {
    $freed += ((Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB
    Remove-Item -LiteralPath $p -Recurse -Force
    $removed += $u
  }
}
Write-Host ("  删除 {0} 项，释放 {1:N1} MB" -f $removed.Count, $freed)

Write-Host "== 平台残留自检（不该有 Windows 二进制）=="
$winLeft = Get-ChildItem (Join-Path $Target 'app\node_modules') -Recurse -File -Filter *.exe -ErrorAction SilentlyContinue
Write-Host ("  .exe 残留：{0} 个" -f @($winLeft).Count)
$winPkgs = Get-ChildItem (Join-Path $Target 'app\node_modules') -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'win32' }
Write-Host ("  win32 专用包：{0} 个{1}" -f @($winPkgs).Count, $(if (@($winPkgs).Count -gt 0) { ' → ' + (($winPkgs | ForEach-Object { $_.Name }) -join ', ') } else { '' }))

Write-Host "== 写使用说明 =="
$readme = @"
companion-agent 便携版 —— 使用说明（macOS / $Arch）
==================================================

一、怎么用
  1. 解压后把文件夹放到任意位置（建议 ～/Applications 或桌面）
  2. 打开「终端」，cd 进这个文件夹，执行一次：
         chmod +x node 启动.command
     （压缩包里已把 启动.command 标成可执行，但有些解压工具会丢掉权限位；
       不想 chmod 也行，直接  bash 启动.command  ）
  3. 双击 启动.command（若提示"无法验证开发者"：右键 → 打开 → 仍要打开）
  4. 第一次会请你粘贴自己的 DeepSeek API key（申请：https://platform.deepseek.com/ ）
     —— 每个人用自己的 key；key 只存在本目录 state/companion.env 里
  5. 浏览器会自动打开 http://127.0.0.1:4180 ，她就站在那儿了
  6. 停止：终端窗口里按 Ctrl+C

二、首次打开被系统拦住怎么办（macOS 的正常行为）
  未签名的脚本第一次运行会被 Gatekeeper 拦。
  办法 A：右键点 启动.command → 选「打开」→ 在弹窗里再点「打开」
  办法 B：终端里执行一次，去掉下载隔离标记：
         xattr -dr com.apple.quarantine .

三、她是什么
  一个住在你电脑里的陪伴型 AI：有立绘（序列帧动画，会眨眼、会张嘴说话）、
  有情绪与关系状态、会记住你说过的事，也会偶尔主动找你说话。
  数据全在本目录里（state/ 与 dsh-home/）。

四、常见问题
  · 提示端口被占用 → 已经有一个实例在跑，先关掉那个终端窗口
  · 换 key → 编辑 state/companion.env 里 DEEPSEEK_API_KEY= 那一行，然后重启
  · 想换形象 → 需要重做素材（app/public/papercut/），换素材后要重新量背景色

五、包内容
  自带 node（Mach-O $Arch + 依赖树），所以解压后约 160 MB 左右。
  无需安装 Node、无需 npm install。
"@
$readme | Set-Content -LiteralPath (Join-Path $Target '使用说明.txt') -Encoding UTF8

Write-Host "== 清掉本地状态（分发包不带个人数据）=="
foreach ($p in @('state', 'dsh-home')) {
  $full = Join-Path $Target $p
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force; Write-Host "  已删 $p\" }
}

Write-Host "== 打包（tar → 改写权限位 → gzip）=="
$tarPlain = Join-Path $Dist "companion-agent-mac-$Arch.tar"
$targz = Join-Path $Dist "companion-agent-mac-$Arch.tar.gz"
if (Test-Path $tarPlain) { Remove-Item $tarPlain -Force }
if (Test-Path $targz) { Remove-Item $targz -Force }
& tar -cf $tarPlain -C $Dist "companion-agent-mac-$Arch"
if ($LASTEXITCODE -ne 0) { throw "tar 失败（exit=$LASTEXITCODE）" }
& node (Join-Path $PSScriptRoot 'fix-tar-mode.mjs') $tarPlain $targz '启动.command' 'node'
if ($LASTEXITCODE -ne 0) { throw "改写权限位失败（exit=$LASTEXITCODE）" }
Remove-Item $tarPlain -Force

$dirMb = [math]::Round(((Get-ChildItem $Target -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
$gzMb = [math]::Round((Get-Item $targz).Length / 1MB, 1)
Write-Host ""
Write-Host "  解压后：$dirMb MB"
Write-Host "  一个文件：$targz  ($gzMb MB)" -ForegroundColor Green
Write-Host ""
Write-Host "  ⚠️ 本机无法运行 macOS 二进制 —— 这个包只做了离线核验，" -ForegroundColor Yellow
Write-Host "     真机能否启动/回话需要 Mac 用户实测。" -ForegroundColor Yellow

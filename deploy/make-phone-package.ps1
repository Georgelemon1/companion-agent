# 打"手机端部署包"：只带运行需要的东西，并自检结果
#
# 为什么要有脚本而不是手敲 tar（两处实测踩过的坑）：
#   ① `--exclude "app/node_modules"` 在 bsdtar 下**不生效**（打出来 136 MB），
#      必须写成 `*/node_modules` 才真的排除。
#   ② `app/npm/@deepseek-ai` 是指向本机 DSH 安装的 **junction**。
#      `Get-ChildItem -Recurse` 不跟 junction（所以看着 0 MB），但 **tar 会跟进去**，
#      把 7505 个包条目拖进包里 —— 这也是那 136 MB 的主因。
#
# 用法: pwsh -File deploy\make-phone-package.ps1
param([string]$Out = "companion-phone.tgz")

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root
$outPath = Join-Path $Root $Out
if (Test-Path $outPath) { Remove-Item $outPath -Force }

Write-Host "打包中（排除 node_modules / npm junction / 素材母本 / 截图日志）…"

# ── 先给记忆库做在线快照 ────────────────────────────────────────────────────
# 为什么不直接打包 state/companion.db：应用在跑，Windows 下 SQLite 文件被占用，
# tar 会报 `Couldn't open state/companion.db: Permission denied`（实测）。
# 也不该为了打包就把她的服务停掉。用 SQLite 的在线备份 `VACUUM INTO` 生成一份
# **一致**的副本（含 WAL 里尚未并回的事务），应用全程无感。
# 副本落成 state/companion.db.snap，手机端首次安装时由 termux-install.sh 改名为 companion.db。
$snap = Join-Path $Root 'state\companion.db.snap'
$dbPath = Join-Path $Root 'state\companion.db'
if (Test-Path $snap) { Remove-Item $snap -Force }
if (Test-Path $dbPath) {
  $snapFwd = $snap -replace '\\', '/'
  $vm = "import { DatabaseSync } from 'node:sqlite';" +
        "const db = new DatabaseSync(String.raw``$dbPath``, { readOnly: true });" +
        "db.exec(``VACUUM INTO '$snapFwd'``);db.close();console.log('snapshot ok');"
  $vm | node --input-type=module -
  if ($LASTEXITCODE -ne 0) { throw "记忆库快照失败（exit=$LASTEXITCODE）" }
  Write-Host ("  记忆库快照：{0:N0} KB" -f ((Get-Item $snap).Length / 1KB))
}

& tar -czf $outPath `
  --exclude '*/node_modules' `
  --exclude 'app/npm' `
  --exclude 'assets' `
  --exclude 'docs-legacy' `
  --exclude 'state/*.png' `
  --exclude 'state/*.log' `
  --exclude 'state/companion.db' `
  --exclude 'state/companion.db-wal' `
  --exclude 'state/companion.db-shm' `
  --exclude '*.tgz' `
  app state deploy start-companion.ps1 status-companion.ps1 run-companion.ps1 *.md
$tarCode = $LASTEXITCODE
if (Test-Path $snap) { Remove-Item $snap -Force }   # 快照只为打包而生，不留痕
if ($tarCode -ne 0) { throw "tar 失败（exit=$tarCode）" }

$mb = [math]::Round((Get-Item $outPath).Length / 1MB, 1)
$entries = & tar -tzf $outPath
$nm = ($entries | Select-String 'node_modules' | Measure-Object).Count
$npm = ($entries | Select-String '^app/npm/' | Measure-Object).Count

Write-Host ""
Write-Host "包：$outPath  ($mb MB)"
Write-Host "自检："
Write-Host ("  node_modules 条目  {0}  {1}" -f $nm, $(if ($nm -eq 0) { '✅' } else { '❌ 不该有' }))
Write-Host ("  app/npm 条目       {0}  {1}" -f $npm, $(if ($npm -eq 0) { '✅' } else { '❌ 不该有' }))

# 关键文件必须在（少一个手机上就跑不起来）
$must = @(
  'app/launcher.mjs',
  'app/package.json',
  'app/cordis.yml',
  'app/cordis.patch.yml',
  'app/public/index.html',
  'app/public/papercut/version.json',
  'app/companion/index.js',
  'deploy/termux-install.sh',
  'deploy/termux-start.sh',
  'deploy/phone-package.json',
  # 会话落盘的 flock 降级（Android 上原生 flock 装不了，见 README-手机.md）
  'deploy/flock-shim.mjs',        # module hook 入口（--import 挂它）
  'deploy/flock-shim-stub.cjs',   # 立即成功的空实现（ESM/CJS 两条路都指向它）
  'deploy/flock-probe-flock.mjs', # 启动脚本用它探测原生 flock 是否可用
  'state/companion.db.snap'   # 记忆库的在线快照（应用在跑时只能这样带走）
)
$missing = @()
foreach ($m in $must) {
  $ok = $entries -contains $m
  if (-not $ok) { $missing += $m }
  Write-Host ("  {0,-42} {1}" -f $m, $(if ($ok) { '✅' } else { '❌ 缺失' }))
}

if ($nm -gt 0 -or $npm -gt 0 -or $missing.Count -gt 0) {
  Write-Host "`n❌ 自检未通过，别拿这个包去手机。" -ForegroundColor Red
  exit 1
}
if ($mb -gt 40) {
  Write-Host "`n⚠️  包偏大（$mb MB）：检查是否又有目录被 junction 带进来了。" -ForegroundColor Yellow
}
Write-Host "`n✅ 可以拷到手机了（见 deploy/README-手机.md）" -ForegroundColor Green

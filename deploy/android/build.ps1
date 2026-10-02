# companion-agent → Android APK 一键构建（Windows + WSL1，全程不需要管理员、不装 Android Studio）
#
# 五步：
#   1  下载依赖（便携 JDK / Android build-tools / platform / ubuntu-base / 官方 Node）
#   2  在 WSL 里组装 guest 运行时 rootfs（ubuntu-base + node + 应用依赖，按 linux-arm64 解析）
#   3  在 WSL 里打成载荷 payload.zip + payload.manifest
#   4  在 Windows 上出 APK（aapt2 + javac + d8 + 自写 zip 打包 + apksigner）
#   5  静态校验产物
#
# 为什么 rootfs 必须在 WSL 里组装：要保留 unix 权限位与**符号链接**（Ubuntu 24.04 是 usrmerge，
# /bin 本身就是软链）。Windows 的 NTFS 上建不了这些链接，硬解会得到一个跑不起来的 rootfs。
# WSL1 可以（实测 Ubuntu-24.04-w1，node v24.13.0、python3 3.12）。
param(
  [string]$AppVersion = '1.0.0',
  [string]$EmbedCredentials = '',
  [string]$JdkZip = '',
  [switch]$SkipDownload,
  [switch]$SkipRootfs,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Root = Split-Path (Split-Path $Here -Parent) -Parent

$Dl    = if ($env:DL_DIR)    { $env:DL_DIR }    else { 'E:\android-build\dl' }
$Work  = if ($env:BUILD_DIR) { $env:BUILD_DIR } else { 'E:\android-build\work' }
$Tools = if ($env:APK_TOOLS) { $env:APK_TOOLS } else { 'E:\android-build\tools' }
$env:APK_WORK = Join-Path (Split-Path $Work -Parent) 'work-apk'
$env:DL_DIR = $Dl
$env:BUILD_DIR = $Work

function To-Wsl([string]$p) {
  # E:\a\b → /mnt/e/a/b
  $full = [System.IO.Path]::GetFullPath($p)
  $drive = $full.Substring(0, 1).ToLower()
  return '/mnt/' + $drive + ($full.Substring(2) -replace '\\', '/')
}

Write-Host '== 0/5 环境检查 =='
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw '需要 WSL（本构建的 rootfs 组装必须在 Linux 文件系统语义下做）' }
$wslList = (wsl.exe -l -q 2>&1 | Where-Object { $_ -match '\S' })
if (-not $wslList) { throw 'WSL 里没有已安装的发行版' }
$distro = ($wslList | Select-Object -First 1).Trim()
Write-Host "   WSL 发行版: $distro"
wsl.exe -u root -- bash -lc 'node -v; python3 -V; tar --version | head -1' | ForEach-Object { Write-Host "   $_" }
$SrcWsl = To-Wsl $Root
$WorkWsl = To-Wsl $Work
$DlWsl = To-Wsl $Dl
Write-Host "   源码 $SrcWsl"
Write-Host "   工作 $WorkWsl"

if (-not $SkipDownload) {
  Write-Host '== 1/5 下载依赖 =='
  & node (Join-Path $Here '01-download-deps.mjs')
  if ($LASTEXITCODE -ne 0) { throw '依赖下载失败' }
} else {
  Write-Host '== 1/5 跳过下载 =='
}

if (-not $SkipRootfs) {
  Write-Host '== 2/5 组装 guest rootfs（WSL） =='
  # 用 env 传参：路径里有空格（"deepseek harness workspace1"），经 argv 走比拼 shell 字符串安全
  & wsl.exe -u root -- env "SRC=$SrcWsl" "BUILD=$WorkWsl" "DL=$DlWsl" `
      bash "$SrcWsl/deploy/android/02-prepare-rootfs.sh"
  if ($LASTEXITCODE -ne 0) { throw "rootfs 组装失败 ($LASTEXITCODE)" }

  Write-Host '== 3/5 打载荷（WSL） =='
  & wsl.exe -u root -- env "BUILD=$WorkWsl" `
      python3 "$SrcWsl/deploy/android/03-pack-payload.py"
  if ($LASTEXITCODE -ne 0) { throw "载荷打包失败 ($LASTEXITCODE)" }

  # WSL 写出来的文件属主是 root；后面 Windows 侧要读它，别让权限位挡住
  & wsl.exe -u root -- chmod -R a+rX "$WorkWsl/payload" "$WorkWsl/rootfs"
} else {
  Write-Host '== 2、3/5 跳过 rootfs / 载荷 =='
}

Write-Host '== 4/5 出 APK =='
$apkArgs = @('-File', (Join-Path $Here '04-build-apk.ps1'), '-AppVersion', $AppVersion)
if ($EmbedCredentials) { $apkArgs += @('-EmbedCredentials', $EmbedCredentials) }
& pwsh @apkArgs
if ($LASTEXITCODE -ne 0) { throw "APK 构建失败 ($LASTEXITCODE)" }

$apk = Join-Path $Root "dist\android\companion-agent.apk"
if (-not $SkipVerify) {
  Write-Host '== 5/5 静态校验 =='
  & node (Join-Path $Here '05-verify-apk.mjs') $apk $env:APK_WORK
  if ($LASTEXITCODE -ne 0) { throw '静态校验未通过' }

  Write-Host ''
  Write-Host '== aapt2 dump badging（第三方工具交叉验证） =='
  $aapt2 = Join-Path $Tools 'build-tools\aapt2.exe'
  if (Test-Path $aapt2) { & $aapt2 dump badging $apk | Select-Object -First 12 }
  Write-Host ''
  Write-Host '== apksigner verify（签名） =='
  $apksignerJar = Join-Path $Tools 'build-tools\lib\apksigner.jar'
  $java = Join-Path $Tools 'jdk\bin\java.exe'
  if ((Test-Path $apksignerJar) -and (Test-Path $java)) {
    & $java -jar $apksignerJar verify --verbose --print-certs $apk
  }
}

Write-Host ''
Write-Host "✅ 产物：$apk  ($([math]::Round((Get-Item $apk).Length / 1MB, 1)) MB)"
Write-Host '   安装与限制见 deploy/android/README-安卓APK.md'

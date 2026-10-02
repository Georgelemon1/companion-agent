# 步骤 4/5：出 APK（Windows 侧；不依赖 Android Studio / Gradle，不需要管理员）。
#
# 流水线（路线照 dsh-android 验证过的走，代码为自写实现）：
#   aapt2 compile  →  aapt2 link(生成 R.java)  →  javac  →  d8(=classes.dex)
#   →  自写 zip 打包（resources.arsc 强制 STORED+4 对齐、.so 页对齐）
#   →  keytool 生成密钥  →  apksigner 只签 v2+v3（签 v1 会重写 zip、把对齐搞坏）
#
# 工具从哪来（全部由 01-download-deps.mjs 下到 $Dl，本脚本就地解压，系统里不装任何东西）：
#   JDK 17        cdn.azul.com 绿色版 zip。**注意**：Adoptium 的 binary 端点会 302 到 github.com，
#                 而本机 github.com 超时，所以默认走 Azul 的 CDN 直链。
#   build-tools   dl.google.com/android/repository/build-tools_r34-windows.zip
#                 → aapt2.exe / lib\d8.jar / lib\apksigner.jar / zipalign.exe
#   android.jar   dl.google.com/android/repository/platform-28_r06.zip
#                 用 platform-28 而不是更新的版本：运行时 targetSdk 就是 28，编译面与运行面一致。
param(
  [string]$Slug = 'companion-agent',
  [string]$AppVersion = '1.0.0',
  [string]$OutDir = '',
  # 可选：把一份凭据内嵌进 assets/seed/companion.env（首次启动释放到 guest 的 HOME；
  # 不内嵌也能用 —— 应用首启界面上可以直接填）
  [string]$EmbedCredentials = ''
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Root = Split-Path (Split-Path $Here -Parent) -Parent      # projects\companion-agent
if (-not $OutDir) { $OutDir = Join-Path $Root 'dist\android' }

$Dl    = if ($env:DL_DIR)    { $env:DL_DIR }    else { 'E:\android-build\dl' }
$Work  = if ($env:APK_WORK)  { $env:APK_WORK }  else { 'E:\android-build\work-apk' }
# 载荷（rootfs 的打包产物）由 02/03 步写在 BUILD_DIR 下，与 APK 中间产物分开放
$Build = if ($env:BUILD_DIR) { $env:BUILD_DIR } else { 'E:\android-build\work' }
$Tools = if ($env:APK_TOOLS) { $env:APK_TOOLS } else { 'E:\android-build\tools' }

Write-Host '== 4.0 准备便携工具链（免安装、不写注册表） =='
$JdkHome = Join-Path $Tools 'jdk'
$BuildTools = Join-Path $Tools 'build-tools'
$AndroidJar = Join-Path $Tools 'android-28\android.jar'
New-Item -ItemType Directory -Force -Path $Tools, $Work, $OutDir | Out-Null

function Expand-Inner([string]$zip, [string]$dest) {
  # 这些归档里都套了一层同名目录，解出来只留里层
  $tmp = Join-Path $Tools ('raw-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item $inner.FullName $dest
  Remove-Item -Recurse -Force $tmp
}

if (-not (Test-Path (Join-Path $JdkHome 'bin\javac.exe'))) {
  Write-Host '   解压 JDK…'
  Expand-Inner (Join-Path $Dl 'jdk17.zip') $JdkHome
}
$Java = Join-Path $JdkHome 'bin\java.exe'
$Javac = Join-Path $JdkHome 'bin\javac.exe'
$Keytool = Join-Path $JdkHome 'bin\keytool.exe'
Write-Host ("   JDK: " + ((& $Java -version 2>&1 | Select-Object -First 1) -join ''))

if (-not (Test-Path (Join-Path $BuildTools 'aapt2.exe'))) {
  Write-Host '   解压 build-tools…'
  Expand-Inner (Join-Path $Dl 'build-tools_r34-windows.zip') $BuildTools
}
$Aapt2 = Join-Path $BuildTools 'aapt2.exe'
$D8Jar = Join-Path $BuildTools 'lib\d8.jar'
$ApksignerJar = Join-Path $BuildTools 'lib\apksigner.jar'
$Zipalign = Join-Path $BuildTools 'zipalign.exe'
foreach ($t in @($Aapt2, $D8Jar, $ApksignerJar, $Zipalign)) {
  if (-not (Test-Path $t)) { throw "工具缺失：$t" }
}

if (-not (Test-Path $AndroidJar)) {
  Write-Host '   解压 platform-28（android.jar）…'
  $tmp = Join-Path $Tools ('plat-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  Expand-Archive -Path (Join-Path $Dl 'platform-28_r06.zip') -DestinationPath $tmp -Force
  $jar = Get-ChildItem $tmp -Recurse -Filter 'android.jar' | Select-Object -First 1
  if (-not $jar) { throw 'platform-28 里找不到 android.jar' }
  New-Item -ItemType Directory -Force -Path (Split-Path $AndroidJar -Parent) | Out-Null
  Copy-Item $jar.FullName $AndroidJar -Force
  Remove-Item -Recurse -Force $tmp
}

Write-Host '== 4.1 生成图标 =='
# 有参考图（icon-source.png）就用**真实插画**生成图标：脚本在 app/ 下，
# 因为 Node 的裸模块名解析按脚本所在目录走，它要用 sharp（只有 app/node_modules 里有）。
# 没有参考图时才退回手写生成器 make-icons.mjs（逐像素画渐变+心形的占位图）。
$iconSrc = Join-Path $Here 'icon-source.png'
if (Test-Path $iconSrc) {
  Write-Host '   源图: icon-source.png（真实插画）'
  & node (Join-Path $Here '..\..\app\make-android-icons.mjs')
} else {
  Write-Host '   没有 icon-source.png，用占位图标生成器'
  & node (Join-Path $Here 'make-icons.mjs') (Join-Path $Here 'apk')
}
if ($LASTEXITCODE -ne 0) { throw '图标生成失败' }

Write-Host '== 4.2 aapt2 compile（资源） =='
$resZip = Join-Path $Work 'res.zip'
if (Test-Path $resZip) { Remove-Item $resZip -Force }
& $Aapt2 compile --dir (Join-Path $Here 'apk\res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败 ($LASTEXITCODE)" }

Write-Host '== 4.3 aapt2 link（清单 + 资源表 + R.java） =='
$baseApk = Join-Path $Work 'base.apk'
$genDir = Join-Path $Work 'gen'
if (Test-Path $baseApk) { Remove-Item $baseApk -Force }
if (Test-Path $genDir) { Remove-Item -Recurse -Force $genDir }
New-Item -ItemType Directory -Force -Path $genDir | Out-Null
$code = 0
foreach ($part in $AppVersion.Split('.')[0..2]) { $code = $code * 100 + [int]$part }
& $Aapt2 link `
  -I $AndroidJar `
  --manifest (Join-Path $Here 'apk\AndroidManifest.xml') `
  --min-sdk-version 26 --target-sdk-version 28 `
  --version-code $code --version-name $AppVersion `
  --java $genDir `
  -o $baseApk `
  $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败 ($LASTEXITCODE)" }

Write-Host '== 4.4 生成 BuildInfo.java（载荷内容哈希当版本戳） =='
$payloadZip = Join-Path $Build 'payload\payload.zip'
$payloadManifest = Join-Path $Build 'payload\payload.manifest'
foreach ($f in @($payloadZip, $payloadManifest)) {
  if (-not (Test-Path $f)) { throw "缺少载荷 $f（先跑 02、03 步）" }
}
$genSrc = Join-Path $Work 'gen-src'
if (Test-Path $genSrc) { Remove-Item -Recurse -Force $genSrc }
& node (Join-Path $Here 'lib\gen-buildinfo.mjs') $payloadZip $genSrc $AppVersion
if ($LASTEXITCODE -ne 0) { throw 'BuildInfo 生成失败' }

Write-Host '== 4.5 javac =='
$classes = Join-Path $Work 'classes'
if (Test-Path $classes) { Remove-Item -Recurse -Force $classes }
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$sources = @()
$sources += Get-ChildItem (Join-Path $Here 'apk\java') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName }
$sources += Get-ChildItem $genDir -Recurse -Filter '*.java' | ForEach-Object { $_.FullName }
$sources += Get-ChildItem $genSrc -Recurse -Filter '*.java' | ForEach-Object { $_.FullName }
$sources = $sources | Sort-Object -Unique
Write-Host ("   " + $sources.Count + ' 个源文件')
# -source/-target 8：Android 的 dex 只需要 Java 8 字节码。
# -bootclasspath 指向 android.jar 是"对 Android 编译"的正统做法（避免误用 JDK 自带类）；
# 个别 JDK 版本不接受 -bootclasspath 与 -source 8 组合，所以留一条不带它的退路。
# -source/-target 8：Android 的 dex 只需要 Java 8 字节码。
# 用 -classpath android.jar（而不是 -bootclasspath）：实测 android.jar(API 28) 里的
# java.lang.invoke.LambdaMetafactory 是个空壳，一旦让它当引导类路径，javac 处理 lambda 时
# 会报"找不到符号 metafactory"。走 -classpath 时 java.* 来自 JDK、android.* 来自 android.jar，
# 这也是非 Gradle 编译 Android 的通行做法（代价：要自觉不用 Java 9+ 的 API）。
& $Javac -encoding UTF-8 -source 8 -target 8 -nowarn -classpath $AndroidJar -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw "javac 失败 ($LASTEXITCODE)" }
Write-Host ("   " + (Get-ChildItem $classes -Recurse -Filter '*.class').Count + ' 个 class')

Write-Host '== 4.6 d8 → classes.dex =='
$dexDir = Join-Path $Work 'dex'
if (Test-Path $dexDir) { Remove-Item -Recurse -Force $dexDir }
New-Item -ItemType Directory -Force -Path $dexDir | Out-Null
$classFiles = Get-ChildItem $classes -Recurse -Filter '*.class' | ForEach-Object { $_.FullName }
& $Java -cp $D8Jar com.android.tools.r8.D8 --release --min-api 26 --lib $AndroidJar --output $dexDir @classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 失败 ($LASTEXITCODE)" }
$dex = Join-Path $dexDir 'classes.dex'
if (-not (Test-Path $dex)) { throw 'd8 没有产出 classes.dex' }

Write-Host '== 4.7 打包（自写 zip：对齐是硬要求） =='
$libproot = Join-Path $Here 'precache\libproot.so'
$spec = [ordered]@{
  entries = @(
    [ordered]@{ name = 'classes.dex'; from = $dex }
    [ordered]@{ name = 'lib/arm64-v8a/libproot.so'; from = $libproot; store = $true; alignment = 4096 }
    [ordered]@{ name = 'assets/payload.zip'; from = $payloadZip; store = $true; alignment = 4 }
    [ordered]@{ name = 'assets/payload.manifest'; from = $payloadManifest }
  )
}
if ($EmbedCredentials) {
  if (-not (Test-Path $EmbedCredentials)) { throw "凭据文件不存在：$EmbedCredentials" }
  $seed = Join-Path $Work 'seed\companion.env'
  New-Item -ItemType Directory -Force -Path (Split-Path $seed -Parent) | Out-Null
  Copy-Item $EmbedCredentials $seed -Force
  $spec.entries += [ordered]@{ name = 'assets/seed/companion.env'; from = $seed }
  Write-Host '   已内嵌 assets/seed/companion.env'
}
$specPath = Join-Path $Work 'spec.json'
$spec | ConvertTo-Json -Depth 5 | Set-Content -Path $specPath -Encoding utf8NoBOM
$unsigned = Join-Path $Work 'unsigned.apk'
& node (Join-Path $Here 'lib\pack-apk.mjs') $baseApk $unsigned $specPath
if ($LASTEXITCODE -ne 0) { throw '打包失败' }

Write-Host '== 4.8 密钥（首次运行生成，之后复用） =='
$keystore = Join-Path $Here 'keystore\companion.p12'
$ksPass = 'companion'
$ksAlias = 'companion'
if (-not (Test-Path $keystore)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $keystore -Parent) | Out-Null
  & $Keytool -genkeypair -keystore $keystore -storetype PKCS12 `
    -storepass $ksPass -keypass $ksPass -alias $ksAlias `
    -keyalg RSA -keysize 2048 -validity 10000 `
    -dname 'CN=companion-agent, OU=self, O=self, L=, S=, C=CN' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'keytool 生成密钥失败' }
  Write-Host "   生成 $keystore（口令 $ksPass —— 这是应用身份，泄露=别人能签出系统认可的升级包）"
} else {
  Write-Host "   复用 $keystore"
}

Write-Host '== 4.9 apksigner（只签 v2+v3） =='
$outApk = Join-Path $OutDir "$Slug.apk"
if (Test-Path $outApk) { Remove-Item $outApk -Force }
& $Java -jar $ApksignerJar sign `
  --ks $keystore --ks-pass "pass:$ksPass" --key-pass "pass:$ksPass" --ks-key-alias $ksAlias `
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true `
  --out $outApk $unsigned
if ($LASTEXITCODE -ne 0) {
  Write-Host '   （-jar 不可用，改用主类）'
  & $Java -cp $ApksignerJar com.android.apksigner.ApkSignerTool sign `
    --ks $keystore --ks-pass "pass:$ksPass" --key-pass "pass:$ksPass" --ks-key-alias $ksAlias `
    --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true `
    --out $outApk $unsigned
  if ($LASTEXITCODE -ne 0) { throw "apksigner 失败 ($LASTEXITCODE)" }
}

Write-Host '== 4.10 签名后复验对齐 =='
$alignOut = & $Zipalign -c -p -v 4 $outApk 2>&1
$alignCode = $LASTEXITCODE
$alignOut | Where-Object { $_ -notmatch '\(OK\)' } | Select-Object -Last 8
if ($alignCode -ne 0) {
  Write-Host '   未对齐的条目：'
  $alignOut | Where-Object { $_ -notmatch '\(OK\)$' } | Select-Object -Last 15
  throw "zipalign -c 校验失败（对齐被破坏）($alignCode)"
}
Write-Host "   $($alignOut[-1])"
Write-Host ("   产物 " + $outApk + "  " + [math]::Round((Get-Item $outApk).Length / 1MB, 1) + ' MB')
Write-Host '== 4 完成 =='

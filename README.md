# Companion Agent

一个**拟人化的陪伴型智能体**：有立绘（序列帧动画，会眨眼、思考、说话时张嘴）、有情绪与关系状态、会记住你说过的事，
并且**她的一切设定都从真实对话里推断出来、实时更新**——不做"填表定制"。

跑起来是一个本机网页（`http://127.0.0.1:4180`），也可以打成**安卓 APK**：一个 App 自带整套运行时，
不需要 Termux、不需要 root、不需要浏览器外壳。

<p align="center">
  <img src="app/public/papercut/idle/1.jpg" width="240" alt="立绘（待机帧）">
</p>

## 它能做什么

| 能力 | 说明 |
|---|---|
| **序列帧立绘** | 待机 / 思考 / 说话三态 + 随机眨眼；眨眼频率按人类研究校准（约 19 次/分，成簇出现，单次固定 250ms） |
| **情绪与关系** | 每回合评估情绪与关系变化，落库；她的神态从表情和语气里读出来，不由 UI 汇报数字 |
| **记忆** | 从对话里抽取值得记住的事（人、事、偏好、约定），下次自然用上 |
| **主动性** | 会挑时机主动找你说话（有每日上限与静默时段） |
| **人设自我推断** | 15 个维度（称呼、语气、回复长度、主动性、禁忌、在意的事、相处偏好…）**从你说过的话里推断**，**用户的明确指令优先于模型推断**，改完下一回合即生效 |
| **语音输入** | 浏览器按住说话（识别结果只落进输入框，由你确认后再发） |

## 快速开始（电脑）

```bash
# 1) 依赖：Node 24+（应用用内置的 node:sqlite）
cd app && npm install --ignore-scripts && cd ..

# 2) 填你自己的 key
cp state/companion.env.example state/companion.env
#   编辑 state/companion.env，把 DEEPSEEK_API_KEY 改成你的（申请：https://platform.deepseek.com/）

# 3) 启动
node app/launcher.mjs          # 或者 Windows 上： .\start-companion.ps1 -Detach
```

然后浏览器打开 <http://127.0.0.1:4180>。

> Windows 用户：`start-companion.ps1` 会读 `state/companion.env` 并把它注入进程环境变量，
> 这样这个应用用一把**独立的 key**，不影响你机器上其它 DSH 会话（DSH 的凭据是分层的，环境变量优先）。

## 安卓 APK

```powershell
pwsh -File deploy\android\build.ps1                    # → dist/android/companion-agent.apk
pwsh -File deploy\android\build.ps1 -EmbedCredentials state\companion.env   # 把 key 内嵌进包（见下方安全须知）
```

APK 自带一套 **PRoot + Ubuntu(glibc) + 官方 Node 24 + 应用依赖**：启动时解包，用 PRoot 起后端，WebView 打开它自己的页面。
免 Gradle、免 Android Studio、免管理员（工具链在 `01-download-deps.mjs` 里自动下载）。
细节与"哪些没验证"见 [deploy/android/README-安卓APK.md](deploy/android/README-安卓APK.md)。

⚠️ **`-EmbedCredentials` 打出来的包内含你的 API key**——只适合自己用或私下分发；要公开发布请**不要**加这个参数，
让使用者在 App 内右上角 `⋯ → 填 API Key` 里填自己的。

## 架构

这个项目是 **DSH 的一个应用 profile**：`app/package.json` 声明 `dsh.profile.bundles`，`app/launcher.mjs` 用
`loadProfileDirectory` 把自己那套组合加载起来。应用自己的逻辑都在 `app/companion/` 下，作为 Cordis 插件挂在树上：

```
app/
  launcher.mjs            启动器：读 profile → 挂载 → 起 HTTP/WebSocket
  cordis.yml / cordis.patch.yml   组合与裁剪（这份 patch 关掉了 45 个用不到的插件）
  companion/
    index.js              前端通道：HTTP 静态 + /companion/ws，消息分段与节拍化输出
    affect.js             情绪、关系、人设推断的落库与现叠（核心状态机）
    infer.js              从对话推断人设：规则通道（同步）+ LLM 通道（异步节流）
    persona.js            人设段与硬规则 → 系统提示词
    memory.js             记忆抽取与召回
    clock.js              主动性：什么时候该开口
    guard-plugin.js       入站/出境安全护栏
    state.js              SQLite（node:sqlite）：记忆 / 情绪 / 关系 / 人设
  public/
    papercut-core.js      序列帧引擎（纯逻辑、时间注入，可单测）
    papercut.js           渲染层（rAF、帧替换、pixelated）
    app.js / style.css    聊天界面（无气泡、文字直接浮在立绘上）
deploy/
  android/                安卓 APK 的完整构建流水线
  portable/ portable-mac/ 免安装便携版（自带 node 运行时）
  termux-*.sh             另一种手机方案（Termux + 网页，本项目里已停放，留作参考）
```

## 几个值得说的设计取舍

- **眨眼不是随机闪烁**：按人类眨眼研究校准——频率约 12.5–20 次/分、间隔多数 0.5–2s、成簇出现在话语单元结束处、
  单次时长固定 250ms（用户要求"一次眨眼的时间保持不变"）。实现是"长恢复期 + 簇内短间隔"，
  并且**思考态所有间隔乘 1.7**（人越费脑子眨得越少）。依据与实测见 [眨眼设计依据.md](眨眼设计依据.md)。
- **人设从对话里长出来，而不是填表**：每条推断必须挂一句**你说过的原话**当证据；
  你的明确指令优先级最高，模型的推断不许覆盖它。改完下一回合立即生效（人设段每回合现读库、不缓存）。
- **立绘底色必须与素材同色**：素材是 9:16、按 `contain` 居中，比手机屏矮一截，上下会留出底色带——
  底色取素材边缘的实测值（当前批次是纯黑），换素材批次必须重新量，否则接缝看得出来。
- **会话落盘在有的平台需要绕**：会话持久化用 POSIX `flock`，而 Android 的 Bionic libc 没有对应预编译件，
  于是有"探针 + 按需降级为单进程空实现"的 shim（`deploy/flock-shim.mjs`）。
  安卓 APK 那条路自带 glibc Node，不需要它。

## 已知限制

- **音频是浏览器语音识别**（Web Speech API），不是本地模型；识别结果需要你确认后再发。
- 安卓版**息屏后会被系统冻结**（ColorOS 实测）：需要在系统设置里把应用设为"允许后台运行/不受限制"。
- 安卓 APK 的 `targetSdk` 刻意压到 28：只有 legacy SELinux 域才允许 execve 应用私有目录里的二进制（PRoot 要用）。
- 部分平台相关的验证仍在进行，`deploy/` 下的文档里逐条标注了"已实测 / 推断 / 未验证"。

## 第三方与许可

- 安卓部分的 Java 代码参考并改写了 [itiswdwa/dsh-android](https://github.com/itiswdwa/dsh-android)（MIT），声明见
  [deploy/android/THIRD_PARTY.md](deploy/android/THIRD_PARTY.md)。
- `deploy/android/precache/libproot.so` 是 [PRoot](https://proot-me.github.io/)（**GPL-2.0-or-later**）的 arm64 构建，
  作为独立可执行文件随 APK 分发。自用无额外义务；**若对外分发打包好的 APK，需同时提供 PRoot 的源码**。
- 本项目其余代码：见 [LICENSE](LICENSE)。

## 安全须知

- **仓库里不含任何 key**：`.gitignore` 排除了 `state/*`（凭据、记忆库、会话原文）与 `dist/`（构建产物）。
- `state/companion.env` 是**明文凭据**，别提交、别外传。
- 用 `-EmbedCredentials` 构建的 APK 内含 key，**不要公开发布**。

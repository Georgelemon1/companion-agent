// 只做一件事：把 process.platform 伪装成 'android'，用于本机复现手机端分支。
//
// 为什么单独一个文件：必须让伪装发生在**任何业务模块被求值之前**（--import 的
// 语义就是如此）。持久化层在模块初始化时就把 process.platform 抓进
// internals.platform（dsh-session-persistence-jsonl/lib/index.js:1616），
// 晚一步改就没意义了。
//
// 只在验证时使用，不进手机包、不参与正式启动。
Object.defineProperty(process, 'platform', { value: 'android', configurable: true })

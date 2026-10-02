// 测试用 ESM 加载钩子 —— 把 app.js 的两个 UI 依赖换成桩
//
// 为什么要这样：app.js 是 ES 模块，import 了 questionnaire.js 与 voice.js，
// 这两个都是浏览器 DOM 交互模块，在 Node 里跑不起来。但我们想测的是
// **真实的 app.js**（它的消息处理与气泡渲染逻辑），不能把逻辑抄一份到测试里。
// 所以只替换它的两个依赖，其余原样加载。
//
// 用法：node --import ./app/test-loader-hook.mjs app/test-frontend-bubbles.mjs

const STUBS = new Map([
  ['./questionnaire.js', {
    initPersonaForm: () => ({ handleMessage: () => false, open() {} }),
  }],
  ['./voice.js', {
    initVoiceInput: () => ({ setEnabled() {}, destroy() {} }),
  }],
])

export async function resolve(specifier, context, nextResolve) {
  const stubbed = STUBS.get(specifier)
  if (stubbed !== undefined && String(context.parentURL ?? '').includes('/public/app.js')) {
    // 指向一个同名占位文件（内容由下面的 load 钩子提供）
    return {
      url: `stub:${specifier}`,
      shortCircuit: true,
      format: 'module',
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('stub:')) {
    const spec = url.slice('stub:'.length)
    const stub = STUBS.get(spec)
    const source = Object.entries(stub)
      .map(([name, value]) => `export const ${name} = ${value.toString()}`)
      .join('\n')
    return { format: 'module', source, shortCircuit: true }
  }
  return nextLoad(url, context)
}

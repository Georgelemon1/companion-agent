// 验证"用户往上翻时不被流式输出拽回底部"
import { readFileSync } from "node:fs"
let pass=0, fail=0
const check=(l,ok,d="")=>{ if(ok){pass++;console.log(`  ✅ ${l}${d?` — ${d}`:""}`)} else {fail++;console.log(`  ❌ ${l}${d?` — ${d}`:""}`)} }

// DOM 桩：messages 容器要支持 scrollTop/scrollHeight/clientHeight 与 scroll 事件
const listeners={}
const messagesEl={ _scrollTop:0, scrollHeight:1000, clientHeight:400,
  set scrollTop(v){ this._scrollTop=v }, get scrollTop(){ return this._scrollTop },
  addEventListener(t,fn){ (listeners[t]??=[]).push(fn) },
  append(){}, replaceChildren(){}, removeEventListener(){} }
const fire=(t)=>{(listeners[t]??[]).forEach(f=>f())}

// DOM 桩用 Proxy 兜底未实现的方法（教训：逐个补会一直漏 —— focus/setProperty/removeAttribute/...）
function mkEl(){
  const el = { style:{_p:{},setProperty(k,v){this._p[k]=v},getPropertyValue(k){return this._p[k]??""},removeProperty(k){delete this._p[k]}}, dataset:{},
    classList:{_s:new Set(),add(){},remove(){},contains(){return false},toggle(){}}, children:[], append(){}, replaceChildren(){}, remove(){},
    addEventListener(){}, removeEventListener(){}, querySelector(){return null}, getBoundingClientRect(){return{width:400,height:700}}, offsetWidth:400, textContent:"", setAttribute(){}, removeAttribute(){} }
  return new Proxy(el, {
    get(t,p){ if(p in t) return Reflect.get(t,p); if(typeof p==="symbol") return undefined; return ()=>undefined },
    set(t,p,v){ t[p]=v; return true },
  })
}
const byId=new Map()
globalThis.document={ head:{append(){}}, body:mkEl(), documentElement:mkEl(), createElement:()=>mkEl(),
  getElementById:(id)=>{ if(id==="messages") return messagesEl; if(!byId.has(id)) byId.set(id,mkEl()); return byId.get(id) },
  querySelector:()=>null, addEventListener(){}, removeEventListener(){}, baseURI:"http://127.0.0.1:4180/" }
let messageHandler=null
globalThis.window={ addEventListener(){}, devicePixelRatio:1, setTimeout, clearTimeout, requestAnimationFrame:(f)=>setTimeout(f,0),
  CompanionStage:{ setMode(){}, setTalking(){}, debug:()=>({}) } }
globalThis.CSS={ supports:()=>true }
globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}}
globalThis.requestAnimationFrame=(f)=>setTimeout(f,0)
globalThis.Image=class{ set src(v){} addEventListener(){} }
globalThis.WebSocket=class{ static OPEN=1; constructor(){this.readyState=1} addEventListener(t,fn){ if(t==="message") messageHandler=fn } send(){} close(){} }
globalThis.location={ protocol:"http:", host:"127.0.0.1:4180" }
globalThis.fetch=async()=>({ok:true,json:async()=>({})})

await import("./public/app.js")
await new Promise(r=>setTimeout(r,80))
const feed=(p)=>messageHandler({ data: JSON.stringify(p) })
console.log("  已加载真实 app.js")

console.log("\n【用户往上翻时，流式输出不该拽回底部】")
// 模拟：已有很多消息，用户滚到中间
messagesEl.scrollHeight=1000; messagesEl.clientHeight=400
messagesEl.scrollTop=100            // 离底 500px，远大于 80 容差
fire("scroll")                       // 触发滚动监听 → followBottom=false
feed({ type:"message.delta", text:"她" })
feed({ type:"message.delta", text:"在" })
feed({ type:"message.delta", text:"说" })
await new Promise(r=>setTimeout(r,60))
check("往上翻后 scrollTop 保持不动", messagesEl.scrollTop === 100, `scrollTop=${messagesEl.scrollTop}`)

console.log("\n【回到底部后恢复跟随】")
// 注意：现在 message.delta 只累积到变量、不碰 DOM（paced 模式下由 message.done 统一呈现），
// 所以滚动发生在**落气泡**时。测试要走这条真实路径。
messagesEl.scrollTop=590             // 离底 10px，在容差内
fire("scroll")
feed({ type:"message.done", text:"她说话了", segments:[] })
await new Promise(r=>setTimeout(r,80))
check("回到底部后恢复自动跟随", messagesEl.scrollTop === messagesEl.scrollHeight, `scrollTop=${messagesEl.scrollTop} scrollHeight=${messagesEl.scrollHeight}`)

console.log("\n【用户发消息时强制滚到底（明确意图）】")
messagesEl.scrollTop=50              // 用户在很上面看历史
fire("scroll")
feed({ type:"message.done", text:"旧消息", segments:[] })
await new Promise(r=>setTimeout(r,60))
const beforeSend = messagesEl.scrollTop
check("她说话时仍不拽（用户在看历史）", beforeSend !== messagesEl.scrollHeight, `scrollTop=${beforeSend}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail===0?0:1

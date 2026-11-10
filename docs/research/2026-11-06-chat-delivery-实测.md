# 对话投递实测（2026-11-06）：本版没有 `conversation` 服务，`inputActions` 才是本体

> 这份文档**更正**了 `2026-11-04-chat-reference-api.md` 的结论。上一份是纯静态阅读得出的，
> 这一份有**运行时证据**（live client inspect）+ 逐行源码定位。
> 结论落地在 `lib/client.js` 的 `deliverInputText()` / `buildChatPrompt()`。

- 目标 DSH：0.2.1-rc.5（`E:\Users\asus\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`）
- 证据记号：`asar!<包内路径>:<行号>`

---

## 0. 一句话结论

0.2.1-rc.5 的客户端**没有 `conversation` 这个 client service**，所以
`ctx.get("conversation")` 恒为 `undefined` —— 上一版「走会话作用域 + `slash/input-insert-reference`」
的路线在本版**从来没有通过**（这就是用户看到的「投递失败：拿不到会话桥」）。
真正可用的是 **slot props 里的 `inputActions`**：`captureInsertion()` + `insertText(text, span)`。

```js
// 唯一实测可用的投递序列（cite() 里的 ①）
const span = props.inputActions.captureInsertion()      // {start, end, draftRev}
const ok = props.inputActions.insertText(text, span)    // true = 真的写进了 Lexical 编辑器
```

---

## 1. 运行时证据：service 目录里没有 `conversation`

`cordis_inspect_query`（client / Service / listService，打的是**正在跑的页面**）返回的目录只有：

```
layout · locale · sessions · slots · theme · timer · uiWorkspace · workspaces
```

单独查 `conversation` 直接回 `provider-error: no catalogued Service named "conversation"`。
而 `sessions` 明确写着「sessions-service face injected as `ctx.sessions`」，方法里有 `scope(id)`。

**推论**：任何以 `ctx.get("conversation")` 为前提的投递代码，在本版都是死路。

## 2. 门面（guard）让 `ctx.<service>` 直接抛错，只有 `ctx.get()` 是可选查找

`asar!dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:484-514`
（`dynamicCordisContext`）：

```js
const declared = new Set(Object.keys(ctx.fiber.inject))
const denyRead = (prop) => {
  if (ctx.get(prop) !== undefined) throw new Error(`service "${prop}" is not declared by your plugin. …`)
  throw new Error(`dynamic ctx does not expose "${prop}". …`)
}
get(_target, prop) {
  if (prop === "get") return (name) => readService(name, false)   // ← 不要求声明
  …
  return readService(prop, true)                                   // ← 属性访问要求 inject 声明
}
```

于是旧代码

```js
ctx.sessions.scope(sid)      // ← 未 inject "sessions" → 抛异常（还被记成一次插件失败）
```

被 `try/catch` 吃掉 → `actx = null` → 桥永远为 null。**改成 `ctx.get("sessions")` 即可**（本仓库已改）。

## 3. `props.inputActions` 就是 `SessionInputShell.actions`（有 `captureInsertion` / `insertText`）

供给链：`asar!dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:22777-22792`

```js
ctx.uiSession.provide({
  hooks: ["conversation", "input"],
  props: ["inputActions"],
  resolve: (binding) => {
    const shell = inputHub.shellFor(binding)
    return { hooks: {…}, props: { inputActions: shell.actions } }   // ← 逐字就是这个对象
  },
})
```

它公开的方法（同文件 `15366-15392`，`SessionInputShell.actions`）：

| 方法 | 语义 |
|---|---|
| `insertQuote(text)` | 插入引用块（仅 phase=plain 时） |
| `captureInsertion()` | 返回 `{...caretSpan(), draftRev}`；**光标不在编辑器里时就是草稿末尾**（`15092-15099`） |
| `insertText(text, span)` | `span.draftRev !== rev` → false；否则 `draftEditor.insertAsyncText(span, text)` → `$replaceDetectSpanWithText`（`15119-15125`）。**插入**，不是整体替换 |
| `setDraft(text)` | 整体替换草稿（会吃掉用户已经打的字） |
| `persistDraft()` / `addAttachments` / `removeAttachment` / `pruneAttachments` / `submit` | 与投递无关 |

要点：`insertText` 传的是**纯文本**（会先剥掉参考占位符 `REFERENCE_PLACEHOLDER_RE`），
所以多行代码围栏插进去是普通字符，不会被当成语法解析。

## 4. 为什么这一轮**不**上「文件芯片」

芯片通道确实存在：会话作用域里有监听器
（`…/client.js:16197-16202`）

```js
actx.on("slash/input-insert-reference", (req) => shell.insertReference(req.reference, req.span) ? true : undefined)
actx.on("slash/input-insert-text", (req) => shell.insertText(req.text, req.span, req.continue === true) ? true : undefined)
```

但两个现实问题：

1. `ctx.get("sessions").scope(sid)` 返回的是会话 `AgentContext`；它如果 `instanceof Context`，
   会被门面的 `denyContext()` 直接拒绝（`runner.js:382-385`）—— 静态插件不一定走这条门面，
   **本版没有运行时证据能证明它一定能拿到**，所以只能当「前向兼容」而不是主路径；
2. 芯片在**模型侧**只序列化成 `@path`（`source:"reference"` 的 codec 是恒等的），
   `Cell[3] L4-L8` 只活在 `label` 里给人看，**主 agent 读不到**。用户要的是「让对话去改这一格」，
   芯片反而丢掉位置信息。

所以：**主通道是纯文本插入**，文本自带一行结构化定位 `@path (Cell[3] L4-L8)`。

## 5. 落地：`cite()` 的三层降级

| 层 | 通道 | 本版状态 |
|---|---|---|
| ① | `props.inputActions.captureInsertion()` + `insertText(text, span)`，被拒时重试 1 次（rev 竞态） | ✅ 主通道 |
| ② | `getChatBridge()`：`ctx.get("sessions").scope(sid)` + `ctx.get("conversation").input.for(actx)`，芯片走 `actx.emit("slash/input-insert-reference", …)` | ⚠️ 前向兼容（本版无 `conversation`，恒 null） |
| ③ | `navigator.clipboard.writeText()` | ✅ 最后兜底 |

失败提示必须**分层写明断在哪一层**（`no-actions` / `no-insertText`（附带实际方法清单）/
`insertText-refused` / `clipboard-unavailable`），否则用户只能回一句「还是不行」。

## 6. 「AI 改写看不到项目上下文」→ 交给对话

用户 2026-11-06 的原话：「AI 改写这部分，它看不到我的整个项目的上下文 …… 还不如用提示词法
到对话框里让人家给改」。内联 AI 走插件自己的 LLM 端点，手里只有 本格 + 邻格 + 变量/报错摘要。
所以新增 `buildChatPrompt()` + 三个入口（AI 条「💬 交给对话」/ 选区条「💬 在对话里改」/
右键「💬 让对话改本格」），把 **位置 + 当前代码 + 上下文 + 要求 + 怎么动手（nb_* 工具链）**
拼成提示词，投进主对话 —— 由有完整工作区上下文的 agent 去改。

## 7. 对上一版调研的更正（逐条）

| 上一版结论 | 实测 |
|---|---|
| 「正路是绕过 props，用 `conversation` service + `slash/input-insert-reference`」 | ❌ 本版没有 `conversation` service，这条路从未打通 |
| 「`props.inputActions` 不可靠，只有 8 个方法」 | ❌ 是 9 个方法，其中 `captureInsertion` + `insertText` 正是官方给的插入通道 |
| 「`ctx.sessions.scope(sid)` 可用」 | ⚠️ 未在 `inject` 里声明时属性访问会抛异常；必须 `ctx.get("sessions")`，且返回值可能被 `denyContext` 拒绝 |
| 「芯片是首选，纯文本是降级」 | ⚠️ 对「让 agent 改这一格」这个用途，纯文本（带 `Cell[n] Lx-Ly`）反而信息更全 |

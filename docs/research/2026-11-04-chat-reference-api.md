# 对话输入框投递 API 调研（RC.5：reference chip / inputActions / 替代通路）

- 调研日期：2026-11-04
- 目标 DSH：`E:\Users\asus\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
- 只读调研：除本文件外未改动任何生产代码
- 证据记号：`asar!<包内路径>:<行号>`；插件侧证据用相对路径

---

## 0. 一句话结论 + 推荐调用序列

**一句话结论**：`props.inputActions` 在 `sidebar.right.pane.tab` 的 props 类型里**确实声明了**，但它指向的公开 `actions` 对象（`dsh-client-ui-conversation` 里 `SessionInputShell.actions`）**只有 8 个方法，既没有 `appendDraft` 也没有 `insertReference`** —— 你代码里那两个判断（`ia && typeof ia.appendDraft === "function"`）在当前版本**必然为假**，所以永远退化成剪贴板；要拿到「文件卡片式芯片 + 结构化 cell/行号」，正路是**绕过 props，用 client service `conversation` + session 作用域事件 `slash/input-insert-reference`（或结构化 `setDraft`）**，这也是 `dsh-better-sidebar@0.28.0` 实际用的路径（它整个插件里没有出现过一次 `inputActions`）。

**推荐调用序列（可直接抄，Path A：自定义 source + codec，芯片显示自定义 label，模型收到结构化文本）**

```js
// 一次性注册（插件 apply 里，ctx.effect 包裹）：给芯片一个自己的 source + 序列化 codec
ctx.effect(() => {
  const inputTriggers = ctx.get("inputTriggers")            // service 名：inputTriggers
  return inputTriggers.registerSource({
    name: "notebook",                  // → 芯片的 source
    trigger: "#",                      // 必须 (trigger,name) 唯一；不想要菜单可以给个用户打不出来的字符
    order: 90,
    codec: {
      clipboardText: (ref) => ref,     // 复制/持久化形态
      // 模型真正看到的文本（异步）：这里放「cell 序列 + 行区间」
      serialize: async (ref, signal) => ref,   // ref 自己就编码了 path/cell/lines，下面构造
    },
    // 可选：点芯片时的行为（返回 true = 已处理）
    openReference(session, { ref }) { /* focus 到对应 cell */ return true },
  })
}, "notebook: reference source")

// 每次「添加到对话」：把当前 cell / 选区作为芯片插进活动会话的输入框
function citeToComposer(ctx, sessionId, { path, cellIndex, startLine, endLine }) {
  const actx = ctx.sessions.scope(sessionId)          // session 作用域 ctx
  if (actx === undefined) return false
  const conversation = ctx.get("conversation")        // client service：conversation
  if (conversation === undefined) return false
  const input = conversation.input.for(actx)          // 每会话常驻 facade（含 state / setDraft）
  const st = input.state.getSnapshot()
  if (st.phase !== "plain" && st.phase !== "claimed") return false   // 提交中不要插
  if (st.draftRev === undefined) return false

  // span 是 **detect 坐标**（芯片在 detect 里只占 1 个字符）。两条取法，优先第一条：
  //   ① shell 上有公开 getter `input.projection.detectText`（14970-14972 的 `get projection()`）
  //   ② 退化公式：draft(剪贴板坐标) 减去每个芯片多出来的长度
  const detectEnd = input.projection?.detectText?.length
    ?? (st.draft.length - st.occurrences.reduce((n, o) => n + o.length - 1, 0))

  const modelForm = `@${path} (Cell[${cellIndex}] L${startLine}-L${endLine})`
  const chipLabel = `${path.split("/").pop()}#Cell[${cellIndex}]:L${startLine}-L${endLine}`

  actx.emit("slash/input-insert-reference", {
    reference: {
      source: "notebook",
      ref: modelForm,          // ← codec.serialize(ref) 原样返回它
      label: chipLabel,        // ← 芯片上显示的文字（自由文本）
      appearance: "file",      // 只允许 file | folder | session
      clipboardText: modelForm,// 复制/持久化用
    },
    span: { draftRev: st.draftRev, start: detectEnd, end: detectEnd },
  })
  return input.state.getSnapshot().draftRev !== st.draftRev   // 成功判据（better-sidebar 同款）
}
```

**不想注册 source 的最短可用版**（Path B，芯片可点开文件，模型看到 `@path L4-L8`）：

```js
const st = input.state.getSnapshot()
const detectEnd = input.projection?.detectText?.length
  ?? (st.draft.length - st.occurrences.reduce((n, o) => n + o.length - 1, 0))
const mention = `@${relPath}`                       // 必须是工作区内的真实相对路径
actx.emit("slash/input-insert-reference", {
  reference: { source: "reference", ref: mention, label: `${base}#Cell[${i}]:L${a}-L${b}`,
               appearance: "file", clipboardText: mention },
  span: { draftRev: st.draftRev, start: detectEnd, end: detectEnd },
})
// 再补一段纯文本把行区间送进模型（芯片本身序列化出来只有 mention）
actx.emit("slash/input-insert-text", { text: ` L${a}-L${b}`, span: { draftRev: <最新 rev>, start: detectEnd + 1, end: detectEnd + 1 } })
```

> ⚠️ Path B 的第二段若嫌脆，用 `input.setDraft({text, references:[...]})` 一次成型（见 §3.4），或直接采用 Path A。

---

## 1. 当前 DSH 版本

| 位置 | 内容 |
| --- | --- |
| `asar!package.json` | `"name": "@deepseek-ai/dsh-desktop"`, **`"version": "0.2.1-rc.5"`**, `dshBuildCommit: d4db512a…`, `dshDesktopUpdateChannel: nightly` |
| `asar!dsh/package.json` | `"name": "@deepseek-ai/dsh-desktop-runtime"`, **`"version": "0.2.1-rc.5"`** |

结论：**0.2.1-rc.5**（桌面壳与内嵌 runtime 同版）。下文所有行号均针对该 asar。
`app.asar` 共 18234 个文件，`dsh/node_modules` 占 158 MB；客户端 UI 逻辑在 `dsh/node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js`（未压缩，带完整 JSDoc 与 `//#region`，可直接读）。

---

## 2. 槽位拿到的 `inputActions` 到底是什么

### 2.1 权威定义链（三段，缺一不可）

1. **props 类型清单（Slot Catalog，编译进 bundle 的元数据）**
   `asar!dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:5844-5896` 是 `sidebar.right.pane.tab` 的目录条目：

   ```js
   key: "sidebar.right.pane.tab", kind: "keyed", scope: "session",      // 5844-5846
   standardProps: [ …, "useInput: SnapshotSelectorHook<InputState>",
                       "inputActions: InputActions",                     // 5870
                       "sessionId: SessionId", … ],
   hookContext: "TabHookContext",                                       // 5878
   slotInject: "SidebarRightTabInjected",                               // 5879
   declaredBy: "an entry in 'rightbar.session' (client-ui-sidebar-right)…" // 5880
   ```

2. **值来自哪里（client 侧 provider）**
   `asar!dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:19912-19928`：

   ```js
   ctx.uiSession.provide({
     hooks: ["conversation", "input"],
     props: ["inputActions"],
     resolve: (binding) => {
       const shell = inputHub.shellFor(binding)
       return { hooks: { conversation: …, input: shell.state },
                props: { inputActions: shell.actions } }   // 19925
     },
   })
   ```

3. **`shell.actions` 的真正形状**
   `asar!…/dsh-client-ui-conversation/lib/client.js:14941-14967`（`SessionInputShell.actions`，注：一个 session 一份，identity 稳定）：

   | 方法 | 签名 | 语义 / 失败表现 |
   | --- | --- | --- |
   | `captureInsertion` | `() => { start, end, draftRev }` | 取当前草稿选区（**detect 坐标**）+ 当前修订号；无选区时是文末的折叠 span（`caretSpan()`，14745-14752） |
   | `insertText` | `(text: string, span) => boolean` | 纯文本插入（**无芯片**）。phase 为 `adjudicating`/`submitting` 或 `span.draftRev !== rev` → 返回 `false`，**不抛错**（14946-14950） |
   | `setDraft` | `(text) => void` | **整段替换**草稿；`text` 可以是纯字符串，也可以是结构化语义文档（见 §3.4）。无返回值 |
   | `persistDraft` | `() => void` | 把当前草稿刷进 conversation store（等价 publish 时自动持久化） |
   | `addAttachments` | `(ids: string[]) => …` | 追加附件 id（按签名推断） |
   | `removeAttachment` | `(id) => void` | 移除单个附件 |
   | `pruneAttachments` | `(ids: string[]) => void` | 只保留给定附件（输入栏用它对齐 `input.attachmentIds`，19029） |
   | `submit` | `() => void` | 以 `"queue"` 模式提交当前草稿（14964-14966） |

   **关键否定结论**：这个对象里**没有** `appendDraft`、**没有** `insertReference`、**没有** `insertFileReferences`、**没有** `paste`、**没有** `replaceText`。

### 2.2 你说到的那些方法其实都存在，但都在「内部 runtime」上，不对 slot 暴露

`DraftEditorRuntime`（同一 bundle，14969 `draftEditor` 字段持有）才有这些（`asar!…/dsh-client-ui-conversation/lib/client.js`）：

| 方法 | 行号 | 签名/语义 |
| --- | --- | --- |
| `setDraft(text)` | 14686-14696 | 整段替换（剥掉占位符 `REFERENCE_PLACEHOLDER_RE`），并入 undo 历史 |
| `appendDraft(text)` | 14704-14717 | **追加纯文本**为新段落（草稿为空时等价 setDraft）。**不在 actions 里** |
| `paste(text)` | 14725-14738 | 覆盖当前选区粘贴 |
| `caretSpan()` | 14745-14752 | detect 坐标选区 |
| `replaceText(span, text)` | 14759-14765 | 无 phase/rev 守卫的替换，返回是否应用 |
| `insertAsyncText(span, text)` | 14772-14779 | 独立 undo 步的异步文本插入（`actions.insertText` 就是转调它） |
| `insertReference(span, ref, tail)` | 14787-14793 | 用 1 个芯片节点替换 span；`tail === " "` 时不再补空格 |
| `insertFileReferences(references[])` | 14817-14830 | 在光标处**批量**插芯片（不动选区），refs 按源顺序 —— 最接近「多 cell 批量投递」的内部能力，同样不对外 |
| `insertCommand(...)` / `beginCommand` | 14804-14811 / 15315 | 斜杠命令芯片 |

### 2.3 `insertReference` 的参数形状、`span.draftRev` 与 CAS

- **公开的调用面**有两个，参数顺序**相反**，极易踩：
  - shell 内部：`insertReference(ref, span)` —— `asar!…/dsh-client-ui-conversation/lib/client.js:15347-15353`
  - draftEditor 内部：`insertReference(span, ref, tail)` —— 14787
- `ref` 不是一个「kind 枚举」，而是一个**插入对象**（见 §3.1）。
- `span` = `{ start, end, draftRev }`，坐标是 **detect 坐标系**（芯片在这个坐标系里占 1 个字符 `\uFFFC`，见 14308 `pushLeaf("chip", kid, "\uFFFC", …)`；`REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu` 在 14550）。
- `draftRev` = `SessionInputShell.rev`，是一个**单调递增的内容修订号**：只有「内容真的变了」才 +1（`onEditorUpdate` → `projectionContentChanged` → `this.rev += 1`，15016-15027）；纯光标移动不涨。
- **CAS 语义**：`if (span.draftRev !== this.rev) return false`（15350，`insertText` 同款 15384，`applyClaim` 15326）。过期就**静默返回 false**——不抛错、不提示，表现正是「点了没反应」。
- **从插件侧凭空构造能否成功**：**能**，因为修订号是可读的公开状态：`conversation.input.for(actx).state.getSnapshot().draftRev`（`compose()` 里 `draftRev: this.rev`，15714-15720）。只要读完在**同一 tick** 内发出，CAS 必过。唯一的真实竞态是「用户此刻正好也在打字」（rev 会 +1）；判定成功与否看 rev 有没有变化（`dsh-better-sidebar` 就是这么做的，见 §4.2）。
  → 因此插件里那句注释「我们从侧栏凭空构造 span 一定会被 rev CAS 挡掉」**是错的**：被挡的原因是「span 里的 rev 用了猜的/过期的值」，而不是「侧栏不能构造」。

---

## 3. ReferenceChipNode：什么 ref 会渲染成「文件卡片/芯片」

### 3.1 节点字段（芯片的全部可变量）

`asar!…/dsh-client-ui-conversation/lib/client.js:13650-13791`（`ReferenceChipNode`）：

```js
__source;        // 拥有者 source 名（序列化路由键 + DOM 锚点 data-composer-chip）
__ref;           // owner 作用域内的引用 id（字符串，语义由 source 决定）
__label;         // 芯片显示文字（插入时缓存）
__appearance;    // 可选图标种类
__clipboardText; // 剪贴板/持久化投影（也是 draft 文本里该芯片占的字符串）
__invalid;       // owner 解析失败位 → 芯片渲染成 invalid 样式
```

### 3.2 渲染条件（`ReferenceChip`，13629-13646）

```js
appearance === undefined
  ? <span class=marker>@</span>                                  // 无图标 → 打一个 "@"
  : <ReferenceIconRegular kind={appearance} size={14}/>          // 有图标
… <span class=label>{label}</span>                               // 显示 label
// 可点击条件：appearance === "file" && !invalid  → 加 openable 样式（cursor:pointer）
```

所以**想渲染成「文件卡片/芯片」形态，就设 `appearance: "file"`**（带文件图标、hover 高亮、可点击跳转）。也可以直接省略 `appearance` → 退化成 `@` 前缀的文字芯片（仍是一个整体芯片，但不像文件卡片）。

### 3.3 各字段控制什么

| 字段 | 控制 | 备注 |
| --- | --- | --- |
| `source` | 序列化走哪个 codec；点击走哪个 owner；DOM `data-composer-chip` | 必须是已 `registerSource` 的 name，否则**发送会被拒**（§3.5） |
| `ref` | owner 内部 id；`source: "reference"` 时它就是 `@path` 这种 mention 字符串 | 字符串，自由编码 |
| `label` | **芯片上显示的文字**（完全自由） | 想显示 `notebook.ipynb#Cell[3]:L4-L8` 直接塞进去即可 ✅ |
| `appearance` | 图标 + 是否可点 | 结构化路径里是**闭集** `session \| file \| folder`（zod 校验，§3.4） |
| `clipboardText` | 复制到剪贴板 / 草稿持久化 / draft 文本里占位 | 长度决定 span 的 `length` |
| `invalid` | 渲染成失败态（红色等） | 恢复草稿时由持久化数据带回来 |

### 3.4 结构化 `setDraft`：一次把「文本 + 多个芯片」交给输入框（官方 restore 通道）

`asar!…/dsh-client-ui-conversation/lib/client.js:4332-4345`（zod schema）+ 4351-4361（refine）：

```js
referenceSchema = z.object({
  source: z.string(), ref: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  label: z.string(),
  appearance: z.enum(["session", "file", "folder"]).optional(),   // ← 闭集
  clipboardText: z.string(),
  invalid: z.boolean().optional(),
})
snapshotSchema = z.object({ text: z.string(), references: z.array(referenceSchema),
                            command: z.object({ token: z.string() }).optional() })
  .refine(/* 引用必须有序、不重叠；且 text.slice(offset, offset+length) === clipboardText */)
```

`setDraft` 的落地：`15037-15048` → 无引用走 `draftEditor.setDraft(text)`，有引用走 `restoreDraft(text, references)`（14861-14896，逐 occurrence `new ReferenceChipNode({...})`）。

**这条路的价值**：`props.inputActions.setDraft(obj)` 和 `conversation.input.for(actx).setDraft(obj)` 都能用；一次提交即可带 N 个芯片，且芯片能扛重载（持久化 → `parseStoredDraft` 4383-4396 → 恢复）。
**代价**：整段替换（要自己把已有草稿文本拼进去，并给**所有**已有芯片算 offset），且 `appearance` 被限死为三值。

### 3.5 「某个文件第 X–Y 行」/ 自定义 label 能不能表达

- **自定义 label**：能，原生就是这么用的（`ui-reference` 里 `label` 直接取文件名/目录名，`asar!dsh/node_modules/@deepseek-ai/dsh-client-ui-reference/lib/client.js:339-353`）。所以 `notebook.ipynb#Cell[3]:L4-L8` 作为显示文字**完全没问题**。
- **内置「行区间 / 符号 / URL / range」引用类型**：**没有**。全部原生引用只有 3 种外观（`file` / `folder` / `session`），`ref` 就是一个字符串，没有结构化的 `lines` 字段。原生 file 引用连行号都不带。
- **想让模型真的收到行号**，只有两条路：
  1. **芯片 + 紧随其后的纯文本**（Path B）：芯片自身 serialize 出 `@path`，行区间靠后面的文字带过去；
  2. **自定义 source + codec**（Path A，推荐）：`ref` 里编码 `path/cell/lines`，`codec.serialize(ref)` 直接产出 `@path (Cell[3] L4-L8)`，芯片 `label` 用同类信息做人读展示。**这就是「用具体逻辑 + 渲染成文件卡片」两个要求同时满足的唯一干净解**。
- 注意：`source: "reference"` 的 codec 是恒等（`clipboardText: (ref) => ref`、`serialize: (ref) => ref`，`asar!…/dsh-client-ui-reference/lib/client.js:362-365`），即 **`ref` 本身就是模型看到的文本**；把行号塞进 `ref` 会同时污染「点芯片打开文件」的路径解析（355-361：只有 `appearance === "file"` 才打开，且按 `@` 后内容当路径）。

### 3.6 发送时的序列化（为什么 `source` 必须已注册）

`asar!…/dsh-client-ui-conversation/lib/client.js:15524-15566`（`sinkSerialized`）：

```js
Promise.all(occurrences.map(async (o) => ({
  offset: o.offset, length: o.length,
  text: await inputTriggers.serializeReference(o.source, o.ref, attempt.signal),  // 15549
})))
```
`serializeReference`（`asar!dsh/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js:1249-1253`）：

```js
const owner = this.deps.roster.all().find((s) => s.name === source)
if (owner?.codec === void 0) return Promise.reject(new Error(`slash: no serializer for reference source "${source}"`))
return owner.codec.serialize(ref, signal)
```

**风险点**：草稿里只要有一个芯片的 `source` 找不到带 `codec` 的 owner，**整次发送被拒**（15561-15565 把草稿恢复并报错）。所以 Path A 必须保证 source 常驻注册（`ctx.effect` 的生命周期要跟插件一致），且**不要**在草稿里留下已被卸载 source 的芯片。

---

## 4. 为什么 `sidebar.right.pane.tab` 里拿不到可用的 `inputActions`

### 4.1 两个独立的原因，其中第二个是决定性的

**(a) 类型上有，运行时可能是 `undefined`。** `inputActions` 由 `uiSession` 的 props provider 提供；`uiSession` 的「无会话」兜底会把**所有已声明 prop 显式置为 `undefined`**：

```js
// asar!dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js
function declareAbsent(kind, target, declared) {   // 1080-1085
  for (const name of declared ?? []) { claimStandardProp(kind, name, finalProps); target[name] = void 0 }  // 1083
}
materializeAbsent() { … declareAbsent("prop", props, descriptor.props, finalProps) … return { key: undefined, props } }  // 1032-1048
```

即：props 对象存在、key 存在、**值为 `undefined`**。只有当渲染点处于**有效 session binding** 内才拿得到真对象（`materialize()`，1012-1031）。
`sidebar.right.pane.tab` 的宿主 `SessionView` **确实**用 `SessionProvider` 包住了（`asar!dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:1698-1716`，`session: view.reference`），所以正常路径下 bindings 在；但 slot 声明是 `scope: "session"` 且由 `rightbar.session` 承载（catalog 5880），一旦渲染落在 absent 投影（无会话/未 retain/浮层重挂）就是 `undefined`。

**(b) 决定性原因：即使拿到了，`appendDraft` 也不存在。** 见 §2.1 —— `shell.actions` 只有 8 个方法。你代码里的守卫

```js
const ia = props && props.inputActions                                        // lib/client.js:4683
if (ia && typeof ia.appendDraft === "function") { ia.appendDraft(body) … }   // 4684-4686
```

**在当前版本恒为假**（`appendDraft` 只在内部 `DraftEditorRuntime` 上，14704）。于是两条分支都落到 `navigator.clipboard.writeText`，并且打印的就是那句「当前挂载点未提供对话桥接」。所以「拿不到 props.inputActions」这个诊断**可能是误读**：更常见的情况是 `<inputActions 存在但没有 appendDraft>`。建议把这句 notice 改成区分两者（`ia ? "inputActions 无 appendDraft" : "inputActions 缺失"`），否则永远查不清。

> 附带证据：本机 profile 里**没有任何第三方插件**出现过 `inputActions`（对 `~/.dsh/profiles/desktop/node_modules` 全量 grep `inputActions` / `appendDraft` 均 0 命中，含 `dsh-better-sidebar@0.28.0`）。这个 props 通道实际上没有被生态验证过。

### 4.2 `dsh-better-sidebar@0.28.0` 是怎么做的（结论：完全不用 inputActions）

它的「添加到对话」实现在 `lib/client.js` 的 `src/client/conversation-draft.ts` 区块（26928-27157），设计说明写在 `lib/types/client/conversation-draft.d.ts:1-20`：

```js
// lib/client.js:27033-27058  appendToDraft()
const actx = ctx.sessions.scope(sessionId)          // session 作用域 ctx
const conversation = ctx.get("conversation")        // 懒取 service（inject-free read）
const input = conversation.input.for(actx)          // 每会话 facade
const draft = input.state.getSnapshot().draft
const { draft: next, caretAfter } = spliceInsert(draft, text, probeComposerCaret(draft))
input.setDraft(next)                                // ← 公开 setDraft（纯文本路径）
placeComposerCaretAfterInsert(next, caretAfter)
```

```js
// lib/client.js:27129-27158  insertFileReference()  ← 结构化芯片路径
const input = conversation.input.for(actx)
const before = input.state.getSnapshot()
if (before.draftRev === void 0) return false
actx.emit("slash/input-insert-reference", {
  reference: { source: "reference", ref: reference.mention,
               label: reference.label, appearance: "file", clipboardText: reference.mention },
  span: { draftRev: before.draftRev, start: before.draft.length, end: before.draft.length },
})
return input.state.getSnapshot().draftRev !== before.draftRev   // 成功判据
```

要点：
1. **service 名是 `conversation`，入口 `conversation.input.for(actx)`**，`actx = ctx.sessions.scope(sessionId)`；`state` 是快照 store（`getSnapshot()` 拿 `{draft, draftRev, phase, occurrences, attachmentIds, queue}`）。
2. **结构化芯片走 session 作用域事件 `slash/input-insert-reference`**，`draftRev` 从 `state` 现读；成功判据是 rev 变了。
3. 它用 **DOM 探测**只为了解决「光标位置」（`probeComposerCaret`，26978-26994，`document.querySelector('#root [data-slot="conversation"] textarea[data-phase]')`）——因为 **`state` 没有光标 API**。这属于可选增强，不是投递必需。
4. 它明确写了 file 引用优先走事件、纯文本 `@path` 只是 fallback（`conversation-draft.d.ts:9-14`：「plain text `@folder/file.ts` only ever gets DSH's folder-ref decoration… so plain append is the fallback, not the primary path, for files」）。
5. 它**没有**用 `inputActions`、也没有 `appendDraft`（全仓库 0 命中）——所以插件注释里「dsh-better-sidebar 也这么做」是错记。

### 4.3 该槽位现在到底注入哪些 props

`asar!…/dsh-cordis-client-runner/lib/client.js:5857-5876`（`sidebar.right.pane.tab` 的 `standardProps` 全文，17 项）：

```
useRemoteAccess(action) · useResource · useWorkspaces · usePanelInfo · useSessions ·
useSessionStatus · useSessionRetainInfo · useSessionAccess(sessionId, action) ·
useWorkspaceAccess(workspaceId, action) · useChat · useConversation ·
useInput (SnapshotSelectorHook<InputState>) · inputActions: InputActions ·
useSession · sessionId: SessionId · useProjection · useAccess(action) · useTrajectory
```
外加 `hookContext: "TabHookContext"`（tab 自身的 `tab/定義` 等）与 `slotInject: "SidebarRightTabInjected"`（侧栏宿主额外注入的东西，catalog 未展开其成员）。

来源分层：
- `inputActions` / `useInput` / `useConversation` → conversation 包 `ctx.uiSession.provide`（19912-19928）
- `sessionId` / `useSession` / `useProjection` → `dsh-client-ui-session` 的 `BUILTIN_SOURCE`（`client.js:755-764`）+ `useProjection` keyed hook
- `useSessions` / `useSessionStatus` / `useSessionRetainInfo` / `useSessionAccess` → `slots.provideRoot`（1104-1113）
- `useChat` / `useTrajectory` 等 → 各自业务包

**slot 注入并不是「按 slot 单独装配」的对象字面量**，而是「作用域 source 的合并结果」：session 作用域 slot 拿到的就是 §2.1-2) 那些 descriptor 的 `materialize(binding).props + hooks`。所以**判断某个 prop 有没有，等价于判断「该 slot 渲染时有没有有效 session binding」+「provider 有没有声明它」**。

---

## 5. 替代方案（按可靠性排序）

### Path A —— 自定义 `source` + `codec` + 事件插芯片（**推荐**，唯一能同时满足「文件卡片」+「结构化 cell/行号」）

- 入口：`ctx.get("inputTriggers").registerSource({ name, trigger, order, codec: { clipboardText, serialize }, openReference? })`
  证据：`asar!…/dsh-client-ui-input-trigger/lib/client.js:1556-1571`（注册，只要求 `(trigger,name)` 唯一）、`1249-1253`（序列化走 `owner.codec.serialize`）、`1260-1268`（点击路由 `owner.name === source` → `owner.openReference(session, ref)`）；原生 file/session source 的写法可照抄 `asar!…/dsh-client-ui-reference/lib/client.js:332-368`。
- 插入：`actx.emit("slash/input-insert-reference", { reference, span })`（`dsh-better-sidebar` 27129-27158 已验证；宿主监听在 `dsh-client-ui-conversation/lib/client.js:15859-15873`）。
- 收益：`serialize(ref)` 由你控制 → 模型收到 `@nb.ipynb (Cell[3] L4-L8)`；`label` 自由 → 芯片显示 `nb.ipynb#Cell[3]:L4-L8`；`appearance:"file"` → 文件卡片观感；可批量（多 cell 多次 emit 或结构化 setDraft）。
- 风险：①`trigger` 必须唯一，别和 `@`、`/` 抢；②source 生命周期若短于草稿寿命，**该芯片会让整次发送失败**（§3.6）；③`codec.serialize` 必须容错、绝不抛（抛 = 发送失败）；④`trigger` 选一个用户不会打出来的字符属于「未验证行为」，建议先用真实触发符（如 `#`）验证一轮。

### Path B —— 复用 `source: "reference"` 的芯片（**零新增注册，最稳**，但行号靠旁路文本）

- 入口：同一个 `slash/input-insert-reference` 事件，`reference.source = "reference"`、`ref = "@<工作区相对路径>"`、`appearance:"file"`、`label = "文件#Cell[3]:L4-L8"`。
- 语义完全等于用户在 `@` 菜单里选了那个文件（`asar!…/dsh-client-ui-reference/lib/client.js:339-345`），所以**一定可渲染、一定可发送、点击能打开文件**（355-361 走 `ctx.sidebarRight.openResource`）。
- 行号：模型只会收到 `@path`（codec 恒等）。要么在芯片后补一段纯文本（`slash/input-insert-text`，宿主监听 15864），要么把行号写进 `ref`（会让点击解析失败，不推荐）。
- 风险：`ref` 必须是工作区内**真实存在**的相对路径，否则点击打开会失败（但发送不受影响）；`@path` 拼写要符合 `formatFileMention` 语法（含空格要 `@"..."`，见 better-sidebar `mentionFor` 的注释 27060-27100）。

### Path C —— 纯文本 `setDraft`（**最保险的降级**，但只有文字）

- 入口：`ctx.get("conversation").input.for(actx).setDraft(text|{text,references})`；或若 props 里有 `inputActions.setDraft` 也可。
  证据：`dsh-better-sidebar` 27033-27058；DSH 侧 `asar!…/dsh-client-ui-conversation/lib/client.js:15793-15798`（`input.for` 要求 retained session scope）、`15037-15048`（接受字符串或语义文档）。
- 用途：Path A/B 都不可用时（例如 session scope 拿不到），至少把「cell 序列 + 行区间 + 代码」作为结构化 Markdown 文本投进去。**注意**：这仍是「糊一坨文本」，但比剪贴板好，且不会被 CAS 静默拒绝。

### 明确不推荐
- **继续依赖 `props.inputActions.appendDraft`**：该方法在本版本不存在（§2.1）；即使将来出现，也没有类型/文档保证。
- **`props.inputActions.insertReference`**：同样不存在（只有内部 shell 的 `insertReference(ref, span)`，14787/15347）。
- **`inputActions.captureInsertion() + insertText()`**：可用但不是芯片，只能塞纯文本；且 `insertText` 会剥离占位符（14946-14950 → 14772-14779）。

---

## 6. 不确定性 / 未验证项

1. **`props.inputActions` 在 `sidebar.right.pane.tab` 运行时到底是「undefined」还是「有对象但无 appendDraft」**：静态证据显示两种都可能，我没有拿到现场值。验证方法（一行，插件里打印即可）：
   `console.log("[nb2] inputActions?", props.inputActions, "keys:", props.inputActions && Object.keys(props.inputActions))`
   或临时把 notice 文本改成区分两者的版本（见 §4.1 末尾）。**这条决定你 comment 里的诊断是否要改。**
2. **`hookContext: "TabHookContext"` / `slotInject: "SidebarRightTabInjected"` 的成员清单**没有展开（catalog 只给类型名，bundle 里无 `.d.ts`）。我只确认了 `sessionId` 之外的 standardProps；tab 专属注入里是否有更合适的桥接（如 `tab` 定义、`openTab`）未逐一核对。
3. **detect 坐标折算**：`SessionInputShell` 有公开 getter `get projection()`（14970-14972），`projection.detectText` 就是 detect 全文，直接取 `.length` 最稳；我给的**退化公式**（`draft.length - Σ(len-1)`）是根据「芯片在 detect 里占 1 个 `\uFFFC`」（14308）、`layout.clipboardStart/Length`（14416-14417）推导的，**两条都未实测**。基准事实是 `draft`（剪贴板坐标）与 `detectText` 在有芯片时**长度不同**——better-sidebar 用 `before.draft.length` 当 span 端点（27147-27151），在「草稿里已有芯片」的场景下**理论上是错的**（它自己只处理末尾追加、通常草稿是空的，所以没暴露）。
4. **`actx.emit` vs `actx.bail`**：原生 picker 用 `actx.bail`（1376-1379，可被拦截/取返回值），better-sidebar 用 `actx.emit`（无返回值，靠 rev 变化判成功）。二者在本版本都能到达宿主监听，但 `emit` 的**错误传播/取消语义**未验证；若发现偶发不生效，改试 `actx.bail(actx, eventName, payload)`。
5. **`trigger` 取值约束**：我只确认了「`(trigger,name)` 唯一」（1558），没有找到对 trigger 字符集的校验。用一个用户永不输入的字符（如 `\u0000`）是否安全**未验证**；建议先实测。
6. **`codec.clipboardText` 的实际调用点**没追到（只追到 `codec.serialize` 在发送时被调、`inputTriggers.serializeReference`）。它在插入时的作用可能只是 `ui-reference` 自己用来填 `clipboardText` 字段，不是宿主强制；Path A 里我把它写成恒等以规避风险。
7. **未做任何运行时验证**：客户端 `cordis_inspect_query`（client `Slots` / `Service`）在本会话两次均 10 s 超时（"Open or reconnect the Harness page"），我因此**全部结论来自静态阅读**。若要我实测，请在 GUI 已打开且前台的情况下重跑，或让我用内置浏览器打开 `http://127.0.0.1:61849` 再查。
8. **未验证 better-sidebar 0.28.0 与 rc.5 的兼容性**：它按 rc.1 写（`conversation-draft.d.ts` 提到「rc.1 picker」），在本机是 0.28.0 + rc.5；它能跑说明 service/事件接口在这两个版本间稳定，但我没有逐条比对返回值差异。

---

## 附录：一句话回答 5 个问题

1. **版本**：`0.2.1-rc.5`（asar `package.json` 与 `dsh/package.json` 一致）。
2. **`inputActions`**：`shell.actions`，8 个方法（`captureInsertion` / `insertText` / `setDraft` / `persistDraft` / `addAttachments` / `removeAttachment` / `pruneAttachments` / `submit`）；**没有 `appendDraft`、没有 `insertReference`**；`span={start,end,draftRev}` 为 detect 坐标，rev CAS 失败静默 `false`，rev 可从 `input.state.getSnapshot().draftRev` 现读 → **插件侧可以可靠构造 span**。
3. **芯片**：`appearance:"file"` → 文件卡片；`label` 自由（可写 `nb.ipynb#Cell[3]:L4-L8`）；`ref`/`clipboardText` 决定序列化与剪贴板形态；**无内置行区间/kind 体系**，行号要靠「旁路文本」或「自定义 source 的 codec」表达。
4. **为什么拿不到**：类型上声明了（catalog 5870），值由 `uiSession.provide` 给（19912-19928）；无 session binding 时被 `declareAbsent` 置 `undefined`（1080-1085）；**但真正的杀手是 `appendDraft` 不在公开 actions 里**。better-sidebar 0.28.0 完全不用它，走 `ctx.get("conversation").input.for(actx)` + `slash/input-insert-reference` 事件。
5. **替代方案**：A（自定义 source+codec+事件，推荐）→ B（复用 `source:"reference"` 芯片 + 旁路行号，最稳）→ C（纯文本 `setDraft` 降级）。

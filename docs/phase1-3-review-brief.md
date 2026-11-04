# Phase 1–3 实施摘要（供独立评审）

> 计划：`docs/plans/2026-11-04-dsh-notebook-v2-选区UI与AI交互计划.md`
> 插件：`dsh-notebook-v2`
> 时间：2026-11-04

## 一、已核实的事实（避免评审者重复取证）

1. **`--dsw-alias-brand-primary` 不是蓝色**。实测 `app.asar` 内
   `dsh-client-ui-theme/lib/client.js`：
   - `--dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-1000)` → `#0f1115`
   - `--dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50)` → `#f9fafb`
   即它是「品牌中性墨色」，深色主题近白、浅色主题近黑。**当强调色用 = 黑白灰**。
   正确的蓝色令牌：
   - 强调色 → `--dsw-alias-link` / `--dsw-alias-button-info-fill` → deepseek-400/500 = `#7aaaff` / `#4176e6`
   - 文档选区 → `--dsw-alias-bg-document-selection` = `color-mix(in srgb, #3b82f6 40%, transparent)`
2. **`react-dom` 在客户端模块表里可用**：已启用的 `dsh-better-sidebar@0.28.0`
   的 `lib/*.js` 里就有 `require("react-dom")` + `createPortal`，且它在真机正常工作。
   本插件仍做了 try/catch 降级（拿不到就 fixed 定位）。
3. **`props.inputActions.insertReference(span, ref, tail)` 不可用**：
   它的 `span` 是 detect 坐标系，还要 `span.draftRev === 编辑器当前 rev` 的 CAS；
   从侧栏凭空构造必然返回 false 且**不报错**（表现为「点了没反应」）。
   所以对话投递统一走 `appendDraft(text)`（纯文本入口，官方正道）。
4. **`agentDefaultModel` 的读方法是 `currentSelection()`**（不是 `get()`）。
5. **execute 的 ack 只在冷启动时发**：`kernel_driver.py` 里
   `if not started and needs_kernel and op == "execute": emitter.ack(...)`；
   内核已热时 `handle()` 不再 ack。所以执行类命令必须用 `sidecar.post()`（不等回执），
   用 `sidecar.send()` 会挂到 15s 超时。

## 二、改动清单

### lib/client.js（+905 行）
- 新增 `ACCENT` / `accentMix()` / `TEXT_SELECTION` / `ensureGlobalCss()` / `createPortal` 探测
- `tokens` 改选区令牌；7 处 `brand-primary` → `ACCENT`
- `buildExtensions`：**移除 `CM.drawSelection()`**；新增 `Alt-\` keymap；选区改原生 `::selection`
- 新增 `readSelection(view)`（CM6 选区 → {from,to,text,startLine,endLine}，0 基行号）
- 新增 `readDomSelection()`（markdown/输出区的 window.getSelection）
- 新增 `placeSelectionBar(rect, viewport, size)`（纯函数，上方优先/放不下翻下/水平夹取）
- 新增 `SelectionFloatingBar` 组件（createPortal + 三条销毁守卫）
- 新增 `languageOfCell(cell)`
- `buildGhostExtension`：新增 `onBusy`、`force`（Alt-\ 手动触发，跳过 enabled 与 minGap）、`acceptWord`
- `CellEditor`：上报选区变化；onReady 暴露 `getSelection` / `applySelectionEdit({startLine,endLine,insert})`（走 dispatch 进 undo 栈）
- `OutputBlockView`：报错块新增 `🔧 AI 快速修复` / `💬 发给 Agent`，并打 `data-nb2-error`
- `AiBar`：模式徽标 + 选区块行号徽标 + 上下文胶囊（邻格/变量/报错）
- `CellView`：工具栏新增 `✨ AI` / `💬`；`data-nb2-output` / markdown 区加 mouseup 上报选区；`flash` 类
- 面板：`cite()`（appendDraft 投递 + 剪贴板兜底）、`citeCell()`、`citeError()`、
  `runAi` 支持 mode/selection/vars/error、`acceptAi` 选区路径、`loadVars()`、`collectError()`、
  `onSelectionChange` + `selActions`、`ghostBusy`、`flashCell` + Agent 改格滚动闪烁
- `useNotebook` 增加 `agentFrame`（识别 `nb.updated` 的 `source:"agent"` + `cellId`）
- `__internals` 增加 9 个新出口

### lib/ai.js
- `resolveTarget`：优先 `svc.currentSelection()`，兼容 `get()`，支持 Promise，抛错回落 listModels
- `buildMessages`：新增 `rewrite-selection` / `fix` / `explain` 分支、`vars` 内核变量、`error` 报错、
  ghost 的 `context` 跨格上下文；新增导出 `normalizeMode`

### lib/index.js
- 新增 `VAR_CELL`（保留 cellId）、`VARS_PROBE`（Python 探针，一行 JSON 到 stdout）
- `onSidecarEvent` 顶部拦截保留 cellId 的 stream/cell.done，解析进 `varsCache`
- 新增 `Session.refreshVars()`（缓存 8s、并发复用、3s 超时、用 `post` 不用 `send`）
- 新增 `/nb2/vars` 路由
- `/nb2/ai/complete` 透传 `context`

### lib/tools.js
- `nb_add_cell` / `nb_edit_cell` / `nb_delete_cell` / `nb_move_cell` 的 `nb.updated`
  带 `source:"agent"` + `cellId` + `op`

### test
- 新增 `test/vars.mjs`（13 项：探针抽取/语法/行为/过滤/DataFrame 摘要）
- `client-logic.mjs` +26 项（placeSelectionBar/readSelection/languageOfCell/投递契约/反例断言）
- `smoke-client.mjs` +5 项（CellView 的 ✨AI/💬、报错块两个按钮）
- `ai.mjs` +20 项（新提示词分支、resolveTarget）
- `all.mjs` 登记 vars 套件

## 三、评审重点（请只针对这些提问）

按严重度分组，**每条一行**：

1. **会不会改坏用户数据**：选区级改写在「拿不到编辑器」时的降级路径是否会把片段当整格写回？
2. **生命周期**：新增的 async/定时器/监听器（ghost onBusy、flashCell、selPop、refreshVars、loadVars）
   在「组件卸载 / view 销毁 / 切换 cell / 面板关闭」时会不会留下 dispatch-after-destroy、泄漏或 unhandled rejection？
3. **分支顺序**：`onKeyDown` / keymap / `acceptAi` 里新加的分支有没有被前面的分支吞掉（死代码）？
4. **焦点与选区**：`SelectionFloatingBar` 的 `onMouseDown: preventDefault` 与三条销毁守卫是否真的能保住选区、
   又不留幽灵按钮？点「✨ AI 修改」后 AiBar 拿到的选区是否还是用户拖选的那一段？
5. **契约违反**：有没有用到 `window.prompt/confirm/alert`？有没有对 CM6 `destroyed` view dispatch？
   有没有在 `nb.updated` 之后假设 state 已经更新？
6. **令牌**：是否还有把 `brand-primary` 当强调色用的残留？
7. **提示词**：`rewrite-selection` 的分支会不会让模型返回整格（导致 diff 与接受逻辑错位）？

## 四、独立评审结论与处置（2026-11-04）

评审者只拿到三段代码（`acceptAi` / `applySelectionEdit` / `classifySelectionReply`），未读其它文件。

| # | 评审发现 | 处置 |
|---|---|---|
| Q1 | `replyKind==="full-cell"` 时直接整格覆盖，无校验；判别是启发式，误报会静默删掉选区外代码 | **已修**：新增 `fullCellCoversOutside()` —— 整格覆盖前必须**逐字包含选区外每一行非空原文**；不满足则**拒绝写入**并提示（保留 AI 条让用户看 diff） |
| Q2 | 「接受并运行」用 `state.cells` 可能是旧闭包 → 跑改前代码 | **已修**：`applySelectionEdit` 同层新增 `getSource()`，运行直接取编辑器权威 doc；不再依赖 React state 时序 |
| Q3 | `Number(undefined)→NaN` 被 `\|\|0` 静默变 0 → 改写文件开头；上游只判 `!!sel` 挡不住 | **已修**：新增 `validSelectionRange()`（严格要求 `typeof number` + 整数 + `0 ≤ start ≤ end`），`applySelectionEdit` 与 `acceptAi` 都先过它 |

回归测试：`client-logic.mjs` 新增 11 项覆盖上述三个函数（含「-1 行号 → 拒绝」「字符串行号 → 拒绝」
「整格回包改动了选区外 → 拒绝覆盖」等反例）。

另外两处自查发现（评审未覆盖）：
- **ghost 跨格上下文定位**：原先靠「prefix 尾 40 字符反查当前格」，匹配不上会退化成「取最后 3 格」，
  把当前格自身当成前序格（模型看到自己的代码→原样抄回）。改为由 `CellEditor` 显式传 `cellId`。
- **`refreshVars` 用错通道**：execute 的 ack 只在**冷启动**时发（`kernel_driver.py`），
  内核已热时 `send()` 会挂到 15s 超时。改用 `post()`（不等回执，以事件为准）。

## 五、已知的限制（不必报告）

- 移除 `drawSelection()` 后矩形选择不再自绘（原生选区仍可用）—— 已知取舍。
- `/nb2/vars` 在内核繁忙时最多等 3s 后返回旧快照 —— 有意为之。
- `cite()` 在没有 `props.inputActions` 时退化为剪贴板 —— 有意为之。

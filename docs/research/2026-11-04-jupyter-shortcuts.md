# Jupyter 快捷键对照调研（dsh-notebook-v2）

> 调研日期：2026-11-04 · 只读调研，未修改任何生产代码
> 对象：`dsh-notebook-v2/lib/client.js`（6084 行，revision `16df0aab`）
> 方法：全文 grep（`keymap` / `key:` / `keydown` / `Mod-` / `Escape` / `matchKey` / `keyFor`）+ 逐段精读 + 官方/半官方文档核对
> 说明：行号以当前 `lib/client.js` 为准；vendor 说明：`lib/cm-vendor.js` 是 esbuild 压缩产物（符号名已重命名），只能按**键位字符串**核对

---

## 0. 一句话结论 + P0 缺口清单

**一句话结论**：插件把「运行三连 + 编辑态」这套 VS Code 手感做完了（`Shift-Enter` / `Ctrl-Enter` / `Alt-Enter` / `Esc` / `Enter` / `↑↓` / `Delete` / `Ctrl-S`（仅编辑器内）），但**完全没有「命令模式（command mode）」这一层**——Jupyter 用户肌肉记忆里 `A`/`B`/`DD`/`Z`/`Y`/`M`/`R`/`Ctrl-A`/`Shift-↑↓` 整组无处可挂，且删格不可撤销。

**P0 缺口（7 条，按实现顺序）**

| # | 缺口 | 现状证据 | 为什么是 P0 |
|---|---|---|---|
| 1 | **命令模式底座缺失**（无 mode 状态、无 `data-nb2-mode`、无命令态选中态可视化） | 全文件无 `commandMode`/`data-nb2-mode`；`selected` 是**单个 id**（state 在 `client.js:4115`，派生下标 `4276`），`CellView` 只收 `selected` 布尔（`client.js:3549`） | 下面 2–5 全部依赖它；不先做等于逐条打补丁 |
| 2 | `A` / `B` 插入上/下一格 | 只有工具条「＋代码/＋MD/＋SH」都在**末尾**追加（`client.js:5390-5392`）；`addCell` 支持 `after`/`index`（`client.js:4229-4252`，`docs/api-nb2.md:186`）但没有任何键位 | Jupyter 最高频的造格动作；现在必须离开键盘去点按钮 |
| 3 | `DD` 删除 + `Z` 撤销删除 | 删除只有 `Delete`/`Backspace`（`client.js:3637-3641`）与 `⋯` 菜单（`client.js:5434-5449`），**删完即不可恢复**（`cell/delete` 无 undo 路由，`docs/api-nb2.md:27`） | Jupyter 里 `Z` 是删错格的唯一后悔药；现在误删一格 = 重新敲一遍代码 |
| 4 | `Y` / `M` / `R` 类型切换 | 只有下拉框 `<select>`（`client.js:3822-3837`）+ `changeType`（`client.js:4167-4178`） | 代码↔Markdown 切换是 Jupyter 第二高频动作 |
| 5 | `Ctrl-A` 全选 / `Shift-↑↓` 扩选 | `Ctrl-A` 在编辑器内是 CM 的「全选文本」；命令态无多选模型（`client.js:4115`） | 批量删除/合并/运行的前置；没有它 `Shift-M` 也无法实现 |
| 6 | `Ctrl-S` 全局保存 | 只有 CM keymap 里一条 `Mod-s`（`client.js:2601`），**焦点在容器/命令态/工具栏时按 Ctrl-S 会落到浏览器「网页另存为」** | 保存是 Jupyter 里唯一「随时可按」的键；现在按错位置就弹浏览器对话框 |
| 7 | `Esc` 语义未归一 + 命令态无「进编辑」入口收敛 | `Esc` 散了 **5 处** window/document capture：CM（`2610`）、容器（`3642`）、picker（`4470-4475`）、AI 条（`4974`）、选区浮条（`2788`）；命令态没有「当前格」概念可 Esc 回去 | 加命令模式前必须先定「Esc 归谁」，否则新键位会和浮层抢 |

> `Shift-Enter` / `Ctrl-Enter` / `Alt-Enter` 本身**已经是支持状态**（三处 handler 都通），不在缺口里，只在第 3 节标「部分（语义细节偏离）」。

---

## 1. 现状：插件当前全部键盘绑定（表 1）

插件没有集中式快捷键表，绑定分布在 **6 个层次**。逐层列出（行号 = `lib/client.js`）。

### 1.1 CM6 编辑器内 keymap（仅焦点在 `.cm-editor` 时生效）

构造点：`buildExtensions(CM, opts)`，`client.js:2557-2627`。

| # | 按键 | 行为 | 行号 | 备注 |
|---|---|---|---|---|
| E1 | `Tab` | 有 ghost 补全建议 → 接受；无 → `return false` 落到 `indentWithTab`（缩进） | `2596` | **必须是数组第一条**，注释说明「先匹配先赢」，早前被 `indentWithTab` 抢过（`2588-2595`） |
| E2 | `Shift-Enter` | `onRunBelow()` = 跑本格 + 聚焦下一格；最后一格补一格 | `2597` | 落点 `runBelow`（`4287-4302`）→ `nextRunTarget`（`810-821`） |
| E3 | `Ctrl-Enter` | `onRun()` 原地跑 | `2598` | |
| E4 | `Mod-Enter` | `onRun()`（macOS ⌘-Enter；Windows 上 Ctrl 已由 E3 命中，此条是冗余保护） | `2599` | 与 CM `defaultKeymap` 的 `Mod-Enter`=`insertBlankLine` 同键，**靠数组顺序压制**（`2589-2593` 的注释同源） |
| E5 | `Alt-Enter` | `onRunInsert()` = 下方插入新格并运行 | `2600` | 落点 `addCell(cell.id, true, type)`（`5793`） |
| E6 | `Mod-s` | `onSave()` | `2601` | **只在此层存在**；CM 返回 true 会 preventDefault，所以在编辑器内不会弹浏览器另存 |
| E7 | `Mod-k` | 唤起内联 AI 条（带当前选区） | `2603` | 插件自有键位（对齐 marimo / VS Code inline chat） |
| E8 | `Alt-\` | 强制请求一次 ghost 补全（绕过开关） | `2609` | 插件自有 |
| E9 | `Escape` | 若补全下拉开着（`.cm-tooltip-autocomplete`）→ `false`（让 `completionKeymap` 关它）；否则 `onEscape()` → 退出编辑态、焦点回格容器 | `2610-2619` | 上层包装在 `CellEditor`：**先丢弃 ghost 建议**，没有建议才退出编辑（`2896-2902`） |
| E10 | （透传）`...CM.closeBracketsKeymap` | `Backspace` 删配对括号、`Enter` 自动补右括号 | `2620` | |
| E11 | （透传）`...CM.defaultKeymap` | **隐式获得**：`Ctrl-/` 注释切换、`Mod-]`/`Mod-[` 缩进/反缩进、`Shift-Ctrl-K` 删除整行、`Ctrl-a` 全选文本、`Mod-z`/`Mod-Shift-z` 撤销/重做、`Mod-i` 选父语法、`Mod-Enter` 插空行（被 E4 压掉） | `2621` | 键位字符串在 vendor 里可查到：`"Mod-/"`、`"Mod-]"`、`"Shift-Mod-k"`、`"Mod-Enter"` 各命中 1 次（见 §6 不确定性） |
| E12 | （透传）`...CM.searchKeymap` | `Mod-f` 打开 CM 搜索面板、`Mod-g`/`Shift-Mod-g` 下/上一个、`Escape` 关面板（scope=`editor search-panel`）、`Mod-d` 选中下一个相同片段 | `2622` | `"Mod-f"`、`"Mod-d"` 在 vendor 里各命中 1 次；README 宣称的「`Mod-F` 查找」就是这条（`README.md:33`） |
| E13 | （透传）`...CM.historyKeymap` | `Mod-z` 撤销、`Mod-y`/`Mod-Shift-z` 重做、`Mod-u` 撤销选区 | `2623` | |
| E14 | （透传）`...CM.foldKeymap` | `Ctrl-Shift-[` / `Ctrl-Shift-]` 折叠/展开代码块、`Ctrl-Alt-[`/`]` 全部折叠/展开 | `2624` | 与 `foldGutter()`（`2585`）配套 |
| E15 | （透传）`...CM.completionKeymap` | `Ctrl-Space` 触发补全、`Escape` 关下拉、`↑↓/PageUp/PageDown` 在选择项间移动 | `2625` | |
| E16 | `CM.indentWithTab` | `Tab` 缩进（E1 返回 false 时才到） | `2626` | |

### 1.2 单元格容器（`CellView` 的 React `onKeyDown`，容器 `tabIndex=0`）

组件签名 `client.js:3549`；handler `client.js:3578-3647`；挂载点 `onKeyDown`（`3750`）。

前置闸门：`shouldIgnoreContainerKey({inEditor, focusMode})`（定义 `508-510`，调用 `3604`）→ 焦点在编辑器里或 `focusMode==="editor"` 一律 return。

| # | 按键 | 条件 | 行为 | 行号 |
|---|---|---|---|---|
| C1 | `Shift-Enter` | 非编辑器 | 运行并下移（`onRunBelow`） | `3605-3609` |
| C2 | `Ctrl`/`⌘`+`Enter` | 非编辑器 | 原地运行（`onRun`） | `3610-3614` |
| C3 | `Alt-Enter` | 非编辑器 | 运行并在下方插格（`onRunInsert`） | `3615-3619` |
| C4 | — | `inControl`（落点是 `button/select/a/option/label`） | **到此 return**，不再处理 C5–C9 | `3621` |
| C5 | `Enter` 或 `F2` | 容器态 | 进编辑态（`enterEdit`） | `3622-3626` |
| C6 | `ArrowDown` | 容器态 | 选中下一格（`onSelectSibling(1)`） | `3627-3631` |
| C7 | `ArrowUp` | 容器态 | 选中上一格 | `3632-3636` |
| C8 | `Delete` 或 `Backspace` | 容器态 | **直接删除本格**（无确认、无撤销） | `3637-3641` |
| C9 | `Escape` | 容器态 | `setFocusMode("container")` + 把焦点放回格容器 | `3642-3646` |

> 注释 `3584-3603` 记录三条「顺序定理」：①编辑器内放行必须在最前 ②Enter 组合必须在 `inControl` 之前 ③`Shift-Enter` 必须在普通 `Enter` 之前（否则是死分支，有回归测试 `test/client-logic.mjs:404-417`）。

### 1.3 面板级 capture 分发器（`onPanelKeyDownCapture`）

纯函数 `decideCellKey`（`782-801`）＋ `nextRunTarget`（`810-821`）＋ `isTextEntryTarget`（`824-837`）；接线 `4312-4348`；挂在面板根节点 `onKeyDownCapture`（`5346`，根节点**没有 `tabIndex`**，`5320-5346`）。

| # | 按键 | 条件（`decideCellKey`） | 行为 | 行号 |
|---|---|---|---|---|
| P1 | `Shift-Enter` | 非编辑器/非输入框/未 `defaultPrevented` | 运行并下移（`runBelow`） | `796` → `4345` |
| P2 | `Ctrl`/`⌘`+`Enter` | 同上 | 原地运行 **+ 重新聚焦本格**（`focusCell`） | `797` → `4336-4339` |
| P3 | `Alt-Enter` | 同上 | 下方插格并运行（`addCell(cell.id, true, type)`） | `798` → `4341-4344` |
| P4 | 其余一切 | `defaultPrevented` / `key!=="Enter"` / `inInput` / 无修饰键 / 不认识的组合（`Ctrl-Shift-Enter` 等） | `"pass"` | `784-793`、`800` |
| P5 | 编辑器内所有键 | `.cm-editor` 命中 | `"pass"`（避免一次按键跑两遍） | `795` |

### 1.4 window / document capture 兜底与浮层

| # | 位置 | 按键 | 条件 | 行为 | 行号 |
|---|---|---|---|---|---|
| W1 | 面板 `document` 级兜底 | 同上 P1–P3 | ①最近一次 `mousedown` 在面板内 ②落点**不在**面板内 ③面板可见（`getBoundingClientRect` 非零）④未 `defaultPrevented` | 复用 `onPanelKeyDownCapture` | `4506-4532`（判定注释 `4493-4505`） |
| W2 | 打开 notebook 的 picker | `Escape` / `↑` / `↓` / `Enter` | 焦点在 picker 内 | `pickerKeyAction`（`1769-1784`）：关 / 移动 / 打开 | `2001-2013` |
| W3 | picker 的 window 兜底 | `Escape` | picker 开着（焦点已掉到 `<body>`） | 关 picker（`preventDefault+stopPropagation`） | `4468-4491` |
| W4 | 选区浮动工具条 | `Escape` | 浮条显示中 | 关闭浮条 | `2787-2798`（另含点外部/mousedown/blur） |
| W5 | 内联 AI 条（全局） | `Ctrl`/`⌘`+`Enter` | AI 条开着 | 接受修改（`acceptAi(false)`） | `4967-4981` |
| W6 | 内联 AI 条（全局） | `Escape` | AI 条开着 | 拒绝/关闭 | `4974-4976` |
| W7 | AI 条指令输入框 | `Enter`（无 Shift） | 焦点在输入框 | 提交指令 | `3414-3417` |
| W8 | AI 条指令输入框 | `Escape` | 同上 | 取消 | `3418-3421` |
| W9 | 大纲过滤框 | `Escape` | 焦点在过滤框 | 清空过滤词 | `2168-2174` |
| W10 | 「手输路径」输入框 | `Enter` / `Escape` | 焦点在输入框 | 提交 / 关闭 | `5613-5616` |

### 1.5 按钮上的「快捷键提示」（**承诺 vs 实际**）

| 提示文案 | 位置 | 实际按键真的存在吗 |
|---|---|---|
| 「运行 (Ctrl-Enter)」 | `3838` | ✅ 存在（E3/C2/P2） |
| 「运行并在下方插入」（`▶+`，无提示） | `3839` | 有 `Alt-Enter`（E5/C3/P3），但按钮**没写提示** |
| 「渲染并跳到下一格 (Shift-Enter)」 | `3846` | ✅ 存在 |
| 「内联 AI…（Mod-K）」 | `3867`、`5177` | ✅ 存在 |
| 「接受 (Mod-↵)」 | `3530` | ✅ 存在（W5） |
| 「保存 (Mod-S)」 | `5371` | ⚠️ **只对编辑器内成立**（E6）；面板/容器态按 Ctrl-S 无绑定（见 §4） |
| 「AI 补全 … Tab 接受 / Esc 丢弃」 | `5396`、`README.md:29` | ✅ 存在（E1 / E9+`2898-2902`） |
| README「`Mod-F` 查找」 | `README.md:33` | ⚠️ 只在编辑器内（CM `searchKeymap`，E12）；命令态无「整本 notebook 查找」 |
| README「容器态键盘：`Enter` 进格、`↑↓` 选格、`Delete` 删格、`Esc` 退出编辑」 | `README.md:34` | ✅ 全部存在（C5–C9） |

### 1.6 一句话汇总

**已实现（14 个键位）**：`Shift-Enter`、`Ctrl-Enter`、`⌘-Enter`、`Alt-Enter`、`Ctrl-S`（仅编辑器）、`Ctrl-K`、`Alt-\`、`Tab`、`Esc`、`Enter`/`F2`、`↑`、`↓`、`Delete`/`Backspace`，外加 CM 透传的一整套（`Ctrl-/`、`Ctrl-]`/`Ctrl-[`、`Ctrl-Z`/`Ctrl-Shift-Z`、`Ctrl-F`、`Ctrl-Space`、`Ctrl-A`（文本级）、`Ctrl-Shift-[/]` 折叠）。
**完全没有**：命令模式、`A`/`B`/`DD`/`Z`/`Y`/`M`/`R`/`X`/`C`/`V`/`Shift-M`/`Ctrl-Shift-Minus`/`Ctrl-A`（单元格级）/`Shift-↑↓`/`F`/`O`/`Shift-O`/`L`/`H`/`I I`/`0 0`/`1..6`/`Alt-↑↓`/`Ctrl-Shift-C`/`Ctrl-Shift-P`。

---

## 2. Jupyter 常见快捷键对照（表 2）

**来源**（按权威度）：
- **L1** = JupyterLab 4.6 官方 *Notebooks* 文档（Edit/Command Mode 定义、`Tab` 补全、`Shift-Tab` tooltip、`Alt-↑/↓` 内核历史）：<https://jupyterlab.readthedocs.io/en/stable/user/notebook.html>
- **L2** = JupyterLab 4.6 官方 *Commands* 文档（命令面板 `Command/Ctrl Shift C`）：<https://jupyterlab.readthedocs.io/en/stable/user/commands.html>
- **N1** = Jupyter Notebook 官方文档（`Shift-Enter` / `Esc` / `Enter` 三条 essential、`Ctrl-F` 搜索、`i i` 中断、`0 0` 重启）：<https://jupyter-notebook.readthedocs.io/en/latest/notebook.html>
- **T1** = **非官方**社区教程（按 command/edit 两模式逐条列表，覆盖官网页面上没有逐条列出的键）：<https://jupyter-tutorial.readthedocs.io/en/24.1.0/notebook/shortcuts.html>
  > ⚠️ 官方页面只列「essential」并在应用内 Help → Keyboard Shortcuts 里给全表；**本表逐条键位主要依据 T1 + 对 JupyterLab 默认键位的通识核对**，标 `T1*` 的行请按 §6 当作「高置信但非官方原文」。

「Lab / NB」列：`L` = JupyterLab 有；`N` = Jupyter Notebook（7.x 基于 JupyterLab 组件，classic 6.x 同键）有；`L+N` = 两者都有。
「本插件」列：✅支持 / 🟡部分 / ❌缺失。

### 2.1 运行（两种模式都可用，是 Jupyter 的核心）

| 快捷键 | Jupyter 语义 | Lab | NB | 本插件 | 证据 |
|---|---|---|---|---|---|
| `Shift-Enter` | 运行本格并**选中下一格**（最后一格则新建一格） | L | N（N1 明示「last cell → makes a new cell below」） | ✅ 支持，但**跑完直接进下一格的编辑态**（VS Code 手感，非 Jupyter 的「选中」） | `2597`/`3605`/`4345`；语义 `4281-4286` |
| `Ctrl-Enter` | 原地运行，**保持选中（命令态）** | L | N | 🟡 跑了，但会把焦点塞进本格编辑器（`focusCell` → `focusReq` → 进编辑态） | `3610-3614`、`4336-4339`、`4126-4131` |
| `Alt-Enter` | 运行并在下方插入新格 | L | N | ✅ 行为一致；同样会聚焦新格编辑态 | `2600`/`3615`/`4341-4344` |
| `Ctrl-Shift-Enter` | 不存在（有些环境绑「运行全部」） | — | — | ❌ 且**刻意不实现**（`test/client-logic.mjs:619` 断言「不发明第四个键位」） | `decideCellKey:799-800` |
| `I I` | 中断内核 | ✅ | ✅（N1 提到 "i,i"） | ❌ 只有工具条「■ 中断」按钮 | `5386` |
| `0 0` | 重启内核（带确认） | ✅ | ✅（N1 提到 "0,0"） | ❌ 只有「↻ 重启 / ↻ 重启并清空」按钮 | `5387`、`5432` |

### 2.2 命令模式：导航与多选

| 快捷键 | Jupyter 语义 | Lab | NB | 本插件 | 证据 |
|---|---|---|---|---|---|
| `Esc` | 进入命令模式 | L（L1 明示） | N | 🟡 只是「退出编辑器、焦点回格容器」，没有命令态语义 | `2610-2619`、`3642-3646` |
| `Enter` | 进入编辑模式 | L | N | ✅（容器态 `Enter`/`F2`） | `3622-3626` |
| `↑` / `k` | 选中上一格 | L | N | 🟡 `↑` 有；`k` 无 | `3632-3636` |
| `↓` / `j` | 选中下一格 | L | N | 🟡 `↓` 有；`j` 无 | `3627-3631` |
| `Shift-↑` / `Shift-k` | 向上扩选（多选） | L | N | ❌ 无多选模型 | `client.js:4115`（`selected` 单值） |
| `Shift-↓` / `Shift-j` | 向下扩选 | L | N | ❌ 同上 | 同上 |
| `Ctrl-A` | 全选所有单元格 | L | N | ❌ 命令态无；编辑器内 `Ctrl-A` 是 CM 的「全选文本」（语义不同） | `2621`（`defaultKeymap`） |

### 2.3 命令模式：增删改

| 快捷键 | Jupyter 语义 | Lab | NB | 本插件 | 证据 |
|---|---|---|---|---|---|
| `A` | 在上方插入格 | L | N | ❌ 只有「末尾追加」按钮 | `5390-5392` |
| `B` | 在下方插入格 | L | N | ❌ 同上（`Alt-Enter` 是「插入并运行」，不是 `B`） | `5793` |
| `D D` | 删除选中格 | L | N | 🟡 只有 `Delete`/`Backspace`（键位不同，且**不可撤销**） | `3637-3641` |
| `Z` | 撤销删格 | L | N | ❌ 无（`cell/delete` 无 undo 路由） | `docs/api-nb2.md:27` |
| `X` / `C` / `V` | 剪切/复制/粘贴单元格 | L | N | ❌ 无单元格剪贴板 | — |
| `Shift-V` | 粘贴到上方 | L | N | ❌ | — |
| `Y` | 变 code | L | N | ❌ 只有下拉框 | `3822-3837` |
| `M` | 变 markdown | L | N | ❌ 同上 | 同上 |
| `R` | 变 raw | L | N | ❌ 同上 | 同上 |
| `1`–`6` | 变 heading 1–6（markdown 格） | ✅ | ✅ | ❌ | — |
| `Shift-M` | 合并选中格（单选则与下一格合并） | ✅ | ✅ | ❌ 无合并能力（无 `cell/merge` 路由） | `docs/api-nb2.md:27` |
| `Ctrl-Shift-Minus` | 在光标处拆分单元格 | ✅ | ✅（T1*） | ❌ 无拆分能力 | — |

### 2.4 命令模式：其他常用

| 快捷键 | Jupyter 语义 | Lab | NB | 本插件 | 证据 |
|---|---|---|---|---|---|
| `Ctrl-S` | 保存 + checkpoint | L | N | 🟡 **仅编辑器内**（CM keymap）；容器/命令态会触发浏览器「网页另存为」 | `2601`（唯一一处） |
| `F` | 查找/替换（整本 notebook） | ✅ | ✅ | 🟡 编辑器内 `Ctrl-F` 走 CM 搜索面板；命令态 `F` 与「整本查找」都没有 | `2622` |
| `O` | 切换选中格输出显示/隐藏 | ✅ | ✅ | ❌ `OutputBlockView` 没有折叠开关（只接 `block/CM/onFixError/onCiteError`） | `3092` |
| `Shift-O` | 切换输出滚动 | ✅ | ✅ | ❌ | — |
| `L` | 切换行号 | ✅ | ✅ | 🟡 行号**恒开**（`CM.lineNumbers()`），无法切换 | `2560` |
| `H` | 显示快捷键帮助 | ✅ | ✅ | ❌ 无快捷键帮助面板 | — |
| `Ctrl-Shift-C` | 命令面板 | ✅（L2 明示 `Command/Ctrl Shift C`） | NB7 ✅ / classic ❌ | ❌ 无命令面板 | — |
| `Ctrl-Shift-P` | 命令面板（旧版/部分环境） | ✅（T1*） | ✅（T1*） | ❌ | — |
| `Alt-↑` / `Alt-↓` | 内核历史（上一条/下一条输入） | ✅（L1 明示，需开启 settings） | ❌ | ❌ 无 sidecar 历史接口 | — |
| `Q` / `Esc` | 关闭 pager | ✅ | ✅ | ❌（无 pager） | — |

### 2.5 编辑模式（与 Jupyter 的差异集中在这里）

| 快捷键 | Jupyter 语义 | Lab | NB | 本插件 | 证据 |
|---|---|---|---|---|---|
| `Tab` | 补全 / 缩进 | L（L1 明示） | N | ✅ 补全优先，无建议则缩进 | `2596`、`2626` |
| `Shift-Tab` | tooltip / 签名帮助 | L（L1 明示） | N | ❌ CM `defaultKeymap` 无此绑定；插件也没加 | — |
| `Ctrl-]` / `Ctrl-[` | 缩进 / 反缩进 | ✅ | ✅ | ✅ 由 `...CM.defaultKeymap` 提供 | `2621`（vendor 含 `"Mod-]"`） |
| `Ctrl-/` | 注释/取消注释 | ✅ | ✅ | ✅ 由 `...CM.defaultKeymap` 提供（`toggleComment`） | `2621`（vendor 含 `"Mod-/"`） |
| `Ctrl-D` | 删除整行 | ✅ | ✅ | ❌ **且已被占用**：CM `searchKeymap` 的 `Mod-d` = 「选中下一个相同片段」（vendor 含 `"Mod-d"`） | `2622` |
| `Ctrl-Z` / `Ctrl-Shift-Z`（或 `Ctrl-Y`） | 撤销 / 重做 | ✅ | ✅ | ✅ CM history | `2583`、`2623` |
| `Ctrl-U` | 撤销选区 | ✅ | ✅ | 🟡 CM 是 `Mod-u`=undoSelection（等价，键位同） | `2623` |
| `Ctrl-K` | emacs 式删到行尾 | ✅ | ✅ | ✅ CM `defaultKeymap` 的 `Ctrl-k`=killLine | `2621` |
| `Ctrl-↑` / `Ctrl-↓` | 跳到格首 / 格尾 | ✅ | ✅ | 🟡 CM 是 `Mod-Home/Mod-End`（不同键） | `2621` |
| `Ctrl-M` | 进命令模式 | ✅ | ✅ | 🟡 用 `Esc` 代替 | `2610` |
| `Ctrl-S` | 保存 | ✅ | ✅ | ✅（编辑器内） | `2601` |
| `Ctrl-Shift-C` / `Ctrl-Shift-P` | 命令面板 | ✅ | ✅ | ❌ | — |

### 2.6 覆盖度小结

| 分组 | 对照条目数 | 本插件 ✅ | 🟡 | ❌ |
|---|---|---|---|---|
| 运行（§2.1） | 6 | 2 | 1 | 3 |
| 命令模式导航/多选（§2.2） | 8 | 1 | 3 | 4 |
| 命令模式增删改（§2.3） | 13 | 0 | 2 | 11 |
| 命令模式其他（§2.4） | 11 | 0 | 3 | 8 |
| 编辑模式（§2.5） | 13 | 6 | 2 | 5 |
| **合计** | **51** | **9** | **11** | **31** |

---

## 3. 缺口与优先级（表 3）

优先级判据（任务给定）：**P0** = 肌肉记忆级高频；**P1** = 常用但要求可发现性；**P2** = Lab 特有/低频。
「建议动作」里带 `[B]` 的表示需要后端（宿主半）配合。

| # | 快捷键 | Jupyter 语义 | 本插件现状（证据） | 建议动作 | 优先级 |
|---|---|---|---|---|---|
| 1 | `Esc` | 进命令模式 | 🟡 退编辑器→容器（`2610`、`3642`） | 引入显式 mode 状态（`editor`/`command`），`Esc` 从 editor→command；命令态再 `Esc` 取消选中/关闭浮层。**同一份判定要覆盖浮层优先级**（picker/AI/大纲 > 命令态） | **P0** |
| 2 | `A` | 上方插入 | ❌ 只有末尾追加（`5390-5392`） | `addCell` 加 `index` 通道：`post("cell/add", {index: idx})`（`4229-4252` 已支持 `opts.index`） | **P0** |
| 3 | `B` | 下方插入 | ❌ 同上（`Alt-Enter` 是「插入+运行」，语义不同） | `addCell(selectedId, false, "code")`；并把 `▶+` 按钮 title 补上 `Alt-Enter` 提示（`3839`） | **P0** |
| 4 | `D D` | 删除选中格（两段式，防误删） | 🟡 只有 `Delete`/`Backspace` 立即删（`3637-3641`） | 命令态加 `d` 前缀状态（500ms 内第二个 `d` 才删）；保留 `Delete` 作为兼容 | **P0** |
| 5 | `Z` | 撤销删格 | ❌ 无（`docs/api-nb2.md:27` 无 undo 路由） | 客户端 undo 栈：删除前存 `{cell, index}`→ `Z` 时 `cell/add` 按 index 回插并回写 source/type。**输出无法恢复**（`cell/add` 只收 source），要么接受「源码回来、输出丢」，要么 `[B]` 加 `cell/restore` | **P0** |
| 6 | `Y` / `M` / `R` | code/markdown/raw | ❌ 只有下拉框（`3822-3837`） | 直接复用 `changeType`（`4167-4178`，走 `cell/edit {cellType}`，无需后端改动） | **P0** |
| 7 | `Ctrl-A` | 全选单元格 | ❌ `selected` 单值（`4115`） | 状态从 `selected:string` 改成 `selectedIds:string[]` + `anchor`；`Ctrl-A` 全选；框选/多选高亮要同步改 `CellView.selected`（`3549`、`3778-3779`） | **P0** |
| 8 | `Shift-↑` / `Shift-↓` | 扩选 | ❌ 同上 | 依赖 #7 的 `anchor` + `extendTo`；`onSelectSibling`（`5778-5781`）扩成支持 `extend` 参数 | **P0** |
| 9 | `Ctrl-S` | 保存 | 🟡 仅编辑器内（`2601`） | 提到面板级（见 §5.2）：`if ((ctrl||meta) && key==="s") { preventDefault(); save() }`，否则浏览器另存会抢 | **P0** |
| 10 | `Ctrl-Enter` 语义 | 原地跑后**留在命令态** | 🟡 会 `focusCell` 进编辑态（`4336-4339`） | 二选一：显式声明「本插件采用 VS Code 手感（跑完进编辑）」并写进 README，或命令态下不 `focusCell`、只 `setSelected`。**必须由用户拍板**（见 §4.3） | **P1** |
| 11 | `Shift-M` | 合并格 | ❌ 无路由 | `[B]` 加 `cell/merge {ids:[a,b]}`（拼 source + 删后者，原子）；客户端两步（`cell/edit` 拼 source + `cell/delete`）不原子，中途失败会丢内容 | **P1** |
| 12 | `Ctrl-Shift-Minus` | 光标处拆分 | ❌ | `[B]` 优先；客户端两步可行（`cell/edit` 前半 + `cell/add` 后半 `after` 本格），丢输出 | **P1** |
| 13 | `Ctrl-/` | 注释 | ✅（编辑器内，`2621`） | **无需新增**；只需在命令态拒绝该键（避免误触） | **P1**（已支持，标注即可） |
| 14 | `Ctrl-]` / `Ctrl-[` | 缩进 | ✅（编辑器内，`2621`） | 同上 | **P1**（已支持） |
| 15 | `F` | 整本查找/替换 | 🟡 仅 CM 编辑器内搜索（`2622`）；无 cross-cell 搜索 | 面板级搜索框：对 `cells[].source` 做定位（客户端即可，无需后端），命中后 `focusCell` + `api.setCursorLine`（`3663` 已有该 API） | **P1** |
| 16 | `Ctrl-F` | 同上（浏览器习惯） | 🟡 同上 | 与 #15 同一条落点；面板焦点不在编辑器时 `preventDefault` 后走面板搜索 | **P1** |
| 17 | `Shift-Tab` | tooltip/签名 | ❌ | CM 侧无内建（需要 `@codemirror/hover`/LSP，vendor 未打），**建议不做**，在文档里写清 | **P2** |
| 18 | `O` / `Shift-O` | 输出显隐/滚动 | ❌ `OutputBlockView` 无折叠属性（`3092`） | 给 `OutputBlockView` 加 `collapsed`（父级按 cellId 存开关），`O` 切换；`Shift-O` 可只切「最大高度」 | **P2** |
| 19 | `L` | 行号开关 | 🟡 恒开（`2560`） | 用 `CM.Compartment`（vendor 已导出，`scripts/cm-entry.js:7`）包 `lineNumbers()`，`L` 重配 | **P2** |
| 20 | `H` | 快捷键帮助 | ❌ | 静态浮层列出本插件**自有**键位（含 `Mod-K`/`Alt-\` 这类非 Jupyter 键），复用 picker 的浮层约定（`data-nb2-*` + window capture Esc） | **P2** |
| 21 | `I I` / `0 0` | 中断/重启内核 | ❌ 按钮有（`5386-5387`） | 命令态两段式前缀键；`kernelAction` 已有（`4263-4273`） | **P2** |
| 22 | `X` / `C` / `V` / `Shift-V` | 单元格剪贴板 | ❌ | 需要 `clipboard` 状态 + 多选（#7）；`Ctrl-V` 在浏览器里权限受限（read 需用户手势），**建议只做 `X`/`C`/`V` 的内存内剪贴板** | **P2** |
| 23 | `Ctrl-Shift-C` / `Ctrl-Shift-P` | 命令面板 | ❌ | 需要命令注册表（本插件命令 ≈ 40 个动作）；且 **Chrome/Edge 把 `Ctrl-Shift-C` 绑成「检查元素」**（见 §4.1），建议只做 `Ctrl-Shift-P` 或自定键 | **P2** |
| 24 | `Alt-↑` / `Alt-↓` | 内核历史 | ❌ | `[B]` sidecar 需暴露 `history` 接口（当前 `docs/api-nb2.md` 无） | **P2** |
| 25 | `1`–`6` | md heading | ❌ | 客户端改 source 前缀（`cell/edit`），无需后端；但和「命令态数字键」易冲突 | **P2** |

**依赖顺序（实现上必须先做的三件）**：`#1 mode 状态` → `#7 多选模型` → 其余按 P0 顺序。

---

## 4. 冲突风险与既有约定

### 4.1 会被宿主/浏览器/CM6 抢走的 Jupyter 默认键

| 键 | 谁可能先吃掉 | 证据/理由 | 结论 |
|---|---|---|---|
| `Ctrl-S` | **浏览器**（保存网页对话框） | 插件唯一绑定在 CM keymap（`2601`），CM 命中后 `preventDefault` 所以**编辑器内安全**；容器/命令态没有任何 handler，事件直达浏览器 | 加 #9 时**必须** `preventDefault()`，否则会同时弹「另存为」 |
| `Ctrl-Shift-C` | **Chromium 全局快捷键**（检查元素 / Toggle element inspector） | Chrome/Edge 的硬绑定；DSH 桌面版本质是 Electron（Chromium） | 若做命令面板，**别用** `Ctrl-Shift-C`；`Ctrl-Shift-P` 在普通页面上不是浏览器全局键（只在 DevTools 聚焦时是命令菜单），可安全 `preventDefault` 后自用 |
| `Ctrl-D`（编辑态删行） | **CM `searchKeymap`** | vendor 里有 `"Mod-d"`（`selectNextOccurrence`），`2622` 已透传 | 想做 Jupyter 的 `Ctrl-D` 删行，必须**把自定义绑定放在 `...CM.searchKeymap` 之前**（同数组先匹配先赢），并接受「失去 selectNextOccurrence」 |
| `Ctrl-F` | **浏览器**（页内查找）/ CM | 编辑器内 CM 抢到（`2622`）；面板态无 handler → 浏览器查找 | #15/#16 落地时面板级必须 `preventDefault` |
| `Ctrl-A` | **浏览器**（全选页面文本） | 现无命令态绑定 | #7 落地时必须 `preventDefault`，否则整页被选中 |
| `Ctrl-/` | 插件自身 CM 已占 | `2621`（`toggleComment`） | 命令态不要重复绑定，避免「注释了文本又触发别的」 |
| `Esc` | **已有 5 处语义** | CM（`2610`）、容器（`3642`）、picker（`4470`）、AI 条（`4974`）、选区浮条（`2788`）、大纲过滤框（`2169`） | 新增「Esc=命令模式」前必须先定**优先级链**，否则会出现「按 Esc 关了 picker 又退了模式」 |
| `Ctrl-K` | 插件自有（`2603`） | 与 Jupyter 无冲突，但与浏览器「地址栏搜索」无关（页面内可控） | 保留 |
| `Alt-\`、`Mod-K` | 插件自有 | `2609`、`2603` | 保留，需写进帮助面板（#20） |
| `Ctrl-Shift-[` / `]` | CM `foldKeymap`（`2624`） | 与 Jupyter 的「缩进」`Ctrl-]` 不同键（缩进是 `Ctrl-]` 单键） | 无冲突；但**注意**：`Ctrl-]` 缩进、`Ctrl-Shift-]` 折叠，差一个 Shift，文档要写清 |

**未验证项**：DSH 客户端壳（`dsh-client-*`）是否有全局快捷键（例如工作区级 `Ctrl-S`、面板切换）。仓库内 grep `addEventListener("keydown"` 只命中本插件（5 处 capture）与 `dsh-autoresearch`（1 处非 capture），**没有跨插件抢占**；宿主壳在 `app.asar` 内，本轮未能静态确认（见 §6）。

### 4.2 插件**刻意**避开的设计（改之前先读这两处）

1. **README「关键实现约定」**（`README.md:165-189`）：
   - 浮层退出**不能**只靠浮层自己的 `onKeyDown`，必须 window capture 兜底（picker 目录行是 `div`，点一下焦点掉 `<body>`）；
   - 面板级键盘分发**必须**有 document 级兜底，且兜底要同时满足三条（最近 mousedown 在面板内 / 落点不在面板内 / 面板可见）——**加新键位时要复用这三条闸门，不要另起一套**。
2. **`docs/plans/2026-11-04-体验修复v6-计划.md`**：
   - `:110` 明确写下「按键抢占宿主快捷键」的缓解：**「面板级 keydown 只处理 Enter 组合；命中 `.cm-editor` / `input` / `textarea` / `select` 一律放行」**。
   - `:224` 「**不新增 Ctrl-Shift-Enter**：VS Code 真实键位是 Shift-Enter / Ctrl-Enter / Alt-Enter」。
   - `:228` 纯函数抽进 `__internals` 才可测（`decideCellKey` / `nextRunTarget`）。
3. **`spin` 记忆（`dsh-notebook-v2` 经验）**：客户端半不能 import 兄弟文件；纯逻辑必须内联 `client.js` 并用 `__internals` 暴露；`test/_load.mjs` 会把 `lib/*.js` 逐个复制后 `import`，所以**新增的键位判定也要是纯函数**，否则测不到（React 桩的 `useState` 无状态、`useEffect` 空实现）。

### 4.3 需要用户先拍板的语义冲突（不是 bug，是产品取向）

| 冲突 | VS Code 手感（插件现状） | Jupyter 语义 | 影响面 |
|---|---|---|---|
| `Shift-Enter` 跑完去哪 | 聚焦下一格**编辑器**（可直接打字） | 选中下一格（**命令态**） | 命令模式一上线，两者会互相打架：命令态按 `Shift-Enter` 之后到底该不该进编辑？ |
| `Ctrl-Enter` 跑完 | 原地跑 + 聚焦本格编辑器（`4336-4339`） | 原地跑、留在命令态 | 同上 |
| `Alt-Enter` 跑完 | 新建格 + 运行 + 聚焦新格编辑 | 新建格 + 运行 + 选中新格（命令态） | 同上 |
| `Delete` | 立即删格（`3637`） | Jupyter 用 `D D`；`Delete` 在 Jupyter 命令态无删格语义 | 保留 `Delete` 会与「两段式 `D D`」并存，需确认是否容忍两条删除路径 |

**建议**：把「跑完进编辑」作为**本插件明示的差异**写进 README/帮助面板；命令态新增键位一律不改这三个键的既有行为（避免破坏已验收的 v6 手感）。

---

## 5. 实现落点建议

### 5.1 状态模型（必须先改的两处）

| 现状 | 建议 | 位置 |
|---|---|---|
| `selected` = 单个 cellId（`client.js:4115` `const [selected, setSelected] = React.useState(null)`） | `selectedIds: string[]` + `anchorId` + `mode: "command" \| "editor"`；`CellView` 的 `selected` 布尔改为 `selected={selectedIds.includes(cell.id)}`，`primary` 单独传（决定 `borderLeft` 与工具条不透明度 `3778-3779`、`3821`） | 面板 state（`4115`） |
| 面板根节点无 `tabIndex`（`5320-5346`） | 根节点加 `tabIndex={-1}` + `data-nb2-mode={mode}`，让「命令态」有可聚焦宿主；CSS 按 `[data-nb2-mode=command] .nb2-cell` 画选中框（Jupyter 的灰底蓝左条） | `5320-5346` |
| `focusMode`（`3551`）三态：editor/container/output | 保留，但**不要**直接当命令态用：它是 per-cell 的焦点标记，`data-nb2-mode` 才是面板级。映射：`focusMode==="editor"` ⇒ `mode="editor"`，`focusMode==="container"` ⇒ `mode="command"`（面板在 `onFocus`/`onEscape` 里同步，`3754-3757`、`3736-3741`） | `3551`、`3736-3741` |

### 5.2 分派优先级（三处 handler 的正确姿势）

现在有 3 层，**建议不要新增第 4 层**，而是把「非 Enter 键」塞进已有的纯函数：

```
命中 .cm-editor          → CM keymap（一切放行；E10-E15 已覆盖 Ctrl-/、Ctrl-] 等）
焦点在 input/textarea/select → 放行（isTextEntryTarget，824-837）
浮层开着（picker/AI/大纲/选区条/搜索面板）
                         → 浮层自己的 window capture 先处理并 stopPropagation
面板内其它落点            → onPanelKeyDownCapture（4312）→ decideCellKey 扩展
焦点掉到 <body>           → W1 document 兜底（4506-4532），复用同一判定
```

具体改法（最小改动、可测）：

1. **扩展现有纯函数，而不是新写一个**：把 `decideCellKey(state)`（`782-801`）改名为 `decidePanelKey(state)`，返回枚举从 4 个值扩到
   `"pass" | "run-below" | "run-stay" | "run-insert-below" | "insert-above" | "insert-below" | "delete" | "undo-delete" | "to-code" | "to-markdown" | "to-raw" | "select-prev" | "select-next" | "extend-prev" | "extend-next" | "select-all" | "save" | "join-prev" | "join-next" | "enter-edit" | "escape"`。
   - **保留** `key !== "Enter"` 这条对 Enter 家族的早退，但在其后加「命令态单字母/组合键」分支；
   - 单字母只在 `mode === "command"` 且 `!inEditor && !inInput` 时生效（这就是 §4.2 `:110` 那条约定的延伸，不违背它——那条约定针对 Enter，且单字母必须显式加 mode 闸门）。
2. **`DD` 前缀状态放 React 状态**，不放纯函数里：`lastKeyRef`（`{key, at}`），判定函数只收 `{key, prevKey, prevKeyAgeMs}` 这种可测入参（与 `pickerKeyAction` 的写法一致，`1769-1784`）。
3. **`Ctrl-S` / `Ctrl-A` / `Ctrl-F` 必须走 `e.preventDefault()`**：它们默认归浏览器（§4.1）。放在 `onPanelKeyDownCapture` 最前面（在 `decideCellKey` 之前），并且同样复制到 W1 兜底（`4521-4529` 的判定里目前只放行 `Enter`，要改成「Enter 家族 + 这 3 个组合键」）。
4. **CM 侧只加两条**（其余一律不加，避免和 CM 内建键位打架）：
   - `Ctrl-D` = 删除整行：**必须放在 `...CM.searchKeymap` 之前**（现在数组在 `2587-2627`，把新条目插在 `2596` 的 Tab 之后即可），否则被 `selectNextOccurrence` 吃掉；
   - 若要做「行号开关」，用 `CM.Compartment`（vendor 已导出，`scripts/cm-entry.js:7`）包住 `CM.lineNumbers()`（`2560`）。
5. **不要动 E2/E3/E5 的顺序与其 3 处 handler**——`test/client-logic.mjs:404-417`、`800-838` 有「Shift-Enter 必须早于普通 Enter」「不发明 Ctrl-Shift-Enter」的回归断言，动了必红。

### 5.3 逐条落点

| 功能 | 加在哪 | 用什么模式 |
|---|---|---|
| mode 状态 + `data-nb2-mode` | 面板 state（`4115` 一带）+ 根节点属性（`5320-5346`） | React state；`CellView` 通过 props 拿 |
| `A`/`B` | `addCell` 调用处（`4229-4252`）+ 分派器 | `A` 用 `{index: idx}`；`B` 用 `{after: id}`；均 `run=false` |
| `DD`/`Z` | 新增 `deleteCellWithUndo`（包住 `5796-5803` 与 `5444`）+ 客户端 undo 栈 `undoRef` | 纯函数算「回插位置」，IO 在组件层 |
| `Y`/`M`/`R` | 直接调 `changeType`（`4167-4178`） | 零新增 IO |
| `Ctrl-A`/`Shift-↑↓` | 分派器 + `selectedIds`；`onSelectSibling`（`5778-5781`）加 `extend` 参数 | 纯函数 `extendSelection(ids, anchor, nextId)` |
| `Ctrl-S` | `onPanelKeyDownCapture`（`4312`）+ W1（`4521`） | `preventDefault` + 调 `save`（`4254-4261`） |
| `F`/`Ctrl-F` 整本查找 | 新浮层（照 picker 的 `data-nb2-picker` 约定） | 客户端过滤 `cells[].source`；跳转用 `focusCell`（`4126`）+ `api.setCursorLine`（`3663`） |
| `O` 输出折叠 | `OutputBlockView` 签名（`3092`）+ `CellView` 传 `collapsed` | `useState` 按 cellId 存；`foldDecision`（已在 internals，`5985`）不动 |
| `L` 行号 | `buildExtensions`（`2560`） | `Compartment` + `reconfigure` |
| `H` 帮助面板 | 新浮层 | 静态表；键位表**从 `__internals` 导出**供测试断言（与 `pickerKeyAction` 同思路） |
| `I I`/`0 0` | 分派器 → `kernelAction`（`4263-4273`） | 两段式前缀键，复用 `DD` 的状态机 |

### 5.4 需要后端（宿主半）配合的

| 能力 | 为什么绕不过后端 | 建议端点 |
|---|---|---|
| `Shift-M` 合并 | 拼 source + 删格必须**原子**；客户端两步会在中途失败时丢内容（`cell/edit` 成功、`cell/delete` 失败 ⇒ 内容重复） | `POST /nb2/cell/merge {sid, cellIds:[a,b]}` |
| `Ctrl-Shift-Minus` 拆分 | 同上（前半写回 + 后半建格） | `POST /nb2/cell/split {sid, cellId, atLine}` |
| `Z` 撤销删格（**若要恢复输出**） | `cell/add` 只收 `source/cellType`，不收 outputs；`cell/restore` 才能把 outputs 一起回填 | `POST /nb2/cell/restore {sid, cell, index}` |
| `Alt-↑/↓` 内核历史 | 需要 sidecar 侧 `history_request`；当前 `docs/api-nb2.md` 无此路由 | `GET /nb2/history?sid=&cellId=` |
| 运行并「选中」下一格（严格 Jupyter 语义，**不需后端，列此以便对照**） | 不需要后端，但要改 `nextRunTarget`（`810-821`）返回 `{kind:"select"}` 而非一律 `focus` | 纯客户端 |

> `A`/`B`/`Y`/`M`/`R`/`Ctrl-S`/`Ctrl-A`/`DD`（不含 `Z` 的输出恢复）/`F`/`O`/`L` **都不需要后端**——`cell/add` 已支持 `after` 与 `index`（`4225-4226`、`docs/api-nb2.md:186`），`cell/edit` 已支持 `cellType`（`docs/api-nb2.md:186`）。

### 5.5 测试落点（否则改了也测不到）

- `test/client-logic.mjs` 已按「源码文本断言 + 纯函数矩阵」两条腿走：`404-417`、`800-838` 断言 Enter 分支顺序；`578-621` 是 `decideCellKey` 矩阵。新增键位**必须**同时补：
  1. 纯函数矩阵（`decidePanelKey` 的每个返回值至少 1 条）；
  2. 源码顺序断言（例如「`Ctrl-D` 必须排在 `...CM.searchKeymap` 之前」，可直接正则 `indexOf`）；
  3. `__internals` 导出（`5985-6079` 那段列表里加）。
- ⚠️ React 桩测不到焦点/真实按键（记忆与 `docs/plans/...:228` 都写明），所以**不要**指望组件级测试覆盖命令态选中；用纯函数 + 真机手测（`node test/all.mjs` + 刷新页面）。

---

## 6. 不确定性 / 未验证项

1. **逐条键位缺一份「官方全表」**：JupyterLab / Notebook 官方文档只列 essential，并让你在应用内 **Help → Keyboard Shortcuts** 看全表；`Ctrl-S`、`Shift-M`、`Ctrl-Shift-Minus`、`Z`、`DD`、`O`、`L`、`H`、`1–6` 等逐条键位我依据的是社区教程 T1（<https://jupyter-tutorial.readthedocs.io/en/24.1.0/notebook/shortcuts.html>）＋ 对 JupyterLab 默认键位的通识核对。**标 `T1*` 的行建议在真实 JupyterLab 里按一次确认**（尤其 `Ctrl-Shift-Minus` 与 `Ctrl-Shift-P`）。
2. **`Ctrl-Shift-C` 的官方地位**：L2（`commands.html`）确认「命令面板 = Command/Ctrl Shift C」，但该页是 4.x 文档的搜索摘要口径；**不同大版本可能只有 `Ctrl-Shift-P`**。做命令面板前请先定键位再写文档。
3. **DSH 宿主壳是否有全局快捷键**：本轮只静态确认「仓库内其它插件没有 window capture 的 keydown 抢占」（只有 `dsh-notebook-v2` 5 处 + `dsh-autoresearch:778` 非 capture）；`app.asar` 内的 `dsh-client-*` 未静态核对。**验证办法**：打开 GUI，在 notebook 面板外按 `Ctrl-S` / `Ctrl-A` / `Ctrl-Shift-C`，看是否被宿主先处理；再在面板内重复一次。
4. **CM vendor 的符号级事实只能按字符串推断**：`lib/cm-vendor.js` 是 esbuild 压缩产物（单行 208 KB），函数名已重命名 → 我确认的是**键位字符串**存在：`"Mod-/"`、`"Mod-]"`、`"Shift-Mod-k"`、`"Mod-Enter"`、`"Mod-f"`、`"Mod-d"` 各 1 处。由此推断 `Ctrl-/`（注释）、`Ctrl-]`（缩进）、`Shift-Ctrl-K`（删行）、`Mod-Enter`（CM 的 insertBlankLine）、`Mod-f`（搜索）、`Mod-d`（selectNextOccurrence）均在 bundle 里；**具体归属哪个 keymap 未逐字验证**（`toggleComment`/`deleteLine`/`selectNextOccurrence` 三个符号名在压缩后已消失，grep 计数为 0）。
5. **`Ctrl-/` 是否真的能注释 Python**：`toggleComment` 依赖语言包提供 `commentTokens`；插件只装了 `@codemirror/lang-python`，理论上提供 `#`。**未真机验证**（建议手测：编辑器内 `Ctrl-/`）。
6. **多选模型的工作量未评估**：`selected` 从单值→数组会波及 `CellDivider`、大纲跳转、AI 条的 cellId 归属、`focusReq` 单槽（`4126-4131`）等；本轮只做了「影响面清单」，没做行级改造方案。
7. **`O`/`Shift-O` 的现状判断**：我确认 `OutputBlockView` 只接 `{block, CM, onFixError, onCiteError}`（`3092`），因此**没有**按格的输出折叠；但「输出是否已按 MIME/长度做过折叠」有内部 `foldDecision`（`5985`，判定逻辑在 `1329` 附近），这属于「渲染裁剪」而非用户可切换的显隐——两者别混为一谈。
8. **`Delete` 删格的有意/无意**：README 把它写进「容器态键盘」（`README.md:34`），说明是**有意设计**；但它与 Jupyter 的 `DD` 并存会让「误删」概率翻倍，是否保留需要产品决策（见 §4.3）。
9. **未验证「跑完进编辑」是否会影响 `Ctrl-Enter` 连跑**：`focusCell` 会触发 `focusReq`（`4126-4131`）→ `CellView` 进编辑态（`3677-3692`）；连续按 `Ctrl-Enter` 时第二次按键落在编辑器里，会走 CM keymap 的 `Ctrl-Enter`（`2598`，同样是 `onRun`）——行为等价，但**焦点态和「命令态」预期不一致**，命令模式上线后需要重新定义。

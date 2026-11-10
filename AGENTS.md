# AGENTS.md

给**改这个仓库的人 / AI** 看的实现笔记。用户向的说明在 [`README.md`](README.md)。

- 目标运行时：**DSH Desktop 0.2.1-rc.5**（客户端插件接口走 rc.x 那一版）
- 端点契约：[`docs/api-nb2.md`](docs/api-nb2.md) · sidecar 协议：[`docs/protocol-ndjson.md`](docs/protocol-ndjson.md)
- 计划：[需求统一整理与实施计划](docs/plans/2026-11-04-需求统一整理与实施计划.md) · [体验修复 v6](docs/plans/2026-11-04-体验修复v6-计划.md)

## 文件

```
package.json          dsh.bundle.patch + dsh.client（platform:web, inject: sidebar-right）
cordis.patch.yml      bundle patch：entry + config（enabled/token/python/cwd/eager/ai）
lib/index.js          会话装配、HTTP 路由、SSE、AI 流式端点、工具注册
lib/events.js         事件总线（seq + 回放日志 + 游标）
lib/notebook.js       纯模型：cells / 输出块合并 / 状态机 / 队列 / 执行历史
lib/ipynb.js          .ipynb 语义等价读写
lib/sidecar.js        NDJSON 客户端：握手 / 心跳 / 重启预算 / 树杀
lib/python.js         解释器与内核发现（envsel → conda → PATH）+ 诊断
lib/ai.js             LLM 桥：提示词、chunk 解析、流式转发、错误映射
lib/tools.js          nb_* 工具全集
lib/client.js         客户端：工具栏、CM6、输出渲染、标签条、AI 内联条、行级 diff（单文件 CJS 工厂）
lib/cm-vendor.js      CM6 + KaTeX 的 IIFE 包（构建产物，已提交，使用者无需构建）
python/kernel_driver.py   sidecar：NDJSON over stdio + jupyter_client 事件泵
docs/api-nb2.md       /nb2 端点契约
docs/protocol-ndjson.md  sidecar 协议
scripts/{install,uninstall,retire-old-plugin,build-cm-vendor}.mjs, scripts/cm-entry.js
test/{all,smoke,model,python,python-envsel,ai,ai-http,vars,client-logic,smoke-client,kernel,real-app}.mjs
```

## 跑测试

```bash
node test/all.mjs        # 全部套件（含真 ipykernel 端到端）
node test/all.mjs --fast # 跳过真内核
NB2_BASE=http://127.0.0.1:<port> node test/real-app.mjs   # 对运行中的应用做真机验收
```

| 套件 | 验什么 |
|---|---|
| `smoke.mjs` | `/nb2` 路由、**SSE 真流式**（多 chunk + 时间跨度）、seq 单调、`after`/`Last-Event-ID` 续传、会话隔离、vendor 可下载、state/tabs、AI 路由接线（无 llm 时 `E_NO_LLM`） |
| `model.mjs` | stream 复用输出块、display update 替换、状态机越界忽略、迟到尾包窗口、队列去重/遇错停止/`raises-exception`、执行历史上限、`.ipynb` 深比较往返 |
| `python.mjs` | 内核扫描、envsel 读取与**父会话继承**、解析优先级、诊断清单、**解析出的解释器真能 import ipykernel** |
| `python-envsel.mjs` | **envsel 选了没装 ipykernel 的环境时必须降级**（否则复现 `No module named 'ipykernel'`） |
| `ai.mjs` | chunk 形状解析、终态判定、提示词组装、target 解析、流式转发、错误码映射、**取消不写成成功** |
| `ai-http.mjs` | AI 流式的 HTTP 层：假 llm + 真 HTTP，断言 delta 落在多个独立 chunk、首字延迟远小于总时长 |
| `client-logic.mjs` | MIME 优先级、折叠判定、事件归约、markdown/JSON/KaTeX、**键位表**、主题走 DSH 令牌（且不再用 oneDark）、行级 diff、大纲宽度与 md 标题折叠 |
| `smoke-client.mjs` | 客户端注册契约（行 id、静态 inject、两阶段注册、disposer） |
| `kernel.mjs` | 真 ipykernel 端到端：多行分批到达、结果/错误分块、一万行 1 块、中断收敛、重启三语义、变量跨格、多标签、`nb_*` 工具调用 |
| `real-app.mjs`（可选） | 打运行中的应用：健康、解释器来源=conda、python 是装 ipykernel 的环境、execCount、两行输出分两次到达、结果块 |

纯逻辑一律通过 `module.exports.__internals` 暴露给 Node 测试（客户端半是单文件 CJS 工厂，不能 import 兄弟文件）。

## 内核解释器是怎么选的（第一次真机崩溃的根因）

真机曾报 `SidecarError: No module named 'ipykernel'`。原因：**`DSH_ENV_PYTHON` / `DSH_PYTHON`
只存在于 shell 调用的环境里**，harness 不会写进插件进程；插件里读 `process.env` 看不到用户在
python-env 插件里选的那个解释器，于是回落到 PATH 上的系统 python（没装 ipykernel）。

现在的解析链（`lib/python.js`）：

1. 工具栏里显式选的内核（会话级）
2. `config.python`
3. **envsel 存储** `~/.dsh/envsel-state.json`（`{version:1, selections:{sessionId:{python:{...}}}}`），
   并**沿父会话继承**（子代理通常自己没有选择）
4. conda 环境扫描（`~/.conda/environments.txt` → `~/.conda/envs` → 常见安装位置），挑第一个**真装了 ipykernel** 的
5. 最后才回落 PATH（诊断里会明确标注）

排障：`curl http://127.0.0.1:<port>/nb2/diagnostics` 会列出「envsel 路径/选择、候选内核及 hasIpykernel、
`DSH_ENV_PYTHON` 等 env 快照、以及怎么修」。

## 关键实现约定（踩过的坑，别改）

- **协议两端必须强制 UTF-8，绝不能吃系统代码页**（2026-11-10 真机事故，用户报「点了运行，
  代码没运行」）：Windows 下 `python -u` 从管道拿到的 stdio 是 **cp936/GBK**，宿主写的是
  UTF-8。于是 ① 中文源码被 GBK + `surrogateescape` 解坏，进内核变成 U+FFFD →
  `SyntaxError: invalid character`（中文一旦出现在关键字参数、变量名这类语法位置就必炸；
  在字符串里则静默变成乱码输出）；② 含 U+FFFD 的报错帧 GBK 编不出来，`Emitter` 原来
  `except → os._exit(1)`，**内核进程当场被打死**；③ 宿主只看到 sidecar 退出、自动重启，
  没人收尾 → UI 上「内核 idle + 零输出 + 零报错 + 那格一直转」。修法是三处一起：
  `kernel_driver.force_utf8_stdio()`（stdin `replace` / stdout `backslashreplace`）、
  `sidecar.spawn(env: PYTHONIOENCODING/PYTHONUTF8)`、`Emitter._write` 只对**管道断**才退出。
  回归用例：`test/kernel.mjs` 的「中文关键字参数不报语法错误」。
- **内核进程死了，正在跑的那一格必须当场收尾**（同一事故的第二个 bug）：
  `_onExit` 只重启不收敛 = 那格永远 `running`，`pump()` 的闸门永久关闭，后面每格都排队不动。
  `index.js` 里 `abortInflight()` 专门干这件事：先确保落在 `running`（状态机只允许
  `running → error`），再 `error` → `cell.done`，并把队列清成 idle + 把驱动 stderr 塞进
  `KernelDied` 的 evalue（那是用户唯一能看到的「为什么」）。
- **`inflight` 是闸门，必须处处有出清路径**：它记录「已 post execute、还没等到
  `cell.started`」的格。中断/丢帧会让这个格**永远收不到任何事件** → `pump()` 永久 return
  → 「点运行没反应且不报错」。现在四处清：`cell.started`、`cell.done`、`interrupt()`、
  `abortInflight()`，外加 `KERNEL_START_TIMEOUT_MS`（15s）兜底成 `KernelTimeout`。
- **崩溃后重新起内核要走 `sidecar.whenAlive()`，不能直接 `ensureSidecar()` 再 spawn**：
  `sidecarReady` 缓存的是一个**已经 resolve 过的死实例**，照旧返回会让 pump 无限重试
  （CPU 打满、界面卡死）。`whenAlive()` 分三种：活着给自己、重启中给那次重启的 promise、
  彻底没了给 null（宿主据此重建）。
- **Windows 上 ipykernel 的「中断」可能根本不生效**（2026-11-10 实测：ipykernel 7.2.0 +
  jupyter_client 8.8.0，`km.interrupt_kernel()` 与直接 `SetEvent(win32_interrupt_event)`
  都对 `time.sleep(20)` 无效）。所以 `KernelRunner.interrupt()` 做两级：先请求，1.5s 观察窗
  （期间必须自己 `pump()`，否则 live_cells 永远不清空）内没收敛就降级成**重启内核**，
  日志写明变量会丢。宁可重来，也不要留一个「看起来取消了、其实还在跑」的内核。
- **运行状态必须有可判读的显示**（用户 2026-11-10：「代码运行的时候我不知道有没有运行」）：
  左槽 `◐` 用 CSS 转 + 黄条 + 淡黄底，外加「已跑 N 秒」；工具栏第三行最左是
  「运行中 · 第 N 格 · 12s · 队列 2 / 空闲」。计时起点是**服务端**写进 `cell.startedAt`
  的时间戳（`cell.started` 的 `at`），不是客户端 `Date.now()` —— 右栏切走/重连会重新拉
  `/nb2/state`，本地时间戳一刷新计时器就倒退。

- **快捷键只认「命令注册表 + 键位表」，不要在 UI 里另写闭包**（2026-11-04 重构，用户提议）：
  `COMMANDS`（命令 id → label/hint）、`KEYBINDINGS`（键 → 命令 id）、`commandsRef.current`
  （命令 id → 执行体，每帧重建）三层。右键菜单/快捷键都从这三张表取，所以不会出现
  「菜单能点、快捷键没接」。**加动作 = 两处各加一条；加快捷键 = 只改 KEYBINDINGS**；
  测试会断言「每个面板命令都有执行体」与「同 context 无重复键位」。
  细节见 `docs/plans/2026-11-04-需求统一整理与实施计划.md` 第十节。
- **执行表不要写进 `useMemo` 依赖数组**：它引用了后面才声明的符号（`moveCellTo`/`mergeBelow`/
  `citeCellRef`），依赖数组在渲染期求值 → 必 TDZ 崩（本仓库踩过 3 次：`citeCell`、`cells`、`deleteCells`）。
  用 `commandsRef.current = {...}` 每帧重赋值，或改用 `state.xxx`。
- **组件必须定义在模块级**：写进 `NotebookV2Panel` 函数体的子组件每次渲染都是新身份 →
  React 卸载重挂子树 → 子组件 state（拖拽中、折叠开合）全归零。大纲停靠栏就是踩过才搬出去的。
- **宿主 `webServer` 的 handler 只给 `(req, res)`**，没有第三个 `url` 参数；URL 必须自己
  `new URL(req.url, "http://localhost")` 解析。**测试脚手架也要按这个契约调用**——曾经测试多传一个
  参数把 bug 掩盖了，真机每个请求都在第一行抛 `Cannot read properties of undefined (reading 'pathname')`。
- **宿主半不是热加载**：改 `lib/*.js` 必须重启应用；用 `curl /nb2/health` 可判断跑的是新码还是旧码。
- **客户端插件必须用静态 `inject: [...]`**（门面不提供 `ctx.inject`）。
- **右栏 tab 两阶段注册**：`sidebarRightTabs.register({id,kind,title,guide})` →
  `slots.register({name:'sidebar.right.pane.tab', key:id}, Body)`，`key` 必须等于 `id`。
- **SSE / NDJSON 流都要发**：`Cache-Control: …no-transform` + `X-Accel-Buffering: no` + `res.flushHeaders()`。
- **重连要认两个游标**：`?after=` 与 `Last-Event-ID` 取最大。
- **ipykernel 的 `OutStream.flush_interval` 默认 0.2s**：不改它输出就是每 200ms 跳一批（sidecar 的 `_bootstrap` 改成 0.02s）。
- **非 stream 输出前必须 flush 该 cell 的 stream 缓冲**，否则 UI 上「结果先出现、打印后出现」。
- **重跑一个 cell 必须先清空它上一轮的输出**：宿主 `notebook._onStarted` 与客户端
  `reduceEvent` 的 `cell.started` **两处都要清**（`lastStream` 一起清）。这是 Jupyter / VS Code
  的语义；不清的话每跑一次就把新输出接在旧输出后面，用户看到同一格三四份重复的 DataFrame
  和 print。客户端那份是「只靠 SSE 更新的本地快照」，只改宿主的话得刷新页面才恢复。
- **HTML 输出走沙箱 iframe，宿主的 CSS 变量进不去**：`body{color:inherit}` 在 iframe 里等于
  取初始值（深色主题下就是黑字压深底，等于看不见）。所以 srcdoc 里要写**算好的具体前景色**
  （`getComputedStyle(document.body).color`），派生色一律
  `color-mix(in srgb, currentColor N%, transparent)`，明暗两套主题自动跟随。
- **表格样式照 JupyterLab 的 `.jp-RenderedHTMLCommon table`**：无竖线、表头只有一条下横线、
  `tbody tr` 斑马纹 + hover、数值右对齐、`font-variant-numeric: tabular-nums`。pandas 的
  `_repr_html_` 自带 `<table border="1">`（浏览器按属性画粗黑网格）和 `<style scoped>`
  （`.dataframe thead th{text-align:right}`），所以必须显式 `border:0`，且自定义规则的选择器
  要比它**更具体**（`table.dataframe thead th` 压 `.dataframe thead th`），否则对齐不受控。
- **stream / traceback 里的 ANSI 要解析成 span**（`parseAnsi` → `ansiNodes`；色板参考
  JupyterLab 的 `.ansi-*-fg`，但一律 `color-mix(..., currentColor)`，免得在另一套主题下
  变成隐形色）。折叠**前**先 `stripAnsi`，否则会切在转义序列中间，屏幕上留下 `[31` 残渣。
- **MIME 优先级表里只放真有渲染分支的 mime**：放了 `application/vnd.jupyter.widget-view+json`
  这类没有渲染器的项，`pickMime` 选中后会掉进纯文本兜底，用户看到的是一大坨 JSON（图没了）。
- **版本号只有一个来源：`package.json`**。`/nb2/health` 的 `version` 从它读（`PKG_VERSION`），
  README 徽章与 `docs/api-nb2.md` 的示例跟着改。曾经三处各写一份且互相矛盾
  （package.json 0.0.1 / health 0.1.0 / 文档 0.0.1），发版时对不上号。发版流程：改
  `package.json` → `CHANGELOG.md` 记一节 → 同步 README 徽章与 api 文档示例 → 跑测试
  （`test/smoke.mjs` 会断言 `health.version` 与 package.json 相等）。
  注意 `test/_load.mjs` 要把 `package.json` 一起复制到临时包目录，否则测试壳里 health 会
  走兜底返回 0.0.0。
- **另存为要迁移标签 key**，否则同一份 `.ipynb` 会被开出两个标签。
- **取消 AI 生成不能写成 done**，否则前端会把半截代码当成品。
- **ghost 的 `StateField.update` 必须先看 `tr.effects`，再看 `tr.docChanged`**：分级接受（按词 / 按行）
  的事务同时带 `changes`（插入这一小段）和 `setGhost`（剩余建议挪到新位置）。若先判 docChanged
  就 `return null`，剩下的建议被直接丢掉 —— 表现是「按词接受只吃一个词、后面全没」，而且**不报错**，
  只有真机连按两次才发现（`acceptWord` 就这样半残了很久）。正常打字的事务没有 effect，
  所以这个顺序调换不会让「一打字幽灵就作废」失效。
- **补全的缓存要做「最长前缀匹配」，不能只做精确匹配**：key 是 `pos\0doc` 的精确匹配只能救
  「退格又打回来」；用户**继续往下打**（`df.he` → `df.hea`）时文档已变，精确匹配必然落空，
  于是每多敲一个字都要重付一次网络往返。规则：`doc` 是缓存 key 的前缀、且用户多敲的字符
  正是缓存建议的开头 → 返回切掉已打部分的剩余建议（Continue `AutocompleteLruCache` 同款）。
- **补全的设置项（防抖 / 最大行数）必须 `getOptions()` 现读**：CM 编辑器只在挂载时建一次扩展，
  把值闭包进 `buildGhostExtension` 就变成「改设置要刷新页面才生效」（用户明确要求改完立即生效）。
- CM 主题只写 `var(--dsw-alias-*)`，**不要**引入 oneDark 这类硬编码主题。
- **浮层的退出不能只靠浮层自己的 `onKeyDown`**：picker 的目录行是普通 `div`（不可聚焦），
  点一下焦点就掉到 `<body>`，此后浮层根节点收不到任何按键 —— 用户看到的就是「钻了目录之后 Esc 关不掉」。
  必须在 `window` capture 阶段兜底，并给浮层加 `data-nb2-picker="1"` 供「点击外部关闭」判定、
  给触发按钮加 `data-nb2-picker-anchor="1"` 豁免（否则 mousedown 关、click 又开，表现为闪一下）。
  同类浮层（大纲、AI 条、`⋯` 菜单）照此办理。
- **面板级键盘分发要补一层 document 级兜底**：`onKeyDownCapture` 只在事件落点在面板内时触发。
  点面板空白/输出区/工具栏文字都会让焦点掉到 `<body>`，于是 Shift-Enter「按了没反应」。
  兜底必须同时满足三条：① 最近一次 `mousedown` 在面板内（否则会抢左侧对话的键）；
  ② 事件落点不在面板内（否则与面板内分发重复执行、一次按键跑两遍格）；
  ③ 面板在屏幕上（`getBoundingClientRect` 非零，防止右栏切走后后台抢键）。
- **对话投递走 slot props 的 `inputActions`（2026-11-06 实测修正）**：
  `props.inputActions.captureInsertion()` 给 `{start,end,draftRev}`，`insertText(text, span)`
  真的把字插进 Lexical 编辑器；被拒（rev 竞态）重试一次。**本版没有 `conversation` 这个
  client service**，`ctx.get("conversation")` 恒为 undefined —— 老的「会话桥」永远拿不到，
  只保留作前向兼容。另外**必须** `ctx.get("sessions")`，写 `ctx.sessions` 会被门面抛异常
  （未在静态 `inject` 里声明）。失败提示必须分层写明断在哪一层
  （`no-actions` / `no-insertText`（带实际方法清单）/ `insertText-refused` / 剪贴板）。
  细节见 `docs/research/2026-11-06-chat-delivery-实测.md`。
- **需要项目上下文的改写一律走「交给对话」而不是内联 AI**：内联 AI 只看得到本格 + 邻格 +
  变量/报错摘要。`buildChatPrompt()` 把位置 / 代码 / 上下文 / 要求 / `nb_*` 动手方式拼成
  提示词投进主对话，由有完整工作区的 agent 去改（用户 2026-11-06 的明确要求）。
  入口三个：AI 条「💬 交给对话」/ 选区条「💬 在对话里改」/ 右键「💬 让对话改本格」。

## 重新打 CM6 vendor

`lib/cm-vendor.js`（~700KB，含 KaTeX）已提交，用户无需构建。改依赖或升级 CM6 时：

```bash
node scripts/build-cm-vendor.mjs
```

它在 profile 下的临时目录里跑 esbuild（这样能解析到 profile `node_modules` 里的 `@codemirror/*`）。
**注意**：DSH 自己把 `DSH_PROFILE` 设成**档案名**（`desktop`），不是路径；脚本用 `--profile` / `DSH_PROFILE_DIR`。

## 工具与第三方插件的冲突

`nb_*` 工具名与第三方插件 `@beihaizb/dsh-notebook` **完全相同**（那是另一份独立实现，本仓库不依赖它、
也没有它的代码）。两者同时启用会重复注册同名工具，profile 里只应启用一个。
`scripts/retire-old-plugin.mjs` 只改 profile 的加载列表，不动对方文件与任何 `.ipynb`。

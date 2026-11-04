# dsh-notebook-v2

自研 Jupyter 前端（DSH 插件）：右栏里一个真正的 notebook —— 常驻内核、**流式输出**、多标签、
`.ipynb` 语义等价读写、**内联 AI 建议**。已替代旧插件 `@beihaizb/dsh-notebook`（可从备份一键回滚）。

- 目标运行时：**DSH Desktop 0.2.1-rc.5**
- 计划 / 决策：`docs/plans/2026-11-03-dsh-notebook-v2-自研迭代计划.md`（§12 实施进度）
- 评审结论：`docs/plans/2026-11-03-dsh-notebook-v2-评审结论.md`
- 规格：[`docs/api-nb2.md`](docs/api-nb2.md)（端点契约）、[`docs/protocol-ndjson.md`](docs/protocol-ndjson.md)（sidecar 协议）

## 能做什么

**工具栏（带文字标签，对齐旧插件那条工具条）**

| 行 | 内容 |
|---|---|
| 1 | 同步状态点 · notebook 标题 · `未保存 ●` · 保存 · 另存为 |
| 2 | ▶ 运行全部 · ■ 中断 · ↻ 重启 · ↻ 重启并清空 · 清空输出 · ＋ 代码 · ＋ MD · ＋ SH · ✕ 删除 · ≡ 大纲 · AI 补全 |
| 3 | `内核 idle` 状态点 · **内核下拉（conda 环境，缺 ipykernel 的禁选）** · 📁 工作目录（点击修改） |
| 标签条 | 多 notebook 标签 · ＋打开（内联路径输入） · ＋新建 |

**单元格类型**：`代码` / `Markdown` / `Shell` / `Raw`（每格左侧下拉切换）。
Markdown 默认渲染、点一下进编辑；Shell 走**独立子进程**（`cmd` / `bash` / `pwsh` 自动选，不需要 Python 内核也能跑）。
`.ipynb` 里 Shell 格就是标准 Jupyter 写法「带 `%%bash` 魔法行的 code 格」，在 JupyterLab / VS Code 里仍合法。

**大纲（TOC）**：`≡ 大纲` 展开，列 markdown 标题（按级别缩进，代码块里的 `#` 不算标题）+ 每格首行，点击滚动到该格。
大纲栏**宽度可拖**：拖它内侧那条边缘（右停靠拖左边缘、左停靠拖右边缘）→ 实时变宽变窄，
松手即记忆（`nb2.outlineWidth.v1`）；双击分隔条复位 200px，聚焦分隔条后 `←/→` 微调 16px。
宽度上限跟着宿主走（至少给正文留 180px），所以右栏拉窄时不会把单元格挤没。

**md 标题折叠**（对齐 VS Code Notebook 的章节折叠）：markdown 格里**首个非空行是标题**（`#`…`######`，
或 setext 的 `===`/`---`）的格，左侧槽位会出现 `▾`。折起来后，它下面直到**下一个同级或更高级标题**
之前的格全部隐藏，原地留一条 `⋯ 已折叠 N 格 · 点击展开` 的占位。
标题格自己永远可见；嵌套按层级算（折 `#` 时里面的 `##` 一并收起，但各自折叠状态保留，展开外层即恢复）。
大纲里点到被折叠的格会自动展开那一节 —— 否则点下去像没反应。折叠状态不落盘（重开 notebook 是展开的）。

**AI 自动补全（ghost text）**：`AI 补全` 开关（**默认关**，会消耗 token）。
停止输入 ~0.5s 后在光标处出现灰色续写建议 → `Tab` 接受 / `Esc` 丢弃；一打字即作废。
后端是独立提示词（只续写光标处那一小段，不是整格重写），超时/失败一律静默不打扰。

**编辑手感**：CodeMirror 6（查找/折叠/多光标/括号匹配/补全/撤销历史）。
`Shift-Enter` 运行并下移 · `Ctrl(-Alt)-Enter` 运行 · `Alt-Enter` 运行并插格 · `Mod-F` 查找 · `Mod-S` 保存 · **`Mod-K` 内联 AI** · `Tab` 接受补全。
容器态键盘：`Enter` 进格、`↑↓` 选格、`Delete` 删格、`Esc` 退出编辑。

**AI 内联建议（Mod-K）**
指令 → 逐 token 流式 → **行级 diff** 评审（`+N −M` 统计）→ `接受 (Mod-↵)` / `接受并运行` / `重试` / `拒绝 (Esc)`。
后端走宿主 `ctx.llm.stream()`（POST + NDJSON 流），provider/model 来自 `config.ai`，留空则自动解析。

**配色**：CM 主题**全部使用 DSH 的 `--dsw-alias-*` CSS 变量**（不再硬编码 oneDark）——
明暗切换跟随软件、无需重建编辑器，不会出现「软件浅色、编辑器黑底」。

**输出**：`print` 一行一行往外冒（`print` 一万行只产生**一个**输出块）；
`text/html`（沙箱 iframe + 高度回传）、图片、`application/json` 折叠树、`text/latex`（KaTeX）、
markdown（表格/公式/代码块/引用）；超长输出「头 300 + 尾 100 + 展开」。

**内核**：常驻、变量跨格保留；Interrupt / Restart / RestartAndClear / RestartAndRunAll 四语义；
**内核下拉换 conda 环境**、**工作目录可改**（都会重启内核）。

**多 notebook**：同会话多标签，切换即切活动 notebook；重复打开同一路径只激活不重载。

**无损读写**：读入 → 写回**语义等价**（`attachments`、`metadata.widgets`、旧插件的 `metadata.dsh`、
以及不认识的字段全部原样保留）。

**不做**（v1 非目标）：ipywidgets 交互、调试器、远程/SLURM 内核、多人协作、Monaco 级类型检查。

## 安装 / 卸载 / 回滚

```bash
node dsh-notebook-v2/scripts/install.mjs   --dry-run   # 装进 profile（先看要改什么）
node dsh-notebook-v2/scripts/install.mjs

node dsh-notebook-v2/scripts/uninstall.mjs              # 从 profile 摘除（只删自己的痕迹）
node dsh-notebook-v2/scripts/retire-old-plugin.mjs      # 下线旧插件
node dsh-notebook-v2/scripts/retire-old-plugin.mjs --rollback   # 把旧插件装回加载列表
```

- 所有脚本幂等、支持 `--dry-run`、写前自动备份 profile `package.json`。
- **下线旧插件只动 profile 的 package.json**：`node_modules` 里的文件与任何 `.ipynb` 都不动 → 回滚一条命令。
- **改宿主半（`lib/*.js`）必须重启桌面版**（实测宿主半不是热加载）；只改客户端半通常重载窗口即可。
- 装/卸后必须重启，客户端 bundle 在启动时编进 boot graph。

## 内核解释器是怎么选的（第一次真机崩溃的根因）

真机曾报 `SidecarError: No module named 'ipykernel'`。原因：**`DSH_ENV_PYTHON` / `DSH_PYTHON`
只存在于 shell 调用的环境里**，harness 不会写进插件进程；插件里读 process.env 看不到用户在
python-env 插件里选的那个解释器，于是回落到 PATH 上的系统 python（没装 ipykernel）。

现在的解析链（`lib/python.js`）：

1. 工具栏里显式选的内核（会话级）
2. `config.python`
3. **envsel 存储** `~/.dsh/envsel-state.json`（`{version:1, selections:{sessionId:{python:{...}}}}`），
   并**沿父会话继承**（子代理通常自己没有选择）
4. conda 环境扫描（`~/.conda/environments.txt` → `~/.conda/envs` → 常见安装位置），挑第一个**真装了 ipykernel** 的
5. 最后才回落 PATH（诊断里会明确标注）

排障：`curl http://127.0.0.1:<port>/nb2/diagnostics` 会列出「envsel 路径/选择、候选内核及 hasIpykernel、
DSH_ENV_PYTHON 等 env 快照、以及怎么修」。

## 测试

```bash
node dsh-notebook-v2/test/all.mjs        # 9 个套件全跑（含真内核）
node dsh-notebook-v2/test/all.mjs --fast # 跳过真内核

# 可选：对着**正在运行的** DSH 应用做真机验收（不经过测试脚手架）
NB2_BASE=http://127.0.0.1:<port> node dsh-notebook-v2/test/real-app.mjs
```

| 套件 | 验什么 |
|---|---|
| `smoke.mjs` | `/nb2` 路由、**SSE 真流式**（多 chunk + 时间跨度）、seq 单调、`after`/`Last-Event-ID` 续传、会话隔离、vendor 可下载、state/tabs、AI 路由接线（无 llm 时 E_NO_LLM） |
| `model.mjs` | stream 复用输出块、display update 替换、状态机越界忽略、迟到尾包窗口、队列去重/遇错停止/`raises-exception`、执行历史上限、`.ipynb` 深比较往返 |
| `python.mjs` | 内核扫描、envsel 读取与**父会话继承**、解析优先级、诊断清单、**解析出的解释器真能 import ipykernel** |
| `python-envsel.mjs` | **envsel 选了没装 ipykernel 的环境时必须降级**（否则又复现原报错） |
| `ai.mjs` | chunk 形状解析、终态判定、提示词组装、target 解析、流式转发、错误码映射、**取消不写成成功** |
| `ai-http.mjs` | **AI 流式的 HTTP 层验收**：假 llm + 真 HTTP，断言 delta 落在多个独立 chunk、首字延迟远小于总时长 |
| `client-logic.mjs` | MIME 优先级、折叠判定、事件归约、markdown/JSON/KaTeX、**键位表**、**主题走 DSH 令牌（且不再用 oneDark）**、行级 diff |
| `smoke-client.mjs` | 客户端注册契约（行 id、静态 inject、两阶段注册、disposer） |
| `kernel.mjs` | 真 ipykernel 端到端：多行分批到达、结果/错误分块、一万行 1 块、中断收敛、重启三语义、变量跨格、多标签、`nb_*` 工具调用 |
| `real-app.mjs`（可选） | 打运行中的应用：健康、解释器来源=conda、python 是装 ipykernel 的环境、execCount、两行输出分两次到达、结果块 |

## agent 工具（与旧插件**同名**，既有提示词不用改）

| 工具 | 说明 |
|---|---|
| `nb_ping` / `nb_list` / `nb_get` | 连通性、标签与 cell 快照 |
| `nb_new` / `nb_open` / `nb_save` | 文件生命周期（`nb_open` 对已打开路径只激活） |
| `nb_add_cell` / `nb_edit_cell` / `nb_move_cell` / `nb_delete_cell` | 结构操作 |
| `nb_run_cell` / `nb_edit_and_run_cell` / `nb_run_all` | 执行 |
| `nb_kernel_list` / `nb_kernel_select` / `nb_kernel_interrupt` | 内核 |
| `nb_kernel_restart` / `nb_kernel_restart_and_clear` / `nb_kernel_restart_and_run_all` | 重启三语义 |
| `nb_set_cwd` / `nb_clear_outputs` | 环境 |
| `nb_list_vars` / `nb_inspect_object` | 走一次静默 execute 拿真实内核事实 |
| `nb_cell_history` / `nb_context` / `nb_error_context` | 历史与上下文 |
| `nb_apply_suggestion` | 走 `ctx.llm` 真流式改写并落盘（与内联 AI 同一条链路） |
| `nb_revert_cell` | **明确不支持**（v2 没有代码版本栈），返回说明而不是假装成功 |

> ⚠️ 新旧插件工具同名：**不要同时启用两个**（会重复注册同名工具）。回滚旧插件前先禁用 v2。

## 重新打 CM6 vendor

`lib/cm-vendor.js`（~700KB，含 KaTeX）已提交，用户无需构建。改依赖或升级 CM6 时：

```bash
node dsh-notebook-v2/scripts/build-cm-vendor.mjs
```

它在 profile 下的临时目录里跑 esbuild（这样能解析到 profile `node_modules` 里的 `@codemirror/*`）。
**注意**：DSH 自己把 `DSH_PROFILE` 设成**档案名**（`desktop`），不是路径；脚本用 `--profile` / `DSH_PROFILE_DIR`。

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
lib/tools.js          nb_* 工具全集（与旧插件同名）
lib/client.js         客户端：工具栏、CM6、输出渲染、标签条、AI 内联条、行级 diff
lib/cm-vendor.js      CM6 + KaTeX 的 IIFE 包（构建产物，已提交）
python/kernel_driver.py   sidecar：NDJSON over stdio + jupyter_client 事件泵
docs/api-nb2.md       /nb2 端点契约
docs/protocol-ndjson.md  sidecar 协议
scripts/{install,uninstall,retire-old-plugin,build-cm-vendor}.mjs, scripts/cm-entry.js
test/{all,smoke,model,python,ai,client-logic,smoke-client,kernel,_load}.mjs
```

## 关键实现约定（踩过的坑，别改）

- **快捷键只认「命令注册表 + 键位表」，不要在 UI 里另写闭包**（2026-11-04 重构，用户提议）：
  `COMMANDS`（命令 id → label/hint）、`KEYBINDINGS`（键 → 命令 id）、`commandsRef.current`
  （命令 id → 执行体，每帧重建）三层。右键菜单/快捷键都从这三张表取，所以不会出现
  「菜单能点、快捷键没接」。**加动作 = 两处各加一条；加快捷键 = 只改 KEYBINDINGS**；
  测试会断言「每个面板命令都有执行体」与「同 context 无重复键位」。
  细节见 `docs/plans/2026-11-04-需求统一整理与实施计划.md` 第十节。
- **执行表不要写进 `useMemo` 依赖数组**：它引用了后面才声明的符号（`moveCellTo`/`mergeBelow`/
  `citeCellRef`），依赖数组在渲染期求值 → 必 TDZ 崩（本仓库踩过 3 次：`citeCell`、`cells`、`deleteCells`）。
  用 `commandsRef.current = {...}` 每帧重赋值，或改用 `state.xxx`。
- **宿主 `webServer` 的 handler 只给 `(req, res)`**，没有第三个 `url` 参数；URL 必须自己
  `new URL(req.url, "http://localhost")` 解析。**测试脚手架也要按这个契约调用**——曾经测试多传一个
  参数把 bug 掩盖了，真机每个请求都在第一行抛 `Cannot read properties of undefined (reading 'pathname')`。
- **宿主半不是热加载**：改 `lib/*.js` 必须重启应用；用 `curl /nb2/health` 可判断跑的是新码还是旧码。
- **客户端插件必须用静态 `inject: [...]`**（门面不提供 `ctx.inject`）。
- **右栏 tab 两阶段注册**：`sidebarRightTabs.register({id,kind,title,guide})` → `slots.register({name:'sidebar.right.pane.tab', key:id}, Body)`，`key` 必须等于 `id`。
- **SSE / NDJSON 流都要发**：`Cache-Control: …no-transform` + `X-Accel-Buffering: no` + `res.flushHeaders()`。
- **重连要认两个游标**：`?after=` 与 `Last-Event-ID` 取最大。
- **ipykernel 的 `OutStream.flush_interval` 默认 0.2s**：不改它输出就是每 200ms 跳一批（sidecar 的 `_bootstrap` 改成 0.02s）。
- **非 stream 输出前必须 flush 该 cell 的 stream 缓冲**，否则 UI 上「结果先出现、打印后出现」。
- **另存为要迁移标签 key**，否则同一份 `.ipynb` 会被开出两个标签。
- **取消 AI 生成不能写成 done**，否则前端会把半截代码当成品。
- CM 主题只写 `var(--dsw-alias-*)`，**不要**引入 oneDark 这类硬编码主题。
- **浮层的退出不能只靠浮层自己的 `onKeyDown`**：picker 的目录行是普通 `div`（不可聚焦），
  点一下焦点就掉到 `<body>`，此后浮层根节点收不到任何按键 —— 用户看到的就是
  「钻了目录之后 Esc 关不掉」。必须在 `window` capture 阶段兜底，并给浮层加
  `data-nb2-picker="1"` 供「点击外部关闭」判定、给触发按钮加 `data-nb2-picker-anchor="1"`
  豁免（否则 mousedown 关、click 又开，表现为闪一下）。同类浮层（大纲、AI 条、`⋯` 菜单）照此办理。
- **面板级键盘分发要补一层 document 级兜底**：`onKeyDownCapture` 只在事件落点在面板内时触发。
  点面板空白/输出区/工具栏文字都会让焦点掉到 `<body>`，于是 Shift-Enter「按了没反应」。
  兜底必须同时满足三条：① 最近一次 `mousedown` 在面板内（否则会抢左侧对话的键）；
  ② 事件落点不在面板内（否则与面板内分发重复执行、一次按键跑两遍格）；
  ③ 面板在屏幕上（`getBoundingClientRect` 非零，防止右栏切走后后台抢键）。

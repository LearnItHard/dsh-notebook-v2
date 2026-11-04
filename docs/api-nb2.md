# nb2 端点契约（v1，M0 已实现）

> 状态：`/nb2/health`、`/nb2/events`、`/nb2/emit` **已实现并冒烟通过**（`test/smoke.mjs`）。
> `docs/plans/2026-11-03-dsh-notebook-v2-自研迭代计划.md` §4.2 只给了事件表；本文补它缺的
> **路径、方法、参数、回放语义、缓冲与鉴权**，M1 照此实现，不再改协议形状。

## 0. 传输选择

| 方向 | 方式 | 理由 |
|---|---|---|
| 下行（内核 → UI） | **SSE**（`GET /nb2/events`） | 单向推送足够；复用宿主已有 HTTP 端口，免握手/心跳/代理协商 |
| 上行（UI → 内核） | **普通 POST** | 可重试、可幂等、出错好排查；SSE 不能上行 |

宿主的 webServer 只绑 `127.0.0.1`（`dsh-host-webserver` 显式拒绝 wildcard host），
端口由宿主分配（`--port 0`），因此**不要硬编码端口**，客户端一律用同源相对路径 `/nb2/...`。

## 1. 端点一览

前缀 `/nb2`（`ctx.webServer.register({ kind:'prefix', path:'/nb2', handler })`）。

| 方法 | 路径 | 用途 | 返回 |
|---|---|---|---|
| GET | `/nb2/health` | 健康 + 会话总线概览 | JSON |
| GET | `/nb2/events?sid=&after=` | SSE 事件流 | `text/event-stream` |
| POST | `/nb2/emit` | M0 演示：按间隔推 N 条 stream 事件 | JSON |
| GET | `/nb2/state?sid=` | M1：当前快照（SSE 断开时的轮询降级） | JSON |
| POST | `/nb2/cell/{run,interrupt,restart,add,edit,delete}` | M1：上行命令 | JSON |

M0 只实现前三个；后两个是 M1 的形状，**路径与语义先定死**，实现时不许改名。

## 2. `GET /nb2/health`

```json
{
  "ok": true, "pkg": "dsh-notebook-v2", "version": "0.0.1",
  "uptimeMs": 12345, "logCap": 2000, "heartbeatMs": 15000,
  "sessions": [{ "sid": "...", "seq": 42, "minSeq": 1, "log": 42, "clients": 1 }]
}
```

用于排障第一问：**插件活着吗**（`ok`）、**事件在动吗**（`seq`）。

## 3. `GET /nb2/events`（SSE）

### 查询参数
- `sid`（必填，缺省 `default`）：会话隔离键。**会话级隔离，不跨会话串台**（冒烟已验）。
- `after`（可选，缺省 0）：只回放 `seq > after` 的事件。`0` = 全量回放（日志窗口内）。

### 请求头
- `Last-Event-ID`：EventSource 自动重连时浏览器**不再拼 query**，改带这个头。
  服务端取 `max(after, Last-Event-ID)` 作为游标。**两条都要认**，否则重连会重放。

### 响应头（缺一不可）
```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-store, no-transform   ← no-transform 是关键
Connection: keep-alive
X-Accel-Buffering: no
```
`no-transform` / `X-Accel-Buffering` 是防「被中间层攒成一次性响应」的两道保险；
宿主的 gzip 若对 `text/event-stream` 生效会导致**整条流被缓冲**，M1 接内核前必须用
`curl -N` 复核一次（`test/smoke.mjs` 已验证插件自身不缓冲，但宿主中间件不在它的覆盖内）。

### 帧格式
```
retry: 2000\n\n                                  ← 首帧，声明重连间隔
event: hello\ndata: {"sid","seq","minSeq"}\n\n   ← 连上即发，告知当前游标
event: nb\nid: 7\ndata: {"seq":7,"at":…,"ev":…}\n\n
event: resync\ndata: {"minSeq","seq"}\n\n         ← 游标已滚出日志窗口
: keep-alive\n\n                                 ← 注释帧，15s 一次
```

| 事件名 | 何时 | 客户端动作 |
|---|---|---|
| `hello` | 连接建立 | 记录基线 `seq`，状态置「已连」 |
| `nb` | 每条业务事件 | 按 `ev` 分派；**`id` 就是 `seq`**，浏览器自动记住用于重连 |
| `resync` | 请求的游标早于 `minSeq` | **清屏重建**（不是续传），然后从 `hello.seq` 继续 |
| `: keep-alive` | 空闲 15s | 忽略（SSE 注释帧，客户端不可见） |

### 回放窗口与溢出
- 每会话保留最近 **2000** 条（`LOG_CAP`）。超出后最旧滚出，`minSeq` 前移。
- 游标 `< minSeq` → 发 `resync`，客户端**必须清空本地状态**再按后续事件重建。
- 不返回 409：`resync` 比 HTTP 错误码更省一次往返，且 EventSource 对非 2xx 会停止重连。

### 断线降级
SSE 连续失败 → 客户端退化为 `2s` 轮询 `GET /nb2/state?sid=`，**UI 逻辑不变**
（事件适配层把快照 diff 成同样的事件序列）。这是计划 §4.2 已定的兜底策略。

## 4. `POST /nb2/emit`（M0 演示专用）

```jsonc
// 请求
{ "sid": "s1", "count": 10, "delayMs": 220 }
// 响应（立即返回，事件异步推）
{ "ok": true, "sid": "s1", "count": 10, "delayMs": 220, "outId": "demo-out-xxx" }
```
`count` 上限 200、`delayMs` 上限 2000。M1 之后保留它作调试口（不删，但 UI 不主推）。

## 5. 业务事件（`ev` 字段）

| `ev` | 载荷 | 语义 |
|---|---|---|
| `cell.queued` | `{cellId, at}` | 入队（VS Code 内部叫 Pending，对外用 queued 更直白） |
| `cell.started` | `{cellId, execCount, at}` | 开始执行；`execCount` 即 `In[n]` |
| `stream.append` | `{cellId, outId, name:'stdout'\|'stderr', text, seq}` | **增量追加文本**，不是替换 |
| `display.data` | `{cellId, outId, mime, data}` | 追加输出块（`data` 为 base64 或原文字符串） |
| `display.update` | `{cellId, outId, mime, data}` | **替换**同一 `outId`（对应 `update_display_data`） |
| `exec.result` | `{cellId, outId, data}` | 追加 result 块 |
| `error` | `{cellId, outId, ename, evalue, traceback}` | traceback 渲染 + 可点击跳格 |
| `cell.done` | `{cellId, status, durationMs}` | 收敛状态：`ok`/`error`/`cancelled` |
| `kernel.state` | `{state, pid?, name}` | `starting`/`idle`/`busy`/`dead`/`terminating` |
| `nb.updated` | `{revision}` | 非本端引起的结构变化（agent 改 cell） |

**append 语义的硬约束**（照 vscode-jupyter 的 `clearLastUsedStreamOutput`）：
连续同类 `stream` 复用**同一个 `outId`**，遇非 stream 输出则清空记录。
`print` 一万行 → **只产生 1 个输出块**，不是一万个。

## 6. 鉴权

- 宿主只绑 `127.0.0.1`，**本机任意进程可达**（已核实：插件路由无 auth gate）。
- M0：`config.token` 为空 = 不校验（演示端点风险低）。
- M1 起：**默认置 token**，`?token=` 或 `x-nb2-token` 二者其一；token 由插件启动时随机生成、
  通过 profile 配置下发，客户端从 `ctx.connection` 拿。
- 未授权一律 `401 {"error":"unauthorized"}`，**不泄漏任何事件内容**。

## 7. 生命周期

- 路由与工具的 disposer 全部写在 `ctx.effect` 里 → 插件卸载/热重载**不留僵尸路由**。
- 卸载时：清演示定时器 → 逐个 `res.end()` 关掉 SSE 客户端 → 清空总线。
- 每个 SSE 连接在 `req.close` / `res.close` **任一**触发时清理（心跳 interval 一并清）。

## 8. 第二轮新增端点（内核选择 / 环境 / AI）

| 方法 | 路径 | 用途 | 返回 |
|---|---|---|---|
| GET | `/nb2/kernels?sid=` | conda 环境候选（含 `hasIpykernel`）+ 当前选择 + cwd | JSON |
| POST | `/nb2/kernel/select` | `{kernelId}` 换内核（**会重启内核并清空输出**） | JSON |
| POST | `/nb2/notebook/setCwd` | `{dir}` 改内核工作目录（**会重启内核**） | JSON |
| POST | `/nb2/notebook/saveAs` | `{path}` 另存为并把标签 key 迁到新路径 | JSON |
| GET | `/nb2/diagnostics` | 解释器/内核排查清单（envsel 路径与选择、候选内核及 hasIpykernel、env 快照、修法提示） | JSON |
| GET | `/nb2/ai/health` | `ctx.llm` 是否可用、已注册 provider、解析出的 target | JSON |
| POST | `/nb2/ai/stream` | **AI 流式生成（NDJSON）** | `application/x-ndjson` |

### `POST /nb2/ai/stream` 的帧（每行一个 JSON）

```jsonc
{"type":"start","provider":"quota-auto","model":"deepseek-v4.1-flash","source":"config"}
{"type":"delta","text":"print("}          // × N，token 级，前端边收边渲染
{"type":"done","text":"print('hi')","ms":2310}
{"type":"error","code":"NO_ADAPTER","message":"…","hint":"…","partial":"…"}
```

要点（都是踩过坑的）：

- **取消语义**：客户端断开时服务端必须停止产出并写 `error{code:"ABORTED"}`，**绝不能写 `done`**
  （否则前端会把半截代码当成品）。判活用 **`res.on("close")`**，不能用 `req.on("close")` ——
  `IncomingMessage` 的 close 在请求体读完时就触发了，用它会导致「取消传不下去」甚至「整条流 0 字节」。
- **`signal` 必须传进 `ctx.llm.stream()`**，否则 provider 会无视取消把整段生成跑完。
- 响应头同 SSE：`Cache-Control: no-cache, no-store, no-transform` + `X-Accel-Buffering: no` + `flushHeaders()`。

### `POST /nb2/kernel/select` 与 `setCwd` 的副作用

两者都会**重建 sidecar 进程**（换解释器/换 cwd 在 jupyter 语义里只能重启），因此会：
清空所有输出与 execCount → 杀掉旧进程（Windows `taskkill /T /F`）→ 用新解释器起新内核。
前端在调用期间会收到 `kernel.state: starting`。

---

## 9. 单元格类型（code / markdown / raw / shell）

### 类型与归一化

| 归一后的类型 | 接受的别名 | 执行语义 |
| --- | --- | --- |
| `code` | `code` `py` `python` `ipython` `jupyter`（空/未知也归这里） | 送 Python 内核 |
| `markdown` | `markdown` `md` `mdown` `mkdn` | **永不执行**；`cell/run` 返回 `{skipped:true}` |
| `raw` | `raw` `text` `plain` | **永不执行**；UI 里按原文预格式显示 |
| `bash` | `bash` `sh` `shell` `zsh` `console` `cmd` `powershell` `pwsh` | 起**独立子进程**执行，不经过内核 |

别名表在 `lib/notebook.js#normalizeCellType`。客户端半是自包含工厂，抄了一份完全相同的实现；
`test/celltypes.mjs` 用同一张别名表同时喂两边并断言结果一致 —— **改一边不改另一边会让测试红**。

### 涉及的路由

- `POST /nb2/cell/add` `{sid, cellType?, source?, after?}` → 按归一后的类型建格。
- `POST /nb2/cell/edit` `{sid, cellId, source?, cellType?}`
  - 带 `source` → 覆盖内容（`sourceDirty=true`）。
  - **只带 `cellType`** → 换类型，走 `Notebook#setCellType`：换到 `markdown`/`raw` 时**清空输出与 execCount**
    （它们已无意义），并置 `sourceDirty=true`（序列化必须跟着变，见下）。
- `POST /nb2/cell/run` → `code` 进内核队列；`bash` 进 shell 执行器；`markdown`/`raw` 直接 `{status:"ok", skipped:true}`。
- `POST /nb2/runAll` → 只跑 `code` 与 `bash`，**跳过** `markdown`/`raw`（与 Jupyter 一致）。

### shell 格怎么执行

`lib/shell.js`。三个要点：

1. **不经过 Python 内核**：`ipykernel` 的 `%%bash` 在 Windows 上因为没 bash 会直接抛错，
   而且「有没有 bash」不该决定用户能否跑 shell 格。所以起独立进程，队列/中断/事件协议照旧复用
   （事件形状与 sidecar 完全一致，`runShellCell` 直接调 `onSidecarEvent`，模型层零改动）。
2. **shell 选择**：`config.shell` = `auto|bash|cmd|pwsh`。`auto` 的规则是「**有 bash 就用 bash**」，
   否则 Windows 退 `cmd`、POSIX 用 `bash`（`pickShellKind`，纯函数、可测）。
3. **编码**：`cmd` 前面加 `chcp 65001>nul`，`pwsh` 前面设 `[Console]::OutputEncoding`，否则中文输出是 GBK 乱码。

失败语义：非零退出码 → `error{ename:"ShellError", evalue:"退出码 N"}` + `cell.done{status:"error"}`；
超时（`config.shellTimeoutMs`）→ `ShellTimeout`；被 `kernel/interrupt` 打断 → `ShellKilled`（Windows 用 `taskkill /T /F` 杀进程树）。

### `.ipynb` 里的 shell 格

**shell 格在文件里就是「带 `%%bash` 魔法行的 `code` 格」** —— 这是 Jupyter 的标准写法，
所以在 JupyterLab / VS Code 里打开仍是合法 notebook（Linux 上还能真跑）。

- 读：把开头的 `%%bash` / `%%sh` / `%%script bash` 剥掉存进模型，原本的魔法行记在 `cell.magic`。
- 写：贴回去（`%%sh` 不会被强行改成 `%%bash`）。
- 换类型（python→shell、shell→markdown）时必须置 `sourceDirty`，否则写回会沿用旧序列化 —— 这是个真错，
  `test/celltypes.mjs` 有专门用例。

---

## 10. `POST /nb2/ai/complete`（AI 内联补全 / ghost text）

一次请求换一行建议，**非流式**（补全要的是「快」，流式反而没法用）。

请求：`{prefix, suffix, timeoutMs?}`
- `prefix`：光标之前的全文；`suffix`：光标之后的全文。
- `timeoutMs`：预算，默认 8000，实际夹在 `[1500, 20000]`。

响应：`{ok, suggestion, ms, model, provider, aborted, error?}`

关键语义：

- 提示词走 `buildMessages` 的 **`ghost` 分支**（`lib/ai.js`），与 `complete`/`rewrite` 是两套任务：
  ghost 只要「光标处要插入的那一小段」，**不能**退化成「整格重写」，否则铺进编辑器就是灾难。
- **超时/取消/失败 → `suggestion: ""`**。半截的 `ad_csv(` 插进编辑器比什么都不给更糟。
- 失败一律 HTTP 200 + 空建议：补全是锦上添花，不能因为模型抽风就在 UI 上弹错。

客户端触发判据（纯函数 `shouldRequestCompletion`，`test/client-logic.mjs` 覆盖）：
开关开着 · 光标在行尾 · 前缀至少 3 个字符 · 不在空行 · 上一字符不是 `= , ( + - * /` 等「还没写完」的位置 ·
两次请求间隔 ≥ 600ms · 停止输入 ~550ms 后才发。补全默认**关闭**（消耗 token）。

### 客户端实现要点（踩过的坑）

- 幽灵文本用 `Decoration.widget` 画在光标处，**不进文档**：不污染 undo 栈，也不会让「保存」带上没接受的内容。
- 任何 `docChanged` / 选区变化都会让 `StateField` 返回 `null`（建议作废），否则幽灵文本会飘到错误位置。
- 不要在 `updateListener` 里 dispatch 去清 ghost（重入风险）；清理由 StateField 的 update 自然完成。
- **`Tab` 绑定必须写在 `buildExtensions` 那个主 `keymap.of([...])` 数组的第一条**，并排在
  `...CM.defaultKeymap` / `CM.indentWithTab` 之前。原因是同一 keymap 数组内「先匹配先赢」，
  而跨 keymap 扩展的先后取决于扩展树顺序（脆弱）。早先版本把 ghost 的 keymap 作为独立扩展
  追加在数组末尾 → Tab 被 `indentWithTab` 抢先插缩进，**补全永远接受不了且不报错**。
  `test/smoke-client.mjs` 有一条静态断言把顺序钉死。
- `Esc` 分两级：有建议时第一下只丢弃建议，第二下才退出编辑态（VS Code 同行为）。
- 关掉开关要主动收掉已有的幽灵文本（`useEffect([ghost])` 里发一个空 selection 事务）——
  `Decoration.widget` 不会因为「开关变量变了」自己消失。


---

## 11. 大纲（TOC）与 `window.prompt`

大纲是**纯客户端**功能（`buildOutline`）：markdown 格的 `#` 标题（跳过代码块内的 `#`）+ 其余每格首行，
点击用 `data-cell-id` 定位并 `scrollIntoView`。不发任何请求。

⚠️ **Electron 里 `window.prompt` 被禁用**（调用抛 `prompt() is and will not be supported.`）。
所以「打开」「另存为」都必须用**内联输入行**实现，不能用 prompt —— 否则按钮表现为「点了没反应」，
而且错误在控制台里，用户完全看不到。同理不要在按钮 handler 里 `.catch(() => {})` 吞错。

---

## 12. 第三轮新增端点（工作区列举 / 素材文件 / KaTeX 资源）

> 背景：用户反馈「打开要我先输工作目录」「markdown 渲染不对」。根因之一是**默认目录取成了
> `process.cwd()` = DSH 档案目录**，之二是**KaTeX 只有 JS 没有 CSS**。

### `GET /nb2/health` 新增自证字段

```json
{ "ok": true, "dir": "E:\\repo", "dirSource": "workingDirectory" }
```

`dirSource ∈ { agent | workingDirectory | defaultDirectory | sandboxPolicy | process.cwd }`。
「取错工作目录」的故障表现很隐蔽（内核里 `read_csv("data.csv")` 失败，报错指向数据而不是 cwd），
所以把命中层级暴露出来：**一条 curl 就能判断链路通没通**，不用去读内核报错。

回退顺序（每级单独 try/catch，服务缺失不抛）：
`agents.get(sid)` → `workingDirectory.get(agent.session)` → `workingDirectory.defaultDirectory`
→ `sandboxPolicy.workspaceRoot` → `process.cwd()`。

### `GET /nb2/fs/list?sid=&dir=&depth=`

工作区里的 notebook 列举（picker 用）。

```json
{ "ok": true, "root": "E:\\repo", "cwd": "E:\\repo", "dir": "E:\\repo",
  "entries": [ { "path": "E:\\repo\\a.ipynb", "rel": "a.ipynb", "dir": false, "mtime": 1793766112109, "size": 2187 },
               { "path": "E:\\repo\\sub",     "rel": "sub",    "dir": true,  "mtime": 1793766000000, "size": 0 } ],
  "truncated": true, "filesTruncated": false, "dirsTruncated": true }
```

- `dir` 缺省 = 会话工作目录；`depth` 默认 2、上限 4；黑名单目录（`.git`/`node_modules`/`.venv`/
  `__pycache__`/`.ipynb_checkpoints`/`dist`/`build`/`.next`/`.cache`）剪枝；
  **目录符号链接不跟随**（防循环）；`EACCES/EPERM` 逐条跳过不报错。
- ⚠️ **目录与 notebook 的预算必须分开**（notebook 500 / 目录 150，BFS 先浅层）。
  实测一个 500+ 目录、0 notebook 的工作区会把"总上限 500"吃光，`truncated:true` 却 `files:0` ——
  有 notebook 也永远看不到。`entries` 里**先 notebook 后目录**：这个端点的第一用途是挑 notebook。

### `GET /nb2/file?sid=&path=`

markdown 里相对路径图片、以及输出里的素材文件。

- **`base` 不接受客户端参数**，只能由服务端推导（活动 notebook 的目录 → 会话工作目录）。
  让客户端指定 base 等于让客户端自选子树，子树校验恒成立 → 任意本地文件读取器。
- 两道校验，**顺序不能反**：① 先 `path.relative` 词法 containment（越界目标常常不存在，
  先 `realpath` 会得到 ENOENT → 把"有人穿越"伪装成"文件没找到"）；② 再 `realpath` containment
  （拦"词法在子树内、实际是指向外面的符号链接/junction"）。Win32 还要大小写折叠，
  且不能用裸 `startsWith`（`C:\foo` 与 `C:\foobar`）。
- 只服务**扩展名白名单**（图片 + 文本）；`>20MB` → 413；越界 403；不存在 404；
  svg 额外加 `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'` + `nosniff`。

### `GET /nb2/katex.css` + `GET /nb2/fonts/<name>.woff2`

构建产物 `lib/katex/`（`scripts/build-cm-vendor.mjs` 生成）。

- CSS 由 `katex.min.css` **改写**而来：只保留 woff2 回退（60 个 `url()` → 20 个），
  `url(fonts/X.woff2)` 改成绝对 `/nb2/fonts/X.woff2`（所以字体路由就叫 `/nb2/fonts/`，不用改写内容）。
- 字体白名单**只允许 `.woff2`**，穿越 403，`Cache-Control: public, max-age=31536000, immutable`。
- 为什么不 base64 内联：内联 ≈ +350KB 且 render-blocking，还无法按字体缓存；
  裁到 20 个 woff2 后约 21KB CSS + 254KB 字体，浏览器按需惰性下载（典型文档只用 8 个）。

### 路径语义（`notebook/open|save|saveAs`）

三者都 `path.resolve(默认工作目录, body.path)` —— `ipynb.js` 内部是裸 `readFile(path)`（按
`process.cwd()` = 档案目录解析），picker 传相对路径必然 ENOENT。
另外：相对路径的**写**操作若解析到 DSH 档案目录 → 400（防止"另存为"把 `.ipynb` 写进 profile）。

`notebook/open` 成功后，若用户没显式 `setCwd` 过（`cwdExplicit=false`），**会话 cwd 跟随 notebook 目录**
（等同 Jupyter/VS Code 语义，内核里相对路径才指对地方）；只改 `session.cwd`，不重启内核。

---

## 13. markdown 渲染与大纲 v2（客户端）

### markdown

`renderMarkdown(src, { CM, sid })` → 纯字符串 HTML：

1. 有 `CM.marked`（构建期已 `use(markedKatexExtension({throwOnError:false}))`）就用它 ——
   一次覆盖表格、任务列表、嵌套列表、分割线、围栏、`$..$` 与 `$$` 公式；
2. 相对路径 `<img src>` 改写成 `/nb2/file?sid=…&path=…`（`rewriteImgSrc`）；
3. 过 `CM.DOMPurify.sanitize(html, SANITIZE_CFG)` 再进 `dangerouslySetInnerHTML`。

⚠️ 三条安全/健壮性约束：
- **`matched` 会原样透传 `<script>`**，消毒不能省；
- Node 无 DOM 时 `DOMPurify.sanitize === undefined`（拿到的是工厂）→ 必须
  `typeof CM.DOMPurify?.sanitize === "function"` 守卫，不满足就回落 `markdownLite`（纯 `h()` 构造，天然安全）；
- `marked.parse` 按 source 字符串缓存（上限 200）+ 超大 md 先显示源码，避免 App 级重绘卡主线程。

样式：作用域 CSS `.nb2-md`（h1–h6 阶梯 1.6→0.92em、表格边框/斑马纹/横向滚动、任务列表去圆点、
嵌套缩进、引用块、分割线、图片 `max-width:100%`），KaTeX 的 `<link href="/nb2/katex.css">` 只注入一次。

### 大纲 v2

`buildOutlineV2(cells, { CM })` → 树：

- **markdown 标题**：`CM.marked.lexer(src)` 取 `heading` token（ATX + setext，围栏内自动不算）；
  无 CM 时回落到正则（跳围栏）。
- **Python 符号**：`CM.pythonParser.parse(src)` 遍历 `FunctionDefinition` / `ClassDefinition`，
  **名字取该节点内第一个 `VariableName` 子节点**（`FunctionDefinition` 的 span 含整个函数体，
  直接切文本会拿到整段）；行号用「`from` 之前换行数 + 1」；层级用**节点 span 包含关系**算
  （缩进法在 tab/续行/混排下不可靠）。
- UI：可折叠 + 过滤框 + 当前格高亮 + 点击跳转并**聚焦该格编辑器**（旧实现只滚动不聚焦）。
- 旧的扁平 `buildOutline` 保留，作为无 CM 时的兜底。




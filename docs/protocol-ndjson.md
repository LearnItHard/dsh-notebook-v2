# sidecar ↔ Node NDJSON 帧协议（v1，待实现 / M1）

> 计划 §4.1 只写了一句「NDJSON over stdio」。本文把它补成可实现、可测试的规格 ——
> **M1 的第一件事是实现 `python/kernel_driver.py` 的 echo 模式跑通本协议**，再接 ipykernel。
>
> 为什么 NDJSON：一帧一行、行内 JSON，天然和 `readline` 对齐；坏帧只影响一行，不会
> 因长度前缀算错而整条流报废（stream 解析器出错最容易丢的就是「界限」，所以宁可放弃二进制长度前缀）。

## 1. 进程模型

```
Node (插件宿主半)
  │  spawn('python', ['-u', 'kernel_driver.py', '--session', sid])
  │  stdin:  命令帧（一行一个 JSON）
  │  stdout: 事件帧（一行一个 JSON，**只放协议**）
  │  stderr: 诊断文本（人类日志，不参与协议）
  ▼
Python sidecar (kernel_driver.py)
  ├─ ipykernel + jupyter_client
  └─ 唯一真相源：内核消息原样转成事件帧
```

**规则**
1. `python -u` 必须加，否则 stdout 块缓冲会让「流式」变成「攒满 4KB 才吐」。
2. **stdout 只走协议**；任何 print/日志 → stderr。Python 侧把所有业务日志导向 stderr，
   包括未捕获异常的 traceback（同时用 `sys.excepthook` 兜底，防止打到 stdout）。
3. 一帧一行，**行内不许有裸换行**（JSON 会转义 `\n`，所以自然满足）；单帧上限 8MB，
   超限说明分包逻辑错了（见 §4 大输出）。
4. Node 侧用 `readline.createInterface({ input: child.stdout })` 逐行解析；解析失败 →
   记 stderr 日志并**跳过该行**，绝不让一行坏帧拖垮整个会话。

## 2. 通用信封

所有帧共有：

```jsonc
{
  "v": 1,                 // 协议版本；不匹配时 Node 侧拒绝启动并给出明确报错
  "type": "event|ack|ready|error|heartbeat",
  "id": "uuid-or-crypto-random",   // 帧 id（排障用，不要求全局唯一）
  "ts": 1730000000000,             // 毫秒时间戳
  "reply_to": "req-id"             // 可选：本帧在回应哪个命令
}
```

**命令帧**（Node → Python）额外带 `req_id` 与 `op`；
**事件帧**（Python → Node）额外带 `name` 与 `payload`。

```jsonc
// 命令
{ "v":1, "type":"cmd", "req_id":"r1", "op":"execute", "payload":{…} }
// 回应（可以是 ack 也可以是 error）
{ "v":1, "type":"ack", "reply_to":"r1", "payload":{…} }
// 事件
{ "v":1, "type":"event", "name":"stream", "msg_id":"m1", "payload":{…} }
```

## 3. 启动握手

```jsonc
// Python 起好后第一帧（必须）
{ "v":1, "type":"ready", "ts":…, "payload":{"pid":1234, "python":"3.11.15", "ipykernel":"6.x", "cwd":"…"} }
```
Node 侧：**10s 内没收到 `ready` → 判失败**，杀掉进程，向上报 `kernel.state: dead` + 明确原因
（Python 找不到／ipykernel 没装／cwd 不存在，三种要能区分）。

内核真正的启动（`KernelManager.start_kernel()`）可以是 lazy 的（第一次 execute 才起），
但 `ready` 必须立即发 —— **协议活着 ≠ 内核活着**，两个状态分开报：

```jsonc
{ "type":"event", "name":"kernel.state", "payload":{"state":"starting"|"idle"|"busy"|"dead"|"terminating"} }
```

## 4. 命令 / 事件对照

### 命令（Node → Python）

| `op` | payload | 说明 |
|---|---|---|
| `execute` | `{cellId, code, silent?, storeHistory?}` | 送 `requestExecute` |
| `interrupt` | `{}` | `KernelManager.interrupt_kernel()` |
| `restart` | `{clearOutputs?:bool, runAll?:bool}` | 重启语义三种由 **Node 侧**编排，Python 只做 restart |
| `complete` | `{code, cursorPos}` | 补全（Jedi） |
| `inspect` | `{code, cursorPos}` | hover |
| `shutdown` | `{}` | 收尾退出 |
| `ping` | `{}` | 心跳，回 `ack` |

### 事件（Python → Node）

| `name` | payload | 来源 |
|---|---|---|
| `cell.started` | `{cellId, execCount}` | `execute_reply` 前的 `execute_input` |
| `stream` | `{cellId, name:'stdout'\|'stderr', text}` | `iopub.stream` |
| `display` | `{cellId, mime, data, displayId?, update?:bool}` | `display_data` / `update_display_data` |
| `result` | `{cellId, mime, data}` | `execute_result` |
| `error` | `{cellId, ename, evalue, traceback:[…]}` | `iopub.error` |
| `cell.done` | `{cellId, status, execCount, durationMs}` | `execute_reply`（**或**中断/竞态下的超时判定） |
| `kernel.state` | `{state}` | 生命周期 |
| `stderr.log` | `{text}` | 诊断（Node 侧只写日志，不进 UI） |

### msg_id 关联（最容易写错的地方）

Python 侧对每次 `execute` 记：`msg_id = km.session.send(...)` 的返回值。之后所有 iopub 消息
**按 `parent_header.msg_id` 归到对应 cell**。归不到任何在飞 `msg_id` 的 iopub 消息：

- 若是 `stream`/`display` 且属于**刚结束的那个 cell**（`last_msg_id`）→ 仍归给它（迟到尾包）；
- 否则 → 丢弃并记 `stderr.log`（不要猜归属，猜错会把 A 格的输出画到 B 格）。

这与 vscode-jupyter 的 `CellExecutionQueue` **故意不 dispose `lastCellExecution`** 是同一个原因。

## 5. 大输出与背压

| 场景 | 规则 |
|---|---|
| 单条 `stream` 文本 | Python 侧按 **8KB 或 50ms** 先攒后发（两者先到为准），减少帧数；`text` 原样保留换行 |
| 图片 | `data` 里的 base64 **不进 NDJSON 的单个大帧**：>256KB 时 Python 存到磁盘临时文件，帧里只给 `{kind:'path', path, bytes, mime}`；Node 侧读文件后经 `/nb2/asset/<id>` 提供给前端 |
| 单帧上限 | 8MB，超限 Node 侧记日志丢弃该帧（说明分包没生效） |
| 背压 | Node 侧 `child.stdin.write()` 返回 false 时**不要**继续灌（队列里最多 1 个在飞 execute）；Python 侧不需要读速反馈，因为命令是低频的 |
| 输出总量 | 每 cell 上限 50MB / 20 万行，超出后截断并推一条 `{name:'stream', text:'…（已截断）'}` |

## 6. 心跳与死亡判定

- Node 每 **15s** 发 `{"op":"ping"}`；**30s 内无任何帧**（含事件）→ 判 sidecar 挂起，
  杀掉并按「崩溃」处理。
- Python 侧不需要主动心跳：有活干就有帧；`ping` 只为覆盖「内核 idle 且无输出」的空窗。
- 死亡处理：`child.on('exit')` → 推 `kernel.state: dead` → 取消剩余排队 cell
  → **自动重启一次**（`restartBudget=1`，1 分钟内第二次死亡则停止自动重启并报错，避免崩溃循环刷屏）。

## 7. 进程清理（Windows 是重点）

- Linux/macOS：`child.kill('SIGTERM')`，3s 后 `SIGKILL`；sidecar 内 `atexit` 关内核。
- **Windows 没有 pkill，也没有进程组信号**：`execFile('taskkill', ['/pid', pid, '/T', '/F'])`
  杀掉整棵树（`/T` 必须带，否则 ipykernel 的 zmq 子进程会成孤儿）。
- 宿主退出：`ctx.effect` 的 disposer 里同步 kill；另注册 `process.on('exit')` 尽力而为。
- **孤儿检测**：sidecar 写入 `%TEMP%/nb2-sidecar-<pid>.json`（含父 pid），启动时扫一遍，
  父 pid 已不存在的直接 taskkill。这是「上次崩溃后残留内核占着内存」的唯一可靠兜底。

## 8. 三种重启语义（Python 只实现第一种）

| 语义 | 谁负责 | 实现 |
|---|---|---|
| 重启 | Python | `restart_kernel(now=True)` |
| 重启并运行全部 | **Node** | restart → 等 `kernel.state:idle` → 依次 `execute` 全部 code cell |
| 重启并清空 | **Node** | restart → 清本地 outputs 与 `execCount`（**内核不会替我们清**，vscode 侧也是核心 clean） |

## 9. 错误码

| `type:"error"` 的 `code` | 触发 | Node 侧动作 |
|---|---|---|
| `E_BAD_FRAME` | JSON 解析失败 | 记日志，跳过 |
| `E_UNKNOWN_OP` | 未知 `op` | 回 error，不中断 |
| `E_KERNEL_DEAD` | 执行时内核已死 | 自动重启一次 |
| `E_INTERRUPT_TIMEOUT` | `interrupt` 5s 内没等到 `execute_reply` | 硬杀重启 |
| `E_IPYKERNEL_MISSING` | import 失败 | 提示装包，**不重试** |
| `E_VERSION` | `v` 不匹配 | 拒绝启动，报版本 |

## 10. 测试清单（M1 验收，`test/` 下逐条脚本化）

1. echo sidecar：发 `ping` 收 `ack`，发 `execute` 收 `cell.started→stream→cell.done`；
2. 坏帧注入（一行乱码）后仍能继续工作；
3. `ready` 超时 → 报错且不残留进程；
4. 崩溃 `os._exit(1)` → 自动重启 1 次；1 分钟内第二次崩溃 → 停止并报错；
5. 迟到尾包：`cell.done` 之后 200ms 到达的 stream 仍归属同一 cell；
6. `print` 10000 行 → 前端只 1 个输出块（联动 `/nb2` 侧合并规则）；
7. Windows 强杀后 `tasklist | findstr python` 无孤儿。

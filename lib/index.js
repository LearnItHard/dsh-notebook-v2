/**
 * dsh-notebook-v2 · 宿主半
 *
 * 分层（每层都能单独测）：
 *   events.js    事件总线（seq + 回放 + 游标）
 *   notebook.js  纯模型：cells / 输出块合并 / 状态机 / 队列
 *   ipynb.js     .ipynb 语义等价读写
 *   sidecar.js   NDJSON 客户端 + 生命周期（重启预算 / 心跳 / 树杀）
 *   index.js     ← 本文件：会话装配、HTTP 路由、agent 工具
 *
 * 数据流（单向，内核消息是唯一真相源）：
 *   ipykernel → sidecar(NDJSON) → Session.onSidecarEvent → Notebook.applyEvent
 *             → EventBus.emit → SSE → 客户端增量渲染
 *
 * 路由见 docs/api-nb2.md；sidecar 协议见 docs/protocol-ndjson.md。
 */

import { readFileSync, existsSync, readdirSync, lstatSync, statSync, realpathSync, unlinkSync } from "node:fs"
import { dirname, join, extname, isAbsolute, normalize, relative, resolve, sep } from "node:path"
import { homedir, tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { defineTool } from "@deepseek-ai/dsh-tools"
import { EventBus } from "./events.js"
import { Notebook, isRunnableCell } from "./notebook.js"
import { Sidecar } from "./sidecar.js"
import { runShell } from "./shell.js"
import { notebookToIpynb, readIpynbFile, writeIpynbFile } from "./ipynb.js"
import { kernelById, kernelDiagnostics, listKernels, probeIpykernel, resolvePython } from "./python.js"
import { buildMessages, listAiCatalog, modelEfforts, resolveTarget, runCompletion, stripFences } from "./ai.js"
import { buildTools } from "./tools.js"

export const name = "dsh-notebook-v2"
export const inject = ["tools", "webServer"]

/**
 * 版本号从 `package.json` 读，**不要**在代码里再写一个字面量。
 * 曾经三处各写一份且互相矛盾（package.json=0.0.1、`/nb2/health`=0.1.0、文档=0.0.1），
 * 发版时对不上号，排障也没法一眼看出跑的是哪一版。
 */
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0"
  } catch {
    return "0.0.0"
  }
})()

const HEARTBEAT_MS = 15000
/**
 * 送 execute 之后，等 `cell.started` 的上限。
 *
 * 为什么需要这个兜底（2026-11-10 真机）：中断/驱动异常会让「已 post 未 started」的
 * 那一格永远收不到任何事件，`inflight` 便永久占着队列闸门 —— 表现为「点运行没反应、
 * 也不报错」。15s 足够覆盖最慢的冷启动（sidecar ready 上限 10s）。
 */
const KERNEL_START_TIMEOUT_MS = 15000
const HERE = dirname(fileURLToPath(import.meta.url))
/** CodeMirror 6 + KaTeX 的 IIFE 包（scripts/build-cm-vendor.mjs 生成，已提交） */
const VENDOR_PATH = join(HERE, "cm-vendor.js")
/**
 * KaTeX 的 CSS 与字体（scripts/build-cm-vendor.mjs 从 katex/dist 复制，已提交）。
 *
 * 为什么单独放目录而不是塞进 vendor：katex.min.css 有 23KB + 20 个字体文件，
 * 内联进 JS 会让「打开面板」的首屏包多 350KB，而 CSS 是浏览器自己缓存/并行拉取的。
 * 目录结构保持 katex 原样（katex.min.css + fonts/），CSS 里的 `url(fonts/…)`
 * 才不用改写 —— 它挂在 /nb2/katex.css 时相对路径正好落到 /nb2/fonts/。
 */
const KATEX_DIR = join(HERE, "katex")

/** /nb2/file 的上限：比这更大的图片/日志不该走 HTTP 预览（浏览器也扛不住）。 */
const FILE_MAX_BYTES = 20 * 1024 * 1024

/**
 * 大块输出的落盘目录（sidecar 写、本进程用 `/nb2/spill` 读回渲染）。
 *
 * 默认 = 系统临时目录下的**固定**子目录，可用 `DSH_NB2_SPILL` 指到别的盘。
 * 为什么不放工作区：这是 base64 解码出来的中间产物，不是用户资产；每跑一次图就多一个
 * 文件，工作区会被临时文件淹没、还会被 git 看到。放在临时目录 + 定期清理才是对的。
 */
const SPILL_DIR = process.env.DSH_NB2_SPILL ? resolve(process.env.DSH_NB2_SPILL) : join(tmpdir(), "dsh-nb2-spill")
/** 落盘文件扩展名 → Content-Type（前端用 `<img src="/nb2/spill?path=...">` 直接渲染）。 */
const SPILL_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".bin": "application/octet-stream",
}
/**
 * 列举 notebook 时的**分离预算**。
 *
 * 为什么不能共用一个 500：真机上量到过 `entries=500 / dirs=500 / files=0` ——
 * 一个目录多的仓库（几乎所有真实工程）会把预算全吃在目录上，picker 里一条
 * notebook 都看不到，哪怕工作区里明明有。这个端点的第一用途是「挑一个 notebook」，
 * 目录只是导航，所以两者必须各算各的。
 */
const LIST_MAX_FILES = 500
const LIST_MAX_DIRS = 150
const LIST_MAX_DEPTH = 4
/** 列举时直接剪掉的重目录：它们里面的 .ipynb 是依赖自带的示例，不是用户的文件。 */
const LIST_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".ipynb_checkpoints",
  "dist",
  "build",
  ".next",
  ".cache",
])

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
}
const TEXT_MIME = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".ipynb": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".cfg": "text/plain; charset=utf-8",
  ".sh": "text/x-sh; charset=utf-8",
  ".tex": "text/x-tex; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
}
// 只服务 woff2：构建期已把 CSS 里 woff/ttf 的回退段删掉，这两类文件根本没落盘。
// 白名单只留一种扩展名，路由就不可能被当成通用文件读取器用。
const FONT_MIME = { ".woff2": "font/woff2" }

/**
 * 「探变量」用的保留 cellId。
 *
 * 它不对应任何真实单元格 —— 前端 reduceEvent 找不到该 id 的 cell，直接忽略，
 * 所以这次探测不会在界面上多出任何输出块；而 sidecar 的 display 事件会被
 * Session.onSidecarEvent 截下来存进 varsCache。
 */
const VAR_CELL = "__nb2_vars__"

/**
 * 变量摘要探针：把「用户定义的全局变量」压成一行 JSON 打到 stdout。
 *
 * 为什么走 stdout 而不是 display/MIME：stdout 是 stream 事件，后端在
 * `onSidecarEvent` 里按保留 cellId 就能截获并拼起来，不需要改 sidecar 协议、
 * 也不需要前端参与。JSON 放一行，拼完 `JSON.parse` 就行。
 *
 * 只取「用户自己定义的」变量：跳过下划线开头的内部名、模块、函数、类。
 * 对 DataFrame / ndarray 给出 columns / shape 摘要 —— 这正是 AI 写数据分析代码时
 * 最需要的信息（它不知道 `df` 有哪些列，就只能猜列名）。
 */
const VARS_PROBE = [
  "import json as _nb2_json",
  "import types as _nb2_types",
  "def _nb2_sig(_v):",
  "    try:",
  "        _n = type(_v).__name__",
  "        if hasattr(_v, 'columns') and hasattr(_v, 'shape'):",
  "            _c = ','.join(str(_x) for _x in list(_v.columns)[:10])",
  "            return _n + ' columns: ' + _c + ' shape: ' + str(tuple(_v.shape))",
  "        if hasattr(_v, 'shape'):",
  "            return _n + ' shape: ' + str(tuple(_v.shape)) + ' dtype: ' + str(getattr(_v, 'dtype', ''))",
  "        if isinstance(_v, (list, tuple, set, frozenset)):",
  "            return _n + ' len: ' + str(len(_v))",
  "        if isinstance(_v, dict):",
  "            return 'dict keys: ' + ','.join(str(_k) for _k in list(_v.keys())[:10])",
  "        if isinstance(_v, (int, float, str, bool)) or _v is None:",
  "            return _n + ' = ' + repr(_v)[:60]",
  "        return _n",
  "    except Exception:",
  "        return '?'",
  "_nb2_out = []",
  "for _nb2_k, _nb2_v in list(globals().items()):",
  "    if _nb2_k.startswith('_') or _nb2_k in ('In', 'Out', 'get_ipython', 'exit', 'quit'):",
  "        continue",
  "    if isinstance(_nb2_v, (_nb2_types.ModuleType, _nb2_types.FunctionType, _nb2_types.BuiltinFunctionType, type)):",
  "        continue",
  "    _nb2_out.append({'name': _nb2_k, 'type': type(_nb2_v).__name__, 'detail': _nb2_sig(_nb2_v)})",
  "    if len(_nb2_out) >= 24:",
  "        break",
  "print(_nb2_json.dumps({'vars': _nb2_out}))",
  "del _nb2_out",
  "del _nb2_k, _nb2_v",
].join("\n")

/**
 * 清掉 spill 目录里过期的落盘文件（默认 24h）。
 *
 * 不清理的话，每跑一次生图的 cell 就在临时目录里留一个文件，几个月后是几百 MB。
 * 只删我们自己的命名（`nb2-<pid>-<ms>-<seq>.<ext>`），不碰别的程序放在同目录的东西。
 */
function cleanupSpill(maxAgeMs) {
  try {
    if (!existsSync(SPILL_DIR)) return 0
    const cutoff = Date.now() - (Number(maxAgeMs) > 0 ? Number(maxAgeMs) : 24 * 60 * 60 * 1000)
    let removed = 0
    for (const name of readdirSync(SPILL_DIR)) {
      if (!/^nb2-\d+-\d+-\d+\.[A-Za-z0-9]+$/.test(name)) continue
      const p = join(SPILL_DIR, name)
      try {
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p)
          removed += 1
        }
      } catch {
        /* 被别的进程占着 / 已删：跳过 */
      }
    }
    return removed
  } catch {
    return 0
  }
}

export function apply(ctx, config) {
  const cfg = config || {}
  if (cfg.enabled === false) return

  const startedAt = Date.now()
  // 启动时顺手清一次旧的落盘输出（不阻塞、失败也不影响加载）
  cleanupSpill()
  /** sid -> Session */
  const sessions = new Map()
  /** 子会话 -> 父会话：envsel 的选择要沿这条链继承（子代理通常自己没有选择） */
  const sessionParents = new Map()
  const timers = new Set()

  function workspaceRoot() {
    try {
      const policy = ctx.get("sandboxPolicy")
      if (policy && policy.workspaceRoot) return policy.workspaceRoot
    } catch {
      /* ignore */
    }
    return process.cwd()
  }

  /**
   * 会话自己的工作目录 + **这个目录是从哪一级取到的**。
   *
   * 为什么要 source：取错目录的后果很隐蔽 —— 内核在 profile 目录里起，用户
   * `read_csv("data.csv")` 才会失败，报错还指向数据文件而不是 cwd。而服务装配
   * 随 composition 而异（agents / workingDirectory / sandboxPolicy 都可能没有）。
   * 把命中的那一级写进 /nb2/health，一条 curl 就能自证这条链路通没通。
   *
   * 顺序（每一级单独 try/catch，服务 undefined 也绝不抛）：
   *   ① 会话 → agent 自带 cwd / workingDirectory.get(agent.session)
   *   ② workingDirectory.defaultDirectory
   *   ③ sandboxPolicy.workspaceRoot
   *   ④ process.cwd()
   */
  function defaultCwdInfo(sid) {
    // ① 会话自己的工作目录：用户真正开着的那个工作区
    try {
      const agents = ctx.get("agents")
      const agent = agents && typeof agents.get === "function" ? agents.get(String(sid)) : null
      if (agent && agent.session) {
        try {
          const wd = ctx.get("workingDirectory")
          const dir = wd && typeof wd.get === "function" ? wd.get(agent.session) : null
          // 目录可能已被删/被移走：不存在就当这一级没拿到，别让内核在虚空里启动
          if (dir && typeof dir === "string" && existsSync(dir)) return { dir, source: "workingDirectory" }
        } catch {
          /* workingDirectory 没装载：继续下一级 */
        }
      }
      // agent 自带 cwd 的宿主（服务装配不同）：只在 workingDirectory 拿不到时才采用，
      // 免得它盖过更有权威的按会话映射
      const own = agent && typeof agent.cwd === "string" ? agent.cwd : null
      if (own && existsSync(own)) return { dir: own, source: "agent" }
    } catch {
      /* agents 没装载：继续下一级 */
    }
    // ② 工作目录服务的全局默认值（没有具体会话时也能用）
    try {
      const wd = ctx.get("workingDirectory")
      const dir = wd && wd.defaultDirectory
      if (dir && typeof dir === "string" && existsSync(dir)) return { dir, source: "defaultDirectory" }
    } catch {
      /* ignore */
    }
    // ③ 沙箱策略的工作区根（有就是权威）
    try {
      const policy = ctx.get("sandboxPolicy")
      if (policy && policy.workspaceRoot) return { dir: policy.workspaceRoot, source: "sandboxPolicy" }
    } catch {
      /* ignore */
    }
    return { dir: process.cwd(), source: "process.cwd" }
  }

  /** 只要目录（绝大多数调用方不关心它从哪一级来）。 */
  function defaultCwdFor(sid) {
    return defaultCwdInfo(sid).dir
  }

  // ─────────────────────────── 会话 ───────────────────────────

  class Session {
    constructor(sid) {
      this.sid = sid
      this.bus = new EventBus()
      /** 多 notebook：key -> Notebook（key 用绝对路径；未保存的用 untitled:N） */
      this.tabs = new Map()
      this.activeKey = null
      this.untitledSeq = 0
      this.sidecar = null
      this.sidecarReady = null
      this.waiters = new Map() // cellId -> [resolve]
      this.inflight = null // 已发出 execute 但还没收到 cell.started 的 cellId
      this.inflightAt = 0 // 上面那个 cell 发出去的时刻（给 pump 的卡死兜底用）
      this.stderr = []
      /**
       * 用户是否**显式**选过工作目录（notebook/setCwd）。
       *
       * 用来决定「打开 notebook 时要不要把内核 cwd 跟过去」：没显式选过就跟（这是
       * 用户对 Jupyter 的默认预期：notebook 在哪，相对路径就在哪），选过就不动
       * ——用户明确指定了位置，被一次「打开」悄悄改掉是最难查的那种错。
       */
      this.cwdExplicit = false
      /**
       * 内核变量快照（Kernel-aware Prompt 的数据源）。
       *
       * 做法：往内核发一次 `silent` 之外的普通 execute（`storeHistory:false`，不占 In[] 序号），
       * cellId 用保留名 `VAR_CELL`。它 display 出来的 JSON 会被 onSidecarEvent 截下来存这里；
       * 前端 `/nb2/vars` 直接读缓存。**前端不需要知道内核在哪**，也不需要额外的 Python 协议。
       * 保留 cellId 不对应任何真实单元格，所以前端 reduceEvent 找不到它就忽略（不会多画东西）。
       */
      this.varsCells = new Set()
      this.varsCache = { at: 0, vars: [], pending: null }
    }

    /** 当前活动 notebook（没有就建一个未保存的）。 */
    get notebook() {
      if (this.activeKey && this.tabs.has(this.activeKey)) return this.tabs.get(this.activeKey)
      const key = `untitled:${++this.untitledSeq}`
      const nb = new Notebook({ path: null })
      nb.__key = key
      this.tabs.set(key, nb)
      this.activeKey = key
      return nb
    }

    /** 兼容 routes 里的 `session.notebook = ...` 写法：落成标签并激活。 */
    set notebook(nb) {
      const key = nb.path || nb.__key || `untitled:${++this.untitledSeq}`
      nb.__key = key
      this.tabs.set(key, nb)
      this.activeKey = key
    }

    get activeNotebook() {
      return this.notebook
    }

    listTabs() {
      const out = []
      for (const [key, nb] of this.tabs) {
        out.push({
          key,
          path: nb.path,
          title: nb.title,
          cells: nb.cells.length,
          dirty: nb.revision > 0,
          active: key === this.activeKey,
        })
      }
      return out
    }

    activate(key) {
      if (!this.tabs.has(key)) return false
      this.activeKey = key
      return true
    }

    closeTab(key) {
      if (!this.tabs.has(key)) return false
      this.tabs.delete(key)
      if (this.activeKey === key) {
        const first = this.tabs.keys().next()
        this.activeKey = first.done ? null : first.value
      }
      return true
    }

    /**
     * 另存为之后把标签 key 迁到新路径。
     * 不做这一步的话：untitled:1 存成 a.ipynb 后，再 open a.ipynb 会**又开一个标签**
     * （tabs.has(path) 为 false），同一份文件出现两个标签，改哪个都不知道。
     */
    rekey(nb, path) {
      const prevKey = nb.__key || this.activeKey
      if (prevKey && prevKey !== path && this.tabs.get(prevKey) === nb) this.tabs.delete(prevKey)
      nb.path = path
      nb.__key = path
      this.tabs.set(path, nb)
      this.activeKey = path
      return path
    }

    /**
     * 这个会话用哪个解释器：显式选择（内核下拉）→ config.python → envsel（含父会话继承）
     * → conda 里第一个有 ipykernel 的 → PATH。**必须走这一层**，否则真机上会退化成
     * PATH 上的系统 python（没有 ipykernel），内核一起就死。
     */
    resolveInterpreter() {
      // 只有「用户显式选过」才走 kernelId 快路径
      if (this.kernelId) {
        const k = kernelById(this.kernelId)
        if (k && existsSync(k.python)) return { python: k.python, source: "selected", kernelId: k.id, display: k.display }
      }
      const r = resolvePython({ sessionId: this.sid, parents: sessionParents, configPython: cfg.python })
      // ⚠️ 自动探测（envsel/conda）的结果**不写回 this.kernelId**：
      // 写回会让「自动探测」和「用户显式选择」混成一个状态，之后 envsel 变更对本会话永久失效。
      if (r.warning) this.stderr.push(`[interpreter] ${r.warning}\n`)
      return r
    }

    /** 懒启动 sidecar；并发调用共享同一个启动 Promise。 */
    async ensureSidecar() {
      if (this.sidecar && this.sidecar.alive) return this.sidecar
      /**
       * 崩溃之后的三条路，必须分清（真机 2026-11-10：分不清就是「点运行永远没反应」）：
       *   ① 正在自动重启 → 等它回来，**绝不能**再 spawn 一个内核；
       *   ② 已彻底没了（崩溃循环/重启失败）→ 丢掉旧实例，下面重建；
       *   ③ 缓存 promise 指向一个已死实例 → 清掉缓存，否则每次都拿到死 sidecar。
       */
      if (this.sidecar) {
        const back = await this.sidecar.whenAlive()
        if (back && back.alive) return back
        this.sidecar = null
        this.sidecarReady = null
      }
      if (this.sidecarReady) {
        const cached = await this.sidecarReady.catch(() => null)
        if (cached && cached.alive) return cached
        this.sidecarReady = null
      }
      const interp = this.resolveInterpreter()
      this.interpreter = interp

      /**
       * 起内核前先真跑一次 `import ipykernel`（结果有缓存）。
       * 不这么做的话，选了没装 ipykernel 的环境会到内核启动阶段才炸，
       * 用户只看到一句 `No module named 'ipykernel'`（正是这一轮要修的报错），
       * 却不知道「哪个环境、还能选谁」。这里提前拦，并且把候选清单一起给出去。
       */
      const probe = probeIpykernel(interp.python)
      if (!probe.ok) {
        const usable = listKernels().filter((k) => k.hasIpykernel)
        const err = new Error(
          `解释器跑不了 ipykernel：${interp.python}（来源 ${interp.source}）\n` +
            `原因：${probe.detail || "import ipykernel 失败"}\n` +
            `可用的内核：${usable.length ? usable.map((k) => `${k.name}(${k.python})`).join("、") : "无"}\n` +
            `修法：在该环境执行 pip install ipykernel；或在 notebook 工具栏的「内核」下拉里换一个环境。`,
        )
        err.code = "E_IPYKERNEL_MISSING"
        this.bus.emit("kernel.state", { state: "dead", reason: "E_IPYKERNEL_MISSING" })
        this.bus.emit("interpreter.error", {
          python: interp.python,
          source: interp.source,
          detail: probe.detail,
          candidates: usable.map((k) => ({ id: k.id, name: k.name, python: k.python })),
        })
        throw err
      }

      const sidecar = new Sidecar({
        python: interp.python,
        // 显式 cwd 优先；没设就用「会话自己的工作目录」而不是进程 cwd
        cwd: cfg.cwd || this.cwd || defaultCwdFor(this.sid),
        // 大块输出落盘目录（`/nb2/spill` 从这里读回）
        spillDir: SPILL_DIR,
        sid: this.sid,
        eager: cfg.eager !== false,
        onEvent: (eventName, payload, frame) => this.onSidecarEvent(eventName, payload, frame),
        onStderr: (text) => {
          this.stderr.push(text)
          if (this.stderr.length > 50) this.stderr.shift()
        },
        onDeath: (info) => {
          // 崩溃循环 / 重启失败：内核彻底没了。同样要把在跑的格收尾（否则永远卡 running）。
          this.abortInflight(info)
          this.bus.emit("kernel.state", { state: "dead", reason: info.reason })
          this.bus.emit("sidecar.dead", { reason: info.reason, stderr: String(info.stderr || "").slice(-600) })
        },
      })
      this.sidecar = sidecar
      this.sidecarReady = sidecar
        .start()
        .then(() => sidecar)
        .catch((err) => {
          this.sidecarReady = null
          this.bus.emit("kernel.state", { state: "dead", reason: err && err.code })
          throw err
        })
      return this.sidecarReady
    }

    /** sidecar 事件 → 模型 → 总线。顺序在这里定形，UI 只按总线渲染。 */
    onSidecarEvent(eventName, payload) {
      const nb = this.notebook
      /**
       * 变量探针的保留通道（必须在 applyEvent 的「找不到单元格就丢弃」之前截获）：
       * 它的 stdout/text 拼成 JSON，`cell.done` 时解析进 varsCache。
       * 这条通路对前端完全不可见（保留 cellId 不对应任何真实单元格）。
       */
      if (this.varsCells.has(payload && payload.cellId)) {
        const c = this.varsCache
        if (eventName === "stream") {
          c.buf = (c.buf || "") + String(payload.text || "")
        } else if (eventName === "cell.done") {
          const raw = String(c.buf || "").trim()
          c.buf = ""
          const line = raw.split("\n").filter(Boolean).pop() || ""
          try {
            const parsed = JSON.parse(line)
            c.vars = Array.isArray(parsed && parsed.vars) ? parsed.vars : []
            c.at = Date.now()
          } catch {
            /* 探针失败就保持旧快照，不影响 AI 可用性 */
          }
          const resolve = c.pending
          c.pending = null
          if (resolve) resolve(c.vars)
        }
        return
      }
      // 这些是"元事件"，不进模型
      if (eventName === "stderr.log") {
        this.stderr.push(payload && payload.text)
        return
      }
      if (eventName === "sidecar.error") {
        this.bus.emit(eventName, payload)
        return
      }
      if (eventName === "sidecar.restarting") {
        // ⚠️ 顺序不能反：先把在跑的格收尾（会往模型里塞 error 块并广播），
        // 再把「内核重启了」这件事告诉前端。见 abortInflight 的注释。
        this.abortInflight(payload)
        this.bus.emit(eventName, payload)
        return
      }
      if (eventName === "kernel.state") {
        nb.applyEvent("kernel.state", payload)
        this.bus.emit("kernel.state", payload)
        return
      }

      const result = nb.applyEvent(eventName, payload)
      if (!result.applied) return

      switch (eventName) {
        case "cell.started":
          // 已经确认开跑：交棒给 nb.running 把关，inflight 的「等 started」职责结束。
          // 不清掉的话，中断/丢帧一旦发生在 started 之后、done 之前，闸门同样会卡死。
          if (this.inflight === payload.cellId) this.inflight = null
          // `at` 必须转发：前端拿它算「已跑多久」，不能自己 take 一个本地时间戳
          // （重连/切标签会重新拉快照，本地时间戳归零，计时器看起来在倒退）
          this.bus.emit("cell.started", {
            cellId: payload.cellId,
            execCount: payload.execCount,
            at: (nb.cell(payload.cellId) || {}).startedAt || Date.now(),
          })
          break
        case "stream":
          this.bus.emit("stream.append", {
            cellId: payload.cellId,
            outId: result.outId,
            name: payload.name || "stdout",
            text: payload.text,
          })
          break
        case "display":
          this.bus.emit(payload.update ? "display.update" : "display.data", {
            cellId: payload.cellId,
            outId: result.outId,
            mime: payload.mime,
            data: payload.data,
            kind: payload.kind,
            path: payload.path,
            // 落盘块的大小/截断标记也要转发：漏了它前端只能显示「0KB」
            bytes: payload.bytes,
            truncated: payload.truncated,
            displayId: payload.displayId,
          })
          break
        case "error":
          this.bus.emit("error", {
            cellId: payload.cellId,
            ename: payload.ename,
            evalue: payload.evalue,
            traceback: payload.traceback,
          })
          break
        case "cell.done": {
          this.bus.emit("cell.done", {
            cellId: payload.cellId,
            status: payload.status,
            durationMs: payload.durationMs,
            execCount: payload.execCount,
          })
          // 遇错停止：取消剩余（raises-exception 例外）
          if (payload.status === "error") {
            const { cancelled } = nb.onCellError(payload.cellId)
            for (const id of cancelled) {
              this.bus.emit("cell.done", { cellId: id, status: "cancelled" })
              // 取消的格也要唤醒等待者，否则 runAll 会挂到超时
              this.resolveWaiters(id, { cellId: id, status: "cancelled" })
            }
          }
          this.resolveWaiters(payload.cellId, payload)
          if (this.inflight === payload.cellId) this.inflight = null
          // 队列继续
          this.pump()
          break
        }
        case "cell.executed":
          this.bus.emit("cell.executed", payload)
          break
        default:
          this.bus.emit(eventName, payload)
      }
    }

    resolveWaiters(cellId, payload) {
      const list = this.waiters.get(cellId)
      if (!list) return
      this.waiters.delete(cellId)
      for (const resolve of list) resolve(payload)
    }

    waitForCell(cellId, timeoutMs = 180000) {
      return new Promise((resolve) => {
        const wrapped = (payload) => {
          clearTimeout(timer)
          resolve(payload)
        }
        const timer = setTimeout(() => {
          // 超时不要清掉 waiter：迟到的事件仍能 resolve（只是调用方已经走了）
          resolve({ cellId, status: "timeout" })
        }, timeoutMs)
        if (typeof timer.unref === "function") timer.unref()
        const list = this.waiters.get(cellId) || []
        list.push(wrapped)
        this.waiters.set(cellId, list)
      })
    }

    /**
     * 刷新内核变量快照并把摘要返回给调用方。
     *
     * @param {{maxAgeMs?:number, timeoutMs?:number}} [opts]
     * @returns {Promise<Array<{name:string,type:string,detail:string}>>}
     */
    async refreshVars(opts = {}) {
      const maxAge = Number(opts.maxAgeMs) || 8000
      const timeout = Number(opts.timeoutMs) || 3000
      const c = this.varsCache
      if (c.vars.length && Date.now() - c.at < maxAge) return c.vars
      // 已经有探针在跑：复用它，别把内核连发两次
      if (c.pending) return c.pending
      try {
        await this.ensureSidecar()
      } catch {
        return c.vars
      }
      return new Promise((resolve) => {
        let settled = false
        const done = (vars) => {
          if (settled) return
          settled = true
          // 超时/失败路径也要清掉 pending，否则后续请求会一直复用这个已经结束的 promise
          if (c.pending === done) c.pending = null
          resolve(vars)
        }
        c.pending = done
        const timer = setTimeout(() => done(c.vars), timeout)
        if (typeof timer.unref === "function") timer.unref()
        this.varsCells.add(VAR_CELL)
        /**
         * ⚠️ 必须用 `post` 而不是 `send`：
         * kernel_driver 只在**冷启动**时给 execute 补一个 ack（`if not started && op === "execute"`），
         * 内核已热时 handle() 里不再 ack —— 用 send() 会一直挂到 15s 超时才 reject。
         * post 是「发出去就不管回执」，正好符合这里的语义（结果以 stream + cell.done 为准）。
         */
        const ok = this.sidecar.post("execute", { code: VARS_PROBE, cellId: VAR_CELL, storeHistory: false, silent: false })
        if (!ok) done(c.vars)
      })
    }

    /**
     * 内核进程死了（崩溃 / 被强杀 / 重启）：把「在跑的那格」收尾，别留悬空状态。
     *
     * 为什么要专门做这件事（2026-11-10 真机事故）：驱动进程在写一条含 U+FFFD 的
     * 报错帧时被 GBK 编码打死，宿主只看到 `sidecar.restarting` 并自动重启内核。
     * 于是 UI 上是「内核 idle + 没有任何输出 + 没有任何报错 + 那一格一直在跑」，
     * 用户根本无法判断代码到底跑没跑 —— 报的就是「代码没运行」。
     *
     * 收尾顺序必须是 error → cell.done：状态机只允许 running → error，
     * 所以先确保落在 running（崩溃可能发生在 cell.started 之前，那时还是 queued）。
     */
    abortInflight(info = {}) {
      const nb = this.notebook
      const cellId = nb.running || this.inflight
      this.inflight = null
      // 队列里剩下的不再发：内核刚崩，继续送只会再崩一次。清成 idle，让用户自己决定重跑。
      const queued = nb.queue.slice()
      nb.queue = []
      for (const id of queued) {
        const c = nb.cell(id)
        if (c && c.status === "queued") nb.setStatus(c, "idle")
      }
      if (!cellId) return null
      const cell = nb.cell(cellId)
      if (!cell) {
        nb.running = null
        return null
      }
      if (cell.status !== "running") nb.setStatus(cell, "running")
      const code = info && info.code !== undefined && info.code !== null ? info.code : "?"
      const signal = info && info.signal ? ` / ${info.signal}` : ""
      const tail = String((info && info.stderr) || "").trim()
      const evalue =
        `内核进程在运行这一格时退出了（exit code ${code}${signal}）。内核已自动重启，本格需要重跑。` +
        (tail ? `\n\n驱动 stderr（最后一段）：\n${tail}` : "")
      this.onSidecarEvent("error", { cellId, ename: "KernelDied", evalue, traceback: [] })
      this.onSidecarEvent("cell.done", { cellId, status: "error", durationMs: null })
      return cellId
    }

    /** 队列泵：没有在跑的就去队列里取一个送执行。 */
    pump() {
      const nb = this.notebook
      // inflight 立刻置位：post 到收到 cell.started 之间有窗口，
      // 只看 nb.running 会让同一个 cell 被送两次（重复执行 = 用户最直观的"bug"）
      if (nb.running || this.inflight) {
        /**
         * 兜底：post 出去很久都没等到 cell.started（被中断打断、驱动卡死、丢帧），
         * 这个标记会把队列永久锁死 —— 界面上「点了运行没反应、也不报错」。
         * 超过 KERNEL_START_TIMEOUT_MS 就认账，把那格标成 error 并让队列继续走。
         */
        if (this.inflight && Date.now() - (this.inflightAt || 0) > KERNEL_START_TIMEOUT_MS) {
          const stuck = this.inflight
          this.inflight = null
          nb.queue = nb.queue.filter((id) => id !== stuck)
          const c = nb.cell(stuck)
          if (c && (c.status === "running" || c.status === "queued")) {
            if (c.status !== "running") nb.setStatus(c, "running")
            this.onSidecarEvent("error", {
              cellId: stuck,
              ename: "KernelTimeout",
              evalue: `内核 ${Math.round(KERNEL_START_TIMEOUT_MS / 1000)} 秒内没有开始执行这一格（没收到 cell.started）。` + `请重跑，或者用工具栏的「↻ 重启」重启内核。`,
              traceback: [],
            })
            this.onSidecarEvent("cell.done", { cellId: stuck, status: "error", durationMs: null })
          }
        } else {
          return
        }
      }
      const cellId = nb.next()
      if (!cellId) return
      const cell = nb.cell(cellId)
      if (!cell) return
      // shell 格不需要 Python 内核：先把队列让出来，别逼用户装 ipykernel
      if (cell.cellType === "bash") {
        nb.queue = nb.queue.filter((id) => id !== cellId)
        this.inflight = cellId
        this.inflightAt = Date.now()
        this.runShellCell(cell)
        return
      }
      if (!this.sidecar || !this.sidecar.alive) {
        // sidecar 没起来：先起再跑（首次会经历冷启动，UI 已收到 kernel.state=starting）
        this.ensureSidecar()
          .then(() => this.pump())
          .catch((err) => {
            nb.onCellError(cellId)
            this.bus.emit("error", { cellId, ename: "SidecarError", evalue: String(err && err.message) })
            this.bus.emit("cell.done", { cellId, status: "error" })
          })
        return
      }
      nb.queue = nb.queue.filter((id) => id !== cellId)
      this.inflight = cellId
      this.inflightAt = Date.now()
      this.sidecar.post("execute", { cellId, code: cell.source, storeHistory: true })
    }

    /**
     * 跑一个 shell 格。
     *
     * 关键点：**事件形状与 sidecar 完全一致**，所以直接复用 onSidecarEvent ——
     * 模型更新/总线广播/waiter 唤醒/队列续跑全都是现成的，一行都不用重写。
     * 代价是这里要自己编排顺序：started → stream* → (error) → done。
     */
    async runShellCell(cell) {
      const nb = this.notebook
      const cellId = cell.id
      this.shellSeq = (this.shellSeq || 0) + 1
      const execCount = this.shellSeq
      const session = this
      // 清掉上一次的 stream 复用记录：这次执行的输出要开一个新块，
      // 而不是继续往上次那个块尾巴上粘（同一次执行内部仍然复用，见 _onStream）
      cell.lastStream = null
      this.onSidecarEvent("cell.started", { cellId, execCount })
      const ac = new AbortController()
      this.shellAbort = ac
      try {
        const r = await runShell(cell.source, {
          cwd: this.cwd || cfg.cwd || defaultCwdFor(this.sid),
          kind: cfg.shell || "auto",
          signal: ac.signal,
          timeoutMs: Number(cfg.shellTimeoutMs) > 0 ? Number(cfg.shellTimeoutMs) : 0,
          onStdout: (text) => session.onSidecarEvent("stream", { cellId, name: "stdout", text }),
          onStderr: (text) => session.onSidecarEvent("stream", { cellId, name: "stderr", text }),
        })
        const bad = r.timedOut || r.killed || (typeof r.code === "number" && r.code !== 0)
        if (bad) {
          const ename = r.timedOut ? "ShellTimeout" : r.killed ? "ShellKilled" : "ShellError"
          const evalue = r.timedOut
            ? `超过 ${cfg.shellTimeoutMs}ms 未结束，已终止`
            : r.killed
              ? "已被中断"
              : `退出码 ${r.code}`
          // 中断只提示、不再画 error 块（interrupt 已经让 UI 把状态标成 cancelled；
          // 再塞一个 ShellKilled 红块，用户会以为自己代码写错了）
          if (!r.killed || r.timedOut) {
            this.onSidecarEvent("error", { cellId, ename, evalue, traceback: [] })
          }
        }
        this.onSidecarEvent("cell.done", {
          cellId,
          // 被中断 → cancelled（与 ipykernel 路径的中断语义一致），其余失败才是 error
          status: r.killed && !r.timedOut ? "cancelled" : bad ? "error" : "ok",
          durationMs: r.durationMs,
          execCount,
        })
      } catch (err) {
        this.onSidecarEvent("error", { cellId, ename: "ShellError", evalue: String((err && err.message) || err), traceback: [] })
        this.onSidecarEvent("cell.done", { cellId, status: "error", durationMs: 0, execCount })
      } finally {
        if (this.shellAbort === ac) this.shellAbort = null
      }
    }

    async runCell(cellId, source, timeoutMs) {
      const nb = this.notebook
      if (source !== undefined) nb.editCell(cellId, source)
      const cell = nb.cell(cellId)
      if (!cell) throw new Error(`no such cell: ${cellId}`)
      // markdown / raw 是文档格：Jupyter 里「运行」= 渲染，不产生执行记录
      if (!isRunnableCell(cell.cellType)) {
        return { cellId, status: "ok", skipped: true, cellType: cell.cellType }
      }
      nb.enqueue(cellId)
      const waiting = this.waitForCell(cellId, timeoutMs)
      this.pump()
      return waiting
    }

    async runAll() {
      const nb = this.notebook
      // markdown / raw 不跑；代码格与 shell 格按文档顺序
      const runnable = nb.cells.filter((c) => isRunnableCell(c.cellType))
      for (const cell of runnable) nb.enqueue(cell.id)
      this.pump()
      const results = await Promise.all(runnable.map((c) => this.waitForCell(c.id)))
      return results
    }

    async interrupt() {
      nb_cancel(this.notebook)
      /**
       * ⚠️ `inflight` 必须跟着清掉。
       *
       * 它记录「已经 post 出去、还没等到 cell.started」的那一格。被中断时驱动可能
       * **永远发不出这一格的任何事件**（SIGINT 在起执行之前就把它打断了），于是
       * `pump()` 的 `if (nb.running || this.inflight) return` 会一直把后面每一格挡在门外。
       * 用户看到的就是「点了运行，什么都不发生」，而且没有任何报错，只能重启内核才好 ——
       * 和 2026-11-10 报的「代码没运行」是同一类症状。
       */
      this.inflight = null
      // shell 格不在内核里，得单独杀
      if (this.shellAbort) {
        try {
          this.shellAbort.abort()
        } catch {
          /* ignore */
        }
      }
      // 20s：驱动在 Windows 上可能要把「中断没生效」降级成「重启内核」，
      // 那一步要 1.5s 观察窗 + 内核冷启动，5s 会误报超时
      if (this.sidecar) await this.sidecar.send("interrupt", {}, { timeoutMs: 20000 }).catch(() => {})
    }

    /** 重建 sidecar（换解释器 / 换工作目录时必须换进程）。 */
    async recycleSidecar() {
      this.notebook.cancelAll()
      this.inflight = null
      if (this.sidecar) this.sidecar.dispose()
      this.sidecar = null
      this.sidecarReady = null
      this.sidecar = await this.ensureSidecar()
      return this.sidecar
    }

    /** 内核下拉：换一个 conda 环境（会换进程并清掉「已死」状态）。 */
    async selectKernel(kernelId) {
      const k = kernelById(kernelId)
      if (!k) throw new Error(`unknown kernel: ${kernelId}`)
      if (!k.hasIpykernel) {
        throw new Error(`${k.name} 里没装 ipykernel（${k.python}）。请先 pip install ipykernel。`)
      }
      this.kernelId = kernelId
      this.interpreter = { python: k.python, source: "selected", kernelId, display: k.display }
      this.notebook.clearOutputs()
      for (const cell of this.notebook.cells) cell.execCount = null
      await this.recycleSidecar()
      this.bus.emit("nb.updated", { revision: 0, kernel: kernelId })
      return { ok: true, kernel: kernelId, python: k.python }
    }

    /** 工作目录：重启内核到新 cwd（jupyter 的 cwd 只在启动时生效）。 */
    async setCwd(dir) {
      if (!dir || typeof dir !== "string") throw new Error("dir required")
      if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`)
      this.cwd = dir
      await this.recycleSidecar()
      this.bus.emit("nb.updated", { revision: 0, cwd: dir })
      return { ok: true, cwd: dir }
    }

    async restart({ clear = false, runAll = false } = {}) {
      const nb = this.notebook
      nb.cancelAll()
      if (clear) {
        nb.clearOutputs()
        for (const cell of nb.cells) cell.execCount = null
      }
      if (this.sidecar) await this.sidecar.send("restart", { now: true }, { timeoutMs: 40000 }).catch(() => {})
      if (runAll) {
        // 「重启并运行全部」由 Node 编排（内核只提供 restart）
        return this.runAll()
      }
      return { ok: true }
    }

    dispose() {
      if (this.sidecar) this.sidecar.dispose()
      this.sidecar = null
      this.sidecarReady = null
      this.waiters.clear()
    }

    state() {
      const nb = this.notebook
      const snap = nb.snapshot()
      return Object.assign(snap, {
        sid: this.sid,
        key: this.activeKey,
        tabs: this.listTabs(),
        bus: this.bus.snapshot(),
        cwd: this.cwd || cfg.cwd || defaultCwdFor(this.sid),
        kernel: {
          state: nb.kernelState,
          kernelId: this.kernelId || null,
          python: this.interpreter ? this.interpreter.python : null,
          source: this.interpreter ? this.interpreter.source : null,
          display: this.interpreter ? this.interpreter.display : null,
        },
        sidecar: this.sidecar ? { alive: this.sidecar.alive, pid: this.sidecar.pid, started: this.sidecar.started } : null,
        stderrTail: this.stderr.join("").slice(-800),
      })
    }
  }

  /** 中断时把队列里排着的标成 cancelled（内核不会再回它们的 execute_reply）。 */
  function nb_cancel(nb) {
    nb.cancelAll()
  }

  function sessionFor(sid) {
    let s = sessions.get(sid)
    if (!s) {
      s = new Session(sid || "default")
      sessions.set(s.sid, s)
    }
    return s
  }

  // ─────────────────────────── HTTP ───────────────────────────

  function sendJson(res, value, status) {
    res.statusCode = status || 200
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.setHeader("Cache-Control", "no-store")
    res.end(JSON.stringify(value))
  }

  /**
   * 规范化路径用于子树比较。
   * win32 是大小写不敏感的（同一个文件 `D:\A` 与 `d:\a` 都能打开），
   * 比较前统一小写，避免「大小写不同就被判成越界」。
   */
  function normCase(p) {
    const s = normalize(p)
    return process.platform === "win32" ? s.toLowerCase() : s
  }

  /**
   * target 是否在 base 子树内（含 base 本身）。
   *
   * ⚠️ **不能用 `startsWith`**：`C:\foo` 是 `C:\foobar` 的前缀，会把兄弟目录
   * 判成子目录（这正是「读到了不该读的文件」这类漏洞的经典写法）。
   * `path.relative` 给的是「从 base 怎么走到 target」：以 `..` 开头或本身是绝对路径
   * （跨盘符 / UNC 另一台机器）就是越界。
   */
  function withinSubtree(base, target) {
    const rel = relative(normCase(base), normCase(target))
    if (!rel) return true // 同一个路径
    if (rel === ".." || rel.startsWith(".." + sep)) return false
    return !isAbsolute(rel)
  }

  /**
   * 把一个文件读出来发出去（静态资源与 /file 共用）。
   * `nosniff`：别让浏览器把 .txt 猜成 HTML 执行（/file 能喂任意用户文件）。
   */
  function sendFile(req, res, absPath, mime, cacheControl) {
    let body
    try {
      body = readFileSync(absPath)
    } catch {
      return sendJson(res, { error: "not found" }, 404)
    }
    res.statusCode = 200
    res.setHeader("Content-Type", mime)
    res.setHeader("Content-Length", body.length)
    res.setHeader("Cache-Control", cacheControl)
    res.setHeader("X-Content-Type-Options", "nosniff")
    // SVG 是**能带 <script> 的图片**：客户端用 <img> 渲染是安全的，但用户若直接打开
    // 这个 URL，脚本就会跑在 DSH 自己的源上。sandbox + default-src 'none' 把脚本、
    // 外链、表单全掐掉，只留内联样式（否则 SVG 自己的 fill 规则会失效）。
    if (mime === "image/svg+xml") {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    }
    return res.end(req.method === "HEAD" ? undefined : body)
  }

  /**
   * 递归列举 root 下的 .ipynb 与子目录（客户端 picker 的数据源）。
   *
   * 四条硬约束：
   *  - **文件与目录分离预算**（500 / 150）：共用一个上限时，目录多的仓库会把预算
   *    吃光，picker 里一条 notebook 都看不到（真机实测 files=0 / dirs=500）；
   *  - **广度优先**遍历：层级浅的先出，picker 顶部永远是「离根近的」东西，
   *    不会被某个深目录里的一次性几百个条目挤掉；
   *  - **符号链接一律不跟**（lstat 判定）：目录链接/junction 能指回自己，递归会成环，
   *    也能把用户整个家目录列出来；黑名单目录（node_modules/.venv…）同样直接剪掉；
   *  - 每条单独 try/catch：一个 EACCES 子目录不能把整个请求变成 500。
   *
   * 输出顺序：先 notebook（按 rel 字典序），后目录（BFS 序）。
   */
  function listNotebooks(root, depthAsked) {
    // ⚠️ 「没传」不能当 0：searchParams.get 缺失时给 null，Number(null) === 0 会让默认
    // 深度变成 0（只列根目录），而契约是「默认 2、上限 4」。
    const raw = depthAsked === null || depthAsked === undefined || depthAsked === "" ? NaN : Number(depthAsked)
    const depthLimit = Math.max(0, Math.min(LIST_MAX_DEPTH, Number.isFinite(raw) ? Math.trunc(raw) : 2))
    /** @type {Array<{path:string, rel:string, dir:boolean, mtime:number, size:number}>} */
    const files = []
    const dirs = []
    let filesTruncated = false
    let dirsTruncated = false

    // BFS：队列里存（目录, 深度）。用下标推进而不是 shift()（大目录树上 shift 是 O(n²)）
    const queue = [{ dir: root, depth: 0 }]
    for (let qi = 0; qi < queue.length; qi += 1) {
      // 两类都满了才停：目录预算满了也要继续往下找 notebook，否则深层的仍然看不见
      if (filesTruncated && dirsTruncated) break
      const { dir, depth } = queue[qi]
      let names
      try {
        names = readdirSync(dir)
      } catch {
        continue // EACCES / EPERM / ENOENT：跳过这个子树，不中断整次列举
      }
      // 同一层内按名字排序：readdir 的顺序随文件系统变，客户端要稳定列表才能键盘上下选
      names.sort()
      for (const name of names) {
        const full = join(dir, name)
        let st
        try {
          st = lstatSync(full) // lstat：链接本身的信息，不是它指向的东西
        } catch {
          continue
        }
        if (st.isSymbolicLink()) continue // 不跟随：会成环，也会漏出 root 之外
        if (st.isDirectory()) {
          if (LIST_SKIP_DIRS.has(name)) continue
          if (dirs.length < LIST_MAX_DIRS) {
            dirs.push({ path: full, rel: relative(root, full), dir: true, mtime: st.mtimeMs || 0, size: 0 })
          } else {
            dirsTruncated = true
          }
          // 入队与「有没有进列表」无关：里面的 notebook 仍然要能找到
          if (depth < depthLimit) queue.push({ dir: full, depth: depth + 1 })
        } else if (st.isFile() && name.toLowerCase().endsWith(".ipynb")) {
          if (files.length < LIST_MAX_FILES) {
            files.push({ path: full, rel: relative(root, full), dir: false, mtime: st.mtimeMs || 0, size: st.size })
          } else {
            filesTruncated = true
          }
        }
      }
    }

    // 排序固定：notebook 按 rel 字典序（BFS 序对文件没有意义）；目录保持 BFS 序
    files.sort((a, b) => a.rel.localeCompare(b.rel))
    return {
      entries: files.concat(dirs),
      truncated: filesTruncated || dirsTruncated,
      filesTruncated,
      dirsTruncated,
      depth: depthLimit,
    }
  }

  /**
   * 把客户端/用户给的路径解析成绝对路径。
   *
   * ⚠️ 相对路径**不能**交给 fs 去解析：`readIpynbFile` 内部是 `readFile(path)`，
   * 它按 `process.cwd()` 解析 —— 实测那是 DSH 的 profile 目录，不是工作区，
   * 于是 picker 传相对路径时必然「文件不存在」，另存为还会写进 DSH 自己的档案目录。
   * 统一在这里按「会话自己的工作目录」解析。
   */
  function resolveUserPath(sid, p) {
    const raw = String(p == null ? "" : p)
    if (!raw) return ""
    return isAbsolute(raw) ? resolve(raw) : resolve(defaultCwdFor(sid), raw)
  }

  /** DSH 的 profile 目录（相对路径的写操作绝不该落进来）。 */
  function profileRootDir() {
    try {
      if (process.env.DSH_PROFILE_DIR) return resolve(process.env.DSH_PROFILE_DIR)
    } catch {
      /* ignore */
    }
    try {
      return join(homedir(), ".dsh", "profiles", process.env.DSH_PROFILE || "desktop")
    } catch {
      return null
    }
  }

  /**
   * 相对路径的写操作不许落进 profile 目录。
   *
   * 为什么拦：一旦默认目录退化成 process.cwd()（就是 profile 目录），
   * 「另存为 report.ipynb」会把文件写进 DSH 自己的档案目录，用户既找不到也删不干净。
   * 显式绝对路径不拦 —— 那是用户明确指定了位置。
   */
  function profileWriteBlock(rawPath, resolvedPath) {
    if (!rawPath || isAbsolute(String(rawPath))) return null
    const profile = profileRootDir()
    if (profile && withinSubtree(profile, resolvedPath)) {
      return `相对路径会写进 DSH 档案目录（${profile}）。请用绝对路径，或先在工具栏里选择工作目录。`
    }
    return null
  }

  /**
   * 「这个会话的 notebook 在哪个目录」= /nb2/file 的 base，**由服务端推导**。
   *
   * ⚠️ 绝不能让客户端传 base：客户端能给任意目录，子树校验就恒成立，
   * 这个端点会退化成「任意本地文件读取器」。base 只能来自会话状态。
   */
  function notebookDirFor(session, sid) {
    try {
      const nb = session && session.activeKey ? session.tabs.get(session.activeKey) : null
      if (nb && nb.path) return dirname(String(nb.path))
    } catch {
      /* 活动标签不可用：退回会话工作目录 */
    }
    return defaultCwdFor(sid)
  }

  function readJson(req) {
    return new Promise((resolve) => {
      let data = ""
      req.on("data", (chunk) => {
        data += chunk
        if (data.length > 4e6) req.destroy()
      })
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch {
          resolve({})
        }
      })
      req.on("error", () => resolve({}))
    })
  }

  function authorized(req, url) {
    if (!cfg.token) return true
    return req.headers["x-nb2-token"] === cfg.token || url.searchParams.get("token") === cfg.token
  }

  function handleEvents(req, res, url) {
    const sid = url.searchParams.get("sid") || "default"
    const after = Number(url.searchParams.get("after") || 0) || 0
    const lastId = Number(req.headers["last-event-id"] || 0) || 0
    const cursor = Math.max(after, lastId)
    const session = sessionFor(sid)
    const bus = session.bus

    res.statusCode = 200
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    if (typeof res.flushHeaders === "function") res.flushHeaders()
    res.write("retry: 2000\n\n")
    res.write(`event: hello\ndata: ${JSON.stringify({ sid, seq: bus.seq, minSeq: bus.minSeq })}\n\n`)

    if (bus.needsResync(cursor)) {
      res.write(`event: resync\ndata: ${JSON.stringify({ minSeq: bus.minSeq, seq: bus.seq })}\n\n`)
    }
    for (const frame of bus.replay(cursor)) {
      res.write(`id: ${frame.seq}\nevent: nb\ndata: ${JSON.stringify(frame)}\n\n`)
    }

    const client = {
      cursor: Math.max(cursor, bus.seq),
      write(frame) {
        res.write(`id: ${frame.seq}\nevent: nb\ndata: ${JSON.stringify(frame)}\n\n`)
      },
    }
    const removeClient = bus.addClient(client)

    const hb = setInterval(() => {
      try {
        res.write(": keep-alive\n\n")
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS)
    if (typeof hb.unref === "function") hb.unref()

    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(hb)
      removeClient()
    }
    req.on("close", cleanup)
    req.on("error", cleanup)
    res.on("close", cleanup)
    res.on("error", cleanup)
  }

  /**
   * ⚠️ 宿主调用约定是 `handler(req, res)` —— **只给两个参数**。
   * 千万不要写成 `handler(req, res, url)` 并在里面直接用 url：
   * 测试里自己传了第三个参数会掩盖这个问题，真机上每个请求都会抛
   * `Cannot read properties of undefined (reading 'pathname')`，UI 表现为
   * 「打开/新建都没反应 + 顶部一条莫名报错」。
   * URL 一律在这里自己解析。
   */
  async function handler(req, res) {
    const url = new URL(req.url || "/", "http://localhost")
    try {
      const route = url.pathname.replace(/^\/nb2\/?/, "")
      if (!authorized(req, url)) return sendJson(res, { error: "unauthorized" }, 401)

      if (route === "health") {
        const list = []
        for (const [sid, s] of sessions) {
          list.push(Object.assign({ sid }, s.bus.snapshot()))
        }
        // 自证字段：`curl '/nb2/health?sid=<真实会话>'` 就能看出「打开 notebook 的
        // 默认目录」取到了哪一级（agent / workingDirectory / defaultDirectory /
        // sandboxPolicy / process.cwd）。取错目录时内核也能起，只是相对路径全错，
        // 没有这个字段就只能靠猜。
        const healthSid = String(url.searchParams.get("sid") || "default")
        const cwdInfo = defaultCwdInfo(healthSid)
        return sendJson(res, {
          ok: true,
          pkg: name,
          version: PKG_VERSION,
          uptimeMs: Date.now() - startedAt,
          logCap: sessions.size ? [...sessions.values()][0].bus.logCap : 0,
          heartbeatMs: HEARTBEAT_MS,
          sessions: list,
          dir: cwdInfo.dir,
          dirSource: cwdInfo.source,
        })
      }

      if (route === "events") return handleEvents(req, res, url)

      /**
       * 大块输出的读回通道：图片/HTML 落盘后，前端用 `<img src="/nb2/spill?path=...">` 拿回来，
       * 而不是只显示一行「已落盘」。
       *
       * 这是**唯一**一个「query 里的绝对路径直接读文件」的端点，所以必须用 withinSubtree
       * 把范围卡在 spill 根目录里（`path.relative` 判越界，不能用 startsWith）。
       */
      if (route === "spill") {
        const raw = String(url.searchParams.get("path") || "").trim()
        if (!raw) return sendJson(res, { error: "path required" }, 400)
        const abs = resolve(raw)
        if (!withinSubtree(SPILL_DIR, abs)) return sendJson(res, { error: "forbidden" }, 403)
        const mime = SPILL_MIME[extname(abs).toLowerCase()] || "application/octet-stream"
        return sendFile(req, res, abs, mime, "no-store")
      }

      // CodeMirror + KaTeX 的 vendor 包：客户端用 <script src="/nb2/vendor.js"> 拉一次
      if (route === "vendor.js") {
        if (!existsSync(VENDOR_PATH)) {
          return sendJson(res, { error: "vendor missing: run scripts/build-cm-vendor.mjs" }, 404)
        }
        const body = readFileSync(VENDOR_PATH)
        res.statusCode = 200
        res.setHeader("Content-Type", "application/javascript; charset=utf-8")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Accept-Ranges", "none")
        return res.end(body)
      }

      // KaTeX 的样式：客户端按需 <link href="/nb2/katex.css"> 拉一次。
      // 缺 CSS 时公式不是「没渲染」，而是**渲染出来但错版**（无字体无间距）——
      // 这种静默降级最难发现，所以缺资源要明确 404 而不是回一份空样式。
      // 构建脚本已把 CSS 里 woff/ttf 的回退段删掉、字体地址改写成 /nb2/fonts/…，
      // 所以这里原样发出去即可，不需要运行时再改。
      if (route === "katex.css") {
        const css = join(KATEX_DIR, "katex.css")
        if (!existsSync(css)) {
          return sendJson(res, { error: "katex css missing: run scripts/build-cm-vendor.mjs" }, 404)
        }
        return sendFile(req, res, css, "text/css; charset=utf-8", "public, max-age=86400")
      }

      // KaTeX 字体：文件名由改写后的 CSS 决定（绝对路径 /nb2/fonts/KaTeX_xxx.woff2），
      // 一律 immutable —— 字体文件名带字重/字形，内容变了文件名也会变，缓存可以永久。
      if (route === "fonts" || route.startsWith("fonts/")) {
        const fontsDir = join(KATEX_DIR, "fonts")
        let name = route.slice("fonts".length).replace(/^\/+/, "")
        try {
          name = decodeURIComponent(name)
        } catch {
          return sendJson(res, { error: "bad font name" }, 400)
        }
        // 白名单扩展名：这里只该有 woff2，别的类型一律拒绝（防被当成通用文件读取器）
        const ext = extname(name).toLowerCase()
        if (!FONT_MIME[ext]) return sendJson(res, { error: "font type not allowed" }, 403)
        // normalize 后再校验仍在本目录内：`../../index.js` 这类要先被词法拦住
        const target = normalize(join(fontsDir, name))
        if (!withinSubtree(fontsDir, target)) return sendJson(res, { error: "forbidden" }, 403)
        return sendFile(req, res, target, FONT_MIME[ext], "public, max-age=31536000, immutable")
      }

      const body = req.method === "POST" ? await readJson(req) : {}
      const sid = String(body.sid || url.searchParams.get("sid") || "default")
      const session = sessionFor(sid)

      // ── 只读状态：SSE 断开时的轮询降级目标 ──
      if (route === "state") return sendJson(res, session.state())

      // ── 标签页列表（老客户端与 kernel.mjs/smoke.mjs 的既有契约，语义不要动）──
      if (route === "notebooks") return sendJson(res, { ok: true, tabs: session.listTabs(), active: session.activeKey })

      // ── 目录列举（客户端 picker 的数据源）──
      // 独立成 /nb2/fs/list：`/nb2/notebooks` 已经是「标签页列表」，
      // 两者共用一个名字只能靠「带没带参数」猜语义，凭空多一类难查的 bug。
      if (route === "fs/list") {
        const cwd = defaultCwdFor(sid)
        const asked = url.searchParams.get("dir") || (typeof body.dir === "string" ? body.dir : "")
        const abs = asked ? resolve(cwd, String(asked)) : cwd
        let st
        try {
          st = statSync(abs)
        } catch {
          return sendJson(res, { ok: false, error: "no such dir", cwd, dir: abs, entries: [] }, 404)
        }
        if (!st.isDirectory()) {
          return sendJson(res, { ok: false, error: "not a directory", cwd, dir: abs, entries: [] }, 400)
        }
        // realpath 之后才递归：目录可能是链接，条目里的 path 要能和「打开」对得上
        let root = abs
        try {
          root = realpathSync(abs)
        } catch {
          /* 拿不到 realpath 就按原样列，仍然能列 */
        }
        const out = listNotebooks(root, url.searchParams.get("depth"))
        // truncated 保留（两类任一被截断就为 true）；再给两个细分标记，
        // 客户端才能分别提示「还有更多 notebook」/「还有更多目录」。
        return sendJson(res, {
          ok: true,
          root,
          cwd,
          dir: root,
          entries: out.entries,
          truncated: out.truncated,
          filesTruncated: out.filesTruncated,
          dirsTruncated: out.dirsTruncated,
          depth: out.depth,
        })
      }

      // ── 读 notebook 目录下的图片 / 文本（md 里的相对图片走这里）──
      if (route === "file") {
        if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "GET only" }, 405)
        const pathQ = url.searchParams.get("path")
        if (!pathQ) return sendJson(res, { error: "path required" }, 400)
        // ⚠️ base **不接受客户端参数**：客户端能给任意目录，子树校验就恒成立，
        // 这个端点会变成「任意本地文件读取器」。base 只能从会话状态推导。
        const base = notebookDirFor(session, sid)
        // path 允许相对（相对 base）也允许绝对；两种都要过下面两道校验
        const target = isAbsolute(pathQ) ? resolve(pathQ) : resolve(base, pathQ)

        /**
         * 两道校验，顺序不能反：
         * ① 词法 containment：越界目标**常常根本不存在**（Windows 上没有 /etc/passwd），
         *    先 realpath 会得到 ENOENT → 变成 404，把「有人试图穿越」伪装成「文件没找到」。
         *    这里先按路径语义判 403。
         * ② realpath containment：词法在子树内但实际是**指向外面的符号链接/junction**，
         *    只有解析出真实路径才拦得住。
         */
        if (!withinSubtree(base, target)) return sendJson(res, { error: "forbidden: outside notebook dir" }, 403)

        let realBase
        try {
          realBase = realpathSync(base)
        } catch {
          return sendJson(res, { error: "base not found" }, 404)
        }
        let realTarget
        try {
          realTarget = realpathSync(target)
        } catch (err) {
          const denied = err && (err.code === "EACCES" || err.code === "EPERM")
          return sendJson(res, { error: denied ? "forbidden" : "not found" }, denied ? 403 : 404)
        }
        if (!withinSubtree(realBase, realTarget)) return sendJson(res, { error: "forbidden: outside notebook dir" }, 403)

        let st
        try {
          st = statSync(realTarget)
        } catch {
          return sendJson(res, { error: "not found" }, 404)
        }
        if (!st.isFile()) return sendJson(res, { error: "not a file" }, 403)
        const ext = extname(realTarget).toLowerCase()
        const mime = IMAGE_MIME[ext] || TEXT_MIME[ext]
        // 只服务「图片 + 文本」：这是个预览端点，不该变成任意文件读取器
        if (!mime) return sendJson(res, { error: `unsupported file type: ${ext || "(none)"}` }, 415)
        if (st.size > FILE_MAX_BYTES) {
          return sendJson(res, { error: `file too large: ${st.size}`, max: FILE_MAX_BYTES }, 413)
        }
        return sendFile(req, res, realTarget, mime, "private, max-age=60")
      }

      // ── notebook 生命周期 ──
      if (route === "notebook/activate") {
        const ok = session.activate(String(body.key || ""))
        return ok ? sendJson(res, session.state()) : sendJson(res, { error: "no such tab" }, 404)
      }
      if (route === "notebook/close") {
        const ok = session.closeTab(String(body.key || ""))
        session.bus.emit("nb.updated", { revision: 0, closed: body.key })
        return ok ? sendJson(res, session.state()) : sendJson(res, { error: "no such tab" }, 404)
      }
      if (route === "notebook/new") {
        const nb = new Notebook({ path: body.path || null, title: body.title || null })
        nb.addCell("code", "")
        session.notebook = nb
        // 新建的 notebook 没有所在目录：内核 cwd 用会话工作目录（不是 profile 目录）
        if (!session.cwdExplicit) session.cwd = defaultCwdFor(sid)
        session.bus.emit("nb.updated", { revision: nb.revision, path: nb.path })
        return sendJson(res, session.state())
      }
      if (route === "notebook/open") {
        // 相对路径按**会话工作目录**解析：picker 传的是相对路径，而 ipynb.js 内部是
        // `readFile(path)`（按 process.cwd() 解析 = DSH 的 profile 目录），会必然打不开。
        const path = resolveUserPath(sid, body.path)
        if (!path) return sendJson(res, { error: "path required" }, 400)
        // 已经开着就只切过去：重载会丢掉未保存的编辑
        if (session.tabs.has(path)) {
          session.activate(path)
          return sendJson(res, session.state())
        }
        let nb
        try {
          nb = await readIpynbFile(path)
        } catch (err) {
          // picker 里的条目可能刚被别人删掉：给 404 而不是 500（500 看起来像插件坏了）
          if (err && err.code === "ENOENT") return sendJson(res, { error: `not found: ${path}`, path }, 404)
          throw err
        }
        session.notebook = nb
        // 内核 cwd 跟随 notebook：否则用户在 profile 目录里跑 read_csv("data.csv") 必失败。
        // 用户显式 setCwd 过就不动他的选择。
        if (!session.cwdExplicit) session.cwd = dirname(path)
        session.bus.emit("nb.updated", { revision: nb.revision, path })
        return sendJson(res, session.state())
      }
      if (route === "notebook/save") {
        const nb = session.notebook
        const rawPath = String(body.path || nb.path || "")
        const path = resolveUserPath(sid, rawPath)
        if (!path) return sendJson(res, { error: "no path" }, 400)
        const blocked = profileWriteBlock(rawPath, path)
        if (blocked) return sendJson(res, { error: blocked }, 400)
        // 同名文件已开在别的标签里：先合过去，避免两份内存状态互相覆盖
        const existing = session.tabs.get(path)
        if (existing && existing !== nb) session.tabs.delete(path)
        const bytes = await writeIpynbFile(path, notebookToIpynb(nb))
        session.rekey(nb, path)
        nb.revision = 0
        session.bus.emit("nb.updated", { revision: 0, path })
        return sendJson(res, { ok: true, path, bytes })
      }
      // 另存为：与 save 的唯一区别是「目标路径与当前不同也算成功」，并把标题换掉
      if (route === "notebook/saveAs") {
        const nb = session.notebook
        const rawPath = String(body.path || "")
        const path = resolveUserPath(sid, rawPath)
        if (!path) return sendJson(res, { error: "path required" }, 400)
        // 相对路径不许落进 DSH 的档案目录（见 profileWriteBlock）
        const blocked = profileWriteBlock(rawPath, path)
        if (blocked) return sendJson(res, { error: blocked }, 400)
        const bytes = await writeIpynbFile(path, notebookToIpynb(nb))
        session.rekey(nb, path)
        nb.title = path.split(/[\\/]/).pop()
        nb.revision = 0
        session.bus.emit("nb.updated", { revision: 0, path })
        return sendJson(res, { ok: true, path, bytes, tabs: session.listTabs() })
      }

      // ── cell 操作 ──
      if (route === "cell/add") {
        const cell = session.notebook.addCell(body.cellType || "code", body.source || "", {
          after: body.after || null,
          index: typeof body.index === "number" ? body.index : null,
        })
        session.bus.emit("nb.updated", { revision: session.notebook.revision })
        return sendJson(res, { ok: true, cell: { id: cell.id, cellType: cell.cellType, source: cell.source } })
      }
      if (route === "cell/edit") {
        // 只有 cellType（没有 source）= 换类型，走 setCellType（会顺手清掉已无意义的输出）
        let cell
        if (typeof body.source !== "string" && body.cellType) {
          cell = session.notebook.setCellType(body.cellId, body.cellType)
        } else {
          cell = session.notebook.editCell(body.cellId, body.source, { cellType: body.cellType })
        }
        if (!cell) return sendJson(res, { error: "no such cell" }, 404)
        // ⚠️ 换类型也必须让 .ipynb 重写这个格：code→bash 要在前面贴 %%bash，
        // bash→code 要把魔法行去掉。不置脏的话写回会保留旧序列化（真错）。
        cell.sourceDirty = true
        session.bus.emit("nb.updated", { revision: session.notebook.revision })
        return sendJson(res, { ok: true, cell: { id: cell.id, cellType: cell.cellType } })
      }
      if (route === "cell/delete") {
        const ok = session.notebook.deleteCell(body.cellId)
        session.bus.emit("nb.updated", { revision: session.notebook.revision })
        return sendJson(res, ok ? { ok: true } : { error: "no such cell" }, ok ? 200 : 404)
      }
      if (route === "cell/move") {
        const ok = session.notebook.moveCell(body.cellId, Number(body.toIndex ?? 0))
        session.bus.emit("nb.updated", { revision: session.notebook.revision })
        return sendJson(res, ok ? { ok: true } : { error: "no such cell" }, ok ? 200 : 404)
      }
      if (route === "cell/clearOutputs") {
        session.notebook.clearOutputs(body.cellId || null)
        session.bus.emit("nb.updated", { revision: session.notebook.revision })
        return sendJson(res, { ok: true })
      }
      /**
       * 合并本格与下一格（Jupyter `Shift-M`）。
       *
       * 必须走宿主：客户端「先改源码再删下一格」两步不原子，中间失败会**静默丢内容**。
       */
      if (route === "cell/merge") {
        const out = session.notebook.mergeWithNext(body.cellId)
        if (!out || !out.ok) {
          return sendJson(res, { error: (out && out.reason) || "merge failed" }, out && out.reason === "no next cell" ? 409 : 404)
        }
        session.bus.emit("nb.updated", {
          revision: session.notebook.revision,
          source: "agent",
          cellId: out.cell.id,
          op: "merge",
        })
        return sendJson(res, { ok: true, cell: { id: out.cell.id, cellType: out.cell.cellType, source: out.cell.source } })
      }

      // ── 执行 ──
      if (route === "cell/run") {
        const cellId = String(body.cellId || "")
        if (!cellId) return sendJson(res, { error: "cellId required" }, 400)
        const p = session.runCell(cellId, body.source)
        if (body.wait === false) return sendJson(res, { ok: true, queued: cellId })
        const done = await p
        const cell = session.notebook.cell(cellId)
        return sendJson(res, { ok: true, done, cell: cell ? summarizeCell(cell) : null })
      }
      if (route === "runAll") {
        const results = await session.runAll()
        return sendJson(res, { ok: true, results })
      }
      if (route === "kernel/interrupt") {
        await session.interrupt()
        return sendJson(res, { ok: true })
      }
      if (route === "kernel/restart") {
        const out = await session.restart({ clear: !!body.clear, runAll: !!body.runAll })
        return sendJson(res, { ok: true, result: out })
      }

      // ── 内核选择 / 工作目录（对齐旧插件工具栏） ──
      if (route === "kernels") {
        const cur = session.kernelId || null
        /**
         * 「我没选内核时，到底会用谁？」——前端必须答得出来，否则下拉只能显示
         * 一个「选择内核…」的占位符，用户不知道现在能不能直接跑。
         *
         * 这里不复用 `session.resolveInterpreter()`：那个方法会把 warning 追加进
         * session.stderr（每刷一次 /kernels 就多一条，诊断越来越脏）。语义保持一致：
         * 显式选择 > config.python > envsel > conda > PATH。
         */
        let resolved = null
        try {
          if (cur) {
            const k = kernelById(cur)
            if (k) {
              resolved = { python: k.python, source: "selected", kernelId: k.id, display: k.display, warning: null }
            }
          }
          if (!resolved) {
            const r = resolvePython({ sessionId: sid, parents: sessionParents, configPython: cfg.python })
            resolved = {
              python: r.python,
              source: r.source,
              kernelId: r.kernelId || null,
              display: r.display || null,
              warning: r.warning || null,
            }
          }
        } catch {
          resolved = null
        }
        return sendJson(res, {
          ok: true,
          kernels: listKernels(),
          current: cur,
          python: session.interpreter ? session.interpreter.python : resolved ? resolved.python : null,
          resolved,
          cwd: session.cwd || cfg.cwd || defaultCwdFor(sid),
        })
      }
      if (route === "kernel/select") {
        const out = await session.selectKernel(String(body.kernelId || ""))
        return sendJson(res, out)
      }
      if (route === "notebook/setCwd") {
        const out = await session.setCwd(String(body.dir || ""))
        // 显式选过就算「用户拍板」：之后打开 notebook 不再自动改 cwd
        session.cwdExplicit = true
        return sendJson(res, out)
      }
      if (route === "diagnostics") return sendJson(res, kernelDiagnostics())

      // ── 内核变量快照（Kernel-aware Prompt 的数据源）──
      // 前端拿它填 AI 条上的「变量 N」胶囊，并随请求一起发给模型。
      if (route === "vars") {
        let vars = []
        try {
          const ms = Number(new URL(req.url || "/", "http://localhost").searchParams.get("maxAge")) || 8000
          vars = await session.refreshVars({ maxAgeMs: ms })
        } catch {
          vars = []
        }
        return sendJson(res, { ok: true, vars, at: session.varsCache.at || null })
      }

      // ── AI 内联建议（M4）──
      // 用 POST + NDJSON：一次带代码与指令的请求，浏览器 fetch 读流即可逐字显示。
      /**
       * 设置栏数据源：**全部** provider × 模型。
       * 用户明确要求「都列出来，让用户自己选」，所以这里不做任何白名单裁剪 ——
       * 权威只有宿主 `llm.listProviders()` / `listModels()`。
       * 同时回带当前生效的 target（设置栏没选过时用它做默认选中项）。
       */
      if (route === "ai/models") {
        const llm = ctx.get("llm")
        const catalog = await listAiCatalog(llm)
        const target = llm ? await resolveTarget(llm, { ai: cfg.ai, getService: (n) => ctx.get(n) }, { provider: body.provider, model: body.model }) : null
        return sendJson(res, { ok: !!llm, configured: cfg.ai || null, target, ...catalog })
      }
      /**
       * 某个模型自己声明的思考强度。前端选中模型后调它来填「思考强度」下拉，
       * 这样选出来的值一定是该模型支持的（宿主对不支持的显式 effort 直接拒绝）。
       */
      if (route === "ai/efforts") {
        const llm = ctx.get("llm")
        const p = String(body.provider || url.searchParams.get("provider") || "")
        const m = String(body.model || url.searchParams.get("model") || "")
        return sendJson(res, { ok: !!llm, ...(await modelEfforts(llm, p, m)) })
      }
      if (route === "ai/health") {
        const llm = ctx.get("llm")
        let providers = []
        try {
          providers = ((llm && (await llm.listProviders())) || []).map((p) => (typeof p === "string" ? p : (p && (p.id || p.name)) || null)).filter(Boolean)
        } catch {
          providers = []
        }
        const target = llm ? await resolveTarget(llm, { ai: cfg.ai, getService: (n) => ctx.get(n) }) : null
        return sendJson(res, {
          ok: !!llm,
          configured: cfg.ai || null,
          providers,
          target,
          hint: llm
            ? providers.length
              ? null
              : "宿主有 llm 服务但没有任何 provider adapter。检查 composition。"
            : "宿主没有 llm 服务：确认 @deepseek-ai/dsh-llm 与 provider adapter 已装载。",
        })
      }
      if (route === "ai/stream") {
        if (req.method !== "POST") return sendJson(res, { error: "POST only" }, 405)
        // ⚠️ body 已经在 handler 顶部读过一次（`const body = req.method === "POST" ? await readJson(req) : {}`）。
        // 这里**绝不能**再 readJson(req)：请求流已被消费，第二次等 'end' 永远等不到 → 请求挂死。
        res.statusCode = 200
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
        // no-transform：别让中间层把流攒起来（和 SSE 一个道理）
        res.setHeader("Cache-Control", "no-cache, no-store, no-transform")
        res.setHeader("X-Accel-Buffering", "no")
        if (typeof res.flushHeaders === "function") res.flushHeaders()

        const ac = new AbortController()
        let closed = false
        /**
         * ⚠️ 判活必须挂 **res** 的 close，不能挂 req 的：
         * `IncomingMessage` 的 'close' 在**请求体读完**时就触发了（POST 带 body 时几乎立刻），
         * 那时监听器还没挂上/已触发过 → 永远等不到，取消就传不下去（实测客户端 abort 后
         * 后端仍把 12/12 token 全生成完）。
         * 更糟的是：如果恰好命中并置 closed=true，write 会被全部吞掉 → 整条流 0 字节。
         * `ServerResponse` 的 'close' 只在**连接真正结束**时触发，正是我们要的语义。
         */
        const onClose = () => {
          closed = true
          ac.abort()
        }
        res.on("close", onClose)
        res.on("error", onClose)
        const write = (obj) => {
          // closed 只用来「停止继续产出」，不用来拦第一包（首包必须发得出去）
          if (closed) return
          try {
            res.write(JSON.stringify(obj) + "\n")
          } catch {
            closed = true
            ac.abort()
          }
        }
        try {
          await runCompletion(
            { llm: ctx.get("llm"), cfg: { ai: cfg.ai, getService: (n) => ctx.get(n) } },
            body,
            write,
            { signal: ac.signal },
          )
        } finally {
          res.off("close", onClose)
          res.off("error", onClose)
        }
        try {
          res.end()
        } catch {
          /* ignore */
        }
        return
      }

      // ── AI 自动补全（ghost text）：一次短请求，返回一行补全文本 ──
      if (route === "ai/complete") {
        if (req.method !== "POST") return sendJson(res, { error: "POST only" }, 405)
        const started = Date.now()
        const ac = new AbortController()
        // 补全是「打字时的猜测」，等太久就没意义了：超时就当没有建议
        const budget = Math.max(1500, Math.min(20000, Number(body.timeoutMs) || 8000))
        const timer = setTimeout(() => ac.abort(), budget)
        try {
          let text = ""
          let startInfo = null
          let terminal = null
          /**
           * 跨格上下文 v2（#8）：客户端已按预算裁好（含 markdown 意图注释），
           * 这里只做一道硬上限。早先写死 3 格，把「预算制」的收益又卡回去了一半。
           */
          const contextList = Array.isArray(body.context) ? body.context.slice(0, 12) : []
          // 内核变量摘要（列名 / 类型）：补全最常见的失败是「不知道 df 有哪些列」
          const varsList = Array.isArray(body.vars) ? body.vars.slice(0, 24) : []
          const reqForAi = {
            // ghost 是独立提示词分支（只续写光标处的一小段，不是整格重写）
            mode: "ghost",
            prefix: String(body.prefix != null ? body.prefix : body.code || ""),
            suffix: String(body.suffix || ""),
            code: String(body.code || ""),
            cellType: body.cellType || "code",
            context: contextList,
            vars: varsList,
            // 设置栏的三项（**逐字段透传，缺省就不传**：不传才让宿主用 adapter 自己的默认）
            provider: body.provider ? String(body.provider) : undefined,
            model: body.model ? String(body.model) : undefined,
            reasoningEffort: body.reasoningEffort ? String(body.reasoningEffort) : undefined,
            /**
             * 输出预算（P0 #14）：补全只要「下一小段」。
             * 不设上限时通用 chat 模型会把整格思路都吐出来 —— 幽灵文本铺满屏幕、又慢又贵。
             * 客户端可覆盖；默认 150 token 与三个「到段落就停」的序列。
             * 宿主不认这两个字段时会在流里降级重试（见 ai.js `consume`），不会把补全弄挂。
             */
            maxTokens: Math.max(16, Math.min(1000, Number(body.maxTokens) || 150)),
            stop: Array.isArray(body.stop) && body.stop.length ? body.stop : ["\n\n\n", "\n#", "\n%%"],
          }
          const out = await runCompletion(
            { llm: ctx.get("llm"), cfg: { ai: cfg.ai, getService: (n) => ctx.get(n) } },
            reqForAi,
            (chunk) => {
              if (chunk.type === "start") startInfo = chunk
              if (chunk.type === "delta") text += chunk.text
              if (chunk.type === "done") terminal = chunk
              if (chunk.type === "error") terminal = chunk
            },
            { signal: ac.signal },
          )
          const aborted = ac.signal.aborted || (terminal && terminal.code === "ABORTED")
          const failed = !!(terminal && terminal.type === "error") || !!(out && out.error)
          // 超时/取消 → 一律不给建议。半截的 "ad_csv(" 插进编辑器比没有更糟。
          const suggestion = aborted || failed ? "" : stripFences(text).trimEnd()
          return sendJson(res, {
            ok: !aborted && !failed,
            suggestion,
            ms: Date.now() - started,
            model: startInfo ? startInfo.model : null,
            provider: startInfo ? startInfo.provider : null,
            aborted: !!aborted,
            error: failed ? (terminal && (terminal.message || terminal.code)) || (out && out.error) : undefined,
            /**
             * `debug:true` → 回显**这次真正拼出来的提示词**与上下文统计。
             * 没有它，「markdown 意图有没有进上下文」「预算裁到多少」只能靠猜；
             * 正常请求不回显（提示词里可能有用户代码，不往网络/日志里多送一份）。
             */
            ...(body.debug
              ? {
                  debug: {
                    context: contextList.length,
                    contextChars: contextList.reduce((n, c) => n + String((c && c.source) || "").length, 0),
                    vars: varsList.length,
                    messages: buildMessages(reqForAi),
                  },
                }
              : {}),
          })
        } catch (err) {
          // 补全失败不打扰用户：安静返回空建议（UI 什么都不画）
          return sendJson(res, { ok: false, suggestion: "", error: String((err && err.message) || err) })
        } finally {
          clearTimeout(timer)
        }
      }

      // ── 诊断/演示 ──
      if (route === "emit") {
        if (req.method !== "POST") return sendJson(res, { error: "POST only" }, 405)
        const sidOut = String(body.sid || sid)
        return sendJson(res, startDemo(sidOut, body.count, body.delayMs))
      }
      if (route === "complete") {
        await session.ensureSidecar()
        const out = await session.sidecar.send("complete", { code: body.code || "", cursorPos: body.cursorPos })
        return sendJson(res, out)
      }
      if (route === "inspect") {
        await session.ensureSidecar()
        const out = await session.sidecar.send("inspect", {
          code: body.code || "",
          cursorPos: body.cursorPos,
          detailLevel: body.detailLevel,
        })
        return sendJson(res, out)
      }

      return sendJson(res, { error: `unknown endpoint: ${route}` }, 404)
    } catch (err) {
      try {
        sendJson(res, { error: String((err && err.message) || err), code: err && err.code }, 500)
      } catch {
        /* SSE 已发头 */
      }
    }
  }

  function startDemo(sid, count, delayMs) {
    const session = sessionFor(sid)
    const n = Math.max(1, Math.min(200, Number(count) || 8))
    const gap = Math.max(0, Math.min(2000, Number(delayMs) || 250))
    const cellId = "demo-cell"
    const outId = `demo-out-${Date.now().toString(36)}`
    session.bus.emit("cell.started", { cellId, execCount: session.bus.seq + 1 })
    let i = 0
    const tick = () => {
      i += 1
      session.bus.emit("stream.append", { cellId, outId, name: "stdout", text: `line ${i} · 逐行到达\n` })
      if (i >= n) {
        session.bus.emit("cell.done", { cellId, status: "ok", durationMs: gap * n })
        return
      }
      const t = setTimeout(() => {
        timers.delete(t)
        tick()
      }, gap)
      timers.add(t)
    }
    tick()
    return { ok: true, sid, count: n, delayMs: gap, outId }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: "prefix", path: "/nb2", handler })
    return () => {
      dispose()
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const session of sessions.values()) session.dispose()
      sessions.clear()
    }
  })

  // ─────────────────────────── agent 工具 ───────────────────────────
  // 对外注册的是**与旧插件同名的 `nb_*`**（见 lib/tools.js 的命名对照表），
  // 目的是让 agent 既有提示词/技能零改动地继续工作。
  // 代价：新旧两套插件**不能同时启用**（会重复注册同名工具）；回滚旧插件前先禁用本插件。

  function sessionIdOf(exec) {
    const session = exec && exec.agent && exec.agent.session
    const sid = String((session && session.id) || "default")
    // 记录派生关系：子代理的会话通常没有自己的 envsel 选择，得沿父会话继承
    const parent = session && session.header && session.header.parentSession
    if (parent) sessionParents.set(sid, String(parent))
    return sid
  }

  function summarizeCell(cell) {
    const text = cell.outputs
      .filter((o) => o.kind === "stream")
      .map((o) => o.text)
      .join("")
    const errors = cell.outputs.filter((o) => o.kind === "error")
    return {
      id: cell.id,
      cellType: cell.cellType,
      status: cell.status,
      execCount: cell.execCount,
      durationMs: cell.durationMs,
      sourcePreview: String(cell.source).slice(0, 200),
      stdout: text.length > 6000 ? text.slice(0, 6000) + `\n…（截断，共 ${text.length} 字符）` : text,
      error: errors.length
        ? { ename: errors[errors.length - 1].ename, evalue: errors[errors.length - 1].evalue }
        : null,
      outputBlocks: cell.outputs.length,
    }
  }

  // 工具集在 lib/tools.js。
  // ⚠️ 对外注册的是**与旧插件同名的 `nb_*`**（这样 agent 既有提示词不用改）。
  // 代价：新旧两套插件不能同时启用（会重复注册同名工具）；回滚旧插件前先禁用本插件。
  // 这里只负责把依赖注入进去并把它们注册到 ctx.tools。
  const tools = buildTools({
    defineTool,
    sessionFor,
    sessionIdOf,
    summarizeCell,
    listKernels,
    kernelDiagnostics,
    stateOf: (sid) => sessionFor(sid).state(),
    readIpynbFile,
    writeIpynbFile,
    notebookToIpynb,
    model: { Notebook },
    stripFences,
    workspaceRoot,
    aiRewrite: async (req, session) => {
      const write = () => {}
      // 用与 HTTP 路由同一条链路（含 provider/model 解析与错误映射）
      return runCompletion({ llm: ctx.get("llm"), cfg: { ai: cfg.ai, getService: (n) => ctx.get(n) } }, req, write)
    },
  })

  ctx.effect(() => {
  /**
   * ── 让模型知道「.ipynb 要走 nb_* 工具」（R4）──
   *
   * 用户反馈：新 session 里让它生成 notebook，它写了个 `nbformat` 脚本，而不是调工具。
   * 实测 28 个 `nb_*` 工具**全都在**（`cordis_inspect_query(host/Tool)` 可验证），
   * 缺的是**引导** —— 插件此前没有注册任何 `systemPrompt` 段。
   *
   * ⚠️ `PromptSection.text` 只能拿到 `{ scope, signal }`（没有 agent / session / cwd），
   * 所以这里只能写**静态**规则；不要试图在这里读会话目录，那会静默变空。
   */
  ctx.effect(() => {
    const sp = ctx.get("systemPrompt")
    if (!sp || typeof sp.section !== "function") return () => {}
    return sp.section({
      name: "dsh-notebook-v2/tools-first",
      order: 640,
      text: [
        "## Notebook (.ipynb) 一律用 nb_* 工具",
        "用户要求「新建 notebook / 写个 notebook / 整理成 ipynb / 在这个目录建 notebook」时：",
        '1. 先 `nb_new`（可选 path），再用 `nb_add_cell` 写内容；多格时用一次 `cells: [...]` 批量传，不要逐格调用。',
        "2. 改内容用 `nb_edit_cell`；运行用 `nb_run_cell` / `nb_run_all`；保存用 `nb_save`；看结构用 `nb_get` / `nb_list`。",
        "3. **不要**用 Python 脚本（nbformat / 手写 JSON）生成或修改 .ipynb：那样用户看不到界面、不能运行，",
        "   已打开的 notebook 标签也不会跟着变。只有用户明确要求「用脚本处理」时才例外。",
        '4. 写方案/文档优先用 markdown 格（`cellType: "markdown"`，不执行），需要计算时再加代码格。',
      ].join("\n"),
    })
  })

    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  })

  // 会话回收：DSH 会话被删除/归档时把 sidecar 一并杀掉，别留孤儿内核
  ctx.effect(() => {
    try {
      return ctx.on(
        "session/disposed",
        (session) => {
          const s = sessions.get(String(session && session.id))
          if (s) {
            s.dispose()
            sessions.delete(s.sid)
          }
        },
        { global: true },
      )
    } catch {
      return () => {}
    }
  })
}

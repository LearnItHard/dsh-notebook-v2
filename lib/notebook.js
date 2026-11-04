/**
 * Notebook 模型：cells / 输出块 / 执行状态机 / 队列。
 *
 * 这一层是**纯逻辑**（不碰 IO、不碰 DOM），所以能被 headless 测试直接驱动 ——
 * M1/M3 的验收大部分落在这里。
 *
 * 两条来自源码考古的硬约束（见 docs/plans/...-自研迭代计划.md 附录 A）：
 * 1. **stream 复用 last-used 输出块**：连续同类 stream 追加到同一个 outId，
 *    遇非 stream 输出才清空记录。`print` 一万行 → 只产生 1 个输出块（vscode-jupyter
 *    的 `clearLastUsedStreamOutput` 同语义）。
 * 2. **迟到尾包**：cell.done 之后仍接受该 cellId 的 stream，最多 LATE_WINDOW_MS；
 *    超过窗口就不再认（避免上个 cell 的输出污染下一个）。
 */

export const LATE_WINDOW_MS = 5000
export const MAX_EXECUTIONS_PER_CELL = 50
export const MAX_OUTPUT_BLOCKS = 500

let idSeq = 0
export function newCellId(prefix = "cell") {
  idSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`
}

/** 四种格：python 代码 / markdown / raw / shell（bash|sh|cmd…都归到这里）。 */
export const CELL_TYPES = ["code", "markdown", "raw", "bash"]

/**
 * 单元格类型归一化。
 *
 * 为什么要归一：类型是三个入口共用的 —— 客户端下拉、`nb_add_cell` 工具、.ipynb 读取。
 * 三处各写一套别名，迟早会出现「工具建了 md 格、前端不认」的裂缝。别名表放在这里，
 * 客户端半（自包含 CJS，import 不了本文件）有一份完全相同的拷贝，测试会交叉比对两边
 * 是否仍然一致 —— 见 test/client-logic.mjs 的 normalizeCellType 对照用例。
 */
export function normalizeCellType(type) {
  const t = String(type == null ? "" : type)
    .trim()
    .toLowerCase()
  if (!t) return "code"
  if (t === "code" || t === "py" || t === "python" || t === "ipython" || t === "jupyter") return "code"
  if (t === "markdown" || t === "md" || t === "mdown" || t === "mkdn") return "markdown"
  if (t === "raw" || t === "text" || t === "plain") return "raw"
  if (t === "bash" || t === "sh" || t === "shell" || t === "zsh" || t === "console" || t === "cmd" || t === "powershell" || t === "pwsh") return "bash"
  return "code"
}

/** 这一格需不需要真跑（markdown / raw 是"文档格"，运行 = 结束编辑并下移）。 */
export function isRunnableCell(cellType) {
  const t = normalizeCellType(cellType)
  return t === "code" || t === "bash"
}

export function emptyCell(cellType = "code", source = "") {
  return {
    id: newCellId(),
    cellType: normalizeCellType(cellType),
    source,
    metadata: {},
    outputs: [],
    execCount: null,
    status: "idle",
    durationMs: null,
    /** 该 cell 当前 last-used stream 输出块（内存态，不进 .ipynb） */
    lastStream: null,
  }
}

/** 状态机允许的转移（越界的静默忽略，不抛 —— UI 会因为竞态收到乱序事件）。 */
const TRANSITIONS = {
  idle: ["queued", "running", "idle"],
  queued: ["running", "cancelled", "idle"],
  running: ["ok", "error", "cancelled", "running"],
  ok: ["queued", "running", "idle"],
  error: ["queued", "running", "idle"],
  cancelled: ["queued", "running", "idle"],
}

export class Notebook {
  constructor({ path = null, title = null } = {}) {
    this.path = path
    this.title = title || (path ? path.split(/[\\/]/).pop() : "Untitled.ipynb")
    this.cells = []
    this.metadata = {}
    this.nbformat = 4
    this.nbformatMinor = 5
    /** 已保存的 .ipynb 原文，用于语义等价写回（未知字段不丢） */
    this.raw = null
    /** 队列与执行态 */
    this.queue = []
    this.running = null
    this.stopOnError = true
    this.kernelState = "unknown"
    this.revision = 0
    this.lastDoneAt = new Map() // cellId -> ts，迟到尾包窗口用
  }

  get dirty() {
    return this.revision > 0
  }

  touch() {
    this.revision += 1
  }

  // ── 结构操作 ──
  addCell(cellType = "code", source = "", { after = null, index = null } = {}) {
    const cell = emptyCell(cellType, source)
    if (index !== null && index >= 0 && index <= this.cells.length) {
      this.cells.splice(index, 0, cell)
    } else if (after) {
      const i = this.cells.findIndex((c) => c.id === after)
      this.cells.splice(i >= 0 ? i + 1 : this.cells.length, 0, cell)
    } else {
      this.cells.push(cell)
    }
    this.touch()
    return cell
  }

  /**
   * 合并本格与**下一格**（Jupyter 的 `Shift-M`）：源码拼接后删掉下一格。
   *
   * 为什么放在模型层做**原子**操作：客户端两步（先 editCell 再 deleteCell）不原子，
   * 中间失败会丢掉下一格的源码 —— 那是最糟的一种数据损坏（静默丢内容）。
   *
   * 类型口径：合并后保持**本格**的类型（Jupyter 同款）。markdown + code 混并时，
   * 内容原样拼进去，不做语法转换 —— 用户自己会看见并改。
   *
   * @returns {{ok:true, cell:object}|{ok:false, reason:string}}
   */
  mergeWithNext(cellId) {
    const i = this.cells.findIndex((c) => c.id === cellId)
    if (i < 0) return { ok: false, reason: "no such cell" }
    const next = this.cells[i + 1]
    if (!next) return { ok: false, reason: "no next cell" }
    const cur = this.cells[i]
    const a = String(cur.source || "")
    const b = String(next.source || "")
    // 两边都有内容才插一个换行，避免合并后多出空行
    cur.source = a && b ? `${a}\n${b}` : a || b
    cur.sourceDirty = true
    this.cells.splice(i + 1, 1)
    this.queue = this.queue.filter((id) => id !== next.id)
    this.touch()
    return { ok: true, cell: cur, removed: next.id }
  }

  deleteCell(cellId) {
    const i = this.cells.findIndex((c) => c.id === cellId)
    if (i < 0) return false
    this.cells.splice(i, 1)
    this.queue = this.queue.filter((id) => id !== cellId)
    this.touch()
    return true
  }

  moveCell(cellId, toIndex) {
    const i = this.cells.findIndex((c) => c.id === cellId)
    if (i < 0) return false
    const [cell] = this.cells.splice(i, 1)
    const clamped = Math.max(0, Math.min(this.cells.length, toIndex))
    this.cells.splice(clamped, 0, cell)
    this.touch()
    return true
  }

  editCell(cellId, source, { cellType } = {}) {
    const cell = this.cell(cellId)
    if (!cell) return null
    if (typeof source === "string") cell.source = source
    if (cellType) cell.cellType = normalizeCellType(cellType)
    this.touch()
    return cell
  }

  /** 换类型（下拉框用）。换到 markdown/raw 时输出已无意义，顺手清掉。 */
  setCellType(cellId, cellType) {
    const cell = this.cell(cellId)
    if (!cell) return null
    const next = normalizeCellType(cellType)
    if (cell.cellType === next) return cell
    cell.cellType = next
    if (next === "markdown" || next === "raw") {
      cell.outputs = []
      cell.lastStream = null
      cell.execCount = null
    }
    this.touch()
    return cell
  }

  cell(cellId) {
    return this.cells.find((c) => c.id === cellId) || null
  }

  clearOutputs(cellId = null) {
    const targets = cellId ? [this.cell(cellId)].filter(Boolean) : this.cells
    for (const cell of targets) {
      cell.outputs = []
      cell.lastStream = null
    }
    this.touch()
  }

  // ── 状态机 ──
  setStatus(cell, next) {
    const allowed = TRANSITIONS[cell.status] || []
    if (!allowed.includes(next)) return false
    cell.status = next
    if (next === "queued") cell.durationMs = null
    this.touch()
    return true
  }

  // ── 事件应用（sidecar → 模型） ──
  /**
   * @returns {{applied:boolean, reason?:string}}
   */
  applyEvent(name, payload) {
    switch (name) {
      case "cell.started":
        return this._onStarted(payload)
      case "stream":
        return this._onStream(payload)
      case "display":
        return this._onDisplay(payload)
      case "error":
        return this._onError(payload)
      case "cell.done":
        return this._onDone(payload)
      case "cell.executed":
        return this._onExecuted(payload)
      case "kernel.state":
        this.kernelState = payload.state || this.kernelState
        this.touch()
        return { applied: true }
      default:
        return { applied: false, reason: `unknown event ${name}` }
    }
  }

  _onStarted({ cellId, execCount }) {
    const cell = this.cell(cellId)
    if (!cell) return { applied: false, reason: "no cell" }
    this.setStatus(cell, "running")
    cell.execCount = execCount ?? cell.execCount
    cell.durationMs = null
    this.running = cellId
    return { applied: true }
  }

  _onStream({ cellId, name = "stdout", text = "" }) {
    const cell = this.cell(cellId)
    if (!cell) return { applied: false, reason: "no cell" }
    if (!text) return { applied: true }
    // 迟到尾包：cell 已结束但仍在窗口内，允许追加（vscode 故意不 dispose lastCellExecution）
    const doneAt = this.lastDoneAt.get(cellId)
    if (cell.status !== "running" && doneAt && Date.now() - doneAt > LATE_WINDOW_MS) {
      return { applied: false, reason: "late packet out of window" }
    }
    const last = cell.lastStream
    if (last && last.name === name) {
      const block = cell.outputs.find((o) => o.id === last.outId)
      if (block) {
        block.text += text
        this.touch()
        return { applied: true, outId: block.id }
      }
    }
    const outId = `out-${cellId}-${cell.outputs.length}-${name}`
    cell.outputs.push({ id: outId, kind: "stream", name, text })
    cell.lastStream = { name, outId }
    this._trimOutputs(cell)
    this.touch()
    return { applied: true, outId }
  }

  _onDisplay({ cellId, mime, data, kind = "display", outId, update = false, path, bytes }) {
    const cell = this.cell(cellId)
    if (!cell) return { applied: false, reason: "no cell" }
    cell.lastStream = null // 非 stream 输出清空复用记录（vscode clearLastUsedStreamOutput）
    const id = outId || `disp-${cellId}-${cell.outputs.length}`
    const item = { mime, data, path, bytes, kind: kind === "path" ? "path" : "mime" }
    if (update) {
      const existing = cell.outputs.find((o) => o.id === id)
      if (existing) {
        existing.items = existing.items || []
        const idx = existing.items.findIndex((it) => it.mime === mime)
        if (idx >= 0) existing.items[idx] = item
        else existing.items.push(item)
        this.touch()
        return { applied: true, outId: id }
      }
    }
    const block = cell.outputs.find((o) => o.id === id)
    if (block) {
      block.items = block.items || []
      const idx = block.items.findIndex((it) => it.mime === mime)
      if (idx >= 0) block.items[idx] = item
      else block.items.push(item)
    } else {
      cell.outputs.push({ id, kind: "display", items: [item] })
    }
    this._trimOutputs(cell)
    this.touch()
    return { applied: true, outId: id }
  }

  _onError({ cellId, ename, evalue, traceback }) {
    const cell = this.cell(cellId)
    if (!cell) return { applied: false, reason: "no cell" }
    cell.lastStream = null
    cell.outputs.push({
      id: `err-${cellId}-${cell.outputs.length}`,
      kind: "error",
      ename,
      evalue,
      traceback: Array.isArray(traceback) ? traceback : [],
    })
    this._trimOutputs(cell)
    this.touch()
    return { applied: true }
  }

  _onDone({ cellId, status, durationMs, execCount }) {
    const cell = this.cell(cellId)
    if (!cell) return { applied: false, reason: "no cell" }
    const next = status === "error" ? "error" : status === "cancelled" ? "cancelled" : "ok"
    this.setStatus(cell, next)
    if (durationMs !== null && durationMs !== undefined) cell.durationMs = durationMs
    if (execCount !== null && execCount !== undefined) cell.execCount = execCount
    cell.lastStream = null
    this.lastDoneAt.set(cellId, Date.now())
    if (this.running === cellId) this.running = null
    this._dequeue(cellId)
    return { applied: true }
  }

  _onExecuted({ cellId, execCount, status, durationMs, finishedAt }) {
    const cell = this.cell(cellId)
    if (!cell) return { applied: false, reason: "no cell" }
    // 执行历史落 cell.metadata.dsh2.executions（每格上限 50），为 diff/回放留数据
    if (!cell.metadata) cell.metadata = {}
    if (!cell.metadata.dsh2) cell.metadata.dsh2 = {}
    if (!Array.isArray(cell.metadata.dsh2.executions)) cell.metadata.dsh2.executions = []
    const hist = cell.metadata.dsh2.executions
    hist.push({ execCount, status, durationMs, finishedAt: finishedAt || Date.now() })
    if (hist.length > MAX_EXECUTIONS_PER_CELL) hist.splice(0, hist.length - MAX_EXECUTIONS_PER_CELL)
    cell.lastStream = null
    this.touch()
    return { applied: true }
  }

  _trimOutputs(cell) {
    if (cell.outputs.length > MAX_OUTPUT_BLOCKS) {
      cell.outputs.splice(0, cell.outputs.length - MAX_OUTPUT_BLOCKS)
    }
  }

  // ── 队列（照 vscode-jupyter CellExecutionQueue 语义） ──
  enqueue(cellId) {
    const cell = this.cell(cellId)
    if (!cell) return false
    // 入队去重：同一 cell 重复点运行，复用队列里已有的 execution，不排两次
    if (this.queue.includes(cellId) || this.running === cellId) return false
    this.queue.push(cellId)
    this.setStatus(cell, "queued")
    return true
  }

  _dequeue(cellId) {
    this.queue = this.queue.filter((id) => id !== cellId)
  }

  /** 取下一个该执行的 cell；stopOnError 由调用方在 error 时清空队列。 */
  next() {
    while (this.queue.length) {
      const cellId = this.queue[0]
      const cell = this.cell(cellId)
      if (!cell) {
        this.queue.shift()
        continue
      }
      return cellId
    }
    return null
  }

  /**
   * 遇错停止：取消剩余全部，但带 `raises-exception` tag 的 cell 允许报错后继续
   * （vscode-jupyter 的 cancelledOrCompletedWithErrors 同语义）。
   */
  onCellError(cellId) {
    // 出错的那个 cell 本身先从队列摘掉（正常流程里 _onDone 已摘，这里兜底，
    // 防止「先 error 后 done」或 done 丢包时把出错格又排一次）
    this._dequeue(cellId)
    const cell = this.cell(cellId)
    const tags = (cell && cell.metadata && cell.metadata.tags) || []
    if (tags.includes("raises-exception")) return { cancelled: [] }
    if (!this.stopOnError) return { cancelled: [] }
    const cancelled = this.queue.slice()
    this.queue = []
    for (const id of cancelled) {
      const c = this.cell(id)
      if (c) this.setStatus(c, "cancelled")
    }
    return { cancelled }
  }

  cancelAll() {
    const cancelled = this.queue.slice()
    this.queue = []
    for (const id of cancelled) {
      const c = this.cell(id)
      if (c) this.setStatus(c, "cancelled")
    }
    if (this.running) {
      const c = this.cell(this.running)
      if (c) this.setStatus(c, "cancelled")
    }
    this.running = null
    return cancelled
  }

  // ── 快照（给 UI / HTTP） ──
  snapshot() {
    return {
      path: this.path,
      title: this.title,
      kernelState: this.kernelState,
      running: this.running,
      queue: this.queue.slice(),
      revision: this.revision,
      cells: this.cells.map((c) => ({
        id: c.id,
        cellType: c.cellType,
        source: c.source,
        execCount: c.execCount,
        status: c.status,
        durationMs: c.durationMs,
        outputs: c.outputs,
      })),
    }
  }
}

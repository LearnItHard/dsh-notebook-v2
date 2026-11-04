/**
 * agent 工具集：**与旧插件 @beihaizb/dsh-notebook 同名**（`nb_*`）。
 *
 * 为什么必须同名：agent 的既有提示词/技能里写的是 `nb_run_cell` 这类名字。自研插件若叫 `nb2_*`，
 * 一旦把旧插件下线，那些提示词就全断了。所以对外的名字保持 `nb_*`，内部实现换成 v2 的模型/事件链路。
 *
 * 命名对照（旧 → 新实现位置）：
 *   nb_list/nb_get       → 标签与 cell 快照            nb_new/nb_open/nb_save → 文件生命周期
 *   nb_add/edit/move/del → Notebook 结构操作           nb_run_cell/run_all    → Session 队列
 *   nb_kernel_*          → Session 内核控制（含 select/restart 三语义）
 *   nb_set_cwd           → Session.setCwd（重启内核）
 *   nb_list_vars / nb_inspect_object → 走一次静默 execute 拿结果
 *   nb_cell_history      → cell.metadata.dsh2.executions
 *   nb_apply_suggestion  → 走 ctx.llm 真流式改写（v1.1 的 AI 内联同一条链路）
 *   nb_revert_cell       → v2 没有版本栈，明确报"不支持"而不是假装成功
 */

import { isAbsolute as pathIsAbsolute, resolve as pathResolve } from "node:path"
import { existsSync } from "node:fs"

const isAbsolute = (p) => pathIsAbsolute(String(p || ""))
const resolvePath = (base, p) => pathResolve(String(base || process.cwd()), String(p || ""))

export function buildTools(deps) {
  const {
    defineTool,
    sessionFor,
    sessionIdOf,
    summarizeCell,
    listKernels,
    stateOf,
  } = deps

  const output = {
    schema: { type: "json" },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
  }
  const tool = (def) => defineTool(Object.assign({ output }, def))

  /** 工作区根：优先用宿主注入的，其次进程 cwd（旧插件也支持相对路径，语义保持一致）。 */
  const workspaceRootOf = () => {
    try {
      const w = deps.workspaceRoot && deps.workspaceRoot()
      if (w && existsSync(w)) return w
    } catch {
      /* ignore */
    }
    return process.cwd()
  }

  /** 跑一段**不污染执行序号**的代码并取回文本结果（用于变量列表/对象检查）。 */
  async function evalQuiet(session, code, timeoutMs = 8000) {
    await session.ensureSidecar()
    const cellId = `__quiet_${Date.now().toString(36)}`
    // 借用一个临时 cell（不进 notebook 的 cells 列表），只为了有 cellId 归集事件
    session.notebook.cells.push({
      id: cellId,
      cellType: "code",
      source: "",
      metadata: {},
      outputs: [],
      execCount: null,
      status: "idle",
      durationMs: null,
      lastStream: null,
    })
    const started = Date.now()
    const done = session.waitForCell(cellId, timeoutMs)
    session.sidecar.post("execute", { cellId, code, storeHistory: false, silent: false })
    await done
    const cell = session.notebook.cell(cellId)
    // 清理临时 cell
    const idx = session.notebook.cells.findIndex((c) => c.id === cellId)
    if (idx >= 0) session.notebook.cells.splice(idx, 1)
    if (!cell) return { ok: false, error: "no result", ms: Date.now() - started }
    const stdout = cell.outputs
      .filter((o) => o.kind === "stream")
      .map((o) => o.text)
      .join("")
    const display = cell.outputs
      .filter((o) => o.kind === "display")
      .flatMap((o) => (o.items || []).filter((i) => i.mime === "text/plain").map((i) => i.data))
      .join("\n")
    const err = cell.outputs.find((o) => o.kind === "error")
    return {
      ok: !err,
      stdout: stdout.slice(0, 8000),
      result: display.slice(0, 8000),
      error: err ? { ename: err.ename, evalue: err.evalue } : null,
      ms: Date.now() - started,
    }
  }

  const tools = []

  // ── 会话/文件 ──
  tools.push(
    tool({
      name: "nb_ping",
      description: "Check that the notebook plugin host half is alive, and report kernel/notebook status.",
      parameters: {},
      execute: (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        return {
          ok: true,
          pong: "dsh-notebook-v2",
          sid: s.sid,
          kernel: s.notebook.kernelState,
          python: s.interpreter ? s.interpreter.python : null,
          sidecar: s.sidecar ? { alive: s.sidecar.alive, pid: s.sidecar.pid } : null,
          tabs: s.listTabs().length,
          cells: s.notebook.cells.length,
        }
      },
    }),
    tool({
      name: "nb_list",
      description: "List open notebooks (tabs) and, with cells=true, the cells of the active notebook.",
      parameters: {
        cells: { type: "boolean", description: "Include the active notebook's cells." },
      },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const out = { active: s.activeKey, tabs: s.listTabs() }
        if (a && a.cells) out.cells = s.notebook.cells.map((c, i) => ({ index: i, id: c.id, cellType: c.cellType, status: c.status, firstLine: String(c.source).split("\n")[0].slice(0, 100) }))
        return out
      },
    }),
    tool({
      name: "nb_get",
      description: "Read the active notebook: metadata plus every cell with source and output summary. Or pass cellId for one cell.",
      parameters: {
        cellId: { type: "string", description: "Read only this cell." },
        includeOutputs: { type: "boolean", description: "Include full output blocks (default false)." },
      },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const nb = s.notebook
        if (a && a.cellId) {
          const c = nb.cell(a.cellId)
          if (!c) return { error: `no such cell: ${a.cellId}` }
          const out = { id: c.id, cellType: c.cellType, source: c.source, summary: summarizeCell(c) }
          if (a.includeOutputs) out.outputs = c.outputs
          return out
        }
        return {
          path: nb.path,
          title: nb.title,
          kernel: nb.kernelState,
          cells: nb.cells.map((c) => {
            const one = { id: c.id, cellType: c.cellType, source: c.source, summary: summarizeCell(c) }
            if (a && a.includeOutputs) one.outputs = c.outputs
            return one
          }),
        }
      },
    }),
    tool({
      name: "nb_new",
      description:
        "Create a new empty notebook in a new tab. " +
        "**Use this whenever the user asks to create / write / draft a notebook (.ipynb)** — including markdown-only " +
        "planning documents. Do NOT create notebooks by writing a Python script with nbformat: that bypasses the live UI, " +
        "the user cannot see or run the cells, and the open notebook tab will not follow along.",
      parameters: { path: { type: "string", description: "Optional target path (not written until nb_save)." } },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const { Notebook } = deps.model
        const nb = new Notebook({ path: (a && a.path) || null })
        nb.addCell("code", "")
        s.notebook = nb
        s.bus.emit("nb.updated", { revision: 0, path: nb.path })
        return { ok: true, key: s.activeKey, tabs: s.listTabs().length }
      },
    }),
    tool({
      name: "nb_open",
      description: "Open an .ipynb file into a new tab (lossless read). If it is already open, just activates it.",
      parameters: { path: { type: "string", required: true, description: "Absolute path to a .ipynb file." } },
      execute: async (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        let path = String((a && a.path) || "")
        if (!path) return { error: "path required" }
        // 旧插件的描述是 "Absolute or workspace-relative"，保留同义能力，避免既有提示词传相对路径失败
        if (!isAbsolute(path)) path = resolvePath(workspaceRootOf(), path)
        if (s.tabs.has(path)) {
          s.activate(path)
          s.bus.emit("nb.updated", { revision: 0, path })
          return { ok: true, path, activated: true }
        }
        const nb = await deps.readIpynbFile(path)
        s.notebook = nb
        s.bus.emit("nb.updated", { revision: 0, path })
        return { ok: true, path, cells: nb.cells.length, key: s.activeKey }
      },
    }),
    tool({
      name: "nb_save",
      description: "Save the active notebook to disk as .ipynb (semantic-lossless: unknown fields and old-plugin metadata survive).",
      parameters: { path: { type: "string", description: "Target path; defaults to the notebook's current path." } },
      execute: async (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const nb = s.notebook
        const path = (a && a.path) || nb.path
        if (!path) return { error: "no path: pass path or open a notebook first" }
        const bytes = await deps.writeIpynbFile(path, deps.notebookToIpynb(nb))
        s.rekey(nb, path)
        nb.revision = 0
        s.bus.emit("nb.updated", { revision: 0, path })
        return { ok: true, path, bytes }
      },
    }),
    tool({
      name: "nb_set_cwd",
      description: "Set the kernel working directory (restarts the kernel, like Jupyter).",
      parameters: { dir: { type: "string", required: true, description: "Absolute directory path." } },
      execute: async (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        return s.setCwd(String((a && a.dir) || ""))
      },
    }),
  )

  // ── cell 结构 ──
  tools.push(
    tool({
      name: "nb_add_cell",
      description:
        "Append (or insert after a given cell) one or more new cells. cellType: code (Python) | markdown | bash (shell) | raw. " +
        "For a multi-cell document (e.g. a markdown-only plan with 10 sections) pass `cells` and add them ALL IN ONE CALL — " +
        "do not fall back to writing an nbformat script just because there are many cells.",
      parameters: {
        source: { type: "string", description: "Cell source (single-cell form)." },
        cellType: {
          type: "string",
          enum: ["code", "markdown", "bash", "raw", "md", "sh", "shell"],
          description: "Defaults to code. markdown/raw are documents (never executed); bash runs in a shell subprocess.",
        },
        after: { type: "string", description: "Insert after this cell id; omit to append." },
        cells: {
          type: "array",
          description: "Batch form: several cells in one call, appended in order after `after`. Each item: { cellType, source }.",
          items: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        // ── 批量形态：一次调用写多格（否则「16 个 markdown 格」会让模型觉得写脚本更快）──
        const batch = a && Array.isArray(a.cells) ? a.cells : null
        if (batch && batch.length) {
          let after = (a && a.after) || null
          const made = []
          for (const item of batch) {
            const cell = s.notebook.addCell((item && item.cellType) || "code", String((item && item.source) || ""), { after })
            after = cell.id
            made.push({ id: cell.id, cellType: cell.cellType, source: cell.source })
          }
          s.bus.emit("nb.updated", {
            revision: s.notebook.revision,
            source: "agent",
            cellId: made[made.length - 1].id,
            op: "add",
          })
          return { ok: true, count: made.length, cells: made }
        }
        const cell = s.notebook.addCell((a && a.cellType) || "code", (a && a.source) || "", { after: (a && a.after) || null })
        // source:"agent" → 前端滚到该格并闪一下（用户要看清楚 AI 动了哪里）
        s.bus.emit("nb.updated", { revision: s.notebook.revision, source: "agent", cellId: cell.id, op: "add" })
        return { ok: true, cell: { id: cell.id, cellType: cell.cellType, source: cell.source } }
      },
    }),
    tool({
      name: "nb_edit_cell",
      description: "Replace a cell's source without running it. Pass cellType to convert the cell (code/markdown/bash/raw).",
      parameters: {
        cellId: { type: "string", required: true, description: "Cell id." },
        source: { type: "string", description: "Full replacement source; omit to only change the type." },
        cellType: { type: "string", enum: ["code", "markdown", "bash", "raw", "md", "sh", "shell"], description: "Convert to this cell type." },
      },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        if (typeof a.source !== "string" && a.cellType) {
          const c = s.notebook.setCellType(a.cellId, a.cellType)
          if (!c) return { error: `no such cell: ${a.cellId}` }
          c.sourceDirty = true // 序列化要跟着变（code↔bash 差一个 %%bash 魔法行）
          s.bus.emit("nb.updated", { revision: s.notebook.revision, source: "agent", cellId: c.id, op: "edit" })
          return { ok: true, id: c.id, cellType: c.cellType }
        }
        const cell = s.notebook.editCell(a.cellId, a.source, { cellType: a.cellType })
        if (!cell) return { error: `no such cell: ${a.cellId}` }
        cell.sourceDirty = true
        s.bus.emit("nb.updated", { revision: s.notebook.revision, source: "agent", cellId: cell.id, op: "edit" })
        return { ok: true, id: cell.id, cellType: cell.cellType }
      },
    }),
    tool({
      name: "nb_delete_cell",
      description: "Delete a cell by id.",
      parameters: { cellId: { type: "string", required: true, description: "Cell id." } },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const ok = s.notebook.deleteCell(a.cellId)
        s.bus.emit("nb.updated", { revision: s.notebook.revision, source: "agent", cellId: a.cellId, op: "delete" })
        return ok ? { ok: true } : { error: `no such cell: ${a.cellId}` }
      },
    }),
    tool({
      name: "nb_move_cell",
      description: "Move a cell to a new index.",
      parameters: {
        cellId: { type: "string", required: true, description: "Cell id." },
        toIndex: { type: "integer", required: true, description: "Target index (0-based)." },
      },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const ok = s.notebook.moveCell(a.cellId, Number(a.toIndex))
        s.bus.emit("nb.updated", { revision: s.notebook.revision, source: "agent", cellId: a.cellId, op: "move" })
        return ok ? { ok: true } : { error: `no such cell: ${a.cellId}` }
      },
    }),
    tool({
      name: "nb_clear_outputs",
      description: "Clear outputs of every cell (or one cell when cellId is given). Does not restart the kernel.",
      parameters: { cellId: { type: "string", description: "Only this cell." } },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        s.notebook.clearOutputs((a && a.cellId) || null)
        s.bus.emit("nb.updated", { revision: s.notebook.revision })
        return { ok: true }
      },
    }),
  )

  // ── 执行 ──
  tools.push(
    tool({
      name: "nb_run_cell",
      description: "Run one cell and wait for it to finish. Returns status, execution count, duration, stdout text and error.",
      parameters: {
        cellId: { type: "string", required: true, description: "Cell id." },
        source: { type: "string", description: "Optional: replace the source before running." },
        timeout: { type: "integer", description: "Seconds to wait (default 180)." },
      },
      execute: async (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const timeoutMs = Math.max(1000, Math.min(600000, (Number(a && a.timeout) || 180) * 1000))
        await s.ensureSidecar().catch((err) => ({ __err: err }))
        if (!s.sidecar || !s.sidecar.alive) {
          const diag = deps.kernelDiagnostics()
          return { ok: false, error: "kernel unavailable", diagnostics: { hint: diag.hint, kernels: diag.kernels } }
        }
        const done = await s.runCell(a.cellId, a.source, timeoutMs).catch((err) => ({ status: "error", evalue: String(err && err.message) }))
        const cell = s.notebook.cell(a.cellId)
        return { ok: done.status !== "error", done, cell: cell ? summarizeCell(cell) : null }
      },
    }),
    tool({
      name: "nb_edit_and_run_cell",
      description: "Replace a cell's source and immediately run it.",
      parameters: {
        cellId: { type: "string", required: true, description: "Cell id." },
        source: { type: "string", required: true, description: "Full replacement source." },
        reason: { type: "string", description: "Why (recorded in output for traceability)." },
      },
      execute: async (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const cell = s.notebook.editCell(a.cellId, a.source)
        if (!cell) return { error: `no such cell: ${a.cellId}` }
        cell.sourceDirty = true
        await s.ensureSidecar().catch(() => {})
        const done = await s.runCell(a.cellId).catch((err) => ({ status: "error", evalue: String(err && err.message) }))
        return { ok: done.status !== "error", reason: a.reason || null, done, cell: summarizeCell(s.notebook.cell(a.cellId) || cell) }
      },
    }),
    tool({
      name: "nb_run_all",
      description: "Run every code cell in order and wait for all of them.",
      parameters: {
        includeOutputs: { type: "boolean", description: "Include full output blocks per cell (old-plugin compatible)." },
      },
      execute: async (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        await s.ensureSidecar().catch(() => {})
        const results = await s.runAll()
        const cells = s.notebook.cells.map((c) => {
          const one = summarizeCell(c)
          if (_a && _a.includeOutputs) one.outputs = c.outputs
          return one
        })
        return { ok: results.every((r) => r.status === "ok"), results, cells }
      },
    }),
  )

  // ── 内核 ──
  tools.push(
    tool({
      name: "nb_kernel_list",
      description: "List available conda environments usable as kernels (has ipykernel flag), and the current selection.",
      parameters: {},
      execute: (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        return { kernels: listKernels(), current: s.kernelId || null, python: s.interpreter ? s.interpreter.python : null, cwd: s.cwd || null }
      },
    }),
    tool({
      name: "nb_kernel_select",
      description:
        "Switch the kernel to another environment. Accepts the kernel id from nb_kernel_list, or the environment name " +
        "(e.g. \"ML-LLM-base\"). Restarts the kernel and clears outputs.",
      parameters: {
        kernelId: { type: "string", description: "Kernel id from nb_kernel_list." },
        // 旧插件用的是 {id?, name?}，这里保留同义参数，避免既有提示词按名字调用时报 unknown kernel
        name: { type: "string", description: "Environment name (alternative to kernelId)." },
        id: { type: "string", description: "Alias of kernelId." },
      },
      execute: async (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const wanted = String((a && (a.kernelId || a.id || a.name)) || "").trim()
        if (!wanted) return { error: "kernelId / name required" }
        let id = wanted
        if (!id.startsWith("conda:")) {
          const hit = listKernels().find((k) => k.name.toLowerCase() === wanted.toLowerCase() || k.id === wanted)
          if (!hit) {
            return {
              error: `unknown kernel: ${wanted}`,
              candidates: listKernels().map((k) => ({ id: k.id, name: k.name, hasIpykernel: k.hasIpykernel })),
            }
          }
          id = hit.id
        }
        return s.selectKernel(id)
      },
    }),
    tool({
      name: "nb_kernel_interrupt",
      description: "Interrupt the running cell / kernel.",
      parameters: {},
      execute: async (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        await s.interrupt()
        return { ok: true }
      },
    }),
    tool({
      name: "nb_kernel_restart",
      description: "Restart the kernel, keeping cell outputs.",
      parameters: {},
      execute: async (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        await s.restart({})
        return { ok: true, kernel: s.notebook.kernelState }
      },
    }),
    tool({
      name: "nb_kernel_restart_and_clear",
      description: "Restart the kernel and clear every cell's outputs and execution counts.",
      parameters: {},
      execute: async (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        await s.restart({ clear: true })
        return { ok: true, kernel: s.notebook.kernelState }
      },
    }),
    tool({
      name: "nb_kernel_restart_and_run_all",
      description: "Restart the kernel, then run every code cell from the top.",
      parameters: {},
      execute: async (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const results = await s.restart({ runAll: true })
        return { ok: true, results }
      },
    }),
  )

  // ── 自省 / 历史 / AI ──
  tools.push(
    tool({
      name: "nb_list_vars",
      description: "List user-defined variables in the kernel namespace (name, type, short repr).",
      parameters: {},
      execute: async (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const code = [
          "def __nb2_vars():",
          "    import json",
          "    out = []",
          "    for k, v in list(globals().items()):",
          "        if k.startswith('_'):",
          "            continue",
          "        try:",
          "            r = repr(v)",
          "        except Exception:",
          "            r = '<unrepr>'",
          "        out.append({'name': k, 'type': type(v).__name__, 'repr': r[:200]})",
          "    return json.dumps(out, ensure_ascii=False)",
          "print(__nb2_vars())",
        ].join("\n")
        const r = await evalQuiet(s, code)
        if (!r.ok) return r
        try {
          return { vars: JSON.parse(String(r.stdout).trim() || "[]"), ms: r.ms }
        } catch {
          return { vars: [], raw: r.stdout, ms: r.ms }
        }
      },
    }),
    tool({
      name: "nb_inspect_object",
      description: "Inspect one live kernel variable by name (type, repr, len/shape when available).",
      parameters: { name: { type: "string", required: true, description: "Variable name." } },
      execute: async (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const name = String((a && a.name) || "").trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: "invalid identifier" }
        const code = [
          "def __nb2_inspect():",
          "    import json",
          `    name = ${JSON.stringify(name)}`,
          "    g = globals()",
          "    if name not in g:",
          "        return json.dumps({'found': False})",
          "    v = g[name]",
          "    info = {'found': True, 'name': name, 'type': type(v).__name__}",
          "    try:",
          "        info['len'] = len(v)",
          "    except Exception:",
          "        pass",
          "    for attr in ('shape', 'dtype', 'columns'):",
          "        try:",
          "            val = getattr(v, attr)",
          "            info[attr] = list(val) if attr == 'columns' else str(val)",
          "        except Exception:",
          "            pass",
          "    try:",
          "        info['repr'] = repr(v)[:500]",
          "    except Exception:",
          "        info['repr'] = '<unrepr>'",
          "    return json.dumps(info, ensure_ascii=False)",
          "print(__nb2_inspect())",
        ].join("\n")
        const r = await evalQuiet(s, code)
        if (!r.ok) return r
        try {
          return JSON.parse(String(r.stdout).trim() || "{}")
        } catch {
          return { raw: r.stdout }
        }
      },
    }),
    tool({
      name: "nb_cell_history",
      description: "Read a cell's recorded execution history (exec count, status, duration, finishedAt).",
      parameters: { cellId: { type: "string", required: true, description: "Cell id." } },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const c = s.notebook.cell(a.cellId)
        if (!c) return { error: `no such cell: ${a.cellId}` }
        const hist = (c.metadata && c.metadata.dsh2 && c.metadata.dsh2.executions) || []
        return { cellId: c.id, execCount: c.execCount, history: hist }
      },
    }),
    tool({
      name: "nb_revert_cell",
      description: "Not supported in v2: there is no cell version stack (the old plugin kept one). Read nb_cell_history and re-edit the source instead.",
      parameters: { cellId: { type: "string", description: "Cell id." } },
      execute: () => ({
        ok: false,
        unsupported: true,
        reason: "v2 用 cell.metadata.dsh2.executions 记录执行历史，但没有代码版本栈，无法回滚到旧版本。",
        suggestion: "用 nb_get 取回当前 source、按需要 nb_edit_cell 覆盖；或从 git / .ipynb 备份恢复。",
      }),
    }),
    tool({
      name: "nb_context",
      description: "Summarize the notebook as context for the agent: path, kernel, cells (first lines), recent error.",
      parameters: {
        includeVariables: { type: "boolean", description: "Also list kernel variables (old-plugin compatible)." },
      },
      execute: async (_a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const nb = s.notebook
        const lastError = [...nb.cells]
          .reverse()
          .flatMap((c) => (c.outputs || []).filter((o) => o.kind === "error").map((o) => ({ cellId: c.id, ename: o.ename, evalue: o.evalue })))
          .slice(0, 1)
        const out = {
          path: nb.path,
          kernel: nb.kernelState,
          python: s.interpreter ? s.interpreter.python : null,
          cwd: s.cwd || null,
          cells: nb.cells.map((c, i) => ({ index: i, id: c.id, cellType: c.cellType, status: c.status, firstLine: String(c.source).split("\n")[0].slice(0, 120) })),
          lastError: lastError[0] || null,
        }
        // 旧插件有 includeVariables；保留同义能力（内核没起来就跳过，不当成错误）
        if (_a && _a.includeVariables) {
          try {
            const code = [
              "def __nb2_vars():",
              "    import json",
              "    return json.dumps([{'name': k, 'type': type(v).__name__} for k, v in list(globals().items()) if not k.startswith('_')], ensure_ascii=False)",
              "print(__nb2_vars())",
            ].join("\n")
            const r = await evalQuiet(s, code)
            out.variables = r.ok ? JSON.parse(String(r.stdout).trim() || "[]") : []
            if (!r.ok) out.variablesError = r.error || r.raw
          } catch (err) {
            out.variablesError = String((err && err.message) || err)
          }
        }
        return out
      },
    }),
    tool({
      name: "nb_error_context",
      description: "Return the most recent cell error with its full traceback and the offending source.",
      parameters: { cellId: { type: "string", description: "Only this cell." } },
      execute: (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const nb = s.notebook
        const cells = a && a.cellId ? [nb.cell(a.cellId)].filter(Boolean) : [...nb.cells].reverse()
        for (const c of cells) {
          const err = (c.outputs || []).find((o) => o.kind === "error")
          if (err) return { cellId: c.id, source: c.source, ename: err.ename, evalue: err.evalue, traceback: err.traceback }
        }
        return { error: "no error found" }
      },
    }),
    tool({
      name: "nb_apply_suggestion",
      description: "Rewrite a cell with the model: give a natural-language instruction, get streaming output, apply it. Uses the host LLM service.",
      parameters: {
        cellId: { type: "string", required: true, description: "Cell id." },
        instruction: { type: "string", description: "What to change, in natural language." },
        // 旧插件这个工具吃的是 text，保留同义参数：否则会被**静默忽略**成"无指令重写"
        text: { type: "string", description: "Alias of instruction." },
        run: { type: "boolean", description: "Run the cell after applying (default false)." },
      },
      execute: async (a, exec) => {
        const s = sessionFor(sessionIdOf(exec))
        const cell = s.notebook.cell(a.cellId)
        if (!cell) return { error: `no such cell: ${a.cellId}` }
        const instruction = String((a && (a.instruction || a.text)) || "").trim()
        if (!instruction) return { error: "instruction / text required（不能没有指令就重写，否则会静默变成无指令改写）" }
        const out = await deps.aiRewrite(
          { sid: s.sid, cellId: a.cellId, code: cell.source, instruction, mode: "rewrite" },
          s,
        )
        if (out.error) return { ok: false, error: out.error, text: out.text }
        const next = deps.stripFences(out.text || "")
        if (!next) return { ok: false, error: "empty suggestion" }
        s.notebook.editCell(a.cellId, next)
        cell.sourceDirty = true
        s.bus.emit("nb.updated", { revision: s.notebook.revision, source: "agent", cellId: cell.id, op: "edit" })
        if (a.run) await s.runCell(a.cellId).catch(() => {})
        return { ok: true, applied: next, ms: out.ms }
      },
    }),
  )

  return tools
}

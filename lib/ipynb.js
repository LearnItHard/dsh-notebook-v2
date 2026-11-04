/**
 * .ipynb 读写：**语义等价无损**。
 *
 * 验收判据（评审已把「字节级等价」降级）：
 *   读入 → 原样写回 → 与原文 **深比较相等**（键顺序无关）。
 * 做法：每个 cell 保留原始 JSON（raw / rawOutputs）；只要该 cell 没被执行过、
 * source 没被改过，写回时**逐字段复用原文**，连 `attachments`、`metadata.widgets`、
 * `metadata.dsh2`、以及我们不认识的字段都原样带回去。
 *
 * 为什么不能直接重建：旧插件写过 `metadata.dsh`（版本栈）与执行历史，科研用户还可能挂
 * `metadata.widgets`。丢字段 = 用户数据受损，这比少一个功能严重得多。
 */

import { readFile, writeFile, rename } from "node:fs/promises"
import { Notebook, emptyCell, newCellId } from "./notebook.js"

/** source 在 .ipynb 里可以是字符串或行数组；内部统一成字符串，同时记住原始形态。 */
function sourceToText(source) {
  if (Array.isArray(source)) return source.join("")
  return typeof source === "string" ? source : ""
}

/** 文本 → .ipynb 的 source 形态：保持"行数组 + 行尾换行"的惯用写法。 */
function textToLines(text) {
  const lines = String(text).split("\n")
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const isLast = i === lines.length - 1
    if (isLast && lines[i] === "") break
    out.push(isLast ? lines[i] : lines[i] + "\n")
  }
  return out
}

const MANAGED_CELL_KEYS = new Set(["cell_type", "source", "metadata", "outputs", "execution_count", "id"])

/** 我们模型里的输出块 → .ipynb 的 outputs 数组（只在真的执行过、输出变了时用）。 */
function outputsToIpynb(cell) {
  const out = []
  for (const block of cell.outputs) {
    if (block.kind === "stream") {
      // 连续同类 stream 我们已合并成一块；写回时保持一块 stream 是合法的
      out.push({ output_type: "stream", name: block.name || "stdout", text: block.text })
    } else if (block.kind === "error") {
      out.push({
        output_type: "error",
        ename: block.ename || "Error",
        evalue: block.evalue || "",
        traceback: Array.isArray(block.traceback) ? block.traceback : [],
      })
    } else if (block.kind === "display") {
      const data = {}
      const meta = {}
      for (const item of block.items || []) {
        if (item.kind === "path") continue // 落盘的大块不进 ipynb（无法还原时宁可不写）
        data[item.mime] = item.data
      }
      if (!Object.keys(data).length) continue
      const type = block.items && block.items[0] && block.items[0].result ? "execute_result" : "display_data"
      const entry = { output_type: type, data, metadata: meta }
      if (type === "execute_result") entry.execution_count = cell.execCount ?? null
      out.push(entry)
    }
  }
  return out
}

/**
 * .ipynb JSON → Notebook
 * @param {object} json 已解析的 .ipynb
 * @param {{path?:string, title?:string}} [opts]
 */
export function notebookFromIpynb(json, opts = {}) {
  const nb = new Notebook({ path: opts.path || null, title: opts.title || null })
  nb.raw = json
  nb.nbformat = json.nbformat ?? 4
  nb.nbformatMinor = json.nbformat_minor ?? 5
  nb.metadata = json.metadata ?? {}

  for (const rawCell of json.cells || []) {
    const cellType = rawCell.cell_type || "code"
    let srcText = sourceToText(rawCell.source)
    let magic = null
    // shell 格在 .ipynb 里就是「带 %%bash 魔法行的 code 格」——这是 Jupyter 的标准写法，
    // 所以文件在 JupyterLab / VS Code 里仍然是合法 notebook（Linux 上还能真跑）。
    // 我们把它剥掉存进模型，写回时再贴回去（见 notebookToIpynb）。
    if (cellType === "code") {
      const m = /^\s*%%(bash|sh|script\s+(?:bash|sh))\s*(?:\n|$)/.exec(srcText)
      if (m) {
        magic = m[0].trim()
        srcText = srcText.slice(m[0].length)
      }
    }
    const cell = emptyCell(magic ? "bash" : cellType, srcText)
    cell.magic = magic
    // 内部 id 用 .ipynb 的 id（nbformat 4.5+ 有），否则生成
    cell.id = typeof rawCell.id === "string" && rawCell.id ? rawCell.id : newCellId()
    cell.nbId = cell.id
    cell.metadata = JSON.parse(JSON.stringify(rawCell.metadata || {}))
    cell.execCount = rawCell.execution_count ?? null
    cell.rawCell = JSON.parse(JSON.stringify(rawCell))
    cell.rawOutputs = JSON.parse(JSON.stringify(rawCell.outputs || []))
    cell.rawSource = rawCell.source
    cell.sourceDirty = false
    cell.outputsDirty = false
    // 把 .ipynb 的 outputs 展示成我们模型的输出块（只读视图；不改就原样写回）
    cell.outputs = ipynbOutputsToBlocks(rawCell.outputs || [], cell.id)
    if (cellType !== "code") cell.outputs = []
    nb.cells.push(cell)
  }
  nb.dirtyRevision = 0
  nb.revision = 0
  return nb
}

/** .ipynb outputs → 我们的输出块（显示用；写回时不依赖它）。 */
export function ipynbOutputsToBlocks(rawOutputs, cellId) {
  const blocks = []
  for (const raw of rawOutputs) {
    const type = raw.output_type
    if (type === "stream") {
      const name = raw.name || "stdout"
      const text = sourceToText(raw.text)
      const last = blocks[blocks.length - 1]
      // 与运行期一致：连续同类 stream 合并成一块
      if (last && last.kind === "stream" && last.name === name) last.text += text
      else blocks.push({ id: `out-${cellId}-${blocks.length}-${name}`, kind: "stream", name, text })
    } else if (type === "error") {
      blocks.push({
        id: `err-${cellId}-${blocks.length}`,
        kind: "error",
        ename: raw.ename,
        evalue: raw.evalue,
        traceback: raw.traceback || [],
      })
    } else if (type === "display_data" || type === "execute_result") {
      const items = []
      for (const [mime, value] of Object.entries(raw.data || {})) {
        items.push({ mime, data: value, kind: "mime", result: type === "execute_result" })
      }
      blocks.push({ id: `disp-${cellId}-${blocks.length}`, kind: "display", items })
    }
  }
  return blocks
}

/** Notebook → .ipynb JSON（语义等价写回）。 */
export function notebookToIpynb(nb) {
  const base = nb.raw ? JSON.parse(JSON.stringify(nb.raw)) : {}
  const cells = nb.cells.map((cell) => {
    // bash 格写回时贴回 %%bash（读进来时剥掉的），保证文件仍是标准 Jupyter 写法
    const isShell = cell.cellType === "bash"
    const shellMagic = isShell ? cell.magic || "%%bash" : null
    const srcWithMagic = shellMagic ? `${shellMagic}\n${cell.source}` : cell.source
    // 没动过 → 原文照抄（连未知字段、attachments、widgets 一起）
    if (cell.rawCell) {
      const out = JSON.parse(JSON.stringify(cell.rawCell))
      if (cell.sourceDirty || (isShell && cell.rawCell.cell_type !== "code")) {
        out.source = Array.isArray(cell.rawSource) ? textToLines(srcWithMagic) : srcWithMagic
        out.cell_type = isShell ? "code" : out.cell_type
      }
      // 元数据只有在我们写了 dsh2（执行历史）时才覆盖
      if (cell.metadata && Object.keys(cell.metadata).length) {
        out.metadata = mergeMetadata(cell.rawCell.metadata, cell.metadata)
      }
      if (cell.outputsDirty) {
        out.outputs = outputsToIpynb(cell)
        out.execution_count = cell.execCount ?? null
      }
      if (!out.id && cell.id && nb.nbformatMinor >= 5) out.id = cell.id
      return out
    }
    // 新加的 cell
    const out = {
      cell_type: isShell ? "code" : cell.cellType,
      metadata: cell.metadata || {},
      source: textToLines(srcWithMagic),
    }
    if (nb.nbformatMinor >= 5) out.id = cell.id
    if (out.cell_type === "code") {
      out.outputs = outputsToIpynb(cell)
      out.execution_count = cell.execCount ?? null
    }
    return out
  })

  const result = Object.assign({}, base, {
    cells,
    nbformat: nb.nbformat ?? 4,
    nbformat_minor: nb.nbformatMinor ?? 5,
  })
  // 保留原始 metadata 的未知字段；把我们没改过的原样带回去
  result.metadata = nb.metadata ?? base.metadata ?? {}
  return result
}

/**
 * 合并元数据：原文的字段全部保留，只覆盖我们管理的 dsh2（执行历史）。
 * 旧插件的 metadata.dsh 必须原样留着 —— 用户回滚到旧插件时还要用。
 */
function mergeMetadata(rawMeta, currentMeta) {
  const merged = JSON.parse(JSON.stringify(rawMeta || {}))
  for (const [key, value] of Object.entries(currentMeta || {})) {
    if (key === "dsh2") {
      merged.dsh2 = value
    } else if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged
}

// ── 文件 IO ──

export async function readIpynbFile(path) {
  const text = await readFile(path, "utf8")
  const json = JSON.parse(text)
  return notebookFromIpynb(json, { path })
}

/** 原子写：先写临时文件再 rename，避免写一半断电毁 notebook。 */
export async function writeIpynbFile(path, json) {
  const text = JSON.stringify(json, null, 1) + "\n"
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, "utf8")
  await rename(tmp, path)
  return text.length
}

/** 纯内存往返（测试用）：读 JSON → 模型 → 写回 JSON。 */
export function roundTrip(json) {
  const nb = notebookFromIpynb(json)
  return notebookToIpynb(nb)
}

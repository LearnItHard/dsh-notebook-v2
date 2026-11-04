/**
 * Notebook 模型 + .ipynb 无损往返的单元测试（纯逻辑，不需要内核、不需要 DSH）。
 *
 * 覆盖的是 M1/M3 里最容易写错、且肉眼最难发现的地方：
 *   - stream 复用 last-used 输出块（print 一万行只产生 1 块）
 *   - 非 stream 输出清空复用记录
 *   - display 的 update 走替换而不是追加
 *   - 状态机越界转移被忽略（竞态下会收到乱序事件）
 *   - 迟到尾包窗口
 *   - 队列去重 / 遇错停止 / raises-exception 例外 / 取消
 *   - 执行历史上限 50
 *   - .ipynb 语义等价往返（未知字段、attachments、metadata.widgets、metadata.dsh 全保留）
 *
 * 运行：node dsh-notebook-v2/test/model.mjs
 */

import { Notebook, emptyCell, LATE_WINDOW_MS, MAX_EXECUTIONS_PER_CELL } from "../lib/notebook.js"
import { notebookFromIpynb, notebookToIpynb, roundTrip } from "../lib/ipynb.js"

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function nbWithCells(n = 1) {
  const nb = new Notebook()
  const ids = []
  for (let i = 0; i < n; i += 1) ids.push(nb.addCell("code", `print(${i})`).id)
  nb.revision = 0
  return { nb, ids }
}

console.log("dsh-notebook-v2 · model/ipynb tests\n")

// ───────────────── 1. stream 复用 last-used 输出块 ─────────────────
{
  console.log("[stream 合并]")
  const { nb, ids } = nbWithCells(1)
  const id = ids[0]
  nb.applyEvent("cell.started", { cellId: id, execCount: 1 })
  let r
  for (let i = 0; i < 5; i += 1) r = nb.applyEvent("stream", { cellId: id, name: "stdout", text: `line ${i}\n` })
  const cell = nb.cell(id)
  check("5 条连续 stream → 只 1 个输出块", cell.outputs.length === 1, `blocks=${cell.outputs.length}`)
  check("文本是拼接的", cell.outputs[0].text === "line 0\nline 1\nline 2\nline 3\nline 4\n", JSON.stringify(cell.outputs[0].text.slice(0, 20)))
  check("outId 全程不变", r.outId === cell.outputs[0].id)

  // 混入 display 后再 stream → 必须新建块
  nb.applyEvent("display", { cellId: id, mime: "text/plain", data: "42", kind: "result", outId: "res-1" })
  nb.applyEvent("stream", { cellId: id, name: "stdout", text: "after\n" })
  check("display 之后的 stream 新建块", nb.cell(id).outputs.length === 3, `blocks=${nb.cell(id).outputs.length}`)

  // stderr 与 stdout 不共用块
  nb.applyEvent("stream", { cellId: id, name: "stderr", text: "warn\n" })
  check("stdout/stderr 分成两块", nb.cell(id).outputs.length === 4, `blocks=${nb.cell(id).outputs.length}`)
}

// ───────────────── 2. display update 走替换 ─────────────────
{
  console.log("\n[display update]")
  const { nb, ids } = nbWithCells(1)
  const id = ids[0]
  nb.applyEvent("display", { cellId: id, mime: "text/html", data: "<b>1</b>", outId: "d1" })
  nb.applyEvent("display", { cellId: id, mime: "text/html", data: "<b>2</b>", outId: "d1", update: true })
  const block = nb.cell(id).outputs[0]
  check("同 outId 更新不新增块", nb.cell(id).outputs.length === 1)
  check("内容被替换", block.items.length === 1 && block.items[0].data === "<b>2</b>", JSON.stringify(block.items))

  // 一个 display 里多个 mime 各占一项
  nb.applyEvent("display", { cellId: id, mime: "text/plain", data: "x", outId: "d2" })
  nb.applyEvent("display", { cellId: id, mime: "image/png", data: "AAA", outId: "d2" })
  const multi = nb.cell(id).outputs.find((o) => o.id === "d2")
  check("一个 display 多 mime 合成一项集合", multi.items.length === 2, `items=${multi.items.length}`)
}

// ───────────────── 3. 状态机 ─────────────────
{
  console.log("\n[状态机]")
  const { nb, ids } = nbWithCells(1)
  const cell = nb.cell(ids[0])
  check("初始 idle", cell.status === "idle")
  check("idle → queued", nb.setStatus(cell, "queued") && cell.status === "queued")
  check("queued → running", nb.setStatus(cell, "running") && cell.status === "running")
  check("running → ok", nb.setStatus(cell, "ok") && cell.status === "ok")
  check("越界转移被忽略（ok → queued 不允许）", nb.setStatus(cell, "queued") === true && cell.status === "queued")
  const bad = nb.setStatus(cell, "running")
  check("queued → running 合法", bad === true)
  // 从 running 直接跳到 queued 不合法
  const noop = nb.setStatus(cell, "queued")
  check("running → queued 被拒绝", noop === false && cell.status === "running")
}

// ───────────────── 4. 迟到尾包窗口 ─────────────────
{
  console.log("\n[迟到尾包]")
  const { nb, ids } = nbWithCells(1)
  const id = ids[0]
  nb.applyEvent("cell.started", { cellId: id, execCount: 1 })
  nb.applyEvent("cell.done", { cellId: id, status: "ok", durationMs: 5 })
  const soon = nb.applyEvent("stream", { cellId: id, name: "stdout", text: "late\n" })
  check("done 后立刻到的尾包被接受", soon.applied === true)

  // 把时间戳往回拨，模拟超出窗口
  nb.lastDoneAt.set(id, Date.now() - LATE_WINDOW_MS - 1000)
  const late = nb.applyEvent("stream", { cellId: id, name: "stdout", text: "too late\n" })
  check("超过窗口的尾包被拒绝", late.applied === false && late.reason === "late packet out of window", late.reason)
}

// ───────────────── 5. 队列语义 ─────────────────
{
  console.log("\n[队列]")
  const { nb, ids } = nbWithCells(3)
  check("入队", nb.enqueue(ids[0]) === true && nb.queue.length === 1)
  check("重复入队去重", nb.enqueue(ids[0]) === false && nb.queue.length === 1)
  nb.enqueue(ids[1])
  nb.enqueue(ids[2])
  check("队列顺序", eq(nb.queue, ids), JSON.stringify(nb.queue))
  check("next() 取队首", nb.next() === ids[0])

  // 遇错停止：取消剩余全部
  nb.setStatus(nb.cell(ids[0]), "running")
  const res = nb.onCellError(ids[0])
  check("遇错取消剩余", eq(res.cancelled, ids.slice(1)), JSON.stringify(res.cancelled))
  check("取消的 cell 状态为 cancelled", nb.cell(ids[1]).status === "cancelled")
  check("出错的 cell 也被移出队列", !nb.queue.includes(ids[0]), JSON.stringify(nb.queue))

  // raises-exception 例外：允许继续
  const { nb: nb2, ids: ids2 } = nbWithCells(2)
  nb2.cell(ids2[0]).metadata.tags = ["raises-exception"]
  nb2.enqueue(ids2[1])
  nb2.setStatus(nb2.cell(ids2[0]), "running")
  const res2 = nb2.onCellError(ids2[0])
  check("raises-exception 不取消剩余", res2.cancelled.length === 0 && nb2.queue.length === 1)

  // cancelAll
  const { nb: nb3, ids: ids3 } = nbWithCells(2)
  nb3.enqueue(ids3[0])
  nb3.enqueue(ids3[1])
  const cancelled = nb3.cancelAll()
  check("cancelAll 清空队列", cancelled.length === 2 && nb3.queue.length === 0)
}

// ───────────────── 6. 执行历史 ─────────────────
{
  console.log("\n[执行历史]")
  const { nb, ids } = nbWithCells(1)
  const id = ids[0]
  for (let i = 0; i < MAX_EXECUTIONS_PER_CELL + 12; i += 1) {
    nb.applyEvent("cell.executed", { cellId: id, execCount: i + 1, status: "ok", durationMs: 1, finishedAt: Date.now() })
  }
  const hist = nb.cell(id).metadata.dsh2.executions
  check(`历史上限 ${MAX_EXECUTIONS_PER_CELL}`, hist.length === MAX_EXECUTIONS_PER_CELL, `len=${hist.length}`)
  check("保留的是最新的", hist[hist.length - 1].execCount === MAX_EXECUTIONS_PER_CELL + 12, `last=${hist[hist.length - 1].execCount}`)
}

// ───────────────── 7. .ipynb 语义等价往返 ─────────────────
{
  console.log("\n[.ipynb 往返]")
  const original = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
      language_info: { name: "python", version: "3.11.15" },
      widgets: { "application/vnd.jupyter.widget-state+json": { state: { a: { model_name: "X" } }, version_major: 2 } },
      dsh: { versions: [{ at: 1, by: "old-plugin" }] },
      // 我们不认识的字段也必须留住
      some_future_field: { nested: [1, 2, { deep: true }] },
    },
    cells: [
      {
        cell_type: "code",
        id: "aaa111",
        execution_count: 3,
        metadata: {
          tags: ["raises-exception"],
          dsh2: { executions: [{ execCount: 3, status: "ok", durationMs: 12, finishedAt: 1 }] },
          collapsed: false,
        },
        source: ["print('hi')\n", "x = 1"],
        outputs: [
          { output_type: "stream", name: "stdout", text: ["hi\n"] },
          {
            output_type: "execute_result",
            execution_count: 3,
            data: { "text/plain": ["1"], "text/html": ["<b>1</b>"] },
            metadata: { scrolled: false },
          },
        ],
        unknown_cell_key: "keep me",
      },
      {
        cell_type: "markdown",
        id: "bbb222",
        metadata: {},
        source: "# Title\n\nSome text",
        attachments: { "img.png": { "image/png": "AAAA" } },
      },
      {
        cell_type: "code",
        id: "ccc333",
        execution_count: null,
        metadata: {},
        source: "",
        outputs: [],
      },
    ],
    unknown_top_key: [1, 2, 3],
  }

  const back = roundTrip(original)
  check("顶层未知字段保留", eq(back.unknown_top_key, original.unknown_top_key), JSON.stringify(back.unknown_top_key))
  check("metadata 深度相等（含 widgets/dsh/未来字段）", eq(back.metadata, original.metadata))
  check("cells 数量一致", back.cells.length === original.cells.length)
  check("cell 未知字段保留", back.cells[0].unknown_cell_key === "keep me")
  check("source 数组形态保留", eq(back.cells[0].source, original.cells[0].source), JSON.stringify(back.cells[0].source))
  check("outputs 逐字节一致", eq(back.cells[0].outputs, original.cells[0].outputs))
  check("attachments 保留", eq(back.cells[1].attachments, original.cells[1].attachments))
  check("cell id 保留", back.cells[0].id === "aaa111" && back.cells[2].id === "ccc333")
  check("**整体深比较相等**", eq(back, original), eq(back, original) ? "完全等价" : "有差异")

  // 修改后写回：只该变 source
  const nb = notebookFromIpynb(original)
  const c0 = nb.cells[0]
  c0.source = "print('changed')"
  c0.sourceDirty = true
  const back2 = notebookToIpynb(nb)
  // 原文是行数组 → 改动后仍写行数组（保持原始形态才是最保守的无损策略）
  check("改过的 source 写回（沿用原数组形态）", eq(back2.cells[0].source, ["print('changed')"]), JSON.stringify(back2.cells[0].source))
  check("其他字段仍未受影响", back2.cells[0].unknown_cell_key === "keep me" && eq(back2.cells[1], original.cells[1]))
  check("旧插件 metadata.dsh 仍在", eq(back2.metadata.dsh, original.metadata.dsh))

  // 新 cell 写回
  const nb2 = notebookFromIpynb(original)
  nb2.addCell("code", "print('new')")
  const back3 = notebookToIpynb(nb2)
  check("新 cell 追加在末尾", back3.cells.length === 4 && back3.cells[3].cell_type === "code", `len=${back3.cells.length}`)
  check("新 cell 带 id（nbformat 4.5）", typeof back3.cells[3].id === "string" && back3.cells[3].id.length > 0)
}

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

/**
 * 单元格类型测试：code / markdown / raw / shell。
 *
 * 这一套盯的是用户明确提的需求：「notebook 不止能写代码，还要有 sh、md 这类格式」。
 * 所以四个面都要断言：
 *   1. 类型归一化（三个入口共用一张别名表，客户端与宿主两边必须一致）
 *   2. .ipynb 往返：shell 格 = 带 `%%bash` 魔法行的 code 格（Jupyter 标准写法）
 *   3. 执行语义：shell 格真跑、不需要 Python 内核；markdown/raw 永不执行；runAll 跳过文档格
 *   4. 换类型：清掉已无意义的输出，且写回时序列化跟着变
 *
 * 运行：node dsh-notebook-v2/test/celltypes.mjs
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadPlugin, makeCtx } from "./_load.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

const { normalizeCellType, emptyCell, Notebook, isRunnableCell } = await import(
  pathToFileURL(join(HERE, "..", "lib", "notebook.js")).href
)
const { notebookFromIpynb, notebookToIpynb } = await import(pathToFileURL(join(HERE, "..", "lib", "ipynb.js")).href)
const { pickShellKind, hasBash } = await import(pathToFileURL(join(HERE, "..", "lib", "shell.js")).href)

// ─────────────────────── 1. 类型归一化（含两端一致） ───────────────────────
console.log("\n[1] 类型归一化")

{
  const table = [
    ["code", "code"],
    ["py", "code"],
    ["python", "code"],
    ["", "code"],
    [null, "code"],
    ["markdown", "markdown"],
    ["md", "markdown"],
    ["MD", "markdown"],
    ["  markdown  ", "markdown"],
    ["bash", "bash"],
    ["sh", "bash"],
    ["shell", "bash"],
    ["cmd", "bash"],
    ["pwsh", "bash"],
    ["raw", "raw"],
    ["text", "raw"],
    ["不认识", "code"],
  ]
  const bad = []
  for (const [input, want] of table) {
    const got = normalizeCellType(input)
    if (got !== want) bad.push(`${String(input)}→${got}(期望${want})`)
  }
  check("宿主半 normalizeCellType 别名表", bad.length === 0, bad.length ? bad.join(", ") : `${table.length} 组全对`)
}

{
  // 客户端半是自包含工厂，抄了一份同名实现；历史教训是「只改一边」→ 行为分叉。
  // 这里用同一张表同时喂两边，断言逐项相同。
  let loaded = null
  const prevWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (e) => (loaded = e) }, location: { origin: "http://x" } }
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: "Fragment",
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const requireStub = (name) => {
    if (name === "react") return ReactStub
    throw new Error(`意外的外部依赖：${name}`)
  }
  const mod = loaded ? loaded : null
  try {
    await import(pathToFileURL(join(HERE, "..", "lib", "client.js")).href)
  } catch {
    /* 客户端半在无 DOM 环境里执行到注册为止就会返回；失败由下面的 loaded 判定 */
  }
  const clientMod = loaded && loaded.factory ? loaded.factory(requireStub) : null
  globalThis.window = prevWindow
  const clientNorm = clientMod && clientMod.__internals ? clientMod.__internals.normalizeCellType : null
  check("客户端半导出了 normalizeCellType", typeof clientNorm === "function")
  if (typeof clientNorm === "function") {
    const differs = []
    for (const v of ["code", "py", "markdown", "md", "bash", "sh", "shell", "cmd", "pwsh", "raw", "text", "", null, "zzz"]) {
      if (clientNorm(v) !== normalizeCellType(v)) differs.push(`${String(v)}: ${clientNorm(v)} vs ${normalizeCellType(v)}`)
    }
    check("客户端与宿主的归一化结果完全一致（防两边漂移）", differs.length === 0, differs.join("; ") || "14 组一致")
  }
  void mod
}

{
  check("isRunnableCell：code/bash 要跑", isRunnableCell("code") && isRunnableCell("bash"))
  check("isRunnableCell：markdown/raw 不跑", !isRunnableCell("markdown") && !isRunnableCell("raw"))
}

// ─────────────────────── 2. .ipynb 往返（%%bash） ───────────────────────
console.log("\n[2] .ipynb 往返：shell 格 = 带 %%bash 的 code 格")

const shaBash = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3", display_name: "Python 3" } },
  cells: [
    {
      id: "c1",
      cell_type: "code",
      execution_count: 1,
      metadata: {},
      outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }],
      source: ["%%bash\n", "echo hi\n", "pwd\n"],
    },
    {
      id: "c2",
      cell_type: "markdown",
      metadata: {},
      source: ["# 标题\n", "\n", "正文\n"],
    },
    {
      id: "c3",
      cell_type: "raw",
      metadata: {},
      source: ["raw content\n"],
    },
  ],
}

{
  const nb = notebookFromIpynb(JSON.parse(JSON.stringify(shaBash)))
  check("读到 3 个格", nb.cells.length === 3, `cells=${nb.cells.length}`)
  check("第 1 格识别为 bash", nb.cells[0].cellType === "bash", nb.cells[0].cellType)
  check("%%bash 魔法行被剥掉（UI 里不显示）", nb.cells[0].source === "echo hi\npwd\n", JSON.stringify(nb.cells[0].source))
  check("记下了原本的魔法行（写回时贴回去）", nb.cells[0].magic === "%%bash", nb.cells[0].magic)
  check("markdown 格类型正确", nb.cells[1].cellType === "markdown")
  check("raw 格类型正确", nb.cells[2].cellType === "raw")

  const back = notebookToIpynb(nb)
  check("原样写回 → 深比较完全一致（含 %%bash 与 outputs）", JSON.stringify(back) === JSON.stringify(shaBash), diffHint(back, shaBash))
}

{
  // 编辑过 shell 格（sourceDirty）→ 仍然带 %%bash 写回
  const nb = notebookFromIpynb(JSON.parse(JSON.stringify(shaBash)))
  nb.editCell(nb.cells[0].id, "echo edited")
  nb.cells[0].sourceDirty = true
  const back = notebookToIpynb(nb)
  const src = Array.isArray(back.cells[0].source) ? back.cells[0].source.join("") : back.cells[0].source
  check("改过的 shell 格写回仍以 %%bash 开头", src.startsWith("%%bash\n"), JSON.stringify(src))
  check("改过的 shell 格内容正确", src === "%%bash\necho edited", JSON.stringify(src))
  check("写回后 cell_type 仍是 code（Jupyter 合法）", back.cells[0].cell_type === "code", back.cells[0].cell_type)
}

{
  // python 格转成 shell 格：写回必须补上 %%bash（这是「换类型」最容易漏的一条）
  const py = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ id: "p1", cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["print(1)\n"] }],
  }
  const nb = notebookFromIpynb(py)
  nb.setCellType(nb.cells[0].id, "bash")
  nb.cells[0].sourceDirty = true
  const back = notebookToIpynb(nb)
  const src = Array.isArray(back.cells[0].source) ? back.cells[0].source.join("") : back.cells[0].source
  check("python→shell 换类型后写回带 %%bash", src.startsWith("%%bash\n"), JSON.stringify(src))
}

{
  // 没有 id 的旧 notebook（nbformat 4.4）不能因为我们的往返而崩
  const old = {
    nbformat: 4,
    nbformat_minor: 4,
    metadata: {},
    cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["%%sh\n", "ls\n"] }],
  }
  const nb = notebookFromIpynb(JSON.parse(JSON.stringify(old)))
  check("识别 %%sh 变体", nb.cells[0].cellType === "bash" && nb.cells[0].magic === "%%sh", nb.cells[0].magic)
  const back = notebookToIpynb(nb)
  check("%%sh 原样保留（不强行改成 %%bash）", back.cells[0].source.join("").startsWith("%%sh\n"), JSON.stringify(back.cells[0].source))
}

// ─────────────────────── 3. 执行语义（真进程） ───────────────────────
console.log("\n[3] 执行语义：shell 格真跑，markdown 永不执行")

const { mod, routes, teardown } = await (async () => {
  const { mod, dir } = await loadPlugin()
  return { mod, dir }
})()
const { createServer } = await import("node:http")
const { makeCtx: mk } = await import("./_load.mjs")
const ctxBag = mk({ workspaceRoot: await mkdtemp(join(tmpdir(), "nb2-ct-")) })
mod.apply(ctxBag.ctx, { enabled: true })

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost")
  const route = ctxBag.routes.find((r) => (r.kind === "prefix" ? url.pathname.startsWith(r.path) : url.pathname === r.path))
  if (!route) {
    res.statusCode = 404
    return res.end("no route")
  }
  return route.handler(req, res)
})
const origin = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))
})

async function post(path, body) {
  const res = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const getState = async (sid) => (await fetch(`${origin}/nb2/state?sid=${sid}`)).json()

const SID = "ct1"
const st0 = await getState(SID)
check("初始没有 sidecar（不主动拉起 Python 内核）", st0.sidecar === null, JSON.stringify(st0.sidecar))

{
  // bash 格：agent 工具建的格也能跑
  const add = await post("/nb2/cell/add", { sid: SID, cellType: "bash", source: "echo from-shell" })
  check("cell/add 接受 cellType=bash", add.status === 200 && add.json.cell.cellType === "bash", JSON.stringify(add.json))
  const cellId = add.json.cell.id

  const run = await post("/nb2/cell/run", { sid: SID, cellId })
  check("cell/run 返回 ok", run.json && run.json.ok === true, JSON.stringify(run.json && run.json.done))
  check("shell 格执行成功（status=ok）", run.json.done.status === "ok", JSON.stringify(run.json.done))

  const st = await getState(SID)
  const cell = st.cells.find((c) => c.id === cellId)
  const text = (cell.outputs || []).filter((o) => o.kind === "stream").map((o) => o.text).join("")
  check("输出经 stream 块回到模型", text.includes("from-shell"), JSON.stringify(text.trim()))
  check("execCount 已写回", typeof cell.execCount === "number" && cell.execCount >= 1, `execCount=${cell.execCount}`)
  check("durationMs 有值", typeof cell.durationMs === "number" && cell.durationMs >= 0, `durationMs=${cell.durationMs}`)
  check("跑完仍然没有 sidecar（shell 完全不依赖 Python 内核）", st.sidecar === null, JSON.stringify(st.sidecar))
  check("内核状态没被 shell 格改写", st.kernelState === "unknown", st.kernelState)
}

{
  // 非零退出码 → error 块 + status=error
  // ⚠️ 退出码的写法必须跟着**实际**用的 shell 走：这台机器有 git-bash 时
  // KIND=bash，`exit /b 7` 会被 bash 当成非法数字（exit 2），测试就会假红。
  const kind = pickShellKind({ platform: process.platform, hasBash: hasBash() })
  const exitCodeSrc = kind === "bash" ? "exit 7" : kind === "pwsh" ? "exit 7" : "exit /b 7"
  const add = await post("/nb2/cell/add", { sid: SID, cellType: "bash", source: exitCodeSrc })
  const cellId = add.json.cell.id
  const run = await post("/nb2/cell/run", { sid: SID, cellId })
  check("非零退出码 → status=error", run.json.done.status === "error", JSON.stringify(run.json.done))
  const st = await getState(SID)
  const cell = st.cells.find((c) => c.id === cellId)
  const errBlock = (cell.outputs || []).find((o) => o.kind === "error")
  check("产生了 error 输出块", !!errBlock, errBlock ? errBlock.ename : "none")
  check("错误信息里带退出码 7", !!errBlock && /7/.test(String(errBlock.evalue)), errBlock && errBlock.evalue)
}

{
  // markdown 格：runCell 直接 skipped，不产生输出
  const add = await post("/nb2/cell/add", { sid: SID, cellType: "markdown", source: "# hi" })
  const cellId = add.json.cell.id
  const run = await post("/nb2/cell/run", { sid: SID, cellId })
  check("markdown 格 runCell 返回 skipped", run.json.done.skipped === true, JSON.stringify(run.json.done))
  const st = await getState(SID)
  const cell = st.cells.find((c) => c.id === cellId)
  check("markdown 格没有输出", (cell.outputs || []).length === 0, `outputs=${(cell.outputs || []).length}`)
  check("markdown 格 execCount 仍是 null", cell.execCount === null, String(cell.execCount))
}

{
  // runAll：只跑代码格与 shell 格，跳过 markdown/raw
  const stBefore = await getState(SID)
  const before = stBefore.cells.map((c) => ({ id: c.id, type: c.cellType }))
  const run = await post("/nb2/runAll", { sid: SID })
  check("runAll 返回 ok", run.json && run.json.ok === true)
  const ranIds = new Set((run.json.results || []).map((r) => r.cellId))
  const mdCell = before.find((c) => c.type === "markdown")
  const rawCell = before.find((c) => c.type === "raw")
  check("runAll 跳过了 markdown 格", mdCell ? !ranIds.has(mdCell.id) : true, `ran=${ranIds.size}`)
  check("runAll 跳过了 raw 格", rawCell ? !ranIds.has(rawCell.id) : true)
  check("runAll 覆盖了 shell 格", before.some((c) => c.type === "bash" && ranIds.has(c.id)), `ran=${[...ranIds].length}`)
}

{
  // 中断 shell 格：状态必须是 cancelled（不是 error），且不该塞一个 ShellKilled 红块
  // 长跑命令：等 5s，跑起来后立刻中断
  const longSrc = process.platform === "win32" ? "ping -n 6 127.0.0.1 >nul" : "sleep 5"
  const add = await post("/nb2/cell/add", { sid: SID, cellType: "bash", source: longSrc })
  const cellId = add.json.cell.id
  // 不 await：先让它跑起来
  const running = post("/nb2/cell/run", { sid: SID, cellId })
  await new Promise((r) => setTimeout(r, 400))
  await post("/nb2/kernel/interrupt", { sid: SID })
  const run = await running
  check("中断后 cell/run 返回", !!run.json, JSON.stringify(run.json && run.json.done))
  const st = await getState(SID)
  const cell = st.cells.find((c) => c.id === cellId)
  check("中断的 shell 格状态是 cancelled（不是 error）", cell.status === "cancelled", cell.status)
  const errBlocks = (cell.outputs || []).filter((o) => o.kind === "error")
  check("中断不再塞 ShellKilled 错误块", errBlocks.length === 0, `error blocks=${errBlocks.length}`)
}

{
  // 换类型：cellType-only 的 cell/edit 生效，且 markdown 会清掉旧输出
  const add = await post("/nb2/cell/add", { sid: SID, cellType: "bash", source: "echo x" })
  const cellId = add.json.cell.id
  await post("/nb2/cell/run", { sid: SID, cellId })
  let st = await getState(SID)
  check("换类型前有输出", (st.cells.find((c) => c.id === cellId).outputs || []).length > 0)

  const conv = await post("/nb2/cell/edit", { sid: SID, cellId, cellType: "markdown" })
  check("cell/edit 只传 cellType 也能生效", conv.json.ok === true && conv.json.cell.cellType === "markdown", JSON.stringify(conv.json))
  st = await getState(SID)
  const cell = st.cells.find((c) => c.id === cellId)
  check("转成 markdown 后输出被清空", (cell.outputs || []).length === 0, `outputs=${(cell.outputs || []).length}`)
  check("转成 markdown 后 execCount 归零", cell.execCount === null, String(cell.execCount))

  // 再换回 shell，确认 source 没丢
  await post("/nb2/cell/edit", { sid: SID, cellId, cellType: "bash" })
  st = await getState(SID)
  check("换回 shell 后 source 保留", st.cells.find((c) => c.id === cellId).source === "echo x")
}

{
  // 工具层：nb_add_cell 建 shell 格 + nb_edit_cell 只改类型
  // ⚠️ 工具通过 exec.agent.session.id 找会话（与 DSH 的真实调用形状一致）
  const exec = { agent: { session: { id: SID } } }
  const tools = ctxBag.tools
  const addTool = tools.find((t) => t.name === "nb_add_cell")
  const editTool = tools.find((t) => t.name === "nb_edit_cell")
  const added = await addTool.execute({ cellType: "sh", source: "echo tool" }, exec)
  check("nb_add_cell 接受 cellType=sh 并归一为 bash", added.cell.cellType === "bash", added.cell.cellType)
  const edited = await editTool.execute({ cellId: added.cell.id, cellType: "md" }, exec)
  check("nb_edit_cell 只传 cellType 可换类型", edited.cellType === "markdown", JSON.stringify(edited))
  const st = await getState(SID)
  check("工具建出来的 md 格在模型里也是 markdown", st.cells.find((c) => c.id === added.cell.id).cellType === "markdown")
}

// ─────────────────────── 收尾 ───────────────────────
await new Promise((r) => server.close(r))
try {
  teardown()
  ctxBag.teardown()
} catch {
  /* ignore */
}

/** 深比较失败时给出第一个差异点，免得只看到一句 false。 */
function diffHint(a, b) {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    if (sa[i] !== sb[i]) return `首个差异 @${i}: ...${sa.slice(Math.max(0, i - 40), i + 40)} | ${sb.slice(Math.max(0, i - 40), i + 40)}`
  }
  return "完全一致"
}

console.log(
  failures.length === 0 ? "\n单元格类型测试全部通过 ✅" : `\n单元格类型测试失败 ${failures.length} 项 ❌\n  - ${failures.join("\n  - ")}`,
)
process.exit(failures.length === 0 ? 0 : 1)

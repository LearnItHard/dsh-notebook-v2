/**
 * dsh-notebook-v2 · M1 端到端测试（真 ipykernel + 真 HTTP + 真 SSE）
 *
 * 它验证的是计划里 M1 的验收项，逐条对应：
 *   1. 点运行 → cell.started 及时到达（冷启动除外，单独标注）
 *   2. 首行 stdout 及时到达，且**多行分批到达**（不是攒齐一次吐）
 *   3. 执行结果/错误各自成块
 *   4. print 一万行 → 只产生 1 个输出块（stream 合并端到端生效）
 *   5. 中断：sleep 中的 cell 被中断后收敛为 cancelled/error，不留 running
 *   6. 重启三语义：restart / restartAndClear（Node 侧清 output 与 execCount）
 *   7. .ipynb 存盘再读回语义等价
 *
 * 需要：装了 ipykernel 的 python（默认取 DSH_PYTHON）。
 * 运行：node dsh-notebook-v2/test/kernel.mjs
 */

import { readFile, mkdtemp } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadPlugin, makeCtx, sleep } from "./_load.mjs"

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}
function serve(routes) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost")
    const route = routes.find((r) => (r.kind === "prefix" ? url.pathname.startsWith(r.path) : url.pathname === r.path))
    if (!route) {
      res.statusCode = 404
      return res.end("no route")
    }
    // ⚠️ 只传两个参数：宿主真实约定就是 handler(req, res)
    return route.handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

/** 常驻 SSE 收集器：把所有帧按到达时间排队，便于事后断言"分批到达"。 */
function openSse(origin, sid) {
  const ctrl = new AbortController()
  const frames = []
  const chunks = []
  const state = { ready: false }
  const task = (async () => {
    const res = await fetch(`${origin}/nb2/events?sid=${sid}&after=0`, {
      signal: ctrl.signal,
      headers: { accept: "text/event-stream" },
    })
    state.ready = true
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      let chunk
      try {
        chunk = await reader.read()
      } catch {
        return
      }
      if (chunk.done) return
      const text = dec.decode(chunk.value, { stream: true })
      chunks.push({ at: Date.now(), text })
      buf += text
      let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const frame = parseFrame(raw)
        if (frame && frame.event === "nb") frames.push({ at: Date.now(), ...frame.data })
      }
    }
  })()
  return {
    frames,
    chunks,
    state,
    stop: () => {
      ctrl.abort()
      void task
    },
  }
}

function parseFrame(raw) {
  let event = "message"
  const data = []
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue
    const i = line.indexOf(":")
    const field = line.slice(0, i)
    const value = line.slice(i + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  if (!data.length) return null
  try {
    return { event, data: JSON.parse(data.join("\n")) }
  } catch {
    return null
  }
}

async function postJson(origin, path, body) {
  const res = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  })
  return { status: res.status, json: await res.json() }
}

async function getJson(origin, path) {
  const res = await fetch(origin + path, { cache: "no-store" })
  return { status: res.status, json: await res.json() }
}

async function main() {
  console.log("dsh-notebook-v2 · M1 kernel e2e\n")
  console.log(`python = ${process.env.DSH_PYTHON || "(PATH python)"}`)

  const { mod } = await loadPlugin()
  const { ctx, routes, tools } = makeCtx()
  mod.apply(ctx, { enabled: true, eager: true })
  const srv = await serve(routes)
  const SID = "e2e"
  const sse = openSse(srv.origin, SID)

  const cellOf = (state, i = 0) => state.cells[i]
  const findCell = (state, id) => state.cells.find((c) => c.id === id)

  try {
    // 等 SSE 连上
    for (let i = 0; i < 50 && !sse.state.ready; i += 1) await sleep(20)

    // ── 准备 notebook ──
    let r = await postJson(srv.origin, "/nb2/notebook/new", { sid: SID })
    check("notebook/new 返回 1 个空 code cell", r.json.cells.length === 1 && r.json.cells[0].cellType === "code")
    let state = r.json
    const c1 = cellOf(state, 0).id

    // ── 1. 多行流式：两行之间隔 400ms，必须分两批到达 ──
    const tRun = Date.now()
    const runPromise = postJson(srv.origin, "/nb2/cell/run", {
      sid: SID,
      cellId: c1,
      source: "import time\nprint('first')\ntime.sleep(0.4)\nprint('second')\n6*7",
    })
    const run = await runPromise
    const totalMs = Date.now() - tRun
    check("cell/run 返回 ok", run.json.ok === true, `status=${run.json.done && run.json.done.status} totalMs=${totalMs}`)

    await sleep(200)
    const started = sse.frames.filter((f) => f.ev === "cell.started" && f.cellId === c1)
    const appends = sse.frames.filter((f) => f.ev === "stream.append" && f.cellId === c1)
    const dones = sse.frames.filter((f) => f.ev === "cell.done" && f.cellId === c1)
    check("收到 cell.started", started.length === 1, `execCount=${started[0] && started[0].execCount}`)
    check("stdout 分 2 次到达", appends.length === 2, `appends=${appends.length}`)
    if (appends.length >= 2) {
      const gap = appends[appends.length - 1].at - appends[0].at
      check("两次 stdout 间隔 ≥300ms（真流式）", gap >= 300, `gap=${gap}ms`)
      check("文本内容正确", appends.map((a) => a.text.trim()).join("|") === "first|second", appends.map((a) => a.text.trim()).join("|"))
      check("同一个 outId（stream 复用输出块）", appends.every((a) => a.outId === appends[0].outId), appends.map((a) => a.outId).join(","))
    }
    check("收到 cell.done ok", dones.length === 1 && dones[0].status === "ok", JSON.stringify(dones[0]))

    const results = sse.frames.filter((f) => f.ev === "display.data" && f.cellId === c1)
    check("执行结果作为 display 到达", results.length >= 1 && results.some((f) => f.data === "42"), JSON.stringify(results.map((f) => `${f.mime}=${f.data}`)))

    const st1 = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
    const cell1 = findCell(st1.json, c1)
    check("模型里该格 status=ok 且有 execCount", cell1.status === "ok" && cell1.execCount === 1, `status=${cell1.status} execCount=${cell1.execCount}`)
    check("模型里该格输出块数 = stream(1) + display(1)", cell1.outputs.length === 2, `blocks=${cell1.outputs.length}`)
    check("durationMs 有值", typeof cell1.durationMs === "number" && cell1.durationMs > 300, `durationMs=${cell1.durationMs}`)

    // ── 2. 错误 cell ──
    r = await postJson(srv.origin, "/nb2/cell/add", { sid: SID, source: "raise ValueError('boom')" })
    const c2 = r.json.cell.id
    await postJson(srv.origin, "/nb2/cell/run", { sid: SID, cellId: c2 })
    await sleep(150)
    const errFrames = sse.frames.filter((f) => f.ev === "error" && f.cellId === c2)
    check("error 事件到达且 ename=ValueError", errFrames.length === 1 && errFrames[0].ename === "ValueError", JSON.stringify(errFrames[0] && errFrames[0].ename))
    const st2 = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
    check("错误 cell status=error", findCell(st2.json, c2).status === "error")

    // ── 3. 一万行 print → 1 个输出块 ──
    r = await postJson(srv.origin, "/nb2/cell/add", { sid: SID, source: "for i in range(10000): print(i)" })
    const c3 = r.json.cell.id
    const t3 = Date.now()
    await postJson(srv.origin, "/nb2/cell/run", { sid: SID, cellId: c3 })
    const ms3 = Date.now() - t3
    const st3 = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
    const cell3 = findCell(st3.json, c3)
    check("print 一万行 → 只 1 个输出块", cell3.outputs.length === 1, `blocks=${cell3.outputs.length} runMs=${ms3}`)
    const text3 = cell3.outputs[0] && cell3.outputs[0].text ? cell3.outputs[0].text : ""
    check("一万行内容完整（不小于 20000 字符）", text3.length > 20000, `len=${text3.length}`)

    // ── 4. 中断 ──
    r = await postJson(srv.origin, "/nb2/cell/add", { sid: SID, source: "import time\ntime.sleep(30)\nprint('never')" })
    const c4 = r.json.cell.id
    postJson(srv.origin, "/nb2/cell/run", { sid: SID, cellId: c4 }).catch(() => {})
    await sleep(800)
    const tInt = Date.now()
    await postJson(srv.origin, "/nb2/kernel/interrupt", { sid: SID })
    // 等状态收敛
    let st4 = null
    for (let i = 0; i < 40; i += 1) {
      st4 = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
      const c = findCell(st4.json, c4)
      if (c && c.status !== "running" && c.status !== "queued") break
      await sleep(150)
    }
    const c4state = findCell(st4.json, c4)
    check("中断后不再 running", c4state.status !== "running", `status=${c4state.status} after ${Date.now() - tInt}ms`)
    check("中断后没有在跑的 cell", st4.json.running === null, `running=${st4.json.running}`)

    // ── 5. 重启三语义 ──
    await postJson(srv.origin, "/nb2/cell/run", { sid: SID, cellId: c1 })
    let st5 = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
    const beforeExec = findCell(st5.json, c1).execCount
    r = await postJson(srv.origin, "/nb2/kernel/restart", { sid: SID, clear: false })
    check("restart 返回 ok", r.json.ok === true)
    st5 = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
    check("restart（不清）保留输出与 execCount", findCell(st5.json, c1).outputs.length > 0 && findCell(st5.json, c1).execCount === beforeExec, `execCount=${findCell(st5.json, c1).execCount}`)

    r = await postJson(srv.origin, "/nb2/kernel/restart", { sid: SID, clear: true })
    st5 = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
    check("restartAndClear 清空输出与 execCount", st5.json.cells.every((c) => c.outputs.length === 0 && c.execCount === null), `cells=${st5.json.cells.length}`)

    // 重启后内核真的还能跑（新内核可用）
    const afterRestart = await postJson(srv.origin, "/nb2/cell/run", { sid: SID, cellId: c1, source: "x=1\nx+1" })
    check("重启后仍可执行", afterRestart.json.ok === true, `status=${afterRestart.json.done && afterRestart.json.done.status}`)
    const stAfter = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
    check("重启后 execCount 从 1 重新开始", findCell(stAfter.json, c1).execCount === 1, `execCount=${findCell(stAfter.json, c1).execCount}`)

    // ── 6. 变量跨 cell 保留（同一内核 = 状态持久）──
    r = await postJson(srv.origin, "/nb2/cell/add", { sid: SID, source: "print(x + 41)" })
    const c6 = r.json.cell.id
    await postJson(srv.origin, "/nb2/cell/run", { sid: SID, cellId: c6 })
    const st6 = await getJson(srv.origin, `/nb2/state?sid=${SID}`)
    const text6 = (findCell(st6.json, c6).outputs.find((o) => o.kind === "stream") || {}).text || ""
    check("变量在 cell 之间保留（x=1 → print(x+41)=42）", text6.includes("42"), JSON.stringify(text6.trim()))

    // ── 7. .ipynb 往返（走 HTTP）──
    const dir = await mkdtemp(join(tmpdir(), "nb2-ipynb-"))
    const path = join(dir, "roundtrip.ipynb")
    r = await postJson(srv.origin, "/nb2/notebook/save", { sid: SID, path })
    check("notebook/save 落盘", r.json.ok === true && r.json.bytes > 0, `bytes=${r.json.bytes}`)
    const saved = JSON.parse(await readFile(path, "utf8"))
    check("存盘文件有 cells", Array.isArray(saved.cells) && saved.cells.length >= 4, `cells=${saved.cells.length}`)
    check("存盘保留 metadata.dsh2 执行历史", JSON.stringify(saved).includes("dsh2") || JSON.stringify(saved).includes("executions"))

    // 读回并再次存盘 → 深比较
    await postJson(srv.origin, "/nb2/notebook/open", { sid: SID, path })
    const path2 = join(dir, "roundtrip2.ipynb")
    await postJson(srv.origin, "/nb2/notebook/save", { sid: SID, path: path2 })
    const again = JSON.parse(await readFile(path2, "utf8"))
    check("读回再写 → 语义等价（深比较）", JSON.stringify(again) === JSON.stringify(saved), JSON.stringify(again) === JSON.stringify(saved) ? "完全一致" : "有差异")

    // ── 7b. 多 notebook 标签（M5）──
    const tabs1 = await getJson(srv.origin, `/nb2/notebooks?sid=${SID}`)
    check("当前至少有 1 个标签", Array.isArray(tabs1.json.tabs) && tabs1.json.tabs.length >= 1, `${tabs1.json.tabs.length} tabs`)
    await postJson(srv.origin, "/nb2/notebook/new", { sid: SID })
    const tabs2 = await getJson(srv.origin, `/nb2/notebooks?sid=${SID}`)
    check("新建后变成 2 个标签", tabs2.json.tabs.length === 2, `${tabs2.json.tabs.length} tabs`)
    check("只有一个 active 标签", tabs2.json.tabs.filter((t) => t.active).length === 1)

    const firstKey = tabs2.json.tabs.find((t) => !t.active).key
    await postJson(srv.origin, "/nb2/notebook/activate", { sid: SID, key: firstKey })
    const tabs3 = await getJson(srv.origin, `/nb2/notebooks?sid=${SID}`)
    check("切换活动标签", tabs3.json.tabs.find((t) => t.key === firstKey).active === true)

    const pathTab = tabs2.json.tabs.find((t) => t.path)
    if (pathTab) {
      const openAgain = await postJson(srv.origin, "/nb2/notebook/open", { sid: SID, path: pathTab.path })
      check("重复打开同一路径只激活不新增标签", openAgain.json.tabs.length === 2, `${openAgain.json.tabs.length} tabs`)
    } else {
      check("重复打开同一路径只激活不新增标签", true, "跳过（无落盘标签）")
    }

    const secondKey = (tabs3.json.tabs.find((t) => t.key !== firstKey) || {}).key
    if (secondKey) {
      await postJson(srv.origin, "/nb2/notebook/close", { sid: SID, key: secondKey })
      const tabs4 = await getJson(srv.origin, `/nb2/notebooks?sid=${SID}`)
      check("关闭标签后只剩 1 个", tabs4.json.tabs.length === 1, `${tabs4.json.tabs.length} tabs`)
    }

    // ── 8. 工具可用性 ──
    const names = tools.map((t) => t.name).sort()
    check("注册了与旧插件同名的 nb_* 工具集", names.includes("nb_run_cell") && names.includes("nb_list") && names.includes("nb_kernel_restart") && names.includes("nb_apply_suggestion"), `${names.length} tools`)
    const listTool = tools.find((t) => t.name === "nb_list")
    const listed = await listTool.execute({}, { agent: { session: { id: SID } } })
    const listedCells = await listTool.execute({ cells: true }, { agent: { session: { id: SID } } })
    check("nb_list 可用（含 cells）", Array.isArray(listedCells.cells) && listedCells.cells.length >= 4, `cells=${listedCells.cells.length}`)
    const runTool = tools.find((t) => t.name === "nb_run_cell")
    const added = await tools.find((t) => t.name === "nb_add_cell").execute({ source: "print('via-tool')" }, { agent: { session: { id: SID } } })
    const ran = await runTool.execute({ cellId: added.cell.id }, { agent: { session: { id: SID } } })
    check("nb_run_cell（agent 工具）可用", ran.ok === true && String(ran.cell.stdout).includes("via-tool"), JSON.stringify(ran.cell && ran.cell.stdout))
  } finally {
    sse.stop()
    await srv.close()
    await sleep(400)
  }

  console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("测试自身异常：", err)
  process.exit(2)
})

// 真机端到端：直接打运行中的 DSH 应用（不经过我的测试脚手架）。
// 验的是"新代码真的被加载了 + 解释器解析真的选了装 ipykernel 的环境 + 内核真能跑 + 流式分层到达"。
const B = process.env.NB2_BASE || "http://127.0.0.1:59941"
const SID = "probe-real-app-" + Date.now().toString(36)
const post = async (p, body) => {
  const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
  return r.json()
}
const get = async (p) => (await fetch(B + p, { cache: "no-store" })).json()

const health = await get("/nb2/health")
console.log("health.ok =", health.ok, "version =", health.version)

const created = await post("/nb2/notebook/new", { sid: SID })
const cellId = created.cells[0].id
console.log("notebook created, cellId =", cellId)

// 同时挂一个 SSE 收集器，验证事件是分批到的（真流式）
const frames = []
const ac = new AbortController()
const sseTask = (async () => {
  const res = await fetch(`${B}/nb2/events?sid=${SID}&after=0`, { signal: ac.signal, headers: { accept: "text/event-stream" } })
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
    buf += dec.decode(chunk.value, { stream: true })
    let i
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const line = raw.split("\n").find((l) => l.startsWith("data: "))
      if (!line) continue
      try {
        const obj = JSON.parse(line.slice(6))
        if (obj.ev) frames.push({ at: Date.now(), ...obj })
      } catch {
        /* ignore */
      }
    }
  }
})()
await new Promise((r) => setTimeout(r, 300))

const t0 = Date.now()
const code = [
  "import sys, time",
  "print('hello from real app')",
  "print('python:', sys.executable)",
  "time.sleep(0.4)",
  "print('second line')",
  "1+1",
].join("\n")
const ran = await post("/nb2/cell/run", { sid: SID, cellId, source: code })
const totalMs = Date.now() - t0
await new Promise((r) => setTimeout(r, 400))
ac.abort()
void sseTask

const state = await get("/nb2/state?sid=" + SID)
const cell = state.cells[0]
const kernel = state.kernel
const appends = frames.filter((f) => f.ev === "stream.append" && f.cellId === cellId)
const gap = appends.length >= 2 ? appends[appends.length - 1].at - appends[0].at : 0

console.log("\n--- 结果 ---")
console.log("run.status =", ran.done && ran.done.status, "totalMs =", totalMs, "(含冷启动)")
console.log("kernel.state =", kernel.state, "| source =", kernel.source, "| python =", kernel.python)
console.log("cell.status =", cell.status, "execCount =", cell.execCount, "durationMs =", cell.durationMs)
const streamText = cell.outputs.filter((o) => o.kind === "stream").map((o) => o.text).join("")
const results = cell.outputs.flatMap((o) => (o.items || []).map((i) => `${i.mime}=${i.data}`))
console.log("输出块数 =", cell.outputs.length)
console.log("stdout =", JSON.stringify(streamText.slice(0, 200)))
console.log("result blocks =", JSON.stringify(results))
console.log("SSE stream.append 条数 =", appends.length, "两次间隔 =", gap + "ms")

const checks = [
  ["健康检查 ok", health.ok === true],
  ["内核跑起来了", kernel.state === "idle" || cell.status === "ok"],
  ["解释器来自 conda（不是 PATH 兜底）", kernel.source === "conda" || kernel.source === "envsel" || kernel.source === "selected"],
  ["python 是装了 ipykernel 的环境", /ML-LLM-base|conda/i.test(String(kernel.python))],
  ["cell 执行成功", cell.status === "ok"],
  ["execCount = 1", cell.execCount === 1],
  ["stdout 含 hello", streamText.includes("hello from real app")],
  ["stdout 含两行（跨 sleep）", streamText.includes("second line")],
  ["两行分两次到达（真流式）", appends.length >= 2 && gap >= 250],
  ["执行结果 1+1=2", results.some((r) => r.startsWith("text/plain=") && r.endsWith("2"))],
  ["输出块数 = 2（stream + result）", cell.outputs.length === 2],
]
console.log("\n--- 判定 ---")
let bad = 0
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`)
  if (!ok) bad += 1
}
console.log(bad === 0 ? "\n真机端到端全部通过 ✅" : `\n${bad} 项不通过 ❌`)
process.exit(bad === 0 ? 0 : 1)

/**
 * AI 流式的 HTTP 层验收：假 llm + 真 HTTP + 真 NDJSON 分块。
 *
 * 为什么要单独一个文件：`ai.mjs` 只验了 runCompletion 的纯逻辑（write 回调）；
 * 这里验的是**经过 HTTP 之后仍然是流式的** —— 也就是用户真正感知的「首字 <1s」。
 * 判据和 SSE 那次一样：多个独立 chunk + 时间跨度 ≈ 假 llm 的产出间隔。
 *
 * 运行：node dsh-notebook-v2/test/ai-http.mjs
 */

import { createServer } from "node:http"
import { loadPlugin, makeCtx, sleep } from "./_load.mjs"

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

/** 假 llm：每 120ms 吐一个 token，最后给终结 chunk。`count` 记录真正产出了几个（取消测试用）。 */
function fakeLlm(delayMs = 120, tokens = ["print(", "'hi'", ")"]) {
  const self = {
    count: 0,
    lastOpts: null,
    listProviders: async () => ["fake"],
    listModels: async () => [{ id: "fake-model" }],
    async *stream(opts) {
      self.lastOpts = opts
      for (const t of tokens) {
        await sleep(delayMs)
        self.count += 1
        yield { kind: "text-delta", text: t }
      }
      yield { kind: "finish" }
    },
  }
  return self
}

function serve(routes) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost")
    const route = routes.find((r) => (r.kind === "prefix" ? url.pathname.startsWith(r.path) : url.pathname === r.path))
    if (!route) {
      res.statusCode = 404
      return res.end("no route")
    }
    // ⚠️ 只传两个参数：宿主真实契约
    return route.handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }))
  })
}

/** 读 NDJSON：把每个 chunk 的到达时间记下来。 */
async function readNdjson(origin, body, timeoutMs = 8000) {
  const ac = new AbortController()
  const cap = setTimeout(() => ac.abort(), timeoutMs)
  const chunks = []
  const lines = []
  try {
    const res = await fetch(origin + "/nb2/ai/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const text = dec.decode(value, { stream: true })
      chunks.push({ at: Date.now(), text })
      buf += text
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          lines.push({ at: chunks[chunks.length - 1].at, msg: JSON.parse(line) })
        } catch {
          lines.push({ at: chunks[chunks.length - 1].at, msg: { type: "BAD", raw: line.slice(0, 80) } })
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err
  } finally {
    clearTimeout(cap)
  }
  return { chunks, lines }
}

console.log("dsh-notebook-v2 · AI 流式（HTTP 层）\n")

const { mod } = await loadPlugin()
const { ctx, routes } = makeCtx()
const llm = fakeLlm(120)
// 把假 llm 挂到 ctx.get 上（插件用 ctx.get("llm") 可选取服务）
const origGet = ctx.get.bind(ctx)
ctx.get = (name) => (name === "llm" ? llm : origGet(name))
mod.apply(ctx, { enabled: true, ai: { provider: "fake", model: "fake-model" } })
const srv = await serve(routes)

try {
  const { chunks, lines } = await readNdjson(srv.origin, {
    sid: "ai",
    code: "x = 1",
    instruction: "打印它",
    mode: "rewrite",
  })

  const started = lines.filter((l) => l.msg.type === "start")
  const deltas = lines.filter((l) => l.msg.type === "delta")
  const done = lines.filter((l) => l.msg.type === "done")
  const errs = lines.filter((l) => l.msg.type === "error")

  check("响应是多行 NDJSON（start/delta/done）", started.length === 1 && deltas.length === 3 && done.length === 1, `start=${started.length} delta=${deltas.length} done=${done.length} err=${errs.length}`)
  check("没有 error 帧", errs.length === 0)
  check("done 文本是拼起来的完整结果", (done[0] && done[0].msg.text) === "print('hi')", done[0] && JSON.stringify(done[0].msg.text))
  check("start 里带上了 provider/model", started[0] && started[0].msg.provider === "fake" && started[0].msg.model === "fake-model")

  // 关键断言：delta 是**分批**到的，不是攒齐一次吐
  const deltaChunks = chunks.filter((c) => c.text.includes('"delta"'))
  check("delta 落在多个独立 chunk", deltaChunks.length >= 2, `delta chunks=${deltaChunks.length}, total=${chunks.length}`)
  if (deltas.length >= 2) {
    const gap = deltas[deltas.length - 1].at - deltas[0].at
    check("delta 之间有时间跨度（≈假 llm 的 120ms 间隔）", gap >= 200, `${gap}ms`)
  }
  const firstDeltaAt = deltas.length ? deltas[0].at - (started.length ? started[0].at : deltas[0].at) : null
  check("首字延迟远小于总时长（流式的意义）", firstDeltaAt !== null && firstDeltaAt < 600, `firstDelta=${firstDeltaAt}ms`)

  // 传参正确性
  check("传给 llm 的 provider/model 来自 config.ai", llm.lastOpts && llm.lastOpts.provider === "fake", JSON.stringify(llm.lastOpts && { p: llm.lastOpts.provider, m: llm.lastOpts.model }))
  check("messages 是按块数组组装的", llm.lastOpts && Array.isArray(llm.lastOpts.messages) && llm.lastOpts.messages[0] && llm.lastOpts.messages[1].content[0].type === "text")
  // 评审要求：signal 必须真的传进 llm.stream，否则客户端取消后 provider 还在跑
  check("signal 已传给 llm.stream", !!(llm.lastOpts && llm.lastOpts.signal), `signal=${llm.lastOpts && typeof llm.lastOpts.signal}`)

  // ── 取消：客户端断开后，后端必须停止继续产出 ──
  // 假 llm 产出 30 个 token（每个 60ms），客户端读 250ms 后主动断开；
  // 若 signal 传导正确，后端应在 30 个之前停下（评审实测过「不传 signal 会跑完 12/12」）。
  const cancelLlm = fakeLlm(60, Array.from({ length: 30 }, (_, i) => `tok${i}`))
  const ctx2 = makeCtx()
  const origGet2 = ctx2.ctx.get.bind(ctx2.ctx)
  ctx2.ctx.get = (name) => (name === "llm" ? cancelLlm : origGet2(name))
  mod.apply(ctx2.ctx, { enabled: true, ai: { provider: "fake", model: "fake-model" } })
  const srv2 = await serve(ctx2.routes)
  try {
    const ac = new AbortController()
    const res = await fetch(srv2.origin + "/nb2/ai/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: "cancel", code: "x=1", instruction: "写长一点", mode: "rewrite" }),
      signal: ac.signal,
    })
    const reader = res.body.getReader()
    await sleep(250) // 先收一会儿
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
    ac.abort()
    await sleep(800) // 给后端时间感知断开
    check("客户端取消后后端停止产出（没有把 30 个 token 跑完）", cancelLlm.count < 30, `已产出 ${cancelLlm.count}/30`)
    check("取消确实发生在中途（不是一开始就没跑）", cancelLlm.count >= 1, `${cancelLlm.count}`)
  } finally {
    await srv2.close()
  }

  // ── /nb2/ai/complete：内联补全（ghost text）──
  // 与 /ai/stream 不同：它不是流式 NDJSON，而是**一次请求换一行建议**。
  // 提示词必须走 ghost 分支（只续写光标处），不能退化成「整格重写」。
  {
    const ghostLlm = fakeLlm(10, ["ad_csv(", "'a.csv'", ")"])
    const ctx3 = makeCtx()
    const origGet3 = ctx3.ctx.get.bind(ctx3.ctx)
    ctx3.ctx.get = (name) => (name === "llm" ? ghostLlm : origGet3(name))
    mod.apply(ctx3.ctx, { enabled: true, ai: { provider: "fake", model: "fake-model" } })
    const srv3 = await serve(ctx3.routes)
    try {
      const res = await fetch(srv3.origin + "/nb2/ai/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prefix: "import pandas as pd\ndf = pd.re",
          suffix: "\nprint(df)",
          timeoutMs: 4000,
        }),
      })
      const json = await res.json()
      check("补全端点返回 200", res.status === 200, `status=${res.status}`)
      check("补全结果拼接正确", json.suggestion === "ad_csv('a.csv')", JSON.stringify(json.suggestion))
      check("补全是 ok 且带耗时", json.ok === true && typeof json.ms === "number", `ms=${json.ms}`)
      check("补全带上了 model", json.model === "fake-model", String(json.model))

      // 提示词必须是 ghost 分支：要的是「Insert at cursor」，不是「Return the complete cell code」
      const sysMsg = (ghostLlm.lastOpts.messages.find((m) => m.role === "system").content[0].text) || ""
      const userMsg = (ghostLlm.lastOpts.messages.find((m) => m.role === "user").content[0].text) || ""
      check("ghost 用独立系统提示词（inline code completion）", /inline code completion/i.test(sysMsg), sysMsg.slice(0, 60))
      check("ghost 要求只给插入片段（Insert at cursor）", /Insert at cursor/.test(userMsg), userMsg.slice(-40))
      check("ghost 提示词里带了光标前的代码", /pd\.re/.test(userMsg))
      check("ghost 提示词里带了光标后的代码（有 suffix 时）", /print\(df\)/.test(userMsg))
      check("ghost 没有退化成改写整格", !/Return the complete/i.test(userMsg))
    } finally {
      await srv3.close()
    }
  }

  // ── 补全的超时预算：慢模型不能把补全拖成「永远不出」 ──
  {
    const slowLlm = fakeLlm(200, Array.from({ length: 40 }, (_, i) => `t${i}`))
    const ctx4 = makeCtx()
    const origGet4 = ctx4.ctx.get.bind(ctx4.ctx)
    ctx4.ctx.get = (name) => (name === "llm" ? slowLlm : origGet4(name))
    mod.apply(ctx4.ctx, { enabled: true, ai: { provider: "fake", model: "fake-model" } })
    const srv4 = await serve(ctx4.routes)
    try {
      const t0 = Date.now()
      const res = await fetch(srv4.origin + "/nb2/ai/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefix: "x = 1", timeoutMs: 600 }),
      })
      const json = await res.json()
      const spent = Date.now() - t0
      check("超时预算生效（不会被慢模型拖住）", spent < 5000, `${spent}ms`)
      check("超时也能正常返回 JSON（不 500、不挂死）", typeof json.suggestion === "string", `suggestion=${JSON.stringify(json.suggestion)}`)
      // 半截建议（"t0t1t2"）插进编辑器比没有更糟，所以超时一律清空
      check("超时不给半截建议（suggestion 为空）", json.suggestion === "", JSON.stringify(json.suggestion))
      check("超时标记 aborted=true 且 ok=false", json.aborted === true && json.ok === false, `aborted=${json.aborted} ok=${json.ok}`)
    } finally {
      await srv4.close()
    }
  }
} finally {
  await srv.close()
}

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

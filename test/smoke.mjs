/**
 * dsh-notebook-v2 · 宿主半冒烟测试（不需要 DSH 运行，不需要安装）
 *
 * 它验的是 M0 的三个核心断言：
 *   A. 路由注册与 /nb2/health 正常
 *   B. SSE **真的是流式的**：多条事件在不同时刻分批到达，而不是攒齐一次性吐
 *   C. seq 单调 + after/Last-Event-ID 续传不丢不重
 *   D. nb_ping 可注册可调用；HTTP /nb2/emit 能扇出到 SSE 客户端
 *   F. /nb2/fs/list 目录列举（picker 的数据源：黑名单目录、深度、条数上限）
 *   G. /nb2/file 只服务 notebook 目录子树内的图片/文本（base 由服务端推导，穿越必须 403）
 *   H. /nb2/katex.css + /nb2/fonts/*（公式的 CSS 与字体，缺了公式就错版）
 *   I. 相对路径按会话工作目录解析；打开 notebook 后内核 cwd 跟着它走
 *
 * 为什么要在临时目录里生成一份打过补丁的副本：
 *   插件在 DSH 里以 bundle 形式加载，裸标识符 `@deepseek-ai/dsh-tools` 由宿主解析；
 *   仓库里没有该包，直接用 node import 会失败。副本只把这一行 import 换成本地 stub
 *   （stub 语义与真实 defineTool 一致：返回工具描述本身），其余代码逐字节相同。
 *
 * 运行：node dsh-notebook-v2/test/smoke.mjs
 */

import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from "node:fs"
import { cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { loadPlugin, makeCtx, sleep, PKG_DIR } from "./_load.mjs"

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`)
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
    failures.push(label)
  }
}

/** 本文件用的小工具：POST JSON 并解析返回（A5 的路由断言要用）。 */
async function postJson(origin, path, body) {
  const res = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

/** 用真实 http server 承载插件注册的前缀路由，模拟宿主行为。 */
function serve(routes, handlerFor) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost")
    const route = routes.find((r) =>
      r.kind === "prefix" ? url.pathname.startsWith(r.path) : url.pathname === r.path,
    )
    if (!route) {
      res.statusCode = 404
      return res.end("no route")
    }
    // ⚠️ 必须只传两个参数：这是宿主真实的调用约定（handler(req, res)）。
    // 早先这里多传了 url，导致「handler 内部用第三个参数」的 bug 在测试里完全看不见，
    // 真机上每个请求都抛 Cannot read properties of undefined (reading 'pathname')。
    return route.handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

/**
 * 读 SSE：把收到的每个 chunk 连同到达时间记下来。
 * 这是「是否真流式」的唯一硬证据 —— 一次性响应只会有一个 chunk。
 */
async function readSse(origin, path, { wantFrames = Infinity, timeoutMs = 4000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  const res = await fetch(origin + path, { signal: ctrl.signal, headers: { accept: "text/event-stream" } })
  const chunks = []
  const frames = []
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  try {
    while (frames.length < wantFrames) {
      const { value, done } = await reader.read()
      if (done) break
      const text = dec.decode(value, { stream: true })
      chunks.push({ at: Date.now(), text })
      buf += text
      let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const frame = parseFrame(raw)
        if (frame) frames.push(frame)
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err
  } finally {
    clearTimeout(t)
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
  return { status: res.status, headers: res.headers, chunks, frames }
}

function parseFrame(raw) {
  let event = "message"
  let id = null
  const data = []
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue
    const i = line.indexOf(":")
    if (i < 0) continue
    const field = line.slice(0, i)
    const value = line.slice(i + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "data") data.push(value)
    else if (field === "id") id = Number(value)
  }
  if (!data.length) return null
  let parsed = null
  try {
    parsed = JSON.parse(data.join("\n"))
  } catch {
    parsed = data.join("\n")
  }
  return { event, id, data: parsed }
}

async function main() {
  console.log("dsh-notebook-v2 · host smoke test\n")

  const { mod, dir: pkgCopy } = await loadPlugin()
  // loadPlugin 只复制 lib/*.js；KaTeX 的 CSS/字体是静态资源，得单独搬进副本，
  // 否则 H 段测的就是「副本里没有资源」而不是路由本身。
  const katexSrc = join(PKG_DIR, "lib", "katex")
  check("H. lib/katex 已生成（先跑 scripts/build-cm-vendor.mjs）", existsSync(join(katexSrc, "katex.css")))
  // 测试壳（_load.mjs）由 Lead 维护，会把 lib/ 整个搬过去；万一没搬，这里补一份，
  // 否则 H 段测的是「副本里没有资源」而不是路由本身。已经搬过就不重复复制。
  if (existsSync(katexSrc) && !existsSync(join(pkgCopy, "lib", "katex"))) {
    await cp(katexSrc, join(pkgCopy, "lib", "katex"), { recursive: true })
  }
  check("插件形状：name / inject / apply", mod.name === "dsh-notebook-v2" && Array.isArray(mod.inject) && typeof mod.apply === "function", `inject=${JSON.stringify(mod.inject)}`)

  const { ctx, routes, tools, teardown } = makeCtx()
  mod.apply(ctx, { enabled: true })
  check("注册了 /nb2 前缀路由", routes.length === 1 && routes[0].path === "/nb2", JSON.stringify(routes.map((r) => r.path)))
  const toolNames = tools.map((t) => t.name)
  check("注册了 nb_* 工具集（与旧插件同名）", toolNames.includes("nb_ping") && toolNames.includes("nb_run_cell") && tools.length >= 10, `${tools.length} tools`)

  const srv = await serve(routes)

  // ── A. health ──
  const health = await (await fetch(srv.origin + "/nb2/health")).json()
  check("A. /nb2/health 正常", health.ok === true && health.pkg === "dsh-notebook-v2", `uptimeMs=${health.uptimeMs}`)
  // 版本号只能有一个来源（package.json）。曾经三处各写一份、互相矛盾，发版对不上号。
  const pkgVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
  check("A. health.version 与 package.json 一致", health.version === pkgVersion, `health=${health.version} pkg=${pkgVersion}`)
  const unknown = await fetch(srv.origin + "/nb2/nope")
  check("A. 未知端点 404", unknown.status === 404, `status=${unknown.status}`)

  // ── A1b. AI 设置栏两条路由（真 HTTP；宿主 llm 服务用假 adapter）──
  // 这两条是「模型 + 思考强度」下拉的数据源，用户明确要求「全部列出来」。
  {
    const fakeLlm = {
      listProviders: async () => [{ id: "quota-auto", name: "Quota Auto" }, { id: "no-cred", name: "No Cred" }],
      listModels: async (p) => {
        if (p === "no-cred") throw new Error("missing key")
        return [{ id: "deepseek-v4.1-flash", name: "V4.1 Flash", description: "快" }, { id: "other" }]
      },
      resolveModelInfo: async (p, m) => ({
        provider: p,
        id: m,
        name: m,
        reasoning: m === "other" ? undefined : { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "high" },
      }),
    }
    const { ctx: ctxAi, routes: routesAi } = makeCtx({ llm: fakeLlm })
    const quiet = { ...ctxAi, effect: (fn) => fn() }
    quiet.get = ctxAi.get
    quiet.webServer = ctxAi.webServer
    quiet.tools = ctxAi.tools
    quiet.on = () => () => {}
    mod.apply(quiet, { enabled: true })
    const srvAi = await serve(routesAi)
    try {
      const cat = await (await fetch(srvAi.origin + "/nb2/ai/models?sid=ai1")).json()
      check("A1b. /nb2/ai/models 列出全部 provider", Array.isArray(cat.providers) && cat.providers.length === 2, JSON.stringify((cat.providers || []).map((p) => p.id)))
      const q = (cat.providers || []).find((p) => p.id === "quota-auto") || {}
      check("A1b. 模型全列出（含 description）", (q.models || []).length === 2 && q.models[0].description === "快")
      const nc = (cat.providers || []).find((p) => p.id === "no-cred") || {}
      check("A1b. 拉不到模型的 provider 仍列出并带 error", nc.error === "missing key")

      const eff = await (await fetch(srvAi.origin + "/nb2/ai/efforts?provider=quota-auto&model=deepseek-v4.1-flash")).json()
      check("A1b. /nb2/ai/efforts 返回该模型自己的档位", (eff.efforts || []).length === 2 && eff.defaultEffort === "high", JSON.stringify(eff.efforts))
      const effNone = await (await fetch(srvAi.origin + "/nb2/ai/efforts?provider=quota-auto&model=other")).json()
      check("A1b. 不支持推理的模型 → 空清单", (effNone.efforts || []).length === 0)
    } finally {
      await srvAi.close()
    }
  }

  // ── A2. CM6+KaTeX vendor 能下载（客户端没有它就没有编辑器）──
  const vendor = await fetch(srv.origin + "/nb2/vendor.js")
  const vendorText = await vendor.text()
  check(
    "A2. /nb2/vendor.js 可下载且是 IIFE 包",
    vendor.status === 200 && vendorText.length > 100000 && vendorText.includes("CM"),
    `status=${vendor.status} bytes=${vendorText.length}`,
  )

  // ── A3. 状态与标签端点（M5 多 notebook）──
  const nbState = await (await fetch(srv.origin + "/nb2/state?sid=s1")).json()
  check("A3. /nb2/state 返回 cells 与 tabs", Array.isArray(nbState.cells) && Array.isArray(nbState.tabs), `cells=${nbState.cells.length} tabs=${nbState.tabs.length}`)
  const nbTabs = await (await fetch(srv.origin + "/nb2/notebooks?sid=s1")).json()
  check("A3. /nb2/notebooks 列出标签", Array.isArray(nbTabs.tabs), `tabs=${nbTabs.tabs.length}`)

  // ── A4. AI 路由接线（这里没有 llm 服务，应回一条 E_NO_LLM 的 NDJSON 而不是挂住）──
  const aiRes = await fetch(srv.origin + "/nb2/ai/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sid: "s1", code: "print(1)", instruction: "改成 2", mode: "rewrite" }),
  })
  const aiText = await aiRes.text()
  let aiFirst = null
  try {
    aiFirst = JSON.parse(aiText.trim().split("\n")[0] || "{}")
  } catch {
    aiFirst = null
  }
  check(
    "A4. /nb2/ai/stream 返回 NDJSON 且无 llm 时给 E_NO_LLM",
    aiRes.status === 200 && aiFirst && aiFirst.type === "error" && aiFirst.code === "E_NO_LLM",
    `${aiRes.status} ${aiText.slice(0, 80)}`,
  )
  const aiHealth = await (await fetch(srv.origin + "/nb2/ai/health")).json()
  check("A4. /nb2/ai/health 报告 ok=false 与提示", aiHealth.ok === false && typeof aiHealth.hint === "string", JSON.stringify(aiHealth).slice(0, 120))

  // ── A5. 内核下拉 / 工作目录路由（这两条以前完全没测过，只测正常路径也会漏掉异常分支）──
  const kernelsRes = await (await fetch(srv.origin + "/nb2/kernels?sid=s1")).json()
  check("A5. /nb2/kernels 返回候选内核与 cwd", Array.isArray(kernelsRes.kernels) && "cwd" in kernelsRes, `kernels=${kernelsRes.kernels.length}`)
  check("A5. 每个候选都带 hasIpykernel 标记", kernelsRes.kernels.every((k) => typeof k.hasIpykernel === "boolean"))
  /**
   * 用户 2026-11-11：「没选择内核的时候，应该先提示选择内核，或者一个默认的内核」。
   * 前端要靠 `resolved` 才能显示「默认：xxx」，所以这条字段不能悄悄消失。
   */
  check(
    "A5. /nb2/kernels 报出「没显式选时会用谁」（resolved.python + source）",
    !!kernelsRes.resolved &&
      typeof kernelsRes.resolved.python === "string" &&
      ["selected", "config", "envsel", "conda", "path"].includes(String(kernelsRes.resolved.source)),
    JSON.stringify(kernelsRes.resolved),
  )
  const badKernel = await postJson(srv.origin, "/nb2/kernel/select", { sid: "s1", kernelId: "conda:nope:xxx" })
  check("A5. 选不存在的内核 → 明确报错（不是静默成功）", badKernel.json && /unknown kernel/i.test(String(badKernel.json.error || "")), JSON.stringify(badKernel.json).slice(0, 100))
  /**
   * `/nb2/spill` 是唯一一个「query 里的绝对路径直接读文件」的端点，
   * 只能读 spill 目录内的文件。越界必须 403（不是 404，更不能读出来）。
   */
  const spillOut = await fetch(`${srv.origin}/nb2/spill?path=${encodeURIComponent("C:/Windows/win.ini")}`)
  check("A5. /nb2/spill 拒绝读 spill 目录外的文件", spillOut.status === 403, `status=${spillOut.status}`)
  const badCwd = await postJson(srv.origin, "/nb2/notebook/setCwd", { sid: "s1", dir: "Z:/definitely/not/here" })
  check("A5. 设不存在的目录 → 明确报错", badCwd.json && /目录不存在/.test(String(badCwd.json.error || "")), JSON.stringify(badCwd.json).slice(0, 100))
  const emptyCwd = await postJson(srv.origin, "/nb2/notebook/setCwd", { sid: "s1", dir: "" })
  check("A5. 空目录 → 报错而不是把内核重启到奇怪位置", emptyCwd.json && /dir required/.test(String(emptyCwd.json.error || "")), JSON.stringify(emptyCwd.json).slice(0, 80))
  const saveAs = await postJson(srv.origin, "/nb2/notebook/saveAs", { sid: "s1", path: "" })
  check("A5. 另存为缺 path → 400 报错", saveAs.json && /path required/.test(String(saveAs.json.error || "")), JSON.stringify(saveAs.json).slice(0, 80))

  // ── F. notebook 目录列举（客户端 picker 的数据源，独立端点 /nb2/fs/list）──
  // 用独立 sid：这一段会 open notebook（发 nb.updated），不要搅乱 s1 的 SSE 游标断言
  const FSID = "s-fs"
  const samePath = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase()
  const tree = mkdtempSync(join(tmpdir(), "nb2-list-"))
  const NB_JSON = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })
  const putFile = (rel, text) => {
    const full = join(tree, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, text)
  }
  putFile("a.ipynb", NB_JSON)
  putFile("b.ipynb", NB_JSON)
  putFile(join("sub", "c.ipynb"), NB_JSON)
  putFile(join("deep", "deeper", "d.ipynb"), NB_JSON)
  putFile(join("node_modules", "skip.ipynb"), NB_JSON) // 黑名单目录
  putFile(join("vendored", ".ipynb_checkpoints", "x.ipynb"), NB_JSON) // 黑名单目录里的

  const listUrl = (dir, depth) => `${srv.origin}/nb2/fs/list?sid=${FSID}&dir=${encodeURIComponent(dir)}&depth=${depth}`
  const l1 = await (await fetch(listUrl(tree, 1))).json()
  const ipynb1 = (l1.entries || []).filter((e) => !e.dir)
  check("F. /nb2/fs/list 列出 .ipynb 与子目录", l1.ok === true && ipynb1.length === 3, `depth=1 ipynb=${ipynb1.length} entries=${(l1.entries || []).length}`)
  check("F. 子目录本身也在列表里（dir:true）", (l1.entries || []).some((e) => e.dir && e.rel === "sub"))
  check(
    "F. 黑名单目录（node_modules/.ipynb_checkpoints）里的 .ipynb 不列",
    !(l1.entries || []).some((e) => /node_modules|\.ipynb_checkpoints/.test(e.rel)),
    JSON.stringify((l1.entries || []).map((e) => e.rel)),
  )
  check(
    "F. 条目字段齐（path/rel/dir/mtime/size）",
    ipynb1.every((e) => typeof e.path === "string" && typeof e.rel === "string" && e.dir === false && e.mtime > 0 && e.size >= 0),
  )
  const l2 = await (await fetch(listUrl(tree, 2))).json()
  check("F. depth=2 才能进到更深的子目录", (l2.entries || []).filter((e) => !e.dir).length === 4, `ipynb=${(l2.entries || []).filter((e) => !e.dir).length}`)
  const lDflt = await (await fetch(`${srv.origin}/nb2/fs/list?sid=${FSID}&dir=${encodeURIComponent(tree)}`)).json()
  check("F. 不给 depth 时默认 2（不是 0）", lDflt.depth === 2 && (lDflt.entries || []).filter((e) => !e.dir).length === 4, `depth=${lDflt.depth}`)
  const l99 = await (await fetch(listUrl(tree, 99))).json()
  check("F. depth 超过上限（99）被夹到 4", l2.depth === 2 && l99.depth === 4, `depth=2→${l2.depth}, depth=99→${l99.depth}`)
  const lBad = await fetch(listUrl(join(tree, "definitely-missing"), 1))
  check("F. 目录不存在 → 404 而不是 500", lBad.status === 404, `status=${lBad.status}`)
  const stillTabs = await (await fetch(`${srv.origin}/nb2/notebooks?sid=s1`)).json()
  check("F. /nb2/notebooks 仍是标签列表（新端点没抢名字）", Array.isArray(stillTabs.tabs) && stillTabs.entries === undefined)

  // 条数上限：510 个 .ipynb → 只回 500 条并标 truncated
  const manyDir = join(tree, "many")
  mkdirSync(manyDir, { recursive: true })
  for (let i = 0; i < 510; i += 1) writeFileSync(join(manyDir, `n${String(i).padStart(3, "0")}.ipynb`), NB_JSON)
  const capped = await (await fetch(listUrl(manyDir, 0))).json()
  check(
    "F. notebook 上限 500 且标 filesTruncated",
    (capped.entries || []).length === 500 && capped.truncated === true && capped.filesTruncated === true && capped.dirsTruncated === false,
    `entries=${(capped.entries || []).length} filesTruncated=${capped.filesTruncated} dirsTruncated=${capped.dirsTruncated}`,
  )

  // F3. 回归守卫：目录多的仓库里，notebook 不能被目录挤出预算。
  // 真机曾出现 entries=500 / dirs=500 / files=0 —— 工作区里有 notebook 却一条都看不见。
  const wide = mkdtempSync(join(tmpdir(), "nb2-wide-"))
  writeFileSync(join(wide, "a.ipynb"), NB_JSON)
  const wideDirs = 200
  for (let i = 0; i < wideDirs; i += 1) mkdirSync(join(wide, `d${String(i).padStart(3, "0")}`))
  // 再造一层更深的目录：验证 BFS（浅的先出），预算用完时列出来的必须全是根层目录
  for (let i = 0; i < 30; i += 1) {
    mkdirSync(join(wide, "zd"), { recursive: true })
    mkdirSync(join(wide, "zd", `s${String(i).padStart(2, "0")}`), { recursive: true })
  }
  const wideList = await (await fetch(listUrl(wide, 4))).json()
  const wideEntries = wideList.entries || []
  const wideFiles = wideEntries.filter((e) => !e.dir)
  const wideDirsOut = wideEntries.filter((e) => e.dir)
  check(
    "F3. 200 个目录 + 根下一个 .ipynb → notebook 必须仍在列表里（本次回归）",
    wideList.ok === true && wideFiles.some((e) => e.rel === "a.ipynb"),
    `files=${wideFiles.map((e) => e.rel).join(",") || "(空)"} dirs=${wideDirsOut.length}`,
  )
  check("F3. notebook 排在目录之前（端点第一用途是挑 notebook）", wideEntries.length > 0 && wideEntries[0].dir === false)
  check("F3. 目录单独 150 上限 + dirsTruncated", wideDirsOut.length === 150 && wideList.dirsTruncated === true, `dirs=${wideDirsOut.length} dirsTruncated=${wideList.dirsTruncated}`)
  check(
    "F3. BFS：预算用完时列出的全是根层目录（深层的没挤进来）",
    wideDirsOut.every((e) => !e.rel.includes(sep) && e.rel !== "zd"),
    wideDirsOut.slice(-3).map((e) => e.rel).join(","),
  )
  rmSync(wide, { recursive: true, force: true })

  // F2. 默认目录 / 自证字段：一条 curl 就该能看出 defaultCwdFor 取到了哪一级
  const ctx2 = makeCtx({ workspaceRoot: tree })
  mod.apply(ctx2.ctx, { enabled: true })
  const srv2 = await serve(ctx2.routes)
  const dflt = await (await fetch(`${srv2.origin}/nb2/fs/list?sid=zz&depth=1`)).json()
  check("F2. 不给 dir → 默认目录来自会话工作区（不是进程 cwd）", dflt.ok === true && samePath(dflt.root, realpathSync(tree)), `root=${dflt.root}`)
  const health2 = await (await fetch(`${srv2.origin}/nb2/health?sid=zz`)).json()
  check("F2. /nb2/health 自证 dir + dirSource", health2.dirSource === "sandboxPolicy" && samePath(health2.dir, tree), `${health2.dirSource} → ${health2.dir}`)

  // ── G. /nb2/file：base 由服务端推导（活动 notebook 的目录）──
  // 先打开 tree 里的 notebook（绝对路径）：之后 base 就等于 tree，客户端**没有**发言权
  const opened = await postJson(srv.origin, "/nb2/notebook/open", { sid: FSID, path: join(tree, "a.ipynb") })
  check("G. 打开 notebook 成功", opened.status === 200 && samePath(opened.json && opened.json.key, join(tree, "a.ipynb")), `key=${opened.json && opened.json.key}`)
  check("I. 打开后会话 cwd 跟随 notebook 目录", samePath(opened.json && opened.json.cwd, tree), `cwd=${opened.json && opened.json.cwd}`)
  const kernelsFs = await (await fetch(`${srv.origin}/nb2/kernels?sid=${FSID}`)).json()
  check("I. /nb2/kernels 报的 cwd 也是 notebook 目录（不是 profile 目录）", samePath(kernelsFs.cwd, tree), `cwd=${kernelsFs.cwd}`)

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )
  const outsideAbs = join(tmpdir(), "nb2-outside-secret.txt")
  writeFileSync(join(tree, "pic.png"), png)
  writeFileSync(join(tree, "notes.md"), "# 标题\n")
  writeFileSync(join(tree, "evil.exe"), "MZ")
  writeFileSync(join(tree, "big.png"), Buffer.alloc(20 * 1024 * 1024 + 8))
  const fileUrl = (p) => `${srv.origin}/nb2/file?sid=${FSID}&path=${encodeURIComponent(p)}`

  const imgRes = await fetch(fileUrl("pic.png"))
  const imgBytes = Buffer.from(await imgRes.arrayBuffer())
  check("G. 图片 200 + image/png", imgRes.status === 200 && String(imgRes.headers.get("content-type")).includes("image/png"), `${imgRes.status} ${imgRes.headers.get("content-type")}`)
  check("G. 返回的是真 PNG 字节（不是被文本化）", imgBytes.length === png.length && imgBytes[0] === 0x89 && imgBytes.toString("latin1", 1, 4) === "PNG")
  check("G. 图片带私有缓存头", String(imgRes.headers.get("cache-control")).includes("max-age=60"), imgRes.headers.get("cache-control"))
  const mdRes = await fetch(fileUrl("notes.md"))
  check("G. 文本按扩展名给 Content-Type", mdRes.status === 200 && String(mdRes.headers.get("content-type")).startsWith("text/markdown"), mdRes.headers.get("content-type"))
  const subRes = await fetch(fileUrl(join("sub", "c.ipynb")))
  check("G. 子目录里的文件也能读（仍在 notebook 目录下）", subRes.status === 200, `status=${subRes.status}`)
  const absInside = await fetch(fileUrl(join(tree, "notes.md")))
  check("G. 绝对路径但仍在 notebook 目录内 → 允许", absInside.status === 200, `status=${absInside.status}`)

  // base 参数必须被忽略：客户端换一个目录也不该影响解析（否则就是任意文件读取）
  const ignoredBase = await fetch(`${srv.origin}/nb2/file?sid=${FSID}&base=${encodeURIComponent(tmpdir())}&path=pic.png`)
  check("G. 客户端传的 base 被忽略（仍按 notebook 目录解析）", ignoredBase.status === 200 && String(ignoredBase.headers.get("content-type")).includes("image/png"), `status=${ignoredBase.status}`)

  // 目录穿越：词法越界必须 403（目标不存在也一样 —— 不能伪装成 404）
  const traversal = await fetch(fileUrl("../../etc/passwd"))
  check("G. path=../../etc/passwd → 403", traversal.status === 403, `status=${traversal.status}`)
  if (process.platform === "win32") {
    const backslash = await fetch(`${srv.origin}/nb2/file?sid=${FSID}&path=..%5C..%5Cx`)
    check("G. Windows 反斜杠穿越 ..\\..\\x → 403", backslash.status === 403, `status=${backslash.status}`)
  }
  writeFileSync(outsideAbs, "secret")
  const absRes = await fetch(fileUrl(outsideAbs))
  check("G. 绝对路径越界 → 403", absRes.status === 403, `status=${absRes.status}`)
  const missingRes = await fetch(fileUrl("nope.png"))
  check("G. 不存在的文件 → 404", missingRes.status === 404, `status=${missingRes.status}`)
  const badType = await fetch(fileUrl("evil.exe"))
  check("G. 非图片/文本类型 → 415", badType.status === 415, `status=${badType.status}`)
  const tooBig = await fetch(fileUrl("big.png"))
  check("G. 超过 20MB → 413", tooBig.status === 413, `status=${tooBig.status}`)
  const noPath = await fetch(`${srv.origin}/nb2/file?sid=${FSID}`)
  check("G. 缺 path → 400", noPath.status === 400, `status=${noPath.status}`)

  // ── I. 相对路径语义 + 不许写进 profile 目录（用 srv2：workspaceRoot = tree）──
  const relOpen = await postJson(srv2.origin, "/nb2/notebook/open", { sid: "zz", path: "b.ipynb" })
  check("I. 相对路径按会话工作目录解析（落到 cwd 下）", relOpen.status === 200 && samePath(relOpen.json && relOpen.json.key, join(tree, "b.ipynb")), `key=${relOpen.json && relOpen.json.key}`)
  const gone = await postJson(srv2.origin, "/nb2/notebook/open", { sid: "zz", path: "just-deleted.ipynb" })
  check("I. 打开不存在的文件 → 404（不是 500）", gone.status === 404, `status=${gone.status}`)
  const savedAbs = await postJson(srv2.origin, "/nb2/notebook/saveAs", { sid: "zz", path: join(tree, "saved.ipynb") })
  check("I. 绝对路径另存为正常落盘", savedAbs.status === 200 && existsSync(join(tree, "saved.ipynb")), `status=${savedAbs.status}`)
  // 把「档案目录」指向 tree：此时相对路径另存为如果放行，就会写进 DSH 自己的档案目录
  const prevProfile = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = tree
  const guarded = await postJson(srv2.origin, "/nb2/notebook/saveAs", { sid: "zz", path: "oops.ipynb" })
  if (prevProfile === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = prevProfile
  check("I. 相对路径另存为不许写进 DSH 档案目录 → 400", guarded.status === 400 && /档案目录/.test(String(guarded.json && guarded.json.error)), `status=${guarded.status} ${guarded.json && guarded.json.error}`)
  check("I. 上面那条确实没落盘", !existsSync(join(tree, "oops.ipynb")))

  await srv2.close()
  ctx2.teardown()

  // ── H. KaTeX 静态资源（公式的 CSS 与字体；缺了公式会「渲染出来但错版」）──
  const cssRes = await fetch(`${srv.origin}/nb2/katex.css`)
  const cssText = await cssRes.text()
  check(
    "H. /nb2/katex.css 200 + text/css",
    cssRes.status === 200 && String(cssRes.headers.get("content-type")).includes("text/css"),
    `${cssRes.status} ${cssRes.headers.get("content-type")}`,
  )
  check("H. CSS 字体地址已改写为绝对路径 /nb2/fonts/…", cssText.includes("url(/nb2/fonts/") && !cssText.includes("url(fonts/"), `len=${cssText.length}`)
  check("H. CSS 里只剩 woff2 回退（没有 woff/ttf 段）", !/\.woff\)/.test(cssText) && !/\.ttf\)/.test(cssText))
  check("H. CSS 可被浏览器缓存", String(cssRes.headers.get("cache-control")).includes("max-age=86400"), cssRes.headers.get("cache-control"))

  const fontNames = existsSync(join(katexSrc, "fonts")) ? readdirSync(join(katexSrc, "fonts")).filter((n) => n.endsWith(".woff2")) : []
  check("H. lib/katex/fonts 有 20 个 woff2", fontNames.length === 20, `${fontNames.length} 个`)
  if (fontNames.length) {
    const fontRes = await fetch(`${srv.origin}/nb2/fonts/${encodeURIComponent(fontNames[0])}`)
    const fontBytes = Buffer.from(await fontRes.arrayBuffer())
    check(
      "H. /nb2/fonts/<真实字体> 200 + font/woff2",
      fontRes.status === 200 && String(fontRes.headers.get("content-type")).includes("font/woff2") && fontBytes.length > 1000,
      `${fontRes.status} ${fontRes.headers.get("content-type")} bytes=${fontBytes.length}`,
    )
    check("H. 字体是 immutable 长缓存", String(fontRes.headers.get("cache-control")).includes("immutable"), fontRes.headers.get("cache-control"))
    const badExt = await fetch(`${srv.origin}/nb2/fonts/..%2F..%2Findex.js`)
    check("H. 字体路由拒绝非 woff2 扩展名", badExt.status === 403, `status=${badExt.status}`)
    const escape = await fetch(`${srv.origin}/nb2/fonts/..%2F..%2Fpackage.woff2`)
    check("H. 字体路由拒绝穿越（即使扩展名合规）", escape.status === 403, `status=${escape.status}`)
  }

  // ── B. SSE 真的流式 ──
  const sse = readSse(srv.origin, "/nb2/events?sid=s1&after=0", { wantFrames: 7, timeoutMs: 5000 })
  await sleep(120) // 等 EventSource 注册进总线
  const emitRes = await (
    await fetch(srv.origin + "/nb2/emit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: "s1", count: 5, delayMs: 120 }),
    })
  ).json()
  const stream = await sse

  check("B. Content-Type 是 text/event-stream", String(stream.headers.get("content-type")).includes("text/event-stream"), stream.headers.get("content-type"))
  check("B. Cache-Control 含 no-transform", String(stream.headers.get("cache-control")).includes("no-transform"), stream.headers.get("cache-control"))
  check("B. 收到 hello 帧", stream.frames.some((f) => f.event === "hello"))

  const nb = stream.frames.filter((f) => f.event === "nb")
  check("B. 收到 1 started + 5 append + 1 done", nb.length === 7 && nb.filter((f) => f.data.ev === "stream.append").length === 5, `nb=${nb.length}`)

  // 关键断言：帧分布在不同 chunk / 不同时刻
  const appendChunks = stream.chunks.filter((c) => c.text.includes("stream.append"))
  const firstAt = appendChunks.length ? appendChunks[0].at : 0
  const lastAt = appendChunks.length ? appendChunks[appendChunks.length - 1].at : 0
  check("B. 多个 chunk 到达（不是一次性）", appendChunks.length >= 2, `append chunks=${appendChunks.length}, total chunks=${stream.chunks.length}`)
  check("B. 流式耗时符合 delayMs*gap（>=250ms）", lastAt - firstAt >= 250, `${lastAt - firstAt}ms 跨度`)

  // seq 单调
  const seqs = nb.map((f) => f.data.seq)
  const monotonic = seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1)
  check("C. seq 严格单调 +1", monotonic, seqs.join(","))

  // ── C. 续传 ──
  const lastSeq = seqs[seqs.length - 1]
  const resumed = await readSse(srv.origin, `/nb2/events?sid=s1&after=${lastSeq}`, { wantFrames: 1, timeoutMs: 1200 })
  const replayedOld = resumed.frames.filter((f) => f.event === "nb").length
  check("C. after=lastSeq 不重放旧事件", replayedOld === 0, `重放 ${replayedOld} 条`)

  const fresh = await readSse(srv.origin, `/nb2/events?sid=s1&after=0`, { wantFrames: 8, timeoutMs: 1500 })
  check("C. after=0 全量回放（7 条）", fresh.frames.filter((f) => f.event === "nb").length === 7, `${fresh.frames.filter((f) => f.event === "nb").length} 条`)

  // ── D. 工具调用会扇出到 SSE ──
  const pingTool = tools.find((t) => t.name === "nb_ping")
  const ping = await pingTool.execute({}, { agent: { session: { id: "s1" } } })
  check("D. nb_ping 可执行", ping.ok === true && ping.pong === "dsh-notebook-v2", `kernel=${ping.kernel}`)

  const before = await readSse(srv.origin, "/nb2/events?sid=s1&after=0", { wantFrames: 9, timeoutMs: 2500 })
  const emitOut = await (await fetch(srv.origin + "/nb2/emit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid: "s1", count: 2, delayMs: 20 }) })).json()
  // emit 是异步推送，稍等后从回放日志里确认
  await sleep(300)
  const after = await (await fetch(srv.origin + "/nb2/health")).json()
  const s1 = after.sessions.find((s) => s.sid === "s1")
  check("D. HTTP emit 推进了事件游标", s1 && s1.seq > (before.frames.at(-1)?.data?.seq ?? 0), `seq=${s1 && s1.seq}, emitRes=${JSON.stringify(emitOut)}`)

  // ── E. 会话隔离 ──
  await fetch(srv.origin + "/nb2/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sid: "other", count: 1, delayMs: 0 }),
  })
  const isolated = await readSse(srv.origin, "/nb2/events?sid=other&after=0", { wantFrames: 3, timeoutMs: 1500 })
  check("E. 不同 sid 的事件互不串台", isolated.frames.filter((f) => f.event === "nb").every((f) => !String(f.data.cellId || "").includes("agent-demo")), `other 会话 ${isolated.frames.filter((f) => f.event === "nb").length} 条`)

  teardown()
  await srv.close()
  // 临时目录树：500+ 文件，不清会在 %TEMP% 里越堆越多
  try {
    rmSync(tree, { recursive: true, force: true })
    rmSync(outsideAbs, { force: true })
  } catch {
    /* 清理失败不影响结论 */
  }

  console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("测试自身异常：", err)
  process.exit(2)
})

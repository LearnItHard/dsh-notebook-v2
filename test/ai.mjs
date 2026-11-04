/**
 * AI 桥测试：宿主侧 `lib/ai.js` 的提示词组装、chunk 解析、流式转发与错误映射。
 *
 * 为什么必须用假 llm：真 provider 要凭据、要网络、还会限流；而这里要验的是**我们的桥**
 * （chunk 形状解析、终态判定、错误码映射、取消），与具体厂商无关。
 *
 * 运行：node dsh-notebook-v2/test/ai.mjs
 */

import { extractTextDelta, terminalOf, buildMessages, resolveTarget, runCompletion, listAiCatalog, modelEfforts } from "../lib/ai.js"

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

/** 收集写入的行。 */
function collector() {
  const lines = []
  const write = (obj) => lines.push(obj)
  return { lines, write, of: (type) => lines.filter((l) => l.type === type) }
}

console.log("dsh-notebook-v2 · AI bridge\n")

// ── 1. chunk 解析 ──
{
  console.log("[chunk 解析]")
  check("text-delta + text", extractTextDelta({ kind: "text-delta", text: "hi" }) === "hi")
  check("text-delta + delta", extractTextDelta({ kind: "text-delta", delta: "hi" }) === "hi")
  check("type 形式的 text-delta", extractTextDelta({ type: "text-delta", text: "hi" }) === "hi")
  check("delta.text 嵌套", extractTextDelta({ delta: { text: "hi" } }) === "hi")
  check("usage/block-start 不产文本", extractTextDelta({ kind: "usage", usage: {} }) === "" && extractTextDelta({ kind: "block-start" }) === "")
  check("null 安全", extractTextDelta(null) === "" && extractTextDelta(undefined) === "")
  check("finish 是终态", terminalOf({ kind: "finish" }) !== null)
  check("error 是终态且带 failure", terminalOf({ kind: "error", failure: { code: "AUTH" } }).failure.code === "AUTH")
  check("aborted 是终态", terminalOf({ kind: "aborted" }) !== null)
  check("普通 delta 不是终态", terminalOf({ kind: "text-delta" }) === null)
}

// ── 2. 提示词组装 ──
{
  console.log("\n[提示词]")
  const m = buildMessages({ mode: "rewrite", code: "print(1)", instruction: "改成打印 2" })
  check("两条消息（system + user）", m.length === 2 && m[0].role === "system" && m[1].role === "user")
  check("content 是块数组形式", Array.isArray(m[1].content) && m[1].content[0].type === "text")
  const userText = m[1].content[0].text
  check("带上当前 cell 代码", userText.includes("print(1)"))
  check("带上指令", userText.includes("改成打印 2"))
  check("system 要求只回代码", /code only/i.test(m[0].content[0].text))
  check("complete 模式且无指令 → 要求续写", /Continue this cell/i.test(buildMessages({ mode: "complete", code: "x=1" })[1].content[0].text))
  const withCtx = buildMessages({ mode: "rewrite", code: "a", context: [{ source: "prev = 1" }] })
  check("上下文 cell 被带上", withCtx[1].content[0].text.includes("prev = 1"))
  const explain = buildMessages({ mode: "explain", code: "y=2", instruction: "这是什么" })
  check("explain 模式问句化", /Question: 这是什么/.test(explain[1].content[0].text))
}

// ── 3. target 解析 ──
{
  console.log("\n[target 解析]")
  const cfgHit = await resolveTarget({ listProviders: async () => ["p"] }, { ai: { provider: "quota-auto", model: "deepseek-v4.1-flash" } })
  check("config 优先", cfgHit.provider === "quota-auto" && cfgHit.source === "config")

  const llm = {
    listProviders: async () => [{ id: "prov-a" }, "prov-b"],
    listModels: async (p) => (p === "prov-a" ? [{ id: "m-a1" }] : [{ id: "m-b1" }]),
  }
  const auto = await resolveTarget(llm, {})
  check("无 config → 取第一个有模型的 provider", auto.provider === "prov-a" && auto.model === "m-a1", JSON.stringify(auto))

  const empty = await resolveTarget({ listProviders: async () => [] , listModels: async () => [] }, {})
  check("没有任何 provider → provider 为空", empty.provider === null || empty.provider === undefined)
}

// ── 4. 流式转发（happy path）──
{
  console.log("\n[流式：正常]")
  const fake = {
    listProviders: async () => ["p"],
    listModels: async () => [{ id: "m" }],
    async *stream(opts) {
      check("传给 llm.stream 的 provider/model 正确", opts.provider === "p" && opts.model === "m")
      yield { kind: "block-start" }
      yield { kind: "text-delta", text: "print(" }
      yield { kind: "text-delta", text: "42)" }
      yield { kind: "usage", usage: { outputTokens: 3 } }
      yield { kind: "finish" }
    },
  }
  const c = collector()
  const out = await runCompletion({ llm: fake, cfg: {} }, { mode: "complete", code: "print(" }, c.write)
  check("写了 start 帧", c.of("start").length === 1 && c.of("start")[0].provider === "p")
  check("逐 token 写 delta", c.of("delta").length === 2, `${c.of("delta").length} 个`)
  check("写了 done 且带完整文本", c.of("done").length === 1 && c.of("done")[0].text === "print(42)")
  check("返回值带文本与耗时", out.text === "print(42)" && typeof out.ms === "number")
  check("没有 error 帧", c.of("error").length === 0)
}

// ── 5. 流式：中途失败 ──
{
  console.log("\n[流式：失败]")
  const fake = {
    listProviders: async () => ["p"],
    listModels: async () => [{ id: "m" }],
    async *stream() {
      yield { kind: "text-delta", text: "print(" }
      yield { kind: "error", failure: { code: "AUTH", message: "bad key" } }
    },
  }
  const c = collector()
  const out = await runCompletion({ llm: fake, cfg: {} }, { code: "" }, c.write)
  check("失败时写 error 帧且带 code", c.of("error").length === 1 && c.of("error")[0].code === "AUTH")
  check("保留已生成的部分文本", c.of("error")[0].partial === "print(")
  check("AUTH 给出凭据提示", /凭据/.test(c.of("error")[0].hint || ""))
  check("返回值标记错误", out.error === "AUTH")
}

// ── 6. 流式：抛异常（带 code）──
{
  console.log("\n[流式：抛异常]")
  const fake = {
    listProviders: async () => ["p"],
    listModels: async () => [{ id: "m" }],
    // eslint-disable-next-line require-yield
    async *stream() {
      const err = new Error("missing credential")
      err.code = "MISSING_CREDENTIAL"
      throw err
    },
  }
  const c = collector()
  const out = await runCompletion({ llm: fake, cfg: {} }, {}, c.write)
  check("异常被映射成 error 帧", c.of("error").length === 1 && c.of("error")[0].code === "MISSING_CREDENTIAL")
  check("返回 error 码", out.error === "MISSING_CREDENTIAL")
}

// ── 7. 无 llm / 无 provider ──
{
  console.log("\n[缺依赖]")
  const c1 = collector()
  const r1 = await runCompletion({ llm: null, cfg: {} }, {}, c1.write)
  check("没有 llm 服务 → E_NO_LLM", c1.of("error")[0].code === "E_NO_LLM" && r1.error === "E_NO_LLM")

  const noProv = {
    listProviders: async () => [],
    listModels: async () => [],
    // stream 必须存在，否则会先撞上 E_NO_LLM 检查（那是另一条分支，见上一个用例）
    // eslint-disable-next-line require-yield
    async *stream() {},
  }
  const c2 = collector()
  const r2 = await runCompletion({ llm: noProv, cfg: {} }, {}, c2.write)
  check("没有 provider → NO_ADAPTER", c2.of("error")[0].code === "NO_ADAPTER" && r2.error === "NO_ADAPTER")
  check("NO_ADAPTER 提示怎么配", /config\.ai\.provider/.test(c2.of("error")[0].hint || ""))
}

// ── 8. 取消 ──
{
  console.log("\n[取消]")
  const ac = new AbortController()
  let yielded = 0
  const fake = {
    listProviders: async () => ["p"],
    listModels: async () => [{ id: "m" }],
    async *stream() {
      for (let i = 0; i < 5; i += 1) {
        yielded += 1
        yield { kind: "text-delta", text: `${i}` }
        if (i === 1) ac.abort()
      }
      yield { kind: "finish" }
    },
  }
  const c = collector()
  await runCompletion({ llm: fake, cfg: {} }, {}, c.write, { signal: ac.signal })
  check("abort 后及时停止读取", yielded <= 3, `yielded=${yielded}`)
  check("取消后不写 done（没完成不算成功）", c.of("done").length === 0)
}

// ── 9. Phase 2/3 新增提示词分支（选区级改写 / 修错 / 内核变量 / 跨格上下文）──
{
  console.log("\n[新提示词分支]")

  // 选区级改写：必须只要求「替换选区的那段」，而不是整格
  const selMsg = buildMessages({
    mode: "rewrite-selection",
    code: "import pandas as pd\nx = 1\ny = 2\nz = 3",
    selection: { text: "y = 2", startLine: 2, endLine: 2 },
    instruction: "rename y to yy",
  })
  const selText = selMsg[1].content[0].text
  check("选区模式带上了「只替换这几行」的指令", /Return ONLY the replacement code for the selected lines/.test(selText), selText.slice(0, 70))
  check("选区模式给出 1 基行号范围（用户看到的是第 3 行）", selText.includes("lines 3–3"), selText.slice(0, 120))
  check("选区模式仍然提供整格（模型需要上下文）", selText.includes("x = 1") && selText.includes("z = 3"))
  check("选区模式不复用整格改写指令", !/Return the complete rewritten cell code/.test(selText))

  // 修错
  const fixMsg = buildMessages({ mode: "fix", code: "1/0", instruction: "ZeroDivisionError: division by zero" })
  check("修错模式要求返回整格修复代码", /Fix the root cause/.test(fixMsg[1].content[0].text))

  // 内核变量
  const varMsg = buildMessages({
    mode: "rewrite",
    code: "df.head()",
    vars: [
      { name: "df", type: "DataFrame", detail: "columns: a,b shape: (3, 2)" },
      { name: "n", type: "int", detail: "int = 3" },
    ],
  })
  const varText = varMsg[1].content[0].text
  check("内核变量被写进提示词", varText.includes("Live kernel variables"), varText.slice(0, 60))
  check("列出 df 的列名（AI 不再靠猜列名）", varText.includes("columns: a,b"))
  check("列出变量类型", varText.includes("n: int"))

  // 报错上下文
  const errMsg = buildMessages({
    mode: "rewrite",
    code: "df.foo()",
    error: { ename: "AttributeError", evalue: "no attribute foo", traceback: 'File "<cell>", line 1' },
  })
  check("最近一次报错进提示词", /Most recent error/.test(errMsg[1].content[0].text) && errMsg[1].content[0].text.includes("AttributeError"))

  // ghost 跨格上下文
  const ghostMsg = buildMessages({
    mode: "ghost",
    prefix: "df = pd.read_csv('a.csv')\n",
    suffix: "",
    context: [{ source: "import pandas as pd" }],
  })
  const ghostText = ghostMsg[1].content[0].text
  check("ghost 带上前面几格的 import（跨格补全）", ghostText.includes("Earlier notebook cells") && ghostText.includes("import pandas as pd"))
  check("ghost 仍明确禁止重复已有代码", /do NOT repeat them/.test(ghostText))

  // 空上下文不应出现空标题
  const ghostNoCtx = buildMessages({ mode: "ghost", prefix: "a=1\n", suffix: "" })
  check("ghost 无上下文时不写空标题", !ghostNoCtx[1].content[0].text.includes("Earlier notebook cells"))

  // 解释模式：不要求返回代码
  const exMsg = buildMessages({ mode: "explain", code: "x=1", instruction: "什么作用" })
  check("解释模式要求散文而不是代码", /plain prose/.test(exMsg[0].content[0].text))
}

// ── 10. resolveTarget：必须认 currentSelection()（0.2.1-rc.5 的真实方法名）──
{
  console.log("\n[resolveTarget]")
  const llm = { listProviders: async () => ["fallback"], listModels: async () => [{ id: "m1" }] }

  // 只有 currentSelection 的宿主服务（这就是真机的形状）
  const cur = await resolveTarget(llm, { getService: (n) => (n === "agentDefaultModel" ? { currentSelection: () => ({ provider: "p-sel", model: "m-sel" }) } : null) })
  check("currentSelection() 被调用并命中", cur.provider === "p-sel" && cur.model === "m-sel", JSON.stringify(cur))
  check("source 标记为 agentDefaultModel", cur.source === "agentDefaultModel")

  // currentSelection 返回 Promise 也要能解析
  const asyncCur = await resolveTarget(llm, { getService: (n) => (n === "agentDefaultModel" ? { currentSelection: async () => ({ provider: "p-a", model: "m-a" }) } : null) })
  check("currentSelection 返回 Promise 也能用", asyncCur.provider === "p-a")

  // 只有 get() 的老形状仍要兜住
  const oldSvc = await resolveTarget(llm, { getService: (n) => (n === "agentDefaultModel" ? { get: () => ({ provider: "p-g", model: "m-g" }) } : null) })
  check("旧形状 svc.get() 仍兼容", oldSvc.provider === "p-g")

  // 服务抛错 → 不能炸，退回 listModels
  const boom = await resolveTarget(llm, { getService: () => ({ currentSelection: () => { throw new Error("nope") } }) })
  check("服务抛错时回落到 listModels", boom.source === "listModels" && boom.provider === "fallback", JSON.stringify(boom))

  // 显式 config 优先级最高
  const cfgWin = await resolveTarget(llm, { ai: { provider: "p-cfg", model: "m-cfg" }, getService: () => ({ currentSelection: () => ({ provider: "p-sel", model: "m-sel" }) }) })
  check("config.ai 优先于宿主默认模型", cfgWin.source === "config" && cfgWin.provider === "p-cfg")

  // 设置栏的显式选择必须**压过** config（用户手选了就该听用户的）
  const ovWin = await resolveTarget(llm, { ai: { provider: "p-cfg", model: "m-cfg" } }, { provider: "p-user", model: "m-user" })
  check("设置栏 override 优先于 config.ai", ovWin.source === "override" && ovWin.provider === "p-user" && ovWin.model === "m-user", JSON.stringify(ovWin))
  // 只给一半（有 provider 无 model）不能生效，否则会拼出跨 provider 的野路由
  const half = await resolveTarget(llm, { ai: { provider: "p-cfg", model: "m-cfg" } }, { provider: "p-user" })
  check("override 只有 provider 时忽略、回落 config", half.source === "config" && half.provider === "p-cfg", JSON.stringify(half))
}

// ── 11. 设置栏：模型目录（全部 provider × 模型）──
{
  console.log("\n[listAiCatalog]")
  const llm = {
    listProviders: async () => [{ id: "quota-auto", name: "Quota Auto" }, { id: "broken", name: "Broken" }],
    listModels: async (p) => {
      if (p === "broken") throw new Error("no credential")
      return [{ id: "deepseek-v4.1-flash", name: "V4.1 Flash", description: "fast" }, "plain-model"]
    },
  }
  const cat = await listAiCatalog(llm)
  check("列出全部 provider（不裁剪）", cat.providers.length === 2, JSON.stringify(cat.providers.map((p) => p.id)))
  const q = cat.providers.find((p) => p.id === "quota-auto")
  check("provider 下的模型全列出来", q && q.models.length === 2 && q.models[0].id === "deepseek-v4.1-flash")
  check("模型 name 取声明值，缺失回落 id", q && q.models[0].name === "V4.1 Flash" && q.models[1].name === "plain-model")
  check("保留模型 description", q && q.models[0].description === "fast")
  const b = cat.providers.find((p) => p.id === "broken")
  check("拉不到模型的 provider 仍然列出并带 error", b && b.error === "no credential" && Array.isArray(b.models))
  // 没有 llm 服务时不能抛
  const none = await listAiCatalog(null)
  check("无 llm 服务 → 空目录且不抛", none.providers.length === 0)
}

// ── 12. 设置栏：模型自己的思考强度 ──
{
  console.log("\n[modelEfforts]")
  const llm = {
    resolveModelInfo: async (p, m) => {
      if (m === "no-reasoning") return { provider: p, id: m, name: m }
      if (m === "boom") throw new Error("adapter down")
      return {
        provider: p,
        id: m,
        name: m,
        reasoning: {
          efforts: [{ id: "high", name: "High" }, { id: "max", name: "Max", description: "最深" }, { id: "", name: "坏数据" }],
          defaultEffort: "high",
        },
      }
    },
  }
  const r = await modelEfforts(llm, "quota-auto", "m1")
  check("返回该模型自己的 effort 清单", r.efforts.length === 2 && r.efforts[0].id === "high", JSON.stringify(r.efforts))
  check("带 defaultEffort", r.defaultEffort === "high")
  check("保留 effort 的 description", r.efforts[1].description === "最深")
  check("丢掉空 id 的脏数据", !r.efforts.some((e) => !e.id))

  const nr = await modelEfforts(llm, "p", "no-reasoning")
  check("不支持推理的模型 → 空清单（前端据此禁用下拉）", nr.efforts.length === 0 && nr.defaultEffort === null)

  const bad = await modelEfforts(llm, "p", "boom")
  check("adapter 抛错 → 降级空清单并带 error，不抛", bad.efforts.length === 0 && !!bad.error)

  const missing = await modelEfforts(llm, "", "")
  check("缺 provider/model → 直接空清单", missing.efforts.length === 0)
}

// ── 13. runCompletion：override 与 reasoningEffort 真的进了 stream ──
{
  console.log("\n[runCompletion · 设置栏参数]")
  const seen = []
  const llm = {
    listProviders: async () => ["quota-auto"],
    listModels: async () => [{ id: "default-model" }],
    stream: (opts) => {
      seen.push(opts)
      return (async function* () {
        yield { kind: "text-delta", text: "ok" }
        yield { kind: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const { write, of } = collector()
  await runCompletion({ llm, cfg: { ai: { provider: "cfg-p", model: "cfg-m" } } }, { mode: "ghost", code: "x", provider: "user-p", model: "user-m", reasoningEffort: "max" }, write)
  const opts = seen[0] || {}
  check("设置栏 provider/model 覆盖 config", opts.provider === "user-p" && opts.model === "user-m", JSON.stringify({ p: opts.provider, m: opts.model }))
  check("reasoningEffort 原样传给宿主（不做档位映射）", opts.reasoningEffort === "max")
  check("start 行报告的是实际生效的 target", (of("start")[0] || {}).provider === "user-p")

  // 没传强度就不该带这个字段（让 adapter 用自己的默认）
  const seen2 = []
  const llm2 = { ...llm, stream: (o) => { seen2.push(o); return (async function* () { yield { kind: "finish", reason: { kind: "stop" } } })() } }
  await runCompletion({ llm: llm2, cfg: {} }, { mode: "ghost", code: "x" }, collector().write)
  check("未指定强度时不写 reasoningEffort 字段", !("reasoningEffort" in (seen2[0] || {})))
}

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

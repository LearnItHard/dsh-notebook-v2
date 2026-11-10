/**
 * AI 内联建议的后端桥：把宿主的 `ctx.llm.stream()` 转成「一行一个 JSON」的流式响应。
 *
 * 为什么用 POST + NDJSON 而不是 SSE：
 *   这是一次性请求（带 prompt 与代码），不适合 EventSource（它只能 GET、且会把参数塞进 query
 *   有长度与转义问题）。浏览器用 `fetch()` 读 `res.body` 的流即可，服务端一行一行写。
 *
 * 协议（每行一个 JSON）：
 *   {"type":"start","provider":..,"model":..}
 *   {"type":"delta","text":"..."}        × N（token 级，前端边收边显示 = "首字 <1s"）
 *   {"type":"done","text":"完整文本","ms":123}
 *   {"type":"error","code":"NO_ADAPTER","message":..,"hint":..}
 *
 * 事实来源（不要凭印象改）：
 *   - `@deepseek-ai/dsh-llm` 的 README 与实现在 app.asar 内；
 *   - 调用形状：`ctx.llm.stream({ provider, model, messages })` → async iterable；
 *   - messages 的 content 是块数组：`[{ type:'text', text:'...' }]`；
 *   - 流**总是**以一个终结 chunk 结束（失败是 `{kind:'error'|'aborted', failure}`）。
 *   - `ctx.llm.listProviders()` 报告注册的路由。
 */

/** 从各种可能的 chunk 形状里取出文本增量（宿主版本演进时这里兜底，不至于整个功能哑掉）。 */
export function extractTextDelta(chunk) {
  if (!chunk || typeof chunk !== "object") return ""
  const kind = chunk.kind || chunk.type
  if (kind === "text-delta" || kind === "text" || kind === "delta") {
    const v = chunk.text ?? chunk.delta ?? chunk.value
    return typeof v === "string" ? v : ""
  }
  // 有些实现把 delta 挂在 content 上
  if (chunk.delta && typeof chunk.delta.text === "string") return chunk.delta.text
  if (typeof chunk.text === "string" && (kind === undefined || kind === "content_block_delta")) return chunk.text
  return ""
}

/** 终结 chunk 的判定。 */
export function terminalOf(chunk) {
  if (!chunk || typeof chunk !== "object") return null
  const kind = chunk.kind || chunk.type
  if (kind === "finish" || kind === "error" || kind === "aborted") return { kind, failure: chunk.failure }
  return null
}

/**
 * 组装 messages。纯函数 —— 提示词是我们唯一能"调手感"的地方，所以单独可测。
 *
 * @param {{mode?:string, code?:string, instruction?:string, context?:Array<{source:string}>,
 *          selection?:{text:string,startLine:number,endLine:number}|null,
 *          vars?:Array<{name:string,type:string,detail?:string}>, error?:{ename?:string,evalue?:string,traceback?:string}|null,
 *          prefix?:string, suffix?:string}} opts
 */
export function buildMessages(opts = {}) {
  const mode = normalizeMode(opts.mode)
  const code = String(opts.code || "")
  const instruction = String(opts.instruction || "").trim()

  /**
   * ghost（内联自动补全）与 complete（Mod-K 改写）是**两种任务**，提示词必须分开：
   *  - ghost：只要「光标之后那一小段」的续写，禁止重复已有代码、禁止解释，且必须能就地插入；
   *  - complete：要整格/整段新代码，用于 diff 评审。
   * 混用会让补全变成「把整格重写一遍」，铺进编辑器就是灾难。
   */
  if (mode === "ghost") {
    const before = String(opts.prefix != null ? opts.prefix : code)
    const after = String(opts.suffix || "")
    const ghostSystem =
      "You are an inline code completion engine embedded in a notebook editor. " +
      "Continue the code at the cursor. Reply with ONLY the text to insert at the cursor — " +
      "no explanation, no markdown fences, no repetition of existing code. " +
      // 行数上限写进提示词：与宿主侧 maxTokens/stop 一起构成「只补一小段」的双保险
      "Keep it short: at most 6 lines, and never restate the surrounding code. " +
      "If nothing useful can be added, reply with an empty string. " +
      "IMPORTANT: if the line at the cursor is only a Python comment (starts with #), the user is " +
      "describing what they want in words — do NOT continue the comment prose. Instead output a " +
      "NEWLINE followed by the code that implements that comment, leaving the comment untouched."
    /**
     * 跨格上下文：把前面几格（import / 变量定义 / 函数）一起给模型。
     * 只给当前格的 prefix 时，模型不知道 `df` 从哪来、`np` 有没有 import，
     * 于是补出「看起来对但跑不通」的代码（反馈 2 明确点出这个问题）。
     *
     * v2（#8）：markdown 格折成一行「意图注释」单独成块 —— 早先 markdown 一个字都不送，
     * 于是「## 数据清洗」这一节下面补出来的代码跟章节意图无关。代码格仍走围栏。
     */
    const earlier = Array.isArray(opts.context) ? opts.context.filter((c) => c && String(c.source || "").trim()) : []
    const mdIntents = earlier.filter((c) => String(c.kind || "") === "markdown")
    const codeCells = earlier.filter((c) => String(c.kind || "") !== "markdown")
    const intentBlock = mdIntents.length
      ? "Notebook section intent (markdown cells above; context only):\n" +
        mdIntents.map((c) => String(c.source || "")).join("\n") +
        "\n\n"
      : ""
    const fenceLang = (kind) => (String(kind || "") === "bash" ? "bash" : "python")
    const earlierBlock = codeCells.length
      ? "Earlier notebook cells (context only — do NOT repeat them):\n" +
        codeCells.map((c) => "```" + fenceLang(c.kind) + "\n" + String(c.source || "") + "\n```").join("\n") +
        "\n\n"
      : ""
    /**
     * 内核变量（Kernel-aware completion）。
     *
     * 补全最常见的失败是「模型不知道 df 有哪些列 / model 是什么类型」，于是补出
     * 看起来对但跑不通的代码。这里只给**名字 + 类型 + 一句细节**，并且限条数限长度 ——
     * 补全要快，上下文不能像改写那样铺满。
     */
    const liveVars = Array.isArray(opts.vars) ? opts.vars.filter((v) => v && v.name) : []
    const varsBlock = liveVars.length
      ? "Live kernel variables (name: type — detail):\n" +
        liveVars
          .slice(0, 16)
          .map((v) => `- ${v.name}: ${v.type || "?"}${v.detail ? " — " + String(v.detail).slice(0, 120) : ""}`)
          .join("\n") +
        "\n\n"
      : ""
    const user =
      "Language: python\n" +
      intentBlock +
      earlierBlock +
      varsBlock +
      "Code before cursor:\n```python\n" +
      before +
      "\n```\n\n" +
      (after ? "Code after cursor:\n```python\n" + after + "\n```\n\n" : "") +
      "Insert at cursor:"
    return [
      { role: "system", content: [{ type: "text", text: ghostSystem }] },
      { role: "user", content: [{ type: "text", text: user }] },
    ]
  }

  const isExplain = mode === "explain"
  const system = isExplain
    ? "You are a Jupyter notebook Python assistant embedded in an editor. " +
      "Answer in plain prose (no markdown fences, no code rewrite). Be concise: at most 6 sentences."
    : "You are a Jupyter notebook Python assistant embedded in a editor. " +
      "Answer with code only — no prose, no markdown fences, no explanation. " +
      "Preserve the user's existing code style. Output must be valid Python."

  const parts = []

  /**
   * 内核运行时上下文（Kernel-aware Prompt）。
   * 这是「AI 在 Notebook 里写数据分析代码总是跑不通」的主要修复点：
   * 用户拖选三行让它改，模型不知道 df 有哪些列、模型是什么类型，就只能猜。
   */
  const vars = Array.isArray(opts.vars) ? opts.vars.filter((v) => v && v.name) : []
  if (vars.length) {
    parts.push("Live kernel variables (name: type — detail):")
    for (const v of vars.slice(0, 24)) {
      parts.push(`- ${v.name}: ${v.type || "?"}${v.detail ? " — " + v.detail : ""}`)
    }
  }
  const err = opts.error
  if (err && (err.ename || err.evalue || err.traceback)) {
    parts.push(
      "Most recent error in this notebook (fix the cause, not the symptom):\n```\n" +
        [err.ename ? `${err.ename}: ${err.evalue || ""}` : "", String(err.traceback || "")].filter(Boolean).join("\n") +
        "\n```",
    )
  }

  if (opts.context && opts.context.length) {
    parts.push("Neighbouring cells (for context, do not repeat them):")
    for (const c of opts.context) parts.push("```python\n" + String(c.source || "") + "\n```")
  }

  const sel = opts.selection
  if (mode === "rewrite-selection" && sel && String(sel.text || "").trim()) {
    /**
     * 选区级局部改写：只让模型返回「替换这几行」的代码。
     * 为什么不让它返回整格：长 cell 整格重写又慢又容易改坏不相关代码，
     * 而且前端 diff 也没法对准用户关心的那几行（反馈 2 第 1 条）。
     */
    parts.push(`Full current cell (the user selected lines ${Number(sel.startLine) + 1}–${Number(sel.endLine) + 1}):`)
    parts.push("```python\n" + code + "\n```")
    parts.push("Selected lines to replace (ONLY these):")
    parts.push("```python\n" + String(sel.text) + "\n```")
    parts.push(
      (instruction ? `Instruction: ${instruction}\n` : "Improve the selected lines.\n") +
        "Return ONLY the replacement code for the selected lines — not the whole cell, no fences, no prose. " +
        "Keep the surrounding code unchanged.",
    )
  } else {
    parts.push("Current cell:")
    parts.push("```python\n" + code + "\n```")

    if (mode === "complete") {
      parts.push(
        instruction
          ? `Instruction: ${instruction}\nReturn the complete cell code after applying the instruction.`
          : "Continue this cell naturally. Return only the lines to append.",
      )
    } else if (mode === "fix") {
      parts.push(
        "The code above failed. Fix the root cause and return the complete corrected cell code. " +
          (instruction ? `\nError:\n${instruction}` : ""),
      )
    } else if (mode === "rewrite") {
      parts.push(
        instruction
          ? `Instruction: ${instruction}\nReturn the complete rewritten cell code.`
          : "Improve this cell. Return the complete rewritten cell code.",
      )
    } else {
      parts.push(instruction ? `Question: ${instruction}` : "Explain what this cell does, briefly.")
    }
  }

  return [
    { role: "system", content: [{ type: "text", text: system }] },
    { role: "user", content: [{ type: "text", text: parts.join("\n\n") }] },
  ]
}

/** 模式归一化：未知模式回落到 complete，避免提示词分支拿不到值。 */
export function normalizeMode(mode) {
  const m = String(mode || "")
  if (m === "rewrite-selection") return "rewrite-selection"
  if (m === "rewrite") return "rewrite"
  if (m === "explain") return "explain"
  if (m === "fix") return "fix"
  if (m === "ghost") return "ghost"
  return "complete"
}

/**
 * 取补全的**输出预算**：`maxTokens` / `stop`。
 *
 * 为什么需要：不设上限时通用 chat 模型会把「整个 cell 的思路」都吐出来（几十行），
 * 幽灵文本铺满编辑器既难看又慢；Tabby 的 `max_decoding_tokens=64` 就是同一个理由。
 * 非法值一律丢掉（不要把一个 undefined/NaN 塞给宿主）。
 */
export function outputBudget(req) {
  const out = {}
  const max = Number(req && req.maxTokens)
  if (Number.isFinite(max) && max > 0) out.maxTokens = Math.floor(Math.min(max, 4096))
  const stop = Array.isArray(req && req.stop) ? req.stop.filter((s) => typeof s === "string" && s) : []
  if (stop.length) out.stop = stop.slice(0, 8)
  return out
}

/** 去掉模型偶尔仍会带出来的 ``` 围栏（宿主侧与客户端各有一份，逻辑保持等价）。 */
export function stripFences(text) {
  const s = String(text || "").trim()
  const m = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(s)
  return m ? m[1] : s.replace(/^```[a-zA-Z0-9_-]*\n/, "").replace(/\n```$/, "")
}

/** 把 provider/model 的各种可能形状统一成 {id,label}。 */
function normalizeModel(m) {
  if (!m) return null
  if (typeof m === "string") return { id: m, label: m }
  const id = m.id || m.model || m.modelId || m.name
  if (!id) return null
  return { id, label: m.displayName || m.name || id }
}

/**
 * 决定这次请求用哪个 provider/model。
 * 顺序：**调用方显式指定**（override，设置栏选的）→ 显式配置 → 宿主默认模型服务（若有）→ 第一个有模型的 provider。
 *
 * @param {object} llm
 * @param {object} cfg
 * @param {{provider?:string, model?:string}} [override] 设置栏的会话级选择，优先于 cordis 配置
 */
export async function resolveTarget(llm, cfg, override) {
  const o = override || {}
  const ovProvider = String(o.provider || "").trim()
  const ovModel = String(o.model || "").trim()
  if (ovProvider && ovModel) return { provider: ovProvider, model: ovModel, source: "override" }
  const ai = (cfg && cfg.ai) || {}
  if (ai.provider && ai.model) {
    return { provider: ai.provider, model: ai.model, source: "config" }
  }
  /**
   * 有些 composition 会暴露一个「默认模型」服务，形状各家不同，防御式地试一下。
   *
   * ⚠️ 实测 DSH 0.2.1-rc.5 的 `agentDefaultModel` 服务，读当前选择的方法是
   * **`currentSelection()`**（不是 `get()`）。之前只试了 `svc.get()`，于是未配 config.ai 时
   * 会漏掉用户默认模型、盲选第一个 provider —— 模型用错了但表面上「能跑」，最难发现。
   * 这里把 currentSelection 排在最前，其余形状作为兜底。
   */
  for (const name of ["agentDefaultModel", "defaultModel", "modelSelection"]) {
    try {
      const svc = cfg && cfg.getService ? cfg.getService(name) : null
      if (!svc) continue
      // 每种读法都可能返回 Promise（服务可能异步解析），统一 await
      let v = null
      if (typeof svc.currentSelection === "function") v = await svc.currentSelection()
      else if (typeof svc.get === "function") v = await svc.get()
      else v = await (svc.current || svc.value || null)
      if (v && v.provider && v.model) return { provider: v.provider, model: v.model, source: name }
    } catch {
      /* ignore */
    }
  }

  let providers = []
  try {
    providers = (await llm.listProviders()) || []
  } catch {
    providers = []
  }
  const ids = providers.map((p) => (typeof p === "string" ? p : p && (p.id || p.name))).filter(Boolean)
  for (const provider of ids) {
    let models = []
    try {
      models = (await llm.listModels(provider)) || []
    } catch {
      models = []
    }
    const first = normalizeModel(models[0])
    if (first) return { provider, model: first.id, source: "listModels" }
  }
  return { provider: ai.provider || null, model: ai.model || null, source: "none", providers: ids }
}

/**
 * 跑一次流式生成，把结果按 NDJSON 行写给 `write`。
 *
 * @param {object} deps { llm, cfg }
 * @param {object} req  请求体
 * @param {(obj:object)=>void} write 写一行
 * @param {{signal?:AbortSignal}} [ctl]
 * @returns {Promise<{text:string, ms:number, error?:string}>}
 */
export async function runCompletion(deps, req, write, ctl = {}) {
  const started = Date.now()
  const { llm, cfg } = deps
  if (!llm || typeof llm.stream !== "function") {
    write({
      type: "error",
      code: "E_NO_LLM",
      message: "宿主的 LLM 服务不可用（ctx.llm.stream 不存在）",
      hint: "确认 composition 里挂了 @deepseek-ai/dsh-llm 与至少一个 provider adapter。",
    })
    return { text: "", ms: 0, error: "E_NO_LLM" }
  }

  const target = await resolveTarget(llm, cfg, { provider: req.provider, model: req.model })
  if (!target.provider || !target.model) {
    write({
      type: "error",
      code: "NO_ADAPTER",
      message: "没有可用的 provider/model",
      hint:
        "在 cordis.patch.yml 里给本插件配 config.ai.provider / config.ai.model（例如 provider: quota-auto, " +
        "model: deepseek-v4.1-flash），或先让某个 provider adapter 注册成功。",
      providers: target.providers || [],
    })
    return { text: "", ms: 0, error: "NO_ADAPTER" }
  }

  write({ type: "start", provider: target.provider, model: target.model, source: target.source })

  const messages = buildMessages(req)
  let text = ""
  let failure = null
  try {
    // signal 必须传进去：否则客户端取消后 provider 仍会把整段生成跑完（评审实测 12/12 token）。
    // 宿主 GenerateOptions 里 signal 是可选字段，传了就会在取消时中断 provider 调用。
    const streamOpts = { provider: target.provider, model: target.model, messages }
    /**
     * 思考强度：**按模型自己声明的 id 原样传**，不做「low/medium/high」的映射。
     * 宿主 `resolveCallConfig`/`prepareCall` 对不支持的显式 effort 会**直接拒绝**
     * （"no clamping or aliasing is performed"），所以这里只能传
     * `/nb2/ai/efforts` 枚举出来的、该模型真实支持的值 —— 前端就是这么填的。
     */
    const effort = String(req.reasoningEffort || "").trim()
    if (effort) streamOpts.reasoningEffort = effort
    if (ctl.signal) streamOpts.signal = ctl.signal
    /**
     * 输出预算（补全专用）：`maxTokens` + `stop`。
     * 宿主不认这些字段时**降级重试**（同步抛或流里第一块就抛都兜住）——
     * 「加了预算」绝不能变成「补全彻底不可用」。
     */
    const budget = outputBudget(req)
    const withBudget = Object.keys(budget).length ? { ...streamOpts, ...budget } : streamOpts
    /** 跑一次流；abort/终态写进外层 failure，返回即结束。 */
    const consume = async (opts) => {
      const stream = llm.stream(opts)
      for await (const chunk of stream) {
        // 取消不是成功：记成 aborted，绝不能落到下面写 done（否则前端会把半截代码当成品）
        if (ctl.signal && ctl.signal.aborted) {
          failure = { code: "ABORTED", message: "已取消" }
          return
        }
        const term = terminalOf(chunk)
        if (term) {
          if (term.kind === "error" || term.kind === "aborted") {
            failure = term.failure || { code: term.kind }
          }
          return
        }
        const delta = extractTextDelta(chunk)
        if (!delta) continue
        text += delta
        write({ type: "delta", text: delta })
      }
    }
    try {
      await consume(withBudget)
    } catch (err) {
      // 还没有产出任何文本才重试：否则会把同一段补全吐两遍
      if (withBudget === streamOpts || text) throw err
      await consume(streamOpts)
    }
  } catch (err) {
    failure = { code: (err && err.code) || "E_STREAM", message: String((err && err.message) || err) }
  }

  const ms = Date.now() - started
  if (failure) {
    write({
      type: "error",
      code: failure.code || "E_STREAM",
      message: failure.message || String(failure.code || "生成失败"),
      hint:
        failure.code === "MISSING_CREDENTIAL" || failure.code === "AUTH"
          ? "provider 凭据没配好：检查 API key（credentials / 环境变量）。"
          : failure.code === "RATE_LIMIT"
            ? "被限流了，稍后再试或换模型。"
            : failure.code === "NO_ADAPTER"
              ? "这个 provider 没注册：检查 adapter 是否装载。"
              : undefined,
      partial: text || undefined,
    })
    return { text, ms, error: failure.code || "E_STREAM" }
  }

  write({ type: "done", text, ms })
  return { text, ms }
}

/**
 * 列出**全部** provider 及其模型 —— 设置栏的「模型」下拉就是它。
 *
 * 为什么不在宿主写死几个模型：provider adapter 是运行时可装卸的，
 * 唯一权威是 `llm.listProviders()` + `llm.listModels(provider)`。
 * 一个 provider 拉不到模型不算错（凭据没配/网络），记 `error` 但**不隐藏它**，
 * 否则用户会以为「这个家里的模型根本不存在」。
 *
 * @returns {Promise<{providers:Array<{id:string,name:string,models:Array<{id:string,name:string,description?:string}>,error?:string}>}>}
 */
export async function listAiCatalog(llm) {
  if (!llm || typeof llm.listProviders !== "function") return { providers: [] }
  let raw = []
  try {
    raw = (await llm.listProviders()) || []
  } catch {
    raw = []
  }
  const out = []
  for (const p of raw) {
    const id = typeof p === "string" ? p : (p && (p.id || p.name)) || ""
    if (!id) continue
    const name = (p && p.name) || id
    const entry = { id, name, models: [] }
    try {
      const models = (await llm.listModels(id)) || []
      entry.models = models.map(normalizeModel).filter(Boolean).map((m, i) => ({
        id: m.id,
        name: m.label || m.id,
        ...(models[i] && models[i].description ? { description: models[i].description } : {}),
      }))
    } catch (err) {
      entry.error = String((err && err.message) || err)
    }
    out.push(entry)
  }
  return { providers: out }
}

/**
 * 某个模型**自己声明的**思考强度清单（设置栏的「思考强度」下拉）。
 *
 * `resolveModelInfo` 是 adapter 侧的权威来源；不支持推理的模型返回空数组，
 * 前端据此把下拉禁用成「该模型不支持」而不是假装能选。
 * 任何异常都降级成空清单：设置栏拿不到强度不该让整个面板报错。
 *
 * @returns {Promise<{provider:string,model:string,efforts:Array<{id:string,name:string,description?:string}>,defaultEffort:string|null,error?:string}>}
 */
export async function modelEfforts(llm, provider, model) {
  const base = { provider: String(provider || ""), model: String(model || ""), efforts: [], defaultEffort: null }
  if (!llm || typeof llm.resolveModelInfo !== "function" || !base.provider || !base.model) return base
  try {
    const info = await llm.resolveModelInfo(base.provider, base.model)
    const r = (info && info.reasoning) || null
    if (!r) return base
    const efforts = Array.isArray(r.efforts) ? r.efforts : []
    return {
      ...base,
      efforts: efforts
        .map((e) => ({
          id: String((e && e.id) || ""),
          name: String((e && (e.name || e.id)) || ""),
          ...(e && e.description ? { description: String(e.description) } : {}),
        }))
        .filter((e) => e.id),
      defaultEffort: r.defaultEffort ? String(r.defaultEffort) : null,
    }
  } catch (err) {
    return { ...base, error: String((err && err.message) || err) }
  }
}

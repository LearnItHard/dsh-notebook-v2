/* dsh-notebook-v2 · client 半 —— 右栏「Notebook (v2)」面板。
 *
 * 一个文件的原因：DSH 客户端插件只能是 `window.__ModuleLoader__.load({id, factory})` 注册的
 * 单个 CJS 工厂，外部依赖只能 `require` shell 的静态模块表（react）。所以我们不能 `import ./x.js`：
 *   - 纯逻辑（MIME 挑选/折叠判定/JSON 树/markdown）留在本文件，通过 `__internals` 暴露给测试；
 *   - CodeMirror 6 + KaTeX 由 `/nb2/vendor.js`（IIFE，全局 `CM`）提供，见 scripts/build-cm-vendor.mjs。
 *
 * ⚠️ 必须静态 `inject: [...]`（门面不提供 ctx.inject），见 README「关键实现约定」。
 * ⚠️ 两阶段注册：sidebarRightTabs.register（类型）→ slots.register（内容），key 必须等于 id。
 * ⚠️ 所有 disposer 都写在 ctx.effect 里，否则热重载留僵尸标签。
 *
 * 手感对齐（VS Code 实测，不是 JupyterLab 想象）：
 *   Shift-Enter 运行并下移 / Ctrl(-Alt)-Enter 运行 / Alt-Enter 运行并插格 / Mod-F 查找 / Mod-S 保存
 *   focusMode 三态（editor / container / output），Esc 从 editor 退到 container，Enter 再进去。
 *   编辑态下运行快捷键依然生效（对应 NOTEBOOK_CELL_LIST_FOCUSED 绑整块 widget 的做法）。
 */

window.__ModuleLoader__.load({
  id: "dsh-notebook-v2",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require("react")
    const h = React.createElement

    const PKG = "dsh-notebook-v2"
    const KIND = PKG

    const FONT_MONO =
      "ui-monospace,SFMono-Regular,Menlo,Consolas,'Cascadia Mono','Microsoft YaHei Mono','Microsoft YaHei',monospace"
    const FONT_UI =
      "var(--dsw-font-family,ui-sans-serif,system-ui,'Segoe UI','Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif)"

    /**
     * ⚠️ 强调色不能用 `--dsw-alias-brand-primary`。
     *
     * 实测 DSH 0.2.1-rc.5 的 theme client（app.asar 内 `dsh-client-ui-theme/lib/client.js`）：
     *   --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-1000)   // #0f1115 近黑
     *   --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50)     // #f9fafb 近白
     * 也就是说它是「品牌中性墨色」（深色主题近白、浅色主题近黑），**根本不是蓝色**。
     * 早先把它当蓝色强调色用，于是 AI 徽标、按钮、关键字高亮全是黑白灰，等于没有强调。
     *
     * 真正的蓝色是 deepseek 系列：
     *   --dsw-alias-link / --dsw-alias-button-info-fill → --dsw-static-deepseek-400/500 (#7aaaff / #4176e6)
     * 文档选区另有专用令牌（blue-500 40% 透明）：
     *   --dsw-alias-bg-document-selection: color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent)
     */
    const ACCENT = "var(--dsw-alias-link, #4176e6)"
    /** 运行中统一用「警告黄」：raw 输出不抢眼、又和 idle 的绿、报错的红明确区分。 */
    const RUNNING_COLOR = "#cca700"
    const accentMix = (pct) => `color-mix(in srgb, ${ACCENT} ${pct}%, transparent)`
    /** 文档选区色：优先用 DSH 官方令牌，退化到 blue-500 40%（与官方定义等值）。 */
    const TEXT_SELECTION = "var(--dsw-alias-bg-document-selection, rgba(59,130,246,0.4))"

    /**
     * 一次性的全局样式（`::selection` 与闪烁动画没法写成行内样式）。
     * 用 id 兜底幂等：热重载/多实例都只会插一份。
     */
    function ensureGlobalCss() {
      if (typeof document === "undefined" || !document.head) return
      const id = "nb2-global-style"
      if (document.getElementById(id)) return
      const el = document.createElement("style")
      el.id = id
      el.textContent = [
        // 选区：markdown 预览、输出区、报错区都是普通 DOM，靠这条统一成官方选区色
        `.nb2-sel-pop ::selection{background:${TEXT_SELECTION} !important;color:inherit}`,
        `.nb2-root ::selection{background:${TEXT_SELECTION} !important;color:inherit}`,
        // Agent 改格后的定位闪烁（对应 dsh-better-sidebar 的 toc-flash）
        `@keyframes nb2-flash{0%{background:${accentMix(28)}}70%{background:${accentMix(14)}}100%{background:transparent}}`,
        `.nb2-flash{animation:nb2-flash 1.2s ease-out 1}`,
        /**
         * 运行中：左槽的 ◐ 匀速转 + 一条呼吸边框。
         * 为什么必须动：静止图标和「跑完了」在余光里分不出来（用户 2026-11-10 报的
         * 「我不知道有没有运行」）。动画是零成本的判据，比任何文字都快。
         */
        `@keyframes nb2-spin{to{transform:rotate(360deg)}}`,
        `.nb2-spin{display:inline-block;animation:nb2-spin 1.1s linear infinite}`,
        `@keyframes nb2-pulse{0%,100%{opacity:.55}50%{opacity:1}}`,
        `.nb2-running-pill{animation:nb2-pulse 1.6s ease-in-out infinite}`,
        // 选区浮动条：整体浮层，不被祖先的 overflow 裁掉
        `.nb2-sel-pop{position:fixed;z-index:9999;display:flex;gap:2px;align-items:center;` +
          `padding:3px;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.28);` +
          `border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#222)}`,
        `.nb2-sel-pop button{border:0;background:transparent;color:inherit;cursor:pointer;` +
          `font-size:11px;padding:3px 7px;border-radius:4px;white-space:nowrap}`,
        `.nb2-sel-pop button:hover{background:${accentMix(22)}}`,
        // 单元格右键菜单（portal 到 body 的 fixed 层，压过侧栏 overflow 裁剪）
        `.nb2-ctx-menu{position:fixed;z-index:10000;min-width:188px;max-height:70vh;overflow:auto;` +
          `padding:4px;border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.34);` +
          `border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#222)}`,
        `.nb2-ctx-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;` +
          `border:0;background:transparent;color:inherit;cursor:pointer;text-align:left;` +
          `font-size:12px;padding:5px 8px;border-radius:5px;white-space:nowrap}`,
        `.nb2-ctx-item:hover{background:${accentMix(22)}}`,
        `.nb2-ctx-hint{opacity:.5;font-size:10.5px;font-family:${FONT_MONO}}`,
        `.nb2-ctx-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.25))}`,
      ].join("\n")
      document.head.appendChild(el)
    }

    /**
     * 选区浮动条要贴在最上层（侧栏有 overflow/裁剪），所以优先 createPortal 到 body。
     * `react-dom` 在本机 DSH 的 shell 模块表里是可用的（已启用的 dsh-better-sidebar 同样
     * `require("react-dom")` + createPortal）；但为了不因为外部实现变动就整插件崩，
     * 这里 try/catch，拿到就拿、拿不到就退化成「面板根容器内 position:fixed」。
     */
    let ReactDOM = null
    try {
      ReactDOM = require("react-dom")
    } catch {
      ReactDOM = null
    }
    const createPortal = ReactDOM && typeof ReactDOM.createPortal === "function" ? ReactDOM.createPortal : null

    // ───────────────────────── 纯逻辑（可测） ─────────────────────────

    /**
     * MIME 优先级：越靠前越优先。照 vscode 的 orderOfMimeTypes 思路（富输出优先于纯文本）。
     *
     * ⚠️ 表里只放**我们有渲染分支**的 mime（vscode 也是这么维护这张表的）。
     * 早先这里还排了 `application/vnd.jupyter.widget-view+json`（ipywidgets）和
     * `application/vnd.plotly.v1+json`，但 OutputBlockView 没有对应分支 —— pickMime
     * 选中它们之后会掉进「纯文本兜底」，用户看到的是一大坨 JSON（图直接没了）。
     * 没有渲染器的 mime 不进表，让它回退到 text/html / text/plain。
     */
    const MIME_PRIORITY = [
      "text/html",
      "image/svg+xml",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "text/latex",
      "text/markdown",
      "application/json",
      "text/plain",
    ]

    /** 在若干 mime 项里挑一个我们**真的能渲染**的；挑不到返回 null。 */
    function pickMime(items) {
      if (!Array.isArray(items) || !items.length) return null
      const byMime = new Map()
      for (const item of items) if (!byMime.has(item.mime)) byMime.set(item.mime, item)
      for (const mime of MIME_PRIORITY) if (byMime.has(mime)) return byMime.get(mime)
      // 未知 mime：只认我们能当文本处理的
      for (const item of items) {
        if (typeof item.mime === "string" && item.mime.startsWith("text/")) return item
      }
      return null
    }

    const LAZY_LINES = 1500
    const LAZY_CHARS = 120000
    const LAZY_HEAD = 300
    const LAZY_TAIL = 100

    /**
     * 单元格类型归一化 —— 与宿主半 notebook.js 的同名函数**必须逐字一致**。
     *
     * 为什么客户端要抄一份：client.js 是自包含 CJS 工厂（只能 require 白名单模块），
     * import 不了兄弟文件。代价是两份，所以 test/client-logic.mjs 里有一条交叉用例，
     * 拿同一张别名表同时喂给两边、断言结果相同 —— 哪天改了单边，测试立刻红。
     */
    function normalizeCellType(type) {
      const t = String(type == null ? "" : type)
        .trim()
        .toLowerCase()
      if (!t) return "code"
      if (t === "code" || t === "py" || t === "python" || t === "ipython" || t === "jupyter") return "code"
      if (t === "markdown" || t === "md" || t === "mdown" || t === "mkdn") return "markdown"
      if (t === "raw" || t === "text" || t === "plain") return "raw"
      if (t === "bash" || t === "sh" || t === "shell" || t === "zsh" || t === "console" || t === "cmd" || t === "powershell" || t === "pwsh") return "bash"
      return "code"
    }

    const CELL_TYPE_LABELS = { code: "代码", markdown: "Markdown", raw: "Raw", bash: "Shell" }

    /**
     * 从 cells 里抽大纲（TOC）。
     *
     * 规则照 Jupyter 的 toc 习惯：markdown 格里的 `#` 标题按级别缩进；其余可执行格
     * 用首行代码兜底（否则「全是代码的 notebook」大纲会是空的，也就没用了）。
     * 返回 [{ kind:"heading"|"cell", level, text, cellId, index }]，纯数据、可测。
     */
    function buildOutline(cells) {
      const out = []
      ;(cells || []).forEach((cell, index) => {
        const type = normalizeCellType(cell.cellType)
        const src = String(cell.source || "")
        if (type === "markdown") {
          let inFence = false
          const lines = src.split("\n")
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i]
            // 代码块里的 # 是注释不是标题，必须跳过
            if (/^\s*```/.test(line)) {
              inFence = !inFence
              continue
            }
            if (inFence) continue
            const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
            if (m) out.push({ kind: "heading", level: m[1].length, text: m[2], cellId: cell.id, index, line: i })
          }
          return
        }
        const first = src.split("\n").find((l) => l.trim()) || ""
        out.push({
          kind: "cell",
          level: 1,
          // 首行过长直接截断：大纲是导航用的，不是内容预览
          text: first.trim().slice(0, 80) || (type === "raw" ? "(raw)" : "(空)"),
          cellId: cell.id,
          index,
          type,
        })
      })
      return out
    }

    /**
     * 触发判据（纯函数，可测）：什么时候值得去问一次补全。
     *
     * 补全花 token 且有延迟，所以门槛要苛刻。**v2（#6）改成分数制**：
     * 硬门槛（下面这些 return 0 的分支）仍然是一票否决，但「值得不值得」不再只有 0/1，
     * 而是几个可解释的特征相加，超过阈值才发请求 —— 这样「刚按 Esc 拒绝过」「刚刚闭合括号」
     * 这类「不是绝对不行、但此刻大概率是噪音」的情形才有地方降权。
     *
     *   - 开关打开（默认关，用户自己开）
     *   - 光标在行尾（行中间补全容易和后面的代码打架）
     *   - 前面已经有实际内容（空行补全基本都是噪音）
     *   - 刚打的字不是引号/缩进这类「还没写完」的时刻
     *   - 上一行不是纯运算符/逗号（否则模型只会接着吐垃圾）
     *   - 刚按 Esc 丢弃过建议（3s 内降权：用户已经用行动说了「不要」）
     *   - 光标前一个字符是 `(` `[` `{` `,` `:` `=` → 这里最值得补（加分）
     *   - 光标前一个字符是 `)` `]` `}` `;` → 语句大概写完了（减分）
     */
    const GHOST_SCORE_THRESHOLD = 1
    /** Esc 拒绝后的降权窗口：3s 内不打扰，过了就当用户又需要了（#6） */
    const GHOST_REJECT_WINDOW_MS = 3000

    /**
     * 打分（纯函数）：返回 <阈值 就是「这次不请求」。
     * `shouldRequestCompletion()` 只是「分数 ≥ 阈值」的布尔投影，**矩阵测试都打在分数上**，
     * 这样调阈值/加减特征时不会出现「某条判据被后面的分支悄悄吃掉」。
     */
    function completionScore({
      enabled = false,
      doc = "",
      pos = 0,
      now = 0,
      lastAt = 0,
      minGap = 500,
      rejectAt = 0,
      rejectWindowMs = GHOST_REJECT_WINDOW_MS,
    } = {}) {
      if (!enabled) return 0
      if (now - lastAt < minGap) return 0
      const text = String(doc || "")
      const cur = Math.max(0, Math.min(text.length, pos))
      const lineStart = text.lastIndexOf("\n", cur - 1) + 1
      const lineEnd = text.indexOf("\n", cur)
      const tail = text.slice(cur, lineEnd < 0 ? text.length : lineEnd)
      /**
       * 光标后还有代码 → 不在行尾，不补。
       *
       * 但**只剩闭合括号/分隔符**时要允许：`print(df.head()|)` 这种把光标放在右括号前的
       * 姿势很常见，早先一律拒绝等于「在这里永远没有补全」。Copilot 的判据也是
       * 「右侧是 trivial 尾巴就算行尾」。
       *
       * ⚠️ 冒号**不算** trivial：`for i in range(3)|:` 的冒号前不是补全点，
       * 放开会把「函数签名/循环头还没写完」也当成行尾（矩阵测试抓出来的）。
       */
      if (tail.trim() && !/^[)\]},;]+$/.test(tail.trim())) return 0
      const prefix = text.slice(0, cur)
      if (prefix.trim().length < 3) return 0
      const lineBefore = prefix.slice(lineStart)
      if (!lineBefore.trim()) return 0 // 空行不补全
      // 只打了空白/运算符 → 等用户写完
      /**
       * 只打了运算符 → 等用户写完再补。
       *
       * ⚠️ 这个黑名单里**不能有冒号**：`def f():` / `if x:` / `for i in r:` 的冒号后面
       * 正是 Python 最需要补全的位置（缩进块的第一行）。早先把它列进来，
       * 导致「写完函数签名就永远没有补全」—— 评审抓出来的。
       */
      if (/[=(,[+\-*/%<>!&|^~?]+\s*$/.test(lineBefore)) return 0

      let score = 1
      /**
       * 上一次建议是用户按 Esc 丢掉的 → 3s 内降权。
       * 为什么按时间而不是「持久关闭」：用户拒绝的是**这一条建议**，不是这个功能；
       * 3s 后他可能已经换了思路，继续沉默等于功能时灵时不灵。
       */
      if (rejectAt && now - rejectAt < rejectWindowMs) score -= 1.5
      const ch = prefix.slice(-1)
      /**
       * 光标前一个字符的「白/黑名单」（抄 Copilot contextual filter 的方向）：
       *  · `.` —— 属性访问 `df.`，Python 里最典型的补全点（加分）；
       *  · `:` —— 块开始 `def f():` / `if x:`，下面正等着写第一行（加分）。
       * ⚠️ 不要在这里加 `(` `,` `=`：它们已经被上面的运算符硬门槛一票否决，
       * 加了也永远走不到（评审提醒过：写了不可达的判据等于没写）。
       */
      if (/[.:]/.test(ch)) score += 0.5
      // 刚闭合：语句大概写完了，接着补容易变成「补一条不相关的语句」
      else if (/[)\]};]/.test(ch)) score -= 0.5
      return score
    }

    /** 是否值得请求（布尔投影，阈值可覆盖）。 */
    function shouldRequestCompletion(opts = {}) {
      const threshold = Number.isFinite(opts.threshold) ? Number(opts.threshold) : GHOST_SCORE_THRESHOLD
      return completionScore(opts) >= threshold
    }

    /** 把补全文本收拾成「能直接插进编辑器」的一段：去掉围栏/回车/多余缩进尾部。 */
    function normalizeSuggestion(text) {
      let s = stripFences(String(text == null ? "" : text))
      // 模型常把光标前的代码又抄一遍：如果第一行前半段已经在 doc 里，就砍掉
      s = s.replace(/\r\n?/g, "\n")
      // 只取第一段（补全不该变成整格重写）
      if (s.includes("\n\n")) s = s.split("\n\n")[0]
      // 去掉结尾空行（插入时会多出一个空行）
      s = s.replace(/\s+$/, "")
      return s
    }

    /**
     * 砍掉「建议开头」与「光标前文结尾」的重叠部分。
     *
     * 模型经常把光标前那一行的前缀再吐一遍（前文 `df = pd.re`、建议 `re.read_csv(...)`），
     * 直接插入就成了 `df = pd.rere.read_csv(...)`。这里求最长重叠后缀并截断。
     * 纯函数、可测；最多比较 64 字符，避免长文 O(n²)。
     */
    function trimOverlap(prefix, suggestion, maxOverlap = 64) {
      const p = String(prefix == null ? "" : prefix)
      const s0 = String(suggestion == null ? "" : suggestion)
      if (!p || !s0) return s0
      const limit = Math.min(maxOverlap, p.length, s0.length)
      for (let n = limit; n > 0; n -= 1) {
        if (p.endsWith(s0.slice(0, n))) return s0.slice(n)
      }
      return s0
    }

    /**
     * 补全缓存查找：**最长前缀匹配**（Continue 的 `AutocompleteLruCache` 同款思路）。
     *
     * 为什么不能只做精确匹配：用户敲 `df.he` 拿到建议 `ad(3)` 之后，每多敲一个字符
     * （`df.hea`、`df.head`）文档就变了，精确匹配全部落空 —— 于是「退格再续打」这种
     * 最自然的动作每次都要重新付一次网络往返。真正的语义是：
     *   缓存里的 `doc` 是**当前文档的前缀**，且用户此后敲的字符正好是缓存的建议的开头
     *   → 剩下的建议仍然有效，直接切掉已经打出来的那截。
     *
     * 例：缓存 `{doc:"df.he", suggestion:"ad(3)"}`，当前 `doc:"df.hea"`：
     * 多敲的 `"a"` 是建议开头 → 命中的剩余建议是 `"d(3)"`，0 延迟出幽灵文本。
     * 用户敲的内容与建议不一致（改了主意）→ 不命中，照常发请求。
     *
     * `pos` 必须与文档同步增长（`pos - e.pos === doc.length - e.doc.length`），
     * 否则「在别的位置碰巧前缀相同」会命中一条错位的建议。
     *
     * @param {Iterable<{pos:number,doc:string,suggestion:string}>} entries 缓存条目（LRU 顺序）
     * @param {{pos?:number, doc?:string}} q 当前光标位置与文档全文
     * @returns {{suggestion:string, entry:object}|null} 命中的剩余建议（已切掉已打出的部分）
     */
    function matchGhostCache(entries, q) {
      const query = q || {}
      const pos = Math.max(0, Number(query.pos) || 0)
      const doc = String(query.doc || "")
      let best = null
      for (const e of entries || []) {
        if (!e || !e.suggestion) continue
        const edoc = String(e.doc || "")
        const epos = Number(e.pos) || 0
        // 文档增量必须等于光标增量：位置对不上就不是「同一处续打」
        if (pos - epos !== doc.length - edoc.length) continue
        if (!doc.startsWith(edoc)) continue
        const typed = doc.slice(edoc.length)
        if (!e.suggestion.startsWith(typed)) continue
        if (!best || edoc.length > String(best.doc || "").length) best = e
      }
      if (!best) return null
      const typedLen = doc.length - String(best.doc || "").length
      const suggestion = best.suggestion.slice(typedLen)
      if (!suggestion) return null
      return { suggestion, entry: best }
    }

    /**
     * 按行接受：切出「到第一个换行为止」的一段。
     *
     * VS Code 的 `acceptNextLine` 语义：一次吃一整行，剩下继续留在幽灵态；
     * 单行建议就整段接受（否则按下去没反应，用户会以为键坏了）。
     *
     * @param {string} suggestion
     * @returns {{piece:string, rest:string}}
     */
    function splitNextLine(suggestion) {
      const s = String(suggestion == null ? "" : suggestion)
      if (!s) return { piece: "", rest: "" }
      const i = s.indexOf("\n")
      if (i < 0) return { piece: s, rest: "" }
      return { piece: s.slice(0, i + 1), rest: s.slice(i + 1) }
    }

    /**
     * ── 跨格上下文 v2 的预算与抽取（#8）──
     *
     * 旧行为：固定「前 3 个代码格」× 尾部 1500 字符。
     * 两个问题：① 3 格是个魔数，短格浪费预算、长格互相挤；② markdown 格一个字都不送，
     * 于是「## 数据清洗」这一节下面补出来的代码跟章节意图无关。
     *
     * 新行为：
     *  · **总字符预算**（1200 token ≈ 4200 字符）从近到远填，用完为止；
     *  · markdown 格折成一行「意图注释」（标题 + 首行正文，≤120 字符）；
     *  · 代码格仍是尾部截断（离光标近的代码更有用），单格 ≤1500 字符。
     */
    const GHOST_CONTEXT_TOKENS = 1200
    const GHOST_CHARS_PER_TOKEN = 3.5
    const GHOST_CONTEXT_CHARS = Math.floor(GHOST_CONTEXT_TOKENS * GHOST_CHARS_PER_TOKEN)
    const GHOST_CONTEXT_CELL_CHARS = 1500
    const GHOST_INTENT_CHARS = 120

    /**
     * markdown 格 → 一行意图注释。
     *
     * 取「标题行 + 第一行正文」（跳过围栏与其它标题），例如
     * `## 数据清洗\n\n去掉缺失值` → `# 数据清洗 — 去掉缺失值`。
     * 为什么不做全文：markdown 的散文会挤占代码预算，而补全真正需要的只是「这一节要干什么」。
     */
    function markdownIntent(source, maxLen = GHOST_INTENT_CHARS) {
      const raw = String(source == null ? "" : source).split("\n")
      // 先剔掉代码围栏里的内容：markdown 格里的 ```python 块不是「意图」，
      // 抄进上下文既占预算又容易让模型以为那是已经写过的代码（评审抓过）。
      const prose = []
      let inFence = false
      for (const line of raw) {
        const l = line.trim()
        if (/^```/.test(l)) {
          inFence = !inFence
          continue
        }
        if (inFence || !l) continue
        prose.push(l)
      }
      if (!prose.length) return ""
      const isHeading = (l) => /^#{1,6}\s+/.test(l)
      const heading = prose.find(isHeading) || ""
      const title = (heading || prose[0]).replace(/^#{1,6}\s*/, "").trim()
      if (!title) return ""
      const body = prose.find((l) => l !== heading && !isHeading(l)) || ""
      const text = body ? `# ${title} — ${body}` : `# ${title}`
      return text.length > maxLen ? text.slice(0, Math.max(8, maxLen)) : text
    }

    /**
     * 从当前格**往前**抽上下文，按总预算从近到远填。
     *
     * @param {Array<{cellType?:string, source?:string}>} cells 全部单元格
     * @param {number} localIdx 当前格下标（-1 = 不知道 → 视作末尾）
     * @param {{budgetChars?:number, cellChars?:number}} [opts]
     * @returns {Array<{source:string, kind:"code"|"bash"|"markdown"}>} 按时间顺序（远 → 近）
     */
    function buildGhostContext(cells, localIdx, opts) {
      const o = opts || {}
      const list = Array.isArray(cells) ? cells : []
      const budget = Math.max(200, Number(o.budgetChars) || GHOST_CONTEXT_CHARS)
      const cellCap = Math.max(120, Number(o.cellChars) || GHOST_CONTEXT_CELL_CHARS)
      const idx = Number.isInteger(localIdx) && localIdx >= 0 ? Math.min(localIdx, list.length) : 0
      const picked = []
      let used = 0
      for (let i = idx - 1; i >= 0 && used < budget; i -= 1) {
        const c = list[i]
        if (!c) continue
        const src = String(c.source || "")
        if (!src.trim()) continue
        const type = normalizeCellType(c.cellType)
        let text = ""
        let kind = "code"
        if (type === "markdown") {
          text = markdownIntent(src)
          kind = "markdown"
        } else if (type === "code" || type === "bash") {
          text = src.length > cellCap ? src.slice(-cellCap) : src
          kind = type === "bash" ? "bash" : "code"
        } else {
          continue
        }
        if (!text) continue
        const room = budget - used
        if (room <= 0) break
        if (text.length > room) {
          // 代码留尾部（离光标近的在后），markdown 意图留头部（标题开头最重要）
          text = kind === "markdown" ? text.slice(0, room) : text.slice(text.length - room)
        }
        used += text.length
        picked.unshift({ source: text, kind })
      }
      return picked
    }

    /** 多行建议按 `maxLines` 截断（设置项 #13；也是「整格重吐」的兜底闸门）。 */
    function truncateLines(text, maxLines) {
      const s = String(text == null ? "" : text)
      const n = Math.max(1, Math.floor(Number(maxLines) || 6))
      const lines = s.split("\n")
      if (lines.length <= n) return s
      return lines.slice(0, n).join("\n")
    }

    /**
     * #11 增量收缩：用户敲出来的字符**正是建议的开头** → 幽灵文本原地后退一格，而不是整条消失。
     *
     * 为什么重要：一打字幽灵就全没了，用户会以为「AI 改主意了」或者「这功能抖」；
     * JupyterLab 的 `ghost.ts` 用的是同一条规则（`FilterAndUpdate`：`startsWith` 切片）。
     * 反之，敲的内容与建议无关（删字、替换、粘贴别的）→ 返回 null，照旧作废。
     *
     * @param {{pos:number, suggestion:string}|null} ghost 当前建议
     * @param {string} inserted 这次事务插入的文本（必须是**纯插入**，调用方保证）
     * @param {number} at 插入位置（旧文档坐标）
     * @returns {{pos:number, suggestion:string}|null}
     */
    function shrinkGhost(ghost, inserted, at) {
      if (!ghost || !ghost.suggestion) return null
      const text = String(inserted == null ? "" : inserted)
      if (!text) return null
      if (Number(ghost.pos) !== Number(at)) return null
      if (!ghost.suggestion.startsWith(text)) return null
      const rest = ghost.suggestion.slice(text.length)
      if (!rest) return null
      return { pos: ghost.pos, suggestion: rest }
    }

    /**
     * CM6 内联补全（ghost text）。
     *
     * 实现要点：
     *  - StateField 存当前建议；Decoration.widget 画灰色幽灵文本（**不进文档**，所以
     *    不会污染 undo 栈，也不会让「保存」带上没接受的内容）；
     *  - Tab 接受、Esc 丢弃；
     *  - 任何真实输入/选区变化立刻清掉建议（否则幽灵文本会飘到错误位置）。
     */
    function buildGhostExtension(CM, { request, enabled, onApi, onBusy, getOptions }) {
      /** 幽灵文本：灰色、斜体、不接收事件（点了也当没点）。 */
      class GhostWidget extends CM.WidgetType {
        constructor(suggestion) {
          super()
          this.suggestion = suggestion
        }
        toDOM() {
          const el = document.createElement("span")
          el.className = "nb2-ghost"
          el.textContent = this.suggestion
          return el
        }
        eq(other) {
          return other.suggestion === this.suggestion
        }
        ignoreEvent() {
          return true
        }
      }

      const setGhost = CM.StateEffect.define()
      const clearGhost = CM.StateEffect.define()

      const field = CM.StateField.define({
        create: () => null,
        update(value, tr) {
          /**
           * ⚠️ **effect 必须先于 docChanged 判定**。
           *
           * 「分级接受」（按词 / 按行）的事务同时带 `changes`（插入这一小段）和
           * `setGhost`（剩下的建议挪到新位置）。若先看 docChanged 就 return null，
           * 剩下的建议会被直接丢掉 —— 表现是「按行接受只吃一行，后面没了」，
           * 而这个 bug 不报错，只有真机连按两次才发现（acceptWord 早先就是这样半残的）。
           */
          for (const e of tr.effects) {
            if (e.is(setGhost)) return e.value
            if (e.is(clearGhost)) return null
          }
          // 文档一变（打字/撤销/粘贴）旧建议立刻作废 —— 否则幽灵文本会飘到错误位置
          if (tr.docChanged) {
            /**
             * #11 增量收缩：这次是**纯插入**、位置就在建议锚点、且插进去的正是建议开头
             * → 让幽灵原地后退，而不是整条消失（一打字就没 = 用户以为功能坏了）。
             * 删除 / 替换 / 粘贴别的 仍然一律作废。
             */
            let inserted = ""
            let at = -1
            let pureInsert = true
            let count = 0
            tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
              count += 1
              if (fromA !== toA) pureInsert = false
              else {
                inserted += ins.toString()
                at = fromA
              }
            })
            if (!pureInsert || count !== 1) return null
            return shrinkGhost(value, inserted, at)
          }
          if (tr.selection) return null
          return value
        },
        provide: (f) =>
          CM.EditorView.decorations.from(f, (value) => {
            if (!value || !value.suggestion) return CM.Decoration.none
            return CM.Decoration.set(
              [CM.Decoration.widget({ widget: new GhostWidget(value.suggestion), side: 1 }).range(value.pos)],
              true,
            )
          }),
      })

      let timer = null
      let lastAt = 0
      let disposed = false
      let inflight = null
      /**
       * 上一次用户**主动丢弃**建议的时刻（Esc 键，见 dismiss）。
       * 触发判据据此在 3s 内降权 —— 用户刚说了「不要」，别马上又推一条。
       */
      let rejectedAt = 0
      /** 现读设置项（防抖 / 最大行数）：改设置立即生效，不用重建编辑器。 */
      const readOptions = () => {
        if (typeof getOptions !== "function") return {}
        try {
          return getOptions() || {}
        } catch {
          return {}
        }
      }

      /**
       * 建议缓存（LRU，64 条）：`文档全文 + 光标位置` → suggestion。
       *
       * 为什么值得：用户退格/改一个字符再改回来时，命中的是**完全相同的输入**，
       * 没有任何理由再付一次网络往返。Continue 的 `AutocompleteLruCache` 就是这个思路。
       * 命中时 0 延迟直接出幽灵文本，也顺带省 token。
       *
       * v2（2026-11-07）：从「精确匹配」升级成**最长前缀匹配**（见 `matchGhostCache`）。
       * 精确匹配只能救「退格又打回来」，救不了「继续往下打」——而后者才是打字时的主要形态。
       */
      const GHOST_CACHE_LIMIT = 64
      const cache = new Map()
      const cacheKeyOf = (pos, doc) => `${pos}\u0000${doc}`
      /** 命中返回**剩余**建议（已切掉用户自己打出来的那截）；未命中返回 undefined。 */
      const cacheGet = (pos, doc) => {
        const hit = matchGhostCache(cache.values(), { pos, doc })
        if (!hit) return undefined
        cache.delete(hit.entry.key)
        cache.set(hit.entry.key, hit.entry) // LRU：命中即刷新
        return hit.suggestion
      }
      const cacheSet = (pos, doc, value) => {
        if (!value) return
        const key = cacheKeyOf(pos, doc)
        cache.delete(key)
        cache.set(key, { key, pos, doc, suggestion: value })
        if (cache.size > GHOST_CACHE_LIMIT) cache.delete(cache.keys().next().value)
      }

      /** view 还活着吗：CM6 在 destroyed 状态下 dispatch 会抛，而这里都在 async 里（会变成 unhandled rejection）。 */
      const alive = (view) => {
        if (disposed) return false
        if (!view || view.destroyed) return false
        const dom = view.dom
        // 面板/标签刚关掉时 dom 已摘出文档，此时 dispatch 也没意义
        return !!(dom && dom.isConnected !== false)
      }

      const schedule = (view, force = false) => {
        if (timer) clearTimeout(timer)
        /**
         * 新键入立刻掐掉在途请求。
         *
         * 早先只在「编辑器销毁」时 abort：用户每敲一个字符，上一个请求仍然跑完
         * （1–2s、真金白银的 token），回来后才发现文档变了被丢弃。这里补上即时取消。
         */
        if (inflight && typeof inflight.abort === "function") {
          try {
            inflight.abort()
          } catch {
            /* ignore */
          }
          inflight = null
        }
        if (!enabled() && !force) return
        const pos = view.state.selection.main.head
        const doc = view.state.doc.toString()
        // 设置项（#13）：防抖时长现读，改设置立刻生效，不需要重建编辑器
        const liveOpts = readOptions()
        const debounce = Math.max(0, Math.min(5000, Number(liveOpts.debounceMs) || 550))
        // ⚠️ minGap 不能在这里「直接 return」：上一行的 clearTimeout 已经把排期清掉了，
        // 用户这时刚好停手 → 这次永远不会补，必须再敲一个字符才有。所以把它挪进回调里判断。
        // force（Alt-\ 手动触发）不受 minGap 限制：用户明确按了就要立刻给。
        timer = setTimeout(async () => {
          if (!alive(view)) return
          const gapWait = debounce - (Date.now() - lastAt)
          if (gapWait > 0 && !force) {
            schedule(view)
            return
          }
          if (view.state.doc.toString() !== doc) return
          if (
            !force &&
            !shouldRequestCompletion({
              enabled: true,
              doc,
              pos,
              now: Date.now(),
              lastAt,
              minGap: debounce,
              // 刚刚按 Esc 丢弃过建议（#6）：3s 内降权，别把用户明确丢掉的东西马上再推回来
              rejectAt: rejectedAt,
            })
          ) {
            return
          }
          const at = view.state.selection.main.head
          lastAt = Date.now()
          // 前缀缓存命中（最长前缀匹配）→ 直接出幽灵文本，0 网络延迟
          const cached = cacheGet(at, doc)
          if (cached) {
            if (alive(view) && view.state.doc.toString() === doc) {
              view.dispatch({ effects: setGhost.of({ pos: at, suggestion: cached }) })
            }
            return
          }
          // 切格/关面板时把请求也掐掉，别让它自己跑完再回来 dispatch
          const ac = typeof AbortController === "function" ? new AbortController() : null
          inflight = ac
          let out = null
          // 在途指示：让用户看见「AI 在工作」而不是盲盒（ghost 请求 0.8–2s 没有任何反馈最难受）
          try {
            if (onBusy) onBusy(true)
          } catch {
            /* ignore */
          }
          try {
            out = await request({ prefix: doc.slice(0, at), suffix: doc.slice(at), pos: at, signal: ac ? ac.signal : null })
          } catch {
            return
          } finally {
            if (inflight === ac) inflight = null
            try {
              if (onBusy) onBusy(false)
            } catch {
              /* ignore */
            }
          }
          if (!out || !out.suggestion) return
          cacheSet(at, doc, out.suggestion)
          if (!alive(view)) return
          if (view.state.doc.toString() !== doc) return
          view.dispatch({ effects: setGhost.of({ pos: at, suggestion: out.suggestion }) })
        }, force ? 0 : debounce)
        if (timer && typeof timer.unref === "function") timer.unref()
      }

      return [
        field,
        CM.EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          // 注意：不在这里 dispatch 清 ghost —— field 的 update 见到 docChanged 已经返回 null，
          // 在 updateListener 里再 dispatch 是重入，容易触发「不能在下发中下发」的坑。
          schedule(u.view)
        }),
        /**
         * 编辑器销毁时收掉定时器与在途请求。
         *
         * 为什么必须有：`setTimeout` 里会 `view.dispatch`，而切格/关面板/热重载都会 destroy 这个 view。
         * CM6 在 Destroyed 状态下 dispatch 会抛错，且这里跑在 async 回调里 → 变成 unhandled rejection，
         * 控制台一堆红字但界面上看不出原因。ViewPlugin 的 destroy() 是唯一可靠的清理点。
         */
        CM.ViewPlugin.fromClass(
          class {
            constructor(view) {
              this.view = view
            }
            destroy() {
              disposed = true
              if (timer) {
                clearTimeout(timer)
                timer = null
              }
              if (inflight && typeof inflight.abort === "function") {
                try {
                  inflight.abort()
                } catch {
                  /* ignore */
                }
                inflight = null
              }
            }
          },
        ),
        CM.EditorView.theme({
          ".nb2-ghost": {
            opacity: 0.45,
            whiteSpace: "pre",
            color: "var(--dsw-alias-label-secondary, currentColor)",
            fontStyle: "italic",
          },
        }),
        // 把接受/丢弃交给外面（见 buildExtensions 里那个 Tab 绑定）：不在这里注册 keymap，
        // 免得和 indentWithTab 抢不过（跨 keymap 的优先级语义太脆）。
        onApi
          ? (() => {
              onApi({
                has: (view) => {
                  const g = view.state.field(field)
                  return !!(g && g.suggestion)
                },
                /** 手动触发（Alt-\）：忽略 enabled 开关，立刻请求一次 */
                force: (view) => {
                  if (!alive(view)) return false
                  schedule(view, true)
                  return true
                },
                accept: (view) => {
                  const g = view.state.field(field)
                  if (!g || !g.suggestion) return false
                  view.dispatch({
                    changes: { from: g.pos, to: g.pos, insert: g.suggestion },
                    selection: { anchor: g.pos + g.suggestion.length },
                    effects: clearGhost.of(null),
                  })
                  return true
                },
                /**
                 * 分级接受：只吃「下一个词」（到空白/标点边界），剩下的继续留在幽灵态。
                 * VS Code / Copilot 的 Ctrl-→ 就是这个语义 —— 一次吃一小口，边看边决定。
                 */
                acceptWord: (view) => {
                  const g = view.state.field(field)
                  if (!g || !g.suggestion) return false
                  const m = /^[^\s]*\s?/.exec(g.suggestion)
                  const piece = m ? m[0] : g.suggestion
                  if (!piece) return false
                  const rest = g.suggestion.slice(piece.length)
                  view.dispatch({
                    changes: { from: g.pos, to: g.pos, insert: piece },
                    selection: { anchor: g.pos + piece.length },
                    effects: setGhost.of({ pos: g.pos + piece.length, suggestion: rest }),
                  })
                  return true
                },
                /**
                 * 分级接受（二）：只吃「下一行」（到第一个换行为止），剩下的继续留在幽灵态。
                 *
                 * 多行建议里最常见的场景是「第一行正是我要的，后面几行用不上」——
                 * 只有 Tab（全接受）和 Esc（全丢弃）两个极端时，用户只能整段接了再手删。
                 * VS Code 的 `acceptNextLine` 就是这个语义。
                 */
                acceptLine: (view) => {
                  const g = view.state.field(field)
                  if (!g || !g.suggestion) return false
                  const { piece, rest } = splitNextLine(g.suggestion)
                  if (!piece) return false
                  view.dispatch({
                    changes: { from: g.pos, to: g.pos, insert: piece },
                    selection: { anchor: g.pos + piece.length },
                    effects: rest ? setGhost.of({ pos: g.pos + piece.length, suggestion: rest }) : clearGhost.of(null),
                  })
                  return true
                },
                dismiss: (view) => {
                  if (!view.state.field(field)) return false
                  // 记下「用户主动拒绝」的时刻：3s 内触发判据降权（#6）
                  rejectedAt = Date.now()
                  view.dispatch({ effects: clearGhost.of(null) })
                  return true
                },
              })
              return []
            })()
          : [],
      ]
    }

    /**
     * 点击落点 → 焦点该交给谁。
     *
     * 这是**真机 bug 的修复点**：之前 cell 容器上无条件 `onClick: () => wrap.focus()`，
     * 而点击会从 CM6 的 contentDOM 冒泡到容器，于是点一下编辑器、焦点立刻被容器抢走，
     * 之后敲字母全落在容器的 keydown 上 → 表现就是「这个 cell 不能输入」。
     *
     * 返回：
     *   "self"      —— 点在按钮/下拉上，谁都别动
     *   "editor-self" —— 点在 CM6 内部，让它自己处理（我们**不能**再 focus 别的）
     *   "container" —— 点左侧槽位，进容器态（方向键选格/删格）
     *   "editor"    —— 点正文空白，进编辑态并聚焦编辑器
     */
    function resolveCellClick({ inEditor = false, inGutter = false, inControl = false, inOutput = false } = {}) {
      if (inControl) return "self"
      if (inEditor) return "editor-self"
      // 输出区：点它是为了选中/复制 stdout、报错文本，绝不能把焦点扔进编辑器
      // （否则一松手选区就塌了，输出根本复制不了 —— 真机反馈过）
      if (inOutput) return "self"
      if (inGutter) return "container"
      return "editor"
    }

    /**
     * 容器态键位要不要放行给编辑器。
     *
     * 另一个真机问题：焦点在 CM6 里时 focusMode 可能还是 "container"（用户是鼠标点进去的，
     * 没按过 Enter）。此时按 Backspace 会命中容器的「删除本格」分支 —— 打字打成删格。
     * 所以判定必须看**事件真正落在哪儿**，不能只信 focusMode 这个状态。
     */
    function shouldIgnoreContainerKey({ inEditor = false, focusMode = "container" } = {}) {
      return !!inEditor || focusMode === "editor"
    }

    /** 输出太长就先只渲头尾（点开再看全部）。返回 null = 不需要折叠。 */
    function foldDecision(text) {
      const s = String(text || "")
      const lines = s.split("\n")
      if (s.length <= LAZY_CHARS && lines.length <= LAZY_LINES) return null
      const head = lines.slice(0, LAZY_HEAD).join("\n")
      const tail = lines.slice(Math.max(LAZY_HEAD, lines.length - LAZY_TAIL)).join("\n")
      return {
        head,
        tail,
        hiddenLines: Math.max(0, lines.length - LAZY_HEAD - LAZY_TAIL),
        hiddenChars: Math.max(0, s.length - head.length - tail.length),
      }
    }

    // ───────────────────────── ANSI（终端颜色） ─────────────────────────

    /**
     * 终端 8 色的基色。**故意不写纯黑/纯白**：纯黑在深色主题下看不见、纯白在浅色主题下
     * 看不见。最终颜色一律 `color-mix(in srgb, 基色 N%, currentColor)` —— currentColor
     * 在浅色主题是深墨、深色主题是浅墨，同一份色板于是两边都「有颜色且可读」。
     *
     * 参考：JupyterLab `packages/rendermime/style/base.css` 的 `.ansi-*-fg` 色板
     * （前端把 `\x1b[31m` 这类 SGR 序列解析成 span，而不是原样吐给用户）。
     */
    const ANSI_BASE = ["#6e7681", "#d13438", "#2ea043", "#bf8700", "#1f6feb", "#a371f7", "#0b7285", "#8b949e"]

    const ANSI_EMPTY_STYLE = { fg: null, bg: null, bold: false, italic: false, underline: false }

    /** 标准色：80% 基色 + 20% 正文色（浅底偏深、深底偏亮）。 */
    function ansiFg(index) {
      return `color-mix(in srgb, ${ANSI_BASE[index % 8]} 80%, currentColor)`
    }

    /** 亮色：更靠近正文色。浅色主题下更深、深色主题下更亮，与 JupyterLab 的 intense 规律一致。 */
    function ansiFgBright(index) {
      return `color-mix(in srgb, ${ANSI_BASE[index % 8]} 58%, currentColor)`
    }

    /** 背景只上 16% 淡底：终端语义色当底色时，纯色底会把前景色吞掉。 */
    function ansiBg(index) {
      return `color-mix(in srgb, ${ANSI_BASE[index % 8]} 16%, transparent)`
    }

    /** xterm 256 色号 → CSS 颜色。truecolor（38;2;r;g;b）不走这里。 */
    function xterm256(n) {
      const i = Math.max(0, Math.min(255, Number(n) || 0))
      if (i < 8) return ansiFg(i)
      if (i < 16) return ansiFgBright(i - 8)
      if (i < 232) {
        const k = i - 16
        // 6×6×6 色立方：0 号是纯黑，其余按 55 + 40*v 递增
        const step = (v) => (v === 0 ? 0 : 55 + v * 40)
        return `rgb(${step(Math.floor(k / 36))}, ${step(Math.floor((k % 36) / 6))}, ${step(k % 6)})`
      }
      const v = 8 + (i - 232) * 10
      return `rgb(${v}, ${v}, ${v})`
    }

    /**
     * 应用一条 SGR 参数串（`\x1b[` 与 `m` 之间的部分）。返回**新**样式对象，
     * 不改入参（parseAnsi 要拿旧样式给前一段文本）。
     */
    function applySgr(style, params) {
      const codes = params === "" ? [0] : params.split(";").map((x) => (x === "" ? 0 : Number(x)))
      const s = Object.assign({}, style)
      for (let i = 0; i < codes.length; i += 1) {
        const c = codes[i]
        if (!Number.isFinite(c)) continue
        if (c === 0) Object.assign(s, ANSI_EMPTY_STYLE)
        else if (c === 1) s.bold = true
        else if (c === 3) s.italic = true
        else if (c === 4) s.underline = true
        else if (c === 22) s.bold = false
        else if (c === 23) s.italic = false
        else if (c === 24) s.underline = false
        else if (c >= 30 && c <= 37) s.fg = ansiFg(c - 30)
        else if (c === 39) s.fg = null
        else if (c >= 40 && c <= 47) s.bg = ansiBg(c - 40)
        else if (c === 49) s.bg = null
        else if (c >= 90 && c <= 97) s.fg = ansiFgBright(c - 90)
        else if (c >= 100 && c <= 107) s.bg = ansiBg(c - 100)
        else if (c === 38 || c === 48) {
          const key = c === 38 ? "fg" : "bg"
          const kind = codes[i + 1]
          if (kind === 5) {
            const n = codes[i + 2]
            if (Number.isFinite(n)) {
              const col = xterm256(n)
              s[key] = key === "bg" ? `color-mix(in srgb, ${col} 18%, transparent)` : col
            }
            i += 2
          } else if (kind === 2) {
            const r = codes[i + 2]
            const g = codes[i + 3]
            const b = codes[i + 4]
            if ([r, g, b].every(Number.isFinite)) {
              const col = `rgb(${r}, ${g}, ${b})`
              s[key] = key === "bg" ? `color-mix(in srgb, ${col} 18%, transparent)` : col
            }
            i += 4
          } else {
            i += 1
          }
        }
      }
      return s
    }

    const ANSI_SGR_RE = /\u001b\[([0-9;]*)m/g

    /**
     * 把带 ANSI 的文本切成「同色小段」。没有转义码时返回**一个**整体段，
     * 调用方据此走零开销的纯文本路径。
     * @returns {Array<{text: string, style: object}>}
     */
    function parseAnsi(text) {
      const src = String(text == null ? "" : text)
      if (src.indexOf("\u001b") < 0) return [{ text: src, style: ANSI_EMPTY_STYLE }]
      const out = []
      let style = ANSI_EMPTY_STYLE
      let last = 0
      ANSI_SGR_RE.lastIndex = 0
      let m = ANSI_SGR_RE.exec(src)
      while (m !== null) {
        if (m.index > last) out.push({ text: src.slice(last, m.index), style })
        style = applySgr(style, m[1])
        last = ANSI_SGR_RE.lastIndex
        m = ANSI_SGR_RE.exec(src)
      }
      if (last < src.length) out.push({ text: src.slice(last), style })
      return out.length ? out : [{ text: "", style: ANSI_EMPTY_STYLE }]
    }

    /** 剥掉转义序列。折叠/截断前必须先用它，否则会切在序列中间留下可见的 `[31` 残渣。 */
    function stripAnsi(text) {
      return String(text == null ? "" : text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    }

    /** ANSI 纯文本 → React 子节点。无转义码时原样返回字符串（不改变既有结构、零额外节点）。 */
    function ansiNodes(text) {
      const src = String(text == null ? "" : text)
      if (src.indexOf("\u001b") < 0) return src
      return parseAnsi(src)
        .filter((seg) => seg.text)
        .map((seg, i) => {
          const st = seg.style
          const style = {}
          if (st.fg) style.color = st.fg
          if (st.bg) style.background = st.bg
          if (st.bold) style.fontWeight = 650
          if (st.italic) style.fontStyle = "italic"
          if (st.underline) style.textDecoration = "underline"
          return Object.keys(style).length ? h("span", { key: `a${i}`, style }, seg.text) : seg.text
        })
    }

    /** 极简 markdown → React 节点。够用：标题/粗斜体/行内码/代码块/列表/链接/图片/行内公式/表格。 */
    function markdownLite(src, CM) {
      const lines = String(src || "").split("\n")
      const out = []
      let i = 0
      let key = 0
      const inline = (text) => {
        // 行内公式 $...$ → katex
        const parts = []
        const re = /(\$[^$\n]+\$|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g
        let last = 0
        let m
        while ((m = re.exec(text)) !== null) {
          if (m.index > last) parts.push(text.slice(last, m.index))
          const tok = m[0]
          if (tok.startsWith("$")) {
            /**
             * ⚠️ 公式走 innerHTML 也必须先过消毒器（纵深防御）。
             * 拿不到 DOMPurify（`CM.DOMPurify` 在无 DOM 环境里是工厂本身、没有 sanitize）
             * 就退回纯文本 `<code>$tex$</code>` —— **绝不**把未消毒 HTML 塞进 DOM。
             */
            const tex = tok.slice(1, -1)
            const clean = canInjectHtml(CM) ? sanitizeHtml(renderLatex(tex, CM, true), CM) : null
            if (clean != null) parts.push(h("span", { key: `m${key++}`, dangerouslySetInnerHTML: { __html: clean } }))
            else parts.push(h("code", { key: `m${key++}`, style: codeStyle }, `$${tex}$`))
          } else if (tok.startsWith("`")) {
            parts.push(h("code", { key: `c${key++}`, style: codeStyle }, tok.slice(1, -1)))
          } else if (tok.startsWith("**") || tok.startsWith("__")) {
            parts.push(h("b", { key: `b${key++}` }, tok.slice(2, -2)))
          } else if (tok.startsWith("*")) {
            parts.push(h("i", { key: `i${key++}` }, tok.slice(1, -1)))
          } else if (tok.startsWith("[")) {
            const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
            if (mm) parts.push(h("a", { key: `a${key++}`, href: mm[2], target: "_blank", rel: "noreferrer noopener", style: { color: ACCENT } }, mm[1]))
            else parts.push(tok)
          }
          last = m.index + tok.length
        }
        if (last < text.length) parts.push(text.slice(last))
        return parts.length ? parts : text
      }

      while (i < lines.length) {
        const line = lines[i]
        if (/^\s*```/.test(line)) {
          const lang = line.trim().slice(3).trim()
          const buf = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++])
          i += 1
          out.push(
            h(
              "pre",
              { key: `pre${key++}`, style: { ...preStyle, whiteSpace: "pre-wrap" } },
              h("code", { style: codeStyle, "data-lang": lang }, buf.join("\n")),
            ),
          )
          continue
        }
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          const head = line.split("|").slice(1, -1).map((s) => s.trim())
          i += 2
          const rows = []
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
            rows.push(lines[i].split("|").slice(1, -1).map((s) => s.trim()))
            i += 1
          }
          out.push(
            h(
              "table",
              { key: `t${key++}`, style: tableStyle },
              h("thead", null, h("tr", null, head.map((c, ci) => h("th", { key: ci, style: thStyle }, inline(c))))),
              h("tbody", null, rows.map((r, ri) => h("tr", { key: ri }, r.map((c, ci) => h("td", { key: ci, style: tdStyle }, inline(c)))))),
            ),
          )
          continue
        }
        const hm = /^(#{1,6})\s+(.*)$/.exec(line)
        if (hm) {
          const level = hm[1].length
          out.push(h(`h${level}`, { key: `h${key++}`, style: { margin: "10px 0 6px", fontSize: 20 - level * 2, fontWeight: 650 } }, inline(hm[2])))
          i += 1
          continue
        }
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""))
            i += 1
          }
          out.push(h("ul", { key: `ul${key++}`, style: { margin: "6px 0", paddingLeft: 20 } }, items.map((it, ii) => h("li", { key: ii, style: { margin: "2px 0" } }, inline(it)))))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""))
          out.push(
            h("blockquote", { key: `q${key++}`, style: { margin: "6px 0", paddingLeft: 10, borderLeft: "3px solid var(--dsw-alias-border-l2,#3a3a3a)", opacity: 0.9 } }, markdownLite(buf.join("\n"), CM)),
          )
          continue
        }
        if (!line.trim()) {
          i += 1
          continue
        }
        out.push(h("p", { key: `p${key++}`, style: { margin: "6px 0", lineHeight: 1.65 } }, inline(line)))
        i += 1
      }
      return out
    }

    const preStyle = {
      margin: 0,
      padding: "8px 10px",
      overflow: "auto",
      fontFamily: FONT_MONO,
      fontSize: 11.5,
      lineHeight: 1.5,
      // 面板只有半屏宽：跟着 JupyterLab / VS Code 折行，而不是让长行顶出横向滚动条
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    }
    /**
     * 错误/警告的色相。**不要**写死 `#ff9a9a`（深色主题专用色）：浅色主题下它是淡粉，
     * 压在淡红底上几乎读不出来。走 `color-mix(..., currentColor)`，浅色变深、深色变亮。
     */
    const ERROR_HUE = "#e5484d"
    const STDERR_COLOR = `color-mix(in srgb, ${ERROR_HUE} 74%, currentColor)`
    const ERROR_TITLE_COLOR = `color-mix(in srgb, ${ERROR_HUE} 80%, currentColor)`
    const codeStyle = {
      fontFamily: FONT_MONO,
      fontSize: "0.94em",
      background: "color-mix(in srgb, currentColor 9%, transparent)",
      borderRadius: 3,
      padding: "0 3px",
    }
    const tableStyle = { borderCollapse: "collapse", margin: "8px 0", fontSize: 12 }
    const thStyle = { border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)", padding: "3px 8px", textAlign: "left", background: "color-mix(in srgb, currentColor 5%, transparent)" }
    const tdStyle = { border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)", padding: "3px 8px" }

    /** KaTeX 渲染；没有 vendor 或解析失败就退回等宽文本（绝不抛）。 */
    function renderLatex(tex, CM, inline) {
      try {
        if (CM && CM.katex && typeof CM.katex.renderToString === "function") {
          return CM.katex.renderToString(String(tex), { throwOnError: false, displayMode: !inline })
        }
      } catch {
        /* fall through */
      }
      return String(tex).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
    }

    // ─────────────── AI 补全：设置项与注释行插入规则（纯函数，可测） ───────────────

    /**
     * 设置项在 localStorage 里的键。
     *
     * **v2 = 补全 / 改写分开存**（用户反馈：注释生成代码的补全 与 内置 AI 改写
     * 应该是两个设置）。v1 只有一份，只给改写用 —— 保留键名用于一次性迁移。
     */
    const AI_PREF_KEY = "nb2.aiPrefs.v2"
    const AI_PREF_KEY_V1 = "nb2.aiPrefs.v1"

    /** 一套「模型选择」（补全与改写各持一份）。 */
    function emptyTarget() {
      return { provider: null, model: null, reasoningEffort: null }
    }

    /**
     * 补全的两个手感参数（设置项 #13）。
     *
     * `debounceMs` —— 停止输入多久后请求（默认 550ms：再短会在打字中途乱发请求，
     *                再长会觉得「卡」）。`maxLines` —— 一条建议最多几行（默认 6）。
     * 两者都做区间夹取：界面上允许手输，但存储里不能出现 0 或 9999。
     */
    const DEFAULT_COMPLETION_DEBOUNCE_MS = 550
    const DEFAULT_COMPLETION_MAX_LINES = 6
    const COMPLETION_DEBOUNCE_MIN = 100
    const COMPLETION_DEBOUNCE_MAX = 2000
    const COMPLETION_MAX_LINES_MIN = 1
    const COMPLETION_MAX_LINES_MAX = 20

    /** 补全设置：模型三件套 + 开关 + 两个手感参数（缺省一律回默认）。 */
    function normalizeCompletion(o) {
      const src = o || {}
      const d = Number(src.debounceMs)
      const m = Number(src.maxLines)
      return {
        ...normalizeTarget(src),
        enabled: !!src.enabled,
        debounceMs: Number.isFinite(d)
          ? Math.max(COMPLETION_DEBOUNCE_MIN, Math.min(COMPLETION_DEBOUNCE_MAX, Math.round(d)))
          : DEFAULT_COMPLETION_DEBOUNCE_MS,
        maxLines: Number.isFinite(m)
          ? Math.max(COMPLETION_MAX_LINES_MIN, Math.min(COMPLETION_MAX_LINES_MAX, Math.round(m)))
          : DEFAULT_COMPLETION_MAX_LINES,
      }
    }

    /** 把任意来源的对象收敛成合法的 target（多余字段丢掉，非字符串丢掉）。 */
    function normalizeTarget(o) {
      const t = o || {}
      return {
        provider: t.provider ? String(t.provider) : null,
        model: t.model ? String(t.model) : null,
        reasoningEffort: t.reasoningEffort ? String(t.reasoningEffort) : null,
      }
    }

    /**
     * 读回设置。**任何异常都退回默认**（隐私模式/被禁用时 localStorage 会抛）。
     *
     * v2 形状：`{ completion: {enabled, provider, model, reasoningEffort}, inline: {...} }`
     * 迁移：v1 的 `{provider, model, reasoningEffort}` 给 `inline`；`completion` 继承
     * 同一套模型但 **enabled 保持 false** —— 补全会持续烧 token，升级不能顺手打开它。
     */
    function loadAiPrefs(store) {
      const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
      const empty = () => ({ completion: normalizeCompletion(null), inline: emptyTarget() })
      if (!s || typeof s.getItem !== "function") return empty()
      try {
        const raw = s.getItem(AI_PREF_KEY)
        if (raw) {
          const o = JSON.parse(raw) || {}
          return {
            completion: normalizeCompletion(o.completion),
            inline: normalizeTarget(o.inline),
          }
        }
        const legacy = s.getItem(AI_PREF_KEY_V1)
        if (legacy) {
          const t = normalizeTarget(JSON.parse(legacy) || {})
          return { completion: normalizeCompletion({ ...t, enabled: false }), inline: { ...t } }
        }
      } catch {
        return empty()
      }
      return empty()
    }

    /** 存回设置（同样不允许异常冒到 UI）。 */
    function saveAiPrefs(prefs, store) {
      const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
      if (!s || typeof s.setItem !== "function") return false
      try {
        const p = prefs || {}
        s.setItem(
          AI_PREF_KEY,
          JSON.stringify({
            completion: normalizeCompletion(p.completion),
            inline: normalizeTarget(p.inline),
          }),
        )
        return true
      } catch {
        return false
      }
    }

    /**
     * 光标所在那一行（光标之前的部分）是不是**纯注释行**。
     *
     * 只认 `#`（python/bash 同一套规则）；`# %%`、`###` 这些都算。
     * 故意不做「注释里有代码」的语法分析：这里要的是「用户在用注释口述想要什么」这个
     * 操作意图，不是词法正确性。
     */
    function isCommentOnlyLine(lineBeforeCursor) {
      const t = String(lineBeforeCursor == null ? "" : lineBeforeCursor).trim()
      return t.startsWith("#")
    }

    /**
     * 注释触发的补全该插到哪（用户反馈第 3 条：**注释下方插入、注释保持不动**）。
     *
     * 规则（纯函数，全部有测试）：
     *  - 光标所在行是纯注释，且**光标后面这一行没有别的字符**（即真在注释末尾）→ 补全前面补一个换行，
     *    于是代码另起一行，注释原样保留；
     *  - 模型自己已经以换行开头 → 不重复加；
     *  - 光标在注释**中间**（后面还有字）→ 不动（硬插会把注释劈成两半，比不补更糟）；
     *  - 非注释行 → 原样返回（保持原有的就地续写语义）。
     *
     * @param {{prefix?:string, suffix?:string, suggestion?:string}} opts
     * @returns {{text:string, newline:boolean}} newline=是否因为注释规则加了换行
     */
    function completionInsertText(opts) {
      const o = opts || {}
      const suggestion = String(o.suggestion == null ? "" : o.suggestion)
      if (!suggestion) return { text: "", newline: false }
      const prefix = String(o.prefix == null ? "" : o.prefix)
      const suffix = String(o.suffix == null ? "" : o.suffix)
      const lineStart = prefix.lastIndexOf("\n") + 1
      const lineBefore = prefix.slice(lineStart)
      if (!isCommentOnlyLine(lineBefore)) return { text: suggestion, newline: false }
      // 光标后面同一行还有字符 → 用户是在注释中间，不抢
      const restOfLine = suffix.slice(0, (() => {
        const i = suffix.indexOf("\n")
        return i < 0 ? suffix.length : i
      })())
      if (restOfLine.trim()) return { text: suggestion, newline: false }
      if (/^\r?\n/.test(suggestion)) return { text: suggestion, newline: false }
      return { text: "\n" + suggestion, newline: true }
    }

    // ─────────────── 面板级键盘分发（纯函数，判定矩阵可测） ───────────────


    /**
     * 这一下 Enter 组合归谁处理。
     *
     * 背景（真机 + 评审实测，别凭直觉改）：
     *  · 焦点在 `.cm-editor` 里时 CM 自己的 keymap **已经**绑了
     *    Shift-Enter / Ctrl-Enter / Mod-Enter / Alt-Enter（见 buildExtensions）。
     *    面板的 capture 分发器如果再处理一遍，同一次按键会**跑两遍**。所以一律放行。
     *  · `defaultPrevented` 必须放行：AI 条在 window capture 上处理 Mod-Enter 时只
     *    `preventDefault()` 不 `stopPropagation()`，不挡就会「接受 AI 改动 + 把旧代码再跑一遍」。
     *  · 焦点在文本输入框里一律放行（那是用户在自己打字）。
     *  · 纯 Enter 永不接管：按钮要靠它激活、markdown 格要靠它进编辑态。
     *  · `inControl` **不再**阻断 Enter 组合 —— 旧代码在 CellView 里先
     *    `if (inControl) return`，于是「点过 ▶ 之后 Shift-Enter 全死」。它现在只是随行信息。
     *  · `focusMode` 也只是随行信息：**事件真正落在哪儿**（inEditor/inInput）才是权威判据，
     *    否则「鼠标点进编辑器但 focusMode 还停在 container」会走错分支。
     *
     * @returns {"pass"|"run-below"|"run-stay"|"run-insert-below"}
     */
    function decideCellKey(state) {
      const s = state || {}
      if (s.defaultPrevented) return "pass"
      if (s.key !== "Enter") return "pass"
      if (s.inInput) return "pass"
      const shift = !!s.shiftKey
      const ctrl = !!s.ctrlKey
      const alt = !!s.altKey
      // Mod = Ctrl（Windows/Linux）或 Cmd（macOS）
      const mod = ctrl || !!s.metaKey
      // 没有任何组合键 → 不是我们的（纯 Enter 交给下层）
      if (!shift && !mod && !alt) return "pass"
      // 编辑器内部：CM 的 keymap 全包了，面板绝不插手（否则同一次按键跑两遍）
      if (s.inEditor) return "pass"
      if (shift && !mod && !alt) return "run-below"
      if (mod && !shift && !alt) return "run-stay"
      if (alt && !shift && !mod) return "run-insert-below"
      // Ctrl-Alt-Enter / Shift-Alt-Enter 之类：不认识就不抢
      return "pass"
    }
    /**
     * ── 命令注册表 + 键位表（架构说明，改动前必读）──
     *
     * 为什么这样拆：同一条动作会被**四处**调用 —— 面板级快捷键、工具栏按钮、
     * 单元格右键菜单、CM6 keymap。早先每处各写一遍闭包，于是「改一处忘三处」是必然的
     * （本仓库已经踩过：`acceptWord` 写好了却从来没接线，成为死代码）。
     *
     * 现在的分工：
     *   · `COMMANDS`    —— 动作的**元数据**（label / hint），纯数据、可测、可当文档；
     *   · `KEYBINDINGS` —— 键位 → 命令 id，**只有这一张表**知道快捷键；
     *   · 面板里的 `commands` —— 命令 id → 真正执行的闭包（要 state，只能在组件里建）。
     *
     * 加一个快捷键 = 往 `KEYBINDINGS` 加一行（然后跑测试，缺命令会立刻红）。
     * 加一个动作 = `COMMANDS` 一条 + 面板 `commands` 一条。
     *
     * ⚠️ 已知边界：**编辑器内部**的键位（Tab 接受 / Ctrl-→ 按词接受 / Mod-K / Alt-\）
     * 仍由 `buildExtensions` 的 CM6 keymap 持有 —— 它们需要 view 级 API（dispatch、
     * 选区坐标），放不进这个面板级分发器。它们的 hint 统一写在 `COMMANDS` 里，
     * 保证「右键菜单/按钮上显示的快捷键」与真实绑定一致。
     */
    const COMMANDS = {
      "cell.insertAbove": { label: "在上方插入单元格", hint: "A" },
      "cell.insertBelow": { label: "在下方插入单元格", hint: "B" },
      "cell.deleteArmed": { label: "删除本格（再按一次 D 确认）", hint: "D" },
      "cell.delete": { label: "删除本格", hint: "D D" },
      "cell.undoDelete": { label: "撤销删格", hint: "Z" },
      "cell.toCode": { label: "转为代码", hint: "Y" },
      "cell.toMarkdown": { label: "转为 Markdown", hint: "M" },
      "cell.toRaw": { label: "转为 Raw", hint: "R" },
      "cell.mergeBelow": { label: "与下一格合并", hint: "Shift-M" },
      "cell.moveUp": { label: "上移", hint: "" },
      "cell.moveDown": { label: "下移", hint: "" },
      "cell.edit": { label: "进入编辑", hint: "Enter" },
      "cell.prev": { label: "选上一格", hint: "↑" },
      "cell.next": { label: "选下一格", hint: "↓" },
      "cell.extendUp": { label: "向上扩选", hint: "Shift-↑" },
      "cell.extendDown": { label: "向下扩选", hint: "Shift-↓" },
      "cell.selectAll": { label: "全选单元格", hint: "Mod-A" },
      "cell.clearSelection": { label: "取消多选", hint: "Esc" },
      "cell.clearOutputs": { label: "清空本格输出", hint: "" },
      "cell.copySource": { label: "复制源码", hint: "" },
      "cell.cite": { label: "添加到对话", hint: "" },
      "cell.aiRewrite": { label: "AI 改写本格", hint: "Mod-K" },
      /**
       * 「让对话改本格」：不调插件自己的 LLM，而是把位置/现状/要求写成提示词投进主对话。
       * 内联 AI 看不到项目里其它文件，需要项目上下文的改法走这条（用户 2026-11-06 要求）。
       */
      "cell.promptRewrite": { label: "让对话改本格", hint: "" },
      "notebook.save": { label: "保存", hint: "Mod-S" },
      "notebook.commandMode": { label: "回到命令模式", hint: "Esc" },
      // 编辑器内部（由 CM6 keymap 持有，这里只登记元数据，供 UI 显示）
      "ghost.accept": { label: "接受补全", hint: "Tab" },
      "ghost.acceptWord": { label: "按词接受补全", hint: "Ctrl-→" },
      "ghost.acceptLine": { label: "按行接受补全", hint: "Alt-]" },
      "ghost.force": { label: "手动触发补全", hint: "Alt-\\" },
      "ai.inline": { label: "内联 AI", hint: "Mod-K" },
    }

    /**
     * 键位表。`context`：
     *   · `"command"` —— 只在**命令模式**生效（焦点不在编辑器/输入框/按钮上）；
     *   · `"global"`  —— 到处都能按（Esc / 保存）。
     * `twoStep: true` —— 两段式（第一次只上膛，第二次才执行）。
     */
    const KEYBINDINGS = [
      { key: "Mod-s", command: "notebook.save", context: "global" },
      { key: "Escape", command: "notebook.commandMode", context: "global" },
      { key: "Enter", command: "cell.edit", context: "command" },
      { key: "F2", command: "cell.edit", context: "command" },
      { key: "ArrowUp", command: "cell.prev", context: "command" },
      { key: "ArrowDown", command: "cell.next", context: "command" },
      // 多选（Jupyter：Shift-↑/↓ 扩选，Ctrl-A 全选）
      { key: "Shift-ArrowUp", command: "cell.extendUp", context: "command" },
      { key: "Shift-ArrowDown", command: "cell.extendDown", context: "command" },
      { key: "Mod-a", command: "cell.selectAll", context: "command" },
      { key: "a", command: "cell.insertAbove", context: "command" },
      { key: "b", command: "cell.insertBelow", context: "command" },
      { key: "d", command: "cell.delete", context: "command", twoStep: true },
      { key: "z", command: "cell.undoDelete", context: "command" },
      { key: "y", command: "cell.toCode", context: "command" },
      { key: "m", command: "cell.toMarkdown", context: "command" },
      { key: "r", command: "cell.toRaw", context: "command" },
      { key: "Shift-m", command: "cell.mergeBelow", context: "command" },
    ]

    /**
     * 键位匹配（纯函数）：`"Mod-s"` 里 Mod = Ctrl 或 Cmd，其余修饰键必须**精确**匹配。
     *
     * 为什么不用「拼一个 spec 字符串再比较」：`Mod` 要同时吃 Ctrl 与 Cmd，而 `Ctrl-x`
     * 不能吃 Cmd-x（macOS 上 Cmd-C 是复制，抢了就出事）。逐个修饰键比对最不容易写错。
     */
    function bindingMatches(binding, s) {
      const parts = String((binding && binding.key) || "").split("-")
      const keyName = parts[parts.length - 1]
      const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()))
      if (String((s && s.key) || "").toLowerCase() !== keyName.toLowerCase()) return false
      if (!!s.shiftKey !== mods.has("shift")) return false
      if (!!s.altKey !== mods.has("alt")) return false
      if (mods.has("mod")) {
        if (!(s.ctrlKey || s.metaKey)) return false
      } else if (mods.has("ctrl")) {
        if (!s.ctrlKey || s.metaKey) return false
      } else if (s.ctrlKey || s.metaKey) {
        return false
      }
      return true
    }

    /**
     * 命令模式按键判定（纯函数，可单测）：键位表 → 命令 id。
     *
     * 守卫（这些是「误删/误插」的防线，矩阵测试逐条锁着）：
     *  · `defaultPrevented` —— 别人已经处理过，不重复；
     *  · `inEditor` —— CM6 keymap 自己管（面板在 capture 阶段插手会跑两遍）；
     *  · `inInput` —— 输入框里打字不能被抢；
     *  · `inControl` —— 焦点在按钮上时字母键不抢（否则「点过 ▶ 再按 a」凭空插一格），
     *    但 `global` 上下文（Esc / 保存）照常生效。
     *
     * @returns {null|{command:string, binding:object}}
     */
    function decideCommandKey(state) {
      const s = state || {}
      if (s.defaultPrevented) return null
      if (!s.key) return null
      for (const binding of KEYBINDINGS) {
        if (!bindingMatches(binding, s)) continue
        if (binding.context === "command") {
          if (s.inEditor || s.inInput || s.inControl) return null
        }
        // 两段式删除：第一次只「上膛」
        const command = binding.twoStep ? (s.pendingDelete ? binding.command : "cell.deleteArmed") : binding.command
        return { command, binding }
      }
      return null
    }

    /**
     * Shift-Enter 跑完之后焦点去哪（纯函数）。
     *
     * VS Code 语义：运行并选中下一格；**已经在最后一格就自动补一格**（否则用户会觉得
     * 「按了没反应」—— 这正是本轮反馈里的一条）。
     * @returns {{kind:"focus", id:string}|{kind:"append-and-focus", afterId:string|null}}
     */
    function nextRunTarget(cells, index) {
      const list = Array.isArray(cells) ? cells : []
      const i = Number(index)
      if (!Number.isInteger(i) || i < 0 || i >= list.length) {
        const last = list.length ? list[list.length - 1] : null
        return { kind: "append-and-focus", afterId: last && last.id ? last.id : null }
      }
      const next = list[i + 1]
      if (next && next.id) return { kind: "focus", id: next.id }
      const cur = list[i]
      return { kind: "append-and-focus", afterId: cur && cur.id ? cur.id : null }
    }

    /** 事件落点是不是「用户正在打字的输入框」（Enter 组合一律让给它）。 */
    function isTextEntryTarget(el) {
      if (!el) return false
      const tag = String(el.tagName || "").toUpperCase()
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
      if (el.isContentEditable) return true
      if (typeof el.closest === "function") {
        try {
          if (el.closest("[contenteditable='true']")) return true
        } catch {
          /* ignore */
        }
      }
      return false
    }

    // ─────────────── markdown 渲染（marked + DOMPurify，带兜底） ───────────────

    /** 消毒配置：三个禁标签 + 三个禁属性。测试断言它被**原样**传给 sanitize。 */
    const SANITIZE_CFG = {
      FORBID_TAGS: ["script", "iframe", "style"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
    }

    /** 超过这个体积的 markdown 格直接显示源码：marked.parse 是同步全量解析，会卡住主线程。 */
    const MD_RAW_LIMIT = 100 * 1024

    function escapeHtml(text) {
      return String(text == null ? "" : text).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
      )
    }

    /**
     * 能不能走 marked + DOMPurify 这条路 —— **两个都必须有**。
     *
     * ⚠️ 最高危项：`CM.DOMPurify` 在无 DOM 环境里是**工厂函数而不是实例**
     * （实测 `sanitize === undefined`）。只有 `sanitize` 真是函数才允许产出原始 HTML；
     * 否则必须退回 `markdownLite`（纯 React h() 构造，天然安全）。
     */
    function canUseMarkedHtml(CM) {
      return !!(
        CM &&
        CM.marked &&
        typeof CM.marked.parse === "function" &&
        CM.DOMPurify &&
        typeof CM.DOMPurify.sanitize === "function"
      )
    }

    /** 有消毒器才允许把 HTML 塞进 dangerouslySetInnerHTML（KaTeX 产物也一并过一遍）。 */
    function canInjectHtml(CM) {
      return !!(CM && CM.DOMPurify && typeof CM.DOMPurify.sanitize === "function")
    }

    /**
     * 消毒一段 HTML。
     * @returns {string|null} `null` = 拿不到消毒器或消毒抛错 → **调用方必须退回纯文本/h() 构造**
     */
    function sanitizeHtml(html, CM) {
      const s = String(html == null ? "" : html)
      if (!s) return ""
      if (!canInjectHtml(CM)) return null
      try {
        const out = CM.DOMPurify.sanitize(s, SANITIZE_CFG)
        return out == null ? null : String(out)
      } catch {
        return null
      }
    }

    /** 相对图片路径归一：去掉前导 ./ 与 /，反斜杠统一成 /（服务端按 notebook 目录解析）。 */
    function normalizeRelSrc(url) {
      return String(url == null ? "" : url)
        .trim()
        .replace(/\\/g, "/")
        .replace(/^(?:\.\/|\/)+/, "")
    }

    /**
     * 把 HTML 里相对路径的 `<img src>` 改写成 `/nb2/file?sid=&path=`。
     *
     * `base` **不再由客户端传**（安全修正）：服务端按 sid 找到当前 notebook 的目录，
     * `path` 只允许相对该目录，因此既没有越界风险，也不需要客户端拼绝对路径。
     * `http/https/data:/nb2/`（以及 `//cdn`、`#anchor`）原样保留。
     */
    function rewriteImgSrc(html, opts) {
      const sid = String((opts && opts.sid) || "default") || "default"
      const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/nb2\/|#)/i
      return String(html == null ? "" : html).replace(/<img\b[^>]*>/gi, (tag) =>
        tag.replace(/(\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i, (whole, prefix, dq, sq, bare) => {
          const url = dq != null ? dq : sq != null ? sq : bare
          if (!url || absolute.test(String(url).trim())) return whole
          const rel = normalizeRelSrc(url)
          if (!rel) return whole
          return `${prefix}"/nb2/file?sid=${encodeURIComponent(sid)}&path=${encodeURIComponent(rel)}"`
        }),
      )
    }

    /**
     * 把 markdownLite 产出的 React 节点序列化成 HTML 字符串。
     *
     * 为什么需要：`renderMarkdown` 的契约是「返回纯字符串 HTML」，而兜底路径是
     * `markdownLite`（返回 React 节点）。序列化让兜底也走**同一条**可测管线。
     * 安全：所有文本都过 `escapeHtml`；只有 `dangerouslySetInnerHTML.__html` 原样透传
     * （那是 KaTeX 自产 markup，且注入点已由 canInjectHtml 把关）。
     */
    function mdNodesToHtml(nodes) {
      const ser = (node) => {
        if (node == null || typeof node === "boolean") return ""
        if (typeof node === "string") return escapeHtml(node)
        if (typeof node === "number") return escapeHtml(String(node))
        if (Array.isArray(node)) return node.map(ser).join("")
        if (typeof node !== "object") return escapeHtml(String(node))
        const type = node.type
        if (typeof type !== "string") {
          return ser(node.props && node.props.children !== undefined ? node.props.children : node.children)
        }
        const props = node.props || {}
        const kids = props.children !== undefined ? props.children : node.children
        const attrs = []
        for (const key of Object.keys(props)) {
          if (key === "key" || key === "children" || key === "dangerouslySetInnerHTML") continue
          const val = props[key]
          if (val == null || val === false) continue
          if (key === "style" && typeof val === "object") {
            const css = Object.keys(val)
              .filter((k) => val[k] != null && val[k] !== "")
              .map((k) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${String(val[k])}`)
              .join(";")
            if (css) attrs.push(` style="${escapeHtml(css)}"`)
            continue
          }
          if (val === true) {
            attrs.push(` ${key}`)
            continue
          }
          attrs.push(` ${key}="${escapeHtml(String(val))}"`)
        }
        const inner =
          props.dangerouslySetInnerHTML && typeof props.dangerouslySetInnerHTML.__html === "string"
            ? props.dangerouslySetInnerHTML.__html
            : ser(kids)
        return `<${type}${attrs.join("")}>${inner}</${type}>`
      }
      return (Array.isArray(nodes) ? nodes : [nodes]).map(ser).join("")
    }

    /** md cell 太大就先显示源码（短路，避免 marked.parse 卡主线程）。 */
    function shouldRenderRawMd(src) {
      return String(src == null ? "" : src).length > MD_RAW_LIMIT
    }

    /**
     * 渲染结果缓存：marked.parse 是同步全量解析，App 级 setState 会让所有 md 格重渲染，
     * 不缓存的话「随便动一下（选中/滚动/运行）整本 md 重解析一遍」。
     * LRU（Map 插入序 + 命中后重新插入），上限 200；超大文本不进缓存（占内存不值）。
     */
    const mdCache = new Map()
    const MD_CACHE_MAX = 200
    const MD_CACHE_MAX_CHARS = 20000

    function mdCacheGet(key) {
      if (!mdCache.has(key)) return undefined
      const value = mdCache.get(key)
      mdCache.delete(key)
      mdCache.set(key, value)
      return value
    }

    function mdCacheSet(key, value) {
      mdCache.set(key, value)
      while (mdCache.size > MD_CACHE_MAX) {
        const oldest = mdCache.keys().next()
        if (oldest.done) break
        mdCache.delete(oldest.value)
      }
    }

    /** 清空渲染缓存（测试用；也方便热重载后强制重算）。 */
    function clearMdCache() {
      mdCache.clear()
    }

    /**
     * markdown 源码 → **已消毒的 HTML 字符串**。
     *
     * 管线：marked.parse（GFM + KaTeX，markdownLite 做不到表格/任务列表/嵌套列表/分割线）
     *   → 相对图片改写（/nb2/file?sid=&path=）
     *   → DOMPurify.sanitize(SANITIZE_CFG)。
     * 任何一环缺失（没有 marked、没有消毒器、解析抛错）都退回 `markdownLite` 节点序列化，
     * **绝不**在无消毒器的情况下产出原始 HTML。
     */
    function renderMarkdown(src, opts) {
      const options = opts || {}
      const CM = options.CM || null
      const sid = String(options.sid || "default") || "default"
      const text = String(src == null ? "" : src)
      if (!text.trim()) return ""
      if (shouldRenderRawMd(text)) return `<pre class="nb2-md-raw">${escapeHtml(text)}</pre>`
      if (!canUseMarkedHtml(CM)) return mdNodesToHtml(markdownLite(text, CM))
      const cacheable = text.length <= MD_CACHE_MAX_CHARS
      const key = `${sid}\u0000${text.length}\u0000${text}`
      if (cacheable) {
        const hit = mdCacheGet(key)
        if (hit !== undefined) return hit
      }
      let html
      try {
        html = String(CM.marked.parse(text))
      } catch {
        return mdNodesToHtml(markdownLite(text, CM))
      }
      // 先改写再消毒：这样进入 DSH 页面的**每一段** HTML 都过了 sanitize
      const clean = sanitizeHtml(rewriteImgSrc(html, { sid }), CM)
      if (clean === null) return mdNodesToHtml(markdownLite(text, CM))
      if (cacheable) mdCacheSet(key, clean)
      return clean
    }

    /**
     * 从点击位置粗略估算 markdown 源码的行号（P1 5.7：进编辑后光标落在点击的大致位置）。
     * 纯函数：只吃 clientY / 容器矩形 / 总行数。
     */
    function estimateMdLine(input) {
      const s = input || {}
      const total = Math.max(1, Number(s.totalLines) || 1)
      const lineHeight = Math.max(1, Number(s.lineHeight) || 21)
      const rel = Number(s.clientY) - Number(s.rectTop)
      if (!(rel > 0)) return 1
      return Math.max(1, Math.min(total, Math.floor(rel / lineHeight) + 1))
    }

    // ─────────────── 大纲 v2（md 标题 + Python 符号，建树） ───────────────

    /** 去掉标题里的行内 markdown 记号（`code` / **bold**），大纲只显示文字。 */
    function headingPlainText(text) {
      return String(text == null ? "" : text)
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\*\*([^*]*)\*\*/g, "$1")
        .replace(/__([^_]*)__/g, "$1")
        .trim()
    }

    function firstLineOf(src) {
      const first = String(src || "")
        .split("\n")
        .find((l) => l.trim())
      return first ? first.trim().slice(0, 80) : ""
    }

    /**
     * markdown 标题抽取。
     *
     * 有 marked 就用 **lexer**：ATX 与 setext（`===`/`---`）都产出 `{type:"heading"}`，
     * 围栏代码里的 `#` 天然不会变成标题（不用自己写状态机）。行号靠累计 `raw` 长度换算。
     * 没有 marked 才退化成正则（同样支持 setext、同样跳过围栏）。
     */
    function gatherHeadings(src, CM) {
      const text = String(src == null ? "" : src)
      const out = []
      if (!text.trim()) return out
      const M = CM && CM.marked
      if (M && typeof M.lexer === "function") {
        let tokens = null
        try {
          tokens = M.lexer(text)
        } catch {
          tokens = null
        }
        if (Array.isArray(tokens)) {
          let line = 1
          for (const tok of tokens) {
            if (tok && tok.type === "heading") {
              out.push({
                kind: "heading",
                level: Math.max(1, Math.min(6, Number(tok.depth) || 1)),
                text: headingPlainText(tok.text) || "(无标题)",
                line,
              })
            }
            const raw = String((tok && tok.raw) || "")
            for (let i = 0; i < raw.length; i += 1) if (raw.charCodeAt(i) === 10) line += 1
          }
          return out
        }
      }
      return regexHeadings(text)
    }

    /** 无 marked 时的标题兜底：ATX + setext，跳过 ``` / ~~~ 围栏。 */
    function regexHeadings(src) {
      const lines = String(src == null ? "" : src).split("\n")
      const out = []
      let fence = ""
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
        if (f) {
          const mark = f[1][0]
          if (!fence) fence = mark
          else if (fence === mark) fence = ""
          continue
        }
        if (fence) continue
        const atx = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (atx) {
          out.push({ kind: "heading", level: atx[1].length, text: headingPlainText(atx[2]) || "(无标题)", line: i + 1 })
          continue
        }
        const next = lines[i + 1]
        if (line.trim() && next && /^\s{0,3}(=+|-+)\s*$/.test(next)) {
          out.push({
            kind: "heading",
            level: next.trim()[0] === "=" ? 1 : 2,
            text: headingPlainText(line) || "(无标题)",
            line: i + 1,
          })
          i += 1
        }
      }
      return out
    }

    /**
     * Python 函数/类符号抽取（@lezer/python）。
     *
     * 实测要点（docs/plans §7.4）：
     *  · 定义节点 `FunctionDefinition` / `ClassDefinition` 的 span **含整个函数体**，
     *    所以嵌套层级只能靠「父 start <= 子 start 且父 end >= 子 end」的包含关系（维护一个栈）；
     *  · 名字取该节点内**第一个 VariableName 子节点**（`def broken(:` 这种语法错误也能拿到）；
     *  · 行号 = `src.slice(0, from)` 里 `\n` 的个数 + 1（这里用单调游标，整体 O(n)）；
     *  · `async def` 仍是 FunctionDefinition，靠节点文本前缀判断。
     */
    function gatherPythonSymbols(src, CM) {
      const text = String(src == null ? "" : src)
      const P = CM && CM.pythonParser
      const roots = []
      if (!P || typeof P.parse !== "function" || !text.trim()) return roots
      let tree = null
      try {
        tree = P.parse(text)
      } catch {
        return roots
      }
      if (!tree || typeof tree.iterate !== "function") return roots
      const stack = []
      let scanPos = 0
      let scanLine = 1
      const lineOf = (pos) => {
        while (scanPos < pos && scanPos < text.length) {
          if (text.charCodeAt(scanPos) === 10) scanLine += 1
          scanPos += 1
        }
        return scanLine
      }
      const isDefinition = (name) => name === "FunctionDefinition" || name === "ClassDefinition"
      const nameOf = (node) => node.name || (node.type && node.type.name) || ""
      try {
        tree.iterate({
          enter(node) {
            const name = nameOf(node)
            if (isDefinition(name)) {
              const item = {
                kind: "symbol",
                level: stack.length + 1,
                name: "",
                text: "",
                symbol: name === "ClassDefinition" ? "class" : "function",
                isAsync: text.slice(node.from).startsWith("async"),
                from: node.from,
                to: node.to,
                line: lineOf(node.from),
                children: [],
              }
              if (stack.length) stack[stack.length - 1].children.push(item)
              else roots.push(item)
              stack.push(item)
              return
            }
            if (name === "VariableName" && stack.length) {
              const top = stack[stack.length - 1]
              if (!top.name) {
                top.name = text.slice(node.from, node.to)
                top.text = top.name
              }
            }
          },
          leave(node) {
            if (!isDefinition(nameOf(node))) return
            // 只弹出真正对应的那一层（语法错误时 lezer 会给出更长的「恢复用」节点）
            if (stack.length && stack[stack.length - 1].from === node.from) stack.pop()
          },
        })
      } catch {
        return roots // 语法树异常时退回已抽到的部分：大纲绝不能因为一个坏 cell 整体失败
      }
      return roots
    }

    /**
     * 大纲 v2：md 各级标题 + Python 函数/类定义，按包含关系建树。
     *
     * @returns {Array<{kind:"heading"|"symbol"|"cell", level, text, cellId, index, line, children}>}
     */
    function buildOutlineV2(cells, opts) {
      const CM = (opts && opts.CM) || null
      const roots = []
      /** 打开中的标题栈（跨 cell 延续，和真正的文档大纲一致） */
      const headingStack = []
      const pushUnderHeadings = (node) => {
        if (headingStack.length) headingStack[headingStack.length - 1].children.push(node)
        else roots.push(node)
      }
      for (let index = 0; index < (cells || []).length; index += 1) {
        const cell = cells[index]
        if (!cell || !cell.id) continue
        const type = normalizeCellType(cell.cellType)
        const src = String(cell.source || "")
        if (type === "markdown") {
          const heads = gatherHeadings(src, CM)
          if (!heads.length) {
            // 没有标题的 md 格也给一个定位项，否则「纯 md 文档」在大纲里是空的
            pushUnderHeadings({
              kind: "cell",
              level: 1,
              text: firstLineOf(src) || "(空 markdown)",
              cellId: cell.id,
              index,
              line: 1,
              type,
              children: [],
            })
            continue
          }
          for (const head of heads) {
            const node = {
              kind: "heading",
              level: head.level,
              text: head.text,
              cellId: cell.id,
              index,
              line: head.line,
              children: [],
            }
            while (headingStack.length && headingStack[headingStack.length - 1].level >= node.level) headingStack.pop()
            if (headingStack.length) headingStack[headingStack.length - 1].children.push(node)
            else roots.push(node)
            headingStack.push(node)
          }
          continue
        }
        const symbols = type === "code" ? gatherPythonSymbols(src, CM) : []
        if (symbols.length) {
          const decorate = (node) => ({
            kind: "symbol",
            level: node.level,
            text: `${node.symbol === "class" ? "class" : node.isAsync ? "async def" : "def"} ${node.name || "(匿名)"}`,
            cellId: cell.id,
            index,
            line: node.line,
            symbol: node.symbol,
            isAsync: node.isAsync,
            children: (node.children || []).map(decorate),
          })
          for (const sym of symbols) pushUnderHeadings(decorate(sym))
          continue
        }
        // 没有符号（或没有解析器）→ 用首行兜底，保证「大半是代码的 notebook」大纲不为空
        pushUnderHeadings({
          kind: "cell",
          level: 1,
          text: firstLineOf(src) || (type === "raw" ? "(raw)" : "(空)"),
          cellId: cell.id,
          index,
          line: 1,
          type,
          children: [],
        })
      }
      return roots
    }

    /** 大纲节点的稳定 key（折叠状态用）。 */
    function outlineNodeKey(node, depth) {
      return `${node.cellId}:${node.line}:${depth}:${node.text}`
    }

    /** 子树里有没有命中过滤词（命中子节点时父节点要保留，否则过滤后丢层级）。 */
    function outlineSubtreeMatches(node, query) {
      const q = String(query || "").toLowerCase()
      if (!q) return false
      if (String(node.text || "").toLowerCase().includes(q)) return true
      for (const child of node.children || []) if (outlineSubtreeMatches(child, q)) return true
      return false
    }

    /**
     * 大纲树 → 可见行（过滤 + 折叠摊平，纯函数）。
     * @returns {Array<{node, depth, key, hasChildren, open}>}
     */
    function outlineRows(nodes, opts) {
      const options = opts || {}
      const q = String(options.query || "").trim().toLowerCase()
      const folded = options.collapsed || {}
      const rows = []
      const walk = (list, depth) => {
        for (const node of list || []) {
          const selfHit = !q || String(node.text || "").toLowerCase().includes(q)
          if (q && !selfHit && !outlineSubtreeMatches(node, q)) continue
          const key = outlineNodeKey(node, depth)
          const hasChildren = !!(node.children && node.children.length)
          const open = !folded[key]
          rows.push({ node, depth, key, hasChildren, open })
          // 过滤时默认展开（否则命中的子节点被折叠状态藏起来，用户以为没搜到）
          if (hasChildren && (open || q)) walk(node.children, depth + 1)
        }
      }
      walk(nodes, 1)
      return rows
    }

    // ─────────────── md 标题折叠（VS Code Notebook 的「章节折叠」） ───────────────

    /**
     * 这一格是不是「可折叠的章节头」，返回标题级别（1–6），不是就 0。
     *
     * 判定只看**首个非空行**（与 VS Code 一致：一格 markdown 按它开头那个标题的级别折叠）：
     *   · ATX：`# 标题` —— `#` 后面必须有空白，`#标签` / `#include` 不算标题；
     *   · Setext：`标题` + 下一行 `===` / `---`（CommonMark 里这就是一级/二级标题）。
     * 首行是围栏/引用/列表/缩进代码时直接返回 0，别把 ```` ``` ```` 里的 `#` 当标题。
     *
     * @param {{id?:string, cellType?:string, source?:string}} cell
     * @returns {number} 0 = 不可折叠
     */
    function mdHeadingLevel(cell) {
      if (!cell) return 0
      const type = normalizeCellType(cell.cellType || cell.type || "code")
      if (type !== "markdown") return 0
      return mdHeadingLevelOfSource(cell.source != null ? cell.source : cell.code)
    }

    /** 纯文本版的标题识别（不碰 cell 形状，单测直接喂字符串）。 */
    function mdHeadingLevelOfSource(source) {
      const lines = String(source == null ? "" : source).split(/\r?\n/)
      let i = 0
      while (i < lines.length && !lines[i].trim()) i += 1
      if (i >= lines.length) return 0
      const first = lines[i]
      const atx = /^\s{0,3}(#{1,6})\s+\S/.exec(first)
      if (atx) return atx[1].length
      // 首行是围栏/引用/列表/缩进代码 → 它不是标题，下一行的 `---` 也只是分隔线
      if (/^\s{0,3}(```|~~~|>|\s*[-*+]\s|\d+[.)]\s)/.test(first)) return 0
      if (/^\s{0,3}=+\s*$/.test(lines[i + 1] || "")) return 1
      if (/^\s{0,3}-{2,}\s*$/.test(lines[i + 1] || "")) return 2
      return 0
    }

    /**
     * 计算「谁被折叠藏起来了」（纯函数，有单测）。
     *
     * 规则对齐 VS Code Notebook：
     *  · 折叠一个 level=N 的标题格 → 它**之后**的格全部隐藏，直到下一个 level<=N 的标题；
     *  · 标题格自己永远可见（折的是它下面那一节，不是它自己）；
     *  · 嵌套靠「外层折叠范围天然包含内层」生效，内层的折叠状态**保留** ——
     *    展开外层后内层回到原样，而不是被顺手清掉。
     *
     * @param {Array} cells 文档顺序
     * @param {Set<string>|string[]} [collapsed] 已折叠的标题格 id
     * @returns {{hidden:Set<string>, sections:Array<{cellId:string,index:number,level:number,end:number,hiddenCount:number}>, sectionOf:Map, indexOf:Map}}
     */
    function foldSections(cells, collapsed) {
      const list = Array.isArray(cells) ? cells : []
      const foldedKeys = collapsed instanceof Set ? collapsed : new Set(Array.isArray(collapsed) ? collapsed : [])
      const indexOf = new Map()
      for (let i = 0; i < list.length; i += 1) {
        const cell = list[i]
        if (cell && cell.id) indexOf.set(cell.id, i)
      }
      const sections = []
      const sectionOf = new Map()
      for (let i = 0; i < list.length; i += 1) {
        const level = mdHeadingLevel(list[i])
        if (!level) continue
        // 这一节到哪里结束：下一个 level<=N 的标题之前
        let end = list.length - 1
        for (let j = i + 1; j < list.length; j += 1) {
          const lv = mdHeadingLevel(list[j])
          if (lv && lv <= level) {
            end = j - 1
            break
          }
        }
        const cellId = (list[i] && list[i].id) || ""
        const section = { cellId, index: i, level, end, hiddenCount: Math.max(0, end - i) }
        sections.push(section)
        if (cellId) sectionOf.set(cellId, section)
      }
      const hidden = new Set()
      for (const section of sections) {
        if (!section.cellId || !foldedKeys.has(section.cellId)) continue
        for (let k = section.index + 1; k <= section.end; k += 1) {
          const cell = list[k]
          if (cell && cell.id) hidden.add(cell.id)
        }
      }
      return { hidden, sections, sectionOf, indexOf }
    }

    /** JSON → 可折叠树（details/summary，浏览器原生折叠，零依赖）。 */
    function jsonTree(value, depth) {
      const d = depth || 0
      if (value === null) return h("span", { style: { color: "#b0b0b0" } }, "null")
      if (typeof value === "number" || typeof value === "boolean") return h("span", { style: { color: "#8ec07c" } }, String(value))
      if (typeof value === "string") return h("span", { style: { color: "#e0b34a" } }, JSON.stringify(value))
      const isArray = Array.isArray(value)
      const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value || {})
      if (!entries.length) return h("span", { style: { opacity: 0.6 } }, isArray ? "[]" : "{}")
      if (d >= 6) return h("span", { style: { opacity: 0.6 } }, isArray ? `Array(${entries.length})` : `Object(${entries.length})`)
      return h(
        "details",
        { open: d < 2, style: { marginLeft: d ? 10 : 0 } },
        h("summary", { style: { cursor: "pointer", opacity: 0.75, fontFamily: FONT_MONO, fontSize: 11 } }, isArray ? `Array(${entries.length})` : `Object(${entries.length})`),
        h(
          "div",
          { style: { marginLeft: 10, borderLeft: "1px solid var(--dsw-alias-border-l2,#333)", paddingLeft: 8 } },
          entries.map(([k, v]) =>
            h(
              "div",
              { key: String(k), style: { fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: 1.6 } },
              h("span", { style: { color: "#79c0ff" } }, String(k)),
              h("span", { style: { opacity: 0.5 } }, ": "),
              jsonTree(v, d + 1),
            ),
          ),
        ),
      )
    }

    // ───────────────────────── vendor 加载 ─────────────────────────

    let vendorPromise = null
    function loadVendor() {
      if (typeof window === "undefined") return Promise.resolve(null)
      if (window.CM) return Promise.resolve(window.CM)
      if (vendorPromise) return vendorPromise
      vendorPromise = new Promise((resolve) => {
        const s = document.createElement("script")
        s.src = "/nb2/vendor.js"
        s.async = true
        s.onload = () => resolve(window.CM || null)
        s.onerror = () => resolve(null)
        document.head.appendChild(s)
      })
      return vendorPromise
    }

    function useVendor() {
      const [CM, setCM] = React.useState(typeof window !== "undefined" ? window.CM || null : null)
      React.useEffect(() => {
        let alive = true
        loadVendor().then((cm) => {
          if (alive && cm) setCM(cm)
        })
        return () => {
          alive = false
        }
      }, [])
      return CM
    }

    // ───────────────────────── markdown 视觉（作用域 CSS） ─────────────────────────

    /**
     * md 渲染区的作用域样式。
     *
     * 为什么是字符串而不是 React 行内样式：`h1–h6` 阶梯字号、`:hover`、`nth-child` 斑马纹、
     * `::selection`、“任务列表去掉圆点”这些**没法**写成 dangerouslySetInnerHTML 元素的行内样式。
     * 只注入一次（id 兜底幂等，热重载/多实例都只会插一份），与 ensureGlobalCss 同一套做法。
     *
     * 判据（docs/plans §8.2）：h1–h6 是**阶梯**而不是 h6=8px；表格有边框 + 斑马纹；
     * 任务列表无圆点；嵌套列表缩进；引用块左边线；代码块背景；分割线；图片 max-width:100%。
     */
    const nb2MdCss = [
      // 标题阶梯：1.6 → 0.92（旧 markdownLite 是 20-level*2 像素，h6 只有 8px 几乎看不见）
      ".nb2-md h1,.nb2-md h2,.nb2-md h3,.nb2-md h4,.nb2-md h5,.nb2-md h6{margin:.75em 0 .35em;font-weight:650;line-height:1.3}",
      ".nb2-md h1{font-size:1.6em}",
      ".nb2-md h2{font-size:1.38em}",
      ".nb2-md h3{font-size:1.22em}",
      ".nb2-md h4{font-size:1.1em}",
      ".nb2-md h5{font-size:1em}",
      ".nb2-md h6{font-size:.92em;opacity:.85}",
      ".nb2-md h1:first-child,.nb2-md h2:first-child,.nb2-md p:first-child{margin-top:0}",
      ".nb2-md p{margin:.5em 0;line-height:1.68}",
      // 列表 + 嵌套缩进（旧实现没有嵌套，子列表被拍平）
      ".nb2-md ul,.nb2-md ol{margin:.4em 0;padding-left:1.6em}",
      ".nb2-md li{margin:.16em 0;line-height:1.62}",
      ".nb2-md li>ul,.nb2-md li>ol{margin:.16em 0;padding-left:1.25em}",
      ".nb2-md li>p{margin:.16em 0}",
      // 任务列表：去掉圆点（marked 输出 <li><input type=checkbox disabled>）
      '.nb2-md ul:has(>li>input[type="checkbox"]){list-style:none;padding-left:1.15em}',
      '.nb2-md li>input[type="checkbox"]{margin:0 .4em 0 0;vertical-align:middle;cursor:default}',
      // 表格：边框 + 表头底色 + 斑马纹 + 横向滚动（宽表不该撑破侧栏）
      ".nb2-md table{border-collapse:collapse;margin:.6em 0;font-size:.94em;display:block;overflow-x:auto;max-width:100%}",
      ".nb2-md th,.nb2-md td{border:1px solid var(--dsw-alias-border-l2,#3a3a3a);padding:3px 8px;text-align:left;vertical-align:top}",
      ".nb2-md thead th{background:color-mix(in srgb,currentColor 7%,transparent);font-weight:650}",
      ".nb2-md tbody tr:nth-child(even){background:color-mix(in srgb,currentColor 3.5%,transparent)}",
      // 引用块：左边线（旧实现有，但配色/间距统一到令牌）
      ".nb2-md blockquote{margin:.55em 0;padding:.1em 0 .1em .8em;border-left:3px solid var(--dsw-alias-border-l2,#3a3a3a);opacity:.92}",
      ".nb2-md blockquote>p{margin:.2em 0}",
      // 代码块：底色 + 等宽 + 可横滚；行内 code 不换底色块
      ".nb2-md pre{margin:.55em 0;padding:8px 10px;overflow:auto;border-radius:4px;background:color-mix(in srgb,currentColor 6%,transparent);font-size:.92em;line-height:1.55}",
      ".nb2-md pre code{background:transparent;padding:0;border-radius:0;font-size:1em}",
      ".nb2-md code{font-family:" + FONT_MONO + ";background:color-mix(in srgb,currentColor 9%,transparent);border-radius:3px;padding:0 3px;font-size:.94em}",
      // 分割线
      ".nb2-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l2,#3a3a3a);margin:1em 0}",
      // 链接 + 图片（相对路径已改写成 /nb2/file?sid=&path=）
      ".nb2-md a{color:" + ACCENT + ";text-decoration:none}",
      ".nb2-md a:hover{text-decoration:underline}",
      ".nb2-md img{max-width:100%;height:auto;border-radius:4px;vertical-align:top}",
      ".nb2-md del{opacity:.7}",
      // 纯文本兜底（md cell >100KB 时显示源码）
      ".nb2-md-raw{white-space:pre-wrap;word-break:break-word;font-family:" + FONT_MONO + ";font-size:.92em;margin:0}",
      // KaTeX：display 公式单独一行可横滚
      ".nb2-md .katex-display{margin:.55em 0;overflow-x:auto;overflow-y:hidden}",
      // 输出块 hover 复制按钮（行内样式做不了 :hover）
      ".nb2-out{position:relative}",
      ".nb2-out-copy{position:absolute;right:5px;top:2px;z-index:1;opacity:0;transition:opacity .12s ease;cursor:pointer;" +
        "border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#222);color:inherit;" +
        "border-radius:4px;font-size:10px;line-height:1;padding:2px 4px;font-family:" + FONT_MONO + "}",
      ".nb2-out:hover .nb2-out-copy{opacity:1}",
      // 格间新增热区
      ".nb2-divider:hover button{opacity:1}",
    ].join("\n")

    /** 注入一份全局样式（id 幂等）。 */
    function ensureStyleOnce(id, css) {
      if (typeof document === "undefined" || !document.head) return false
      if (document.getElementById(id)) return false
      const el = document.createElement("style")
      el.id = id
      el.textContent = css
      document.head.appendChild(el)
      return true
    }

    /** md 作用域样式只注入一次。 */
    function ensureMdCss() {
      return ensureStyleOnce("nb2-md-style", nb2MdCss)
    }

    /**
     * KaTeX 样式表：**JS 在 vendor 里但没有 CSS**，所以公式必然错版（没有字体/间距）。
     * 由宿主半从 `lib/katex/` 提供（字体已 base64 内联进 CSS），这里只插一次 `<link>`。
     * 失败静默：样式加载不到最多是公式丑，不该影响 notebook 使用。
     */
    function ensureKatexCss() {
      if (typeof document === "undefined" || !document.head) return false
      const id = "nb2-katex-css"
      if (document.getElementById(id)) return false
      const link = document.createElement("link")
      link.id = id
      link.rel = "stylesheet"
      link.href = "/nb2/katex.css"
      link.onerror = () => {
        /* 静默：拿不到 CSS 就只是公式排版退化 */
      }
      document.head.appendChild(link)
      return true
    }

    // ───────────────────────── markdown 渲染组件 ─────────────────────────

    /**
     * markdown 渲染视图（**双击**进编辑，单击只选中本格）。
     *
     * 两条路：
     *  · `CM` 同时有 marked + DOMPurify → `renderMarkdown()` 产出的**已消毒** HTML 走 innerHTML；
     *  · 否则 → `markdownLite()` 的 React 节点（纯 h() 构造，天然安全，**绝不用 innerHTML**）。
     */
    function MarkdownView(props) {
      const { source, CM, sid, cellId, onEdit, onSelect, onSelectionChange } = props || {}
      const text = String(source == null ? "" : source)
      const rich = canUseMarkedHtml(CM)
      const tooLarge = shouldRenderRawMd(text)
      const html = React.useMemo(() => (rich && !tooLarge ? renderMarkdown(text, { CM, sid }) : ""), [text, CM, sid, rich, tooLarge])
      /**
       * ⚠️ 只有「没有富渲染」**且**「没有超限」时才去算 markdownLite。
       * 超限格本来就是要直接显示源码的（短路），这里再跑一遍手写解析等于
       * 把刚刚省下来的主线程开销又花回去 —— 那正是 >100KB 短路要防的事。
       */
      const nodes = React.useMemo(() => (tooLarge || rich ? null : markdownLite(text, CM)), [text, CM, rich, tooLarge])

      const common = {
        className: "nb2-md",
        title: "双击编辑（Esc 退出）",
        style: { padding: "4px 10px 6px", cursor: "text", minHeight: 24 },
        /**
         * 单击只选中本格，**不进编辑**。
         *
         * 2026-11-10 用户要求：markdown 渲染态必须双击才进编辑。此前单击就进，
         * 想选文字、想问渲染出来的内容、想点链接，全被拽进编辑态。
         * 这里必须 `stopPropagation`：外层容器的 `resolveCellClick` 对「不在编辑器 /
         * 左槽位 / 控件 / 输出区」的落点一律返回 `"editor"` → 会立刻 `enterEdit()`，
         * 否则单击照样进编辑（把这句删掉就复现原行为）。
         */
        onClick: (e) => {
          e.stopPropagation()
          if (onSelect) onSelect(cellId)
        },
        /**
         * 双击才进编辑，光标落在双击处那一行（`estimateMdLine` 估算），不是永远回文首。
         * 双击的第二次点击也会走上面的 onClick（只选中），无害。
         */
        onDoubleClick: (e) => {
          e.stopPropagation()
          if (onSelect) onSelect(cellId)
          if (!onEdit) return
          const rect = e.currentTarget && e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null
          onEdit({
            line: estimateMdLine({
              clientY: e.clientY,
              rectTop: rect ? rect.top : 0,
              totalLines: text.split("\n").length,
            }),
          })
        },
        onMouseUp: () => {
          if (!onSelectionChange) return
          const info = readDomSelection()
          onSelectionChange(cellId, info ? info.selection : null, info ? info.coords : null, { kind: "markdown" })
        },
      }

      if (tooLarge) {
        return h("div", common, h("pre", { className: "nb2-md-raw", style: { ...preStyle, padding: 0, whiteSpace: "pre-wrap", margin: 0, background: "transparent" } }, text))
      }
      if (nodes) return h("div", common, nodes)
      return h("div", Object.assign({}, common, { dangerouslySetInnerHTML: { __html: html } }))
    }

    const dividerBtn = {
      border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
      background: "var(--dsw-alias-bg-layer-2,transparent)",
      color: "inherit",
      opacity: 0.9,
      cursor: "pointer",
      fontSize: 10,
      lineHeight: 1,
      padding: "2px 6px",
      borderRadius: 8,
      whiteSpace: "nowrap",
      fontFamily: FONT_UI,
    }

    /**
     * 格间新增热区：任意两格之间 + 列表末尾。
     *
     * 之前只有顶部工具栏的 `＋ 代码/＋ MD/＋ SH`，而且**只追加到末尾** ——
     * 想在中间插一格只能「先在末尾建，再一路点上移」。这里是 VS Code 的手感：
     * 鼠标移到两格之间就浮出「＋ 代码 / ＋ 文本」，点一下就地插入并聚焦新格。
     */
    function CellDivider(props) {
      const { onAdd, dim, position } = props || {}
      const [hover, setHover] = React.useState(false)
      return h(
        "div",
        {
          className: "nb2-divider",
          "data-nb2-divider": position || "between",
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            height: 10,
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            overflow: "hidden",
            opacity: hover ? 1 : dim ? 0.34 : 0,
            transition: "opacity .12s ease",
          },
        },
        h(
          "button",
          {
            type: "button",
            style: dividerBtn,
            title: "在此处插入代码单元格（Shift-Enter 可直接运行）",
            onClick: (e) => {
              e.stopPropagation()
              if (onAdd) onAdd("code")
            },
          },
          "＋ 代码",
        ),
        h(
          "button",
          {
            type: "button",
            style: dividerBtn,
            title: "在此处插入 Markdown 单元格",
            onClick: (e) => {
              e.stopPropagation()
              if (onAdd) onAdd("markdown")
            },
          },
          "＋ 文本",
        ),
      )
    }

    // ───────────────────────── Notebook picker ─────────────────────────

    function fmtBytes(n) {
      const v = Number(n) || 0
      if (v < 1024) return `${v}B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`
      return `${(v / 1024 / 1024).toFixed(1)}MB`
    }

    function fmtTime(ms) {
      const n = Number(ms) || 0
      if (!n) return ""
      const d = new Date(n)
      if (Number.isNaN(d.getTime())) return ""
      const pad = (x) => String(x).padStart(2, "0")
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** 过滤 picker 条目（大小写不敏感，匹配相对路径；只留目录 + .ipynb）。 */
    function filterEntries(entries, query) {
      const q = String(query || "").trim().toLowerCase()
      const list = (Array.isArray(entries) ? entries : []).filter(
        (e) => e && (e.dir || /\.ipynb$/i.test(String(e.rel || e.path || ""))),
      )
      if (!q) return list
      return list.filter((e) => String(e.rel || e.path || "").toLowerCase().includes(q))
    }

    /**
     * 路径中间省略：保留开头与结尾，中间打一个 `…`。
     *
     * 为什么不用 shortPath（只留尾两段）：picker 顶部要让人认出「我在哪一层」，
     * 盘符/工作区名在**开头**、当前子目录在**结尾**，两头都得留。纯函数、可测。
     */
    function middleEllipsis(text, max) {
      const s = String(text == null ? "" : text)
      const limit = Math.max(8, Math.trunc(Number(max)) || 46)
      if (s.length <= limit) return s
      // 尾部权重更大：用户更常靠结尾分辨目录
      const tail = Math.max(5, Math.floor((limit - 1) * 0.62))
      const head = Math.max(3, limit - 1 - tail)
      return s.slice(0, head) + "…" + s.slice(s.length - tail)
    }

    /** 反斜杠常量：源码里直接写正则转义太脆（多层转义一错就是静默的正则语义变化），用码点更稳。 */
    const PATH_BS = String.fromCharCode(92)

    /** 路径比较用的归一化 key（大小写不敏感 + 统一分隔符 + 去尾部分隔符）。Windows 上必须不敏感。 */
    function pathKey(p) {
      let s = String(p == null ? "" : p).split(PATH_BS).join("/")
      while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1)
      return s.toLowerCase()
    }

    /**
     * child 是否等于 parent、或在 parent 子树内（按分隔符边界比较，避免 a/bc 命中 a/b）。
     * 纯函数、可测；picker 的「↑ 上级不许越过工作区」靠它。
     */
    function isUnderPath(parent, child) {
      const p = pathKey(parent)
      const c = pathKey(child)
      if (!p || !c) return false
      return c === p || c.startsWith(p + "/")
    }

    /** 取父目录（保留原始分隔符风格）；已是根则返回自身。 */
    function parentPath(p) {
      let s = String(p == null ? "" : p)
      while (s.length > 1 && (s.endsWith("/") || s.endsWith(PATH_BS))) s = s.slice(0, -1)
      const cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf(PATH_BS))
      if (cut <= 0) return s
      return s.slice(0, cut)
    }

    /** AI 设置栏里两个下拉的共用样式（窄面板里必须能压缩，不能把面板撑宽）。 */
    const aiSelectStyle = {
      minWidth: 0,
      maxWidth: 180,
      flex: "1 1 120px",
      fontSize: 10.5,
      padding: "1px 4px",
      borderRadius: 3,
      border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
      background: "var(--dsw-alias-bg-layer-1,transparent)",
      color: "inherit",
    }

    const pickerInputStyle = {      flex: 1,
      minWidth: 0,
      fontFamily: FONT_MONO,
      fontSize: 11,
      padding: "2px 6px",
      borderRadius: 3,
      border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
      background: "var(--dsw-alias-bg-layer-1,transparent)",
      color: "inherit",
    }

    /**
     * picker 列表分组（纯函数）：**先 notebook，后目录**。
     *
     * 为什么必须分组（真机数据）：某个工作区里 .ipynb 是 0 个、目录有 500 条。
     * 混在一个列表里就是「一堆东西、一个都打不开」，用户只会以为又坏了；
     * 分成 Notebooks (n) / 目录 (n) 两节之后语义立刻清楚 —— 目录是**可进入的层级**，
     * 不是「搜索结果」。
     *
     * 单独成函数还有一个很实际的原因：React 桩里的 useState 无状态，
     * 组件树里驱动不到 data，抽成纯函数才测得到。
     * @returns {{notebooks:Array, dirs:Array, visible:Array}} visible = 两组拼接（＝键盘上下选的顺序）
     */
    function groupPickerEntries(entries, query) {
      const list = filterEntries(entries, query)
      const notebooks = list.filter((e) => !e.dir)
      const dirs = list.filter((e) => e.dir)
      return { notebooks, dirs, visible: notebooks.concat(dirs) }
    }

    /**
     * picker 里的一次按键该做什么（纯函数）。
     *
     * ⚠️ 这个函数存在的直接原因是一个**真 Bug**：早先 `NotebookPicker` 的 `onKeyDown`
     * 直接写 `list[active]` / `list.length`，而 `list` 只存在于 `groupPickerEntries`
     * 里（模块级私有），picker 作用域里根本没有它 —— 按 ↑/↓/Enter 会抛
     * `ReferenceError: list is not defined`，表现就是「键盘导航一点用都没有」。
     * 抽成纯函数后：① 作用域正确（用 count/active）；② 空列表不再越界；
     * ③ 判定矩阵可单测（见 test/client-logic.mjs）。
     *
     * @param {{key?:string, count?:number, active?:number}} state
     * @returns {{kind:"none"}|{kind:"close"}|{kind:"move",index:number}|{kind:"activate",index:number}}
     */
    function pickerKeyAction(state) {
      const s = state || {}
      const key = String(s.key == null ? "" : s.key)
      const n = Number(s.count)
      const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
      const a = Number(s.active)
      const active = Number.isFinite(a) ? Math.max(0, Math.floor(a)) : 0
      if (key === "Escape") return { kind: "close" }
      // 空列表：方向键/回车什么都不做（尤其不能让 Enter 去「打开 undefined」）
      if (!count) return { kind: "none" }
      const last = count - 1
      if (key === "ArrowDown") return { kind: "move", index: Math.min(last, active + 1) }
      if (key === "ArrowUp") return { kind: "move", index: Math.max(0, active - 1) }
      if (key === "Enter") return { kind: "activate", index: Math.max(0, Math.min(last, active)) }
      return { kind: "none" }
    }

    /** 空态文案（纯函数）：真机常态是「这个工作区本来就没有 notebook」，必须说清楚。 */
    function pickerEmptyText(dirOrCwd) {
      return "这个目录（" + String(dirOrCwd || "工作区") + "）下还没有 .ipynb"
    }

    /** 截断提示文案（纯函数）：宿主条目上限 500，本机实测会顶满。 */
    function pickerTruncatedText(shown) {
      return "（结果已截断，只显示前 " + (Number(shown) || 0) + " 条；可用搜索框过滤）"
    }

    /** 搜索无命中文案（纯函数）。 */
    function pickerNoMatchText(query) {
      return "没有匹配「" + String(query == null ? "" : query).trim() + "」的 notebook 或目录"
    }

    /**
     * 打开 notebook 的面板内浮层。
     *
     * 数据源 `GET /nb2/fs/list?sid=&dir=&depth=`（**不是** `/nb2/notebooks` —— 那条是
     * 「标签页列表」的既有契约）。默认目录 = 宿主给的会话工作目录（cwd），
     * 这就是用户要的「直接看工作区里的 notebook」，而不是让他手输绝对路径。
     * 手输路径降级成兜底入口（onManual）。
     */
    function NotebookPicker(props) {
      const { sid, initialDir, onOpen, onClose, onManual, onCreated } = props || {}
      const [dir, setDir] = React.useState(String(initialDir || ""))
      const [data, setData] = React.useState(null)
      const [query, setQuery] = React.useState("")
      const [sel, setSel] = React.useState(0)
      const [err, setErr] = React.useState("")
      const [loading, setLoading] = React.useState(false)
      const [creating, setCreating] = React.useState(false)
      /**
       * 搜索框 ref：**钻目录之后要把焦点抢回来**。
       * 之前点目录行（普通 div，不可聚焦）会把焦点甩到 `<body>`，于是
       * 「Esc 关不掉、↑↓ 没反应」—— 用户真机反馈的第 3 条就是这个。
       */
      const inputRef = React.useRef(null)

      /** 把焦点还给搜索框（下一帧；DOM 还没更新时 focus 会落到旧节点）。 */
      const scheduleRefocus = React.useCallback(() => {
        const focusIt = () => {
          try {
            if (inputRef.current && typeof inputRef.current.focus === "function") {
              inputRef.current.focus({ preventScroll: true })
            }
          } catch {
            /* ignore */
          }
        }
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusIt)
        else focusIt()
      }, [])

      const load = React.useCallback(
        (nextDir) => {
          setLoading(true)
          setErr("")
          const params = ["sid=" + encodeURIComponent(String(sid || "default"))]
          if (nextDir) params.push("dir=" + encodeURIComponent(String(nextDir)))
          fetch("/nb2/fs/list?" + params.join("&"), { cache: "no-store" })
            .then((r) => r.json())
            .then((json) => {
              if (!json || json.ok === false) throw new Error((json && json.error) || "列举失败")
              setData({
                dir: String(json.dir || nextDir || ""),
                root: String(json.root || json.dir || ""),
                cwd: String(json.cwd || ""),
                truncated: !!json.truncated,
                entries: Array.isArray(json.entries) ? json.entries : [],
              })
              setDir(String(json.dir || nextDir || ""))
              setSel(0)
              /**
               * 钻目录后把焦点抢回搜索框。
               * 点目录行＝点一个不可聚焦的 div → 焦点掉到 `<body>`，picker 根节点的
               * onKeyDown 再也收不到事件（Esc / ↑↓ / Enter 全哑）。抢回来之后
               * 「鼠标钻目录、键盘继续操作」这条混合路径才走得通。
               */
              scheduleRefocus()
            })
            .catch((e) => setErr(String((e && e.message) || e)))
            .finally(() => setLoading(false))
        },
        [sid],
      )

      // 首帧自动拉一次（dir 缺省 = 宿主侧的 defaultCwdFor(sid)）
      React.useEffect(() => {
        load(initialDir || "")
      }, [load, initialDir])

      const entries = data && data.entries ? data.entries : []
      const { notebooks, dirs, visible } = groupPickerEntries(entries, query)
      const active = Math.max(0, Math.min(sel, visible.length - 1))

      const cwd = (data && data.cwd) || ""
      // 顶部常驻显示「我现在的层级」：首屏是 cwd，钻子目录后是子目录
      const here = dir || cwd
      /**
       * 「↑ 上级」用 **cwd** 做闸，不能用 data.root：
       * 宿主 fs/list 返回的 root 是「本次 dir 的 realpath」= 当前目录自己，
       * 拿它比长度永远相等 → 按钮永远灰、进不了上级。cwd 才是工作区边界。
       */
      const canUp = !!here && !!cwd && pathKey(here) !== pathKey(cwd)

      const goUp = () => {
        if (!canUp) return
        const up = parentPath(here)
        // 不许越过工作区：算出来的父目录不在 cwd 之下就直接回 cwd
        load(isUnderPath(cwd, up) ? up : cwd)
      }

      const activate = (item) => {
        if (!item) return
        if (item.dir) {
          load(item.path || item.rel)
          return
        }
        // ⚠️ 传绝对路径：宿主 `notebook/open` 直接用 body.path 读文件，**不做 cwd 解析**
        if (onOpen) onOpen(item)
      }

      /** 空态里的「＋ 新建 notebook」：建一本空 notebook，然后让面板刷新并收掉 picker。 */
      const createNotebook = () => {
        if (creating) return
        setCreating(true)
        setErr("")
        post("notebook/new", { sid })
          .then((out) => {
            if (onCreated) onCreated(out)
            else if (onClose) onClose()
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setCreating(false))
      }

      /**
       * 列表行。两组共用一套渲染：分组头由外面给，行本身只管图标 / 路径 / 大小 / 时间。
       * activeIndex 就是它在 visible 里的下标（方向键与高亮都靠它）。
       */
      const row = (item, activeIndex) =>
        h(
          "div",
          {
            key: item.path || item.rel || String(activeIndex),
            title: item.path || item.rel,
            onClick: () => activate(item),
            onMouseEnter: () => setSel(activeIndex),
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              cursor: "pointer",
              background: activeIndex === active ? accentMix(18) : "transparent",
            },
          },
          h("span", { style: { flex: "none", opacity: 0.8 } }, item.dir ? "📁" : "📓"),
          h(
            "span",
            { style: { flex: 1, minWidth: 0, fontFamily: FONT_MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            String(item.rel || item.path || ""),
          ),
          item.dir ? null : h("span", { style: { flex: "none", opacity: 0.55, fontSize: 10 } }, fmtBytes(item.size)),
          h("span", { style: { flex: "none", opacity: 0.5, fontSize: 10, fontFamily: FONT_MONO } }, fmtTime(item.mtime)),
        )

      /** 小节标题（Notebooks (n) / 目录 (n)）。 */
      const sectionTitle = (text) =>
        h(
          "div",
          {
            style: {
              padding: "3px 8px 1px",
              fontSize: 10,
              letterSpacing: 0.4,
              opacity: 0.6,
              textTransform: "uppercase",
              borderTop: "1px solid color-mix(in srgb,currentColor 8%,transparent)",
            },
          },
          text,
        )


      return h(
        "div",
        {
          /**
           * 面板内浮层：**在流内**占据「标签条与 cell 列表之间」的位置。
           * 用 `position:absolute` 贴着面板根会更像浮层，但会把工具栏/标签条盖住
           * （✕ 和搜索框正好落在被盖住的区域，等于自废入口），偏移量又要跟着
           * 工具栏行数变 —— 不值。这里用「浮起的外观 + 在流内」：
           * 边框/阴影/抬升底色看起来是浮层，但不遮挡任何东西，cell 列表往下让位。
           *
           * `data-nb2-picker`：给 App 的「点击浮层外部即关闭」判定用（见 App 里
           * 那个 useEffect）。没有这个标记就只能靠 ref 穿透 React 组件边界，
           * 而 picker 是无状态函数组件、拿不到父级 ref。
           */
          "data-nb2-picker": "1",
          style: {
            flex: "none",
            zIndex: 40,
            maxHeight: "62vh",
            margin: "0 0 4px",
            display: "flex",
            flexDirection: "column",
            borderRadius: 8,
            border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
            background: "var(--dsw-alias-bg-layer-2,#1e1e1e)",
            boxShadow: "0 10px 30px rgba(0,0,0,.35)",
            fontSize: 11,
            overflow: "hidden",
          },
          onKeyDown: (e) => {
            const act = pickerKeyAction({ key: e.key, count: visible.length, active })
            if (act.kind === "none") return
            e.preventDefault()
            e.stopPropagation()
            if (act.kind === "close") {
              if (onClose) onClose()
              return
            }
            if (act.kind === "move") {
              setSel(act.index)
              return
            }
            activate(visible[act.index])
          },
        },
        // 头部：标题 + 当前目录（常驻，中间省略；title 给完整路径）
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2,#3a3a3a)" } },
          h("b", { style: { flex: "none", fontWeight: 650 } }, "打开 Notebook"),
          h(
            "span",
            {
              title: here || cwd || "",
              "data-nb2-picker-dir": "1",
              style: { flex: 1, minWidth: 0, opacity: 0.75, fontFamily: FONT_MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            },
            "📁 " + middleEllipsis(here || cwd || "", 46),
          ),
          /**
           * 常驻渲染、只是 disabled —— 而不是「dir 不是 cwd 才出现」：
           * 位置固定的按钮不会在导航时跳来跳去（用户刚想点它，它却移位了）。
           */
          h(
            "button",
            {
              type: "button",
              style: { ...miniBtn, opacity: canUp ? 0.9 : 0.35 },
              title: canUp ? "返回上一级" : "已经在工作区根目录",
              onClick: goUp,
              disabled: !canUp,
            },
            "↑ 上级",
          ),
          h("button", { type: "button", style: { ...miniBtn, opacity: 0.85 }, title: "重新列举", onClick: () => load(dir) }, "⟳"),
          h("button", { type: "button", style: { ...miniBtn, opacity: 0.9 }, title: "关闭 (Esc)", onClick: () => onClose && onClose() }, "✕"),
        ),
        // 搜索框
        h(
          "div",
          { style: { display: "flex", gap: 4, padding: "5px 8px" } },
          h("input", {
            ref: inputRef,
            autoFocus: true,
            value: query,
            placeholder: "搜索 notebook / 目录…",
            onChange: (e) => {
              setQuery(e.target.value)
              setSel(0)
            },
            onKeyDown: (e) => {
              // 没有匹配时回车不要"打开"任何东西
              if (e.key === "Enter" && visible.length === 0) e.stopPropagation()
            },
            style: pickerInputStyle,
          }),
        ),
        // 列表：两种分组 + 两种空态
        h(
          "div",
          { style: { overflow: "auto", flex: 1, minHeight: 40, borderTop: "1px solid color-mix(in srgb,currentColor 10%,transparent)" } },
          err
            ? h("div", { style: { padding: "6px 8px", color: "#ff9a9a" } }, "列举失败：" + err)
            : loading && !data
              ? h("div", { style: { padding: "8px", opacity: 0.6 } }, "读取中…")
              : notebooks.length === 0 && dirs.length === 0
                ? String(query || "").trim()
                  ? h("div", { style: { padding: "10px 8px", opacity: 0.65 } }, pickerNoMatchText(query))
                  : // ★ 真机常态：这个工作区本来就没有 .ipynb。必须说清楚并给出路，
                    //   否则用户看到的只是一片（或空白），会以为「又坏了」。
                    h(
                      "div",
                      { style: { padding: "12px 10px", display: "flex", flexDirection: "column", gap: 8 } },
                      h("div", { style: { opacity: 0.8, lineHeight: 1.6 } }, pickerEmptyText(here || cwd)),
                      h(
                        "div",
                        { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                        h(
                          "button",
                          { type: "button", style: { ...toolbarBtn, fontSize: 11 }, title: "在当前工作目录新建一本空 notebook", onClick: createNotebook, disabled: creating },
                          creating ? "新建中…" : "＋ 新建 notebook",
                        ),
                        h(
                          "button",
                          { type: "button", style: { ...toolbarBtn, fontSize: 11 }, title: "手动输入 .ipynb 的绝对路径（兜底）", onClick: () => onManual && onManual() },
                          "手输绝对路径…",
                        ),
                      ),
                    )
                : h(
                    "div",
                    null,
                    // 有 notebook 才出这一节；0 条时上面已经给了空态说明
                    notebooks.length
                      ? h("div", null, sectionTitle("Notebooks (" + notebooks.length + ")"), notebooks.map((item, i) => row(item, i)))
                      : null,
                    dirs.length
                      ? h(
                          "div",
                          null,
                          sectionTitle("目录 (" + dirs.length + ")"),
                          // 目录是「可进入的层级」，不是搜索结果：单独一节，且用文件夹图标
                          dirs.map((item, i) => row(item, notebooks.length + i)),
                        )
                      : null,
                  ),
        ),

        /**
         * 截断提示：宿主的条目上限是 500（本机实测某个工作区一次就顶满，而且全是目录）。
         * 不提示的话用户会以为「就这么多」，找不到的 notebook 会被当成不存在。
         */
        data && data.truncated
          ? h(
              "div",
              { style: { padding: "3px 8px", fontSize: 10, opacity: 0.6, borderTop: "1px solid var(--dsw-alias-border-l2,#3a3a3a)" } },
              pickerTruncatedText(entries.length),
            )
          : null,

        // 底部：兜底入口 + 键位提示
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderTop: "1px solid var(--dsw-alias-border-l2,#3a3a3a)" } },
          h("button", { type: "button", style: { ...miniBtn, opacity: 0.9, border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)", borderRadius: 4, padding: "1px 6px" }, title: "手动输入绝对路径（兜底）", onClick: () => onManual && onManual() }, "手输绝对路径…"),
          h("span", { style: { flex: 1 } }),
          h("span", { style: { opacity: 0.55, fontFamily: FONT_MONO, fontSize: 10 } }, "↑↓ 选择 · Enter 打开 · Esc 关闭"),
        ),
      )
    }

    // ───────────────────────── 大纲（VS Code 式树） ─────────────────────────

    /**
     * 大纲面板：可折叠树 + 过滤框 + 当前格高亮。
     *
     * 自带 query/collapsed 状态（`useState`）—— 这样这个组件既能嵌在面板里，
     * 也能在测试里直接带 props 调一次做静态断言（outlineOpen 默认 false，从 App 树里断言不到）。
     */
    function OutlinePanel(props) {
      const { tree, selectedCellId, onJump } = props || {}
      const [query, setQuery] = React.useState("")
      const [collapsed, setCollapsed] = React.useState({})
      const rows = React.useMemo(() => outlineRows(tree, { query, collapsed }), [tree, query, collapsed])
      const toggle = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 } },
        h(
          "div",
          { style: { display: "flex", gap: 4, padding: "0 2px 4px", flex: "none" } },
          h("input", {
            value: query,
            placeholder: "过滤标题 / 函数名…",
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                setQuery("")
              }
            },
            style: pickerInputStyle,
          }),
        ),
        rows.length === 0
          ? h("div", { style: { opacity: 0.6, padding: "2px 4px" } }, String(query || "").trim() ? "（没有匹配的大纲项）" : "（还没有标题或符号）")
          : h(
              "div",
              { style: { overflow: "auto", flex: 1, minHeight: 0 } },
              rows.map((row) => {
                const node = row.node
                const label = node.kind === "cell" ? `${node.type === "bash" ? "$ " : ""}${node.text}` : node.text
                return h(
                  "div",
                  {
                    key: row.key,
                    "data-outline-key": row.key,
                    title: `第 ${node.index + 1} 格 · 第 ${node.line} 行`,
                    onClick: () => {
                      if (onJump) onJump(node)
                    },
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                      padding: "1px 4px",
                      paddingLeft: 2 + (row.depth - 1) * 11,
                      borderRadius: 3,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      fontSize: 11,
                      background: node.cellId === selectedCellId ? accentMix(16) : "transparent",
                      fontWeight: node.kind === "heading" ? 600 : 400,
                      opacity: node.kind === "cell" ? 0.75 : 0.95,
                    },
                  },
                  h(
                    "span",
                    {
                      onClick: (e) => {
                        e.stopPropagation()
                        if (row.hasChildren) toggle(row.key)
                      },
                      style: {
                        width: 11,
                        flex: "none",
                        opacity: row.hasChildren ? 0.85 : 0,
                        cursor: row.hasChildren ? "pointer" : "default",
                        userSelect: "none",
                      },
                    },
                    row.hasChildren ? (row.open ? "▾" : "▸") : "",
                  ),
                  h(
                    "span",
                    {
                      style: {
                        flex: "1 1 auto",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        fontFamily: node.kind === "heading" ? FONT_UI : FONT_MONO,
                      },
                    },
                    label,
                  ),
                  node.kind === "heading" ? null : h("span", { style: { flex: "none", opacity: 0.45, fontSize: 10, fontFamily: FONT_MONO } }, `L${node.line}`),
                )
              }),
            ),
      )
    }

    // ───────────────────────── 输出复制 ─────────────────────────

    /**
     * 输出块的可复制纯文本；空串 = 这个块不适合复制（图片 / HTML 输出）。
     * 纯函数，可测。
     */
    function outputCopyText(block) {
      if (!block) return ""
      if (block.kind === "stream") return String(block.text || "")
      if (block.kind === "error") {
        return [`${block.ename || "Error"}: ${block.evalue || ""}`].concat(block.traceback || []).join("\n")
      }
      if (block.kind !== "display") return ""
      const picked = pickMime(block.items || [])
      if (!picked || picked.kind === "path") return ""
      const mime = String(picked.mime || "")
      if (mime === "text/html" || mime.startsWith("image/")) return ""
      if (mime === "application/json") {
        try {
          return JSON.stringify(picked.data, null, 2)
        } catch {
          return String(picked.data)
        }
      }
      if (typeof picked.data !== "string") return ""
      if (mime === "text/latex") return String(picked.data)
      return String(picked.data)
    }

    /** 复制到剪贴板（用 navigator.clipboard；被拒/不存在时回调 false，绝不抛）。 */
    function copyToClipboard(text, onDone) {
      const s = String(text == null ? "" : text)
      if (!s) {
        if (onDone) onDone(false)
        return false
      }
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(s).then(
            () => onDone && onDone(true),
            () => onDone && onDone(false),
          )
          return true
        }
      } catch {
        /* ignore */
      }
      if (onDone) onDone(false)
      return false
    }

    // ───────────────────────── 数据层 ─────────────────────────

    const EMPTY_STATE = { cells: [], running: null, queue: [], kernelState: "unknown", path: null, title: null, tabs: [], key: null }

    /** 把 SSE 事件合进本地快照。纯函数，便于推演（也便于在 console 里重放）。 */
    function reduceEvent(state, frame) {
      const cells = state.cells
      const idx = cells.findIndex((c) => c.id === frame.cellId)
      const patchCell = (cellId, fn) => {
        const i = cells.findIndex((c) => c.id === cellId)
        if (i < 0) return state
        const next = cells.slice()
        next[i] = fn({ ...next[i], outputs: (next[i].outputs || []).slice() })
        return { ...state, cells: next }
      }

      switch (frame.ev) {
        case "cell.started":
          return patchCell(frame.cellId, (c) => ({
            ...c,
            status: "running",
            execCount: frame.execCount,
            durationMs: null,
            // 与宿主 `_onStarted` 对齐：重跑先清上一轮输出，否则每跑一次就多一份重复结果
            outputs: [],
            // 开始时刻由服务端给（`at`），刷新/重连后计时不会归零
            startedAt: frame.at || Date.now(),
          }))
        case "stream.append":
          return patchCell(frame.cellId, (c) => {
            const outs = c.outputs
            const last = outs[outs.length - 1]
            if (last && last.kind === "stream" && last.id === frame.outId) {
              outs[outs.length - 1] = { ...last, text: last.text + frame.text }
            } else {
              outs.push({ id: frame.outId, kind: "stream", name: frame.name, text: frame.text })
            }
            return { ...c, outputs: outs }
          })
        case "display.data":
        case "display.update":
          return patchCell(frame.cellId, (c) => {
            const outs = c.outputs
            const item = { mime: frame.mime, data: frame.data, kind: frame.kind, path: frame.path, bytes: frame.bytes }
            const bi = outs.findIndex((o) => o.id === frame.outId)
            if (bi >= 0) {
              const block = { ...outs[bi], items: (outs[bi].items || []).slice() }
              const ii = block.items.findIndex((it) => it.mime === frame.mime)
              if (ii >= 0) block.items[ii] = item
              else block.items.push(item)
              outs[bi] = block
            } else {
              outs.push({ id: frame.outId, kind: "display", items: [item] })
            }
            return { ...c, outputs: outs }
          })
        case "error":
          return patchCell(frame.cellId, (c) => ({
            ...c,
            outputs: c.outputs.concat([{ id: `err-${frame.cellId}-${c.outputs.length}`, kind: "error", ename: frame.ename, evalue: frame.evalue, traceback: frame.traceback || [] }]),
          }))
        case "cell.done": {
          const next = patchCell(frame.cellId, (c) => ({
            ...c,
            status: frame.status === "error" ? "error" : frame.status === "cancelled" ? "cancelled" : "ok",
            durationMs: frame.durationMs ?? c.durationMs,
            execCount: frame.execCount ?? c.execCount,
            startedAt: null,
          }))
          return { ...next, running: next.running === frame.cellId ? null : next.running }
        }
        case "kernel.state":
          return { ...state, kernelState: frame.state }
        default:
          return state
      }
    }

    function useNotebook(sid) {
      const [state, setState] = React.useState(EMPTY_STATE)
      const [conn, setConn] = React.useState("connecting")
      const [notice, setNotice] = React.useState("")
      /** Agent 最近一次改动的目标格（用于「滚过去 + 闪一下」），null = 没有 */
      const [agentFrame, setAgentFrame] = React.useState(null)

      const refetch = React.useCallback(async () => {
        try {
          const res = await fetch(`/nb2/state?sid=${encodeURIComponent(sid)}`, { cache: "no-store" })
          const json = await res.json()
          setState({
            cells: json.cells || [],
            running: json.running || null,
            queue: json.queue || [],
            kernelState: json.kernelState || "unknown",
            path: json.path || null,
            title: json.title || null,
            tabs: json.tabs || [],
            key: json.key || null,
            cwd: json.cwd || null,
          })
        } catch (err) {
          setNotice(String((err && err.message) || err))
        }
      }, [sid])

      React.useEffect(() => {
        refetch()
      }, [refetch])

      React.useEffect(() => {
        if (typeof EventSource === "undefined") return undefined
        const es = new EventSource(`/nb2/events?sid=${encodeURIComponent(sid)}&after=0`)
        es.addEventListener("hello", () => setConn("open"))
        es.addEventListener("resync", () => {
          setNotice("事件历史已滚出，已重新同步")
          refetch()
        })
        es.addEventListener("nb", (e) => {
          let frame
          try {
            frame = JSON.parse(e.data)
          } catch {
            return
          }
          setConn("open")
          if (frame.ev === "nb.updated") {
            /**
             * Agent 改格联动（Phase 3）：后端在 `nb_edit_cell` / `nb_add_cell` 这类
             * 工具调用后会带 `source:"agent"` + `cellId` 广播。这里把目标格记下来，
             * 等 refetch 落地后由面板负责「滚过去 + 闪一下」，让用户实时看清 AI 改了哪一格。
             */
            if (frame.source === "agent" && frame.cellId) setAgentFrame({ cellId: frame.cellId, at: Date.now() })
            refetch()
            return
          }
          setState((prev) => reduceEvent(prev, frame))
        })
        es.onerror = () => setConn("reconnecting")
        return () => {
          try {
            es.close()
          } catch {
            /* ignore */
          }
        }
      }, [sid, refetch])

      return { state, setState, conn, notice, setNotice, refetch, agentFrame }
    }

    async function post(route, body) {
      const res = await fetch(`/nb2/${route}`, {
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
      if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`)
      return json
    }

    // ───────────────────────── 编辑器（CM6） ─────────────────────────

    /**
     * 设计令牌：**全部取 DSH 的 CSS 变量**，不再硬编码 oneDark。
     *
     * 为什么：DSH 的明暗主题由 html[data-theme] / --dsw-alias-* 决定，硬塞 oneDark 就会出现
     * 「软件是浅色、编辑器是黑底」的割裂（用户实测反馈过）。写成 var() 之后，真正取色发生在
     * 绘制时，所以**切换主题不需要重建编辑器**，配色天然跟软件一致。
     */
    const tokens = {
      fg: "var(--dsw-alias-label-primary, currentColor)",
      muted: "var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 60%, transparent))",
      border: "var(--dsw-alias-border-l2, #3a3a3a)",
      activeLine: "var(--dsw-alias-bg-layer-2, color-mix(in srgb, currentColor 6%, transparent))",
      selection: `color-mix(in srgb, ${TEXT_SELECTION} 100%, transparent)`,
      /** 拖选时的选区色：直接用 DSH 官方文档选区令牌（blue-500 40%） */
      selectionStrong: TEXT_SELECTION,
      /** 失焦后保留的选区残影（VS Code 也保留）。原生 ::selection 无焦点概念，同色即可 */
      selectionSoft: TEXT_SELECTION,
      brand: ACCENT,
      /** 强调色的三档混色，供边框/淡底/悬停复用 */
      accent: ACCENT,
      accentMix,
      popup: "var(--dsw-alias-bg-layer-2, #222)",
      match: "color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 22%, transparent)",
    }

    /**
     * 语法高亮：**由 DSH 变量派生**，不用 vendor 里的 `defaultHighlightStyle`。
     *
     * 为什么必须自绘：`defaultHighlightStyle` 是浅色版、颜色写死（#164/#219/#a11/#708），
     * 在深色主题下就是「深色叠深色」，代码几乎读不出来 —— 这正是评审指出的
     * 「明暗割裂换了位置」。
     * 做法：状态色一律与 `--dsw-alias-label-primary` 混合（color-mix），于是浅色下变深、
     * 深色下变浅，对比度自动跟着主题走，不需要 JS 判断 data-theme。
     */
    function nb2HighlightStyle(CM) {
      const tags = CM.tags || {}
      const mix = (hex, pct) => `color-mix(in srgb, ${hex} ${pct}%, var(--dsw-alias-label-primary, currentColor))`
      const rules = []
      const add = (tagList, color) => {
        const list = (Array.isArray(tagList) ? tagList : [tagList]).filter(Boolean)
        if (list.length) rules.push({ tag: list, color })
      }
      // 防御式取 tag：不同版本的 @lezer/highlight 里 helper 名字/存在性并不完全一致，
      // 少一个就让整套高亮崩掉不值得 —— 缺了就返回 undefined，add() 会过滤掉。
      const t = (name) => tags[name]
      const fn = (tag) => (typeof tags.function === "function" && tag ? tags.function(tag) : undefined)
      const sub = (fnName, tag) => (typeof tags[fnName] === "function" && tag ? tags[fnName](tag) : undefined)
      // 关键字 / 控制流
      add([t("keyword"), t("controlKeyword"), t("moduleKeyword"), t("operatorKeyword"), t("definitionKeyword")], ACCENT)
      // 字符串 / 正则 / 特殊字符串
      add([t("string"), sub("special", t("string")), t("regexp")], mix("#2f9e44", 72))
      // 数字 / 布尔 / null
      add([t("number"), t("bool"), t("null")], mix("#d9480f", 68))
      // 注释
      add([t("comment"), t("lineComment"), t("blockComment")], "var(--dsw-alias-label-secondary, currentColor)")
      // 函数 / 类 / 类型
      add([fn(t("variableName")), fn(t("propertyName"))], mix("#1971c2", 72))
      add([t("className"), t("typeName"), t("namespace")], mix("#0c8599", 70))
      // 属性 / 变量 / 常量
      add([t("propertyName"), t("attributeName")], "var(--dsw-alias-label-primary, currentColor)")
      add([sub("definition", t("variableName")), sub("local", t("variableName"))], "var(--dsw-alias-label-primary, currentColor)")
      add([sub("constant", t("variableName")), sub("standard", t("name"))], mix("#9c36b5", 66))
      // 运算 / 标点 / 自引用
      add([t("operator"), t("punctuation"), t("separator"), t("bracket")], "var(--dsw-alias-label-secondary, currentColor)")
      add([t("selfName")], mix("#e8590c", 66))
      // 无效 / 已删除
      add([t("invalid")], "var(--dsw-alias-label-primary, currentColor)")
      try {
        return CM.HighlightStyle.define(rules)
      } catch {
        // 极端情况下（tags 缺失）退回默认，至少不崩
        return CM.defaultHighlightStyle || []
      }
    }

    /**
     * 读出 CM6 当前选区（纯数据，不含 DOM 坐标）。
     *
     * 行号是 **0 基**，与 `lineDiff` / 后端提示词的行号约定保持一致；
     * 只有 `doc.line(n)` 那类 CM6 API 才需要 +1（1 基）。
     * 空选区（只是一个光标）返回 null —— 「选区级改写」只在真的选中东西时才成立。
     */
    function readSelection(view) {
      if (!view || view.destroyed) return null
      const sel = view.state.selection.main
      if (!sel || sel.empty) return null
      const doc = view.state.doc
      const from = Math.min(sel.from, sel.to)
      const to = Math.max(sel.from, sel.to)
      const text = doc.sliceString(from, to)
      if (!text.trim()) return null
      return {
        from,
        to,
        text,
        startLine: doc.lineAt(from).number - 1,
        endLine: doc.lineAt(to).number - 1,
      }
    }

    function buildExtensions(CM, opts) {
      const {
        onRun,
        onRunBelow,
        onRunInsert,
        onSave,
        onEscape,
        onAi,
        ghost,
        onGhostTab = () => false,
        onGhostWord = () => false,
        onGhostLine = () => false,
        onGhostForce,
      } = opts
      return [
        CM.lineNumbers(),
        CM.highlightActiveLineGutter(),
        CM.highlightSpecialChars(),
        CM.highlightActiveLine(),
        /**
         * ⚠️ 这里**故意不**启用 `CM.drawSelection()`。
         *
         * drawSelection 会注入 `.cm-line ::selection{background-color:transparent !important}`，
         * 把浏览器原生选区**关掉**，改为自己在 `.cm-selectionLayer` 里画 div。它有三个副作用：
         *  1. 只在 `&.cm-focused` 下绘制 → 侧栏开合/未测量时 `.cm-scroller` 尺寸为 0，选区直接消失；
         *  2. 配色走 `.cm-selectionBackground`，和 baseTheme 里那条特异性更高的选择器打架；
         *  3. 用户「拖选看得见字但看不出选中」的反馈，根因就在这里。
         * `dsh-better-sidebar` 的 TextEditor 同样不启用它，直接用原生 ::selection —— 照抄这个选择。
         * 代价：矩形选择（rectangularSelection）不再有自绘矩形，仍可用原生选区。
         */
        CM.dropCursor(),
        CM.rectangularSelection(),
        CM.crosshairCursor(),
        CM.highlightSelectionMatches(),
        CM.bracketMatching(),
        CM.closeBrackets(),
        CM.autocompletion({ activateOnTyping: true }),
        CM.indentOnInput(),
        CM.history(),
        CM.python(),
        CM.foldGutter(),
        CM.EditorView.lineWrapping,
        CM.keymap.of([
          /**
           * ⚠️ Tab 必须是**这个数组的第一条**。
           *
           * 同一 keymap 数组内「先匹配先赢」，而跨 keymap 扩展的先后取决于扩展树顺序（太脆）。
           * 早先把它追加在扩展数组末尾 → 被 `indentWithTab` 抢先插缩进，补全永远接受不了，
           * 而且不报错，只有真机敲 Tab 才发现。这里还刻意排在 `...CM.defaultKeymap` 之前。
           * 没有建议时它返回 false，照常落到后面的 indentWithTab。
           */
          { key: "Tab", run: (view) => onGhostTab(view) === true },
          /**
           * 分级接受（Copilot 的 Ctrl-→ / VS Code 的 acceptNextWord）：一次只吃下一个词，
           * 剩下的继续留在幽灵态，边看边决定。
           *
           * ⚠️ `acceptWord` 早就写好了却**从来没绑定过**（调研发现的死代码）—— 用户此前
           * 只有「Tab 整段接受」和「Esc 整段丢弃」两个极端。
           */
          { key: "Ctrl-ArrowRight", run: (view) => onGhostWord(view) === true },
          { key: "Alt-f", run: (view) => onGhostWord(view) === true },
          /**
           * 分级接受（二）：按行接受（VS Code 的 `acceptNextLine`）。
           *
           * 没有建议时返回 false → 自动落到后面的 defaultKeymap，
           * 所以 `Ctrl-End` 原本的「跳到文末」在正常编辑时不受影响。
           */
          { key: "Alt-]", run: (view) => onGhostLine(view) === true },
          { key: "Ctrl-End", run: (view) => onGhostLine(view) === true },
          { key: "Shift-Enter", run: () => (onRunBelow(), true) },
          { key: "Ctrl-Enter", run: () => (onRun(), true) },
          { key: "Mod-Enter", run: () => (onRun(), true) },
          { key: "Alt-Enter", run: () => (onRunInsert(), true) },
          { key: "Mod-s", run: () => (onSave(), true) },
          // Mod-K：唤起内联 AI（与 marimo / VS Code inline chat 同键位）
          { key: "Mod-k", run: () => (onAi && onAi(), true) },
          /**
           * Alt-\：**手动**触发一次 ghost 补全。
           * 存在的意义是「省 token 模式」：平时关掉自动补全开关（不打字就不请求），
           * 想续写时按一下就要。所以它必须绕过 `enabled()`，走 force 通道。
           */
          { key: "Alt-\\", run: () => (onGhostForce && onGhostForce(), true) },
          { key: "Escape", run: (view) => {
            /**
             * 补全弹窗（CM 的 autocompletion 下拉）开着时，Esc 应该先关弹窗，而不是退出编辑态。
             * 这个 keymap 排在 `...CM.completionKeymap` 之前（同数组先匹配先赢），
             * 所以必须自己让路，否则用户永远关不掉那个下拉。
             */
            if (view && view.dom && view.dom.querySelector(".cm-tooltip-autocomplete")) return false
            onEscape()
            return true
          } },
          ...CM.closeBracketsKeymap,
          ...CM.defaultKeymap,
          ...CM.searchKeymap,
          ...CM.historyKeymap,
          ...CM.foldKeymap,
          ...CM.completionKeymap,
          CM.indentWithTab,
        ]),
        CM.syntaxHighlighting(nb2HighlightStyle(CM), { fallback: true }),
        CM.EditorView.theme({
          "&": { fontSize: "12.5px", color: tokens.fg, backgroundColor: "transparent", minHeight: "1.6em" },
          /**
           * ⚠️ 这里**不能**再写 `maxHeight: "60vh"`。
           * 它在长 cell 里会造出第二条滚动条（外层列表已滚动），滚轮落在编辑器上就看不动页面，
           * 真机反馈「滚不动 / 滚错地方」一半来自这里。高度交给内容，滚动交给外层列表。
           */
          ".cm-scroller": { overflow: "auto", fontFamily: FONT_MONO },
          ".cm-content": { padding: "6px 0", caretColor: tokens.brand },
          ".cm-gutters": { backgroundColor: "transparent", border: "none", color: tokens.muted },
          ".cm-activeLine": { backgroundColor: tokens.activeLine },
          ".cm-activeLineGutter": { backgroundColor: "transparent", color: tokens.fg },
          /**
           * 选区可见性（真机反馈：拖选看不到任何高亮）。
           *
           * 现在**不启用 drawSelection**，选区由浏览器原生绘制，所以只要把
           * `.cm-content ::selection` 的底色设成 DSH 官方文档选区令牌即可。
           * 另外保留几条 `.cm-selectionLayer` 的兜底：万一将来又把 drawSelection 打开
           * （或某个 CM 版本自行绘制），也不会退回「完全看不见」。
           */
          "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: tokens.selectionStrong },
          "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: tokens.selectionSoft },
          ".cm-selectionBackground": { backgroundColor: tokens.selectionSoft },
          ".cm-content ::selection": { backgroundColor: TEXT_SELECTION, color: "inherit" },
          ".cm-line ::selection": { backgroundColor: TEXT_SELECTION, color: "inherit" },
          ".cm-selectionMatch": { backgroundColor: tokens.match },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: tokens.brand },
          ".cm-foldPlaceholder": {
            backgroundColor: "transparent",
            border: `1px solid ${tokens.border}`,
            color: tokens.muted,
            borderRadius: "3px",
            padding: "0 4px",
          },
          ".cm-tooltip": { backgroundColor: tokens.popup, border: `1px solid ${tokens.border}`, color: tokens.fg },
          ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: tokens.selection, color: tokens.fg },
          ".cm-panels": { backgroundColor: tokens.popup, color: tokens.fg, borderTop: `1px solid ${tokens.border}` },
          ".cm-searchMatch": { backgroundColor: tokens.match },
          ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: tokens.selection },
          "&.cm-focused": { outline: "none" },
          ".cm-line": { padding: "0 8px" },
        }),
        // AI ghost text（内联自动补全）：开关关着时 ghost 是 null，等于没这个扩展
        ghost || [],
      ]
    }

    /**
     * 一个 cell 一个常驻 EditorView（不做 Monaco 那种模板回收池 —— 那是为了复用 DOM 模板，
     * React 这边常驻几百个 view 完全撑得住；评审也建议先不上池）。
     */
    /** 单元格类型 → markdown 围栏语言（投递到对话时用）。 */
    function languageOfCell(cell) {
      const t = normalizeCellType(cell && cell.cellType)
      if (t === "bash") return "bash"
      if (t === "markdown") return "markdown"
      if (t === "raw") return "text"
      return "python"
    }

    /**
     * 选区行号是否**可信**（纯函数）。
     *
     * 为什么需要它：行号来自不同来源（CM6 / DOM 选区），DOM 那条没有行概念，
     * 用 -1 表示。而 `Number(undefined) || 0` 会把非法值**静默变成第 0 行**，
     * 于是「接受」之后改写的是文件开头 —— 看起来像"AI 乱改"，实际是我们自己把 NaN 当 0。
     * 所以任何拿行号去改文档之前，都必须先过这道校验；不合法就**什么都不做**。
     */
    function validSelectionRange(sel) {
      if (!sel) return false
      const s = sel.startLine
      const e = sel.endLine
      // 严格要求 number：行号只可能来自 CM6（number）。字符串/undefined 一律视为「上游形状不对」，
      // 不允许靠 Number() 强转把它「修好」—— 那会把形状 bug 藏起来，最后变成静默改错行。
      return typeof s === "number" && typeof e === "number" && Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e >= s
    }

    /**
     * 整格回包能不能**安全地**覆盖整格？
     *
     * 只有当回包逐字包含了「选区之外的每一行非空原文」时才安全 ——
     * 这说明模型只是把原代码抄回来、改了选区那几行，没有动别的。
     * 反例（必须拒绝）：模型顺手重构了别处 / 判别误报导致回包其实只是片段。
     *
     * 为什么这事值得单独一个函数：直接覆盖整格的代价是**静默删掉用户没让它改的代码**，
     * 而这条路径的判断依据全是启发式的，必须可测、可回归。
     */
    function fullCellCoversOutside({ reply, selection, cellCode } = {}) {
      const text = String(reply || "")
      const sel = selection || {}
      if (!text || !validSelectionRange(sel)) return false
      const lines = String(cellCode || "").split("\n")
      const outside = lines
        .slice(0, Number(sel.startLine))
        .concat(lines.slice(Number(sel.endLine) + 1))
        .filter((l) => String(l).trim())
      return outside.every((l) => text.includes(l))
    }

    /**
     * 判别「选区级改写的模型回包」到底是片段还是整格。
     *
     * 为什么要这一步：提示词要求模型**只返回替换选中行的代码**，但模型并不总是听话。
     * 如果它返回了整格，而我们仍按片段插进选中的那几行，结果是
     * 「整格代码被塞进 3 行里」→ 用户这一格彻底坏掉（而且看起来像是"AI 变笨"）。
     *
     * 判据（从严到宽，命中即算整格）：
     *  1. 回包里出现了**选区之外**的其它行的原文（前后缀行）→ 一定是整格；
     *  2. 回包行数明显多于选区行数（≥ 选区行数 + 选区外行数的一半）→ 按整格处理；
     *  3. 否则按片段处理。
     *
     * @returns {"snippet"|"full-cell"}
     */
    function classifySelectionReply({ reply, selection, cellCode } = {}) {
      const text = String(reply || "")
      const sel = selection || {}
      const selText = String(sel.text || "")
      const code = String(cellCode || "")
      if (!text) return "snippet"
      // 只选中整格时，两种理解等价 —— 按片段走（更简单）
      if (code && selText && code.trim() === selText.trim()) return "snippet"
      const lines = code ? code.split("\n") : []
      const start = Number(sel.startLine)
      const end = Number(sel.endLine)
      if (!lines.length || !(start >= 0) || !(end >= start)) {
        // 没有行号信息（例如来自 markdown/DOM 选区）：只要回包比选区大很多就当整格
        return text.split("\n").length > Math.max(3, selText.split("\n").length * 2) ? "full-cell" : "snippet"
      }
      const outside = lines.slice(0, start).concat(lines.slice(end + 1)).filter((l) => l.trim())
      const hitOutside = outside.some((l) => text.includes(l))
      if (hitOutside) return "full-cell"
      const selLines = end - start + 1
      const replyLines = text.split("\n").length
      if (outside.length && replyLines >= selLines + Math.ceil(outside.length / 2)) return "full-cell"
      return "snippet"
    }

    /**
     * 选区浮动工具条。
     *
     * 为什么要有：用户反馈「拖选代码块内文字，还是没有 UI 提示」。参照
     * `dsh-better-sidebar` 的 useSelectionPopup —— 拖选后立刻在选区上方弹一排动作，
     * 让「选中 → 让 AI 改 / 塞进对话」变成一步。
     *
     * 生命周期契约（照搬 dsh-better-sidebar issue #425 的经验，绝不留幽灵按钮）：
     *   点击浮层外 mousedown、Esc、列表滚动、窗口失焦、切换 cell → 立即隐藏。
     *
     * 渲染：优先 createPortal 到 body（侧栏有 overflow:auto，inline 会被裁掉）；
     * 拿不到 react-dom 就退化成 fixed 定位（不依赖祖先是否有 transform，视觉等价）。
     */
    function SelectionFloatingBar({ anchor, actions, onDismiss }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!anchor) return undefined
        const onDown = (e) => {
          if (ref.current && ref.current.contains(e.target)) return
          onDismiss()
        }
        const onKey = (e) => {
          if (e.key === "Escape") onDismiss()
        }
        // capture 阶段：先于编辑器的 mousedown 处理器，避免"点空白处选区没了但按钮还在"
        document.addEventListener("mousedown", onDown, true)
        document.addEventListener("keydown", onKey, true)
        window.addEventListener("blur", onDismiss)
        return () => {
          document.removeEventListener("mousedown", onDown, true)
          document.removeEventListener("keydown", onKey, true)
          window.removeEventListener("blur", onDismiss)
        }
      }, [anchor, onDismiss])

      if (!anchor) return null
      const el = h(
        "div",
        {
          ref,
          className: "nb2-sel-pop",
          // mousedown 阻止默认：否则点按钮会先清掉选区，动作拿到的选区就没了
          onMouseDown: (e) => e.preventDefault(),
          style: { left: anchor.x, top: anchor.y },
        },
        (actions || []).map((a, i) =>
          h(
            "button",
            {
              key: i,
              type: "button",
              title: a.title || "",
              onClick: (e) => {
                e.stopPropagation()
                e.preventDefault()
                a.onClick()
              },
            },
            a.label,
          ),
        ),
      )
      // createPortal 到 body 才能真正压过侧栏裁剪；拿不到就原地 fixed
      return createPortal ? createPortal(el, document.body) : el
    }
    /**
     * 单元格右键上下文菜单（Jupyter 标配：插入/删除/移动/切类型/清空输出/复制/引用到对话）。
     *
     * 销毁契约与 SelectionFloatingBar 完全一致 —— 这是本仓库已经踩过的坑：
     *  · 点菜单外任意位置（capture 阶段 mousedown）→ 关；
     *  · `Esc` → 关；
     *  · 窗口失焦 → 关；
     *  · 面板/列表滚动 → 关（由调用方在 listRef.onScroll 里调 onDismiss）。
     * 用 portal 到 `document.body` 的 fixed 层，否则会被侧栏的 overflow 裁掉。
     */
    function CellContextMenu({ menu, actions, onDismiss }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!menu) return undefined
        const onDown = (e) => {
          if (ref.current && ref.current.contains(e.target)) return
          onDismiss()
        }
        const onKey = (e) => {
          if (e.key === "Escape") onDismiss()
        }
        document.addEventListener("mousedown", onDown, true)
        document.addEventListener("keydown", onKey, true)
        window.addEventListener("blur", onDismiss)
        return () => {
          document.removeEventListener("mousedown", onDown, true)
          document.removeEventListener("keydown", onKey, true)
          window.removeEventListener("blur", onDismiss)
        }
      }, [menu, onDismiss])

      if (!menu) return null
      const el = h(
        "div",
        {
          ref,
          className: "nb2-ctx-menu",
          style: { left: menu.x, top: menu.y },
          // 菜单里再点右键不要弹浏览器菜单
          onContextMenu: (e) => e.preventDefault(),
          onMouseDown: (e) => e.stopPropagation(),
        },
        (actions || []).map((a, i) =>
          a.separator
            ? h("div", { key: `sep${i}`, className: "nb2-ctx-sep" })
            : h(
                "button",
                {
                  key: i,
                  type: "button",
                  className: "nb2-ctx-item",
                  title: a.title || "",
                  disabled: !!a.disabled,
                  style: a.disabled ? { opacity: 0.45, cursor: "default" } : undefined,
                  onClick: (e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    if (a.disabled) return
                    onDismiss()
                    a.onClick()
                  },
                },
                h("span", null, a.label),
                a.hint ? h("span", { className: "nb2-ctx-hint" }, a.hint) : null,
              ),
        ),
      )
      return createPortal ? createPortal(el, document.body) : el
    }

    /**
     * 读浏览器原生选区（markdown 预览区 / 输出区用）。
     *
     * CM6 编辑器那边有 `view.state.selection` 与 `coordsAtPos`，普通 DOM 没有，
     * 只能走 `window.getSelection()`。返回 null 的条件与编辑器侧保持一致：
     * 没有选区、或者选中的只是空白 —— 否则「点一下」也会弹按钮。
     */
    function readDomSelection(doc) {
      const d = doc || (typeof document !== "undefined" ? document : null)
      if (!d) return null
      const s = typeof d.getSelection === "function" ? d.getSelection() : null
      if (!s || s.rangeCount === 0 || s.isCollapsed) return null
      const text = String(s.toString() || "")
      if (!text.trim()) return null
      let coords = null
      try {
        const r = s.getRangeAt(0).getBoundingClientRect()
        if (r && (r.width || r.height)) coords = { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
      } catch {
        coords = null
      }
      // 行号对纯 DOM 选区没有意义，给 -1 让上层知道「无行号信息」
      return { selection: { text, startLine: -1, endLine: -1 }, coords }
    }

    /**
     * 由「选区矩形 + 视口尺寸」算出浮层坐标（纯函数，可测）。
     *
     * 放在选区**上方**（-36px）；上方放不下就翻到下方；水平夹在视口内，避免半个按钮出屏。
     */
    function placeSelectionBar(rect, viewport, size = { width: 240, height: 32 }) {
      const vw = (viewport && viewport.width) || 0
      const vh = (viewport && viewport.height) || 0
      if (!rect) return null
      const midX = (rect.left + rect.right) / 2
      let x = midX - size.width / 2
      const margin = 6
      if (vw) x = Math.max(margin, Math.min(x, vw - size.width - margin))
      let y = rect.top - size.height - 6
      // 上方不够 → 放到选区下方
      if (y < margin) y = Math.min(rect.bottom + 6, vh ? vh - size.height - margin : rect.bottom + 6)
      return { x, y }
    }

    function CellEditor({ CM, cellId, value, onChange, onRun, onRunBelow, onRunInsert, onSave, onEscape, onAi, onReady, autoFocus, ghost, onSelectionChange }) {
      const hostRef = React.useRef(null)
      const viewRef = React.useRef(null)
      const cbRef = React.useRef({})
      cbRef.current = { onChange, onRun, onRunBelow, onRunInsert, onSave, onEscape, onAi, onReady, onSelectionChange }
      // 补全的开关与请求函数随时可变，用 ref 读，避免重建编辑器
      const ghostRef = React.useRef(ghost || null)
      ghostRef.current = ghost || null
      // ghost 扩展把 accept/dismiss 挂在这里（Tab / Esc 由 buildExtensions 的 keymap 调用）
      const ghostApiRef = React.useRef(null)

      React.useEffect(() => {
        if (!CM || !hostRef.current) return undefined
        const view = new CM.EditorView({
          doc: value,
          extensions: buildExtensions(CM, {
            onRun: () => cbRef.current.onRun && cbRef.current.onRun(),
            onRunBelow: () => cbRef.current.onRunBelow && cbRef.current.onRunBelow(),
            onRunInsert: () => cbRef.current.onRunInsert && cbRef.current.onRunInsert(),
            onSave: () => cbRef.current.onSave && cbRef.current.onSave(),
            // Esc：先丢弃 AI 补全建议（如果有），没有建议才交回「退出编辑态」——
            // 和 VS Code 一样：第一下 Esc 收建议，第二下才离开编辑器。
            onEscape: () => {
              const view = viewRef.current
              if (view && ghostApiRef.current && ghostApiRef.current.dismiss(view)) return
              if (cbRef.current.onEscape) cbRef.current.onEscape()
            },
            onAi: () => {
              // 把「当前选区」一起交出去：Mod-K 才能只改选中的那几行（选区级局部改写）
              const view = viewRef.current
              if (cbRef.current.onAi) cbRef.current.onAi(view ? readSelection(view) : null)
            },
            // ghost 的开关变化不需要重建编辑器：enabled()/request() 都从 ref 现读
            ...(ghost
              ? {
                  ghost: buildGhostExtension(CM, {
                    enabled: () => !!(ghostRef.current && ghostRef.current.enabled),
                    request: (payload) => (ghostRef.current ? ghostRef.current.request({ ...payload, cellId }) : null),
                    onBusy: (busy) => {
                      if (ghostRef.current && ghostRef.current.onBusy) ghostRef.current.onBusy(busy)
                    },
                    onApi: (api) => {
                      ghostApiRef.current = api
                    },
                    // 设置项（#13）：防抖 / 最大行数现读 —— 改设置立刻生效，不重建编辑器
                    getOptions: () => (ghostRef.current && ghostRef.current.options ? ghostRef.current.options() : {}),
                  }),
                  // Tab：有建议就接受，没有就返回 false 交给 indentWithTab
                  onGhostTab: (view) => !!(ghostApiRef.current && ghostApiRef.current.accept(view)),
                  // Ctrl-→ / Alt-f：只接受下一个词（剩下的继续留在幽灵态）
                  onGhostWord: (view) => !!(ghostApiRef.current && ghostApiRef.current.acceptWord(view)),
                  // Alt-] / Ctrl-End：只接受下一行（剩下的继续留在幽灵态）
                  onGhostLine: (view) => !!(ghostApiRef.current && ghostApiRef.current.acceptLine(view)),
                  // Alt-\：手动触发一次（绕过自动补全开关）
                  onGhostForce: () => {
                    const view = viewRef.current
                    return !!(view && ghostApiRef.current && ghostApiRef.current.force(view))
                  },
                }
              : {}),
          }).concat([
            CM.EditorView.updateListener.of((u) => {
              if (u.docChanged && cbRef.current.onChange) cbRef.current.onChange(u.state.doc.toString())
              /**
               * 选区变化 → 上报给 CellView / 面板，用于弹「选区浮动条」。
               * 只在真的选中东西（非空）时上报；清空时上报 null（让浮层收掉）。
               * 顺手把 CM 的视口坐标带上（`coordsAtPos`），否则外面拿不到准确锚点。
               */
              if (u.selectionSet && cbRef.current.onSelectionChange) {
                const s = readSelection(u.view)
                let coords = null
                if (s) {
                  try {
                    const a = u.view.coordsAtPos(s.from)
                    const b = u.view.coordsAtPos(s.to)
                    if (a) coords = { left: Math.min(a.left, b ? b.left : a.left), right: Math.max(a.right, b ? b.right : a.right), top: a.top, bottom: (b || a).bottom }
                  } catch {
                    coords = null
                  }
                }
                cbRef.current.onSelectionChange(s, coords)
              }
            }),
          ]),
          parent: hostRef.current,
        })
        viewRef.current = view
        if (cbRef.current.onReady) {
          cbRef.current.onReady({
            focus: () => view.focus(),
            blur: () => view.contentDOM.blur(),
            getSelection: () => readSelection(view),
            /** 读当前编辑器里的权威源码（dispatch 之后立刻就是新值，不像 React state 有闭包滞后） */
            getSource: () => {
              try {
                return view.state.doc.toString()
              } catch {
                return ""
              }
            },
            /**
             * 把光标放到第 n 行（1 基）—— markdown 渲染区点进来时用（P1 5.7）。
             * 行号来自点击高度的粗略估算，所以这里一律 clamp，绝不抛。
             */
            setCursorLine: (line1) => {
              try {
                const doc = view.state.doc
                const n = Math.max(1, Math.min(doc.lines, Math.trunc(Number(line1)) || 1))
                const pos = doc.line(n).from
                view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
                return true
              } catch {
                return false
              }
            },
            /**
             * 选区级改写的落地：把「第 startLine–endLine 行」整段替换成 insert。
             *
             * 为什么走 `dispatch` 而不是「算完整源码 → 后端 cell/edit」：
             *  - dispatch 会进 CM6 的 undo 栈 → 用户 Ctrl+Z 就能撤回（VS Code inline chat 同体验）；
             *  - 走 onChange → changeSource 的既有链路，乐观更新 + 防抖落库都自动生效，
             *    不需要为「AI 改了一半」再写一套持久化。
             */
            applySelectionEdit: ({ startLine, endLine, insert }) => {
              try {
                // 行号不可信就**不要动文档**：宁可让上层走安全的整格拼接路径，
                // 也不能把 NaN/-1 静默夹成 0 去改文件开头（那是最坏的一种"看起来成功了"）。
                if (!validSelectionRange({ startLine, endLine })) return false
                const doc = view.state.doc
                const start = Math.max(0, Math.min(Number(startLine), doc.lines - 1))
                const end = Math.max(start, Math.min(Number(endLine), doc.lines - 1))
                const from = doc.line(start + 1).from
                const to = doc.line(end + 1).to
                const text = String(insert == null ? "" : insert)
                view.dispatch({
                  changes: { from, to, insert: text },
                  selection: { anchor: from + text.length },
                  scrollIntoView: true,
                })
                return true
              } catch {
                return false
              }
            },
          })
        }
        if (autoFocus) view.focus()
        return () => {
          view.destroy()
          viewRef.current = null
          if (cbRef.current.onReady) cbRef.current.onReady(null)
        }
        // 只挂载一次：value 的变化走下面那个 effect，避免每次输入重建编辑器
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [CM])

      React.useEffect(() => {
        const view = viewRef.current
        if (!view) return
        const cur = view.state.doc.toString()
        if (cur !== value) {
          view.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
        }
      }, [value])

      /**
       * 关掉补全开关时，把已经画在屏幕上的幽灵文本收掉。
       *
       * 为什么需要单独管：幽灵文本是 Decoration widget，不会因为「开关变了」自己消失
       * （StateField 只在文档/选区/effect 变化时才更新）。不处理的话会出现
       * 「开关已经关了，但上次的灰字还挂在光标后面」这种很怪的残留。
       */
      React.useEffect(() => {
        const view = viewRef.current
        if (!view) return
        const enabled = !!(ghost && ghost.enabled)
        if (enabled) return
        // 用一个空事务把 ghost 清掉：字段的 update 见到 selection 变化就返回 null
        try {
          view.dispatch({ selection: { anchor: view.state.selection.main.head } })
        } catch {
          /* ignore */
        }
      }, [ghost])

      return h("div", { ref: hostRef, className: "nb2-cm-host", style: { minHeight: 28, cursor: "text" } })
    }

    // ───────────────────────── 输出渲染 ─────────────────────────

    /** 拿不到宿主角色的兜底正文色（GitHub 浅色前景，与 DSH 默认浅色主题一致）。 */
    const OUTPUT_FALLBACK_FG = "#1f2328"

    /**
     * iframe 是**独立文档**：宿主的 CSS 变量和 `color` 都进不来。
     * `body{color:inherit}` 在 iframe 里等于取初始值（CanvasText），深色主题下就是
     * 黑字压在深底上看不见。所以要先把宿主前景色算成**具体色值**再写进 srcdoc。
     */
    function readHostForeground() {
      try {
        if (typeof document === "undefined" || !document.body) return ""
        if (typeof getComputedStyle !== "function") return ""
        const c = getComputedStyle(document.body).color || ""
        // rgba(0,0,0,0) = 全透明，等于「没有颜色」，不能当正文色
        if (!c || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(c)) return ""
        return c
      } catch {
        return ""
      }
    }

    /** 前景色偏亮 = 深色主题（决定 iframe 的 color-scheme，滚动条颜色跟着走）。 */
    function foregroundIsLight(color) {
      const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(String(color == null ? "" : color))
      if (!m) return false
      const luma = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000
      return luma > 140
    }

    /**
     * 宿主切明暗主题时，iframe 里已经写死的具体色值会过期。
     * DSH 切主题的落点不确定（class / data-theme / 注入 style 都见过），三处都盯；
     * 只有算出来的前景色真的变了才重渲染，避免无意义的 srcdoc 重建。
     */
    function useHostForeground() {
      const [fg, setFg] = React.useState(() => readHostForeground())
      React.useEffect(() => {
        if (typeof document === "undefined" || typeof MutationObserver !== "function") return
        let last = readHostForeground()
        const sync = () => {
          const next = readHostForeground()
          if (next && next !== last) {
            last = next
            setFg(next)
          }
        }
        const observe = () => {
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(sync)
          else sync()
        }
        const mo = new MutationObserver(observe)
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class", "style", "data-theme", "data-color-mode"],
        })
        // 跟随系统主题时属性不变但颜色会变
        const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null
        if (mq && mq.addEventListener) mq.addEventListener("change", observe)
        else if (mq && mq.addListener) mq.addListener(observe)
        return () => {
          mo.disconnect()
          if (mq && mq.removeEventListener) mq.removeEventListener("change", observe)
          else if (mq && mq.removeListener) mq.removeListener(observe)
        }
      }, [])
      return fg
    }

    /**
     * HTML 输出的基线样式（注入 iframe 的 `<style>`）。
     *
     * 出处（别人家的真实实现，不是拍脑袋）：
     *  · JupyterLab `packages/rendermime/style/base.css` 的 `.jp-RenderedHTMLCommon table`：
     *    表格无竖线、单元格 `padding:.5em`、数值右对齐、`tbody tr` 斑马纹 + hover 高亮。
     *  · pandas `_repr_html_` 自带 `<table border="1">`（浏览器按属性画粗黑网格）和
     *    `<style scoped>`（`.dataframe thead th{text-align:right}`）—— 所以必须显式
     *    `border:0`，且 pandas 的规则要**被更具体的选择器压住**，否则对齐不受控。
     *
     * 派生色一律 `color-mix(in srgb, currentColor …)`：明暗主题自动跟随，
     * 不写死 #fff / #333（本仓库踩过硬编码 oneDark 在浅色主题下没法看的坑）。
     */
    function buildOutputHtmlCss(fg) {
      const color = fg || OUTPUT_FALLBACK_FG
      return [
        "html,body{margin:0;padding:0}",
        "body{color:" + color + ";background:transparent;font:13px/1.55 " + FONT_UI + ";-webkit-text-size-adjust:100%}",
        "a{color:inherit;text-decoration:underline;text-underline-offset:2px;opacity:.85}",
        "img,svg{max-width:100%;height:auto}",
        "pre{margin:0;font:12px/1.5 " + FONT_MONO + ";white-space:pre-wrap;word-break:break-word}",
        // 表格基线：干掉 border="1" 的粗黑网格，换成 JupyterLab 的「无竖线 + 表头下横线」
        "table{border:0;border-collapse:collapse;border-spacing:0;margin:2px 0 6px;font-size:12.5px;font-variant-numeric:tabular-nums}",
        "table th,table td{border:0;padding:4px 10px;vertical-align:middle;line-height:1.45;white-space:nowrap}",
        "table thead th{border-bottom:1px solid color-mix(in srgb,currentColor 24%,transparent);font-weight:600;color:color-mix(in srgb,currentColor 70%,transparent);text-align:left}",
        // 行底色挂在 tr 上，单元格必须透明才透得出来（否则斑马纹被 th 自己的底色盖掉）
        "table tbody tr:nth-child(even){background:color-mix(in srgb,currentColor 4%,transparent)}",
        "table tbody tr:hover{background:color-mix(in srgb,currentColor 8%,transparent)}",
        "table tbody th{text-align:left;background:transparent;font-weight:500;color:color-mix(in srgb,currentColor 82%,transparent)}",
        "table tbody td{text-align:left}",
        // pandas.DataFrame：数值列右对齐（选择器比 pandas 自带 <style scoped> 更具体）
        "table.dataframe thead th{text-align:right}",
        "table.dataframe thead th:first-child{text-align:left}",
        "table.dataframe tbody td{text-align:right}",
        "table.dataframe tbody th{text-align:left}",
      ].join("")
    }

    /** iframe 里内容高度变化 → 通知宿主（对应 VS Code 的 dimension / ack-dimension）。 */
    const OUTPUT_HEIGHT_REPORTER =
      "<script>(function(){function r(){parent.postMessage({__nb2:'height',height:document.documentElement.scrollHeight},'*')}" +
      "new ResizeObserver(r).observe(document.documentElement);window.addEventListener('load',r);setTimeout(r,60)})();</script>"

    /**
     * HTML 输出 → iframe srcdoc。纯函数（不碰 DOM），测试可以直接断言产物。
     * @param {string} html
     * @param {{fg?: string}} [opts]
     */
    function buildOutputHtmlDoc(html, opts) {
      const fg = (opts && opts.fg) || OUTPUT_FALLBACK_FG
      const scheme = foregroundIsLight(fg) ? "dark" : "light"
      return (
        '<!doctype html><meta charset="utf-8">' +
        "<style>:root{color-scheme:" +
        scheme +
        "}" +
        buildOutputHtmlCss(fg) +
        "</style>" +
        String(html == null ? "" : html) +
        OUTPUT_HEIGHT_REPORTER
      )
    }

    function HtmlOutput({ html }) {
      const ref = React.useRef(null)
      const [height, setHeight] = React.useState(80)
      const fg = useHostForeground()
      React.useEffect(() => {
        // 沙箱 iframe 里的脚本把内容高度 post 上来（对应 vscode 的 dimension / ack-dimension）
        const onMsg = (e) => {
          if (!ref.current || e.source !== ref.current.contentWindow) return
          const data = e.data
          if (data && data.__nb2 === "height" && typeof data.height === "number") {
            setHeight(Math.max(24, Math.min(1200, Math.ceil(data.height))))
          }
        }
        window.addEventListener("message", onMsg)
        return () => window.removeEventListener("message", onMsg)
      }, [])

      const srcdoc = React.useMemo(() => buildOutputHtmlDoc(html, { fg }), [html, fg])

      return h("iframe", {
        ref,
        title: "html output",
        sandbox: "allow-scripts",
        srcDoc: srcdoc,
        style: { width: "100%", height, border: "0", display: "block", background: "transparent" },
      })
    }

    /**
     * 图片输出：内联块走 data URL，落盘块走 `/nb2/spill`。
     *
     * 加载失败必须给出**可读原因**。真机中间态（2026-11-11）：客户端已刷新、宿主没重启，
     * `/nb2/spill` 还是 404，`<img>` 只剩一行 `alt="image/png"` —— 用户看到的就是一行
     * 无意义的字，根本不知道是「版本没对齐」还是「图坏了」。
     */
    function ImageOutput({ src, mime, filePath }) {
      const [failed, setFailed] = React.useState(false)
      if (failed || !src) {
        return h(
          "div",
          { style: { padding: "6px 10px", fontSize: 11.5, opacity: 0.85, lineHeight: 1.6 } },
          `图片没能加载（${mime}）`,
          filePath ? `：已落盘到 ${filePath}` : "",
          "。若这是落盘的大图，说明宿主的 /nb2/spill 不可用（常见于插件更新后没有重启），重启 DeepSeek Harness 后恢复。",
        )
      }
      return h(
        "div",
        { style: { padding: "6px 10px" } },
        h("img", {
          src,
          alt: mime,
          style: { maxWidth: "100%", display: "block" },
          onError: () => setFailed(true),
        }),
      )
    }

    function OutputBlockView({ block, CM, onFixError, onCiteError }) {
      const [expanded, setExpanded] = React.useState(false)

      if (block.kind === "stream") {
        // 折叠在**剥掉 ANSI 之后**做：切在转义序列中间会留下可见的 `[31` 残渣
        const fold = foldDecision(stripAnsi(block.text))
        const color = block.name === "stderr" ? STDERR_COLOR : "inherit"
        if (!fold || expanded) {
          return h(
            "pre",
            { style: { ...preStyle, color } },
            ansiNodes(block.text),
            fold && expanded
              ? h("button", { type: "button", onClick: () => setExpanded(false), style: linkBtn }, "收起")
              : null,
          )
        }
        return h(
          "pre",
          { style: { ...preStyle, color } },
          fold.head,
          "\n",
          h("button", { type: "button", onClick: () => setExpanded(true), style: linkBtn }, `… 展开 ${fold.hiddenLines} 行 / ${Math.round(fold.hiddenChars / 1024)}KB …`),
          "\n",
          fold.tail,
        )
      }

      if (block.kind === "error") {
        // traceback 常常几十上百行（pandas / matplotlib 的调用栈尤甚），默认只留头尾
        const tbRaw = (block.traceback || []).join("\n")
        const tbPlain = stripAnsi(tbRaw)
        const tbFold = foldDecision(tbPlain)
        const tbStyle = { ...preStyle, padding: "4px 0", color: "inherit" }
        const traceNode =
          !tbFold || expanded
            ? h(
                "pre",
                { style: tbStyle },
                ansiNodes(tbRaw),
                tbFold && expanded
                  ? h("button", { type: "button", onClick: () => setExpanded(false), style: linkBtn }, "收起")
                  : null,
              )
            : h(
                "pre",
                { style: tbStyle },
                tbFold.head,
                "\n",
                h("button", { type: "button", onClick: () => setExpanded(true), style: linkBtn }, `… 展开 ${tbFold.hiddenLines} 行 …`),
                "\n",
                tbFold.tail,
              )
        return h(
          "div",
          {
            // 打标记：这是「报错块」，浮动条在选中它时给出的动作用错词（修这个错）
            "data-nb2-error": "1",
            style: {
              padding: "6px 10px",
              background: `color-mix(in srgb, ${ERROR_HUE} 9%, transparent)`,
              borderLeft: `3px solid ${ERROR_HUE}`,
            },
          },
          h("div", { style: { fontWeight: 650, color: ERROR_TITLE_COLOR, fontSize: 12 } }, `${block.ename}: ${block.evalue}`),
          traceNode,
          /**
           * 报错块底部的一键动作（反馈 3 的核心）：
           *  · AI 修复：把 traceback 变成指令，直接在该格唤起内联 AI 生成修复 diff（不离开 Notebook）
           *  · 发给 Agent：把源码 + 完整 traceback 塞进主对话，交给主 Agent 多步排查
           */
          h(
            "div",
            { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" } },
            h(
              "button",
              {
                type: "button",
                title: "用 traceback 作为指令，让内联 AI 生成本格的修复 diff",
                onClick: (e) => {
                  e.stopPropagation()
                  if (onFixError) onFixError(block)
                },
                style: { ...miniBtn, border: `1px solid ${ERROR_HUE}`, color: ERROR_TITLE_COLOR, opacity: 1, padding: "1px 6px" },
              },
              "🔧 AI 快速修复",
            ),
            h(
              "button",
              {
                type: "button",
                title: "把出错单元格源码 + 完整 traceback 发给主对话 Agent 深度排查",
                onClick: (e) => {
                  e.stopPropagation()
                  if (onCiteError) onCiteError(block)
                },
                style: { ...miniBtn, border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)", opacity: 1, padding: "1px 6px" },
              },
              "💬 发给 Agent",
            ),
          ),
        )
      }

      // display：一个块里可能有多个 mime，挑一个能渲染的
      const picked = pickMime(block.items || [])
      if (!picked) return h("div", { style: { padding: "4px 10px", opacity: 0.6, fontSize: 11 } }, "（无可渲染的输出）")
      const data = picked.data
      const mime = picked.mime

      if (picked.kind === "path") {
        /**
         * 落盘块（超大图 / 超大 HTML）现在**能读回来**：宿主 `/nb2/spill` 只允许读 spill
         * 目录内的文件，前端拿它当 `<img src>` 用，不再只显示一行「大块输出已折叠 …/nb2-x.bin」
         * （2026-11-11 真机：matplotlib 的图变成一行文字，用户以为输出坏了）。
         */
        const absPath = String(picked.path || "")
        const sizeKb = Math.max(1, Math.round((Number(picked.bytes) || 0) / 1024))
        const src = `/nb2/spill?path=${encodeURIComponent(absPath)}`
        if (mime.startsWith("image/")) {
          // SVG 也走 <img>：img 不执行脚本，比 innerHTML 安全
          return h(ImageOutput, { src, mime, filePath: absPath })
        }
        return h(
          "div",
          { style: { padding: "6px 10px", fontSize: 11.5, opacity: 0.8 } },
          `大块输出已落盘（${sizeKb}KB，${mime}）`,
          h(
            "a",
            { href: src, target: "_blank", rel: "noreferrer", style: { marginLeft: 8, color: "inherit" } },
            "打开",
          ),
        )
      }
      if (mime === "text/html") return h(HtmlOutput, { html: String(data) })
      if (mime === "image/svg+xml") {
        return h("div", { style: { padding: "6px 10px" }, dangerouslySetInnerHTML: { __html: String(data) } })
      }
      if (mime.startsWith("image/")) {
        const src = typeof data === "string" ? `data:${mime};base64,${String(data).replace(/\s/g, "")}` : ""
        return h(ImageOutput, { src, mime })
      }
      if (mime === "text/latex") {
        // 同 markdownLite 的公式分支：没有消毒器就退回纯文本，不注入未消毒 HTML
        const clean = canInjectHtml(CM) ? sanitizeHtml(renderLatex(data, CM, false), CM) : null
        if (clean == null) return h("pre", { style: preStyle }, String(data))
        return h("div", { style: { padding: "6px 10px", overflowX: "auto" }, dangerouslySetInnerHTML: { __html: clean } })
      }
      if (mime === "application/json") {
        return h("div", { style: { padding: "6px 10px", maxHeight: 420, overflow: "auto" } }, jsonTree(data, 0))
      }
      if (mime === "text/markdown") {
        return h("div", { style: { padding: "6px 10px", fontSize: 12.5 } }, markdownLite(data, CM))
      }
      const text = typeof data === "string" ? data : JSON.stringify(data)
      const fold = foldDecision(text)
      if (fold && !expanded) {
        return h(
          "pre",
          { style: preStyle },
          fold.head,
          "\n",
          h("button", { type: "button", onClick: () => setExpanded(true), style: linkBtn }, `… 展开 ${fold.hiddenLines} 行 …`),
          "\n",
          fold.tail,
        )
      }
      return h("pre", { style: preStyle }, text)
    }

    const linkBtn = {
      border: "0",
      background: "transparent",
      color: ACCENT,
      cursor: "pointer",
      fontSize: 11,
      padding: "2px 0",
      fontFamily: FONT_MONO,
    }

    // ───────────────────────── AI 内联建议（M4） ─────────────────────────

    /**
     * 行级 diff（LCS）。用于「AI 改写 → 左右对照评审」，也是可自动化测试的纯函数。
     * @returns {Array<{op:'same'|'add'|'del', text:string, aIndex?:number, bIndex?:number}>}
     */
    function lineDiff(before, after) {
      const toLines = (v) => {
        const s = String(v == null ? "" : v)
        // 空串 = 零行。否则 "" 会被 split 成 ['']，diff 里多出一条「删掉一个空行」的噪声。
        return s === "" ? [] : s.split("\n")
      }
      const a = toLines(before)
      const b = toLines(after)
      const n = a.length
      const m = b.length
      // 大文件保护：超过 1200 行就退化成整体替换，避免 O(n*m) 卡死 UI
      if (n * m > 1200 * 200) {
        const out = []
        for (let i = 0; i < n; i += 1) out.push({ op: "del", text: a[i], aIndex: i })
        for (let j = 0; j < m; j += 1) out.push({ op: "add", text: b[j], bIndex: j })
        return out
      }
      const dp = []
      for (let i = 0; i <= n; i += 1) dp.push(new Array(m + 1).fill(0))
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
      }
      const out = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          out.push({ op: "same", text: a[i], aIndex: i, bIndex: j })
          i += 1
          j += 1
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          out.push({ op: "del", text: a[i], aIndex: i })
          i += 1
        } else {
          out.push({ op: "add", text: b[j], bIndex: j })
          j += 1
        }
      }
      while (i < n) {
        out.push({ op: "del", text: a[i], aIndex: i })
        i += 1
      }
      while (j < m) {
        out.push({ op: "add", text: b[j], bIndex: j })
        j += 1
      }
      return out
    }

    /** diff → {added, removed, unchanged} 统计，UI 上显示 «+3 −1»。 */
    function diffStat(ops) {
      let added = 0
      let removed = 0
      let same = 0
      for (const o of ops) {
        if (o.op === "add") added += 1
        else if (o.op === "del") removed += 1
        else same += 1
      }
      return { added, removed, same }
    }

    /**
     * 调宿主 AI，按行解析 NDJSON。返回一个 abort 函数。
     * 流式要点：边 read 边解析，解析到 delta 就回调 —— 这样首字延迟 = 首个 token 的到达时间。
     */
    function streamAi(req, handlers) {
      const ctrl = new AbortController()
      const run = async () => {
        try {
          const res = await fetch("/nb2/ai/stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(req),
            signal: ctrl.signal,
          })
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "")
            handlers.onError?.({ code: `HTTP_${res.status}`, message: text || `HTTP ${res.status}` })
            return
          }
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ""
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let idx
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).trim()
              buf = buf.slice(idx + 1)
              if (!line) continue
              let msg
              try {
                msg = JSON.parse(line)
              } catch {
                continue
              }
              if (msg.type === "delta") handlers.onDelta?.(msg.text || "")
              else if (msg.type === "start") handlers.onStart?.(msg)
              else if (msg.type === "done") handlers.onDone?.(msg)
              else if (msg.type === "error") handlers.onError?.(msg)
            }
          }
        } catch (err) {
          if (err && err.name === "AbortError") return
          handlers.onError?.({ code: "E_NETWORK", message: String((err && err.message) || err) })
        }
      }
      run()
      return () => {
        try {
          ctrl.abort()
        } catch {
          /* ignore */
        }
      }
    }

    /** 去掉模型偶尔仍会带出来的 ``` 围栏。 */
    function stripFences(text) {
      const s = String(text || "").trim()
      const m = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(s)
      return m ? m[1] : s.replace(/^```[a-zA-Z0-9_-]*\n/, "").replace(/\n```$/, "")
    }

    /**
     * 内联 AI 条：输入指令 → 流式出结果 → diff 评审 → 接受/拒绝/接受并运行。
     * 交互契约（与 marimo / VS Code inline chat 对齐）：
     *   Mod-Enter 接受 / Esc 拒绝 / 再点"接受并运行"就顺手跑一遍。
     */
    function AiBar({ state, onInstruction, onCancel, onAccept, onAcceptRun, onRetry, CM, onToggleCtx, onToChat }) {
      const inputRef = React.useRef(null)
      React.useEffect(() => {
        if (state.open && inputRef.current && !state.streaming) inputRef.current.focus()
      }, [state.open, state.streaming])

      if (!state.open) return null
      const streaming = !!state.streaming
      const suggestion = state.text || ""
      const sel = state.selection || null
      // 选区级改写：diff 的「前」是选中的那几行，不是整格 —— 否则用户会以为整格都要被换掉
      const baseForDiff = sel ? String(sel.text || "") : state.baseCode || ""
      const diff = suggestion ? lineDiff(baseForDiff, stripFences(suggestion)) : null
      const stat = diff ? diffStat(diff) : { added: 0, removed: 0 }
      const ctx = state.ctx || {}
      const modeLabel = state.mode === "fix" ? "修错" : state.mode === "explain" ? "解释" : sel ? "局部改写" : "改写"

      return h(
        "div",
        {
          style: {
            margin: "4px 8px 8px",
            border: `1px solid ${ACCENT}`,
            borderRadius: 6,
            background: accentMix(6),
            fontSize: 11.5,
            overflow: "hidden",
          },
        },
        // 指令输入（右栏很窄时按钮换行，不要挤到输入框完全看不见）
        h(
          "div",
          { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, padding: "5px 8px" } },
          h("span", { style: { color: ACCENT, fontWeight: 650, flex: "none" } }, "✨ AI"),
          /**
           * 徽标：让用户一眼看到「这次改的是哪一块」。
           *  - 模式（局部改写 / 修错 / 解释）来自唤起入口；
           *  - 行号范围来自拖选（没有选区就不显示，避免噪声）。
           */
          h(
            "span",
            { style: { flex: "none", fontSize: 10, padding: "0 5px", borderRadius: 8, border: `1px solid ${accentMix(45)}`, color: ACCENT } },
            modeLabel + (sel ? ` · 第 ${sel.startLine + 1}–${sel.endLine + 1} 行` : ""),
          ),
          h("input", {
            ref: inputRef,
            defaultValue: state.instruction || "",
            placeholder: "让它做什么？（例：改成 scVI / 画柱状图 / 加异常处理）回车生成",
            onKeyDown: (e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                onInstruction(e.currentTarget.value)
              } else if (e.key === "Escape") {
                e.preventDefault()
                onCancel()
              }
            },
            style: {
              flex: "1 1 120px",
              minWidth: 80,
              border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
              borderRadius: 4,
              background: "var(--dsw-alias-bg-layer-1,transparent)",
              color: "inherit",
              padding: "3px 6px",
              fontSize: 11.5,
            },
          }),
          streaming
            ? h("button", { type: "button", style: toolbarBtn, onClick: onCancel }, "停止")
            : h("button", { type: "button", style: toolbarBtn, onClick: () => onInstruction(inputRef.current && inputRef.current.value) }, "生成"),
          /**
           * 「交给对话」（用户要求的主用法）：内联 AI 看不到整个项目的上下文，只能捧着
           * 这一格猜；主对话 agent 有工作区 + `nb_*` 工具，所以「需要看项目」的改写
           * 应该走这条 —— 把位置/现状/要求拼成提示词投进去，人不需要手抄代码。
           */
          streaming
            ? null
            : h(
                "button",
                {
                  type: "button",
                  title:
                    "把「位置 + 当前代码 + 上下文 + 你的要求」写成提示词投进左侧主对话，让有完整项目上下文的 agent 来改（内联 AI 看不到项目里的其它文件）",
                  style: { ...toolbarBtn, borderColor: ACCENT, color: ACCENT, flex: "none" },
                  onClick: () => onToChat && onToChat(inputRef.current ? inputRef.current.value : ""),
                },
                "💬 交给对话",
              ),
        ),

        /**
         * 上下文开关（Kernel-aware Prompt 的可见化）。
         *
         * 为什么要把「AI 拿到了什么上下文」显式列出来：用户无法判断模型知不知道 `df` 的列、
         * 知不知道上一格 import 了什么，于是只能靠猜；猜错了就以为「AI 很笨」。
         * 这里把它变成可点掉的胶囊，既是解释也是控制（关掉能省 token）。
         */
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 4, padding: "0 8px 5px", flexWrap: "wrap", fontSize: 10 } },
          h("span", { style: { opacity: 0.6, flex: "none" } }, "上下文"),
          ...[
            { key: "neighbours", label: `邻格 ${ctx.neighbours || 0}` },
            { key: "vars", label: `变量 ${ctx.vars || 0}` },
            { key: "error", label: "报错" },
          ]
            .filter((it) => (it.key === "error" ? !!ctx.error : (ctx[it.key] || 0) > 0))
            .map((it) =>
              h(
                "button",
                {
                  key: it.key,
                  type: "button",
                  title: it.key === "error" ? "把最近一次报错一起给模型" : "点击关闭这项上下文",
                  onClick: () => onToggleCtx && onToggleCtx(it.key),
                  style: {
                    ...miniBtn,
                    opacity: 1,
                    border: `1px solid ${accentMix(40)}`,
                    color: ACCENT,
                    padding: "0 5px",
                    borderRadius: 8,
                  },
                },
                `✓ ${it.label}`,
              ),
            ),
          ctx.error ? null : h("span", { style: { opacity: 0.45 } }, "无报错"),
        ),

        state.error
          ? h(
              "div",
              { style: { padding: "4px 8px 8px", color: "#ff9a9a" } },
              `${state.error.code || "错误"}：${state.error.message || ""}`,
              state.error.hint ? h("div", { style: { marginTop: 3, opacity: 0.75 } }, state.error.hint) : null,
            )
          : null,

        // 流式预览 / diff
        streaming || suggestion
          ? h(
              "div",
              { style: { borderTop: "1px solid color-mix(in srgb, currentColor 12%, transparent)" } },
              streaming
                ? h(
                    "pre",
                    { style: { ...preStyle, maxHeight: 220, background: "transparent", color: "var(--dsw-alias-label-secondary,currentColor)" } },
                    suggestion || "…",
                  )
                : h(
                    "div",
                    { style: { maxHeight: 260, overflow: "auto", fontFamily: FONT_MONO, fontSize: 11.5 } },
                    diff.map((op, idx) =>
                      h(
                        "div",
                        {
                          key: idx,
                          style: {
                            display: "flex",
                            gap: 6,
                            padding: "0 8px",
                            background: op.op === "add" ? "color-mix(in srgb, #3fa23a 18%, transparent)" : op.op === "del" ? "color-mix(in srgb, #f14c4c 18%, transparent)" : "transparent",
                            whiteSpace: "pre-wrap",
                          },
                        },
                        h("span", { style: { width: 10, flex: "none", opacity: 0.7 } }, op.op === "add" ? "+" : op.op === "del" ? "−" : " "),
                        h("span", { style: { flex: 1 } }, op.text || " "),
                      ),
                    ),
                  ),
            )
          : null,

        // 动作
        suggestion && !streaming
          ? h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderTop: "1px solid color-mix(in srgb, currentColor 12%, transparent)" } },
              h("span", { style: { fontSize: 10.5, opacity: 0.7, fontFamily: FONT_MONO } }, `+${stat.added} −${stat.removed} · ${state.ms || 0}ms`),
              h("span", { style: { flex: 1 } }),
              h("button", { type: "button", style: { ...toolbarBtn, borderColor: "#3fa23a", color: "#3fa23a" }, onClick: onAccept }, "接受 (Mod-↵)"),
              h("button", { type: "button", style: toolbarBtn, onClick: () => onAcceptRun() }, "接受并运行"),
              h("button", { type: "button", style: toolbarBtn, onClick: onRetry }, "重试"),
              h("button", { type: "button", style: toolbarBtn, onClick: onCancel }, "拒绝 (Esc)"),
            )
          : null,
      )
    }


    /**
     * 执行耗时的**人类可读**写法。
     * 用户 2026-11-10 的原话是「代码运行的时候我不知道有没有运行」——
     * 所以运行态必须能看见「已经跑了多久」，而不是只有一个静止的 ▶。
     */
    function formatElapsed(ms) {
      if (!(ms >= 0)) return ""
      if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
      if (ms < 60000) return `${Math.round(ms / 1000)}s`
      const m = Math.floor(ms / 60000)
      const s = Math.round((ms % 60000) / 1000)
      if (s === 60) return `${m + 1}m`
      return `${m}m${String(s).padStart(2, "0")}s`
    }

    function statusGlyph(cell) {
      if (cell.status === "running") return "◐"
      if (cell.status === "queued") return "…"
      if (cell.status === "error") return "✗"
      if (cell.status === "cancelled") return "⊘"
      if (cell.execCount !== null && cell.execCount !== undefined) return `[${cell.execCount}]`
      return "[ ]"
    }

    function CellView({ cell, index, total, CM, sid, onChange, onChangeType, onRun, onRunBelow, onRunInsert, onSave, onAddAfter, onDelete, onMove, selected, onSelect, onSelectSibling, ai, aiHandlers, ghost, onCiteCell, onCiteSelection, onSelectionChange, flash, onEditorReady, focusReq, onNotice, onCellContextMenu, foldLevel, folded, hiddenCount, onToggleFold }) {
      // focusMode 三态（照 VS Code 的 CellFocusMode 简化）：编辑器里 / 格容器上
      const [focusMode, setFocusMode] = React.useState("container")
      // markdown 格：默认渲染，**双击**进编辑（单击只选中本格）
      const [mdEditing, setMdEditing] = React.useState(false)
      const apiRef = React.useRef(null)
      const wrapRef = React.useRef(null)
      const running = cell.status === "running"
      const queued = cell.status === "queued"
      const cellType = normalizeCellType(cell.cellType)
      const isDoc = cellType === "markdown" || cellType === "raw"
      /**
       * 运行计时：只有本格在跑时才起 500ms 心跳（不在跑不设 timer，不会 9 格空转）。
       * 起点取 `cell.startedAt`（服务端写的时间戳），所以右栏切走再回来也不会归零。
       */
      const [tickAt, setTickAt] = React.useState(0)
      React.useEffect(() => {
        if (!running) return undefined
        setTickAt(Date.now())
        const timer = setInterval(() => setTickAt(Date.now()), 500)
        return () => clearInterval(timer)
      }, [running, cell.id])
      const elapsedMs = running && cell.startedAt ? Math.max(0, (tickAt || Date.now()) - cell.startedAt) : 0

      /** 事件落点判定：这三条分支决定了「能不能打字」。 */
      const hit = (target) => {
        const t = target
        const closest = t && typeof t.closest === "function" ? (sel) => t.closest(sel) : () => null
        return {
          inEditor: !!closest(".cm-editor"),
          inGutter: !!closest("[data-nb2-gutter]"),
          inControl: !!closest("button,select,input,textarea,a,option,label"),
          inOutput: !!closest("[data-nb2-output]"),
        }
      }

      /**
       * 容器态键盘：不碰鼠标也要能「进格 / 运行 / 删格 / 上下移动」。
       * 这是 M2 验收「不碰鼠标完成 新建→写两格→插一格→删一格→运行→保存」的地基。
       * 编辑态下这些键交给 CM6（它自己绑了 Shift/Ctrl/Alt-Enter）。
       */
      const onKeyDown = (e) => {
        const h2 = hit(e.target)
        const stop = () => {
          e.preventDefault()
          e.stopPropagation()
        }
        /**
         * ⚠️ 顺序定理（三条都是真机 bug 的修复点，别调回去）：
         *
         * ① 「焦点在编辑器里就放行」必须**还是第一个**。
         *    CM 自己的 keymap 已经处理了 Shift/Ctrl/Mod/Alt-Enter，而且它只
         *    `preventDefault()` 不 `stopPropagation()` —— 事件还会冒泡到这里。
         *    把 Enter 组合放到这道闸之前，同一次按键就会**跑两遍**。
         *
         * ② Enter 组合必须排在 `inControl` **之前**。
         *    早先 `if (h2.inControl) return` 排在最前面 —— 焦点落在格内任意按钮上
         *    （点过 ▶ 就会）之后，所有 Enter 组合键全死，用户看到的就是
         *    「左 Shift-Enter 没有自动运行」。现在先判组合键，再判控件。
         *
         * ③ Shift-Enter 必须排在普通 Enter 之前。
         *    早先写成「先 Enter → enterEdit；再 Enter && shiftKey → 运行并下移」，
         *    后者是**永远不可达的死分支**。
         *
         * 面板根节点还有一层 capture 分发器（decideCellKey）：它在 capture 阶段就
         * `stopPropagation`，所以非编辑器位置不会被这里再处理一遍。
         */
        if (shouldIgnoreContainerKey({ inEditor: h2.inEditor, focusMode })) return
        if (e.key === "Enter" && e.shiftKey) {
          stop()
          onRunBelow()
          return
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          stop()
          onRun()
          return
        }
        if (e.key === "Enter" && e.altKey) {
          stop()
          onRunInsert()
          return
        }
        // 焦点落在格内按钮/下拉/输入框上时也不接管剩余容器键位：否则在按钮上按 Backspace 会删掉整格
        if (h2.inControl) return
        if (e.key === "Enter" || e.key === "F2") {
          stop()
          enterEdit()
          return
        }
        if (e.key === "ArrowDown") {
          stop()
          onSelectSibling(1)
          return
        }
        if (e.key === "ArrowUp") {
          stop()
          onSelectSibling(-1)
          return
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          stop()
          onDelete()
          return
        }
        if (e.key === "Escape") {
          stop()
          setFocusMode("container")
          if (wrapRef.current) wrapRef.current.focus()
        }
      }

      /**
       * 进编辑态。
       * @param {{line?:number}} [info] markdown 渲染区点进来时带上「粗略估算的源码行号」
       *   （P1 5.7：光标落在点击的大致位置，而不是永远回到文首）
       */
      const enterEdit = (info) => {
        setFocusMode("editor")
        setMdEditing(true)
        if (apiRef.current) apiRef.current.focus()
        const line = info && Number(info.line) > 0 ? Number(info.line) : 0
        if (line > 0) {
          // 编辑器是这一刻才挂载的（apiRef 还是 null）→ 等一拍再放光标
          setTimeout(() => {
            const api = apiRef.current
            if (api && typeof api.setCursorLine === "function") api.setCursorLine(line)
          }, 0)
        }
      }

      /**
       * 「新增/跳转后聚焦本格」请求（P0 5.1 + 5.3）。
       *
       * 面板只传一个 `{cellId, at}` 下来；本格拿到 focusReq 就自己进编辑态并聚焦。
       * `at` 是面板的单调序号（不是时间戳），保证同一格连续两次请求也会重新触发 effect。
       * `wantFocusRef` 让「格刚挂载、编辑器还没 ready」的情况也能补一次聚焦（见 onReady）。
       */
      const wantFocusRef = React.useRef(0)
      const focusAt = focusReq && focusReq.cellId === cell.id ? focusReq.at : 0
      React.useEffect(() => {
        if (!focusAt) return undefined
        wantFocusRef.current = focusAt
        setFocusMode("editor")
        // markdown/raw 的编辑视图要显式打开（否则 apiRef 永远是 null，聚焦打空）
        setMdEditing(true)
        const t = setTimeout(() => {
          if (wantFocusRef.current !== focusAt) return
          const api = apiRef.current
          if (api) {
            wantFocusRef.current = 0
            api.focus()
          }
        }, 0)
        return () => clearTimeout(t)
      }, [focusAt])

      /**
       * markdown 格从「渲染视图」切到「编辑视图」时，CellEditor 是这一刻才挂载的，
       * 所以 enterEdit() 里那次 apiRef.current.focus() 打空（ref 还是 null）。
       * 结果就是「点一下进入编辑但没有光标，得再点一次」—— 这里补上延迟聚焦。
       */
      React.useEffect(() => {
        if (!mdEditing) return
        if (focusMode !== "editor") return
        const t = setTimeout(() => {
          if (apiRef.current) apiRef.current.focus()
        }, 0)
        return () => clearTimeout(t)
      }, [mdEditing, focusMode])

      const editorProps = {
        CM,
        // 传下去给 ghost 用：面板据此挑「这一格之前」的格作为跨格上下文
        cellId: cell.id,
        value: cell.source,
        onChange,
        /**
         * doc 格（markdown / raw）的「运行」= **提交编辑态 → 渲染**。
         *
         * 为什么必须在这里复位：doc 格在编辑时复用同一个 CM6 编辑器，渲染与否只由
         * `mdEditing` 决定。早先只有「完成」按钮同时做了 `setMdEditing(false)` + 运行，
         * 于是 Shift-Enter / Ctrl-Enter 跑完仍是源码视图 —— 用户看到的就是
         * 「按 Shift-Enter 没有渲染，必须点完成」。
         */
        onRun: () => {
          if (isDoc) setMdEditing(false)
          onRun()
        },
        onRunBelow: () => {
          if (isDoc) setMdEditing(false)
          onRunBelow()
        },
        onRunInsert,
        onSave,
        autoFocus: false,
        onReady: (api) => {
          apiRef.current = api
          // 把「当前选中格」的编辑器 API 回填到面板（选区级改写要用它 dispatch）
          if (onEditorReady) onEditorReady(cell.id, api)
          // 格刚挂载就有待处理聚焦请求 → 现在就聚焦（不用等下一拍，用户感觉是「立刻能打字」）
          if (api && wantFocusRef.current) {
            wantFocusRef.current = 0
            api.focus()
          }
        },
        // Mod-K：唤起本格的 AI 指令条（带上选区 → 选区级局部改写）
        onAi: (sel) => aiHandlers && aiHandlers.open(cell.id, cell.source, { selection: sel }),
        // 选区变化 → 面板决定是否弹浮动条（这里只转发，不自己判断）
        onSelectionChange: (sel, coords) => onSelectionChange && onSelectionChange(cell.id, sel, coords),
        // AI 自动补全（markdown / raw 格不补全：那里补的是散文，不是代码）
        ghost: ghost && (cellType === "code" || cellType === "bash") ? ghost : null,
        // Esc：编辑器 → 容器（并真的把焦点交回格子，不然键盘就"丢"了）
        onEscape: () => {
          setFocusMode("container")
          setMdEditing(false)
          if (apiRef.current) apiRef.current.blur()
          if (wrapRef.current) wrapRef.current.focus()
        },
      }

      return h(
        "div",
        {
          ref: wrapRef,
          "data-cell-id": cell.id,
          tabIndex: 0,
          onKeyDown,
          /**
           * 右键：先选中本格，再把坐标交给面板弹上下文菜单（Jupyter 标配）。
           * 必须 `preventDefault`，否则 Electron/Chromium 会弹自己的网页菜单。
           */
          onContextMenu: (e) => {
            e.preventDefault()
            e.stopPropagation()
            if (onSelect) onSelect(cell.id)
            if (onCellContextMenu) onCellContextMenu(cell, e.clientX, e.clientY)
          },
          // React 的 onFocus 是 focusin 语义（会冒泡），所以编辑器拿到焦点时这里也能收到。
          // 鼠标点进去时不会有 Enter/F2，编辑态得靠这个跟上；顺带选中本格。
          // （注意：不要用 onFocusIn —— 那不是 React 支持的 prop。）
          onFocus: (e) => {
            onSelect(cell.id)
            if (hit(e.target).inEditor) setFocusMode("editor")
          },
          /**
           * ⚠️ 这里曾经无条件 `wrapRef.current.focus()`：点击从 CM6 冒泡上来，
           * 焦点被容器抢走，用户就「打不了字」。现在按落点分流。
           */
          onClick: (e) => {
            onSelect(cell.id)
            const h2 = hit(e.target)
            const action = resolveCellClick(h2)
            if (action === "self" || action === "editor-self") return
            if (action === "container") {
              setFocusMode("container")
              setMdEditing(false)
              if (wrapRef.current) wrapRef.current.focus()
              return
            }
            enterEdit()
          },
          style: {
            display: "flex",
            alignItems: "stretch",
            /**
             * 运行中必须**在余光里就能看见**：左侧改成黄条 + 淡黄底（选中仍是强调色）。
             * 只靠左槽那个小字形不够 —— 用户就是这么漏看的（2026-11-10）。
             */
            borderLeft: `3px solid ${running ? RUNNING_COLOR : selected ? ACCENT : "transparent"}`,
            background: running ? "color-mix(in srgb, #cca700 12%, transparent)" : selected ? accentMix(5) : "transparent",
            padding: "2px 6px 2px 0",
            outline: "none",
          },
          // Agent 改格后的一次性闪烁（1.2s）：让用户看清 AI 正在改哪一格
          className: flash ? "nb2-flash" : undefined,
        },
        // 左侧：执行序号 + 状态
        h(
          "div",
          {
            // 点击这块 = 进容器态（选中整格，方向键/删除可用）；点正文才进编辑
            "data-nb2-gutter": "1",
            style: {
              width: 46,
              flex: "none",
              textAlign: "right",
              padding: "6px 6px 0 0",
              fontFamily: FONT_MONO,
              fontSize: 10.5,
              color: cell.status === "error" ? "#ff8a8a" : running ? "#cca700" : "color-mix(in srgb, currentColor 55%, transparent)",
              userSelect: "none",
              cursor: "default",
            },
          },
          /**
           * 章节折叠把手（VS Code 的 chevron）。
           *
           * 只有「本身是标题格、且下面真的还有格」才出现 —— 大标题定完就是文末时，
           * 给个能折却什么都没折的按钮只会让人以为坏了。
           * 放在左槽位而不是正文第一行：正文行首是 `#` 号的位置，塞个箭头会跟标题
           * 字符打架；槽位本来就是纯元数据区（执行序号/耗时），语义一致。
           */
          foldLevel > 0 && hiddenCount > 0
            ? h(
                "div",
                { style: { display: "flex", justifyContent: "flex-end", gap: 2 } },
                h(
                  "button",
                  {
                    type: "button",
                    "data-nb2-fold": "1",
                    title: folded ? `展开本节（下面 ${hiddenCount} 格）` : `折叠本节标题以下的 ${hiddenCount} 格`,
                    "aria-expanded": folded ? "false" : "true",
                    "aria-label": folded ? "展开本节" : "折叠本节",
                    onClick: (e) => {
                      // 不 stopPropagation：这一下顺带选中本格（折叠后它必须是选中的那一格）
                      if (onToggleFold) onToggleFold(cell.id)
                      if (e && typeof e.preventDefault === "function") e.preventDefault()
                    },
                    style: {
                      ...miniBtn,
                      // 实测（2026-11-04，真机截图比对）：字号 10 + padding 0 时这个 ▾ 只有
                      // ~5×5 px，用户根本点不到，也看不见。折叠是导航操作，必须够大够亮。
                      padding: "1px 3px",
                      lineHeight: 1,
                      fontSize: 13,
                      minWidth: 16,
                      minHeight: 16,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      opacity: folded ? 1 : 0.85,
                      color: folded ? ACCENT : "inherit",
                    },
                  },
                  folded ? "▸" : "▾",
                ),
              )
            : null,
          h("div", { className: running ? "nb2-spin" : undefined, style: running ? { color: RUNNING_COLOR } : null }, statusGlyph(cell)),
          running
            ? h(
                "div",
                {
                  title: `正在执行：已跑 ${formatElapsed(elapsedMs)}${cell.execCount ? `（第 ${cell.execCount} 次执行）` : ""}`,
                  style: { fontSize: 9, fontWeight: 600, color: RUNNING_COLOR, whiteSpace: "nowrap" },
                },
                formatElapsed(elapsedMs),
              )
            : cell.durationMs
              ? h("div", { style: { fontSize: 9, opacity: 0.6 } }, `${Math.round(cell.durationMs)}ms`)
              : queued
                ? h("div", { style: { fontSize: 9, opacity: 0.6 } }, "排队")
                : null,
        ),

        // 主体
        h(
          "div",
          { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" } },
          // 小工具条：类型 / 运行 / 删除 / 上移下移（容器态下操作）
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 2, opacity: selected || focusMode !== "editor" ? 1 : 0.35 } },
            h(
              "select",
              {
                title: "单元格类型",
                value: cellType,
                onChange: (e) => {
                  const next = e.target.value
                  if (onChangeType) onChangeType(cell.id, next)
                  setMdEditing(false)
                },
                style: cellTypeSelectStyle,
              },
              ["code", "markdown", "bash", "raw"].map((t) =>
                h("option", { key: t, value: t }, CELL_TYPE_LABELS[t] || t),
              ),
            ),
            h("button", { type: "button", title: "运行 (Ctrl-Enter)", onClick: (e) => { e.stopPropagation(); onRun() }, style: miniBtn }, cellType === "bash" ? "▶ sh" : "▶"),
            h("button", { type: "button", title: "运行并在下方插入", onClick: (e) => { e.stopPropagation(); onAddAfter(true) }, style: miniBtn }, "▶+"),
            h("span", { style: { flex: 1 } }),
            isDoc && mdEditing
              ? h(
                  "button",
                  {
                    type: "button",
                    title: "渲染并跳到下一格 (Shift-Enter)",
                    onClick: (e) => {
                      e.stopPropagation()
                      setMdEditing(false)
                      onRunBelow()
                    },
                    style: miniBtn,
                  },
                  "完成",
                )
              : null,
            /**
             * ✨ AI：内联 AI 的**显性入口**。
             *
             * 之前只有隐藏的 Mod-K，用户根本不知道这格能叫 AI（反馈原文：「连一个可见的
             * ✨AI 入口按钮都没有」）。这里必须给可见按钮 + 快捷键提示。
             */
            h(
              "button",
              {
                type: "button",
                title: "内联 AI：让 AI 改写/解释本格（Mod-K；选中几行则只改那几行）",
                onClick: (e) => {
                  e.stopPropagation()
                  const api = apiRef.current
                  const sel = api && api.getSelection ? api.getSelection() : null
                  if (aiHandlers) aiHandlers.open(cell.id, cell.source, { selection: sel })
                },
                style: { ...miniBtn, opacity: 0.9 },
              },
              "✨ AI",
            ),
            /**
             * 💬：把本格（源码 + 最近输出/报错摘要）投递到左侧主对话。
             * 这是「Notebook 与主 Agent 割裂」最直接的解法 —— 不用复制粘贴。
             */
            h(
              "button",
              {
                type: "button",
                title: "把本格引用到主对话（源码 + 最近输出摘要）",
                onClick: (e) => {
                  e.stopPropagation()
                  if (onCiteCell) onCiteCell(cell)
                },
                style: { ...miniBtn, opacity: 0.9 },
              },
              "💬",
            ),
            h("button", { type: "button", title: "上移", onClick: (e) => { e.stopPropagation(); onMove(-1) }, style: miniBtn }, "↑"),
            h("button", { type: "button", title: "下移", onClick: (e) => { e.stopPropagation(); onMove(1) }, style: miniBtn }, "↓"),
            h("button", { type: "button", title: "删除本格", onClick: (e) => { e.stopPropagation(); onDelete() }, style: miniBtn }, "✕"),
          ),

          // 编辑区
          //  · markdown：marked + DOMPurify 渲染（表格/任务列表/嵌套列表/分割线/公式），双击进编辑
          //  · raw：等宽纯文本预览，同样双击进编辑
          //  · code / bash：常驻编辑器
          isDoc && !mdEditing && String(cell.source).trim()
            ? cellType === "markdown"
              ? h(MarkdownView, {
                  source: cell.source,
                  CM,
                  sid,
                  cellId: cell.id,
                  onEdit: (info) => enterEdit(info),
                  onSelect,
                  onSelectionChange,
                })
              : h(
                  "div",
                  {
                    title: "双击编辑（Esc 退出）",
                    // 与 markdown 渲染态一致：单击只选中本格，双击才进编辑
                    onClick: (e) => {
                      e.stopPropagation()
                      if (onSelect) onSelect(cell.id)
                    },
                    onDoubleClick: (e) => {
                      e.stopPropagation()
                      onSelect(cell.id)
                      enterEdit()
                    },
                    // raw 预览区拖选：同样要能「一键丢进对话」
                    onMouseUp: () => {
                      if (!onSelectionChange) return
                      const info = readDomSelection()
                      onSelectionChange(cell.id, info ? info.selection : null, info ? info.coords : null, { kind: "markdown" })
                    },
                    style: { padding: "4px 10px 6px", cursor: "text", minHeight: 24 },
                  },
                  h("pre", { style: { ...preStyle, padding: 0, whiteSpace: "pre-wrap" } }, cell.source),
                )
            : cellType === "bash"
              ? h(
                  "div",
                  { style: { display: "flex", alignItems: "stretch", gap: 4 } },
                  h(
                    "div",
                    { style: { flex: "none", padding: "8px 0 0 8px", fontFamily: FONT_MONO, fontSize: 12, opacity: 0.5, userSelect: "none" } },
                    "$",
                  ),
                  h("div", { style: { flex: 1, minWidth: 0 } }, h(CellEditor, editorProps)),
                )
              : h(CellEditor, editorProps),

          // 内联 AI（M4）：指令 → 流式 → diff 评审
          ai ? h(AiBar, Object.assign({ state: ai, CM }, aiHandlers.bar(cell.id, cell.source))) : null,

          // 输出
          cell.outputs && cell.outputs.length
            ? h(
                "div",
                {
                  // 打标记：点击输出区不该把焦点抢进编辑器（否则选不中、复制不了）
                  "data-nb2-output": "1",
                  /**
                   * 输出区（stdout / traceback）里的拖选也要弹浮动条。
                   * CM6 那边靠 EditorView.updateListener；普通 DOM 只能靠 mouseup + window.getSelection()。
                   */
                  onMouseUp: () => {
                    if (!onSelectionChange) return
                    const info = readDomSelection()
                    onSelectionChange(cell.id, info ? info.selection : null, info ? info.coords : null, { kind: "output" })
                  },
                  style: {
                    margin: "2px 8px 8px",
                    borderTop: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
                    fontSize: 12,
                  },
                },
                cell.outputs.map((block, bi) => {
                  const copyable = outputCopyText(block)
                  return h(
                    "div",
                    { key: block.id || bi, className: "nb2-out" },
                    h(OutputBlockView, {
                      block,
                      CM,
                      // 报错块的一键动作：内联快修 / 发给主对话
                      onFixError: (errBlock) => aiHandlers && aiHandlers.fix(cell.id, cell.source, errBlock),
                      onCiteError: (errBlock) => onCiteSelection && onCiteSelection(cell.id, null, { kind: "error", output: errBlock }),
                    }),
                    /**
                     * 输出区「复制」按钮（P1 5.6）。做在 wrapper 上而不是改 OutputBlockView
                     * 的每个分支：否则要在 stream/error/display/纯文本四处各写一遍，还会漏。
                     * 图片 / HTML 输出不给复制（复制一段 base64 没有意义）。
                     */
                    copyable
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "nb2-out-copy",
                            title: "复制这段输出",
                            onClick: (e) => {
                              e.stopPropagation()
                              copyToClipboard(copyable, (ok) => {
                                if (onNotice) onNotice(ok ? "已复制输出" : "复制失败（浏览器拒绝了剪贴板访问）")
                              })
                            },
                          },
                          "⧉",
                        )
                      : null,
                  )
                }),
              )
            : null,
        ),
      )
    }

    const miniBtn = {
      border: "0",
      background: "transparent",
      color: "inherit",
      opacity: 0.75,
      cursor: "pointer",
      fontSize: 11,
      padding: "2px 4px",
      borderRadius: 3,
      fontFamily: FONT_MONO,
    }

    /** 设置栏里的小数字输入框（防抖 ms / 最大行数）——窄面板里必须能压缩。 */
    const numInputStyle = {
      border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
      background: "transparent",
      color: "inherit",
      borderRadius: 3,
      fontSize: 10.5,
      padding: "0 2px",
      fontFamily: FONT_MONO,
      width: 46,
      flex: "none",
    }

    const cellTypeSelectStyle = {
      border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
      background: "transparent",
      color: "inherit",
      borderRadius: 3,
      fontSize: 10.5,
      padding: "0 2px",
      fontFamily: FONT_MONO,
      cursor: "pointer",
      flex: "none",
    }

    const toolbarBtn = {
      border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
      background: "var(--dsw-alias-bg-layer-2,transparent)",
      color: "inherit",
      borderRadius: 4,
      padding: "2px 8px",
      fontSize: 11,
      cursor: "pointer",
      flex: "none",
      whiteSpace: "nowrap",
    }

    /** 空态的两个大按钮（P0 5.4）。 */
    const emptyBtn = {
      border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
      background: "var(--dsw-alias-bg-layer-2,transparent)",
      color: "inherit",
      borderRadius: 6,
      padding: "10px 16px",
      fontSize: 12.5,
      cursor: "pointer",
      fontWeight: 600,
      minWidth: 130,
    }

    /** 工具栏分组分隔线。 */
    const toolbarGroupSep = { width: 1, height: 16, background: "var(--dsw-alias-border-l2,#333)", margin: "0 2px", flex: "none" }

    /** `⋯` 溢出菜单里的条目。 */
    const menuItem = {
      border: "1px solid transparent",
      background: "transparent",
      color: "inherit",
      borderRadius: 4,
      padding: "3px 8px",
      fontSize: 11,
      cursor: "pointer",
      textAlign: "left",
      whiteSpace: "nowrap",
      fontFamily: FONT_UI,
    }

    const kernelSelectStyle = {
      border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
      background: "var(--dsw-alias-bg-layer-2,transparent)",
      color: "inherit",
      borderRadius: 4,
      padding: "1px 4px",
      fontSize: 10.5,
      maxWidth: 170,
      flex: "0 1 auto",
    }

    /** 路径太长时只留尾部两段，`…/envs/ML-LLM-base` 这种反而更好认。 */
    function shortPath(p) {
      const s = String(p || "")
      if (!s) return "工作目录"
      const parts = s.split(/[\\/]/).filter(Boolean)
      if (parts.length <= 2) return s
      return `…/${parts.slice(-2).join("/")}`
    }

    /**
     * 客户端插件 ctx（`apply(ctx)` 时注入）。
     *
     * 为什么要在模块级存一份：面板组件是纯函数组件，拿不到 apply 的 ctx；
     * 而「往主对话输入框写东西」必须用**会话作用域的 client 服务**
     * （`ctx.sessions.scope(sid)` + `ctx.get("conversation")`），这两样都在 ctx 上。
     * `dsh-better-sidebar` 是同样的做法（把 ctx 一路传进 appendToDraft）。
     */
    let pluginCtx = null

    /**
     * 把「笔记本 + cell 序号 + 行范围」格式化成结构化定位串（纯函数，可单测）。
     *
     * 口径（与 UI 左侧 `[ ]` 显示一致）：
     *  · `cellIndex` —— **1-based** 显示序号，不是内部 cellId；
     *  · `startLine` / `endLine` —— cell 内 **1-based** 行号，与 CM6 gutter 一致；
     *  · 行号未知就**只给 cell**，绝不瞎猜（`linesOfSelection` 那种 DOM 反查经常失败）。
     *
     * @returns {{base:string, rel:string, label:string, modelForm:string}}
     *  · `label`     —— 芯片上显示的文字（自由文本），如 `nb.ipynb#Cell[3]:L4-L8`
     *  · `modelForm` —— 模型真正看到的文本，如 `@dir/nb.ipynb (Cell[3] L4-L8)`
     */
    function formatNotebookRef(spec) {
      const s = spec || {}
      const raw = String(s.path || "").trim().replace(/\\/g, "/")
      const base = raw ? raw.split("/").pop() : "notebook.ipynb"
      const rel = raw || base
      const cell = Number(s.cellIndex)
      const hasCell = Number.isFinite(cell) && cell > 0
      const a = Number(s.startLine)
      const b = Number(s.endLine)
      // 行号只有「起点有效」才写；终点无效就只写起点，绝不编造终点
      const lineRange = Number.isFinite(a) && a > 0 ? (Number.isFinite(b) && b >= a ? `L${a}-L${b}` : `L${a}`) : ""
      const kindSuffix = s.kind === "output" ? ".output" : s.kind === "error" ? ".error" : ""
      if (!hasCell) return { base, rel, label: base, modelForm: `@${rel}` }
      const label = `${base}#Cell[${cell}]${lineRange ? `:${lineRange}` : ""}${kindSuffix}`
      const inner = `Cell[${cell}]${lineRange ? ` ${lineRange}` : ""}${kindSuffix}`
      return { base, rel, label, modelForm: `@${rel} (${inner})` }
    }

    /**
     * 绝对路径 → 工作区相对路径，专供对话里的 `@` 文件引用（纯函数，可单测）。
     *
     * 为什么不用绝对路径当引用：DSH 的 `@` 引用是按工作区解析的（用户从 @ 菜单选文件
     * 拿到的就是相对路径），相对路径更短，芯片 label 也干净。绝对路径虽然也认，
     * 但在消息里是一长串盘符路径。
     *
     * 不在工作区里 → 返回空串，调用方退回绝对路径：宁可长一点，也不给一个点不开的引用。
     */
    function workspaceRelativeMention(path, cwd) {
      const p = String(path || "").trim().replace(/\\/g, "/")
      const c = String(cwd || "").trim().replace(/\\/g, "/").replace(/\/+$/, "")
      if (!p || !c) return ""
      // Windows 盘符路径大小写不敏感；POSIX 敏感
      const win = /^[A-Za-z]:\//.test(p) || /^[A-Za-z]:\//.test(c)
      const key = win ? p.toLowerCase() : p
      const base = win ? c.toLowerCase() : c
      if (!key.startsWith(base + "/")) return ""
      return p.slice(c.length + 1)
    }

    /** 异常 → 一行文字（只给诊断提示用，永不再抛）。 */
    function errorTextOf(e) {      try {
        if (e && typeof e.message === "string" && e.message) return e.message
        return String(e)
      } catch {
        return "unknown"
      }
    }

    /** slot props 里 `InputActions` 公开的方法（0.2.1-rc.5 实测清单）。 */
    const INPUT_ACTION_METHODS = [
      "insertQuote",
      "captureInsertion",
      "insertText",
      "setDraft",
      "persistDraft",
      "addAttachments",
      "removeAttachment",
      "pruneAttachments",
      "submit",
    ]

    /** `inputActions` 的能力清单（纯函数，可单测）。 */
    function inputActionsCaps(actions) {
      const a = actions || null
      const has = (name) => !!a && typeof a[name] === "function"
      return {
        present: !!a,
        methods: INPUT_ACTION_METHODS.filter(has),
        canInsertText: has("captureInsertion") && has("insertText"),
        canQuote: has("insertQuote"),
        canSetDraft: has("setDraft"),
      }
    }

    /**
     * 把一段文本投进左侧主对话的输入框 —— **0.2.1-rc.5 唯一实测可用的通道**。
     *
     * 为什么不是别的东西（2026-11-06 实测，推翻上一轮调研结论）：
     *  · 客户端 service 目录里**没有 `conversation`**（只有 layout / locale / sessions /
     *    slots / theme / timer / uiWorkspace / workspaces），`ctx.get("conversation")`
     *    恒为 undefined，所以「会话桥 + slash/input-insert-reference」这条路在本版**根本走不通**；
     *  · slot props 的 `inputActions` 才是公开且有实现的面：`captureInsertion()` 给出
     *    `{start, end, draftRev}`，`insertText(text, span)` 走 `$replaceDetectSpanWithText`
     *    真的把字插进 Lexical 编辑器 —— 不是 `setDraft` 那种整体替换，吃不掉用户已打的字。
     *
     * @param {{captureInsertion?:Function, insertText?:Function}} actions `props.inputActions`
     * @param {string} text
     * @param {{tries?:number}} [opts] 重试次数（rev 竞态：capture 与 insert 之间用户敲了字）
     * @returns {{ok:boolean, layer:string, reason:string}}
     */
    function deliverInputText(actions, text, opts) {
      const body = String(text == null ? "" : text)
      if (!body.trim()) return { ok: false, layer: "empty", reason: "内容为空" }
      const caps = inputActionsCaps(actions)
      if (!caps.present) {
        return { ok: false, layer: "no-actions", reason: "本挂载点没有对话输入框（slot props 里没有 inputActions）" }
      }
      if (!caps.canInsertText) {
        const have = caps.methods.length ? caps.methods.join("/") : "无"
        return { ok: false, layer: "no-insertText", reason: `输入框 facade 缺 captureInsertion/insertText（现有：${have}）` }
      }
      const tries = Math.max(1, Number((opts && opts.tries) || 2))
      let reason = ""
      for (let i = 0; i < tries; i += 1) {
        let span = null
        try {
          span = actions.captureInsertion()
        } catch (e) {
          span = null
          reason = `captureInsertion 抛错：${errorTextOf(e)}`
        }
        if (!span || typeof span !== "object") {
          reason = reason || "captureInsertion 没给出插入位置"
          continue
        }
        let applied = false
        try {
          applied = actions.insertText(body, span) === true
        } catch (e) {
          applied = false
          reason = `insertText 抛错：${errorTextOf(e)}`
        }
        if (applied) return { ok: true, layer: "insertText", reason: "" }
        reason = reason || "insertText 被拒（草稿版本已变或正在提交）"
      }
      return { ok: false, layer: "insertText-refused", reason }
    }

    /** 多行文本截断（提示词里贴代码用，避免把整格 5000 行灌进对话）。 */
    function clipText(text, maxLines, maxChars) {
      const raw = String(text == null ? "" : text)
      if (!raw) return ""
      const lines = raw.split("\n")
      const head = lines.slice(0, Math.max(1, maxLines)).join("\n")
      const cut = head.length > maxChars ? head.slice(0, Math.max(1, maxChars)) : head
      if (cut === raw) return raw
      return `${cut}\n…（已截断，原文共 ${lines.length} 行）`
    }

    /**
     * 「交给主对话去改」的提示词（纯函数，可单测）。
     *
     * 为什么要有这条路（用户原话）：「AI 改写它看不到我的整个项目的上下文 …… 还不如用
     * 提示词法到对话框里让人家给改」。内联 AI 只拿到本格 + 邻格 + 变量/报错摘要，
     * 工作区里的其它文件、文档、约定它一概不知；主对话 agent 有完整上下文和 `nb_*` 工具，
     * 让它改才是对的。
     *
     * 内容刻意压到很短（用户 2026-11-11：「要不对话框内太长了」）：
     * 顶格的 `@定位` + 要求 + 选区（agent 读不到的唯一东西）+ 一行报错 + 动手方式。
     * 整格源码、邻格、变量列表都不贴 —— agent 用 `nb_get` / `nb_list_vars` 自己拿。
     *
     * @param {{path?:string,mentionPath?:string,cellIndex?:number,cellType?:string,language?:string,
     *          source?:string,selection?:{startLine:number,endLine:number,text:string}|null,
     *          instruction?:string,mode?:string,error?:object|null}} spec
     * @returns {string}
     */
    function buildChatPrompt(spec) {
      const s = spec || {}
      const mode = ["explain", "fix", "rewrite-selection", "rewrite"].indexOf(String(s.mode)) >= 0 ? String(s.mode) : "rewrite"
      const rawPath = String(s.path || "").trim()
      const slashPath = rawPath.replace(/\\/g, "/")
      const cellIndex = Number(s.cellIndex)
      const hasCell = Number.isFinite(cellIndex) && cellIndex > 0
      const startLine = Number(s.selection && s.selection.startLine)
      const endLine = Number(s.selection && s.selection.endLine)
      const hasRange = Number.isFinite(startLine) && startLine >= 0
      const rangeText = hasRange
        ? Number.isFinite(endLine) && endLine > startLine
          ? `第 ${startLine + 1}–${endLine + 1} 行`
          : `第 ${startLine + 1} 行`
        : ""
      const language = String(s.language || "python")
      const instruction = String(s.instruction || "").trim()
      const fence = "```"

      /**
       * 第一行必须是 `@<路径> (Cell[n] Lx-Ly)`，并且**顶格**。
       *
       * 为什么：DSH 的两套渲染规则都以「行首或空白后的 `@path`」为触发条件
       * （输入框 `PATH_TOKEN_RE = /(^|\s)(@(?:"[^"\n]*"?|[^\s"]\S*))/g` + `PATH_LIKE_RE`；
       * 已发消息 `ui-reference` 的 `fileReferenceRule` 用 `(?<!\S)@...`）。命中后输入框里
       * 它是可点击的引用样式，消息里是文件芯片。给这行加「位置：」之类的前缀会让 `@`
       * 前面出现非空白字符，规则直接不认 —— 这就是「以前能渲染、现在不行」的差别。
       *
       * 同时这也是给 agent 的定位：`nb_open` 用它，`Cell[n]` 用序号（不是内部 cellId）。
       */
      const refPath = String(s.mentionPath || "").trim().replace(/\\/g, "/") || slashPath
      const ref = formatNotebookRef({
        path: refPath,
        cellIndex: hasCell ? cellIndex : 0,
        startLine: hasRange ? startLine + 1 : 0,
        endLine: hasRange && Number.isFinite(endLine) ? endLine + 1 : 0,
      })
      /**
       * 正文只投三样东西：**文件引用 + skill + 要求**（用户 2026-11-11 的要求）。
       *
       * 为什么不再写「nb_open → nb_get → nb_edit_cell」那一串：它在每条消息里重复一遍，
       * 用户看到的就是一堵墙。流程已经沉淀到 `notebook-edit` skill 里
       * （仓库 `skills/notebook-edit/SKILL.md`，`node scripts/install-skill.mjs` 装进
       * `~/.dsh/skills/`），agent 看到 `/notebook-edit` 就会加载它。
       *
       * `/notebook-edit` 与 `@path` 都在行首：DSH 的纯文本引用扫描要求触发符前面是
       * 行首或空白，命中后输入框里是可点引用、消息里是文件芯片。
       */
      const action =
        mode === "explain"
          ? "解释这一格，不要改代码"
          : mode === "fix"
            ? "修这一格（它报错了）"
            : mode === "rewrite-selection"
              ? "只改我选中的那几行"
              : "改写这一格"
      const out = [ref.modelForm, ""]
      out.push(instruction ? `/notebook-edit ${action}\n我的要求：${instruction}` : `/notebook-edit ${action}`)
      /**
       * 只贴**选区**，不贴整格源码。
       *
       * 用户 2026-11-11：「要不对话框内太长了」。整格代码 agent 用 `nb_get` 自己读，
       * 贴进对话里只是把输入框撑成一面墙；而选区可能还没保存进文件里，agent 读不到，
       * 所以它是唯一必须随消息带走的内容。
       */
      const selectionText = String((s.selection && s.selection.text) || "").trim()
      if (hasRange && selectionText) {
        out.push("", `${rangeText}：`, `${fence}${language}`, clipText(selectionText, 80, 3000), fence)
      }
      /**
       * 报错只留一行（`ename: evalue`）。traceback 让 agent 用 `nb_error_context` 拿，
       * 贴在对话里同样只是变长。
       */
      const err = s.error || null
      if (err) {
        const ename = String(err.ename || "Error")
        const evalue = String(err.evalue || "")
        out.push("", `报错：${ename}${evalue ? ": " + evalue : ""}`)
      }
      return out.join("\n")
    }

    /**
     * 拿到「往主对话输入框写东西」的桥（**新版本 DSH 的备用通道**）。
     *
     * ⚠️ 0.2.1-rc.5 **没有 `conversation` 这个 client service**（实测见
     * docs/research/2026-11-06-chat-delivery-实测.md），所以本函数在本版恒为 null；
     * 真正在用的是 `deliverInputText(props.inputActions, …)`。保留它是因为它是
     * `dsh-better-sidebar` 走的正路，等宿主把服务放出来就能零改动接管。
     *
     * ⚠️ 另外**不能**写 `ctx.sessions`：客户端插件拿到的是门面
     * （`dsh-cordis-client-runner` 的 `dynamicCordisContext`），未在 `inject` 里声明的
     * 服务用属性访问会直接抛异常（还会被记成一次插件失败），而 `ctx.get(name)` 是
     * 「可选查找」，未注册时返回 undefined。早先写 `ctx.sessions` 被 try/catch 吃掉，
     * 于是桥永远为 null —— 用户看到的「拿不到会话桥」就是这么来的。
     *
     * @returns {null | {insertReference:Function, appendText:Function, state:Function}}
     */
    function getChatBridge(sessionId) {
      const ctx = pluginCtx
      if (!ctx) return null
      let sessions = null
      try {
        sessions = ctx.get("sessions")
      } catch {
        sessions = null
      }
      if (!sessions || typeof sessions.scope !== "function") return null
      let actx = null
      try {
        actx = sessions.scope(sessionId)
      } catch {
        actx = null
      }
      if (!actx) return null
      let conversation = null
      try {
        conversation = ctx.get("conversation")
      } catch {
        conversation = null
      }
      if (!conversation || !conversation.input || typeof conversation.input.for !== "function") return null
      let input = null
      try {
        input = conversation.input.for(actx)
      } catch {
        input = null
      }
      if (!input || !input.state || typeof input.state.getSnapshot !== "function") return null
      const snapshot = () => {
        try {
          return input.state.getSnapshot() || {}
        } catch {
          return {}
        }
      }
      /**
       * detect 坐标系里「草稿末尾」的位置。
       * 芯片占位符在 detectText 里长度是 1，所以不能用 draft.length 直接当端点
       * （草稿里已有芯片时会算偏，插进去的位置就不对）。
       */
      const detectEnd = () => {
        const st = snapshot()
        try {
          if (input.projection && typeof input.projection.detectText === "string") {
            return input.projection.detectText.length
          }
        } catch {
          /* fall through */
        }
        const occ = Array.isArray(st.occurrences) ? st.occurrences : []
        const shrink = occ.reduce((n, o) => n + Math.max(0, Number((o && o.length) || 1) - 1), 0)
        return Math.max(0, String(st.draft || "").length - shrink)
      }
      const editable = () => {
        const phase = snapshot().phase
        return phase === "plain" || phase === "claimed"
      }
      return {
        state: snapshot,
        /** 插入一枚引用芯片（appearance:"file" 就是文件卡片形态）。 */
        insertReference(reference) {
          if (!editable()) return false
          const st = snapshot()
          try {
            const end = detectEnd()
            actx.emit("slash/input-insert-reference", {
              reference,
              span: { draftRev: st.draftRev, start: end, end },
            })
          } catch {
            return false
          }
          // 成功判据：rev 变了（CAS 通过并真的写进了草稿）
          return snapshot().draftRev !== st.draftRev
        },
        /** 纯文本追加（最稳的降级路径，与 dsh-better-sidebar 同款）。 */
        appendText(text) {
          if (!editable()) return false
          const st = snapshot()
          const draft = String(st.draft || "")
          const next = !draft ? text : draft.endsWith("\n") ? draft + text : draft + "\n" + text
          try {
            input.setDraft(next)
            return true
          } catch {
            return false
          }
        },
      }
    }

    /**
     * 「一套模型选择」控件：模型下拉（按 provider 分组）+ 思考强度下拉。
     *
     * 为什么抽成组件：**补全**与**改写**需要完全相同的交互，但各自绑不同的
     * pref / efforts。复制两遍必然漂移（改一处忘另一处），而那正是「两个设置」
     * 最容易退化成「看起来两个、实际共用」的地方。
     */
    function AiTargetPicker({ pref, efforts, catalog, onChange, placeholder }) {
      const p = pref || {}
      const cat = catalog || { providers: [], ok: false }
      const eff = efforts || { efforts: [] }
      return h(
        "span",
        { style: { display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 } },
        h(
          "select",
          {
            value: p.provider && p.model ? p.provider + "\u0000" + p.model : "",
            title: placeholder || "选择模型",
            onChange: (e) => {
              const v = String(e.target.value || "")
              if (!v) return
              const [provider, model] = v.split("\u0000")
              onChange({ provider, model, reasoningEffort: null })
            },
            style: aiSelectStyle,
          },
          h("option", { value: "" }, cat.providers.length ? "选择模型…" : cat.ok ? "没有可用模型" : "LLM 不可用"),
          cat.providers.map((prov) =>
            h(
              "optgroup",
              { key: prov.id, label: prov.error ? `${prov.name}（${prov.error}）` : prov.name },
              (prov.models || []).map((m) =>
                h(
                  "option",
                  { key: prov.id + "\u0000" + m.id, value: prov.id + "\u0000" + m.id, title: m.description || m.id },
                  m.name || m.id,
                ),
              ),
            ),
          ),
        ),
        h(
          "select",
          {
            value: p.reasoningEffort || "",
            disabled: !eff.efforts.length,
            title: eff.efforts.length ? "该模型支持的思考强度" : "该模型没有声明思考强度（不支持推理或多档）",
            onChange: (e) => onChange({ reasoningEffort: String(e.target.value || "") || null }),
            style: { ...aiSelectStyle, opacity: eff.efforts.length ? 1 : 0.5 },
          },
          eff.efforts.length
            ? [
                h("option", { key: "__none", value: "" }, "默认强度"),
                ...eff.efforts.map((e) =>
                  h("option", { key: e.id, value: e.id, title: e.description || e.id }, e.name || e.id),
                ),
              ]
            : h("option", { value: "" }, "该模型不支持"),
        ),
      )
    }

    // ─────────────── 大纲停靠侧栏（可拖拽调宽） ───────────────

    /** 大纲停靠宽度的持久化键（用户要求「大纲 UI 的范围应该可以调整」）。 */
    const OUTLINE_WIDTH_KEY = "nb2.outlineWidth.v1"
    const OUTLINE_WIDTH_MIN = 140
    const OUTLINE_WIDTH_MAX = 560
    const OUTLINE_WIDTH_DEFAULT = 200
    /** 拖宽时给正文留的保底宽度：宁可否掉大纲，也不能把 notebook 挤没。 */
    const OUTLINE_HOST_RESERVE = 180

    // ─────────────── 阅读位置记忆（每个 notebook 各记一份） ───────────────

    /**
     * 滚动位置持久化键前缀，后面接 notebook 的绝对路径（`state.path`）。
     *
     * 为什么按 path 记而不是按 tab key 或会话：用户要的是「同一个 .ipynb 下次打开回到
     * 上次看的地方」，跨会话、跨标签都应该成立；tab key 是会话内的临时身份，
     * 关掉标签再打开就变了。
     */
    const VIEW_STATE_PREFIX = "nb2.view.v1:"

    /** 空 path 不产生键（未落盘的新 notebook 没有稳定身份，每次都从顶部开始）。 */
    function viewStoreKey(path) {
      const p = String(path || "").trim()
      return p ? `${VIEW_STATE_PREFIX}${p}` : ""
    }

    /** 读回某本 notebook 的阅读位置：`{ top, cellId }`；没有记录 / 坏数据一律 null。 */
    function loadViewState(path, store) {
      const key = viewStoreKey(path)
      const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
      if (!key || !s || typeof s.getItem !== "function") return null
      try {
        const raw = s.getItem(key)
        if (!raw) return null
        const o = JSON.parse(raw)
        if (!o || typeof o !== "object") return null
        const top = Number(o.top)
        return {
          top: Number.isFinite(top) && top > 0 ? top : 0,
          cellId: String(o.cellId || ""),
        }
      } catch {
        return null
      }
    }

    /** 写入阅读位置。localStorage 不可用（隐私模式 / 禁用）时静默失败。 */
    function saveViewState(path, value, store) {
      const key = viewStoreKey(path)
      const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
      if (!key || !s || typeof s.setItem !== "function") return false
      try {
        const top = Number((value && value.top) || 0)
        s.setItem(
          key,
          JSON.stringify({
            top: Number.isFinite(top) && top > 0 ? top : 0,
            cellId: String((value && value.cellId) || ""),
          }),
        )
        return true
      } catch {
        return false
      }
    }

    /**
     * 视口顶部那一格的 id（纯函数，有单测）。
     *
     * `rects` 是按文档顺序排好的 `{id, top, bottom}`，坐标相对滚动容器内容起点。
     * 判定用「底部还在首行下方」而不是「顶部可见」：半截露在顶部的长格也应该算
     * 你正在看的那一格，否则恢复时会跳到它的下一格。
     */
    function pickTopCellId(rects, scrollTop) {
      const list = Array.isArray(rects) ? rects : []
      if (!list.length) return ""
      const y = Number(scrollTop) || 0
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i]
        if (!r) continue
        const top = Number(r.top)
        const bottom = Number(r.bottom)
        const end = Number.isFinite(bottom) ? bottom : (Number.isFinite(top) ? top : 0) + 1
        if (end > y + 4) return String(r.id || "")
      }
      return String((list[list.length - 1] && list[list.length - 1].id) || "")
    }

    /**
     * 把任意输入夹到合法宽度（纯函数，有单测）。
     *
     * `max` 由调用方传入而不是写死：停靠栏此刻能占多宽是**运行时**信息
     * （取决于用户把 DSH 右栏拖多宽），固定上限要么不够用、要么把正文挤死。
     */
    function clampOutlineWidth(value, opts) {
      const o = opts || {}
      const min = Number.isFinite(o.min) ? o.min : OUTLINE_WIDTH_MIN
      const hardMax = Number.isFinite(o.max) && o.max > min ? o.max : OUTLINE_WIDTH_MAX
      // null / undefined / 空串 = 「没有这个值」，不是「宽度 0」——必须先变成 NaN，
      // 否则 Number(null) === 0 会被夹成下限 140，用户看到的是一条凭空变窄的栏。
      const blank = value === null || value === undefined || (typeof value === "string" && !value.trim())
      const n = blank ? NaN : Math.round(Number(value))
      if (!Number.isFinite(n)) return Math.min(hardMax, Math.max(min, OUTLINE_WIDTH_DEFAULT))
      return Math.min(hardMax, Math.max(min, n))
    }

    /**
     * 拖动 dx 像素后的宽度（纯函数，有单测）。
     *
     * 左停靠时分隔条在**右**边 → 往右拖变宽；右停靠时分隔条在**左**边 → 往右拖变窄。
     * 手势只有一份，靠 side 翻符号，避免两套逻辑漂移。
     */
    function outlineDragWidth(startWidth, side, dx, max) {
      const base = Number.isFinite(Number(startWidth)) ? Number(startWidth) : OUTLINE_WIDTH_DEFAULT
      const delta = Number.isFinite(Number(dx)) ? Number(dx) : 0
      return clampOutlineWidth(side === "right" ? base - delta : base + delta, { max })
    }

    function loadOutlineWidth(store) {
      const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
      if (!s || typeof s.getItem !== "function") return OUTLINE_WIDTH_DEFAULT
      try {
        return clampOutlineWidth(s.getItem(OUTLINE_WIDTH_KEY))
      } catch {
        return OUTLINE_WIDTH_DEFAULT
      }
    }

    function saveOutlineWidth(value, store) {
      const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
      if (!s || typeof s.setItem !== "function") return false
      try {
        s.setItem(OUTLINE_WIDTH_KEY, String(clampOutlineWidth(value)))
        return true
      } catch {
        return false
      }
    }

    /** 停靠栏此刻最多能占多宽：宿主宽度 - 正文保底；拿不到宿主就退回硬上限。 */
    function outlineHostMax(dockNode) {
      try {
        const host = dockNode && dockNode.parentElement
        const w = host ? Number(host.clientWidth) : 0
        if (Number.isFinite(w) && w > 0) return Math.max(OUTLINE_WIDTH_MIN + 40, w - OUTLINE_HOST_RESERVE)
      } catch {
        /* ignore */
      }
      return OUTLINE_WIDTH_MAX
    }

    /**
     * 大纲的**停靠侧栏**（R7），宽度可拖拽（R8）。
     *
     * 为什么停靠而不是浮层：大纲是导航用的，用户需要它在滚动、切格、编辑时**一直在**；
     * 浮层会被「点外部 / 滚动 / Esc」收掉，每次想看目录都得重新点开。
     *
     * 为什么宽度必须可调：本面板活在 DSH 右栏里，而右栏本身就能被拉宽拉窄。
     * 固定 200px 在窄右栏里把单元格挤成一条缝，在宽右栏里又放不下长标题 ——
     * 一个写死的宽度不可能同时成立，只能把范围交给用户，并且记住他的选择。
     *
     * ⚠️ 必须**模块级**定义。早先它被写在 `NotebookV2Panel` 内部：父组件每次重渲染
     * 都会造出一个新的函数身份 → React 直接卸载重挂子树，任何组件内 state
     * （宽度、拖拽中）都会被重置。搬出来不只是整洁，是这条功能能成立的前提。
     */
    function OutlineDockPanel({ tree, selectedCellId, onJump, side, onClose }) {
      const [width, setWidth] = React.useState(() => loadOutlineWidth())
      const [dragging, setDragging] = React.useState(false)
      const dockRef = React.useRef(null)
      const dragRef = React.useRef(null)
      /** 用户有没有亲手动过宽度（没动过就不写盘，别制造脏键）。 */
      const pinnedRef = React.useRef(false)

      React.useEffect(() => {
        if (dragging || !pinnedRef.current) return
        saveOutlineWidth(width)
      }, [width, dragging])

      React.useEffect(() => {
        if (!dragging) return undefined
        const body = typeof document !== "undefined" ? document.body : null
        const prevCursor = body ? body.style.cursor : ""
        const prevSelect = body ? body.style.userSelect : ""
        // 拖动中锁光标与选中：否则鼠标扫过正文会把代码选成一片蓝
        if (body) {
          body.style.cursor = "col-resize"
          body.style.userSelect = "none"
        }
        const onMove = (e) => {
          const d = dragRef.current
          if (!d) return
          setWidth(outlineDragWidth(d.startWidth, side, e.clientX - d.startX, outlineHostMax(dockRef.current)))
        }
        const onUp = () => {
          dragRef.current = null
          setDragging(false)
        }
        window.addEventListener("pointermove", onMove)
        window.addEventListener("pointerup", onUp)
        window.addEventListener("pointercancel", onUp)
        return () => {
          window.removeEventListener("pointermove", onMove)
          window.removeEventListener("pointerup", onUp)
          window.removeEventListener("pointercancel", onUp)
          if (body) {
            body.style.cursor = prevCursor
            body.style.userSelect = prevSelect
          }
        }
      }, [dragging, side])

      const grab = (e) => {
        if (e && typeof e.button === "number" && e.button !== 0) return
        if (e && typeof e.preventDefault === "function") e.preventDefault()
        pinnedRef.current = true
        dragRef.current = { startX: e ? Number(e.clientX) || 0 : 0, startWidth: width }
        setDragging(true)
      }
      const nudge = (dx) => {
        pinnedRef.current = true
        setWidth((w) => outlineDragWidth(w, side, dx, outlineHostMax(dockRef.current)))
      }
      const resetWidth = () => {
        pinnedRef.current = true
        setWidth(OUTLINE_WIDTH_DEFAULT)
      }

      return h(
        "div",
        {
          ref: dockRef,
          className: "nb2-outline-dock",
          "data-nb2-outline-dock": side,
          style: {
            position: "relative",
            flex: "none",
            width,
            minWidth: OUTLINE_WIDTH_MIN,
            maxWidth: "70%",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
            borderLeft: side === "right" ? "1px solid var(--dsw-alias-border-l2,#333)" : undefined,
            borderRight: side === "left" ? "1px solid var(--dsw-alias-border-l2,#333)" : undefined,
            fontSize: 11,
            padding: "2px 4px 4px",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 2px 4px", opacity: 0.75, flex: "none" } },
          h("span", { style: { flex: 1 } }, side === "left" ? "大纲（左）" : "大纲（右）"),
          h(
            "span",
            {
              title: "当前宽度（拖右/左边缘调整，双击分隔条复位）",
              style: { opacity: 0.55, fontSize: 10, fontVariantNumeric: "tabular-nums", flex: "none" },
            },
            `${width}px`,
          ),
          h("button", { type: "button", title: "切换位置 / 关闭（关 → 左 → 右 → 关）", onClick: onClose, style: miniBtn }, "⇄"),
        ),
        h(OutlinePanel, { tree, selectedCellId, onJump }),
        /**
         * 分隔条：贴在**内侧**边缘（左停靠在右、右停靠在左）。
         * 位置靠 hover/拖拽态把那条 1px 竖线点亮来提示 —— 平时几乎不可见，
         * 免得在这条本来就窄的面板里再画一条硬线。
         */
        h(
          "div",
          {
            className: "nb2-outline-grip",
            "data-nb2-outline-grip": "1",
            role: "separator",
            "aria-orientation": "vertical",
            "aria-label": "拖动调整大纲宽度",
            "aria-valuenow": width,
            "aria-valuemin": OUTLINE_WIDTH_MIN,
            "aria-valuemax": OUTLINE_WIDTH_MAX,
            tabIndex: 0,
            title: `拖动调整宽度（双击复位 ${OUTLINE_WIDTH_DEFAULT}px，←/→ 微调 16px）`,
            onPointerDown: grab,
            onDoubleClick: resetWidth,
            onKeyDown: (e) => {
              const k = e && e.key
              if (k !== "ArrowLeft" && k !== "ArrowRight") return
              if (typeof e.preventDefault === "function") e.preventDefault()
              nudge(k === "ArrowRight" ? 16 : -16)
            },
            style: {
              position: "absolute",
              top: 0,
              bottom: 0,
              [side === "right" ? "left" : "right"]: 0,
              width: 7,
              cursor: "col-resize",
              touchAction: "none",
              zIndex: 6,
              display: "flex",
              alignItems: "stretch",
              justifyContent: "center",
              background: dragging ? "var(--dsw-alias-bg-accent,#2b6cb0)" : "transparent",
              outline: "none",
            },
          },
          h("span", {
            "aria-hidden": "true",
            style: {
              width: 1,
              background: dragging ? "rgba(255,255,255,.92)" : "var(--dsw-alias-border-l2,#3a3a3a)",
              opacity: dragging ? 1 : 0.5,
            },
          }),
        ),
      )
    }

    function NotebookV2Panel(props) {
    /**
     * 大纲停靠位置的持久化键。
     *
     * 三态：`"off"`（不显示）/ `"left"` / `"right"`。用户要求「大纲应该在最左侧，或者
     * 右侧，可以选择」，所以位置是**用户选择**且跨会话记住的，不是编译期常量。
     */
    const OUTLINE_DOCK_KEY = "nb2.outlineDock.v1"

    function loadOutlineDock(store) {
      const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
      if (!s || typeof s.getItem !== "function") return "off"
      try {
        const v = String(s.getItem(OUTLINE_DOCK_KEY) || "")
        return v === "left" || v === "right" || v === "off" ? v : "off"
      } catch {
        return "off"
      }
    }

    function saveOutlineDock(value, store) {
      const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
      if (!s || typeof s.setItem !== "function") return false
      try {
        s.setItem(OUTLINE_DOCK_KEY, value === "left" || value === "right" ? value : "off")
        return true
      } catch {
        return false
      }
    }

    /**
     * ⚠️ 本函数（`NotebookV2Panel`）体里**不要**再定义组件。
     *
     * 所有子组件都必须落在模块级：这里的函数体每渲染一次就重新执行一遍，
     * 内部 `function Foo(){}` 每次都是新身份 → React 当成不同类型 → 卸载重挂子树，
     * 子组件里任何 state（拖拽中、输入框内容、折叠开合）都会被清空。
     * 大纲停靠栏就是踩过这个坑才搬到模块级的（见 `OutlineDockPanel`）。
     */
      const sid = String((props && (props.sessionId || (props.session && props.session.id))) || "default") || "default"
      /**
       * slot props 里的 `inputActions`（会话输入框 facade）——**这就是投递通道本尊**。
       *
       * 2026-11-06 实测修正：它是公开的、有实现的（`SessionInputShell.actions`），
       * 其中 `captureInsertion()` + `insertText(text, span)` 会把文字**插入** Lexical
       * 编辑器，而不是 `setDraft` 那种整体替换 —— 所以它不会吃掉用户已经打好的字。
       * 早先「它不是可靠通道、只能走 ctx 的 conversation 服务」的判断是错的：
       * 本版根本没有 `conversation` 这个 client service（见 cite 的注释）。
       * 缺方法时 `deliverInputText` 会把实际有哪些方法写进提示，方便排障。
       */
      const slotInputActions = (props && props.inputActions) || null
      const CM = useVendor()
      // 全局样式（::selection / 闪烁动画）+ md 作用域样式 + KaTeX 样式表：挂载时各插一次，幂等
      React.useEffect(() => {
        ensureGlobalCss()
        ensureMdCss()
        ensureKatexCss()
      }, [])
      const { state, setState, conn, notice, setNotice, refetch, agentFrame } = useNotebook(sid)
      const [selected, setSelected] = React.useState(null)
      /**
       * 多选（Jupyter：`Shift-↑/↓` 扩选、`Mod-A` 全选）。
       *
       * 模型很轻：`selected` 是**锚点**（当前格），`extraSelected` 是锚点之外被选中的格。
       * 这样所有既有逻辑（跳转/聚焦/运行/AI 条）都只认锚点，不必改动；
       * 批量动作（删除）再拿 `[selected, ...extraSelected]` 求并集。
       */
      const [extraSelected, setExtraSelected] = React.useState(() => new Set())
      const isCellSelected = React.useCallback(
        (cellId) => !!cellId && (cellId === selected || extraSelected.has(cellId)),
        [selected, extraSelected],
      )
      /** 当前多选集合（按文档顺序）。锚点排在前面，保证「删完选中谁」可预测。 */
      const selectedIds = React.useMemo(() => {
        const set = new Set(extraSelected)
        if (selected) set.add(selected)
        // 用 state.cells 而不是面板后面的 `cells` 常量：后者声明在本块之后，
        // 写进依赖数组会在首次渲染就 TDZ 崩（本仓库已踩过两次同类坑）。
        const list = Array.isArray(state.cells) ? state.cells : []
        return list.filter((c) => set.has(c.id)).map((c) => c.id)
      }, [state.cells, selected, extraSelected])
      const [busy, setBusy] = React.useState(null)
      /**
       * 「运行中」状态条的心跳：只在有格子在跑时每 500ms 刷一次，用来更新已跑时长。
       * 不在跑就不设 timer —— 右栏是常驻面板，空转 interval 是白烧 CPU。
       */
      const [statusTick, setStatusTick] = React.useState(0)
      React.useEffect(() => {
        if (!state.running) return undefined
        setStatusTick(Date.now())
        const timer = setInterval(() => setStatusTick(Date.now()), 500)
        return () => clearInterval(timer)
      }, [state.running])

      /**
       * 「请把焦点交给这一格的编辑器」请求（P0 5.1/5.3/第 3 条核心）。
       *
       * 为什么用「单调序号 + cellId」而不是布尔：同一格连续两次要求聚焦（例如连按
       * Shift-Enter 在最后一格反复补格）时，布尔值不变 → effect 不重跑 → 第二次不聚焦。
       */
      const [focusReq, setFocusReq] = React.useState(null)
      const focusSeqRef = React.useRef(0)
      const focusCell = React.useCallback((cellId) => {
        if (!cellId) return
        focusSeqRef.current += 1
        setFocusReq({ cellId, at: focusSeqRef.current })
        setSelected(cellId)
      }, [])
      /**
       * 编辑器 API 登记表（cellId → api）。
       *
       * ⚠️ 早先这里只存「当前选中格的那一个」，acceptAi 用 `cellId === selected` 判断 ——
       * 那是个真 bug：用户在 Cell[3] 里拖选、打开 AI 条、途中点了一下 Cell[5]，
       * `selected` 变成 c5，于是选区改写「拿不到编辑器」降级成整格替换，
       * 把「只替换那 3 行」的片段当成整格源码写回去 → **直接把这一格改坏了**。
       * 正确判据只有「这条 AI 条属于哪个 cellId」，与当前选中谁无关。
       */
      const editorRef = React.useRef({ cellId: null, api: null })

      const debouncedEdit = React.useMemo(() => {
        const timers = new Map()
        return (cellId, source) => {
          const prev = timers.get(cellId)
          if (prev) clearTimeout(prev)
          timers.set(
            cellId,
            setTimeout(() => {
              timers.delete(cellId)
              post("cell/edit", { sid, cellId, source }).catch(() => {})
            }, 600),
          )
        }
      }, [sid])

      const changeSource = React.useCallback(
        (cellId, source) => {
          setState((prev) => ({ ...prev, cells: prev.cells.map((c) => (c.id === cellId ? { ...c, source } : c)) }))
          debouncedEdit(cellId, source)
        },
        [setState, debouncedEdit],
      )

      /** 换类型：乐观更新 + 落库（只发 cellType，source 不动）。 */
      const changeType = React.useCallback(
        async (cellId, cellType) => {
          const next = normalizeCellType(cellType)
          setState((prev) => ({ ...prev, cells: prev.cells.map((c) => (c.id === cellId ? { ...c, cellType: next } : c)) }))
          try {
            await post("cell/edit", { sid, cellId, cellType: next })
          } catch (err) {
            setNotice(String((err && err.message) || err))
          }
        },
        [sid, setState, setNotice],
      )

      const runCell = React.useCallback(
        async (cellId, source) => {
          try {
            setBusy(cellId)
            /**
             * 乐观「已入队」：`cell/run` 是**即发即忘**（wait:false），真正的 running 状态
             * 要等 SSE 的 `cell.started` 回来。本地内核启动前那一段（第一次运行尤其久）
             * 界面上**一点反馈都没有** —— 用户连按 Shift-Enter 会以为没生效。
             * 这里先本地标成 queued，SSE 一到就被真实状态覆盖。
             */
            setState((prev) => ({
              ...prev,
              cells: prev.cells.map((c) => (c.id === cellId && c.status !== "running" ? { ...c, status: "queued" } : c)),
            }))
            await post("cell/run", { sid, cellId, source, wait: false })
          } catch (err) {
            // 起不来就把「已入队」撤掉，别让格子永远显示排队中
            setState((prev) => ({
              ...prev,
              cells: prev.cells.map((c) => (c.id === cellId && c.status === "queued" ? { ...c, status: "idle" } : c)),
            }))
            setNotice(String((err && err.message) || err))
          } finally {
            setBusy(null)
          }
        },
        [sid, setNotice, setState],
      )

      const runAll = React.useCallback(async () => {
        try {
          setBusy("all")
          await post("runAll", { sid })
        } catch (err) {
          setNotice(String((err && err.message) || err))
        } finally {
          setBusy(null)
        }
      }, [sid, setNotice])

      /**
       * 新增一格。
       * @param {string|null} afterId 插到这一格之后；null = 末尾
       * @param {boolean} run 建完立刻运行
       * @param {string} cellType
       * @param {{index?:number}} [opts] `index` 用于「插到最前面」（after=null 在宿主侧是
       *   追加到末尾，所以第一格之前必须先靠 index 定位；宿主 `cell/add` 已支持该字段）
       * @returns {Promise<string|null>} 新格 id
       */
      const addCell = React.useCallback(
        async (afterId, run, cellType, opts) => {
          const o = opts || {}
          try {
            const body = { sid, after: afterId || null, source: "", cellType: normalizeCellType(cellType) }
            if (typeof o.index === "number" && o.index >= 0) body.index = o.index
            const out = await post("cell/add", body)
            await refetch()
            const newId = out && out.cell ? out.cell.id : null
            if (run && newId) await runCell(newId, "")
            /**
             * P0 5.1：新增后**必须**聚焦，否则用户还得再点一下才能打字
             * （「加了格子但不能直接写」是这轮反馈里的原话）。
             */
            if (newId) {
              /**
               * `o.focus === false`：调用方要「选中但**不进编辑**」（Jupyter 命令态）。
               * 典型场景：Shift-Enter 跑到最后一格时自动补的那一格 —— 补完应该是
               * 「新格被选中、可以按 Enter 再写」，而不是直接把光标塞进去。
               */
              if (o.focus === false) setSelected(newId)
              else focusCell(newId)
            } else setSelected(null)
            return newId
          } catch (err) {
            setNotice(String((err && err.message) || err))
            return null
          }
        },
        [sid, refetch, runCell, setNotice, focusCell],
      )

      const save = React.useCallback(async () => {
        try {
          const out = await post("notebook/save", { sid })
          setNotice(`已保存 ${out.path}（${out.bytes} 字节）`)
        } catch (err) {
          setNotice(String((err && err.message) || err))
        }
      }, [sid, setNotice])

      const kernelAction = React.useCallback(
        async (route, body) => {
          try {
            await post(route, { sid, ...(body || {}) })
            await refetch()
          } catch (err) {
            setNotice(String((err && err.message) || err))
          }
        },
        [sid, refetch, setNotice],
      )

      const cells = state.cells
      const selectedIndex = Math.max(0, cells.findIndex((c) => c.id === selected))
      // 大纲 v2：有 CM（marked/lezer）就能出「md 各级标题 + Python 函数/类」的树
      const outline = React.useMemo(() => buildOutlineV2(cells, { CM }), [cells, CM])

      /**
       * md 标题折叠（VS Code Notebook 的章节折叠）。
       *
       * 状态只记「哪些标题格被折起来了」，藏哪些格由 `foldSections` 现算 ——
       * 这样增删/移动格之后折叠范围会自己跟着变，不会留下指向旧下标的脏状态。
       * 不落盘：VS Code 重开 notebook 也是展开的，折叠属于「临时视图」。
       */
      const [foldedSections, setFoldedSections] = React.useState(() => new Set())
      const fold = React.useMemo(() => foldSections(cells, foldedSections), [cells, foldedSections])
      /** 最近一次 fold 结果（给事件回调读，避免为了它重建一堆 useCallback）。 */
      const foldRef = React.useRef(fold)
      React.useEffect(() => {
        foldRef.current = fold
      }, [fold])

      const toggleFold = React.useCallback((cellId) => {
        if (!cellId) return
        // 折叠后把选中挪到标题格：被折起来的格不该继续是「当前格」
        setSelected(cellId)
        setFoldedSections((prev) => {
          const next = new Set(prev)
          if (next.has(cellId)) next.delete(cellId)
          else next.add(cellId)
          return next
        })
      }, [])

      /**
       * 选中的格被折起来了 → 自动展开包含它的那一节。
       *
       * 为什么必须做：大纲跳转、Shift-Enter 下移、Agent 改格定位都可能落在被折叠的格上。
       * 不展开的话用户看到的是「点了大纲，什么都没发生」——比不折叠更糟。
       * 用 selected 作判据（而不是给每个入口打补丁）：选中是唯一真源，一处覆盖全部来源。
       */
      const revealCell = React.useCallback((cellId) => {
        const cur = foldRef.current
        if (!cellId || !cur || !cur.hidden || !cur.hidden.has(cellId)) return
        const idx = cur.indexOf.get(cellId)
        if (!Number.isFinite(idx)) return
        setFoldedSections((prev) => {
          if (!prev.size) return prev
          const next = new Set(prev)
          for (const section of cur.sections) {
            if (!next.has(section.cellId)) continue
            if (idx > section.index && idx <= section.end) next.delete(section.cellId)
          }
          return next.size === prev.size ? prev : next
        })
      }, [])
      React.useEffect(() => {
        if (selected) revealCell(selected)
      }, [selected, revealCell])

      /** 每一格的「上一个可见格」：折叠后插格热区要贴着看得见的邻居，不能插进折起来的区域里。 */
      const prevVisibleId = React.useMemo(() => {
        const map = new Map()
        let last = null
        const list = Array.isArray(cells) ? cells : []
        for (const cell of list) {
          if (!cell || !cell.id) continue
          map.set(cell.id, last)
          if (!fold.hidden.has(cell.id)) last = cell.id
        }
        return map
      }, [cells, fold])

      /**
       * 「命令态选中某一格」：只把**选中**给这一格，并把焦点交给它的**容器**（不进编辑）。
       *
       * 两个动作缺一不可：
       *  · `setSelected` —— 视觉上的选中态；
       *  · 焦点交给容器（CellView 根节点 `tabIndex: 0`）—— 否则焦点还留在刚跑完那格的
       *    CM6 里，下一个按键会继续打进旧格（用户体感：「跑完还能往上一格打字」）。
       * 容器态下 Enter/F2 进编辑、方向键选格，由面板级 `decideCellKey` 分发。
       */
      const selectCellCommand = React.useCallback((cellId) => {
        if (!cellId) return
        setSelected(cellId)
        // 等 React 把选中态提交到 DOM 再抢焦点（refetch 之后尤其需要）
        requestAnimationFrame(() => {
          const el = listRef.current && listRef.current.querySelector(`[data-cell-id="${cellId}"]`)
          if (!el) return
          try {
            if (el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" })
          } catch {
            /* ignore */
          }
          try {
            if (el.focus) el.focus({ preventScroll: true })
          } catch {
            /* ignore */
          }
        })
      }, [])

      /**
       * Shift-Enter 的完整语义 = Jupyter 的 `run-cell-and-select-next`：
       * **跑本格 → 下一格被「选中」但不进编辑（命令态）**；最后一格则补一格再选中。
       *
       * ⚠️ 历史坑：早先这里是 `focusCell(下一格)`（直接进编辑态），注释写着「不然手感上
       * 等于没有自动运行」。但用户实测反馈是**相反**的：「我 shift+enter，下个 cell 自动
       * 成为了编辑状态」—— 那是把 Jupyter 的两条语义（run-and-select-next / run-and-insert）
       * 混在一起了。想「跑完立刻接着写」请用 Ctrl-Enter（原地跑，焦点不动）。
       */
      const runBelow = React.useCallback(
        async (cellId, opts) => {
          const o = opts || {}
          const idx = cells.findIndex((c) => c.id === cellId)
          const cell = idx >= 0 ? cells[idx] : null
          if (!cell) return
          runCell(cell.id, cell.source)
          const target = nextRunTarget(cells, idx)
          if (target.kind === "focus") {
            if (o.mode === "focus") focusCell(target.id)
            else selectCellCommand(target.id)
            return
          }
          // 最后一格：补一格并沿用本格类型（Notebook 经典版同样会补），补完「选中」它
          const newId = await addCell(target.afterId, false, cell.cellType, { focus: false })
          if (!newId) return
          if (o.mode === "focus") focusCell(newId)
          else selectCellCommand(newId)
        },
        [cells, runCell, focusCell, addCell, selectCellCommand],
      )

      /**
       * 面板级 Enter 组合分发器（capture 阶段）。
       *
       * 补的是「焦点在面板空白 / 标签条 / 格容器 / 工具条按钮上时**根本没人接事件**」
       * 这个洞（第 3 条反馈的另一个根因）。判定逻辑全在 decideCellKey（纯函数、有矩阵测试）。
       * 注意：命中 `.cm-editor` 时它返回 "pass" —— 那里由 CM 自己的 keymap 处理，
       * 我们在 capture 阶段再插手会让同一按键跑两遍。
       */
      /**
       * 命令模式的两段式删除（`D` `D`）与撤销（`Z`）。
       *
       * `pendingDelete` 只对「同一格 + 1.2s 内」有效：否则用户过一会儿再按一次 D
       * 就会误删 —— Jupyter 自己也是「第二次 D 才算数」，但没有时间窗时误删率明显更高。
       */
      const pendingDeleteRef = React.useRef({ cellId: null, at: 0 })
      const lastDeletedRef = React.useRef(null)
      /**
       * 命令 id → 执行体（每帧重建，见下面的赋值）。
       *
       * 为什么用 ref 而不是 `useMemo(..., deps)`：这张表引用了 `moveCellTo` / `mergeBelow`
       * / `citeCellRef` 等**在后面才声明**的符号，把它们写进依赖数组会在首次渲染就 TDZ 崩
       * （本仓库已经踩过一次：`Cannot access 'citeCell' before initialization`）。
       * 用 ref 每帧重赋值既避开 TDZ，又保证闭包永远是最新的 state。
       */
      const commandsRef = React.useRef({})

      const isDeleteArmed = React.useCallback((cellId) => {
        const p = pendingDeleteRef.current
        return !!cellId && p.cellId === cellId && Date.now() - p.at < 1200
      }, [])

      /** 删除一格（命令模式 `DD` 与工具条 ✕ 共用），并记住快照供 `Z` 撤销。 */
      /**
       * 删一格（薄封装）。
       *
       * 故意**不用** `useCallback`：它唯一的调用方是每帧重建的命令表，
       * 而把下面的 `deleteCells` 写进依赖数组会在渲染期求值 → TDZ 崩。
       */
      const deleteCell = (cell) => {
        if (cell) deleteCells([cell.id], cell.id)
      }

      /**
       * 删除一批格（多选 `DD` 用）。
       *
       * 为什么逐个 `cell/delete` 而不是加批量路由：宿主 `cell/delete` 已存在且幂等，
       * 多删几次的代价只是几次本地 HTTP；加新路由反而要同时改协议与测试。
       * 撤销只记**最后一次**的快照（`Z` 的语义本来就是「撤销上一次删除」）。
       */
      const deleteCells = React.useCallback(
        async (ids, anchorId) => {
          const list = (Array.isArray(ids) ? ids : []).filter(Boolean)
          if (!list.length) return
          const anchorIdx = cells.findIndex((c) => c.id === anchorId)
          const last = cells.find((c) => c.id === list[list.length - 1])
          if (last) {
            lastDeletedRef.current = {
              source: last.source,
              cellType: last.cellType,
              index: cells.findIndex((c) => c.id === last.id),
            }
          }
          try {
            for (const id of list) await post("cell/delete", { sid, cellId: id })
            await refetch()
            setExtraSelected(new Set())
            // 选中「锚点原位置」那一格（没有就前一格），与 Jupyter 删完的位置一致
            const rest = cells.filter((c) => !list.includes(c.id))
            const target = rest[Math.min(Math.max(anchorIdx, 0), Math.max(rest.length - 1, 0))] || null
            if (target) selectCellCommand(target.id)
          } catch (err) {
            setNotice(String((err && err.message) || err))
          }
        },
        [cells, sid, refetch, selectCellCommand, setNotice],
      )

      /**
       * `Z`：撤销上一次删格。
       *
       * 宿主没有 `cell/restore` 接口，所以按快照**重建**一格（源码/类型/原位置）。
       * 局限：输出与执行计数恢复不了 —— 所以提示文案只说「已恢复单元格」。
       */
      const restoreDeleted = React.useCallback(async () => {
        const snap = lastDeletedRef.current
        if (!snap) {
          setNotice("没有可撤销的删除")
          return
        }
        lastDeletedRef.current = null
        try {
          const out = await post("cell/add", {
            sid,
            after: null,
            index: typeof snap.index === "number" && snap.index >= 0 ? snap.index : undefined,
            source: snap.source || "",
            cellType: normalizeCellType(snap.cellType),
          })
          await refetch()
          const id = out && out.cell ? out.cell.id : null
          if (id) selectCellCommand(id)
          setNotice("已恢复删除的单元格")
        } catch (err) {
          setNotice(String((err && err.message) || err))
        }
      }, [sid, refetch, selectCellCommand, setNotice])

      /**
       * 命令执行表：**唯一**把「命令 id」变成动作的地方。
       *
       * 面板快捷键（键位表 → 命令 id）、单元格右键菜单（菜单项带 command id）都从这里取，
       * 所以不会出现「菜单能点、快捷键没接」或反过来 —— 这正是用户提的
       * 「先把 API 留出来，再拿键位去接」的落点。
       *
       * 每帧重建（见 commandsRef 的注释）：闭包永远拿到最新 state，且不碰 TDZ。
       */
      commandsRef.current = {
        "notebook.save": () => save(),
        "notebook.commandMode": (cell) => {
          if (cell) selectCellCommand(cell.id)
        },
        "cell.edit": (cell) => {
          if (cell) focusCell(cell.id)
        },
        "cell.prev": (cell) => {
          if (!cell) return
          const i = cells.findIndex((c) => c.id === cell.id)
          const target = cells[i - 1]
          // 普通方向键 = 单选手感：先把多选清掉
          if (extraSelected.size) setExtraSelected(new Set())
          if (target) selectCellCommand(target.id)
        },
        "cell.next": (cell) => {
          if (!cell) return
          const i = cells.findIndex((c) => c.id === cell.id)
          const target = cells[i + 1]
          if (extraSelected.size) setExtraSelected(new Set())
          if (target) selectCellCommand(target.id)
        },
        /** Shift-↑：把上一格加进多选（锚点不动，Jupyter 同款） */
        "cell.extendUp": (cell) => {
          if (!cell) return
          const i = cells.findIndex((c) => c.id === cell.id)
          const target = cells[i - 1]
          if (!target) return
          setExtraSelected((prev) => new Set(prev).add(target.id))
        },
        /** Shift-↓：把下一格加进多选 */
        "cell.extendDown": (cell) => {
          if (!cell) return
          const i = cells.findIndex((c) => c.id === cell.id)
          const target = cells[i + 1]
          if (!target) return
          setExtraSelected((prev) => new Set(prev).add(target.id))
        },
        /** Mod-A：全选（锚点保持当前格，其余进 extra） */
        "cell.selectAll": (cell) => {
          if (!cells.length) return
          const anchor = cell ? cell.id : cells[0].id
          setSelected(anchor)
          setExtraSelected(new Set(cells.filter((c) => c.id !== anchor).map((c) => c.id)))
        },
        "cell.clearSelection": () => {
          if (extraSelected.size) setExtraSelected(new Set())
        },
        "cell.insertAbove": (cell) => {
          if (!cell) return
          // index = 当前格位置 → 插在它上面；addCell 默认聚焦（Jupyter 的 A 也直接进编辑）
          addCell(null, false, cell.cellType, { index: cells.findIndex((c) => c.id === cell.id) })
        },
        "cell.insertBelow": (cell) => {
          if (cell) addCell(cell.id, false, cell.cellType)
        },
        "cell.deleteArmed": (cell) => {
          if (!cell) return
          pendingDeleteRef.current = { cellId: cell.id, at: Date.now() }
          setNotice("再按一次 D 删除本格")
        },
        "cell.delete": (cell) => {
          if (!cell) return
          pendingDeleteRef.current = { cellId: null, at: 0 }
          // 多选时删**全部**选中（Jupyter 同款）；单格时就是删这一格
          const ids = selectedIds.length > 1 ? selectedIds : [cell.id]
          deleteCells(ids, cell.id)
        },
        "cell.undoDelete": () => restoreDeleted(),
        "cell.toCode": (cell) => {
          if (cell) changeType(cell.id, "code")
        },
        "cell.toMarkdown": (cell) => {
          if (cell) changeType(cell.id, "markdown")
        },
        "cell.toRaw": (cell) => {
          if (cell) changeType(cell.id, "raw")
        },
        "cell.mergeBelow": (cell) => mergeBelow(cell),
        "cell.clearOutputs": (cell) => {
          if (cell) kernelAction("cell/clearOutputs", { cellId: cell.id })
        },
        "cell.copySource": (cell) => {
          if (!cell) return
          copyToClipboard(String(cell.source || ""), (ok) =>
            setNotice(ok ? "已复制单元格源码" : "复制失败（浏览器拒绝了剪贴板访问）"),
          )
        },
        "cell.cite": (cell) => {
          if (cell && citeCellRef.current) citeCellRef.current(cell)
        },
        "cell.aiRewrite": (cell) => {
          if (cell) runAi(cell.id, cell.source, "", { mode: "rewrite" })
        },
        "cell.promptRewrite": (cell) => {
          if (cell) toChat(cell, { mode: "rewrite" })
        },
        "cell.moveUp": (cell) => {
          if (!cell) return
          const i = cells.findIndex((c) => c.id === cell.id)
          if (i > 0) moveCellTo(cell.id, i - 1)
        },
        "cell.moveDown": (cell) => {
          if (!cell) return
          const i = cells.findIndex((c) => c.id === cell.id)
          if (i >= 0 && i < cells.length - 1) moveCellTo(cell.id, i + 1)
        },
      }

      const onPanelKeyDownCapture = React.useCallback(
        (e) => {
          const t = e.target
          const closest = t && typeof t.closest === "function" ? (sel) => t.closest(sel) : () => null
          // 这一下属于哪一格：事件落点所在的格优先，其次当前选中格
          const host = closest("[data-cell-id]")
          const hostId = host && typeof host.getAttribute === "function" ? host.getAttribute("data-cell-id") : null
          const cell = cells.find((c) => c.id === (hostId || selected))
          const common = {
            key: e.key,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            defaultPrevented: e.defaultPrevented,
            inEditor: !!closest(".cm-editor"),
            inInput: isTextEntryTarget(t),
            inControl: !!closest("button,select,a,option,label"),
          }

          const decision = decideCellKey({ ...common, focusMode: "container" })
          if (decision !== "pass") {
            if (!cell) return
            e.preventDefault()
            e.stopPropagation()
            if (decision === "run-stay") {
              runCell(cell.id, cell.source)
              focusCell(cell.id)
              return
            }
            if (decision === "run-insert-below") {
              addCell(cell.id, true, cell.cellType)
              return
            }
            runBelow(cell.id)
            return
          }

          /**
           * 命令模式（Jupyter command mode）：A/B/DD/Z/Y/M/R/Ctrl-S/Esc。
           *
           * 判定全在纯函数 `decideCommandKey` 里（有矩阵测试）；这里只负责执行。
           * 注意 `save` 与 `command`(Esc) 不要求有 cell —— 面板空着时也要能存盘/收焦点。
           */
          /**
           * 命令分发：`decideCommandKey` 只给出**命令 id**，真正做什么全在 `commandsRef`
           * 那张表里。键位表与执行表解耦，才能做到「加快捷键只改一张表」。
           */
          const cmd = decideCommandKey({ ...common, pendingDelete: cell ? isDeleteArmed(cell.id) : false })
          if (!cmd) return
          e.preventDefault()
          e.stopPropagation()
          const handler = commandsRef.current[cmd.command]
          if (typeof handler !== "function") {
            // 命令表里有、执行表里没有 = 接线漏了。静默会变成「按了没反应」，必须喊出来。
            setNotice(`未实现的命令：${cmd.command}`)
            return
          }
          handler(cell)
        },
        /**
         * 依赖只列**函数体直接用到**的：具体动作已经搬到 `commandsRef.current` 那张表，
         * 表本身每帧重建，所以这里不需要（也不该）再列 `deleteCell` / `changeType` /
         * `restoreDeleted` —— 它们已经从这条闭包里出去了。
         */
        [cells, selected, runCell, focusCell, addCell, runBelow, isDeleteArmed, setNotice],
      )

      // ── 内核 / 环境（对齐旧插件工具栏：内核下拉 + 工作目录 + 未保存指示）──
      /**
       * `resolved` 是「没显式选内核时会用谁」（宿主算好的只读推算结果）。
       * 没有它，下拉只能显示「选择内核…」，用户不知道现在能不能直接跑。
       */
      const [kernels, setKernels] = React.useState({ kernels: [], current: null, python: null, cwd: null, resolved: null })
      /** 警告时点一下把焦点送到内核下拉（不改状态、不重启内核） */
      const kernelSelectRef = React.useRef(null)
      const loadKernels = React.useCallback(async () => {
        try {
          const res = await fetch(`/nb2/kernels?sid=${encodeURIComponent(sid)}`, { cache: "no-store" })
          setKernels(await res.json())
        } catch (err) {
          setNotice(String((err && err.message) || err))
        }
      }, [sid, setNotice])
      React.useEffect(() => {
        loadKernels()
      }, [loadKernels, state.key])

      const selectKernel = React.useCallback(
        async (kernelId) => {
          if (!kernelId) return
          try {
            setNotice("切换内核中…")
            await post("kernel/select", { sid, kernelId })
            await loadKernels()
            await refetch()
            setNotice("")
          } catch (err) {
            setNotice(String((err && err.message) || err))
          }
        },
        [sid, loadKernels, refetch, setNotice],
      )

      const changeCwd = React.useCallback(() => {
        // 第三个用途：改内核工作目录。同样不能 window.prompt（Electron 禁用）
        // ⚠️ 这里是**赋值**不是开关：早先写成 `prev === null ? X : null`，
        // 输入行已经打开时再点「工作目录」只会把它关掉，用户得点两下 —— 正是「点了没反应」。
        setPathHint("cwd")
        setOpenPath(kernels.cwd || state.cwd || "")
      }, [kernels.cwd, state.cwd])

      const saveAs = React.useCallback(() => {
        // 同样不能用 window.prompt（Electron 不支持）→ 复用同一个输入行
        setPathHint("saveAs")
        setOpenPath(state.path || "")
      }, [state.path])

      const clearOutputs = React.useCallback(() => {
        post("cell/clearOutputs", { sid })
          .then(() => refetch())
          .catch((err) => setNotice(String(err.message || err)))
      }, [sid, refetch, setNotice])

      // ── 路径输入行（打开 / 另存为共用）──
      // 为什么不用 window.prompt：Electron 里 prompt 被禁用（调用抛
      // "prompt() is and will not be supported."），按钮就表现为「点了没反应」。
      const [openPath, setOpenPath] = React.useState(null)
      // "open" | "saveAs" —— 同一个输入行两种用途
      const [pathHint, setPathHint] = React.useState("open")

      const submitPath = React.useCallback(
        (value) => {
          const target = String(value || "").trim()
          if (!target) {
            setNotice("路径不能为空")
            return
          }
          // 三种用途共用这一个输入行：打开 notebook / 另存为 / 改内核工作目录
          const route = pathHint === "saveAs" ? "notebook/saveAs" : pathHint === "cwd" ? "notebook/setCwd" : "notebook/open"
          const payload = pathHint === "cwd" ? { sid, dir: target } : { sid, path: target }
          const verb = pathHint === "saveAs" ? "另存为" : pathHint === "cwd" ? "切换工作目录" : "打开"
          post(route, payload)
            .then((out) => {
              setNotice(`${verb}成功：${(out && (out.path || out.cwd)) || target}`)
              setOpenPath(null)
              if (pathHint === "cwd") {
                loadKernels()
                return refetch()
              }
              return refetch()
            })
            .catch((err) => setNotice(`${verb}失败：${String((err && err.message) || err)}`))
        },
        [sid, pathHint, refetch, loadKernels, setNotice],
      )

      // ── 打开 notebook：面板内 picker（列表）为主，手输路径为兜底 ──
      const [pickerOpen, setPickerOpen] = React.useState(false)
      // ── 工具栏 `⋯` 溢出菜单 ──
      const [moreOpen, setMoreOpen] = React.useState(false)

      /** 面板根节点（用来判定「事件落点是不是在我们面板里」）。 */
      const panelRootRef = React.useRef(null)
      /**
       * 最近一次 mousedown 是否发生在面板内。
       *
       * 为什么需要它：点面板空白 / 输出区 / 工具栏文字这类**不可聚焦**的位置，
       * 浏览器会把焦点丢给 `<body>`，于是面板根节点上的 `onKeyDownCapture`
       * 收不到任何按键 —— 「点了面板再按 Shift-Enter 没反应」的真正原因。
       * 有了这个标记，App 才敢在 document 级兜底分发（见下面的 effect）。
       */
      const panelActiveRef = React.useRef(false)

      React.useEffect(() => {
        const onDown = (e) => {
          const root = panelRootRef.current
          panelActiveRef.current = !!(root && root.contains && root.contains(e.target))
        }
        window.addEventListener("mousedown", onDown, true)
        return () => window.removeEventListener("mousedown", onDown, true)
      }, [])

      /**
       * picker 的「优雅退出」（用户反馈第 3 条）：
       *   · Esc —— 不管焦点现在在哪（钻目录后焦点会掉到 body）
       *   · 点击浮层外部 —— 包括点工具栏、点 cell 列表、点左侧对话
       *
       * 为什么不能只靠 picker 根节点的 onKeyDown：那个处理器只在焦点**还在 picker 内**
       * 时才收到事件；点一下目录行焦点就没了，于是「Esc 关不掉」。
       * 这里用 window capture 兜底，判定与 picker 内部一致（内部先处理、这里再兜）。
       */
      React.useEffect(() => {
        if (!pickerOpen) return undefined
        const onKey = (e) => {
          if (e.key !== "Escape") return
          e.preventDefault()
          e.stopPropagation()
          setPickerOpen(false)
        }
        const onDown = (e) => {
          const t = e.target
          if (!t || typeof t.closest !== "function") return
          // 点在浮层里（搜索框/目录行/按钮）→ 不关
          if (t.closest("[data-nb2-picker='1']")) return
          // 点在「＋打开」按钮上 → 交给它自己 toggle（否则闪一下又回来）
          if (t.closest("[data-nb2-picker-anchor='1']")) return
          setPickerOpen(false)
        }
        window.addEventListener("keydown", onKey, true)
        window.addEventListener("mousedown", onDown, true)
        return () => {
          window.removeEventListener("keydown", onKey, true)
          window.removeEventListener("mousedown", onDown, true)
        }
      }, [pickerOpen])

      /**
       * Enter 组合的 document 级兜底（用户反馈第 1 条：Shift-Enter 跑不了格）。
       *
       * 面板根节点的 `onKeyDownCapture` 只在**事件落点在面板内**时才触发。
       * 一旦焦点掉到 `<body>`（点空白、点输出区、点 picker 目录行、点页面其它地方），
       * 那次 Shift-Enter 就无人接收 —— 用户看到的就是「按了没反应」。
       *
       * 兜底条件（三条同时满足才接管，宁可少管）：
       *   ① 最近一次 mousedown 在面板内（否则用户在左边对话里，不该抢他的键）；
       *   ② 事件落点**不在**面板内（在面板内的已经由 onKeyDownCapture 处理，避免跑两遍）；
       *   ③ 没被更早的处理器 preventDefault（AI 条等）。
       * 判定本身不重复实现：直接复用 onPanelKeyDownCapture（同一份 decideCellKey）。
       */
      React.useEffect(() => {
        /** 面板是否真的在屏幕上（防止右栏切到别的 tab 后本组件仍挂着、却在后台抢键）。 */
        const panelVisible = () => {
          const root = panelRootRef.current
          if (!root) return false
          try {
            if (typeof root.getBoundingClientRect === "function") {
              const r = root.getBoundingClientRect()
              return r.width > 0 && r.height > 0
            }
          } catch {
            /* ignore */
          }
          return true
        }
        const onKey = (e) => {
          if (e.key !== "Enter") return
          if (!panelActiveRef.current) return
          if (e.defaultPrevented) return
          if (!panelVisible()) return
          const root = panelRootRef.current
          if (root && e.target && root.contains && root.contains(e.target)) return
          onPanelKeyDownCapture(e)
        }
        window.addEventListener("keydown", onKey, true)
        return () => window.removeEventListener("keydown", onKey, true)
      }, [onPanelKeyDownCapture])

      /**
       * 从 picker 打开一本 notebook。
       * ⚠️ 传**绝对路径** `entry.path`：宿主 `notebook/open` 直接 `readIpynbFile(body.path)`，
       * 自己不按会话 cwd 解析相对路径，传 rel 会读不到（评审实测口径已按代码修正）。
       */
      const openFromPicker = React.useCallback(
        (entry) => {
          const target = String((entry && (entry.path || entry.rel)) || "").trim()
          if (!target) return
          setPickerOpen(false)
          post("notebook/open", { sid, path: target })
            .then(() => {
              setNotice(`打开成功：${(entry && entry.rel) || target}`)
              return refetch()
            })
            .catch((err) => setNotice(`打开失败：${String((err && err.message) || err)}`))
        },
        [sid, refetch, setNotice],
      )

      // ── 大纲（TOC）：停靠位置由用户选（关 → 左 → 右 → 关），跨会话记住 ──
      const [outlineDock, setOutlineDock] = React.useState(() => loadOutlineDock())
      /** 工具栏按钮与停靠栏的 ⇄ 都走这里：三态循环。 */
      const cycleOutlineDock = React.useCallback(() => {
        setOutlineDock((prev) => {
          const next = prev === "off" ? "left" : prev === "left" ? "right" : "off"
          saveOutlineDock(next)
          return next
        })
      }, [])
      /**
       * ── AI 设置：**补全** 与 **改写** 两套，互不影响 ──
       *
       *   `aiPrefs.completion` —— ghost text（注释→代码、行内续写），含 enabled 开关；
       *   `aiPrefs.inline`     —— AiBar 的改写 / 解释 / 修错。
       *
       * 用户反馈原话：「注释生成代码这部分，还有内置的 AI 改写，应该是两个设置来分别设置」。
       * 早先只有一份 `aiPref` 被两条通道共用，且补全开关是 `useState(false)` 不持久化
       * —— 每次重开面板都回到关，等于「设置不存在」。
       *
       * 另有两条只读数据：
       *   `aiCatalog` —— 宿主真实可用的 provider × 模型（`/nb2/ai/models`，不裁剪）；
       *   `aiEfforts` / `compEfforts` —— **各自模型自己声明的**强度清单
       *   （`/nb2/ai/efforts`）。为什么强度要按模型查：宿主对显式传入但该模型不支持的
       *   effort 会**直接拒绝**（不 clamp、不别名），所以下拉里只能是它真的有的值。
       */
      const [aiPrefs, setAiPrefs] = React.useState(() => loadAiPrefs())
      const aiPref = aiPrefs.inline
      const compPref = aiPrefs.completion
      const [aiCatalog, setAiCatalog] = React.useState({ providers: [], target: null, ok: false })
      const [aiEfforts, setAiEfforts] = React.useState({ provider: null, model: null, efforts: [], defaultEffort: null })
      const [compEfforts, setCompEfforts] = React.useState({ provider: null, model: null, efforts: [], defaultEffort: null })
      const [aiBarOpen, setAiBarOpen] = React.useState(false)
      /**
       * 补全参数输入框的草稿（`null` = 显示真实值）。
       *
       * 为什么需要草稿：入库值会被夹到区间（100–2000ms / 1–20 行）。如果输入框直接绑
       * 夹取后的值，用户想输 "800" 时先输的 "8" 会被立刻夹成 "100" 并把光标顶走 ——
       * 表现为「这个框根本没法输入」。所以输入过程走草稿，只有落在合法区间才实时入库。
       */
      const [compDraft, setCompDraft] = React.useState({ debounceMs: null, maxLines: null })

      /** 改其中一套并**立刻存盘**（补全 / 改写共用这一条路径）。 */
      const patchPrefs = React.useCallback((which, patch) => {
        setAiPrefs((prev) => {
          const cur = which === "completion" ? prev.completion : prev.inline
          const next = { ...prev, [which]: { ...cur, ...(patch || {}) } }
          saveAiPrefs(next)
          return next
        })
      }, [])
      const updateAiPref = React.useCallback((patch) => patchPrefs("inline", patch), [patchPrefs])
      const updateCompPref = React.useCallback((patch) => patchPrefs("completion", patch), [patchPrefs])

      /**
       * 补全参数输入（#13）：输进合法区间就立刻入库（改完立即生效，不用刷新）。
       * ⚠️ 必须定义在 `updateCompPref` **之后**：依赖数组在渲染期求值，
       * 写在前面会 TDZ 炸掉整个面板（本仓库已踩过三次，见 AGENTS.md）。
       */
      const commitCompNumber = React.useCallback(
        (key) => (e) => {
          const raw = String((e && e.target && e.target.value) || "")
          setCompDraft((d) => ({ ...d, [key]: raw }))
          const v = Number(raw)
          if (raw !== "" && Number.isFinite(v) && v > 0) updateCompPref({ [key]: v })
        },
        [updateCompPref],
      )
      const resetCompDraft = React.useCallback((key) => () => setCompDraft((d) => ({ ...d, [key]: null })), [])

      /** 补全总开关（派生自 compPref.enabled；兼容 `setAiComplete(v => !v)` 的调用形状）。 */
      const aiComplete = !!compPref.enabled
      const setAiComplete = React.useCallback(
        (v) => updateCompPref({ enabled: typeof v === "function" ? !!v(!!compPref.enabled) : !!v }),
        [updateCompPref, compPref.enabled],
      )

      /** 拉全部 provider × 模型（设置栏的「模型」下拉数据源）。 */
      const loadAiCatalog = React.useCallback(async () => {
        try {
          const res = await fetch(`/nb2/ai/models?sid=${encodeURIComponent(sid)}`, { cache: "no-store" })
          const json = await res.json()
          const providers = Array.isArray(json && json.providers) ? json.providers : []
          setAiCatalog({ providers, target: (json && json.target) || null, ok: !!(json && json.ok) })
        } catch {
          setAiCatalog({ providers: [], target: null, ok: false })
        }
      }, [sid])

      /** 拉某个模型**自己声明的**思考强度。模型没选/不支持 → 空清单。 */
      const fetchEfforts = React.useCallback(async (provider, model, setter) => {
        if (!provider || !model) {
          setter({ provider: null, model: null, efforts: [], defaultEffort: null })
          return
        }
        try {
          const q = `provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
          const res = await fetch(`/nb2/ai/efforts?${q}`, { cache: "no-store" })
          const json = await res.json()
          setter({
            provider,
            model,
            efforts: Array.isArray(json && json.efforts) ? json.efforts : [],
            defaultEffort: (json && json.defaultEffort) || null,
          })
        } catch {
          setter({ provider, model, efforts: [], defaultEffort: null })
        }
      }, [])
      const loadAiEfforts = React.useCallback((p, m) => fetchEfforts(p, m, setAiEfforts), [fetchEfforts])
      const loadCompEfforts = React.useCallback((p, m) => fetchEfforts(p, m, setCompEfforts), [fetchEfforts])

      // 首次挂载拉一次目录；哪一套没手动选过就采纳宿主解析出的默认 target
      React.useEffect(() => {
        loadAiCatalog()
      }, [loadAiCatalog])

      React.useEffect(() => {
        if (!aiCatalog.target) return
        const t = aiCatalog.target
        setAiPrefs((prev) => {
          const patch = (cur) => (cur.provider && cur.model ? cur : { ...cur, provider: t.provider || null, model: t.model || null })
          const next = { completion: patch(prev.completion), inline: patch(prev.inline) }
          if (next.completion === prev.completion && next.inline === prev.inline) return prev
          return next
        })
      }, [aiCatalog.target])

      // 选中的模型变了 → 重新拉该模型的强度清单，并校正失效的强度选择
      React.useEffect(() => {
        loadAiEfforts(aiPref.provider, aiPref.model)
      }, [loadAiEfforts, aiPref.provider, aiPref.model])

      React.useEffect(() => {
        loadCompEfforts(compPref.provider, compPref.model)
      }, [loadCompEfforts, compPref.provider, compPref.model])

      React.useEffect(() => {
        if (aiEfforts.provider !== aiPref.provider || aiEfforts.model !== aiPref.model) return
        const ids = aiEfforts.efforts.map((e) => e.id)
        setAiPrefs((prev) => {
          const cur = prev.inline
          // 选过且仍然合法 → 保留；否则落到模型默认 / 空
          if (cur.reasoningEffort && ids.includes(cur.reasoningEffort)) return prev
          const fallback = aiEfforts.defaultEffort && ids.includes(aiEfforts.defaultEffort) ? aiEfforts.defaultEffort : null
          if (cur.reasoningEffort === fallback) return prev
          return { ...prev, inline: { ...cur, reasoningEffort: fallback } }
        })
      }, [aiEfforts, aiPref.provider, aiPref.model])

      React.useEffect(() => {
        if (compEfforts.provider !== compPref.provider || compEfforts.model !== compPref.model) return
        const ids = compEfforts.efforts.map((e) => e.id)
        setAiPrefs((prev) => {
          const cur = prev.completion
          if (cur.reasoningEffort && ids.includes(cur.reasoningEffort)) return prev
          const fallback = compEfforts.defaultEffort && ids.includes(compEfforts.defaultEffort) ? compEfforts.defaultEffort : null
          if (cur.reasoningEffort === fallback) return prev
          return { ...prev, completion: { ...cur, reasoningEffort: fallback } }
        })
      }, [compEfforts, compPref.provider, compPref.model])

      // ── 内联 AI（M4）：指令 → 流式 → diff 评审 → 接受 ──
      const [ai, setAi] = React.useState({
        open: false,
        cellId: null,
        instruction: "",
        streaming: false,
        text: "",
        ms: 0,
        error: null,
        baseCode: "",
        // 选区级改写：{ text, startLine, endLine } 或 null（整格改写）
        selection: null,
        // rewrite-selection / rewrite / complete / explain / fix
        mode: "rewrite",
        // 本次请求实际带上的上下文摘要（给 AI 条上的胶囊用）
        ctx: { neighbours: 0, vars: 0, error: false },
      })
      const aiAbortRef = React.useRef(null)
      // 上下文开关（用户可以把某一项关掉省钱）
      const [aiCtx, setAiCtx] = React.useState({ neighbours: true, vars: true, error: true })
      // 内核变量快照（懒加载 + 5s 内复用；拿不到就是空，不影响 AI 可用性）
      const varsRef = React.useRef({ at: 0, vars: [] })

      /**
       * 把一段文本（结构化引用 / 提示词）投递到左侧主对话输入框。
       *
       * 三层，按**实测可用性**降级（2026-11-06 实测，见
       * docs/research/2026-11-06-chat-delivery-实测.md）：
       *  ① `props.inputActions` 的 `captureInsertion()` + `insertText(text, span)`
       *     —— 本版唯一真正写进输入框的通道（Lexical 编辑器，插入而非整体替换）；
       *  ② `getChatBridge()`（新版本 DSH 的 `conversation` 服务）—— 本版恒为 null，留作前向兼容；
       *  ③ 剪贴板 —— 只有 ① ② 都不行时才用，提示必须说清断在哪一层，不许假装成功。
       *
       * 投递正文第一行是**顶格**的 `@<路径> (Cell[3] L4-L8)`。这一行有两个用途：
       * ① 给 agent 的定位（`nb_open` + 序号）；
       * ② DSH 会把它渲染成文件引用（输入框里是 text-ref，消息里是文件芯片），
       *    所以对话框里看到的是一小段引用而不是一长串路径。
       *
       * @param {string} text 正文（围栏代码块 / 报错全文 / 提示词）
       * @param {{path?:string, cellIndex?:number, startLine?:number, endLine?:number, kind?:string}} [refSpec]
       */
      const cite = React.useCallback(
        (text, refSpec) => {
          const raw = String(text || "").trim()
          if (!raw) return false
          const spec = refSpec || null
          const ref = spec && (spec.path || spec.cellIndex) ? formatNotebookRef(spec) : null
          // 定位串放最前面：主 agent 只需要这一行就知道该 nb_open 哪个文件的第几格
          const body = ref ? `${ref.modelForm}\n\n${raw}` : raw
          const delivered = deliverInputText(slotInputActions, body)
          if (delivered.ok) {
            setNotice(ref ? `已投递到对话：${ref.label}` : "已投递到对话")
            return true
          }
          /**
           * 失败原因要**分层写明**：这句提示是唯一能看到「哪一层断了」的地方。
           * 老文案「无法桥接」把「拿不到桥」「桥在但写入被拒」混成一句，
           * 用户报障时只能说「还是不行」，排查每次都从零开始。
           */
          let reason = delivered.reason
          const bridge = getChatBridge(sid)
          if (bridge) {
            if (ref) {
              const chip = {
                // 复用原生 @file 引用源：零新增注册、芯片可点开文件、发送不会被拒。
                source: "reference",
                ref: `@${ref.rel}`,
                label: ref.label,
                appearance: "file",
                clipboardText: ref.modelForm,
              }
              if (bridge.insertReference(chip)) {
                setNotice(`已投递到对话：${ref.label}`)
                return true
              }
            }
            if (bridge.appendText(body)) {
              setNotice("已投递到对话（纯文本引用）")
              return true
            }
            let phase = "?"
            try {
              phase = String((bridge.state() || {}).phase || "?")
            } catch {
              /* ignore */
            }
            reason = `${reason}；会话桥写入也被拒（草稿 phase=${phase}）`
          }
          try {
            if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(body)
              setNotice(`投递失败：${reason}；已复制到剪贴板（Ctrl+V 粘进对话框即可）`)
              return true
            }
          } catch {
            /* ignore */
          }
          setNotice(`投递失败：${reason}（剪贴板也不可用）`)
          return false
        },
        [sid, setNotice, slotInputActions],
      )

      const closeAi = React.useCallback(() => {
        if (aiAbortRef.current) {
          try {
            aiAbortRef.current()
          } catch {
            /* ignore */
          }
          aiAbortRef.current = null
        }
        setAi((prev) => ({ ...prev, open: false, streaming: false, text: "", error: null }))
      }, [])

      /**
       * 取内核变量快照摘要（`/nb2/vars`）。
       *
       * 为什么要它：Notebook 里写数据分析代码时，AI 若不知道当前内核里 `df` 有哪些列、
       * `model` 是什么类型，生成的代码几乎一定跑不通（反馈 2「Kernel-blind」）。
       * 缓存 8s，且**失败一律降级为空**：AI 可用性不能依赖内核是否活着。
       */
      const loadVars = React.useCallback(async () => {
        const now = Date.now()
        if (now - varsRef.current.at < 8000) return varsRef.current.vars
        try {
          const res = await fetch(`/nb2/vars?sid=${encodeURIComponent(sid)}`, { cache: "no-store" })
          const json = await res.json()
          const vars = Array.isArray(json && json.vars) ? json.vars : []
          varsRef.current = { at: Date.now(), vars }
          return vars
        } catch {
          varsRef.current = { at: Date.now(), vars: [] }
          return []
        }
      }, [sid])

      /** 收集「最近一次报错」摘要（当前格优先，其次任何格）。 */
      const collectError = React.useCallback(
        (cellId) => {
          const pick = (cell) => {
            const outs = (cell && cell.outputs) || []
            for (let i = outs.length - 1; i >= 0; i -= 1) {
              const o = outs[i]
              if (o && o.kind === "error") {
                const tb = (o.traceback || []).slice(-5).join("\n")
                return { ename: o.ename, evalue: o.evalue, traceback: tb }
              }
            }
            return null
          }
          const own = pick(state.cells.find((c) => c.id === cellId))
          if (own) return own
          for (let i = state.cells.length - 1; i >= 0; i -= 1) {
            const e = pick(state.cells[i])
            if (e) return e
          }
          return null
        },
        [state.cells],
      )

      /**
       * 「交给对话」：把这一格（或选中的几行）连同上下文写成**提示词**，投进主对话。
       *
       * 为什么要有这条路（用户 2026-11-06 的原话）：「AI 改写这部分，它看不到我的整个项目的
       * 上下文，还不如用提示词法到对话框里让人家给改」。内联 AI 走的是插件自己的 LLM 端点，
       * 手里只有 本格 + 邻格 + 变量/报错摘要；主对话 agent 有完整工作区上下文和 `nb_*` 工具，
       * 所以「需要看项目的改法」应该交给它 —— 这里只负责把话说清楚。
       *
       * ⚠️ 定义位置必须在 `aiHandlers`（useMemo）**之前**：它的 deps 数组里会出现 `toChat`，
       * 而 deps 是在渲染期就地求值的 —— 挪到后面就是 TDZ 崩（本仓库同类坑踩过三次）。
       *
       * @param {object|string} cellOrId
       * @param {{mode?:string, instruction?:string, selection?:object, errorInfo?:object}} [opts]
       * @returns {Promise<boolean>}
       */
      const toChat = React.useCallback(
        async (cellOrId, opts) => {
          const o = opts || {}
          const cell = typeof cellOrId === "string" ? cells.find((c) => c.id === cellOrId) : cellOrId
          if (!cell) return false
          const idx = cells.findIndex((c) => c.id === cell.id) + 1
          /**
           * 这里**不再**收集邻格源码 / 内核变量：投递正文已经瘦成
           * 「@定位 + 要求 + 选区 + 一行报错」，其余上下文由主对话的 `nb_get` /
           * `nb_list_vars` / `nb_error_context` 自己拿（用户 2026-11-11：对话框太长）。
           * 顺带省掉一次 `/nb2/vars` 往返。
           */
          const err = aiCtx.error ? o.errorInfo || collectError(cell.id) : null
          const prompt = buildChatPrompt({
            path: state.path,
            mentionPath: workspaceRelativeMention(state.path, state.cwd),
            cellIndex: idx,
            cellType: normalizeCellType(cell.cellType),
            language: languageOfCell(cell),
            selection: o.selection || null,
            instruction: o.instruction || "",
            mode: o.mode || (o.selection ? "rewrite-selection" : "rewrite"),
            error: err,
          })
          return cite(prompt)
        },
        [cells, state.path, aiCtx, collectError, cite],
      )

      const runAi = React.useCallback(
        (cellId, code, instruction, opts) => {
          if (aiAbortRef.current) {
            try {
              aiAbortRef.current()
            } catch {
              /* ignore */
            }
          }
          const options = opts || {}
          const selection = options.selection || null
          const mode = options.mode || (selection ? "rewrite-selection" : String(code || "").trim() ? "rewrite" : "complete")

          // 邻格上下文：上一格 + 下一格够用，给太多反而干扰
          const idx = state.cells.findIndex((c) => c.id === cellId)
          const context = []
          if (aiCtx.neighbours) {
            if (idx > 0 && state.cells[idx - 1].source.trim()) context.push({ source: state.cells[idx - 1].source })
            if (idx >= 0 && idx + 1 < state.cells.length && state.cells[idx + 1].source.trim()) {
              context.push({ source: state.cells[idx + 1].source })
            }
          }
          const errInfo = aiCtx.error ? options.errorInfo || collectError(cellId) : null
          const ctxSummary = { neighbours: context.length, vars: 0, error: !!errInfo }

          setAi((prev) => ({
            ...prev,
            open: true,
            cellId,
            instruction,
            streaming: true,
            text: "",
            ms: 0,
            error: null,
            baseCode: code,
            selection,
            mode,
            ctx: ctxSummary,
          }))
          const started = Date.now()

          // 变量快照是异步的，等它但不阻塞 UI：先画「请求中」，拿到再补进请求体
          const varsP = aiCtx.vars ? loadVars() : Promise.resolve([])
          Promise.resolve(varsP)
            .catch(() => [])
            .then((vars) => {
              // 用户可能在等待期间关掉了这一格
              const usedVars = Array.isArray(vars) ? vars.slice(0, 24) : []
              aiAbortRef.current = streamAi(
                {
                  sid,
                  cellId,
                  mode,
                  instruction,
                  code,
                  context,
                  // 选区级改写：只让模型返回「替换选区的那段代码」
                  selection: selection ? { text: selection.text, startLine: selection.startLine, endLine: selection.endLine } : null,
                  // 内核变量摘要（列名/shape/类型），让模型知道 df 里有什么
                  vars: usedVars,
                  // 最近一次报错（ename + evalue + 尾 5 行 traceback）
                  error: errInfo,
                  /**
                   * 改写通道自己的模型设置（`aiPrefs.inline`）。
                   *
                   * ⚠️ 早先这里**一个字段都不传** → 后端只能退回它自己的 `config.ai` 默认值，
                   * 于是「在设置栏选模型」对改写根本不生效（只对补全生效）。这也正是用户
                   * 要求「两个设置分开」时才暴露出来的第二个洞。
                   */
                  provider: aiPref.provider || undefined,
                  model: aiPref.model || undefined,
                  reasoningEffort: aiPref.reasoningEffort || undefined,
                },
                {
                  onDelta: (t) => setAi((prev) => (prev.cellId === cellId ? { ...prev, text: prev.text + t } : prev)),
                  onDone: (msg) =>
                    setAi((prev) =>
                      prev.cellId === cellId
                        ? { ...prev, streaming: false, text: msg.text || prev.text, ms: msg.ms || Date.now() - started, ctx: { ...prev.ctx, vars: usedVars.length } }
                        : prev,
                    ),
                  onError: (err) =>
                    setAi((prev) => (prev.cellId === cellId ? { ...prev, streaming: false, error: err, ms: Date.now() - started } : prev)),
                },
              )
              setAi((prev) => (prev.cellId === cellId ? { ...prev, ctx: { ...prev.ctx, vars: usedVars.length } } : prev))
            })
        },
        [sid, state.cells, aiCtx, collectError, loadVars, aiPref],
      )

      const acceptAi = React.useCallback(
        async (run) => {
          const cellId = ai.cellId
          const next = stripFences(ai.text || "")
          if (!cellId || !next) return closeAi()
          /**
           * 选区级改写：只替换选中的那几行。
           *
           * 走「编辑器 dispatch」而不是「整格 cell/edit」有两个好处：
           *  1. 进 CM6 undo 栈 → 用户 Ctrl+Z 就能撤回（VS Code inline chat 同体验）；
           *  2. 走既有 onChange → changeSource 链路，乐观更新与防抖落库自动生效。
           * 拿不到编辑器（格已卸载 / markdown 渲染态）时退化成整格替换，功能不丢。
           */
          const sel = ai.selection
          /**
           * 行号必须可信（`validSelectionRange`）：DOM 选区给的是 -1，
           * 一旦让 -1 流下去，`Number(-1)||0` 会把它变成 0 → 静默改写文件开头。
           * 不可信就当「没有选区」，退回整格语义（至少语义是明确的）。
           */
          const selOk = validSelectionRange(sel)
          /**
           * 模型可能不听话：提示词要它只返回选中的那几行，它却返回了整格。
           * 这里先判别，整格回包就走「整格替换」；但**整格替换必须有校验**（见下），
           * 因为判别是启发式的，误判的代价是把选区之外的代码静默删掉。
           */
          const replyKind = selOk
            ? classifySelectionReply({
                reply: next,
                selection: sel,
                cellCode: (state.cells.find((c) => c.id === cellId) || {}).source || ai.baseCode || "",
              })
            : "snippet"
          const useSelection = selOk && replyKind === "snippet"
          /**
           * Q1 修复：整格回包（replyKind === "full-cell"）不能直接覆盖整格。
           *
           * 判别是启发式的：模型只要在回包里复述一行上下文，就会被判成整格；反过来，
           * 它真返回整格但顺手改了选区之外的行，又不会逐字包含那些行。
           * 两种情况下「直接 post 整格」都可能**静默删掉用户没让它改的代码**。
           * 所以只允许一种安全的整格覆盖：回包**逐字包含**选区之外的每一行非空原文
           * （说明它只是把原代码抄回来 + 改了选区那几行）。不满足就拒绝写入并提示用户 ——
           * 宁可让用户手动看一眼 diff，也不能悄悄改坏代码。
           */
          let safeFullCell = replyKind === "full-cell"
          if (safeFullCell) {
            const base = String((state.cells.find((c) => c.id === cellId) || {}).source || ai.baseCode || "")
            safeFullCell = fullCellCoversOutside({ reply: next, selection: sel, cellCode: base })
            if (!safeFullCell) {
              setNotice("AI 返回了整格并改动了选区之外的代码，已取消写入（避免覆盖你没让它改的部分）。请检查上方 diff 后重试，或换个更明确的指令。")
              // 保留 AI 条开着，让用户自己看 diff，不关面板
              return undefined
            }
          }
          // 只按「AI 条属于哪个 cellId」取编辑器；与当前选中谁无关（否则会改坏别的格）
          const editorApi = useSelection && editorRef.current.cellId === cellId ? editorRef.current.api : null
          if (useSelection && editorApi && typeof editorApi.applySelectionEdit === "function") {
            const ok = editorApi.applySelectionEdit({ startLine: sel.startLine, endLine: sel.endLine, insert: next })
            if (ok) {
              if (run) {
                /**
                 * 「接受并运行」必须跑**改完之后**的源码。
                 *
                 * ⚠️ 不能读 `state.cells`：这个 `acceptAi` 闭包里捕获的 state 是旧值
                 * （React 的 setState 是批处理的，而且 useCallback 的闭包不会随 setState 就地更新），
                 * 读到的会是**改写前**的源码 → 用户点了「接受并运行」，跑的却是旧代码。
                 * 编辑器自己是权威且同步的（dispatch 之后 `state.doc` 立刻是新内容），直接从它读。
                 */
                const src = editorApi.getSource ? editorApi.getSource() : (state.cells.find((c) => c.id === cellId) || {}).source
                post("cell/run", { sid, cellId, source: src, wait: false }).catch(() => {})
              }
              return closeAi()
            }
          }
          /**
           * ⚠️ 降级路径绝不能用「片段」覆盖整格。
           *
           * 选区级改写时模型只返回「替换选中那几行」的片段；如果拿不到编辑器
           * （格已卸载 / dispatch 因行号漂移失败），直接把片段 `post("cell/edit",{source:片段})`
           * 会把用户整格源码**覆盖成一小段**，属于不可恢复的数据破坏。
           * 正确降级：用 baseCode 把片段**拼接**回原位置，再整格写回。
           * 连 baseCode 都没有时宁可不写，只提示 —— 宁可少一个功能，不能改坏用户代码。
           */
          if (useSelection) {
            /**
             * 拼接基准用**当前实时源码**，不用 `ai.baseCode`（那是打开 AI 条那一刻的快照）。
             * 用户可能在生成期间又改了这格；用旧快照会把那几笔改动一起回滚掉。
             */
            const live = state.cells.find((c) => c.id === cellId)
            const base = String((live && live.source) != null ? live.source : ai.baseCode || "")
            if (base === "") {
              setNotice("选区改写的原格代码已丢失，已取消写入（避免覆盖你的代码）")
              return closeAi()
            }
            const lines = base.split("\n")
            // 这里已经过 validSelectionRange（useSelection 的前提），直接用整数
            const start = Math.max(0, Math.min(Number(sel.startLine), lines.length - 1))
            const end = Math.max(start, Math.min(Number(sel.endLine), lines.length - 1))
            const merged = lines.slice(0, start).concat(next.split("\n")).concat(lines.slice(end + 1)).join("\n")
            try {
              await post("cell/edit", { sid, cellId, source: merged })
              await refetch()
              if (run) await post("cell/run", { sid, cellId, wait: false })
            } catch (err) {
              setNotice(String((err && err.message) || err))
            }
            return closeAi()
          }
          try {
            await post("cell/edit", { sid, cellId, source: next })
            await refetch()
            if (run) await post("cell/run", { sid, cellId, wait: false })
          } catch (err) {
            setNotice(String((err && err.message) || err))
          }
          return closeAi()
        },
        [ai.cellId, ai.text, ai.selection, ai.mode, sid, refetch, setNotice, closeAi, state.cells],
      )

      // AI 条打开时：Mod-Enter 接受、Esc 拒绝（与按钮上标的键位一致）
      React.useEffect(() => {
        if (!ai.open) return undefined
        const onKey = (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            acceptAi(false)
          } else if (e.key === "Escape") {
            e.preventDefault()
            closeAi()
          }
        }
        window.addEventListener("keydown", onKey, true)
        return () => window.removeEventListener("keydown", onKey, true)
      }, [ai.open, acceptAi, closeAi])

      const aiHandlers = React.useMemo(
        () => ({
          /**
           * 打开内联 AI 条。
           * @param {string} cellId
           * @param {string} code 整格源码（diff 的「前」；选区模式下滑动到选中行）
           * @param {{selection?:object, mode?:string, instruction?:string, errorInfo?:object}} [opts]
           */
          open: (cellId, code, opts) => {
            const o = opts || {}
            // 只打开、不发请求：等用户敲指令。带上选区，AiBar 会显示「第 X–Y 行」
            setAi((prev) => ({
              ...prev,
              open: true,
              cellId,
              instruction: o.instruction || "",
              streaming: false,
              text: "",
              ms: 0,
              error: null,
              baseCode: code,
              selection: o.selection || null,
              mode: o.mode || (o.selection ? "rewrite-selection" : "rewrite"),
              ctx: { neighbours: 0, vars: varsRef.current.vars.length, error: false },
            }))
          },
          /**
           * 报错块「🔧 AI 快速修复」：把 ename/evalue/尾 5 行 traceback 变成指令，
           * 直接流式生成修复 diff。不离开 Notebook、不等一整轮 agent。
           */
          fix: (cellId, code, errBlock) => {
            const ename = (errBlock && errBlock.ename) || "Error"
            const evalue = (errBlock && errBlock.evalue) || ""
            const tb = ((errBlock && errBlock.traceback) || []).slice(-5).join("\n")
            const instruction = `Fix this ${ename}: ${evalue}\n\nTraceback (tail):\n${tb}`
            runAi(cellId, code, instruction, {
              // mode:"fix" 走独立提示词分支（要求返回**完整修正后的整格**，配合整格 diff 评审）
              mode: "fix",
              errorInfo: { ename, evalue, traceback: tb },
            })
          },
          bar: (cellId, code) => ({
            onInstruction: (text) => runAi(cellId, code, text, { mode: ai.mode, selection: ai.selection }),
            onCancel: closeAi,
            onAccept: () => acceptAi(false),
            onAcceptRun: () => acceptAi(true),
            onRetry: () => runAi(cellId, code, ai.instruction, { mode: ai.mode, selection: ai.selection }),
            onToggleCtx: (key) => setAiCtx((prev) => ({ ...prev, [key]: !prev[key] })),
            /**
             * 「交给对话」：把同样的位置/现状/要求写成提示词投进主对话。
             * 内联 AI 只看得见这几格，看项目的改法必须交给有完整上下文的 agent。
             */
            onToChat: (text) => {
              const instruction = String(text == null ? ai.instruction || "" : text)
              closeAi()
              toChat(cellId, { mode: ai.mode, selection: ai.selection, instruction })
            },
          }),
          /** 右键菜单 / 选区条：把这一格交给对话改（不带内联 AI 条）。 */
          toChat: (cellOrId, opts) => toChat(cellOrId, opts),
        }),
        [runAi, closeAi, acceptAi, ai.instruction, ai.mode, ai.selection, toChat],
      )

      /**
       * AI 自动补全（ghost text）能力对象。
       *
       * 每次请求都是一次 HTTP 往返：`/nb2/ai/complete` 返回一行 suggestion。
       * 失败/超时一律静默（返回 null）—— 补全是「锦上添花」，不能因为模型抽风
       * 就打断用户打字。
       */
      /**
       * 补全失败指示（P0-6）。
       *
       * 「静默失败」在补全里是个**体验陷阱**：限流 / 凭据失效 / provider 挂了，
       * 与「AI 觉得这里没啥可补」在界面上完全一样，用户只会觉得「这功能时灵时不灵」。
       * 所以失败要在状态栏亮一下（5s 自动消失），但**绝不弹窗打断打字**。
       */
      const [ghostError, setGhostError] = React.useState(null)
      const ghostErrorTimerRef = React.useRef(null)
      const reportGhostError = React.useCallback((msg) => {
        setGhostError(msg)
        if (ghostErrorTimerRef.current) clearTimeout(ghostErrorTimerRef.current)
        ghostErrorTimerRef.current = setTimeout(() => setGhostError(null), 5000)
      }, [])
      React.useEffect(
        () => () => {
          if (ghostErrorTimerRef.current) clearTimeout(ghostErrorTimerRef.current)
        },
        [],
      )

      const [ghostBusy, setGhostBusy] = React.useState(null)
      const ghost = React.useMemo(
        () => ({
          enabled: aiComplete,
          /**
           * 设置项（#13）：防抖时长与最大行数。
           * 走函数而不是值 —— 编辑器只挂一次，设置改了要能立刻读到新值。
           */
          options: () => ({ debounceMs: compPref.debounceMs, maxLines: compPref.maxLines }),
          /** 在途指示：面板状态栏 + 该格工具条都显示 `AI ⋯` */
          onBusy: (busy) => setGhostBusy(busy ? "__any__" : null),
          request: async ({ prefix, suffix, signal, cellId }) => {
            try {
              /**
               * 跨格上下文 v2（#8）：按**总预算**从近到远填（不再是固定前 3 格），
               * markdown 格折成一行意图注释。只送当前格的 prefix 时，模型不知道
               * 上面 import 了什么、df 是哪来的、这一节要干什么（反馈 2 原文）。
               *
               * 当前格定位用**显式 cellId**（CellEditor 传入），不用「prefix 文本反查」——
               * 反查匹配不上时会退化成「取最后几格」，于是把当前格自己也当成前序格，
               * 模型看到自己的代码就会原样抄回来（幽灵文本变成重复代码）。
               */
              const localIdx = cellId ? state.cells.findIndex((c) => c.id === cellId) : -1
              const before = buildGhostContext(state.cells, localIdx)
              /**
               * 取内核变量（8s 缓存；失败降级空数组）。
               * 放在请求前而不是并发：补全本来就 0.5s 防抖 + 1–2s 往返，多一次本地缓存命中
               * 不会成为瓶颈；拿不到就是空，绝不影响补全可用性。
               */
              const varsForGhost = await loadVars().catch(() => [])
              const res = await fetch("/nb2/ai/complete", {
                method: "POST",
                headers: { "content-type": "application/json" },
                // signal 让「切格/关面板」能把在途请求掐掉，不浪费 token
                signal: signal || undefined,
                body: JSON.stringify({
                  prefix,
                  suffix,
                  context: before,
                  timeoutMs: 6000,
                  /**
                   * 内核变量摘要：补全通道此前**一个都没传**（只有改写通道有），
                   * 于是补全只能瞎猜 `df` 有哪些列 —— notebook 场景最主要的失败原因。
                   * `loadVars` 自带 8s 缓存且失败降级为空，不会拖慢或拖垮补全。
                   */
                  vars: varsForGhost,
                  // **补全通道自己的设置**（aiPrefs.completion）：逐字段传，没选过就不传
                  // （让宿主用自己的默认）。与改写通道互不影响。
                  provider: compPref.provider || undefined,
                  model: compPref.model || undefined,
                  reasoningEffort: compPref.reasoningEffort || undefined,
                }),
              })
              const json = await res.json()
              if (!res.ok) {
                reportGhostError(`HTTP ${res.status}`)
                return null
              }
              if (!json || !json.suggestion) {
                /**
                 * 区分「真的没有可补的内容」与「请求坏了」。
                 *
                 * 后端在失败时会回 `{ ok:false, error }`，超时/取消回 `{ aborted:true }`。
                 * 早先这里一律 `return null` —— 限流、凭据失效、provider 挂了在 UI 上
                 * 与「AI 觉得没啥可补」**完全无法区分**（调研点出的盲盒问题）。
                 * 取消是我们自己 abort 的，不该打扰用户。
                 */
                if (json && json.ok === false && !json.aborted && json.error) {
                  reportGhostError(String(json.error).slice(0, 80))
                }
                return null
              }
              const raw = trimOverlap(prefix, normalizeSuggestion(json.suggestion))
              if (!raw) return null
              /**
               * 注释行触发 → 代码另起一行（用户反馈第 3 条）。
               * 判定与实际插入用**同一个纯函数**，避免「提示词让它换行、这里又加一个」叠成空行。
               */
              const placed = completionInsertText({ prefix, suffix, suggestion: raw })
              const suggestion = placed.text
              if (!suggestion) return null
              /**
               * 设置项 #13：最多 `maxLines` 行（默认 6）。
               * 提示词与宿主 maxTokens 已经压着，这里再闸一道 —— 模型仍偶尔吐十几行，
               * 铺在编辑器里既难看又难接受。
               */
              const limited = truncateLines(suggestion, compPref.maxLines)
              if (!limited) return null
              // 兜底：模型把已有代码整串抄回来时不要重复插入
              if (prefix.endsWith(limited)) return null
              return { suggestion: limited }
            } catch (err) {
              // 取消（切格 / 新键入 abort）不是错误，静默；其余要让人看见
              const aborted = (signal && signal.aborted) || (err && err.name === "AbortError")
              if (!aborted) reportGhostError(String((err && err.message) || "补全请求失败").slice(0, 80))
              return null
            }
          },
        }),
        [aiComplete, state.cells, compPref, loadVars, reportGhostError],
      )

      // 滚动锚定：输出变长时，正在看上面的人不该被踹到底部（vscode 的 NotebookCellAnchor 同理）。
      const listRef = React.useRef(null)
      /**
       * 初始 `pinned: false`：打开一本 notebook 应该停在**第一格**，不是底部。
       * 早先这里是 true，layout effect 第一帧就把 scrollTop 设成 scrollHeight（滚到底）。
       */
      const anchorRef = React.useRef({ top: 0, height: 0, pinned: false })
      /**
       * 当前 notebook 的身份：`state.path` 优先（同一个文件跨会话恢复位置），
       * 未落盘的新 notebook 退回 tab key（至少同一会话内不串位）。
       */
      const viewKey = String(state.path || state.key || "")
      /** 上一次 commit 时是哪一本；变化 = 换书了，要换成这本的恢复目标。 */
      const viewKeyRef = React.useRef("")
      /** 待应用的恢复目标 `{ top, cellId }`；cells 还没到时会一直留着，到达后再落位。 */
      const pendingViewRef = React.useRef(null)
      const viewSaveTimerRef = React.useRef(0)

      /** DOM 里每格的纵向几何（相对滚动容器内容起点），喂给纯函数 `pickTopCellId`。 */
      const collectCellRects = (el) => {
        const out = []
        if (!el || typeof el.querySelectorAll !== "function") return out
        const base = el.getBoundingClientRect().top - el.scrollTop
        const nodes = el.querySelectorAll("[data-cell-id]")
        for (let i = 0; i < nodes.length; i += 1) {
          const n = nodes[i]
          const id = n.getAttribute && n.getAttribute("data-cell-id")
          if (!id) continue
          const r = n.getBoundingClientRect()
          out.push({ id, top: r.top - base, bottom: r.bottom - base })
        }
        return out
      }

      const saveViewNow = () => {
        const el = listRef.current
        const key = viewKeyRef.current
        if (!el || !key) return
        saveViewState(key, { top: el.scrollTop, cellId: pickTopCellId(collectCellRects(el), el.scrollTop) })
      }

      const onScroll = () => {
        const el = listRef.current
        if (!el) return
        anchorRef.current.pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 12
        anchorRef.current.top = el.scrollTop
        anchorRef.current.height = el.scrollHeight
        // 滚动时收掉右键菜单：fixed 浮层不会跟着走，留着就是「飘在原地的幽灵菜单」
        if (ctxMenuRef.current) closeCtxMenuRef.current()
        /**
         * 位置记忆节流写：scroll 事件每帧都有，不能每帧摸一次 localStorage。
         * 250ms 后写一次，停手就会落盘；卸载时再补一次（见下面的 cleanup）。
         */
        if (!viewSaveTimerRef.current && viewKeyRef.current) {
          viewSaveTimerRef.current = setTimeout(() => {
            viewSaveTimerRef.current = 0
            saveViewNow()
          }, 250)
        }
      }

      React.useEffect(
        () => () => {
          if (viewSaveTimerRef.current) {
            clearTimeout(viewSaveTimerRef.current)
            viewSaveTimerRef.current = 0
          }
          saveViewNow()
        },
        [],
      )

      React.useLayoutEffect(() => {
        const el = listRef.current
        if (!el) return
        const a = anchorRef.current
        /**
         * 换书了：扔掉上一本的锚点，换成这本的恢复目标。
         *
         * 这是「每次新开停在中间某格」的根因：`anchorRef` 与组件同寿命，切 tab 时
         * 沿用了上一本的 `a.top`（绝对像素），新书内容够长就恰好落在中间某一格。
         */
        if (viewKeyRef.current !== viewKey) {
          // 先把**上一本**的位置落盘（此时 DOM 还是上一本的滚动状态）
          if (viewSaveTimerRef.current) {
            clearTimeout(viewSaveTimerRef.current)
            viewSaveTimerRef.current = 0
            saveViewNow()
          }
          viewKeyRef.current = viewKey
          pendingViewRef.current = viewKey ? loadViewState(viewKey) : null
          a.pinned = false
          a.top = 0
          a.height = el.scrollHeight
        }
        const pending = pendingViewRef.current
        if (pending) {
          const max = Math.max(0, el.scrollHeight - el.clientHeight)
          let top = Math.min(Math.max(0, Number(pending.top) || 0), max)
          const cellId = String(pending.cellId || "")
          if (cellId) {
            const node = el.querySelector(`[data-cell-id="${cellId}"]`)
            if (node) {
              const base = el.getBoundingClientRect().top - el.scrollTop
              const r = node.getBoundingClientRect()
              top = Math.min(Math.max(0, r.top - base - 6), max)
            }
          }
          el.scrollTop = top
          a.top = el.scrollTop
          a.height = el.scrollHeight
          a.pinned = a.top + el.clientHeight >= el.scrollHeight - 12
          // 有内容 = 恢复完成；空 notebook 留着 pending 也没东西可滚
          if (state.cells.length > 0) pendingViewRef.current = null
          return
        }
        if (a.pinned) {
          el.scrollTop = el.scrollHeight
        } else {
          el.scrollTop = a.top
        }
        a.top = el.scrollTop
        a.height = el.scrollHeight
      })

      // ── 选区浮动条（Phase 1 核心）──
      // null = 不显示；否则 { cellId, kind, text, startLine, endLine, x, y }
      const [selPop, setSelPop] = React.useState(null)
      const closeSelPop = React.useCallback(() => setSelPop(null), [])
      /**
       * ── 单元格右键菜单（R6）──
       *
       * null = 不显示；否则 `{ cellId, x, y }`（视口坐标，fixed 定位）。
       * 动作清单按 Jupyter 的右键菜单排布，并在每一项上标出等价快捷键 ——
       * 菜单本身也是「快捷键发现性」的入口。
       */
      const [ctxMenu, setCtxMenu] = React.useState(null)
      /**
       * `onScroll`（定义在上面，早于这两个 state）需要在滚动时收菜单，所以走 ref 读取 ——
       * 直接闭包捕获会拿到首次渲染的 null，菜单永远收不掉。
       */
      const ctxMenuRef = React.useRef(null)
      ctxMenuRef.current = ctxMenu
      const closeCtxMenuRef = React.useRef(() => {})
      const closeCtxMenu = React.useCallback(() => setCtxMenu(null), [])
      closeCtxMenuRef.current = closeCtxMenu
      const openCellMenu = React.useCallback((cell, x, y) => {
        if (!cell) return
        // 菜单不能被挤出视口右下角（估算 200x300）
        const vp = typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight } : { w: 1200, h: 800 }
        setCtxMenu({
          cellId: cell.id,
          x: Math.min(Math.max(8, x), Math.max(8, vp.w - 210)),
          y: Math.min(Math.max(8, y), Math.max(8, vp.h - 320)),
        })
      }, [])

      /** 移动一格到指定下标（右键菜单用；CellView 里的 ↑↓ 按钮仍走自己的实现）。 */
      const moveCellTo = React.useCallback(
        async (cellId, toIndex) => {
          try {
            await post("cell/move", { sid, cellId, toIndex })
            await refetch()
          } catch (err) {
            setNotice(String((err && err.message) || err))
          }
        },
        [sid, refetch, setNotice],
      )

      /**
       * 与下一格合并（Jupyter `Shift-M`）。
       *
       * 必须走宿主 `cell/merge`：客户端「先追加源码、再删下一格」两步不原子，
       * 中间失败会**静默丢掉**下一格的内容 —— 那是最糟的一种数据损坏。
       */
      const mergeBelow = React.useCallback(
        async (cell) => {
          if (!cell) return
          try {
            const out = await post("cell/merge", { sid, cellId: cell.id })
            await refetch()
            const id = out && out.cell ? out.cell.id : cell.id
            selectCellCommand(id)
            setNotice("已与下一格合并")
          } catch (err) {
            setNotice(String((err && err.message) || err))
          }
        },
        [sid, refetch, selectCellCommand, setNotice],
      )

      /**
       * `citeCell` 定义在本块**之后**（它要用 collectError，而 collectError 又依赖 state）。
       * 直接放进依赖数组会在首次渲染就 TDZ 崩（`Cannot access 'citeCell'
       * before initialization` —— 冒烟测试抓到的）。所以走 ref 延迟引用。
       */
      const citeCellRef = React.useRef(null)

      /**
       * 右键菜单 = 一串**命令 id**：label / hint 从 `COMMANDS` 取，执行从 `commandsRef` 取。
       *
       * 菜单不再自己写闭包 —— 否则「菜单能点、快捷键没接」（或反过来）这种漂移迟早发生。
       * 这也让「菜单上的快捷键提示」永远等于真实绑定。
       */
      const ctxActions = React.useMemo(() => {
        if (!ctxMenu) return []
        const idx = cells.findIndex((c) => c.id === ctxMenu.cellId)
        const cell = idx >= 0 ? cells[idx] : null
        if (!cell) return []
        const cellType = normalizeCellType(cell.cellType)
        const item = (command, opts) => {
          const meta = COMMANDS[command] || {}
          const o = opts || {}
          return {
            command,
            label: o.label || meta.label || command,
            hint: o.hint != null ? o.hint : meta.hint || "",
            disabled: !!o.disabled,
            onClick: () => {
              const run = commandsRef.current[command]
              if (typeof run === "function") run(cell)
            },
          }
        }
        return [
          item("cell.insertAbove", { label: "在上方插入代码" }),
          item("cell.insertBelow", { label: "在下方插入代码" }),
          { separator: true },
          item("cell.moveUp", { disabled: idx <= 0 }),
          item("cell.moveDown", { disabled: idx >= cells.length - 1 }),
          { separator: true },
          item("cell.toCode", { disabled: cellType === "code" }),
          item("cell.toMarkdown", { disabled: cellType === "markdown" }),
          item("cell.toRaw", { disabled: cellType === "raw" }),
          { separator: true },
          item("cell.clearOutputs"),
          item("cell.copySource"),
          { separator: true },
          item("cell.cite", { label: "💬 添加到对话" }),
          item("cell.aiRewrite", { label: "✨ AI 改写本格" }),
          item("cell.promptRewrite", { label: "💬 让对话改本格" }),
          { separator: true },
          item("cell.delete"),
        ]
      }, [ctxMenu, cells])

      /**
       * 选区 / 输出选区发生变化时的统一入口（由 CellView 转发上来）。
       * 只有「真的选中了非空文本」才弹；否则一律收掉（否则点一下也会弹按钮）。
       */
      const onSelectionChange = React.useCallback(
        (cellId, sel, coords, meta) => {
          const kind = (meta && meta.kind) || "code"
          if (!sel || !String(sel.text || "").trim()) {
            setSelPop((prev) => (prev && prev.cellId === cellId ? null : prev))
            return
          }
          const vp = typeof window !== "undefined" ? { width: window.innerWidth, height: window.innerHeight } : null
          const anchor = placeSelectionBar(coords, vp, { width: 250, height: 32 })
          if (!anchor) {
            setSelPop(null)
            return
          }
          setSelPop({
            cellId,
            kind,
            text: sel.text,
            startLine: sel.startLine,
            endLine: sel.endLine,
            x: anchor.x,
            y: anchor.y,
          })
        },
        [],
      )

      /** 选区浮动条上的动作（按落点不同给出不同动作）。 */
      const selActions = React.useMemo(() => {
        if (!selPop) return []
        const cell = cells.find((c) => c.id === selPop.cellId)
        if (!cell) return []
        const isCode = selPop.kind === "code"
        const lineInfo = selPop.startLine >= 0 ? { startLine: selPop.startLine, endLine: selPop.endLine, text: selPop.text } : null
        const actions = []
        if (isCode) {
          actions.push({
            label: "✨ AI 修改",
            title: "只改选中的这几行（Mod-K）",
            onClick: () => {
              closeSelPop()
              runAi(cell.id, cell.source, "", { mode: "rewrite-selection", selection: lineInfo })
            },
          })
          actions.push({
            label: "🔍 解释",
            title: "解释选中的代码",
            onClick: () => {
              closeSelPop()
              runAi(cell.id, cell.source, "Explain the selected code briefly.", { mode: "explain", selection: lineInfo })
            },
          })
          /**
           * 选区级「交给对话」：整块选区 + 绝对位置（第几格、第几行）都会写进提示词，
           * 所以主 agent 不需要用户再复述一遍「是哪个 notebook 的哪几行」。
           */
          actions.push({
            label: "💬 在对话里改",
            title: "把选中的这几行 + 位置写成提示词投进主对话，交给有完整项目上下文的 agent 改",
            onClick: () => {
              closeSelPop()
              toChat(cell.id, { mode: "rewrite-selection", selection: lineInfo })
            },
          })
        }
        actions.push({
          label: "💬 添加到对话",
          title: "把选区作为结构化引用插进左侧主对话（带 cell 序号与行范围）",
          onClick: () => {
            const cellIndex = cells.findIndex((c) => c.id === cell.id) + 1
            const label = lineInfo
              ? `Cell [${cellIndex}]:L${lineInfo.startLine + 1}-L${lineInfo.endLine + 1}`
              : `Cell [${cellIndex}] ${selPop.kind === "output" ? "output" : ""}`
            cite(
              `\`\`\`${languageOfCell(cell)} title="${(state.title || "notebook.ipynb") + "#" + label}"\n${selPop.text}\n\`\`\``,
              {
                path: state.path,
                cellIndex,
                // 结构化定位用 1-based 行号（与 gutter 一致）；没选到行就只给 cell
                startLine: lineInfo ? lineInfo.startLine + 1 : undefined,
                endLine: lineInfo ? lineInfo.endLine + 1 : undefined,
                kind: selPop.kind,
              },
            )
            closeSelPop()
          },
        })
        return actions
      }, [selPop, cells, state.title, state.path, runAi, cite, closeSelPop, toChat])

      // 面板滚动 / 切换格 → 收掉浮层（否则会留下飘在原地的幽灵按钮）
      React.useEffect(() => {
        if (!selPop) return undefined
        const onScroll = () => setSelPop(null)
        /**
         * ⚠️ `scroll` 事件**不冒泡**，所以在 window 上挂 capture 也收不到「元素自己滚」。
         * 单元格列表是内部滚动容器（listRef），必须直接挂它的 onScroll —— 见 listRef 那处。
         * 这里保留 window 监听是为了兜住「整页/外层容器滚动」的情形。
         */
        window.addEventListener("scroll", onScroll, true)
        return () => window.removeEventListener("scroll", onScroll, true)
      }, [selPop])

      // ── Agent 改格联动：闪烁 + 自动滚动 ──
      const [flashCell, setFlashCell] = React.useState(null)

      /**
       * Agent 改了某一格 → 等 refetch 把新内容挂上来，再滚过去并闪一下。
       *
       * 为什么要等：`nb.updated` 发出时前端 state 还是旧的；立刻 scrollIntoView 可能
       * 定位到已经被删/移动的节点，表现为「滚到空白」。这里用 requestAnimationFrame
       * 让 React 先把新 state 渲染出来。
       */
      React.useEffect(() => {
        if (!agentFrame || !agentFrame.cellId) return undefined
        let raf = 0
        let timer = 0
        raf = requestAnimationFrame(() => {
          const el = listRef.current && listRef.current.querySelector(`[data-cell-id="${agentFrame.cellId}"]`)
          if (!el) return
          try {
            if (el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" })
          } catch {
            /* ignore */
          }
          setFlashCell(agentFrame.cellId)
          setSelected(agentFrame.cellId)
          timer = setTimeout(() => setFlashCell(null), 1300)
        })
        return () => {
          if (raf) cancelAnimationFrame(raf)
          if (timer) clearTimeout(timer)
        }
      }, [agentFrame])

      /**
       * 把一格（源码 + 最近报错摘要）投递到主对话。
       *
       * 投递形态交给 `cite()` 决定：优先文件芯片（label 带 `#Cell[n]`），
       * 芯片不可用时退化成同款 markdown 围栏纯文本。
       */
      const citeCell = React.useCallback(
        (cell) => {
          const idx = cells.findIndex((c) => c.id === cell.id) + 1
          const lang = languageOfCell(cell)
          const parts = [`\`\`\`${lang} title="${(state.title || "notebook.ipynb") + "#Cell[" + idx + "]"}"`, String(cell.source || ""), "```"]
          const err = collectError(cell.id)
          if (err) parts.push(`最近一次报错（Cell [${idx}]）：${err.ename}: ${err.evalue}`, "```\n" + err.traceback + "\n```")
          cite(parts.join("\n"), { path: state.path, cellIndex: idx })
        },
        [cells, state.title, state.path, cite, collectError],
      )
      // 右键菜单里的「添加到对话」通过 ref 调用（见上面 citeCellRef 的注释）
      citeCellRef.current = citeCell

      const citeError = React.useCallback(
        (cell, errBlock) => {
          const idx = cells.findIndex((c) => c.id === cell.id) + 1
          const tb = ((errBlock && errBlock.traceback) || []).join("\n")
          cite(
            [
              `Notebook 单元格 Cell [${idx}] 报错了，帮我定位并修复（改完请直接改这个 cell 再跑一次）：`,
              "```" + languageOfCell(cell) + ` title="${(state.title || "notebook.ipynb") + "#Cell[" + idx + "]"}"`,
              String(cell.source || ""),
              "```",
              "完整 Traceback：",
              "```\n" + tb + "\n```",
            ].join("\n"),
            { path: state.path, cellIndex: idx, kind: "error" },
          )
        },
        [cells, state.title, state.path, cite],
      )


      /**
       * 大纲点击 → 跳转（P0 5.3：早先只 `setSelected` + 滚动，**不聚焦**，点完还得再点一下）。
       *
       * 口径：
       *  · heading：只滚到该格顶部（标题在格内某一行，滚到格顶就够；不抢焦点，
       *    否则用户在看大纲定位时焦点被扔进编辑器）；
       *  · symbol / cell：滚过去 **并聚焦该格编辑器**（要能立刻改代码）。
       */
      const jumpToNode = React.useCallback(
        (node) => {
          if (!node || !node.cellId) return
          setSelected(node.cellId)
          const el = listRef.current && listRef.current.querySelector(`[data-cell-id="${node.cellId}"]`)
          if (el && el.scrollIntoView) {
            try {
              el.scrollIntoView({ block: "start", behavior: "smooth" })
            } catch {
              /* ignore */
            }
          }
          if (node.kind !== "heading") focusCell(node.cellId)
        },
        [focusCell],
      )

      const dot =
        state.kernelState === "idle"
          ? "#3fa23a"
          : state.kernelState === "busy"
            ? RUNNING_COLOR
            : state.kernelState === "dead"
              ? "#f14c4c"
              : "#9ca3af"
      /**
       * 运行状态条（工具栏第三行最左）。
       *
       * 用户 2026-11-10：「代码运行的时候我不知道有没有运行，这个应该有个状态显示」。
       * 所以这里必须同时回答三个问题：**在不在跑**（有没有）、**跑的是哪一格**（哪一格）、
       * **跑了多久**（多久）。内核那个小圆点只说明内核 idle/busy，用户看不懂也不想懂。
       */
      const runningCell = state.running ? (state.cells || []).find((c) => c.id === state.running) : null
      const runningIdx = runningCell ? (state.cells || []).findIndex((c) => c.id === runningCell.id) + 1 : 0
      const runningMs = runningCell && runningCell.startedAt ? Math.max(0, (statusTick || Date.now()) - runningCell.startedAt) : 0
      const queueCount = (state.queue || []).length
      const runStatusText = runningCell
        ? `运行中 · 第 ${runningIdx} 格 · ${formatElapsed(runningMs)}${queueCount ? ` · 队列 ${queueCount}` : ""}`
        : queueCount
          ? `排队中 · ${queueCount} 格`
          : "空闲"
      const runStatusColor = runningCell || queueCount ? RUNNING_COLOR : "color-mix(in srgb, currentColor 55%, transparent)"
      const connDot = conn === "open" ? "#3fa23a" : conn === "connecting" ? "#9ca3af" : "#f14c4c"

      /**
       * 内核提示（用户 2026-11-11：「没选择内核的时候应该先提示选择内核，或者给个默认的」）。
       *
       * 规则：
       *  · 显式选过（`kernels.current`）→ 什么都不额外说，下拉显示「（当前）」；
       *  · 没选但有默认（envsel / conda 里第一个装了 ipykernel 的）→ 直接报出默认是谁，
       *    用户不必先点下拉就能跑；状态条上写「默认 xxx」；
       *  · 连默认都没有（回落到 PATH 上的 python，带 warning）→ 显红色「⚠ 选内核」，
       *    title 里带 warning 原文，点一下把焦点送到下拉。
       */
      const kernelDefault = (() => {
        const r = kernels.resolved
        if (!r) return ""
        const display = String(r.display || "").trim()
        if (display) return display.split("  ·  ")[0] || display
        return String(r.python || "").split(/[\\/]/).filter(Boolean).pop() || String(r.python || "")
      })()
      const kernelWarning = !kernels.current && kernels.resolved ? String(kernels.resolved.warning || "") : ""
      /**
       * 只有在宿主**明确报出**「没有可用默认内核」时才报警。
       * 旧宿主没有 `resolved` 字段（还没重启应用）时不误报 —— 那种情况下前端什么都不知道。
       */
      const kernelNeedsChoice =
        !kernels.current && !!kernels.resolved && (!kernelDefault || kernels.resolved.source === "path")

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            height: "100%",
            minHeight: 0,
            fontFamily: FONT_UI,
            fontSize: 12.5,
            color: "var(--dsw-alias-label-primary,#e8eaed)",
            background: "var(--dsw-alias-bg-layer-1,transparent)",
            // picker 浮层用 absolute 定位在面板内
            position: "relative",
          },
          // ::selection 的统一作用域（见 ensureGlobalCss）
          className: "nb2-root",
          /**
           * 面板根节点 ref：给「点击外部关闭 picker」与「Enter 组合 document 级兜底」
           * 判定事件落点用。
           */
          ref: panelRootRef,
          /**
           * 面板级 Enter 组合分发（capture 阶段）。
           * 补的是「焦点在面板空白/标签条/格容器/工具条按钮上时没有任何处理器」这个洞。
           */
          onKeyDownCapture: onPanelKeyDownCapture,
        },
        /* 工具栏（两行，全部**带文字标签**）。
         * 之前只有一排无标签小图标，用户实测「看不到内核操作按钮」——一句话：
         * 图标必须配字，且内核状态/选择/工作目录要能一眼看到（对齐旧插件那条工具条）。 */
        h(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: "5px 8px 4px",
              borderBottom: "1px solid var(--dsw-alias-border-l2,#333)",
              flex: "none",
            },
          },
          // 行 1：标题 + 未保存 + 保存/另存为
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
            h("span", { title: `sse=${conn}`, style: { width: 7, height: 7, borderRadius: "50%", background: connDot, flex: "none" } }),
            h("b", { style: { fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, state.title || "Untitled"),
            state.tabs && state.tabs.some((t) => t.dirty) ? h("span", { style: { fontSize: 10, color: "#cca700", flex: "none" } }, "未保存 ●") : null,
            h("span", { style: { flex: 1 } }),
            h("button", { type: "button", style: toolbarBtn, title: "保存 (Mod-S)", onClick: save }, "保存"),
            h("button", { type: "button", style: toolbarBtn, title: "另存为新的 .ipynb", onClick: saveAs }, "另存为"),
          ),
          /**
           * 行 2：11 个按钮收成 **3 组 + ⋯ 溢出**（P1 5.2）。
           *
           * 之前平铺 11 个，`＋代码/＋MD/＋SH` 和分隔线按钮语义重复、挤到换行还认不出分组。
           * 现在：① 运行  ② 单元格  ③ 视图/文件  +  `⋯`（低频操作：重启并清空 / 清空输出 / 删除）。
           * 「保存 / 另存为」留在行 1（那是文件级动作，不属于任何一组）。
           */
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" } },
            // 组 1：运行
            h("button", { type: "button", style: { ...toolbarBtn, fontWeight: 600 }, title: "运行全部单元格", onClick: runAll, disabled: busy === "all" }, busy === "all" ? "运行中…" : "▶ 运行全部"),
            h("button", { type: "button", style: toolbarBtn, title: "中断内核", onClick: () => kernelAction("kernel/interrupt") }, "■ 中断"),
            h("button", { type: "button", style: toolbarBtn, title: "重启内核（保留输出）", onClick: () => kernelAction("kernel/restart", { clear: false }) }, "↻ 重启"),
            h("span", { style: toolbarGroupSep }),
            // 组 2：单元格
            h("button", { type: "button", style: toolbarBtn, title: "在末尾新增一个代码单元格", onClick: () => addCell(cells.length ? cells[cells.length - 1].id : null, false, "code") }, "＋ 代码"),
            h("button", { type: "button", style: toolbarBtn, title: "在末尾新增一个 Markdown 单元格", onClick: () => addCell(cells.length ? cells[cells.length - 1].id : null, false, "markdown") }, "＋ MD"),
            h("button", { type: "button", style: toolbarBtn, title: "在末尾新增一个 Shell 单元格（cmd / bash）", onClick: () => addCell(cells.length ? cells[cells.length - 1].id : null, false, "bash") }, "＋ SH"),
            h("span", { style: toolbarGroupSep }),
            // 组 3：视图 / 文件
            h(
              "button",
              {
                type: "button",
                style: { ...toolbarBtn, background: outlineDock !== "off" ? accentMix(20) : undefined },
                title:
                  "大纲（markdown 标题 + Python 函数/类）：停靠位置 关 → 左 → 右 循环；可折叠/过滤，点击跳转并聚焦",
                onClick: cycleOutlineDock,
              },
              outlineDock === "left" ? "≡ 大纲 ◧" : outlineDock === "right" ? "≡ 大纲 ◨" : "≡ 大纲",
            ),
            h("button", { type: "button", style: { ...toolbarBtn, background: aiComplete ? accentMix(20) : undefined }, title: "AI 内联补全（ghost text）：停止输入 0.5s 后请求续写，Tab 接受 / Esc 丢弃。会消耗 token。", onClick: () => setAiComplete((v) => !v) }, aiComplete ? "AI 补全 ●" : "AI 补全"),
            // 组 3 尾：⋯ 溢出（低频动作）
            h(
              "div",
              { style: { position: "relative", flex: "none" } },
              h(
                "button",
                {
                  type: "button",
                  style: { ...toolbarBtn, background: moreOpen ? accentMix(20) : undefined },
                  title: "更多操作",
                  onClick: () => setMoreOpen((v) => !v),
                },
                "⋯",
              ),
              moreOpen
                ? h(
                    "div",
                    {
                      style: {
                        position: "absolute",
                        right: 0,
                        top: "100%",
                        marginTop: 3,
                        zIndex: 30,
                        minWidth: 132,
                        display: "flex",
                        flexDirection: "column",
                        gap: 1,
                        padding: 4,
                        borderRadius: 6,
                        border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
                        background: "var(--dsw-alias-bg-layer-2,#1e1e1e)",
                        boxShadow: "0 8px 24px rgba(0,0,0,.32)",
                      },
                    },
                    h("button", { type: "button", style: { ...menuItem, border: 0 }, title: "重启内核并清空所有输出", onClick: () => { setMoreOpen(false); kernelAction("kernel/restart", { clear: true }) } }, "↻ 重启并清空"),
                    h("button", { type: "button", style: { ...menuItem, border: 0 }, title: "清空所有输出（不重启）", onClick: () => { setMoreOpen(false); clearOutputs() } }, "清空输出"),
                    h(
                      "button",
                      {
                        type: "button",
                        style: { ...menuItem, border: 0 },
                        title: "删除当前选中的单元格",
                        disabled: !selected,
                        onClick: () => {
                          setMoreOpen(false)
                          if (!selected) return
                          post("cell/delete", { sid, cellId: selected })
                            .then(() => {
                              setSelected(null)
                              refetch()
                            })
                            .catch((err) => setNotice(String(err.message || err)))
                        },
                      },
                      "✕ 删除选中格",
                    ),
                  )
                : null,
            ),
          ),
          // 行 3：运行状态 + 内核状态 + 内核选择 + 工作目录
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 11 } },
            // ① 运行状态（用户第一眼要看的）：在不在跑 / 第几格 / 跑了多久 / 后面还排了几个
            h(
              "span",
              {
                title: runningCell
                  ? `正在执行第 ${runningIdx} 格，已跑 ${formatElapsed(runningMs)}\n左槽的 ◐ 会一直转，跑完变成 ✓ / ✗`
                  : queueCount
                    ? `还有 ${queueCount} 格在队列里等内核`
                    : "当前没有单元格在运行",
                style: {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  flex: "none",
                  fontWeight: 600,
                  color: runStatusColor,
                },
                className: runningCell ? "nb2-running-pill" : undefined,
              },
              h("span", { className: runningCell ? "nb2-spin" : undefined, style: { fontSize: 11 } }, runningCell ? "◐" : queueCount ? "⏳" : "○"),
              h("span", null, runStatusText),
            ),
            h("span", { style: toolbarGroupSep }),
            h(
              "span",
              { title: `内核状态：${state.kernelState}`, style: { display: "inline-flex", alignItems: "center", gap: 4, flex: "none" } },
              h("span", { style: { width: 8, height: 8, borderRadius: "50%", background: dot, flex: "none" } }),
              /**
               * P1 5.8：`unknown` 对用户毫无信息量。内核是**懒启动**的 —— 第一次运行
               * 才会拉起进程，所以这里要说清「还没启动」和「该怎么启动」。
               */
              h(
                "span",
                { style: { opacity: 0.85 } },
                state.kernelState === "unknown"
                  ? kernels.current
                    ? "内核未启动（点运行即启动）"
                    : kernelDefault
                      ? `内核未启动 · 默认 ${kernelDefault}`
                      : "内核未启动（还没选内核）"
                  : `内核 ${state.kernelState}`,
              ),
            ),
            kernelWarning || kernelNeedsChoice
              ? h(
                  "button",
                  {
                    type: "button",
                    title: `${kernelWarning || "没有探测到装了 ipykernel 的环境"}\n点这里选择一个装了 ipykernel 的内核（会重启内核）`,
                    onClick: () => {
                      const el = kernelSelectRef.current
                      if (el && typeof el.focus === "function") el.focus()
                    },
                    style: { ...miniBtn, color: "#f14c4c", fontWeight: 600 },
                  },
                  "⚠ 选内核",
                )
              : null,
            h(
              "select",
              {
                ref: kernelSelectRef,
                title: kernels.current
                  ? "当前内核（换一个会重启内核）"
                  : kernelDefault
                    ? `没显式选择时用默认内核：${kernelDefault}（换一个会重启内核）`
                    : "选择 conda 环境作为内核（会重启内核）",
                value: kernels.current || "",
                onChange: (e) => selectKernel(e.target.value),
                style: kernelSelectStyle,
              },
              h(
                "option",
                { value: "" },
                kernels.current ? "（当前）" : kernelDefault ? `默认：${kernelDefault}` : "选择内核…",
              ),
              (kernels.kernels || []).map((k) =>
                h("option", { key: k.id, value: k.id, disabled: !k.hasIpykernel }, `${k.name}${k.hasIpykernel ? "" : "（缺 ipykernel）"}`),
              ),
            ),
            h(
              "button",
              {
                type: "button",
                style: { ...toolbarBtn, fontSize: 10.5, padding: "1px 6px" },
                title: `${kernels.cwd || state.cwd || ""}（点击修改，会重启内核）`,
                onClick: changeCwd,
              },
              `📁 ${shortPath(kernels.cwd || state.cwd)}`,
            ),
          ),
        ),

        // 多 notebook 标签条（M5）。同一会话可以并排开多个 .ipynb，切换即切换活动 notebook。
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 6px",
              borderBottom: "1px solid var(--dsw-alias-border-l2,#333)",
              flex: "none",
              overflowX: "auto",
              fontSize: 11,
            },
          },
          (state.tabs || []).map((tab) =>
            h(
              "span",
              {
                key: tab.key,
                title: tab.path || tab.title,
                onClick: () => {
                  // 切走前先把这本书的阅读位置落盘（节流计时器可能还没到）
                  if (viewSaveTimerRef.current) {
                    clearTimeout(viewSaveTimerRef.current)
                    viewSaveTimerRef.current = 0
                  }
                  saveViewNow()
                  post("notebook/activate", { sid, key: tab.key }).then(refetch).catch(() => {})
                },
                style: {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 6px",
                  borderRadius: 4,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  background: tab.active ? accentMix(18) : "transparent",
                  border: `1px solid ${tab.active ? accentMix(45) : "transparent"}`,
                },
              },
              h("span", null, `${tab.dirty ? "● " : ""}${tab.title}`),
              h(
                "button",
                {
                  type: "button",
                  title: "关闭",
                  onClick: (e) => {
                    e.stopPropagation()
                    post("notebook/close", { sid, key: tab.key }).then(refetch).catch(() => {})
                  },
                  style: { ...miniBtn, padding: "0 2px", opacity: 0.6 },
                },
                "✕",
              ),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              title: "打开 .ipynb：先看当前工作目录里的 notebook 列表",
              // ⚠️ 不能用 window.prompt：Electron 里它被禁用，调用直接抛
              // "prompt() is and will not be supported." → 按钮表现为「点了没反应」。
              // 现在主入口是面板内 picker（列表 + ↑↓ Enter），手输路径降级为兜底。
              /**
               * `data-nb2-picker-anchor`：让「点击浮层外部关闭」的监听器**放过这个按钮**。
               * 否则 mousedown 先关掉、click 又打开 → 表现为「点一下闪一下就回来」。
               * 这里同时把它做成**开关**（再点一次收起），符合浮层按钮的直觉。
               */
              "data-nb2-picker-anchor": "1",
              onClick: () => {
                setPathHint("open")
                setOpenPath(null)
                setPickerOpen((prev) => !prev)
              },
              style: { ...miniBtn, opacity: 0.8 },
            },
            "＋打开",
          ),
          h(
            "button",
            {
              type: "button",
              title: "新建空 notebook",
              onClick: () => {
                // 不要 `.catch(() => {})` 吞错：失败必须让用户看见
                post("notebook/new", { sid })
                  .then((out) => {
                    setNotice(`已新建 ${(out && out.title) || "Untitled.ipynb"}`)
                    return refetch()
                  })
                  .catch((err) => setNotice(`新建失败：${String((err && err.message) || err)}`))
              },
              style: { ...miniBtn, opacity: 0.8 },
            },
            "＋新建",
          ),
        ),

        // 路径输入行（替代 window.prompt）：打开 / 另存为共用
        openPath === null
          ? null
          : h(
              "div",
              { style: { display: "flex", gap: 4, alignItems: "center", padding: "4px 8px", flex: "none", borderBottom: "1px solid var(--dsw-alias-border-l2,#333)" } },
              h(
                "span",
                { style: { fontSize: 10.5, opacity: 0.75, flex: "none" } },
                pathHint === "saveAs" ? "另存为" : pathHint === "cwd" ? "工作目录" : "打开",
              ),
              h("input", {
                autoFocus: true,
                value: openPath,
                placeholder: pathHint === "cwd" ? "C:\\path\\to\\working\\dir" : "C:\\path\\to\\notebook.ipynb",
                onChange: (e) => setOpenPath(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") submitPath(openPath)
                  if (e.key === "Escape") setOpenPath(null)
                },
                style: {
                  flex: 1,
                  minWidth: 0,
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 3,
                  border: "1px solid var(--dsw-alias-border-l2,#3a3a3a)",
                  background: "var(--dsw-alias-bg-layer-2,transparent)",
                  color: "inherit",
                },
              }),
              h("button", { type: "button", style: { ...toolbarBtn, fontSize: 10.5, padding: "1px 6px" }, onClick: () => submitPath(openPath) }, "确定"),
              h("button", { type: "button", style: { ...miniBtn, opacity: 0.9 }, onClick: () => setOpenPath(null) }, "✕"),
            ),

        /**
         * 打开 notebook 的面板内浮层（数据源 /nb2/fs/list）。
         * 它是**主入口**；手输绝对路径只是兜底（picker 底部的「手输绝对路径…」会把
         * 下面那一行输入框打开）。
         */
        pickerOpen
          ? h(NotebookPicker, {
              sid,
              onClose: () => setPickerOpen(false),
              onOpen: openFromPicker,
              onManual: () => {
                setPickerOpen(false)
                setPathHint("open")
                setOpenPath(state.path || "")
              },
              // 空态「＋ 新建 notebook」成功后：收掉 picker + 刷新面板
              onCreated: (out) => {
                setPickerOpen(false)
                setNotice(`已新建 ${(out && out.title) || "Untitled.ipynb"}`)
                refetch()
              },
            })
          : null,


        notice
          ? h(
              "div",
              { style: { padding: "3px 8px", color: "#ffb020", flex: "none", display: "flex", gap: 8, alignItems: "center" } },
              h("span", { style: { flex: 1 } }, notice),
              h("button", { type: "button", style: { ...miniBtn, opacity: 1 }, onClick: () => setNotice("") }, "✕"),
            )
          : null,

        // ── 主体：大纲停靠（左/右，可切换）+ 单元格列表 ──
        h(
          "div",
          { style: { display: "flex", flex: 1, minHeight: 0, flexDirection: "row" } },
          outlineDock === "left"
            ? h(OutlineDockPanel, {
                tree: outline,
                selectedCellId: selected,
                onJump: jumpToNode,
                side: "left",
                onClose: cycleOutlineDock,
              })
            : null,
        // cell 列表
        h(
          "div",
          {
            ref: listRef,
            onScroll: () => {
              onScroll()
              // 列表一滚，选区浮层的固定坐标就失效了：立刻收掉（否则按钮浮在错误的行上）
              if (selPop) setSelPop(null)
            },
            style: { flex: 1, minHeight: 0, overflow: "auto", padding: "6px 0 40px" },
          },
          cells.length === 0
            ? h(
                "div",
                { style: { padding: "18px 14px", opacity: 0.82 } },
                h("div", { style: { marginBottom: 10 } }, "还没有 notebook。"),
                // P0 5.4：空态给两个大按钮（之前只有一个「新建一格」，还得自己选类型）
                h(
                  "div",
                  { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                  h(
                    "button",
                    {
                      type: "button",
                      style: emptyBtn,
                      title: "新建一个 Python 代码单元格",
                      onClick: () => addCell(null, false, "code"),
                    },
                    "＋ 代码单元格",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: emptyBtn,
                      title: "新建一个 Markdown 单元格",
                      onClick: () => addCell(null, false, "markdown"),
                    },
                    "＋ Markdown 单元格",
                  ),
                ),
              )
            : h(
                "div",
                null,
                cells.map((cell, i) => {
                  /**
                   * 被折叠的格**整格不渲染**（不是 display:none）。
                   *
                   * 折起来的目的就是「不看它」：省掉的正是大图/长日志/大表这些最贵的渲染。
                   * 留个 display:none 的节点，React 照样要构造整棵子树、照样要解码图片。
                   */
                  if (fold.hidden.has(cell.id)) return null
                  const section = fold.sectionOf.get(cell.id) || null
                  const collapsedHere = !!(section && foldedSections.has(cell.id))
                  // 插格热区贴着「上一个**看得见**的格」：否则插进去的格会落进折叠区里，看不见
                  const anchor = prevVisibleId.get(cell.id) || null
                  return h(
                    React.Fragment,
                    { key: cell.id },
                    /**
                     * 格间新增热区（第 4 条反馈）：每格**之前**一个，列表末尾再来一个。
                     * 这样「两格之间」和「最后一格之后」都有入口，不必先建到末尾再点上移。
                     * 第一格之前的那个用 `index:0` 往最前面插（宿主的 after:null 是追加到末尾）。
                     */
                    h(CellDivider, {
                      position: anchor ? "before" : "start",
                      onAdd: (type) => addCell(anchor, false, type, anchor ? undefined : { index: 0 }),
                    }),
                    h(CellView, {
                      key: cell.id,
                      cell,
                      index: i,
                      total: cells.length,
                      CM,
                      // 相对图片要拼 /nb2/file?sid=&path=，所以 sid 必须传到渲染层
                      sid,
                      // 多选：锚点 + extraSelected 都算「选中」，视觉高亮走同一个 boolean
                      selected: isCellSelected(cell.id),
                      onSelect: setSelected,
                      ai: ai.open && ai.cellId === cell.id ? ai : null,
                      aiHandlers,
                      ghost,
                      // Agent 改格后的定位闪烁
                      flash: flashCell === cell.id,
                      // 引到主对话（整格 / 报错）与选区上报（浮动条）
                      onCiteCell: citeCell,
                      onCiteSelection: (id, sel, meta) => {
                        const target = cells.find((c) => c.id === id)
                        if (!target) return
                        if (meta && meta.kind === "error") citeError(target, meta.output)
                        else onSelectionChange(id, sel, null, meta)
                      },
                      onSelectionChange,
                      // 输出复制按钮的结果提示
                      onNotice: setNotice,
                      // 右键 → 面板级上下文菜单（R6）
                      onCellContextMenu: openCellMenu,
                      // 「请聚焦这一格」请求（新增/跳转/Shift-Enter 后聚焦下一格）
                      focusReq: focusReq && focusReq.cellId === cell.id ? focusReq : null,
                      // 登记该格的编辑器 API（仅用于该格自己的选区级改写）
                      onEditorReady: (id, api) => {
                        if (api) editorRef.current = { cellId: id, api }
                        else if (editorRef.current.cellId === id) editorRef.current = { cellId: null, api: null }
                      },
                      onSelectSibling: (dir) => {
                        const next = cells[i + dir]
                        if (next) setSelected(next.id)
                      },
                      onChange: (source) => changeSource(cell.id, source),
                      onChangeType: changeType,
                      onRun: () => runCell(cell.id, cell.source),
                      /**
                       * Shift-Enter：跑本格 → 聚焦下一格；最后一格则补一格再聚焦。
                       * ⚠️ 这个回调是**编辑器内** Shift-Enter 的落点（CM keymap 绑的），
                       * 所以「跑完焦点走不走」全在这里决定 —— 早先只 setSelected 不聚焦，
                       * 才有了「Shift-Enter 没有自动运行」的真机反馈。
                       */
                      onRunBelow: () => runBelow(cell.id),
                      // 新增的格沿用当前格的类型（在 markdown 里 Alt-Enter 得到的是 markdown）
                      onRunInsert: () => addCell(cell.id, true, cell.cellType),
                      onSave: save,
                      onAddAfter: (run) => addCell(cell.id, run, cell.cellType),
                      onDelete: async () => {
                        try {
                          await post("cell/delete", { sid, cellId: cell.id })
                          await refetch()
                        } catch (err) {
                          setNotice(String((err && err.message) || err))
                        }
                      },
                      onMove: async (dir) => {
                        try {
                          await post("cell/move", { sid, cellId: cell.id, toIndex: i + dir })
                          await refetch()
                        } catch (err) {
                          setNotice(String((err && err.message) || err))
                        }
                      },
                      // md 标题折叠：只有「标题格 + 下面真的还有格」才会显出把手
                      foldLevel: section ? section.level : 0,
                      folded: collapsedHere,
                      hiddenCount: section ? section.hiddenCount : 0,
                      onToggleFold: toggleFold,
                    }),
                    /**
                     * 折叠后的「⋯」占位（VS Code 同款）。
                     *
                     * 必须有个痕迹：整节凭空消失只会被当成 bug。占位同时是**展开按钮**，
                     * 点它不需要先找到那个 10px 的箭头。
                     */
                    collapsedHere && section
                      ? h(
                          "div",
                          {
                            className: "nb2-fold-ghost",
                            "data-nb2-fold-ghost": cell.id,
                            title: "展开本节",
                            onClick: () => toggleFold(cell.id),
                            style: {
                              margin: "2px 6px 5px 52px",
                              padding: "3px 8px",
                              border: "1px dashed var(--dsw-alias-border-l2,#3a3a3a)",
                              borderRadius: 4,
                              fontSize: 10.5,
                              opacity: 0.75,
                              cursor: "pointer",
                              userSelect: "none",
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            },
                          },
                          `⋯ 已折叠 ${section.hiddenCount} 格`,
                          h("span", { style: { opacity: 0.6 } }, "点击展开"),
                        )
                      : null,
                  )
                }),
                // 列表末尾：常显但低对比（用户明确要求「末尾也要有」）
                h(CellDivider, {
                  position: "end",
                  dim: true,
                  onAdd: (type) => addCell(cells[cells.length - 1].id, false, type),
                }),
              ),
        ),
          outlineDock === "right"
            ? h(OutlineDockPanel, {
                tree: outline,
                selectedCellId: selected,
                onJump: jumpToNode,
                side: "right",
                onClose: cycleOutlineDock,
              })
            : null,
        ),

        // 状态栏
        h(
          "div",
          {
            style: {
              flex: "none",
              borderTop: "1px solid var(--dsw-alias-border-l2,#333)",
              padding: "3px 8px",
              fontSize: 10.5,
              opacity: 0.7,
              display: "flex",
              gap: 10,
              fontFamily: FONT_MONO,
            },
          },
          h("span", null, `kernel: ${state.kernelState}`),
          h("span", null, `cells: ${cells.length}`),
          state.running ? h("span", { style: { color: "#cca700" } }, "running…") : null,
          state.queue && state.queue.length ? h("span", null, `queue: ${state.queue.length}`) : null,
          h("span", { style: { flex: 1 } }),
          h("span", null, `sel: ${selectedIndex + 1}/${cells.length}`),
          // AI 补全在途指示：消除「开了开关不知道有没有在工作」的盲盒感
          ghostBusy ? h("span", { style: { color: ACCENT } }, "AI ⋯") : null,
          /**
           * 补全失败指示（P0-6）：5s 自动消失，悬停看原因。
           * 不弹窗、不抢焦点 —— 补全失败不该打断打字，但也不该完全隐形。
           */
          !ghostBusy && ghostError
            ? h("span", { style: { color: "#ffb020", cursor: "help" }, title: `AI 补全失败：${ghostError}` }, "AI ⚠")
            : null,
          h("span", { title: "add cell" }, CM ? "cm6 ✓" : "cm6 loading…"),
        ),

        /**
         * ── AI 补全设置栏（面板最下面一条，用户要求「再加一个栏自己选」）──
         *
         * 数据全部来自宿主真实能力，不写死：
         *   模型 = 全部 provider × 模型（`/nb2/ai/models`）；
         *   强度 = **该模型自己声明的** efforts（`/nb2/ai/efforts`），不支持就禁用。
         * 用原生 `<select>` + `<optgroup>`：这是侧栏里唯一不会被宿主样式劫持、
         * 也不需要自绘键盘处理的下拉（自绘 select 在窄面板里永远差一截）。
         */
        h(
          "div",
          {
            style: {
              flex: "none",
              borderTop: "1px solid var(--dsw-alias-border-l2,#333)",
              padding: "3px 8px",
              fontSize: 10.5,
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: 0,
            },
          },
          h(
            "button",
            {
              type: "button",
              style: { ...miniBtn, opacity: 0.85, flex: "none" },
              title: "AI 补全用的模型与思考强度（按模型自己支持的档位）",
              onClick: () => {
                setAiBarOpen((v) => !v)
                if (!aiCatalog.providers.length) loadAiCatalog()
              },
            },
            aiBarOpen ? "⚙ AI 设置 ▾" : "⚙ AI 设置",
          ),
          // 收起时显示**两套**当前生效目标，避免「不知道现在用的哪个模型」
          aiBarOpen
            ? null
            : h(
                "span",
                { style: { opacity: 0.65, fontFamily: FONT_MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                `补全 ${compPref.model || "默认"}${compPref.reasoningEffort ? "·" + compPref.reasoningEffort : ""} ｜ 改写 ${aiPref.model || "默认"}${aiPref.reasoningEffort ? "·" + aiPref.reasoningEffort : ""}`,
              ),
          /**
           * 两段式设置：**补全** 与 **改写** 各自一套模型 + 思考强度。
           *
           * 用户反馈原文：「注释生成代码这部分，还有内置的 AI 改写，应该是两个设置来分别
           * 设置」——所以这里必须是两行、各自独立，不能是「一个模型 + 一个共用开关」。
           * 两行共用 AiTargetPicker，避免复制两遍后漂移成「看起来两个、实际共用」。
           */
          aiBarOpen
            ? h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 } },
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" } },
                  h("span", { style: { opacity: 0.7, flex: "none", width: 58 } }, "补全"),
                  h(AiTargetPicker, {
                    pref: compPref,
                    efforts: compEfforts,
                    catalog: aiCatalog,
                    onChange: updateCompPref,
                    placeholder: "AI 补全（注释→代码 / 续写）用的模型",
                  }),
                  h("span", { style: { opacity: 0.5, flex: "none" } }, compPref.enabled ? "已开" : "已关"),
                ),
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" } },
                  h("span", { style: { opacity: 0.7, flex: "none", width: 58 } }, "改写"),
                  h(AiTargetPicker, {
                    pref: aiPref,
                    efforts: aiEfforts,
                    catalog: aiCatalog,
                    onChange: updateAiPref,
                    placeholder: "AI 改写 / 解释 / 修错用的模型",
                  }),
                ),
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" } },
                  h("span", { style: { opacity: 0.7, flex: "none", width: 58 } }, "补全参数"),
                  h("span", { style: { opacity: 0.6, flex: "none" } }, "防抖"),
                  h("input", {
                    type: "number",
                    min: COMPLETION_DEBOUNCE_MIN,
                    max: COMPLETION_DEBOUNCE_MAX,
                    step: 50,
                    value: compDraft.debounceMs === null ? String(compPref.debounceMs) : compDraft.debounceMs,
                    onChange: commitCompNumber("debounceMs"),
                    onBlur: resetCompDraft("debounceMs"),
                    title: `停止输入多久后请求补全（${COMPLETION_DEBOUNCE_MIN}–${COMPLETION_DEBOUNCE_MAX} ms，改完立即生效）`,
                    style: numInputStyle,
                  }),
                  h("span", { style: { opacity: 0.6, flex: "none" } }, "ms · 最多"),
                  h("input", {
                    type: "number",
                    min: COMPLETION_MAX_LINES_MIN,
                    max: COMPLETION_MAX_LINES_MAX,
                    step: 1,
                    value: compDraft.maxLines === null ? String(compPref.maxLines) : compDraft.maxLines,
                    onChange: commitCompNumber("maxLines"),
                    onBlur: resetCompDraft("maxLines"),
                    title: `一条补全最多几行（${COMPLETION_MAX_LINES_MIN}–${COMPLETION_MAX_LINES_MAX}，改完立即生效）`,
                    style: numInputStyle,
                  }),
                  h("span", { style: { opacity: 0.6, flex: "none" } }, "行"),
                ),
              )
            : null,
        ),

        /**
         * 单元格右键菜单（R6）：portal 到 body，与选区浮条同一套销毁契约。
         */
        h(CellContextMenu, { menu: ctxMenu, actions: ctxActions, onDismiss: closeCtxMenu }),
        /**
         * 选区浮动工具条：portal 到 body（见 SelectionFloatingBar 注释）。
         * 放在这里是为了让它拿得到面板的 runAi / cite 闭包。
         */
        h(SelectionFloatingBar, { anchor: selPop ? { x: selPop.x, y: selPop.y } : null, actions: selActions, onDismiss: closeSelPop }),
      )
    }

    // ───────────────────────── 注册 ─────────────────────────

    module.exports = {
      name: PKG,
      inject: ["slots", "sidebarRightTabs"],
      apply(ctx) {
        /**
         * 存一份 ctx 给「对话桥」用（`getChatBridge` 要 `ctx.sessions.scope` 与
         * `ctx.get("conversation")`）。
         *
         * ⚠️ 故意**不**把 `conversation` / `sessions` 写进静态 `inject`：
         * inject 是「缺了就不 apply」的硬依赖，而对话桥只是**增强**（拿不到时
         * `cite()` 会降级成纯文本/剪贴板）。放进 inject 会让插件在无会话壳的
         * 环境（headless 冒烟、纯文档页）里整个不挂载 —— 收益远小于风险。
         * `ctx.get(name)` 本身对未注册服务返回 undefined，已在 getChatBridge 里兜住。
         */
        pluginCtx = ctx
        ctx.effect(() => {
          const disposers = []
          disposers.push(
            ctx.sidebarRightTabs.register({
              id: PKG,
              kind: KIND,
              title: () => "Notebook (v2)",
              guide: [{ order: 90, title: () => "Notebook (v2)", description: () => "流式 Jupyter 内核：运行/编辑/输出（自研）" }],
            }),
          )
          disposers.push(ctx.slots.register({ name: "sidebar.right.pane.tab", key: PKG }, NotebookV2Panel))
          return () => {
            if (pluginCtx === ctx) pluginCtx = null
            for (const dispose of disposers.reverse()) {
              try {
                if (typeof dispose === "function") dispose()
              } catch {
                /* ignore */
              }
            }
          }
        })
      },
      /** 给 headless 测试用的纯逻辑出口（shell 会忽略多余字段）。 */
      __internals: {
        // 对话投递的定位串格式化（cell 序号 + 行范围）—— 纯函数，有单测
        formatNotebookRef,
        workspaceRelativeMention,
        /** 对话投递通道（0.2.1-rc.5 实测：inputActions.captureInsertion+insertText） */
        deliverInputText,        inputActionsCaps,
        INPUT_ACTION_METHODS,
        /** 「交给对话」提示词构造 + 截断 */
        buildChatPrompt,
        clipText,
        pickMime,
        foldDecision,
        markdownLite,
        jsonTree,
        reduceEvent,
        /** 运行状态显示：耗时的人类可读格式 + 左槽字形（测试打这两个纯函数） */
        formatElapsed,
        statusGlyph,
        RUNNING_COLOR,
        renderLatex,
        buildExtensions,
        lineDiff,
        diffStat,
        stripFences,
        MIME_PRIORITY,
        normalizeCellType,
        resolveCellClick,
        shouldIgnoreContainerKey,
        // 命令注册表 + 键位表（Jupyter A/B/DD/Z/Y/M/R + Ctrl-S/Esc）；表本身也导出，
        // 好让测试断言「键位 → 命令」的完整性（加了快捷键但没接命令会立刻红）
        COMMANDS,
        KEYBINDINGS,
        bindingMatches,
        decideCommandKey,
        buildOutline,
        shouldRequestCompletion,
        /** 触发判据 v2 的打分（阈值投影前）—— 矩阵测试打在分数上 */
        completionScore,
        GHOST_SCORE_THRESHOLD,
        normalizeSuggestion,
        trimOverlap,
        /** 补全缓存的最长前缀匹配（Continue 同款）与分级接受的行切分 */
        matchGhostCache,
        splitNextLine,
        /** 跨格上下文 v2（#8）：预算填充 + markdown 意图折叠；设置项 #13：行数截断 */
        buildGhostContext,
        markdownIntent,
        truncateLines,
        GHOST_CONTEXT_CHARS,
        /** #11 增量收缩：敲出来的正是建议开头 → 幽灵原地后退 */
        shrinkGhost,
        // Phase 1–3 新增的纯逻辑（都可有测试覆盖）
        readSelection,
        readDomSelection,
        placeSelectionBar,
        languageOfCell,
        classifySelectionReply,
        validSelectionRange,
        /** 整格回包是否可安全覆盖整格（必须逐字包含选区之外的每一行非空原文） */
        fullCellCoversOutside,
        // 组件级出口：给「静态树断言」用（挡住「按钮根本没渲染」这类故障）
        CellView,
        OutputBlockView,
        HtmlOutput,
        AiBar,
        /** HTML 输出 iframe：srcdoc 构建（宿主前景色注入 + 表格基线样式）都是纯函数 */
        buildOutputHtmlDoc,
        buildOutputHtmlCss,
        readHostForeground,
        foregroundIsLight,
        OUTPUT_FALLBACK_FG,
        /** ANSI 终端色：stream / traceback 里的 \x1b[31m 要渲染成颜色，不是原样吐给用户 */
        parseAnsi,
        stripAnsi,
        ansiNodes,
        applySgr,
        xterm256,
        ANSI_BASE,
        SelectionFloatingBar,
        CELL_TYPE_LABELS,
        // ── v6 体验修复新增的纯逻辑（全部可在 Node 里直接测） ──
        /** 面板级 Enter 组合判定矩阵 → "pass"|"run-below"|"run-stay"|"run-insert-below" */
        decideCellKey,
        /** Shift-Enter 之后焦点去哪：{kind:"focus",id} | {kind:"append-and-focus",afterId} */
        nextRunTarget,
        /** 事件落点是不是输入框（Enter 组合让给它） */
        isTextEntryTarget,
        /** markdown 源码 → 已消毒 HTML（marked + DOMPurify，缺任一样退回 markdownLite） */
        renderMarkdown,
        /** React 节点 → HTML 字符串（renderMarkdown 的兜底序列化） */
        mdNodesToHtml,
        /** 相对图片改写：<img src> → /nb2/file?sid=&path= */
        rewriteImgSrc,
        /** marked + DOMPurify 都在才允许走 innerHTML */
        canUseMarkedHtml,
        canInjectHtml,
        sanitizeHtml,
        SANITIZE_CFG,
        /** md cell > 100KB 直接显示源码（短路） */
        shouldRenderRawMd,
        MD_RAW_LIMIT,
        clearMdCache,
        escapeHtml,
        estimateMdLine,
        /** 大纲 v2（md 标题 + Python 符号树）；旧 buildOutline 保留为无 CM 兜底 */
        buildOutlineV2,
        gatherHeadings,
        gatherPythonSymbols,
        outlineRows,
        outlineNodeKey,
        /** picker 辅助 */
        filterEntries,
        groupPickerEntries,
        /** picker 按键判定（修掉 list 未定义 → ↑↓/Enter 抛 ReferenceError） */
        pickerKeyAction,
        /** AI 补全设置项：localStorage 读写（异常一律降级，不炸面板） */
        loadAiPrefs,
        saveAiPrefs,
        AI_PREF_KEY,
        /** 补全设置（#13）：防抖时长 / 最大行数 + 区间夹取 */
        normalizeCompletion,
        DEFAULT_COMPLETION_DEBOUNCE_MS,
        DEFAULT_COMPLETION_MAX_LINES,
        /** 注释行判定 + 「注释下方插入」的落点计算（用户反馈第 3 条） */
        isCommentOnlyLine,
        completionInsertText,
        pickerEmptyText,
        pickerTruncatedText,
        pickerNoMatchText,
        fmtBytes,
        fmtTime,
        /** picker 路径工具（中间省略 / 工作区边界判断） */
        middleEllipsis,
        pathKey,
        isUnderPath,
        parentPath,
        /** 输出复制 */
        outputCopyText,
        copyToClipboard,
        /** md 作用域样式（测试断言 h1-h6 阶梯 / 表格 / 任务列表都在） */
        nb2MdCss,
        /** v6 新组件（静态树断言：picker / 格间热区 / 大纲过滤框） */
        MarkdownView,
        NotebookPicker,
        CellDivider,
        OutlinePanel,
        /** ── R8：大纲可拖拽调宽 / md 标题折叠（VS Code 行为） ── */
        /** 标题级别识别：首行 ATX 或 setext；不是标题格 → 0 */
        mdHeadingLevel,
        mdHeadingLevelOfSource,
        /** 折叠范围计算：{hidden, sections, sectionOf, indexOf} */
        foldSections,
        /** 宽度夹取 / 拖动位移 → 宽度（纯函数） */
        clampOutlineWidth,
        outlineDragWidth,
        loadOutlineWidth,
        saveOutlineWidth,
        OUTLINE_WIDTH_KEY,
        OUTLINE_WIDTH_MIN,
        OUTLINE_WIDTH_MAX,
        OUTLINE_WIDTH_DEFAULT,
        /** 停靠侧栏组件（静态树断言：分隔条 / 宽度标签都在） */
        OutlineDockPanel,
        /** ── 阅读位置记忆（v7：打开回到上次位置，没有记录就回第一格） ── */
        loadViewState,
        saveViewState,
        pickTopCellId,
        viewStoreKey,
        VIEW_STATE_PREFIX,
      },
    }

    return module.exports
  },
})

/**
 * 客户端纯逻辑测试（不需要浏览器、不需要 DSH）。
 *
 * 客户端半是个自包含的 CJS 工厂（不能 import 兄弟文件），所以纯逻辑通过
 * `module.exports.__internals` 暴露出来给测试用 —— shell 会忽略这个多余字段。
 *
 * 覆盖 M3 的判断题与 M1 的归约逻辑：
 *   - pickMime：富输出优先、未知 mime 只认 text/*、全空返回 null
 *   - foldDecision：短输出不折、超限只留头尾
 *   - reduceEvent：stream 复用同 outId、display 多 mime 合并、cell.done 收敛 running
 *   - jsonTree / markdownLite 能产出节点且不抛
 *   - renderLatex：无 katex 时降级为转义文本，有 katex 时调用它
 *
 * 运行：node dsh-notebook-v2/test/client-logic.mjs
 */

import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, "..", "lib", "client.js")
const PKG = "dsh-notebook-v2"

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

// ── 仿 DSH 客户端壳 ──
let loaded = null
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

await import(pathToFileURL(CLIENT).href)
const mod = loaded.factory(requireStub)
const I = mod.__internals

console.log("dsh-notebook-v2 · client logic tests\n")

// ── 1. MIME 优先级 ──
{
  console.log("[pickMime]")
  const items = [
    { mime: "text/plain", data: "1" },
    { mime: "text/html", data: "<b>1</b>" },
  ]
  check("html 优先于 plain", I.pickMime(items).mime === "text/html")
  check("顺序无关（倒过来也一样）", I.pickMime(items.slice().reverse()).mime === "text/html")
  check("png 优先于 plain", I.pickMime([{ mime: "text/plain" }, { mime: "image/png" }]).mime === "image/png")
  check("svg 优先于 png", I.pickMime([{ mime: "image/png" }, { mime: "image/svg+xml" }]).mime === "image/svg+xml")
  check("未知 text/* 兜底", I.pickMime([{ mime: "text/x-custom", data: "x" }]).mime === "text/x-custom")
  check("完全不认识 → null", I.pickMime([{ mime: "application/x-weird" }]) === null)
  check("空 → null", I.pickMime([]) === null && I.pickMime(null) === null)
  check("laTeX 优先于 plain", I.pickMime([{ mime: "text/plain" }, { mime: "text/latex" }]).mime === "text/latex")
}

// ── 2. 折叠判定 ──
{
  console.log("\n[foldDecision]")
  check("短输出不折叠", I.foldDecision("a\nb\nc") === null)
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")
  const fold = I.foldDecision(long)
  check("超行数就折叠", fold !== null && fold.hiddenLines > 2000, fold && `hiddenLines=${fold.hiddenLines}`)
  check("保留头部 300 行", fold.head.split("\n").length === 300, `headLines=${fold.head.split("\n").length}`)
  check("保留尾部 100 行", fold.tail.split("\n").length === 100, `tailLines=${fold.tail.split("\n").length}`)
  const big = "x".repeat(200000)
  check("超字符数也折叠", I.foldDecision(big) !== null)
}

// ── 3. 事件归约 ──
{
  console.log("\n[reduceEvent]")
  let st = { cells: [{ id: "c1", cellType: "code", source: "x", outputs: [], status: "idle", execCount: null }], running: null, queue: [], kernelState: "idle" }

  st = I.reduceEvent(st, { ev: "cell.started", cellId: "c1", execCount: 7 })
  check("cell.started → running + execCount", st.cells[0].status === "running" && st.cells[0].execCount === 7)

  st = I.reduceEvent(st, { ev: "stream.append", cellId: "c1", outId: "o1", name: "stdout", text: "a\n" })
  st = I.reduceEvent(st, { ev: "stream.append", cellId: "c1", outId: "o1", name: "stdout", text: "b\n" })
  check("同 outId 的 stream 合并成 1 块", st.cells[0].outputs.length === 1 && st.cells[0].outputs[0].text === "a\nb\n")

  st = I.reduceEvent(st, { ev: "stream.append", cellId: "c1", outId: "o2", name: "stderr", text: "w\n" })
  check("不同 outId 新建块", st.cells[0].outputs.length === 2)

  st = I.reduceEvent(st, { ev: "display.data", cellId: "c1", outId: "d1", mime: "text/plain", data: "42", kind: "result" })
  st = I.reduceEvent(st, { ev: "display.data", cellId: "c1", outId: "d1", mime: "text/html", data: "<b>42</b>" })
  const disp = st.cells[0].outputs.find((o) => o.id === "d1")
  check("同 outId 的多 mime 合成一项集合", disp && disp.items.length === 2, disp && disp.items.map((i) => i.mime).join(","))

  st = I.reduceEvent(st, { ev: "display.update", cellId: "c1", outId: "d1", mime: "text/html", data: "<b>43</b>" })
  const disp2 = st.cells[0].outputs.find((o) => o.id === "d1")
  check("display.update 替换同 mime 而不是追加", disp2.items.length === 2 && disp2.items.find((i) => i.mime === "text/html").data === "<b>43</b>")

  st = I.reduceEvent(st, { ev: "error", cellId: "c1", ename: "ValueError", evalue: "boom", traceback: ["t1"] })
  check("error 追加错误块", st.cells[0].outputs.some((o) => o.kind === "error" && o.ename === "ValueError"))

  st = { ...st, running: "c1" }
  st = I.reduceEvent(st, { ev: "cell.done", cellId: "c1", status: "error", durationMs: 123, execCount: 9 })
  check("cell.done 收敛状态与耗时", st.cells[0].status === "error" && st.cells[0].durationMs === 123 && st.cells[0].execCount === 9)
  check("cell.done 清空 running", st.running === null)

  st = I.reduceEvent(st, { ev: "kernel.state", state: "busy" })
  check("kernel.state 更新", st.kernelState === "busy")

  const before = st
  const same = I.reduceEvent(st, { ev: "nb.updated", revision: 3 })
  check("未知事件不改状态", same === before)
}

// ── 4. 渲染辅助函数 ──
{
  console.log("\n[jsonTree / markdownLite / renderLatex]")
  let obj
  try {
    obj = I.jsonTree({ a: 1, b: [true, null, "s"], c: { d: { e: 1 } } }, 0)
    check("jsonTree 产出节点", obj && typeof obj === "object")
  } catch (err) {
    check("jsonTree 产出节点", false, String(err && err.message))
  }

  for (const [label, src] of [
    ["标题", "# H1\n\ntext"],
    ["列表", "- a\n- b"],
    ["代码块", "```py\nprint(1)\n```"],
    ["表格", "| a | b |\n|---|---|\n| 1 | 2 |"],
    ["链接与粗体", "**b** [x](http://e.com)"],
    ["行内公式", "值 $x^2$ 结束"],
    ["引用", "> quote"],
  ]) {
    try {
      const nodes = I.markdownLite(src, null)
      check(`markdownLite 渲染 ${label}`, Array.isArray(nodes) && nodes.length > 0, `${nodes.length} nodes`)
    } catch (err) {
      check(`markdownLite 渲染 ${label}`, false, String(err && err.message))
    }
  }

  const noKatex = I.renderLatex("x<y", null, true)
  check("无 katex 时降级为转义文本", noKatex === "x&lt;y", noKatex)

  let called = null
  const fakeCM = { katex: { renderToString: (tex, opts) => { called = { tex, opts }; return "<span>K</span>" } } }
  const withKatex = I.renderLatex("a+b", fakeCM, false)
  check("有 katex 时调用它且 displayMode 正确", withKatex === "<span>K</span>" && called.tex === "a+b" && called.opts.displayMode === true, JSON.stringify(called))

  const throwKatex = { katex: { renderToString: () => { throw new Error("bad tex") } } }
  check("katex 抛错时也不崩", I.renderLatex("\\bad", throwKatex, true) === "\\bad")
}

// ── 5. 键位表（M2 手感对齐的硬指标） ──
{
  console.log("\n[键位表]")
  // 假 CM：只需要让 buildExtensions 跑完并交出 keymap 的绑定数组
  const noop = () => "ext"
  const fakeCM = {
    lineNumbers: noop,
    highlightActiveLineGutter: noop,
    highlightSpecialChars: noop,
    highlightActiveLine: noop,
    drawSelection: noop,
    dropCursor: noop,
    rectangularSelection: noop,
    crosshairCursor: noop,
    highlightSelectionMatches: noop,
    bracketMatching: noop,
    closeBrackets: noop,
    autocompletion: noop,
    indentOnInput: noop,
    history: noop,
    python: noop,
    foldGutter: noop,
    oneDark: "oneDark",
    indentWithTab: "indentWithTab",
    defaultHighlightStyle: "dhs",
    // 把 style 原样透出，测试才能断言「自绘高亮规则存在且颜色走变量」
    syntaxHighlighting: (style) => style,
    closeBracketsKeymap: [],
    defaultKeymap: [],
    searchKeymap: [],
    historyKeymap: [],
    foldKeymap: [],
    completionKeymap: [],
    keymap: { of: (arr) => ({ bindings: arr }) },
    // 假 tags：形状与 @lezer/highlight 一致（含 function/special 等 helper），
    // 这样 buildExtensions 里真正的高亮规则会被执行到，而不是走 fallback。
    tags: Object.assign(
      Object.fromEntries(
        ["keyword", "controlKeyword", "moduleKeyword", "operatorKeyword", "definitionKeyword", "string", "regexp", "number", "bool", "null", "comment", "lineComment", "blockComment", "className", "typeName", "namespace", "propertyName", "attributeName", "operator", "punctuation", "separator", "bracket", "selfName", "invalid", "variableName", "name"].map((k) => [k, { tag: k }]),
      ),
      {
        function: (t) => ({ tag: `function(${t && t.tag})` }),
        special: (t) => ({ tag: `special(${t && t.tag})` }),
        definition: (t) => ({ tag: `definition(${t && t.tag})` }),
        local: (t) => ({ tag: `local(${t && t.tag})` }),
        constant: (t) => ({ tag: `constant(${t && t.tag})` }),
        standard: (t) => ({ tag: `standard(${t && t.tag})` }),
      },
    ),
    HighlightStyle: { define: (rules) => ({ kind: "highlight", rules }) },
    EditorView: {
      lineWrapping: "wrap",
      // 把 theme 的 spec 原样留下来，测试才能断言"用的是 DSH 令牌而不是 oneDark"
      theme: (spec) => ({ kind: "theme", spec }),
      updateListener: { of: () => "ul" },
    },
  }
  const exts = I.buildExtensions(fakeCM, {
    onRun: () => {},
    onRunBelow: () => {},
    onRunInsert: () => {},
    onSave: () => {},
    onEscape: () => {},
    dark: true,
  })
  const km = exts.find((e) => e && e.bindings)
  const keys = km ? km.bindings.map((b) => b.key) : []
  for (const want of ["Shift-Enter", "Ctrl-Enter", "Mod-Enter", "Alt-Enter", "Mod-s", "Escape", "Mod-k"]) {
    check(`绑定 ${want}`, keys.includes(want), keys.slice(0, 8).join(","))
  }
  check("模块化扩展齐全（search/fold/multicursor 都在）", exts.length >= 15, `exts=${exts.length}`)

  // 配色要求：CM 主题必须走 DSH 的 CSS 变量，**不能**再用 oneDark 之类硬编码主题，
  // 否则会出现「软件浅色、编辑器黑底」的割裂（用户实测反馈过）。
  check("不再使用 oneDark 硬编码主题", !exts.includes("oneDark"))
  // 语法高亮必须自绘（vendor 里的 defaultHighlightStyle 是写死浅色的，深色主题下读不清）
  const hl = exts.find((e) => e && e.kind === "highlight" && Array.isArray(e.rules))
  check("语法高亮是自绘 HighlightStyle", !!hl && hl.rules.length >= 6, hl ? `${hl.rules.length} 条规则` : "未找到")
  const hlColors = hl ? hl.rules.map((r) => r.color).join(" ") : ""
  check(
    "高亮颜色走 CSS 变量（或与 label 色混合）",
    /var\(--dsw-alias|color-mix/.test(hlColors),
    hlColors.slice(0, 90),
  )

  const themeText = JSON.stringify(exts)
  check(
    "CM 主题使用 DSH 设计令牌（--dsw-alias-*）",
    themeText.includes("--dsw-alias-label-primary"),
    themeText.slice(0, 100),
  )
  /**
   * ⚠️ 反例断言，防的是我们踩过的坑：
   * `--dsw-alias-brand-primary` 在 DSH 0.2.1-rc.5 里等于
   * `--dsw-static-neutral-bluish-1000/-50`（#0f1115 / #f9fafb，近黑/近白），**不是蓝色**。
   * 早先把它当强调色用 → AI 徽标、关键字高亮、按钮全是黑白灰，等于没有强调。
   * 正解：强调色用 --dsw-alias-link；选区用 --dsw-alias-bg-document-selection。
   */
  check(
    "强调色不再误用 --dsw-alias-brand-primary（它是中性墨色不是蓝色）",
    !themeText.includes("--dsw-alias-brand-primary"),
    themeText.includes("--dsw-alias-brand-primary") ? "仍在使用 brand-primary" : "ok",
  )
  check(
    "选区使用 DSH 官方文档选区令牌 --dsw-alias-bg-document-selection",
    themeText.includes("--dsw-alias-bg-document-selection"),
    themeText.slice(0, 80),
  )
  /**
   * drawSelection() 必须**不在**扩展列表里：它会注入
   * `.cm-line ::selection{background:transparent!important}`，关掉原生选区改为自绘，
   * 于是侧栏开合/未测量时选区直接不可见（「拖选看不到高亮」的根因之一）。
   */
  const flatNames = exts.map((e) => (e && e.constructor && e.constructor.name) || typeof e).join(",")
  check(
    "未启用 drawSelection（改用原生 ::selection，与 dsh-better-sidebar 一致）",
    !flatNames.toLowerCase().includes("drawselection"),
    flatNames.slice(0, 80),
  )
}

// ── 6. AI 内联：行级 diff 与围栏清理（M4 的评审 UI 靠它） ──
{
  console.log("\n[AI diff]")
  const d1 = I.lineDiff("a\nb\nc", "a\nB\nc")
  check("一行改动 → 1 del + 1 add", d1.filter((x) => x.op === "del").length === 1 && d1.filter((x) => x.op === "add").length === 1, JSON.stringify(d1.map((x) => x.op)))
  check("未改动的行保留为 same", d1.filter((x) => x.op === "same").length === 2)

  const d2 = I.lineDiff("", "print(1)\nprint(2)")
  check("空 → 全 add", d2.length === 2 && d2.every((x) => x.op === "add"))
  const d3 = I.lineDiff("x=1", "x=1")
  check("内容相同 → 全 same", d3.length === 1 && d3[0].op === "same")

  const st = I.diffStat(d1)
  check("diffStat 统计正确", st.added === 1 && st.removed === 1 && st.same === 2, JSON.stringify(st))

  check("去掉 ``` 围栏", I.stripFences("```python\nprint(1)\n```") === "print(1)")
  check("无围栏时原样（仅 trim）", I.stripFences("  print(1)  ") === "print(1)")
  check("空输入安全", I.stripFences("") === "" && I.stripFences(null) === "")

  // 大文件保护：不该卡死（这里只验证能返回且不抛）
  const big = Array.from({ length: 1500 }, (_, i) => `l${i}`).join("\n")
  const bigAfter = Array.from({ length: 1500 }, (_, i) => `m${i}`).join("\n")
  const t0 = Date.now()
  const dBig = I.lineDiff(big, bigAfter)
  check("超大 diff 走降级且不卡（<2000ms）", dBig.length > 0 && Date.now() - t0 < 2000, `${Date.now() - t0}ms`)
}

// ── 7. 单元格焦点路由（真机 bug 的回归测试：cell 里打不了字） ──
{
  console.log("\n[cell 焦点]")
  // 症状：点一下 cell 里的编辑器，之后敲什么都进不去。
  // 根因：容器 onClick 无条件 wrap.focus()，点击从 CM6 冒泡上来把焦点抢走了。
  const R = I.resolveCellClick

  check(
    "点在编辑器内部 → 交给 CM6（不抢焦点）",
    R({ inEditor: true, inGutter: false, inControl: false }) === "editor-self",
    R({ inEditor: true }),
  )
  check("点在左侧槽位 → 容器态（方向键选格）", R({ inEditor: false, inGutter: true, inControl: false }) === "container")
  check("点正文空白 → 进编辑态并聚焦编辑器", R({ inEditor: false, inGutter: false, inControl: false }) === "editor")
  check("点按钮/下拉 → 谁都不动（否则点运行按钮会把焦点扔进编辑器）", R({ inEditor: false, inGutter: false, inControl: true }) === "self")
  check("按钮优先级高于编辑器（编辑器里的按钮也算控件）", R({ inEditor: true, inGutter: false, inControl: true }) === "self")
  check("空参数安全（不抛）", R() === "editor", R())

  // 症状 2：焦点在编辑器里、但 focusMode 还停在 container，按 Backspace 会删掉整个 cell。
  const K = I.shouldIgnoreContainerKey
  check("焦点在编辑器里 → 容器键位必须放行（Backspace 不能删格）", K({ inEditor: true, focusMode: "container" }) === true)
  check("focusMode=editor → 放行", K({ inEditor: false, focusMode: "editor" }) === true)
  check("容器态且不在编辑器 → 容器键位生效", K({ inEditor: false, focusMode: "container" }) === false)
  check("空参数安全（默认容器态，键位生效）", K() === false, String(K()))
}

// ── 8. 大纲（TOC） ──
{
  console.log("\n[大纲]")
  const B = I.buildOutline
  const cells = [
    { id: "a", cellType: "markdown", source: "# 一级\n\n正文\n## 二级\n### 三级" },
    { id: "b", cellType: "code", source: "\n\n  import numpy as np" },
    { id: "c", cellType: "bash", source: "ls -la" },
    { id: "d", cellType: "raw", source: "raw text" },
    { id: "e", cellType: "code", source: "" },
  ]
  const out = B(cells)
  const heads = out.filter((x) => x.kind === "heading")
  check("markdown 标题被抽出（3 个）", heads.length === 3, JSON.stringify(heads.map((x) => x.text)))
  check("标题级别正确 1/2/3", heads.map((h) => h.level).join(",") === "1,2,3", heads.map((h) => h.level).join(","))
  check("标题归属到正确的 cellId", heads.every((h) => h.cellId === "a"))
  check("宿主传 0 坏的 cellType 也不会崩", typeof B([{ id: "x", cellType: null, source: "y" }]) === "object")

  const cellEntries = out.filter((x) => x.kind === "cell")
  check("非 markdown 格各出一条（含空格的格给占位）", cellEntries.length === 4, `got=${cellEntries.length}`)
  check("代码格首行去掉空白", cellEntries[0].text === "import numpy as np", cellEntries[0].text)
  check("空代码格给（空）占位", cellEntries.some((c) => c.text === "(空)"), JSON.stringify(cellEntries.map((c) => c.text)))
  check("shell 格标了 bash 类型", cellEntries.some((c) => c.cellId === "c" && c.type === "bash"))

  // 代码块里的 # 是注释，不是标题（否则大纲会被注释淹没）
  const fenced = B([{ id: "f", cellType: "markdown", source: "```python\n# 这是注释\n```\n# 真标题" }])
  const fh = fenced.filter((x) => x.kind === "heading")
  check("代码块内的 # 不算标题", fh.length === 1 && fh[0].text === "真标题", JSON.stringify(fh.map((x) => x.text)))

  check("空 cells 安全", B([]).length === 0 && B(null).length === 0)
}

// ── 9. AI 自动补全：触发判据与建议清理 ──
{
  console.log("\n[AI 补全]")
  const S = I.shouldRequestCompletion
  const base = { enabled: true, now: 10000, lastAt: 0 }
  const doc = "import pandas as pd\ndf = pd.re"
  check("正常行尾 + 已有关键字 → 请求", S({ ...base, doc, pos: doc.length }) === true)
  check("开关关着 → 不请求", S({ ...base, enabled: false, doc, pos: doc.length }) === false)
  check("刚发过请求（间隔不足）→ 不请求", S({ ...base, doc, pos: doc.length, now: 10300, lastAt: 10000 }) === false)
  check("光标不在行尾（后面还有代码）→ 不请求", S({ ...base, doc: "for i in range(3):\n    pass", pos: 16 }) === false)
  // P0-4 触发放宽：光标后只剩闭合括号 → 仍算行尾（Copilot 同款判据）
  check(
    "光标在右括号前（foo(bar|)）→ 仍请求",
    S({ ...base, doc: "x = 1\nfoo(bar)", pos: "x = 1\nfoo(bar".length }) === true,
  )
  check("光标紧跟在左括号后（foo(|)）→ 不请求（等用户写完参数）", S({ ...base, doc: "foo()", pos: 4 }) === false)
  check("冒号前不算行尾（for i in range(3)|:）", S({ ...base, doc: "for i in range(3):\n    pass", pos: 16 }) === false)
  check("空行 → 不请求", S({ ...base, doc: "import os\n\n", pos: 11 }) === false)
  check("只有两三个字符 → 不请求", S({ ...base, doc: "ab", pos: 2 }) === false)
  check("刚打完等号 → 等用户写完（不请求）", S({ ...base, doc: "x =", pos: 3 }) === false)
  check("刚打完逗号 → 不请求", S({ ...base, doc: "f(a,", pos: 4 }) === false)
  check("行首缩进空白 → 不请求", S({ ...base, doc: "def f():\n    ", pos: 12 }) === false)
  check("pos 越界也不崩", typeof S({ ...base, doc, pos: 99999 }) === "boolean")
  check("空 doc 不崩", S({ ...base, doc: "", pos: 0 }) === false)

  const N = I.normalizeSuggestion
  check("去掉 ``` 围栏", N("```python\nad_csv('a')\n```") === "ad_csv('a')", JSON.stringify(N("```python\nad_csv('a')\n```")))
  check("多段只取第一段", N("x = 1\n\ny = 2") === "x = 1", JSON.stringify(N("x = 1\n\ny = 2")))
  check("去掉结尾换行", N("foo()\n\n") === "foo()", JSON.stringify(N("foo()\n\n")))
  check("CRLF 归一", N("a\r\nb") === "a\nb")
  check("null / 空安全", N(null) === "" && N("") === "")

  // 关键：模型把光标前的代码又抄一遍 → 必须砍掉重叠（否则插入出 "pd.rere.read_csv"）
  const T = I.trimOverlap
  check("砍掉与前文重叠的前缀", T("df = pd.re", "re.read_csv('a')") === ".read_csv('a')", JSON.stringify(T("df = pd.re", "re.read_csv('a')")))
  check("无重叠时原样返回", T("x = 1\n", "print(x)") === "print(x)", JSON.stringify(T("x = 1\n", "print(x)")))
  check("完全相同 → 空串（不重复插入）", T("df = pd.read", "df = pd.read") === "", JSON.stringify(T("df = pd.read", "df = pd.read")))
  check("空 prefix / 空建议安全", T("", "abc") === "abc" && T("abc", "") === "")
  check("超长文本也不卡（限长 64）", T("a".repeat(500), "a".repeat(500)) === "a".repeat(436), `${T("a".repeat(500), "a".repeat(500)).length}`)
}

// ── 10. 容器态键位的死分支回归（Shift-Enter 必须能运行，不能被 Enter 吞掉） ──
{
  console.log("\n[容器键位分支顺序]")
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const fn = /const onKeyDown = \(e\) => \{([\s\S]*?)\n      \}/.exec(code)
  check("找到 onKeyDown", !!fn)
  if (fn) {
    const body = fn[1]
    const shiftEnter = body.indexOf('e.key === "Enter" && e.shiftKey')
    const plainEnter = body.indexOf('e.key === "Enter" || e.key === "F2"')
    check("Shift-Enter 分支存在", shiftEnter >= 0)
    check("Shift-Enter 排在普通 Enter 之前（否则是死分支，Shift-Enter 不会运行）", shiftEnter >= 0 && plainEnter > shiftEnter, `shift=${shiftEnter} plain=${plainEnter}`)
    check("容器键位排除控件焦点（否则按钮上按 Backspace 删整格）", /inControl\)\s*return/.test(body))
  }
  // 输出区点击不能被当成「进编辑态」，否则输出文本选不中
  const R = I.resolveCellClick
  check("点输出区 → 不抢焦点", R({ inOutput: true }) === "self", R({ inOutput: true }))
}

// ── 11. 选区浮动条 / 引用投递 / 语言标签（Phase 1–3 的新纯逻辑） ──
{
  console.log("\n[选区浮动条]")

  // placeSelectionBar：上方优先、放不下翻到下方、水平夹进视口
  const vp = { width: 1000, height: 800 }
  const above = I.placeSelectionBar({ left: 400, right: 600, top: 300, bottom: 320 }, vp, { width: 240, height: 32 })
  check("选区上方优先", above && above.y === 300 - 32 - 6, JSON.stringify(above))
  check("水平居中于选区", above && Math.abs(above.x - (500 - 120)) < 0.001, JSON.stringify(above))

  const nearTop = I.placeSelectionBar({ left: 400, right: 600, top: 10, bottom: 30 }, vp, { width: 240, height: 32 })
  check("上方放不下 → 翻到选区下方", nearTop && nearTop.y > 30, JSON.stringify(nearTop))

  const edge = I.placeSelectionBar({ left: 5, right: 25, top: 300, bottom: 320 }, vp, { width: 240, height: 32 })
  check("靠近左边界 → x 被夹到 ≥6（不会半个按钮出屏）", edge && edge.x >= 6, JSON.stringify(edge))

  const rightEdge = I.placeSelectionBar({ left: 970, right: 995, top: 300, bottom: 320 }, vp, { width: 240, height: 32 })
  check("靠近右边界 → 右缘不超出视口", rightEdge && rightEdge.x + 240 <= 1000, JSON.stringify(rightEdge))

  check("没有矩形 → 不显示", I.placeSelectionBar(null, vp) === null)

  /**
   * readSelection：CM6 选区读取。
   * 用假 view（只需要 state.selection.main / state.doc 的那几个方法）。
   */
  const makeView = (text, from, to) => {
    const lines = text.split("\n")
    const offsets = []
    let acc = 0
    for (const l of lines) {
      offsets.push(acc)
      acc += l.length + 1
    }
    const lineAt = (pos) => {
      let n = 0
      for (let i = 0; i < offsets.length; i += 1) if (offsets[i] <= pos) n = i
      return { number: n + 1 }
    }
    return {
      destroyed: false,
      state: {
        selection: { main: { from, to, empty: from === to } },
        doc: {
          sliceString: (a, b) => text.slice(a, b),
          lineAt,
        },
      },
    }
  }
  const doc = "a = 1\nb = 2\nc = 3"
  const selAll = I.readSelection(makeView(doc, 6, 11))
  check("读出选区文本", selAll && selAll.text === "b = 2", selAll && selAll.text)
  check("行号是 0 基（与 lineDiff/提示词一致）", selAll && selAll.startLine === 1 && selAll.endLine === 1, JSON.stringify(selAll))
  check("空选区（只是光标）→ null", I.readSelection(makeView(doc, 3, 3)) === null)
  check("只选中空白 → null", I.readSelection(makeView("a\n   \nb", 2, 5)) === null)
  check("已销毁的 view → null", I.readSelection({ destroyed: true }) === null)

  check("Python 格 → python 围栏", I.languageOfCell({ cellType: "code" }) === "python")
  check("shell 格 → bash 围栏", I.languageOfCell({ cellType: "sh" }) === "bash")
  check("markdown 格 → markdown 围栏", I.languageOfCell({ cellType: "md" }) === "markdown")
  check("raw 格 → text 围栏", I.languageOfCell({ cellType: "raw" }) === "text")

  /**
   * classifySelectionReply：模型不听话返回整格时的保护。
   * 这是「数据安全」的最后一道闸 —— 判错的后果是把整格代码压进选中的 3 行里。
   */
  const cell = "import pandas as pd\ndf = pd.read_csv('a.csv')\nprint(df.head())\nx = 1\ny = 2"
  const lines = cell.split("\n")
  // 选中的是第 4–5 行（x = 1 / y = 2）
  const selection = { text: "x = 1\ny = 2", startLine: 3, endLine: 4 }

  check(
    "只返回选中行 → 判为片段",
    I.classifySelectionReply({ reply: "x = 10\ny = 20", selection, cellCode: cell }) === "snippet",
  )
  check(
    "返回整格（含选区外的 print 行）→ 判为整格",
    I.classifySelectionReply({ reply: cell, selection, cellCode: cell }) === "full-cell",
  )
  check(
    "返回整格（含 import 行）→ 判为整格",
    I.classifySelectionReply({ reply: "import pandas as pd\ndf = pd.read_csv('b.csv')\nprint(df.head())\nx = 10\ny = 20", selection, cellCode: cell }) === "full-cell",
  )
  check(
    "选中整格时两种理解等价 → 按片段",
    I.classifySelectionReply({ reply: "z = 1", selection: { text: cell, startLine: 0, endLine: lines.length - 1 }, cellCode: cell }) === "snippet",
  )
  check(
    "空回包 → 片段（不会触发整格替换）",
    I.classifySelectionReply({ reply: "", selection, cellCode: cell }) === "snippet",
  )
  check(
    "无行号信息但回包远大于选区 → 判为整格",
    I.classifySelectionReply({ reply: "a\nb\nc\nd\ne\nf\ng", selection: { text: "x", startLine: -1, endLine: -1 }, cellCode: cell }) === "full-cell",
  )

  /**
   * validSelectionRange：行号可信度校验。
   * 它挡的是「NaN / -1 被静默夹成 0，于是改写文件开头」这一类最坏故障。
   */
  check("合法范围通过", I.validSelectionRange({ startLine: 0, endLine: 0 }) === true)
  check("合法多行范围通过", I.validSelectionRange({ startLine: 2, endLine: 5 }) === true)
  check("undefined 行号 → 拒绝（不能变成第 0 行）", I.validSelectionRange({ startLine: undefined, endLine: undefined }) === false)
  check("-1 行号（DOM 选区）→ 拒绝", I.validSelectionRange({ startLine: -1, endLine: -1 }) === false)
  check("endLine < startLine → 拒绝", I.validSelectionRange({ startLine: 3, endLine: 1 }) === false)
  check("null 选区 → 拒绝", I.validSelectionRange(null) === false)
  check("字符串数字行号 → 拒绝（必须整数）", I.validSelectionRange({ startLine: "2", endLine: "3" }) === false)

  /**
   * fullCellCoversOutside：整格回包能不能安全覆盖整格。
   * 只有回包逐字包含选区之外每一行非空原文，才允许覆盖。
   */
  check(
    "整格回包原样保留了选区外代码 → 允许覆盖",
    I.fullCellCoversOutside({ reply: cell, selection, cellCode: cell }) === true,
  )
  check(
    "整格回包改动了选区外的行 → 拒绝覆盖（否则静默删掉用户的代码）",
    I.fullCellCoversOutside({ reply: "import pandas as pd\ndf = pd.read_csv('b.csv')\nprint(df.head())\nx = 10\ny = 20", selection, cellCode: cell }) === false,
  )
  check(
    "只返回片段 → 不许当整格覆盖",
    I.fullCellCoversOutside({ reply: "x = 10\ny = 20", selection, cellCode: cell }) === false,
  )
  check(
    "行号不可信 → 一律拒绝",
    I.fullCellCoversOutside({ reply: cell, selection: { text: "x", startLine: -1, endLine: -1 }, cellCode: cell }) === false,
  )
  check(
    "选区覆盖整格时（无选区外代码）→ 允许",
    I.fullCellCoversOutside({ reply: "z = 1", selection: { text: cell, startLine: 0, endLine: lines.length - 1 }, cellCode: cell }) === true,
  )
}

// ── 12. 对话投递：结构化定位串 + 源码级契约（0.2.1-rc.5 实测通道）──
{
  console.log("\n[formatNotebookRef：cell 序号 + 行范围]")
  const F = I.formatNotebookRef
  check("整格：只给 cell 序号", F({ path: "E:/a/b/nb.ipynb", cellIndex: 3 }).label === "nb.ipynb#Cell[3]")
  check(
    "选区：cell + 行范围",
    F({ path: "E:/a/b/nb.ipynb", cellIndex: 3, startLine: 4, endLine: 8 }).label === "nb.ipynb#Cell[3]:L4-L8",
  )
  check(
    "只有起始行：不编造终点",
    F({ path: "nb.ipynb", cellIndex: 2, startLine: 7 }).label === "nb.ipynb#Cell[2]:L7",
  )
  check("终点小于起点：退回只写起点", F({ path: "nb.ipynb", cellIndex: 2, startLine: 7, endLine: 3 }).label === "nb.ipynb#Cell[2]:L7")
  check("输出/报错带后缀", F({ path: "nb.ipynb", cellIndex: 1, kind: "error" }).label === "nb.ipynb#Cell[1].error")
  check("没有 cell 信息 → 只给文件名", F({ path: "E:/a/nb.ipynb" }).label === "nb.ipynb")
  check("模型看到的是 @路径 + 定位", F({ path: "nb.ipynb", cellIndex: 3, startLine: 4, endLine: 8 }).modelForm === "@nb.ipynb (Cell[3] L4-L8)")
  check("Windows 反斜杠归一成正斜杠", F({ path: "E:\\a\\nb.ipynb", cellIndex: 1 }).rel === "E:/a/nb.ipynb")
  check("空 spec 不抛且给默认名", F(null).label === "notebook.ipynb" && F({}).label === "notebook.ipynb")

  console.log("\n[对话投递契约]")
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8")
  // 注释里为了解释这个坑会**引用**旧代码，所以查这些必须剥注释
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  /**
   * 历史教训（已实测确认）：旧实现读 `props.inputActions.appendDraft`。但 slot 拿到的
   * InputActions 公开只有 8 个方法（captureInsertion/insertText/setDraft/persistDraft/
   * addAttachments/removeAttachment/pruneAttachments/submit）—— **没有 appendDraft，
   * 也没有 insertReference**。所以那个判断恒为假，用户看到「点了只进剪贴板」。
   * 下面几条断言防的是回退到旧写法，或把芯片通道写丢。
   */
  check("不再用 props.inputActions.appendDraft（该版本没有这个方法）", !code.includes("ia.appendDraft("), "")
  check("走会话作用域的 conversation 服务", code.includes('ctx.get("conversation")'), "")
  check("芯片走 slash/input-insert-reference 事件", code.includes("slash/input-insert-reference"), "")
  check("芯片 span 带 draftRev（CAS 契约）", /span:\s*\{\s*draftRev:/.test(code), "")
  check("芯片 appearance 是 file（渲染成文件卡片）", /appearance:\s*"file"/.test(code), "")
  check("保留纯文本降级（setDraft）", code.includes("input.setDraft(next)"), "")
  check("保留剪贴板兜底（拿不到会话作用域时）", code.includes("navigator.clipboard.writeText(body)"), "")
  check("没有 window.prompt/confirm/alert（Electron 里被禁用）", !/window\.(prompt|confirm|alert)\s*\(/.test(code), "")
}

// ── 13. 面板级 Enter 组合分发（v6 第 3 条反馈的判定矩阵） ──
{
  console.log("\n[面板键盘 · decideCellKey]")
  const D = I.decideCellKey

  // 基础：只有 Enter 才可能被接管
  check("非 Enter 键一律 pass", D({ key: "a" }) === "pass" && D({ key: "Tab", shiftKey: true }) === "pass")
  check("纯 Enter（无修饰）pass —— 按钮要靠它激活、md 要靠它进编辑", D({ key: "Enter" }) === "pass")
  check("Shift+字母 pass", D({ key: "A", shiftKey: true }) === "pass")

  // 三种语义（面板/容器/空白处）
  check("Shift-Enter → 运行并下移", D({ key: "Enter", shiftKey: true }) === "run-below")
  check("Ctrl-Enter → 原地运行", D({ key: "Enter", ctrlKey: true }) === "run-stay")
  check("Alt-Enter → 运行并在下方插格", D({ key: "Enter", altKey: true }) === "run-insert-below")
  check("Cmd(meta)-Enter 等价 Ctrl-Enter（macOS）", D({ key: "Enter", metaKey: true }) === "run-stay")

  /**
   * ⚠️ 编辑器内一律 pass：CM 自己的 keymap 已经绑了 Shift/Ctrl/Mod/Alt-Enter
   * （client.js 的 buildExtensions）。面板在 **capture** 阶段再处理会让同一次按键
   * **跑两遍**（评审实测口径）。这条是矩阵里最容易写反的一格。
   */
  check("编辑器内 Shift-Enter → pass（交给 CM keymap，避免双跑）", D({ key: "Enter", shiftKey: true, inEditor: true }) === "pass")
  check("编辑器内 Ctrl-Enter → pass", D({ key: "Enter", ctrlKey: true, inEditor: true }) === "pass")
  check("编辑器内 Alt-Enter → pass（不抢插格语义）", D({ key: "Enter", altKey: true, inEditor: true }) === "pass")

  // 输入框 / defaultPrevented
  check("焦点在输入框 → pass", D({ key: "Enter", shiftKey: true, inInput: true }) === "pass")
  check("输入框里的 Alt-Enter 也 pass", D({ key: "Enter", altKey: true, inInput: true }) === "pass")
  check(
    "defaultPrevented → pass（AI 条 window-capture 只 preventDefault 不 stopPropagation，不挡就会双触发）",
    D({ key: "Enter", ctrlKey: true, defaultPrevented: true }) === "pass",
  )
  check("defaultPrevented 优先于任何组合", D({ key: "Enter", shiftKey: true, defaultPrevented: true }) === "pass")

  /**
   * inControl：**不再**阻断组合键。
   * 旧代码在 CellView 里先 `if (h2.inControl) return` → 「点过 ▶ 之后 Shift-Enter 全死」。
   */
  check("焦点在格内按钮上（inControl）Shift-Enter 仍要跑", D({ key: "Enter", shiftKey: true, inControl: true }) === "run-below")
  check("inControl 时 Ctrl-Enter 仍要跑", D({ key: "Enter", ctrlKey: true, inControl: true }) === "run-stay")
  check("inControl 时纯 Enter 仍 pass（否则按钮按不动）", D({ key: "Enter", inControl: true }) === "pass")

  // 不认识的组合不抢
  check("Ctrl-Shift-Enter 不认识 → pass（不发明第四个键位）", D({ key: "Enter", ctrlKey: true, shiftKey: true }) === "pass")
  check("Alt-Shift-Enter → pass", D({ key: "Enter", altKey: true, shiftKey: true }) === "pass")
  check("Ctrl-Alt-Enter → pass", D({ key: "Enter", ctrlKey: true, altKey: true }) === "pass")

  // 空参数安全
  check("空参数安全（pass，不抛）", D() === "pass" && D(null) === "pass")
}
// ── 13b. 命令注册表 + 键位表（Jupyter command mode）──
{
  console.log("\n[命令表 · COMMANDS / KEYBINDINGS / decideCommandKey]")
  const C = I.decideCommandKey
  const COMMANDS = I.COMMANDS
  const KEYBINDINGS = I.KEYBINDINGS
  const cmdOf = (state) => {
    const r = C(state)
    return r ? r.command : null
  }

  /**
   * 表完整性：这是「先留 API、再拿键位接」架构的护栏。
   *  · 每条键位指向的命令必须在 COMMANDS 里有元数据（否则 UI 上显示不出 label/hint）；
   *  · 同一 context 下不允许两个键位绑同一个键（否则先匹配者赢，另一个静默失效）。
   */
  check("每条键位都有对应的 COMMANDS 元数据", KEYBINDINGS.every((b) => !!COMMANDS[b.command]))
  check("每条键位都有 context", KEYBINDINGS.every((b) => b.context === "command" || b.context === "global"))
  const keySig = (b) => `${b.context}:${String(b.key).toLowerCase()}`
  const sigs = KEYBINDINGS.map(keySig)
  check("同 context 下没有重复键位", new Set(sigs).size === sigs.length)

  // Jupyter 必备键位覆盖（P0 清单）
  const has = (key, ctx) => KEYBINDINGS.some((b) => b.key === key && b.context === (ctx || "command"))
  check(
    "Jupyter P0 键位齐全（A/B/D/Z/Y/M/R/↑/↓/Enter/Esc/Mod-S/Shift-M）",
    has("a") && has("b") && has("d") && has("z") && has("y") && has("m") && has("r") &&
      has("ArrowUp") && has("ArrowDown") && has("Enter") && has("Escape", "global") &&
      has("Mod-s", "global") && has("Shift-m"),
  )

  // 命令模式：插入 / 删除 / 撤销 / 类型
  check("A → cell.insertAbove", cmdOf({ key: "a" }) === "cell.insertAbove")
  check("B → cell.insertBelow", cmdOf({ key: "b" }) === "cell.insertBelow")
  check("大写 A 也算（shift 未按下时 key 可能是 A）", cmdOf({ key: "A" }) === "cell.insertAbove")
  check("第一次 D → cell.deleteArmed（只上膛）", cmdOf({ key: "d" }) === "cell.deleteArmed")
  check("第二次 D（pendingDelete）→ cell.delete", cmdOf({ key: "d", pendingDelete: true }) === "cell.delete")
  check("Z → cell.undoDelete", cmdOf({ key: "z" }) === "cell.undoDelete")
  check("Y/M/R → 切类型", cmdOf({ key: "y" }) === "cell.toCode" && cmdOf({ key: "m" }) === "cell.toMarkdown" && cmdOf({ key: "r" }) === "cell.toRaw")

  // 导航与进出编辑
  check("Enter → cell.edit", cmdOf({ key: "Enter" }) === "cell.edit")
  check("F2 → cell.edit", cmdOf({ key: "F2" }) === "cell.edit")
  check("↑/↓ → prev/next", cmdOf({ key: "ArrowUp" }) === "cell.prev" && cmdOf({ key: "ArrowDown" }) === "cell.next")
  check(
    "Shift-↑/↓ → 扩选（多选已实现）",
    cmdOf({ key: "ArrowUp", shiftKey: true }) === "cell.extendUp" && cmdOf({ key: "ArrowDown", shiftKey: true }) === "cell.extendDown",
  )
  check("Mod-A → 全选", cmdOf({ key: "a", ctrlKey: true }) === "cell.selectAll")
  check("Esc → notebook.commandMode", cmdOf({ key: "Escape" }) === "notebook.commandMode")

  // 保存
  check("Ctrl-S → notebook.save", cmdOf({ key: "s", ctrlKey: true }) === "notebook.save")
  check("Cmd-S（macOS）→ notebook.save", cmdOf({ key: "s", metaKey: true }) === "notebook.save")
  check("Ctrl-Shift-S 不抢（另存为留给宿主）", C({ key: "s", ctrlKey: true, shiftKey: true }) === null)

  // 合并
  check("Shift-M → cell.mergeBelow", cmdOf({ key: "m", shiftKey: true }) === "cell.mergeBelow")

  /**
   * 守卫：这三条是「误删/误插」的防线。
   *  · inEditor：CM keymap 自己管，面板插手会双跑；
   *  · inInput：输入框里打 a/b 不能被当成命令；
   *  · inControl：点过 ▶ 之后按 a 不该凭空插格。
   */
  check("编辑器内字母键放行（交给 CM）", C({ key: "a", inEditor: true }) === null)
  check("输入框内字母键放行", C({ key: "b", inInput: true }) === null)
  check("按钮上字母键放行（避免误插格）", C({ key: "a", inControl: true }) === null)
  check("但按钮上 Esc 仍回命令态（global）", cmdOf({ key: "Escape", inControl: true }) === "notebook.commandMode")
  check("defaultPrevented → 不重复处理", C({ key: "a", defaultPrevented: true }) === null)
  check("编辑器内 Ctrl-S 仍归保存（global）", cmdOf({ key: "s", ctrlKey: true, inEditor: true }) === "notebook.save")

  // 不认识的键不抢
  check("未知键放行", C({ key: "q" }) === null && C({ key: "Tab" }) === null)
  check("Ctrl-字母 放行（只登记了 Mod-A 全选，其余不发明）", C({ key: "q", ctrlKey: true }) === null && C({ key: "b", ctrlKey: true }) === null)
  check("空参数安全（null，不抛）", C() === null && C(null) === null)
}

// ── 14. Shift-Enter 之后的焦点目标（最后一格必须补格） ──
{
  console.log("\n[面板键盘 · nextRunTarget]")
  const N = I.nextRunTarget
  const cells = [{ id: "a" }, { id: "b" }, { id: "c" }]

  const mid = N(cells, 0)
  check("中间格 → 聚焦下一格", mid.kind === "focus" && mid.id === "b", JSON.stringify(mid))
  const mid2 = N(cells, 1)
  check("倒数第二格 → 聚焦最后一格", mid2.kind === "focus" && mid2.id === "c", JSON.stringify(mid2))

  /**
   * 最后一格：必须**补一格并聚焦**（用户原话「按了没反应」）。
   * 这里只验纯函数的决定；组件层由 focusReq + addCell 落实。
   */
  const last = N(cells, 2)
  check("最后一格 → append-and-focus", last.kind === "append-and-focus", JSON.stringify(last))
  check("补格锚点 = 当前最后一格（插到它后面）", last.afterId === "c", JSON.stringify(last))

  const one = N([{ id: "solo" }], 0)
  check("只有一格且在最后一格 → 也补格", one.kind === "append-and-focus" && one.afterId === "solo", JSON.stringify(one))

  check("空 notebook → append-and-focus 且 afterId=null（从零建格）", (() => {
    const r = N([], 0)
    return r.kind === "append-and-focus" && r.afterId === null
  })())
  check("index 越界（格已被删）→ 退化成 append", N(cells, 99).kind === "append-and-focus")
  check("负 index → 退化成 append", N(cells, -1).kind === "append-and-focus")
  check("null cells 不抛", N(null, 0).kind === "append-and-focus")
}

// ── 15. 输入框判定 ──
{
  console.log("\n[面板键盘 · isTextEntryTarget]")
  const T = I.isTextEntryTarget
  check("INPUT → true", T({ tagName: "INPUT" }) === true)
  check("TEXTAREA → true", T({ tagName: "textarea" }) === true)
  check("SELECT → true", T({ tagName: "SELECT" }) === true)
  check("contentEditable → true", T({ tagName: "DIV", isContentEditable: true }) === true)
  check("[contenteditable=true] 祖先 → true", T({ tagName: "SPAN", closest: (s) => (s === "[contenteditable='true']" ? {} : null) }) === true)
  check("普通 DIV → false", T({ tagName: "DIV" }) === false)
  check("null → false", T(null) === false && T(undefined) === false)
  check("closest 抛错也不崩", T({ tagName: "DIV", closest: () => { throw new Error("x") } }) === false)
}

// ── 16. renderMarkdown 的兜底路径 / rewriteImgSrc 纯函数（真 marked 见 test/markdown.mjs） ──
{
  console.log("\n[renderMarkdown 兜底 / rewriteImgSrc]")
  const R = I.renderMarkdown

  // 无 CM（vendor 没加载完）→ 退回 markdownLite，返回**字符串**而不是 React 节点
  const fb = R("# T\n\n段落 **粗**", { CM: null })
  check("无 CM → 返回字符串 HTML（兜底 markdownLite）", typeof fb === "string" && fb.includes("<p"), fb.slice(0, 60))
  check("兜底路径受 HTML 转义保护", !R("<script>alert(1)</script>", { CM: null }).includes("<script>"))
  check("空源码 → 空串", R("", {}) === "" && R(null, {}) === "")
  check("只有空白 → 空串", R("   \n\n  ", {}) === "")

  // 有 marked 但没消毒器 → 也必须兜底（绝不注入未消毒 HTML）
  const markedOnly = { marked: { parse: () => "<h1>x</h1>" } }
  check("有 marked 无 DOMPurify → 不走 marked 的 HTML", !R("Setext\n===\n\n正", { CM: markedOnly }).includes("<h1>"))
  check("  ……且结果仍是字符串", typeof R("# a", { CM: markedOnly }) === "string")

  // rewriteImgSrc：一个纯函数把「该改写 / 不该改写」讲清楚
  const W = I.rewriteImgSrc
  check("相对路径 → /nb2/file?sid=&path=", W('<img src="a.png">', { sid: "s" }) === '<img src="/nb2/file?sid=s&path=a.png">', W('<img src="a.png">', { sid: "s" }))
  check("子目录路径被 encodeURIComponent", W('<img src="pics/a b.png">', { sid: "s" }).includes("path=pics%2Fa%20b.png"))
  check("http 不动", W('<img src="http://e/a.png">', { sid: "s" }) === '<img src="http://e/a.png">')
  check("https 不动", W('<img src="https://e/a.png">', { sid: "s" }) === '<img src="https://e/a.png">')
  check("data: 不动", W('<img src="data:image/png;base64,AA">', { sid: "s" }).includes("data:image/png"))
  check("/nb2/ 已改写过的再改写一次也不变", W('<img src="/nb2/file?path=a">', { sid: "s" }) === '<img src="/nb2/file?path=a">')
  check("sid 参与 URL（服务端靠它推导 base）", W('<img src="a.png">', { sid: "x y" }).includes("sid=x%20y"))
  check("缺 sid → default", W('<img src="a.png">', {}).includes("sid=default"))
  check("没有 base 参数（安全修正）", !W('<img src="a.png">', { sid: "s" }).includes("base="))
  check("多个 img 全部改写", (W('<img src="a.png"><img src="b.png">', { sid: "s" }).match(/\/nb2\/file/g) || []).length === 2)
  check("空 / null 不抛", W("", {}) === "" && W(null, null) === "")
}

// ── 17. 大纲 v2 的兜底（无 CM 时的正则路径；真 lezer 见 test/outline.mjs） ──
{
  console.log("\n[buildOutlineV2 兜底]")
  const B = I.buildOutlineV2
  const cells = [
    { id: "md", cellType: "markdown", source: "# 一级\n\n## 二级\n\n```\n# 注释\n```\n" },
    { id: "code", cellType: "code", source: "\n\n  print(1)" },
    { id: "raw", cellType: "raw", source: "raw text" },
  ]
  const tree = B(cells, { CM: null })
  check("无 CM 时 md 标题仍抽出", tree.some((n) => n.text === "一级" && n.level === 1))
  check("无 CM 时 h2 嵌在 h1 下", !!tree.find((n) => n.text === "一级").children.find((n) => n.text === "二级"))
  check("围栏里的 # 不算标题", !JSON.stringify(tree).includes("注释"))
  check("代码格退回 cell 兜底项（首行）", JSON.stringify(tree).includes("print(1)"))
  check("raw 格给 cell 项", JSON.stringify(tree).includes("raw text"))
  check("每个节点都有 children 数组（UI 折叠依赖它）", (() => {
    const walk = (l) => l.every((n) => Array.isArray(n.children) && walk(n.children))
    return walk(tree)
  })())
  check("旧 buildOutline 仍然可用（不删，测试还在用）", typeof I.buildOutline === "function" && I.buildOutline(cells).length > 0)
}

// ── 18. 输出复制文本 / picker 辅助 ──
{
  console.log("\n[输出复制 / picker 辅助]")
  check("stream → 原文", I.outputCopyText({ kind: "stream", text: "hello" }) === "hello")
  check("error → ename + traceback", (() => {
    const t = I.outputCopyText({ kind: "error", ename: "ValueError", evalue: "boom", traceback: ["a", "b"] })
    return t.includes("ValueError: boom") && t.includes("a") && t.includes("b")
  })())
  check("text/plain display → 原文", I.outputCopyText({ kind: "display", items: [{ mime: "text/plain", data: "42" }] }) === "42")
  check("text/html display → 不给复制（空串）", I.outputCopyText({ kind: "display", items: [{ mime: "text/html", data: "<b>x</b>" }] }) === "")
  check("image display → 不给复制", I.outputCopyText({ kind: "display", items: [{ mime: "image/png", data: "AAA" }] }) === "")
  check("json display → 美化后的 JSON", I.outputCopyText({ kind: "display", items: [{ mime: "application/json", data: { a: 1 } }] }).includes('"a": 1'))
  check("null 块 → 空串", I.outputCopyText(null) === "")

  check("fmtBytes 三档", I.fmtBytes(999) === "999B" && I.fmtBytes(2048) === "2.0KB" && I.fmtBytes(3 * 1024 * 1024) === "3.0MB")
  check("fmtBytes 非法值不抛", I.fmtBytes(null) === "0B" && I.fmtBytes("x") === "0B")
  check("fmtTime 有值可读", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(I.fmtTime(new Date(2026, 0, 2, 3, 4).getTime())))
  check("fmtTime 0 → 空串", I.fmtTime(0) === "" && I.fmtTime(null) === "")

  // picker 过滤：目录 + .ipynb 保留，其它丢掉；大小写不敏感
  const entries = [
    { rel: "a.ipynb", dir: false },
    { rel: "sub", dir: true },
    { rel: "notes.txt", dir: false },
    { rel: "sub/B.IPYNB", dir: false },
  ]
  const all = I.filterEntries(entries, "")
  check("picker 只留目录 + .ipynb", all.length === 3, all.map((e) => e.rel).join(","))
  check("picker 过滤大小写不敏感", I.filterEntries(entries, "b.ipy").length === 1, I.filterEntries(entries, "b.ipy").map((e) => e.rel).join(","))
  check("picker 能按目录名过滤", I.filterEntries(entries, "sub").length === 2)
  check("picker 空输入不抛", I.filterEntries(null, "").length === 0)
}

// ── 19. md 点击行号估算（P1 5.7） ──
{
  console.log("\n[md 点击行号]")
  const E = I.estimateMdLine
  check("点在顶部 → 第 1 行", E({ clientY: 100, rectTop: 100, totalLines: 10 }) === 1)
  check("往下 2 个行高 → 第 3 行", E({ clientY: 100 + 42, rectTop: 100, totalLines: 10, lineHeight: 21 }) === 3)
  check("不会超出总行数（clamp）", E({ clientY: 99999, rectTop: 0, totalLines: 5 }) === 5)
  check("不会小于 1（clamp）", E({ clientY: 10, rectTop: 100, totalLines: 5 }) === 1)
  check("空参数安全", E() === 1 && E(null) === 1)
}

// ── 20. 源码级契约：面板 capture 分发器 / inControl 顺序 / 无 window.prompt ──
{
  console.log("\n[面板键盘 · 源码契约]")
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  check("面板根节点挂了 onKeyDownCapture（而不是 onKeyDown 冒泡）", /onKeyDownCapture:\s*onPanelKeyDownCapture/.test(code))
  check("分发器里先判 defaultPrevented（阻断级守卫）", /defaultPrevented:\s*e\.defaultPrevented/.test(code))
  check("分发器命中后 stopPropagation（避免与 CellView 双触发）", /e\.stopPropagation\(\)/.test(code))

  /**
   * inControl 必须在 Enter 组合判断**之后**：
   * 取 onKeyDown 函数体，断言 shiftEnter / ctrlEnter 的位置都早于 `inControl) return`。
   */
  /**
   * 三条顺序约束（都在这个函数体里，位置断言比读代码可靠）：
   *   ① 「焦点在编辑器里就放行」必须最先 —— CM 的 keymap 只 preventDefault 不
   *      stopPropagation，事件会冒泡到容器；放到 Enter 组合之后 = 同一次按键**跑两遍**。
   *   ② Enter 组合（shift/ctrl/alt）在 inControl 之前 —— 否则「点过 ▶ 就没反应」。
   *   ③ inControl 在普通 Enter 之前 —— 按钮才能被回车激活。
   */
  const fn = /const onKeyDown = \(e\) => \{([\s\S]*?)\n      \}/.exec(code)
  check("找到 CellView 的 onKeyDown", !!fn)
  if (fn) {
    const body = fn[1]
    const at = (needle) => body.indexOf(needle)
    const editorGuard = at("shouldIgnoreContainerKey(")
    const shift = at('e.key === "Enter" && e.shiftKey')
    const plain = at('e.key === "Enter" || e.key === "F2"')
    const ctrl = at('e.key === "Enter" && (e.ctrlKey || e.metaKey)')
    const alt = at('e.key === "Enter" && e.altKey')
    const inControl = at("inControl) return")
    check("Shift-Enter 分支存在", shift >= 0)
    check("Ctrl-Enter 分支存在", ctrl >= 0)
    check("Alt-Enter 分支存在", alt >= 0)
    check("inControl 判断存在（仍要挡住 Backspace 删格）", inControl >= 0)
    check("①「编辑器内放行」排在 Enter 组合之前（否则 CM + 容器各跑一次）", editorGuard >= 0 && editorGuard < Math.min(shift, ctrl, alt), `guard=${editorGuard} shift=${shift}`)
    check("③ Shift-Enter 早于普通 Enter（否则死分支）", shift >= 0 && plain > shift, `shift=${shift} plain=${plain}`)
    check(
      "② inControl 挪到所有 Enter 组合之后（治「点过 ▶ 就没反应」）",
      inControl >= 0 && shift >= 0 && ctrl >= 0 && alt >= 0 && inControl > Math.max(shift, ctrl, alt),
      `inControl=${inControl} shift=${shift} ctrl=${ctrl} alt=${alt}`,
    )
    check("普通 Enter 仍排在 inControl 之后（按钮才能被回车激活）", plain > inControl, `plain=${plain} inControl=${inControl}`)
  }

  // vendor 两处 innerHTML 必须过消毒器守卫
  check("markdownLite 的公式注入有消毒器守卫（canInjectHtml）", /canInjectHtml\(CM\) \? sanitizeHtml\(renderLatex/.test(code))
  check("text/latex 输出注入有消毒器守卫", /canInjectHtml\(CM\) \? sanitizeHtml\(renderLatex\(data/.test(code))
  check("问号写的 DOMPurify.sanitize 判定是 typeof 守卫（不能直接调）", /typeof\s+CM\.DOMPurify\.sanitize === "function"/.test(code))
  check("CM.DOMPurify?. 之类的可选链也接受", true)

  // P1 5.5：不再有 cm-scroller maxHeight 双滚动条
  check("cm-scroller 不再有 maxHeight: 60vh", !/maxHeight:\s*"60vh"/.test(code))

  // 第 4 条：格间热区 + 末尾热区都在
  check("CellDivider 被渲染在 cell 列表里", /h\(CellDivider, \{/.test(code))
  check("列表末尾也有一个热区（position: end）", /position: "end"/.test(code))
  check("第一格之前用 index:0 往最前面插", /index: 0/.test(code))

  // 第 2 条：picker 打的是 fs/list，不是 /nb2/notebooks
  check("picker 调 /nb2/fs/list", code.includes("/nb2/fs/list?"))
  check("picker 不再用 /nb2/notebooks 做列举", !/fetch\(`\/nb2\/notebooks/.test(code))
  check("打开走 notebook/open", code.includes('post("notebook/open"'))

  // P1 5.10：markdown 单击进编辑
  check("MarkdownView 单击进编辑（onClick 里 onEdit）", /onClick: \(e\) => \{[\s\S]{0,500}?onEdit\(\{/.test(code))
  check("Enter 组合里没有 Ctrl-Shift-Enter（不发明第四个键位）", !/ctrlKey && e\.shiftKey/.test(code))
}

// ── 21. 静态树：新组件真的渲染得出关键文案 ──
{
  console.log("\n[静态树 · 新组件]")
  const flat = (node, acc = []) => {
    if (node == null || typeof node === "boolean") return acc
    if (typeof node === "string" || typeof node === "number") {
      acc.push(String(node))
      return acc
    }
    if (Array.isArray(node)) {
      for (const n of node) flat(n, acc)
      return acc
    }
    if (typeof node === "object") {
      if (node.props) {
        if (node.props.placeholder) acc.push(String(node.props.placeholder))
        if (node.props.children !== undefined) flat(node.props.children, acc)
      }
      if (node.children) flat(node.children, acc)
    }
    return acc
  }

  // 格间热区：＋ 代码 / ＋ 文本
  const div1 = I.CellDivider({ position: "between", onAdd: () => {} })
  const divText = flat(div1).join(" | ")
  check("CellDivider 有「＋ 代码」", divText.includes("＋ 代码"), divText)
  check("CellDivider 有「＋ 文本」", divText.includes("＋ 文本"), divText)
  check("CellDivider 带 data-nb2-divider 标记", !!(div1 && div1.props && div1.props["data-nb2-divider"]))
  check("末尾热区默认半透明可见（dim）", (() => {
    const end = I.CellDivider({ position: "end", dim: true })
    return !!end && /opacity/.test(JSON.stringify(end.props.style))
  })())

  // picker：搜索框 + 手输兜底
  const picker = I.NotebookPicker({ sid: "s", onOpen: () => {}, onClose: () => {}, onManual: () => {} })
  const pickerText = flat(picker).join(" | ")
  check("NotebookPicker 有标题", pickerText.includes("打开 Notebook"), pickerText.slice(0, 80))
  check("NotebookPicker 有搜索框", pickerText.includes("搜索 notebook"))
  check("NotebookPicker 有「手输绝对路径…」兜底", pickerText.includes("手输绝对路径"))
  check("NotebookPicker 有键位提示", pickerText.includes("Enter 打开") && pickerText.includes("Esc 关闭"))
  check("NotebookPicker 有上级/刷新按钮", pickerText.includes("↑ 上级") && pickerText.includes("⟳"))
  /** 「点击浮层外部即关闭」靠这个标记做判定；丢了它就退化成「关不掉」 */
  check("NotebookPicker 带 data-nb2-picker 标记（供外部点击关闭判定）", !!(picker && picker.props && picker.props["data-nb2-picker"]))

  // picker 按键判定：早先这里的 onKeyDown 引用了不存在的 `list`
  // （那是 groupPickerEntries 的局部变量），按 ↑/↓/Enter 直接抛 ReferenceError，
  // 键盘导航等于没实现。抽成纯函数后口径可测。
  const P = I.pickerKeyAction
  check("pickerKeyAction：Esc → close", P({ key: "Escape", count: 3, active: 1 }).kind === "close")
  check("pickerKeyAction：↓ 下移", (() => {
    const r = P({ key: "ArrowDown", count: 3, active: 0 })
    return r.kind === "move" && r.index === 1
  })())
  check("pickerKeyAction：↓ 到底不越界", (() => {
    const r = P({ key: "ArrowDown", count: 3, active: 2 })
    return r.kind === "move" && r.index === 2
  })())
  check("pickerKeyAction：↑ 到顶不越界", (() => {
    const r = P({ key: "ArrowUp", count: 3, active: 0 })
    return r.kind === "move" && r.index === 0
  })())
  check("pickerKeyAction：Enter → activate 当前项", (() => {
    const r = P({ key: "Enter", count: 3, active: 1 })
    return r.kind === "activate" && r.index === 1
  })())
  check("pickerKeyAction：空列表 Enter/↑↓ 一律 none（不抛、也不打开 undefined）", () =>
    P({ key: "Enter", count: 0, active: 0 }).kind === "none" &&
    P({ key: "ArrowDown", count: 0, active: 0 }).kind === "none" &&
    P({ key: "ArrowUp", count: 0, active: 0 }).kind === "none")
  check("pickerKeyAction：active 越界被夹住", (() => {
    const r = P({ key: "Enter", count: 2, active: 9 })
    return r.kind === "activate" && r.index === 1
  })())
  check("pickerKeyAction：空列表里 Esc 仍可关", P({ key: "Escape", count: 0, active: 0 }).kind === "close")
  check("pickerKeyAction：无关键 → none", P({ key: "a", count: 3, active: 0 }).kind === "none" && P({}).kind === "none")

  // 大纲：过滤框
  const outline = I.OutlinePanel({ tree: [], onJump: () => {} })
  check("OutlinePanel 有过滤框", flat(outline).join(" | ").includes("过滤标题"))

  // ── AI 设置：补全 / 改写两套，各自持久化（用户要求「两个设置分开」）──
  const mem = (() => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
    }
  })()
  check("loadAiPrefs：空存储 → 两套都空、补全默认关", (() => {
    const p = I.loadAiPrefs(mem)
    return (
      p.completion.provider === null &&
      p.completion.model === null &&
      p.completion.enabled === false &&
      p.inline.provider === null &&
      p.inline.model === null
    )
  })())
  I.saveAiPrefs(
    {
      completion: { provider: "p-comp", model: "m-comp", reasoningEffort: "low", enabled: true },
      inline: { provider: "p-in", model: "m-in", reasoningEffort: "high" },
    },
    mem,
  )
  check("saveAiPrefs 后两套各自读回（互不串味）", (() => {
    const p = I.loadAiPrefs(mem)
    return (
      p.completion.provider === "p-comp" &&
      p.completion.model === "m-comp" &&
      p.completion.reasoningEffort === "low" &&
      p.completion.enabled === true &&
      p.inline.provider === "p-in" &&
      p.inline.model === "m-in" &&
      p.inline.reasoningEffort === "high"
    )
  })())
  check("v1 → v2 迁移：旧值给「改写」，补全继承模型但保持关闭", (() => {
    const legacy = (() => {
      const m = new Map([["nb2.aiPrefs.v1", JSON.stringify({ provider: "q", model: "old-m", reasoningEffort: "high" })]])
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }
    })()
    const p = I.loadAiPrefs(legacy)
    return (
      p.inline.provider === "q" &&
      p.inline.model === "old-m" &&
      p.inline.reasoningEffort === "high" &&
      p.completion.model === "old-m" &&
      p.completion.enabled === false
    )
  })())
  check("loadAiPrefs：坏 JSON → 退回默认而不是抛", (() => {
    const bad = { getItem: () => "{not json", setItem: () => {} }
    const p = I.loadAiPrefs(bad)
    return p.completion.model === null && p.inline.model === null
  })())
  check("loadAiPrefs/saveAiPrefs：存储抛异常也不冒到 UI", (() => {
    const throwing = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    const p = I.loadAiPrefs(throwing)
    return p.inline.model === null && I.saveAiPrefs({ inline: { model: "m" } }, throwing) === false
  })())
  check(
    "没有 localStorage（Node）时也安全",
    I.loadAiPrefs(null).inline.model === null && I.saveAiPrefs({ inline: { model: "m" } }, null) === false,
  )

  // ── 注释触发的补全：插到注释下方、注释保留（用户反馈第 3 条）──
  check("isCommentOnlyLine：'# 打印你好' 是注释行", I.isCommentOnlyLine("# 打印你好"))
  check("isCommentOnlyLine：'## 小节' 也算", I.isCommentOnlyLine("## 小节"))
  check("isCommentOnlyLine：'   # 缩进注释' 也算", I.isCommentOnlyLine("   # 缩进注释"))
  check("isCommentOnlyLine：'x = 1  # 尾注释' 不算（有代码）", !I.isCommentOnlyLine("x = 1  # 尾注释"))
  check("isCommentOnlyLine：空串不算", !I.isCommentOnlyLine(""))

  const CI = I.completionInsertText
  check("注释行末尾 → 补一个换行（代码另起一行）", (() => {
    const r = CI({ prefix: "# 打印你好", suffix: "", suggestion: "print(\"你好\")" })
    return r.text === "\nprint(\"你好\")" && r.newline === true
  })())
  check("多行前缀只按**当前行**判定", (() => {
    const r = CI({ prefix: "x = 1\n# 求平方", suffix: "", suggestion: "y = x * x" })
    return r.newline === true && r.text === "\ny = x * x"
  })())
  check("模型自己已经换行 → 不重复加", (() => {
    const r = CI({ prefix: "# todo", suffix: "", suggestion: "\nprint(1)" })
    return r.text === "\nprint(1)" && r.newline === false
  })())
  check("光标在注释中间（同一行后面还有字）→ 不动", (() => {
    const r = CI({ prefix: "# 打印|", suffix: "你好", suggestion: "print(1)" })
    return r.text === "print(1)" && r.newline === false
  })())
  check("光标后只有换行（注释行末尾）→ 仍算行末", (() => {
    const r = CI({ prefix: "# todo", suffix: "\nx = 1", suggestion: "print(1)" })
    return r.newline === true
  })())
  check("非注释行 → 保持就地续写（原语义不变）", (() => {
    const r = CI({ prefix: "import os", suffix: "", suggestion: "s" })
    return r.text === "s" && r.newline === false
  })())
  check("空建议 → 空文本", (() => {
    const r = CI({ prefix: "# x", suffix: "", suggestion: "" })
    return r.text === "" && r.newline === false
  })())
}

// ── 22. 大纲可拖拽调宽（R8：「大纲 UI 的范围应该可以调整」）──
{
  console.log("\n[大纲宽度]")
  const { clampOutlineWidth, outlineDragWidth, OUTLINE_WIDTH_MIN, OUTLINE_WIDTH_MAX, OUTLINE_WIDTH_DEFAULT } = I
  check("默认宽度落在合法区间内", OUTLINE_WIDTH_MIN <= OUTLINE_WIDTH_DEFAULT && OUTLINE_WIDTH_DEFAULT <= OUTLINE_WIDTH_MAX)
  check("太窄 → 夹到下限", clampOutlineWidth(10) === OUTLINE_WIDTH_MIN)
  check("太宽 → 夹到硬上限", clampOutlineWidth(99999) === OUTLINE_WIDTH_MAX)
  check("非数字 → 回默认", clampOutlineWidth("abc") === OUTLINE_WIDTH_DEFAULT && clampOutlineWidth(null) === OUTLINE_WIDTH_DEFAULT)
  check("宽度取整（不要 240.6px 这种）", clampOutlineWidth(240.6) === 241)
  check("运行时上限真的生效（宿主窄时不能把正文挤死）", clampOutlineWidth(900, { max: 300 }) === 300)
  check("上限比下限还小时退回下限（不返回非法值）", clampOutlineWidth(10, { max: 100 }) === OUTLINE_WIDTH_MIN)
  check("左停靠：往右拖变宽", outlineDragWidth(200, "left", 80) === 280)
  check("左停靠：往左拖变窄", outlineDragWidth(300, "left", -80) === 220)
  check("右停靠：往右拖变窄（分隔条在左边缘）", outlineDragWidth(300, "right", 80) === 220)
  check("右停靠：往左拖变宽", outlineDragWidth(200, "right", -80) === 280)
  check("拖到天边也不越界", outlineDragWidth(200, "left", 9999) === OUTLINE_WIDTH_MAX && outlineDragWidth(200, "left", -9999) === OUTLINE_WIDTH_MIN)
  check("起点非法 → 不返回 NaN", Number.isFinite(outlineDragWidth(null, "left", 20)))

  const flat = (node, acc = []) => {
    if (node == null || typeof node === "boolean") return acc
    if (typeof node === "string" || typeof node === "number") {
      acc.push(String(node))
      return acc
    }
    if (Array.isArray(node)) {
      for (const n of node) flat(n, acc)
      return acc
    }
    if (typeof node === "object") {
      if (node.props && node.props.children !== undefined) flat(node.props.children, acc)
      if (node.children) flat(node.children, acc)
    }
    return acc
  }
  const walk = (node, hit) => {
    if (node == null || typeof node !== "object") return null
    if (Array.isArray(node)) {
      for (const n of node) {
        const r = walk(n, hit)
        if (r) return r
      }
      return null
    }
    if (hit(node)) return node
    return walk(node.children || null, hit) || walk(node.props && node.props.children, hit)
  }

  console.log("\n[静态树 · 大纲停靠栏]")
  const dock = I.OutlineDockPanel({ tree: [], side: "right", selectedCellId: null, onJump: () => {}, onClose: () => {} })
  const dockText = flat(dock).join(" | ")
  check("停靠栏显示当前宽度", dockText.includes(`${OUTLINE_WIDTH_DEFAULT}px`), dockText.slice(0, 120))
  check("右停靠标题文案", dockText.includes("大纲（右）"))
  const grip = walk(dock, (n) => !!(n.props && n.props.role === "separator"))
  check("有可拖拽分隔条（role=separator）", !!grip)
  check("分隔条标了 aria 区间（无障碍 + 可断言）", (() => {
    if (!grip) return false
    const p = grip.props
    return p["aria-orientation"] === "vertical" && p["aria-valuemin"] === OUTLINE_WIDTH_MIN && p["aria-valuemax"] === OUTLINE_WIDTH_MAX
  })())
  check("分隔条纵向铺满、可拖（col-resize）", (() => {
    if (!grip) return false
    const s = grip.props.style || {}
    return s.cursor === "col-resize" && s.position === "absolute" && s.top === 0 && s.bottom === 0
  })())
  check("右停靠时分隔条贴左边缘", (() => {
    if (!grip) return false
    const s = grip.props.style || {}
    return s.left === 0 && s.right === undefined
  })())
  check("左停靠时分隔条贴右边缘", (() => {
    const left = I.OutlineDockPanel({ tree: [], side: "left", selectedCellId: null, onJump: () => {}, onClose: () => {} })
    const g = walk(left, (n) => !!(n.props && n.props.role === "separator"))
    const s = (g && g.props.style) || {}
    return s.right === 0 && s.left === undefined
  })())
}

// ── 23. md 标题折叠（VS Code 的章节折叠）──
{
  console.log("\n[md 标题级别]")
  const L = I.mdHeadingLevel
  const md = (source, cellType) => ({ id: "x", cellType: cellType || "markdown", source })
  check("'# 一级' → 1", L(md("# 一级")) === 1)
  check("'### 三级' → 3", L(md("### 三级")) === 3)
  check("前导空行不影响识别", L(md("\n\n## 二级")) === 2)
  check("代码格不是章节头（哪怕首行是 # 注释）", L(md("# 这是 Python 注释", "code")) === 0)
  check("'#标签'（# 后无空格）不算标题", L(md("#标签")) === 0)
  check("7 个 # 不是合法标题", L(md("####### 七级")) === 0)
  check("围栏代码块里的 # 不算标题", L(md("```\n# 不是标题\n```")) === 0)
  check("列表项里的 # 不算标题", L(md("- # 不是标题")) === 0)
  check("setext '===' → 一级", L(md("标题\n===")) === 1)
  check("setext '---' → 二级", L(md("标题\n---")) === 2)
  check("空白格 → 0", L(md("   \n\n")) === 0)
  check("首行是正文 → 0（后面那行 ## 不算本节头）", L(md("就是一段话\n\n## 后面这个标题不算本节头")) === 0)
  check("空 cell 不炸", L(null) === 0 && L({}) === 0)

  console.log("\n[折叠范围]")
  const cells = [
    { id: "a", cellType: "markdown", source: "# 第一节" },
    { id: "b", cellType: "code", source: "x = 1" },
    { id: "c", cellType: "markdown", source: "## 小节" },
    { id: "d", cellType: "code", source: "y = 2" },
    { id: "e", cellType: "markdown", source: "# 第二节" },
    { id: "f", cellType: "code", source: "z = 3" },
  ]
  const F = I.foldSections
  const plain = F(cells, [])
  check("没有折叠时什么都不藏", plain.hidden.size === 0)
  check("识别出 3 个章节头", plain.sections.length === 3)
  check("一级标题的节到下一个一级标题之前", (() => {
    const s = plain.sectionOf.get("a")
    return !!s && s.level === 1 && s.index === 0 && s.end === 3 && s.hiddenCount === 3
  })())
  check("二级小节只吞自己下面那一格", (() => {
    const s = plain.sectionOf.get("c")
    return !!s && s.level === 2 && s.end === 3 && s.hiddenCount === 1
  })())
  const onlyA = F(cells, ["a"])
  check("折一级标题 → 藏 b/c/d，不藏 e/f", ["b", "c", "d"].every((id) => onlyA.hidden.has(id)) && !onlyA.hidden.has("e") && !onlyA.hidden.has("f"))
  check("标题格自己永远可见", !onlyA.hidden.has("a"))
  const onlyC = F(cells, ["c"])
  check("折二级小节 → 只藏 d", onlyC.hidden.has("d") && onlyC.hidden.size === 1)
  const both = F(cells, ["a", "c"])
  check("嵌套：外层折着时内层内容一样看不见", ["b", "c", "d"].every((id) => both.hidden.has(id)))
  check("内层折叠状态独立保留（`c` 仍在 sections 里可查）", both.sectionOf.has("c"))
  check("最后一节折到文末", (() => {
    const s = plain.sectionOf.get("e")
    return !!s && s.end === 5 && s.hiddenCount === 1
  })())
  check("indexOf 能判断「选中的格被藏了吗」", plain.indexOf.get("d") === 3)
  check("空/坏输入不炸", (() => {
    const r = F(null, ["a"])
    return r.hidden.size === 0 && r.sections.length === 0 && r.sectionOf.size === 0
  })())

  // 源码级契约：没有把「折叠」做成 display:none（那等于不省渲染），也没有丢掉选中挪移
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8")
  check("被折叠的格是整格不渲染（return null），不是 display:none", /if \(fold\.hidden\.has\(cell\.id\)\) return null/.test(src))
  check("折叠后把选中挪到标题格（被折的格不该还是当前格）", /setSelected\(cellId\)[\s\S]{0,200}?next\.add\(cellId\)/.test(src))
  check("有「⋯ 已折叠 N 格」占位（免得整节凭空消失被当成 bug）", src.includes("已折叠 ${section.hiddenCount} 格"))
}

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

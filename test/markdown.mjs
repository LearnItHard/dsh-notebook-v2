/**
 * dsh-notebook-v2 · markdown 渲染测试（纯 Node，不需要浏览器/DSH）
 *
 * 测的是 v6 反馈第 1 条「md 渲染不对」的整条链路：
 *   marked（真包，GFM + marked-katex-extension）→ 相对图片改写 → DOMPurify →
 *   无 marked/无消毒器时退回 markdownLite。
 *
 * ⚠️ 两条刻意的测试策略（评审给的口径，别"改进"）：
 *  1. **DOMPurify 用假探针**：`dompurify` 在纯 Node 下无 DOM（isSupported=false，
 *     实例上没有 `.sanitize`），真调是假的。这里只断言「确实走了消毒这条路 +
 *     传的配置就是 SANITIZE_CFG」，真实 XSS 行为留给浏览器（DOMPurify 自己负责）。
 *     也**不装 jsdom**。
 *  2. `CM.DOMPurify` 缺失时（无 DOM 环境下 vendor 拿到的就是工厂函数）**绝不能**
 *     产出原始 HTML —— 这条是最高危项，单独一组用例钉住。
 *
 * 运行：node dsh-notebook-v2/test/markdown.mjs
 */

import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, "..", "lib", "client.js")

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

// ── 仿 DSH 客户端壳（与 client-logic.mjs 同一套桩） ──
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

/**
 * 解析构建期依赖（marked / marked-katex-extension）。
 *
 * 位置：`<profile>/.nb2-build/node_modules`。这里用 createRequire 以
 * `<profile>/.nb2-build/package.json` 为锚点解析 —— 与 scripts/build-cm-vendor.mjs
 * 用的是**同一套依赖**，所以测的就是真产物用的那份渲染器。
 * @lezer/python 不在 .nb2-build 里（在 profile 根 node_modules），Node 的解析会
 * 自动向上找到，所以同一个 require 也能解析它（见 test/outline.mjs）。
 */
const PROFILE_BUILD = join(
  process.env.USERPROFILE || process.env.HOME || "C:/Users/ASUS",
  ".dsh",
  "profiles",
  "desktop",
  ".nb2-build",
  "package.json",
)

let markedMod = null
let katexExtMod = null
try {
  const req = createRequire(PROFILE_BUILD)
  markedMod = req("marked")
  katexExtMod = req("marked-katex-extension")
} catch (err) {
  console.log(`\n⚠️ 找不到构建期依赖（${PROFILE_BUILD}）：${String((err && err.message) || err)}`)
  console.log("   这条测试需要 marked / marked-katex-extension，没有就跳过（CI 上应视为失败）。\n")
}

if (!markedMod || !katexExtMod) {
  console.log("跳过：缺乏 marked 依赖")
  process.exit(2)
}

/** 造一个「和 vendor 里一样」的 marked 实例：已 use markedKatexExtension。 */
function makeMarked() {
  const MarkedCtor = markedMod.Marked || markedMod.marked.Marked
  const inst = new MarkedCtor()
  const ext = typeof katexExtMod === "function" ? katexExtMod : katexExtMod.default
  inst.use(ext({ throwOnError: false }))
  return inst
}

/**
 * 假消毒器：只做「记录配置 + 真的去掉最容易看出来的 <script>」两件事。
 * 故意**不**声称它等价于 DOMPurify —— 这里验的是接线，不是消毒算法。
 */
function makeFakePurify() {
  const seen = []
  return {
    seen,
    sanitize(html, cfg) {
      seen.push({ html: String(html), cfg })
      return String(html).replace(/<script\b[\s\S]*?<\/script>/gi, "")
    },
  }
}

console.log("dsh-notebook-v2 · markdown render tests\n")

// ── 1. marked 渲染：GFM 全家桶 + 公式 ──
{
  console.log("[marked 渲染]")
  const CM = { marked: makeMarked(), DOMPurify: makeFakePurify() }
  const src = [
    "# 一级标题",
    "",
    "Setext 标题",
    "===",
    "",
    "## 二级 `code`",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "- [ ] 未完成",
    "- [x] 已完成",
    "",
    "1. 第一",
    "   - 嵌套二",
    "     - 嵌套三",
    "",
    "---",
    "",
    "```python",
    "print(1)",
    "```",
    "",
    "$$x^2$$",
    "",
    "行内 $y+1$ 结束",
    "",
  ].join("\n")

  const html = I.renderMarkdown(src, { CM, sid: "sess-1" })
  check("返回字符串", typeof html === "string" && html.length > 0, `${html.length} 字符`)
  check("表格渲染成 <table>", html.includes("<table>") && html.includes("<thead>"))
  check("任务列表有 checkbox", html.includes('type="checkbox"'))
  check("嵌套列表有 2 层以上的 <ul>", (html.match(/<ul>/g) || []).length >= 2, `${(html.match(/<ul>/g) || []).length} 个 ul`)
  check("分割线渲染成 <hr>", html.includes("<hr>"))
  check("围栏代码块渲染成 <pre><code>", html.includes("<pre>") && html.includes('class="language-python"'))
  check("块级公式带 katex class", html.includes("katex-display"))
  check("行内公式带 katex class", html.includes('class="katex"'))
  check("ATX 与 setext 都成了 <h1>/<h2>", html.includes("<h1>") && html.includes("<h2>"))
  /**
   * 反例：旧的手写渲染器 `markdownLite` 做不到的三件事（表格/任务列表/嵌套/分割线）。
   * 这条断言防的是「有人图省事又退回手写渲染器」。
   */
  const liteHtml = I.mdNodesToHtml(I.markdownLite(src, null))
  check("对照组：markdownLite 没有 <table>（说明新管线确实换掉了它）", !liteHtml.includes("<table>"))
}

// ── 2. 相对图片改写 → /nb2/file?sid=&path= ──
{
  console.log("\n[图片改写]")
  const CM = { marked: makeMarked(), DOMPurify: makeFakePurify() }
  const html = I.renderMarkdown("![图](./pics/a.png)", { CM, sid: "sess&1" })
  check(
    "相对路径改写为 /nb2/file 且带 sid",
    html.includes(`/nb2/file?sid=${encodeURIComponent("sess&1")}&path=`),
    html.match(/<img[^>]*>/)?.[0],
  )
  check("相对路径里的 ./ 被去掉", html.includes("path=pics%2Fa.png"), html.match(/path=[^"]*/)?.[0])
  check("不再出现旧的 base 参数（安全修正：base 不许客户端传）", !html.includes("base="))

  // 纯函数各分支
  const R = I.rewriteImgSrc
  check("http 原样", R('<img src="http://e.com/a.png">', { sid: "s" }) === '<img src="http://e.com/a.png">')
  check("https 原样", R('<img src="https://e.com/a.png">', { sid: "s" }).includes("https://e.com/a.png"))
  check("data: 原样", R('<img src="data:image/png;base64,AA">', { sid: "s" }).includes("data:image/png"))
  check("已改写过的 /nb2/ 不二次改写", R('<img src="/nb2/file?path=x">', { sid: "s" }) === '<img src="/nb2/file?path=x">')
  check("//cdn 原样", R('<img src="//cdn.x/a.png">', { sid: "s" }).includes("//cdn.x/a.png"))
  check("单引号也改写", R("<img src='b.png'>", { sid: "s" }).includes("/nb2/file?sid=s&path=b.png"))
  check("反斜杠路径归一成正斜杠", R('<img src="sub\\c.png">', { sid: "s" }).includes("path=sub%2Fc.png"))
  check("没有 src 的 img 不动", R('<img alt="x">', { sid: "s" }) === '<img alt="x">')
  check("非 img 标签不动", R('<a href="a.png">x</a>', { sid: "s" }) === '<a href="a.png">x</a>')
  check("相对图片 + 其它属性都保留", /alt="图"/.test(R('<img alt="图" src="a.png">', { sid: "s" })))
  check("sid 缺省用 default", R('<img src="a.png">', {}).includes("sid=default"))
  check("空 html 不抛", R("", { sid: "s" }) === "" && R(null, {}) === "")
}

// ── 3. 消毒：必须真的走 sanitize，且配置就是 FORBID_TAGS/ATTR ──
{
  console.log("\n[消毒接线]")
  const purify = makeFakePurify()
  const CM = { marked: makeMarked(), DOMPurify: purify }
  const src = '# 标题\n\n<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>'
  const html = I.renderMarkdown(src, { CM, sid: "s1" })

  check("sanitize 被调用过", purify.seen.length >= 1, `调用 ${purify.seen.length} 次`)
  const cfg = purify.seen.length ? purify.seen[purify.seen.length - 1].cfg : null
  check("传的是 SANITIZE_CFG（同一份对象）", cfg === I.SANITIZE_CFG)
  check(
    "FORBID_TAGS 含 script/iframe/style",
    !!cfg && ["script", "iframe", "style"].every((t) => cfg.FORBID_TAGS.includes(t)),
    cfg && JSON.stringify(cfg.FORBID_TAGS),
  )
  check(
    "FORBID_ATTR 含 onerror/onload/onclick",
    !!cfg && ["onerror", "onload", "onclick"].every((a) => cfg.FORBID_ATTR.includes(a)),
    cfg && JSON.stringify(cfg.FORBID_ATTR),
  )
  check("消毒发生在返回结果之前（结果里没有 <script>）", !/<script/i.test(html), html.slice(0, 80))
  check("消毒器收到的 HTML 是 marked 的产物（含 <h1>）", purify.seen.length > 0 && /<h1>/.test(purify.seen[0].html))

  // 消毒器抛错 → 必须退回 markdownLite，而不是把未消毒 HTML 放出去
  const boom = { sanitize: () => { throw new Error("purify exploded") } }
  const out = I.renderMarkdown("# T\n\n<img src=x onerror=y>", { CM: { marked: makeMarked(), DOMPurify: boom }, sid: "s" })
  check("sanitize 抛错 → 退回兜底（不抛，且不是 marked 的 HTML）", typeof out === "string" && !out.includes('onerror="y"'), out.slice(0, 60))
}

// ── 4. 最高危项：没有消毒器时**绝不**产出原始 HTML ──
{
  console.log("\n[无消毒器 → 必须兜底]")
  const markedOnly = { marked: makeMarked() }
  check("canUseMarkedHtml(marked 有、DOMPurify 无) === false", I.canUseMarkedHtml(markedOnly) === false)
  check("canInjectHtml 同样为 false", I.canInjectHtml(markedOnly) === false)

  /**
   * 模拟 vendor 在无 DOM 环境下的真实形状：`CM.DOMPurify` 是**工厂函数**，
   * 上面根本没有 `.sanitize`。早先直接 `CM.DOMPurify.sanitize(...)` 会 TypeError；
   * 更坏的是如果有人 try/catch 后继续注入，就等于**跳过消毒**。
   */
  const factoryShape = { marked: makeMarked(), DOMPurify: function DOMPurifyStub() { return {} } }
  check("DOMPurify 是工厂函数（无 sanitize）→ canUseMarkedHtml false", I.canUseMarkedHtml(factoryShape) === false)
  /**
   * 用 **setext 标题** 做判别器：marked 会把 `Setext\n===` 变成 `<h1>Setext</h1>`，
   * 而 markdownLite 的正则只认 ATX（`#`），只会给出 `<p>`。因此
   * 「有 <h1>」= 走了 marked（不该发生），「无 <h1> 且有 <p>」= 确实兜底了。
   */
  const SETEXT = "Setext 标题\n===\n\n正文段落"
  const out = I.renderMarkdown(SETEXT, { CM: factoryShape, sid: "s" })
  check("工厂形状下不抛", typeof out === "string" && out.length > 0)
  check("工厂形状下**没有**走 marked（无 <h1>）", !out.includes("<h1>"), out.slice(0, 70))
  check("工厂形状下确实走了 markdownLite 兜底（<p> 在）", out.includes("<p"))
  check("兜底仍保留原文", out.includes("Setext 标题") && out.includes("正文段落"))

  const sanitizeNull = { sanitize: () => null }
  const out2 = I.renderMarkdown(SETEXT, { CM: { marked: makeMarked(), DOMPurify: sanitizeNull }, sid: "s" })
  check("sanitize 返回 null → 也退回兜底（绝不注入）", !out2.includes("<h1>"), out2.slice(0, 60))

  check("sanitizeHtml 无消毒器 → null", I.sanitizeHtml("<b>x</b>", {}) === null)
  check("sanitizeHtml 有消毒器 → 走 sanitize", I.sanitizeHtml("<b>x</b>", { DOMPurify: makeFakePurify() }) === "<b>x</b>")
}

// ── 5. markdownLite 兜底路径仍然不抛（旧行为必须保住） ──
{
  console.log("\n[markdownLite 兜底]")
  const cases = [
    ["标题", "# H1\n\n正文"],
    ["列表", "- a\n- b"],
    ["代码块", "```py\nprint(1)\n```"],
    ["表格", "| a | b |\n|---|---|\n| 1 | 2 |"],
    ["行内公式", "值 $x^2$ 结束"],
    ["引用", "> quote"],
    ["空", ""],
    ["null", null],
    ["怪输入", "\u0000\u0001 <script>alert(1)</script>"],
  ]
  for (const [label, src] of cases) {
    let nodes = null
    let err = null
    try {
      nodes = I.markdownLite(src, null)
    } catch (e) {
      err = e
    }
    check(`markdownLite 不抛：${label}`, !err && Array.isArray(nodes), err ? String(err.message) : `${nodes ? nodes.length : 0} nodes`)
  }
  // 无 marked、无 katex：renderMarkdown 走 mdNodesToHtml(markdownLite(...))
  const fb = I.renderMarkdown("# T\n\n**b** 与 `c`", { CM: null })
  check("无 CM 时 renderMarkdown 仍返回 HTML 字符串", typeof fb === "string" && fb.includes("<p"), fb.slice(0, 70))
  check("兜底 HTML 里的文本被转义（不是裸 HTML 注入）", !I.renderMarkdown("<script>alert(1)</script>", { CM: null }).includes("<script>"))
}

// ── 6. 大 cell 短路（>100KB 显示源码）+ 缓存 ──
{
  console.log("\n[性能护栏]")
  check("shouldRenderRawMd 小文本 false", I.shouldRenderRawMd("x".repeat(1000)) === false)
  check("shouldRenderRawMd >100KB true", I.shouldRenderRawMd("x".repeat(I.MD_RAW_LIMIT + 1)) === true)

  const CM = { marked: makeMarked(), DOMPurify: makeFakePurify() }
  const huge = "# T\n\n" + "y".repeat(I.MD_RAW_LIMIT + 10)
  const out = I.renderMarkdown(huge, { CM, sid: "s" })
  check("超大 md 返回 <pre class=nb2-md-raw>（先显示源码）", out.startsWith('<pre class="nb2-md-raw">'), out.slice(0, 60))
  check("超大 md 不抛", typeof out === "string")

  // 缓存：同 source 同 sid 第二次不应再调 marked.parse
  let parses = 0
  const probeMarked = {
    parse: (s) => {
      parses += 1
      return `<p>${s}</p>`
    },
  }
  I.clearMdCache()
  const cacheCM = { marked: probeMarked, DOMPurify: makeFakePurify() }
  I.renderMarkdown("# a", { CM: cacheCM, sid: "c1" })
  I.renderMarkdown("# a", { CM: cacheCM, sid: "c1" })
  check("同 source 命中缓存（只 parse 一次）", parses === 1, `parse ${parses} 次`)
  I.renderMarkdown("# b", { CM: cacheCM, sid: "c1" })
  check("不同 source 会重新 parse", parses === 2, `parse ${parses} 次`)
  I.clearMdCache()
  I.renderMarkdown("# a", { CM: cacheCM, sid: "c1" })
  check("clearMdCache 之后重新 parse", parses === 3, `parse ${parses} 次`)
}

// ── 7. 渲染容器契约（ dangerouslySetInnerHTML 只出现在 MarkdownView 的消毒分支） ──
{
  console.log("\n[MarkdownView 组件]")
  const CM = { marked: makeMarked(), DOMPurify: makeFakePurify() }
  let tree = null
  try {
    tree = I.MarkdownView({ source: "# T\n\n正文", CM, sid: "s1", cellId: "c1", onEdit: () => {}, onSelect: () => {} })
  } catch (err) {
    check("MarkdownView 不抛", false, String(err && err.message))
  }
  check("MarkdownView 渲染出节点", !!tree)
  check("MarkdownView 用 nb2-md 作用域 class", tree && tree.props && tree.props.className === "nb2-md")
  check("有消毒器时走 dangerouslySetInnerHTML", !!(tree && tree.props && tree.props.dangerouslySetInnerHTML))

  // 无消毒器 → 必须是 h() 子节点（不是 innerHTML）
  const lite = I.MarkdownView({ source: "# T", CM: { marked: makeMarked() }, sid: "s", cellId: "c1" })
  check("无消毒器时不使用 dangerouslySetInnerHTML", !(lite && lite.props && lite.props.dangerouslySetInnerHTML))
  check("无消毒器时用 h() 子节点渲染", !!(lite && lite.children && lite.children.length))

  // 空 source / null 也不能抛
  let okEmpty = false
  try {
    okEmpty = !!I.MarkdownView({ source: "", CM, sid: "s", cellId: "c" })
  } catch {
    okEmpty = false
  }
  check("空 source 不抛", okEmpty)

  /**
   * 四个分支都必须**渲染出内容**（不能有空白分支）：
   *   ① 有富渲染 + 正常   → innerHTML（已消毒）
   *   ② 有富渲染 + 超限   → h() 的 <pre>（短路，不走 marked）
   *   ③ 无富渲染 + 正常   → markdownLite 的 h() 节点
   *   ④ 无富渲染 + 超限   → h() 的 <pre>（也不能白屏）
   */
  const huge = "# T\n\n" + "z".repeat(I.MD_RAW_LIMIT + 5)
  const richCM = { marked: { parse: () => "<h1>x</h1>" }, DOMPurify: { sanitize: (s) => s } }
  const b1 = I.MarkdownView({ source: "# ok", CM: richCM, sid: "s", cellId: "c" })
  const b2 = I.MarkdownView({ source: huge, CM: richCM, sid: "s", cellId: "c" })
  const b3 = I.MarkdownView({ source: "# ok", CM: null, sid: "s", cellId: "c" })
  const b4 = I.MarkdownView({ source: huge, CM: null, sid: "s", cellId: "c" })
  check("① 富渲染+正常 → 走 innerHTML", !!(b1.props && b1.props.dangerouslySetInnerHTML))
  check("② 富渲染+超限 → 用 h() 渲染（不 innerHTML、不走 marked）", !b2.props.dangerouslySetInnerHTML && !!(b2.children && b2.children.length))
  check("② 超限时渲染的是 <pre>", !!(b2.children && b2.children[0] && b2.children[0].type === "pre"))
  check("③ 无富渲染+正常 → 用 h() 渲染", !b3.props.dangerouslySetInnerHTML && !!(b3.children && b3.children.length))
  check("④ 无富渲染+超限 → 也有内容（不白屏）", !b4.props.dangerouslySetInnerHTML && !!(b4.children && b4.children.length))

  /**
   * 交互契约（2026-11-10 用户要求）：markdown 渲染态**双击**才进编辑，单击只选中本格。
   * 直接调 vdom 上的 props，不靠源码正则 —— 正则只能证明代码长这样，证明不了点下去会发生什么。
   */
  {
    let edits = []
    let selects = []
    let stopped = 0
    const md = I.MarkdownView({
      source: "# T\n\n正文",
      CM,
      sid: "s1",
      cellId: "c1",
      onEdit: (info) => edits.push(info || {}),
      onSelect: (id) => selects.push(id),
    })
    const ev = (clientY) => ({
      clientY,
      currentTarget: { getBoundingClientRect: () => ({ top: 0 }) },
      stopPropagation: () => {
        stopped++
      },
    })
    md.props.onClick(ev(30))
    check("单击：不调 onEdit（不进编辑）", edits.length === 0, `edits=${edits.length}`)
    check("单击：选中本格", selects.length === 1 && selects[0] === "c1")
    check("单击：stopPropagation（否则外层容器会 enterEdit）", stopped === 1, `stopped=${stopped}`)
    md.props.onDoubleClick(ev(30))
    check("双击：进编辑", edits.length === 1, `edits=${edits.length}`)
    check("双击：带估算行号（落在双击处，不回文首）", edits.length === 1 && Number(edits[0].line) >= 1, JSON.stringify(edits[0]))
    check("双击：也选中本格", selects.length === 2)
  }
}

// ── 8. md 作用域 CSS：判据都在 ──
{
  console.log("\n[md 样式]")
  const css = I.nb2MdCss
  check("有 nb2-md 作用域", css.includes(".nb2-md"))
  // h1–h6 阶梯字号（旧 markdownLite 是 20-level*2 像素，h6=8px 几乎看不见）
  const sizes = []
  for (let i = 1; i <= 6; i += 1) {
    // 允许 font-size 后面还有别的声明（例如 h6 带了 opacity）
    const m = new RegExp(`\\.nb2-md h${i}\\{font-size:([0-9.]+)em[;}]`).exec(css)
    sizes.push(m ? Number(m[1]) : NaN)
  }
  check("h1–h6 字号全部定义且是 em 阶梯", sizes.every((n) => Number.isFinite(n)), sizes.join(","))
  check("字号严格递减（h1 > h2 > … > h6）", sizes.every((n, i) => i === 0 || n < sizes[i - 1]), sizes.join(">"))
  check("h6 不至于看不见（≥0.9em）", sizes[5] >= 0.9, String(sizes[5]))
  check("表格有边框规则", css.includes(".nb2-md th,.nb2-md td{border:1px solid"))
  check("表格有斑马纹（nth-child(even)）", css.includes("nth-child(even)"))
  check("任务列表去圆点（input[type=checkbox]）", css.includes('input[type="checkbox"]') && css.includes("list-style:none"))
  check("嵌套列表有缩进规则", css.includes(".nb2-md li>ul") && css.includes("padding-left"))
  check("引用块有左边线", css.includes(".nb2-md blockquote") && css.includes("border-left"))
  check("代码块有背景", css.includes(".nb2-md pre{") && css.includes("background:"))
  check("分割线有规则", css.includes(".nb2-md hr"))
  check("图片 max-width:100%", css.includes(".nb2-md img{max-width:100%"))
  check("输出复制按钮 hover 才显形", css.includes(".nb2-out:hover .nb2-out-copy{opacity:1}"))
}

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

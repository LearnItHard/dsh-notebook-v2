/**
 * dsh-notebook-v2 · 大纲 v2 测试（纯 Node，不需要浏览器/DSH）
 *
 * 覆盖 v6 反馈第 6 条「大纲要像 VS Code：md 各级标题 + 函数定义」：
 *   - markdown 标题：ATX + setext，围栏里的 `#` 不算（有 marked 用 lexer，没有用正则）
 *   - Python 符号：`@lezer/python` 真包，FunctionDefinition / ClassDefinition，
 *     名字取**该节点内第一个 VariableName 子节点**，行号按 from 换算，
 *     `async def` 靠节点文本前缀，嵌套靠「父 span 包含子 span」建树
 *   - 语法错误容错（`def broken(:` 也要出符号，且不能整体失败）
 *   - 树结构：heading 按 level 嵌套、symbol 按包含关系嵌套、cell 兜底项
 *
 * 运行：node dsh-notebook-v2/test/outline.mjs
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

/**
 * 构建期依赖：`<profile>/.nb2-build/node_modules`（与 scripts/build-cm-vendor.mjs 同源）。
 * @lezer/python 不在 .nb2-build 里，但在 profile 根 node_modules —— Node 解析会向上找到。
 */
const PROFILE_BUILD = join(
  process.env.USERPROFILE || process.env.HOME || "C:/Users/ASUS",
  ".dsh",
  "profiles",
  "desktop",
  ".nb2-build",
  "package.json",
)
let lezerPython = null
try {
  lezerPython = createRequire(PROFILE_BUILD)("@lezer/python")
} catch (err) {
  console.log(`\n⚠️ 找不到 @lezer/python（${PROFILE_BUILD}）：${String((err && err.message) || err)}\n`)
}

if (!lezerPython || !lezerPython.parser) {
  console.log("跳过：缺乏 @lezer/python 依赖")
  process.exit(2)
}

/** vendor 里的形状：`CM.pythonParser = parser`（一个 Lezer Parser 实例）。 */
const CM = { pythonParser: lezerPython.parser }

console.log("dsh-notebook-v2 · outline v2 tests\n")

// ── 1. Python 符号抽取：函数 / 类 / 嵌套 / async ──
{
  console.log("[Python 符号]")
  const src = [
    "import os",
    "",
    "async def fetch(url):",
    "    return url",
    "",
    "@decorated",
    "class Model(Base):",
    "    def fit(self, X):",
    "        def helper():",
    "            pass",
    "        return helper",
    "",
    "    class Inner:",
    "        pass",
    "",
    "def plain():",
    "    pass",
    "",
  ].join("\n")

  const syms = I.gatherPythonSymbols(src, CM)
  check("抽到顶层符号", syms.length >= 3, `${syms.length} 个顶层`)

  const fetch = syms.find((s) => s.name === "fetch")
  check("async def 被识别", !!fetch && fetch.isAsync === true, fetch ? String(fetch.isAsync) : "未找到 fetch")
  check("async def 的行号正确（第 3 行）", !!fetch && fetch.line === 3, fetch ? `line=${fetch.line}` : "")

  const model = syms.find((s) => s.name === "Model")
  check("class 被识别", !!model && model.symbol === "class", model ? model.symbol : "未找到 Model")
  check("class 行号正确（第 7 行，decorator 不算在 span 里）", !!model && model.line === 7, model ? `line=${model.line}` : "")
  check("同名函数名取自第一个 VariableName（不是 Base 基类）", !!model, model ? model.name : "")

  const fit = model && (model.children || []).find((c) => c.name === "fit")
  check("方法嵌套在 class 下面", !!fit, model ? `children=${(model.children || []).map((c) => c.name).join(",")}` : "无 Model")
  check("方法行号正确（第 8 行）", !!fit && fit.line === 8, fit ? `line=${fit.line}` : "")

  const helper = fit && (fit.children || []).find((c) => c.name === "helper")
  check("函数内嵌套函数变成孙节点", !!helper, fit ? `children=${(fit.children || []).map((c) => c.name).join(",")}` : "无 fit")
  check("嵌套层级 level 递增（1 → 2 → 3）", !!model && model.level === 1 && !!fit && fit.level === 2 && !!helper && helper.level === 3, `${model && model.level},${fit && fit.level},${helper && helper.level}`)

  const inner = model && (model.children || []).find((c) => c.name === "Inner")
  check("class 里嵌套 class", !!inner && inner.symbol === "class", inner ? inner.symbol : "未找到 Inner")

  check("import 这类非定义不产生符号", !syms.some((s) => s.name === "os"))
  check("空源码 → 空数组", I.gatherPythonSymbols("", CM).length === 0 && I.gatherPythonSymbols(null, CM).length === 0)
  check("没有 parser → 空数组（不抛）", I.gatherPythonSymbols("def f(): pass", null).length === 0)
  check("parser 乱来也不抛", I.gatherPythonSymbols("x", { pythonParser: { parse: () => { throw new Error("boom") } } }).length === 0)
}

// ── 2. 语法错误容错 ──
{
  console.log("\n[语法错误容错]")
  const broken = "def broken(:\n    pass\n\ndef ok():\n    pass\n"
  let syms = null
  let err = null
  try {
    syms = I.gatherPythonSymbols(broken, CM)
  } catch (e) {
    err = e
  }
  check("语法错误不抛", !err, err ? String(err.message) : "")
  check("语法错误前的符号仍抽出（broken / ok 之一或全部）", !!syms && syms.length >= 1, syms ? syms.map((s) => s.name).join(",") : "null")
  check("语法错误不影响后续定义", !!syms && syms.some((s) => s.name === "ok"), syms ? syms.map((s) => s.name).join(",") : "")

  // 半个文件都是错的：也不能把整个大纲搞崩
  const garbage = ")))\nclass X:\n  def y(:\n~~~\n"
  let g = null
  try {
    g = I.gatherPythonSymbols(garbage, CM)
  } catch {
    g = null
  }
  check("全垃圾输入不抛且返回数组", Array.isArray(g), g ? `${g.length} 个` : "null")
}

// ── 3. markdown 标题：marked lexer（ATX + setext + 围栏跳过） ──
{
  console.log("\n[md 标题 · 正则兜底]")
  // 没有 CM ⇒ 走 regexHeadings（这是「vendor 没加载完」时的真实路径）
  const src = [
    "# 一级",
    "",
    "正文",
    "",
    "## 二级 `code`",
    "### 三级",
    "",
    "Setext 一级",
    "===========",
    "",
    "Setext 二级",
    "-----------",
    "",
    "```python",
    "# 这是注释不是标题",
    "```",
    "",
    "~~~",
    "# 也不是标题",
    "~~~",
    "",
    "#尾部井号#",
    "",
  ].join("\n")

  const heads = I.gatherHeadings(src, null)
  const texts = heads.map((h) => h.text)
  check("ATX 三级都抽到", ["一级", "二级 code", "三级"].every((t) => texts.includes(t)), texts.join(" | "))
  check("setext `===` 变一级标题", heads.some((h) => h.text === "Setext 一级" && h.level === 1), JSON.stringify(heads.find((h) => h.text === "Setext 一级")))
  check("setext `---` 变二级标题", heads.some((h) => h.text === "Setext 二级" && h.level === 2), JSON.stringify(heads.find((h) => h.text === "Setext 二级")))
  check("``` 围栏里的 # 不算标题", !texts.includes("这是注释不是标题"))
  check("~~~ 围栏里的 # 不算标题", !texts.includes("也不是标题"))
  check("行内 code 记号被去掉（大纲只显示文字）", texts.includes("二级 code"))
  check("行号是 1 基且指向标题行", (heads.find((h) => h.text === "一级") || {}).line === 1, JSON.stringify(heads[0]))
  check("空源码 → 空", I.gatherHeadings("", null).length === 0 && I.gatherHeadings(null, null).length === 0)
}

// ── 4. markdown 标题：有 marked 时走 lexer（同一套断言，另一条路径） ──
{
  console.log("\n[md 标题 · marked lexer]")
  const PROFILE_BUILD_MD = PROFILE_BUILD
  let markedMod = null
  try {
    markedMod = createRequire(PROFILE_BUILD_MD)("marked")
  } catch {
    markedMod = null
  }
  if (!markedMod) {
    check("marked 可用（跳不过就说明构建依赖缺了）", false, "缺少 marked")
  } else {
    const inst = new (markedMod.Marked || markedMod.marked.Marked)()
    const CMmd = { marked: inst }
    const src = "# A\n\nSetext\n===\n\n```\n# no\n```\n\n## B\n"
    const heads = I.gatherHeadings(src, CMmd)
    check("lexer 抽到 ATX + setext（3 个）", heads.length === 3, heads.map((h) => `${h.level}:${h.text}`).join(" | "))
    check("lexer 级别正确 A=1 / Setext=1 / B=2", heads.map((h) => h.level).join(",") === "1,1,2", heads.map((h) => h.level).join(","))
    check("lexer 跳过围栏里的 #", !heads.some((h) => h.text === "no"))
    /**
     * 源码行号（1 基）：
     *   1 `# A` / 2 空 / 3 `Setext` / 4 `===` / 5 空 / 6 ``` / 7 `# no` / 8 ``` / 9 空 / 10 `## B`
     * 围栏里的 `# no` 必须被 marked 吃成 code token（不是 heading），这正是「不写正则」的价值。
     */
    check("lexer 行号正确（A=1 / Setext=3 / B=10）", heads.map((h) => h.line).join(",") === "1,3,10", heads.map((h) => h.line).join(","))
  }
}

// ── 5. buildOutlineV2 的树 ──
{
  console.log("\n[buildOutlineV2 树]")
  const cells = [
    { id: "md1", cellType: "markdown", source: "# 项目\n\n介绍\n\n## 安装\n\ntext" },
    { id: "code1", cellType: "code", source: "import os\n\ndef main():\n    pass\n" },
    { id: "md2", cellType: "markdown", source: "### 细节\n\n正文" },
    { id: "bash1", cellType: "bash", source: "ls -la" },
  ]
  const tree = I.buildOutlineV2(cells, { CM })

  check("顶层返回数组", Array.isArray(tree))
  const project = tree.find((n) => n.text === "项目")
  check("h1 在顶层", !!project && project.kind === "heading" && project.level === 1, JSON.stringify(project && { k: project.kind, l: project.level }))
  const install = project && project.children.find((n) => n.text === "安装")
  check("h2 嵌套在 h1 下", !!install && install.level === 2, project ? project.children.map((c) => `${c.level}:${c.text}`).join(",") : "")
  const main = (() => {
    const walk = (list) => {
      for (const n of list) {
        if (n.text === "def main") return n
        const got = walk(n.children || [])
        if (got) return got
      }
      return null
    }
    return walk(tree)
  })()
  check("Python 函数进树（def main）", !!main, JSON.stringify(tree.map((n) => n.text)))
  check("符号节点带 cellId / line / kind", !!main && main.cellId === "code1" && main.line === 3 && main.kind === "symbol", main ? JSON.stringify({ c: main.cellId, l: main.line, k: main.kind }) : "")
  check("代码符号挂在当前打开的 heading 下（文档大纲语义）", !!install && !!main && install.children.some((c) => c.text === "def main"), install ? install.children.map((c) => c.text).join(",") : "")
  const detail = (() => {
    const walk = (list) => {
      for (const n of list) {
        if (n.text === "细节") return n
        const got = walk(n.children || [])
        if (got) return got
      }
      return null
    }
    return walk(tree)
  })()
  check("h3 出现在后续 md 格里", !!detail && detail.level === 3, detail ? `${detail.level}:${detail.text}` : "未找到")
  /**
   * 标题栈是**跨 cell 延续**的：`## 安装`(h2) 之后、下一个 h3 之前没有更高级标题，
   * 所以 `### 细节` 应该挂在 h2 安装 下面（不是 h1 项目）。
   * 这条钉的是「标题栈不能在换格时重置」—— 重置了的话大纲会长成一堆散落的根节点。
   */
  check("h3 嵌在 h2（安装）下面（跨格子延续标题栈）", !!install && !!detail && install.children.includes(detail), install ? install.children.map((c) => `${c.level}:${c.text}`).join(",") : "")
  /**
   * bash 格没有 Python 符号 → 给 `cell` 兜底项（否则「大半是代码的 notebook」大纲接近空）。
   * 它和其它非标题项一样，挂在**当前打开的标题**下（文档大纲语义），所以要递归找。
   */
  const findNode = (list, pred) => {
    for (const n of list || []) {
      if (pred(n)) return n
      const got = findNode(n.children, pred)
      if (got) return got
    }
    return null
  }
  check(
    "bash 格给 cell 兜底项",
    !!findNode(tree, (n) => n.cellId === "bash1" && n.kind === "cell"),
    JSON.stringify(tree.map((n) => `${n.kind}:${n.text}`)),
  )
  check("每个节点都有 cellId / index / line / children", (() => {
    const walk = (list) =>
      list.every((n) => n.cellId && Number.isInteger(n.index) && Number.isInteger(n.line) && Array.isArray(n.children) && walk(n.children))
    return walk(tree)
  })())

  // 没有 CM 时：md 标题仍能出（正则），代码格退回 cell 兜底
  const noCM = I.buildOutlineV2(cells, { CM: null })
  check("无 CM 时仍有 md 标题", noCM.some((n) => n.text === "项目"))
  check("无 CM 时代码格退回 cell 兜底（不是 symbol）", !noCM.some((n) => n.kind === "symbol"), JSON.stringify(noCM.map((n) => n.kind)))

  check("空 cells → 空树", I.buildOutlineV2([], { CM }).length === 0 && I.buildOutlineV2(null, {}).length === 0)
  check("坏 cell（没 id / null）被跳过不抛", I.buildOutlineV2([null, { cellType: "code", source: "x" }, { id: "ok", cellType: "code", source: "y" }], { CM }).length === 1)
}

// ── 6. 大纲 UI 的行摊平（过滤 + 折叠 + 高亮用的纯函数） ──
{
  console.log("\n[outlineRows 过滤/折叠]")
  const cells = [
    { id: "m", cellType: "markdown", source: "# Alpha\n\n## Beta\n\n### Gamma\n" },
    { id: "c", cellType: "code", source: "def delta():\n    pass\n" },
  ]
  const tree = I.buildOutlineV2(cells, { CM })

  const all = I.outlineRows(tree)
  check("不带过滤 → 全部展开", all.length >= 4, `${all.length} 行`)
  check("depth 从 1 开始", all[0].depth === 1 && all[1].depth === 2, all.map((r) => r.depth).join(","))
  check("每行都有稳定 key", all.every((r) => typeof r.key === "string" && r.key.length > 0))
  check("hasChildren 正确标出", all.some((r) => r.hasChildren) && all.some((r) => !r.hasChildren))

  // 过滤：大小写不敏感，匹配标题/符号名
  const upper = I.outlineRows(tree, { query: "GAMMA" })
  check("过滤大小写不敏感", upper.some((r) => r.node.text === "Gamma"), upper.map((r) => r.node.text).join(","))
  const parents = I.outlineRows(tree, { query: "beta" })
  check("过滤命中子节点时父节点保留（不丢层级）", parents.some((r) => r.node.text === "Alpha") && parents.some((r) => r.node.text === "Beta"), parents.map((r) => r.node.text).join(","))
  const fn = I.outlineRows(tree, { query: "delta" })
  check("按函数名过滤", fn.some((r) => r.node.text === "def delta"), fn.map((r) => r.node.text).join(","))
  const none = I.outlineRows(tree, { query: "zzzzz" })
  check("无命中 → 空（UI 显示「没有匹配」）", none.length === 0, `${none.length} 行`)

  // 折叠：折叠一个父节点后子节点不再出现在可见行里
  const key = I.outlineNodeKey(tree[0], 1)
  const folded = I.outlineRows(tree, { collapsed: { [key]: true } })
  check("折叠后父节点仍在", folded.some((r) => r.key === key))
  check("折叠后子节点被隐藏（行数减少）", folded.length < all.length, `${folded.length} < ${all.length}`)
  check("折叠状态反映在 open=false", folded.find((r) => r.key === key).open === false)
  // 过滤时强制展开：命中子节点不能被折叠状态藏起来
  const foldedFiltered = I.outlineRows(tree, { collapsed: { [key]: true }, query: "gamma" })
  check("过滤时强制展开（否则搜到了也看不见）", foldedFiltered.some((r) => r.node.text === "Gamma"), foldedFiltered.map((r) => r.node.text).join(","))

  check("空树 → 空行", I.outlineRows([], {}).length === 0 && I.outlineRows(null).length === 0)
}

// ── 7. OutlinePanel 组件静态可用（过滤框必须真的渲染出来） ──
{
  console.log("\n[OutlinePanel 组件]")
  const cells = [{ id: "m", cellType: "markdown", source: "# T\n\n## S" }]
  const tree = I.buildOutlineV2(cells, { CM })
  let panel = null
  try {
    panel = I.OutlinePanel({ tree, selectedCellId: "m", onJump: () => {} })
  } catch (err) {
    check("OutlinePanel 不抛", false, String(err && err.message))
  }
  check("OutlinePanel 渲染", !!panel)
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
  const text = flat(panel).join(" | ")
  check("有过滤框（placeholder 可见）", text.includes("过滤标题"), text.slice(0, 80))
  check("树节点文字被渲染（T / S）", text.includes("T") && text.includes("S"), text.slice(0, 120))
  check("空树时不抛且给出提示", (() => {
    try {
      const t = flat(I.OutlinePanel({ tree: [], onJump: () => {} })).join(" | ")
      return t.includes("还没有")
    } catch {
      return false
    }
  })())
}

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

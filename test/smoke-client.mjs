/**
 * dsh-notebook-v2 · 客户端半冒烟测试
 *
 * 客户端半边在 DSH 里由 `dsh-client-modules` 编进 boot graph，靠
 * `window.__ModuleLoader__.load({id, factory})` 注册、`require('react')` 拿外部依赖。
 * 这里在 node 里把这个壳子仿出来，验的是**注册契约**（不是渲染结果）：
 *   - 行 id 必须等于包名
 *   - 导出 { name, inject, apply }，inject 用**静态数组**（门面不提供 ctx.inject）
 *   - apply(ctx) 里两阶段注册：sidebarRightTabs.register（tab 类型）+ slots.register（tab 内容）
 *   - 两处 disposer 都在 ctx.effect 内触发（热重载不留僵尸 tab）
 *
 * 运行：node dsh-notebook-v2/test/smoke-client.mjs
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

// ── 仿 DSH 客户端壳：__ModuleLoader__ + 静态模块表（这里只有 react） ──
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
}

/** 只实现注册阶段用得到的部分；渲染不在本测试范围内。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: "Fragment",
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  // 组件体里用到了 useLayoutEffect（滚动锚定），stub 必须也有，否则一渲染就抛
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

check("调用了 window.__ModuleLoader__.load", loaded !== null)
check("行 id 等于包名", loaded && loaded.id === PKG, loaded && loaded.id)

const mod = loaded.factory(requireStub)
check("导出 name 等于包名", mod.name === PKG, mod.name)
check("导出 apply 函数", typeof mod.apply === "function")

// 静态 inject：门面（dsh-cordis-client-runner 的 dynamicCordisContext）只放行声明过的服务。
check("inject 是数组（静态声明）", Array.isArray(mod.inject), JSON.stringify(mod.inject))
check("声明了 slots", mod.inject.includes("slots"))
check("声明了 sidebarRightTabs", mod.inject.includes("sidebarRightTabs"))

// ── 仿客户端门面 ctx ──
const calls = { types: [], bodies: [], effects: 0 }
const ctx = {
  effect(fn) {
    calls.effects += 1
    return fn()
  },
  sidebarRightTabs: {
    register(def) {
      calls.types.push(def)
      return () => {
        calls.types.push({ disposed: def.id })
      }
    },
  },
  slots: {
    register(options, component) {
      calls.bodies.push({ options, component })
      return () => {
        calls.bodies.push({ disposed: options.key })
      }
    },
  },
}

mod.apply(ctx)

const type = calls.types[0]
check("注册了 tab 类型（sidebarRightTabs.register）", !!type && typeof type === "object", JSON.stringify(type && { id: type.id, kind: type.kind }))
check("类型 id / kind 等于包名（跨包唯一）", type && type.id === PKG && type.kind === PKG)
check("title() 返回标签名", type && typeof type.title === "function" && type.title() === "Notebook (v2)", type && String(type.title()))
check("贡献了 guide 卡片（右栏引导页可点开）", type && Array.isArray(type.guide) && type.guide.length === 1)

const body = calls.bodies[0]
check("注册了 tab 内容（slots.register）", !!body, body && JSON.stringify(body.options))
check("slot 名是 sidebar.right.pane.tab", body && body.options.name === "sidebar.right.pane.tab")
check("key 等于类型 id（README 要求）", body && body.options.key === type.id)
check("内容是函数组件", body && typeof body.component === "function")

check("注册都包在 ctx.effect 里（热重载安全）", calls.effects === 1, `effects=${calls.effects}`)

// 面板组件本身能被调用一次（不渲染、只保证不抛）—— 传最小 props。
let tree = null
try {
  tree = body.component({ sessionId: "s-test" })
  check("面板组件首次调用不抛（hooks 由 React 提供，这里只验签名）", true)
} catch (err) {
  check("面板组件首次调用不抛", false, String(err && err.message))
}

/**
 * 静态树断言：把渲染出来的元素树摊平，检查「关键按钮确实被渲染了」。
 *
 * 为什么值这个钱：用户在真机上反馈过「打开/新建点了没反应」，也有过整块 UI 不出现。
 * 只验「不抛」抓不到「按钮根本没渲染」—— 这里直接找文本。
 */
function collectText(node, acc = []) {
  if (node == null || typeof node === "boolean") return acc
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node))
    return acc
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, acc)
    return acc
  }
  if (typeof node === "object") {
    if (node.children) collectText(node.children, acc)
    if (node.props && node.props.children) collectText(node.props.children, acc)
  }
  return acc
}

const joined = collectText(tree).join(" | ")
check("渲染出工具栏（保存 / 另存为）", joined.includes("保存") && joined.includes("另存为"), joined.slice(0, 60))
check("渲染出运行/内核按钮", joined.includes("运行全部") && joined.includes("中断") && joined.includes("重启"))
check("渲染出三种新增按钮（代码 / MD / SH）", joined.includes("＋ 代码") && joined.includes("＋ MD") && joined.includes("＋ SH"))
check("渲染出大纲开关（≡ 大纲）", joined.includes("≡ 大纲"))
check("渲染出 AI 补全开关", joined.includes("AI 补全"))
check("渲染出打开/新建（不再用 window.prompt）", joined.includes("＋打开") && joined.includes("＋新建"))

// ── 工具栏分组 + ⋯ 溢出（P1 5.2：11 个按钮收成 3 组 + 溢出）──
check("工具栏有 ⋯ 溢出按钮", joined.includes("⋯"), joined.slice(0, 120))
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  // 定义 1 次 + 使用 2 次 = 3 处 ⇒ 3 组之间 2 条分隔线
  const sep = (src.match(/toolbarGroupSep/g) || []).length
  check("工具栏分成 3 组（toolbarGroupSep 定义 + 2 处分隔）", sep >= 3, `${sep} 处`)
}

// ── 空态两个大按钮（P0 5.4）──
{
  // 默认 state.cells 为空（useNotebook 的 EMPTY_STATE）→ 空态分支应该渲染
  const text = collectText(tree).join(" | ")
  check("空态有两个大按钮（代码 / Markdown）", text.includes("＋ 代码单元格") && text.includes("＋ Markdown 单元格"), text.slice(0, 160))
  check("内核 unknown 给了可读解释（P1 5.8）", text.includes("内核未启动"), "")
}

/**
 * ── v6 新增组件的静态树断言 ──
 *
 * 为什么不能从 App 树里断言：
 *  · `outlineOpen` / `pickerOpen` 默认 false（React.useState 在桩里恒为初始值），
 *    App 树里根本不会渲染 picker / 大纲面板；
 *  · ReactStub 的 useState 是无状态的、useEffect 是空实现，键盘/聚焦测不了（那是纯函数的事）。
 * 所以组件一律从 __internals 取出、直接带 props 调一次，断文案与结构。
 */
function flatText(node, acc = []) {
  if (node == null || typeof node === "boolean") return acc
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node))
    return acc
  }
  if (Array.isArray(node)) {
    for (const n of node) flatText(n, acc)
    return acc
  }
  if (typeof node === "object") {
    if (node.props) {
      if (node.props.placeholder) acc.push(String(node.props.placeholder))
      if (node.props.title) acc.push(String(node.props.title))
      if (node.props.children !== undefined) flatText(node.props.children, acc)
    }
    if (node.children) flatText(node.children, acc)
  }
  return acc
}

{
  console.log("\n[v6 新组件静态树]")
  const I2 = mod.__internals

  // 1. 格间新增热区：＋ 代码 / ＋ 文本
  const divider = I2.CellDivider({ position: "between", onAdd: () => {} })
  const dText = flatText(divider).join(" | ")
  check("存在「＋ 代码」热区按钮", dText.includes("＋ 代码"), dText)
  check("存在「＋ 文本」热区按钮", dText.includes("＋ 文本"), dText)
  check("热区带 data-nb2-divider 标记（定位/测试用）", !!(divider && divider.props && divider.props["data-nb2-divider"]))
  check("热区有 opacity 控制（hover 才显形）", /opacity/.test(JSON.stringify(divider && divider.props && divider.props.style)))
  const endDivider = I2.CellDivider({ position: "end", dim: true, onAdd: () => {} })
  check("列表末尾热区（position=end）常显但低对比", !!(endDivider && endDivider.props && endDivider.props["data-nb2-divider"] === "end"))

  // 2. NotebookPicker：列表 + ↑↓ Enter + 手输兜底
  const picker = I2.NotebookPicker({ sid: "s", onOpen: () => {}, onClose: () => {}, onManual: () => {} })
  const pText = flatText(picker).join(" | ")
  check("picker 渲染（打开 Notebook）", pText.includes("打开 Notebook"), pText.slice(0, 90))
  check("picker 有搜索框", pText.includes("搜索 notebook"))
  check("picker 有「手输绝对路径…」兜底", pText.includes("手输绝对路径"))
  check("picker 提示 ↑↓ / Enter / Esc", pText.includes("↑↓ 选择") && pText.includes("Enter 打开") && pText.includes("Esc 关闭"))
  check("picker 有上级目录按钮", pText.includes("↑ 上级"))
  check("picker 显示当前目录（📁）", pText.includes("📁"))

  // 3. 大纲：过滤框 + 折叠箭头 + 标题层级
  const outlinePanel = I2.OutlinePanel({
    tree: I2.buildOutlineV2([{ id: "c1", cellType: "markdown", source: "# 标题\n\n## 子标题" }], { CM: null }),
    selectedCellId: "c1",
    onJump: () => {},
  })
  const oText = flatText(outlinePanel).join(" | ")
  check("大纲有过滤框", oText.includes("过滤标题"), oText.slice(0, 80))
  check("大纲显示标题层级文字", oText.includes("标题") && oText.includes("子标题"), oText.slice(0, 120))
  check("大纲有折叠箭头（▾ 表示有子节点且展开）", oText.includes("▾"), oText.slice(0, 120))

  // 4. MarkdownView：nb2-md 作用域
  const md = I2.MarkdownView({ source: "# T\n\n正文", CM: null, sid: "s", cellId: "c1", onEdit: () => {} })
  check("MarkdownView 用 nb2-md 作用域 class", !!(md && md.props && md.props.className === "nb2-md"))
}

// ── md 作用域样式 + KaTeX 样式表注入 ──
{
  const I3 = mod.__internals
  const css = I3.nb2MdCss
  check("存在 nb2-md 样式表", typeof css === "string" && css.includes(".nb2-md"))
  check(
    "h1–h6 阶梯字号都在（h6 ≥ .9em，不再是 8px）",
    /\.nb2-md h1\{font-size:1\.6em/.test(css) && /\.nb2-md h6\{font-size:\.92em/.test(css),
  )
  check(
    "表格 / 任务列表 / 引用块 / 分割线 / 图片样式齐全",
    [".nb2-md table", 'input[type="checkbox"]', ".nb2-md blockquote", ".nb2-md hr", ".nb2-md img{max-width:100%"].every((k) => css.includes(k)),
  )
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  check("KaTeX CSS 由 <link href=/nb2/katex.css> 注入一次", src.includes('link.href = "/nb2/katex.css"') || src.includes('"nb2-katex-css"'))
  check("md 样式与 KaTeX 样式都只注入一次（id 幂等）", src.includes('"nb2-md-style"') && src.includes('"nb2-katex-css"'))
}

// ── 面板键盘/聚焦/复制的接线（v6 第 3/4 条 + P1）──
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  // 注释里为了解释这个坑会**引用**旧代码，所以查这些必须剥注释
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  check("面板根节点用 onKeyDownCapture（不是冒泡 onKeyDown）", code.includes("onKeyDownCapture: onPanelKeyDownCapture"))
  // addCell 默认聚焦；只有显式 `focus:false` 才「选中不进编辑」（Shift-Enter 补末格时用）
  check("新增格默认聚焦（addCell 里调 focusCell）", /else focusCell\(newId\)/.test(code))
  check("addCell 支持 focus:false（只选中不进编辑）", /if \(o\.focus === false\) setSelected\(newId\)/.test(code))
  check("CellView 收到 focusReq", code.includes("focusReq: focusReq && focusReq.cellId"))
  // 注释可能夹在中间（剥注释后会留下空行），所以用宽松的跨行匹配
  // 多选后 selected 变成 isCellSelected(cell.id)（锚点 + extraSelected 都算选中）
  check("CellView 收到 sid（图片改写要 sid）", /\bsid,\s*(\n\s*)*selected: isCellSelected\(cell\.id\)/.test(code))
  check("CellView 的选中态走多选判定", code.includes("selected: isCellSelected(cell.id)"))
  check("输出块有复制按钮（nb2-out-copy）", code.includes("nb2-out-copy"))
  check("cm-scroller 不再写死 maxHeight（双滚动条）", !code.includes('maxHeight: "60vh"'))
  check("Shift-Enter 走 runBelow（跑完聚焦下一格 / 最后一格补格）", /onRunBelow: \(\) => runBelow\(cell\.id\)/.test(code))
  check("没有 window.prompt/confirm/alert", !/window\.(prompt|confirm|alert)\s*\(/.test(code))
}

// ── 单元格级 UI：✨ AI / 💬 入口必须真的被渲染（用户反馈「连一个可见的 AI 入口都没有」）──
let cellTree = null
try {
  cellTree = mod.__internals.CellView({
    cell: { id: "c1", cellType: "code", source: "x = 1", status: "ok", outputs: [] },
    index: 0,
    total: 1,
    CM: null,
    selected: true,
    ai: null,
    aiHandlers: { open: () => {}, fix: () => {}, bar: () => ({}) },
    ghost: null,
    onChange: () => {},
    onChangeType: () => {},
    onRun: () => {},
    onRunBelow: () => {},
    onRunInsert: () => {},
    onSave: () => {},
    onAddAfter: () => {},
    onDelete: () => {},
    onMove: () => {},
    onSelect: () => {},
    onSelectSibling: () => {},
    onCiteCell: () => {},
    onCiteSelection: () => {},
    onSelectionChange: () => {},
    onEditorReady: () => {},
  })
  check("CellView 不抛", !!cellTree)
} catch (err) {
  check("CellView 不抛", false, String(err && err.message))
}
const cellText = collectText(cellTree).join(" | ")
check("单元格工具栏有可见的 ✨ AI 入口（Mod-K 不再隐形）", cellText.includes("✨ AI"), cellText.slice(0, 90))
check("单元格工具栏有 💬 引用到对话", cellText.includes("💬"), cellText.slice(0, 90))

// ── 报错块的两个一键动作（AI 快修 / 发给 Agent）──
let errTree = null
try {
  errTree = mod.__internals.OutputBlockView({
    block: { kind: "error", ename: "ValueError", evalue: "boom", traceback: ["tb line"] },
    CM: null,
    onFixError: () => {},
    onCiteError: () => {},
  })
  check("OutputBlockView（error）不抛", !!errTree)
} catch (err) {
  check("OutputBlockView（error）不抛", false, String(err && err.message))
}
const errText = collectText(errTree).join(" | ")
check("报错块有「🔧 AI 快速修复」", errText.includes("AI 快速修复"), errText.slice(0, 90))
check("报错块有「💬 发给 Agent」", errText.includes("发给 Agent"), errText.slice(0, 90))

/**
 * 关键回归：客户端里**不能**再出现 window.prompt / window.confirm / window.alert。
 * Electron 禁用了它们，调用即抛 —— 之前的「打开/新建无响应」正是这个。
 */
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  // 去掉注释再查，避免把「解释这个坑」的注释当成违规
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  check("没有 window.prompt（Electron 禁用）", !/window\.prompt\s*\(/.test(code))
  check("没有 window.confirm（Electron 禁用）", !/window\.confirm\s*\(/.test(code))
  check("没有 window.alert（Electron 禁用）", !/window\.alert\s*\(/.test(code))
}

/**
 * 关键回归：AI 补全的 Tab 绑定必须和 indentWithTab 在**同一个** keymap 数组里且排在前面。
 *
 * 为什么值一条测试：早先版本把 ghost 的 keymap 作为独立扩展追加在扩展数组末尾，
 * 结果 Tab 被 `CM.indentWithTab` 抢先插了缩进 —— 补全永远接受不了，而且**不报错**，
 * 只有真机敲 Tab 才能发现。这条断言把「顺序」钉死。
 */
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  // 先剥注释：我的警告注释里也写了 `...CM.defaultKeymap`，不剥会误判位置
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const cm = /CM\.keymap\.of\(\[([\s\S]*?)\]\)/.exec(code)
  check("找到 buildExtensions 里的 keymap 数组", !!cm)
  if (cm) {
    const body = cm[1]
    const tabAt = body.indexOf('key: "Tab"')
    const indentAt = body.indexOf("CM.indentWithTab")
    const defaultAt = body.indexOf("...CM.defaultKeymap")
    check("Tab 绑定存在于主 keymap 里", tabAt >= 0, `tabAt=${tabAt}`)
    check("Tab 排在 indentWithTab 之前（否则接受不了建议）", tabAt >= 0 && indentAt > tabAt, `tab=${tabAt} indent=${indentAt}`)
    check("Tab 排在 defaultKeymap 之前", tabAt >= 0 && defaultAt > tabAt, `tab=${tabAt} default=${defaultAt}`)
  }
  // ghost 扩展自己不该再注册 keymap（否则又回到「跨扩展抢键」的老路）
  const ghost = /function buildGhostExtension[\s\S]*?\n    \}/.exec(code)
  check("ghost 扩展内部不再注册 keymap", !!ghost && !/CM\.keymap\.of/.test(ghost[0]))
}

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
// ── R6：单元格右键上下文菜单 ──
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  check("有 CellContextMenu 组件（portal 浮层）", code.includes("function CellContextMenu(") && code.includes("createPortal(el, document.body)"))
  check("CellView 根节点绑了 onContextMenu", code.includes("onContextMenu: (e) => {"))
  check("右键会 preventDefault（不弹浏览器菜单）", /onContextMenu: \(e\) => \{\s*\n\s*e\.preventDefault\(\)/.test(code))
  check("菜单项：在上方/下方插入", code.includes("在上方插入代码") && code.includes("在下方插入代码"))
  check("菜单项：切类型（Y/M/R）", code.includes("转为代码") && code.includes("转为 Markdown") && code.includes("转为 Raw"))
  check("菜单项：清空本格输出（走 cell/clearOutputs 路由）", code.includes("清空本格输出") && code.includes('"cell/clearOutputs"'))
  check("菜单项：复制源码 / 添加到对话 / AI 改写 / 删除", code.includes("复制源码") && code.includes("💬 添加到对话") && code.includes("✨ AI 改写本格") && code.includes("删除本格"))
  check("菜单项标了等价快捷键（发现性）", code.includes('hint: "A"') && code.includes('hint: "D D"'))
  check("菜单会在列表滚动时收掉（不留幽灵浮层）", code.includes("if (ctxMenuRef.current) closeCtxMenuRef.current()"))
  check("菜单销毁契约：Esc / 外部点击 / 失焦", /document\.addEventListener\("keydown", onKey, true\)/.test(code) && /window\.addEventListener\("blur", onDismiss\)/.test(code))
}
// ── R7：大纲可停靠左/右（用户要求「在最左侧或右侧，可以选择」）──
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  check("有 OutlineDockPanel 组件（停靠侧栏，side 参数）", code.includes("function OutlineDockPanel(") && code.includes('side === "left"'))
  check("停靠三态：off / left / right", code.includes('prev === "off" ? "left" : prev === "left" ? "right" : "off"'))
  check("位置跨会话记住（localStorage）", code.includes("nb2.outlineDock.v1") && code.includes("saveOutlineDock(next)"))
  check("列表被包进横向容器（大纲在左/右）", code.includes('flexDirection: "row"') && code.includes('outlineDock === "left"'))
  check("右侧停靠也渲染", code.includes('outlineDock === "right"'))
  check("旧的顶部浮层大纲已移除（不再有 34vh 大纲块）", !/maxHeight: "34vh",\s*\n\s*display: "flex",\s*\n\s*flexDirection: "column"/.test(code))
  check("工具栏按钮走 cycleOutlineDock", code.includes("onClick: cycleOutlineDock"))
}
// ── AI 自动补全 P0（据开源调研：Continue / Tabby / JupyterLab / VS Code）──
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const aiSrc = readFileSync(new URL("../lib/ai.js", import.meta.url), "utf8")
  const indexSrc = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8")

  // P0-1 在途取消：新键入立刻 abort 上一个请求（否则旧请求跑完才被丢弃，白烧 token）
  check("新键入会 abort 在途补全请求", /if \(inflight && typeof inflight\.abort === "function"\)/.test(code) && code.includes("inflight.abort()"))
  // P0-2 前缀缓存
  check("补全建议有前缀缓存（LRU）", code.includes("GHOST_CACHE_LIMIT") && code.includes("const cacheGet") && code.includes("const cacheSet"))
  check("缓存命中时直接出幽灵文本（不再发请求）", /const cached = cacheGet\(at, doc\)/.test(code))
  // P0-2' 最长前缀匹配（v2：继续打字也能复用，不只是退格再打回来）
  check("缓存查找走最长前缀匹配（matchGhostCache）", code.includes("matchGhostCache(cache.values()"))
  check("缓存条目存 pos/doc/suggestion（能算前缀增量）", /cache\.set\(key, \{ key, pos, doc, suggestion: value \}\)/.test(code))
  // P0-3 按词接受（原为死代码）
  check("acceptWord 已接线：Ctrl-→", code.includes('"Ctrl-ArrowRight"') && code.includes("onGhostWord"))
  check("acceptWord 还有 Alt-f 别名", code.includes('"Alt-f"'))
  check("CellEditor 把 onGhostWord 接到 ghostApi.acceptWord", code.includes("ghostApiRef.current.acceptWord(view)"))
  // P0-4 按行接受（VS Code acceptNextLine）
  check("acceptLine 已接线：Alt-]", code.includes('"Alt-]"') && code.includes("onGhostLine"))
  check("acceptLine 还有 Ctrl-End 别名", code.includes('"Ctrl-End"'))
  check("CellEditor 把 onGhostLine 接到 ghostApi.acceptLine", code.includes("ghostApiRef.current.acceptLine(view)"))
  check("分级接受剩下的建议不被 docChanged 丢掉（effect 先于 docChanged）", /for \(const e of tr\.effects\) \{[\s\S]{0,200}?if \(e\.is\(setGhost\)\) return e\.value[\s\S]{0,300}?if \(tr\.docChanged\)/.test(code))
  // P0-14 输出预算（提示词 6 行 + maxTokens + stop）
  check("ghost 提示词写了至多 6 行", aiSrc.includes("at most 6 lines"))
  check("宿主 ghost 路由带 maxTokens 预算", indexSrc.includes("Number(body.maxTokens) || 150"))
  check("宿主 ghost 路由带 stop 序列", indexSrc.includes('["\\n\\n\\n", "\\n#", "\\n%%"]'))
  check("宿主把 maxTokens/stop 交给 stream（降级重试）", aiSrc.includes("outputBudget(req)") && aiSrc.includes("if (withBudget === streamOpts || text) throw err"))
  // P0-5 内核变量进补全
  check("补全请求带上内核变量", code.includes("vars: varsForGhost") && code.includes("await loadVars()"))
  check("补全提示词有内核变量块（ai.js ghost 分支）", aiSrc.includes("Live kernel variables (name: type — detail)") && aiSrc.includes("varsBlock"))
  check("宿主 /nb2/ai/complete 透传 vars", indexSrc.includes("vars: varsList") && indexSrc.includes("const varsList = Array.isArray(body.vars)"))
}
// ── AI 补全 v2（批次 B：#8 上下文预算 / #6 打分过滤器 / #13 设置项）──
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const indexSrc = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8")
  // #8 跨格上下文 v2
  check("跨格上下文改预算制（不再固定前 3 格）", code.includes("buildGhostContext(state.cells, localIdx)") && !code.includes("before.length < 3"))
  check("markdown 格折成意图注释进上下文", code.includes("markdownIntent(src)"))
  check("宿主上下文上限放宽到 12（预算由客户端裁）", indexSrc.includes("body.context.slice(0, 12)"))
  check("debug 回显真正拼出来的提示词（验收：markdown 意图可在后端核对）", indexSrc.includes("messages: buildMessages(reqForAi)"))
  // #6 打分制过滤器
  check("触发判据改打分制（completionScore + 阈值投影）", code.includes("function completionScore(") && code.includes("return completionScore(opts) >= threshold"))
  check("Esc 拒绝后降权（rejectedAt → rejectAt）", code.includes("rejectedAt = Date.now()") && code.includes("rejectAt: rejectedAt"))
  // #13 设置项
  check("防抖时长现读设置（getOptions，改设置不重建编辑器）", code.includes("getOptions: () =>") && code.includes("Number(liveOpts.debounceMs)"))
  check("建议按 maxLines 截断", code.includes("truncateLines(suggestion, compPref.maxLines)"))
  check("设置面板有补全参数两个输入框", code.includes('commitCompNumber("debounceMs")') && code.includes('commitCompNumber("maxLines")'))
  // #11 增量收缩
  check("打字时幽灵原地后退（shrinkGhost + iterChanges）", code.includes("shrinkGhost(value, inserted, at)") && code.includes("tr.changes.iterChanges("))
}
// ── 命令注册表接线完整性（防「加了快捷键没接命令」/ 死代码）──
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(CLIENT, "utf8")
  const cmdBlock = /const COMMANDS = \{([\s\S]*?)\n    \}/.exec(src)
  const handlerBlock = /commandsRef\.current = \{([\s\S]*?)\n      \}/.exec(src)
  check("找到 COMMANDS 表", !!cmdBlock)
  check("找到命令执行表（commandsRef.current）", !!handlerBlock)
  if (cmdBlock && handlerBlock) {
    const ids = [...cmdBlock[1].matchAll(/"([a-zA-Z.]+)":/g)].map((m) => m[1])
    const handled = [...handlerBlock[1].matchAll(/"([a-zA-Z.]+)":/g)].map((m) => m[1])
    /**
     * 编辑器内部命令（Tab / Ctrl-→ / Alt-\ / Mod-K）由 CM6 keymap 持有，
     * 面板执行表里没有它们是**设计如此**（需要 view 级 API）。
     */
    const EDITOR_ONLY = ["ghost.accept", "ghost.acceptWord", "ghost.acceptLine", "ghost.force", "ai.inline"]
    const missing = ids.filter((id) => !handled.includes(id) && !EDITOR_ONLY.includes(id))
    check("每个面板命令都有执行体（无死代码）", missing.length === 0, missing.join(","))
    check("编辑器内部命令单独登记且不重复", EDITOR_ONLY.every((id) => ids.includes(id)))
  }
  // 分发器只认命令 id（不许再出现旧的动作字符串分支）
  check("分发器走命令表（commandsRef.current[cmd.command]）", src.includes("commandsRef.current[cmd.command]"))
  check("不再有 cmd.action 分支（已迁移到命令表）", !src.includes("cmd.action"))
  // 右键菜单由命令 id 驱动
  check("右键菜单由命令 id 驱动（item(\"cell.xxx\")）", /item\("cell\.insertAbove"/.test(src) && src.includes('item("cell.delete")'))
}
process.exit(failures.length === 0 ? 0 : 1)

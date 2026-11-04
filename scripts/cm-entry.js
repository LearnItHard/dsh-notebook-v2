// dsh-notebook-v2 的 CodeMirror 6 vendor 入口。
// 由 build-cm-vendor.mjs 打进 lib/cm-vendor.js（IIFE，全局名 CM），
// 客户端用 <script src="/nb2/vendor.js"> 加载后从 window.CM 取。
//
// 只导出我们用得到的符号 —— 每多导一个就多几百字节，而这是启动路径上的字节。

export { EditorState, Compartment, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state"

export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder,
  Decoration,
  ViewPlugin,
  WidgetType,
  gutter,
  GutterMarker,
} from "@codemirror/view"

export { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"

export {
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  HighlightStyle,
} from "@codemirror/language"

export { python } from "@codemirror/lang-python"
export { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete"
export { searchKeymap, highlightSelectionMatches, search, openSearchPanel } from "@codemirror/search"
export { oneDark } from "@codemirror/theme-one-dark"

// tags 供自定义 HighlightStyle 用（默认高亮是浅色写死的，深色主题下会看不清）。
// 注意：@codemirror/language 1.x 的这个版本**不再**重导出 tags，必须从 @lezer/highlight 取。
export { tags } from "@lezer/highlight"

// ── Markdown / 消毒 / Python 语法树（客户端半的 md 渲染与大纲用）──
// 这三个包不在宿主的「客户端可 require 模块表」里，只能在构建期打进 vendor：
//   CM.marked       已 use 过 KaTeX 扩展的实例 —— 直接 .parse(src) 就同时得到
//                   GFM（表格/任务列表/嵌套列表）与 $…$ 公式，客户端不必再配一遍
//                   （每个面板各 use() 一次会重复注册扩展）
//   CM.DOMPurify    消毒器，渲染前必须过它（markdown 允许内联 HTML）
//   CM.pythonParser @lezer/python 的语法树 —— 大纲里的函数/类定义靠它，比正则准
import { marked } from "marked"
import markedKatexExtension from "marked-katex-extension"
import createDOMPurify from "dompurify"

marked.use(markedKatexExtension({ throwOnError: false, nonStandard: true }))

// dompurify 的 default 在不同构建里可能是**实例**（浏览器版自初始化）也可能是**工厂**。
// 两种都接住：客户端只用 CM.DOMPurify.sanitize，不该在运行时才发现它是个函数。
const DOMPurify =
  typeof createDOMPurify.sanitize === "function"
    ? createDOMPurify
    : createDOMPurify(typeof window !== "undefined" ? window : undefined)

export { marked, DOMPurify }
export { parser as pythonParser } from "@lezer/python"
// katex 本体早已在（公式渲染）；这里固定导出，不再由构建脚本条件追加 ——
// 「缺依赖就静默跳过」正是上一轮「公式有 JS 没 CSS」的来源。
export { default as katex } from "katex"


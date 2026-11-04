/**
 * 打 lib/cm-vendor.js（CodeMirror 6 + Markdown + KaTeX 的 IIFE 包，全局名 CM），
 * 并生成 lib/katex/（公式用的 CSS + 字体）。
 *
 * 为什么要打包：DSH 客户端插件只能用 `require` 拿 shell 静态模块表里的东西（react 等），
 * @codemirror/* / marked / dompurify / katex 都不在表里；而它们是一堆互相 import 的
 * ESM 小包，浏览器里没法直接铺开。
 * 现成先例：@beihaizb/dsh-notebook 也是 esbuild 打一个 cm-vendor.js（400KB）。
 *
 * 为什么在 profile 目录里打：依赖（@codemirror/* 等）只装在 profile 的 node_modules 里，
 * 仓库里没有。esbuild 从 profile 内的临时目录解析，天然能找到它。
 *
 * 用法：node dsh-notebook-v2/scripts/build-cm-vendor.mjs
 * 产物：
 *   dsh-notebook-v2/lib/cm-vendor.js        （提交进仓库，用户无需构建）
 *   dsh-notebook-v2/lib/katex/katex.css     （只留 woff2 的改写版）
 *   dsh-notebook-v2/lib/katex/fonts/*.woff2 （20 个，约 254KB）
 */

import { mkdir, copyFile, stat, readFile, readdir, writeFile, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, "..")

// ⚠️ 别用 DSH_PROFILE 当默认值：DSH 自己把它设成**档案名**（"desktop"），不是路径。
// 正确顺序：--profile 参数 → DSH_PROFILE_DIR（绝对路径，DSH 自己给的）→ ~/.dsh/profiles/<name>。
const argv = process.argv.slice(2)
const profileArg = argv.indexOf("--profile") >= 0 ? argv[argv.indexOf("--profile") + 1] : null
const PROFILE =
  profileArg ||
  process.env.DSH_PROFILE_DIR ||
  join(homedir(), ".dsh", "profiles", process.env.DSH_PROFILE || "desktop")
const BUILD_DIR = join(PROFILE, ".nb2-build")
const OUT = join(PKG_DIR, "lib", "cm-vendor.js")
const KATEX_OUT = join(PKG_DIR, "lib", "katex")
const META_PATH = join(BUILD_DIR, "cm-vendor-meta.json")

/**
 * 构建期依赖清单。**缺任何一个都硬失败**。
 *
 * 上一轮的教训：katex 是「有就并进去、没有就静默跳过」，产物里因此只有公式 JS
 * 没有公式 CSS，真机上的表现是「公式错版」而不是报错 —— 谁也没发现。
 * 半成品比构建失败危险得多，所以这里宁可吵。
 *
 * 两份 node_modules 都认：`.nb2-build` 里显式装的最优先，profile 里随插件带来的兜底
 * （esbuild 从 BUILD_DIR 往上找就是这两层）。
 */
const REQUIRED_PKGS = [
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lang-python",
  "@codemirror/autocomplete",
  "@codemirror/search",
  "@codemirror/theme-one-dark",
  "@lezer/highlight",
  "marked",
  "dompurify",
  "marked-katex-extension",
  "katex",
]

/**
 * 只能由 profile 提供的**传递依赖**。
 *
 * ⚠️ 千万不要把 @lezer/python 装进 `.nb2-build`：@codemirror/lang-python 已经在
 * profile 里依赖它，再装一份会让 vendor 里出现**两个 lezer 运行时**
 * （语法树节点的 instanceof 会互相不认，体积还翻倍）。缺了只可能是 profile 装坏了。
 */
const TRANSITIVE_ONLY = ["@lezer/python"]

/** 依赖实际落在哪：.nb2-build 优先，再退 profile/node_modules。 */
function resolvePkgDir(pkg) {
  for (const base of [join(BUILD_DIR, "node_modules"), join(PROFILE, "node_modules")]) {
    const dir = join(base, pkg)
    if (existsSync(dir)) return dir
  }
  return null
}

const missing = REQUIRED_PKGS.filter((pkg) => !resolvePkgDir(pkg))
const missingTransitive = TRANSITIVE_ONLY.filter((pkg) => !resolvePkgDir(pkg))
if (missing.length || missingTransitive.length) {
  if (missing.length) {
    console.error(`缺少构建依赖（${missing.length} 个）：${missing.join("、")}`)
    console.error("")
    console.error("这些依赖只在**构建期**需要（产物 lib/cm-vendor.js 已提交，运行时零依赖）。")
    console.error(`请在 ${BUILD_DIR} 里安装：`)
    console.error(`  cd "${BUILD_DIR}"`)
    console.error(`  npm i --no-save ${missing.join(" ")}`)
  }
  if (missingTransitive.length) {
    console.error(`缺少传递依赖：${missingTransitive.join("、")}`)
    console.error("它们应由 @codemirror/* 从 profile 带进来，**不要单独 npm i**（会打出两份 lezer）。")
    console.error(`请检查 ${join(PROFILE, "node_modules")} 是否完整，或用 --profile 指定另一套 profile。`)
  }
  console.error("")
  console.error("若本机已有装好 CodeMirror 的插件，也可以指定那套 profile：")
  console.error("  node scripts/build-cm-vendor.mjs --profile <profile 目录>")
  process.exit(1)
}

await mkdir(BUILD_DIR, { recursive: true })
await copyFile(join(HERE, "cm-entry.js"), join(BUILD_DIR, "cm-entry.js"))

const args = [
  "--yes",
  "esbuild@0.25.0",
  "cm-entry.js",
  "--bundle",
  "--format=iife",
  "--global-name=CM",
  "--minify",
  "--target=es2020",
  `--outfile=${OUT}`,
  `--metafile=${META_PATH}`,
  "--log-level=warning",
]

const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
  cwd: BUILD_DIR,
  encoding: "utf8",
  shell: process.platform === "win32",
})
if (r.status !== 0) {
  console.error(r.stdout || "")
  console.error(r.stderr || "")
  process.exit(r.status || 1)
}
if (r.stderr) console.error(r.stderr.trim())

/** 产物里必须真的带这些符号：脚本退出码 0 不等于它们在里面。 */
const bundle = await readFile(OUT, "utf8")
const wantSymbols = ["marked", "DOMPurify", "pythonParser", "katex"]
const absent = wantSymbols.filter((sym) => !new RegExp(`\\b${sym}\\b`).test(bundle))
if (absent.length) {
  console.error(`vendor 产物缺少导出：${absent.join("、")} —— 检查 cm-entry.js 与依赖版本`)
  process.exit(1)
}
const bundleSize = (await stat(OUT)).size
console.log(`已生成 ${OUT}（${(bundleSize / 1024).toFixed(1)} KB）`)
console.log(`  └ 导出自检通过：${wantSymbols.join(" / ")}`)

/**
 * 重复依赖自检：同一个包被打进两份时，运行时会出现「两套 lezer」
 * （节点类型 instanceof 互不相等）和体积翻倍，而构建**不会报错**。
 * metafile 是最可靠的证据：每个 input 文件的真实来源都列在里面。
 */
const meta = JSON.parse(await readFile(META_PATH, "utf8"))
const inputs = Object.keys(meta.inputs || {})
const countOf = (frag) => inputs.filter((p) => p.split("\\").join("/").includes(frag)).length
const lrCopies = countOf("@lezer/lr/dist/index.js")
const pyCopies = countOf("@lezer/python/dist/index.js")
if (lrCopies > 1 || pyCopies > 1) {
  console.error(`vendor 里出现重复的 lezer：@lezer/lr × ${lrCopies}，@lezer/python × ${pyCopies}`)
  console.error("多半是 .nb2-build 里也装了一份 @lezer/*。删掉它，让依赖统一从 profile 解析。")
  process.exit(1)
}
console.log(`  └ 依赖自检通过：@lezer/lr × ${lrCopies}，@lezer/python × ${pyCopies}（无重复）`)

// ── KaTeX 静态资源：CSS（只留 woff2）+ 字体 ──
// 为什么不内联进 vendor：katex 的 CSS 有 23KB、字体 20 个 woff2 共 254KB；
// base64 内联会让「打开面板」的首屏包多 ~350KB，而 CSS/字体本来就是浏览器
// 并行拉取并长期缓存的资源。
//
// 为什么改写 CSS：原版每个 @font-face 都有 woff2/woff/ttf 三段（共 60 个 url），
// 而我们只带 woff2。删掉其余两段并把 url 改成**绝对路径** /nb2/fonts/…，
// 这样不管 CSS 从哪个路径被引用，字体都能指到宿主的字体路由。
const KATEX_DIST = join(resolvePkgDir("katex"), "dist")
const cssSrc = join(KATEX_DIST, "katex.min.css")
if (!existsSync(cssSrc)) {
  console.error(`katex 包里没有 dist/katex.min.css：${cssSrc}`)
  process.exit(1)
}
const FONT_OUT = join(KATEX_OUT, "fonts")
await mkdir(FONT_OUT, { recursive: true })

const rawCss = await readFile(cssSrc, "utf8")
let srcBlocks = 0
let urlsBefore = 0
const keptCss = rawCss.replace(/(src:)([^;}]+)/g, (whole, head, value) => {
  srcBlocks += 1
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean)
  urlsBefore += parts.length
  const woff2Only = parts
    .filter((s) => s.includes(".woff2"))
    .map((s) => s.replace(/url\(\s*(['"]?)fonts\//, "url($1/nb2/fonts/"))
  if (!woff2Only.length) {
    console.error(`@font-face 里没有 woff2 段，CSS 结构与预期不符：${value.slice(0, 120)}`)
    process.exit(1)
  }
  return head + woff2Only.join(",")
})
const urlsAfter = (keptCss.match(/url\(\/nb2\/fonts\//g) || []).length
if (urlsAfter !== srcBlocks) {
  console.error(`字体地址改写不完整：@font-face ${srcBlocks} 个，但重写后的绝对地址只有 ${urlsAfter} 个`)
  process.exit(1)
}
await writeFile(join(KATEX_OUT, "katex.css"), keptCss, "utf8")
// 早期版本产物叫 katex.min.css（未改写），留着会让人以为字体走的是相对路径
const stale = join(KATEX_OUT, "katex.min.css")
if (existsSync(stale)) await unlink(stale)
const cssSize = (await stat(join(KATEX_OUT, "katex.css"))).size

const fontNames = (await readdir(join(KATEX_DIST, "fonts"))).filter((n) => n.toLowerCase().endsWith(".woff2"))
let fontBytes = 0
for (const name of fontNames) {
  const dest = join(FONT_OUT, name)
  await copyFile(join(KATEX_DIST, "fonts", name), dest)
  fontBytes += (await stat(dest)).size
}
// 已经落盘的 woff/ttf（如果有）一并清掉：宿主只服务 woff2
for (const name of await readdir(FONT_OUT)) {
  if (!name.toLowerCase().endsWith(".woff2")) await unlink(join(FONT_OUT, name))
}
console.log(
  `已生成 ${join(KATEX_OUT, "katex.css")}（${(cssSize / 1024).toFixed(1)} KB；` +
    `@font-face ${srcBlocks} 个，url 由 ${urlsBefore} 段裁到 ${urlsAfter} 段，全为绝对路径）`,
)
console.log(`已复制 ${fontNames.length} 个 woff2 字体（${(fontBytes / 1024).toFixed(1)} KB）→ ${FONT_OUT}`)
console.log(`合计：vendor ${(bundleSize / 1024).toFixed(1)} KB + katex ${((cssSize + fontBytes) / 1024).toFixed(1)} KB`)

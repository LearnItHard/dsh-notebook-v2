/**
 * 内核变量探针（VARS_PROBE）的测试。
 *
 * 为什么单独测它：这是 Phase 2「Kernel-aware Prompt」唯一碰用户命名空间的地方 ——
 * 探针里写错一行（比如 Python 2 的反引号 repr、或忘了过滤模块名），
 * 表现不是崩，而是「AI 拿到的变量列表是空的/脏的」，在真机上极难发现。
 *
 * 测的不是 sidecar，而是**探针脚本本身**：把它从 lib/index.js 里抽出来，
 * 交给真实 Python 跑一遍，断言：
 *   1. 语法合法（能 compile）；
 *   2. 能输出**一行 JSON**（后端就是按行的最后一个 JSON 解析的）；
 *   3. DataFrame 给出 columns / shape（AI 最需要的两个信息）；
 *   4. 模块 / 类 / 下划线开头的内部名都被过滤掉；
 *   5. 标量 / list / dict 的摘要形状正确。
 *
 * 不依赖 DSH，也不依赖 ipykernel；只用 PATH 上的 python（DSH_PYTHON 可覆盖）。
 * 没有 pandas 的机器只跳过 DataFrame 断言，不算失败。
 *
 * 运行：node dsh-notebook-v2/test/vars.mjs
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

/** 从 lib/index.js 抽出 VARS_PROBE 数组，还原成 Python 源码。 */
export function extractProbe(srcPath = join(HERE, "..", "lib", "index.js")) {
  const src = readFileSync(srcPath, "utf8")
  const start = src.indexOf("const VARS_PROBE = [")
  const end = src.indexOf('].join("\\n")', start)
  if (start < 0 || end < 0) return null
  const body = src.slice(start + "const VARS_PROBE = [".length, end)
  const lines = []
  for (const line of body.split("\n")) {
    const t = line.trim()
    if (!t.startsWith('"')) continue
    lines.push(JSON.parse(t.endsWith(",") ? t.slice(0, -1) : t))
  }
  return lines.join("\n")
}

const PY = process.env.DSH_PYTHON || "python"
const probe = extractProbe()

console.log("[探针抽取]")
check("从 lib/index.js 抽到 VARS_PROBE", !!probe && probe.length > 200, probe ? `${probe.split("\n").length} 行` : "null")

if (!probe) {
  console.log(`\n${failures.length} 项失败 ❌：${failures.join(" | ")}`)
  process.exit(1)
}

/**
 * 探针里容易出现、且**只在 Python 3 下才报错**的写法。
 * 这里做源码级否定断言，比"跑一遍看结果"更早失败。
 */
check("不含 Python 2 的反引号 repr", !/`/.test(probe), "")
check("过滤下划线开头的内部名", probe.includes("startswith('_')"), "")
check("过滤模块/函数/类", probe.includes("_nb2_types.ModuleType"), "")
check("只输出一行 JSON（后端按行解析）", /^print\(_nb2_json\.dumps/m.test(probe), "")

// ── 真跑一次：注入一个伪造的内核命名空间 ──
const dir = mkdtempSync(join(tmpdir(), "nb2-vars-"))
const probePath = join(dir, "probe.py")
writeFileSync(probePath, probe, "utf8")

const HARNESS = `
import io, json, contextlib, os, sys, json as _json
probe_path = os.environ["NB2_PROBE"]
src = open(probe_path, encoding="utf-8").read()
ns = {"__name__": "__main__"}
setup = "n = 42\\ns = 'hi'\\nitems = [1,2,3]\\nd = {'k': 1}\\nimport os\\nclass Foo: pass\\n"
has_pandas = True
try:
    setup = "import pandas as pd\\n" + setup + "df = pd.DataFrame({'a':[1,2,3],'b':[4,5,6]})\\n"
    exec(setup, ns)
except Exception:
    has_pandas = False
    ns = {"__name__": "__main__"}
    exec("n = 42\\ns = 'hi'\\nitems = [1,2,3]\\nd = {'k': 1}\\nimport os\\nclass Foo: pass\\n", ns)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    exec(src, ns)
out = buf.getvalue().strip()
lines = [l for l in out.splitlines() if l.strip()]
data = _json.loads(lines[-1])
print(_json.dumps({"hasPandas": has_pandas, "lineCount": len(lines), "vars": data["vars"]}))
`

const run = spawnSync(PY, ["-c", HARNESS], {
  encoding: "utf8",
  env: { ...process.env, NB2_PROBE: probePath, PYTHONIOENCODING: "utf-8" },
  timeout: 60000,
})

console.log("\n[真跑探针]")
check("python 可执行", !run.error, run.error ? String(run.error.message) : PY)
check("探针跑通（退出码 0）", run.status === 0, (run.stderr || "").slice(-300))

let payload = null
try {
  payload = JSON.parse(String(run.stdout || "").trim().split("\n").pop())
} catch {
  payload = null
}
check("输出可被解析为 JSON（后端就是这么解析的）", !!payload, String(run.stdout || "").slice(0, 200))

if (payload) {
  const names = payload.vars.map((v) => v.name)
  /** 只输出一行：多行会让后端 `lines.pop()` 拿到错的片段 */
  check("只产生 1 行输出", payload.lineCount === 1, `lines=${payload.lineCount}`)
  check("收进了用户标量 n", names.includes("n"), names.join(","))
  check("收进了 list", names.includes("items") && /list len: 3/.test(String(payload.vars.find((v) => v.name === "items").detail)), "")
  check("收进了 dict 且给出 keys", names.includes("d") && /dict keys: k/.test(String(payload.vars.find((v) => v.name === "d").detail)), "")
  check("过滤掉导入的模块（os/pd 不该出现）", !names.includes("os") && !names.includes("pd"), names.join(","))
  check("过滤掉类（Foo 不该出现）", !names.includes("Foo"), names.join(","))
  check("过滤掉内部名（_nb2_* 不该出现）", !names.some((n) => String(n).startsWith("_")), names.join(","))

  if (payload.hasPandas) {
    const df = payload.vars.find((v) => v.name === "df")
    check("DataFrame 给出 columns（AI 靠它写对列名）", !!df && /columns: a,b/.test(String(df.detail)), df && df.detail)
    check("DataFrame 给出 shape", !!df && /shape: \(3, 2\)/.test(String(df.detail)), df && df.detail)
    check("DataFrame 的 type 是 DataFrame", !!df && df.type === "DataFrame", df && df.type)
  } else {
    console.log("  （本机 python 没有 pandas，跳过 DataFrame 断言）")
  }
}

rmSync(dir, { recursive: true, force: true })

console.log(`\n${failures.length === 0 ? "探针测试全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

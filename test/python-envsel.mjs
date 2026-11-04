/**
 * 专用回归：envsel 里选中的解释器**跑不了 ipykernel** 时必须降级，而不是原样复现
 * `No module named 'ipykernel'`（评审指出的残留漏洞）。
 *
 * 这条漏洞的形态：用户在 python-env 插件里换到某个没装 ipykernel 的环境 → 内核又起不来，
 * 而我们已经"修好了"这个报错 —— 所以必须单独钉死。
 *
 * 运行：node dsh-notebook-v2/test/python-envsel.mjs
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

console.log("dsh-notebook-v2 · envsel 降级回归\n")

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), "nb2-envsel-"))
const py = await import("../lib/python.js")

const usable = py.listKernels().find((k) => k.hasIpykernel)
if (!usable) {
  console.log("  （跳过：本机没有任何装了 ipykernel 的环境）")
  process.exit(0)
}

// 一个「真实存在但绝对不是 python 解释器」的路径：模拟"选错环境"
const bogus = process.platform === "win32" ? "C:\\Windows\\System32\\where.exe" : "/bin/ls"

await writeFile(
  py.envselStatePath(),
  JSON.stringify({ version: 1, selections: { bad: { python: { pythonCommand: bogus } } } }),
  "utf8",
)
py.resetCache()

// 1) 直接探测这个假解释器
const probe = py.probeIpykernel(bogus)
check("假解释器探测结果为不可用", probe.ok === false, String(probe.detail || "").slice(0, 60))

// 2) 解析时应降级到可用环境，并给出 warning
const r = py.resolvePython({ sessionId: "bad" })
check("不把坏解释器当结果（已降级）", r.python !== bogus, `${r.source} → ${r.python}`)
check("降级后 source 不是 envsel", r.source !== "envsel", r.source)
check("给出可读 warning（含 ipykernel 字样）", typeof r.warning === "string" && /ipykernel/i.test(r.warning), String(r.warning || "").slice(0, 90))
check("降级目标是真有 ipykernel 的环境", r.python === usable.python, r.python)
check("降级结果本身能 import ipykernel", py.probeIpykernel(r.python).ok === true)

// 3) 对照：envsel 指向**可用**环境时必须走 envsel（不能无脑降级）
await writeFile(
  py.envselStatePath(),
  JSON.stringify({ version: 1, selections: { good: { python: { pythonCommand: usable.python } } } }),
  "utf8",
)
py.resetCache()
const good = py.resolvePython({ sessionId: "good" })
check("envsel 指向可用环境 → source=envsel", good.source === "envsel" && good.python === usable.python, `${good.source} → ${good.python}`)

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

/**
 * 解释器 / 内核发现测试（不需要启动内核）。
 *
 * 这套逻辑是 v2 第一次真机启动就挂掉的根因所在，所以必须单测：
 *   真机症状：`SidecarError: No module named 'ipykernel'`
 *   根因：插件进程读不到 DSH_ENV_PYTHON（它只存在于 shell 调用的环境里），
 *         于是回落到 PATH 上的系统 python（没装 ipykernel）。
 *   权威来源：~/.dsh/envsel-state.json（用户选的解释器），且要沿父会话继承。
 *
 * 运行：node dsh-notebook-v2/test/python.mjs
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

console.log("dsh-notebook-v2 · python/kernel discovery\n")

// 用临时 DSH_HOME，避免依赖/污染真实 envsel 状态
const fakeHome = await mkdtemp(join(tmpdir(), "nb2-home-"))
process.env.DSH_HOME = fakeHome

const py = await import("../lib/python.js")

// ── 1. conda 内核清单 ──
{
  console.log("[listKernels]")
  const kernels = py.listKernels()
  check("扫到了 conda 环境", kernels.length >= 1, `${kernels.length} 个`)
  const withKernel = kernels.filter((k) => k.hasIpykernel)
  check("至少有一个环境装了 ipykernel（本机应命中 ML-LLM-base 之类）", withKernel.length >= 1, withKernel.map((k) => k.name).join(",") || "无")
  check("有 ipykernel 的排在前面", kernels.length === 0 || kernels[0].hasIpykernel === true || withKernel.length === 0, kernels.map((k) => `${k.name}:${k.hasIpykernel}`).join(" "))
  check("每条都有 id/python/display", kernels.every((k) => k.id && k.python && k.display))
  check("内核可按下拉项 id 反查", kernels.length ? py.kernelById(kernels[0].id) !== null : true)
  check("未知 id 反查返回 null", py.kernelById("conda:nope:x") === null)
}

// ── 2. envsel 读取（版本/结构不对就当没有）──
{
  console.log("\n[envsel 存储]")
  py.resetCache()
  check("文件不存在时返回 null（不猜 schema）", py.envselSelections() === null)

  const statePath = py.envselStatePath()
  check("状态路径落在 DSH_HOME 下", statePath.startsWith(fakeHome), statePath)

  await writeFile(statePath, JSON.stringify({ version: 999, selections: { s1: { python: { python: "x" } } } }), "utf8")
  py.resetCache()
  check("版本不符 → null", py.envselSelections() === null)

  const kernels = py.listKernels()
  const realPython = kernels.length ? kernels[0].python : null
  await writeFile(
    statePath,
    JSON.stringify({ version: 1, selections: { s1: { python: { pythonCommand: realPython } } } }),
    "utf8",
  )
  py.resetCache()
  const sel = py.envselSelections()
  check("version=1 能读出 selections", sel !== null && sel.s1 !== undefined)
  check("envselPython 命中本会话", realPython ? py.envselPython("s1") === realPython : true, realPython)
}

// ── 3. 父会话继承（子代理自己没有选择）──
{
  console.log("\n[父会话继承]")
  const kernels = py.listKernels()
  const realPython = kernels.length ? kernels[0].python : null
  const parents = new Map([["child", "parent"], ["parent", "root"]])
  // 关键：给 **parent** 写选择，child 自己没有 —— 这才是子代理的真实情形
  await writeFile(
    py.envselStatePath(),
    JSON.stringify({ version: 1, selections: { parent: { python: { pythonCommand: realPython } } } }),
    "utf8",
  )
  py.resetCache()
  check("child 自己没有选择", (py.envselSelections() || {}).child === undefined)
  check("子会话沿父链拿到父的选择", py.envselPython("child", parents) === realPython, py.envselPython("child", parents))
  check("父会话自己直接命中", py.envselPython("parent", parents) === realPython)
  py.resetCache()
  check("链上没有选择 → null", py.envselPython("stranger", parents) === null)
  const cyc = new Map([["a", "b"], ["b", "a"]])
  py.resetCache()
  let cycleResult
  try {
    cycleResult = py.envselPython("a", cyc)
  } catch (err) {
    cycleResult = `THREW:${err && err.message}`
  }
  check("父子成环不会死循环（不抛且返回 null）", cycleResult === null, String(cycleResult))
}

// ── 4. 解析优先级 ──
{
  console.log("\n[resolvePython 优先级]")
  // 前面的用例重写过 envsel 文件，这里必须给被测会话**重新**写一条选择，
  // 否则测的不是 envsel 分支（会得到假红/假绿）。
  const okPy = py.listKernels().find((k) => k.hasIpykernel)
  if (okPy) {
    await writeFile(
      py.envselStatePath(),
      JSON.stringify({ version: 1, selections: { s1: { python: { pythonCommand: okPy.python } } } }),
      "utf8",
    )
  }
  py.resetCache()
  const fromEnvsel = py.resolvePython({ sessionId: "s1" })
  // 精确断言：envsel 里的解释器**确实有 ipykernel**时必须走 envsel（不能悄悄降级到 conda）
  const envselExpected = py.envselSelections() !== null
  check(
    "有 envsel 选择且该解释器可用 → source=envsel（不降级）",
    envselExpected ? fromEnvsel.source === "envsel" : fromEnvsel.source !== "envsel",
    `${fromEnvsel.source} → ${fromEnvsel.python}`,
  )
  check("解析出的 python 存在", py.listKernels().some((k) => k.python === fromEnvsel.python) || fromEnvsel.source === "path")

  const cfgHit = py.resolvePython({ sessionId: "s1", configPython: py.listKernels()[0].python })
  check("config 优先", cfgHit.source === "config")
  check("config 指向不存在的路径时被忽略", py.resolvePython({ sessionId: "s1", configPython: "Z:/nope/python.exe" }).source !== "config")

  py.resetCache()
  const noSel = py.resolvePython({ sessionId: "no-such-session" })
  const hasUsableConda = py.listKernels().some((k) => k.hasIpykernel)
  check(
    "没有 envsel 选择 → 用 conda 里有 ipykernel 的（本机有则必须是 conda，不能是 path）",
    hasUsableConda ? noSel.source === "conda" : noSel.source === "path",
    `${noSel.source} → ${noSel.python}`,
  )
}

// ── 5. 诊断清单 ──
{
  console.log("\n[diagnostics]")
  const diag = py.kernelDiagnostics()
  check("带 envsel 路径与是否找到", typeof diag.envselPath === "string" && typeof diag.envselFound === "boolean")
  check("列出候选内核及 hasIpykernel", Array.isArray(diag.kernels) && diag.kernels.length >= 1 && "hasIpykernel" in diag.kernels[0])
  check("带排查提示文案", typeof diag.hint === "string" && diag.hint.includes("ipykernel"))
  check("带 DSH_ENV_PYTHON 等 env 快照（便于确认进程里看不到）", "DSH_ENV_PYTHON" in diag.lookup)
}

// ── 6. 真实探测：本机解析出的 python 应该真能 import ipykernel ──
{
  console.log("\n[真实探测]")
  const { spawnSync } = await import("node:child_process")
  py.resetCache()
  const r = py.resolvePython({ sessionId: "probe" })
  const probe = spawnSync(r.python, ["-c", "import ipykernel, jupyter_client; print('ok')"], { encoding: "utf8", timeout: 20000 })
  check(
    "解析出的解释器真的能 import ipykernel（这条就是真机崩溃的防线）",
    probe.status === 0 && String(probe.stdout).includes("ok"),
    `${r.source}:${r.python} → ${probe.status === 0 ? "ok" : String(probe.stderr).slice(0, 120)}`,
  )
}

console.log(`\n${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join(" | ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)

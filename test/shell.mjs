/**
 * shell 执行器测试（不需要 DSH、不需要 Python）。
 *
 * 覆盖两类：
 *   1. 纯函数：shell 种类归一化、Auto 选择策略、命令拼装（含 Windows 编码前缀）
 *   2. 真跑：飙一个真进程，验流式回调、退出码、stderr 分流、超时、中断
 *
 * 第 2 类是本套件的重点 —— 「shell 格能不能用」不是靠读代码能保证的，
 * 尤其是 Windows 的 cmd 进程树、编码、超时杀进程。
 *
 * 运行：node dsh-notebook-v2/test/shell.mjs
 */

import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = join(HERE, "..", "lib", "shell.js")

const { normalizeShellKind, pickShellKind, buildShellInvocation, hasBash, runShell, whichCommand, resetBashProbe } =
  await import(pathToFileURL(MOD).href)

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

const isWin = process.platform === "win32"

// ───────────────────────────── 1. 纯函数 ─────────────────────────────
console.log("\n[1] 类型归一化与命令拼装")

{
  const table = [
    ["bash", "bash"],
    ["sh", "bash"],
    ["zsh", "bash"],
    ["git-bash", "bash"],
    ["cmd", "cmd"],
    ["cmd.exe", "cmd"],
    ["pwsh", "pwsh"],
    ["powershell", "pwsh"],
    ["ps", "pwsh"],
    ["", "auto"],
    [null, "auto"],
    ["whatever", "auto"],
  ]
  let bad = []
  for (const [input, want] of table) {
    const got = normalizeShellKind(input)
    if (got !== want) bad.push(`${String(input)}→${got}(期望${want})`)
  }
  check("normalizeShellKind 别名表", bad.length === 0, bad.length ? bad.join(", ") : "12 组全对")
}

{
  check("pickShellKind：有 bash 就用 bash（win32）", pickShellKind({ platform: "win32", hasBash: true }) === "bash")
  check("pickShellKind：win32 没 bash → cmd", pickShellKind({ platform: "win32", hasBash: false }) === "cmd")
  check("pickShellKind：linux → bash", pickShellKind({ platform: "linux", hasBash: false }) === "bash")
}

{
  const b = buildShellInvocation("echo hi", { kind: "bash", platform: "linux" })
  check("bash 调用形状", b.command === "bash" && b.args[0] === "-c" && b.args[1] === "echo hi", JSON.stringify(b))

  const c = buildShellInvocation("echo hi", { kind: "cmd", platform: "win32" })
  check(
    "cmd 调用带 chcp 65001（否则中文输出是乱码）",
    c.command === "cmd.exe" && c.args[0] === "/d" && c.args[1] === "/s" && c.args[2] === "/c" && c.args[3].includes("chcp 65001"),
    c.args[3],
  )

  const p = buildShellInvocation("Get-Date", { kind: "pwsh", platform: "win32" })
  check(
    "pwsh 调用设 OutputEncoding 且有 powershell.exe 兜底",
    p.command === "pwsh" && p.fallbackCommand === "powershell.exe" && p.args[p.args.length - 1].includes("OutputEncoding"),
  )

  const auto = buildShellInvocation("echo hi", { kind: "auto", platform: "win32", hasBash: false })
  check("auto 在 win32/无 bash 时落到 cmd", auto.kind === "cmd", auto.kind)
  const auto2 = buildShellInvocation("echo hi", { kind: "auto", platform: "linux", hasBash: true })
  check("auto 在有 bash 时落到 bash", auto2.kind === "bash", auto2.kind)
}

{
  // 多行 + 中文 + 引号必须原样透传（不能在我们这层被 shell 解析掉）
  const code = 'echo "第一行"\necho 第二行'
  const b = buildShellInvocation(code, { kind: "bash", platform: "linux" })
  check("多行脚本原样透传（不预解析）", b.args[1] === code)
}

{
  const [cmd, args] = whichCommand("win32")
  check("whichCommand（win32 用 where）", cmd === "where" && args[0] === "bash")
  const [cmd2] = whichCommand("linux")
  check("whichCommand（posix 用 sh -c command -v）", cmd2 === "sh")
  resetBashProbe()
  check("hasBash 返回布尔值（本机实探）", typeof hasBash() === "boolean", `bash=${hasBash()}`)
}

// ───────────────────────────── 2. 真跑 ─────────────────────────────
console.log("\n[2] 真跑一个 shell 进程")

const KIND = pickShellKind({ platform: process.platform, hasBash: hasBash() })

/** 跨平台的一段脚本：打印两行、中间不带延迟（流式单独测）。 */
function scriptLines() {
  if (KIND === "bash") return 'echo alpha\necho beta'
  if (KIND === "pwsh") return 'Write-Output alpha; Write-Output beta'
  return "echo alpha & echo beta"
}

{
  let out = ""
  let err = ""
  const r = await runShell(scriptLines(), {
    cwd: HERE,
    kind: KIND,
    onStdout: (t) => (out += t),
    onStderr: (t) => (err += t),
  })
  check("退出码 0", r.code === 0, `code=${r.code} kind=${r.kind}`)
  check("stdout 收到两行", out.includes("alpha") && out.includes("beta"), JSON.stringify(out.trim()))
  check("stderr 为空", err.trim() === "", JSON.stringify(err.trim()))
  check("durationMs 是正数", r.durationMs > 0, `${r.durationMs}ms`)
}

{
  // 非零退出码必须如实回报（UI 才会画 error 块）
  const cmd = KIND === "bash" ? "exit 3" : KIND === "pwsh" ? "exit 3" : "exit /b 3"
  const r = await runShell(cmd, { cwd: HERE, kind: KIND })
  check("非零退出码如实回报", r.code === 3, `code=${r.code}`)
}

{
  // stderr 要分流，不能混进 stdout
  let out = ""
  let err = ""
  const cmd = KIND === "bash" ? "echo to-err 1>&2" : KIND === "pwsh" ? "[Console]::Error.WriteLine('to-err')" : "echo to-err 1>&2"
  const r = await runShell(cmd, { cwd: HERE, kind: KIND, onStdout: (t) => (out += t), onStderr: (t) => (err += t) })
  check("stderr 分流到 onStderr", err.includes("to-err"), `stderr=${JSON.stringify(err.trim())} stdout=${JSON.stringify(out.trim())}`)
  check("stderr 场景退出码仍为 0", r.code === 0, `code=${r.code}`)
}

{
  // 真流式：两行之间隔 400ms，必须分两次回调（不是攒一起）
  const chunks = []
  let t0 = 0
  const cmd =
    KIND === "bash"
      ? "echo first\nsleep 0.4\necho second"
      : KIND === "pwsh"
        ? "Write-Output first; Start-Sleep -Milliseconds 400; Write-Output second"
        : "echo first & ping -n 2 127.0.0.1 >nul & echo second"
  await runShell(cmd, {
    cwd: HERE,
    kind: KIND,
    onStdout: (t) => {
      if (!t0) t0 = Date.now()
      chunks.push({ t: Date.now(), text: t })
    },
  })
  const gap = chunks.length >= 2 ? chunks[chunks.length - 1].t - chunks[0].t : -1
  check("流式分次到达（≥2 次回调）", chunks.length >= 2, `chunks=${chunks.length}`)
  check("两次回调间隔 ≥200ms（真流式，不是憋到最后）", gap >= 200, `gap=${gap}ms`)
}

{
  // 超时：必须被终止且标记 timedOut
  const cmd = KIND === "bash" ? "sleep 5" : KIND === "pwsh" ? "Start-Sleep -Seconds 5" : "ping -n 6 127.0.0.1 >nul"
  const t0 = Date.now()
  const r = await runShell(cmd, { cwd: HERE, kind: KIND, timeoutMs: 700 })
  const spent = Date.now() - t0
  check("超时被终止（timedOut=true）", r.timedOut === true, `timedOut=${r.timedOut} code=${r.code}`)
  check("超时在 ~700ms 附近生效（没等满 5s）", spent < 3500, `${spent}ms`)
}

{
  // 中断：AbortController 要能杀掉子进程（含 Windows 进程树）
  const cmd = KIND === "bash" ? "sleep 5" : KIND === "pwsh" ? "Start-Sleep -Seconds 5" : "ping -n 6 127.0.0.1 >nul"
  const ac = new AbortController()
  const t0 = Date.now()
  const p = runShell(cmd, { cwd: HERE, kind: KIND, signal: ac.signal })
  setTimeout(() => ac.abort(), 300)
  const r = await p
  const spent = Date.now() - t0
  check("中断后 killed=true", r.killed === true, `killed=${r.killed} code=${r.code}`)
  check("中断在 ~300ms 后生效", spent < 3500, `${spent}ms`)
}

{
  // 已经 abort 过的 signal：立即返回，不 spawn
  const ac = new AbortController()
  ac.abort()
  const r = await runShell("echo never", { cwd: HERE, kind: KIND, signal: ac.signal })
  check("预先 abort 的 signal 立即返回", r.killed === true && r.durationMs < 1000, `killed=${r.killed} ${r.durationMs}ms`)
}

{
  // 找不到的命令：不抛，退出码 127（否则整条队列会被异常打断）
  const r = await runShell("nb2-definitely-not-a-command", { cwd: HERE, kind: KIND })
  if (KIND === "bash") {
    check("未知命令 → 退出码非 0 且不抛", typeof r.code === "number" && r.code !== 0, `code=${r.code}`)
  } else {
    check("未知命令 → 不抛且有退出码", typeof r.code === "number", `code=${r.code}`)
  }
}

{
  // 交互式命令不能被挂死：stdio 是 ignore，读不到输入就该立刻结束
  const cmd = KIND === "bash" ? "cat" : KIND === "pwsh" ? "$null = [Console]::ReadLine()" : "set /p x="
  const r = await runShell(cmd, { cwd: HERE, kind: KIND, timeoutMs: 3000 })
  check("等待 stdin 的命令不会挂住", r.timedOut === false, `timedOut=${r.timedOut} code=${r.code}`)
}

console.log(
  failures.length === 0 ? "\nshell 测试全部通过 ✅" : `\nshell 测试失败 ${failures.length} 项 ❌\n  - ${failures.join("\n  - ")}`,
)
process.exit(failures.length === 0 ? 0 : 1)

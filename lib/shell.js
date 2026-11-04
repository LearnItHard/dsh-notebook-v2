/**
 * Shell 单元格执行器（不经过 Python 内核）。
 *
 * 为什么不在内核里跑 `%%bash`：
 *  - Windows 上 ipykernel 的 `%%bash` magic **直接抛错**（没有 bash），
 *    用户写了 shell 格却能不能跑取决于有没有装 git-bash，这是最差的手感；
 *  - 走独立进程之后，channel/编码/中断/超时都归我们管，还能保证
 *    「重启内核不影响 shell 格」；
 *  - 输出直接复用现有的 `stream` 事件（stdout/stderr 分开），所以 UI 不用改。
 *
 * 三个可测的纯函数：
 *   normalizeShellKind / classifyWhich / buildShellInvocation
 * 一个执行器：runShell（流式回调 + 超时 + 中断 + 退出码）
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

/** 归一化 shell 种类：只认 bash / cmd / pwsh，其它一律 auto。 */
export function normalizeShellKind(kind) {
  const k = String(kind == null ? "" : kind)
    .trim()
    .toLowerCase()
  if (k === "bash" || k === "sh" || k === "zsh" || k === "git-bash" || k === "gitbash") return "bash"
  if (k === "cmd" || k === "cmd.exe" || k === "command") return "cmd"
  if (k === "pwsh" || k === "powershell" || k === "ps" || k === "ps1") return "pwsh"
  return "auto"
}

/**
 * 决定 Auto 时到底用哪个 shell。
 *
 * 优先级刻意这么排：**只要机器上有 bash 就用 bash**。理由：用户写 shell 格时
 * 心里想的是 sh 语法（`for i in 1 2 3; do`），cmd 跑不了；而反过来，简单的
 * `echo hi` / `ls` 在 bash 下也没问题。没 bash 的机器才退到 cmd（Windows 必装）。
 */
export function pickShellKind({ platform = process.platform, hasBash = false } = {}) {
  if (hasBash) return "bash"
  return platform === "win32" ? "cmd" : "bash"
}

/**
 * 判别 `which` 的结果用哪条命令。
 * 纯函数（不碰 IO）是为了能测：Windows 上 `where bash` 返回 0 才算有。
 */
export function whichCommand(platform = process.platform) {
  return platform === "win32" ? ["where", ["bash"]] : ["sh", ["-c", "command -v bash"]]
}

/** 探测 bash 是否存在（结果缓存在模块级：每次建 shell 格都 spawn 一次太浪费）。 */
let bashProbe = null
export function hasBash({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return true // POSIX 一定有 sh/bash 之一
  if (bashProbe !== null) return bashProbe
  // 快路径：git-bash 的常见位置，省一次 spawn
  const guess = "C:\\Program Files\\Git\\bin\\bash.exe"
  if (env.NB2_BASH && existsSync(env.NB2_BASH)) {
    bashProbe = true
    return true
  }
  if (existsSync(guess)) {
    bashProbe = true
    return true
  }
  try {
    const [cmd, args] = whichCommand(platform)
    const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 4000 })
    bashProbe = r.status === 0 && String(r.stdout || "").trim().length > 0
  } catch {
    bashProbe = false
  }
  return bashProbe
}

/** 测试用：清掉探测缓存。 */
export function resetBashProbe() {
  bashProbe = null
}

/**
 * 把一段脚本文本变成 {command, args}。
 *
 * 编码：Windows 的 cmd 默认走 OEM 代码页（中文系统是 GBK），Node 按 UTF-8 解码会
 * 得到一堆 `锟斤拷`。所以 cmd 前缀 `chcp 65001`；pwsh 显式设 OutputEncoding；
 * bash 本来就是 UTF-8，不动。
 */
export function buildShellInvocation(code, { kind = "auto", platform = process.platform, hasBash = false } = {}) {
  const body = String(code == null ? "" : code)
  let resolved = normalizeShellKind(kind)
  if (resolved === "auto") resolved = pickShellKind({ platform, hasBash })
  if (resolved === "bash") {
    return { kind: "bash", command: "bash", args: ["-c", body] }
  }
  if (resolved === "pwsh") {
    // pwsh 优先级高于 powershell.exe（Win10 自带的是 5.1，非交互也能用，作兜底）
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + body
    return { kind: "pwsh", command: "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], fallbackCommand: "powershell.exe" }
  }
  return { kind: "cmd", command: "cmd.exe", args: ["/d", "/s", "/c", `chcp 65001>nul & ${body}`] }
}

/**
 * 跑一段 shell，流式回调 stdout/stderr。
 *
 * 返回 {code, signal, killed, timedOut, durationMs}；**不抛**（错误也当结果返回），
 * 因为调用方是事件泵，抛出去会打断队列。
 */
export function runShell(code, options = {}) {
  const {
    cwd = process.cwd(),
    kind = "auto",
    platform = process.platform,
    verbose = false,
    timeoutMs = 0,
    signal = null,
    onStdout = () => {},
    onStderr = () => {},
  } = options

  const inv = buildShellInvocation(code, { kind, platform, hasBash: hasBash({ platform }) })
  const started = Date.now()

  return new Promise((resolve) => {
    let child
    let settled = false
    let killed = false
    let timedOut = false
    let timer = null
    const finish = (payload) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(Object.assign({ durationMs: Date.now() - started, command: inv.command, shellKind: inv.kind }, payload))
    }

    const spawnOnce = (command, args) =>
      new Promise((res) => {
        let done = false
        const c = spawn(command, args, {
          cwd,
          windowsHide: true,
          // 不要把 stdin 接给 shell：交互式命令会挂住整个格
          stdio: ["ignore", "pipe", "pipe"],
          env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }),
        })
        child = c
        c.stdout.setEncoding("utf8")
        c.stderr.setEncoding("utf8")
        c.stdout.on("data", (t) => {
          if (t) onStdout(t)
        })
        c.stderr.on("data", (t) => {
          if (t) onStderr(t)
        })
        c.on("error", (err) => {
          if (done) return
          done = true
          res({ error: err })
        })
        c.on("close", (code, sig) => {
          if (done) return
          done = true
          res({ code, signal: sig })
        })
      })

    const kill = () => {
      killed = true
      if (!child || child.exitCode !== null) return
      try {
        if (platform === "win32" && child.pid) {
          // Windows 上必须杀进程树：cmd → 子进程，只杀 cmd 会留孤儿
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        } else {
          child.kill("SIGTERM")
        }
      } catch {
        /* ignore */
      }
    }
    if (signal) {
      if (signal.aborted) {
        finish({ code: null, signal: "SIGTERM", killed: true, timedOut: false })
        return
      }
      signal.addEventListener("abort", kill, { once: true })
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
      if (typeof timer.unref === "function") timer.unref()
    }

    const args = inv.args
    spawnOnce(inv.command, args).then(async (r) => {
      if (r.error && inv.fallbackCommand) {
        // pwsh 没装 → 退回 powershell.exe（同样的参数形状）
        if (verbose) onStderr(`[nb2] ${inv.command} 不可用，改用 ${inv.fallbackCommand}\n`)
        const r2 = await spawnOnce(inv.fallbackCommand, args)
        if (r2.error) {
          onStderr(`${r2.error.code === "ENOENT" ? "找不到 " + inv.fallbackCommand : String(r2.error.message)}\n`)
          return finish({ code: 127, signal: null, killed: false, timedOut: false })
        }
        return finish({ code: r2.code, signal: r2.signal, killed, timedOut })
      }
      if (r.error) {
        const msg = r.error.code === "ENOENT" ? `找不到 ${inv.command}（这台机器没装？）` : String(r.error.message)
        onStderr(`${msg}\n`)
        return finish({ code: 127, signal: null, killed, timedOut })
      }
      finish({ code: r.code, signal: r.signal, killed, timedOut })
    })
  })
}

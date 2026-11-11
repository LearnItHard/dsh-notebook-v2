/**
 * sidecar 客户端：NDJSON over stdio 的 Node 侧。
 *
 * 协议规格：docs/protocol-ndjson.md。这里负责规格里属于 Node 的那部分：
 *   - 启动握手（ready 超时 10s → 判失败并给可诊断的错误码）
 *   - 逐行解析（坏帧跳过，绝不因为一行脏数据丢掉整个会话）
 *   - 心跳（15s ping；30s 无任何帧 → 判挂起并杀掉）
 *   - 死亡处理（崩溃自动重启 1 次；1 分钟内第二次死亡则停止，避免崩溃循环）
 *   - 清理（Windows 必须 taskkill /T /F，否则 ipykernel 的 zmq 子进程成孤儿）
 */

import { spawn, execFile } from "node:child_process"
import { createInterface } from "node:readline"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
export const DRIVER = join(HERE, "..", "python", "kernel_driver.py")

const READY_TIMEOUT_MS = 10000
const HEARTBEAT_MS = 15000
const SILENCE_TIMEOUT_MS = 30000
const RESTART_WINDOW_MS = 60000

/**
 * 选 python 的**兜底**（正常情况下 index.js 已经解析好并显式传进来）。
 *
 * ⚠️ 不要指望 `process.env.DSH_PYTHON` / `DSH_ENV_PYTHON`：那些只在 shell 调用的环境里存在，
 * harness 不会写进插件进程。真正的权威来源是 envsel 的存储，见 lib/python.js。
 * 这里保留 env 读取只是为了「有人手动设了进程级 env」的极端情况。
 */
export function resolvePython(configPython) {
  if (configPython) return configPython
  if (process.env.DSH_PYTHON && existsSync(process.env.DSH_PYTHON)) return process.env.DSH_PYTHON
  return process.platform === "win32" ? "python" : "python3"
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === "win32") {
    // /T 必须带：不杀子进程树，ipykernel 的 zmq 子进程会活成孤儿
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {})
  } else {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
  }
}

export class Sidecar {
  /**
   * @param {object} opts
   * @param {string} [opts.python] 解释器路径
   * @param {string} [opts.cwd] 内核工作目录
   * @param {string} [opts.sid] 会话 id（日志/诊断用）
   * @param {(name:string, payload:object, frame:object)=>void} opts.onEvent 事件回调
   * @param {(text:string)=>void} [opts.onStderr] 诊断回调
   * @param {(info:object)=>void} [opts.onDeath] 无法恢复时回调
   * @param {boolean} [opts.eager] 是否预热内核
   */
  constructor(opts) {
    this.opts = opts
    this.child = null
    this.pid = null
    this.started = false
    this.dead = false
    this.pending = new Map() // reqId -> {resolve, reject, timer}
    this.reqSeq = 0
    this.lastFrameAt = 0
    this.heartbeatTimer = null
    this.restarts = []
    this.stderrTail = []
    /** 崩溃后自动重启中的那个 promise（见 whenAlive） */
    this._restartPromise = null
  }

  get alive() {
    return !!this.child && !this.dead
  }

  /** 启动并等 ready 帧。失败时抛带 code 的 Error（E_IPYKERNEL_MISSING / E_READY_TIMEOUT …）。 */
  start() {
    if (this.child) return Promise.resolve()
    const python = resolvePython(this.opts.python)
    const args = ["-u", DRIVER]
    if (this.opts.eager !== false) args.push("--eager")
    if (this.opts.cwd) args.push("--cwd", this.opts.cwd)
    if (this.opts.sid) args.push("--session", this.opts.sid)
    // 大块输出的落盘目录：宿主用同一个路径把文件读回去渲染（/nb2/spill）
    if (this.opts.spillDir) args.push("--spill-dir", this.opts.spillDir)

    const child = spawn(python, args, {
      cwd: this.opts.cwd && existsSync(this.opts.cwd) ? this.opts.cwd : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      // 非 Windows 上给一个进程组，方便整组杀
      detached: process.platform !== "win32",
      /**
       * ⚠️ **必须显式给 UTF-8**。Windows 上 python 从管道拿到的 stdio 是系统代码页
       * （本机 cp936/GBK），而 Node 写 stdin 一律 UTF-8 —— 中文源码会被解坏成 U+FFFD，
       * 中文出现在语法位置（关键字参数、变量名）就直接 SyntaxError；
       * 更糟的是含 U+FFFD 的报错帧 GBK 编不出来，驱动进程会当场死掉。
       * 真机事故与完整链路见 python/kernel_driver.py 的 force_utf8_stdio 注释。
       */
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    })
    this.child = child
    this.pid = child.pid
    this.dead = false
    this.lastFrameAt = Date.now()

    child.stderr.on("data", (buf) => {
      const text = String(buf)
      this.stderrTail.push(text)
      if (this.stderrTail.length > 50) this.stderrTail.shift()
      this.opts.onStderr?.(text)
    })

    const rl = createInterface({ input: child.stdout })
    const readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve
      this._readyReject = reject
      this._readyTimer = setTimeout(() => {
        const tail = this.stderrTail.join("").slice(-500)
        this._fail("E_READY_TIMEOUT", `sidecar 未在 ${READY_TIMEOUT_MS}ms 内发出 ready 帧。stderr: ${tail}`)
      }, READY_TIMEOUT_MS)
    })

    rl.on("line", (line) => this._onLine(line))
    child.on("exit", (code, signal) => this._onExit(code, signal))
    child.on("error", (err) => {
      this._fail(
        "E_SPAWN",
        `无法启动 python（${python}）：${err && err.message}。` +
          `提示：用 notebook 工具栏的「内核」下拉换一个装了 ipykernel 的 conda 环境，` +
          `或在 cordis.patch.yml 里把 config.python 指向它。（注意：DSH_PYTHON 只存在于 shell 调用环境，` +
          `插件进程里读不到，别指望它。）`,
      )
    })

    return readyPromise
  }

  _fail(code, message) {
    if (this._readyTimer) {
      clearTimeout(this._readyTimer)
      this._readyTimer = null
    }
    const err = new Error(message)
    err.code = code
    if (this._readyReject) {
      const reject = this._readyReject
      this._readyResolve = this._readyReject = null
      reject(err)
    }
    this.cleanup()
    return err
  }

  _onLine(line) {
    if (!line.trim()) return
    this.lastFrameAt = Date.now()
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // 坏帧只跳过：协议规格 §1 规则 4
      this.opts.onStderr?.(`bad frame skipped: ${line.slice(0, 200)}\n`)
      return
    }
    if (frame && frame.v !== 1) {
      this._fail("E_VERSION", `协议版本不匹配：sidecar v=${frame && frame.v}，宿主 v=1`)
      return
    }

    if (frame.type === "ready") {
      if (this._readyTimer) {
        clearTimeout(this._readyTimer)
        this._readyTimer = null
      }
      const payload = frame.payload || {}
      if (payload.error) {
        this._fail(payload.error, payload.detail || payload.error)
        return
      }
      this.started = true
      this._startHeartbeat()
      const resolve = this._readyResolve
      this._readyResolve = this._readyReject = null
      if (resolve) resolve(payload)
      return
    }

    if (frame.type === "ack" || frame.type === "error") {
      const waiter = frame.reply_to && this.pending.get(frame.reply_to)
      if (waiter) {
        this.pending.delete(frame.reply_to)
        clearTimeout(waiter.timer)
        if (frame.type === "error") {
          const err = new Error((frame.payload && frame.payload.message) || "sidecar error")
          err.code = (frame.payload && frame.payload.code) || "E_UNKNOWN"
          waiter.reject(err)
        } else {
          waiter.resolve(frame.payload)
        }
      }
      if (frame.type === "error") {
        this.opts.onEvent?.("sidecar.error", frame.payload || {}, frame)
      }
      return
    }

    if (frame.type === "event") {
      this.opts.onEvent?.(frame.name, frame.payload || {}, frame)
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.alive) return
      // 30s 一个帧都没来 → 判挂起（协议规格 §6）
      if (Date.now() - this.lastFrameAt > SILENCE_TIMEOUT_MS) {
        this.opts.onStderr?.("sidecar silent > 30s, killing\n")
        this.killTreeAndForget()
        return
      }
      this.send("ping", {}, { timeoutMs: 5000 }).catch(() => {})
    }, HEARTBEAT_MS)
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref()
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  _onExit(code, signal) {
    const wasAlive = !this.dead
    this.dead = true
    this._stopHeartbeat()
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      const err = new Error(`sidecar exited (code=${code}, signal=${signal})`)
      err.code = "E_KERNEL_DEAD"
      waiter.reject(err)
    }
    this.pending.clear()
    this.child = null
    if (!wasAlive) return

    // 崩溃重启预算：1 分钟内允许 1 次，超过则停手（避免崩溃循环刷屏）
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restarts.length >= 1) {
      this.opts.onDeath?.({
        code,
        signal,
        stderr: this.stderrTail.join("").slice(-1000),
        reason: "crash-loop",
      })
      return
    }
    this.restarts.push(now)
    /**
     * `stderr` 一起带上：内核崩掉时宿主唯一能拿到的「为什么」就在这里。
     * 宿主必须用它把「正在跑的那格」收尾成 error —— 只重启不收敛，
     * UI 会显示 idle + 无输出 + 无报错，格子永远卡在 running（真机 2026-11-10）。
     */
    this.opts.onEvent?.("sidecar.restarting", { code, signal, stderr: this.stderrTail.join("").slice(-1200) }, {})
    /**
     * 重启期间宿主**必须等这一个实例回来**，不许再 spawn 第二个：
     * 两个内核并存已经够糟，更糟的是 `sidecarReady` 缓存的是「已经 resolve 过的
     * 死实例」，于是每次 pump 都拿到一个死 sidecar → 无限重试 → 格子永远不跑
     * （真机 2026-11-10：崩溃后点运行，界面直接卡死，CPU 打满）。
     */
    this._restartPromise = new Promise((resolve) => {
      setTimeout(() => {
        if (this.disposedByOwner) {
          this._restartPromise = null
          resolve(null)
          return
        }
        this.start()
          .then(() => {
            this._restartPromise = null
            resolve(this)
          })
          .catch((err) => {
            this._restartPromise = null
            this.opts.onDeath?.({ code, signal, stderr: String(err && err.message), reason: "restart-failed" })
            resolve(null)
          })
      }, 300)
    })
  }

  /**
   * 等它（重新）活过来：
   *   活着 → 立刻返回自己；正在自动重启 → 返回那次重启的结果（成功自己 / 失败 null）；
   *   已彻底没了 → 立刻 null（宿主据此重新 spawn）。
   * 宿主侧用它，就不会在 300ms 的重启窗口里再起一个内核。
   */
  whenAlive() {
    if (this.alive) return Promise.resolve(this)
    if (this._restartPromise) return this._restartPromise
    return Promise.resolve(null)
  }

  /** 发命令。返回 ack payload 的 Promise（execute 不等待 ack，以事件为准）。 */
  send(op, payload, { timeoutMs = 15000 } = {}) {
    if (!this.child || !this.child.stdin.writable) {
      const err = new Error("sidecar not running")
      err.code = "E_KERNEL_DEAD"
      return Promise.reject(err)
    }
    const reqId = `r${++this.reqSeq}`
    const frame = { v: 1, type: "cmd", req_id: reqId, op, payload: payload || {} }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        const err = new Error(`sidecar ${op} 超时 ${timeoutMs}ms`)
        err.code = "E_TIMEOUT"
        reject(err)
      }, timeoutMs)
      this.pending.set(reqId, { resolve, reject, timer })
      try {
        this.child.stdin.write(JSON.stringify(frame) + "\n")
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(reqId)
        reject(err)
      }
    })
  }

  /** 发命令但不等回应（execute 用）。 */
  post(op, payload) {
    if (!this.child || !this.child.stdin.writable) return false
    const reqId = `r${++this.reqSeq}`
    try {
      this.child.stdin.write(JSON.stringify({ v: 1, type: "cmd", req_id: reqId, op, payload: payload || {} }) + "\n")
      return true
    } catch {
      return false
    }
  }

  killTreeAndForget() {
    const pid = this.pid
    this.dead = true
    this._stopHeartbeat()
    if (this.child) {
      try {
        this.child.stdin.end()
      } catch {
        /* ignore */
      }
    }
    killTree(pid)
    this.child = null
  }

  /** 主动销毁（插件卸载 / 会话关闭）。 */
  dispose() {
    this.disposedByOwner = true
    const pid = this.pid
    try {
      if (this.child && this.child.stdin.writable) {
        this.child.stdin.write(JSON.stringify({ v: 1, type: "cmd", req_id: "bye", op: "shutdown", payload: {} }) + "\n")
      }
    } catch {
      /* ignore */
    }
    this._stopHeartbeat()
    // 给 300ms 优雅退出，然后强杀整棵树
    setTimeout(() => {
      if (this.child) killTree(pid)
      this.child = null
      this.dead = true
    }, 300)
    this.cleanup()
  }

  cleanup() {
    this._stopHeartbeat()
    for (const [, waiter] of this.pending) clearTimeout(waiter.timer)
    this.pending.clear()
  }
}

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""dsh-notebook-v2 sidecar：NDJSON over stdio 的 Jupyter 内核驱动。

协议规格：packages/dsh-notebook-v2/docs/protocol-ndjson.md
  stdin  <- 命令帧（一行一个 JSON）
  stdout -> 事件帧（一行一个 JSON，**只放协议**）
  stderr -> 人类日志（不参与协议）

两个模式：
  --echo   不启内核，只跑协议（用于协议层的白盒测试与 CI）
  默认      jupyter_client + ipykernel，内核消息是唯一真相源

设计约束（来自协议规格，改之前先读它）：
  * 必须 `python -u` 启动，否则块缓冲会把流式变成"攒满才吐"；
  * 任何日志/异常都只能走 stderr，stdout 出现非协议内容即视为 bug；
  * iopub 消息按 parent_header.msg_id 归 cell；归不到就归"刚结束的那个"（迟到尾包），
    再归不到就丢弃并记日志——**绝不猜**，猜错会把 A 格输出画到 B 格。
"""

import argparse
import base64
import json
import os
import queue
import sys
import tempfile
import threading
import time
import traceback

PROTOCOL_VERSION = 1

# 单条 stream 的攒批阈值：先到先发（8KB 或 20ms）
# 20ms 而不是 50ms：这是"首行到达"的下限开销，计划要求首行 P95 < 150ms，
# 攒批窗口每多 10ms 就直接吃在这个指标上。
STREAM_BATCH_BYTES = 8 * 1024
STREAM_BATCH_MS = 20
# 主循环在空闲时等命令的粒度。它同时是"输出泵"的最坏延迟，
# 所以不能用 100ms —— 那会把每次 flush 人为推后最多 100ms。
CMD_POLL_MS = 0.01
# 单条输出超过它就落盘（避免 8MB 单帧上限）。
# 图片阈值单独放大：matplotlib 一张 300dpi PNG 的 base64 常有三四百 KB，
# 用 256KB 一刀切会把**正常能渲染的图**也赶去落盘，用户看到的是一行
# 「大块输出已折叠 /tmp/nb2-xxxx.bin」，图没了（2026-11-11 真机）。
INLINE_LIMIT_TEXT = 256 * 1024
INLINE_LIMIT_IMAGE = 6 * 1024 * 1024
# 落盘目录：宿主通过 --spill-dir 传（默认系统 temp 下的固定子目录）。
# **不放工作区**：这是 base64 解码出来的中间产物，不是用户资产；每跑一次图就多一个文件，
# 工作区会被临时文件淹没，还会被 git 看到。放在 DSH 自己的缓存目录里，配可读回端点 + 定期清理。
SPILL_DIR = os.path.join(tempfile.gettempdir(), "dsh-nb2-spill")
_spill_seq = 0
# 每 cell 输出上限
CELL_MAX_CHARS = 50 * 1024 * 1024
CELL_MAX_LINES = 200000


def log(msg):
    """人类日志 → stderr。stdout 是协议专用。"""
    try:
        sys.stderr.write(str(msg) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def spill_write(mime, value):
    """把超过内联阈值的输出写进 SPILL_DIR，返回 (绝对路径, 原始字节数)。

    文件名带真实扩展名（.png/.svg/.txt…），用户在资源管理器里能认出来；
    宿主用 `/nb2/spill` 端点把它读回去渲染，前端不再只显示一行路径。
    """
    global _spill_seq
    os.makedirs(SPILL_DIR, exist_ok=True)
    ext = ".bin"
    raw = value.encode("utf-8")
    if mime.startswith("image/") and mime != "image/svg+xml":
        try:
            raw = base64.b64decode(value)
        except Exception:
            raw = value.encode("utf-8")
        ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}.get(mime, ".img")
    elif mime == "image/svg+xml":
        ext = ".svg"
    elif mime == "text/html":
        ext = ".html"
    elif mime == "application/json":
        ext = ".json"
    elif mime.startswith("text/"):
        ext = ".txt"
    _spill_seq += 1
    # 进程 id + 毫秒 + 序号：同一进程里连续两次生图也不会撞名
    name = "nb2-%d-%d-%d%s" % (os.getpid(), int(time.time() * 1000), _spill_seq, ext)
    path = os.path.join(SPILL_DIR, name)
    with open(path, "wb") as fh:
        fh.write(raw)
    return path, len(raw)


def force_utf8_stdio():
    """协议两端一律 UTF-8，**不看系统代码页**。

    真机 bug（2026-11-10，用户报「点了运行什么都没发生」）：
    `python -u` 从管道拿到的 stdin/stdout 用 locale 编码（本机 cp936/GBK），而宿主写的是
    UTF-8。于是

      1. 中文源码被 GBK + surrogateescape 解坏，进内核后变成 U+FFFD →
         `SyntaxError: invalid character '\ufffd'`（中文出现在关键字参数、变量名这些
         语法位置上时必炸；出现在字符串里则静默变成乱码输出）；
      2. 报错帧里带 U+FFFD，GBK 编不出来 → Emitter 的兜底 punish 成 os._exit(1)
         → 内核进程当场死掉；
      3. 宿主只看到 sidecar 退出、自动重启，没人把「在跑的那格」标成失败
         → UI 显示 idle、无输出、无报错，格子永远卡在 running。

    修法就是这一行：stdin 解不了就用 replace（坏帧交给 json.loads 去拒），
    stdout 编不了就用 backslashreplace（宁可难看，绝不以死兜底）。
    """
    for name, errors in (("stdin", "replace"), ("stdout", "backslashreplace"), ("stderr", "backslashreplace")):
        stream = getattr(sys, name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors=errors)
        except Exception as exc:  # 老 python / 已包装过的流：host 侧的 env 兜底
            log("reconfigure %s failed: %r" % (name, exc))


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


class Emitter:
    """把事件帧写到 stdout。全程一把锁，避免多线程交叉写坏一行。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._seq = 0

    def _write(self, frame):
        """写一帧。**只有真正的管道断了才退出**，编码错误降级重发。

        旧写法把所有异常都当「宿主没了」→ os._exit(1)。结果一条含 U+FFFD 的错误事件
        就能把整个内核打死（见 force_utf8_stdio 的注释）。管道断（EPIPE）才是真的该退。
        """
        line = dumps(frame) + "\n"
        try:
            sys.stdout.write(line)
            sys.stdout.flush()
            return True
        except UnicodeEncodeError as exc:
            # 走到这里说明 reconfigure 没生效（老解释器/流被包过）。ASCII 转义一定能写出去。
            log("stdout encode fallback (%r)" % (exc,))
            try:
                sys.stdout.write(json.dumps(frame, ensure_ascii=True, separators=(",", ":")) + "\n")
                sys.stdout.flush()
                return True
            except Exception as exc2:
                log("stdout write failed after fallback: %r" % (exc2,))
                os._exit(1)
        except Exception as exc:  # stdout 断了 = 宿主没了，尽快退出
            log("stdout write failed: %r" % (exc,))
            os._exit(1)

    def emit(self, name, payload=None, msg_id=None, reply_to=None, extra=None):
        self._seq += 1
        frame = {
            "v": PROTOCOL_VERSION,
            "type": "event",
            "id": "e%d" % self._seq,
            "ts": int(time.time() * 1000),
            "name": name,
            "payload": payload or {},
        }
        if msg_id:
            frame["msg_id"] = msg_id
        if reply_to:
            frame["reply_to"] = reply_to
        if extra:
            frame.update(extra)
        with self._lock:
            self._write(frame)

    def ack(self, req_id, payload=None):
        self.emit_control("ack", req_id, payload)

    def error(self, req_id, code, message):
        self.emit_control("error", req_id, {"code": code, "message": message})

    def emit_control(self, ftype, reply_to, payload=None):
        frame = {
            "v": PROTOCOL_VERSION,
            "type": ftype,
            "id": "c%d" % (self._seq + 1),
            "ts": int(time.time() * 1000),
            "reply_to": reply_to,
            "payload": payload or {},
        }
        with self._lock:
            self._write(frame)

    def ready(self, payload):
        self.emit_control("ready", None, payload)


# ─────────────────────────── stdin 读取 ───────────────────────────


def stdin_reader(cmd_queue):
    """独占 stdin，逐行解析成命令塞进队列。坏帧记日志后跳过，绝不退出。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except Exception as exc:
            log("bad frame skipped: %r (%s)" % (line[:200], exc))
            continue
        if not isinstance(frame, dict):
            log("non-object frame skipped")
            continue
        cmd_queue.put(frame)
    # stdin 关闭 = 宿主退出
    cmd_queue.put({"__eof__": True})


# ─────────────────────────── echo 模式 ───────────────────────────


def run_echo(emitter, cmd_queue):
    """协议白盒：不碰内核，用固定的假数据跑通所有帧形状。"""
    emitter.ready({"pid": os.getpid(), "mode": "echo", "python": sys.version.split()[0]})
    emitter.emit("kernel.state", {"state": "idle"})

    while True:
        try:
            frame = cmd_queue.get(timeout=0.1)
        except queue.Empty:
            continue
        if frame.get("__eof__"):
            return 0

        req_id = frame.get("req_id")
        op = frame.get("op")
        payload = frame.get("payload") or {}
        cell_id = payload.get("cellId") or "echo-cell"

        if op == "ping":
            emitter.ack(req_id, {"pong": True})
        elif op == "execute":
            code = payload.get("code") or ""
            emitter.emit("cell.started", {"cellId": cell_id, "execCount": 1}, msg_id="echo-1")
            # 故意分成两帧发：测试要能区分"逐条到达"与"攒齐一次"
            for i, line in enumerate(code.splitlines() or ["echo"]):
                emitter.emit(
                    "stream",
                    {"cellId": cell_id, "name": "stdout", "text": line + "\n"},
                    msg_id="echo-1",
                )
            emitter.emit(
                "cell.done",
                {"cellId": cell_id, "status": "ok", "execCount": 1, "durationMs": 1},
                msg_id="echo-1",
            )
            emitter.ack(req_id, {"msgId": "echo-1"})
        elif op == "interrupt":
            emitter.ack(req_id, {"ok": True})
        elif op == "restart":
            emitter.emit("kernel.state", {"state": "starting"})
            emitter.emit("kernel.state", {"state": "idle"})
            emitter.ack(req_id, {"ok": True})
        elif op == "shutdown":
            emitter.ack(req_id, {"ok": True})
            return 0
        elif op == "complete":
            emitter.ack(req_id, {"matches": [], "cursorStart": 0, "cursorEnd": 0})
        elif op == "inspect":
            emitter.ack(req_id, {"found": False})
        else:
            emitter.error(req_id, "E_UNKNOWN_OP", "unknown op: %r" % (op,))


# ─────────────────────────── 真内核模式 ───────────────────────────


class KernelRunner:
    """jupyter_client 驱动。单线程事件泵 + 独立的 stdin 线程。"""

    def __init__(self, emitter, cwd=None, kernel_name=None):
        self.emitter = emitter
        self.cwd = cwd
        self.kernel_name = kernel_name
        self.km = None
        self.client = None
        # cellId <-> msg_id 双向映射
        self.cell_of_msg = {}
        self.msg_of_cell = {}
        self.live_cells = {}
        self.last_msg_id = None
        # 执行元信息
        self.exec_meta = {}  # cellId -> {start, execCount}
        # 请求/回应：complete / inspect
        self.pending_requests = {}  # msg_id -> req_id
        # stream 攒批： (cellId, name) -> {buf, firstAt}
        self.stream_bufs = {}
        self.cell_out_bytes = {}
        self.cell_out_lines = {}
        self.truncated = set()

    # ── 内核生命周期 ──
    def start(self):
        from jupyter_client.manager import KernelManager

        # 先把「正在起」报出去：冷启动 3s 左右，UI 必须能显示"启动中"而不是干等（计划 §8 风险项）
        self.emitter.emit("kernel.state", {"state": "starting"})
        kwargs = {}
        if self.kernel_name:
            kwargs["kernel_name"] = self.kernel_name
        self.km = KernelManager(**kwargs)
        if self.cwd:
            os.makedirs(self.cwd, exist_ok=True)
            self.km.start_kernel(cwd=self.cwd)
        else:
            self.km.start_kernel()
        self.client = self.km.client()
        self.client.start_channels()
        try:
            self.client.wait_for_ready(timeout=30)
        except Exception as exc:
            log("kernel wait_for_ready failed: %r" % (exc,))
            self.emitter.emit("kernel.state", {"state": "dead"})
            raise
        self.emitter.emit(
            "kernel.state",
            {"state": "idle", "pid": self.km.provisioner.pid if self.km.provisioner else None},
        )
        self._bootstrap()

    def _bootstrap(self):
        """
        内核启动后的静默调参。

        为什么必须做：ipykernel 的 `OutStream.flush_interval` 默认 **0.2s**，
        也就是 `print()` 出来的内容在内核里先攒 200ms 才发到 iopub。
        这是"输出冒字"粒度的硬下限 —— 不改它，UI 上永远是每 200ms 跳一批，
        计划里「首行 stdout P95 < 150ms」也不可能达标。

        改成 0.02s：IO 线程每 20ms 冲一次，配合我们自己 20ms 的攒批，
        端到端首行延迟落在 ~40ms 量级。
        silent=True + store_history=False：不占执行序号、不产生输出、不进历史。
        """
        if not self.client:
            return
        snippet = (
            "try:\n"
            "    import ipykernel.iostream as _nb2_io\n"
            "    _nb2_io.OutStream.flush_interval = 0.02\n"
            "except Exception:\n"
            "    pass\n"
        )
        try:
            self.client.execute(snippet, silent=True, store_history=False, allow_stdin=False)
        except Exception as exc:
            log("bootstrap failed: %r" % (exc,))

    def interrupt(self):
        """请求中断；Windows 上不生效时降级为重启内核。

        ⚠️ 实测事实（2026-11-10，本机 ipykernel 7.2.0 + jupyter_client 8.8.0）：
        `km.interrupt_kernel()`（内部走 SetEvent 的 win32_interrupt_event）**不会**
        真的打断正在跑的 `time.sleep(20)`；直接 `send_interrupt(handle)` 也没反应。
        用户点「■ 中断」看到状态变成「已取消」，内核却还在跑，后面每一格都在排队 ——
        这又是一条「点了运行，什么都不发生」的来源。

        所以做两级：先按官方方式请求；1.5s 内没收敛就重启内核（restart 会把
        live_cells 收尾成 cancelled）。代价是变量丢失，日志里写明，别装作没发生。
        """
        if not self.km:
            return
        try:
            self.km.interrupt_kernel()
        except Exception as exc:
            log("interrupt_kernel failed: %r" % (exc,))
        deadline = time.time() + 1.5
        while time.time() < deadline:
            # 主循环被这次调用占住了，必须自己泵消息，否则 live_cells 永远不会清空
            try:
                self.pump()
            except Exception as exc:
                log("pump during interrupt failed: %r" % (exc,))
            if not self.live_cells:
                return
            time.sleep(0.05)
        if not self.live_cells:
            return
        log("interrupt 未生效（win32 interrupt event 没反应），降级为重启内核（变量会丢）")
        self.emitter.emit("kernel.state", {"state": "starting", "reason": "interrupt-escalated"})
        try:
            self.restart(now=True)
        except Exception as exc:
            log("interrupt escalation failed: %r" % (exc,))

    def restart(self, now=True):
        if not self.km:
            return
        # 重启前把在飞的状态清掉：旧内核不会再回消息
        for cell_id in list(self.live_cells):
            self.emitter.emit(
                "cell.done",
                {"cellId": cell_id, "status": "cancelled", "execCount": self._exec_count(cell_id), "durationMs": self._duration(cell_id)},
            )
        self.live_cells.clear()
        self.exec_meta.clear()
        self.cell_of_msg.clear()
        self.msg_of_cell.clear()
        self.stream_bufs.clear()
        self.emitter.emit("kernel.state", {"state": "starting"})
        self.km.restart_kernel(now=now)
        if self.client:
            try:
                self.client.stop_channels()
            except Exception:
                pass
        self.client = self.km.client()
        self.client.start_channels()
        try:
            self.client.wait_for_ready(timeout=30)
            self.emitter.emit("kernel.state", {"state": "idle"})
            self._bootstrap()
        except Exception as exc:
            log("restart wait_for_ready failed: %r" % (exc,))
            self.emitter.emit("kernel.state", {"state": "dead"})

    def shutdown(self):
        try:
            if self.client:
                self.client.stop_channels()
            if self.km:
                self.km.shutdown_kernel(now=True)
        except Exception as exc:
            log("shutdown error: %r" % (exc,))

    # ── 命令处理 ──
    def handle(self, frame):
        req_id = frame.get("req_id")
        op = frame.get("op")
        payload = frame.get("payload") or {}

        if op == "ping":
            self.emitter.ack(req_id, {"pong": True, "state": "running"})
        elif op == "execute":
            self.execute(payload, req_id)
        elif op == "interrupt":
            self.interrupt()
            self.emitter.ack(req_id, {"ok": True})
        elif op == "restart":
            self.restart(now=bool(payload.get("now", True)))
            self.emitter.ack(req_id, {"ok": True})
        elif op == "shutdown":
            self.shutdown()
            self.emitter.ack(req_id, {"ok": True})
            return True
        elif op == "complete":
            self.request_shell(req_id, "complete", payload)
        elif op == "inspect":
            self.request_shell(req_id, "inspect", payload)
        elif op == "state":
            self.emitter.ack(req_id, {"state": "running", "cells": list(self.live_cells)})
        else:
            self.emitter.error(req_id, "E_UNKNOWN_OP", "unknown op: %r" % (op,))
        return False

    def execute(self, payload, req_id):
        code = payload.get("code") or ""
        cell_id = payload.get("cellId") or ("cell-%d" % int(time.time() * 1000))
        if not self.client:
            self.emitter.error(req_id, "E_KERNEL_DEAD", "kernel not started")
            return
        try:
            msg_id = self.client.execute(
                code,
                silent=bool(payload.get("silent", False)),
                store_history=bool(payload.get("storeHistory", True)),
                allow_stdin=False,
                stop_on_error=True,
            )
        except Exception as exc:
            log("execute failed: %r" % (exc,))
            self.emitter.error(req_id, "E_KERNEL_DEAD", str(exc))
            self.emitter.emit("kernel.state", {"state": "dead"})
            return
        self.cell_of_msg[msg_id] = cell_id
        self.msg_of_cell[cell_id] = msg_id
        self.live_cells[cell_id] = msg_id
        self.exec_meta[cell_id] = {"start": time.time(), "execCount": None}
        # 不在这里 ack：ack 已在命令收下时就发了（冷启动不能拖慢 ack），
        # 调用方以 cell.started / cell.done 为准。

    def request_shell(self, req_id, kind, payload):
        code = payload.get("code") or ""
        pos = int(payload.get("cursorPos") or len(code))
        try:
            if kind == "complete":
                msg_id = self.client.complete(code, pos)
            else:
                detail = int(payload.get("detailLevel") or 0)
                msg_id = self.client.inspect(code, pos, detail_level=detail)
        except Exception as exc:
            self.emitter.error(req_id, "E_SHELL", str(exc))
            return
        self.pending_requests[msg_id] = (req_id, kind)
        self.emitter.ack(req_id, {"msgId": msg_id, "deferred": True})

    # ── 事件泵 ──
    def pump(self):
        """把 iopub/shell 里能拿到的消息全部处理掉，然后按需 flush stream 攒批。"""
        self._drain_iopub()
        self._drain_shell()
        self._flush_streams(force=False)

    def _drain_iopub(self):
        if not self.client:
            return
        while True:
            try:
                msg = self.client.get_iopub_msg(timeout=0)
            except queue.Empty:
                return
            except Exception as exc:
                log("iopub error: %r" % (exc,))
                return
            try:
                self._on_iopub(msg)
            except Exception:
                log("on_iopub crash:\n" + traceback.format_exc())

    def _drain_shell(self):
        if not self.client:
            return
        while True:
            try:
                msg = self.client.get_shell_msg(timeout=0)
            except queue.Empty:
                return
            except Exception as exc:
                log("shell error: %r" % (exc,))
                return
            try:
                self._on_shell(msg)
            except Exception:
                log("on_shell crash:\n" + traceback.format_exc())

    def _resolve_cell(self, msg):
        """按 parent msg_id 找 cell；找不到归 last（迟到尾包），再找不到返回 None。"""
        parent = (msg.get("parent_header") or {}).get("msg_id")
        cell_id = self.cell_of_msg.get(parent)
        if cell_id:
            return cell_id, parent
        # 迟到尾包：执行结束后才到的 iopub 仍归最近那个 cell
        if parent and parent == self.last_msg_id and self.live_cells:
            return self.live_cells.get(parent) or list(self.live_cells)[-1], parent
        if self.last_msg_id:
            cell_id = self.cell_of_msg.get(self.last_msg_id)
            if cell_id:
                return cell_id, self.last_msg_id
        return None, parent

    def _on_iopub(self, msg):
        msg_type = (msg.get("header") or {}).get("msg_type")
        content = msg.get("content") or {}
        cell_id, parent = self._resolve_cell(msg)

        if msg_type == "status":
            state = content.get("execution_state")
            if state in ("busy", "idle"):
                self.emitter.emit("kernel.state", {"state": state})
            return

        if msg_type == "execute_input":
            if cell_id:
                count = content.get("execution_count")
                self.exec_meta.setdefault(cell_id, {"start": time.time(), "execCount": None})
                self.exec_meta[cell_id]["execCount"] = count
                self.emitter.emit(
                    "cell.started",
                    {"cellId": cell_id, "execCount": count, "at": int(time.time() * 1000)},
                    msg_id=parent,
                )
            return

        if not cell_id:
            # 明确记一条，不猜归属
            self.emitter.emit(
                "stderr.log",
                {"text": "unattributed iopub %s (parent=%s)" % (msg_type, parent)},
            )
            return

        if msg_type == "stream":
            name = content.get("name") or "stdout"
            text = content.get("text") or ""
            self._buffer_stream(cell_id, name, text)
        elif msg_type in ("display_data", "update_display_data"):
            data = content.get("data") or {}
            transient = content.get("transient") or {}
            self._emit_display(
                cell_id,
                data,
                parent,
                display_id=transient.get("display_id"),
                update=(msg_type == "update_display_data"),
                out_id=transient.get("display_id"),
            )
        elif msg_type == "execute_result":
            data = content.get("data") or {}
            count = content.get("execution_count")
            if cell_id in self.exec_meta and count is not None:
                self.exec_meta[cell_id]["execCount"] = count
            out_id = "res-%s-%s" % (cell_id, parent)
            self._emit_display(cell_id, data, parent, kind="result", out_id=out_id)
        elif msg_type == "error":
            # 同理：traceback 之前先冲掉攒批的 stdout（print 完再抛错是常态）
            self._flush_streams(force=True, only_cell=cell_id)
            trace = content.get("traceback") or []
            self.emitter.emit(
                "error",
                {
                    "cellId": cell_id,
                    "ename": content.get("ename"),
                    "evalue": content.get("evalue"),
                    "traceback": [strip_ansi(t) for t in trace],
                },
                msg_id=parent,
            )

    def _on_shell(self, msg):
        msg_type = (msg.get("header") or {}).get("msg_type")
        parent = (msg.get("parent_header") or {}).get("msg_id")
        content = msg.get("content") or {}

        if msg_type == "execute_reply":
            cell_id = self.cell_of_msg.get(parent)
            if not cell_id:
                return
            self._flush_streams(force=True, only_cell=cell_id)
            meta = self.exec_meta.pop(cell_id, {"start": time.time(), "execCount": None})
            self.last_msg_id = parent
            self.live_cells.pop(cell_id, None)
            self.msg_of_cell.pop(cell_id, None)
            self.emitter.emit(
                "cell.done",
                {
                    "cellId": cell_id,
                    "status": content.get("status") or "ok",
                    "execCount": meta.get("execCount"),
                    "durationMs": int((time.time() - meta.get("start", time.time())) * 1000),
                },
                msg_id=parent,
            )
            # 记录执行历史，供 Node 侧写进 metadata.dsh2.executions
            self.emitter.emit(
                "cell.executed",
                {
                    "cellId": cell_id,
                    "execCount": meta.get("execCount"),
                    "status": content.get("status"),
                    "durationMs": int((time.time() - meta.get("start", time.time())) * 1000),
                    "finishedAt": int(time.time() * 1000),
                },
                msg_id=parent,
            )
            return

        pending = self.pending_requests.pop(parent, None)
        if not pending:
            return
        req_id, kind = pending
        if kind == "complete":
            matches = content.get("matches") or []
            cursor_start = content.get("cursor_start") or 0
            cursor_end = content.get("cursor_end") or 0
            self.emitter.ack(
                req_id,
                {"matches": matches, "cursorStart": cursor_start, "cursorEnd": cursor_end},
            )
        else:
            found = bool(content.get("found"))
            self.emitter.ack(
                req_id,
                {
                    "found": found,
                    "data": content.get("data") or {},
                    "metadata": content.get("metadata") or {},
                },
            )

    def _exec_count(self, cell_id):
        return (self.exec_meta.get(cell_id) or {}).get("execCount")

    def _duration(self, cell_id):
        start = (self.exec_meta.get(cell_id) or {}).get("start")
        return int((time.time() - start) * 1000) if start else None

    # ── stream 攒批 ──
    def _buffer_stream(self, cell_id, name, text):
        if not text:
            return
        key = (cell_id, name)
        buf = self.stream_bufs.get(key)
        now = time.time()
        if buf is None:
            buf = {"parts": [], "size": 0, "firstAt": now}
            self.stream_bufs[key] = buf
        buf["parts"].append(text)
        buf["size"] += len(text)
        if buf["size"] >= STREAM_BATCH_BYTES:
            self._flush_key(key)

    def _flush_streams(self, force=False, only_cell=None):
        now = time.time()
        due = []
        for key, buf in list(self.stream_bufs.items()):
            if only_cell and key[0] != only_cell:
                continue
            if force or (now - buf["firstAt"]) * 1000 >= STREAM_BATCH_MS:
                due.append(key)
        for key in due:
            self._flush_key(key)

    def _flush_key(self, key):
        buf = self.stream_bufs.pop(key, None)
        if not buf or not buf["parts"]:
            return
        cell_id, name = key
        text = "".join(buf["parts"])
        # 输出上限：超了截断一次，之后丢弃（避免 UI 被单一 cell 拖死）
        used = self.cell_out_bytes.get(cell_id, 0)
        lines = self.cell_out_lines.get(cell_id, 0) + text.count("\n")
        if used + len(text) > CELL_MAX_CHARS or lines > CELL_MAX_LINES:
            if cell_id not in self.truncated:
                self.truncated.add(cell_id)
                self.emitter.emit(
                    "stream",
                    {"cellId": cell_id, "name": name, "text": "…（输出超过上限，已截断）\n"},
                )
            return
        self.cell_out_bytes[cell_id] = used + len(text)
        self.cell_out_lines[cell_id] = lines
        self.emitter.emit("stream", {"cellId": cell_id, "name": name, "text": text})

    def _emit_display(self, cell_id, data, parent, kind="display", display_id=None, update=False, out_id=None):
        # 先把该 cell 攒着的 stream 冲出去：否则 50ms 攒批会让 stream 排到 display/result 之后，
        # UI 上就是「结果先出现、打印后出现」。顺序错了，用户第一眼就看出假。
        self._flush_streams(force=True, only_cell=cell_id)
        # 一个 display 里有多个 mime：全部原样发，由前端按优先级挑（照 vscode 的 orderOfMimeTypes）
        for mime, value in data.items():
            payload = {
                "cellId": cell_id,
                "mime": mime,
                "kind": kind,
                "outId": out_id or ("disp-%s-%s" % (cell_id, parent)),
            }
            if update:
                payload["update"] = True
            if display_id:
                payload["displayId"] = display_id
            limit = INLINE_LIMIT_IMAGE if mime.startswith("image/") else INLINE_LIMIT_TEXT
            if isinstance(value, str) and len(value) > limit:
                # 超大块（通常是几十 MB 的 base64 图）落盘，帧里只给路径 + 原始字节数
                try:
                    path, raw_bytes = spill_write(mime, value)
                    payload.update({"kind": "path", "path": path, "bytes": raw_bytes})
                except Exception as exc:
                    log("spill failed: %r" % (exc,))
                    payload["data"] = value[:limit]
                    payload["truncated"] = True
            else:
                payload["data"] = value
            self.emitter.emit("display", payload, msg_id=parent)


ANSI_RE = None


def strip_ansi(text):
    """traceback 里带 ANSI 颜色，前端不做终端渲染，直接剥掉。"""
    global ANSI_RE
    if ANSI_RE is None:
        import re

        ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
    return ANSI_RE.sub("", text)


# ─────────────────────────── 入口 ───────────────────────────


def main(argv=None):
    # ⚠️ 必须在读 stdin / 写 stdout 之前。见 force_utf8_stdio 的注释。
    force_utf8_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument("--echo", action="store_true", help="只跑协议，不启内核")
    parser.add_argument("--cwd", default=None, help="内核工作目录")
    parser.add_argument("--kernel-name", default=None, help="kernel spec 名（默认 python3）")
    parser.add_argument("--eager", action="store_true", help="启动即预热内核（宿主默认开启）")
    parser.add_argument("--session", default=None, help="会话 id，仅用于日志")
    parser.add_argument("--spill-dir", default=None, help="大块输出落盘目录（宿主给 DSH 缓存目录）")
    args = parser.parse_args(argv)

    global SPILL_DIR
    if args.spill_dir:
        SPILL_DIR = os.path.abspath(args.spill_dir)

    emitter = Emitter()
    # 排障用：这两行能一眼看出「协议两端是不是 UTF-8」，比复现一次崩溃快得多
    log(
        "stdio encoding: stdin=%s stdout=%s stderr=%s (utf-8 forced)"
        % (
            getattr(sys.stdin, "encoding", None),
            getattr(sys.stdout, "encoding", None),
            getattr(sys.stderr, "encoding", None),
        )
    )
    cmd_queue = queue.Queue()
    t = threading.Thread(target=stdin_reader, args=(cmd_queue,), daemon=True)
    t.start()

    if args.echo:
        return run_echo(emitter, cmd_queue)

    runner = None
    try:
        import ipykernel  # noqa: F401
    except Exception as exc:
        emitter.emit_control(
            "ready",
            None,
            {"pid": os.getpid(), "error": "E_IPYKERNEL_MISSING", "detail": str(exc)},
        )
        emitter.error(None, "E_IPYKERNEL_MISSING", "ipykernel not installed: %s" % exc)
        return 2

    runner = KernelRunner(emitter, cwd=args.cwd, kernel_name=args.kernel_name)
    emitter.ready(
        {
            "pid": os.getpid(),
            "mode": "kernel",
            "python": sys.version.split()[0],
            "cwd": args.cwd or os.getcwd(),
            "session": args.session,
            "started": False,
        }
    )

    started = False

    # 预热：宿主 spawn sidecar 时默认就起内核，让 3s 冷启动和用户「写第一格」重叠（计划 §8）
    if args.eager:
        try:
            runner.start()
            started = True
        except Exception as exc:
            log("eager start failed:\n" + traceback.format_exc())
            emitter.error(None, "E_KERNEL_DEAD", "eager start failed: %s" % exc)

    try:
        while True:
            # 命令优先：先处理完队列再泵输出
            drained = 0
            while drained < 64:
                try:
                    frame = cmd_queue.get(timeout=CMD_POLL_MS)
                except queue.Empty:
                    break
                drained += 1
                if frame.get("__eof__"):
                    return 0
                op = frame.get("op")
                needs_kernel = op in ("execute", "complete", "inspect")
                # execute 先 ack 再接内核：冷启动 3s 不能把 ack 拖成 3s（调用方看 cell.started 为准）
                if not started and needs_kernel and op == "execute":
                    payload = frame.get("payload") or {}
                    emitter.ack(
                        frame.get("req_id"),
                        {"accepted": True, "cellId": payload.get("cellId"), "coldStart": True},
                    )
                if not started and needs_kernel:
                    try:
                        runner.start()
                        started = True
                    except Exception as exc:
                        log("kernel start failed:\n" + traceback.format_exc())
                        emitter.error(
                            frame.get("req_id"), "E_KERNEL_DEAD", "kernel start failed: %s" % exc
                        )
                        continue
                if runner.handle(frame):
                    return 0

            if started:
                runner.pump()
            else:
                time.sleep(0.02)
    except KeyboardInterrupt:
        return 0
    finally:
        try:
            if runner:
                runner.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())

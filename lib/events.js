/**
 * 事件总线：单调 seq + 回放日志 + 每客户端游标。
 *
 * v2 的唯一出站口。设计约束见 docs/api-nb2.md §3：
 *   - seq 每会话单调递增；客户端按游标 after 续传，不丢不重；
 *   - 日志滚动（LOG_CAP）后游标过旧的客户端收 resync，必须清屏重建；
 *   - 慢客户端不能拖死别人：写失败只丢自己。
 */

export const LOG_CAP = 2000

export class EventBus {
  constructor({ logCap = LOG_CAP } = {}) {
    this.logCap = logCap
    this.seq = 0
    this.minSeq = 1
    this.log = []
    this.clients = new Set()
  }

  /** 推一条事件；返回带 seq 的帧。payload 直接展开进帧（前端按 ev 分派）。 */
  emit(ev, payload) {
    const frame = Object.assign({ seq: ++this.seq, at: Date.now(), ev }, payload || {})
    this.log.push(frame)
    if (this.log.length > this.logCap) {
      this.log.splice(0, this.log.length - this.logCap)
      this.minSeq = this.log[0].seq
    }
    for (const client of this.clients) {
      if (frame.seq <= client.cursor) continue
      try {
        client.write(frame)
        client.cursor = frame.seq
      } catch {
        this.clients.delete(client)
      }
    }
    return frame
  }

  /** 已滚出的最小 seq；调用方据此判断要不要发 resync。 */
  needsResync(cursor) {
    return cursor > 0 && cursor + 1 < this.minSeq
  }

  /** 回放 cursor 之后的所有事件。 */
  replay(cursor) {
    const out = []
    for (const frame of this.log) if (frame.seq > cursor) out.push(frame)
    return out
  }

  addClient(client) {
    this.clients.add(client)
    return () => this.clients.delete(client)
  }

  snapshot() {
    return { seq: this.seq, minSeq: this.minSeq, log: this.log.length, clients: this.clients.size }
  }
}

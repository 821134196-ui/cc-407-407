// 进程内任务队列:串行轮询 + 指数退避重试,负责离线暂存与上线补传。
// 任务同时落库 task_queue,进程重启后仍可继续补传。
import { nowIso } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TaskQueue {
  constructor(db, services, { pollMs = 250 } = {}) {
    this.db = db;
    this.svc = services;
    this.pollMs = pollMs;
    this.timer = null;
    this.running = false;
    // 当前离线的 ATM:补传前必须恢复在线,否则继续延后
    this.offlineAtmIds = new Set(
      db.prepare(`SELECT id FROM atms WHERE status='offline'`).all().map((r) => r.id)
    );
    this.handlers = {
      report_submit: (p) => this._handleReport(p)
    };
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => this._tick().catch(() => {}), this.pollMs);
    // 让事件循环不因该定时器保活而阻止退出
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setAtmOffline(atmId, offline) {
    if (offline) this.offlineAtmIds.add(atmId);
    else this.offlineAtmIds.delete(atmId);
  }

  // ATM 恢复在线:解除离线标记,并把该 ATM 积压(排队/退避/失败)的回传任务
  // 重置为立即到期,触发补传。
  rescheduleForAtm(atmId) {
    this.offlineAtmIds.delete(atmId);
    const rows = this.db
      .prepare(`SELECT id, payload FROM task_queue WHERE type='report_submit'
                AND status IN ('queued','failed','running')`)
      .all();
    let n = 0;
    for (const r of rows) {
      let p;
      try { p = JSON.parse(r.payload); } catch { continue; }
      if (Number(p.atmId) !== Number(atmId)) continue;
      this.db
        .prepare(
          `UPDATE task_queue SET status='queued', attempts=0, last_error=NULL, available_at=? WHERE id=?`
        )
        .run(nowIso(), r.id);
      n++;
    }
    return n;
  }

  // 入队。delayMs 用于模拟离线滞留;返回任务 id。
  enqueue(type, payload, { idempotencyKey = null, delayMs = 0 } = {}) {
    const available = new Date(Date.now() + delayMs).toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO task_queue(type, payload, idempotency_key, status, available_at, created_at)
         VALUES(?,?,?, 'queued', ?, ?)`
      )
      .run(type, JSON.stringify(payload), idempotencyKey, available, nowIso());
    return Number(r.lastInsertRowid);
  }

  size(status = null) {
    const row = status
      ? this.db.prepare('SELECT COUNT(*) AS n FROM task_queue WHERE status=?').get(status)
      : this.db.prepare('SELECT COUNT(*) AS n FROM task_queue').get();
    return row.n;
  }

  list() {
    return this.db.prepare('SELECT * FROM task_queue ORDER BY id DESC').all();
  }

  async _claimDue() {
    // 认领一条到期任务
    const t = this.db
      .prepare(
        `SELECT * FROM task_queue
         WHERE status='queued' AND available_at<=?
         ORDER BY id LIMIT 1`
      )
      .get(nowIso());
    if (!t) return null;
    const res = this.db
      .prepare(`UPDATE task_queue SET status='running', attempts=attempts+1 WHERE id=? AND status='queued'`)
      .run(t.id);
    return res.changes ? { ...t, attempts: t.attempts + 1 } : null;
  }

  // 清机回传处理:幂等键判重
  _handleReport(p) {
    const { employeeId, atmId, expectedFen = 0, entries = [], key,
      sealBrokenCassetteId = null } = p;

    // 重复回传:同幂等键已成功落单 => 记「重复回传」差额
    const prior = key
      ? this.db.prepare('SELECT * FROM clear_orders WHERE idempotency_key=?').get(key)
      : null;
    if (prior) {
      this.svc.raiseDiscrepancy(
        employeeId, prior.id, 'duplicate_report', '重复回传',
        `检测到幂等键 ${key} 的重复回传,已忽略重复数据`
      );
      return { duplicate: true, orderId: prior.id };
    }

    // ATM 仍离线:抛出可重试错误,延后补传
    if (this.offlineAtmIds.has(atmId)) {
      const e = new Error('ATM_OFFLINE');
      e.retryable = true;
      throw e;
    }

    const order = this.svc.createOrder(employeeId, atmId, expectedFen);
    if (key) {
      this.db.prepare('UPDATE clear_orders SET idempotency_key=? WHERE id=?').run(key, order.id);
    }
    const opts = {};
    if (sealBrokenCassetteId) opts.sealBrokenCassetteId = sealBrokenCassetteId;
    // 离线补传成功的数据,标记一条 ATM 离线差额(数据曾离线暂存)
    if (p.offlineCached) opts.atmOffline = true;
    this.svc.enterClearEntries(employeeId, order.id, entries, opts);
    return { duplicate: false, orderId: order.id };
  }

  async _processOne(t) {
    const handler = this.handlers[t.type];
    const payload = JSON.parse(t.payload);
    if (!handler) throw new Error(`未知任务类型 ${t.type}`);
    return handler(payload);
  }

  async _tick() {
    const t = await this._claimDue();
    if (!t) return;
    try {
      const result = await this._processOne(t);
      this.db
        .prepare(
          `UPDATE task_queue SET status=?, result=?, processed_at=?, last_error=NULL WHERE id=?`
        )
        .run(result && result.duplicate ? 'duplicate' : 'done',
          JSON.stringify(result || {}), nowIso(), t.id);
    } catch (e) {
      const retryable = e.retryable !== false && (e.retryable === true || e.message === 'ATM_OFFLINE');
      const attempts = t.attempts;
      if (retryable && attempts < t.max_attempts) {
        const backoff = Math.min(30000, 500 * 2 ** (attempts - 1));
        this.db
          .prepare(
            `UPDATE task_queue SET status='queued', last_error=?, available_at=? WHERE id=?`
          )
          .run(e.message, new Date(Date.now() + backoff).toISOString(), t.id);
      } else {
        this.db
          .prepare(`UPDATE task_queue SET status='failed', last_error=?, processed_at=? WHERE id=?`)
          .run(e.message, nowIso(), t.id);
      }
    }
  }

  // 立即处理所有到期任务(测试 / 上线后补传用)。resolve 时队列为空或全部阻塞于离线。
  async drain({ maxWaitMs = 3000 } = {}) {
    const start = Date.now();
    for (;;) {
      await this._tick();
      const pending = this.db
        .prepare(`SELECT COUNT(*) AS n FROM task_queue WHERE status IN ('queued','running')`)
        .get().n;
      if (!pending) break;
      // 仍有排队但可能是未到期(退避)或离线阻塞
      const due = this.db
        .prepare(`SELECT COUNT(*) AS n FROM task_queue WHERE status='queued' AND available_at<=?`)
        .get(nowIso()).n;
      if (!due || Date.now() - start > maxWaitMs) break;
      await sleep(20);
    }
  }
}

// 业务服务层:所有业务不变量集中于此,与 HTTP 解耦,可直接被测试调用。
import { genCode, nowIso, isoInDays } from './db.js';

export class BizError extends Error {
  constructor(message, status = 400, code = 'BIZ_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DISC_DUE_DAYS = {
  short: 2,
  over: 2,
  soiled: 5,
  seal_broken: 3,
  atm_offline: 1,
  duplicate_report: 7
};

export class Services {
  constructor(db) {
    this.db = db;
  }

  // ---------- 基础与权限 ----------
  getEmployee(id) {
    const e = this.db.prepare('SELECT * FROM employees WHERE id=?').get(id);
    if (!e) throw new BizError('员工不存在', 404, 'EMP_NOT_FOUND');
    if (!e.active) throw new BizError('员工已停用', 403, 'EMP_INACTIVE');
    return e;
  }

  // 网点权限:本网点员工或清算中心(HQ)可操作;其余拒绝
  assertBranch(employee, branchId) {
    if (employee.is_hq) return;
    if (employee.branch_id !== branchId) {
      throw new BizError(
        `跨网点越权:${employee.name} 不归属该网点,无法操作`,
        403,
        'BRANCH_FORBIDDEN'
      );
    }
  }

  assertBranchByEmployee(employeeId, branchId) {
    this.assertBranch(this.getEmployee(employeeId), branchId);
  }

  audit(actorId, action, entity, entityId, detail = {}, branchId = null) {
    this.db
      .prepare(
        `INSERT INTO audit_logs(actor_id, branch_id, action, entity, entity_id, detail, created_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(actorId, branchId, action, entity, entityId == null ? null : String(entityId),
        JSON.stringify(detail), nowIso());
  }

  // ---------- 查询 ----------
  listBranches() {
    return this.db.prepare('SELECT * FROM branches ORDER BY id').all();
  }
  listDenominations() {
    return this.db.prepare('SELECT * FROM denominations ORDER BY sort_order').all();
  }
  listEmployees(branchId = null) {
    if (branchId) {
      return this.db
        .prepare('SELECT * FROM employees WHERE branch_id=? OR is_hq=1 ORDER BY id')
        .all(branchId);
    }
    return this.db.prepare('SELECT * FROM employees ORDER BY id').all();
  }

  // ATM 台账(含网点名、钞箱数)
  listAtms(branchId = null) {
    const sql = `
      SELECT a.*, b.name AS branch_name,
        (SELECT COUNT(*) FROM cassettes c WHERE c.current_atm_id=a.id) AS cassette_count
      FROM atms a JOIN branches b ON b.id=a.branch_id
      ${branchId ? 'WHERE a.branch_id=?' : ''}
      ORDER BY a.branch_id, a.id`;
    return branchId
      ? this.db.prepare(sql).all(branchId)
      : this.db.prepare(sql).all();
  }

  listCassettes(branchId = null) {
    const sql = `
      SELECT c.*, d.value_fen, d.label AS denom_label,
        a.code AS atm_code, b.name AS branch_name,
        e.name AS claimed_by_name
      FROM cassettes c
      JOIN denominations d ON d.id=c.denomination_id
      LEFT JOIN atms a ON a.id=c.current_atm_id
      LEFT JOIN branches b ON b.id=c.current_branch_id
      LEFT JOIN employees e ON e.id=c.claimed_by
      ${branchId ? 'WHERE c.current_branch_id=? OR c.current_branch_id IS NULL' : ''}
      ORDER BY c.current_branch_id, a.id, c.id`;
    return branchId ? this.db.prepare(sql).all(branchId) : this.db.prepare(sql).all();
  }

  getCassette(id) {
    const c = this.db
      .prepare(
        `SELECT c.*, d.value_fen, d.label AS denom_label FROM cassettes c
         JOIN denominations d ON d.id=c.denomination_id WHERE c.id=?`
      )
      .get(id);
    if (!c) throw new BizError('钞箱不存在', 404, 'CASSETTE_NOT_FOUND');
    return c;
  }

  cassetteTrace(cassetteId) {
    return this.db
      .prepare(
        `SELECT t.*, e.name AS actor_name FROM cassette_trace t
         LEFT JOIN employees e ON e.id=t.actor_id
         WHERE t.cassette_id=? ORDER BY t.id`
      )
      .all(cassetteId);
  }

  // 券别汇总:按券别汇总某清机单(或全部)张数/金额
  denomSummary(orderId = null) {
    const where = orderId ? 'WHERE ce.order_id=?' : '';
    const rows = this.db
      .prepare(
        `SELECT d.id AS denomination_id, d.value_fen, d.label,
                SUM(ce.notes_count) AS notes_count,
                SUM(ce.soiled_notes) AS soiled_notes,
                SUM(ce.amount_fen) AS amount_fen
         FROM clear_entries ce
         JOIN denominations d ON d.id=ce.denomination_id
         ${where}
         GROUP BY d.id ORDER BY d.sort_order`
      )
      .all(...(orderId ? [orderId] : []));
    return rows;
  }

  // ---------- 钞箱:封签 / 位置 / 领取 ----------
  _trace(cassetteId, event, actorId, extra = {}) {
    const c = this.getCassette(cassetteId);
    this.db
      .prepare(
        `INSERT INTO cassette_trace(cassette_id, event, from_label, to_label, seal_no,
           seal_status, actor_id, detail, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        cassetteId, event, extra.from_label ?? null, extra.to_label ?? null,
        extra.seal_no ?? c.seal_no, extra.seal_status ?? c.seal_status,
        actorId, extra.detail ? JSON.stringify(extra.detail) : null, nowIso()
      );
  }

  // 封存(赋予封签号)
  sealCassette(employeeId, cassetteId, sealNo) {
    const emp = this.getEmployee(employeeId);
    const c = this.getCassette(cassetteId);
    if (c.seal_status === 'sealed')
      throw new BizError('钞箱已封存,请勿重复封存', 409, 'ALREADY_SEALED');
    if (!sealNo || !String(sealNo).trim())
      throw new BizError('封签号不能为空');
    const from = c.seal_status;
    this.db
      .prepare(
        `UPDATE cassettes SET seal_no=?, seal_status='sealed', status=
           CASE WHEN status='idle' THEN 'vault' ELSE status END WHERE id=?`
      )
      .run(String(sealNo).trim(), cassetteId);
    this._trace(cassetteId, 'seal', emp.id, {
      from_label: c.position_label,
      seal_no: String(sealNo).trim(),
      seal_status: 'sealed',
      detail: { prev: from }
    });
    this.audit(emp.id, 'cassette.seal', 'cassette', cassetteId, { sealNo }, c.current_branch_id);
    return this.getCassette(cassetteId);
  }

  // 开封/登记封签破损。破损封存钞箱不能直接改数量,须先登记破损。
  unsealCassette(employeeId, cassetteId, broken = false, reason = '') {
    const emp = this.getEmployee(employeeId);
    const c = this.getCassette(cassetteId);
    const newStatus = broken ? 'broken' : 'unsealed';
    this.db
      .prepare('UPDATE cassettes SET seal_status=? WHERE id=?')
      .run(newStatus, cassetteId);
    this._trace(cassetteId, broken ? 'seal_broken' : 'unseal', emp.id, {
      seal_status: newStatus,
      detail: { broken, reason, seal_no: c.seal_no }
    });
    this.audit(emp.id, broken ? 'cassette.seal_broken' : 'cassette.unseal',
      'cassette', cassetteId, { reason }, c.current_branch_id);
    return this.getCassette(cassetteId);
  }

  // 已封存钞箱不能直接改数量:改数量前必须非封存
  setCassetteNotes(employeeId, cassetteId, notes) {
    const emp = this.getEmployee(employeeId);
    const c = this.getCassette(cassetteId);
    if (c.seal_status === 'sealed') {
      throw new BizError(
        '钞箱已封存,不能直接修改数量;请先经授权开封',
        409,
        'SEALED_NO_MODIFY'
      );
    }
    this.db.prepare('UPDATE cassettes SET loaded_notes=? WHERE id=?').run(notes, cassetteId);
    this._trace(cassetteId, 'set_notes', emp.id, { detail: { notes } });
    return this.getCassette(cassetteId);
  }

  // 原子领取:条件更新,只有 claimed_by IS NULL 时成功 => 并发仅一人成功
  claimCassette(employeeId, cassetteId) {
    const emp = this.getEmployee(employeeId);
    const c = this.getCassette(cassetteId);
    const ts = nowIso();
    const res = this.db
      .prepare(
        `UPDATE cassettes SET claimed_by=?, claimed_at=?
         WHERE id=? AND claimed_by IS NULL`
      )
      .run(emp.id, ts, cassetteId);
    if (res.changes === 0) {
      const holder = this.db
        .prepare('SELECT claimed_by FROM cassettes WHERE id=?')
        .get(cassetteId);
      const h = holder.claimed_by
        ? this.db.prepare('SELECT name FROM employees WHERE id=?').get(holder.claimed_by)
        : null;
      throw new BizError(
        `钞箱已被${h ? h.name : '他人'}领取,领取失败`,
        409,
        'CASSETTE_CLAIMED'
      );
    }
    this._trace(cassetteId, 'claim', emp.id, { detail: { by: emp.name } });
    this.audit(emp.id, 'cassette.claim', 'cassette', cassetteId, {}, c.current_branch_id);
    return { ok: true, cassette: this.getCassette(cassetteId) };
  }

  // 异步领取(模拟两名员工"同时"操作):让出事件循环后再做条件更新
  async claimCassetteAsync(employeeId, cassetteId, delayMs = 0) {
    await new Promise((r) => setTimeout(r, delayMs));
    return this.claimCassette(employeeId, cassetteId);
  }

  releaseCassette(employeeId, cassetteId) {
    const emp = this.getEmployee(employeeId);
    this.db
      .prepare('UPDATE cassettes SET claimed_by=NULL, claimed_at=NULL WHERE id=? AND claimed_by=?')
      .run(cassetteId, emp.id);
    this._trace(cassetteId, 'release', emp.id, {});
    return this.getCassette(cassetteId);
  }

  // ---------- 装钞计划 ----------
  createPlan(employeeId, atmId, items = [], notes = '') {
    const emp = this.getEmployee(employeeId);
    const atm = this.db.prepare('SELECT * FROM atms WHERE id=?').get(atmId);
    if (!atm) throw new BizError('ATM 不存在', 404, 'ATM_NOT_FOUND');
    this.assertBranch(emp, atm.branch_id);
    if (!items.length) throw new BizError('装钞计划至少包含一个钞箱');

    const code = genCode('LP');
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      const r = tx
        .prepare(
          `INSERT INTO load_plans(code, atm_id, branch_id, status, notes, created_by, created_at)
           VALUES(?,?,?, 'draft', ?,?,?)`
        )
        .run(code, atm.id, atm.branch_id, notes, emp.id, nowIso());
      const planId = Number(r.lastInsertRowid);
      const ins = tx.prepare(
        'INSERT INTO load_plan_items(plan_id, cassette_id, notes_count) VALUES(?,?,?)'
      );
      const seen = new Set();
      for (const it of items) {
        if (seen.has(it.cassetteId))
          throw new BizError('同一计划内钞箱重复');
        seen.add(it.cassetteId);
        const cas = tx.prepare('SELECT * FROM cassettes WHERE id=?').get(it.cassetteId);
        if (!cas) throw new BizError('钞箱不存在', 404);
        const cnt = Number(it.notesCount || 0);
        if (cnt < 0) throw new BizError('装钞张数不能为负');
        if (cnt > cas.capacity_notes)
          throw new BizError(`钞箱 ${cas.code} 超过容量 ${cas.capacity_notes} 张`);
        ins.run(planId, it.cassetteId, cnt);
      }
      tx.exec('COMMIT');
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
    this.audit(emp.id, 'plan.create', 'load_plan', null, { atmId }, atm.branch_id);
    return this.getPlanByCode(code);
  }

  getPlan(id) {
    const p = this.db
      .prepare(
        `SELECT p.*, a.code AS atm_code, a.name AS atm_name, b.name AS branch_name,
                le.name AS locked_by_name
         FROM load_plans p
         JOIN atms a ON a.id=p.atm_id
         JOIN branches b ON b.id=p.branch_id
         LEFT JOIN employees le ON le.id=p.locked_by
         WHERE p.id=?`
      )
      .get(id);
    if (!p) throw new BizError('装钞计划不存在', 404, 'PLAN_NOT_FOUND');
    p.items = this.db
      .prepare(
        `SELECT pi.*, c.code AS cassette_code, c.seal_no, c.seal_status,
                d.label AS denom_label, d.value_fen
         FROM load_plan_items pi
         JOIN cassettes c ON c.id=pi.cassette_id
         JOIN denominations d ON d.id=c.denomination_id
         WHERE pi.plan_id=? ORDER BY pi.id`
      )
      .all(id);
    return p;
  }
  getPlanByCode(code) {
    const p = this.db.prepare('SELECT id FROM load_plans WHERE code=?').get(code);
    return p ? this.getPlan(p.id) : null;
  }
  listPlans(status = null) {
    const rows = status
      ? this.db.prepare('SELECT id FROM load_plans WHERE status=? ORDER BY id').all(status)
      : this.db.prepare('SELECT id FROM load_plans ORDER BY id DESC').all();
    return rows.map((r) => this.getPlan(r.id));
  }

  // 锁定计划:锁定后不可增删改明细
  lockPlan(employeeId, planId) {
    const emp = this.getEmployee(employeeId);
    const plan = this.getPlan(planId);
    this.assertBranch(emp, plan.branch_id);
    if (plan.status !== 'draft')
      throw new BizError(`计划当前为 ${plan.status},仅草稿可锁定`, 409, 'PLAN_NOT_DRAFT');
    this.db
      .prepare(
        `UPDATE load_plans SET status='locked', locked_by=?, locked_at=? WHERE id=?`
      )
      .run(emp.id, nowIso(), planId);
    this.audit(emp.id, 'plan.lock', 'load_plan', planId, {}, plan.branch_id);
    return this.getPlan(planId);
  }

  // 编辑明细:仅草稿可改(锁定后冻结)
  updatePlanItem(employeeId, planId, itemId, notesCount) {
    const emp = this.getEmployee(employeeId);
    const plan = this.getPlan(planId);
    this.assertBranch(emp, plan.branch_id);
    if (plan.status !== 'draft')
      throw new BizError('计划已锁定,明细不可修改', 409, 'PLAN_LOCKED');
    this.db.prepare('UPDATE load_plan_items SET notes_count=? WHERE id=? AND plan_id=?')
      .run(notesCount, itemId, planId);
    return this.getPlan(planId);
  }

  // 执行装钞:计划必须已锁定;封存钞箱由系统授权开封后装入,再重新封存并留痕
  executePlan(employeeId, planId) {
    const emp = this.getEmployee(employeeId);
    const plan = this.getPlan(planId);
    this.assertBranch(emp, plan.branch_id);
    if (plan.status !== 'locked')
      throw new BizError('装钞前必须先锁定计划', 409, 'PLAN_NOT_LOCKED');

    const tx = this.db;
    tx.exec('BEGIN');
    try {
      for (const it of plan.items) {
        const cas = tx.prepare('SELECT * FROM cassettes WHERE id=?').get(it.cassette_id);
        if (cas.seal_status === 'sealed') {
          // 已封存不能直接改数量:授权开封 -> 改数量 -> 重新封存
          tx.prepare(`UPDATE cassettes SET seal_status='unsealed' WHERE id=?`).run(cas.id);
          tx.prepare(
            `INSERT INTO cassette_trace(cassette_id,event,from_label,to_label,seal_no,seal_status,actor_id,detail,created_at)
             VALUES(?,?,?,?,?,?,?,?,?)`
          ).run(cas.id, 'unseal', cas.position_label, cas.position_label, cas.seal_no,
            'unsealed', emp.id, JSON.stringify({ reason: '执行装钞计划,授权开封' }), nowIso());
        }
        const newSeal = genCode('SEAL');
        tx.prepare(
          `UPDATE cassettes SET loaded_notes=?, seal_no=?, seal_status='sealed',
             status='loaded', current_atm_id=?, current_branch_id=?,
             position_label=?, claimed_by=NULL, claimed_at=NULL WHERE id=?`
        ).run(it.notes_count, newSeal, plan.atm_id, plan.branch_id,
          `ATM ${plan.atm_code} 钞箱`, cas.id);
        tx.prepare(
          `INSERT INTO cassette_trace(cassette_id,event,from_label,to_label,seal_no,seal_status,actor_id,detail,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`
        ).run(cas.id, 'load', cas.position_label, `ATM ${plan.atm_code}`, newSeal,
          'sealed', emp.id, JSON.stringify({ notes: it.notes_count }), nowIso());
      }
      tx.prepare(`UPDATE load_plans SET status='completed', completed_at=? WHERE id=?`)
        .run(nowIso(), planId);
      tx.exec('COMMIT');
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
    this.audit(emp.id, 'plan.execute', 'load_plan', planId, {}, plan.branch_id);
    return this.getPlan(planId);
  }

  // ---------- 清机单 ----------
  createOrder(employeeId, atmId, expectedTotalFen = 0) {
    const emp = this.getEmployee(employeeId);
    const atm = this.db.prepare('SELECT * FROM atms WHERE id=?').get(atmId);
    if (!atm) throw new BizError('ATM 不存在', 404);
    this.assertBranch(emp, atm.branch_id);
    const code = genCode('CL');
    const r = this.db
      .prepare(
        `INSERT INTO clear_orders(code, atm_id, branch_id, status, expected_total_fen,
            created_by, started_at, created_at)
         VALUES(?,?,?, 'open', ?,?,?,?)`
      )
      .run(code, atm.id, atm.branch_id, expectedTotalFen, emp.id, nowIso(), nowIso());
    const orderId = Number(r.lastInsertRowid);
    this.audit(emp.id, 'order.create', 'clear_order', orderId, { atmId }, atm.branch_id);
    return this.getOrder(orderId);
  }

  getOrder(id) {
    const o = this.db
      .prepare(
        `SELECT o.*, a.code AS atm_code, a.name AS atm_name, a.status AS atm_status,
                b.name AS branch_name,
                ce.name AS created_by_name, cl.name AS closed_by_name
         FROM clear_orders o
         JOIN atms a ON a.id=o.atm_id
         JOIN branches b ON b.id=o.branch_id
         LEFT JOIN employees ce ON ce.id=o.created_by
         LEFT JOIN employees cl ON cl.id=o.closed_by
         WHERE o.id=?`
      )
      .get(id);
    if (!o) throw new BizError('清机单不存在', 404, 'ORDER_NOT_FOUND');
    o.entries = this.db
      .prepare(
        `SELECT ce.*, d.value_fen, d.label AS denom_label, d.sort_order
         FROM clear_entries ce JOIN denominations d ON d.id=ce.denomination_id
         WHERE ce.order_id=? ORDER BY d.sort_order`
      )
      .all(id);
    o.confirms = this.db
      .prepare(
        `SELECT rc.*, e.name AS employee_name FROM review_confirms rc
         JOIN employees e ON e.id=rc.employee_id WHERE rc.order_id=? ORDER BY rc.id`
      )
      .all(id);
    o.discrepancies = this.db
      .prepare('SELECT * FROM discrepancies WHERE order_id=? ORDER BY id').all(id);
    return o;
  }
  getOrderByKey(key) {
    const o = this.db.prepare('SELECT id FROM clear_orders WHERE idempotency_key=?').get(key);
    return o ? this.getOrder(o.id) : null;
  }
  listOrders() {
    return this.db.prepare('SELECT id FROM clear_orders ORDER BY id DESC').all()
      .map((r) => this.getOrder(r.id));
  }

  // 逐券别录入实点;重算合计并生成/更新 短款/长款/残钞 差额
  enterClearEntries(employeeId, orderId, entries, opts = {}) {
    const emp = this.getEmployee(employeeId);
    const order = this.getOrder(orderId);
    this.assertBranch(emp, order.branch_id);
    if (order.status === 'closed')
      throw new BizError('清机单已关闭,不能再录入', 409, 'ORDER_CLOSED');

    const tx = this.db;
    tx.exec('BEGIN');
    try {
      tx.prepare('DELETE FROM clear_entries WHERE order_id=?').run(orderId);
      const ins = tx.prepare(
        `INSERT INTO clear_entries(order_id, denomination_id, notes_count, soiled_notes, amount_fen)
         VALUES(?,?,?,?,?)`
      );
      let counted = 0;
      let soiledTotal = 0;
      const seen = new Set();
      for (const e of entries) {
        if (seen.has(e.denominationId)) throw new BizError('同一券别重复录入');
        seen.add(e.denominationId);
        const d = tx.prepare('SELECT * FROM denominations WHERE id=?').get(e.denominationId);
        if (!d) throw new BizError('券别不存在');
        const notes = Number(e.notesCount || 0);
        const soiled = Number(e.soiledNotes || 0);
        if (notes < 0 || soiled < 0) throw new BizError('张数不能为负');
        if (soiled > notes) throw new BizError(`${d.label} 残钞张数不能多于实点张数`);
        const amount = notes * d.value_fen;
        counted += amount;
        soiledTotal += soiled;
        ins.run(orderId, d.id, notes, soiled, amount);
      }
      tx.prepare('UPDATE clear_orders SET counted_total_fen=?, status=? WHERE id=?')
        .run(counted, order.status === 'open' ? 'reviewing' : order.status, orderId);

      // 重建金额类差额(短款/长款/残钞),保留其它类型
      tx.prepare(
        `DELETE FROM discrepancies WHERE order_id=? AND type IN ('short','over','soiled')`
      ).run(orderId);
      this._raiseDiff(tx, order, emp, counted - order.expected_total_fen);
      if (soiledTotal > 0) {
        this._insertDiff(tx, order, emp, 'soiled', 0, '残钞', `发现残钞 ${soiledTotal} 张`);
      }
      // 封签破损 / ATM 离线 由录入选项触发
      if (opts.sealBrokenCassetteId) {
        this._insertDiff(tx, order, emp, 'seal_broken', 0, '封签破损',
          `钞箱 #${opts.sealBrokenCassetteId} 封签破损`, opts.sealBrokenCassetteId);
      }
      if (opts.atmOffline) {
        this._insertDiff(tx, order, emp, 'atm_offline', 0, 'ATM 离线',
          '清机时 ATM 处于离线状态,数据离线暂存待补传');
      }
      tx.exec('COMMIT');
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
    this.audit(emp.id, 'order.enter', 'clear_order', orderId, { entries: entries.length },
      order.branch_id);
    return this.getOrder(orderId);
  }

  _raiseDiff(tx, order, emp, diffFen) {
    if (diffFen === 0) return;
    if (diffFen < 0) {
      this._insertDiff(tx, order, emp, 'short', diffFen, '短款',
        `实点少于账面 ${Math.abs(diffFen)} 分`);
    } else {
      this._insertDiff(tx, order, emp, 'over', diffFen, '长款',
        `实点多于账面 ${diffFen} 分`);
    }
  }

  _insertDiff(tx, order, emp, type, amountFen, title, detail, cassetteId = null) {
    const code = genCode('DC');
    tx.prepare(
      `INSERT INTO discrepancies(code, order_id, cassette_id, branch_id, type, amount_fen,
         title, detail, status, due_date, raised_by, raised_at)
       VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?)`
    ).run(code, order.id, cassetteId, order.branch_id, type, amountFen, title, detail,
      isoInDays(DISC_DUE_DAYS[type] ?? 3), emp.id, nowIso());
  }

  // 双人复核:两名不同员工签名
  addReview(employeeId, orderId, comment = '') {
    const emp = this.getEmployee(employeeId);
    const order = this.getOrder(orderId);
    this.assertBranch(emp, order.branch_id);
    const exists = this.db
      .prepare('SELECT id FROM review_confirms WHERE order_id=? AND employee_id=?')
      .get(orderId, emp.id);
    if (exists) throw new BizError('同一员工不能重复复核', 409, 'DUP_REVIEWER');
    this.db
      .prepare(
        `INSERT INTO review_confirms(order_id, employee_id, comment, created_at)
         VALUES(?,?,?,?)`
      )
      .run(orderId, emp.id, comment, nowIso());
    this.db.prepare(`UPDATE clear_orders SET status='reviewing' WHERE id=? AND status='open'`)
      .run(orderId);
    this.audit(emp.id, 'order.review', 'clear_order', orderId, { comment }, order.branch_id);
    return this.getOrder(orderId);
  }

  reviewComplete(order) {
    const ids = new Set(order.confirms.map((c) => c.employee_id));
    return ids.size >= 2;
  }

  // 差额处置(复核)
  resolveDiscrepancy(employeeId, discId, status, resolution) {
    const emp = this.getEmployee(employeeId);
    const d = this.db.prepare('SELECT * FROM discrepancies WHERE id=?').get(discId);
    if (!d) throw new BizError('差额记录不存在', 404);
    this.assertBranch(emp, d.branch_id);
    if (!['approved', 'adjusted', 'rejected'].includes(status))
      throw new BizError('处置状态非法');
    this.db
      .prepare(
        `UPDATE discrepancies SET status=?, resolved_by=?, resolved_at=?, resolution=? WHERE id=?`
      )
      .run(status, emp.id, nowIso(), resolution || null, discId);
    this.audit(emp.id, 'discrepancy.resolve', 'discrepancy', discId,
      { status, resolution }, d.branch_id);
    return this.db.prepare('SELECT * FROM discrepancies WHERE id=?').get(discId);
  }

  listDiscrepancies(branchId = null, status = null) {
    const where = [];
    const args = [];
    if (branchId) { where.push('d.branch_id=?'); args.push(branchId); }
    if (status) { where.push('d.status=?'); args.push(status); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT d.*, e.name AS raised_by_name, r.name AS resolved_by_name,
                o.code AS order_code
         FROM discrepancies d
         LEFT JOIN employees e ON e.id=d.raised_by
         LEFT JOIN employees r ON r.id=d.resolved_by
         LEFT JOIN clear_orders o ON o.id=d.order_id
         ${w} ORDER BY d.id DESC`
      )
      .all(...args);
  }

  // 关闭清机单:双人复核完成前禁止;且不得有未处置差额
  closeOrder(employeeId, orderId) {
    const emp = this.getEmployee(employeeId);
    const order = this.getOrder(orderId);
    this.assertBranch(emp, order.branch_id);
    if (!this.reviewComplete(order)) {
      throw new BizError(
        `复核未完成:需两名不同员工签名(当前 ${new Set(order.confirms.map((c) => c.employee_id)).size} 人)`,
        409,
        'REVIEW_INCOMPLETE'
      );
    }
    const pending = this.db
      .prepare(`SELECT COUNT(*) AS n FROM discrepancies WHERE order_id=? AND status='pending'`)
      .get(orderId).n;
    if (pending > 0)
      throw new BizError(`仍有 ${pending} 条差额未处置,不能关闭`, 409, 'PENDING_DISCREPANCY');
    this.db
      .prepare(
        `UPDATE clear_orders SET status='closed', closed_by=?, closed_at=? WHERE id=?`
      )
      .run(emp.id, nowIso(), orderId);
    this.audit(emp.id, 'order.close', 'clear_order', orderId, {}, order.branch_id);
    return this.getOrder(orderId);
  }

  // 系统/人工登记非金额类差额(ATM 离线、重复回传、封签破损)
  raiseDiscrepancy(employeeId, orderId, type, title, detail, cassetteId = null) {
    if (!DISC_DUE_DAYS[type]) throw new BizError('差额类型非法');
    const emp = this.getEmployee(employeeId);
    const order = this.getOrder(orderId);
    this.assertBranch(emp, order.branch_id);
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      this._insertDiff(tx, order, emp, type, 0, title, detail, cassetteId);
      tx.exec('COMMIT');
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
    this.audit(emp.id, 'discrepancy.raise', 'clear_order', orderId, { type, title },
      order.branch_id);
    return this.db
      .prepare('SELECT * FROM discrepancies WHERE order_id=? ORDER BY id DESC LIMIT 1')
      .get(orderId);
  }

  // 金额修正:保留原值/新值/原因/审批人
  // target: 'order_expected' 调整账面应缴;'clear_entry' 调整某券别实点(重算合计)
  adjustAmount(employeeId, { target, orderId, entryId = null, denominationId = null,
    newValueFen, reason, approverId }) {
    const emp = this.getEmployee(employeeId);
    const approver = this.getEmployee(approverId);
    if (emp.id === approver.id)
      throw new BizError('经办人与审批人不能为同一人', 409, 'SELF_APPROVE');
    if (!reason || !String(reason).trim()) throw new BizError('必须填写修正原因');
    const order = this.getOrder(orderId);
    this.assertBranch(emp, order.branch_id);
    this.assertBranch(approver, order.branch_id);
    if (order.status === 'closed') throw new BizError('清机单已关闭,不可修正', 409);

    let oldValue, targetId = null, denomId = denominationId;
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      if (target === 'order_expected') {
        oldValue = order.expected_total_fen;
        tx.prepare('UPDATE clear_orders SET expected_total_fen=? WHERE id=?')
          .run(newValueFen, orderId);
      } else if (target === 'clear_entry') {
        const en = tx.prepare('SELECT * FROM clear_entries WHERE id=? AND order_id=?')
          .get(entryId, orderId);
        if (!en) throw new BizError('券别录入明细不存在', 404);
        denomId = en.denomination_id;
        const d = tx.prepare('SELECT * FROM denominations WHERE id=?').get(denomId);
        oldValue = en.amount_fen;
        const newNotes = Math.trunc(newValueFen / d.value_fen);
        tx.prepare(
          `UPDATE clear_entries SET notes_count=?, amount_fen=? WHERE id=?`
        ).run(newNotes, newValueFen, en.id);
        targetId = en.id;
        const total = tx
          .prepare('SELECT COALESCE(SUM(amount_fen),0) AS t FROM clear_entries WHERE order_id=?')
          .get(orderId).t;
        tx.prepare('UPDATE clear_orders SET counted_total_fen=? WHERE id=?').run(total, orderId);
      } else {
        throw new BizError('未知修正目标');
      }
      tx.prepare(
        `INSERT INTO amount_adjustments(order_id, target_type, target_id, denomination_id,
           old_value_fen, new_value_fen, reason, created_by, approver_id, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(orderId, target, targetId, denomId, oldValue, newValueFen, reason,
        emp.id, approver.id, nowIso());

      // 重算短/长款差额
      const o2 = tx.prepare('SELECT * FROM clear_orders WHERE id=?').get(orderId);
      tx.prepare(`DELETE FROM discrepancies WHERE order_id=? AND type IN ('short','over')`)
        .run(orderId);
      const diff = o2.counted_total_fen - o2.expected_total_fen;
      if (diff !== 0) {
        const t = diff < 0 ? 'short' : 'over';
        this._insertDiff(tx, o2, emp, t, diff, diff < 0 ? '短款' : '长款',
          diff < 0 ? `实点少于账面 ${Math.abs(diff)} 分` : `实点多于账面 ${diff} 分`);
      }
      tx.exec('COMMIT');
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
    this.audit(emp.id, 'amount.adjust', 'clear_order', orderId,
      { target, oldValue, newValue: newValueFen, reason, approverId }, order.branch_id);
    return this.getOrder(orderId);
  }

  listAdjustments(orderId = null) {
    const where = orderId ? 'WHERE aa.order_id=?' : '';
    return this.db
      .prepare(
        `SELECT aa.*, e.name AS created_by_name, ap.name AS approver_name,
                d.label AS denom_label
         FROM amount_adjustments aa
         LEFT JOIN employees e ON e.id=aa.created_by
         LEFT JOIN employees ap ON ap.id=aa.approver_id
         LEFT JOIN denominations d ON d.id=aa.denomination_id
         ${where} ORDER BY aa.id DESC`
      )
      .all(...(orderId ? [orderId] : []));
  }

  // ---------- 钞箱交接(离开网点双人签收) ----------
  createHandover(employeeId, cassetteId, toBranchId = null, kind = 'leave_branch') {
    const emp = this.getEmployee(employeeId);
    const c = this.getCassette(cassetteId);
    this.assertBranch(emp, c.current_branch_id);
    if (c.seal_status !== 'sealed')
      throw new BizError('钞箱离开网点前必须封存', 409, 'NOT_SEALED');
    const code = genCode('HO');
    const r = this.db
      .prepare(
        `INSERT INTO handovers(code, cassette_id, from_branch_id, to_branch_id, kind, seal_no,
           status, initiator_id, created_at)
         VALUES(?,?,?,?,?,?,'pending',?,?)`
      )
      .run(code, cassetteId, c.current_branch_id, toBranchId, kind, c.seal_no, emp.id, nowIso());
    const id = Number(r.lastInsertRowid);
    this._trace(cassetteId, 'handout', emp.id, {
      from_label: c.position_label,
      detail: { handover: code }
    });
    this.audit(emp.id, 'handover.create', 'handover', id, { cassetteId }, c.current_branch_id);
    return this.getHandover(id);
  }

  getHandover(id) {
    const h = this.db
      .prepare(
        `SELECT h.*, c.code AS cassette_code, fb.name AS from_branch_name,
                tb.name AS to_branch_name, i.name AS initiator_name
         FROM handovers h
         JOIN cassettes c ON c.id=h.cassette_id
         LEFT JOIN branches fb ON fb.id=h.from_branch_id
         LEFT JOIN branches tb ON tb.id=h.to_branch_id
         LEFT JOIN employees i ON i.id=h.initiator_id
         WHERE h.id=?`
      )
      .get(id);
    if (!h) throw new BizError('交接单不存在', 404);
    h.signoffs = this.db
      .prepare(
        `SELECT hs.*, e.name AS employee_name FROM handover_signoffs hs
         JOIN employees e ON e.id=hs.employee_id WHERE hs.handover_id=? ORDER BY hs.id`
      )
      .all(id);
    return h;
  }
  listHandovers() {
    return this.db.prepare('SELECT id FROM handovers ORDER BY id DESC').all()
      .map((r) => this.getHandover(r.id));
  }

  // 签收:必须两名不同员工;第二签完成交接,钞箱离开网点
  signoffHandover(employeeId, handoverId) {
    const emp = this.getEmployee(employeeId);
    const h = this.getHandover(handoverId);
    this.assertBranch(emp, h.from_branch_id);
    if (h.status !== 'pending')
      throw new BizError('交接单已完结,不能再签收', 409, 'HANDOVER_DONE');
    const dup = this.db
      .prepare('SELECT id FROM handover_signoffs WHERE handover_id=? AND employee_id=?')
      .get(handoverId, emp.id);
    if (dup) throw new BizError('同一员工不能重复签收', 409, 'DUP_SIGNOFF');

    const tx = this.db;
    tx.exec('BEGIN');
    try {
      tx.prepare(
        `INSERT INTO handover_signoffs(handover_id, employee_id, created_at) VALUES(?,?,?)`
      ).run(handoverId, emp.id, nowIso());
      tx.prepare(
        `INSERT INTO cassette_trace(cassette_id,event,from_label,to_label,seal_no,seal_status,actor_id,detail,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      ).run(h.cassette_id, 'signoff', null, null, h.seal_no, 'sealed', emp.id,
        JSON.stringify({ by: emp.name }), nowIso());

      const count = tx
        .prepare('SELECT COUNT(*) AS n FROM handover_signoffs WHERE handover_id=?')
        .get(handoverId).n;
      if (count >= 2) {
        // 两名不同员工签收完成 -> 钞箱离开网点
        const c = tx.prepare('SELECT * FROM cassettes WHERE id=?').get(h.cassette_id);
        const dest = h.to_branch_id
          ? tx.prepare('SELECT name FROM branches WHERE id=?').get(h.to_branch_id).name
          : '中心金库';
        tx.prepare(
          `UPDATE cassettes SET status='transit', current_atm_id=NULL,
             current_branch_id=?, position_label=?, claimed_by=NULL, claimed_at=NULL WHERE id=?`
        ).run(h.to_branch_id, `押运在途 -> ${dest}`, h.cassette_id);
        tx.prepare(`UPDATE handovers SET status='completed', completed_at=? WHERE id=?`)
          .run(nowIso(), handoverId);
        tx.prepare(
          `INSERT INTO cassette_trace(cassette_id,event,from_label,to_label,seal_no,seal_status,actor_id,detail,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`
        ).run(h.cassette_id, 'locate', c.position_label, `押运在途 -> ${dest}`, h.seal_no,
          'sealed', emp.id, JSON.stringify({ handover: h.code }), nowIso());
      }
      tx.exec('COMMIT');
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
    this.audit(emp.id, 'handover.signoff', 'handover', handoverId, {}, h.from_branch_id);
    return this.getHandover(handoverId);
  }

  // ---------- 附件(本地目录) ----------
  saveAttachment(employeeId, orderId, filename, buffer, mime) {
    const emp = this.getEmployee(employeeId);
    const order = this.getOrder(orderId);
    this.assertBranch(emp, order.branch_id);
    return order; // 实际落盘在 attachments.js,这里仅权限校验入口
  }

  // ---------- 审计查询 ----------
  queryAudit({ branchId = null, action = null, entity = null, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (branchId) { where.push('a.branch_id=?'); args.push(branchId); }
    if (action) { where.push('a.action LIKE ?'); args.push(`%${action}%`); }
    if (entity) { where.push('a.entity=?'); args.push(entity); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(limit);
    return this.db
      .prepare(
        `SELECT a.*, e.name AS actor_name, b.name AS branch_name
         FROM audit_logs a
         LEFT JOIN employees e ON e.id=a.actor_id
         LEFT JOIN branches b ON b.id=a.branch_id
         ${w} ORDER BY a.id DESC LIMIT ?`
      )
      .all(...args);
  }

  setAtmStatus(employeeId, atmId, status) {
    const emp = this.getEmployee(employeeId);
    const atm = this.db.prepare('SELECT * FROM atms WHERE id=?').get(atmId);
    if (!atm) throw new BizError('ATM 不存在', 404);
    this.assertBranch(emp, atm.branch_id);
    if (!['online', 'offline', 'maintenance'].includes(status))
      throw new BizError('ATM 状态非法');
    this.db.prepare('UPDATE atms SET status=? WHERE id=?').run(status, atmId);
    this.audit(emp.id, 'atm.status', 'atm', atmId, { status }, atm.branch_id);
    return this.db.prepare('SELECT * FROM atms WHERE id=?').get(atmId);
  }
}

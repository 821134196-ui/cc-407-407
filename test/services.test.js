// 集成测试:券别汇总、钞箱锁定(计划冻结)、重复回传、双人复核、
// 金额修正留痕、网点权限,另加并发领取、双人签收、封存禁改等不变量。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDb, migrate, fenToYuan } from '../src/db.js';
import { Services, BizError } from '../src/services.js';
import { TaskQueue } from '../src/queue.js';
import { AttachmentStore } from '../src/attachments.js';

let db, svc, queue, att, seq;

function freshContext() {
  const dir = join(tmpdir(), `atm-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(dir, 't.db');
  const db = openDb(dbPath);
  migrate(db);
  const svc = new Services(db);
  const queue = new TaskQueue(db, svc, { pollMs: 1000 });
  const att = new AttachmentStore(db, svc, join(dir, 'att'));
  return { dir, db, svc, queue, att };
}

// 建最小档案:网点1/2,员工:1,2,3 属网点1;4 属网点2;6 属清算中心(HQ)
function seedBase() {
  const t = new Date().toISOString();
  db.prepare(`INSERT INTO branches(id,code,name,created_at) VALUES
    (1,'B1','城东支行',?),(2,'B2','高新支行',?),(3,'BHQ','清算中心',?)`).run(t, t, t);
  db.prepare(`INSERT INTO employees(id,code,name,branch_id,role,is_hq,active,created_at) VALUES
    (1,'E1','张伟',1,'柜员',0,1,?),(2,'E2','李娜',1,'库管员',0,1,?),
    (3,'E3','王强',1,'复核员',0,1,?),(4,'E4','赵敏',2,'柜员',0,1,?),
    (6,'E6','周明',3,'主管',1,1,?)`).run(t, t, t, t, t);
  db.prepare(`INSERT INTO denominations(id,value_fen,label,sort_order) VALUES
    (1,10000,'壹佰圆',1),(2,5000,'伍拾圆',2),(3,2000,'贰拾圆',3)`).run();
  db.prepare(`INSERT INTO atms(id,code,name,branch_id,status,created_at) VALUES
    (1,'A1','城东机',1,'online',?),(2,'A2','高新机',2,'online',?)`).run(t, t);
  const ins = db.prepare(
    `INSERT INTO cassettes(id,code,denomination_id,capacity_notes,loaded_notes,seal_no,seal_status,status,current_branch_id,position_label,created_at)
     VALUES(?,?,?,2500,0,NULL,'unsealed','idle',3,'清算中心金库',?)`);
  ins.run(1, 'BOX1', 1, t);
  ins.run(2, 'BOX2', 2, t);
  ins.run(3, 'BOX3', 1, t);
  return t;
}

beforeEach(() => {
  const c = freshContext();
  db = c.db; svc = c.svc; queue = c.queue; att = c.att;
  seedBase();
});

const fen = (y) => Math.round(y * 100);
const expectBiz = async (fn, code) => {
  try { await fn(); } catch (e) {
    assert.ok(e instanceof BizError, `应为 BizError,实际 ${e.constructor.name}: ${e.message}`);
    if (code) assert.equal(e.code, code);
    return e;
  }
  assert.fail('应抛出业务错误但未抛出');
};

test('券别汇总:按券别正确汇总张数、残钞与金额', () => {
  const order = svc.createOrder(1, 1, fen(100000));
  svc.enterClearEntries(1, order.id, [
    { denominationId: 1, notesCount: 800, soiledNotes: 2 },
    { denominationId: 2, notesCount: 300, soiledNotes: 1 }
  ]);
  const sum = svc.denomSummary(order.id);
  const d100 = sum.find((s) => s.denomination_id === 1);
  const d50 = sum.find((s) => s.denomination_id === 2);
  assert.equal(d100.notes_count, 800);
  assert.equal(d100.soiled_notes, 2);
  assert.equal(d100.amount_fen, fen(80000));
  assert.equal(d50.amount_fen, fen(15000));
  const total = sum.reduce((s, x) => s + x.amount_fen, 0);
  assert.equal(total, fen(95000));
});

test('装钞计划锁定后不可改明细,未锁定不可执行', () => {
  const plan = svc.createPlan(2, 1, [{ cassetteId: 1, notesCount: 100 }]);
  // 草稿可改
  svc.updatePlanItem(2, plan.id, plan.items[0].id, 120);
  assert.equal(svc.getPlan(plan.id).items[0].notes_count, 120);
  svc.lockPlan(2, plan.id);
  expectBiz(() => svc.updatePlanItem(2, plan.id, plan.items[0].id, 130), 'PLAN_LOCKED');
  // 锁定后执行成功
  svc.executePlan(2, plan.id);
  assert.equal(svc.getPlan(plan.id).status, 'completed');
});

test('装钞必须先锁定:草稿状态执行被拒(独立单)', () => {
  const plan = svc.createPlan(2, 1, [{ cassetteId: 1, notesCount: 10 }]);
  expectBiz(() => svc.executePlan(2, plan.id), 'PLAN_NOT_LOCKED');
});

test('锁定计划执行装钞:钞箱封存、入机、数量正确', () => {
  const plan = svc.createPlan(2, 1, [
    { cassetteId: 1, notesCount: 100 }, { cassetteId: 2, notesCount: 50 }
  ]);
  svc.lockPlan(2, plan.id);
  svc.executePlan(2, plan.id);
  const c1 = svc.getCassette(1);
  assert.equal(c1.seal_status, 'sealed');
  assert.ok(c1.seal_no);
  assert.equal(c1.status, 'loaded');
  assert.equal(c1.current_atm_id, 1);
  assert.equal(c1.loaded_notes, 100);
  assert.equal(svc.getPlan(plan.id).status, 'completed');
});

test('已封存钞箱不能直接改数量', () => {
  svc.sealCassette(2, 3, 'SEAL-X1');
  expectBiz(() => svc.setCassetteNotes(2, 3, 99), 'SEALED_NO_MODIFY');
  // 授权开封后可改
  svc.unsealCassette(2, 3, false, '装钞');
  svc.setCassetteNotes(2, 3, 99);
  assert.equal(svc.getCassette(3).loaded_notes, 99);
});

test('两名员工同时领取同一钞箱,仅一人成功', async () => {
  // 串行条件更新互斥
  svc.claimCassette(1, 1);
  await expectBiz(() => svc.claimCassette(2, 1), 'CASSETTE_CLAIMED');

  // 释放后可被他人领取
  svc.releaseCassette(1, 1);
  svc.claimCassette(2, 1);
  assert.equal(svc.getCassette(1).claimed_by, 2);
  svc.releaseCassette(2, 1);

  // 真并发:两名员工在同一时刻发起,只有一人 changes=1
  const results = await Promise.allSettled([
    svc.claimCassetteAsync(1, 1, 5),
    svc.claimCassetteAsync(2, 1, 5)
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'CASSETTE_CLAIMED');
});

test('双人复核:同一人不能重复;未满两人不能关闭清机单', () => {
  const order = svc.createOrder(1, 1, fen(1000));
  svc.enterClearEntries(1, order.id, [{ denominationId: 1, notesCount: 10, soiledNotes: 0 }]);
  svc.addReview(1, order.id, 'first');
  expectBiz(() => svc.addReview(1, order.id, 'again'), 'DUP_REVIEWER');
  // 仅一人,关闭被拒
  expectBiz(() => svc.closeOrder(2, order.id), 'REVIEW_INCOMPLETE');
  // 第二人复核后可关闭(账实相符无待处置差额)
  svc.addReview(2, order.id, 'second');
  const closed = svc.closeOrder(2, order.id);
  assert.equal(closed.status, 'closed');
  assert.ok(closed.closed_at);
});

test('存在未处置差额时即使双人复核也不能关闭', () => {
  const order = svc.createOrder(1, 1, fen(100000));
  svc.enterClearEntries(1, order.id, [{ denominationId: 1, notesCount: 999, soiledNotes: 0 }]); // 短款 100
  svc.addReview(1, order.id);
  svc.addReview(2, order.id);
  expectBiz(() => svc.closeOrder(2, order.id), 'PENDING_DISCREPANCY');
});

test('清机自动生成短款/长款/残钞差额且金额符号正确', () => {
  const short = svc.createOrder(1, 1, fen(100000));
  svc.enterClearEntries(1, short.id, [{ denominationId: 1, notesCount: 999, soiledNotes: 0 }]);
  const sd = svc.listDiscrepancies(1).find((d) => d.order_id === short.id);
  assert.equal(sd.type, 'short');
  assert.equal(sd.amount_fen, fen(-100));

  const over = svc.createOrder(1, 1, fen(100000));
  svc.enterClearEntries(1, over.id, [{ denominationId: 1, notesCount: 1001, soiledNotes: 0 }]);
  const od = svc.listDiscrepancies(1).find((d) => d.order_id === over.id);
  assert.equal(od.type, 'over');
  assert.equal(od.amount_fen, fen(100));

  const soil = svc.createOrder(1, 1, fen(1000));
  svc.enterClearEntries(1, soil.id, [{ denominationId: 1, notesCount: 10, soiledNotes: 3 }]);
  const sld = svc.listDiscrepancies(1).find((d) => d.order_id === soil.id && d.type === 'soiled');
  assert.ok(sld);
  assert.ok(sld.due_date); // 处理期限
});

test('金额修正保留原值、新值、原因、审批人,且经办审批不能同人', () => {
  const order = svc.createOrder(1, 1, fen(100000));
  svc.enterClearEntries(1, order.id, [
    { denominationId: 1, notesCount: 900, soiledNotes: 0 },
    { denominationId: 2, notesCount: 196, soiledNotes: 0 }
  ]);
  const entry = svc.getOrder(order.id).entries.find((e) => e.denomination_id === 2);
  const oldVal = entry.amount_fen;

  // 经办人=审批人被拒
  expectBiz(() => svc.adjustAmount(1, {
    target: 'clear_entry', orderId: order.id, entryId: entry.id,
    newValueFen: fen(10000), reason: 'x', approverId: 1
  }), 'SELF_APPROVE');
  // 缺原因被拒
  expectBiz(() => svc.adjustAmount(1, {
    target: 'clear_entry', orderId: order.id, entryId: entry.id,
    newValueFen: fen(10000), reason: '', approverId: 3
  }));

  svc.adjustAmount(1, {
    target: 'clear_entry', orderId: order.id, entryId: entry.id,
    newValueFen: fen(10000), reason: '漏点4张,监控核实', approverId: 3
  });
  const recs = svc.listAdjustments(order.id);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].old_value_fen, oldVal);
  assert.equal(recs[0].new_value_fen, fen(10000));
  assert.equal(recs[0].reason, '漏点4张,监控核实');
  assert.equal(recs[0].created_by, 1);
  assert.equal(recs[0].approver_id, 3);
  // 修正后重算合计=100000,短款差额消失
  const o = svc.getOrder(order.id);
  assert.equal(o.counted_total_fen, fen(100000));
  assert.equal(o.discrepancies.filter((d) => d.type === 'short').length, 0);
});

test('网点权限:非本网点且非清算中心员工被拒绝', () => {
  // 员工4 属网点2,不能对网点1 的 ATM 建单/锁定
  expectBiz(() => svc.createOrder(4, 1, fen(100)), 'BRANCH_FORBIDDEN');
  const plan = svc.createPlan(2, 1, [{ cassetteId: 1, notesCount: 1 }]);
  expectBiz(() => svc.lockPlan(4, plan.id), 'BRANCH_FORBIDDEN');
  // 清算中心员工(is_hq)可跨网点
  const p2 = svc.createPlan(2, 1, [{ cassetteId: 2, notesCount: 1 }]);
  svc.lockPlan(6, p2.id); // 不抛错
  assert.equal(svc.getPlan(p2.id).status, 'locked');
});

test('钞箱离开网点须两名不同员工签收;第二签完成离行', () => {
  // 把钞箱放到网点1并封存
  db.prepare(`UPDATE cassettes SET current_branch_id=1, position_label='城东金库' WHERE id=3`).run();
  svc.sealCassette(2, 3, 'SEAL-HO-1');
  const ho = svc.createHandover(2, 3, 3);
  // 未封存不能发起(用另一只未封存箱)
  db.prepare(`UPDATE cassettes SET current_branch_id=1 WHERE id=1`).run();
  expectBiz(() => svc.createHandover(2, 1, 3), 'NOT_SEALED');

  svc.signoffHandover(1, ho.id);
  expectBiz(() => svc.signoffHandover(1, ho.id), 'DUP_SIGNOFF'); // 同人重复
  const mid = svc.getHandover(ho.id);
  assert.equal(mid.status, 'pending'); // 一签未完成
  assert.notEqual(svc.getCassette(3).status, 'transit'); // 钞箱尚未离行

  svc.signoffHandover(3, ho.id); // 第二人
  const done = svc.getHandover(ho.id);
  assert.equal(done.status, 'completed');
  const c = svc.getCassette(3);
  assert.equal(c.status, 'transit');
  assert.equal(c.current_atm_id, null);
  // 轨迹包含两次签收与位置变更
  const tr = svc.cassetteTrace(3).map((x) => x.event);
  assert.ok(tr.includes('handout'));
  assert.ok(tr.filter((e) => e === 'signoff').length >= 2);
  assert.ok(tr.includes('locate'));
});

test('重复回传:相同幂等键第二次生成 duplicate_report 差额且不重复建单', async () => {
  const payload = {
    employeeId: 1, atmId: 1, expectedFen: fen(5000),
    entries: [{ denominationId: 1, notesCount: 50, soiledNotes: 0 }],
    key: 'KEY-1'
  };
  queue.enqueue('report_submit', payload, { idempotencyKey: 'KEY-1' });
  queue.enqueue('report_submit', payload, { idempotencyKey: 'KEY-1' });
  await queue.drain();
  const orders = svc.listOrders();
  assert.equal(orders.length, 1);
  const tasks = queue.list();
  assert.ok(tasks.some((t) => t.status === 'duplicate'));
  const dup = svc.listDiscrepancies(1).find((d) => d.type === 'duplicate_report');
  assert.ok(dup, '应生成重复回传差额');
});

test('离线暂存:ATM 离线时回传排队,上线后自动补传成功', async () => {
  queue.setAtmOffline(1, true);
  queue.enqueue('report_submit', {
    employeeId: 1, atmId: 1, expectedFen: fen(3000),
    entries: [{ denominationId: 1, notesCount: 30, soiledNotes: 0 }],
    key: 'OFF-1', offlineCached: true
  }, { idempotencyKey: 'OFF-1' });
  await queue.drain();
  assert.equal(svc.listOrders().length, 0, '离线期间不应建单');
  // 仍处于 queued(退避等待)
  assert.equal(queue.list()[0].status, 'queued');

  // 恢复在线 -> 重排并补传
  const n = queue.rescheduleForAtm(1);
  assert.equal(n, 1);
  await queue.drain();
  assert.equal(svc.listOrders().length, 1);
  assert.equal(queue.list()[0].status, 'done');
  // offlineCached 生成 ATM 离线差额
  assert.ok(svc.listDiscrepancies(1).some((d) => d.type === 'atm_offline'));
});

test('封签破损与 ATM 离线选项生成对应差额', () => {
  const order = svc.createOrder(1, 1, fen(1000));
  svc.enterClearEntries(1, order.id, [
    { denominationId: 1, notesCount: 10, soiledNotes: 0 }
  ], { sealBrokenCassetteId: 3, atmOffline: true });
  const types = svc.listDiscrepancies(1).map((d) => d.type);
  assert.ok(types.includes('seal_broken'));
  assert.ok(types.includes('atm_offline'));
});

test('附件以原始字节保存到本地目录并可读回', async () => {
  const order = svc.createOrder(1, 1, fen(100));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff]);
  const meta = att.save(1, order.id, '凭证.bin', bytes, 'application/octet-stream');
  assert.equal(meta.size_bytes, bytes.length);
  const back = att.read(meta.stored_name);
  assert.ok(back.buffer.equals(bytes));
  assert.equal(att.list(order.id).length, 1);
});

test('金额工具:元/分转换无浮点误差', () => {
  assert.equal(fenToYuan(12345), '123.45');
  assert.equal(fenToYuan(-5), '-0.05');
});

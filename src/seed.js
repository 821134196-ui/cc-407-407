// 演示数据:网点、员工、券别、ATM、钞箱、装钞计划、清机/差额处置、演示账户卡号。
// 全部为虚构演示数据。单条启动命令自动迁移后调用本文件。
import { nowIso, genCode } from './db.js';

const fen = (yuan) => Math.round(yuan * 100);

export function isSeeded(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM branches').get().n > 0;
}

export async function seedIfEmpty(db, svc, queue = null) {
  if (isSeeded(db)) return false;

  const t = nowIso();
  const ins = (sql, ...args) => db.prepare(sql).run(...args);

  // ---- 网点 ----
  ins(`INSERT INTO branches(id,code,name,address,created_at) VALUES
    (1,'BR-CDB','城东支行','城东新区中央大道 18 号',?),
    (2,'BR-GXQ','高新支行','高新园区科苑路 66 号',?),
    (3,'BR-HQ','清算中心金库','市分行金库大院',?)`, t, t, t);

  // ---- 员工 ----
  ins(`INSERT INTO employees(id,code,name,branch_id,role,is_hq,active,created_at) VALUES
    (1,'E001','张伟',1,'柜员',0,1,?),
    (2,'E002','李娜',1,'库管员',0,1,?),
    (3,'E003','王强',1,'复核员',0,1,?),
    (4,'E004','赵敏',2,'柜员',0,1,?),
    (5,'E005','孙丽',2,'库管员',0,1,?),
    (6,'E006','周明',3,'主管',1,1,?)`, t, t, t, t, t, t);

  // ---- 券别(面值:分) ----
  ins(`INSERT INTO denominations(id,value_fen,label,sort_order) VALUES
    (1,10000,'壹佰圆',1),
    (2,5000,'伍拾圆',2),
    (3,2000,'贰拾圆',3),
    (4,1000,'壹拾圆',4)`);

  // ---- ATM 台账 ----
  ins(`INSERT INTO atms(id,code,name,branch_id,status,model,location,created_at) VALUES
    (1,'ATM-001','城东营业部大堂机',1,'online','H6220','城东支行营业部大堂',?),
    (2,'ATM-002','城东 24 小时自助机',1,'online','H6220','城东支行 24h 自助区',?),
    (3,'ATM-003','高新园区存取款机',2,'offline','H6250','高新园区孵化中心一层',?)`, t, t, t);

  // ---- 钞箱(金库备用 + 各券别) ----
  ins(`INSERT INTO cassettes(id,code,denomination_id,capacity_notes,loaded_notes,seal_no,seal_status,status,current_branch_id,position_label,created_at) VALUES
    (1,'BOX-1001',1,2500,0,NULL,'unsealed','idle',3,'清算中心金库',?),
    (2,'BOX-1002',2,2500,0,NULL,'unsealed','idle',3,'清算中心金库',?),
    (3,'BOX-1003',1,2500,0,NULL,'unsealed','idle',3,'清算中心金库',?),
    (4,'BOX-1004',3,3000,0,NULL,'unsealed','idle',3,'清算中心金库',?),
    (5,'BOX-1005',4,3000,0,NULL,'unsealed','idle',3,'清算中心金库',?),
    (6,'BOX-1006',2,2500,0,NULL,'unsealed','idle',3,'清算中心金库',?)`, t, t, t, t, t, t);

  // ============ 样例一:完整装钞计划(城东 ATM-001),锁定 -> 执行 ============
  const plan = svc.createPlan(2, 1, [
    { cassetteId: 1, notesCount: 1200 }, // 100 元
    { cassetteId: 2, notesCount: 900 }   // 50 元
  ], '周五例行加钞');
  svc.lockPlan(2, plan.id);
  svc.executePlan(2, plan.id); // 执行后两钞箱封存并装入 ATM-001

  // ============ 样例二:已关闭清机单(短款修正 -> 平账,残钞处置,双人复核) ============
  const closed = svc.createOrder(1, 1, fen(100000)); // 账面应缴 10 万
  svc.enterClearEntries(1, closed.id, [
    { denominationId: 1, notesCount: 900, soiledNotes: 3 }, // 90000,残钞 3
    { denominationId: 2, notesCount: 196, soiledNotes: 0 }  // 9800 -> 短款 200
  ]);
  // 金额修正:50 元券少计 4 张,经办张伟、审批王强(双人不同),原值留痕
  const e50 = svc.getOrder(closed.id).entries.find((x) => x.denomination_id === 2);
  svc.adjustAmount(1, {
    target: 'clear_entry',
    orderId: closed.id,
    entryId: e50.id,
    newValueFen: fen(10000),
    reason: '调阅监控核实,50 元券漏点 4 张(200 元),补录后账实相符',
    approverId: 3
  });
  // 双人复核
  svc.addReview(2, closed.id, '清点数字与系统一致');
  svc.addReview(3, closed.id, '残钞 3 张已单独封袋');
  // 残钞差额处置
  const soiled = svc.listDiscrepancies(1, null).find((d) => d.type === 'soiled');
  svc.resolveDiscrepancy(3, soiled.id, 'approved', '残钞 3 张按残损券上缴,同意核销');
  svc.closeOrder(2, closed.id);

  // ============ 样例三:进行中的清机单(城东 ATM-002,长款待第二人复核) ============
  const open = svc.createOrder(1, 2, fen(60000));
  svc.enterClearEntries(1, open.id, [
    { denominationId: 1, notesCount: 600, soiledNotes: 0 }, // 60000
    { denominationId: 2, notesCount: 5, soiledNotes: 0 }    // 250 -> 长款 250
  ]);
  // 本网点一人已复核,尚缺第二人 => 清机单不能关闭(用于界面演示双人复核)
  svc.addReview(2, open.id, '长款 250 元,待第二人复核并查交易流水');

  // ============ 样例四:钞箱交接(离开网点双人签收) ============
  // BOX-1003 封存后由城东发起、金库/押运双人签收
  svc.sealCassette(2, 3, 'SEAL-DEMO-7788');
  // 将其位置置于城东支行以演示离行
  db.prepare(`UPDATE cassettes SET current_branch_id=1, position_label='城东支行金库' WHERE id=3`).run();
  const ho = svc.createHandover(2, 3, 3, 'leave_branch');
  svc.signoffHandover(1, ho.id);
  // 第二签由调用方/界面完成,保留待签收态以便演示;此处直接完成一示例
  // svc.signoffHandover(3, ho.id);

  // ============ 演示账户 / 卡号 / 交易(全为演示数据) ============
  ins(`INSERT INTO demo_accounts(id,account_no,holder_name,branch_id,balance_fen) VALUES
    (1,'6222 0212 3456 7001','演示客户·陈晨',1,?),
    (2,'6222 0212 3456 7002','演示客户·林航',2,?)`, fen(18650.40), fen(9200.00));
  ins(`INSERT INTO demo_cards(id,card_no,account_id,status) VALUES
    (1,'6222 0212 3456 7001',1,'normal'),
    (2,'6222 0212 3456 7002',2,'normal')`);
  ins(`INSERT INTO demo_txn(card_no,atm_id,txn_type,amount_fen,created_at) VALUES
    ('6222 0212 3456 7001',1,'withdraw',?,?),
    ('6222 0212 3456 7001',1,'withdraw',?,?),
    ('6222 0212 3456 7002',2,'deposit',?,?),
    ('6222 0212 3456 7002',1,'balance',0,?)`,
    fen(500), t, fen(300), t, fen(1200), t, t);

  // ============ 样例五:任务队列补传 ============
  if (queue) {
    // (a) 一条曾离线缓存的回传,ATM 已在线 -> 立即补传成功,并登记 ATM 离线差额
    queue.enqueue('report_submit', {
      employeeId: 1, atmId: 1, expectedFen: fen(200000),
      entries: [{ denominationId: 1, notesCount: 2000, soiledNotes: 0 }],
      key: 'DEMO-OFFLINE-001', offlineCached: true
    }, { idempotencyKey: 'DEMO-OFFLINE-001' });
    // (b) 同一幂等键重复回传 -> 判重,生成「重复回传」差额
    queue.enqueue('report_submit', {
      employeeId: 1, atmId: 1, expectedFen: fen(200000),
      entries: [{ denominationId: 1, notesCount: 2000, soiledNotes: 0 }],
      key: 'DEMO-OFFLINE-001', offlineCached: true
    }, { idempotencyKey: 'DEMO-OFFLINE-001' });
    await queue.drain();

    // (c) 离线 ATM-003 的回传暂存,等待上线后补传(10 分钟后到期,界面可手动立即补传)
    queue.setAtmOffline(3, true);
    db.prepare(
      `INSERT INTO task_queue(type,payload,idempotency_key,status,attempts,max_attempts,available_at,created_at)
       VALUES('report_submit',?, 'DEMO-OFFLINE-002','queued',0,5,?,?)`
    ).run(
      JSON.stringify({
        employeeId: 4, atmId: 3, expectedFen: fen(400000),
        entries: [{ denominationId: 1, notesCount: 4000, soiledNotes: 0 }],
        key: 'DEMO-OFFLINE-002', offlineCached: true
      }),
      new Date(Date.now() + 10 * 60_000).toISOString(),
      nowIso()
    );
  }

  return true;
}

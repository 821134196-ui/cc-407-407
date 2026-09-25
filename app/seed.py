"""演示数据：网点、员工、ATM、钞箱、装钞、清机、差额处置样例。

所有账户、金额、卡号均为演示数据。
"""
from __future__ import annotations

import sqlite3

from . import db, services as svc


def is_seeded(conn: sqlite3.Connection) -> bool:
    return conn.execute("SELECT COUNT(*) c FROM branches").fetchone()["c"] > 0


def seed(conn: sqlite3.Connection, force: bool = False) -> None:
    if is_seeded(conn) and not force:
        return

    conn.executescript("""
        DELETE FROM audit_logs; DELETE FROM jobs; DELETE FROM attachments;
        DELETE FROM cassette_tracks; DELETE FROM handover_signoffs;
        DELETE FROM handovers; DELETE FROM cassette_claims;
        DELETE FROM clearing_reviews; DELETE FROM amount_amendments;
        DELETE FROM discrepancies; DELETE FROM clearing_items;
        DELETE FROM clearings; DELETE FROM loading_plan_items;
        DELETE FROM loading_plans; DELETE FROM cassettes; DELETE FROM atms;
        DELETE FROM employees; DELETE FROM denominations; DELETE FROM branches;
    """)
    ts = svc.now()
    conn.executemany(
        "INSERT INTO branches(id, code, name, created_at) VALUES(?,?,?,?)",
        [(1, "BR001", "中心支行营业部", ts),
         (2, "BR002", "滨江路分理处", ts),
         (3, "BR003", "城东支行", ts)])
    conn.executemany(
        "INSERT INTO denominations(value, label) VALUES(?,?)",
        [(d, s) for d, s in svc.DENOM_LABELS.items()])
    # 员工：每网点 3 人（含 1 名主管）
    emps = [
        (101, "E101", "张静", 1, "manager"),
        (102, "E102", "李伟", 1, "clerk"),
        (103, "E103", "王敏", 1, "clerk"),
        (201, "E201", "赵强", 2, "manager"),
        (202, "E202", "钱芳", 2, "clerk"),
        (203, "E203", "孙磊", 2, "clerk"),
        (301, "E301", "周琳", 3, "manager"),
        (302, "E302", "吴昊", 3, "clerk"),
    ]
    conn.executemany(
        "INSERT INTO employees(id, code, name, branch_id, role) VALUES(?,?,?,?,?)", emps)
    # ATM（演示卡号式编号）
    atms = [
        (1, "ATM-6222-0001", "营业部大厅存取款机", 1, "online", "中心支行一楼大厅"),
        (2, "ATM-6222-0002", "营业部穿墙式取款机", 1, "offline", "中心支行西门"),
        (3, "ATM-6222-0003", "滨江路自助终端", 2, "online", "滨江路 88 号"),
        (4, "ATM-6222-0004", "城东商圈取款机", 3, "online", "城东万达广场"),
    ]
    conn.executemany(
        "INSERT INTO atms(id, code, name, branch_id, status, address) VALUES(?,?,?,?,?,?)",
        atms)
    # 钞箱：每 ATM 四个券别箱（100/50/20/10），另有备用箱
    cass = []
    cid = 1
    for atm_id, branch_id in [(1, 1), (2, 1), (3, 2), (4, 3)]:
        for d, cap in [(100, 2500), (50, 2500), (20, 3000), (10, 3000)]:
            cass.append((cid, f"CS{cid:04d}", d, cap, 0, "", 0, "idle",
                         "网点库房", branch_id, atm_id))
            cid += 1
    # 备用封存钞箱（中心支行库，100 元券别）
    cass.append((cid, f"CS{cid:04d}", 100, 2500, 1200, "SL2026090001", 1,
                 "stored", "中心支行金库", 1, None))
    conn.executemany(
        """INSERT INTO cassettes(id, code, denomination_value, capacity, qty, seal_no,
              sealed, status, location, branch_id, atm_id)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""", cass)
    for r in cass:
        conn.execute(
            """INSERT INTO cassette_tracks(cassette_id, event, seal_no, location,
                  operator_id, detail, created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (r[0], "入库登记", r[6] and r[5] or "", r[8], None,
             f"券别 {r[2]} 元 / 容量 {r[3]} 张", ts))

    # ---- 业务样例 1：中心支行装钞 → 清机（短款）→ 复核 → 差额处置 → 关闭 ----
    # 装钞计划：ATM1 装入 100×2000, 50×1000
    p1 = svc.create_plan(conn, 101, 1, {100: 2000, 50: 1000}, note="国庆节前加钞")
    svc.lock_plan(conn, 101, p1["plan_id"])
    svc.load_plan(conn, 102, p1["plan_id"])

    # 清机：实点 100×1995（短 5 张=500）、50×1002（长 2 张=100），100 元残钞 3 张
    c1 = svc.open_clearing(conn, 102, 1, plan_id=p1["plan_id"], note="节日后清机")
    r1 = svc.submit_clearing(
        conn, 102, c1["clearing_id"],
        actual={100: 1995, 50: 1002}, defects={100: 3}, batch_no="BATCH-20260920-01")
    # 双人复核（开单人 102 不能复核，由 101、103 复核）
    svc.review_clearing(conn, 101, c1["clearing_id"], comment="账实核对一致，差异待处理")
    svc.review_clearing(conn, 103, c1["clearing_id"], comment="残钞已双人加封")
    # 短款金额修正：500 → 400（其中 100 元为客户投诉已登记错账，审批人 101）
    short_disc = conn.execute(
        "SELECT id FROM discrepancies WHERE clearing_id=? AND type='short'",
        (c1["clearing_id"],)).fetchone()
    svc.amend_discrepancy_amount(
        conn, 101, short_disc["id"], 400,
        "其中 100 元系客户长款投诉已冲正，经主管审批调减短款金额")
    # 处置全部差异
    for d in conn.execute(
            "SELECT id FROM discrepancies WHERE clearing_id=?", (c1["clearing_id"],)):
        svc.resolve_discrepancy(conn, 101, d["id"], "approved", "挂账处理，逐级报批")
    svc.close_clearing(conn, 101, c1["clearing_id"])

    # ---- 业务样例 2：ATM2 离线 + 重复回传 ----
    p2 = svc.create_plan(conn, 101, 2, {100: 800}, note="离线机补钞测试")
    svc.lock_plan(conn, 101, p2["plan_id"])
    svc.load_plan(conn, 102, p2["plan_id"])
    c2 = svc.open_clearing(conn, 102, 2, plan_id=p2["plan_id"])  # 自动生成离线差异
    svc.submit_clearing(conn, 102, c2["clearing_id"], actual={100: 800},
                        batch_no="BATCH-20260921-09")
    # 关闭 c2（补两人复核与处置），其批次号留在库中，供后续回传演示重复回传拦截
    svc.review_clearing(conn, 101, c2["clearing_id"], "离线数据已核对")
    svc.review_clearing(conn, 103, c2["clearing_id"], "复核通过")
    for d in conn.execute(
            "SELECT id FROM discrepancies WHERE clearing_id=?", (c2["clearing_id"],)):
        svc.resolve_discrepancy(conn, 101, d["id"], "resolved", "离线补传成功，平账")
    svc.close_clearing(conn, 101, c2["clearing_id"])

    # ---- 业务样例 3：滨江路 装钞 → 清机（长款待处理，未关闭，供页面操作） ----
    p3 = svc.create_plan(conn, 201, 3, {100: 1500, 20: 600}, note="日常加钞")
    svc.lock_plan(conn, 201, p3["plan_id"])
    svc.load_plan(conn, 202, p3["plan_id"])
    c3 = svc.open_clearing(conn, 202, 3, plan_id=p3["plan_id"], note="长款待查")
    svc.submit_clearing(conn, 202, c3["clearing_id"],
                        actual={100: 1500, 20: 607},  # 20 元长 7 张 = 140
                        batch_no="BATCH-20260922-03")
    svc.review_clearing(conn, 201, c3["clearing_id"], "长款待客户核实")
    # 仅一人复核 → 页面上可由 203 完成第二人复核后关闭

    # ---- 业务样例 4：封签破损 + 钞箱交接（待第二人签收） ----
    spare = conn.execute("SELECT id FROM cassettes WHERE code='CS0017'").fetchone()
    if spare:
        svc.report_seal_broken(conn, 102, spare["id"], "搬运中发现封签撕裂")
        # 重新封存后发起跨网点交接：中心支行 → 滨江路
        svc.seal_cassette(conn, 101, spare["id"], "SL202609240088")
        h = svc.create_handover(conn, 101, spare["id"], 2)
        svc.signoff_handover(conn, 102, h["handover_id"])  # 第一签收人（中心支行）
        # 第二签收人（滨江路 201/202/203）待页面操作

    # ---- 补传队列样例 ----
    # 由 web 启动时统一入队；此处仅保证 jobs 表存在即可

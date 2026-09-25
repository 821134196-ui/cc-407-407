"""业务服务层：装钞、清机、差额、封签、双人复核、钞箱交接、补传队列。

金额单位统一为「分」？为演示直观，本平台统一使用「元」（整数）。
"""
from __future__ import annotations

import json
import queue
import sqlite3
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from . import db

# ---------------- 常量 ----------------

DENOMS = [100, 50, 20, 10, 5, 1]
DENOM_LABELS = {100: "壹佰元", 50: "伍拾元", 20: "贰拾元", 10: "壹拾元", 5: "伍元", 1: "壹元"}

DISC_TYPES = {
    "short": "短款",
    "over": "长款",
    "defect": "残钞",
    "seal_broken": "封签破损",
    "offline": "ATM 离线",
    "duplicate": "重复回传",
}


class BusinessError(Exception):
    """业务规则错误。"""


class PermissionError403(BusinessError):
    """网点权限错误。"""


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def due_in(days: int = 2) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


def code(prefix: str) -> str:
    return f"{prefix}{datetime.now().strftime('%Y%m%d%H%M%S')}{uuid.uuid4().hex[:4].upper()}"


# ---------------- 基础查询 ----------------

def get_employee(conn: sqlite3.Connection, employee_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM employees WHERE id=?", (employee_id,)).fetchone()
    if not row:
        raise BusinessError("员工不存在")
    return row


def require_branch(employee: sqlite3.Row, branch_id: int, action: str = "操作"):
    """网点权限：员工只能处理本网点业务。"""
    if employee["branch_id"] != branch_id:
        raise PermissionError403(
            f"网点权限不足：{employee['name']} 属于其他网点，无权{action}本网点业务"
        )


def audit(conn: sqlite3.Connection, actor: sqlite3.Row | None, action: str,
          entity: str, ref_code: str = "", detail: str = "", branch_id: int | None = None):
    conn.execute(
        """INSERT INTO audit_logs(actor_id, actor_name, branch_id, action, entity, ref_code, detail, created_at)
           VALUES(?,?,?,?,?,?,?,?)""",
        (actor["id"] if actor else None, actor["name"] if actor else "系统",
         branch_id if branch_id is not None else (actor["branch_id"] if actor else None),
         action, entity, ref_code, detail, now()),
    )


def denom_breakdown(conn: sqlite3.Connection, table: str, id_col: str, row_id: int,
                    qty_col: str) -> list[dict]:
    """按券别汇总（右对齐数字列数据源）。"""
    rows = conn.execute(
        f"""SELECT denomination_value AS denom, {qty_col} AS qty
            FROM {table} WHERE {id_col}=?""", (row_id,)).fetchall()
    m = {r["denom"]: r["qty"] for r in rows}
    return [{"denom": d, "label": DENOM_LABELS[d], "qty": m.get(d, 0) or 0,
             "amount": (m.get(d, 0) or 0) * d} for d in DENOMS]


# ---------------- ATM / 钞箱 ----------------

def list_atms(conn: sqlite3.Connection, branch_id: int | None = None) -> list[sqlite3.Row]:
    sql = """SELECT a.*, b.name AS branch_name FROM atms a
             JOIN branches b ON b.id=a.branch_id"""
    params: tuple = ()
    if branch_id is not None:
        sql += " WHERE a.branch_id=?"
        params = (branch_id,)
    sql += " ORDER BY a.code"
    return conn.execute(sql, params).fetchall()


def list_cassettes(conn: sqlite3.Connection, branch_id: int | None = None,
                   atm_id: int | None = None) -> list[sqlite3.Row]:
    sql = """SELECT c.*, b.name AS branch_name, a.code AS atm_code,
                    d.label AS denom_label
             FROM cassettes c
             JOIN branches b ON b.id=c.branch_id
             LEFT JOIN atms a ON a.id=c.atm_id
             LEFT JOIN denominations d ON d.value=c.denomination_value"""
    cond, params = [], []
    if branch_id is not None:
        cond.append("c.branch_id=?"); params.append(branch_id)
    if atm_id is not None:
        cond.append("c.atm_id=?"); params.append(atm_id)
    if cond:
        sql += " WHERE " + " AND ".join(cond)
    sql += " ORDER BY c.atm_id, c.denomination_value, c.code"
    return conn.execute(sql, params).fetchall()


def track(conn: sqlite3.Connection, cassette_id: int, event: str,
          operator_id: int | None = None, seal_no: str | None = None,
          location: str | None = None, detail: str = ""):
    cass = conn.execute("SELECT * FROM cassettes WHERE id=?", (cassette_id,)).fetchone()
    conn.execute(
        """INSERT INTO cassette_tracks(cassette_id, event, seal_no, location, operator_id, detail, created_at)
           VALUES(?,?,?,?,?,?,?)""",
        (cassette_id, event,
         seal_no if seal_no is not None else cass["seal_no"],
         location if location is not None else cass["location"],
         operator_id, detail, now()),
    )


def update_cassette_qty(conn: sqlite3.Connection, employee_id: int, cassette_id: int,
                        qty: int, seal_no: str | None = None) -> dict:
    """直接修改钞箱数量。已封存钞箱禁止直接改数量。"""
    emp = get_employee(conn, employee_id)
    cass = conn.execute("SELECT * FROM cassettes WHERE id=?", (cassette_id,)).fetchone()
    if not cass:
        raise BusinessError("钞箱不存在")
    require_branch(emp, cass["branch_id"], "修改")
    if cass["sealed"]:
        raise BusinessError(f"钞箱 {cass['code']} 已封存（封签 {cass['seal_no']}），不能直接修改数量，请先解封")
    if qty < 0 or qty > cass["capacity"]:
        raise BusinessError(f"张数超出券别容量（容量 {cass['capacity']} 张）")
    with db.tx(conn):
        conn.execute("UPDATE cassettes SET qty=?, seal_no=COALESCE(?, seal_no) WHERE id=?",
                     (qty, seal_no, cassette_id))
        track(conn, cassette_id, "数量调整", employee_id,
              detail=f"张数调整为 {qty}")
        audit(conn, emp, "钞箱数量调整", "cassette", cass["code"], f"qty={qty}")
    return {"cassette_id": cassette_id, "qty": qty}


def seal_cassette(conn: sqlite3.Connection, employee_id: int, cassette_id: int,
                  seal_no: str) -> dict:
    """封存钞箱：登记封签号。"""
    emp = get_employee(conn, employee_id)
    cass = conn.execute("SELECT * FROM cassettes WHERE id=?", (cassette_id,)).fetchone()
    require_branch(emp, cass["branch_id"], "封存")
    dup = conn.execute("SELECT id FROM cassettes WHERE seal_no=? AND id<>?",
                       (seal_no, cassette_id)).fetchone()
    if dup:
        raise BusinessError(f"封签号 {seal_no} 已被其他钞箱占用")
    with db.tx(conn):
        conn.execute("UPDATE cassettes SET sealed=1, seal_no=?, status='stored' WHERE id=?",
                     (seal_no, cassette_id))
        track(conn, cassette_id, "封存", employee_id, seal_no=seal_no,
              detail=f"加封封签 {seal_no}")
        audit(conn, emp, "钞箱封存", "cassette", cass["code"], f"seal={seal_no}")
    return {"cassette_id": cassette_id, "sealed": True, "seal_no": seal_no}


def unseal_cassette(conn: sqlite3.Connection, employee_id: int, cassette_id: int,
                    reason: str = "清分复用") -> dict:
    """解封必须留痕；若封签破损须登记差异。"""
    emp = get_employee(conn, employee_id)
    cass = conn.execute("SELECT * FROM cassettes WHERE id=?", (cassette_id,)).fetchone()
    require_branch(emp, cass["branch_id"], "解封")
    with db.tx(conn):
        old_seal = cass["seal_no"]
        conn.execute("UPDATE cassettes SET sealed=0, seal_no='', status='idle' WHERE id=?",
                     (cassette_id,))
        track(conn, cassette_id, "解封", employee_id, seal_no="",
              detail=f"拆除封签 {old_seal}，原因：{reason}")
        audit(conn, emp, "钞箱解封", "cassette", cass["code"], f"old_seal={old_seal} {reason}")
    return {"cassette_id": cassette_id, "sealed": False}


def report_seal_broken(conn: sqlite3.Connection, employee_id: int, cassette_id: int,
                       description: str = "") -> dict:
    """封签破损：生成差异记录。"""
    emp = get_employee(conn, employee_id)
    cass = conn.execute("SELECT * FROM cassettes WHERE id=?", (cassette_id,)).fetchone()
    require_branch(emp, cass["branch_id"], "上报")
    disc_code = code("D")
    with db.tx(conn):
        cur = conn.execute(
            """INSERT INTO discrepancies(code, branch_id, type, amount, denomination_value,
                  status, due_date, description, created_at)
               VALUES(?,?,?,?,?, 'pending', ?, ?, ?)""",
            (disc_code, cass["branch_id"], "seal_broken", 0, cass["denomination_value"],
             due_in(), f"钞箱 {cass['code']} 封签破损（原封签 {cass['seal_no'] or '无'}）。{description}",
             now()))
        conn.execute("UPDATE cassettes SET sealed=0, seal_no='' WHERE id=?", (cassette_id,))
        track(conn, cassette_id, "封签破损", employee_id, seal_no="", detail=description)
        audit(conn, emp, "登记差异", "discrepancy", disc_code, "封签破损")
    return {"discrepancy_code": disc_code}


def cassette_tracks(conn: sqlite3.Connection, cassette_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT t.*, e.name AS operator_name FROM cassette_tracks t
           LEFT JOIN employees e ON e.id=t.operator_id
           WHERE t.cassette_id=? ORDER BY t.id""", (cassette_id,)).fetchall()


# ---------------- 领取（两人同时领取只允许一人成功） ----------------

def claim_cassette(conn: sqlite3.Connection, employee_id: int, cassette_id: int) -> dict:
    emp = get_employee(conn, employee_id)
    cass = conn.execute("SELECT * FROM cassettes WHERE id=?", (cassette_id,)).fetchone()
    require_branch(emp, cass["branch_id"], "领取")
    active = conn.execute(
        "SELECT cc.*, e.name AS employee_name FROM cassette_claims cc "
        "JOIN employees e ON e.id=cc.employee_id "
        "WHERE cc.cassette_id=? AND cc.status='active'", (cassette_id,)).fetchone()
    if active:
        raise BusinessError(f"钞箱 {cass['code']} 已被 {active['employee_name']} 领取，不能重复领取")
    try:
        with db.tx(conn):
            conn.execute(
                "INSERT INTO cassette_claims(cassette_id, employee_id, status, created_at) "
                "VALUES(?,?,'active',?)", (cassette_id, employee_id, now()))
            conn.execute("UPDATE cassettes SET status='claimed' WHERE id=?", (cassette_id,))
            track(conn, cassette_id, "领取", employee_id, detail=f"领取人 {emp['name']}")
            audit(conn, emp, "领取钞箱", "cassette", cass["code"])
    except sqlite3.IntegrityError:
        # 并发下唯一部分索引兜底：只允许一人成功
        raise BusinessError(f"钞箱 {cass['code']} 领取冲突：已被其他员工抢先领取")
    return {"cassette_id": cassette_id, "claimed_by": employee_id, "ok": True}


def release_cassette(conn: sqlite3.Connection, employee_id: int, cassette_id: int) -> dict:
    with db.tx(conn):
        cur = conn.execute(
            "UPDATE cassette_claims SET status='released' WHERE cassette_id=? AND status='active'",
            (cassette_id,))
        if cur.rowcount == 0:
            raise BusinessError("该钞箱没有活跃领取记录")
        conn.execute("UPDATE cassettes SET status='idle' WHERE id=?", (cassette_id,))
        track(conn, cassette_id, "交还", employee_id)
        emp = get_employee(conn, employee_id)
        audit(conn, emp, "交还钞箱", "cassette",
              conn.execute("SELECT code FROM cassettes WHERE id=?", (cassette_id,)).fetchone()["code"])
    return {"ok": True}


# ---------------- 装钞计划（装钞前锁定） ----------------

def create_plan(conn: sqlite3.Connection, employee_id: int, atm_id: int,
                items: dict[int, int], note: str = "") -> dict:
    """items: {券别: 张数}。"""
    emp = get_employee(conn, employee_id)
    atm = conn.execute("SELECT * FROM atms WHERE id=?", (atm_id,)).fetchone()
    if not atm:
        raise BusinessError("ATM 不存在")
    require_branch(emp, atm["branch_id"], "制定装钞计划")
    items = {int(k): int(v) for k, v in items.items() if int(v) > 0}
    if not items:
        raise BusinessError("装钞计划至少包含一个券别")
    for d, qty in items.items():
        if d not in DENOMS:
            raise BusinessError(f"不支持的券别 {d}")
    pcode = code("P")
    with db.tx(conn):
        cur = conn.execute(
            """INSERT INTO loading_plans(code, atm_id, branch_id, status, created_by, created_at, note)
               VALUES(?, ?, ?, 'draft', ?, ?, ?)""",
            (pcode, atm_id, atm["branch_id"], employee_id, now(), note))
        pid = cur.lastrowid
        conn.executemany(
            "INSERT INTO loading_plan_items(plan_id, denomination_value, qty) VALUES(?,?,?)",
            [(pid, d, q) for d, q in items.items()])
        audit(conn, emp, "创建装钞计划", "loading_plan", pcode,
              f"ATM={atm['code']} 券别数={len(items)}")
    return {"plan_code": pcode, "plan_id": pid}


def lock_plan(conn: sqlite3.Connection, employee_id: int, plan_id: int) -> dict:
    """装钞前锁定计划；锁定后不可修改。"""
    emp = get_employee(conn, employee_id)
    plan = conn.execute("SELECT * FROM loading_plans WHERE id=?", (plan_id,)).fetchone()
    if not plan:
        raise BusinessError("装钞计划不存在")
    require_branch(emp, plan["branch_id"], "锁定")
    if plan["status"] != "draft":
        raise BusinessError(f"计划当前状态为 {plan['status']}，仅草稿可锁定")
    with db.tx(conn):
        conn.execute("UPDATE loading_plans SET status='locked', locked_at=? WHERE id=?",
                     (now(), plan_id))
        audit(conn, emp, "锁定装钞计划", "loading_plan", plan["code"])
    return {"plan_id": plan_id, "status": "locked"}


def update_plan_items(conn: sqlite3.Connection, employee_id: int, plan_id: int,
                      items: dict[int, int]):
    emp = get_employee(conn, employee_id)
    plan = conn.execute("SELECT * FROM loading_plans WHERE id=?", (plan_id,)).fetchone()
    require_branch(emp, plan["branch_id"], "修改")
    if plan["status"] != "draft":
        raise BusinessError("计划已锁定，不能修改")
    with db.tx(conn):
        conn.execute("DELETE FROM loading_plan_items WHERE plan_id=?", (plan_id,))
        conn.executemany(
            "INSERT INTO loading_plan_items(plan_id, denomination_value, qty) VALUES(?,?,?)",
            [(plan_id, int(d), int(q)) for d, q in items.items() if int(q) > 0])
        audit(conn, emp, "修改装钞计划", "loading_plan", plan["code"])


def load_plan(conn: sqlite3.Connection, employee_id: int, plan_id: int) -> dict:
    """执行装钞：将计划券别装入 ATM 上对应钞箱（必须已锁定）。"""
    emp = get_employee(conn, employee_id)
    plan = conn.execute("SELECT * FROM loading_plans WHERE id=?", (plan_id,)).fetchone()
    require_branch(emp, plan["branch_id"], "装钞")
    if plan["status"] != "locked":
        raise BusinessError("只有已锁定的计划才能执行装钞")
    items = conn.execute(
        "SELECT * FROM loading_plan_items WHERE plan_id=?", (plan_id,)).fetchall()
    with db.tx(conn):
        for it in items:
            cass = conn.execute(
                "SELECT * FROM cassettes WHERE atm_id=? AND denomination_value=? "
                "ORDER BY id LIMIT 1", (plan["atm_id"], it["denomination_value"])).fetchone()
            if not cass:
                raise BusinessError(f"ATM 上缺少 {it['denomination_value']} 元券别钞箱，无法装钞")
            if cass["sealed"]:
                raise BusinessError(f"钞箱 {cass['code']} 已封存，不能装钞，请先解封")
            if it["qty"] > cass["capacity"]:
                raise BusinessError(
                    f"钞箱 {cass['code']} 容量不足：{it['qty']} > {cass['capacity']}")
            conn.execute("UPDATE cassettes SET qty=?, status='loaded' WHERE id=?",
                         (it["qty"], cass["id"]))
            track(conn, cass["id"], "装钞入箱", employee_id,
                  detail=f"{it['denomination_value']}元 × {it['qty']} 张")
        conn.execute("UPDATE loading_plans SET status='loaded', loaded_at=? WHERE id=?",
                     (now(), plan_id))
        audit(conn, emp, "执行装钞", "loading_plan", plan["code"])
    return {"plan_id": plan_id, "status": "loaded"}


# ---------------- 清机 ----------------

def open_clearing(conn: sqlite3.Connection, employee_id: int, atm_id: int,
                  plan_id: int | None = None, note: str = "") -> dict:
    emp = get_employee(conn, employee_id)
    atm = conn.execute("SELECT * FROM atms WHERE id=?", (atm_id,)).fetchone()
    require_branch(emp, atm["branch_id"], "清机")
    exist = conn.execute(
        "SELECT id FROM clearings WHERE atm_id=? AND status IN ('open','submitted','reviewed')",
        (atm_id,)).fetchone()
    if exist:
        raise BusinessError("该 ATM 已有未关闭的清机单")
    ccode = code("C")
    with db.tx(conn):
        cur = conn.execute(
            """INSERT INTO clearings(code, atm_id, branch_id, plan_id, status, opened_by,
                  opened_at, note) VALUES(?,?,?,?,'open',?,?,?)""",
            (ccode, atm_id, atm["branch_id"], plan_id, employee_id, now(), note))
        cid = cur.lastrowid
        # 预期数：取钞箱当前张数（或计划项）
        if plan_id:
            rows = conn.execute(
                "SELECT denomination_value, qty FROM loading_plan_items WHERE plan_id=?",
                (plan_id,)).fetchall()
            for r in rows:
                conn.execute(
                    "INSERT INTO clearing_items(clearing_id, denomination_value, expected_qty) "
                    "VALUES(?,?,?)", (cid, r["denomination_value"], r["qty"]))
        else:
            for cass in conn.execute(
                    "SELECT denomination_value, SUM(qty) AS qty FROM cassettes "
                    "WHERE atm_id=? GROUP BY denomination_value", (atm_id,)):
                conn.execute(
                    "INSERT INTO clearing_items(clearing_id, denomination_value, expected_qty) "
                    "VALUES(?,?,?)", (cid, cass["denomination_value"], cass["qty"] or 0))
        # ATM 离线差异
        if atm["status"] == "offline":
            conn.execute(
                """INSERT INTO discrepancies(code, clearing_id, branch_id, type, amount,
                      status, due_date, description, created_at)
                   VALUES(?,?,?, 'offline', 0, 'pending', ?, ?, ?)""",
                (code("D"), cid, atm["branch_id"], due_in(1),
                 f"清机时 ATM {atm['code']} 处于离线状态", now()))
        audit(conn, emp, "开启清机单", "clearing", ccode, f"ATM={atm['code']}")
    return {"clearing_code": ccode, "clearing_id": cid}


def submit_clearing(conn: sqlite3.Connection, employee_id: int, clearing_id: int,
                    actual: dict[int, int], defects: dict[int, int] | None = None,
                    batch_no: str | None = None,
                    seal_broken_cassettes: list[int] | None = None) -> dict:
    """按实点金额逐券别录入。actual/defects: {券别: 张数}。

    - batch_no 重复回传：登记差异并拒绝
    - 短款/长款：逐券别比对 expected 生成差异
    - 残钞：defects 张数登记差异
    - 封签破损钞箱：登记差异
    """
    emp = get_employee(conn, employee_id)
    cl = conn.execute("SELECT * FROM clearings WHERE id=?", (clearing_id,)).fetchone()
    if not cl:
        raise BusinessError("清机单不存在")
    require_branch(emp, cl["branch_id"], "录入清机")
    if cl["status"] not in ("open",):
        raise BusinessError(f"清机单状态 {cl['status']}，不能重复录入")

    # 重复回传
    if batch_no:
        dup = conn.execute("SELECT id, code FROM clearings WHERE batch_no=? AND id<>?",
                           (batch_no, clearing_id)).fetchone()
        if dup:
            with db.tx(conn):
                dcode = code("D")
                conn.execute(
                    """INSERT INTO discrepancies(code, clearing_id, branch_id, type, amount,
                          status, due_date, description, created_at)
                       VALUES(?,?,?, 'duplicate', 0, 'pending', ?, ?, ?)""",
                    (dcode, cl["id"], cl["branch_id"], due_in(1),
                     f"批次号 {batch_no} 已随清机单 {dup['code']} 回传，本次为重复回传", now()))
                audit(conn, emp, "登记差异", "discrepancy", dcode, "重复回传")
            raise BusinessError(f"批次号 {batch_no} 重复回传，已登记差异，本次回传拒绝入账")

    defects = defects or {}
    seal_broken_cassettes = seal_broken_cassettes or []
    items = conn.execute("SELECT * FROM clearing_items WHERE clearing_id=?",
                         (clearing_id,)).fetchall()
    disc_codes: list[str] = []
    with db.tx(conn):
        expected_total = actual_total = 0
        for it in items:
            d = it["denomination_value"]
            aq = int(actual.get(d, 0))
            dq = int(defects.get(d, 0))
            if aq < 0 or dq < 0 or dq > aq:
                raise BusinessError(f"{d} 元券别录入数据不合法（残钞不能多于实点）")
            conn.execute(
                "UPDATE clearing_items SET actual_qty=?, defect_qty=? WHERE id=?",
                (aq, dq, it["id"]))
            expected_total += it["expected_qty"] * d
            actual_total += aq * d
            diff_qty = aq - it["expected_qty"]
            if diff_qty < 0:
                dcode = code("D")
                disc_codes.append(dcode)
                conn.execute(
                    """INSERT INTO discrepancies(code, clearing_id, branch_id, type, amount,
                          denomination_value, status, due_date, description, created_at)
                       VALUES(?,?,?, 'short', ?, ?, 'pending', ?, ?, ?)""",
                    (dcode, clearing_id, cl["branch_id"], -diff_qty * d, d, due_in(2),
                     f"{d} 元券别短款 { -diff_qty} 张", now()))
            elif diff_qty > 0:
                dcode = code("D")
                disc_codes.append(dcode)
                conn.execute(
                    """INSERT INTO discrepancies(code, clearing_id, branch_id, type, amount,
                          denomination_value, status, due_date, description, created_at)
                       VALUES(?,?,?, 'over', ?, ?, 'pending', ?, ?, ?)""",
                    (dcode, clearing_id, cl["branch_id"], diff_qty * d, d, due_in(2),
                     f"{d} 元券别长款 {diff_qty} 张", now()))
            if dq > 0:
                dcode = code("D")
                disc_codes.append(dcode)
                conn.execute(
                    """INSERT INTO discrepancies(code, clearing_id, branch_id, type, amount,
                          denomination_value, status, due_date, description, created_at)
                       VALUES(?,?,?, 'defect', ?, ?, 'pending', ?, ?, ?)""",
                    (dcode, clearing_id, cl["branch_id"], dq * d, d, due_in(3),
                     f"{d} 元券别残钞 {dq} 张需上缴鉴别", now()))
        # 封签破损
        for cass_id in seal_broken_cassettes:
            cass = conn.execute("SELECT * FROM cassettes WHERE id=?", (cass_id,)).fetchone()
            dcode = code("D")
            disc_codes.append(dcode)
            conn.execute(
                """INSERT INTO discrepancies(code, clearing_id, branch_id, type, amount,
                      denomination_value, status, due_date, description, created_at)
                   VALUES(?,?,?, 'seal_broken', 0, ?, 'pending', ?, ?, ?)""",
                (dcode, clearing_id, cl["branch_id"], cass["denomination_value"], due_in(1),
                 f"钞箱 {cass['code']} 封签破损（原封签 {cass['seal_no'] or '无'}）", now()))
            conn.execute("UPDATE cassettes SET sealed=0, seal_no='' WHERE id=?", (cass_id,))
            track(conn, cass_id, "封签破损", employee_id, seal_no="", detail="清机发现封签破损")

        conn.execute(
            """UPDATE clearings SET status='submitted', submitted_at=?, expected_total=?,
                  actual_total=?, batch_no=? WHERE id=?""",
            (now(), expected_total, actual_total, batch_no, clearing_id))
        audit(conn, emp, "提交清机录入", "clearing", cl["code"],
              f"预期={expected_total} 实点={actual_total} 差异={len(disc_codes)}条")
    return {"clearing_id": clearing_id, "expected_total": expected_total,
            "actual_total": actual_total, "discrepancies": disc_codes}


def review_clearing(conn: sqlite3.Connection, employee_id: int, clearing_id: int,
                    comment: str = "") -> dict:
    """双人复核：两名不同员工各复核一次。"""
    emp = get_employee(conn, employee_id)
    cl = conn.execute("SELECT * FROM clearings WHERE id=?", (clearing_id,)).fetchone()
    require_branch(emp, cl["branch_id"], "复核")
    if cl["status"] not in ("submitted", "reviewed"):
        raise BusinessError("仅已提交的清机单可复核")
    if employee_id == cl["opened_by"]:
        raise BusinessError("开单人不能复核自己的清机单，须由其他员工复核")
    already = conn.execute(
        "SELECT id FROM clearing_reviews WHERE clearing_id=? AND reviewer_id=?",
        (clearing_id, employee_id)).fetchone()
    if already:
        raise BusinessError("同一员工不能重复复核")
    with db.tx(conn):
        conn.execute(
            "INSERT INTO clearing_reviews(clearing_id, reviewer_id, comment, created_at) "
            "VALUES(?,?,?,?)", (clearing_id, employee_id, comment, now()))
        n = conn.execute(
            "SELECT COUNT(*) c FROM clearing_reviews WHERE clearing_id=?",
            (clearing_id,)).fetchone()["c"]
        if n >= 2:
            conn.execute("UPDATE clearings SET status='reviewed' WHERE id=?", (clearing_id,))
        audit(conn, emp, "清机复核", "clearing", cl["code"], f"第 {n} 人复核")
    return {"clearing_id": clearing_id, "reviews": n}


def close_clearing(conn: sqlite3.Connection, employee_id: int, clearing_id: int) -> dict:
    """复核完成前禁止关闭；有待处理差异也禁止关闭。"""
    emp = get_employee(conn, employee_id)
    cl = conn.execute("SELECT * FROM clearings WHERE id=?", (clearing_id,)).fetchone()
    require_branch(emp, cl["branch_id"], "关闭")
    n = conn.execute("SELECT COUNT(*) c FROM clearing_reviews WHERE clearing_id=?",
                     (clearing_id,)).fetchone()["c"]
    if n < 2:
        raise BusinessError(f"双人复核未完成（当前 {n}/2），禁止关闭清机单")
    pend = conn.execute(
        "SELECT COUNT(*) c FROM discrepancies WHERE clearing_id=? AND status='pending'",
        (clearing_id,)).fetchone()["c"]
    if pend:
        raise BusinessError(f"仍有 {pend} 条差异待处理，禁止关闭清机单")
    if cl["status"] != "reviewed":
        raise BusinessError(f"清机单状态 {cl['status']}，不可关闭")
    with db.tx(conn):
        conn.execute("UPDATE clearings SET status='closed', closed_at=? WHERE id=?",
                     (now(), clearing_id))
        # 清机后钞箱归位
        conn.execute("UPDATE cassettes SET status='idle' WHERE atm_id=?", (cl["atm_id"],))
        audit(conn, emp, "关闭清机单", "clearing", cl["code"])
    return {"clearing_id": clearing_id, "status": "closed"}


# ---------------- 差额处置 / 金额修正 ----------------

def list_discrepancies(conn: sqlite3.Connection, branch_id: int | None = None,
                       status: str | None = None) -> list[sqlite3.Row]:
    sql = """SELECT d.*, e.name AS approver_name, c.code AS clearing_code,
                    b.name AS branch_name
             FROM discrepancies d
             LEFT JOIN employees e ON e.id=d.approved_by
             LEFT JOIN clearings c ON c.id=d.clearing_id
             JOIN branches b ON b.id=d.branch_id"""
    cond, params = [], []
    if branch_id is not None:
        cond.append("d.branch_id=?"); params.append(branch_id)
    if status:
        cond.append("d.status=?"); params.append(status)
    if cond:
        sql += " WHERE " + " AND ".join(cond)
    sql += " ORDER BY d.due_date, d.id"
    return conn.execute(sql, params).fetchall()


def amend_discrepancy_amount(conn: sqlite3.Connection, employee_id: int, discrepancy_id: int,
                             new_amount: int, reason: str) -> dict:
    """修正金额：保留原值、新值、原因、审批人。"""
    emp = get_employee(conn, employee_id)
    disc = conn.execute("SELECT * FROM discrepancies WHERE id=?",
                        (discrepancy_id,)).fetchone()
    if not disc:
        raise BusinessError("差异记录不存在")
    require_branch(emp, disc["branch_id"], "修正")
    if not reason.strip():
        raise BusinessError("修正必须填写原因")
    if new_amount < 0:
        raise BusinessError("金额不能为负")
    if new_amount == disc["amount"]:
        raise BusinessError("新金额与原值一致，无需修正")
    with db.tx(conn):
        conn.execute(
            """INSERT INTO amount_amendments(discrepancy_id, old_amount, new_amount, reason,
                  approver_id, created_at) VALUES(?,?,?,?,?,?)""",
            (discrepancy_id, disc["amount"], new_amount, reason, employee_id, now()))
        conn.execute("UPDATE discrepancies SET amount=?, approved_by=? WHERE id=?",
                     (new_amount, employee_id, discrepancy_id))
        audit(conn, emp, "金额修正", "discrepancy", disc["code"],
              f"{disc['amount']} → {new_amount}，原因：{reason}")
    return {"discrepancy_id": discrepancy_id, "old_amount": disc["amount"],
            "new_amount": new_amount}


def resolve_discrepancy(conn: sqlite3.Connection, employee_id: int, discrepancy_id: int,
                        action: str = "resolved", comment: str = "") -> dict:
    """审批/核销差异。action: approved / resolved / rejected。"""
    emp = get_employee(conn, employee_id)
    disc = conn.execute("SELECT * FROM discrepancies WHERE id=?",
                        (discrepancy_id,)).fetchone()
    require_branch(emp, disc["branch_id"], "处理差异")
    if disc["status"] != "pending":
        raise BusinessError("差异已处理，不能重复操作")
    if action not in ("approved", "resolved", "rejected"):
        raise BusinessError("非法处理动作")
    with db.tx(conn):
        conn.execute(
            "UPDATE discrepancies SET status=?, approved_by=?, resolved_at=? WHERE id=?",
            ("resolved" if action == "approved" else action, employee_id, now(),
             discrepancy_id))
        audit(conn, emp, "差异处置", "discrepancy", disc["code"],
              f"{action} {comment}")
    return {"discrepancy_id": discrepancy_id, "status": action}


def amendments(conn: sqlite3.Connection, discrepancy_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT a.*, e.name AS approver_name FROM amount_amendments a
           JOIN employees e ON e.id=a.approver_id
           WHERE a.discrepancy_id=? ORDER BY a.id""", (discrepancy_id,)).fetchall()


# ---------------- 钞箱交接（两名不同员工签收） ----------------

def create_handover(conn: sqlite3.Connection, employee_id: int, cassette_id: int,
                    to_branch_id: int) -> dict:
    emp = get_employee(conn, employee_id)
    cass = conn.execute("SELECT * FROM cassettes WHERE id=?", (cassette_id,)).fetchone()
    require_branch(emp, cass["branch_id"], "发起交接")
    if not cass["sealed"]:
        raise BusinessError("钞箱离开网点前必须封存并加封签")
    pend = conn.execute(
        "SELECT id FROM handovers WHERE cassette_id=? AND status='pending'",
        (cassette_id,)).fetchone()
    if pend:
        raise BusinessError("该钞箱已有进行中的交接单")
    hcode = code("H")
    with db.tx(conn):
        cur = conn.execute(
            """INSERT INTO handovers(code, cassette_id, from_branch_id, to_branch_id,
                  status, created_by, created_at) VALUES(?,?,?,?, 'pending', ?, ?)""",
            (hcode, cassette_id, cass["branch_id"], to_branch_id, employee_id, now()))
        hid = cur.lastrowid
        conn.execute("UPDATE cassettes SET status='in_transit' WHERE id=?", (cassette_id,))
        track(conn, cassette_id, "发起交接", employee_id,
              detail=f"由网点 {cass['branch_id']} 调出")
        audit(conn, emp, "发起钞箱交接", "handover", hcode)
    return {"handover_code": hcode, "handover_id": hid}


def signoff_handover(conn: sqlite3.Connection, employee_id: int, handover_id: int) -> dict:
    """签收：须两名不同员工；两人签完即完成交接、钞箱落到新网点。"""
    emp = get_employee(conn, employee_id)
    h = conn.execute("SELECT * FROM handovers WHERE id=?", (handover_id,)).fetchone()
    if not h:
        raise BusinessError("交接单不存在")
    # 签收人须为调出或调入网点员工，且与发起流程相关
    if emp["branch_id"] not in (h["from_branch_id"], h["to_branch_id"]):
        raise PermissionError403("非交接双方网点员工，无权签收")
    if h["status"] != "pending":
        raise BusinessError("交接单已完成")
    exists = conn.execute(
        "SELECT id FROM handover_signoffs WHERE handover_id=? AND employee_id=?",
        (handover_id, employee_id)).fetchone()
    if exists:
        raise BusinessError("同一员工不能重复签收")
    with db.tx(conn):
        conn.execute(
            "INSERT INTO handover_signoffs(handover_id, employee_id, created_at) VALUES(?,?,?)",
            (handover_id, employee_id, now()))
        track(conn, h["cassette_id"], "交接签收", employee_id,
              detail=f"签收人 {emp['name']}")
        n = conn.execute(
            "SELECT COUNT(*) c FROM handover_signoffs WHERE handover_id=?",
            (handover_id,)).fetchone()["c"]
        if n >= 2:
            conn.execute("UPDATE handovers SET status='completed', completed_at=? WHERE id=?",
                         (now(), handover_id))
            to_branch = conn.execute(
                "SELECT name FROM branches WHERE id=?", (h["to_branch_id"],)).fetchone()["name"]
            conn.execute(
                "UPDATE cassettes SET branch_id=?, location=?, status='stored' WHERE id=?",
                (h["to_branch_id"], to_branch, h["cassette_id"]))
            track(conn, h["cassette_id"], "交接完成", employee_id,
                  location=to_branch, detail="双人签收完成，钞箱到达新网点")
        audit(conn, emp, "交接签收", "handover", h["code"], f"第 {n} 人签收")
    return {"handover_id": handover_id, "signoffs": n}


def list_handovers(conn: sqlite3.Connection, branch_id: int | None = None) -> list[sqlite3.Row]:
    sql = """SELECT h.*, c.code AS cassette_code, c.seal_no,
                    b1.name AS from_branch_name, b2.name AS to_branch_name
             FROM handovers h
             JOIN cassettes c ON c.id=h.cassette_id
             JOIN branches b1 ON b1.id=h.from_branch_id
             JOIN branches b2 ON b2.id=h.to_branch_id"""
    params: tuple = ()
    if branch_id is not None:
        sql += " WHERE h.from_branch_id=? OR h.to_branch_id=?"
        params = (branch_id, branch_id)
    sql += " ORDER BY h.id DESC"
    rows = conn.execute(sql, params).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["signoffs"] = conn.execute(
            """SELECT s.*, e.name AS employee_name, b.name AS branch_name
               FROM handover_signoffs s
               JOIN employees e ON e.id=s.employee_id
               JOIN branches b ON b.id=e.branch_id
               WHERE s.handover_id=? ORDER BY s.id""", (r["id"],)).fetchall()
        out.append(d)
    return out


# ---------------- 附件（本地目录） ----------------

def save_attachment(conn: sqlite3.Connection, employee_id: int, clearing_id: int,
                    filename: str, data: bytes) -> dict:
    emp = get_employee(conn, employee_id)
    cl = conn.execute("SELECT * FROM clearings WHERE id=?", (clearing_id,)).fetchone()
    require_branch(emp, cl["branch_id"], "上传附件")
    db.ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    safe = uuid.uuid4().hex + "_" + filename.replace("/", "_").replace("\\", "_")
    path = db.ATTACH_DIR / safe
    path.write_bytes(data)
    with db.tx(conn):
        conn.execute(
            """INSERT INTO attachments(clearing_id, filename, stored_path, size, uploaded_by, created_at)
               VALUES(?,?,?,?,?,?)""",
            (clearing_id, filename, str(path), len(data), employee_id, now()))
        audit(conn, emp, "上传清机附件", "clearing", cl["code"], filename)
    return {"filename": filename, "size": len(data)}


def list_attachments(conn: sqlite3.Connection, clearing_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT a.*, e.name AS uploaded_by_name FROM attachments a
           LEFT JOIN employees e ON e.id=a.uploaded_by
           WHERE a.clearing_id=? ORDER BY a.id""", (clearing_id,)).fetchall()


# ---------------- 进程内补传队列 ----------------

class JobQueue:
    """进程内任务队列：后台线程串行处理补传，失败重试。"""

    def __init__(self, conn_factory=db.connect, max_attempts: int = 3):
        self.q: queue.Queue[int] = queue.Queue()
        self.conn_factory = conn_factory
        self.max_attempts = max_attempts
        self.worker: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self):
        if self.worker and self.worker.is_alive():
            return
        self._stop.clear()
        self.worker = threading.Thread(target=self._run, daemon=True, name="reupload-worker")
        self.worker.start()

    def stop(self):
        self._stop.set()
        self.q.put(-1)

    def enqueue(self, ref_text: str, payload: dict[str, Any]) -> str:
        conn = self.conn_factory()
        try:
            jcode = code("J")
            with db.tx(conn):
                conn.execute(
                    """INSERT INTO jobs(code, type, ref_text, payload, status, attempts,
                          created_at, updated_at) VALUES(?, 'reupload', ?, ?, 'queued', 0, ?, ?)""",
                    (jcode, ref_text, json.dumps(payload, ensure_ascii=False), now(), now()))
                jid = conn.execute("SELECT id FROM jobs WHERE code=?", (jcode,)).fetchone()["id"]
            self.q.put(jid)
            return jcode
        finally:
            conn.close()

    def _run(self):
        while not self._stop.is_set():
            try:
                jid = self.q.get(timeout=1)
            except queue.Empty:
                continue
            if jid == -1:
                break
            self._process(jid)

    def _process(self, jid: int):
        conn = self.conn_factory()
        try:
            job = conn.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
            if not job or job["status"] != "queued":
                return
            attempts = job["attempts"] + 1
            with db.tx(conn):
                conn.execute(
                    "UPDATE jobs SET status='running', attempts=?, updated_at=? WHERE id=?",
                    (attempts, now(), jid))
            # 模拟补传：前两次失败，第三次成功（演示重试）
            if attempts < min(2, self.max_attempts):
                with db.tx(conn):
                    conn.execute(
                        "UPDATE jobs SET status='queued', last_error=?, updated_at=? WHERE id=?",
                        (f"网络超时，第 {attempts} 次补传失败，待重试", now(), jid))
                time.sleep(0.2)
                self.q.put(jid)
                return
            if attempts >= self.max_attempts:
                with db.tx(conn):
                    conn.execute(
                        "UPDATE jobs SET status='failed', last_error=?, updated_at=? WHERE id=?",
                        ("超过最大重试次数", now(), jid))
                return
            with db.tx(conn):
                conn.execute(
                    "UPDATE jobs SET status='succeeded', last_error='', updated_at=? WHERE id=?",
                    (now(), jid))
        finally:
            conn.close()

    def list_jobs(self, limit: int = 50) -> list[sqlite3.Row]:
        conn = self.conn_factory()
        try:
            return conn.execute("SELECT * FROM jobs ORDER BY id DESC LIMIT ?",
                                (limit,)).fetchall()
        finally:
            conn.close()

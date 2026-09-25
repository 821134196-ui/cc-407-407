"""平台业务规则测试：零依赖 unittest。

覆盖：券别汇总、钞箱锁定、重复回传、双人复核、金额修正、网点权限、并发领取、
双人签收、差异未处置禁止关闭、离线差异。
"""
from __future__ import annotations

import os
import tempfile
import threading
import unittest
from pathlib import Path

from app import db, seed, services as svc


class PlatformTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["ATM_DATA_DIR"] = self.tmp.name
        # 重新绑定 db 模块路径常量
        db.DATA_DIR = Path(self.tmp.name)
        db.DB_PATH = Path(self.tmp.name) / "test.db"
        db.ATTACH_DIR = Path(self.tmp.name) / "attach"
        self.conn = db.connect(db.DB_PATH)
        db.migrate(self.conn)
        seed.seed(self.conn, force=True)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def err(self, fn, *args, **kwargs):
        with self.assertRaises(svc.BusinessError) as cx:
            fn(self.conn, *args, **kwargs)
        return str(cx.exception)


class TestDenomSummary(PlatformTestBase):
    """券别汇总：按券别统计张数与金额，合计正确。"""

    def test_plan_denom_breakdown(self):
        # 样例计划 p1: 100×2000, 50×1000
        plan = self.conn.execute(
            "SELECT id FROM loading_plans WHERE code IN "
            "(SELECT code FROM loading_plans ORDER BY id LIMIT 1)").fetchone()
        pid = self.conn.execute("SELECT MIN(id) id FROM loading_plans").fetchone()["id"]
        rows = svc.denom_breakdown(self.conn, "loading_plan_items", "plan_id", pid, "qty")
        m = {r["denom"]: r for r in rows}
        self.assertEqual(m[100]["qty"], 2000)
        self.assertEqual(m[100]["amount"], 200_000)
        self.assertEqual(m[50]["qty"], 1000)
        self.assertEqual(m[50]["amount"], 50_000)
        self.assertEqual(m[20]["qty"], 0)
        self.assertEqual(sum(r["amount"] for r in rows), 250_000)

    def test_cassette_denom_totals_for_atm(self):
        # ATM3 已装钞 100×1500, 20×600
        total = self.conn.execute(
            "SELECT COALESCE(SUM(qty*denomination_value),0) t FROM cassettes WHERE atm_id=3"
        ).fetchone()["t"]
        self.assertEqual(total, 150_000 + 12_000)
        by_denom = {r["denomination_value"]: r["qty"] for r in self.conn.execute(
            "SELECT denomination_value, SUM(qty) qty FROM cassettes WHERE atm_id=3 GROUP BY 1")}
        self.assertEqual(by_denom[100], 1500)
        self.assertEqual(by_denom[20], 600)


class TestLocks(PlatformTestBase):
    """锁定规则：计划锁定后不可改；封存钞箱不可直接改数量；未锁定不可装钞。"""

    def test_locked_plan_cannot_change(self):
        r = svc.create_plan(self.conn, 101, 1, {100: 100, 50: 50})
        pid = r["plan_id"]
        # 草稿可改
        svc.update_plan_items(self.conn, 101, pid, {100: 120})
        svc.lock_plan(self.conn, 101, pid)
        msg = self.err(svc.update_plan_items, 101, pid, {100: 1})
        self.assertIn("锁定", msg)
        msg = self.err(svc.lock_plan, 101, pid)
        self.assertIn("草稿", msg)

    def test_load_requires_locked_plan(self):
        r = svc.create_plan(self.conn, 101, 1, {10: 100})
        msg = self.err(svc.load_plan, 101, r["plan_id"])
        self.assertIn("锁定", msg)

    def test_sealed_cassette_qty_locked(self):
        spare = self.conn.execute(
            "SELECT id FROM cassettes WHERE code='CS0017'").fetchone()
        # seed 中该箱先报封签破损后重新封存
        cass = self.conn.execute("SELECT * FROM cassettes WHERE id=?",
                                 (spare["id"],)).fetchone()
        if not cass["sealed"]:
            svc.seal_cassette(self.conn, 101, spare["id"], "SEAL-TEST-1")
        msg = self.err(svc.update_cassette_qty, 101, spare["id"], 999)
        self.assertIn("封存", msg)
        # 解封后可以改
        svc.unseal_cassette(self.conn, 101, spare["id"])
        svc.update_cassette_qty(self.conn, 101, spare["id"], 999)
        self.assertEqual(self.conn.execute(
            "SELECT qty FROM cassettes WHERE id=?", (spare["id"],)).fetchone()["qty"], 999)

    def test_qty_cannot_exceed_capacity(self):
        cid = self.conn.execute(
            "SELECT id FROM cassettes WHERE sealed=0 ORDER BY id LIMIT 1").fetchone()["id"]
        cap = self.conn.execute("SELECT capacity FROM cassettes WHERE id=?",
                                (cid,)).fetchone()["capacity"]
        self.err(svc.update_cassette_qty, 101, cid, cap + 1)


class TestDuplicateSubmission(PlatformTestBase):
    """重复回传：同批次号拒绝并登记差异。"""

    def test_duplicate_batch_rejected(self):
        r = svc.open_clearing(self.conn, 102, 2, note="重复回传测试")
        msg = self.err(svc.submit_clearing, 102, r["clearing_id"],
                       {100: 800}, batch_no="BATCH-20260921-09")
        self.assertIn("重复回传", msg)
        disc = self.conn.execute(
            "SELECT * FROM discrepancies WHERE clearing_id=? AND type='duplicate'",
            (r["clearing_id"],)).fetchone()
        self.assertIsNotNone(disc)
        self.assertIn("BATCH-20260921-09", disc["description"])
        # 被拒绝的清机单仍为 open，实点未入账
        cl = self.conn.execute("SELECT status FROM clearings WHERE id=?",
                               (r["clearing_id"],)).fetchone()
        self.assertEqual(cl["status"], "open")

    def test_cannot_submit_twice(self):
        # c3 已 submitted
        cid = self.conn.execute("SELECT id FROM clearings WHERE status='submitted' LIMIT 1"
                                ).fetchone()["id"]
        self.err(svc.submit_clearing, 202, cid, {100: 1})


class TestDoubleReview(PlatformTestBase):
    """双人复核规则。"""

    def _fresh_clearing(self):
        # ATM4（城东）尚无清机样例：101 无权限，改用 301/302
        r = svc.create_plan(self.conn, 301, 4, {100: 500})
        svc.lock_plan(self.conn, 301, r["plan_id"])
        svc.load_plan(self.conn, 302, r["plan_id"])
        c = svc.open_clearing(self.conn, 302, 4, plan_id=r["plan_id"])
        svc.submit_clearing(self.conn, 302, c["clearing_id"], {100: 500},
                            batch_no="BATCH-TEST-DR")
        return c["clearing_id"]

    def test_review_rules(self):
        cid = self._fresh_clearing()
        # 开单人不能复核自己
        msg = self.err(svc.review_clearing, 302, cid)
        self.assertIn("自己", msg)
        # 第一人复核后仍是 submitted
        svc.review_clearing(self.conn, 301, cid, "第一复核人")
        st = self.conn.execute("SELECT status FROM clearings WHERE id=?",
                               (cid,)).fetchone()["status"]
        self.assertEqual(st, "submitted")
        # 同一人不能复核两次
        self.err(svc.review_clearing, 301, cid)
        # 未完成双人复核禁止关闭
        msg = self.err(svc.close_clearing, 301, cid)
        self.assertIn("双人复核", msg)
        # 第二人复核 → reviewed → 可关闭
        # 城东只有 301/302 两名员工；需要第二名不同员工，临时加一名
        self.conn.execute(
            "INSERT INTO employees(code,name,branch_id,role) VALUES('E303','郑凯',3,'clerk')")
        e303 = self.conn.execute("SELECT id FROM employees WHERE code='E303'").fetchone()["id"]
        svc.review_clearing(self.conn, e303, cid, "第二复核人")
        st = self.conn.execute("SELECT status FROM clearings WHERE id=?",
                               (cid,)).fetchone()["status"]
        self.assertEqual(st, "reviewed")
        svc.close_clearing(self.conn, 301, cid)

    def test_pending_discrepancy_blocks_close(self):
        # c3 已一人复核且有 pending 长款：补齐第二人复核后仍应禁止关闭
        cid = self.conn.execute(
            "SELECT id FROM clearings WHERE status='submitted' LIMIT 1").fetchone()["id"]
        svc.review_clearing(self.conn, 203, cid, "第二人")
        msg = self.err(svc.close_clearing, 201, cid)
        self.assertIn("差异", msg)
        for d in self.conn.execute(
                "SELECT id FROM discrepancies WHERE clearing_id=? AND status='pending'",
                (cid,)):
            svc.resolve_discrepancy(self.conn, 201, d["id"], "approved")
        svc.close_clearing(self.conn, 201, cid)


class TestAmountAmendment(PlatformTestBase):
    """金额修正保留原值、新值、原因、审批人。"""

    def test_amend_keeps_history(self):
        disc = self.conn.execute(
            "SELECT * FROM discrepancies WHERE type='short' LIMIT 1").fetchone()
        self.assertEqual(disc["amount"], 400)  # seed 已从 500 修正为 400
        hist = svc.amendments(self.conn, disc["id"])
        self.assertEqual(len(hist), 1)
        self.assertEqual((hist[0]["old_amount"], hist[0]["new_amount"]), (500, 400))
        self.assertIn("冲正", hist[0]["reason"])
        self.assertEqual(hist[0]["approver_id"], 101)
        # 再修正一次
        svc.amend_discrepancy_amount(self.conn, 101, disc["id"], 350, "复核后追加调减")
        hist = svc.amendments(self.conn, disc["id"])
        self.assertEqual(len(hist), 2)
        self.assertEqual((hist[1]["old_amount"], hist[1]["new_amount"]), (400, 350))

    def test_amend_requires_reason(self):
        disc = self.conn.execute(
            "SELECT id FROM discrepancies WHERE status='pending' LIMIT 1").fetchone()
        self.err(svc.amend_discrepancy_amount, 101, disc["id"], 1, "  ")

    def test_same_amount_noop(self):
        disc = self.conn.execute(
            "SELECT * FROM discrepancies WHERE status='pending' LIMIT 1").fetchone()
        self.err(svc.amend_discrepancy_amount,
                 self.conn.execute("SELECT id FROM employees WHERE branch_id=? LIMIT 1",
                                   (disc["branch_id"],)).fetchone()["id"],
                 disc["id"], disc["amount"], "相同")


class TestBranchPermission(PlatformTestBase):
    """网点权限：跨网点操作一律拒绝。"""

    def test_cross_branch_plan(self):
        # 201（滨江路）不能为 ATM1（中心支行）建计划
        msg = self.err(svc.create_plan, 201, 1, {100: 10})
        self.assertIn("网点权限", msg)

    def test_cross_branch_review(self):
        cid = self.conn.execute(
            "SELECT id FROM clearings WHERE status='submitted' LIMIT 1").fetchone()["id"]
        branch = self.conn.execute("SELECT branch_id FROM clearings WHERE id=?",
                                   (cid,)).fetchone()["branch_id"]
        other = self.conn.execute(
            "SELECT id FROM employees WHERE branch_id<>? LIMIT 1", (branch,)).fetchone()["id"]
        msg = self.err(svc.review_clearing, other, cid)
        self.assertIn("网点权限", msg)

    def test_cross_branch_claim_seal_handover(self):
        cid = self.conn.execute("SELECT id FROM cassettes WHERE branch_id=2 LIMIT 1"
                                ).fetchone()["id"]
        msg = self.err(svc.claim_cassette, 101, cid)
        self.assertIn("网点权限", msg)
        msg = self.err(svc.seal_cassette, 101, cid, "X1")
        self.assertIn("网点权限", msg)

    def test_cross_branch_amend(self):
        disc = self.conn.execute(
            "SELECT * FROM discrepancies WHERE status='pending' LIMIT 1").fetchone()
        other = self.conn.execute(
            "SELECT id FROM employees WHERE branch_id<>? LIMIT 1",
            (disc["branch_id"],)).fetchone()["id"]
        self.err(svc.amend_discrepancy_amount, other, disc["id"], 1, "越权")


class TestConcurrentClaim(PlatformTestBase):
    """两名员工同时领取同一钞箱，只有一人成功。"""

    def test_concurrent_claims_only_one_wins(self):
        cid = self.conn.execute(
            "SELECT id FROM cassettes WHERE branch_id=2 AND status!='claimed' "
            "AND sealed=0 ORDER BY id LIMIT 1").fetchone()["id"]
        results = {}
        barrier = threading.Barrier(2)

        def claim(emp_id, key):
            conn = db.connect(db.DB_PATH)
            try:
                barrier.wait()
                try:
                    svc.claim_cassette(conn, emp_id, cid)
                    results[key] = True
                except svc.BusinessError:
                    results[key] = False
            finally:
                conn.close()

        t1 = threading.Thread(target=claim, args=(202, "a"))
        t2 = threading.Thread(target=claim, args=(203, "b"))
        t1.start(); t2.start(); t1.join(); t2.join()
        self.assertEqual(sorted(results.values()), [False, True])
        active = self.conn.execute(
            "SELECT COUNT(*) c FROM cassette_claims WHERE cassette_id=? AND status='active'",
            (cid,)).fetchone()["c"]
        self.assertEqual(active, 1)
        # 释放后可再领取
        winner = 202 if results["a"] else 203
        svc.release_cassette(self.conn, winner, cid)
        svc.claim_cassette(self.conn, 202 if winner == 203 else 203, cid)


class TestHandover(PlatformTestBase):
    """钞箱交接：必须封存、两名不同员工签收。"""

    def test_handover_requires_sealed(self):
        cid = self.conn.execute(
            "SELECT id FROM cassettes WHERE sealed=0 AND atm_id IS NOT NULL LIMIT 1"
        ).fetchone()["id"]
        msg = self.err(svc.create_handover, 101, cid, 2)
        self.assertIn("封存", msg)

    def test_two_distinct_signoffs(self):
        cid = self.conn.execute(
            "SELECT id FROM cassettes WHERE sealed=0 AND branch_id=3 AND atm_id IS NOT NULL LIMIT 1"
        ).fetchone()["id"]
        svc.seal_cassette(self.conn, 301, cid, "SEAL-H-1")
        h = svc.create_handover(self.conn, 301, cid, 2)
        # 第一签收人 301（调出方）
        svc.signoff_handover(self.conn, 301, h["handover_id"])
        # 同一人不能再签
        self.err(svc.signoff_handover, 301, h["handover_id"])
        row = self.conn.execute("SELECT status FROM handovers WHERE id=?",
                                (h["handover_id"],)).fetchone()
        self.assertEqual(row["status"], "pending")
        # 第二签收人须为双方网点员工：202（调入方）
        svc.signoff_handover(self.conn, 202, h["handover_id"])
        row = self.conn.execute("SELECT status FROM handovers WHERE id=?",
                                (h["handover_id"],)).fetchone()
        self.assertEqual(row["status"], "completed")
        # 钞箱已落到新网点
        cass = self.conn.execute("SELECT * FROM cassettes WHERE id=?", (cid,)).fetchone()
        self.assertEqual(cass["branch_id"], 2)
        # 第三方网点员工不能签收
        h2 = svc.create_handover(self.conn, 201, cid, 1)
        msg = self.err(svc.signoff_handover, 301, h2["handover_id"])
        self.assertIn("无权签收", msg)


class TestOfflineAndDefects(PlatformTestBase):
    """离线 ATM 开单自动登记差异；残钞录入。"""

    def test_offline_auto_discrepancy(self):
        r = svc.open_clearing(self.conn, 102, 2, note="离线")
        disc = self.conn.execute(
            "SELECT * FROM discrepancies WHERE clearing_id=? AND type='offline'",
            (r["clearing_id"],)).fetchone()
        self.assertIsNotNone(disc)

    def test_defect_qty_validation(self):
        r = svc.open_clearing(self.conn, 102, 2, note="残钞校验")
        items = self.conn.execute(
            "SELECT DISTINCT denomination_value FROM clearing_items WHERE clearing_id=?",
            (r["clearing_id"],)).fetchall()
        d = items[0]["denomination_value"]
        msg = self.err(svc.submit_clearing, 102, r["clearing_id"],
                       {d: 10}, defects={d: 11}, batch_no="B-BAD-1")
        self.assertIn("残钞", msg)


class TestJobQueue(unittest.TestCase):
    """进程内补传队列：失败重试直至成功/失败。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.DATA_DIR = Path(self.tmp.name)
        db.DB_PATH = Path(self.tmp.name) / "q.db"
        db.ATTACH_DIR = Path(self.tmp.name) / "att"
        conn = db.connect(db.DB_PATH)
        db.migrate(conn)
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_retry_then_succeed(self):
        jq = svc.JobQueue(max_attempts=3)
        jq.start()
        code = jq.enqueue("X1", {"k": 1})
        deadline = 0
        import time
        for _ in range(50):
            conn = db.connect(db.DB_PATH)
            st = conn.execute("SELECT status, attempts FROM jobs WHERE code=?",
                              (code,)).fetchone()
            conn.close()
            if st["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.1)
        conn = db.connect(db.DB_PATH)
        st = conn.execute("SELECT status, attempts FROM jobs WHERE code=?",
                          (code,)).fetchone()
        conn.close()
        jq.stop()
        # 模拟逻辑：attempts<min(2,3)=2 重试，第 2 次满足 attempts>=2 且 <3 → succeeded
        self.assertEqual(st["status"], "succeeded")
        self.assertGreaterEqual(st["attempts"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""数据库连接、建表与自动迁移（SQLite）。"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ATM_DATA_DIR", BASE_DIR / "data"))
DB_PATH = Path(os.environ.get("ATM_DB_PATH", DATA_DIR / "atm_platform.db"))
ATTACH_DIR = DATA_DIR / "attachments"

SCHEMA_VERSION = 1

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    role TEXT NOT NULL DEFAULT 'clerk'   -- clerk 出纳 / manager 主管
);

CREATE TABLE IF NOT EXISTS atms (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'online', -- online / offline
    address TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS denominations (
    id INTEGER PRIMARY KEY,
    value INTEGER UNIQUE NOT NULL,  -- 面额（元）：100/50/20/10/5/1
    label TEXT NOT NULL
);

-- 钞箱：编号、券别、容量、封签号、当前位置
CREATE TABLE IF NOT EXISTS cassettes (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    denomination_value INTEGER NOT NULL,
    capacity INTEGER NOT NULL,            -- 券别容量（张）
    qty INTEGER NOT NULL DEFAULT 0,       -- 当前张数
    seal_no TEXT DEFAULT '',              -- 封签号
    sealed INTEGER NOT NULL DEFAULT 0,    -- 是否封存
    status TEXT NOT NULL DEFAULT 'idle',  -- idle/loaded/claimed/in_transit/stored
    location TEXT NOT NULL DEFAULT '',    -- 当前位置
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    atm_id INTEGER REFERENCES atms(id)
);

-- 装钞计划
CREATE TABLE IF NOT EXISTS loading_plans (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    atm_id INTEGER NOT NULL REFERENCES atms(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'draft', -- draft/locked/loaded/cancelled
    created_by INTEGER NOT NULL REFERENCES employees(id),
    created_at TEXT NOT NULL,
    locked_at TEXT,
    loaded_at TEXT,
    note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS loading_plan_items (
    id INTEGER PRIMARY KEY,
    plan_id INTEGER NOT NULL REFERENCES loading_plans(id),
    denomination_value INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    UNIQUE(plan_id, denomination_value)
);

-- 清机单
CREATE TABLE IF NOT EXISTS clearings (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    batch_no TEXT UNIQUE,                 -- 回传批次号（用于重复回传判定）
    atm_id INTEGER NOT NULL REFERENCES atms(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    plan_id INTEGER REFERENCES loading_plans(id),
    status TEXT NOT NULL DEFAULT 'open',  -- open/submitted/reviewed/closed
    opened_by INTEGER NOT NULL REFERENCES employees(id),
    opened_at TEXT NOT NULL,
    submitted_at TEXT,
    closed_at TEXT,
    expected_total INTEGER NOT NULL DEFAULT 0,
    actual_total INTEGER NOT NULL DEFAULT 0,
    note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS clearing_items (
    id INTEGER PRIMARY KEY,
    clearing_id INTEGER NOT NULL REFERENCES clearings(id),
    denomination_value INTEGER NOT NULL,
    expected_qty INTEGER NOT NULL DEFAULT 0,
    actual_qty INTEGER,
    defect_qty INTEGER NOT NULL DEFAULT 0, -- 残钞张数
    UNIQUE(clearing_id, denomination_value)
);

-- 差异记录：短款 short / 长款 over / 残钞 defect / 封签破损 seal_broken /
--          ATM 离线 offline / 重复回传 duplicate
CREATE TABLE IF NOT EXISTS discrepancies (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    clearing_id INTEGER REFERENCES clearings(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    type TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    denomination_value INTEGER,
    status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/resolved/rejected
    due_date TEXT NOT NULL,                -- 处理期限
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    approved_by INTEGER REFERENCES employees(id),
    resolved_at TEXT
);

-- 金额修正留痕：原值、新值、原因、审批人
CREATE TABLE IF NOT EXISTS amount_amendments (
    id INTEGER PRIMARY KEY,
    discrepancy_id INTEGER NOT NULL REFERENCES discrepancies(id),
    old_amount INTEGER NOT NULL,
    new_amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    approver_id INTEGER NOT NULL REFERENCES employees(id),
    created_at TEXT NOT NULL
);

-- 清机单双人复核（同一人只能复核一次）
CREATE TABLE IF NOT EXISTS clearing_reviews (
    id INTEGER PRIMARY KEY,
    clearing_id INTEGER NOT NULL REFERENCES clearings(id),
    reviewer_id INTEGER NOT NULL REFERENCES employees(id),
    comment TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(clearing_id, reviewer_id)
);

-- 钞箱领取（活跃领取唯一：两人同时领取只允许一人成功）
CREATE TABLE IF NOT EXISTS cassette_claims (
    id INTEGER PRIMARY KEY,
    cassette_id INTEGER NOT NULL REFERENCES cassettes(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    status TEXT NOT NULL DEFAULT 'active', -- active/released
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cassette_claim_active
    ON cassette_claims(cassette_id) WHERE status = 'active';

-- 钞箱交接（离开网点需两名不同员工签收）
CREATE TABLE IF NOT EXISTS handovers (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    cassette_id INTEGER NOT NULL REFERENCES cassettes(id),
    from_branch_id INTEGER NOT NULL REFERENCES branches(id),
    to_branch_id INTEGER NOT NULL REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'pending', -- pending/completed
    created_by INTEGER NOT NULL REFERENCES employees(id),
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE TABLE IF NOT EXISTS handover_signoffs (
    id INTEGER PRIMARY KEY,
    handover_id INTEGER NOT NULL REFERENCES handovers(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    created_at TEXT NOT NULL,
    UNIQUE(handover_id, employee_id)
);

-- 钞箱连续轨迹（含封签状态）
CREATE TABLE IF NOT EXISTS cassette_tracks (
    id INTEGER PRIMARY KEY,
    cassette_id INTEGER NOT NULL REFERENCES cassettes(id),
    event TEXT NOT NULL,
    seal_no TEXT DEFAULT '',
    location TEXT DEFAULT '',
    operator_id INTEGER REFERENCES employees(id),
    detail TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

-- 清机附件（本地目录）
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY,
    clearing_id INTEGER NOT NULL REFERENCES clearings(id),
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES employees(id),
    created_at TEXT NOT NULL
);

-- 进程内补传任务队列
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL DEFAULT 'reupload',
    ref_text TEXT DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued', -- queued/running/succeeded/failed
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    actor_name TEXT DEFAULT '',
    branch_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    ref_code TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracks_cassette ON cassette_tracks(cassette_id, id);
CREATE INDEX IF NOT EXISTS idx_disc_branch ON discrepancies(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
"""


def connect(path: str | Path | None = None) -> sqlite3.Connection:
    p = Path(path) if path else DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


@contextmanager
def tx(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def migrate(conn: sqlite3.Connection) -> None:
    """自动迁移：建表并维护 user_version。"""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:
        conn.executescript(SCHEMA_SQL)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    # 后续版本在此追加 ALTER / 迁移逻辑

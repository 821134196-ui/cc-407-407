// 数据库结构定义。金额一律以「分」(INTEGER) 存储,避免浮点误差。
// 版本化迁移:启动时自动执行未应用的版本。
export const MIGRATIONS = [
  {
    version: 1,
    name: 'init',
    sql: `
-- 网点
CREATE TABLE branches (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  address     TEXT,
  created_at  TEXT NOT NULL
);

-- 员工(归属网点;is_hq=1 的中心金库/清算中心员工可跨网点)
CREATE TABLE employees (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  branch_id   INTEGER REFERENCES branches(id),
  role        TEXT NOT NULL DEFAULT '柜员',      -- 柜员/库管员/复核员/主管
  is_hq       INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- 券别(面值,单位:分)
CREATE TABLE denominations (
  id          INTEGER PRIMARY KEY,
  value_fen   INTEGER NOT NULL UNIQUE,           -- 10000=100元
  label       TEXT NOT NULL,                     -- 壹佰圆
  sort_order  INTEGER NOT NULL
);

-- ATM 台账
CREATE TABLE atms (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  status      TEXT NOT NULL DEFAULT 'online',   -- online/offline/maintenance
  model       TEXT,
  location    TEXT,
  created_at  TEXT NOT NULL
);

-- 钞箱:编号、券别容量、封签号、当前位置
CREATE TABLE cassettes (
  id              INTEGER PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  denomination_id INTEGER NOT NULL REFERENCES denominations(id),
  capacity_notes  INTEGER NOT NULL DEFAULT 2500,  -- 容量(张)
  loaded_notes    INTEGER NOT NULL DEFAULT 0,     -- 当前在钞张数
  seal_no         TEXT,                           -- 封签号
  seal_status     TEXT NOT NULL DEFAULT 'unsealed', -- unsealed/sealed/broken
  status          TEXT NOT NULL DEFAULT 'idle',   -- idle/loaded/transit/vault
  current_atm_id  INTEGER REFERENCES atms(id),
  current_branch_id INTEGER REFERENCES branches(id),
  position_label  TEXT NOT NULL DEFAULT '中心金库',  -- 当前位置(可读)
  claimed_by      INTEGER REFERENCES employees(id), -- 当前领取人(并发互斥)
  claimed_at      TEXT,
  created_at      TEXT NOT NULL
);

-- 装钞计划
CREATE TABLE load_plans (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  atm_id      INTEGER NOT NULL REFERENCES atms(id),
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  status      TEXT NOT NULL DEFAULT 'draft',     -- draft/locked/completed/cancelled
  notes       TEXT,
  created_by  INTEGER REFERENCES employees(id),
  locked_by   INTEGER REFERENCES employees(id),
  locked_at   TEXT,
  completed_at TEXT,
  created_at  TEXT NOT NULL
);

-- 装钞计划明细(钞箱 + 计划张数)
CREATE TABLE load_plan_items (
  id           INTEGER PRIMARY KEY,
  plan_id      INTEGER NOT NULL REFERENCES load_plans(id) ON DELETE CASCADE,
  cassette_id  INTEGER NOT NULL REFERENCES cassettes(id),
  notes_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(plan_id, cassette_id)
);

-- 清机单
CREATE TABLE clear_orders (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  atm_id            INTEGER NOT NULL REFERENCES atms(id),
  branch_id         INTEGER NOT NULL REFERENCES branches(id),
  status            TEXT NOT NULL DEFAULT 'open',  -- open/reviewing/closed
  expected_total_fen INTEGER NOT NULL DEFAULT 0,   -- 账面应缴
  counted_total_fen  INTEGER NOT NULL DEFAULT 0,  -- 实点合计
  idempotency_key   TEXT UNIQUE,                   -- 回传幂等键
  created_by        INTEGER REFERENCES employees(id),
  closed_by         INTEGER REFERENCES employees(id),
  started_at        TEXT,
  closed_at         TEXT,
  created_at        TEXT NOT NULL
);

-- 清机逐券别实点明细
CREATE TABLE clear_entries (
  id             INTEGER PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES clear_orders(id) ON DELETE CASCADE,
  denomination_id INTEGER NOT NULL REFERENCES denominations(id),
  notes_count    INTEGER NOT NULL DEFAULT 0,
  soiled_notes   INTEGER NOT NULL DEFAULT 0,      -- 残钞张数
  amount_fen     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(order_id, denomination_id)
);

-- 差额记录:短款/长款/残钞/封签破损/ATM离线/重复回传
CREATE TABLE discrepancies (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  order_id     INTEGER REFERENCES clear_orders(id),
  cassette_id  INTEGER REFERENCES cassettes(id),
  branch_id    INTEGER NOT NULL REFERENCES branches(id),
  type         TEXT NOT NULL,  -- short/over/soiled/seal_broken/atm_offline/duplicate_report
  amount_fen   INTEGER NOT NULL DEFAULT 0, -- 短款为负,长款为正,其余 0
  title        TEXT NOT NULL,
  detail       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending/approved/adjusted/rejected
  due_date     TEXT NOT NULL,   -- 处理期限
  raised_by    INTEGER REFERENCES employees(id),
  raised_at    TEXT NOT NULL,
  resolved_by  INTEGER REFERENCES employees(id),
  resolved_at  TEXT,
  resolution   TEXT
);
CREATE INDEX idx_disc_order ON discrepancies(order_id);
CREATE INDEX idx_disc_status ON discrepancies(status);

-- 差额/清机单双人复核签名(必须两名不同员工)
CREATE TABLE review_confirms (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES clear_orders(id) ON DELETE CASCADE,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  comment      TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(order_id, employee_id)
);

-- 金额修正留痕:原值、新值、原因、审批人
CREATE TABLE amount_adjustments (
  id             INTEGER PRIMARY KEY,
  order_id       INTEGER REFERENCES clear_orders(id) ON DELETE CASCADE,
  target_type    TEXT NOT NULL,  -- order_expected / clear_entry
  target_id      INTEGER,
  denomination_id INTEGER REFERENCES denominations(id),
  old_value_fen  INTEGER NOT NULL,
  new_value_fen  INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  created_by     INTEGER NOT NULL REFERENCES employees(id),
  approver_id    INTEGER NOT NULL REFERENCES employees(id),
  created_at     TEXT NOT NULL
);

-- 钞箱交接(离开网点需两名不同员工签收)
CREATE TABLE handovers (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  cassette_id    INTEGER NOT NULL REFERENCES cassettes(id),
  from_branch_id INTEGER REFERENCES branches(id),
  to_branch_id   INTEGER REFERENCES branches(id),
  kind           TEXT NOT NULL DEFAULT 'leave_branch', -- leave_branch/receive/transfer
  seal_no        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',      -- pending/completed/rejected
  initiator_id   INTEGER REFERENCES employees(id),
  completed_at   TEXT,
  created_at     TEXT NOT NULL
);
-- 交接签收签名
CREATE TABLE handover_signoffs (
  id           INTEGER PRIMARY KEY,
  handover_id  INTEGER NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  created_at   TEXT NOT NULL,
  UNIQUE(handover_id, employee_id)
);

-- 钞箱轨迹 / 封签连续轨迹
CREATE TABLE cassette_trace (
  id           INTEGER PRIMARY KEY,
  cassette_id  INTEGER NOT NULL REFERENCES cassettes(id),
  event        TEXT NOT NULL, -- claim/load/seal/unseal/handout/signoff/receive/locate/unload
  from_label   TEXT,
  to_label     TEXT,
  seal_no      TEXT,
  seal_status  TEXT,
  actor_id     INTEGER REFERENCES employees(id),
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_trace_cassette ON cassette_trace(cassette_id, id);

-- 清机附件(本地目录保存)
CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES clear_orders(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  stored_name  TEXT NOT NULL,
  mime         TEXT,
  size_bytes   INTEGER NOT NULL,
  uploaded_by  INTEGER REFERENCES employees(id),
  created_at   TEXT NOT NULL
);

-- 进程内任务队列(同时落库,支持补传/重试/判重)
CREATE TABLE task_queue (
  id              INTEGER PRIMARY KEY,
  type            TEXT NOT NULL,   -- report_submit
  payload         TEXT NOT NULL,   -- JSON
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'queued', -- queued/running/done/failed/duplicate
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  available_at    TEXT NOT NULL,
  last_error      TEXT,
  result          TEXT,
  created_at      TEXT NOT NULL,
  processed_at    TEXT
);
CREATE INDEX idx_task_poll ON task_queue(status, available_at);

-- 审计日志
CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY,
  actor_id    INTEGER REFERENCES employees(id),
  branch_id   INTEGER REFERENCES branches(id),
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_time ON audit_logs(created_at);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- 演示账户 / 卡号 / 交易(全部为演示数据)
CREATE TABLE demo_accounts (
  id          INTEGER PRIMARY KEY,
  account_no  TEXT NOT NULL UNIQUE,
  holder_name TEXT NOT NULL,
  branch_id   INTEGER REFERENCES branches(id),
  balance_fen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE demo_cards (
  id          INTEGER PRIMARY KEY,
  card_no     TEXT NOT NULL UNIQUE,
  account_id  INTEGER NOT NULL REFERENCES demo_accounts(id),
  status      TEXT NOT NULL DEFAULT 'normal'
);
CREATE TABLE demo_txn (
  id          INTEGER PRIMARY KEY,
  card_no     TEXT NOT NULL,
  atm_id      INTEGER REFERENCES atms(id),
  txn_type    TEXT NOT NULL,
  amount_fen  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
`
  }
];

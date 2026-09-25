// SQLite 连接、迁移与小工具
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export function nowIso() {
  return new Date().toISOString();
}

// 当前时间 + n 天的 ISO(处理期限)
export function isoInDays(days) {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

export function openDb(dbPath = process.env.DB_PATH || 'data/atm.db') {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

export function migrate(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
     );`
  );
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.prepare(
      `INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`
    );
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      tx.run(m.version, nowIso());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 v${m.version}(${m.name}) 失败: ${e.message}`);
    }
  }
}

// 金额:元 -> 分(整数)。接受 12.3 / "12.30"
export function yuanToFen(yuan) {
  if (typeof yuan === 'number') {
    return Math.round(yuan * 100);
  }
  const s = String(yuan).trim();
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int, dec = ''] = body.split('.');
  const frac = (dec + '00').slice(0, 2);
  const n = BigInt((int || '0').replace(/[^\d]/g, '') || '0') * 100n + BigInt(frac);
  return (neg ? -1 : 1) * Number(n);
}

// 分 -> 元字符串(右对齐数字列使用)
export function fenToYuan(fen) {
  const neg = fen < 0;
  const v = Math.abs(Math.trunc(fen));
  const s = String(v).padStart(3, '0');
  const intPart = s.slice(0, -2);
  const decPart = s.slice(-2);
  return `${neg ? '-' : ''}${intPart}.${decPart}`;
}

// 千分位
export function fenToYuanGrouped(fen) {
  const y = fenToYuan(fen);
  const [i, d] = y.split('.');
  const neg = i.startsWith('-');
  const digits = neg ? i.slice(1) : i;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}.${d}`;
}

export function genCode(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${prefix}${stamp}${rand}`;
}

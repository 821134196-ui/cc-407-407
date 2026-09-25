// 清机附件:保存到本地目录(不入库二进制),数据库仅存元数据。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nowIso } from './db.js';

export class AttachmentStore {
  constructor(db, services, root = process.env.ATTACH_DIR || 'data/attachments') {
    this.db = db;
    this.svc = services;
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  // 以原始字节落盘,避免任何编码损坏
  save(employeeId, orderId, originalName, buffer, mime = 'application/octet-stream') {
    const order = this.svc.saveAttachment(employeeId, orderId, originalName, buffer, mime);
    const safeBase = String(originalName || 'file.bin')
      .replace(/[^\w.\-一-龥]+/g, '_').slice(0, 120) || 'file.bin';
    const ext = extname(safeBase) || '.bin';
    const stored = `${orderId}_${randomUUID()}${ext}`;
    writeFileSync(join(this.root, stored), buffer);
    const r = this.db
      .prepare(
        `INSERT INTO attachments(order_id, filename, stored_name, mime, size_bytes, uploaded_by, created_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(orderId, safeBase, stored, mime, buffer.length, employeeId, nowIso());
    this.svc.audit(employeeId, 'attachment.upload', 'clear_order', orderId,
      { filename: safeBase, size: buffer.length }, order.branch_id);
    return this.db.prepare('SELECT * FROM attachments WHERE id=?').get(r.lastInsertRowid);
  }

  list(orderId) {
    return this.db
      .prepare(
        `SELECT a.*, e.name AS uploaded_by_name FROM attachments a
         LEFT JOIN employees e ON e.id=a.uploaded_by WHERE a.order_id=? ORDER BY a.id`
      )
      .all(orderId);
  }

  read(storedName) {
    // 防目录穿越:只取文件名
    const base = storedName.split(/[\\/]/).pop();
    const path = join(this.root, base);
    if (!existsSync(path)) return null;
    return { buffer: readFileSync(path), path };
  }
}

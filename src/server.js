// HTTP 服务:零依赖。JSON API + 原始字节附件上传 + 静态资源。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, yuanToFen } from './db.js';
import { Services, BizError } from './services.js';
import { TaskQueue } from './queue.js';
import { AttachmentStore } from './attachments.js';
import { seedIfEmpty } from './seed.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function createContext(dbPath = process.env.DB_PATH || 'data/atm.db') {
  const db = openDb(dbPath);
  migrate(db);
  const svc = new Services(db);
  const queue = new TaskQueue(db, svc);
  const attachments = new AttachmentStore(db, svc);
  return { db, svc, queue, attachments };
}

export function createServerApp(ctx) {
  const { db, svc, queue, attachments } = ctx;

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  // 从请求头取操作员工
  const actor = (req, required = true) => {
    const raw = req.headers['x-employee-id'];
    if (!raw) {
      if (required) throw new BizError('缺少操作人工号(X-Employee-Id)', 401, 'NO_ACTOR');
      return null;
    }
    return svc.getEmployee(Number(raw));
  };

  const readBody = (req) =>
    new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 20 * 1024 * 1024) {
          rejectBody(new BizError('请求体过大', 413));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks)));
      req.on('error', rejectBody);
    });

  const routes = [];
  const route = (method, pattern, handler) => { routes.push({ method, pattern, handler }); compiled = null; };

  // 把 /a/:b 形式编译成正则
  const compile = (p) => {
    const keys = [];
    const re = new RegExp(
      '^' +
        p.replace(/:[^/]+/g, (m) => {
          keys.push(m.slice(1));
          return '([^/]+)';
        }) +
        '/*$'
    );
    return { re, keys };
  };
  let compiled = [];
  const buildCompiled = () => routes.map((r) => ({ ...r, ...compile(r.pattern) }));

  // ---- 参考数据 ----
  route('GET', '/api/branches', async () => svc.listBranches());
  route('GET', '/api/denominations', async () => svc.listDenominations());
  route('GET', '/api/employees', async (req, res, p, q) =>
    svc.listEmployees(q.branch_id ? Number(q.branch_id) : null));
  route('GET', '/api/demo/accounts', async () =>
    db.prepare('SELECT a.*, b.name AS branch_name FROM demo_accounts a LEFT JOIN branches b ON b.id=a.branch_id').all());
  route('GET', '/api/demo/cards', async () =>
    db.prepare('SELECT c.*, da.holder_name, da.account_no FROM demo_cards c JOIN demo_accounts da ON da.id=c.account_id').all());
  route('GET', '/api/demo/txns', async () =>
    db.prepare('SELECT t.*, a.code AS atm_code FROM demo_txn t LEFT JOIN atms a ON a.id=t.atm_id ORDER BY t.id DESC LIMIT 50').all());

  // ---- ATM 台账 ----
  route('GET', '/api/atms', async (req, res, p, q) =>
    svc.listAtms(q.branch_id ? Number(q.branch_id) : null));
  route('POST', '/api/atms/:id/status', async (req, res, p, q, body) => {
    const emp = actor(req);
    const r = svc.setAtmStatus(emp.id, Number(p.id), body.status);
    if (body.status === 'offline') {
      queue.setAtmOffline(Number(p.id), true);
    } else {
      const n = queue.rescheduleForAtm(Number(p.id));
      if (n > 0) queue.drain().catch(() => {}); // 上线即补传
      r.rescheduled = n;
    }
    return r;
  });

  // ---- 钞箱 ----
  route('GET', '/api/cassettes', async (req, res, p, q) =>
    svc.listCassettes(q.branch_id ? Number(q.branch_id) : null));
  route('GET', '/api/cassettes/:id', async (req, res, p) => svc.getCassette(Number(p.id)));
  route('GET', '/api/cassettes/:id/trace', async (req, res, p) =>
    svc.cassetteTrace(Number(p.id)));
  route('POST', '/api/cassettes/:id/seal', async (req, res, p, q, body) =>
    svc.sealCassette(actor(req).id, Number(p.id), body.sealNo));
  route('POST', '/api/cassettes/:id/unseal', async (req, res, p, q, body) =>
    svc.unsealCassette(actor(req).id, Number(p.id), !!body.broken, body.reason || ''));
  route('POST', '/api/cassettes/:id/notes', async (req, res, p, q, body) =>
    svc.setCassetteNotes(actor(req).id, Number(p.id), Number(body.notes)));
  route('POST', '/api/cassettes/:id/claim', async (req, res, p) =>
    svc.claimCassette(actor(req).id, Number(p.id)));
  route('POST', '/api/cassettes/:id/release', async (req, res, p) =>
    svc.releaseCassette(actor(req).id, Number(p.id)));

  // ---- 装钞计划 ----
  route('GET', '/api/plans', async () => svc.listPlans());
  route('POST', '/api/plans', async (req, res, p, q, body) =>
    svc.createPlan(actor(req).id, Number(body.atmId), body.items || [], body.notes || ''));
  route('GET', '/api/plans/:id', async (req, res, p) => svc.getPlan(Number(p.id)));
  route('POST', '/api/plans/:id/lock', async (req, res, p) =>
    svc.lockPlan(actor(req).id, Number(p.id)));
  route('POST', '/api/plans/:id/execute', async (req, res, p) =>
    svc.executePlan(actor(req).id, Number(p.id)));
  route('POST', '/api/plans/:id/items/:itemId', async (req, res, p, q, body) =>
    svc.updatePlanItem(actor(req).id, Number(p.id), Number(p.itemId), Number(body.notesCount)));

  // ---- 清机单 ----
  route('GET', '/api/orders', async () => svc.listOrders());
  route('POST', '/api/orders', async (req, res, p, q, body) =>
    svc.createOrder(actor(req).id, Number(body.atmId), fen(body.expectedFen, body.expectedYuan)));
  route('GET', '/api/orders/:id', async (req, res, p) => svc.getOrder(Number(p.id)));
  route('POST', '/api/orders/:id/entries', async (req, res, p, q, body) =>
    svc.enterClearEntries(actor(req).id, Number(p.id), body.entries || [], {
      sealBrokenCassetteId: body.sealBrokenCassetteId
        ? Number(body.sealBrokenCassetteId) : null,
      atmOffline: !!body.atmOffline
    }));
  route('POST', '/api/orders/:id/review', async (req, res, p, q, body) =>
    svc.addReview(actor(req).id, Number(p.id), body.comment || ''));
  route('POST', '/api/orders/:id/close', async (req, res, p) =>
    svc.closeOrder(actor(req).id, Number(p.id)));
  route('POST', '/api/orders/:id/adjust', async (req, res, p, q, body) =>
    svc.adjustAmount(actor(req).id, {
      target: body.target,
      orderId: Number(p.id),
      entryId: body.entryId ? Number(body.entryId) : null,
      newValueFen: fen(body.newValueFen, body.newValueYuan),
      reason: body.reason,
      approverId: Number(body.approverId)
    }));
  route('GET', '/api/orders/:id/adjustments', async (req, res, p) =>
    svc.listAdjustments(Number(p.id)));
  route('GET', '/api/orders/:id/attachments', async (req, res, p) =>
    attachments.list(Number(p.id)));
  // 附件上传:原始字节(query 带 filename)
  route('POST', '/api/orders/:id/attachments', async (req, res, p, q, body, raw) =>
    attachments.save(actor(req).id, Number(p.id),
      q.filename || `attachment_${Date.now()}.bin`, raw, req.headers['content-type'] || 'application/octet-stream'));

  route('GET', '/api/attachments/:stored', async (req, res, p) => {
    const found = attachments.read(decodeURIComponent(p.stored));
    if (!found) throw new BizError('附件不存在', 404);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(found.buffer);
    return null;
  });

  // ---- 券别汇总 ----
  route('GET', '/api/summary/denoms', async (req, res, p, q) =>
    svc.denomSummary(q.order_id ? Number(q.order_id) : null));

  // ---- 差额 ----
  route('GET', '/api/discrepancies', async (req, res, p, q) =>
    svc.listDiscrepancies(q.branch_id ? Number(q.branch_id) : null, q.status || null));
  route('POST', '/api/discrepancies/:id/resolve', async (req, res, p, q, body) =>
    svc.resolveDiscrepancy(actor(req).id, Number(p.id), body.status, body.resolution || ''));

  route('GET', '/api/adjustments', async () => svc.listAdjustments());

  // ---- 交接 ----
  route('GET', '/api/handovers', async () => svc.listHandovers());
  route('POST', '/api/handovers', async (req, res, p, q, body) =>
    svc.createHandover(actor(req).id, Number(body.cassetteId),
      body.toBranchId ? Number(body.toBranchId) : null));
  route('POST', '/api/handovers/:id/signoff', async (req, res, p) =>
    svc.signoffHandover(actor(req).id, Number(p.id)));

  // ---- 审计 ----
  route('GET', '/api/audit', async (req, res, p, q) =>
    svc.queryAudit({
      branchId: q.branch_id ? Number(q.branch_id) : null,
      action: q.action || null,
      entity: q.entity || null,
      limit: q.limit ? Number(q.limit) : 200
    }));

  // ---- 任务队列 / 补传 ----
  route('GET', '/api/tasks', async () => queue.list());
  route('POST', '/api/tasks/drain', async () => {
    await queue.drain();
    return queue.list();
  });
  // 提交清机回传(进入进程内队列;离线暂存,上线补传)
  route('POST', '/api/reports', async (req, res, p, q, body) => {
    const id = queue.enqueue('report_submit', {
      employeeId: actor(req).id,
      atmId: Number(body.atmId),
      expectedFen: fen(body.expectedFen, body.expectedYuan),
      entries: body.entries || [],
      key: body.key || null,
      offlineCached: !!body.offlineCached,
      sealBrokenCassetteId: body.sealBrokenCassetteId
        ? Number(body.sealBrokenCassetteId) : null
    }, { idempotencyKey: body.key || null, delayMs: Number(body.delayMs || 0) });
    return { taskId: id };
  });

  function fen(explicit, yuan) {
    if (explicit !== undefined && explicit !== null && explicit !== '') return Number(explicit);
    if (yuan !== undefined && yuan !== null && yuan !== '') return yuanToFen(yuan);
    return 0;
  }

  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const full = join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    try {
      const data = await readFile(full);
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      // SPA 回退
      try {
        const data = await readFile(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    }
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    const q = Object.fromEntries(u.searchParams.entries());
    try {
      if (pathname.startsWith('/api/')) {
        let raw = Buffer.alloc(0);
        let body = {};
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          raw = await readBody(req);
          const ct = req.headers['content-type'] || '';
          if (ct.includes('application/json') && raw.length) {
            body = JSON.parse(raw.toString('utf-8'));
          }
        }
        for (const r of (compiled ||= buildCompiled())) {
          if (r.method !== req.method) continue;
          const m = pathname.match(r.re);
          if (!m) continue;
          const params = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
          const result = await r.handler(req, res, params, q, body, raw);
          if (result === null || res.headersSent) return;
          return send(res, 200, { ok: true, data: result });
        }
        return send(res, 404, { ok: false, error: '接口不存在', code: 'NOT_FOUND' });
      }
      if (req.method === 'GET') return await serveStatic(req, res, pathname);
      res.writeHead(405);
      res.end('Method not allowed');
    } catch (e) {
      if (e instanceof BizError) return send(res, e.status, { ok: false, error: e.message, code: e.code });
      console.error(e);
      return send(res, 500, { ok: false, error: e.message || '服务器错误', code: 'INTERNAL' });
    }
  });

  return server;
}

async function main() {
  const ctx = createContext();
  // 单条启动命令:自动迁移 + 写入装钞/清机/差额处置样例(含队列补传)
  await seedIfEmpty(ctx.db, ctx.svc, ctx.queue);
  ctx.queue.start();
  const server = createServerApp(ctx);
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    console.log(`ATM 现金清分平台已启动: http://localhost:${port}`);
    console.log(`数据文件: ${process.env.DB_PATH || 'data/atm.db'}`);
  });
}

// 仅当作为入口直接运行时启动(被测试 import 时不自动监听)
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}

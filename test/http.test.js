// HTTP 端到端:真实监听随机端口,验证 JSON API、操作人头、网点权限 403、
// 原始字节附件上传与静态页面。
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { createContext, createServerApp } from '../src/server.js';

let base, server, ctx, dirs = [];

function setupDb() {
  const dir = join(tmpdir(), `atm-http-${process.pid}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  process.env.ATTACH_DIR = join(dir, 'att');
  ctx = createContext(join(dir, 't.db'));
  const t = new Date().toISOString();
  ctx.db.prepare(`INSERT INTO branches(id,code,name,created_at) VALUES (1,'B1','城东',?),(2,'B2','高新',?)`).run(t, t);
  ctx.db.prepare(`INSERT INTO employees(id,code,name,branch_id,role,is_hq,active,created_at) VALUES
    (1,'E1','张伟',1,'柜员',0,1,?),(4,'E4','赵敏',2,'柜员',0,1,?)`).run(t, t);
  ctx.db.prepare(`INSERT INTO denominations(id,value_fen,label,sort_order) VALUES (1,10000,'壹佰圆',1)`).run();
  ctx.db.prepare(`INSERT INTO atms(id,code,name,branch_id,status,created_at) VALUES (1,'A1','城东机',1,'online',?)`).run(t);
  ctx.db.prepare(`INSERT INTO cassettes(id,code,denomination_id,capacity_notes,seal_status,status,current_branch_id,position_label,created_at)
    VALUES(1,'BOX1',1,2500,'unsealed','idle',1,'城东金库',?)`).run(t);
}

beforeEach(async () => {
  setupDb();
  server = createServerApp(ctx);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  if (server) server.close();
});

after(() => {
  dirs.forEach((d) => { try { rmSync(d, { recursive: true, force: true }); } catch {} });
});

async function req(method, path, { actor, body, raw, headers = {} } = {}) {
  const h = {};
  if (actor) h['X-Employee-Id'] = actor;
  let payload;
  if (raw) { payload = raw; h['Content-Type'] = headers['Content-Type'] || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data };
}

test('GET 基础数据与缺少操作人头返回 401', async () => {
  const r = await req('GET', '/api/branches');
  assert.equal(r.status, 200);
  assert.equal(r.data.data.length, 2);

  const noActor = await req('POST', '/api/orders', { body: { atmId: 1, expectedYuan: '10' } });
  assert.equal(noActor.status, 401);
  assert.equal(noActor.data.code, 'NO_ACTOR');
});

test('跨网点操作返回 403 BRANCH_FORBIDDEN', async () => {
  const r = await req('POST', '/api/orders', { actor: 4, body: { atmId: 1, expectedYuan: '100' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'BRANCH_FORBIDDEN');
});

test('完整建单→录入→双人复核→关闭 走 HTTP', async () => {
  const created = await req('POST', '/api/orders', { actor: 1, body: { atmId: 1, expectedYuan: '1000.00' } });
  assert.equal(created.status, 200);
  const id = created.data.data.id;

  const ent = await req('POST', `/api/orders/${id}/entries`, {
    actor: 1, body: { entries: [{ denominationId: 1, notesCount: 10, soiledNotes: 0 }] }
  });
  assert.equal(ent.status, 200);
  assert.equal(ent.data.data.counted_total_fen, 100000);

  // 仅一人复核关闭被拒
  await req('POST', `/api/orders/${id}/review`, { actor: 1, body: {} });
  const blocked = await req('POST', `/api/orders/${id}/close`, { actor: 1 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'REVIEW_INCOMPLETE');

  // 第二人(需同网点;员工4 是网点2 会被拒)——补一个网点1 复核员
  ctx.db.prepare(`INSERT INTO employees(id,code,name,branch_id,role,is_hq,active,created_at)
    VALUES(2,'E2','李娜',1,'复核员',0,1,?)`).run(new Date().toISOString());
  await req('POST', `/api/orders/${id}/review`, { actor: 2, body: {} });
  const closed = await req('POST', `/api/orders/${id}/close`, { actor: 2 });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.data.status, 'closed');
});

test('封存钞箱后改数量经 API 返回 409', async () => {
  const sealed = await req('POST', '/api/cassettes/1/seal', { actor: 1, body: { sealNo: 'SEAL-WEB-1' } });
  assert.equal(sealed.status, 200);
  const r = await req('POST', '/api/cassettes/1/notes', { actor: 1, body: { notes: 50 } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'SEALED_NO_MODIFY');
});

test('附件以原始字节上传并可下载,字节完全一致', async () => {
  const created = await req('POST', '/api/orders', { actor: 1, body: { atmId: 1, expectedYuan: 0 } });
  const id = created.data.data.id;
  const bytes = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x0d, 0x0a, 0x41, 0x42]);
  const up = await req('POST', `/api/orders/${id}/attachments?filename=${encodeURIComponent('凭 证.bin')}`,
    { actor: 1, raw: bytes });
  assert.equal(up.status, 200);
  assert.equal(up.data.data.size_bytes, bytes.length);
  const back = await req('GET', `/api/attachments/${up.data.data.stored_name}`);
  assert.equal(back.status, 200);
  assert.ok(back.data instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(back.data), bytes);
});

test('静态首页可访问', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('ATM 现金清分'));
});

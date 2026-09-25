// ===== 零依赖单页应用:六个交付视图 =====
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  view: 'atms',
  actorId: 1,
  branchId: '',
  denoms: [],
  employees: [],
  branches: [],
  clearingOrderId: null,
  traceCassetteId: null
};

// ---------- 工具 ----------
async function api(path, opts = {}) {
  const headers = { 'X-Employee-Id': state.actorId, ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof ArrayBuffer) && !(opts.body instanceof Blob) && !opts.raw) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  let json = null;
  try { json = await res.json(); } catch { /* 非 json */ }
  if (!res.ok || (json && json.ok === false)) {
    const err = new Error(json?.error || `请求失败 ${res.status}`);
    err.status = res.status; err.code = json?.code;
    throw err;
  }
  return json ? json.data : null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = (fen) => Number(fen || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedFmt = (fen) => (fen > 0 ? '+' : '') + fmt(fen);
const dt = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';
const dateShort = (iso) => iso ? iso.slice(0, 10) : '—';

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 2600);
}

const ATM_STATUS = { online: ['在线', 'badge-green'], offline: ['离线', 'badge-red'], maintenance: ['维护', 'badge-gold'] };
const SEAL_STATUS = { sealed: ['已封存', 'badge-green'], unsealed: ['未封存', 'badge-gray'], broken: ['封签破损', 'badge-red'] };
const CAS_STATUS = { idle: '金库备用', loaded: '已装钞', transit: '押运在途', vault: '在库' };
const PLAN_STATUS = { draft: ['草稿', 'badge-gray'], locked: ['已锁定', 'badge-gold'], completed: ['已完成', 'badge-green'], cancelled: ['已取消', 'badge-gray'] };
const ORDER_STATUS = { open: ['待录入', 'badge-gray'], reviewing: ['复核中', 'badge-gold'], closed: ['已关闭', 'badge-green'] };
const DISC = {
  short: ['短款', 't-short'], over: ['长款', 't-over'], soiled: ['残钞', 't-soiled'],
  seal_broken: ['封签破损', 't-seal_broken'], atm_offline: ['ATM 离线', 't-atm_offline'],
  duplicate_report: ['重复回传', 't-duplicate_report']
};
const DISC_STATUS = { pending: ['待处置', 'badge-red'], approved: ['已核准', 'badge-green'], adjusted: ['已调整', 'badge-blue'], rejected: ['已驳回', 'badge-gray'] };
const TASK_STATUS = { queued: '排队中', running: '处理中', done: '完成', failed: '失败', duplicate: '重复忽略' };

function daysUntil(iso) {
  return Math.ceil((new Date(iso) - Date.now()) / 86400000);
}
function duePill(dueDate, status) {
  if (status !== 'pending') return `<span class="due-pill done">已处置 · 截止 ${dateShort(dueDate)}</span>`;
  const d = daysUntil(dueDate);
  const cls = d <= 1 ? 'urgent' : '';
  const txt = d < 0 ? `已逾期 ${-d} 天` : d === 0 ? '今日到期' : `剩 ${d} 天`;
  return `<span class="due-pill ${cls}">⏳ ${txt} · 截止 ${dateShort(dueDate)}</span>`;
}

function modal(html) {
  $('#modalRoot').innerHTML =
    `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  return $('.modal');
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

function currentEmployee() { return state.employees.find((e) => e.id === state.actorId); }
function branchName(id) { return state.branches.find((b) => b.id === id)?.name || '—'; }
function empName(id) { return state.employees.find((e) => e.id === id)?.name || `#${id}`; }

// ---------- 启动 ----------
async function init() {
  state.branches = await api('/api/branches');
  state.employees = await api('/api/employees');
  // 顶部选择器
  $('#actorSelect').innerHTML = state.employees.map((e) =>
    `<option value="${e.id}">${esc(e.name)} · ${esc(e.role)}${e.is_hq ? ' · 清算中心' : ''}</option>`).join('');
  $('#actorSelect').value = state.actorId;
  $('#branchFilter').innerHTML =
    `<option value="">全部网点</option>` + state.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');

  $('#actorSelect').addEventListener('change', (e) => { state.actorId = Number(e.target.value); render(); });
  $('#branchFilter').addEventListener('change', (e) => { state.branchId = e.target.value; render(); });
  $$('#tabs .tab').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));
  $('#modalRoot').addEventListener('click', (e) => { if (e.target.classList.contains('modal-mask')) closeModal(); });
  $('#view').addEventListener('click', onAction);
  $('#view').addEventListener('change', onChange);
  $('#view').addEventListener('submit', onSubmit);

  render();
}

async function render() {
  const v = $('#view');
  v.innerHTML = '';
  try {
    state.denoms = await api('/api/denominations');
    const fn = {
      atms: viewAtms, plans: viewPlans, clearing: viewClearing,
      trace: viewTrace, discrepancy: viewDiscrepancy, audit: viewAudit
    }[state.view];
    await fn(v);
  } catch (e) {
    v.innerHTML = `<div class="empty">加载失败:${esc(e.message)}</div>`;
  }
}

// 统一动作分发
async function onAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = Number(btn.dataset.id);
  try {
    switch (act) {
      case 'nav-trace': state.view = 'trace'; state.traceCassetteId = id;
        $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.view === 'trace'));
        return render();
      case 'atm-online': await api(`/api/atms/${id}/status`, { method: 'POST', body: { status: 'online' } }); toast('ATM 已置为在线,触发补传'); break;
      case 'atm-offline': await api(`/api/atms/${id}/status`, { method: 'POST', body: { status: 'offline' } }); toast('ATM 已置为离线'); break;
      case 'plan-lock': await api(`/api/plans/${id}/lock`, { method: 'POST' }); toast('计划已锁定'); break;
      case 'plan-execute': await api(`/api/plans/${id}/execute`, { method: 'POST' }); toast('装钞完成,钞箱已封存入机'); break;
      case 'new-plan': return openPlanModal();
      case 'open-order': state.clearingOrderId = id; return render();
      case 'new-order': return openOrderModal();
      case 'save-entries': return saveEntries(id);
      case 'add-review': await api(`/api/orders/${id}/review`, { method: 'POST', body: { comment: '双人复核签名' } }); toast('复核签名成功'); break;
      case 'close-order': await api(`/api/orders/${id}/close`, { method: 'POST' }); toast('清机单已关闭'); break;
      case 'adjust': return openAdjustModal(id);
      case 'attach': return triggerAttach(id);
      case 'disc-resolve': return openDiscModal(id);
      case 'trace-select': state.traceCassetteId = id; return render();
      case 'seal': return openSealModal(id);
      case 'unseal': await api(`/api/cassettes/${id}/unseal`, { method: 'POST', body: { broken: false } }); toast('已授权开封'); break;
      case 'seal-broken': await api(`/api/cassettes/${id}/unseal`, { method: 'POST', body: { broken: true, reason: '清分发现封签破损' } }); toast('已登记封签破损'); break;
      case 'claim': {
        const r = await api(`/api/cassettes/${id}/claim`, { method: 'POST' });
        toast(`领取成功:${r.cassette.code}`); break;
      }
      case 'release': await api(`/api/cassettes/${id}/release`, { method: 'POST' }); toast('已释放领取'); break;
      case 'handover': return openHandoverModal(id);
      case 'signoff': await api(`/api/handovers/${id}/signoff`, { method: 'POST' }); toast('签收成功'); break;
      case 'drain': {
        // 先把离线 ATM 恢复在线以演示补传,再排空队列
        await api('/api/tasks/drain', { method: 'POST' }); toast('已尝试补传排队任务'); break;
      }
      case 'duplicate-report': return openReportModal();
      case 'modal-close': return closeModal();
    }
    if (!['nav-trace', 'open-order'].includes(act)) render();
  } catch (err) {
    toast(err.message, true);
    if (btn.dataset.refresh === '1') render();
  }
}
async function onChange(e) {
  const el = e.target;
  if (el.id === 'entryDenom') {
    if (el.classList.contains('live-amount')) liveCalc();
  }
  if (el.classList.contains('live-amount')) liveCalc();
}
async function onSubmit(e) {
  const f = e.target;
  if (!f.dataset.form) return;
  e.preventDefault();
  const form = f.dataset.form;
  try {
    if (form === 'plan') await submitPlan(f);
    if (form === 'order') await submitOrder(f);
    if (form === 'adjust') await submitAdjust(f);
    if (form === 'seal') await submitSeal(f);
    if (form === 'handover') await submitHandover(f);
    if (form === 'disc') await submitDisc(f);
    if (form === 'report') await submitReport(f);
    if (form === 'audit-filter') { applyAuditFilter(f); return; }
    closeModal(); render();
  } catch (err) { toast(err.message, true); }
}

// ================= 视图一:ATM 台账 =================
async function viewAtms(v) {
  const q = state.branchId ? `?branch_id=${state.branchId}` : '';
  const [atms, cassettes] = await Promise.all([api('/api/atms' + q), api('/api/cassettes' + q)]);
  const byBranch = {};
  atms.forEach((a) => (byBranch[a.branch_id] ??= []).push(a));

  v.innerHTML = `
    <div class="page-head">
      <div><h2>ATM 台账</h2><div class="hint">按网点分组;每张 ATM 卡片内嵌当前钞箱与封签状态</div></div>
    </div>
    <div id="atmGroups"></div>`;
  const g = $('#atmGroups', v);
  if (!atms.length) { g.innerHTML = `<div class="empty">暂无 ATM</div>`; return; }

  for (const bid of Object.keys(byBranch).sort()) {
    const head = document.createElement('div');
    head.className = 'branch-label';
    head.textContent = branchName(Number(bid));
    g.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'group-grid';
    for (const a of byBranch[bid]) {
      const boxes = cassettes.filter((c) => c.current_atm_id === a.id);
      const [stTxt, stCls] = ATM_STATUS[a.status];
      grid.insertAdjacentHTML('beforeend', `
        <div class="group-card ${a.status === 'offline' ? 'is-offline' : ''}">
          <div class="gc-head">
            <div>
              <div class="gc-title">${esc(a.name)}</div>
              <div class="gc-sub"><span class="mono">${esc(a.code)}</span> · ${esc(a.model)} · ${esc(a.location)}</div>
            </div>
            <span class="badge ${stCls}">${stTxt}</span>
          </div>
          <div class="gc-body">
            ${boxes.length ? boxes.map((c) => cassetteMini(c)).join('') : '<div class="muted small">该机当前无在机钞箱</div>'}
          </div>
          <div class="gc-foot">
            <button class="btn btn-sm" data-act="atm-offline" data-id="${a.id}" ${a.status === 'offline' ? 'disabled' : ''}>置为离线</button>
            <button class="btn btn-sm btn-primary" data-act="atm-online" data-id="${a.id}" ${a.status === 'online' ? 'disabled' : ''}>恢复在线(补传)</button>
          </div>
        </div>`);
    }
    g.appendChild(grid);
  }
}

function cassetteMini(c) {
  const [sealTxt, sealCls] = SEAL_STATUS[c.seal_status];
  return `<div class="mini-cassette">
    <div class="mc-left">
      <span class="seal-dot ${c.seal_status}"></span>
      <div>
        <div class="mc-code">${esc(c.code)}</div>
        <div class="mc-meta">${esc(c.denom_label)} · ${c.loaded_notes.toLocaleString()} 张 · ${esc(CAS_STATUS[c.status] || c.status)}</div>
      </div>
    </div>
    <div class="row" style="gap:6px">
      <span class="badge ${sealCls}">${sealTxt}</span>
      <button class="btn-link" data-act="nav-trace" data-id="${c.id}">轨迹</button>
    </div>
  </div>`;
}

// ================= 视图二:装钞计划 =================
async function viewPlans(v) {
  const plans = await api('/api/plans');
  v.innerHTML = `
    <div class="page-head">
      <div><h2>装钞计划</h2><div class="hint">计划锁定后冻结明细;装钞前必须锁定,执行时封存钞箱并入机</div></div>
      <div class="toolbar"><button class="btn btn-gold" data-act="new-plan">+ 新建装钞计划</button></div>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>计划号</th><th>ATM</th><th>网点</th><th>状态</th>
        <th class="num">钞箱数</th><th class="num">计划金额</th><th>锁定人</th><th>备注</th><th></th>
      </tr></thead>
      <tbody>${plans.map(planRow).join('')}</tbody>
    </table></div>`;
}
function planRow(p) {
  const [stTxt, stCls] = PLAN_STATUS[p.status];
  const amount = p.items.reduce((s, it) => s + it.notes_count * it.value_fen, 0);
  const boxes = p.items.map((it) =>
    `<div class="mini-cassette" style="margin:0 0 6px">
      <div class="mc-left"><span class="seal-dot ${it.seal_status}"></span>
        <div><div class="mc-code">${esc(it.cassette_code)}</div>
        <div class="mc-meta">${esc(it.denom_label)} · ${it.notes_count.toLocaleString()} 张 · ${fmt(it.notes_count * it.value_fen)} 元</div></div>
      </div><span class="mono small muted">${it.seal_no ? esc(it.seal_no) : '无封签'}</span>
    </div>`).join('');
  return `<tr>
    <td><span class="mono">${esc(p.code)}</span>
      <div class="mt8">${boxes}</div></td>
    <td>${esc(p.atm_code)}<div class="mc-meta">${esc(p.atm_name)}</div></td>
    <td>${esc(p.branch_name)}</td>
    <td><span class="badge ${stCls}">${stTxt}</span></td>
    <td class="num">${p.items.length}</td>
    <td class="num pos">${fmt(amount)}</td>
    <td>${esc(p.locked_by_name || '—')}</td>
    <td class="small muted">${esc(p.notes || '—')}</td>
    <td style="white-space:nowrap">
      ${p.status === 'draft' ? `<button class="btn btn-sm btn-gold" data-act="plan-lock" data-id="${p.id}">锁定</button>` : ''}
      ${p.status === 'locked' ? `<button class="btn btn-sm btn-primary" data-act="plan-execute" data-id="${p.id}">执行装钞</button>` : ''}
      ${p.status === 'completed' ? '<span class="muted small">已入机</span>' : ''}
    </td>
  </tr>`;
}

async function openPlanModal() {
  const atms = await api('/api/atms');
  const boxes = await api('/api/cassettes');
  const avail = boxes.filter((c) => c.status === 'idle' || c.status === 'vault');
  const m = modal(`
    <div class="modal-head"><h3>新建装钞计划</h3><button class="close-x" data-act="modal-close">×</button></div>
    <form data-form="plan">
      <div class="modal-body">
        <div class="form-grid">
          <label class="fld full">目标 ATM
            <select name="atmId" required>${atms.map((a) => `<option value="${a.id}">${esc(a.code)} · ${esc(a.name)}(${esc(branchName(a.branch_id))})</option>`).join('')}</select>
          </label>
        </div>
        <div class="section-title">选择钞箱并填写张数</div>
        <div id="planBoxes">${avail.length ? avail.map((c) => `
          <label class="entry-row" style="grid-template-columns:1.4fr 1fr 1fr">
            <span class="mc-code">${esc(c.code)} <span class="muted">${esc(c.denom_label)} · 容量 ${c.capacity_notes}</span></span>
            <input type="number" min="0" max="${c.capacity_notes}" data-box="${c.id}" data-value="${c.value_fen}" placeholder="张数" />
            <span class="ro-amount plan-amt" data-amt="${c.id}">0.00</span>
          </label>`).join('') : '<div class="empty">没有可用的在库钞箱</div>'}
        </div>
        <label class="fld full mt12">备注<textarea name="notes" rows="2"></textarea></label>
      </div>
      <div class="modal-foot"><button class="btn" type="button" data-act="modal-close">取消</button>
        <button class="btn btn-gold" type="submit">创建(草稿)</button></div>
    </form>`);
  m.querySelectorAll('input[data-box]').forEach((inp) =>
    inp.addEventListener('input', () => {
      const id = inp.dataset.box;
      const val = Number(inp.value || 0) * Number(inp.dataset.value);
      m.querySelector(`[data-amt="${id}"]`).textContent = fmt(val);
    }));
}
async function submitPlan(f) {
  const atmId = Number(f.atmId.value);
  const items = $$('input[data-box]', f).filter((i) => Number(i.value) > 0)
    .map((i) => ({ cassetteId: Number(i.dataset.box), notesCount: Number(i.value) }));
  if (!items.length) throw new Error('请至少为一个钞箱填写张数');
  await api('/api/plans', { method: 'POST', body: { atmId, items, notes: f.notes.value } });
  toast('草稿计划已创建,请锁定后执行');
}

// ================= 视图三:清机录入 =================
async function viewClearing(v) {
  const orders = await api('/api/orders');
  v.innerHTML = `
    <div class="page-head">
      <div><h2>清机录入与复核</h2><div class="hint">按实点金额逐券别录入;短款/长款/残钞自动生成差额,双人复核后方可关闭</div></div>
      <div class="toolbar"><button class="btn btn-gold" data-act="new-order">+ 新建清机单</button></div>
    </div>
    <div class="clear-grid">
      <div id="orderList" class="table-wrap"></div>
      <div id="orderDetail"></div>
    </div>`;
  $('#orderList', v).innerHTML = `<table class="data"><thead><tr>
      <th>清机单号</th><th>ATM</th><th>状态</th><th class="num">实点</th><th class="num">差额</th><th class="num">复核</th>
    </tr></thead><tbody>${orders.map(orderListRow).join('')}</tbody></table>`;
  const target = state.clearingOrderId || orders[0]?.id;
  if (target) { state.clearingOrderId = target; renderOrderDetail(target); }
  else $('#orderDetail', v).innerHTML = '<div class="panel empty">暂无清机单</div>';
}
function orderListRow(o) {
  const [stTxt, stCls] = ORDER_STATUS[o.status];
  const diff = o.counted_total_fen - o.expected_total_fen;
  const reviewers = new Set(o.confirms.map((c) => c.employee_id)).size;
  const active = state.clearingOrderId === o.id;
  return `<tr style="${active ? 'background:var(--green-050)' : ''};cursor:pointer" data-act="open-order" data-id="${o.id}">
    <td><span class="mono">${esc(o.code)}</span></td>
    <td>${esc(o.atm_code)}</td>
    <td><span class="badge ${stCls}">${stTxt}</span></td>
    <td class="num">${fmt(o.counted_total_fen)}</td>
    <td class="num ${diff < 0 ? 'neg' : diff > 0 ? 'pos' : ''}">${signedFmt(diff)}</td>
    <td class="num">${reviewers}/2</td>
  </tr>`;
}

async function renderOrderDetail(id) {
  const o = await api(`/api/orders/${id}`);
  const adjustments = await api(`/api/orders/${id}/adjustments`);
  const attachments = await api(`/api/orders/${id}/attachments`);
  const [stTxt, stCls] = ORDER_STATUS[o.status];
  const diff = o.counted_total_fen - o.expected_total_fen;
  const reviewers = [...new Map(o.confirms.map((c) => [c.employee_id, c])).values()];
  const canReview = !reviewers.some((c) => c.employee_id === state.actorId) && o.status !== 'closed';
  const entryMap = Object.fromEntries(o.entries.map((e) => [e.denomination_id, e]));
  const el = $('#orderDetail');
  if (!el) return;
  el.innerHTML = `
    <div class="panel">
      <h3>${esc(o.code)} · ${esc(o.atm_name)} <span class="badge ${stCls}">${stTxt}</span></h3>
      <dl class="kv">
        <dt>所属网点</dt><dd>${esc(o.branch_name)}</dd>
        <dt>ATM 状态</dt><dd>${ATM_STATUS[o.atm_status][0]}</dd>
        <dt>建单人</dt><dd>${esc(o.created_by_name)} · ${dt(o.started_at)}</dd>
      </dl>
      <div class="expected-line mt12"><span class="lbl">账面应缴</span><strong>${fmt(o.expected_total_fen)} 元</strong></div>
      <div class="expected-line"><span class="lbl">实点合计</span><div class="big-total" id="countedTotal">${fmt(o.counted_total_fen)}</div></div>
      <div class="expected-line"><span class="lbl">差额</span>
        <strong class="num ${diff < 0 ? 'neg' : diff > 0 ? 'pos' : ''}" style="font-size:18px">${signedFmt(diff)} 元</strong></div>
    </div>

    <div class="panel">
      <h3>逐券别实点录入</h3>
      <div class="entry-row" style="border:none;padding-bottom:4px;color:var(--silver-700);font-size:12px">
        <span>券别</span><span>实点张数</span><span>残钞张数</span><span class="num">金额(元)</span>
      </div>
      ${state.denoms.map((d) => {
        const cur = entryMap[d.id] || { notes_count: 0, soiled_notes: 0 };
        return `<div class="entry-row">
          <span><strong>${esc(d.label)}</strong><div class="mc-meta">${fmt(d.value_fen)} 元/张</div></span>
          <input type="number" min="0" class="live-amount" data-denom="${d.id}" data-value="${d.value_fen}" data-kind="notes" value="${cur.notes_count}" ${o.status === 'closed' ? 'disabled' : ''}/>
          <input type="number" min="0" class="live-amount" data-denom="${d.id}" data-value="${d.value_fen}" data-kind="soiled" value="${cur.soiled_notes}" ${o.status === 'closed' ? 'disabled' : ''}/>
          <span class="ro-amount" id="amt-${d.id}">${fmt((cur.notes_count || 0) * d.value_fen)}</span>
        </div>`;
      }).join('')}
      <div class="expected-line mt12"><span></span>
        <button class="btn btn-primary" data-act="save-entries" data-id="${o.id}" ${o.status === 'closed' ? 'disabled' : ''}>保存实点并核对差额</button></div>
      <label class="row mt8 small muted"><input type="checkbox" id="atmOfflineChk" ${o.discrepancies.some((x) => x.type === 'atm_offline') ? 'checked' : ''}/> 清机时 ATM 离线(数据离线暂存,生成离线差额)</label>
    </div>

    <div class="panel">
      <h3>双人复核</h3>
      <div class="sign-row">
        ${reviewers.length ? reviewers.map((c) => `<span class="sign-chip"><span class="avatar">${esc(c.employee_name[0])}</span>${esc(c.employee_name)}<span class="muted">${dateShort(c.created_at)}</span></span>`).join('') : '<span class="sign-empty">尚无复核签名</span>'}
      </div>
      <div class="muted small mt8">需两名<strong>不同员工</strong>签名;当前操作人 ${esc(currentEmployee()?.name)}</div>
      <div class="row mt12">
        <button class="btn" data-act="add-review" data-id="${o.id}" ${!canReview ? 'disabled' : ''}>我来复核签名</button>
        <button class="btn btn-gold" data-act="close-order" data-id="${o.id}" ${o.status === 'closed' ? 'disabled' : ''}>关闭清机单</button>
      </div>
    </div>

    <div class="panel">
      <h3>金额修正留痕 ${adjustments.length ? '' : '<span class="muted small" style="font-weight:400">(暂无修正)</span>'}</h3>
      ${adjustments.length ? `<table class="data" style="box-shadow:none"><thead><tr><th>目标</th><th class="num">原值</th><th class="num">新值</th><th>原因</th><th>经办</th><th>审批</th></tr></thead>
        <tbody>${adjustments.map((a) => `<tr>
          <td class="small">${a.target === 'order_expected' ? '账面应缴' : '券别实点' + (a.denom_label ? '·' + esc(a.denom_label) : '')}</td>
          <td class="num neg">${fmt(a.old_value_fen)}</td>
          <td class="num pos">${fmt(a.new_value_fen)}</td>
          <td class="small">${esc(a.reason)}</td>
          <td class="small">${esc(a.created_by_name)}</td><td class="small">${esc(a.approver_name)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="muted small">修正金额时强制保留原值、原因与审批人,且经办/审批不得为同一人。</div>'}
      <div class="mt12"><button class="btn btn-sm" data-act="adjust" data-id="${o.id}" ${o.status === 'closed' ? 'disabled' : ''}>金额修正</button></div>
    </div>

    <div class="panel">
      <h3>清机附件(本地保存)</h3>
      <div class="sign-row">${attachments.length ? attachments.map((a) =>
        `<a class="sign-chip" href="/api/attachments/${encodeURIComponent(a.stored_name)}" target="_blank">📎 ${esc(a.filename)} <span class="muted">${a.size_bytes}B</span></a>`).join('') : '<span class="sign-empty">暂无附件</span>'}</div>
      <div class="mt12"><button class="btn btn-sm" data-act="attach" data-id="${o.id}">上传清分凭证/照片</button></div>
    </div>`;
}

function liveCalc() {
  let total = 0;
  state.denoms.forEach((d) => {
    const notes = Number($(`input[data-denom="${d.id}"][data-kind="notes"]`)?.value || 0);
    const el = $(`#amt-${d.id}`);
    if (el) el.textContent = fmt(notes * d.value_fen);
    total += notes * d.value_fen;
  });
  const t = $('#countedTotal');
  if (t) t.textContent = fmt(total);
}

async function saveEntries(orderId) {
  const entries = state.denoms.map((d) => ({
    denominationId: d.id,
    notesCount: Number($(`input[data-denom="${d.id}"][data-kind="notes"]`)?.value || 0),
    soiledNotes: Number($(`input[data-denom="${d.id}"][data-kind="soiled"]`)?.value || 0)
  }));
  await api(`/api/orders/${orderId}/entries`, {
    method: 'POST',
    body: { entries, atmOffline: $('#atmOfflineChk')?.checked || false }
  });
  toast('已保存,差额已自动核对');
  render();
}

async function openOrderModal() {
  const atms = await api('/api/atms');
  modal(`
    <div class="modal-head"><h3>新建清机单</h3><button class="close-x" data-act="modal-close">×</button></div>
    <form data-form="order"><div class="modal-body"><div class="form-grid">
      <label class="fld full">ATM
        <select name="atmId">${atms.map((a) => `<option value="${a.id}">${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</select></label>
      <label class="fld full">账面应缴金额(元)<input name="expectedYuan" type="number" step="0.01" value="0" required/></label>
    </div></div>
    <div class="modal-foot"><button class="btn" type="button" data-act="modal-close">取消</button>
      <button class="btn btn-gold" type="submit">创建并录入</button></div></form>`);
}
async function submitOrder(f) {
  const r = await api('/api/orders', { method: 'POST', body: { atmId: Number(f.atmId.value), expectedYuan: f.expectedYuan.value } });
  state.clearingOrderId = r.id;
  toast('清机单已创建');
}

async function openAdjustModal(orderId) {
  const o = await api(`/api/orders/${orderId}`);
  const others = state.employees.filter((e) => e.id !== state.actorId);
  modal(`
    <div class="modal-head"><h3>金额修正(原值留痕)</h3><button class="close-x" data-act="modal-close">×</button></div>
    <form data-form="adjust"><div class="modal-body">
      <input type="hidden" name="orderId" value="${orderId}"/>
      <div class="form-grid">
        <label class="fld full">修正对象
          <select name="target" id="adjTarget">
            <option value="order_expected">账面应缴总额</option>
            ${o.entries.map((e) => `<option value="clear_entry" data-entry="${e.id}">${esc(e.denom_label)} 实点(当前 ${fmt(e.amount_fen)} 元)</option>`).join('')}
          </select></label>
        <label class="fld full">修正后金额(元)<input name="newValueYuan" type="number" step="0.01" required/></label>
        <label class="fld full">审批人(须与经办人不同)
          <select name="approverId" required>${others.map((e) => `<option value="${e.id}">${esc(e.name)} · ${esc(e.role)}</option>`).join('')}</select></label>
        <label class="fld full">修正原因(必填)<textarea name="reason" rows="3" required placeholder="如:调阅监控核实漏点 / 客户长款退回"></textarea></label>
      </div></div>
      <div class="modal-foot"><button class="btn" type="button" data-act="modal-close">取消</button>
        <button class="btn btn-gold" type="submit">提交修正</button></div></form>`);
}
async function submitAdjust(f) {
  const sel = f.target;
  const opt = sel.options[sel.selectedIndex];
  const body = {
    target: sel.value,
    newValueYuan: f.newValueYuan.value,
    reason: f.reason.value,
    approverId: Number(f.approverId.value)
  };
  if (sel.value === 'clear_entry') body.entryId = Number(opt.dataset.entry);
  await api(`/api/orders/${f.orderId.value}/adjust`, { method: 'POST', body });
  toast('修正已记录,差额已重算');
}

let pendingFileOrder = null;
function triggerAttach(orderId) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    try {
      await api(`/api/orders/${orderId}/attachments?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST', body: buf, raw: true,
        headers: { 'Content-Type': file.type || 'application/octet-stream' }
      });
      toast('附件已保存到本地目录'); render();
    } catch (e) { toast(e.message, true); }
  };
  inp.click();
}

// ================= 视图四:钞箱轨迹 =================
async function viewTrace(v) {
  const boxes = await api('/api/cassettes' + (state.branchId ? `?branch_id=${state.branchId}` : ''));
  const handovers = await api('/api/handovers');
  v.innerHTML = `
    <div class="page-head"><div><h2>钞箱轨迹与封签</h2>
      <div class="hint">封签状态以连续时间线呈现;钞箱离开网点须两名不同员工签收;两人同时领取仅一人成功</div></div></div>
    <div class="trace-wrap">
      <div class="table-wrap" style="overflow:auto;max-height:72vh">
        <table class="data"><thead><tr><th>钞箱</th><th>券别</th><th>封签</th><th>位置</th></tr></thead>
        <tbody>${boxes.map((c) => `<tr style="cursor:pointer;${state.traceCassetteId === c.id ? 'background:var(--green-050)' : ''}" data-act="trace-select" data-id="${c.id}">
          <td><span class="mc-code">${esc(c.code)}</span>${c.claimed_by_name ? `<div class="mc-meta">领取:${esc(c.claimed_by_name)}</div>` : ''}</td>
          <td class="small">${esc(c.denom_label)}</td>
          <td><span class="badge ${SEAL_STATUS[c.seal_status][1]}">${SEAL_STATUS[c.seal_status][0]}</span></td>
          <td class="small">${esc(c.position_label)}</td></tr>`).join('')}</tbody></table>
      </div>
      <div id="traceDetail"></div>
    </div>`;
  if (state.traceCassetteId) renderTraceDetail(state.traceCassetteId, handovers);
  else $('#traceDetail', v).innerHTML = '<div class="panel empty">请选择左侧钞箱查看连续轨迹</div>';
}

const TRACE_LABEL = {
  claim: '领取', release: '释放', seal: '封存', unseal: '授权开封', seal_broken: '封签破损',
  load: '装钞入机', unload: '清机卸箱', handout: '发起离行', signoff: '交接签收',
  locate: '位置变更', set_notes: '数量登记'
};
async function renderTraceDetail(id, handoversAll) {
  const [c, trace, handovers] = await Promise.all([
    api(`/api/cassettes/${id}`), api(`/api/cassettes/${id}/trace`),
    handoversAll ? Promise.resolve(handoversAll.filter((h) => h.cassette_id === id)) : api('/api/handovers').then((h) => h.filter((x) => x.cassette_id === id))
  ]);
  const pendingHo = handovers.filter((h) => h.status === 'pending');
  const el = $('#traceDetail');
  el.innerHTML = `
    <div class="panel">
      <h3>${esc(c.code)} · ${esc(c.denom_label)}</h3>
      <dl class="kv">
        <dt>容量/在钞</dt><dd>${c.capacity_notes.toLocaleString()} / ${c.loaded_notes.toLocaleString()} 张</dd>
        <dt>封签号</dt><dd class="mono">${esc(c.seal_no || '无')} <span class="badge ${SEAL_STATUS[c.seal_status][1]}">${SEAL_STATUS[c.seal_status][0]}</span></dd>
        <dt>当前位置</dt><dd>${esc(c.position_label)}</dd>
        <dt>领取人</dt><dd>${esc(c.claimed_by_name || '无')}</dd>
      </dl>
      <div class="row mt12">
        ${c.seal_status !== 'sealed' ? `<button class="btn btn-sm btn-gold" data-act="seal" data-id="${c.id}">封存</button>` : ''}
        ${c.seal_status === 'sealed' ? `<button class="btn btn-sm" data-act="unseal" data-id="${c.id}">授权开封</button>
          <button class="btn btn-sm btn-danger" data-act="seal-broken" data-id="${c.id}">登记封签破损</button>` : ''}
        ${!c.claimed_by_name ? `<button class="btn btn-sm btn-primary" data-act="claim" data-id="${c.id}">领取(互斥)</button>`
          : (c.claimed_by_name === currentEmployee()?.name ? `<button class="btn btn-sm" data-act="release" data-id="${c.id}">释放领取</button>` : '<span class="muted small">他人持有中</span>')}
        ${c.seal_status === 'sealed' ? `<button class="btn btn-sm" data-act="handover" data-id="${c.id}">发起离行交接</button>` : ''}
      </div>
      ${c.seal_status === 'sealed' ? '<div class="muted small mt8">已封存钞箱不能直接改数量,须先授权开封。</div>' : ''}
    </div>
    ${pendingHo.length ? `<div class="panel"><h3>待签收交接</h3>${pendingHo.map((h) => `
      <div class="sign-row spread">
        <div><strong class="mono">${esc(h.code)}</strong>
          <div class="mc-meta">${esc(h.from_branch_name)} → ${esc(h.to_branch_name || '中心金库')} · 已签收 ${h.signoffs.length}/2
            ${h.signoffs.map((s) => `<span class="sign-chip" style="margin-left:6px">${esc(s.employee_name)}</span>`).join('')}</div></div>
        <button class="btn btn-sm btn-gold" data-act="signoff" data-id="${h.id}">签收(第 ${h.signoffs.length + 1} 人)</button>
      </div>`).join('')}</div>` : ''}
    <div class="panel"><h3>封签连续轨迹</h3>
      <div class="timeline">${trace.length ? trace.slice().reverse().map(traceItem).join('') : '<div class="muted small">暂无轨迹</div>'}</div>
    </div>`;
}
function traceItem(t) {
  let detail = '';
  try { detail = t.detail ? JSON.parse(t.detail) : {}; } catch { detail = {}; }
  const sealCls = t.seal_status === 'broken' ? 'broken' : t.seal_status === 'sealed' ? 'sealed' : 'unsealed';
  return `<div class="tl-item">
    <span class="tl-node ${sealCls}"></span>
    <div class="tl-title">${TRACE_LABEL[t.event] || t.event}
      ${t.seal_no ? `<span class="tl-seal">封签 ${esc(t.seal_no)}</span>` : ''}</div>
    <div class="tl-meta">${esc(t.actor_name || '系统')} · ${dt(t.created_at)}</div>
    ${(t.from_label || t.to_label) ? `<div class="tl-path">${esc(t.from_label || '—')}<span class="arrow">➜</span>${esc(t.to_label || '—')}</div>` : ''}
    ${detail.reason ? `<div class="tl-meta">原因:${esc(detail.reason)}</div>` : ''}
    ${detail.notes != null ? `<div class="tl-meta">张数:${detail.notes}</div>` : ''}
  </div>`;
}

function openSealModal(id) {
  modal(`<div class="modal-head"><h3>封存钞箱</h3><button class="close-x" data-act="modal-close">×</button></div>
    <form data-form="seal"><div class="modal-body">
      <input type="hidden" name="id" value="${id}"/>
      <label class="fld full">封签号<input name="sealNo" required placeholder="如 SEAL-2026-0001"/></label>
    </div><div class="modal-foot"><button class="btn" type="button" data-act="modal-close">取消</button>
      <button class="btn btn-gold" type="submit">确认封存</button></div></form>`);
}
async function submitSeal(f) {
  await api(`/api/cassettes/${f.id.value}/seal`, { method: 'POST', body: { sealNo: f.sealNo.value } });
  toast('钞箱已封存');
}
async function openHandoverModal(id) {
  modal(`<div class="modal-head"><h3>发起钞箱离行交接</h3><button class="close-x" data-act="modal-close">×</button></div>
    <form data-form="handover"><div class="modal-body">
      <input type="hidden" name="cassetteId" value="${id}"/>
      <label class="fld full">目的网点
        <select name="toBranchId"><option value="">中心金库</option>
          ${state.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>
      <div class="muted small mt8">发起后需两名不同员工依次签收,钞箱才会离开当前网点。</div>
    </div><div class="modal-foot"><button class="btn" type="button" data-act="modal-close">取消</button>
      <button class="btn btn-gold" type="submit">发起交接</button></div></form>`);
}
async function submitHandover(f) {
  await api('/api/handovers', { method: 'POST', body: {
    cassetteId: Number(f.cassetteId.value), toBranchId: f.toBranchId.value ? Number(f.toBranchId.value) : null } });
  toast('交接已发起,等待双人签收');
}

// ================= 视图五:差额复核 =================
async function viewDiscrepancy(v) {
  const q = state.branchId ? `?branch_id=${state.branchId}` : '';
  const discs = await api('/api/discrepancies' + q);
  v.innerHTML = `
    <div class="page-head"><div><h2>差额复核与处置</h2>
      <div class="hint">短款 / 长款 / 残钞 / 封签破损 / ATM 离线 / 重复回传;同时突出金额与处理期限</div></div></div>
    <div class="disc-grid">${discs.length ? discs.map(discCard).join('') : '<div class="empty">暂无差额记录</div>'}</div>`;
}
function discCard(d) {
  const [txt, cls] = DISC[d.type] || [d.type, ''];
  const [stTxt, stCls] = DISC_STATUS[d.status];
  const amtCls = d.amount_fen < 0 ? 'neg' : d.amount_fen > 0 ? 'pos' : 'zero';
  const amtTxt = d.amount_fen === 0 ? '非金额差额' : `${signedFmt(d.amount_fen)} 元`;
  return `<div class="disc-card ${cls}">
    <div class="disc-top">
      <div><div class="disc-title">${txt}</div>
        <div class="disc-order">${esc(d.order_code || '—')} · ${esc(branchName(d.branch_id))}</div></div>
      <div style="text-align:right"><span class="badge ${stCls}">${stTxt}</span>
        <div class="disc-amount ${amtCls}">${amtTxt}</div></div>
    </div>
    <div class="disc-detail">${esc(d.detail || '')}</div>
    <div class="disc-foot">${duePill(d.due_date, d.status)}
      ${d.status === 'pending' ? `<button class="btn btn-sm btn-gold" data-act="disc-resolve" data-id="${d.id}">复核处置</button>`
        : `<span class="muted small">${esc(d.resolved_by_name)} · ${dateShort(d.resolved_at)}</span>`}
    </div>
    ${d.resolution ? `<div class="muted small mt8">意见:${esc(d.resolution)}</div>` : ''}
  </div>`;
}
function openDiscModal(id) {
  modal(`<div class="modal-head"><h3>差额处置</h3><button class="close-x" data-act="modal-close">×</button></div>
    <form data-form="disc"><div class="modal-body">
      <input type="hidden" name="id" value="${id}"/>
      <label class="fld full">处置结论
        <select name="status">
          <option value="approved">核准(情况属实,按流程核销/挂账)</option>
          <option value="adjusted">调整(据修正金额重算)</option>
          <option value="rejected">驳回(退回继续核查)</option>
        </select></label>
      <label class="fld full mt12">处置说明<textarea name="resolution" rows="3" required placeholder="处置依据 / 凭证 / 责任人"></textarea></label>
    </div><div class="modal-foot"><button class="btn" type="button" data-act="modal-close">取消</button>
      <button class="btn btn-gold" type="submit">提交处置</button></div></form>`);
}
async function submitDisc(f) {
  await api(`/api/discrepancies/${f.id.value}/resolve`, { method: 'POST',
    body: { status: f.status.value, resolution: f.resolution.value } });
  toast('差额处置已提交');
}

// 重复回传演示入口(在审计视图放按钮)
function openReportModal() {
  modal(`<div class="modal-head"><h3>模拟清机回传(进入补传队列)</h3><button class="close-x" data-act="modal-close">×</button></div>
    <form data-form="report"><div class="modal-body"><div class="form-grid">
      <label class="fld full">ATM <select name="atmId">
        <option value="1">ATM-001 城东营业部大堂机</option><option value="3">ATM-003 高新(离线)</option></select></label>
      <label class="fld">账面应缴(元)<input name="expectedYuan" type="number" value="200000"/></label>
      <label class="fld">100 元张数<input name="notes" type="number" value="2000"/></label>
      <label class="fld full">幂等键(相同键二次提交=重复回传)<input name="key" value="MANUAL-001"/></label>
      <label class="fld full small"><input type="checkbox" name="offlineCached" checked/> 数据曾离线暂存(补传时登记 ATM 离线差额)</label>
    </div></div>
    <div class="modal-foot"><button class="btn" type="button" data-act="modal-close">取消</button>
      <button class="btn btn-gold" type="submit">提交到队列</button></div></form>`);
}
async function submitReport(f) {
  await api('/api/reports', { method: 'POST', body: {
    atmId: Number(f.atmId.value), expectedYuan: f.expectedYuan.value,
    entries: [{ denominationId: 1, notesCount: Number(f.notes.value), soiledNotes: 0 }],
    key: f.key.value, offlineCached: f.offlineCached.checked } });
  toast('已进入进程内补传队列');
}

// ================= 视图六:审计查询 =================
async function viewAudit(v) {
  const [audit, tasks, accounts, cards, txns] = await Promise.all([
    api('/api/audit?limit=120'), api('/api/tasks'), api('/api/demo/accounts'),
    api('/api/demo/cards'), api('/api/demo/txns')
  ]);
  v.innerHTML = `
    <div class="page-head"><div><h2>审计查询 · 补传队列 · 演示账户</h2>
      <div class="hint">全部关键操作留痕;进程内队列处理离线补传与幂等判重(账户/卡号均为演示数据)</div></div>
      <div class="toolbar">
        <button class="btn" data-act="duplicate-report">模拟清机回传</button>
        <button class="btn btn-primary" data-act="drain">立即补传排队任务</button>
      </div></div>

    <form data-form="audit-filter" class="panel row">
      <label class="fld">网点<select name="branchId"><option value="">全部</option>
        ${state.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>
      <label class="fld">动作关键字<input name="action" placeholder="如 order.close / seal"/></label>
      <label class="fld">实体<select name="entity"><option value="">全部</option>
        ${['clear_order', 'cassette', 'load_plan', 'discrepancy', 'handover', 'atm'].map((x) => `<option>${x}</option>`).join('')}</select></label>
      <button class="btn btn-gold" type="submit">查询</button>
    </form>

    <div class="section-title">进程内补传队列</div>
    <div class="table-wrap"><table class="data"><thead><tr>
      <th>#</th><th>类型</th><th>状态</th><th class="num">尝试</th><th>幂等键</th><th>错误/结果</th><th>可执行时间</th></tr></thead>
      <tbody>${tasks.map((t) => `<tr>
        <td>${t.id}</td><td>${esc(t.type)}</td>
        <td><span class="queue-dot q-${t.status}"></span>${TASK_STATUS[t.status] || t.status}</td>
        <td class="num">${t.attempts}/${t.max_attempts}</td>
        <td class="mono small">${esc(t.idempotency_key || '—')}</td>
        <td class="small muted">${esc(t.last_error || t.result || '')}</td>
        <td class="small">${dt(t.available_at)}</td></tr>`).join('')}</tbody></table></div>

    <div class="section-title">操作审计日志</div>
    <div class="table-wrap" style="max-height:420px;overflow:auto"><table class="data"><thead><tr>
      <th>时间</th><th>操作人</th><th>网点</th><th>动作</th><th>实体</th><th>明细</th></tr></thead>
      <tbody id="auditBody">${audit.map(auditRow).join('')}</tbody></table></div>

    <div class="section-title">演示账户 / 卡号 / 近期交易</div>
    <div class="clear-grid">
      <div class="table-wrap"><table class="data"><thead><tr><th>账户</th><th>户名</th><th>绑定卡号</th><th class="num">余额</th></tr></thead>
        <tbody>${accounts.map((a) => {
          const card = cards.find((c) => c.account_id === a.id);
          return `<tr><td class="mono small">${esc(a.account_no)}</td><td>${esc(a.holder_name)}</td>
            <td class="mono small">${esc(card ? card.card_no : '—')}</td><td class="num">${fmt(a.balance_fen)}</td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>时间</th><th>卡号</th><th>类型</th><th class="num">金额</th></tr></thead>
        <tbody>${txns.map((t) => `<tr><td class="small">${dt(t.created_at)}</td><td class="mono small">${esc(t.card_no)}</td>
          <td><span class="badge badge-gray">${esc(t.txn_type)}</span></td><td class="num">${fmt(t.amount_fen)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
}
function auditRow(a) {
  let detail = a.detail;
  try { detail = JSON.stringify(JSON.parse(a.detail), null, 0); } catch {}
  return `<tr><td class="small">${dt(a.created_at)}</td><td>${esc(a.actor_name || '系统')}</td>
    <td class="small">${esc(a.branch_name || '清算中心')}</td>
    <td><span class="mono small">${esc(a.action)}</span></td>
    <td class="small">${esc(a.entity || '')}${a.entity_id ? '#' + esc(a.entity_id) : ''}</td>
    <td class="small muted" style="max-width:340px;overflow:hidden;text-overflow:ellipsis">${esc(detail || '')}</td></tr>`;
}
async function applyAuditFilter(f) {
  const params = new URLSearchParams();
  if (f.branchId.value) params.set('branch_id', f.branchId.value);
  if (f.action.value) params.set('action', f.action.value);
  if (f.entity.value) params.set('entity', f.entity.value);
  params.set('limit', '200');
  const rows = await api('/api/audit?' + params.toString());
  $('#auditBody').innerHTML = rows.map(auditRow).join('');
  toast(`查询到 ${rows.length} 条审计记录`);
}

init();

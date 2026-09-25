"""Web 服务：台账 / 装钞计划 / 清机录入 / 钞箱轨迹 / 差额复核 / 审计查询。

零第三方依赖，基于 http.server。演示身份通过 cookie 中的 uid 切换。
"""
from __future__ import annotations

import html
import json
import os
import sqlite3
import urllib.parse
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import db, seed, services as svc

STATIC_DIR = Path(__file__).resolve().parent / "static"

PLAN_STATUS = {"draft": "草稿", "locked": "已锁定", "loaded": "已装钞", "cancelled": "已取消"}
CL_STATUS = {"open": "待录入", "submitted": "已提交待复核", "reviewed": "双人复核完成",
             "closed": "已关闭"}
CASS_STATUS = {"idle": "在库", "loaded": "已装机", "claimed": "已领取",
               "in_transit": "交接中", "stored": "封存"}
JOB_STATUS = {"queued": "排队中", "running": "补传中", "succeeded": "成功", "failed": "失败"}


def esc(v) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def money(v) -> str:
    return f"{int(v or 0):,}"


def badge(text: str, cls: str = "") -> str:
    return f'<span class="badge {cls}">{esc(text)}</span>'


# ---------------- multipart 解析（附件上传） ----------------

def parse_multipart(body: bytes, boundary: bytes):
    delim = b"--" + boundary
    fields, files = {}, {}
    for part in body.split(delim):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        header_blob, content = part.split(b"\r\n\r\n", 1)
        headers = {}
        for line in header_blob.decode("utf-8", "replace").split("\r\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        cd = headers.get("content-disposition", "")
        name = None
        filename = None
        for token in cd.split(";"):
            token = token.strip()
            if token.startswith("name="):
                name = token[5:].strip('"')
            elif token.startswith("filename="):
                filename = token[9:].strip('"')
        if not name:
            continue
        if filename is not None:
            files[name] = (filename, content)
        else:
            fields[name] = content.decode("utf-8", "replace")
    return fields, files


class Handler(BaseHTTPRequestHandler):
    server_version = "ATMPlatform/1.0"
    job_queue: "svc.JobQueue" = None  # type: ignore

    def log_message(self, fmt, *args):
        pass  # 静默；审计走 audit_logs

    # ---------- 请求基础 ----------
    def _cookies(self) -> dict[str, str]:
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return {k: m.value for k, m in c.items()}

    @property
    def conn(self) -> sqlite3.Connection:
        if not hasattr(self, "_conn"):
            self._conn = db.connect()
        return self._conn

    def finish(self):
        c = getattr(self, "_conn", None)
        if c:
            c.close()
        super().finish()

    def current_employee(self) -> sqlite3.Row:
        uid = self._cookies().get("uid", "102")
        try:
            row = self.conn.execute("SELECT * FROM employees WHERE id=?", (int(uid),)).fetchone()
        except ValueError:
            row = None
        return row or self.conn.execute("SELECT * FROM employees ORDER BY id LIMIT 1").fetchone()

    def send_html(self, content: str, status: int = 200):
        data = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, path: str):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", path)
        self.end_headers()

    def form(self) -> dict[str, str]:
        length = int(self.headers.get("Content-Length", 0))
        ctype = self.headers.get("Content-Type", "")
        raw = self.rfile.read(length) if length else b""
        if ctype.startswith("multipart/form-data"):
            boundary = ctype.split("boundary=", 1)[1].encode()
            fields, files = parse_multipart(raw, boundary)
            self._files = files
            return fields
        self._files = {}
        return {k: v[0] for k, v in
                urllib.parse.parse_qs(raw.decode("utf-8"), keep_blank_values=True).items()}

    # ---------- 路由 ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/static/style.css":
                return self._static("style.css", "text/css")
            if path == "/" or path == "/ledger":
                return self.page_ledger(qs)
            if path == "/plans":
                return self.page_plans(qs)
            if path == "/clearing":
                return self.page_clearing(qs)
            if path == "/tracks":
                return self.page_tracks(qs)
            if path == "/discrepancies":
                return self.page_discrepancies(qs)
            if path == "/audit":
                return self.page_audit(qs)
            if path == "/attachment":
                return self.download_attachment(qs)
            self.send_html(self.layout("未找到", "<p>页面不存在</p>"), 404)
        except svc.BusinessError as e:
            self.send_html(self.layout("业务错误",
                f'<div class="flash err">⚠ {esc(str(e))}</div>'
                '<p><a class="btn" href="javascript:history.back()">返回</a></p>'), 400)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        form = self.form()
        try:
            route = {
                "/switch": self.act_switch,
                "/plans/create": self.act_plan_create,
                "/plans/lock": self.act_plan_lock,
                "/plans/load": self.act_plan_load,
                "/clearing/open": self.act_clearing_open,
                "/clearing/submit": self.act_clearing_submit,
                "/clearing/review": self.act_clearing_review,
                "/clearing/close": self.act_clearing_close,
                "/clearing/upload": self.act_clearing_upload,
                "/clearing/duplicate-demo": self.act_duplicate_demo,
                "/cassette/claim": self.act_claim,
                "/cassette/release": self.act_release,
                "/cassette/seal": self.act_seal,
                "/cassette/unseal": self.act_unseal,
                "/cassette/qty": self.act_qty,
                "/discrepancy/amend": self.act_amend,
                "/discrepancy/resolve": self.act_resolve,
                "/handover/create": self.act_handover_create,
                "/handover/signoff": self.act_handover_signoff,
                "/jobs/enqueue": self.act_job_enqueue,
            }.get(path)
            if not route:
                return self.send_html(self.layout("未找到", "无此操作"), 404)
            result = route(form)
            if result is None:
                return  # 动作已自行写出响应（如切换操作员）
            back, msg = result
            sep = "&" if "?" in back else "?"
            self.redirect(back + (f"{sep}msg={urllib.parse.quote(msg)}" if msg else ""))
        except svc.BusinessError as e:
            back = form.get("back", "/")
            sep = "&" if "?" in back else "?"
            self.redirect(back + f"{sep}err={urllib.parse.quote(str(e))}")
        except (KeyError, ValueError) as e:
            back = form.get("back", "/") if isinstance(form, dict) else "/"
            self.redirect(back + f"{sep if '?' in back else '?'}err=表单数据不完整：{urllib.parse.quote(str(e))}")

    def _static(self, name: str, ctype: str):
        p = STATIC_DIR / name
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------- 布局 ----------
    def nav(self, active: str) -> str:
        items = [("/", "ATM 台账"), ("/plans", "装钞计划"), ("/clearing", "清机录入"),
                 ("/tracks", "钞箱轨迹"), ("/discrepancies", "差额复核"),
                 ("/audit", "审计查询")]
        links = "".join(
            f'<a class="{ "on" if p == active else "" }" href="{p}">{n}</a>'
            for p, n in items)
        emp = self.current_employee()
        emps = self.conn.execute(
            "SELECT e.*, b.name bname FROM employees e JOIN branches b ON b.id=e.branch_id "
            "ORDER BY e.id").fetchall()
        opts = "".join(
            f'<option value="{e["id"]}" {"selected" if e["id"] == emp["id"] else ""}>'
            f'{esc(e["name"])}（{esc(e["bname"])}·{"主管" if e["role"] == "manager" else "出纳"}）'
            f'</option>' for e in emps)
        return f'''
        <header class="topbar">
          <div class="brand"><span class="logo">¥</span> 现金清分与钞箱交接平台
            <small>Cash Sorting &amp; Cassette Custody</small></div>
          <nav>{links}</nav>
          <form class="who" method="post" action="/switch">
            <label>当前操作员</label>
            <select name="uid" onchange="this.form.submit()">{opts}</select>
          </form>
        </header>'''

    def layout(self, title: str, body: str, active: str = "") -> str:
        emp = self.current_employee()
        branch = self.conn.execute("SELECT name FROM branches WHERE id=?",
                                   (emp["branch_id"],)).fetchone()["name"]
        return f"""<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} · 现金清分平台</title>
<link rel="stylesheet" href="/static/style.css">
</head><body>
{self.nav(active)}
<main class="wrap">
  <div class="page-head">
    <h1>{esc(title)}</h1>
    <div class="ctx">操作员 <b>{esc(emp['name'])}</b>（工号 {esc(emp['code'])}）·
      所属网点 <b>{esc(branch)}</b> · 演示数据</div>
  </div>
  {body}
</main>
<footer class="foot">银灰 / 墨绿 / 金色 · SQLite + 本地附件 + 进程内补传队列 · 全部数据为演示数据</footer>
</body></html>"""

    def flash(self, qs) -> str:
        if qs.get("msg"):
            return f'<div class="flash ok">✓ {esc(qs["msg"][0])}</div>'
        if qs.get("err"):
            return f'<div class="flash err">⚠ {esc(qs["err"][0])}</div>'
        return ""

    # ---------- 页面：ATM 台账 ----------
    def page_ledger(self, qs):
        emp = self.current_employee()
        atms = svc.list_atms(self.conn)
        branches = self.conn.execute("SELECT * FROM branches ORDER BY id").fetchall()
        cards = []
        for br in branches:
            atm_html = []
            for a in atms:
                if a["branch_id"] != br["id"]:
                    continue
                cass = svc.list_cassettes(self.conn, atm_id=a["id"])
                total = sum(c["qty"] * c["denomination_value"] for c in cass)
                rows = ""
                for c in cass:
                    lock = "🔒封存" if c["sealed"] else CASS_STATUS.get(c["status"], c["status"])
                    seal = esc(c["seal_no"]) if c["seal_no"] else '<em>无封签</em>'
                    rows += f"""<tr>
                      <td>{esc(c['code'])}</td>
                      <td class="num">{c['denomination_value']} 元</td>
                      <td class="num">{money(c['qty'])}</td>
                      <td class="num">{money(c['capacity'])}</td>
                      <td class="num amt">{money(c['qty'] * c['denomination_value'])}</td>
                      <td>{seal}</td>
                      <td>{badge(lock, 'seal' if c['sealed'] else 'st-' + c['status'])}</td>
                    </tr>"""
                st = badge("离线", "off") if a["status"] == "offline" else badge("在线", "on")
                atm_html.append(f"""
                <section class="card atm-card">
                  <header class="card-h">
                    <div><span class="card-no">{esc(a['code'])}</span>
                      <span class="card-name">{esc(a['name'])}</span></div>
                    <div>{st}</div>
                  </header>
                  <div class="muted">{esc(a['address'])}</div>
                  <table class="grid">
                    <thead><tr><th>钞箱号</th><th>券别</th><th>张数</th><th>容量</th>
                    <th>金额(元)</th><th>封签号</th><th>状态</th></tr></thead>
                    <tbody>{rows}</tbody>
                  </table>
                  <div class="card-foot">在机金额合计
                    <b class="gold num">{money(total)}</b> 元</div>
                </section>""")
            spare = svc.list_cassettes(self.conn, branch_id=br["id"])
            spare = [c for c in spare if c["atm_id"] is None]
            spare_rows = ""
            for c in spare:
                lock = "🔒封存" if c["sealed"] else CASS_STATUS.get(c["status"], c["status"])
                spare_rows += f"""<tr>
                  <td>{esc(c['code'])}</td>
                  <td class="num">{c['denomination_value']} 元</td>
                  <td class="num">{money(c['qty'])}</td>
                  <td>{esc(c['seal_no']) or '<em>无封签</em>'}</td>
                  <td class="num amt">{money(c['qty'] * c['denomination_value'])}</td>
                  <td>{badge(lock, 'seal' if c['sealed'] else '')}</td>
                  <td class="ops">{self._cassette_ops(c, emp)}</td>
                </tr>"""
            spare_card = f"""
            <section class="card spare-card">
              <header class="card-h"><div><span class="card-name">网点备用 / 在库钞箱</span>
                <small>领取需独占，离开网点须双人签收</small></div></header>
              <table class="grid">
                <thead><tr><th>钞箱号</th><th>券别</th><th>张数</th><th>封签号</th>
                <th>金额(元)</th><th>状态</th><th class="ops">操作</th></tr></thead>
                <tbody>{spare_rows or '<tr><td colspan="7" class="muted">无</td></tr>'}</tbody>
              </table>
            </section>"""
            cards.append(f'<div class="branch-group"><h2 class="group-title"><span class="bar"></span>'
                         f'{esc(br["name"])} <small>{esc(br["code"])}</small></h2>'
                         f'<div class="card-grid">{"".join(atm_html)}</div>{spare_card}</div>')

        # 统计条
        n_disc = self.conn.execute(
            "SELECT COUNT(*) c FROM discrepancies WHERE status='pending'").fetchone()["c"]
        n_open = self.conn.execute(
            "SELECT COUNT(*) c FROM clearings WHERE status!='closed'").fetchone()["c"]
        n_transit = self.conn.execute(
            "SELECT COUNT(*) c FROM handovers WHERE status='pending'").fetchone()["c"]
        stats = f"""
        <div class="stats">
          <div class="stat"><b>{len(atms)}</b><span>ATM 设备</span></div>
          <div class="stat"><b>{self.conn.execute("SELECT COUNT(*) c FROM cassettes").fetchone()["c"]}</b><span>钞箱</span></div>
          <div class="stat"><b class="gold">{money(sum(a_qty_total(self.conn)))}</b><span>全辖在机现金(元)</span></div>
          <div class="stat"><b>{n_open}</b><span>未关闭清机单</span></div>
          <div class="stat"><b class="danger">{n_disc}</b><span>待处理差异</span></div>
          <div class="stat"><b>{n_transit}</b><span>待完成交接</span></div>
        </div>"""
        body = self.flash(qs) + stats + "".join(cards)
        self.send_html(self.layout("ATM 台账", body, "/"))

    def _cassette_ops(self, c, emp) -> str:
        """当前员工可对备用钞箱执行的操作（跨网点操作会被服务层拒绝）。"""
        ops = []
        same = c["branch_id"] == emp["branch_id"]
        if not same:
            return '<span class="muted">非本网点</span>'
        if c["status"] == "claimed":
            owner = self.conn.execute(
                """SELECT e.name FROM cassette_claims cc JOIN employees e ON e.id=cc.employee_id
                   WHERE cc.cassette_id=? AND cc.status='active'""", (c["id"],)).fetchone()
            return f'<span class="muted">领取人：{esc(owner["name"]) if owner else ""}</span>'
        ops.append(f'<form method="post" action="/cassette/claim"><input type="hidden" name="id" value="{c["id"]}">'
                   f'<input type="hidden" name="back" value="/"><button class="btn mini">领取</button></form>')
        if not c["sealed"]:
            ops.append(f'''<form method="post" action="/cassette/seal" class="inline">
              <input type="hidden" name="id" value="{c["id"]}"><input type="hidden" name="back" value="/">
              <input name="seal_no" class="seal-in" placeholder="封签号" required>
              <button class="btn mini gold">封存</button></form>''')
        else:
            ops.append(f'<form method="post" action="/cassette/unseal" class="inline">'
                       f'<input type="hidden" name="id" value="{c["id"]}"><input type="hidden" name="back" value="/">'
                       f'<button class="btn mini danger">解封</button></form>')
            other_branches = self.conn.execute(
                "SELECT id, name FROM branches WHERE id<>? ORDER BY id",
                (c["branch_id"],)).fetchall()
            opts = "".join(f'<option value="{b["id"]}">{esc(b["name"])}</option>'
                           for b in other_branches)
            ops.append(f'''<form method="post" action="/handover/create" class="inline">
              <input type="hidden" name="cassette_id" value="{c["id"]}"><input type="hidden" name="back" value="/tracks">
              <select name="to_branch_id">{opts}</select>
              <button class="btn mini">发起交接</button></form>''')
        return '<div class="ops-row">' + "".join(ops) + "</div>"

    # ---------- 页面：装钞计划 ----------
    def page_plans(self, qs):
        emp = self.current_employee()
        plans = self.conn.execute(
            """SELECT p.*, a.code atm_code, a.name atm_name, b.name branch_name,
                      e.name creator_name
               FROM loading_plans p
               JOIN atms a ON a.id=p.atm_id
               JOIN branches b ON b.id=p.branch_id
               JOIN employees e ON e.id=p.created_by
               ORDER BY p.id DESC""").fetchall()
        cards = []
        for p in plans:
            items = self.conn.execute(
                "SELECT * FROM loading_plan_items WHERE plan_id=? ORDER BY denomination_value",
                (p["id"],)).fetchall()
            total = sum(r["qty"] * r["denomination_value"] for r in items)
            rows = "".join(
                f'<tr><td>{r["denomination_value"]} 元</td>'
                f'<td class="num">{money(r["qty"])}</td>'
                f'<td class="num amt">{money(r["qty"] * r["denomination_value"])}</td></tr>'
                for r in items)
            ops = []
            same = p["branch_id"] == emp["branch_id"]
            if same and p["status"] == "draft":
                ops.append(f'<form method="post" action="/plans/lock">'
                           f'<input type="hidden" name="id" value="{p["id"]}">'
                           f'<button class="btn gold">🔒 锁定计划</button></form>')
            if same and p["status"] == "locked":
                ops.append(f'<form method="post" action="/plans/load">'
                           f'<input type="hidden" name="id" value="{p["id"]}">'
                           f'<button class="btn">执行装钞</button></form>')
            cards.append(f"""
            <section class="card plan-card">
              <header class="card-h">
                <div><span class="card-no">{esc(p['code'])}</span>
                  <span class="card-name">{esc(p['atm_code'])} · {esc(p['atm_name'])}</span></div>
                {badge(PLAN_STATUS[p['status']], 'st-' + p['status'])}</header>
              <div class="muted">{esc(p['branch_name'])} · 制单人 {esc(p['creator_name'])} ·
                {esc(p['created_at'])}{(' · ' + esc(p['note'])) if p['note'] else ''}</div>
              <table class="grid narrow">
                <thead><tr><th>券别</th><th>张数</th><th>金额(元)</th></tr></thead>
                <tbody>{rows}<tr class="sum"><td colspan="2">合计</td>
                  <td class="num gold">{money(total)}</td></tr></tbody>
              </table>
              <div class="card-foot">{"".join(ops) or '<span class="muted">当前状态无可执行操作</span>'}</div>
            </section>""")
        atms = self.conn.execute(
            "SELECT a.*, b.name bname FROM atms a JOIN branches b ON b.id=a.branch_id "
            "ORDER BY a.id").fetchall()
        opts = "".join(
            f'<option value="{a["id"]}">{esc(a["code"])}（{esc(a["bname"])}）</option>'
            for a in atms)
        denom_inputs = "".join(
            f'<label>{d} 元<input type="number" name="d{d}" min="0" value="" placeholder="张数"></label>'
            for d in (100, 50, 20, 10))
        form = f"""
        <section class="card form-card">
          <header class="card-h"><span class="card-name">新建装钞计划</span>
            <small>保存为草稿，装钞前必须锁定；锁定后不可修改</small></header>
          <form method="post" action="/plans/create" class="plan-form">
            <label>ATM
              <select name="atm_id">{opts}</select></label>
            {denom_inputs}
            <label class="grow">备注<input name="note" placeholder="如：节前加钞"></label>
            <button class="btn gold">创建计划</button>
          </form>
        </section>"""
        body = self.flash(qs) + form + '<div class="card-grid">' + "".join(cards) + "</div>"
        self.send_html(self.layout("装钞计划", body, "/plans"))

    # ---------- 页面：清机录入 ----------
    def page_clearing(self, qs):
        emp = self.current_employee()
        cls = self.conn.execute(
            """SELECT c.*, a.code atm_code, a.name atm_name, a.status atm_status,
                      b.name branch_name, e.name opener_name
               FROM clearings c
               JOIN atms a ON a.id=c.atm_id
               JOIN branches b ON b.id=c.branch_id
               JOIN employees e ON e.id=c.opened_by
               ORDER BY c.id DESC""").fetchall()
        cards = []
        for cl in cls:
            items = self.conn.execute(
                "SELECT * FROM clearing_items WHERE clearing_id=? ORDER BY denomination_value",
                (cl["id"],)).fetchall()
            reviews = self.conn.execute(
                """SELECT r.*, e.name reviewer_name FROM clearing_reviews r
                   JOIN employees e ON e.id=r.reviewer_id WHERE r.clearing_id=? ORDER BY r.id""",
                (cl["id"],)).fetchall()
            atts = svc.list_attachments(self.conn, cl["id"])
            disc_rows = self.conn.execute(
                "SELECT * FROM discrepancies WHERE clearing_id=? ORDER BY id",
                (cl["id"],)).fetchall()

            rows = ""
            for it in items:
                actual = "" if it["actual_qty"] is None else money(it["actual_qty"])
                diff = ""
                if it["actual_qty"] is not None:
                    d = (it["actual_qty"] - it["expected_qty"]) * it["denomination_value"]
                    if d:
                        diff = f'<b class="{"danger" if d < 0 else "over"}">' \
                               f'{"−" if d < 0 else "+"}{money(abs(d))}</b>'
                    else:
                        diff = '<span class="muted">平</span>'
                rows += f"""<tr>
                  <td>{it['denomination_value']} 元</td>
                  <td class="num">{money(it['expected_qty'])}</td>
                  <td class="num">{actual}</td>
                  <td class="num">{money(it['defect_qty'])}</td>
                  <td class="num">{diff}</td></tr>"""

            entry = ""
            if cl["status"] == "open" and cl["branch_id"] == emp["branch_id"]:
                inputs = "".join(
                    f'''<div class="drow"><label>{it["denomination_value"]} 元
                        <span class="muted">应收 {money(it["expected_qty"])} 张</span></label>
                        <input type="number" name="a{it["denomination_value"]}" min="0"
                          value="{it["expected_qty"]}" required>
                        <input type="number" name="f{it["denomination_value"]}" min="0"
                          value="0" title="残钞张数"></div>'''
                    for it in items)
                entry = f"""
                <form method="post" action="/clearing/submit" class="entry">
                  <input type="hidden" name="id" value="{cl['id']}">
                  <div class="entry-grid">
                    <div class="muted">实点张数 / 残钞</div><div></div>
                    {inputs}
                    <label class="batch">回传批次号
                      <input name="batch_no" value="BATCH-{esc(cl['code'][-6:])}" required></label>
                    <button class="btn gold">逐券别录入并提交</button>
                  </div>
                </form>"""

            review_html = ""
            if reviews:
                review_html = '<div class="reviews"><b>双人复核：</b>' + "".join(
                    f'{badge(r["reviewer_name"], "rev")}<span class="muted">{esc(r["comment"])}</span>'
                    for r in reviews) + "</div>"
            ops = []
            same = cl["branch_id"] == emp["branch_id"]
            if same and cl["status"] in ("submitted", "reviewed"):
                ops.append(f'''<form method="post" action="/clearing/review">
                  <input type="hidden" name="id" value="{cl['id']}">
                  <input name="comment" placeholder="复核意见（可选）">
                  <button class="btn">复核签名（第 {len(reviews) + 1} 人）</button></form>''')
            if same and cl["status"] == "reviewed":
                ops.append(f'<form method="post" action="/clearing/close">'
                           f'<input type="hidden" name="id" value="{cl["id"]}">'
                           f'<button class="btn gold">关闭清机单</button></form>')
            if same and cl["status"] != "closed":
                ops.append(f'''<form method="post" action="/clearing/upload"
                    enctype="multipart/form-data" class="inline">
                    <input type="hidden" name="id" value="{cl['id']}">
                    <input type="file" name="file" required>
                    <button class="btn mini">上传清机附件</button></form>''')

            att_html = ""
            if atts:
                att_html = '<div class="atts"><b>附件：</b>' + "".join(
                    f'<a href="/attachment?id={a["id"]}">📎 {esc(a["filename"])}</a>'
                    f'<span class="muted">{a["size"]}B · {esc(a["uploaded_by_name"] or "")}</span>'
                    for a in atts) + "</div>"
            disc_html = ""
            if disc_rows:
                disc_html = '<div class="mini-disc">' + "".join(
                    f'{badge(svc.DISC_TYPES[d["type"]], "disc-" + d["type"])}'
                    f'<b class="{"danger" if d["amount"] else ""}">{money(d["amount"])} 元</b>'
                    f'{badge(("待处理" if d["status"] == "pending" else "已处置"), "st-" + d["status"])}'
                    for d in disc_rows) + "</div>"

            st_off = badge("ATM 离线", "off") if cl["atm_status"] == "offline" else ""
            cards.append(f"""
            <section class="card clearing-card">
              <header class="card-h">
                <div><span class="card-no">{esc(cl['code'])}</span>
                  <span class="card-name">{esc(cl['atm_code'])} · {esc(cl['atm_name'])}</span>
                  {st_off}</div>
                {badge(CL_STATUS[cl['status']], 'cl-' + cl['status'])}</header>
              <div class="muted">{esc(cl['branch_name'])} · 开单 {esc(cl['opener_name'])} ·
                {esc(cl['opened_at'])}{(' · ' + esc(cl['note'])) if cl['note'] else ''}</div>
              <table class="grid narrow">
                <thead><tr><th>券别</th><th>应收张数</th><th>实点张数</th>
                <th>残钞</th><th>差额(元)</th></tr></thead>
                <tbody>{rows}
                <tr class="sum"><td colspan="4">预期 / 实点合计</td>
                  <td class="num">{money(cl['expected_total'])} /
                    <b class="gold">{money(cl['actual_total'])}</b></td></tr></tbody>
              </table>
              {entry}{review_html}{disc_html}{att_html}
              <div class="card-foot ops-row">{"".join(ops)}</div>
            </section>""")

        atms = self.conn.execute(
            "SELECT a.*, b.name bname FROM atms a JOIN branches b ON b.id=a.branch_id ORDER BY a.id"
        ).fetchall()
        opts = "".join(f'<option value="{a["id"]}">{esc(a["code"])}（{esc(a["bname"])}）</option>'
                       for a in atms)
        open_form = f"""
        <section class="card form-card">
          <header class="card-h"><span class="card-name">新开清机单</span>
            <small>清机时按实点金额逐券别录入；离线 ATM 自动登记差异</small></header>
          <form method="post" action="/clearing/open" class="plan-form">
            <label>ATM<select name="atm_id">{opts}</select></label>
            <label class="grow">备注<input name="note" placeholder="如：节后清机"></label>
            <button class="btn">开单</button>
          </form>
          <form method="post" action="/clearing/duplicate-demo" class="dup-demo">
            <button class="btn mini danger">模拟重复回传（使用已存在批次号 BATCH-20260921-09）</button>
          </form>
        </section>"""
        body = self.flash(qs) + open_form + '<div class="card-grid">' + "".join(cards) + "</div>"
        self.send_html(self.layout("清机录入", body, "/clearing"))

    # ---------- 页面：钞箱轨迹 + 交接 ----------
    def page_tracks(self, qs):
        emp = self.current_employee()
        cass_id = qs.get("cassette", [None])[0]
        cassettes = self.conn.execute(
            """SELECT c.*, b.name branch_name FROM cassettes c
               JOIN branches b ON b.id=c.branch_id ORDER BY c.id""").fetchall()
        sel = int(cass_id) if cass_id else cassettes[0]["id"]
        target = self.conn.execute(
            "SELECT c.*, b.name branch_name FROM cassettes c JOIN branches b ON b.id=c.branch_id "
            "WHERE c.id=?", (sel,)).fetchone()
        tracks = svc.cassette_tracks(self.conn, sel)
        opts = "".join(
            f'<option value="{c["id"]}" {"selected" if c["id"] == sel else ""}>'
            f'{esc(c["code"])} · {c["denomination_value"]}元 · {esc(c["branch_name"])}</option>'
            for c in cassettes)
        tl = []
        for i, t in enumerate(tracks):
            seal_cls = "sealed" if t["seal_no"] else "unsealed"
            seal_txt = f'封签 <b>{esc(t["seal_no"])}</b>' if t["seal_no"] else "无封签"
            tl.append(f"""
            <li class="t-item {seal_cls}">
              <span class="dot">{i + 1}</span>
              <div class="t-body">
                <div class="t-h"><b>{esc(t['event'])}</b>
                  {badge(seal_txt, "seal" if t["seal_no"] else "noseal")}
                  <span class="muted">{esc(t['created_at'])}</span></div>
                <div class="muted">位置：{esc(t['location'])} ·
                  操作员：{esc(t['operator_name'] or '系统')}</div>
                {f'<div>{esc(t["detail"])}</div>' if t['detail'] else ''}
              </div></li>""")
        # 数量调整（未封存才可改）
        qty_form = ""
        if target["branch_id"] == emp["branch_id"] and not target["sealed"]:
            qty_form = f"""
            <form method="post" action="/cassette/qty" class="inline qty-form">
              <input type="hidden" name="id" value="{target['id']}">
              <input type="hidden" name="back" value="/tracks?cassette={target['id']}">
              <label>调整张数<input type="number" min="0" max="{target['capacity']}"
                name="qty" value="{target['qty']}"></label>
              <button class="btn mini">保存数量</button>
              <small class="muted">封存后此入口禁用</small>
            </form>"""
        sealed_note = '<div class="flash err">🔒 该钞箱已封存，不能直接修改数量</div>' \
            if target["sealed"] else ""

        # 交接单
        handovers = svc.list_handovers(self.conn)
        h_cards = []
        for h in handovers:
            signs = "".join(
                f'<li>{badge("已签收", "rev")} <b>{esc(s["employee_name"])}</b>'
                f'<span class="muted">{esc(s["branch_name"])} · {esc(s["created_at"])}</span></li>'
                for s in h["signoffs"])
            can_sign = (emp["branch_id"] in (h["from_branch_id"], h["to_branch_id"])
                        and h["status"] == "pending")
            sign_btn = f'''<form method="post" action="/handover/signoff" class="inline">
                <input type="hidden" name="id" value="{h["id"]}">
                <input type="hidden" name="back" value="/tracks">
                <button class="btn gold">签收（须两名不同员工）</button></form>''' if can_sign else ""
            h_cards.append(f"""
            <section class="card hand-card">
              <header class="card-h">
                <div><span class="card-no">{esc(h['code'])}</span>
                  <span class="card-name">钞箱 {esc(h['cassette_code'])} · 封签 {esc(h['seal_no'])}</span></div>
                {badge('交接中（已签收 %d/2）' % len(h['signoffs']) if h['status'] == 'pending'
                       else '交接完成', 'st-in_transit' if h['status'] == 'pending' else 'st-loaded')}
              </header>
              <div class="route"><span>{esc(h['from_branch_name'])}</span>
                <span class="arrow">⟶</span><span>{esc(h['to_branch_name'])}</span></div>
              <ul class="sign-list">{signs or '<li class="muted">尚无签收</li>'}</ul>
              {sign_btn}
            </section>""")

        body = f"""
        {self.flash(qs)}
        <section class="card">
          <header class="card-h">
            <span class="card-name">封签状态连续轨迹</span>
            <form method="get" action="/tracks" class="inline">
              <select name="cassette" onchange="this.form.submit()">{opts}</select>
            </form>
          </header>
          <div class="cass-meta">
            <div>钞箱 <b>{esc(target['code'])}</b> · {target['denomination_value']} 元券别 ·
              容量 {money(target['capacity'])} 张 · 当前 <b>{money(target['qty'])}</b> 张</div>
            <div>当前位置 <b>{esc(target['location'])}</b> · 所属 {esc(target['branch_name'])} ·
              {badge("🔒已封存 " + target['seal_no'] if target['sealed'] else "未封存",
                     "seal" if target['sealed'] else "noseal")}</div>
            {qty_form}{sealed_note}
          </div>
          <ol class="timeline">{"".join(tl)}</ol>
        </section>
        <h2 class="group-title"><span class="bar"></span>钞箱交接（离开网点双人签收）</h2>
        <div class="card-grid">{"".join(h_cards) or '<p class="muted">暂无交接单</p>'}</div>"""
        self.send_html(self.layout("钞箱轨迹", body, "/tracks"))

    # ---------- 页面：差额复核 ----------
    def page_discrepancies(self, qs):
        emp = self.current_employee()
        f_branch = qs.get("branch", [""])[0]
        f_status = qs.get("status", [""])[0]
        discs = svc.list_discrepancies(
            self.conn, int(f_branch) if f_branch else None, f_status or None)
        branches = self.conn.execute("SELECT * FROM branches ORDER BY id").fetchall()
        b_opts = "".join(
            f'<option value="{b["id"]}" {"selected" if f_branch == str(b["id"]) else ""}>'
            f'{esc(b["name"])}</option>' for b in branches)
        today = __import__("datetime").date.today().isoformat()
        rows = ""
        for d in discs:
            due_cls = "overdue" if d["due_date"] <= today and d["status"] == "pending" else ""
            amt_cls = "danger" if d["type"] in ("short",) else (
                "over" if d["type"] == "over" else "")
            ams = svc.amendments(self.conn, d["id"])
            amend_hist = "".join(
                f'<div class="amend">{money(a["old_amount"])} → <b>{money(a["new_amount"])}</b>'
                f'元 · {esc(a["reason"])} · 审批人 <b>{esc(a["approver_name"])}</b>'
                f' · {esc(a["created_at"])}</div>' for a in ams)
            ops = ""
            same = d["branch_id"] == emp["branch_id"]
            if same and d["status"] == "pending":
                ops = f'''
                <div class="ops-row">
                  <form method="post" action="/discrepancy/amend" class="amend-form">
                    <input type="hidden" name="id" value="{d["id"]}">
                    <input type="hidden" name="back" value="/discrepancies">
                    <input name="new_amount" type="number" min="0" value="{d["amount"]}"
                      class="num" style="width:7em">
                    <input name="reason" placeholder="修正原因（必填）" required>
                    <button class="btn mini">金额修正</button>
                  </form>
                  <form method="post" action="/discrepancy/resolve">
                    <input type="hidden" name="id" value="{d["id"]}">
                    <input type="hidden" name="back" value="/discrepancies">
                    <button class="btn mini gold" name="action" value="approved">审批核销</button>
                  </form>
                </div>'''
            rows += f"""
            <tr>
              <td><span class="card-no">{esc(d['code'])}</span><br>
                <small class="muted">{esc(d['clearing_code'] or '—')}</small></td>
              <td>{badge(svc.DISC_TYPES[d['type']], 'disc-' + d['type'])}</td>
              <td class="num amt {amt_cls}">{money(d['amount'])}</td>
              <td>{esc(d['denomination_value'] or '—')}{" 元" if d['denomination_value'] else ""}</td>
              <td class="due {due_cls}"><b>{esc(d['due_date'])}</b>
                {'<small>已到期</small>' if due_cls else '<small>期限内</small>'}</td>
              <td>{esc(d['description'])}</td>
              <td>{badge("待处理" if d["status"] == "pending" else "已处置", "st-" + d["status"])}
                <small class="muted">{esc(d["approver_name"] or "")}</small>
                {amend_hist}</td>
              <td class="ops">{ops}</td>
            </tr>"""
        filter_bar = f"""
        <form method="get" class="filter-bar">
          <label>网点<select name="branch"><option value="">全部</option>{b_opts}</select></label>
          <label>状态<select name="status">
            <option value="">全部</option>
            <option value="pending" {"selected" if f_status == 'pending' else ''}>待处理</option>
            <option value="resolved" {"selected" if f_status == 'resolved' else ''}>已处置</option>
            <option value="rejected" {"selected" if f_status == 'rejected' else ''}>已驳回</option>
          </select></label>
          <button class="btn mini">筛选</button>
        </form>"""
        pending_sum = self.conn.execute(
            "SELECT type, SUM(amount) s, COUNT(*) c FROM discrepancies WHERE status='pending' "
            "GROUP BY type").fetchall()
        sum_cards = "".join(
            f'<div class="stat"><b class="{"danger" if r["type"] == "short" else "gold"}">'
            f'{money(r["s"] if r["type"] != "seal_broken" else 0)}</b>'
            f'<span>{svc.DISC_TYPES[r["type"]]} {r["c"]} 笔(元)</span></div>'
            for r in pending_sum) or '<div class="muted">无待处理差异</div>'
        body = f"""
        {self.flash(qs)}
        <div class="stats">{sum_cards}</div>
        {filter_bar}
        <section class="card">
          <table class="grid disc-table">
            <thead><tr><th>差异编号/清机单</th><th>类型</th><th>金额(元)</th><th>券别</th>
            <th>处理期限</th><th>说明</th><th>状态 / 修正留痕</th><th>操作</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </section>"""
        self.send_html(self.layout("差额复核", body, "/discrepancies"))

    # ---------- 页面：审计查询 + 队列 ----------
    def page_audit(self, qs):
        emp = self.current_employee()
        kw = qs.get("kw", [""])[0]
        action = qs.get("action", [""])[0]
        sql = """SELECT l.*, b.name branch_name FROM audit_logs l
                 LEFT JOIN branches b ON b.id=l.branch_id WHERE 1=1"""
        params = []
        if kw:
            sql += " AND (l.detail LIKE ? OR l.ref_code LIKE ? OR l.actor_name LIKE ?)"
            params += [f"%{kw}%"] * 3
        if action:
            sql += " AND l.action=?"
            params.append(action)
        sql += " ORDER BY l.id DESC LIMIT 200"
        logs = self.conn.execute(sql, params).fetchall()
        rows = "".join(
            f'<tr><td class="nowrap">{esc(l["created_at"])}</td>'
            f'<td>{esc(l["actor_name"])}</td><td>{esc(l["branch_name"] or "—")}</td>'
            f'<td><b>{esc(l["action"])}</b></td><td>{esc(l["entity"])}</td>'
            f'<td class="nowrap">{esc(l["ref_code"])}</td><td>{esc(l["detail"])}</td></tr>'
            for l in logs)
        actions = ["创建装钞计划", "锁定装钞计划", "执行装钞", "开启清机单", "提交清机录入",
                   "清机复核", "关闭清机单", "金额修正", "差异处置", "登记差异",
                   "领取钞箱", "交还钞箱", "钞箱封存", "钞箱解封", "发起钞箱交接", "交接签收"]
        a_opts = '<option value="">全部动作</option>' + "".join(
            f'<option {"selected" if action == a else ""}>{esc(a)}</option>' for a in actions)
        jobs = self.job_queue.list_jobs() if self.job_queue else []
        j_rows = "".join(
            f'<tr><td>{esc(j["code"])}</td><td>{esc(j["ref_text"])}</td>'
            f'<td>{badge(JOB_STATUS.get(j["status"], j["status"]), "job-" + j["status"])}</td>'
            f'<td class="num">{j["attempts"]}</td><td class="muted">{esc(j["last_error"])}</td>'
            f'<td class="nowrap">{esc(j["updated_at"])}</td></tr>' for j in jobs)
        body = f"""
        {self.flash(qs)}
        <section class="card">
          <header class="card-h"><span class="card-name">审计日志</span>
            <small>最近 200 条，可按关键字 / 动作过滤</small></header>
          <form method="get" class="filter-bar">
            <label class="grow">关键字
              <input name="kw" value="{esc(kw)}" placeholder="钞箱号 / 员工 / 差异说明片段"></label>
            <label>动作<select name="action">{a_opts}</select></label>
            <button class="btn mini">查询</button>
          </form>
          <table class="grid">
            <thead><tr><th>时间</th><th>操作人</th><th>网点</th><th>动作</th>
            <th>对象</th><th>单据号</th><th>明细</th></tr></thead>
            <tbody>{rows or '<tr><td colspan="7" class="muted">无匹配记录</td></tr>'}</tbody>
          </table>
        </section>
        <section class="card">
          <header class="card-h"><span class="card-name">进程内补传任务队列</span>
            <small>后台线程串行处理，失败自动重试</small>
            <form method="post" action="/jobs/enqueue" class="inline">
              <input name="ref_text" placeholder="关联单据，如 C…" value="">
              <button class="btn mini gold">新增补传任务</button>
            </form>
          </header>
          <table class="grid narrow">
            <thead><tr><th>任务号</th><th>关联单据</th><th>状态</th><th>尝试次数</th>
            <th>错误</th><th>更新时间</th></tr></thead>
            <tbody>{j_rows or '<tr><td colspan="6" class="muted">队列为空</td></tr>'}</tbody>
          </table>
        </section>"""
        self.send_html(self.layout("审计查询", body, "/audit"))

    def download_attachment(self, qs):
        a = self.conn.execute("SELECT * FROM attachments WHERE id=?",
                              (qs.get("id", ["0"])[0],)).fetchone()
        if not a:
            return self.send_html(self.layout("未找到", "附件不存在"), 404)
        data = Path(a["stored_path"]).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition",
                         f'attachment; filename="{urllib.parse.quote(a["filename"])}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------- 动作 ----------
    def act_switch(self, form):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", form.get("back", "/"))
        c = SimpleCookie()
        c["uid"] = form.get("uid", "102")
        self.send_header("Set-Cookie", c.output(header="").strip())
        self.end_headers()
        return None  # 已自行响应

    def _uid(self, form):
        return self.current_employee()["id"]

    def act_plan_create(self, form):
        items = {d: int(form.get(f"d{d}", "") or 0) for d in svc.DENOMS}
        r = svc.create_plan(self.conn, self._uid(form), int(form["atm_id"]), items,
                            form.get("note", ""))
        return "/plans", f'装钞计划 {r["plan_code"]} 已创建（草稿）'

    def act_plan_lock(self, form):
        svc.lock_plan(self.conn, self._uid(form), int(form["id"]))
        return "/plans", "计划已锁定，装钞数据不可再修改"

    def act_plan_load(self, form):
        svc.load_plan(self.conn, self._uid(form), int(form["id"]))
        return "/plans", "装钞完成，钞箱已入机并写入轨迹"

    def act_clearing_open(self, form):
        r = svc.open_clearing(self.conn, self._uid(form), int(form["atm_id"]),
                              note=form.get("note", ""))
        return "/clearing", f'清机单 {r["clearing_code"]} 已开单'

    def act_clearing_submit(self, form):
        cid = int(form["id"])
        cl = self.conn.execute("SELECT * FROM clearings WHERE id=?", (cid,)).fetchone()
        denoms = [r["denomination_value"] for r in self.conn.execute(
            "SELECT DISTINCT denomination_value FROM clearing_items WHERE clearing_id=?",
            (cid,))]
        actual = {d: int(form.get(f"a{d}", "") or 0) for d in denoms}
        defects = {d: int(form.get(f"f{d}", "") or 0) for d in denoms}
        r = svc.submit_clearing(self.conn, self._uid(form), cid, actual, defects,
                                form.get("batch_no") or None)
        return "/clearing", (f'清机录入完成：预期 {money(r["expected_total"])} 元，'
                             f'实点 {money(r["actual_total"])} 元，'
                             f'生成差异 {len(r["discrepancies"])} 条')

    def act_clearing_review(self, form):
        r = svc.review_clearing(self.conn, self._uid(form), int(form["id"]),
                                form.get("comment", ""))
        done = "双人复核完成，可关闭" if r["reviews"] >= 2 else f"已签收 {r['reviews']}/2"
        return "/clearing", done

    def act_clearing_close(self, form):
        svc.close_clearing(self.conn, self._uid(form), int(form["id"]))
        return "/clearing", "清机单已关闭，钞箱归位"

    def act_clearing_upload(self, form):
        cid = int(form["id"])
        filename, data = self._files.get("file", ("", b""))
        if not filename:
            raise svc.BusinessError("请选择附件")
        svc.save_attachment(self.conn, self._uid(form), cid, filename, data)
        return "/clearing", f"附件 {filename} 已保存到本地目录"

    def act_duplicate_demo(self, form):
        """演示重复回传拦截：对 ATM2 开单并以已存在批次号提交。"""
        uid = self._uid(form)
        r = svc.open_clearing(self.conn, uid, 2, note="重复回传拦截演示")
        try:
            svc.submit_clearing(self.conn, uid, r["clearing_id"], {100: 800},
                                batch_no="BATCH-20260921-09")
        except svc.BusinessError:
            raise
        return "/clearing", "不应发生"

    def act_claim(self, form):
        r = svc.claim_cassette(self.conn, self._uid(form), int(form["id"]))
        return form.get("back", "/"), "领取成功（独占）"

    def act_release(self, form):
        svc.release_cassette(self.conn, self._uid(form), int(form["id"]))
        return form.get("back", "/"), "钞箱已交还"

    def act_seal(self, form):
        svc.seal_cassette(self.conn, self._uid(form), int(form["id"]), form["seal_no"])
        return form.get("back", "/tracks"), f"已加封封签 {form['seal_no']}"

    def act_unseal(self, form):
        svc.unseal_cassette(self.conn, self._uid(form), int(form["id"]))
        return form.get("back", "/tracks"), "封签已拆除并留痕"

    def act_qty(self, form):
        svc.update_cassette_qty(self.conn, self._uid(form), int(form["id"]),
                                int(form["qty"]))
        return form.get("back", "/tracks"), "数量已更新并写入轨迹"

    def act_amend(self, form):
        svc.amend_discrepancy_amount(self.conn, self._uid(form), int(form["id"]),
                                     int(form["new_amount"]), form["reason"])
        return form.get("back", "/discrepancies"), "金额已修正，原值/原因/审批人已留痕"

    def act_resolve(self, form):
        svc.resolve_discrepancy(self.conn, self._uid(form), int(form["id"]),
                                form.get("action", "resolved"), "审批通过")
        return form.get("back", "/discrepancies"), "差异已处置"

    def act_handover_create(self, form):
        r = svc.create_handover(self.conn, self._uid(form), int(form["cassette_id"]),
                                int(form["to_branch_id"]))
        return form.get("back", "/tracks"), f"交接单 {r['handover_code']} 已发起，等待双人签收"

    def act_handover_signoff(self, form):
        r = svc.signoff_handover(self.conn, self._uid(form), int(form["id"]))
        if r["signoffs"] >= 2:
            return form.get("back", "/tracks"), "双人签收完成，钞箱已到达调入网点"
        return form.get("back", "/tracks"), f"签收成功（{r['signoffs']}/2），还需另一名员工"

    def act_job_enqueue(self, form):
        jcode = self.job_queue.enqueue(form.get("ref_text", ""),
                                       {"by": self.current_employee()["name"]})
        return "/audit", f"补传任务 {jcode} 已入队"


def a_qty_total(conn):
    return [r["amount"] for r in conn.execute(
        "SELECT COALESCE(SUM(qty*denomination_value),0) amount FROM cassettes "
        "WHERE atm_id IS NOT NULL")]


def serve(host: str = "127.0.0.1", port: int = 8000):
    conn = db.connect()
    db.migrate(conn)
    seed.seed(conn)
    conn.close()

    jq = svc.JobQueue()
    jq.start()
    # 预置一条补传样例
    jq.enqueue("BATCH-20260921-09", {"memo": "ATM 离线期间流水补传样例"})

    httpd = ThreadingHTTPServer((host, port), Handler)
    Handler.job_queue = jq
    print(f"ATM 现金清分与钞箱交接平台已启动: http://{host}:{port}")
    print(f"数据库: {db.DB_PATH}    附件目录: {db.ATTACH_DIR}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        jq.stop()
        httpd.server_close()


if __name__ == "__main__":
    serve(os.environ.get("ATM_HOST", "127.0.0.1"),
          int(os.environ.get("ATM_PORT", "8000")))

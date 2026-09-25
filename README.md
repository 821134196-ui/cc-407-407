# 银行 ATM 现金清分与钞箱交接平台（演示）

管理网点、ATM、钞箱、券别、装钞计划、清机记录、差额、封签与双人复核的一体化演示平台。
**零第三方依赖**：仅使用 Python 3 标准库 + SQLite。所有账户、金额、卡号均为演示数据。

## 单条本地启动

```bash
./run.sh                 # 自动迁移数据库 + 写入演示样例 + 启动 http://127.0.0.1:8000
ATM_PORT=9000 ./run.sh   # 自定义端口
./run.sh --reseed        # 重置并重新写入演示数据
python3 -m unittest discover -s tests -v   # 运行全部测试
```

首次启动会在 `data/` 下创建 SQLite 库、在 `data/attachments/` 保存清机附件，并写入：
网点 3 个、员工 8 名、ATM 4 台、钞箱 17 个，以及装钞 → 清机 → 差异（短款/长款/残钞/
离线/封签破损/重复回传）→ 金额修正 → 双人复核 → 关闭的完整业务样例。

## 六大交付页面

| 页面 | 内容 |
|---|---|
| **ATM 台账** `/` | 按网点分组卡片呈现 ATM 与钞箱；券别金额右对齐数字列；在机金额合计；备用钞箱领取/封存/解封/发起交接 |
| **装钞计划** `/plans` | 新建草稿 → 装钞前锁定（锁定不可改）→ 执行装钞入箱 |
| **清机录入** `/clearing` | 开单后按实点金额**逐券别录入**（含残钞张数、回传批次号）；附件上传；双人复核签名；关闭 |
| **钞箱轨迹** `/tracks` | 钞箱编号/券别容量/封签号/当前位置；封签状态用连续时间线展示；跨网点交接单双人签收 |
| **差额复核** `/discrepancies` | 短款/长款/残钞/封签破损/离线/重复回传六类差异；金额与处理期限高亮；金额修正留痕；审批核销 |
| **审计查询** `/audit` | 全量操作审计（动作/对象/单据号/明细）；进程内补传任务队列状态与重试次数 |

顶栏可切换当前操作员（按网点隔离权限）。界面配色：银灰底、墨绿主色、金色点缀。

## 核心业务规则实现位置（`app/services.py`）

- **装钞前锁定计划**：`lock_plan()` / `load_plan()`，仅 `draft` 可锁定，仅 `locked` 可装钞。
- **逐券别清机录入**：`submit_clearing()`，逐券别比对应收/实点自动生成短款、长款、残钞差异。
- **封签**：`seal_cassette()` / `unseal_cassette()`；**已封存钞箱不能直接改数量**
  （`update_cassette_qty()` 拦截）；封签破损 `report_seal_broken()` 生成差异。
- **双人复核**：`review_clearing()` 要求两名不同员工（开单人不可复核），未满 2 人
  `close_clearing()` 禁止关闭；有待处理差异同样禁止关闭。
- **金额修正**：`amend_discrepancy_amount()` 在 `amount_amendments` 保留原值、新值、
  原因、审批人，差异必须填写原因。
- **钞箱离开网点双人签收**：`create_handover()` 要求先封存；`signoff_handover()`
  要求两名不同的双方网点员工，签满后钞箱落到调入网点。
- **两人同时领取同一钞箱只允许一人成功**：`cassette_claims` 上的部分唯一索引
  `WHERE status='active'` + `BEGIN IMMEDIATE` 事务兜底（见并发测试）。
- **重复回传**：`clearings.batch_no` 唯一；重复批次号拒绝入账并登记 `duplicate` 差异。
- **网点权限**：`require_branch()` 统一校验，员工只能操作本网点单据/钞箱/差异。
- **进程内补传队列**：`JobQueue` 后台线程串行处理，失败自动重试，状态落 SQLite `jobs` 表。

## 数据与存储

- SQLite：`data/atm_platform.db`（WAL 模式，`PRAGMA user_version` 管理自动迁移，见 `app/db.py`）
- 清机附件：本地目录 `data/attachments/`，元数据入 `attachments` 表
- 券别：100/50/20/10/5/1 元；金额单位为元（整数），演示用卡号式编号 `ATM-6222-xxxx`

## 测试覆盖（23 项）

```
python3 -m unittest discover -s tests -v
```

券别汇总、计划锁定、封存钞箱数量锁定、容量校验、重复回传拒绝、清机单不可重复提交、
双人复核（开单人回避/同人不可重复/未复核禁关闭）、待处理差异阻塞关闭、金额修正留痕、
跨网点权限（计划/复核/领取/封存/修正）、并发领取唯一成功、双人交接签收、
离线自动差异、残钞校验、补传队列重试。

## 目录结构

```
app/
  db.py         SQLite 连接、建表与迁移
  services.py   业务规则（装钞/清机/差异/封签/交接/队列）
  seed.py       演示数据样例
  web.py        http.server Web 界面与接口
  main.py       启动入口（迁移 + seed + serve）
  static/style.css
tests/test_platform.py
run.sh          单条启动命令
```

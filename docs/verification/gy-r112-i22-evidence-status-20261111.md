# #22 失败回归的证据面现状（R112 片，2026-11-11）

本页回答一个问题：**#22「完成权限、安全规则及首版端到端失败回归」的证据面，今天到哪一步了。**
它不关单、不给结论性批复；关不关由监工判。本页只把「今天在 main 上能复算什么、还缺什么、缺在哪一行」摊开。

## 1. 一句话结论

- 失败回归的**可执行证据**已经齐了：表驱动矩阵 **273 条**＋负控制 **29 条**，stub 臂 **273/273 PASS**、真库臂 **203 条 same 203 / different 0 / not-runnable 0**（本机 PostgreSQL 17.11）。
- 证据**页**也有了：`docs/verification/gy-i22-failmatrix-current-20261111.md` 由 `tools/i22-failmatrix-evidence-table.mjs --write` 生成，表格行数由工具与矩阵对账（对不上直接拒绝写盘）。
- 但 #22 仍**不该关**：真机回归、发布验收、以及第 4 节列出的若干「仍未取得」不在本片证据面内；R90 索引页给 #22 的「差证据」理由里，「缺证据页」这一条**已被本页取代**，其余理由不变。

## 2. 今天可原地复算的读数

| 读数 | 命令 | 今天的结果 |
| --- | --- | --- |
| 表驱动矩阵 | `node tests/failmatrix/run.mjs` | 273 条：PASS 273 / FAIL 0（HTTP 249 + seam 20） |
| 负控制（故意改坏源码，看用例是否真的会红） | `node tools/i22-failmatrix-negative-control.mjs` | 29 条：PASS 29 / FAIL 0 |
| 真库权限面 | `node tests/failmatrix/run-real.mjs`（需 `GY_PG_BIN`） | 203 条：same 203 / different 0 / not-runnable 0 |
| 矩阵与文档是否自洽 | `node tools/i22-failmatrix-evidence-table.mjs` | 「自洽：矩阵 273 条全 PASS、负控制 29 条全 PASS，与文档声明一致」 |

族分布（矩阵，合计 273）：C1 37、C2 24、C3 40、C4 36、C5 12、C6 12、C7 16、E1 3、E2 3、C10 23、C11 39、F1 6、E3 2，D 族（受信 seam）D1 11、D2 4、D3 2、D4 3。
真库臂只跑权限面八族（C1–C4、C10、C11、E3、F1）＝203 条；其余族依赖对象存储／真实供应商／异步作业，在 real 模式下 fail-closed，属例如实记 `not-runnable`，不进真库臂。

## 3. 本片新增了什么（相对 R110 之前）

1. **证据表口径与反向对账**：`tools/i22-failmatrix-evidence-table.mjs` 的 `EXPECTED` 与真实普查对齐，并补了「矩阵里出现未登记族／批次就报错」的反向检查；新增单测从工具源码读 `EXPECTED` 字面量与三份矩阵源文件普查逐项比对。
2. **现行口径证据页**：`docs/verification/gy-i22-failmatrix-current-20261111.md`（生成区 = 矩阵 273 行＋负控制 29 行；§5 明列「不能证明什么」七条）。
3. **AC↔用例族映射**：`FAMILY_ACCEPTANCE` 补 E3／C10／C11，并把此前在 `tests/` 下**零标签**的 AC07（失败与重试）与 AC23（注销删除与保留）落位；新增单测钉住「#22 的 12 条 AC 每条至少一族承担、不许出现范围外 AC」。
4. **真库臂扩面**：`PERMISSION_FAMILIES` 从六族扩到八族，E3（后台内容写的版本／引用门槛）与 F1（下架后引用跳转）进真库臂，180 → 203 条；E3-01 真库 409 `REVISION_CONFLICT`、E3-02 真库 422 `SOURCE_CONFLICT`，与 stub 期望一致。
5. **伪造角色／篡改 claim**：C3 族补 4 条（伪造不透明令牌、真令牌尾字符篡改、自报 `x-admin-scopes`／`x-scopes`／`x-role` 提权、同组头的正控制），并补两条负控制。此前全仓只有两条「伪造令牌 401」的散点断言，failmatrix 里没有这一类用例。
6. **口径清理**：`failmatrix` workflow 头注释与 `tests/failmatrix/README.md` 的历史条数（230／249）改到现行值并写清来路；一键「在途取消 `REQUEST_IN_PROGRESS` 409 未取得」的旧说法被实测推翻，改成订正行（真实多进程竞争仍未取得）。

## 4. 仍未取得（本片**不**声称已解决）

| # | 仍未取得 | 现状 |
| --- | --- | --- |
| 1 | 注销冷静期到期后的**真实清理执行面**（在线 7 日 / 备份 30 日） | 只覆盖「申请 → 回执 → 冷静期内原会话可用」；到期清理有独立真库臂与保留闸门，但未与本矩阵串联 |
| 2 | 第三方删除状态 | 适配器仍未装配进 `app.ts`（数据缺口钉在 `tests/unit/s4-data-gap-pins.test.mjs`【缺口 2】）；状态机与故障阻塞已有覆盖，端到端仍缺 |
| 3 | 社区**媒体授权全链路** | stub 下带图发帖被判 `422 INPUT_UNCERTAIN`（`decision=quarantined`），正路走不通；只覆盖 C5 前面的 400/404 与图片审核缺失路径 |
| 4 | 收藏／消息的**来源撤回端到端** | 消息域已由 F1 族覆盖；收藏域需要知识公开读面（stub 无），`SOURCE_WITHDRAWN` 端到端仍未取得 |
| 5 | real 模式下 media／社区投稿／异步 AI 作业 | 对象存储与真实供应商未接线 ⇒ fail-closed，无法播种属主行，属例如实 `not-runnable` |
| 6 | #279 读面复测、#256 残余 retryable 扫尾复测 | 两片代码已合入，复测未做（见 `docs/verification/gy-i22-closure-gap-20261018.md` 第 6 节） |
| 7 | 真实**多进程竞争**（在途取消／并发注销） | 单进程内并发已覆盖（C6 在途 409 及各服务并发用例）；跨进程竞争未取得 |
| 8 | 真机回归与发布验收 | 属 #23／#24 的外部条件，不在 #22 的证据面内 |

## 5. 与其它证据页的关系

- `docs/verification/gy-i22-closure-gap-20261018.md`：2026-10-18 的缺口页，第 6 节「未取得 7 项」仍是本页第 4 节的来源；该页自陈「本页不构成关闭声明」，本页也不构成。
- `docs/verification/gy-i22-failmatrix-20261022.md`：R29 冻结快照（168 行 / 23 条负控制），工具按 dev+ino 拒覆写；本页口径页只读它、不改它。
- `docs/verification/gy-i22-failmatrix-current-20261111.md`：**现行口径页**，读数是本页第 2 节那两组数。
- `docs/verification/gy-r90-open-issue-acceptance-index-20261109.md`：R90 快照索引页，第 170／450 行给 #22 的判据是「差证据 ← 缺证据页自陈不构成关闭声明」。**本页只取代「缺证据页」这一条**；索引页其余判断与其它 issue 行不动（快照页按规矩不回写）。

## 6. 复算与自检

```powershell
# 1) 矩阵与负控制（stub 臂，无需数据库）
node tests/failmatrix/run.mjs --json=tests/failmatrix/.artifacts/matrix.json
node tools/i22-failmatrix-negative-control.mjs --json=tests/failmatrix/.artifacts/negative-control.json

# 2) 文档与矩阵是否自洽（会逐条比对族／批次／总数／负控制数）
node tools/i22-failmatrix-evidence-table.mjs

# 3) 真库臂（需要 GY_PG_BIN 指向含 initdb / pg_ctl 的目录）
node tests/failmatrix/run-real.mjs --require-no-not-runnable --json=D:\tmp\real.json
```

矩阵条数只增不减：新增用例要同时改 `tests/unit/gy-i22-failmatrix.test.mjs` 的 `MIN_CASES`／`FAMILY_COUNTS`／`BATCH_COUNTS`，以及 `tools/i22-failmatrix-evidence-table.mjs` 的 `EXPECTED`；漏改任一处，`tests/unit/i22-evidence-table-expectation-sync.test.mjs` 与生成器会一起报红。

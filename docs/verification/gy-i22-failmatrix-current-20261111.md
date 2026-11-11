# 失败矩阵现行口径页（#22 · 269 条用例 + 27 条负控制）

**本页是「一次真跑的机读对账」，不是 #22 的收尾声明。** `#22` 的验收形态、剩余能力缺口与监工裁决
仍以 issue 与验收索引页为准；本页只回答四件事：用例表现在有多少条、每一条的读数是什么、负控制是否
真的会红、以及这些数字与工具里的口径是否对得上。

## 1 口径与生成方式

| 项 | 口径 |
| --- | --- |
| 用例条数 | `tests/failmatrix/run.mjs --json=<out>` 的 `rows.length`；269 = `cases.mjs` 249 + `seams.mjs` 20 |
| 分组 | 族（C1–C7、E1、E2、E3、C10、C11、F1、D1–D4）与批次（B1–B7），两者各自求和都必须等于 269 |
| 负控制 | `tools/i22-failmatrix-negative-control.mjs --json=<out>` 的 `MUTATIONS.length` = 27 |
| 写页 | `node tools/i22-failmatrix-evidence-table.mjs --write --page=docs/verification/gy-i22-failmatrix-current-20261111.md` |
| 只读对账 | `node tools/i22-failmatrix-evidence-table.mjs`（不写盘；对账不过 exit 1） |

两张表由机读结果渲染，**不要手改**：表内条数与工具里的 `EXPECTED` 不一致时，
`tests/unit/i22-evidence-table-expectation-sync.test.mjs` 会红；反向也一样——矩阵里出现 `EXPECTED`
没登记的族或批次，生成器直接判失败（这是 249 一路落后到 269 却全程静默的那条漏洞的补丁）。

R29 的归档快照 `gy-i22-failmatrix-20261022.md`（表格 168 行 / 负控制 23 条）是**时点记录**，生成器
拒绝覆写它：`--write` 没有隐式默认页，显式点名归档页时按文件身份（`dev` + `ino`）识别并拒绝。
本页是**另建**的现行口径页，不与那份快照竞争。

## 2 矩阵读数

<!-- BEGIN:MATRIX-TABLE -->
一次真跑：2026-11-11T12:40:09.630Z · node v24.19.0 · 基线 4452ce71f4 · 传输方式 `app.inject+trusted-seam`。

| 用例 id | 族 | 期望 | 实际读数（status · code · cache · etag） | #22 acceptance（自评） | 判定 |
| --- | --- | --- | --- | --- | --- |
| `C1-01` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-02` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-03` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-04` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-05` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-06` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-07` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-08` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-09` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-10` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-11` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-12` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-13` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-14` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-15` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-16` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-17` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-18` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-19` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-20` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-21` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-22` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-23` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-24` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-25` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-26` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-27` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-28` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-29` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-30` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-31` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-32` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-33` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-34` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-35` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-36` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C1-37` | C1 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC01 | PASS |
| `C2-01` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-02` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-03` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-04` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-05` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-06` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-07` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-08` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-09` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-10` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-11` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-12` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-13` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-14` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-15` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-16` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-17` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-18` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-19` | C2 | 200 | 200 · — · no-store · "1" | AC01/AC02 | PASS |
| `C2-20` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-21` | C2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC01/AC02 | PASS |
| `C2-22` | C2 | 200 | 200 · — · no-store · — | AC01/AC02 | PASS |
| `C2-23` | C2 | 200 | 200 · — · no-store · — | AC01/AC02 | PASS |
| `C2-24` | C2 | 200 | 200 · — · no-store · — | AC01/AC02 | PASS |
| `C3-01` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-02` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-03` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-04` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-05` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-06` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-07` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-08` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-09` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-10` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-11` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-12` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-13` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-14` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C3-15` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C3-16` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C3-17` | C3 | 200 | 200 · — · no-store · "1" | AC02/AC07 | PASS |
| `C3-18` | C3 | 428 REVISION_REQUIRED | 428 · REVISION_REQUIRED · no-store · — | AC02/AC07 | PASS |
| `C3-19` | C3 | 503 PROVIDER_UNAVAILABLE | 503 · PROVIDER_UNAVAILABLE · no-store · — | AC02/AC07 | PASS |
| `C3-20` | C3 | 503 PROVIDER_UNAVAILABLE | 503 · PROVIDER_UNAVAILABLE · no-store · — | AC02/AC07 | PASS |
| `C3-21` | C3 | 503 PROVIDER_UNAVAILABLE | 503 · PROVIDER_UNAVAILABLE · no-store · — | AC02/AC07 | PASS |
| `C3-22` | C3 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC02/AC07 | PASS |
| `C3-23` | C3 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC02/AC07 | PASS |
| `C3-24` | C3 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC02/AC07 | PASS |
| `C3-25` | C3 | 200 | 200 · — · no-store · "2" | AC02/AC07 | PASS |
| `C3-26` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C3-27` | C3 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC02/AC07 | PASS |
| `C3-28` | C3 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC02/AC07 | PASS |
| `C3-29` | C3 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC02/AC07 | PASS |
| `C3-30` | C3 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC02/AC07 | PASS |
| `C3-31` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C3-32` | C3 | 400 INVALID_CURSOR | 400 · INVALID_CURSOR · no-store · — | AC02/AC07 | PASS |
| `C3-33` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C3-34` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C3-35` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C3-36` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `C4-01` | C4 | 400 IDEMPOTENCY_KEY_REQUIRED | 400 · IDEMPOTENCY_KEY_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-02` | C4 | 200 | 200 · — · no-store · — | AC08/AC09 | PASS |
| `C4-03` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-04` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-05` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-06` | C4 | 403 ACCOUNT_INACTIVE | 403 · ACCOUNT_INACTIVE · no-store · — | AC08/AC09 | PASS |
| `C4-07` | C4 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-08` | C4 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-09` | C4 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-10` | C4 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC08/AC09 | PASS |
| `C4-11` | C4 | 400 IDEMPOTENCY_KEY_REQUIRED | 400 · IDEMPOTENCY_KEY_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-12` | C4 | 200 | 200 · — · no-store · "2" | AC08/AC09 | PASS |
| `C4-13` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-14` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-15` | C4 | 202 | 202 · — · no-store · "2" | AC08/AC09 | PASS |
| `C4-16` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-17` | C4 | 200 | 200 · — · no-store · "2" | AC08/AC09 | PASS |
| `C4-18` | C4 | 200 | 200 · — · no-store · — | AC08/AC09 | PASS |
| `C4-19` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-20` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-21` | C4 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC08/AC09 | PASS |
| `C4-22` | C4 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-23` | C4 | 400 IDEMPOTENCY_KEY_REQUIRED | 400 · IDEMPOTENCY_KEY_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-24` | C4 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC08/AC09 | PASS |
| `C4-25` | C4 | 200 | 200 · — · no-store · "3" | AC08/AC09 | PASS |
| `C4-26` | C4 | 409 OBJECT_UNAVAILABLE | 409 · OBJECT_UNAVAILABLE · no-store · — | AC08/AC09 | PASS |
| `C4-27` | C4 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-28` | C4 | 400 IDEMPOTENCY_KEY_REQUIRED | 400 · IDEMPOTENCY_KEY_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-29` | C4 | 428 REVISION_REQUIRED | 428 · REVISION_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-30` | C4 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC08/AC09 | PASS |
| `C4-31` | C4 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC08/AC09 | PASS |
| `C4-32` | C4 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-33` | C4 | 400 IDEMPOTENCY_KEY_REQUIRED | 400 · IDEMPOTENCY_KEY_REQUIRED · no-store · — | AC08/AC09 | PASS |
| `C4-34` | C4 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC08/AC09 | PASS |
| `C4-35` | C4 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC08/AC09 | PASS |
| `C4-36` | C4 | 503 PROVIDER_UNAVAILABLE | 503 · PROVIDER_UNAVAILABLE · no-store · — | AC08/AC09 | PASS |
| `C5-01` | C5 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC09/AC13 | PASS |
| `C5-02` | C5 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC09/AC13 | PASS |
| `C5-03` | C5 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC09/AC13 | PASS |
| `C5-04` | C5 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC09/AC13 | PASS |
| `C5-05` | C5 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC09/AC13 | PASS |
| `C5-06` | C5 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC09/AC13 | PASS |
| `C5-07` | C5 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC09/AC13 | PASS |
| `C5-08` | C5 | 200 | 200 · — · no-store · "2" | AC09/AC13 | PASS |
| `C5-09` | C5 | 200 | 200 · — · no-store · "2" | AC09/AC13 | PASS |
| `C5-10` | C5 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC09/AC13 | PASS |
| `C6-01` | C6 | 201 | 201 · — · no-store · "1" | AC16 | PASS |
| `C6-02` | C6 | 201 | 201 · — · no-store · "1" | AC16 | PASS |
| `C6-03` | C6 | 409 IDEMPOTENCY_CONFLICT | 409 · IDEMPOTENCY_CONFLICT · no-store · — | AC16 | PASS |
| `C6-04` | C6 | 400 IDEMPOTENCY_KEY_REQUIRED | 400 · IDEMPOTENCY_KEY_REQUIRED · no-store · — | AC16 | PASS |
| `C6-05` | C6 | 201 | 201 · — · no-store · "1" | AC16 | PASS |
| `C6-06` | C6 | 201 | 201 · — · no-store · "1" | AC16 | PASS |
| `C6-07` | C6 | 409 IDEMPOTENCY_CONFLICT | 409 · IDEMPOTENCY_CONFLICT · no-store · — | AC16 | PASS |
| `C6-08` | C6 | 201 | 201 · — · no-store · "1" | AC16 | PASS |
| `C6-09` | C6 | 201 | 201 · — · no-store · "1" | AC16 | PASS |
| `C6-10` | C6 | 201 |  · — · — · — | AC16 | PASS |
| `C6-11` | C6 | 428 REVISION_REQUIRED | 428 · REVISION_REQUIRED · no-store · — | AC16 | PASS |
| `C7-01` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-02` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-03` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-04` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-05` | C7 | 400 INVALID_CURSOR | 400 · INVALID_CURSOR · no-store · — | AC19 | PASS |
| `C7-06` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-07` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-08` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-09` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-10` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-11` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-12` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-13` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-14` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-15` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `C7-16` | C7 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC19 | PASS |
| `E1-01` | E1 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC21（F08 提示注入只作数据） | PASS |
| `E1-02` | E1 | 400 INVALID_REQUEST | 400 · INVALID_REQUEST · no-store · — | AC21（F08 提示注入只作数据） | PASS |
| `E1-03` | E1 | 201 | 201 · — · no-store · "1" | AC21（F08 提示注入只作数据） | PASS |
| `E2-01` | E2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC13/AC22（F20 媒体访问凭据） | PASS |
| `E2-02` | E2 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | AC13/AC22（F20 媒体访问凭据） | PASS |
| `E2-03` | E2 | 200 | 200 · — · no-store · "2" | AC13/AC22（F20 媒体访问凭据） | PASS |
| `C10-01` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-02` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-03` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-04` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-05` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-06` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-07` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-08` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-09` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-10` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-11` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-12` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-13` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-14` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-15` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-16` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-17` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-18` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-19` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-20` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-21` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-22` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C10-23` | C10 | 401 SESSION_REQUIRED | 401 · SESSION_REQUIRED · no-store · — | — | PASS |
| `C11-01` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-02` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-03` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-04` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-05` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-06` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-07` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-08` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-09` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-10` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-11` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-12` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-13` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-14` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-15` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-16` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-17` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-18` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-19` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-20` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-21` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-22` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-23` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-24` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-25` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-26` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-27` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-28` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-29` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-30` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-31` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-32` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-33` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-34` | C11 | 404 NOT_FOUND | 404 · NOT_FOUND · no-store · — | — | PASS |
| `C11-35` | C11 | 200 | 200 · — · no-store · "3" | — | PASS |
| `C11-36` | C11 | 200 | 200 · — · no-store · "1" | — | PASS |
| `C11-37` | C11 | 200 | 200 · — · no-store · "1" | — | PASS |
| `C11-38` | C11 | 200 | 200 · — · no-store · "1" | — | PASS |
| `C11-39` | C11 | 200 | 200 · — · no-store · "1" | — | PASS |
| `F1-01` | F1 | 200 | 200 · — · no-store · — | AC22（下架 ⇒ 消息引用跳转 unavailable，同形不泄露存在性） | PASS |
| `F1-02` | F1 | 200 | 200 · — · no-store · — | AC22（下架 ⇒ 消息引用跳转 unavailable，同形不泄露存在性） | PASS |
| `F1-03` | F1 | 200 | 200 · — · no-store · — | AC22（下架 ⇒ 消息引用跳转 unavailable，同形不泄露存在性） | PASS |
| `F1-04` | F1 | 200 | 200 · — · no-store · — | AC22（下架 ⇒ 消息引用跳转 unavailable，同形不泄露存在性） | PASS |
| `F1-05` | F1 | 200 | 200 · — · no-store · — | AC22（下架 ⇒ 消息引用跳转 unavailable，同形不泄露存在性） | PASS |
| `F1-06` | F1 | 200 | 200 · — · no-store · — | AC22（下架 ⇒ 消息引用跳转 unavailable，同形不泄露存在性） | PASS |
| `C5-11` | C5 | 415 MEDIA_TYPE_UNSUPPORTED | 415 · MEDIA_TYPE_UNSUPPORTED · no-store · — | AC09/AC13 | PASS |
| `C5-12` | C5 | 413 MEDIA_TOO_LARGE | 413 · MEDIA_TOO_LARGE · no-store · — | AC09/AC13 | PASS |
| `C6-12` | C6 | 422 INPUT_UNCERTAIN | 422 · INPUT_UNCERTAIN · no-store · — | AC16 | PASS |
| `E3-01` | E3 | 409 REVISION_CONFLICT | 409 · REVISION_CONFLICT · no-store · — | — | PASS |
| `E3-02` | E3 | 422 SOURCE_CONFLICT | 422 · SOURCE_CONFLICT · no-store · — | — | PASS |
| `C3-37` | C3 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC02/AC07 | PASS |
| `C3-38` | C3 | 401 SESSION_EXPIRED | 401 · SESSION_EXPIRED · no-store · — | AC02/AC07 | PASS |
| `C3-39` | C3 | 403 SCOPE_DENIED | 403 · SCOPE_DENIED · no-store · — | AC02/AC07 | PASS |
| `C3-40` | C3 | 200 | 200 · — · no-store · — | AC02/AC07 | PASS |
| `D1-01` | D1 | undefined CALLBACK_REPLAY |  · CALLBACK_REPLAY · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-02` | D1 | undefined CALLBACK_JOB_TERMINAL |  · CALLBACK_JOB_TERMINAL · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-03` | D1 | undefined CALLBACK_TARGET_WITHDRAWN |  · CALLBACK_TARGET_WITHDRAWN · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-04` | D1 | undefined CALLBACK_JOB_REVISION_STALE |  · CALLBACK_JOB_REVISION_STALE · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-05` | D1 | undefined CALLBACK_LEASE_MISMATCH |  · CALLBACK_LEASE_MISMATCH · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-06` | D1 | undefined CALLBACK_INPUT_DIGEST_MISMATCH |  · CALLBACK_INPUT_DIGEST_MISMATCH · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-07` | D1 | undefined CALLBACK_EXPIRED |  · CALLBACK_EXPIRED · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-08` | D1 | undefined CALLBACK_SIGNATURE_INVALID |  · CALLBACK_SIGNATURE_INVALID · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-09` | D1 | undefined CALLBACK_CONTROL_FIELD_FORBIDDEN |  · CALLBACK_CONTROL_FIELD_FORBIDDEN · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-10` | D1 | undefined CALLBACK_EPOCH_REVOKED |  · CALLBACK_EPOCH_REVOKED · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D1-11` | D1 | undefined OK |  · OK · — · — | AC23（F13 任务状态机：旧回调不复活） | PASS |
| `D2-01` | D2 | undefined PROVIDER_OUTCOME_UNKNOWN |  · PROVIDER_OUTCOME_UNKNOWN · — · — | AC21/AC23（F13/F20 AI 失败不得发布） | PASS |
| `D2-02` | D2 | undefined PROVIDER_TIMEOUT |  · PROVIDER_TIMEOUT · — · — | AC21/AC23（F13/F20 AI 失败不得发布） | PASS |
| `D2-03` | D2 | undefined PROVIDER_OUTCOME_UNKNOWN |  · PROVIDER_OUTCOME_UNKNOWN · — · — | AC21/AC23（F13/F20 AI 失败不得发布） | PASS |
| `D2-04` | D2 | undefined REJECTED_BY_RULES |  · REJECTED_BY_RULES · — · — | AC21/AC23（F13/F20 AI 失败不得发布） | PASS |
| `D3-01` | D3 | undefined WITHDRAWN_CACHE_INVALIDATED |  · WITHDRAWN_CACHE_INVALIDATED · — · — | AC22（G4 下架 ⇒ 缓存失效） | PASS |
| `D3-02` | D3 | undefined WITHDRAWN_IDEMPOTENT |  · WITHDRAWN_IDEMPOTENT · — · — | AC22（G4 下架 ⇒ 缓存失效） | PASS |
| `D4-01` | D4 | undefined NOT_SCREENED_NEW_REVISION |  · NOT_SCREENED_NEW_REVISION · — · — | AC22/AC29（内容版本变更 ⇒ 旧结论不复用） | PASS |
| `D4-02` | D4 | undefined REV2_PUBLISHED |  · REV2_PUBLISHED · — · — | AC22/AC29（内容版本变更 ⇒ 旧结论不复用） | PASS |
| `D4-03` | D4 | undefined SUPERSEDED_REFUSED |  · SUPERSEDED_REFUSED · — · — | AC22/AC29（内容版本变更 ⇒ 旧结论不复用） | PASS |
<!-- END:MATRIX-TABLE -->

## 3 负控制读数

<!-- BEGIN:NEGATIVE-CONTROL-TABLE -->
一次真跑：2026-11-11T12:37:37.463Z · node v24.19.0 · **合计 29 条：PASS 29 / FAIL 0**。

| 负控制 | 真改的那一处 | watch（必须真红） | sha256 改前（前 16 位） | 恢复后一致 | 判定 |
| --- | --- | --- | --- | --- | --- |
| `NC-01` 放宽「无凭据」守卫：SESSION_REQUIRED → SESSION_EXPIRED | `services/api/src/auth/middleware.ts` | C1-01, C1-02, C1-09, C1-16, C1-27, C1-35, C4-07, C4-08 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-02` 放宽「会话已撤销」：注销过的会话照样算活着 | `services/api/src/auth/middleware.ts` | C4-03, C4-04 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-03` 放宽「会话已过期」：过期会话照样算活着 | `services/api/src/auth/middleware.ts` | C4-05 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-04` 删掉「账号 epoch 变更」校验：旧会话不被踢 | `services/api/src/auth/middleware.ts` | C4-06 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-05` 删掉「后台接口不接受用户会话」：普通用户会话可以进后台 | `services/api/src/auth/middleware.ts` | C3-01, C3-02, C3-07 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-06` 删掉路由层 scope 校验：任何后台会话都能进「只看 middleware 那一层」的后台路由 | `services/api/src/auth/middleware.ts` | C3-12 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-06b` 删掉后台 scope 的双层校验（路由层 + 服务层各一行）：缺权限会话可以读后台 | `services/api/src/auth/middleware.ts` + `services/api/src/admin/identity.ts` | C3-09, C3-10, C3-11, C3-13 | middleware.ts=7d27f11e9cc3bde7…；identity.ts=faca9fd4c048fda3… | true | PASS |
| `NC-07` 删掉注销/注销申请路由的幂等键校验：缺键不再 400 | `services/api/src/routes/support.ts` | C4-01, C4-11 | support.ts=1614ae44331806e7… | true | PASS |
| `NC-07b` 删掉收藏面的幂等键校验（favorites/validate.ts）：缺键写收藏不再 400 | `services/api/src/favorites/validate.ts` | C6-04 | validate.ts=1bbeb193798b5471… | true | PASS |
| `NC-08` 放宽注销回执绑定：回执可以用在别人的注销单 id 上 | `services/api/src/routes/account-deletion.ts` | C4-14 | account-deletion.ts=58db9570d0168a43… | true | PASS |
| `NC-09` 删掉媒体归属校验：能读/删别人的媒体元数据 | `services/api/src/media/service.ts` | C2-01, C2-02 | service.ts=a0d41bbea7857ac9… | true | PASS |
| `NC-10` 删掉收藏列表的属主过滤：A 的列表会列出 B 的收藏 | `services/api/src/favorites/store.ts` | C2-22 | store.ts=f3c4adb9c1c3cefa… | true | PASS |
| `NC-11` 删掉历史列表的属主过滤：A 的列表会列出 B 的历史 | `services/api/src/history/store.ts` | C2-23 | store.ts=bd029665969a8f9a… | true | PASS |
| `NC-12` 删掉消息列表的属主过滤：A 的列表会列出 B 的消息 | `services/api/src/messages/store.ts` | C2-24 | store.ts=b60d92c5a74883b7… | true | PASS |
| `NC-13` 删掉回调回放守卫：同一 event_id 可以重复落定 | `services/api/src/moderation/service.ts` | D1-01 | service.ts=bc7ccea79e855164… | true | PASS |
| `NC-14` 删掉终态守卫：已 succeeded/cancelled 的任务还能被旧回调改写 | `services/api/src/moderation/service.ts` | D1-02 | service.ts=bc7ccea79e855164… | true | PASS |
| `NC-15` 删掉下架守卫：下架对象会被旧回调复活 | `services/api/src/moderation/service.ts` | D1-03 | service.ts=bc7ccea79e855164… | true | PASS |
| `NC-16` 删掉输入摘要比对：换内容不换版本的回调会被接受（#421 的复发形态） | `services/api/src/moderation/service.ts` | D1-06 | service.ts=bc7ccea79e855164… | true | PASS |
| `NC-17` 删掉「规则层否决 ⇒ 直接 rejected」分支：规则说不行而模型说 pass 也能通过 | `services/api/src/moderation/decisions.ts` | D2-04 | decisions.ts=6d90b07cdec0e3a2… | true | PASS |
| `NC-18` 删掉读缓存按目标失效：下架后旧可见性继续被缓存返回 | `services/api/src/moderation/visibility.ts` | D3-01 | visibility.ts=75ec341b8429bdc3… | true | PASS |
| `NC-19` 命中阻断级规则也不再判 rejected（把 block 当提示）：注入内容照样发布 | `packages/moderation/engine.mjs` | E1-01, E1-02 | engine.mjs=9f8785c2303fa126… | true | PASS |
| `NC-20` 删掉「未筛查 ⇒ 拒发」的分级：改版内容没审过也能走发布 | `services/api/src/moderation/service.ts` | D4-01 | service.ts=bc7ccea79e855164… | true | PASS |
| `NC-21` 删掉「版本已被推进」守卫：内容改版后还能把历史版本写成 published | `services/api/src/moderation/service.ts` | D4-03 | service.ts=bc7ccea79e855164… | true | PASS |
| `NC-22` me/exports：放松「账本读面解析失败」的 fail-closed（折成 503 → 原始错误直接抛给调用方） | `services/api/src/privacy/exports-list.ts` |  | exports-list.ts=65dfc495c3c3014b… | true | PASS |
| `NC-23` public/home：删掉语句超时单独分级（504 PROVIDER_TIMEOUT 退化成 503） | `services/api/src/db/catalog.ts` |  | catalog.ts=3fd779cc9be18f7b… | true | PASS |
| `NC-24` registrations/verify：非 matched 不再 fail-closed 成 4xx（登记校验结论退化成 500） | `services/api/src/knowledge/applicability-screen.ts` |  | applicability-screen.ts=45cad9090813c2f2… | true | PASS |
| `NC-25` consents：删掉隐私政策读面的 requireUser（游客也能读 /me/privacy-policy） | `services/api/src/routes/consents.ts` |  | consents.ts=a11a50ff6c46616d… | true | PASS |
| `NC-26` auth：会话令牌改成「去掉尾字符再查」——篡改后的令牌仍算命中 | `services/api/src/auth/middleware.ts` | C3-38 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-27` auth：scope 改成「请求头能自称」——x-admin-scopes 同时覆盖路由门与服务层身份 | `services/api/src/auth/middleware.ts` + `services/api/src/routes/admin.ts` | C3-39 | middleware.ts=7d27f11e9cc3bde7…；admin.ts=eaa41d6355c7cf91… | true | PASS |
<!-- END:NEGATIVE-CONTROL-TABLE -->

## 4 本页能证明什么

- 269 条用例在**一次真跑**里全部 PASS，且每条都有真实读数（status / code / cache / etag 至少一项是
  服务端真实返回值，不是期望值回填）。
- 27 条负控制全部按设计**真红**：每条都改一处代码、跑一次、看到 watch 命中，再恢复并核对 sha256 一致。
  也就是说这些 PASS 不是「断言写松了」写出来的。
- 条数与工具内 `EXPECTED` 逐族、逐批次、正反两个方向都对得上；`unit-tests` 里有测试把它钉住，
  所以「删用例让矩阵变绿」这条路会红。

## 5 本页不能证明什么（剩余缺口）

本页只覆盖失败矩阵这一层。以下按能力列出**仍未取得**的部分，任何一条都不因本页而闭合：

1. **真库臂只跑权限面六族**（C1–C4、C10、C11 共 180 条）。C5/C6/C7/E1/E2/E3/F1 与 D 族共约 89 条
   只在合成装配下跑过，没有在真实 PostgreSQL 上逐条验过。
2. **注销冷静期到期后的真实清理执行面**（在线 7 日 / 备份 30 日）只覆盖到「申请 → 回执 → 冷静期内
   原会话仍可用」，到期后的清理动作本身没有端到端读数。
3. **real 装配下 media / 社区投稿 / 异步 AI 作业 fail-closed**（对象存储与真实供应商未接线）⇒
   没有属主行可播种，这几族在真库臂里如实记 `not-runnable`，不是 PASS。
4. **带图发帖在 stub 下被判 `INPUT_UNCERTAIN`**（`decision=quarantined`）⇒ 社区媒体授权全链路的
   正路走不通，矩阵只覆盖到它前面的 400/404。
5. **收藏引用跳转到来源撤回**需要知识公开读面，stub 侧没有该读面 ⇒ 端到端未取得；消息域的引用跳转
   已由 F1 族覆盖。
6. **第三方删除适配器未装配进 `services/api/src/app.ts`** ⇒ 外部删除状态只有真库手跑臂与保留阻塞的
   单元证据，没有走主流程的读数。
7. **AC ↔ 用例的映射仍是族级自评**（见第 2 节「#22 acceptance（自评）」列）——它说明「这一族的失败面
   大致对应哪条验收」，不是逐条 AC 的验收结论，最终由监工裁决。

## 6 与其它证据页的关系

| 页 | 关系 |
| --- | --- |
| `gy-i22-failmatrix-20261022.md` | R29 建页时点的冻结快照（168 行 / 23 条），只增不改 |
| `gy-i22-closure-gap-20261018.md` | 真库臂最小权限与账号停用面的实测与未取得清单 |
| `tests/failmatrix/README.md` | 族/批次/负控制的机器口径与判决条件 |
| `gy-r90-open-issue-acceptance-index-20261109.md` | #22 的「差证据」状态与不该关的理由 |

本页的读数会随用例表增长而重生成：新增族或批次必须同时抬 `tests/unit/gy-i22-failmatrix.test.mjs` 的
`MIN_CASES`/`FAMILY_COUNTS`/`BATCH_COUNTS`、工具里的 `EXPECTED`，以及本页表格。

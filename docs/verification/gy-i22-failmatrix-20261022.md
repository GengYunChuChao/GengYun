# GY-I22（#22）失败回归矩阵 · 可执行骨架与 168 条真读数用例

- **分支**：`test/gy-r29-i22-failmatrix`（基线 `origin/main` = `a2ab0d9aff391a199142699038b01eda2f74d497`；PR #423）
- **时间**：2026-10-22（Asia/Hong_Kong）· node v24.16.0 · `execution_mode=stub` · 传输 = 进程内 `app.inject` + 受信审核 seam
- **命令**：`node tests/failmatrix/run.mjs`、`node tools/i22-failmatrix-negative-control.mjs`、
  `node --test tests/unit/gy-i22-failmatrix.test.mjs`
- **本页只记真实读数**。本片**不宣称 #22 完成**：交付的是可重复运行的骨架 + 168 条用例 + 23 条负控制；
  「真实 AI 外呼、真机、微信端到端、真实对象存储签名过期、断网重试、账号停用、注销到期清理」仍记未取得（§8）。

## 1 交付物

| 文件 | 说明 |
| --- | --- |
| `tests/failmatrix/world.mjs`（256 行） | 世界装配：内存 auth/业务 store + 替身对象存储 + 合成审核端口（四个网络 seam 持有即抛错） |
| `tests/failmatrix/cases.mjs`（282 行） | HTTP 用例表：C1–C7 + E1/E2 共 150 条，字段 = `id/method/path/headers/body/expect{status,code,etag}/check/sameShapeAs/concurrent` |
| `tests/failmatrix/seams.mjs`（589 行） | 受信 seam 用例表：D1–D4 共 18 条（审核回调 / AI 失败 / 下架缓存 / 版本回写） |
| `tests/failmatrix/run.mjs`（446 行） | 表驱动 runner：状态码/错误码 + 四条拒绝不变量 + 同形对照 + 按族/批次汇总 + `--only/--json/--list` |
| `tests/failmatrix/mutations.mjs`（216 行） | 23 条负控制清单（逐字 `find`，要求恰好命中一次） |
| `tools/i22-failmatrix-negative-control.mjs`（199 行） | 负控制执行器：sha256 → 真改 → watch 必须全红 → **原始字节**恢复 → sha256 复核 → 复跑必须全绿 |
| `tools/i22-failmatrix-evidence-table.mjs`（167 行） | 证据表生成器：读机读结果生成 §4/§5 的三列表，条数不符即失败 |
| `tests/unit/gy-i22-failmatrix.test.mjs`（150 行） | CI 入口：真跑全矩阵断言 `FAIL 0`/条数 ≥168 + 负控制清单与产品代码同步的静态检查 |
| `tests/failmatrix/README.md` | 用法、为什么用 `inject`、每族覆盖、负控制挑法、未取得清单 |

为什么用进程内 `app.inject` 而不是 loopback HTTP：每条用例要零端口、零外呼、可复现到行；`inject` 走完整
Fastify 生命周期（`onRequest` → schema → `preHandler` → 处理器 → `onSend`），与 loopback 只差 TCP 编解码。
**代价**：不覆盖反向代理、真实 TLS、真实 body 上限与真实网络超时（记入 §8）。

## 2 矩阵读数（168 条，全绿）

```
node tests/failmatrix/run.mjs
矩阵合计 168 条：PASS 168 / FAIL 0
```

| 族 | 条数 | 读数 | 覆盖 |
| --- | --- | --- | --- |
| C1 游客面 | 37 | PASS 37 / FAIL 0 | 无凭据一律 `401 SESSION_REQUIRED`（不是 403/404/500），且带 `no-store` |
| C2 越权（IDOR） | 24 | PASS 24 / FAIL 0 | A 读写 B 的私有行一律 `404`，与「不存在」同形；列表隔离；公开内容不误拦 |
| C3 后台 | 27 | PASS 27 / FAIL 0 | 用户会话 `403 SCOPE_DENIED`；缺 scope `403`；有 scope 2xx；未接线面 `503` |
| C4 会话与注销 | 18 | PASS 18 / FAIL 0 | 注销/过期/旧 epoch/坏凭据的拒绝码；注销回执的绑定、换发与重放 |
| C5 媒体归属与访问凭据 | 10 | PASS 10 / FAIL 0 | 跨主体 `404`、缺/错 token、属主 token 不得越权读社区内容 |
| C6 重复请求 | 10 | PASS 10 / FAIL 0 | 同键同体重放同一行、同键异体 `409`、缺键 `400`、并发只产生一行 |
| C7 无效输入 | 16 | PASS 16 / FAIL 0 | 坏 uuid / 坏游标 / 越界分页 / 多余字段 → `400`（含 `INVALID_CURSOR`） |
| E1 提示注入 | 3 | PASS 3 / FAIL 0 | 标题/评论里的指令只作数据：命中 `PROMPT_INJECTION` ⇒ `400`；干净文本 `201` |
| E2 媒体访问凭据 | 3 | PASS 3 / FAIL 0 | 篡改/越权 token 一律 `404`（与不存在同形，不泄露对象存在性） |
| D1 审核回调 | 11 | PASS 11 / FAIL 0 | 重复/旧版本/旧租约/摘要不符/过期/坏签名/控制字段/撤权/下架 ⇒ 拒绝；回调绝不发布 |
| D2 AI 失败 | 4 | PASS 4 / FAIL 0 | 端口抛错/超时/结构未知/PII 未过 ⇒ 任务 `quarantined`、`publishable:false` |
| D3 下架缓存 | 2 | PASS 2 / FAIL 0 | 下架 ⇒ 读缓存键失效 + 可见性 `hidden`；二次下架幂等 |
| D4 版本回写 | 3 | PASS 3 / FAIL 0 | 改版后未筛查 ⇒ `INPUT_UNCERTAIN`；已筛查 ⇒ 可发布；历史版本 ⇒ `REVISION_CONFLICT` |

批次（`BATCHES`）：**B1**（C1–C4，身份与权限面）106 条 · **B2**（C5–C7，媒体归属/重复请求/无效输入）36 条 ·
**B3**（D1–D3，受信 seam：回调/AI 失败/下架缓存）17 条 · **B4**（D4/E1/E2，版本回写/提示注入/媒体凭据）9 条。

代表性逐条读数（原文取自 `--json` 机读结果，拒绝响应 `cache` 列全部为 `no-store`）：

| 用例 | 请求 | 实际读数 | 断言 |
| --- | --- | --- | --- |
| C1-01 | `GET /api/v1/favorites`（游客） | `401 SESSION_REQUIRED` | 游客一律 401，不是 403/404/500 |
| C2-01 / C2-11 | A 读 B 的媒体 / A 读不存在的媒体 | `404 NOT_FOUND` / `404 NOT_FOUND` | 跨主体与「不存在」同形（`sameShapeAs`） |
| C2-19 | A 读 B 的公开帖子 | `200` | **反向控制**：不得过度拦截公开内容 |
| C3-01 | 用户会话读后台 | `403 SCOPE_DENIED` | 后台不接受用户会话 |
| C3-19 | 全 scope 读账号列表 | `503 PROVIDER_UNAVAILABLE` | 账号读写权威未接线 → fail-closed |
| C4-03 | 注销后旧会话读收藏 | `401 SESSION_EXPIRED` | 注销立刻作废旧会话 |
| C4-14 | 回执跨单使用 | `401 SESSION_EXPIRED` | 回执绑定注销单 id |
| C6-10 | 并发两发同键写收藏 | `201` + `201`，同一 `id` | 并发只产生一行 |
| C7-05 | `cursor=%25%25%25` | `400 INVALID_CURSOR` | 游标非法单独成码 |
| E1-01 | 标题塞「忽略以上指令…」 | `400 INVALID_REQUEST`，`details` = `PROMPT_INJECTION` + `NOT_PUBLISHABLE` | 注入只作数据，不改变审核策略 |
| E2-01 | 属主 token 读社区媒体 | `404 NOT_FOUND` | 凭据不得越权（与不存在同形） |
| D4-01 | 改版后未筛查就发布 | `INPUT_UNCERTAIN`（`NOT_SCREENED:text`） | 旧审核结论不得复用 |
| D4-03 | 内容已推进到 rev2 时发布 rev1 | `REVISION_CONFLICT`（`REVISION_SUPERSEDED:2:1`） | 历史版本不得发布 |
| D2-01 | 模型端口抛错 | `PROVIDER_OUTCOME_UNKNOWN` + `MODEL_PORT_ERROR`，`publishable:false` | AI 失败不得发布 |

## 3 用例三列表（id → #22 acceptance → 实际读数）

下表由 `tools/i22-failmatrix-evidence-table.mjs` 从一次真跑的 `--json` 结果生成（重跑即复核）：
`node tests/failmatrix/run.mjs --json=tests/failmatrix/.artifacts/matrix.json && node tools/i22-failmatrix-evidence-table.mjs --write`。
`#22 acceptance` 列是**片内自评映射**（AC 编号取自 `docs/initial-issues.json` 的 GY-I22 acceptance_ids），最终由监工裁决。

<!-- BEGIN:MATRIX-TABLE -->
一次真跑：2026-10-21T19:13:51.755Z · node v24.16.0 · 基线 a515503976 · 传输方式 `app.inject+trusted-seam`。

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

## 4 负控制（23 条，全部 PASS：真红 → 原字节恢复 → 复跑绿）

`node tools/i22-failmatrix-negative-control.mjs` → `负控制合计 23 条：PASS 23 / FAIL 0`。
每条都是**真改一处**（NC-06b 因守卫分两层，两处各一行；其余均单文件一处），跑完用**原始字节**写回，
sha256 与改前逐字节一致，再复跑同一组 watch 必须全绿。

<!-- BEGIN:NEGATIVE-CONTROL-TABLE -->
一次真跑：2026-10-21T19:13:05.384Z · node v24.16.0 · **合计 23 条：PASS 23 / FAIL 0**。

| 负控制 | 真改的那一处 | watch（必须真红） | sha256 改前（前 16 位） | 恢复后一致 | 判定 |
| --- | --- | --- | --- | --- | --- |
| `NC-01` 放宽「无凭据」守卫：SESSION_REQUIRED → SESSION_EXPIRED | `services/api/src/auth/middleware.ts` | C1-01, C1-02, C1-09, C1-16, C1-27, C1-35, C4-07, C4-08 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-02` 放宽「会话已撤销」：注销过的会话照样算活着 | `services/api/src/auth/middleware.ts` | C4-03, C4-04 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-03` 放宽「会话已过期」：过期会话照样算活着 | `services/api/src/auth/middleware.ts` | C4-05 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-04` 删掉「账号 epoch 变更」校验：旧会话不被踢 | `services/api/src/auth/middleware.ts` | C4-06 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-05` 删掉「后台接口不接受用户会话」：普通用户会话可以进后台 | `services/api/src/auth/middleware.ts` | C3-01, C3-02, C3-07 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-06` 删掉路由层 scope 校验：任何后台会话都能进「只看 middleware 那一层」的后台路由 | `services/api/src/auth/middleware.ts` | C3-12 | middleware.ts=7d27f11e9cc3bde7… | true | PASS |
| `NC-06b` 删掉后台 scope 的双层校验（路由层 + 服务层各一行）：缺权限会话可以读后台 | `services/api/src/auth/middleware.ts` + `services/api/src/admin/identity.ts` | C3-09, C3-10, C3-11, C3-13 | middleware.ts=7d27f11e9cc3bde7…；identity.ts=b31c0bd030233385… | true | PASS |
| `NC-07` 删掉注销/注销申请路由的幂等键校验：缺键不再 400 | `services/api/src/routes/support.ts` | C4-01, C4-11 | support.ts=1614ae44331806e7… | true | PASS |
| `NC-07b` 删掉收藏面的幂等键校验（favorites/validate.ts）：缺键写收藏不再 400 | `services/api/src/favorites/validate.ts` | C6-04 | validate.ts=55fd2c9a8d9c361d… | true | PASS |
| `NC-08` 放宽注销回执绑定：回执可以用在别人的注销单 id 上 | `services/api/src/routes/account-deletion.ts` | C4-14 | account-deletion.ts=41c003931f07203e… | true | PASS |
| `NC-09` 删掉媒体归属校验：能读/删别人的媒体元数据 | `services/api/src/media/service.ts` | C2-01, C2-02 | service.ts=90a7146f814677b9… | true | PASS |
| `NC-10` 删掉收藏列表的属主过滤：A 的列表会列出 B 的收藏 | `services/api/src/favorites/store.ts` | C2-22 | store.ts=33e9a5413ddb2bea… | true | PASS |
| `NC-11` 删掉历史列表的属主过滤：A 的列表会列出 B 的历史 | `services/api/src/history/store.ts` | C2-23 | store.ts=5eb0d8600878b7b4… | true | PASS |
| `NC-12` 删掉消息列表的属主过滤：A 的列表会列出 B 的消息 | `services/api/src/messages/store.ts` | C2-24 | store.ts=ead31a22a3b2566c… | true | PASS |
| `NC-13` 删掉回调回放守卫：同一 event_id 可以重复落定 | `services/api/src/moderation/service.ts` | D1-01 | service.ts=ca70786f4a2891b4… | true | PASS |
| `NC-14` 删掉终态守卫：已 succeeded/cancelled 的任务还能被旧回调改写 | `services/api/src/moderation/service.ts` | D1-02 | service.ts=ca70786f4a2891b4… | true | PASS |
| `NC-15` 删掉下架守卫：下架对象会被旧回调复活 | `services/api/src/moderation/service.ts` | D1-03 | service.ts=ca70786f4a2891b4… | true | PASS |
| `NC-16` 删掉输入摘要比对：换内容不换版本的回调会被接受（#421 的复发形态） | `services/api/src/moderation/service.ts` | D1-06 | service.ts=ca70786f4a2891b4… | true | PASS |
| `NC-17` 删掉「规则层否决 ⇒ 直接 rejected」分支：规则说不行而模型说 pass 也能通过 | `services/api/src/moderation/decisions.ts` | D2-04 | decisions.ts=a4caf607fc7d6595… | true | PASS |
| `NC-18` 删掉读缓存按目标失效：下架后旧可见性继续被缓存返回 | `services/api/src/moderation/visibility.ts` | D3-01 | visibility.ts=75ec341b8429bdc3… | true | PASS |
| `NC-19` 命中阻断级规则也不再判 rejected（把 block 当提示）：注入内容照样发布 | `packages/moderation/engine.mjs` | E1-01, E1-02 | engine.mjs=9f8785c2303fa126… | true | PASS |
| `NC-20` 删掉「未筛查 ⇒ 拒发」的分级：改版内容没审过也能走发布 | `services/api/src/moderation/service.ts` | D4-01 | service.ts=ca70786f4a2891b4… | true | PASS |
| `NC-21` 删掉「版本已被推进」守卫：内容改版后还能把历史版本写成 published | `services/api/src/moderation/service.ts` | D4-03 | service.ts=ca70786f4a2891b4… | true | PASS |
<!-- END:NEGATIVE-CONTROL-TABLE -->

### 4.1 真红原文（执行器原样输出，逐字照抄）

```
NC-01 C1-01 GET /api/v1/favorites → 实际 {"status":401,"code":"SESSION_EXPIRED","cache":"no-store","etag":null}：
      status 期望 401 实际 401；error.code 期望 SESSION_REQUIRED 实际 SESSION_EXPIRED

NC-09 C2-01 GET /api/v1/media/… → 实际 {"status":200,"code":null,"cache":"no-store","etag":"\"2\""}：
      status 期望 404 实际 200；期望错误封套 NOT_FOUND，实际没有 error：{"data":{"id":"def66837-…","revision":2,…}；
      拒绝响应里带了 data（失败必须是纯封套）

NC-10 C2-22 GET /api/v1/favorites?limit=50 → 实际 {"status":200,…,items 含 B 的收藏行}：
      A 的收藏列表里出现了 B 的收藏行（跨主体列表泄露）

NC-18 D3-01 → 实际 {"code":"WITHDRAWN_CACHE_NOT_INVALIDATED","cache_size":1}：
      code 期望 WITHDRAWN（缓存已失效）实际 WITHDRAWN_CACHE_NOT_INVALIDATED

NC-19 E1-01 POST /api/v1/posts → 实际 {"status":422,"code":"INPUT_UNCERTAIN",…}：
      status 期望 400 实际 422；error.code 期望 INVALID_REQUEST 实际 INPUT_UNCERTAIN
      （注：注入内容没直接发布成功，但拿到了「进入人工复核」的 422，与「硬规则直接拒绝」不是一回事）

NC-20 D4-01 → 实际 {"code":"UNEXPECTED_REVISION_CONFLICT"}，details=[{"field":"reason_codes","code":"NOT_SCREENED:text"}]：
      code 期望 INPUT_UNCERTAIN 实际 UNEXPECTED_REVISION_CONFLICT（分级退化）

NC-21 D4-03 → 实际 {"code":"UNEXPECTED_REVISION_CONFLICT"}，details=[]，view_visibility=private：
      code 期望 SUPERSEDED_REFUSED 实际 UNEXPECTED_REVISION_CONFLICT（拒绝理由消失）
```

**恢复后逐字节一致**：以下 13 个被临时改过的文件全部与 `origin/main` 相同
（`git diff origin/main -- services packages` = 0 行），当前 sha256：

```
7d27f11e9cc3bde7c7b33198ecfbb4b8dc7845b4a1e76cc96652542c204bb2c9  services/api/src/auth/middleware.ts
b31c0bd030233385311cc7b4a9279dee5dc40c1b2d884d4ff7d06042f6215880  services/api/src/admin/identity.ts
1614ae44331806e7b2d4640197ff181e7bd963e5bcfa045dc2522ebfd1f26b8e  services/api/src/routes/support.ts
55fd2c9a8d9c361d0ac5b6e44803f1b90a5ff9bcfb1a5a8f30d9e4ba8c92b9d1  services/api/src/favorites/validate.ts
41c003931f07203e27831f3ab14a619f5c84df71251346c76664d9fad6b38550  services/api/src/routes/account-deletion.ts
90a7146f814677b924a01be7b26984f89a891abe8b899bd519c45a87d558ef93  services/api/src/media/service.ts
33e9a5413ddb2beaefe362c9f4ef37a0b77a0a2c09aa8f095815b65f918f02f3  services/api/src/favorites/store.ts
5eb0d8600878b7b472a49d3cf1b3bddeb4bcb6f1325b1b967d9601c0214ff3d4  services/api/src/history/store.ts
ead31a22a3b2566c9074abf376f2762907c7bbdb0d65a59f85fd6b326deabe4b  services/api/src/messages/store.ts
ca70786f4a2891b4a47ccc9b0e1e0f54571c2197114a5ed03089886bc7c68386  services/api/src/moderation/service.ts
a4caf607fc7d6595706c2a801c5a6c597ee132a0b725a203144263a55e4693b1  services/api/src/moderation/decisions.ts
75ec341b8429bdc375eceac2784729c6e2a0aa5da29508dd3deea612c324821b  services/api/src/moderation/visibility.ts
9f8785c2303fa126c5d2e60d84fe8e91f163866e2d25d95c64256661b7ca5b03  packages/moderation/engine.mjs
```

### 4.2 夹具自检（证明这套矩阵自己会红，而不是只会绿）

首跑时「全 scope」后台账号漏了 `audit:read`、`session:read` 两个 scope，`C3-15`/`C3-17`/`C3-26` 当场真红。
为把这条留成可复现的证据，本轮又做了一次**夹具负控制**（改测试夹具一行，不改产品代码）：从
`tests/failmatrix/run.mjs` 的 `ALL_SCOPES` 临时删掉 `'audit:read',` 后单跑 C3-15：

```
  FAIL C3-15  GET    /api/v1/admin/audit-events → 403 SCOPE_DENIED · cache=no-store etag=-
       ✗ status 期望 200 实际 403
       ✗ 期望成功，实际 error=SCOPE_DENIED（缺少所需权限：audit:read）
```

恢复后 `run.mjs` 与改前**字节相同**（sha256 `c2b3c67ba195b5eefd7b87164b219e75e0422a2e4d7241af566c7187aef1f07e`），
单跑 C3-15 回到 `PASS`。结论：**这套矩阵有红的能力**，不是「只绿不红」的同形测试。

### 4.3 四条负控制挑法的实测依据（写进 README，避免后来者误判）

1. **收藏/历史/消息的 IDOR 删除，单改 service 一行不会变红**：service 判属主后，内存 store 的
   `remove()`/`deleteHistory()` 又按 `owner_id` 复核一次，`commitRefusal` 映射回同一个 `404`，用例仍绿。
   代表性负控制因此落在**列表隔离**（store 的 `list*` 过滤，NC-10/11/12）与**媒体归属**（`ownedRecord`，NC-09）。
2. **后台 scope 是两层**：`routes/admin.ts` 的 `guards.requireScope(...)` 与 `admin/identity.ts:49
   requireAdminScope` 各判一次。单独去掉任一层，缺权限会话仍被另一层挡成 403（NC-06 首版 watch 4 条只有 1 条
   变红即此因），故 `NC-06b` 是「两层各删一行」。
3. **规则严重级不能直接改**：把 `packages/moderation/rules.mjs:145` 的 `severity: 'block'` 改成 `'warn'` 会让
   规则目录自校验抛 `RULE_CATALOG_INVALID`（`packages/moderation/constants.mjs:127` 的 `RULE_SEVERITIES` 只允许
   `['block']`），矩阵在播种阶段就崩（`exit 2`，无机读结果）。NC-19 因此改锚**判定引擎那一行**
   （`packages/moderation/engine.mjs:421`），这也是一条真实性质：**规则目录是冻结的，改严重级不是「一行」**。
4. **`REVISION_SUPERSEDED` 有两处兜底**：删掉 `moderation/service.ts:797-799`（NC-21）后发布**没有真的发生**，
   只是拒绝理由从 `REVISION_SUPERSEDED:2:1` 退化成 `REVISION_CONFLICT`（第二层在 `moderation/visibility.ts:280-281`
   的 `deny(snapshot.visibility, 'REVISION_SUPERSEDED')`）。所以 NC-21 证明的是「可解释的拒绝理由由这一行给出」，
   不是「删了就能发布」——如实记账，不许升级成更强的结论。

## 5 真扫：在 `origin/main` 上真红的项 = **0 条**

对 168 条矩阵在 `a2ab0d9` 上完整真扫：**0 条真红**，即本片覆盖范围内没有发现新的、可直接复现的严重安全/权限缺陷。
不把它写成「没问题」的地方，按事实列在这里：

1. 首跑那 3 条红（C3-15/C3-17/C3-26）是**我自己的夹具漏 scope**，不是产品缺陷；已修并留了 §4.2 的复现证据。
2. `C3-19/C3-20/C3-21` 把「账号/作业面未接线 → `503 PROVIDER_UNAVAILABLE`」钉成**期望值**（fail-closed）。
   这与 #22 前轮「后台账号能力脱钩方向更保守」的裁定一致；一旦这些面接线，这三条会**先红**，提醒后续批次改期望
   而不是悄悄跳过。
3. `POST /favorites` 指向不存在的 species/herbicide 返回 `201` + `reference_state: 'unavailable'` 是**设计**
   （收藏可指向已下架目标），不是缺陷；矩阵按实跑读数钉住，避免后人误判成 bug。
4. `NC-08` 证明「回执跨单使用」在负控制里落到 `404`（回执不再绑定 → 目标不存在），与 `C4-14` 期望的 `401`
   不同码——这是**负控制真红**的表现，产品本身仍是 `401`。

## 6 与禁改清单的关系

- 未改 `services/api/src/app.ts`、`config.ts`、`tts/*`、`speech/*`、`ocr/*`、
  `tests/unit/sql-column-coverage.test.mjs`、`deploy/postgres-cvm/*`、`docs/verification/gy-r29-*`、
  `tests/integration/online-purge-pg.mjs`。
- 未改 `docs/architecture/contract-status.json`（`status` 与 `lines` 均未动）；产品代码
  `git diff origin/main -- services packages` = 0 行（负控制临时改动全部按原始字节恢复）。
- 未改 issue 状态、未 merge、未 push main。

## 7 P0/P1/P2 对照（父代理派单 → 本片事实）

| 派单 | 本片交付 | 读数位置 |
| --- | --- | --- |
| P0① AI 失败/超时/结构错误 ⇒ 内容不得发布 | D2 四条：端口抛错 / `TimeoutError` / `label:'maybe'` / 规则未过 | §2、§3 |
| P0② 重复回调 / 在途取消（#421 复发形态） | D1 十一条：回放、终态、旧版本、旧租约、摘要不符、过期、坏签名、控制字段、撤权、下架 | §2、§3 |
| P0③ 下架/驳回 ⇒ 缓存失效 + 消息跳转 | D3 两条：缓存键失效 + `hidden`；二次下架幂等 | §2、§3 |
| P1④ 版本回写（旧审核结论不得复用） | D4 三条：未筛查拒发 / 已筛查可发 / 历史版本拒发 | §2、§3 |
| P1⑤ 提示注入（标题/评论塞指令） | E1 三条：标题 400、评论 400、干净对照 201 | §2、§3 |
| P1⑥ 上传签名（过期/篡改/越权 scope） | E2 三条：篡改 token 404、越权 token 404、属主申请 200（含 `expires_at`） | §2、§3 |
| P2⑦ 真实 AI 外呼 / 真机 / 微信端到端 | **未取得**，见 §8 | — |

补充：「在途取消（`REQUEST_IN_PROGRESS` 409）」在 stub 世界仍**未取得**（内存台账太快，并发同键落到重放同一行）；
「任务取消」本身由 C3-20（`/admin/jobs` 未接线 503）与 D1-02（终态不复活）间接钉住，但**不是**在途取消的真证据。

## 8 未取得（一律不许当成绿）

| 条目 | 状态 |
| --- | --- |
| 真实 AI 外呼（真实供应商的失败/超时/配额/结构漂移） | **未取得**：D2 用替身端口注入失败，**不是**真实外呼 |
| 真机、微信端到端（`POST /auth/wechat` 真实换会话、真机上传/预览） | **未取得** |
| 真实对象存储与上传签名过期/篡改（服务端签名密钥轮换） | **未取得**：E2 覆盖的是**访问凭据**（`X-Media-Access-Token`）篡改/越权，不是对象存储的预签名 URL |
| 真实网络失败（断网、半开连接、重试退避）与反向代理/TLS | **未取得**：`inject` 不经过网络栈 |
| 账号被停用（`users.state !== 'active'`）真实生效 | **未取得**：stub 无账号写权威；仅覆盖 fail-closed 503（C3-19/20/21） |
| 注销冷静期到期后的真实清理（在线 7 日 / 备份 30 日执行面） | **未取得**：仅覆盖申请→回执→冷静期内原会话可用→回执换发/重放 |
| 在途取消（`REQUEST_IN_PROGRESS` 409）与「注销-撤回」 | **未取得**：内存台账太快，未出现 409；契约无 cancel-deletion 入口 |
| 社区媒体授权全链路（帖子带附件 → 访客申请 → 拿 grant → 读内容） | **未取得**：stub 下带媒体发帖被内容筛查判 `422 INPUT_UNCERTAIN`（`decision=quarantined`），正路走不通，只能覆盖其前的 `400/404` 分支（C5） |
| 消息与收藏的引用跳转（内容下架后 UI 跳 `unavailable`） | **未取得**：本片只到接口层（下架后 A 读帖 `404`，D3 缓存 `hidden`），未验证端上跳转 |
| 外部删除状态（第三侧删除后的同步） | **未取得**：仓内无该能力接线 |
| 真实 PG 下的同一矩阵（`real-pg-17.11` 已跑但**不跑本矩阵**） | **未取得**：本矩阵固定 `execution_mode=stub`，内存 store 与 PG store 的行为差异未验 |

## 9 事实 vs 派单

| 派单要求 | 事实 |
| --- | --- |
| 一个可重复运行的失败矩阵 harness（inject 或 loopback，须说明理由） | 已交付：`tests/failmatrix/{world,cases,seams,run,mutations}.mjs` + 两个 tool，一条命令跑完；选 `inject` 的理由与代价见 §1 |
| 表驱动：场景 id + 期望状态码/错误码 + 实际 + PASS/FAIL | 已交付：168 条，`--json` 给机读逐条读数，§3 为生成的三列表 |
| 先交付一批真能跑绿的用例 | 已交付 168 条全绿（C1–C7 + E1/E2 + D1–D4；B1 106 / B2 36 / B3 17 / B4 9） |
| 每条附负控制：放宽守卫必须真红，恢复后转绿 | 已交付 23 条负控制全部 PASS（含 13 个文件 sha256 逐字节恢复） |
| 真扫 main 并列出真红项 | 真红 **0 条**；首跑 3 红为夹具 bug（已修，留复现证据）；另列 4 条「不该误判为缺陷」的事实 |
| 不擅自修产品代码 | 产品代码 `git diff origin/main -- services packages` = 0 行 |
| 未取得项单列（真实 AI 外呼/真机/微信写未取得） | 见 §8，共 10 条 |
| 提交前 lint + harness + verify-contract-status | 见 §10 |

## 10 提交前自检读数（本机）

```
npm run lint                        → PASS tsc --noEmit services/api ↔ PASS tsc --noEmit apps/admin ↔ PASS 仓库卫生扫描 → lint 通过
node tools/verify-contract-status.mjs → 6 行全 PASS（契约 112 条 / 装配 108 / implemented 13 / partial 95 / planned 4；形状错误 0、语义错误 0）
node tests/failmatrix/run.mjs        → 矩阵合计 168 条：PASS 168 / FAIL 0
node tools/i22-failmatrix-negative-control.mjs → 负控制合计 23 条：PASS 23 / FAIL 0
node --test tests/unit/gy-i22-failmatrix.test.mjs → 3 tests / pass 3 / fail 0
```

`npm run test:unit` 整套在本机是 `tests 3404 / pass 3395 / fail 8 / skipped 1`：**8 条红全部来自
`tests/unit/release-materials-index.test.mjs` 与 `release-materials-index-strict.test.mjs` 的 `bash -n` 项**，
根因是**本机环境限制**——Windows 上没有可用的 WSL/bash（`wsl: 检测到 localhost 代理配置…`）。已用
`git stash push -u` 在**未改动的基线**复跑同一测试，同样 `1 !== 0` 红，CI 的 Linux runner 有 bash 故不触发本项。

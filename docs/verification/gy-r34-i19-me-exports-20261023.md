# GY-R34-I19 · `GET /me/exports`（`listExports`）装配与证据

- 切片：`feat/gy-r34-i19-me-exports`（worktree `wt-r34-i19-exports`）
- 起点基线：`upstream/main = 765b6a31d993995e5dacbf6a3227ebcbb97fd8df`
- 合流基线：`upstream/main = f3a5f24d7427f5c2e40b9c8278312aa4827157ca`（`git merge --no-ff`，无冲突）
- 交付提交：实现 `adefebbd7f7ea7da7ef26bd345368bdcdaf1d6bc`；合流 `17a559b9`（`Refs #19`，无任何关单关键字）
- 结论：**契约条目 `listExports` 的 HTTP 面已实现并接线**；`contract-status.json` 的
  `route_mounted`/`status` 按派单**未改**，因此 `node tools/verify-contract-status.mjs` 仍 red（1 条形状错误，
  见 §5）。真实 PG17、真实数据、真机与"导出文件生成"**均未取得/不在本片范围**（见 §4）。

本页所有代码引用都用**符号**而非行号：证据页会被 `tools/verify-doc-anchors.mjs --strict` 当锚点扫描，
写死行号会在下一次代码移动时变成假引用。

## 1 契约条目 → 实现落点

契约原文 `packages/contracts/openapi.json` 的 `paths./me/exports.get`（`packages/contracts/operations.json`
里 `id: listExports`、`scope: user`、`version_required: false`）。**未改契约任何字节。**

| 契约项 | 实现落点（符号级） | 说明 |
| --- | --- | --- |
| 路径/方法 `GET /me/exports` | `services/api/src/routes/exports.ts` `registerExportRoutes()`，`API_PREFIX` + `/me/exports` | 实际路径 `/api/v1/me/exports` |
| `security: [{userSession: []}]` | 同上，`preHandler: guards.requireUser` | 缺/失效会话 ⇒ 401；另按 `x-scope: user` 判 `role !== 'user'` ⇒ 403 `SCOPE_DENIED`（与 `GET /me/consents` 同口径） |
| `parameters.Cursor`（string，maxLength 2048） | 同上，querystring schema `cursor: {type:'string', maxLength:2048}` | 超 2048 ⇒ schema 层 400 `INVALID_REQUEST`；≤2048 但解不开 ⇒ 400 `INVALID_CURSOR` |
| `parameters.Limit`（integer 1..50，默认 20） | 同上，`limit: {type:'integer', minimum:1, maximum:50, default:20}` | 0/51/小数/非数 ⇒ 400 |
| `200 → ExportPageEnvelope` | 同上，`{ data, meta: buildMeta(...) }`；`data` 由 `services/api/src/privacy/exports-list.ts` 的 `createExportsListService().list()` 产出 | `data.items[].*` 为 `components.schemas.Export` 的 8 个必需字段（`additionalProperties:false`）；`data.next_cursor` 为 string 或 null |
| `200` 头 `Cache-Control`（私有/授权访问） | 同上，`reply.header('Cache-Control', 'no-store')` | 与 `GET /me/consents` 一致 |
| `200` 头 `ETag` | **不发** | 契约原文：「资源revision强ETag；**列表无此头**」 |
| `400` | schema 校验失败 ⇒ `INVALID_REQUEST`；游标不可用 ⇒ `INVALID_CURSOR` | 见 `services/api/src/app.ts` 的 `setErrorHandler` 既有映射 |
| `401` | `guards.requireUser` | `SESSION_REQUIRED` / `SESSION_EXPIRED` |
| `403` | `SCOPE_DENIED`（后台会话不得读用户清单） | 同 `consents-pg.ts` 的 `identity.role !== 'user'` 口径 |
| `503` | 无连接池 / 账本不可用 ⇒ `PROVIDER_UNAVAILABLE`（`retryable:false`） | **不用内存账本冒充持久化** |

数据来源（**不新增 SQL**）：`services/api/src/privacy/ledger-pg.ts` 的
`createPostgresExportLedger().list()`（`WHERE user_id=$1` + `(created_at,id)` keyset），
经 `packages/privacy/egress.mjs` 的 `listExportsForUser()` 投影成契约 `ExportPage`
（`toContractExport` 负责形状，形状不合 ⇒ `PROVIDER_UNAVAILABLE`）。
`services/api/src/privacy/exports-list.ts` 只是装配层：**零 SQL 面**——
`tests/unit/sql-column-coverage.test.mjs` 的「SQL 宿主 = 19 已审计 + N 登记」不变量与 NC7
（新宿主必须判红）在本片全绿，可作"没有偷偷加 SQL"的机器证据（读数见 §3）。

游标（**复用既有签名游标唯一实现，未新造第二套分页**）：
- `services/api/src/privacy/signed-list-cursor.ts` —— 把 `consent-pagination.ts` 里的
  「HMAC 域分隔 + 9 键固定载荷 + `timingSafeEqual` + 15 分钟绝对到期」核**原样抽出**；
- `services/api/src/privacy/consent-pagination.ts` —— 改为委托（水位=快照签名、锚点=快照内 id）；
- `services/api/src/privacy/exports-list.ts` —— 同一份引擎的第二个列表域：载荷 `kind='exports'`、
  `sort='created_at_desc_id_desc'`、`watermark=null`、`after=`账本 keyset 游标（不透明锚点）。
  ⇒ 分页策略仍是**账本既有 keyset**（limit+1 看一页），本片没有重写分页；
  签名/主体/登录版本/TTL 绑定由共用引擎提供。
- 等价性证据（临时探针，已删除，不入库）：对 `paginateConsentRecords` 的新旧实现跑 22 组对比
  （首页/改变 limit/逐页到底/空列表/恰好整页 + 11 条拒绝路径 + 3 条水位变化），
  `JSON.stringify` 输出**逐字节相同**，探针打印 `EQUIVALENT: 22 comparisons byte-identical`。

接线（`services/api/src/app.ts` 两处，刻意**不推移行号**）：
- import：`import { registerExportRoutes } from './routes/exports.ts';`（与上一条 import 同一物理行）；
- 注册：`registerExportRoutes(app, config, pool, guards);`（紧跟 `registerConsentRoutes(...)` 之后）。
- ⚠ 为何 import 与既有 import 同行：`app.ts` 的行号被多份历史证据页当引用锚点，独占一行会让
  `node tools/verify-doc-anchors.mjs --strict` 新增 SUSPECT（本提交实测：拆行后新增 4 条）。
  要拆行必须先同步改那些证据页的行号，本片不做。

## 2 变更清单

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `services/api/src/routes/exports.ts` | 新增 | 路由模块：契约逐项对照、schema、鉴权、`no-store`、无池 503 |
| `services/api/src/privacy/exports-list.ts` | 新增 | 只读装配：账本读面（懒建）+ 共用签名游标；零 SQL |
| `services/api/src/privacy/signed-list-cursor.ts` | 新增 | 签名游标引擎（全仓唯一实现）：编解码、域分隔、主体/版本/到期校验 |
| `services/api/src/privacy/consent-pagination.ts` | 修改 | 改为委托共用引擎；对外 API 与字节输出不变 |
| `services/api/src/app.ts` | 修改 | 一处 import + 一处注册（见 §1 末） |
| `tests/unit/exports-route-http.test.mjs` | 新增 | 3 条用例（见 §3） |
| `docs/verification/gy-r34-i19-me-exports-20261023.md` | 新增 | 本页 |

未改（派单红线）：`packages/contracts/**`、`services/api/db/migrations/**`、
`docs/architecture/contract-status.json`、其它路由文件（`routes/consents.ts` 等一字未动）。

## 3 门禁与测试读数（2026-10-23，本 worktree，`node v24.16.0`）

| 命令 | 读数 |
| --- | --- |
| `node --test tests/unit/exports-route-http.test.mjs` | `tests 3 / pass 3 / fail 0` |
| `node --test <定向 8 文件>`（exports + consent×2 + planned-exemptions + sql-column-coverage + privacy/egress + api-health + doc-anchors-guard） | `tests 65 / pass 65 / fail 0` |
| `node --test <合流新增 5 文件>`（community-knowledge-wiring / history-cascade-wiring / moderation-live-adapter / admin-ui-flag-audit / doc-closing-keywords） | `tests 71 / pass 71 / fail 0` |
| `npx tsc -p services/api/tsconfig.json --noEmit` | `exit 0` |
| `node tools/verify-doc-anchors.mjs --strict` | `PASS`：基线 103 条命中、**基线外新增 0**、陈旧 0，`exit 0` |
| `node tools/verify-contract-status.mjs` | **`exit 1`**：`[形状错误 1 / 语义错误 0 / 表格漂移 0]`，唯一一条 `ERROR: 形状错误 · get /me/exports: route_mounted=false, actual=true` —— 见 §5 |
| `node tools/verify-contract-status.mjs` 锚点面 | 语义错误 0、表格漂移 0：`consent-pagination.ts` 的重构**没有**破坏任何既有证据锚点 |

`tests/unit/exports-route-http.test.mjs` 的三条用例（全部走真实产品 HTTP / 真实 `buildApp`）：

1. **无池 ⇒ 503**：`buildApp({pool:null})` + stub 微信登录；匿名请求 401 `SESSION_REQUIRED`
   （鉴权在 503 之前），带令牌 ⇒ `503 PROVIDER_UNAVAILABLE`、`retryable:false`、**无 `data` 封套**。
2. **连接池形状不合 ⇒ 装配期不抛、请求期 503**：`buildApp` 用只有 `query()` 的假池必须能起
   （路由已装配 ⇒ 匿名 401），`createExportsListService().list()` 必须以 `PROVIDER_UNAVAILABLE`/503 拒绝，
   而不是裸 `Error`/500。**这条是返修用的负控制**：本片第一版把"解析账本"放在装配期，
   被 `tests/unit/api-health.test.mjs` 的假池用例抓红（`createPostgresExportLedger 需要 pg 连接池`），
   现改为懒建（首个请求才解析）。`api-health` 6/6 复绿。
3. **PGlite + `SET ROLE` 全链路**（合成账号/合成账本行）：
   - **fail-closed 臂**：运行期角色只有 `public.exports.user_id` 一列 SELECT（`roles/auth_privacy.sql` 现状）
     ⇒ `SELECT *` 触 42501 ⇒ `mapPgError` ⇒ `503 PROVIDER_UNAVAILABLE`（`retryable:false`）——
     **如实复现真库现状**，不是用内存冒充；
   - 补齐 `GRANT SELECT ON public.exports` 后 **200**：`Cache-Control: no-store`、**无 ETag**、
     `meta` 三字段、`data` 只有 `items`/`next_cursor`、每条 item **恰好 8 个键**、
     `object_ref` 三字段、无 `user_id` 泄漏；排序 `(created_at DESC, id DESC)`（含 created_at 相同的 id 降序）；
   - 翻页：`next_cursor` ≤2048、改变 limit 不重复不漏项、末页 `null`；
   - **他人不可见**：b 只看到自己 1 条、`next_cursor=null`；
   - **游标绑定**：他人游标 / 改签名 / 只给锚点 / 追加段 / 空串 / 2047 字超长 / 改 `auth_epoch` /
     改 `kind` / 改 `sort` / 改 `expires` 过期 / 加额外字段 —— 11 条全部 `400 INVALID_CURSOR`（即使
     签名合法，主体/域/到期不符仍拒）；**跨域**：导出游标打到 `GET /me/consents` ⇒ 400（域分隔生效）；
   - **参数校验**：`limit=0/51/1.5/abc`、`unknown=1`、`cursor` 2049 字 ⇒ 400 `INVALID_REQUEST`；
   - **会话重验**：`POST /auth/logout` 后旧令牌 ⇒ 401 `SESSION_EXPIRED`。

## 4 未取得（如实登记）

1. **真实 PG17 集成臂未取得**（`tests/integration/` 未新增脚本，`.github/workflows/real-pg-integration.yml`
   未改，`tests/unit/ci-real-pg-wiring.test.mjs` 的清单未动）。原因不是"省事"：
   - 真库上运行期角色对 `public.exports` 连 `SELECT` 都没有（`egress_ledger` 组从未部署、
     `20-login-roles.sql` 未授予 ⇒ `tests/unit/sql-column-coverage.test.mjs` 的
     `LEDGER_COVERAGE_EXEMPT` 33 条 + 1 条行锁豁免），**这条读面在真库上只能证到 503**；
   - 接一条臂还要同时改 workflow 的 job 清单与 CI 接线守卫（共享清单，在飞 PR 冲突面），
     属"成本过高"（派单允许的降级路径）。
   - **已用等价手段替代**：PGlite + `SET ROLE gy_exports_route_runtime` 复现了同一条
     `42501 ⇒ mapPgError ⇒ 503` 路径，并另跑通了 happy path（同一批 SQL、同一批迁移文件）。
     这**不等于**原生 PG17 证据。
2. **真实数据未取得**：全部是合成账号（stub 微信登录）+ 合成 `exports` 行；没有真实外发账本数据。
3. **真机未取得**：本片只有 HTTP 层，无小程序/真机链路。
4. **"导出文件生成"不在本片范围，也未取得**：契约 `Export` 是**外发账本条目的投影**
   （`object_ref`/`purpose`/`recipient_id`/`consent_epoch`/`state`/`sent_at`/`deletion_state`），
   `listExports` 只描述"发生过哪些外发"，**没有任何文件生成、打包、下载或 `Content-Disposition` 面**；
   本片因此没有、也不应产出"导出文件"。**不要把本片读成"用户数据导出（packaging）已实现"。**
5. **契约台账状态未更新**（派单禁止改 `contract-status.json`）：本片把 `listExports` 从"无 HTTP 路由"
   变成"已装配"，但台账仍写 `route_mounted: false` / `status: "planned"` / 空 `evidence`。
   后果与后续动作见 §5。
6. **生产授权面未改**：`public.exports` 的运行时读权限属"接线待裁定"（既有豁免），本片不动授权 SQL。

## 5 前提被推翻 / 需要指挥裁定的一处

**派单前提「跑 `node tools/verify-contract-status.mjs` 能 green」与「⛔ 不改 `contract-status.json`」互斥。**

- 实测原文：`ERROR: 形状错误 · get /me/exports: route_mounted=false, actual=true`，
  汇总行 `FAIL: 契约实现状态对照校验未通过（1 项）[形状错误 1 / 语义错误 0 / 表格漂移 0]`，`exit 1`。
- 机制：`tools/verify-contract-status.mjs` 的 `scanMountedRoutes()` 静态扫描**源码里的路由装配**，
  再与台账 `route_mounted` 逐条比对（`mountedMismatches`）。⇒ **任何**把 `planned` 操作接上线的片，
  在台账更新前都会红；这**不是**本片代码缺陷，`语义错误 0 / 表格漂移 0` 也说明没破坏任何既有锚点。
- 为什么本片不改：派单明文 **⛔ 不改 `docs/architecture/contract-status.json`**。要变绿至少需要
  4 处联动（同一片一次做完才自洽）：
  1. `docs/architecture/contract-status.json`：`listExports` 的 `route_mounted: true`、`status` 改 `partial`、
     补 `evidence`（带符号锚）、重写 `blocker`（现在这段"无 HTTP 路由与 handler 注册"已与事实不符）；
  2. `node tools/verify-contract-status.mjs --write-doc` 重生成 `docs/architecture/contract-implementation-status.md`
     的生成区（手改生成区无效）；
  3. `tests/unit/contract-planned-exemptions.test.mjs` 的 `PLANNED_EXEMPT` 删掉 `listExports`
     并把钉死的**条数 4 → 3**（该测试还会断言 4 条空证据操作的状态数组，一并改）；
  4. 本页 §1 的 evidence 落到台账锚点后，`node tools/verify-contract-status.mjs` 复跑至 `exit 0`。
  ⇒ 建议由**契约台账片**（或指挥指定片）单独完成，本片保持"代码已交付、台账如实仍为 planned"。
  ⚠ 在此之前，任何人看到 `listExports` 仍标 `planned` 都应以本页为准：**HTTP 面已存在**。

## 6 复核方式（可直接粘贴）

```bash
git -C <worktree> rev-parse HEAD            # 交付后应为合流提交之后的 HEAD
git -C <worktree> status --porcelain        # 期望：0 行
node --test tests/unit/exports-route-http.test.mjs
node tools/verify-doc-anchors.mjs --strict  # 期望 PASS / exit 0
npx tsc -p services/api/tsconfig.json --noEmit
node tools/verify-contract-status.mjs       # 期望 exit 1 且只有 §5 那一条（台账未改，见 §5）
git -C <worktree> merge-tree --write-tree upstream/main HEAD   # 合流预演：期望 exit 0
```

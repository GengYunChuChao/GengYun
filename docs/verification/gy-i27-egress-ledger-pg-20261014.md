# GY-I27（#29）第二片 · **持久外发账本 + 实际派发 + 在途守卫接入 + 真 PG 端到端**证据

- **任务**：GY-I27（issue **#29**）第二片，承接已合并的协议层（#128）与接线单（#133）
- **本片回应监工对 #133 的关闭核对**：
  > 「真实持久外发账本和实际派发、任务执行/保存/取消墓碑接入、注销消费者触发、HTTP 撤回端到端及真实能力集成未齐」
- **日期**：2026-10-14
- **分支**：`feat/gy-i27-egress-ledger`（新 worktree `GengYun_W31`，未复用旧分支）
- **基线**：`upstream/main` = `fcfa6de9d62aeaaa0489d3319f8f06911312af48`
- **跨线改动已获用户授权**（2026-10-14）：可修改其他任务线已合并文件，逐处披露见第 5 节
- **真 PG**：本机隔离集群 PostgreSQL **17.11**（`initdb` 新建、随机口令只存仓外本机文件、仅 `127.0.0.1:55432`、跑完 `pg_ctl stop`，无遗留进程）
- **未发起任何真实第三方外发/付费调用**

## 1 交付物

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `services/api/db/migrations/0011_export_ledger.sql` | 新增 | `exports` 增列 `revision`（CAS 前置条件）/`error_code`/`job_id`/`cancelled_at`/`cancellation_reason` + 取消墓碑成对约束与两个部分索引；`export_writebacks`（受控结果介质：写回与校验**同事务**、只增不改、`result` 必须是 jsonb 对象） |
| `services/api/db/migrations/rollback/0011_export_ledger.down.sql` | 新增 | 仅撤销本迁移新增对象（不动 0003 既有列） |
| `services/api/db/roles/egress_ledger.sql` | 新增 | 最小权限组 `gengyun_egress_ledger`：可登记/迁移/写回；**不可**删账本行、改冻结快照列、写 `recipients`/`users.state`，无 DDL |
| `services/api/src/privacy/ledger-pg.ts` | 新增 | **持久账本**：`reserve`/`get`/`list`/`resolveRecipient`/`findReservedByObject`/`linkJob`/`markSent`/`markFailed`/`markOutcomeUnknown`/`guardWriteback`/`getWriteback`/`cancelVersion`/`cancelForJob`/`revokeInFlight`；`createPostgresPrivacyPorts`；`summarizeEgressOutcome` |
| `services/api/src/privacy/task-egress.ts` | 新增 | 媒体类任务（识别/转写/OCR）的外发守卫端口：`reserveForAcceptance`/`provider`/`abandonReservation`/`cancelForJob`/`cancelVersion` |
| `services/api/src/privacy/ledger-pg-reference.d.ts` | 新增 | errors/constants/redact 三个 `.mjs` 形状声明（不改既有 `reference.d.ts`） |
| `services/api/src/app.ts` | 跨线追加 | 配置了数据库时装配持久账本 + 只读隐私端口 + 在途守卫 + 三域 egress 端口；撤回/注销消费者由持久账本现建 |
| `services/api/src/routes/{recognitions,speech,ocr}.ts` | 跨线追加 | 受理前预留（失败即回收）、提供者包装（speech/ocr 在插件内、识别域在 app.ts） |
| `services/api/src/jobs/sources.ts` | 跨线追加 | `createRecognitionJobSource(service, { onCancelled })` 可选钩子 ⇒ 取消成功即写取消墓碑 |
| `packages/privacy/{in-flight,egress}.mjs` | 本线接口变更 | 账本访问统一 `async/await`（见第 5 节「跨线接口变更」） |
| `services/api/src/privacy/{consent-pg,grant-pg}.ts` | 跨线（上一片已授权） | `EgressRevoker` 两方法返回 Promise 并在调用处 `await` |
| `tests/integration/egress-ledger-pg.mjs` | 新增 | **真 PG** 端到端 11 组（见第 3 节） |
| `tests/privacy/{in-flight,egress}.test.mjs` | 更新 | 调用点改 `await`；负例不放宽（并补 `SESSION_REQUIRED`） |
| `tests/integration/{speech,ocr}-http.mjs` | 跨线更新 | 结构断言按其原意更新（允许追加隐私域 `egress` 键，仍禁止 provider/store/media 端口注入） |

## 2 装配说明（挂在哪、如何回退）

| 环节 | 装配点 | 回退方式 |
| --- | --- | --- |
| 持久账本 / 只读隐私端口 / 在途守卫 / 撤回消费者 | `app.ts` 一处：`pool !== null && typeof pool.connect === 'function'` 时构建；**连接池形状不足（如测试假池只有 query）⇒ 不装配并告警** | 删该段（或让 `pool` 缺 `connect`）即回到"不装配" |
| 三域 egress 端口 | `mediaEgress(dataType, capability)` → `{ consent, egress }` 传入 3 个 `register*` | 不传 `egress` 即行为不变 |
| 受理前预留 | `POST /recognitions`、`POST /speech/transcriptions`、`POST /ocr` handler 内（`withPrivacyErrors` 包装），位于服务 create **之前** | 同上 |
| 派发收口 | 提供者包装：识别域在 `app.ts`（该域服务在此构建）、转写/OCR 在各自路由插件内 | 同上 |
| 执行前/保存前重查 | `task-egress.provider()`：`findReservedByObject` → `linkJob` → `assertExecutable` → `ledger.markSent` → 提供者 → `saveResult`（失败 `markFailed`） | 同上 |
| 取消墓碑 | `jobs/sources.ts` 的 `onCancelled` → `cancelForJob`（`app.ts` 传入） | 钩子为可选，不传即无此行为 |
| 撤回/注销撤销在途 | `registerConsentRoutes(..., { egressRevoker })`（持久账本现建；注入优先） | 不传 `egressRevoker` ⇒ 既有 `OBJECT_UNAVAILABLE` fail-closed 兜底 |

### 2.1 `real` 未接真实传输的红线（本片仍在）

`reserveForAcceptance` 在 `executionMode === 'real'` 且**被包装的提供者 `available !== true`** 时，
于**任何账本变更之前**抛 `PROVIDER_UNAVAILABLE`（503、`retryable: true`）⇒ 该用户**零 `exports` 行**、
零 `sent`。`stub`/`preset_demo` **完全不预留、不记账**（替身不发生真实外发 ⇒ 账本里不得出现 `sent`）。

## 3 真 PG 端到端（`tests/integration/egress-ledger-pg.mjs`）

运行方式（**该脚本不在任何 CI glob 内**，必须显式运行；要求**空库**——首行断言 `public` 无表）：

```
# 本地隔离集群（仓外数据目录；口令只在本机 private 文件里）
psql -h 127.0.0.1 -p 55432 -U <owner> -d postgres -c "DROP DATABASE IF EXISTS gengyun_egress_test" -c "CREATE DATABASE gengyun_egress_test"
EGRESS_LEDGER_TEST_URL='postgres://<owner>:<pw>@127.0.0.1:55432/gengyun_egress_test' node tests/integration/egress-ledger-pg.mjs
```

原始输出（末尾）：

```
Native PostgreSQL: 17.11 @ 127.0.0.1:55432/gengyun_egress_test
PASS 1: fresh native PG17.11：0001/0003/0008/0009/0011 up，0011 down 后表与列如实消失，再 up 成功
PASS 2: 运行时 LOGIN 继承 auth_privacy + consent_granter + egress_ledger，且无任何超级权限
PASS 3: egress_ledger 组：可读账本/回写与核验所需列；不可删账本行、不可改冻结快照列、不可写 recipients/users.state、无 DDL
PASS 4: 合成用途政策 + 已验证接收方（fixture-weed, capability=weed, 禁止训练/可删除）就绪
PASS 5: buildApp(real + 真 PG 池 + 注入的合成 real 传输) 启动（后台域 real 仍 fail-closed，与本片无关）
PASS 6: 实际派发（真 PG）：reserve→assertExecutable→markSent→传输→saveResult；账本如实登记 userid/purpose/recipient/job，回写仅结构分类
PASS 7: 重复派发被拒：已 sent 的预留行再次 markSent ⇒ OBJECT_UNAVAILABLE（零重复外发、不新增行）
PASS 8: HTTP 撤回端到端（真 PG）：撤回 200 + 在途外发置 failed + 晚到结果零写入 + 入口拒绝且不新增账本行
PASS 9: 取消墓碑（真 PG）：/jobs/{id}/cancel 写只增不减墓碑 + 晚到零写入 + 同对象同版本再次预留被拒（不可复活）
PASS 10: real 未接真实传输 ⇒ 受理处 503 PROVIDER_UNAVAILABLE(retryable)，且该用户**零 sent 记录**（在任何账本变更之前拒绝）
PASS 11: 注销/停用（真 PG，契约口径模拟）：入口 403 ACCOUNT_INACTIVE + 在途撤销 + 晚到结果零写入（HTTP 触发面 requestAccountDeletion 仍为 planned）

RESULT=PASS 11 组；真实 PostgreSQL 17.11（本机隔离、仅回环）；未发出任何对外/付费请求
CLEANUP=done（角色与回写表已清理；库由运行器删除）
```

### 3.1 逐条说明（改前/改后语义对照）

| # | 断言 | 改前（无持久账本） | 改后（本片） |
| --- | --- | --- | --- |
| 6 | `exports` 行 `state='sent'`、`purpose='external_inference'`、`recipient_id='fixture-weed'`、`job_id=<job>`、`required_consents={media_processing,external_inference}`；`export_writebacks` 1 行且 `result.content_class='structural_only'`、**不含提供者载荷** | 无账本行（盘点不到外发） | 如实登记 + 回写仅结构分类 |
| 7 | 同一预留行第二次 `markSent` ⇒ `OBJECT_UNAVAILABLE`，`exports` 行数不变 | 无 | 零重复外发 |
| 8 | `DELETE /me/consents/external_inference` ⇒ **200**（而非 409 兜底）；该外发行 → `failed`/`CONSENT_WITHDRAWN`；放开悬挂的提供者后 `export_writebacks` 仍为 **0**；撤回后入口 403 且**不新增**账本行 | 撤回被 `OBJECT_UNAVAILABLE` 拒绝（"消费者尚未接入"） | 撤回立即撤销在途 + 晚到回写零写入 |
| 9 | `POST /jobs/{id}/cancel` ⇒ 200；`cancelled_at` 非空、`state='failed'`；晚到结果零写入；**同对象同版本**再次 `POST /recognitions` ⇒ **409 `OBJECT_UNAVAILABLE`** | 无墓碑、无不可复活保证 | 只增不减墓碑 + 不可复活 |
| 10 | 未注入真实传输的 `real` 实例：`POST /recognitions` ⇒ **503 `PROVIDER_UNAVAILABLE`（retryable）**，该用户 `exports` 计数 **0** | 无账本可查 | 在任何账本变更之前拒绝 ⇒ 零 `sent` |
| 11 | 按 `state-contract §105` 口径在同一提交置 `deletion_pending` + `auth_epoch+1`：入口 403 `ACCOUNT_INACTIVE`；`revoker.onAccountSuspendedOrDeleted` ⇒ 在途置 `failed`；晚到结果零写入；注销后连同 `GET /jobs/{id}` 也被守卫拒绝 | 无 | 注销/停用 ⇒ 撤销在途（HTTP 触发面仍缺，见第 6 节） |

## 3.2 真 PG workflow 回归 + 修法（本片修）

**现象**（PR #149 的 CI，两个真 PG workflow 红）：
`auth-privacy-postgres-17.11` 与 `consent-grant-postgres-17.11` 失败，报
`{"error":{"code":"PROVIDER_UNAVAILABLE","message":"授权服务暂不可用",...}}`
（`auth-privacy-pg.mjs` 侧断言为 `503 !== 409`）。

**本地复现**（同一隔离集群，为两个 workflow 各建专用库；**不改任何 CI 文件**）：

```
AUTH_PRIVACY_TEST_URL='postgres://<owner>:<pw>@127.0.0.1:55432/gengyun_auth_privacy_test' node tests/integration/auth-privacy-pg.mjs
CONSENT_GRANT_TEST_URL='postgres://<owner>:<pw>@127.0.0.1:55432/gengyun_consent_grant_test' node tests/integration/consent-grant-pg.mjs
```

**真因**（与本片的装配/接口变更直接相关，**不是**基线既有问题——基线 `fcfa6de` 未装配账本，
撤回/授予在依赖存在时一律 409 拒绝，这两条因此从不会走到消费者）：
1. 这两个 workflow 的库只施加 `0001/0003/0008`（`consent-grant` 另加 `0009`）与
   `roles/auth_privacy.sql`（`consent-grant` 另加 `roles/consent_granter.sql`）——
   **既不施加 `0011_export_ledger.sql`，也不授予新的 `gengyun_egress_ledger` 角色**；
2. 本片让 `app.ts` 在"配置了数据库"时装配持久账本并注入 `egressRevoker` ⇒ 撤回/授予在
   "已有业务依赖（jobs/media/exports/author_links）"时会调用撤回消费者；
3. 消费者的第一条 `UPDATE public.exports` 于是以驱动错误失败（缺列/缺权限），
   被 `mapPgError` 笼统映射成 **503 `PROVIDER_UNAVAILABLE`**，再被 `consent-pg`/`grant-pg` 的
   `transaction()` 兜底成"授权服务暂不可用" ⇒ **把"如实拒绝的部分撤回（409）"说成了"服务不可用"**。

**修法**（fail-closed；**未改 CI 文件、未放宽任何断言、未跳过任何真 PG 负例**）：
- `ledger-pg.ts` 新增**懒探测** `assertProvisioned()`（结果缓存）：要求
  `to_regclass('public.export_writebacks')` 存在**且**当前角色对 `exports.revision` /
  `exports.cancelled_at` 具备 `UPDATE`；所有写路径（reserve / markSent / markFailed /
  markOutcomeUnknown / guardWriteback / linkJob / cancelVersion / cancelForJob / revokeInFlight）
  先过探测；不就绪 ⇒ 抛契约内的 **`OBJECT_UNAVAILABLE`（"外发账本未就绪"）**，
  而不让驱动错误变成 503。
- `consent-pg.ts` / `grant-pg.ts`：消费者调用包 `try/catch` ⇒ 失败时
  **`OBJECT_UNAVAILABLE`（拒绝部分撤回 / 拒绝授权变更）**。
  语义定式：**要么真的撤销了在途外发，要么如实拒绝** —— 绝不在"能否撤销"未知时放行。

**改前 / 改后（原始输出）**：

```
# 改前
$ node tests/integration/auth-privacy-pg.mjs   → EXIT=1
  AssertionError: 503 !== 409   at expectError (auth-privacy-pg.mjs:44) → (…:223)
  {"error":{"code":"PROVIDER_UNAVAILABLE","message":"授权服务暂不可用","retryable":false,...}}
# 改后
$ node tests/integration/auth-privacy-pg.mjs   → EXIT=0
  ALL 26 native PG17.11 integration groups passed; grant API is tested separately; business write/export consumers remain unimplemented.
$ node tests/integration/consent-grant-pg.mjs  → EXIT=0
  ALL 27 grant integration groups passed; synthetic policies are NOT production evidence.
```

**负控制思路（为什么这不算"放宽断言"）**：两个 workflow 的 `409 OBJECT_UNAVAILABLE` 断言
（`auth-privacy-pg.mjs`「existing media dependency refuses partial withdrawal」、
`consent-grant-pg.mjs`「all four unimplemented business dependency classes refuse…」）**逐字保留**，
它们现在验证的是**更严格**的性质：*消费者不可用时，撤回/授权变更必须**拒绝**，而不是放行或含糊的 503*。
真正"接上消费者"的环境（本片 `egress-ledger-pg.mjs`：施加 0011 + `egress_ledger` 角色）走另一分支：
撤回 **200** + 在途外发置 `failed` + 晚到零写入（第 3 节 PASS 8）。两条分支合起来即完备的 fail-closed：
`消费者可用 ⇒ 真撤销并放行` ／ `消费者不可用 ⇒ 拒绝`。

> 备注（不阻塞、未改动他人脚本）：`auth-privacy-pg.mjs` 收尾提示仍写
> "business write/export consumers remain unimplemented"——该文本属该脚本作者维护；该 workflow 的库
> 确实没有施加账本迁移/角色，因此其结论在该环境下成立。本片不改他人脚本文案。

## 4 门禁与受影响测试（原始输出）

```
$ node --test tests/privacy/in-flight.test.mjs tests/privacy/egress.test.mjs tests/privacy/ledger.test.mjs \
               tests/unit/privacy-consent-wiring.test.mjs tests/unit/privacy-egress-http.test.mjs
ℹ tests 110   ℹ pass 110   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0

$ npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）

$ npm run test:unit
ℹ tests 1800   ℹ pass 1799   ℹ fail 0   ℹ skipped 1（既有 skip）

$ node tests/integration/{recognitions,speech,ocr,tts,jobs}-http.mjs
recognitions-http EXIT=0 / speech-http EXIT=0 / ocr-http EXIT=0 / tts-http EXIT=0 / jobs-http EXIT=0

$ node tests/integration/auth-privacy-pg.mjs     → EXIT=0（ALL 26 native PG17.11 integration groups passed）
$ node tests/integration/consent-grant-pg.mjs    → EXIT=0（ALL 27 grant integration groups passed）
$ node tests/integration/egress-ledger-pg.mjs    → EXIT=0（RESULT=PASS 11 组，见第 3 节）

$ git diff --check
（无输出）
```

**两个集成脚本为何要改**（`tests/integration/{speech,ocr}-http.mjs`）：它们用**源码文本断言**证明
"产品装配零端口注入"（注册行字符串完全相等 / 注入键集合恰为 5 个）。本片把**隐私域** `egress`
端口追加进注册行 ⇒ 原断言必然失效。按其**原意**更新为：保留原字段、**只允许追加隐私域
`consent`/`egress` 键**、并断言**不存在其它注入键**（不得出现 provider/store/media 端口）。
这两个脚本**不在任何 CI glob 内**（`package.json` 的 `test:*` 只覆盖 `tests/{unit,privacy,media,
reference,moderation,contract,evaluation}` 与 `tests/local-debug.test.mjs`），因此第 4 节是**显式运行**
的原始输出，而非 CI 结论。

## 5 跨线改动披露（**用户 2026-10-14 授权改他人已合并文件**）

| 文件（原属） | 改了什么 | 为什么最小 / 如何回退 |
| --- | --- | --- |
| `services/api/src/app.ts`（GY-I02） | 追加式：`privacyInjection` 已在上一片存在；本片新增"隐私域装配"一段（持久账本/端口/守卫/三域 egress）、3 个 `register*` 各加 `egress` 键、识别域提供者包装、作业源 `onCancelled` 钩子 | 全部**追加**；删该段 + 3 个 `egress` 键即回退 |
| `services/api/src/routes/{recognitions,speech,ocr}.ts`（GY-I09/I10/I11） | 各加**可选** `egress` 端口；POST handler 内加"预留 + 失败回收"；speech/ocr 提供者包装 | 未注入 ⇒ `preHandler` 与 handler 行为不变 |
| `services/api/src/jobs/sources.ts`（GY-I01） | `createRecognitionJobSource(service, hooks = {})` 追加**可选**钩子（取消成功后调用；失败只吞进日志、不改写取消结果） | 不传 hooks 即逐字不变 |
| `tests/integration/{speech,ocr}-http.mjs`（GY-I11/I10） | 结构断言按原意更新（见第 4 节末） | `git revert` 该文件 |

### 5.1 跨线**接口变更**（有意且必要，非顺手重构）

**改了哪些他人已合并文件**：`packages/privacy/in-flight.mjs`（本线协议模块，但已在 #128 合并、
被他人文件依赖）、`packages/privacy/egress.mjs`、`services/api/src/privacy/consent-pg.ts`、
`services/api/src/privacy/grant-pg.ts`。

**为什么必须改**：内存账本的 `get`/`list`/`markFailed`/`revokeInFlight` 是**同步**的，
而 PostgreSQL 账本必然返回 Promise。守卫/消费者若按同步取值，会**把 Promise 当记录**
⇒ 归属判定为不符（`OBJECT_UNAVAILABLE`）或把 Promise 当计数 ⇒ **fail-closed 方向正确但功能不可用**。
本片正是要接**持久**账本，因此必须统一 `await`：具体是
`in-flight.mjs` 的 `requireRecord`/`cancelVersion`/`createEgressRevoker` 两个方法、
`egress.mjs` 的 `dispatch` 内 `ledger.get` 与失败分支、`listExportsForUser`。

**语义不变性证据**：
1. 对同步实现，`await` 非 Promise 值即**原值返回**（内存账本人/路径行为逐字不变）；
2. 相关既有用例**全绿**：`tests/privacy/{in-flight,egress,ledger}.test.mjs`、
   `tests/unit/privacy-consent-wiring.test.mjs`、`tests/unit/privacy-egress-http.test.mjs` ——
   共 **110/110**（第 4 节原始输出）；
3. 负例**未放宽**：畸形游标仍 `INVALID_CURSOR`、越界 limit 仍 `INVALID_REQUEST`（并补 `SESSION_REQUIRED`）；
4. `tests/unit/privacy-consent-wiring.test.mjs` 里注入的 revoker 仍是**同步**返回对象，
   服务层 `await` 它照常工作 —— 这正是"await 同步值 = 原值"的活证据。

**如何回退**：还原 `in-flight.mjs` / `egress.mjs` / `consent-pg.ts` / `grant-pg.ts` 的 async 化即可；
但那样 `ledger-pg.ts`（持久账本）**不可用**（守卫会误判）⇒ 应与持久账本装配一并回退。

## 6 未取得 / 未验证（不得据本页声称已完成）

| # | 项 | 状态 | 原因 |
| --- | --- | --- | --- |
| 1 | **真实第三方外发** | **未验证** | 未授权付费/真实调用；`real` 未接真实传输一律 503，且**零 sent 记录**。第 3 节 6–9 的"实际派发"用的是**测试内合成 real 传输**（不联网，脚本内明确标注） |
| 2 | **合成域（TTS）的在途守卫接入** | **已接线（后续片，2026-10-16）** | 本页记录当时状态：迁移 0003 的 `exports.object_id` 是 **uuid**，而 `createSynthesis` 的 `checked_content_ref.id` 是 1..80 的**任意字符串**（合成目标不一定是 uuid）⇒ 需要一次 **schema/契约决策**（例如新增文本型对象标识列），本片不自造。**该决策已由 GY-I27 第三片落地**：迁移 `0014_export_object_key.sql` 新增文本型对象标识列 `object_key varchar(128)`（既有列类型未改），装配在 `services/api/src/privacy/synthesis-egress.ts`；本页第 2 节读数照旧（当时确未接线） |
| 3 | **注销的 HTTP 触发面** | **未接线**（契约仍 `planned`） | `requestAccountDeletion` 在契约里仍是 `planned`（属 GY-I19），**不得自造契约外路由**。本片交付消费者接口并在第 3 节 11 按 `state-contract §105` 口径**模拟**注销提交（同一提交里 `deletion_pending` + `auth_epoch+1`）后验证：入口拒绝、在途撤销、晚到零写入 |
| 4 | **真实微信身份 / 真机** | **未验证** | 合成身份（替身 wechat 提供者）；无小程序改动 |
| 5 | **真实媒体/对象存储** | **未验证** | 第 3 节用 `createSubstituteMediaPort()`（合成媒体引用端口）；本片测的是账本，不是存储 |
| 6 | **生产默认装配下的"实际派发"** | **未验证（也不可能发生）** | 应用装配路径**永不注入真实提供者**（既有零端口注入策略）⇒ 生产 `real` 里提供者恒为 `available=false` ⇒ 受理 503、零账本行。真实派发只有在显式注入已审真实传输后才会发生 |
| 7 | **`export_writebacks` 的实库持久化语义**（崩溃恢复、备份 30 日） | **未验证** | 属 GY-I19 的 7/30 日删除与恢复清单范围 |
| 8 | 真实能力集成（AI 供应商、准确率） | **未做** | 本片是隐私/账本接线，不涉及能力接入 |
| 9 | 域名/网关/CDN | **未做** | 用户明确暂不做 |

## 7 剩余风险

1. **`reserve` 与受理之间的窗口**：受理失败已回收预留（`abandonReservation` → `failed`），但**已回收的
   `(object, revision)` 仍可被后续合法任务重新预留**（取消墓碑只针对**取消**，不针对"受理失败"）——
   这是有意的：受理失败不是取消。
2. **`required_consents` 的用途集合变化**：`markSent`/`guardWriteback` 逐项比对预留守住的用途 epoch；
   若某用途**新增**到 `MEDIA_PURPOSE_REQUIRED_CONSENTS`（代码变更），旧预留行不会被自动收紧
   （仍要求原有集合）—— 需要该集合变更时同步评估既有预留。
3. **`revokeInFlight` 的粒度**：按 `required_consents ? purpose` 精确到用途；`注销` 走全量。
   两者都是 `UPDATE`（幂等），但**不撤销已发出的外部请求**（账本口径：派发 at-least-once，
   外部调用无法与本地事务绑定）——受影响的隔离由第三方删除流程（GY-I19）承接。
4. **`cancelForJob` 只对已 `linkJob` 的行生效**：若提供者尚未被调用（`reserved` 且未链接 job），
   按 job 取消不会命中该行；此时该行仍会被"撤回/注销"路径撤销，或被受理失败回收。
5. **本地 PG 集群是一次性证据环境**：随机口令放在仓外本机 private 文件；跑完已 `pg_ctl stop`。
   真 PG 用例**不在 CI**（需显式提供 `EGRESS_LEDGER_TEST_URL`），因此 CI 绿**不代表**本片已验证。
6. **接口 async 化的兼容面**：`in-flight.mjs` 的 `cancelVersion` 由同步返回变为 Promise。
   仓库内已核对**全部调用点**（`packages/privacy/**`、`services/api/src/**`、`tests/**`）并同步 `await`；
   若外部还有未入库的调用方，需要同样处理。
7. **账本未就绪时的语义（承接第 3.2 节）**：库未施加 `0011`/`egress_ledger` 角色时，
   撤回/授权变更在"已有业务依赖"下一律 **409 `OBJECT_UNAVAILABLE` 拒绝**（不再含糊 503）；
   运维需按迁移与角色文件补齐后，才算真正接入在途撤销。这是**有意的 fail-closed**，
   不是功能缺失的静默降级（日志/回执给出"账本未就绪/消费者不可用"）。
8. **两个 workflow 的库仍未施加账本迁移/角色**：本片**不改 CI**，因此那两个 workflow 走的是
   "消费者不可用 ⇒ 拒绝"分支；它们**不会**验证"真撤销"路径（该路径由 `egress-ledger-pg.mjs` 覆盖）。

## 8 PR 正文可粘贴段落

```
Refs #29（不关闭整项）。第二片：把协议层接到**持久**外发账本，并回应监工对 #133 的关闭核对四项。
跨线改动已获用户 2026-10-14 授权，逐处披露于证据页第 5 节。

1) 持久外发账本 + 实际派发：新增迁移 0011（exports 增 revision/error_code/job_id/cancelled_at/
   cancellation_reason + export_writebacks）与最小权限角色 gengyun_egress_ledger；新增 ledger-pg.ts，
   提交边界在**单事务**内完成「校验读取（账号 auth_epoch + 全部必需用途 epoch + 接收方版本/条款）
   + 实际写入」。受理处 reserve → assertExecutable → markSent → 传输 → saveResult（失败 markFailed）；
   未登记即派发直接拒绝。**real 未接真实传输 ⇒ 在任何账本变更之前 503 PROVIDER_UNAVAILABLE(retryable)，
   该用户零 sent 记录**；替身/演示不记账。
2) 任务执行/保存/取消墓碑接入：以**提供者端口包装**为接缝（识别/转写/OCR 三域），
   不改各域服务判定语义；`/jobs/{id}/cancel` 成功后写**只增不减**墓碑 ⇒ 晚到回调零写入、
   同对象同版本再次预留被拒（不可复活）。
3) 注销消费者：`createEgressRevoker` 已注入授权服务；**HTTP 触发面 `requestAccountDeletion` 仍为
   planned（属 GY-I19），故未自造路由** —— 证据以 state-contract §105 口径模拟注销提交后验证
   入口 403 + 在途撤销 + 晚到零写入。
4) 真 PG 端到端：本机隔离 PostgreSQL 17.11（initdb 新建、随机口令、仅回环、跑完停库），
   tests/integration/egress-ledger-pg.mjs 11 组全过，含 **HTTP 撤回 200（不再走 409 兜底）+
   在途置 failed + 晚到结果零写入 + 零新增账本行**、取消墓碑不可复活、real fail-closed 零 sent、
   最小权限负例（不可删账本行/改冻结快照列/写 recipients/users.state/DDL）。
   **该脚本不在任何 CI glob 内**，需显式运行（命令与原始输出见证据页第 3 节）。

**跨线接口变更（有意且必要）**：为接入持久账本，packages/privacy 的 in-flight/egress 把账本访问统一
async/await（同步账本 ⇒ 持久账本必须 await，否则守卫会把 Promise 当记录、fail-closed 但功能不可用），
consent-pg/grant-pg 的 EgressRevoker 两方法改为返回 Promise 并 await。语义不变性：对同步实现
await 非 Promise 值即原值返回；相关既有用例 110/110 全绿，负例未放宽。回退：还原这四个文件的
async 化（但会失去持久账本支持，须与 ledger-pg 一并回退）。

**真 PG workflow 回归已修（本片）**：`auth-privacy-pg.mjs` / `consent-grant-pg.mjs` 曾在 CI 红
（`PROVIDER_UNAVAILABLE 授权服务暂不可用`）。真因：这两条链路所在的库**未施加 0011/未授予
`gengyun_egress_ledger`**，而本片让授权路径在"已有业务依赖"时调用撤回消费者 ⇒ 驱动错误被笼统
映射成 503。修法（fail-closed，**未改 CI、未放宽断言**）：账本新增"就绪探测"，
未就绪 ⇒ 契约内 `OBJECT_UNAVAILABLE`；`consent-pg`/`grant-pg` 对消费者失败**如实拒绝**
（要么真撤销，要么拒绝）。改后：`auth-privacy-pg` **26/26**、`consent-grant-pg` **27/27** 全绿，
原 `409` 负例逐字保留并升级为"消费者不可用时必须拒绝"的负控制。详见证据页第 3.2 节。

未取得：真实第三方外发（未授权，real 一律 503 且零 sent）、合成域(TTS)在途守卫（exports.object_id
为 uuid 与 checked_content_ref.id 不兼容 ⇒ 需 schema/契约决策；**该待办已由 GY-I27 第三片以迁移
0014 的 object_key 文本型对象标识列 + synthesis-egress.ts 接线完成**）、注销 HTTP 触发面（契约仍 planned）、
真实微信身份/真机、真实媒体存储、export_writebacks 的 7/30 日删除与恢复（GY-I19）、域名/网关/CDN。

门禁：lint / test:unit(1800，0 fail) / privacy+unit 冒烟组 110/110 / 真 PG 三支
（auth-privacy-pg 26/26、consent-grant-pg 27/27、egress-ledger-pg 11/11）/ 受影响域集成脚本
（recognitions/speech/ocr/tts/jobs-http EXIT=0）/ git diff --check。
```

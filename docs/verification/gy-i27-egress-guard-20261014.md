# GY-I27（#29）· 前置用途授权、外发账本与隐私撤回接口守卫 —— 剩余项证据

> **后续更新（接线单，2026-10-14）**：本页第 6 节曾把「协议未挂到路由/装配」列为未取得项。接线单
> （**用户明确授权**改他人已合并文件）已把**授权中间件**挂到 4 个 AI 执行入口与派生内容写面，
> 并把**撤回/授予消费者**接口接进 `consent-pg`/`grant-pg`；**外发账本与 `consumer.send` 派发仍未装配**
> （需持久 commitGate + 接收方读取口）。现状与未取得项以
> [接线单证据页](gy-i27-consent-wiring-20261014.md) 为准。

- **任务**：GY-I27（GitHub issue **#29**，P0／M1，验收 AC09／AC23／AC28／AC29）**剩余部分**
- **本轮交付**：真实外发消费者、在途守卫、全模块注销/删除注册协议 + 第三方删除接口、日志脱敏与错误码对齐
- **日期**：2026-10-14
- **分支**：`feat/gy-i27-egress-guard`
- **基线**：`upstream/main` = `ab5df72b6d4a0dbc6e1055bce39c0161fe10b2a4`
- **执行模式**：全部离线（内存账本 + 注入身份 + 替身传输/介质），**未发起任何付费或真实第三方调用**

## 1 为什么只做这些（承接监工关闭核对）

上一层（PR #45）已交付 `packages/privacy/**` 的账本与守卫；PR #120 已合 PG 写入回执 24h 子项。
监工本轮关闭核对逐字写明剩余：

> 完成／剩余：PG 授予/撤回回执修正已合；**真实外发消费者、在途守卫与全模块注销/删除恢复必要证据未齐。**

代码层面对应两处**可见**缺口（均在本轮修掉或给出消费者接口）：

| 位置 | 原文 | 性质 |
| --- | --- | --- |
| `services/api/src/privacy/consent-pg.ts:163`、`grant-pg.ts:84` | `已有资料或任务的撤回消费者尚未接入` ⇒ `OBJECT_UNAVAILABLE` | 缺"消费者"对象本身（正确的 fail-closed 兜底，但无人可注入） |
| `packages/privacy/deletion.mjs:309` | `hasWork = rows.length > 0 \|\| thirdParties.length > 0` | **部分模块报告完成即判整单 `completed`**（"全模块证据未齐"） |

**完整 7/30 日注销删除集成（对象存储／备份／供应商副本／恢复清单重放）属 GY-I19**，本片只交付
**协议与接口**，不实现删除、不注册 HTTP 路由。

## 2 交付物

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `packages/privacy/egress.mjs` | 新增 | 外发消费者协议：`createStubEgressTransport`／`createRealEgressTransport`（fail-closed）／`resolveEgressTransport`／`createEgressConsumer`（`reserve`/`send`/`dispatch`/`audit`）；`toContractExport`／`listExportsForUser`（契约 `Export`/`ExportPage` 形状） |
| `packages/privacy/in-flight.mjs` | 新增 | 在途守卫：`assertExecutable`／`assertSavable`／`cancelVersion`／`isVersionCancelled`／`saveResult`；`createEgressRevoker`（撤回/注销撤销在途外发的消费者接口） |
| `packages/privacy/deletion-modules.mjs` | 新增 | 全模块删除协议：`declareRequiredModules`／`registerModule`（闭集）／`missingModules`／`completionStatus`（未齐不判完成）／`receipt`（契约 `DeletionReceipt` 形状）／`thirdPartyStatuses` |
| `packages/privacy/ledger.mjs` | 增量 | 新增只读 `list({ userId, limit, cursor })`（keyset 游标，`createdAt desc, id desc`）；既有行为不变 |
| `packages/privacy/index.mjs` | 增量 | 导出三个新模块 |
| `packages/privacy/README.md` | 增量 | 新模块职责、装配/挂载表、边界与未接线项 |
| `services/api/src/privacy/egress.ts` | 新增 | HTTP 侧适配：`createConsentPreHandler`（Fastify preHandler）、`withPrivacyErrors`、`toApiError`、`createPrivacyEgress`、`createPrivacyInFlightGuard`、`createApiEgressRevoker`、`createPrivacyDeletionCoordinator` |
| `services/api/src/privacy/egress-reference.d.ts` | 新增 | 上述 `.mjs` 的形状声明（不改既有 `reference.d.ts`） |
| `tests/privacy/egress.test.mjs` | 新增 | 15 例 |
| `tests/privacy/in-flight.test.mjs` | 新增 | 13 例 |
| `tests/privacy/deletion-modules.test.mjs` | 新增 | 11 例 |
| `tests/unit/privacy-egress-http.test.mjs` | 新增 | 7 例 |

**未改动**（跨线或属其它任务线，按纪律不碰）：`services/api/src/app.ts`（GY-I02）、
`routes/*.ts`（各业务线）、`privacy/consent-pg.ts`／`privacy/grant-pg.ts`（`[GY-I04/27]` 共同线，
且需真实 PG 才能验证）、`packages/contracts/**`（冻结契约）、CI workflow。

## 3 契约对齐

| 本片输出 | 契约来源 | 断言位置 |
| --- | --- | --- |
| `Export`（`id`/`object_ref`/`purpose`/`recipient_id`/`consent_epoch`/`state`/`sent_at`/`deletion_state`） | `openapi.json components.schemas.Export`（`additionalProperties:false`、required 8 项） | `tests/privacy/egress.test.mjs`（逐字段 = required、枚举成员、`sent_at` 为 ISO 或 null） |
| `ExportPage`（`items` ≤ 50、`next_cursor` string\|null） | `components.schemas.ExportPage` | 同上（分页不重不漏、畸形游标 `INVALID_CURSOR`、`limit>50` ⇒ `INVALID_REQUEST`） |
| `DeletionReceipt` / `DeletionHandler` | `components.schemas.DeletionReceipt` / `DeletionHandler` | `tests/privacy/deletion-modules.test.mjs`（逐字段 = required、状态枚举成员） |
| 授权错误码 `CONSENT_REQUIRED`/`SCOPE_DENIED`/`ACCOUNT_INACTIVE`/`SESSION_REQUIRED`/`OBJECT_UNAVAILABLE`/`INVALID_CURSOR` | `states.json error_status_map` | `packages/privacy/constants.mjs`（既有 `tests/privacy/contract.test.mjs` 逐项比对）+ 本片 HTTP 断言（401/403/409/503） |
| `PROVIDER_UNAVAILABLE` = **503 + retryable:true** | `states.json error_status_map`（503 闭集） | `tests/privacy/egress.test.mjs`、`tests/unit/privacy-egress-http.test.mjs` |

`Export.state` 闭集为 `reserved/sent/failed/outcome_unknown`（**无 `succeeded`**）：账本条目形状不符时
`toContractExport` 抛 `PROVIDER_UNAVAILABLE`，**不输出自相矛盾条目**（与 PG 读取层同口径）。

## 4 装配说明（授权中间件挂在哪、守卫在哪调用）

`services/api/src/privacy/egress.ts` 文件头「挂载点」表即装配清单：

| 位置 | 挂什么 | 语义 |
| --- | --- | --- |
| 需用途授权的执行入口（`/speech/transcriptions`、`/recognitions/**`、`/ocr/**`、`/synthesis/**`、社区投稿） | `createConsentPreHandler(guard, { purpose, dataType })` 进 `preHandler`（会话层先填 `req.userId`/`req.authEpoch`） | 缺 `auth_epoch` ⇒ 401 `SESSION_REQUIRED`；非正整数 ⇒ 400 `INVALID_REQUEST`；旧版本/注销 ⇒ 403 `ACCOUNT_INACTIVE`；未授权 ⇒ 403 `CONSENT_REQUIRED`；错用途 ⇒ 403 `SCOPE_DENIED` |
| 外发派发 | `createPrivacyEgress({ executionMode, ledger }).consumer.send({ identity, objectType, objectId, objectRevision, dataType, purpose, recipientId, sourceVersion, payload })`（外层 `withPrivacyErrors`） | `transport.available!==true` ⇒ **任何账本变更之前** 503 `PROVIDER_UNAVAILABLE`(retryable)；`markSent` 同步原子边界是唯一权威判定（被拒 ⇒ **零外发**）；网络调用在临界区之外；失败落 `failed`/`outcome_unknown` |
| 任务执行前 | `createPrivacyInFlightGuard(...).assertExecutable({ exportId, userId })` | 重查账号 `auth_epoch` + 全部必需用途 `granted+epoch` |
| 结果保存前 | `...saveResult({ exportId, userId, objectVersion, result })` | 回调版本必须 = 预留版本；实际写入在账本原子临界区内（不过 ⇒ **零写入**） |
| 版本取消 | `...cancelVersion({ exportId, userId, objectVersion, reason })` | 只增不减墓碑 ⇒ 已取消版本不可复活；`reason` 只收短安全 token |
| 撤回/注销撤销在途 | `createApiEgressRevoker({ ledger })` 注入 `consent-pg.ts`／`grant-pg.ts` | `onConsentWithdrawn`（按用途）/`onAccountSuspendedOrDeleted`（全量）⇒ 在途外发 `failed`。**不注入 ⇒ 行为与今天逐字一致**（维持 `OBJECT_UNAVAILABLE` 兜底） |
| 全模块删除 | `createPrivacyDeletionCoordinator({ registry, requiredModules })` | 闭集外的模块不可注册；未齐不判完成 |

`real` 模式放行条件写死在装配处：`realTransportApproved === true` **且**注入已审真实传输；
否则消费者 `available=false`，`send`/`dispatch` 在账本之前 503。**不存在 "real 回退替身" 分支**。

## 5 关键原始输出

### 5.1 新增测试直跑（4 个文件合并一次运行）

```
> node --test tests/privacy/egress.test.mjs tests/privacy/in-flight.test.mjs tests/privacy/deletion-modules.test.mjs tests/unit/privacy-egress-http.test.mjs
ℹ tests 46
ℹ suites 0
ℹ pass 46
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 395.4091
```

### 5.2 real fail-closed 反例（说明）

`tests/privacy/egress.test.mjs`「real + 未接真实依赖 ⇒ fail-closed」：

```
✔ real + 未接真实依赖 ⇒ fail-closed：503 PROVIDER_UNAVAILABLE(retryable)、零外发、零账本变更 (0.3187ms)
```

反例内容：`executionMode='real'`、有完整用途授权（`recording`/`media_processing`/`external_inference`，
接收方已验证 `no_training_verified` + `deletion_verified`），仅因**真实外发适配器未接入**：

- 抛 `PrivacyError.code === 'PROVIDER_UNAVAILABLE'`，`err.status === 503`，`err.retryable === true`；
- 替身传输登记 `deliveries.length === 0`（**零外发**）；
- `ledger.list({ userId: 'u1' }).items.length === 0`（**零账本变更**，连 `reserved` 都不落）；
- `consumer.available === false`、`transport.kind === 'real'`、`transport.stub === false`
  （real 路径上**没有**替身）。

HTTP 侧同一反例（`tests/unit/privacy-egress-http.test.mjs`）：

```
✔ real 未接真实依赖 ⇒ 503 PROVIDER_UNAVAILABLE(retryable)：零外发、零账本变更，无成功封套 (2.3957ms)
```

断言 `statusCode===503`、`error.retryable===true`、`data===undefined`（无成功封套）、
`meta.execution_mode==='real'`，且账本仍为空。

**stub 对照**（同一路由、同一代码路径，仅执行模式不同）：

```
✔ stub 对照：同一路由在 stub 下可用，且回执/账本如实标注替身 (3.4593ms)
```

断言 `egress.stub === true`、`egress.label` 含「替身」、账本条目 `state==='sent'` 且
`recipientId` 如实。⇒ 替身只出现在**明确标注**的 `stub`/`preset_demo`，且不被记为真实成功。

### 5.3 零外发（无授权／错用途／撤回／注销）

```
✔ 无授权：send 抛 CONSENT_REQUIRED，且替身传输零调用、账本零记录 (1.6068ms)
✔ 错用途：send 抛 SCOPE_DENIED，且替身传输零调用 (0.4821ms)
✔ 撤回与任务竞争：撤回后派发被原子边界拒绝（零调用），记录不得被置 sent (0.432ms)
✔ 注销与任务竞争：auth_epoch 前进后派发被拒（零调用，ACCOUNT_INACTIVE） (0.4687ms)
✔ 重复派发被拒（零重复外发）：已 sent 的记录再次 dispatch 不再调用传输 (0.5267ms)
```

### 5.4 在途守卫与"取消版本不可复活"

```
✔ 任务执行前重查：授权撤回后 assertExecutable 拒绝（不得再起新工作） (2.0758ms)
✔ 保存前重查：撤回后 saveResult 阻断且**零写入**（介质无条目） (1.1164ms)
✔ 保存前重查：注销后 saveResult 阻断且零写入 (0.3758ms)
✔ 旧版本回调：objectVersion 与预留版本不一致 ⇒ 阻断且零写入 (0.3094ms)
✔ 取消版本不可被回调复活：cancelVersion 后回写阻断且零写入，重新授权亦不复活 (2.1822ms)
✔ 取消后 markSent 亦被阻断：已终态记录不可再派发 (0.5638ms)
✔ 撤回消费者接口：撤销在途外发后回写被阻断（新外发另由守卫阻断） (0.4791ms)
✔ 注销消费者接口：撤销该用户全部在途外发（含多条） (0.3248ms)
```

"重新授权亦不复活"是逐字断言：撤回 → 重新授权（epoch 前进 + `granted`）→ 用**同一 exportId +
同一版本**回写仍 `OBJECT_UNAVAILABLE` 且介质零写入。

### 5.5 账本登记（`userid`/`purpose`/`recipient`/`source_version`）

```
✔ 授权齐全：如实落账 userid/purpose/recipient/source_version，恰一次外发且审计为 sent (2.8953ms)
```

账本记录 `userId='u1'`、`purpose='external_inference'`、`recipientId='provider-llm'`、
`sourceVersion='asr-v1'`、`state='sent'`、`authEpoch=1`；审计轨迹一条 `sent`。

### 5.6 日志脱敏

```
✔ 日志脱敏：私有正文/精确坐标/凭据不进审计轨迹与日志出口 (0.4733ms)
```

输入负载含私有转写正文、`data:image/png;base64,...`、坐标对 `31.23041,121.47370`、
`lat`/`lng`、`access_token`、`providerRequestRefCipher`；断言审计轨迹 + `logSink` + 替身登记
`JSON.stringify` 后**均不含**上述任何片段，而非敏感维度（`recipientId`/`sourceVersion`）仍留痕。

### 5.7 全模块删除协议与第三方状态机

```
✔ 全模块未注册齐时不得受理删除请求（不假装能完成） (0.199ms)
✔ 闭集在创建任何请求之前声明，之后不可再改（不得按已有结果倒推清单） (0.622ms)
✔ **关键反例**：绕过协调器只报告部分模块时，整单不得判完成，且缺口可见 (0.3856ms)
✔ 回执与契约 DeletionReceipt / DeletionHandler 逐字段一致（含未报告模块） (0.4846ms)
✔ 第三方删除状态机：requested ≠ confirmed；确认必须有证据；失败/不支持保留阻塞 (0.7695ms)
```

"关键反例"复现了旧口径：直连 `deletion.mjs` 的注册表只注册 1 个模块并执行后，
`registry.completionStatus()` 返回 `completed: true`（**旧口径确实会把部分模块当全模块完成**）；
同一请求经协调器复核为 `completed: false`，`missingModules = ['conversations','media_objects']`，
且回执里这两个模块以 `pending/pending` 出现。

### 5.8 门禁

```
> npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。

> npm run test:unit
ℹ tests 1697
ℹ pass 1696
ℹ fail 0
ℹ skipped 1        # 既有 skip，与本片无关

> npm run test:contract
ℹ tests 6
ℹ pass 6
ℹ fail 0

> npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables

> git diff --check
（无输出 ⇒ 无空白错误）
```

`test:unit` 只增不破：基线 132 例 `tests/privacy/**` 全绿，加上本片 46 例后总数与通过数同步上升。

## 6 未取得 / 未验证（不得据本页声称已验证）

| # | 项 | 状态 | 原因 |
| --- | --- | --- | --- |
| 1 | **真实第三方外发**（真实 ASR/OCR/识别/LLM/TTS 供应商收件） | **未验证** | 本任务**未授权**真实外发与付费调用；`real` 一律 fail-closed（503） |
| 2 | **真实微信身份 / 真实登录会话** | **未验证** | 身份上下文由测试注入（这正是 issue #29 要求的"单元测试可注入身份上下文"）；本片不读 GY-I04 真实登录 |
| 3 | **真机 / 小程序端交互** | **未验证** | 本片为服务端协议与接口，无小程序改动 |
| 4 | **完整 7/30 日注销删除**（对象存储、备份、供应商副本、恢复清单重放） | **未验证**（属 **GY-I19**） | 本片只交付协议与接口；`deletion_tombstones`/`backup_inventory` 不在范围 |
| 5 | **PG17.11 实库验收**（账本/授权/删除回执落库） | **未验证** | 本片未新增实库适配器；`tests/integration/*-pg.mjs` 需 `CONSENT_GRANT_TEST_URL` 等本地 PG，**本轮未运行**（未声称通过） |
| 6 | **撤回/注销消费者接入 `consent-pg.ts`／`grant-pg.ts`** | **未接线** | 该文件为 `[GY-I04/27]` 共同线且改动需真实 PG 验证；本片交付 `createEgressRevoker` 接口与装配说明，**默认行为保持不变**（fail-closed 兜底） |
| 7 | **外发消费者挂到各 AI 域路由** | **未接线** | `routes/recognitions.ts`／`speech.ts`／`ocr.ts`／`synthesis.ts`／`app.ts` 属其它任务线已合并文件；本片交付协议 + HTTP 适配 + 挂载说明 |
| 8 | **`contract-status.json` / `contract-implementation-status.md` 状态更新** | **未改** | 本片未新增 HTTP 路由，`listExports`/`requestAccountDeletion`/`getDeletionReceipt` 仍为 `planned`（HTTP 装配属 GY-I19）；不改文档以免出现"已实现"的误导 |

## 7 剩余风险

1. **消费者未接线期间的"边界"**：`real` 模式下所有外发路径 503 fail-closed；
   但**没有任何 AI 域路由调用本消费者**，因此本片的"零外发"保证是**协议层**的，
   不是"生产路径已被守卫"。接线前，各 AI 域的现有守卫（GY-I09/I10/I11/I13 各自实现）仍生效，
   但与账本**未打通**（无 `exports` 登记）。
2. **撤回/注销撤销在途尚未生效**：`consent-pg.ts`／`grant-pg.ts` 仍以 `OBJECT_UNAVAILABLE`
   拒绝有依赖的撤回/授予；这是 fail-closed（不伪造取消成功），但用户侧表现为"暂不可撤回"。
   接入 `createEgressRevoker` 后才会真正撤销在途外发。
3. **内存提交门禁不等价于实库事务**：`ledger` 的原子性依赖单线程同步临界区；实库部署须在
   **单事务**内完成校验与写入（既有 README「提交一致性契约」已写明，本片未新增实库适配器）。
4. **账本读面为进程内内存**：`list()` 只在内存实现上验证；实库分页（含游标语义与限幅）待
   接线方实现时另验（本片未声称实库游标已验收）。
5. **`third_party_state` 在 `DeletionHandler` 中恒为 `null`**：第三方删除按**接收方**维度登记
   （`third_party_deletions.recipient_id`），与"模块"维度不是同一键；本片如实置 `null`，
   另提供 `thirdPartyStatuses(requestId)` 追溯。契约允许 `null`，但接线方若要在回执里显示，
   需先定义 recipient→module 的映射（属 GY-I19 集成决定）。
6. **`reason` 字段收敛**：`cancelVersion` 的 `reason` 仅接受 `[a-z0-9_:-]{1,40}`，自由文本
   回落为 `cancelled`；如需更丰富的原因文本，须先定义安全枚举（否则会把私有正文带进日志）。

## 8 PR 正文可粘贴段落

```
Refs #29（不关闭整项）

本轮只做监工关闭核对写明的剩余部分：真实外发消费者、在途守卫、全模块注销/删除注册协议与第三方删除接口。
完整 7/30 日注销删除集成（对象存储/备份/供应商副本/恢复清单重放）仍属 GY-I19，本片只交付协议与接口。

新增（全部离线可跑，无真实外发、无付费调用）：
- packages/privacy/egress.mjs   外发消费者协议：real 未接真实适配器 ⇒ fail-closed（PROVIDER_UNAVAILABLE/503/retryable），
                                无授权/错用途/撤回/注销 ⇒ 断言"零调用"；stub/preset_demo 替身明确标注；
                                账本读面输出契约 Export/ExportPage 形状。
- packages/privacy/in-flight.mjs 在途守卫：任务执行前/保存前重查授权与账号状态；取消版本墓碑只增不减
                                （已取消版本不可被回调复活，即使重新授权）；createEgressRevoker 提供撤回/注销
                                撤销在途外发的消费者接口（默认不注入 ⇒ 既有 fail-closed 兜底行为不变）。
- packages/privacy/deletion-modules.mjs 全模块闭集协议：受理前声明必需模块、闭集外不可注册、
                                任一必需模块未报告 ⇒ 不判 completed（旧口径"部分模块也算完成"的反例见测试）。
- services/api/src/privacy/egress.ts   HTTP 适配（preHandler / withPrivacyErrors / toApiError）与装配说明。
- 新增 46 例测试（tests/privacy/{egress,in-flight,deletion-modules}.test.mjs、tests/unit/privacy-egress-http.test.mjs），
  含 real fail-closed 反例与 stub 对照。

门禁：lint / test:unit（1697 例，0 fail）/ test:contract（6 例，0 fail）/ test:docs / git diff --check。

未取得（不在本 PR 声称）：真实第三方外发、真实微信身份、真机、7/30 日完整删除集成（GY-I19）、
PG17.11 实库验收；撤回/注销消费者接入 consent-pg.ts/grant-pg.ts 与外发消费者挂到各 AI 域路由
（均为其它任务线的已合并文件）仍未接线，装配点与调用位置已在 egress.ts 与 packages/privacy/README.md 写明。
```

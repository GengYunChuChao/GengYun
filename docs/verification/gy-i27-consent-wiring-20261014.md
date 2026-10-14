# GY-I27（#29）· **用途授权接线单**证据 —— 授权中间件挂到 AI 域 + 撤回/授予消费者接线

- **任务**：GY-I27（issue **#29**）接线单：承接已合并的协议层（PR #128 / `1fc0308`），把用途授权接到线上
- **前提**：**用户 2026-10-14 明确授权修改"其他任务线已合并的文件"**（本页第 4 节逐处披露）
- **日期**：2026-10-14
- **分支**：`feat/gy-i27-egress-guard`
- **基线**：合并 `upstream/main` = `a15a7f1`（本片开工时 main 的 SHA）
- **执行模式**：全部离线（合成身份 + 内存 store + 替身提供者）；**未发起任何真实外发、未连接数据库、未产生费用**

## 1 本单做了什么（最小且可验证）

| # | 目标 | 结果 |
| --- | --- | --- |
| 1 | 撤回/注销消费者接线（撤掉 `OBJECT_UNAVAILABLE` 兜底） | `consent-pg.ts` / `grant-pg.ts` 新增**可选** `egressRevoker`；注入后撤回/授予**先撤销在途外发再继续**；**未注入 ⇒ 既有行为逐字不变** |
| 2 | 授权中间件挂到 AI 域执行入口 | `ConsentGate` 挂到 `POST /recognitions`、`POST /speech/transcriptions`、`POST /ocr`、`POST /speech/synthesis` **及其派生内容写面**；`app.ts` 追加式装配 |
| 3 | 外发派发经 `consumer.send(...)` | **未接线**（见第 5 节）：账本需持久 commitGate + 接收方读取口，本片未提供 ⇒ 不装配，`real` 保持 fail-closed |
| 4 | 不扩大范围 | 未碰 `packages/contracts/**`、未改 CI workflow、**未做任何域名/网关/CDN/自定义域名相关内容** |

## 2 挂载点（接线后的事实）

| 路由 | 资料类型 / 用途 | 挂中间件？ |
| --- | --- | --- |
| `POST /recognitions` | `weed_recognition` ⇒ `media_processing` + `external_inference` | ✅ |
| `PATCH /recognitions/{id}/selection`（派生内容写面） | 同上 | ✅ |
| `POST /speech/transcriptions` | `voice_question` ⇒ `recording` + `media_processing` + `external_inference` | ✅ |
| `PATCH /speech/transcriptions/{id}/confirmation` | 同上 | ✅ |
| `POST /ocr` | `label_ocr` ⇒ `media_processing` + `external_inference` | ✅ |
| `PATCH /ocr/{id}/correction`、`POST /ocr/{id}/verify` | 同上 | ✅ |
| `POST /speech/synthesis` | 用途 `external_inference`（TTS **不属**四类媒体资料类型 ⇒ 不声明 `data_type`，不做「错用途」判定） | ✅ |
| `GET /recognitions/{id}`、`GET /ocr/{id}`、`GET /speech/transcriptions/{id}`、`DELETE ...` | — | ❌ **有意不挂**：撤回后用户仍须能取回并删除自己的数据 |
| `GET /me/consents` 等授权面 | — | 不变（既有 `guards.requireUser` + 服务层事务） |

**装配解析顺序**（`app.ts`，一处）：注入 `privacyInjection.consent` 优先；否则 `pool !== null` 时用
`createPostgresConsentGate(createPostgresConsentService(pool, key))`（复用**已合并**的
`consent-pg.requireConsent` 单事务读取口，**不新写 SQL、不新造事实源**）；都没有 ⇒ 不挂。

## 3 关键原始输出

### 3.1 新增接线测试（10 例，直接运行）

```
> node --test tests/unit/privacy-consent-wiring.test.mjs
✔ 接线生效·无授权 ⇒ 403 CONSENT_REQUIRED；未登录仍 401（鉴权顺序不变）
✔ 接线生效·错用途 ⇒ 403 SCOPE_DENIED（用途与资料类型不匹配的装配必须在 HTTP 面被拒）
✔ 接线生效·撤回用途后写面被阻断且**零写入**（GET revision 不变），读取与删除不受限
✔ 可回退对照·未注入授权中间件 ⇒ 无授权也能受理（既有行为逐字不变）
✔ 接线生效·四个 AI 执行入口都挂了中间件（转写/标签 OCR/合成 与识别同一口径）
✔ 生产解析·配置了数据库（未注入）⇒ 中间件自动挂上；授权读取不可用 ⇒ fail-closed 503 不放行
✔ 撤回接线·注入 egressRevoker ⇒ 先撤销在途外发再完成撤回（合成 PG 替身）
✔ 可回退对照·撤回未注入 egressRevoker ⇒ 既有 OBJECT_UNAVAILABLE 兜底逐字不变
✔ 授予接线·注入 egressRevoker ⇒ 已有依赖时先撤销在途外发再写新 epoch
✔ 可回退对照·授予未注入 egressRevoker ⇒ 既有 OBJECT_UNAVAILABLE 兜底逐字不变
ℹ tests 10   ℹ pass 10   ℹ fail 0
```

### 3.2 「撤回后零写入」改前/改后对照（本单的核心增量）

同一用例（`接线生效·撤回用途后写面被阻断且**零写入**`）内的**改前**与**改后**两次写面调用：

```
改前（已授权）：PATCH /api/v1/recognitions/{id}/selection
  → 200；随后 GET → revision = 2（较受理后 1 前进 ⇒ 写面确实生效）
改后（撤回 external_inference 之后，同一路由、同一 If-Match 版本头）：
  → 403 CONSENT_REQUIRED（body.data === undefined）
  → 随后 GET → revision = 2（**与撤回前完全一致 ⇒ 零写入**）
撤回后新任务受理：POST /api/v1/recognitions → 403 CONSENT_REQUIRED（不得再外发）
负向对照（有意不挂）：DELETE /api/v1/recognitions/{id} → 202（用户仍能删除自己的数据）
```

「零写入」的判据是**服务端资源 revision 不变**（写面在 `preHandler` 阶段即被拒 ⇒ 处理器未执行）。
该断言在**改前**（无中间件）会因 revision 前进而失败 —— 即：这条增量是接线带来的，不是既有行为。

### 3.3 未注入 ⇒ 既有行为不变（可回退对照）

```
✔ 可回退对照·未注入授权中间件 ⇒ 无授权也能受理（既有行为逐字不变）
    POST /api/v1/recognitions（无任何授权）→ 202，data.state = 'queued'
✔ 可回退对照·撤回未注入 egressRevoker ⇒ 既有 OBJECT_UNAVAILABLE 兜底逐字不变
✔ 可回退对照·授予未注入 egressRevoker ⇒ 既有 OBJECT_UNAVAILABLE 兜底逐字不变
    （且兜底路径**不写入任何撤回**：断言未出现 UPDATE public.consent_records）
```

### 3.4 real fail-closed 在生产解析路径上仍成立

```
✔ 生产解析·配置了数据库（未注入）⇒ 中间件自动挂上；授权读取不可用 ⇒ fail-closed 503 不放行
    不可达 pool + stub 模式：POST /recognitions → 503 PROVIDER_UNAVAILABLE，data === undefined
    （断言确实尝试读取授权 ⇒ 证明中间件已挂上；读不到授权**不放行**）
```

### 3.5 受影响域既有测试（`tests/integration/*-http.mjs`，全部在改后重跑）

```
> node tests/integration/recognitions-http.mjs   → EXIT=0
> node tests/integration/speech-http.mjs         → EXIT=0（PASS 11 组）
> node tests/integration/ocr-http.mjs            → EXIT=0（PASS 11 组）
> node tests/integration/tts-http.mjs            → EXIT=0（RESULT=PASS）
> node tests/integration/jobs-http.mjs           → EXIT=0
```

### 3.6 门禁

```
> npm run lint            → PASS（tsc services/api + apps/admin + 卫生扫描）
> npm run test:unit       → tests 1746 / pass 1745 / fail 0 / skipped 1（既有 skip）
> npm run test:contract   → tests 6 / pass 6 / fail 0
> npm run test:docs       → PASS: 27 initial tasks; … Markdown links and tables
> git diff --check        → 无输出
```

## 4 跨线改动披露（**用户 2026-10-14 授权改他人已合并文件**）

| 文件（原属任务线） | 改了什么 | 为什么最小 | 如何回退 |
| --- | --- | --- | --- |
| `services/api/src/app.ts`（GY-I02 装配） | 新增可选 `privacyInjection`；**一处**解析 `consentGate`/`egressRevoker`；4 个 `register*` 调用各追加一个参数；`registerConsentRoutes` 的 options 追加 `egressRevoker` | 只追加、不改既有分支；解析逻辑集中在一处（13 行） | 删除 `privacyInjection` 相关 3 行 + 4 个参数即可回到原状（不传即不挂） |
| `services/api/src/privacy/consent-pg.ts`（GY-I04/27 共同线） | 服务 options 追加 `egressRevoker?`（并重命名形参 `options`→`serviceOptions` 以消除与 `withdraw` 局部形参的遮蔽）；撤回路径：有依赖时**有消费者则撤销在途并继续**，无消费者则保持原 `OBJECT_UNAVAILABLE` | 缺省不注入 ⇒ 行为逐字不变；仅把原来的"直接抛"改为"有消费者时先撤销" | 不注入 `egressRevoker` 即完全回退；或 `git revert` 本提交该文件 |
| `services/api/src/privacy/grant-pg.ts`（同上） | `persistConsentGrant` 追加**第 6 个可选参数** `egressRevoker = null`；有依赖时同口径处理 | 新增参数**可选且默认 null** ⇒ 既有调用点（含测试）语义不变 | 同上 |
| `services/api/src/routes/consent.ts`→`consents.ts`（GY-I04/27） | `testOptions` 类型追加 `egressRevoker?` 并透传 | 类型面追加，无行为变化 | 同上 |
| `services/api/src/routes/recognitions.ts`（GY-I09） | 第 5 个可选参数 `deps.consent`；`POST` 与 `PATCH .../selection` 的 `preHandler` 变为 `[requireUser, gate]` | 未注入 ⇒ 原 `guards.requireUser` 单值，逐字不变 | 不注入 `consent` 即回退 |
| `services/api/src/routes/speech.ts`（GY-I11） | `SpeechRouteDeps` 追加 `consent?`；`POST` 与 `PATCH .../confirmation` 经 `gated(schema)` 装配 | 同上（`gated()` 在无注入时等于原写法的单值） | 同上 |
| `services/api/src/routes/ocr.ts`（GY-I10） | `OcrRouteDeps` 追加 `consent?`；`POST /ocr`、`PATCH .../correction`、`POST .../verify` 经 `gated(schema)` | 同上 | 同上 |
| `services/api/src/routes/synthesis.ts`（GY-I13） | 追加第 5 个**可选**参数 `consent?`；`POST /speech/synthesis` 的 `preHandler` 条件装配 | 同上 | 同上 |
| `tests/integration/speech-http.mjs`（GY-I11） | 结构证据：原来断言注册行**字符串完全相等**；改为解析该行、要求保留原 5 个字段 + 只允许追加 `consent` 键（并断言无其它注入键） | 该断言**因本单合法改动而失效**，故按其原意（零提供者端口注入）更新；意图不变、更严格 | `git revert` 该文件 |
| `tests/integration/ocr-http.mjs`（GY-I10） | 同上：期望注册行改为 `{ guards, consent: consentGate }` | 同上 | 同上 |
| `tests/integration/tts-http.mjs`（GY-I13） | 同上：注册行匹配串追加 `, consentGate`（仍断言**恰好一处**调用） | 同上 | 同上 |

**未改**：`packages/contracts/**`、`.github/workflows/**`、`packages/privacy/**` 的实现（仅 README 文档更新）、
`deploy/**`、任何域名/网关/CDN 相关文件。

## 5 未取得 / 未验证（不得据本页声称已完成）

| # | 项 | 状态 | 原因 |
| --- | --- | --- | --- |
| 1 | **真实 PG17.11 上的撤回/授予接线执行** | **未验证** | 本机无可用 PostgreSQL（`127.0.0.1:5432` 未监听、无 PG 客户端工具）；`tests/integration/consent-grant-pg.mjs` 需 `CONSENT_GRANT_TEST_URL` ⇒ **本轮未运行**。第 3.1 节的撤回/授予用例使用**明确标注的合成 PG 替身**（canned `query`），只证明**接线路径**，不证明 SQL/事务在实库上的行为 |
| 2 | **HTTP 撤回面（`DELETE /me/consents/{purpose}`）经中间件的端到端** | **未验证** | 该路由要求 `pool !== null`；无 PG 时不可达。测试中的"撤回"直接作用于注入的授权存储（合成撤回） |
| 3 | **外发账本装配 / 真实外发派发经 `consumer.send`** | **未接线** | 账本需**持久** commitGate（单事务 + 行锁；内存参考实现要求同步快照）与接收方读取口，本片未提供该适配器；`app.ts` 因此不装配账本 ⇒ `real` 仍 fail-closed 503，也**不产生**任何 `sent` 记录（不把替身记为真实外发） |
| 4 | **任务执行前 `assertExecutable` / 保存前 `saveResult` / `cancelVersion` 的路由级接线** | **未接线** | 依赖第 3 项账本；且任务的真实提供者调用发生在各域异步服务内部（提供者接口不带身份上下文），路由层无法替其保存结果 |
| 5 | **注销（account deletion）消费者触发** | **未接线** | 契约 `requestAccountDeletion` 仍为 `planned`（属 GY-I19）；`onAccountSuspendedOrDeleted` 接口已交付并单测，但无 HTTP 触发点 |
| 6 | **真实第三方外发、真实微信身份、真机** | **未验证** | 本单不做且未授权；身份为合成替身 |
| 7 | **域名/网关/CDN/自定义域名** | **未做** | 用户明确暂不做，本单未涉及任何相关文件 |

## 6 剩余风险

1. **生产解析依赖数据库可用性**：配置了 `DATABASE_URL` 后中间件即挂上；授权读取失败 ⇒ 503 fail-closed
   （不会放行），但会让 AI 执行入口在授权库故障时整体不可用 —— 这是**有意的**方向（宁拒绝不放行）。
2. **撤回事务内的"多撤"**：`egressRevoker.onConsentWithdrawn` 在事务内调用，若事务回滚会多撤销在途外发；
   方向是更安全的一侧（禁止外发）且 `revokeInFlight` 幂等。实库验证（未做）应确认这一取舍可接受。
3. **未注入时的兜底语义**：没有账本时撤回仍以 `OBJECT_UNAVAILABLE` 拒绝（用户可见"暂不可撤回"）；
   这是 fail-closed，不是功能完成。
4. **三个集成脚本的结构断言被更新**：它们原本以"注册行字符串完全相等"来证明零端口注入；
   本单按其原意改成"保留原字段 + 只允许追加隐私域 `consent` 键"，并额外断言**没有其它注入键**。
   若监工认为这种结构断言必须由原作者维护，可要求把该断言移回原所有者或删除。
5. **TTS 只按用途判定**：`POST /speech/synthesis` 不做「错用途」判定（TTS 输出不属四类媒体资料类型），
   因此它只校验 `external_inference` 是否授予；合成内容本身仍由既有核对链路把关（未改）。
6. **合成 PG 替身的边界**：第 3.1 节的撤回/授予用例只覆盖"接线是否被调用、兜底是否保留"，
   SQL 形状由替身 canned 结果提供 —— **任何 SQL 层缺陷都不会被该用例发现**。

## 7 PR 正文可粘贴段落

```
Refs #29（不关闭整项）。承接已合并的协议层（PR #128），本轮把用途授权**接到线上**；
用户 2026-10-14 明确授权修改其它任务线已合并文件，跨线改动逐处披露于证据页第 4 节。

1) 撤回/授予消费者接线：consent-pg.ts / grant-pg.ts 新增**可选** egressRevoker；注入后撤回/授予
   先撤销在途外发再继续；**未注入 ⇒ 既有 OBJECT_UNAVAILABLE 兜底行为逐字不变**（可回退对照有测试）。
2) 授权中间件挂到 AI 执行入口：POST /recognitions、POST /speech/transcriptions、POST /ocr、
   POST /speech/synthesis 及其派生内容写面（选择/确认/校正/核对）；**GET 与 DELETE 有意不挂**
   （撤回后用户仍须能取回并删除自己的数据）。装配解析：注入优先，否则配置了数据库时复用已合并的
   consent-pg.requireConsent 单事务读取口（不新写 SQL），都没有则不挂 —— 既有集成脚本行为不变。
3) 未接线（如实声明）：外发账本与 consumer.send 派发、assertExecutable/saveResult/cancelVersion、
   注销消费者触发 —— 均需持久账本适配器（单事务 commitGate + 接收方读取口），本片未提供；
   real 模式因此始终 fail-closed 503，不产生任何 sent 记录。
4) 未取得/未验证：真实 PG17.11 上的撤回/授予接线执行（本机无 PG，consent-grant-pg 脚本未运行；
   接线用例使用明确标注的合成 PG 替身）、HTTP 撤回面端到端、真实第三方外发、真实微信身份、真机；
   域名/网关/CDN 相关一律未做。

测试：新增 tests/unit/privacy-consent-wiring.test.mjs（10 例，含"撤回后零写入（revision 不变）"改前/改后对照、
未注入对照、生产解析 fail-closed）；受影响域集成脚本重跑：recognitions-http / speech-http / ocr-http /
tts-http / jobs-http 全部 EXIT=0。门禁：lint / test:unit（1746，0 fail）/ test:contract / test:docs /
git diff --check 全绿。
```

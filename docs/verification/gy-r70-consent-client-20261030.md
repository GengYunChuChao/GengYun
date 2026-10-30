# GY-R70 · 客户端「用途授予 / 撤回」接线（2026-10-30）

> **一句话**：`miniprogram/utils/consent-api.js` 从"只读一条 `GET`"扩成**读清单 + 授予 + 撤回 + 政策读面**四条，
> `pages/consent` 从只读页变成**可授予、可撤回**的页（撤回二次确认并逐用途写清代价），
> `pages/profile` 的「可以随时撤回」这句承诺**重新成立且写准了边界**。
> 本页同时如实登记：本地 stub 下**没有真实政策行**，所以本片证的是"客户端按契约调用 + 失败路径如实呈现"，
> **不是**"真机授予/撤回链路已验"。见 §7。

## 1. 基线与范围

- 基线：`upstream/main` = `c609ce7f`（本片工作树 `E:\GengYunCommander\wt-r70-consent-ui`，分支 `feat/gy-r70-consent-client`，从 `c609ce7f` 拉出）。
- 范围：只动 `miniprogram/**`、`tests/**`、`docs/**`。**零** `services/api/src/**` 改动 ⇒ 不需要 `--reanchor`，也不挪任何既有台账锚点。
- 起点状态（逐行实测，就是本片要消掉的"承诺与实现不一致"）：`miniprogram/pages/consent/consent.js:1` 头注写「只读」；
  `miniprogram/pages/consent/consent.wxml` 原文写「本页只读：授予与撤回……尚未接入，所以这里没有开关」；
  `miniprogram/utils/consent-api.js` 头注写「本片只实现契约里的 `GET /me/consents`」；
  `miniprogram/pages/profile/profile.wxml:184`（改前行号）写「授予与撤回入口尚未接入」。服务端三条接口则**早就在**。

## 2. 契约逐项复述（**按代码读出来的**，不是按派单抄的）

| 项 | 代码事实 | 证据锚点 |
| --- | --- | --- |
| `POST /me/consents` 请求体 | `purpose` + `policy_version` + `recipient_ids` **三者全必填**，`additionalProperties: false`；`purpose` 是闭集 `recording/media_processing/external_inference/public_posting`；`policy_version` 1..80；`recipient_ids` ≤30 项、去重、每项 1..80 | `services/api/src/routes/consents.ts:38-53`、`services/api/src/privacy/grant-pg.ts:33-39` |
| `Idempotency-Key` | **只看长度**：`< 8` 或 `> 128` ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`；**没有字符集约束**。`POST` 与 `DELETE` 都必填 | `services/api/src/routes/consents.ts:50`、`services/api/src/routes/consents.ts:72`、`services/api/src/privacy/grant-pg.ts:39` |
| `POST` 无可用政策 | 找不到 `enabled AND reviewed_at<=now AND valid_from<=now AND valid_until>now` 的政策行 ⇒ **403 `CONSENT_REQUIRED`**「没有可用的已核验用途政策」；`source_kind`/证据不符同样是 403 `CONSENT_REQUIRED`（"来源尚未核验"/"接收方核验证据不可用"） | `services/api/src/privacy/grant-pg.ts:49`、`services/api/src/privacy/grant-pg.ts:53`、`services/api/src/privacy/grant-pg.ts:63` |
| `POST` 政策版本不符 | `policy.policy_version !== body.policy_version` ⇒ **409 `REVISION_CONFLICT`**（不是 403） | `services/api/src/privacy/grant-pg.ts:54` |
| `POST` external_inference | `recipient_ids` 为空 ⇒ 403 `CONSENT_REQUIRED`「对外推理需要已核验接收方」 | `services/api/src/privacy/grant-pg.ts:60` |
| `DELETE` 缺 `If-Match` | 路由层在**调服务之前**抛 `REVISION_REQUIRED` ⇒ **428**；`If-Match` 存在但格式不是 `^"[1-9][0-9]*"$` ⇒ 400 `INVALID_REQUEST` | `services/api/src/routes/consents.ts:74`、`services/api/src/routes/consents.ts:75` |
| `DELETE` 版本不符 | 记录当前 `revision` 与 `If-Match` 不等 ⇒ **409 `REVISION_CONFLICT`**；**不是** 404 | `services/api/src/privacy/consent-pg.ts:170` |
| `DELETE` 该用途没有当前记录 | `NOT_FOUND`（**404**）「没有该用途授权记录」 | `services/api/src/privacy/consent-pg.ts:167` |
| `DELETE` 有业务依赖 | `media`/`exports`/`author_links` 任一存在且撤回消费者未接 ⇒ **409 `OBJECT_UNAVAILABLE`**（拒绝只撤一半）；接了就**先撤销在途外发**再撤回 | `services/api/src/privacy/consent-pg.ts:174-186` |
| 错误码 → HTTP | `CONSENT_REQUIRED`/`SCOPE_DENIED`/`ACCOUNT_INACTIVE` → 403；`NOT_FOUND` → 404；`REVISION_CONFLICT`/`IDEMPOTENCY_CONFLICT`/`OBJECT_UNAVAILABLE` → 409；**`REVISION_REQUIRED` → 428**；`PROVIDER_UNAVAILABLE` → 503 | `services/api/src/contract.ts:15-23` |
| `GET /me/consents` 空页 | `{ items: [], next_cursor: null }`（200；空列表是"确实 0 条"，不是错误） | `services/api/src/privacy/consent-pagination.ts`、本片 `tests/unit/miniprogram-consent-grant-withdraw.test.mjs:549` |
| 政策读面（授予体的版本来源） | `GET /me/privacy-policy` → `{version, purposes[], recipients[], training_enabled:false}`；**无政策行 ⇒ 200 + `version: "unpublished"`**（诚实空态，不是 4xx）；无连接池 ⇒ 503 | `services/api/src/privacy/privacy-policy.ts:37-44`、`services/api/src/routes/consents.ts:90-97` |
| 撤回是否真能撤销在途 | 仅当装配方注入 `egressRevoker`（`executionMode === 'real'` 且账本存在）时才注入；否则仍 409 兜底 | `services/api/src/app.ts:1017-1019` |
| 用途 × 资料类型必需集合 | `voice_question` 需 `recording + media_processing + external_inference`；`community_image` 需 `media_processing + public_posting + external_inference` | `packages/privacy/constants.mjs:90-95` |

**⚠ 与派单文字不一致的两处（以代码为准，请裁定口径）**：

1. 派单写"`DELETE` 的 `If-Match` 给错的 ⇒ **404**"。代码里 **404 = 该用途没有当前授权记录**（`consent-pg.ts:167`），
   **给错版本 = 409 `REVISION_CONFLICT`**（`consent-pg.ts:170`）。本片按代码实现：428 自动补取、409 原样透出并要求重读，
   两者**没有**被糊成一句"失败"（见 `miniprogram/utils/consent-api.js:491` 与 `tests/unit/miniprogram-consent-grant-withdraw.test.mjs:319`）。
2. 派单说"`Idempotency-Key` 格式与范围（既有实现是 8..128）"——代码里**只有长度**，没有任何字符集/前缀要求；
   服务端也不校验格式。本片客户端生成的键是 `consent-grant-<36进制时间戳>-<8位随机>`（≈30 字符），落在 8..128 内。

## 3. 改了什么

| 文件 | 改动 | 证据锚点 |
| --- | --- | --- |
| `miniprogram/utils/consent-api.js` | `send()` 支持 `expect` 状态、请求体与 `Idempotency-Key`/`If-Match` 头；错误对象带 `status`/`retryable` 而 `code` 原样；新增 `readPolicy`/`grant`/`withdraw`/`newIdempotencyKey`/`grantAvailability`/`actionMessage`/`blockingReason`；`consentView` 透出 `revision`/`epoch`；头注从"只读"改写为四条接口与三条纪律 | `miniprogram/utils/consent-api.js:177`、`:372`、`:440`、`:491`、`:576` |
| `miniprogram/pages/consent/consent.js` | 四行开关（闭集四用途各一行）、`WITHDRAW_COST` 逐用途代价文案、`buildRows` 计算可用性、`onGrant`（幂等键按动作复用）、`onWithdraw`（二次确认 + 世代守卫）、`loadPolicy`、`onRefresh` 清本地阻塞与键 | `miniprogram/pages/consent/consent.js:69`、`:241`、`:315`、`:370` |
| `miniprogram/pages/consent/consent.wxml` | 删掉「本页只读」「所以这里没有开关」；新增「用途授权」区（每行状态 + 可用性原因 + 上次失败原因 + 服务端码 + 动作按钮）、政策版本说明、四条"关于这份清单"补充说明 | 路径同上；`wxml` 不在锚点工具的目标后缀内，故这一行只给路径、不给行号 |
| `miniprogram/pages/consent/consent.wxss` | 头注去掉"只读"；新增用途行的左右分栏与三类文字样式（一律取 `styles/tokens.wxss` 变量） | `miniprogram/pages/consent/consent.wxss:1` |
| `miniprogram/pages/profile/profile.wxml` | 隐私说明改准：`可以随时撤回` **重新写回**但注明边界（只有服务端有可用政策的用途可授予；没有就置灰说明）；新增长期成立的一条（系统权限由微信询问，本页不能替用户开关）；入口行「只读查看」→「查看与撤回」，`aria-label` 与说明同步 | 路径同上；`wxml` 不在锚点目标后缀内，只给路径、不给行号 |
| `miniprogram/utils/identify-api.js` | `CONSENT_REQUIRED` 文案从「应用内授权入口尚未接入」改为指向「我的 · 授权清单」，并明确"没有可用政策的用途会置灰"；同文件两处"措辞红线"注释同步（**仍不写「去授权」**，因为识别页那个按钮只重试本次操作） | `miniprogram/utils/identify-api.js:970` |
| `miniprogram/pages/identify/identify.wxml` | 只改注释里的"措辞红线"依据（原文引用的前提已过期） | `miniprogram/pages/identify/identify.wxml:325` |
| `tests/unit/miniprogram-consent-grant-withdraw.test.mjs` | 新增 18 条：契约形状 / 幂等键 / 428 补取 / 置灰不重发 / 非乐观 / 空清单与读面失败 / 码原样 | 全文 592 行 |

## 4. 三个 API 的行为表（客户端层 `miniprogram/utils/consent-api.js`）

| 行为 | 入参 | 发什么 | 成功返回 | 失败时 |
| --- | --- | --- | --- | --- |
| `listConsents` | `{ cursor?, limit? }` | `GET /me/consents?limit=20`（空 cursor 不拼，服务端会把空游标判非法） | `{ items, nextCursor, mode }`，DTO 逐字段核对 | 服务端 `error.code` 原样 reject；401/403 交 `auth.failureFor` 归因 |
| `readPolicy` | 无 | `GET /me/privacy-policy` | `{ policy: { version, published, purposes, recipients, trainingEnabled }, mode }`；`version==='unpublished'` ⇒ `published:false` | 形状不符 ⇒ `INVALID_RESPONSE`；503 ⇒ `PROVIDER_UNAVAILABLE` 原样 |
| `grant` | `{ purpose, policyVersion, recipientIds?, idempotencyKey? }` | `POST /me/consents`，体恰为 `{purpose, policy_version, recipient_ids}`，头带 `Idempotency-Key`（8..128），**不带** `If-Match` | `{ consent, revision, mode, status:201, idempotencyKey }` | 缺省键只生成**一次**并随返回值带回；同一次动作重试必须传回同一个键（换键 = 换意图 → 服务端 `409 IDEMPOTENCY_CONFLICT`）；403/409/400/503 码原样 |
| `withdraw` | `{ purpose, idempotencyKey? }` | ① `GET /me/consents?limit=50` 取该用途**当前 revision** ⇒ ② `DELETE /me/consents/{purpose}`，头带 `If-Match: "<revision>"` + `Idempotency-Key` | `{ consent, revision, mode, status:200, idempotencyKey, refetches }` | **428 `REVISION_REQUIRED`** ⇒ 补取一次 revision 再重试（`refetches:1`）；补取也失败 ⇒ 抛**补取自己的码**并留 `refetchFailedAfter`，⛔ 不再重试；428 以外（409/404/403）不补取、原样抛；清单里没有该用途的当前记录 ⇒ 客户端前置码 `NOT_GRANTED`，**不发** DELETE |

**幂等键的生命周期（页面层 `miniprogram/pages/consent/consent.js:262`）**：一次点击 = 一次动作 = 一个键；
失败但可重试（`NETWORK_UNCERTAIN` / `REVISION_CONFLICT`）时**保留**同一个键；成功或判定为"做不成"（置灰类）时**丢弃**；
`重新读取` 清空所有键。测试钉住"同动作同键 / 新动作新键"（`tests/unit/miniprogram-consent-grant-withdraw.test.mjs:420`）。

## 5. 界面四态

| 态 | 触发条件 | 界面表现 | 会不会发请求 |
| --- | --- | --- | --- |
| 可授予 | 该用途在政策 `purposes` 内、`version !== 'unpublished'`、清单读到了、不是 `external_inference` | 行内「当前状态 未授权/已撤回」+ 按钮「授予」可点 | 点击才发 `POST` |
| 可撤回 | 清单里该用途 `state === 'granted'` | 行内「当前状态 已授权」+ 按钮「撤回」可点 | 点击 ⇒ 弹二次确认 ⇒ 确认后才发 `GET`+`DELETE` |
| 置灰 + 原因 | 政策没读到 / `unpublished` / `purposes` 不含它 / `external_inference`（必须选已核验接收方）/ 清单没读到（不知道当前状态）/ 服务端回 403 `CONSENT_REQUIRED`、409 `OBJECT_UNAVAILABLE`、503/504、撤回 404 `NOT_FOUND` | 按钮 `disabled`，行内「不可用：<原因>」点名**为什么**并带服务端码 | **不发**；置灰后再点也不发（测试 `...:397` 断言请求数不变） |
| 失败保持原状 | 写请求失败且不属于置灰类（`NETWORK_UNCERTAIN` / `REVISION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / 响应无法核对） | 状态**不翻**；行内「上次操作未完成：<真实原因>」+「服务端错误码 <CODE>」；按钮仍可再试 | 只有用户再点时发 |

⛔ **非乐观**：写成功后**再发一次 `GET` 重新读清单**，四个开关以服务端返回为准；写完的响应体只用于把
revision 写进说明文字，不用来改状态。测试 `...:372` 断言"在飞时该行 `state` 仍是 `none`"。

**撤回代价文案按用途分别写（`miniprogram/pages/consent/consent.js:42`）**，每一条都对得上服务端的真实判定点：

- `recording`：`voice_question` 的必需集合含 `recording` ⇒ 语音提问外发被 403 拒；**本机录音入口不受影响**（只说"问不出去"）。
- `media_processing`：媒体上传按 `media_processing` 判定 ⇒ 拍草识别/标签识别/语音提问/社区图片都传不了字节。
- `external_inference`：识别、OCR、语音问答、朗读合成四条外发各自按它判定 ⇒ 立刻全部不可用；账本已接时撤回前撤销在途外发，未接时服务端 409 拒绝（不做只撤一半）。
- `public_posting`：发帖/评论/社区图片按它判定 ⇒ 立刻发不了帖、发不了评论。
- 四条都写明"**不会删除已存在的内容**"（撤回改的是授权状态，不是数据）。

## 6. 证明了什么

全部为本地可复跑的机器断言（`node --test tests/unit/miniprogram-consent-grant-withdraw.test.mjs`，18/18 通过）：

1. **契约形状**：`grant` 的 method/url/body/头逐项钉住（体恰三个字段、键 8..128、**不带** `If-Match`）；`201` 才算成功，`200` 会被判 `UNEXPECTED_STATUS`。
2. **幂等键复用**：API 层传回同一个键 ⇒ 两次请求同键；页面层同一次动作的重试同键、成功后新动作换新键（`...:420`）。
3. **428 路径真实被处理**：`DELETE` 先取 revision 再带 `If-Match`；428 ⇒ 补取一次 ⇒ 用**新 revision** 重试成功（`...:273`）；补取失败 ⇒ 抛补取自己的 `NETWORK_UNCERTAIN` + 留 `refetchFailedAfter=REVISION_REQUIRED`，DELETE 只发过一次、总请求停在 3 条（`...:299`）；409 不被当作 428（`...:319`）。
4. **403 无可用政策**：界面**置灰 + 点名原因 + 服务端码**，且**请求数不再增加**（`...:397`）。
5. **失败后状态不变**：`NETWORK_UNCERTAIN` / `OBJECT_UNAVAILABLE` / `REVISION_CONFLICT` 三种失败后状态都保持原样，原因与码写在行内（见 `tests/unit/miniprogram-consent-grant-withdraw.test.mjs:420`、`tests/unit/miniprogram-consent-grant-withdraw.test.mjs:510`、`tests/unit/miniprogram-consent-grant-withdraw.test.mjs:532`）。
6. **空清单与读面失败可区分**：0 条 ⇒ 四行"未授权"且 `errorText` 为空（`...:549`）；读面 503 ⇒ items 清空 + 码原样 + 四行置灰并说明"没读到"、点击不发请求（`...:563`）。
7. **撤回二次确认**：不确认不发任何请求；四个用途的确认文案**两两不同**且各自说到该项能力（`...:459`）。
8. **政策读面语义**：`unpublished` ⇒ `published:false`（不是版本号）；`training_enabled` 非 `false` ⇒ `INVALID_RESPONSE`。

## 7. 没证明什么（**这一节比上一节重要**）

1. **没有证明"真能授予成功"**。本地 stub / 假 `wx.request` 下 `consent_policies` **没有可用行**，真服务端会回
   `403 CONSENT_REQUIRED`（`services/api/src/privacy/grant-pg.ts:49`）。本片测到的 `201` 全部来自**回放的假响应**。
   真机上"授予成功"取决于运维是否导入已核验政策行 —— 本片**未取得**该证据。
2. **没有真机/微信编译器证据**。`wx.request`/`wx.showModal` 都是替身；四态渲染只在数据层被断言，没截图、没真机走查。
3. **428 分支是防御性路径，不是常态**。本客户端始终带 `If-Match`，而 428 只由服务端在 `if-match` **缺失**时抛出
   （`services/api/src/routes/consents.ts:74` 在调服务前判定）⇒ 正常路径**不该**出现 428。测试用假响应造出 428 来钉住该分支，
   因此它证明的是"如果服务端这样答，客户端会怎么处理"，**不是**"线上真的发生过 428"。
4. **没证明撤回会真的撤销在途外发**。`egressRevoker` 只在 `executionMode === 'real'` 且外发账本存在时注入
   （`services/api/src/app.ts:1017-1019`）；本地无账本时服务端走 409 `OBJECT_UNAVAILABLE` 兜底。撤回消费者本身的真库证据属
   `tests/integration/consent-grant-postgres.yml` 那条链，本片**没有**跑它。
5. **没证明 `external_inference` 可授予**。客户端**刻意**不给它授予按钮：`POST` 强制至少一个已核验接收方
   （`services/api/src/privacy/grant-pg.ts:60`），而政策读面露出的 `recipients[]` 是**披露面**（比授权面宽，见
   `services/api/src/privacy/privacy-policy.ts:49-57`），拿它当授权面的接收方等于替用户挑第三方 —— 本片不替用户做这个决定。
   要支持它需要一个"可授权接收方"读面或接收方选择界面（**未做**，见 §10）。
6. **没证明"每个用途都能撤回"**。撤回按钮的可用性完全取自服务端清单与错误码；服务端 404/409 时如实置灰，不做本地推断。
7. **`docs/verification/gy-r30-public-posting-gate-20261022.md` 与 `gy-i04-login-chain-20261021.md` 里"客户端没有授权入口"的读数是历史快照**，
   本片**不改**这两页（历史证据按当时树写）。新的现状以本页为准。

## 8. 门禁

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm run test:unit` | exit 0（见 §8.1） |
| 锚点（仓内口径） | `npm run verify:anchors` | exit 0（见 §8.1） |
| **CI exact 锚点** | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | exit 0（见 §8.1） |
| 契约 ↔ 路由对拍 | `npm run verify:parity` | exit 0（见 §8.1） |
| 能力图 | `npm run verify:capability-map` | exit 0（见 §8.1） |
| 文档校验 | `npm run test:docs` | exit 0（见 §8.1） |
| lint | `npm run lint` | exit 0（见 §8.1） |
| 契约测试 | `npm run test:contract` | exit 0（见 §8.1） |
| 构建 | `npm run build` | exit 0（见 §8.1） |
| 失败矩阵 | `npm run test:failmatrix` | exit 0（见 §8.1） |

两条锚点命令**都**跑了：`verify:anchors` 走默认面（`docs/architecture` + `docs/verification`），
CI 那条还多扫 `docs/` 下其余页面 —— 扫描面不同，读数不可互换。

### 8.1 读数（2026-10-30 本机实测，全部 exit 0）

- `npm run test:unit`：`tests 5816 / pass 5812 / fail 0 / skipped 2 / todo 2`（约 200 秒）。本片新增的
  `tests/unit/miniprogram-consent-grant-withdraw.test.mjs` 18/18 通过，既有 `tests/unit/consent-page-read.test.mjs` 10/10 仍绿。
  `skipped 2 / todo 2` 是仓内既有登记项（`i11` 的 MP3→WAV 缺口等带 `todo` 的用例），不是本片引入。
- `npm run verify:anchors`：
  - `verify-contract-status`：`PASS`（语义可核 105 条区间 + 4 条片段；证据锚点 576 条引用带锚点；行号区间 313 条 = 台账直写 302 + 符号解析 11；整段仅空白 0 条；中文表格一致）；
  - `verify-doc-anchors --strict`：`PASS`（结构四判据无基线外新增；`BARE_ORPHAN` 命中 3479 条、基线外新增 **0**、陈旧 0；`ANCHOR-COUNT` 计数下降的文档 **0** 份）。
- **CI exact** `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs`：`PASS`
  （`BARE_ORPHAN` 命中 3543 = 册上 3543、新增 0、陈旧 0；`ANCHOR-COUNT` 6489 条 / 233 份文档，下降 0 份、上升 11 份；
  `SYMBOL-STRICT-BASELINE` 31 条命中 31、基线外新增 0）。
- `npm run verify:parity`：`extra: []`、`missing: []`、`ledgerDrift: 0`（本片没动服务端与契约，对拍持平）。
- `npm run verify:capability-map`：`totalOps=46，有入口=46，无入口=0，死按钮=0`；文档标记块与重算一致。
- `npm run test:docs`：`PASS`（Markdown 链接/表格校验；研究记录 5 通过 / 0 失败 / 4 legacy 已钉住）。
- `npm run lint`：`PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、仓库卫生扫描通过。
- `npm run test:contract`：17/17 通过。
- `npm run build`：API 与后台均构建成功（admin 产物 `index-BEr_fGAO.js` 629.18 kB / gzip 174.14 kB；只有 rollup 的
  "chunk > 500 kB" 告警，退出码 0）。**build 之后、unit 之前删掉了 `services/api/dist` 与 `apps/admin/dist`**（本仓只有这一个 `apps/*`）。
- `npm run test:failmatrix`：`矩阵合计 249 条：PASS 249 / FAIL 0`。
- 环境：`TMP`/`TEMP` 指向仓外目录；`GY_BASH` 指向本机 bash（`bash-resolution` 用例因此不 skip）。

### 8.2 负控制（四条，逐条实跑打红再恢复）

| # | 改法（一次性） | 打红 | 恢复后 |
| --- | --- | --- | --- |
| ① | `onGrant` 里在发请求前把该行本地改成"已授权"（乐观更新） | `B2 非乐观` 红（在飞时状态被翻过去），17/18 | 18/18 绿 |
| ② | `withdraw` 的 428 分支关掉（`refetches >= 0`，永不补取） | `A4 428 补取`、`A5 补取失败` 红，16/18 | 18/18 绿 |
| ③ | `onGrant` 每次重试都 `newIdempotencyKey()`（不复用） | `B4 同动作同键` 红，17/18 | 18/18 绿 |
| ④ | `actionMessage` 一律返回「操作失败，请重试。」（折叠服务端码） | `B3`、`B4`、`B6`、`B7` 红，14/18 | 18/18 绿 |

负控制是**改源码 → 跑同一份测试 → 还原**，不是新写测试；每次只改一处、命中次数断言为 1（改点在文件里唯一）。

## 9. 需要裁定的点

1. **`DELETE` 错版本到底是 404 还是 409**（§2 第 1 条）。本片按代码实现（409 `REVISION_CONFLICT`）；若口径确实是 404，
   那是**服务端/派单**要改，不是客户端。
2. **`external_inference` 的授予入口**：现在不可授予且写明原因。要真支持，需要（a）服务端加"某用途可授权接收方"读面，或
   （b）客户端加接收方选择界面并说明每个接收方的留存/核验。两者都超出"不动服务端"的本片范围。
3. **`recording` 的授予体 `recipient_ids` 为空**是否符合运营预期：服务端允许（只有 `external_inference` 强制非空），但"录音用途不绑定任何接收方"这一语义值得产品确认。
4. **`identify-api` 的文案改动**属本片顺带修的"已过期声明"（原话"应用内授权入口尚未接入"在本片合入后为假）。若认为超范围，可单独拆出一片只改这一处。

## 10. 监工复查修复（跨账号写）

> 本节为**追加**，§1–§9 的正文一字未改。唯一一处旧行改动：本片改了
> `miniprogram/pages/consent/consent.js` 之后，§3 那张表中该文件一行的四个锚点按新树重锚
> （原第 42／188／262／310 行 → 新第 69／241／315／370 行，指的还是同一批构造、原文逐字未变）：
> 不重锚则 `docs/verification/gy-r70-consent-client-20261030.md:50` 的继承锚点落在空行上（`SUSPECT`），
> CI-exact 锚点门禁直接红。重锚量等于该文件 `git diff -U0` 的端点位移（+27／+53／+53／+60），
> 四个构造在新树上的行号分别是 `const WITHDRAW_COST`、`buildRows`、`onGrant`、`onWithdraw`。

### 10.1 缺陷（监工原话，逐字）

> `consent.js:112-113` onHide/onUnload 只调用 `pageGate.cancel`，不递增本页 `_epoch`；
> `onWithdraw:312-325` 的旧确认因此仍通过。撤回客户端随后按**当前**会话重取 revision 并 DELETE
> （`consent-api.js` `currentRecordOf`/`withdraw`），会把旧账号的确认变成对新账号的撤回。

因果链（按改前那棵树读出来的三步）：

1. **离页只取消门禁**：`onHide`/`onUnload` 只调 `pageGate.cancel(this)`，本页 `_epoch` 不动。
   `miniprogram/utils/page-gate.js` 的 `cancel` 会经 `_gateClose` 回调页面把 `gatePassed` 置 false，
   但那份代码里没有任何一处会递增**页面自己**的世代。
2. **确认只比对世代**：弹窗回调里唯一的一道闸是 `epoch !== self._epoch`。世代没变 ⇒ 旧确认照样通过。
3. **写链路按"当前"会话取版本**：`withdraw` 第一步 `currentRecordOf(purpose)` 发
   `GET /me/consents?limit=50`，令牌取自 `auth.getSession()` **此刻**的值；第二步带 `If-Match` 发 `DELETE`。
   两步都用当下令牌 ⇒ **A 的确认变成了对 B 的撤回**。

所以它不是"多发一条请求"，而是**跨账号写**：撤回动的是授权状态，替另一个账号撤掉授权。

### 10.2 复现（可跑用例，就是监工那份最小隔离检查）

- 用例：`tests/unit/miniprogram-consent-withdraw-confirm-isolation.test.mjs`（9 条）。
- 夹具：**真实** `miniprogram/pages/consent/consent.js` + **真实** `miniprogram/utils/consent-api.js` +
  **真实** `miniprogram/utils/page-gate.js` 跑在 `vm` 沙箱；只替身三样事情——
  `wx.request`（只入队，要成功由用例显式回放）、`wx.showModal`（手动回放 `success`，让用例决定"确认"什么时候回来）、
  会话读面（`getSession` / `sessionEpoch`；切账号 = 换令牌 + 世代 +1，与 `utils/auth.js` 的 `setSession`
  在令牌变化时递增 `generation` 同形）。无真实网络、无用户数据、无供应商、无 PG。
- 命令：`node --test tests/unit/miniprogram-consent-withdraw-confirm-isolation.test.mjs`
- **改前（`916aa99e` 的源码 + 本片最终版用例）**：`tests 9 / pass 2 / fail 7`。七条红点原文：

| 用例 | 改前读数（原文照抄） |
| --- | --- |
| C1 跨账号 | `actual: [ 'GET http://127.0.0.1:4318/api/v1/me/consents?limit=50 [Bearer token-B-account-b]' ]`、`expected: []` |
| C2 同账号离页 | `onHide 必须递增本页可见周期世代（改前 1、改后 1…）` → `actual: false` |
| C4 onUnload | `onUnload 同样必须递增本页可见周期世代` → `actual: false` |
| C5 账号变化 | `actual: [ 'GET http://127.0.0.1:4318/api/v1/me/consents?limit=50 [Bearer token-B-account-b]' ]` |
| C7 一次性令牌 | `点「撤回」时必须生成一次性的 _pendingConfirm` → `actual: undefined` |
| C8 适配层入口 | `actual: [ 'GET http://127.0.0.1:4318/api/v1/me/consents?limit=50' ]`（改前的 `withdraw` 没有 `guard`） |
| C9 428 补取 | `actual: 2`、`expected: 1`（补取那条 GET 也发了出去） |

C3（正常路径）与 C6（离页后**重新可见**）改前就是绿的：前者说明缺陷不是"撤回根本不通"，后者说明
`onShow` 的世代递增本来是一道闸 —— 真正漏的是**只离页不重进**、以及**页面还在但账号换了**这两条。

### 10.3 修法（选①确认令牌化；以及为什么不选②）

**① 确认令牌化（本片采用）**

- 点「撤回」这一刻快照一次性的 `_pendingConfirm = { epoch, identity, purpose, token, claimed }`
  （`miniprogram/pages/consent/consent.js:370`）。`token` 由 `miniprogram/pages/consent/consent.js:49` 生成，
  **不发给服务端**（C7 断言它不出现在任何 header／URL 里），只在本页内存里区分"这一次确认"。
- `invalidate()`（`miniprogram/pages/consent/consent.js:152`）= 递增 `_epoch` + 作废令牌；
  由**重进**、`onHide`（`miniprogram/pages/consent/consent.js:157`）、`onUnload`
  （`miniprogram/pages/consent/consent.js:162`）、**门禁关闭**四处调用。
- `confirmGuard(pending)`（`miniprogram/pages/consent/consent.js:417`）按"会话身份 → 页面世代 →
  是否仍是当前这次确认"的顺序判。会话身份 = 访问令牌 + `auth.sessionEpoch()`
  （`miniprogram/pages/consent/consent.js:39`）：契约禁止客户端声明 `userId`，这是页面唯一能观测到的账号身份。
- **写链路每一步复验**：`withdraw` 接受 `guard`，在链路入口、`DELETE` 之前、428 补取的 `GET` 之前
  各判一次（`miniprogram/utils/consent-api.js:501`、`miniprogram/utils/consent-api.js:510`）；
  不成立 ⇒ `CONFIRM_STALE`，**一条请求都不发**。
- 丢弃走 `dropConfirm`（`miniprogram/pages/consent/consent.js:445`）：页面级原因码 + 文案 + 行内原因，
  ⛔ 不静默（`CONFIRM_STALE` 的文案在 `miniprogram/utils/consent-api.js:584`）。

**为什么不选②（把确认与写合并成一条不可分割的异步链路 + 入口快照）**

② 也能满足监工那三条，但代价更实：

- (a) 撤回**必须**再发一次读：`DELETE` 前要先取当前 `revision`，428 时还要补取一次 —— 链路注定跨多次请求，
  "快照点在链路入口"因此特别容易被下一次改动挪走（本片正是把 `guard` 放进适配层才把"每一步都复验"钉住的；
  只在页面入口判一次的写法，428 补取那一步仍会用一个已过期的确认发出读取，C9 就是钉这个的）。
- (b) ② 里"过期"只有链路内部知道：用户的"再想想"、网络不确定后的重试、428 补取三者状态不同，
  合并成一条链路会把"这是一次新意图"与"这是同一次意图的续跑"糊在一起，而后者正是幂等键复用所依赖的区别。
- (c) ① 的状态是**可观测的**：`_pendingConfirm` 与其 `epoch`/`identity` 在页面上就能断言（C7 直接读它），
  负控制也能一处一处打红；② 的快照藏在闭包里，测试只能通过"有没有发请求"间接推断。

① 的代价（如实登记）：多一个内存字段 + 一个守卫函数；页面必须记住"哪些时刻该 `invalidate`"，
漏一处就漏一个洞 —— 所以下面用四条负控制逐个证明这些时刻真的在起作用。

### 10.4 用例与前后读数

| 用例 | 改前 | 改后 | 断言的是 |
| --- | --- | --- | --- |
| C1 A 打开确认 → onHide → 切 B → 旧 confirm | 红（GET 入队，`Bearer token-B`） | 绿 | 跨账号不写：请求队列为空 |
| C2 同账号 onHide（不重进）→ 旧 confirm | 红（世代 1→1 + GET 入队） | 绿 | 可见周期已变：请求队列为空 + 原因码 `PAGE_CYCLE_CHANGED` |
| C3 同账号同周期确认 | 绿 | 绿 | 正常路径不退化：GET + DELETE 各一次、`If-Match` = 当前 revision、写后重读 |
| C4 onUnload → 旧 confirm | 红（世代未递增） | 绿 | 销毁后不发请求，也不往已销毁页面写"成功" |
| C5 账号变化（页面仍可见、世代未变） | 红（GET 入队，`Bearer token-B`） | 绿 | 会话身份绑定 + 明确界面原因（`SESSION_CHANGED`） |
| C6 onHide → 重新可见 → 旧 confirm | 绿 | 绿 | 回归钉（改前靠 `onShow` 递增就挡住了） |
| C7 同一回调重复触发 | 红（无令牌） | 绿 | 一次性：只发一次；令牌不上网 |
| C8 适配层入口 `guard` 不成立 | 红（GET 入队） | 绿 | 过期确认连取 revision 的 GET 都不发 |
| C9 428 补取那一步 `guard` 不成立 | 红（GET 2 条） | 绿 | 补取也复验；`DELETE` 只发过一次 |

改后读数：`tests 9 / pass 9 / fail 0`。

### 10.5 四条负控制（实跑：改源码 → 跑同一份用例 → `git checkout` 还原）

| # | 一次性改法 | 打红 | 恢复后 |
| --- | --- | --- | --- |
| ① | `onHide` 只留 `pageGate.cancel(this)`，去掉 `invalidate()`（= 改前形状） | C2 红：`onHide 必须递增本页可见周期世代（改前 1、改后 1）`，8 绿 / 1 红 | 9 绿 |
| ② | 删掉 `confirmGuard` 里"会话身份与发起时相同"那一段（写前不校验账号） | C5 红：`actual: [ 'GET …limit=50 [Bearer token-B-account-b]' ]`，8 绿 / 1 红 | 9 绿 |
| ③ | `withdraw` 入口那一道 `checkGuard()` 删掉（只留 `DELETE` 之前那道） | C8 红（入口就发出 GET）+ C9 红（GET 2 条 vs 1），7 绿 / 2 红 | 9 绿 |
| ④ | `dropConfirm` 改成静默成功（`actionCode` 置空、`actionText` 写"已撤回"、行内不留原因） | C2 + C5 红：`actual: ''`、`expected: 'PAGE_CYCLE_CHANGED'` / `'SESSION_CHANGED'`，7 绿 / 2 红 | 9 绿 |

负控制是"改一处源码 → 跑同一份用例 → 还原"，每次只改一处。

**一条必须说清的边界**：负控制①只去掉 `onHide` 的递增**不足以**让真实代码漏掉 —— 真
`miniprogram/utils/page-gate.js` 的 `cancel` 会通过 `_gateClose` 回调页面，门禁关闭那条路径同样会
`invalidate()`，等于修复有**两道闸**。用例夹具的 `cancel` 因此刻意做成**不回调**（只置 `gatePassed:false`），
按监工原话（"onHide/onUnload 只调用 pageGate.cancel"）单独逼 `onHide` 自己承担递增的责任；
若不去掉门禁回调那道闸，① 永远不会红，这条负控制就成了摆设。**两道闸都在，是冗余，不是重复劳动**：
`page-gate` 是另一个模块，页面不该把自己的生命周期不变量寄托在它的回调上。

### 10.6 证明了什么 / 没证明什么

**证明了（全部为本地可复跑的机器断言）**

1. 旧确认在 **onHide / onUnload / 重进 / 账号变化** 之后**一条请求都不发**（C1／C2／C4／C5／C6）。
   断言是"确认之后的请求队列为空"，不是"发了但失败了"；读数里连令牌都打出来，改前正是 `Bearer token-B`。
2. **正常路径不退化**（C3）：同账号同周期确认 ⇒ `GET /me/consents?limit=50` 与 `DELETE /me/consents/recording`
   各一次，`If-Match` 取的是这次读到的当前 revision，写成功后按服务端记录重读清单。
3. **一次性**（C7）：同一弹窗回调重复投递只发一次；确认令牌不出现在任何请求 header／URL 里。
4. **适配层两道复验真的在链路上**（C8／C9）：链路入口与 428 补取那一步都能把过期确认拦在请求之前。
5. **丢弃有明确界面原因**（C5）：`actionCode`、`actionText`（写清"账号/会话变了""没有发出"）、
   行内 `errorText`／`errorCode` 三处都在，行不留在"进行中"，状态不变。

**没证明什么（这一节比上一节重要）**

1. **真机／微信编译器仍未跑**。`wx.showModal`／`wx.request` 都是替身，所以**不证明**真机上
   "弹窗还在时切账号"的时序一定这样发生。证的是：**只要**旧确认在离页/换号之后回来，
   本页不会用新会话的令牌去读或去写。
2. **没有真实账号体系参与**：客户端拿不到 `userId`，身份只能是（令牌, 会话世代）这一对。
   若存在某种**不换令牌**的换号路径（服务端把同一令牌改指另一个用户——契约上不该发生，但本片无法证伪），
   本片的判定会认为"还是同一个账号"。这是本修法最实的边界，也是需要裁定的第 1 条。
3. **没证明服务端的授权隔离**：`services/api/src/**` 一行未动，服务端是否会在同一令牌下串号，
   本片既不测也不改。
4. **本地 stub 无真实政策行 ⇒ 仍不证明真机撤回链路**（沿用 §7 第 1 条）：`201`／`200` 全部来自回放的假响应。
5. **没做界面截图／真机走查**（沿用 §7 第 2 条）：四态与"丢弃原因"只在数据层被断言。
6. **`_pendingConfirm` 只在内存里**：杀掉小程序再进来就是新确认（这是对的），但没有"跨进程确认存续"这回事。

### 10.7 本片门禁（2026-10-30 本机实测；九条里八条 exit 0，**构建一条被宿主环境卡住**，见 10.7.2）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm run test:unit` | exit 0（读数见 10.7.1） |
| 锚点（仓内口径） | `npm run verify:anchors` | exit 0 |
| **CI exact 锚点** | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | exit 0 |
| 契约 ↔ 路由对拍 | `npm run verify:parity` | exit 0 |
| 能力图 | `npm run verify:capability-map` | exit 0 |
| 文档校验 | `npm run test:docs` | exit 0 |
| lint | `npm run lint` | exit 0 |
| 契约测试 | `npm run test:contract` | exit 0 |
| 构建 | `npm run build` | **exit 1（宿主环境受阻，不是代码问题；证据见 10.7.2）** |
| 失败矩阵 | `npm run test:failmatrix` | exit 0 |

### 10.7.1 读数

- `npm run test:unit`：`tests 5834 / pass 5830 / fail 0 / skipped 2 / todo 2`。本片新增
  `tests/unit/miniprogram-consent-withdraw-confirm-isolation.test.mjs` 9 条全绿；既有
  `tests/unit/miniprogram-consent-grant-withdraw.test.mjs` 18 条与 `tests/unit/consent-page-read.test.mjs` 10 条仍绿。
  `skipped 2 / todo 2` 是仓内既有登记项（`i11` 的 MP3→WAV 缺口等），不是本片引入；
  无真 bash（WSL 存根不可用），`bash-resolution` 用例按原因 skip。
- `npm run verify:anchors`：`verify-contract-status` PASS；`verify-doc-anchors --strict` PASS
  （`BARE_ORPHAN` 命中 3479 条、基线外新增 0 条、作用域外本会红 121 条、新增 0 条；`ANCHOR-COUNT` 计数下降 0 份）。
- **CI exact** `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs`：PASS
  （同一批读数；`SYMBOL-STRICT` 基线外新增 0）。
  两条锚点命令都跑了：`verify:anchors` 走默认面（`docs/architecture` + `docs/verification`），
  CI 那条还扫 `docs/` 其余页面，扫描面不同，读数不可互换。
- **「文档锚点位移恒等」这条在本提交上是 SKIP，如实登记**：`node --test tests/unit/doc-anchor-relocation-identity.test.mjs`
  读数 `tests 33 / pass 32 / fail 0 / skipped 1`，主用例的 SKIP 文案是
  「本次文档提交只有新增行，没有锚点位移面（1 个纯新增 hunk）」——因为本页相对 base（`d03faf90`）
  是**新文件**，整页都是新增行、没有"旧行→新行"可配。**后果**：10.1 里那四处重锚（原第 42／188／262／310 行
  → 新第 69／241／315／370 行）**没有**被这条闸门验过，只被 `--strict` 的"行号在文件范围内 + 该行有实质内容"
  验过；重锚量按 `miniprogram/pages/consent/consent.js` 自己的 `git diff -U0` 端点位移算（+27／+53／+53／+60），
  可人工逐条复核。
- `npm run verify:parity`：`extra: []`、`missing: []`、`ledgerDrift: []`（本片没动服务端与契约）。
- `npm run verify:capability-map`：`totalOps=46，有入口=46，无入口=0，死按钮=0`；文档标记块与重算一致。
- `npm run test:docs`：PASS（Markdown 链接/表格校验；研究记录 5 通过 / 0 失败 / 4 legacy 已钉住）。
- `npm run lint`：PASS（两个工作区 `tsc --noEmit` + 仓库卫生扫描）。
- `npm run test:contract`：17/17 通过。
- `npm run build`：**本会话 exit 1 —— 卡在宿主环境，不是本片代码**（证据见 10.7.2）。
  `npm run build --workspace @gengyun/api`（`tsc`）单独跑 exit 0；`apps/admin` 本片一行未改。
  build 之后、unit 之前照纪律删掉 `services/api/dist` 与 `apps/admin/dist`（本仓 `apps/*` 只有 `admin`）。
- `npm run test:failmatrix`：`矩阵合计 249 条：PASS 249 / FAIL 0`。
- 环境：`TMP`／`TEMP` 指向仓外目录；无真 bash，相关用例带原因 skip。

### 10.7.2 构建门禁的受阻证据（如实登记，⛔ 不冒充绿）

现象：`npm run build` 在 `@gengyun/admin` 的 `vite build` 阶段失败，报文是

> `[vite:esbuild-transpile] remove <TMP>\esbuild-<hash>: Access is denied.`

这段失败与本仓库代码无关，三条证据：

1. **最小复现不含本仓任何代码**：`node -e "const e=require('esbuild'); e.transform('var x=1;\n'.repeat(120000),{loader:'js'})"`
   —— 1,080,000 字节的输入同样报 `remove …: Access is denied`；同一个调用在 1 MiB 以内的输入上正常返回。
2. **触发条件是 esbuild 自己的 1 MiB 阈值**：`node_modules/esbuild/lib/main.js` 里
   `input.length > 1024 * 1024` 就改成"把输入写进临时文件交给 esbuild 二进制"，该二进制读完后
   `remove` 这个临时文件时被宿主拒绝（Go 的 `remove <path>: Access is denied`）。
   1 MiB 以内的输入走管道、不建临时文件，所以小程序侧与全部单元测试照常。
3. **换临时目录／换盘／关压缩都无效**：`C:\Users\MR\AppData\Local\Temp`、`E:\gy-tmp-r70`、
   `C:\gy-tmp-r70` 三处都失败（跨两个卷）；`vite build --minify false`、`vite build --target esnext`
   同样失败 —— 说明既不是路径问题，也不是某个开关单独造成的。
4. **旁证：应用代码本身能构建**。`npx vite build --minify false --target esnext`（在 `apps/admin` 下）
   exit 0，产出 `dist/assets/index-B-9Crt2j.js 1,351.42 kB / gzip 321.35 kB`；
   但这不是仓内那条命令，⛔ **不拿它冒充 `npm run build` 的绿**（产物已按纪律删除）。
5. **指挥已在另一个会话独立复现同一失败**：复现命令同第 1 条，两个读数分别是
   `>1 MiB（1.08 MB 输入）⇒ FAIL：remove C:\Users\MR\AppData\Local\Temp\esbuild-ebd654e0…: Access is denied`
   与 `<1 MiB（0.45 MB 输入）⇒ OK`；当时宿主上有 77 个 node 进程、CPU 100%（并发写手所致，与本片无关）。
   **口径（指挥裁定）**：`build` 的权威读数取 CI（ubuntu-24.04 —— Linux 上不撞这个 Windows `remove` 拒绝）；
   本机这条按「环境受阻」登记，⛔ 不拿它当阻塞别人的理由，⛔ 也不为它改 `vite.config`／构建配置／esbuild 版本。

结论：**本片没有取得 `npm run build` 的 exit 0 读数**（`apps/admin` 一行未改，`services/api` 的
`tsc` 构建单独 exit 0，admin 用关压缩+esnext 目标也能过）。这一条要在能走通 esbuild >1 MiB
临时文件路径的机器／会话上重跑才算数 —— 按上述口径，**权威读数是 CI 的 Linux 构建**。

### 10.8 需要裁定的点

1. **会话身份的粒度**：本片用（访问令牌, `auth.sessionEpoch()`）。若要求把"服务端签发的稳定账号标识"
   作为身份的一部分，需要 `GET /auth/session` 多返回一个 account 标识（服务端 + 契约改动，
   超出"不动 `services/api/src/**`"的本片范围）。
2. **① 是否满足"确认与写是一条不可分割的链路"**：本片的 `guard` 就是那条链路的入口快照，
   且链路内每一步都复验；差别只在"链路内不再有第二次用户交互"。若口径要求"必须合并成一个 await 链"，
   那要按 ② 重做，代价见 10.3。
3. **离页递增世代会丢弃隐藏期间回来的读回执**：这是有意的（隐藏页不该往自己身上写数据），
   但如果产品希望"后台预取、回前台立刻可见"，需要另设计（例如保留数据但标记为过期）。
4. **§3 那四个锚点选择重锚而不是登记到孤儿册**：理由是它们指的构造没变、只是行号位移，
   重锚后仍是指向真实代码的锚点；登记则等于承认它指错了。若监工认为历史证据页不该被重锚，
   可改用 `--write-orphan-baseline` 登记，本片照办。

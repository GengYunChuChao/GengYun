# GY-R35-I19 · `GET /me/exports`（`listExports`）台账改判与隐私红线证据

- 切片：`feat/gy-i19-me-exports`（worktree `wt-r34-exports`）
- 基线：`upstream/main = 46dc7e0d07d73fd436b7b03e3546ad7136c8be84`（`git fetch upstream --prune` 后复核）
- 本页所有代码引用**只写符号、不写行号**：证据页会被 `tools/verify-doc-anchors.mjs --strict` 当锚点扫描，
  行号一漂就变假引用；台账里那 4 条 evidence 的行号由 `tools/verify-contract-status.mjs` 负责核。

**一句话结论**：契约条目 `listExports` 由 `planned`（零证据）改判 **`partial`**；HTTP 面在 R34 已交付，
本片补的是**台账口径、planned 守卫、隐私红线测试**与随之而来的生成物同步，**没有新增业务代码**。
真实 PG17 臂、真实账本数据、真机与部署侧读授权面仍未取得 ⇒ 不判 `implemented`（见 §4）。

## 1 契约原文摘要（`packages/contracts/openapi.json` 的 `paths./me/exports.get`）

| 契约项 | 原文/取值 |
| --- | --- |
| 方法/路径 | `GET /me/exports`；`operationId: listExports`；`tags: [me]` |
| 鉴权 | `security: [{ userSession: [] }]`（**用户会话**，没有 deletionReceipt 之类的换签凭据） |
| 参数 | `cursor`（string，≤2048）、`limit`（integer，1..50，默认 20） |
| 200 体 | `ExportPageEnvelope = { data: ExportPage, meta: Meta }`，两者都 required、`additionalProperties:false` |
| `ExportPage` | `{ items: Export[]（maxItems 50）, next_cursor: string(1..2048) \| null }` |
| `Export` 条目 | 8 个必需键：`id`（uuid）、`object_ref`（`TargetRef`：`type` 16 值枚举/`id` 1..80/`revision`≥1）、`purpose`（`ConsentPurpose` 4 值）、`recipient_id`（1..80）、`consent_epoch`（≥1）、`state`（`reserved\|sent\|failed\|outcome_unknown`）、`sent_at`（date-time 或 null）、`deletion_state`（`ThirdPartyState` 5 值） |
| 200 头 | `Cache-Control`：私有/授权访问 `no-store`；`ETag`：原文「资源revision强ETag；**列表无此头**」⇒ **不发** |
| 错误码 | 400/401/403/404/409/413/415/422/428/429/503/504（本 operation 实际用到 400/401/403/503） |
| 其它 | `x-scope: user`、`x-version-required: false`、`x-task: GY-I01`；**同步而非异步**（无 job、无 signed url） |

**口径澄清（必须写清，否则会误读整片）**：契约 `Export` 是**外发账本条目**的投影 —— "发生过哪些第三方外发、
用途是什么、同意版本几、对方是谁、结果与删除状态"。它**不是**"把用户数据打包下载"：openapi 里这个 operation
没有任何文件生成、打包、压缩包、`Content-Disposition` 或签名下载 URL 面。派单标题里的「用户数据导出」若按
"数据可携带/打包导出"理解，在契约上**不成立**；本条只描述外发清单。

## 2 侦察结论

**最接近的同类实现（照抄模式）**
1. 同域列表读面：`services/api/src/routes/consents.ts` + `services/api/src/privacy/consent-pg.ts`
   （`GET /me/consents`：`identity.role !== 'user'` ⇒ `SCOPE_DENIED`、`no-store`、列表不发 ETag）——
   `routes/exports.ts` 就是这条模式；两片共用同一个签名游标引擎
   `services/api/src/privacy/signed-list-cursor.ts`（主体/`auth_epoch`/列表域/排序域/15 分钟绝对到期 + HMAC）。
2. 同域**资源**读面：`services/api/src/routes/account-deletion.ts` 的 `getDeletionReceipt` 发**强 ETag**
   （`"${revision}"`）；本 operation 是**列表**，按契约原文**故意不发** ETag —— 两者差异有契约依据，不是遗漏。
3. 注销/删除侧（`services/api/src/privacy/account-deletion.ts`、`user-data-deletion.ts`）只提供**删除与回执**，
   没有任何"导出文件"实现；全仓 grep 未见打包/下载导出工具或导出任务表。

**数据来源**
- 唯一数据面是 `public.exports` 一张表：`services/api/db/migrations/0003_privacy_consent.sql` 建表（含
  `recipient_config_version`、`source_version`、`provider_request_ref_cipher`、`required_consents`、`consent_id`
  等**内部列**），`0011_export_ledger.sql` / `0014_export_object_key.sql` 增列（`revision`、`object_key`、
  回写与取消字段）。
- 读面是既有实现 `services/api/src/privacy/ledger-pg.ts` 的 `list()`：`WHERE user_id=$1` +
  `(created_at,id)` keyset + `LIMIT limit+1`；投影是 `packages/privacy/egress.mjs` 的 `listExportsForUser`
  → `toContractExport`（形状不合抛 `PROVIDER_UNAVAILABLE`，不输出自相矛盾条目）。
- 装配层 `services/api/src/privacy/exports-list.ts` 的 `createExportsListService` **零 SQL**：只做
  签名游标的装/拆与「账本懒建」（首请求才解析池，构造期不打库）。
- 结论：**没有新增 SQL、没有新增迁移、没有新增导出工具**；本片也未改 `services/api/**` 任何一行。

## 3 改动清单

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `docs/architecture/contract-status.json` | **仅** `listExports` 一条：`status` `planned`→`partial`；`evidence` 空→4 条（路由/装配各一条带符号锚，两条单测带用例名锚）；`blocker` 重写为"已交付什么 + 为何仍 partial" | 台账必须与实测一致；`planned` 的含义是"未取得产品实现证据"，而 main 上已有 HTTP 面与两条单测 |
| `docs/architecture/contract-implementation-status.md` | `node tools/verify-contract-status.mjs --write-doc` 重生成 | 生成区禁止手改；diff 只有 `listExports` 那一行与汇总计数行（`partial 95→96`、`planned 3→2`） |
| `docs/architecture/openapi-route-parity.md` | `node tools/openapi-route-parity.mjs --write-doc` 重生成 | 该表带台账 status 列，改状态必同步；diff 只有 `listExports` 那一行 |
| `tests/unit/contract-planned-exemptions.test.mjs` | 从 `PLANNED_EXEMPT` 移出 `listExports`；把钉死的条数 `3→2`、状态数组三元素→两元素 | 守卫要求「零证据 ⇔ planned 且已登记」；改判后不同步即红（不是放宽：条数从 3 收紧到 2，剩余两条仍逐条钉死） |
| `tests/unit/exports-privacy-redlines.test.mjs` | **新增**（3 条用例） | 隐私红线与 fail-closed 的定向验收，见 §5/§6 |
| `docs/verification/gy-i16-i17-deletion-cascade-20261021.md`、`docs/verification/gy-issue-closure-index-20261018.md` | 2 处 `contract-status.json` 引用各 **+19**（`1771→1790`） | 本片给台账插入 19 行，这 2 处原引用被推成"只剩收尾括号"的行 ⇒ `--strict` 新增 SUSPECT。按最小改动只做机械位移（目标内容与原引用同类：同为该证据项的起始行），**不改任何历史结论**；其余引用见 §8.6 |
| `docs/verification/gy-r31-i07-sort-20261022.md` | `listKnowledge.blocker` 指针 `716→735`、`dimensions.pagination.blocker` 指针 `3191→3286`；并把"本轮实测已漂到 `:3191`"改成如实表述 | **审查指出的两处错**：① `:3191` 在**基线 `46dc7e0d` 上就已经不是 blocker 行**（该行是证据项的收尾括号，真正的 `dimensions.pagination.blocker` 在 `:3267`）⇒ 不能把"既有的错指针 +19"冠以"本轮实测"；② 该表还有一处同族过期指针（`:726`/`:746` 等），本片只修这两处被点名的，其余标注"2026-10-22 原始测量、待批量重锚" |
| 本页 | 新增 | 证据与未取得项 |

未改：`packages/contracts/**`（契约一个字节没动）、`services/api/**`、`services/api/db/**`、`apps/**`、
`tests/unit/exports-route-http.test.mjs`（既有断言零放宽）。

## 4 台账 `status` 填了什么，为什么

填 **`partial`**。按 `contract-status.json` 的 `status_definitions` 逐条对照（测量时点 `@46dc7e0d`）：

| 定义 | 事实 | 判定 |
| --- | --- | --- |
| `implemented` = "main 上已装配 http 路由，且行为有可复核证据" | 路由已装配、行为有两条单测可复核 —— 机械面**满足** | 但见下 |
| `partial` = "有对应操作代码，但产品 HTTP 未装配、**缺运行条件/分支**，或**存在已记录的契约偏差**" | **两条同时成立**：① **缺运行条件**：部署侧 `deploy/postgres-cvm/sql/20-login-roles.sql` 逐字记载 `services/api/db/roles/egress_ledger.sql` 当前不被任何部署脚本执行，运行时角色对 `public.exports` 只有 `user_id` 一列（`services/api/db/roles/auth_privacy.sql` 的授权面）⇒ 真库上 `SELECT * FROM public.exports` 触 42501 ⇒ 本 operation 在**真实环境只能证到 503**，happy path 只在 PGlite + 补授 `SELECT` 的合成臂里跑通；② **存在已记录的契约偏差**：非媒体写入方（`conversation_turn`/`checked_content`）与 81..128 长度的对象键会以 **200 原样返回**，越 `TargetRef.type` 枚举与 `object_ref.id` 的 1..80（详见 §8.5，含本片自造探针读数） | **判 `partial`**（且比只凭①更硬） |
| `planned` = "未取得对应操作的产品实现证据" | 与事实不符（路由 + 2 条单测 + PGlite 全链臂都在） | 不成立，故移出 |

⇒ 结论：**代码面接近 `implemented`，但"运行条件"与"已记录的契约偏差"两条都停在 `partial`**。按「⛔ 不得虚报
implemented」的纪律取严的一方，并在 `blocker` 里把"已交付什么 / 还差什么 / 已知偏差"逐条写清，不用旧文案的
"路由待装配"（那句在 main 上已被事实推翻）。

## 5 隐私审查自证

**① 响应字段白名单（唯一允许出现的键）** —— 测试**从契约文件现读**，不手抄常量：

| 层级 | 白名单 |
| --- | --- |
| 封套顶层 | `data`、`meta` |
| `data` | `items`、`next_cursor` |
| `meta` | `request_id`、`contract_version`、`execution_mode` |
| `items[]`（= `Export.required`） | `id`、`object_ref`、`purpose`、`recipient_id`、`consent_epoch`、`state`、`sent_at`、`deletion_state` |
| `object_ref` | `type`、`id`、`revision` |

`tests/unit/exports-privacy-redlines.test.mjs` 断言 `Object.keys(item).sort()` 与契约 `Export.properties` 的键集
**逐项相等**，并对每个值做域校验：uuid 形状、`TargetRef.type ∈ 契约 16 值枚举`、`purpose ∈ ConsentPurpose`、
`state ∈ Export.state`、`deletion_state ∈ ThirdPartyState`、`consent_epoch` 为正整数、`recipient_id` 长度 1..80、
`sent_at` 为 ISO date-time 或 null。

**② 响应字段黑名单（一个都不许出现）**

| 类别 | 清单 | 依据 |
| --- | --- | --- |
| 账本内部列 | `user_id`、`auth_epoch`、`recipient_config_version`、`required_consents`、`consent_id`、`object_key`、`source_version`、`provider_request_ref_cipher`、`error_code`、`job_id`、`cancelled_at`、`cancellation_reason`、`requested_at`、`updated_at` | `SELECT *` 会把它们取出来，投影必须丢掉；`provider_request_ref_cipher` 是**密文引用**，泄露即等于泄露外发请求可追踪信息 |
| 凭据/去身份线索 | `sessionSigningKey`、`session_signing_key`、`access_token`、`refresh_token`、`token_hash`、`password`、`secret`、`author_id`、`anonymized_author_ref`、`objectStorageKey`、`storage_key`、`signed_url` | 不导出密钥/会话令牌；不直出内部作者 id，也不把去身份引用当成可回链线索 |
| 运行时值 | 会话**令牌明文**、其 `sha256` 摘要、本片注入的签名密钥 | 三条都断言不出现在响应字节里 |
| 库内哨兵值 | `cfg-MARKER-7f3a`（配置版本）、`src-MARKER-2b91`（来源版本）、`cipher-MARKER-94de`（密文列）、`consent_id` 专用 uuid | 证明黑名单是**按值**也拦，不只按键名 |

**③ 越权面**
- 身份唯一来源是服务端会话存储（`readIdentity`：`userId`/`authEpoch`/`role` 只由守卫填充）；查询串里**没有**
  用户维度 ⇒ `?user_id=`、`?userId=`、`?owner_id=`、`?user=`、`?limit=20&user_id=` 五条一律
  `400 INVALID_REQUEST`（querystring schema `additionalProperties:false`），**永不 200、永不返回任何清单**。
- 他人数据不可见：b 只看到自己那一行；a 的响应里不出现 b 的 `user_id`/接收方，反之亦然；跨用户游标 ⇒
  `400 INVALID_CURSOR`（签名绑定 `userId` + `auth_epoch`，换登录版本、跨列表域、过期、篡改都拒）。
- 后台会话：**实测只能到 `401 SESSION_EXPIRED`**，且这是结构性的 —— `authenticateUser` 只按
  `audience='user'` 查会话，而 `services/api/db/migrations/0001_initial_schema.sql` 对 `sessions` 有
  `CONSTRAINT sessions_audience_is_user CHECK (audience = 'user')`（后台会话在另一张表）⇒ 后台令牌在本路由
  **不可能**走到 `role !== 'user'` 那行。该行是**纵深防御、当前不可达**，本片**不**把它算作已达标的行为，
  对外也**不得**表述成「后台会话返回 403」。

**④ 关于 `recipient_id` 与 `object_ref.id` 的口径（不是泄露）**：`recipient_id` 是**外部接收方**的公开标识
（契约限 1..80 字符），不是内部用户 id；`object_ref.id` 是**本人对象**的标识（契约要求必填，媒体维是 uuid、
非媒体维走 `object_key` 文本键），不含任何他人主体信息。

## 6 负控制（4 条，都是"改坏就红"的实测）

| # | 变异（改的是业务代码，跑完即还原） | 该变异**唯一**能命中的红点 | 实测失败原文（节选） |
| --- | --- | --- | --- |
| N1 | `packages/privacy/egress.mjs` 的 `toContractExport` 返回值加一个 `user_id: record.userId` | 键集断言（黑名单同向命中） | `actual` 键集多出 `user_id` |
| N2 | `routes/exports.ts` 在信封上加契约外字段 `debug: 'cfg-MARKER-7f3a'`（**只带库内值、不改任何契约内字段**） | **黑名单「按值」臂**（键集/等值/枚举断言全不触发，`debug` 也不在键名黑名单里） | `AssertionError: 哨兵「configVersion」的库内值不得进响应：cfg-MARKER-7f3a` |
| N3 | `routes/exports.ts` 无池时 `throw 503` 改成 `200 { items: [], next_cursor: null }` | "不拿空清单冒充成功"臂 | arm ① 期望 503 实得 200 |
| N4（**订正**） | 把内部值塞进契约内字段 `recipient_id: record.recipientId + "\|" + record.recipientConfigVersion` | ⚠ **不是**黑名单：先红在测试里的 `recipient_id` **等值断言**上 ⇒ 这条**不能**用来证明「按值也拦」。本页上一版把它记成"哨兵断言失败"是归因错误，已按审查意见改正；真正证明按值拦截的是 **N2** | 等值断言 `'synthetic-vendor-a' !== 'synthetic-vendor-a\|cfg-MARKER-7f3a'` |

还原后 `git status --porcelain` 只剩本片自己的新增/修改项（每次还原都有读数留档；探针脚本本身放在仓外
`.pg17/tmp/` 并在收工前删除）。

## 7 门禁末行（本 worktree 实测，`node v24.16.0`）

| 命令 | 末行读数 |
| --- | --- |
| `python3 tools/validate_contracts.py` | `PASS: 115 operations; contract consistency; 29 fixtures; 30 media traces; 8 knowledge roundtrips (design only, not runtime tests)` ⇒ `exit 0` |
| `npm run test:contract` | `ℹ tests 16 / ℹ pass 16 / ℹ fail 0` |
| `node --test tests/unit/{exports-privacy-redlines,exports-route-http,contract-planned-exemptions,knowledge-ledger-sort-drift}.test.mjs` | `ℹ tests 16 / ℹ pass 16 / ℹ fail 0`（含本页订正后重跑的 `knowledge-ledger-sort-drift`：台账滞后登记重锚后 4/4） |
| `node tools/verify-contract-status.mjs` | `PASS: 覆盖 115 条契约操作；已装配 113 条；implemented 17 / partial 96 / planned 2；形状错误 0 项；语义错误 0 项` + `PASS: 中文表格一致` ⇒ `exit 0` |
| `node tools/verify-doc-anchors.mjs --strict` | **`exit 1`（基线即红）**：`BASELINE: 登记 99 条；本次命中 99 条、基线外新增 8 条、陈旧 0 条`。**关键读数**：`@46dc7e0d` 的干净检出（`git worktree add --detach`，仓外）**同样**是 8 条且**逐条相同**（两边清单做过逐行 `Compare-Object`）⇒ 本片**新增 0 条**；那 8 条全部是 `services/api/src/app.ts` 的历史行号漂移，与 `me/exports` 无关（不属本片范围，未动基线文件） |
| `npm run lint` | `lint 通过（静态检查；不代表运行期或真实服务已通过）。` ⇒ `exit 0` |

## 8 未取得 / 剩余风险（如实登记）

1. **真实 PG17 集成臂未取得**：`tests/integration/` 未新增脚本，CI 真库 workflow 未改。原因是真库上运行时角色
   对 `public.exports` 连 `SELECT` 都没有（见 §4），这条臂在真库上**只能证到 503**；happy path 已用
   PGlite + `SET ROLE` 复现同一条 42501 路径与同一批迁移文件，但**不等价于**原生 PG17 证据。
2. **部署侧读授权面未改**：`public.exports` 的运行时读权限属运维动作（`egress_ledger` 组未部署），本片不动。
3. **真实外发账本数据与真机/小程序链路未取得**；本片全部是合成账号 + 合成账本行。
4. **failmatrix 未覆盖 `me/exports`**：`tests/failmatrix/cases.mjs` 的矩阵仍不含本域（既有四域未纳入之一），
   本片未扩写。
5. **契约偏差（本片当时实测可达、当时未修；GY-R35 `#568` 已处置，见下方更新块）—— 上一版把它写成"潜伏、非现网"是错的，已订正**：

   > **2026-10-25 更新（GY-R35 · `#568`）**：本项已按裁定处置，随本 PR 合入——契约 `TargetRef.type` 补入 `conversation_turn`（16→17），
   > `toContractExport` 已按 `EXPORT_OBJECT_TYPES` 逐项校验并把 `object_ref.id` 限到 1..80，写入侧 `OBJECT_KEY_MAX` 由 128 收到 80，
   > `synthesis-egress.ts` 不再借用账本标签（按真实内容类型记账），历史越界键由迁移 `0040` 回填、不可如实回填时整条中止。
   > **下文 5.1–5.6 保留的是当时的实测读数（16 值枚举、上限 128、只判 typeof），作为历史证据，不再是当前事实**；
   > 契约偏差面未改的部分只剩库层 `0018_favorites_history.sql` 的 `target_type` CHECK（仍是旧 16 值，今日写入口不可达，已登记待另开迁移）。
   1. **当时**：写入方至少两处、`object_type` 至少三种（都在产品装配里）：
      - `services/api/src/privacy/task-egress.ts`：`objectType: 'media'`（媒体作业外发），以及
        `objectType: CHAT_EGRESS_OBJECT_TYPE`，而 `CHAT_EGRESS_OBJECT_TYPE = 'conversation_turn'`（问答外发）；
      - `services/api/src/privacy/synthesis-egress.ts`：`SYNTHESIS_LEDGER_OBJECT_TYPE = 'checked_content'`，
        在 `findReservedByObject` 与 `reserve` 两处使用（合成域外发）；
      - 接线：问答侧 `services/api/src/ai/chat-wiring.ts` 的 `createChatEgress({ dataType: 'checked_content', … })`
        由 `services/api/src/app.ts` 的 `planConversationChat(...)` 调用；合成侧 `createSynthesisEgress(...)`
        在 `services/api/src/app.ts` 的合成域装配里（`egressLedger === null || privacyInFlight === null` 时才不建）。
        ⚠ 前提是**账本可用**（`real` + 有池），这一点与 §4"真库只能证 503"并不矛盾：装配存在、写入路径存在，
        只是当前真库的**读**面缺授权。
   2. **当时**：`conversation_turn` 与 `checked_content` 都**不在**契约 `TargetRef.type` 的 **16 值**枚举内
      （枚举 = `species/herbicide/scheme/static_region/recognition/ocr/transcription/answer/post/comment/
      conversation/dose_card/media/synthesis/job/source`）；`media` 在枚举内，这两个不在。
   3. **投影不校验**：`packages/privacy/egress.mjs` 的 `toContractExport` 对 `objectType`、`objectId` **只判
      `typeof === 'string'`** —— 既不校验 `object_ref.type ∈ TargetRef.type`，也**不校验 `object_ref.id` 的
      1..80 上限（契约 `maxLength: 80`）**；作为对照，同一个函数校验了 `id.length === 0`、
      `EXPORT_STATES.includes(state)`、`recipientId` 1..80。而**当时的写入侧**上限是 **128**
      （`services/api/src/privacy/ledger-pg.ts` 的 `OBJECT_KEY_MAX = 128`，正则允许 0..126 中间字符）⇒
      **81..128 长度的对象键合法入库，并会原样出现在 `object_ref.id`**。
   4. **本片自造探针读数**（PGlite + 真实 `buildApp` HTTP + 与生产写入方同形的 4 行合成数据：`media` 1 条、
      `checked_content` 2 条（其中一条键长 96）、`conversation_turn` 1 条）：`HTTP_STATUS 200`，`ITEMS 4`，
      `TALLY outOfEnum=3/4 over80=1`；逐条为 `conversation_turn`（inContractEnum=false）、
      `checked_content`（idLen=96 > 80）、`checked_content`（inContractEnum=false）、`media`（inContractEnum=true）。
      ⇒ **200 可返回越枚举条目与超长 `object_ref.id`**，属**可达**的契约偏差（与审查者探针读数一致：
      4 条中 3 条越枚举、1 条 id 长 96）。探针脚本已在收工前删除，`git status` 复核干净。
   5. **当时本片为什么不修**：① 改 `toContractExport` 属**他片领域**（`packages/privacy/egress.mjs` 是 GY-I27 外发账本
      的共享投影），本片纪律是「不擅自扩领域」；② 两种修法都要**产品裁定**：把 `conversation_turn`/`checked_content`
      加进契约 `TargetRef.type`（**改契约**，会影响所有消费方），或让投影对未登记类型 **fail-closed**（后果是
      用户整页 `503`，比"列出条目"更差）；③ 长度面需与写入侧 `OBJECT_KEY_MAX` 一起定口径（收紧到 80？还是把契约
      放宽），同样是契约级决定。
   6. **后续落点**：另开切片，先在 PR 里做一次三选一裁定（枚举扩项 / 投影 fail-closed / 写入侧改写 `object_type`），
      再补 `object_ref.id` 的 1..80 校验与两条判据（越枚举 ⇒ 拒；81..128 键 ⇒ 拒），并在本 operation 的 `blocker`
      里同步"已收口"。本片已把该偏差写进台账 `blocker`（见 §4 / §3），使 `partial` 的"存在已记录的契约偏差"
      这一条**有据可查**，而不是只停在口头。
6. **台账行号引用债（本片量测的口径与读数）**：本片给 `contract-status.json` 插入 19 行，该文件第 407 行之后的
   行号整体 +19。**独立实测**（扫描 `docs/**/*.md|json|mjs` 中的**全限定**形式
   `docs/architecture/contract-status.json:NNNN`，正文行级统计）：
   **30 处**这样的引用，其中 5 处在插入点之前（不受影响）、**25 处跨过插入点**、跨过的这 25 处里
   **23 处在基线 `46dc7e0d` 上指向实质字段行**（另 2 处在基线时就已经是收尾括号 ⇒ 属既有的 SUSPECT 债）。
   受影响文件 10 个。本片只重锚 **3 个文件 / 4 处**（其中 `gy-r29-i07-ledger-lags.json` 是机器登记表，
   另 3 处是 docs 引用）；审查者给的"50 处 / 37 处跨过 / 33 处实质"应是**含 `:NNNN` 同段简写形式**的口径
   （本片实测这类简写在 `docs/**` 里有约 3k 处，无法逐条判定是否指本文件，故未计入）。两者量级一致，
   **结论相同**：绝大多数跨过插入点的引用**没有**被本片重锚。
   **闸门能不能看见它们（订正审查的一条前提）**：`tools/verify-doc-anchors.mjs` **校验**这类引用 ——
   本片实测证据：重锚前 `--strict` 报"基线外新增 11 条"（8 条既有 + 我引入的 1 条 `OUT_OF_RANGE` +
   **3 条 `contract-status.json` 引用变成"只剩收尾括号"的 SUSPECT**），把 3 处重定位后回到"8 条、与基线逐条相同"。
   所以它**能**看见行号引用，但**只判结构性**（路径是否在仓内、行号是否越界、区间里有没有实质内容行），
   **不判**"这一行是否还是原来那个字段"⇒ 那 23 处"仍实质但可能已错位"的引用正是闸门盲区。
   **结论不变**：建议另开**批量重锚片**统一处理（不要在各片里零散改历史页——历史页里存在
   "在某 SHA 上仍在 `:395`"这类必须保留的历史读数）。
7. **本页不判定契约验收**：`status` 是人工判定，`tools/verify-contract-status.mjs` 只验证引用形式/锚点/表格一致，
   不证明语义正确、真实能力或整项验收。

## 9 复核方式（可直接粘贴）

```bash
git -C <worktree> rev-parse HEAD
git -C <worktree> status --porcelain
node --test tests/unit/exports-privacy-redlines.test.mjs tests/unit/exports-route-http.test.mjs tests/unit/contract-planned-exemptions.test.mjs
node tools/verify-contract-status.mjs          # 期望 exit 0
node tools/verify-doc-anchors.mjs --strict     # 期望 exit 1 且仍是那 8 条（基线即红，见 §7）
npm run test:contract
git -C <worktree> merge-tree --write-tree upstream/main HEAD   # 合流预演（须先 git fetch upstream --prune）
```

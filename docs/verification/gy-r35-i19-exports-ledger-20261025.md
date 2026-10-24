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
| `docs/verification/gy-i16-i17-deletion-cascade-20261021.md`、`docs/verification/gy-issue-closure-index-20261018.md`、`docs/verification/gy-r31-i07-sort-20261022.md` | 3 处 `contract-status.json` 行号引用各 **+19** | 本片给台账插入 19 行，这 3 处原引用被推成"只剩收尾括号"的行 ⇒ `--strict` 新增 SUSPECT。按最小改动只重定位这 3 处（目标内容与原引用同类：同为该证据项的起始行），**不改任何历史结论**；其余引用见 §8.6 |
| 本页 | 新增 | 证据与未取得项 |

未改：`packages/contracts/**`（契约一个字节没动）、`services/api/**`、`services/api/db/**`、`apps/**`、
`tests/unit/exports-route-http.test.mjs`（既有断言零放宽）。

## 4 台账 `status` 填了什么，为什么

填 **`partial`**。按 `contract-status.json` 的 `status_definitions` 逐条对照（测量时点 `@46dc7e0d`）：

| 定义 | 事实 | 判定 |
| --- | --- | --- |
| `implemented` = "main 上已装配 http 路由，且行为有可复核证据" | 路由已装配、行为有两条单测可复核 —— 机械面**满足** | 但见下 |
| `partial` = "有对应操作代码，但产品 HTTP 未装配、**缺运行条件/分支**，或存在已记录的契约偏差" | **缺运行条件**：部署侧 `deploy/postgres-cvm/sql/20-login-roles.sql` 逐字记载 `services/api/db/roles/egress_ledger.sql` 当前不被任何部署脚本执行，运行时角色对 `public.exports` 只有 `user_id` 一列（`services/api/db/roles/auth_privacy.sql` 的授权面）⇒ 真库上 `SELECT * FROM public.exports` 触 42501 ⇒ 本 operation 在**真实环境只能证到 503**，happy path 只在 PGlite + 补授 `SELECT` 的合成臂里跑通 | **判 `partial`** |
| `planned` = "未取得对应操作的产品实现证据" | 与事实不符（路由 + 2 条单测 + PGlite 全链臂都在） | 不成立，故移出 |

⇒ 结论：**代码面接近 `implemented`，运行条件面停在 `partial`**。按「⛔ 不得虚报 implemented」的纪律取严的一方，
并在 `blocker` 里把"已交付什么/还差什么"逐条写清，不用旧文案的"路由待装配"（那句在 main 上已被事实推翻）。

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
- 后台会话：路由层另判 `identity.role !== 'user'` ⇒ `403 SCOPE_DENIED`（与 `GET /me/consents` 同口径；
  该分支是纵深防御，HTTP 上先进用户门禁 ⇒ 后台令牌实测 `401 SESSION_EXPIRED`，两条都不给用户清单）。

**④ 关于 `recipient_id` 与 `object_ref.id` 的口径（不是泄露）**：`recipient_id` 是**外部接收方**的公开标识
（契约限 1..80 字符），不是内部用户 id；`object_ref.id` 是**本人对象**的标识（契约要求必填，媒体维是 uuid、
非媒体维走 `object_key` 文本键），不含任何他人主体信息。

## 6 负控制（3 条，都是"改坏就红"的实测）

| # | 变异（改的是业务代码，跑完即还原） | 新测试的红点 | 实测 |
| --- | --- | --- | --- |
| N1 | `packages/privacy/egress.mjs` 的 `toContractExport` 返回值加一个 `user_id: record.userId` | 键集/黑名单两条 | **红**：`actual` 键集多出 `user_id`（`ERR_ASSERTION`） |
| N2 | 把内部值塞进**契约内**字段：`recipient_id: record.recipientId + "\|" + record.recipientConfigVersion` | 只按键名拉黑会漏 ⇒ 必须按值 | **红**：哨兵断言失败 |
| N3 | `routes/exports.ts` 无池时 `throw 503` 改成 `200 { items: [], next_cursor: null }` | "不拿空清单冒充成功" | **红**：arm ① 期望 503 实得 200 |

还原后 `git status --porcelain` 只剩本片自己的新增/修改项（两次还原均有读数留档）。

## 7 门禁末行（本 worktree 实测，`node v24.16.0`）

| 命令 | 末行读数 |
| --- | --- |
| `python3 tools/validate_contracts.py` | 见交付回报（PASS / exit 0） |
| `npm run test:contract` | 见交付回报 |
| `node --test tests/unit/exports-privacy-redlines.test.mjs tests/unit/exports-route-http.test.mjs tests/unit/contract-planned-exemptions.test.mjs` | 见交付回报（3 + 3 + 6 全绿） |
| `node tools/verify-contract-status.mjs` | `PASS: 覆盖 115 条契约操作；已装配 113 条；implemented 17 / partial 96 / planned 2；形状错误 0 项；语义错误 0 项` ⇒ `exit 0` |
| `node tools/verify-doc-anchors.mjs --strict` | **`exit 1`（基线即红）**：`BASELINE: 登记 99 条；本次命中 99 条、基线外新增 8 条、陈旧 0 条`。**关键读数**：`@46dc7e0d` 的干净检出**同样**是 8 条且**逐条相同**（用 `git worktree add --detach` 在仓外临时检出实测对比）⇒ 本片**新增 0 条**；那 8 条全部是 `services/api/src/app.ts` 的历史行号漂移，与 `me/exports` 无关（不属本片范围，未动基线文件） |
| `npm run lint` | 见交付回报 |

## 8 未取得 / 剩余风险（如实登记）

1. **真实 PG17 集成臂未取得**：`tests/integration/` 未新增脚本，CI 真库 workflow 未改。原因是真库上运行时角色
   对 `public.exports` 连 `SELECT` 都没有（见 §4），这条臂在真库上**只能证到 503**；happy path 已用
   PGlite + `SET ROLE` 复现同一条 42501 路径与同一批迁移文件，但**不等价于**原生 PG17 证据。
2. **部署侧读授权面未改**：`public.exports` 的运行时读权限属运维动作（`egress_ledger` 组未部署），本片不动。
3. **真实外发账本数据与真机/小程序链路未取得**；本片全部是合成账号 + 合成账本行。
4. **failmatrix 未覆盖 `me/exports`**：`tests/failmatrix/cases.mjs` 的矩阵仍不含本域（既有四域未纳入之一），
   本片未扩写。
5. **潜伏缺口（未修，登记待裁定）**：`toContractExport` 校验了 `state`，但**未**校验 `object_ref.type` 是否落在
   契约 `TargetRef.type` 的 16 值枚举内；DB 列 `object_type` 是 `varchar(40)` 无 CHECK。当前全仓唯一写入方
   （`services/api/src/privacy/task-egress.ts`）只写 `media`（在枚举内），故属**潜伏**而非现网缺陷；改它要动
   共享投影库 `packages/privacy/egress.mjs`（属隐私域他片），本片按"不擅自扩领域"只登记。
6. **台账行号漂移的连带影响**：本片给 `contract-status.json` 插入 19 行，该文件第 407 行之后的**所有**行号 +19。
   仓内另有若干 docs 引用指向该文件的行号（仍落在实质内容行上、结构性有效，但语义可能已陈旧）。本片按最小占用
   只重定位越过 SUSPECT 阈值的 3 处；**批量重锚建议由后续台账片统一做**，不要在各片里零散改历史页。
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

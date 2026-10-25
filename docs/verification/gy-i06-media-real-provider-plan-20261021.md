# GY-I06 · #6 私有媒体上传「真实对象存储」接线方案（2026-10-21）

- **Issue**：[#6](https://github.com/GengYunChuChao/GengYun/issues/6)（P0 / M1；验收 AC07、AC09、AC23；功能 F05、F12、F13、F15、F16）。**不关闭整项**（`Refs #6`）。
- **分支 / worktree**：`feat/gy-r28-b3-media-real-plan`（独立 worktree `E:\GengYunCommander\wt-b3-media`）。
- **基线 HEAD**：`f7155d5ac1329974b20a6128e332bb84c19c733d`。
- **文档性质**：**只出接线方案，零代码改动**。本片不修改 `services/**`、`packages/**`、`packages/contracts/**`、`.github/workflows/**`，只新增本文件。
- **证据性质**：本片**不产生**任何真实对象存储证据（无真实桶、无真实凭据、未发任何网络请求），**不构成** #6 验收通过，也不改变 [#6 现状证据](gy-i06-private-media-20261014.md) 与 [S3 适配器跑通证据](gy-r27-object-store-s3-paths-20261020.md) 的既有结论。

## 0 一句话结论

真实对象存储适配器**代码已经在 main**（`services/api/src/media/object-store.ts` 455 行，R27-S8 已把 `put/get/has/delete/presign` 全路径在进程内 `fetch` 替身下跑通，并用独立实现逐字节复算 SigV4 签名）。
当前 real 模式上传如实返回 503 `PROVIDER_UNAVAILABLE`，**不是因为缺适配器**，而是三处「门」没有接上，外加一处部署期数据面缺口：

| # | 门 | 现状事实（文件:行号） | 后果 |
| --- | --- | --- | --- |
| 1 | **配置搬运门** | `services/api/src/config.ts:69-79` 只校验 `OBJECT_STORAGE_*` 四键「存在」，`AppConfig`（`services/api/src/config.ts:20-42`）里**没有任何对象存储字段**；装配点 `services/api/src/app.ts:1546` 调 `resolveMediaObjectStore({ executionMode })` **刻意不传 env** | real 模式**恒** `unwired`：校验过的东西到不了装配层，装配层又不敢读 ambient env |
| 2 | **批准门** | `services/api/src/media/service.ts:603` 的 real 分支要求 `realMediaApproval` 必须是 `approveRealMediaWiring()`（`:473`）铸造的 `WeakSet` 品牌（`:470` 的 `APPROVED_REAL_MEDIA_WIRINGS`；以上三处均为合流当前 main 后的行号，本片测量时为 `:595`／`:465`／`:462`）；`buildApp` 只**转发**不铸造（`services/api/src/app.ts:1562`：`...(mediaRealApprovalOption === undefined ? {} : { realMediaApproval: mediaRealApprovalOption })`）；生产入口 `services/api/src/server.ts:51` 只传 `{ config, pool }` | 即使端口是 `s3_compatible`，real 仍整域 503（`services/api/src/media/service.ts:609` 的 fail-closed 服务）。既有断言已把这条钉成「运行期主闸门」：`tests/unit/media-real-mode-fail-closed.test.mjs:1451`（原记 :1431；四键齐备 + 真实端口 + 无批准 ⇒ 仍 fail-closed）、`:1480`（原记 :1460；批准能力不可伪造/不可派生/不可默认化） |
| 3 | **持久化门** | 媒体记录 / 社区句柄 / 幂等台账全在进程内 `Map`/`Set`（原记 `:624-629`；该符号在 `1d65b7ee` 已不存在——`git grep -n "new Map<" 1d65b7ee -- services/api/src/media/service.ts` ⇒ 0 命中，最后见于 `1fbe7572:624-629`，`records`／`grants`／`idempotency`／`inflight` 四个容器；现行记录已改由 `persistence` 端口持有） | 重启即丢 owner、`revision`、`rawRef`；`expireInitiated`（`:1239`）、`cleanupOrphans`（`:1250`）在 main 无生产调用者 ⇒ 删除链与 24h 回收**没有依据** |
| 4 | **数据面缺口（部署件）** | 冻结契约内**没有**「owner 私有媒体字节读取」这一 operation；`MEDIA_ACCESS_GRANT_ORIGIN` 指向的访问网关在本仓库内**无实现** | 句柄签发得出来，但没人消费；本仓不能自称「契约已实现」 |

**最关键的判断**：#6 的真实接线工作量**不在适配器层**（第一层可新增代码为 0 行），而在**配置搬运 + 批准铸造点 + PG 持久化 + 部署期网关**这四件。

## 1 口径与边界

| 项 | 本方案的处理 |
| --- | --- |
| 契约 | **不动** `packages/contracts/**`。owner 私有字节读取的契约缺口**如实保留**，不在本片补 operation |
| CI | **不动** `.github/workflows/**`。测试改造点只给「要接哪条脚本、哪个 workflow 已有真库臂」，实际接线另开片 |
| 代码 | **不动**。所有「新增/修改」都写成待实施的 `文件:行号` 清单，供后续实现片照单执行 |
| fail-closed | 三道门的**默认值一律保持关闭**：缺配置/缺批准 ⇒ 503，不排队、不回退 `stub`/`preset_demo`、不静默用替身顶替 |
| 证据口径 | 接线完成后仍**不**产出识别准确率、EXIF 清除效果统计、音色质量或任何验收结论；只产出「上传→清除→读回」的字节级事实 |
| 供应商 | **未定**（用户/指挥决策项，见 §9 R1）。方案保持 provider-agnostic，只锁「https + SigV4 预签名 + 单次 PUT」这条能力面 |

## 2 四域真实供应商接入的共同模式（抽出来给媒体域用）

权威范式是 [真实供应商接线规范](provider-adapter-live-wiring.md)。把 OCR / ASR / TTS / moderation 四域的既有实现放在一起看，可抽出五条共同模式：

| 模式 | 具体形态 | 出处 |
| --- | --- | --- |
| 端口对象 + 无默认实现 | 真实分支的全部外呼能力收进一个**注入式端口对象**，字段全必填、类型上不给默认实现 ⇒ 「默认关闭」不靠易忘开关 | `services/api/src/tts/live-ports.ts` 的 `RealTtsPorts`（`liveGate`/`authorization`/`profile`/`credentials` 必填） |
| 能力声明与失败分离 | `available: boolean` + `unavailableReason: string \| null`；缺凭据时 `available=false`（受理前就拒），`extract()` 仍如实返回失败而**不**回退替身 | `services/api/src/ocr/provider.ts` 的 `OcrProvider` 与 `createRealOcrProvider` |
| real 下忽略注入替身 | 装配函数在 real 模式**不采信**任何注入的替身端口，返回 `{ ports:{}, substitutes:[], fail_closed:true }` | `services/api/src/moderation/provider.ts` 的 `resolveModerationPorts` |
| 顺序即安全 | `build(本地) → reserve(闸门) → sign(TC3) → send(恰好一次) → settle(无论成败)`；`maxRetries` 契约锁 0 | 同规范的 §2.2；`services/api/src/tts/live-ports.ts` 的 `LiveCallGate.reserve/settle` |
| 错误码闭集 | 恒 4 个契约码：`PROVIDER_TIMEOUT`(504) / `PROVIDER_QUOTA_EXCEEDED`(429) / `PROVIDER_OUTCOME_UNKNOWN`(503) / `PROVIDER_UNAVAILABLE`(503)；供应商原始错误码必须原样留台账 | `services/api/src/ocr/provider.ts` 的 `PROVIDER_FAILURE_CODES`；`services/api/src/tts/live-ports.ts` 的 `LIVE_GATE_REFUSALS` 与 `PROVIDER_CALL_STATES` |

**env 命名约定（实测，和直觉不同）**：

| 事实 | 证据 |
| --- | --- |
| `services/api/src/config.ts` 里**没有**任何 `OCR_*` / `ASR_*` / `TTS_*` / `MODERATION_*` 键 | `grep OBJECT_STORAGE_`/`OCR_` 在 `services/api/src/config.ts` 零命中（媒体域是唯一在 `REQUIRED_WHEN_REAL` 里登记存储键的域） |
| 模型的端点白名单不放在 `config.ts`，放在 `tools/ai-config.mjs` 的 `AI_ENDPOINTS`；发送前再断言 host + 全串相等 | 规范 §2.4 |
| 全仓 `process.env` 直读只剩三处：`RECOGNITION_PROVIDER_URL`/`RECOGNITION_PROVIDER_KEY`（`services/api/src/app.ts:1062-1063`）、`APP_KNOWLEDGE_UNVERIFIED_SEED`（`services/api/src/app.ts:1620`、`services/api/src/routes/knowledge.ts:163`）、`DATABASE_URL`（`services/api/src/db/migrate.ts:277`） | 逐处 `grep` 实测（2026-10-25 按符号在 `upstream/main`=`46dc7e0d` 树重取行号） |

**媒体域与四域的结构差异（这决定了方案形状）**：

| 维度 | OCR / ASR / TTS / moderation | 媒体域（#6） |
| --- | --- | --- |
| 真实适配器 | **还没有**（`createRealOcrProvider` 的 `extract` 恒返回 `PROVIDER_UNAVAILABLE`） | **已经有了**（`services/api/src/media/object-store.ts:323`），且全路径被 R27-S8 跑通 |
| 缺什么 | 适配器本体 + 端点白名单 + TC3 签名 + 付费台账闸门 | 配置搬运 + 批准铸造点 + 元数据持久化 + 部署期网关 |
| 外呼性质 | 计费 API，一次调用一条台账 | 对象存储读写，按字节计费、**无「一次调用」台账语义** |
| 失败语义 | `PROVIDER_OUTCOME_UNKNOWN` 表示「可能已扣费」 | `PROVIDER_UNAVAILABLE` + `retryable` 表示「本次写/读/删是否生效未知」；`deleteObject` 返回 `false` 表示**未确认删除，必须保留引用**（`services/api/src/media/object-store.ts:380-387`） |
| 复用结论 | — | 复用「端口无默认实现」「real 忽略注入」「错误码闭集」三条；**不**复用付费台账闸门（对象存储没有按次计费语义） |

## 3 stub 链路现状（它是怎么走通的）

### 3.1 装配链（逐行）

| 步骤 | 代码位置 | 行为 |
| --- | --- | --- |
| 1 | `services/api/src/config.ts:158-173` | 解析 `APP_EXECUTION_MODE`（`stub` \| `preset_demo` \| `real`），非法值进 `ConfigError` |
| 2 | `services/api/src/config.ts:251-260` | real 模式逐项检查 `REQUIRED_WHEN_REAL`，缺项只登记字段名（不回显值） |
| 3 | `services/api/src/app.ts:1546` | `mediaObjectStore = mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode })` —— **不传 `env`** |
| 4 | `services/api/src/media/object-store.ts:448-455` | `resolveMediaObjectStore`：real → `readObjectStorageConfig(NO_STORAGE_ENV)`（null 原型空表）⇒ 必然 `unwired`；非 real → `substitute` |
| 5 | `services/api/src/app.ts:1555-1569` | `createAppMediaService({ executionMode, objectStore, tokenSecret: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY, contentSource: mediaContentSource ?? createClosedContentSource(), accessGrantOrigin: config.mediaAccessGrantOrigin ?? undefined, ... })` |
| 6 | `services/api/src/app.ts:2108` | `app.decorate('mediaObjectStore', mediaObjectStore)`（测试与自证用） |
| 7 | `services/api/src/app.ts:2250` | `registerMediaRoutes(app, config, guards, mediaService, { consent: consentGate })` —— 7 条路由的唯一注册点（GY-R34-I19 树重取；此前后续片在 `app.ts` 上半部新增装配行，行号已上移） |
| 8 | `services/api/src/server.ts:27` | 生产入口 `buildApp({ config, pool })`：**不传** `mediaObjectStore`、**不传** `realMediaApproval` |

### 3.2 stub 下一次上传的完整走向

| 阶段 | 服务方法（行号） | 实际发生 |
| --- | --- | --- |
| 受理 | `initiateUploadUnclaimed`（`services/api/src/media/service.ts:936-1006`；原记 :807-874） | 幂等占位（`withKeyClaim` 在任何 await 之前同步取得，`:869-874`）→ `validateUploadInput` 校验用途/类型/字节/哈希 → `presignUpload({ key: rawRef, expiresInSeconds: 86400 })`（`:973-979`，原记 :838-844；句柄 = 本地拼的 `https://substitute.invalid/...`）→ 落 `records` + `idempotency` |
| 完成 | `completeUploadUnclaimed`（`:1008-1133`；原记 :876-953） | `getObject(rawRef)` 取回字节（`:1048`，原记 :907）→ `assertBytesMatchDeclaration`（`:1057`，原记 :916，魔数/字节数/sha256/音频真实时长）→ 图片走 `stripImageMetadata`（`:1069`，原记 :928）→ `putObject(derivativeRef, ...)`（`:1076`，原记 :935）→ `ready`（`:1083`，原记 :943） |
| 读元数据 | `getMedia`（`:1135-1138`；原记 :975-978） | 只 owner 可读；非本人与不存在**逐字节同形** 404 |
| 签句柄 | `grantMediaAccess`（`:1194-1225`；原记 :1021-1052） | 仅 owner 且仅 `ready`；`access_token` 是 HMAC 令牌，**不入 URL**；URL = `${accessGrantOrigin}/api/v1/media/${id}/content` |
| 删除 | `deleteMediaUnclaimed`（`:1140-1190`；原记 :980-1009） | 强 ETag + 幂等；`dropObjects`（`:722`，原记 :667）只在 `deleteObject===true` 时清 `rawRef`/`derivativeRef`，`false`/抛错则**保留引用**待重试 |

⚠ **前提变更（2026-10-25 按符号重取，基线 `1d65b7ee`）**：本表的 `initiateUploadUnclaimed` / `completeUploadUnclaimed` / `deleteMediaUnclaimed` 三个符号在现行树上**已不存在**（`#419` `e5c38a2f` 起改名为 `initiateUpload` / `completeUpload` / `deleteMedia`，记录改由 PG 仓储持有），`withKeyClaim` 亦已不存在（幂等占位改由 `openIdempotentRequest` 落库原子占位）；表内行号已按现行同名语义重取，原值以 `（原记 :N）` 保留（`withKeyClaim` 那一处无对应符号，保留原值未动）；**行为描述仍是基线 `f7155d5a` 上的实测，不代表现行实现**。

> 结论：stub 链路是**完整可用**的（7 条路由 + 幂等 + 强 ETag + EXIF 清除 + 归属判定都在跑），只是存储端口是内存替身、元数据不持久化。

## 4 现状盘点表（7 个 operationId 逐条）

| operationId | 路由（`services/api/src/routes/media.ts`） | 服务入口（`services/api/src/media/service.ts`） | real 现状 | 接线缺口 |
| --- | --- | --- | --- | --- |
| `createUpload` | `:218-233` | `initiateUploadUnclaimed` `:936-1006`（原记 :807-874） | 503 `PROVIDER_UNAVAILABLE`（`retryable:false`，reason=空 env ⇒ `unwired`） | 配置搬运（门 1）+ 批准（门 2）+ 持久化（门 3）；`community_image` 另有每帖计数未接线（`:327`，原记 :319；`retryable:false`） |
| `completeUpload` | `:236-257` | `completeUploadUnclaimed` `:1008-1133`（原记 :876-953） | 同上（fail-closed 服务整体拒绝） | 同上；另需真实字节回取的大小/超时/并发保护（§9 R5） |
| `getMedia` | `:260-275` | `getMedia` `:1135-1138`（原记 :975-978） | 同上 | 元数据持久化（门 3）；无对象存储读操作 |
| `deleteMedia` | `:278-295` | `deleteMediaUnclaimed` `:1140-1190`（原记 :980-1009） | 同上 | 门 3 + 删除链（§9 R3）；`deleteObject` 未确认时保留引用的语义要能跨重启 |
| `grantMediaAccess` | `:298-315` | `grantMediaAccess` `:1194-1225`（原记 :1021-1052） | 同上 | 句柄消费网关（门 4）+ `MEDIA_ACCESS_GRANT_ORIGIN` 必须配成真实网关域 |
| `grantCommunityMediaAccess` | `:318-334` | `grantCommunityMediaAccess` `:1229-1347`（原记 :1056-1174） | 默认 404（内容来源关闭，`createClosedContentSource`，fail-closed 不误放行） | 属社区/审核线（GY-I14/I15）提供只读端口后在装配层注入；**不在本片范围** |
| `readCommunityMediaContent` | `:337-362` | `readCommunityMediaContent` `:1349-1397`（原记 :1176-1222） | 同上（仅出 `derivativeRef` 的去 EXIF 字节，`:1391`，原记 :1218） | 同上；真实 CDN/网关与原桶 URL 重定向策略未验收 |

⚠ **前提变更（同上）**：本表「服务入口」列的行号已按现行同名语义重取（原值见 `（原记 :N）`；`*Unclaimed` 三个符号已改名，现行实现见 `services/api/src/media/service.ts` 的 `initiateUpload` / `completeUpload` / `deleteMedia`）；「路由」列 `:218-233` 等七段仍在 `services/api/src/routes/media.ts` 上逐条命中。

补充事实：七条路由的契约面状态在 `docs/architecture/contract-status.json` 里均为 `partial`，逐条 `blocker` 与本表一致（`createUpload` 在 `:564`、`completeUpload` `:591`、`getMedia` `:618`、`deleteMedia` `:645`、`grantMediaAccess` `:672`、`grantCommunityMediaAccess` `:3216`、`readCommunityMediaContent` `:3243`）。（以上七处 2026-10-25 按 `contract-status.json` 的 `id` 行重取；原记 `:498`／`:525`／`:552`／`:579`／`:606`／`:3047`／`:3074`）

## 5 接线三层

### 5.1 第一层：对象存储 SDK 层 —— **新增代码 0 行，只差配置搬运与装配**

| 动作 | 文件:行号 | 说明 |
| --- | --- | --- |
| 修改 | `services/api/src/config.ts:20-42`（`AppConfig`） | 新增一等字段 `objectStorage: ObjectStorageConfig \| null`（类型从 `services/api/src/media/object-store.ts:179` 复用）。**不得**加「裸字符串四件套」，避免密钥散落 |
| 修改 | `services/api/src/config.ts:251-260` | real 模式下把 `REQUIRED_WHEN_REAL` 的存在性检查升级为「产出结构化 config 或抛 `ConfigError`」：直接调用 `readObjectStorageConfig(env)`（`services/api/src/media/object-store.ts:197`）并把 `issues` 折进 `ConfigError`（复用既有 `ConfigIssue { field, code, reason }` 形状，`services/api/src/config.ts:44-51`） |
| 修改 | `services/api/src/config.ts:69-79` | 保留 `OBJECT_STORAGE_*` 在 `REQUIRED_WHEN_REAL` 里（防止有人误删），但**判定权**移到上一行的结构化解析 |
| 修改 | `services/api/src/app.ts:1546` | real 分支改为 `resolveMediaObjectStore({ executionMode, env: config.objectStorageEnv })`，其中 `objectStorageEnv` 是**从 `AppConfig` 派生的已解析配置**，**绝不能**是 ambient `process.env` |
| ⛔ 禁止 | `services/api/src/app.ts:1546` | **不得**写成 `env: process.env`：`tests/unit/media-real-mode-fail-closed.test.mjs:519-541`（原记 :329-337）有静态断言逐字钉住（PR #193 的 P1 结论：配置即门控） |
| ⛔ 约束 | `services/api/src/app.ts` 全文件 | ambient env 只允许 3 个非媒体键（`tests/unit/media-real-mode-fail-closed.test.mjs:1121`（原记 :1050）的全文件审计 + `:1298`（原记 :1227）运行期来源检查）；新增的「从 `AppConfig` 派生」取值**不是** ambient 读取，不受此限，但也不得借此新增第四个 `process.env[...]` |
| ⛔ 禁止 | `services/api/src/media/**` | **不得**在媒体域内读 `process.env` / `import.meta.env`（`services/api/src/media/service.ts:281-283` 已把该约束写进注释，同上测试做 AST 级判违规） |
| 保留 | `services/api/src/media/object-store.ts:448-455` | `resolveMediaObjectStore` 的「缺任一键 ⇒ `unwired`」语义**不改**：`tests/unit/media-real-mode-fail-closed.test.mjs` 的 1-A 用例逐键验证 |
| 建议增强 | `services/api/src/media/object-store.ts:224`（`readObjectStorageConfig` 的 endpoint 校验） | 现正则 `/^https:\/\/[^\s/]+/i` 只挡 http 与空 host，`https://evil.example/whatever` 能过。建议补「无 path/query/fragment + host 白名单」（与 [规范 §2.4](provider-adapter-live-wiring.md) 的端点白名单同口径） |

### 5.2 第二层：签名 / 句柄层 —— 缺 3 件

| # | 缺口 | 现状事实 | 建议动作（文件:行号） |
| --- | --- | --- | --- |
| 2.1 | **临时密钥不支持** | `presignS3Url`（`services/api/src/media/object-store.ts:283-313`）的签名查询串只有 5 个 `X-Amz-*` 参数，**没有** `X-Amz-Security-Token`；`send()` 的请求头（`:341-346`）也没有 `x-amz-security-token` | 若采用 CAM/STS 临时密钥（与 TTS/ASR 的 `TENCENTCLOUD_SESSION_TOKEN` 做法一致），必须扩 `services/api/src/media/object-store.ts:283` 的 `options` 与 `:296-302` 的参数表 + `ObjectStorageConfig`（`:179`）增可选 `sessionToken`；否则只能用长期 AK/SK（见 §9 R2） |
| 2.2 | **句柄消费网关无实现** | 契约 85 路径/112 operation 里没有 owner 私有字节读；`DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN`（`services/api/src/media/service.ts:551`）= `https://media.placeholder.invalid`（RFC 6761 保留、永不解析） | 属**部署件**。方案只定契约：网关必须①校验 `X-Media-Access-Token`（1..512，随请求头，**不入 URL**）②按 token 里的 `kind/mediaId/revision/ownerId/exp` 反向校验归属与版本③只回 `derivativeRef` 字节（**绝不**回 `rawRef`）④`Cache-Control: no-store` + 强 ETag。仓内参考实现另开 issue |
| 2.3 | **TTL 与配置面** | 上传句柄 TTL = `MEDIA_INITIATED_TTL_MS` = 24h（`packages/media/constants.mjs:78`）；内部 `send()` 固定 300s 预签名窗口（`services/api/src/media/object-store.ts:340`）；访问句柄 TTL = `MEDIA_ACCESS_TTL_MS` = 300s（`packages/media/constants.mjs:81`） | 24h 上传句柄对真实桶偏长（可用未授权 PUT 占位 24h）。建议把上传句柄 TTL 降为可配置 `MEDIA_UPLOAD_HANDLE_TTL_SECONDS`（建议 900–3600），并在 `services/api/src/config.ts` 加 `100..86400` 范围校验；同时核对契约是否允许改读法（若不改契约，只能在服务层截短） |

### 5.3 第三层：元数据 / 权限层 —— 需新增 PG 持久化 + 批准铸造点

| 动作 | 文件:行号 | 说明 |
| --- | --- | --- |
| 新增 | `services/api/src/media/store.ts`（端口） | 从 `services/api/src/media/service.ts` 的四个进程内容器（原记 `:624-629`；该符号在 `1d65b7ee` 已不存在——`git grep -n "new Map<" 1d65b7ee -- services/api/src/media/service.ts` ⇒ 0 命中，最后见于 `1fbe7572:624-629`）抽出端口：`records`（读/写/CAS by revision）、`grants`、`idempotency`（`claim/finalize/release/purge`）、`pendingObjectRefs`。方法集**逐条**对齐现有内存实现的语义，不做「大致等价」 |
| 新增 | `services/api/src/media/store-pg.ts` | 形状照抄最近三片的 PG 存储（`services/api/src/ocr/store-pg.ts`、`services/api/src/speech/store-pg.ts`、`services/api/src/recognitions/store-pg.ts`）：`pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout = '4s'` → SQL → `COMMIT`；`57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`，其余数据库错误 ⇒ `PROVIDER_UNAVAILABLE`；缺表 ≠ 库坏（三态就绪判定） |
| 新增 | `services/api/db/migrations/0027_media_persistence.sql` | 现有迁移止于 `0026_speech_persistence.sql`；本片新增 `media_records` / `media_grants` / `media_idempotency` / `media_pending_object_refs` 四张表。约束要点：`media_records(revision)` 由一条带 `WHERE revision=$2` 的原子 UPDATE 推进（CAS 唯一裁决点）；`media_idempotency UNIQUE(scope, key_hash)`；`media_pending_object_refs` 以 `(media_id, kind)` 唯一键登记未确认删除的引用。**状态迁移表不在 SQL 里抄第二份**，事实来源仍是 `packages/media` 的 `MEDIA_STATE_TRANSITIONS`（`packages/media/constants.mjs:87`） |
| 修改 | `services/api/src/media/service.ts:263-289`（`AppMediaServiceOptions`） | 新增 `store?: AppMediaStore`（缺省仍用内存实现，保持 stub/preset_demo 与全部既有测试不变） |
| 修改 | `services/api/src/media/service.ts` 的四个容器（原记 `:624-629`；该符号在 `1d65b7ee` 已不存在——`git grep -n "new Map<" 1d65b7ee -- services/api/src/media/service.ts` ⇒ 0 命中，最后见于 `1fbe7572:624-629`；现行记录已由 `persistence` 端口持有，见同文件 `:640`） | 四个容器改为经 `store` 存取；`transition`（`:659`；原记 :648）与 `dropObjects`（`:722`；原记 :667）的判定逻辑**原样保留**，只换写入目标 |
| 修改 | `services/api/src/app.ts`（`buildApp` 顶部 import 区按仓库惯例把新 import 追加到文件末尾，`services/api/src/app.ts:2406` 已有此先例） | 有 `pool` 时构造 PG store 并注入；无 `pool` 时保持内存实现（与 `community/store-pg.ts` 的装配口径一致） |
| 修改 | `services/api/src/app.ts`（real 装配段） | **批准铸造点**：见 §10 D2 的三个选项；无论选哪个，必须①唯一铸造点②可审计（记 reason/approvedAt）③保留 `objectStore.kind==='s3_compatible'` 的第二道校验（`services/api/src/media/service.ts:595` 起） |
| 新增（可选） | `services/api/src/media/cleanup.ts` | `expireInitiated`（`:1412`；原记 :1239）/`cleanupOrphans`（`:1424`；原记 :1250）今天无生产调用者。真实接线后必须有驱动方（定时器或外部 cron 打内部端点），否则 24h 过期对象永久计费、`pending` 引用永不重试 |

### 5.4 依赖顺序与「最小可用切片」

```
①配置搬运（0.5–1 人日，可独立交付、零风险）
   └─→ ③元数据持久化（必须先于真实外呼上线，否则重启即丢所有权）
          └─→ ②签名/句柄（临时密钥？（视供应商）+ 网关）
                    └─→ 清理器驱动 + 删除链闭环
```

**为什么不能先接真实外呼再补持久化**：`completeUpload` 在真实桶下会产生两个真实对象（`rawRef` + `derivativeRef`），而 `dropObjects`（`services/api/src/media/service.ts:667`）只在 `deleteObject===true` 时清引用，未确认删除时**必须**保留引用待重试。若状态只在内存，进程重启即丢失重试依据 ⇒ 违反「未确认删除不得丢重试依据」的隐私红线（[#6 证据 §11](gy-i06-private-media-20261014.md)）。

## 6 EXIF 清除的落点（字节级）

| 维度 | 结论 |
| --- | --- |
| **哪一步** | `completeUpload`，即「客户端直传完成之后、服务端核验时」。**不在** `createUpload`（那时只有声明值，没有字节），**不在**读路径（读路径只挑对象） |
| **代码位置** | `services/api/src/media/service.ts:1008-1133`（原记 :876-953；现行同名实现为 `completeUpload`）；关键三行：`:1048`（原记 :907）`objectStore.getObject(record.rawRef as string)` → `:1069`（原记 :928）`stripImageMetadata(stored.bytes, detected.mime)` → `:1076`（原记 :935）`objectStore.putObject(derivativeRef, stripped.data, detected.mime)` |
| **字节级实现** | `packages/media/exif.mjs:432` 的 `stripImageMetadata(bytes, mime)`（441 行文件的最后一个导出）：按容器结构性移除元数据段——JPEG 去 `APP1:Exif` / `APP1:XMP` / `APP13:Photoshop`，PNG 去 `eXIf` / `tEXt` / `iTXt` / `zTXt`，WebP 去 `EXIF` / `XMP ` chunk（并重算 RIFF 声明长度）。同时**拒绝容器尾部多余字节**（PNG IEND 之后、JPEG EOI 之后、WebP RIFF 声明之外一律判失败），等价于禁尾部走私。`removed` 明细记进 `record.metadata_removed` |
| **失败即拒** | 解码失败 ⇒ `reject(record, 'decode_failed')` + `MediaError('MEDIA_TYPE_UNSUPPORTED', '图片解码失败，无法去除元数据')`（415）；**不**放行原始字节 |
| **两个对象** | `rawRef`（客户端直传的原件，**含元数据**）与 `derivativeRef`（去元数据件）。读路径只用 `derivativeRef`（`services/api/src/media/service.ts:1218`） |
| **真实桶下的含义** | 清除发生在**服务端内存**：必须先把原件整对象下载回来（≤ 每用途上限，见 §7）；因此需要①下载大小上限②超时③并发限流，否则一个 10MiB 对象 × N 并发即可打满进程内存 |
| **残留风险** | `rawRef` 在保留期内仍是「含 EXIF 的原件对象」。**桶策略必须保证只有服务端角色可读**，且建议 `raw/` 与 `derived/` 分前缀、分生命周期规则（§9 R5） |

## 7 env 变量清单（含格式校验）

**A. 已存在（`services/api/src/media/object-store.ts:197-247` 实读）**

| 变量 | 层 | 必填 | 现有校验 | 建议补的校验 |
| --- | --- | --- | --- | --- |
| `OBJECT_STORAGE_ENDPOINT` | ① | real 必填 | `trim` 非空；`/^https:\/\/[^\s/]+/i`（明文 http 拒绝） | 拒绝 path/query/fragment/凭据；host 白名单（与 `AI_ENDPOINTS` 同口径） |
| `OBJECT_STORAGE_BUCKET` | ① | real 必填 | `trim` 非空 | S3/COS 桶名 `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$` |
| `OBJECT_STORAGE_ACCESS_KEY` | ① | real 必填 | `trim` 非空 | 长度 16..128、字符集 `[A-Za-z0-9_\-]`；**永不回显** |
| `OBJECT_STORAGE_SECRET_KEY` | ① | real 必填 | `trim` 非空 | 长度 ≥32；**永不回显、永不进日志/异常消息** |
| `OBJECT_STORAGE_REGION` | ① | 可选（默认 `ap-shanghai`） | 无 | `^[a-z]{2,}-[a-z]+-\d{1,2}$` |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | ① | 可选（默认 `false`） | 仅 `'true'`（大小写不敏感）为真 | 建议显式枚举 `true`/`false`，其余值报 `INVALID_VALUE` 而非静默当 false |
| `MEDIA_ACCESS_GRANT_ORIGIN` | ② | **接线后实质必填** | `services/api/src/config.ts:235-247` 经 `asHttpsOrigin`：仅 `https://host[:port]`，拒 path/query/凭据；`services/api/src/media/service.ts:559` 同形二次校验 | 未配置时句柄指向 `media.placeholder.invalid`（不可解析）⇒ real 接线必须设为网关域，建议在 real 模式下把它提升为必填 |

**B. 建议新增（接线实现片决定是否落地）**

| 变量 | 层 | 建议默认 | 校验 | 用途 |
| --- | --- | --- | --- | --- |
| `OBJECT_STORAGE_SESSION_TOKEN` | ② | 空 | 非空时长度 ≥16 | CAM/STS 临时密钥的 `X-Amz-Security-Token`（当前**不支持**，见 §5.2 2.1） |
| `MEDIA_UPLOAD_HANDLE_TTL_SECONDS` | ② | 3600 | `100..86400` 整数 | 覆盖 24h 默认上传句柄窗口 |
| `MEDIA_GATEWAY_ENABLED` | ② | `false` | 只认 `true` | 句柄消费网关的就绪开关（缺省关闭，fail-closed） |

**C. 须同步更新的文档/模板（不算代码改动，列在此便于实施片照做）**

| 文件 | 要改什么 |
| --- | --- |
| `.env.example`（现 `:23-27` 只有四个 `OBJECT_STORAGE_*` 与「real 必填」注释） | 补 `OBJECT_STORAGE_REGION`、`OBJECT_STORAGE_FORCE_PATH_STYLE`、`MEDIA_ACCESS_GRANT_ORIGIN` 及其格式说明 |
| `deploy/cloudrun/container.config.json.example` | 同上（云托管侧注入口径） |
| `docs/reference/configuration.md` | 同上（该文件已登记 `OBJECT_STORAGE_*`，需逐项补校验与取值范围） |
| `deploy/cloudrun/service-settings.md` | 补「桶策略只允许服务端角色读 `raw/`」与网关域名配置 |

## 8 测试改造点（含真库 CI 集成）

**A. 必须新增的用例（单测，进程内替身，零网络）**

| 用例 | 位置建议 | 锁什么 |
| --- | --- | --- |
| 配置搬运正/负控制 | `tests/unit/media-object-storage-config.test.mjs` | ①real + 四键齐备 ⇒ `config.objectStorage` 非 null 且装配出 `s3_compatible`；②缺任一键 ⇒ `ConfigError` 且 `issues` 只含字段名；③`app.ts` 装配行**不得**出现 `env: process.env`（静态断言，与 `tests/unit/media-real-mode-fail-closed.test.mjs:329-337` 同形但落在新路径上） |
| 批准铸造点 | `tests/unit/media-real-approval-gate.test.mjs` | ①未铸造 ⇒ 503（现状）；②铸造后 + `s3_compatible` ⇒ 201；③铸造后但端口仍 `unwired` ⇒ 仍 503（双层门） |
| 签名临时密钥 | `tests/unit/media-object-store-s3-paths.test.mjs`（扩现有 599 行文件） | 有 `sessionToken` 时查询串含 `X-Amz-Security-Token`、无则不含；两分支签名各自独立复算命中（沿用该文件已有的独立 `independentSigV4()`） |
| 删除链跨重启 | `tests/unit/media-delete-pending-refs.test.mjs` | `deleteObject` 返回 `false` 后：记录进 `pending`、引用**未清**、重建服务（模拟重启）后 `cleanupOrphans` 仍能重试 |

**B. 真库集成（这是本次唯一需要真 PG 的部分）**

| 项 | 内容 |
| --- | --- |
| 新脚本 | `tests/integration/media-pg.mjs`（形状照抄 `tests/integration/speech-pg.mjs`/`community-pg.mjs`：开头断言 public 下无表、库名硬钉、缺前置以 `77` 退出而不是「跳过」） |
| 脚本必须证明的性质（内存库证明不了的） | ①迁移 `0027` 按序 apply 且**二连跑 0 条**；②`media_records.revision` CAS 只由一条原子 UPDATE 推进（并发两写恰一成功）；③`media_idempotency UNIQUE(scope,key_hash)` 真的裁决并发占位；④`media_pending_object_refs` 唯一键挡住重复登记、删除后行消失；⑤枚举/CHECK 拒绝闭集外的 `purpose`/`state`；⑥重建 `buildApp`（带真库 pool）后 `getMedia` 仍返回同一 `revision`/`ownerId` |
| CI 接入 | 已有真库臂 `.github/workflows/real-pg-integration.yml`（`runs-on: ubuntu-24.04`、`postgres:17.11`、每脚本先用 `psql` 建**专用空库**再 `&&` 串联跑）。接线方式：追加一个 step（`CREATE DATABASE gengyun_media_test && node tests/integration/media-pg.mjs` + 五条 `PG*` env），**不新增 workflow 文件** |
| 会被既有守卫拦住的点 | `tests/unit/ci-real-pg-wiring.test.mjs`（87 KB）对 workflow 里出现「放宽/跳过开关」一律判红；`tests/unit/integration-script-coverage.test.mjs`（21 KB）要求「整链跳过必须给 77」⇒ 新脚本**必须**有 77 分支且 CI 不得传跳过参数 |

**C. 既有断言不得削弱（实施片必须逐条保住）**

| 断言 | 位置 | 为什么不能动 |
| --- | --- | --- |
| real + 未接真实存储 ⇒ 整域 503 | `tests/unit/media-real-mode-fail-closed.test.mjs:102-137` | 这是 fail-closed 的主证据 |
| 端口级 fail-closed（非 real 注入 unwired 也 503） | 同上 `:153-169` | 证明门在端口上，不只在模式开关上 |
| 缺任一 `OBJECT_STORAGE_*` ⇒ 仍 `unwired`、reason 逐字不变 | 同上 `:279-410` | 防止「重新引入配置即门控」 |
| `app.ts` 不得把 `process.env` 交给 resolver | 同上 `:519-541`（原记 :329-337） | PR #193 P1 的静态钉子 |
| `app.ts` 全文件 ambient env 审计：只允许 3 个非媒体键 | 同上 `:1121`（原记 :1050；另有 `:1298` 原记 :1227 的运行期来源检查） | 实施片新增任何装配读取都不得突破这条白名单 |
| 构造期拒绝（空桶 / http endpoint） | 同上 `:249-254` | 真实适配器不静默降级 |

## 9 风险清单

| # | 风险 | 具体机制 | 缓解 |
| --- | --- | --- | --- |
| R1 | **对象存储供应商未定** | 用户/指挥尚未选型（腾讯云 COS / S3 / 自建 MinIO）。适配器能力面只有「SigV4 + `UNSIGNED-PAYLOAD` + 单次 PUT/GET/DELETE + 预签名」，**不支持** multipart、不支持 list（`objectCount` 恒抛 `PROVIDER_UNAVAILABLE`，`services/api/src/media/object-store.ts:388-390`）、不支持临时密钥 | 方案保持 provider-agnostic；选型硬约束：单对象 ≤ 每用途上限（`packages/media/constants.mjs:61-66`：识别/OCR 2 MiB、语音 10 MiB、社区图 5 MiB）+ 支持预签名 PUT/GET/DELETE |
| R2 | **密钥管理** | 长期 AK/SK 一旦进 `AppConfig` 就随 config 对象在整个进程生命周期可达；`readObjectStorageConfig` 已做到不回显（`services/api/src/media/object-store.ts:196`），但 `AppConfig` 会被 `buildApp` 整个握住，任何日志/序列化都可能带出去 | ①`objectStorage` 字段在 `toJSON`/日志里显式脱敏；②禁止把 `AppConfig` 整体打日志（既有实践已如此）；③若供应商支持，改用 CAM 子账号最小权限（仅 `PutObject`/`GetObject`/`DeleteObject`，**不给** list，与 `objectCount` 的「未接线」口径一致）；④临时密钥方案需先补 §5.2 2.1 |
| R3 | **删除链** | ①`dropObjects` 未确认删除时保留引用，但引用只在内存 ⇒ 重启丢依据；②`expireInitiated`/`cleanupOrphans` 无调度器 ⇒ 24h 过期对象永久留在桶里计费；③应用侧删除与桶生命周期规则若各自为政，会出现「台账说删了、桶里还在」 | ①引用持久化（§5.3 的 `media_pending_object_refs`）；②清理器必须有驱动方（定时器或 cron 打内部端点）；③**桶侧生命周期规则不得替代应用侧删除证据**，删除证据只认本仓台账 |
| R4 | **句柄消费网关变成绕过口** | 若为图省事让 CDN 直读原桶，则①owner 鉴权被绕过②可能读到 `rawRef`（含 EXIF） | 红线：网关必须校验 token + 归属 + 版本，只回 `derivativeRef`；桶策略禁止公网直读 |
| R5 | **服务端内存放大** | EXIF 清除要求整对象下载（§6）。10 MiB × 并发 × 2（raw+derivative） | 下载前校验 `Content-Length` ≤ 每用途上限；单实例并发闸（如 ≤4）；超时用 `AbortSignal.timeout` |
| R6 | **批准门被误读成接线失败** | 即便 §5.1 配置搬运做完，real 仍 503（门 2 未解决）⇒ 极易被误判为「接错了」 | §10 D2 必须先裁定；实施片的验收口径写成「两侧同时满足才 201」 |
| R7 | **契约缺口被说成已实现** | owner 私有字节读无 operation；`grantMediaAccess` 只交付 URL | 措辞纪律：只能说「句柄签发符合契约」，不能说「私有媒体访问已实现」；`contract-status.json` 的 `partial` 状态在网关验收前不得改 |
| R8 | **stub 证据被当作真实能力** | `substitute.invalid` 域与内存元数据在 stub 下完全可用 | 沿用既有口径：stub/preset_demo 的 201 只证明「链路形状对」，不证明真实存储可用 |

## 10 关键决策点（需指挥/用户裁定）

| # | 决策 | 选项 | 建议 |
| --- | --- | --- | --- |
| D1 | **配置从哪进装配层** | (a) `app.ts` 传 `process.env`（**禁止**，命中 PR #193 P1）；(b) `config.ts` 产出结构化 `objectStorage` 字段，`app.ts` 显式传派生 env；(c) 让 `resolveMediaObjectStore` 自己读 env（**禁止**，同上测试有 AST 断言） | **(b)**：唯一同时满足「配置即门控」禁令与「媒体域不读 env」约束的形状 |
| D2 | **`realMediaApproval` 由谁铸造** | (a) 保持现状 ⇒ 永不放行，方案等于无效；(b) 由 `config.ts` 凭一个 env（如 `MEDIA_REAL_WIRING_APPROVED=true`）在装配层铸造 ⇒ 与「配置即门控」冲突；(c) 由**生产入口**（`services/api/src/server.ts`）在显式运维动作下铸造（启动参数或一次性令牌与代码内常量比对），并保留 `s3_compatible` 第二道校验 | **(c)**：门由「显式运维动作」打开，而不是「环境里恰好有值」；铸造点唯一、可审计（reason + approvedAt 已由 `approveRealMediaWiring` 记录，`services/api/src/media/service.ts:473`） |
| D3 | **句柄消费网关归属** | (a) 仓内最小参考实现（`deploy/media-gateway/`）；(b) 纯部署件，仓内只留契约文档；(c) 推迟到有真实网关域名后再做 | 建议 **(b) + 立即写契约**：本仓没有该 operation，仓内实现会制造「契约外接口」；但契约（token 头、归属校验、只回 derivative、no-store）必须现在定死，否则实现方各写一套 |
| D4 | **供应商与临时密钥** | (a) 长期 AK/SK，不改签名代码；(b) 临时密钥，先扩 `presignS3Url`（`services/api/src/media/object-store.ts:283`） | 建议先 **(a)** 打通端到端（改动最小、可快速验证「桶策略 + 预签名 + 去 EXIF + 删除链」），再按需演进到 (b) |

## 11 工作量估算（人日）

假设：已有适配器与 7 条路由不动；工作量含自测与证据文档，不含真实桶采购/开通、不含社区线（GY-I14/I15）内容来源端口。

| 工作项 | 人日 | 说明 |
| --- | --- | --- |
| ① 配置搬运 + 装配点（D1） | 1.0 | `config.ts` 结构化字段、`app.ts` 装配行、错误折进 `ConfigError`、补模板与 `docs/reference/configuration.md` |
| ② 批准铸造点（D2） | 0.5 | 唯一铸造点 + 审计字段 + 双层门用例 |
| ③ 元数据持久化：端口抽取 + 内存实现回填 | 2.0 | `services/api/src/media/store.ts` + `service.ts` 的四个容器（原记 `:624-629`；该符号在 `1d65b7ee` 已不存在——`git grep -n "new Map<" 1d65b7ee -- services/api/src/media/service.ts` ⇒ 0 命中，最后见于 `1fbe7572:624-629`）换写入目标；语义逐条对齐 |
| ④ 元数据持久化：PG 实现 + 迁移 `0027` | 3.0 | 四张表 + CAS + 幂等唯一键 + 事务/错误折叠 + 三态就绪 |
| ⑤ 装配与有/无 pool 双轨 | 0.5 | 与 `community/store-pg.ts` 同口径 |
| ⑥ 清理器驱动（过期/孤儿/pending 重试） | 1.0 | `expireInitiated`/`cleanupOrphans` 的生产调用者 |
| ⑦ 签名层增强（D4 取决于选项） | 0.5–1.5 | 临时密钥支持 1.0；仅端点白名单 + 桶名/密钥格式校验 0.5 |
| ⑧ 句柄消费网关契约 + 参考实现（D3） | 0–3.0 | 选 (b) 只写契约 0.5；选 (a) 另加 2.5 |
| ⑨ 单测（A 组四组用例 + 既有断言保绿） | 2.0 | 含静态装配断言 |
| ⑩ 真库集成 `tests/integration/media-pg.mjs` + CI step | 2.0 | 脚本 1.5 + workflow 追加 0.5 |
| ⑪ 证据文档 + 台账（`contract-status.json` 逐条 blocker 更新） | 1.0 | 不含任何验收结论 |
| **合计** | **13.5–17.0** | 建议按 **15 人日**排期（含 10% 缓冲），关键路径 ①→③→④→⑥ |

**关键路径说明**：① 可独立先行（零风险、可单独 PR）；③④ 必须在真实外呼上线之前完成（否则违反「未确认删除不得丢重试依据」）；②⑤ 可与 ③④ 并行；⑧ 不阻塞主链路（句柄签发不依赖网关，只是「签出来没人消费」）。

## 12 未取得项（如实）

| 项 | 状态 |
| --- | --- |
| 真实对象存储桶 / 真实凭据 / 真实签名往返 | **未取得**。本片零网络、零凭据、零外呼 |
| 供应商选型 | **未定**（D4 / R1，待用户或指挥裁定） |
| 句柄消费网关实现 | **仓内不存在**，且冻结契约内无对应 operation |
| 真实 EXIF 清除效果（真实相机原图） | **未取得**。既有证据只覆盖合成字节 |
| 迁移 `0027` 是否与既有迁移二连跑 0 条 | **未验证**（迁移尚不存在） |
| 生产入口的批准铸造点 | **未取得**（本片只给三个选项，未实施） |

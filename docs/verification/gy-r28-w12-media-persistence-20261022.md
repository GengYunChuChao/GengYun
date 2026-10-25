# W12 · 媒体持久化：PG 仓储 + `object_ref_cipher` 键接线 + 幂等落库（2026-10-22）

分支 `feat/gy-r28-w12-media-persistence`（Refs #6 #16）。本片**不新增迁移号**：`0027` 保持空闲，
`services/api/db/migrations` 仍是 26 个迁移（真库读数见 §5 `[1] schema_migrations 行数=26`）。

## 1. 结论摘要

- 媒体四表早在 `0001_initial_schema.sql` 里就存在（`media` :171、`media_derivatives` :192、
  `content_media_refs` :294、`community_media_grants` :306），媒体域幂等台账复用 `0008` 的
  `public.idempotency_keys`。**真正缺的从来不是建表，而是 PG 仓储、`object_ref_cipher` 的键接线、
  幂等落库、以及 `app.ts` 的装配**。
- 新增 `services/api/src/media/store.ts`（端口 + 内存实现）与 `store-pg.ts`（PG 实现），
  新增 `services/api/src/media/object-ref-cipher.ts`（AES-256-GCM 信封）。
- `services/api/src/media/service.ts` 里四个进程内状态（`records`/`grants`/`idempotency` 三个 `Map`
  与 `inflight` 一个 `Set`）已删除，全部改由 `MediaStore` 承载；`serverObjectKeys` 因此变成异步
  （重启后的新进程只能从真库读键）。
- 真库复验：三段式上传在**新进程**里仍可用，owner 私有读与桶内衍生件逐字节相等（36 B），
  非 owner `NOT_FOUND`，同幂等键重复 complete **新增 0 行**，缺键时整域 fail-closed（HTTP 503）。

## 2. 事实 vs 派单

| 派单说法 | 事实 | 证据 |
| --- | --- | --- |
| `media` / `media_derivatives` 在 `0001_initial_schema.sql` 约 :171 / :192 | 成立 | `services/api/db/migrations/0001_initial_schema.sql:171`、`:192` |
| `content_media_refs` / `community_media_grants` 在 `0022_community_persistence.sql` | **不成立，两者都在 `0001`**；`0022` 建的是 `community_posts`/`comments`/`likes`/`reports`/`moderation_decisions`/`community_idempotency` | `0001_initial_schema.sql:294`、`:306`；`0022_community_persistence.sql` 全文无这两张表 |
| 「幂等表没落」是本片缺口 | **不成立（不需要新表）**：`0008` 的 `public.idempotency_keys` 就是通用台账，`0019` 已按同一口径给 messages 复用 | `0008_auth_session.sql:46-58`；`0019_messages_persistence.sql:28-29`；`services/api/src/messages/store-pg.ts:349-426` |
| 台账在 `docs/verification/contract-status.json` | **不成立**：真实路径是 `docs/architecture/contract-status.json`（`docs/verification/` 下不存在该文件） | `tools/verify-contract-status.mjs` 的 `STATUS_FILE` |
| `readObjectStorageConfig` 只有六项、无 session token | 成立，未改动 | `services/api/src/media/object-store.ts:209-243` |
| 0027 空闲、能不占就不占 | 成立，本片未占用 | 见 §5 `[1]` |

## 3. 第一步：事实表

### 3.1 `services/api/src/media/**` 的进程内状态盘点

| 位置 | 状态 | 判定 | 处置 |
| --- | --- | --- | --- |
| `media/service.ts`（改前）`:624` `records: Map<string, MediaRecord>` | 媒体行 | **持久化事实的来源**（行没了 = 上传链路断） | 删除，改 `MediaStore.createMedia/saveMedia/getMedia` |
| `media/service.ts`（改前）`:625` `grants: Map<string, CommunityGrantRecord>` | 社区取图授权行 | **持久化事实的来源**（`community_media_grants` 有真实表） | 删除，改 `createGrant/getGrant/revokeGrantsForMedia/listStaleGrants/deleteGrant` |
| `media/service.ts`（改前）`:627` `idempotency: Map<string, {requestHash, mediaId}>` | 幂等台账 | **持久化事实的来源**（重启后重放会重复派生/重复计费） | 删除，改 `findIdempotency/claimIdempotency/settleIdempotency/releaseIdempotency` |
| `media/service.ts`（改前）`:629` `inflight: Set<string>` | 同键并发占位 | 短期互斥（可丢弃，但不能凭空消失——并发会双写） | 并入台账：`outcome IS NULL` / 内存版 `mediaId === null` 即「占位中」 |
| `media/object-store.ts:91` `objects: Map<string, StoredObject>` | 替身桶对象 | 可丢弃的短期缓存（真桶在 S3 兼容存储里，`kind: 's3_compatible'`） | 不动：`createSubstituteObjectStore` 只用于 stub / 单测 |
| `media/content-source.ts:69` `snapshots: Map<string, PublishedContentSnapshot>` | 已发布内容快照 | 可丢弃的短期缓存（来源是社区内容域） | 不动：`createClosedContentSource` 是生产默认（一律 null ⇒ 404） |

### 3.2 四表真实列（逐列抄，未凭字段名猜）

- `media`（`0001_initial_schema.sql:171-190`）：`id` uuid PK、`owner_id` uuid NOT NULL →`users(id)`、
  `purpose` `media_purpose` NOT NULL、`mime` varchar(120)、`bytes` bigint CHECK(>0)、`duration_ms`
  integer CHECK(>0 AND <=60000)、`sha256` char(64)、`state` `media_state` DEFAULT `'initiated'`、
  `failure_code` varchar(80)、**`object_ref_cipher` text NOT NULL**、`revision` integer DEFAULT 1、
  `consent_epoch` bigint DEFAULT 0、`expires_at` timestamptz、`created_at`/`updated_at`。
  约束 `media_voice_has_duration`；索引 `media_owner_created_idx (owner_id, created_at, id)`。
  **没有幂等键列，也没有 `metadata_removed` 列**。
- `media_derivatives`（`:192-200`）：`id`、`media_id` →`media(id)` ON DELETE CASCADE、
  `derivative_kind` varchar(40)、**`object_ref_cipher` text NOT NULL**、`hash` char(64)、`state`。
  唯一键 `(media_id, derivative_kind, hash)`。
- `content_media_refs`（`:294-303`）：`target_type`、`target_id`、`content_revision`、`media_id`、
  `media_revision`、`purpose_epoch`、`created_at`；唯一键 `(target_type,target_id,content_revision,media_id)`。
- `community_media_grants`（`:306-330`）：`id`、`requester_id`、`session_ref`、`requester_auth_epoch`、
  `content_type`/`content_id`/`content_revision`、`slot` `media_slot`、`media_id`、`media_revision`、
  `author_ref`、`author_revision`、`parent_post_id`、`parent_revision`、`public_posting_epoch`、
  `content_owner_epoch`、**`token_hash` bytea NOT NULL**、`expires_at`、`revoked_at`、`created_at`；
  `community_media_grants_ttl CHECK (expires_at <= created_at + interval '300 seconds')`。
  枚举 `media_state` = `('initiated','uploaded','processing','ready','rejected','deleting','deleted')`（`:23`）。

### 3.3 「重启后上传链路断在哪一步」

改前断在**三处，且都不在 HTTP 层**（HTTP 层 `#408` 已通）：

1. `media` 行只写进 `service.ts:624` 的 `records` Map —— 进程退出即消失，`complete` 之后新进程
   `getMedia` 一律 `NOT_FOUND`。
2. `object_ref_cipher` 从未被任何代码写过：`AppConfig` 没有键字段，`service.ts` 也没有加解密调用
   （改前全仓 grep `object_ref_cipher` 只命中迁移文件）。即「真库里有列、代码里没有接线」。
3. 幂等台账是 `service.ts:627` 的 Map —— 重启后同键重放会重新走一遍 complete（重新 `putObject`、
   重新插衍生物行）。

### 3.4 照抄的既有范式（未发明新架构）

- 端口 + 两个实现 + `persistent` 布尔门禁：`services/api/src/messages/store.ts:118-172`、
  `store-pg.ts:47-124`（`SqlRunner` 最小形状 `query(text, values?)`、`classify*DatabaseError`、单语句原子）。
- `app.ts` 按 `executionMode` 二分注入：`services/api/src/app.ts` 的 favorites/history 段
  （`injection?.store ?? (config.executionMode === 'real' && pool !== null ? createPostgresXStore(...) : createMemoryXStore(...))`）。
- 幂等台账复用 `0008`：`0019_messages_persistence.sql:28-29` 的注释即同一口径；scope 形状见
  `services/api/src/auth/idempotency.ts:111-118`（`<主体>\n<方法>\n<路由模板>` + `sha256Hex(scope\nkey)`）。

## 4. 实现清单

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `services/api/src/media/store.ts`（新增，274 行） | 导出 `MediaRecord`:33 / `CommunityGrantRecord`:52 / `MediaIdempotencyEntry`:71 / `MEDIA_IDEMPOTENCY_TTL_MS`:77 / `MEDIA_IDEMPOTENCY_CLAIM_TTL_MS`:83 / `MediaStore`:86（17 个成员）/ `mediaIdempotencyScope`:132 / `mediaIdempotencyKeyHash`:137 / `MEDIA_IDEMPOTENCY_PATHS`:146 / `createMemoryMediaStore`:166（`persistent: false`:183） | 把「事实来源」抽成端口，服务层不再自持状态；内存实现只剩 stub / 单测用途 |
| `services/api/src/media/store-pg.ts`（新增，404 行） | `MediaSqlRunner`:49 / `PostgresMediaStoreOptions`:53 / `MEDIA_DERIVATIVE_KIND_METADATA_STRIPPED`:60 / `classifyMediaDatabaseError`:87（57014/55P03 ⇒ `PROVIDER_TIMEOUT`，其余 ⇒ `PROVIDER_UNAVAILABLE`）/ `createPostgresMediaStore`:149（`persistent: true`:190） | 真库实现：`media` 全列读写、`media_derivatives` 按 `(media_id, kind, hash)` upsert / 键位清空时 DELETE、`community_media_grants` 行、台账 SQL 抄 `messages/store-pg.ts:351-409` |
| `services/api/src/media/object-ref-cipher.ts`（新增，~200 行） | AES-256-GCM；信封 `v1.<iv>.<tag>.<ct>`（`ENVELOPE_VERSION`:36）；`OBJECT_REF_AAD = 'gengyun/media/object-ref/v1'`:44；`MEDIA_OBJECT_REF_KEY_FIELD`:47；`ObjectRefCipher`:50；`MediaObjectRefKeyError`:60；`MediaObjectRefCipherError`:68；`parseObjectRefKeyMaterial`:84（64 hex / 32 字节 base64 / 32 字节原串）；`createObjectRefCipher`:108 | `object_ref_cipher` 列 NOT NULL 且要能「表示没有键」：明文 `''` 加密后存库，解出 `''` 即 null。认证失败（换键/篡改）**抛错而不是返回 null**，杜绝静默降级 |
| `services/api/src/media/service.ts` | 删除 `records`/`grants`/`idempotency`/`inflight`；`AppMediaServiceOptions.persistence?: MediaStore`:285；`const store = options.persistence ?? createMemoryMediaStore(...)`:629；`openIdempotentRequest`/`replayOrConflict`/`IdempotencySlot` 取代 `withKeyClaim`；`initiateUpload`:837-907、`completeUpload`:909-995、`getMedia`:1012-1015、`deleteMedia`:1017-1056、`grantMediaAccess`:1060-1091、`grantCommunityMediaAccess`:1095-1213、`readCommunityMediaContent`:1215-1261 全部改 `await store.*`；`serverObjectKeys` 改 async；`readOwnerMediaContent` 改 `await media.serverObjectKeys(...)` | 「进程内 Map 仍是事实源、PG 只做旁路」是本片明令禁止的假持久化；台账改成 `find → claim → 工作 → settle/release` 后，跨进程并发也只有一个赢家 |
| `services/api/src/app.ts` | import :102/:105/:106；`BuildAppOptions.mediaStore?`:397；解构 `mediaStore: mediaStoreOption`:663；装配 `const mediaStore: MediaStore = ...`:1291-1294；`mediaPersistenceRefusal`:1298-1301；`const mediaService: AppMediaService = mediaPersistenceRefusal === null ? createAppMediaService({...}) : createFailClosedMediaService(mediaPersistenceRefusal)`:1302-1318（`persistence: mediaStore`:1315） | 照 favorites 同范式二分；缺键时整域 fail-closed。**没有**新增 `resolveMediaObjectStore` 调用（仍 1 处、实参仍只有 `executionMode`），`createAppMediaService({` 全文件仍恰好 1 处 |
| `services/api/src/config.ts` | `import { createObjectRefCipher }`:11；`AppConfig.mediaObjectRefKey`（`string` 或 `null`）:62；`loadConfig` 校验块 :307-320；返回字面量 `mediaObjectRefKey`:342 | 键只从配置注入（媒体域**禁止**读 ambient env，见 `tests/unit/media-real-mode-fail-closed.test.mjs` 的静态审计）；非法键在启动期就报 `INVALID_VALUE`，不进 `REQUIRED_WHEN_REAL`（缺键由装配层 fail-closed，不误伤既有 real 夹具） |
| `docs/architecture/contract-status.json` + `contract-implementation-status.md` | 8 条锚点机械刷新（`accountDeletionWired`@app.ts 1810-1818；`initiateUpload` 837-907；`completeUpload` 909-995；`getMedia` 1012-1015；`deleteMedia` 1017-1056；`grantMediaAccess` 1060-1091；`grantCommunityMediaAccess` 1095-1213；`readCommunityMediaContent` 1215-1261）；三个 `*Unclaimed` 符号随函数合并改名 | 只改 `lines`/符号名，`status`/`blocker`/用例引用一字未改 |
| `tests/unit/media-object-ref-cipher.test.mjs`（新增） | 9 个子用例 | 往返、随机 IV、三种键表示、缺键/非法键 fail-closed、换键与篡改必抛、`encrypt('')⇒null` |
| `tests/unit/media-persistence-store.test.mjs`（新增） | 2 个顶层 test | 三段式 + owner/非 owner + 同键回放（put 计数不变）+ 异 body 409 + **换实例后同 `uploadId` 仍可读**；内存 store 的 claim/settle/release 语义 |
| `tests/integration/media-persistence-pg.mjs`（新增） | 8 段、17 条读数 | 真库复验（§5），含子进程真重启、迁移自举与两条负控制 |
| `.github/workflows/real-pg-integration.yml` + `package.json` | 新增一步「媒体持久化」（`CREATE DATABASE gengyun_media_test && node tests/integration/media-persistence-pg.mjs <url>`）与脚本入口 `test:integration:media-persistence-pg` | 与既有 11 个域级 PG 脚本同形；本片证据进 CI，而不是只活在本机日志里 |
| 7 个既有单测 | 仅把 `service.serverObjectKeys(...)` 调用点加 `await`（`media-real-ports-wiring`、`media-http-upload`、`media-http-access`、`media-grant-url-origin`、`media-grant-origin-assembly`、`gy-i22-cache-headers`、`gy-i22-secmatrix`） | 端口变异步是事实（新进程只能读库）；断言一条未改 |
| `tests/unit/media-attachment-limit.test.mjs` | 结构闸门的锚点跟随签名改成 `async function attachmentLimitFor(...): Promise<number> {` | 函数转异步后旧锚点消失；**判据 1)~4) 一条未改** |

## 5. 真库读数（临时 PG :55683，`initdb` 新建集群 + `Invoke-CimMethod Win32_Process Create` 起 `postgres.exe`）

脚本**自带迁移自举**：库里没有 `public.media` 时自己 `applyMigrations(discoverMigrations())`
（`services/api/src/db/migrate.ts:131`，与 `npm run db:migrate` 同一条代码路径）⇒ CI 里
`psql -c 'CREATE DATABASE …' && node tests/integration/media-persistence-pg.mjs <url>` 一步到位，
已在 `.github/workflows/real-pg-integration.yml` 加同名步骤，本地入口 `npm run test:integration:media-persistence-pg`。

```
$ createdb gengyun_media_test        # 全新空库
$ node --experimental-strip-types tests/integration/media-persistence-pg.mjs \
    'postgres://gengyun@127.0.0.1:55683/gengyun_media_test'          → 17 条读数，全部断言通过，exit 0
[1] 迁移自举：空库，applyMigrations 套用了 26 个迁移
[1] 表：community_media_grants(20) content_media_refs(7) idempotency_keys(8) media(15) media_derivatives(6)；
    media.object_ref_cipher=text/NOT NULL
[1] schema_migrations 行数=26；迁移文件 26 个（最大号 0026_speech_persistence.sql；本片不新增迁移号）
[0] 合成 jpeg=77B（含 EXIF+GPS 的夹具）
[2] initiate：HTTP 201；media 行已落库 state=initiated revision=1；
    object_ref_cipher 长度=81（密文，解密回桶键一致）
[2] complete：HTTP 202；media state=ready revision=2；
    media_derivatives=1 行 kind=metadata_stripped hash=c8007caa7bc8…
[2] rawRef=obj_Xg__KndqBH6IkH… derivativeRef=obj_bmiqCTqRcnOuW0…（两个不同对象键）
[3] 同键重复 complete：202 回放；行数 {"media":1,"derivatives":1,"ledger":2} → 同样（新增 0）
[3] 异请求同键：IDEMPOTENCY_CONFLICT / 同一 Idempotency-Key 已被不同的完成请求使用
[4] owner 读：source=derivative contentType=image/jpeg bytes=36（与衍生件逐字节相等）
[4] 非 owner 读：NOT_FOUND / 媒体不存在
[5] 真重启（子进程 pid=13812）：同一 uploadId 仍可读，state=ready revision=2，键逐字相等
[6] 缺键 fail-closed：HTTP 503 PROVIDER_UNAVAILABLE / 「real 模式的媒体持久化缺少 MEDIA_OBJECT_REF_KEY：
    object_ref_cipher 无法加密，拒绝以进程内状态承载媒体事实（fail-closed）」；
    failClosedReason = 同文（不含「（fail-closed）」后缀）
[6] 同一缺键实例的上传面：HTTP 403 CONSENT_REQUIRED（consent 前置闸门先拦，非降级）
[7] 有键正向对照：real 装配 GET /media/{id} → HTTP 200 state=ready revision=2；
    该行只在库里（库内 media 共 1 行，object_ref_cipher=v1.BGGu2oELQ…）
[8] 负控制（空端口）：getMedia → NOT_FOUND / 媒体不存在
[8] 负控制结论：同一 uploadId 在空端口下读不到 ⇒ 上面的 200/逐字节相等确实来自真库
```

重复跑的稳定性：在**已迁移过**的库上重跑同一脚本同样 exit 0（`[1]` 不再打印自举行，行数读数随
上一次运行累积，例如 `{"media":6,"derivatives":6,"ledger":12}`；脚本只断言「本次前后增量」）。

`[5]` 的「真重启」是**新进程**（`spawnSync` 起子进程，只带 `DATABASE_URL` + `MEDIA_OBJECT_REF_KEY`，
不共享任何内存），因此它证明的是「键与行来自真库」而不是同一进程内缓存。

## 6. 负控制与报错文本（都真跑过）

1. **缺 `MEDIA_OBJECT_REF_KEY`**（real 装配 + 真库池 + 注入真实 S3 端口夹具）：
   `GET /api/v1/media/{id}` ⇒ **503**，`error.code = PROVIDER_UNAVAILABLE`，
   `app.mediaService.failClosedReason = 'real 模式的媒体持久化缺少 MEDIA_OBJECT_REF_KEY：object_ref_cipher 无法加密，拒绝以进程内状态承载媒体事实'`。
   ⇒ 没有明文落库，也没有静默退回内存 Map。
2. **把仓储换成空实现**（17 个成员全空实现的内联 `MediaStore`）：`getMedia` ⇒ `NOT_FOUND / 媒体不存在`，
   同一 `uploadId` 读不到 ⇒ 反证上面的 200 与逐字节相等来自真库。
3. **换键/篡改密文**（`media-object-ref-cipher.test.mjs`）：
   `MediaObjectRefCipherError: 对象引用密文认证失败（键不匹配或密文被篡改）`；非法键材料
   抛 `MediaObjectRefKeyError`（如 `…形状非法…实测 16 字节`）。
4. **异请求同幂等键**：`IDEMPOTENCY_CONFLICT / 同一 Idempotency-Key 已被不同的完成请求使用`。

## 7. 未取得项 / TODO

- 对象桶是 `createSubstituteObjectStore()` 替身（零外呼、不碰任何真实供应商）。**未取得**真实 S3/COS
  端到端证据；`createPostgresMediaStore` 与真桶的组合只做过类型与装配级核对。
- `mediaService.stats().objectCount` 在真实适配器下不可用（需 list 权限，`service.ts:1316` 显式抛
  「真实适配器不提供对象计数」）⇒ §5 `[7]` 用 HTTP 200 + 库内行数代替对象计数证据。
- `community_media_grants` 的 `public_posting_epoch` / 公开作者 id 在
  `PublishedContentSnapshot`（`media/content-source.ts:26-38`）里没有对应字段，仓储按 0/可空落库；
  真正的社区取图端到端仍被 `createClosedContentSource()`（生产默认一律 null ⇒ 404）挡住，属后续片。
- `docs/verification/gy-r28-w2-media-ports-20261021.md:35`、`:66`、`:98` 仍引用 `service.ts:465`/`:595`/
  `:1306`/`:1329`，其中「既有行号零位移」一句因本片改服务层已不成立。**未修改**该历史证据文档，
  留给文档片处理（本片只机械刷新台账 `docs/architecture/contract-status.json` 的 `lines`）。
- 本片在合流后用 `node --test --test-concurrency=1`（串行，不是 `npm run test:unit` 的默认并发）跑过全量，
  读数见 §8.4。
- 「生产最小权限角色下媒体持久化可用」**已取得**（第三次推送补的，见 §11）：`20-login-roles.sql` 新增段 M
  （`media` 列级 14/14/12、`media_derivatives` 6/5/2 + 表级 DELETE），`90-assert-least-privilege.sql` 三处同步，
  运行时角色 `gengyun_api_runtime` 下 9 条正向语句全过、6 条越界探针全 42501。
  §5 的集成臂仍以**库 owner** 连接（脚本自带 `DATABASE_URL`），两者互补：集成臂证明业务语义，
  §11 证明最小权限面。唯一剩下的 FAIL 是既有 `runtime_ledger_readiness_biconditional`（egress ledger 从未部署，与本片无关）。
- **未取得** ASR/OCR/识别/TTS 四条链的媒体端口证据：本片只接通媒体域自己的仓储（§9），
  这四个按域端口仍是 `createUnwiredMediaPort()`，`real` 下 `OBJECT_UNAVAILABLE`（ASR 表现为 409）。
- `MEDIA_OBJECT_REF_KEY` 需在部署模板补**真实值**：本片只补了 `deploy/cloudrun/env.placeholder.json` 的空占位 `""`
  （门禁「环境变量模板覆盖配置面」要求模板键 ⊇ 配置面键，现为 18 ⊇ 18）。真值属密钥管理，**未取得**。
  处方一行：在部署模板/密钥管理里给 `gengyun-api` 注入 32 字节随机值（64 位 hex 或 32 字节 base64/原串，经
  `createObjectRefCipher` 校验）；缺键时 real + 有库池的媒体域会整体 503 fail-closed（§5 `[6]` 实测）。
- `deploy/postgres-cvm/**` 本片**按指挥第二轮指令动过**（段 M 授权 + `90-assert` 三处同步，见 §11），
  其余面（`provision-db.sh` / 密码模板 / 备份脚本）只读未改。

## 8. CI 门禁登记、合流与根因（第二次推送补齐）

首轮 CI 里 17 个 job 全绿、只有 `unit-tests` 红；红的原因全部是**既有门禁账本没登记新文件**，不是实现缺陷。
按门禁登记的格式补齐（一条判据都没改，也没删任何声明）：

| 门禁文件 | 登记内容 | 单跑读数 |
| --- | --- | --- |
| `tests/unit/ci-integration-chain-structure.test.mjs` | `UNWIRED_DECLARATIONS` 加 `media-persistence-pg.mjs`（理由：硬钉库名 `gengyun_media_test`、自举 26 迁移，不能进无 PG 的回环链） | tests 7 / pass 7 |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `MANAGED_SCRIPTS` + `FROZEN_MANAGED_SCRIPTS` + `REQUIRED_STEP_ORDER` 三处同插（第 12 条），后续条目重编号 | tests 18 / pass 18 |
| `tests/unit/sql-column-coverage.test.mjs` | `UNAUDITED_SQL_HOSTS` 加 `services/api/src/media/store-pg.ts`（走登记桶，理由见下） | tests 16 / pass 16 |
| `tests/unit/release-materials-index*.test.mjs` | 索引页登记本文件与集成脚本 | 见 §8.3 |
| `deploy/cloudrun/env.placeholder.json` | 补 `"MEDIA_OBJECT_REF_KEY": ""`（发布门禁：「PASS 模板 18 键 ⊇ 配置面 18 键」） | — |

**SQL 宿主为什么走「登记」而不是「真审计」**：把 `media/store-pg.ts` 临时加进 `ADDITIONAL_SQL_HOST_FILES`
（= 走真审计）实测立刻红 5 项，其中两条原文是
`AssertionError: 审计文件数必须是 16（8 store + 8 新纳管）` 与
`AssertionError: 除 email 外不许有别的红字：services/api/src/media/store-pg.ts:196 → public.media.id 缺 INSERT（INSERT 列清单）；授权面现状：该表该权限未授任何列`
（`owner_id`/`purpose`/`mime`/`bytes`/`sha256`/`state`/`failure_code`/`object_ref_cipher`/`revision`/`expires_at`
同形）。根因：`deploy/postgres-cvm/sql/20-login-roles.sql` 里**对媒体四表本来就没有任何一条 GRANT**
（`grep "ON public.media"` 零命中），所以列审计必然全红；真审计的前置条件是部署片先补列级授权。
本片按 W3 先例登记（`services/api/src/ai/checked-content-live-adapter.ts` 同样在 `UNAUDITED_SQL_HOSTS`），
**没有**使用豁免桶（`COVERAGE_EXEMPT`）——扩账本还是改豁免，留给指挥定。

**`/health` 三条红的根因（不是「本地过了」）**：既有测试用字面量配置 `{ ...baseConfig(), executionMode: 'real' }`
加注入 `pool`，新字段 `mediaObjectRefKey` 在字面量里是 `undefined`，而装配层判据写的是 `!== null`
⇒ 走了 `createObjectRefCipher(undefined)` ⇒ **构造期**抛
`Error [MediaObjectRefKeyError]: MEDIA_OBJECT_REF_KEY 缺失：媒体对象引用加密键未配置`
（栈顶 `services/api/src/media/object-ref-cipher.ts:86` ← `:109` ← `app.ts:1245`（原记 `:1380`）：`createPostgresMediaStore` 的 `cipher:` 实参处；本行随合流 main 从 `:1293` 移到 `:1380`，按符号重取而非平移），`buildApp` 直接失败。
修法：装配层先归一化 `config.mediaObjectRefKey`（非空字符串才算配置，否则按「未配置」），
`tests/unit/api-health.test.mjs` ⇒ tests 6 / pass 6。

**合流**：`git merge origin/main`（main 当时 `30a4ff7`）只撞 `ci-real-pg-wiring.test.mjs`
（main 新增 `messages-purge-pg.mjs`、`SELF_CLUSTERED_ENV` 改名 `SELF_CLUSTERED_PG_BIN_ENV`）。
解决方式：保留 main 的措辞与 `GY_W11_PG_ROOT` 说明，media 条目排第 12、其后重编号并修交叉引用。

### 8.4 合流后本地串行全量读数（`node --test --test-concurrency=1`，5 个 test 目录）

`tests 3447 / pass 3438 / fail 8`，**8 条全部属于 `release-materials-index*` 一组**，且同一个根因：
`tools/verify-release-materials.mjs` 的 `FAIL CVM 脚本 bash -n 语法通过（blob 喂 stdin，不传路径）` ——
本机 `bash` 是 `C:\Users\MR\AppData\Local\Microsoft\WindowsApps\bash.exe`（App Execution Alias，
文件体积 0 字节），执行后打印 `wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL …` 并返回 1，
即**本机没有可用的 bash**。该组其余 20 条判据（索引覆盖 31/31、相对链接 40/40、环境变量模板 18 键、
Dockerfile Node 版本、/health 路由、down 脚本覆盖 0002..0026、migrate 命令闭集…）全部 PASS；
其余 7 个 test 目录（含 `tests/reference/*`、`tests/media/*`、`tests/privacy/*`）全绿。
⇒ 这是**本机环境**限制，CI（ubuntu）有真 bash；CI 侧读数见 PR 的 `unit-tests` job。
（首轮 CI 这同一组也红过，但根因不同：当时 `deploy/cloudrun/env.placeholder.json` 缺 `MEDIA_OBJECT_REF_KEY`，
`FAIL 环境变量模板覆盖配置面` 打崩了「对照组必须全绿」；补键后已 PASS。）

## 9. 媒体端口盘点：本片接通了哪一个（给 #404 阶段二）

「媒体」在 `services/api/src` 下不是一条链，而是**五个端口**。本片只接通第一个：

| 端口 | 文件:行 | 覆盖面 | `real` 下现状 |
| --- | --- | --- | --- |
| 媒体域仓储（本片） | `services/api/src/media/service.ts:1323`（`persistence: mediaStore`） | `/api/v1/media/*` 7 条 + 社区取图 | **已接 PG**（缺键/缺池时 fail-closed） |
| `SynthesisMediaPort`（TTS） | `services/api/src/tts/media.ts:141` | 合成产物存放 | `createUnwiredMediaPort()` fail-closed |
| `SpeechMediaPort`（ASR） | `services/api/src/speech/media.ts:79` | 转写前媒体引用校验 | `createUnwiredMediaPort()` ⇒ `OBJECT_UNAVAILABLE` |
| `OcrMediaPort` | `services/api/src/ocr/media.ts:77` | OCR 媒体引用校验 | 同上 |
| `RecognitionMediaPort` | `services/api/src/recognitions/media.ts:76` | 识别媒体引用校验 | 同上 |

装配点：TTS `app.ts:1085`、ASR `app.ts:2227`（原记 `:2168`）（`media: speechMedia`，无缺省工厂）、OCR `app.ts:1756-1757`
（`ocrPersistencePool` 是 **OCR 自己的 PG 持久化**，不是媒体端口）。

⇒ **`#404 + #419` 都合流后，ASR 转写是 503 → 409，不是 503 → 200**。`services/api/src/speech/media.ts:14-19`
逐字写着理由：域级供应商闸门（`provider.available`）先于 `media.resolve`，real 缺真实 ASR 凭据时先 503；
只有供应商可用时才轮到该端口 ⇒ 409 `OBJECT_UNAVAILABLE`。

**接线处方（另派，本片不扩权）**：每个域的 `media.ts` 加一个包本片 `MediaStore` 的适配器，例如
`createRegistryMediaPort(store: MediaStore)` → `store.getMedia(mediaId)` 判归属/版本/`state === 'ready'`
与目的（ASR 要 `purpose === 'voice_question'`），返回 `NOT_FOUND`/`REVISION_CONFLICT`/`OBJECT_UNAVAILABLE`；
装配处用**已建好的** `mediaStore`（`app.ts:1243`（原记 `:1299`），同一块，不新增工厂调用），判据
`config.executionMode === 'real' && mediaStore.persistent`；代价：四个端口的 `kind` 都是闭集
`'substitute' | 'unwired'`，要加成员并同步各域测试。最小真库臂：在
`tests/integration/media-persistence-pg.mjs` 增一段——real 装配 + PG 仓储 ⇒ 上传 `purpose='voice_question'`
到 `ready` ⇒ `POST /api/v1/speech/transcriptions` 期望非 409；换陌生人 `media_id` 期望拒绝且无新增行。

## 11. 部署授权面补齐与静态审计转正（第三次推送）

### 11.1 事实起点（改之前）

`deploy/postgres-cvm/sql/**` 里对媒体四表**一条授权都没有**（`grep -n 'ON public.media'` 只命中 OCR/识别/语音三域的 `media_id` 单列），
`services/api/db/roles/auth_privacy.sql:39` 给的也只是 `GRANT SELECT (owner_id) ON jobs, media TO gengyun_auth_privacy`（注销/隐私域读属主用）。
所以本片最初的 `services/api/src/media/store-pg.ts` 只能登记进 `tests/unit/sql-column-coverage.test.mjs` 的 `UNAUDITED_SQL_HOSTS`，
真库臂也只有**库 owner** 一条连接 —— 生产运行时角色下第一次 `INSERT INTO public.media` 就会 42501。

### 11.2 补的授权（`services/api/src/media/store-pg.ts` 逐语句反推，不是抄列名）

| 表 | 权限 | 列 | 依据 |
| --- | --- | --- | --- |
| `public.media` | `SELECT` | `id, owner_id, purpose, mime, bytes, duration_ms, sha256, state, failure_code, object_ref_cipher, revision, expires_at, created_at, updated_at`（14） | 读投影（`store-pg.ts` 的 `getMedia` / `listMediaByState` 两份 14 列字面量）＋ `count(*)` 的 `WHERE owner_id / purpose / state` |
| `public.media` | `INSERT` | 同上 14 列 | `createMedia` 的 14 个占位符 |
| `public.media` | `UPDATE` | 除 `id` / `created_at` 外 12 列 | `saveMedia` 的 `SET` 12 项 + `WHERE id` 需 SELECT |
| `public.media` | —（**不给** `DELETE`） | — | 删除是状态机（`deleting → deleted` 走 `UPDATE state`）；媒体行是审计与计费事实，不物理删 |
| `public.media_derivatives` | `SELECT` | `id, media_id, derivative_kind, object_ref_cipher, hash, state`（6） | `SELECT`（:154）＋ `ON CONFLICT … DO UPDATE` **实测**要读 `hash` / `state`（见 11.4） |
| `public.media_derivatives` | `INSERT` | `media_id, derivative_kind, object_ref_cipher, hash, state` | `INSERT … ON CONFLICT` |
| `public.media_derivatives` | `UPDATE` | `object_ref_cipher, state` | `DO UPDATE SET` 两项 |
| `public.media_derivatives` | `DELETE`（**表级**） | — | `DELETE FROM public.media_derivatives WHERE media_id = $1`；PG 无列级 DELETE |
| `public.idempotency_keys` | 复用既有表级 `SELECT/INSERT/DELETE` | — | `services/api/db/roles/auth_privacy.sql:33` 已授（0008 通用台账，W2/W7 各域共用） |
| `public.content_media_refs` / `public.community_media_grants` | **零授权** | — | 本片对这两张表没有任何 SQL（社区授权在 `store-pg.ts` 里显式拒绝），`community_media_grants` 还被 `90-assert-least-privilege.sql` 的 `domain_manifest` 判 `forbidden` |

落点：`deploy/postgres-cvm/sql/20-login-roles.sql` 新增 **段 M（第 931-989 行）**，每段配 `\echo` 说明；
`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 同步三处 —— `domain_manifest` 加 `('media','granted',true)` / `('media_derivatives','granted',true)`，
`expected(...)` 加两行（列清单与 20 逐字一致），`allow_table_dml` 加 `('public','media_derivatives','DELETE')`；
并把 `external_manifest` 里那行 `('media','auth_privacy',…)` **移除**（原因见 11.3）。

### 11.3 为什么必须移除 `external_manifest` 的 media 行

该表的语义是「经 5 个 NOLOGIN 组继承的权限」，判定 `external_violations` 第 (c) 条规定：
**直授 runtime 只允许 `source_group = 'direct'` 的行**，其余组继承行一旦出现直接授权就是漂移。
`media` 的组级授权是 `auth_privacy.sql:39` 的单列 `owner_id`，而本片要求列级读写 ⇒ 只有两条路：
(a) 把 `source_group` 改成 `'direct'`（等于宣称「不经组、直授」，与事实不符，且会把 `jobs` 一行也拖下水）；
(b) 把 media 移出「组继承清单」。选 (b)：`media` 现在是**直授 runtime** 的表，它的权限事实由 `expected(...)` 与 `domain_manifest` 两处表达，
比塞进组继承清单更如实。A/B 读数证明这样改没有放水（11.5）。

### 11.4 `ON CONFLICT DO UPDATE` 的列面实测（这次唯一的返工）

只授 `SELECT (id, media_id, derivative_kind, object_ref_cipher)` 时，以 `SET LOCAL ROLE gengyun_api_runtime` 跑
`INSERT INTO public.media_derivatives (…) VALUES (…) ON CONFLICT (media_id, derivative_kind, hash) DO UPDATE SET object_ref_cipher = EXCLUDED.object_ref_cipher, state = EXCLUDED.state`
⇒ `ERROR: 42501: permission denied for table media_derivatives`。
把 `SELECT` 面扩到 6 列（**+ `hash`, `state`**）后同一语句通过 —— PG 的冲突判定要读 `hash`，`DO UPDATE` 的 `SET` 右侧要读旧 `state`。
两个 deploy 文件（授权 + `expected`）都按实测改齐，并在注释里写明「实测补充，不是静态推断」。

### 11.5 A/B 读数（同一 `gengyun` 库，`origin/main` 版 vs 本片版）

| 阶段 | 结果 |
| --- | --- |
| 库准备 | `DROP/CREATE DATABASE gengyun` → `npm run db:migrate`（26 个迁移）→ `services/api/db/roles/*.sql` 8 个（应用到 `gengyun` 本体） |
| 基线（`origin/main` 的 20 + 90） | `20` exit 0；`90` exit 3，**1 条 FAIL**：`runtime_ledger_readiness_biconditional`（`revision_upd/cancelled_upd/egress_role/egress_grant/writebacks_present/writebacks_listed = false/false/true/false/true/false`） |
| 本片（工作树的 20 + 90） | `20` exit 0；`90` exit 3，**同样是那 1 条**、读数逐字相同 ⇒ **零新增违规**；`runtime_grants_external_*` / `runtime_domain_delete_exec` 全系列 PASS |

> 该条 FAIL 与媒体无关：`services/api/db/roles/egress_ledger.sql` 从未被任何部署脚本执行（`deploy/postgres-cvm/provision-db.sh:285`、`20-login-roles.sql:54` 都记着），
> 属既有缺口，本片不碰。另外两个环境前置（都是真报错逼出来的）：`20-login-roles.sql:83` 要求角色 `gengyun_cvm_owner` 存在；
> `:~90` 要求 `GENGYUN_API_RUNTIME_PASSWORD` 是 48 位小写十六进制；脚本还硬判 `current_database() = 'gengyun'`。

### 11.6 运行时角色正向实测（`SET ROLE gengyun_api_runtime`，9 条语句全过）

```
INSERT INTO public.media (14 列)                        ⇒ RETURNING id ✅
SELECT 14 列投影（purpose::text / state::text / 毫秒时间列）⇒ 1 行 ✅
UPDATE public.media SET state='uploaded', revision=2     ⇒ revision=2 / uploaded ✅
SELECT count(*) … WHERE owner_id AND purpose AND state   ⇒ ✅
INSERT INTO media_derivatives … ON CONFLICT DO UPDATE    ⇒ id ✅
SELECT id, media_id, derivative_kind, object_ref_cipher  ⇒ 1 行 ✅
DELETE FROM media_derivatives WHERE media_id = $1        ⇒ ✅（表级 DELETE）
INSERT INTO idempotency_keys … ON CONFLICT DO NOTHING    ⇒ id ✅（占位 503）
CTE(DELETE claimed) → INSERT … 202 + {"media_id":…}      ⇒ ✅（settle 走 CTE，24h 有效）
```

### 11.7 运行时角色负控制（全部 SQLSTATE **42501**）

| 探针 | 结果 |
| --- | --- |
| `DELETE FROM public.media WHERE id = …` | 42501（media 故意不授 DELETE） |
| `SELECT consent_epoch FROM public.media` | 42501（逐列授权，未列的列读不到） |
| `SELECT * FROM public.media` | 42501（表级 SELECT 未授，星号展开即越界） |
| `SELECT count(*) FROM public.community_media_grants` | 42501（`domain_manifest` 判 forbidden） |
| `SELECT count(*) FROM public.content_media_refs` | 42501（零授权） |
| `TRUNCATE public.media_derivatives` | 42501 |

### 11.8 静态审计转正（`tests/unit/sql-column-coverage.test.mjs`）

`services/api/src/media/store-pg.ts` 从 `UNAUDITED_SQL_HOSTS` **移到 `ADDITIONAL_SQL_HOST_FILES`**（真审计），
并把该文件的 SQL 全部改成**字面量**（去掉 `MS_PARAM(i)` / 投影数组拼接）——否则两份 14 列投影会退化成「不可判插值」，那 14 列就脱离了列权限判定。
五处读数改前 → 改后：

| 读数 | 改前（16 文件） | 改后（17 文件） | 差 |
| --- | --- | --- | --- |
| `auditedFiles` | 16 | 17 | +1（media/store-pg.ts） |
| `sqlLiterals` | 217 | 230 | +13 |
| `statements` | INSERT 36 / UPDATE 32 / SELECT 119 / DELETE 30 | INSERT 39 / UPDATE 33 / SELECT 125 / DELETE 33 | +3 / +1 / +6 / +3 |
| `returningClauses` / `onConflictClauses` | 68 / 21 | 70 / 23 | +2 / +2 |
| `referencedTables` | 39 | 41 | +2（`public.media`、`public.media_derivatives`） |
| `columnRequirements` / `coveredRequirements` | 1409 / 1355 | 1489 / 1435 | +80 / +80（**缺 0 条**） |
| `opaqueExpressions` | 5 | 5 | 0（改造后无新增插值） |
| 未纳管登记 | 8 条 | 7 条 | −1（media 转正） |
| 宿主文件总数 | 24 | 24 | 0（16+8 → 17+7） |

`NC7`（新宿主未登记必红）与 `NC5/NC6`（列面缺/多必红）全部仍绿，`tests 16 / pass 16 / fail 0`。

### 11.9 顺序判据：三链到真 200 需要什么（本片能测的 vs 必须另接的）

| 条件组合 | 现象 | 本片能否测 |
| --- | --- | --- |
| real + 无供应商凭据 | 域级闸门先 503（`PROVIDER_UNAVAILABLE`），**不是** 409 | 未取得（需真实供应商不可用臂；本片未跑，不给读数） |
| real + 凭据可用 + 域媒体端口仍是 `createUnwiredMediaPort()` | 409 `OBJECT_UNAVAILABLE`（`speech/media.ts:14-19` 逐字记着这条顺序） | 未取得（需 stub 供应商把 `provider.available` 置 true） |
| real + 凭据可用 + 域媒体端口包本片 `MediaStore`（处方见 §9） | 走通；替身供应商须显式标注 | 未取得（属另一片：端口 kind 是闭集（`substitute` 或 `unwired`），要加 `registry` 成员） |
| 陌生人 `media_id` / 版本不符 | 拒绝且 `transcriptions` 无新增行 | 未取得（同上，需先有接线端口） |

**本片能测的**：媒体域自身七条路由（`/api/v1/media/*` + 社区取图）在真库 + 真 PG 仓储下 201/202/200/NOT_FOUND/503 全部有读数（§5、§6）；
**必须靠另一片接的**：`tts/synthesisMedia`、`speech/speechMedia`、`ocr/ocrMedia`、`recognitions/recognitionMedia` 四个端口（处方见 §9）。
## 10. 复现命令

```powershell
# 1) 临时 PG（:55683）
initdb -U gengyun -A trust -E UTF8 --no-locale -D .pg17\data-r28w12
# postgresql.conf 追加：port=55683 / listen_addresses='127.0.0.1' / fsync=off / synchronous_commit=off
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"E:\GengYunCommander\.pg17\pgsql\bin\postgres.exe" -D "E:\GengYunCommander\.pg17\data-r28w12"' }
createdb -h 127.0.0.1 -p 55683 -U gengyun gengyun

# 2) 集成复验（脚本自己套用 26 个迁移，`npm run db:migrate` 可省略）
$env:DATABASE_URL='postgres://gengyun@127.0.0.1:55683/gengyun'; $env:PGCLIENTENCODING='UTF8'
node --experimental-strip-types tests/integration/media-persistence-pg.mjs
#    或：npm run test:integration:media-persistence-pg

# 3) 定向单测 + 静态检查 + 台账
node --test --test-concurrency=1 tests/unit/media-*.test.mjs
npm run lint
node tools/verify-contract-status.mjs
```

## 12. [P1] 返修（监工 1027-1927 轮）：条件更新、连带读数与合流订正

**新增的那一条 SQL 与为什么要新增**：`services/api/src/media/store-pg.ts` 的 `writeMediaRow` 里，除原有的
无条件 `UPDATE public.media … WHERE id = $1 RETURNING id`（端口原语 `saveMedia` 仍保留）之外，新增
`UPDATE public.media … WHERE id = $1 AND revision = $14 AND state = $15::media_state RETURNING id`，
即 `saveMediaIfCurrent(record, expected)` 的原子前置条件写。**为什么必须新增**：`complete` 与 `delete`
的幂等 scope 不同（`/complete` 的快照可能早于一次成功删除），只靠 `WHERE id = $1` 会让迟到的 complete
把 `deleted` 墓碑覆盖回 `ready`——改前真库读数就是 `{"ok":true,…,"state":"ready","revision":2}` 且衍生件
留在桶里（§5 的同一 interleave 复跑见 §12 末尾读数）。加上 revision/state 前置条件后影响行数为 0，
服务层据此给出可判定失败（已删除 ⇒ 409 `OBJECT_UNAVAILABLE`「媒体已被删除，迟到的完成上传未生效」；
被别的写入抢先 ⇒ 409 `REVISION_CONFLICT`），并回收这次多写的衍生件。

**连带读数（同一条 SQL 引起的、按实测更新的钉死值，都在 `tests/unit/sql-column-coverage.test.mjs`）**：

| 读数 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| `sqlLiterals` | 230 | 231 | 多一条字面量（条件 UPDATE） |
| `statements.UPDATE` | 33 | 34 | 同上 |
| `returningClauses` | 70 | 71 | 条件 UPDATE 自带 `RETURNING id` |
| `EXPECTED_EXTENDED_PER_FILE['media']` | 13 | 14 | 逐文件口径与总数一致 |
| `columnRequirements` / `coveredRequirements` | 1489 / 1435 | 1502 / 1448 | 新语句重复要求 media 的 13 个 SET 列，全部已被既有列级授权覆盖 |

**合流订正（不属于本片代码，但不改就跑不动 main 的失败矩阵）**：`tests/failmatrix/world.mjs:178` 在 main
上按**同步**签名调用 `mediaService.serverObjectKeys(mediaId)`；本片把该端口改成查持久化台账、返回
`Promise` 之后，那里拿到的是 Promise，`keys.rawRef` 为 `undefined`，于是往替身桶里写了 `null` 键，
`complete` 一律 409「上传对象不存在或已被回收」（真跑：`完成上传失败 409`，`bucket.putObject null`）。
补一个 `await` 即恢复；负控制语义未动。

**锚点与负控制同步**：`services/api/src/media/service.ts` 新增 `snapshotOf`/`staleWriteFailure` 后行号整体下移，
台账 5 条引用（app.ts 的 `accountDeletionWired`、service.ts 的 `getMedia`/`deleteMedia`/`grantMediaAccess`/
`readCommunityMediaContent`）用 `node tools/verify-contract-status.mjs --write-doc` 重新同步，锚点都落在真实
函数体内（`getMedia` 1078-1081、`deleteMedia` 1083-1133、`grantMediaAccess` 1137-1168、
`readCommunityMediaContent` 1292-1338、`accountDeletionWired` 1824-1832）。`tests/failmatrix/mutations.mjs`
的 NC-09 `find` 从 `record === undefined || …` 改为重构后的真实守卫 `record === null || record.ownerId !== actor.ownerId`
（store 端口自本片起返回 `MediaRecord | null`，不再返回 `undefined`），仍是同一条「删掉归属比对」负控制；
`node tools/i22-failmatrix-negative-control.mjs --only=NC-09` 实跑：`watch C2-01,C2-02 → 变红：C2-01(200) C2-02(202)`
（跨主体 GET 拿到 200 + 别人元数据、DELETE 拿到 202），恢复字节后复跑 `C2-01=PASS C2-02=PASS`。

**§12 复跑读数（真库 :55691，与 §5 同一 interleave）**：窗口内 delete ⇒ 202（库内 `state=deleted rev=2`）；
放行迟到 complete ⇒ `OBJECT_UNAVAILABLE`；最终库内 `state=deleted rev=2`、`media_derivatives` 0 行、桶内衍生件
已回收。定向套件：`node --test tests/unit/*contract-status*.test.mjs tests/unit/*i22*.test.mjs
tests/unit/*sql-column*.test.mjs` ⇒ 89 pass / 0 fail；`node tools/verify-contract-status.mjs` 退出码 0。

## 13. 监工二轮：两条 CI 红收口（第四次推送）

两条红都是本分支自己引入或已过期，均在**本分支**修掉，未碰 main。

### 13.1 红一 `unit-tests`：`media-concurrency-pg.mjs` 既不接线也不声明

**改前**（head `c094afae`）：`tests/integration/media-concurrency-pg.mjs` 已随并发读数提交，但既没接进 workflow，
也没进 `UNWIRED_DECLARATIONS` ⇒ `ci-integration-chain-structure.test.mjs` 判据 4 红：
`tests/integration 下有既未接线、也未在本文件 UNWIRED_DECLARATIONS 声明的脚本：tests/integration/media-concurrency-pg.mjs`。

**改后**（三处，全部是「订正 + 加严」，没有放松任何一条）：

1. `.github/workflows/real-pg-integration.yml:243`：紧接 `media-persistence-pg.mjs` 那一步之后新增独立 step ——
   `psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_media_concurrency_test' && node tests/integration/media-concurrency-pg.mjs postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_media_concurrency_test`，
   `env` 与相邻步同形（`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`）。step 上方 15 行中文注释写清覆盖面
   （并发 complete 一 202 一 409、跨主体同幂等键、`reject()` 布尔语义、空库自举）与**必须独立库**的理由：
   第 12 条的读数里有**全库** `count(*)`（`media-persistence-pg.mjs:273-275`、`:289-291`、`:426`），共库会让
   「同一幂等键重复 complete 行数不变」与并发臂的行数互相污染 ⇒ 两条臂都变假读数。
2. `tests/unit/ci-real-pg-wiring.test.mjs:122`（`MANAGED_SCRIPTS`）、`:143`（`FROZEN_MANAGED_SCRIPTS`）、`:221`
   （`REQUIRED_STEP_ORDER` 第 12b 条）三处清单同步加入该脚本，另有 10 行注释写明「与第 12 条同型、独立库、零耦合」。
   判据 ⑦ 的「workflow 里执行的 `-pg.mjs` 集合与 `MANAGED_SCRIPTS` 双向相等」因此把新脚本也纳入管控 —— 这是**加严**：
   接线前它完全没人跑，接线后任何一方漏登记都红。
3. `tests/unit/ci-integration-chain-structure.test.mjs:277`：`UNWIRED_DECLARATIONS` 增一条该脚本的 reason，写明
   「已接进 `.github/workflows/real-pg-integration.yml` 的独立真库 job」「同型但不同库」「不进无 PG 回环链」。

**为什么「接线 + 登记」不是二选一**：判据 4 的 `wired` 集合只来自 `package.json` 的 `test:integration:http` 链，
**不读 workflow**；仓库里真库脚本的既有先例（`media-persistence-pg.mjs`、`messages-pg.mjs` 等）全部是
「接进真库 job + 同时登记『不在无 PG 回环链』」。本脚本照同一范式登记，描述的是「不在回环链」，与「由
`real-pg-17.11` 每次真跑」并不矛盾；派单要求的「优先接线」落在第 1、2 处。

### 13.2 红二 `real-pg-17.11`：`media-persistence-pg.mjs:190` 的 0027 断言过期

**改前**：
```js
assert.equal(migrations.some((m) => /^0027_/.test(m.filename)), false, '本片不占 0027（现成四表 + 0008 台账已够）');
```
它写于「main 最大迁移号 0026」时。`#428` 合入 `0027_admin_audit_observability.sql` 后恒红；下一张 PR 拿 0028 会再红
一次 —— 本质是**拿别人的迁移号当自己的不变量**，注定腐坏。

**改后**（`tests/integration/media-persistence-pg.mjs:190-220`）：判据改为**看迁移内容，不看迁移号** ——
剥掉 `--` 行注释、按 `;` 切句、只认 `CREATE|ALTER|DROP` 开头的 DDL，解析其**作用对象**
（`create [unique] table|alter table|drop table` 后的表名；`create [unique] index … on <表>` 的 `<表>`），
再断言 media 域两张表 `media`／`media_derivatives` 的 DDL **只出自 `0001_initial_schema.sql`**：

```js
const MEDIA_DOMAIN_TABLES = new Set(['media', 'media_derivatives']);
const mediaDdlOwners = migrations.filter((migration) => migration.sql
  .replace(/--[^\n]*/g, '').split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter((statement) => /^(create|alter|drop)\b/i.test(statement))
  .some((statement) => MEDIA_DOMAIN_TABLES.has(ddlTargetOf(statement))))
  .map((migration) => migration.filename);
assert.deepEqual(mediaDdlOwners, ['0001_initial_schema.sql'], '…');
```

**为什么新判据不腐坏**（三条都与「别人加迁移」解耦）：
- 别人加 0027／0028／0030…（不碰这两张表）⇒ 不红，本判据不需要跟着别人改；
- 真有片往 media 域叠迁移（`CREATE/ALTER/DROP TABLE|INDEX`，不管文件名里有没有 `media`）⇒ **立刻红**，且必须在
  本行显式登记文件名并写明是哪个片在改 —— 这是「刻意留 diff」，比按号段猜硬；
- 只认 DDL 的**作用对象**：别的表里带 `media_id` 外键／列的迁移（如 0018 的 favorites/history）不算，避免误伤。

本地真跑（空库 + 27 个迁移，`0027_admin_audit_observability.sql` 在库）：`[1] schema_migrations 行数=27；
迁移文件 27 个（最大号 0027_admin_audit_observability.sql，属别的片；本片**不新增**迁移，判据见下）` ⇒ 18 条读数全过。

### 13.3 本轮本地读数（PG 17.11，端口 55741，`Invoke-CimMethod Win32_Process Create` 起 `postgres.exe`）

| 读数 | 结果 |
| --- | --- |
| 判断 A 并发 complete（真库 `gengyun_media_concurrency_test`） | 状态码 `[409, 202]`；胜方 `media-conc-race-complete-b-00001`（ready/rev2），败方 409 `REVISION_CONFLICT`；库里衍生物 1 行、败方台账 0 行、共享原始对象赛后回收 |
| B1 跨主体同 `Idempotency-Key` initiate | owner 201／stranger 201，两条 media，两把 scope 各 1 行（互不抑制） |
| B2 跨主体同键 complete | owner 202（replay→202）／stranger 404 `NOT_FOUND`；stranger scope 0 行 |
| B3 同主体同键异请求体 | 409 `IDEMPOTENCY_CONFLICT` |
| C1 `reject()`→true | `expireInitiated` expired=1，行 `rejected/expired` 落库 |
| C2 `reject()`→false | 窗口内 DELETE→202；放行后 expired=0，行仍 `deleted/rev2`（不覆盖终态） |
| `media-persistence-pg.mjs` 新判据 | 18 条读数全过（含空库自举 27 迁移、密文往返、真重启、缺键 fail-closed、负控制） |
| `npm run test:unit` 全量 | 3647 tests / **3646 pass / 0 fail** / 1 skipped（`native separate-connection …`，仓库既有 skip） |
| `node tools/lint-workspaces.mjs` | 两份 `tsc --noEmit` + 仓库卫生扫描全 PASS |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | 7/7 pass |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs` | 18/18 pass |

### 13.4 红线自查（本轮）

- 只推 `feat/gy-r28-w12-media-persistence`；未合并、未 approve、未推 main、未强推。
- **未删断言**：红一是「加」清单条目与声明；红二把一条过期断言**换成更硬的按内容判据**（判 DDL 归属比判号严），
  没有任何一条被删除或弱化。
- 未改 `status` 语义、未改任何 `db/migrations/` 文件（`git status` 5 个文件：workflow、两份单测、一个集成脚本、本证据页）。

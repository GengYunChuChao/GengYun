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
- 本片未跑全量 `npm run test:unit`（并发跑全量会互相制造 OOM），全量交给 CI。

## 8. 复现命令

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

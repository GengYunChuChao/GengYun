# R28-W2：媒体域真实对象存储端口接线（证据页）

- 片号：GY-R28 · W2
- 分支：`feat/gy-r28-w2-media-ports`，基点 `f5cca8b`（`f5cca8b73d7190f0276e104cf9cf4889e91a4036`）
- 提交：`544616d`（装配层）／`f1ccdc5`（owner 私有读）／`a03d4e7`（正向读数 + 拒绝闭集 + 两处判据加强）
- 本页由指挥据 W2 回执起草，W2 补齐 `文件:行号` 与复现命令，并**订正一处事实**（临时密钥并未接，见 §2 末、§7-1）
- 上游断点：W1 已把 TTS/OCR/ASR 提供者接线做完，但受理在提供者闸门之后落到 `409 OBJECT_UNAVAILABLE` —— 因为**媒体域自己**从未接过真实对象存储

## 0. 性质口径

本片只做四件事：**对象存储端口接线点**、**上传三段式的 real 路径**、**EXIF 剥离与衍生物**、**服务层内部的 owner 私有字节读**。

⛔ 不含：持久化转 PG（第 4 步判完未动，见 §6）、TTS/OCR/ASR 的 `checked_content` 端口（另一片）、真实云桶与 TLS 往返、对外暴露 owner 字节读的契约面。

## 1. 断点

接线前，`real` 模式下媒体域**整域 503**。确切落点（四步链条）：

- `services/api/src/app.ts:1598`：`const mediaObjectStore = mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode: config.executionMode });`
  —— 端口**只因显式注入而生**；生产启动路径从不注入，于是永远走回落分支。
- `services/api/src/media/object-store.ts:448-451`：`resolveMediaObjectStore` 未收 `env` 时 `config === null` ⇒ `return createUnwiredObjectStore();`。
- `services/api/src/media/object-store.ts:143`：`createUnwiredObjectStore` 的每个操作抛 `PROVIDER_UNAVAILABLE`（`retryable: false`，口径见同文件 `:10`）。
- `services/api/src/app.ts:2356`（`setErrorHandler`；本片测量时在 `:1864`，合流当前 main 后按符号重取）：按契约 `x-error-status-map` 映射为 **503 + `ErrorEnvelope`** ⇒ `POST /api/v1/media/uploads` 在 `real` 下必落 503。

⇒ 这是**装配面缺失**，不是「配置缺失」：四键配齐也拿不到真实端口。

## 2. 形态

- 装配点在 **`services/api/src/media/real-ports.ts`**，由 **`services/api/src/server.ts`**（进程启动点，不在 tsc 审计树内）构造后注入；`buildApp` 侧的「端口只能来自显式注入」结构断言**保持锁死**。
  - `services/api/src/server.ts:39`：`resolveMediaRealPorts({ config, argv: process.argv.slice(2) })`
  - `services/api/src/server.ts:40`：`if (mediaRealPorts !== null) mediaAssembly = mediaRealPortsAssemblyOptions(mediaRealPorts);`
  - `services/api/src/server.ts:51`：`const app = buildApp({ config, pool, ...(mediaAssembly ?? {}) });`
  - 为什么不在 `app.ts`：那里的媒体段被 `tests/unit/media-real-mode-fail-closed.test.mjs` 判死——`resolveMediaObjectStore` 只允许 `buildApp` 以 `{ executionMode }` 一种形状调 1 次；若在 `app.ts` 用 `config.objectStorage` 造真实端口会立刻判红。
- **`--approve-real-media-wiring`**（`services/api/src/media/real-ports.ts:44`）是唯一显式决定点；选启动参数而非 env 的理由同文件 `:40-42`（env 会被容器顺手带上且长期生效；启动参数可被部署清单与进程列表审出来，且不扩张 `config.ts` 的 ambient env 面）。
- 批准能力 `approveRealMediaWiring`（`services/api/src/media/service.ts:473`；non-defaultable 品牌 WeakSet 在 `service.ts:603` 的 `createAppMediaService` 内；两处均为合流当前 main 后的行号）**只在 `resolveMediaRealPorts` 内铸造一次**，不从 env／选项／原型链／结构化克隆派生。
- 配置搬运：`services/api/src/config.ts:51` 暴露 `objectStorage`（由 `readObjectStorageConfig` 解析，`:498-504`；原记 :284-290）、`config.ts:42` 暴露 `mediaAccessGrantOrigin`；两处都**复用媒体域既有判据**，不重写。
- 刻意**没有**给 `MediaObjectStore` 接口加 `probe()`：那会平移 `contract-status.json` 里 `media/object-store.ts` 的锚点。
- ⚠️ **订正**：草稿曾写「临时密钥 `X-Amz-Security-Token` 走 `OBJECT_STORAGE_SESSION_TOKEN` 进适配器」——**不成立**。`readObjectStorageConfig` 只读 `OBJECT_STORAGE_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY,REGION,FORCE_PATH_STYLE}`（`services/api/src/media/object-store.ts:209-243`），**没有 session token 字段**。本片未接临时密钥，见 §7-1。

### 拒绝闭集（6 条，扩张即红；`services/api/src/media/real-ports.ts:58-71`，对外码映射 `:81-88`；原记 :76-83）

| # | 条件 | 拒绝原因字面量 | 对外码 |
|---|---|---|---|
| 1 | 模式非 `real` | `execution_mode_not_real` | `PROVIDER_UNAVAILABLE`／`retryable:false` |
| 2 | 四键不齐/非法 | `object_storage_not_configured` | 同上 |
| 3 | 网关原点不可部署（仍是 `.invalid` 占位） | `access_grant_origin_not_deployable` | 同上 |
| 4 | 批准未铸造（形状/派生/克隆） | `approval_not_minted` | 同上 |
| 5 | 端口 `kind ≠ s3_compatible` | `object_store_not_s3_compatible` | 同上 |
| 6 | 持久化口径不支持 | `persistence_unsupported` | 同上 |

生产入口里它是**启动失败**（`MediaRealWiringError`，`exitCode != 0`），不半接线起来。

## 3. 正向读数（loopback 桶替身 + 真实适配器 + 真实 `buildApp`）

替身方式：桶替身跑在 `127.0.0.1` 的 `node:http` 上，`fetch` **只拦保留域** `storage.example.test`（RFC 6761，永不解析）——TCP、HTTP 帧、预签名 query、body 字节都是真的，**只有主机名映射是替身**。

| 步骤 | 读数 |
|---|---|
| `POST /api/v1/media/uploads` | **201**；句柄 host = `storage.example.test`；`X-Amz-Signature` 为 64 位 hex（签名真实） |
| 客户端 PUT（真实写路径落桶） | `x-amz-content-sha256: UNSIGNED-PAYLOAD`；`content-type: image/jpeg`；**77 B** |
| `POST /media/uploads/{id}/complete` | **202**（契约码本身就是 202 Accepted，**不是 200**，勿误读为缺陷）；`state=ready`、`revision=2` |
| EXIF | 原始 77 B：`Exif=true`、`GPS=true`；衍生物 36 B：`Exif=false`、`GPS=false`（`stripImageMetadata` 生效） |
| 对象引用 | `rawRef=obj_FSA2OhHlloC-2fHTestP8zEF`、`derivativeRef=obj_OtOZSiINKm7iflq11M2sV-gj`（两个不同对象，桶内 2 个键） |
| 内部 owner 读 | `readOwnerMediaContent` → 200、`source=derivative`、36 B、**逐字节等于衍生物**；非 owner ⇒ `NOT_FOUND` |

内部读面的落点：`services/api/src/media/service.ts:1306`（`OwnerContentOutcome`）、`services/api/src/media/service.ts:1329`（`readOwnerMediaContent`）。它**追加在文件末尾**，既有行号零位移，故 `contract-status.json` 里 `getMedia`／`deleteMediaUnclaimed`／`grantMediaAccess` 三处锚点仍逐条可核（台账按红线**未修改**，`contract-status-anchors` **29/29** 绿）。

## 4. 负控制

同样完整的真实 env（四键 + 网关原点 + `real`）但 **argv 不给 `--approve-real-media-wiring`** ⇒ 端口 `kind=unwired`、`POST /media/uploads` → **503 `PROVIDER_UNAVAILABLE`、`retryable:false`**；`server.ts` 零参数时**一个媒体选项都不传**。既有 fail-closed 守卫 `tests/unit/media-real-mode-fail-closed.test.mjs` **20/20 全绿**（含「零注入与 main 一致」类断言）。

## 5. 两处既有判据的改动（只加强，非放宽）

1. **`tests/unit/media-real-mode-fail-closed.test.mjs`「唯一显式注入来源」**
   - 改前：`resolveMediaObjectStore` 调用点必须是 **1 处**（断言「生产码里不存在真实端口装配点」）
   - 改后：允许 **2 处闭集**（`app.ts:1598` + `media/real-ports.ts`），同时**新增**三条更强的钉子——`approveRealMediaWiring` 调用点恰好 **1 处**、`app.ts` 只允许 `resolveMediaObjectStore({ executionMode })` 这一种带参形式、闭集外任何新调用点即红
   - 理由：本片任务正是补那个装配点，只把 1 改成 2 是退化；故改成「点名两处 + 参数形状 + 铸造点唯一」的更强形状
2. **`tests/unit/profile-log-redaction.test.mjs`**
   - 改前：`server.ts` 的 `buildApp({ config, pool })` 逐字钉子
   - 改后：`{ config, pool }` **+ 恰好一处** `...(mediaAssembly ?? {})`，并追加 `mediaRealPortsAssemblyOptions(` 恰好 1 次、`buildApp(` 恰好 1 次
   - 主旨（生产入口不进 `logStream`）不变，实参集合收得更死

## 6. 第 4 步（持久化）的判定与实测修正

- 判定：4 个进程内 Map/Set（记录表／幂等键／授权句柄／附件计数）在**单进程生命周期内**（含 24h `initiated` TTL）不破坏「上传 → complete → 读」；只在**重启后**丢链路（对象仍在桶里，变成不可达孤儿）。因此**未转 PG**，改为 `real` 模式下**显式拒绝** `persistence_unsupported`（`services/api/src/media/real-ports.ts:55` 只有 `process_memory` 一个字面量，`:52-58` 写明限制，**不伪装已持久化**）。
- **实测修正（重要，纠正方案页「需要迁移 0027」）**：本机 PG 17.11（端口 `55611`）全新库跑满 **26 个迁移**后，`media`／`media_derivatives`／`content_media_refs`／`community_media_grants` **四张表早已存在**：
  - `media`、`media_derivatives` —— 出自 `services/api/db/migrations/0001_initial_schema.sql:171/192`（`media` 列含 `owner_id`／`purpose`／`mime`／`bytes`／`duration_ms`／`sha256`／`state`／`failure_code`／`object_ref_cipher`／`revision`／`consent_epoch`／`expires_at`）
  - `content_media_refs`、`community_media_grants` —— 出自 `0022_community_persistence.sql`
  - ⇒ 第三层**不需要新迁移号**（`0027` 仍空闲，勿凭印象写）。
- 真正缺的是：PG 仓储 + `media.object_ref_cipher` 的**加密键接线** + 幂等表落库 + `app.ts` 装配（受 §2 结构断言约束）。工作量远大于「加两张表」，建议单独一片。

## 7. 未取得

1. **临时密钥 `X-Amz-Security-Token`（STS）**：`readObjectStorageConfig` 目前**没有 session token 字段**（`services/api/src/media/object-store.ts:209-243`）；要接需改 `object-store.ts` 的接口与判据，会平移 `contract-status.json` 里该文件的锚点 ⇒ 本片未做，STS 临时凭据仍不可用。
2. **真实云桶 / TLS**：只有 loopback 替身（保留域 `storage.example.test`；TCP、HTTP 帧、预签名、body 字节全真，仅主机名映射是替身）。真实云桶的凭据与签名往返、桶策略/CORS、`https` 与证书链未验。
3. **部署参数**：`deploy/**` 按红线未动 ⇒ 生产 real 启动若真要接线，部署侧必须显式加 `--approve-real-media-wiring` 并配齐 `OBJECT_STORAGE_*` 与 `MEDIA_ACCESS_GRANT_ORIGIN`，否则启动即被拒（如 `access_grant_origin_not_deployable`）。
4. **`checked_content` 端口**：TTS/OCR/ASR 的内容审核端仍非 real（W1 只接了提供者），属另一片。
5. **owner 字节读无外部出口**：当前只有服务层内部函数（`service.ts:1329`），`services/api/src/routes/media.ts` 一次都不引用它 ⇒ 外部 HTTP 面对它只会 404；若要对外暴露，需先补契约 operation（85 路径之外），属契约片。

## 8. 复现命令

本轮在 `E:\GengYunCommander\wt-w2-media-ports` 里**真跑**过的命令（Node v24.16.0 / npm 11.13.0，`npm install` 只跑一次）：

```powershell
# 静态检查
npm run lint

# 媒体域逐文件（逐条真跑）
node --test tests/unit/media-attachment-limit.test.mjs
node --test tests/unit/media-consent-wiring.test.mjs
node --test tests/unit/media-grant-origin-assembly.test.mjs
node --test tests/unit/media-grant-url-origin.test.mjs
node --test tests/unit/media-http-access.test.mjs
node --test tests/unit/media-http-upload.test.mjs
node --test tests/unit/media-object-store-s3-paths.test.mjs
node --test tests/unit/media-real-mode-fail-closed.test.mjs      # 20/0
node --test tests/unit/media-real-ports-wiring.test.mjs          # 2/0（新）
node --test tests/media/access.test.mjs tests/media/audio.test.mjs
node --test tests/media/chunk-transform-boundaries.test.mjs tests/media/contract.test.mjs
node --test tests/media/detect-exif.test.mjs tests/media/lifecycle.test.mjs
node --test tests/media/schema.test.mjs tests/media/validate.test.mjs

# 全量单测（独占跑）
npm run test:unit                                                # 3377 tests / 3376 pass / 0 fail / 1 skipped

# 契约台账锚点（红线：台账不改，锚点仍可核）
node --test tests/unit/contract-status-anchors.test.mjs tests/unit/contract-status-tool.test.mjs   # 29/0

# 真库读数（自建一次性集群，端口 55611，不用 55436；跑完即停并删数据目录）
$pg = 'E:\GengYunCommander\.pg17\pgsql\bin'
& "$pg\initdb.exe" -D E:\GengYunCommander\.pgdata-w2 -U postgres -A trust -E UTF8 --locale=C
& "$pg\pg_ctl.exe" -D E:\GengYunCommander\.pgdata-w2 -o "-p 55611 -c listen_addresses=127.0.0.1" -l E:\GengYunCommander\.pgdata-w2\srv.log start
& "$pg\psql.exe" -h 127.0.0.1 -p 55611 -U postgres -c "create database gengyun_w2"
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:55611/gengyun_w2'
npm run db:migrate                                               # 26 个迁移全绿
& "$pg\psql.exe" -h 127.0.0.1 -p 55611 -U postgres -d gengyun_w2 -tAc "select table_name from information_schema.tables where table_schema='public' and table_name like '%media%' order by 1"
& "$pg\pg_ctl.exe" -D E:\GengYunCommander\.pgdata-w2 -m fast stop
```

读数汇总：`npm run lint` **PASS**（`tsc --noEmit services/api` + `apps/admin` + 仓库卫生扫描「无禁用 TLS 写法／无硬编码密钥／无真实 `.env`」）；`npm run test:unit` **3376 pass / 0 fail / 3377 tests**（1 skipped）；媒体域逐文件 `6/0 · 8/0 · 3/0 · 6/0 · 12/0 · 22/0 · 11/0 · 20/0 · 2/0`（`tests/unit`）与 `10/0 · 37/0 · 10/0 · 7/0 · 41/0 · 16/0 · 4/0 · 15/0`（`tests/media`）；`tests/integration/*media*` 为空集（该目录无 media 文件）。

## 9. 抖动与真红的如实记录

`npm run test:unit` 首跑出现过 3 条红：`local-dev-package`、`local-profile-bootstrap` 单跑各自通过、次跑全量即绿 ⇒ 判为负载抖动；`contract-status-anchors` 是**真红**（新代码插在 `service.ts` 中部导致 3 个锚点行号位移），已改为「追加到文件末尾」修复，`contract-status.json` **未改**。

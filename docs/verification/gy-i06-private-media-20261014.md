# GY-I06 私有媒体上传、访问权限与 EXIF 清除 · 可见证据（2026-10-14）

- **Issue**：[#6](https://github.com/GengYunChuChao/GengYun/issues/6)（P0 / M1；验收 AC07、AC09、AC23；功能 F05、F12、F13、F15、F16）。**不关闭整项**（`Refs #6`）。
- **分支**：`feat/gy-i06-private-media`（独立 worktree，本地提交，**未 push**；无任何 GitHub 凭据）。
- **初版基线**：`upstream/main` = `ab5df72b6d4a0dbc6e1055bce39c0161fe10b2a4`。
- **返修时合入的 `upstream/main`**：`1fc0308818b85227078d43b6246d006cb2aead7f`（`git merge upstream/main`，无冲突）。
- **提交**：`5880f819e0157df29c475452aba1de4a077c33af`（实现 + 测试 + 契约状态对照表）、
  `725ae5bc7869e3ee6391b589f42bf60503faa5bb`（初版证据文档），以及**本次返修提交**
  （监工批复 P1 修复 + 针对性验证 + 本文档 §11；SHA 见 PR #129 的最新 HEAD 与回传）。
- **环境**：Node `v24.16.0` / npm `11.13.0`；仓库为 npm workspaces + 纯 ESM（`npm install`，**未使用**任何 junction/symlink）。

## 1 本片做了什么（一句话）

`packages/media/**`（PR #60 已合并的媒体域纯模块）此前**从未接入产品 HTTP 面**
（该模块 README 自述「媒体 HTTP 路由尚未接线」，`services/api/src/recognitions|speech|ocr/media.ts`
三处注释均把接线工作记为 **GY-I06 的剩余工作**）。本片接上契约的 7 个 operationId，补齐
**异步对象存储端口**、**real 模式 fail-closed**、**同键并发保护**与**社区审核上下文**。

> **校订（2026-10-16 实测；测量基线 `3bc7451`）**：上段**转述**的那句「媒体 HTTP 路由尚未接线」**已过期**——`packages/media/README.md:74`
> 现标题为「services/api 挂载示例（媒体 HTTP 路由已接线；未接线的是**句柄消费网关**）」，同名接力点
> `services/api/src/{recognitions,speech,ocr}/media.ts` 的**文件头仍为旧措辞**（实测三份的 `:8` 均逐字含「媒体 HTTP 路由尚未接线」；
> `services/api/src/recognitions/media.ts:10`、`services/api/src/speech/media.ts:9`、`services/api/src/ocr/media.ts:9` 写「本片不接线媒体 HTTP 路由」），
> **本页不引用其文件头为现状**，订正由**在飞 PR #235**（`fix/gy-i02-stale-wiring-comments`，head 实测 `84de2ce4e65972595f3b3f4d2fd8fbfa6d9e9729`，OPEN／非草稿／未合并）承载。本节转述的是**改前**状态
> （该片当时**就是**在接这条线），故"三处注释把接线记为 GY-I06 剩余工作"作为**过程记录**仍成立，**不作现状引用**。
> **仍未接线、不受本次校订影响的是**：句柄消费网关（owner 私有媒体字节数据面）与**真实对象存储适配器**。

## 2 改前 / 改后（运行时原始输出）

探针：`buildApp` + 合成会话，打三条媒体路径与一条对照路径（`services/api/src/app.ts` 的 404 处理器兜底）。
「改前」= 临时注释掉 `registerMediaRoutes(app, config, guards, mediaService);` 这一行（改后已还原，
文件 SHA-256 与备份一致）。

```
########## 改前（媒体路由未注册）##########
[mode=stub] POST /api/v1/media/uploads → 404 {"error":{"code":"NOT_FOUND","message":"未实现的路径：POST /api/v1/media/uploads","retryable":false,"details":[]},...}
[mode=stub] GET /api/v1/media/66666666-…-666666666666 → 404 {"error":{"code":"NOT_FOUND","message":"未实现的路径：GET /api/v1/media/…",…},...}
[mode=stub] GET /api/v1/community/media/66666666-…/content → 404 {"error":{"code":"NOT_FOUND","message":"未实现的路径：GET /api/v1/community/media/…/content",…},...}
[mode=stub] GET /api/v1/recognitions/66666666-… → 404 {"error":{"code":"NOT_FOUND","message":"识别记录不存在",…},...}
```

```
########## 改后（registerMediaRoutes 生效）##########
[mode=stub] POST /api/v1/media/uploads → 201 {"data":{"media":{"id":"6dd92c06-…","revision":1,"purpose":"label_ocr","mime":"image/jpeg","bytes":77,"duration_ms":null,"state":"initiated","sha256":"a29f530c…","failure_code":null},"upload":{…}},"meta":{…,"execution_mode":"stub"}}
[mode=stub] GET /api/v1/media/66666666-… → 404 {"error":{"code":"NOT_FOUND","message":"媒体不存在","retryable":false,"details":[]},…}
[mode=stub] GET /api/v1/community/media/66666666-…/content → 404 {"error":{"code":"NOT_FOUND","message":"授权不存在","retryable":false,"details":[]},…}
[mode=stub] GET /api/v1/recognitions/66666666-… → 404 {"error":{"code":"NOT_FOUND","message":"识别记录不存在",…},…}   ← 对照：非媒体域未被本片影响
```

```
########## real 模式（真实对象存储未接线 ⇒ 整域 fail-closed）##########
[mode=real] POST /api/v1/media/uploads → 503 {"error":{"code":"PROVIDER_UNAVAILABLE","message":"real 模式未接真实对象存储：媒体域不可用（拒绝以内存/替身存储返回成功应答）（fail-closed）","retryable":true,"details":[]},…}
[mode=real] GET /api/v1/media/66666666-… → 503 {"error":{"code":"PROVIDER_UNAVAILABLE",…,"retryable":true,…},…}
[mode=real] GET /api/v1/community/media/66666666-…/content → 503 {"error":{"code":"PROVIDER_UNAVAILABLE",…,"retryable":true,…},…}
[mode=real] GET /api/v1/recognitions/66666666-… → 404 {"error":{"code":"NOT_FOUND","message":"识别记录不存在",…,"execution_mode":"real"},…}
```

## 3 契约对齐点（逐 operationId，来源 [openapi.json](../../packages/contracts/openapi.json) + [operations.json](../../packages/contracts/operations.json)）

| operationId | 方法与路径 | 成功 | 必填参数 | 成功响应头 | 本片实现的错误码 |
| --- | --- | --- | --- | --- | --- |
| `createUpload` | `POST /media/uploads` | 201 `UploadGrantEnvelope` | `Idempotency-Key`(8..128) | `ETag: "<revision>"`、`Cache-Control: no-store` | 400 `INVALID_REQUEST` / 400 `IDEMPOTENCY_KEY_REQUIRED` / 409 `IDEMPOTENCY_CONFLICT` / 409 `REQUEST_IN_PROGRESS` / 413 `MEDIA_TOO_LARGE` / 415 `MEDIA_TYPE_UNSUPPORTED` / 503 `PROVIDER_UNAVAILABLE` |
| `completeUpload` | `POST /media/uploads/{id}/complete` | 202 `MediaEnvelope` | `Idempotency-Key`、`If-Match` | `ETag`、`Cache-Control: no-store` | 400 / 404 `NOT_FOUND` / 409 `REVISION_CONFLICT` / 409 `IDEMPOTENCY_CONFLICT` / 409 `OBJECT_UNAVAILABLE` / 413 / 415 / 428 `REVISION_REQUIRED` / 503 |
| `getMedia` | `GET /media/{id}` | 200 `MediaEnvelope` | — | `ETag`、`Cache-Control: no-store` | 400 / 401 `SESSION_REQUIRED` / 404 |
| `deleteMedia` | `DELETE /media/{id}` | 202 `AckEnvelope` | `Idempotency-Key`、`If-Match` | `ETag`、`Cache-Control: no-store` | 400 / 404 / 409 `REVISION_CONFLICT` / 428 / 503 |
| `grantMediaAccess` | `POST /media/{id}/access` | 200 `AccessGrantEnvelope` | `Idempotency-Key`、`If-Match` | `ETag`、`Cache-Control: no-store` | 400 / 404 / 409 `OBJECT_UNAVAILABLE` / 409 / 428 / 503 |
| `grantCommunityMediaAccess` | `POST /community/media-access` | 200 `CommunityMediaGrantEnvelope` | `Idempotency-Key`、`If-Match`（**对应 `content_ref.revision`**） | `ETag`、`Cache-Control: no-store` | 400 / 404 / 409 / 428 / 503 |
| `readCommunityMediaContent` | `GET /community/media/{grant_id}/content` | 200 二进制 `image/jpeg\|png\|webp` | `X-Media-Access-Token`(1..512) | `ETag`、`Cache-Control: no-store`（**恒**）、`X-Request-Id`、`X-Execution-Mode` | 400 / 404（**失效统一 404**）/ 503 |

对齐细节（逐条与冻结契约核对）：

- 请求体 schema 与契约逐字一致并 `additionalProperties: false`（`app.ts` 已关闭 `removeAdditional`，
  多余字段**不会被静默剔除**，而是 400）；`UploadInput` 的 required 是
  `purpose/mime/bytes/sha256`，`duration_ms` 仅音频接受、图片拒绝。
- `Media` 投影只含契约 9 个字段（`id/revision/purpose/mime/bytes/duration_ms/state/sha256/failure_code`），
  **不含** `object_ref` / owner / 桶路径。
- `AccessGrant` 四字段齐备：`url` 必须 `^https://`、`method` 为 `PUT`（上传）或 `GET`（读取）、
  `expires_at`、`access_token` —— **令牌不入 URL**（测试断言 `url` 不包含 `access_token`）。
- `If-Match` 按契约 `^"[1-9][0-9]*"$`：缺失 428、格式非法 400、不匹配 409（`"1"` 这种裸数字被拒绝）。
  社区取图的 `If-Match` 对应 **`content_ref.revision`**，并以其回写 `ETag`。
- 成功封套统一 `{ data, meta }`，`meta` 复用 `buildMeta`（`request_id` / `contract_version=1.0.0` / `execution_mode`）。
- **`author_revision` 的写法差异（有意为之，已在源码注明）**：契约写 `anyOf: [integer>=1, null]`，
  但 Fastify 默认 `coerceTypes: true` 会让 `anyOf` 的第二支把数字 `0` **静默强转**为 `null` 从而通过校验。
  本实现改用语义等价的联合 `type: ['integer','null'] + minimum: 1`，使 `author_revision: 0` 如实 400。
  合法取值（正整数 / `null`）的线上行为与契约完全一致。

## 4 装配与实现清单

| 文件 | 状态 | 为什么这样装配 |
| --- | --- | --- |
| [services/api/src/media/object-store.ts](../../services/api/src/media/object-store.ts) | 新增 | 对象存储端口三态：`substitute`（明确标注的替身，句柄域 `substitute.invalid`，零网络）/ `unwired`（每操作 503，fail-closed）/ `s3_compatible`（COS/S3 兼容 SigV4 预签名 + `fetch`，**只写好、从未被调用**）。端口是**异步**的，因为契约的 `UploadCompleteInput` 只有 `{sha256,bytes}` —— 字节必须由服务端从对象存储取回，网络 I/O 无法在同步端口里表达。 |
| [services/api/src/media/service.ts](../../services/api/src/media/service.ts) | 新增 | HTTP 面的唯一业务入口。**复用** `packages/media` 的已合并原语（`validateUploadInput` / `validateCompleteInput` / `assertBytesMatchDeclaration` / `stripImageMetadata` / `createAccessTokenFactory` / 常量与 `MediaError`），**不修改 `packages/media/**`**。`packages/media/service.mjs` 保持为模块内参考实现（由 `tests/media/**` 覆盖）：其存储端口是同步的、且要求调用方在 `completeUpload` 直接交出媒体字节，这两点与冻结契约的「预签名直传 + 服务端取回核验」不一致，故异步边界由本层承担。 |
| [services/api/src/media/content-source.ts](../../services/api/src/media/content-source.ts) | 新增 | 社区取图的公开内容来源端口。**默认关闭**（一律返回 null ⇒ 统一 404，不误放行）；真实来源属社区/审核线，本任务**不修改** `services/api/src/community/**`、`services/api/src/admin/**` 等已合并文件。 |
| [services/api/src/media/packages.d.ts](../../services/api/src/media/packages.d.ts) | 新增 | 对 `*packages/media/index.mjs` 的只读类型声明（与 `community/moderation.d.ts`、`privacy/reference.d.ts` 同一做法），让导出漂移在 `npm run lint`（tsc）阶段暴露。 |
| [services/api/src/routes/media.ts](../../services/api/src/routes/media.ts) | 新增 | 7 条路由的**单一注册点**。签名只接收一个已装配好的 `AppMediaService`，因此「装配路径零真实存储注入」在类型上成立；HTTP 层只管形状（幂等键 / 路径 uuid / 请求体 schema），语义全在服务层。 |
| [services/api/src/app.ts](../../services/api/src/app.ts) | 修改（+43/−1） | 新增可选注入项 `mediaObjectStore` / `mediaContentSource` / `mediaAttachmentCounter`，按执行模式解析端口，`decorate('mediaService')` 与 `decorate('mediaObjectStore')`，并在**唯一一处**调用 `registerMediaRoutes` 注册 7 条路由。默认不传注入项 ⇒ 与接线前无其它域行为变化。 |

## 5 测试与直跑原始输出

测试文件（全部使用合成身份 + 替身对象存储 + `tests/media/_fixtures.mjs` 合成媒体字节，
**不含**任何真实个人媒体 / 凭据 / 真实对象存储 / 供应商调用）：

| 测试文件 | 条数 | 覆盖 |
| --- | --- | --- |
| [tests/unit/media-http-upload.test.mjs](../../tests/unit/media-http-upload.test.mjs) | 22 | 契约形状与投影、伪扩展名、无图像数据、hash 不符、真实时长 >60s、四类限额、每帖 ≤3 张、EXIF 清除、失败/取消的孤立对象回收、同键并发（HTTP 收敛 + 服务层确定性 409） |
| [tests/unit/media-http-access.test.mjs](../../tests/unit/media-http-access.test.mjs) | 12 | 越权与不存在**逐字节同形** 404、删除/幂等重放、owner 句柄、社区取图默认关闭、未发布/未过审/版本不符、令牌与主体与过期与下架复核、头像 `author_revision`；**§11 返修新增 3 条**：删除失败后的可重试性（抛错 / 返回 `false` / 重复删除重试 / 完成失败回收同源路径） |
| [tests/unit/media-real-mode-fail-closed.test.mjs](../../tests/unit/media-real-mode-fail-closed.test.mjs) | 5 | real 整域 503 反例、stub 对照、端口级 fail-closed、显式放行（零网络）、端口标注与配置读取 |

直跑命令与原始输出：

```
> node --test tests/unit/media-http-upload.test.mjs tests/unit/media-http-access.test.mjs tests/unit/media-real-mode-fail-closed.test.mjs

▶ GY-I06 HTTP 上传面：契约形状、真实类型核验、限额、EXIF 清除与孤立对象回收
  ✔ 未登录访问任一媒体路由 → 401 SESSION_REQUIRED
  ✔ createUpload 成功：201 UploadGrantEnvelope + 强 ETag + no-store + initiated/revision=1
  ✔ 反例：body 多余字段 → 400 INVALID_REQUEST（additionalProperties:false）
  ✔ 反例：缺 / 过短 Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED
  ✔ 反例：空路径参数形状非法 → HTTP 层 400（存在性判定留给服务层 404）
  ✔ 反例：用途与声明类型不符 → 415 MEDIA_TYPE_UNSUPPORTED（不是 400）
  ✔ 反例：超限（识别图 >2MiB / 帖图 >5MiB / 语音 >10MiB / 时长 >60s）→ 413 或 400
  ✔ 社区每帖 ≤3 图：第 4 张 createUpload → 400（保守替身计数器，非静默放宽）
  ✔ completeUpload 成功：202 + ready/revision=2，且**输出不含 EXIF/GPS**（原始对象留私有参考）
  ✔ 反例：伪扩展名（声明 image/png、真实 JPEG）→ 415，且上传对象被回收
  ✔ 反例：无图像数据（仅 PNG 签名）→ 415，且上传对象被回收
  ✔ 反例：实际字节与声明 hash 不符 → 400，且上传对象被回收
  ✔ 反例：音频真实时长 >60s（声明 60s，真实 61s）→ 400，且上传对象被回收
  ✔ 反例：If-Match 缺失 → 428；不匹配 → 409；格式非法 → 400（完成接口）
  ✔ 反例：完成时对象尚未落盘 → 409 OBJECT_UNAVAILABLE（不伪造 ready）
  ✔ 取消（客户端放弃上传）：24h 后 expireInitiated 回收对象，不留孤立对象
  ✔ 孤立对象清理：cleanupOrphans 回收 rejected/deleted 记录的对象
  ✔ 并发同键：同键并发 createUpload 不得产生第二条媒体记录（409 REQUEST_IN_PROGRESS 或回放同一 id）
  ✔ 并发同键：同键并发 completeUpload 只自增一次、只落一个衍生件
  ✔ 并发同键（服务层确定性）：第二个同键请求被 409 REQUEST_IN_PROGRESS 拒绝，只落一条记录
  ✔ 替身对象存储如实标注：不发起外部请求，句柄指向保留域
▶ GY-I06 HTTP 访问面：归属同形 404、短效句柄失效、审核上下文与版本复核
  ✔ 反例：非本人与不存在**逐字节同形** 404（getMedia / complete / delete / access）
  ✔ deleteMedia：202 Ack + 强 ETag；同键同体原样重放；删除后墓碑为 deleted 且对象即时回收
  ✔ grantMediaAccess：仅 owner 且仅 ready；If-Match 对应媒体 revision
  ✔ 社区取图：公开内容来源默认**关闭** ⇒ 统一 404（不误放行）
  ✔ 社区取图：未发布 / 未过审 / 版本不符 / 非社区用途 ⇒ 一律 404
  ✔ 社区取图：授权 → 读图 → 逐次复核（令牌/主体/过期/媒体删除/内容下架）
  ✔ 社区取图：头像槽位另核 author_revision，且不接受非社区用途媒体
  ✔ 反例：社区取图请求体非法 / 多余字段 → 400 INVALID_REQUEST
  ✔ 返修 P1：删除时端口一次暂时失败 ⇒ 引用保留；端口恢复 ⇒ cleanupOrphans 真正删除
  ✔ 返修 P1：端口持续返回 false（未能确认）⇒ 引用与待清理计数保留，恢复后才清空
  ✔ 返修 P1：重复删除（已是 deleted）仍会重试回收；completeUpload 失败回收走同一原则
✔ GY-I06 real 模式 + 未接真实对象存储：整域 503 PROVIDER_UNAVAILABLE（fail-closed 反例）
✔ GY-I06 stub 对照：同一批路由在替身模式下可用（证明上面的 503 来自 fail-closed 而非路由缺失）
✔ GY-I06 端口级 fail-closed：把未接线端口注入**非 real** 模式也一律 503（不只看模式开关）
✔ GY-I06 显式放行：注入真实适配器（仅构造 + 本地预签名，零网络）后 real 模式可用
✔ GY-I06 对象存储端口：如实标注、构造校验与配置读取

ℹ tests 39
ℹ pass 39
ℹ fail 0
```

关键断言摘录（避免「只要不 500 就算过」）：

- EXIF：夹具 `jpegWithExif()` 的**输入**含 `Exif` 与 `GPSDATA` 字节；服务端对外衍生件
  **不含** `Exif` / `GPSDATA` / `GPS`，且仍是结构完整的 JPEG（`FFD8` 起、`FFD9` 止）。
- 孤立对象：每次失败/取消后断言替身存储对象数回到基线；删除后断言 `原始件 + 衍生件` 两件被回收。
- 同形 404：对 `getMedia`/`complete`/`delete`/`access` 逐条比较「非本人」与「不存在」的
  `error` 对象 `deepEqual`（含 `message` 与空 `details`）。
- real fail-closed：7 条路由全部 503 且 `retryable === false`、**无 `data` 字段**（不得返回成功封套）。
  **订正（绑实测 SHA `95b8e7cf`）**：此处原文写 `retryable === true`，与现行代码／断言不符。现行口径是
  「能力未装配／未接线造成的 `PROVIDER_UNAVAILABLE` 一律 `false`」（`services/api/src/errors.ts:32`，
  另见 `:35`），服务层的 fail-closed 构造器同样显式 `retryable: false`
  （`services/api/src/media/service.ts:448`；槽位判定处 `:652-654`），测试断言
  `tests/unit/media-real-mode-fail-closed.test.mjs:949`（同文件 `:126-127` 断言 503 ＋ `PROVIDER_UNAVAILABLE`）。
  §2 的 2026-10-14 探针输出与 §10 所记裁定原文**按原样保留**，不追改；口径差异见 §8.1 末段。

## 6 real fail-closed 反例：若不修会怎样

本片的负控制（negative control）针对**监工对 #121 的 P1 裁定**：

- 若把 `resolveMediaObjectStore({ executionMode: 'real' })` 改回替身存储，或删掉
  `createAppMediaService` 里 `executionMode === 'real' && objectStore.kind !== 's3_compatible'`
  这条判据，则 `real` 模式下 `POST /api/v1/media/uploads` 会返回 **201 成功封套**，
  而落点只是进程内内存 —— 即在「真实模式」下声称成功、重启即丢。
  `media-real-mode-fail-closed.test.mjs` 的第 1 条用例会**立刻失败**（期望 503，实得 201/409）。
- 该守卫的判据是**注入端口的 `kind`**，不是一个自述「我已持久化」的布尔标志：
  第 4 条用例注入真实的 `createS3CompatibleObjectStore(...)` 证明「显式放行」这条可审查接线路径
  确实存在，且断言 `externalRequestCount === 0`（整轮**未发起任何真实对象存储请求**）。
- 第 3 条用例把 `createUnwiredObjectStore()` 注入**非 real** 模式，证明守卫不只在模式开关上，
  端口层面同样 fail-closed。

## 7 门禁（全部在本分支 HEAD 上实跑，退出码 0）

```
> npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）

> npm run test:unit
ℹ tests 1736   ℹ pass 1735   ℹ fail 0   ℹ skipped 1
```

其中唯一跳过项来自**既有**用例 `tests/unit/knowledge-api.test.mjs:101`（`{skip: !f.native}`：
本机无原生 PG），本片新增的 3 个测试文件（22 + 12 + 5 = 39 条）**不含**任何 `skip`/`todo`。
（1736 是**合入 `upstream/main` `1fc0308`（GY-I27 #128）之后**的全量数：
本片返修前为 1687，合入后 +49 条来自 GY-I27 的隐私测试。）

```
> npm run test:contract
ℹ tests 6      ℹ pass 6      ℹ fail 0

> npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables

> git diff --check     （无输出，退出码 0）
```

**§11 返修按轻量规范只跑受影响项**（其余既有回归复用，未重跑无关矩阵）：

```
> node --test "tests/unit/media-*.test.mjs"      ℹ tests 39   ℹ pass 39   ℹ fail 0   ℹ skipped 0
> node --test "tests/media/*.test.mjs"           ℹ tests 140  ℹ pass 140  ℹ fail 0   （同域模块级回归，未改 packages/**）
> npm run lint                                   PASS ×3（tsc services/api、tsc apps/admin、卫生扫描）
> npm run test:docs                              PASS: 27 initial tasks; … Markdown links and tables
> npm run test:unit                              ℹ tests 1736 ℹ pass 1735 ℹ fail 0 ℹ skipped 1
> git diff --check                               （无输出，退出码 0）
```

契约状态对照表按**实际装配**更新：[contract-status.json](../architecture/contract-status.json) 中
7 条媒体操作由 `route_mounted: false` / `planned` 改为 `route_mounted: true` / `partial`，
并同步 [contract-implementation-status.md](../architecture/contract-implementation-status.md) 的中文表。

**已发现的既有门禁缺口（非本片引入，本片未修）**：`node tools/verify-contract-status.mjs`
在本基线 `upstream/main` 上**已经**失败 4 项「证据行号越界」，全部指向**其它线**的文件
（`services/api/src/knowledge/service.ts` 记录 14-80 / 60-69 / 74-78 但文件仅 65 行；
`services/api/src/privacy/consent-pg.ts` 记录 140-183 但文件仅 180 行）。
已用 `git show upstream/main:…` 逐项复算确认这 4 项在**基线**即存在。因该脚本在存在错误时
拒绝写表格，本片改用其自带的 `replaceStatusTables()` 直接渲染中文表（结果与 `--write-doc` 逐字节一致，
并做了幂等自检）。**未修**该 4 项：它们属其它线的数据，改动应先由对应写手/监工确认。

## 8 未取得 / 未验证项（如实列出）

| 项 | 状态 |
| --- | --- |
| 真实对象存储（腾讯云 COS / S3 兼容桶） | **未验证**。`createS3CompatibleObjectStore` / `presignS3Url` 的代码路径在本仓库内**从未被实际调用**；未对接任何真实桶、未做签名往返核验；测试只覆盖结构断言（https、必需 `X-Amz-*` 查询参数、未发起网络请求）。 |
| 上传/读取访问网关、CDN、原桶 URL 重定向策略 | **未接线**。冻结契约（85 条路径 / 112 条 operation）内**没有**满足「owner 私有媒体字节读取」语义的那一条 operation：`/media/{id}/content` 不在契约里（复现：`GET /api/v1/media/{id}/content` ⇒ 404「未实现的路径」；契约内唯一返回二进制的 `GET /community/media/{grant_id}/content` 只服务社区公开已审上下文）；`grantMediaAccess` 的句柄 URL 消费端属部署期网关，本仓库不提供该数据面 ⇒ **客户端经契约取不到私有媒体字节**。 |
| 真实微信登录态 | **未验证**。测试用合成身份（stub 登录替身或直接注入合成会话）；微信开发者工具未运行。 |
| 真机 / Android / iOS / 小程序端 | **未验证**。本片不含客户端改动，也未在真机或微信开发者工具中验证。 |
| 真实供应商（ASR/识别/TTS） | 本片不涉及；音频只按契约枚举与真实时长核验，**不**把产品限额冒充供应商接口限制。 |
| 实库事务 / 持久化媒体记录 | **未接线**。媒体记录为进程内 Map（本片无持久化实现）；库表 `media` / `media_derivatives` / `community_media_grants` 已由 GY-I02 的 `0001_initial_schema.sql` 冻结，但本片不写库。 |
| 社区帖子 / 审核状态真实来源 | **未接线**（默认关闭 ⇒ 统一 404）。跨线：需 GY-I14/GY-I15 提供只读端口后在装配层显式注入。 |
| 删除账本（`DELETION_LEDGER_KEY`）与注销 7 日 / 备份 30 日闭环 | **未接线**。本片的删除是即时回收 + `deleted` 墓碑，**不**声称删除任务记录已对接。 |
| 有损 WebP / 动画 WebP | **受控拒绝**（沿用 `packages/media` 的既定边界：本仓库只有 VP8L 无损真实解码器）。 |
| 真实个人原始媒体 / 真实 `.env` / 密钥 | **未使用、未入库**（仓库卫生扫描通过）。 |

### 8.1 复核补充：在现行 `upstream/main` 上新增的三项证据缺口

> **测量基线**：`upstream/main` = `95b8e7cf67106391a61e88090d3c7cb6f820a99b`（`%cI` = `2026-10-16T22:16:13Z`）。
> **测量时间**：`2026-10-17T12:14+08:00`（本地）。本节每条 `file:line` 均在该 blob 上逐文件复算，
> 行号为 `git show upstream/main:<path>` 的 1-based 行号；只登记事实与口径，不写修法。

1. **「每帖 ≤3 张」的权威计数器在 `real` 路径上不可得 ⇒ 该用途恒 503（既不是 201，也不是 400）**。
   槽位判定点是 `services/api/src/media/service.ts:645` 的 `attachmentLimitFor(actor, purpose)`：计数端口返回
   `null` 时，`services/api/src/media/service.ts:652` 抛 `ApiError('PROVIDER_UNAVAILABLE', ...)`
   （`:653-654` 明写「retryable 必须为 false」）⇒ 503。未显式注入时 `real` 取 `createUnwiredAttachmentCounter()`
   （`services/api/src/media/service.ts:526-528`），其 `countFor()` 恒返 `null`
   （`services/api/src/media/service.ts:293-299`；`:296` 自述「拒绝 community_image 上传（fail-closed）」）。
   生产装配**没有**从 env／配置注入计数器的路径，只能由调用方选项透传
   （`services/api/src/app.ts:1047`；`:1041` 是对象存储端口 —— 两者是**两个独立端口**，注入前者不解后者）；
   同处还有整域闸门：`real` 下 `createAppMediaService` 必须收到显式批准能力，否则整域 503
   （`services/api/src/app.ts:1036-1039`）。
   ⇒ 现状：`stub`／`preset_demo` 走替身计数器（`countFor()` 直接返回存活社区图片数，
   `services/api/src/media/service.ts:282-290`）⇒ 第 4 张 400（即 §5 输出里 `:121` 那条用例）；
   `real` 下该用途**恒 503**，与 §9 第 3 条「`real` 下未接线即拒绝该用途」一致，**不是**「≤3 张已生效」。
   复现：`git grep -n "计数器未接线" upstream/main -- services/api/src/media/service.ts` ⇒ **1 处命中（`:652`）**。
2. **媒体域与识别／合成域各持一套「按域」媒体端口，两套从未互接**。媒体域实例在
   `services/api/src/app.ts:1041-1042`（`mediaObjectStore` → `createAppMediaService`）；识别域的媒体引用端口在
   `services/api/src/app.ts:834`（`media: recognitionMedia ?? createRecognitionMediaPort(config.executionMode)`），
   合成域在 `services/api/src/app.ts:873`（`media: synthesisMedia ?? createSynthesisMediaPort(config.executionMode)`）——
   两处都只**按执行模式新建**，不接收也不引用媒体域的服务或对象存储。
   `services/api/src/recognitions/media.ts:16` 文件头逐字自述：「本文件这套**按域**媒体引用端口并未改接媒体域：
   `real` 下仍由 `createUnwiredMediaPort` 承担」；同文件 `:17-21` 说明该端口只在受理函数的媒体校验步骤被触达，
   `real` 缺供应商凭据时**先**返回 503，只有供应商判定可用时才轮到该端口 ⇒ 409 `OBJECT_UNAVAILABLE`。
   复现：`git grep -n "createRecognitionMediaPort\|createSynthesisMediaPort" upstream/main -- services/api/src/app.ts`
   ⇒ **2 处命中（`:834`／`:873`）**（`services/api/src/app.ts:60`／`:64` 为导入行，不计）。
   ⇒ 上传面即使接线成功，也**不构成**识别／语音／TTS 可用的证据：三个消费域与本域不共享任何媒体事实。
3. **生命周期清扫有机制、无生产触发点**：本片点到的 `expireInitiated()` 与 `cleanupOrphans()` 在全生产面
   **零调用点**，24h 过期回收与失败／取消后的孤立对象回收**在运行时永不发生**（只在测试里被直接调用）。
   本节实测（命中数按命令输出计数）：

   - `git grep -n -E "expireInitiated|cleanupOrphans" upstream/main -- services/ packages/ apps/ tools/ miniprogram/`
     ⇒ **11 处命中**，全部是接口声明（`services/api/src/media/service.ts:238`／`:245`）、`real` 替身实现（`:479`／`:482`）、
     真实实现（`:1123`／`:1134`）、注释（`:569`／`:587`）与 `packages/media/service.mjs` 的定义／导出
     （`:520`／`:536`／`:572`／`:573`）——无一处调用；
   - `git grep -n -E "\.(cleanupOrphans|expireInitiated)\(" upstream/main` ⇒ **9 处命中，全部在 `tests/`**
     （`tests/media/lifecycle.test.mjs:141`／`:146`、`tests/unit/media-http-upload.test.mjs:407`／`:410`／`:437`、
     `tests/unit/media-http-access.test.mjs:248`／`:278`／`:285`／`:348`）⇒ **生产代码 0 处**；
   - `git grep -n "setInterval" upstream/main -- services/api/src` ⇒ **0 处命中（exit 1）**；`services/api/src` 内
     `setTimeout` 共 16 处，全是请求级超时／重试等待（如 `services/api/src/auth/wechat.ts:95`、
     `services/api/src/ocr/service.ts:610`、`services/api/src/recognitions/service.ts:533`），**无周期调度器**。

   `services/api/src/media/service.ts:1108` 的注释标题「过期与清理」只是能力入口的分段线，不是触发点。

**与 §10 所记裁定的口径差异（不追改历史）**：§10 记的「2026-10-14 监工对 #121 的 P1 裁定」要求
`retryable: true`；现行代码按 `services/api/src/errors.ts:32`／`:35` 收敛为 `false`，断言见
`tests/unit/media-real-mode-fail-closed.test.mjs:949`。该裁定原文、§2 的 2026-10-14 探针输出与 §11 的批复原文
**均按原样保留**；本片只在 §5 断言清单就地订正，见本文件 `:165` 起。

## 9 剩余风险与已知缺口

1. **媒体记录不持久**：进程重启即丢；`real` 模式下已被 fail-closed 挡住，但 `stub`/`preset_demo`
   与测试之外的任何「准生产」用法都应视为不可用。持久化实现（PG + 行版本 CAS）属后续接线。
2. **owner 私有媒体字节读取在契约内没有对应 operation**：契约只签发短效句柄（`AccessGrant.url` 为 https，本仓库占位域 `media.gengyun.local`），字节读取由部署期访问网关承担；契约内唯一返回二进制的 operation 是 `GET /community/media/{grant_id}/content`，只服务社区公开已审上下文，不能用于 owner 私有媒体 ⇒ **客户端经契约取不到私有媒体字节**（复现：`GET /api/v1/media/{id}/content` ⇒ 404「未实现的路径」）。
   若监工认为需要 API 侧网关端点，那属于**扩展冻结契约**，须先走契约变更流程。
3. **「每帖 ≤3 图」的判定点**：冻结契约的 `UploadInput` 没有帖子上下文，真正的「每帖」判定在
   **附件挂载**（社区线 GY-I15）。本片用「同一 owner 名下存活的 `community_image` 计数」作为
   **保守替身**（`real` 下未接线即拒绝该用途），已在源码与对照表中显式标注为保守替身。
4. **同键并发**：本片用**同步占位 + 409 `REQUEST_IN_PROGRESS`（带 `Retry-After: 1`）**收敛，
   与本仓既有幂等口径一致；这是「拒绝第二个」而非「有界等待后回放」。若监工要求后者，
   需与服务层语义一并复核。
5. **`packages/media/service.mjs` 与本片服务层并存**：两处都实现同一状态机。本片逐字复用其
   校验/嗅探/EXIF/时长/句柄原语，语义一致性由「同一批原语」保证；但**状态机与授权逻辑确实有两份**。
   若要收敛为一份，需把 `packages/media` 的存储端口改成异步 —— 那是对已合并文件的改动，
   本片按纪律**未做**，留待监工裁决。

## 10 依据

- [#6](https://github.com/GengYunChuChao/GengYun/issues/6)（范围与验收）、`docs/implementation-requirements.md` F05/F12/F13/F15/F16、
  `docs/architecture/state-contract.md`「媒体及 AI 任务」、
  [packages/media/README.md](../../packages/media/README.md)（模块既有边界与返修记录）。
- 监工对 #121 的 P1 裁定：`real` 且真实存储/持久端口未接线 ⇒ 必须 `PROVIDER_UNAVAILABLE`（503，`retryable: true`），
  不得用内存/替身实现返回成功封套；替身只允许出现在**明确标注**的 `stub`/`preset_demo` 路径。

**`Refs #6`（不关闭整项）**：真实对象存储、网关、真机、微信工具与持久化删除闭环均未验收。

## 11 返修记录：删除失败后的可重试性（监工批复 P1，2026-10-14）

监工（组织 App `gengyun-supervisor[bot]`）给出的 **CHANGES_REQUESTED** 原文（逐字）：

> **P1：`services/api/src/media/service.ts` 的 `dropObjects` 吞掉 `deleteObject` 异常/false 后仍无条件清空 `rawRef/derivativeRef`；`deleteMedia` 随后把记录置 `deleted`。对象存储一次暂时失败会留下私人对象，却永久丢失清理引用，`cleanupOrphans` 无法重试。** 监工隔离 checkout 用合成字节+替身端口仅一次故障探针实证：删除返回 202、state=deleted、两引用=null；恢复端口后 `cleanupOrphans removedObjects=0, remainingObjects=1`。**这影响本片承诺的失败/取消孤立对象回收与隐私删除，不属于测试写法或未承诺优化。请保留失败对象引用/可重试状态，未确认删除不得丢失重试依据……**

**确认成立、已修**。修复（`services/api/src/media/service.ts` + 端口语义 `object-store.ts`）：

1. `dropObjects` 改为**只对「已确认删除」的引用置空**：端口返回 `true` ⇒ 清空该引用并计数；
   **抛错或返回 `false` ⇒ 保留该引用**，计入 `pending`，绝不丢弃重试依据。
2. 端口契约 `deleteObject` 的返回值语义被写明：`true` = 已确认删除（含幂等删除「对象本就不存在」，
   与 S3 `DeleteObject` 的 204 一致）；`false` = **未能确认**；抛出 = 暂时失败。后两者调用方必须保留引用。
   替身存储改为**幂等删除**（键不存在也返回 `true`），真实适配器在非 2xx/404 时改为**抛错**而不是静默返回 `false`。
3. `deleteMedia` 不再因「状态已是 `deleted`」而跳过回收：**重复删除也会重试**（同源路径）。
4. `cleanupOrphans` 新增 `pendingObjects`（仍未确认删除的引用数）与 `remainingObjects`（清扫后桶内对象数），
   让「删不掉」可观测，而不是被静默吞掉；`rejected` / `deleted` 记录一律可反复重试。
5. 对外语义**未放宽**：删除仍返回 202 `{accepted:true}`，记录仍置 `deleted`（监工明示可保持）。
   放宽断言、把未确认删除当成功的行为一律未采用。

**改前 / 改后原始输出**（同一个探针：合成字节 + 替身端口 + **仅一次** `deleteObject` 故障；
`git checkout -- services/api/src/media/service.ts` 得到「改前」= HEAD 版本，随后从备份还原并核对 SHA-256 一致）：

```
########## 改前（HEAD 版本）##########
completeUpload        → 202 state=ready | objects = 2
deleteMedia           → 202 {"accepted":true}
getMedia after delete → 200 state=deleted
refs after failure    → rawRef=null derivativeRef=null          ← 引用被无条件清空（缺陷）
objects after delete  → 1 (1 = 有一个对象本次未能删除)
cleanupOrphans        → removedObjects=0 revokedGrants=0 remainingObjects=1   ← 复现监工那组数字
refs after cleanup    → rawRef=null derivativeRef=null

########## 改后（本地修复）##########
completeUpload        → 202 state=ready | objects = 2
deleteMedia           → 202 {"accepted":true}
getMedia after delete → 200 state=deleted
refs after failure    → rawRef=obj_bByFxHoVziwupbvYQbEtnlXk derivativeRef=null   ← 重试依据保留
objects after delete  → 1 (1 = 有一个对象本次未能删除)
cleanupOrphans        → removedObjects=1 revokedGrants=0 pendingObjects=0 remainingObjects=0
refs after cleanup    → rawRef=null derivativeRef=null
```

改前 `removedObjects=0` / `remainingObjects=1` 与监工探针**逐数字一致**；改后为
`removedObjects=1` / `pendingObjects=0` / `remainingObjects=0`，且未确认删除的引用在清扫前始终保留。

**针对性验证**（`tests/unit/media-http-access.test.mjs` 新增 3 条，均在 `node --test "tests/unit/media-*.test.mjs"` 中通过）：

| 用例 | 覆盖 |
| --- | --- |
| 返修 P1：删除时端口一次暂时失败 ⇒ 引用保留；端口恢复 ⇒ cleanupOrphans 真正删除 | 抛错型故障：删后引用仍在、桶内剩 1；清扫 `removedObjects≥1` / `pendingObjects=0` / `remainingObjects=0` 且引用清空 |
| 返修 P1：端口持续返回 `false`（未能确认）⇒ 引用与待清理计数保留，恢复后才清空 | `false` 型故障：清扫中如实报 `pendingObjects=1` / `remainingObjects=1` 且**引用仍在**；故障耗尽后重试成功 |
| 返修 P1：重复删除（已是 deleted）仍会重试回收；completeUpload 失败回收走同一原则 | 同源路径：状态已 `deleted` 时再次 DELETE 真正回收；`completeUpload` 失败回收失败后引用保留、`cleanupOrphans` 可重试 |

**未取得项不变**：真实对象存储、访问网关、持久化媒体记录、真机、微信工具与供应商音频适配仍未验证；
监工未验收，本片**不关闭 #6**。

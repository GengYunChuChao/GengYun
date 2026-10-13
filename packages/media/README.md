# packages/media · 私有媒体上传、访问权限与 EXIF 清除（GY-I06 / #6）

纯 ESM 模块，**零第三方依赖**（仅用 Node 内置 `node:crypto`、`node:zlib`），Node 24 可用。枚举、限额与
错误码只读消费 `packages/contracts/states.json` / `openapi.json`（契约 1.0.0），本模块是
前后端一致的**媒体域唯一事实来源**。

覆盖冻结契约（`packages/contracts/openapi.json`）：

| 操作 | 路径 | 说明 |
| --- | --- | --- |
| `createUpload` | `POST /media/uploads` | 按用途限制真实类型/字节/时长，返回 private 上传句柄 |
| `completeUpload` | `POST /media/uploads/{id}/complete` | 验魔数/hash/字节/解码/EXIF，异步处理至 `ready` |
| `getMedia` | `GET /media/{id}` | 仅 owner 读私有元数据，非本人统一 404 |
| `deleteMedia` | `DELETE /media/{id}` | 归属/版本检查后 `deleting → deleted` |
| `grantMediaAccess` | `POST /media/{id}/access` | 仅 owner 短效访问句柄，If-Match 为媒体 revision |
| `grantCommunityMediaAccess` | `POST /community/media-access` | 登录读者基于公开已审内容上下文取图 |
| `readCommunityMediaContent` | `GET /community/media/{grant_id}/content` | 取图逐次重查内容/媒体当前版本 |

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `constants.mjs` | 冻结枚举 + 每用途限额 + 状态机 + `error_status_map`（与 contracts 逐项一致） |
| `errors.mjs` | `MediaError` + `toErrorEnvelope`（与 services/api 的 ErrorEnvelope 同形） |
| `detect.mjs` | **魔数探测**：jpeg/png/webp/mpeg/wav/aac（不信扩展名/声明 MIME） |
| `exif.mjs` | 图片元数据**结构性段清除**（JPEG App1 Exif/XMP+App13、PNG eXIf/tEXt/iTXt/zTXt、WebP EXIF/XMP）；**严格容器结构校验**：拒绝无图像数据、截断与「结束标记之后的尾部字节」；PNG 须可解压且**逐行滤波类型字节合法**（E3）；WebP 须**真实解码 VP8L**（E2） |
| `webp.mjs` | **VP8L 无损位流真实解码器**（纯 ESM、零依赖）：位流头 → 变换/子图流 → 颜色缓存 → 前缀码（meta-Huffman）→ LZ77 回引 → W×H 像素；任何非法/越界构造 fail-closed |
| `audio.mjs` | 音频容器/帧时长解析（WAV/ADTS/MPEG/M4A）；M4A 逐块核对 `stsc`、`stsz`、`stco`/`co64` 与音频描述及 `mdat` 范围；不解码 AAC 等音频编码负载 |
| `validate.mjs` | 声明与真实字节校验（用途/类型/字节/**真实时长**/hash/伪扩展名/每帖 3 张） |
| `tokens.mjs` | HMAC 短效句柄签名（token 不入 URL；服务端只存 hash） |
| `store.mjs` | 私有对象存储（内存参考实现，可插拔真实对象存储；对外只出**不透明 object_ref**） |
| `local-store.mjs` | 私有本地文件适配器；只存字节，专用根目录与OS权限前提见下文；不是COS或HTTP授权网关 |
| `service.mjs` | 服务：生命周期、owner 访问、社区取图、过期与孤立对象清理 |
| `index.mjs` | 统一出口 |

## 本地文件及新增传输契约（部分交付）

`createPrivateLocalObjectStore({ rootDir })` 可注入现有服务 store，真实字节写入专用私有目录并可由新适配器读取；元数据/幂等仍为参考内存实现。不要将存储目录作为静态目录公开或放入Git；本地对象放已忽略`.local/`或`.supervisor/`下，由服务端配置根目录，不接受用户路径。Windows须由操作者配置受限ACL，组件不将0600模式宣称为已落实Windows权限。

OpenAPI增补PUT上传字节及owner GET内容两条私有传输操作，现有DTO不变；本次只有契约、文件组件与合成回归，没有实际HTTP接线。权限、300秒token、用途epoch、版本及回收仍须由下一份PG/HTTP组件落实，参考示例URL不是HTTP成功。[ADR](../../docs/architecture/adr-gy-i06-local-private-transport.md)与[证据](../../docs/verification/gy-i06-private-file-contract.md)记录边界；COS、正式微信/Android及完整7/30日删除未完成。

## 状态机（`docs/architecture/state-contract.md`）

```
initiated → uploaded → processing → ready
任一非删除状态 → rejected
任一非删除状态 → deleting → deleted
```

`ready` 仅表示**可处理**，不等于公开。图片在 `processing` 阶段去 EXIF 后生成**去元数据衍生件**，
对外只提供衍生件；原始对象保留为私有参考。音频不产生衍生件。

## 每用途限额（state-contract「媒体及 AI 任务」）

| 用途 | 真实类型 | 上限 | 时长 |
| --- | --- | --- | --- |
| `weed_recognition` / `label_ocr` | jpeg/png/webp | ≤2 MiB | — |
| `voice_question` | mp3/wav/aac | ≤10 MiB | ≤60 秒 |
| `community_image` | jpeg/png/webp | 每张 ≤5 MiB、每帖 ≤3 张 | — |

全局上限 = `UploadInput.bytes.maximum` = 10 MiB。

## 与契约字段对照

| 本模块 | 契约来源 |
| --- | --- |
| `MEDIA_PURPOSES` | states.json `MediaPurpose` |
| `MEDIA_STATES` | states.json `MediaState` |
| `MEDIA_PURPOSE_MIME` | `UploadInput.mime` 枚举（按用途子集） |
| `MEDIA_MAX_BYTES` / `MEDIA_MAX_DURATION_MS` | `UploadInput.bytes.maximum` / `duration_ms.maximum` |
| `ERROR_STATUS_MAP` | states.json `error_status_map` |
| `toMedia()` 投影 | `Media.required`（**不含** object_ref/owner） |

## 数据库：**本任务不新增迁移**

媒体相关表与枚举（`media`、`media_derivatives`、`content_media_refs`、`community_media_grants`、
`media_purpose`、`media_state`、`media_slot`）已由 **GY-I02 的 `0001_initial_schema.sql`** 冻结。
本模块只消费该结构；一致性由 `tests/media/schema.test.mjs` 断言（枚举、列、CHECK、
300 秒 TTL）。生产部署须以对象存储适配器 + 单事务/行版本 CAS 实现同一 `commit` 契约（同 GY-I27）。

## services/api 挂载示例（媒体 HTTP 路由尚未接线）

`service.mjs` 是**纯模块**，不直接改 `services/api/src/app.ts`（该文件归 GY-I02）。
认证与授权组件已通过 PR #59、#61、#63 合并；媒体模块仍须由服务端会话层注入身份并挂载路由。
以下仅为接线示例，不代表已运行的 HTTP 接口：

```js
import { createMediaService } from '../packages/media/service.mjs';
// session 提供者由 GY-I04 会话层注入：从会话/DB 读 { ownerId, authEpoch }
const media = createMediaService({ tokenSecret: process.env.MEDIA_TOKEN_SECRET, contentProvider });

app.post('/media/uploads', { preHandler: attachSession }, async (req) =>
  media.initiateUpload({ ownerId: req.userId, authEpoch: req.authEpoch, input: req.body, idempotencyKey: req.headers['idempotency-key'] }));
// GET /media/{id}、POST /media/{id}/access 仅 owner；社区取图走 /community/media-access
```

- 身份上下文 `{ ownerId, authEpoch }` 由调用方注入；**未注入即 401 `SESSION_REQUIRED`**——
  这是替身占位，不代表已接入微信真实登录态。
- `contentProvider.getPublishedContent()` 默认**关闭**（返回 null），社区取图在未注入公开内容
  提供者时统一 404，避免误放行。
- 单元测试注入合成账号与内存 store/内容提供者，**不依赖微信真实登录**，避免与 GY-I04 形成依赖循环。

## 依赖与缺项

- 前置工程与隐私组件已合入（复用 `packages/privacy/redact.mjs` 做日志脱敏），GY-I04/#4、GY-I27/#29 的完整 issue 验收仍未完成。
- PR #59、#61、#63 已提供认证与授权组件；本媒体 PR 仍使用合成身份和内存替身，未提供真实登录态下的媒体 HTTP 验收证据。
- **GY-I25 供应商适配**：音频编码/采样率与真实 ASR 供应商约束的“真实核实”依赖 GY-I25；
  本模块只按契约枚举核验，不把产品限额冒充官方接口限制。
- 对象存储、CDN、访问网关为部署期接线；本模块提供内存参考实现与适配接口。
- **WebP 覆盖边界（返修 E2，受控 fail-closed）**：本模块零依赖，仅内置 **VP8L（无损）** 真实解码器，
  因此**只接受可真实解码的无损 WebP**；**有损 WebP（VP8）与动画 WebP（ANIM/ANMF）受控拒绝**。
  这是「无法核验即拒绝」的有意取舍 —— 若要放开有损/动画支持，需引入标准解码库
  （如 libwebp 绑定）作为依赖，属**变更依赖形态**，须先经维护者确认。

## 边界（不实现）

- 不实现微信登录/会话（GY-I04）；不实现社区帖子与审核（GY-I14 / GY-I15）——`contentProvider` 由上层注入。
- 不做像素级重编码净化：EXIF 清除为**结构性段清除**，保留压缩数据，不声称重编码级净化。
- 实库事务/对象存储事务性由部署方实现；内存实现不等价于实库验收（同 GY-I27 口径）。

## 硬红线落实

- **不信扩展名/声明 MIME**：完成上传以魔数 + hash + 字节数 + 用途核验；伪扩展名（声明与真实不符）→ 415。
- **对外字节全部经过校验与清理（返修 B1）**：JPEG/PNG/WebP 均**逐块重建**输出，绝不回退返回原始输入；
  容器结束标记（PNG `IEND`、JPEG `EOI`）之后**不得有尾部字节**，WebP 必须与 RIFF 声明长度一致；
  无图像数据（仅 PNG 签名 / 仅 JPEG SOI / WebP 无 VP8* 块）或结构截断 → 拒绝。
- **音频真实时长以字节为准（返修 B2）**：由 `audio.mjs` 按有效编码解析真实时长并参与上限判断；
  无法解析、真实时长 > 60s、或声明与真实偏差超容差 → 受控拒绝；投影中的 `duration_ms` 为**真实值**。
- **完成接口幂等重放（返修 B3）**：幂等键的请求 hash **包含原 `If-Match`**；同请求重放（含原 `If-Match`）
  回放首次成功结果而非 409；同键改请求（改 `If-Match`/正文）→ `IDEMPOTENCY_CONFLICT`；重放前**重新鉴权**。
- **非本人统一 404**：`getMedia` / `grantMediaAccess` 对非 owner 与不存在同形，不泄露存在性。
- **短效句柄 ≠ 公开权限**：token 不入 URL、服务端只存 hash、每次取图重查账号/授权/媒体/内容当前版本；
  内容下架、媒体删除、版本变化、会话失效均即时拒绝（即使未到期）。
- **私有对象不外露**：公开投影只含契约字段；日志经 `redactForLog` 脱敏，不含对象引用/字节。
- **容器结构校验（返修 B1/C2/D3/E3）**：PNG 的 `IDAT` 须可真实解压、解压长度**精确等于** IHDR 期望、
  且**逐行滤波类型字节 ∈ 0..4**（E3，支持非交错与 Adam7）；解压受预算约束（解压前按 IHDR 限尺寸、
  解压中 `maxOutputLength` 强制上限），杜绝高压缩比炸弹。
- **「结构形状」≠「可解码内容」（返修 E2）**：WebP 的 VP8L 位流必须由 `webp.mjs` **真实解码**并恰好产出
  「仅 5 字节位流头、无像素位流」的空壳（44 字节）一律拒绝；VP8（有损）与动画（ANIM/ANMF）
  因本模块**不具备核验其真实内容的解码能力**，按 fail-closed **受控拒绝**。
- **音频样本表边界**：M4A 的 `mdat` 负载必须非空；`stts` 条目须完整（绝不回退信任 mvhd），累计样本数等于 `stsz.sample_count`。
  `stsc` 的递增 run 从首块 1 开始，逐块消费定长或变长样本，引用存在的音频描述；所有完整块范围须在已定位的 `mdat` 内且不重叠。
  缺表、截断、零长样本、计数不符或不安全整数均拒绝，失败上传回收对象。
  这是容器与样本定位验证，不证明合成 `mdat` 字节或真实 AAC 可解码；多 `mdat`、分片 MP4 未作为支持范围验收。
- **VP8L 变换唯一性**：同一主图中每种变换最多一次，重复类型在读取参数前拒绝；合法单次变换仍可通过。
  依据 [WebP 官方位流规范](https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification#4-transforms)。
  M4A 映射依据 [Apple sample-to-chunk table](https://developer.apple.com/documentation/quicktime-file-format/sample-to-chunk_atom/sample-to-chunk_table)。
- **不把请求当完成**：`completeUpload` 未通过核验即 `rejected` 并回收对象；`initiated` 超 24h 过期回收；
  `rejected`/`deleted` 对象与句柄统一清理。

## 验证（本地：Node 24.16.0）

```
node --test "tests/media/*.test.mjs"
```

合成夹具覆盖：魔数探测、JPEG/PNG/WebP 去元数据（含 GPS）、**PNG IEND 后尾部走私 / JPEG EOI 后尾部 /
无图像数据 / 截断（B1）**、伪扩展名 415、超限 413、**音频真实时长：虚报 / 真实超时长 / 截断（B2）**、
**完成接口幂等原样重试回放与改请求冲突（B3）**、**PNG 解压预算与滤波字节校验（D3/E3）**、
**WebP VP8L 真实解码与「无像素位流空壳」拒绝（E2）**、**M4A 样本表一致性与空 mdat 拒绝（E1）**、
幂等与幂等冲突、If-Match 428/409、非本人 404、社区取图授权与撤销、过期回收、孤立对象清理、日志脱敏、
schema 与契约一致性。
**这些是模块级单元证据，不等于真实登录/对象存储/供应商验收。**

`chunk-transform-boundaries.test.mjs` 补查完整样本范围、定长/变长、多块/多 run、`co64`、描述索引、溢出、重叠与失败回收，
并保留合法 VP8L 及单次 SUBTRACT_GREEN 正例。独立 Pillow/libwebp 的完整加载结果另记录在 PR 中。
真实对象存储/网关、媒体 HTTP/PG 事务、第三方适配、Android/iOS 真机及 7/30 天删除闭环仍未验收。

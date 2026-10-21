# R28-W2：媒体域真实对象存储端口接线（证据页）

- 片号：GY-R28 · W2
- 分支：`feat/gy-r28-w2-media-ports`，基点 `f5cca8b`
- 提交：`544616d`（装配层）／`f1ccdc5`（owner 私有读）／`a03d4e7`（正向读数 + 拒绝闭集 + 两处判据加强）
- 编写：实施代理 W2 的读数由指挥整理成本页（原始汇报含逐条命令输出）

## 0. 性质口径

本片只做四件事：**对象存储端口接线点**、**上传三段式的 real 路径**、**EXIF 剥离与衍生物**、**服务层内部的 owner 私有字节读**。

⛔ 不含：持久化转 PG（第 4 步判完未动，见 §6）、TTS/OCR/ASR 的 `checked_content` 端口（另一片）、真实云桶与 TLS 往返、对外暴露 owner 字节读的契约面。

## 1. 断点

接线前，`real` 模式下媒体域**整域 503**：`buildApp` 的媒体端口只来自显式注入，生产启动路径从不注入真实端口（源码注释自述「应用装配路径永不注入真实适配器端口」），因此 `POST /api/v1/media/uploads` 在 `real` 下必落 `PROVIDER_UNAVAILABLE`。

## 2. 形态

- 装配点在 **`services/api/src/media/real-ports.ts`**，由 **`services/api/src/server.ts`**（进程启动点，不在 tsc 审计树内）构造后注入；`buildApp` 侧的「端口只能来自显式注入」结构断言**保持锁死**。
- **`--approve-real-media-wiring`** 是唯一显式决定点；批准能力 `approveRealMediaWiring`（non-defaultable 品牌 WeakSet）**只在 `resolveMediaRealPorts` 内铸造一次**，不从 env／选项／原型链派生。
- 配置搬运：`config.ts` 直接暴露媒体域**自己已解析**的 `objectStorage`（复用 `media/object-store.ts#readObjectStorageConfig`，不重写判据）与 `mediaAccessGrantOrigin`（+31 行）。
- 临时密钥 `X-Amz-Security-Token`：`OBJECT_STORAGE_SESSION_TOKEN` 走既有 `readObjectStorageConfig` 通道进 S3 适配器，**只存内存**，不进日志、不进证据页。
- 刻意**没有**给 `MediaObjectStore` 接口加 `probe()`：那会平移 `contract-status.json` 里 `media/object-store.ts` 的锚点。

### 拒绝闭集（6 条，扩张即红）

| # | 条件 | 对外码 |
|---|---|---|
| 1 | 模式非 `real` | `PROVIDER_UNAVAILABLE`／`retryable:false` |
| 2 | 四键不齐 | 同上 |
| 3 | 网关原点不可部署 | 同上 |
| 4 | 批准未铸造 | 同上 |
| 5 | 端口 `kind ≠ s3_compatible` | 同上 |
| 6 | 持久化口径不支持 | 同上 |

## 3. 正向读数（loopback 桶替身 + 真实适配器 + 真实 `buildApp`）

| 步骤 | 读数 |
|---|---|
| `POST /api/v1/media/uploads` | **201**；句柄 host = `storage.example.test`；`X-Amz-Signature` 为 64 位 hex（签名真实） |
| 客户端 PUT（真实写路径落桶） | `x-amz-content-sha256: UNSIGNED-PAYLOAD`；`content-type: image/jpeg`；**77 B** |
| `POST /media/uploads/{id}/complete` | **202**（契约码本身就是 202 Accepted，**不是 200**，勿误读为缺陷）；`state=ready`、`revision=2` |
| EXIF | 原始 77 B：`Exif=true`、`GPS=true`；衍生物 36 B：`Exif=false`、`GPS=false`（`stripImageMetadata` 生效） |
| 对象引用 | `rawRef=obj_FSA2OhHlloC-2fHTestP8zEF`、`derivativeRef=obj_OtOZSiINKm7iflq11M2sV-gj`（两个不同对象，桶内 2 个键） |
| 内部 owner 读 | `readOwnerMediaContent` → 200、`source=derivative`、36 B、**逐字节等于衍生物**；非 owner ⇒ `NOT_FOUND` |

## 4. 负控制

同样完整的真实 env（四键 + 网关原点 + `real`）但 **argv 不给 `--approve-real-media-wiring`** ⇒ 端口 `kind=unwired`、`POST /media/uploads` → **503 `PROVIDER_UNAVAILABLE`、`retryable:false`**；`server.ts` 零参数时**一个媒体选项都不传**。既有 fail-closed 守卫 `tests/unit/media-real-mode-fail-closed.test.mjs` **20/20 全绿**（含「零注入与 main 一致」类断言）。

## 5. 两处既有判据的改动（只加强，非放宽）

1. **`tests/unit/media-real-mode-fail-closed.test.mjs`「唯一显式注入来源」**
   - 改前：`resolveMediaObjectStore` 调用点必须是 **1 处**（断言「生产码里不存在真实端口装配点」）
   - 改后：允许 **2 处闭集**（`app.ts` 1 处 + `media/real-ports.ts` 1 处），同时**新增**三条更强的钉子——`approveRealMediaWiring` 调用点恰好 **1 处**、`app.ts` 只允许 `resolveMediaObjectStore({ executionMode })` 这一种带参形式、闭集外任何新调用点即红
   - 理由：本片任务正是补那个装配点，只把 1 改成 2 是退化；故改成「点名两处 + 参数形状 + 铸造点唯一」的更强形状
2. **`tests/unit/profile-log-redaction.test.mjs`**
   - 改前：`server.ts` 的 `buildApp({ config, pool })` 逐字钉子
   - 改后：`{ config, pool }` **+ 恰好一处** `...(mediaAssembly ?? {})`，并追加 `mediaRealPortsAssemblyOptions(` 恰好 1 次、`buildApp(` 恰好 1 次
   - 主旨（生产入口不进 `logStream`）不变，实参集合收得更死

## 6. 第 4 步（持久化）的判定与实测修正

- 判定：4 个进程内 Map/Set 在**单进程生命周期内**（含 24h `initiated` TTL）不破坏「上传 → complete → 读」；只在**重启后**丢链路。因此**未转 PG**，改为 `real` 模式下**显式拒绝** `persistence_unsupported`（`MediaPersistenceMode='process_memory'`，**不伪装已持久化**）。
- **实测修正（重要）**：本机 PG 17 全新库跑满 26 个迁移后，`media`／`media_derivatives`／`content_media_refs`／`community_media_grants` **四张表早已存在**（`media` 与 `media_derivatives` 出自 `0001_initial_schema.sql:171/192`）。⇒ 第三层**不需要新迁移号**（`0027` 仍空闲，勿凭印象写）。
- 真正缺的是：PG 仓储 + `media.object_ref_cipher` 的加密键接线 + 幂等表落库 + `app.ts` 装配（受结构断言约束）。工作量远大于「加两张表」，建议单独一片。

## 7. 未取得

1. **真实云桶 / TLS**：只有 loopback 替身（保留域 `storage.example.test`；TCP、HTTP 帧、预签名、body 字节全真，仅主机名映射是替身）。真实云桶的凭据与签名往返、临时密钥 `X-Amz-Security-Token` 的服务端接受度均未验证。
2. **部署参数**：`deploy/**` 按红线未动 ⇒ 生产 real 启动若真要接线，部署侧必须显式加 `--approve-real-media-wiring` 并配齐 `OBJECT_STORAGE_*` 与 `MEDIA_ACCESS_GRANT_ORIGIN`，否则启动即被拒（如 `access_grant_origin_not_deployable`）。
3. **`checked_content` 端口**：TTS/OCR/ASR 的内容审核端仍非 real（W1 只接了提供者），属另一片。
4. **owner 字节读无外部出口**：当前只有服务层内部函数；若要对外暴露，需先补契约 operation（85 路径之外），属契约片。

## 8. 复现命令

```bash
npm run lint
# 媒体逐文件（逐条真跑）
node --test tests/unit/media-attachment-limit.test.mjs
node --test tests/unit/media-consent-wiring.test.mjs
node --test tests/unit/media-grant-origin-assembly.test.mjs
node --test tests/unit/media-grant-url-origin.test.mjs
node --test tests/unit/media-http-access.test.mjs
node --test tests/unit/media-http-upload.test.mjs
node --test tests/unit/media-object-store-s3-paths.test.mjs
node --test tests/unit/media-real-mode-fail-closed.test.mjs      # 20/0
node --test tests/unit/media-real-ports-wiring.test.mjs          # 2/0（新）
node --test "tests/media/*.test.mjs"
npm run test:unit                                                # 3377 tests / 3376 pass / 0 fail / 1 skipped
# 真库（PG 17，端口 55611，临时集群跑完即停并删目录）
GY_PG_BIN=E:/GengYunCommander/.pg17/pgsql/bin npm run db:migrate  # 26 个迁移全绿
```

## 9. 抖动与真红的如实记录

`npm run test:unit` 首跑出现过 3 条红：`local-dev-package`、`local-profile-bootstrap` 单跑各自通过、次跑全量即绿 ⇒ 判为负载抖动；`contract-status-anchors` 是**真红**（新代码插在 `service.ts` 中部导致 3 个锚点行号位移），已改为「追加到文件末尾」修复，`contract-status.json` **未改**。

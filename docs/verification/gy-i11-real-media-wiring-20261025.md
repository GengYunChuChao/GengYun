# GY-I11 · 受理阶段真实媒体端口接线与真实链路验收（2026-10-25）

> 状态：**部分交付（`Refs #11`，不 `Closes`）**。本文只记录**实测读数**；不构成本片之外的任何能力声称。
> 基线：`upstream/main` = `46dc7e0d07d73fd436b7b03e3546ad7136c8be84`（动手前 `git fetch upstream --prune` 复核，
> 与派单一致）。

## 1 本片关的卡点

`services/api/src/speech/media.ts` 的 `real` 分支此前恒为 `createUnwiredMediaPort()`：`POST /api/v1/speech/transcriptions`
在越过供应商闸门（503）之后**必然**落到媒体引用校验 ⇒ 409 `OBJECT_UNAVAILABLE`，转写任务根本建不出来。
于是「真实录音 → 受理 → 真实 ASR」这条链路在 `real` 下**一步都走不通**，与对象存储/ASR 是否可用无关。

## 2 改法（四道门，缺任一仍 fail-closed）

`real` 分支现在按**端口身份与既有裁决**判定，不接受任何自述布尔开关：

1. **对象存储端口必须是真实适配器**（`kind === 's3_compatible'`）。替身/未接线端口一律拒绝。
   产品装配里该端口**只可能**由 `--approve-real-media-wiring` + `OBJECT_STORAGE_*` 四键经
   `services/api/src/media/real-ports.ts` 的 `resolveMediaRealPorts` 铸造后显式注入。
2. **媒体域构造期裁决必须是「已打开」**（`AppMediaService.failClosedReason === null`）。媒体域的主闸门是
   `approveRealMediaWiring()` 铸造、`WeakSet` 品牌校验的批准能力；转写域**沿用**该裁决，不自行铸造、
   不重复解释配置 ⇒ 不会出现「媒体域拒绝、转写域却放行」的错位。
3. **媒体登记册端口必须存在**（`MediaStore`）。
4. 单次 `resolve()` 逐条校验：行存在 / `ownerId` 逐字相等 / `revision` 逐字相等 / `state === 'ready'` /
   用途属音频类 / `rawRef` 非空。任一不成立按既有闭集码拒绝（`NOT_FOUND` 与越权同形）。

边界（如实登记）：本端口**不取录音字节、不核 `sha256`**。字节与「长度 + sha256 必须与登记册逐字节一致」
由已交付的 `services/api/src/ai/asr-audio-source.ts` 在转写期完成（不成立即 `failed PROVIDER_UNAVAILABLE`、零发包）。
受理期再 `getObject()` 一次会把整段录音下载两遍（受理一遍、转写一遍），在计费桶上纯属浪费。

`app.ts` **一行未改**：端口从既有注入面（`speechAudioMedia`）与既有装饰（`app.mediaService`）派生，
`registerSpeechRoutes(...)` 的 8 个注入键逐字不变。

## 3 反向验收（不带启动参数 ⇒ 必须仍关闭）

装配：`real` + 真实 ASR 凭据 + 真实对象存储四键 + `MEDIA_OBJECT_REF_KEY` + 真实 PG（36 个迁移齐备）+ 已授予
`recording`/`media_processing`/`external_inference` 三个用途，**但不带** `--approve-real-media-wiring`。

| 读数 | 值 |
| --- | --- |
| `resolveMediaRealPorts(...)` | `null` |
| `app.mediaObjectStore.kind` | `unwired` |
| `app.mediaObjectStore.externalRequestCount` | `0` |
| 媒体域 7 条路由 | 全部 503 `PROVIDER_UNAVAILABLE`，`retryable=false`，无 `data` |
| `POST /api/v1/speech/transcriptions` | **409 `OBJECT_UNAVAILABLE`**，无 `data` |
| 转写域 `describe().mediaPort` | `unwired` |
| `describe().providerCalls` | `0` |
| 外呼计量（桶/ASR/其它） | 写 0 / 读 0 / 删 0 / ASR 0 / 其它 0 |
| 库侧 | `media=0`、`speech_jobs=0`、`transcriptions=0` |

⇒ **零字节写入真实桶**，且没有任何一次 ASR 请求。

启动参数侧的 fail-closed（真起 `services/api/src/server.ts`）：

| 启动形态 | 读数 |
| --- | --- |
| 带 `--approve-real-media-wiring` + env 齐备 | 进程起来，`GET /health` ⇒ **200** |
| 带参数但缺 `MEDIA_ACCESS_GRANT_ORIGIN` | **启动失败**，`exit=1`；日志 `access_grant_origin_not_deployable → PROVIDER_UNAVAILABLE, retryable=false` |
| 不带参数 | 进程起来，`GET /health` ⇒ **200**（默认装配与基线一致） |

## 4 正向验收（带启动参数 + env 齐备 ⇒ 全链路，仅 1 次真实 ASR 调用）

音频：**本地 SAPI TTS 合成语音**（`Microsoft Huihui Desktop`，zh-CN），重采样为 16kHz/单声道/16bit PCM。
⛔ 不含任何真人录音；转写文本来自供应商 `Result`，**不构成任何准确率或转写质量证据**。

| 步骤 | 读数 |
| --- | --- |
| 合成 WAV | `bytes=230184`、`seconds=7.192`、`sha256=cab930159f6682d6cf0522d350bfeb27e8f64fee1d315d73f2bf262b2333fc9f` |
| `POST /media/uploads` | **201**，`state=initiated`、`revision=1`；出口端口 `externalRequestCount=0`（预签名纯本地） |
| 直传真实桶（预签名 PUT） | **200**，`elapsed=351ms`，`bytes=230184`；host 为真实桶虚拟主机域，URL 带 `X-Amz-Signature` |
| `POST /media/uploads/{id}/complete` | **202**，`elapsed=219ms`，`state=ready`、`duration_ms=7192`、`revision=2` |
| 桶内回读自证 | `bytes=230184`、`sha256Match=true`、`byteEqual=true` |
| `POST /speech/transcriptions` | **202**，`state=queued`（**不再是 409**），`job=ea100c32-…` |
| 作业终态 | `succeeded`（`error_code=null`），受理→终态 `settleMs=1132` |
| **真实 ASR 调用** | **HTTP 200**、`elapsed=518ms`、请求体 `307080` 字节、响应 `156` 字节、**`RequestId=7116095a-5e28-4305-8dfb-cd84fbeb713f`** |
| 供应商 `Result` | `水稻田里的稗草已经长到3~5叶期，请问应该使用什么除草剂？` |
| `GET /speech/transcriptions/{id}` | **200**，`raw_text` 同上（29 字符），`model_version=tencent-sentencerecognition-2019-06-14` |
| 库 `media` 行 | `state=ready`、`purpose=voice_question`、`mime=audio/wav`、`bytes=230184`、`duration_ms=7192`、`revision=2` |
| 库 `speech_jobs` 行 | `state=succeeded`、`revision=3`、`error_code=null` |
| 库 `transcriptions` 行 | `raw_text` 29 字符、`model_version` 同上、`confirmed_text=null`、`revision=1` |
| 外发账本 `exports` | 1 行 `state=sent`（这一次真实外发） |

⇒ 「上传合成语音 → 受理 → 真实 ASR → 结果落库可查」在 `real` 下**首次跑通**，且**只打 1 次**、无重试。

### 4.1 前置夹具（如实登记，非产品路径）

要让请求落到媒体/转写这两片，本机验收另外需要三项**运维/夹具**前提（都属其它线，不是本片交付）：

1. `ai_enabled` 全局开关：经仓库唯一写面 `public.set_feature_flag(...)`（迁移 0020，同事务写审计）
   由 `false` 打开到 `revision=2`。**不打开时受理返回 409 `FLAG_CLOSED`**（与媒体验收无关的独立门）。
2. 用途授权三条：与仓库既有 PG 集成脚本同法（直接写 `consent_records` + `privacy_epochs`），
   并落一条 `capability='asr'`、`enabled`、`no_training_verified`、`deletion_verified` 的**合成接收方**
   绑到三个用途上（`privacy/ledger-pg.ts` 的 `resolveRecipient` 要求「唯一可用接收方」）。
   ⛔ 这不是 `POST /me/consents` 产品路径的验收（那需要已核验的 `consent_policies` 与 `recipients` 配置）。
3. 会话：`real` 的会话闸门要求持久存储，因此直接对真实 PG 签一份会话（不走微信登录，避免真实外呼）。

## 5 门禁读数（本片，实测）

| 门禁 | 末尾读数 |
| --- | --- |
| `npm run lint` | `lint 通过（静态检查；不代表运行期或真实服务已通过）。`（tsc×2 + 仓库卫生扫描全 PASS） |
| `npm run test:contract` | `tests 16 / pass 16 / fail 0` |
| `node --test` 定向（`speech-*`、`media-*`、`ai-live-provider-wiring`、`i11-*`、`runtime-strings-truth`、`idempotency-job-ttl`） | `tests 269 / pass 267 / fail 0 / todo 2`（两条 todo 是 `i11-audio-mp3-wav-guard` 的**既有**未修缺口，与本片无关） |
| `node tests/integration/speech-http.mjs` | `PASS 15 …`，exit 0 |
| `node tests/integration/transcript-confirm-http.mjs` | `PASS 6 groups …`，exit 0 |
| `node tools/verify-contract-status.mjs` | **exit 0**（4 条 speech 锚点纯行号漂移，已用 `--reanchor --write-doc` 落盘；未手工改行号） |
| `node tools/verify-doc-anchors.mjs --strict` | **exit 1 —— 与基线同形**：基线 `46dc7e0d` 在同一台机器上也是 `BROKEN 33 / OUT_OF_RANGE 6 / SUSPECT 68`、exit 1；本片红读数与基线**逐项相同**（唯一差异是非判红的「区间全是注释行」计数 652→656，因为 `routes/speech.ts` 多了 4 行注释） |

## 6 本片之后还差什么（真实链路的剩余断点）

1. **媒体元数据持久化口径**：`media/real-ports.ts` 的 `MediaPersistenceMode` 仍只有 `process_memory`
   （重启即丢句柄/幂等键）。本片验收在真库上跑通了 `media`/`media_derivatives` 两表的**写入**
   （`MEDIA_OBJECT_REF_KEY` 齐备 ⇒ `createPostgresMediaStore`），但 `MediaRealPorts.persistence` 这个
   自述口径还没升级成 `postgres`，属装配口径的诚实性收尾（不影响本片读数）。
2. **访问网关主机**：`MEDIA_ACCESS_GRANT_ORIGIN` 在本次验收里是**部署面占位**（`https://media.acceptance-i11.test`）。
   契约的 `AccessGrant.url` 读句柄指向该主机 ⇒ 真实读链路（客户端凭句柄取图/取音频）仍需部署期接一个可解析的网关。
   本片验收只消费**写**句柄（直传桶），**未取得**读句柄的端到端读数。
3. **转写任务经公共 Job 读面**：`GET /api/v1/jobs/{id}` 的转写作业源已在 #106 消费；本片只用
   `app.speechService.getJob` 与 `GET /speech/transcriptions/{id}` 读，未额外验证 `GET /jobs/{id}` 在
   真实 PG 上对该作业的投影。
4. **真实样本**：本片音频是**合成语音**，`docs/evaluation/sample-gap-register.md` 的 `asr_utterances`
   仍为 0 —— 本片不改变任何准确率口径。

## 7 未取得项

- 读句柄端到端（见 §6.2）：未取得。
- 真实人工录音样本：按派单**禁止**取得（本片只用合成音频）。
- `GET /api/v1/jobs/{id}` 对本次转写作业的真实 PG 投影：未取得（不是本片范围）。
- 全量单测（`npm run test:unit`）：按资源纪律**未跑**；只跑了与本片改动相关的定向文件（读数见 §5）。

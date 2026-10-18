# GY-I11 阶段 2a 转写路由与回环 HTTP 验证

日期：2026-10-12（香港时间）。Refs #11，仅交付转写路由插件与**本机回环 HTTP** 证据；**2a 当时**不注册到 `app.ts`、不改小程序、不开 PR。
本页正文是 **2a 当时**的记录；**其后的变更与最新证据见下方「阶段 2b 更新」**（凡与 2b 冲突处，以 2b 为准）。

## 阶段 2b 更新（2026-10-12，`upstream/main = 13262f19`，本页随 2b 提交追加）

**基线变化**：`upstream/main` 已推进到 `13262f19`（其中 `f8da03b` 是 #87「识别任务闭环与七类状态」的合并）。
本分支基于 2a 的 `c3aa79e` 合并该 main（**无冲突**），因此 2a 时"参考文件不存在"的前提已消失。

1. **`routes/speech.ts` 已注册进产品装配**：`services/api/src/app.ts` 先加两行
   （一行 `import { registerSpeechRoutes } from './routes/speech.ts';` + 一行
   `registerSpeechRoutes(app, config, { guards });`，紧随 `registerRecognitionRoutes` 之后）。
   **随后按指挥裁定 1 追加**：在 `BuildAppOptions` 补四个**可选**注入项
   `speechStore` / `speechProvider` / `speechMedia` / `speechJobDeadlineMs`（**逐项对齐 GY-I09 识别域的同名项**，
   不改动其已有项、不新造抽象），并把它们转发进插件；装配路径对 `speech/{store,provider,media}` 的引用**全部是 `import type`**
   （运行时被类型擦除）。`app.ts` 相对 main 的 diff = **+17 / −1**（唯一修改行是 `buildApp` 解构签名**末尾追加**四个名字，无重排/无格式化他人行）。
   **默认行为逐字节不变**：不传任何 `speech*` 注入项时，四个值均为 `undefined` ⇒ 插件按 `executionMode` 自建
   （内存 store、模式对应提供者与媒体端口、服务层默认截止时间）⇒ **默认装配路径仍成立「零端口注入」**（由 §5 的 `[13]` 与 `[9]` 实测）。
2. **集成脚本改为打真实装配**：`tests/integration/speech-http.mjs` 现用 `buildApp`（同一实例同时提供鉴权、
   生产错误封套、`ajv removeAdditional:false` 与转写路由）+ 本机回环 HTTP；**14 组通过**（含 real 模式实例与注入式实例）。
   2a 的"测试内自建最小 app"已不再使用（当时是唯一可行做法）。
   **新增覆盖（因注入能力而补齐）**：`[12]` 在**真实装配**上构造并断言 `succeeded` / **`timed_out`（悬挂提供者 + 注入的 250ms 截止时间，`PROVIDER_TIMEOUT`）**
   / `uncertain`（`INPUT_UNCERTAIN`）/ `failed`（`PROVIDER_QUOTA_EXCEEDED`）四类终态，并读出终态
   （经装饰的 `app.speechService.getJob`；HTTP 面对非成功态仍如实 404）；`[13]` 用**默认实例**（`stub-v1`）
   与**注入实例**（`stub-scripted-v1`）可区分，证明注入项**只在传入时生效**、默认行为未变。
3. **失败终态与 `/jobs/{id}` 的现状更正**：契约的 `GET /jobs/{id}`／`POST /jobs/{id}/cancel`
   **现已实现**（由 #87 在 `routes/recognitions.ts` 注册），但**只服务识别域**——转写 job 的 id 在其上得到
   `404 NOT_FOUND`（两域 store 独立）。⇒ **转写任务的 `JobState` 与取消目前仍不可经 HTTP 读取**，
   `failed`／`timed_out`／`uncertain` 依然只能表现为「该转写记录 `GET` 404（未产生记录）」。
   本片**不得**再注册同一路径（会与 #87 的路由重复），故按跨域装配缺口如实登记。
4. **默认关闭的结构性证据（2b 新增）**：`real` 型 ASR 未配置时，经真实装配实例实测
   受理前 **503 `PROVIDER_UNAVAILABLE`**、**提供者调用 0 次**、**不回退替身**（`describe().modelVersion`
   仍为 `real-unconfigured`）；代码层证据：`app.ts` 的转写注册行只传 `guards`（且不 import `speech/provider`、
   `speech/store`、`speech/media`），`speech/provider.ts` **不含任何网络客户端**（无 `fetch(`／`node:http`／
   `node:https`／`node:net`），`createRealSpeechProvider` 函数体内**无替身回退**、**无网络请求**。
5. **新增诊断计数（按指挥裁定 2 保留并披露）**：`speech/service.ts` 在真正发起提供者调用的那一行累加 `providerCalls`，并经
   `describe().providerCalls` 暴露（不含凭据、不改变语义），用于在真实装配上实测"0 次／恰好 1 次调用"。
   路由插件同时 `app.decorate('speechService', service)`，供回归驱动在途任务（`settle()`）与读取终态。
   **披露原文**：「本片在自持文件 `speech/service.ts` 追加 7 行：仅用于证据的 `providerCalls` 计数，不含凭据、
   不改变任何语义与契约；若评审认为测试计数不宜进入生产代码，可改为由路由插件装饰对象暴露。」
6. **跨基线口径**：2b 的"前后数字"在**合并后的合成树**上测得（见 2b 的 PR 正文与提交信息）。

## 来源与范围（**以下为 2a 当时记录**）

- 基线 `upstream/main = 9e87a97385f86e04e965ad2a2caf7494e10a628b`（开工前 `git fetch upstream --prune` 核对；工作分支 `feat/gy-i11-speech-http`，HEAD 即基线 + 本页所述新增）。
- 阶段 1（PR #93，合并提交 `0b75a08`）已把 `services/api/src/speech/**` 与 `tests/unit/speech-*.test.mjs` 带入 main；本页实测**与阶段 1 分支逐字节相同**（`git diff --stat 9a979e6 9e87a97 -- services/api/src/speech tests/unit/speech-*.test.mjs` 为空），因此本轮**未改动服务层语义**。
- 本轮新增：
  - `services/api/src/routes/speech.ts`：转写路由插件（导出 `registerSpeechRoutes`），**2a 当时未注册到 `app.ts`**（2b 已注册，见上）。
  - `tests/integration/speech-http.mjs`：真实本机回环 HTTP 集成脚本。
- 未触碰：`services/api/src/app.ts`（只读调用其 `buildApp`）、`services/api/src/routes/recognitions.ts`（**该文件在基线中不存在**，见下）、`services/api/src/{ocr,tts,community,admin}/**`、`miniprogram/**`、`tools/prepare-wechat.mjs`、`packages/**`、根 `package.json`／`package-lock.json`、`.github/workflows/**`。

### 与派单所引参考文件的偏差（如实登记）

派单要求"照 `services/api/src/routes/recognitions.ts` 与 `tests/integration/recognitions-http.mjs` 的既有风格"。实测这两个文件在该基线**均不存在**（`git ls-tree -r upstream/main -- services/api/src/routes tests/integration` 无 recognitions／ocr／tts 项）——#9（PR #87）尚未合并。因此本轮的"既有 HTTP 管道"参照改为实际存在的实现：

- 路由风格／封套／头部：`services/api/src/routes/profile.ts`、`routes/knowledge.ts`、`routes/support.ts`（`buildMeta`）、`app.ts`（`setErrorHandler`／`setNotFoundHandler`／`ajv.removeAdditional:false`）。
- 鉴权身份读取：`services/api/src/auth/middleware.ts` 的 `readIdentity` 与 `createAuthGuards().requireUser`。
- 集成脚本风格：`tests/integration/knowledge-consumer-http.mjs`、`profile-ui-http.test.mjs`（真实回环 + 合成身份 + 末尾 PASS 行）。

## 交付物与四条路由的注册位置

| operationId | 方法 路径（契约 `/api/v1` 前缀下） | 注册位置 | 成功状态与头部 | 失败码（本层实测） |
| --- | --- | --- | --- | --- |
| `createTranscription` | `POST /speech/transcriptions` | `registerSpeechRoutes` 的 `app.post`（`/speech/transcriptions`） | **202** + `ETag: "<job.revision>"` + `Cache-Control: no-store` | 400 `INVALID_REQUEST`／400 `IDEMPOTENCY_KEY_REQUIRED`／401 `SESSION_REQUIRED`／409 `IDEMPOTENCY_CONFLICT`／503 `PROVIDER_UNAVAILABLE`／409 `OBJECT_UNAVAILABLE`（real 媒体未接线） |
| `getTranscription` | `GET /speech/transcriptions/{id}` | `registerSpeechRoutes` 的 `app.get`（`/speech/transcriptions/:id`） | **200** + `ETag: "<revision>"` + `Cache-Control: no-store` | 400 `INVALID_REQUEST`／401／404 `NOT_FOUND` |
| `deleteTranscription` | `DELETE /speech/transcriptions/{id}` | `registerSpeechRoutes` 的 `app.delete`（`/speech/transcriptions/:id`） | **202** + `Cache-Control: no-store`（见下"未下发 ETag"说明） | 400／401／404／409 `REVISION_CONFLICT`／428 `REVISION_REQUIRED` |
| `confirmTranscription` | `PATCH /speech/transcriptions/{id}/confirmation` | `registerSpeechRoutes` 的 `app.patch`（`/speech/transcriptions/:id/confirmation`） | **200** + `ETag: "<revision>"` + `Cache-Control: no-store` | 400／401／404／409／428 |

**注册位置一律按符号检索，勿按行号复现**：四条均为 `services/api/src/routes/speech.ts` 的 `registerSpeechRoutes` 内 `app.{post,get,delete,patch}` 调用。读数对照——阶段 2a 快照 `c3aa79e`（本表原数字的来源）实测 `:114`／`:135`／`:149`／`:169`；交付提交 `a249e77`（2b 在文件头插入 18 行后）实测 `:132`／`:153`／`:167`／`:187`；测量基线 `6c22000` 实测 `:160`／`:196`／`:210`／`:230`。原表未随 2b 的 18 行插入更新，故在交付提交上即已错位（四条统一偏 +18），按上式补记。

本模块是**薄适配层**：幂等占位、`If-Match` 判定、归属、fail-closed 终态全部由阶段 1 的 `speech/service.ts` 负责，本层只做身份读取、契约 body schema 校验、封套与头部装配。**未新增任何契约字段**。

## 自动检查

- `npm run lint`：`PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`。
- `npm run test:unit`：**971 tests / 970 pass / 0 fail / 1 skipped**。**前后数字相同**：本轮新增的测试文件是 `tests/integration/speech-http.mjs`，**不在** `test:unit` 的 glob（`tests/unit` / `tests/privacy` / `tests/media` / `tests/reference` / `tests/moderation`）内，且本轮**未新增或修改任何**落在这些目录下的文件（`git status --porcelain` 只有本页、`routes/speech.ts`、`tests/integration/speech-http.mjs` 三项）⇒ 单元门禁前后同为 971。
- `npm run test:contract`：6/6 通过（错误码闭集与契约一致，本轮未新增错误码）。
- `npm run test:docs`：`PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`。
- `node --test "tests/unit/speech*.test.mjs"`：**64 tests / 64 pass / 0 fail / 0 skipped**（复用自证：阶段 1 服务层语义未改，逐条通过）。
  - **口径订正**：派单称"既有 88 条测试"，实测该基线内 `tests/unit/speech-*.test.mjs` 共 **64** 条（阶段 1 交付数）。此处以实测为准，不按未复核的数字声明。
- `node tests/integration/speech-http.mjs`：**11 组通过**（原始输出见下）。
- `git diff --check`：无输出（无空白/冲突标记问题）。

### `node tests/integration/speech-http.mjs` 原始输出

```text
PASS [1] POST 202 + JobEnvelope（data.kind/state/result=null、meta.contract_version/execution_mode/request_id、ETag、Cache-Control）
PASS [+] 正控制：受理 → succeeded → GET 读到转写结果（raw_text/uncertain_spans/model_version）
[gap] GET /api/v1/jobs/{id} → 404 NOT_FOUND（getJob 属 GY-I01，本次未装配；running/cancelled 与失败终态因此不可经 HTTP 观测）
PASS [2] 状态如实：queued（202 观测）/ succeeded（GET 200）/ failed·timed_out·uncertain（无记录 ⇒ GET 404）
PASS [3] 归属：他人 GET/DELETE/PATCH ⇒ 404，且与「不存在」响应封套同形（error 逐字段相同）
PASS [4] If-Match：缺失 ⇒ 428 REVISION_REQUIRED、格式非法 ⇒ 400 INVALID_REQUEST、不匹配 ⇒ 409 REVISION_CONFLICT
[并发实测·HTTP 同键同体 3 次] 落库任务数=1、提供者调用数=1、不同 job id 数=1、不同 target_ref.id 数=1
PASS [5] 幂等：同键同体重放同一 job；同键异体 409 IDEMPOTENCY_CONFLICT；同键同体并发恰好 1 任务 1 次提供者调用
PASS [6] 确认只写 confirmed_text/confirmed_at：raw_text 与 uncertain_spans 逐项不变，revision +1
PASS [7] uncertain_spans 如实透传：数量/内容/顺序与提供者所报一致（不删改、不补造、不排序）
PASS [8] raw_text > 8000 码点不静默截断：落 failed（无记录 ⇒ GET 404），且不存在 8000 码点的截断文本
PASS [10] 缺/非法 Idempotency-Key、body 多余字段、非 uuid、revision 边界、未声明查询参数（limit）一律按契约拒绝
PASS [9] real 缺凭据 ⇒ 受理前 503 PROVIDER_UNAVAILABLE（不建任务、不调提供者、不回退替身）
PASS 11 loopback HTTP groups; production pipeline (buildApp) with only the speech plugin added; synthetic identity/provider; loopback only, no supplier, no PG, no real ASR sample
```

### 十条覆盖项与用例名对照

| 派单覆盖项 | 脚本内可单独指出的组名 |
| --- | --- |
| 1 POST 202 + JobEnvelope 形状 | `[1] POST 202 + JobEnvelope（… ETag、Cache-Control）` |
| 2 状态如实（正常 + 失败） | `[+] 正控制：受理 → succeeded → GET 读到转写结果`、`[2] 状态如实：queued / succeeded / failed·timed_out·uncertain` |
| 3 归属 404 同形 | `[3] 归属：他人 GET/DELETE/PATCH ⇒ 404，且与「不存在」响应封套同形` |
| 4 If-Match 428/400/409 | `[4] If-Match：缺失 ⇒ 428 … 格式非法 ⇒ 400 … 不匹配 ⇒ 409` |
| 5 幂等（重放／异体／并发） | `[5] 幂等：同键同体重放同一 job；同键异体 409；同键同体并发恰好 1 任务 1 次提供者调用` |
| 6 确认不改写原始输出 | `[6] 确认只写 confirmed_text/confirmed_at：raw_text 与 uncertain_spans 逐项不变，revision +1` |
| 7 uncertain_spans 如实透传 | `[7] uncertain_spans 如实透传：数量/内容/顺序…（不删改、不补造、不排序）` |
| 8 超长不静默截断 | `[8] raw_text > 8000 码点不静默截断：落 failed…` |
| 9 real 缺凭据受理前 503 不回退 | `[9] real 缺凭据 ⇒ 受理前 503 PROVIDER_UNAVAILABLE（不建任务、不调提供者、不回退替身）` |
| 10 缺/非法幂等键、多余字段、limit 边界 | `[10] 缺/非法 Idempotency-Key、body 多余字段、非 uuid、revision 边界、未声明查询参数（limit）一律按契约拒绝` |

## 装配与证据强度说明

脚本**没有另造一套 HTTP 管道**：它直接调用 `services/api/src/app.ts` 的 `buildApp`（生产错误封套 `setErrorHandler`、`setNotFoundHandler`、`ajv.customOptions.removeAdditional:false`、鉴权守卫），再在其上**只**注册 `registerSpeechRoutes`。因此状态码、`error` 封套形状、`meta` 三项都来自生产代码路径，而 `app.ts` 本身**未被修改**（2b 才在其中加一行注册）。

脚本内的网络面只有 `127.0.0.1` 回环：不发起任何外网请求、不连接任何数据库（`pool: null` ⇒ 认证与转写均为内存 store）、不调用真实 ASR／微信。身份是**合成**的：按 `AuthStore` 公开 API 直接播种 user + session（`createUser` / `createSession` + `mintOpaqueToken` / `hashToken`），**不经过微信换取**，也不涉及任何真实 openid。提供者是**合成脚本**，仅用于构造契约可观测行为。

`real` 模式证据（第 9 组）用 `loadConfig` 装配一份 **real** 配置实例（所有 `REQUIRED_WHEN_REAL` 字段均为明显合成的占位值，且**从不连接**），只装配转写插件、不注入提供者，因此走 `createSpeechProvider({executionMode:'real'})` 的真实 fail-closed 分支。该实例同样只做回环 HTTP。

## 幂等并发实测

```text
[并发实测·HTTP 同键同体 3 次] 落库任务数=1、提供者调用数=1、不同 job id 数=1、不同 target_ref.id 数=1
```

3 个并发同键同体 `POST` 全部得到 **202**，收敛到**同一个 job**；`store.insertJob` 仅发生 1 次（`commitTerminal` 写入 1 条记录），提供者也只被调用 1 次。同键**异体**（串行）得到 **409 `IDEMPOTENCY_CONFLICT`**，且任务数增量为 0。同键同体**重放**获得同一 job 且不再调用提供者。

## 契约缺口与实现层选择（如实登记，不改契约）

> **校订注（2026-10-16 实测）**：本节的 1–6 条是**本片当年**（2026-10-12）的登记，标题里的"缺口"是**当时**事实，逐条保留。
> 其中**第 1 条**的现在时断言已过期：`getJob` / 取消**已装配**——运行期存在 `GET,HEAD /api/v1/jobs/:id` 与
> `POST /api/v1/jobs/:id/cancel`（注册点 `services/api/src/app.ts:1313` `registerJobRoutes(...)`）。
> 因此"`getJob` 未装配 ⇒ 失败终态不可经 HTTP 轮询"**不再成立**；但本片当年**脚本里**的 `[gap] … 404` 观测与
> "未覆盖 `running`/`cancelled`"的**声明**属历史证据，⛔ 不据此重跑或改写。第 2–6 条未复核出过期，保持原样。

1. **`getJob` 未装配 ⇒ 失败终态不可经 HTTP 轮询**。契约存在 `GET /jobs/{id}`（`x-task: GY-I01`），不属本派单的四个操作，脚本只**观测并打印**（`[gap] … 404 NOT_FOUND`）而未据此断言。后果：`failed`／`timed_out`／`uncertain` 在 HTTP 上只能表现为「该转写记录 `GET` 404（未产生记录）」；`running` 与本阶段无阻断语义的 `cancelled` 在 HTTP 层**没有任何观测点**。第 2 组因此覆盖 `queued`（202）+ `succeeded`（200）+ `failed`/`timed_out`/`uncertain`（404 无记录），并显式声明未覆盖 `running`/`cancelled`。
2. **`DELETE` 不下发 `ETag`**。`AckEnvelope` 只有 `accepted`，没有可绑定的 revision；契约 202 的 `ETag` 头未标 `required`（`openapi 202.headers`），故只下发 `Cache-Control: no-store`，不伪造 ETag。
3. **路径 `id` 不做 Fastify `format: uuid` 校验**，交由服务层统一按 `NOT_FOUND` 处理：避免 ajv 的 uuid 版本／变体严格度与 `service.ts` 的宽松形状判定不一致，导致同一非法 id 时而 400、时而 404。两种都是契约声明的响应码；本实现选择与阶段 1 已合并语义保持一致（不泄露资源是否存在）。
4. **请求体 schema 只校验类型/必填/多余字段**；`media_id` 的 uuid 形状与 `media_revision >= 1` 由服务层判定（语义单一出口，避免两处规则漂移）。
5. **这四个操作在契约里没有任何查询参数**；本层按 `routes/profile.ts` 同口径显式 `additionalProperties:false`，因此 `?limit=5` 一类未声明参数一律 400，不静默忽略（已覆盖）。
6. **归属与不存在的"同形"以 `error` 对象逐字段相同 + `meta` 除逐请求 `request_id` 外相同为准**；`meta.request_id` 是 Fastify 每请求生成的 uuid，**不可能**逐字节相同，脚本未声称它相同。

## 未做项（本轮明确未取得）

- **`services/api/src/app.ts` 注册**：2a 时未做（该装配点当时被 #9／PR #87 占用）。**2b 已完成**（两行，见上）；本页下方 2a 证据仍来自测试内自行装配的实例。
- **小程序 `miniprogram/pages/identify/**` 语音模式**、`tools/prepare-wechat.mjs` 白名单：未做（2b）。
- **真实 ASR 供应商／凭据**：未接入；`real` 分支只证明受理前 `PROVIDER_UNAVAILABLE` 与"不回退替身"。**ASR 真实样本为 0**（`docs/evaluation/sample-gap-register.md` 的 `asr_utterances` 0/50、`asr_speakers` 0/10）⇒ 本页**不声称任何转写质量或准确率**，也不声称需求第 6 节评估已运行。
- **真机／微信开发者工具**：未取得（本轮无小程序改动）。
- **PG 持久化**：未做；转写任务与记录仍在内存 store（`describe()` 如实标注 `persistent=false`），进程重启即丢。
- **媒体 HTTP 层**：未接线；`real` 下媒体端口为 `unwired`（受理前 `OBJECT_UNAVAILABLE`）。
- **`POST /speech/synthesis`**：属 #13 TTS，未做。
- **未 push、未开 PR**（2a 当时按派单：等 2b 完成 `app.ts` 与页面后一次性开）。⇒ 2a 的提交 `c3aa79e` 随 **2a+2b 合并的同一个 PR** 推送。

## 整项仍待完成

本页不关闭整项 #11。剩余：2b 的路由注册与小程序语音模式、媒体 HTTP 面与私有保存／外发授权（接 F13）、真实已审 ASR 适配器与凭据通道、50 段真实转写评估（GY-I21）、真机与 PG 证据。当前所有结论仅限"服务层语义 + 本机回环 HTTP 装配"，**不构成验收通过**。

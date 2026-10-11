# GY-I09 识别任务闭环（第一片）· 验证证据

- 上游 issue：`GengYunChuChao/GengYun#9`（保持 open；交付口径 **Refs #9**，不关闭整项）
- 分支：`feat/gy-i09-identify-loop`；基线 `upstream/main = 2d562d5b6fb79896ef8935716b90939538f274c2`
- 本机环境：Windows；Node `v24.16.0`；npm 11.x；无数据库（不接 PG）、无真实微信登录、无真实识别供应商凭据
- 契约：`packages/contracts/openapi.json` 1.0.0（**未修改**，本片只读消费）

## 0 结论摘要（先说不成立的部分）

**能证明的**：在离线/隔离环境下，契约中 `JobState` 的 **7 个取值全部可被真实构造并观测**；候选恒 ≤3 且不补造；
没有可信分数时不写分数、落 `uncertain`；提供者失败/超时**不会**落 `succeeded`；越权一律 `NOT_FOUND`；
`selection` 不改写模型原始 `candidates`/`model_score`/`model_version`；`real` 缺凭据 **fail-closed** 且不回退替身。

**不能证明的（未取得，见 §5）**：真实识别供应商调用与准确率、真机流程、真实照片上传链路（`/media/**` HTTP 未接线）、
PG 持久化、真实微信登录态、CI 绿灯（本机未跑 CI）。

## 1 契约对齐：operationId ↔ 实现 ↔ 回归用例

| operationId | 方法 路径 | 实现位置 | 回归用例（用例名） |
| --- | --- | --- | --- |
| `createRecognition` | `POST /recognitions` | `services/api/src/routes/recognitions.ts`（装配于 `app.ts`）+ `recognitions/service.ts#createRecognition` | `状态 1 queued：202 受理即观测，且 result 为 null`；`幂等：同键同体不重复建任务；同键异体 → IDEMPOTENCY_CONFLICT` |
| `getRecognition` | `GET /recognitions/{id}` | 同上 + `service.ts#getRecognition` | `反例 9：他人任务 id → 一律 NOT_FOUND（GET/PATCH/DELETE/jobs 均不泄露存在性）` |
| `selectSpecies` | `PATCH /recognitions/{id}/selection` | 同上 + `service.ts#selectSpecies` | `selection：只写 selected_species_id，模型原始 candidates/model_score/model_version 不变` |
| `deleteRecognition` | `DELETE /recognitions/{id}` | 同上 + `service.ts#deleteRecognition` | `delete：归属/版本校验 → 202 Ack；重放同键返回同一结果；删除后 GET 404` |
| `getJob`（补充读面） | `GET /jobs/{id}` | `routes/recognitions.ts` + `service.ts#getJob` | 七类状态各自用例（见 §2） |
| `cancelJob`（补充读面） | `POST /jobs/{id}/cancel` | 同上 + `service.ts#cancelJob` | `状态 7 cancelled：取消后**迟到的提供者结果不复活任务**` |

> 补充读面的必要性与边界：契约中 `JobState` **只**出现在 `Job`（`JobEnvelope`）上，`Recognition` 没有状态字段，
> 因此「按 `JobState` 分七类呈现」与「轮询任务状态」在契约内只能经 `GET /jobs/{id}`；`cancelled` 也只能经
> `POST /jobs/{id}/cancel` 构造。两者均为**已冻结**的 operationId，本片只实现 `kind=recognition` 的状态读/取消，
> 不实现其他任务类型的业务逻辑。**未新增迁移**（识别存储为内存实现，见 §6.2）。

## 2 七类 `JobState` 逐类：如何构造、观测到什么

构造方式统一为「注入脚本化提供者 → 经真实 HTTP/inject 受理 → 观测 `Job.state`」。用例文件：
`tests/unit/recognitions-api.test.mjs`（inject，七类逐类）+ `tests/integration/recognitions-http.mjs`（loopback 真实 HTTP）。

| # | state | 如何构造 | 观测命令 | 实际观测到的关键字段 | 用例名 |
| --- | --- | --- | --- | --- | --- |
| 1 | `queued` | 提供者返回**悬挂** Promise（永不落定）；`POST /recognitions` 202 | `POST /api/v1/recognitions` | `data.state="queued"`、`data.result=null`、`data.error_code=null`、`etag="1"`、`cache-control: no-store`、`meta.execution_mode="stub"` | `状态 1 queued：202 受理即观测，且 result 为 null` |
| 2 | `running` | 提供者返回受控 Promise（测试内 `release` 前一直悬挂）；轮询 `GET /jobs/{id}` | `GET /api/v1/jobs/{id}` | `data.state="running"`（随后 release → `succeeded`） | `状态 2 running：提供者悬挂时可观测` |
| 3 | `succeeded` | 提供者返回 3 条有分数候选（0.81/0.42/0.17，Top1 ≥ 0.5） | `GET /api/v1/jobs/{id}` | `state="succeeded"`、`error_code=null`、`result.kind="recognition"`、`result.value.candidates.length=3`、`uncertainty_reasons=[]`、`model_version="stub-v1"` | `状态 3 succeeded：…` |
| 4 | `uncertain` | 三种构造各一条：①候选全 `model_score=null`；②候选为空；③候选有分数但提供者给出 `uncertainty_reasons` | `GET /api/v1/jobs/{id}` | `state="uncertain"`、`uncertainty_reasons.length ≥ 1`、`model_score` 保持 `null`（**不写分数**）；空候选时 `candidates=[]`（**不补造**）；自述原因时不判成功 | `状态 4 uncertain：无分数 → uncertain + 原因，且不写分数`；`状态 4b uncertain：空候选…`；`状态 4c uncertain：提供者自述原因…` |
| 5 | `failed` | 提供者返回 `{kind:'failed',code:'PROVIDER_QUOTA_EXCEEDED'}`；另有协议违规（候选 >3、rank 重复、字段缺失）与抛异常三种 | `GET /api/v1/jobs/{id}` | `state="failed"`、`error_code="PROVIDER_QUOTA_EXCEEDED"`（协议违规/抛异常 → `PROVIDER_OUTCOME_UNKNOWN`）、`result=null`；该任务**没有**识别记录（`GET /recognitions/{target}` → 404） | `状态 5 failed：…`；`反例 5/6/7/8` |
| 6 | `timed_out` | 提供者悬挂 + 任务截止时间 60ms；执行器与截止时间竞速 | `GET /api/v1/jobs/{id}` | `state="timed_out"`、`error_code="PROVIDER_TIMEOUT"`、`result=null` | `状态 6 timed_out：提供者无响应且超过截止时间 → timed_out + PROVIDER_TIMEOUT` |
| 7 | `cancelled` | 提供者悬挂（任务 `running`）→ `POST /jobs/{id}/cancel`（带当前 `If-Match`）→ **再 release 迟到结果** | `POST /api/v1/jobs/{id}/cancel`、随后 `GET /api/v1/jobs/{id}` | 取消返回 `state="cancelled"`；迟到结果落定后再次读取仍为 `cancelled`、`result=null`（**旧回调不复活**）；对已终态任务再取消 → `409 OBJECT_UNAVAILABLE` | `状态 7 cancelled：取消后**迟到的提供者结果不复活任务**` |

集成（loopback 真实 HTTP）另观测到：`create(202,state=queued) → 轮询 → succeeded(2 条候选，未补造第 3 条) → GET(revision=1,ETag "1") → 越权 404 →
`PATCH selection`(200, ETag "2", 候选不变) → `DELETE`(202 accepted) → GET 404`，以及另一 media 上的 `uncertain`（`model_score=null` + 原因）。

## 3 fail-closed 反例清单（每条可单独指出）

`tests/unit/recognitions-api.test.mjs` 中每条为一个独立子测试（negative control）：

| 反例 | 构造 | 观测（实际） |
| --- | --- | --- |
| 多余字段 | body 含 `owner_id` | `400 INVALID_REQUEST` |
| 缺/过短 `Idempotency-Key` | 无头 / `"short"` | `400 IDEMPOTENCY_KEY_REQUIRED` |
| body 形状非法 | `media_id` 非 uuid → 400；`media_revision` 0 / 1.5 / 缺失 → 400；空体 → 400 | `400 INVALID_REQUEST`（schema 层 `details[0].field="/media_id"`，服务层再校验一次） |
| 媒体引用不可用 | 注入「未接线」媒体端口 | `409 OBJECT_UNAVAILABLE`，**不创建任务** |
| 候选 >3 | 提供者给 4 条 | `failed` + `PROVIDER_OUTCOME_UNKNOWN`（**不截断、不补造**） |
| 同 rank 重复 | rank `[1,1]` | `failed` + `PROVIDER_OUTCOME_UNKNOWN`（**不静默去重**） |
| 候选字段缺失 | 缺 `model_score`（`undefined`） | `failed` + `PROVIDER_OUTCOME_UNKNOWN`（先判 `typeof`，`undefined` 不放行） |
| 提供者抛异常 | 提供者 throw | `failed` + `PROVIDER_OUTCOME_UNKNOWN` |
| 提供者无响应/超时 | 悬挂 + 短截止 | `timed_out` + `PROVIDER_TIMEOUT` |
| 他人任务 id | B 用户读 A 的 `GET /recognitions/{id}`、`PATCH selection`、`DELETE`、`GET /jobs/{id}` | 全部 `404 NOT_FOUND`（不泄露存在性） |
| 缺 `If-Match` | `PATCH/DELETE/cancel` 无 If-Match | `428 REVISION_REQUIRED` |
| `If-Match` 格式非法 | `If-Match: 1`（无引号） | `400 INVALID_REQUEST` |
| `revision` 不一致 | `If-Match: "9"` | `409 REVISION_CONFLICT` |
| 幂等冲突 | 同键不同 body | `409 IDEMPOTENCY_CONFLICT` |
| `real` 缺凭据 | `APP_EXECUTION_MODE=real` + 无 endpoint/apiKey | `503 PROVIDER_UNAVAILABLE`，响应**无** `data`/候选/`model_version`（不回退替身） |
| `real` 有凭据无已审适配器 | endpoint+apiKey 齐备 | 受理后落 `failed` + `PROVIDER_UNAVAILABLE`、`result=null` |
| 已终态取消 | 对 `cancelled`/终态任务再取消 | `409 OBJECT_UNAVAILABLE`（不假装取消成功） |
| 非 uuid 路径参数 | `GET /recognitions/not-a-uuid` | `400 INVALID_REQUEST`（ajv `format:uuid` 生效，实测确认） |

## 4 提供者与媒体引用端口（替身标注 / fail-closed）

- `stub`：`model_version="stub-v1"`，`meta.execution_mode="stub"`；按 `sha256(media_id)[0]%4` **确定性分桶**（同一 id 恒得同一脚本，离线可复现），
  且**不构成任何准确率证据**。用例：`GY-I09 替身提供者确定性：同一 media_id 稳定分桶（离线可复现）`。
- `preset_demo`：`model_version="preset-demo-v1"`，固定 Top3 演示脚本，页面显著标注「预设演示，不代表真实识别」。
- `real`：缺凭据 → `available=false` → `POST /recognitions` **直接 503**（受理前 fail-closed）；有凭据但无已审适配器 → 任务落 `failed`/`PROVIDER_UNAVAILABLE`；
  **任何路径都不回退替身**。凭据仅从进程环境 `RECOGNITION_PROVIDER_URL` / `RECOGNITION_PROVIDER_KEY` 读取，缺省为空（本机未设置）。
- 媒体引用端口：`real` → 「未接线」端口，一律 `OBJECT_UNAVAILABLE`；`stub`/`preset_demo` → **明确标注的替身媒体引用**
  （任意合法 uuid 视为调用者名下已就绪媒体；**不上传、不读取真实照片**）。原因与边界见 §6.2。

## 5 证据分列（本机 / 隔离 / 真机 / 真实供应商 / 准确率）

| 类别 | 状态 | 证据 |
| --- | --- | --- |
| 本机 | **已取得** | `tests/unit/recognitions-api.test.mjs`（27 项，含七类状态与 19 条反例）、`tests/unit/miniprogram-identify.test.mjs`（5 项）、`npm run lint` / `test:unit` / `test:contract` / `test:docs` / `test:mini` 输出见 §6.1 |
| 隔离 | **已取得** | `node tests/integration/recognitions-http.mjs`：`127.0.0.1:<随机端口>` loopback 真实 HTTP + 合成身份 + 内存 store + 替身提供者；输出见 §6.3 |
| 真机 | **未取得** | 未在微信开发者工具/真机运行识别页；仅取得「标准产物加载/编译」证据（`test:mini` 内 `check-wechat-project.mjs` + `prepare-wechat.mjs local/release` 产物加载 12 页）。**不声称真机流程已验收** |
| 真实供应商 | **未取得** | 无供应商凭据、无已审适配器；本片只有 fail-closed 行为证据（§3 最后两行）。**未发起任何真实识别调用** |
| 准确率 | **未取得，且不得声称** | 依据 `docs/evaluation/sample-gap-register.md`：拍草「覆盖内清晰照片」要求 ≥300、**实际到位 0**；「覆盖外」0/100；「低质量」0/100（逐项均为 0 且标记阻塞）。因此本片**不以任何合成样本声称准确率**；替身脚本与 `preset_demo` 均不计入准确率 |

## 6 门禁实测（真跑，含失败原文）

### 6.1 五条门禁（最终一次运行的原始输出要点）

```
> npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。      # exit 0

> npm run test:unit
…（含 GY-I09 三个新用例文件全部 ✔）
ℹ tests 715
ℹ pass 714
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1        # 既有 native-PG 用例（本机无 PG，按其自身 skip 条件跳过）
ℹ duration_ms 16739.3582                                  # exit 0

> npm run test:contract
✔ API 错误码与 HTTP 状态映射与契约 states.json 完全一致
✔ API ExecutionMode 与契约 states.json 一致
✔ API 错误码集合与 openapi ErrorCode 枚举一致
✔ 错误码在状态映射中不重复归属
✔ meta.contract_version 与契约 Meta 常量一致，且必填字段齐备
✔ Error / ErrorEnvelope 形状与契约一致
ℹ tests 6 / pass 6 / fail 0                               # exit 0

> npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables   # exit 0

> npm run test:mini
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
✔ missing, public, wildcard, credential and mismatched configs fail
✔ actual HTTP service is synthetic, no-store and has no business routes
✔ client blocks trial/release/unknown environments and labels stub or failure
✔ isolated packaging excludes private files and rejects release overrides/stale output   # 含 release 产物加载 12 页 + 白名单依赖断言
ℹ tests 4 / pass 4 / fail 0                               # exit 0
```

> CI 状态：本片**未**取得 CI 绿灯证据；不以 CI 代替本机实测，也未据此宣布通过。

### 6.2 未新增迁移（接口/迁移影响）

本片**未新增任何数据库迁移、未修改 `packages/contracts/**`、未修改 `packages/privacy/**`、未修改 `miniprogram/config/runtime.js`**。
识别任务是**进程内内存 store**（`services/api/src/recognitions/store.ts`，`persistent=false`）：进程重启即丢失，**未取得 PG 持久化证据**——
这是本片最明确的实现缺口（见 §7）。

### 6.3 隔离集成（loopback 真实 HTTP）原始输出

```
> node tests/integration/recognitions-http.mjs
PASS GY-I09 loopback HTTP integration (synthetic identity + stub provider + memory store)
  - loopback origin=http://127.0.0.1:62916
  - create job=953c9e9d-… recognition=a67603ed-… state=queued
  - final state=succeeded error_code=null model_version=stub-v1
  - selection=synthetic_weed_a revision=2
  - delete=accepted; get after delete=404
  - uncertain job=ad9d9404-… reasons=["替身未给出可信分数，需重拍或人工核对"]
```
（job/recognition id 为单次运行的合成 uuid，每次运行不同。）

### 6.4 过程中真实失败与处置（如实记录，含原始报错）

1. `selection` 幂等重放被自身版本校验拦下：`AssertionError: 409 !== 200`（`tests/unit/recognitions-api.test.mjs` 的 replay 断言）。
   处置：把**幂等重放判定移到版本校验之前**（与 `packages/media` 完成接口 B3 口径一致），并保留「新键 + 过期 If-Match → 409」的反例。
2. `real` 模式用合成微信 code 登录失败：`503 PROVIDER_UNAVAILABLE {"message":"微信登录需要持久化会话存储（数据库未配置或不可用）"}`
   （GY-I04 既有守卫，**不放宽**）。处置：改为在内存 store 直接注入合成会话，并在用例注释与本文档标注
   「不代表 real 模式会话存储/真实登录已验收」。
3. 集成脚本 `DELETE` 请求返回 `400 INVALID_REQUEST {"message":"请求体格式错误"}`：原因是无请求体却声明了
   `Content-Type: application/json`（Fastify 空 JSON 体 → `FST_ERR_CTP_EMPTY_JSON_BODY` → 契约 `INVALID_REQUEST`）。
   处置：改为无体请求不带 JSON content-type；并实测确认（探针：`DELETE` + json content-type 无体 → `400 INVALID_REQUEST`）。
4. 既有 `tests/unit/miniprogram-ui-auth-integration.test.mjs` 报
   `ENOENT: … miniprogram\data\crops.js.js`：该测试的模块加载器会给每个 require 路径追加 `.js`，而识别页顶层 require
   `utils/reference`（其内部 `require('../data/crops.js')` 带扩展名）。处置：**不改动既有测试与断言**，改为在识别页内**懒 require** `utils/reference`。
5. 工具事故：用 PowerShell `Set-Content` 覆写 `miniprogram/utils/identify-api.js` 造成编码损坏（`SyntaxError: Unexpected identifier`），
   已删除并以 UTF-8 重写全文；`node --check` 与 `test:mini` 复跑通过。

## 7 契约缺口、剩余项与阻塞

1. **PG 持久化未实现**：识别任务/识别记录在内存 store，重启丢失；无迁移、无 RLS/权限证据。
2. **媒体 HTTP 未接线**：`packages/media/**` 是纯模块（其 README 明确「媒体 HTTP 路由尚未接线」），且契约把上传句柄 URL 限定为 `^https://`，
   本机 loopback 无法提供该 https 数据面。故本片**不接线 `/media/**`**（属 GY-I06 剩余工作，避免越界）；
   后果：`real` 模式更不可能上传照片 → 如实 fail-closed；`stub/preset_demo` 使用**明确标注的替身媒体引用**。
   小程序侧已按契约实现 `createUpload → PUT 句柄 URL → completeUpload` 调用链（`utils/identify-api.js#uploadPrivatePhoto`），
   但**未取得一次成功上传的证据**：照片上传在本机不可用（页面如实报 `MEDIA_CHANNEL_UNAVAILABLE`，不使用替身顶替）。
3. **私有历史**：小程序侧仅保存**本机索引**（jobId/recordId/状态/选择），条目内容以服务端为权威重新核对；
   服务端历史列表 `GET /history`（listHistory，属 GY-I20 范围）**未实现**。
4. **契约缺口（不改契约，如实记录）**：
   - `SelectionInput.selected_species_id` 只约束 1..80 字符，**未**约束必须是候选之一；本片不发明该约束（记录为缺口）。
   - `JobState` 只挂在 `Job` 上，`Recognition` 无状态字段：客户端必须同时持有 `GET /jobs/{id}`（状态）与
     `GET /recognitions/{id}`（结果）才能完整呈现；这是契约形态，已按补充读面实现，记录供监工裁决是否算越界。
   - 无「上传字节」契约操作：`UploadCompleteInput` 只有 `{sha256,bytes}`，字节只能经服务端下发的句柄 URL 传输，该数据面端点**不在 openapi 中**。
5. **未实现（属其他任务）**：GY-I08 条件匹配/用量守卫、处方/剂量换算、社区/消息/后台、OCR/语音/问答链路。

## 8 逐项「观测 vs 期望」

| 验收项（派单/issue） | 期望 | 实际观测 | 判定 |
| --- | --- | --- | --- |
| 7 类 `JobState` 逐类可构造可观测 | 7/7 | 7/7（§2，逐类独立用例） | 满足（离线/隔离） |
| 候选至多 3 条、少于 3 不补造 | ≤3 且不补造 | 2 条候选保持 2 条；>3 → `failed`（不截断） | 满足 |
| 无可信分数不伪造 | `uncertain` + 原因 | `model_score` 保持 `null`，状态 `uncertain`，原因 ≥1 条 | 满足 |
| 提供者失败不写 `succeeded` | `failed`/`timed_out` | `failed`/`timed_out` + `error_code`，`result=null` | 满足 |
| `real` 缺凭据 fail-closed、不回退替身 | 503 且无替身结果 | `503 PROVIDER_UNAVAILABLE`，响应无 `data` | 满足（HTTP 层，合成会话注入） |
| 越权/不存在一律 `NOT_FOUND` | 404 同形 | 4 条路径全部 404 | 满足 |
| `selection` 独立记录、不回写模型字段 | 仅 `selected_species_id` 变化 | 深度相等断言通过，`revision+1`、`ETag "2"` | 满足 |
| 幂等（同键不重复建任务） | 同键同体同一 job | 同一 job id，提供者只被调用 1 次；异体 409 | 满足 |
| 小程序按七类分呈现（不合并成「失败」） | 7 套文案 + 分支 | 7 套独立文案；`candidatesTrusted`/`allowReferenceQuery` 仅 `succeeded` | 满足（本机纯函数/生命周期） |
| 打包白名单同步（既往 MODULE_NOT_FOUND） | 新依赖在白名单内 | `utils/identify-api.js` 已加入；release 产物加载 12 页通过 | 满足 |
| 保留 `page-gate` / `font-scale` | 语义不变 | 既有 `tests/unit/miniprogram-ui-auth-integration.test.mjs` 18 项全通过（identify 门禁用例含在内） | 满足 |
| 真实供应商调用 / 准确率 / 真机 | 需真实证据 | **未取得** | **不满足**（如实列为阻塞） |
| PG 持久化 | 需实库证据 | **未取得** | **不满足**（内存 store） |
| 图片真实上传 | 需真实链路 | **未取得**（`/media` 未接线） | **不满足** |

## 9 F15 / AC11 / AC22 映射

| 项 | 本片覆盖情况 |
| --- | --- |
| F15（实时拍草识别、Top3 核对与不确定处理） | 任务受理/状态机/Top3 上限与不补造/不确定判定/用户选择与私有记录：**本片已实现并离线取证**；真实模型准确率与真机流程未取得 |
| AC11（无可信分数不伪造高置信、候选少于 3 不补造） | **已满足**（§3、§8 对应用例） |
| AC22（任务归属与重试安全） | 归属：越权一律 404（4 条路径）；重试幂等：同键同体复用同一任务、异体 409；取消后旧回调不复活 |

## 10 自我核对清单（本片**不**声称的内容）

- [x] 口径 `Refs #9`，未关闭 #9，未合并任何 PR，未自评通过
- [x] 未修改 `packages/contracts/**`、`packages/privacy/**`、`packages/evaluation/**`、`miniprogram/config/runtime.js`
- [x] 未放宽 `guards` / `page-gate` / `privacy` 守卫；未删除或注释既有测试，未改弱既有断言
- [x] 未提交令牌、`.env`、AppSecret、真实 openid、真实会话令牌、个人原始媒体、构建输出
- [x] 未跑的命令不写「通过」；失败原文已如实记录（§6.4）
- [ ] **不声称**真实供应商可用、真机通过、准确率成立、PG 持久化已完成、`/media/**` 已接线、CI 绿灯

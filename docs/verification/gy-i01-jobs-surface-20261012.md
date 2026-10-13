# GY-I01 跨 kind 作业读面/取消面（`GET /jobs/{id}` + `POST /jobs/{id}/cancel`）验证

日期：2026-10-12（香港时间）。口径：`Refs #9 #10 #11 #13`，**四个整项都不关闭**，**不声称已修复任何单域能力**。

## 来源与范围

- 基线 `upstream/main = a249e77b31d75001b778bf2d8df0229a6a23639a`（开工前 `git fetch upstream --prune` 核对，`git merge` ⇒ Already up to date）。
- **合成（变更 2）**：开工后 main 前进到 **`54ed689c`**（#105「GY-I13 TTS 阶段 2a+2b」）⇒ `git merge upstream/main` 出现**唯一冲突文件 `services/api/src/app.ts`**（两侧在同一 import 区末尾与 `registerSpeechRoutes(...)` 之后**同点各自追加**）。经指挥逐条许可，按「**两侧全保留**」解决：保留 #102 的 `registerSpeechRoutes(...)`、#105 的 `registerSynthesisRoutes(...)`（沿用其原位）与本片的 `registerJobRoutes(...)`；import 三组与 `BuildAppOptions` 的 `speech*`(4)/`synthesis*`(5) 注入项全部保留。**未删除/改写 #102、#105 的任何行**（合成后 `git diff upstream/main -- services/api/src/app.ts` 只显示本片新增的 3 行 import + 4 行 jobs 注册块）。merge commit `c75e792`（中文，**非** rebase/force/amend）。
- **合成（变更 3）**：main 又前进到 **`b1f6ab0e`**（含 **#104「GY-I10 标签 OCR 服务端 HTTP 层」**）⇒ 第二次 `git merge upstream/main`，**冲突仍只在 `services/api/src/app.ts`**（同点相邻追加：本片 jobs 注册块 vs #104 的 `registerOcrRoutes(app, config, { guards })`）。同样按「**两侧全保留**」解决：`registerRecognitionRoutes` / `registerSpeechRoutes` / `registerSynthesisRoutes` / `registerOcrRoutes` / `registerJobRoutes` **五者各恰一处**（行 207/208/209/210/214），无残留冲突标记，jobs 仍在 `registerSpeechRoutes` 之后；**未删除/改写 #102、#104、#105 的任何行**。merge commit `0679d09`（中文，**非** rebase/force/amend）。合成后 `jobs-http.mjs` 仍 **13 组全 PASS**，四个既有域脚本（`speech-http` / `recognitions-http` / `tts-http` / `ocr-http`）全部通过。
- 本片新增：`services/api/src/jobs/registry.ts`（端口 + 契约形状守卫 + 分派注册表）、`services/api/src/jobs/sources.ts`（各域作业源适配器）、`services/api/src/jobs/routes.ts`（**唯一注册点**）。
- 本片修改：`services/api/src/routes/recognitions.ts`（**仅为收敛**：删除其两处 `/jobs` 注册与原注释）、`services/api/src/app.ts`（+3 import、+1 注册块）、`tests/integration/speech-http.mjs`（#102 里那条 `[gap] …→ 404` 已过时 ⇒ 改为"经共享作业面可读"；**只动缺口那几行、只新增断言**，14 组仍全绿）。
- 未触碰：`packages/**`、契约、`db/**`、`apps/admin/**`、`miniprogram/**`、`tools/prepare-wechat.mjs`、根 `package.json`/lock、`.github/workflows/**`；**未改** `routes/{speech,synthesis,ocr}.ts` 与任何域 `service`/`store` 语义（**只读复用**）。

## 设计：单一注册 + 按 kind 分派的作业源注册表

```
JobSourcePort = { kind, get({userId, jobId}) → Job|null, cancel?({userId, jobId, ifMatch, idempotencyKey}) → Job|null }
```

1. **单一注册**：全仓**只有** `services/api/src/jobs/routes.ts` 注册这两个路径（实测注册点 = 2，GET/POST 各 1）。
   识别域原先自带的两处注册（只查识别域 store）被**迁移**到共享面，识别域改为以 `createRecognitionJobSource(recognitionService)` 接入
   ⇒ **同一个识别域服务被复用**，行为不变（其既有集成回归**零改动**且逐条通过）。
   *选择理由*：迁移（而非"识别域委托共享面"）避免在域路由里再造转发层与二次鉴权，且共享面本就承接这两个 operationId（`x-task: GY-I01`）。
2. **按 kind 分派**：注册表按注册顺序询问各源；**未注册的 kind ⇒ 与"作业不存在"同形的 404**（fail-closed，**绝不为未接线能力伪造状态**）。
3. **同形 404（**三类**）**：**他人作业**、**合法 uuid 但不存在**、**kind 未接线** ⇒ 对外封套**逐字节同形**。
4. **两层分工（与 #9/#10 线既有钉子同一口径）**：路径参数按契约 `format: uuid` ⇒ **HTTP 层判格式（非 uuid ⇒ 400 `INVALID_REQUEST`）**；
   **服务层判存在性与归属（⇒ 404 `NOT_FOUND`）**。既有钉子两处可对照：
   `docs/verification/gy-i09-identify-loop-20261011.md:74`「非 uuid 路径参数 `GET /recognitions/not-a-uuid` ⇒ `400 INVALID_REQUEST`（ajv `format:uuid` 生效，实测确认）」，
   以及 #104 的 `tests/integration/ocr-http.mjs` 的 **`PASS 7b) 钉子·两层分工：非 uuid 路径 id⇒400 INVALID_REQUEST（HTTP 层判格式）；格式合法但不存在⇒404 NOT_FOUND（服务层判存在性）`**（本片合成后实测仍通过）。
   **非法 uuid 不并入同形 404 组**（故 `/ocr/{id}`、`/recognitions/{id}` 与本共享面口径一致：格式 400、存在性 404）。
5. **未声明查询参数 ⇒ 400**：契约对这两个操作**没有声明任何查询参数** ⇒ 显式 `additionalProperties: false`（不静默忽略；与 `routes/speech.ts` 同口径）。
6. **出口即重建**：命中后由 `assertContractJob` 按契约字段**重建**新对象（`additionalProperties:false` ⇒ 键集合恰好九键）并对 `result.value` `structuredClone` ⇒ 出口不共享域内引用。
7. **取消不重写状态机**：`If-Match`、幂等回放、终态判定、`cancelled` 迁移**全部复用各域既有实现**；本层只分派。
   域内**没有取消能力**（未接线）时：注册表先确认作业存在，再以 **503 `PROVIDER_UNAVAILABLE`（retryable）** 如实拒绝——
   与"对象当前不可用"（409 `OBJECT_UNAVAILABLE`）**刻意区分**，既不谎称对象状态、也**不伪造 `cancelled`**；
   依据：契约 `cancelJob` 的响应闭集含 503（`x-error-status-map["503"] = [PROVIDER_UNAVAILABLE, PROVIDER_OUTCOME_UNKNOWN]`），
   以及项目"未接线 ⇒ fail-closed 503"的既有口径（先例 `db/catalog.ts` 的"尚未接入"、admin `AdminJobPort`）。

## 待接线清单（本片**未**引用任何未合并代码；逐项如实登记）

| kind | 本基线现状（实测） | 接线所需 |
| --- | --- | --- |
| `recognition` | **已接线**（#87）：`getJob` + `cancelJob` 齐备 | — |
| `transcription` | **已接线读取**（#11/#102）：`getJob` 齐备；**域内无取消入口** ⇒ cancel 返回 503（见设计 7） | 取消能力需 #11 线补域内 `cancel` |
| `ocr` | `services/api/src/ocr/service.ts` 在本基线**已存在**，但其路由**未装配进 `app.ts`** | 装配方提供 `getJob`（有取消则一并） |
| `synthesis` | TTS 在 `services/api/src/tts/service.ts`（#105 已接线 **`/speech/synthesis`**，但**未注册 `/jobs`**） | 作业读面若需要，另接 |
| `answer` | 本基线**无该域服务** | 领域实现后再接 |
| `moderation` | `services/api/src/community/service.ts` 存在，**无作业面** | 领域提供作业读面后再接 |

## 单一注册的证明（命令与原始输出）

```text
$ 递归扫 `services/api/src/**/*.ts` 中 `${API_PREFIX}/jobs/:id…` 模板字面量注册点（脚本内 [12]）
[注册点] jobs/routes.ts → ${API_PREFIX}/jobs/:id | jobs/routes.ts → ${API_PREFIX}/jobs/:id/cancel
注册点总数 = 2（GET、POST 各 1），且全部位于 jobs/routes.ts

$ Select-String -Path services/api/src/{*.ts,routes/*.ts,jobs/*.ts} -Pattern 'API_PREFIX\}/jobs/:id'
services\api\src\jobs\routes.ts:39:    `${API_PREFIX}/jobs/:id`,
services\api\src\jobs\routes.ts:48:    `${API_PREFIX}/jobs/:id/cancel`,
共 2 处：routes.ts:39 , routes.ts:48
```
`git grep 'API_PREFIX}/jobs'` 在 main 上另有一处 `recognitions/service.ts:539` —— 那是**幂等 scope 字符串**（`POST ${API_PREFIX}/jobs/{id}/cancel`），**不是路由注册**。
⇒ 路由注册点计数 = **1 处路径 × 2 个操作**，无重复注册；运行时亦不冲突（所有集成脚本都在真实装配上跑通；若重复，Fastify 装配期即抛 `FST_ERR_DUPLICATED_ROUTE`）。

## 「改前 404 → 改后 200」对照（本片核心）

```text
[前后对照] 同一个转写 job id：改后（两源注册表）→ 200 succeeded；改前等价臂（仅识别域源）→ 404 NOT_FOUND
```
- **改后**（真实装配：识别域 + 转写域两源）⇒ `200`、`kind=transcription`；
- **改前等价臂**（同一 `authStore`、同一守卫与错误封套，**只把转写源从注册表移除** = 等价收敛前识别域独占注册）⇒ `404 NOT_FOUND`。
- 该对照同时就是「**未接线 kind ⇒ 同形 404**」的实测证据。

## 状态码 / 错误码映射（实测；**含变更 2 的三处口径更正**）

| 情形 | 状态 | 错误码 |
| --- | --- | --- |
| `GET /jobs/{id}` 命中（识别域 / 转写域） | **200** `JobEnvelope` + `ETag: "<revision>"` + `Cache-Control: no-store` | — |
| `POST /jobs/{id}/cancel` 命中且非终态（识别域） | **200**（`state=cancelled`，revision+1，`result=null`） | — |
| **他人作业 / 合法 uuid 但不存在 / kind 未接线**（三类同形） | **404** | `NOT_FOUND` |
| **非 uuid 路径 id**（GET 与 cancel） | **400** | `INVALID_REQUEST`（**HTTP 层判格式**；钉子用例 `[4b]`） |
| **未声明查询参数**（如 `?limit=5`，GET 与 cancel） | **400** | `INVALID_REQUEST` |
| 取消已终态作业（识别域有取消能力 ⇒ 由域内判终态） | **409** | `OBJECT_UNAVAILABLE`（状态与 revision 均不变 ⇒ 不复活） |
| 取消"注册但其域**无取消能力**"的作业（本片：转写域） | **503** | `PROVIDER_UNAVAILABLE`（`retryable: true`；能力未接线，不谎称对象状态、不伪造 `cancelled`） |
| 取消缺 `If-Match` | **428** | `REVISION_REQUIRED` |
| 取消 `If-Match` 非法（`1`/`*`/`abc`/`"0"`） | **400** | `INVALID_REQUEST` |
| 取消缺 `Idempotency-Key` | **400** | `IDEMPOTENCY_KEY_REQUIRED` |
| 取消时 `If-Match` 落后（新幂等键） | **409** | `REVISION_CONFLICT` |
| 无会话（GET 与 cancel） | **401** | `SESSION_REQUIRED` |

## 反例矩阵（≥10 类，均可单独指出）

| # | 反例 | 位置 |
| --- | --- | --- |
| 1 | 他人作业 `GET` ⇒ 同形 404 | 集成 `[4]` |
| 2 | 他人作业 `cancel` ⇒ 同形 404 | 集成 `[5]` |
| 3 | 合法 uuid 但不存在（GET / cancel）⇒ 同形 404 | 集成 `[4]`/`[5]` |
| 4 | **未接线 kind ⇒ 同形 404（fail-closed，不伪造状态）** | 集成 `[4]` + 单元"未接线 kind 同形" |
| 5 | **非 uuid 路径 id（GET / cancel）⇒ 400 `INVALID_REQUEST`**（钉子：HTTP 层判格式） | 集成 `[4b]` |
| 6 | **未声明查询参数（GET / cancel）⇒ 400 `INVALID_REQUEST`** | 集成 `[4b]` |
| 7 | 无会话 ⇒ 401 `SESSION_REQUIRED`（GET / cancel） | 集成 `[5]` |
| 8 | `cancel` 缺 `If-Match` ⇒ 428；非法 ⇒ 400；缺 `Idempotency-Key` ⇒ 400 | 集成 `[7]` |
| 9 | **已终态 `cancel` ⇒ 409 `OBJECT_UNAVAILABLE` 且状态/revision 不变（不复活）** | 集成 `[8]` |
| 10 | **域无取消能力（转写）⇒ 503 `PROVIDER_UNAVAILABLE`（retryable）且状态不变** | 集成 `[9]` + 单元 |
| 11 | 形状违规：多余/缺键、未知 kind/state、`result` 判别子不一致、终态带 `result`、`succeeded` 带 `error_code`、`failed`/`timed_out` 无 `error_code` | 单元（逐条） |
| 12 | 同一 kind 重复装配 ⇒ 装配期抛错 | 单元 |

## cancel 的终态与并发证据

```text
[并发实测·cancel 同键 2 次] statuses=[200,200] 迁移前 revision=2 → 迁移后 3
[并发实测·cancel 异键 2 次同一 If-Match] statuses=[200,409] 冲突码=REVISION_CONFLICT 迁移前 revision=2 → 迁移后 3
```
- 同键并发：两次响应**回放同一结果**（同一 revision），作业**恰好迁移一次**；
- 异键并发（同一 `If-Match`）：**恰好一个 200 + 一个 409**，作业仍**恰好迁移一次**（CAS 生效，不复活、不双写）。

## 回退-复跑（去掉守卫 ⇒ 反例失败；跑完按 sha256 逐字节还原）

| 变异 | 内容 | 结果（原始输出摘录） |
| --- | --- | --- |
| **M1**「未接线 kind 不得伪造状态」 | `registry.get` 末段改为**伪造**一个 `queued`/`kind=ocr` 的合法作业返回 | **`FAIL [3] 对照·「改前 404 → 改后 200」…：收敛前等价臂：转写 job 必须 404（识别域独占）` / `actual: 200`** |
| **M2**「已终态不得被取消」 | 识别域源 `cancel` 捕获域内 `OBJECT_UNAVAILABLE` 后**伪装取消成功**（返回 `cancelled`） | **`FAIL [8] 反例·已终态作业 cancel ⇒ 拒绝…`**，响应体为伪造的 `state=cancelled`（`actual: 200`） |

还原校验（**变更 2 之后重跑**）：`registry.ts`/`routes.ts`/`sources.ts` 的 sha256 与注入前**完全一致**
（`F2EAB8028CB2857F9EF040E23C497EEA98D1F225AAA096258B2BBEE453DF4343` /
`A350059152DA461A782A1488B1E0A1BBA58E2F788C3987621E87EF11DE768F6B` /
`74D2F653A5DDBA9F48942D5D64FCFAF141875515BADAEB8C7785327051040C2E`），重跑全绿。

## 口径更正记录（**变更 2**：派单字面 vs 已合并域的实际不变式）

1. **`uncertain` 可带 `result`（不改识别域）**：派单原「设计要求 6」写"`uncertain` 必须 `result=null`"，
   与**已合并识别域**（`recognitions/service.ts` 的 `toJob`：`usable = succeeded || uncertain`）及其既有集成测试
   （断言 `uncertainJob.result.value.uncertainty_reasons`）冲突。经指挥更正，**按实际不变式**实现并测试：
   `result≠null ⇒ state ∈ {succeeded, uncertain}` 且 `result.kind === job.kind`；
   `state ∈ {queued, running, failed, timed_out, cancelled} ⇒ result === null`；
   `succeeded ⇒ error_code === null`；`failed`/`timed_out` ⇒ `error_code !== null`。**未改识别域任何代码/测试**。
2. **非法 uuid ⇒ 400（不并入同形 404）**：派单原要求把"非法 uuid"并入"同形 404"；经指挥更正为
   「**HTTP 层负责格式（400）、服务层负责存在性（404）**」，本片据此恢复 `params: format:'uuid'`，
   并新增**钉子用例** `[4b]`（用例名写明"两层分工…防未来静默翻转"），与 #9/#10 线既有钉子同一口径。
3. **"域无取消能力" ⇒ 503（不是 409）**：见设计 7 与状态码表；依据为契约 `cancelJob` 响应闭集含 503 及项目"未接线 ⇒ 503"口径。

## 未取得项

- `ocr`/`synthesis`/`answer`/`moderation` 的作业源**未接线**（见"待接线清单"）；转写域的**取消能力**域内不存在（⇒ 503）。
- **PG 持久化**未做（内存 store；进程重启即丢）。
- **真实供应商**（识别/转写）未接入；**真实样本为 0** ⇒ 不声称任何识别/转写质量或准确率；**未运行需求第 6 节评估**。
- **真机 / 微信开发者工具**、小程序页面（`identify` 语音模式等）未取得。
- `/admin/jobs*`（`AdminJobPort`，属 #18 阶段 2）**未做**。

## 整项状态

本页**四个整项都不关闭**（`#9`、`#10`、`#11`、`#13`）：只交付「跨 kind 作业读面/取消面」这一层，
接线范围严格限于**已合并**的识别域与转写域；其余 kind 的作业源留接缝。

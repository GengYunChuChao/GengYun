# GY-I01 跨 kind 作业读面/取消面（`GET /jobs/{id}` + `POST /jobs/{id}/cancel`）验证

日期：2026-10-12（香港时间）。口径：`Refs #9 #10 #11 #13`，**不关闭任何整项**，**不声称已修复任何单域能力**。

## 来源与范围

- 基线 `upstream/main = a249e77b31d75001b778bf2d8df0229a6a23639a`（含 `a249e77` = #102 合并；开工前 `git fetch upstream --prune` 核对并 `git merge upstream/main` ⇒ **Already up to date，无冲突**）。
- 本片新增：`services/api/src/jobs/registry.ts`（端口 + 契约形状守卫 + 分派注册表）、`services/api/src/jobs/sources.ts`（各域作业源适配器）、`services/api/src/jobs/routes.ts`（**唯一注册点**）。
- 本片修改：`services/api/src/routes/recognitions.ts`（**仅为把 `/jobs/{id}`、`/jobs/{id}/cancel` 收敛到共享面**：删除其两处注册与原注释，其余识别域路由一字未动）、`services/api/src/app.ts`（+3 行 import、+6 行注册，见 PR 正文 diff）、`tests/integration/speech-http.mjs`（#102 里那条"转写 job 不可经 `/jobs/{id}` 读取"的 `[gap]` 观测**已过时**，改为正控制断言；只改该测试的观测/断言，未动任何域代码）。
- 未触碰：`packages/**`、契约、`db/**`、`apps/admin/**`、`miniprogram/**`、`tools/prepare-wechat.mjs`、根 `package.json`/lock、`.github/workflows/**`；**未改** `routes/{speech,ocr}.ts` 与任何域 `service`/`store` 的语义（**只读复用**）。

## 设计：单一注册 + 按 kind 分派的作业源注册表

```
JobSourcePort = { kind, get({userId, jobId}) → Job|null, cancel?({userId, jobId, ifMatch, idempotencyKey}) → Job|null }
```

1. **单一注册**：全仓**只有** `services/api/src/jobs/routes.ts` 注册这两个路径（实测注册点 = 2，GET/POST 各 1；见下"单一注册的证明"）。
   识别域原先自带的两处注册（只查识别域 store）被**迁移**到共享面，识别域改为以 `createRecognitionJobSource(recognitionService)` 形式接入
   ⇒ **同一个识别域服务被复用**，行为不变（其既有集成回归仍全绿）。
   *选择理由*：迁移（而非"识别域委托共享面"）避免在域路由里再造一层转发与二次鉴权，且共享面本来就是这两个 operationId 的契约归属（`x-task: GY-I01`）。
2. **按 kind 分派**：注册表按注册顺序询问各源；**未注册的 kind ⇒ 与"作业不存在"同形的 404**（fail-closed）——
   注册表里没有该 kind 的源，调用自然落到同一条 `NOT_FOUND` 分支，**绝不为未接线能力伪造状态**。
3. **同形 404**：各域源在「不存在**或**越权」时返回 `null`（适配层把域内 `NOT_FOUND` 映射为 `null`）⇒ 注册表无法、也不需要区分二者。
4. **出口即重建**：命中后由 `assertContractJob` **按契约字段逐项重建**新对象（`additionalProperties:false` ⇒ 键集合必须恰好九键）并对 `result.value` `structuredClone` ⇒ 出口不共享域内引用。
5. **取消不重写状态机**：`cancelJob` 的 `If-Match`、幂等回放、终态判定、`cancelled` 迁移**全部复用各域既有实现**；本层只做分派。
   域内无取消能力的源**不暴露 `cancel`** ⇒ 注册表先确认作业存在、再以 `409 OBJECT_UNAVAILABLE` 如实拒绝（**不假装取消成功、不伪造 `cancelled`**）。

## 待接线清单（本片**未**引用任何未合并代码；逐项如实登记）

| kind | 本基线现状（实测） | 接线所需 |
| --- | --- | --- |
| `recognition` | **已接线**（#87）：`recognitions/service.ts` 有 `getJob` + `cancelJob` | — |
| `transcription` | **已接线读取**（#11/#102）：`speech/service.ts` 有 `getJob`；**域内无取消入口** | **取消能力**需 #11 线补域内 `cancel`（本片按纪律不擅自加） |
| `ocr` | `services/api/src/ocr/service.ts` **在本基线已存在**，但其路由**尚未装配进 `app.ts`** | 装配方提供 `getJob`（有取消则一并） |
| `synthesis` | **目录不存在**（TTS 在 `services/api/src/tts/service.ts`，已存在；作业面属 #13） | 作业读/取消面 + 路由装配 |
| `answer` | 本基线**无该域服务** | 领域实现后再接 |
| `moderation` | `services/api/src/community/service.ts` 存在；**无作业面** | 领域提供作业读面后再接 |

> 未接线的 kind 现在一律 **404 同形**（实测：拿转写 job 的 id 去问"只有识别域源"的注册表 ⇒ `NOT_FOUND`，与未知 id/他人作业/非法 uuid 逐字段同形）。

## 单一注册的证明

```
$ 全仓扫描 `services/api/src/**/*.ts` 中 `${API_PREFIX}/jobs/:id…` 模板字面量注册点
[注册点] jobs/routes.ts → ${API_PREFIX}/jobs/:id | jobs/routes.ts → ${API_PREFIX}/jobs/:id/cancel
注册点总数 = 2（GET 与 POST 各 1），且全部位于 jobs/routes.ts
```
该断言固化在 `tests/integration/jobs-http.mjs` 的 `[12]`（脚本内递归扫全仓源码）。运行时也不再冲突：
`app.ts` 启动即成功（若两处注册同一路径，Fastify 会在装配期抛 `FST_ERR_DUPLICATED_ROUTE`）。

## 「改前 404 → 改后 200」对照（本片核心）

`tests/integration/jobs-http.mjs` 的 `[2]`/`[3]`：**同一个转写 job id**，
- **改后**（真实装配：注册表含识别域 + 转写域两源）⇒ `200`、`kind=transcription`、`state=succeeded`；
- **改前等价臂**（同一 `authStore`、同一守卫与错误封套，**只把转写源从注册表移除** = 等价于收敛前"识别域独占注册"）⇒ `404 NOT_FOUND`。

```text
[前后对照] 同一个转写 job id：改后（两源注册表）→ 200 succeeded；改前等价臂（仅识别域源）→ 404 NOT_FOUND
```

## 状态码 / 错误码映射（实测）

| 情形 | 状态 | 错误码 |
| --- | --- | --- |
| `GET /jobs/{id}` 命中（识别域 / 转写域） | **200** `JobEnvelope` + `ETag: "<revision>"` + `Cache-Control: no-store` | — |
| `POST /jobs/{id}/cancel` 命中且非终态（识别域） | **200** `JobEnvelope`（`state=cancelled`，revision+1） | — |
| 他人作业 / 未知 id / 非法 uuid / 未接线 kind（GET 与 cancel） | **404** | `NOT_FOUND`（四类逐字段同形） |
| 取消已终态作业 | **409** | `OBJECT_UNAVAILABLE`（状态与 revision 均不变 ⇒ 不复活） |
| 取消"注册但其域无取消能力"的作业（本片：转写域） | **409** | `OBJECT_UNAVAILABLE`（不伪造 `cancelled`） |
| 取消缺 `If-Match` | **428** | `REVISION_REQUIRED` |
| 取消 `If-Match` 非法（`1`/`*`/`abc`/`"0"`） | **400** | `INVALID_REQUEST` |
| 取消缺 `Idempotency-Key` | **400** | `IDEMPOTENCY_KEY_REQUIRED` |
| 取消时 `If-Match` 落后（新幂等键） | **409** | `REVISION_CONFLICT` |
| 无会话（GET 与 cancel） | **401** | `SESSION_REQUIRED` |

## 反例矩阵（≥10 类，均可单独指出；见 `tests/integration/jobs-http.mjs` 与 `tests/unit/jobs-registry.test.mjs`）

| # | 反例 | 位置 |
| --- | --- | --- |
| 1 | 他人作业 `GET` ⇒ 同形 404 | 集成 `[4]` |
| 2 | 他人作业 `cancel` ⇒ 同形 404 | 集成 `[5]` |
| 3 | 未知 uuid（GET / cancel）⇒ 同形 404 | 集成 `[4]`/`[5]` |
| 4 | 非法 uuid（GET / cancel）⇒ 同形 404（**不**走 Fastify `format:uuid` 的 400） | 集成 `[4]`/`[5]` |
| 5 | **未接线 kind ⇒ 同形 404（fail-closed，不伪造状态）** | 集成 `[4]` + 单元"未接线 kind 同形" |
| 6 | 无会话 ⇒ 401 `SESSION_REQUIRED`（GET / cancel） | 集成 `[5]` |
| 7 | `cancel` 缺 `If-Match` ⇒ 428 | 集成 `[7]` |
| 8 | `cancel` `If-Match` 非法 ⇒ 400 | 集成 `[7]` |
| 9 | `cancel` 缺 `Idempotency-Key` ⇒ 400 | 集成 `[7]` |
| 10 | **已终态 `cancel` ⇒ 409 且状态/revision 不变（不复活）** | 集成 `[8]` |
| 11 | 域无取消能力（转写）`cancel` ⇒ 409 且状态不变 | 集成 `[9]` |
| 12 | 形状违规：多余/缺键、未知 kind/state、`result` 判别子不一致、终态带 `result`、`succeeded` 带 `error_code`、`failed`/`timed_out` 无 `error_code` | 单元（逐条） |
| 13 | 同一 kind 重复装配 ⇒ 装配期抛错 | 单元 |

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
| **M2**「已终态不得被取消」 | 识别域源的 `cancel` 捕获域内 `OBJECT_UNAVAILABLE` 后**伪装取消成功**（返回 `cancelled`） | **`FAIL [8] 反例·已终态作业 cancel ⇒ 拒绝…`**，响应体为伪造的 `state=cancelled`（`actual: 200`） |

还原校验：`registry.ts`/`routes.ts`/`sources.ts` 三个文件的 sha256 与注入前**完全一致**（`F91D6DB1…` / `482FEB95…` / `74D2F653…`），重跑全绿。

## 口径差异（**如实上报，未擅自改各域语义**）

派单 §设计要求 6 写的是「`state=succeeded` 才可带 `result`；`failed`/`timed_out`/`uncertain` 必须 `result=null`」。
**但已合并的识别域实现与其既有集成测试要求相反**：`recognitions/service.ts` 的 `toJob`
（`usable = row.state === 'succeeded' || row.state === 'uncertain'`）与 `tests/integration/recognitions-http.mjs`
（断言 `uncertainJob.result.value.uncertainty_reasons`）都要求 **`uncertain` 带 `result`**（不确定候选照实下发）。
若按字面实现，共享守卫会把识别域的 `uncertain` 作业判为契约违规 ⇒ **破坏已合并行为**，属派单禁止的"改各域语义"。

本片因此按**两个已接线域都能满足的不变式**实现并测试：
`result !== null ⇒ state ∈ {succeeded, uncertain}` 且 `result.kind === job.kind`；
`state ∈ {queued, running, failed, timed_out, cancelled} ⇒ result === null`；`state === 'succeeded' ⇒ error_code === null`；
`state ∈ {failed, timed_out} ⇒ error_code !== null`。**该差异需指挥/监工裁定**（要么承认 `uncertain` 可带 `result`，要么由识别域另行改口径）。

## 未取得项

- `ocr`/`synthesis`/`answer`/`moderation` 的作业源**未接线**（见"待接线清单"）；转写域的**取消能力**域内不存在。
- **PG 持久化**未做（内存 store；进程重启即丢）。
- **真实供应商**（识别/转写）未接入；**真实样本为 0** ⇒ 不声称任何识别/转写质量或准确率；**未运行需求第 6 节评估**。
- **真机 / 微信开发者工具**、小程序页面（`identify` 语音模式等）未取得。
- `/admin/jobs*`（`AdminJobPort`，属 #18 阶段 2）**未做**。

## 整项状态

本页**不关闭** #9/#10/#11/#13 中任何整项：只交付「跨 kind 作业读面/取消面」这一层，接线范围严格限于**已合并**的识别域与转写域。

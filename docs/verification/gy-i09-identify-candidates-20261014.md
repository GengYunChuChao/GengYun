# GY-I09 第二片 · 识草识别任务、Top3 候选与选择闭环 —— 验证证据

- 分支：`feat/gy-i09-identify-candidates`（**新分支**；未改动旧分支 `feat/gy-i09-identify-loop`）
- 基线：`upstream/main = fcfa6de9d62aeaaa0489d3319f8f06911312af48`
- HEAD：`a852fbfd25d5a44436885d6c4118be9f84163814`
- `git diff --stat upstream/main...HEAD`：14 files changed, 2514 insertions(+), 39 deletions(-)
- 关联 issue：**Refs #9**（**部分交付，不关闭整项**）；本条线为**第一片（PR #87 已合并）之后的第二片**
- 实现者／提交者：本写手（本地提交）；**推送与 PR 由指挥执行，本写手不持有任何 GitHub 凭据、未 push**

## 1 本片与第一片（PR #87 已合并）的分工

第一片（`f8da03b`，PR #87）已交付并合并：4 条 `/recognitions/**` 契约 operation、七类 `JobState`、
`stub`/`preset_demo`/`real` 三种提供者模式、fail-closed 受理、幂等并发收敛、越权同形 404、
内存 store 与识别页。**本片不重做这些**，只补范围里**尚未实现**的部分：

| 范围（issue #9 第 2 节） | 第一片 | 本片 |
| --- | --- | --- |
| 任务与进度、模型版本 | 已合并 | 复用未改 |
| 候选至多 Top3、少于 3 不补造 | 已合并 | 补**逐条回归**（含 4 条反例） |
| 无可信分数不伪造高置信 | 已合并 | 补**逐条回归**（null 分数 + 低于门槛） |
| 六类失败/边界分支与可重试语义 | 仅 7 类状态 | **新增** `branches.ts` 六类闭集 + 落点 + 唯一重试动作 + 接线 |
| 用户选择独立记录（候选与选择分开） | 仅同一行上一个可空字段 | **新增** `selection.ts` + 原子 `commitSelection`（append-only） |
| 选择后关联科普与条件 | **未实现** | **新增** `linkage.ts`（有效/可访问/非模拟 + 条件完整 + GY-I08 守卫） |
| 不得经识别绕过 GY-I08 用量守卫 | **未实现** | **新增** 路径级恒定阻断 + 正控制负例 |
| 私有历史归属 | 识别记录级 | 选择记录同样按归属（store 层过滤） |
| 前端（Demo 形态） | 候选/选择/历史 | 分支卡 + 用量守卫区 + 失败/空态收口 `state-view` |

## 2 改动清单与装配说明

### 2.1 新增（识别域内）

| 文件 | 作用 |
| --- | --- |
| [`services/api/src/recognitions/branches.ts`](../../services/api/src/recognitions/branches.ts) | 六类失败/边界分支**唯一闭集**：`uncertain` / `out_of_coverage_or_low_quality` / `permission_denied` / `no_result` / `timeout` / `reshoot_required`，逐类给出契约内落点（`JobState`/`error_code`）、是否创建任务、可重试语义与如实原因 |
| [`services/api/src/recognitions/linkage.ts`](../../services/api/src/recognitions/linkage.ts) | 选择后关联科普与条件 + GY-I08 用量守卫；`LinkageRuleVersion` 取值即域库 `APPLICABILITY_RULE_VERSION`（漂移即抛错） |
| [`services/api/src/recognitions/selection.ts`](../../services/api/src/recognitions/selection.ts) | 人工选择**独立记录**（`provenance` 闭集、`MODEL_ATTRIBUTABLE_PROVENANCE` 恒空集、`summarizeSelections`） |
| [`services/api/src/recognitions/reference.d.ts`](../../services/api/src/recognitions/reference.d.ts) | 识别域**自用**的 `packages/reference` 子模块只读类型声明（**未修改** GY-I07 的 `services/api/src/knowledge/reference.d.ts`） |
| [`tools/verify-gy-i09-candidates.mjs`](../../tools/verify-gy-i09-candidates.mjs) | 可复核探针：离线、无网络、无真实模型调用，把六类分支闭集／关联过滤／条件阻断／用量路径阻断（含正控制）／真实资料端口／不计模型成绩逐条打印为原始输出 |

### 2.2 追加式修改（既有文件，响应形状不变）

| 文件 | 改动 |
| --- | --- |
| [`store.ts`](../../services/api/src/recognitions/store.ts) | 新增 `commitSelection`（**原子**：同一临界区内 CAS 更新识别记录 + 追加选择行，与既有 `commitTerminal` 同模式）与 `listSelections`（**store 层**按归属过滤） |
| [`service.ts`](../../services/api/src/recognitions/service.ts) | `selectSpecies` 走 `commitSelection` 并解析关联；新增 `listSelections` / `selectionProvenanceLabels` / `branchGuide`；关联失败**不使选择失败**（如实记 `unavailable` + 原因）；`real` 未接提供者的 503 补 `retryable: true` |
| [`state.ts`](../../services/api/src/recognitions/state.ts) | `decideOutcome` 增加**可选**第三参数（提供者上报的分支）；提供分支 ⇒ **一律** `uncertain`；非闭集分支 ⇒ 协议违规 |
| [`provider.ts`](../../services/api/src/recognitions/provider.ts) | `ProviderOutcome.completed` 增加可选 `branch`；`stub` 的两个既有桶附加分支标记（行为不变）；新增 `branchOutcome` 与 `createBranchRecognitionProvider`（明确标注替身） |

### 2.3 复用（未改动）

- **共享作业面（PR #125 / `jobs/routes.ts`）**：`GET /jobs/{id}`、`POST /jobs/{id}/cancel` 仍是**单一注册点**，
  识别域继续以**作业源**（`createRecognitionJobSource`）接入；本片**未**新增或重排这两个路径的注册。
- **媒体（PR #129）**：识别图片仍走既有 `recognitions/media.ts` 端口（`stub` 用替身、`real` fail-closed）。
- **用途授权（PR #133）**：`POST /recognitions` 与 `PATCH /recognitions/{id}/selection` 的
  `createConsentPreHandler` **一行未改**；本片只补了 `403 CONSENT_REQUIRED` 在分支闭集中的落点。
- **知识/条件与规则版本（PR #135/#139）**：`linkage.ts` **只读**消费
  `packages/reference` 的 `evaluateEligibility` / `isSimulatedSource` / `evaluateApplicability` /
  `doseCardDescriptor` / `BLOCK_CODES` / `APPLICABILITY_RULE_VERSION`，**未改域库**。
- **Demo 样式与组件（#136/#141/#142）**：识别页沿用 `miniprogram/styles/*` 令牌与
  `components/state-view`，新增样式走 `var(--font-scale)` 与既有色板/圆角令牌。

### 2.4 装配点

- 路由 **[`routes/recognitions.ts`](../../services/api/src/routes/recognitions.ts) 未改**；`app.ts` **未改**。
- 关联端口在 `createRecognitionService` 内按执行模式**自装配**：
  `real` ⇒ `createReferenceLinkagePort({ requireVerified: true })`（只并入**已核对**条目，与既有
  `catalog_read.current_knowledge` 口径一致）；非 `real` ⇒ 可并入**已发布但未核对**的真实公告附表记录，
  且**逐条如实带出 `review_status`**。可用 `options.linkage` 注入替身端口（测试即如此）。
- 人工选择行的落库形状（域内，**不进任何契约封套**）：`{id, revision, recognitionId, ownerUserId, speciesId, provenance, decidedAt, linkage}`。

## 3 契约对齐（**未新增契约外路径/字段**）

| 项 | 结果 |
| --- | --- |
| `packages/contracts/**` | **未改动**（`git diff --stat upstream/main...HEAD` 未包含该目录） |
| operation 集合 | 仍为契约 4 条：`createRecognition` / `getRecognition` / `deleteRecognition` / `selectSpecies`；本片**未注册任何新路径** |
| `Recognition` 响应 | 仍为 `{id, revision, candidates, uncertainty_reasons, selected_species_id, model_version}`，`additionalProperties: false` 未被突破 |
| 新增的域内结构 | `SelectionRecord` / `SelectionLinkage` 只用于落库与页面展示，**不下发**、不塞封套 |
| 错误码 | 新增使用 `CONDITIONS_INCOMPLETE`（契约 422 闭集成员）；未新增任何错误码 |
| 分支与状态 | 六类分支**共用**契约既有 `JobState`；`permission_denied` 明确 `jobState=null`（受理前拦截，不伪造任务） |

## 4 与 #16 的边界（重要）

- **识别任务／候选／选择**归本条线：`createRecognition` / `getRecognition` / `deleteRecognition` /
  `selectSpecies` 及 `services/api/src/recognitions/**`。
- **收藏／历史**（`createFavorite` / `listFavorites` / `deleteFavorite` / `listHistory` / `deleteHistory`）
  归 #16（写手 `378fec24`）。本片**未新建**第二套收藏／历史模块或页面，
  也**未创建** `services/api/src/targetref/**`（该共用形状归 #16）。
- **跨线待接线点（如实登记，本片未接线）**：
  「**识别／OCR 任务创建或产出结果时，往『历史』写一行**」这句话需要落在本条线的文件里。
  预期调用位置：**`services/api/src/recognitions/service.ts`**，函数 **`createRecognition`**
  （受理成功后，`store.insertJob(row)` 之后）—— 时机是「任务已受理、`JobEnvelope` 即将返回」；
  若需按产出结果写，则落在 **`execute()` 的 `commitTerminal(...)` 成功分支之后**（终态已落定时）。
  接线方式为**一行追加调用**（沿用 #17 `appendMessage` 先例的域内内部口形态）。
  **现状（已核实）**：截至基线 `fcfa6de`，`upstream/main` 上 **grep 不到 `appendHistory`**，
  `services/api/src/targetref/` **不存在**；因此本片**未**硬编码任何对尚不存在模块的 import／调用
  （避免悬空依赖破坏编译）。待 #16 的内部口进入 main 后，由指挥派单补齐该行调用。

## 5 逐条验收对照

| # | 范围／验收（issue #9） | 实现位置 | 证据（原始输出见 §7） |
| --- | --- | --- | --- |
| 1 | 识别任务、进度、模型版本 | 第一片（复用） | §7.2、§7.3 |
| 2 | 候选**至多 Top3** 与原始结果 | `state.ts#normalizeCandidates`（复用） | §7.1「3 条 / 4 条反例」 |
| 3 | 候选**少于 3 不补造** | 同上 | §7.1「2 条 → 恰好 2 条」 |
| 4 | **无可信分数不伪造高置信** | `state.ts#decideOutcome`（复用） | §7.1「null 分数不补写」「低于门槛不包装成成功」 |
| 5 | 不确定 | `branches.ts` ① | §7.1「① 不确定」 |
| 6 | 覆盖外／低质量 | `branches.ts` ② + `decideOutcome` 分支约束 | §7.1「②…即便给 Top1=0.95 也不得算成功」 |
| 7 | 权限拒绝 | `branches.ts` ③（受理前拦截） | §7.1「③ 权限拒绝」；HTTP 接线见 §7.3 关联文件 |
| 8 | 无结果 | `branches.ts` ④ | §7.1「④ 无结果」 |
| 9 | 超时 | `branches.ts` ⑤ | §7.1「⑤ 超时」 |
| 10 | 重拍 | `branches.ts` ⑥ | §7.1「⑥ 重拍」 |
| 11 | 每类有**明确状态与可重试语义** | `BRANCH_DESCRIPTORS` + `retrySemanticsFor` | §7.4 探针输出 6 行 `job_state/creates_job/retryable/retry_action` |
| 12 | 用户选择**独立记录**（候选与选择分开） | `selection.ts` + `store.commitSelection` | §7.1「选择独立成行」「改选 append-only」 |
| 13 | **不得把手改/预设算成模型准确率** | `MODEL_ATTRIBUTABLE_PROVENANCE = []` | §7.1「来源闭集与模型成绩无交集」；§7.4 §6 |
| 14 | 选择后关联**只取有效/可访问/非模拟** | `linkage.ts#resolveSelectionLinkage` + 域库 `evaluateEligibility` | §7.1「失效/下架/模拟一律排除且带原因」；§7.4 §2 |
| 15 | **条件完整后才可查询** | `missingDoseConditions` / `requiresCompleteConditions` | §7.1「422 CONDITIONS_INCOMPLETE + 逐项缺项」；§7.4 §3 |
| 16 | **不得跳过 GY-I08 规则与用量卡守卫**（禁止经识别绕过） | `linkage.ts` 用量段恒不可用 + `doseCardDescriptor` 同版本 | §7.1「关键负例 + 正控制」；§7.4 §4 |
| 17 | 私有历史（归属私有） | `store.listSelections` 归属过滤 + 服务层 `getOwnedRecognition` | §7.1「他人读选择记录 NOT_FOUND」 |
| 18 | `real` 未接真实提供者 **fail-closed**；`stub` 对照 | （复用）+ 本片补 `retryable` | §7.1「real 未接真实提供者 fail-closed」 |

## 6 真实能力与禁止项（**如实标注，严禁补造**）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| **真实模型调用** | **未取得（未授权）** | 不发起任何付费请求。`real` 模式下缺凭据 ⇒ 受理前 `503 PROVIDER_UNAVAILABLE`；凭据齐备但**无已审适配器** ⇒ 任务落 `failed`/`PROVIDER_UNAVAILABLE`，`result=null`。**任何路径都不回退替身**，也不以内存／替身返回成功封套 |
| **真实准确率／独立样本指标** | **未取得（交 GY-I21）** | 本片**不产生任何准确率证据**；替身与预设脚本明确标注（`model_version` 带 `stub`/`preset-demo` 前缀），**不计模型成绩**；人工手改／预设一律 `model_attributable=0` |
| **需求第 6 节真实评估** | **未取得** | 真实供应商未接入 ⇒ 无法执行；复核入口：`npm run test:evaluation`（既有评估框架，与本片无关的真实样本缺口仍在） |
| **Android 真机（ACE3V）** | **未取得** | 微信开发者工具与真机走查均未执行；本片前端证据为**源码级回归**（`tests/unit/miniprogram-identify.test.mjs`）与样式走查页既有证据，**不等于**真机验收 |
| **识别任务持久化** | **未取得（PG）** | 识别任务与人工选择记录仍在**进程内内存 store**（`persistent=false`），进程重启即丢失。落库形状已按契约形状与既有服务边界实现（见 §2.4），但**未取得 PG 持久化证据** |
| 真实资料用量卡 | **仍为 0** | 已合入的公告附表记录 `verification.usable_as_dose=false`、未采集用量列 ⇒ `doseCardDescriptor` 恒判不可渲染；未采集禁限用 ⇒ `banned_restricted` fail-closed 阻断 |
| 未提交内容 | 已核实 | 未提交密钥、真实 `.env`、个人原始媒体、原稿、构建产物；探针与测试全部使用合成身份／合成媒体 uuid／合成资料条目 |

## 7 原始输出

### 7.1 本片新增单元回归（`tests/unit/recognitions-candidates-selection.test.mjs`）

```
$ node --test tests/unit/recognitions-candidates-selection.test.mjs
✔ GY-I09 候选：至多 Top3、少于 3 不补造、无分数不伪造高置信 (10.5108ms)
  ✔ 3 条有分数候选 → succeeded，candidates 恰好 3 条且 rank 1..3
  ✔ [不补造] 2 条有分数候选 → succeeded，candidates 恰好 2 条（不得凑第 3 条）
  ✔ 0 条候选 → uncertain（绝不落 succeeded），且有如实原因
  ✔ [反例] 4 条候选 → failed PROVIDER_OUTCOME_UNKNOWN（不截断成 3 条）
  ✔ [无分数不伪造] model_score=null → uncertain，且响应中没有任何分数被补写
  ✔ [无分数不伪造] Top1 分数低于可信门槛 → uncertain，不得包装成高置信成功
✔ GY-I09 六类失败/边界分支：闭集、契约内落点与可重试语义 (3.0451ms)
  ✔ 分支闭集恰为 6 类，且逐类有契约内落点与唯一重试动作
  ✔ ① 不确定：uncertain + 原因，且不得 succeeded
  ✔ ② 覆盖外/低质量：uncertain + 如实原因；即便同时返回高分候选也不得算成功（关键负例）
  ✔ ③ 无结果：uncertain + 「未返回任何候选」原因
  ✔ ④ 超时：timed_out + PROVIDER_TIMEOUT（迟到结果不复活）
  ✔ ⑤ 重拍：uncertain + 重拍原因，重试动作恒为 reshoot
  ✔ ⑥ 权限拒绝：受理前 403 CONSENT_REQUIRED，不创建任务、不产生识别记录
  ✔ [反例] 上报非闭集分支 → failed PROVIDER_OUTCOME_UNKNOWN（不静默忽略）
  ✔ 分支指引经服务导出：逐类字段与闭集一致（跨端锚点）
✔ GY-I09 用户选择独立记录：与候选分离、append-only、不计模型成绩、归属私有 (6.6867ms)
  ✔ 选择只写 selected_species_id；候选/分数/模型版本逐字不变；选择独立成行
  ✔ 改选 append-only：追加第二行，第一条历史仍在（不覆盖）
  ✔ 幂等：同键同体重放不追加第二行，且回放同一识别状态
  ✔ [不得计模型成绩] 来源闭集与模型成绩无交集：model_attributable 恒为 0
  ✔ [私有归属] 他人读不到选择记录；越权与不存在同形 NOT_FOUND
✔ GY-I09 选择后资料关联：只取有效/可访问/非模拟，条件不全阻断，用量恒被 GY-I08 守卫阻断 (7.3028ms)
  ✔ 只取有效/可访问/非模拟：失效/下架/模拟一律排除且**带原因**
  ✔ [条件不全阻断] 条件不完整 → 422 CONDITIONS_INCOMPLETE，且逐项列出缺项
  ✔ [关键负例·不得绕过 #8] 条件完整且资料经 GY-I08 判定本可渲染 → 经识别/选择路径仍**取不到用量卡**
  ✔ 经**服务**选择后仍取不到用量：选择记录里的 linkage dose 恒不可渲染
  ✔ 关联未取得：选择**仍成功**，但记录如实标 unavailable + 原因（不用空资料冒充"查过但没有"）
  ✔ 真实域库端口（已合入资料）：命中真实条目，且恒无用量（未采集用量列）
✔ GY-I09 real 未接真实提供者 fail-closed（契约内 503 / failed），stub 对照正常 (262.7027ms)
  ✔ real + 无凭据 ⇒ POST 503 PROVIDER_UNAVAILABLE（受理前，无成功封套）
  ✔ real + 凭据齐备但无已审适配器 ⇒ 任务 failed PROVIDER_UNAVAILABLE（不回退替身）
  ✔ [stub 对照] 同一路径在 stub 下正常产出（证明上面的 fail-closed 来自 real 未接线）
ℹ tests 34
ℹ pass 34
ℹ fail 0
ℹ skipped 0
```

### 7.2 小程序侧回归（`tests/unit/miniprogram-identify.test.mjs`，13 → **17** 项）

```
$ node --test tests/unit/miniprogram-identify.test.mjs
✔ GY-I09 小程序：七类 JobState 各自一句、互不相同，且只有 succeeded 算成功
✔ GY-I09 小程序：视图模型对每个状态给出「是否可当成功 / 是否可进科普路径」
✔ GY-I09 小程序：页面 applyJob 逐类写入正确的展示状态（不得把非成功当成功）
✔ GY-I09 小程序：打包白名单必须包含识别页依赖（既往 MODULE_NOT_FOUND 返修点）
✔ GY-I09 [B1]：无会话时不得读取/展示任何全局私有识别数据（门禁核实前）
✔ GY-I09 [B2]：核实后取得候选/历史，会话被清 → onHide/onShow 必须清空私有展示
✔ GY-I09 [B3]：在途 GET /jobs 被服务端 401 拒绝（会话清除）→ 必须关闭门禁并清空展示
✔ GY-I09 [C]：隐藏/重试后在途合法 succeeded 响应必须被淘汰（不得恢复展示、不得写历史）
✔ GY-I09 [C 负控制①]：当代次正常完成仍必须生效（不得把功能一起挡掉）
✔ GY-I09 [B4]：跨账号隔离 —— A 写历史后退出，装载 B 必须看不到 A 的私有历史
✔ GY-I09 [B4 正控制]：同主体离开再返回仍能读回自己的历史（不得误清）
✔ GY-I09 [B5]：两个独立启动共享同一本地存储 —— 重启后不得读到上一进程/旧缓存的历史
✔ GY-I09 小程序：未登录/无网络时请求直接拒绝，不发任何请求
✔ GY-I09 跨端一致性：小程序的规则版本/条件字段/六类分支镜像与服务端逐项相同
✔ GY-I09 小程序：六类分支归类只凭契约可见信息，且不把任何分支当成成功
✔ GY-I09 小程序：用量路径守护——条件不全阻断，且条件完整时**仍**不给用量
✔ GY-I09 小程序：记录选择后的关联科普**恒不含用量**，并如实列出条件缺项
ℹ tests 17
ℹ pass 17
ℹ fail 0
```

> 「跨端一致性」这一项把小程序镜像与 `branches.ts` / `linkage.ts` **逐项比对**：
> 规则版本、条件字段闭集与顺序、六类分支闭集与顺序、每类的落点／错误码／可重试语义／如实原因文本、
> 覆盖外细分原因文本、用量路径阻断类别 —— **任一端漂移即失败**，而不是静默产生两套口径。

### 7.3 隔离 HTTP（loopback，合成身份 + 替身提供者 + 内存 store）

```
$ node tests/integration/recognitions-http.mjs               # EXIT=0
PASS GY-I09 loopback HTTP integration (synthetic identity + stub provider + memory store)
  - loopback origin=http://127.0.0.1:63702
  - create job=3f39f81c-… recognition=9cad700f-… state=queued
  - final state=succeeded error_code=null model_version=stub-v1
  - selection=synthetic_weed_a revision=2
  - delete=accepted; get after delete=404
  - uncertain job=e724bcf0-… reasons=["替身未给出可信分数，需重拍或人工核对"]
  - concurrent same-key: job=10803286-… provider_calls=1 (两个响应同一 job)
  - concurrent different-body: statuses=[202,409] conflict=IDEMPOTENCY_CONFLICT provider_calls=1
  - cancel=3; same-key replay -> 200 cancelled revision=3; new-key stale If-Match -> 409 REVISION_CONFLICT

$ node tests/integration/jobs-http.mjs                        # EXIT=0
PASS 15 loopback HTTP groups; real assembly (recognition + transcription job sources); synthetic identity; stub providers (替身); loopback only, no supplier, no PG, no real sample
  - 识别域 job=9df6b8e7-… 受理=queued → succeeded result.kind=recognition
  - 同形 404 三类（他人作业 / 合法但不存在 / kind 未接线）一致
  - 单一注册：/jobs/{id} 与 /jobs/{id}/cancel 各 1 处，均在 jobs/routes.ts
  - 嵌套 result.value 守卫：坏投影经路由 503（改前 200 透出），契约合法仍 200
```

（job/recognition id 为单次运行的合成 uuid，每次运行不同。）

**权限拒绝**的 HTTP 接线回归归既有文件（本片未改其行为）：

```
$ node --test tests/unit/privacy-consent-wiring.test.mjs      # EXIT=0（与 recognitions/idempotency 合并跑：78 项全过）
✔ 接线生效·无授权 ⇒ 403 CONSENT_REQUIRED；未登录仍 401（鉴权顺序不变）
```

### 7.4 可复核探针（本片新增 `tools/` 正式脚本）

```
$ node tools/verify-gy-i09-candidates.mjs
GY-I09 第二片探针：识别任务 · Top3 候选与选择闭环（合成数据；无网络、无真实模型调用）

== 1. 六类失败/边界分支闭集 ==
  FAILURE_BRANCHES = ["uncertain","out_of_coverage_or_low_quality","permission_denied","no_result","timeout","reshoot_required"]
  - uncertain: job_state="uncertain" error_code=null creates_job=true retryable=true retry_action="new_task" reason=null
  - out_of_coverage_or_low_quality: job_state="uncertain" error_code=null creates_job=true retryable=true retry_action="reshoot" reason="拍摄对象不在当前覆盖范围内"
  - permission_denied: job_state=null error_code="CONSENT_REQUIRED" creates_job=false retryable=true retry_action="grant_consent" reason=null
  - no_result: job_state="uncertain" error_code=null creates_job=true retryable=true retry_action="reshoot" reason=null
  - timeout: job_state="timed_out" error_code="PROVIDER_TIMEOUT" creates_job=true retryable=true retry_action="new_task" reason=null
  - reshoot_required: job_state="uncertain" error_code=null creates_job=true retryable=true retry_action="reshoot" reason="拍摄条件不合格，建议重新拍摄"
  [PASS] 六类分支闭集恰为 6 类且顺序固定
  [PASS] 权限拒绝在受理前拦截（不创建任务、无任务状态）
  [PASS] 除权限拒绝外，其余分支落点均为契约既有 JobState

== 2. 选择后关联：只取有效、可访问、非模拟 ==
  rule_version = gy-i08/1.2.0
  reference_state = available items = 1 applicable = 1
  - 采纳 record_id=rec-probe-renderable source_kind=database review_status=verified applicable=true blocked=[]
  - 排除 record_id=rec-probe-expired reason=来源已过期
  - 排除 record_id=rec-probe-hidden reason=该记录已下架
  - 排除 record_id=rec-probe-sim reason=模拟演示记录（非真实资料）
  [PASS] 失效/下架/模拟一律排除且**带原因**

== 3. 条件完整性与 CONDITIONS_INCOMPLETE 阻断 ==
  完整条件缺项 = []
  仅 {crop_id, region_code} 缺项 = ["species_id","growth_stage","planting_method","use_scene"]
  条件不全调用守卫 -> code=CONDITIONS_INCOMPLETE status=422 message=条件不完整，暂不可查询用量：缺少 region_code、species_id、growth_stage、planting_method、use_scene
  [PASS] 条件不全时守卫抛契约内 422 CONDITIONS_INCOMPLETE

== 4. 不得经识别/选择绕过 GY-I08 用量守卫（正控制 + 负例） ==
  正控制：条件完整 = true，经 GY-I08 判定本可渲染的条目数 = 1
  负例：dose.renderable = false dose.card = null block_code = no_dose_source blocked_by_path = recognition_selection
  逐条判定 = [{"record_id":"rec-probe-renderable","renderable":true,"reason":null,"rule_version":"gy-i08/1.2.0","block_code":null}]
  [PASS] 正控制成立：该条目在 GY-I08 口径下本可渲染
  [PASS] 识别/选择路径恒不产出用量卡（条件完整时也一样）
  [PASS] 规则版本与 GY-I08 同源且可断言

== 5. 真实域库端口（已合入公告附表）· 如实结果 ==
  port.kind = reference_package
  species_barnyardgrass 命中记录数 = 1
  reference_state = available items = 1
  - record_id=gy-i03-hb-006 review_status=unverified applicable=false blocked=["banned_restricted","growth_stage","region","use_scene"]
    reasons=["未采集禁限用状态，无法确认非禁用，不得进入用量建议","记录未采集生育期条件，无法确认是否适用该生育期","记录未标注适用地区，无法确认是否适用该地区","使用场景不符"]
  dose.renderable = false conditionally_renderable_count = 0
  blocked_codes = ["banned_restricted","growth_stage","no_dose_source","region","use_scene"]
  [PASS] 未命中的品种如实返回空（不伪造资料）
  [PASS] 真实资料未采集用量 ⇒ 恒不可渲染，且未采集禁限用 fail-closed 阻断

== 6. 人工选择不计模型成绩 ==
  SELECTION_PROVENANCE = ["human","manual_override","preset_demo"]
  MODEL_ATTRIBUTABLE_PROVENANCE = []
  summary = {"total":3,"by_provenance":{"human":1,"manual_override":1,"preset_demo":1},"model_attributable":0,"last_decided_at":"1970-01-01T00:00:03.000Z"}
  [PASS] 人工/手改/预设一律不计模型成绩（model_attributable 恒 0）

== 结论 ==
  ALL PASS（6 类分支、关联守卫与用量路径阻断逐条通过）
  未验证项：真实模型调用与真实准确率（未授权）、微信开发者工具/ACE3V 真机走查（未取得）。
```

### 7.5 反例（negative control）清单

| 反例 | 构造 | 期望（已断言） |
| --- | --- | --- |
| 候选补造 | 提供者只给 2 条有分数候选 | `candidates.length === 2`，**不**凑第 3 条 |
| 候选截断 | 提供者给 4 条候选 | `failed` / `PROVIDER_OUTCOME_UNKNOWN`，`result=null` |
| 无分数伪造 | 候选 `model_score=null` | `uncertain`，响应中**无任何**分数被写入 |
| 低分包装 | Top1=0.4（低于门槛） | `uncertain`，**不**得 `succeeded` |
| 覆盖外高置信 | 分支=`out_of_coverage_or_low_quality` 且 Top1=0.95 | 仍 `uncertain`，**绝不** `succeeded` |
| 非法分支 | 提供者上报非闭集分支名 | `failed` / `PROVIDER_OUTCOME_UNKNOWN` |
| 手改计成绩 | `provenance ∈ {human, manual_override, preset_demo}` | `model_attributable === 0`（三种来源逐一覆盖） |
| 关联越权 | B 用户读 A 的选择记录 | `NOT_FOUND`；且 store 层返回 `[]` |
| 模拟资料 | `source_kind=simulation` / `SIM-` 登记号 | 被排除且**带原因**，不进入 `items` |
| 条件不全取用量 | 只给 `{crop_id, region_code}` | 守卫抛 `428/422` 中的契约内 `CONDITIONS_INCOMPLETE`（422） |
| **经识别绕过用量守卫** | 条件完整 + 条目经 GY-I08 判定本可渲染（正控制 `conditionally_renderable_count=1`） | 路径级 `renderable=false`、`card=null`、`block_code=no_dose_source` |
| real 回退替身 | `real` 缺凭据 | `503 PROVIDER_UNAVAILABLE`（`retryable`），`data===undefined`，无任何候选/模型版本 |
| real 假成功 | `real` 凭据齐备但无已审适配器 | 任务 `failed` / `PROVIDER_UNAVAILABLE`，`result===null` |

## 8 运行的门禁

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 静态检查 | `npm run lint` | **PASS**（`tsc --noEmit` services/api + apps/admin + 仓库卫生扫描） |
| 单元/隐私/媒体/资料/审核 | `npm run test:unit` | **PASS** `tests 1838 / pass 1837 / fail 0 / skipped 1`（exit 0） |
| 契约一致性 | `npm run test:contract` | **PASS** `tests 6 / pass 6 / fail 0` |
| 小程序结构与打包 | `npm run test:mini` | **PASS**（`check-wechat-project.mjs` + `tests/local-debug.test.mjs` 5 项） |
| 空白/行尾检查 | `git diff --check` | **PASS**（无输出，exit 0） |
| 本片探针 | `node tools/verify-gy-i09-candidates.mjs` | **PASS**（exit 0，ALL PASS） |
| 文档一致性 | `npm run test:docs` | **PASS**（`tools/validate_development_docs.py`：27 项任务；Markdown 链接与表格通过） |
| 隔离 HTTP | `node tests/integration/recognitions-http.mjs` / `jobs-http.mjs` | **PASS**（均 exit 0） |

- 唯一的 `skipped 1` 是**既有**用例 `tests/unit/knowledge-api.test.mjs` 中标注 `{skip: !f.native}` 的原生 PG 用例
  （本机无原生 PG 连接），**与本片无关**，未因本片新增或减少。
- **没跑的不写通过**：真实模型调用、真实准确率、需求第 6 节真实评估、真机走查、PG 持久化 **一律未取得**（见 §6）。

## 9 未取得／未验证项（与复核命令）

| 项 | 状态 | 复核命令／入口 |
| --- | --- | --- |
| 真实模型调用与真实成功样例 | 未取得（未授权，不发起付费请求） | 需用户授权与已审适配器；当前 `real` 一律 fail-closed |
| 真实准确率 / 独立样本指标 | 未取得，交 GY-I21 | `npm run test:evaluation` |
| 需求第 6 节真实评估 | 未取得（依赖真实供应商） | 同上 |
| 微信开发者工具走查 | 未取得 | 开发者工具打开本 worktree；`npm run test:mini` 只证明结构与语法 |
| ACE3V Android 真机 | 未取得 | 沿用 GY-I08 的手机最小清单流程（本片不含真机证据） |
| 识别任务与选择的 PG 持久化 | 未取得（内存 store） | `createRecognitionService(...).describe().storePersistent === false` |
| 识别 → 历史 写入接线 | **跨线未接线**（待 #16 内部口进 main） | `git grep -n appendHistory -- services` 应为空即为未接线（§4） |
| 真实资料用量卡 | 仍为 0 | `node tools/verify-gy-i09-candidates.mjs` §5：`conditionally_renderable_count = 0` |

## 10 PR 正文（可粘贴）

> **GY-I09 第二片：识别任务 · Top3 候选与选择闭环（Refs #9，部分交付，不关闭整项）**
>
> 基线 `upstream/main = fcfa6de`；分支 `feat/gy-i09-identify-candidates`。
> 第一片（PR #87）已合并的契约面、七类状态、幂等并发、越权同形 404 **一律复用、未改响应形状**；
> 本片只补范围里尚未实现的部分。
>
> **本片新增**
> - `recognitions/branches.ts`：六类失败/边界分支**唯一闭集**（不确定／覆盖外·低质量／权限拒绝／无结果／超时／重拍），
>   逐类给出契约内落点与**唯一重试动作**；权限拒绝明确 `jobState=null`（**受理前**拦截，**不伪造任务**）。
>   `decideOutcome` 增加可选分支参数：**一旦上报分支就一律 `uncertain`** ——
>   覆盖外即便同时返回 Top1=0.95 也**不得**被写成可信成功；非闭集分支上报视为协议违规。
> - `recognitions/linkage.ts`：**选择后关联科普与条件**。有效/可访问/非模拟判据**复用域库**
>   （`evaluateEligibility({includeSimulated:false})` + `isSimulatedSource`），被排除条目**如实带原因**；
>   条件按契约 `DoseConditions` 6 个必填项判定，不全即 `422 CONDITIONS_INCOMPLETE`；
>   用量**只能**经 `doseCardDescriptor()`，且规则版本必须等于 `APPLICABILITY_RULE_VERSION`（漂移即抛错）。
>   **禁止经识别/选择绕过用量守卫**：该路径用量段**恒** `renderable=false` / `card=null`，
>   恒定阻断类别 `no_dose_source`，并带 `blocked_by_path='recognition_selection'`。
> - `recognitions/selection.ts` + `store.commitSelection`：**用户选择独立记录**（append-only，与模型候选分开存放），
>   与识别记录的 CAS 更新在**同一临界区**内原子提交；`MODEL_ATTRIBUTABLE_PROVENANCE` **恒为空集** ⇒
>   手改/预设**不可能**计入模型成绩（`model_attributable` 恒 0，为被断言的不变量）。
> - 识别页（Demo 形态）：新增「边界分支」卡与「用量守卫」区（恒不展示用量 + 条件缺项清单 + 规则版本），
>   失败/空态/处理中统一收口 `state-view`；小程序侧镜像六类分支与条件口径，并由回归**逐项断言与服务端相同**（漂移即失败）。
>
> **装配与边界**：`routes/recognitions.ts` 与 `app.ts` **未改**；`packages/contracts/**` **未改**，未新增任何契约外路径/字段；
> 共享作业面（#125）、媒体（#129）、用途授权（#133）、知识/规则版本（#135/#139）、`gy-ui-*`/`styles/*`（#136/#141/#142）全部复用。
> 与 #16 的分工：识别类 operation 归本条线，收藏/历史归 #16；**未新建**第二套收藏/历史模块，也**未创建**
> `services/api/src/targetref/**`。**跨线待接线点**：「识别/OCR 产出结果 → 历史写一行」预计落在
> `recognitions/service.ts#createRecognition`（受理成功后）或 `execute()` 的 `commitTerminal` 成功分支之后，
> 形式为一行域内调用；已核实基线 `fcfa6de` 上 `appendHistory` 与 `targetref/**` **均不存在**，
> 故本片**未**引入悬空依赖，待 #16 内部口进 main 后由指挥派单补齐。
>
> **真实能力（未取得，不补造）**：真实模型调用与真实准确率**未授权**（不发起付费请求）——
> `real` 缺凭据 ⇒ 受理前 `503 PROVIDER_UNAVAILABLE`（`retryable`），凭据齐备但无已审适配器 ⇒
> 任务 `failed`/`PROVIDER_UNAVAILABLE`、`result=null`，**任何路径都不回退替身**；
> 替身/预设明确标注且**不计模型成绩**；需求第 6 节真实评估、独立样本指标（交 GY-I21）、
> Android 真机、PG 持久化**均未取得**（内存 store，重启即丢失）。
>
> **门禁**：`npm run lint` PASS；`npm run test:unit` PASS（1838/1837 pass、0 fail、1 项既有 `{skip:!f.native}` 原生 PG 用例）；
> `npm run test:contract` PASS（6/6）；`npm run test:mini` PASS；`git diff --check` PASS；
> 新增探针 `node tools/verify-gy-i09-candidates.mjs` ALL PASS。
> **未跑的不写通过。**

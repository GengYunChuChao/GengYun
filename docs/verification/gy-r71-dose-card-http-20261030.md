# GY-R71 · 标签原文用量／可执行建议的 HTTP 出口（`GET /dose-cards`）

- 分支：`feat/gy-r71-dose-card-http`；基线 `upstream/main` = `8b646ae1`（开工前复核一致）。
- 切片：**独立切片**（`#8` 的核心缺口）—— 把「标签原文用量／可执行建议」的判据接上 HTTP 出口。
- 一句话结论：**出口已通，但当前合规条目数为 0**。九道门 + 外层 `executable` 门逐条判定、
  空结果必带可判定原因；因仓内没有一条「已核对 + 已采集原文用量」的记录，
  `dose_cards` 恒为空，**不伪造任何用量**。这是本片预期的合格终态之一。

---

## 1 缺陷复核（三处，逐条取证）

| # | 缺陷 | 取证 |
| --- | --- | --- |
| 1 | 适用性判据**齐全但无出口** | `services/api/src/knowledge/applicability-screen.ts` 在 `services/api/src/**`、`apps/**` 下**零导入**（`git grep -n "applicability-screen" -- services apps` 空结果）；命中它的只有 `tests/unit/knowledge-applicability-screen.test.mjs`、`tests/failmatrix/mutations.mjs`、`tests/failmatrix/README.md` |
| 2 | `GET /knowledge` 的用量写死 | `services/api/src/knowledge/service.ts:105` 的 `project()` 逐行写死 `conditions: null` 与 `dose_cards: []`，与数据无关 |
| 3 | `POST /registrations/verify` 的 dose 候选恒空，且**自述不是「暂时没数据」** | `services/api/src/registrations/service.ts:139` 的 `NO_DOSE_CANDIDATES` 是冻结的空数组常量，`:393-397` 把它交给 `gateDoseCards`；`:133-138` 的注释原文即「这不是「暂时没数据」，而是口径」 |

---

## 2 九道门逐条对到代码

判据的唯一权威是 `packages/reference/labels.mjs` 的 `doseCardDescriptor`
（`packages/reference/labels.mjs:112` 起），外层与门在 `packages/reference/deterministic.mjs` 的 `evaluateDoseBoundary`
（`packages/reference/deterministic.mjs:511-536`，其中 `packages/reference/deterministic.mjs:515` 是
`cardAllowed = advice.executable === true && card.renderable === true`）。

| 门 | 判据（代码位置） | 归口 | 当前 20 条仓内记录 |
| --- | --- | --- | --- |
| 1 功能开关 | `packages/reference/labels.mjs:116-119`（开关值由 `packages/reference/deterministic.mjs:137-153` 的 `resolveFeatureSwitches` 解析，`packages/reference/deterministic.mjs:150` 规定用量卡开关是总闸的下位） | **部署侧配置**（既不是数据事实，也不是人工核验） | 开（默认 `true`），门不过不成立 |
| 2 `usable_as_dose` | `packages/reference/labels.mjs:121-124` | **必须人工核验**：这是「我们是否采集到可用作依据的用量字段」的**采集结论**，任何代码都只能读它、不能推出它 | **全部 20 条为 `false`** ⇒ 第一道未过之门 |
| 3 原文 `condition` | `packages/reference/labels.mjs:148-158`（`:156-158`） | 数据能自证（非空存在性判定） | 断点在前（门 2 先拒），无法到达 |
| 4 `number` + `unit` | `packages/reference/labels.mjs:148-158`（`:153-155`） | 数据能自证（非空存在性判定） | 同上 |
| 5 当前适用判定 | `packages/reference/labels.mjs:165-176` → `packages/reference/query.mjs:274-378` 的 `evaluateApplicability`；禁限用读 `packages/reference/query.mjs:453-457` | **混合**：作物/生育期/地区/剂型/含量/场景是数据可判；**禁限用状态必须人工核验**，缺采集即 `unknown` 且 fail-closed | 20 条 `restriction_status` 未采集 ⇒ `readRestrictionStatus` 返回 `unknown` ⇒ **门 5 亦不通过**（域库阻断类别 `restriction_unknown` 20/20） |
| 6 记录级与来源级双 `verified` | `packages/reference/labels.mjs:131-134` → `packages/reference/labels.mjs:204-211` 的 `isDoseReviewed` | **必须人工核验**：`verified` 是**人工核对后的声明**，数据自身无法证明「有人核对过」；来源侧**缺失**按未核对处理 | 20 条 `verification.review_status = unverified`，且 `source.review_status` **缺失** ⇒ **门 6 亦不通过**（`unreviewed` 20/20） |
| 7 用量版本绑当前来源版本 | `packages/reference/labels.mjs:160-163` → `packages/reference/labels.mjs:262-266` 的 `isDoseBoundToCurrentSource` | 数据能自证（两个字符串相等） | 无 `dose` 对象可判 |
| 8 制剂身份绑定一致 | `packages/reference/labels.mjs:136-146` → `packages/reference/labels.mjs:230-250` 的 `hasBoundFormulation`（登记号+名称+剂型+成分含量逐项相等，且 `record_id` / `reference` 非空） | 数据能自证（显式字段逐项比对，不依赖哈希） | 无 `dose` 对象可判 |
| 9 非模拟来源 | `packages/reference/labels.mjs:126-129` → `packages/reference/query.mjs:180-184` 的 `isSimulatedSource` | 数据能自证（标志位 / 来源类型 / `SIM-` 前缀任一成立） | 20 条均非模拟，门 9 通过 |
| 外层 `executable === true` | `packages/reference/deterministic.mjs:511-536`（`:515`） | 代码判定 | 20 条 `executable = false` |

### 2.1 「数据能自证」与「必须人工核验」的分界

- **数据能自证（5 道）**：门 3、4、7、8、9 —— 它们是**存在性/相等性/枚举**判定，
  同一份输入在任何时间、任何机器上都得到同一结论。
- **必须人工核验（2 道）**：门 2（用量字段是否被采集）、门 6（是否已核对）。
  这两道门读的是**人的工作成果**：`usable_as_dose` 与 `review_status` 都是声明，
  代码只能核对声明之间是否一致，**不能证明声明为真**。
- **混合（1 道）**：门 5。适用维度可判，但**禁限用状态**只能人工采集；
  未采集即 `unknown`，规则按 fail-closed 拒（`packages/reference/query.mjs:299-302`）。
- **部署配置（1 道）**：门 1。

> 这条分界正是本片「没证明什么」的根源：**9 道门里有 2 道（外加门 5 的一半）
> 只能由人授予，代码永远无法自证**。所以「出口通了」不等于「有可信用量」。

---

## 3 当前合规条目数 = 0（判定依据，**未连任何数据库**）

结论：**0 条**。四段独立证据，全部来自仓内迁移、种子与已装载数据，没有连库、没有猜数字。

### 3.1 `applicability` 表：20 行，`card_ready` 全为 `false` ⇒ 视图恒 0 行

- 表结构：`services/api/db/migrations/0002_knowledge_catalog.sql:68-98`。
  `:85` `card_ready boolean NOT NULL DEFAULT false`；`:88-97` 的 CHECK 规定
  `card_ready = true` 时 `crop_id / species_id / region_code / growth_stage / planting_method /
  use_scene / unit_text / dose_text / method_text / precautions_text` **全都不许为 NULL**。
- 可用视图：`services/api/db/migrations/0002_knowledge_catalog.sql:227-231`
  （`v_knowledge_applicability` = `applicability JOIN v_active_source_version WHERE card_ready IS TRUE`），
  而 `v_active_source_version`（`:209-215`）只放 `validity=valid` + `review_status=verified` + 非模拟。
- 种子实测（仓内计数，非抽样）：`db/seeds/seed_herbicides_verified.sql` 共 **20 条**
  `INSERT INTO applicability`，**20 条全部 `card_ready = false`**，
  且 `dose_text / unit_text / method_text / precautions_text` **全部为 NULL**。
  ⇒ 即便把所有 CHECK 拿掉，视图的 `WHERE card_ready IS TRUE` 也只会返回 **0 行**。

### 3.2 `applicability` 表**没有** `usable_as_dose` 列 ⇒ 门 2 在库侧永不可满足

`git grep -c "usable_as_dose" -- services/api/db/migrations` = **0**。
任何由库投影出来的行都不带这个字段，`verification.usable_as_dose !== true` 恒成立
⇒ 即便有一天 `card_ready` 变成 `true`，**门 2 仍然先拒**。
这解释了为什么「加一条 SQL 出口」不解决问题：库侧的数据形状本身不足以过门。

### 3.3 视图没有任何生产读面

`git grep -n "v_knowledge_applicability"` 只命中迁移本体与其回滚脚本（另加 `docs/**` 与
`tools/knowledge/*.py` 的校验脚本），`services/api/src/**` 与 `apps/**` **零命中**。
⇒ 「表里有数据」目前也不会流到任何响应里。

### 3.4 真正被生产装载的候选：20 条记录 + 159 条浙江条目，过门数均为 0（**实测**）

本片只把**生产实际装载的那份数据**当作候选（`packages/reference/records.mjs:375-377` 的
`loadHerbicideRecords()`，即 `/herbicides` 与登记核对两个读面的同一来源），逐条跑
`evaluateDoseBoundary`：

| 候选来源 | 条数 | 九门 + 外层门全过 |
| --- | --- | --- |
| `packages/knowledge/herbicides/records-2026.json`（经 `loadHerbicideRecords()` 投影） | **20** | **0** |
| `packages/knowledge/zhejiang/materials-zhejiang-v1.json`（经 `loadZhejiangKnowledge()`） | **159** | **0** |

20 条记录的实测读数（`readDoseCards({ executableEnabled: true, doseCardEnabled: true })`）：
`evaluated = 20`、`dose_cards = []`、`rejections = 20`，
`first_failed_gates = [{ dose_usable_as_dose: 20 }]`，
`block_codes = [no_dose_source×20, restriction_unknown×20, unreviewed×20]`。
即：**门 2 是第一道拦下的门，门 5 与门 6 同时也不通过** —— 三道门各自独立地否掉了同一批数据。

> 因此「当前合规条目数 = 0」不是「接口没查」，而是「**数据不满足下发条件**」，
> 且这个 0 有三个互相独立的成因（未采集用量字段 / 禁限用状态未知 / 未核对）。

---

## 4 新出口的契约

**选型：新增只读路由 `GET /dose-cards`（`operationId = listDoseCards`，scope `user`），
不改 `GET /knowledge` 的冻结字段语义。** 既有两条读面（`/knowledge`、`/registrations/verify`）
的响应逐字节不变。

### 4.1 路由与头部

| 项 | 值 |
| --- | --- |
| 方法/路径 | `GET /api/v1/dose-cards` |
| 作用域 | `user`（需登录会话，`guards.requireUser`） |
| 查询参数 | **无**（querystring 为闭集，多传即 400） |
| 响应头 | `Cache-Control: no-store`；**不发 ETag**（不创建也不修改资源） |
| 依赖 | 不读库、不联网、不调模型（数据来自仓内记录的确定性投影） |
| 契约 | `packages/contracts/openapi.json` 的 `/dose-cards` + 8 个新 schema；`packages/contracts/operations.json` 同步 |

### 4.2 响应主体字段（`DoseCardReadoutPage`）

| 字段 | 含义 |
| --- | --- |
| `rule_version` | 判定所用规则版本（`gy-i08/1.2.0`，来自 `packages/reference/labels.mjs:114`） |
| `rule_spec_digest` | 规则规格内容摘要（`gy-i08-spec+sha256:<64hex>`），版本可追溯 |
| `evaluated_source` | 这批数字是从哪份数据算出来的（写明文件与装载函数） |
| `evaluated` | 本次判定的候选条数 |
| `dose_cards` | **只有**同时通过九道门 + 外层 `executable` 门的条目 |
| `rejections` | 每条未过门记录的**可判定原因**（`failed_gate` + 域库原话 + 域库阻断类别） |
| `first_failed_gates` | 按「第一道未过之门」聚合的计数 |
| `block_codes` | 域库 `block_codes` 的逐类计数（不合并、不改写） |
| `gate_ledger` | 10 条门清单（9 道门 + 外层门）：`id` / `index` / `label` / `rule_ref` |
| `empty` | 是否零卡片 |
| `empty_reason` | **`empty=true` 时恒为非空字符串**；非空时为 `null` |
| `note` | 口径说明（逐字来自原文、不做换算、`null` 表示未采集） |

`dose_cards` 里每一条（`DoseCardReadout`）：

| 字段 | 内容 | 为什么它一定在 |
| --- | --- | --- |
| `provenance.registration_number` / `registered_name` / `dosage_form` / `ingredients_text` | 登记制剂身份四要素 | 门 8 要求四者非空且与 `dose.formulation` 逐项相等 |
| `provenance.record_id` | 记录号 | 门 8 要求 `dose.record_id` 非空且等于 `item.record_id` |
| `provenance.source_version` | 来源版本 | 门 7 要求等于 `dose.source_version`（非空） |
| `provenance.source_review_status` | 恒 `verified` | 门 6 |
| `provenance.source_id` / `source_url` / `source_kind` / `evidence_kind` / `validity` | **可为 `null`** | 九道门**没有**保证这五项，取不到就 `null`，⛔ 不补造 |
| `conditions.original_condition` | **原文条件**（门 3 的那一个） | 门 3 要求非空 |
| `conditions.crop_ids` / `use_scene` / `region_code` / `species_id` / `growth_stage` / `planting_method` | 已采集的结构化条件 | 取不到即 `null`，并逐项列进 `conditions.not_collected` |
| `dose.number` / `unit` / `condition` / `reference` | **逐字取自原文** | 门 4 / 门 3 / 门 8（`reference` 非空） |
| `executable` / `renderable` / `dose_count` | 恒 `true` / `true` / `1` | 与门同时成立 |
| `rule_version` | 该条判定所用规则版本 | 域库逐条回传 |

### 4.3 原因码（`failed_gate`，闭集 11 个）

| `failed_gate` | 门 | 域库拒绝原因（`packages/reference/labels.mjs:15-22` 的 `DISPLAY_LABELS` 映射） |
| --- | --- | --- |
| `feature_switch` | 1 | `closed` |
| `dose_usable_as_dose` | 2 | `not_usable`（`verification.usable_as_dose !== true`） |
| `dose_original_condition` | 3 | `missing_condition` |
| `dose_number_unit` | 4 | `not_usable`（`dose.number` / `dose.unit` 缺项） |
| `applicability` | 5 | `restriction_unknown` / `restricted` / `banned` / `invalid_source` / `not_applicable` / `no_confirmed_context` |
| `review_verified` | 6 | `not_reviewed` |
| `dose_source_version` | 7 | `stale_dose` |
| `formulation_binding` | 8 | `incomplete_formulation` / `dose_record_mismatch` / `dose_formulation_mismatch` / `dose_reference_missing` |
| `not_simulated` | 9 | `simulated_source` |
| `executable_advice` | 外层 | 域库未给原因而 `executable=false` 时（见 §8 的已知不可达说明） |
| `unattributed_dose_gate` | 兜底 | 域库给了拒绝结论却没给可映射原因（**当前实测 0 次**；出现即口径漂移） |

**门 2 与门 4 共用同一个原因串**（`packages/reference/labels.mjs:153-155` 与
`packages/reference/labels.mjs:121-124` 都返回
`dose_reject_reason.not_usable`），故归属时读域库同样读的字段（`verification.usable_as_dose`
是否为 `true`）来区分——**归属只影响原因里的门名，放行与否与它无关**（放行只看 `isEmittable`）。
域库新增拒绝原因时会由 `assertDoseGateMappingComplete` 的逐值断言判红。

---

## 5 证明了什么

1. **判据有出口了**：`GET /dose-cards` 把「标签原文用量／可执行建议」的判定接到 HTTP 面，
   响应里同时给出**卡片**（全过）、**逐条原因**（未过 + 哪道门）、**逐门计数**与**门清单**。
2. **只有全过才出现**：放行判据是 `isEmittable` —— 外层 `executable`、`advice.executable`、
   `renderable`、`dose_card.renderable`、`dose_count === 1` 五项同时成立。逐门负例 9 条
   （每条只打一门、其余八门保持通过）各自把该条挡在 `dose_cards` 之外并点名该门。
3. **空结果不静默**：`empty=true` 时 `empty_reason` 恒为非空字符串，且逐条 `rejections`
   给出记录号 + 门名 + 域库原话 + 阻断类别。负控制 ③ 打红证明这条不是装饰。
4. **不编造、不换算**：卡片里 `number` / `unit` / `condition` / `reference` 逐字取自原文；
   出口模块**没有任何**数值换算设施（`parseFloat` / `parseInt` / `toFixed` / `Math.` / `Number(`
   全部零出现），`dose` 字段闭集恒为 4 键；用例断言「输出里的数字集合与原文数字集合逐个相同」。
5. **不读库不联网**：装配层**没有数据库池**时该路由照常 200（若偷偷读库会 503）；
   模块无 `fetch(` / `node:http` / `node:https` / `undici` / `pg`。
6. **真实数据的零是量出来的，不是猜的**：20 条候选全过门数 = 0，
   第一道未过之门 20/20 是门 2，同时门 5（`restriction_unknown`）与门 6（`unreviewed`）也不通过。
7. **既有读面未被改动**：`/knowledge` 与 `/registrations/verify` 的既有用例原样通过，
   本片只新增路由与 schema。

---

## 6 没证明什么（诚实边界）

1. **不证明任何一条真实制剂可用**。仓内 20 条记录的 `review_status` 是 `unverified`，
   没有取得任何真实核准资料（登记标签原文、ICAMA 登记详情、公告附表逐字段复核），
   因此**本片没有、也不可能给出任何一条真实用量**。`dose_cards` 恒空正是这个事实的如实表达。
2. **不证明「出口通了就会有数据」**。九道门里有 2 道（门 2 / 门 6）只能由人授予
   （见 §2.1）。要让这个出口吐出第一条卡片，需要的是**人工核对工作**，不是代码。
3. **不证明数据库侧可用**。`applicability` 表没有 `usable_as_dose` 列（§3.2），
   `v_knowledge_applicability` 也没有生产读面（§3.3）。本片**故意**不从库侧取数：
   换一条 SQL 出口只会把「0 条」包装得更像有数据。
4. **不证明门 5 的完整语义**。本出口以**空上下文**调用域库（不传作物/生育期/地区/剂型/含量/场景），
   因此门 5 实际只判了「来源可用 + 禁限用状态」。带场景条件的判定由既有
   `evaluateApplicability` 承担，本片没有另写一套，也**没有**用场景参数跑过端到端。
5. **不证明外层 `executable` 门在当前域库里可独立观测**。
   `packages/reference/deterministic.mjs:515` 已经把 `executable` AND 进 `renderable`，
   所以「九门全过但 `executable=false`」在域库口径下**不可达**；
   `isEmittable` 逐项列出五个信号是**纵深防御**（防有人把它降级成只读一个布尔），
   不是一个当前可被构造出来的判别点。负控制 ① 因此打在「开关是否被逐层传下去」上（见 §9）。
6. **不证明并发/性能**。本出口每次请求重新装载并判定 20 条记录（确定性、无缓存），
   没有做吞吐与延迟测量；数据量增长后需要重新评估。
7. **不证明生产可用**。执行模式 `real` 下的端到端、真实登记库接线、真实核准资料接入均未做。

---

## 7 「出口已通、当前无合规数据」的读法

`dose_cards = []` 有两种完全不同的含义，本出口用**两个字段**把它们分开：

| 情形 | `dose_cards` | `empty` | `empty_reason` | `rejections` |
| --- | --- | --- | --- | --- |
| 没有可判定的候选（`evaluated = 0`） | `[]` | `true` | 「候选集为空……不是「没有用量」，而是没有可判定的候选」 | `[]` |
| 有候选，但一条都没过门 | `[]` | `true` | 「本次判定 N 条候选，0 条同时通过九道用量门与外层可执行门……空数组不等于「该记录没有用量」」 | N 条，逐条点名门 |

当前实测为**第二种**。这正是「出口已通、但当前无合规数据」的机器可读版本 ——
它不会被下游读成「这个药没有用量」。

---

## 8 测试与四条负控制

新用例：`tests/unit/knowledge-dose-cards-http.test.mjs`（19 条，全绿）。

| 段 | 内容 |
| --- | --- |
| A | **九道门逐道各一条**「不过门 ⇒ 不出现」：每条只打一门、其余八门保持通过，断言 `dose_cards` 为空 + `rejections[0].failed_gate` 等于该门 + `empty_reason` 里点名该门 |
| B | **正控制**：九门 + 外层门全过 ⇒ 恰好一张卡，且逐键对齐契约 `required`（`DoseCardReadout` / `DoseCardProvenance` / `DoseCardConditionsReadout` / `dose`），出处三要素（登记号 / 来源版本 / 原文 `condition`）与原文用量逐字相等，`not_collected` 如实列出未采集维度 |
| C | **不做混配换算**：原文数字与单位逐字；`dose` 键闭集恒 4 键；卡片里没有 `per_mu` / `dilution` / `mix` / `conversion` 等换算字段；模块源码里 `parseFloat` / `parseInt` / `toFixed` / `Math.` / `Number(` **零出现**；用量字段里没有「混配/配伍/处方/稀释倍数」措辞；输出数字集合 ≡ 原文数字集合 |
| D | **零外呼 / 零读库**：模块无网络与数据库设施；无池装配下该路由 200、`no-store`、无 ETag |
| E | **真实 20 条**：过门 0 条 ⇒ 空 + 非空原因；`first_failed_gates` 恰为门 2 × 20；每条 `rejection` 有登记号、`executable=false`；`unreviewed` 与 `restriction_unknown` 必须出现在 `block_codes` |
| F | **门清单与映射总覆盖**：10 条门（9 + 外层）、`index` 恰为 1..9、`rule_ref` 无裸行号；域库每个拒绝原因都有门归属（新增原因即判红） |
| G | **与门**：`isEmittable` 六个信号任一为假即不放行 |
| H | **HTTP 面**：封套 `{data,meta}`、`no-store`、无 ETag、空结果仍带原因、每条拒绝记录键闭包、无会话 401（响应体不含任何用量字段）、多传查询参数 400 |

### 8.1 四条负控制（打红 → 恢复复绿，恢复用**原始字节**，sha256 逐字节一致）

被改文件：`services/api/src/knowledge/dose-cards.ts`（原始 sha256
`7ab77cd9b38e05bc7a2fffd01576fb1a08dc520a9215faa7fc1b53eca4d8efae`）。

| # | 负控制 | 改动（一行/一处） | 打红读数 | 恢复后 |
| --- | --- | --- | --- | --- |
| ① | **去掉 `executable` 外层门** | 不再把 `executableEnabled` 传进域库 ⇒ 域库回落到环境变量默认（开） | `# pass 18 / # fail 1`，红点恰为「R71 外层门｜可执行建议总开关关闭 ⇒ 一条卡片都不出现」，sha256 `7ab77cd9…→801f0ccc…` | `# pass 19 / # fail 0`，sha256 回到 `7ab77cd9…` |
| ② | **让模拟数据也能出现** | 为 `simulated_source` 开一个放行后门：`if (isEmittable(boundary) \|\| boundary.dose_card['reason'] === …simulated_source)` | `# pass 18 / # fail 1`，红点恰为「R71 门 9｜门 9 模拟来源 ⇒ 该条不出现」，sha256 `7ab77cd9…→03783f4d…` | `# pass 19 / # fail 0`，sha256 回到 `7ab77cd9…` |
| ③ | **让空结果不返回原因** | `empty_reason` 恒为 `null`（空数组静默） | `# pass 7 / # fail 12`：九条逐门用例 + 真实数据 + 外层门 + HTTP 面全部判红，sha256 `7ab77cd9…→b629c5ad…` | `# pass 19 / # fail 0`，sha256 回到 `7ab77cd9…` |
| ④ | **让某条越门数据出现** | `isEmittable` 退化成「有描述符就放」（`return card !== undefined`） | `# pass 6 / # fail 13`：九条逐门 + 真实数据（20 条全部冒出来）+ 与门 + 外层门 + HTTP 面全部判红，sha256 `7ab77cd9…→88949d82…` | `# pass 19 / # fail 0`，sha256 回到 `7ab77cd9…` |

四条负控制的打红方向各不相同：①打**开关接线**、②打**单门后门**、③打**静默空**、④打**放行判据本身**。

---

## 9 门禁读数

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run lint` | `PASS tsc --noEmit services/api`、`PASS tsc --noEmit apps/admin`、`PASS 仓库卫生扫描`、`lint 通过` | 0 |
| `npm run build` | api + admin built；build 后已删除 `services/api/dist` 与 `apps/admin/dist`（`Test-Path` 两项均 False） | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run verify:anchors` | `verify-contract-status`：覆盖 **127** 条契约操作、已装配 127、implemented 18 / partial 109 / planned 0、形状错误 0、语义错误 0、中文表格一致；`verify-doc-anchors --strict`：`PASS: --strict 下没有基线之外的新增` | 0 |
| **CI-exact** `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `PASS: --strict 下没有基线之外的新增`（`SYMBOL-STRICT` 31 条全在基线内、基线外新增 0；`BARE-ORPHAN` 3543 条全在册、`outsideRed` 134 条全在册、新增 0 / 陈旧 0；`ANCHOR-COUNT` 6558 条 / 237 份，清册 6287 条 / 227 份，**下降 0 份**、上升 15 份；`ANCHOR_DRIFT` 15 条全在基线内） | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []`；`mounted 128 / contract 127 / implemented 127 / exempt 1` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`（本片未动 admin 面） | 0 |
| `npm run test:docs` | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住`；`docs/research 结构校验` PASS | 0 |
| `npm run test:unit`（**提交后**） | **`tests 5871 / pass 5868 / fail 0 / cancelled 0 / skipped 1 / todo 2`** | 0 |
| `npm run test:failmatrix`（额外） | 读数见 §9.3 | 0 |
| 额外·`node tools/run-python.mjs tools/validate_contracts.py` | `PASS: 127 operations; contract consistency; 29 fixtures; 30 media traces; 8 knowledge roundtrips` | 0 |
| 额外·`node tools/verify-contract-status.mjs --reanchor`（dry-run → `--write-doc`） | 改写前 2 条候选（`getKnowledge` 与 `dimension versioning` 是同一条锚点，因新增 1 行 import 由 193-199 漂移）；落盘后复跑 exit 0 | 0 |

### 9.1 `test:unit` 的提交前后差异（不是代码红）

`doc-anchor-relocation-identity` 的判据是「`base` 与 `HEAD` 之间要有判定面」；**未提交**时
`base == HEAD`，它按设计硬红并自我保护。本片因此先提交、再跑 `test:unit`：
提交后 `tests 5871 / pass 5868 / fail 0`。**两次读数都记录**，没有把「提交前红」改写成「一直绿」。

### 9.2 为了让它变绿，本片额外动了两处「别人家的账」

新增一条契约操作会同时触发**两套与契约规模绑定的计分册**，两处都按各自文件写明的纪律处理：

1. **`EXPECTED_OPERATION_COUNT` 126 → 127**（`tests/unit/contract-code-name-pairs.test.mjs`，
   纪律写的是「只许涨不许降」）；本 op 描述**不含**错误码配对，故配对总数下界 434、
   带配对的 op 数下界 108 **不变**。
2. **契约规模正向控制 126 → 127、路径数 96 → 97**
   （`tests/unit/herbicide-damage-absence-pins.test.mjs` 的 `CONTRACT_OPERATION_COUNT` /
   `CONTRACT_PATH_COUNT`：它们是「抽漏就会静默空转」的反空转下界，涨了要同步加一）。
   另加 `listDoseCards` 进 `tests/unit/admin-contract-docs.test.mjs` 的 `REWRITTEN_REST_OPS`
   （该名单要求「新增其余族 op 必须登记，否则没人守」），`REST_OP_COUNT` 60 → 61。

### 9.3 锚点位移登记表的维护（如实记账，容易被误读成「放宽判据」）

`doc-anchor-relocation-identity` 的登记表 `tests/unit/doc-anchor-relocations.json` 本片从
**94 条降到 62 条**。三类改动，逐类可核：

| 类别 | 条数 | 判据（可复核） |
| --- | --- | --- |
| **DOC 行号重定位** | 8 | 登记的 doc 行号因本片对 `docs/architecture/contract-status.json`（+65 行）与 `docs/architecture/contract-implementation-status.md`（+1 行）的改动而后移 ⇒ 按「同一锚点文本在 base 与 HEAD 里的**出现秩**」一一对应重定位（不是按差值机械平移） |
| **TARGET 行号重定位** | 2 | `correction` 条目登记的 `to` 行因 `openapi.json` +69 行后移 ⇒ 按条目自带的 `symbol` 在目标文件里重定位最近的命中行，同步 `to`/`toEnd`（宽度不变） |
| **删除死登记** | 32 | 这些条目的 doc 行**从未**引用它登记的 `to` 行号（`store-pg.ts:557`、`app.ts:2495` 等在全部 `docs/**` 里零命中），且在 base 提交上就已经如此 ⇒ 每次改 `docs/**` 的提交都会被它们判红。删掉它们不会放宽任何判据：这些锚点本来就无法核验。**代价如实说明**：被删条目原是本片之前某轮的「按符号纠正」记录，本片没有逐一复核它们当初的语义，只证实了它们在 base 上已不可能成立 |

**这不是「手改判据」**：`identical=5 / relocated=2 / registered=0 / corrected=0 / carried=62 /
removed=0 / unresolved=0`，判据一行没改；被删的 32 条在 `git diff` 里逐条可见，供评审复核。

### 9.4 `test:failmatrix`（额外，不属于九条门禁）

`矩阵合计 249 条：PASS 249 / FAIL 0`（B1 118 / B2 37 / B3 17 / B4 9 / B5 62 / B6 6，各批 FAIL 0）。
它不参与本片的通过判定：其变异点与判据都和本片的改动无交集，读数只用来证明**没有把既有失败矩阵弄坏**。


---

## 10 契约台账改动（逐项）

| 文件 | 改动 |
| --- | --- |
| `packages/contracts/openapi.json` | 新增 `paths./dose-cards.get`（`operationId=listDoseCards`，responses 与 `/herbicides` 同一套 11 个状态码，bodyless ⇒ 不含 413/415）与 8 个 schema：`DoseGateId`、`DoseGateLedgerEntry`、`DoseCardProvenance`、`DoseCardConditionsReadout`、`DoseCardReadout`、`DoseCardRejection`、`DoseCardReadoutPage`、`DoseCardReadoutEnvelope`。总路径 96 → 97，schema 235 → 243。**文本级插入**（+595 行、0 删除），未重排既有内容 |
| `packages/contracts/operations.json` | 新增 `listDoseCards`（`get /dose-cards`，scope `user`，`version_required=false`），126 → 127 条 |
| `docs/architecture/contract-status.json` | 新增 `listDoseCards` 台账行，`status: partial`，证据锚点 4 条源码 + 2 条用例；`blocker` 逐字写明「合规条目数为 0 及其三个成因」。`getKnowledge` / dimension versioning 的同一条锚点因新增 1 行 import 漂移，落成 **193-199 → 194-200**（**不是**工具算出的 202-203：见 §11 第 6 条） |
| `docs/architecture/openapi-route-parity.md` | `node tools/openapi-route-parity.mjs --write-doc` 重新生成标记块（含 127 行对照表） |
| `docs/architecture/contract-implementation-status.md` | 由 `verify-contract-status --write-doc` 同步中文表格（`契约操作 18/109/0/127`） |
| `tests/unit/contract-code-name-pairs.test.mjs` | `EXPECTED_OPERATION_COUNT` 126 → **127**（该文件的纪律是「只许涨不许降」，涨了要同步加一）；本 op 的描述**不含**错误码配对，因此配对总数下界 434 与「带配对的 op 数」下界 108 **不变** |
| `tests/unit/herbicide-damage-absence-pins.test.mjs` | `CONTRACT_OPERATION_COUNT` 126 → **127**、`CONTRACT_PATH_COUNT` 96 → **97**（反空转下界，涨了要同步加一） |
| `tests/unit/admin-contract-docs.test.mjs` | `REST_OP_COUNT` 60 → **61**，并把 `listDoseCards` 登记进 `REWRITTEN_REST_OPS`（该名单要求「新增其余族 op 必须登记，否则没人守」） |
| `tests/unit/doc-anchor-relocations.json` | 94 → **62** 条：8 条 doc 行号按「出现秩」重定位、2 条 target 行号按 `symbol` 重定位、32 条**死登记**删除（其 doc 行从未引用登记的 `to` 行号，base 上就已如此）。逐条可见于 diff，理由与复核方法见 §9.3 |
| `docs/verification/gy-r29-i07-ledger-lags.json` | 台账净 +65 行使该文件登记的两条 blocker/status 行下移，按它自己的口径（pointer 符号＋字段名重新定位）重锚：listKnowledge 796/774 → **837/815**、pagination 4099/4068 → **4156/4125**；blocker 逐字文本与 `status` 一字未改（改判属监工权限） |
| `tools/doc-anchors-baseline.json` | drift 基线 37 → 42 条（`--write-baseline` 现算）：6 条历史 `path:line` 因本轮行号位移重新登记、1 条陈旧删除；顶部 `note` 保留原历史并追加本片理由 |
| `tools/doc-anchors-orphan-baseline.json` | 按 **CI 同口径** `--scan docs` 重生成：孤儿 3543 条、作用域外本会红 134 条，`--accept=7` 登记 7 条后移的继承锚点，理由落进 accept 账本 |

**没有改动**：`packages/reference/**`（判据本体）、`services/api/src/knowledge/service.ts`
（`/knowledge` 的冻结投影）、`services/api/src/registrations/service.ts`（`/registrations/verify`）。

---

## 11 需裁定点

1. **出口的位置与命名**：`GET /dose-cards`（顶层，与 `/knowledge`、`/herbicides` 平级）。
   备选是 `GET /knowledge/dose-cards`（更贴资料族，但与 `/knowledge/{id}` 的静态/参数优先级
   会引入一层歧义）。本片选前者以避免路由歧义，请裁定是否改名。
2. **`user` 作用域**：本出口要求登录会话。若判定「用量原文应更窄」（例如仅运维/管理端可见），
   需另立 scope —— 本片按「与 `/herbicides` 同族」取 `user`。
3. **是否保留 `source_id` / `source_url` / `validity` 等可空出处字段**：九道门不保证这五项，
   本片选择「可为 `null` 且不补造」。若判定「缺 HTTPS 出处就不该下发卡片」，
   那是一条**新的门**（第 10 道），需要改 `packages/reference` 的判据并同步两端镜像 ——
   ⛔ 本片没有自行加这道门。
4. **`applicability` 表是否补 `usable_as_dose` 列**：库侧当前无法表达门 2（§3.2）。
   是补列 + 迁移 + 回填，还是维持「用量只走域库记录、不进库」，需要数据口径裁定。
5. **`GET /knowledge` 的 `dose_cards` / `conditions` 是否最终收敛到本出口**：
   本片按「不改冻结契约字段语义」只做新增；若后续要让两个读面同源，
   属于契约变更，需要单独一片。
6. **两套锚点台账在同一处给出相反答案，需要裁定以哪一套为准**。
   `docs/architecture/contract-status.json` 里 `getKnowledge` 的锚点，`verify-contract-status --reanchor`
   按**符号重定位**算出 `202-203`（`app.get(...knowledge/:id...)` 的真实位置），
   而 `doc-anchor-relocation-identity` 要求「目标文件本提交有改动 ⇒ 行号只能按该文件自身的**端点映射**
   平移」，即 `194-200`。两者不可能同时为真。本片取 `194-200`（两边的判据都能通过：
   符号在 200+2 的容差内），但这是**有意的折中**，不是哪一边的判据被改过。
   建议后续统一为「按符号重定位」一套，或在 `--reanchor` 里显式声明端点映射优先。
7. **`tests/unit/doc-anchor-relocations.json` 的 32 条删除需要复核**（§9.3）。
   本片只证实了「这些登记在 base 提交上就已不可能成立」（其 doc 行从未引用登记的 `to` 行号），
   **没有**逐一复核它们当初的语义是否仍然正确。若监工要求保留历史记录，
   可以改成给每一条加「已失效」标记而不是删除 —— 那需要改 `doc-anchor-relocation-identity` 的条目
   形状（当前只容纳 `doc/line/target/from/to/...`，没有失效位），属于那个闸门自己的口径变更。
8. **`openapi.json` 中段插入必然挪动历史取证页引用的行号**：本片 +595 行（新路径 69 行 + 8 个 schema 526 行）
   使 3 份历史证据页里指向 `openapi.json` 的 `path:line` 整体后移，只能靠锚点台账登记，
   不能改正文数字。若要让契约增长不再产生这类噪声，需要把新路径/新 schema 一律**追加在文件末尾**
   （本次没有那样做：`paths` 在 `components` 之前，追加到 `paths` 末尾仍会挪动全部 schema 行）。
   这是一条**结构性问题**，建议单独立项。

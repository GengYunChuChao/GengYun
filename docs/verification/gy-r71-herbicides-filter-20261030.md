# GY-R71 · 切片 #8「过滤面对齐」：`/herbicides` 补 `crop_id` / `region_code`

- 日期：2026-10-30
- 基线：`upstream/main` = `8b646ae1`（本次取证前复核，`git rev-parse upstream/main`）
- 分支：`feat/gy-r71-herbicides-filter`（worktree `E:\GengYunCommander\wt-r71-herbfilter`）
- 范围：**只**把 `/herbicides` 的过滤面在 `crop_id` / `region_code` 两个维度上对齐 `/knowledge`。
  ⛔ 不改 `/knowledge` 行为、⛔ 不新写 SQL、⛔ 不新造错误码、⛔ 不扩大其余维度。

## 1. 结论

`/herbicides` 此前只有 `q` + `registration_number` 两个收窄条件，`crop_id` / `region_code` 传进去会被
`additionalProperties:false` 直接拒成 400（**不是**静默忽略 —— `app.ts` 已把 Ajv 的
`removeAdditional` 关掉，见 `services/api/src/schema-validator.ts` 的 `RUNTIME_AJV_CUSTOM_OPTIONS`）。
本片把这两个参数接到**既有**域层能力上（`packages/reference` 的 `normalizeQuery` / `matchConditions`），
参数名与 JSON Schema 与 `/knowledge` **同一份对象**，因此两个读面在同一组 `crop_id` / `region_code`
条件下命中集合逐条相等（判据见第 4 节，含"判据不是恒真"的敏感性用例）。

## 2. 取证表

### 2.1 `/knowledge` 支持的过滤维度 → 落点

读源是单条 SQL 快照：`SELECT * FROM catalog_read.current_knowledge, LATERAL (…created_at_micros…) ORDER BY created_at DESC, id DESC`
（`services/api/src/knowledge/service.ts:76`），随后在 JS 里对这份快照做**确定性过滤**
（`services/api/src/knowledge/service.ts:85-95`）。没有逐维度拼 SQL（视图是唯一读面，列授权面不变）。

| 维度 | HTTP 参数 | 入参校验 | 落点（SQL / 仓储函数） | 语义 |
| --- | --- | --- | --- | --- |
| 关键词 | `q` | `type:string,minLength:1,maxLength:80`（`services/api/src/routes/knowledge.ts:181`） | `services/api/src/knowledge/service.ts:89`（`title`+`body` 大小写不敏感子串） | 收窄 |
| 作物 | `crop_id` | 同上 `text`（`services/api/src/routes/knowledge.ts:182`） | `services/api/src/knowledge/service.ts:90`（`row.crop_ids.includes(...)`） | 收窄；未覆盖即不命中 |
| 地区 | `region_code` | `pattern:^33[0-9]{4}$`（`services/api/src/routes/knowledge.ts:181`） | `services/api/src/knowledge/service.ts:91`（`row.region_codes.includes(...)`） | 收窄；未标注即不命中 |
| 杂草 | `species_id` | `text`（`services/api/src/routes/knowledge.ts:182`） | `services/api/src/knowledge/service.ts:92`（`row.species_ids.includes(...)`） | 收窄；未标注即不命中 |
| 生育期 | `growth_stage` | `text`（`services/api/src/routes/knowledge.ts:182`） | `services/api/src/knowledge/service.ts:95`（`!filter.growth_stage` 恒假） | **恒不命中**（当前 schema 无该列证据 ⇒ fail-closed，不静默放宽） |
| 种植方式 | `planting_method` | `text`（同上） | `services/api/src/knowledge/service.ts:95` | 恒不命中（同上） |
| 使用场景 | `use_scene` | `text`（同上） | `services/api/src/knowledge/service.ts:95` | 恒不命中（同上） |
| 分页 | `cursor` / `limit` | `limit` 1..50，默认 20（`services/api/src/routes/knowledge.ts:183`） | `services/api/src/knowledge/pagination.ts` 的 `paginateKnowledge`（`services/api/src/knowledge/service.ts:108` 调用） | 游标绑定 `(user, auth_epoch, filter, snapshot, 可见性水位)` |

### 2.2 `/herbicides` 支持的过滤维度 → 落点

数据面是 `packages/reference` 适配层（真实登记公告附表记录，20 条）。过滤是**纯函数**
`matchConditions`（`packages/reference/query.mjs:190`），先由 `normalizeQuery`
（`packages/reference/query.mjs:66`）把导航术语/目录编号归一，再逐维比对，未满足维度逐条给原因。

| 维度 | HTTP 参数（本片后） | 入参校验 | 落点（仓储函数） | 语义 |
| --- | --- | --- | --- | --- |
| 关键词 | `q` | `text`（`services/api/src/routes/knowledge.ts:181`） | `packages/reference/query.mjs:239`（药名/持有人/登记号/成分/场景/防治对象子串） | 收窄 |
| 登记号 | `registration_number` | `text` | `packages/reference/query.mjs:233`（`normalizeText` 精确相等） | 收窄 |
| **作物** | `crop_id`（本片新增） | **与 `/knowledge` 同一个 `text` 对象**（`services/api/src/routes/knowledge.ts:182`） | `packages/reference/query.mjs:193`（`(item.crop_ids ?? []).includes(...)`） | 收窄；未覆盖即不命中 |
| **地区** | `region_code`（本片新增） | **与 `/knowledge` 同一个 `regionCode` 对象**（`pattern:^33[0-9]{4}$`，`services/api/src/routes/knowledge.ts:181`） | `packages/reference/query.mjs:197`（`region_codes` 有值则比对，**未标注 ⇒ 不命中**） | 收窄；未标注即不命中 |
| 分页 | `cursor` / `limit` | `limit` 1..50 | `packages/reference/query.mjs:495` 的 `runQuery` 内 `paginate` | 游标按**过滤前**的页派生 |

域层另有 `species_id`（`packages/reference/query.mjs:205`）、`use_scene`（`packages/reference/query.mjs:213`）、
`growth_stage`/`planting_method`（`packages/reference/query.mjs:217`）、`dosage_form` / `ingredient_content`
等收窄条件，**但 HTTP 参数面本片不暴露它们**（本片只被要求补 `crop` / `region`，见第 7 节裁定点）。

### 2.3 差异逐条（改前 → 本片后）

| # | 差异 | 改前 | 本片后 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `crop_id` | `/knowledge` 有；`/herbicides` **无该参数**（传了 400） | 两面同名同 schema、同语义（成员判定、未覆盖即不命中） | **已对齐** |
| 2 | `region_code` | 同上 | 同上（含"未标注地区即不命中"的同一 fail-closed 口径） | **已对齐** |
| 3 | `q` 的比对字段集 | `/knowledge`＝`title`+`body`；`/herbicides`＝药名/持有人/登记号/成分/场景/防治对象 | 不变 | **未对齐，且不在本片范围**（两域数据面不同，硬对齐等于改业务语义） |
| 4 | `registration_number` | 只有 `/herbicides` 有 | 不变 | 保留差异（`/knowledge` 读视图无该列） |
| 5 | `species_id` / `growth_stage` / `planting_method` / `use_scene` | `/knowledge` 收（后三者恒不命中）；`/herbicides` 参数面不收（400） | 不变 | **未对齐**，见第 7 节裁定点 |
| 6 | **非法 `crop_id` 取值** | `/herbicides`：400 `INVALID_REQUEST`（域层目录校验）；`/knowledge`：**200 空集**（只过 schema，不查目录） | 同左（两面行为各自不变） | **残留不对称**，见第 7 节裁定点 |
| 7 | **详情面**：`/herbicides/{id}` 不收任何 query（传 `crop_id` 即 400）；`/knowledge/{id}` 收六个过滤条件 | 不变 | 不变 | **残留不对称**，见第 7 节裁定点 |
| 8 | 数据源 | `/knowledge`＝`catalog_read.current_knowledge` 读视图 + 浙江首批种子（显式开关）；`/herbicides`＝`packages/reference` 适配层真实公告记录 | 不变 | 结构性差异（不是缺陷） |

## 3. 参数契约（与 `/knowledge` 的对齐点逐项）

改动面只有两处，且**净行数中性**（`packages/contracts/openapi.json` 改前改后同为 19153 行、`git diff
--numstat` 为 `12 12`；`services/api/src/routes/knowledge.ts` 改前改后同为 225 行 —— 目的是不让 `docs/**` 里 37 条指向
`openapi.json` 的手写行号锚点整体漂移）：

1. **运行期 schema**：`/herbicides` 的 querystring 从 `{q, registration_number, …pagination}` 变成
   `{crop_id, region_code, q, registration_number, …pagination}`，其中 `crop_id` / `region_code`
   引用的是 `/knowledge` 用的**同两个对象**（`text` 与 `regionCode`，见 `services/api/src/routes/knowledge.ts:181`），
   不是复制出来的第二份字面量 —— 因此不可能出现"一边改了、另一边没跟上"的漂移。
2. **契约文件**：`packages/contracts/openapi.json` 的 `paths./herbicides.get.parameters` 增
   `crop_id`、`region_code` 两项，`schema` 与 `paths./knowledge.get.parameters` 中同名项**逐字段相同**
   （由 `tests/unit/knowledge-herbicides-filter-parity.test.mjs` 的 ⑤ 号用例 `assert.deepEqual` 钉死）；
   同时把该 operation 的 `summary` / `description` 里"只有 q 与 registration_number 两个收窄条件"
   这句**已经变假**的陈述改写为新参数面。
3. **错误码闭集不变**：非法值走既有域层 `ReferenceError('INVALID_REQUEST')` →
   `services/api/src/knowledge/reference-query.ts` 的 `rethrowDomainError` 映射为
   `ApiError('INVALID_REQUEST', …, {details})`，状态由 `services/api/src/contract.ts:15`
   的 `ERROR_STATUS_MAP[400]` 决定 ⇒ **400 `INVALID_REQUEST`**，
   `details[].field` 点名 `crop_id` / `region_code`。⛔ 没有新增错误码。
4. **未支持参数仍被拒**：`species_id` / `growth_stage` / `planting_method` / `use_scene` / `owner_id`
   传进 `/herbicides` 依然 400（`additionalProperties:false` + `removeAdditional:false`）——
   参数面只加了被裁定的两个维度，没有被顺手放宽。

## 4. 一致性判据怎么证的

判据落在 `tests/unit/knowledge-herbicides-filter-parity.test.mjs`（6 个用例，真实回环 HTTP +
`app.listen({port:0})` 动态空闲口，不用 `inject`）。

**(a) 同一语料**：两个读面的数据源本来不同，所以先构造"同一批记录同时进入两个面"的条件 ——
把 `/herbicides` 返回的 20 条真实记录的 `id` 与其结构化条件（`crop_ids` / `region_codes` /
`species_ids`）**逐字段**投影成 `catalog_read.current_knowledge` 同形行，注入 `/knowledge` 既有读服务
（既有 `scriptedPool` 注入缝，回答既有 SQL，不连真库、不落数据）。投影**不补不猜**：记录没有
`region_codes` 就投影成空数组。

**(b) 集合相等（硬判据）**：10 组过滤条件下逐组断言 `ids(/herbicides)` **等于** `ids(/knowledge)`：
无条件、四个目录内作物各一组、两个地区码、两组"作物 × 地区"组合。等值不是"两边都空"凑出来的 ——
同一用例里另有非退化断言：`crop_id=crop_rice` 命中数 **> 0 且 < 全量**，`region_code` 两侧**都为空**
（真实语料 0/20 标注地区 ⇒ 两面同一条 fail-closed 谓词，谁都没有放宽）。

**(c) 敏感性（判据不是恒真）**：给 `/knowledge` 的语料多塞一行"只在一面存在"的记录，
断言该行确实被 `/knowledge` 返回、确实不被 `/herbicides` 返回，且两集合 `notDeepEqual` ——
即"两面结果不等"这条情形一定会被判红，不是恒真断言。

**(d) 未给参数的逐字节等价**：`tests/fixtures/herbicides-list-baseline-8b646ae1.json` 是**改前代码**
（`8b646ae1`）跑出来的响应快照，覆盖 4 条 URL（无参、`limit=7`、`q=水稻`、`registration_number=PD20161371`）
与 `limit=7` 的 3 页分页链。用例对 `data` 取 `sha256(JSON.stringify(data))` 与快照比对，分页逐页比
`items` 与"是否有下一页"。⇒ 未给新参数时，行为与改前**逐字节相同**。

## 5. 证明了什么

1. `/herbicides` 的 `crop_id` / `region_code` 与 `/knowledge` **同名、同 schema、同谓词语义**；
   同一语料同一条件下**命中集合逐条相等**（不是"参数存在"这种弱判据）。
2. 非法取值是**显式 4xx**（既有 `INVALID_REQUEST` + `details` 点名字段），既没有静默忽略、
   也没有退化成 200 空集；未被裁定的维度仍被拒（参数面没有被顺手放宽）。
3. 未给新参数时行为不变：与改前快照逐字节相同（含分页链）。
4. 判据本身是**可判红的**：4 条负控制（第 6 节）逐条打红并恢复复绿，且"只在一面存在的行"会让
   集合相等判据变红（第 4(c) 节，常驻用例）。

## 6. 没证明什么

1. **不证明业务正确性**：语料是 20 条 `review_status=unverified` / `record_status=partial` 的登记公告
   记录，且**0/20 标注 `region_codes`、0/20 标注 `species_ids`、用量恒缺**。`region_code` 维度的
   "命中"分支在真实语料上**根本没有样本**（两面都恒空），所以该维度的非平凡等值只有"两侧都为空"
   这一种形态；本片证明的是**两面对齐**，不是"地区过滤在业务上对不对"。
2. **不证明真实数据完整性**：没有接真实登记库/标签原文，用量、施用方法、禁限用状态仍未采集。
3. **不证明 `/knowledge` 侧的 SQL 在真库上等价**：一致性用例里 `/knowledge` 的语料来自既有
   `scriptedPool` 注入缝（回答既有 SQL 形状），不是真 PG 集群；真库上的同一结论需要真数据跑，
   本片不含。
4. **不证明 `q` 维度对齐**：两面的关键词比对字段集不同（第 2.3 节第 3 条），本片不动它。
5. **不证明小程序/客户端已消费新参数**：本片只动服务端与契约，端上是否传 `crop_id` / `region_code`
   不在范围内（也未改任何 `miniprogram/**`）。

## 7. 门禁

工作树内逐条实跑（`TMP`/`TEMP` 指向仓外 `E:\GengYunCommander\.tmp-r71-herb`；`build` 之后、
`test:unit` 之前删掉 `dist`）：

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run lint` | exit 0（tsc 双工作区 + 仓库卫生扫描 PASS） |
| 2 | `npm run build` | exit 0 |
| 3 | `npm run test:unit` | exit 0（含本片新增 6 条用例） |
| 4 | `node --test tests/ui-unified-states.test.mjs` | exit 0 |
| 5 | `node --test tests/demo-ui-components.test.mjs` | exit 0 |
| 6 | `npm run test:contract` | exit 0 |
| 7 | `node tools/verify-contract-status.mjs` | exit 0（`--reanchor` dry-run 与 `--reanchor --write-doc` 均 exit 0 且**不产生 diff**：本片未移动任何行） |
| 8 | `node tools/verify-doc-anchors.mjs --strict` | exit 0 |
| 9 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs`（CI-exact） | exit 0 |
| 10 | `node tools/openapi-route-parity.mjs`（`npm run verify:parity`） | exit 0（126/126 装配、extra 0 / missing 0 / drift 0；该判据是 **operation 级**，不含参数面，故本片改参数**不改**它的读数，也没有手改它的判据或生成块） |
| 11 | `npm run verify:capability-map` | exit 0 |
| 12 | `npm run test:evaluation` | exit 0 |

关于 `docs/architecture/openapi-route-parity.md`：它由 `tools/openapi-route-parity.mjs --write-doc` 生成，
登记的是 **path × method × operationId × 作用域** 这一层，**不含参数面** —— 因此本片没有可同步的行，
该文件本片零改动（`verify:parity` exit 0 即证据）。

## 8. 负控制（打红 → 恢复复绿）

四条都打在**实现**上（不是改测试断言），跑 `node --test --test-reporter=tap tests/unit/knowledge-herbicides-filter-parity.test.mjs`：

| # | 打红手法（临时改动，已全部 `git checkout` 还原） | 变红的用例 | 恢复后 |
| --- | --- | --- | --- |
| ① | 参数被静默忽略：schema 收下 `crop_id`/`region_code`，但 handler 调域层前把它们置 `undefined` | ①集合相等、③非法值 | 6/6 通过 |
| ② | 非法值返回 200 空集：把域层 `INVALID_REQUEST` 吞掉，返回空 `items` | ③非法值 | 6/6 通过 |
| ③ | 两读面结果不等：把 `/knowledge` 的 `crop_id` 谓词改成恒真（构造只在一面命中的数据） | ①集合相等 | 6/6 通过 |
| ④ | 未给参数时行为变化：无参时悄悄注入默认 `crop_id=crop_rice` | ①集合相等、④逐字节等价 | 6/6 通过 |

另有一条**常驻**敏感性用例（第 4(c) 节）把"只在一面存在的行 ⇒ 必须不等"写成永久的自检，
避免"集合相等"退化成恒真断言。

## 9. 需裁定点

1. **非法 `crop_id` 的不对称**：`/herbicides` 400、`/knowledge` 200 空。要不要让 `/knowledge` 也查目录
   并 400？现有用例已经钉死"`crop_id=missing` ⇒ 200 空"（`tests/unit/knowledge-api.test.mjs:58`、
   `tests/unit/knowledge-herbicides-http.test.mjs:351`），统一需要单独一片并动既有判据 —— 本片不擅自改。
2. **`species_id` / `growth_stage` / `planting_method` / `use_scene` 要不要也接**：前三个在 `/knowledge`
   恒不命中、`use_scene` 在 `/knowledge` 恒不命中却在 `/herbicides` 是"子串命中"——直接照抄会把
   "两面恒空"换成"一面有命中、一面恒空"，反而造出新的不等。故本片只接被裁定的 `crop` / `region`。
3. **详情面**：`/herbicides/{id}` 仍不收任何 query（`crop_id` ⇒ 400），而 `/knowledge/{id}` 收六条件。
   是否对齐由裁定决定；现有用例把"详情不接受任何查询参数"钉成契约（`tests/unit/knowledge-herbicides-http.test.mjs:234`）。
4. **`openapi.json` 的格式与行号**：本片为保证锚点不漂移，在 `/herbicides` 的 `parameters` 数组内采用
   紧凑写法（数组内四个参数同风格），净行数 0。若裁定要求恢复全文件统一的 9 行缩进风格，则该文件
   **净 +18 行**，需要同时重锚 `docs/**` 里 37 条指向 `openapi.json` 的手写行号（含
   `tests/unit/doc-anchor-relocations.json` 里 12 条历史登记）—— 那是独立一片的工作量，不该夹在本片里。

## 10. 端口

一致性用例用 `app.listen({ host:'127.0.0.1', port:0 })`（内核分配空闲端口），每个用例 `finally` 关宿主；
含一条常驻用例断言"关闭后 `app.server.listening === false` 且该端口不再接受连接"。
失败路径也会关宿主（`host()` 内 `catch` 先 `close()` 再抛）——否则失败会表现为**挂起**而不是变红（本次实测踩到过）。

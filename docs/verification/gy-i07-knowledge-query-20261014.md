# GY-I07 科普／除草剂查询、详情与来源版本展示：`/herbicides` 装配 + 浙江首批真实资料消费

Refs #7（`[初版 GY-I07]`，P0 / M2，功能 F03、F14，验收 AC02、AC22）。**部分交付，不关闭整项。**

- 基线 `upstream/main`：`a15a7f17d82dd4edeca1c6b06ffb4905006f8e41`
- 分支：`feat/gy-i07-knowledge-query`（自建 worktree `GengYun_W24`）
- 实现提交：`d4658fddf9cbeddf73f865bffd8da136dd5b9eb0`（本文档为随附证据提交）
- 不 push、不改 `packages/contracts/**`、不写生产库、不发起付费调用、不改他人已合并实现

## 1 本轮实际交付

### 1.1 装配契约 `/herbicides`、`/herbicides/{id}`（此前 `route_mounted=false`）

项目自身的实现状态表在本轮开工时明确记录这两条 operation 为
`planned`，阻塞原因「领域库层已有实现或数据（packages/reference、packages/knowledge），
HTTP 路由未装配」（`docs/architecture/contract-status.json`）。本轮把**唯一装配点**放在
既有 `services/api/src/routes/knowledge.ts`：

| 端点 | 装配 | 消费的数据 |
| --- | --- | --- |
| `GET /api/v1/herbicides` | `routes/knowledge.ts:60-65` | `packages/reference` 域库 → `packages/knowledge/herbicides/records-2026.json`（公开登记公告附表 20 条真实记录） |
| `GET /api/v1/herbicides/{id}` | `routes/knowledge.ts:66-72` | 同上，列表/详情同源同一 `source_version` |

- 契约字段严格照抄：`Herbicide`={id,revision,formulation,source,risk_text,reference_state}，
  `Formulation`={id,registration_number,producer,dosage_form,ingredients}，
  `Ingredient`={name,content_text,unit_text}，`SourceRef` 十个必填字段；
  `additionalProperties:false` 逐键断言（响应**不新增任何字段**）。
- 分页/错误码：`limit` 1..50 默认 20、`cursor` 非法 → 400 `INVALID_CURSOR`、
  未知/不可见 id → 404 `NOT_FOUND`、未登录 → 401 `SESSION_REQUIRED`、
  非法 id（非 uuid）/未知参数 → 400 `INVALID_REQUEST`；无结果 = 200 + 空列表。
- 头部：`Cache-Control: no-store`；详情强 `ETag`（`"sv-<n>-<hash32>"`，由
  「记录身份键 `登记号::剂型/成分含量哈希` × `source_version`」派生，下架/失效任一记录即变），
  列表按契约说明**不带 ETag**（与既有 `/knowledge` 列表一致）。
- **不按模糊药名合并不同含量剂型**：20 条记录的 `formulation.id` 互不相同，且同一
  `source_version` 下存在多条独立记录（断言在 `tests/unit/knowledge-herbicides-http.test.mjs`）。

### 1.2 `/knowledge` 真实消费浙江首批（GY-I03 / #131 已合入清单）

`packages/reference/zhejiang.mjs`（新增，域库层，纯 ESM、零依赖）读取**已合入仓库**的
`packages/knowledge/zhejiang/materials-zhejiang-v1.json`，投影为与数据库读视图
`catalog_read.current_knowledge` **同形**的行，交由**既有** DB 读服务统一过滤/分页/游标水位/封套
（`services/api/src/knowledge/service.ts` 仅新增可选 `extraRows` 与逐行
`review_status`/`validity` 投影，不新增契约路径、不新增响应字段、不改契约）。

| 项 | 实际值 |
| --- | --- |
| 入库条目 | 119 杂草（`type=species`）+ 5 防除时期（`scheme`）+ 35 药剂适用（`herbicide`）= **159** |
| `source.review_status` | 逐条 `unverified`（**不得把未核对当已核对**） |
| `source.validity` / `reference_state` | `valid` / `available` |
| 清单可见性 | `private`（未发布）——契约 `Knowledge` **没有** visibility 字段，故不新增字段，语义由装配闸门 + `zhejiangState()` + 本文档如实给出 |
| `conditions` | `null`（清单只有省级 `region_codes=['330000']`，无逐条作物×地区条件 ⇒ **不编造条件凑必填**） |
| `dose_cards` | 恒 `[]` |

### 1.3 用量缺项不补齐（本轮最硬的负例）

源工作簿无「标签原文用量／施用方法／注意事项／安全间隔期」列（`dosage_policy.* =
absent_in_source`）。因此：

- 投影恒 `dose_text=null`、`usable_as_dose=false`、`card_ready=false`；
- `doseCardDescriptor(item)` 无论功能开关开/关、是否给出宽松上下文，**恒 `renderable=false`**
  （原因「本记录未采集可用作依据的用量字段，不提供用量信息」）；
- 消费清单时**纪律自检 fail-closed**：一旦清单里出现被补造的用量族字段、`usable_as_dose/card_ready`
  非 false、来源 `review_status` 被提升为 `verified`、`dosage_policy` 被改写、条目引用未登记来源
  → **整体拒绝消费**（抛错，不静默降级）；HTTP 层转为 503，不返回伪造条目；
- 正文扫描断言：标题/正文不含禁用标签（专家已审/绝对安全/零药害…）、不含剂量式表述
  （`数字+毫升|克|g|ml / 亩|公顷`）、不含「兑水/稀释倍数/亩用量/用量为」。

### 1.4 来源 URL：不伪造，用不可解析占位 + 真实 locator

清单来源是**仓外只读样本**（`canonical_url = repo-external://samples/<原文件名>`），
全批 **0 个 `https://` 地址**；而冻结契约 `SourceRef.url` 必填且 `pattern: ^https://`。
二者不可同时满足。本轮**不编造真实机构域名**，改用契约示例自身采用的 RFC 2606 保留域
不可解析占位 `https://example.invalid/gengyun/source-not-published`
（`packages/contracts/examples.json:40` 同样以 `example.invalid` 表达示例地址），
并把**真实可复核定位**逐条写入 `body`：
`locator`（file + 原文件 sha256 + sheet + row + cells）、`row_sha256` 行指纹、
原文件 sha256、来源版本与「未核对」声明。因此「任一展示记录能追溯实际来源」（AC02）仍然成立，
而 URL 字段不被当成真实来源冒充。该政策在 `zhejiangState().source_url_policy` 中显式给出，
并有测试断言占位属 `.invalid` 且不含 `moa/gov/agri/cnipa` 等真实机构域名。

### 1.5 未发布内容进入用户查询面：显式接线闸门

浙江首批 `visibility='private'`（未发布）。让未发布内容进入用户查询面**必须是可审查的接线决定**，
所以 `/knowledge` 的并入需要**两道闸同时放行**：

1. 执行模式**非 `real`**（`real` 模式只返回已核对 + 已发布的数据库投影，硬拒）；
2. 显式开关 `APP_KNOWLEDGE_UNVERIFIED_SEED=1|true`（**默认关闭**）。

`tools/local-dev/api.mjs`（本地 stub 联调启动器）显式置位该开关，使本地联调真的消费这批资料；
生产/`real` 路径不因此改变语义。逐条仍以 `SourceRef.review_status='unverified'` 如实呈现。

### 1.6 失效状态

- 数据库侧：既有读视图与既有回归不变（`withdrawn/expired/unknown/未审核/未来生效/非 https/
  模拟/缺字段` 一律退出查询，详情 404，列表与详情一致）。
- 种子侧：`toSeedRows()`（`services/api/src/knowledge/reference-query.ts:66-96`）对
  `validity ∈ {expired, withdrawn, conflicting, unknown}` 与 `visibility ∈ {hidden, deleted}`
  的条目**在并入前剔除**；测试逐枚举值断言从 159 降为 158 且该 id 不再出现。

### 1.7 注册表同步（仓库自带的静态清单门禁要求）

`tools/contract-status-core.mjs` 的 `mountedMismatches` 会把「源码已装配但对照表写 `planned`」
判为不一致，`tests/unit/contract-status-tool.test.mjs` 会对真实仓库断言一致。因此本轮同步
`docs/architecture/contract-status.json`（两条 herbicide operation → `route_mounted:true`、
`status:implemented`、带可复核证据路径与用例名、`blocker` 写明未核对/无用量等剩余缺口），
并用工具导出的 `replaceStatusTables` 重建 `contract-implementation-status.md` 的生成表格。

## 2 实际验证（原始输出）

环境：Windows，Node `v24.16.0`，`npm install` 103 packages（无 junction/symlink）。

### 2.1 静态门禁

```text
$ npm run lint
> gengyun@0.0.0 lint
> node tools/lint-workspaces.mjs

PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

```text
$ git diff --check        # 无输出（无空白/冲突标记问题）
```

### 2.2 新增 HTTP 面（`/herbicides` + `/knowledge` 浙江首批）

```text
$ node --test tests/unit/knowledge-herbicides-http.test.mjs
✔ /herbicides 与 /herbicides/{id} 未登录一律 401 SESSION_REQUIRED（不泄露是否存在） (219.1559ms)
✔ /herbicides 列表：契约封套/实体形状对齐、no-store、列表不带 ETag、真实来源可追溯 (56.8526ms)
✔ /herbicides/{id} 详情：与列表同一条实体、强 ETag、来源版本一致 (39.5078ms)
✔ /herbicides 错误码：未知 id 404、非法 id/参数 400、游标非法 400、无结果 200 空 (39.2541ms)
✔ /herbicides 查询与分页：登记号收窄、q 关键词、limit=1 逐页取尽 (39.2340ms)
✔ /knowledge 默认不并入浙江首批：开关关闭时列表仍为空（不把未发布内容默认放行） (29.0731ms)
✔ /knowledge 显式放行 + 空库：真实消费浙江首批（未核对如实呈现、零用量卡、来源可复核） (38.0723ms)
✔ /knowledge 结构与条件过滤：省级命中、县区/未采集条件不命中、无结果 200 空、详情 404 (56.3284ms)
✔ /knowledge real 执行模式硬拒：即使开关打开也不并入未发布/未核对种子 (28.6314ms)
✔ 负例·失效(expired/withdrawn/conflicting/unknown)与下架(hidden/deleted)条目退出有效查询 (5.9539ms)
ℹ tests 10   ℹ pass 10   ℹ fail 0   ℹ skipped 0
```

### 2.3 新增域库真伪回归（浙江首批如实消费）

```text
$ node --test tests/reference/zhejiang-consumption.test.mjs
✔ 浙江首批真实资料被消费：119 杂草 + 5 防除时期 + 35 药剂适用 = 159 条 (7.6823ms)
✔ 逐条如实标注未核对（unverified）与来源版本，绝不写成已核对 (0.5267ms)
✔ 负例·用量缺项不得被补齐：无 dose_text、usable_as_dose/card_ready=false、dose_cards=[]、conditions=null (0.4326ms)
✔ 负例·DoseCard 恒不可渲染（未采集用量），功能开关打开也不能放行 (0.3628ms)
✔ 负例·篡改清单即拒绝消费（补造用量 / 提升为已核对 / 改剂量策略） (28.3864ms)
✔ 来源 URL 策略：全批零 https，使用 RFC 2606 不可解析占位，满足契约 ^https:// 而不伪造真实机构 (0.8157ms)
✔ 可追溯来源：逐条 body 含真实 locator + 行指纹 + 原文件 sha256（不以 URL 冒充来源） (1.3732ms)
✔ 契约形状严格对齐：Knowledge/SourceRef 必填键齐全、无额外键、枚举与格式命中冻结契约 (1.2352ms)
✔ 查询语义：省级证据不猜县区；未采集条件不静默放宽；无结果如实为空 (4.1144ms)
✔ 负例·禁用标签与数值用量扫描：标题/正文不得出现禁用词或剂量式表述 (2.0785ms)
ℹ tests 10   ℹ pass 10   ℹ fail 0   ℹ skipped 0
```

### 2.4 受影响既有路径回归

```text
$ node --test tests/reference/*.test.mjs tests/unit/knowledge-api.test.mjs tests/unit/knowledge-pagination.test.mjs tests/unit/knowledge-herbicides-http.test.mjs tests/unit/contract-status-tool.test.mjs
（含既有 PGlite 知识读面 9 通过 + 1 原生边界明确跳过；含 contract-status 工具「实际 buildApp 注册清单与当前契约表一致」）
✔ 实际 buildApp 注册清单与当前契约表一致；未接 HTTP 的社区/消息/后台保持未注册 (772.8521ms)
ℹ tests 292   ℹ pass 291   ℹ fail 0   ℹ skipped 1
```

```text
$ node --test tests/contract/*.test.mjs tests/unit/local-dev-package.test.mjs
✔ API 错误码与 HTTP 状态映射与契约 states.json 完全一致
✔ 错误码在状态映射中不重复归属
✔ local package includes actual navigation dependencies, stays synthetic and excludes local secrets
ℹ tests 10   ℹ pass 10   ℹ fail 0   ℹ skipped 0
```

```text
$ npm run test:unit
ℹ tests 1757   ℹ pass 1756   ℹ fail 0   ℹ skipped 1
ℹ duration_ms 18216.3602
```

（唯一 skip 是既有 `knowledge-api.test.mjs` 中「原生独立连接撤回」专项，需显式
`GY_KNOWLEDGE_TEST_OWNER_URL` 指向自建隔离集群；未跑即不写通过。）

### 2.5 静态路由清单工具

```text
$ node tools/verify-contract-status.mjs
ERROR: delete /me/consents/{purpose}: services/api/src/privacy/consent-pg.ts lines=140-183 越界
FAIL: 契约实现状态对照校验未通过（1 项）
```

本轮并入前该工具在**同一基线**上先失败于三条：两条 herbicide `route_mounted=false, actual=true`
（本轮装配导致）＋ 上述 privacy 行号越界（**本轮之前即存在**：`consent-pg.ts` 现为 179 行，
对照表写 `140-183`；本轮未触碰 `services/api/src/privacy/**`）。前两条已按注册表同步消除；
最后一条属既有资料漂移，本轮**不代为修改他线数据**，如实记录为未解决项（不阻塞 CI：
CI 的 `test:unit` 只断言 `route_mounted` 一致性，不断言行号范围）。
中文对照表已用工具导出的 `replaceStatusTables` 重建，JSON 与表格一致。

## 3 未取得 / 未验证项（不写「通过」）

1. **标签原文用量正例缺失**：全仓与浙江首批均无「标签原文用量」列（`usable_as_dose=false`、
   `card_ready=false`），因此 DoseCard 的**正例**（可渲染卡片）与「同一用量不跨制剂挪用」的
   真实资料验收**没有正样本可跑**；本轮只验证了负例（恒不可渲染、开关不能放行、篡改即拒绝）。
2. **八组科普评估（GY-I03 的一部分）**：清单自述 `gap-science-eval = not_done`，
   需既定评估方案与真实来源核对；本轮未做，不标通过。
3. **#8 整项（100 组）与消费者一致性**：GY-I08 的整项 100 组验收与跨消费者
   （后端 / 小程序 / GY-I12 问答）一致性未在本轮执行；本轮只沿用既有
   `gy-i08/1.2.0` 规则版本与 `doseCardDescriptor` 负例断言。
4. **正式微信 / Android 端到端**：未跑真机、未调用腾讯正式身份交换；
   `miniprogram` 页面端到端消费 `/herbicides` 的新页面/交互未实现，本轮只完成 HTTP 面。
5. **真实数据库与原生 PG 复跑**：`/knowledge` 真实库路径未在本轮重跑原生 PostgreSQL
   （仅沿用 PGlite 回归与既有原生证据）；`/herbicides` 为文件+域库驱动，不依赖数据库，
   但**未在真实环境**验证部署形态与只读文件可用性。
6. **浙江清单 `private` 语义的契约缺口**：冻结契约 `Knowledge`/`Herbicide` 没有 visibility
   字段，`private`（未发布）只能在装配闸门、`zhejiangState()` 与本文档体现，
   **无法**在响应体内字段级表达；需要契约侧增补才能真正字段化（本轮不新增契约字段）。
7. **`APP_KNOWLEDGE_UNVERIFIED_SEED` 开关的运维姿态**：默认关闭意味着「开箱即用」的
   `/knowledge` 仍不返回浙江首批；本地 stub 已在 `tools/local-dev/api.mjs` 显式放行。
   非 local-dev 的联调环境需运维显式置位（这是刻意的可审查边界）。

## 4 PR 正文（可粘贴）

> **GY-I07 科普／除草剂查询、详情与来源版本展示（Refs #7，部分交付，不关闭整项）**
>
> 本轮补上 #7 中项目自身状态表标记为 `planned` 的两条契约 operation，并让查询/详情**真的消费**
> 已合入的浙江首批真实资料，同时如实呈现「未核对 / 未发布 / 缺用量」三种状态。
>
> **1) 装配 `/herbicides`、`/herbicides/{id}`**（`services/api/src/routes/knowledge.ts`）：
> 复用已合入的 `packages/reference` 适配层与 `packages/knowledge` 真实登记公告记录（20 条）；
> 列表与详情同一 `source_version`，详情强 ETag 由「记录身份 × source_version」派生；
> `additionalProperties:false` 逐键对齐冻结契约，无新增路径、无新增字段；无结果 = 200 空列表，
> 未知/不可见 = 404，未登录 = 401，非法参数/游标 = 400。
>
> **2) `/knowledge` 消费浙江首批真实资料**（`packages/reference/zhejiang.mjs` 新增）：
> 119 杂草 + 5 防除时期 + 35 药剂适用 = 159 条，逐条 `review_status=unverified`、
> `validity=valid`、`conditions=null`、`dose_cards=[]`；并入既有数据库读服务的同一份快照
> （游标水位/分页/过滤不变），不新增契约字段。
>
> **3) 缺项不补齐、不伪造来源**：源工作簿无「标签原文用量」列 ⇒ `dose_text=null`、
> `usable_as_dose=false`、`card_ready=false`，`doseCardDescriptor` 恒不可渲染，并断言
> 正文无剂量式表述；清单来源为仓外 `repo-external` 样本且全批零 `https`，故按契约
> `SourceRef.url` 的 `^https://` 要求使用 RFC 2606 不可解析占位（契约示例同一约定），
> 真实 `locator`/行指纹/原文件 sha256 逐条写入 `body`，**不编造机构域名**。
>
> **4) 未发布内容需显式接线**：`APP_KNOWLEDGE_UNVERIFIED_SEED`（默认关闭、`real` 模式硬拒）
> 控制浙江首批并入；`tools/local-dev/api.mjs` 在 stub 联调显式放行；失效/下架条目在并入前剔除。
>
> 验证：`npm run lint` 通过；新增/受影响测试见 `docs/verification/gy-i07-knowledge-query-20261014.md`
> （新增 HTTP 10/10、域库 10/10、受影响 292 项 291 通过 1 明确跳过、`npm run test:unit`
> 1757 项 1756 通过 0 失败 1 明确跳过）。**未验证**：标签原文用量正例、八组科普评估、
> #8 整项 100 组与消费者一致性、正式微信/Android 端到端、真实库/原生 PG 复跑。

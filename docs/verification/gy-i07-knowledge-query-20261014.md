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
>
> **变更 2（跨线，用户 2026-10-14 已授权）· 修正被新事实推翻的陈旧 404 断言**：
> `tests/integration/catalog-pg.mjs` 的既有守卫写于 `/herbicides` 仍为 `planned` 契约之时，
> 把 `/api/v1/herbicides`、`/api/v1/herbicides/{id}` 与未实现的 `/staging`、`/registrations`
> 一起断言为「未实现 ⇒ 404」。本轮合法装配并挂上用户鉴权后，未登录正确返回
> **401 `SESSION_REQUIRED`**，该 404 断言被新事实推翻（CI 原文 `401 !== 404`，
> `catalog-pg.mjs:126`）。修正只做**最小搬移**：两条 herbicide 路径并入既有 401 循环
> （额外断言 `error.code==='SESSION_REQUIRED'`，口径与 `/knowledge` 一致），
> `/staging`、`/registrations` 留在 404 循环；**未放宽任何其它断言**，
> 且断言强度只增不减（路径数不变，新增 error.code 断言）。已在自建隔离 PG 17.11
> 上取「改动前失败 / 改动后通过」对照，原始输出见第 5 节。该处可**一行回退**（把两条
> herbicide 路径移回 404 循环即可）。

## 5 PR #135 CI 回归：陈旧 404 断言的修正与真 PG 对照复现

### 5.1 事实与根因

| 项 | 值 |
| --- | --- |
| PR | #135，head `60dd7b9`（= 本片 `5ba9457` + 合成 main `15c3003`） |
| CI | 13 项：12 success / 1 failure |
| 失败项 | `catalog-postgres-17.11` → step 6 `node tests/integration/catalog-pg.mjs` |
| CI 原文 | `AssertionError: 401 !== 404`，`tests/integration/catalog-pg.mjs:126` |
| 对照 | `main(15c3003)` 与本片基线 `a15a7f1` 上该项**均 success** ⇒ 确由本片引入 |

根因不是实现缺陷，而是**既有测试守卫陈旧**：`catalog-pg.mjs:117-127` 写作于 `/herbicides`
仍为 `planned` 契约之时，把两条 herbicide 路径与未实现的 `/staging`、`/registrations`
合并断言「未实现 ⇒ 404」。本片合法装配并挂用户鉴权后，未登录正确地变成 401
`SESSION_REQUIRED`。属于「被新事实推翻的断言」，按「只改被推翻处、不放宽其它断言」最小修正。

### 5.2 同源处 grep（只发现这一处）

```text
$ Select-String -Path tests/**/*.{mjs,cjs,js,ts}, tools/**  -Pattern 'api/v1/herbicides'
tests/integration/catalog-pg.mjs:125            ← 唯一陈旧处（已修）
tests/unit/knowledge-herbicides-http.test.mjs:* ← 本片新增测试（正确断言 401）
```

`tests/integration/*` 全量 grep `404|NOT_FOUND|unassembled|route_mounted|planned` 的其余命中
均为「未知 id / 归属 / 未接线 kind」等同形 404 语义，与路由是否装配无关，**未触碰**。
CI 其余 PG 入口（`auth-privacy-pg`、`consent-grant-pg`、`source-lifecycle-pg`、
`staging-intake-pg`、`workbook-staging-pg`）不含路由装配清单断言。

### 5.3 本轮改动（最小 diff，仅一个文件）

```diff
--- a/tests/integration/catalog-pg.mjs
+++ b/tests/integration/catalog-pg.mjs
@@ -114,15 +114,17 @@ try {
-  // Knowledge is now registered and user-only, even for unavailable detail.
+  // Knowledge and herbicides are now registered and user-only, even for unavailable detail.
   // This preview LOGIN intentionally lacks user-auth/knowledge privileges;
   // guest rejection happens before any attempt to query private user data.
-  for (const path of ['/api/v1/knowledge', '/api/v1/knowledge/00000000-0000-4000-8000-000000000001']) {
+  for (const path of ['/api/v1/knowledge', '/api/v1/knowledge/00000000-0000-4000-8000-000000000001',
+    '/api/v1/herbicides', '/api/v1/herbicides/00000000-0000-4000-8000-000000000001']) {
     const denied = await fetch(`${app.listeningOrigin}${path}`);
     assert.equal(denied.status, 401);
     assert.equal((await denied.json()).error.code, 'SESSION_REQUIRED');
   }
-  for (const path of ['/api/v1/herbicides', '/api/v1/herbicides/00000000-0000-4000-8000-000000000001', '/api/v1/staging', '/api/v1/registrations']) {
+  // staging / registrations remain unimplemented paths ⇒ contract-shaped 404.
+  for (const path of ['/api/v1/staging', '/api/v1/registrations']) {
     assert.equal((await fetch(`${app.listeningOrigin}${path}`)).status, 404);
   }
```

强度对照：路径总数不变（6 条未登录探测），两条 herbicide 路径由「仅断言状态 404」
改为「断言状态 401 **且** `error.code==='SESSION_REQUIRED'`」——**只增强、未放宽**；
`/staging`、`/registrations` 仍是 404（它们确实未注册）。
**一行可回退**：把这两条路径移回 404 循环、并删去新增注释行即恢复原状。

### 5.4 自建隔离 PG 17.11 上的「改动前 / 改动后」对照（原始输出）

环境：本机自建集群 `E:\GengYunCommander\.w24-pg\data`（`initdb` 新库、SCRAM、
`listen_addresses=127.0.0.1`、端口 55512、owner 随机密码仅存本机 private 文件，
不提交、不回显），库 `gengyun_catalog_test` 每轮 drop+create，并清理 5 个测试角色，
以满足脚本自带的「fresh DB / 无既有角色」前置。跑完 `pg_ctl -m fast stop`。

```text
=== [BEFORE (stale 404 guard)] PG17.11 up on port 55512 ===
preconditions: server_version=17.11 public_tables=0 pre_existing_roles=0
Real PostgreSQL patch: 17.11
PASS real migration apply/repeat/drift/failed-DDL rollback
PASS actual login roles deny private/base reads, PUBLIC access, cross-view access, writes, DDL, TEMP and escalation
PASS committed 20 incomplete public records + 2 synthetic records: real PG import/repeat, eligible evidence=0, DoseCard=0, scoped seed rollback
node:internal/modules/run_main:107
    triggerUncaughtException(
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
401 !== 404
    at file:///E:/GengYunCommander/GengYun_W24/tests/integration/catalog-pg.mjs:126:12
  actual: 401,
  expected: 404,
  operator: 'strictEqual',
Node.js v24.16.0
=== [BEFORE (stale 404 guard)] catalog-pg exit=-1073740791 (expected fail) ===
port 55512 listening after stop: False
leftover postgres processes from E:\GengYunCommander\.pg17\pgsql\bin : 0
```

（改动前的本地中断退出码为 `-1073740791`：断言抛出后 Node 在 Windows 上以
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 中止；CI 记为 exit 1。
两者都是**非零失败**，且断言点与 CI 完全一致。）

```text
=== [AFTER v2 (fresh cluster, explicit exit)] PG17.11 up on port 55512 ===
preconditions: server_version=17.11 public_tables=0 pre_existing_roles=0
Real PostgreSQL patch: 17.11
PASS real migration apply/repeat/drift/failed-DDL rollback
PASS actual login roles deny private/base reads, PUBLIC access, cross-view access, writes, DDL, TEMP and escalation
PASS committed 20 incomplete public records + 2 synthetic records: real PG import/repeat, eligible evidence=0, DoseCard=0, scoped seed rollback
PASS real HTTP→API→restricted PG: empty/12→10, field shape, source/status/date/review/mode/content negatives, newer-hidden and immediate invalidation/rollback
PASS registration identity/source/hash/ingredients mapping; status/missing-date/identity-conflict/injection/demo rejection; failed import transaction preserves prior evidence
PASS 0005 scoped rollback preserves base records and fails closed in API
=== [AFTER v2 (fresh cluster, explicit exit)] catalog-pg exit=0 (expected pass) ===
port 55512 listening after stop: False
leftover postgres processes from E:\GengYunCommander\.pg17\pgsql\bin : 0
OUTER_EXIT=0
```

### 5.5 合成当前 main 与本轮门禁

```text
$ git fetch upstream --prune ; git merge upstream/main --no-edit
第一次合成：upstream/main = 15c3003efc221407734ea26366a7538ae23ddcbb（仅 docs/ui-demo/**，#132）
            → 无冲突；合成提交 d93dd0cf41a2e275cd12f6715bb42975104bf539
第二次合成：upstream/main = 2431cfde9b4fcb1619d65cec8817f686b9a50846
            （#134 docs(GY-I01) 协调主线契约事实 + #133 feat(GY-I27) 用途授权接线）
            → 冲突仅 docs/architecture/contract-implementation-status.md（生成表格）
```

第二次合成的**注册表冲突口径**（`docs/architecture/contract-status.json` 自动合并，语义已核对）：

| 条目 | 采用 | 说明 |
| --- | --- | --- |
| `listHerbicides` / `getHerbicide` | **本片** | 主线仍写 `planned`/`route_mounted:false`；本片必须标 `implemented`+`route_mounted:true`（否则 `contract-status-tool.test.mjs` 的装配一致性断言失败） |
| `listKnowledge`（主线由 `implemented` 改判 `partial`，补 `pagination.ts` 证据与新 blocker）/ `getKnowledge` | **主线** | 本片此前的 `/knowledge` 注册表条目改动**主动放弃**，不覆盖 #134 的协调结论 |
| `source_kind` 横切维度 blocker | **本片** | 主线仍写「/herbicides 仍未装配」，与事实不符，故更新为「已装配并消费真实公告记录（来源 unverified、用量/禁限用未采集）」 |
| `withdrawConsent`（`consent-pg.ts:135-179`）等 | **主线** | #134 已修正此前发现的 privacy 行号越界，本轮不再自行修改 |

冲突文件按「取主线版本 → 用工具 `replaceStatusTables` 从合并后 JSON 重建生成表格」解决，
**不改动手写正文**。

```text
$ node tools/verify-contract-status.mjs
PASS: 覆盖 112 条契约操作；已装配 75 条；implemented 13 / partial 81 / planned 18；横切维度 8 条；中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

（此前该工具在基线上因 `consent-pg.ts` 行号越界失败；#134 已修复，本轮**全通过**。）

```text
$ npm run lint                      → PASS（api/admin tsc + 卫生扫描）
$ npm run test:contract             → tests 6  / pass 6 / fail 0
$ node --test tests/reference/zhejiang-consumption.test.mjs tests/unit/knowledge-herbicides-http.test.mjs
                                    → tests 20 / pass 20 / fail 0 / skipped 0
$ npm run test:unit                 → tests 1767 / pass 1766 / fail 0 / skipped 1
$ git diff --check upstream/main...HEAD → 无输出
```

合成后再次在隔离 PG 17.11 上跑目标集成测试（因为 #133 改了 `app.ts` 等装配）：

```text
=== [AFTER merge of upstream 2431cfd] PG17.11 up on port 55512 ===
preconditions: server_version=17.11 public_tables=0 pre_existing_roles=0
Real PostgreSQL patch: 17.11
PASS real migration apply/repeat/drift/failed-DDL rollback
PASS actual login roles deny private/base reads, PUBLIC access, cross-view access, writes, DDL, TEMP and escalation
PASS committed 20 incomplete public records + 2 synthetic records: real PG import/repeat, eligible evidence=0, DoseCard=0, scoped seed rollback
PASS real HTTP→API→restricted PG: empty/12→10, field shape, source/status/date/review/mode/content negatives, newer-hidden and immediate invalidation/rollback
PASS registration identity/source/hash/ingredients mapping; status/missing-date/identity-conflict/injection/demo rejection; failed import transaction preserves prior evidence
PASS 0005 scoped rollback preserves base records and fails closed in API
=== [AFTER merge of upstream 2431cfd] catalog-pg exit=0 (expected pass) ===
port 55512 listening after stop: False
leftover postgres processes from E:\GengYunCommander\.pg17\pgsql\bin : 0
OUTER_EXIT=0
```

未跑项：CI 上的其余 workflow（`workbook-staging`、`local-wechat`、`auth-privacy-postgres` 等）
未在本机复跑；本轮唯一新增跨线改动是 `tests/integration/catalog-pg.mjs` 的那一处
（已在真 PG 复现失败、并验证修复）。隔离集群 `E:\GengYunCommander\.w24-pg`（仓外、
随机 owner 密码仅存本机 private 文件、不提交）与启动脚本
`E:\GengYunCommander\.w24-pg-run-catalog.ps1` 保留在仓外，便于复验；跑完已停库、
端口关闭、无遗留 postgres 进程。

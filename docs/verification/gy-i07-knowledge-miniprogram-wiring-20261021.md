# GY-I07 小程序科普／除草剂页与知识 API 的接线盘点

日期：2026-10-21。Refs #7（科普／除草剂查询、详情与来源版本展示）。本页只盘点小程序端现状，不改服务端、不改小程序代码，不关闭整项。

基线：`f7155d5ac1329974b20a6128e332bb84c19c733d`（2026-10-21 08:57:05 +0000，`test(deploy): 补角色面与账本双条件兜底断言…` (#370)）。分支 `feat/gy-r28-b6-knowledge-miniprogram`（`upstream/main` 同期基点），盘点时工作树干净。

## 一、结论：已接真 API，选 C（只出盘点，不动代码）

`pages/knowledge/`、`knowledgedetail/`、`reference/`、`referencedetail/` 四个页面**不是纯静态骨架**：它们经 `miniprogram/utils/knowledge-api.js` 打真实 HTTP（`GET /knowledge`、`GET /knowledge/{id}`、`GET /herbicides`、`GET /herbicides/{id}`），请求／响应形状与 `packages/contracts/openapi.json` 的冻结契约一致，未发现字段名或路径需要修正的地方（故不选 B）。`pages/referenceseed/`、`referenceseeddetail/` 是**设计上就是随包离线种子目录**，不调任何业务 API（故也不满足「纯静态骨架待接 API」的 A 条件）。

因此按 A/B/C 里的 C 交付：本页即交付物，`miniprogram/**` 零改动。

需要同时说清的两条边界，避免把「代码已接」说成「本次实测走通」：

1. 共享源码 `miniprogram/config/runtime.js` 逐字为 `module.exports = { mode: 'disabled', apiBaseUrl: '' }`。**出厂状态下小程序不会发起任何业务请求**，页面按冻结闭集文案如实报「需登录／未启用联网」，不冒充读数。真实请求只发生在 `node tools/prepare-wechat.mjs local --config <file>` 生成的被忽略副本（`.local/wechat-local`）里。
2. 本会话的**进程级**证据缺失（沙箱禁止带管道的子进程、微信开发者工具 CLI 无写权限），详见第七节。下文「已接」指代码与契约对齐、并由既有进程内测试覆盖；「真 HTTP 联调／开发者工具编译」本轮**未取得**。

## 二、六个页面的接线现状

| 页面 | 数据源 | 是否走服务端 | 关键锚点 |
| --- | --- | --- | --- |
| `pages/knowledge/` | `utils/knowledge-api`（`/knowledge`） | 是（联网副本下） | `miniprogram/pages/knowledge/knowledge.js:4` require、`:197` `await api.list(q)`、`:153-158` 条件与 `limit: 20` |
| `pages/knowledgedetail/` | 同上（`/knowledge/{id}`） | 是 | `miniprogram/pages/knowledgedetail/knowledgedetail.js:4` require、`:41` `api.detail(this._id, expected ? expected.filters : {})`、`:43` 来源指纹漂移判定 |
| `pages/reference/` | 双路径：`/herbicides` 或随包离线副本 | 条件启用 | `miniprogram/pages/reference/reference.js:152-163` `querySource()`、`:191` `knowledgeApi.listHerbicides(input)`、`:233` `reference.query(...)` 离线分支、`:247` 离线行标记 |
| `pages/referencedetail/` | 双路径：`/herbicides/{id}` 或随包副本 | 条件启用 | `miniprogram/pages/referencedetail/referencedetail.js:16-20` 注释、`:243` `knowledgeApi.detailHerbicide(recordId)`、`:323` `reference.detail(recordId)` |
| `pages/referenceseed/` | 仅 `utils/reference` 的 `seed` 数据 | 否（设计如此） | `miniprogram/pages/referenceseed/referenceseed.js:50-57`、`:91-101` |
| `pages/referenceseeddetail/` | 仅 `reference.seedHerbicideDetail` | 否（设计如此） | `miniprogram/pages/referenceseeddetail/referenceseeddetail.js:66`、`:74-76` |

`reference` 之所以是双路径而不是硬接服务端，理由写在代码里且与契约一致：`/herbicides` 的 querystring 只接受 `q`／`registration_number`／`cursor`／`limit`（`packages/contracts/openapi.json` `listHerbicides`，第 2669 行起），**作物／杂草／地区条件在服务端不可表达**。所以：

- 未启用联网（`auth.networkEnabled()` 为假）⇒ 离线副本，标记 `data_source='bundled-offline'`、`source_marker='随包离线副本'`；
- 带 `cropId`／`speciesId`／`regionCode` 任一结构化条件 ⇒ 同样离线，且明说「筛选条件未被丢弃」（`reference.js:157-160`）；
- 其余 ⇒ `data_source='server'`，走 `/herbicides`，**失败不落回离线副本**（`reference.js:178-179` 注释）。

页面对「执行模式」不做乐观假设：模式取自服务端响应 `meta.execution_mode`（`miniprogram/utils/knowledge-api.js:25-29` 校验 `request_id` 为 UUID、`contract_version === '1.0.0'`、`execution_mode ∈ {real, stub, preset_demo}`），再由 `api.modeNote(mode)` 生成文案（`knowledge-api.js:209` 附近）：`stub` 明确写「替身服务资料，仅供联调，不代表真实资料查询」。**没有把 stub 当 real 的路径**。

## 三、stub / real 由谁决定

- 共享源码固定 `mode: 'disabled'`（`tools/check-wechat-project.mjs:55-56` 的断言就是钉这一行，防止有人把共享源改成联网）。
- `miniprogram/utils/auth.js:37-38` 的 `networkEnabled()` 要求 `runtime.mode === 'local' && runtime.apiBaseUrl !== ''`；`knowledge-api.js:67` 在两个条件任一不满足时直接 reject `SESSION_REQUIRED`，**不会**静默降级成离线数据。
- 联网副本由 `node tools/prepare-wechat.mjs local --config <file> [--appid wx…]` 生成（输出 `.local/wechat-local`，被忽略），`apiBaseUrl` 需含客户端拼接的业务前缀（如 `http://127.0.0.1:3100/api/v1`）；`tools/prepare-wechat.mjs:50-51` 在共享 `runtime.js` 被改动时拒绝打包。
- 服务端执行模式：真实读库或 real 端口为 `real`；本地替身服务为 `stub`；演示预置为 `preset_demo`。页面文案随之变化，`api.modeNote` 对三者不共用一句话。

## 四、五个 operationId 的对照

| operationId（openapi.json 行） | 路径 | 小程序消费者 | 客户端实际发送 |
| --- | --- | --- | --- |
| `listKnowledge`（2375） | `GET /knowledge` | `pages/knowledge` | `q`＋`crop_id`／`region_code`／`species_id`／`growth_stage`／`planting_method`／`use_scene`＋`limit: 20`＋`cursor`（分页） |
| `getKnowledge`（2525） | `GET /knowledge/{id}` | `pages/knowledgedetail` | 路径 id ＋ 列表带过的 6 个筛选条件（作为同条件复核） |
| `listHerbicides`（2669） | `GET /herbicides` | `pages/reference`（server 路径） | `q`＋`limit`＋`cursor`；**不传**结构化条件（契约不支持） |
| `getHerbicide`（2775） | `GET /herbicides/{id}` | `pages/referencedetail`（server 路径） | 仅路径 id，**不带查询串**（该 schema `additionalProperties:false`，见 `knowledge-api.js:174`） |
| `verifyRegistration`（2866） | `POST /registrations/verify` | **无消费者** | — |

`verifyRegistration` 在这六个页面里没有任何调用点（`grep -r "registrations\|verifyRegistration" miniprogram/` 零命中）。它不是本次接线缺口：登记精确核对属 #10 的 OCR 链路，科普／除草剂阅读面按契约只读 `Knowledge` 与 `Herbicide` 两个实体。

客户端不是「发出去就算」：`miniprogram/utils/knowledge-api.js` 对响应做了冻结级校验——实体必填字段齐备（`:46-54`）、`source.url` 必须 `https://`、`source.updated_at` 必须是带时区的 RFC3339（`:18-23`）、`dose_cards` 必须为空数组否则抛 `UNSUPPORTED_DOSE_RESPONSE`（`:56`）、只展示 `usable()` 的条目（`:63`：`reference_state==='available' && source.validity==='valid' && review_status!=='rejected'`）、重复 id 或多页循环游标一律 `INVALID_RESPONSE`。这一层是「接对」的实际判据，不只是路径对得上。

## 五、「来源版本」在响应里到底是什么

契约里**没有** `source_version` 这个字段：来源版本就是 `SourceRef.version`（`packages/contracts/openapi.json:12519` `SourceRef`，`:12286-12297` 的 required 含 `version`、`updated_at`、`validity`、`review_status`）。服务端口径见 `docs/verification/gy-i07-knowledge-consumer-20261011.md:15`：`SourceRef.id` 为 `sources.id`，`version` 为关联当前 `source_versions.version`，`updated_at` 取 `retrieved_at`。

页面展示位置：

- 列表 `miniprogram/pages/knowledge/knowledge.wxml:79`：`来源版本：{{item.item.source.version}}`（+ `来源取得时间：{{item.item.source.updated_at}}`）；
- 详情 `miniprogram/pages/knowledgedetail/knowledgedetail.wxml:36-37`：来源版本 `{{item.source.version}}`、资料修订 `{{item.revision}}`、来源取得时间 `{{item.source.updated_at}}`、来源有效性按 `validity === 'valid'` 二分；
- 除草剂列表 `miniprogram/pages/reference/reference.wxml:68`：`来源版本：{{item.source_version}}`——服务端行由 `knowledge-api.js:188` 的 `herbicideRow()` 把 `SourceRef.version` 映射成视图字段 `source_version`；离线行由随包数据自带同名字段，两条路径因此能显示**同一个口径**；
- 除草剂详情 `miniprogram/pages/referencedetail/referencedetail.wxml:113`：`{{detail.source_version}}`（`:266` 由 `source_version: row.source_version` 传入）。

实际返回的取值样例（随包浙江资料，`packages/knowledge/zhejiang/materials-zhejiang-v1.json`）：`weed-summary-2026.10`（`:28`）、`herbicide-risk-2026.10`（`:59`）；同处 `validity: "valid"`、`review_status: "unverified"`、`retrieved_at: "2026-10-14"`、`license.licensed: false`。两点因此需要如实保留，不要写成「来源已核实」：**审核状态是 `unverified`**，页面对它的展示（`labels.review`）不代表已核实；包里 `retrieved_at` 是**日期**，而客户端要求 `updated_at` 是完整时间戳，服务端投影必须把日期转成 `date-time`，该转换结果本轮未实测（见第七节）。

## 六、排序仍是契约 partial（本片不改码，只登记）

前端不参与排序：`listKnowledge`／`listHerbicides` 的契约里**没有任何排序参数**（`packages/contracts/openapi.json:2312`、`:2603` 的 parameters 只有 `Cursor`／`Limit` 与筛选字段），页面照契约不传排序，也不在 UI 上声称任何排序（无「最新优先」字样）。所以这不是前端缺陷，而是服务端契约面未冻结完的口径差：

- 冻结口径为 `(created_at DESC, id DESC)`：`docs/architecture/state-contract.md:32`「游标列表统一 items + next_cursor（null 结束），limit 默认 20、最大 50，排序 (created_at DESC,id DESC)」。
- 现行实现为 `id_asc`：`docs/architecture/contract-status.json:781`（本轮实测行号，取**合流树**：`upstream/main`=`1d65b7ee` ＋ 本片 #538；合流按内容重锚，原记 `:716`）blocker 原文「当前 id_asc 排序仍不同于冻结 (created_at DESC, id DESC)，实际表/投影无 created_at，排序及历史数据方案未完成，按 partial 保留」（⚠ 引文为 R33 订正前原文，该行现文已按代码事实订正，见 `docs/verification/gy-r33-contract-ledger-20261023.md`）；台账同项记 `partial`（`docs/architecture/contract-implementation-status.md:72`，证据 `services/api/src/routes/knowledge.ts:188-192`、`services/api/src/knowledge/service.ts:56-123`、`services/api/src/knowledge/pagination.ts:30-72`）；历史判据见 `docs/verification/gy-i01-knowledge-cursor-20261013.md:46`。
- README 的 #7 行（`README.md:212`）已按同一表述记录「契约面仍 partial」，本页不升格该结论。

后续若要消除这处口径差，属于服务端排序／历史数据方案（不改前端即可生效）。本轮**没有**在页面里加 `TODO` 注释：类 C 交付明确不动代码，且页面上任何「排序」注释都属无消费者备注，不如把事实留在本页与台账里。

## 七、验证记录（含跑不动的原因，不省略）

| 检查 | 结果 |
| --- | --- |
| `node tools/check-wechat-project.mjs` | **未通过，原因在环境**：`:49` 的 `spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })` 返回 `status === null`（`AssertionError: null !== 0`），即本会话沙箱禁止带管道的子进程（`EPERM`）。脚本自身逻辑未被证伪。 |
| 等价复算（无子进程） | 通过：root／miniprogram 两份 `project.config.json` 的 `appid wx4407a4b908a69a54`、`compileType miniprogram`、`setting.urlCheck true`、`libVersion 3.17.3`、`miniprogramRoot miniprogram/`；`project.private.config.json.example` 的 `urlCheck`；`app.json` 五 Tab 文案与注册、19 个页面各含 `.js/.json/.wxml`；`miniprogram/config/runtime.js` 仍匹配 `mode: 'disabled', apiBaseUrl: ''`。逐文件 `node --check`（PowerShell 直调，不经子进程管道）**62/62 通过**。 |
| `npm run test:mini` | **未通过，原因是同一环境限制**：`node --test` 起子进程即 `spawn EPERM`；`tests/local-debug.test.mjs:105` 的 `spawnSync` 同样 `status === null`（`:110` 断言失败）。这两项在有正常子进程权限的机器上属可执行项，本会话无法取得读数。 |
| 受影响测试（进程内直跑 `node <file>`，不 spawn） | `tests/reference/knowledge-client.test.mjs` **51 通过 0 失败**（用假 `wx` 回调驱动 `utils/knowledge-api.js` 与 `pages/knowledge`、`pages/knowledgedetail` 的真实代码，含门禁、错误码、指纹漂移、未采集维度空态）；`tests/reference/miniprogram-parity.test.mjs` 16/0；`tests/reference/source-version.test.mjs` 12/0；`tests/reference/page-gate.test.mjs` 9/0；`tests/reference/knowledge-layout.test.mjs` 3/0。`tests/local-debug.test.mjs` 进程内 4 通过 2 失败，两个失败均为上述 `status === null`（打包／`--appid` 覆盖两例，均在 `spawnSync` 之后）。 |
| `tests/unit/knowledge-*.test.mjs` | 未跑：本 worktree 未安装 `node_modules`（`ERR_MODULE_NOT_FOUND: @electric-sql/pglite`）。属依赖未安装，不是断言失败；本片未安装依赖（红线：不新增依赖）。 |
| 微信开发者工具 `cli.bat open --project` | **未取得编译证据**。工具在 `D:\微信web开发者工具\cli.bat`，执行返回 `[error] Please ensure that the IDE has been properly installed`；细看为 `EPERM: operation not permitted, open 'C:\Users\MR\AppData\Local\微信开发者工具\User Data\…\.cli'`——CLI 需要写工作区外的用户数据目录，本会话沙箱拒绝，且 IDE 服务端口未就绪。故「编译无报错」本轮**未验证**。 |

## 八、本片未覆盖（不得据本页升格）

- 未做真机、未做开发者工具渲染与截图；`tests/local-debug.test.mjs` 的「隔离打包」两例未取得通过读数。
- 未起 `npm run dev:api` 做真 HTTP 联调：本机无 `DATABASE_URL`（属 #3／#27 线），且本片按类 C 不改码，无需要实测的改动。
- 未取得 `source.updated_at` 由 `retrieved_at`（日期）转 `date-time` 的服务端投影实测；未取得真实来源与实际消费者证据（#7 整项仍「待前置／待证据」，前置 #3 已关、#4 仍 OPEN）。
- 排序 `id_asc` vs 冻结 `created_at DESC` 的差异照旧记 `partial`，本页任何表述都不改变台账与 AC 判定。

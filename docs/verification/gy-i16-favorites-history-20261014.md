# GY-I16 收藏与可浏览的识别历史 —— 实现与自检证据（Refs #16）

> **本记录不关闭整项 issue #16。** 它只覆盖本次派单范围内的交付与自检，并**如实列出未取得／未验证项**。
> 文中所有"通过"都附命令与原始输出；**没有跑过的，一个字都不写通过**。

## 0 基本信息

| 项 | 值 |
| --- | --- |
| 分支 | `feat/gy-i16-favorites-history`（自建 worktree `E:\GengYunCommander\GengYun_W28`） |
| 基线 | `upstream/main = fcfa6de9d62aeaaa0489d3319f8f06911312af48`（`feat(ui): add reusable native Demo components (Refs #28) (#142)`） |
| 已并入上游 | `upstream/main = c85a1e8`（含 #146 GY-I02／#147 GY-I09／**#148 GY-I15 社区页**／#149 GY-I27 第二片）⇒ 合并提交与冲突解析见 §3.7 |
| 契约 | 只读消费 `packages/contracts/{openapi,operations,states}.json`（1.0.0）；**不改契约** |
| 执行模式声明 | 本片服务端只有**内存** store（无数据库迁移）⇒ `real` 模式下收藏／历史**整域 503**（有意 fail-closed）；`stub`/`preset_demo` 下可跑通，但**不代表真实业务验收** |
| 推送 | 由**指挥**推送；写手**不 push**、不改共享 remote／配置 |
| 作者 | GY-I16 写手（本 worktree 独立分支） |

## 1 契约对齐（逐条 operation，不新增契约外路径）

| operationId | 方法 路径 | 实现位置 | 关键契约纪律 |
| --- | --- | --- | --- |
| `listFavorites` | `GET /api/v1/favorites` | `registerFavoriteRoutes` 的 `app.get`（`/favorites`） | 只有 `cursor`/`limit`（多余查询参数 400）；列表**无 `ETag`**；`Cache-Control: no-store` |
| `createFavorite` | `POST /api/v1/favorites` | 同函数 `app.post`（`/favorites`） | 201 + `FavoriteEnvelope` + `ETag: "<revision>"`；`Idempotency-Key` 必填；body 恰为 `{target_ref}`，`type` 3 项闭集 |
| `deleteFavorite` | `DELETE /api/v1/favorites/{id}` | 同函数 `app.delete`（`/favorites/:id`） | 200 + `AckEnvelope`；`If-Match` 必填（缺失 428／非强 ETag 400／不符 409）；**不回 ETag**（资源已删除，口径同 `DELETE /recognitions/{id}`） |
| `listHistory` | `GET /api/v1/history` | `registerHistoryRoutes` 的 `app.get`（`/history`） | 同上列表纪律 |
| `deleteHistory` | `DELETE /api/v1/history/{id}` | 同函数 `app.delete`（`/history/:id`） | 200 + `AckEnvelope` + `X-GY-Cascade`（**非契约披露标记**） |

**实现位置按符号检索，勿按行号复现**：五个 handler 分别在 `services/api/src/routes/favorites.ts` 的 `registerFavoriteRoutes` 与 `services/api/src/routes/history.ts` 的 `registerHistoryRoutes` 内。读数对照——交付提交 `1b0b3d6` 实测 `favorites.ts` `:87`／`:92`／`:107`、`history.ts` `:78`／`:83`；测量基线 `6c22000` 实测 `:89`／`:94`／`:109` 与 `:80`／`:85`。本表原记的 `60-72`／`74-88`／`90-102`／`55-62`／`64-80` 在交付提交上即不成立（该二文件在本文声明基线 `fcfa6de9` 与并入基线 `c85a1e8` 上均尚不存在），已按上式订正。

**刻意不注册 `GET /history/{id}`**：契约里 `/history/{id}` **只有 `delete`**。因此"历史详情"由客户端用第 7 项
`target_ref` 去读**已合并**的 `GET /recognitions/{id}`（#9）或 `GET /ocr/{id}`（#10）组合出来
（`miniprogram/pages/historydetail/*`）。本片**不新造**路径，也**不把**候选／人工选择／OCR 核对／来源版本
复制进历史响应（`History` 契约里没有这些字段，自造字段就是编造契约）。

字段级核对（`additionalProperties:false`，逐键比对，测试断言键集**恰等**）：

- `Favorite` = `id/revision/target_ref/reference_state/unavailable_reason/created_at`（6 项）；
- `History` = `id/revision/kind/target_ref/job_state/reference_state/created_at`（7 项）；
- 内部字段 `job_id`／`event_key`／`owner_id` **绝不出契约**（有专门断言）。

## 2 逐项验收对应

### 2.1 收藏：增／取消／去重；旧收藏不恢复失效推荐资格

- **去重**由存储层 `(owner_id, target_type, target_id)` 唯一索引保证：同一用户对同一目标**永远只有一行**；
  重复 `POST`（含换新 `Idempotency-Key`）返回**既有那一行**、不改 `created_at`、不推进版本（201）。
- **取消**是**物理删除**（CAS 同一同步临界区内校验 `owner_id` + `revision`）：取消后该行消失，再次收藏得到**新 id**，旧行不复活。
- **旧收藏不恢复失效推荐资格**：`favoriteEligibleForRecommendation(view)` 只看**本次派生**的 `reference_state`；
  隐藏／失效／删除／注销之后，收藏时间再久也**不可用**（负例见 §3）。
- **收藏不授予可见性**：对当前不可用的目标也如实建行，但响应里的 `reference_state` 由**本次派生**给出 `unavailable`。

### 2.2 历史：时间／任务类型／候选与人工选择分开／OCR 核对／来源版本／失败真实可见

- 列表逐项展示：`created_at`（时间）、`kind`（识草／标签识别）、`job_state`（**七类逐类**）、`reference_state`。
- **候选与人工选择分开**：详情页把 `candidates`（模型候选 + 自报分数，标注"未人工确认"、分数**不是**准确率）
  与 `selected_species_id`（人工选择）作为**两个独立区块**呈现（`candidateSelectionSeparated: true`）。
- **OCR 核对**：`raw_fields`（模型原始）／`corrected_fields`（人工更正）／`verification`（核对结果）三者分开；
  用药安全：页面**不渲染**用量卡正文与登记用量数字，只报"存在 N 条"并提示以核验资料为准。
- **来源版本**：取 `Recognition.model_version` / `OCR.model_version`（来自详情面，不在历史响应里）。
- **失败状态真实可见**：`failed/timed_out/cancelled/uncertain` 一律原样列出（有专门断言），
  且**读取时重查**（见 2.3）——任务状态端口在**生产装配**下就已接线到已合并的公开读取口
  `recognitionService.getJob`（#9）／`ocrService.getJob`（#10），因此列表里的 `job_state` 是**实时值**。
- **识别或收藏不自动转成"已使用"事实**：`History` 投影恰为契约 7 字段、`Favorite` 恰为 6 字段，
  两者都**没有**任何 `used/usage/used_at` 类字段；收藏域整体**不持有**历史／识别／用量端口
  （结构上不可能写出"已使用"）；历史内部口的入参对未知字段（含 `used`）一律 400。

### 2.3 读取时重查权限与当前可见性（含针对性负例）

- `reference_state`（`targetref/visibility.ts`）**每次读取**调用 `stateOf` 重新派生，**不入库、不缓存**；
  `Favorite.unavailable_reason` 只能取冻结闭集里的一条**非披露**说明。
- 硬边界：端口未接线／抛错／返回非闭集取值 ⇒ 一律 `unavailable`（**绝不**返回 `'available'` 来"默认可用"）；
  对象侧的一切原因（下架／失效／隐藏／删除／无权／版本替换／注销）折叠成**同一条**说明，
  **不区分"已隐藏"与"不存在"**（不泄露存在性）。
- 历史行在目标失效后**仍然存在**（不隐藏失败／失效记录），只是 `reference_state` 如实为 `unavailable`。

### 2.4 注销删除接 F13（复用已合并协议，不另起一套）

`services/api/src/privacy/user-data-deletion.ts`：

- 用**已合并**的 `createDeletionRegistry()`（`packages/privacy/deletion.mjs`，模块注册协议）+ 已合并的
  `services/api/src/privacy/egress.ts::createPrivacyDeletionCoordinator()`（即 `deletion-modules.mjs` 的封套）；
- 只把本片自己的两个模块 `favorites`／`history` 注册进去（各一个处理器），**不实现**删除流程本身
  （7 日在线／30 日备份／第三方证据／恢复清单重放属 GY-I19）；
- 已合并协议的两个约束如实适配：① 处理器入参不含主体 ⇒ 在**创建请求时**绑定 `requestId → userId`，
  反查不到主体即抛错（协议折叠为 `blocked`），**绝不**用空主体清理；② `completed` 必须带非空 `evidenceRef`；
- 状态事实：`onlineState = completed` + 证据 `"<module>:online-purged:<删除行数>"`（**真的删掉了在线行**）；
  `backupState` 默认 `pending`（**备份副本清除未接线，不谎称 completed**）⇒ 因此回执如实显示该模块**未完成**。
  接线备份清除端口后同一套协议即判 `completed`（有专门用例）。

## 3 本次运行的原始输出（作者自检）

> 环境：Windows / `node v24.16.0` / `npm 11.13.0`；worktree `E:\GengYunCommander\GengYun_W28`；
> 全部命令在本 worktree 内、以**当前 HEAD** 执行。以下为原始输出摘录（未改写）。

### 3.1 静态检查与卫生扫描

```
> npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

### 3.2 受影响测试（服务端）

```
> node --test tests/unit/favorites-http.test.mjs
✔ 收藏HTTP：增→列→取消 的契约形状、头部与"去重不产生第二行"
✔ 收藏HTTP：归属/越权同形、If-Match 与幂等头部纪律
✔ 收藏HTTP：请求校验（闭集/未知字段/路径/查询参数）与后台会话隔离
✔ 收藏HTTP：分页稳定、游标签名与跨主体拒绝
✔ 收藏HTTP：real 模式整域关闭（内存存储不冒充持久化）
✔ 收藏HTTP：可控可见性替身下 可用/不可用 的投影与推荐资格
ℹ tests 6  ℹ pass 6  ℹ fail 0

> node --test tests/unit/history-http.test.mjs
✔ 历史HTTP：空列表 → 内部口落行 → 契约形状（无候选/选择/来源版本字段、无 ETag）
✔ 历史HTTP：任务状态端口已接线到已合并读取口 ⇒ 失败状态真实可见（读取时重查）
✔ 历史HTTP：他人任务核不到 ⇒ 只退回入库值，不泄露他人任务状态
✔ 历史HTTP：失败/超时/取消 五类非成功终态逐类可见（不被折叠成一句"失败"）
✔ 历史HTTP：去重（同一任务不产生第二行）、归属隔离、越权与不存在同形
✔ 历史HTTP：删除历史行 + 级联披露（未接线如实说明，接线后只启动不声称完成）
✔ 历史HTTP：请求校验、分页与 real 模式整域关闭
ℹ tests 7  ℹ pass 7  ℹ fail 0

> node --test tests/unit/favorites-history-visibility.test.mjs
✔ 投影字段集恰等契约：收藏 6 项 / 历史 7 项，且历史不含候选或人工选择字段
✔ 可见性 fail-closed：未接线 / 抛错 / 非闭集取值 一律 unavailable，且不外泄原始错误文本
✔ 读取时重查（无缓存）：可用↔不可见 逐次重新派生，调用次数随读取增长
✔ 负例：隐藏/失效后不得因缓存或旧链接重新公开，旧收藏也不恢复推荐资格
✔ 负例：注销（账号不可读）后所有目标统一不可用，且不复活、不泄露存在性
✔ 历史：失败/超时/取消/不确定 原样可见，且不会被折叠成成功或被隐藏
✔ 历史：job_state 读取时实时重查；核不到时退回入库值，绝不凭空升级为成功
✔ 历史：目标失效后行仍在但不可用；归属隔离；越权与不存在同形
ℹ tests 8  ℹ pass 8  ℹ fail 0

> node --test tests/unit/user-data-deletion.test.mjs
✔ F13：必需模块闭集只含本片两个模块，且非闭集模块注册即拒（复用同一协议）
✔ F13：按主体清理，其它主体不受影响；在线证据非空，备份如实 pending（不谎称完成）
✔ F13：接线备份清除端口后，同一套协议即可判完成（缺口补上即通过）
✔ F13：未绑定主体的请求 ⇒ 处理器抛错折叠为 blocked，且不清理任何人的数据
✔ F13：清理可重跑 —— 未完成行按协议重试（数据仍幂等），已完成行不重跑
ℹ tests 5  ℹ pass 5  ℹ fail 0
```

### 3.2.1 **针对性负例**（原文，逐条对应 issue #16 的"缓存或旧链接不得让已隐藏/失效/注销对象重新公开"）

```
✔ 负例：隐藏/失效后不得因缓存或旧链接重新公开，旧收藏也不恢复推荐资格
✔ 负例：注销（账号不可读）后所有目标统一不可用，且不复活、不泄露存在性
```

两条负例的具体断言（节选，逐字引自测试文件）：

- 隐藏后**同一条收藏（同 id、同 revision）**必须变成 `unavailable`，并断言"每次读取都应重新派生可见性"
  （读取次数随读取增长 ⇒ **无缓存**）；`favoriteEligibleForRecommendation === false` ⇒ **旧收藏不恢复时效资格**；
  目标侧说明对**所有**收藏是**同一条**非披露文本 ⇒ 不区分"已隐藏"与"不存在"。
- 注销（账号不可读）后：3 条收藏的行**仍存在**（不因注销隐藏用户数据），但全部 `unavailable`，
  且说明集合**恰为一条**（不因目标类型或存在性给出可区分信号）；旧链接（同 id 反复读）不得复活。

### 3.3 受影响测试（小程序侧）

```
> node --test tests/unit/miniprogram-favorites-history.test.mjs
✔ 收藏客户端：未联网如实失败；成功响应逐字段校验；可用时不得给不可用说明
✔ 收藏客户端：闭集拒绝（本地不发请求）、取消带 If-Match 与幂等键、呈现口径非披露
✔ 历史客户端：旧链接夹带的状态字段一律忽略，详情链接只接受 id
✔ 历史客户端：失败状态真实可见、任务类型与时间显示、列表响应逐字段校验
✔ 历史详情：实时读取优先；实时未命中时快照只用于定位、**不携带状态**
✔ 历史详情视图：候选与人工选择分开、失败不当作成功、分数不是准确率
✔ OCR 视图：原始字段/人工更正/核对结果分开，只报用量卡数量（不展示用量内容）
✔ 级联披露（非契约标记）三态文案不同，未接线明确说明只删了记录本身
ℹ tests 8  ℹ pass 8  ℹ fail 0
```

### 3.4 门禁全量

本片单分支 HEAD（`fe6ab99`）：

```
> npm run test:unit
ℹ tests 1834  ℹ pass 1833  ℹ fail 0  ℹ skipped 1  ℹ duration_ms 42542.9
```

**并入 `upstream/main = c85a1e8` 之后**（合并提交 `380edc3`；上游新增社区/识别/隐私测试，故总数变化）：

```
> npm run test:unit
ℹ tests 1890  ℹ pass 1889  ℹ fail 0  ℹ skipped 1  ℹ duration_ms 23455.3
```

> 唯一的 `skipped 1` 是**既有**子用例 `native separate-connection withdrawal and account state changes at
> guarded read boundary`（`tests/unit/knowledge-api.test.mjs:101`，`skip: !f.native`：需要原生独立连接/PG），
> **与本片无关**，未被我改动。两次运行都**没有红项**。

```
> npm run test:mini
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
ℹ tests 5  ℹ pass 5  ℹ fail 0

> node tools/check-wechat-project.mjs
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.

> git diff --check        （无输出，exit 0）
```

### 3.5 页面清单三处同步（新增页面的既有断言）

新增 3 个页面 ⇒ 必须同批同步三处清单，否则既有断言必红：

```
> node --test tests/unit/miniprogram-login-return-to.test.mjs
ℹ tests 41  ℹ pass 41  ℹ fail 0
   （其中 miniprogram-login-return-to.test.mjs:86-87 逐项断言 navigation.PAGES === app.json.pages、
     navigation.TAB_PAGES === app.json.tabBar.list）

> node --test tests/local-debug.test.mjs
ℹ tests 5  ℹ pass 5  ℹ fail 0
   （其中 local-debug.test.mjs:118 页数断言随页数变化，按"只加数据项、不改判定逻辑"最小修正）
```

同步内容（**只加数据项，不改任何路由判定逻辑**）：

1. `miniprogram/app.json` 的 `pages` 追加 `pages/favorites/favorites`、`pages/history/history`、`pages/historydetail/historydetail`；
2. `miniprogram/utils/navigation.js` 的 `PAGES` 同步（与 `app.json.pages` **逐项相等**）；三者**都不是**底部 Tab ⇒ **不加** `TAB_PAGES`；
   另把 `pages/historydetail/historydetail` 加入 `ID_PAGES` 与 `UUID_ID_PAGES`（只接受 `?id=<uuid>`，不接受任何状态类参数）；
3. `tools/prepare-wechat.mjs` 的**打包允许清单**：`pages` 三项 + `utils/favorites-api.js`、`utils/history-api.js`
   （否则隔离工程缺页／`MODULE_NOT_FOUND`）。

页数轨迹：本片单分支 13 → **16**；并入 `c85a1e8`（+GY-I15 社区投稿/详情）后 = **18**。
合并后复核（同一命令，在合并树 `380edc3` 上）：

```
> node --test tests/unit/miniprogram-login-return-to.test.mjs tests/local-debug.test.mjs
ℹ tests 46  ℹ pass 46  ℹ fail 0
```

### 3.6 契约实现状态对照表（**必改**，否则 `test:unit` 必红）

```
> node tools/verify-contract-status.mjs --runtime --write-doc
PASS: 覆盖 112 条契约操作；已装配 83 条；implemented 13 / partial 86 / planned 13；横切维度 8 条；中文表格一致
PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

`docs/architecture/contract-status.json` 中本片 5 条 operation：`route_mounted: false → true`、
`status: planned → partial`（**保守不升档**）、补证据（行区间 + 用例名）与真实缺口；
`docs/architecture/contract-implementation-status.md` 由该工具**自动重生成**。

合并后（`main` 新增社区 16 条已装配路由）同一工具的运行期比对：

```
> node tools/verify-contract-status.mjs --runtime
PASS: 覆盖 112 条契约操作；已装配 99 条；implemented 13 / partial 86 / planned 13；横切维度 8 条；中文表格一致
```

### 3.7 与最新 main 的实际合并冲突（已解；**不重排、不删任何一侧**）

合并提交：`380edc33bf97e6a5b51dd89e661e733bd39d1712`（双亲 `fe6ab99` + `c85a1e8`）。

| 文件 | 处理 |
| --- | --- |
| `services/api/src/app.ts` | 导入块／`FastifyInstance` 声明／`BuildAppOptions` 注入项／`buildApp` 形参解构／`decorate`／路由 `register` **六处全部取并集**（本片 6 项 + GY-I15 社区 1 项） |
| `miniprogram/utils/navigation.js` | `PAGES` 并集；`ID_PAGES` = main 4 项 + `historydetail`；保留 main 的 `UUID_ID_PAGES` 并把 `historydetail` **也纳入** uuid 校验 |
| `miniprogram/app.json` | 自动合并为并集（18 页，顺序与 `navigation.PAGES` 逐项相等） |
| `tools/prepare-wechat.mjs` | utils 适配层并集（`community-api` + `favorites-api`/`history-api`）；`pages` 白名单 18 项 |
| `tests/local-debug.test.mjs` | 页数断言合并为 **18**；`dep` 清单补本片两个 utils |
| `docs/architecture/contract-implementation-status.md` | **不手改** ⇒ `--write-doc` 重生成 |
| `docs/architecture/contract-status.json` | 自动合并为并集（本片 5 条 + main 的社区/识别/隐私增量；运行期比对通过） |

**唯一"不能只保留双方"处（如实说明）**：`app.ts` 中 GY-I27 的
`consentSigningKey` / `consentGate` / `egressRevoker` 被**两侧各声明一次** —— 上游把该块**前移并扩成"两片接线"**
（新增持久外发账本 `createPostgresExportLedger`/`createPostgresPrivacyPorts`，位置在识别域服务构造**之前**）。
同一标识符二次 `const` 会直接 `SyntaxError`（实测：合并过程中 `tools/contract-status-runtime.mjs` 子进程报
`Identifier 'consentSigningKey' has already been declared`）。**最小必要改动**：删除**本片侧那份重复声明**，
保留上游版本（它是严格超集：仍以 `privacyInjection.consent`/`egressRevoker` 优先，只是多了持久账本），
并在原位留 4 行注释写清理由。本片自身的装配（store 构造／service／decorate／register）**全部保留**，
只是**同一段配置只能有一份声明**。

## 4 装配说明（如何复用既有成果）

### 4.1 服务端（`services/api/src/app.ts`，**追加式**，不重排既有装配）

```ts
const favoritesStore = favoritesInjection?.store ?? createMemoryFavoritesStore({ now: () => clock().getTime() });
const historyStore   = historyInjection?.store   ?? createMemoryHistoryStore({ now: () => clock().getTime() });
// 引用可用性端口：**默认未接线**（一律 unavailable，绝不假装可用）
const favoritesVisibility = favoritesInjection?.visibility ?? createUnwiredVisibilityPort();
const historyVisibility   = historyInjection?.visibility   ?? createUnwiredVisibilityPort();
// 任务状态端口：**默认接线到已合并的公开读取口**（只调公开方法，不改他人文件）
const historyJobPort = historyInjection?.job ?? createWiredHistoryJobPort({
  resolve: async ({ kind, jobId, userId }) => kind === 'recognition'
    ? app.recognitionService.getJob({ userId, jobId })   // #9 已合并
    : app.ocrService.getJob({ userId, jobId }),          // #10 已合并
});
const favoritesService = config.executionMode === 'real' ? null : createFavoritesService({ ... });
const historyService   = config.executionMode === 'real' ? null : createHistoryService({ ... });
```

- 5 条路由的**唯一注册点**：`registerFavoriteRoutes(...)` / `registerHistoryRoutes(...)`（与 `messages` 并列，追加在两行之后）；
- 新增可选注入：`favoritesInjection`／`historyInjection`／`userDataDeletionInjection`（**全部可选**，不传即默认）；
- `real` ⇒ 两个 service 为 `null` ⇒ 5 条路由 503 `PROVIDER_UNAVAILABLE`（**绝不用内存存储冒充持久化**）。
- **并入最新 main 时**同一文件出现 6 处冲突，全部按"并集"解决（见 §3.7）；
  唯一无法"只保留双方"的是 GY-I27 三个标识符被两侧各声明一次 —— 保留上游那份（超集），删除本片侧重复声明，
  本片自身的装配**一行未删**。因此现在的文件是「既有装配 + 本片装配」的合成结果，**没有重排、没有删任何一侧的功能**。

### 4.2 小程序端（复用既有成果，不重写）

| 复用对象 | 用法 |
| --- | --- |
| `styles/{tokens,icons,components}.wxss` | 页面直接用既有类名（`.page-heading`／`.section-head`／`.panel`／`.info-list`／`.pill--gray`／`.demo-caption`／`gy-icon--*`／`.tiny-art`），**不新写一套色板/字号/间距** |
| `components/gy-ui-button`、`gy-ui-card` | 收藏页/历史页/详情页的操作与卡片（`bind:tap`、`variant`、`block`） |
| `components/state-view` | 全部失败／空态收口：`guest`／`empty`／`loading`／`error`／`invalid`（**不另写空态**） |
| `utils/identify-api.js` | 历史详情复用 `describeJobState`／`isSuccessState`／`getRecognition`（**不重写**七状态呈现） |
| `utils/knowledge-api.js` | 收藏页的"可收藏资料"列表复用 `list`（`Knowledge.type` 前三类恰是契约允许收藏的 `FavoriteTarget.type`） |
| `utils/auth.js`／`utils/page-gate.js`／`utils/font-scale.js` | 门禁、联网判定、字号缩放（与既有页面同口径） |

**Demo 优先政策**：页面按 Demo 手机预览的色板／卡片／导航／交互形态落地；独立适老模式、正文统一 18px、
触控统一 44px、最大系统字号与多机型字体矩阵**属后续适老阶段**，本片不作为阻塞（既有字号支持与触控保护未删除）。
关键文字与操作均可见、可点、无遮挡；状态有文字＋图标双通道；"前端模拟/替身"标记清楚。

## 5 **未取得／未验证项**（如实，不得据此关闭整项 #16）

1. **真实识别结果**：依赖 **#9 识草**／**#10 OCR** 的真实模型输出。本片所有验证用的识别/OCR 记录都是
   **合成替身**（合成 `job_id`、合成候选与分数、合成 OCR 字段）——**不得**记作真实识别历史。
2. **正式身份**：依赖 **#4 正式会话**。本片用合成账号与合成 bearer 令牌驱动回环 HTTP。
3. **持久化**：只有**内存** store，**没有**新增数据库迁移（`services/api/db/**` 属共享文件，本片不碰）。
   ⇒ `real` 模式整域 503；**不宣称**收藏/历史已端到端可用。
4. **引用可用性端口：该日（2026-10-14）状态为未接线；其后 #167 已接线** —— 本记录成文当日，生产装配下所有收藏/历史行的 `reference_state` 恒为 `unavailable`；**其后 #167 已接线**（`createWiredVisibilityPort`；装配点 `services/api/src/app.ts` 的 `defaultVisibility`；可用性按 `/knowledge` 公开读面**每次读取重新派生**）⇒ 该结论**仅描述本记录当日**，**#167 之后的实际可见性本记录未复核**。
   本片用**明确标注的可控替身**证明"每次读取都重新派生、且 fail-closed"；真实可见性核验中，
   `species`/`herbicide`/`scheme` → `/knowledge` 公开读面已由 #167 接线；**识别/OCR 侧的当前可见性接入仍未接线**（#167 改动面仅 `services/api/src/app.ts` 与其单测）。
5. **识别/OCR → 历史的写入接线属跨线（未做）**：那一句调用要加在 `recognitions/**`／`ocr/**`（#9/#10 的文件），
   本片**不改他人已合并实现**，只交付**内部创建口**（签名见 §6.1）与其测试。
6. **`deleteHistory` 的关联删除级联未接线**（属 GY-I19／跨线）：本片只删除历史行本身，
   并通过端口 + `X-GY-Cascade` 披露头如实回传 `initiated|unwired|failed`，**不谎称已完成**。
7. **真机与微信开发者工具证据：未取得**。本机有 `D:\微信web开发者工具\cli.bat`，但本片**未成功执行**
   （未登录/需交互，未反复重试）。**未跑 = 不写通过**。复核命令（供指挥/监工在已登录环境执行）：
   ```
   "D:\微信web开发者工具\cli.bat" open --project E:\GengYunCommander\GengYun_W28
   "D:\微信web开发者工具\cli.bat" auto --project E:\GengYunCommander\GengYun_W28 --auto-port 9423
   ```
   另：`node tools/check-wechat-project.mjs` **不是**微信编译器或真机证据（脚本自带该声明）。
8. **真实供应商调用**：本片无任何付费/外部调用（未发起）。
9. **适老验收**：暂缓 **≠ 通过**（见 Demo 优先政策）。

## 6 跨线披露与待接线

### 6.1 内部创建口（**稳定签名**，供指挥一行接线）

```ts
// 已 decorate：app.historyService（real 模式为 null）
app.historyService.appendHistory({
  owner_id: string,        // 归属用户 id（uuid）；服务端调用方给出，绝不来自客户端
  kind: 'recognition' | 'ocr',
  target_ref: { type: 'recognition' | 'ocr', id: string, revision: number },
  job_id: string,          // 内部作业 id（1..80）；读取时用它向已合并的 getJob 核实时状态
  job_state: 'queued'|'running'|'succeeded'|'uncertain'|'failed'|'timed_out'|'cancelled',
  event_key: string        // 1..200；去重键：同 (owner_id, event_key) 只存在一条历史行
}): Promise<{ created: boolean; history: HistoryRecord }>
```

- **调用位置**：`recognitions/**` 与 `ocr/**` 里"任务创建成功、拿到 `job_id` 之后"各一句
  （属 #9／#10 的文件，本片不改）；建议 `event_key = 'recognition:' + jobId` / `'ocr:' + jobId`。
- **语义**：只记"发生过一次任务"（含失败／超时／取消），**不产生任何"已使用"事实**；
  重复调度返回既有行且 `created: false`；未知字段（含 `used`）⇒ 400 `INVALID_REQUEST`。
- **不是**契约 operationId、**不注册**任何路由、不接受客户端调用。

### 6.2 其它跨线/待接线

| 项 | 归属 | 本片做了 | 本片**没做** |
| --- | --- | --- | --- |
| 识别/OCR → 历史写入 | #9／#10（跨线） | 内部口 + 测试 + 披露 | 那一句调用 |
| 关联识别/OCR/媒体/外发删除的级联 | GY-I19／跨线 | 端口 + `X-GY-Cascade` 披露 + 测试 | 真实级联实现 |
| 备份副本清除（F13 的 backup 阶段） | GY-I19 | 端口 + `backupState: pending` 如实 | 真实备份清除 |
| 收藏/历史的 PG 持久化 | 后续 | 存储接口 + 内存实现 | 迁移与 PG 实现 |
| 真实目标可见性核验 | 后续 | 端口 + fail-closed 默认 | 真实核验实现 |
| 注销删除的 HTTP 入口（`requestAccountDeletion`） | GY-I19 | F13 模块可被其直接复用 | 该路由本身 |

`/me/account/deletion`／`/account/deletions/{id}` 在本仓**至今未实现**（`services/api/src` 中无任何命中），
本片的 F13 注册表**已就绪可被其复用**；本片**不改**那条流程。

## 7 PR 正文可粘贴段落（`Refs #16`，**不关闭整项**）

```markdown
Refs #16（**不关闭整项**）

### 本片交付
- 收藏（`GET/POST /api/v1/favorites`、`DELETE /api/v1/favorites/{id}`）：新增/取消（去重，不产生第二行）、
  归属与越权同形 404、If-Match/Idempotency-Key 契约纪律、签名游标分页、real 模式整域 503。
- 历史（`GET /api/v1/history`、`DELETE /api/v1/history/{id}`）：时间/任务类型/七类任务状态真实可见
  （含失败/超时/取消/不确定）、**读取时重查**目标可见性与任务状态、删除历史行 + 级联披露。
- **读取时重查**：`reference_state` 逐次派生、不入库不缓存；未接线/抛错/非闭集一律 `unavailable`；
  对象侧原因折叠为**同一条非披露说明**（不区分隐藏与不存在）。
- **针对性负例**：隐藏/失效/注销后，缓存与旧链接**不得**让对象重新公开；旧收藏**不恢复**失效目标的推荐资格；
  详情链接里夹带的状态字段一律忽略（状态只来自实时读取）。
- **注销删除接 F13**：复用已合并的 `packages/privacy` 删除注册协议（`createDeletionRegistry` +
  `createPrivacyDeletionCoordinator`），只注册 `favorites`/`history` 两个模块；在线部分真删并留证据，
  **备份副本清除未接线 ⇒ 如实 pending、不谎称完成**。
- 页面：`pages/favorites`、`pages/history`、`pages/historydetail`（复用 `styles/*`、`gy-ui-*`、`state-view`、
  `identify-api`、`knowledge-api`）；`app.json.pages`、`navigation.PAGES`、`prepare-wechat` 白名单三处同步；
  `profile` 页加两个入口（追加式）。
- 契约状态对照表同步 5 条 `route_mounted: false → true`（`status` 保守保持 `partial`）。

### 自检（作者侧，本机原始输出见证据页）
`npm run lint` ✅ ／ `npm run test:unit` 1833 passed / 0 failed / 1 skipped（既有 PG 用例） ✅ ／
`npm run test:mini` 5/5 ✅ ／ `git diff --check` 干净 ✅ ／
`node tools/verify-contract-status.mjs --runtime --write-doc` ✅（112 条契约操作，已装配 83 条）／
新增测试 4 个文件 26 例全绿（含 2 条针对性负例）。

### 未取得／未验证（不得据此关闭整项）
真实识别（#9）／真 OCR（#10）／正式身份（#4）／真机与微信工具证据／真实供应商调用：
**均未取得**，本片用合成替身并逐条标注；服务端只有内存存储（real 模式整域 503）。

### 跨线披露（待指挥另行派单）
① 识别/OCR → 历史的**内部创建口**那一句调用（属 #9/#10 文件）；
② `deleteHistory` 的关联识别/OCR/媒体/外发删除级联（属 GY-I19）；
③ 备份副本清除（F13 的 backup 阶段，属 GY-I19）。
```

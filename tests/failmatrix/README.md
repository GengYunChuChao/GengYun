# GY-I22（#22）失败回归矩阵 · 可执行骨架

一套**能重复跑**的权限/安全失败回归：表驱动、每条用例给真实读数、每条关键守卫配**负控制**
（故意放宽守卫 → 对应用例必须真红 → 原字节恢复 → sha256 前后一致 → 复跑转绿）。

**本片不宣称 #22 完成。** 这里交付骨架 + 249 条用例 + 27 条负控制，覆盖「身份与权限面
（游客/越权/后台/会话与注销）」「媒体归属与访问凭据」「重复请求」「无效输入」「审核回调与 AI 失败」
「下架缓存」「版本回写」「提示注入」「下架后引用跳转」。**真实 AI 外呼、真机、微信端到端、真实对象存储签名过期、
断网重试、账号停用、注销到期清理、在途取消 409** 仍**未取得**（见末尾「未取得」一节，逐条写明为什么）。

证据页：`docs/verification/gy-i22-failmatrix-20261022.md`（含「用例 id → #22 acceptance → 实际读数」三列表，
由 `tools/i22-failmatrix-evidence-table.mjs` 从机读结果生成）。

## 一条命令

```bash
node tests/failmatrix/run.mjs                  # 全跑（HTTP 229 + 受信 seam 20 = 249 条）
node tests/failmatrix/run.mjs --only=C2        # 只跑某族（前缀匹配，D/E/F 族同样适用）
node tests/failmatrix/run.mjs --only=D1-01,C6-10 --json=out.json
node tests/failmatrix/run.mjs --list           # 只列用例

node tools/i22-failmatrix-negative-control.mjs               # 27 条负控制
node tools/i22-failmatrix-negative-control.mjs --only=NC-09  # 只跑一条

# 真实 PostgreSQL 17 臂（把权限面 C1–C4/C10/C11 跑在一次性真 PG 集群上，逐条记录 stub vs 真 PG 差异）
$env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'        # 必填：含 initdb/pg_ctl 的目录（PG 17.x）
node tests/failmatrix/run-real.mjs                            # 缺 GY_PG_BIN ⇒ 退出 77（未取得，不是通过）
node tests/failmatrix/run-real.mjs --json=out.json            # 另存机读结果

# 证据页三列表（读上面两条命令的 --json，重跑即复核）
node tools/i22-failmatrix-evidence-table.mjs                       # 只打印不写盘（对账）；要写页必须 --write --page=<目标页>
```

进 CI/单测入口：`tests/unit/gy-i22-failmatrix.test.mjs`（stub 臂，`npm run test:unit` 会带上它）。
它真跑一遍全矩阵并断言 `FAIL 0` / 条数不少于 249，另加一条**静态同步检查**：负控制清单里
每处 `find` 必须在当前产品代码里恰好出现一次（守卫被重构时这条先红，而不是等你发现矩阵不再变红）。

真 PG 臂的闸门入口：`tests/unit/gy-i22-failmatrix-real.test.mjs`（只锁「缺 `GY_PG_BIN` ⇒ 退出 77、
不伪装 PASS」与「权限面覆盖范围与 stub 用例表同源」两条契约，⛔ 不锁真库全绿——那是 `run.mjs` 的职责）。

## 为什么用进程内 `app.inject`，不用 loopback HTTP

- 每条用例都要**零端口、零外呼、可复现到行**。`inject` 直接走 Fastify 的完整请求生命周期
  （`onRequest` → schema 校验 → `preHandler` 守卫 → 处理器 → `onSend`），与 loopback 的差别
  只在 TCP 编解码；本轮没有一条用例要验传输层。
- loopback 要选端口、处理并发占用、在 CI 里额外开 socket；`inject` 一条命令跑完。
- **代价（如实记账）**：不覆盖反向代理、真实 TLS、真实 body 上限与真实网络超时。这些属于
  「未取得」里的「真机/真实网络」一条。

世界装配（`world.mjs`）：内存 auth store + 内存业务 store + 替身对象存储 + 合成审核端口，
四个网络 seam **持有即抛错**——跑这套用例不可能偷偷打到真实供应商。执行模式固定 `stub`，
运行器对每个响应额外校验 `meta.execution_mode === 'stub'`。

**作业过滤腿（S-6）另建第二个 app**（`world.mjs` 的 `createJobFilterWorld`）：与默认世界**共享 auth store**、
作业端口换成内存参考实现（`createMemoryAdminJobPort(ADMIN_JOB_SEED)`，`wired: true`）。原因是
`listAdminJobs` 的判定顺序是「鉴权 → 端口接线(`503`) → 入参闭集(`400`)」（`admin/ops/service.ts:718-724`），
默认世界未接线 ⇒ 过滤参数再错也**永远到不了 400**；而 `C3-20` 必须继续证明「未接线 ⇒ `503`」，所以不能把默认世界接线。
用例用 `app: 'jobs'` 点名该 app，缺省 `'main'` ⇒ 既有用例一条都不改道（loopback 臂两个 app 各绑一个自选端口）。

受信 seam（`seams.mjs`）：审核回调、AI 端口、下架缓存这三类失败**不经过 HTTP**，而是走
`tests/moderation/_http-fixtures.mjs` 里已被其它套件使用的受信夹具（`makeHarness` / `signedCallback` /
`makePort`），因此 D 族的读数来自**真实服务代码**，不是复刻一份同形实现。

## 文件

| 文件 | 作用 |
| --- | --- |
| `world.mjs` | 世界装配 + 身份播种（直插会话，零登录外呼）+ 请求助手 + 响应指纹 |
| `cases.mjs` | HTTP 用例表：`id` / `method` / `path` / `headers` / `body` / `expect{status,code,etag}` / `check` / `sameShapeAs` / `concurrent` / `app`（缺省 `'main'`；`'jobs'` = 已接线作业端口的第二个 app） |
| `seams.mjs` | 受信 seam 用例表：`invoke` + `expect{code}` + `check`（审核回调 / AI 失败 / 下架缓存 / 版本回写） |
| `run.mjs` | 表驱动 runner：判定 + 拒绝不变量 + 同形对照 + 按族/批次汇总 + `--json` 机读结果 |
| `run-real.mjs` | **真实 PostgreSQL 17 臂**：自己起一次性真 PG 集群（`GY_PG_BIN` 闸门 + `await import('pg')`），把权限面 C1–C4/C10/C11 的 world 换成真 PG store，逐条记录 stub 期望 vs 真 PG 实际；缺 `GY_PG_BIN` ⇒ 退出 77（未取得，不是通过）。**R72-W12 起已接进 CI**：`.github/workflows/real-pg-integration.yml` 末尾的 job `failmatrix-real-17.11`（键 `failmatrix-real-17-11`）每次 PR 真跑它，`GY_PG_BIN` 由 PGDG 装出的 `postgresql-17` 提供（`/usr/lib/postgresql/17/bin`），`--json` 产物按 artifact 归档；判决口径见下节末「进 CI 后的判决口径」 |
| `mutations.mjs` | 27 条负控制清单（`file` + 逐字 `find` + `replace` + `watch` 用例；`edits` 支持「同一条负控制改多处」） |
| `tools/i22-failmatrix-negative-control.mjs` | 负控制执行器：sha256 → 改 → 跑（必须全红）→ 原字节恢复 → sha256 复核 → 复跑（必须全绿） |
| `tools/i22-failmatrix-evidence-table.mjs` | 证据表生成器：读 `--json` 结果生成三列表，条数与文档声明不符即失败；归档页保护基于真实路径比较 + 文件身份（`dev` + `ino`，硬链接也拦得住）+ 仓库内包含性校验，`--write` 无隐式默认页（必须显式 `--page=`，且目标必须在仓库内；点名归档页要 `--i-know-this-rewrites-archive`，带旗标也仍受条数一致性约束——页内条数必须等于 `EXPECTED`，所以当前 168 / 23 的归档页必被拒），对账不通过一律不写盘 |

## 用例族与批次

| 族 | 条数 | 覆盖 |
| --- | --- | --- |
| C1 | 37 | 游客面：无凭据一律 `401 SESSION_REQUIRED`（不是 403/404/500），且带 `no-store` |
| C2 | 24 | 越权（IDOR）：A 读写 B 的私有行一律 `404`，与「不存在」同形；列表隔离；公开内容不得过度拦截 |
| C3 | 36 | 后台：用户会话 `403 SCOPE_DENIED`；缺 scope `403`；有 scope 2xx；未接线面 fail-closed `503`；作业过滤 `?state=`/`?error_code=` 闭集外 ⇒ `400 INVALID_REQUEST`（重复键 ⇒ `code:'type'`）、游标绑定筛选组合（换组合 ⇒ `400 INVALID_CURSOR`）、合法但无匹配 ⇒ `200` 空页（S-6 补 9 条） |
| C4 | 21 | 会话与注销：注销/过期/旧 epoch/坏凭据的拒绝码；注销回执 bearer 的绑定、换发与重放；退出后 `/me/profile`、`/catalog/crops`、`/knowledge` 三面与 `/favorites` **同形** `401 SESSION_EXPIRED` |
| C5 | 10 | 媒体归属与媒体访问凭据：跨主体 `404`、缺/错 token、内容-媒体不匹配 |
| C6 | 11 | 重复请求：同键同体重放同一行、同键异体 `409`、缺键 `400`、并发只产生一行；已登录取消收藏缺 `If-Match` ⇒ `428 REVISION_REQUIRED` |
| C7 | 16 | 无效输入：坏 uuid / 坏游标 / 越界分页 / 多余字段 → `400`（含 `INVALID_CURSOR`） |
| E1 | 3 | 提示注入：标题/评论里的指令只作数据；命中 `PROMPT_INJECTION` ⇒ `400`；干净文本 `201` |
| E2 | 3 | 媒体访问凭据：篡改/越权 token ⇒ `404`（与不存在同形，不泄露对象存在性） |
| D1 | 11 | 审核回调：重复/旧版本/旧租约/摘要不符/过期/坏签名/控制字段/撤权/下架 ⇒ 拒绝；回调绝不发布 |
| D2 | 4 | AI 失败：端口抛错 / 超时 / 结构未知 / 规则未过 ⇒ 任务 `quarantined`、`publishable:false` |
| D3 | 2 | 下架缓存：下架 ⇒ 读缓存键失效 + 可见性 `hidden`；二次下架幂等 |
| D4 | 3 | 版本回写：改版后未筛查 ⇒ `INPUT_UNCERTAIN`；已筛查 ⇒ 可发布；历史版本 ⇒ `REVISION_CONFLICT` |
| C10 | 23 | 异步 AI 域游客面（识别 / OCR / 转写 / 合成 / 作业 / 会话）：无凭据一律 `401 SESSION_REQUIRED`，且带 `no-store`（#449 引入） |
| C11 | 39 | 异步 AI 域归属面：他人资源一律 `404`（与「不存在」同形，不泄露存在性）、列表隔离（#449 引入） |
| F1 | 6 | 引用跳转：消息引用帖子/评论，删除目标后同一条消息 `reference_state` 从 `available` 迁到 `unavailable`（同形，不崩溃不泄露） |

批次：**B1** = C1–C4，118 条（身份与权限面）· **B2** = C5–C7，37 条（媒体归属、重复请求与无效输入）·
**B3** = D1–D3，17 条（受信 seam：回调 / AI 失败 / 下架缓存）· **B4** = D4+E1+E2，9 条（版本回写 / 提示注入 / 媒体凭据）· **B5** = C10+C11，62 条（异步 AI 域的游客面与归属面）· **B6** = F1，6 条（下架后引用跳转 unavailable）。

## 拒绝不变量（每条 4xx/5xx 都校验，不只是状态码）

1. `Cache-Control: no-store`（认证/授权响应不得被缓存）；
2. 封套带 `error{code,message,retryable,details}`，且 `meta.contract_version === '1.0.0'`；
3. `meta.execution_mode === 'stub'`（防止有人把真实模式混进来复跑）；
4. **失败响应不得带 `data`**（半成功比失败更危险）。

## 负控制：哪些守卫、为什么这么挑

| 负控制 | 改的那一处 | watch（必须真红） |
| --- | --- | --- |
| NC-01 | `auth/middleware.ts` 无凭据 → `SESSION_EXPIRED` | C1-01/02/09/16/27/35、C4-07/08 |
| NC-02 | 会话已撤销 → `return session` | C4-03、C4-04 |
| NC-03 | 会话已过期 → `return session` | C4-05 |
| NC-04 | 删 `ACCOUNT_INACTIVE`（epoch 变更） | C4-06 |
| NC-05 | 删「后台接口不接受用户会话」 | C3-01/02/07 |
| NC-06 | 删路由层 `requireScope` | C3-12（只有这条只依赖路由层） |
| NC-06b | 删**两层** scope 校验（路由层 + `admin/identity.ts`） | C3-09/10/11/13 |
| NC-07 | 删 `routes/support.ts` 幂等键门 | C4-01、C4-11 |
| NC-07b | 删 `favorites/validate.ts` 自己的键门 | C6-04 |
| NC-08 | 注销回执不再绑定注销单 id | C4-14 |
| NC-09 | 删 `media/service.ts` 的属主判断 | C2-01、C2-02（跨主体读媒体 → 200 泄露） |
| NC-10/11/12 | 删收藏/历史/消息列表的属主过滤 | C2-22 / C2-23 / C2-24 |
| NC-13 | 删回调回放守卫 | D1-01 |
| NC-14 | 删终态守卫 | D1-02 |
| NC-15 | 删下架守卫（旧回调复活下架对象） | D1-03 |
| NC-16 | 删输入摘要比对（#421 复发形态） | D1-06 |
| NC-17 | 删「规则层否决 ⇒ rejected」分支 | D2-04 |
| NC-18 | 删读缓存按目标失效 | D3-01 |
| NC-19 | 判定引擎不再因命中阻断级规则判 rejected | E1-01、E1-02 |
| NC-20 | 删「未筛查 ⇒ INPUT_UNCERTAIN」分级 | D4-01 |
| NC-21 | 删「版本已被推进」守卫 | D4-03 |
| NC-22 | `privacy/exports-list.ts` 的 `ledger()` 懒建 catch：读面解析失败不再折成 503，原样上抛 | 单元测试 `exports-route-http.test.mjs`「连接池形状不合：装配期不抛（buildApp 能起），请求期 fail-closed 503」 |
| NC-23 | `db/catalog.ts` 的 `readHomePreviews`：删掉语句超时单独分级（504 退化成 503） | 单元测试 `public-home.test.mjs`「database failures use safe contract errors, including statement timeout」 |
| NC-24 | `knowledge/applicability-screen.ts` 的 `screenRegistrationMatch`：非 matched 的阻断码钉成 `INTERNAL`（不再 fail-closed 成 4xx） | 单元测试 `knowledge-applicability-screen.test.mjs`「GY-I08 装配：登记匹配非 matched 一律带 4xx，matched 保留记录但资格另判」 |
| NC-25 | `routes/consents.ts` 的隐私政策读面删掉 `preHandler: guards.requireUser`（无会话也能读 `GET /me/privacy-policy`） | 单元测试 `privacy-policy-read.test.mjs`「路由已装配：routes/consents.ts 里有路径、noStoreHook 与 requireUser 闸门」 |

> **NC-22/23/24（R34 追加）的靶子不是矩阵用例，而是既有单元测试**：`me/exports`、`public/home`、
> 登记校验面这三个读面不进 HTTP 失败矩阵，守着它们的是 `tests/unit/*.test.mjs`。执行器为此支持
> `unitWatch: [{ file, pattern }]`，`pattern` 是测试名的**字面子串**：改一处后必须**恰好那一条**转红
> （`# fail ≥ 1` 且 `# pass = 0`），恢复原字节后必须**恰好一条**转绿（`# fail = 0` 且 `# pass = 1`）。
> **订正（2026-10-31，基线 `7ada259e`）**：本页 R34 小节此前写着「隐私说明（`GET /me/privacy-policy`）本轮判为
> **负控制不成立**：该域无路由、无守卫代码、无守护测试，缺口性质是「缺实现 / 缺测试」」。这句是 R34 时点
> （基线 `d4a47206`）的**真话，现在已过期**——不是当初写错。时间线：路由/守卫/测试由 `9bd14e56`
> （2026-10-24，PR #534）引入，三件东西现在各自落在——路由与守卫 `services/api/src/routes/consents.ts:90-97`
> （守卫在 `services/api/src/routes/consents.ts:92` 的 `preHandler: guards.requireUser`；空态口径见
> `services/api/src/privacy/privacy-policy.ts:37-44`）、装配 `services/api/src/app.ts:2418` 的
> `registerConsentRoutes`、守护测试 `tests/unit/privacy-policy-read.test.mjs:210`「路由已装配」（真库同形用例
> `tests/integration/consent-zero-policy-pg.mjs:405-413`）。所以该域缺的是**矩阵用例 + 负控制**，不是实现：
> 本片补了 **NC-25**（`tests/failmatrix/mutations.mjs` 末尾，删 `services/api/src/routes/consents.ts` 里那行
> `preHandler: guards.requireUser,`，靶子是既有单测「路由已装配」），实测「变异后恰一红（`# fail 1 / # pass 0`）
> ／恢复后恰一绿（`# fail 0 / # pass 1`）」。按派单 §4 当时未动条数读数；随后由指挥在本片内统一重算（负控制 26 → **27**
> 、真库臂实跑面 168 → **180**，见 §「真实 PG 臂」）；矩阵用例仍未为隐私说明域新增（NC-25 只有 `unitWatch`、
> `watch` 为空），因此证据页「仍未进矩阵的域」那两行的口径不变——**「进矩阵」与「有负控制」是两件事**。

四条**必须知道**的实测结论（它们本身就是被测代码/工具链的性质，不是测试写法）：

1. **收藏/历史/消息的 IDOR 删除，单改 service 一行不会变红**：service 判属主之后，内存 store
   的 `remove()` / `deleteHistory()` 又按 `owner_id` 复核一次，`commitRefusal` 把它映射回同一个
   `404`，用例仍然绿。所以这类用例的代表性负控制落在**列表隔离**（store 的 `list*` 过滤那一行）
   与**媒体归属**（`ownedRecord` 那一行）。要证明「删除路径」真能红，得同时改两处——那就不叫
   「一处一行」的负控制了，本片不做。
2. **后台 scope 是两层校验**：路由层 `guards.requireScope(...)` 与 `admin/identity.ts` 的
   `requireAdminScope` 各判一次。单独去掉任一层，缺权限会话仍被另一层挡成 `403`；所以
   `NC-06b` 是「两层各删一行」的组合改动，`NC-06` 只用于证明**只依赖路由层**的那条用例（后台登出）
   会真红。
3. **规则严重级不是「一行」**：`packages/moderation/rules.mjs` 的 `severity: 'block'` 受
   `packages/moderation/constants.mjs:127` 的 `RULE_SEVERITIES = ['block']` 自校验保护，改成 `'warn'`
   会让规则目录直接抛 `RULE_CATALOG_INVALID`（矩阵在播种阶段崩、无机读结果）。因此 NC-19 改锚
   判定引擎那一行（`packages/moderation/engine.mjs:421`）——负控制要挑**真能单独翻结论**的那一处。
4. **`REVISION_SUPERSEDED` 有两处兜底**：删掉 `moderation/service.ts:758`（NC-21）后发布**没有真的发生**，
   只是拒绝理由从 `REVISION_SUPERSEDED:2:1` 退化成 `REVISION_CONFLICT`（第二层在
   `moderation/visibility.ts:280-281`）。NC-21 证明的是「可解释的拒绝理由由这一行给出」，
   不是「删了就能发布」——如实记账。

## 未取得（本片没有证据的，不许当成绿）

- **真实 AI 外呼**：真实供应商的失败/超时/配额/结构漂移。D2 用替身端口**注入**失败，不是真实外呼。
- **真机 / 微信端到端**：`POST /auth/wechat` 真实换取会话、真机媒体上传与预览——未取得。
- **真实对象存储与上传签名过期/篡改**：E2 覆盖的是**访问凭据**（`X-Media-Access-Token`）的篡改与越权，
  不是对象存储预签名 URL 的过期/密钥轮换。
- **真实网络失败**（断网、半开连接、重试退避）与反向代理/TLS——`inject` 不经过网络栈。
- **账号被停用（`users.state !== 'active'`）真实生效**：stub 没有账号写权威，只覆盖 fail-closed 503。
- **注销冷静期到期后的真实清理**（在线 7 日 / 备份 30 日执行面）：只覆盖申请→回执→冷静期内原会话可用。
- **在途取消（`REQUEST_IN_PROGRESS` 409）与「注销-撤回」**：内存台账太快，未出现 409；契约无 cancel-deletion 入口。
- **社区媒体授权全链路**：stub 下「带媒体的发帖」会被内容筛查判 `422 INPUT_UNCERTAIN`（`decision=quarantined`），
  正路走不通；本片只能覆盖它前面的 `400/404` 分支（C5）。
- **收藏的引用跳转**（内容下架后端上跳 `unavailable`）：收藏契约目标闭集是 `species|herbicide|scheme`
  （不是帖子/评论），其下架形态（来源撤回 `SOURCE_WITHDRAWN`）需要知识公开读面，stub 世界无该读面 ⇒
  端到端仍未取得；消息域引用帖子/评论的下架跳转已由 F1 族覆盖（作者删除后同一条消息 `reference_state` 迁 `unavailable`）。
- **外部删除状态**（第三侧删除后的同步）：仓内无该能力接线。
- **真实 PG 下的同一矩阵（R34 追加：已接真 PG 臂，差异见下节）**：`run-real.mjs` 已把权限面
  C1–C4/C10/C11 跑在一次性真 PG 17 集群上，逐条记录 stub vs 真 PG 差异。**未取得的部分**：media /
  社区投稿 / 异步 AI 作业（识别 / OCR / 转写 / 作业）在 real 模式下 fail-closed（对象存储、真实供应商、
  真实媒体未接线），无法播种属主行，对应用例如实标 `not-runnable`（占 R29 时点 168 条里的 35 条；现表 180 条，这组读数未随现表重跑，见下节），⛔ 不拿
  「不存在」当「越权 404」的假同形。

  订正（2026-10-31，基线 `7ada259e`）：上面这条 R34 追加只写了「已接真 PG 臂」，容易被读成「CI 上已经在跑」。
  事实是 `run-real.mjs` 对 `.github/workflows/` **零命中** —— 它只在本机手跑过，CI 上一直没有读数。R72-W12 起
  由 `real-pg-integration.yml` 末尾的 job `failmatrix-real-17.11` 每次 PR 真跑，判决口径见下节末。

## 真实 PG 臂（`run-real.mjs`）· stub vs 真 PG 差异结论

本臂把矩阵 world 的内存 store 换成真 PG store（`execution_mode=real` + 真 `pool`），在**一次性
PostgreSQL 17.11 集群**上实跑权限面 **180** 条（C1 37 + C2 24 + C3 36 + C4 21 + C10 23 + C11 39）；R29 时点读数是 168 条（C3 27 + C4 18），差额 12 条 = C3 的 9 条作业过滤腿（`C3-28`…`C3-36`）+ C4 的 3 条「注销后旧会话读 个人资料／目录／资料库」（`C4-19`/`C4-20`/`C4-21`）。
逐条比 `status`+`code`（stub 期望 vs 真 PG 实际）并校验 `meta.execution_mode === 'real'`。

实测读数（本机 PG 17.11，基线 `d4a47206`，**当时口径 168 条**）：**168 条 = same 114 / different 19 / not-runnable 35**；这组读数**没有**随现表 180 条重跑（真库臂要 `GY_PG_BIN`，沙箱内跑不了），别把 114/19/35 当成 180 条的分母。
`same` 是「stub 与真 PG 行为逐条一致」的证据；`different` 是真实行为差异；`not-runnable` 是「real
模式该域 fail-closed，无法播种夹具」。差异分五类：

| 类别 | 用例 | stub | 真 PG | 为什么 |
| --- | --- | --- | --- | --- |
| 未接线面 fail-closed → 真接线 | C3-19 读账号、C3-20 读作业、C3-21 停用账号 | 503 | 200 | real + 真库时账号/作业/停用权威接 PG（stub 无账号写权威） |
| 已接线面 → real fail-closed | C3-14 读内容族、C3-15/C3-26 读审计、C3-22 读不存在内容条目 | 200/404 | 503 | 后台内容 store / 审计只读口在 real 模式 fail-closed（无真实内容权威 / 运行时角色未授权审计函数） |
| 媒体域 fail-closed | C2-11/12/13（不存在媒体读/删/访问） | 404 | 503 | 媒体对象存储 real 模式未接线，整域 503，连「不存在」也 503 |
| 注销受理 fail-closed | C1-30、C4-11、C4-15 | 401/400/202 | 503 | real 模式注销执行链路（7 日在线/30 日备份）未实现 ⇒ 整域 503 |
| 同意门先于存在性判定 | C2-18、C11-08/14/16/22（改/确认不存在资源） | 404 | 403 `CONSENT_REQUIRED` | real 模式同意门（`public_posting` 等）接 PG 后，PATCH/POST 面先撞 403 再判存在性 |

**一条级联差异（如实记账）**：C3-21 在真 PG 下**真的停用了 B**（stub 该面 503 无副作用），因此排在其后的
C11-39（「B 仍能读自己的会话」正控制）由 200 变为 401 `SESSION_EXPIRED`——这不是独立差异，而是 C3-21
真实副作用的级联，正好证明「真 PG 停用面会真的让会话失效」而 stub 做不到。

**同源保障**：本臂的用例表**直接复用 `cases.mjs`**（不另写一套），只换 world（真 PG store）+ 判定口径
（`real` 而非 `stub`）。`tests/unit/gy-i22-failmatrix-real.test.mjs` 锁住「缺 `GY_PG_BIN` ⇒ 77」与
「权限面覆盖范围 = 180 条同源」两条契约。其中 9 条作业过滤腿（`app: 'jobs'`）在本臂记「不跑」：
它们依赖已接线的内存作业端口种子，real + 真库没有作业读权威可播种（stub 臂与单测里全跑）。

### 进 CI 后的判决口径（R72-W12，基线 `7ada259e`）

这条臂从 R72 起在 CI 上有读数。job 是 `.github/workflows/real-pg-integration.yml` **末尾追加**的
`failmatrix-real-17.11`（键 `failmatrix-real-17-11`，`runs-on: ubuntu-24.04`，job 级封顶 55 分钟 = Σ step 封顶
45 + 前置余量 10）。它**不**吃 `services.postgres`：脚本自己 `initdb` 一次性集群，job 只负责用 PGDG 源装
`postgresql-17`（装完先自证 `initdb --version` 主版本是 17），把 `/usr/lib/postgresql/17/bin` 传给 `GY_PG_BIN`，
另给 `GY_I22_PG_ROOT`（脚本唯一读的数据根键）与 `PGCLIENTENCODING: UTF8`，然后跑
`node tests/failmatrix/run-real.mjs --json="$RUNNER_TEMP/failmatrix-real/real.json"`，产物按 artifact 归档 14 天。

**不可静默通过 —— 两条独立判决，任一成立就红：**

1. **退出码**：`77` = 没拿到 17 的服务端二进制 ⇒「未取得」，job 把它显式升级成 `exit 1`
   （脚本头注释写的就是「77 = 未取得，不是通过」）；其它非 0 原样透出。⛔ workflow 里**不传**任何放宽跳过的
   开关/环境变量（守卫 `tests/unit/ci-real-pg-wiring.test.mjs` 对这类字样在**任何** workflow 里出现即判红）。
2. **机读自证**：`exit 0` 之后再读一遍 `--json` 产物（node，不是 shell 数值闸门），要求「总条数 > 0」且
   「三档计数之和 `same + different + not_runnable` === 总条数」，并顺带核 `rows.length === 总条数`、
   `execution_mode === 'real'` —— 「打完成绩也退 0」「产物被清空」这两类回归都在这里红。
   ⛔ **不断言 `different === 0`**：差异正是这条臂的产品，全 `same` 反而应该先怀疑用例没换代；
   ⛔ **不断言总条数恰好 180**：`180` 是**今天**用例表的口径，硬钉等于把「加一条用例」变成假红。

**读数口径要对齐的两个数字**：`168 条 = same 114 / different 19 / not-runnable 35` 是基线 `d4a47206` 上**本机
PG 17.11** 手跑的读数（当时权限面 `C3` 27 条 + `C4` 18 条）；当前用例表是 **180 条**（`C3` 36 / `C4` 21，由
`tests/unit/gy-i22-failmatrix-real.test.mjs` 的「同源 = 180 条」断言锁着）。180 条口径的真读数已由 CI 产出，见下节。

### 首个真读数（2026-10-31，运行 `41137232998` / job `124342580280`，head `439970c2`）

这是这条臂**第一次在 CI 上跑完**并留下可复查的读数（artifact `failmatrix-real-ecd95703…`，`real.json` 89945 字节）：

| 档 | 条数 | 含义 |
| --- | --- | --- |
| `same` | 116 | 真 PG 与 stub 判定一致 |
| `different` | 20 | 真 PG 下的实际与 stub 期望不同（**这是本臂的产品，不是失败**） |
| `not-runnable` | 44 | real 模式下该域 fail-closed、夹具不可播种 |

族分布与用例表一致：`C1` 37 / `C2` 24 / `C3` 36 / `C4` 21 / `C10` 23 / `C11` 39 = 180；产物里
`execution_mode: "real"`、`postgres: 17.11`、`base_commit: 439970c2…`。

`different` 的几条典型（stub 期望 → real 实际）：`C1-30` `401 SESSION_REQUIRED → 503 PROVIDER_UNAVAILABLE`、
`C2-11/12/13` `404 NOT_FOUND → 503 PROVIDER_UNAVAILABLE`、`C2-18` `404 → 403 CONSENT_REQUIRED`、
`C3-15` `200 → 503`，以及反向的两条 `C3-19`/`C3-20` `503 PROVIDER_UNAVAILABLE → 200`（那两处在 real 下**已接线**、
不再 fail-closed）。`not-runnable` 44 条的成因集中在「夹具不可用」：社区投稿（审核管线未接线）10、作业过滤腿 9、
注销受理 5、OCR 5、识别 4 …。

⛔ 这 20 条差异**不是**要「修绿」的：本臂只负责把 stub 期望与真库实际并排记下来；哪条差异说明产品该改、哪条说明
用例期望该改，属后续批次，每条都要单独给依据。CI 判决刻意**不**断言 `different === 0`（见上节）。

### CI 首跑记录（2026-10-31，运行 `41135206295`）· 一次**真**失败，已修

首跑不是绿的，而且红得有价值 —— 它暴露了一个**只有 Debian 系才存在、Windows 本机永远复现不了**的缺陷：

```
[pg] bin=/usr/lib/postgresql/17/bin
[pg] dataDir=/home/runner/work/_temp/gy-i22-pg/gy-i22-failmatrix-realpg-4347-54067f2a port=36271
真 PG 臂 FAIL：Error: Command failed: /usr/lib/postgresql/17/bin/pg_ctl -D … -o -p 36271 -c listen_addresses=127.0.0.1 start
FATAL:  could not create lock file "/var/run/postgresql/.s.PGSQL.36271.lock": Permission denied
```

根因：PGDG 装出来的 `postgresql-17` 把编译默认 `unix_socket_directories` 钉成 `/var/run/postgresql`，而 runner 普通用户
写不了那个目录 ⇒ `pg_ctl start` 拿不到 socket lock。**同仓 `tests/integration/*` 十余个自起集群脚本早就用
`if (process.platform !== 'win32') options.push('-k ' + dataDir)` 避开了**（`user-chain-e2e.mjs:313-315`、
`media-row-purge-pg.mjs:105-110`），只有这条臂漏了 —— 因为它此前从没在 Linux 上跑过。

修法（`tests/failmatrix/run-real.mjs`）：`pg_ctl -o` 的选项改成数组拼装，非 win32 上追加 `-k <dataDir>`；
本臂只走 TCP，socket 目录只影响这个 lock 文件，不影响任何断言。首跑日志另外证明了两件事：**job 结构、装包、
主版本自证、env 传递都是对的**（`initdb (PostgreSQL) 17.11` 自证通过、`GY_PG_BIN`/`GY_I22_PG_ROOT` 都到了脚本里）。

### CI 第二轮（2026-10-31，运行 `41135701430`）· 又一次**真**失败：夹具的时间炸弹

socket 修掉之后集群起来了、全链迁移也跑过去了，step 6 改红在**播种第一个账号**：

```
ERROR:  new row for relation "sessions" violates check constraint "sessions_expires_after_creation"
DETAIL:  Failing row contains (d9151d10-…, fedfae4f-…, …, user, 1, 2026-10-27 04:00:00+00, null, 2026-10-30 22:05:54.519484+00).
    at async createAccount (…/tests/failmatrix/run-real.mjs:143:19)
    at async main (…/tests/failmatrix/run-real.mjs:415:15)
```

根因是**夹具把会话过期时间写成了冻结时钟**：`sessions` 表有 `CHECK (expires_at > created_at)`，而
`created_at` 走列默认 `DEFAULT now()`（真实墙钟）、生产 `createSession()` 也不写它；夹具却用
`START + 48h`（`world.mjs:32` 的 `START = 2026-10-25T04:00Z` ⇒ `2026-10-27T04:00Z`）当 `expires_at`。
墙钟一走过 `2026-10-27`，这条 INSERT 就必撞约束 —— 也就是说这条臂**自带保质期**，R29 当时本机时间还在
窗口内，所以「历史上绿过」；它从没在 CI 上跑过，也就没人被这个炸弹炸到。

修法（`tests/failmatrix/run-real.mjs`，不改生产代码、不动任何断言），三处同源：

1. **真 PG 臂改用真实时钟**：`clock.now` 从 `() => new Date(START)` 改成 `() => new Date()`。冻结时钟只属于
   stub 臂（那里没有库、也没有 CHECK）；real 臂必须和库同一口时钟。这一条是**根因级**的——不只 `sessions`，
   `admin_sessions` 与 `idempotency_keys` 也有同样的 `CHECK (expires_at > created_at)`，而生产代码用应用时钟算
   `expires_at = now + TTL`；时钟冻在过去，任何带 `Idempotency-Key` 的写请求（连 `logout` 都带）都会算到过去。
2. **播种时间基准取库内 `now()`**（`SELECT (extract(epoch from now())*1000)::bigint` → `world.dbNowMs`）：
   `createAccount` 缺省 `dbNowMs + 48h`、`createAdmin` 缺省 `dbNowMs + 1h`，与 `created_at` 的 `DEFAULT now()`
   同源，钳制关系不因容器时钟/时区漂移再翻。
3. **「已过期会话」改合规造法**：不再给 `expires_at` 一个过去时间（那必撞 CHECK），改为**先正常插入、再把
   `created_at` 与 `expires_at` 一起回拨**（`-10 days` / `-9 days`，`expires_at > created_at` 仍成立，对应用时钟
   确实已过期）。

启动行会多打一行 `[pg] db_now=… app_clock=real`，把时钟口径落在日志里。`START` 这个常量从此只服务 stub 臂。

这两轮红是**把臂接进 CI 这件事本身的收益**：两个缺陷（Debian socket 目录、夹具时间炸弹）在 Windows 本机
都复现不了，只有真跑一次 Linux + 真 PG 才会现形。

## 与 `#22` 的关系

`#22` 远未完成。本片交付的是**可重复运行的失败回归骨架 + 249 条真读数用例 + 27 条负控制**，
并把「在 main 上一跑就绿」与「哪些还没取得」分开记账。后续批次直接在 `cases.mjs` 追加族
`C8+`/`E3+`、在 `seams.mjs` 追加 `D5+`，并在 `mutations.mjs` 追加对应负控制；
`tests/unit/gy-i22-failmatrix.test.mjs` 的 `MIN_CASES` / `FAMILY_COUNTS` / `BATCH_COUNTS` 随之抬高——
**条数只准加、不准在没人注意时被删**，`tools/i22-failmatrix-evidence-table.mjs` 会拿文档声明的条数对账。

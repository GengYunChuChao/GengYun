# GY-I22（#22）失败回归矩阵 · 可执行骨架

一套**能重复跑**的权限/安全失败回归：表驱动、每条用例给真实读数、每条关键守卫配**负控制**
（故意放宽守卫 → 对应用例必须真红 → 原字节恢复 → sha256 前后一致 → 复跑转绿）。

**本片不宣称 #22 完成。** 这里交付骨架 + 230 条用例 + 26 条负控制，覆盖「身份与权限面
（游客/越权/后台/会话与注销）」「媒体归属与访问凭据」「重复请求」「无效输入」「审核回调与 AI 失败」
「下架缓存」「版本回写」「提示注入」。**真实 AI 外呼、真机、微信端到端、真实对象存储签名过期、
断网重试、账号停用、注销到期清理、在途取消 409** 仍**未取得**（见末尾「未取得」一节，逐条写明为什么）。

证据页：`docs/verification/gy-i22-failmatrix-20261022.md`（含「用例 id → #22 acceptance → 实际读数」三列表，
由 `tools/i22-failmatrix-evidence-table.mjs` 从机读结果生成）。

## 一条命令

```bash
node tests/failmatrix/run.mjs                  # 全跑（HTTP 210 + 受信 seam 20 = 230 条）
node tests/failmatrix/run.mjs --only=C2        # 只跑某族（前缀匹配，D/E 族同样适用）
node tests/failmatrix/run.mjs --only=D1-01,C6-10 --json=out.json
node tests/failmatrix/run.mjs --list           # 只列用例

node tools/i22-failmatrix-negative-control.mjs               # 26 条负控制
node tools/i22-failmatrix-negative-control.mjs --only=NC-09  # 只跑一条

# 真实 PostgreSQL 17 臂（把权限面 C1–C4/C10/C11 跑在一次性真 PG 集群上，逐条记录 stub vs 真 PG 差异）
$env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'        # 必填：含 initdb/pg_ctl 的目录（PG 17.x）
node tests/failmatrix/run-real.mjs                            # 缺 GY_PG_BIN ⇒ 退出 77（未取得，不是通过）
node tests/failmatrix/run-real.mjs --json=out.json            # 另存机读结果

# 证据页三列表（读上面两条命令的 --json，重跑即复核）
node tools/i22-failmatrix-evidence-table.mjs                       # 只打印不写盘（对账）；要写页必须 --write --page=<目标页>
```

进 CI/单测入口：`tests/unit/gy-i22-failmatrix.test.mjs`（stub 臂，`npm run test:unit` 会带上它）。
它真跑一遍全矩阵并断言 `FAIL 0` / 条数不少于 230，另加一条**静态同步检查**：负控制清单里
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

受信 seam（`seams.mjs`）：审核回调、AI 端口、下架缓存这三类失败**不经过 HTTP**，而是走
`tests/moderation/_http-fixtures.mjs` 里已被其它套件使用的受信夹具（`makeHarness` / `signedCallback` /
`makePort`），因此 D 族的读数来自**真实服务代码**，不是复刻一份同形实现。

## 文件

| 文件 | 作用 |
| --- | --- |
| `world.mjs` | 世界装配 + 身份播种（直插会话，零登录外呼）+ 请求助手 + 响应指纹 |
| `cases.mjs` | HTTP 用例表：`id` / `method` / `path` / `headers` / `body` / `expect{status,code,etag}` / `check` / `sameShapeAs` / `concurrent` |
| `seams.mjs` | 受信 seam 用例表：`invoke` + `expect{code}` + `check`（审核回调 / AI 失败 / 下架缓存 / 版本回写） |
| `run.mjs` | 表驱动 runner：判定 + 拒绝不变量 + 同形对照 + 按族/批次汇总 + `--json` 机读结果 |
| `run-real.mjs` | **真实 PostgreSQL 17 臂**：自己起一次性真 PG 集群（`GY_PG_BIN` 闸门 + `await import('pg')`），把权限面 C1–C4/C10/C11 的 world 换成真 PG store，逐条记录 stub 期望 vs 真 PG 实际；缺 `GY_PG_BIN` ⇒ 退出 77（未取得，不是通过） |
| `mutations.mjs` | 26 条负控制清单（`file` + 逐字 `find` + `replace` + `watch` 用例；`edits` 支持「同一条负控制改多处」） |
| `tools/i22-failmatrix-negative-control.mjs` | 负控制执行器：sha256 → 改 → 跑（必须全红）→ 原字节恢复 → sha256 复核 → 复跑（必须全绿） |
| `tools/i22-failmatrix-evidence-table.mjs` | 证据表生成器：读 `--json` 结果生成三列表，条数与文档声明不符即失败；归档页保护基于真实路径比较 + 文件身份（`dev` + `ino`，硬链接也拦得住）+ 仓库内包含性校验，`--write` 无隐式默认页（必须显式 `--page=`，且目标必须在仓库内；点名归档页要 `--i-know-this-rewrites-archive`，带旗标也仍受条数一致性约束——页内条数必须等于 `EXPECTED`，所以当前 168 / 23 的归档页必被拒），对账不通过一律不写盘 |

## 用例族与批次

| 族 | 条数 | 覆盖 |
| --- | --- | --- |
| C1 | 37 | 游客面：无凭据一律 `401 SESSION_REQUIRED`（不是 403/404/500），且带 `no-store` |
| C2 | 24 | 越权（IDOR）：A 读写 B 的私有行一律 `404`，与「不存在」同形；列表隔离；公开内容不得过度拦截 |
| C3 | 27 | 后台：用户会话 `403 SCOPE_DENIED`；缺 scope `403`；有 scope 2xx；未接线面 fail-closed `503` |
| C4 | 18 | 会话与注销：注销/过期/旧 epoch/坏凭据的拒绝码；注销回执 bearer 的绑定、换发与重放 |
| C5 | 10 | 媒体归属与媒体访问凭据：跨主体 `404`、缺/错 token、内容-媒体不匹配 |
| C6 | 10 | 重复请求：同键同体重放同一行、同键异体 `409`、缺键 `400`、并发只产生一行 |
| C7 | 16 | 无效输入：坏 uuid / 坏游标 / 越界分页 / 多余字段 → `400`（含 `INVALID_CURSOR`） |
| E1 | 3 | 提示注入：标题/评论里的指令只作数据；命中 `PROMPT_INJECTION` ⇒ `400`；干净文本 `201` |
| E2 | 3 | 媒体访问凭据：篡改/越权 token ⇒ `404`（与不存在同形，不泄露对象存在性） |
| D1 | 11 | 审核回调：重复/旧版本/旧租约/摘要不符/过期/坏签名/控制字段/撤权/下架 ⇒ 拒绝；回调绝不发布 |
| D2 | 4 | AI 失败：端口抛错 / 超时 / 结构未知 / 规则未过 ⇒ 任务 `quarantined`、`publishable:false` |
| D3 | 2 | 下架缓存：下架 ⇒ 读缓存键失效 + 可见性 `hidden`；二次下架幂等 |
| D4 | 3 | 版本回写：改版后未筛查 ⇒ `INPUT_UNCERTAIN`；已筛查 ⇒ 可发布；历史版本 ⇒ `REVISION_CONFLICT` |
| C10 | 23 | 异步 AI 域游客面（识别 / OCR / 转写 / 合成 / 作业 / 会话）：无凭据一律 `401 SESSION_REQUIRED`，且带 `no-store`（#449 引入） |
| C11 | 39 | 异步 AI 域归属面：他人资源一律 `404`（与「不存在」同形，不泄露存在性）、列表隔离（#449 引入） |

批次：**B1** = C1–C4，106 条（身份与权限面）· **B2** = C5–C7，36 条（媒体归属、重复请求与无效输入）·
**B3** = D1–D3，17 条（受信 seam：回调 / AI 失败 / 下架缓存）· **B4** = D4+E1+E2，9 条（版本回写 / 提示注入 / 媒体凭据）· **B5** = C10+C11，62 条（异步 AI 域的游客面与归属面）。

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

> **NC-22/23/24（R34 追加）的靶子不是矩阵用例，而是既有单元测试**：`me/exports`、`public/home`、
> 登记校验面这三个读面不进 HTTP 失败矩阵，守着它们的是 `tests/unit/*.test.mjs`。执行器为此支持
> `unitWatch: [{ file, pattern }]`，`pattern` 是测试名的**字面子串**：改一处后必须**恰好那一条**转红
> （`# fail ≥ 1` 且 `# pass = 0`），恢复原字节后必须**恰好一条**转绿（`# fail = 0` 且 `# pass = 1`）。
> 隐私说明（`GET /me/privacy-policy`）本轮判为**负控制不成立**：该域无路由、无守卫代码、无守护测试，
> 缺口性质是「缺实现 / 缺测试」——不为凑数新写弱测试去喂负控制，详见证据页 R34 小节。

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
- **消息与收藏的引用跳转**（内容下架后端上跳 `unavailable`）：只到接口层（下架后读帖 `404`、D3 缓存 `hidden`）。
- **外部删除状态**（第三侧删除后的同步）：仓内无该能力接线。
- **真实 PG 下的同一矩阵（R34 追加：已接真 PG 臂，差异见下节）**：`run-real.mjs` 已把权限面
  C1–C4/C10/C11 跑在一次性真 PG 17 集群上，逐条记录 stub vs 真 PG 差异。**未取得的部分**：media /
  社区投稿 / 异步 AI 作业（识别 / OCR / 转写 / 作业）在 real 模式下 fail-closed（对象存储、真实供应商、
  真实媒体未接线），无法播种属主行，对应用例如实标 `not-runnable`（占 168 条里的 35 条），⛔ 不拿
  「不存在」当「越权 404」的假同形。

## 真实 PG 臂（`run-real.mjs`）· stub vs 真 PG 差异结论

本臂把矩阵 world 的内存 store 换成真 PG store（`execution_mode=real` + 真 `pool`），在**一次性
PostgreSQL 17.11 集群**上实跑权限面 168 条（C1 37 + C2 24 + C3 27 + C4 18 + C10 23 + C11 39），
逐条比 `status`+`code`（stub 期望 vs 真 PG 实际）并校验 `meta.execution_mode === 'real'`。

实测读数（本机 PG 17.11，基线 `d4a47206`）：**168 条 = same 114 / different 19 / not-runnable 35**。
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
「权限面覆盖范围 = 168 条同源」两条契约。

## 与 `#22` 的关系

`#22` 远未完成。本片交付的是**可重复运行的失败回归骨架 + 230 条真读数用例 + 26 条负控制**，
并把「在 main 上一跑就绿」与「哪些还没取得」分开记账。后续批次直接在 `cases.mjs` 追加族
`C8+`/`E3+`、在 `seams.mjs` 追加 `D5+`，并在 `mutations.mjs` 追加对应负控制；
`tests/unit/gy-i22-failmatrix.test.mjs` 的 `MIN_CASES` / `FAMILY_COUNTS` / `BATCH_COUNTS` 随之抬高——
**条数只准加、不准在没人注意时被删**，`tools/i22-failmatrix-evidence-table.mjs` 会拿文档声明的条数对账。

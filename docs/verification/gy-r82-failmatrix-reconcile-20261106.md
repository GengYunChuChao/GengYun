# R82 failmatrix 真库臂：C4-15 与 C4-18 逐条裁定（2026-11-06）

- 工作树 `E:\GengYunCommander\.pg17\wt-r82-reconcile`，分支 `docs/gy-r82-failmatrix-reconcile`，基线 `7155b9e7`（= `origin/main`，也是 `git merge-base origin/main <branch>` 的结果；本页描述的是「基线 = `7155b9e7`、本页提交 = 其直接子提交」这一对读数，不是「工作树 HEAD 永远是 7155b9e7」）。
- 本页只做两件事：把 failmatrix 真库臂里**尚未裁定的两条分歧**（C4-15、C4-18）逐条读到位，并给出裁定。
- 只读 + 写文档：没有 commit、没有 push、没有改任何代码或测试。跑出来的原始日志在 `.pg17\tmp\r82-real-arm.log`（真库臂）、`.pg17\tmp\r82-stub-arm.log`（stub 臂）、`.pg17\tmp\r82-probe.log`、`.pg17\tmp\r82-probe2.log`（两条探针）。
- 引 `docs/verification/gy-r75-failmatrix-reconcile-20261103.md` 时一律**标注它是旧读数**并给行号，不与本页读数混算。

## §1 本轮两条臂的读数（同一天、同一棵树）

真库臂六键（`.pg17\tmp\r82-real-arm.log` 合计行）：

| 条数 | same | sameWithCheck | sameWithShape | different | not runnable |
| --- | --- | --- | --- | --- | --- |
| 180 | 162 | 19 | 27 | 5 | 13（fixture 8 / domain-unavailable 5） |

stub 臂（`tests/failmatrix/run.mjs`）本轮 249 条全 PASS、0 FAIL，其中 C4-15 读数为 `202 -`、C4-18 为 `200 -`（`.pg17\tmp\r82-stub-arm.log`）。两臂的条数不同不是口径冲突：stub 臂跑的是整个矩阵 249 条，真库臂只跑权限面 180 条。

真库臂族分布（同一次 run 的合计行）：C1 37（37/0/0）、C2 24（18/0/6）、C3 36（31/3/2）、C4 21（14/2/5）、C10 23（23/0/0）、C11 39（39/0/0），耗时 24936 ms。

真库臂 5 条 `different`：C3-19、C3-20、C3-21（stub 期望 503 `PROVIDER_UNAVAILABLE`、真库 200，属旧页已裁过的「按模式的合法分歧」），加上本页要裁的 **C4-15** 与 **C4-18**。

真库臂 13 条 `not runnable`：C2-01/02/03（媒体夹具未播种）、C2-11/12/13（媒体域 503）、C3-15/C3-26（后台审计域 503）、C4-12/13/14/16/17（注销夹具哨兵）。

合计行原文（`.pg17\tmp\r82-real-arm.log` 尾行，逐字）：

```
total=180 same=162 sameWithCheck=19 sameWithShape=27 different=5 notRunnable=13 elapsedMs=24936
```

族级分布（同文件，逐字）：

```
C1=37(37/0/0) C2=24(18/0/6) C3=36(31/3/2) C4=21(14/2/5) C10=23(23/0/0) C11=39(39/0/0)
```

## §2 两条分歧的四列读数

| 用例 | stub 期望 | 真库实际 | 分类 | 裁定 |
| --- | --- | --- | --- | --- |
| C4-15 `注销申请重放：同一单 + 换发回执` | 202（`tests/failmatrix/cases.mjs:407`） | **202**，但 `[check]` 判红 | `different`（check 判红） | 夹具口径，不是产品缺陷 |
| C4-18 `冷静期内原会话仍可用（注销在线 7 日到期前）` | 200（`tests/failmatrix/cases.mjs:438`） | **401 `SESSION_EXPIRED`** | `different`（status 判红） | 期望与冻结契约冲突，真库行为正确 |

真库臂原样两行（`.pg17\tmp\r82-real-arm.log`）：

```
DIFF C4-15  POST   /api/v1/me/account/deletion → 真PG 202 - · stub期望 202 - · 注销申请重放：同一单 + 换发回执
  ✗ [check] 重放产生了新的注销单 id（幂等失效）：f9b4271e-1a04-4767-8838-ac92fdfb10fb
DIFF C4-18  GET    /api/v1/favorites → 真PG 401 SESSION_EXPIRED · stub期望 200 - · 冷静期内原会话仍可用（注销在线 7 日到期前）
  ✗ status stub期望 200 实际 401
```

stub 臂对应两行（`.pg17\tmp\r82-stub-arm.log`）：C4-15 `PASS … 202 - · etag="2"`、C4-18 `PASS … 200 -`。

**注意 C4-15 的自相矛盾之处**：status 与 code 都对上了 202，唯一红的是 `check`。也就是说「重放」这件事根本没有被真正验证——只验证了某个 id 与另一个东西不相等。

## §3 手法（这两条读数是怎么来的）

1. 用 `E:\GengYunCommander\.pg17\pgsql\bin` 起一次性 PG 17.11 簇，端口 55410（55433、55439 被既有簇占用），`initdb -U postgres -A trust -E UTF8 --locale=C`，建全新库 `gengyun_r82_reconcile`。
2. 真库臂自建临时簇、自跑迁移（日志首行 `[pg] server_version=17.11`、`[pg] migrations=53（一次性空库，全部落地）`）；端口不可由外部指定，`tests/failmatrix/run-real.mjs:93-102` 的 `freePort()` 走 `listen(0)` 取 OS 临时端口。
3. 命令：`$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'; $env:GY_I22_PG_ROOT='E:\GengYunCommander\.pg17\tmp\realpg-r82'; node tests/failmatrix/run-real.mjs --json=E:\GengYunCommander\.pg17\tmp\r82-real-arm.json`，退出码 0。
4. 两条探针（不入库，落在 `.pg17\tmp\`）把「会话在受理后到底还能不能用」直接测出来：探针 1 用受理前那张会话，探针 2 另铸一张 `auth_epoch` 已递增后的新会话。
5. 判定器口径：`tests/failmatrix/run-real.mjs:710-741` 比 status/code 并要求 `meta.execution_mode === 'real'`，`c.check` 抛错进 `checkProblems`；`:758-772` 的 `domainUnavailable` **只认** 503 `PROVIDER_UNAVAILABLE` 或 409 `OBJECT_UNAVAILABLE` + `feature_flag`，401 不在其中——这决定了本页两条都只能落 `different`，不会被顺手改判成 `not runnable`。

## §4 裁定 C4-15

**能由仓内补齐**：是，且只涉及夹具与断言两侧。

- 真库臂根本没有播种过「一张已经受理过的注销单」：`tests/failmatrix/run-real.mjs:994-996` 把 `deleter.deletionId`、`.receipt`、`.staleReceipt` 三个字段都设成 `unavailableSeed(...)` 哨兵；对照 stub 臂 `tests/failmatrix/run.mjs:285-298`，那里是**真发一次 202** 再把读数写回夹具。
- 哨兵是个 `Proxy`，`tests/failmatrix/run-real.mjs:217-226` 的 `get` 陷阱在取值时才抛。而 `tests/failmatrix/cases.mjs:355-359` 的 `check` 里，判等那一行是 `tests/failmatrix/cases.mjs:357`：`result.body?.data?.deletion?.id !== prior.deletionId`——右侧只是一个普通属性取值，返回代理本身不抛；`'f9b4271e-…' !== proxy` 恒为真。所以那句话的正确读法是「这一次 202 的 id 与一个哨兵不相等」，不是「重放换单了」。
- 真库臂这一次 202 是**首次受理**：探针 1 首次 POST 就返回 202 并给出新 id，与真库臂红出来的 `f9b4271e-…` 是同一种读数。至于「重放」分支 `services/api/src/routes/account-deletion.ts:281-311`，在**串行**场景（首条受理事务已提交之后）对任何用户会话都不可达——理由是三段串联的：`:255` 的 `preHandler` 先做鉴权（鉴权先于幂等台账）；受理事务按契约撤掉该账号全部会话，`services/api/db/migrations/0016_account_deletion_persistence.sql:130-135`；账号转 `deletion_pending` 后一律拒绝，`services/api/src/auth/middleware.ts:88`。
- 探针实测坐实这条不可达：受理后用**同一张**会话重放同键 → 401 `SESSION_EXPIRED`（探针 1）；改用 `auth_epoch` 递增后**新铸**的会话 → 403 `ACCOUNT_INACTIVE`（探针 2）。两条路径都拿不到第二个 202，自然也谈不上「同一单 + 换发回执」。
  - 边界：这里说的是**串行**情形。`services/api/src/routes/account-deletion.ts:281-311` 的 replay 分支本身不校验账号状态，判定入口只是「同 subject 同幂等键已存在台账」；理论上存在一个并发窗口（第二条请求在首条受理事务提交**前**过了 `:255` 的鉴权、提交**后**才进 `:261` 的 handler）。本页没有复现这个窗口，也不据此下「对任何会话都不可达」的绝对结论；裁定本身不受影响（同账号同单换发回执，既不越权也不放行）。
- 因此：**不是产品缺陷，不是 503 域门**（真库臂实测 202，受理面是开着的），是「真库臂没播种 + 断言拿哨兵当基准」的夹具口径。不计入 A1「未解决严重安全/权限缺陷」的缺陷计数：这里没有越权、没有跨账号读、失效方向是拒绝而不是放行。
- 要让读数对齐 stub，改这两处：`tests/failmatrix/cases.mjs` 里 C4-15 那条用例补 real 侧期望（受理后重放只可能 401），并把 `tests/failmatrix/run-real.mjs` 判定器里的 `const exp = c.expect ?? {}` 换成先读 real 侧期望、缺省回落到 `c.expect`（这一行现在是 `realExpect ?? expect`，行号见 §9）；同时把同一文件里给 `deleter.deletionId` / `.receipt` / `.staleReceipt` 播种 `unavailableSeed(...)` 的那三行（见本节上一条与 §7 第 1 行）换成真播一次 202 的读数（照 `tests/failmatrix/run.mjs:285-298`）。只改前者也能让读数不再红，但那是把「不可达」写成「期望 401」，语义上要把用例改名（「受理后重放不得再签发回执」）。

## §5 裁定 C4-18

**不能由仓内补齐到与 stub 一致**：真库 401 是冻结契约要求的正确行为；要对齐只能让 stub 世界也撤会话（或把期望改成 401）。

- 真库 401 的成因不是「会话没播好」：`tests/failmatrix/run-real.mjs:165-178` 的 `createAccount` 铸的会话是受理**之前**签发的，受理事务按契约把它撤销（`0016…sql:130-135`，探针 1 读到 `sessions=1 / revoked=1`）。撤销的直接后果是 `services/api/src/auth/middleware.ts:78-80` 的 401 `SESSION_EXPIRED`。
- 也不是「冷静期内会话被错误作废」：即使用 `auth_epoch` 递增后新铸的会话来问，读数也只是从 401 变成 403 `ACCOUNT_INACTIVE`（`middleware.ts:88`），拿不到 200。所以 200 在真库里根本不可达，换哪张会话都一样。
- 契约侧逐字：`docs/architecture/state-contract.md:105`「注销请求202的返回在**同一事务**将账号改deletion_pending、撤所有用户会话/角色、auth_epoch递增……受理成功后旧会话不再可调用 API」。`:109` 的 7×24 小时是**在线数据**的保留期限，不是会话可用期限——用例标题里的「冷静期内原会话仍可用」把这两件事混成了一件。`:107` 说明回执用专用 `deletionReceipt` bearer、不允许用户 session 代替，也就是说冷静期内留给用户的通道是**回执**，不是旧会话。
- stub 臂为什么是 200：stub 世界的注销受理没有做同事务撤销，会话还活着（stub 臂实测 C4-18 `PASS 200`）。这是 stub 世界的实现缺口，不是真库的缺陷。
- 因此：**不是产品缺陷**，不计入 A1；同时**不能把真库改成 200**——那要动 `state-contract.md:105` 这条冻结口径。要消掉这条分歧，改 `tests/failmatrix/cases.mjs` 里 C4-18 那条用例的期望（200 → 401 `SESSION_EXPIRED`）并同步让 stub 世界的受理撤会话；后者属产品内存实现的改动，本片不做，也不能在本片做。

## §6 与旧页的关系（旧读数，不得回填）

- 旧页 `docs/verification/gy-r75-failmatrix-reconcile-20261103.md:35` 把 C4-15 归为 `domain-unavailable`「注销域整域失闭（受理面本身 503，202 无从产生）」。**本轮推翻**：真库臂 C4-15 实测 202，探针也 202，装配层 `services/api/src/app.ts:2339` 的 `available` 在 real + 真库下为真。
- 旧页 `docs/verification/gy-r75-failmatrix-reconcile-20261103.md:36` 说 C4-12 的夹具字段「唯一生产者是 C4-15 的 202」。方向对，但前提已不成立：C4-15 现在能产出 202，缺的是**播种回写**（`tests/failmatrix/run-real.mjs:994-996`），所以 C4-12/13/14/16/17 仍落 `not runnable`。
- 旧页 `docs/verification/gy-r75-failmatrix-reconcile-20261103.md:8` 与同页 `:17-18` 记的是 180 = same 161 / different 3 / not runnable 16（旧读数）。本页是 180 = same 162 / different 5 / not runnable 13；差值来自注销域这组用例的状态迁移：旧页 `docs/verification/gy-r75-failmatrix-reconcile-20261103.md:33` 的 C1-30、`:34` 的 C4-11 本轮已不在 `not runnable` 名单里，而 C4-15、C4-18 从「不可跑」变成「跑起来了但不一致」。三组数字不可互相换算。
- 旧页 `docs/verification/gy-r75-failmatrix-reconcile-20261103.md:71` 与同页 `:78` 对 C3-19/20/21 的「不改期望、不记缺陷、按模式的合法分歧」结论本轮继续成立（本轮它们仍是 503/200 的差异）。

## §7 可执行项

| # | 改哪里 | 改什么 | 谁来做 |
| --- | --- | --- | --- |
| 1 | `tests/failmatrix/run-real.mjs:994-996` | 哨兵换成真播一次 202 的读数（照 `tests/failmatrix/run.mjs:285-298`） | 夹具片 |
| 2 | C4-15 那条用例（`tests/failmatrix/cases.mjs`）＋ 判定器（`tests/failmatrix/run-real.mjs`） | 加 real 侧期望（受理后重放 401），判定器先读 real 侧 | 夹具片 |
| 3 | `tests/failmatrix/cases.mjs:438` | 期望 200 → 401，标题去掉「原会话仍可用」 | 夹具片 + 契约确认 |
| 4 | stub 世界的注销受理 | 补同事务撤销，让两臂同码 | 单开产品问题（改内存实现） |
| 5 | `DELETE /api/v1/me/account/deletion` | 受理后取消入口不可达（见下） | 单开产品问题 |

第 5 条的证据：取消路由 `services/api/src/routes/account-deletion.ts:362` 挂的是 `guards.requireUser`（要用户会话），而受理后该账号所有会话已撤销、且 `services/api/src/auth/middleware.ts:88` 一律 403 ⇒ real 模式下「受理后撤销注销」这条路走不通；能读的只有回执 bearer（`services/api/src/routes/account-deletion.ts:318-356`，只读）。本页只实测到 401/403，没有验证前端是否另有撤回入口，也不把它算进 A1——但它是一条真实的可用性缺口，建议单独开，不阻塞 #22。

## §8 本页不能证明什么

- 没有跑真实 AI 外呼、没有跑真机、没有覆盖 C4 之外的其余 `not runnable` 用例（本轮 13 条里另 11 条只读到分类，未逐条读代码）。
- 没有证明 C4-15 的 `check` 在**播种之后**会绿：真重放在真库结构性不可达，播种后这条只会从「哨兵比较失败」变成「期望 401 的差异」，本页没实跑过那个改动后的读数。
- 没有证明 stub 世界补上同事务撤销后 stub 臂仍全绿（249 条里有多少条依赖「注销后会话还活着」未盘）。
- 没有验证 `deletion_pending` 账号是否存在别的自助入口（例如前端撤回页面、客服工单），只验证了 API 层的 401/403。
- 没有验证第三方删除、备份清除、7 日／30 日到期这些外部世界事实；本页所有读数都停在本机 PG 17.11 + 进程内 app 的边界内。
- 没有做任何 commit / push / gh；工作树除新增本页外无改动。

## §9 行号现状（2026-11-07 追加，不改写本页既有读数）
## §9 行号现状（2026-11-07 追加，不改写本页既有读数）

本页 §1–§8 的读数与行号都是**基线 `7155b9e7`** 上的事实，按 §11 的证据纪律不回填。此后 `#1028` 合入（`main = 1dec1bbb`）把 `tests/failmatrix` 四个文件从 460 行推到 567 行（合计 +215/−20，其中 `run-real.mjs` 单文件 +151/−11），本页引用的 `run-real.mjs` 位置**全部**平移。

| 本页引用 | 基线 `7155b9e7` | `main = 1dec1bbb` |
| --- | --- | --- |
| `freePort()`（真库臂取空闲端口） | `tests/failmatrix/run-real.mjs:93-102` | `tests/failmatrix/run-real.mjs:141-150` |
| `createAccount()`（铸账号与会话） | `tests/failmatrix/run-real.mjs:165-178` | `tests/failmatrix/run-real.mjs:213-226` |
| `unavailableSeed()`（哨兵工厂） | `tests/failmatrix/run-real.mjs:217-226` | `tests/failmatrix/run-real.mjs:265-274` |
| 注销夹具哨兵（`deleter.deletionId` / `.receipt` / `.staleReceipt`） | `tests/failmatrix/run-real.mjs:994-996` | `tests/failmatrix/run-real.mjs:1103-1105` |
| 真库臂判定器 `verdictFor()` 全体 | `tests/failmatrix/run-real.mjs:710-741` | `tests/failmatrix/run-real.mjs:783-814` |
| 判定器取期望那一行（`const exp = c.expect ?? {};`） | `tests/failmatrix/run-real.mjs:711` | `tests/failmatrix/run-real.mjs:784` |
| `domainUnavailable()`（整域失闭判据） | `tests/failmatrix/run-real.mjs:758-772` | `tests/failmatrix/run-real.mjs:835-849` |

上表七行逐条按**内容比对**核过（同一函数/语句的首末行在两侧逐字相同），不是按差值推算；哨兵那行在 `main` 上从第 1096 行起是 7 行注释、赋值语句落在第 1103–1105 行，故区间取赋值行本身。

本轮只重锚本页对 `cases.mjs` 的两条陈旧指针（见页首 §2 与 §7 第 3 行，登记在 `tests/unit/doc-anchor-relocations.json`）；`run-real.mjs` 的七处留给 docs-only 小 PR 一并重锚，本页先给出映射，避免把这次改动的验证面从「夹具两文件」扩到整页。

同一次合入还把真库臂的 `notRunnable` 从 13 条清到 0（`same 162 → 175`、`sameWithCheck 19 → 20`、`sameWithShape 27 → 30`、`different` 仍 5），所以本页 §1 那张「13 条 not runnable」的表**只代表基线**，不再代表 `main`。两条 `different`（C4-15、C4-18）的裁定结论不变，仍是本页 §2 的裁定。

承接提交（本 PR，分支 `test/gy-r83-real-expect`）已把本页 §2 的两行与 §7 第 3 行的 `tests/failmatrix/cases.mjs` 定位改为用例新位置（C4-15 在**第 407 行**、C4-18 在**第 438 行**），三条映射登记在 `tests/unit/doc-anchor-relocations.json`（`kind: "correction"`，`symbol` 分别为 C4-15、C4-18、C4-18）。上表里 `run-real.mjs` 的七组引用仍按上表处理，不属本 PR 的重锚范围。

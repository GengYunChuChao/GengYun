# R87 failmatrix 真库臂复跑：180 条权限面在真 PG 17.11 上的读数（2026-11-07）

- 基线 `origin/main = 3561b1fc31558409242829b4610213c00f95f7fb`（`git fetch origin --prune` 后实测，2026-11-07 21:34 HKT）；本页跑的树就是它：工作树 `E:\GengYunCommander\.pg17\wt-r87-realarm`、分支 `docs/gy-r87-i22-real-arm-reading`、`git rev-parse HEAD` = `3561b1fc`、`status --porcelain` 空。
- 本页补的是 `#22` 一直欠着的**新读数**：`#1033`（`0ecae98c test(failmatrix): 按执行模式分叉真库期望`）把 5 条 `different` 改成 real 侧期望，但那次**没有重跑真库臂**，所以「改完到底读数是什么」此前没有本机实测。
- 本页读数**全部来自本机实跑**：`run-real.mjs` 的 stdout 与它写出的 `--json` 产物。⛔ 没有抄 CI artifact 的任何数字——那个 artifact 的实名是 `failmatrix-real-<sha>`（`.github/workflows/real-pg-integration.yml:1410`；`failmatrix-real-17.11` 是同文件 `.github/workflows/real-pg-integration.yml:1332` 的 **job/check 名**，不是 artifact 名）——也没抄任何旧页的读数来充本轮。
- 只读 + 写文档：没有改 `cases.mjs` / `run-real.mjs` / 任何业务代码，没有 push，没有合并，没有碰 `#1037` 占用的文件。

## §1 基线与环境

| 项 | 读数（原文） |
| --- | --- |
| `origin/main` | `3561b1fc31558409242829b4610213c00f95f7fb` |
| 工作树 HEAD | `3561b1fc31558409242829b4610213c00f95f7fb`（= 基线；`status --porcelain` 空后才开跑） |
| 时间（HKT） | 2026-11-07 21:36:11（json `generated_at = 2026-11-07T13:36:11.473Z`），整臂耗时 12586 ms |
| PG 版本（`initdb --version` 原文） | `initdb (PostgreSQL) 17.11` |
| PG 版本（脚本自报，`SHOW server_version`） | `[pg] server_version=17.11` |
| PG 二进制 | `E:\GengYunCommander\.pg17\pgsql\bin`（`initdb.exe` / `pg_ctl.exe` / `postgres.exe` / `psql.exe` / `createdb.exe` 逐个 `Test-Path` 为 True） |
| 端口 / 库名 | 端口 **58055**（脚本自取，见 §2 说明）；库名 **`postgres`**（`tests/failmatrix/run-real.mjs:1082` 的连接串固定 `/postgres`，本臂不另建库、不跑 `createdb`） |
| 迁移 | `[pg] migrations=54（一次性空库，全部落地）` |
| Node | `v24.16.0`（json `node` 字段） |
| transport | `app.inject (real PG stores)`（json `transport` 字段原文：用例经 `app.inject` 直接打到真实 PG 支撑的存储层，不起 HTTP 监听） |

**哪些读数来自日志、哪些来自 json**：端口 `58055`、耗时 `12586 ms`、`migrations=54` 三项**只来自日志**（`.pg17\tmp\r87-real-arm.log`）。json 的元数据只有 `generated_at` / `node` / `base_commit` / `postgres` / `execution_mode` / `transport` 六项，其余是 `totals` / `shapePass` / `families` / `rows` 四块数据；端口、耗时、迁移数都不在机读产物里，无法从 json 复算。

**端口为什么不是指挥派单里写的 554xx**：本臂的簇由脚本自己 `initdb` + `pg_ctl start`、并在 `finally` 里 stop + 删目录，端口在 `tests/failmatrix/run-real.mjs:143` 的 `freePort()` 里用 `listen(0, '127.0.0.1')` 向 OS 取临时端口，外部无法指定。能钉住的只有**监听地址**——`tests/failmatrix/run-real.mjs:1105` 把 `-c listen_addresses=127.0.0.1` 写进 `pg_ctl -o`，即只听回环。本轮实测取到 58055；开跑前本机 55400–55500 段只有 55433 在听（既有 `data-r74` 簇），与本轮无关。

## §2 命令（逐字）

```powershell
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_I22_PG_ROOT='E:\GengYunCommander\.pg17\tmp\r87-pgroot'
node tests/failmatrix/run-real.mjs --require-no-not-runnable --json=E:\GengYunCommander\.pg17\tmp\r87-real.json
```

- 工作目录 `E:\GengYunCommander\.pg17\wt-r87-realarm`；退出码 **0**。
- 环境变量名逐字：`GY_PG_BIN`（必填，缺则整臂退出 77 未取得）、`GY_I22_PG_ROOT`（可选，簇目录落点）。`GY_I22_PG_KEEP` **未设** ⇒ 走清理分支。
- `--require-no-not-runnable` 在 `tests/failmatrix/run-real.mjs:1047` 解析；打开后 `not_runnable > 0` 会在 `tests/failmatrix/run-real.mjs:1622` 生效、由 `tests/failmatrix/run-real.mjs:1624` 往 stderr 打 `FAIL：--require-no-not-runnable 下有 N 条 not_runnable` 并 `return 1`。退出码 0 的含义因此是「**且** not_runnable = 0」，不只是「脚本没崩」。
- 依赖安装：本 worktree 内独立 `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts`（`added 103 packages`），跑完 `git status --porcelain` 仍空、`package-lock.json` 未变。⛔ 没有做任何跨 worktree 的 `node_modules` junction/symlink（§3 红线），因此本片也没有需要摘除的重解析点。

## §3 读数表（本轮 vs 旧基线）

| 项 | 本轮（R87，基线 `3561b1fc`） | 旧基线（`docs/verification/gy-r82-failmatrix-reconcile-20261106.md:27`，基线 `7155b9e7`） | 差 |
| --- | --- | --- | --- |
| `total` | **180** | 180 | 0 |
| `same` | **180** | 162 | +18 |
| `sameWithCheck` | **24** | 19 | +5 |
| `sameWithShape` | **30** | 27 | +3 |
| 二者皆无（`sameWithNeither`） | **126** | 116（派生值 162−19−27，旧页未直接给这一列） | +10 |
| `different` | **0** | 5 | −5 |
| `not_runnable` | **0** | 13 | −13 |

两臂条数口径不同不是冲突：真库臂只跑权限面六族（`tests/failmatrix/run-real.mjs:1072` 的 `PERMISSION_FAMILIES` 筛出 180 条，`tests/failmatrix/run-real.mjs:1073` 落筛选），stub 臂跑整个矩阵 249 条。（R111 起该集合扩到八族 —— 追加 `E3`／`F1`，臂面 203 条；本页 180 是 R87 时点读数，不改写。）

json `totals` 逐字段（`E:\GengYunCommander\.pg17\tmp\r87-real.json` 原样）：

```
total = 180
same = 180
sameWithCheck = 24
sameWithShape = 30
sameWithEither = 54
sameWithNeither = 126
sameWithShapeUnchecked = 0
different = 0
differentFromCheck = 0
differentFromShape = 0
not_runnable = 0
notRunnableByKind = {}
reclassifiedToNotRunnable = 0
```

同形比对（json `shapePass` 字段，逐字段读数）：真比过 30 条、不一致 0 条、对照组缺读数 0 条。

## §4 stdout 合计行原文（逐字，`.pg17\tmp\r87-real-arm.log`）

```
———————————————— 汇总 ————————————————
C1 游客面：没有凭据时一律 401 SESSION_RE… 37 条：same 37 / different 0 / not-runnable 0
C2 越权（IDOR）：A 不得读写 B 的私有行；「不是… 24 条：same 24 / different 0 / not-runnable 0
C3 后台：用户会话 → 403 SCOPE_DENIED… 36 条：same 36 / different 0 / not-runnable 0
C4 会话与注销：注销/过期/旧 epoch/坏凭据的拒绝… 21 条：same 21 / different 0 / not-runnable 0
C10 异步 AI 域游客面：识别 / OCR / 转写 /… 23 条：same 23 / different 0 / not-runnable 0
C11 异步 AI 域归属面：A 碰 B 的作业 / 识别 … 39 条：same 39 / different 0 / not-runnable 0
权限面合计 180 条：same 180 / sameWithCheck 24 / sameWithShape 30 / different 0 / not_runnable 0
  判据强度：same 里真跑过断言 54 条（check 24 + 同形 30），只比 status/code 126 条
  差异归因：different 0 条（status/code/check 判红 0 · 同形比对判红 0）
  not-runnable 0 条：（无）；其中由 different 改判 0 条
  同形比对：真比过 30 条（不一致 0）· 对照组缺读数 0 条
———— stub vs 真 PG 差异结论 ————
（无：权限面在 stub 与真 PG 下逐条一致）
真 PG 臂完成：180 条权限面用例在 PostgreSQL 17.11 上取得逐条读数，耗时 12586 ms（same=180 sameWithCheck=24 sameWithShape=30 different=0 not-runnable=0）。
```

上面那句「权限面合计 …」由 `tests/failmatrix/run-real.mjs:1556` 打印，末句由 `tests/failmatrix/run-real.mjs:1611` 打印。另有整臂零外呼自证：`[pg] media_external_requests=0 fetch_calls=0（整臂零外呼）`。

**关于「（无：权限面在 stub 与真 PG 下逐条一致）」这行**：这是 `run-real.mjs` 在 `different=0` 时打印的**固定文案**，不是逐条比对 stub 期望与 real 期望后的结论。本轮 5 条（C3-19/20/21、C4-15、C4-18）按 `realExpect` / `realCheck` 分叉口径比对：stub 侧对 C3-19/20/21 仍是 503 `PROVIDER_UNAVAILABLE`、对 C4-18 仍是 200，real 侧实测分别是 200 与 401 `SESSION_EXPIRED`（逐条见 §6）。因此这行的「逐条一致」只能读作「在**当次判定口径**（real 期望优先）下没有判红的那一条」，**不能**读作「stub 与真 PG 的原始期望值相同」——后者与 §6 的五条分叉自相矛盾，故在此显式澄清。

## §5 族分布（本轮，含判据强度分列）

| 族 | total | same | sameWithCheck | sameWithShape | 二者皆无 | different | not_runnable | 旧基线（`docs/verification/gy-r82-failmatrix-reconcile-20261106.md:18`：total/same/diff/nr） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | 37 | 37 | 0 | 0 | 37 | 0 | 0 | 37（37/0/0） |
| C2 | 24 | 24 | 3 | 10 | 11 | 0 | 0 | 24（18/0/6） |
| C3 | 36 | 36 | 14 | 0 | 22 | 0 | 0 | 36（31/3/2） |
| C4 | 21 | 21 | 2 | 3 | 16 | 0 | 0 | 21（14/2/5） |
| C10 | 23 | 23 | 0 | 0 | 23 | 0 | 0 | 23（23/0/0） |
| C11 | 39 | 39 | 5 | 17 | 17 | 0 | 0 | 39（39/0/0） |
| **合计** | **180** | **180** | **24** | **30** | **126** | **0** | **0** | 180（162/5/13） |

表里 `sameWithCheck` / `sameWithShape` / 「二者皆无」三列**是由 json 的 `rows`（180 条逐条行）复算的**，不是 json 自带字段：json 的 `families` 每族只存 `total` / `same` / `different` / `notRunnable` 四个数。复算口径与脚本一致——`assertions.check === "ran"` 计 check、`assertions.shape === "compared"` 计同形；同一行两者互斥（同时成立的 0 条），故 24 + 30 = 54（= `sameWithEither`），180 − 54 = 126（= `sameWithNeither`）。复算的六族逐格与上表一致，合计与 §3 的 `totals` 逐字段相等。

六族逐条 `same`，`different` 与 `not_runnable` 全 0——包括 r82 页记为 13 条 `not runnable` 的那批（C2-01/02/03、C2-11/12/13、C3-15/C3-26、C4-12/13/14/16/17）：本轮它们全部取得了真实读数且与 stub 期望一致。

## §6 `#1033` 的五条分叉：本轮真库读数下是否成立

判定器口径：期望取 `realExpect ?? expect`（`tests/failmatrix/run-real.mjs:869`），断言取 `realCheck ?? check`（`tests/failmatrix/run-real.mjs:884`）。

| 用例 | stub 期望 | `#1033` 加的 real 侧期望 | 本轮真库实测 | 断言 | 结论 |
| --- | --- | --- | --- | --- | --- |
| C3-19 后台读账号列表 | 503 `PROVIDER_UNAVAILABLE` | 200（`tests/failmatrix/cases.mjs:203`） | **200 -** | `realCheck` 跑过、0 problems（`data.items` 是数组、含 B、state 全在闭集内） | **成立** |
| C3-20 后台读作业面 | 503 `PROVIDER_UNAVAILABLE` | 200（`tests/failmatrix/cases.mjs:215`） | **200 -** | `realCheck` 跑过、0 problems（每行 id 是 uuid 形状） | **成立** |
| C3-21 后台停用账号 | 503 `PROVIDER_UNAVAILABLE` | 200（`tests/failmatrix/cases.mjs:225`） | **200 -** | `realCheck` 跑过、0 problems（`data.state === suspended` + 响应头 ETag 为字符串） | **成立** |
| C4-15 注销申请 | 202 | 202（`tests/failmatrix/cases.mjs:407`），另有 real 侧断言（`tests/failmatrix/cases.mjs:413`） | **202 -** | `realCheck` 跑过、0 problems（注销单 id 是 uuid、不等于夹具哨兵、`receipt_token` 非空、`receipt_expires_at` 在未来） | **成立**（real 侧口径是「首次受理」，不是 stub 的「同单重放」） |
| C4-18 受理后原会话读收藏 | 200 | 401 `SESSION_EXPIRED`（`tests/failmatrix/cases.mjs:438`） | **401 SESSION_EXPIRED** | 无 `check`（只比 status/code + `meta.execution_mode`） | **成立** |

真库臂原样五行（`.pg17\tmp\r87-real-arm.log` 逐字）：

```
  SAME C3-19  GET    /api/v1/admin/accounts → 真PG 200 - · stub期望 503 PROVIDER_UNAVAILABLE · real期望 200 - · 后台读账号列表（stub：账号读权威未接线 / real：真库读面）
  SAME C3-20  GET    /api/v1/admin/jobs → 真PG 200 - · stub期望 503 PROVIDER_UNAVAILABLE · real期望 200 - · 后台读作业面（stub：未接线 / real：真库作业读面）
  SAME C3-21  POST   /api/v1/admin/accounts/1c119af7-3ac8-4956-84f8-d6d658a6df86/suspend → 真PG 200 - · stub期望 503 PROVIDER_UNAVAILABLE · real期望 200 - · 后台停用账号（stub：未接线 / real：真停用专用目标）
  SAME C4-15  POST   /api/v1/me/account/deletion → 真PG 202 - · stub期望 202 - · real期望 202 - · 注销申请：stub 同键重放 / real 首次受理
  SAME C4-18  GET    /api/v1/favorites → 真PG 401 SESSION_EXPIRED · stub期望 200 - · real期望 401 SESSION_EXPIRED · 注销受理后原会话立即失效（冷静期只保在线数据，凭证是回执 bearer）
```

结论：**五条全部成立**，`different` 由 5 归 0；行级断言（C3-19/20/21、C4-15）也真跑过且全过，不是「把期望改成实际值」凑绿——`realCheck` 里断言的是**内容**（items 数组、uuid 形状、`state=suspended`、回执到期时刻在未来），不是状态码的同义反复。

## §7 与「`#1028` 合入后」那条中间读数的对齐（引用，不是本轮实测）

`docs/verification/gy-r82-failmatrix-reconcile-20261106.md:132` 记着 `#1028` 合入后的中间读数：`notRunnable 13 → 0`、`same 162 → 175`、`sameWithCheck 19 → 20`、`sameWithShape 27 → 30`、`different` 仍 5。以它为参照，本轮相对该中间读数的差值恰好等于 `#1033` 改的 5 条：

- `same` 175 → **180**（+5）、`different` 5 → **0**（−5）：就是 C3-19/20/21 与 C4-15/18 这 5 条。
- `sameWithCheck` 20 → **24**（+4）：C3-19/20/21 与 C4-15 各自新增的 `realCheck` 真跑过；C4-18 只改 `realExpect`（无 `check`）⇒ 落在「二者皆无」里，所以那一列是 +1（125 → **126**），不是 +5。
- `sameWithShape` 27 → 30 是 `#1028` 带来的，本轮**没有**再变（30 → 30）。

这条对齐是**算术自证**，用来证明本轮读数不是「换了一台机器的另一组数字」，而是同一口径下 `#1033` 那 5 条的直接后果。参照的中间读数属引用，本轮没有复跑 `#1028` 那个提交。

## §8 局限与未取得

- **本机 PG 17.11 ≠ CI 环境**：本页是本机 Windows + `E:\GengYunCommander\.pg17\pgsql\bin` 的 17.11 一次性簇（脚本 `initdb` 于 `tests/failmatrix/run-real.mjs:1095`），不是 CI 的 ubuntu-24.04 + PGDG `postgresql-17`。读数一致只说明「同一脚本、同一棵树、同一 PG 大版本下结果相同」，不替代 CI 的绿。
- **stub 臂 249 条没跑**：本轮只跑真库臂的权限面 180 条；`node tests/failmatrix/run.mjs` 与 27 条负控制（`tools/i22-failmatrix-negative-control.mjs`）本片**都没有跑**，不得据此宣称 stub 臂本轮全绿。
- **`--require-no-not-runnable` 的拒红分支没被触发**：本轮 `not_runnable = 0`，`tests/failmatrix/run-real.mjs:1622` 那个 `return 1` 分支从未执行 ⇒ 本页**不证明**该闸门在有 `not_runnable` 时会红（那是既有单测与 `#1054` 口径说明的范围）。
- **不覆盖 stub/real 之外的世界**：无真实对象存储、无真实供应商外呼（整臂 `fetch_calls=0` 自证）、无真机、无真实网络；媒体域走的是合成端点 `storage.example.test`。
- **媒体域「持久化接线」的口径不一致仍在**（既有，非本片引入）：本轮只证明权限面读数，不宣称媒体已按生产形态持久化。
- 本页**没有**做任何 commit 之外的写操作到 `cases.mjs` / `run-real.mjs`：证据页是唯一新增文件。

## §9 清理自证（一次性簇不留在机器上）

- 脚本 `finally` 分支（`tests/failmatrix/run-real.mjs:1642` 起的清理段，`tests/failmatrix/run-real.mjs:1646` 打印 `[pg] 一次性集群已停止，数据目录已删除`）实测生效：日志末行就是这句。
- `Test-Path E:\GengYunCommander\.pg17\tmp\r87-pgroot\gy-i22-failmatrix-realpg-79016-0e68efc2` = **False**；`GY_I22_PG_ROOT` 目录条目数 = **0**。
- `Get-NetTCPConnection -State Listen` 里 **58055 无监听**；本机现存 7 个 `postgres.exe` 全部带 `-D "E:/GengYunCommander/.pg17/data-r74" -p 55433`（既有簇），与本轮无关。
- 临时产物（仓外，`E:\GengYunCommander\.pg17\tmp\`）：`r87-real-arm.log`（230 行）、`r87-real.json`（机读产物）、`r87-realarm-npmci.log`。仓库内除本页外无改动。

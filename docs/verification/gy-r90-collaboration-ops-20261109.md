# R90 协作与操作口径（交接用，2026-11-09）

**本页只记录事实与操作建议，不改任何策略文件。** 纯新增一页，仓内其余文件零 diff（`git diff --stat` 只有本页）。

**范围**：把 GY-R90 这一轮摸清、但仓里还没写下来的「协作事实」固化成可执行口径——draft PR 的实际命运、A／B 档的处置差异、代贴审查评论的边界、八条已知坑、CI 三类红的区分、收尾清单。
**基线**：本版（第三版）动笔时 `origin/main` = `a4183da623215b675d3d088d402dec091f57c41e`（2026-11-09T10:36:30+08:00 / 02:36:30Z），交稿时已前进到 `3ea5792554c8e675208dcdb8349ef6bca2cbd39d`；分支本身从 `a372bd91`（第二版合入点）切出，所以闸门 ② 的 merge-base 仍是 `a372bd91`。此前两版分别以 `af39bfe6`（第一版）与 `a372bd91`（第二版）为基线，两者都已被 main 越过。**main 每天都在前进**，本页任何「当前」读数都只对写作时刻有效，合并前按 §6 第 5 条当场重跑。
**性质**：只记录 GitHub 侧可观测字段与本机可复核读数，不评价内容正确性，不替代合并门禁。`#1084`–`#1113` 那 27 张 PR 的统计底账已另有专页（`docs/verification/gy-r90-supervisor-self-merge-audit-20261109.md:8`），本页**不复述**那张表，只用它之后的样本（`#1117` 起）。

## 0 引证口径（先读这一节，否则会读错本页的行号）

1. 仓内文件一律写 `path:line`，每条都在定稿时**回读过**，落在**行为行**上（不是块首注释、不是空行）。
2. 仓**外**文件（`E:\GengYunCommander\.pg17\` 下的脚本、本机代理设置）写「路径 + 第 N 行」或直接给复核命令。理由：`tools/verify-doc-anchors.mjs:170` 的锚点正则会把它当成仓内锚点，`existsSync` 失败即判 `BROKEN`，从而让闸门 ① 变红；仓内既有同类做法见 `docs/verification/gy-r72-admin-takedown-truth-20261102.md:200`。所以本页**没有**仓外路径的行号锚点。
3. gh 读数一律给到可复现命令与字段名；时间戳是 UTC（后缀 `Z`），看板上的本地时间要 +8。
4. 本页不含裸行号：全文的冒号行号都带路径前缀（自检见 §7 末行）。

## 1 draft 曾经不是冻结（历史行为），现行规则是「草稿阻塞」

> **读法**：§1.1 与 §1.2 记的是**既往样本**（2026-11-08 及更早）。**现行规则在 §1.3**：draft 不进合并队列，监工不代替作者 ready。把 §1.1 当成「现在的做法」会读反了。

### 1.1 三张以 draft 开出、随后被 App 置 ready 并合并的 PR（既往样本，分支保护启用之前）

| PR | 开出 | 唯一一条 review | 置 ready | 合并 | review→ready | ready→merge |
| --- | --- | --- | --- | --- | --- | --- |
| `#1117` | 17:15:07Z | 17:27:55Z `gengyun-supervisor[bot]` / `commented` | 17:31:13Z 同上 | 17:31:16Z 同上 | 198 秒 | **3 秒** |
| `#1119` | 17:16:21Z | 17:30:31Z 同上 | 17:32:29Z 同上 | 17:32:32Z 同上 | 118 秒 | **3 秒** |
| `#1120` | 17:24:11Z | 17:36:04Z 同上 | 17:40:59Z 同上 | 17:41:02Z 同上 | 295 秒 | **3 秒** |

- 三张的 `ready_for_review` 事件由**监工 App 自己**发出——这本身就是「此前是 draft」的证据（GitHub 只在 draft→ready 时记这条事件）。三张 merge 后 `isDraft` 都变 `false`，`mergedBy` 都是 `app/gengyun-supervisor`。三张的日期都是 **2026-11-08**，属于分支保护启用**之前**的行为。
- 三张里没有任何一条来自其他账号的 review：唯一一条 review 的作者 = 合并者，所以「合并前经过独立审查」在这三张上**不成立**（口径见 `docs/pr-review-policy.md:181`）。
- 与底账页同形：该页记的 11 张也是「合并前 4–126 秒由 App 自己置 ready」（`docs/verification/gy-r90-supervisor-self-merge-audit-20261109.md:8`）；本页这三张把间隔压到了 3 秒。
- 本页自己的 PR 也是这套**旧规则**下的样本，不是现行做法的证明：`#1132` 19:11:39Z 以 draft 开出，19:21:05Z 被 App `reviewed`（`state=commented`，正文「结论：通过」），19:23:03Z App 自己置 ready，19:23:08Z App 合并（`a372bd91`）——从 draft 到合并 11 分 29 秒。它同样发生在 `a4183da6`（分支保护）**之前**。
- 复核命令：`gh api repos/GengYunChuChao/GengYun/issues/<n>/timeline --paginate`，看 `reviewed` / `ready_for_review` / `merged` 三种事件的 `created_at` 与 `actor`。

### 1.2 时间边界：这套行为到哪儿为止

- **发生区间**：`#1084`–`#1113`。`#1121` 的审计页把 27 张逐张还原过：19 张有 `ready_for_review` 事件，其中 **11 张由 App 自己置 ready**，ready→merge 为 4–126 秒，且这 11 张的 review 时间**全部早于** ready（`docs/verification/gy-r90-supervisor-self-merge-audit-20261109.md:8`）。本页 §1.1 的三张把这个间隔压到 3 秒。
- **边界**：`a4183da6`（`2026-11-09T10:36:30+08:00` / `02:36:30Z`，「#19 片1 证据页 + 台账口径同步 (#1127)」）之后，main 开启分支保护，合并门禁明确**草稿阻塞**（`docs/pr-review-policy.md:118`、`docs/pr-review-policy.md:133`）。此后未再出现「监工替作者 ready」。
- **边界两侧的实测对照**（`issues/<n>/timeline` 的 `ready_for_review.actor.login`）：
  - 边界**前最后一张**由 App 自置 ready：`#1135`，19:52:21Z by `gengyun-supervisor[bot]`，19:52:37Z 由同一 App 合并。
  - 边界**后**：`#1127` 02:36:23Z 与 `#1137` 02:36:21Z 的 ready 都是 `Sek1ro-oka`（作者）发的，合并也是作者点的；`#1133`（19:47:27Z）同样是作者 ready 后 3 秒自合。
- **边界不是「某天之后大家都变自觉」**，而是有可核参数撑着：分支保护 + 「非草稿」写进 `docs/pr-review-policy.md:133` 的门禁。参数见 §1.3。

### 1.3 现行规则（判据，不是叙述）

1. **draft PR 不进入合并队列。** 「草稿」与 CI 失败、冲突、未解决阻塞同级，都是合并门禁：`docs/pr-review-policy.md:118`。
2. **监工不会代替作者 ready。** 边界后两张样本（`#1127`／`#1137`）的 `ready_for_review` 作者都是 `Sek1ro-oka`；边界前那种「App 自己置 ready」的做法已停止（§1.2）。
3. **只有作者或获授权方 ready 之后，门禁才重新评估**：要重读当前 HEAD、真实 base、非草稿状态、冲突、适用 CI、reviews 与未解决线程（`docs/pr-review-policy.md:133`）；protected branch 的 `strict` 会要求分支与 main 同步后才算绿。
4. **当前分支保护实测**（`gh api repos/GengYunChuChao/GengYun/branches/main/protection`，2026-11-09T10:3xZ 读）：`required_status_checks.contexts` = `unit-tests, contract-tests, static-check, docs, build, access-guards`；`strict` = `true`；`enforce_admins` = `false`；`allow_force_pushes` = `false`；`allow_deletions` = `false`；`required_pull_request_reviews` = 未设（`false`）。
5. **PG 臂未设为必需**（`real-pg-*` 不在上面六个 context 里）：它们要起真 PG、装包、跑 4–5 分钟，抖动成本高；设成必需会把基础设施抖动直接变成合并阻塞（§5）。
6. **操作建议仍然成立**：**要冻结就只推分支、不开 PR**。现在的 draft 虽然阻塞合并，但「解除草稿」这一步随时可能发生，PR 开着就等于随时回到合并队列；把 draft 当保险箱仍是错的。
- 反例（**别**把 draft 当保险）：`#1110` 以 draft 开出（16:29:06Z）、16:40:06Z 被监工 review，最后是**作者自己**在 16:58:09Z 关闭的，关闭理由写在两条评论里——16:58:01Z「已由 #1115 承接」、16:58:07Z「关闭为由 #1115 承接（分支 docs/gy-r90-closeout-nits 保留未删）」。它至今 `isDraft=true`、`mergedAt` 为空。⇒ draft 状态救不了它，救它的是「承接 + 关闭」这套动作（见 §4 第 2 条）。

## 2 A 档与 B 档的实际处置差异

### 2.1 策略怎么定义档位（原文行号，逐条回读过）

- 默认 B 档、A 档是例外：`docs/pr-review-policy.md:162`
- 正面清单（路径必须**全部**落在其中一项）：`docs/pr-review-policy.md:164`
  - `tests/**`：`docs/pr-review-policy.md:166`
  - `docs/**` 下的证据与进度记录（现状页、验证页、进度行）：`docs/pr-review-policy.md:167`
- 受保护文档命中即 B 档：`docs/pr-review-policy.md:169`
- 不在正面清单内一律 B 档（`.github/**`、`tools/**`、`packages/contracts/openapi.json`、真实迁移目录、产品行为代码）：`docs/pr-review-policy.md:173`
- 判定以**合并时的最终 diff** 为准：`docs/pr-review-policy.md:175`；触及排除项当场升档、旧审查作废：`docs/pr-review-policy.md:177`
- 谁能点合并：A 档是 §1 的唯一例外 `docs/pr-review-policy.md:156`；分层**只**回答「谁能点合并」`docs/pr-review-policy.md:158`
- B 档：监工「GitHub 批复并通过后合并 main」`docs/pr-review-policy.md:16`；指挥「推送…并创建 PR…不批准或合并」`docs/pr-review-policy.md:19`
- 监工用组织 App、**不自动回退个人 PAT**：`docs/pr-review-policy.md:18`
- 治理类文档、`.github/**`、迁移类改动**永远**是 B 档，与「改动小」无关：`docs/pr-review-policy.md:197`
- `AGENTS.md` 侧同步的例外条款：`AGENTS.md:14`

### 2.2 实测：档位 ≠ 谁点合并

| 档位（按路径判） | PR | 谁点的合并 |
| --- | --- | --- |
| A 档（只 `docs/**` + `tests/**`） | `#1121` `#1122` `#1124` `#1125` `#1126` `#1115` | `Sek1ro-oka`（指挥自合并） |
| A 档（同上） | `#1117` `#1120` | `app/gengyun-supervisor`（交监工合） |
| B 档（不碰 `.github/**`） | `#1108`（`deploy/**` 等 45 文件）、`#1119`（`tools/**`） | `app/gengyun-supervisor` |
| B 档（改 `.github/workflows/**`） | `#1093`、`#1123`、`#1128` | `Sek1ro-oka`（作者账号；`#1128` 已有 App 的「通过」review 仍由人合） |

读数取 `gh pr list --state merged --limit 20 --json number,mergedBy,files`，逐个看 `mergedBy.login` 与 `files[].path`。

⇒ **本轮样本只能说明两条**：① A 档「可以」自合并，但不等于「一定」自合并——同一批 A 档 PR 里两种处置并存；② **B 档由谁合，得逐张看**：本轮 5 张样本里，不碰 `.github/**` 的（`#1108`／`#1119`）由 App 合，碰 `.github/workflows/**` 的（`#1093`／`#1123`／`#1128`）由作者账号合。这只是**本轮的相关性**，不是判据——跨轮反例见 §2.3：`#716`／`#753`／`#767`／`#918`／`#1049` 全都改了 workflow，全都由 App 合并。档位判的仍是「谁能点」（策略原文同义：`docs/pr-review-policy.md:158`）。

⚠️ **派单写的「B 档由持 PAT 的账号代合」不足以当下结论**：不碰 `.github/**` 的 B 档（`#1108`／`#1119`）实测由 `app/gengyun-supervisor` 合并；改 `.github/workflows/**` 的本轮 3 张确实由 `Sek1ro-oka` 合——但这不是「B 档」的规律，也不是「workflow 只能人合」的规律（§2.3 的反例）。**唯一可执行的判据是 `merged_by` 实测，逐张看，不写通则。** 另需分清：策略里的「不自动回退个人 PAT」（`docs/pr-review-policy.md:18`）约束的是**监工自己**不用个人 PAT 去批复／合并，跟「谁有 `workflow` scope 能推送」是两件事。

### 2.3 `.github/**` 与 `workflows` 权限：**推送**需要，**合并**不需要

**本页第二版写错过的一条，留档防复发**：第二版把「改 `.github/**` 的 B 档只能由持 `workflows` 权限的账号合；App 没这权限 ⇒ 403 ⇒ 别指望 App」写成了判据。**这条被实测证伪**：合并一个改 workflow 的 PR，不需要 `workflows` 权限。

反例（`gh api repos/GengYunChuChao/GengYun/pulls/<n>` 看 `merged_by.login`，`/pulls/<n>/files` 看是否含 workflow）：

| PR | 合并者 | 合并时刻 | 改动里的 workflow 文件 |
| --- | --- | --- | --- |
| `#716` | `app/gengyun-supervisor` | 2026-10-28T04:02:41Z | `.github/workflows/engineering-shell.yml` |
| `#753` | 同上 | 2026-10-28T16:10:56Z | `.github/workflows/real-pg-integration.yml` |
| `#767` | 同上 | 2026-10-29T02:14:18Z | `.github/workflows/real-pg-integration.yml` |
| `#918` | 同上 | 2026-11-04T08:10:41Z | `.github/workflows/engineering-shell.yml` |
| `#1049` | 同上 | 2026-11-07T06:20:26Z | `.github/workflows/real-pg-integration.yml` |

⇒ 5 张全部由 App 合并、全部含 workflow 改动 ⇒「App 合不了 workflow PR」不成立。

**本轮 5 张样本只是相关性，不是判据**（`gh pr list --state merged -L 40 --json number,mergedBy,files` 的窗口分布）：碰 `.github/**` 的 3 张（`#1093` 只改 `real-pg-integration.yml`；`#1123` workflow + 验证页、`reviews` 为空、作者自置 ready 自合；`#1128` workflow + 验证页 + 4 个测试，App 18:52:42Z 给了「结论：通过」仍由人合）全部由 `Sek1ro-oka` 合；不碰的由 App 合 23 张（含 45 文件的 `#1108`、4 文件的 `#1119`）、人合 14 张。窗口内「App 合并」与「碰 `.github/**`」零交集——但上表已经证明这只在本轮窗口成立，换个窗口就反了。

按 `docs/pr-review-policy.md:173` 与 `docs/pr-review-policy.md:197`，`.github/**` 是 B 档、而且「永远」是 B 档；这是**档位**问题，与「谁点合并」无关——第二版把它讲成「平台权限把谁能点收窄到 App 之外」，那是把推送约束误当成了合并约束。

**能保留的那半句（本仓实测，不外推）**：`workflows` 权限约束的是**推送／创建**含 `.github/workflows/**` 改动的分支——本仓这类推送由持 `workflow` scope 的账号执行；**合并**不受此限（反例见上表）。机制层面只记到这里，不再往外推。

**判据（一句话）**：`gh pr view <n> --json files,mergedBy` 逐张看 `mergedBy.login`，**以实测为准，不推通则**。本机也读不到 App 的安装权限清单（`gh api /repos/GengYunChuChao/GengYun/installation` → 401「A JSON web token could not be decoded」，该端点要 App JWT），所以任何「App 有／没有某权限」的断言都不该写进交接页。

**别把「谁合」当「审没审」**：`#1123` 上读不出任何监工批复留痕（线下是否另有批复，PR 上没有痕迹就无法复核）；`#1128` 有 App 的「通过」review 却仍由人合。这两张的档位没争议——`.github/**` 一律 B 档（`docs/pr-review-policy.md:173`、`docs/pr-review-policy.md:197`）；它们说明的是合并者身份不能替代审查记录（口径见 `docs/pr-review-policy.md:181`）。复核：`gh pr view 1123 --json reviews,mergedBy,mergedAt`、`gh pr view 1128 --json reviews,mergedBy,mergedAt`。

### 2.4 操作口径（直接照做）

- **A 档**：可以自己点合并，但合并前仍必须留独立审查（审查者 ∉ {实现者, 推送者, 派发者}，`docs/pr-review-policy.md:181`）、以 `COMMENT` 为载体（`docs/pr-review-policy.md:182`）、过 §7 全部门禁（`docs/pr-review-policy.md:186`）、留合并注记（`docs/pr-review-policy.md:191`）。
- **A 档但审查者只有你本人**（你自己实现的那张）：不许自审通过，只能按 B 档交监工（`docs/pr-review-policy.md:184`）。
- **B 档**：不自己点合并，交给监工。若这张 PR 含 `.github/workflows/**`，需要特别安排的只是**推送**那一步（由持 `workflow` scope 的账号推送分支）；**合并**可能是 App、也可能是人（§2.3 的反例表），不要预判「App 合不了」——以 `mergedBy` 实测为准。合并前必须已有「通过」review 与 reviewed SHA：`#1128` 是正例（App 在 18:52:42Z 审通过、再由人合），`#1123` 是反例（`reviews` 为空、作者自置 ready 自合）。
- **不自证**：合并注记必须链接**审查者本人**的 COMMENT／APPROVED（`docs/pr-review-policy.md:191`）——自己夸自己那张注记不算留痕。

## 3 代贴审查评论：规矩与边界

### 3.1 规矩（策略原文四要件）

代贴允许，但四件事同时成立（`docs/pr-review-policy.md:183`）：

1. 正文首行写「审查者：<主体标识>（本评论由指挥代贴）」，并声明审查者 ∉ {实现者, 推送者, 派发者}；
2. 结论方向与**全部阻塞项逐字保留**，指挥不得改写、删减、替换；
3. 审查者实际跑了什么／没跑什么、负控制结果一并贴出；
4. 合并注记链接该代贴评论，交接清单里写明「代贴」。

配套：审查记录必须落在 PR 上（口头／离线结论不算，合并注记也不能替代审查本身，`docs/pr-review-policy.md:182`）；合并注记必含审查者账号与 reviewed SHA（`docs/pr-review-policy.md:191`）。

### 3.2 本轮六个实例：代贴时刻 vs 合并时刻

取「正文首行为『审查者：…（本评论由指挥代贴）』」的那条 issue 评论，与 `mergedAt` 相减：

| PR | 代贴 | 合并 | 差 | 性质 |
| --- | --- | --- | --- | --- |
| `#1092` | 11:42:33Z | 11:42:44Z | −11 秒 | 合并**前** |
| `#1094` | 12:19:40Z | 12:19:54Z | −14 秒 | 合并**前** |
| `#1096` | 13:11:02Z | 13:12:02Z | −60 秒 | 合并**前** |
| `#1093` | 12:13:13Z | 12:12:49Z | +24 秒 | 合并**后** |
| `#1097` | 14:05:31Z | 14:05:13Z | +18 秒 | 合并**后** |
| `#1098` | 14:31:46Z | 14:31:29Z | +17 秒 | 合并**后** |

`#1096` 的代贴正文还写了「本代理未参与实现、未参与推送、未参与派单，与被审 PR 的实现者 `5d42c6c2` 无重叠」——这是 §3.1 第 1 条要求的独立性声明的正例。`#1092` 同页另有一条 11:24:07Z 的评论写「仍为 draft：不 merge、不 ready」，是**事前**就声明边界的正例。

### 3.3 结论：代贴 ≠ 独立审查

- 代贴只能证明「某个代理说过这些话」，证明不了「合并前有人独立把关」。
- 判据是**时序**，不是评论存在与否：代贴时刻 **早于** `mergedAt` 才算合并前的把关（`#1092`／`#1094`／`#1096`）；**晚于** `mergedAt` 的（`#1093`／`#1097`／`#1098`）只是事后记录，**不能**拿来给当次合并兜底——那三张 PR 在合并前的把关记录是空的。
- 所以合并后补贴时，正文必须自证时点（例如写明「本评论贴于合并之后，不构成合并前的独立审查」），否则下一个人看 PR 会把它读成「审过了才合」。
- 复核：`gh api repos/GengYunChuChao/GengYun/issues/<n>/comments` 取 `created_at`，与 `gh pr view <n> --json mergedAt` 相减。

## 4 八条已知坑（结论 + 触发条件 + 证据）

1. **`push-generic.ps1` 传相对 `-SrcDir` 会把主检出 HEAD 推成远端分支。**
   触发：`-SrcDir` 传相对路径（如 `..\wt-r90ops`）。
   机制：脚本第 176 行先 `Set-Location 'E:\GengYunCommander\GengYun_Agent2'`，到第 179 行才 `git -C $SrcDir rev-parse HEAD` ⇒ 相对路径解析到**主检出**上，把那边 77 条脏改动的 HEAD 推上去。
   处置：永远传绝对路径；推前 `git ls-remote <remote> refs/heads/<branch>` 记下远端旧 SHA，推后同命令再核一次是不是你刚提交的那个 SHA。

2. **已合并分支再推会被护栏拒（`exit 2`）。**
   触发：`-Branch` 指向的分支已经有 MERGED PR（护栏会打印 PR 号、mergeCommit、远端 tip 与本地 HEAD）。
   证据：脚本第 185 行查 `gh pr list --head $Branch --state merged`、第 196 行判定、第 215 行 `exit 2`；第 51 行的 `-AllowMergedBranch` 是「明知会改写已合并 PR 的 head ref 还要推」的逃逸口，不是解决办法。
   处置：新分支 + 新 PR 承接，旧 PR 上写「已由 #NNN 承接」再关。本轮样本：`#1110` 16:58:01Z 评论「已由 #1115 承接」、16:58:09Z 关闭。

3. **`tests/unit/doc-anchor-relocations.json` 是逐条 10 行的 JSON，禁整体重写、禁按行抽取。**
   触发：想用 `JSON.parse`＋`JSON.stringify` 回写，或用「一行一条」的正则去捞条目。
   证据：第一条登记就从 `tests/unit/doc-anchor-relocations.json:3` 的 `doc` 键起、横跨第 2–11 行（8 个键 `doc`/`line`/`target`/`from`/`fromEnd`/`to`/`toEnd`/`reason`），`reason` 是中文明文；读取方按整文件解析（`tests/unit/doc-anchor-relocation-identity.test.mjs:150` 写死这份登记表的相对路径）。仓内既有同口径禁令：`docs/verification/gy-r88-i30-http-arm-wiring-20261108.md:87`（「没有 `JSON.parse`+`JSON.stringify` 整体重写」）。
   处置：先取 `origin/main` 的**全量**文件当底稿，只在文本层面替换／追加要改的那几行（整段拼接）；改完用 `JSON.parse` 只做**校验**、不做回写。

4. **`gh api .../jobs/<id>/logs` 可能只拿到 0 字节。**
   触发：日志走重定向／管道落盘时（本轮实测该命令落盘 0 字节）。
   反例（别过度概括）：同仓历史页用同一 API 取到过日志原文，见 `docs/verification/gy-r66-wire-audit-logs-arm-20261027.md:283` ⇒ 0 字节不等于「CI 没日志」。
   处置：取失败日志用 `gh run view <run> --job <job> --log-failed`。

5. **`gh pr view --json body` 抖动时会用错误对象覆盖正文。**
   触发：`gh` 走 GraphQL 偶发 `EOF`／超时；失败时仍然输出了 JSON，`--json body` 落盘就把 PR 正文写坏。
   处置：读正文用 REST：`gh api repos/GengYunChuChao/GengYun/issues/<n> --jq .body`（仓内既有写法：`docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:37`）。写正文前先把原正文备份一份。

6. **identity 闸门在 main tip 上必红——这是设计内自诊断，不是回归。**
   触发：worktree 刚开、还没提交（`git merge-base HEAD origin/main` 等于 HEAD），或在 main tip 上直接跑。
   证据：`tests/unit/doc-anchor-relocation-identity.test.mjs:1309` 判 `base === head`；CI 浅克隆走 `tests/unit/doc-anchor-relocation-identity.test.mjs:1313` 的 `if (isCi())` 守卫，非 CI 走 `tests/unit/doc-anchor-relocation-identity.test.mjs:1317` 的 `assert.notEqual`，消息是「base 与 HEAD 同一提交…本用例没有判定面却也不是 CI 浅克隆…不允许静默通过」；真正吐 SKIP 的是 `t.skip(...)`（`tests/unit/doc-anchor-relocation-identity.test.mjs:1314`），紧接 `return;`。
   处置：**提交之后再跑**（有判定面即可），⛔ 不要为了让这条变绿去改测试。

7. **多个代理并发跑全量 `npm run test:unit` 会互相饿死。**
   触发：同一台机上同时有多份 node 测试进程；本轮观测过一次 65 分钟不结束，独占同一命令只要 3 分半。
   处置：跑前 `(Get-Process node -ErrorAction SilentlyContinue).Count`；>6 就只跑受影响文件，并在交接里写明「全量以 CI 为准」。
   备注：本条是**本机观测**，仓内无法复核，只能按上面的命令当场重测。

8. **本机 `*_proxy` 指向 `127.0.0.1:7897`，直连与走代理都会抖。**
   当场可复核：`(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings').ProxyServer` 读回 `127.0.0.1:7897`；`$env:https_proxy` 读回 `http://127.0.0.1:7897`。
   症状：OpenSSL 的 `error:0A000126`、`curl: (56)`（收不到完整响应）、`gh` 的 `EOF`。
   处置：失败先重试 2–6 次，两种走法（直连／代理）都试一次；⛔ 不要把某一次的成败写成恒定结论——这条同时是本页所有 gh 读数都给了可复现命令的原因。

## 5 CI 的三类红怎么区分

| 类别 | 判据（按顺序看） | 本轮对应 |
| --- | --- | --- |
| 真断言失败 | 失败 step 的日志里是断言／`Error:` 行；**同一 SHA 重跑仍然红**；能本地复现 | 修代码或修断言，别重跑赌一次 |
| 基础设施抖动 | 失败行是下载／连接类（`curl: (56)`、`error:0A000126`）；同一步骤重跑转绿 | PG 安装步骤已加重试：`sudo curl … --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 15` 在 `.github/workflows/real-pg-integration.yml:596`，`apt-get -o Acquire::Retries=5 … update` 在 `.github/workflows/real-pg-integration.yml:598`；那 12 行改动的逐行账在 `docs/verification/gy-r90-ci-pg-install-retry-20261109.md:212` |
| 已知假红 | identity 闸门在 main tip／浅克隆上的自诊断（§4 第 6 条）：本地 main tip 走 `tests/unit/doc-anchor-relocation-identity.test.mjs:1317` 的断言，CI 浅克隆走 `tests/unit/doc-anchor-relocation-identity.test.mjs:1314` 的 `t.skip` | 不当回归处理；看到 SKIP 不是绿也不是红，是「本轮没有判定面」 |

判法：① 先看失败 job 名与失败 step 名；② `gh run view <run> --job <job> --log-failed` 取原文（§4 第 4 条）；③ 对号入座；④ **判「真红」之前必须有一次同 SHA 重跑仍然红**——否则很容易把一次代理抖动写成产品缺陷。

## 6 收尾清单（每一步都要有读数，不靠「我记得删了」）

1. **拆 junction**：`cmd /c rmdir <worktree>\node_modules`。⛔ 不要用 `Remove-Item -Recurse`——它会穿透 junction 删掉**主检出**的真目录。
2. **拆 worktree**：`git worktree remove --force <worktree>`，然后 `git worktree prune`，最后 `git worktree list` 确认已消失。
3. **无残留进程**：`Get-Process postgres,node -ErrorAction SilentlyContinue` 应为空（或与开工前同一组）。
4. **主检出回到开工前**：`(git -C E:\GengYunCommander\GengYun_Agent2 status --porcelain).Count` 必须回到开工前的条数——本轮恒为 **77** 行。
5. **远端对账**：`git ls-remote origin refs/heads/<branch>` 与本地 `git rev-parse HEAD`、以及 PR 的 `headRefOid` 三者一致。**别把「留在 draft」当冻结**：`#1132` 在旧规则下以 draft 开出后 11 分 29 秒内被 App 置 ready 并合并（§1.1）；现在 draft 阻塞合并（§1.3）——要冻结就只推分支。

## 7 六道闸门与本页自检（本轮实跑）

| # | 命令 | EXIT | 尾行（逐字） |
| --- | --- | --- | --- |
| ① | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）` |
| ② | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `ℹ tests 37` / `ℹ pass 37` / `ℹ fail 0` / `ℹ skipped 0`；本次判定面 `pairs=6 judged=6 identical=6 relocated=0 registered=0`（base `a372bd91`，`hunks(pair=22 add=3 del=0)`）。上一版是纯新增 hunk，同一命令走「无位移面」显式 SKIP（`skipped 1`）；**提交前**（HEAD 与 origin/main 同一提交）同一用例是 `fail 1`（§4 第 6 条的自诊断） |
| ③ | `node tools/verify-contract-status.mjs` | 0 | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| ④ | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 365 页（扫描面 370 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` |
| ⑤ | `node tools/verify-g-drill-readings.mjs --check` | 0 | `✓ 八条判据全过：workflows 15 / jobs 30 / 演练 21 条 / 测试文件 608（glob 合计 578）；生长型读数按**下界**判（--tolerant-growth），其中 8 条滞后已逐行打印` |
| ⑥ | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 输出一行 tree oid、无冲突路径（oid 随 HEAD 变，每次重算，故不在此固定引用） |

- 闸门 ① 就是 CI 跑的同一条命令（`.github/workflows/engineering-shell.yml:112`），本地绿 ≠ CI 绿的唯一差别是扫描面一致、环境不同。
- 闸门 ② 的「必红」不是缺陷：`tests/unit/doc-anchor-relocation-identity.test.mjs:1309` 的自诊断把「base 与 HEAD 同一提交」当成取 base 逻辑坏掉的信号（§4 第 6 条）。
- 表内读数取自**本轮修订分支**的实跑（分支自 `a372bd91` 切出，闸门 ② 的 merge-base 就是它；动笔时 `origin/main` 已到 `a4183da6`，交稿时再到 `3ea57925`）。main 这几轮一直在前进：`af39bfe6`（第二版 base）→ `7835bfe5`（`#1129`）→ `5a54b262`（`#1128`）→ `a372bd91`（`#1132`，本页第二版合入）→ `a30c8adb`（`#1133`）→ `a40fba6c`（`#1135`）→ `754efa23`（`#1137`）→ `a4183da6`（`#1127`，分支保护起点）→ `3ea57925`（交稿时 tip）。`git merge-tree --write-tree --name-only origin/main HEAD` 每次都 exit 0 且无冲突路径，但那一律是**当时**的判定——合并前必须按 §6 第 5 条用当次的 `origin/main` 重跑，不许拿本页读数顶替。
- 本页自检：`Select-String -Path docs/verification/gy-r90-collaboration-ops-20261109.md -Pattern '(?<![\w./-]):\d'` —— 命中 **0** 行（本页无裸行号）。

## 8 派单写的 vs 实测（只有这几处不一致，其余逐条对得上）

| 派单写的 | 实测 |
| --- | --- |
| 时间线用 `gh api repos/…/pulls/<n>/timeline` | 本机 gh 2.102.0 打这个端点是 **404**（加 `Accept: application/vnd.github.mockingbird-preview+json` 也一样）；改用 `issues/<n>/timeline`，`reviewed`／`ready_for_review`／`merged` 事件都在里面 |
| `#1110` 是「draft 被监工置 ready + squash」的样本 | `#1110` 至今 `isDraft=true`、`mergedAt` 为空、16:58:09Z 由作者关闭，理由是「已由 #1115 承接」⇒ 它是**承接关闭**样本，不是置 ready 样本 |
| B 档「由持 PAT 的账号代合」 | **不足以当下结论**：本轮 5 张里不碰 `.github/**` 的由 App 合（`#1108`／`#1119`），碰 `.github/workflows/**` 的由 `Sek1ro-oka` 合（`#1093`／`#1123`／`#1128`）——但跨轮反例 `#716`／`#753`／`#767`／`#918`／`#1049` 全部由 App 合并且都改了 workflow ⇒ 「`workflows` 权限」卡的是**推送**、不是合并。判据：逐张看 `mergedBy`（§2.3） |
| 八条坑里「相对 `-SrcDir` 会把主检出 HEAD 推上去」 | 结论对，机制要补：脚本第 176 行先 `Set-Location` 进主检出、第 179 行才 `git -C $SrcDir`，所以**相对路径**才落在主检出上（绝对路径不受影响） |
| 「`jobs/<id>/logs` 会返回 0 字节」 | 本轮实测 0 字节，但同仓历史页取到过原文（`docs/verification/gy-r66-wire-audit-logs-arm-20261027.md:283`）⇒ 是「会」不是「恒」 |
| 代贴时序：`#1093`／`#1097`／`#1098` 在合并后，`#1092`／`#1094`／`#1096` 在合并前 | **对得上**（逐条见 §3.2，差值 −60 秒到 +24 秒） |
| 并发饿死 65 分钟 vs 独占 3 分半 | 本轮本机观测，仓内无留痕；只能按 §4 第 7 条的命令当场重测 |
| 「开成 draft 先放着，等我点头再合」 | 这条在 `a4183da6` 之前不成立：`#1132` 19:11:39Z 以 draft 开出 → 19:21:05Z App review → 19:23:03Z App 置 ready → 19:23:08Z 合并，全程没人按过 ready（§1.1）。现在 draft 阻塞合并（§1.3），但「解除草稿」只差一个人按一下——冻结仍只能靠「不推 PR」 |

## 9 给下一任指挥的一页交接

1. 想冻结就**只推分支**；开了 PR 就当作会被合。draft 现在阻塞合并（§1.3），但那只是「还没人按 ready」，不是承诺。
2. A 档能自合并，但独立审查、`COMMENT` 载体、§7 门禁、合并注记四件一件都不能省；自己实现的 PR 只能交 B 档。
3. 代贴只是载体：**时序早于合并**才算把关，晚于合并必须在正文里自证时点。
4. 八条坑里最贵的是第 1 条（相对 `-SrcDir`）和第 7 条（并发全量测试）——一条会污染主检出，一条会烧掉一小时。
5. 判红之前先重跑一次同 SHA；判绿之前先看 `git ls-remote`。
6. 收尾五步都要读数；主检出脏改动条数本轮恒为 77，回不到 77 就说明这轮动错了地方。
7. 含 `.github/**` 的 PR：**推送**那一步交给持 `workflow` scope 的账号；**合并**看 `mergedBy` 实测（App 与人合过都有，§2.3），别预判「App 合不了」。

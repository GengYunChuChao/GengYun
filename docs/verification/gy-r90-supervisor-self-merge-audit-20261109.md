# 监工自审自合与 draft 自动 ready 的时序底账（GY-R90，2026-11-09）

**范围**：`GengYunChuChao/GengYun` 的 `#1084`–`#1113` 区间内全部 27 张已合并 PR（该区间另有 `#1108` 开放 draft、`#1110`／`#1111` 关闭未合并，不计入）。
**性质**：只记录 GitHub 侧可观测的身份字段与时序，不评价合并内容正确性，不替代合并门禁。
**抓取时刻**：逐 PR 数据 `2026-11-08T17:06Z`（HKT `2026-11-09T01:06`，UTC+8）；合并清单与未合并状态复核 `2026-11-08T17:10Z`（HKT `2026-11-09T01:10`）。
**数据来源**：GitHub REST `pulls/{n}`、`pulls/{n}/reviews`、`pulls/{n}/files`、`issues/{n}/comments`、`issues/{n}/timeline`，以及 `gh pr list --state merged --limit 60`。

**一句话事实**：27 张里 16 张的 review 作者与 `merged_by` 是同一个 App（`gengyun-supervisor[bot]`）；这 16 张的 review→merge 中位间隔 34 秒、最短 5 秒；11 张在合并前 4–126 秒由该 App 自己把 draft 置为 ready；21 张有 review 的 PR 里，review 作者全部是该 App，没有一条来自其他账号。

## 1 口径与取数方法

### 1.1 身份归一

- `gengyun-supervisor[bot]`（REST 的 `user.login`／`merged_by.login`）与 `app/gengyun-supervisor`（GraphQL `gh pr list --json mergedBy`）是同一个组织 GitHub App；其 App ID `5303709`、slug、安装 ID 见 `AGENTS.md:15`。本页表格统一写作 `bot`。
- 27 张 PR 的 `user.login` 全部是 `Sek1ro-oka`；按 `AGENTS.md:13`，该账号同时承担实现者与推送者（指挥以已授权凭据推送并建 PR），本页无法从 GitHub 字段区分这两个角色，故只按账号计。
- 因此本页的「独立审查」在账号级只能判到「reviewer ≠ `Sek1ro-oka` 且 reviewer ≠ 该 PR 的 `merged_by`」这一粒度。

### 1.2 抓取字段与用途

- `pulls/{n}`：`number`、`title`、`created_at`、`draft`、`merged_at`、`merged_by.login`、`user.login`、`head.sha`、`base.ref`、`changed_files`。
- `pulls/{n}/reviews`：`user.login`、`state`、`submitted_at`、`commit_id`（review 绑定的 SHA），用 `?per_page=100`；本页不使用可能截断的 `gh pr view --json reviews`。
- `pulls/{n}/files`：`filename`，用于按最终 diff 判 A/B 档（`docs/pr-review-policy.md:175`）。
- `issues/{n}/comments`：`user.login`、`created_at`、`body`，用于识别正文含「本评论由指挥代贴」的独立审查评论。
- `issues/{n}/timeline`：`ready_for_review`、`merged` 事件的 `created_at`、`actor.login`，用于还原 draft→ready→merge 的先后。
- `pulls/{n}/comments`（行内 review 评论）：27 张实测合计 0 条，故本页所有审查文字都是 issue 级评论或 review 正文。

### 1.3 独立审查判据（两级，不混计）

- **L1（账号级可核）**：review 的 `user.login` ∉ {PR 作者, 推送者, 派发者}，且 ≠ 该 PR 的 `merged_by.login`。本仓作者与推送者同为 `Sek1ro-oka`，故 L1 实际等价于「reviewer 不是 `Sek1ro-oka`，也不是合并者本人」。
- **L2（正文自述，账号级不可核）**：`issues/{n}/comments` 中首行形如「审查者：独立审查代理 `xxxxxxxx`（本评论由指挥代贴）」的评论。`docs/pr-review-policy.md:183` 允许无 GitHub 身份的子代理由指挥代贴，但 GitHub 记录上的发布账号仍是 `Sek1ro-oka`，无法与作者账号区分，故单列为 L2，不与 L1 相加成「一条 review」。
- 明确不算独立审查的三种形态：① review 作者 = `merged_by`（自审自合）；② 既无 review 也无代贴评论；③ review 或代贴评论出现在 `merged_at` 之后。
- 「自审自合」在本页定义为：该 PR 存在一条 `submitted_at ≤ merged_at` 的 review，且该 review 的 `user.login` = `merged_by.login` = `bot`。

### 1.4 A/B 档判据

按 `docs/pr-review-policy.md:162`（默认 B、A 为例外）、`docs/pr-review-policy.md:166`（`tests/**`）、`docs/pr-review-policy.md:167`（`docs/**` 的证据与进度记录）、`docs/pr-review-policy.md:169`（受保护文档清单）、`docs/pr-review-policy.md:173`（正面清单外一律 B）、`docs/pr-review-policy.md:175`（以合并时最终 diff 为准）逐文件核对 `pulls/{n}/files`：

- A 档：全部改动落在 `tests/**` 或 `docs/**` 的证据/进度记录，且未命中 `docs/pr-review-policy.md:169` 的受保护文档。
- B 档：任一文件落在 `.github/**`、`tools/**`、`miniprogram/**`、`services/**`、`packages/**`、`.env*`，或命中受保护文档（含 `docs/architecture/contract-status.json`）。
- 表中带 `*` 的 6 张没有任何 review，档位由路径规则反推（这 6 张的改动全部落在 `tests/**` 或 `docs/verification/**`，故为 A，仅 `#1093` 因 `.github/workflows/**` 为 B）。
- 21 张有 review 的 PR 中，17 张正文自述档位且与上述路径判定逐张一致；另 4 张只自述改动面（实质同为 A 档）。

B 档 6 张的触发路径：

| PR | 触发 B 档的路径 | 合并者 | 合并前 review |
| --- | --- | --- | --- |
| #1093 | `.github/workflows/real-pg-integration.yml` | Sek1ro-oka | 无 |
| #1096 | `tools/doc-anchors-orphan-baseline.json` | Sek1ro-oka | bot/COMMENTED，+1077s |
| #1098 | `tools/doc-anchors-orphan-baseline.json` | Sek1ro-oka | bot/COMMENTED，+473s |
| #1099 | `docs/architecture/contract-status.json` | bot | bot/COMMENTED，+115s |
| #1101 | `miniprogram/utils/audio-playback.js` | bot | bot/COMMENTED，+283s |
| #1106 | `.env.example` | bot | bot/COMMENTED，+128s |

## 2 逐 PR 表（#1084–#1113，27 张已合并）

列说明：`review 作者/state` 取**最后一条合并前** review；`秒差` = `merged_at` − 该 review 的 `submitted_at`（正数表示 review 在前）；`自审自合` 按 §1.3 定义；`代贴评论` 指正文含「本评论由指挥代贴」的 issue 评论相对 `merged_at` 的位置。

| PR | 档位 | review 作者/state | 秒差 | 自审自合 | 代贴评论 | 合并者 |
| --- | --- | --- | --- | --- | --- | --- |
| #1084 | A | bot/APPROVED | +2277 | 否 | 无 | Sek1ro-oka |
| #1085 | A | bot/APPROVED | +15 | 是 | 无 | bot |
| #1086 | A* | 无 | — | 否 | 无 | Sek1ro-oka |
| #1087 | A | bot/APPROVED | +13 | 是 | 无 | bot |
| #1088 | A | bot/APPROVED | +15 | 是 | 无 | bot |
| #1089 | A* | 无 | — | 否 | 无 | Sek1ro-oka |
| #1090 | A | bot/APPROVED | +28 | 是 | 无 | bot |
| #1091 | A* | 无 | — | 否 | 无 | Sek1ro-oka |
| #1092 | A* | 无 | — | 否 | 合并前 11s | Sek1ro-oka |
| #1093 | B* | 无 | — | 否 | 合并后 24s | Sek1ro-oka |
| #1094 | A* | 无 | — | 否 | 合并前 14s | Sek1ro-oka |
| #1095 | A | bot/COMMENTED | +3274 † | 否 | 无 | Sek1ro-oka |
| #1096 | B | bot/COMMENTED | +1077 | 否 | 合并前 60s | Sek1ro-oka |
| #1097 | A | bot/COMMENTED | +771 | 否 | 合并后 18s | Sek1ro-oka |
| #1098 | B | bot/COMMENTED | +473 | 否 | 合并后 17s | Sek1ro-oka |
| #1099 | B | bot/COMMENTED ‡ | +115 | 是 | 无 | bot |
| #1100 | A | bot/COMMENTED | +52 | 是 | 无 | bot |
| #1101 | B | bot/COMMENTED | +283 | 是 | 无 | bot |
| #1102 | A | bot/COMMENTED | +165 | 是 | 无 | bot |
| #1103 | A | bot/COMMENTED | +85 | 是 | 无 | bot |
| #1104 | A | bot/COMMENTED | +60 | 是 | 无 | bot |
| #1105 | A | bot/COMMENTED | +40 | 是 | 无 | bot |
| #1106 | B | bot/COMMENTED | +128 | 是 | 同一秒（+0） | bot |
| #1107 | A | bot/COMMENTED | +5 | 是 | 无 | bot |
| #1109 | A | bot/COMMENTED | +5 | 是 | 无 | bot |
| #1112 | A | bot/COMMENTED | +6 | 是 | 无 | bot |
| #1113 | A | bot/COMMENTED | +7 | 是 | 无 | bot |

- `†` #1095：合并前最后一条 review 绑 `7faeadb3`（旧 head，+3274s）；最终被合入的 head `773b805b` 的 review 出现在合并**之后** 228 秒（`2026-11-08T13:52:21Z`，merge 为 `13:48:33Z`）。
- `‡` #1099：首条是 `CHANGES_REQUESTED`（`e2abed09`，+1200s），返修后第二条 `COMMENTED`（`a09367b6`，+115s，即最终 head）。
- 除 #1095 外，其余 20 张有 review 的 PR 的最终 head 在合并前均已有绑定同一 SHA 的 review；另 6 张合并前无任何 review（见 §3.1）。

## 3 统计（逐行可加）

### 3.1 三分类互斥

| 口径 | 张数 | 表内来源 |
| --- | --- | --- |
| 区间内已合并 | 27 | 表 27 行 |
| 自审自合（review 作者 = merged_by = bot，且 review 在合并前） | 16 | `自审自合` 列「是」16 行 |
| 无任何 review（含无代贴评论的 3 张） | 6 | #1086、#1089、#1091、#1092、#1093、#1094 |
| 有 review 且合并者不是 review 作者 | 5 | #1084、#1095、#1096、#1097、#1098 |
| 合计校验 16 + 6 + 5 | 27 | 三类互斥 |

### 3.2 档位 × 合并者

| 档位 | bot 合并 | Sek1ro-oka 合并 | 合计 |
| --- | --- | --- | --- |
| A | 13 | 8 | 21 |
| B | 3 | 3 | 6 |
| 合计 | 16 | 11 | 27 |

即：16 张自审自合里 A 档 13 张、B 档 3 张（#1099 受保护台账、#1101 小程序播放代码、#1106 `.env.example`）。

### 3.3 review→merge 时间差（16 张自审自合）

- 全部 16 个值：5、5、6、7、13、15、15、28、40、52、60、85、115、128、165、283（秒）。
- 合计 1022 秒，平均 63.9 秒，中位 34 秒，最短 5 秒（#1107、#1109），最长 283 秒（#1101）。
- ≤10 秒 4 张（#1107 5、#1109 5、#1112 6、#1113 7）；≤60 秒 11 张；>600 秒 0 张。
- 5 张「有 review 且合并者非 review 作者」的秒差为 2277、1077、771、473、3274。

### 3.4 合并前独立审查与事后补审

- 合并前存在 **L1** 独立 review 的：5 张（#1084、#1095、#1096、#1097、#1098），占 27 张的 18.5%。这 5 张的合并者都是 `Sek1ro-oka`；同一 App 在另外 16 张里既审又合。
- 合并前存在 **L2** 代贴评论的：3 张（#1092 合并前 11 秒、#1094 合并前 14 秒、#1096 合并前 60 秒）。其中 #1096 已计入 L1；并集为 7 张（25.9%）。
- #1106 的代贴评论与 `merged_at` 同为 `2026-11-08T16:22:34Z`，先后不可判；若计入，上限 8 张（29.6%）。
- 合并**之后**才补的独立复核：3 张（#1093 合并后 24 秒、#1097 合并后 18 秒、#1098 合并后 17 秒）。其中只有 #1093 在合并前没有任何 review 或代贴评论，即「先合并、事后才补独立复核」的纯案例 1 张。
- 另有 #1095 在合并后 228 秒由同一 App 对已合入 head 补了一条 review，属同账号补审，不计独立。
- 完全没有任何审查记录（无 review、无代贴）的 3 张：#1086、#1089、#1091，合并者均为 `Sek1ro-oka`。

### 3.5 draft 与 ready

- 27 张中 19 张有 `ready_for_review` 事件；8 张（#1084–#1090、#1107）无该事件，即创建时即非 draft。
- 19 张中由 `bot` 置 ready 的 11 张：#1099、#1100、#1101、#1102、#1103、#1104、#1105、#1106、#1109、#1112、#1113；由 `Sek1ro-oka` 置 ready 的 8 张：#1091–#1098。
- bot 置 ready 的 11 张，ready→merge 为 4、5、5、10、13、16、38、40、43、51、126 秒（合计 351，平均 31.9，中位 16）。
- 这 11 张的 review 时间**全部早于** ready 时间：即「以 draft 状态收 review → 自审通过后自己置 ready → 4–126 秒内合并」，最短链条是 #1109（review `16:37:34Z` → ready `16:37:35Z` → merge `16:37:39Z`）。

## 4 时间线片段（逐字引 GitHub 返回值）

### 4.1 #1107：review 与 merge 相隔 5 秒，且未经过 ready 事件

```
2026-11-08T16:20:08Z  2026-11-09T00:20:08  created（draft=false）
2026-11-08T16:28:10Z  2026-11-09T00:28:10  review   bot  COMMENTED  sha=e02afffb
2026-11-08T16:28:15Z  2026-11-09T00:28:15  merged   bot
```

该 review 正文自述：「复用作者单文件/全量与变异读数，以及当前 HEAD 的 25/25 check-runs success；监工未重复运行本地业务测试。」（`2026-11-08T16:28:10Z`，369 字，`state=COMMENTED`）

### 4.2 #1112：draft 在 review 之后 1 秒被置 ready，再过 5 秒合并

```
2026-11-08T16:41:07Z  2026-11-09T00:41:07  created
2026-11-08T16:46:45Z  2026-11-09T00:46:45  review           bot  COMMENTED  sha=8163b5ad
2026-11-08T16:46:46Z  2026-11-09T00:46:46  ready_for_review  bot
2026-11-08T16:46:51Z  2026-11-09T00:46:51  merged            bot
```

`ready_for_review` 只会由 draft→ready 触发，故该 PR 在 `16:46:46Z` 之前处于 draft；从置 ready 到 squash 合并 5 秒。review 正文同样自述「未重复运行本地业务测试」，并以「随后置 ready」收尾。

### 4.3 #1095：最终被合入的 SHA，其 review 出现在合并之后 228 秒

```
2026-11-08T12:45:10Z  2026-11-08T20:45:10  created
2026-11-08T12:53:59Z  2026-11-08T20:53:59  review   bot  COMMENTED  sha=7faeadb3（旧 head）
2026-11-08T13:48:33Z  2026-11-08T21:48:33  merged   Sek1ro-oka    head=773b805b
2026-11-08T13:52:21Z  2026-11-08T21:52:21  review   bot  COMMENTED  sha=773b805b（+228s）
```

合并时能对上的只有旧 SHA 的通过结论；新 head 的通过结论在合并 228 秒后才出现。按 `docs/pr-review-policy.md:133`（合并前重读 HEAD、核对 reviews 与未解决线程），合并前本应已有针对当前 HEAD 的结论。

## 5 缓解建议（每条带代价）

### 5.1 把 A 档合并动作交回指挥，bot 只允许留 COMMENT

- 动作：bot 对 A 档 PR 只调 `POST /reviews`（COMMENT），不再调 `PUT /merge`；合并由 `AGENTS.md:14` 指定的指挥执行。B 档仍由 bot 按 `AGENTS.md:11` 批复后合并。
- 覆盖：直接消掉 16 张里的 13 张 A 档自审自合。
- 代价：A 档从「bot 自己 5 秒闭环」变为「等指挥在线」，按今天 13 张的密度，指挥每轮需多花约 15–40 分钟复核并逐张合并；且指挥与推送者是同一账号，仍不构成「第二人」合并。
- 残余：B 档仍可自审自合（#1099、#1101、#1106）。

### 5.2 在 bot 侧加 review→merge 冷却闸门（建议 N = 10 分钟）

- 动作：合并前检查 `now − max(reviews[].submitted_at) ≥ 600s`，不满足则拒绝合并并在 PR 上留一条说明。
- 覆盖：今天 16 张自审自合的秒差全部 < 600 秒（最大 283），即 16 张都会被挡下；5–7 秒的 4 张会被推迟到 10 分钟。
- 代价：每张多等 ≤10 分钟；bot 需新增守卫逻辑与单测（B 档 PR，含自测）；真正的紧急热修也被同样延迟，若加 `hotfix` 例外标签，例外本身可被任意 PR 借用。
- 残余：冷却只改时序，不改变「reviewer = merger」这一身份事实。

### 5.3 把 ready 与「存在非合并者的 COMMENT/APPROVED」绑定

- 动作：bot 只有在 `reviews` 中存在 `user.login ≠ merged_by.login` 的 `COMMENTED`／`APPROVED` 时才允许把 draft 置 ready；代贴评论按 `docs/pr-review-policy.md:183` 另记 `代贴` 标志并保留原文。
- 覆盖：今天 11 张 bot 自动 ready 里 6 张发生在 bot 自己 review 之后 0–2 秒内，另 5 张在 20–267 秒内（#1104 20s / #1103 42s / #1099 102s / #1102 155s / #1101 267s）；该闸门会把它们全部挡在 draft。
- 代价：需要改 `.github/workflows/**` 或 bot 的合并脚本（B 档 + 自测 + 一轮 CI）；代贴评论的发布账号仍是 `Sek1ro-oka`，账号级无法核验，仍需人工确认是否为真实第三方结论。
- 残余：无法阻止「先由 bot 置 ready、再由 Sek1ro-oka 合并」的等价路径（今天 #1091–#1098 即此形态）。

### 5.4 合并注记自动化，强制链接审查者本人的 COMMENT

- 动作：按 `docs/pr-review-policy.md:191`，合并后 60 秒内由 bot 写一条注记，字段为审查者账号、reviewed SHA、CI 项数与结论、合并者、squash、未关闭 issue；缺任一字段即自动开 issue 并 @ 监工。
- 覆盖：27 张中只有 #1090 有一条合并注记（`2026-11-08T10:23:28Z`，含 `merged_sha`、`merged_by`、`remote main`），但未链接审查者本人的 COMMENT——该 PR 的审查者与合并者同为 bot，按 `docs/pr-review-policy.md:191` 的「避免变成合并者自证」无法满足；其余 26 张没有同类注记。
- 代价：每次合并多 1 次 API 写与模板维护；对已合并的 27 张只能补记，不改变既成事实；注记仍由合并者自己生成，不能替代独立审查。
- 残余：无法阻止事后补写。

### 5.5 事后复核 SLA：24 小时内贴回并在本页登记

- 动作：合并后 24 小时内，指挥须把真正独立复核的结论贴回 PR（首行沿用「审查者：…（本评论由指挥代贴）」），并在本页追加一行「PR／复核者／完成时刻／结论」；超 24 小时即升级给用户。
- 覆盖：今天 3 张合并后才补（#1093 +24s、#1097 +18s、#1098 +17s）已符合该 SLA；#1086、#1089、#1091 三张至今零审查记录，会被该 SLA 挑出。
- 代价：需要一张登记表 + 定时提醒（每轮巡检多 1 次查询），逾期升级会占用用户注意力；且事后复核只能补记录，不能撤回已合入的代码。
- 残余：SLA 依赖人工执行，无自动阻断力。

## 6 不声称

- 不声称监工（`gengyun-supervisor[bot]`）有恶意、越权意图或伪造记录；本页只复述 GitHub 返回的账号、时间戳与正文字段。
- 不声称其审查无价值：21 张有 review 的 PR 均带 `reviewed_sha`、逐条结论与 P0/P1/P2 计数（例如 #1107 的 369 字正文），本页不评价这些结论的技术正确性。
- 不声称本页替代了合并门禁或 GitHub 分支保护；`main` 的实际保护规则、必需审查数、是否允许 App 绕过，本页未核验。
- 不评价任何一张 PR 的合并内容是否正确、是否应该合并；本页只记录「谁在什么时刻做了什么动作」。
- 不判断上述时序是否另经线下授权或口头批准；本页只覆盖 GitHub 侧可观测事实。
- 只覆盖 `#1084`–`#1113` 的 27 张已合并 PR，不外推到更早或更晚区间，也不代表其他仓库。

## 7 复跑脚本与校验

### 7.1 环境与前置

- 仓库：`GengYunChuChao/GengYun`；`gh` ≥ 2.102；PowerShell 5.1 或 7 均可。
- 令牌：`$env:GH_TOKEN=(Get-Content E:\GengYunPrivate\github-pat.txt -Raw).Trim()`；所有 `gh` 命令显式带仓库。
- 网络：本机实测 `gh api` 会间歇返回 `EOF`，脚本内置 12 次重试与退避；复跑时若某张 PR 连续失败，脚本会抛错而不是静默跳过。
- 时刻：本页数据于 `2026-11-08T17:06Z`（HKT `2026-11-09T01:06`）抓取；复跑会得到同一批 PR，但 `merged_at` 之后的字段（如新增评论）可能增多。
- 编码：把 7.2 整块另存为 `.ps1` 时用 **UTF-8 with BOM**。PowerShell 5.1 对无 BOM 文件按 ANSI 解码，会破坏脚本里的中文字面量（`本评论由指挥代贴`），表现为 `ProxySec` 列全空——那是编码问题，不是数据缺失。

### 7.2 脚本

```powershell
# repro-self-merge-audit.ps1 -- 复跑 #1084..#1113 的自审自合时序表
param([int]$From = 1084, [int]$To = 1113, [string]$MergedBefore = '2026-11-08T17:06:00Z')
$ErrorActionPreference = 'Stop'
$env:GH_TOKEN = (Get-Content E:\GengYunPrivate\github-pat.txt -Raw).Trim()
$repo = 'GengYunChuChao/GengYun'
$bot  = 'gengyun-supervisor[bot]'

function Get-Api([string]$path) {
  for ($i = 1; $i -le 12; $i++) {
    $raw = $null
    try { $raw = gh api $path 2>$null } catch { $raw = $null }
    if ($LASTEXITCODE -eq 0 -and $raw) { return (($raw -join "`n") | ConvertFrom-Json) }
    Start-Sleep -Seconds ([math]::Min(2 * $i, 15))
  }
  throw "gh api failed: $path"
}

$rows = @()
for ($n = $From; $n -le $To; $n++) {
  $pr = Get-Api "repos/$repo/pulls/$n"
  if (-not $pr.merged_at) { continue }
  if ([datetimeoffset]::Parse($pr.merged_at) -gt [datetimeoffset]::Parse($MergedBefore)) { continue }
  $revs = @(Get-Api "repos/$repo/pulls/$n/reviews?per_page=100")
  $cms  = @(Get-Api "repos/$repo/issues/$n/comments?per_page=100")
  $tl   = @(Get-Api "repos/$repo/issues/$n/timeline?per_page=100")
  $merge = [datetimeoffset]::Parse($pr.merged_at)
  $pre = @($revs | Where-Object { [datetimeoffset]::Parse($_.submitted_at) -le $merge } |
           Sort-Object { [datetimeoffset]::Parse($_.submitted_at) })
  $last = if ($pre.Count -gt 0) { $pre[-1] } else { $null }
  $gap = $null
  if ($last) {
    $span = $merge.Subtract([datetimeoffset]::Parse($last.submitted_at))
    $gap = [int]$span.TotalSeconds
  }
  $proxySec = @()
  foreach ($c in $cms) {
    if ($c.body -like '*本评论由指挥代贴*') {
      $ps = $merge.Subtract([datetimeoffset]::Parse($c.created_at))
      $proxySec += [int]$ps.TotalSeconds
    }
  }
  $isSelf = $false
  if ($last) { if ($pr.merged_by.login -eq $bot -and $last.user.login -eq $bot) { $isSelf = $true } }
  $ready = @($tl | Where-Object { $_.event -eq 'ready_for_review' } |
             ForEach-Object { $_.actor.login })
  $rows += [pscustomobject]@{
    PR        = $n
    MergedBy  = $pr.merged_by.login
    Review    = if ($last) { "$($last.user.login)/$($last.state)" } else { 'none' }
    GapSec    = $gap
    SelfMerge = $isSelf
    ProxySec  = ($proxySec -join ',')
    ReadyBy   = ($ready -join ',')
  }
}
$rows | Format-Table -AutoSize | Out-String -Width 220
$self = @($rows | Where-Object { $_.SelfMerge })
$gaps = @($self | ForEach-Object { $_.GapSec } | Sort-Object)
$n = $gaps.Count
$half = [math]::Truncate($n / 2)
$median = if ($n % 2 -eq 1) { $gaps[$half] }
          else { ($gaps[$half - 1] + $gaps[$half]) / 2 }
"merged=$($rows.Count) self=$($self.Count) median=${median}s min=$($gaps[0])s max=$($gaps[-1])s"
"ready-by-bot=$(@($rows | Where-Object { $_.ReadyBy.Contains($bot) }).Count)"
```

### 7.3 复跑后应能对上的数

- `merged=27`；`self=16`；`median=34s`；`min=5s`；`max=283s`；`ready-by-bot=11`。
- 表中「否」11 行 = 6 张无 review + 5 张 bot 审、`Sek1ro-oka` 合。
- 若 `gh pr list --state merged` 在 `#1084`–`#1113` 返回的集合不是 27 张，说明区间内有新的合并或回滚，需先更新本页再对比。

### 7.4 本页自身的门禁

本页是纯新增文档（A 档，仅 `docs/verification/**`），在提交 HEAD 上跑过：四连 strict 锚点闸门、`node --test tests/unit/doc-anchor-relocation-identity.test.mjs`、`node tools/verify-contract-status.mjs`、`npm run test:docs`、`node tools/verify-g-drill-readings.mjs --check`、`git merge-tree --write-tree --name-only origin/main HEAD`；结果见对应 PR 描述与提交说明。

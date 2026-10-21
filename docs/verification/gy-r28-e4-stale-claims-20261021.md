# E4：过期口径订正 —— 四片合入后的文档事实对齐（纯文档，零产品代码）

## 0. 本页性质与判定口径

| 项 | 读数 |
| --- | --- |
| 基点 | `ee46eb1`（`feat(privacy): 备份副本 30 日到期清除的驱动者（P0-4 / Refs #19） (#398)`），与 `origin/main` 同点 |
| 分支 | `docs/gy-r28-e4-stale-claims`（worktree `E:\GengYunCommander\wt-e4-doc-truth`）；**未 push、未开 PR** |
| 覆盖 issue | #16、#17、#19（主）；#12、#28 只做口径对齐，不改判 |
| 是否改代码 | **否**。改动面 = 5 个既有 Markdown + 本页：`README.md`、`docs/development-progress.md`、`docs/verification/gy-i16-i17-deletion-cascade-20261021.md`、`docs/verification/gy-i28-unified-states-20261021.md`、`docs/verification/gy-i19-backup-purge-driver-20261021.md`（后者只加 superseded 注）。**未改**任何 `.ts`／`.js`／`.mjs`／`.sql`、`packages/contracts/openapi.json`、`docs/architecture/contract-status.json`（含其生成区 `contract-implementation-status.md`），也**没有**跑 `--write-doc` |
| 计数时点 | `gh` 与 `git` 实跑时刻 **2026-10-21T14:56:42Z**（本地 `2026-10-21 22:56:42 +08:00`）；读数：开放 issue 24／已关闭 issue 3／累计合入 PR 312／在飞 PR 3（`#400`、`#399` 非草稿、`#324` 草稿，均 `MERGEABLE`）／`git rev-list --count HEAD` 366／迁移 26 个（最大 `0026_speech_persistence.sql`）／`HEAD` = `ee46eb1dc2b8a5a57acd9b8905b72863d45cfa4e`。本页、README 表头与 `docs/development-progress.md` 的 2026-10-21 快照用的是同一次读数（本轮核对期间在飞数由 2 增至 3，因为 `#400` 新建；以这次为准） |
| 不做什么 | 不改验收结论：#16／#17 仍记「待前置」、#19 仍记「不可关」，本页**不写**「已验收」「可关闭」。历史页的当时读数不改写，只加 superseded 标注 |

---

## 1. 本片订正清单（逐句）

「改前」为原文逐字，「改后」为本片落地文本（长段落只摘录被替换的句子，完整 diff 见 `git diff`）。

### 1.1 `docs/verification/gy-i16-i17-deletion-cascade-20261021.md`（B4 勘察页）

- **顶部新增**「状态更新（后续合入）」块，逐条指向新证据页；原文一字未删，只在 §1／§3／§4／§4.1／§5／§7／§8 各加一行 superseded 标注指回该块。
- 被推翻的四条（改前 → 改后）：

| # | 位置 | 改前（原文逐字摘录） | 改后事实（依据） |
| --- | --- | --- | --- |
| 1 | §4 表「scope 闭集」行、§5 G8、§7 P0-2 | 「**只有 `favorite`、`history`**」／「messages/conversations/community **没有副本清单行**」 | 四域：`packages/privacy/backup-copies.mjs:42-47` 现为 `favorites: 'favorite'`、`history: 'history'`、`messages: 'message'`、`conversations: 'conversation'`；四域 store 都有 `snapshotOwner`（`messages/store-pg.ts:341`、`conversations/store-pg.ts:445`），清单来源 `services/api/src/privacy/user-data-deletion.ts:320-326` 已列四对。真库臂 `tests/integration/backup-purge-pg.mjs:397-465` 判「四域清单行齐 ⇒ 整体 `completed`」。**社区域仍无 scope**（G7 未变） |
| 2 | §4.1 第 1 条、§5 G9、§7 P0-4 | 「**无**。全仓 `services/api/src` 无 `setInterval`／调度器／worker」／「形态（进程内定时 vs 运维手工 vs 外部 cron 调受保护端点）需指挥定」 | 形态已定为**运维命令**：`tools/purge-expired-backup-copies.mjs` + `services/api/src/privacy/backup-purge-driver.ts`，见 `docs/verification/gy-i19-backup-purge-driver-20261021.md`。「本仓仍零 `setInterval`」这一读数**仍然成立**（驱动刻意不搞常驻定时器），但「无到期驱动者」已不成立 |
| 3 | §5 G1／G2／G3、§7 P0-1 | 「消息域**没有按主体清理原语**」／「消息幂等台账**无按主体清理**」 | 已补（#390／#397）：`messages/store.ts:104,105,313,318` 与 `messages/store-pg.ts:430,437` 的 `deleteAllByOwner`／`purgeOwnerData`，同一事务内 `DELETE FROM public.messages WHERE owner_id = $1::uuid RETURNING id`（`:230`）＋ 按 scope 前缀删 `public.idempotency_keys`（`:234`） |
| 4 | §5 G5／G6、§7 P0-3 | 「会话域注销协调器**已建未驱动**」 | 已按 P0-3 的**路径①**落地（#397）：`conversations` 进 `USER_DATA_DELETION_MODULES`（`user-data-deletion.ts:93-98` 四域）并注册（`:454`），备份清单亦有 `snapshotOwner`（`conversations/store-pg.ts:445`） |

- **仍然有效、本片不动**的条目：G4（`0019` 迁移注释）／G7（社区域无原语、无 scope）／G10（`real` 注销 HTTP 面整域 503，`app.ts:1775-1783`）／G11（审计与回执台账仍在进程内，`user-data-deletion.ts:301`）；§4.1 第 2 条「再受理被 `G0003` 拒」（`0016:112-114`）也未变。
- **口径澄清（G10 旁）**：`real` 模式的「整域 503」只对**注销 HTTP 面**成立。**消息域**的现行口径是 `real` + 有连接池 ⇒ 接 PG（`services/api/src/app.ts:752-772`：`pool === null` 才把服务置 `null` ⇒ 503），与 `docs/architecture/contract-implementation-status.md` 的 `listMessages` 行「`real` 且无连接池 ⇒ 整域 503，`real` + 池 ⇒ 迁移 `0019` 与 `store-pg.ts`」一致。任何把「real 模式消息域整域 503」写成无条件的句子都是过期口径。

### 1.2 `README.md`

- 标题：「## 当前进度（2026-10-20）」→「## 当前进度（2026-10-21）」。
- 表头读数（基线 + 计数）：
  - 改前：「本轮实测 `main` 基线 `4122976`（`412297636141562653ecbaa6b3fbbfecb05ecdd4`，提交时间 2026-10-20 12:11:28 +0000）：开放 issue 24 项、已关闭 3 项（#1、#2、#3）、累计合入 PR 242 条、在飞 PR 2 条（#324 为草稿、#328 非草稿…）」
  - 改后：基线 `ee46eb1`（`ee46eb1dc2b8a5a57acd9b8905b72863d45cfa4e`）＋ `gh` 实跑时点 2026-10-21T14:56:42Z ＋ 开放 24／已关闭 3／累计合入 PR 312／在飞 3（#400、#399 非草稿 `MERGEABLE`、#324 草稿 `MERGEABLE`）。
- `#16` 行「工程缺口」：补记两件**已达成**但漏记的事实——收藏/历史在注销链里是**真删**；注销清理闭集已扩到四域、真库臂「四域齐 ⇒ `completed`」。真机页面证据仍缺，`AC 判定` 列不动（仍「待前置」）。
- `#17` 行「工程缺口」：把「PG 注销清理…待验收」拆成事实与缺口两截——消息域清理原语与闭集已补（#390／#397），并有 PGlite 真表断言；**真 PG17 上的行数读数未取得**，故仍不写「注销清理已验收」。
- `#19` 行「工程缺口」：
  - 删掉与实现相反的「仍缺…「受理同一事务撤会话」」——`0016_account_deletion_persistence.sql:132-134` 就在**同一事务**里撤销该用户全部活跃会话。
  - 「仍缺 7／30 日到期的**真实执行**」改为「备份 30 日到期清除现有**可重复执行的驱动**（#398，运维命令 + 真库 14 臂，非定时器）」，并保留「真实 cron／CVM 读数未取得」「7 日在线的真实时钟执行未取得」「第三方删除证据未取得」。
  - 末尾关于台账 `:419`／`:464` 的滞后描述保留，并补一句：该台账行（`requestAccountDeletion`）在 `#397`／`#398` 后仍写着「到期清除的唯一触发者是「请求重放」，无到期枚举器、无维护端点」，属**台账滞后**（生成区，本片不改）。
- 表下「在飞 PR 与迁移号」段：`#328` 已于 2026-10-20T13:26:02Z 合入（不再是在飞）；迁移数 24 → **26**、最大号 `0024_ocr_persistence.sql` → `0026_speech_persistence.sql`；补记 2026-10-21 合入批次 `#389`～`#399`。
- 表下新增一段**行号锚点漂移提示**：README 表「依据」列引用的 `contract-status.json` 行号是各轮各自的读数，`#362`／`#369` 等台账扩写已把它们整体推后（实测：`requestAccountDeletion` 现 `:410`、`createOCR` 现 `:913`、`listPosts` 现 `:1344`、`listMessages` 现 `:1915`、`listAdminUsers` 现 `:2795`）。本片只订正`#16`／`#17`／`#19` 三行里点到的锚点，其余留给后续片（登记见 §2 R5）。

### 1.3 `docs/development-progress.md`

新增「2026-10-21 快照」一节（按该文件「更新时另起快照、不改本节」的规则，**不改** 10-20 与 10-18 两节原文）：
`gh`／`git` 实跑计数表（同 §0 时点）、自 `4122976` 起 70 个提交（`git rev-list --count 4122976..HEAD`=70）、契约门禁原样输出、`#19`／`#16`／`#17` 的同类过期表述订正、「仍未取得的主干」四类不变、台账滞后清单按现状重列。

### 1.4 `docs/verification/gy-i28-unified-states-20261021.md`

- 403 边界注记（#396 已加）**结论准确**，只订正一处指代：改前「`SESSION_LOSS_CODES` 与 `FORBIDDEN_CODES` 均由**本文件**的 `CODE_KIND` 反推」→ 改后明确写成「均由 `miniprogram/utils/states.js` 的 `CODE_KIND` 反推」——`CODE_KIND` 在代码里（`miniprogram/utils/auth.js:61-67` 现按 `states.CODE_KIND` 过滤生成两个闭集），不在任何一页文档里。其余（7 个适配层曾先 `clearSession` 再改写成 `SESSION_REQUIRED`、已由 `auth.attribution`／`auth.failureFor` 收敛、9 个适配层委托）经复核**属实**。

### 1.5 `docs/verification/gy-i19-backup-purge-driver-20261021.md`（只加 superseded 注，原文一字未改）

在该页 §8 表格之后加「状态更新（后续，2026-10-21 补注；上表原文不改）」块，覆盖两处：

- **D1 已按「建议接」落实**：另有在飞 PR（分支 `test/gy-r28-e5-backup-driver-ci`，**PR #400，尚未合入**）把
  `tests/integration/backup-copies-purge-pg.mjs` 接进 `.github/workflows/real-pg-integration.yml`（受管脚本第 14 条，自起集群形态）。
  该页 D1 行仍写「本片红线禁止改 workflows ⇒ 未接线」——那只是该片当时的状态；**未合入前也不得记作「已接线」**。
- **§1 第 ③ 条与 §7「消息域／会话域／社群域的副本行」的读数已过期**：`#397` 已把 `BACKUP_COPY_SCOPES` 扩到四域
  （`packages/privacy/backup-copies.mjs:42-47`），消息域与会话域都有副本清单行，只有社群域仍无 scope。
  该页基点为 `3935c55`（早于 #397 合入），故 §1／§7 原文保留为当时读数。

### 1.6 真库 CI 接线口径（README `#10` 行、README「下一批」第 1 条、`development-progress.md` 10-20 节第 127 行）

- 改前（README `#10` 行逐字摘录）：「`real-pg-integration.yml` 现跑 7 条…`git grep -n ocr-jobs-pg -- .github/workflows` 仍零命中；另两条也未接——`account-suspend-pg.mjs` 是脚本自身缺陷（SCRAM 口令 28P01／角色已存在 42710），`backup-purge-pg.mjs` 需服务端 `initdb` 起第二集群、CI 的 runner 与容器不共享该二进制，故均如实判不可接。」
- 改后：现跑 **13 条受管脚本**（12 条 `-pg` ＋ `recognition-chain-e2e.mjs`；`git grep -c 'node tests/integration/' -- .github/workflows/real-pg-integration.yml`=13）。逐条来源：
  `ocr-jobs-pg.mjs` ← `#331`（第 8 条）、`recognitions-pg.mjs` ← `#349`、`account-suspend-pg.mjs` ← `#353`（脚本缺陷已修）、
  `speech-pg.mjs` ← `#354`、`backup-purge-pg.mjs` ← `#360`（PGDG apt 装 `postgresql-17` 取 `initdb`/`pg_ctl`，故「不共享该二进制」的判断过期）、
  `recognition-chain-e2e.mjs` ← `#375`（第 13 条）。另有在飞 PR #400 将把 `backup-copies-purge-pg.mjs` 接成第 14 条（**未合入前不记作事实**）。
- `development-progress.md`：按该文件自己的规则**不改 10-20 节读数**，改为在 10-20 节末加一行指路 + 新增「2026-10-21 快照」逐条订正。

---

## 2. 本轮发现但不由本片改的过期点（后续片登记）

| 编号 | 位置 | 现措辞／现状 | 为何本片不改 | 建议处理 |
| --- | --- | --- | --- | --- |
| **R1** | `docs/verification/gy-i19-backup-purge-driver-20261021.md` §1 第 ③ 条、§7「消息域/会话域/社群域的副本行」 | 仍写「闭集只有 `favorite`/`history`」「这些域**没有副本清单行**」 | 该页是另一片（#398）的读数页，基点为 `3935c55`（早于 #397）；按纪律不改写别人的实测原文 | **本轮已在该页 §8 之后加 superseded 注**（见 §1.5），原文未动 ⇒ 无需后续片重复处理 |
| **R2** | `docs/verification/gy-r28-c5-favorites-history-20261021.md` 5.1 | 自持 `FORBIDDEN_CODES`／`forbiddenOrSessionLoss` 的实现形态 | **已由 #396 加 superseded 边界并给出口径**，本片复核确认有效 | 无需处理；登记以免后续片重复订正 |
| **R3** | `docs/architecture/contract-implementation-status.md`（**生成区**）`requestAccountDeletion` 行 | 仍写「到期清除的唯一触发者是「请求重放」，无到期枚举器、无维护端点，requestId 须由片外 driver 提供」 | 生成区只能经 `node tools/verify-contract-status.mjs --write-doc` 改；文案源在 `docs/architecture/contract-status.json`，本片红线禁改 | 后续片先改 JSON 的 blocker 文案（补 `#397` 四域与 `#398` 驱动），再 `--write-doc` |
| **R4** | 同上，`listMessages`／`getUnreadCount`／`markMessageRead` 行 | 仍写「PG/注销及页面/Android仍待验收」 | 同 R3（生成区） | 同 R3：把「注销」一截改成「消息域注销清理已补并进闭集（#390／#397），真 PG17 行数读数未取得」 |
| **R5** | `README.md` 表「依据」列的 `contract-status.json` 行号（`#4` `:46`、`#7` `:649`／`:668`、`#9` `:777`、`#12` `:1061`、`#13` `:1041`、`#15` `:1261`、`#18` `:2578-2604`、`#22`、`#29` 等） | 全部为旧轮读数；台账经 `#362`／`#369`／`#344`／`#356` 扩写后整体漂移（实测：`createOCR` 913、`createSynthesis` 1111、`createConversation` 1133、`listPosts` 1344、`listMessages` 1915、`listAdminUsers` 2795） | 24 行 × 多处锚点重测属独立一片的体量；本片只动 `#10`／`#16`／`#17`／`#19` 四行 | 单开「台账锚点全表重测」片：逐行 `grep -n '"id": "<operationId>"'` 重锚，或改用 operationId 取代行号 |
| **R6** | `docs/development-progress.md` 顶部「已合组件与剩余验收」表（2026-10-14 段，`问答／社区／消息／后台` 行） | 「消息只服务进程内存储、real持久存储未接线」「社区real模式整域503 `PROVIDER_UNAVAILABLE`、**真实持久存储未交付**」 | 该表属 2026-10-14 历史段，文件自身规则是「更新时另起快照、不改本节」 | 与 R5 一并处理，或在下一份快照里明写「顶表为 10-14 读数」 |
| **R7** | `docs/verification/gy-i17-messages-pg-20261018.md:34`、`docs/verification/gy-i16-favorites-history-20261014.md:14`／`:330`／`:391`／`:414` | 同类「real 整域 503／无注销清理」旧口径 | 历史页按仓内惯例不改写当时读数 | 由涉及该域的下一个片统一加 superseded 头注 |
| **R8** | `#399`（D4，消息域三处修复 + 401/403 收敛）与 `#400`（E5，把 `backup-copies-purge-pg.mjs` 接进真库 CI） | **均在飞**（#399 于 2026-10-21T14:47:52Z 实测为非草稿 `MERGEABLE`；#400 分支 `test/gy-r28-e5-backup-driver-ci`）；#399 的证据页 `docs/verification/gy-i15-messages-chain-20261021.md` **未进 main** | 未合入 PR 的结论不当作既成事实；本页因此**不引用**它们的读数，口径一律以 main 代码与 workflow 为准 | 合入后由各自片核对 README／B4 页／E2 页的引用是否需要再订正 |
| **R9** | `docs/verification/gy-i16-i17-deletion-cascade-20261021.md` §10「未取得」 | 仍写「`messages` 真库注销臂：不存在（本片未实现 G1–G3）」 | 属该页当时读数；本片已在页首状态块与 §1／§3／§4／§4.1／§5／§7／§8／§9／§10 加 superseded 标注，不改原文 | 无需后续片单列 |
| **R10** | `docs/verification/gy-i19-backup-purge-driver-20261021.md` §8 D1 与 §7「未取得」 | 仍写「本片红线禁止改 workflows ⇒ 未接线」「闭集仍只有 `favorite`/`history`」 | 同为 #398 的实测页；不改原文 | **本轮已加 superseded 注**（§1.5）；E5 #400 合入后由该片自行改「已接线」 |

---

## 3. 复现命令（全部只读）

```powershell
# 1) 闭集已是四域（预期：favorites/history/messages/conversations）
Select-String -Path services/api/src/privacy/user-data-deletion.ts -Pattern 'USER_DATA_DELETION_MODULES' -Context 0,6

# 2) 备份 scope 四域（预期：favorite/history/message/conversation）
Get-Content packages/privacy/backup-copies.mjs | Select-Object -Skip 41 -First 7

# 3) 消息域清理原语在同一事务内删正文与幂等台账
Select-String -Path services/api/src/messages/store-pg.ts -Pattern 'DELETE FROM public.messages|DELETE FROM public.idempotency_keys'

# 4) 30 日驱动的两个文件存在
Test-Path tools/purge-expired-backup-copies.mjs; Test-Path services/api/src/privacy/backup-purge-driver.ts

# 5) 仍零进程内定时器（预期：仅注释命中）
Select-String -Path services/api/src/**/*.ts -Pattern 'setInterval' | Where-Object { $_.Line -notmatch '^\s*\*' }

# 6) 注销面 real 仍整域 503（预期：accountDeletionWired 由 available 决定）
Select-String -Path services/api/src/app.ts -Pattern 'accountDeletionWired'

# 7) 消息域 real 口径（预期：pool === null 才置 null ⇒ 503）
Get-Content services/api/src/app.ts | Select-Object -Skip 751 -First 22

# 8) 计数（本页读数同一次）
gh issue list --state open --limit 300 --json number
gh pr list --state open --limit 300 --json number,isDraft,mergeable
gh api 'search/issues?q=repo:GengYunChuChao/GengYun+type:pr+is:merged' --jq .total_count
git rev-list --count HEAD
(Get-ChildItem services/api/db/migrations/*.sql).Count
```

---

## 4. 未取得（本页不得据以推断已通过）

- **真 PG17 上的消息域注销行数读数**：`#397` 的行数证据来自 PGlite 真表（`tests/unit/favorites-history-deletion-registration.test.mjs` 注入 `0008`＋`0019`／`0013` 迁移集）与真库臂的清单行，**不是** `messages` 真库注销行数；本片未起 PG，也不改代码，故不产生该读数。
- **30 日到期的真实调度**：驱动是「可被 cron 调用」的形态，仓内无任何调度器接线，真实 30 日墙钟等待未发生（`docs/verification/gy-i19-backup-purge-driver-20261021.md` §7 同结论）。
- **`real` 注销面放开**：仍整域 503（G10／P0-5），本片不动也不建议先放开。
- **#399 的读数**：仍在飞，未合入的结论不作为事实。
- **`backup-copies-purge-pg.mjs` 的 CI 常驻证据**：把它是接进 `real-pg-integration.yml` 的在飞 PR（`#400`／`test/gy-r28-e5-backup-driver-ci`）**尚未合入**，故本页只写「另有在飞 PR 把它接进去」，不写「已接线」；该脚本的 CI 绿读数需等合入后由 CI 运行记录提供。
- 本页所有「已补」「已是四域」均指**代码与断言现状**，不构成 #16／#17／#19 任何一项的验收通过。

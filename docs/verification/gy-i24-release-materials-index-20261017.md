# GY-I24 部署／备份／恢复／回滚材料索引与离线核验（2026-10-17）

- 基线：`upstream/main` = `60aa9ad`（`test(GY-I02): 为调研记录建立机械门禁并把 §4 按项来源接入 CI (#277)`）。
- **刷新记录（2026-10-18）**：本分支原基于 `95b8e7c`（提交 `58fdbfc`）；应指挥派发，已 rebase 到
  `60aa9ad` 并按新基线重跑门禁、刷新全部读数。迁移数在两代基线间由 15 变为 17（见 §5-F1）。
- **并流刷新（2026-10-18，#272）**：`feat/gy-i16-favorites-history-pg` 以 `git merge --no-ff upstream/main`
  并入 `53922eb`（含上面的 `0017_account_suspend_authority.sql`），叠加本片的 `0018_favorites_history.sql`
  ⇒ 迁移数 **18**（`0001..0018`）、`rollback/` **17**（`0002..0018`）、`deploy/` 在册仍 **29**；
  §2 表与 §4 第 8 项的「当前读数」已按本分支实测改写（`60aa9ad` 时代的历史读数按原样保留）。
- **合流复核（2026-10-18，PR #278）**：再合流 `upstream/main` = `0856e49` 后，本片 `2f0946b`（消息域持久化）带入
  `0019_messages_persistence.sql` 及其 down 脚本 ⇒ 迁移数 **19**（`0001..0019`）、`rollback/` **18**（`0002..0019`）、
  `deploy/` 在册 **30**；§2 表与 §4 第 8 项的「当前读数」已按合流后的树实测同步（上面那条的 18/17/29 是 `53922eb` 时点的读数，按原样保留）。
- **合流波刷新（2026-10-19，GY-I19/#19 接线片并流）**：本分支叠加 `0023_user_backup_copies.sql` 与其
  `rollback/0023_user_backup_copies.down.sql` ⇒ 迁移数 **20**（`0001..0019` ＋ `0023`）、
  `rollback/` **19**（`0002..0019` ＋ `0023`，仍无 `0001`）、`deploy/` 在册 **30**；
  `0020`–`0022` 由合流波排在本片之前合入（`#282`／`#279`／`#296`），本片号位因此定 **0023**
  （曾临时用 `0024`，2026-10-19 合流波改回），断号原因写在
  `services/api/db/migrations/0023_user_backup_copies.sql` 头注释，⛔ 不造占位迁移；
  §2 表与 §4 第 8 项的「当前读数」按本次实测改写（此前 19/18 的读数作为历史保留）。
- **并流刷新二（2026-10-18，#15 社区域 PG 持久化落地后）**：`feat/gy-i15-community-pg` 新增 `0022_community_persistence.sql`
  ＋ `rollback/0022_community_persistence.down.sql` ⇒ 该片自身树上迁移数 **19**（`0001..0018` ＋ `0022`）、
  `rollback/` **18**；**`0020`–`0021` 是有意缺号**（分属 I18 切片，各自分支带自己的迁移号），
  因此这里不能写成连续区间。`deploy/` 在册仍 29（该片分支上未含上游新增件）。⚠️ 这是该片**合流前**的读数，
  当前读数见下一条。
- **合流复核二（2026-10-19，#15 合流 `upstream/main` = `d131e47` 后）**：`0019_messages_persistence.sql`（上游 I17）
  与本片 `0022_community_persistence.sql` 同在树上 ⇒ 迁移数 **20**（`0001..0019` ＋ `0022`）、`rollback/` **19**
  （`0002..0019` ＋ `0022`）、`deploy/` 在册 **30**；**`0020`–`0021` 仍是有意缺号**（分属 I18 切片 #282／#279，
  各自分支带自己的迁移号），故计数只能逐名对应、不能写成连续区间。§2 表行与 §4 第 8 项读数已按合流后的树同步。
- **三次并流（2026-10-19，#282）**：`feat/gy-i18-feature-flags-pg` 先于 `0856e49` 上并流、带入 `0020_feature_flags.sql`
  及其 down 脚本（当时 `0019` 在途 ⇒ 19 个：`0001..0018`＋`0020`）；本次再 `git merge --no-ff upstream/main`
  = `d131e47`（含 `0019_messages_persistence.sql`）⇒ 迁移数 **20**（`0001..0020`，连续无缺号）、`rollback/` **19**
  （`0002..0020`）、`deploy/` 在册仍 **30**；§2 表与 §4 第 8 项的「当前读数」已按合并后的树实测改写（上面三代读数按原样保留为历史）。
- **合流复核（2026-10-19，main `31a746d`，PR #304）**：`test/gy-recog-chain-e2e` 以 `git merge --no-ff upstream/main` 合流
  `31a746d676975cf41e995b0641ff9999f9def705`（含 #282／#305／#306／#307／#308 五张 squash）后，按本树实测复核：
  迁移 **20** 个（`0001..0020`，连续无缺号）、`rollback/` **19**（`0002..0020`）、`deploy/` 在册 **30**，与上一条「三次并流」
  **逐项一致**；合流前的旧值（本分支树 `2bcf635`）为 **19／18／30** —— PR #304 只做识别链端到端验收、**不带迁移**，
  `0020_feature_flags.sql` 及其 down 脚本是原样取自上游。§2 表与 §4 第 8 项的「当前读数」无需再改。
- **合流复核（2026-10-19，main `31a746d`）**：本分支再 `git merge upstream/main` = `31a746d`
  （含 `0020_feature_flags.sql` 及其 down 脚本与 `#305`／`#306`／`#307`／`#308` 四张 squash）⇒ 本片 `0023` 与
  `0020` 并存：迁移数 **21**（`0001..0020` ＋ `0023`）、`rollback/` **20**（`0002..0020` ＋ `0023`，仍无 `0001`）、
  `deploy/` 在册 **30**；`0021`／`0022` 仍由合流波在途片（`#279`／`#296`）占用 ⇒ 合流后**仍缺号**，
  ⛔ 不改号、⛔ 不造占位迁移（`tests/integration/migrations-negative-pg.mjs` 的号段断言因此照旧转红，原样登记）；
  上面两条的 20/19 与 20/19 分别是合流前 `c6baf86` 与 `d131e47` 时点的读数，按原样保留为历史；
  §2 表与 §4 第 8 项的「当前读数」已按本次合流复核后的树实测改写。
- **合流复核三（2026-10-19，#15 合流 `upstream/main` = `31a746d` 后）**：上游 I18 的 `0020_feature_flags.sql`
  已随 `31a746d` 进入本片树，与本片 `0022_community_persistence.sql` 并存 ⇒ 迁移数 **21**
  （`0001..0020` ＋ `0022`）、`rollback/` **20**（`0002..0020` ＋ `0022`）、`deploy/` 在册 **30**；
  **`0021` 仍是有意缺号**（I18 切片 #279 尚未合入），故计数只能逐名对应、不能写成连续区间。
  合流前的旧读数：本片侧 20/19/30（`d131e47`，见上条「合流复核二」）、上游侧 20/19/30（见「三次并流」）；
  本次 §2 表行与 §4 第 8 项已按合流后的树实测同步。
- **合流复核（2026-10-19，main `31a746d`）**：`feat/gy-i18-admin-accounts-read` 合流新 `upstream/main` = `31a746d`
  （新 main 已含 #282 的 `0020_feature_flags.sql`），叠加本片 `0021_admin_accounts_read.sql` ⇒ 按
  `git ls-tree HEAD -- services/api/db/migrations` 逐条实测：迁移数 **21** 个（`0001..0021`，**连续无缺号**）、
  `rollback/` **20** 个（`0002..0021`，仍无 `0001`）、`deploy/` 在册 **30** 个；§2 表与 §4 第 8 项的「当前读数」
  已按合流后的树刷新。**旧值（并列历史，按原样保留）**：本片在 `d131e47` 上、`0020` 尚未入树时读数为 **20/19**
  （`0001..0019` ＋ `0021`，缺 `0020`）；`feat/gy-i18-feature-flags-pg` 在 `d131e47` 上单独并流时读数同为 **20/19**
  （`0001..0020` 连续）；更早是 #278 时点的 19/18/30 与 `53922eb` 时点的 18/17/29。
- **合流复核（2026-10-19，main `607c03c`，PR #304）**：再 `git merge --no-ff upstream/main` 合流
  `607c03cd0c54508164822cc36640a0ec3675564e`（含 #309／#310／#311／#312 四张 squash；`0021_admin_accounts_read.sql`
  及其 down 脚本由其中一张原样带入）后，按本树 `git ls-tree HEAD` ＋ `git ls-files deploy` 逐条实测：
  迁移 **21** 个（`0001..0021`，**连续无缺号**）、`rollback/` **20** 个（`0002..0021`，仍无 `0001`）、`deploy/` 在册 **30** 个；
  与上一条 i18 合流读数（21／20／30）**逐项一致**。合流前本树（`0371cdc`）为 **20／19／30** —— PR #304 自身不带迁移，
  `0021` 是原样取自上游。§2 表与 §4 第 8 项的「当前读数」据此复核，无需再改。
- **合流复核四（2026-10-19，#15 合流 `upstream/main` = `145ebe4` 后）**：`#279`（`0021_admin_accounts_read.sql`）
  已随 `61e031e` 进入 main，故本片不再叠 PR 分支，改为直接 `git merge --no-ff upstream/main` = `145ebe4`
  （含 I14 的 `#310`、I22 的 `#309`、I18 后台账号目录的 `#311`）⇒ 本片 `0022_community_persistence.sql`
  与 main 的 `0021_admin_accounts_read.sql` 同在一棵树上，按合流后的树逐条实测：迁移数 **22** 个
  （`0001..0022`，**连续无缺号**）、`rollback/` **21** 个（`0002..0022`，仍无 `0001`）、`deploy/` 在册 **30** 个；
  `0021` 的缺号由 main 侧补齐，上面并列的两条 21/20/30 读数（本片侧 `0001..0020` ＋ `0022`、main 侧 `0001..0021`）
  自此只作历史保留。**本行由合流 `upstream/main` 之后的复核更新，旧值＝21/20/30。**
  §2 表行与 §4 第 8 项已按合流后的树实测同步。
- **合流复核五（2026-10-19，main `607c03c`）**：#15 再 `git merge --no-ff upstream/main` = `607c03c`
  （含 `#312` 集成脚本门禁覆盖，以及 I14 的 `#310`、I22 的 `#309`、I18 后台账号目录的 `#311`）——
  上游未带新迁移，本片 `0022_community_persistence.sql` 仍在末位；按合流后的树逐条实测：迁移数 **22** 个
  （`0001..0022`，**连续无缺号**）、`rollback/` **21** 个（`0002..0022`，仍无 `0001`）、`deploy/` 在册 **30** 个，
  §2 表与 §4 第 8 项读数不变（旧值＝22/21/30，无回退）。同轮按 `#312`「跳过即未取得」口径修正本分支自有脚本
  `tests/integration/community-pg.mjs`：缺 `COMMUNITY_PG_TEST_URL` 时由 `exit 0` 改为 `exit 77`
  （`--allow-skip`／`GY_ALLOW_SKIP=1` 才显式取 0），SKIP 判定条件与断言未改。
- **合流复核六（2026-10-20，main `df043a7`，PR #304）**：`test/gy-recog-chain-e2e` 再 `git merge --no-ff upstream/main` 合流
  `df043a715e691019e14373181249a5cf51ec9da9`（含 `#296` 社区域 PG 持久化带入的 `0022_community_persistence.sql` 及其 down 脚本、
  `#313` I12 会话链真库证据带入的 `tests/integration/conversations-pg.mjs` 与 `test:integration:conversations-pg` 脚本）后，
  按**合流后的树**逐条实测：迁移 **22** 个（`0001..0022`，**连续无缺号**）、`rollback/` **21** 个（`0002..0022`，仍无 `0001`）、
  `deploy/` 在册 **30** 个 —— 与上条「合流复核五」**逐项一致**。本片（PR #304）只做识别入口链路端到端验收、**自身 0 迁移**，
  `0022` 及其 down 脚本是原样取自上游 `#296`；合流前本分支树（`89be8be`）为 **21／20／30**。
  §2 表行与 §4 第 8 项的「当前读数」已按本次合流后的树复核（数值不变，只刷新绑定树）。
- **合流复核六（2026-10-19，#296 侧合流 main `607c03c`）**：#15 在其树上再 `git merge --no-ff upstream/main`
  = `607c03c`（含 `#312` 集成脚本门禁覆盖，以及 I14 的 `#310`、I22 的 `#309`、I18 后台账号目录的 `#311`）——
  上游未带新迁移，`0022_community_persistence.sql` 仍在末位；按合流后的树逐条实测：迁移数 **22** 个
  （`0001..0022`，**连续无缺号**）、`rollback/` **21** 个（`0002..0022`，仍无 `0001`）、`deploy/` 在册 **30** 个，
  §2 表与 §4 第 8 项读数不变（旧值＝22/21/30，无回退）。同轮按 `#312`「跳过即未取得」口径修正
  `tests/integration/community-pg.mjs`：缺 `COMMUNITY_PG_TEST_URL` 时由 `exit 0` 改为 `exit 77`
  （`--allow-skip`／`GY_ALLOW_SKIP=1` 才显式取 0），SKIP 判定条件与断言未改；#296 新 head `71eda51` 即在此之后。
- **合流复核五（2026-10-19，#19 叠在 #296 之上）**：本分支 `git merge --no-ff` #296 的新 head
  （`71eda51`，它已先直接合流 main `607c03c`；本片上一版叠的是 #296 旧 head `a6e3101`）之后，
  `0021_admin_accounts_read.sql`／`0022_community_persistence.sql`／本片 `0023_user_backup_copies.sql`
  三者同在一棵树上 ⇒ 按合流后的树逐条实测：迁移数 **23** 个（`0001..0023`，**连续无缺号**）、
  `rollback/` **22** 个（`0002..0023`，仍无 `0001`）、`deploy/` 在册 **30** 个；
  本片树此前两处缺号（`0021`／`0022`）由本次叠放一次补齐。
  **本行由叠在 #296 新 head 之上的合流复核更新，旧值＝21/20/30（本片树）／22/21/30（#296 旧 head `a6e3101` 侧）。**
  §2 表行与 §4 第 8 项已按合流后的树实测同步。同轮按 `#312`「跳过即未取得」口径修正本分支自有脚本
  `tests/integration/backup-purge-pg.mjs`：缺 `GY_PG_BIN` 时由 `exit 0` 改为 `exit 77`
  （`--allow-skip`／`GY_ALLOW_SKIP=1` 才显式取 0），SKIP 判定条件与全部断言未改。
  本轮真库臂在本机原生 PG 17.11 上实测 `PASS 1 … PASS 13`（`RESULT=PASS 13 组`，自起自停临时集群、仅回环，收尾 `CLEANUP=done`）；
  `migrations-negative-pg` 实测 `PASS 1 … PASS 11`（`ALL 11 … passed against native PG17.11`）；全量单测 `tests 1876 / pass 1875 / fail 0 / skipped 1`。
- **合流复核七（2026-10-20，#19 再合流 `upstream/main`）**：本分支 `git merge --no-ff upstream/main` ＝
  `df043a7`（`test(GY-I12): 会话链真库 17.11 端到端证据…(#313)`）之后实测：上游未带新迁移
  （`#296` 的 `0022_community_persistence.sql` 已随上一轮叠放进入本片树，本次**无净变化**），本片
  `0023_user_backup_copies.sql` 仍在末位；本次净新增为 I12 的 `tests/integration/conversations-pg.mjs`、
  `package.json` 的 `test:integration:conversations-pg` 脚本条目，以及
  `tests/unit/ci-integration-chain-structure.test.mjs` 里 `UNWIRED_DECLARATIONS` 新增的一条登记行
  （`FROZEN_CHAIN` 与既有断言未动，`test:integration:http` 链成员与条数未变）。
  按合流后的树逐条实测（`git ls-files`）：迁移数 **23** 个（`0001..0023`，**连续无缺号**）、
  `rollback/` **22** 个（`0002..0023`，仍无 `0001`）、`deploy/` 在册 **30** 个；
  `0020`／`0021`／`0022` 已分别随 `#282`／`#279`／`#296` 落在 main ⇒ **main（`df043a7`）侧**当前迁移
  **22** 个（`0001..0022`，连续无缺号）、`rollback/` **21** 个；**本 PR 树侧**迁移 **23** 个
  （`0001..0023`，连续无缺号）、`rollback/` **22** 个。本片 `0023_user_backup_copies.sql` 仍**只在本分支树上、
  尚未合入 main** ⇒ 本索引不据此声称任何「已合入」或「已部署」；合入后 main 的号段才会首次连续到 `0023`
  （本树侧已连续，故上一轮登记的「号段红」在本片落 main 后才有条件在 main 侧转绿，本片不改号、不造占位迁移）。
  **本行由 2026-10-20 合流复核更新，旧值＝23/22/30（叠 #296 新 head `71eda51` 时点，读数与本次相同）。**
  §2 表行与 §4 第 8 项已按合流后的树实测同步。
- **合流复核九（2026-10-20，`upstream/main` = `ff1b39d`）**：`test/gy-recog-chain-e2e` 再 `git merge --no-ff upstream/main` 合流
  `ff1b39d4ee27347d9e5e4ec012c9f6f65a84664a`（`feat(GY-I19): 备份副本域设计与真接线（迁移 0023）（Refs #19） (#295)`）：上游把 `0023_user_backup_copies.sql`
  与其 `rollback/0023_user_backup_copies.down.sql` 带入 main，本次合流原样带入本树 ⇒ 合并后仅一份、**无号段竞争、无改号**（本片自身 **0 迁移**，
  合流前本树为 **22／21／30**、main `df043a7` 侧同为 **22／21**）。按**合流后的树**逐条实测（`git ls-files`）：迁移 **23** 个
  （`0001..0023`，**连续无缺号**）、`rollback/` **22** 个（`0002..0023`，仍无 `0001`）、`deploy/` 在册 **30** 个 ⇒ 读数由 22／21／30 变为 **23／22／30**；
  同时 `0023` **首次落在 main**（main 侧号段首次连续到 `0023`），本索引自此不再称其「只在本分支树上」。
  §2 表行与 §4 第 8 项的「当前读数」已按本次合流后的树实测同步。
  （编号沿革：合流后树内既有段最高编号为上游侧的「合流复核七」；本段沿用派单指定名「合流复核九」，未新造「八」。）
- **本片新增迁移（2026-10-20，GY-R27 S10，#10 OCR 持久化）**：`feat/gy-r27-ocr-persist`（基线 `upstream/main` = `13dd429`）
  新增 `0024_ocr_persistence.sql` 与其 `rollback/0024_ocr_persistence.down.sql`（迁移号由指挥在
  `.pg17/ruling-migration-order-20261019.md` 分配并登记，**未改号、未造占位迁移**）⇒ 按本树实测：
  迁移 **24** 个（`0001..0024`，**连续无缺号**）、`rollback/` **23** 个（`0002..0024`，仍无 `0001`）、
  `deploy/` 在册 **30** 个 ⇒ 读数由 23／22／30 变为 **24／23／30**。§2 表行与 §4 第 8 项的「当前读数」已按本树同步。
- **本片新增迁移（2026-10-20，GY-R28 S13，#9 识别域持久化）**：`feat/gy-r28-recognitions-persist`
  （基线 `upstream/main` = `1794052`，已含 `#323` 的 `0024_ocr_persistence.sql`）新增
  `0025_recognitions_persistence.sql` 与其 `rollback/0025_recognitions_persistence.down.sql`（迁移号按派单分配，
  **未改号、未造占位迁移**）⇒ 按本树实测：迁移 **25** 个（`0001..0025`，**连续无缺号**）、
  `rollback/` 24 个（`0002..0025`，仍无 `0001`）、`deploy/` 在册 **30** 个 ⇒ 读数由 24／23／30 变为 **25／24／30**。
  §2 表行与 §4 第 8 项的「当前读数」已按本树同步。该迁移与 `0024` 的两处刻意差异写在其头注释：
  `state` 直接引用 `0001:211` 的 `job_state` 枚举（同库**首次跨域复用**：`0013:70-71`／`0018:87`／`0024:93`
  都是 `varchar`/`text + CHECK`，取「不为记录形状另绑枚举」；本片只是复用既有类型，不重建同义类型），
  `recognition_jobs.recognition_id` 不设外键（终态记录由 `commitTerminal` 落库，先建后写会产生「合法写入即违反」的约束）。
- **本片新增迁移（2026-10-21，GY-R28 S20，#20 语音持久化）**：`feat/gy-r28-speech-persist`
  （基线 `upstream/main` = `693af5d`，已含 `0025_recognitions_persistence.sql`）新增
  `0026_speech_persistence.sql` 与其 `rollback/0026_speech_persistence.down.sql`（迁移号按派单分配，
  **未改号、未造占位迁移**）⇒ 按本树实测：迁移 **26** 个（`0001..0026`，**连续无缺号**）、
  `rollback/` 25 个（`0002..0026`，仍无 `0001`）、`deploy/` 在册 **31** 个 ⇒ 读数由 25／24／31 变为 **26／25／31**。
  §2 表行与 §4 第 8 项的「当前读数」已按本树同步。该迁移头部如实登记了本片**未**给三张语音表加
  `GRANT`（`deploy/postgres-cvm/**` 一字未改）⇒ 运行时角色直连会 `42501`，授权属后续授权片。
- 分支：`step/gy-i24-release-readiness-20261017`。
- 写手：WorkBuddy Step（本地实现与自检；**未推送、未建 PR、未改 main**）。
- 范围（派单口径）：**整理部署、备份、恢复、回滚材料索引，仅做离线文档核验**。
  ⛔ 本片不部署、不连云、不连库、不购买、不改动他人材料正文；`Refs #24`，不关闭整项 issue。

## 0. 怎么用这份索引

1. **找材料**：按 §1–§4 的表定位到具体文件；每行都标了「离线核验」结果。
2. **复跑核验**：`node tools/verify-release-materials.mjs`（退出码 0 = 通过；判据全是仓库事实，不触云）。
3. **看缺口**：§5 是离线核验**发现**的问题（只报告，不越位改写他人材料）；§6 是离线**核验不了**的项
   （留给运行期／云端，均不在本片范围，不得据本索引推断为已验收）。

## 1. 部署（镜像与平台配置）

| 材料 | 作用 | 离线核验 |
| --- | --- | --- |
| [`../../deploy/README.md`](../../deploy/README.md) | deploy 目录总入口与约定（密钥只走私密渠道、不改契约/数据模型/miniprogram） | ✅ 在册；门禁工具检查其存在与非空 |
| [`../../deploy/cloudrun/README.md`](../../deploy/cloudrun/README.md) | 微信云托管（API）＋上海 CVM（PostgreSQL）Runbook：基线、构建、平台配置、迁移顺序、验收、回滚、未取得项 | ✅ 在册；其「最小验收」依据的 `/health` 形状已对 `services/api/src/routes/health.ts` 实测一致（`status`/`checks.database`/`meta.execution_mode`，200/503） |
| [`../../deploy/cloudrun/service-settings.md`](../../deploy/cloudrun/service-settings.md) | 平台字段与依据、健康检查语义、环境变量/机密清单、官方链接、运行时 import 闭包 | ✅ 在册；其环境变量清单与 `deploy/cloudrun/env.placeholder.json`、`services/api/src/config.ts` 的口径已交叉核对（见 §3 第 4 项） |
| [`../../deploy/cloudrun/Dockerfile`](../../deploy/cloudrun/Dockerfile) | API 镜像（Node 24.16.0、`npm ci --omit=dev`、非 root、SIGTERM 优雅退出） | ✅ 在册；镜像 Node 版本与根 `package.json` 的 `engines.node`（`>=24.16.0 <25`）逐位一致；**镜像构建本身需 Docker，属运行期，未核验** |
| [`../../deploy/cloudrun/Dockerfile.dockerignore`](../../deploy/cloudrun/Dockerfile.dockerignore) | 与 Dockerfile 配套的构建忽略清单 | ✅ 在册 |
| [`../../deploy/cloudrun/env.placeholder.json`](../../deploy/cloudrun/env.placeholder.json) | 平台「环境变量 JSON 导入」模板（全部空值/非机密） | ✅ 在册；**键集 ⊇ 配置面且无多余键、机密类键全部为空值**（门禁第 5 项）。本片刷新时按新基线配置面补入 `MEDIA_ACCESS_GRANT_ORIGIN`（可选键，见 §5-F4） |
| [`../../deploy/cloudrun/container.config.json.example`](../../deploy/cloudrun/container.config.json.example) | 官方模板 `container.config.json` 字段对照（本路线不使用该文件） | ✅ 在册 |
| [`../../deploy/cloudrun/local-check.ps1`](../../deploy/cloudrun/local-check.ps1) | 本地自检：构建镜像 + 容器内 `/health`（需本机 Docker） | ✅ 在册；**执行需 Docker，属运行期，未核验** |
| [`../../deploy/cloudrun-vpc/README.md`](../../deploy/cloudrun-vpc/README.md) | 云托管关联腾讯云账号与 VPC 互联：事实分级、判定框架、只读实测摘要 | ✅ 在册 |
| [`../../deploy/cloudrun-vpc/connection-verification-prep.md`](../../deploy/cloudrun-vpc/connection-verification-prep.md) | 连通性验证准备（探针与判读） | ✅ 在册 |
| [`../../deploy/cloudrun-vpc/user-console-actions.md`](../../deploy/cloudrun-vpc/user-console-actions.md) | 仅用户本人可在控制台完成的动作清单 | ✅ 在册 |
| [`../../deploy/cloudrun-vpc/verify-vpc-linkage.md`](../../deploy/cloudrun-vpc/verify-vpc-linkage.md) | VPC 连通核验步骤与判据 | ✅ 在册 |

## 2. 数据库（目标 CVM 上的 PostgreSQL 17）

| 材料 | 作用 | 离线核验 |
| --- | --- | --- |
| [`../../deploy/postgres-cvm/README.md`](../../deploy/postgres-cvm/README.md) | 技术准备物总览：账号边界（子账号 S ≠ 父账号 P）、目标形态（路径 A 已选）、授权门禁、目录内容 | ✅ 在册 |
| [`../../deploy/postgres-cvm/runbook.md`](../../deploy/postgres-cvm/runbook.md) | **主操作手册**：安装→迁移→角色→备份恢复→启动 API→日常运维→回滚→故障速查 | ✅ 在册；其引用的脚本/配置文件全部存在（门禁第 2 项）；§5.4 的迁移数量读数**已过期**，见 §5-F1 |
| [`../../deploy/postgres-cvm/roles-and-migration.md`](../../deploy/postgres-cvm/roles-and-migration.md) | 最小权限角色清单、迁移执行顺序与幂等语义 | ✅ 在册；其中「10 个版本」读数**已过期**，见 §5-F1 |
| [`../../deploy/postgres-cvm/verify-checklist.md`](../../deploy/postgres-cvm/verify-checklist.md) | 资源就绪后逐条执行的验证清单（含明确不覆盖项） | ✅ 在册 |
| [`../../deploy/postgres-cvm/verify-socket-only-equivalents.md`](../../deploy/postgres-cvm/verify-socket-only-equivalents.md) | 仅套接字等价环境的复核口径 | ✅ 在册 |
| [`../../deploy/postgres-cvm/install-postgres.sh`](../../deploy/postgres-cvm/install-postgres.sh) | 安装与初始化（`--plan` 干跑、网段断言、权限收敛） | ✅ `bash -n`、`set -euo pipefail`、blob 为 LF（门禁第 4 项） |
| [`../../deploy/postgres-cvm/provision-db.sh`](../../deploy/postgres-cvm/provision-db.sh) | 角色引导与最小权限断言（幂等、默认不轮换口令） | ✅ 同上三件套 |
| [`../../deploy/postgres-cvm/backup-postgres.sh`](../../deploy/postgres-cvm/backup-postgres.sh) | 备份（pg_dump + 可读性校验 + 清单 + 保留期清理） | ✅ 同上三件套 |
| [`../../deploy/postgres-cvm/restore-drill.sh`](../../deploy/postgres-cvm/restore-drill.sh) | 恢复演练（隔离库重建，逐项比对） | ✅ 同上三件套 |
| [`../../deploy/postgres-cvm/restore-drill.ps1`](../../deploy/postgres-cvm/restore-drill.ps1) | 本机（Windows ＋ 便携 PG 17.11）的恢复演练脚本：与 `restore-drill.sh` **同五条判据、同退出码语义**（0＝五条全 PASS／1＝有 FAIL／2＝缺清单不算通过）；演练库只在 `drill`/`restore` 命名空间内重建，口令只从文件读 | ✅ 在册；**需本机 PG，属运行期，未在 CVM 上核验**（门禁第 4 项只查 `.sh`，不覆盖本脚本；真跑读数见[证据页](../../docs/verification/gy-i24-restore-drill-local-20261018.md)，**不代表已验收**） |
| [`../../deploy/postgres-cvm/verify-cvm-postgres.sh`](../../deploy/postgres-cvm/verify-cvm-postgres.sh) | 可执行判据一键核验（退出码 0/1/2 语义见 runbook §步骤4） | ✅ 同上三件套 |
| [`../../deploy/postgres-cvm/conf/10-gengyun-postgres.conf`](../../deploy/postgres-cvm/conf/10-gengyun-postgres.conf) | 监听地址/端口等配置模板 | ✅ 在册 |
| [`../../deploy/postgres-cvm/conf/pg_hba.gengyun.conf`](../../deploy/postgres-cvm/conf/pg_hba.gengyun.conf) | 认证规则模板（仅回环 + VPC 私网） | ✅ 在册 |
| [`../../deploy/postgres-cvm/conf/pg_ident.gengyun.conf`](../../deploy/postgres-cvm/conf/pg_ident.gengyun.conf) | 身份映射模板 | ✅ 在册 |
| [`../../deploy/postgres-cvm/conf/gengyun-postgresql.service`](../../deploy/postgres-cvm/conf/gengyun-postgresql.service) | systemd 单元模板 | ✅ 在册 |
| [`../../deploy/postgres-cvm/sql/20-login-roles.sql`](../../deploy/postgres-cvm/sql/20-login-roles.sql) | 登录角色授予 | ✅ 在册 |
| [`../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql`](../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql) | 最小权限断言 | ✅ 在册 |

## 3. 备份／恢复／回滚：证据与判据

| 材料 | 作用 | 离线核验 |
| --- | --- | --- |
| [`../../deploy/postgres-cvm/evidence/local-self-check.md`](../../deploy/postgres-cvm/evidence/local-self-check.md) | 本地自检原始输出（2026-10-13）：环境事实、`bash -n`/`--help`/失败路径自检、真跑记录（`provision-db.sh` exit=0、平台侧连通实测） | ✅ 在册；其「行尾 LF」自检结论已由本片对 **blob** 复验成立（见 §4 第 3 项） |
| [`../../deploy/postgres-cvm/evidence/probe-runtime-grants.sql`](../../deploy/postgres-cvm/evidence/probe-runtime-grants.sql) | 运行时授权探针（2026-10-20，R28-S24 新增）：`SET ROLE gengyun_api_runtime` 后重放 messages/community/ocr 三域的真实语句形态（全部 `WHERE false`、末尾回滚），加 `user_backup_copies`/`feature_flags`/`idempotency_keys` 三个对照臂与全库表级 DML 清单 | ✅ 在册；**本机** PG 17.11 临时集群实跑（改前 31 条 `42501`，改后 0 条），读数见[证据页](../../docs/verification/gy-r28-least-privilege-grants-20261020.md)；**未在 CVM 上执行**，不得据本行推断为已验收 |
| [`../../docs/verification/gy-i19-backup-replay-manifest-20261015.md`](../../docs/verification/gy-i19-backup-replay-manifest-20261015.md) | 备份恢复重放清单 +「恢复后不得复活」负例（GY-I19 第 3 步） | ✅ 在册 |
| [`../../docs/verification/gy-i19-backup-replay-p1-20261015.md`](../../docs/verification/gy-i19-backup-replay-p1-20261015.md) | P1 返修：必重放条目只认本轮证据 | ✅ 在册 |
| [`../../docs/verification/gy-i19-deletion-deadline-p1-20261015.md`](../../docs/verification/gy-i19-deletion-deadline-p1-20261015.md) | 删除截止 P1 返修 | ✅ 在册 |
| [`../../docs/verification/database-run-handoff.md`](../../docs/verification/database-run-handoff.md) | 数据库组件运行交接：已合组件、运行前置、迁移与重放入口、回滚/停止/未交付项 | ✅ 在册 |
| [`../../services/api/db/migrations/`](../../services/api/db/migrations/) | 迁移本体（当前 **26** 个：`0001..0026`，**连续无缺号**） | ✅ down 脚本覆盖 `0002..0026`（25 个）、无 `0001`（门禁第 8 项）；本行按**本片树**实测刷新：2026-10-20 `feat/gy-r28-recognitions-persist`（S13，#9 识别域持久化）新增 `0025_recognitions_persistence.sql` 与其 down 脚本 ⇒ **25／24／31**（`git ls-files services/api/db/migrations` ∪ `…/rollback` ∪ `git ls-files deploy`；deploy 侧由 R28-S24 新增 `evidence/probe-runtime-grants.sql`，30 → 31）。2026-10-21 `feat/gy-r28-speech-persist`（S20，#20 语音持久化）新增 `0026_speech_persistence.sql` 与其 down 脚本 ⇒ **26／25／31**。此前的读数（并列历史，按原样保留）：2026-10-20 S10（#10 OCR 持久化）新增 `0024_ocr_persistence.sql` 与其 down 后为 **24／23／30**；再合流 `upstream/main` = `ff1b39d`（含 #295 的 `0023_user_backup_copies.sql` 及其 down 脚本）后为 **23／22／30**；合流前本树（`280054b`）为 **22／21／30**（PR #304 自身 **0 迁移**，`git diff --name-status upstream/main...HEAD -- services/api/db/migrations` 为空），main `df043a7` 侧同为 22／21 ⇒ `0023` 系上游 `#295` 原样带入、合并后仅一份、无改号；#295 侧叠在 #296 新 head（`71eda51`）之上时 23／22／30。 |
| [`../../services/api/db/migrations/rollback/`](../../services/api/db/migrations/rollback/) | 结构 down 脚本（**不是**常规回滚工具；有审计数据时会拒绝并保留对象） | ✅ 覆盖性已核验；runbook §5.4 的「0002–0010」读数过期，见 §5-F1 |
| [`../../services/api/src/db/migrate.ts`](../../services/api/src/db/migrate.ts) | 迁移入口：命令闭集 `up \| status \| list`（**无 down**） | ✅ 闭集报错文本在册（门禁第 8 项） |

## 4. 离线核验方法与读数（全部可复跑）

门禁：`node tools/verify-release-materials.mjs`（15 项，退出码 0 = 通过）。逐项判据与读数：

| # | 判据 | 命令/来源 | 读数（基线 `60aa9ad`；第 2／8 项按 2026-10-18 合流 `0856e49`、2026-10-19 合流 `d131e47`／main `31a746d`／`145ebe4`（含 #279 的 `0021`）／`607c03c`（含 #312）／叠在 #296 新 head（`71eda51`）、2026-10-20 合流 main `df043a7`（含 #296 的 `0022` 与 #313）／`ff1b39d`（含 #295 的 `0023`）后的树复跑） |
| --- | --- | --- | --- |
| 1 | 索引存在 | 文件在册 | ✅ |
| 2 | 索引覆盖 `deploy/**` 全部在册文件、所列路径全部存在、被索引文件非空 | `git ls-files deploy` ∪ 索引反查 | ✅ 31 个文件全部在索引表行中（31/31 覆盖），无悬空路径；较基线 `60aa9ad` 的 29 多出 `deploy/postgres-cvm/restore-drill.ps1`（I24 片）与 `deploy/postgres-cvm/evidence/probe-runtime-grants.sql`（R28-S24，2026-10-20） |
| 3 | 索引相对链接全部可解析 | 链接目标按索引所在目录解析 | ✅ |
| 4 | 脚本三件套：`bash -n`、`set -euo pipefail`、**blob 为 LF** | `bash -n`（**blob 内容喂 stdin，不传文件路径**）；`git cat-file blob` 数 CR 字节 | ✅ 5/5 通过；blob CR 字节数全部为 0 |
| 5 | 环境变量模板 ⊇ 配置面、无多余键、机密类键为空值 | `REQUIRED_WHEN_REAL`（9）∪ `config.ts` 实际读取键（8）＝17；模板 17 键 | ✅ 完全一致；`*_SECRET`/`*_PASSWORD`/`*_KEY` 全部空值 |
| 6 | Dockerfile Node 版本 ↔ `engines.node` | `FROM node:24.16.0-…` ↔ `>=24.16.0 <25` | ✅ 逐位一致 |
| 7 | `/health` 路由存在且形状与云托管 README 的最小验收一致 | `routes/health.ts` | ✅ `status`/`checks.database`/`meta.execution_mode`，200/503 |
| 8 | down 覆盖 `0002..N`、无 `0001`；`migrate.ts` 命令闭集 | `migrations/` 26 个（`0001..0026`，连续无缺号）；`rollback/` 25 个（`0002..0026`）；`migrate.ts` 报错文本 | ✅ 一致（本片树实读：`0001..0026` 连续无缺号，`0002..0026` 的 down 全部在册、无 `0001`；`0026_speech_persistence.sql` 与其 down 由 S20（#20 语音持久化，2026-10-21）新增；`0025_recognitions_persistence.sql` 与其 down 由 S13（#9 识别域持久化）新增；`0024_ocr_persistence.sql` 与其 down 由 S10（#10 OCR 持久化）新增，`0021`／`0022`／`0023` 已分别随 `#279`／`#296`／`#295` 落在 main）；此前读数（并列历史，按原样保留）：2026-10-20 S10（#10）后为 24／23（`0001..0024` / `0002..0024`）；再合流 `upstream/main` = `ff1b39d` 后为 23／22（`0001..0023` / `0002..0023`）；合流前本树 22／21（`280054b`，见头部「合流复核六（2026-10-20，main `df043a7`，PR #304）」）；#295 侧叠 #296 新 head `71eda51` 时点＝23／22／30 |
| 9 | LF 判据必须是 blob 而非工作区 | 本机 `core.autocrlf=true` ⇒ 工作区 5/5 为 CRLF（**假象**） | ✅ 判据已按 blob 实现（见工具文件头） |
| 10 | 工具自身可重复运行且确定性 | 连续两次运行读数一致 | ✅ |

> **第 9 项是一次真实的误报排除**：2026-10-17 本机首次用 `grep -lU $'\r' deploy/**/*.sh`
> 得到 5/5 「CRLF」，几乎误判为「runbook 必查项不成立」。用 `git ls-files --eol`（`i/lf`）、
> `git cat-file blob \| git hash-object --stdin`（与索引条目 SHA 相同）、`od` 数 CR 字节（0）
> 三种方式交叉证实：**提交内容是 LF**，CRLF 只是本机签出假象。CI/Linux 取的是 blob ⇒ 判据按 blob。

## 5. 离线核验发现的问题（只报告；材料归原任务所有，本片不越位改写）

| # | 问题 | 证据 | 影响与建议 |
| --- | --- | --- | --- |
| F1 | **runbook / roles-and-migration 的迁移数量读数过期**：`runbook.md:331`「全部 10 个版本」、`:343` 期望输出「10 个版本已全部应用（0001 … 0010）」；`roles-and-migration.md:240`「全部 10 个版本」；`runbook.md:507`「rollback 存在（0002–0010，没有 0001）」 | 实测（基线 `60aa9ad`）`services/api/db/migrations/` = **17** 个（`0001..0017`）；`rollback/` = **16** 个（`0002..0017`，仍无 `0001`）。**两代基线均未修**：`95b8e7c` 上为 15/14，`60aa9ad` 上为 17/16，文档读数始终停在 10/9；2026-10-18 并流 `53922eb` ＋ `0018` 后为 18/17（见头部「并流刷新」）；再合流 `0856e49` ＋ `0019` 后为 19/18（见头部「合流复核」）；2026-10-19 合流 `d131e47` ＋ `0020` 后为 20/19（见头部「三次并流」）；同日再合流 main `31a746d` 后为 20/19（PR #304 侧，见头部「合流复核（2026-10-19，main `31a746d`，PR #304）」）／**21/20**（#15 侧，见头部「合流复核三」）／21/20（i18 后台账号目录侧，见头部「合流复核（2026-10-19，main `31a746d`）」）；再合流 `145ebe4`（含 #279 的 `0021`）后为 **22/21**（见头部「合流复核四」）；再合流 main `607c03c`（含 #312）后 #15 侧仍 22/21（见头部「合流复核五」）、PR #304 侧为 21/20（见头部「合流复核（2026-10-19，main `607c03c`，PR #304）」）；#19 侧叠 #296 新 head（`71eda51`）之上后为 **23/22**（见头部「合流复核五（2026-10-19，#19 叠在 #296 之上）」）；2026-10-20 再合流 main `df043a7`（含 #296 的 `0022` 与 #313）后**本树（PR #304 侧）实测仍为 22/21**（见头部「合流复核六（2026-10-20，main `df043a7`，PR #304）」）、#19 侧亦仍 23/22（见头部「合流复核七」）；2026-10-20 再合流 `upstream/main` = `ff1b39d`（含 #295 的 `0023`）后**按本树实测为 23/22**（见头部「合流复核九」） | 未来执行者按旧读数会误判「迁移没跑全」。`evidence/local-self-check.md:825/887` 的「10 个版本」是 2026-10-13 真跑的**历史输出**（当时确为 10 个），按「不改写历史证据」原则应保留；**建议由 GY-I25（#27）材料Owner** 在 runbook §步骤2/3 与 §5.4 增加「当时 10 个／现有 N 个（随基线变）」的时点说明，或改为引用门禁输出 |
| F2 | **LF 判据的工作区假象**（第 9 项） | `core.autocrlf=true` | 已在本片工具中按 blob 判据固化；建议后续所有「行尾必查」都注明「查 blob，不查工作区」 |
| F5 | **`bash -n` 不得传文件路径**（监工在 WSL 下实测转红后修复）：旧写法 `execFileSync('bash',['-n', join(ROOT, script)])` 把 Windows 路径传给 bash，MSYS bash 吃 `D://…`（本机因此 5/5 假绿）、**WSL 只吃 `/mnt/d/…`（监工环境 5/5 找不到文件）**、Linux CI 吃 `/…`——三种解释互不相容 | 修复：`bash -n` 改为**读 blob 内容喂 stdin**（`execFileSync('bash',['-n'],{input})`），与路径解释完全无关，且与 LF 判据同源（检查提交内容而非工作区）；`tests/unit/release-materials-index.test.mjs` 增加结构化回归钉住该形态（不得再出现给 bash 传路径的调用） | 已修复并复跑通过；教训：跨平台门禁里，**凡是把本机路径交给外部程序的调用都要按「调用方可能是另一种路径哲学」设计**（stdin/stdout 优先，路径探测兜底） |
| F3 | **`service-settings.md` 对 `OBJECT_STORAGE_*` 的「当前无代码消费」已过期**：该表四行（`:61`-`:64`）称 object storage 相关键「当前无代码消费（识别/合成媒体端口在 real 下未接线、fail-closed）」 | 新基线上 `services/api/src/media/object-store.ts:209` 实际读取 `OBJECT_STORAGE_ENDPOINT`（并在 `:214/226` 参与校验与报错）；`app.ts:1127` 在 `mediaAccessGrantOrigin !== null` 时注入 `accessGrantOrigin`。即 PR #193「媒体对象存储显式接线」之后这些键**已被消费**（凭据齐备才构造真实适配器、缺任一保持 fail-closed 的口径不变） | 会影响运维对「填了是否起作用」的判断。同表 `DELETION_LEDGER_KEY` 的「无代码消费」**仍成立**（`grep` 确认 config.ts 之外无消费者）⇒ 不是整表过期，建议材料Owner 只订正 object storage 四行 |
| F4 | **环境变量模板缺 `MEDIA_ACCESS_GRANT_ORIGIN`**（新基线配置面新增的可选键） | 门禁第 5 项在 `60aa9ad` 上实测转红：模板 16 键 vs 配置面 17 键 | **本片已修**：模板补入该键（空值；该键可选，未配置时媒体域用 `.invalid` 占位域，`config.ts:234-248`）。属「模板与配置面保持一致」的补齐，不改变任何部署行为 |

## 6. 离线核验**不能**覆盖的项（不得据本索引推断为已验收）

- Docker 镜像构建与容器内 `/health`（需 Docker）：`deploy/cloudrun/local-check.ps1`、`Dockerfile`。
- 云托管控制台操作、VPC/子网/安全组、账号边界核对：`deploy/cloudrun-vpc/*`、runbook §6「仅用户本人可做」。
- 目标 CVM 上的真实执行：安装、迁移、角色引导、备份、恢复演练、`verify-cvm-postgres.sh` 的全部判据
  （2026-10-13 已有部分真跑记录，见 `evidence/local-self-check.md`；**监工尚未复核，不得声称已验收**）。
- PITR／异地备份、备份保留期的生产启用、真实 ASR/LLM 供应商调用与额度。
- GY-I24 整项的其余范围（联网比赛版交付、赛前检查、完整材料包）不在本片内。

## 7. 边界

- 本片只做**索引 + 离线文档核验**：新增 1 份索引（本文件）、1 个门禁工具、1 项回归；
  **未改动** `deploy/**`、`docs/verification/**` 既有材料正文，未改契约与服务端代码。
- `Refs #24`，**不关闭整项 issue**；GY-I24 整项未完成（见 §6）。
- 本索引的读数一律绑定**测量时的树**：`60aa9ad`（初版）与 2026-10-18 顶层并流／再合流、2026-10-19 三次并流、再合流 `31a746d`（PR #304）／`31a746d`（i18 后台账号目录侧）、再合流 `145ebe4`（含 #279 的 `0021`）、再合流 `607c03c`（含 #312）／`607c03c`（PR #304 侧）、叠在 #296 新 head（`71eda51`）之上、2026-10-20 再合流 `df043a7`（含 #296 的 `0022` 与 #313）、再合流 `ff1b39d`（含 #295 的 `0023`）后的合并树（见头部「并流刷新」「合流复核」「三次并流」「合流复核三」「合流复核四」「合流复核五」「合流复核六」「合流复核七」「合流复核九」「合流复核（2026-10-19，main `31a746d`，PR #304）」「合流复核（2026-10-19，main `607c03c`，PR #304）」）；
  基线前进后应复跑门禁并更新读数（刷新方法：并入新 `upstream/main` → 跑门禁 → 按输出改数 → 复跑回归）。

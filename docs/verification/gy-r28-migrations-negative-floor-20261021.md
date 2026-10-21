# GY-R28-S32 迁移负例补齐：最大号下限钉（2026-10-21）

任务归属：交接文档 §7 队列第 ⑨ 条（R28 批次，本片编号 S32；是交接队列条目、不绑定 GitHub issue，故本页无 `Refs` 行）。
范围：只改 `tests/integration/migrations-negative-pg.mjs`，并新增本页。未改任何迁移文件、`services/**`、`apps/**`、`packages/**`、`deploy/**`、`.github/**`、其他测试与其他证据页；未 push、未建 PR。
**结论先说**：该测试原有的两条结构不变量（下称 ① 连续无缺号、② `count === max`）对「迁移发现器把**尾部整段**漏掉」**恒真**，这是它的真空洞。本片在 ①② 之后补两条**下限钉**（`MIN_EXPECTED_LAST_VERSION = 25`），不写死总数、不改 11 条 PASS 计数。真库实测三组：完整 25 迁移 ⇒ 退出码 0（下限钉绿）；同一份只剩 22 个迁移的副本 ⇒ 旧两条仍绿、新钉红、退出码 1；**改前脚本**在同一 22 迁移副本上 11/11 全绿、退出码 0——洞与补钉都被逐字取证。

## 0 分支、基线与工作区

| 项 | 值 |
| --- | --- |
| worktree | `E:\GengYunCommander\wt-r28-s32`（独立 worktree，未切指挥仓库分支） |
| 分支 | `test/gy-r28-migrations-negative-floor` |
| 实现起点 | `c06d232820ce2acc6c2cf20914c81aba45817aad`（短 `c06d232`） |
| 基线 `upstream/main` | `56042f7e6aeba740f72180f0162417ed0300bdbc`（短 `56042f7`，`#342`）；实现完成后 `git rebase upstream/main` 到此基线，并按 §8 重跑 §3、§4、§6 的读数（§5 用的改前版本在 `56042f7` 上逐字相同，结论不受 rebase 影响） |
| 基线差异核对 | `git diff --name-only c06d232 upstream/main -- services/api/db/migrations` 为**空**、`git diff --stat c06d232 upstream/main -- tests/integration/migrations-negative-pg.mjs` 为**空**；`56042f7` 只改 `deploy/postgres-cvm/**` 三份 SQL 与 `docs/verification/gy-r28-recognition-grants-20261021.md`。故 `MIN_EXPECTED_LAST_VERSION = 25` 在 rebase 后仍然正确（此刻末位仍是 `0025_recognitions_persistence.sql`） |
| 迁移集合 | `services/api/db/migrations/` 共 25 个 `.sql`（`0001`…`0025`） |
| 起点状态 | `git status --porcelain` 为空；`node_modules` 已装（含 `pg` 8.23.1）；node v24.16.0 |
| 数据库 | 本机 PostgreSQL 17.11 一次性集群，端口 `55643`，数据目录 `E:\GengYunCommander\.pg17\data-r28s32`（`initdb -U postgres --auth=trust`） |
| 是否 push | **否**（写手不持有推送凭据，CI 未触发；见 §7） |

## 1 洞的机制：两条不变量只约束「已发现集合」的内部一致性

取数来源与迁移器完全相同：测试调用 `discoverMigrations()`（`services/api/src/db/migrate.ts:51`，默认目录 `DEFAULT_MIGRATIONS_DIR`，见 `:42`），它只按文件名 `/^(\d{4,})_([a-z0-9_]+)\.sql$/` 清点目录下的 `.sql` 文件。测试再对这批结果加两条断言（`tests/integration/migrations-negative-pg.mjs:67-76`）：

- ① 版本号在 `1..max` 上**连续无缺号**——只问「已发现集合中间有没有洞」；
- ② `MIGRATION_COUNT === LAST_VERSION_NUMBER`——只问「已发现集合数得对不对」。

两条都是**集合自身的内部一致性**，没有任何外部锚点。把集合 `{1..25}` 换成 `{1..19}`（或 `{1..22}`）时两条同时成立，于是「发现器把尾部整段漏掉」这一整类漏项对旧断言**恒真**：

| 情形 | ① 连续无缺号 | ② count === max | 旧脚本判决 |
| --- | --- | --- | --- |
| 发现器跳过中间的 `0015` | 红（缺号点名） | 红（24 ≠ 25） | 红（既有实测） |
| 目录只剩 `0001..0019`（尾部丢 6 个） | **绿** | **绿** | **绿（洞）** |
| 目录只剩 `0001..0022`（尾部丢 3 个） | **绿** | **绿** | **绿（本页实测，见 §5）** |

为什么不能再用「纯派生」数字兜底：文件 `:53` 已记「纯派生（只把 `discoverMigrations().length` 与自身比）曾实测无牙：同一次漏片下本测试仍 11/11 绿」。任何从同一目录再取一次的数字会**跟着一起丢**。要发现「整段尾巴不见」，锚点必须来自目录之外——即人工维护的下限。

## 2 改法：两条下限钉 + 一行 STRUCT 读数（不改 PASS 计数）

| 位置 | 内容 |
| --- | --- |
| `tests/integration/migrations-negative-pg.mjs:55-58` | 文件头注释补「①② 的真空洞（2026-10-21 补）」，说明两条只约束内部一致性、对尾部整段丢失恒真，并指向本页 |
| `tests/integration/migrations-negative-pg.mjs:78-86` | 常量 `MIN_EXPECTED_LAST_VERSION = 25` 的注释：**有意的人工步骤**（新增迁移时须抬到新的最大版本号）；三条「为什么是 ≥ 而不是等于某个数」的理由 |
| `tests/integration/migrations-negative-pg.mjs:89-93` | 新增一行 `STRUCT 旧的两条结构不变量已通过：…`（`console.log`，**不计入** `say()` 的 PASS 计数），让「旧两条仍绿」在负控制输出里可逐字取证 |
| `tests/integration/migrations-negative-pg.mjs:94-100` | 第一条钉 `assert.ok(LAST_VERSION_NUMBER >= MIN_EXPECTED_LAST_VERSION, …)`，失败文案点名「挡的是迁移发现器把尾部整段漏掉」并声明「不是必须等于某个数」 |
| `tests/integration/migrations-negative-pg.mjs:101-106` | 第二条钉 `assert.ok(MIGRATION_COUNT >= MIN_EXPECTED_LAST_VERSION, …)`，与上一条共用常量 |

**为什么下限钉不是「写死总数」**（`:78-86` 注释的三条理由，此处展开）：

1. 下限只挡**尾部整段丢失**这一类漏项，不影响「新增迁移」：新增 `0026` 后 `max=26`、`count=26`，`26 >= 25` 仍绿，测试照旧自动放行。
2. 别人先合入新迁移、本文件后合入时，数字**落后**只会让钉子变松（`25 ≤ 26` 仍绿），不会变成时炸弹——这正是 ①② 当初拒绝写死总数的原因，下限钉不退回那个坑。
3. 漏抬钉子不会制造新故障，只损失一点灵敏度：尾部丢失若仍留在「≥ 本数」之上，本钉看不见（如实登记为缺口，见 §7 第 2 条）。

**为什么还要第二条（总数）**：② 已保证 `count === max`，所以尾部丢失时第一条会先红、第二条不会单独触发（顺序使然，如实登记）。它单列的价值在「将来若有人松动 ②」：那时总数这一列的下限仍然在。两条**共用**同一常量，抬数字是一次、不是两处。

**为什么保持 11 条 PASS**：本片不动 `say()` 与末行 `ALL 11 migration negative groups passed …`，避免 `docs/verification/gy-r28-recognitions-persist-20261020.md`、`docs/verification/gy-r27-ocr-persist-20261020.md` 等历史页引用的「11 条 PASS」读数变陈旧。

## 3 正控制：完整 25 迁移，上下限钉必须绿

集群：`postgres.exe -D E:\GengYunCommander\.pg17\data-r28s32 -p 55643`（回环；`select version()` ⇒ `PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit`，`show port` ⇒ `55643`）。
命令与 CI 同一条，只换连接串（`cmd` 重定向保证原始 UTF-8 落盘）：

```powershell
$env:MIGRATIONS_NEGATIVE_TEST_URL='postgres://postgres@127.0.0.1:55643/postgres'
node tests/integration/migrations-negative-pg.mjs
```

逐字输出，**退出码 0**：

```text
STRUCT 旧的两条结构不变量已通过：25 个迁移，版本 0001..0025 连续无缺号，count === max（不写死总数）。
PASS 1: A0 基线：空库 `up` 依次应用 0001–0025，台账 25 行（三臂的前提现场可复现）
PASS 2: A1 现场置回「0016 待应用」：四类对象计数 0、台账 24 行
PASS 3: A2 半截失败：退出码 1，0016 的三列/CHECK/函数全被回滚，台账仍 24 行且无 0016 行
PASS 4: A3 冲突解除后 `up` 补上 0016：四类对象与 25 行台账全部恢复
PASS 5: A4 合成迁移「先建表后写坏语句」：抛错、建表被回滚、台账无 0099 行
PASS 6: A5 事务正控：不带 `BEGIN` 的合成迁移 0100 由迁移器事务包住，正常路径落地且台账 +1，复原后台账 25 行
PASS 7: A6 事务负例：台账 INSERT 失败后，无 `BEGIN` 迁移里已建的表不残留、台账无行（runner 的 BEGIN 承重）
PASS 8: B1 重放：退出码 0，`已应用：（无）`＋`已存在跳过：0001…0025`，台账指纹/对象数/哨兵行完全不变
PASS 9: B2 drift：篡改 0001 的磁盘内容后抛「迁移校验和 drift，拒绝继续」，台账与对象数不变
PASS 10: C1 0016 up→down：四类对象回到 up 前状态，快照与 up 前 deepEqual
PASS 11: C2 两轮 down→up→down：快照守恒，且 down 不碰 0003 的表/唯一索引/既有列/两条 CHECK
ALL 11 migration negative groups passed against native PG17.11; only 0016's up/down pair is exercised, the runner has no down command, and down scripts do not update the ledger.
```

读数要点：首行 `25 个迁移 … 0001..0025` 证明 `max=25 >= 25` 与 `count=25 >= 25` 两条钉**都绿**（两条钉在 DB 动作之前，若红则连 PASS 1 都不会出现）；A0 台账 25 行说明迁移器对 25 个文件真跑通；PASS 数仍是 11。

## 4 负控制一：尾部整段丢失时，新钉必须红（洞仍绿，钉红）

副本与忠实性：用 `robocopy E:\GengYunCommander\wt-r28-s32 E:\GengYunCommander\.pg17\tmp\r28-s32\tail-loss /E /XF .git /NFL /NDL /NP /R:1 /W:1` 整树复制（5140 文件 133.8 MB，含 `node_modules` 故沙箱内 `pg` 可解析），未删改时先跑一次同一脚本 ⇒ **退出码 0**、首行同样是 `STRUCT … 25 个迁移 … 0001..0025`、PASS 1 为 `0001–0025，台账 25 行` ⇒ 副本忠实。

随后**只在副本内**删除末 3 个迁移：`0023_user_backup_copies.sql`、`0024_ocr_persistence.sql`、`0025_recognitions_persistence.sql`（剩 22 个，末位 `0022`；工作树迁移目录零改动）。复跑 ⇒ **退出码 1**，逐字：

```text
STRUCT 旧的两条结构不变量已通过：22 个迁移，版本 0001..0022 连续无缺号，count === max（不写死总数）。
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: 最大迁移版本号不得低于下限钉 25（实测 max=22）：这条挡的是「迁移发现器把尾部整段漏掉」——例如只剩 0001..0019 时，① 连续无缺号与 ② count===max 会同时成立，旧两条结构不变量对此恒真、只有本条会红。它不是「必须等于某个数」：新增迁移只须把下限钉同步抬到新号（有意的人工步骤），不相等不报错，只有整段尾巴消失才红。
    at file:///E:/GengYunCommander/.pg17/tmp/r28-s32/tail-loss/tests/integration/migrations-negative-pg.mjs:94:8
    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)
    at async node:internal/modules/esm/loader:633:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v24.16.0
```

读数：第 1 行是 ①② 的判决，`22 个迁移 … 0001..0022 连续无缺号，count === max`——**旧两条结构不变量在尾部丢失下仍然全绿**（这一行打印在两条钉之前，它出现即证明 ①② 都过了）；紧接着就是第一条下限钉在 `:94` 转红，`max=22 < 25`。两条钉都在 DB 动作之前，所以退出码 1 时库上什么都没发生，副本被删的 3 个文件也没有进工作树。

## 5 负控制二：同一 22 迁移副本上，改前脚本端到端全绿（洞的证明）

把**改前**版本（`git show HEAD:tests/integration/migrations-negative-pg.mjs`，21535 字节，即本片未加钉的 `c06d232` 版本；该版本在 `56042f7` 上逐字相同，见 §0）写进同一副本，命名为 `migrations-negative-pg-pre-floor.mjs`（**只在副本内，未进工作树、未提交**），在同样的 22 迁移目录上复跑 ⇒ **退出码 0**，逐字：

```text
PASS 1: A0 基线：空库 `up` 依次应用 0001–0022，台账 22 行（三臂的前提现场可复现）
PASS 2: A1 现场置回「0016 待应用」：四类对象计数 0、台账 21 行
PASS 3: A2 半截失败：退出码 1，0016 的三列/CHECK/函数全被回滚，台账仍 21 行且无 0016 行
PASS 4: A3 冲突解除后 `up` 补上 0016：四类对象与 22 行台账全部恢复
PASS 5: A4 合成迁移「先建表后写坏语句」：抛错、建表被回滚、台账无 0099 行
PASS 6: A5 事务正控：不带 `BEGIN` 的合成迁移 0100 由迁移器事务包住，正常路径落地且台账 +1，复原后台账 22 行
PASS 7: A6 事务负例：台账 INSERT 失败后，无 `BEGIN` 迁移里已建的表不残留、台账无行（runner 的 BEGIN 承重）
PASS 8: B1 重放：退出码 0，`已应用：（无）`＋`已存在跳过：0001…0022`，台账指纹/对象数/哨兵行完全不变
PASS 9: B2 drift：篡改 0001 的磁盘内容后抛「迁移校验和 drift，拒绝继续」，台账与对象数不变
PASS 10: C1 0016 up→down：四类对象回到 up 前状态，快照与 up 前 deepEqual
PASS 11: C2 两轮 down→up→down：快照守恒，且 down 不碰 0003 的表/唯一索引/既有列/两条 CHECK
ALL 11 migration negative groups passed against native PG17.11; only 0016's up/down pair is exercised, the runner has no down command, and down scripts do not update the ledger.
```

读数：尾部丢掉 3 个迁移（含最新的一片 `0025`），改前脚本照样把 22 个迁移全部应用、11/11 PASS、退出码 0，**没有任何一行提示少了迁移**。§4 与 §5 合起来是完整证明：同一故障、同一副本，改前绿、改后红，红点只落在新加的下限钉上。

## 6 六项门禁读数（本机实测，全部退出码 0）

| 门禁 | 退出码 | 关键读数 |
| --- | --- | --- |
| ① `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json`；`PASS tsc --noEmit apps/admin/tsconfig.json`；`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`；`lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| ② `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）`；末项 `PASS migrate.ts 命令闭集为 up/status/list` |
| ③ `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`；`研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` |
| ④ `node tools/verify-contract-status.mjs` | 0 | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项` |
| ⑤ `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6`／`pass 6`／`fail 0`／`skipped 0` |
| ⑥ `node --test --test-concurrency=1 tests/unit/ci-integration-chain-structure.test.mjs tests/unit/integration-script-coverage.test.mjs` | 0 | `tests 13`／`pass 13`／`fail 0`；含「整链跳过必须给 77」与「反向控制：零出口的假 SKIP 脚本必须红」 |

门禁均在 `git rebase upstream/main`（基到 `56042f7`）之后按 §8 重跑一遍，六项退出码仍全 0、上表关键行逐字不变。

## 7 未取得／已知缺口（逐条如实）

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | GitHub CI 真跑读数 | **未取得**：本片只本地提交、未 push，`auth-privacy-postgres.yml` 未触发。下限钉搭的是**既有**那一步（`- run: node tests/integration/migrations-negative-pg.mjs`），**未新增、未修改任何 workflow**；runner 上是 ubuntu + service `postgres:17.11`，与本页 Windows + 本机 17.11 环境不同 |
| 2 | 漏抬钉子时的灵敏度 | 若新增迁移却没把 `MIN_EXPECTED_LAST_VERSION` 抬到新号，钉子只是变松：尾部丢失若仍留在「≥ 25」之上（例如丢了 `0026` 只剩 25 个），本钉**看不见**。这是有意的取舍（宁松不误炸），已写进常量注释 |
| 3 | 第二条钉的实际触发条件 | 尾部丢失时第一条先红，第二条不会单独触发（`:94` 在 `:101` 之前）；只有将来有人松动 ② 使 `count < max` 而 `max >= 25` 时，它才会独自承重。本页未构造该变异 |
| 4 | 尾部丢失的模拟粒度 | 只实测「删末 3 个（25→22）」这一种；未逐一枚举删 1、2、4…个或对 25 个迁移做组合注入。中间缺号仍由 ① 负责（既有实测：跳过 `0015` 时 ①② 各红） |
| 5 | 迁移发现器的真实故障形态 | 本页的「尾部丢失」是**删文件**模拟；发现器本身的正则/目录参数若被改坏，等价效果已被 §4/§5 覆盖，但未对 `discoverMigrations()` 源码做变异注入 |
| 6 | 26 号及以后迁移的自动同步 | 不做：抬 `MIN_EXPECTED_LAST_VERSION` 是**人工步骤**，新增迁移的 PR 须自行同步；本片没有加任何自动推导（自动推导正是 §1 说的「跟着一起丢」） |

## 8 复核命令

```powershell
# 正控制（真库；不设 env 则打印 3 行 SKIP、退出码 77）
$env:MIGRATIONS_NEGATIVE_TEST_URL='postgres://postgres@127.0.0.1:55643/postgres'
node tests/integration/migrations-negative-pg.mjs

# 负控制（副本内删末 3 个迁移后复跑；退出码应为 1，首行 STRUCT 应为 22）
robocopy E:\GengYunCommander\wt-r28-s32 E:\GengYunCommander\.pg17\tmp\r28-s32\tail-loss /E /XF .git /NFL /NDL /NP /R:1 /W:1
Remove-Item E:\GengYunCommander\.pg17\tmp\r28-s32\tail-loss\services\api\db\migrations\002{3,4,5}_*.sql
node E:\GengYunCommander\.pg17\tmp\r28-s32\tail-loss\tests\integration\migrations-negative-pg.mjs

# 洞的证明（改前版本在同一副本上应为退出码 0、11 条 PASS）
git -C E:\GengYunCommander\wt-r28-s32 show HEAD:tests/integration/migrations-negative-pg.mjs > <副本>\tests\integration\migrations-negative-pg-pre-floor.mjs

# 五项无需真库的门禁（另加 §6 ⑤）
npm run lint
node tools/verify-release-materials.mjs
npm run test:docs
node tools/verify-contract-status.mjs
node --test --test-concurrency=1 tests/unit/ci-integration-chain-structure.test.mjs tests/unit/integration-script-coverage.test.mjs
```

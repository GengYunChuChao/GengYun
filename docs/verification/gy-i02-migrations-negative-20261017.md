# GY-I02 迁移负例证据：半截失败／重放／回滚三臂（2026-10-17）

任务归属：GY-I02，issue **#2**（**Refs #2，不关闭整项**）。
范围：本页只记录**迁移器负例**的真库取证。**结论先说**：实测 `services/api/src/db/migrate.ts` 现状**已满足**「半截失败必须回滚干净」（单迁移单事务＋失败即 `ROLLBACK`），因此本片**未改迁移器**，只新增测试、CI 一步、文档与结构测试白名单声明；派单的「停手条件」未触发。
禁区遵守：未改 `packages/contracts/**`、`miniprogram/**`、`services/api/src/app.ts`、`services/api/src/privacy/**`、`services/api/src/db/pool.ts`，**未改任何既有迁移文件的内容**。

## 0 分支、基线与工作区

| 项 | 值 |
| --- | --- |
| worktree | `E:\GengYunCommander\GengYun_W02mig`（独立 worktree；未切指挥仓库的分支） |
| 分支 | `feat/gy-i02-migrations-negative` |
| 基线 `upstream/main` | `6c2200087ae5f8841a04505cb1c226284cee7f1b`（短 `6c22000`；`git fetch upstream --prune` 后读取，与派单签发基线一致） |
| 起点状态 | 新建 worktree，`git status --short` 为空；`npm ci --no-audit --no-fund` 安装依赖后开工 |
| 是否 push | **否**（写手不持有推送凭据；推送与 PR 由指挥执行，故下文 CI 读数标注「未跑」） |

## 1 现状盘点（先摸清，再决定是否加固）

| # | 问题 | 实测答案 | 证据 |
| --- | --- | --- | --- |
| 1 | `db:migrate` 在哪、怎么连库 | `services/api/package.json:17` 定义 `"db:migrate": "node src/db/migrate.ts up"`；CLI 只认环境变量 `DATABASE_URL`，缺省直接抛「缺少 DATABASE_URL：迁移需要真实数据库连接串，未配置时拒绝运行。」；失败以 `process.exitCode = 1` 退出 | `services/api/package.json:17`、`services/api/src/db/migrate.ts:178-187`、`services/api/src/db/migrate.ts:232` |
| 2 | 是否单迁移单事务 | **是**：每个迁移各自 `BEGIN` → 整段迁移 SQL → 台账 `INSERT` → `COMMIT`；catch 里先 `ROLLBACK` 再抛「迁移 <文件名> 执行失败：…」，因此文件内任何一条语句失败都不会留半截对象 | `services/api/src/db/migrate.ts:150`、`:152`、`:154`、`:157`、`:159`、`:160` |
| 3 | 有无已应用记录表 | **有**：`schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz)`；按台账跳过已应用版本，磁盘内容与台账校验和不一致时整批拒绝（drift） | `services/api/src/db/migrate.ts:107-114`、`:83-103`、`:145` |
| 4 | 有无 CI 真跑 rollback | **无**：`.github/workflows/` 的 10 个 workflow 没有任何一个执行 `services/api/db/migrations/rollback/*.down.sql`；仓内只有 `tests/integration/account-deletion-pg.mjs` 与 `tests/integration/egress-object-key-pg.mjs` 用 psql 跑**单个** down 文件做 UP→DOWN→REPLAY，且不经过迁移器的 `up` 命令 | 10 个 workflow 逐一检索；`tests/integration/account-deletion-pg.mjs`、`tests/integration/egress-object-key-pg.mjs` |

推断与实测一致：`applyMigrations` 的 per-migration `BEGIN/COMMIT` 已提供事务性回滚，`up` 又是 `ON_ERROR` 即抛错退出，故**加固不必要**；本片按派单「只加测试与文档」路线执行，并补做负控制证明测试对事务管道缺失**敏感**（见 §3）。

## 2 三臂读数（本机真 PG17.11，逐字）

隔离集群：临时数据目录 `E:\GengYunCommander\gytmp-migneg\pgdata`，`postgres.exe -p 55441 -h 127.0.0.1`（回环；`psql -tAc "select version()"` ⇒ `PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35211, 64-bit`）。
命令与 CI 完全同一条（只换连接串）：

```powershell
$env:MIGRATIONS_NEGATIVE_TEST_URL='postgres://postgres@127.0.0.1:55441/postgres'
node tests/integration/migrations-negative-pg.mjs
```

逐字输出（退出码 **0**）：

```text
PASS 1: A0 基线：空库 `up` 依次应用 0001–0016，台账 16 行（三臂的前提现场可复现）
PASS 2: A1 现场置回「0016 待应用」：四类对象计数 0、台账 15 行
PASS 3: A2 半截失败：退出码 1，0016 的三列/CHECK/函数全被回滚，台账仍 15 行且无 0016 行
PASS 4: A3 冲突解除后 `up` 补上 0016：四类对象与 16 行台账全部恢复
PASS 5: A4 合成迁移「先建表后写坏语句」：抛错、建表被回滚、台账无 0099 行
PASS 6: B1 重放：退出码 0，`已应用：（无）`＋`已存在跳过：0001…0016`，台账指纹/对象数/哨兵行完全不变
PASS 7: B2 drift：篡改 0001 的磁盘内容后抛「迁移校验和 drift，拒绝继续」，台账与对象数不变
PASS 8: C1 0016 up→down：四类对象回到 up 前状态，快照与 up 前 deepEqual
PASS 9: C2 两轮 down→up→down：快照守恒，且 down 不碰 0003 的表/唯一索引/既有列/两条 CHECK
ALL 9 migration negative groups passed against native PG17.11; only 0016's up/down pair is exercised, the runner has no down command, and down scripts do not update the ledger.
```

| 臂 | 断言（不满足即红） | 读数 |
| --- | --- | --- |
| A 半截失败 | 注入冲突使 0016 第 2 条语句失败 ⇒ 退出码非 0，且该迁移已执行的第 1 条语句（三列/CHECK）被回滚、台账不新增行；冲突解除后同一命令可补齐 | PASS 3、PASS 4 |
| A 半截失败（合成） | 「先建表、后写坏语句」的合成迁移 0099 ⇒ 抛错、建表被回滚、台账无 0099 行 | PASS 5 |
| B 重放 | 已迁移库再跑 `up` ⇒ 退出码 0、`已应用：（无）`、`已存在跳过：0001…0016`，台账指纹／对象数／哨兵行数全不变（无任何语句被再执行一次）；篡改磁盘内容 ⇒ 明确失败且状态不变 | PASS 6、PASS 7 |
| C up→down 可逆 | 0016 先 up 再 down ⇒ up 前不存在的四类对象全部重新消失，快照与 up 前 `deepEqual`；两轮 down→up→down 快照守恒；down 不触碰 0003 建立的表／唯一索引／既有列／两条 CHECK | PASS 8、PASS 9 |

**SKIP 口径（无库时不静默绿）**：不设 `MIGRATIONS_NEGATIVE_TEST_URL` 时逐字打印下列三行并 `exit 0`（不算通过，CI 里由 workflow 显式给 env，不会走到这里）：

```text
SKIP migrations-negative-pg：MIGRATIONS_NEGATIVE_TEST_URL 未设置，三臂 A/B/C 均未执行（不算通过）。
  原因：半截失败／重放／回滚必须对真实 PostgreSQL 17.11 取证，无库时不伪造读数，也不静默绿。
  启用：MIGRATIONS_NEGATIVE_TEST_URL=postgres://<user>@127.0.0.1:<port>/<test_db>（维护连接须可 CREATE/DROP DATABASE）。
```

## 3 负控制（先红后绿：证明测试能抓住回滚缺失）

为确认三臂不是「无论迁移器怎样都绿」，做了一次**临时**变异（未入提交）：

1. 把 `services/api/src/db/migrate.ts` 里的 `await client.query('BEGIN');`、`await client.query('ROLLBACK');`、`await client.query('COMMIT');` 三行替换为注释（`git diff --stat` ⇒ 3 insertions / 3 deletions）。
2. 复跑同一条命令 ⇒ **转红**，退出码 1，逐字：

```text
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /迁移 0016_account_deletion_persistence\.sql 执行失败：/. Input: '迁移失败： current transaction is aborted, commands ignored until end of transaction block\n'
```

3. `git checkout -- services/api/src/db/migrate.ts` 复原（`git diff --stat` 为空、`git status --short` 只剩新测试文件），复跑 ⇒ 恢复 9 条 PASS、退出码 0。

即：测试依赖的正是迁移器的 per-migration 事务管道；该管道被拿掉后 A 臂立刻失败。**提交里的迁移器零改动**（`git diff upstream/main...HEAD -- services/api/src/db/migrate.ts` 为空）。

## 4 CI 接线（挂进已有 workflow，未新建）

| 项 | 值 |
| --- | --- |
| 文件 | `.github/workflows/auth-privacy-postgres.yml`（既有、最贴近的 PG workflow，service `postgres:17.11`） |
| 位置 | 末尾新增一步 `:37-41`：两行中文注释说明三臂与自建自删库，`:39` 为 `- run: node tests/integration/migrations-negative-pg.mjs`，`:40-41` 设 `MIGRATIONS_NEGATIVE_TEST_URL: postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_auth_privacy_test` |
| 未新建 workflow | 是（10 个 workflow 数量不变） |
| 未动 `engineering-shell.yml` | 是（该文件的 11 条集成链一字未改） |
| 未接进 `test:integration:http` 链 | 是（该链需无 PG 环境可跑）；改为在 `tests/unit/ci-integration-chain-structure.test.mjs:107` 的白名单里声明「需真 PG、由 workflow 另起一步」，否则结构测试断言 4 会红 |
| **CI 未跑** | **是：本片只本地提交、未推送，workflow 未触发；上述 CI 读数待推送后验证** |

## 5 六项门禁读数（本机实测，全部退出码 0）

| 门禁 | 退出码 | 关键读数 |
| --- | --- | --- |
| ① `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json`；`PASS tsc --noEmit apps/admin/tsconfig.json`；`PASS 仓库卫生扫描` |
| ② `npm run test:unit` | 0 | `tests 2441`；`pass 2440`；`fail 0`；`skipped 1`（既有跳过项，本片未新增跳过）；`duration_ms 49302.3059` |
| ③ `npm run test:integration:http` | 0 | `CHECKS pass=42 fail=0`；`RESULT=PASS 真实产品装配（buildApp）+ 本机回环 HTTP` |
| ④ `node tools/verify-contract-status.mjs` | 0 | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4` |
| ⑤ `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| ⑥ `git diff --check` | 0 | 三个口径均 0 且无输出，见下 |

`git diff --check` 三口径：`git diff --check`（工作区）、`git diff --check upstream/main...HEAD`（三点）、`git diff --check upstream/main HEAD`（两点）。

## 6 未取得／已知缺口（逐条如实）

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | CI 真跑读数 | **未取得**：未推送，workflow 未触发，待推送后验证 |
| 2 | 迁移器 `down` 命令 | **不存在**（只有 `up`／`status`／`list`）；C 臂的回滚是用 `psql` 客户端直接执行既有 down 文件，不是 runner 能力 |
| 3 | down 脚本回写台账 | **不做**：0016 down 之后 `schema_migrations` 仍留 0016 行，直接再 `up` 会按台账跳过而不重建对象；C 臂里显式 `DELETE FROM schema_migrations WHERE version='0016'` 才复原现场。本片未改此既有语义 |
| 4 | 回滚覆盖范围 | 只实测 `0016_account_deletion_persistence` 这一对（`0001` 无 down 文件，其余 14 对未逐对实测） |
| 5 | 故障注入覆盖 | A 臂注入的是 0016 第 2 条语句（同名索引冲突）＋合成 `0099_half_broken.sql`；未对 16 个迁移逐个注入 |
| 6 | 「文件自带事务」边界 | 16 个 up 迁移文件都自带 `BEGIN…COMMIT`，故失败语句位于文件事务内；若将来出现把语句写在文件 `COMMIT` 之后的迁移，runner 的 `BEGIN/COMMIT` 之外还有 PG 对「单条 Query 多语句」的隐式事务兜底，但那种写法本身不合规，本页**未取证**其行为 |
| 7 | OpenAPI 2020-12 与 Fastify 适配实测 | **未取得**（属 GY-I02 验收表其余项，本片不冒称） |

## 7 复核命令

```powershell
# 三臂（真库；不设 env 则打印 3 行 SKIP、退出码 0）
$env:MIGRATIONS_NEGATIVE_TEST_URL='postgres://postgres@127.0.0.1:55441/postgres'
node tests/integration/migrations-negative-pg.mjs

# 迁移器零改动
git -C E:\GengYunCommander\GengYun_W02mig diff upstream/main...HEAD -- services/api/src/db/migrate.ts

# 结构测试（白名单声明 + 集成链完整性）
node --test tests/unit/ci-integration-chain-structure.test.mjs
```

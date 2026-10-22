# R28-S29：识别域 PG 集成脚本「迁移末位断言」解除验证（2026-10-21）

范围：**只改 `tests/integration/recognitions-pg.mjs` 的一条顺序断言**，删除「本片迁移必须是当前最后一条」的位置约束，保留其余结构不变量与非位置断言。不改迁移 SQL、不改被测行为、不改 CI/workflow、不改任何运行时实现。

- 实现分支：`test/gy-r28-recognition-migration-order`（基线 `56042f7`，rebase 说明见 §7）
- 改动文件：`tests/integration/recognitions-pg.mjs`（`git diff --stat`：1 file changed, +6 −2）
- 本页记录手动取证过程与本机门禁结果；不代表部署、云端或整项验收。

## 1. 问题与证据

### 1.1 症状

`tests/integration/recognitions-pg.mjs` 的 M0 结构不变量把「迁移顺序」写成了**全局位置断言**：要求本片迁移 `0025_recognitions_persistence.sql` 永远是发现结果里的最后一条。只要迁移目录出现更新的一条（0026 及以后），脚本在 `PASS 1` 之前就红：

```
AssertionError [ERR_ASSERTION]: 0025_recognitions_persistence.sql 必须是当前最后一条（本片新增的就是末位）
+ actual: '0026_r28s29_tmp_probe.sql'
- expected: '0025_recognitions_persistence.sql'
    at migrationTriple (tests/integration/recognitions-pg.mjs:280:10)
exit=1
```

本机读数 R1 用「改前原文 + 临时 0026」复现了这条红（见 §3.2）。红点在第一个用例之前，与识别域业务流程无关——即使 PG 一切正常也必然失败。

### 1.2 根因

`tests/integration/recognitions-pg.mjs:280`（改前）把「迁移顺序」写成了**全局位置断言**：

```js
assert.equal(names[names.length - 1], MIGRATION, `${MIGRATION} 必须是当前最后一条（本片新增的就是末位）`);
```

`MIGRATION` 在 `tests/integration/recognitions-pg.mjs:43` 固定为 `0025_recognitions_persistence.sql`。仓库的迁移目录按文件名顺序发现（`readdir` + 数字前缀排序），**该断言要求「今天的最后一条永远是新文件」**：

- 本片（0025）落 main 后、任何切片追加 0026+ 之前，它暂时成立；
- 后续任一切片（语音转写、社区等，任务台账已明确在本片之后）一追加迁移，`names.at(-1)` 就变成新文件 → **0025 脚本立刻变红，并把该切片自身的合并锁死**；
- 反之，若 0025 尚未合入就有人先合入 0026，同样变红。**两条脚本互钉末位 = 谁先落 main 谁锁死另一条。**

这不是识别域业务问题，而是「顺序断言与新增迁移天然冲突」的测试设计缺陷；`#341` 已在 `tests/integration/ocr-jobs-pg.mjs` 按同一口径解除（见该文件当前注释），本 PR 是第二处、也是最后一处同类位置断言。

### 1.3 为什么不能靠「改数字」绕过

把 `MIGRATION` 改成某个「更大版本号」只是把锁往后推一格，问题原样保留；而删掉断言又会让「发现器静默漏项（比如 `readdir` 少读一层）」「编号错位」这类真故障漏网。因此只**删除位置约束、保留结构不变量**。

## 2. 改动

`tests/integration/recognitions-pg.mjs:276-285`（改后）：

```js
  const names = discovered.map((migration) => migration.filename);
  assert.equal(names.includes(MIGRATION), true, `${MIGRATION} 必须是顶层迁移的一部分`);
  // ⛔ 这里**不再**断言「本片迁移必须是当前末位」。0001..0025 是本片现状，后续切片（语音转写、社区等）必然
  //    追加更大版本号；一旦两条脚本都钉自己末位，谁先落 main 就把另一条锁红（#341 已在 `ocr-jobs-pg.mjs`
  //    按同一口径解除）。真正要守的结构不变量是上面三条（1..max 连续无缺号、count === max、含本片迁移）——
  //    它们对「新增迁移」自动放行，对「发现器静默漏项／编号错位」变红，且与「谁是末位」无关。本片迁移是否
  //    真被应用、对象是否真建出，由下面的 UP/ROLLBACK/REPLAY 三连与 `to_regclass` 结构断言逐条证明（不靠位置）。
  say(`[M0] 结构不变量：迁移 ${discovered.length} 个（0001..${String(max).padStart(4, '0')}）连续无缺号；count === max；含 ${MIGRATION}`);
```

保留的不变量（改后 `:276-279` 三条 assert + 本片迁移应用）：

| 不变量 | 代码位置 | 作用 |
| --- | --- | --- |
| 每个编号 1..max 连续出现 | `tests/integration/recognitions-pg.mjs:276`（`assert.deepEqual(missing, [])`） | 无缺号 |
| `count === max` | `tests/integration/recognitions-pg.mjs:277` | 发现数 = 最大编号（无跳号/漏项） |
| `names.includes(MIGRATION)` | `tests/integration/recognitions-pg.mjs:291` | 本片迁移确实在发现结果里 |
| 本片迁移真被应用、对象真建出 | `tests/integration/recognitions-pg.mjs:358`（UP）、`:376`（ROLLBACK）、`:287-291`（`to_regclass`） | 与「末位」无关的语义断言 |

改前位置断言在 `:280`；本节三处结构 assert 的行号是 GY-R28 当时的读数，经 #434 的迁移保留台账重构后现为 `:275-279`／`:285-289`／`:291`。

## 3. 手动取证

### 3.1 环境

本机独立 PostgreSQL 17（不经系统服务、不触碰既有实例）：

| 项 | 值 |
| --- | --- |
| 二进制 | `E:\GengYunCommander\.pg17\pgsql\bin`（PG 17.11 zip 分发包） |
| 数据目录 | `E:\GengYunCommander\.pg17\data-r28s29`（集群属性：`server_encoding=UTF8`、`postgres` 为唯一登录超级用户、`pg_hba` 全 `trust`；等价 `initdb -D <dir> -U postgres -A trust -E UTF8 --locale=C`，本轮另建全新集群（端口 55691）按此命令 from-zero 复验通过） |
| 端口 | `127.0.0.1:55642`（`postgresql.conf` 内 `port`/`listen_addresses`；起服也可用 `-o "-p 55642 -c listen_addresses=127.0.0.1"`） |
| 测试库 | `gengyun_recognitions_test`（每次跑前 `dropdb --if-exists --force` + `createdb`，脚本 `:653-654` 自身断言 `public` 0 张表） |
| 角色/权限 | **不需要任何 `gengyun_*` 角色**：脚本以连接串里的 `postgres`（集群超级用户）直连空库，自己应用迁移；从未执行 `deploy/postgres-cvm/sql/20-login-roles.sql`（该文件要求 `current_database()='gengyun'` 且 `GENGYUN_API_RUNTIME_PASSWORD` 为 48 位十六进制，在本库上按设计硬失败，exit 3） |
| 起服方式 | `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 直接拉 `postgres.exe -D <datadir> -p 55642 -c listen_addresses=127.0.0.1`（`postmaster.opts` 已留档；前台 `pg_ctl start` 会在 pwsh 管道下挂住，且杀 wrapper 会连带带走 postgres 子进程） |
| 连接串 | `RECOGNITIONS_PG_TEST_URL=postgres://postgres@127.0.0.1:55642/gengyun_recognitions_test` |

### 3.2 三次读数（同一环境、同一 DB 创建方式）

| # | 脚本状态 | 迁移目录状态 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| R1 | **改前**原文（= 基线 `56042f7` 工作区文件，尚未编辑） | 0001..0025 + 临时 `0026_r28s29_tmp_probe.sql`（26 个） | **红**：`AssertionError ... 必须是当前最后一条`，`actual '0026_r28s29_tmp_probe.sql'` vs `expected '0025_recognitions_persistence.sql'`，`:280`，`exit=1`，M0 未通过 | `.pg17\handoff\r28-s29-logs\s29-read1-before.log` |
| R2a | **改后** | 0001..0025 + 临时 `0026_r28s29_tmp_probe.sql`（26 个） | **绿**：`PASS 1: [M0] 结构不变量：迁移 26 个（0001..0026）连续无缺号；count === max；含 0025_recognitions_persistence.sql`，`共 30 条 PASS`，`ALL PASS`，`exit=0` | `.pg17\handoff\r28-s29-logs\s29-read2a-fake0026.log` |
| R2b | **改后**，临时迁移已删、`git status` 干净 | 0001..0025（25 个） | **绿**：`PASS 1: [M0] 结构不变量：迁移 25 个（0001..0025）连续无缺号；count === max；含 0025_recognitions_persistence.sql`，`共 30 条 PASS`，`ALL PASS`，`exit=0` | `.pg17\handoff\r28-s29-logs\s29-read2b-final.log` |

复跑补充（2026-10-21，复核提问时）：另建全新集群（`initdb` 于 `data-r28s29-repro`、端口 55691），`createdb` 空库后直接跑改后脚本 ⇒ `exit=0`、`共 30 条 PASS`、`ALL PASS`；跑前/跑后 `pg_roles` 完全一致（16 个内置角色 + `postgres`，**无任何 `gengyun_*` 角色**）。日志：`.pg17\handoff\r28-s29-logs\s29-repro-fromzero-20261021.log`、同目录 `pg_roles-fromzero-before.txt` / `-after.txt`。

R2a 是本次最关键的读数：**新迁移被追加后，0025 脚本依旧全绿**——正是本 PR 要买到的行为；R2b 证明删除断言没有把正常路径弄红。两次 `共 30 条 PASS` 说明正文断言（13 方法语义、UP→ROLLBACK→REPLAY 三连、关连接重开逐字节仍在、4 条负控制）一条没少。

### 3.3 临时文件纪律

`0026_r28s29_tmp_probe.sql` 只在 R1/R2a 期间存在，跑完即 `Remove-Item`；`git status` 全程只有 `M tests/integration/recognitions-pg.mjs`（提交前）。临时文件内容：

```sql
-- R28-S29 临时探针：只为验证 recognitions-pg.mjs 是否误钉「本片必须是末位」。用完即删，不得提交。
CREATE TABLE IF NOT EXISTS r28s29_tmp_probe (id integer);
```

## 4. 同类断言清点

`grep -rn "length - 1" tests/ tools/` 与 `grep -rn "本片新增的就是末位"` 的结果：

| 位置 | 用途 | 是否同类缺陷 |
| --- | --- | --- |
| `tests/integration/ocr-jobs-pg.mjs:256` | 注释，说明已按同一口径解除（#341） | 否（已解除） |
| `tests/integration/recognitions-pg.mjs:280` | 本 PR 删除的位置断言（现为注释） | **是（本 PR 修）** |
| `tools/verify-release-materials.mjs:266` | 报告里用 `migrations[length-1]` 报出末位迁移名，仅作信息 | 否（不作断言） |
| `tests/unit/release-materials-index.test.mjs:60` | down 文件数 = 迁移数 − 1，属正常语义 | 否 |
| `services/api/src/db/migrate.ts:51-80` | 发现器本身：只收顶层 `.sql`，按名排序后按版本号 `localeCompare` 再排；重复版本在 `:70-74` 抛错 | 否（被测对象，本身无末位概念） |
| `services/api/src/db/pg/recognitions-pg.mjs` | 业务 SQL 无迁移顺序依赖 | 否 |

结论：**没有第二条「本片必须末位」断言**；本 PR 后该模式清零。

## 5. 本机门禁（exit code）

工作树 `E:\GengYunCommander\wt-r28-s29`，在最终文件状态下重跑（日志见下表；`g1`→`g6` 六道全 0）：

| 门 | 命令 | 结果 | 关键计数 |
| --- | --- | --- | --- |
| g1 | `npm run lint` | exit 0 | `PASS tsc --noEmit`（services/api、apps/admin）+ 仓库卫生扫描 PASS |
| g2 | `node tools/verify-release-materials.mjs` | exit 0 | **15/15 项通过**（离线文档核验） |
| g3 | `npm run test:docs` | exit 0 | 研究记录校验 **5 通过 / 0 失败 / 4 legacy 已钉住**；`PASS docs/research 结构校验` |
| g4 | `node tools/verify-contract-status.mjs` | exit 0 | 覆盖 112 条契约操作；已装配 108；横切 8；形状错误 0 / 语义错误 0；中文表格一致 |
| g5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | exit 0 | **tests 6 / pass 6 / fail 0** |
| g6 | `node --test tests/unit/ci-integration-chain-structure.test.mjs tests/unit/integration-script-coverage.test.mjs` | exit 0 | **tests 13 / pass 13 / fail 0** |

日志：`E:\GengYunCommander\.pg17\handoff\r28-s29-logs\g1-lint.log`、`g2-release.log`、`g3-docs.log`、`g4-contract-status.log`、`g5-contract.log`、`g6-unit.log`（原始副本文档，另有首轮 `s29-gates.log`）。

说明：g1/g3/g4/g6 与本改动无直接关联，但按「跑完迁移相关改动后复核仓库级门禁」的惯例一并跑，结果表明本改动未引入跨域回归（尤其 `integration-script-coverage` 仍通过，说明新增/删除的断言没有破坏脚本覆盖台账）。契约状态脚本的 `implemented 13 / partial 95 / planned 4` 与基线一致（脚本只读文档，不受本改影响；记录在此便于交叉核对）。

## 6. 失败与未取得项（如实记录）

1. **首次 R2a 失败过，原因不在被测代码**：用 `Set-Content -Encoding utf8` 生成临时迁移时写入了 BOM，PG 抛 `error: syntax error at or near "﻿" (42601)`。改用 `[System.IO.File]::WriteAllText(..., new UTF8Encoding($false))` 重写后通过。仓库内文件无 BOM（`tools/lint-workspaces.mjs` 卫生扫描通过），此坑只存在于探针生成方式。
2. **未在本机跑真实 `npm run migrate` 全量迁移**：脚本直接 `readSql(UP)` 应用 SQL，不写 `schema_migrations`；「迁移台账与实际对象一致」由仓库既有 `npm run` 迁移链测试在 CI 覆盖，本 PR 不改变迁移行为。
3. **未验证远端 CI、未在 GitHub runner 上跑、未在真实 CVM 上跑**：本机全绿不等于远端绿；工作流未改，是否需要 PR 由指挥决定（本写手未 push、未建 PR）。临时 0026 只是本地模拟，不代表真实切片迁移。
4. **未覆盖并发/故障注入**：临时 0026 只验证「追加新迁移后旧脚本仍绿」，不涉及并发追加、迁移中断、`schema_migrations` 冲突。
5. **首轮门禁日志编码问题**（见 §5 说明）：首轮用 `*>>` 重定向产生 UTF-16LE 日志，我的读取工具按 ANSI 解出乱码；退出码仍是 0。随后改用 `cmd /c ... > log 2>&1` 重跑并解码，表内计数取自第二轮。
6. **本片不验证授权/最小权限**：识别域四表的 GRANT 在 `deploy/postgres-cvm/sql/20-login-roles.sql` J 段，识别脚本不执行它、也不以运行时角色连接；本页与 R1/R2 的任何绿都不构成「运行时授权已验收」。

## 7. 基线与 rebase

- 本工作树原基线 `c06d232`；收到指挥通知后 `git fetch upstream`（`upstream` = `https://github.com/GengYunChuChao/GengYun.git`，与 `origin` 同址；本分支 rebase 前无本地提交），`git rebase upstream/main` **fast-forward 到 `56042f7`**（无冲突）。
- `56042f7` 与 `c06d232` 的差异 4 个文件全在 deploy/证据目录，**不含** `tests/integration/recognitions-pg.mjs`（已核 `git diff --name-only c06d232..56042f7`）。
- 因此本文所有读数、门禁均在 `56042f7` 上取得；未产生二次 rebase。

## 8. 复现

```powershell
$bin = 'E:\GengYunCommander\.pg17\pgsql\bin'
# 0) 全新一次性集群（可选；也可复用 55642 的集群，只要库是空的）
$dir = 'E:\GengYunCommander\.pg17\data-repro'
& "$bin\initdb.exe" -D $dir -U postgres -A trust -E UTF8 --locale=C
# 起服：必须“脱离”，前台 pg_ctl start 在 pwsh 管道下会挂住
$port = 55691
$cmd = "`"$bin\postgres.exe`" -D `"$dir`" -p $port -c listen_addresses=127.0.0.1"
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd} | Out-Null
& "$bin\pg_isready.exe" -h 127.0.0.1 -p $port   # 等到 accepting

# 1) 每次跑前：空库（脚本 :653-654 断言 public 0 张表）
& "$bin\dropdb.exe"  -h 127.0.0.1 -p $port -U postgres --if-exists --force gengyun_recognitions_test
& "$bin\createdb.exe" -h 127.0.0.1 -p $port -U postgres gengyun_recognitions_test
$env:RECOGNITIONS_PG_TEST_URL = "postgres://postgres@127.0.0.1:$port/gengyun_recognitions_test"

# 2) R1（红）：用基线原文 + 临时 0026
git show 56042f7:tests/integration/recognitions-pg.mjs > tests/integration/recognitions-pg.mjs
[System.IO.File]::WriteAllText('services\api\db\migrations\0026_r28s29_tmp_probe.sql',
  "CREATE TABLE IF NOT EXISTS r28s29_tmp_probe (id integer);`n", [System.Text.UTF8Encoding]::new($false))
node tests/integration/recognitions-pg.mjs   # 期望 exit=1，AssertionError 必须是当前最后一条（:280）

# 3) R2a（绿）：换回改后文件，临时 0026 仍在
git checkout -- tests/integration/recognitions-pg.mjs   # 或 git stash pop
node tests/integration/recognitions-pg.mjs   # 期望 exit=0：[M0] 迁移 26 个，共 30 条 PASS

# 4) R2b（绿）：删临时迁移后再跑
Remove-Item services\api\db\migrations\0026_r28s29_tmp_probe.sql
node tests/integration/recognitions-pg.mjs   # 期望 exit=0：[M0] 迁移 25 个，共 30 条 PASS

# 5) 收尾
& "$bin\pg_ctl.exe" -D $dir -m fast -w stop
```

注意：

- 脚本用连接串里的 `postgres` 直连（本机 `trust`），**不需要** `gengyun_api_runtime` / `gengyun_cvm_owner`，也不需要执行 `20-login-roles.sql`；该文件在 `gengyun_recognitions_test` 上会因 `current_database() <> 'gengyun'` 硬失败（实测 exit 3），不要把它塞进本复现。
- 迁移由脚本自己按 `discoverMigrations()` 顺序 `readSql` 应用，**不写 `schema_migrations` 台账**，也不经过 `npm run migrate`。
- DB 名被脚本钉死为 `gengyun_recognitions_test`（`:63` 断言 `url.pathname`），换库名会直接失败。

## 9. 结论与边界

- 改后：迁移目录**追加新文件不再让 0025 脚本变红**（R2a 直接证明），正常 25 迁移路径仍全绿（R2b），30 条正文断言一条未减。
- 保留的 `count === max`、连续无缺号、`includes(MIGRATION)` 三条结构不变量仍能抓住「发现器漏项 / 编号错位」；本片迁移被应用与否由 UP/ROLLBACK/REPLAY 与 `to_regclass` 断言独立证明，不依赖位置。
- 本页只证明「测试断言缺陷已解除」这一件事；不声明识别域整体验收通过，也不替代远端 CI 与集成验收。

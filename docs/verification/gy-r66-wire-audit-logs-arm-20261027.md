# R66 · 真库臂 `admin-audit-logs-pg` 接进 real-PG 作业（2026-10-27）

分支 `feat/gy-r66-wire-audit-logs-arm`，基 `e2d78919c8b378de7b809aadd9c50b2fcca167ae`（main，`Run post-hide audit database checks in CI (#657)`），
单提交；⛔ 不 push、不建 PR、不合并。本页读数取自**提交前工作树**（HEAD 仍是 `e2d78919` + 四个文件的工作区改动：
workflow、两份守卫用例、被验证臂、本页）。

## 1. 结论摘要

- **接线完成**：`.github/workflows/real-pg-integration.yml` 的 `real-pg-17.11` job 里新增一个 step，
  位置 `.github/workflows/real-pg-integration.yml:708-714`（注释块 `:684-707`），夹在
  `third-party-deletion-sql-pg`（`:677-683`）与识别端到端链路（`:715` 起注释、`:728` 起 step）之间。
  job 的 step 数 **34 → 35**（真 YAML 解析读数见 §4）。⛔ 无 `continue-on-error`、无 `|| true`，77 绝不当通过。
- **该臂属于「自起集群」族**（自己 `initdb` 出一次性 17 集群、端口 `55436–55467` 先探活再起、自建库、
  跑完 `pg_ctl stop` 并删**数据目录**——`server.log` 随目录删，工具日志 `gy-r34-audit-logs-pg-tools.log` 写在
  root 下、按设计**不删**、留着取证，见 §2.1 最后一条）⇒ 判据⑦⑧ 换成 `ci-real-pg-wiring.test.mjs` 的 `SELF_CLUSTERED_SCRIPTS`＋
  `SELF_CLUSTERED_ROOT_KEY` 那套等价判据，**不给** owner URL、**不建** CI 的库。
- **五张清单全部登记**：`MANAGED_SCRIPTS`（`:165`）、`FROZEN_MANAGED_SCRIPTS`（`:219`，与前者同相对位置）、
  `REQUIRED_STEP_ORDER`（`:460`，第 15f 条，顺序＝workflow 实际执行顺序）、`SELF_CLUSTERED_SCRIPTS`（`:526`）、
  `SELF_CLUSTERED_ROOT_KEY`（`:569`，`GY_R34_PG_ROOT`）。**既有断言一个字未改**。
- **未接线登记表**：`tests/unit/ci-integration-chain-structure.test.mjs` 里那条**保留**（条数仍 53），
  只把 `reason` 改成当时态：已接进 `real-pg-17.11` 的自起集群 step、因需真 PG 故不进回环链（§3.3）。
  该条目仍是**等行数替换**（文件 738 → 738 行，`git diff --numstat` 读数 `9 9`）。
- **顺手修掉臂的收尾 bug**（§2.3，本片自己的复盘发现、追加指令要求修）：`closeSync(logFd)` 原本排在
  `stopCluster()` 之前，导致 `pg_ctl stop` 每次都以 `status=null / error.code=EBADF` 静默失败，
  **一次也没真正停过集群**。修法两条：fd 关到收尾之后（`tests/integration/admin-audit-logs-pg.mjs:826`）；
  `stopCluster()` 现在判 `stop.error || stop.status !== 0` ⇒ 抛 `pg_ctl stop 失败：…`，整臂非 0 退出
  （`tests/integration/admin-audit-logs-pg.mjs:216-221`）。同时把 `:275-277` 那句「本文件未接入」改成了当时态。
- **CI 首轮红：POSIX unix socket**（§5.4，接进去以后第一次真跑就暴露）：Debian/Ubuntu 的
  `postgresql-17` 把 `unix_socket_directories` 编译默认钉在 `/var/run/postgresql`，runner 普通用户写不了
  ⇒ 32 个候选端口全部 `FATAL: could not create lock file "/var/run/…"`。修法是照兄弟臂同法定修：
  `serverOptions()` 在非 win32 上追加 `-k ${dataDir}`。**这是「只在 Windows 自测过的臂搬上 Linux」必然
  撞上的宿主机差异，不是本片引入的新缺陷**；Linux 侧真值已由 CI 给出，见 §5.5（21/21 success）。
- **本机真库手跑（修后）**：PG 17.11 / 端口 55436 / 独立数据根 `E:\GengYunCommander\.pg17\tmp\r66-arm2`，
  `node tests/integration/admin-audit-logs-pg.mjs` ⇒ **exit 0**，11 条 ✓，末行
  `真库臂 PASS：读通道的 SQL、权限、键集、筛选、脱敏全部在真 PG 17.11 上取得读数。`，含
  `规模：表内 20009 行` 与三条 EXPLAIN 读数；**全自动收尾**：`postgres` 进程 **0**、集群目录**不存在**、
  55436 **不监听**，工具日志出现 `waiting for server to shut down.... done` / `server stopped`
  （修前那条 ⚠ `临时集群目录未能删除` 不再出现）——原文见 §5、§5.2。
- **三条守卫**：`ci-real-pg-wiring` 18/18、`ci-integration-chain-structure` 7/7、
  `migration-subset-coverage-pins` 10/10，合计 `tests 35 / pass 35 / fail 0`，全部 exit 0（§4）。
- **负控制两条**：① 把新增 workflow step 整块（`:684-714`）注释掉 ⇒ `ci-real-pg-wiring.test.mjs`
  **exit 1**、`tests 18 / pass 8 / fail 10`，四条判据逐条点名本脚本，按字节还原后复绿 18/18（§6.1）；
  ② 把 `closeSync` 挪回收尾之前（复原 bug）⇒ 臂 **exit 1**、报
  `清理临时集群失败：pg_ctl stop 失败：EBADF …`，且残留 `postgres` **6** 个 / 目录在 / 55436 在监听，
  按字节还原（SHA256 前后相同）后复跑 exit 0 + 三项自动收尾正常（§6.2）。

## 2. 改了什么

| 文件 | `git diff --numstat` | 关键改动 |
| --- | --- | --- |
| `.github/workflows/real-pg-integration.yml` | `31 0`（718 → 749 行） | `:684-707` 24 行注释块 + `:708-714` 新 step；夹在 `third-party-deletion-sql-pg` 与识别链路之间 |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `34 0`（2241 → 2275 行） | 五张清单各登记一处：`:165`／`:219`／`:449-459`+`:460`／`:521-525`+`:526`／`:562-568`+`:569` |
| `tests/unit/ci-integration-chain-structure.test.mjs` | `9 9`（738 → 738 行，**等行数替换**） | `UNWIRED_DECLARATIONS` 里 `:104-118` 条目**保留**、只改 `reason`；条数仍 53 |
| `tests/integration/admin-audit-logs-pg.mjs` | `21 5`（657 → 673 行） | 收尾顺序 bug 修复（`:210`、`:216-221`、`:672`）+ 两处注释改当时态（`:275-277`、`:10-11`），详见 §2.3 |
| `docs/verification/gy-r66-wire-audit-logs-arm-20261027.md` | 新文件 | 本页 |

### 2.1 workflow（`.github/workflows/real-pg-integration.yml:708-714`）

```yaml
      - name: 审计读面（#34 / 迁移 0033 的 list_admin_audit_logs / 键集 / 筛选 / 脱敏 / 权限形状）
        timeout-minutes: 5
        run: node tests/integration/admin-audit-logs-pg.mjs
        env:
          GY_PG_BIN: /usr/lib/postgresql/17/bin
          GY_R34_PG_ROOT: ${{ runner.temp }}/gy-r34-pg
          PGCLIENTENCODING: UTF8
```

字段顺序（`name` → `timeout-minutes` → `run` → `env`）照邻居 `.github/workflows/real-pg-integration.yml:677-683`；
`timeout-minutes: 5` 与 `PGCLIENTENCODING: UTF8` 也与它一致。逐条要点：

- `:710` 只有一条 `run`，**没有** `psql … CREATE DATABASE`、没有 `set -euo pipefail` 包壳、没有 `|| rc=$?`：
  这条臂自己建库（`tests/integration/admin-audit-logs-pg.mjs:243` `CREATE DATABASE ${DB_NAME}`，
  库名 `gengyun_r34_audit_logs_test` 在 `:41` 硬钉），CI 那套「先建库再 node」的判据对它没有对象。
- `:712` `GY_PG_BIN` 必给：runner 上 `initdb`/`pg_ctl` 不在 PATH，而脚本第一步就是 `initdb`
  （`tests/integration/admin-audit-logs-pg.mjs:162-164`）。装包 step 在 `.github/workflows/real-pg-integration.yml:521-536`（其注释块 `:507-520`），
  故本 step 必须排在它之后（现在是第 34 个 step）。
- `:713` 数据根键 `GY_R34_PG_ROOT`：与 `retention-purge-pg` 那条同键（源码唯一取值点
  `tests/integration/admin-audit-logs-pg.mjs:64` `process.env.GY_R34_PG_ROOT ?? tmpdir()`），两条各自在 root 下
  建自己的子目录 ⇒ 共用 `${{ runner.temp }}/gy-r34-pg` 是允许的，⛔ 不是同目录。
- `:714` `PGCLIENTENCODING: UTF8`：邻居都有；这臂的读数里有中文断言消息，且它自己 `--encoding=UTF8` 建库
  （`tests/integration/admin-audit-logs-pg.mjs:194`），客户端编码不设会让 psql/驱动口径与库不一致。
- **收尾删什么、留什么**（别读成「删了两份日志」）：脚本收尾先 `pg_ctl stop`、再删**数据目录**，
  `server.log` 在数据目录里（`tests/integration/admin-audit-logs-pg.mjs:203`）⇒ 随目录一起没；
  工具日志是 `openSync(join(rootDir, 'gy-r34-audit-logs-pg-tools.log'), 'a')`
  （`tests/integration/admin-audit-logs-pg.mjs:70-72`）写在 **rootDir** 下的固定文件名、append 模式，
  而 `stopCluster()` 只删 `dataDir` ⇒ 工具日志**从来不会被删**，作为取证留在 root 下
  （本机实测：`r66-arm2` 跑完 `E:\GengYunCommander\.pg17\tmp\r66-arm2` 里只剩它一个文件）。

### 2.2 五张清单（`tests/unit/ci-real-pg-wiring.test.mjs`）

| 清单 | 行 | 加了什么 |
| --- | --- | --- |
| `MANAGED_SCRIPTS` | `:165`（注释 `:160-164`） | `'tests/integration/admin-audit-logs-pg.mjs'`，紧挨 `admin-post-hide-audit-pg`（同一审计域的写/读两面） |
| `FROZEN_MANAGED_SCRIPTS` | `:219` | 同一条目，与 `MANAGED_SCRIPTS` **同相对位置**（两份必须同集合） |
| `REQUIRED_STEP_ORDER` | `:460`（注释 `:449-459`） | 第 **15f** 条，排在 `third-party-deletion-sql-pg`（15e）之后、`recognition-chain-e2e`（16）之前 |
| `SELF_CLUSTERED_SCRIPTS` | `:526`（注释 `:521-525`） | 进「自起集群」豁免集：判据⑦⑧ 换成等价判据 |
| `SELF_CLUSTERED_ROOT_KEY` | `:569`（注释 `:562-568`） | `'tests/integration/admin-audit-logs-pg.mjs': 'GY_R34_PG_ROOT'` |

`REQUIRED_STEP_ORDER` 的 15f 条与 workflow 实际执行顺序逐条对齐（这是该清单的判据⑥：每条脚本必须落在
不同的 step 里、且顺序与清单一致）。`SELF_CLUSTERED_ROOT_KEY` 那条注释说明了「与 `retention-purge-pg`
同键但⛔ 非同目录」：本臂数据目录是 `<root>/gy-r34-audit-logs-pg-<端口>-<6 位 hex>`（`:160`），日志是同一 root 下
**固定文件名** `gy-r34-audit-logs-pg-tools.log`（`:66`，append 模式）⇒ 即使两个 step 共用 root 也只是追加、不覆盖。

### 2.3 修臂：收尾顺序 bug + POSIX socket（`tests/integration/admin-audit-logs-pg.mjs`，`34 6`）

五处改动，逐条给行号（前四处是代码，第五处只动头注释）：

1. **`:210`、`:216-221`**：`pg_ctl … stop` 的返回值不再是「调了就算」，而是取出来判：
   `const stop = runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { timeout: 60_000 });`
   → `if (stop.error || stop.status !== 0) { … throw new Error(\`pg_ctl stop 失败：${reason}（目录 ${dataDir}，需人工清理）\`); }`。
   抛出点被 `finally` 里的 `catch`（`:663-665`）接住 ⇒ 打 `清理临时集群失败：…` 并置 `process.exitCode = 1`，
   **不会再静默**。`:211-215` 是把机制写进源码的注释（EBADF 不抛错、`status` 为 `null`、只看/不看返回值的后果）。
2. **`:672`**：`closeSync(logFd)` 从「`stopCluster()` 之前」移到**收尾之后**（`:655` 起的 `finally` 末尾），
   并在 `:668-671` 写明为什么必须这个顺序：`runTool`（`:70-77`）把这个 fd 直接当 `pg_ctl`/`postgres` 的
   stdout/stderr（`stdio: ['ignore', logFd, logFd]` 在 `:72`），提前关掉 ⇒ `spawnSync` 拿到 `EBADF` 且不抛错。
   最小改动、也最不容易再把 bug 带回来（不需要给 stop 单开 fd，也不改 `runTool` 的签名）。
3. **`:153-163` 新增 `serverOptions(candidate, dir)`，`:185` 的 `pg_ctl -o` 改用它**（CI 首轮红后加的，
   见 §5.4）：`process.platform !== 'win32'` 时往 `-o` 里追加 `-k ${dir}`。原因：Debian/Ubuntu 的
   `postgresql-17` 把 `unix_socket_directories` 编译默认钉成 `/var/run/postgresql`，runner 普通用户
   写不了 ⇒ 连 lock file 都建不出来、`pg_ctl start` 直接 FATAL。兄弟臂（`retention-purge-pg` /
   `media-row-purge-pg` / `messages-purge-pg` / `backup-purge-pg` / `user-chain-e2e`）都有这条，本臂原先漏了
   —— 它只在 Windows 上跑过，而 Windows 不用 unix socket。
4. **`:275-277`**：把「而本文件未接入 `.github/workflows/real-pg-integration.yml`，没有 CI 来提醒」改成
   「当时本文件**尚未**接入 …（R66 起它已是 `real-pg-17.11` job 里的一步：钉旧了 CI 直接红，这条注释退回
   『演进史』用途。）」——口径变假的原因（`:284` 的版本钉 `0047` 现在由 CI 把关）也写进去了。
5. **`:10-11`（只动头注释，行数不变）**：原文「收尾 `pg_ctl stop` + 删目录」容易被读成「日志也删了」，
   改成「收尾 `pg_ctl stop` + 删**数据目录**（`server.log` 随目录删；工具日志在 root 下、不删、取证用）」——
   与 workflow 注释块、本页 §2.1 最后一条同口径：**只有数据目录（含 `server.log`）被删，
   `gy-r34-audit-logs-pg-tools.log` 从来不会被删**。

⛔ 除这五处外没有碰这条臂：所有断言、造数、SQL、端口探测、`migrate.ts up` 调用、读面检查一字未动
（`git diff -U0` 只有这九个 hunk：`@@ -10,2 +10,2 @@`、`@@ -151,0 +152,6 @@`、`@@ -152,0 +159,6 @@`、
`@@ -173 +185 @@`、`@@ -210 +222,12 @@`、`@@ -264 +287 @@`、`@@ -265,0 +289 @@`、
`@@ -646 +669,0 @@`、`@@ -656,0 +680,5 @@`；合计 `34 6`）。

## 3. 判据为什么这样定

### 3.1 为什么走「自起集群」等价判据，而不是「CI 建库 + 连接串 env」

`ci-real-pg-wiring.test.mjs` 的判据⑦⑧ 盯的是「同一 step 内先 `CREATE DATABASE <库名>` 再
`node … <同一库名>`」这条形态。本臂不适用：它自己 `initdb`（`tests/integration/admin-audit-logs-pg.mjs:162-164`）、
自己建库（`:243`）、端口从 `55436–55467` 里**先探活再起**（`:155-159` 逐个 `portBusy` 探测，`:202` 全不可用则抛出
`55436–55467 内没有可用端口：…`）、只监听 `127.0.0.1`（`:173` `-c listen_addresses=127.0.0.1`）。
硬套判据⑦⑧ 只有两种结果：要么在 step 里写一条假的 `CREATE DATABASE`（假绿通道，守卫明写出现它就判红），
要么把真库 job 拆成 owner URL 形态（那是改臂形态，本片不做）。

故登记进 `SELF_CLUSTERED_SCRIPTS` 走等价判据（`tests/unit/ci-real-pg-wiring.test.mjs:460-473` 的块注释是这套
豁免的口径说明）：① 必须给 `GY_PG_BIN` 且形如 `…/bin`；② 必须给出**该脚本自己读的**根键
（`detectedRootKeys()` 从源码取真值交叉核对，给错键／只给装饰性 env 都判红）；③ step 里**不得**出现
`CREATE DATABASE`；④ 没有 `continue-on-error`／`|| true` 吞红。本 step 三条都满足，且第 ③ 条在这里是**正向
要求**：紧跟其后的识别链路 step 才会 `CREATE DATABASE`（`.github/workflows/real-pg-integration.yml:731`）。

### 3.2 为什么 `GY_R34_PG_ROOT` 与 `retention-purge-pg` 同键却安全

`GY_R34_PG_ROOT` 是脚本唯一取值点（`:64`），`retention-purge-pg` 也读同一个键。两者**不共享目录**：
本臂用 `<root>/gy-r34-audit-logs-pg-<端口>-<hex>`，`retention-purge-pg` 用它自己的子目录名；日志文件名也不同。
代价只有一个：同一个 root 下会多出两个不同的子目录 + 两份不同的日志文件，`runner.temp` 是每 job 一次性目录，
job 结束即随 runner 丢弃。⛔ 若将来有脚本把**同一目录名**写进同一个 root，那条才是冲突（届时再分 root 不迟）。

### 3.3 为什么 `UNWIRED_DECLARATIONS` 那条**保留**、不删（条数仍 53）

判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链，**真库 job 不算接线**——回环链里既没有真 PG、
也没有 `initdb`/`pg_ctl`，真库臂永远进不了那条链。R65 已在这个坑上踩过（`admin-post-hide-audit-pg.mjs` 条目
的措辞就是这么写的），故本片只把 `reason` 改成当时态：已接进 `real-pg-17.11` 的自起集群 step、因需真 PG 故不进回环链，
并点明「判据 4 只认 `test:integration:http`」这一口径。**没有**为了删条目去放宽判据 1–6 一个字。

「workflow 真的跑它」这件事由 `ci-real-pg-wiring.test.mjs` 的五张清单强制——§6.1 的负控制逐条点名了本脚本，
所以「接了线但 nobody 跑」这类静默缺口在这条 workflow 上是红的。

## 4. 守卫读数（改后复跑）

| 命令 | 结果 |
| --- | --- |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs` | `tests 18 / pass 18 / fail 0`，exit 0 |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | `tests 7 / pass 7 / fail 0`，exit 0 |
| `node --test tests/unit/migration-subset-coverage-pins.test.mjs` | `tests 10 / pass 10 / fail 0`，exit 0 |
| 上面三条一起跑 | `tests 35 / pass 35 / fail 0`，exit 0（修臂后复跑仍同读数） |
| 真 YAML 解析 step 数（js-yaml，见 §7.2） | 改前 `real-pg-17-11` job `steps=34` → 改后 `steps=35` |
| `node tools/verify-doc-anchors.mjs --strict --scan docs` | exit 0；`COUNT: BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7`；`BASELINE 登记 13 条；命中 13、基线外新增 0、陈旧 0`；`PASS` |
| `node tools/verify-contract-status.mjs` | exit 0（行号区间 305 条全部 PASS、中文表格一致；台账未改） |
| `node tools/openapi-route-parity.mjs` | exit 0（`extra`／`missing`／`ledgerDrift` 全空） |
| `node tools/verify-migrations-unique.mjs` | exit 0（45 条配对 + 1 条登记允许缺省 = 46 条正向迁移） |
| `python tools/validate_contracts.py` | exit 0（124 operations；29 fixtures；30 media traces） |
| `python tools/validate_development_docs.py` | exit 0（27 initial tasks；依赖无环） |

`UNWIRED_DECLARATIONS` 条数用 `Select-String -Encoding utf8` 数 `^    path: ` 得 **53**，与改前一致。

## 5. 本机真库手跑（PG 17.11 / 端口 55436）

### 5.1 修臂前的那次跑（历史读数，用于对照）

环境：`$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'`、
`$env:GY_R34_PG_ROOT='E:\GengYunCommander\.pg17\tmp\r66-arm'`，在 `E:\GengYunCommander\wt-r66-wire` 下
`node tests/integration/admin-audit-logs-pg.mjs` ⇒ **exit 0**（读数全对，但收尾是坏的，见 §5.3）。读数原文（原样）：

```
  · 临时集群：E:\GengYunCommander\.pg17\tmp\r66-arm\gy-r34-audit-logs-pg-55436-368a50，端口 55436（仅 127.0.0.1）
  · server_version = 17.11
  ✓ 迁移 0047 经 migrate.ts up 落到真库（schema_migrations 末项 0047）
  ✓ 部署授权段 gy-r34-audit-logs-grant 原样执行通过（存在性检查 + REVOKE PUBLIC + GRANT 运行时）
  ✓ 造数 6 行（三写入点形状 + 键集并列 + 时间窗外 + target_ref 夹带多余键）
  ✓ 权限：运行时零表级 SELECT、函数 EXECUTE 已授予、未授权角色被拒（负向对照）
  ✓ 运行时直查表被数据库拒（SQLSTATE 42501），读面只能走函数
  ✓ 条数与顺序：6 行，created_at DESC + id DESC（并列组 id 大者在前）
  ✓ 键集翻页：3 页收全 6 行，顺序一致、无重复、末页 next_cursor 为 null
  ✓ 时间区间：from 排除窗口外 1 行（5 行），from+to 闭区间取到 2 行
  ✓ 事件类型：action=account.suspend 取 1 行；entity=flag 取 3 行、entity=account 取 3 行
  ✓ 脱敏：target_ref 只留 type/id/revision；无 ip / user_agent / 凭据字段；actor_id 映射为 actor
  ✓ 同毫秒不同微秒：微秒位置翻页收全 3 行；毫秒位置复现漏行（下一页 0 行），微秒位置取回 a002
  · 规模：表内 20009 行（含 9 行夹具：6 行基础夹具 + 3 行同毫秒不同微秒）
  · 首页无筛选：9.59ms，plan=Function Scan
  · action 过滤（约 2%）：3.07ms，plan=Function Scan
  · 深翻页（键集，第 200 页）：2.89ms，plan=Function Scan
真库臂 PASS：读通道的 SQL、权限、键集、筛选、脱敏全部在真 PG 17.11 上取得读数。
```

11 条 ✓（`tests/integration/admin-audit-logs-pg.mjs:297`、`:302`、`:398`、`:416`、`:426`、`:468`、`:485`、`:499`、
`:519`、`:539`、`:608` 各一条），末行由 `tests/integration/admin-audit-logs-pg.mjs:817` 打印；
规模读数在 `:625`（`generate_series(1, 20000)` 见 `:621`，加 9 行夹具 ⇒ 20009），三条 EXPLAIN 在 `:636` 循环里。

耗时口径：工具日志 `gy-r34-audit-logs-pg-tools.log` 的时间戳跨度 **5.0 s**（`14:50:35.280` → `14:50:40.286`，
覆盖 `initdb` + 46 个迁移 + 造数 + 读数），另加收尾 ⇒ 整臂 ≈ 20 s，故 `timeout-minutes: 5` 有余量。

### 5.2 修臂后的自证（全自动收尾，无任何手工步骤）

命令（同一条，仅换一个干净的 root）：`$env:GY_R34_PG_ROOT='E:\GengYunCommander\.pg17\tmp\r66-arm2'` ⇒
`node tests/integration/admin-audit-logs-pg.mjs`。读数：

```
NODE_EXIT=0
✓ 条数 = 11
postgres 进程数 = 0
集群目录残留 = 0
55436 监听 = 0
收尾日志尾 3 行 = 已存在跳过：（无） | waiting for server to shut down.... done | server stopped
失败/警告匹配数 = 0        ← 日志里不再有「临时集群目录未能删除 / pg_ctl stop 失败 / 清理临时集群失败」
```

`r66-arm2` 跑完后 root 里**只剩** `gy-r34-audit-logs-pg-tools.log`：数据目录（含 `server.log`）已随
`stopCluster()` 删除；工具日志按设计**本来就不删**——它 `openSync(join(rootDir, 'gy-r34-audit-logs-pg-tools.log'), 'a')`
（`tests/integration/admin-audit-logs-pg.mjs:70-72`）写在 rootDir 下，而 `stopCluster()` 只删 `dataDir`，
所以「只剩它一个」是**正确的收尾结果**，不是残留（§2.1 最后一条）。
读数规模与修前一致（11 条 ✓、`规模：表内 20009 行`、三条 EXPLAIN：`8.08ms`／`3.02ms`／`2.96ms`）。
**全程没有手工 `pg_ctl stop`、没有手工删目录**——这也是 §6.2 负控制成立的前提。

### 5.3 收尾：机制、修前修后对照

**机制**（修前为什么会坏）：`stopCluster()` 里的 `pg_ctl -m immediate -w stop` 是通过 `runTool`（`:70-77`）
拿 `stdio: ['ignore', logFd, logFd]` 跑的，而修前的 `finally` 在调用 `stopCluster()` **之前**就
`closeSync(logFd)` 了。给 `spawnSync` 一个已关闭的 fd **不会抛错**，只把失败塞进返回值的 `error`
（`status` 为 `null`）——而修前的代码根本不看返回值，于是 `pg_ctl stop` 从未执行、返回码被丢弃。
后果不是「只删不掉」而是「集群没停 + 目录删不掉」：`postmaster.pid` 轮询与 10 次 `rmSync` 重试
（`:225`、`:229`）白等到超时，最后打一句 ⚠（`:237`）就结束，`process.exitCode` 仍是 0。

**修前现场读数**（`r66-arm`，2026-10-27 本轮）：

```
跑完 Get-Process postgres = 6        （集群仍在跑）
集群目录 gy-r34-audit-logs-pg-55436-368a50 仍在
stderr: ⚠ 临时集群目录未能删除（句柄滞留，不影响读数）：…\gy-r34-audit-logs-pg-55436-368a50
工具日志里**没有** `server stopped`（pg_ctl stop 根本没跑）
```

**修后对照读数**（`r66-arm2`／复跑 `r66-arm4`，同为一条命令）：

```
Get-Process postgres = 0
集群目录 = 不存在（残留 0 个）
55436 监听 = 0
工具日志末尾：waiting for server to shut down.... done / server stopped
node exit = 0，11 条 ✓
```

**修法**（两处，互为保险）：① `closeSync(logFd)` 移到收尾之后（`:672`，注释 `:668-671`）；
② `stopCluster()` 判 `stop.error || stop.status !== 0` 并抛 `pg_ctl stop 失败：…`（`:216-221`，注释 `:211-215`），
由 `finally` 的 `catch`（`:663-665`）接住 ⇒ `process.exitCode = 1`。即便将来有人又把 fd 提前关掉，
第 ② 条也会让臂当场红，而不是像修前那样留一个每次都泄漏的 CI step。

### 5.4 POSIX unix socket：CI 首轮红与修法

接进 CI 后**第一次真跑就红**（head `4defd650`，workflow run `40465073598`、job `122058394602`，
失败 step 就是本片新加的「审计读面…」）。日志原文（`gh api …/actions/jobs/122058394602/logs`）：

```
真库臂 FAIL： 55436–55467 内没有可用端口：55436:… FATAL:  could not create lock file "/var/run/
55437:… FATAL:  could not create lock file "/var/run/     （55436…55467 共 32 个候选同一句）
    at startCluster (tests/integration/admin-audit-logs-pg.mjs:202:9)
##[error]Process completed with exit code 1.
```

根因：Debian/Ubuntu（含 PGDG 的 `postgresql-17`）把编译默认 `unix_socket_directories` 钉成
`/var/run/postgresql`，runner 的普通用户写不了该目录 ⇒ `pg_ctl start` 连 lock file 都建不出来。
本臂此前**只在 Windows 上跑过**（Windows 不用 unix socket），所以这条一直没暴露——它不是本片引入的
新缺陷，而是「把只在 Windows 自测过的臂搬上 Linux」必然撞上的宿主机差异。

兄弟臂早就写了这条（同一行 `-k` 在 `tests/integration/{retention-purge-pg,media-row-purge-pg,
messages-purge-pg,backup-purge-pg,user-chain-e2e}.mjs` 里都有），本臂漏了。修法：新增
`serverOptions(candidate, dir)`，`process.platform !== 'win32'` 时追加 `-k ${dir}`，`pg_ctl -o` 改用它。

修后本机复跑（Windows，`-k` 分支不生效 = 等价无回归）：`node tests/integration/admin-audit-logs-pg.mjs`
⇒ exit 0、11 条 ✓、`Get-Process postgres` = **0**、集群目录已删。**Linux 侧的真值只能由 CI 给**——
因此本条不写「已验」，只写「已知原因 + 已按兄弟臂同法定修」，绿了以后再回填 §5.5。

### 5.5 CI 复跑：Linux 侧真值（21/21 success）

修好 §5.4 之后 push 的新 head `7f4d5914`：`Real PostgreSQL integration gates` run `40466389079`、
job `122062702888`（`real-pg-17.11`）**success**，其中本片新加的 step「审计读面（#34 / 迁移 0033 的
`list_admin_audit_logs` / 键集 / 筛选 / 脱敏 / 权限形状）」**success**；该 head 全仓 **21/21 check 全 success**。
step 日志原文（节选，`gh api …/actions/jobs/122062702888/logs`）：

```
  · 临时集群：/home/runner/work/_temp/gy-r34-pg/gy-r34-audit-logs-pg-55436-8033af，端口 55436（仅 127.0.0.1）
  · server_version = 17.11 (Ubuntu 17.11-1.pgdg24.04+2)
  ✓ 迁移 0047 经 migrate.ts up 落到真库（schema_migrations 末项 0047）
  ✓ 部署授权段 gy-r34-audit-logs-grant 原样执行通过（存在性检查 + REVOKE PUBLIC + GRANT 运行时）
  ✓ 造数 6 行（三写入点形状 + 键集并列 + 时间窗外 + target_ref 夹带多余键）
  ✓ 权限：运行时零表级 SELECT、函数 EXECUTE 已授予、未授权角色被拒（负向对照）
  ✓ 运行时直查表被数据库拒（SQLSTATE 42501），读面只能走函数
  ✓ 条数与顺序：6 行，created_at DESC + id DESC（并列组 id 大者在前）
  ✓ 键集翻页：3 页收全 6 行，顺序一致、无重复、末页 next_cursor 为 null
  ✓ 时间区间：from 排除窗口外 1 行（5 行），from+to 闭区间取到 2 行
  ✓ 事件类型：action=account.suspend 取 1 行；entity=flag 取 3 行、entity=account 取 3 行
  ✓ 脱敏：target_ref 只留 type/id/revision；无 ip / user_agent / 凭据字段；actor_id 映射为 actor
  ✓ 同毫秒不同微秒：微秒位置翻页收全 3 行；毫秒位置复现漏行（下一页 0 行），微秒位置取回 a002
  · 规模：表内 20009 行（含 9 行夹具：6 行基础夹具 + 3 行同毫秒不同微秒）
  · 首页无筛选：5.32ms，plan=Function Scan
  · action 过滤（约 2%）：1.54ms，plan=Function Scan
  · 深翻页（键集，第 200 页）：1.42ms，plan=Function Scan
真库臂 PASS：读通道的 SQL、权限、键集、筛选、脱敏全部在真 PG 17.11 上取得读数。
```

三条可核对的推论：①`-k <数据目录>` 确实生效 —— 集群起在 `${{ runner.temp }}/gy-r34-pg/…` 且用的是候选端口
55436，首轮那 32 条 `could not create lock file "/var/run/…"` 全部消失；②工具日志按设计留在 root
（`gy-r34-audit-logs-pg-tools.log`），数据目录（含 `server.log`）随目录删；③step 成功即 `postgres` 进程随
runner 回收，不影响后续 step（同 job 之后的识别端到端链路仍 success）。
## 6. 负控制（红 → 绿自证）

### 6.1 workflow 侧：注释掉新 step

做法：把 `.github/workflows/real-pg-integration.yml:684-714` 整块（24 行注释 + 7 行 step）在**缩进内**逐行
前缀成 YAML 注释（原 6/8 空格缩进保留、`# ` 插在缩进后），文件仍是 749 行、其余一字未动。
先确认解析口径没被破坏：真 YAML 解析后 `real-pg-17-11` job 的 `steps` 回到 **34**，YAML 仍可解析。

红（`node --test tests/unit/ci-real-pg-wiring.test.mjs` ⇒ **exit 1**，`tests 18 / pass 8 / fail 10`）原文：

```
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑 (15.2481ms)
  AssertionError [ERR_ASSERTION]: 有受管真库脚本既没有被任何 workflow 的 `run:` 执行，也没有对应的真库臂——
    · tests/integration/admin-audit-logs-pg.mjs
    actual: [ 'tests/integration/admin-audit-logs-pg.mjs' ],
```

```
✖ 前向⑤（判据⑥）：受管脚本在 workflow 里的执行顺序必须与 REQUIRED_STEP_ORDER 一致
  AssertionError [ERR_ASSERTION]: 受管脚本在 `.github/workflows/real-pg-integration.yml` 里的执行顺序与 `REQUIRED_STEP_ORDER` 不一致：
    · workflow 里找不到这些脚本的 `node` 调用（顺序判据失去对象）：tests/integration/admin-audit-logs-pg.mjs
  期望顺序：… → tests/integration/third-party-deletion-sql-pg.mjs → tests/integration/admin-audit-logs-pg.mjs → tests/integration/recognition-chain-e2e.mjs
```

```
✖ 前向⑥（判据⑦＋⑧）：每个受管脚本所在 step 先 CREATE DATABASE 再 node，且库名与该 step 传入的一致 (27.4688ms)
    · tests/integration/admin-audit-logs-pg.mjs：workflow 里找不到执行它的 step
```

```
✖ 前向⑦（判据⑨）：workflow 里执行的 `-pg.mjs`／`-e2e.mjs` 集合与 MANAGED_SCRIPTS 双向相等
  AssertionError [ERR_ASSERTION]: `.github/workflows/real-pg-integration.yml` 真正执行的 `-pg.mjs` 集合与 `MANAGED_SCRIPTS` 不双向相等：
    · 清单里有、workflow 没跑：tests/integration/admin-audit-logs-pg.mjs
```

另外 `反向控制①`／`①b`／`⑦`／`⑧`／`⑨`／`⑩` 也各自变红（这些是守卫自己的变异自证，被本片的变异连带触发），
其中 `反向控制①` 报 `删掉 run 行后必须且只能点名被删的那个脚本 / actual: [ 'tests/integration/admin-audit-logs-pg.mjs',
'tests/integration/conversations-pg.mjs' ]`——这属于「变异套变异」的预期噪声。

绿（还原后）：按提交前做的**字节备份**还原，还原前后 `Get-FileHash -Algorithm SHA256` 都是
`9C884C00388C0DD59984F34B4033F992A5D6415AA98649B4DF9B184E9B7BE8B5`（identical），文件仍 749 行；
复跑同一条守卫 ⇒ **exit 0**、`tests 18 / pass 18 / fail 0`。

### 6.2 臂侧：把 `closeSync` 挪回收尾之前（复原 bug）

做法：先按字节备份修好的臂（`SHA256=3FDA116E4F6627C863D3920D4572D6EE42CBCC2A4478F0133803F84969ED02A3`），
再把 `closeSync(logFd);` 从 `finally` 末尾挪回 `stopCluster()` 之前（与修前同形，另加一行 `NEGCTL` 标记注释
便于肉眼确认已复原），`node --check` 通过后跑同一条命令（root 换干净的 `r66-arm3`）：

```
SYNTAX_EXIT=0
NODE_EXIT=1
postgres 进程数 = 6
集群目录 = gy-r34-audit-logs-pg-55436-2f6f4c
55436 监听 = 1
node : 清理临时集群失败：pg_ctl stop 失败：EBADF spawnSync E:\GengYunCommander\.pg17\pgsql\bin\pg_ctl.exe EBADF（目录
        …\r66-arm3\gy-r34-audit-logs-pg-55436-2f6f4c 需人工删除）
```

也就是说：修复后新增的判定**当场把这条 bug 判红**（换成修前那版代码它是静默的、`exit 0`），
且残留与修前一致（`postgres` 6 个、目录在、55436 在监听）——两个信号都拿到。负控制留下的集群与目录
随后由人工清掉（`pg_ctl -D <dir> -m immediate -w stop` ⇒ `server stopped`、删目录 ⇒ `postgres` 0、
55436 不再监听），确认环境干净后才做还原。

还原：按**字节备份**回写，`Get-FileHash -Algorithm SHA256` 前后都是
`3FDA116E4F6627C863D3920D4572D6EE42CBCC2A4478F0133803F84969ED02A3`（identical）、673 行、`NEGCTL` 标记 0 处；
复跑同一条命令（root `r66-arm4`）⇒ **exit 0**、11 条 ✓、`postgres` 0、目录不存在、55436 不监听、
工具日志再次出现 `server stopped`。

## 7. 与派单口径不符之处

### 7.1 step 的 YAML 字段顺序（形式差异，无语义差异）

派单给的模板是 `name` → `env` → `run`；落盘按邻居 `.github/workflows/real-pg-integration.yml:677-683` 写成
`name` → `timeout-minutes` → `run` → `env`，并补了 `timeout-minutes: 5` 与 `PGCLIENTENCODING: UTF8`
（派单原文未列这两项，监工补充指令要求与邻居一致）。键序在 YAML／Actions 里无语义，但 diff 不再需要读者自己
比对风格。⛔ 未加 `continue-on-error`、`|| true`、`if:` 任何吞红/条件开关。

### 7.2 解析工具：PyYAML 不可得 ⇒ 用 js-yaml

派单要求「用 PyYAML（或 `python -c`）解析 workflow」。本机没有 PyYAML 也不可装：
`C:\msys64\ucrt64\bin\python.exe`（3.14.3）无 `yaml` 模块且 `python -m pip` 未安装；DSH 自带的 Python 发行版同样没有 `yaml`。
故改用 **js-yaml**（`C:/Users/MR/AppData/Local/Programs/DSH Desktop/resources/node_modules/js-yaml`），
脚本落在仓库外：`E:\GengYunCommander\.pg17\tmp\r66-yaml-step-count.mjs`（读 workflow ⇒ `yaml.load` ⇒ 打印 job 名、
`steps` 长度与每个 step 的标签）。判据不变：都是「用真 YAML 解析器数 step」，不是肉眼数行。

### 7.3 step 名里的「迁移 0033」与脚本钉的「0047」不矛盾

step 名照派单原文写「迁移 0033 的 list_admin_audit_logs」：`list_admin_audit_logs` 确实是 `0033_admin_audit_log_read.sql`
建的（该文件 `:46` `CREATE OR REPLACE FUNCTION public.list_admin_audit_logs(`、`:112` `REVOKE ALL ON FUNCTION`）。
而脚本的版本钉是**全链末项** `0047`（`tests/integration/admin-audit-logs-pg.mjs:284`），因为它走的是生产路径
`migrate.ts up`（`:252` 起的 `spawnSync`）把 46 个迁移全应用一遍，末项自然是 `0047`。两者说的是两件事，本页也按此口径写。

### 7.4 该臂的改动范围（追加指令授权后）

首轮派单第 5 条是「不要改臂」，本页初版因此把收尾 bug 记为「未修」。追加指令明确改为「在同一提交里修掉」
（理由：一条接进 CI 的 step 每次跑完都把 postgres 留在 runner 上、临时目录不释放，等于给 CI 埋一个每跑必留的泄漏）。
本片只动了 §2.3 列的三处（`:210`、`:216-221`、`:672`、`:275-277`），**没有**顺手改任何断言/造数/SQL/端口逻辑。
若监工认为「修臂」本身应单独成片，本片可以把 `tests/integration/admin-audit-logs-pg.mjs` 的 hunk 摘出来，
但那样 CI 接线就会带着一个每跑必留的泄漏，故本页按追加口径交付。

## 8. 未取得 / 未做

- **已取得（但是红）**：GitHub Actions runner 上的真实运行 —— head `4defd650` 的首轮 CI 里本 step **失败**，
  原文是 `FATAL: could not create lock file "/var/run/…"`（§5.4）。根因与修法都已落在这份证据页里；
  修后本机（Windows）复跑 exit 0，**Linux 侧已由 CI 复跑确认（§5.5：21/21 success）**。这一条是本页唯一「先红后修」的读数，
  不写成「已验」。
- **未取得**：Linux 上 `pg_ctl` 在「已关闭 fd」形态下的具体错误码（本机 Windows 是 `EBADF`、非抛错）。
  这不影响判据：修复后的 `stopCluster()` 判的是 `stop.error || stop.status !== 0`，任何平台只要 stop 没成功就红。
- **已取得**：`npm run test:unit` 全量（`GY_BASH=C:\msys64\usr\bin\bash.exe`）⇒ exit 0；尾部那条
  `AssertionError` 属 `tests/unit/i11-audio-mp3-wav-guard.test.mjs:206` 的既有 `todo`（`MEDIA_FORMAT_UNSUPPORTED`
  未实现），不是失败。**注意**：全量是在「修 POSIX socket 之前」的树上跑的；socket 改动只影响非 win32 分支，
  Windows 上等价于没改，故未因它重跑全量（只重跑了本臂 + 三条守卫）。
- **未做**：任何其它真库臂的复跑（`retention-purge-pg`、`third-party-deletion-sql-pg`、`recognition-chain-e2e` 等均未动也未跑）。
- **未做**（超出本片授权）：push / PR / 合并。

## 9. 残余风险（监工可能挑的点）

1. **修好之后的语义变化**：`stopCluster()` 现在会把「`pg_ctl stop` 没成功」判成失败。若 CI 上集群在读数之后
   自行崩掉（例如被 OOM 杀掉），`pg_ctl stop` 会以「server is not running」非 0 退出 ⇒ 本臂变红并打出
   `pg_ctl stop 失败：…`。这是**有意**的取舍：读数为绿但收尾失败，本片宁可红也不静默（也就不会再有「每次都别
   人替你删目录」的泄漏）。
2. **`GY_R34_PG_ROOT` 与 `retention-purge-pg` 同键**：两条 step 共用 `${{ runner.temp }}/gy-r34-pg`。
   当前两条各自建子目录、日志文件名也不同 ⇒ 无覆盖；但「同键不同目录」这件事只写在注释里，
   没有断言强制（守卫只核对键名，不核对子目录名）。
3. **`timeout-minutes: 5` 的依据是本机 5 s / ≈20 s**：Linux runner 上 `migrate.ts up` + `npm ci` 之后的首跑
   可能更慢（尤其 20000 行造数 + 三条 `EXPLAIN ANALYZE`）。若 CI 上偶发超时，应放宽到 10 而不是删掉封顶。
4. **行号漂移**：`tests/unit/ci-real-pg-wiring.test.mjs` 本片 +34 行、`tests/integration/admin-audit-logs-pg.mjs`
   本片 +16 行，`docs/verification/` 里引用这两个文件行号的老页（R28/R29 系列，引用 `:122`、`:218`、`:256`、
   `:298`、`:512`、`:521`、`:566`、`:849`、`:926`）语义上会漂（`--strict` 仍 PASS，它判「在范围内」，基线 13 条、
   新增 0）；若要语义级对齐，需要一次独立的 reanchor 片。
5. **负控制的强度**：workflow 侧只做了「整块注释掉新 step」这一种变异（派单要求的那一种）；更强的一族
   （把 `GY_R34_PG_ROOT` 改成 `GY_I19_PG_ROOT`、删掉 `GY_PG_BIN`）由 `反向控制⑩` 与判据⑦的**既有**变异自证覆盖。
   臂侧只做了「`closeSync` 挪回」这一种（也正是本次真实 bug），未做「把 `stop.error` 判断删掉」的第二变异
   ——那条等价于回到修前行为，§6.2 的读数已经覆盖了它的可观测后果。

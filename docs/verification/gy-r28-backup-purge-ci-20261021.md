# R28-S49：备份副本域接真库 CI —— 先装 PG 17 服务端、再自起集群真跑（第 11 个受管脚本）

- 日期：2026-10-21
- 工作树：`E:\GengYunCommander\wt-r28-s49`，分支 `test/gy-r28-backup-purge-ci`，base `c0217a4`（本片 standalone，不依赖任何在途 PR）
- 本机：Windows 10 + PowerShell 5.1.26100.8875 + Node v24.16.0；本地 PG 17.11 二进制 `E:\GengYunCommander\.pg17\pgsql\bin`
- 日志（一次性本地目录，未入库）：`E:\GengYunCommander\.pg17\handoff\r28-s49-logs\`（`10`–`40` 七个文件）

本片把 `tests/integration/backup-purge-pg.mjs`（GY-I19／#19：迁移 `0023` 的 apply→rollback→replay、注销受理在**同一事务**里写清单、30 天保留窗口到期清除）接进
`.github/workflows/real-pg-integration.yml` 的 job `real-pg-17-11`。它是**最后一条**此前没有任何 workflow 跑过的真库脚本，也是清单里**唯一**的「自起集群」脚本：
runner 上原本取不到 `initdb`/`pg_ctl`（`postgres:17.11` 只活在 service 容器内），所以本片的核心不是给它写 step，而是**先给 runner 装一套 17 的服务端二进制**。

**本片未改脚本本体一个字节**（`git diff --numstat` 对它为空；`658` 行 / `39497` B / `sha256=58C5FD52…A2C98D`，改前改后同值）。

## 0. 结论（一屏）

| 读数 | 接线前（`c0217a4`） | 本片之后 |
| --- | --- | --- |
| `MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` | 10 / 10 | **11 / 11**（逐字一致；`REQUIRED_STEP_ORDER` 同步 11 项） |
| `real-pg-17-11` 的 step 数 | 13（2 `uses` + 1 `npm ci` + 10 受管 `run`） | **15**（+ 装包 step + 真跑 step） |
| 该脚本被哪个 workflow 真跑 | **无**（只有本机手工跑） | `real-pg-integration.yml:203-208`（`GY_PG_BIN=/usr/lib/postgresql/17/bin`） |
| 本机真跑（自起集群） | — | **exit 0**，`RESULT=PASS 13 组`，末行 `CLEANUP=done` |
| 未设 `GY_PG_BIN` | — | **exit 77** + `SKIP:` 行（跳过不是通过） |
| 把真跑 step 临时删掉 | — | 单测 **8 红**（`tests 16 / pass 8 / fail 8`），8 条全部逐字点名该脚本 |
| 同一文件的库建库判据（⑦⑧） | 该 step 没有 `CREATE DATABASE`，原判据会**假红** | 换等价且更强的 `SELF_CLUSTERED_SCRIPTS` 判据（§2.2） |
| 门禁 | — | 7/7 exit 0（§7） |

一句话：**这条臂现在既被 workflow 真跑、又被受管清单守住；把「装包 + 真跑」两步删掉，CI 会红并点名脚本，不会退化成静默缺口。**

## 1. 被测脚本的契约（已核实，本片未改脚本）

- **必填** `GY_PG_BIN`：含 `initdb`/`pg_ctl` 的**服务端** bin 目录（`:52 const binDir = process.env.GY_PG_BIN ?? ''`；`:111` 断言 `initdb` 真的存在）；
- **选填** `GY_I19_PG_ROOT`：数据目录根，默认 `os.tmpdir()`（`:87`）；
- **跳过面**：缺 `GY_PG_BIN` ⇒ `:56` 打印 `SKIP: …（不是通过）`、`:62 process.exit(77)`；只有 `--allow-skip`／`GY_ALLOW_SKIP=1`（`:54`）才降级 0 —— ⛔ 这条出口永远不得写进门禁；
- **自起自停**：`initdb` 到 `<GY_I19_PG_ROOT>\gy-i19-pg-<8hex>`，端口 `55500 + randomInt(0, 500)`（`:89`）无环境变量可覆盖，只监听 `127.0.0.1`；跑完 `pg_ctl stop` + 删数据目录；
- **库名硬钉在脚本内**：`:67 const DB_NAME = 'gengyun_backup_purge_test'`（注意不是 `const DB = …`，判据⑦⑧ 的 `pinnedDatabaseNames()` 正则抽不到它）；
- **权限口径**：运行时对 `user_backup_copies` 只有**列级** SELECT/INSERT/UPDATE（`has_table_privilege=false`、`has_any_column_privilege=true`、`DELETE` 报 `42501`）。

## 2. 改动（两处源码 + 本页）

### 2.1 `.github/workflows/real-pg-integration.yml`：job 末尾追加两步（+23/−0，其它零改动）

逐字内容（`line 186`–`line 208`，与派单 §2.1 一致；`40-wf-static.log` 可逐行比对）：

```yaml
      # 备份副本域（GY-I19 / #19，R28-S49）：**最后一条**此前没有任何 workflow 跑过的真库脚本。
      # 它是唯一的**自起集群**脚本：runner 上原来没有 17 的服务端二进制（`postgres:17.11` 只活在 service
      # 容器内），故先一步用 PGDG apt 装 `postgresql-17` 取 `initdb`/`pg_ctl`，再一步真跑。
      # 它**不**连 service 里那个库、CI 里也**不** `CREATE DATABASE`：库名硬钉在脚本自己的临时集群里
      # （`DB_NAME = gengyun_backup_purge_test`，端口 55500+randomInt(0,500)、只监听 127.0.0.1、跑完自删数据目录）。
      # 未设 `GY_PG_BIN` 时脚本打印 SKIP 并 exit 77 ⇒ 装包/路径没弄好必红（77 不是通过，也不加任何吞红开关）。
      # 本地取证（本机 PG 17.11 二进制 + 临时数据目录）：exit=0，`RESULT=PASS 13 组`，末行 `CLEANUP=done`。
      - name: 安装 PG 17 服务端二进制（backup-purge 需要 initdb/pg_ctl）
        run: |
          set -euo pipefail
          sudo install -d /usr/share/postgresql-common/pgdg
          sudo curl --fail --silent --show-error -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
          echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list > /dev/null
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends postgresql-17
          /usr/lib/postgresql/17/bin/initdb --version
          /usr/lib/postgresql/17/bin/pg_ctl --version
      - name: 备份副本域（迁移 0023 / 受理同事务 / 30 天清除）
        run: node tests/integration/backup-purge-pg.mjs
        env:
          GY_PG_BIN: /usr/lib/postgresql/17/bin
          GY_I19_PG_ROOT: ${{ runner.temp }}/gy-i19-pg
          PGCLIENTENCODING: UTF8
```

三个设计点：

1. **顺序不能反**：先装包、后真跑。`ubuntu-24.04` runner 自带 `psql`（客户端）但没有服务端二进制；装包步把 PGDG 官方源与 key 落到 `/usr/share/postgresql-common/pgdg/`（官方推荐位置，`apt.postgresql.org.asc` 与 `noble-pgdg` 组合），`set -euo pipefail` 保证 curl/apt 任一步失败就炸，末尾两条 `--version` 让「装上了但不在预期路径」当场暴露而不是留到下一步变成 SKIP。
2. **`GY_PG_BIN` 指到 `bin` 目录**：`/usr/lib/postgresql/17/bin`（Debian 系的服务端二进制不在 `PATH` 里，指 `/usr/lib/postgresql/17` 会直接 SKIP+77）；`GY_I19_PG_ROOT` 指 `${{ runner.temp }}/gy-i19-pg`，⛔ 不落仓库、不写系统目录。
3. **`PGCLIENTENCODING: UTF8`**：脚本内多处 `psql` 子进程把中文证据摘要写库/读回；显式钉住编码才与本地取证同形（本机 PS 5.1 + GBK 环境下缺它必乱码，见 §3 注）。

硬要求逐条核对（`40-wf-static.log`）：无 `continue-on-error`、无 `|| true`、无 step 级 `if:`、无 `GY_ALLOW_SKIP`／`--allow-skip`（四类 banned 全部 `none`/`0`）；`set -euo pipefail` 在 `line 195`；`uses:` 仍 2 条且都是 40 位 hex；`services` 仍 `line 46 image: postgres:17.11`；`backup-purge-pg.mjs` 的**字面量只出现在 `line 204`**（注释里提它不算执行，`:191` 提到的是 `GY_PG_BIN`）。

### 2.2 `tests/unit/ci-real-pg-wiring.test.mjs`：10→11 条 + 一组等价判据（+133/−8）

四处同步：

- `MANAGED_SCRIPTS`（`line 74-86`）与 `FROZEN_MANAGED_SCRIPTS`（`line 88-100`）各追加 `'tests/integration/backup-purge-pg.mjs'`，两条清单**逐字一致**（`line 951` 的 `deepEqual` 钉住「改一条必须改另一条」）；
- `REQUIRED_STEP_ORDER`（`line 124-153`）第 11 项，附 4 行注释（自起集群、零耦合、`GY_PG_BIN` 形状、必须排最后）；第 10 项注释里「它在最后」改成「R28-S49 之后 workflow 里最后一步是 `backup-purge-pg`」；
- 头注释（`line 65-72`）：第 11 条是 R28-S49 接的，说明 R28-S14 当年判它接不了的原因与本片的解法，并指向本页。

**判据⑦⑧ 必须换掉，不能照抄**：原判据要求每个受管脚本的 step「先 `CREATE DATABASE <库>` 再 `node <脚本>`」，且把 CI 建的库名与脚本真正连的库名对齐。这条脚本三条都不满足：它**不连** service 的库、**不该**在 CI 建库（库在它自己 `initdb` 出来的临时集群里）、库名还是 `const DB_NAME = …` 这种抽不到的写法（§1）。照抄只会得到一条永久假红，或者更糟——为了让它绿，往 step 里塞一条 `CREATE DATABASE`，于是判据核对的是一个脚本根本不连的库。

所以新增（`line 164-193`、`line 498-525`、`line 541-545`）：

- `SELF_CLUSTERED_SCRIPTS`（表长 1，只能给受管脚本用）；
- `SELF_CLUSTERED_ENV`（`GY_PG_BIN` 值必须以 `/bin` 结尾；`GY_I19_PG_ROOT` 必须引用 `${{ runner.temp }}`），缺失/走形的话术里点明「缺它时脚本只打印 SKIP 并 exit 77」；
- `selfClusteredProblems({ jobId, script, step, command })`：① step 出现 `CREATE DATABASE` 必须红（会造出「CI 建了库、库名判据覆盖到它」的假象）；② 两个 env 必须**存在且形状对**；
- `databaseGuardProblems` 对豁免脚本走 `selfClusteredProblems` 后 `continue`，其余脚本行为不变。

这组判据比原判据更强：原判据只核对「库名一致」，新判据核对**二进制路径的形状**与**临时目录的归属**——正是「装包没成功／路径写错」会让真跑静默退化成 SKIP 的两条通道。

配套：判据⑥（`line 1411-1449`）的入参形态统计扩成四种（`envUrl` / `argvUrl` / `pinnedConstant` / `selfCluster`），并把「每条受管脚本至少命中一种外部入参形态」改成 `envUrl + argvUrl + selfCluster >= 11`；同时断言 `SELF_CLUSTERED_SCRIPTS ⊆ MANAGED_SCRIPTS`、且 `selfCluster` 计数等于豁免表长度（防「表长大了但 workflow 里没有」）。反向控制⑧（`line 1532-1560`）新增两个变异：把 `GY_PG_BIN` 注释掉 ⇒ 必须点名该脚本 + `GY_PG_BIN` + `SKIP`；给真跑 step 补一条 `CREATE DATABASE` ⇒ 必须点名「不是一回事」，不能因为多建了库就判绿。

### 2.3 `tests/unit/ci-integration-chain-structure.test.mjs`：reason 改成真相（+8/−5）

该脚本仍登记在 `UNWIRED_DECLARATIONS` 里（它进不了无 PG 回环链：回环链没有真 PG、也没有 `initdb`/`pg_ctl`），但「未接线」的理由不能再写成「环境前提不满足 ⇒ 接不了」。新 reason 记的是三件事：需要服务端二进制目录、脚本自起集群（端口无覆盖）、以及 **R28-S49 已把它接进真库 job（先装 PGDG `postgresql-17`、再以 `GY_PG_BIN=/usr/lib/postgresql/17/bin` 真跑）**，末尾明确「**已接真库 job**，但**仍不进无 PG 的回环链**」。

### 2.4 本页

## 3. 本机真跑（exit 0，13 组）

```
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_I19_PG_ROOT='E:\GengYunCommander\.pg17\tmp\s49'
$env:PGCLIENTENCODING='UTF8'
node tests/integration/backup-purge-pg.mjs
```

读数（`10-local-realpg-backup-purge.log`，3857 B）：

- 临时集群：数据目录 `E:\GengYunCommander\.pg17\tmp\s49\gy-i19-pg-46c70a68`，端口 **55691**（只监听 127.0.0.1），`PostgreSQL 17.11`；
- 迁移：既有 25 个（`0001`…`0026`，缺 `0023`）先应用，再单独取证 `0023_user_backup_copies.sql` ⇒ 清单 **26** 个；
- `PASS 1`：0023 apply（表 + 3 索引）→ rollback（表消失）→ 再 apply（表重现）；索引 `user_backup_copies_due_idx` / `_key` / `_pkey` / `_subject_idx`；
- `PASS 2`：运行时对清单表**只有列级** SELECT/INSERT/UPDATE（表级 SELECT/INSERT = false、`payload` 列不可读、DELETE = `42501`）；
- `PASS 3`：受理在**同一事务**内写 2 行（收藏 2 个不透明 ref + 历史 0 对象 ref）、`state=pending_purge`、`purge_attempts=0`，lineage/水位/摘要自洽，§4.4 对账 0 行不等；
- `PASS 4`：保留窗口内（+11 天）重放仍 `pending`；`PASS 5`：到期（+31 天）两行 `purged`、`payload=null`、证据摘要由 `payload_digest` 独立复算逐字相等 ⇒ `completed`；
- `PASS 6`：重放幂等（`purged_at` 不变、`purge_attempts` 仍 0）；`PASS 10`：同模块两行同时到期，一条 UPDATE 清完、合成摘要独立复算相等；
- `PASS 7`：清单写入失败（事务内）⇒ `503 PROVIDER_UNAVAILABLE(retryable=false)`、`deletion_requests` 0 行、`users.state` 仍 active ⇒ 202 不可能签发；
- `PASS 8`：同模块还有未到期行 ⇒ 清除整笔回滚、该模块 pending 行统一 `failed + EVIDENCE_REQUIRED + attempts=1`、回执 `blocked`；`PASS 9`：清除期抛错同理（`STORE_UNREACHABLE`）；
- `PASS 11`：未知 `requestId` ⇒ `blocked + EVIDENCE_REQUIRED`（空集不当成功）；`PASS 12`：非 UUID 主体 / 缺受理 id ⇒ `PrivacyError(SESSION_REQUIRED)`，不查库；
- `PASS 13`：库侧约束（`23514` 六类 + `23503` RESTRICT）逐条命中；
- 末三行：`RESULT=PASS 13 组；PostgreSQL 17.11（本机隔离、仅回环）；未发出任何对外请求；迁移清单 26 个（含 0023_user_backup_copies.sql）`、`CLEANUP=done（临时集群已停、数据目录已删；未触碰工作树与既有库）`、`EXITCODE=0`。

注：本机 PowerShell 是 5.1，`>` 重定向会写 UTF-16；日志一律用 `cmd /c "node … > … 2>&1"` 生成、`Get-Content -Encoding UTF8` 读回，必要时带 `PGCLIENTENCODING=UTF8`，否则 `psql` 在 GBK 控制台下把中文读成乱码。

## 4. 跳过面与负控制

### 4.0 不设 `GY_PG_BIN`：exit 77，不是通过

```
SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，没有验证备份副本域（不是通过）。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知没有 PG 二进制时可显式加 --allow-skip 取 0）。
EXITCODE=77
```

（`11-local-skip-77.log`，299 B。CI 里这行一旦出现就说明装包/路径没弄好——那一步不会因此变绿，`node` 以 77 退出，job 红。）

### 4.1 负控制：把真跑 step 删掉 ⇒ 8 条断言红，逐条点名脚本

变异：从 workflow 临时删掉 `- name: 备份副本域（…）` 及其 `run:`/`env:` 三行；跑
`node --test tests/unit/ci-real-pg-wiring.test.mjs` ⇒ `EXITCODE=1`，`tests 16 / pass 8 / fail 8`（`30-negctl-wiring.log`，16352 B）。

8 条红的名字：`前向①`、`反向控制①`、`反向控制①b`、`反向控制⑦`、`前向⑤`、`前向⑥`、`前向⑦`、`反向控制⑧`。原文片段：

```
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑 (18.067ms)
    · tests/integration/backup-purge-pg.mjs
    actual: [ 'tests/integration/backup-purge-pg.mjs' ],
    expected: [],

✖ 前向⑤（判据⑥）：受管脚本在 workflow 里的执行顺序必须与 REQUIRED_STEP_ORDER 一致 (0.8514ms)
    actual: [ 'workflow 里找不到这些脚本的 `node` 调用（顺序判据失去对象）：tests/integration/backup-purge-pg.mjs' ],

✖ 前向⑥（判据⑦＋⑧）：每个受管脚本所在 step 先 CREATE DATABASE 再 node，且库名与该 step 传入的一致 (7.8213ms)
    · tests/integration/backup-purge-pg.mjs：workflow 里找不到执行它的 step

✖ 前向⑦（判据⑨）：workflow 里执行的 `-pg.mjs` 集合与 MANAGED_SCRIPTS 双向相等 (1.1871ms)
    actual: [ '清单里有、workflow 没跑：tests/integration/backup-purge-pg.mjs' ],
```

结论：清单条目不是「加了就绿」——把执行它的那一步拿掉，8 条断言从 4 个不同角度（是否真跑／顺序／建库口径／集合双向相等）同时红，且每条都逐字点到 `tests/integration/backup-purge-pg.mjs`。

### 4.2 恢复后 sha256 相等、复跑全绿

变异前把 workflow 备份到 `.pg17\tmp\s49\rpi-backup.yml`，恢复后三份 `Get-FileHash`（before / backup / after）**同为** `B5B0596A0A278D27B2D393B588340F2A495D204592A8F351C77AEFFEE3A9E8B7`；
复跑两个单测 `tests 23 / pass 23 / fail 0`，`EXITCODE=0`（`32-negctl-restored.log`，2775 B）。

### 4.3 诚实记录：chain 单测**不会**因这次 workflow 变化变红

派单原话是「两个单测必须红」。实测：删掉真跑 step 后
`node --test tests/unit/ci-integration-chain-structure.test.mjs` 仍然 `tests 7 / pass 7 / fail 0`，`EXITCODE=0`（`31-negctl-chain.log`，868 B）。

这不是漏做断言，是该测试的设计边界：它只 `readFileSync` `package.json` + `readdirSync` 集成目录，**从不读 workflow YAML**（它管的是「哪些脚本进无 PG 回环链」，与「workflow 里有没有跑它」是两张网）。它的 reason 文字改了（§2.3），但断言的**对象**不含 workflow，所以 workflow 的任何变异都不该、也不会让它变色。

按派单要求如实报告：负控制真正的守卫是 `ci-real-pg-wiring.test.mjs`（8 红，§4.1）；chain 测试在同一变异下**保持绿**是正确行为，不是缺口。若要它也能红，得给它加一条「UNWIRED_DECLARATIONS 里已声明接线的脚本必须在某 workflow 里被执行」的跨界断言——那属于改它的判据口径，超出本片范围（列入 §5／§7 待拍板）。

## 5. 未取得

- **runner 上的实测**：`ubuntu-24.04` + PGDG `noble-pgdg` 装 `postgresql-17` 的真实耗时、apt 源可达性、`/usr/lib/postgresql/17/bin/{initdb,pg_ctl}` 是否落在预期路径 —— 全部只能由本 PR 的 CI 首次证明。本机用 17.11 二进制 + 临时数据目录替代，证明的是**脚本与 step 的形状**，不是 runner 的装包成功。
- **`initdb --version` 作为「装上了」的证明是否够**：本机无法验证 apt 的部分成功形态（例如 `postgresql-17` 装了但 `postgresql-common` 缺 `initdb` 的罕见路径）。装包步末尾的两条 `--version` 是最小可用的哨兵，值得在 CI 首次跑时人工看一眼日志。
- **chain 测试的跨界断言**（§4.3）：本片未加，属口径变更，需指挥拍板。

## 6. 合并顺序

- 本片与 #354（语音域接 CI）**同改** `real-pg-integration.yml` 的 job 末尾：若 #354 先合，本片的两步会排到第 12/13 条，`MANAGED_SCRIPTS` 仍是 11（语音域那条另加），但**顺序表要重排**（`backup-purge-pg` 必须仍是最后一步，因为它装包 + 自起进程）。由指挥合流时按实际顺序重排 `REQUIRED_STEP_ORDER` 并同步数值；若本片先合，#354 追加即可。
- 本片与 `docs/verification/gy-r28-real-pg-wiring-3-20261020.md`（R28-S14 那页）不冲突，但**该页 §3 的结论被本片推翻**：它把 `backup-purge-pg` 判成「不接（环境前提在 CI 上不成立）」，理由是 runner 上取不到 `initdb`/`pg_ctl`；本片的全部工作就是把这个前提消掉（先装 PGDG `postgresql-17`）。两份证据页并存，以本页为准。读史口径：wiring-3 的「3 接 / 2 不接」两条今已全接 —— `account-suspend-pg` 由 R28-S39 修好 scram 缺陷后接（第 10 条），`backup-purge-pg` 由本片消除环境前提后接（第 11 条）。

## 7. 门禁（逐条 exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run lint` | exit 0（`PASS tsc --noEmit` × 2 + 仓库卫生扫描 + 「lint 通过」） |
| 2 | `node tools/verify-release-materials.mjs` | exit 0，**15/15**（索引覆盖 `deploy/` 31/31、35 条路径、40 个相对链接） |
| 3 | `npm run test:docs` | exit 0（`PASS: 27 initial tasks; … Markdown links and tables`；研究记录 5 通过 / 0 失败 / 4 legacy 钉住） |
| 4 | `node tools/verify-contract-status.mjs` | exit 0（112 条契约操作 / 已装配 108；implemented 13 / partial 95 / planned 4；形状错误 0、语义错误 0） |
| 5 | `node --test --test-concurrency=1 tests/contract/*.test.mjs` | exit 0，**6/6**（168 ms） |
| 6 | `node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | exit 0，**23/23**（278 ms；16 + 7） |
| 7 | `git diff --check` | exit 0，**零输出**（0 B） |

### 7.1 逐条读数来源

`.pg17\handoff\r28-s49-logs\`：`50-lint.log`、`51-release-materials.log`、`52-docs.log`、`53-contract-status.log`、`54-contract.log`、`55-unit.log`、`56-diff-check.log`（0 B）。
七条都是**在最终工作树**（两个单测 + workflow + 本页全部就位）上跑的，不是在中间态上跑的。

## 8. 复现

```
cd E:\GengYunCommander\wt-r28-s49
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_I19_PG_ROOT='E:\GengYunCommander\.pg17\tmp\s49'
$env:PGCLIENTENCODING='UTF8'
cmd /c "node tests/integration/backup-purge-pg.mjs > log.txt 2>&1"; $LASTEXITCODE   # 期望 0
cmd /c "set GY_PG_BIN=& node tests/integration/backup-purge-pg.mjs > skip.txt 2>&1"; $LASTEXITCODE   # 期望 77
node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs
```

## 9. 衔接

- 上一页：`docs/verification/gy-r28-real-pg-wiring-3-20261020.md`（R28-S14 的接线判据、以及 §3 为什么当时判它「不接」——本片推翻的正是那一条）；
- 相邻片：`docs/verification/gy-r28-account-suspend-ci-wire-20261021.md`（R28-S39 接第 10 条，同一 job、同一套「先建库再 node」判据）；
- 域侧证据：`docs/verification/gy-i19-backup-domain-20261018.md`（迁移 `0023`／列级授权口径／`20-login-roles.sql` 的 `gy-i19-deletion-grant`、`gy-i19-backup-copies-grant` 两个区域）。

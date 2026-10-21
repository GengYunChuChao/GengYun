# R28-E5：把备份副本**到期清除驱动**接进真库 CI（第 13 个受管脚本）

- 日期：2026-10-21
- 工作树：`E:\GengYunCommander\wt-e5-backup-ci`，分支 `test/gy-r28-e5-backup-driver-ci`，base = `origin/main` **`ee46eb1`**（`feat(privacy): 备份副本 30 日到期清除的驱动者（P0-4 / Refs #19） (#398)`）
- 本机：Windows + Node v24.16.0；本地 PG 17.11 二进制 `E:\GengYunCommander\.pg17\pgsql\bin`（`initdb --version` = `initdb (PostgreSQL) 17.11`）
- 本地日志（一次性目录，未入库）：`E:\GengYunCommander\.pg17\tmp\r28e5\`（`run-pass.log` 4010 B／`run-skip.log` 328 B／`exit-pass.txt` 18 B）
- ⛔ 本片不 push、不开 PR ⇒ **CI 上还没有任何一次运行**。本页所有读数都标明了来源（本机 / 静态 / 继承自 R28-S49 的真 CI 读数）。

## 0. 结论

| 读数 | 接线前（`ee46eb1`） | 本片之后 |
| --- | --- | --- |
| `tests/integration/backup-copies-purge-pg.mjs` 被哪个 workflow 执行 | **无**（`git grep` 在 `.github/workflows/` 零命中；只在 `UNWIRED_DECLARATIONS` 里登记） | `real-pg-integration.yml:246-251`（step 17，`GY_PG_BIN=/usr/lib/postgresql/17/bin`） |
| `MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` | 13 / 13 | **14 / 14**（逐字一致；`REQUIRED_STEP_ORDER` 同步 14 项，集合与数组都相等） |
| `SELF_CLUSTERED_SCRIPTS`（判据⑦⑧ 的等价替换表） | 1（`backup-purge-pg`） | **2**（+ `backup-copies-purge-pg`） |
| `real-pg-17-11` 的 step 数 | 17 | **18**（只 +1：真跑 step；装包 step 复用，⛔ 没有第二次装包） |
| 本机真跑（自起临时集群） | 由 #398 作者本机跑过，**无日志入库** | **exit 0**，`PASS 1…14` + 末行 `ALL PASS：14 条真库断言`（临时集群端口 55888，跑完自停自删） |
| 未设 `GY_PG_BIN` | — | **exit 77** + `SKIP:` 两行（未取得，⛔ 不是通过） |
| 把新加的 step 整段删掉 | — | 守卫 **9 红**（4 条前向 + 反向控制⑨的前提），每条都逐字点名该脚本 |
| 门禁 | — | `npm run lint` exit 0；两条守卫 24/24；`npm run test:unit` 全量重跑 **exit 0**（`3339/3340 pass`、1 skipped；首跑有 1 条与本片无关的抖动，两次读数都记在 §8.1） |
| CI 上的运行读数 | — | **未取得**（不 push／不开 PR；见 §7） |

**一句话：这个脚本现在是真的被 CI 执行了**——它不是「登记在册」而已，`real-pg-integration.yml` 的 step 17 会 `node tests/integration/backup-copies-purge-pg.mjs`，并且有守卫钉住「这行不能被悄悄删掉/挪顺序/丢 env」。**但**「在 GitHub runner 上跑绿」这件事本片**没有**读数（没 push），§7 逐条写清哪些是继承来的、哪些是未取得的。

## 1. 脚本要什么（实读 `tests/integration/backup-copies-purge-pg.mjs`，634 行 / 35080 B）

| 项 | 事实 | 行 |
| --- | --- | --- |
| **必填** `GY_PG_BIN` | 含 `initdb`/`pg_ctl` 的**服务端** bin 目录；脚本 `:162` 显式 `assert.ok(existsSync(tool('initdb')))` | `:58`、`:102`、`:162` |
| **选填** `GY_I19_PG_ROOT` | 数据目录根，缺省 `os.tmpdir()` | `:97` |
| 选填 `GY_I19_PG_LOG` | `pg_ctl`/`initdb` 的 stdout+stderr 落点（缺省 tmp 下随机文件名） | `:76` |
| 跳过面 | 缺 `GY_PG_BIN` ⇒ `:61` 打印 `SKIP: …（未取得，不是通过）`、`:67 process.exit(77)`；只有 `--allow-skip`／`GY_ALLOW_SKIP=1`（`:59`）才降级 0 —— ⛔ 这条出口不得进 workflow | `:59-68` |
| 自起自停 | `initdb -D <root>/gy-i19-purge-pg-<8hex> --no-sync --encoding=UTF8 --locale=C -U postgres --auth=trust`；`pg_ctl -w start -t 60`；收尾 `pg_ctl -m immediate stop` + `rmSync(dataDir)`（且拒绝删非本脚本前缀的目录） | `:158-180` |
| 端口 | `55600 + randomInt(0, 300)`，**先 `portIsFree()` 探活再 initdb**（40 次尝试）；只监听 `127.0.0.1` | `:116-122`、`:144` |
| POSIX socket | `-k <dataDir>`（把 unix socket 指进本集群数据目录）——**这正是 R28-S49 在真 CI 上踩过的坑**（`docs/verification/gy-r28-backup-purge-ci-20261021.md` §10.2：Debian 打包默认 `/var/run/postgresql`，runner 上不可写），本脚本已自带修法 | `:142-147` |
| 库名 | `DB_NAME = 'gengyun_backup_purge_driver_test'`（**脚本内硬钉**，CI 不建库、也⛔ 不该建） | `:73`、`:325-327` |
| 迁移 | 自己发现并 apply `0001..0026`（含 `0023_user_backup_copies.sql`，断言清单含 0023） | `:334-337` |
| 角色/授权 | 跑 5 个 `roles/*.sql` + 自建 `gengyun_api_runtime`（随机口令）+ 应用 `20-login-roles.sql` 的 `gy-i19-backup-copies-grant` 区域（断言该区域无 psql 元命令） | `:340-359` |
| 断言面 | 14 条（权限形状／到期边界／成功行／批量上限／失败留痕／失败不阻塞／部分到期／failed 默认口径／`--retry-failed`／幂等重跑／边界外不越权／CLI `--dry-run`／CLI 端到端／CLI 幂等） | 头注释 `:10-29` |

## 2. runner 给什么（这是本片与其它 12 条受管脚本的**唯一关键差异**）

- `services.postgres: postgres:17.11` 容器里**有**服务端二进制，但它们在**容器内**，runner 的 `PATH` 上只有客户端（`psql`）。所以「像其它脚本那样连 service 库」这条路对本脚本**无效**——它要的是能自己 `initdb` 一个集群的**服务端**二进制。
- 该前提**已经在 main 上被消除**：`real-pg-integration.yml` 里那条 PGDG apt 装包 step 是 R28-S49（#360）加的，并且**在真 CI 上跑过**：
  - PR **#360**，run `39537029221`，job `real-pg-17.11`（id `119015935359`）：step 16「安装 PG 17 服务端二进制」**success**——PGDG 源可达、`postgresql-17` 装上、`/usr/lib/postgresql/17/bin/{initdb,pg_ctl}` 落在预期路径（两条 `--version` 哨兵都过）；
  - 同一 run 里那一步暴露的**真问题**是 unix socket 目录（脚本侧），已由 `-k <dataDir>` 修掉，本脚本自带该修法（§1）。
  - 结论：**装包这一步不是假设，是有真 CI 读数的**；本片**不重复装包**，只复用它的产物。
- 版本来源的钉法（本片把这条写进 step 注释并加断言）：
  - 源：`apt.postgresql.org` 的 `noble-pgdg`（ubuntu-24.04 的官方 PGDG suite；`https://apt.postgresql.org/pub/repos/apt/dists/` 上 `noble-pgdg/` 2026-10-19 仍在线，本片实读）+ `postgresql.org` 的签名 key（`ACCC4CF8.asc`，`signed-by` 显式绑定到该 key 文件）；
  - 包：`postgresql-17`（大版本钉死）；
  - ⛔ **不**写 `postgresql-17=17.11-…`：PGDG 只保留每个大版本的最新小版本，写死小版本会在 17.12 发布当天变成「依赖无法满足」——那是另一种假门禁（步骤永远红，而人只会把它当噪音）；
  - 作为交换，装完**断言大版本真的是 17**（`initdb_version` → `server_major` → `!= 17` 就 `::error::` + `exit 1`）。sed 取值在 Linux bash 上实测：`17.11 → 17`、`18.0 → 18`（§5.3）。

## 3. 改动（三个文件 + 本页；`git diff --numstat`）

| 文件 | +/− | 内容 |
| --- | --- | --- |
| `.github/workflows/real-pg-integration.yml` | **+34 / −5** | ① 头注释登记新脚本；② 装包 step 改名（`backup-purge / backup-copies`）+ 加「钉来源不钉小版本」的注释与**大版本断言**（`:214-229`）；③ **新增** step「备份副本到期清除驱动」（`:246-251`，+1 step） |
| `tests/unit/ci-real-pg-wiring.test.mjs` | **+153 / −16** | 三处清单 13→14；`SELF_CLUSTERED_SCRIPTS` 1→2；反向控制⑤ 改成**按 step 作用域**变异（两段 `GY_PG_BIN` 逐字相同，job 级变异会假红）；新增反向控制⑨；头注释补第 14 条 |
| `tests/unit/ci-integration-chain-structure.test.mjs` | **+5 / −3** | `UNWIRED_DECLARATIONS` 里 `backup-copies-purge-pg.mjs` 的 reason 改准确（**保留条目**：它仍不进无 PG 的回环链），把「R28-E2 红线禁止改 workflow ⇒ 没有接进任何 workflow」改成「R28-E5 已接进 `real-pg-integration.yml` 的 step 17」 |
| `docs/verification/gy-r28-e5-backup-driver-ci-20261021.md` | 新增 | 本页 |

净新增的 workflow 内容（逐字，`:246-251`）：

```yaml
      # 备份副本**到期清除驱动**（GY-I19 / #19 的 P0-4 执行者，R28-E5 / #398 的脚本）：与上一步同属
      # …（八行注释：自起集群、端口探活、库名、77 语义、排序理由、本地取证）
      - name: 备份副本到期清除驱动（迁移 0023 / 到期枚举 / 逐组清除 / 失败重排 / CLI 幂等）
        run: node tests/integration/backup-copies-purge-pg.mjs
        env:
          GY_PG_BIN: /usr/lib/postgresql/17/bin
          GY_I19_PG_ROOT: ${{ runner.temp }}/gy-i19-pg
          PGCLIENTENCODING: UTF8
```

**为什么这样接（三个设计点）**

1. **不新增装包 step**：两个自起集群脚本各自装一遍 `postgresql-17` 只会让 dpkg 状态互相覆盖（第二条 `apt-get install` 是 no-op，但若前一条半失败则行为不可预期），且没必要。装包 step 放在 `backup-purge` 之前、`backup-copies` 也在它之后 ⇒ 两条都有 bin。
2. **step 里⛔ 没有 `CREATE DATABASE`**：库在它自己 `initdb` 出来的临时集群里（`gengyun_backup_purge_driver_test`），CI 建库只会造出「库名判据核对了一个脚本根本不连的库」的假象。守卫对 `SELF_CLUSTERED_SCRIPTS` 的判据就是钉这一条（`selfClusteredProblems`）。
3. **不给 77 留任何降级通道**：不加 `continue-on-error`、不加 `|| true`、不加 `GY_ALLOW_SKIP`/`--allow-skip`。缺 bin ⇒ 77 ⇒ step 红（真库臂没跑 ⇒ 这一轮什么都没验证）。这里的 77 **不**像 `recognition-chain` 那样需要显式升级成 `exit 1`：本 step 的 env 是**我们自己**给的，77 只可能意味着「装包/路径坏了」，让它以非 0 退出即可（GitHub 判任何非 0 为 failure），多写一层只会多一处可漂移的逻辑。

## 4. 三处数组读数（机器读值，脚本见 §9）

```
MANAGED_SCRIPTS          n=14
FROZEN_MANAGED_SCRIPTS   n=14
REQUIRED_STEP_ORDER      n=14 (exported)
SELF_CLUSTERED_SCRIPTS   n=2
set(MANAGED) == set(FROZEN)      : true
set(MANAGED) == set(ORDER)       : true
array(MANAGED) == array(ORDER)   : true

   1 conversations-pg   2 community-pg   3 messages-pg   4 favorites-history-pg
   5 account-deletion-pg   6 admin-accounts-read-pg   7 admin-flags-pg
   8 ocr-jobs-pg   9 recognitions-pg   10 account-suspend-pg   11 speech-pg
  12 backup-purge-pg   13 backup-copies-purge-pg   14 recognition-chain-e2e

SELF_CLUSTERED: backup-purge-pg, backup-copies-purge-pg
workflow 里被 node 执行的 -pg/-e2e 脚本数: 14
```

顺序理由（写进 `REQUIRED_STEP_ORDER` 第 13 项注释）：它**只**依赖「装包 step 在它之前」，对 service 的库/口令/角色零依赖（不建组角色、不碰集群级对象、只在 runner 临时目录里活动）；排 `backup-purge` 之后是因为复用同一次装包结果，两步共用 `GY_I19_PG_ROOT` 也安全（数据目录名各带随机后缀、前一步收尾已删干净）。

## 5. 本机取证（真跑，非推演）

### 5.1 14 臂全绿（`run-pass.log`，4010 B）

```
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_I19_PG_ROOT='E:\GengYunCommander\.pg17\tmp\r28e5\pgroot'
node tests/integration/backup-copies-purge-pg.mjs      # EXIT=0
  - 临时集群：数据目录 …\gy-i19-purge-pg-d3d9640f，端口 55888（只监听 127.0.0.1）
  - PostgreSQL 17.11
  - 迁移已应用：26 个（0001_initial_schema.sql … 0026_speech_persistence.sql）
PASS 1..PASS 14（14 条）
ALL PASS：14 条真库断言（exit code 0）
```

- 自停自删已核对：`pgroot` 目录**空**（`0` 项）；`55888` 已无监听（`Get-NetTCPConnection -State Listen` 在 55500–55999 里没有它）。
- **端口探活不是花架子**：本次运行的同一台机器上，跑之前 556xx 里已有 **8 个别人留下的临时集群在监听**（`55601 / 55613 / 55618 / 55641 / 55700 / 55731 / 55733 / 55734`）。脚本 `pickPort()` 探活后选了 `55888`。若照抄 `55500 + randomInt` 那种「不探活」的写法，本机就会撞 `could not create any TCP/IP sockets`。

### 5.2 缺 `GY_PG_BIN` ⇒ 77（`run-skip.log`，328 B）

```
$env:GY_PG_BIN=''   # 或干脆不设
node tests/integration/backup-copies-purge-pg.mjs      # EXIT=77
SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，没有验证备份副本到期驱动（未取得，不是通过）。
EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知没有 PG 二进制时可显式加 --allow-skip 取 0）。
```

### 5.3 装包 step 的新断言（Linux 侧取值逻辑）

在 WSL 的 Ubuntu（bash + GNU sed）上跑 step 里那段提取逻辑：

```
case1 major=17 expect=17      # initdb (PostgreSQL) 17.11 (Debian 17.11-1.pgdg120+1)
case2 major=18 expect=18      # initdb (PostgreSQL) 18.0 (Debian 18.0-1.pgdg120+1)
```

⚠ 这**只**证明 `sed` 取值与「不等于 17 就红」的分支逻辑对；不证明 `apt-get install postgresql-17` 在 Ubuntu 24.04 runner 上能装（那一条的证据来自 §2 的真 CI 读数，不是本机）。

## 6. 负控制（真删，真红，真点名）

把新增的整段 step 从磁盘上的 workflow 里删掉（6 行：`- name` / `run` / `env:` / 3 条 env），跑守卫：

```
$ node --test tests/unit/ci-real-pg-wiring.test.mjs
✖ 前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑
    · tests/integration/backup-copies-purge-pg.mjs
✖ 前向⑤（判据⑥）：受管脚本在 workflow 里的执行顺序必须与 REQUIRED_STEP_ORDER 一致
    · workflow 里找不到这些脚本的 `node` 调用（顺序判据失去对象）：tests/integration/backup-copies-purge-pg.mjs
✖ 前向⑥（判据⑦＋⑧）：每个受管脚本所在 step 先 CREATE DATABASE 再 node…
    · tests/integration/backup-copies-purge-pg.mjs：workflow 里找不到执行它的 step
✖ 前向⑦（判据⑨）：workflow 里执行的 `-pg.mjs`／`-e2e.mjs` 集合与 MANAGED_SCRIPTS 双向相等
    · 清单里有、workflow 没跑：tests/integration/backup-copies-purge-pg.mjs
✖ 反向控制⑨：删掉 `backup-copies-purge-pg` 的整段 step ⇒ 四条判据必须逐条点名它
ℹ fail 9
```

（9 = 上述 4 条前向 + 反向控制⑨ 的前置「磁盘真值必须绿」+ 另外 4 条依赖同一真值的用例；每条消息都逐字点到 `tests/integration/backup-copies-purge-pg.mjs`。）

删完用备份还原，`Get-FileHash` 与删除前**逐字节相同**（`True`），守卫回到 17/17。

**为什么还动了反向控制⑤**：现在同一个 job 里有**两条**自起集群脚本、两段 `GY_PG_BIN` 逐字相同（`/usr/lib/postgresql/17/bin`），原来的 `replaceWithinJob(...)` 要求「整个 job 里正好命中一处」⇒ 会变成 `expected: 1, actual: 2` 的假红。改成按 step 作用域变异（新增 `stepRangeOfScript` / `replaceWithinStep` / `withoutScriptStep` 三个内存变异辅助），并**对两条自起集群脚本各跑一遍**（`for (const selfClustered of SELF_CLUSTERED_SCRIPTS)`）——判据强度不减，覆盖面反而从 1 条变 2 条。

## 7. CI 上如何验 / 未取得什么

**怎么验（下一次 PR 的读法）**：job `real-pg-17.11` 的第 **15** 步装包 → 第 **16** 步 `backup-purge` → 第 **17** 步「备份副本到期清除驱动」→ 第 **18** 步 `recognition-chain`（按 YAML 解析的 step 序号）。第 17 步绿 = 14 条断言在 runner 上全过；红时分两种读法：

- 日志里有 `SKIP: 未设置 GY_PG_BIN…` + 77 ⇒ 装包或路径坏了（不是脚本行为错）；
- 其它非 0 ⇒ 真跑挂了，日志里 `PASS n` 停在哪个数字就说明前 n 条过了。

**未取得（明确清单，不得读成「已验收」）**：

1. **本片没有任何 CI 运行读数**（不 push、不开 PR）⇒ 「runner 上 14 条全绿」这件事**未取得**；能给的只有「本机 14/14 + 静态守卫 + 继承的真 CI 装包读数」。
2. **Linux 上的真跑未取得**：本机是 Windows（没有 unix socket 那一段）。同一脚本的 `-k <dataDir>` 修法虽已在 `backup-purge-pg` 的真 CI 上被证明有效（§10.5 的复跑判据），但对**本脚本**是「同一修法、未在同一次 run 里读数」。
3. **装包 step 的真 CI success 属于 R28-S49 的 run**（`39537029221`），不是本片；本片在它上面**加了大版本断言**，这条断言只在 WSL 上验了取值逻辑（§5.3），未在任何 GitHub runner 上跑过。
4. **apt 在本机无法复跑**：WSL 的 Ubuntu 里 `sudo` 需要交互口令（`sudo: interactive authentication is required`）⇒ 拿不到 root，无法在本机复现「PGDG 源 + `apt-get install postgresql-17`」整条链路；本机 WSL 是 26.04（`resolute`），与 runner 的 24.04（`noble`）suite 不同，即便有 root 也不是同一条读数。
5. **556xx 探活的跨平台读数**：本机 8 个残留临时集群的场景是真实的，但 runner 上是否会出现同类碰撞**未取得**（该分支存在时才生效）。
6. 30 天真实时间流逝仍未取得（脚本用注入 cutoff / 库 `now()`），与 #398 的口径一致，不是本片引入的缺口。

## 8. 自检读数（本机真跑）

| 命令 | 读数 |
| --- | --- |
| `npm run lint` | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描`、`lint 通过` ⇒ **exit 0** |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | **24/24 pass**（含新增 `反向控制⑨`；`ci-real-pg-wiring` 单跑 17/17） |
| `GY_PG_BIN=… node tests/integration/backup-copies-purge-pg.mjs` | **exit 0**，`PASS 1…14`，`ALL PASS：14 条真库断言` |
| 不设 `GY_PG_BIN` 同一脚本 | **exit 77**（`SKIP:` 两行） |
| 负控制（删 step 后跑守卫 → 还原） | **fail 9**，逐字点名；还原后哈希不变、守卫回绿 |
| `npm run test:unit` 全量 | 见 §8.1（独占跑，读数补在本节） |
| workflow YAML 解析（`yaml` 包，scratch 目录，未入库） | `YAML=PASS`；`steps=18`；两个自起集群 step 的 `GY_PG_BIN`/`GY_I19_PG_ROOT` 逐字符合守据；`name: 安装…` 的 step **只有 1 个** |

### 8.1 `npm run test:unit`（全量，独占跑）

| 次 | 读数 |
| --- | --- |
| 第 1 次 | **exit 1**：`tests 3335 / pass 3333 / fail 1 / skipped 1`；唯一失败是 `tests/unit/knowledge-order-created-at.test.mjs`（`✖ … 'test failed'`，**该文件无任何子用例失败**，是整文件级失败） |
| 单独复跑该文件 | **6/6 pass**（exit 0，8.9 s） |
| 第 2 次（全量重跑） | **exit 0**：`tests 3340 / pass 3339 / fail 0 / skipped 1` |

判读：那条失败与本片改动**无关**（本片只动 workflow、两条守卫单测与文档；该用例读的是 `services/**` 的知识列表排序 + 真 HTTP，两次全量之间本片只改过 workflow 里一行 `echo` 文案）。它是**并发负载下的抖动**：45 个组长链 + 该文件自己起 loopback 真 HTTP、单组约 1.4–1.7 s，在 3335 个用例同跑时被拖到超时/文件级失败。如实记录两次读数与单独复跑读数，⛔ 不写成「一次就全绿」。`skipped 1` 两次都出现，属既有跳过项。

## 9. 复现命令

```powershell
# 1) 三处数组读数（读真值，不硬编码）
node -e "…"    # 见 §4 的读数脚本（scratch 目录，未入库）

# 2) 本机 14 臂
$env:GY_PG_BIN='E:\GengYunCommander\.pg17\pgsql\bin'
$env:GY_I19_PG_ROOT='E:\GengYunCommander\.pg17\tmp\r28e5\pgroot'
node tests/integration/backup-copies-purge-pg.mjs; $LASTEXITCODE      # 期望 0

# 3) 跳过面
Remove-Item Env:GY_PG_BIN
node tests/integration/backup-copies-purge-pg.mjs; $LASTEXITCODE      # 期望 77

# 4) 守卫
node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs

# 5) 负控制：删掉 workflow 里那段 step 再跑 4)，必须红并点名脚本，然后还原
```

## 10. 相关页面

- 脚本来源：`docs/verification/gy-i19-backup-purge-driver-20261021.md`（#398 的自证，含 D1「是否接进 `real-pg-integration.yml`」——**本片回答了它**）
- 装包 step 的来历与真 CI 首跑：`docs/verification/gy-r28-backup-purge-ci-20261021.md`（§10 unix socket 真红与修法）
- 判据表与「不接」的历史判断：`docs/verification/gy-r28-real-pg-wiring-3-20261020.md`（§3 的「不接」已先后被 R28-S49 与本片推翻）
- 域侧证据：`docs/verification/gy-i19-backup-domain-20261018.md`（迁移 `0023`／列级授权／`20-login-roles.sql` 的两个授权区域）

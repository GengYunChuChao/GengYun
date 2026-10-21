# GY-R28-S14 真库接线第三批：五条候选逐条判定（3 接 / 2 不接）

- 切片：S14（R28 第三批「已在 main、却没有任何 workflow 跑过」的真库脚本接线）
- 分支：`test/gy-r28-real-pg-wire-3`（based on `upstream/main = 47fe0288dd3b0c41213be0adaf6e35fae58c578f`）
- 日期：2026-10-20（本机实测时间）
- 环境：Windows / PowerShell 7 / Node **v24.16.0**（`package.json` engines `>=24.16.0 <25`）／
  PostgreSQL **17.11** 本机二进制（`E:\GengYunCommander\.pg17\pgsql\bin`，`postgres --version` =
  `PostgreSQL 17.11 ... msvc-19.44.35228 64-bit`）
- 集群：本片**自己起了两个**，都不碰本机既有集群（55460/55461 属他人）
  - **`:55611`**＝`initdb -U postgres --auth=trust --encoding=UTF8 --locale=C --no-sync`
    （第一轮「能不能绿」的排障读数；trust 下口令不校验，**不能**用来判 CI 可接性）
  - **`:55612`**＝`initdb -U postgres --pwfile=… --auth-host=scram-sha-256 --auth-local=trust`
    ⇒ `host all all 127.0.0.1/32 scram-sha-256`；并**照 CI 镜像的做法**建了超级用户
    `gengyun_ci_owner` / `synthetic-ci-owner-only`（与 `real-pg-integration.yml` 的
    `POSTGRES_USER`／`POSTGRES_PASSWORD` 逐字一致），四个专用库都以它属主建出来
    ⇒ 这份读数才与 `postgres:17.11` service 等价
- 铁律（本片执行口径）：**先在本机真跑出 exit=0（且必须是 scram 等价集群）才接线**；
  判「不接」的两条也是真跑出来的红，**没有**放宽任何脚本内断言、**没有**加 `--allow-skip`／`GY_ALLOW_SKIP`、
  **没有**改被测脚本（五个脚本一字节未动）。
- 订正：**R28-S18**（2026-10-20）修订 §2.3／§2.4 两处失实结论（首个 `42710` 的出处、触发条件、
  修法范围），段内以 🔁 标注并用本机真集群（`:55601`，scram ＋ `gengyun_ci_owner`）复测；
  本页其余段落保持 S14 原样。

---

## 1 结论：逐条判定

| # | 脚本 | 调用契约（源码） | scram 等价真跑 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `tests/integration/account-deletion-pg.mjs` | `node <脚本> <ownerUrl>`（argv[2]；库名硬钉 `gengyun_deletion_test`，断言 hostname=`127.0.0.1`、pathname=`/gengyun_deletion_test`、`public` 下无表）；自建 5 组角色 + 运行时 LOGIN，口令 `randomBytes(24)` **并写进它自己的运行时 URL**（`:95/198/381`），收尾逐个 DROP | **exit=0**、`RESULT=PASS 13 组`、`CLEANUP=done`；跑完集群里 `gengyun*` 角色只剩 `gengyun_ci_owner` | **接线** |
| 2 | `tests/integration/account-suspend-pg.mjs` | `node <脚本> <ownerUrl> <runtimeRoleUrl>`（只应用 0001–0017，断言恰 17 条迁移）；`:179 CREATE ROLE … PASSWORD '<randomBytes(24)>'` 与 argv[3] 的口令**无关** | **exit=1**，首个失败 `28P01 password authentication failed for user "gengyun_api_runtime"` | **不接（脚本缺陷）** |
| 3 | `tests/integration/admin-accounts-read-pg.mjs` | `node <脚本> <ownerUrl> <runtimeRoleUrl>`（库名硬钉 `gengyun_admin_accounts_read_test`）；`:190-192` 运行时角色口令＝**从 argv[3] 的 URL 解出来**再 `CREATE ROLE` | **exit=0**（迁移三连／最小权限反向控制／真实 HTTP 三态＋nickname 回退＋游标翻页＋403/401 全过） | **接线** |
| 4 | `tests/integration/admin-flags-pg.mjs` | `node <脚本> <ownerUrl>`（库名硬钉 `gengyun_flags_test`）；`:249-262` 仅当 argv[3] 省略时自建/ALTER 运行时角色并把随机口令写进自己的 URL ⇒ **只传一个参数**才是自洽形态 | **exit=0**、`[ALL PASS]`，其中 `[H]` 等锁 **4007 ms** ⇒ `504 PROVIDER_TIMEOUT(retryable:true)` | **接线** |
| 5 | `tests/integration/backup-purge-pg.mjs` | `node <脚本>`，需 `GY_PG_BIN` 指向**服务端二进制目录**（自行 `initdb`/`pg_ctl` 起第二个 17.11 集群，端口 `55500 + randomInt(0,500)`，无 env 覆盖） | 本机（`GY_PG_BIN=E:\GengYunCommander\.pg17\pgsql\bin`）**exit=0**、`PASS 13 组`、临时集群 55650 起停干净 | **不接（环境前提）** |

`MANAGED_SCRIPTS`：**4 → 7**（新增上面 #1/#3/#4 三条，`FROZEN_MANAGED_SCRIPTS` 逐字同步）。

---

## 2 判「不接」之一：`account-suspend-pg.mjs`（脚本缺陷，非环境）

### 2.1 失败原文（`:55612` scram 集群 + `gengyun_ci_owner` + 空库 `gengyun_suspend_test`）

```
node tests/integration/account-suspend-pg.mjs \
  postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55612/gengyun_suspend_test \
  postgres://gengyun_api_runtime:synthetic-pw@127.0.0.1:55612/gengyun_suspend_test
```
读数（全量：`.pg17/handoff/r28-s14-logs/account-suspend-pg.ciparity-scram.log`）：

```
[M] 迁移清单 23 个…；本脚本只应用 0017_account_suspend_authority.sql 及其之前的版本
[M] UP / ROLLBACK / REPLAY 三段全部通过
[P] 已按出厂区域 gy-i22-suspend-grant 授予 EXECUTE（恰好 3 条：suspend/restore/display_name）
首个失败读数：password authentication failed for user "gengyun_api_runtime"
清理：删除本脚本新建的 7 个角色（gengyun_auth_privacy,…,gengyun_api_runtime）
FAIL：有运行时 URL 但读数未全部通过 —— 首个失败：password authentication failed for user "gengyun_api_runtime"
error: password authentication failed for user "gengyun_api_runtime"
  severity: 'FATAL', code: '28P01', routine: 'auth_failed', file: 'auth.c'
EXITCODE=1
```

- 首个失败行：`tests/integration/account-suspend-pg.mjs:199`（用 `runtimeUrl.href` 连库的那一条）；
  栈经由 `pg-protocol/dist/parser.js:306` 抛 `DatabaseError`。
- `[P]` 之后 **`[A]`–`[F]` 一条都没跑**（全部落在「未取得」）⇒ 这不是「断言红了」，是**连不上**。
- 同一脚本在 `:55611`（`--auth=trust`）上是 exit=0 → **红的唯一变量是认证方式**：
  `:179` 建角色时用的是脚本内新生成的 `randomBytes(24)`，而连接用的是 argv[3] 里带的口令；
  trust 下口令不校验所以「碰巧绿」，scram 下必然不匹配。

### 2.2 为什么 CI 一定是 scram（不是我这边自己加的）

- `.github/workflows/real-pg-integration.yml:44-51` 的 service 只给了 `POSTGRES_PASSWORD`
  （`synthetic-ci-owner-only`），**没有**给 `POSTGRES_HOST_AUTH_METHOD`；官方 `postgres` 镜像在
  「给了 `POSTGRES_PASSWORD`、没显式指定认证方式」时的行为就是 `host all all all scram-sha-256`
  （镜像文档 `POSTGRES_HOST_AUTH_METHOD` 一节：默认 `scram-sha-256`，要 `trust` 必须显式设）。
- 我这边的复现集群就是照这个口径建的（`--auth-host=scram-sha-256`，`password_encryption` 实测
  `scram-sha-256`），并且把超级用户改名成 `gengyun_ci_owner` ⇒ 口令校验路径与 CI 一致。

### 2.3 另一条独立缺陷（即使口令修好也会踩）

`provisionRoles` 里的 `CREATE ROLE` 是**无条件**执行的。本片在「角色已存在」的状态下复跑：
`首个失败读数：role "gengyun_auth_privacy" already exists`，`code: '42710'`，`routine: 'CreateRole'`，
调用点 `account-suspend-pg.mjs:177`（`provisionRoles`）／`:493`（顶层），exit=1
（日志 `.pg17/handoff/r28-s14-logs/account-suspend-pg.ciparity-rolesexist.log`）。

🔁 **R28-S18 订正（本机真集群实测，2026-10-20，集群 `:55601`）**：上一段结论有两处不准确。

**（a）首个 `42710` 不是 `:179` 抛的，是 `:177` 抛的。** `provisionRoles`（`:174`）先把
`roles/auth_privacy.sql`、`catalog_readers.sql`、`consent_granter.sql`、`profile_runtime.sql`、
`knowledge_runtime.sql` 依次执行（`:176-178`），再在 `:179` 建运行时角色。首个 `42710` 的失败角色名是
`gengyun_auth_privacy`——它只出现在出厂文件 `services/api/db/roles/auth_privacy.sql:5`
（`CREATE ROLE gengyun_auth_privacy NOLOGIN …`，**无条件、无 `IF NOT EXISTS`**），而 `:179` 建的是
`gengyun_api_runtime`。直接对照读数：
`psql -f services/api/db/roles/auth_privacy.sql` ⇒
`psql:services/api/db/roles/auth_privacy.sql:5: ERROR:  role "gengyun_auth_privacy" already exists`。

**（b）触发条件是「同名角色的 `DROP ROLE` 失败」，不是「集群里有同名角色」。**
`provisionRoles` 开头先 `resetRoles()`（`:164-168`），对每个同名角色做 `DROP OWNED BY` +
`DROP ROLE IF EXISTS`，**两条都 `.catch(() => {})` 吞掉失败**。于是两种情况分岔：

- 同名角色**裸存在**（无任何依赖）⇒ `resetRoles()` 删得掉 ⇒ suspend 依旧只红在 `28P01`
  （实测：预建裸 `gengyun_auth_privacy` 后复跑，首个失败仍是
  `password authentication failed for user "gengyun_api_runtime"`，日志无 `42710`）；
  成员关系也不构成钉子（`GRANT` 后被授角色/组角色 `DROP ROLE` 均成功，实测 exit=0）。
- 同名角色**在另一个数据库里拥有对象或持有那里的 ACL** ⇒ `DROP OWNED BY` 只作用于当前库、
  清不到跨库依赖 ⇒ `DROP ROLE` 失败被吞 ⇒ `:177` 再建同名角色 ⇒ `42710`
  （实测：让 `gengyun_auth_privacy` 在另一个库拥有表后复跑，首个失败读数
  `role "gengyun_auth_privacy" already exists`、`code: '42710'`）。

⇒ 在同一条 workflow 里，能触发它的是「前面留下**带跨库依赖**的角色」，不是「留下同名角色」：

- `admin-accounts-read` 收尾不清理，会留下 1 个运行时 + 6 个组角色（实测 7 个），这些角色在
  `gengyun_admin_accounts_read_test` 里的 ACL/对象所有权就是钉子 ⇒ suspend 排在它后面**必红**
  （实测：前者 exit=0 后紧接跑 suspend，首个失败 `role "gengyun_auth_privacy" already exists`、`42710`）。
- `admin-flags` **不执行任何 `roles/*.sql`**（不建组角色），只建/复用 1 个运行时角色，并在收尾按
  `pg_roles` 基线差集把它自己建的角色 `DROP OWNED BY` + `DROP ROLE` 清掉（实测 `[ALL PASS]` 后
  `pg_roles` 里 `gengyun%` 只剩 `gengyun_ci_owner`）⇒ 它排在 suspend 前面**无害**。

所以「只能把它排在第一个」不成立；真正的要求是**排在 `admin-accounts-read` 之前**——
这条顺序已由 R28-S18 钉进守卫（`tests/unit/ci-real-pg-wiring.test.mjs` 的判据⑥ `REQUIRED_STEP_ORDER`）。
复跑日志：`.pg17/s18-work/expA.log`（裸角色 ⇒ 28P01）、`expB.log`（跨库对象钉住 ⇒ 42710）、
`expM1.log`（admin-flags 全清）、`expM2.log` / `expM2b.log`（accounts-read 留 7 个角色 ⇒ suspend 42710）。

### 2.4 最小修法（本片不改脚本，供后续切片）

🔁 **R28-S18 订正**：只改 `:179`（或只给 `:179` 加 ALTER 回退）**修不好**——首个 `42710` 在 `:177`
就抛了，`:179` 根本没执行到（见 §2.3）。最小修法必须同时覆盖三层：

1. `:177` 执行的 5 个出厂角色文件（`roles/auth_privacy.sql`、`catalog_readers.sql`、
   `consent_granter.sql`、`profile_runtime.sql`、`knowledge_runtime.sql`，共 6 个角色名）都是
   **无条件** `CREATE ROLE`（例如 `auth_privacy.sql:5`）⇒ 改成「存在即复用」：`CREATE ROLE` 失败即
   `ALTER ROLE`，或先查 `pg_roles`，与 `admin-flags-pg.mjs:249-263` 的「存在则 ALTER」同口径。
2. 让角色真的「可删」：`DROP OWNED BY` 只作用于**当前库**，跨库对象所有权/ACL 清不到 ⇒ 要么到对应库
   去清，要么给每个 step 独立集群（与现有共享 `services.postgres` 的形状冲突）；否则 `resetRoles()`
   永远删不掉，只能靠第 1 层兜住。
3. `:179` 改成：运行时角色口令**从 argv[3] 的 URL 解出**再 `CREATE ROLE`（与
   `admin-accounts-read-pg.mjs:190-192` 同手法）；或先 `CREATE ROLE` 再
   `ALTER ROLE … PASSWORD '<argv[3] 的口令>'` 把两边对齐。

⛔ **不允许的修法**：放宽 `[A]`–`[F]` 断言、加 `--allow-skip`、在 workflow 里塞 `|| true`。

---

## 3 判「不接」之二：`backup-purge-pg.mjs`（环境前提在 CI 上不成立）

- 脚本要求 `GY_PG_BIN` 指向**服务端二进制目录**（`:52`、`:90`、`:111` 断言 `initdb` 存在），
  自己 `initdb`（`:113`）+ `pg_ctl start`（`:115`）+ `pg_ctl stop`（`:132`）起**第二个 17.11 集群**；
  端口由 `:89 const port = 55500 + randomInt(0, 500);` 决定，**没有** env 可覆盖。
- 缺 `GY_PG_BIN` 时脚本 `:55-63` 打印 `SKIP` 并 **exit 77**；只有 `--allow-skip`／`GY_ALLOW_SKIP=1`
  才降级为 0 ⇒ 在 CI 里「设不了 GY_PG_BIN」就等于**每轮 77**，而 77 不是通过（⛔ 也不许用放宽开关）。
- CI 侧的事实（**确定的那部分**）：17.11 只在 `services.postgres` **容器内**（`image: postgres:17.11`），
  runner 上的 step 进程与外层容器不共享文件系统 ⇒ 拿不到另一个容器里的 `/usr/lib/postgresql/17/bin/initdb`。
  runner 镜像自带的是发行版打包的 PostgreSQL（16.x 一类，**本片没有网络取证能力，未在片内复核具体版本**，
  见 §7 第 2 条）；即便它自带 17，把 `GY_PG_BIN` 指过去的做法也与 job 名/守卫
  （`ci-real-pg-wiring.test.mjs` 的 `REQUIRED_POSTGRES_MAJOR = '17'`）所声明的「17.11 service」前提脱节——
  那就成了「换一个没被任何守卫钉住的 17 实例」，而不是这条 workflow 想证明的东西。
- 结论：本机 exit=0 是真读数（`.pg17/handoff/r28-s14-logs/backup-purge-pg.log`，13 组 PASS，
  临时集群 55650 起停干净、`CLEANUP=done`），但**在现有 job 形状下不可接**。要接得另开切片：
  在 runner 上装 PG 17 服务端包（PGDG 源）或把这一条搬到 `container: postgres:17.11` 的 job 里，
  并让脚本支持端口/数据目录的 env 覆盖。

---

## 4 接线改动面（只动了派单允许的四类文件）

| 文件 | 改动 |
| --- | --- |
| `.github/workflows/real-pg-integration.yml` | `+37` 行：追加 3 个 step（`account-deletion` / `admin-accounts-read` / `admin-flags`），形状与既有 4 步一致：`psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE …' && node …`，每个脚本一个**专用空库**；argv 形态按各脚本自洽的那一种（见 §1 表） |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `MANAGED_SCRIPTS` 4→7、`FROZEN_MANAGED_SCRIPTS` 4→7（逐字同步）＋ 清单上方注释补上「为什么另两条没进」 |
| `tests/unit/ci-integration-chain-structure.test.mjs` | 五条候选的 `reason` 如实订正：三条改成「由 `real-pg-integration.yml` 的独立真库 job 运行」；`account-suspend` 写成脚本缺陷（28P01/42710 + 修法页链）；`backup-purge` 写成环境前提（runner 无 17 服务端二进制 + 端口不可覆盖） |
| `docs/verification/gy-r28-real-pg-wiring-3-20261020.md` | 本页（新增） |

**为什么 `UNWIRED_DECLARATIONS` 里这五条一条都不删**：那个白名单判的是
「在不在 `test:integration:http` 扁平链里」，不是「有没有 workflow 跑」。接进真库 job 的脚本
仍然不在 http 链里，删掉声明会让断言 4 判红（未声明未接线）。所以正确做法是**保留条目、把
`reason` 改成「由真库 job 运行」**——既有四条（conversations/community/messages/favorites-history）
就是这个形状，本片新增的三条照抄。

**没动**（红线）：五个被测脚本、`docs/architecture/contract-status.json`、`services/api/src/**`、
`services/api/db/migrations/**`、`package.json`。

---

## 5 负控制：两条，都「由绿变红」，还原后 sha256 逐字节相等

### 负控制 ①：删掉 workflow 里 `account-deletion` 的 `run:` 行（`MANAGED_SCRIPTS` 仍含它）

- 判据：`ci-real-pg-wiring.test.mjs` 的①②③（受管脚本必须被某个 workflow 的 `run:` 真跑）。
- 实测（删 1 行，`node --test tests/unit/ci-real-pg-wiring.test.mjs`）：

```
AssertionError [ERR_ASSERTION]: 有受管真库脚本既没有被任何 workflow 的 `run:` 执行，也没有对应的真库臂——
这类脚本坏了 CI 也不会红（「脚本在 main、但没人跑」的静默缺口）：
  · tests/integration/account-deletion-pg.mjs
反向控制⑦也同时红：AssertionError: 删掉 run 行后必须且只能点名被删的那个脚本
+ actual - expected   +   'tests/integration/account-deletion-pg.mjs',
pass 8 / fail 4 / EXITCODE=1
```

- 还原：`git checkout -- .github/workflows/real-pg-integration.yml`
  sha256 `FF9DB5A8746A1E09FA785B6A8587B9605E30DD0651C78C35E7383DB2B8C4A904`
  → 还原后 **同值**（`byte_exact_restore=true`）。

### 负控制 ②：从 `UNWIRED_DECLARATIONS` 删掉 `admin-flags-pg.mjs` 的声明（文件仍在 `tests/integration/`）

- 判据：`ci-integration-chain-structure.test.mjs` 的断言 4（未接线又未声明 ⇒ 红）。
- 实测（删 355 字节的条目，`node --test tests/unit/ci-integration-chain-structure.test.mjs`）：

```
AssertionError [ERR_ASSERTION]: tests/integration 下有既未接线、也未在本文件 UNWIRED_DECLARATIONS
声明的脚本：tests/integration/admin-flags-pg.mjs。请二选一：接进 test:integration:http 链，或在白名单里写明原因。
+ actual - expected
EXITCODE=1
```

- 还原：`git checkout -- tests/unit/ci-integration-chain-structure.test.mjs`
  sha256 `F32E6CFF0CB3D15D6DF440C73B842F4CF7EC00DD6BCD2E1A0E55E4337DA1B5CB` → 还原后 **同值**。

---

## 6 门禁读数（本片收尾时实跑）

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| CI 接线守卫 | `node --test --test-isolation=none tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | 见 §6.1 |
| 静态检查 | `npm run lint` | 见 §6.1 |
| 契约 | `npm run test:contract` | 见 §6.1 |
| 回归（已接线的四条） | 见 §6.2 | 4/4 exit=0 |

### 6.1 守卫／lint／contract（收尾实跑）

| 门禁 | 读数 |
| --- | --- |
| `node --test --test-isolation=none tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | `tests 19 / pass 19 / fail 0`，`EXITCODE=0`（含受管清单 7 条逐条被 `run:` 命中的前向①、以及反向控制①／⑦） |
| `npm run lint` | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描`、`lint 通过`，`EXITCODE=0` |
| `npm run test:contract` | `tests 6 / pass 6 / fail 0`，`EXITCODE=0` |

### 6.2 回归：既有四条在**同一个 scram 集群**上重跑

| 脚本 | 命令形态 | 读数 |
| --- | --- | --- |
| `conversations-pg.mjs` | `CONVERSATIONS_PG_TEST_URL=…:55612/gengyun_conversations_test` | exit=0，12 条读数全过 |
| `community-pg.mjs` | `COMMUNITY_PG_TEST_URL=…:55612/gengyun_community_test` | exit=0，23 组全过（含「无连接池 ⇒ 503」） |
| `messages-pg.mjs` | `node … <url>`（argv） | exit=0，含三条「未取得」如实登记 |
| `favorites-history-pg.mjs` | `FAVORITES_HISTORY_PG_TEST_URL=…:55612/gengyun_favorites_history_test` | exit=0，13 组全过 |

### 6.3 原始输出落盘位置

全部在本机 `E:\GengYunCommander\.pg17\handoff\r28-s14-logs\`（不进仓）：

| 文件 | 内容 |
| --- | --- |
| `account-deletion-pg.log` / `.ciparity.log` | trust 首跑 / scram＋`gengyun_ci_owner` 等价复跑（均 exit=0） |
| `admin-accounts-read-pg.log` / `.ciparity.log` | 同上 |
| `admin-flags-pg.log` / `.ciparity.log` | 同上（含 `[H]` 4007 ms ⇒ 504） |
| `account-suspend-pg.log` | trust 首跑 exit=0（**不能**作为可接证据） |
| `account-suspend-pg.ciparity-scram.log` | **判不接的决定性读数**：28P01，见 §2.1 |
| `account-suspend-pg.ciparity-rolesexist.log` | 角色已存在 ⇒ 42710，见 §2.3 |
| `backup-purge-pg.log` / `backup-purge-pgserver.log` | 本机 `GY_PG_BIN` 真跑 13 组 PASS / 临时集群服务端日志 |
| `regress-conversations-pg.log` 等 4 个 | §6.2 的四条回归 |

---

## 7 我没做到的取证（如实登记）

1. **没有在真正的 GitHub runner 上跑过这条 workflow**（本片无凭据、不 push）。所有 CI 等价证据
   都是「本机 PG 17.11 + scram + 同名超级用户 + 同库名」的复现，不是 Actions 的实测日志。
2. `backup-purge` 的「runner 取不到 17 服务端二进制」里，**只有容器隔离那半截是确定事实**；
   「runner 自带的是 16.x」这半截本片**没有**取证（没有 shell 进过 runner、也没有网络去查镜像清单），
   是按公开镜像常识写的，已在上文标注。
3. `postgres:17.11` 镜像的 `pg_hba.conf` 默认认证方式，本片用的是「官方镜像文档默认
   `scram-sha-256`」这条既有认知 ＋ 本机 `--auth-host=scram-sha-256` 同构集群复现；
   **没有**拉镜像进去看 `pg_hba.conf`（本机无 Docker 凭据、无网络取证）。也就是说：
   account-suspend 的 28P01 结论建立在「CI 是 scram」这个前提上；**这个前提我是用同构集群证的，
   不是用真镜像证的**。
4. 三条新接线的脚本在 CI 上的**总耗时**没有测（本机单跑各 ~10–40 s，job `timeout-minutes: 15`
   的余量没有实测）。
5. `account-suspend` 的修法只给了方向，没有验证（本片不允许改那五个脚本）。
6. **没有做 YAML round-trip 校验**：本树 `node_modules` 里既没有 `yaml` 也没有 `js-yaml`
   （实测 `Cannot find module`），本片无网络可装。workflow 的 3 个新 step 是**逐字照抄**既有 4 个 step
   的缩进与键序，并且守卫的 `run:` 提取器已按 YAML 语法把 7 条受管脚本全部解析出来（19/19 绿）；
   但「这份 YAML 能否被 GitHub 解析」只有 merge 后那次真实 run 能最终确认。

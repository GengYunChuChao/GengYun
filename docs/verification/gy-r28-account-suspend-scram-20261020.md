# R28-S16：`account-suspend-pg.mjs` 的 scram 自洽化（自建角色 / 派生 URL / 角色残留复用）

日期 2026-10-20。被测文件 `tests/integration/account-suspend-pg.mjs`。
起点基线 `47fe028`，迁到 `4122976`（`#327` 之后）；本片 HEAD `c0e2cc5`，`git diff --stat origin/main..HEAD` 只动该脚本（+101/−20，2 个提交）。
集群：本轮自建 PG 17.11 scram 集群（`127.0.0.1:55801`，`--auth-host=scram-sha-256`）。**本页每个读数都是本轮真跑**；日志在 `E:\GengYunCommander\.pg17\tmp-r28s16\*.log`（一次性本地集群，未入库）。

## 0. 结论

| 调用形态 | 改前 `ce8e77d…`（531 行 / 28404 B） | 改后 `fea5c274…`（613 行 / 34065 B） |
| --- | --- | --- |
| 给 `argv[3]`（口令与 URL 一致） | exit 1，**`28P01`** | exit 0，`ALL PASS` |
| 不给 `argv[3]` | exit 2，`PARTIAL`（`[P]`/`[A]`–`[F]` 全未取得） | exit 0，`ALL PASS`（自建角色 + 派生 URL） |
| 同名角色已存在（跨库依赖） | exit 1，**`42710`** | 复用（ALTER），仍 `ALL PASS` |

**行为变更（审查重点）**：改前「省略 `argv[3]`」= **部分跑**（只有 `[M]`）；改后 = **全跑**。这不是放宽：结论行同时要求 `taken` 台账齐全 ∧ 零 `未取得` ∧ 零失败（§2.3），因此「少跑一段」现在只会更红，不会更绿。

## 1. 缺陷与复现

### 1.1 集群确实是 scram（不是 trust）

- `select version()` → `PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit`
- `pg_authid`：`postgres` 与 `gengyun_ci_owner` 的口令哈希均为 `SCRAM-SHA-256$4096:…`
- `pg_hba.conf`：`host 127.0.0.1/32 … scram-sha-256`、`host ::1/128 … scram-sha-256`、`local … trust`
- `postgresql.conf`：`password_encryption = scram-sha-256`
- 反证：`PGPASSWORD=<错>` 连 `gengyun_ci_owner` ⇒ `FATAL:  password authentication failed for user "gengyun_ci_owner"`（exit 2）；正确口令才拿到上面的 version 行。

### 1.2 改前必红（**给了** `argv[3]`）

命令（`gengyun_suspend_test` 已按「空库」要求重建）：

```
node tests/integration/account-suspend-pg.mjs `
  'postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55801/gengyun_suspend_test' `
  'postgres://gengyun_api_runtime:caller-chosen-pw-1111@127.0.0.1:55801/gengyun_suspend_test'
```

exit **1**。日志 `before-red2-with-argv3.log`（48 行）：

- `:1`–`:4` `[M]` 三连全过；`:5` `[P] 已按出厂区域 gy-i22-suspend-grant 授予 EXECUTE（恰好 3 条：suspend/restore/display_name）`
- `:14` `FAIL：有运行时 URL 但读数未全部通过 —— 首个失败：password authentication failed for user "gengyun_api_runtime"`
- `:19` `error: password authentication failed for user "gengyun_api_runtime"`；`:20` 起栈只落在 `pg-protocol/dist/parser.js:306`（客户端解析层），**没有脚本帧**
- `:30` `severity: 'FATAL'`、`:31` `code: '28P01'`、`:43` `file: 'auth.c'`、`:44` `line: '332'`、`:45` `routine: 'auth_failed'`

**失败代码行**：`tests/integration/account-suspend-pg.mjs:200`（`await client.connect();`；连接串取自 `:199` 的 `runtimeUrl.href`）。
**根因行**：`:179`

```js
await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${randomBytes(24).toString('hex')}'`);
```

口令在这里现生成、从不外露，而调用方只能拿 `argv[3]` 里**另一个**口令去连 ⇒ scram 下必然 28P01。

### 1.3 改前另一种形态（**不给** `argv[3]`）—— 订正派单

`node tests/integration/account-suspend-pg.mjs '<ownerUrl>'` ⇒ exit **2**，日志 `before-red2-no-argv3.log`：

- `:6` `未取得 [P] 最小权限反向控制：未提供运行时角色 URL（argv[3]）`
- `:7` `未取得 [A][B][C][D] HTTP 手臂：未提供运行时角色 URL（argv[3]），无法以最小权限跑真实 HTTP`
- `:8` `未取得 [E][F] 并发与失败注入：未提供运行时角色 URL（argv[3]）`
- `:11` `PARTIAL：未取得真库读数 —— 未提供运行时角色 URL（argv[3]），仅库侧 [M] 为真；[P]/[A]–[F] 未取得`

⇒ 派单里「本脚本**不给** `argv[3]` 就 28P01」的说法不准确：28P01 只在**给了** `argv[3]` 时出现（`runtimeUrl` 非 null 才会走到 `:200`）；不给则是「部分跑 + PARTIAL + exit 2」。

### 1.4 第二个独立缺陷：角色残留 ⇒ `42710`

`provisionRoles()` 对 5 个出厂角色区域（`services/api/db/roles/{auth_privacy,catalog_readers,consent_granter,profile_runtime,knowledge_runtime}.sql`，合计 **7 条** `CREATE ROLE … NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`）以及 `gengyun_api_runtime` 全是**无条件 CREATE**。CI 里同一 `services.postgres` 容器被同 workflow 的其它 step 复用（`#327` 刚接入的 `admin-accounts-read`/`admin-flags` 都会留下这 7 个角色），而「先 DROP 再 CREATE」也不可行：

```
psql: ERROR:  role "gengyun_auth_privacy" cannot be dropped because some objects depend on it
DETAIL:  1 object in database gengyun_hold
```

（`pc1-drop-refusal.log`，exit 1。这就是为什么修法必须是「存在即复用」而不是「删掉重建」。）

## 2. 修法

### 2.1 口令单一来源 + 省略 `argv[3]` 时派生 URL

- 新增 `const providedRuntimeUrl = runtimeArg === undefined ? null : new URL(runtimeArg);` 与 `let runtimeUrl = providedRuntimeUrl;`
- `provisionRoles()` 里：
  ```js
  const runtimePassword = providedRuntimeUrl === null
    ? randomBytes(24).toString('hex')
    : decodeURIComponent(providedRuntimeUrl.password);
  assert.ok(runtimePassword.length > 0, '运行时 URL 必须带口令（scram 集群上没有口令必然 28P01）');
  const runtimePasswordSql = runtimePassword.replace(/'/g, "''");
  ```
  （转义照 `tests/integration/admin-accounts-read-pg.mjs:190-192`。）
- 同一个 `runtimePassword` 既写进 `CREATE/ALTER ROLE … PASSWORD`，又在省略 `argv[3]` 时派生连接串：
  ```js
  const derived = new URL(ownerUrl.href);
  derived.username = RUNTIME_ROLE;
  derived.password = runtimePassword;
  runtimeUrl = derived;
  ```
  ⇒ 建角色用的口令 ≡ 后续 `leastPrivilege()` / `httpEvidence()` / `concurrencyAndInjection()` 连接用的口令。

### 2.2 角色残留 ⇒ CREATE 换 ALTER（属性逐字相同）

新增 `const GROUP_ROLE_ATTRS = 'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';` 与 `runRoleRegion(file)`：

- 逐条 `^CREATE ROLE (\w+) [^\n]*$`，**先断言**出厂语句逐字等于 `CREATE ROLE <name> <GROUP_ROLE_ATTRS>;`（属性被改过就立刻失败；不是宽松匹配）；
- 查 `pg_roles`：已存在则把该条换成 `ALTER ROLE <name> <GROUP_ROLE_ATTRS>;` 并记一行
  `[P] 复用已存在的组角色 …（跨库依赖使其不可 DROP ⇒ CREATE 换 ALTER，属性逐字相同）`；
- `gengyun_api_runtime` 同样「查 `pg_roles`，有则 `ALTER ROLE … PASSWORD`、无则 `CREATE ROLE`」（`tests/integration/admin-flags-pg.mjs:249-263` 范式）。

⇒ 同一集群重复跑、或排在本 workflow 其它 `-pg` 脚本之后都不再 42710，且**不删**别人的角色。

### 2.3 结论行收紧（防「少跑一段」冒充通过）

新增 `const taken = new Set();` 与 `const REQUIRED_ARMS = ['M', 'P', 'A-D', 'E-F'];`：每个手臂真跑完才 `taken.add(...)`；末段
`const missingArms = REQUIRED_ARMS.filter((arm) => !taken.has(arm));`。
只要 `taken` 不齐，即使「零失败 ∧ 零 `未取得`」也走 `PARTIAL …（未登记手臂：…）` + `process.exitCode = 2`。
`ALL PASS` 只在「`taken` 齐全 ∧ 零 `未取得` ∧ 零失败」时出现。

### 2.4 改前 → 改后 行为对照（审查用）

| 场景 | 改前 `ce8e77d…` | 改后 `fea5c274…` |
| --- | --- | --- |
| 给 `argv[3]`、口令一致 | 建角色用另一个随机口令 ⇒ **28P01，exit 1** | 用 URL 口令建/改角色 ⇒ `ALL PASS`，exit 0 |
| 给 `argv[3]`、口令为空 | 28P01（或 SQL 语法错） | `assert.ok` 明确失败，不猜 |
| 不给 `argv[3]` | 只跑 `[M]`，`PARTIAL`，exit 2 | 自建角色 + 派生 URL，**全套**跑完，`ALL PASS`，exit 0 |
| 同名角色已存在（跨库依赖） | `42710 role … already exists` | 复用（ALTER 重置口令/属性），继续跑 |
| 同集群重复跑 | 第二次必红（42710） | 幂等绿；清理只 DROP 本轮新建的 |
| 少跑一个手臂 | 可能仍 `ALL PASS` | `taken` 缺项 ⇒ `PARTIAL` + exit 2（NC3 实证） |

## 3. 改后必绿（两种调用形态）

### 3.1 不给 `argv[3]`

```
node tests/integration/account-suspend-pg.mjs 'postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55801/gengyun_suspend_test'
```

exit **0**，`green3-no-argv3.log`（19 行）：

- `:5` `[P] 未给 argv[3] ⇒ 本脚本自建角色并派生运行时 URL（用户 gengyun_api_runtime，口令 48 位，不打印）`
- `:9` `[A] 停用 ⇒ 200，data.state=suspended，revision=2，display_name=耕云用户12C0`
- `:15` `[E] 并发双停用 ⇒ changed=true/false，auth_epoch 1→2（恰好 +1），审计恰好 1 行`
- `:16` `[F] 第 4 步（写审计，23505）失败 ⇒ PROVIDER_UNAVAILABLE；state/auth_epoch/revision 逐字未变 {"state":"active","auth_epoch":"1","revision":1}；已撤会话 0→0；审计 0 行`
- `:19` `ALL PASS：迁移三连 / 最小权限 / A–E / 失败注入 全部取得真库读数`

### 3.2 给 `argv[3]`（口令与角色一致）

```
node tests/integration/account-suspend-pg.mjs `
  'postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55801/gengyun_suspend_test' `
  'postgres://gengyun_api_runtime:caller-chosen-pw-1111@127.0.0.1:55801/gengyun_suspend_test'
```

exit **0**，`green3-with-argv3.log`（18 行）：`:8` `[A] … display_name=耕云用户1A40`、`:14` `[E] … auth_epoch 1→2`、`:18` `ALL PASS…`。

两形态的 `[B]` `401 SESSION_EXPIRED`、`[C]` `403 ACCOUNT_INACTIVE`、`[D]` `auth_epoch=3` 且旧 token 仍 401、两条审计、`[P]` 六条 42501 拒绝，均见两份日志全文；`[S]` 仍如实写着「`90-assert-least-privilege.sql` 含 psql 元命令 ⇒ 由 `psql -f` 单独执行」。

## 4. 正控制 PC1：角色残留下也必须全绿

前置：`gengyun_hold` 库 + 7 个角色 + 每个角色一张表归其所有（制造跨库依赖）；`DROP ROLE gengyun_auth_privacy` ⇒ exit 1（§1.4 原文）。
随后同一集群、`gengyun_suspend_test` 重建为空库，脚本**不给 `argv[3]`** ⇒ exit **0**，`pc1b-leftover-allpass.log`（26 行）：

- `:5`–`:10` 六条 `[P] 复用已存在的组角色 …（跨库依赖使其不可 DROP ⇒ CREATE 换 ALTER，属性逐字相同）`
- `:11` `[P] 复用已存在的运行时角色 gengyun_api_runtime（跨库依赖使其不可 DROP；非本轮残留）`
- `:25` `清理：删除本脚本新建的 0 个角色（无）`
- `:26` `ALL PASS：迁移三连 / 最小权限 / A–E / 失败注入 全部取得真库读数`

## 5. 负控制（每条都做 sha256 逐字节还原）

通用流程：`sha256(基线)` → `node ncmut.mjs <脚本> ncN`（临时脚本，单行单处替换；目标不唯一/不存在即 exit 3/4）→ 重建空库 → 跑 → `git checkout HEAD -- tests/integration/account-suspend-pg.mjs` → 复核 sha256 与 `git status --porcelain` 行数。
基线每次都是 `fea5c2744d3050395bf200010acd757d297bdf8eaf0a3d3a452ce60552279687`（34065 B）。

### NC1 口令与建角色不一致 ⇒ 必 28P01

- 变异：`decodeURIComponent(providedRuntimeUrl.password)` → 再来一次 `randomBytes(24).toString('hex')`（等价还原旧缺陷）
- 变异后 sha256 `e75ff0a9713291a55d068a003bbf259c5e002b6fb7dad3b3b64bcab605b7ad78`（34095 B）
- 命令：给 `argv[3]`（口令 `caller-chosen-pw-1111`，角色建的是另一个）
- 期望：非零退出且 28P01
- 实际：**exit 1**，`nc1.log`：`:6` `首个失败读数：password authentication failed for user "gengyun_api_runtime"`、`:14` `FAIL：有运行时 URL 但读数未全部通过 …`、`:19` `error: password authentication failed …`、`:31` `code: '28P01'`
- 还原：sha256 = `fea5c274…`，`git status --porcelain` **0** 行

### NC2 去掉派生 URL ⇒ 必须 PARTIAL 且非零

- 变异：`runtimeUrl = derived;` → `void derived;`
- 变异后 sha256 `df4b40ac6398a679fa8fcfa42e0d347b8ab3b5501c47fd63229b3e877b3aa0f2`（34095 B）
- 命令：不给 `argv[3]`
- 期望：`PARTIAL` + 非零，且逐条 `未取得`
- 实际：**exit 2**，`nc2.log`：`:7` `未取得 [P] 最小权限反向控制：运行时角色 URL 未派生（provisionRoles 未产出角色）`、`:8` `未取得 [A][B][C][D] HTTP 手臂…`、`:9` `未取得 [E][F] 并发与失败注入…`、`:12` `PARTIAL：未取得真库读数 —— 运行时角色 URL 未派生，仅库侧 [M] 为真；[P]/[A]–[F] 未取得（未登记手臂：P/A-D/E-F）`、`:22` `未取得手臂：P,A-D,E-F`
- 还原：sha256 = `fea5c274…`，status **0** 行

### NC3 删掉 `leastPrivilege()` 调用 ⇒ 不得 ALL PASS

- 变异：`await leastPrivilege();` → `void leastPrivilege;`
- 变异后 sha256 `ef64b2bab48bc5ff5ecd79dc81c265b549ae14b63430a4db2efcc7aff75ebfc9`（34108 B）
- 命令：不给 `argv[3]`（其余手臂照跑）
- 期望：不得 `ALL PASS`，非零
- 实际：**exit 2**，`nc3.log`：`:18` `PARTIAL：未取得全部真库读数 —— 仍有 0 条未取得（未登记手臂：P）`、`:19` `未取得手臂：P` ⇒ 即使「零未取得」也被 `taken` 台账拦住
- 还原：sha256 = `fea5c274…`，status **0** 行

### NC4 无条件 CREATE + 预建同名角色 ⇒ 必需 42710

- 前置：`gengyun_hold` 库 + `gengyun_api_runtime` 角色 + `nc4_keep` 表归它所有（跨库依赖）
- 变异：`if (existing.rowCount === 0) {` → `if (true) {`
- 变异后 sha256 `7f2736e6311b1f2931579847b7ef88a9721073a7df6ddb1ec6ae1e78bb74c8a2`（34083 B）
- 命令：不给 `argv[3]`
- 期望：非零退出且 42710
- 实际：**exit 1**，`nc4.log`：`:5` `首个失败读数：role "gengyun_api_runtime" already exists`、`:13` `FAIL：运行时角色 URL 未派生且库侧读数未通过 —— 首个失败：role "gengyun_api_runtime" already exists`、`:18` `error: role "gengyun_api_runtime" already exists`、`:25` `code: '42710'`
- 还原：sha256 = `fea5c274…`，status **0** 行；随后清掉 hold 库与同名角色

## 6. 门禁原始输出（HEAD `c0e2cc5`）

| 命令 | exit | 原始输出要点 | 日志 |
| --- | --- | --- | --- |
| `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）` / `lint 通过（静态检查；不代表运行期或真实服务已通过）。` | `gate2-lint.log` |
| `npm run test:contract` | 0 | `ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0` | `gate2-contract.log` |
| `node --test --test-isolation=none tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | 0 | `ℹ tests 19` / `ℹ pass 19` / `ℹ fail 0` | `gate2-unit.log` |

## 7. 订正与遗留

1. **派单订正**（§1.3）：「本脚本不给 `argv[3]` 即 28P01」不成立 —— 必红必须**给** `argv[3]`；不给只是「部分跑 + PARTIAL + exit 2」。
2. **上游证据页订正**（`docs/verification/gy-r28-real-pg-wiring-3-20261020.md`）：§2.1 把首失败行写作 `:199`，实测失败点是 `:200`（`:199` 只是构造 `connectionString` 的那行）；§2.4 的「最小修法」只覆盖 `gengyun_api_runtime`，**不足以**修掉 §2.3 里 `gengyun_auth_privacy` 的 42710 —— 组角色区域同样要 CREATE 换 ALTER（本片 §2.2 已实证）。
3. **本片未做（越界）**：
   - `tests/unit/ci-integration-chain-structure.test.mjs:76-84` 的 `UNWIRED_DECLARATIONS` 仍把本脚本的理由写成「脚本缺陷 ⇒ … 必 `28P01` … `42710`」；本片修好后该理由过期，但本片**不得改** `tests/unit/` ⇒ 留给接线切片。
   - `.github/workflows/real-pg-integration.yml` 接线（把本脚本加进 `MANAGED_SCRIPTS`、按 `admin-flags` 范式只传 owner URL）同样属接线切片，本片未动。
4. 本地一次性集群（`E:\GengYunCommander\.pg17\tmp-r28s16`）与临时变异脚本 `mutate.mjs` / `ncmut.mjs` **未入库**。

## 8. 复现（命令清单）

```pwsh
# 1) 每次跑之前必须是空库（脚本硬钉库名且要求空）
psql -w -h 127.0.0.1 -p 55801 -U postgres -d postgres `
  -c 'DROP DATABASE IF EXISTS gengyun_suspend_test WITH (FORCE);' `
  -c 'CREATE DATABASE gengyun_suspend_test OWNER gengyun_ci_owner;'

# 2) 两种形态（都必须在 scram 集群上）
node tests/integration/account-suspend-pg.mjs 'postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55801/gengyun_suspend_test'
node tests/integration/account-suspend-pg.mjs `
  'postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:55801/gengyun_suspend_test' `
  'postgres://gengyun_api_runtime:caller-chosen-pw-1111@127.0.0.1:55801/gengyun_suspend_test'
```

集群前提：`initdb --auth-host=scram-sha-256 --auth-local=trust`，`postgresql.conf` 设 `password_encryption = scram-sha-256`；**trust 集群下绿不算数**。

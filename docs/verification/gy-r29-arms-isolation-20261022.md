# 真库臂「同库隔离」修复与护栏（GY-R29 第二片 / F6）

- 基线：`5b631ec`（= 本片开工时 `origin/main`）｜分支 `test/gy-r29-arms-isolation`｜worktree `E:\GengYunCommander\wt-r29-isolation`
- 现场：本机 PostgreSQL 17.11（`E:\GengYunCommander\.pg17\pgsql\bin`，`initdb -U gengyun_ci_owner`，端口 `55661`，`scram-sha-256`）
- 范围：**只做 F6**（`auth-privacy-pg` 与 `migrations-negative-pg` 共用一库的隔离风险）。F2/F3/F4/F5 未动，见 §5。

## 1. 结论（五条）

1. **两个 step 曾经跑在同一个库上。** `.github/workflows/auth-privacy-postgres.yml` 的 `AUTH_PRIVACY_TEST_URL` 与 `MIGRATIONS_NEGATIVE_TEST_URL` 原都指向 `…/gengyun_auth_privacy_test`；一端的残留会掩住另一端（真红读数见 §2）。
2. **已分库**：`auth-privacy-pg` 独占 `gengyun_auth_privacy_test`；迁移负例的**维护连接**改指服务自带的空库 `postgres`，由脚本自建 `gengyun_migrations_negative_maint`（维护）与 `…_{a,b,c}`（被测），收尾删净并断言 `pg_database` 零残留。
3. **"按库限定"不能用 `IN DATABASE` 语法**：PG 17.11 实测 `ERROR: syntax error at or near "IN"`。⇒「只清本库」只能靠**只连本库**这个结构性约束。⚠ 早先把"逐库连接各做一次"当解法的实现**越界**了（会清掉同集群别人的库里属于 `gengyun_auth_privacy` 的对象/授权），已在 §7 返修。
4. **收尾不再吞错**：`migrations-negative-pg.mjs:464-492` 与 `auth-privacy-pg.mjs:403-429` 都改成分项 try/catch 收集故障 → 断言必须为空；另断言「本臂库/角色残留 = 0」。旧实现的 `.catch(() => {})` 是一条假绿通道（§2 R3）。
5. **护栏落地**：新增 `tests/unit/auth-privacy-arm-isolation.test.mjs`（4 条判据 + 8 条反向控制，11/11 pass），把「两 step 不同库」「不新增集成 step」「不吞错」「清理只碰本臂专用库」钉成静态门禁。判据 4 在监工 1927 轮 [P1] 后已**反向**（从"要求逐库清理"改成"禁止枚举集群库、必须证明收敛"），见 §7。

## 2. 改前真红读数（逐字）

**R1 同库复用**（本片复现；改后代码亦然，因为它就是"全新库"前置契约）：

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

29 !== 0

    at file:///E:/GengYunCommander/wt-r29-isolation/tests/integration/auth-privacy-pg.mjs:136:10
```

`:136` 是 `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'` 必须为 `0` 的**全新库前置断言**（该行是本臂原有关卡，非本片新增）。⇒ 同一个库被两个 step/两次运行共用时，"谁先跑"就决定另一个的红绿。

**R2 跨库依赖**（角色在**另一个库**里拥有对象，只在当前库 `DROP OWNED BY` 后再 `DROP ROLE`）：

```
CODE=2BP01  MESSAGE=role "probe_decoy_role" cannot be dropped because some objects depend on it
DETAIL=1 object in database probe_decoy_db
```

⇒ 旧收尾 `DROP OWNED BY a,b; DROP ROLE …`（单条、只清当前库）在跨库残留时必抛；若外层还有 `.catch`，红就被吃掉。
**返修后（§7）**：这条 2BP01 不再是"要绕开的障碍"，而是**边界证据**——本臂改用 `pg_shdepend` 只读预检，一旦发现角色在别的库还有依赖就**拒绝清理并点名那个库**，绝不连第二个库去 `DROP OWNED`。

**R3 吞错**（删库失败 + `.catch(() => {})`）：

```
CODE=55006  MESSAGE=database "probe_swallow_db" is being accessed by other users
吞错后该库仍存在=true（进程此刻 exit 0 语义）
```

⇒ 旧 `migrations-negative-pg.mjs` 收尾的 `.catch(() => {})` 会让"库没删掉"这一步照绿。

**R4 语法不可用**（否决"用 `IN DATABASE` 限定"这条捷径）：

```
ERROR:  syntax error at or near "IN"
LINE 1: DROP OWNED BY gengyun_ci_owner IN DATABASE postgres
```

## 3. 改了什么（文件:行 → 判据）

| 文件 | 位置 | 改动 | 判据 |
| --- | --- | --- | --- |
| `.github/workflows/auth-privacy-postgres.yml` | `:37-43` | `MIGRATIONS_NEGATIVE_TEST_URL` 改指 `…:5432/postgres`；注释写死"不要改回 `gengyun_auth_privacy_test`"；**不新增 step** | 两 step 库名不同；建/删库仍由脚本负责 |
| `tests/integration/auth-privacy-pg.mjs` | `:34-35` | 诱饵库/诱饵角色常量 `gengyun_auth_privacy_decoy_db` / `gengyun_auth_privacy_decoy` | 负控制可寻址 |
| 同上 | `:38` `:41` | `createdRoles`（只登记本次运行自建的角色）与 `cleanupDatabases`（清理路径连过的库）两个集合 | 「只删自己建的」「只连自己那个库」都留下可断言证据 |
| 同上 | `:43-53` | 清理边界注释：写明被否掉的「枚举非模板库逐库 `DROP OWNED BY`」及后果（`gengyun_auth_privacy` 是项目真实隐私组名） | 判据跟着边界走，不靠口头约定 |
| 同上 | `:59-69` | `foreignDependents(names)`：只读 `pg_shdepend`，取本臂角色在**其它库**的依赖对象（`deptype` 归属 + dbid 换成库名） | 越界前有据可查（`DROP ROLE` 的 2BP01 依据正是这些行） |
| 同上 | `:71-85` | `dropRolesScoped(names)`：有跨库依赖 ⇒ 抛 `拒绝清理角色 …在库 X 还有 N 个依赖对象…`；否则登记 `cleanupDatabases` 后**只连本臂库** `DROP OWNED BY` 再 `DROP ROLE` | 不枚举、不连第二个库（§7） |
| 同上 | `:155` `:161` `:163` | 开跑前的 `dropRolesScoped(ROLE_NAMES)` 取代逐库清理；bootstrap 与建 LOGIN 后各 `createdRoles.add(...)` 登记归属 | 顺序/并发不再决定红绿，且只清自己的 |
| 同上 | `:165-206` | **D0 边界负控制（CI 每次跑）**：诱饵库 `gengyun_auth_privacy_decoy_db` + 在该库拥有表/被授权的诱饵角色 → ①「只清当前库」必报 `cannot be dropped because some objects depend on it`；②本臂清理必须**拒绝**且点名诱饵库；③拒绝发生在连任何库之前（`cleanupDatabases` 为空）；④诱饵库里的行数与属主（`relowner::regrole::text`）**原样**；⑤删掉诱饵库后同一清理才成功，且清理路径只连过本臂库 | 收尾断言非空转 + 别的库不受影响（§7） |
| 同上 | `:444-468` | `catch` 记 `bodyFailure` 后重抛；`finally` **先删本臂诱饵库**再 `dropRolesScoped([...createdRoles])`，分项收集故障 → `assert.deepEqual(faults, [])`、残留角色/诱饵库 `deepEqual []`、`[...cleanupDatabases] === [url.pathname]`；正向臂已红时只打日志不盖原始失败 | 清理失败必红，且清理范围可核对 |
| `tests/integration/migrations-negative-pg.mjs` | `:123` `:125` | 专用维护库 `gengyun_migrations_negative_maint`、诱饵库 `gengyun_migrations_negative_decoy` | 维护连接不落在被测库 |
| 同上 | `:236-237` | 开跑前清掉本臂前缀的全部遗留库，并断言为零 | 上次残留不污染本次 |
| 同上 | `:242-253` | 维护库建立后断言"本臂库只剩维护库"；造诱饵库 → 断言探测器抓到 → 删掉 → 断言归零 | 探测器有牙 |
| 同上 | `:464-492` | 收尾去掉 `.catch(() => {})`；逐库删（含维护库）并收集故障；断言故障为空、`pg_database` 无本臂库、基准库 `public` 对象数不变 | 删库失败必红 |
| `tests/unit/auth-privacy-arm-isolation.test.mjs` | 新文件 | 判据 1-4（库名互异 + 维护库指向 `postgres` + 集成 step 数 == 2 + 不吞错/残留断言在场 + **`inspectAuth` `:103-129`：清理收敛到本臂专用库**）+ 反向控制 ①-⑧（每处变异必须红；⑤-⑧ 专门钉 §7 的四条边界） | 判据回退时测试必红 |

## 4. 改后读数

| 检查 | 命令 | 读数 |
| --- | --- | --- |
| 迁移负例（真库） | `MIGRATIONS_NEGATIVE_TEST_URL=…55661/postgres node tests/integration/migrations-negative-pg.mjs` | **exit 0 / 7.2 s / PASS 12 / 版本 17.11 / 26 迁移 / 台账 26 行**；含 `PASS 1: D1 遗留库负控制：诱饵库被抓到 → 清掉 → 探测器归零` |
| auth-privacy（真库） | `AUTH_PRIVACY_TEST_URL=…55661/gengyun_auth_privacy_test node tests/integration/auth-privacy-pg.mjs` | **exit 0 / 7.2 s / PASS 27 / 版本 17.11**；返修后同一条读数变成 `PASS 2: 清理边界负控制：本臂只清专用库——跨库依赖角色被拒绝清理且别的库对象/行/属主完好，删掉本地诱饵库后才成功，清理路径未连过第二个库`（§7 本地 55662 集群复现：`ALL 27 native PG17.11 integration groups passed`） |
| 收尾残留（外部核对） | `psql -Atc "SELECT string_agg(datname,',') FROM pg_database"`、`… FROM pg_roles WHERE rolname LIKE '%decoy%'` | 库：`postgres,gengyun_auth_privacy_test,template1,template0`；诱饵角色：`(none)` |
| 新判据单测 | `node --test tests/unit/auth-privacy-arm-isolation.test.mjs` | **11/11 pass**（118 ms）：4 条判据 + 8 条反向控制（8/8 是 3 判据 + 5 反向控制时代的读数） |
| 既有接线/顺序守门 | `node --test tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | **25/25 pass**（未放宽、未改步数） |
| **CI（Actions，PG 17.11 service）** | PR #426 | **18/18 pass**；`auth-privacy-postgres-17.11` `pass 36s`：`PASS 2: 跨库负控制：只在本库 DROP OWNED 时 DROP ROLE 报 dependent objects；每库清理后诱饵角色/诱饵库归零` + `ALL 27 native PG17.11 integration groups passed`；`PASS 1: D1 遗留库负控制：诱饵库被抓到 → 清掉 → 探测器归零（收尾断言非空转）` + `ALL 12 migration negative groups passed against native PG17.11 (Debian 17.11-1.pgdg13+2)`；step env 实测 `MIGRATIONS_NEGATIVE_TEST_URL: ***127.0.0.1:5432/postgres`（**分库在 CI 生效，且 service 里 `postgres` 库确实可用**）。⚠ 本行是**返修前**的 CI 读数：清理边界返修后 `PASS 2` 文案改为 §7 的边界负控制（本地已复现，远端 CI 随本轮推送刷新） |

## 5. 未改动与边界

- **不加 `CREATE DATABASE` step**：本 workflow 没有 `REQUIRED_STEP_ORDER` 之类的顺序常量，加 step 只会再造一套形状；建/删库仍由两个脚本自建自删（`migrations-negative` 用一个维护库 + 三个被测库）。因此 `ci-real-pg-wiring.test.mjs` 的四数组（15/15/15/3）与 `ci-integration-chain-structure.test.mjs` 的顺序判据**一行未改**。
- **F2/F3/F4/F5 未动**（20 只脚本的 `*_PG_ROOT` 统一、版本变量补齐、断言计数、诱饵断言等），按指挥要求另片处理。
- `auth-privacy-pg` 仍要求**全新库**（现 `:156` 断言；返修前为 `:136`）：CI 每个 job 一个新 `service` 满足；本地复跑必须先 `DROP DATABASE … WITH (FORCE)` 再建同名库（本片读数即如此取得）。
- 诱饵库/诱饵角色在**每次运行内**建立并删除，同名残留由 `:155`/`:236-237` 的开跑前清理兜住（返修后 `:155` 只碰本臂库，遇到跨库依赖会显式红而不是"顺手清掉"，见 §7）。

## 6. 未取得（单列）

- **GitHub Actions 读数——已取得**：PR #426 的 18 项检查全 pass（含 `unit-tests`、`real-pg-17.11` 15 臂、`auth-privacy-postgres-17.11`）。仍未取得的是"把 workflow 故意改回同库后 `auth-privacy` 必红"的**远端**红对照（本地已用 §2 R1 的 `29 !== 0` 覆盖，静态判据亦含变异必红）。
- **CI service 里 `postgres` 库可直连——已取得（不再是推断）**：Actions 日志显示 `MIGRATIONS_NEGATIVE_TEST_URL: ***127.0.0.1:5432/postgres` 且该 step 绿（`postgres:17.11` 镜像里 `POSTGRES_USER` 为超级用户，可 `CREATE DATABASE`）。仍未取得的是"CI 上故意共用一库必红"的对照实验（本地已用 §2 R1/R2/R3 覆盖）。
- **未取得并发改名后的耗时基线**：`:136` 的全新库契约意味着同一个库连跑两次仍会红（§2 R1），本片未把它改成"每次换库名"（那会改动臂的对外环境变量契约，超出 F6 范围）。

## 7. 返修：清理边界收敛到本臂专用库（监工 1927 轮 [P1]）

### 7.1 批复前提与实测

批复说的是「`tests/integration/auth-privacy-pg.mjs:40-66` 的 `roleDatabaseClients` 枚举整个集群所有可连非模板库，`dropRolesEverywhere` 逐库 `DROP OWNED BY gengyun_auth_privacy_test,gengyun_auth_privacy`」。核对 `reviewed_sha=79a0fe5b` 的源文件：枚举与逐库清理**确实在**（`:56` `dropRolesEverywhere` + `pg_database WHERE datistemplate = false`），调用点 `:135`（开跑前）、`:162`（诱饵）、`:413`（收尾）——与批复一致，无需修正前提。

要害在 `gengyun_auth_privacy` 是**项目真实隐私组名**（`services/api/db/roles/auth_privacy.sql` 用 `DO` 守卫 `CREATE ROLE gengyun_auth_privacy NOLOGIN` + 大量列级 `GRANT`），多臂共用。旧清理对**集群里每个可连库**执行 `DROP OWNED BY …`，等于把别人库里属于这个组的授权/属主一起摘掉。本机 55662 集群实测：旧实现会遍历

```
postgres, probe_own_db, probe_other_db, gengyun_auth_privacy_test
```

即 4 个库各跑一次 `DROP OWNED BY gengyun_auth_privacy_test,gengyun_auth_privacy`。

### 7.2 改法（不是"少清一点"，而是把清理范围做成可核验的结构约束）

| 边界 | 实现 | 位置 |
| --- | --- | --- |
| ① 只连本臂库 | 清理只走 `dropRolesScoped()`，它只 `new pg.Client({connectionString: url.href})`（`url` 已在 `:22` 断言为 `…/gengyun_auth_privacy_test`）；删掉 `roleDatabaseClients` / `dropRolesEverywhere` 两个声明 | `:71-85` |
| ② 越界前先拒绝 | `foreignDependents(names)` 只读 `pg_shdepend`（`refclassid='pg_authid'`，`dbid <> current_database()`，`dbid=0` 视为共享对象），非空即抛 `拒绝清理角色 …在库 X 还有 N 个依赖对象…`，**在连任何库之前** | `:59-69` `:75-79` |
| ③ 只删本次自建 | `createdRoles` 只登记本进程 `CREATE ROLE` 出来的角色（bootstrap 的组角色、测试 LOGIN、诱饵角色）；收尾 `dropRolesScoped([...createdRoles])` | `:38` `:161` `:163` `:173` `:456` |
| ④ 范围可断言 | `cleanupDatabases` 记录清理路径连过的库；收尾断言 `[...cleanupDatabases] === [url.pathname]`（负控制里还要求拒绝时为空集） | `:41` `:80` `:192` `:206` `:468` |
| ⑤ 别的库有负控制 | D0：诱饵库 + 在该库拥有表并被授权的诱饵角色 ⇒ 断言 ①「只清当前库」必报 2BP01；②本臂清理**拒绝**且点名诱饵库；③拒绝时未连任何库；④诱饵库行数/属主原样；⑤删掉诱饵库后同一清理才成功 | `:165-206` |

没有删任何既有断言或正面声明来换绿：删掉的是**被判为缺陷本体**的 `roleDatabaseClients` / `dropRolesEverywhere`（以及 `rolesCreated` 布尔），同时**新增** 6 条断言（拒绝、拒绝时机、别的库行数、别的库属主、诱饵库归零、清理范围单元素）。

### 7.3 改后读数（本机 PostgreSQL 17.11，集群端口 55662，data `E:\GengYunCommander\.pg17\data-r29-iso-cleanup`）

**N1 越界场景下的拒绝（用真实角色名）**：在"别人的库" `probe_other_db.public.o` 上 `GRANT SELECT … TO gengyun_auth_privacy`，`pg_shdepend` 读数 `gengyun_auth_privacy|probe_other_db|1`；再跑整臂：

```
exit=1
Error: 拒绝清理角色 gengyun_auth_privacy：gengyun_auth_privacy 在库 probe_other_db 还有 1 个依赖对象。本臂只清理
gengyun_auth_privacy_test，不对其它库执行 DROP OWNED（同集群其它库不属于本臂）。
```

**N2 拒绝后别的库完好（对照 N1）**：

```
o owner=probe_grp acl={probe_grp=arwdDxtm/probe_grp,gengyun_auth_privacy=r/probe_grp}   ← 清理前
o owner=probe_grp acl={probe_grp=arwdDxtm/probe_grp,gengyun_auth_privacy=r/probe_grp}   ← 被拒绝后逐字相同
rows in probe_other_db.public.o = 1
role gengyun_auth_privacy still present = 1
```

⇒ 旧实现在这里会把这个 GRANT 摘掉（它对该库也执行 `DROP OWNED BY …gengyun_auth_privacy`）；新实现红着退出、别的库一行未动。

**N3 撤掉越界依赖后整臂转绿**（`REVOKE` + `DROP ROLE gengyun_auth_privacy` + 重建 `gengyun_auth_privacy_test`）：

```
exit=0
PASS 1: 0001/0003/0008 executed on fresh native PG17.11 (not migration-runner atomicity evidence)
PASS 2: 清理边界负控制：本臂只清专用库——跨库依赖角色被拒绝清理且别的库对象/行/属主完好，删掉本地诱饵库后才成功，清理路径未连过第二个库
ALL 27 native PG17.11 integration groups passed; …
```

收尾外部核对：`pg_roles LIKE 'gengyun_auth_privacy%'` ⇒ `(none)`；`pg_database LIKE 'gengyun_auth_privacy%'` ⇒ 只有 `gengyun_auth_privacy_test`（臂的运行库，不含诱饵库）。

**N4 静态门禁**：`node --test tests/unit/auth-privacy-arm-isolation.test.mjs` ⇒ **11/11 pass**，新增的反向控制 ⑤（把 `datistemplate = false` 枚举写回清理路径）、⑥（去掉拒绝分支的条件）、⑦（收尾改成删全部同名角色）、⑧（删掉清理路径记账）都必须红。

**N5 同库复跑仍按原契约红**（与本片无关，保持原样）：同一个库连跑第二次 ⇒ `actual: 29, expected: 0`（`:156` 的「全新库」前置断言）。

### 7.4 未解决与风险

- **保守失败**：若别的臂/别人库里已经有 `gengyun_auth_privacy` 的真实依赖，本臂会**红**（拒绝清理）而不是替对方清掉。这是有意的：此时需要人工确认残留归属或改用独立库/角色名，不自动降级为越界清理。
- **开跑前清理仍会删「同名且零依赖」的残留角色**（`:155`）：这是为了让崩溃/并行留下的同名角色不掩住本臂（`:156` 断言它们必须为 0）。它只在角色**任何库里都没有依赖行**时才动手；一旦对方真的在用（有属主/授权行），就落进上一条的拒绝分支。CI 里每个 job 一个独立 `service`，不会有两臂共享集群；本机多臂共用同一集群时，若另一臂刚 `CREATE ROLE gengyun_auth_privacy` 且尚未授任何权限，理论上会被本臂的开跑前清理删掉——这是为换「残留不掩盖红」而接受的已知取舍，未自动重试或静默跳过。
- `pg_shdepend` 覆盖属主（`deptype='o'`）、授权（`'a'`）与共享对象（`dbid=0`）；**角色成员关系不进 `pg_shdepend`**（实测），所以本臂自己的 `GRANT gengyun_auth_privacy TO gengyun_auth_privacy_test` 不会误报。
- 「全新库」契约未变（§2 R1）；`migrations-negative-pg.mjs` 的清理属另一支（维护库 + 三个被测库），本片未动，但它已用「本臂前缀 + 基准库 `public` 对象数不变」限定范围。

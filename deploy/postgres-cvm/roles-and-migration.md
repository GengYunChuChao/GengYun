# 最小权限角色与迁移执行

> 状态：技术准备物。**未部署、未验收**。本页所有 PostgreSQL 命令都**没有被执行过**
> （本机无 PostgreSQL，见 [evidence/local-self-check.md](evidence/local-self-check.md)）。

关联：`Refs #27`（GY-I25）。基线 `upstream/main` = `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`。

## 1 依据与"不改动"声明

本页的目标是**复用**既有数据库组件，而不是另造一套权限模型：

| 依据 | 位置 | 本交付的处理 |
| --- | --- | --- |
| 10 个 NOLOGIN 组的权威定义 | `services/api/db/roles/*.sql` | **原样执行**，不复制、不重写。角色已存在则跳过 |
| 迁移运行器与幂等语义 | `services/api/src/db/migrate.ts` | **原样调用**，不修改 |
| 角色引导是"迁移后一次性管理员操作" | `docs/verification/database-run-handoff.md`（第 53 行） | 作为本页顺序的依据 |
| 运行时刻的最小权限 LOGIN 组合方式 | `tools/local-dev/database.mjs`、`tools/local-dev/profile-bootstrap.mjs` | 按同一属性集与同一成员链约束复刻到 CVM（换环境前缀） |
| 两个 CLI 只允许本机回环 | `services/api/src/db/source-lifecycle.ts:22`（`staging-intake.ts` 复用同一校验） | 作为"CVM 上不建 CLI 组"的依据 |
| PG 主版本 | `.github/workflows/*postgres*.yml` | 17.11，见 [README.md](README.md) 2.3 |

**未改动** `services/api/**`、`db/**`、`packages/contracts/**`、`miniprogram/**`、`apps/admin/**`、
根 `package.json`/lock、`.github/workflows/**`。

## 2 首次部署顺序（含与任务书建议顺序的偏差说明）

```text
① 安装 PostgreSQL 17.11 + initdb（持久盘）     install-postgres.sh
② 创建业务库 gengyun（owner=gengyun_cvm_owner）install-postgres.sh 内完成
③ 建角色组 + 建运行时 LOGIN + 最小权限断言      provision-db.sh
④ 执行迁移 migrate.ts up                        ← 实际顺序见下面的偏差说明
⑤ 启动 API（最小权限 DATABASE_URL）
⑥ 备份 + 隔离库恢复演练 + 验证清单
```

### 2.1 偏差：迁移必须排在角色引导之前

任务书建议的顺序是"**建库⇒建角色⇒迁移⇒启动 API**"。本交付执行的是
"**建库 ⇒ 迁移 ⇒ 建角色 ⇒ 启动 API**"，原因是**既有角色 SQL 本身依赖迁移建出的对象**：

| 角色文件 | 授权对象 | 由哪个迁移创建 |
| --- | --- | --- |
| `auth_privacy.sql` | `users`、`sessions`、`admin_accounts`、`admin_scopes`、`admin_sessions`、`idempotency_keys`、`consent_records`、`privacy_epochs`、`jobs`、`media`、`exports`、`author_links` | 0001、0003、0008、0009 |
| `catalog_readers.sql` | `catalog_read.home_species`、`catalog_read.registration_evidence` | 0005 |
| `consent_granter.sql` | `consent_policies`、`recipients`、`consent_records`、`privacy_epochs` | 0001、0009 |
| `profile_runtime.sql` | `crops`、`regions`、`single_profiles` | 0001 |
| `knowledge_runtime.sql` | `catalog_read.current_knowledge` | 0010 |

若先跑角色文件，会直接报 `ERROR: relation "users" does not exist` 之类错误而中止——**不修改角色
语义**的前提下，唯一可行顺序就是"迁移在前"。这也与既有结论一致：
`docs/verification/database-run-handoff.md` 写明"角色引导是迁移后一次性管理员操作"，
`docs/development-guide.md` 的部署顺序写作"确认迁移／最小角色 → API"。

`provision-db.sh` 已把这条顺序**做成硬门禁**：它先比对 `schema_migrations` 与磁盘上的
`services/api/db/migrations/*.sql`，未全部应用就直接失败并打印该执行什么，而不是留下半套权限。

### 2.2 顺序为什么不能反过来的另一半：API 必须最后启动

`api_runtime` 的权限来自角色引导；API 先启动只会得到 `42501 permission denied`。
另外迁移和角色引导都需要高权限，**绝不能**用 API 的运行身份去做。

## 3 角色清单：用途、授予范围、验证命令

### 3.1 既有 NOLOGIN 组（原样复用，本交付未创建新的一套命名）

| 角色 | 用途 | 授予范围（摘要；**权威在第 3 列的文件里**） | 文件 |
| --- | --- | --- | --- |
| `gengyun_auth_privacy` | 身份、会话、隐私撤回、幂等回执 | `users`/`sessions`/`admin_accounts`/`admin_scopes`/`admin_sessions`/`idempotency_keys`/`consent_records`/`privacy_epochs` 的**按列** SELECT/INSERT/UPDATE；`jobs`、`media` 只授 `owner_id`、`exports`/`author_links` 只授属主列的 SELECT（仅存在性检查） | `services/api/db/roles/auth_privacy.sql` |
| `gengyun_preview_reader` | 公共科普预览 | `catalog_read.home_species` 的 SELECT | `services/api/db/roles/catalog_readers.sql` |
| `gengyun_evidence_reader` | 内部登记证据 | `catalog_read.registration_evidence` 的 SELECT | 同上（与 preview_reader 在同一文件里，文件不可分割，故两个组都会建出） |
| `gengyun_consent_granter` | 用途授权与撤回写入 | `consent_policies`/`recipients` 的 SELECT + `UPDATE(updated_at)`；`consent_records`/`privacy_epochs` 的按列 INSERT | `services/api/db/roles/consent_granter.sql` |
| `gengyun_profile_runtime` | 作物/地区目录与单作物档案 | `crops`/`regions` 按列 SELECT + `UPDATE(name)`（仅为 `FOR SHARE` 加锁）；`single_profiles` 按列 SELECT/INSERT/UPDATE | `services/api/db/roles/profile_runtime.sql` |
| `gengyun_knowledge_runtime` | 0010 知识投影只读 | `catalog_read.current_knowledge` 的 SELECT（无私有原表、无发布权限） | `services/api/db/roles/knowledge_runtime.sql` |
| `gengyun_source_executor` / `gengyun_source_operator` | 来源撤回/恢复 CLI | executor 拥有受控函数与最小列权限；operator **只有**该函数的 EXECUTE，无表权限、无 executor 成员 | `services/api/db/roles/source_operator.sql` |
| `gengyun_staging_executor` / `gengyun_staging_importer` | 暂存导入/回滚 CLI | executor 拥有两个受控函数；importer **只有**这两个函数的 EXECUTE，无 raw 读、无 DML | `services/api/db/roles/staging_importer.sql` |

这些组都是 `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，
**不能直接用来连接**——这正是"应用不拿组身份、而是拿一个受限 LOGIN 继承组"的设计。

### 3.2 本交付新增的两个 LOGIN 身份（只有这两处是新标识）

| 角色 | 属性 | 用途 | 谁持有口令 |
| --- | --- | --- | --- |
| `gengyun_cvm_owner` | `LOGIN SUPERUSER`（由 `initdb -U` 创建） | **迁移管理员**：建库、跑迁移、建角色。只有人类运维使用 | 私密文件 / 私密环境；`pg_ident.conf` 让系统用户 `postgres` 走 socket 免口令执行运维 |
| `gengyun_api_runtime` | `LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，口令为 `scram-sha-256` | **应用运行时**：API 的 `DATABASE_URL` 用户 | 只经私密通道交给 API 部署 |

`gengyun_cvm_owner` 必须是超级用户，因为迁移 `0007_staging_intake.sql` 里有
`CREATE EXTENSION pgcrypto WITH SCHEMA staging_intake;`，而 `pgcrypto` 不是 trusted extension →
需要超级用户。这与 CI（`POSTGRES_USER=gengyun_ci_owner`，即超级用户）和本地开发
（`initdb -U gengyun_local_owner`）的口径一致。**因此迁移管理员口令的保管等级等同数据库最高权限。**

`gengyun_api_runtime` 的命名与属性遵循既有先例 `gengyun_local_runtime`
（`tools/local-dev/database.mjs` 第 25–29 行创建，`tools/local-dev/profile-bootstrap.mjs` 第 4 行
把它与 5 个组一起列进允许的角色集合）。口令形状也沿用同一口径：**48 位小写十六进制**
（`tools/local-dev/start.ps1` 用 24 随机字节生成，`database.mjs` 用 `/^[a-f0-9]{48}$/` 校验），
本交付的 `sql/20-login-roles.sql` 与 `provision-db.sh` 都强制同一形状。

### 3.3 `gengyun_api_runtime` 继承哪 5 个组，以及为什么

```sql
GRANT gengyun_auth_privacy      TO gengyun_api_runtime;  -- 身份/会话/隐私/幂等键
GRANT gengyun_preview_reader    TO gengyun_api_runtime;  -- 主页科普预览
GRANT gengyun_consent_granter   TO gengyun_api_runtime;  -- 用途授权与撤回
GRANT gengyun_profile_runtime   TO gengyun_api_runtime;  -- 作物/地区/单作物档案
GRANT gengyun_knowledge_runtime TO gengyun_api_runtime;  -- 知识投影只读
```

对应代码里**已接线**的读取（逐个可查）：

| 代码 | 读的对象 | 需要哪个组 |
| --- | --- | --- |
| `services/api/src/db/catalog.ts:20` | `catalog_read.home_species` | `gengyun_preview_reader` |
| `services/api/src/db/service.ts:32` | `catalog_read.current_knowledge` | `gengyun_knowledge_runtime` |
| 档案/目录读写（`single_profiles`、`crops`、`regions`） | `public.*` | `gengyun_profile_runtime` |
| 身份/会话/撤回/幂等键 | `users`、`sessions`、`consent_records`、… | `gengyun_auth_privacy` + `gengyun_consent_granter` |

### 3.4 刻意**不**授予的角色

| 角色 | 为什么不授予运行时 | 将来怎么开通 |
| --- | --- | --- |
| `gengyun_evidence_reader` | 它读 `catalog_read.registration_evidence`（内部登记证据）。代码里 `services/api/src/db/catalog.ts:30` 的 `readRegistrationEvidence` **当前没有任何路由调用**（全仓 grep 只有定义处）。给未接线的内部证据读取预授权属于过度授权 | 该路由接线后，以迁移管理员执行一行：`GRANT gengyun_evidence_reader TO gengyun_api_runtime;`，然后重跑 `sql/90-assert-least-privilege.sql` 并更新断言清单 |
| `gengyun_source_operator` | 对应 CLI 只允许 `127.0.0.1/localhost/[::1]` 且库名限 `gengyun_source_ops_test`/`gengyun_local`（`source-lifecycle.ts:22`），**在 CVM 上没有消费者**。预授权等于无消费者的攻击面 | 需要先在 `services/api/**` 放开那道回环校验（属被禁改动，**须先停下报告**），再 `provision-db.sh --with-cli-groups` |
| `gengyun_staging_importer` | 同上（`staging-intake.ts` 复用 `validateSourceDatabaseUrl`） | 同上 |

### 3.5 验证命令（每条都写了期望结果）

```sql
-- (1) 角色属性总览，等价 \du：期望 gengyun_api_runtime 只有 LOGIN+INHERIT
SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls
  FROM pg_roles
 WHERE rolname IN ('gengyun_cvm_owner','gengyun_api_runtime');

-- (2) 当前身份：以运行时连接时，期望 gengyun_api_runtime
SELECT current_user, session_user;

-- (3) 组成员的机器可读版本：期望 5 行，且都 NOT rolcanlogin
SELECT rolname FROM pg_roles
 WHERE pg_has_role('gengyun_api_runtime', oid, 'MEMBER');

-- (4) 绝不能继承迁移管理员：期望 f
SELECT pg_has_role('gengyun_api_runtime','gengyun_cvm_owner','MEMBER');

-- (5) 越权必须失败（以迁移管理员执行，用 SET ROLE 代替切换连接）
SET ROLE gengyun_api_runtime;
SELECT * FROM public.users;                       -- 期望 ERROR 42501（只授权了部分列）
INSERT INTO public.users (id) VALUES (gen_random_uuid());  -- 期望 ERROR 42501
UPDATE public.users SET state='active';            -- 期望 ERROR 42501（state 是运营方专属）
CREATE TABLE public.should_fail (x int);           -- 期望 ERROR 42501（public 无 CREATE）
RESET ROLE;

-- (6) 该能读的必须能读：期望成功返回计数
SET ROLE gengyun_api_runtime;
SELECT count(*) FROM catalog_read.home_species;    -- 期望成功
SELECT count(*) FROM catalog_read.current_knowledge; -- 期望成功
RESET ROLE;
```

以上 (1)–(6) 都已被 [verify-cvm-postgres.sh](verify-cvm-postgres.sh) 实现为自动判据
（`runtime_role_attrs`、`runtime_denied_*`、`least_privilege_assert` 等），
并额外用 [sql/90-assert-least-privilege.sql](sql/90-assert-least-privilege.sql) 做了 15 项只读断言。

## 4 迁移执行：何时、由谁、以什么角色

### 4.1 幂等语义（先读清楚再执行）

`services/api/src/db/migrate.ts` 的行为（本交付只引用，不修改）：

| 机制 | 行为 | 对运维的含义 |
| --- | --- | --- |
| 台账 | `schema_migrations(version, name, checksum, applied_at)`，启动时 `CREATE TABLE IF NOT EXISTS` | 可重复执行；第二次是空操作 |
| 版本与发现 | `services/api/db/migrations/NNNN_name.sql`，按版本升序；文件名不合规或版本号重复**在应用前**报错 | 不要手改文件名/编号 |
| checksum drift | 已应用迁移的 SQL 变了 ⇒ 抛错拒绝继续（`迁移校验和 drift，拒绝继续`） | 别改已合并的迁移文件 |
| 并发 | `pg_advisory_lock(767149023178247)` 串行化 | 两个进程同时跑也安全，但不要靠它做灰度 |
| 事务 | 每个迁移在独立事务里跑，失败即 `ROLLBACK` | 单个迁移失败不会留下半截该迁移 |
| 缺配置 | 无 `DATABASE_URL` 时**明确失败** | 不会"假装迁移成功" |
| 命令 | `list`（不连库）/ `status` / `up` | 先用 `list`+`status` 再 `up` |

已知既有问题（**本交付未修复**，也不宣称已修复）：`0002`/`0004` 自带 `BEGIN/COMMIT`，
与运行器的外层事务嵌套；`docs/verification/database-run-handoff.md` 已记载"旧迁移台账失败时
是否整体原子回滚"未证明。迁移失败时请按该页的处置约定，不要自行改迁移文件。

### 4.2 谁、何时、以什么角色

| 问题 | 答案 |
| --- | --- |
| **何时** | ① 首次部署：`install-postgres.sh` 之后、`provision-db.sh` **之前**（硬门禁）；② 每次 API 发布前，若 `upstream/main` 新增了迁移文件；③ 回滚演练前先做备份 |
| **由谁** | 人类运维／写手在**获准**后执行。**CI 不执行生产迁移**，合并不触发部署 |
| **以什么角色** | `gengyun_cvm_owner`（迁移管理员，超级用户）。**绝不使用** `gengyun_api_runtime` |
| **连接方式** | 本机回环 TCP：`DATABASE_URL='postgres://gengyun_cvm_owner:<私密口令>@127.0.0.1:5432/gengyun'`。口令只从服务端私密环境注入，**不进 argv、不进仓库、不进 PR、不打日志** |
| **为什么不能用 socket 免口令** | `migrate.ts` 直接用 `pg.Client({connectionString})`；用 socket 需要写 `?host=/var/run/postgresql` 这类查询参数，属于对该入口的另一套用法，本交付不引入，以免与既有用法不一致 |
| **执行顺序** | `list`（离线看发现列表）→ `status`（看待应用/drift）→ `up` |

```bash
# 仓库根，Node 24.16.0（与 .github/workflows/*.yml 的 node-version 一致）
node services/api/src/db/migrate.ts list
export DATABASE_URL='postgres://gengyun_cvm_owner:<私密口令>@127.0.0.1:5432/gengyun'
node services/api/src/db/migrate.ts status
node services/api/src/db/migrate.ts up
unset DATABASE_URL
```

期望 `up` 输出形如：`已应用：…` / `已存在跳过：…`；第二次执行应为 `已应用：（无）` 且
`已存在跳过：` 列出全部 10 个版本——这正是幂等的可见证据（要留原始输出）。

### 4.3 迁移后又忘了跑角色引导会怎样

API 会以 `gengyun_api_runtime` 连接成功（认证通过）但**每个查询都 42501**。
`verify-cvm-postgres.sh` 的 `least_privilege_assert` 与 `runtime_can_read_*` 会在验收前抓住这种情况。

## 5 备份/恢复与角色、口令的关系

- 备份用 `pg_dump -Fc`，**不含角色与口令**（刻意不导 `globals`：那会产出含 SCRAM 校验值的
  额外秘密文件，扩大到本交付的密钥面）。
- 因此把 dump 恢复到**全新集群**时，必须先把角色建回来：`install-postgres.sh` →
  `migrate.ts up` → `provision-db.sh`，再注入新的运行时口令。
- 恢复到**同一集群的隔离库**（[restore-drill.sh](restore-drill.sh) 的做法）时角色已存在，
  授权语句能正常重建——这是本交付唯一做成可执行并给出判定的恢复路径。
- 全库灾备到空集群的完整流程**未演练**，已在 [README.md](README.md) 第 6 节列为未验证。
- 需求 F13/AC23 的"注销后在线 7 日／备份 30 日内清理个人数据"是**逐用户删除语义**，
  `backup-postgres.sh` 的 30 天只是备份文件保留期，**两者不是同一件事**，后者属未交付项。

## 6 真跑证据与本次返修（外部真实 PostgreSQL 17.11）

> **证据来源必须写清楚**：本节的真跑由**监工**在**本机真实 PostgreSQL 17.11**（官方 Windows 便携版，
> 与 CI 的 `postgres:17.11` 同版本）上执行，**不是本单写手复现的**（本单写手无 PostgreSQL）。
> 监工回传的原始输出见 [evidence/local-self-check.md](evidence/local-self-check.md) §4。

### 6.1 监工返修前跑出的结果

| 监工执行的内容 | 结果 |
| --- | --- |
| 仓库 `services/api/db/migrations/*.sql`（10 个，按序 `psql -f`） | ✅ **10/10 成功**（含 `0007` 自建 `pgcrypto` —— 印证"不要预装扩展"的判断） |
| 仓库 `services/api/db/roles/*.sql`（7 个） | ✅ **7/7 成功** |
| `sql/20-login-roles.sql`（**返修前**版本） | ❌ `exit=3`：`ERROR: role "gengyun_api_runtime" does not exist`（旧版第 74 行） |
| `sql/90-assert-least-privilege.sql`（**返修前**版本） | ❌ 连带失败：`ERROR: role "gengyun_api_runtime" does not exist`（只跑了 3 行就中止） |

### 6.2 成因与修复（返修 1）

**成因**：旧版把"运行身份是否为迁移管理员成员"这条**前置断言**
（`pg_has_role('gengyun_api_runtime', …)`）放在了**建角色之前**；而 `pg_has_role(name, …)`
在角色不存在时会直接 `ERROR` ⇒ **全新库上必然失败**（这正是真实部署场景）。
若本机历史遗留过该角色，缺陷会被掩盖。

**修复**（只改 `deploy/postgres-cvm/**`，**未动仓库既有 `db/**`**）：

| # | 修复 | 位置 |
| --- | --- | --- |
| 1 | 该断言改为**角色不存在也安全**：`COALESCE((SELECT NOT pg_has_role(…) FROM pg_roles WHERE rolname='gengyun_api_runtime'), true)` —— 子查询 0 行 ⇒ 标量子查询 NULL ⇒ 兜底 `true`；`pg_has_role` 只在子查询真正产生行时才被求值 | `sql/20-login-roles.sql` |
| 2 | 新增 **5 个既有 NOLOGIN 组的存在性前置**（只查 `pg_roles`，天然安全），避免 GRANT 阶段报含糊的 `role does not exist` | 同上 |
| 3 | 两处前置现在都**早于任何写操作** | 同上 |
| 4 | `sql/90-assert-least-privilege.sql` 开头新增**前置自检**（`to_regclass` + `pg_roles` 计数）：缺迁移或缺角色时**立即**打印可操作的补救步骤，而不是跑到一半才报错 | `sql/90-assert-least-privilege.sql` |
| 5 | `verify-cvm-postgres.sh` 的 4 处角色判据改为存在性安全（角色缺失时 `实际=role-missing`，不再抛 `role does not exist`） | `verify-cvm-postgres.sh` |
| 6 | `restore-drill.sh` 的迁移版本比对先用 `to_regclass` 判存在（缺失时 `实际=schema_migrations-missing`） | `restore-drill.sh` |
| 7 | `provision-db.sh` 新增 `--rotate-runtime-password`，并加 **runuser 环境变量透传前置探测**（透传失败时给出不经 argv 的替代做法） | `provision-db.sh` |

### 6.3 口令语义与幂等（返修后可判定的性质）

| 场景 | 行为 | 回归判据 |
| --- | --- | --- |
| **全新库首跑** | 创建 LOGIN（写入口令）+ 收敛属性 + 授予 5 组 | 应 `exit=0`，角色出现在 `\du` |
| **重复执行**（同一口令、不带 rotate） | **不写口令**；只收敛属性 + 重复 GRANT（幂等） | 第二遍 `exit=0`，且 `pg_authid.rolpassword` **不变** |
| **显式轮换**（`--rotate-runtime-password` 或 `GENGYUN_ROTATE_RUNTIME_PASSWORD=1`） | 执行 `ALTER ROLE … PASSWORD` | `rolpassword` **必然变化**——PostgreSQL 每次都用新的随机 salt 重算 SCRAM 校验值，**属固有行为，不是缺陷** |
| 未设 `GENGYUN_API_RUNTIME_PASSWORD` | 明确失败，**绝不**创建无口令 LOGIN | `exit≠0` 且提示明确 |
| 口令非 48 位小写十六进制 | 明确失败 | 同上 |
| `20-login-roles.sql` 单独在"未建组"的库上执行 | 由存在性前置拦下，提示先跑 `provision-db.sh` | `exit≠0`（**不是**含糊的 role does not exist） |
| `90-assert-least-privilege.sql` 单独在"未迁移/未引导"的库上执行 | 由前置自检拦下，打印三步补救指引 | `exit≠0`，且输出可操作 |

### 6.4 待补的证据（返修后）

监工将在真实 PG 17.11 上按正确顺序重跑：**全新库首跑 → 重复执行（幂等）→ 15 项断言 → 备份/恢复演练**，
并回传原始输出。**在监工回传之前，返修后的这两条回归仍属"待验证"，不得记通过。**

## 7 一致性自查清单（提交/验收前逐条对照）

- [ ] `deploy/postgres-cvm/**` 之外没有改动（`git diff --name-only <base>..HEAD` 只有本目录）
- [ ] 没有复制任何 `services/api/db/roles/*.sql` 的内容到本目录（只按路径执行）
- [ ] `provision-db.sh` 的迁移门禁在角色引导之前
- [ ] 运行时 LOGIN 只继承 5 个组，且 `pg_has_role(runtime, owner, 'MEMBER') = f`
- [ ] 没有任何口令/密钥字面量出现在本目录（含注释、示例、PR 正文）
- [ ] PG 主版本口径与 CI 一致（17.11），且安装脚本在版本不符时失败而非继续
- [ ] 没有声称"已部署/已验收/可恢复"
- [ ] 已写明**账号边界**：云托管环境属**子账号 S**、`gengyun-vpc` 属**父账号 P**（**S ≠ P**），
      因此**结构性风险适用**，且目标形态已按**两条并列路径**重述（[README.md](README.md) §0.1／§0.3／§0.4）
- [ ] 已写明**授权门禁**（[README.md](README.md) §0.6）：**未取得用户明确授权前，
      不创建 CVM／不建库／不购买资源包／不改 VPC**；并含"**不要在父账号 P 里为子账号 S 的环境新建 VPC**"
- [ ] 已写明**路径 A 换 CIDR 时网段四处同改**的明确操作步骤（[README.md](README.md) §0.5）：
      脚本常量／`conf/pg_hba.gengyun.conf`／`verify-cvm-postgres.sh` 的判据／各处文档
- [ ] 未把账号 ID、凭据指纹等**标识值**写入本目录／PR／提交信息

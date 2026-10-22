# GY-R29 S7 · 审核判定台账落库：运行时授权／宿主登记／编号缺口的**落地实现与本地读数**

> 状态：**已在本分支执行完毕**（不再是「合流后照抄」的补丁清单）。
> 早前版本的标题是「合流后补丁说明（可直接照抄）」，只写 old → new 的套用步骤；监工 2026-10-22-0119
> 明确「补丁计划不计执行成功，必须给真实代码与真实读数」。本版把三件事**全部落进代码**，
> 并把本机 PG 17.11 真集群上的读数逐条记在此处。
>
> 复现环境（本机）：`PostgreSQL 17.11`（`E:\GengYunCommander\.pg17\pgsql\bin`），
> 集群 `initdb` 后 `listen_addresses='127.0.0.1'` / `port=5432`；
> 库 `gengyun`（owner `gengyun_cvm_owner`）/ 空库 `gengyun_moderation_test`；
> 运行时口令 `4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d`（48 位 hex，与 `deploy-sql-gate` 同值）。
> 与 CI 的关系：`deploy-sql-17.11` job 真跑 `20-login-roles.sql` + `90-assert-least-privilege.sql`
> （`deploy-sql-gate.yml:129`、`:153`，判绿要求「退出码 0 **且** 末行正好 `ok`」），
> `real-pg-17.11` job 真跑 `tests/integration/moderation-ledger-pg.mjs`。

---

## 1 三个失败 check 的根因（逐条来自 CI 日志，不是推测）

| check | 失败 step | 第一现场 | 根因 |
| --- | --- | --- | --- |
| `real-pg-17.11` | `ocr-jobs-pg.mjs` | `tests/integration/ocr-jobs-pg.mjs:252` `AssertionError: 迁移版本号必须在 1..28 上连续无缺号` | 本分支只带 `0028`、`0027` 还在 #428 上 ⇒ 目录里 27 个文件、`1..28` 缺 `0027`。日志里 27 条清单 `0001…0026 + 0028` 可直接对账。 |
| `auth-privacy-postgres-17.11` | `migrations-negative-pg.mjs` | 同一条不变量的另一份实现（`LAST_VERSION_NUMBER` / `MISSING_VERSIONS`），`actual ['0027']` | 同上：`count === max` 也同时不成立。 |
| `unit-tests` | `npm run test:unit` | 6 条：`ci-integration-chain-structure` 断言 4 ＋其下游、`migration-pin-guard:278`（`[last-index]` 命中 `moderation-ledger-pg.mjs:106`）、`release-materials-index:39`（索引仍写 26/25）、`sql-column-coverage:2053`（宿主 24 ≠ 23，`ledger-pg.ts` 未登记）＋ NC7 下游 | 全是「新片没有登记进既有门禁」的同一类问题，不是产品缺陷。 |

**没有一条是「等 #428 合入自动转绿」**：那条路径要求把 #428 的文件复制进本分支（撞号）或把 0028 改号
（违反「迁移号固定 0028」）。因此本片改为：把「有意缺号」变成机器可判定的事实（§2），
并把 0027 的 DDL 语义在真库臂里**按序自证**（§2.3）。

---

## 2 `0027` 缺号：机器可读的保留台账（不是文档里的一句话）

### 2.1 台账文件与产品代码

- `services/api/db/migration-reservations.json`：`reservations: [{ version: 27, filename, owner, reason, remove_when }]`。
  ⛔ 放在 `migrations/` **外面**——`tests/unit/release-materials-index.test.mjs:40-42` 与
  `tools/verify-release-materials.mjs:259-262` 只扫 `migrations/` 与 `migrations/rollback/`，放进去会被当成迁移。
- `services/api/src/db/migrate.ts` 新增（均导出）：
  `interface MigrationReservation`、`DEFAULT_RESERVATIONS_FILE`、`interface MigrationNumbering`
  （`count / maxVersion / gaps / reserved / undeclaredGaps / reservedButPresent / countMatchesMax`）、
  `loadMigrationReservations()`（形状校验：缺字段 / 非正整数 / 重复 一律 throw，⛔ 不静默当空表）、
  `inspectMigrationNumbering()`、`formatMigrationVersion()`。
- 三条不变量（缺一不可）：
  1. `undeclaredGaps` 必须为空 ⇒ **只放行登记过的缺号**，发现器静默漏项照旧红；
  2. `count + reserved.size === maxVersion`（`countMatchesMax`）⇒ 登记不能拿来掩盖漏片；
  3. `reservedButPresent` 必须为空 ⇒ 保留号一旦落盘（#428 合入）立刻判红，**强制删条目**。

### 2.2 四个真库臂改为调用同一份体检

`tests/integration/ocr-jobs-pg.mjs`、`recognitions-pg.mjs`、`speech-pg.mjs` 的 `[M0]` 段与
`tests/integration/migrations-negative-pg.mjs` 全部改成 `inspectMigrationNumbering()` + 上述三条断言
（`migrations-negative-pg.mjs` 的 `LAST_VERSION_NUMBER`/`MISSING_VERSIONS` 现在从体检结果派生，
`MIN_EXPECTED_LAST_VERSION = 25` 的下限钉保留）。⇒ CI 里两条真库臂与 auth-privacy 臂不再假红，
而且「漏项」这一真实风险没有被削弱。

### 2.3 真库臂里按序自证 `0027 → 0028`

`tests/integration/moderation-ledger-pg.mjs` 现在跑九臂，前两臂就是本条的答复：

- `[F] 保留号前向合流`（**不需要数据库**）：把真实迁移目录复制到临时目录，写入 `0027` 夹具 ⇒
  断言 `reservedButPresent = ['0027']`、`undeclaredGaps = []`、`maxVersion = 28`、
  `countMatchesMax = false`（28 + 1 ≠ 28）、`order.indexOf(0027) + 1 === order.indexOf(0028)`。
  即：**#428 合入的那一天，门禁会亲自点名要求删掉台账条目，而不是悄悄放行**。
- `[M] 迁移三连`：`0001..0026` ⇒ 断言本片两表还不存在 + 0027 的「应用前」读数 ⇒
  **应用 `tests/integration/fixtures/0027_admin_audit_observability.sql`** ⇒ 断言读数翻转 ⇒
  应用 `0028_moderation_persistence.sql` ⇒ 断 6 索引 / 4 命名索引 / 1 部分唯一索引
  (`WHERE superseded = FALSE`) / 26 + 5 列，且 **0027 的对象仍在岗** ⇒
  应用 `rollback/0028_moderation_persistence.down.sql` ⇒ 断两表与索引消失、0027 对象逐字仍在 ⇒ REPLAY。
- 夹具来源与完整性：`git show 2b1a8af8:services/api/db/migrations/0027_admin_audit_observability.sql`
  的冻结复本，`git hash-object` ＝ `git rev-parse 2b1a8af8:…` ＝ `5d86b0f06dd6b7199f69815601c45318fe3ea370`
  （10161 字节）⇒ 与 #428 的文件**逐字节相同**，不是手写近似。
- 「应用前」的判别读数（这里踩过两个坑，写下来免得后来人重踩）：
  1. `set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)` 在 **0020 就已存在**，
     0027 是**改写**而非新建 ⇒ 不能拿它当「0027 已应用」的证据；
  2. `to_regprocedure()` 返回的是**完整签名文本**（`integer, timestamp with time zone, uuid`），
     不是短名 ⇒ 断言必须按完整签名比对。
  实际判别用三条：`admin_audit_events.before_value` 列（应用前 0 / 应用后 1）、
  `list_admin_flag_audit(integer,timestamptz,uuid)`（应用前 `null` / 应用后完整签名）、
  以及 `pg_get_functiondef(set_feature_flag…) LIKE '%before_value%'`（应用前 `false` / 应用后 `true`，
  证明 0020 版不写审计列、0027 版写）。

---

## 3 运行时授权：`20-login-roles.sql` 段 M ＋ `90-assert` 清单与真执行探针

### 3.1 段 M（`deploy/postgres-cvm/sql/20-login-roles.sql` 末尾）

`-- #region gy-r29-moderation-ledger-grant`：先 `DO $$ … $$` 用 `to_regclass` 点名缺表
（`RAISE EXCEPTION '缺少审核判定台账表：%…'`），再 `REVOKE ALL ON TABLE … FROM PUBLIC`，
然后**逐列** `GRANT`：

| 表 | SELECT | INSERT | UPDATE | DELETE | 依据（`services/api/src/moderation/ledger-pg.ts`） |
| --- | --- | --- | --- | --- | --- |
| `moderation_decisions` | 6 列 | 26 列 | 14 列 | **不授** | `:74` INSERT 26 列 + `ON CONFLICT (job_id)`；`:89` UPDATE 14 列 + `WHERE job_id`；`:66` supersede 2 列 + 4 列 WHERE |
| `moderation_withdrawals` | 3 列 | 4 列 | 0 | **不授** | `:97` INSERT 4 列 + `ON CONFLICT (target_type,target_id,target_revision)` |

两个「为什么不」写进段注释：**SELECT 给 6 列而不是 1 列**——PG 对 `UPDATE … WHERE` 的列要求 SELECT 权，
而 `SUPERSEDE_SQL` 的 WHERE 读 `target_type/target_id/target_revision/content_kind/superseded`；
**UPDATE 必须授**——两条写路径（建行前置旧当前行 `superseded`、回调结算推进状态/结论）都是 UPDATE，
派单原写的「只给 SELECT/INSERT」会让 `publish` 与回调在真库 42501。
**DELETE 不授**：台账是不可变审计面，`ledger-pg.ts` 里没有任何物理删除语句。

### 3.2 `90-assert-least-privilege.sql`：同一事实的第二次写法

- `domain_manifest` 增 2 行（`('moderation_decisions','granted',true)`、`('moderation_withdrawals','granted',true)`）：
  第 47 条元断言要求「public 下每个运行时可见关系都被分类」，漏登记即红。
- `expected(tbl, sel, ins, upd, del)` 增两块，列数组与 §3.1 逐列一致（断言 49–58 是等值比对：
  清单内的列必须有、清单外的列必须一列都没有；表级除 `del=true` 的 DELETE 外一律不得有）。
- S26 探针段增 4 条**零行真执行**语句（`BEGIN; SET LOCAL ROLE gengyun_api_runtime;` + `SAVEPOINT` +
  `WHERE false` + `ROLLBACK TO SAVEPOINT`）：`r28_probe_mod_dec_ins`、`r28_probe_mod_dec_upd`、
  `r28_probe_mod_dec_supersede`、`r28_probe_mod_wd_ins`；断言段增
  `runtime_moderation_ledger_dml_exec`（四条 `:ERROR` 全为 `false`）。
  为什么非要真执行：`has_column_privilege` 逐列都真，仍可能因为「WHERE 列缺 SELECT」在
  **组合**上 42501 —— 只有真跑才抓得到。
- `function_surface_manifest` **不动**：迁移 0028 零函数（只有两表 + 索引）。

### 3.3 本机真读数（PG 17.11，`gengyun` 库）

执行链（与 `deploy-sql-gate.yml` 同序）：
`migrate.ts up`（27 个迁移全部 apply，rc=0）⇒ `services/api/db/roles/{auth_privacy,catalog_readers,consent_granter,profile_runtime,knowledge_runtime}.sql`（rc=0 ×5）⇒
`GENGYUN_API_RUNTIME_PASSWORD=4f3c…2e1d psql -f deploy/postgres-cvm/sql/20-login-roles.sql`（rc=0）⇒
`psql -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql`。

| 读数 | 实测 |
| --- | --- |
| `90-assert` 退出码 / 末行 | `0` / 正好 `ok` |
| `moderation_decisions` 的列级 SELECT / INSERT / UPDATE | 6 / 26 / 14（表共 26 列） |
| `moderation_withdrawals` 的列级 SELECT / INSERT / UPDATE | 3 / 4 / 0（表共 5 列） |
| 两表的表级 `DELETE`/`INSERT`/`UPDATE`/`TRUNCATE`/`REFERENCES`/`TRIGGER` | 全 `false` |
| 四条真执行探针（`SET LOCAL ROLE gengyun_api_runtime`，零行 + SAVEPOINT 回滚） | `dec_ins ok` / `dec_upd14 ok` / `dec_supersede ok` / `wd_ins ok`，rc=0 |
| 变异反证① `REVOKE SELECT (superseded)` | supersede 臂立刻 `ERROR: permission denied for table moderation_decisions` |
| 变异反证② `REVOKE INSERT (evidence)` | INSERT 臂同样 42501 |
| 复原后再跑四臂 | 全部 `ok`（探针不空转） |

> 日志里 `permission denied for table …` / `invalid input syntax for type uuid: "post-1"` 等
> 是 90-assert **既有探针段的故意 42501 噪声**（`\set ON_ERROR_STOP off` 段），不是失败；
> 判绿只看「退出码 0 + 末行 `ok`」（与 `provision-db.sh:373` 的 `tail -n1` 同口径）。

---

## 4 宿主登记与真库臂接线

### 4.1 `tests/unit/sql-column-coverage.test.mjs`（16/16 绿）

`services/api/src/moderation/ledger-pg.ts` 登记进「R28-S66 新纳管」那组（`storeFiles` 仍 8，
涨的是 `auditedFiles`）：

- `ADDITIONAL_SQL_HOST_FILES` 8 → 9；
- `EXPECTED_EXTENDED_READINGS`（全部改成实测值）：`auditedFiles 17`、`sqlLiterals 221`、
  `statements.INSERT 38`、`statements.UPDATE 34`、`SELECT 119`、`DELETE 30`、`returningClauses 68`、
  `onConflictClauses 23`、`referencedTables 41`、`columnRequirements 1459`、`coveredRequirements 1405`（缺 0）、
  `ledgerExemptions 33`、`rowLockRequirements 19`、`rowLockExemptions 1`、`opaqueExpressions 5`；
- `EXPECTED_EXTENDED_PER_FILE` 加 `'moderation/ledger-pg.ts': 4`（SUPERSEDE / INSERT / UPDATE / WITHDRAW 四条字面量）；
- `EXPECTED_EXTENDED_TABLES` 41 张（+`public.moderation_decisions` / `public.moderation_withdrawals`）；
- 宿主总数断言 23 → **24**（17 已审计 + 7 登记），用例标题同步；
- 该测试的「缺权明细」在本片落地后归零：`columnRequirements - coveredRequirements === 0`，
  即 §3.1 的列级授权**恰好**覆盖四条语句的全部需求（多一列都会被 `90-assert` 的反向断言抓住）。

### 4.2 真库臂接线（三处同步）

- `.github/workflows/real-pg-integration.yml`：在 `speech-pg` 之后、装包 step 之前插入
  `psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_moderation_test' && node tests/integration/moderation-ledger-pg.mjs postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_moderation_test`
  （库名硬钉、脚本只认 `argv[2]`；不排到装包 step 之后，因为它不需要 `initdb`/`pg_ctl`）。
- `tests/unit/ci-real-pg-wiring.test.mjs`：`MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` /
  `REQUIRED_STEP_ORDER` 三处同步（判据⑥顺序、⑦⑧「先建库再 node 且库名一致」、⑨双向相等）。
- `tests/unit/ci-integration-chain-structure.test.mjs`：`UNWIRED_DECLARATIONS` 显式声明
  「由真库 job 独立跑，**不进** `test:integration:http` 回环链」（回环链没有真 PG）。

---

## 5 本地验证序列（全部实跑，命令与结果）

| 命令 | 结果 |
| --- | --- |
| `node --test tests/unit/migration-pin-guard.test.mjs` | 12/12 绿（`ALLOW` **未改**：把 `moderation-ledger-pg.mjs:106` 的 `versions[versions.length - 1]` 改成 `inspectMigrationNumbering()` 的读数，触发行消失） |
| `node --test tests/unit/migration-reservations.test.mjs` | 8/8 绿（含 4 条负控制＋1 条合流预演） |
| `node --test tests/unit/sql-column-coverage.test.mjs` | 16/16 绿（含 NC5–NC9） |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | 7/7 绿 |
| `node --test tests/unit/ci-real-pg-wiring.test.mjs` | 18/18 绿 |
| `node --test tests/unit/release-materials-index.test.mjs` | 5/5 绿（索引改成迁移 27 / rollback 26 / deploy 31） |
| `node --test tests/unit/roles-file-disposition.test.mjs` | 11/11 绿 |
| 相关 23 个单测文件批量跑 | 211/211 绿 |
| `node tests/integration/moderation-ledger-pg.mjs <空库 URL>` | rc=0，九臂 `[√] ALL PASS`（`[F][M][W][S][V][U][X][C][R]`） |
| `migrate.ts up` + 5 个 roles 脚本 + `20-login-roles.sql` + `90-assert` | rc=0，末行 `ok`（见 §3.3） |

`[M]` 臂的实测输出（本地原文节选）：
`[M] 迁移清单 27 个（0001..0028），无未声明缺号；保留号 [0027]；count＋保留 === max` /
`[M] 0027（#428 DDL 夹具）已按序应用：before_value 列 / list_admin_flag_audit / 改写后的 set_feature_flag 全部在岗` /
`[M] UP（0027 → 0028）：两表 / 四条索引 / 部分唯一索引 WHERE superseded=FALSE / 26+5 列 全部出现，0027 的对象仍在岗` /
`[M] ROLLBACK：本片建的两表与索引全部消失，既有表与 0027 的对象逐字仍在` /
`[M] REPLAY：再跑一次 UP，读数与首次逐项相同`。

> 本机坑（不影响 CI）：`bash` 默认解析到 WSL，WSL 因「localhost 代理未镜像」导致所有 `bash -n` 失败 ⇒
> `release-materials-index` 前两条测试假红；把 `C:\msys64\usr\bin` 前置到 `PATH`（GNU bash 5.3.9）后全绿。
> CI 是 `ubuntu-24.04` 原生 bash，无此问题。

---

## 6 #428 合入后必须做的清理（机器会强制要求）

1. `git fetch origin main && git rebase origin/main`：#428 带来 `0027_admin_audit_observability.sql`。
2. `undeclaredGaps` 为空、`reservedButPresent = ['0027']` ⇒ 三条不变量第 3 条立刻判红
   （`migration-reservations.test.mjs` 与四个真库臂同时红）⇒ **删除
   `services/api/db/migration-reservations.json` 里的 27 号条目**（或整文件删除后不再引用）。
3. 删除后可一并移除 `tests/integration/fixtures/0027_admin_audit_observability.sql` 与
   `moderation-ledger-pg.mjs` 的 `[F]`/`[M]` 里的 0027 段（届时真目录里就是 0027）。
   在 0027 未合入前**不许**删：那会退化成「等 #428」的空口承诺。
4. `docs/verification/gy-i24-release-materials-index-20261017.md` 的迁移数届时仍是 27
   （0027 补进来 ⇒ 28？否：本片 27 = `0001..0026` + `0028`；#428 合入后 **28**）——
   该数字由测试从文件系统实测派生，改完文件跑一次 `release-materials-index` 即会指出应写几。

---

## 7 已知偏差与理由（评审请一并看）

1. **`moderation_withdrawals` 的 PK 不是 `comment_id`**：台账 `markWithdrawn` 的键是
   `targetKey = type|id|revision`（`services/api/src/moderation/decisions.ts`），且**帖子也会被下架**
   （`service.ts` 的 `withdraw` 接受任意 `TargetRef`）⇒ PK `(target_type,target_id,target_revision)`。
2. **`20-login-roles.sql` 必须给 UPDATE**（派单原写「不给 UPDATE」）：见 §3.1；仍不给 DELETE。
3. **`function_surface_manifest` 无新增**：迁移 0028 零函数。
4. **`storeFiles` 不变**：涨的是 `auditedFiles`（见 §4.1）。
5. **0027 缺号用「保留台账」而不是「等 #428」**：见 §2；三条不变量都带负控制用例，
   合流当天由机器点名删除条目。

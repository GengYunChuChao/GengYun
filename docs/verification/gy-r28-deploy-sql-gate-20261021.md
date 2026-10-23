# R28-S34 · deploy SQL 链的独立 CI 闸门（末行必须 `ok`，退出码必须 0）

> 切片：R28-S34；分支 `test/gy-r28-deploy-sql-gate`；基线 `56042f7`（`upstream/main`，含 #342 的 S28：90-assert 78 条断言、识别域四表列级授权）。
> 交付物：`.github/workflows/deploy-sql-gate.yml`（本页唯一代码改动）＋本页。
> 一句话问题：`provision-db.sh` 的部署链（迁移 → 组角色 → `20-login-roles.sql` → `90-assert-least-privilege.sql`）此前**没有任何 CI 覆盖**；而 90-assert 是 soft verdict（判 FAIL 仍 `exit 0`），所以「跑完但结论不是 `ok`」在只信退出码的调用方式下是**假绿**。本 job 把这条链搬进 CI，并对「末行 `ok`」与「`psql` 退出码 0」做**双保险**。

**取证范围声明**：本页所有读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55645`，datadir `E:\GengYunCommander\.pg17\data-r28s34`），**没有**在 GitHub Actions runner 上跑过；`provision-db.sh` 本体也没有执行（它要 root/`runuser -u postgres`/真实 CVM），而是把 workflow 里**同一串命令**在 Git Bash（`D:\Git\bin\bash.exe`，GNU bash 5.2.37）里逐条重放。未取得项逐条列在 §8。

## 0. 结论摘要

| 项 | 读数 |
|---|---|
| 本机全链（迁移 0001..0025 → 5 组 → 20-login → 90-assert） | 4 个 run step 全部 `退出码 0`，闸门 `退出码=0 末行='ok'` |
| 破坏①（撤销 `messages.id` 的列级 SELECT） | `psql` 退出码 **仍是 0**，末行变 `FAIL: …` ⇒ step `exit 1`（**只有末行这一道能抓**） |
| 破坏②（断言段注入 `SELECT 1/0`） | `psql` 退出码 **3** ⇒ 退出码分支先报 `::error::` ⇒ step `exit 1` |
| 复原（重新 GRANT ＋ 还原 SQL） | 闸门重新 `退出码=0 末行='ok'`；再从空库整链重放一次仍全绿 |
| 门禁 6 道 | 全绿（exit code 见 §7） |
| job 覆盖到的生产段 | `provision-db.sh:265-291`（5 组按原顺序）、`:352-374`（20-login 与 90-assert 的调用口径） |

## 1. 范围

### 1.1 做了什么

1. 新增 `.github/workflows/deploy-sql-gate.yml`（163 行）：job `deploy-sql-17-11`（`name: deploy-sql-17.11`），`runs-on: ubuntu-24.04`，`timeout-minutes: 15`，service `postgres:17.11` ＋ health-check，7 步：checkout → setup-node → `npm ci` → 迁移 → 组角色 → `20-login-roles.sql` → `90-assert-least-privilege.sql`（末行 ＋ 退出码双保险）。
2. 本机按 workflow 的**同一串命令**跑三段读数（全绿 / 两次人为破坏判红 / 复原）。
3. 本页 ＋ 6 道门禁。

### 1.2 没做什么（边界）

- 没有改 `deploy/postgres-cvm/provision-db.sh`、`deploy/postgres-cvm/sql/20-login-roles.sql`、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`、`services/api/db/migrate.ts`、`services/api/db/roles/*.sql`。
- 没有改任何其它 `.github/workflows/*`、没有改 `tests/**`（`tests/unit/ci-real-pg-wiring.test.mjs` 对新增 workflow 的判据全部原样通过，见 §7）。
- 没有 push、没有建 PR、没有打 tag（指挥统一收口）。
- 没有在真实 CVM 或 GHA runner 上执行（§8）。

## 2. 环境与取证方式

| 项 | 值 |
|---|---|
| 客户端/服务端 | PostgreSQL **17.11**（`E:\GengYunCommander\.pg17\pgsql\bin`，`x86_64-windows`） |
| 集群 | 一次性 `127.0.0.1:55645`，datadir `E:\GengYunCommander\.pg17\data-r28s34`，`initdb -U postgres --auth=trust -E UTF8 --no-locale`；进程用 `Invoke-CimMethod Win32_Process Create` 拉起（不用 `pg_ctl start`/`Start-Process`） |
| 引导身份 | `gengyun_cvm_owner`（`LOGIN SUPERUSER PASSWORD 'synthetic-ci-owner-only'`，镜像 service 容器的 `POSTGRES_USER`/`POSTGRES_PASSWORD`） |
| 库 | `gengyun`，`OWNER gengyun_cvm_owner`（`20-login-roles.sql:93` 硬钉 `current_database() = 'gengyun'`） |
| 迁移 | 25 个（0001…0025），`migrate.ts up`，`pg_advisory_lock` 串行 |
| 组角色 | `services/api/db/roles/` 的 5 个文件，顺序逐条抄 `provision-db.sh:265-271` |
| 运行时口令 | 合成值 `4f3c…2e1d`（48 位小写 hex，`openssl rand -hex 24` 的形状），⛔ 非真实口令 |
| shell | 步骤正文抽出来交给 `D:\Git\bin\bash.exe`（GNU bash 5.2.37 msys）执行，PATH 只含 `.pg17\pgsql\bin`，环境变量取 workflow 里的 `env:` 块 |

读数原文落盘（不进仓库）：`E:\GengYunCommander\.pg17\handoff\r28-s34-final-{A-green,B1-break,B2-break-sql,C1-restore-step,C2-restore-full}.log`。

## 3. workflow 设计

### 3.1 与生产链条的对应

| 生产（`provision-db.sh`） | 本 job |
|---|---|
| `sql/10-install-postgres.sh`（装 PG） | service `postgres:17.11` ＋ `pg_isready` health-check（20 次 × 5s 超时即红） |
| `migrate.ts up`（`:320-330` 段） | `node services/api/src/db/migrate.ts up`（`DATABASE_URL` 指向 service） |
| `ROLE_GROUP_FILES` 5 组（`:265-271`，`--plan` 也能看） | 5 个 `roles/*.sql` **按同一顺序** apply |
| `sql/20-login-roles.sql`（`:352-360`，`\getenv` 取 48 位 hex 口令） | 同名文件，`GENGYUN_API_RUNTIME_PASSWORD` 用合成值 |
| `sql/90-assert-least-privilege.sql`（`:362-374`） | 同名文件，**末行 ＋ 退出码**双保险 |

`--with-cli-groups` 才追加的 3 组（`provision-db.sh:272-275`：`egress_ledger`／`source_operator`／`staging_importer`）**不在 deploy 链里**，本 job 不 apply。

### 3.2 为什么必须自己校验末行

90-assert 是「只报不改」的 soft verdict：脚本尾部 `1806-1811` 用

```sql
SELECT CASE WHEN count(*) FILTER (WHERE ok IS NOT TRUE) = 0 THEN 'ok'
            ELSE 'FAIL: ' || string_agg(...) END AS verdict
```

打印结论——**判 FAIL 也只是一行输出，`psql` 退出码仍然是 0**。实测（§4.2）：撤掉一条列级授权后 `退出码=0 末行='FAIL: …'`。所以：

- 只信退出码 ⇒ 断言全红也判绿（假绿，正是本片要堵的洞）；
- 只信末行 ⇒ 「脚本没跑到判决」（缺文件、连接断、`ON_ERROR_STOP` 截断、SQL 报错）时末行会退化成一截提示，虽然通常也不是 `ok`，但**错误信息会指错方向**（说「结论不是 ok」而不是「断言没跑完」）。

故两道都留，且**先判退出码**再判末行，两条 `::error::` 分别说清是哪一半不满足。末行提取用 `awk 'NF { last = $0 } END { print last }'`，与生产 `provision-db.sh:365` 的 `sed '/^[[:space:]]*$/d' | tail -n1` **逐字等价**（都取最后一条非空行），CI 与生产判的是同一个量。

### 3.3 与 hard-fail 切片的关系（写了注释在文件头）

hard-fail 切片验「人为破坏后**必须判红**」（负控制）；本 job 验「合规授权下**必须判绿**」（正控制）。两者互补：少了本片，hard-fail 的红说明不了合规态是绿的；少了 hard-fail 片，本片的绿说明不了断言真的会拦人。等 hard-fail 合入后末行校验可简化（退出码不再恒 0），但**两道都要保留**——覆盖的失败模式不同。文件头 `§④⑤` 与步骤注释里都写了这条关系。

### 3.4 不含任何「放宽/吞红」写法

- 无 `continue-on-error`、无 `|| true`、无 `set +e`（退出码用 `if psql …; then rc=0; else rc=$?; fi` 捕获，`set -euo pipefail` 全程开启）、无 `if: always()`／任何 step 级条件、无 `GY_ALLOW_SKIP`／`--allow-skip`。
- 所有 `uses:` 钉 40 位 SHA：`actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`、`actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`（与仓内 `real-pg-integration.yml` 等其它 PG workflow 同版本）。
- 无 tab、LF 行尾、无 BOM。

## 4. 三段读数（原文）

### 4.1 全绿：本机从空库整链重放

前置：`reset-cluster.sql`（drop 库与 12 个 `gengyun*` 角色 → 重建库），等价于 service 容器刚起来的状态。

```
=== [3] npm ci --no-audit --no-fund
[SKIP 已声明偏差] npm ci --no-audit --no-fund（依赖已按 package-lock 安装；本机 node -v 与 CI 同版本 24.16.0）
=== [4] 迁移全链（0001..0025）
---- 退出码 0 ----
=== [5] 组角色（services/api/db/roles/*.sql，按 provision-db.sh:265-271 的 5 组顺序）
== services/api/db/roles/auth_privacy.sql
== services/api/db/roles/catalog_readers.sql
== services/api/db/roles/consent_granter.sql
== services/api/db/roles/profile_runtime.sql
== services/api/db/roles/knowledge_runtime.sql
---- 退出码 0 ----
=== [6] 20-login-roles.sql（运行时 LOGIN + 列级最小权限）
---- 退出码 0 ----
=== [7] 90-assert-least-privilege.sql（末行 ok 且退出码 0）
退出码=0 末行='ok'
90-assert：退出码 0 且末行 ok —— 双保险齐了（78 条断言判绿）。
---- 退出码 0 ----
结论：全部 4 个 run step 退出码 0（GHA 会判绿）。
```

步骤 [4] 内部读数：`发现 25 个迁移：0001_initial_schema.sql, …, 0025_recognitions_persistence.sql` ／ `已应用：0001, …, 0025` ／ `已存在跳过：（无）`。
步骤 [6] 内部读数（节选）：`20-login-roles.sql：gengyun_api_runtime 已就位并授予 5 个既有 NOLOGIN 组。` ＋ 段 I（运行时域）与段 J（识别域，S28 新增）的列级授权摘要。
步骤 [7] 的前置自检（7 个业务关系 ＋ `gengyun_api_runtime` ＋ 5 组）全部满足；探针段故意触发的 `permission denied` 只出现在 stderr，属预期读数。

### 4.2 人为破坏①：撤销一条列级 SELECT（`psql` 退出码仍是 0）

```sql
REVOKE SELECT (id) ON public.messages FROM gengyun_api_runtime;
```

```
退出码=0 末行='FAIL: runtime_domain_select_exec (十张表按授权列清单 SELECT … LIMIT 0 必须成功（列级授权下 has_table_privilege 恒为 false，不能当判据）); runtime_grants_messages (列级 SELECT/INSERT/UPDATE 必须与清单逐列一致（清单外一列都不行）…)'（FAIL 明细原样保留，此处仅省略第二条断言的括号内细节）
::error::90-assert 末行不是 ok（实际：'FAIL: …'）：断言没跑完／被改松／结论不是 ok。
---- 退出码 1 ----
结论：step [7] 失败（退出码 1）——与 GHA 一致，后续 step 不再执行。
```

**这一条是本片存在的理由**：`psql` 退出码 **0**，如果只查退出码，这一轮会被判绿。两条断言（`runtime_domain_select_exec`、`runtime_grants_messages`）都点名了被破坏的对象，定位不需要翻日志上下文。

### 4.3 人为破坏②：断言脚本内部报错（退出码分支）

临时在 `90-assert-least-privilege.sql` 尾部追加 `SELECT 1/0;`（随后 `git checkout --` 还原）：

```
退出码=3 末行='psql:deploy/postgres-cvm/sql/90-assert-least-privilege.sql:89: ERROR:  division by zero'
::error::90-assert 的 psql 退出码是 3（要求 0）：断言脚本内部报错或被 ON_ERROR_STOP 截断。
---- 退出码 1 ----
结论：step [7] 失败（退出码 1）——与 GHA 一致，后续 step 不再执行。
```

> **行号说明（2026-10-23 R34 补注，读数本身不变）**：上面这条 psql 报错的行号已改指
> `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:89` —— 那是脚本自带的 `SELECT 1/0;` 兜底语句，
> 与本次人为破坏产生的是同一条 `division by zero`。原记录里的 `1813` 是 2026-10-21 那次运行把
> `SELECT 1/0;` 追加到**文件尾部**时的行号，此后文件多次增补，该数字已不指向任何语句；
> 退出码=3、`::error::` 文案与结论三行保持逐字不变。

退出码分支**先**报出来，`::error::` 说的是「没跑到判决」，与 §4.2 的「跑完了但结论不是 ok」区分开——这就是双保险各自的定位职责。

### 4.4 复原：先修权限，再从空库整链重放

```
（重新 GRANT SELECT (id) ON public.messages TO gengyun_api_runtime）
退出码=0 末行='ok'
90-assert：退出码 0 且末行 ok —— 双保险齐了（78 条断言判绿）。
结论：全部 1 个 run step 退出码 0（GHA 会判绿）。
（reset-cluster.sql 后整链重放）
---- 退出码 0 ----  ×4
退出码=0 末行='ok'
90-assert：退出码 0 且末行 ok —— 双保险齐了（78 条断言判绿）。
结论：全部 4 个 run step 退出码 0（GHA 会判绿）。
```

复原后可重复：破坏 → 判红 → 修复 → 判绿，闸门不是一次性的。

## 5. 双保险的两条判据各自拦什么

| 失败模式 | `psql` 退出码 | 末行 | 谁先报 |
|---|---|---|---|
| 断言判 FAIL（授权被撤/被放宽） | 0 | `FAIL: …` | 末行分支（§4.2） |
| 断言脚本 SQL 报错 / `ON_ERROR_STOP` 截断 | 3 | 退化成错误行 | 退出码分支（§4.3） |
| 前置不满足（缺迁移/缺组/缺 `gengyun_api_runtime`） | 3（脚本 `SELECT 1/0`） | 三步补救指引的最后一行 | 退出码分支，但 output 里有完整指引 |
| 文件缺失 / 连接失败 | 2 | 空或 `psql: error: …` | 退出码分支 |
| 脚本被改松成直接 `\echo ok` | 0 | `ok` | ⚠ **两道都拦不住**——需要 hard-fail 片的负控制来覆盖 |

最后一行是诚实的边界：本 job 是正控制，证明「合规态是绿的」；「断言真的会拦人」由 hard-fail 切片与 §4.2 的破坏读数各自留痕。

## 6. 与既有 CI 的关系

- `tests/unit/ci-real-pg-wiring.test.mjs` 的判据②④⑤（禁 escape hatch、`uses:` 钉 SHA、禁吞红）**全仓扫**，本 job 全部满足；判据①③（受管脚本必须接线、跑受管脚本的 job 必须有 `postgres:17*`）针对既有 workflow，本片不改动它们。
- 本片新增第 13 个 workflow，`ci-real-pg-wiring.test.mjs` 的「工作流数量 ≥ 11」反空转判据仍绿；没有任何测试枚举「workflow 清单」，故不需要登记（见 §7 的 `UNIT_CI` 读数）。
- 与 `real-pg-integration.yml` 的分工：那条跑 `tests/**` 的真库集成；本片**只跑部署链 SQL**（不跑任何 JS 测试），失败时定位点单一。

## 7. 门禁（命令 → exit code）

| # | 命令 | exit | 关键读数 |
|---|---|---|---|
| 1 | `npm run lint` | 0 | `PASS tsc --noEmit services/api/…` / `apps/admin/…`；仓库卫生扫描通过 |
| 2 | `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过` |
| 3 | `npm run test:docs` | 0 | 研究记录 `5 通过 / 0 失败 / 4 legacy`；`docs/research` 结构与 27 条任务映射 PASS |
| 4 | `node tools/verify-contract-status.mjs` | 0 | 112 条操作 / 已装配 108；形状错误 0、语义错误 0 |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `tests 6 / pass 6 / fail 0` |
| 6 | `node --test --test-concurrency=1 tests/unit/ci-real-pg-wiring.test.mjs tests/unit/ci-integration-chain-structure.test.mjs` | 0 | `tests 19 / pass 19 / fail 0`（含对新增 workflow 的判据②④⑤ 与反向控制 ①b③④⑤⑥⑦） |

## 8. 未取得项与偏差声明

1. **没在 GitHub Actions runner 上跑过**：本页读数全部来自本机 PG 17.11 ＋ Git Bash。runner 上的差异（service 容器启动耗时、`ubuntu-24.04` 的 psql 17 版本、`mktemp` 路径）没有实测；`timeout-minutes: 15` 是按本机 40s 量级留的余量，非实测。
2. **`npm ci` 本机跳过**：`node_modules` 已按 `package-lock.json` 安装，且本机 `node -v` = `v24.16.0` 与 workflow 钉的版本一致；CI 上这一步会真跑（每次 `npm ci --no-audit --no-fund`）。
3. **`provision-db.sh` 本体没有执行**：它需要 root、`runuser -u postgres`、`pg_ctlcluster`/真实 CVM 路径；本片只重放它调用的同一串 SQL 命令。因此「生产脚本自己的调用方式」没有被验证，只被引用。
4. **未 push / 未建 PR**：按派单要求，分支与提交留在本地 worktree。
5. **本机 `gengyun_cvm_owner` 是 superuser**（service 容器的 `POSTGRES_USER` 也是 superuser），与生产「`CREATEROLE` 非 `SUPERUSER`」不同；`20-login-roles.sql` 的 `pg_authid` 读取路径与 90-assert 的 `pg_authid` 断言因此在本机走的是超管路径（与 `real-pg-integration.yml` 同等口径，非本片引入的新偏差）。
6. 90-assert 的断言数 78 与「合规态末行 `ok`」均为本机读数；断言内容本身不属于本片改动。

## 9. 复核指引

```bash
# 1) 起一个 17.11 集群（或直接用 postgres:17.11 容器），建库与 owner
# 2) 按 workflow 的顺序执行
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gengyun_cvm_owner \
       PGPASSWORD=synthetic-ci-owner-only PGDATABASE=gengyun
DATABASE_URL=postgres://gengyun_cvm_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun \
  node services/api/src/db/migrate.ts up
for f in auth_privacy catalog_readers consent_granter profile_runtime knowledge_runtime; do
  psql -X -q -v ON_ERROR_STOP=1 -f "services/api/db/roles/${f}.sql"
done
GENGYUN_API_RUNTIME_PASSWORD=4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d \
  psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/20-login-roles.sql
psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql | tail -n 1   # 期望：ok
```

破坏-复原：`REVOKE SELECT (id) ON public.messages FROM gengyun_api_runtime;` ⇒ 末行变 `FAIL: …`（退出码仍 0）；`GRANT SELECT (id) ON public.messages TO gengyun_api_runtime;` ⇒ 回到 `ok`。

## 勘误（R28-S57，2026-10-21）

本节只做勘误，不改动上文任何读数与结论。

- **`:62`**：原文「``--with-cli-groups`` 才追加的 **3 组**（`provision-db.sh:272-275`：`egress_ledger`／`source_operator`／`staging_importer`）」。
  - 今天的事实：`provision-db.sh:274-279` 只追加 **2 组** —— `source_operator`、`staging_importer`；`egress_ledger.sql` **不在** `ROLE_GROUP_FILES`，部署路径从不执行它（`services/api/db/roles/` 共 8 文件、11 条 `CREATE ROLE`）。
  - 影响：该句的**组数与成员写错**；「这些 CLI 组不在本 job 的 apply 列表里」的结论不变（本 job 只 apply 默认 5 个）。
  - 依据：`tests/unit/roles-file-disposition.test.mjs` 的「disposition ③」「计数一致」「引用闭合」断言。
- **`:58`／`:119` 的「5 组」**：仍成立（`20-login-roles.sql:220-224` 只授 5 个组）；`services/api/db/roles/` 的 8 文件 11 角色不改变本 job 的 5 文件 apply 面。

复核：`node --test --test-concurrency=1 tests/unit/roles-file-disposition.test.mjs`（11/11 通过）。

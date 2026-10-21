# R28-S64 证据页：deploy-sql-gate 的 7 组角色形态通道与过期注释订正

> **交付物**：`.github/workflows/deploy-sql-gate.yml`（新增第二个 job `deploy-sql-17-11-cli-groups` ＋ 文件头与步骤注释订正）＋
> `tests/unit/deploy-sql-gate-forms.test.mjs`（10 条测试 = 8 类静态断言 + 2 条负控制组）＋本页。
>
> **一句话问题**：`deploy/postgres-cvm/provision-db.sh` 有**两种组角色形态**（默认 5 组／`--with-cli-groups` 7 组），
> 但 `deploy-sql-gate.yml` 只跑了 5 组那一半；7 组形态至今没有任何 workflow 跑过，而它恰好是 R28-S51 首轮 CI
> 判红的那个形态。文件头与步骤注释还写着「另 3 个组这里一并建」，与脚本事实（追加 2 组、且 `egress_ledger.sql`
> 两种形态都不执行）互相矛盾。
>
> **本片只做两件事**：① 加一条**独立的** CI 通道，把 7 组形态也跑一遍；② 把该文件里过期的注释订正为事实。
> **本片不改** `provision-db.sh`、`90-assert-least-privilege.sql`、`20-login-roles.sql`、任何 `roles/*.sql`、
> 任何 `services/**` 代码，也不改 `docs/verification/gy-r28-deploy-sql-gate-20261021.md`（S42 那页由 S57 在文末勘误，
> 已澄清其「3 组」是历史表述）。
>
> **基线**：`aee9ecb`（=`upstream/main`）；分支 `test/gy-r28-deploy-gate-cli-groups`；
> 提交署名 `dsh-r28-writer <dsh-r28-writer@local>`（`git -c` 单次覆盖，未改 `git config`）。未 push、未建 PR。
>
> **环境**：Windows PowerShell 5.1 ＋ `node v24.16.0` ＋ 本机 PostgreSQL **17.11**（`initdb -E UTF8 --locale=C`，
> 一次性集群端口 **55661**，datadir 在仓外 `E:\GengYunCommander\.pg17\data-r28s64`）。
> 下文所有「读数」都是本机真跑得到的原始输出；GitHub runner 上的首次真跑见 §5。

## 0 结论摘要

| 项 | 结论 |
| --- | --- |
| 7 组形态能否在干净库上落地 | **能**：7 份角色文件逐条 `exit=0`，`20-login-roles.sql` `exit=0` |
| 7 组形态下权限读数是否与 5 组一致 | **一致**：`90-assert` `exit=0`、末行 `ok`、断言 `104/104/0`（总/过/败） |
| 新增 job 与既有 job 的关系 | **平行独立**：无 `needs:`、各自 `runs-on` 与各自 `services.postgres`，互不共享库 |
| 两条脚本的双保险是否两个 job 都有 | **都有**：`psql` 退出码 0 **且** 末行正好 `ok`，各两条 `::error::` |
| 过期注释 | 四处订正（文件头 ② ③ ④、步骤 ② 注释与 step 名、迁移末位口径）＋两处行号勘误（`:93`→`:94`、`265-271`→`267-273`） |
| 静态守卫 | 新增 10 条测试全绿；其中 8 类断言各配一条「改坏夹具必须判红」的负控制 |
| 既有 S42 守卫 | 未被破坏：`deploy-sql-gate-recovery.test.mjs` 8/8 仍绿（演练仍是第一个 job 的最后一步） |
| 未取得 | **未在 GitHub runner 上真跑新 job**（首次真跑由 PR 的 CI 证明）；未在本机另建 5 组对照库 |

**八道门禁（逐条 exit code，提交后复跑）**：

| # | 命令 | exit code |
| --- | --- | --- |
| 1 | `npm run lint` | 0 |
| 2 | `node tools/verify-release-materials.mjs` | 0（15/15） |
| 3 | `npm run test:docs` | 0 |
| 4 | `node tools/verify-contract-status.mjs` | 0 |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0（6/6） |
| 6 | `node --test --test-concurrency=1 tests/unit/deploy-sql-gate-forms.test.mjs` | 0（10/10） |
| 7 | `node --test --test-concurrency=1 tests/unit/deploy-sql-gate-recovery.test.mjs` | 0（8/8） |
| 8 | `git diff --check` | 0 |

## 1 立项依据（逐条复核，只读引用）

### 1.1 `provision-db.sh` 的两套 `ROLE_GROUP_FILES`

`deploy/postgres-cvm/provision-db.sh:267-279`（本片未改该文件）：

```bash
267: ROLE_GROUP_FILES=(
268:   'gengyun_auth_privacy:auth_privacy.sql'
269:   'gengyun_preview_reader:catalog_readers.sql'
270:   'gengyun_consent_granter:consent_granter.sql'
271:   'gengyun_profile_runtime:profile_runtime.sql'
272:   'gengyun_knowledge_runtime:knowledge_runtime.sql'
273: )
274: if [[ "$WITH_CLI_GROUPS" -eq 1 ]]; then
275:   ROLE_GROUP_FILES+=(
276:     'gengyun_source_operator:source_operator.sql'
277:     'gengyun_staging_importer:staging_importer.sql'
278:   )
279: fi
```

即：**默认形态 5 组**、**`--with-cli-groups` 形态 7 组**，追加的是 **2** 份而不是 3 份。

### 1.2 第 8 个角色文件两种形态都不执行

`services/api/db/roles/` 下有 8 个 `.sql`，`egress_ledger.sql` **不在**上面任何一段里 —— 它不被
`provision-db.sh` 的任何分支执行。处置登记见 `docs/verification/gy-r28-roles-file-disposition-20261021.md`
（R28-S57）：`egress_ledger` ＝ `not_provisioned`。所以任何 `deploy-sql-gate.yml` 的 job 都**不该**建那个组。

### 1.3 改前该文件的四处过期表述

| 位置（改前） | 原文要点 | 为什么过期 |
| --- | --- | --- |
| 文件头 ② | 「迁移必须跑**全链**（`0001..0025` 一个都不能漏）」 | 迁移目录当时已到 **0026**（`0026_speech_persistence.sql`）；写死数字必然再过期 |
| 文件头 ③ | 「另 3 个 `egress_ledger`／`source_operator`／`staging_importer` …这里一并建…顺带证明这 3 份也能在干净库上落地」 | 追加的是 **2** 份；`egress_ledger.sql` 两种形态都不执行；且当时**只有 5 组**在跑，这句话描述的是并不存在的行为 |
| 步骤 ① step 名 | `迁移全链（0001..0025）` | 同上 |
| 步骤 ② 注释 | 「`--with-cli-groups` 才追加的 **3 组**（`egress_ledger`／`source_operator`／`staging_importer`，见 `provision-db.sh:272-275`）不在 deploy 链里…它们各有自己的 workflow 取证」 | 数量错（2 组）、文件名多一个、行号偏 2–4 行（真值 274–279）、「各有自己的 workflow 取证」不成立（7 组形态从未被任何 workflow 跑过） |

另外两处行号也是错的：`20-login-roles.sql:93` 实际是注释行，断言在 **`:94`**
（`SELECT (current_database() = 'gengyun') AS db_ok \gset`）；`provision-db.sh:265-271` 的真值是 **267-273**。

### 1.4 这个缺口被 CI 真红过一次（不是推测）

R28-S51 首轮 CI（run `39547572436`，job `deploy-sql-17.11`）判红：

```text
FAIL: runtime_function_grantee_sets (catalog_ops.apply_source_operation（少授 gengyun_source_operator） /
staging_intake.apply_import（少授 gengyun_staging_importer） / staging_intake.rollback_import（少授 gengyun_staging_importer）)
```

这次判红说明「5 组形态 + 函数面断言」会互相打架：`source_operator.sql` / `staging_importer.sql` 不执行，
那两个组与它们对三个函数的 `EXECUTE` 授权就都不存在。S51 用 `8cb52a5` 收窄了判据（只对**真实存在**的角色
追究「少授」）止血；但**7 组形态本身至今没有 workflow 跑过**，本片补的就是这条通道。

### 1.5 为什么静态守卫此前没抓到

`tests/unit/deploy-sql-gate-recovery.test.mjs`（S42）只钉「恢复演练」那一步的位置与形态；
`tests/unit/ci-real-pg-wiring.test.mjs` 全部判据锚定 `.github/workflows/real-pg-integration.yml`。
没有任何测试读 `deploy-sql-gate.yml` 的**角色文件清单**与**注释措辞** —— 数量写错、注释与脚本背离都不会红。
本片补的 `tests/unit/deploy-sql-gate-forms.test.mjs` 就是这一层。

## 2 改了什么

### 2.1 新增第二个 job：`deploy-sql-17-11-cli-groups`

| 维度 | `deploy-sql-17-11`（既有） | `deploy-sql-17-11-cli-groups`（新增） |
| --- | --- | --- |
| 覆盖的形态 | 默认 5 组（生产默认） | `--with-cli-groups` 7 组 |
| 角色文件 | `auth_privacy` → `catalog_readers` → `consent_granter` → `profile_runtime` → `knowledge_runtime` | 同上 5 份，再追加 `source_operator` → `staging_importer` |
| 依赖关系 | 无 | 无（无 `needs:`，平行跑） |
| `runs-on` / 超时 | `ubuntu-24.04` / 15 分钟 | 同 |
| `services.postgres` | `postgres:17.11`、库 `gengyun`、owner `gengyun_cvm_owner`、`ports: ['5432:5432']` | 同（**独立实例**，不共享库） |
| 迁移 | `node services/api/src/db/migrate.ts up` | 同 |
| `20-login-roles.sql` | `psql -X -q -v ON_ERROR_STOP=1 -f …`，env 带 48 位 hex 口令 | 同 |
| `90-assert` | 退出码 0 **且** 末行正好 `ok`，两条 `::error::` | 同（逐字同一套 shell） |
| 恢复演练 | 有（本片未动；仍是该 job 最后一步） | 无（演练验的是运行时列级授权的复原，与形态开关无关；派生一份只会多一处漂移点） |

第二个 job 共 **7 个 step**（`checkout` → `setup-node` → `npm ci` → 迁移 → 组角色 → `20-login-roles.sql` →
`90-assert`），与第一个 job 的前 7 个 step **结构上逐行同形**（同一个 action SHA、同一份 `npm ci` 参数、
同一套 env 与双保险 shell），只有角色清单多两行、并且少了第 8 个「恢复演练」step。
这一点用仓外骨架比对脚本验过（见 §4.7）：把每行归一成 `缩进:键`、跳过注释与 `*.sql` 文件名行后，
两个 job 的 step 骨架 `83 = 83` 行全等（`diffs=0`）。

### 2.2 注释订正（改前 → 改后）

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 文件头 ② | `0001..0025` 一个都不能漏 | 「`0001..当前末位`…末位以 `services/api/db/migrations/` 里实际最大号为准，⛔ 不在本文件里写死数字」 |
| 文件头 ③ | 5 组 + 「另 3 个…这里一并建…这 3 份」 | 「两个 job 分别覆盖 `provision-db.sh` 的**两种组角色形态**」＋逐条列 5 组／7 组＋「`egress_ledger.sql` 两种形态都**不执行**（处置见 S57 证据页：`not_provisioned`）⇒ 任何 workflow 都不该建那个组」 |
| 文件头 ④ | 「90-assert 是『只报不改』的 soft verdict…退出码这一半对『结论是 FAIL』**完全无效**」＋「生产调用方这里是缺口…把退出码吞掉了」 | 末行「是唯一承载判决结论的量」（提取口径与 `provision-db.sh:373` 逐字等价）；退出码那一半抓的是「脚本没跑到判决」；并写明「断言判 FAIL 现在也会经尾部 `RAISE EXCEPTION` 变成非 0（hard-fail 已合入），生产调用方 `provision-db.sh:371-373` 也已是『退出码主判据 + 末行兜底』」 |
| step ① 名 | `迁移全链（0001..0025）` | `迁移全链（0001..当前末位，以 migrations 目录实际最大号为准）` |
| step ② 注释 | 「才追加的 3 组…`provision-db.sh:272-275`…它们各有自己的 workflow 取证」 | 「才追加的是 **2 份**（`source_operator.sql`／`staging_importer.sql`，见 `provision-db.sh:274-279`）：本 job 不 apply，由并行的 `deploy-sql-17-11-cli-groups` 覆盖；两个 job 合起来才是该脚本的两种形态」 |
| step ② 名 | `组角色（services/api/db/roles/*.sql，按 provision-db.sh:265-271 的 5 组顺序）` | `组角色（默认 5 组，按 provision-db.sh:267-273 的顺序）` |
| 两个 job 的 service 注释 | 「`20-login-roles.sql:93` 断言 `current_database()`」 | 「`:94`」（`:93` 是注释行） |

文件头 ④ 那段改写不是「顺手美化」：它原来断言的是「90-assert 判 FAIL 仍以 0 退出」，而
`docs/verification/gy-r28-assert-verdict-hard-fail-20261021.md`（R28-S33）已经把它改成 hard-fail，
本片实测也复现了「判红 ⇒ psql 退出码 3」。留着旧论述会在同类文案里继续误导下一个改判据的人。

### 2.3 没动的东西（边界）

- 第一个 job 的**步骤顺序、step 名（除 step ②）、shell、env** 未动；恢复演练仍是它最后一步（S42 守卫钉着）。
- `deploy/postgres-cvm/**`（含 `provision-db.sh`、两份 SQL）、`services/**`、`apps/**`、`packages/**`、
  `tests/integration/**`、`tests/unit/ci-real-pg-wiring.test.mjs` 全部未改。
- 未加任何依赖：新测试与骨架比对都是纯 `node`（仓库里没有 `yaml`／`js-yaml`，也没有 `actionlint`）。

## 3 静态守卫断言清单（`tests/unit/deploy-sql-gate-forms.test.mjs`）

纯静态解析 YAML 文本，无 YAML 依赖。做法：按 repo 相对路径读文件 → 切出 task 块 → 对块内文本做正则/逐行断言。

| # | 测试 | 钉住什么 |
| --- | --- | --- |
| 1 | 两个 job 都在，且 `name` 分别是 `deploy-sql-17.11` 与 `deploy-sql-17.11-cli-groups` | job id 与展示名（`jobs.<id>.name`）成对存在 |
| 2 | 第一个 job 的组文件清单 = `provision-db.sh` 基础 5 组，顺序逐字一致 | 清单来源**就是** `provision-db.sh` 的 `ROLE_GROUP_FILES=(` 段（不写死数量，读脚本） |
| 3 | 第二个 job 的清单 = 基础 5 组 + `--with-cli-groups` 的 2 组，共 7 份且顺序固定 | 追加段来自 `ROLE_GROUP_FILES+=(`，长度必须 7，且**不含** `egress_ledger.sql` |
| 4 | 两个 job 都跑 `20-login-roles.sql` 与 `90-assert`，且断言步做「退出码 + 末行」双保险 | 两条 `::error::`、`awk 'NF { last = $0 } END { print last }'`、`[ "${rc}" -ne 0 ]`、`[ "${verdict}" != "ok" ]`、口令 `^[0-9a-f]{48}$` |
| 5 | 两个 job 全文都没有 `continue-on-error`／`\|\| true`／`set +e`／`if: always()`／`if: success() \|\| failure()` | 放宽跳过的构造一律不许出现（**跳过注释行**，因为注释里正是在写「不许用」） |
| 6 | 注释不再自称「3 组」，`egress_ledger.sql` 出现处与「不执行」同句 | 禁 `3 组`／`三组`；`--with-cli-groups` 同行只许出现那 2 个文件名；`egress_ledger.sql` 所在行必须含「不执行／未执行／不 apply／从不／never」 |
| 7 | 迁移末位不写死数字，只指向 `services/api/db/migrations/` 的实际最大号 | 禁 `0001..0NNN`，且必须提到目录 |
| 8 | 第二个 job 与第一个 job 平行 | 无 `needs:`；`runs-on: ubuntu-24.04`、`timeout-minutes: 15`、独立 `services.postgres`（`postgres:17.11`／`gengyun`／`gengyun_cvm_owner`／`--health-cmd pg_isready`） |

**负控制（8 + 1 条）**：把同一批检查函数喂给**改坏**的 workflow 文本，必须各自抛错（`assert.throws` 带期望正则）：

1. 第二个 job 少 apply 一份（7 → 6）；
2. 把 `source_operator.sql` 换成 `egress_ledger.sql`；
3. 删掉一条 `::error::`（退出码那一半）；
4. 删掉「末行必须是 `ok`」那一半；
5. 塞进 `continue-on-error: true`；
6. 把「2 份」写回「3 组」；
7. 把 `egress_ledger.sql` 写成会执行；
8. 迁移末位写死 `0001..0025`；
9. （夹具）把 `provision-db.sh` 的 `'gengyun_source_operator:source_operator.sql'` 删掉 ⇒ 追加段变 1 份 ⇒ 检查 3 抛；
   把 `ROLE_GROUP_FILES+=(` 改名 ⇒ 清单解析器自己先抛「找不到」。

**首跑 9/10 的教训**（如实记）：负控制 7 一开始**没被判红** —— 因为改坏的那句后面紧跟着「`provision-db.sh`
从不 apply 它」，`从不` 命中了「不执行」的宽松正则。改成整句替换（「都会执行（`provision-db.sh` 会 apply 它；」）
后才红。⇒ 负控制的改写必须把同一句里的**替代表述**一并改掉，否则检查会被另一处措辞蒙混过关。

## 4 本机 7 组形态真跑读数（PG 17.11 / 端口 55661）

### 4.1 集群与迁移

```text
initdb -D …\data-r28s64 -U gengyun_cvm_owner --auth=trust -E UTF8 --locale=C   -> exit 0
postgresql.conf += port = 55661 / listen_addresses = '127.0.0.1' / unix_socket_directories = ''
pg_ctl -D … -l …\r28-s64-logs\pg.log -w -t 60 start                            -> pid 61592, ret 0
日志: PostgreSQL 17.11 … listening on IPv4 address "127.0.0.1", port 55661 / database system is ready
select version(): PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit
```

迁移用**与 CI 同一条命令**（不是另写的脚本）：`node services/api/src/db/migrate.ts up`，
`DATABASE_URL=postgres://gengyun_cvm_owner:synthetic-ci-owner-only@127.0.0.1:55661/gengyun`
⇒ `exit=0`，`发现 26 个迁移`、`已应用：0001..0026`、`0.54s`。

### 4.2 七份角色文件 + 两条脚本

```text
auth_privacy.sql       exit=0
catalog_readers.sql    exit=0
consent_granter.sql    exit=0
profile_runtime.sql    exit=0
knowledge_runtime.sql  exit=0
source_operator.sql    exit=0
staging_importer.sql   exit=0
20-login-roles.sql     exit=0
90-assert              exit=0  末行='ok'
```

`20-login-roles.sql` 末行原文：

```text
20-login-roles.sql：speech_jobs 的 UPDATE 是业务写权限（认领、终态提交），同时满足 commitTerminal 的
SELECT … FOR UPDATE；transcriptions 不授 FOR UPDATE，speech_idempotency 的 SELECT 是全部 6 列（WHERE 与 RETURNING 需要）。
```

### 4.3 断言计数

计数版 90-assert（在判决语句前插一行 `SELECT count(*) total, count(*) FILTER (WHERE ok) okc, count(*) FILTER (WHERE ok IS NOT TRUE) badc FROM r28_assert_results;`，
用 `-v ON_ERROR_STOP=0` 跑，避免被探针段预期的 42501 中止）：

```text
counts='104|104|0'      # total|ok|bad
```

### 4.4 形态读数（7 组形态实际建出了什么）

角色属性（列序 `rolcanlogin|rolinherit|rolsuper|rolcreatedb|rolcreaterole|rolreplication|rolbypassrls`）：

```text
gengyun_api_runtime      |1|1|0|0|0|0|0
gengyun_auth_privacy     |0|1|0|0|0|0|0
gengyun_consent_granter  |0|1|0|0|0|0|0
gengyun_evidence_reader  |0|1|0|0|0|0|0
gengyun_knowledge_runtime|0|1|0|0|0|0|0
gengyun_preview_reader   |0|1|0|0|0|0|0
gengyun_profile_runtime  |0|1|0|0|0|0|0
gengyun_source_executor  |0|1|0|0|0|0|0
gengyun_source_operator  |0|1|0|0|0|0|0
gengyun_staging_executor |0|1|0|0|0|0|0
gengyun_staging_importer |0|1|0|0|0|0|0
gengyun_cvm_owner        |1|1|1|1|1|1|1
```

三个受控函数的属主与 ACL（7 组形态）：

```text
catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid)
  owner=gengyun_source_executor
  acl={gengyun_source_executor=X/gengyun_source_executor, gengyun_source_operator=X/gengyun_source_executor}
staging_intake.apply_import(uuid,jsonb,uuid)
  owner=gengyun_staging_executor
  acl={gengyun_staging_executor=X/gengyun_staging_executor, gengyun_staging_importer=X/gengyun_staging_executor}
staging_intake.rollback_import(uuid,uuid,uuid,text)
  owner=gengyun_staging_executor
  acl={gengyun_staging_executor=X/gengyun_staging_executor, gengyun_staging_importer=X/gengyun_staging_executor}
```

⇒ 7 组形态与 5 组形态**不是同一份库**：CLI 两组一旦不存在，这三个函数的属主与 `EXECUTE` 授权都不存在
（S51 §9.4 记的 5 组形态是 `owner=gengyun_cvm_owner`、`acl={gengyun_cvm_owner=X/gengyun_cvm_owner}`）。

### 4.5 负控制（原文）

**负控制 A（派单指定的那条：撤 CLI 组的函数授权）**

```sql
REVOKE EXECUTE ON FUNCTION catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid)
  FROM gengyun_source_operator;
```

对**现行** `HEAD` 的 90-assert：`exit=0`、末行 `ok`、`104|104|0` ⇒ **不判红**。
对 **S51 版本**（`git show 567db52:deploy/postgres-cvm/sql/90-assert-least-privilege.sql`，2802 行）的 90-assert：

```text
exit=3
FAIL: runtime_function_grantee_sets (catalog_ops.apply_source_operation（少授 gengyun_source_operator）);
      runtime_function_no_public_execute (PUBLIC 可执行：public.consent_policy_immutable)
counts='108|106|2'
```

为什么要在两版上各跑一遍：S51 的四条函数面断言（含 `runtime_function_grantee_sets`）**没有合进 main**
（全仓 grep 该标签 0 命中），所以现行判据对「CLI 组少授一个 EXECUTE」是盲的。负控制 A 因此**不足以**证明
本片通道会判红，必须再换一条现行判据真会点名的对象。

**负控制 B（现行判据真的会红）**

```sql
REVOKE SELECT (id) ON TABLE public.favorites FROM gengyun_api_runtime;
```

```text
exit=3   末行='CONTEXT:  PL/pgSQL function inline_code_block line 12 at RAISE'
FAIL: runtime_favorites_dml_exec (SET LOCAL ROLE gengyun_api_runtime 后，favorites / favorites_idempotency 的
SELECT、INSERT … ON CONFLICT、FOR UPDATE、DELETE 零行语句必须全部成功；任一 42501 即失败);
runtime_grants_favorites (列级 SELECT/INSERT/UPDATE 必须与清单逐列一致（清单外一列都不行）；
表级只允许 del=true 的表有 DELETE，其它表级写权限一律不得有)
counts='104|102|2'
```

⇒ 判红时 psql 退出码 **3**、末行退化成 `CONTEXT:` 行 —— 这正是「退出码那一半」不可省的原因
（末行此时不是 `FAIL: …`，单看末行会以为只是「不是 ok」，看不出判据是哪两条）。

### 4.6 复原 → 复绿

```sql
GRANT EXECUTE ON FUNCTION catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid)
  TO gengyun_source_operator;
REVOKE SELECT (id) ON TABLE public.favorites FROM gengyun_api_runtime;   -- 撤销误授：改为重跑 20-login-roles.sql
```

实际操作是**重跑** `20-login-roles.sql`（生产修复同一路径），之后复跑 90-assert：

```text
7 份角色文件 exit=0 / 20-login-roles.sql exit=0 / 90-assert exit=0 末行='ok'
counts='104|104|0'
```

三段（撤销 → 判红 → 复原 → 复绿）齐全，且复绿读数与 §4.3 的基线逐字相同。

### 4.7 Windows 本机 vs Ubuntu runner 的差异边界（如实划界）

- **`initdb` 行为**：本机 `initdb -U gengyun_cvm_owner --auth=trust -E UTF8 --locale=C`；CI 是官方
  `postgres:17.11` 镜像，`POSTGRES_USER`/`POSTGRES_PASSWORD` 由 entrypoint 建库建角色、locale 由镜像决定。
  两端都满足 `20-login-roles.sql:94` 的 `current_database() = 'gengyun'` 与 owner 存在，但**建库路径不同**。
- **角色属性**：本机实测 `gengyun_cvm_owner` 是 superuser（`initdb -U` 的必然结果）、CLI 组与运行时组全部
  `rolsuper=0`／`rolcreatedb=0`／`rolcreaterole=0`。CI 里 `POSTGRES_USER=gengyun_cvm_owner` 同样是超级用户
  （镜像 entrypoint 会把它建成 superuser），这一点两端一致；**但「两边都是 superuser」是本机推断，不是 runner 实测**。
- **谁在跑**：本机以 Windows 用户直接连 `127.0.0.1:55661`；CI 用 `PGPASSWORD` + `PGHOST/PGPORT` env 连 service 容器。
  权限读数（`pg_roles`、`pg_proc.proacl`、`has_column_privilege`）与连接来源无关，因此 §4.4／§4.5 的结论可迁移。
- **未跑**：`actionlint`（仓库无此工具、本片不加依赖）；GitHub runner 上的 YAML 解析与 service healthcheck 时序。
- **骨架比对**（第 2.1 节提到的 `diffs=0`）：`tabs=none`、`job1_lines=245`、`job2_lines=100`、
  `skel1(去掉演练)=83`、`skel2=83`、`diffs=0`、`SKELETON_MATCH=yes`。脚本在仓外
  （`E:\GengYunCommander\.pg17\tmp\s64-yaml-skeleton.mjs`），不提交。

## 5 未取得（明确不声称）

1. **新 job 未在 GitHub runner 上真跑过**。本机跑的是「同一套命令 + 同一个 PG 17.11」，不是 workflow 本身；
   首次真跑由本分支 PR 的 CI 给出。本页不声称「CI 已绿」。
2. **未在本机另建 5 组对照库**：5 组形态由既有 job `deploy-sql-17-11` 长期覆盖，其函数 ACL 读数已在 S51 报告 §9.4。
3. **未验证 `runtime_function_grantee_sets` 一类函数面断言**（不在 main 上，见 §4.5）；本片不引入它们。
4. **未改、未重跑** `docs/verification/gy-r28-deploy-sql-gate-20261021.md` 的读数（S42 的历史证据按原样保留）。
5. 断言条数 104 **不写进 workflow 判据**：条数会随断言增减变化，写死必然重演本片要修的这类过期。

## 6 与 S51 首轮 CI 真红的关系

- S51 那次判红（`runtime_function_grantee_sets`，run `39547572436`）的直接原因是「5 组形态 + 函数面断言」错配：
  断言要求 `gengyun_source_operator` 对 `catalog_ops.apply_source_operation` 有 `EXECUTE`，而 5 组形态里那个组
  根本不存在。S51 的 `8cb52a5` 把「少授」收窄到只对真实存在的角色追究，止了血；但**没有解决形态覆盖**。
- 本片的立场：**形态要靠 job 覆盖，不靠把断言改松**。7 组形态有了自己的 job 之后，函数面一类断言将来若要
  回到 main，应当在 `deploy-sql-17-11-cli-groups` 这个形态下才要求 CLI 组的授权，而不是在 5 组形态下要求。
  本片不做这件事（不越 S51 的界），只把通道铺好。
- 需要说清的预期：**在现行 main 判据下，新 job 预期是绿的** —— 因为 S51 那四条函数面断言不在 main，
  新 job 判的是「CLI 组存在时既有 104 条读数不变」。它的价值是① 形态真被跑过、② 将来加形态相关断言时
  有地方落、③ 注释不再骗人。

## 7 复现（本机口径）

```powershell
# 1) 一次性集群（仓外）
& "E:\GengYunCommander\.pg17\pgsql\bin\initdb.exe" -D E:\GengYunCommander\.pg17\data-r28s64 `
    -U gengyun_cvm_owner --auth=trust -E UTF8 --locale=C
#    向 postgresql.conf 追加 port = 55661 / listen_addresses = '127.0.0.1' / unix_socket_directories = ''
#    用 Invoke-CimMethod Win32_Process Create 起 pg_ctl（-o 参数交给 PowerShell 会被拆参）
# 2) 建库 + 迁移（与 CI 同一条命令）
#    CREATE DATABASE gengyun;  DATABASE_URL=postgres://gengyun_cvm_owner:synthetic-ci-owner-only@127.0.0.1:55661/gengyun
node services/api/src/db/migrate.ts up
# 3) 7 份角色文件按序 psql -f → 20-login-roles.sql → 90-assert（退出码 + 末行）
#    取证脚本在仓外：.pg17\tmp\s64-run7.mjs（cli7|default5）、s64-assert.mjs、s64-yaml-skeleton.mjs
# 4) 收尾
pg_ctl -D E:\GengYunCommander\.pg17\data-r28s64 -m fast -w stop
```

> 本页所有命令与读数均来自 2026-10-21 的本机实跑（标签 `g1-cli7`／`g2-cli7`）；日志在仓外
> `E:\GengYunCommander\.pg17\handoff\r28-s64-logs\`。

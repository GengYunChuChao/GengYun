# R28-S57 证据页：角色文件的处置清单守卫与三处过期计数订正

> **交付物**：`tests/unit/roles-file-disposition.test.mjs`（11 条测试 = 6 类断言 + 5 条内存负控制）＋
> 两个部署文档的三处计数订正 ＋ 两个活文档注释的计数口径订正 ＋ 两页历史证据的勘误节 ＋ 本页。
>
> **一句话问题**：`services/api/db/roles/` 有 **8 个文件、11 条 `CREATE ROLE`**，但
> `deploy/postgres-cvm/provision-db.sh` 的 `ROLE_GROUP_FILES` 只会执行其中 **7 个**（默认 5 个 + `--with-cli-groups` 2 个），
> **`egress_ledger.sql` 从未被任何部署路径执行**；而文档还写着「7 个文件，10 个 NOLOGIN 角色」。
> 这类漂移此前**没有任何断言会红**——文件加了、脚本没加、文档没改，三处各错各的。
>
> **本片只做两件事**：① 把「哪个文件被谁执行」变成**显式处置清单**＋五类静态断言；
> ② 订正三处过期计数。**本片不裁定** `egress_ledger` 是否应当授权给运行时（见 §4.4）。
>
> **基线**：`76b0e866723e1e6dab70fa9a1200dfd7d3501668`（`76b0e86`）；分支 `docs/gy-r28-roles-file-disposition`；
> 提交署名 `dsh-r28-writer <dsh-r28-writer@local>`（`git -c` 单次覆盖，未改 `git config`）。
> **环境**：Windows PowerShell 5.1；`node v24.16.0`；本机**无 PostgreSQL**（不连库、不跑 `provision-db.sh`）。
> 下文的"读数"全部来自**只读**命令：`git grep`、`node` 解析脚本、`psql` **未**参与。

## 1 事实复核（复算结果与派单 §1 逐项一致）

### 1.1 8 个文件、11 条 `CREATE ROLE`

```text
$ node -e "…列出 roles/*.sql 并逐文件数 CREATE ROLE…"     # 探针见 §1.6，只读
files=8: auth_privacy.sql, catalog_readers.sql, consent_granter.sql, egress_ledger.sql,
         knowledge_runtime.sql, profile_runtime.sql, source_operator.sql, staging_importer.sql
auth_privacy.sql:      1 -> gengyun_auth_privacy
catalog_readers.sql:   2 -> gengyun_preview_reader, gengyun_evidence_reader
consent_granter.sql:   1 -> gengyun_consent_granter
egress_ledger.sql:     1 -> gengyun_egress_ledger
knowledge_runtime.sql: 1 -> gengyun_knowledge_runtime
profile_runtime.sql:   1 -> gengyun_profile_runtime
source_operator.sql:   2 -> gengyun_source_executor, gengyun_source_operator
staging_importer.sql:  2 -> gengyun_staging_executor, gengyun_staging_importer
CREATE ROLE total=11; distinct=11
```

**为什么是 11 而不是 8**：`catalog_readers.sql` 同时建 `preview_reader` + `evidence_reader`，
`source_operator.sql` 与 `staging_importer.sql` 各建 `executor` + `operator/importer` 两个角色。
所以「8 个文件」与「11 个 NOLOGIN 角色」是两个数，⛔ 不能互相外推。

计数口径：只认 `CREATE ROLE <name>`（含守卫块里的 `EXECUTE 'CREATE ROLE …'`），**先去整行 `--` 注释**——
`egress_ledger.sql:14` 与 `roles-bootstrap-idempotent` 的注释里都写着 "CREATE ROLE" 字样，
不剥注释会把 11 数成 13。本页与测试用的是同一个口径。

### 1.2 `provision-db.sh` 的真实执行集合：5 + 2

`deploy/postgres-cvm/provision-db.sh:267-279`（只读引用，本片未改）：

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

`293-315` 的循环逐条 `runuser … psql -f` 这些文件（存在即跳过）。⇒ **默认 5 个文件、7 条角色；
`--with-cli-groups` 时 7 个文件、9 条角色**——**`egress_ledger.sql` 不在任何一个分支里**。
`provision-db.sh:70` 的 `--help` 文案也只写 `gengyun_source_operator / gengyun_staging_importer` 两个，
与数组一致（不是漏写参数说明）。

### 1.3 `egress_ledger.sql` 的引用面：部署路径 0 处

```text
$ git grep -n "egress_ledger" -- deploy
deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1295: -- 其他角色（例如 gengyun_egress_ledger 在这些表上的列级 SELECT）不属于 runtime 的…
   （另两处命中是本次改的 README:440 / roles-and-migration:14 的说明文字）
```

```text
$ git grep -n "db/roles" -- .github
.github/workflows/deploy-sql-gate.yml:96: - name: 组角色（…，按 provision-db.sh:265-271 的 5 组顺序）
.github/workflows/deploy-sql-gate.yml:106:  psql … -f "services/api/db/roles/${f}"
```

⇒ 部署面（`deploy/**` 脚本 + `.github/workflows/deploy-sql-gate.yml` 的 5 组）**都不执行**它。
它并非"死文件"：`tests/integration/egress-ledger-pg.mjs:245` 与 `egress-object-key-pg.mjs` 会在
真 PG 夹具里施加它（那是**集成测试**夹具，不是部署）；
`tools/local-dev/database.mjs:21` 只施加 3 个组（`auth_privacy`/`catalog_readers`/`consent_granter`），
也不含它。**结论的准确写法**：`egress_ledger.sql` 在仓库里有消费者（集成测试），
但**没有任何部署路径**创建 `gengyun_egress_ledger` 这个组。

### 1.4 `20-login-roles.sql` 只授 5 个组

```text
$ git grep -nE "^GRANT gengyun_[a-z_]+ +TO gengyun_api_runtime;" -- deploy/postgres-cvm/sql/20-login-roles.sql
220:GRANT gengyun_auth_privacy    TO gengyun_api_runtime;
221:GRANT gengyun_preview_reader  TO gengyun_api_runtime;
222:GRANT gengyun_consent_granter TO gengyun_api_runtime;
223:GRANT gengyun_profile_runtime TO gengyun_api_runtime;
224:GRANT gengyun_knowledge_runtime TO gengyun_api_runtime;
```

5 个组名都在 1.1 的 11 个角色里（引用闭合）。`evidence_reader` 只被"确认存在"、不授予运行时；
`egress_ledger` 与两个 CLI 组（`source_operator`/`staging_importer`）都不授予。

### 1.5 三处过期计数（改前原文）

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `deploy/postgres-cvm/README.md:440` | ``…（7 个文件，10 个 NOLOGIN 角色）｜ **原样执行**（存在即跳过）…`` | ``…（8 个文件，11 个 NOLOGIN 角色）｜ `provision-db.sh` 按 `ROLE_GROUP_FILES` 执行其中 5 个（`WITH_CLI_GROUPS=1` 时 7 个）…；`egress_ledger.sql` 当前**未被任何部署脚本执行**…`` |
| `deploy/postgres-cvm/roles-and-migration.md:14` | ``｜ 10 个 NOLOGIN 组的权威定义 ｜ … ｜ **原样执行**，不复制、不重写。…`` | ``｜ 11 个 NOLOGIN 组的权威定义 ｜ … ｜ **原样复用**（…执行其中 5 个、`WITH_CLI_GROUPS=1` 时 7 个；`egress_ledger.sql` 未被任何部署脚本执行），不复制、不重写。…`` |
| `deploy/postgres-cvm/roles-and-migration.md:103` | ``｜ `services/api/db/roles/*.sql`：建 7 个 NOLOGIN 组 ｜ **`CREATEROLE`** ｜ …`` | ``｜ `services/api/db/roles/*.sql`：建 8 个角色文件、11 个 NOLOGIN 角色（其中 5 个默认执行，`WITH_CLI_GROUPS=1` 时 7 个） ｜ **`CREATEROLE`** ｜ …`` |

三处的 `git diff` 全文见 §5.2。**没有**在文档里写「应当补授权」这类结论性建议——
只写事实与「待裁定」（见 §4.4）。

### 1.6 复算探针（一次性；放在仓库外，未提交）

`E:\GengYunCommander\.pg17\tmp-s57-probe.mjs`：只读 `roles/*.sql`、`provision-db.sh`、
`20-login-roles.sql` 与两个文档，打印 §1.1／§1.2／§1.4／§1.5 的读数。它与测试里的解析器
是**同一套正则**（`CREATE\s+ROLE`、`'组:文件'`、`^GRANT gengyun_… TO …;`、`N 个文件`／
`N 个 NOLOGIN 组|角色`），所以探针读数与门禁读数不会互相打脸。

## 2 处置清单（`DISPOSITION`，测试内显式表）

| 类 | 文件 | 组（角色） | 谁执行 | 本片依据 |
| --- | --- | --- | --- | --- |
| `base` | `auth_privacy.sql` | `gengyun_auth_privacy` | `provision-db.sh` 默认 | 脚本 `:268` |
| `base` | `catalog_readers.sql` | `gengyun_preview_reader`（另建 `evidence_reader`） | `provision-db.sh` 默认 | 脚本 `:269` |
| `base` | `consent_granter.sql` | `gengyun_consent_granter` | `provision-db.sh` 默认 | 脚本 `:270` |
| `base` | `profile_runtime.sql` | `gengyun_profile_runtime` | `provision-db.sh` 默认 | 脚本 `:271` |
| `base` | `knowledge_runtime.sql` | `gengyun_knowledge_runtime` | `provision-db.sh` 默认 | 脚本 `:272` |
| `cli` | `source_operator.sql` | `gengyun_source_operator`（另建 `source_executor`） | `--with-cli-groups` | 脚本 `:274-278` |
| `cli` | `staging_importer.sql` | `gengyun_staging_importer`（另建 `staging_executor`） | `--with-cli-groups` | 脚本 `:274-278` |
| `not_provisioned` | `egress_ledger.sql` | `gengyun_egress_ledger` | **无**（部署路径 0 处） | §1.3；理由串见下 |

`not_provisioned` 的理由串（测试断言它逐字包含三句关键话，防止有人用一句「暂不部署」糊过去）：

```text
`provision-db.sh` 的 `ROLE_GROUP_FILES` 只列 5 个基础文件（`WITH_CLI_GROUPS=1` 时 7 个），
不执行本文件；外发账本因此在 CVM 上处于未就绪；是否需要授权属产品/安全待裁定
（本片只登记事实，不裁定）。
```

**为什么用「三类」而不是「白名单/黑名单」**：白名单之外的文件默认"不管"，那么下次有人
再往 `roles/` 扔一个文件，脚本不跑、文档不提、测试不红——仍是本片要修的那种漂移。
三类的语义是**穷尽且互斥**：执行（默认）／执行（可选）／不执行（必须写理由）。

## 3 守卫测试：六类断言 + 五条负控制

`tests/unit/roles-file-disposition.test.mjs`（只读文件系统，对工作区零写入；不连库、不执行 SQL）。

### 3.1 解析器（纯函数，与断言分离）

| 函数 | 入参 | 产出 |
| --- | --- | --- |
| `loadRoleSources(dir)` | 目录 | `[{file, text}]`（只 `.sql`，按名排序） |
| `stripCommentLines(text)` | 文本 | 去整行 `--` 注释后的文本（防把注释里的 "CREATE ROLE" 数进去） |
| `parseCreateRoles(sources)` | 文件清单 | `[{file, role}]`（兼容裸 `CREATE ROLE` 与守卫里的 `EXECUTE 'CREATE ROLE …'`） |
| `parseRoleGroupFiles(scriptText)` | 脚本文本 | `{base, cli, cliGuard}`：按 `ROLE_GROUP_FILES=(` / `+=(` / `)` 逐行扫描，不全文正则（防注释里的例子被当真条目） |
| `parseGroupGrants(loginSqlText)` | SQL 文本 | `[{line, role, grantee}]`（只认整行 `GRANT <组> TO <角色>;`） |
| `parseDocCountClaims(docText)` | 文档文本 | `{fileClaims, roleClaims}`（带行号与原文；只收含 `db/roles` 或「角色文件」的行） |

### 3.2 六类断言（含派单 §2.1 的 ①②③、§2.2 的 ④，以及第二提交追加的第 6 类：活文档口径）

| # | 断言 | 判据 | 红点 |
| --- | --- | --- | --- |
| 1① | 覆盖穷尽且互斥 | 每个 `.sql` 在 `DISPOSITION` 里**恰好出现一次** | `…/X.sql 没有落在 DISPOSITION 的任何一类（漏登记…）`／`…登记了 2 次…必须恰好一类` |
| 1② | 反向存在 | `DISPOSITION` 里的每个文件名在磁盘上**存在** | `DISPOSITION.<cls> 的 X.sql 在 services/api/db/roles/ 下不存在（幽灵条目）` |
| 1③ | 与脚本逐条相等 | `parseRoleGroupFiles()` 的 `组:文件` 集合 == `DISPOSITION.base ∪ cli`；且 `+=` 仍在 `WITH_CLI_GROUPS` 条件里 | `ROLE_GROUP_FILES 多出 G:F（DISPOSITION.base ∪ cli 未登记…）`／`DISPOSITION 声明 G:F，但脚本里没有`／`不在 WITH_CLI_GROUPS 条件里` |
| 2 | 两个具名常量 | 文件数 == 8、`CREATE ROLE` 条数 == 11、角色名不重复 | `文件数 N ≠ 8…`／`条数 M ≠ 11`／`角色名重复：…` |
| 3 | 引用闭合 | `GRANT gengyun_<x> TO gengyun_api_runtime;` 的组 ⊆ 11 个 `CREATE ROLE` 角色 | `20-login-roles.sql:N 授权引用 X，但 … 里没有它（悬空引用）` |
| 4 | 文档计数 | 两个文档里「N 个文件」== 8、「N 个 NOLOGIN 组/角色」== 11；**解析不到计数句同样判红** | `deploy/postgres-cvm/README.md:440 写「7 个文件」，实测 8 个：…`／`解析不到…（删掉句子不能当通过）` |
| 5 | 活文档口径（第二提交） | `provision-db.sh` 与 `20-login-roles.sql` 的注释里不得再出现「7 个角色」／「7 个 NOLOGIN」；正则带数字边界 `(?<![0-9])7\s*个\s*(?:角色\|NOLOGIN)`，不误伤「17 个角色」 | `… 仍出现「7 个角色/NOLOGIN」口径：7 个 NOLOGIN` |

**断言 1③ 为什么比"组名集合相等"更强**：比对的是 `组:文件` **配对**。只比组名的话，
「`gengyun_preview_reader` 配错成 `profile_runtime.sql`」这种错法照样绿——脚本会把错的文件当该组执行。
配对相等 ⇒ 组名集合必然相等（更强的判据，不是更弱的）。

**断言 3 为什么只判 ⊆ 不判 ==**：运行时到底该继承几组是**授权决策**（本片不裁定）。
本片只钉「授予的组必须在 `roles/` 里真有定义」——这条解决的是"引用悬空"，
不是"授权够不够"。

**断言 4 为什么限定在角色文件相关的行**：README 里还有别的「N 个文件」读数（例如工具清单），
全文抓会把无关数字误判成角色计数。限定 `db/roles` / 「角色文件」后，一旦有人删掉计数句，
"解析不到"分支会红——删句子绕不过去。

**断言 5（第二提交追加）为什么用数字边界**：`(?<![0-9])` 保证「17 个角色」不会被误当成「7 个角色」；
守卫同时覆盖「7 个角色」与「7 个 NOLOGIN」两种旧写法（`20-login-roles.sql` 的旧句是「建 7 个 NOLOGIN 组」，
只查「7 个角色」会漏）。测试内先用两个假串自检「能抓旧写法、不误伤 17 个」，再扫两个真实文件。

### 3.3 五条负控制（内存夹具，⛔ 不改仓库文件）

每条负控制都是「在内存里变异 → 期望对应断言判红 → 断言红点**点名**到具体文件/组/行」。
下表"判红原文"是测试里 `assert.ok(problems.some(…))` 实际匹配的**源码串**（运行时插值后即上表红点）。

| # | 变异（不改磁盘） | 期望 | 判红原文要点 |
| --- | --- | --- | --- |
| ① | 从 `DISPOSITION.not_provisioned` 删掉 `egress_ledger.sql` | 1① 红 | 命中 `egress_ledger.sql` ＋ `漏登记` |
| ② | `not_provisioned` 追加 `ghost_role_not_on_disk.sql` | 1② 红 | 命中 `ghost_role_not_on_disk.sql` ＋ `幽灵条目` |
| ③ | 在脚本副本的 `+=` 数组末尾插一条 `'gengyun_ghost_writer:ghost_writer.sql'` | 1③ 红 | 命中 `gengyun_ghost_writer` |
| ④ | 把 `20-login-roles.sql` 副本的 `GRANT gengyun_preview_reader …` 改成 `gengyun_nonexistent` | 3 红 | 命中 `gengyun_nonexistent` ＋ `悬空引用` |
| ⑤ | 把 README 副本的 `8 个文件` 改成 `7 个文件` | 4 红 | 命中 `README.md` ＋ `7 个文件` |

③④⑤ 是"改文本再解析"，①② 是"改数据结构"——两类变异路径都覆盖到了。
③④⑤ 在变异后先断言 `mutatedText !== 原文`（前置校验），所以**一旦脚本/文档形态变了、
变异没生效**，负控制会以"前置失败"红，而不是静默变绿。

### 3.4 真实红/绿读数（不是夹具）

**改前三处计数时**，断言 4 对**真实仓库**判红（同一次 `node --test` 的原始输出，节选）：

```text
✖ 文档计数一致: README 与 roles-and-migration 的「N 个文件」「N 个 NOLOGIN 组/角色」等于实测
  deploy/postgres-cvm/README.md:440 写「7 个文件」，实测 8 个：| `services/api/db/roles/*.sql`（7 个文件，10 个 NOLOGIN 角色） …
  deploy/postgres-cvm/README.md:440 写「10 个 NOLOGIN 组/角色」，实测 11 个：…
  deploy/postgres-cvm/roles-and-migration.md: 解析不到「N 个文件」的角色文件计数句（删掉句子不能当通过）
  deploy/postgres-cvm/roles-and-migration.md:14 写「10 个 NOLOGIN 组/角色」，实测 11 个：…
  deploy/postgres-cvm/roles-and-migration.md:103 写「7 个 NOLOGIN 组/角色」，实测 11 个：…
  ℹ pass 8 / fail 2        （另一条红是负控制 ⑤ 的前置：README 里已无「8 个文件」可改）
```

**改后**：`tests 10 / pass 10 / fail 0`（**第一提交时**的门禁 ① 读数；第二提交后为 `11/11`，见 §5.1）。
这组读数说明断言 4 不只是"夹具里能红"：它在**改前的真实仓库**上就是红的，
在**改后**的真实仓库上是绿的。

**第二提交（新增第 6 类断言）后**：`tests 11 / pass 11 / fail 0`；与 `roles-bootstrap-idempotent`
同跑 `15/15`。第 6 类断言在原两个文件上的取值：改前命中 `provision-db.sh:285` 的「7 个角色 SQL」
与 `20-login-roles.sql:35` 的「7 个 NOLOGIN 组」，改后两个文件都是 **0 命中**。

### 3.5 三条"防恒真"设计（为什么它不会永远绿）

1. **穷尽性靠目录列表**：`loadRoleSources()` 读的是**磁盘上的 `*.sql`**，不是清单。
   新增文件而清单没改 ⇒ 1① 红；清单加了文件而磁盘没有 ⇒ 1② 红。
2. **计数靠具名常量**：`EXPECTED_FILE_COUNT = 8` / `EXPECTED_ROLE_COUNT = 11` 写在测试里。
   多建一条角色而不改常量 ⇒ 断言 2 红；改常量而不改文档 ⇒ 断言 4 红。
3. **解析失败即红**：断言 3 的 `grants.length === 0`、断言 4 的 `fileClaims/roleClaims.length === 0`
   都有"解析不到 ⇒ 红"分支。删句子、改形态都不能换来绿。

## 4 外发账本现状（只登记事实，不裁定）

### 4.1 运行时的探测

`services/api/src/privacy/ledger-pg.ts:219-240`（只读，本片未改）：

```ts
219:  let provisioned: boolean | null = null;
220:  async function assertProvisioned(): Promise<void> {
221:    if (provisioned === true) return;
222:    if (provisioned === false) {
223:      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发账本未就绪（缺 0011 迁移或 egress_ledger 角色）');
224:    }
225:    try {
226:      const row = (
227:        await pool.query(
228:          `SELECT to_regclass('public.export_writebacks') AS wb,
229:                  has_column_privilege(current_user, 'public.exports', 'revision', 'UPDATE') AS upd,
230:                  has_column_privilege(current_user, 'public.exports', 'cancelled_at', 'UPDATE') AS upd_cancel`,
231:        )
232:      ).rows[0] as Row | undefined;
233:      provisioned = row?.['wb'] !== null && row?.['wb'] !== undefined && row['upd'] === true && row['upd_cancel'] === true;
234:    } catch {
235:      provisioned = false;
236:    }
237:    if (!provisioned) {
238:      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发账本未就绪（缺 0011 迁移或 egress_ledger 角色）');
239:    }
240:  }
```

探测有**三条**判据，缺一即"未就绪"：

| # | 判据 | 谁提供 |
| --- | --- | --- |
| a | `to_regclass('public.export_writebacks')` 非空 | 迁移 `0011_export_ledger.sql:50` |
| b | `has_column_privilege(current_user,'public.exports','revision','UPDATE')` | 角色文件 `egress_ledger.sql:43-45`（列级 `UPDATE (… revision …)`） |
| c | `has_column_privilege(current_user,'public.exports','cancelled_at','UPDATE')` | 同上（`cancelled_at` 在同一 GRANT 的列清单里） |

判据 a 由**迁移**满足；**b/c 只能由 `gengyun_egress_ledger` 组满足**——
`services/api/db/roles/egress_ledger.sql:43-45` 是 `exports` 列级 `UPDATE` 的**唯一**授予点，
`20-login-roles.sql` 里**没有任何** `exports` 提及（`git grep -n exports -- deploy/postgres-cvm/sql/20-login-roles.sql`
⇒ 0 命中）。

### 4.2 两条 `OBJECT_UNAVAILABLE`

- `ledger-pg.ts:223`：**缓存命中**的失败（上一次探测已判未就绪）——短路复用，不重查库。
- `ledger-pg.ts:238`：**首次探测**失败——`provisioned` 被算成 false，随即抛出。
- 两处文案完全相同：`外发账本未就绪（缺 0011 迁移或 egress_ledger 角色）`，错误码 `OBJECT_UNAVAILABLE`
  （fail-closed，映射为 **409**；不是 503「服务不可用」）。设计意图写在 `:212-218` 的注释里：
  把「如实拒绝的部分撤回」与「授权服务不可用」区分开，**绝不伪造取消成功**。

### 4.3 部署形态下的推演（为什么恒「未就绪」）

按 `provision-db.sh` 的真实执行集合推演（每一步都可从 §1 的读数推出）：

1. `provision-db.sh` 默认创建 5 组，**不创建** `gengyun_egress_ledger`（§1.2）；
2. `20-login-roles.sql` 只把 5 组授给 `gengyun_api_runtime`（§1.4）⇒ 运行时**不是** `gengyun_egress_ledger` 成员；
3. 即便 `0011` 已应用、`export_writebacks` 存在（判据 a 过），运行时仍**没有** `exports.revision` / `exports.cancelled_at` 的 `UPDATE`（判据 b/c 不过）；
4. ⇒ `provisioned = false` ⇒ 每次走到账本写路径都抛 `OBJECT_UNAVAILABLE`（409），**部署形态下账本路径恒「未就绪」**。

这是**结构性**的，不是环境没配好：只要部署链不带 `egress_ledger.sql`，b/c 永远不可能满足。
（`40-login`/`90-assert` 也不会补：`90-assert-least-privilege.sql:1295` 的注释明确把
`gengyun_egress_ledger` 列级 SELECT 当作"**不属于 runtime**"的既有事实。）

### 4.4 **本片不裁定**

**本片不裁定**是否需要改变这个现状。登记的事实只有三件：

1. `egress_ledger.sql` 在仓库里有消费者（集成测试），但**部署路径不执行它**；
2. 运行时因此**不具备**账本所需的 `exports` 列级 `UPDATE`；
3. 账本路径在部署形态下**恒**返回 `OBJECT_UNAVAILABLE`（fail-closed，409）。

**要不要**把 `egress_ledger.sql` 接进 `provision-db.sh`、要不要把该组授给运行时、
要不要改 `0011`／角色文件的口径——属**产品/安全裁定**，不是本片能定的。
本片只保证：**现状被写进清单与断言**，任何一侧改动都会让 `tests/unit/roles-file-disposition.test.mjs` 红，
从而强制一次显式决策，而不是继续无声漂移。

## 5 门禁（七条，逐条退出码）

命令均在 `E:\GengYunCommander\wt-r28-s57`、PowerShell 5.1 下执行；`$LASTEXITCODE` 为原样退出码。

### 5.1 读数

| # | 命令 | 退出码 | 读数 |
| --- | --- | --- | --- |
| ① | `node --test --test-concurrency=1 tests/unit/roles-file-disposition.test.mjs` | 0 | `tests 11 / pass 11 / fail 0`（6 类断言 + 5 条负控制；第二提交后复跑） |
| ② | ① 与 `tests/unit/roles-bootstrap-idempotent.test.mjs` 同跑 | 0 | `tests 15 / pass 15 / fail 0`（见 §5.3） |
| ③ | `npm run lint` | 0 | `tsc --noEmit` ×2 + 卫生扫描通过 |
| ④ | `npm run test:docs` | 0 | `validate_development_docs.py` + `verify-research-records.mjs` 通过 |
| ⑤ | `node tools/verify-release-materials.mjs` | 0 | 见 §5.3 |
| ⑥ | `git diff --check` | 0 | **无输出** |
| ⑦ | `git status --porcelain` | 0 | **空**（提交后复核） |

### 5.2 三处文档订正的 `git diff` 全文

```diff
@@ -437,7 +437,7 @@
-| `services/api/db/roles/*.sql`（7 个文件，10 个 NOLOGIN 角色） | **原样执行**（存在即跳过），授权口径完全沿用；不复制、不重写、不删除 | **未改动** |
+| `services/api/db/roles/*.sql`（8 个文件，11 个 NOLOGIN 角色） | `provision-db.sh` 按 `ROLE_GROUP_FILES` 执行其中 5 个（`WITH_CLI_GROUPS=1` 时 7 个），存在即跳过；`egress_ledger.sql` 当前**未被任何部署脚本执行**（原样复用、不复制、不重写、不删除仍成立；是否需要授权属产品/安全待裁定） | **未改动** |
@@ -11,7 +11,7 @@
-| 10 个 NOLOGIN 组的权威定义 | `services/api/db/roles/*.sql` | **原样执行**，不复制、不重写。角色已存在则跳过 |
+| 11 个 NOLOGIN 组的权威定义 | `services/api/db/roles/*.sql` | **原样复用**（`provision-db.sh` 按 `ROLE_GROUP_FILES` 执行其中 5 个、`WITH_CLI_GROUPS=1` 时 7 个；`egress_ledger.sql` 未被任何部署脚本执行），不复制、不重写。角色已存在则跳过 |
@@ -100,7 +100,7 @@
-| `services/api/db/roles/*.sql`：建 7 个 NOLOGIN 组 | **`CREATEROLE`** | 否（非超级用户亦可；PG 16+ 起创建者自动获得新角色的 `ADMIN OPTION`） |
+| `services/api/db/roles/*.sql`：建 8 个角色文件、11 个 NOLOGIN 角色（其中 5 个默认执行，`WITH_CLI_GROUPS=1` 时 7 个） | **`CREATEROLE`** | 否（非超级用户亦可；PG 16+ 起创建者自动获得新角色的 `ADMIN OPTION`） |
```

### 5.3 逐条原始输出（节选，原样贴出）

**② 两文件同跑**（证明新测试没有把既有的建组幂等守卫挤掉）：

```text
$ node --test --test-concurrency=1 tests/unit/roles-file-disposition.test.mjs tests/unit/roles-bootstrap-idempotent.test.mjs
✔ … disposition ①② / ③ / 计数一致 / 引用闭合 / 文档计数一致 / 活文档口径
✔ … 负控制 ① ② ③ ④ ⑤
✔ …（roles-bootstrap-idempotent 的 4 条）
ℹ tests 15 / pass 15 / fail 0
```

**③ lint**：

```text
$ npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

**④ test:docs**：

```text
$ npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
```

**⑤ 交付材料索引**（15/15，本片未新增 `deploy/**` 文件，故是不变量）：

```text
$ node tools/verify-release-materials.mjs
PASS 索引文档存在 — docs/verification/gy-i24-release-materials-index-20261017.md
PASS 索引覆盖 deploy/ 全部在册文件 — 31 个文件全部在索引表行中；覆盖计数 31/31
PASS 索引列出的 deploy 路径全部存在 — 35 条路径全部存在
PASS 索引相对链接全部可解析 — 40 个链接全部可解析
PASS 被索引文件全部非空 — 无非空文件
PASS CVM 脚本 bash -n 语法通过（blob 喂 stdin，不传路径） — 5 个脚本全部通过
PASS CVM 脚本均设 set -euo pipefail — 5 个脚本全部设置
PASS CVM 脚本提交内容为 LF（blob 判据） — 5 个脚本 blob 均无 CR
PASS 环境变量模板覆盖配置面 — 模板 17 键 ⊇ 配置面 17 键
PASS 环境变量模板无多余键 — 无多余键
PASS 模板中机密类键均为空值 — 机密类键全部为空值
PASS Dockerfile Node 版本与 engines 一致 — 镜像 node:24.16.0 ↔ engines >=24.16.0 <25
PASS /health 路由存在（云托管最小验收依据） — routes/health.ts 注册 /health 且响应含 checks/meta.execution_mode
PASS 回滚 down 脚本覆盖 0002..N 且无 0001 — 迁移 26 个（0001..0026），down 25 个（0002..0026），无 0001
PASS migrate.ts 命令闭集为 up|status|list — migrate.ts 含封闭命令集报错
15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）
```

### 5.4 门禁自身抓到的问题（如实记录，不删）

**④ 的第一次运行是红的**（`exit 1`），红在**本页 §6.2 的表格**上：

```text
ERROR: gy-r28-roles-file-disposition-20261021.md:390: inconsistent table
ERROR: gy-r28-roles-file-disposition-20261021.md:391: inconsistent table
ERROR: gy-r28-roles-file-disposition-20261021.md:393: inconsistent table
```

**成因**：`tools/validate_development_docs.py:110-114` 要求「连续的 `|` 行单元格数一致」，
切分正则是 `re.split(r"(?<!\\)\|", line)`。而 §6.2 的"残留原文"列里引用了**本身含 `|` 的表格行**，
未转义的 `|` 让那一行的单元格数从 3 变成 6。
**修复**：把引用里的 `|` 写成 `\|`（GFM 表格内转义，渲染仍是 `|`，但切分正则跳过它）⇒ ④ 转绿。
**教训**：证据页里"引用表格行"必须转义竖线，否则 `test:docs` 会当场红——
这正是 gate ④ 该做的事（它抓到了写手自己的格式错），也说明本页不是手写放任的自由区。


## 6 未取得、残留与偏差（明列，不掩盖）

### 6.1 未取得

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 真 PG 上复跑 `provision-db.sh`／`20-login-roles.sql` | **未取得** | 本机无 PostgreSQL；本片是**静态**守卫，且改的是文档与测试，不改执行语义 |
| 部署形态下 `OBJECT_UNAVAILABLE` 的**运行期**观测 | **未取得** | 同上（推演见 §4.3，判据全部来自源码常量与静态读数，不是运行时观测） |
| `egress_ledger` 授权决策（要不要接进部署链） | **未裁定** | 属产品/安全裁定（§4.4） |

### 6.2 第一提交时登记的残留（第二提交已按 §9 处置）

下表是**第一提交时**的状态与不动理由；第二提交经指挥授权，按 §9 逐条处置：两处活文档注释
直接订正（只动注释，脚本逻辑/SQL 语句 0 行），历史证据页只在末尾加勘误节、原文一字不动，
`roles-and-migration.md:271` 属历史跑数，只加注不改数字。

| 位置 | 残留原文 | 第一提交时为什么不动 |
| --- | --- | --- |
| `deploy/postgres-cvm/provision-db.sh:285` | `本脚本按路径**复用**仓库里的 7 个角色 SQL…` | 派单 ⛔ 只读脚本（第二提交授权只改注释，见 §9 第 1 条） |
| `deploy/postgres-cvm/sql/20-login-roles.sql:35` | ``…`services/api/db/roles/*.sql` 建 7 个 NOLOGIN 组 ⇒ 需 **CREATEROLE**…`` | 派单 ⛔ 只读 SQL（第二提交授权只改注释，见 §9 第 2 条） |
| `deploy/postgres-cvm/evidence/local-self-check.md:873` | ``\| `provision-db.sh`（角色循环，7 个文件） \| …`` | 历史证据页（第二提交加勘误，见 §9 第 5 条） |
| `deploy/postgres-cvm/roles-and-migration.md:271` | ``\| 仓库 `services/api/db/roles/*.sql`（7 个） \| ✅ **7/7 成功** \|`` | **历史跑数记录**（指挥返修前的真跑），改它等于改历史（第二提交只加注，见 §9 第 3 条） |
| `deploy/postgres-cvm/evidence/local-self-check.md:363` | ``\| 仓库 `services/api/db/roles/*.sql`（7 个） \| ✅ **7/7 全部成功** \|`` | 同上（第二提交加勘误，见 §9 第 5 条） |
| `docs/verification/gy-r28-deploy-sql-gate-20261021.md:62` | ``--with-cli-groups` 才追加的 **3 组**（`provision-db.sh:272-275`：`egress_ledger`／`source_operator`／`staging_importer`）**不在 deploy 链里**`` | 另一片（R28 deploy-sql-gate）的证据页（第二提交加勘误，见 §9 第 6 条） |

第一提交时：前三条是**当前事实的过期表述**（"7 个角色 SQL"／"建 7 个 NOLOGIN 组"／"7 个文件"），
后三条是**历史跑数记录**或**别片的读数**；本片当时只订正派单指定的三处，其余钉在这里。
第二提交（指挥授权）已按 §9 处置：两条活文档注释直接订正，历史跑数只加注、历史证据页只加勘误节，
原文读数全部保留。

### 6.3 偏差

1. **`roles-and-migration.md:14` 第三列顺带改了动词**：派单只要求改计数，但该行改完计数后
   若仍写「**原样执行**」，本身就成了新的假话（11 个组里 `egress_ledger` 从不执行）。
   故同一行内把「原样执行」改成「原样复用（…执行其中 5 个、`WITH_CLI_GROUPS=1` 时 7 个；
   `egress_ledger.sql` 未被任何部署脚本执行）」。**未超出该行**，只写事实、不写建议。
2. **测试多了一条断言 1③ 的附加判据**（`+=` 必须在 `WITH_CLI_GROUPS` 条件里）。
   派单只要求"集合相等"；这条防的是"把 cli 组挪成默认执行"——那会让基础执行集合从 5 变 7，
   与清单的 `base`/`cli` 语义冲突。属**加强**，不是放宽。
3. **断言 3 只判 ⊆（不判 ==）**，理由见 §3.2；派单原文就是"断言 ⊆"。

## 7 与红线的一致性

| 红线 | 本片实际改动 | 是否触碰 |
| --- | --- | --- |
| ⛔ 不改 `provision-db.sh`／`20-login-roles.sql`／`services/api/db/roles/**` | 第一提交只**读**；**第二提交经指挥授权**只改两处**注释文本**（`provision-db.sh:285`、`20-login-roles.sql:35`），脚本逻辑/`GRANT` 语句 0 行改动 | 触碰（授权范围内，仅注释，见 §9 第 1/2 条） |
| ⛔ 不改 `services/**`、`apps/**`、`packages/**`、`tests/integration/**`、`.github/**` | 未改 | 未触碰 |
| ⛔ 除三处外不动其它文档 | 第一提交只改 `deploy/postgres-cvm/README.md:440`、`roles-and-migration.md:14`、`:103`（+ 本页新增）；第二提交（授权）改 `roles-and-migration.md:271`／`:341`（加注）与两页历史证据（**只在末尾加勘误节，原文不动**） | 未超授权范围 |
| ⛔ 不放宽既有断言 | `roles-bootstrap-idempotent.test.mjs` 一字未动；新测试只**新增**第 6 类断言（收紧） | 未放宽 |
| ⛔ 不 push／不建 PR／不改 `git config` | 两次提交都用 `git -c user.name=… -c user.email=…` 单次覆盖；PR #368 与 push 均由指挥完成 | 未触碰 |
| 提交消息用 **node** 写 UTF-8 无 BOM | `.pg17/commit-msg-s57.txt`（第一提交）与第二提交的消息文件均由 `node` 写 | 见 §5.1⑦ 提交后复核 |

## 8 第二提交（指挥授权）：只改口径，不改历史

第二提交由指挥在 PR #368 复核后授权，目标是处置 §6.2 登记的残留。口径：

- **活文档/代码注释**：直接订正为今天的事实；
- **历史跑数与历史证据页**：只加勘误/加注，**原文一字不动**（含引用旧日志的行）；
- **语义需先读清的**（`roles-and-migration.md:341` 的「7 个」）：先判定所指，再决定是否改数。

## 9 残留计数处置（第二提交）

第 1–2 条是活文档/代码注释（直接订正）；第 3–6 条是历史跑数与历史证据页（只加勘误/加注，原文不动）；第 7 条是断言收紧。

1. **`provision-db.sh:285`（活文档，只改文本）**：改为「本脚本按路径**复用**仓库里的角色 SQL（默认 5 个；WITH_CLI_GROUPS=1 时 7 个；egress_ledger.sql 当前不被本脚本执行），不复制、不重写。请确认：」。只动这一行双引号字符串；脚本逻辑与 `--plan` 分支未改（`bash -n` 通过）。
2. **`20-login-roles.sql:35`（活文档，只改注释）**：改为两行注释——「`services/api/db/roles/*.sql` 建 8 个角色文件、11 个 NOLOGIN 角色（组）⇒ 需 **CREATEROLE**（非超级用户亦可）；**本文件只授其中 5 个组**（C 段）；`egress_ledger.sql` 当前不被任何部署脚本执行，故 `gengyun_egress_ledger` 不在本文件的授权面内。」`GRANT`/`REVOKE` 0 行改动。
3. **`roles-and-migration.md:271`（历史跑数）**：先判定语义——该行在 §6.1「指挥**返修前**跑出的结果」表内 ⇒ 历史读数，**数字不动**；行末加「（R28-S57 注：当时为 7 个；现为 8 个角色文件 11 个 NOLOGIN 角色，见 §3.1）」。
4. **`roles-and-migration.md:341` 与 `local-self-check.md:451`（语义澄清）**：读清后「7 个」指**业务关系**（`users`／`sessions`／`admin_accounts`／`admin_scopes`／`idempotency_keys`／`catalog_read.home_species`／`catalog_read.current_knowledge`），不是角色文件数；「5 个既有 NOLOGIN 组」是运行时继承的 5 个组，今天仍是 5 个。故两处数字不动，各加一条「口径澄清」注（含今天读数「8 个角色文件、11 个 NOLOGIN 角色」）。
5. **`local-self-check.md`（历史证据）**：`:363`（7/7 跑数）、`:873`（角色循环 7 个文件）、`:901`（当时 `--plan` 原文）三处**原文一字不动**；文件末尾加「## 勘误（R28-S57，2026-10-21）」，4 行表格逐条写「原文位置/今天的事实/影响」，并回链本节断言名。
6. **`gy-r28-deploy-sql-gate-20261021.md`（别片历史证据）**：`:62` 原文「才追加的 **3 组**（`egress_ledger`／`source_operator`／`staging_importer`）」——事实是 **2 组**（`source_operator`、`staging_importer`），`egress_ledger.sql` 不在 `ROLE_GROUP_FILES`、部署路径从不执行；`--with-cli-groups` 两组仍不在本 job 的 apply 列表，该结论不变。只在文件末尾加勘误节（另澄清 `:58`／`:119` 的「5 组」仍成立）。
7. **测试收紧（`tests/unit/roles-file-disposition.test.mjs`）**：新增第 6 类断言「活文档口径」——两个活文档里不得再出现「7 个角色」／「7 个 NOLOGIN」，正则 `(?<![0-9])7\s*个\s*(?:角色|NOLOGIN)`（数字边界，避免误伤「17 个」）；测试数 10 → 11，负控制仍 5 条。

第二提交的读数：`tests 11 / pass 11 / fail 0`；与 `roles-bootstrap-idempotent` 同跑 `15/15`；七门禁全 exit 0（命令与 §5.1 相同，提交后复跑）。

**本页不是验收**：它是静态守卫 + 文档订正的证据；部署、云端、运行期均未参与。

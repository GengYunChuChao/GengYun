# R28-S61 证据页：运行时 SQL 列面 ↔ 授权列面 静态一致性守卫

- 切片：R28-S61（派单 `.pg17/dispatch/r28-s61-sql-column-coverage.md`）
- 分支：`test/gy-r28-sql-column-coverage`，基点 `upstream/main` = `76b0e86`
- 新增守卫：`tests/unit/sql-column-coverage.test.mjs`（**离线**，不连数据库、不起 PGlite）
- 本片定性：**只加检查，不加授权**。`deploy/postgres-cvm/**`、`services/**`、`migrations/**`、`roles/**` 与任何既有测试**一行未改**。

## 0. 一句话结论

把 8 个 `store-pg.ts` 里的 **139** 条 SQL 字面量解析成 **25** 张表、**1155** 条列权限要求，逐条对上 `deploy/postgres-cvm/sql/20-login-roles.sql` ＋ `services/api/db/roles/*.sql` 实际授给 `gengyun_api_runtime` 的列：**缺 0 条**。

零缺口本身不足以证明守卫有效，因此本页给三组独立证据（见 §4、§6）：守卫读到了 1140/1155 条**列级精确**授权、4 条负控制逐条变红并点名、从真实授权文本里删掉一条列授权后立刻红在 `public.speech_idempotency.payload` 上。

## 1. 背景：同一个坑踩了四次

| 片 | 症状 | 发现方式 |
| --- | --- | --- |
| S26 | `favorites` / `history` / `conversations` 七张表整张零授权 | 人工排查 |
| S28 | 迁移 0025 建了四张 `recognition_*`，`20-login-roles.sql` 零命中 | 人工排查 |
| S38 | 迁移 0026 建了三张 `speech_*`，同样零授权（90-assert 假绿 78/78） | 人工排查 |
| S45 | `users` 列级 INSERT 有 `wechat_subject_lookup`、缺 `wechat_subject_cipher` | 人工排查 |

`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 已经断言「授权面 = 预期清单」，但它**核对的是「预期」，不是「运行时真的用了什么」**。本片补的正是这一层：以 TypeScript 源码里写出的 SQL 为基准，反查授权面够不够。

## 2. 守卫做了什么

### 2.1 授权面（左操作数）

从 SQL 文本解析，不连库。文件清单固定为 9 个：

- `deploy/postgres-cvm/sql/20-login-roles.sql`（897 行，唯一给 `gengyun_api_runtime` 直授列的文件）
- `services/api/db/roles/*.sql` 8 个：`auth_privacy` / `catalog_readers` / `consent_granter` / `egress_ledger` / `knowledge_runtime` / `profile_runtime` / `source_operator` / `staging_importer`

为什么必须同时读 `services/api/db/roles/*.sql`：`idempotency_keys` 的授权只写在 `services/api/db/roles/auth_privacy.sql`（建组时执行），漏掉它会让 5 个 store 全线假红。

有效权限 = 直授 ∪ 组成员闭包。闭包实测 **6** 个角色：

```
gengyun_api_runtime, gengyun_auth_privacy, gengyun_consent_granter,
gengyun_knowledge_runtime, gengyun_preview_reader, gengyun_profile_runtime
```

`20-login-roles.sql:220-224` 只有这 5 条成员关系；`gengyun_egress_ledger` / `gengyun_source_operator` / `gengyun_staging_importer` **不在**闭包内（与文件里 :559 的 `\echo` 自述一致），因此它们授的表不进核对面。

解析器支持的形态（都实测存在，缺一条就会假红或漏判）：

| 形态 | 出处 |
| --- | --- |
| `GRANT SELECT (a, b) ON public.x TO role` | 20-login-roles.sql 各段 |
| `GRANT INSERT (...) / UPDATE (...)` | 同上 |
| `GRANT DELETE ON public.x TO role`（**表级**） | 同上 14 处 |
| `GRANT SELECT,INSERT,DELETE ON idempotency_keys TO gengyun_auth_privacy` | `roles/auth_privacy.sql:33`（多权限＋表级＋无限定名） |
| `GRANT UPDATE (outcome,response_status) ON idempotency_keys …` | `roles/auth_privacy.sql:34`（同表列级 UPDATE 与表级共存） |
| `GRANT SELECT ON consent_records,privacy_epochs …` | `roles/auth_privacy.sql`（一句多表） |
| `GRANT SELECT (owner_id) ON jobs,media …` | 同上（列清单同时作用于两张表） |
| `GRANT UPDATE(updated_at) ON consent_policies,recipients …` | `roles/consent_granter.sql:17`（`GRANT` 与 `(` 之间无空格） |
| `DO $tag$ … EXECUTE $gy$GRANT SELECT (…) ON …TO …$gy$; … $tag$;` | `roles/auth_privacy.sql:41-56`（美元引用内动态 GRANT，外层 tag 与内层不同，需递归） |
| `DO $$ … RAISE EXCEPTION … $$;` 守卫块、`REVOKE ALL ON TABLE`、`REVOKE ALL ON ALL TABLES IN SCHEMA`、`GRANT USAGE / CREATE ON SCHEMA`、`GRANT EXECUTE ON FUNCTION …`、`\echo` | 全部跳过，不当作表权限 |

**表级 vs 列级的处理（派单 §3.1 的已知陷阱）**：表级 `GRANT UPDATE ON t` 会把该表该权限记成 `{kind: 'table'}`（整表），**不带 `columns` 字段**；下游判定「整表 ⇒ 任意列都算已授权」。若此前已存在同表同权限的列级条目，解析时把它记进 `swallowed` 清单（表 + 权限 + 被吞的列 + 文件:行），报告里单列，不静默丢弃。全仓实测表级授权 14 条，`swallowed` 在基准上为 0 条。

### 2.2 运行时 SQL（右操作数）

扫 `services/api/src/**/store-pg.ts`，实测 8 个文件：

| 文件 | 字面量 | INSERT | UPDATE | SELECT | DELETE |
| --- | --- | --- | --- | --- | --- |
| `community/store-pg.ts` | 28 | 7 | 3 | 14 | 4 |
| `conversations/store-pg.ts` | 16 | 3 | 2 | 8 | 3 |
| `favorites/store-pg.ts` | 15 | 2 | 1 | 7 | 5 |
| `history/store-pg.ts` | 16 | 2 | 1 | 8 | 5 |
| `messages/store-pg.ts` | 12 | 2 | 2 | 6 | 2 |
| `ocr/store-pg.ts` | 16 | 3 | 4 | 7 | 2 |
| `recognitions/store-pg.ts` | 20 | 5 | 4 | 9 | 2 |
| `speech/store-pg.ts` | 16 | 3 | 4 | 7 | 2 |
| **合计** | **139** | **27** | **21** | **66** | **25** |

处理到的形态：

- 模板字面量与普通单引号字符串都扫；跳过 `//` 行注释与 `/* */` 块注释；`\'` 转义按转义处理（`to_regclass('public.x')` 探针就靠这个）。
- **列清单常量代入**：`const JOB_COLUMNS = 'id, revision, kind,' + ' status';` 这类跨行 `+` 拼接会被还原成完整列清单，再代入 `${JOB_COLUMNS}`。共 16 个常量（`messages:62`、`community:98/101/102/104`、`conversations:87/88/91`、`favorites:68/69`、`history:63/66`、`ocr:162/164`、`recognitions:177/179/181`、`speech:149/151`）。
- 表名**限定与不限定都吃**：`INSERT INTO community_posts` 与 `INSERT INTO public.ocr_jobs` 等价处理（未限定默认 `public`）。
- `INSERT … (a,b,c) VALUES/SELECT`、`UPDATE … SET a = …`、`SELECT a, b FROM …`、`DELETE FROM …`。
- `RETURNING`（54 处）与 `ON CONFLICT (a,b) DO UPDATE SET …`（17 处）都计入。`ON CONFLICT` 的冲突目标列按 **SELECT** 计入 —— 依据是 `20-login-roles.sql:714-716` 的既有注释「`ON CONFLICT` 的 `(scope,key_hash)` 推断、`EXCLUDED` / `WHERE` / `RETURNING` 都要 SELECT 权」。
- 特殊表达式：`(extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms`（`messages:231`、`community:708`）—— `FROM` 在函数括号内，先剥 `extract(field FROM expr)` 再切子句，否则会把 `expires_at` 之后整段当表名。`count(*)::bigint AS count`、`answer_id = COALESCE($3::uuid, answer_id)` 同法处理。
- `SELECT *`：实测 **0 处**，单独计数，出现也不展开（见 §8）。

### 2.3 列权限的判定规则（按语句形态区分）

| 语句 | 判定的权限 |
| --- | --- |
| `SELECT` | 选择清单里的列 + `WHERE` 列 + `ORDER BY` 列，都要 SELECT |
| `INSERT` | 列清单要 INSERT；`RETURNING` 列要 SELECT |
| `UPDATE` | `SET` 左值要 UPDATE；`WHERE` 列要 SELECT；`RETURNING` 列要 SELECT |
| `DELETE` | DELETE（表级或该表无列级 DELETE 时要求表级）；`WHERE` / `RETURNING` 列要 SELECT |
| `ON CONFLICT (a, b)` | 冲突目标列要 SELECT；`DO UPDATE SET` 左值要 UPDATE |

`函数名(...)`、`count(*)`、`IS NOT NULL`、`AS 别名`、`::类型` 等都不当成列名（否则会造出 `extract`、`count`、`not` 之类的假列）。

### 2.4 两个方向

- **正向判红**：每条「表.列 + 权限」查授权面；未命中且未登记 `COVERAGE_EXEMPT` ⇒ 断言失败，红字形如 `文件:行 → 表.列 缺 权限（子句）；授权面现状：只授了 [ ... ]`。
- **反向只报告**：授权面里有、运行时从未引用的列 → `console.log` 计数，不判红（派单 §3.3 第 3 条）。当前读数：25 张基准表里有 **3** 条（`public.favorites.revision`、`public.history.revision`、`public.conversations.revision`，全是 UPDATE）；整表从未被 8 个 store 引用的表 **20** 张。
- **不可判插值**：无法静态求值的 `${…}` 逐条登记进 `OPAQUE_ALLOWLIST`（含 `file:line` 与 `reason`），**两个方向都判红**：新增未登记的判红；已登记但源码里已不存在的也判红（防躺平）。当前 2 条，全部是 `conversations/store-pg.ts` 的 `${where}`。

## 3. 覆盖读数（全部钉死在断言里，改一个数就红）

| 读数 | 值 |
| --- | --- |
| store-pg 文件数 | 8 |
| SQL 字面量 | 139 |
| 语句条数 | INSERT 27 / UPDATE 21 / SELECT 66 / DELETE 25 |
| `RETURNING` 子句 | 54 |
| `ON CONFLICT` 子句 | 17 |
| `SELECT *` | 0 |
| 无顶层 `FROM` 的 SELECT（标量子查询与就绪探针） | 4 |
| 引用到的表 | 25 |
| 列权限要求 | 1155 |
| 已覆盖 | 1155（缺 0） |
| 覆盖来源 | 列级精确命中 **1140** / 表级整表命中 **15** |
| 表级授权条目 | 14 |
| 不可判插值 | 2 |
| 反向：已授权未引用的列（基准表上） | 3 |
| 反向：整表未被引用 | 20 |

无顶层 `FROM` 的 4 处是真实存在、且不产生列要求的语句：

- `community/store-pg.ts:786`：4 个标量子查询 `SELECT count(*) …`
- `ocr/store-pg.ts:154`、`recognitions/store-pg.ts:169`、`speech/store-pg.ts:142`：`SELECT (to_regclass('public.<table>') IS NOT NULL) AS ready` 就绪探针

这 4 条不计入「表」也不计入「列」，因此不影响 25 张表的读数 —— 它们只证明解析器确实把每条语句都过了一遍。

## 4. 真实缺口清单

**本片实测 0 条真实缺口。** `COVERAGE_EXEMPT` 为空数组。

「零缺口」不可信，所以给出四组独立证据：

1. **守卫确实在看列，不是在看表**：1155 条要求里 **1140 条**是靠「列级精确授权」命中的（98.7%），只有 15 条靠表级整表授权蒙过。如果解析器没解析列清单、或 `lookupPrivilege` 无脑返回「整表」，这个比例会反过来。
2. **人为制造缺口会红**：NC1（内存夹具，假 store 用未授权列 ⇒ 点名 `public.messages.not_granted_column`）与 NC3（从**真实** `20-login-roles.sql` 文本里删掉 `GRANT UPDATE (payload, pending)` 里的 `payload` ⇒ 立刻红在 `public.speech_idempotency.payload`）。红字原文见 §6。
3. **解析器看见了全部 8 个文件**：逐文件字面量条数（28/16/15/16/12/16/20/16）与合计（139）钉死，任一文件解析失败或漏扫都会红。
4. **反向也有读数**：能报出 3 条「授权了但没人用」的列和 20 张「整表没人用」的表，说明授权面是真的被解析成了「表 × 权限 × 列」结构，而不是空壳。

为什么不修：派单 §2 红线 —— 本片只加检查、不加授权。且本片**没有发现**需要修的缺口，所以也没有留给后续片的条目。

## 5. 例外机制（当前为空，但机制被负控制验证过）

`COVERAGE_EXEMPT` 元素必须含 `ref`（`table.column`，形如 `public.speech_idempotency.payload`）、`privilege`、`reason`、`owner` 四项，缺一直接判红（防止写个空 reason 蒙过去）。

`staleExemptions` 双向盯死：登记的例外如果**已经不再缺**（无论是因为该列在授权面里其实已授权，还是运行时 SQL 已不再引用它），一律判红并打印两种不同措辞，逼人删掉陈旧登记。NC3 用真实缺口 + 复原两种状态验证过这两条路径（见 §6.3）。

## 6. 四条负控制的红字原文

### 6.1 NC1 内存夹具：假 store 用了未授权列 ⇒ 必须红

夹具（4 行假 store，用真实授权面核对）：

```ts
const SENTINEL_COLUMNS = 'id, revision, not_granted_column';
export function fake(pool) {
  return pool.query(`SELECT ${SENTINEL_COLUMNS} FROM public.messages WHERE id = $1`);
}
```

改前红字原文：

```
tests/unit/fixtures/sql-column-coverage/nc1-fake-store-pg.ts:3 → public.messages.not_granted_column 缺 SELECT（SELECT 列清单）；授权面现状：只授了 [id, revision, owner_id, type, target_ref, read_at, created_at, event_key]
```

同一条断言还钉死 `covered === 2`：同一语句里已授权的 `id` / `revision` 仍然算覆盖，解析器不是乱杀。

### 6.2 NC2 内存夹具：表级 GRANT 吞列级 ⇒ 必须标记为「整表」

夹具（两句授权，先列级后表级）：

```sql
GRANT UPDATE (revision) ON public.favorites TO gengyun_api_runtime;
GRANT UPDATE ON public.favorites TO gengyun_api_runtime;
```

改前读数：

```
public.favorites 的 UPDATE 被标记 kind=table（整表）；被吞的同类型列级条目 {"table":"public.favorites","privilege":"UPDATE","columns":["revision"],"file":"services/api/db/roles/nc2-fake.sql","line":3}
```

三条断言：`kind === 'table'`；`hasOwnProperty(granted, 'columns') === false`（整表绝不能带 `columns` 字段，否则下游会把「列清单为空」误当成「全列」）；`kind !== 'columns'`（表级不能被降级成列级）。被吞的列级条目单列记录在 `swallowed` 里，逐列可查。最后用 `lookupPrivilege(model, 'public.favorites', 'UPDATE')` 断言整表语义确实生效。

### 6.3 NC3 从真实授权文本删掉一条真实授权 ⇒ 必须红并点名

**与派单的偏差（必须说明）**：派单 §4 写的是「删掉 `COVERAGE_EXEMPT` 里的一条真实例外」。本片实测 **0 条真实缺口**，`COVERAGE_EXEMPT` 是空的，没有「真实例外」可删。因此改用**等价且更强**的做法：直接从真实文件 `deploy/postgres-cvm/sql/20-login-roles.sql` 的文本里删掉一条**真实存在的列授权**（`GRANT UPDATE (payload, pending)` ⇒ `GRANT UPDATE (pending)`，只改内存里的字符串，不动仓库文件），看正向断言是否变红。这正是用户要求的「人为删掉一条授权后测试会红」的证明。

改前红字原文：

```
services/api/src/speech/store-pg.ts:642 → public.speech_idempotency.payload 缺 UPDATE（UPDATE SET）；授权面现状：只授了 [pending]
```

红字精确点名了「文件:行 → 表.列 + 缺的权限 + 子句类型」四要素。复原证明：把真实文本还原后 `problems.length` 回到 **0**。

例外机制的两条路径也在同一条负控制里验证：

- 把这条真实缺口登记进 `COVERAGE_EXEMPT` ⇒ 立即变绿（`problems.length === 0`），证明例外表真的能把已登记缺口压绿；
- 反过来，在**没有缺口**的基准上登记同一条例外 ⇒ 立刻判陈旧：

```
COVERAGE_EXEMPT 里登记的 public.speech_idempotency.payload（UPDATE）已不再缺失（该列在授权面里其实已授权） —— 陈旧例外，删掉它
```

### 6.4 NC4 给 `OPAQUE_ALLOWLIST` 加一条源码里不存在的 `file:line` ⇒ 必须红

改前红字原文（陈旧登记方向）：

```
OPAQUE_ALLOWLIST 登记的 services/api/src/messages/store-pg.ts:99999 在源码里已不存在（陈旧登记，删掉它以免守卫躺平）
```

反方向（新增未登记的插值）也判红，红字原文：

```
未登记的不可判插值 tests/unit/fixtures/sql-column-coverage/nc4-fake-store-pg.ts:2（${dynamicFilter}）：要么让它可静态求值，要么登记进 OPAQUE_ALLOWLIST 并写清理由
```

两个方向各恰好 1 条，不多不少 —— 证明 `OPAQUE_ALLOWLIST` 与源码是一一对应的，不是「登记了就永不报警」。

## 7. 门禁

全部在本工作树 `E:\GengYunCommander\wt-r28-s61` 内执行。

| # | 门禁命令 | exit | 末行 |
| --- | --- | --- | --- |
| 1 | `node --test --test-concurrency=1 tests/unit/sql-column-coverage.test.mjs` | 0 | `ℹ duration_ms 376.5956`（计数行 `ℹ tests 8` / `ℹ pass 8` / `ℹ fail 0`） |
| 2 | `npm run lint` | 0 | `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| 3 | `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）`（其后仅空行） |
| 4 | `npm run test:docs` | 0 | `PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住` |
| 5 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| 6 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `ℹ duration_ms 160.0001`（计数行 `ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0`） |
| 7 | `node --test --test-concurrency=1 "tests/unit/sql-*.test.mjs" "tests/unit/migrations*.test.mjs"` | 0 | `ℹ duration_ms 4361.638`（计数行 `ℹ tests 18` / `ℹ pass 18` / `ℹ fail 0`） |
| 8 | `git diff --check` | 0 | 无输出 |

门禁 1／6／7 用的是 `node --test`，它输出的**字面最后一行**是 `ℹ duration_ms …`；`ℹ fail 0` 是它上面第四行。上表两行都记，免得「末行」被理解成 `fail 0`。门禁 8 同时跑了 `git diff --check`（工作树）与 `git diff --check upstream/main...HEAD`（覆盖两个提交的全部新增行），两个都无输出、exit 0。

门禁 7 实际跑的是哪些文件（按派单 §5 允许的窄口径）：

- `tests/unit/sql-column-coverage.test.mjs`（本片新增，8 条）
- `tests/unit/migrations.test.mjs`
- `tests/unit/migrations-constraint.test.mjs`（含 PGlite 内存引擎跑 0001）

**没跑**：`tests/unit` 下其余 181 个 `.test.mjs`，以及 `tests/privacy` / `tests/media` / `tests/reference` / `tests/moderation` 五个目录（`npm run test:unit` 的全量口径）。理由是派单 §5 第 7 条允许窄口径，且本片未触碰任何既有代码；但「没跑全量」这件事本身是残余风险，记在这里。

## 8. 未取得（明确的能力边界）

1. **静态解析不覆盖动态拼接 SQL**：只有当 SQL 文本（含常量代入后）能在编译期求出时才被核对。运行时拼出来的字符串（如 `${where}` 之外新增的拼装、`format()` 生成、按参数选表名）一律无法判读 —— 这类插值会进「不可判」清单并强制登记，**但登记本身只保证「人看过」，不保证「授权够」**。
2. **不覆盖 `SELECT *` 的具体列**：实测 0 处，但一旦出现，本守卫只能计「1 处 `SELECT *`」，无法展开成真实列清单 —— 需要改成显式列清单才能被核对。
3. **不覆盖 PL/pgSQL 函数体内的 SQL**：数据库侧函数、触发器、`DO $$ … $$` 里若读写某列，本守卫看不见（授权面的 `DO $$ … EXECUTE $gy$GRANT …$gy$` 是被解析的，因为那是目标语言里的授权语句；反过来，PL/pgSQL 里对业务表的 DML 不在扫描范围）。
4. **不覆盖「授权够但语义错」**：本守卫只核对「列权限有没有」，不核对列名拼写是否正确、不改核对 `REVOKE` 的连锁效果（出现针对运行时角色或其组的 `REVOKE` 时解析器会直接判红并要求人工扩写，而不是猜）。
5. **不连数据库**：不与真实 PG 实例比对 `information_schema.role_column_grants`，也不验证 `20-login-roles.sql` 是否真的被部署执行过。授权面可能「写了但没跑」。
6. **不覆盖非 `store-pg.ts` 的 SQL**：`services/**` 里其他位置的 SQL 字符串（迁移、脚本、admin 侧）不在扫描面内。

## 9. 复现

```
cd E:\GengYunCommander\wt-r28-s61
node --test --test-concurrency=1 tests/unit/sql-column-coverage.test.mjs
```

测试输出里会逐行打印 §3 的全部读数（含逐文件字面量条数与覆盖来源拆分），以及 §6 四条负控制的红字原文。

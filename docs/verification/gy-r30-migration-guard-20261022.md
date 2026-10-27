# R30 · 迁移编号唯一门禁（2026-10-22）

本片只做一件事：给 `services/api/db/migrations/NNNN_*.sql` 的**全局唯一命名空间**补一层**静态**门禁。不连库、不执行任何 `.sql`、不写任何文件、不联网、无第三方依赖。

- 仓库 `GengYunChuChao/GengYun`，分支 `feat/gy-r30-migration-guard`，基线 `d4d48088532377adb54c278b24ba90be42cb5aaf`，工作树 `E:\GengYunCommander\wt-r30-migration-guard`。
- 交付物：`tools/verify-migrations-unique.mjs`（判据本体 · 954 行，含 `--json` / `--strict` / `--annotations`）、`tests/unit/verify-migrations-unique.test.mjs`（单测 · 28 条）、`.github/workflows/migrations-guard.yml`（每个 PR 跑一次）、本页证据。
- ⛔ 不改任何既有迁移/回滚文件，不改 `services/`、`apps/`、`packages/`、`deploy/` 下的实现，不改 `real-pg-integration.yml`，不改 `docs/architecture/contract-status.json`。

## 1 动机：git 不冲突，运行时会炸

`NNNN_` 前缀是**全局唯一**的编号空间，但 git 只比较**文件路径**。两条分支各写一条 `0028_*.sql`，路径不同 ⇒ 无文本冲突、GitHub 判 `MERGEABLE`；而 `services/api/src/db/migrate.ts` 的发现器是**按目录读文件名**的：

```ts
// services/api/src/db/migrate.ts:44
const MIGRATION_PATTERN = /^(\d{4,})_([a-z0-9_]+)\.sql$/;
```

`discoverMigrations()`（`services/api/src/db/migrate.ts:51`）先按 `entry.isFile() && entry.name.endsWith('.sql')` 收文件（`:52-53`），再逐条 `exec` 上面这条正则（`:61`），把撞号的第二条**确定性**抛出来：

```ts
// services/api/src/db/migrate.ts:71-73
const previous = seen.get(version);
if (previous !== undefined) {
  throw new Error(`迁移版本号重复：${version} 同时出现在 ${previous} 与 ${filename}`);
}
```

再加一刀：台账表 `schema_migrations.version` 是 `text PRIMARY KEY`（`services/api/src/db/migrate.ts:108`）。于是「红」只发生在**真库**里 —— 而真库链是分片跑的（`real-pg-integration.yml` 等），一个**只往迁移目录里加文件**的 PR 完全可能先合并、在别人下一次起库时才炸。

真实形态（不是假设）：

| 形态 | 实例 | 后果 |
| --- | --- | --- |
| main 已占 | `0027_admin_audit_observability.sql` | 下一个可用号是 `0028` |
| `#434` 分支带 | `0028_governance_audit_log.sql` | 与下一条同号 |
| 更早未完成的 i18 片（未提交，抢救件在 `.pg17\tmp\cleanup-r30-evidence\i18-batch3\migrations\`，含同名 `.down.sql`） | `0028_admin_scope_authority.sql` | 两条 `0028_*` 落进同一目录 ⇒ 运行器抛「迁移版本号重复：0028 同时出现在 …」 |

既有静态守卫各管一段，**都不管「同号」**：`tests/unit/migrations-rollback-pairing.test.mjs` 按**前缀分组**配对，同号两条正向文件在它那里是「一个桶里的两份 down」，与「同一条迁移写了两遍」不可区分；`tools/verify-release-materials.mjs` 那条数量不变量更是看不出来（一缺一多仍可能相等）。本片补的就是这一层。

## 2 判据表

| 判据 | 档 | 触发条件 | 现实对应 | 实现锚点 |
| --- | --- | --- | --- | --- |
| `[surface]` | **硬**（exit 1） | 顶层 `.sql` 必须合 `^\d{4}_.*\.sql$`，且**至少 1 条**；顶层出现 `.down.sql` 判红；后缀不是小写 `.sql`、或 `.sql` 条目不是常规文件，同样判红 | 「扫到 0 条 ⇒ 全绿」是门禁最经典的假绿；`.down.sql` 放在顶层既不是正向迁移、也永远不会被当回滚执行 | `// ── [surface]` 两段，`tools/verify-migrations-unique.mjs:347`（目录前置）/ `:374`（扫描面） |
| `[runner]` | **硬** | 守卫扫描集合 ≠ **产品发现器**扫描集合 ⇒ 红并点名差集 | 正则逐字抄 `services/api/src/db/migrate.ts:44`（常量 `RUNNER_PATTERN_SOURCE`，`tools/verify-migrations-unique.mjs:105`）。两侧数量不一致时「守卫绿」没有意义 | `tools/verify-migrations-unique.mjs:440` |
| `[dup]` | **硬** | 同一 4 位号被**两个及以上正向文件**占用 | §1 的真实形态。点名两个文件 + 运行时会抛的原话 + 下一个可用号 | `tools/verify-migrations-unique.mjs:467` |
| `[coexist]` | 软（默认 `WARN`，`--strict` 才红） | `rollback/` 只收 `<NNNN>_<name>.down.sql`；往 `rollback/` 放正向形态、或给同一号补第二份 `.down.sql`，判 warn | 这是把「第二条同号迁移」藏起来的两种典型形态：放进去的文件既不会被当回滚执行，也不会被运行器发现 | `tools/verify-migrations-unique.mjs:509` |
| `[rollback]` | 软（默认 `WARN`，`--strict` 才红） | 每条正向迁移要么有 `rollback/<同名>.down.sql`，要么在内置 `NO_ROLLBACK` 清单里（每条理由 ≥ 20 字）；孤儿回滚、同号 down 与正向名不一致、**登记过期**（已有 down / 迁移已不存在 / 理由占位）均报 warn | 例外必须可核证、会过期，不能变成永久通行证 | `tools/verify-migrations-unique.mjs:567` |
| 缺号 `[gap]` | 软（默认 `WARN`，`--strict` 才红） | 首尾之间缺的号（`min+1..max-1`），若在迁移目录下某个 `*.md` 的**同一行**找不到「跳过 / 预留 / 预占」类说明 ⇒ `WARN[gap]` 并点名该号 | 跨 PR 乱序合并时缺号是正常态；真正要防的是「号被**悄悄**用掉了，没人知道」——所以要的是**依据**，不是「必须连续」 | `listDocSources()`（`:212`）/ `findGapEvidence()`（`:228`）/ 证据装配在 `:664-666` |

**为什么分档。** `[dup]` 是本片立项的真实事故形态（两条 `0028_*` 落进同一目录，git 侧 MERGEABLE、运行时才炸）⇒ 必须硬红；`[coexist]`/`[rollback]`/缺号靠的是「全仓统一约定 + 每个 PR 都补」这类**分布式约定**（`rollback/` 目前不是全仓普遍约定、跨 PR 乱序合并天然会缺号），把它们设为硬档等于让每条无关 PR 都为别人的迁移负责 —— 所以默认只 `WARN` 并计入「默认不判错」尾行，需要更严时显式 `--strict`。
**口径更正（2026-10-28 复测）。** 本页早前写过「既有仓里本来就有欠账、会被 `continue-on-error` 绕过」——**这一句没有依据**：当前真仓 `--strict` 实测 **EXIT=0**（46 条配对 + 1 条 `NO_ROLLBACK` 登记 = 47 条正向迁移逐条有交代、软档 0 项），且该 workflow 全历史里从未出现 `continue-on-error` 键（全仓 workflows 也无实际使用）。分档因此是**设计取舍**（避免无关 PR 承担跨分支缺号），不是「历史上被迫放水」的记录。

退出码：`0` = **无硬错**（非 `--strict` 下不看 warn 项）；`1` = 有硬错（`[surface]` / `[runner]` / `[dup]`），加 `--strict` 时软项（`[coexist]` / `[rollback]` / 未登记缺号）也升为 1；`2` = 用法错误（`--dir` 缺值、未知参数）。

两种输出：默认人读报告（`renderReport()`，`tools/verify-migrations-unique.mjs:695`）；`--json` 时 stdout 是**纯 JSON**（`buildJsonReport()`，`:772`），字段 `ok` / `exitCode` / `strict` / `counts{}` / `duplicates[]` / `gaps[]` / `rollbackIssues[]` / `errors[]` / `numbers[]` / `docSources[]` / `readings[]`，`schemaVersion: 1`。命令行入口 `main()`（`:890`），被 `import` 时无副作用（`:942` 的 `isDirectExecution()` 守卫）。

`NO_ROLLBACK` 当前只有 `0001` 一条，理由是**全库地板**（15 个枚举 / 20 张表，`0002..0027` 全部建在其上且既有 down 一律显式保留其对象；它的 down 只等于清库），可逆性判定见 [gy-r28-migration-rollback-pairing-20261021.md §4](gy-r28-migration-rollback-pairing-20261021.md)。

## 3 真跑：当前仓 exit 0

命令：`node tools/verify-migrations-unique.mjs`（工作树根目录，Node v24.16.0）。

```text
迁移编号唯一门禁（R30 · 纯静态）· 目录 E:\GengYunCommander\wt-r30-migration-guard\services\api\db\migrations
[surface]  顶层 .sql 27 条：合 ^\d{4}_.*\.sql$ 的正向迁移 27 条 / 不合规 0 条 / 顶层 .down.sql 0 条
[runner]   守卫 27 条 ↔ 产品发现器 27 条：差集 0 条
[dup]      27 条正向迁移占用 27 个编号（0001..0027）：同号多文件 0 处
[coexist]  rollback/ .sql 26 条：合 <NNNN>_<name>.down.sql 26 条 / 同号多份 0 处
[rollback] 已配对 26 条 / 允许缺省 1 条（0001） / 缺回滚 0 条 / 孤儿回滚 0 条
[gap]      编号连续性：0001..0027 连续（首尾之间无缺口）（缺号默认只 warn；依据 = 迁移目录下 *.md 里同行的「跳过/预留」说明）
[gap]      「故意跳过」依据扫描面：迁移目录下没有任何 .md（README/说明）⇒ 任何缺号都算未登记
[逐条] 正向迁移 ↔ 回滚
  0001  0001_initial_schema.sql  （登记为允许缺省，见 NO_ROLLBACK）
  0002  0002_knowledge_catalog.sql  ← rollback/0002_knowledge_catalog.down.sql
  0003  0003_privacy_consent.sql  ← rollback/0003_privacy_consent.down.sql
  0004  0004_workbook_staging.sql  ← rollback/0004_workbook_staging.down.sql
  0005  0005_catalog_read_views.sql  ← rollback/0005_catalog_read_views.down.sql
  0006  0006_source_lifecycle.sql  ← rollback/0006_source_lifecycle.down.sql
  0007  0007_staging_intake.sql  ← rollback/0007_staging_intake.down.sql
  0008  0008_auth_session.sql  ← rollback/0008_auth_session.down.sql
  0009  0009_consent_policy.sql  ← rollback/0009_consent_policy.down.sql
  0010  0010_knowledge_read_views.sql  ← rollback/0010_knowledge_read_views.down.sql
  0011  0011_export_ledger.sql  ← rollback/0011_export_ledger.down.sql
  0012  0012_knowledge_created_at.sql  ← rollback/0012_knowledge_created_at.down.sql
  0013  0013_conversations.sql  ← rollback/0013_conversations.down.sql
  0014  0014_export_object_key.sql  ← rollback/0014_export_object_key.down.sql
  0015  0015_export_object_key_shape.sql  ← rollback/0015_export_object_key_shape.down.sql
  0016  0016_account_deletion_persistence.sql  ← rollback/0016_account_deletion_persistence.down.sql
  0017  0017_account_suspend_authority.sql  ← rollback/0017_account_suspend_authority.down.sql
  0018  0018_favorites_history.sql  ← rollback/0018_favorites_history.down.sql
  0019  0019_messages_persistence.sql  ← rollback/0019_messages_persistence.down.sql
  0020  0020_feature_flags.sql  ← rollback/0020_feature_flags.down.sql
  0021  0021_admin_accounts_read.sql  ← rollback/0021_admin_accounts_read.down.sql
  0022  0022_community_persistence.sql  ← rollback/0022_community_persistence.down.sql
  0023  0023_user_backup_copies.sql  ← rollback/0023_user_backup_copies.down.sql
  0024  0024_ocr_persistence.sql  ← rollback/0024_ocr_persistence.down.sql
  0025  0025_recognitions_persistence.sql  ← rollback/0025_recognitions_persistence.down.sql
  0026  0026_speech_persistence.sql  ← rollback/0026_speech_persistence.down.sql
  0027  0027_admin_audit_observability.sql  ← rollback/0027_admin_audit_observability.down.sql
PASS：5 项判据全部满足（surface / runner / dup / coexist / rollback）；26 条配对 + 1 条登记允许缺省 = 27 条正向迁移逐条有交代。
```

**退出码 `0`。**（原文照贴；两条 `[gap]` 行只是读数：缺号默认 `WARN` 不判红 —— 跨 PR 乱序合并时 `0028` 在 `#434`、`0029` 在别的片是正常态，判红会在 main 上误伤无关的人。要判红得加 `--strict`，且缺号必须在迁移目录的 `*.md` 里有「故意跳过」依据才豁免 —— 见 §4b。）

`--json` 同一目录的读数（`node tools/verify-migrations-unique.mjs --json`，exit 0）：`ok: true`、`exitCode: 0`、`strict: false`、`duplicates: []`、`gaps: []`、`counts: { forward: 27, rollback: 26, numbers: 27, duplicates: 0, duplicateFiles: 0, gaps: 0, documentedGaps: 0, undocumentedGaps: 0, paired: 26, exempted: 1, missingRollback: 0, orphanRollback: 0, rollbackIssues: 0, errors: 0 }`。

## 4 负控制：把两条 `0028_*` 放进同一个目录 ⇒ exit 1

按**真实事故的形态**造负控制：把 `services/api/db/migrations/` 整棵拷到临时目录（正向 27 条 + `rollback/` 26 条），再往里加两条同号文件 —— `0028_moderation_persistence.sql` 与 `0028_governance_audit_log.sql`（各一行 `CREATE TABLE …;`）—— 然后对**临时目录**跑 `--dir`。⛔ 真实迁移目录**零改动**（比「造完立刻删」更干净：删掉之前的那一瞬间，任何人 `git status` 都会看到脏）。

```text
[dup]      29 条正向迁移占用 28 个编号（0001..0028）：同号多文件 1 处
[gap]      编号连续性：0001..0028 连续（首尾之间无缺口）（缺号默认只 warn；依据 = 迁移目录下 *.md 里同行的「跳过/预留」说明）
[gap]      「故意跳过」依据扫描面：迁移目录下没有任何 .md（README/说明）⇒ 任何缺号都算未登记
FAIL[dup] 同一 4 位号被两个及以上正向文件占用（1 个号）：
  · 0028：0028_governance_audit_log.sql、0028_moderation_persistence.sql
    ⇒ services/api/src/db/migrate.ts:72 会确定性抛「迁移版本号重复：0028 同时出现在 0028_governance_audit_log.sql 与 0028_moderation_persistence.sql」；两条分支的文件路径不同 ⇒ git 无文本冲突、GitHub 判 MERGEABLE，而 schema_migrations.version 是主键（migrate.ts:108）⇒ 只有真库会红。
WARN[rollback] 缺回滚且未登记为允许缺省（3 条）：0001_initial_schema.sql、0028_governance_audit_log.sql、0028_moderation_persistence.sql
FAIL：1 项不满足（dup）；退出码 1。
WARN：1 项默认不判错（rollback）；退出码 0；加 --strict 可升为退出码 1。
```

**退出码 `1`**（上面是判决段原文；上方 `[surface]`/`[runner]`/`[coexist]` 读数与 `[逐条]` 清单同 §3，此处只摘变化段）。

同一目录加 `--json`，退出码同为 `1`：

```json
{
  "ok": false,
  "exitCode": 1,
  "duplicates": [{ "number": "0028", "files": ["0028_governance_audit_log.sql", "0028_moderation_persistence.sql"] }],
  "counts": { "forward": 29, "numbers": 28, "duplicates": 1, "duplicateFiles": 2, "gaps": 0, "undocumentedGaps": 0, "errors": 1, "rollbackIssues": 1 },
  "errors": ["dup"],
  "rollbackIssues": ["rollback"]
}
```

**这条 `WARN[rollback]` 里的 `0001_initial_schema.sql` 是刻意的**：拷到临时目录后，内置 `NO_ROLLBACK` 清单**不套用**（清单绑定真实目录，见守卫里 `builtinAllowlistApplies` 的注释）—— 别的目录不该继承本仓的豁免，否则「换个目录跑」就成了绕开登记的后门。真实目录里 `0001` 是「登记允许缺省」，那份读数见 §3。

「git 侧干净、静态侧点名」正是这条门禁要的形态：这正是一条只加迁移文件的 PR 在**静态**阶段该看到的输出。`[rollback]` 同时报缺 down 是**预期**的（负控制故意不补 down；两者是不同判据，不是为了凑数）；它只 `WARN`，硬红只由 `[dup]` 造成 —— 与 §2 的分档表一致。

负控制跑完即删临时目录（`Remove-Item -Recurse -Force` 后 `Test-Path` = `False`）；真实目录 `git status --porcelain services/api/db/migrations` 全程零输出。

## 4b 跳号控制：缺号只 `WARN`，有 README 依据才豁免

同一套临时目录（拷贝 + 加 `0028_ocr_persistence.sql` 与 `0030_skill_persistence.sql`，故意缺 `0029`），跑三次 —— 这是「跳号」这条判据的负控制：

```text
[gap]      编号连续性：0001..0030 缺 1 个：0029（已登记依据 0 / 未登记 1）（缺号默认只 warn；依据 = 迁移目录下 *.md 里同行的「跳过/预留」说明）
[gap]      「故意跳过」依据扫描面：迁移目录下没有任何 .md（README/说明）⇒ 任何缺号都算未登记
WARN[gap] 缺号但迁移目录下没有「故意跳过」依据（1 个）：0029
WARN：2 项默认不判错（rollback、gap）；退出码 0；加 --strict 可升为退出码 1。
```

**退出码 `0`**（缺号默认不判错）。在临时目录里补一个 `README.md`，第 3 行写 `- 0029 故意跳过：预留给 #434 的审计日志迁移，本片不占号。` 后重跑：

```text
[gap]      编号连续性：0001..0030 缺 1 个：0029（已登记依据 1 / 未登记 0）（缺号默认只 warn；依据 = 迁移目录下 *.md 里同行的「跳过/预留」说明）
[gap]      「故意跳过」依据扫描面：README.md
[gap] 缺号有「故意跳过」依据（1 个）：0029 → README.md:3
WARN：1 项默认不判错（rollback）；退出码 0；加 --strict 可升为退出码 1。
```

**退出码仍为 `0`，且 `[gap]` 从 `WARN` 降为纯读数** —— 有依据的缺号即便 `--strict` 也不该红（同一目录加 `--strict` 时退出码 `1`，但判红项只剩 `rollback`：`FAIL：1 项不满足（rollback）；退出码 1。`）。

判据不恒真：`0101` 这种「只被列在 README 目录清单里、同一行没有『跳过/预留』字样」的号**不算**有依据（单测 `JSON 夹具 C3` 钉住这条）。

## 5 单测：28 条全过

`node --test tests/unit/verify-migrations-unique.test.mjs`（Node v24.16.0，Windows）：

```text
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

夹具一律建在 `os.tmpdir()`、`after()` 删除，**不写** `services/api/db/migrations/`。覆盖：用法 0/1/2 三条；正常 / 重复号 / `rollback/` 形态错两种 / 发现器集合不等 / 空目录 / 顶层 `.down.sql` / 缺回滚 / 不合规命名 / 目录不存在 / `rollback/` 缺失 / 孤儿回滚（软档各带 `--strict` 反向断言）；**派单口径的三类夹具**（§2b：合法连续 / 重复号 / 跳号，全部走 `--json` 解析 `duplicates[]`、`gaps[]`、`counts{}`）；README 有「故意跳过」依据 ⇒ `--strict` 下仍绿；只提到号没「跳过」字样 ⇒ 不算依据；真实仓绿 + `--json` 的 `duplicates[]` 为空且编号清单与磁盘正向文件逐个对齐；口径同源（正则逐字一致、默认目录同一处）；`NO_ROLLBACK` 生效 / 过期 / 理由占位三条。

`npm run test:unit` 的 glob 是 `"tests/unit/*.test.mjs"`（`package.json`），本文件因此在既有 `engineering-shell.yml` 的 unit-tests job 里也会跑一次，不需要改任何既有 workflow。

## 6 口径同源与编码核验

| 项 | 方法 | 读数 |
| --- | --- | --- |
| 守卫抄的正则 == 产品发现器 | 单测读 `services/api/src/db/migrate.ts` 原文，正则体与 `RUNNER_PATTERN_SOURCE` **逐字**比对 | 一致；`migrate.ts:44` = `/^(\d{4,})_([a-z0-9_]+)\.sql$/` |
| 默认目录 == 运行器默认目录 | 两边 `realpathSync` 后比对（单测） | 同一处（`migrate.ts:42` 的 `fileURLToPath(new URL('../../db/migrations/', import.meta.url))`） |
| 运行器仍会因撞号抛错 | 单测断言 `migrate.ts` 里仍有「迁移版本号重复」 | 在（`:72`） |
| 四件产物编码（2026-10-28 R68 注解化改造后复测；数字随改动漂移，此处为当轮读数） | 逐字节读：UTF-8 解码后 U+FFFD 计数、典型乱码字符（U+951B `锛` / U+9532 `鍜`）、BOM、CRLF | `tools/verify-migrations-unique.mjs`：954 行 / 47425 字节 / 无 BOM / 0 个 U+FFFD / 0 个乱码字符 / CRLF 0；`tests/unit/verify-migrations-unique.test.mjs`：604 行 / 27966 字节 / 同 0；`.github/workflows/migrations-guard.yml`：93 行 / 7289 字节 / 同 0；本页：UTF-8 / 无 BOM / 0 个 U+FFFD / CRLF 0（**行数与字节数不复报** —— 本页一改它们就过期，留一个必然过期的数字等于给下一个人埋假锚点；本页的 2 处「典型乱码字符」是 §6 表格里**刻意引用**的 `锛`/`鍜` 样本，不是文件损坏） |
| 非 ASCII 首字样本 | 解码后取首个非 ASCII 片段 | `·迁移编号唯一门禁——纯`（与 `renderReport()` 的标题行一致） |

关于**交接时「该文件是 GBK/UTF-8 互转错的乱码」这一说法**：接手时实测该文件已是合法 UTF-8 —— 逐字节读 + 全文中文注释语义连贯，**没有可修补的乱码字节**，故本片按「复核设计意图 + 全量真跑」处置，没有做逐字节修补（也没有做无谓的重写：真跑与 28 条单测已把判据钉住）。

⚠ 本轮改造里有一次**真实的编码事故**值得记下（已修好）：用 PowerShell `Set-Content` 改 `tests/unit/verify-migrations-unique.test.mjs` 时，行尾被从 LF 变成 CRLF，`git diff --numstat` 从 19/15 暴涨到 405/401 —— 整个文件被当成「全改」。处置：改用 `[System.IO.File]::WriteAllText($p, $t.Replace("\`r\`n","\`n"))` 归一化回 LF，此后改这些文件一律用编辑器/`edit` 工具，不再走 `Set-Content`。这就是上面那条「`Get-Content`/`Set-Content` 往返会写坏文件」的第二个实例（这次坏的是行尾，不是字符）。

乱码的成因在本机可复现，值得记一笔：**Windows PowerShell 5.1 的 `Get-Content` / `Set-Content` 默认按系统 ANSI 代码页（zh-CN = GBK/936）解码**。用 `Get-Content -Raw package.json` 读一个**干净的 UTF-8** 文件，得到的正是 `鑰曚簯锛?…` 这类 mojibake；把它再 `Set-Content` 回去就会写坏文件。本片所有中文产物都用 UTF-8 写入工具落盘，未走 `Get-Content`/`Set-Content` 往返。

## 7 刻意不做 / 未取得

**刻意不做（不冒充能力）**

- 不执行任何 `.sql`、不判断迁移能否跑通（真执行由 `tests/integration/*-pg.mjs` 与 `real-pg-integration.yml` 覆盖，本片不碰）；
- 不判断 down 与 up 语义互逆（配对口径在 `tests/unit/migrations-rollback-pairing.test.mjs`，本片只查**存在 + 同名**）；
- **不查跨分支预留号**：`#434` 的 `0028` 不在本分支目录里，静态扫不到。本门禁的价值是「两条同号一旦进了**同一个目录**就立刻红」，而不是「查谁能占下一个号」——后者需要读全部远端分支，与本片「纯静态、不联网」的前提冲突；
- 编号**缺号默认只 `WARN`、不判红**（`--strict` 才升为 1；要豁免得在迁移目录的 `*.md` 里写「故意跳过」依据 —— 理由见 §3 / §4b）；
- ⛔ 不改任何既有的迁移/回滚文件名（本轮收窄改造只动守卫、单测、workflow、本页；迁移目录 `0001..0027` 与 `rollback/` 26 份 down 文件名**零改动**，`git status --porcelain services/api/db/migrations` 全程零输出）；⛔ 不删既有断言：`git diff` 里 34 条「被删行」全是**改名与改期望**（`assertFailureIds` → `assertIssueIds`，匹配面从 `FAIL[...]` 扩到 `FAIL|WARN[...]`；软档 `assert.equal(status, 1)` → `0` 并**新增** `--strict` 下的 `1`），没有一条判据被摘掉，也没有一个夹具被删。
- 不接管、不修改 `real-pg-integration.yml` 与任何真库链（那是最热冲突面，且资源模型与静态门禁无关）。

**未取得项**

- 本页写作时 PR 尚未创建，**GitHub Actions 的 `migrations-guard` / `migrations-unique` 结果尚未回填**；CI 结果以 PR 页上的 check 为准，若与 §3/§5 的本地读数不一致，以 CI 为准并回填本页。
- 未在真库上复现「两条 `0028_*` ⇒ 运行器抛错」的运行时红：本片交付的是**静态**门禁，运行时那一层的既有证据在真库链与 `services/api/src/db/migrate.ts` 的既有单测里；负控制把两条 `0028_*` 造在**临时拷贝目录**里，不碰真实迁移目录。
- i18 片的 `0028_admin_scope_authority.sql` 抢救件仍未并回 `services/api/db/migrations/`；它一旦并入，本门禁会与 `#434` 的 `0028_governance_audit_log.sql` **正面撞号** —— 那正是本片要提前暴露的形态，处置（改号 / 合并）不在本片范围。

## 7b 软档告警的可见性：WARN ⇒ GitHub 注解（R68-D12 补，2026-10-28）

**缺陷**：软档 findings 原来只以 `WARN[...]` 纯文本打印 —— 既不失败、也不会出现在 PR 的 Annotations 面板，等于「告警」只对肯点开 job 日志的人存在。

**修法（选 a：注解化，不切 strict）**：判决步改为 `node tools/verify-migrations-unique.mjs --annotations`，工具新增导出 `renderAnnotations(result)`：软档项逐条打成 `::warning title=…::…`，回滚问题逐条、无依据缺号合并一条；`%` / CR / LF / 属性里的 `:` `,` 按 GitHub 注解语法转义。**退出码不变**（软档仍 `0`，`--strict` 的取舍一字未动）。

**为什么用显式开关而不是嗅 `GITHUB_ACTIONS`**：后者注入**整个 job**，连跑单测那一步也带着它，夹具产生的软档 WARN 会混进单测 stdout。实测（2026-10-28）：只在**同时**去掉工具侧 `!json` 门时 `--json` 契约才真被破坏（`tests/unit/ci-migrations-guard-annotations.test.mjs` 27 pass / 4 fail）；保留 `!json` 门时 30 pass / 1 fail。故「显式开关」+「`--json` 优先吞掉注解」两件都要。

**机器可验证的落点（三处，删任一处即红）**：
1. `.github/workflows/migrations-guard.yml` 判决步的 `run:` 必须含 `--annotations`、不含 `--strict`（`tests/unit/ci-migrations-guard-annotations.test.mjs` 直接读该文件）；
2. `renderAnnotations()` 的注解条数 = 回滚问题数 +（有无依据缺号 ? 1 : 0），并验 `%0A` / `%25` 转义；
3. `--json --annotations` 的 stdout 仍可 `JSON.parse`（与不加开关逐字节相同）。

**今天真仓 0 条注解**（`--annotations` 实测 EXIT=0、软档 0 项 ⇒ 通道空转），注解**形态**由上面第 2/3 条夹具（`0100`/`0102` 两条缺依据的临时夹具）守住 —— 也就是说：真实仓此刻没有可注解的东西，但「有东西时会真的变成注解」这句话是被测住的，不是靠肉眼。

## 8 复现

```bash
node tools/verify-migrations-unique.mjs                                  # 当前仓：期望 exit 0
node tools/verify-migrations-unique.mjs --json                           # 机读：stdout 是纯 JSON，期望 exitCode 0 / duplicates []
node --test tests/unit/verify-migrations-unique.test.mjs                 # 期望 28 pass / 0 fail
node tools/verify-migrations-unique.mjs --dir <任意临时目录>             # 负控制：不受本仓 NO_ROLLBACK 牵连
node tools/verify-migrations-unique.mjs --dir <含两条 0028_* 的目录>    # 撞号负控制：期望 exit 1、duplicates 列出两条文件
node tools/verify-migrations-unique.mjs --strict                         # 更严口径：coexist / rollback / 未登记缺号也判红
node tools/verify-migrations-unique.mjs --help                          # exit 0
```

CI：`.github/workflows/migrations-guard.yml` 的三个 step 就是「判据本体（非 strict）→ `--json` 快照（只留档）→ 门禁自身单测」，job 名 `migrations-unique`，`on: pull_request` + `push: [main]`，`permissions: contents: read`，无 `paths:` 过滤、无 `continue-on-error`、无 `|| true`、不跑 `npm ci`（只用 `node:` 内建模块，check 不会被 lockfile 漂移或 registry 抖动弄红/弄绿）；不引入第三方 action（`--json` 快照直接打进 job 日志，不传 artifact —— 少一个会自己漂的版本面）。

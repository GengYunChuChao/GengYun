# R30 · 迁移编号唯一门禁（2026-10-22）

本片只做一件事：给 `services/api/db/migrations/NNNN_*.sql` 的**全局唯一命名空间**补一层**静态**门禁。不连库、不执行任何 `.sql`、不写任何文件、不联网、无第三方依赖。

- 仓库 `GengYunChuChao/GengYun`，分支 `feat/gy-r30-migration-guard`，基线 `d4d48088532377adb54c278b24ba90be42cb5aaf`，工作树 `E:\GengYunCommander\wt-r30-migration-guard`。
- 交付物：`tools/verify-migrations-unique.mjs`（判据本体）、`tests/unit/verify-migrations-unique.test.mjs`（单测 · 22 条）、`.github/workflows/migrations-guard.yml`（每个 PR 跑一次）、本页证据。
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

| 判据 | 触发条件 | 现实对应 | 实现位置 |
| --- | --- | --- | --- |
| `[surface]` | 顶层 `.sql` 必须合 `^\d{4}_.*\.sql$`，且**至少 1 条**；顶层出现 `.down.sql` 判红；后缀不是小写 `.sql`、或 `.sql` 条目不是常规文件，同样判红 | 「扫到 0 条 ⇒ 全绿」是门禁最经典的假绿；`.down.sql` 放在顶层既不是正向迁移、也永远不会被当回滚执行 | `tools/verify-migrations-unique.mjs:248-312` |
| `[runner]` | 守卫扫描集合 ≠ **产品发现器**扫描集合 ⇒ 红并点名差集 | 正则逐字抄 `services/api/src/db/migrate.ts:44`（常量 `RUNNER_PATTERN_SOURCE`，`tools/verify-migrations-unique.mjs:76`）。两侧数量不一致时「守卫绿」没有意义 | `tools/verify-migrations-unique.mjs:314-339` |
| `[dup]` | 同一 4 位号被**两个及以上正向文件**占用 | §1 的真实形态。点名两个文件 + 运行时会抛的原话 + 下一个可用号 | `tools/verify-migrations-unique.mjs:341-381` |
| `[coexist]` | `rollback/` 只收 `<NNNN>_<name>.down.sql`；往 `rollback/` 放正向形态、或给同一号补第二份 `.down.sql`，判红 | 这是把「第二条同号迁移」藏起来的两种典型形态：放进去的文件既不会被当回滚执行，也不会被运行器发现 | `tools/verify-migrations-unique.mjs:383-439` |
| `[rollback]` | 每条正向迁移要么有 `rollback/<同名>.down.sql`，要么在内置 `NO_ROLLBACK` 清单里（每条理由 ≥ 20 字）；孤儿回滚、同号 down 与正向名不一致、**登记过期**（已有 down / 迁移已不存在 / 理由占位）均判红 | 例外必须可核证、会过期，不能变成永久通行证 | `tools/verify-migrations-unique.mjs:441-519` |

退出码：`0` = 全部满足，`1` = 有任一判据不满足，`2` = 用法错误（`--dir` 缺值、未知参数）。命令行入口 `tools/verify-migrations-unique.mjs:589-616`，被 `import` 时无副作用（`:619-631`）。

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
[读数]     编号连续性：0001..0027 连续（仅信息，不判红：跨 PR 乱序合并时缺号是正常态）
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

**退出码 `0`。**（原文照贴；`[读数]` 的缺号行只报读数、不判红 —— 跨 PR 乱序合并时 `0028` 在 `#434`、`0029` 在别的片是正常态，判红会在 main 上误伤无关的人。）

## 4 负控制：造两条 `0099_*` ⇒ exit 1

在真实目录里临时造 `0099_dup_a.sql` / `0099_dup_b.sql`（内容各一行 `SELECT 1;` / `SELECT 2;`，**造完立即删除、未提交**），重跑同一命令：

```text
迁移编号唯一门禁（R30 · 纯静态）· 目录 E:\GengYunCommander\wt-r30-migration-guard\services\api\db\migrations
[surface]  顶层 .sql 29 条：合 ^\d{4}_.*\.sql$ 的正向迁移 29 条 / 不合规 0 条 / 顶层 .down.sql 0 条
[runner]   守卫 29 条 ↔ 产品发现器 29 条：差集 0 条
[dup]      29 条正向迁移占用 28 个编号（0001..0099）：同号多文件 1 处
[coexist]  rollback/ .sql 26 条：合 <NNNN>_<name>.down.sql 26 条 / 同号多份 0 处
[rollback] 已配对 26 条 / 允许缺省 1 条（0001） / 缺回滚 2 条 / 孤儿回滚 0 条
[读数]     编号连续性：缺 71 个：0028、0029、0030、0031、0032、0033、0034、0035 …（仅信息，不判红：跨 PR 乱序合并时缺号是正常态）
[逐条] 正向迁移 ↔ 回滚
  …（0001..0027 同 §3，此处略）
  0099_dup_a.sql  ✗ 缺回滚
  0099_dup_b.sql  ✗ 缺回滚
FAIL[dup] 同一 4 位号被两个及以上正向文件占用（1 个号）：
  · 0099：0099_dup_a.sql、0099_dup_b.sql
    ⇒ services/api/src/db/migrate.ts:72 会确定性抛「迁移版本号重复：0099 同时出现在 0099_dup_a.sql 与 0099_dup_b.sql」；两条分支的文件路径不同 ⇒ git 无文本冲突、GitHub 判 MERGEABLE，而 schema_migrations.version 是主键（migrate.ts:108）⇒ 只有真库会红。
    补救：后合的一方改号为下一个可用号（当前最大号 0099 ⇒ 空位 0100），并同步改 rollback/ 与证据页；⛔ 不要靠「合入顺序」当方案。
FAIL[rollback] 缺回滚且未登记为允许缺省（2 条）：0099_dup_a.sql、0099_dup_b.sql
  ⇒ 补救：同时新增 rollback/<同名>.down.sql；确属不可回滚的（如全库地板）才在 NO_ROLLBACK 登记，理由 ≥ 20 字并更新证据页。
FAIL：2 项不满足（dup、rollback）；退出码 1。
```

**退出码 `1`。** 这正是一条只加迁移文件的 PR 在**静态**阶段该看到的形态：git 侧干净，静态侧点名。`[rollback]` 同时报缺 down 是**预期**的（负控制故意不补 down；两者是不同判据，不是为了凑数）。

删除后复查：`node tools/verify-migrations-unique.mjs` 重新 `PASS` / exit 0；`git status --porcelain` 只剩本片新增的未跟踪文件（负控制当时为 3 个：判据本体、单测、workflow；本页落盘后为 4 个），迁移目录**零改动**。

## 5 单测：22 条全过

`node --test tests/unit/verify-migrations-unique.test.mjs`（Node v24.16.0，Windows）：

```text
ℹ tests 22
ℹ suites 0
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

夹具一律建在 `os.tmpdir()`、`after()` 删除，**不写** `services/api/db/migrations/`。覆盖：用法 0/1/2 三条；正常 / 重复号 / `rollback/` 形态错两种 / 发现器集合不等 / 空目录 / 顶层 `.down.sql` / 缺回滚 / 不合规命名 / 目录不存在 / `rollback/` 缺失 / 孤儿回滚；真实仓绿 + 口径同源（正则逐字一致、默认目录同一处）；`NO_ROLLBACK` 生效 / 过期 / 理由占位三条。

`npm run test:unit` 的 glob 是 `"tests/unit/*.test.mjs"`（`package.json`），本文件因此在既有 `engineering-shell.yml` 的 unit-tests job 里也会跑一次，不需要改任何既有 workflow。

## 6 口径同源与编码核验

| 项 | 方法 | 读数 |
| --- | --- | --- |
| 守卫抄的正则 == 产品发现器 | 单测读 `services/api/src/db/migrate.ts` 原文，正则体与 `RUNNER_PATTERN_SOURCE` **逐字**比对 | 一致；`migrate.ts:44` = `/^(\d{4,})_([a-z0-9_]+)\.sql$/` |
| 默认目录 == 运行器默认目录 | 两边 `realpathSync` 后比对（单测） | 同一处（`migrate.ts:42` 的 `fileURLToPath(new URL('../../db/migrations/', import.meta.url))`） |
| 运行器仍会因撞号抛错 | 单测断言 `migrate.ts` 里仍有「迁移版本号重复」 | 在（`:72`） |
| `tools/verify-migrations-unique.mjs` 编码 | 逐字节读：UTF-8 解码后 U+FFFD 计数、典型乱码字符（U+951B `锛` / U+9532 `鍜`）、BOM | 0 个 U+FFFD、0 个典型乱码字符、无 BOM；非 ASCII 首字样本 `·迁移编号唯一门禁——纯` |

关于**交接时「该文件是 GBK/UTF-8 互转错的乱码」这一说法**：接手时实测该文件已是合法 UTF-8 —— 逐字节读 + 全文 631 行中文注释语义连贯，**没有可修补的乱码字节**，故本片按「复核设计意图 + 全量真跑」处置，没有做逐字节修补（也没有做无谓的重写：真跑与 22 条单测已把判据钉住）。

乱码的成因在本机可复现，值得记一笔：**Windows PowerShell 5.1 的 `Get-Content` / `Set-Content` 默认按系统 ANSI 代码页（zh-CN = GBK/936）解码**。用 `Get-Content -Raw package.json` 读一个**干净的 UTF-8** 文件，得到的正是 `鑰曚簯锛?…` 这类 mojibake；把它再 `Set-Content` 回去就会写坏文件。本片所有中文产物都用 UTF-8 写入工具落盘，未走 `Get-Content`/`Set-Content` 往返。

## 7 刻意不做 / 未取得

**刻意不做（不冒充能力）**

- 不执行任何 `.sql`、不判断迁移能否跑通（真执行由 `tests/integration/*-pg.mjs` 与 `real-pg-integration.yml` 覆盖，本片不碰）；
- 不判断 down 与 up 语义互逆（配对口径在 `tests/unit/migrations-rollback-pairing.test.mjs`，本片只查**存在 + 同名**）；
- **不查跨分支预留号**：`#434` 的 `0028` 不在本分支目录里，静态扫不到。本门禁的价值是「两条同号一旦进了**同一个目录**就立刻红」，而不是「查谁能占下一个号」——后者需要读全部远端分支，与本片「纯静态、不联网」的前提冲突；
- 编号**缺号只报读数、不判红**（理由见 §3）；
- 不接管、不修改 `real-pg-integration.yml` 与任何真库链（那是最热冲突面，且资源模型与静态门禁无关）。

**未取得项**

- 本页写作时 PR 尚未创建，**GitHub Actions 的 `migrations-guard` / `migrations-unique` 结果尚未回填**；CI 结果以 PR 页上的 check 为准，若与 §3/§5 的本地读数不一致，以 CI 为准并回填本页。
- 未在真库上复现「两条 `0028_*` ⇒ 运行器抛错」的运行时红：本片交付的是**静态**门禁，运行时那一层的既有证据在真库链与 `services/api/src/db/migrate.ts` 的既有单测里；且负控制刻意只用假号 `0099`，不碰真实迁移目录。
- i18 片的 `0028_admin_scope_authority.sql` 抢救件仍未并回 `services/api/db/migrations/`；它一旦并入，本门禁会与 `#434` 的 `0028_governance_audit_log.sql` **正面撞号** —— 那正是本片要提前暴露的形态，处置（改号 / 合并）不在本片范围。

## 8 复现

```bash
node tools/verify-migrations-unique.mjs                                  # 当前仓：期望 exit 0
node --test tests/unit/verify-migrations-unique.test.mjs                 # 期望 22 pass / 0 fail
node tools/verify-migrations-unique.mjs --dir <任意临时目录>             # 负控制：不受本仓 NO_ROLLBACK 牵连
node tools/verify-migrations-unique.mjs --help                          # exit 0
```

CI：`.github/workflows/migrations-guard.yml` 的两个 step 就是上面前两条，job 名 `migrations-unique`，`on: pull_request` + `push: [main]`，无 `paths:` 过滤、无 `continue-on-error`、无 `|| true`、不跑 `npm ci`（只用 `node:` 内建模块，check 不会被 lockfile 漂移或 registry 抖动弄红/弄绿）。

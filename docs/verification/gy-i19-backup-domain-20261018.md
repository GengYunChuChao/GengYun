# GY-I19 · 「备份副本清除」在仓内无落点的普查与边界收口（Refs #19）

> **本记录不关闭整项 #19，也不宣称任何「备份清除」能力已就位。**
> 它只回答一个问题：#19 剩下的「备份副本清除」**在本仓内有没有可被真实清除的对象**。
> 答案是**没有**：仓里既没有逐用户备份副本的持久域，也没有任何真实备份系统接线；
> 唯一的备份产物是运维侧**整库** `pg_dump -Fc` 文件，**不具备逐用户删除语义**。
> 因此本片**不接线、不新增备份域、不占迁移号**，只把「无落点」做成可复核证据，
> 并把「未接线」的含义在契约状态、边界文档与代码注释里写准。
> 下面每条判读都附命令与原始输出；**没跑过的一个字都不写通过**。
>
> **时点限定（GY-R28 补记，2026-10-20）**：以上「仓里既没有逐用户备份副本的持久域」「没有可被真实清除的对象」
> 是**本记录落笔时（2026-10-18，普查范围 `0001`–`0018`）的结论**，作为历史事实原样保留。
> 其后 `services/api/db/migrations/0023_user_backup_copies.sql`（建 `public.user_backup_copies`）与
> `services/api/src/privacy/backup-copies-pg.ts`（`createPostgresBackupPurgePort()`，`kind: 'wired'`／`available: true`）
> 已落地，并由 `services/api/src/app.ts:1457-1464` 在「受理端口已接线 ＋ 有真库连接池」时装配
> ⇒ **GY-R28 起本仓已有逐用户备份副本域**（口径与落地形状见
> [设计稿 §13](../architecture/gy-i19-user-backup-copies-design.md)）。但这**不是**「#19 已完成」：
> 7 日在线／30 日备份的**到期执行与调度**、恢复清单重放、第三方删除证据仍未取得，`real` 模式整域仍 503
> `PROVIDER_UNAVAILABLE`，`docs/architecture/contract-status.json` 的 GY-I19 `blocker` 未改。

## 0 结论（一句话）

**「备份副本」这个被清对象在仓内不存在**：`services/api/db/migrations/` 0001–0018（18 个文件）里没有任何备份／快照／副本实体，
也没有软删列（`deleted_at/is_deleted/purged` 唯一命中是 `0018_favorites_history.sql:36` 的一句注释
「两个域都是**物理删除**（无 `deleted_at` 软删）」，真实软删列仍为 **0**）；应用侧 `backup-replay-manifest.ts`、`deletion-aging.ts`
都自述**不接真实备份**，`media/object-store.ts` 的 S3 兼容实现**产品装配路径仓内从未被调用**（R27-S8 只在测试的进程内 `fetch` 替身下跑通全路径，未对接真实桶）；
唯一备份产物是 `deploy/postgres-cvm/backup-postgres.sh` 产出的**整库** `pg_dump -Fc`，其 30 天是**备份文件保留期**，
不能删单用户。⇒ **逐用户备份清除不是接线遗漏，而是需要新增备份域**（产品决策）。
在决策与域落地之前，`backup_state` 只能如实停在 `pending`、完成判定 `blocked`；
把「没有副本可删」的空集当成清除成功，比现在更糟。

## 1 基本信息

| 项 | 值 |
| --- | --- |
| 分支 / 工作树 | `feat/gy-i19-backup-purge` / `E:\GengYunCommander\.pg17\wt-i19-backup-purge` |
| 基线提交 | `8205cfc8b8f32b8a7f44a28e53b1234bac5cc6c9`（`upstream/main`；本页初版基于 `53922ebdaae0c91da40a81fc56e76498a13756bd`，上游前进后已 rebase 并按新基线重算全部数字，差异见 §8） |
| 本片改动 | 新增本页；`docs/architecture/contract-status.json` 的 GY-I19 `blocker` 文案精确化；`docs/architecture/state-contract.md` 增**边界说明**；`services/api/src/privacy/user-data-deletion.ts`、`services/api/src/privacy/account-deletion.ts` **只改注释／文档字符串** |
| 运行行为 | **零改动**：`BackupPurgePort` 默认仍是 `unwired`/`available:false`，`backup_state` 仍如实 `pending` |
| 契约 | `packages/contracts/**` **零改动**（枚举／字段／operation 一个不动） |
| 迁移 | **零新增**，未占迁移号 |
| 既有测试断言 | **零改动**（「未接线 ⇒ pending」原样保留，未删未放宽；见 §6.4） |
| 装依赖 | `npm ci --offline --ignore-scripts`（任务书原写 `pnpm install --frozen-lockfile`，但本仓**没有 `pnpm-lock.yaml`**，实为 npm workspaces；见 §6.1） |

## 2 可复核普查

### 2.1 迁移里没有备份副本实体

```powershell
# 工作树根目录（R28 订正口径：schema 前缀不写死成 public，只普查 0001–0018）
Get-ChildItem "services\api\db\migrations\*.sql" |
  Where-Object { $_.Name -match '^00(0[1-9]|1[0-8])_' } |
  Select-String -Pattern "CREATE TABLE (IF NOT EXISTS )?(([a-z_]+)\.)?(\w+)" |
  ForEach-Object {
    $g = $_.Matches[0].Groups
    if ($g[3].Success) { "$($g[3].Value).$($g[4].Value)" } else { "public.$($g[4].Value)" }
  } | Sort-Object -Unique
```

输出（**18 个迁移文件、54 处 `CREATE TABLE`、按 `schema.table` 限定名去重 54 张表**；`public.` 前缀原样保留）：

```
catalog_ops.operations, knowledge_staging.workbook_batches, knowledge_staging.workbook_rows,
public.admin_accounts, public.admin_audit_events, public.admin_scopes, public.admin_sessions,
public.applicability, public.author_links, public.catalog_import_conflicts, public.catalog_import_runs,
public.catalog_source_update_events, public.community_media_grants, public.consent_policies,
public.consent_records, public.content_media_refs, public.conversation_answers,
public.conversation_turns, public.conversations, public.crops, public.deletion_handlers,
public.deletion_requests, public.export_writebacks, public.exports, public.favorites,
public.favorites_idempotency, public.formulations, public.history, public.history_idempotency,
public.idempotency_keys, public.jobs, public.knowledge_dataset_config, public.knowledge_dataset_modes,
public.knowledge_versions, public.media, public.media_derivatives, public.post_versions, public.posts,
public.privacy_epochs, public.public_authors, public.recipients, public.regions, public.registrations,
public.restriction_rules, public.sessions, public.single_profiles, public.source_versions,
public.sources, public.species, public.third_party_deletions, public.user_training_consents,
public.users, staging_intake.batches, staging_intake.operations
```

**口径订正（R28，2026-10-20）**：本页初版记的是「54 处 / 去重 **52** 张」——那是**口径错**，不是事实变了：
初版正则是 `CREATE TABLE (IF NOT EXISTS )?(public\.)?(\w+)`，只认 `public.` 一个前缀，于是
`knowledge_staging.`、`staging_intake.`、`catalog_ops.` 的 **schema 名**被当成**表名**捕获
（`knowledge_staging`、`staging_intake` 因此各重复出现 2 次而被去重抹平 2 张）；若不带 schema 只按裸表名去重，
`catalog_ops.operations` 与 `staging_intake.operations` 又会并成 1 张（53 张）——所以「52」在任何正确口径下都不成立。
按 `schema.table` 限定名去重后**没有一处重复建表**，处数与张数相等 ⇒ 正确读数是 **54 / 54**。
分 schema：`public` 49、`knowledge_staging` 2、`staging_intake` 2、`catalog_ops` 1。
按文件：`0001`:20、`0002`:10、`0003`:8、`0004`:2、`0005`:0、`0006`:1、`0007`:2、`0008`:1、`0009`:1、`0010`:0、
`0011`:1、`0012`:0、`0013`:3、`0014`:0、`0015`:0、`0016`:0、`0017`:1、`0018`:4。
相对初版基线 `53922eb`（那时只有 `0001`–`0017`：**50 处 / 50 张**，旧口径误记为 48 张），
上游 #272 的 `0018_favorites_history.sql` 新增
`favorites`、`favorites_idempotency`、`history`、`history_idempotency` 4 处/4 张。

判读：**54 张表里没有任何 `backup*` / `snapshot*` / `replica*` / `wal*` / `dump*` 表**（这个否命题与口径无关：
处数在两种口径下都是 54，备份/快照/副本/转储实体都是 **0** 张）。
新增的 `favorites`／`history`／`favorites_idempotency`／`history_idempotency` 是收藏与历史正文和本域幂等台账，
`0018_favorites_history.sql:36` 自述「删除语义：两个域都是**物理删除**（无 `deleted_at` 软删）」——仍不是备份副本。
`knowledge_staging`、`staging_intake` 是知识导入暂存域，与备份无关。

### 2.2 迁移里也没有软删记录域

```powershell
Select-String -Path "services\api\db\migrations\*.sql" -Pattern "deleted_at|is_deleted|purged|deleted_by|soft_delete"
```

输出（**1 行，且是注释不是列**）：

```
命中数: 1
0018_favorites_history.sql:36: -- 删除语义：两个域都是**物理删除**（无 `deleted_at` 软删）。
```

判读：全仓**没有**「行还在、标记已删」的软删列（唯一命中是 `0018` 里自述「物理删除、没有软删」的注释，
不是 DDL 列）⇒ 即使想做「先打标、后异步真删」，也没有承载「某用户的副本已标记待清」的持久记录。
备份副本既无实体、也无墓碑。

### 2.3 迁移里的 `backup` 命中全是状态轴，不是副本实体

```powershell
Select-String -Path "services\api\db\migrations\*.sql" -Pattern "create table[^;]*backup|backup_|deleted_at|is_deleted|purged"
```

输出（**15 行**；其中 `0003_privacy_consent.sql` 8 行、`0016_account_deletion_persistence.sql` 6 行是 `backup_` 状态列，
`0018_favorites_history.sql:36` 1 行是把上一条软删模式也纳进命令后命中的注释。只按 `backup_` 统计则为 **14 行**，逐行如下）：

```
0003_privacy_consent.sql:62: retention_backup_days  integer NOT NULL DEFAULT 0
0003_privacy_consent.sql:63: CHECK (retention_backup_days BETWEEN 0 AND 30),
0003_privacy_consent.sql:153: backup_due_at   timestamptz NOT NULL,   -- 受理 + 30×24 小时
0003_privacy_consent.sql:160: CHECK (online_due_at >= requested_at AND backup_due_at >= online_due_at)
0003_privacy_consent.sql:174: backup_state      handler_state NOT NULL DEFAULT 'pending',
0003_privacy_consent.sql:190: backup_status   third_party_state NOT NULL DEFAULT 'not_requested',
0003_privacy_consent.sql:199: (backup_status <> 'confirmed' OR (confirmed_at IS NOT NULL AND evidence_ref IS NOT NULL))
0003_privacy_consent.sql:205: (backup_status NOT IN ('requested', 'confirmed', 'failed') OR requested_at IS NOT NULL)
0016_account_deletion_persistence.sql:75: p_backup_due_at timestamptz,
0016_account_deletion_persistence.sql:96: OR p_requested_at IS NULL OR p_online_due_at IS NULL OR p_backup_due_at IS NULL
0016_account_deletion_persistence.sql:101: OR p_backup_due_at < p_online_due_at
0016_account_deletion_persistence.sql:140: online_due_at, backup_due_at, revision, receipt_issued_at, receipt_expires_at
0016_account_deletion_persistence.sql:143: p_online_due_at, p_backup_due_at, 1, p_receipt_issued_at, p_receipt_expires_at
0016_account_deletion_persistence.sql:161: 'backup_due_at', to_char(x_request.backup_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
0018_favorites_history.sql:36: -- 删除语义：两个域都是**物理删除**（无 `deleted_at` 软删）。
```

判读：这 15 行里 14 行是**状态列／期限列**（`retention_backup_days`、`backup_due_at`、`backup_state`、`backup_status`），
第 15 行是 `0018` 的注释；没有一行是「副本在哪、几号副本、副本水位」这类实体信息。

### 2.4 0003 的四张表只承载状态轴

| 表 | 与备份相关的列 | 它记录的是 | 它不是 |
| --- | --- | --- | --- |
| `recipients` | `retention_backup_days 0–30` | 接收方**保留期政策**（+30×24h 截止的来源） | 副本清单 |
| `deletion_requests` | `backup_due_at`（CHECK ≥ `online_due_at`） | 单请求的备份**期限** | 副本位置 |
| `deletion_handlers` | `backup_state handler_state DEFAULT 'pending'` | 每模块备份清除的**进度** | 副本本身 |
| `third_party_deletions` | `backup_status third_party_state` | **第三方**（供应商）副本的进度 | 仓内备份副本 |

判读：四处都是「进度／期限」，缺了它们要清的**对象**。也就是说，即使现在把 `backup_state` 改成
`completed`，也没有任何一条语句能指出「删掉了什么」。

### 2.5 仓内唯一真实备份产物是整库 dump，逐用户不可删

`deploy/postgres-cvm/backup-postgres.sh`（逐行原文）：

| 行 | 原文 |
| --- | --- |
| `:3` | 逻辑备份（pg_dump -Fc）+ 保留期 + 产出清单 |
| `:23-24` | 保留 30 天只是「备份文件保留期」。需求中「注销后备份 30 日内清理个人数据」是逐用户删除语义，本脚本**没有**实现，仍属未交付项 |
| `:56` | `BACKUP_DIR="${GENGYUN_BACKUP_DIR:-/data/gengyun/backup}"` |
| `:57` | `KEEP_DAYS="${GENGYUN_BACKUP_KEEP_DAYS:-30}"` |
| `:145` | `find … -name "${FILE_PREFIX}*.dump" -mtime "+${KEEP_DAYS}" -print` |
| `:188-193` | `runuser` 下执行 `pg_dump`；**空文件视为失败**（不把空产物当成功） |
| `:205` | `format=pg_dump-custom-v1` |

仓内四处文档**自认**这件事（原文）：

| 位置 | 原文 |
| --- | --- |
| `deploy/postgres-cvm/README.md:459-460` | 备份不实现「注销后备份 30 日内清理个人数据」。`backup-postgres.sh` 的 30 天只是备份文件保留期…后者属未交付项 |
| `deploy/postgres-cvm/runbook.md:540` | U9 \| 确认「注销后备份 30 日内清理个人数据」如何验收（逐用户删除，本交付未实现） \| 需求实现决策 |
| `deploy/postgres-cvm/verify-checklist.md:211` | 5. 「注销后在线 7 日／备份 30 日内清理个人数据」：逐用户删除语义，未实现、未验收 |
| `deploy/postgres-cvm/roles-and-migration.md:256-257` | 需求 F13/AC23 的「注销后在线 7 日／备份 30 日内清理个人数据」是**逐用户删除语义**，`backup-postgres.sh` 的 30 天只是备份文件保留期，**两者不是同一件事**，后者属未交付项 |

判读：dump 是**整库自包含归档**，删掉一个用户的副本只能删掉整个 dump（等于删掉**所有**用户的备份）；
`restore-drill.sh` 证明的是「备份可恢复」，与「逐用户清除」无关。

### 2.6 应用侧「备份」全是纯函数／替身，没有真实接线

| 位置 | 自述原文 | 含义 |
| --- | --- | --- |
| `services/api/src/privacy/backup-replay-manifest.ts:70-73` | 不接任何真实备份系统、不接任何真实第三方：`real` 未接真实依赖一律 fail-closed…测试里的「备份快照」与「目标存储」都是替身 | 恢复清单是**清单投影**，不是备份存储 |
| `services/api/src/privacy/deletion-aging.ts:6` | 只计算、不执行：不碰对象存储、不碰备份 | 到期判定是纯函数 |
| `services/api/src/privacy/deletion-aging.ts:53` | 备份清除端口仍属后续切片 | 本片未接 |
| `services/api/src/media/object-store.ts:24` | `createS3CompatibleObjectStore`／`presignS3Url` **产品装配路径从未被实际调用**（R27-S8 已在测试的进程内 `fetch` 替身下跑通全路径并独立复算签名） | 无真实对象存储 |
| `services/api/src/media/object-store.ts:318,364` | 同上（未对接任何真实桶、未做真实签名往返核验） | 对象存储三态 `substitute`/`s3_compatible`/`unwired` |

判读：`media` 的对象存储只是**在线媒体**的替身域，没有版本／快照语义；
`backup-replay-manifest.ts` 的「备份」是**恢复重放清单的输入形状**，不是可删的副本。

### 2.7 接线缝本身是齐的 —— 所以这**不是**「忘了接线」

| 位置 | 现状 |
| --- | --- |
| `services/api/src/privacy/user-data-deletion.ts:91-95` | `export interface BackupPurgePort { kind: 'wired'\|'unwired'; available: boolean; purge(input): Promise<{purged, evidenceRef?}> }`（`createUnwiredBackupPurgePort()` 在 `:97`，默认 `available:false`） |
| `services/api/src/privacy/user-data-deletion.ts:253-276` | `backupState` 默认 `'pending'`；`if (backupPurge.available)` 且 `purged===true` 且证据非空 ⇒ 才 `'completed'` 并追加 `:backup-purged:` 证据 |
| `services/api/src/app.ts:451` | `userDataDeletionInjection?: { backupPurge?: BackupPurgePort; requests?: DeletionRequestStore \| null }` |
| `services/api/src/app.ts:1305-1307` | 仅在显式注入时把 `backupPurge` 传进 `userDataDeletion`（`...backupPurge === undefined ? {} : { backupPurge }`） |
| `tests/unit/user-data-deletion.test.mjs:108-137` | 已有「接线备份清除端口后…即可判完成」的**替身**用例 |
| `tests/unit/user-data-deletion.test.mjs:88`、`tests/unit/account-deletion-receipts.test.mjs:128`、`tests/integration/account-deletion-http.mjs:281` | 断言「未接线 ⇒ 如实 pending」（本片**未动**） |

判读：协议侧（端口形状、证据要求、注入点、失败折叠）已就位并有替身用例覆盖；
**缺的是真实被清对象**。所以本片只补「对象不存在」的证据，不补一个假端口。

## 3 三条捷径都被否（含理由）

| 捷径 | 为什么不行 |
| --- | --- |
| **新建一张备份副本登记表，立即接线** | 没有任何流程往里写 ⇒ 端口只能恒返回「空集已清 ⇒ `purged:true`」。这正是「把空集当成功」：`tests/privacy/deletion-modules.test.mjs:32` 的既有用例名逐字写着「必需模块闭集校验：空集/重复/超限/非法名一律拒绝（**空集无法证明"全模块"**）」。空登记表换来的 `completed` 是**伪证据**，比如实 `pending` 更糟。 |
| **拿 `exports.deletion_state` 当备份证据** | 它是 `third_party_state` 轴（供应商副本进度），而 `docs/architecture/state-contract.md:109` 明确把「**备份**」与「**供应商副本**」并列成两个不同对象。把第三方轴折叠成备份证据＝污染语义、把两条缺口并成一条假绿。 |
| **用脚本删掉整库 dump 文件** | 那会删掉**全部用户**的备份，等于用一个更大的合规事故换一个 `completed`；且与「逐用户删除」语义正相反。 |

## 4 仍未取得 / 需决策

1. **产品决策**：是否新增「逐用户备份副本域」（副本登记表 ＋ 副本生命周期 ＋ 可定位到用户的副本内容）；
   一旦决定，须先定迁移号（全局命名空间，本树不自行占号）、副本粒度（行级／用户级／时间点）与
   删除后的**可核证据**形状（谁删的、何时、删了哪一批、如何复核为空）。
2. **真实备份系统接线**：本仓没有任何备份系统客户端；`createS3CompatibleObjectStore` 未调用过，
   PITR／WAL 归档／快照均无实现（`deploy/postgres-cvm/` 只有 dump ＋ 保留期 ＋ 恢复演练）。
3. **7/30 日到期的真实执行**、**第三方完成证据**、**恢复清单重放**：与 #19 的其它未取得项一起仍开放。
4. 因此 **#19 不因本片关闭**；本片只把「备份副本清除」这一项的**阻塞原因**从「未接线」精确化为
   「**仓内无被清对象，需新增域**」。

## 5 本片改了什么（运行行为零改动）

| 文件 | 改动 |
| --- | --- |
| `docs/verification/gy-i19-backup-domain-20261018.md` | 新增本页（普查证据 ＋ 边界结论） |
| `docs/architecture/contract-status.json` | GY-I19 `requestAccountDeletion` 的 `blocker`：把「备份副本清除未接线」精确化为「未接线且仓内无被清对象（迁移无副本实体、运维备份是整库 dump）⇒ 需新增域（待决策）」；生成区未手改 |
| `docs/architecture/contract-implementation-status.md` | 由 `node tools/verify-contract-status.mjs --write-doc` 重写表格（机械同步，未手改） |
| `docs/architecture/state-contract.md` | 在备份段落之后**追加一段引用块边界说明**（只说事实与缺口，不改上文语义／枚举） |
| `services/api/src/privacy/user-data-deletion.ts` | 注释写明「未接线的真实原因是仓内无逐用户备份副本域」；`createUnwiredBackupPurgePort()` 的默认 `note` 文本同步（该参数现状为 `void note;`，**不参与任何行为**） |
| `services/api/src/privacy/account-deletion.ts` | 两处注释同上（硬边界 2 与「仍未实现」清单） |

## 6 门禁读数（命令 ＋ 原始输出）

### 6.1 依赖安装（任务书口径不成立，已报指挥改口径）

```text
> pnpm install --frozen-lockfile --offline
[ERR_PNPM_NO_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is absent
WARN  The "workspaces" field in package.json is not supported by pnpm. Create a "pnpm-workspace.yaml" file instead.
```

本仓是 **npm workspaces**（`package.json` 的 `"workspaces": ["services/api","apps/admin"]`，只有 `package-lock.json`）。
改用（本工作树内，未上传任何东西）：

```text
> npm ci --offline --ignore-scripts
added 103 packages, and audited 106 packages in 4s

found 0 vulnerabilities
```

> 说明：不带 `--ignore-scripts` 时 `npm ci --offline` 在 rebuild 阶段被沙箱拦下
> （`npm error code: 'EPERM'`、`npm error syscall: 'spawn'`），故加 `--ignore-scripts`；
> 本片不跑构建、只跑 node 测试，已合并的测试全部通过（§6.3–§6.5）。

### 6.2 契约状态（生成区机械同步 ＋ 复跑一致）

```text
> node tools/verify-contract-status.mjs --write-doc
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）
SYNC: 中文表格此前不是「中文表格一致」状态，已按 JSON 重写；本次重写不计入通过。
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

复跑（不加参数，确认表格与 JSON 一致）：

```text
> node tools/verify-contract-status.mjs
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

### 6.3 单元测试（替代口径 ＋ **同机基线对照**）

`npm run test:unit` 在本沙箱**跑不起来**：`node --test` 默认按文件起子进程，被沙箱拒（`spawn EPERM`）——
这是环境限制，与本片无关。按指挥批准的口径改为**同一组 glob、单进程**：

```powershell
$paths=@(); foreach($g in 'tests/unit','tests/privacy','tests/media','tests/reference','tests/moderation'){
  $paths += (Get-ChildItem -Path $g -Filter *.test.mjs -File | ForEach-Object { $_.FullName }) }
node --test --test-isolation=none $paths
```

**基线（`53922eb`）读数**——当时 191 个测试文件（返修后的当前 HEAD 是 196 个，见本节末注）：

```
ℹ tests 2548
ℹ suites 0
ℹ pass 2462
ℹ fail 85
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 106962.3765
```

**基线对照（同一台机器、同一命令、`git stash` 到干净 `53922eb` 后复跑，再 `git stash pop`）**：

```
ℹ tests 2548
ℹ pass 2462
ℹ fail 85
ℹ skipped 1
```

⇒ 改动前后**逐项同读数**（2548/2462/85/1）。这 85 条失败全部是**测试自身要 spawn 子进程**的用例
（如生成物 `--check` 门禁、`verify-contract-status` CLI 反例、研究记录 CLI 反例、迁移 SQL 工具等），
在本沙箱一律 `EPERM`；**与备份域、与本片改动无关**，且基线已同样失败（未引入新失败）。

**注（返修后补，审查 P2／P3 修正）**：上面 2548/2462/85/1 与「191 个测试文件」都是**基线（`53922eb`）读数**；
当前分支 HEAD（本提交）的 unit glob 测试文件数是 **196**（`tests/unit` 135＋`tests/privacy` 15＋`tests/media` 8＋
`tests/reference` 21＋`tests/moderation` 17；相对 53922eb 新增 5 个，全部来自 #256（2 个：`error-retryable-behavior`、
`error-retryable-static-guard`）／#272（2 个：`favorites-history-deletion-registration`、`favorites-history-store-pg`）／
#290（1 个：`release-materials-index-strict`）；#288／#289 未新增 `.test.mjs`，可由
`git log --diff-filter=A --name-only 53922eb..8205cfc -- 'tests/**/*.test.mjs'` 复核）。本轮返修**未重跑全量 unit**
（返修门禁只要求聚焦删除域＋集成，且本片 diff 不含任何可执行语句），故不把旧读数当作 HEAD 读数。

### 6.4 删除域聚焦用例（全部 pass，断言零放宽）

```powershell
node --test --test-isolation=none tests/unit/user-data-deletion.test.mjs tests/unit/account-deletion-receipts.test.mjs `
  tests/privacy/deletion.test.mjs tests/privacy/deletion-modules.test.mjs tests/privacy/contract.test.mjs tests/unit/conversation-deletion.test.mjs
```

```
ℹ tests 54
ℹ pass 54
ℹ fail 0
ℹ skipped 0
```

其中原样保留、本片**未改**的如实性断言（节选）：

```
✔ 必需模块闭集校验：空集/重复/超限/非法名一律拒绝（空集无法证明"全模块"）
✔ F13 注销清理：模块在启动时已注册、按主体真删、回执如实（备份未清 ⇒ 不谎称完成）
✔ F13：按主体清理，其它主体不受影响；在线证据非空，备份如实 pending（不谎称完成）
✔ F13：接线备份清除端口后，同一套协议即可判完成（缺口补上即通过）
✔ GY-I19：受理即驱动既有级联（在线真删、只删绑定主体），备份未接线如实 pending
✔ GY-I19：备份报称 purged 但缺证据 ⇒ 仍 pending；证据齐备才可能 completed
```

### 6.5 集成（注销 HTTP 全链）

```text
> node tests/integration/account-deletion-http.mjs
  - 级联：A 收藏 1→0 历史 1→0；B 收藏=1 历史=1（不受影响）
  - 回执鉴权：无凭据 401 SESSION_REQUIRED；用户会话令牌顶替 401 SESSION_EXPIRED；跨请求 401 SESSION_EXPIRED；id 非 uuid 400 INVALID_REQUEST
  - 不可达删除请求：404 NOT_FOUND（不是 200 空壳）
  - 幂等重放：同 id=ffb9f472-7e78-4088-98b3-05771dcce549，bearer 换发（旧 401 / 新 200），台账 liveCount=2
  - 同键异体（If-Match 进 hash）：409 IDEMPOTENCY_CONFLICT
  - 键域按主体隔离：B 用同一 Idempotency-Key 也各自受理（id=0f7911c1-f6b5-437f-ab4f-932a74eaa7e7）
  - real 模式：POST/GET 均 503 PROVIDER_UNAVAILABLE(retryable=false)，零状态变更
PASS GY-I19 account-deletion loopback HTTP integration (synthetic identities + memory stores + stub/real wiring arms)
```

### 6.6 文档门禁

`npm run test:docs` 在本沙箱**跑不起来**：`node tools/run-python.mjs` 以管道 spawn python 被拒——

```
无法运行 python：spawnSync python EPERM
```

改为**直接执行该 script 的两条命令**（等价替代，非放宽）：

```text
> python tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables

> node tools/verify-research-records.mjs
PASS 2026-10-18-contract-evidence-gate.md
PASS 2026-10-18-evaluation-readout-structured.md
PASS 2026-10-18-research-records-gate.md
PASS 2026-10-18-stack-reuse-decision.md
PASS gy-i03-label-evidence-increment-20261011.json（legacy 已钉住）
PASS gy-i03-label-evidence-increment-20261011.md（legacy 已钉住）
PASS gy-i03-public-label-index-20261011.json（legacy 已钉住）
PASS gy-i03-public-source-audit-20261011.md（legacy 已钉住）
研究记录校验：4 通过 / 0 失败 / 4 legacy 已钉住
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
```

（首跑时 `validate_development_docs.py` 报过 `ERROR: state-contract.md: missing link ../verification/gy-i19-backup-domain-20261018.md`——
本页当时还没落盘；落盘后复跑 exit 0。）

### 6.7 空白／换行

```text
> git diff --check
（无输出，exit 0）
```

### 6.8 rebase 到 `8205cfc` 之后复跑（数字全部重算，见 §8）

```text
> node tools/verify-contract-status.mjs --write-doc
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）
SYNC: 中文表格此前不是「中文表格一致」状态，已按 JSON 重写；本次重写不计入通过。
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。

> node tools/verify-contract-status.mjs
PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。

> node --test --test-isolation=none tests/unit/user-data-deletion.test.mjs tests/unit/account-deletion-receipts.test.mjs tests/privacy/deletion.test.mjs tests/privacy/deletion-modules.test.mjs tests/privacy/contract.test.mjs tests/unit/conversation-deletion.test.mjs
ℹ tests 54
ℹ pass 54
ℹ fail 0

> node tests/integration/account-deletion-http.mjs
  - 不可达删除请求：404 NOT_FOUND（不是 200 空壳）
  - 幂等重放：同 id=830c1e5a-40ce-4ede-9054-cbb6d090bc4a，bearer 换发（旧 401 / 新 200），台账 liveCount=2
  - 同键异体（If-Match 进 hash）：409 IDEMPOTENCY_CONFLICT
  - 键域按主体隔离：B 用同一 Idempotency-Key 也各自受理（id=6ef89e62-99f3-468c-a07a-e39d70862926）
  - real 模式：POST/GET 均 503 PROVIDER_UNAVAILABLE(retryable=false)，零状态变更
PASS GY-I19 account-deletion loopback HTTP integration (synthetic identities + memory stores + stub/real wiring arms)

> python tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables

> node tools/verify-research-records.mjs
研究记录校验：4 通过 / 0 失败 / 4 legacy 已钉住
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住

> git diff --check
（无输出，exit 0）
```

（§6.1–§6.7 的读数是初版基线 `53922eb` 上取得的；返修后上面这组在新基线 `8205cfc` 上复跑，
删除域聚焦仍是 54/54，集合与断言名未变。全量 unit 替代口径**本轮未重跑**（返修门禁只要求聚焦删除域＋集成，
且本片 diff 不含任何可执行语句：三处代码改动全是注释／文档字符串，`backup_state` 默认 `pending` 与
`if (backupPurge.available)` 判定逻辑一个字符未动）——§6.3 的 2548/2462/85/1 是初版基线读数，
那 85 条失败是沙箱 spawn 限制导致的，与本片无关。）

## 7 如何复查本页

```powershell
# 1 迁移里没有副本实体、没有软删列
Select-String -Path "services\api\db\migrations\*.sql" -Pattern "deleted_at|is_deleted|purged|deleted_by|soft_delete"
Select-String -Path "services\api\db\migrations\*.sql" -Pattern "backup"        # 只应命中 0003/0016 的状态列

# 2 仓内唯一备份产物是整库 dump（且文档自认无逐用户删除）
Select-String -Path "deploy\postgres-cvm\backup-postgres.sh" -Pattern "pg_dump|KEEP_DAYS|BACKUP_DIR"
Select-String -Path "deploy\postgres-cvm\*.md" -Pattern "逐用户|备份文件保留期"

# 3 应用侧只接了替身（备份清除端口仍 unwired）
Select-String -Path "services\api\src\privacy\user-data-deletion.ts" -Pattern "createUnwiredBackupPurgePort|available"
Select-String -Path "services\api\src\app.ts" -Pattern "userDataDeletionInjection"

# 4 契约状态里的阻塞原因
node tools/verify-contract-status.mjs
```

## 8 返修记录：rebase 到 `8205cfc` 后的重算（改前 → 改后）

本页初版基于 `53922ebdaae0c91da40a81fc56e76498a13756bd`。上游 `upstream/main` 前进到
`8205cfc8b8f32b8a7f44a28e53b1234bac5cc6c9`（期间合入 #256／#272／#288／#289／#290）后，
本片 rebase 到新基线并按新基线**重跑了全部普查命令**：下面每个数字都是实测，不是沿用初版。

### 8.1 冲突与解点

- 冲突文件**只有** `services/api/src/privacy/user-data-deletion.ts`（`git merge-tree --write-tree` 与 rebase 都只报这一个；
  `docs/architecture/contract-status.json`、`contract-implementation-status.md`、`state-contract.md`、`account-deletion.ts` 上游未改，干净合入）。
- 解冲突原则：**取上游行为**，只把本片的注释／文档字符串重新落到上游代码上。上游 #272 新增的
  `OwnerPurgeCounts { records, idempotency }`、`OwnerPurgeStore.purgeOwnerData?()`、
  `UserDataDeletionRegistry.evidenceOf()`／`evidenceByRequest` 与证据追加 `;<module>:idempotency-purged:<n>` **全部保留**；
  本片只重落三处文本：`backupState` bullet 注释、`BackupPurgePort` 的「接线前提」docstring、
  `createUnwiredBackupPurgePort()` 的 `note` 默认值（该参数现状 `void note;`，不参与行为）。
- 结果：文件内无 `<<<<<<<`／`=======`／`>>>>>>>` 残留；`backup_state` 默认 `pending` 与 `if (backupPurge.available)` 判定逻辑一个字符未改。

### 8.2 重算数字

| 项 | 改前（裸 `53922eb` 树） | 改后（裸 `8205cfc` 树 ／ 本提交（分支 HEAD）树） | 变化原因 |
| --- | --- | --- | --- |
| 迁移范围 | 0001–0017（17 个文件） | **0001–0018（18 个文件）** | 上游 #272 新增 `0018_favorites_history.sql` |
| `CREATE TABLE` 处数 | 50 | **54** | 同上，新增 4 处 |
| 去重表数（按 `schema.table` 限定名） | 50 | **54** | 新增 `favorites`、`favorites_idempotency`、`history`、`history_idempotency` 4 张；本行原记 48／52 是「schema 名被当表名」的口径错（R28 订正，见 §2.1） |
| 其中 `backup*`／`snapshot*`／`replica*`／`wal*`／`dump*` 表 | 0 | **0** | 新增 4 表是收藏/历史正文与幂等台账，无备份语义 |
| `backup_` 命中 | 14 行（全状态列） | **14 行（全状态列）** | 0003 8 行 + 0016 6 行，`0018` 无 `backup` 字样 |
| 软删 grep（`deleted_at/is_deleted/purged/deleted_by/soft_delete`） | 0 行 | **1 行（注释，不是列）** | `0018_favorites_history.sql:36` 自述「物理删除、无 `deleted_at` 软删」 |
| 真实软删列 | 0 | **0** | 同上，唯一命中是注释 |
| `user-data-deletion.ts` 端口锚点 | `:66`（`export interface BackupPurgePort`）、`:72`（`createUnwiredBackupPurgePort`） | 裸 `8205cfc`：`:82`、`:88`；分支 HEAD：`:91`、`:97` | 上游 #272 numstat `37 3`（+37/−3）使行号下移；本片注释再 +9 行 |
| `user-data-deletion.ts` handler 判定锚点 | `:216`（`let backupState = 'pending'`）…`:234`（`return { onlineState…`） | 裸 `8205cfc`：`:244`…`:267`；分支 HEAD：`:253`…`:276` | 同上；两套行号差 9 行＝本片新增注释 |
| `app.ts` 注入点 | `:422`（`userDataDeletionInjection?`）、`:1276`（`backupPurge === undefined`） | 裸 `8205cfc` ＝ 分支 HEAD：`:425`、`:1305` | 上游在 app.ts 增行；本片未改 app.ts，两棵树同值 |
| 测试锚点 | `user-data-deletion.test.mjs:88`、`:108-137`；`account-deletion-receipts.test.mjs:128`；`account-deletion-http.mjs:281` | **不变** | 这几个测试文件上游未改（`git diff --stat` 为空） |

**锚点取数树说明**（审查 P2 修正）：「改前」列一律取自**裸 `53922eb` 树**；「改后」列同时给出
**裸 `8205cfc` 树**与**本提交（分支 HEAD）树**两套行号——`user-data-deletion.ts` 两套相差 **9 行**，
正是本片在该文件新增的注释（`backupState` bullet＋端口 docstring＋`note` 默认值，`git diff 8205cfc..HEAD` 可见）；
`app.ts` 本片未改，故两棵树同值。复核命令：

```powershell
git grep -n "export interface BackupPurgePort" 53922eb -- services/api/src/privacy/user-data-deletion.ts
git grep -n "export interface BackupPurgePort" 8205cfc -- services/api/src/privacy/user-data-deletion.ts
git grep -n "export interface BackupPurgePort" HEAD    -- services/api/src/privacy/user-data-deletion.ts
```

### 8.3 结论是否改变

**没有改变，而且更强**：新增的 4 张表都是收藏/历史正文与本域幂等台账（`0018:36` 明写物理删除、无软删），
仍然没有任何「副本在哪、副本水位」的实体；`0018` 全文无 `backup`／`purge`／`snapshot` 字样。
整库 `pg_dump` 依旧无法逐用户删除 ⇒ 逐用户备份清除仍须**新增备份域**（产品决策），不是接线遗漏。

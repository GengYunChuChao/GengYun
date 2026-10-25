# 数据保留 / 备份 / 第三方完成证据：现状清单（GY-R59）

> 一句话：**「在线 7 日／备份 30 日」的执行器、调度单元、门禁都已接线并有真库臂；缺的全在两头——一头是「备份本体怎么恢复、恢复时怎么重放删除清单」只有脚本和纯函数，另一头是「第三方删除完成证据」只有库层读写路径、应用侧零行代码。**
>
> 本页只做**现状清单**，逐个结论给 `文件:行号` 与可复算命令，不改任何判定、不提方案。判定口径仍以 [数据面需求-实现-证据矩阵（S4）](s4-data-traceability.md) 为准；本页与它冲突处集中列在 §8。

## 1. 保留期数值：真源在哪，以及两个「30」不是同一件事

| 位置 | 常量 / 判据 | 值 | 用途 |
| --- | --- | --- | --- |
| `packages/privacy/deletion.mjs:15` | `ONLINE_HOURS = 7 * 24` | 7 日（小时口径） | 注销链内存协议；模块私有，未导出 |
| `packages/privacy/deletion.mjs:16` | `BACKUP_HOURS = 30 * 24` | 30 日 | 同上 |
| `services/api/src/privacy/deletion-aging.ts:60` | `export const ONLINE_RETENTION_DAYS = 7` | 7 日 | 服务端算 `online_due_at` 的唯一真源 |
| `services/api/src/privacy/deletion-aging.ts:62` | `export const BACKUP_RETENTION_DAYS = 30` | 30 日 | 服务端算 `backup_due_at` / `retention_until` |
| `packages/privacy/backup-retention.mjs:40` | `export const ONLINE_RETENTION_DAYS = 7` | 7 日 | 备份副本域；`:30-33` 自陈真源是上面两处 |
| `packages/privacy/backup-retention.mjs:43` | `export const BACKUP_RETENTION_DAYS = 30` | 30 日 | 同上 |
| `services/api/src/privacy/grant-pg.ts:69` | `retention_online_days > 7` 或 `retention_backup_days > 30` ⇒ 抛 `CONSENT_REQUIRED` | 7 / 30 作为**接收方留存上限** | 第四处硬编码，与到期计算无关 |

**必须点明的一处易混**：`packages/privacy/retention-policy.mjs` 里也有一个 30，但它**不是**备份的 30 日。

- `packages/privacy/retention-policy.mjs:122` 的 `RETENTION_POLICY` 只有 2 条：`public.idempotency_keys`（`:124`，`retentionDays: 1` 在 `:126`）与 `public.sessions`（`:140`，`retentionDays: 30` 在 `:142`）。
- 备份/注销相关的四张表全部在 `RETENTION_EXCLUSIONS` 里：`:200` 是 `public.user_backup_copies`，`:208` 是 `public.deletion_requests`／`public.deletion_handlers`／`public.third_party_deletions`。

⇒ **口径结论：「在线 7 日／备份 30 日」不是「日历保留策略」，而是两个到期时刻列**——`deletion_requests.online_due_at` 与 `user_backup_copies.retention_until`。写「7 日／30 日在 `retention-policy.mjs` 里」是错的；那是 `public.sessions` 的 30 天，和备份撞数字不撞语义。

## 2. 执行者：三条命令 + 三个 systemd 单元 + 一个 CI job

### 2.1 命令（`package.json`，三条都存在）

| npm script | 入口 | 到期判据 |
| --- | --- | --- |
| `purge:online-data`（`package.json:35`） | `tools/purge-expired-online-data.mjs`（`:3` 标题即「在线数据 7 日到期清除」） | `:16` `online_due_at <= cutoff AND state <> 'completed'`；`:28` keyset 分页；`:79` usage 里 `--limit`／`--max-batches`／`--cursor-file` 的缺省约定 |
| `purge:backup-copies`（`package.json:34`） | `tools/purge-expired-backup-copies.mjs`（`:3` 标题即「备份副本 30 日到期清除」） | `:16` `state <> 'purged' AND retention_until <= cutoff` |
| `purge:retention`（`package.json:36`） | `tools/purge-retention-expired.mjs` | 读 `RETENTION_POLICY` 按 `retentionDays` 算 cut-off；**默认 dry-run**，`:272` 打印「留 N 天（age_column）」 |

两个「到期清除」驱动模块都在 `services/api/src/privacy/`：`online-purge-driver.ts`、`backup-purge-driver.ts`、`online-purge-cursor.ts`。

### 2.2 调度单元（`deploy/purge-schedule/`，7 个文件，三对齐全）

| 单元 | 频率 | ExecStart 入口 |
| --- | --- | --- |
| `deploy/purge-schedule/gengyun-purge-online-data.timer:24` | `OnCalendar=*-*-* *:00/10:00`（10 分钟） | `.service:60`，带 `--cursor-file=/var/lib/gengyun-purge-online-data/online-purge-cursor.json`，`User=gengyun-ops`，`TimeoutStartSec=900` |
| `deploy/purge-schedule/gengyun-purge-backup-copies.timer:17` | `OnCalendar=*-*-* *:05/15:00`（15 分钟） | `.service:55` → `tools/purge-expired-backup-copies.mjs`，`User=gengyun-app` |
| `deploy/purge-schedule/gengyun-purge-retention.timer:29` | `OnCalendar=*-*-* 03:20:00`（日级一次） | `.service:57` → `tools/purge-retention-expired.mjs --yes --json`，`User=gengyun-ops`（**必须是属主/运维，运行时角色删不了 `public.sessions`**） |

### 2.3 门禁与 CI（都已接）

- `tools/verify-purge-schedule.mjs:117` 的 `REQUIRED_NPM_SCRIPTS` = **3 项**（`purge:online-data`、`purge:backup-copies`、`purge:retention`）；`:152` 的 `INTERVAL_BUDGET_MINUTES` 已按命令分档（分钟级 ≤60、日级 ≤1440）。
- `.github/workflows/engineering-shell.yml:140` 的 job `retention-gates`，`:153` 执行 `npm run verify:purge-schedule`。
- **运行侧仍未取得**：`deploy/purge-schedule/README.md:46` 自陈「这些命令没有在目标宿主上实跑过」，`:223` 「真库读数未取得」，`:235` 明写门禁「不证明外部调度真的在跑」。

## 3. 备份面：三件互不相干的东西被叫成同一个「备份」

### 3.1 物理/逻辑备份（`deploy/postgres-cvm/`）—— 脚本在，无 CI，无调度，未在真机跑过

| 项 | 现状 | 锚点 |
| --- | --- | --- |
| 备份脚本 | `pg_dump -Fc` 逻辑备份 + 保留期 + 产出清单；**物理 `pg_basebackup` 与 WAL 归档明确「未实现」** | `deploy/postgres-cvm/backup-postgres.sh:3`、`:14` |
| 保留期 | `KEEP_DAYS="${GENGYUN_BACKUP_KEEP_DAYS:-30}"`，用 `find -mtime +30` 清 | `deploy/postgres-cvm/backup-postgres.sh:57` |
| 可恢复性 | 脚本自己写「⚠️ exit 0 ≠ 备份已被证明可恢复」 | `deploy/postgres-cvm/backup-postgres.sh:40` |
| 恢复演练 | 「**未部署、未验收、未在任何真实 CVM/PG 实例上执行过**」 | `deploy/postgres-cvm/restore-drill.sh:5` |
| 删除清单重放 | 「不能证明……逐用户删除清单重放（**未实现**）」 | `deploy/postgres-cvm/restore-drill.sh:40` |

复算：`.github` 下 grep `restore-drill` 与 `backup-postgres.sh` **各 0 行**；`deploy/purge-schedule/` 里也没有备份单元。⇒ 这对脚本既不在 CI、也不在调度，是纯手工技术准备物。

### 3.2 备份副本域（在线侧的表）—— 已落地，含真库臂 + CI

`services/api/db/migrations/0023_user_backup_copies.sql`（`:46` `retention_until`、`:66` `CHECK (retention_until >= created_at)`、`:89` 到期索引）＋ `services/api/src/privacy/backup-copies-pg.ts` ＋ `services/api/src/app.ts:157` 的 `createPostgresBackupPurgePort` 装配。真库臂 `tests/integration/backup-purge-pg.mjs`、`tests/integration/backup-copies-purge-pg.mjs` 在 `.github/workflows/real-pg-integration.yml:499`、`:515` 跑。

### 3.3 只有文档、没有 DDL 的两张表

`docs/architecture/data-dictionary.md:92` 的 `deletion_tombstones` 与 `:93` 的 `backup_inventory`：字段、保留期语义（「至少覆盖所有 30 日备份和恢复演练」「当前最长 30 日，恢复须应用较新清单」）都写清了，但——

- `services/api/db/migrations` 下对这两个表名 `CREATE TABLE` **命中 0**（其余 `third_party_deletions`／`deletion_requests`／`deletion_handlers`／`user_backup_copies` 各 1 命中）。
- 全仓除文档外只有 `packages/privacy/README.md:124` 提到它们：「属 GY-I19 独立受控清单，不在本迁移范围」。

## 4. 第三方删除完成证据：库层已落地，应用层零行

### 4.1 已落地（有代码 + 有真库证据 + 在 CI）

| 层 | 内容 | 锚点 |
| --- | --- | --- |
| 表 | `third_party_deletions` 九列 + 两条部分唯一索引 | `services/api/db/migrations/0003_privacy_consent.sql:185` |
| 写路径 | `record_third_party_deletion(p_request_id uuid, p_recipient_id text, p_export_ref uuid, p_state text, p_evidence_ref text, p_error_code text, p_at timestamptz) RETURNS jsonb`，SECURITY DEFINER + `search_path=pg_catalog` + `TimeZone='UTC'` | `services/api/db/migrations/0044_third_party_deletion_persistence.sql:97` |
| 读路径 | `list_third_party_deletions(p_request_id uuid) RETURNS TABLE(...)`，八列固定序 | `services/api/db/migrations/0044_third_party_deletion_persistence.sql:270` |
| 授权 | 前置存在性断言（缺则 RAISE「迁移 0044 未执行」）＋ `REVOKE ... FROM PUBLIC` ＋ `GRANT EXECUTE ... TO gengyun_api_runtime`；表对运行时仍 forbidden | `deploy/postgres-cvm/sql/20-login-roles.sql:405`、`:414`、`:416`、`:417` |
| 断言 | `function_surface_manifest` 两条 + 形状断言（恰各一个、SECURITY DEFINER、search_path、TimeZone） | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1803`、`:1805` |
| 真库臂 | 签名常量 + 八列列序契约 + requested/failed/confirmed/幂等/终态 | `tests/integration/third-party-deletion-pg.mjs:43` |
| CI | 该真库臂在真库 workflow 里跑 | `.github/workflows/real-pg-integration.yml:203` |

### 4.2 未落地（这是「只有契约」的那一半）

- **应用侧零行**：`git grep -n third_party_deletions -- services/api/src` = 0 行；`git grep -nE "ThirdPartyDeletion|third-party-deletion" -- services/api/src/app.ts` = 0 行。⇒ **无端口、无装配、无调用方**。
- 唯一的运行时准备是两个未装配的模块：`services/api/src/privacy/third-party-deletion-adapter.ts`（注入式 `fetch`，无凭据或无传输即 `OBJECT_UNAVAILABLE` fail-closed）与 `services/api/src/privacy/third-party-deletion-projection.ts`（只被单测调用）。
- 内存协议侧有请求/确认/失败/不支持四条（`packages/privacy/deletion.mjs:210`／`:236`／`:252`／`:261`），**后端没有把它接到 0044 的函数上**。
- 迁移自己在 `services/api/db/migrations/0044_third_party_deletion_persistence.sql:4` 写明「**不接电**：`services/api/src/**` 一行未动」。
- 已知限制（P1 刻意）：`services/api/db/migrations/0044_third_party_deletion_persistence.sql:26` 起——签名只有一个 `p_state`，所以 `online_status` 与 `backup_status` **两列同时写同一个状态**；两面各自推进要等 P2 加 `p_phase`。

### 4.3 与 S4 D13 的口径核对：**判定仍对，证据层已过期**

`docs/architecture/s4-data-traceability.md:238` 的 D13 判定「未实现」，`:250` 的三条缺口（应用侧零读写、适配器未装配、投影没接进 `/me/exports`）**今天依然逐条成立**；`:248` 的两条零命中 grep 也依然准确。

但 `:240` 起的「实现（半成品，逐层都在但没接起来）」只列到 0003 表、内存协议、适配器、投影四层，**完全没有 0044 的库层读写路径、`20-login-roles.sql` 的授权、`90-assert-least-privilege.sql` 的断言、以及 `tests/integration/third-party-deletion-pg.mjs` 真库臂 + CI 接线**。⇒ 该改的是 S4：给 D13 增补「库层读/写路径已在 0044 落地，有授权、断言、真库臂并在 CI 跑；缺的是应用侧接线」这一层，**判定与缺口不动**。README 那一行（`:20`）不需要改。

## 5. 恢复清单（restore）与恢复重放（replay）：只有纯函数和一对脚本

- 需求原文：`docs/implementation-requirements.md:278`「在线个人数据／私有原媒体 7 日内删除，备份 30 日内滚动清理，**恢复时重放删除清单**」；`:281` 第三方删除要「跟踪请求/完成/失败与证据，未获证据不记完成」；`:286` 的 AC23 验收含「恢复清单」。
- 代码侧只有纯函数 + 端口：`services/api/src/privacy/backup-replay-manifest.ts:559` 的 `buildBackupReplayManifest(...)`、`:367` 的 `interface BackupReplayTargetPort`（**无任何适配器实现**）、`:85` 的 `REPLAY_MANIFEST_VERSION = 1`。S4 的 E3（`docs/architecture/s4-data-traceability.md:326`）就是这个事实。
- 仓内**没有**任何 replay 驱动命令：`tools/`、`deploy/`、`.github/` 下都找不到对应入口。
- 唯一能算「可执行步骤」的是 `deploy/postgres-cvm/backup-postgres.sh` → `deploy/postgres-cvm/restore-drill.sh` 这一对，而后者自陈从未真正恢复过任何备份（`deploy/postgres-cvm/restore-drill.sh:5`），并明说逐用户删除清单重放未实现（`:40`）。

⇒ 回答用户问的那两类：**恢复清单** = 一对未验证的手工脚本 + 一个没适配器的纯函数；**第三方完成证据** = 库层读写路径齐全且被真库臂钉住，但运行时一行都没接，所以「请求/完成/失败/证据」四件事在运行面上一个都取不到。

## 6. 三档清点

### 已落地（有代码 + 有测试或真库证据）

1. 在线数据 7 日到期清除：`tools/purge-expired-online-data.mjs` ＋ `online-purge-driver.ts` ＋ 单测 ＋ 真库臂 `tests/integration/online-purge-pg.mjs`（`.github/workflows/real-pg-integration.yml:560`）。
2. 备份副本 30 日到期清除：`tools/purge-expired-backup-copies.mjs` ＋ 驱动 ＋ 真库臂 `tests/integration/backup-copies-purge-pg.mjs`（同文件 `:515`）。
3. 日历保留执行器：`tools/purge-retention-expired.mjs` ＋ 真库臂 `tests/integration/retention-purge-pg.mjs`（同文件 `:582`）。
4. 三对 systemd 单元 + `verify:purge-schedule` 门禁 + `retention-gates` CI job（§2.2、§2.3）。
5. 第三方删除的**库层**读写路径：0044 两条函数 + 授权 + 断言 + 真库臂 + CI（§4.1）。

### 半落地（契约或脚本在，没人跑／没接 CI／没接电）

1. **第三方删除应用侧**：端口无、装配无、调用方无（§4.2）。库层已能记住，运行时取不到。
2. **物理/逻辑备份 + 恢复演练**：脚本自陈未在真实实例执行过，不在 CI、无调度单元（§3.1）。
3. **调度运行侧**：单元齐全、门禁绿，但目标宿主上没跑过、无 `systemctl list-timers` / `journalctl` 读数（`deploy/purge-schedule/README.md:235`）。
4. **三条真库臂不在任何 workflow**：`tests/integration/media-row-purge-pg.mjs`、`tests/integration/recognitions-speech-purge-pg.mjs`、`tests/integration/retention-clock-drill-pg.mjs`（S4 E2，已复算仍成立）。

### 只有承诺（文档一句话，DDL/代码都没有）

1. `deletion_tombstones`：只有数据字典字段表，无迁移、无代码（§3.3）。
2. `backup_inventory`：同上，「恢复须应用较新清单」目前没有任何清单可应用。
3. **恢复时重放删除清单**：只有纯函数 + 一个空端口，无驱动命令、无演练读数（§5）。
4. 第三方「完成证据」的**业务口径**（未获证据不记完成）：只在 `docs/implementation-requirements.md:281` 与内存协议里成立，库里 `p_state` 是调用方自报、无第三方回执校验的一方事实。

## 7. 最小可执行的 3 件事

1. **把 0044 接到应用侧最小一条腿**：在 `services/api/src/privacy/` 加 `third-party-deletions-pg.ts`（调 `record_third_party_deletion` / `list_third_party_deletions` 两条函数）、在 `services/api/src/app.ts` 装配，并在注销链的第三方分支调用它——单测可以照 `tests/privacy/third-party-deletion-adapter.test.mjs` 的替身写法，真库臂直接复用已有的 `tests/integration/third-party-deletion-pg.mjs` 夹具。**这是把 §4「库层有、运行面没有」这一刀补上的唯一一条。**
2. **让 S4 D13 与本页口径对齐**（纯文档）：给 `docs/architecture/s4-data-traceability.md` 的 `:240` 增补 0044 那一层，判定保持「未实现」。顺带把 G3 与 `:339` 的过期说法撤掉（见 §8）。改动只在 `docs/**`，可按 A 档分层自合并。
3. **给恢复演练留一条可复算读数**：不必上生产——在真实 PG 上用 `deploy/postgres-cvm/backup-postgres.sh` 备一次、`deploy/postgres-cvm/restore-drill.sh` 演一次，把两份输出（含 `pg_restore --list` 的清单行数）落到证据页。**这是把 `deploy/postgres-cvm/restore-drill.sh:5` 的「从未真正恢复过任何备份」从承诺变成读数的唯一动作。**

## 8. 本页推翻的 3 条既有说法

| # | 说法 | 现状 | 该改哪边 |
| --- | --- | --- | --- |
| 1 | `docs/architecture/s4-data-traceability.md:314` 称 `purge:retention`「**没有 `.service`/`.timer`**，也不在调度门禁的必需清单里」，`:315` 说 `tools/verify-purge-schedule.mjs` 的 `REQUIRED_NPM_SCRIPTS` 只有两项 | 单元在（`deploy/purge-schedule/gengyun-purge-retention.service` ＋ `.timer`），必需清单在 `tools/verify-purge-schedule.mjs:117` 已是 **3 项** | **改 s4**。同仓 `docs/architecture/gy-r34-retention-policy.md:118` 已写「调度接线（已做，2026-10-24）」、`:122` 写明日级单元与 `--yes --json`；s4 的 G3 是过期的那一边，应撤条而非补 timer |
| 2 | `docs/architecture/s4-data-traceability.md:339` 说 G3「必需清单只有两项（看 `tools/verify-purge-schedule.mjs:109`）」 | `:109` 实际是 `DEFAULT_SCHEDULE_DIR`；必需清单在 `:117` | 改 s4 的行号与结论 |
| 3 | `docs/architecture/README.md:17` 称「`verify:purge-schedule` **仍未进 CI**」 | 已进：`.github/workflows/engineering-shell.yml:140` 的 `retention-gates` job，`:153` 执行 | 改 README 该行；同页 `:18` 的「#19 的到期执行与第三方证据仍未取得」只剩「第三方证据」那半条成立 |

## 9. 复核命令

```bash
node tools/verify-doc-anchors.mjs --strict     # 行号不腐烂；本页新增锚点全在此闸门下
node tools/verify-contract-status.mjs          # 契约台账与装配一致性
npm run test:docs                              # Markdown 链接与表格、研究记录结构
npm run verify:purge-schedule                  # 三对单元 / OnCalendar / ExecStart / 必需清单 10 项判据
git grep -n third_party_deletions -- services/api/src        # 期望 0 行（D13 缺口仍成立）
git grep -nE "restore-drill|backup-postgres" -- .github       # 期望 0 行（备份/演练不在 CI）
```

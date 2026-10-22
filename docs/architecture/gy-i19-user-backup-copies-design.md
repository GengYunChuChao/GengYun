# 逐用户备份副本域设计（GY-I19 备份轴）

本片状态（**设计稿交付时点，2026-10-18**）：**设计稿 + 可单测的判定逻辑**，当时不落地 DDL、不接线 PG、不改契约状态。DDL／写入路径／清除端口的落地、以及与之相关的口径变化见下方 2026-10-20 增补与 §13（GY-R28 只补时点限定，不改状态）。

> **增补（2026-10-20 · 接线片 C2）**：DDL、写入路径与清除端口已在分支
> `feat/gy-i19-backup-domain` 落地——迁移 [`0023_user_backup_copies.sql`](../../services/api/db/migrations/0023_user_backup_copies.sql)、
> 纯逻辑 [`packages/privacy/backup-copies.mjs`](../../packages/privacy/backup-copies.mjs)、
> PG 适配 [`services/api/src/privacy/backup-copies-pg.ts`](../../services/api/src/privacy/backup-copies-pg.ts)。
> §4 的「归属 0022」改为实际 **0023**（合流波把 `0020`（#282）／`0021`（#279）／`0022`（#296 社区）
> 排在本片之前、本片紧接其后；接线期社区片（#296）当时的号位被预判为 `0023`，本片因此临时改号
> `0024`，而派发文件 `.pg17/dispatch/merge-wave-20261019.md` 把 `0022` 定给社区片、本片紧接其后，
> 故按派发改回 **0023**），R1 已定死为「请求重放驱动」。
> 落地形状、权限口径、与本文草案的偏差、以及**未取得项**见文末 §13。

## 0. 一句话结论

「在线 7 日／备份 30 日」里的**备份副本**，指注销受理那一刻为恢复与审计而留存、**只含不透明对象引用与计数**的最小清单行；`retention_until = 受理时刻 + 30×24 小时`，到点即把 `payload` 硬删、行转 `purged` 并留证据。

本片只交付三件：本文档、判定逻辑 [backup-retention.mjs](../../packages/privacy/backup-retention.mjs)、[单测](../../tests/unit/backup-retention.test.mjs)。因此生产行为**没有变化**：`BackupPurgePort` 仍是未接线实现，各模块 `backup_state` 仍如实停在 `pending`，[契约状态对照](contract-status.json) 的 blocker 不动。（以上为**设计片交付时点**的事实；2026-10-20 接线后：有真库且受理已接线时换真实 PG 端口，`real` 模式整域仍 503、契约状态仍未改，见 §13。）

## 1. 现状与为什么不差这一步

| 事实 | 位置 | 读数 |
| --- | --- | --- |
| **GY-I19 期间**仓内没有逐用户备份副本地表 | [验证记录](../verification/gy-i19-backup-domain-20261018.md) §1 普查 | 18 个迁移（0001–0018）、54 处 `CREATE TABLE`（按 `schema.table` 限定名去重 54 张）、0 张备份/快照/副本/转储表。**GY-R28 起已落地**：`0023_user_backup_copies.sql` 建 `public.user_backup_copies`（`state='purged'` ⇒ `payload='null'::jsonb` ＋ 清除证据），`services/api/src/privacy/backup-copies-pg.ts` 的 `createPostgresBackupPurgePort()` 是真实端口（`kind: 'wired'`／`available: true`） |
| 端口已存在但**当时**恒未接线 | [user-data-deletion.ts:141](../../services/api/src/privacy/user-data-deletion.ts)（接口）、[:147-156](../../services/api/src/privacy/user-data-deletion.ts)（工厂与返回对象；行号为 R28 树，设计片当时在 `:91`／`:97`，上游合流使行号下移） | 当时 `kind: 'unwired'`、`available: false`、`purge()` 恒 `{ purged: false }`；GY-R28 起不再恒未接线：`app.ts:1581-1588`（`backupPurgeWiring`；合流当前 main 前在 `:1457-1464`，按符号重取）在「受理端口已接线 ＋ 有真库连接池」时装配 `backup-copies-pg.ts` 的 PG 端口，无真库/未接受理时仍退回本行的 unwired 语义 |
| 注入点已存在 | [app.ts:470](../../services/api/src/app.ts)、[:1582-1583](../../services/api/src/app.ts) | 仅在显式注入 `userDataDeletionInjection.backupPurge` 时传入 |
| 回执照实不谎报 | [tests/unit/user-data-deletion.test.mjs:88](../../tests/unit/user-data-deletion.test.mjs) | 断言逐字「备份副本清除未接线 ⇒ 如实 pending，不得谎称 completed」 |
| 唯一备份产物是整库 dump | [backup-postgres.sh:56-57](../../deploy/postgres-cvm/backup-postgres.sh) | `KEEP_DAYS=30` 是**文件**保留期，无法逐用户删 |

四处文档已自认未实现逐用户删除（`deploy/postgres-cvm/README.md`、`runbook.md`、`verify-checklist.md`、`roles-and-migration.md`），清单见验证记录 §1；本片未逐行重新核对这四处。

所以「补齐备份轴」不是补一个函数调用，而是补一张**能按主体寻址、能到期硬删、能自证已删**的表，外加一条判定规则。本片先把设计与判定规则定死，DDL 留给合入序就绪后的接线片。

## 2. 目标与边界

### 2.1 目标

1. 注销受理时，为每个已登记模块留下**可恢复、可审计**的最小副本清单行。
2. 30 天到期后能按主体把副本内容**硬删**，并把「删除了什么、什么时候、依据哪次受理」写成证据。
3. 判定不依赖时钟猜测：到期与否由 `retention_until` 闭区间比较得出，清除成功与否由**删除后的持久状态**复核得出。

### 2.2 非目标

- 不做「用户数据的第二份拷贝」：正文、媒体字节、自由文本不进 `payload`。
- 不改整库 dump 策略：`pg_dump -Fc` 仍是整库的，本域不改变它不可逐用户删除的性质（见 §8.3）。
- 不做 30 天到期的调度器（见 §12 R1）。
- 不在本片改 `BackupPurgePort` 形状、不改既有测试、不改契约状态。

### 2.3 三轴不混

| 轴 | 真源（谁写） | 本片 |
| --- | --- | --- |
| `online_state` | handler 在线真删后由删除协议回填 | 不碰（已实现） |
| `backup_state` | handler 调 `BackupPurgePort.purge()` 的结果（[user-data-deletion.ts:259-266](../../services/api/src/privacy/user-data-deletion.ts)） | **只设计**，不接线，取值仍是 `pending` |
| `third_party_state` | 第三方请求/确认（`third_party_deletions` 表与 `deletion-modules.mjs` 的 thirdParty* 接口） | 不碰，与备份轴分列 |

供应商副本的完成证据只认 `confirmed` + 证据（[deletion.mjs](../../packages/privacy/deletion.mjs) 的 `hasEvidence`），**不得**拿备份行的状态去顶替第三方轴，反之亦然。理由见验证记录 §3 第二条捷径。

## 3. 术语：一行副本是什么

一行 `user_backup_copies` = 「某主体、某模块、某范围，在某次注销受理时刻仍存在的对象引用清单」。

- 它是**删除清单的投影**，与 [state-contract.md](state-contract.md) 要求的 `lineage`（该副本属于哪一次备份）和**截至水位**逐项对齐。
- **谁能读**：只有服务端副本存储与清除作业。没有 HTTP 面、没有对外导出、`payload` 不进日志；回执里只出现计数与证据摘要（形如 `favorites:backup-purged:<摘要>`）。
- **何时清除**：`retention_until` 到点即清，边界取闭区间（`now >= retention_until`），与 [deletion-aging.ts:287](../../services/api/src/privacy/deletion-aging.ts) 的口径一致。
- **清到什么程度**：`payload` 内容硬删（置 `'null'::jsonb`），**保留行**作为证据（见 §5.3）。

## 4. 表设计（DDL 草案，归属迁移 0022，本片不落地）

```sql
-- 草案：0022_user_backup_copies.sql（本片只写在文档里，不建 .sql 文件）
CREATE TABLE user_backup_copies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,                       -- 主体；刻意不建 CASCADE 外键，见 §10 第 10 条
  request_id        uuid NOT NULL REFERENCES deletion_requests (id) ON DELETE RESTRICT,
  module            varchar(80) NOT NULL,
  scope             varchar(32) NOT NULL,
  delete_generation integer NOT NULL CHECK (delete_generation >= 1),
  lineage           text NOT NULL,
  covered_through   timestamptz NOT NULL,                -- 截至水位
  payload           jsonb NOT NULL,                      -- 最小化清单，见 §5
  payload_digest    char(64) NOT NULL,
  state             text NOT NULL DEFAULT 'pending_purge',
  retention_until   timestamptz NOT NULL,                -- 受理 + 30×24 小时
  purge_attempts    integer NOT NULL DEFAULT 0,
  purged_at         timestamptz,
  evidence_ref      text,
  last_error_code   varchar(80),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_backup_copies_state_check
    CHECK (state IN ('pending_purge', 'purged', 'failed')),
  CONSTRAINT user_backup_copies_module_shape
    CHECK (module ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT user_backup_copies_scope_shape
    CHECK (scope ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT user_backup_copies_lineage_present
    CHECK (length(btrim(lineage)) > 0),
  CONSTRAINT user_backup_copies_watermark_order
    CHECK (covered_through <= created_at),
  CONSTRAINT user_backup_copies_digest_shape
    CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_backup_copies_retention_after_created
    CHECK (retention_until >= created_at),
  CONSTRAINT user_backup_copies_purge_attempts_nonneg
    CHECK (purge_attempts >= 0),
  -- purged 必须有清除时间、非空白证据，且 payload 已硬删（不允许「报完成但内容还在」）
  CONSTRAINT user_backup_copies_purged_evidence
    CHECK (state <> 'purged' OR (
      purged_at IS NOT NULL
      AND evidence_ref IS NOT NULL
      AND btrim(evidence_ref) <> ''
      AND payload = 'null'::jsonb
    )),
  CONSTRAINT user_backup_copies_failed_error
    CHECK (state <> 'failed' OR last_error_code IS NOT NULL),
  CONSTRAINT user_backup_copies_pending_no_purged_at
    CHECK (state <> 'pending_purge' OR purged_at IS NULL)
);

CREATE UNIQUE INDEX user_backup_copies_key
  ON user_backup_copies (request_id, module, scope);
CREATE INDEX user_backup_copies_subject_idx
  ON user_backup_copies (user_id);
-- 到期扫描只关心未清完的行；purged 行不进索引
CREATE INDEX user_backup_copies_due_idx
  ON user_backup_copies (retention_until)
  WHERE state <> 'purged';
```

### 4.1 列与最小化理由

| 列 | 类型与约束 | 用途与理由 |
| --- | --- | --- |
| `id` | `uuid` 主键，`gen_random_uuid()` | 与全库惯例一致（见 [0003_privacy_consent.sql:147](../../services/api/db/migrations/0003_privacy_consent.sql)） |
| `user_id` | `uuid NOT NULL`，无外键 | 清除作业按主体定位；无外键的理由见 §10 第 10 条 |
| `request_id` | `uuid NOT NULL REFERENCES deletion_requests(id) ON DELETE RESTRICT` | 副本必挂在一次受理上；RESTRICT 防止上游静默删掉证据 |
| `module` | `varchar(80) NOT NULL`，形状 CHECK | 与 `deletion_handlers.module` 同宽；不写死闭集，模块清单归 `deletion-modules.mjs` |
| `scope` | `varchar(32) NOT NULL`，形状 CHECK | 范围名（如 `favorite`、`history`），语义闭集镜像 `REPLAY_SCOPES`（[backup-replay-manifest.ts](../../services/api/src/privacy/backup-replay-manifest.ts)），不在此重复枚举 |
| `delete_generation` | `integer >= 1` | 与 `deletion_requests.generation` 同义，供重放判新旧 |
| `lineage` | `text NOT NULL`，非空白 | 「这行副本来自哪一次备份」，[state-contract.md](state-contract.md) 要求 |
| `covered_through` | `timestamptz NOT NULL`，`<= created_at` | 截至水位：清单只对水位之前的事实负责 |
| `payload` | `jsonb NOT NULL` | 见 §5；清空后置 `'null'::jsonb` |
| `payload_digest` | `char(64)`，十六进制 CHECK | 让证据可复核，不必重读 payload |
| `state` | `text`，3 值 CHECK | 见 §4.3 |
| `retention_until` | `timestamptz NOT NULL`，`>= created_at` | 到期判定唯一依据；值必须等于 `deletion_requests.backup_due_at`（§4.4） |
| `purge_attempts` | `integer >= 0` | 失败重试次数，避免无限重试隐身 |
| `purged_at` / `evidence_ref` | 可空，`purged` 时必填 | 证据三元组：何时清、凭什么清 |
| `last_error_code` | 可空，`failed` 时必填 | 取值须落在 `deletion.mjs` 的 `SAFE_ERROR_CODES` 内（DB 侧只校验形状，真源在 JS） |

### 4.2 索引理由

| 索引 | 列 | 服务的查询 |
| --- | --- | --- |
| `user_backup_copies_key`（唯一） | `(request_id, module, scope)` | 写入幂等：`ON CONFLICT DO NOTHING`；防止同一请求重复落行 |
| `user_backup_copies_subject_idx` | `(user_id)` | 「这个人的副本还有哪些」——越权核查与工单定位 |
| `user_backup_copies_due_idx`（部分） | `(retention_until) WHERE state <> 'purged'` | 到期扫描只扫未清完的行，`purged` 行随 30 天窗口增长后不拖慢扫描 |

### 4.3 状态机

```text
       写入（受理事务内）
              |
              v
      [pending_purge] --到期且清除成功且有证据--> [purged]（终态）
              |                                     ^
              | 清除抛错 / 影响 0 行 / 证据缺失        |
              v                                     |
          [failed] --------------------------------
              |
              +-- 显式重排（运维或重试作业清 last_error_code，且已到期）--> [pending_purge]
```

| 转换 | 触发 | 守卫 |
| --- | --- | --- |
| （插入）→ `pending_purge` | 受理时写快照行 | 每模块至少一行；`retention_until = backup_due_at` |
| `pending_purge` → `purged` | 到期清除成功 | `now >= retention_until` 且证据非空且 `payload` 已置空 |
| `pending_purge` → `failed` | 清除失败 | 写 `last_error_code`，`purge_attempts + 1` |
| `failed` → `pending_purge` | 人工/作业重排 | 只允许在到期后重排，且必须先清 `last_error_code`；不得自动 |
| `purged` → 任意 | 无 | 终态；repository 的 `UPDATE ... WHERE state = 'pending_purge'` 天然挡住回退 |

`purged` 是终态的理由：副本内容已硬删，任何「回到 pending」都意味着要重新生成内容——那等于把已清除的个人数据再造一份。

### 4.4 与 `deletion_requests` 的冗余与对账

`retention_until` 与 `deletion_requests.backup_due_at` 是同一个时刻的两次存储：清除作业要免 join 扫描到期行，而行要在回执窗口之后仍能自证。冗余必须可核，CI 真库臂加一条对账（期望 0 行）：

```sql
SELECT count(*) FROM user_backup_copies c
  JOIN deletion_requests r ON r.id = c.request_id
 WHERE c.retention_until <> r.backup_due_at;
```

## 5. `payload` 的最小化原则

### 5.1 允许存

- 不透明对象引用（受控 `object_ref` 串或 `sha256` 摘要），按范围分组。
- 计数（`records`、`bytes` 之类可核对的数字）。
- 范围名、生成该快照的作业/版本标识。

### 5.2 禁止存

- 正文、标题、媒体字节或可直读的 URL。
- 用户身份信息（手机号、openid、昵称）。
- 任何自由文本、任何第三方凭据或令牌。
- 可反推内容的低熵指纹（例如单条正文的明文哈希不在此列：摘要只对引用做，不对内容做）。

### 5.3 到期即硬删，但保留行

到期清除时 `UPDATE ... SET payload = 'null'::jsonb, state = 'purged'`，**不删整行**：删行会让 30 天后无法区分「清过」与「从没写过」，而这正是 §7.3 要防的判据丢失。`purged` 行的留存窗口由回执台账决定：`RECEIPT_TTL_MS = 35 天`（[account-deletion.ts:64](../../services/api/src/privacy/account-deletion.ts)），比 30 天备份期多 5 天核对余量——顺序成立，不需要额外保留策略。

## 6. 写入路径

### 6.1 位置

注销受理在 [account-deletion.ts:211-227](../../services/api/src/privacy/account-deletion.ts)：

```text
1. requestDeletionFor(userId, {receiptInput})   → requested_at / online_due_at / backup_due_at
2. [新增] 写 user_backup_copies 快照行           → retention_until = backup_due_at，state = pending_purge
3. await executeHandlers(requestId)             → 每模块：在线硬删 → 端口 purge → 状态回填
4. receipts.issue + projectReceipt              → 回执投影（只归形状）
```

第 2 步必须在第 3 步之前、且与受理绑在同一事务里（`startDurableAcceptance`）：handler 做的是**物理删除**（`purgeOwnerData` / `deleteAllByOwner`，[user-data-deletion.ts:247-251](../../services/api/src/privacy/user-data-deletion.ts)），晚写快照只能拿到空引用。

### 6.2 失败语义

| 场景 | 受理结果 | 行状态 | 明令禁止 |
| --- | --- | --- | --- |
| 第 2 步在受理事务内失败（任一行写不进） | 事务回滚，抛 `STORE_UNREACHABLE` / `STORE_REJECTED`，202 不签发、无回执 | 无行（随请求回滚） | ⛔ 先删在线数据再补写；⛔ 只写成功部分模块就提交 |
| 受理已提交，第 3 步发现该模块快照行缺失或为空 | 继续（不撤销已完成的在线删除），如实暴露缺口 | 该模块 `backup_state: 'blocked'`、`error_code: 'EVIDENCE_REQUIRED'` | ⛔ 写回 `pending`；⛔ 写 `completed` |
| 快照行写入成功，但清除时引用已不可读 | 受理成功 | 行转 `failed`，`last_error_code` 非空 | ⛔ 当作已清；⛔ 静默跳过 |
| 端口未接线（`available: false`） | 受理成功 | `pending`（现状，不改） | ⛔ 拿未接线当完成 |

两个分支都**不会**产出 `pending` 来掩盖缺口：事务内失败时请求根本不存在（没有回执可谎报），提交后失败时行被写成 `blocked`。

### 6.3 为什么是 `blocked` 而不是 `pending`

`pending` 的语义是「还没轮到」，可以被等待；`blocked` 是「有不满足的前置，需要人介入」（[constants.mjs](../../packages/privacy/constants.mjs) 的 `HANDLER_STATES`）。快照没写成就意味着 30 天后**没有可清对象**，等下去不会自愈——所以只能是 `blocked`。同理见 [state-contract.md](state-contract.md)「不能完成时显示 blocked 和逾期，不把时钟到期当完成」。

## 7. 清除路径

### 7.1 纯函数判定（本片已交付）

`evaluateBackupPurge({ now, copies })`（[backup-retention.mjs](../../packages/privacy/backup-retention.mjs)）只做判定，不碰 IO：

| 输入情形 | `action` | `reason` |
| --- | --- | --- |
| `now` 不可解析 | `blocked` | `BACKUP_INPUT_INVALID` |
| `copies` 不是数组 | `blocked` | `BACKUP_INPUT_INVALID` |
| 某行非对象 / `state` 不在闭集 / `retentionUntil` 不可解析 | `blocked` | `BACKUP_INPUT_INVALID` |
| 存在 `failed` 行 | `blocked` | `BACKUP_COPY_FAILED` |
| 有到期行（`now >= retentionUntil`） | `purge` | `BACKUP_PURGE_DUE` |
| 只剩未到期行 | `wait` | `BACKUP_WAITING_RETENTION` |
| 全部已 `purged` | `none` | `BACKUP_ALL_PURGED` |
| 零行 | `none` | `BACKUP_NO_COPIES` |

判定顺序即上表顺序：坏输入先于一切，`failed` 先于 `purge`——状态不可信时不允许放行。

### 7.2 `purge()` 判定表

端口实现（接线片写）在事务内先按 §7.1 判定，再动作；返回值以**复核结果**为准：

| 判定 | `purge()` 动作 | `purge()` 返回 | 回执 `backup_state` |
| --- | --- | --- | --- |
| `purge` | `UPDATE ... SET payload='null'::jsonb, state='purged', purged_at=now(), evidence_ref=<摘要> WHERE request_id=… AND module=… AND state='pending_purge'` 然后复核 | `{ outcome: 'purged', evidenceRef }` | `completed` |
| `purge` 但删除抛错或受影响 0 行 | 回滚，行置 `failed`、`last_error_code`、`purge_attempts+1` | `{ outcome: 'blocked', errorCode: 'STORE_UNREACHABLE' }` | `blocked` |
| `wait`（未到期） | 不写 | `{ outcome: 'waiting', reason: 'BACKUP_WAITING_RETENTION' }` | `pending` |
| `none` / `NO_COPIES`（0 行） | 不写 | `{ outcome: 'blocked', errorCode: 'EVIDENCE_REQUIRED' }` | `blocked` |
| `none` / `ALL_PURGED`（重跑） | 只复核持久行 | 复核通过 ⇒ `purged` + 摘要；否则 `blocked` | `completed` 或 `blocked` |
| `blocked` / `COPY_FAILED` | 不自动重置 `failed` | `{ outcome: 'blocked', errorCode: 'STORE_REJECTED' }` | `blocked` |
| `blocked` / `INPUT_INVALID` | 不写 | `{ outcome: 'blocked', errorCode: 'POLICY_BLOCKED' }` | `blocked` |

**复核**（`purged` 的充要条件）：

```sql
-- remaining 必须为 0
SELECT count(*) FROM user_backup_copies
 WHERE request_id = $1 AND module = $2 AND state <> 'purged';
-- evidenceRows 必须 >= 1
SELECT count(*) FROM user_backup_copies
 WHERE request_id = $1 AND module = $2
   AND state = 'purged' AND evidence_ref IS NOT NULL AND btrim(evidence_ref) <> '';
```

`evidenceRef` 用带域分隔的摘要，风格对齐既有 `replayKeyOf`：`'sha256:' + hex(sha256('gengyun/backup-purge/v1\0' + requestId + '\0' + module + '\0' + 排序后的 payload_digest 拼接))`。

### 7.3 空集不得当成功

三条理由，缺一不可：

1. **写入路径保证每模块至少一行**（§6.1，0 个对象也写一行 `payload = {"object_refs": [], "records": 0}`），所以到期时 0 行只能是漏写、丢行或域未接线，不是「这些人本来就没数据」。
2. 若空集算成功，任何「备份域根本没建」的部署都会自证干净——这正是验证记录 §3 否掉的第一条捷径（建空登记表立即接线 ⇒ 恒 `purged: true`）。
3. 复核式证据要求「至少一条带证据的 `purged` 行」；空集连证据行都没有，`purged: true` 无凭据。

因此空集返回 `blocked` + `EVIDENCE_REQUIRED`，并把该模块的 `backup_state` 顶到 `blocked`，让缺口可见。

### 7.4 端口形状的现状缺口（本片只登记，不改）

现有 `BackupPurgePort.purge()` 只能返回 `{ purged: boolean, evidenceRef?: string }`，handler 又始终返回 `errorCode: null`（[user-data-deletion.ts:276](../../services/api/src/privacy/user-data-deletion.ts)），**无法表达 `blocked`**。建议在接线片**新增可选字段**：

```ts
type BackupPurgeOutcome =
  | { outcome: 'purged'; evidenceRef: string }
  | { outcome: 'waiting'; reason: string }
  | { outcome: 'blocked'; errorCode: string; reason: string };
```

保留旧形状兼容：未给 `outcome` 时按既有语义回退（`purged === true` 且证据非空 ⇒ `completed`，否则 `pending`）。这样 [tests/unit/user-data-deletion.test.mjs:127](../../tests/unit/user-data-deletion.test.mjs) 的「未清除 ⇒ 仍 pending」零改动仍成立，接线片不需要撕既有断言。本片不改端口。

### 7.5 幂等与重跑

- 已 `purged` 的模块重跑：走 `ALL_PURGED` 复核，不得降级成 `pending`——否则一次无害的重放会把「已完成」读成「待做」。
- 证据取自持久行，不取「本次删了几行」，因此重跑结果稳定。
- 与既有「已完成行不重跑」的设计一致（[tests/unit/user-data-deletion.test.mjs:162](../../tests/unit/user-data-deletion.test.mjs)）。

## 8. 与契约的映射

### 8.1 `backup_state` 的取值来源

| 来源 | 位置 | 作用 |
| --- | --- | --- |
| handler 写行 | [user-data-deletion.ts:253-266](../../services/api/src/privacy/user-data-deletion.ts) | 唯一写入点：`pending` / `completed`（接线后含 `blocked`） |
| 回执投影 | [deletion-modules.mjs](../../packages/privacy/deletion-modules.mjs) 的 `receipt()` | 未报告模块以 `pending/pending` 呈现 |
| HTTP 形状归一 | [account-deletion.ts:242-265](../../services/api/src/privacy/account-deletion.ts) | 只归形状，不做「部分覆盖说成全部完成」的抬升 |

### 8.2 `contract-status.json` 的 blocker 何时才能改

四条前置全部具备才允许改（本片一条都不具备，故不改）：

- [ ] 0023 落地，且 `user_backup_copies` 在真 PG17.11 上可建、约束负例可复现。
- [ ] 写入路径接线：受理事务内按模块写快照行，含 0 对象模块。
- [ ] 端口扩为三态并与清除作业接通，`purged` 必须由复核产生。
- [ ] 端到端证据：至少一次「受理 → 30 天后到期 → 清除 → 证据 → 回执 `completed`」在真库跑通并留读数。

此外该文件由 `tools/verify-contract-status.mjs --write-doc` 生成，手改会被一致性检查打红——接线片应改源文件后重新生成。

### 8.3 整库 dump 不因本域改变

运维备份仍是整库 `pg_dump -Fc`，30 天是**文件**保留期（[backup-postgres.sh:57](../../deploy/postgres-cvm/backup-postgres.sh)）。本域只让「在线库里的副本」变成逐用户可删，**不改变** dump 内旧副本只能整体过期的性质。这一点必须在对外表述里写清，不能拿本域冒充「备份介质已逐用户清除」。

### 8.4 本片明确不改

⛔ `docs/architecture/contract-status.json`、⛔ `packages/contracts/` 下任何文件、⛔ 迁移 `.sql`、⛔ `services/api/` 下任何既有实现、⛔ 任何既有测试。

## 9. 迁移号与合入序

- main 现到 `0018`（实测 `services/api/db/migrations/` 共 18 个 `.sql`，最大 `0018_favorites_history.sql`）。
- 在途 PR 已占号（未合入本分支）：`#278` = 0019、`#282` = 0020、`#279` = 0021。
- 因此本域取 **0022**（推算，不预占）。
- 「连续无缺号」断言的真正位置是 [tests/integration/migrations-negative-pg.mjs:47-64](../../tests/integration/migrations-negative-pg.mjs)（`MISSING_VERSIONS` 必须为空、`MIGRATION_COUNT === LAST_VERSION_NUMBER`），**不在** `tests/unit/migrations*.test.mjs`（那两支只断言 0001–0003 的存在、校验和、升序、漂移与事务边界）。该集成文件在 `MIGRATIONS_NEGATIVE_TEST_URL` 未设置时打印 SKIP 并 `process.exit(0)`（:22-28），所以本机不红、CI 真库臂才红——`#278` 当前的红因正是这个。
- 结论：本片**不落 `.sql`**。合入序 `#278` → `#282` → `#279` → 本域 0022；若先合入者改号，本域顺延。

## 10. 关键决定

| 决定 | 选择了什么 | 为什么不选另一种 |
| --- | --- | --- |
| 交付形态 | 只设计 + 纯逻辑，不落 `.sql` | 落在分支上会立刻造出 `MISSING_VERSIONS = ['0019','0020','0021']`，让 CI 真库臂变红（缺号断言位置见 §9） |
| 表粒度 | 一张 `user_backup_copies`，一行 =（请求、模块、范围） | 不建「副本内容子表」：清除粒度必须与主体/请求绑定才能逐用户删，且与状态协议要求的 opaque refs + delete generation + 范围 + 期限 + 证据逐项对齐 |
| `payload` 内容 | 只存不透明引用与计数 | 不复制正文/媒体：否则注销后留存的个人数据**变多**，与要求相反，且整库 dump 已有一份 |
| 空模块 | 也必须写一行（0 对象） | 不省略：省略后「到期查不到行」无法与「本来没数据」区分，空集不得当成功就没有可执行判据 |
| 写入位置 | `executeHandlers()` 之前、同一受理事务 | 不放 handler 内部：handler 先做物理删除，那时再取引用只能拿到空集 |
| 提交后缺口 | `blocked` + `EVIDENCE_REQUIRED` | 不写 `pending`：`pending` 读作「还在路上」，会把「30 天后无可清对象」伪装成进行中 |
| 完成判据 | 删除后复核持久行（`remaining = 0 且证据行 >= 1`） | 不用「本次删了几行」：那样重跑会把已完成降级为 pending，且空集仍可能被判成功 |
| 端口 | 三态 `outcome`，但作为**新增可选字段** | 不换成必填对象：既有断言「未清除 ⇒ pending」零改动即通过；也不强行改端口：本片不接线 |
| 状态列类型 | `text` + `CHECK` | 不新建 pg enum：3 态且未来可能加态，enum 加值要新迁移、删值要重建类型，回滚脚本变复杂；若评审要求统一风格，改 `backup_copy_state` enum 语义不变 |
| 外键 | `user_id` 不建外键；`request_id` 用 `ON DELETE RESTRICT` | 不用 `CASCADE`：主体行被物理删除时会连带抹掉「已清」证据，把 `completed` 读成「无副本 ⇒ blocked」 |
| 期限双存 | `retention_until` 与 `backup_due_at` 并存 + 对账查询 | 不每行 join `deletion_requests`：到期扫描要快、且行要在回执窗口后仍自证；漂移由 §4.4 的对账归零兜住 |
| 数值真源 | 新模块只导出天/毫秒，并与既有两处交叉校验 | 不另立第三套数字：单测同时对照 `deletion.mjs`（小时口径，经 `createDeletionRegistry()` 的 `backupDueAt` 反查）与 `deletion-aging.ts`（天口径） |
| 统一出口 | 不改 `packages/privacy/index.mjs` | 不提前加 `export *`：仓内先例是按路径 import，加了也没有消费者，属半接线 |

## 11. 取证计划

| 本机能证 | CI 能证 | 不能证 |
| --- | --- | --- |
| 判定逻辑全分支（到期/未到期/边界相等/失败/非法输入/空集/全清） | 0022 在真 PG17.11 上可建、约束负例可复现 | 真实备份介质上的逐用户清除（仓内无此介质） |
| 7 天与 30 天不相等，且与 `deletion.mjs`、`deletion-aging.ts` 的双向交叉校验一致 | 部分索引被到期扫描命中、唯一索引挡住重复写入 | 30 天真实时间流逝（只用固定时间戳推算，不代表真实到期执行过） |
| 空集返回 `none` / `NO_COPIES` 而非成功；非法输入一律 `blocked` | §4.4 对账查询返回 0 行 | 「清除后不可恢复」的物理保证（只证行删除 + `payload` 置空，不证介质擦除） |
| 与 `deletion_requests.backup_due_at` 的推导一致（受理 + 30×24 小时） | `migrations-negative-pg.mjs` 在 0019–0021 合入后仍无缺号 | 回执/契约状态在真实接线后的行为（本片不改契约状态） |

本机复现命令（单测不依赖网络，也不写死「今天」）：

```bash
node --test --test-isolation=none tests/unit/backup-retention.test.mjs
node --test --test-isolation=none tests/unit/migrations.test.mjs \
  tests/unit/migrations-constraint.test.mjs tests/privacy/deletion-modules.test.mjs
```

## 12. 风险与未决

| 编号 | 风险 | 现状与建议 |
| --- | --- | --- |
| R1 | 没有 30 天到期触发者 | **已定死（2026-10-20 接线片）**：触发者 = **请求重放**——用同一 `requestId` 重跑受理链路的 `deletion.executeHandlers()`，端口每次 `purge()` 都重读库、按 `retention_until` 判定 `wait`/`purge`；不在受理时开定时器、不引入常驻作业/调度器。⚠ 「显式维护端点（仅后台能力位）」**本片未实现**（会新增对外契约面与权限位/审计设计，超出「只接线」范围），列为 §13 未取得项 |
| R2 | 重放把已完成读成 pending | 由 §7.5 的复核规则规避，但依赖 `purged` 行与 `evidence_ref` 仍在；若将来压缩 `purged` 行，须同时保证 `deletion_handlers.evidence_ref` 保留摘要 |
| R3 | 0019–0021 可能改动删除相关表 | 本片未读这三支的实现；0022 落地前必须重读它们是否动过 `deletion_requests` / `deletion_handlers` |
| R4 | `user_id` 无外键的完整性代价 | 若 DDL 评审坚持外键，退让为 `REFERENCES users(id) ON DELETE RESTRICT`，并接受「账号行物理删除被 RESTRICT 挡住」的副作用 |
| R5 | 引用本身可能反推内容 | 只对引用做摘要，且范围名不携带对象细节；若某模块引用含可读标识，须在该模块内先脱敏再落库 |
| R6 | 状态列与既有 enum 风格不一致 | 见 §10「状态列类型」：可改 `backup_copy_state` enum，语义与判定表不变 |

## 13. 接线落地记录（2026-10-20 · 片 C2）

本节只记录**实际落地的形状**。凡与 §4–§7 草案字面不一致处，以本节与代码为准（差异逐条列在 §13.5）。

### 13.1 文件级清单

| 文件 | 角色 |
| --- | --- |
| `services/api/db/migrations/0023_user_backup_copies.sql` | 建表 + 11 条 CHECK + 唯一键/主体索引/到期部分索引；`request_id … ON DELETE RESTRICT`，`user_id` 无外键（§10） |
| `services/api/db/migrations/rollback/0023_user_backup_copies.down.sql` | `DROP TABLE IF EXISTS`（纯新增，可整表拆） |
| `packages/privacy/backup-copies.mjs` | 纯逻辑：scope 闭集、`normalizeObjectRefs`、规范序列化、摘要、§7.2 的证据摘要 |
| `services/api/src/privacy/backup-copies-pg.ts` | `insertBackupCopySeeds()`（受理事务内写清单）+ `createPostgresBackupPurgePort()`（三态端口） |
| `services/api/src/privacy/user-data-deletion.ts` | 端口结果加**可选**三态字段；handler 按三态给 `backup_state`/`error_code`；受理时构造每模块一个清单来源 |
| `services/api/src/privacy/deletion-requests-pg.ts` | `createRequest` 在**同一事务**内 CALL 受理函数 + 写清单行 |
| `services/api/src/favorites/store*.ts`、`history/store*.ts` | 新增 `snapshotOwner(ownerId, client?)`：只回不透明行 id + 计数（内存版与 PG 版同接口） |
| `services/api/src/app.ts` | 装配：受理已接线且有池 ⇒ 真实 PG 端口；否则保持 unwired（`requests: null` 时仍 pending）；`real` 无池的注入场景 ⇒ 显式不可用端口 |
| `deploy/postgres-cvm/sql/20-login-roles.sql`、`services/api/db/roles/auth_privacy.sql` | 列级 `SELECT/INSERT/UPDATE` 授权（两处各一份：前者给已部署库，后者给 fresh bootstrap） |
| `tests/unit/backup-copies-port-contract.test.mjs`、`tests/integration/backup-purge-pg.mjs` | 26 条契约单测；真 PG 17.11 上 13 组集成证据（见交接文件读数） |

### 13.2 写入路径的实际形状

受理仍走唯一写路径 `public.request_account_deletion(...)`（`SECURITY DEFINER`，仓库内既有函数，**未改签名**）；清单行由 Node 侧在**同一事务**里、`COMMIT` 之前紧跟一条 `INSERT … ON CONFLICT DO NOTHING` 写入：

1. `pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout='4s'`；
2. `SELECT public.request_account_deletion($1..$9)`（账号转 `deletion_pending` + 撤会话 + 注销请求落库）；
3. 每必需模块一行：`snapshotOwner(ownerId, client)`（同快照读行 id）→ `normalizeObjectRefs` → 规范 JSON + sha256 → `INSERT`（`retention_until` = 入参 `backupDueAt`，`created_at=covered_through=requestedAt`，`state='pending_purge'`）；
4. `COMMIT`。

失败语义：第 3 步抛错 ⇒ `ROLLBACK` ⇒ 受理行、账号状态、会话撤销、清单行**全部**回滚 ⇒ 路由抛 `PROVIDER_UNAVAILABLE`(503, `retryable:false`) ⇒ **202 不签发**（真 PG 集成臂「清单写入失败」实测：`deletion_requests` 0 行、清单 0 行、`users.state` 仍 `active`）。

0 对象模块也必须写一行：`payload = {"object_refs":[],"records":0}`、摘要照算。**空集不当成功**由此变成「不可能出现 0 行」，而不是靠调用方自觉。

### 13.3 权限口径（为什么是列级、为什么不再加函数）

- `90-assert-least-privilege.sql` 的 `table_dml_allowlist` 只允许 `public.idempotency_keys` 有**表级**写入 ⇒ 新表一律**按列**授予：`SELECT (id,user_id,request_id,module,scope,state,retention_until,payload_digest,evidence_ref,purge_attempts)`、`INSERT (…)`、`UPDATE (payload,state,purged_at,evidence_ref,last_error_code,purge_attempts,updated_at)`；**无表级 DML、无 DELETE/TRUNCATE**（清单行是「清过」的唯一证据）。
- `purge_attempts` 必须在 SELECT 名单里：失败留痕写的是 `purge_attempts = purge_attempts + 1`，读右侧同样要 SELECT 权（本片实测踩到：漏授时 `UPDATE` 报 `permission denied for table user_backup_copies`，而 `failed` 行留不下来）。
- 不新增 `SECURITY DEFINER` 函数：DDL 不是状态机表，运行时要自己写、自己读、自己落证据；原子性由事务保证，而「唯一写路径」约束的是 `users`/`deletion_requests` 的**状态**写，不是本表。

### 13.4 清除路径与 R1 的落地

- **触发者（R1 定死）**：请求重放。`executeHandlers()` 对已知 `requestId` 重跑；端口每次 `purge({userId, module, requestId})` 都重读库（不缓存），先用已交付的 `evaluateBackupPurge()` 判定，再按 §7.2 分支返回三态。⛔ 不引入定时器/常驻作业/调度器。
- **完成判据**：`UPDATE … WHERE state='pending_purge' AND retention_until <= now` → **同事务内重读**复核（`remaining = 0` 且证据行 ≥ 1）→ 通过才 `COMMIT` 并回 `{outcome:'purged', evidenceRef}`；复核不过 `ROLLBACK`。
- **失败留痕范围**：复核不过或事务抛错时，把该模块所有 `pending_purge` 行置 `failed` + `last_error_code` + `purge_attempts+1`（设计只说「回滚置 failed」，未说范围；按模块整体失败更利于显式重排：否则未到期行会一直留 `pending_purge`、下次重放又走同一条死路）。留痕本身写不进时，`blocked` 的 `reason` 会写明「失败留痕未写入（先修权限/连接）」，不静默。
- **三态到回执的映射**（`user-data-deletion.ts`）：`purged` ⇒ `backup_state='completed'`（无证据则降为 `blocked/EVIDENCE_REQUIRED`，不谎称完成）；`waiting` ⇒ `pending`；`blocked` ⇒ `blocked` + 白名单内 `error_code`（白名单外折叠 `EVIDENCE_REQUIRED`）。未给 `outcome` 的旧端口按老语义回退，既有断言零改动。
- **幂等**：已全 `purged` 的模块走 `ALL_PURGED`——只复核持久行、不重写 `purged_at`、不增 `purge_attempts`，`completed` 不降级。

### 13.5 与本文草案的偏差（以代码为准）

| 项 | 草案 | 落地 | 原因 |
| --- | --- | --- | --- |
| 迁移号 | §4 写「归属 0022」 | **0023**（合流波排定 `0020`(#282)／`0021`(#279)／`0022`(#296) 之后紧接本片；本片曾先按 0023 设计，接线期因社区片当时的预判号位 `0023` 先占而临时改 `0024`，2026-10-19 合流波按派发改回 **0023**） | 合流波合并序要求本片排在三片之后；`0020`–`0022` 未落地期间断号有意，⛔ 不造占位迁移（CI 连号臂会红，见 §13.6） |
| `scope` 取值 | 「语义闭集镜像 `REPLAY_SCOPES`」，举例 `favorite`/`history` | `favorite`（favorites 模块）、`history`（history 模块） | `services/api/src/privacy/backup-replay-manifest.ts` 的 `REPLAY_SCOPES` **没有 `history`**；DDL 只校验 `^[a-z][a-z0-9_]{0,31}$` ⇒ 取设计自己举的例子，字面镜像关系不成立 |
| `lineage` | 草案未给值 | 常量 `deletion-manifest/v1` | 本片不接真实备份系统，不谎报备份额；该列只表达「谁产出的清单行」 |
| `covered_through` 与 `created_at` | 两列都要有，CHECK `covered_through <= created_at` | 两列**同值**写入（都用受理时刻） | 避开应用时钟与库 `now()` 的偏差；不放松约束 |
| 清除后 `payload_digest` | §5.3 只要求 `payload='null'` | 保留 `payload_digest` | 复核/重放要靠它独立复算证据；摘要本身不是内容 |
| `failed` 行范围 | 未写 | 该模块该请求下所有 `pending_purge` 行 | 见 §13.4 |

### 13.6 未取得项（如实登记）

| 项 | 状态与原因 |
| --- | --- |
| 「显式维护端点（仅后台能力位）」 | **未实现**。新增对外端点会改契约面（本片纪律禁止），且需要能力位/审计设计 ⇒ 本片只做「请求重放」这一半；重放的驱动者（谁持有 `requestId` 并决定何时重跑）仍在片外 |
| 进程内「扫描到期请求」的枚举器 | **未实现**。`deletion_requests` 无运行时列权限（既有最小权限口径），运行时无法自行列出到期请求 ⇒ 重放必须由外部 driver 提供 `requestId`（真库集成臂就是这样驱动的）。要补，需先设计窄口径只读函数并过最小权限断言 |
| `real` 模式整域可用 | **未翻**。`createAccountDeletionRequestService({ available: executionMode !== 'real' })` 保持：7 日在线/30 日备份的完整执行链与第三方完成证据仍未齐，本片不谎称可用（`real` 模式 POST/GET 仍 503 `PROVIDER_UNAVAILABLE`） |
| `contract-status.json` 的 blocker | **未改**。§8.2 四条前置（0023 真库可建、写入路径含 0 对象模块、端口三态接通且 `purged` 由复核产生、端到端证据）中，本片只做实了前三项与「本机真 PG 端到端」；CI 真库臂因 `0020`–`0022` 尚未落地而断号仍红（合流波合并序预期，见 `.pg17/dispatch/merge-wave-20261019.md`） ⇒ blocker 保持 |
| 真实备份介质上的逐用户清除 | **未取得**（仓内无此介质，§11 已登记）；本片只证「清单行落库 + 到期置 `purged` + `payload` 置 null + 证据可复算」 |
| 30 天真实时间流逝 | **未取得**（集成臂用脚本化时钟推进 31 天，属推算，不代表真实到期执行过） |

### 13.7 读数在哪

本片门禁读数、真 PG 集成臂的 13 组输出、未取得项与残留风险，全部列在交接文件
`.pg17/handoff/i19-backup-wiring-<HEAD7>.md`（不在仓内）。

# B4：#17 消息域 + #16 收藏/历史域 —— 「真实注销清理」收口勘察（2026-10-21）

> ## 状态更新（后续合入）
>
> 本页是 2026-10-21 早间的只读勘察，结论按基点 `f7155d5` 成立。其后三片合入（`#396`／`#397`／`#398`），**推翻了其中四条**；
> 同批的 `#399`（D4，消息域三处修复）仍在飞、证据页未进 `main`，本页**不引用**它的读数。
> 下文原文一字未删（含各节读数），只在受影响处加 `superseded` 标注；本条为唯一权威的状态更新。
>
> 1. **备份副本 scope 闭集不再只有两域**（推翻 §4 表「scope 闭集」行、§5 G8、§7 P0-2 的「messages/conversations/community 没有可清的 scope」）：
>    `#397` 把 `packages/privacy/backup-copies.mjs:42-47` 扩到四域（`favorite`／`history`／`message`／`conversation`），
>    `messages` 与 `conversations` 的 store 都补了 `snapshotOwner`（`messages/store-pg.ts:341`、`conversations/store-pg.ts:445`），
>    清单来源四对见 `services/api/src/privacy/user-data-deletion.ts:320-326`；真库臂判「四域清单行齐 ⇒ 整体 `completed`」
>    （`tests/integration/backup-purge-pg.mjs:397-465`，`#397` 提交记录报 14 组 PASS，本片未重跑）。**社区域仍无 scope**（G7 未变）。
> 2. **30 日到期清除已有驱动者**（推翻 §4.1 第 1 条、§5 G9、§7 P0-4 的「无」与「形态需指挥定」）：
>    形态定为**运维命令**，`tools/purge-expired-backup-copies.mjs`（薄 CLI）＋ `services/api/src/privacy/backup-purge-driver.ts`（扫描/编排/读数），
>    复用既有端口 `createPostgresBackupPurgePort()`，真库 14 臂 ALL PASS，详见
>    [备份副本 30 日到期清除驱动](gy-i19-backup-purge-driver-20261021.md)。「本仓仍无 `setInterval`／调度器」这条读数**继续成立**——
>    驱动刻意不做常驻定时器，真实 cron／CVM 读数仍未取得。
> 3. **消息域已补按主体清理原语，并进了注销闭集**（推翻 §3 矩阵 messages 行、§5 G1／G2／G3、§7 P0-1 的「未做」）：
>    `#390`／`#397` 在 `messages/store.ts:104-105,313-318` 与 `messages/store-pg.ts:430-437` 补 `deleteAllByOwner`／`purgeOwnerData`，
>    同一事务内 `DELETE FROM public.messages … RETURNING id`（`:230`）＋ 按 `scope` 前缀删 `public.idempotency_keys`（`:234`）。
> 4. **会话域已并入统一注销账本**（推翻 §3 矩阵会话行、§5 G5／G6、§7 P0-3 的「已建未驱动」）：
>    `#397` 按 P0-3 的**路径①**执行——`conversations` 进 `USER_DATA_DELETION_MODULES`（`user-data-deletion.ts:93-98` 四域）并注册（`:454`），
>    备份清单补 `snapshotOwner`（`conversations/store-pg.ts:445`）。
>
> **仍然有效、请照旧引用**：G4（`0019` 迁移注释宣称的级联永不触发）、G7（社区域无清理原语、无 scope）、
> G10（`real` 模式**注销 HTTP 面**整域 503，`services/api/src/app.ts:1775-1783`）、G11（审计与回执台账仍在进程内，`user-data-deletion.ts:577`）、
> §4.1 第 2 条（再受理被 `G0003` 确定性拒绝，`0016:112-114`）。
>
> **另需澄清一处口径**（本页未写错，但容易被读错）：本页 G10 说的是**注销 HTTP 面**。**消息域**的 `real` 口径是
> 「有连接池 ⇒ 接 PG；仅无池才整域 503」（`services/api/src/app.ts:752-772`，服务对象在 `pool === null` 时才置 `null`），
> 与台账 `docs/architecture/contract-implementation-status.md` 的 `listMessages` 行一致。把「real 模式消息域整域 503」写成**无条件**的句子属过期口径。
>
> 逐句对照、以及「本轮发现但不由本片改」的过期点登记，见 [E4 过期口径订正](gy-r28-e4-stale-claims-20261021.md)。
> 本轮 `gh`／`git` 读数时点：2026-10-21T14:56:42Z（在飞 PR 3 条：`#400`／`#399`／`#324`）。

## 0. 本页性质与判定口径

| 项 | 读数 |
| --- | --- |
| 基点 | `f7155d5ac1329974b20a6128e332bb84c19c733d`（`test(deploy): 补角色面与账本双条件兜底断言… (#370)`） |
| 分支 | `feat/gy-r28-b4-msg-delete-cascade`（本页只新增本文件，**未改任何源码/迁移/测试**） |
| 覆盖 issue | #17（GY-I17 消息）、#16（GY-I16 收藏/历史）、旁及 #19（注销/备份副本）、#15（社区）、#12（问答） |
| 本页工作方式 | 只读勘察 + 静态证据（`文件:行`）＋ 既有单测/集成测试清单核对。**未跑真库**，因此本页**不含**真 PG 读数 |
| 术语纪律 | 「**硬删**」= 对域表 `DELETE … RETURNING`（行真的没了，返回行数即证据）；「**软删**」= `UPDATE state/revoked_at`（行还在）。本页逐条区分，**不把软删写成硬删** |
| 硬删判定参照实现 | `services/api/src/privacy/backup-copies-pg.ts`（真实 PG 端口）＋ `services/api/src/favorites/store-pg.ts:169-183`（按主体真删的范式） |
| 是否改代码 | **否**。理由见 §6：缺口 11 处（P0 6 处、P1 3 处、P2 2 处），跨 6 个源码文件 + 1 个 `packages/**` 闭集 + 5 个既定断言文件，远超「≤3 处且都在服务层单文件」的前提 |

---

## 1. 一屏结论

1. **注销受理本身一行域数据都不删**。`request_account_deletion`（`services/api/db/migrations/0016_account_deletion_persistence.sql:68`）只做三件事：改 `users.state='deletion_pending'`+`auth_epoch+1`（`:122-128`）、撤全部会话 `sessions.revoked_at`（`:132-134`）、插 `deletion_requests` 行（`:138-145`）。**没有任何 `DELETE FROM <域表>`**。
2. 真正的域清理发生在**同一请求的处理器阶段**，而处理器闭集只有**两个域**：`favorites`、`history`（`services/api/src/privacy/user-data-deletion.ts:63-67`；注册在 `:394-395`）。
3. 所以「注销时点会被硬删」的域只有 **收藏** 与 **历史**（含各自幂等台账）。**#17 消息域一行都不会被删**，会话域、社区域同样不会。
4. 迁移 `0019` 头注释声称的「`owner_id … ON DELETE CASCADE`：注销删除主体时消息随之级联」**永不触发**：全仓 migration 里没有 `DELETE FROM public.users`（本片 §9 的命令可复现）。属**文档与事实不符**。
5. 30 日备份副本清除链：**端口是真的**（`services/api/src/privacy/backup-copies-pg.ts:250-338`，且 `#360` 已把它接进 CI 真库臂），但**只有 `favorite`/`history` 两个 scope**，且**没有任何到期驱动者**——清除只能在「再次受理」的事务里被调一次，而那时 `retention_until` 还在未来 ⇒ 恒 `waiting` ⇒ `backupState: 'pending'`。**消息/收藏/历史的 payload 里，只有收藏与历史有副本行，消息一行都没有。**
6. `real` 模式下注销 HTTP 面**整域 503**（`services/api/src/app.ts:1490-1495` `available: config.executionMode !== 'real'`，注释 `:1482-1489` 自陈理由）⇒ 真实环境**连发起注销都不可能**。
7. 缺口计数：**11 处**（G1–G11；P0 6 处 / P1 3 处 / P2 2 处；6 处 P0 在 §7 里归并为 5 条 P0 修复项）。**本片不动代码**，修复顺序见 §7。

> **superseded（2026-10-21 后续合入）**：第 3、5 条的「未做／无驱动者」已被 `#397`／`#398` 推进，逐条以页首「状态更新」块为准；
> 第 4 条（`ON DELETE CASCADE` 永不触发）、第 6 条（`real` 注销面整域 503）与第 7 条的缺口计数仍按当时读数保留、仍然成立。

---

## 2. 注销时点实际链路（逐跳，均为静态证据）

| # | 跳 | 位置 | 是否硬删 |
| --- | --- | --- | --- |
| 1 | `POST /me/account/deletion`（`userSession` 守卫） | `services/api/src/routes/account-deletion.ts:130-131` | — |
| 2 | `service.request()` → `deletion.requestDeletionFor()` + `await deletion.executeHandlers()` | `services/api/src/privacy/account-deletion.ts:225-228` | — |
| 3 | 受理事务（SECURITY DEFINER 函数） | `0016_account_deletion_persistence.sql:68` → `:122-128`（users 软改）/`:132-134`（sessions 软撤）/`:138-145`（deletion_requests 插入） | **否**（全是 UPDATE/INSERT） |
| 4 | 事务内第 2 步：写备份副本清单行 | `services/api/src/privacy/deletion-requests-pg.ts:251` `insertBackupCopySeeds(client, …)` | INSERT（不是删） |
| 5 | `executeHandlers()` 驱动协调器 | `services/api/src/privacy/user-data-deletion.ts:412-416` | — |
| 6 | 每模块处理器 | `services/api/src/privacy/user-data-deletion.ts:342-392` | **是**（`purgeOwnerData` ⇒ `DELETE … RETURNING`） |
| 7 | 备份阶段 | 同上 `:362-380` → `services/api/src/privacy/backup-copies-pg.ts:250-338` | 到期才 `UPDATE payload='null', state='purged'`（`:74-82`） |

关键旁证：

- 处理器拿不到主体，靠 `requestId → subject` 进程内映射反查（`user-data-deletion.ts:336-339`：「反查不到主体 ⇒ 绝不用空主体去清理」）。
- 证据串构形：`<module>:online-purged:<n>`，若 store 提供 `purgeOwnerData` 再追加 `;<module>:idempotency-purged:<n>`（`:357-361`）。**行数是真计数，不是估算**（`RETURNING id` 的 `rows.length`）。
- 审计只写进程内数组 `auditLog`（`:381-388`），**没有持久审计表**。
- 回执 bearer 台账是进程内 `Map`，35 日 TTL，**重启即 404**（已知缺口，`services/api/src/privacy/account-deletion.ts:58-61`）。

---

## 3. 注销时点清除矩阵

「注册」= 是否在 `USER_DATA_DELETION_MODULES` 闭集内并被 `executeHandlers()` 驱动；「原语」= store 上是否存在按主体真删的方法。

| 域 | 表 | 注销时**真删**？ | 原语（`文件:行`） | 注册进注销链？ | 备份副本 scope | 持久审计 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 收藏 #16 | `favorites` | **✅ 硬删** | `services/api/src/favorites/store-pg.ts:169-183`（`DELETE FROM favorites WHERE owner_id=$1::uuid RETURNING id`，与台账同事务） | ✅ `user-data-deletion.ts:902` | ✅ `favorite`（`packages/privacy/backup-copies.mjs:42-47`） | ❌ 仅进程内 | **真删 + 计数证据**；备份态恒 `pending`（G9） |
| 收藏幂等 | `favorites_idempotency` | **✅ 硬删** | 同上 `:175-180`（前缀 `left(scope, len+1) = $1::text\|\|chr(10)`，**不是** LIKE 模糊匹配） | ✅（随收藏域同事务） | — | ❌ | **真删** |
| 历史 #16 | `history` | **✅ 硬删** | `services/api/src/history/store-pg.ts:157-168`（同形） | ✅ `user-data-deletion.ts:903` | ✅ `history` | ❌ | **真删** |
| 历史幂等 | `history_idempotency` | **✅ 硬删** | 同上 `:164-168` | ✅ | — | ❌ | **真删** |
| 消息 #17 | `messages` | **❌ 一行不删** | **无**（`services/api/src/messages/store.ts:119` `MessagesStore` 只有 `insertMessage/getMessage/listMessagesByOwner/findByEventKey/markReadIfUnread/countUnread` + 幂等方法；`messages/store-pg.ts` 全文件无 `DELETE FROM messages`） | ❌ 不在闭集 | ❌ 无 scope | ❌ | **G1+G2**；HTTP 面无任何 `DELETE` 方法（`services/api/src/routes/messages.ts:43,53,59` 只有 GET×2 + PUT） |
| 消息幂等 | `public.idempotency_keys`（共享表） | **❌ 只按 key 过期清** | `messages/store-pg.ts:260-263`、`:288-291` 只按 `(scope,key_hash)`；**无 owner 清理** | ❌ | — | ❌ | **G3**；表无 owner 列（`0008_auth_session.sql:46-58`），只能按 `scope` 前缀删（`scope` 由 `messages/service.ts:370` `idempotencyScope(user.userId, …)` 拼，口径同 0008:40） |
| 会话 #12 | `conversations` / `conversation_turns` / `conversation_answers` | **❌ 有原语但无人调用** | `services/api/src/conversations/store-pg.ts:431-434`（`DELETE FROM conversations WHERE owner_id=$1::uuid RETURNING id`，子表靠 `0013_conversations.sql:64`（`conversation_turns.conversation_id`）与 `:105`（`conversation_answers.turn_id`）的 `ON DELETE CASCADE`） | ❌ 自建协调器**悬空**：`conversations/cascade.ts:192-203` 建好，`app.ts:1582-1583` 建出来、`:1600` 只 `decorate`；**全仓无调用点** | ❌ | ❌ | **G5**（`:1598-1599` 注释自陈「供回归测试与 GY-I19 统一编排驱动」，编排未实现） |
| 会话备份态 | — | — | — | — | ❌ | — | **G6**：`backupState` 硬编码 `'pending'`（`conversations/cascade.ts:149`） |
| 社区 #15 | `community_posts` / `community_comments` / `community_likes` / `community_reports` / `community_idempotency` | **❌ 一行不删** | **无**（`services/api/src/community/store-pg.ts` 无 `deleteAllByOwner`/`purgeOwnerData`/`snapshotOwner`） | ❌ | ❌ | ❌ | **G7**；`0022_community_persistence.sql:64,107,123,137` 全靠 `REFERENCES users(id) ON DELETE CASCADE` ⇒ 同样永不触发 |
| 用户/会话行 | `users` / `sessions` | **软改**：`state='deletion_pending'`、`revoked_at=now()` | `0016:122-134` | — | — | — | 设计如此，**不是缺口**（7 日恢复窗口需要主体行在） |
| 备份副本 | `user_backup_copies` | **到期才清 payload**（`state='purged'` + `payload='null'` + 必填证据，CHECK 见 `0023:69-76`） | `services/api/src/privacy/backup-copies-pg.ts:74-82` | ✅ 端口已接（`app.ts:1457-1471`） | 只有 `favorite`/`history` | 行内 `evidence_ref` | **G8+G9**：三个新域无 scope；到期清除无驱动者 |

**矩阵一句话**：注销链今天能证明的硬删 = **收藏 + 历史（正文与台账）**；其余四个域（messages/conversations/community）**零硬删**，且其中 conversations 属于「有刀没有手」。

> **superseded（2026-10-21 后续合入）**：本矩阵的 messages 行、消息幂等行、会话三行、会话备份态行、备份副本行已被 `#390`／`#397` 改写
> ——消息域与会话域现在都在 `USER_DATA_DELETION_MODULES` 四域内并被 `executeHandlers()` 驱动，两份 store 都有 `snapshotOwner`。
> 社区域（community）行仍如本表所述**零原语**。矩阵一句话的「零硬删」因此只对 community 成立；逐条见页首「状态更新」块。

---

## 4. 备份副本域（0023）30 天链是否覆盖 messages/favorites/history

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| 表与状态机 | `pending_purge → purged / failed`；`purged` 必须 `payload='null'` + `purged_at` + 非空 `evidence_ref` | `0023_user_backup_copies.sql:34-90`，`:69-76` |
| scope 闭集 | **只有 `favorite`、`history`** | `packages/privacy/backup-copies.mjs:42-47`；`scopeForBackupModule()` 对未登记模块**直接抛 `RangeError`**（`:62-67`） |
| 清单来源 | 装配层硬编码两对 `[favorites, favoritesStore]`、`[history, historyStore]`；任一 store 无 `snapshotOwner` ⇒ 整体不写清单行 | `services/api/src/privacy/user-data-deletion.ts:272-288` |
| favorites/history 的 payload 覆盖 | ✅ 有（`snapshotOwner` 只回行 id 与计数，不回正文） | `favorites/store-pg.ts:279-285`、`history/store-pg.ts:280-285` |
| **messages 的 payload 覆盖** | **❌ 完全没有**：无 `snapshotOwner` ⇒ `backupCopySources()` 都可能整体返回 null；即便返回，scope 闭集也没有 `message` | 同上两处 |
| 无副本行时的语义 | 如实 `blocked` + `EVIDENCE_REQUIRED`「无副本清单行，无法证明已清除」（**不读成"清完了"**） | `backup-copies-pg.ts:291-293` |
| 未到期的语义 | `outcome:'waiting'` ⇒ 处理器把 `backupState` 留 `pending` | `backup-copies-pg.ts:287-289` + `user-data-deletion.ts:362-379` |
| 到期清除的驱动者 | **无**。全仓 `services/api/src` 无 `setInterval`/调度器/worker；`deletion-aging.ts` 只有纯函数（`ONLINE_RETENTION_MS`=7 日 `:66`、`BACKUP_RETENTION_MS`=30 日 `:68`），**只算不执行** | §9 的 grep 可复现 |
| 端口真实性 | ✅ 真 PG：事务内 `BEGIN` + `UPDATE … WHERE state='pending_purge' AND retention_until <= now` + **同事务复核** + 失败留痕 `failed/EVIDENCE_REQUIRED/attempts+1`；`#360` 已把它接进 CI 真库臂 | `backup-copies-pg.ts:309-339`；`docs/verification/gy-r28-backup-purge-ci-20261021.md` |

> **superseded（2026-10-21 后续合入）**：本表「scope 闭集」「messages 的 payload 覆盖」「清单来源」「到期清除的驱动者」四行的读数已被
> `#397`／`#398` 改写：闭集现为四域（`packages/privacy/backup-copies.mjs:42-47`），`messages`／`conversations` 已有 `snapshotOwner`，
> 到期清除的执行者是运维命令 `tools/purge-expired-backup-copies.mjs`（见 [驱动证据页](gy-i19-backup-purge-driver-20261021.md)）。
> 「未到期的语义」「无副本行时的语义」「端口真实性」三行仍准确。

### 4.1 为什么「30 天链」在生产不可达（三段断点，逐段独立成立）

1. **无调度**：清除函数只有调用方是「受理事务 + 处理器」（`account-deletion.ts:225-228`），GET 回执（`routes/account-deletion.ts` 第二个 operation）**不执行**处理器。
2. **再受理被确定性拒绝**：`request_account_deletion` 对 `state='deletion_pending'` 直接 `RAISE … ERRCODE='G0003'`（`0016:112-114`）⇒ 同一账号「再发一次注销」以触发到期清除，在生产 PG 上**必然失败**。
3. **即便调得动，也没有可清的 scope**：messages/conversations/community 无副本行；favorites/history 有行但只能在第 1 段那种调用里被清。测试里之所以能验证 31 天清除，靠的是**注入时钟 + 内存 store + 替身 requests**（`tests/integration/backup-purge-pg.mjs:470,477,625,688,733` 的 `advanceDays` 与 `:418,535,582,617,668,717` 的多套 `createPostgresBackupPurgePort({ pool, now: () => clockX.now() })`；原记 :440,447,536,597），**不经过真实受理函数**。

> **superseded（2026-10-21 后续合入）**：第 1 段与第 3 段已被推翻——`#398` 补了**不经过受理函数**的驱动（运维命令 + `backup-purge-driver.ts`，
> 只读 `user_backup_copies`、只调 `BackupPurgePort`），`#397` 把可清 scope 补到四域。**第 2 段（`G0003`）仍成立**，
> 而新驱动正是为绕开它设计的。详见 [驱动证据页](gy-i19-backup-purge-driver-20261021.md) §1。

---

## 5. 缺口清单（G1–G11）

优先级口径：**P0** = 让「注销清干净」这件事在任何环境下为假或不可达（阻塞 #16/#17 的真实收口）；**P1** = 覆盖不全但与 P0 无先后依赖的域；**P2** = 证据/台账/文档订正。

> **superseded（2026-10-21 后续合入）**：下表 G1／G2／G3（`#390`／`#397`）、G5／G6（`#397` 路径①＋快照原语）、G8（`#397` 四域 scope）、
> G9（`#398` 驱动）**六项的「未做」状态已被推进**，逐条见页首「状态更新」块。**仍有效**：G4、G7、G10、G11。
> 表内措辞保留为当时读数，不据此主张缺口仍全数存在。

| 编号 | 优先级 | 缺口 | 位置（`文件:行`） | 影响（用词严格） |
| --- | --- | --- | --- | --- |
| **G1** | P0 | 消息域**没有按主体清理原语** | `services/api/src/messages/store.ts:119`（接口无 purge/deleteAll）；`services/api/src/messages/store-pg.ts` 全文无 `DELETE FROM messages` | 注销后 `messages` 行**原地保留**；无任何计数可作证据 |
| **G2** | P0 | 消息域**未进注销模块闭集** | `services/api/src/privacy/user-data-deletion.ts:63-67`（`USER_DATA_DELETION_MODULES`）、`:394-395`（只注册两个 handler） | 即使有原语也不会被 `executeHandlers()` 驱动 |
| **G3** | P0 | 消息幂等台账**无按主体清理**（共享 `public.idempotency_keys`，该表**没有 owner 列**） | `messages/store-pg.ts:232-292`；表结构 `0008_auth_session.sql:46-58`；scope 拼法 `messages/service.ts:370` | 注销后同主体消息请求的幂等记录仍在（含 `outcome={"kind":"message","id",…}` 引用），保留 5 分钟 TTL 内的可重放引用；**必须**按 `scope` 前缀删（范式见 `favorites/store-pg.ts:163-167` 注释） |
| **G4** | P2 | 迁移注释**宣称**的重删机制永不触发 | `0019_messages_persistence.sql:24-25`（「注销删除主体时消息随之级联删除」）；全仓 migration 无 `DELETE FROM public.users` | 读注释会以为消息域已覆盖注销 ⇒ **文档与事实不符**（见 §8） |
| **G5** | P0 | 会话域注销协调器**已建未驱动** | `conversations/cascade.ts:192-203`；`app.ts:1582-1583`、`:1600`（只 decorate）；注释 `:1598-1599` | 会话/轮次/回答**一行不删**；`conversations:online-purged` 证据不存在 |
| **G6** | P1 | 会话域备份态硬编码 `pending` 且无 scope | `conversations/cascade.ts:149`、`:132` 注释（「属 GY-I19」） | 即便接线，回执也永远 `blocked/pending`（诚实，但不可完成） |
| **G7** | P1 | 社区域**无清理原语、无注册** | `services/api/src/community/store-pg.ts`（零命中）；`0022:64,107,123,137` | 帖子/评论/点赞/举报行保留；`community_idempotency`（`0022:178`）同样保留 |
| **G8** | P1 | 备份副本 scope 闭集只有两域 | `packages/privacy/backup-copies.mjs:42-47`、`:56-61`；`user-data-deletion.ts:272-288` | messages/conversations/community **没有副本清单行** ⇒ 30 天链对它们「无对象可清」（且不是"清完了"） |
| **G9** | P0 | 30 日到期清除**无驱动者**；再受理被 `G0003` 拒 | §4.1；`0016:112-114`；`deletion-aging.ts:66,68`（只算不执行） | 生产环境 `pending_purge` 行**永久滞留**；`backupState` 永远到不了 `completed` |
| **G10** | P0 | `real` 模式注销 HTTP 面**整域 503** | `app.ts:1490-1495`（`available: config.executionMode !== 'real'`）；注释 `:1482-1489` | 真实环境**无法发起注销**——这是当前最诚实的实现（不假装删除），但也就是「真实注销清理」尚未成立的总闸 |
| **G11** | P2 | 审计不持久 + 回执台账进程内 | `user-data-deletion.ts:381-388`（`auditLog` 数组）；`account-deletion.ts:58-61`（Map + 35 日 TTL，重启 404） | 清理行数/阻断原因**重启即失**；无法向用户或监管出示 30 日证据链 |

**为什么本片不动代码**：G1+G2+G3 是「一个域的三步」，看似可以一处收口，但实际要同时改 `messages/store.ts`（接口）、`messages/store-pg.ts`（原语）+ `privacy/user-data-deletion.ts`（闭集、清单来源、注册）+ 5 个既定断言文件（`tests/unit/user-data-deletion.test.mjs:56-57`、`tests/unit/conversation-deletion.test.mjs:214-215`、`tests/unit/favorites-history-deletion-registration.test.mjs:128-129`、`tests/unit/account-deletion-receipts.test.mjs:107,125`、`tests/unit/gy-i22-secmatrix.test.mjs:789`、`tests/integration/account-deletion-http.mjs:273`），再加 `packages/privacy` 的 scope 闭集与 G5 的编排接线。**缺口 11 处、跨 6 个源码文件 + 1 个包闭集 + 5 处断言**，不满足任务给出的「≤3 处且都在服务层单文件可改」前提。

### 5.1 本片复核的现状（2026-10-21T14:56:42Z 只读核对，只读代码，不改上表）

| 缺口 | 现状 | 依据 |
| --- | --- | --- |
| G1 消息域原语 | **已补**：`deleteAllByOwner`／`purgeOwnerData`，同一事务内删正文 + 幂等台账 | `services/api/src/messages/store-pg.ts:230,234,430,437`；`messages/store.ts:313-318` |
| G2 消息域进闭集 | **已补**：四域闭集 + 注册 | `services/api/src/privacy/user-data-deletion.ts:93-98,449` |
| G3 消息幂等台账 | **已补**：按 `scope` 前缀删（非 LIKE） | `messages/store-pg.ts:234` |
| G5 会话域编排 | **已补**：并入统一账本（P0-3 路径①） | `user-data-deletion.ts:93-98,454`；`conversations/store-pg.ts:432` |
| G6 会话备份态 | **已补**：`snapshotOwner` + `conversation` scope | `conversations/store-pg.ts:445`；`packages/privacy/backup-copies.mjs:42-47` |
| G8 备份 scope 闭集 | **已补到四域**：favorite／history／message／conversation | `packages/privacy/backup-copies.mjs:42-47` |
| G9 到期驱动者 | **已补**：运维命令 + 驱动模块（真实 cron 未接） | `tools/purge-expired-backup-copies.mjs`；`services/api/src/privacy/backup-purge-driver.ts` |
| G4 迁移注释 | **未变**：`0019:24-25` 仍宣称级联 | `services/api/db/migrations/0019_messages_persistence.sql:24-25` |
| G7 社区域 | **未变**：零原语、零 scope | `services/api/src/community/store-pg.ts`（无 `purgeOwnerData`／`deleteAllByOwner`／`snapshotOwner`） |
| G10 real 注销面 503 | **未变**（按 P0-5 的顺序，应最后放开） | `services/api/src/app.ts:1775-1783` |
| G11 审计/回执持久化 | **未变**：`auditLog` 仍是进程内数组 | `user-data-deletion.ts:577` |

---

## 6. 与「硬删」相关的三个必须澄清的判断

1. **不要把 `0019` 的 `ON DELETE CASCADE` 当成交付**。它只在删 `users` 行时生效，而注销**不删 users 行**（只改 `state`），也不该删：`deletion_requests.request_id` 是 `ON DELETE RESTRICT`（`0023:37`）、7 日在线窗口与回执审计都需要主体行在。用外键级联冒充注销清理 = 谎报。
2. **会话域的 `deleteAllByOwner` 是真的**（`DELETE … RETURNING`），但**没人调它**。所以 `conversations` 的正确描述是「有原语、无驱动」，不是「已清理」。
3. **社区域的 `ON DELETE CASCADE` 永远等不到触发**。要真清必须显式删：`community_posts`（`author_id`）→ 子评论随 `post_id` 级联（`0022:106`）；再删 `community_comments`（`author_id`）、`community_likes`（`user_id`）、`community_reports`（`reporter_id`）、`community_idempotency`（scope 前缀）。`community_moderation_decisions`（`0022:158`）属**审核留痕**，删不删需产品/合规签核——本页**不下结论**，列为待决项。

---

## 7. 修复建议（按优先级排序；含 migration 判定）

### P0-1 消息域补「按主体真删」原语（G1＋G3）

> **superseded（2026-10-21）**：**已落地**（`#390` 起、`#397` 收口）。原语在 `services/api/src/messages/store.ts:104-105,313-318` 与
> `messages/store-pg.ts:430-437`；两条 `DELETE`（正文 `:230`、幂等台账 `:234`）在**同一事务**内，和本段下面的范式一致（不含 `LIKE`）。
> 下列「建议」原文保留，供追溯当时的写法依据。

- 文件：`services/api/src/messages/store.ts`（接口加可选 `deleteAllByOwner`/`purgeOwnerData`）、`services/api/src/messages/store-pg.ts`（新方法）。
- 范式照 `services/api/src/favorites/store-pg.ts:169-183`：同一 `withTransaction` 里 ① `DELETE FROM messages WHERE owner_id = $1::uuid RETURNING id` ② `DELETE FROM public.idempotency_keys WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10) RETURNING scope`。
- **migration：不需要**。`idempotency_keys` 已有 `(scope,key_hash)` 唯一索引（`0008:57`），前缀删走主索引即可；不新增表/列。
- 注意：内存实现（`messages/store.ts:177-284`）也要同步补，否则非 real 模式注册后会走 `deleteAllByOwner` 缺失分支。

### P0-2 把 `messages` 注册进注销闭集（G2＋G8 的一半）

> **superseded（2026-10-21）**：**已落地**（`#397`）。`USER_DATA_DELETION_MODULES` 现为四域（`user-data-deletion.ts:93-98`），
> `BACKUP_COPY_SCOPES` 增 `messages: 'message'`／`conversations: 'conversation'`（`packages/privacy/backup-copies.mjs:42-47`），
> `snapshotOwner` 见 `messages/store-pg.ts:341`。本段列的 5 处既定断言没有放宽，而是按「只加强」改写（逐条见 `#397` 提交记录）。

- `services/api/src/privacy/user-data-deletion.ts:63-67`（加 `MESSAGES_DELETION_MODULE = 'messages'` 与 `USER_DATA_DELETION_MODULES`）、`:272-288`（`backupCopySources()` 的 `pairs` 加一对）、`:394-395`（`registerModule`）。
- `packages/privacy/backup-copies.mjs:42-47`（`BACKUP_COPY_SCOPES` 加 `message: 'message'`）；`:56-61` 不再抛。
- `services/api/src/messages/store-pg.ts` 需补 `snapshotOwner(ownerId, client)`（只回行 id 与计数，照 `favorites/store-pg.ts:279-285`）。
- **migration：不需要**。`0023:55-58` 的 `module`/`scope` 只是正则形状 CHECK（`^[a-z][a-z0-9_]{0,31}$`），`message` 合法。
- **必须同步放宽的既定断言**（不改就会被闭集锁死）：`tests/unit/user-data-deletion.test.mjs:56-57`、`tests/unit/favorites-history-deletion-registration.test.mjs:128-129`、`tests/unit/account-deletion-receipts.test.mjs:107,125`、`tests/unit/gy-i22-secmatrix.test.mjs:789`、`tests/integration/account-deletion-http.mjs:273`。放宽方式建议：断言由「逐字 `['favorites','history']`」改为「等于 `USER_DATA_DELETION_MODULES` 且包含 `favorites`/`history`/`messages`」，仍保留闭集性。

### P0-3 驱动会话域协调器（G5）

> **superseded（2026-10-21）**：**已按本段建议的路径①落地**（`#397`）——`conversations` 并入 `USER_DATA_DELETION_MODULES`
> （`user-data-deletion.ts:93-98`，注册 `:454`），`conversations/cascade.ts` 的自建闭集降级为「单域离线/单元验证」用途；
> `tests/unit/conversation-deletion.test.mjs` 里那条「闭集不含 conversations」的反向锁已改为更强的正向断言。

- 现成件已在：`conversations/cascade.ts:192-203` + `app.ts:1582-1583`。
- 接线点在注销受理处：`services/api/src/privacy/account-deletion.ts:225-228` 之后再驱动一次 `conversationDeletion.executeHandlers(<同一 requestId>)`——但注意两套协调器各有自己的 `createDeletionRequest`（`cascade.ts:161-167`），**同一 `requestId` 不能跨协调器复用**，因此正确做法要么 ① 把 `conversations` 并入 `USER_DATA_DELETION_MODULES`（G2 那条路的扩展，同时删掉 `cascade.ts` 的自建闭集），要么 ② 在注销服务里为会话域单开一个 request 并把两份回执合并进 `handlers[]`。
- 建议 ①：改动更小且消掉「自建闭集」这个历史妥协；代价是 `tests/unit/conversation-deletion.test.mjs:214-215`（断言 `USER_DATA_DELETION_MODULES` 不含 `conversations`）必须改写，且要说明理由。

### P0-4 30 日到期清除的驱动者（G9）

> **superseded（2026-10-21）**：**已落地**（`#398`），形态定为**运维命令**（非进程内定时器、非内部维护端点）：
> `tools/purge-expired-backup-copies.mjs` + `services/api/src/privacy/backup-purge-driver.ts`，绕过受理函数、只读写 `user_backup_copies`；
> 真库 14 臂 ALL PASS。详见 [备份副本 30 日到期清除驱动](gy-i19-backup-purge-driver-20261021.md)（其 §8 列出仍未接线的事项：
> 真实 cron／CVM 读数、回执 `backupState` 接线）。本段末尾「形态需指挥定」一问已有结论，原文保留为当时记录。

- 端口可直接复用 `createPostgresBackupPurgePort({ pool, now })`（`backup-copies-pg.ts:183-189`；装配见 `app.ts:1457-1471`）。
- 需要一个**不经过 `request_account_deletion`** 的驱动入口（否则必撞 `G0003`，`0016:112-114`）：按 `(request_id, module, user_id)` 扫 `user_backup_copies WHERE state='pending_purge' AND retention_until <= now()`（索引已备：`0023:88-90`），逐组调 `port.purge({ userId, module, requestId })`；`failed` 行需显式重排（端口对 `failed` 明确返回 `blocked/STORE_REJECTED`，`backup-copies-pg.ts:283-285`）。
- **migration：不需要**（索引已在）。
- 形态（进程内定时 vs 运维手工 vs 外部 cron 调受保护端点）需指挥定；本页只登记「必须有，且不能靠再受理」。

### P0-5 才轮到 `real` 模式放开（G10）

- `app.ts:1490-1495` 的 503 在 **P0-1…P0-4 完成前是正确的**：真实链路不完整时接线 = 假装删除。顺序必须是「先补齐 → 再放开 → 再验收」。**不得**为了「让真机页面能点注销」先放开。

### P1-1 社区域补原语（G7）

- `services/api/src/community/store-pg.ts` 新增 `purgeOwnerData`：`DELETE FROM community_posts WHERE author_id=$1 RETURNING id`（子评论随 `post_id` 级联，`0022:106`）＋ `community_comments(author_id)` + `community_likes(user_id)` + `community_reports(reporter_id)` + `community_idempotency` 的 scope 前缀删。
- 待决：`community_moderation_decisions`（`0022:158`）是否随注销清空——**需产品/合规签核**，不要擅自删审核留痕。
- **migration：不需要**。

### P2-1 持久审计（G11）
把 `auditLog` 落表（模块/请求/主体/在线行数/备份态/时刻），并让 30 日清除写同一条链，供回执审计与复算。**这是唯一可能需要新表的一项**；若做，号位需在合并时重新确认（本片基点上最大为 `0026_speech_persistence.sql`），**本片不加**。

### P2-2 回执台账持久化（G11）
进程内 `Map` + 35 日 TTL ⇒ 重启 404（`account-deletion.ts:58-61`）。落库或加密外部存储需单独设计（含 bearer 明文不落库的硬约束）。

### P2-3 文档订正（G4）
`0019_messages_persistence.sql:24-25` 与 `conversations/cascade.ts:132` 的措辞要改成「外键级联只在删 `users` 行时生效；注销链不删 `users` 行，消息清理由 `<本片或后续片>` 显式执行」或明确标 `未实现`。

---

## 8. 台账/文档滞后登记（只登记，本片不改）

| 位置 | 现措辞 | 与本页读数的关系 |
| --- | --- | --- |
| [README 历史快照（本页基点 f7155d5，#17 行）](https://github.com/GengYunChuChao/GengYun/blob/f7155d5ac1329974b20a6128e332bb84c19c733d/README.md#L222) | 「真实事件／目标端口、**PG 注销清理**与真机页面待验收」 | **方向正确**；本页把它落成 11 条可核缺口，并指出「注销清理」当前不是"待验收"而是"未实现"（G1–G3） |
| [README 历史快照（本页基点 f7155d5，#16 行）](https://github.com/GengYunChuChao/GengYun/blob/f7155d5ac1329974b20a6128e332bb84c19c733d/README.md#L221) | 「收藏／历史已落 PG…真机页面证据未取得」 | 少记了一条**已达成**的事实：收藏/历史在注销链里是**真删**（`favorites/store-pg.ts:169-183`、`history/store-pg.ts:157-168`）。属滞后（漏记好事），非缺陷 |
| [README 历史快照（本页基点 f7155d5，#19 行）](https://github.com/GengYunChuChao/GengYun/blob/f7155d5ac1329974b20a6128e332bb84c19c733d/README.md#L224) | 「仍缺 7／30 日到期的**真实执行**」 | 与本页 G9 一致；本页补上「再受理会被 `G0003` 拒」这条**机制性**原因 |
| `docs/architecture/contract-status.json:2038`（#17 blocker） | 「真实事件/目标端口、PG/注销及页面/Android仍待验收」 | 与本页一致，不需改 |
| `docs/verification/gy-issue-closure-index-20261018.md:178-255`（§1.5 #16 / §1.6 #17） | 两条的 C1–C4 判据只覆盖域层/HTTP 行为，**没有一条判据看注销清理** | 这正是本页补的口子：关闭材料里应新增一条 C5「注销时点该域行被硬删且行数入证据」，判据可直接引用 §3 矩阵 |

> **superseded（2026-10-21 后续合入）**：本表第 1～3 行的 README 行已被 `README.md` 的 2026-10-21 口径订正改写
> （「PG 注销清理待验收」拆成事实与缺口、「仍缺 7／30 日真实执行」改为「备份侧已有驱动、真实 cron 未接」）；
> 第 4 行的台账行号已漂移（`requestAccountDeletion` 现 `:410`），文案仍是旧口径，属生成区滞后。
> 逐句对照见 [E4 过期口径订正](gy-r28-e4-stale-claims-20261021.md)。

---

## 9. 复现命令（全部只读；本机 PowerShell）

> **superseded（2026-10-21 后续合入）**：下面第 3、4、7、8 条的「预期」已随后续合入反转——
> 闭集现为四域、消息域已有清理原语、scope 闭集现为四域、且确实存在一个（非定时器形态的）到期驱动。
> 现行复现命令与预期见 [E4 过期口径订正](gy-r28-e4-stale-claims-20261021.md) §3；本段原文保留为当时读数的取证脚本。

```powershell
# 1) 注销受理函数里没有任何域表 DELETE（预期：0 命中）
Select-String -Path services/api/db/migrations/0016_account_deletion_persistence.sql -Pattern 'DELETE FROM'

# 2) 全仓 migration 没有 DELETE FROM users（预期：0 命中 ⇒ 0019 的 CASCADE 永不触发）
Select-String -Path services/api/db/migrations/*.sql -Pattern 'DELETE\s+FROM\s+(public\.)?users'

# 3) 注销模块闭集只有两个域（预期：'favorites' 'history'）
Select-String -Path services/api/src/privacy/user-data-deletion.ts -Pattern 'USER_DATA_DELETION_MODULES' -Context 0,4

# 4) 消息域没有按主体清理原语（预期：messages/ 下无 purgeOwnerData/deleteAllByOwner、无 DELETE FROM messages）
Select-String -Path services/api/src/messages/*.ts -Pattern 'purgeOwnerData|deleteAllByOwner|DELETE FROM messages'

# 5) 会话协调器只在 app.ts 出现、无调用点（预期：app.ts 3 处 + 类型声明）
Select-String -Path services/api/src/**/*.ts -Pattern 'conversationDeletion|createConversationDeletion'

# 6) 社区域无清理原语（预期：0 命中）
Select-String -Path services/api/src/community/store-pg.ts -Pattern 'purgeOwnerData|deleteAllByOwner|snapshotOwner'

# 7) 备份 scope 闭集（预期：只有 favorite / history）
Get-Content packages/privacy/backup-copies.mjs | Select-String -Pattern 'BACKUP_COPY_SCOPES' -Context 0,6

# 8) 无到期驱动者（预期：services/api/src 下无 setInterval / scheduler 删除驱动）
Select-String -Path services/api/src/**/*.ts -Pattern 'setInterval|createScheduler|purgeWorker'

# 9) 既有断言（闭集锁；改动前必读）
node --test tests/unit/user-data-deletion.test.mjs tests/unit/conversation-deletion.test.mjs tests/unit/favorites-history-deletion-registration.test.mjs tests/unit/account-deletion-receipts.test.mjs
```

---

## 10. 未取得（本页不得据以推断已通过）

- **真 PG 读数**：本页未起 `pg17`，故 `favorites`/`history` 的硬删「行数证据」只有**实现+既有单测/真库臂登记**支撑（`tests/unit/favorites-history-store-pg.test.mjs:230-250`、`tests/integration/favorites-history-pg.mjs:366-370`），本页不重跑。
- **`messages` 真库注销臂**：不存在（本片未实现 G1–G3）。任何「消息域已支持注销清理」的说法都无证据。

> **superseded（2026-10-21 后续合入）**：`#397` 已补原语与闭集，并在 **PGlite 真表**（注入 `0008`＋`0019`／`0013` 迁移集）上断言
> 「注销后本主体 `messages` 0 行、他人 1 行、共享台账按 scope 前缀删到 0」。**真 PG17 上的行数读数仍不存在**，
> 所以本条的实质结论（不得据无读数声称已通过）继续成立，只是「未实现 G1–G3」已过期。
- **真机证据**：#16 的真机页面证据（`docs/verification/platform-checklist.md:40` 状态列「未验证」）与 #17 的真机页面/Android 均**未取得**，本页不涉及。
- **30 日真实时间验证**：只能靠注入时钟（`tests/integration/backup-purge-pg.mjs`），真实 31 天等待未做，也不该在本片做。
- **`community_moderation_decisions` 的注销去留**：待产品/合规签核，本页不判。

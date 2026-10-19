# GY-I17 消息域 PostgreSQL 持久化 · 证据（2026-10-18）

- 工作树 `E:\GengYunCommander\.pg17\wt-messages-pg`，分支 `feat/gy-i17-messages-pg`，基线 `upstream/main = 60aa9ad8f582c3145955226e572576e0dee045ca`。
- 本页只记录**本机实跑读数**；未跑的一律在「未取得」里点名，不得读成通过。
- 真库集群：便携 PostgreSQL 17.11（`E:\GengYunCommander\.pg17\pgsql\bin`），`initdb -U postgres -A trust --encoding=UTF8 --locale=C`，仅回环 `127.0.0.1:55611`，库名硬钉 `gengyun_messages_test`，跑完 `pg_ctl -m fast stop`。注：55394–55493 是 Windows 保留端口段，首次 `55447` 绑定被拒（`could not bind IPv4 address "127.0.0.1": Permission denied`），改用段外端口才起得来。

## 1 迁移 `0019_messages_persistence.sql`

对象读数（真 PG 17.11，`to_regclass` / `pg_constraint` / `information_schema.columns` 实查）：

| 读数 | 期望 | 实测 |
| --- | --- | --- |
| `public.messages` | 存在 | `messages` |
| `public.messages_owner_created_idx` | 存在 | `messages_owner_created_idx` |
| `(owner_id, event_key)` 唯一约束 | 1 条 | 1 |
| `messages` 上的 CHECK | 4 条 | 4 |
| `messages` 列数 | 8 | 8 |
| `public.idempotency_keys`（0008） | 仍在 | 仍在 |
| ROLLBACK 之后 `messages` | 不存在 | `null` |
| ROLLBACK 之后 `users` / `idempotency_keys` | 仍在 | 仍在 |
| REPLAY 之后 `messages` | 存在 | `messages` |

- 表结构：`id uuid` 主键、`owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE`、`type text`（CHECK 闭集 `comment|like|moderation|system`）、`target_ref jsonb`（CHECK 为 NULL 或 `jsonb_typeof = 'object'`）、`read_at timestamptz`、`created_at timestamptz NOT NULL DEFAULT now()`、`revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)`、`event_key text`（CHECK 非空）。
- 索引 `messages (owner_id, created_at DESC, id DESC)` 与列表排序口径逐字同序。
- 回滚 `rollback/0019_messages_persistence.down.sql`：`DROP INDEX IF EXISTS` → `DROP TABLE IF EXISTS`，不触碰 `users`、`idempotency_keys` 与任何他人对象。

## 2 三条硬约束的实现位置

| 约束 | 位置 | 做法 |
| --- | --- | --- |
| 重复判定只由数据库唯一约束 | `services/api/src/messages/store-pg.ts:139` | 单条 `INSERT … ON CONFLICT DO NOTHING RETURNING id`，看有无返回行判 `inserted` / `duplicate`；没有 `SELECT` 前置 |
| 标记已读是单条原子 UPDATE | `services/api/src/messages/store-pg.ts:186` | 一条 `UPDATE … SET read_at = $3, revision = revision + 1 WHERE id = $1 AND (…) AND read_at IS NULL RETURNING …`；成功路径总共只发这一条语句 |
| 未读数是派生量 | `services/api/src/messages/store-pg.ts:215` | `SELECT count(*) … WHERE owner_id = $1 AND read_at IS NULL`；没有计数器列，也没有任何写回 |
| real 且 pool 非空才接线 | `services/api/src/app.ts:693` | `real` + `pool !== null` ⇒ `createPostgresMessagesStore({ pool })`；`real` + `pool === null` ⇒ 维持 `null`（整域 503，语义未变） |

补充两条如实登记：

- `getMessage(id)` 的接口形状**没有 owner 形参**（`services/api/src/messages/store.ts:85`），改签名属派单停手条件，故该单条读按 id 取行；归属判定在同一请求内由服务层完成（`services/api/src/messages/service.ts:380` 取回后比对 `owner_id`，不符与不存在同形 404）。列表、未读计数、事件键去重、标记已读四条路径的 SQL 都带 `owner_id` 谓词。
- 幂等台账复用 0008 的 `public.idempotency_keys`（`scope` 已编码主体，`key_hash bytea`），未另建 `message_idempotency` 表；`claim / complete / release` 各自单语句原子（`ON CONFLICT … DO NOTHING RETURNING`、`AND outcome IS NULL RETURNING`、`DELETE … AND outcome IS NULL`）。

## 3 真库实跑读数（原文）

```text
[M] 迁移清单 18 个，版本号无重复且严格递增，末项 0019
[M] UP：messages 表 / 列表索引 / (owner_id,event_key) 唯一约束 / 4 个 CHECK / 8 列 全部出现
[M] ROLLBACK：本片对象全部消失，users 与 idempotency_keys 逐字仍在
[M] REPLAY：同一份 UP 再执行一次仍然成功，messages 再次出现
[0] 用户 A cbdb28ad-5b42-4dd0-b3d5-b177aa51ec8b / 用户 B 6d484dcb-ed6d-4060-ae67-2059efb1e59e 已在 users 表落库，会话走真实 PG
[D] 同 (owner_id,event_key) 与同 id 两条重复路径都返回 duplicate，A 的行数始终 1
[R] 首次标记 200/revision=2/read_at 非空；再次标记 200 空操作（revision、read_at 不变）；同幂等键重放 200
[N] 他人消息与不存在同形：NOT_FOUND / 404，B 的列表为 0 条
[C] 并发 20 → 200×1 / 409×19；最终 SELECT revision = 2，read_at 非空
[U] countUnread=7 = 逐行统计=7 = 列表未读行数，三处一致
[P] limit=3 翻 3 页，id 序列与 SQL (created_at DESC, id DESC) 逐项相等，无重复无遗漏
[√] ALL PASS：消息域 PostgreSQL 持久化端到端（迁移/重复/已读/归属/并发/派生计数/分页）
```

并发标记的读数逐项：20 条 PUT 同时打同一条未读消息（各自不同 `Idempotency-Key`，同一 `If-Match: "1"`）⇒ 恰好 1 条 200（`ETag "2"`）、19 条 409 `REVISION_CONFLICT`；`SELECT revision, read_at` 收敛为 `revision = 2`、`read_at` 非空，即**只推进一次版本**。

## 4 语句形状（不连库的机械证据）

`tests/unit/messages-store-pg-contract.test.mjs` 用记录型假池逐条抓 `(text, values)`：16 例全绿（`tests 16 / pass 16 / fail 0`）。其中三条是本次的判定核心：

- 标记已读的**成功路径总共只有 1 次查询**（脚本用尽即抛，多查一条就红），且文本含 `AND read_at IS NULL`、`revision = revision + 1`、`RETURNING`，无 `FOR UPDATE`。
- 插入冲突路径（0 行）每轮**只有 1 条 INSERT**，文本含 `ON CONFLICT DO NOTHING RETURNING`，且整条语句里没有 `SELECT`。
- 未读数查询无 `update|insert|delete` 字样，锚在 `WHERE owner_id = $1::uuid AND read_at IS NULL`。

## 5 边界与未取得

- 跨文件登记（只增不改）：新真库脚本按仓内既有规则登记进 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 白名单并写明原因（该文件要求 `tests/integration/*.mjs` 要么进无 PG 回环链、要么显式声明）；既有 15 条白名单条目与全部断言一条未改。
- 未取得 真机（微信端）读数：本片只覆盖后端 HTTP 契约，客户端未改也未在真机跑。
- 未取得 后台推送（写消息的调用方）：消息写入仍由服务内部 `appendMessage` 驱动，本片不接线推送通道。
- 未取得 `>1 万行` 规模：本片用 9 条消息验证语义与游标，未做万行级基准。
- 未取得 跨库恢复演练：只验证单库内迁移 UP/ROLLBACK/REPLAY，未做备份恢复演练。
- 未取得 `tests/integration/account-suspend-pg.mjs` 的绿读数：该脚本写死「`0017` 必须是目录最大号」并「除 `0017` 外全跑」，属单迁移专用硬编码，加入 `0019` 后必红；经指挥裁定，该文件的收口权独占给账号读面片（其 `0021` 依赖 `0017` 的函数，需要更彻底的循环改造），本片**一字未改**该文件，故本片不跑它。
- 未取得 `tests/integration/migrations-negative-pg.mjs` 的「无缺号」读数：本片占 `0019`，而 `0018` 属在途 PR #272 尚未合并 ⇒ 当前分支按设计缺号，该脚本必红，本轮**不跑**。合并顺序应为 #272（0018）→ 本片（0019）→ 开关片（0020）→ 账号片（0021）。

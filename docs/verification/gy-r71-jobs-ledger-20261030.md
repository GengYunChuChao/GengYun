# R71 · 统一作业台账 `public.jobs` 的写入点（四源接入 · 单事务 · 幂等）

- 分支：`feat/gy-r71-jobs-ledger`（基线 `upstream/main` = `8b646ae1`，先复核过）。
- 本片**零迁移、零新表**：`public.jobs` 由 `0001` 建好，DDL 一个字节没动；变的是**写入者**。
- 一句话结论：`public.jobs` 从「全仓零 INSERT」变成「**恰一个**写入点（`jobs/ledger.ts` 的一条
  `ON CONFLICT (id)` upsert）、四个作业源在与源表**同一个事务**里写它、两个源因为**结构上没有
  可同事务写的作业行**而如实不接」；读面一个都没动。

---

## 1 取证（基线 `8b646ae1`）

### 1.1 两条复核 grep（在 `8b646ae1` 上跑）

| # | 命令 | 实测 |
|---|---|---|
| ① | `git grep -n "INSERT INTO public.jobs\|INSERT INTO jobs" 8b646ae1 -- services` | **零条语句级命中**，只有 2 条**注释**（迁移头注在引用这句 grep 判据本身） |
| ② | `git grep -n "public\.jobs" 8b646ae1 -- services/api/src` | 只有 `services/api/src/admin/ops/jobs-pg.ts:4` 与同一段注释里的 `:5`——是**解释「为什么读三张域内表而不是它」**的注释，不是读语句 |

② 的结论要说得更硬一点：基线**没有任何一条生产 SQL 读 `public.jobs`**（无 `FROM public.jobs`）。
`/admin/jobs` 读的是 `ocr_jobs` / `recognition_jobs` / `speech_jobs`；`GET /jobs/{id}` 走
`services/api/src/jobs/registry.ts` 与各域 `JobSourcePort`。全仓能读到它的地方只有两类：
迁移 `0001` 的 DDL、以及真库/集成脚本里的 `to_regclass('public.jobs')` 存在性断言。

### 1.2 DDL 逐列（`services/api/db/migrations/0001_initial_schema.sql:203-230`）

⚠ 派单说「表存在（迁移 `0013`）」，实测**建表语句在 `0001`**；`0013` 只是**头注**里写了
「`jobs` 表（0001）在代码里没有任何写入者」这句裁定（`services/api/db/migrations/0013_conversations.sql:19`）。
本页按实测写，两种说法都指同一张表。

| # | 列 | 类型 / 约束 | R71 写入值 |
|---|---|---|---|
| 1 | `id` | `uuid PRIMARY KEY DEFAULT gen_random_uuid()` | 作业 id（域内三表的 `id`；answer 取轮次的 `job_id`） |
| 2 | `owner_id` | `uuid REFERENCES users (id)` | `owner_user_id` / `owner_id` |
| 3 | `actor_admin_id` | `uuid REFERENCES admin_accounts (id)` | 恒 `NULL`（六源都是用户作业） |
| 4 | `kind` | `varchar(40) NOT NULL`（**无 CHECK**） | 契约 `JobKind` 值：`ocr` / `recognition` / `transcription` / `answer` |
| 5 | `target_type` | `varchar(40) NOT NULL`（**无 CHECK**） | `media`（三源）/ `conversation_turn`（answer） |
| 6 | `target_id` | `uuid NOT NULL` | 作业的**输入对象**：`media_id` / 轮次 `id` |
| 7 | `entity_revision` | `integer NOT NULL CHECK (entity_revision >= 1)` | `media_revision` / 轮次 `revision` |
| 8 | `state` | `job_state NOT NULL DEFAULT 'queued'` | 域内真实状态（枚举列，⛔ 不写哨兵值） |
| 9 | `revision` | `integer NOT NULL DEFAULT 1 CHECK (revision >= 1)` | 域内**状态迁移计数**（台账 revision 数的是迁移，不是写次数） |
| 10 | `input_hash` | `char(64) NOT NULL` | **派生**：sha256(`kind`‖`target_type`‖`target_id`‖`entity_revision`) |
| 11 | `auth_epoch` | `bigint NOT NULL CHECK (auth_epoch >= 1)` | **真值**：同一条语句里 `(SELECT users.auth_epoch …)` |
| 12 | `consent_epoch` | `bigint NOT NULL DEFAULT 0 CHECK (consent_epoch >= 0)` | 不写（走默认 0）——域内没有这份事实 |
| 13 | `deadline_at` | `timestamptz NOT NULL` | `deadline_at` / `job_deadline_at` |
| 14 | `lease_token` | `uuid`（可空） | 不写（无租约/调度器） |
| 15 | `lease_expires_at` | `timestamptz`（可空） | 不写 |
| 16 | `attempt` | `integer NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 3)` | 不写（走默认 0） |
| 17 | `retry_of` | `uuid REFERENCES jobs (id)`（可空） | 不写（无重试链） |
| 18 | `provider_config_version` | `varchar(40)`（可空） | 不写 |
| 19 | `error_code` | `varchar(80)`（可空） | 域内 `error_code`（成功/取消为 `NULL`） |
| 20 | `result_ref` | `uuid`（可空） | 域内**创建时即预分配**的产出行 id（`ocr_id` / `recognition_id` / `transcription_id`；answer 取 `answer_id`，未产出时 `NULL`） |
| 21 | `created_at` | `timestamptz NOT NULL DEFAULT now()` | 域内 `created_at` / `job_created_at` |
| 22 | `updated_at` | `timestamptz NOT NULL DEFAULT now()` | 域内 `updated_at`（取消路径取 `UPDATE … RETURNING updated_at` 的**库时钟**） |

约束与索引（同一段 DDL 内）：
`CONSTRAINT jobs_single_actor CHECK ((owner_id IS NOT NULL)::int + (actor_admin_id IS NOT NULL)::int = 1)`
⇒ owner 与 admin **恰一**，这决定了用户作业的 `actor_admin_id` 必须留 `NULL`；
`jobs_lease_idx`、`jobs_owner_created_idx` 两张索引本片不用也不改。
`state` 的枚举类型 `job_state` 定义在同一迁移里（七值与契约 `JobState` 同序）。

### 1.3 六源现状（R71 之前：只有三张域内表）

| 源（契约 `kind`） | 域内落库位置 | 状态机事实 | R71 前台账 |
|---|---|---|---|
| `ocr` | `public.ocr_jobs`（`0024`） | `state` 是 `text` + 7 值 CHECK | 无 |
| `recognition` | `public.recognition_jobs`（`0025`） | `state` 是 `job_state` 枚举 | 无 |
| `transcription`（域目录叫 `speech`） | `public.speech_jobs`（`0026`） | `state` 是 `job_state` 枚举 | 无 |
| `answer` | `public.conversation_turns` 的作业快照列（`0013`） | `job_state` 列 CHECK 抄契约闭集 | 无 |
| `moderation` | 只有**决定行** `moderation_decisions` / `moderation_withdrawals`（`0028`）；作业态只在进程内 | 无作业行 | 无 |
| `synthesis` | **没有**持久化作业表（迁移里只有 `synthesis` 作为 `target_type` 取值出现） | 作业态只在内存 | 无 |

---

## 2 写入点设计

### 2.1 一条语句、两种幂等

`services/api/src/jobs/ledger.ts:265` 的 `JOB_LEDGER_UPSERT_SQL`：

```sql
INSERT INTO public.jobs
  (id, owner_id, kind, target_type, target_id, entity_revision, input_hash,
   auth_epoch, state, revision, deadline_at, error_code, result_ref, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::integer, $7,
        (SELECT u.auth_epoch FROM public.users AS u WHERE u.id = $2::uuid),
        $8::job_state, $9::integer, $10::timestamptz, $11, $12::uuid, $13::timestamptz, $14::timestamptz)
ON CONFLICT (id) DO UPDATE
   SET state = EXCLUDED.state, revision = EXCLUDED.revision,
       error_code = EXCLUDED.error_code, result_ref = EXCLUDED.result_ref,
       updated_at = EXCLUDED.updated_at
 WHERE jobs.state IS DISTINCT FROM EXCLUDED.state
```

两条幂等判据都落在**主键**上，不靠应用层：

1. **行唯一**：`ON CONFLICT (id) DO UPDATE` —— 台账主键就是作业 id，重复受理 / 重试 / 迟到结果
   都只落到同一行。⛔ 不用「先 SELECT 再决定 INSERT/UPDATE」：那是两次往返 + 额外行锁。
2. **同态重放 no-op**：`WHERE jobs.state IS DISTINCT FROM EXCLUDED.state` —— 同一状态再写一次
   严格不落笔（`updated_at` 都不动），于是 `revision` 数的是**真实状态迁移**而不是写次数。
   真库实测见 §7 的 `[I]` 两条读数。

`kind` / `target_*` / `input_hash` / `created_at` 是作业的**身份**，冲突时**不改**（改了就是把两笔
作业的历史混成一行）。

### 2.2 列映射：哪些是真值、哪些是派生（口径一次写清）

| 列 | 口径 |
|---|---|
| `id` / `owner_id` / `target_*` / `entity_revision` / `state` / `revision` / `deadline_at` / `created_at` / `updated_at` / `error_code` / `result_ref` | **域内真值**逐列透传（`ledgerRowFromDomainJob` / `ledgerRowFromTurn`） |
| `auth_epoch` | **真值**：同一条语句里读 `users.auth_epoch`，不传参、不写哨兵值 |
| `kind` / `target_type` | **源常量**（`ocr`/`recognition`/`transcription`/`answer`；`media`/`conversation_turn`）——域内 `kind` 列本身带 CHECK，映射函数还会校验「源与 kind 必须一致」 |
| `input_hash` | **派生值**：sha256(输入身份四元组)。⛔ 它**不是**输入字节的哈希——全仓没有那件东西的来源（`git grep input_hash services/api/src` 在基线为空），把派生值硬说成「输入哈希」已经够可疑，所以口径写死在这里、并被单测钉住（64 位、同输入同值、换版本换值） |
| `consent_epoch` / `attempt` / `lease_*` / `retry_of` / `provider_config_version` / `actor_admin_id` | **不写**：域内没有这些事实，走 DDL 默认值 / `NULL`，不编造 |

### 2.3 事务边界：逐写点（这是本片唯一的核心不变量）

| 写点 | 位置 | 事务边界 |
|---|---|---|
| ocr 创建 | `services/api/src/ocr/store-pg.ts:571` | `withTransaction`（`BEGIN` → 源表 INSERT → 台账 upsert → `COMMIT`） |
| ocr 开始/取消 | `services/api/src/ocr/store-pg.ts:612` | 同上（读 / CAS UPDATE / 台账三句同一事务） |
| ocr 终态 | `services/api/src/ocr/store-pg.ts:656` | 沿用 `commitTerminal` 既有事务（行锁 → 记录 INSERT → 作业 UPDATE → 台账） |
| recognition 三处 | `services/api/src/recognitions/store-pg.ts:644`（创建）/ `services/api/src/recognitions/store-pg.ts:686`（开始·取消）/ `services/api/src/recognitions/store-pg.ts:730`（终态） | 同 ocr |
| transcription 三处 | `services/api/src/speech/store-pg.ts:530`（创建）/ `services/api/src/speech/store-pg.ts:572`（开始·取消）/ `services/api/src/speech/store-pg.ts:616`（终态） | 同 ocr |
| answer 四处（`GY-R72` 补第四处） | `services/api/src/conversations/store-pg.ts:309`（创建）/ `services/api/src/conversations/store-pg.ts:379`（开始）/ `services/api/src/conversations/store-pg.ts:428`（终态）/ `services/api/src/conversations/store-pg.ts:410`（取消） | `guarded()`（= `withTransaction` + 可选主体核对） |
| 管理台取消 | `services/api/src/admin/ops/jobs-pg.ts:623` | 既有取消事务（行锁 → 域名 UPDATE → 审计函数 → 台账 → `COMMIT`） |

⛔ **没有**「提交之后补写一行」的路径：补写式实现会在 §7 的 `[T]` 两条读数里留下源表行
（真库实测：给 `public.jobs` 挂拒绝触发器后 `insertJob` 抛错、`ocr_jobs` 行数不变）。

管理台取消面为了让台账字段完整，`lockSql` 多读 `owner_user_id` / `media_id` / `media_revision`
三列、`updateSql` 的 `RETURNING` 多回 `updated_at` 一列——**这四列在 `20-login-roles.sql` 里本来就已
按列授予**（`ocr_jobs` / `recognition_jobs` / `speech_jobs` 各 12 列 SELECT），所以这一处**不需要**
新的表级授权；缺列时取消事务 fail-closed 抛 503 并整体回滚，不写半行台账。

---

## 3 六源 × 五态矩阵

五态取派单口径：**创建 / 开始 / 成功 / 失败 / 取消** = `queued` / `running` / `succeeded` /
`failed` / `cancelled`。契约闭集另有 `timed_out` / `uncertain` 两态，矩阵之后另有一整条用例覆盖
七态（`tests/unit/jobs-ledger-mapping.test.mjs` 的第 2 条）。

| 源 | 创建 | 开始 | 成功 | 失败 | 取消 | 接入 |
|---|---|---|---|---|---|---|
| `ocr` | ✅ | ✅ | ✅ | ✅ | ✅ | **已接** |
| `recognition` | ✅ | ✅ | ✅ | ✅ | ✅ | **已接** |
| `speech`(→`transcription`) | ✅ | ✅ | ✅ | ✅ | ✅ | **已接** |
| `answer` | ✅ | ✅ | ✅ | ✅ | ✅ | **已接** |
| `synthesis` | — | — | — | — | — | **未接**（无域内作业表） |
| `moderation` | — | — | — | — | — | **未接**（只有决定行） |

「✅」的判据不是「有调用」，而是 `ledgerRowForSource(source, …)` 在那一格给出的行**逐字段**等于
该源该态应有的值（`kind` / `state` / `revision`（1 → 2 → 3）/ `target_type` / `target_id` /
`entity_revision` / `result_ref` / `error_code` / `input_hash`），30 格逐格断言、并打印每格读数。

**实际接入 4 源 / 6 源。** 未接的两源不是因为"没排期"，而是**结构上没有可同事务写的作业行**：

- `moderation`：审核作业的 `queued` / `running` 只活在进程内，落库的是**决定**（`moderation_decisions`），
  写在判定完成之后。只为终态补一行台账，会让台账声称一段**从未落库**的状态史（`queued` 行永不出现），
  比不写更坏。
- `synthesis`：全仓没有任何合成作业表（迁移里 `synthesis` 只作为导出键形状与收藏历史的
  `target_type` 取值出现），作业态同样只在内存。

两源的理由与"以后怎么接"写在 `services/api/src/jobs/ledger.ts:99` 的 `UNWIRED_SOURCES_REASON`
（由 `tests/unit/ai-ops-ledger-pins.test.mjs` 的钉子①b 钉住：源集合必须恰是「四源已接 + 两源有理由」）。

---

## 4 迁移号与依据：**本片不需要新迁移**

- 读 `services/api/db/migration-reservations.json`：当前只有 1 条保留（`0037`，登记为「允许的缺号」）。
- 迁移目录实测：`0001`–`0036`、`0038`–`0049` 共 48 条正向迁移，**最大编号 0049**。
- 因此**下一个空号是 `0050`**（若将来需要新迁移，就从这里取，⛔ 不许猜）。
- 本片不动 DDL：表、枚举、索引、约束全部照用 `0001` 的既有定义，所以**没有新增迁移**，也就没有
  编号要占。门禁 `node tools/verify-migrations-unique.mjs --strict` 读数不变：
  `47 条配对 + 1 条登记允许缺省 = 48 条正向迁移逐条有交代`、`缺号有「故意跳过」依据（1 个）：0037`。

---

## 5 授权面变更（**需追认点**）

`public.jobs` 自 R34 起被移出运行时授权面（裁定 3：零读者 / 零入向外键 / 无外发账本关联）。
本片给它落了写入者，于是必须按**写入者真实列**重新授权，否则真库一写就 `42501`：

| 文件 | 改动 |
|---|---|
| `deploy/postgres-cvm/sql/20-login-roles.sql:980` | `GRANT SELECT (id,state,revision,error_code,result_ref,updated_at)` —— 冲突目标 `id` + `DO UPDATE … WHERE` 读的 `state` + **`DO UPDATE` 的五个 SET 列**（本片修正，见下方 ⚠） |
| `deploy/postgres-cvm/sql/20-login-roles.sql:981` | `GRANT INSERT (…15 列…)` |
| `deploy/postgres-cvm/sql/20-login-roles.sql:984` | `GRANT UPDATE (state,revision,error_code,result_ref,updated_at)` |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | `domain_manifest` 加一行 `('jobs','granted',true)`；`expected` 加一行逐列复述（58 号断言逐列核对）；`\echo` 同步 |
| `tests/integration/egress-ledger-pg.mjs` | 抽 `deploy/**` 的 `gy-r71-jobs-ledger-grant` 区域原样执行（只替换受权角色），并逐列核对 15/5/6 ⇒ 两条供给路径同源 |
| `deploy/postgres-cvm/sql/20-login-roles.sql`（`#region gy-r71-jobs-ledger-purge-grant`，**补片新增**） | `GRANT DELETE ON public.jobs` —— 注销清理面，单独成区（上面那个区被 `egress-ledger-pg.mjs` 抽取并断言「只含列级授权」） |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`（**补片**） | `allow_table_dml` 加 `('public','jobs','DELETE')`、`expected` 的 `jobs` 行 `del` 由 `false` 翻成 `true`、段 45 加一条 `DELETE … WHERE false` 真执行探针 |

⚠ **本片修正：SELECT 面是 6 列，不是 2 列。** 首版按「`id` 是冲突目标、`state` 被 `WHERE` 读」只授了
`SELECT (id,state)`，真库实测**不足**：`INSERT … ON CONFLICT (id) DO UPDATE` 会让 PG 读旧行，`DO UPDATE`
的**每个 SET 列**也必须可 SELECT。真 PG 17.11 留一法实测（`id` / `state` / `revision` / `error_code` /
`result_ref` / `updated_at` 六列**缺任一列**即 `42501 permission denied for table jobs`；而 `lease_token` /
`created_at` / `provider_config_version` 等**非 SET 列**并不需要）⇒ 仍是**列级**，不必升到表级 SELECT。

**两条授权供给路径（本片收成一处）**：`public.jobs` 的授权只应有一份来源。CI 臂
`consent-grant-postgres-17.11` **不执行** `20-login-roles.sql`，它的运行时角色来自
`services/api/db/roles/*.sql`（8 份，其中**没有一处**提到 `jobs`）⇒ 首版只改了 `deploy/**` 那条，
臂里 `POST /recognitions` 的台账 upsert 直接 42501，整条臂红。现在臂按 `#region` 抽取 `deploy/**`
原文执行，「抄一份进测试」的第二次漂移不再可能。

⛔ **首版没有**授予表级 DML、也没有 DELETE（当时的理由是「台账是作业的账」）。
**该判断在 2026-10-30 的监工复审中被推翻**：台账行携带 `owner_id` / `target_id` / `result_ref`
等私有作业关联，源域清理之后它们仍在库里而注销闭集看不见 ⇒ 必须接进注销清理。补片因此**新增**
一条表级 `GRANT DELETE ON public.jobs`（PG 无列级 DELETE），写法与 `messages` / `favorites` 同款，
授权面变更、事务边界与证据见 **§10**。
R34 的裁定仍然没有被推翻：**读面仍然为零**——`/admin/jobs` 还是读三张域内表，台账至今没有读者。
变的只有两件事：「这张表第一次有写入者」与「这张表第一次有按主体的删除面」，两者都必须带授权，
否则写入点是死代码、删除点是空承诺。

> 这是本片唯一**扩大生产授权面**的改动，按仓规属需要用户明示的事。派单没有单独授权这一步，
> 所以它被列在 §9「需裁定点」第 1 条：若要维持 R34 的"零授权"现状，唯一自洽的做法是把本片降级为
> "代码就位、授权待批"（写入点在真库上会 42501 失败），而不是偷偷用别人的角色写。

---

## 6 证明了什么 / 没证明什么

### 6.1 证明了

1. **写入点真的有且只有一个**：全仓语句级 `INSERT INTO public.jobs` 恰 1 条，落在
   `services/api/src/jobs/ledger.ts`；多一个文件/多一条语句就红（钉子①）。
2. **四源都在单事务里写**：真库实测两条（正向：拒绝触发器让台账写失败 ⇒ `ocr_jobs` 不留行；
   反向：终态事务里记录 id 冲突 ⇒ 台账停在上一状态），另有三份 store 单测把"事务 + 台账语句"
   的序列钉死。
3. **幂等**：同一 `job_id` 的重复迁移不产生第二行；同态重放连 `updated_at` 都不动（真库实测）。
4. **列映射是状态机的函数，不是常量**：六源 × 五态 30 格逐格断言；`state` / `revision` 换一格，
   台账行必须跟着变。
5. **既有读面语义与响应契约零改动**：`/admin/jobs`、`GET /jobs/{id}` 的文件与 SQL 一条没动
   （唯一动到 `admin/ops/jobs-pg.ts` 的是取消面的 `lockSql` / `updateSql` 补列与同事务台账写入，
   响应投影 `toAdminJobView` 的九键一字未改）。

### 6.2 没证明（诚实边界）

1. **台账仍然没有读者**：本片只写不读，"统一台账"作为**查询面**依旧不存在（N04 只到"部分实现"）。
2. **两源未接**（`moderation` / `synthesis`，见 §3）：它们要等各自的域内作业表落地。
3. **管理台取消那条写点的真库证据缺位**：`cancel` 要求真实存在、active、且持 `jobs:cancel` 的后台
   账号，造这套夹具等价于起半个 app；本片对它的证据只有**单测假池**（取消面用例识别台账语句）
   与**静态接线钉子**，没有真库读数。这是明确的缺口，不是"顺手验过"。
4. **`input_hash` 是派生值**，不是输入字节哈希（口径见 §2.2）。
5. **没有验证过并发压测**：幂等靠唯一索引 + 同态守卫，语义上成立，但本片没有跑并发双写矩阵。
6. **没有在真实部署角色下跑过**：真库臂以 `postgres` 连接（迁移需要建表权限）。"`gengyun_api_runtime`
   按 §5 的列级授权能否写出这一行"只有 `tests/unit/sql-column-coverage.test.mjs` 的静态核对
   （列要求 ⊆ 授权）背书，没有一次 `SET LOCAL ROLE` 的真执行读数。

---

## 7 门禁读数

> 全部在分支 `feat/gy-r71-jobs-ledger`、提交后的树上实测；`TMP`/`TEMP` 指向仓外；
> `npm run build` 之后已删 `services/api/dist` 与 `apps/admin/dist`，unit 在删 dist 之后跑。

| # | 门禁 | 读数 | exit |
|---|---|---|---|
| 1 | `npm run build` | **环境受阻，不计 PASS**：`tsc` 段通过、`apps/admin` 的 `vite build` 在 `[vite:esbuild-transpile]` 落临时文件后回 `remove C:\Users\MR\AppData\Local\Temp\esbuild-<hash>: Access is denied.`（Windows 拒绝删除 esbuild 的 >1 MiB 输入临时件）。这是本机结构性限制（已实测「>1 MiB 必失败 / <1 MiB 正常」，与仓库代码无关），⛔ 未改构建配置、未写 PASS。build 之后已删 `services/api/dist` 与 `apps/admin/dist`。 | 1（环境受阻） |
| 2 | `npm run lint` | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描` | 0 |
| 3 | `npm run test:unit` | `tests 5938 / pass 5935 / fail 0 / cancelled 0 / skipped 1 / todo 2`（注销接入前的同树读数曾为 `fail 7`，逐条修完归零；其中 `tests/unit/jobs-ledger-deletion.test.mjs` 6/6、`tests/unit/doc-anchor-relocation-identity.test.mjs` 33 条全绿、`tests/unit/doc-anchors-guard.test.mjs` 27/27、`tests/unit/doc-anchors-symbol-baseline-fresh.test.mjs` 5/5） | 0 |
| 4 | `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| 5 | `npm run verify:anchors` | `verify-contract-status` PASS（126 条契约操作；形状错误 0 / 语义错误 0 / 表格漂移 0）+ `verify-doc-anchors --strict` PASS（`--strict` 下无基线外新增） | 0 |
| 6 | `npm run verify:parity` | `"extra": [] / "missing": [] / "ledgerDrift": []` | 0 |
| 7 | `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`；`文档标记块与重算一致` | 0 |
| 8 | `npm run test:docs` | 研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住`；`docs/research 结构校验` PASS | 0 |
| 9 | `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0`（B1–B6 全绿） | 0 |
| CI-exact | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红）` | 0 |

> 补充口径：`verify:anchors` 的默认面（`docs/architecture` + `docs/verification`）与 CI-exact 面
> （`--scan docs`）都已跑过、都 PASS；两个面共用的三本册子（结构基线 61 条、符号基线 29 条、孤儿册
> 3541 / 作用域外 133）本轮都按「同一处行号位移」重生成或逐条删陈旧项，不是加豁免。

另有两条**本片专项**读数（不计入九条门禁）：

| 项 | 读数 | exit |
|---|---|---|
| `node tools/verify-migrations-unique.mjs --strict` | `47 条配对 + 1 条登记允许缺省 = 48 条正向迁移逐条有交代`；`[gap] 缺号有「故意跳过」依据（1 个）：0037`（本片零迁移，读数与基线一致） | 0 |
| `node tests/integration/jobs-ledger-pg.mjs`（真库） | `SUMMARY: 13 项实测通过（真库 gengyun_jobs_ledger_test）；台账总行数 4` | 0 |

真库臂（非门禁、单独一条）：

| 臂 | 读数 |
|---|---|
| `node tests/integration/jobs-ledger-pg.mjs`（`JOBS_LEDGER_PG_TEST_URL`） | `SUMMARY: 13 项实测通过（真库 gengyun_jobs_ledger_test）；台账总行数 4` |
| 缺 `JOBS_LEDGER_PG_TEST_URL` 时 | 打印 `SKIP real PG17: …` 并 `exit 77`（未取得 ≠ 通过；⛔ 不静默通过） |

---

## 8 负控制（四条，逐条打红 → 恢复复绿）

| # | 负控制 | 怎么打红 | 红在哪（判据原文/读数） | 恢复 |
|---|---|---|---|---|
| ① | **台账写在事务外** | 把 `ocr/store-pg.ts` 的 `insertJob` 改成「`withTransaction` 里只写源表 → 提交后再 `writeJobLedger(pool, …)`」 | `tests/unit/ocr-store-pg.test.mjs` 的 `[1] insertJob` 立刻红：语句序列变成 `BEGIN → INSERT ocr_jobs → COMMIT → RELEASE → INSERT jobs`，而断言要求台账语句落在 `BEGIN…COMMIT` **之内**（真库臂 `[T]` 的正向读数也会同时红：拒绝触发器让台账失败后源表行不再回滚） | `git checkout -- services/api/src/ocr/store-pg.ts` → 复绿 |
| ② | **去掉幂等守卫** | 把 `JOB_LEDGER_UPSERT_SQL` 的 `ON CONFLICT (id) DO UPDATE … WHERE … IS DISTINCT FROM` 换成 `ON CONFLICT (id) DO NOTHING` | `tests/unit/ai-ops-ledger-pins.test.mjs` 钉子①红：字面锚 `/ON CONFLICT \(id\) DO UPDATE/` 不再命中（真库臂 `[I]` 的两条读数也会红：同态重放不再是 no-op、异态不再就地更新） | `git checkout -- services/api/src/jobs/ledger.ts` → 复绿 |
| ③ | **某源漏写** | 删掉 `speech/store-pg.ts` 的 `commitTerminal` 里那一行 `writeJobLedger(...)` | `tests/unit/jobs-ledger-mapping.test.mjs` 的接线钉子红：`services/api/src/speech/store-pg.ts 的 writeJobLedger 调用数是 2，应为 3` | `git checkout -- services/api/src/speech/store-pg.ts` → 复绿 |
| ④ | **台账字段写错（`state` 写成固定值）** | 把 `ledgerRowFromDomainJob` 的 `state: assertJobState(job.state)` 改成 `state: assertJobState('queued')` | 矩阵两条同时红：`矩阵：六源 × 五态逐格断言`（除 `queued` 外每格 `state` 都与该态不符）与 `矩阵补充：契约七态全覆盖…且 state 与 revision 不脱钩` | `git checkout -- services/api/src/jobs/ledger.ts` → 复绿 |

负控制 ③ 的价值要单独说一句：它证明了**接线读数**与**映射矩阵**不是同一层证据 —— 删掉一处调用，
30 格映射断言照样全绿，只有"每域三处（answer 域自 `GY-R72` 起四处）+ 取消一处"的静态读数会红。

### 8.1 注销清理的三条负控制（补片实测）

| # | 负控制 | 怎么打红 | 红在哪（判据原文/读数） | 恢复 |
|---|---|---|---|---|
| ⑤ | **摘掉 `jobs` 的处理器注册** | 删掉 `services/api/src/privacy/user-data-deletion.ts:1099` 起那整块 `if (input.jobsStore !== undefined) { coordinator.registerModule(JOBS_DELETION_MODULE, …) }` | `tests/unit/jobs-ledger-deletion.test.mjs` 多条同时红；正控制那条的报错原文是 `Error [PrivacyError]: 删除处理器未覆盖全部必需模块：jobs`（`packages/privacy/deletion-modules.mjs:140`）—— 「闭集里有、处理器没有」在**受理那一刻**就拒，不会静默少清一个域 | 恢复该块 → `pass 6 / fail 0` |
| ⑥ | **摘掉 `app.ts` 的注入** | 删掉 `services/api/src/app.ts:2264` 的 `...(jobsLedgerDeletionStore === null ? {} : { jobsStore: jobsLedgerDeletionStore }),` | `tests/unit/deletion-registration-coverage.test.mjs` 红：``AssertionError: `app.ts` 必须恰好注入一次 `jobsStore`（`...(jobsLedgerDeletionStore === null ? {} : { jobsStore: jobsLedgerDeletionStore })`）：删掉或挪走 ⇒ 闭集缩回 8 项，而协议层与其它用例都不会报错`` | 恢复该行 → `pass 7 / fail 0` |
| ⑦ | **把那条 `DELETE` 的语义改掉**（不是删调用，而是让「删」变成「什么也没删」） | 把 `services/api/src/jobs/ledger.ts:387` 的字面量改成 `DELETE FROM public.jobs WHERE owner_id = $1::uuid AND false` | `✖ SQL 字面钉子：删的是 public.jobs 里该 owner 的行` → `AssertionError: Expected values to be strictly equal: actual: 'DELETE FROM public.jobs WHERE owner_id = $1::uuid AND false'`（`tests 6 / pass 5 / fail 1`，exit 1） | 改回 → `pass 6 / fail 0` |

⑦ 是这轮**新补出来的洞**，值得单独记一句：⑤⑥ 只证「处理器在、注入在」，而假池是按**导入的常量**判形状
（`text !== JOB_LEDGER_PURGE_SQL`），所以只要常量自己被改成加谓词／换表／换成 `SELECT`，假池照样照着
自己的分支删行、正控制与负控制**全都还是绿的**。因此补了这条**字面钉子**：把「删什么」钉死在
`DELETE FROM public.jobs WHERE owner_id = $1::uuid`（无 `AND`／`OR`、无分号、非 `TRUNCATE`/`UPDATE`）。
它证明的是「语句字面量没被悄悄改」，不证明 PostgreSQL 真的执行了它（那是真库臂的事，见 §10.4）。

⑤ 证的是**闭集与处理器的一致性**（缺处理器 ⇒ 受理即拒）；⑥ 证的是**装配处的注入真的存在**
（源码文本里声明 `jobsStore?: OwnerPurgeStore` 不等于装配处传了实参）。两者不是同一条证据：
⑤ 只在「闭集已追加」时才有意义，⑥ 保证闭集真的会被追加。

---

## 9 边界与需裁定点

1. **授权面扩大**（§5）：本片给 `public.jobs` 加了列级 SELECT/INSERT/UPDATE。R34 当初把它移出授权面
   是**有据的**（零读者），本片没有推翻那个判断，只是让"有写入者"这件事成立。请裁定：接受这次
   授权面扩大，还是把本片降级为"代码就位、授权另批"（真库会 42501）。
2. **R34 的注释与 90-assert 的清单**已被本片改动（`domain_manifest` / `expected` 各加一行）。
   如果第 1 条被否，这两处要一并回退。
3. **`admin/ops/jobs-pg.ts` 的 `lockSql` / `updateSql` 补了列**（3 + 1 列）：这是为了台账字段完整，
   都在既有授权内；但它改了取消面的 SQL 字面量，若审查认为"取消面 SQL 一字不动"优先，则需要
   改成第二条只读语句（会多一次往返，且同事务内仍安全）。
4. **两源未接**（`moderation` / `synthesis`）：要接必须先给它们落域内作业表（各自一片）。
5. **`0013_conversations.sql` 的头注**：它是历史迁移，本片只在原句后追加了「历史快照 + 新写入点」
   两行注释（等长替换，不移动行号），没有改语义；但"改历史迁移文件"这件事本身值得复核。
6. **CI 接线**：真库臂 `tests/integration/jobs-ledger-pg.mjs` **未接** `real-pg-integration.yml`
   （如实登记为「未接线（真缺口）」）。要不要本片就接进去，请裁定。

---

## 10 注销清理接入（补片 · 2026-10-30 · 监工 B 档实质阻塞的正面处置）

**监工判词（逐字）**：台账首次为 `public.jobs` 写入 `owner_id`、`target_id`、`result_ref` 等**私有作业关联**；
`purgeOwnerRows` / `purgeOwnerData` 只删原域表，`privacy/user-data-deletion.ts` 的必需模块与处理器**没有该台账**，
`retention-policy.mjs` 亦无本表保留策略 ⇒ 源域清理后新台账行仍可携带用户/媒体/轮次及产出关联而**未被注销闭集发现**；
「无读者/是作业的账」不能替代删除或限定保留依据。

本节逐条回应。**结论：选 A（接进注销清理与保留策略），不选 B（关闭写入）** —— 台账写入点已经在真库路径上生效，
关掉它等于让 §2 的全部事务证据作废，而缺的那一环（删除）是**能补且已补**的。

### 10.1 删什么

| 项 | 事实 |
|---|---|
| 语句 | `DELETE FROM public.jobs WHERE owner_id = $1::uuid`（`services/api/src/jobs/ledger.ts:387`，与写入语句同一文件：谁写台账、谁删台账不会分叉成两份口径） |
| 范围 | 该主体在台账里的**全部**作业行 —— `ocr` / `recognition` / `transcription` / `answer` 四个源全在这张表里，不再按 `kind` 分四刀（理由见下） |
| 行数 | `pg` 的 `rowCount` 真实值；拿不到就抛（`rowCount` 缺失且没有 `RETURNING` 行 ⇒ 抛「拿不到真实删除行数」，⛔ 不把「不知道」报成 0） |
| 边界 | 空主体 / 纯空白主体**调用即抛**，一条 SQL 都不发（`services/api/src/jobs/ledger.ts:396` 起），⛔ 不退化成「删全部」 |
| 幂等 | 同一主体重复调用第二次删 0 行、不抛（注销重放/重试的既有口径） |

### 10.2 谁在删、和谁同序

| 角色 | 位置 |
|---|---|
| 闭集里的模块 | `jobs`（`services/api/src/privacy/user-data-deletion.ts:178` 的 `JOBS_DELETION_MODULE`），**条件追加**：`CONDITIONAL_DELETION_MODULES`（`:231`）与真实追加点 `conditionalStores`（`:755`）两处逐项一致，静态腿钉住 |
| 处理器 | `coordinator.registerModule(JOBS_DELETION_MODULE, makeHandler(...))`（`services/api/src/privacy/user-data-deletion.ts:1097`）；走 `purgeOwnerData` ⇒ 证据串 `jobs:online-purged:<真实行数>` |
| 端口 | `services/api/src/app.ts:2206` 的 `jobsLedgerDeletionStore`（门＝`pool !== null`），注入点 `services/api/src/app.ts:2264` |
| 证据落库 | 模块名进 `ONLINE_EVIDENCE_MODULES`（`services/api/src/privacy/user-data-deletion.ts:213`），迁移 0031 的写函数照写 `(requestId, module, removed, idempotency)` ⇒ 审计可复算 |

**同序**：`jobs` 是生效闭集的第 9 项（四域 + community + recognitions + speech + ocr + jobs），
与其余 8 个模块在**同一个 requestId、同一份回执**里，处理顺序＝追加顺序（`jobs` 最后）。
**同一事务：做不到，如实登记。** 删除协议里每个模块的处理器各开自己的数据库事务；识别／语音域的清理走
迁移 0034 的两条 `SECURITY DEFINER` 函数（`public.purge_owner_recognitions` / `purge_owner_speech`），
没有可与台账表级 `DELETE` 共用的跨域事务。因此本片的口径是：
- 台账按 `owner_id` **一刀删完**（不按 kind 分刀）⇒ 无论哪个域先跑，收敛结果都是「该主体零行」；
- `public.jobs` 对三张域内作业表**没有外键**（`0001_initial_schema.sql:203` 建表时就没有），
  所以台账删除既不被域内删除阻塞，也不会因为顺序不同留下半截；
- 若将来要把两者放进同一个事务，只有一条路：给台账也做一条 `SECURITY DEFINER` 清理函数并让各域的
  函数在**同一个**受理事务里调用 —— 那是独立一片（要动 0034 的函数与部署面），本片不假装已做到。

### 10.3 保留策略依据（`packages/privacy/retention-policy.mjs`）

`public.jobs` 进 `RETENTION_EXCLUSIONS`（`packages/privacy/retention-policy.mjs:218`），**不进**
`RETENTION_POLICY`（日历保留表）。理由写在条目里，摘要：

1. 行内的 `owner_id` / `target_id` / `entity_revision` / `result_ref` / `auth_epoch` 是**私有作业关联**，
   与它镜像的域内作业行同一生命周期 —— 「私有识别记录原则保存至注销」
   （`docs/implementation-requirements.md:277`），因此**不走日历保留**；
2. 「在线 7 日／备份 30 日」是**注销请求的两个到期时刻**（`deletion_requests.online_due_at` /
   `user_backup_copies.retention_until`），不是本表的日历保留期
   （口径见 `docs/architecture/gy-r59-retention-backup-thirdparty-map.md:24`）；把 7/30 写成本表的
   `retentionDays` 会与既有表的口径**撞词不撞义**；
3. 与 `public.favorites / public.history` 同一条先例：生命周期由注销链负责、不并入日历策略表 ——
   但**必须有注销清理者**，这一条本片补齐（§10.2）。

⛔ 没有用「台账无读者」当排除理由：exclusion 的正文里根本没有这个说法，反而写明「必须有注销清理者」。

### 10.4 证明了什么 / 没证明什么

**证明了**

1. 注销后该主体在 `public.jobs` 的行**归零**，他人主体的行一行不动，证据串带**真实**删除行数
   （`tests/unit/jobs-ledger-deletion.test.mjs`「正控制」，假池里真按 owner 删、再读回行数）。
2. 负控制：把原语换成「报告 0 行但不删」的替身 ⇒ 行仍在库里，说明上面那条断言对「删没删」敏感
   （同一文件「负控制」）。**这一条还不够**——替身替换的是假池，不是那条 SQL；因此另有字面钉子
   （§8.1 ⑦）：把 `DELETE` 改成 `… AND false` ⇒ `tests 6 / pass 5 / fail 1`（exit 1），改回即复绿。
   行级负控制（删掉 `app.ts` 的注入 / 删掉注册块）见 §8.1 ⑤⑥。
3. 闭集真的覆盖它：注入 `jobsStore` ⇒ `requiredModules()` = 9 项且含 `jobs`；不注入 ⇒ 静默缩回 8 项
   （这正是要防的形态，`tests/unit/deletion-registration-coverage.test.mjs` 把它钉成断言）。
4. 用户数据表清单的棘轮：`public.jobs` 从 `DECLARED_UNREGISTERED`（原登记语「任务表随执行器一起清理，
   当前无按主体原语」）**移进** `MODULE_TABLE_COVERAGE` —— 那条声明已作废：执行器不跑就不清，
   而注销必须清。

**没证明（诚实边界）**

1. **真库臂有没有跑**：`tests/integration/jobs-ledger-pg.mjs` 的 `[P] 注销清理` 小节已写好
   （造两个主体、删一个、读回另一个），但本机**没有可用的 PG**（`JOBS_LEDGER_PG_TEST_URL` 未设置），
   本次**没有取得该臂的读数**；缺变量时脚本按既有约定打印 `SKIP real PG17: …` 并 `exit 77`
   （未取得 ≠ 通过）。**因此「真库上删掉 0 行」这件事，本片只有假池 + 静态接线作证。**
2. **运行时角色下的 DELETE 授权没有真执行读数**：`GRANT DELETE ON public.jobs` 的生效性由
   `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的段 45 真执行探针
   （`DELETE … WHERE false`，`SAVEPOINT` 包裹、零行）背书；那条探针要在目标库上执行，
   本机同样没有跑。
3. **跨域同一事务**没有做到（§10.2），只有「按 owner 一刀删完 + 无外键 ⇒ 收敛到零行」。
4. **备份侧**：`jobs` 不生成 `user_backup_copies` 清单行（备份副本只对收藏/历史/消息/会话四域）⇒
   该模块的 `backupState` 仍如实 `pending`，不冒充完成。

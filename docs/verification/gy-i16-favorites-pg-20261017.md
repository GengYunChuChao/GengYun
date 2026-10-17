# GY-I16（#16）阶段 2 · 收藏与识别历史**补 PG 持久化**证据

- **任务**：GY-I16（issue **#16**）第二阶段，承接已合并的收藏/历史域（内存 store + 五条 HTTP）
- **日期**：2026-10-17
- **分支／worktree**：`feat/gy-i16-favorites-history-pg`（`E:\GengYunCommander\GengYun_W16pg`，新建）
- **基线**：`upstream/main` = `6c2200087ae5f8841a04505cb1c226284cee7f1b`（`git fetch upstream --prune` 后实测，
  与本片派单声明的基线**同一提交**，未前进）
- **迁移号裁定**：本片使用 **`0018`**，因 `0017` 已被在飞片 `feat/gy-i22-suspend-authority`
  的 `0017_account_suspend_authority.sql` 占用（实测：`git ls-tree feat/gy-i22-suspend-authority --
  services/api/db/migrations/` ⇒ 该文件存在；`discoverMigrations()` 对同版本号实现在 `seen` 表上**直接抛错**
  「迁移版本号重复」，两片并入 main 后会让所有碰库测试硬红，故让号）
- **本机 PG 可用性（实测，已订正）**：仓库自带 `.pg17\pgsql\bin` 里有 `psql`／`initdb`／`pg_ctl`，
  `psql --version` = **`psql (PostgreSQL) 17.11`**（只是不在 `PATH`，故 `Get-Command psql` 查不到——
  上一版据此写「本机无 psql／未取得真库读数」**是伪断言**，审查已驳回）。本片自起隔离集群：
  `initdb -D E:\GengYunCommander\.pg17\tmp-i16-pg17\data -U postgres -A trust -E UTF8 --locale=C`，
  `pg_ctl -D … -o "-p 55449 -c listen_addresses=127.0.0.1"`（55441 已被**与本片无关**的外部 postgres 占用，
  未动它），`SHOW server_version` = `17.11`、`SHOW listen_addresses` = `127.0.0.1`；
  ⇒ **§5.2／§5.3 的真库读数全部为本人实跑**（收工 `pg_ctl stop`，55449 零监听）
- **未发起任何真实第三方／付费调用**；未使用任何真实凭据

## 1 交付物

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `services/api/db/migrations/0018_favorites_history.sql` | 新增 | `favorites`／`history`／`favorites_idempotency`／`history_idempotency` 四张表 + 三处唯一约束 + 各域 created 排序索引 + 台账过期索引 |
| `services/api/db/migrations/rollback/0018_favorites_history.down.sql` | 新增 | 逆序 `DROP TABLE IF EXISTS`，纯新增 ⇒ 不动既有表/数据 |
| `services/api/src/favorites/store-pg.ts` | 新增 | `createPostgresFavoritesStore(pool, { now })` 实现既有 `FavoritesStore`（12 方法），`persistent: true` |
| `services/api/src/history/store-pg.ts` | 新增 | `createPostgresHistoryStore(pool, { now })` 实现既有 `HistoryStore`（13 方法，含 `findByEventKey`），`persistent: true` |
| `services/api/src/app.ts` | 改动（2 处导入／注释段／store 选择／服务门禁） | real 模式从「恒 null」改成**二分语义**：有 `pool` ⇒ PG store 并开服务；无 `pool` ⇒ 仍 null ⇒ 五条路由仍 503 |
| `tests/unit/favorites-history-fixtures.mjs` | 改动 | 追加 `PG_MIGRATIONS`／`migrationSql(name)`／`pglitePool(t)`（两个 HTTP 用例与 store 用例共用同一份 PGlite 夹具） |
| `tests/unit/favorites-http.test.mjs` | 改动 | 原「real 恒 503」改成**两条**：无 `pool` 臂（503，断言逐字保留）＋有 `pool` 臂（201/200 且真落库） |
| `tests/unit/history-http.test.mjs` | 改动 | 同上两处（行内 real 块改注释并保留无 `pool` 臂；独立接线用例拆成无 `pool`／有 `pool` 两条） |
| `tests/unit/favorites-history-store-pg.test.mjs` | 新增 | store 逐方法语义（8 组）：读回／去重／归属／CAS 四态／台账／`awaitIdempotencySettled`／计行数／回滚 |
| `tests/unit/favorites-history-deletion-registration.test.mjs` | 新增 | 注销清空**经 app 装配**打到 PG 表：真表清零、行数进证据 |
| `tests/integration/favorites-history-pg.mjs` | 新增 | 真 PG17 端到端（**12 组**，脚本内逐个 `PASS n:` 计数）；未设 `FAVORITES_HISTORY_PG_TEST_URL` 时**显式跳过**、逐字打印 `SKIP real PG17: … 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。` 且 `exit 0` —— **跳过不是通过，也不是验证**：该臂下真库持久化一条都没测到，⛔ 不得读成「已验证通过」 |
| `tests/unit/ci-integration-chain-structure.test.mjs` | 改动 | 白名单追加本片真库脚本＋原因（该门禁要求「未接线必须显式声明」） |

## 2 迁移 0018：表、约束、索引

| 表 | 关键列 | 约束 |
| --- | --- | --- |
| `favorites` | `id uuid PK`、`owner_id uuid NOT NULL → users(id)`、`target_type varchar(32)`（TargetRef 16 值闭集）、`target_id varchar(80)`（1..80）、`target_revision`、`revision`（`>=1`）、`created_at timestamptz` | `UNIQUE (owner_id, target_type, target_id)` ⇒ **同目标二次收藏由库裁决** |
| `history` | 同上 ＋ `kind ('recognition','ocr')`、`job_id varchar(120)`、`job_state`（7 状态闭集）、`event_key varchar(120)` | `UNIQUE (owner_id, event_key)`、`UNIQUE (owner_id, kind, target_id)` ⇒ 与内存实现的**两道**去重键一一对应 |
| `favorites_idempotency` | `scope`、`key_hash`、`request_hash`、`response_status smallint (100..599)`、`outcome jsonb`、`expires_at timestamptz` | `PRIMARY KEY (scope, key_hash)`；`outcome` 只允许 NULL 或 jsonb 对象 |
| `history_idempotency` | 同上（分域存放，互不串号） | 同上 |

- 排序索引：`(owner_id, created_at DESC, id DESC)` 两域各一，与 `compareFavoritesDescending`／`compareHistoryDescending` 同口径。
- `target_id`／`job_id`／`event_key` **故意不用 uuid**：契约允许任意文本（既有用例就传 `spc-1`、`job-page-0`）。
- `reference_state` **不入库**：引用可用性由读取时逐次派生（既有实现口径），落库只会变成过期快照。
- 删除是**物理删除**（与内存实现一致）。`owner_id` 是**裸外键** `REFERENCES users (id)`（默认 `NO ACTION`），
  **不带** `ON DELETE CASCADE`（上一版措辞写错，审查已指出）。
- **`DELETE FROM users` 的实测（口径 29：读数绑定测量 SHA `6479d1b`；本片相对基线未改任何代码／迁移／测试）**：
  上一版在此写的是**假断言**（引文「全仓无此语句／已 grep 确认」），本轮删除并换成下面的可复现读数 —— 三档必须分开写：

| 档 | 命令（均落在 `6479d1b` 的 `HEAD` 树上） | 命中 | 说明 |
| --- | --- | --- | --- |
| 生产代码 | `git grep -n 'DELETE FROM users' HEAD -- services/api/src` | **0**（`exit 1`） | 扩到 `services apps packages miniprogram tools scripts .github` 仍 **0**（`exit 1`）⇒ 生产**无删用户路径** |
| 测试代码 | `git grep -n 'DELETE FROM users' HEAD -- tests` | **3** | 2 处**真执行** ＋ 1 处**拒绝断言**（逐处见下） |
| 全仓（含本页） | `git grep -n 'DELETE FROM users' HEAD` | **4** | ＝ 生产 0 ＋ 测试 3 ＋ 本页 1（本页自述，见下方自指说明） |

- **测试里那 3 处逐条列明（符号锚，不用裸行号；这两个文件都不在本片三点 diff 内 ⇒ 读数不受本片改动影响）**：
  - `tests/integration/egress-object-key-pg.mjs` **真执行 ×2**：① 「P2-c 故障注入」段里的
    `await owner.query('DELETE FROM users WHERE id=$1', [uA])`（该段以 `say('P2-c 故障注入①（真 PG）…')` 收尾）；
    ② 脚本末尾 `finally` 清理块里的 `DELETE FROM users WHERE wechat_subject_lookup=decode($1,'hex')`
    （在 `GRANT … ON exports TO gengyun_egress_ledger` 复原之前）。两处删的都是该脚本自造的夹具用户；
    该脚本**不应用 `0018`**（`git grep -c '0018' HEAD -- tests/integration/egress-object-key-pg.mjs` ⇒ `exit 1`／0 命中；
    它应用的迁移只有 `0014`／`0015`）⇒ 这两次删除不落在本片四张表上，不产生本片孤儿子行。
  - `tests/integration/auth-privacy-pg.mjs` **1 处，但不是删用户路径**：`'DELETE FROM users'` 是「受限 LOGIN 必须被
    `42501` 拒绝」的 11 条 SQL 负向清单里的一项（`for (const sql of […])` ＋
    `await assert.rejects(pool.query(sql), e => e.code === '42501')`）⇒ **期望被拒绝**，不是可用的删除能力。
- ⚠ **自指说明（可复现性）**：本页自身含 `DELETE FROM users` 字面量（上面就是命令示例），⇒「全仓」计数会随本页措辞
  变动；**稳定可复现的是 scoped 两档**（`-- tests` = 3、`-- services/api/src` = 0）。`全仓 4` 绑定改前 `6479d1b`，
  与审查报告 §8 的独立实测一致（上一轮的 0 命中是在过期主检出的工作树上测的，故不成立）。
- ⇒ 结论：**生产代码没有删用户路径**（`services/api/src/**` 0 命中）⇒ 本片四张表的裸 FK 当前无触发点、不产生孤儿行；
  这是**已知边界**而非疏漏。裸 FK（默认 `NO ACTION`）本身 fail-safe：将来若引入物理删用户，删 `users` 行会因 FK
  **报错阻止**（不是静默留孤儿），届时需先用 `deleteAllByOwner` 清 `favorites`／`history` 或补级联。

## 3 store 实现：逐方法对齐内存实现

| 验收点 | 内存实现 | PG 实现（关键决定） |
| --- | --- | --- |
| 去重 | 三个 Map 索引先查后写 | `INSERT … ON CONFLICT DO NOTHING RETURNING id`，`rows.length===1 ⇒ 'inserted'` 否则 `'duplicate'` —— **不先查后写**，并发下不会双写 |
| `deleteFavorite`／`deleteHistory` | 同步临界区内比对 owner/revision 后删除 | 单个事务：`SELECT … FOR UPDATE` → `NOT_FOUND`／`OWNER_CHANGED`／`REVISION_CHANGED` → `DELETE … AND owner_id = $2 AND revision = $3 RETURNING id`，`rows.length!==1` 再判 `REVISION_CHANGED`；`SET LOCAL lock_timeout = '4s'` |
| `deleteAllByOwner` | 逐行筛 owner 计数 | `DELETE … RETURNING id`，`rows.length` 即真实行数（注销证据 `<module>:online-purged:<n>` 直接用它） |
| `findByTarget`／`listFavoritesByOwner` | 只按 owner 过滤 | `WHERE owner_id = $1`；唯一性按 owner 分域，两个主体可收藏同一目标 |
| `claimIdempotency` | 已存在且未过期 ⇒ false，否则覆盖 | 单语句 `INSERT … ON CONFLICT (scope,key_hash) DO UPDATE … WHERE expires_at <= $now RETURNING scope`；命中 ⇒ true，未命中 ⇒ false |
| `completeIdempotency` | 仅「存在且 outcome 为空」⇒ 写并 true | `UPDATE … SET outcome, response_status WHERE … AND outcome IS NULL RETURNING scope` |
| `releaseIdempotency` | 仅删「已认领未完成」 | `DELETE … AND outcome IS NULL`（不抹掉已完成结果） |
| `findIdempotency` | 过期即删并返回 null；未完成也返回 null | 过期先 `DELETE … AND expires_at <= $now`，再 `SELECT`；`outcome` 为空 / 过期 ⇒ `null` |
| `awaitIdempotencySettled` | 内存轮询 | 25ms 有界轮询、沿用 `waitMs`，**每轮真读库**（`SELECT outcome`）；`timeout` 只是"这一轮没等到"，不是进程内共享状态 |
| 错误映射 | `ApiError` | `57014`／`55P03` ⇒ `PROVIDER_TIMEOUT`；`ApiError` 直抛；其余 ⇒ `PROVIDER_UNAVAILABLE`（均 `retryable: true`，与问答域 `classifyConversationDatabaseError` 同形） |

## 4 装配：real 模式的二分语义

```
const favoritesStore: FavoritesStore =
  favoritesInjection?.store ??
  (config.executionMode === 'real' && pool !== null
    ? createPostgresFavoritesStore(pool, { now: () => clock().getTime() })
    : createMemoryFavoritesStore({ now: () => clock().getTime() }));

const favoritesService =
  config.executionMode === 'real' && !favoritesStore.persistent
    ? null                                   // real + 内存 store（含注入）⇒ 仍 fail closed
    : createFavoritesService({ store: favoritesStore, … });
```

| `executionMode` | 有 `pool` | 结果 |
| --- | --- | --- |
| `real` | 有 | PG store（`persistent: true`）⇒ 服务开启，201/200 且真落库 |
| `real` | 无 | `null` ⇒ 五条路由仍 **503 `PROVIDER_UNAVAILABLE`**（一分不放宽） |
| `stub`／`preset_demo` | 任意 | 内存 store（行为与追加前逐字一致） |

判据用 `store.persistent`（而不是「是否传了 pool」），与问答域
`conversationStore === null || (real && !conversationStore.persistent)` 同形：即便有人往 `real` 里注入内存
store，也**绕过不了**这道理。`createUserDataDeletion({ favoritesStore, historyStore })` 拿的是同一批 store
⇒ 注销清空一并走 PG（证据见 §5.1 的第 10 项）。

## 5 测试与实测读数

### 5.1 新增／改动的断言（要点）

1. **无 `pool` 臂未被削弱**：`favorites-http.test.mjs` 的 GET/POST/DELETE 三条 503 断言与
   `favoritesService === null` 逐字保留；`history-http.test.mjs` 的两处同样保留（含
   `recognitionService.describe().historyPort === 'unwired'`）。
2. **有 `pool` 臂**：`POST /favorites` 201 → `SELECT` 真表 1 行（owner/revision 如实）→ 换 Idempotency-Key
   二次 POST 同目标 ⇒ 201 且 `id` 相同、`count(*)=1` → 列表 → `DELETE`（`If-Match`）200 → `count(*)=0`；
   他人列表恒空。
3. **历史**：`appendHistory` 落 PG（`job_state='failed'` 原样入库）→ `GET /history` 200 且 `job_state` 仍
   `failed`（读不到实时状态就如实退回入库值）→ 他人列表空 → 同 `event_key` 再 append ⇒ `created=false`
   且行数不增。
4. **store 逐方法**（PGlite）：读回逐字段相等（`created_at` 是 ISO 字符串，不变形为 Date）；
   四路去重；归属分域；CAS 四态；台账六步；`settled` 由**另一条连接**的写入唤醒（证明不是进程内 Map）；
   `deleteAllByOwner` 返回真实行数且他人行不受影响；回滚脚本四表消失而 `users` 仍在。
5. **注销注册**：`buildApp`（real + pool）后 `app.userDataDeletion.requiredModules() === ['favorites','history']`，
   `executeHandlers` 后**真表** `favorites`/`history` 本主体 0 行、他人 1 行，`audit()` 记
   `{favorites: 1, history: 2}`，回执模块行 `online_state='completed'`／`backup_state='pending'`；
   无行时如实记 0。
6. **真库脚本**（`tests/integration/favorites-history-pg.mjs`）覆盖同一批断言 + 迁移重复应用 no-op +
   回滚：**已在真 PG17 17.11 上 12/12 组全绿**（本人实跑，读数见 §5.3）。

### 5.2 已取得的读数（本机，`node v24.16.0`）

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 静态检查 | `npm run lint` | **PASS**（`tsc --noEmit` ×2 + 仓库卫生扫描）`exit 0` |
| 单元测试 | `npm run test:unit` | **tests 2453 / pass 2452 / fail 0 / skipped 1（既有跳过）/ `52475.7ms`**，`exit 0`；逐文件读数见 §5.2 附注 |
| HTTP 回环集成 | `npm run test:integration:http` | **exit 0**（11 个回环脚本串行全绿） |
| 文档校验 | `npm run test:docs` | **PASS**（27 项初始任务、依赖无环、F/AC/Q 映射完整）`exit 0` |
| 契约状态 | `node tools/verify-contract-status.mjs` | **PASS**（112 条操作／已装配 108／implemented 13・partial 95・planned 4；横切 8 条）`exit 0` |
| 空白检查 | `git diff --check`、`git diff --cached --check` | `exit 0`（无空白错误） |
| 本片三文件 | `node --test tests/unit/{favorites-http,history-http,favorites-history-store-pg,favorites-history-deletion-registration}.test.mjs` | 逐文件读数见 §5.2 附注 |
| 真库（**本人实跑**，§5.3） | `$env:FAVORITES_HISTORY_PG_TEST_URL='postgres://postgres@127.0.0.1:55449/gengyun_favorites_history_test'; node tests/integration/favorites-history-pg.mjs` | `Real PostgreSQL patch: 17.11` → `PASS 1:`…`PASS 12:` → **`ALL PASS (12 groups) — real PG17 17.11`**，`exit 0`，**4803ms** |

**§5.2 附注（逐文件读数，均为本机实测）**：
`tests/unit/favorites-http.test.mjs` ⇒ 8 tests / pass 8 / fail 0（2918ms，其中 PG 臂 1531ms）；
`tests/unit/history-http.test.mjs` ⇒ 17 / pass 17 / fail 0（4122ms，PG 臂 1785ms）；
`tests/unit/favorites-history-store-pg.test.mjs` ⇒ 8 / pass 8 / fail 0（31137ms）；
`tests/unit/favorites-history-deletion-registration.test.mjs` ⇒ 2 / pass 2 / fail 0（3898ms）；
全量 `npm run test:unit` ⇒ **tests 2453／pass 2452／fail 0／skipped 1（既有跳过，非本片）**，`exit 0`；
两次读数：`91c7329` 轮 `48379ms`、文档修订后复跑一轮 `52475.7ms`（数字同形，耗时随机器负载浮动）。

- 修好 `ci-integration-chain-structure` 之前的一轮曾 **fail 2**：该门禁要求「未接线的新脚本必须显式声明」，
  白名单补上原因后复跑全绿 —— 这是本片**真的**踩到并修掉的仓库守卫，不是放宽（白名单只登记「为何不进
  无 PG 的回环链」，该脚本仍是显式 SKIP 而非静默绿）。
- 观测到一次**与本片无逻辑耦合的偶发**：某轮全量里 `tests/unit/conversation-retrieval-validity.test.mjs`
  的 `expired` 用例得 `blocked` 而非 `insufficient`；**单跑该文件 7/7 通过**，问答域本片一行未改，判为
  高负载下的时序偶发（本片新增多个 PGlite 实例抬高了并发压力）。如实记录，不掩盖、也不据此改别人的断言。

### 5.3 真库读数（PostgreSQL **17.11**，本人实跑；隔离集群 `127.0.0.1:55449`）

**A. 端到端脚本** `tests/integration/favorites-history-pg.mjs`（12 组逐条打印）：首行
`Real PostgreSQL patch: 17.11`，末行 **`ALL PASS (12 groups) — real PG17 17.11`**，`exit 0`，**4803ms**。

| # | 组（脚本原话摘要） | 结果 |
| --- | --- | --- |
| 1 | `0018` 在真库应用成功（4 张表）、重复应用 no-op | PASS |
| 2 | 两个 store 如实声明 `persistent=true` | PASS |
| 3 | 收藏/历史写入后逐字段读回（`job_state` 终态不被折叠） | PASS |
| 4 | 收藏/历史双路去重均由唯一约束裁决，行数不增 | PASS |
| 5 | 同一目标不同主体各一行；列表/去重只按 `owner_id` 过滤 | PASS |
| 6 | CAS 删除：版本不符/他人/不存在逐条拒绝，命中即物理删除 | PASS |
| 7 | 幂等台账真落库：claim/complete/release/过期清理与内存同语义 | PASS |
| 8 | `awaitIdempotencySettled` 由**独立连接**的写入唤醒（非进程内假象） | PASS |
| 9 | HTTP 面：real+pool 真的 201/200 落库；他人 id 与不存在同形 404 | PASS |
| 10 | 进程重连（新连接池）后收藏行仍在 | PASS |
| 11 | 注销清空 `deleteAllByOwner` 返回真实删除行数（两域各一次，他人行不受影响） | PASS |
| 12 | 回滚脚本 `0018_favorites_history.down.sql` 整表拆干净 | PASS |

**B. 并发探针**（临时脚本、跑完即删，未入库；连接池 `createPool(url.href)` 即生产同款 `max: 4`）：
24 路并发同一收藏目标 ⇒ `inserted=1 duplicate=23 rows=1`；16 路并发同一 `event_key` ⇒
`inserted=1 duplicate=15 rows=1`；2 路并发 CAS 删除同一行（同 `revision=1`）⇒
`ok=1 refused=[NOT_FOUND] remaining_rows=0`。⇒ 去重不是先查后写的假象，输的那一路读到的是
「行已不存在」（`NOT_FOUND`），不是「版本变了」。

**C.** 注销清库的 `audit()` 计数 `{favorites: 1, history: 2}` 由单测（PGlite 引擎）取得，见 §5.1 第 5 条；
真库侧对应证据是上表第 11 组（返回真实删除行数），两者不互相冒充。

### 5.4 未取得项（如实单列，不以推断代替读数）

1. ~~真 PG17 读数：未取得~~ → **已取得**（§5.3）。上一版写「本机无 psql」是伪断言（`psql` 17.11 在
   `.pg17\pgsql\bin`，只是不在 `PATH`）；PGlite 仍只作 SQL 语义旁证，不冒充 PG17 证据。
2. **CI workflow：未新增。** 其它 `*-pg.mjs` 各有 `*-postgres.yml`，本片未加；已在
   `ci-integration-chain-structure.test.mjs` 白名单写明原因（「本片未新增对应 CI workflow」）。
3. **`privacy/**`、`account-deletion-pg.mjs`、`db/pool.ts`**：按派单禁区**未改**（#256 在飞）。
4. **契约与 miniprogram**：未改（五条 operation 的形状与错误码不变）。

## 6 边界（做了什么、没做什么）

- **只加**持久化层与装配分支：路由、服务层、可见性端口、幂等协议、注销协议**均未改签名**。
- **不建跨 worktree `node_modules` 目录联接**（仓库明令禁止）：本 worktree 内 `npm ci` 装真实目录。
- **未 rebase／未 force／未推 main**；未删除或跳过任何既有断言（三处「real 恒 503」是**改写为二分**，
  无 `pool` 臂一字未删）。
- 迁移号按全局命名空间核对：`refs/remotes/upstream/` 175 个 ref 与 `refs/remotes/origin/` 175 个 ref
  均无 ≥ `0017` 的迁移；本地 `refs/heads/` 中仅 `feat/gy-i22-suspend-authority` 有 `0017`（故本片用 `0018`）。

## 7 复现

```bash
git switch feat/gy-i16-favorites-history-pg
npm ci --ignore-scripts
npm run lint && npm run test:unit && npm run test:integration:http
npm run test:docs && node tools/verify-contract-status.mjs && git diff --check
# 真库（需本机 PG17 与专用空库）：
FAVORITES_HISTORY_PG_TEST_URL=postgres://postgres@127.0.0.1:5432/gengyun_favorites_history_test \
  node tests/integration/favorites-history-pg.mjs
```

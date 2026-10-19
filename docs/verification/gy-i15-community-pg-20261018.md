# GY-I15（#15）切片 C1 · 社区域 PostgreSQL 持久化 证据

- **任务**：GY-I15（issue **#15**）阶段 2：为社区域建立 Postgres 持久化，并接进现有装配（与 I17 消息域同款分层）。
  派单：`E:\GengYunCommander\.pg17\dispatch\i15-community-pg.md`。
- **日期**：2026-10-18。
- **工作树**：`E:\GengYunCommander\.pg17\wt-community-pg`（detached @ `0856e49e31bbc5dff3615b146cf9ce12e88a0b49`，`git rev-parse HEAD` 实测一致）。
- **迁移号裁定**：本片用 **`0022`**。`0019`–`0021` **是有意缺号**（分属 I17/I18 切片，各自分支自带迁移号），
  本片**不造占位迁移**；该缺号的 CI 后果见 §6-F3。
- **合流复核（2026-10-19，`upstream/main` = `31a746d`）**：上游 I17 的 `0019_messages_persistence.sql` 与
  I18 的 `0020_feature_flags.sql`（#282）已随上游进入本片树，`0021`（I18 切片 #279）仍未合 ⇒ 树上迁移
  **21** 个（`0001..0020` ＋ `0022`）、`rollback/` **20** 个；I24 索引页读数同步为 21/20/30（见该页头部「合流复核三」）。
  §6-F3 的缺号红**仍在**，只是缺号由 `0019`–`0021` 收窄为仅 `0021`；本片仍未改号、未放宽断言。
- **本机 PG**：仓自带的 `E:\GengYunCommander\.pg17\pgsql\bin`（`psql --version` = `psql (PostgreSQL) 17.11`）；
  本片自起隔离集群 `E:\GengYunCommander\.pg17\pgtmp-community`（`initdb -U postgres -A trust -E UTF8 --locale=C`，
  `pg_ctl -o "-p 55432 -c listen_addresses=127.0.0.1"`，`server_version` = `17.11`）。
  `%TEMP%` 下建目录实测 **Permission denied**，故数据目录落在工作树外的 `.pg17\` 兄弟目录。
- **未发起任何真实第三方/付费调用**；未使用任何真实凭据；未改前端、未改对外 API 契约手写部分。

## 1 交付物

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `services/api/db/migrations/0022_community_persistence.sql` | 新增 | 六张表 `community_posts`/`community_comments`/`community_likes`/`community_reports`/`community_moderation_decisions`/`community_idempotency` + 三处唯一约束 + 八个业务索引 + 台账过期索引；复用 0001 的 `visibility`/`audit_state`/`linked_target_type` 枚举 |
| `services/api/db/migrations/rollback/0022_community_persistence.down.sql` | 新增 | 逆序 `DROP TABLE IF EXISTS`，纯新增对象，不动既有表/数据 |
| `services/api/src/community/store-pg.ts` | 新增 | `createPostgresCommunityStore({ pool })` 实现既有 `CommunityStore` 全部 20 个方法，`persistent: true` |
| `services/api/src/app.ts` | 改动（3 处） | ① 导入 `createPostgresCommunityStore`；② 装配选型：`pool !== null` ⇒ PG store，否则内存 store；③ real 门禁表达式改为 `executionMode === 'real' && !communityStore.persistent`，503 文案同步为「无连接池 ⇒ 内存 store 不持久」 |
| `tests/unit/community-store-pg-contract.test.mjs` | 新增 | 记录型假池锁**语句形状**与语义（23 项） |
| `tests/integration/community-pg.mjs` | 新增 | 真 PG17 端到端（**23 组**，逐组 `PASS n:` 计数）；未设 `COMMUNITY_PG_TEST_URL` 时**显式跳过并明说没验证** |
| `tests/unit/ci-integration-chain-structure.test.mjs` | 改动 | `UNWIRED_DECLARATIONS` 登记本片真库脚本 + 原因（该门禁要求「未接线必须显式声明」） |
| `docs/verification/gy-i24-release-materials-index-20261017.md` | 改动 | 当前读数 18/17 ⇒ **19/18**；并写明 `0019`–`0021` 为有意缺号（`tests/unit/release-materials-index.test.mjs` 要求索引写明当前数量） |

## 2 迁移 0022：表、约束、索引

| 表 | 关键列 | 约束/索引 |
| --- | --- | --- |
| `community_posts` | `id uuid PK`、`revision >= 1`、`author_id uuid NOT NULL → users(id)`、`title varchar(120)`、`body varchar(8000)`、`crop_id varchar(80)`、`region_code varchar(6)`、`media_ids jsonb`、`linked_target_type/id/revision` 三列、`visibility`、`audit_state`、`created_at`/`updated_at` | 三列同空/同有 CHECK；`region_code ~ '^33[0-9]{4}$'` |
| `community_comments` | `id uuid PK`、`post_id uuid NOT NULL → community_posts(id) ON DELETE CASCADE`、`author_id → users(id)`、`body varchar(4000)` | 内容行不可变（编辑升 revision 由服务层保证） |
| `community_likes` | `target_type varchar(16)`（`post`/`comment`）、`target_id uuid`、`user_id uuid → users(id)` | `UNIQUE (user_id, target_type, target_id)` ⇒ 并发/绕过应用层都收敛到一行 |
| `community_reports` | `id uuid PK`、`reporter_id → users(id)`、`target_type/id/revision`、`reason_code varchar(16)`（五值闭集）、`detail text NULL`、`state varchar(16)`（`received`/`isolated`/`closed`） | **不建** `(reporter_id,target…)` 唯一约束：同人可对同目标重复举报（与内存实现一致），见 §2-偏离② |
| `community_moderation_decisions` | `target_type`、`target_id`、`target_revision`、`decision`、`reason_codes jsonb`、`hard_rule_passed`、`rule_version varchar(120) NULL`、`text_digest`、`contract_complete`、`missing_contract_fields jsonb` | `PRIMARY KEY (target_type,target_id,target_revision)` ⇒ 结论按「写到哪一版」唯一 |
| `community_idempotency` | `scope varchar(200)`、`key_hash bytea`、`request_hash`、`response_status smallint (100..599)`、`outcome jsonb`（NULL 或对象）、`expires_at timestamptz` | `PRIMARY KEY (scope,key_hash)` + `expires_at` 索引 |

索引（覆盖派单要求的三条读路径）：

1. `community_posts_feed_idx (crop_id, region_code, created_at DESC, id DESC)` —— **作物/地区筛选 + 稳定倒序游标**；
2. `community_posts_visibility_created_idx (visibility, created_at DESC, id DESC)` —— 列表按可见性收窄；
3. `community_posts_author_created_idx (author_id, created_at DESC, id DESC)` —— 作者自查；
4. `community_comments_post_created_idx (post_id, created_at ASC, id ASC)` —— 评论按对象正序（与内存实现同序）；
5. `community_likes_target_idx (target_type, target_id)` —— 点赞计数；
6. `community_reports_state_created_idx (state, created_at DESC, id DESC)` —— **未处理/待处理事件**；
7. `community_reports_target_idx (target_type, target_id)` —— 按对象查处理状态；
8. `community_idempotency_expires_idx (expires_at)` —— 过期占位清理。

**为何不复用 0001 已建的 `posts`/`post_versions`**（四条硬冲突，逐条实测）：

1. 0001 的 `posts.author_ref` 外键指向 `public_authors(id)`，而本片作者目录是**内存假名投影**
   （`createLocalPseudonymousAuthorDirectory()`），`PostRecord.author_id` 是 `users.id` —— 写 `posts` 会撞 FK；
2. 0001 的 `post_versions.linked_target_id` 是 `uuid`，而社区契约里 `KnowledgeTarget.id` 是**任意字符串**
   （既有用例传 `spc-1`）—— 类型不兼容；
3. 0001 的 `post_versions` 无 `media_ids`（媒体另在 `content_media_refs`，需 `media(id)` + `media_revision`），
   而社区契约要求按 revision 快照 `media_ids`；
4. 0001 的 `post_versions` 是**逐 revision 不可变**的版本表，但社区服务在**同一 revision** 上会重审并写回
   `audit_state`/`visibility`（`service.ts` 的删除/重审路径），语义冲突。

⇒ 本片新建 `community_*` 前缀表，**不修改** 0001 的任何对象；0001 头注承诺「其余表在后续迁移按同一契约补齐」，
本片是该承诺在社区域的一次兑现，遗留问题（两套 posts 并存）见 §7-R3。

**有意偏离数据字典的两处**（必须在审查时可见）：

- ① 表名加 `community_` 前缀（数据字典写作 `posts`/`comments`/`likes`/`reports`/`moderation_decisions`）：
  0001 已占用 `posts`/`post_versions` 且语义不同，直接重名会迫使改既有迁移或产生第二套同名表。
- ② `reports` 不建 `(reporter_id,target_type,target_id,target_revision)` 唯一约束：内存实现对同人重复举报是
  **允许**的（每次一条记录），建唯一键会让 PG 实现与内存实现语义分叉。

## 3 store 逐方法对齐（PG 与内存**同接口、同语义**）

| 方法 | 内存实现 | PG 实现（关键决定） |
| --- | --- | --- |
| `insertPost` / `insertComment` | Map 里先查后写 | 单事务：`INSERT … ON CONFLICT (id) DO NOTHING RETURNING id`（冲突 ⇒ `false`）＋同事务写结论（键 = **record 自身** `(type,id,revision)`）；`insertComment` 另在事务内 `SELECT … FOR SHARE` 校验父帖存在/未删除/revision 相符，不符 ⇒ `false` **且不写结论** |
| `commitPostIfCurrent` / `commitCommentIfCurrent` | 同序判定后合并 patch | 单事务：`SELECT … FOR UPDATE` → **判定顺序逐条与内存一致**：`NOT_FOUND` → `DELETED`（`visibility='deleted'` 单向门，先于归属）→ `AUTHOR_CHANGED` → `REVISION_CHANGED` → `VISIBILITY_CHANGED` → `AUDIT_STATE_CHANGED` → `UPDATE` → 结论键用**写入后的 revision** |
| `getPost`/`getComment`/`listPosts`/`listComments` | 数组快照 | **每次真读库，零缓存**（读取时重查可见性的前提，见 §4） |
| `addLike`/`removeLike`/`countLikes` | Set + 计数 | `INSERT … ON CONFLICT DO NOTHING RETURNING id` 判「是否真的新增」；`DELETE … RETURNING id` 判是否真的取消；`count(*)::bigint` —— 计数由行派生，不存冗余计数 |
| `getModeration` | `Map<复合键>` | `SELECT … WHERE target_type/target_id/target_revision` 三列主键精确命中 |
| `putRefusalVerdict` | 已有结论则不覆盖；该 revision 内容已存在则不写 | **单语句**三条 `NOT EXISTS` 守卫 + `ON CONFLICT DO NOTHING`，无读写竞争窗口 |
| `insertReport`/`getReport` | Map | `INSERT … ON CONFLICT (id) DO UPDATE`（幂等重放按 id 覆盖）＋按 id 读；`state` 只由服务层流转 |
| `findIdempotency`/`claimIdempotency`/`completeIdempotency`/`releaseIdempotency`/`awaitIdempotencySettled` | 进程内三态台账 | 落 `community_idempotency`：`claim` 先清过期同键行再 `INSERT … ON CONFLICT DO NOTHING`；`complete` 只写 `outcome IS NULL` 的行；`release` 只删未完成行；`awaitIdempotencySettled` **有界轮询每次真读库** |
| `countModeration`/`snapshotCounts` | 同步计数 | 一条 SQL 取四个 `count(*)::bigint` |
| `persistent` | `false` | `true` |

错误折叠与 I17 同口径：`57014`/`55P03` ⇒ `ApiError('PROVIDER_TIMEOUT', …, {retryable:true})`；
已是 `ApiError` 原样抛；其余 ⇒ `ApiError('PROVIDER_UNAVAILABLE', …, {retryable:true})`。
行映射对闭集外的值**抛错**而不是静默降级。

## 4 读取时重查可见性（不因缓存复活）

- store 侧：`getPost`/`getComment`/`listPosts`/`listComments` **每次都发一条 SELECT**，进程内不存副本；
- 服务侧：`effectiveState()`（`services/api/src/community/service.ts`）在每次投影前重新取 `getModeration(kind,id,revision)`，
  缺失/`target_ref` 不符/`text_digest` 不符 ⇒ 降级 `hidden`+`pending`；`visibility==='deleted'` 直接不可读；
- 真库验证（`community-pg.mjs` PASS 7）：直接 `UPDATE community_posts SET visibility='hidden'` 后，
  下一次 `getPost`/`listPosts` **立即**反映；恢复可见后立即可读 —— 证明没有跨请求缓存能让失效内容复活。

## 5 实测读数（逐字，全部本机实跑）

### 5.1 门禁与测试

| # | 命令 | 实测读数 |
| --- | --- | --- |
| 1 | `npm ci --offline --ignore-scripts` | `added 103 packages, and audited 106 packages in 5s` / `found 0 vulnerabilities` |
| 2 | `npx tsc -p services/api/tsconfig.json --noEmit` | **无输出**，`exit 0` |
| 3 | `node --test --test-isolation=none tests/unit/community-store-pg-contract.test.mjs` | `tests 23 / pass 23 / fail 0 / duration_ms 79.8183` |
| 4 | `node --test --test-isolation=none tests/unit/community-*.test.mjs` | 改动前基线 `tests 101 / pass 101 / fail 0 / duration_ms 3100.3851`；改动后 **`tests 124 / pass 124 / fail 0 / duration_ms 3356.1757`**（101 + 本片 23） |
| 5 | `node tests/integration/community-pg.mjs`（`COMMUNITY_PG_TEST_URL=postgres://postgres@127.0.0.1:55432/gengyun_community_test`） | `PASS 1` … `PASS 23`，末行 `全部 23 组真库断言通过。` |
| 6 | `node tools/verify-contract-status.mjs` | `exit 0`；`PASS: … implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项`；`PASS: 中文表格一致` |
| 7 | `node tools/verify-release-materials.mjs` | `15/15 项通过（离线文档核验；不代表部署、云端或运行期已验收）`；第 8 项：`迁移 19 个（0001..0022），down 18 个（0002..0022），无 0001` |
| 8 | `node --test --test-isolation=none tests/unit/ci-integration-chain-structure.test.mjs` | `tests 7 / pass 7 / fail 0` |
| 9 | `node --test --test-isolation=none tests/unit/release-materials-index.test.mjs` | `tests 5 / pass 5 / fail 0` |
| 10 | `git diff upstream/main --check` | **无输出**；`git status --porcelain` 交付前为空 |

真库集成测试的 23 组覆盖（每组都是数据库才能证明的性质）：
迁移可重入 / 六表且未动 0001 对象 / 唯一键与索引真的存在 / 逐字段往返（`spc-1` 文本知识 id、
`media_ids` 数组、`timestamptz`→ISO）/ 同 id 再插入 `false` 且不产生第二行 / 结论三元组 +
`putRefusalVerdict` 不覆盖 / 读取无缓存 / CAS 四种失败原因逐条 / 编辑 revision 1→2 结论独立 /
只改可见性不升 revision / 评论父帖校验 + 正序 / 外键真挡孤儿行（`23503`）与级联清理 /
10 并发点赞只新增 1 行 / 唯一键直插 `23505` / 举报按 id 覆盖且同人可重复 /
台账五步 / 过期占位被物理清掉 / `snapshotCounts` 与真库一致 / down 幂等且不碰 `community_media_grants` /
apply→rollback→再 apply 收敛 / HTTP 面真落库 / real 门禁（有真库开启、无连接池 503）。

### 5.2 迁移 0022：apply → rollback → 再 apply（psql 逐字）

```
$ psql -d gengyun_i15_psql -f services/api/db/migrations/0001_initial_schema.sql
CREATE TABLE … CREATE INDEX … COMMIT
$ psql -d gengyun_i15_psql -f services/api/db/migrations/0022_community_persistence.sql
CREATE TABLE … CREATE INDEX … COMMIT
$ psql -tAc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'community%' ORDER BY tablename"
community_comments
community_idempotency
community_likes
community_media_grants      <- 0001 的表（GY-I06 媒体授权），本片未创建、也不得删除
community_moderation_decisions
community_posts
community_reports

$ psql -d gengyun_i15_psql -f services/api/db/migrations/rollback/0022_community_persistence.down.sql
DROP TABLE
COMMIT
$ psql -tAc "<同上查询>"
community_media_grants      <- down 后只剩 0001 的表：撤掉本片 6 张表，未误删同前缀的既有表

$ psql -d gengyun_i15_psql -f services/api/db/migrations/0022_community_persistence.sql
COMMIT
$ psql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'community%'"
7
```

### 5.3 全量单进程跑（如实登记，**不是本片引入**）

`node --test --test-isolation=none tests/unit/*.test.mjs` ⇒ `tests 1640 / fail 8`，8 项**全部**落在
`/knowledge`、`/herbicides` 域。根因是 `tests/unit/favorites-visibility-wiring.test.mjs:34` 在**模块顶层**
设置 `process.env['APP_KNOWLEDGE_UNVERIFIED_SEED'] = '1'` 且从不还原，单进程模式下泄漏给后续文件。
已用**两个文件**复现该失败（`node --test --test-isolation=none tests/unit/favorites-visibility-wiring.test.mjs
tests/unit/knowledge-herbicides-http.test.mjs` ⇒ `tests 13 / pass 12 / fail 1`，同样的 `/knowledge 默认不并入浙江首批`），
不涉及本片任何改动。官方 `npm run test:unit`（`node --test "tests/unit/*.test.mjs" …`，默认逐文件隔离）不受影响；
本机因 spawn 管道 `EPERM` 无法运行官方形态，故只能用 `--test-isolation=none` 单文件跑（派单指定方式）。
结论：**本片未新增失败**，该 8 项是单进程跑法的既有产物，属既有债务（建议另开切片修 `favorites-visibility-wiring` 的 env 还原）。

## 6 未取得项与原因

| # | 未取得 | 原因 / 边界 |
| --- | --- | --- |
| F1 | **real 模式下的真实写入 201** | `POST /api/v1/posts`（带 `idempotency-key`）在 `executionMode:'real'` 下返回 503 `PROVIDER_UNAVAILABLE`，原文：`real 模式未接真实审核供应商（tms/ims 未授权、BizType 未核验）：审核不可用，拒绝以替身/内存返回成功封套`。存储门禁本身**已开**（`app.communityService !== null` 断言通过），503 来自**审核域**（派单明示供应商外部阻塞、不在本片范围）。因此 HTTP 写入/点赞/举报的端到端断言在 **stub 配置 + 真 pool** 下完成（store 仍是 PG）：`PASS 21` 证明 201/200 各对应真库一行 |
| F2 | **本片没有自己的 CI workflow** | 派单禁止改 `.github/`；`community-pg.mjs` 因此不进 `test:integration:http` 链，只在 `UNWIRED_DECLARATIONS` 里白名单登记（不设 env 时显式 SKIP，不静默绿）。要接 CI 需另开切片加 workflow |
| F3 | **`auth-privacy-postgres-17.11` 会因缺号转红（已知、必红）** | `tests/integration/migrations-negative-pg.mjs:47-63` 断言「版本号在 `1..max` 上连续无缺号」且「迁移数 === 最大版本号」；本片引入 `0022` 而 `0019`–`0021` 缺号 ⇒ 该脚本在模块顶层断言失败，而它正是 `auth-privacy-postgres.yml:39` 的步骤。**未放宽、未修改该断言**（派单禁止）。合流时的处置二选一：等 I17/I18 把 `0019`–`0021` 补齐后自然转绿，或由指挥裁定本片改用连号 |
| F4 | **媒体投影仍为空** | `projectPost` 的 `media: []` 是既有行为（媒体域未接线），本片只持久化 `media_ids` 快照，未接 `content_media_refs`/签名 URL |
| F5 | **未做注销清理接线与后台清理任务** | 本片未在注销（`purgeOwnerData`）路径上登记社区数据；台账过期行靠「查询时顺带物理删除」，无定时清理。二者都需改本片范围外的装配，见 §7-R1/R2 |
| F6 | **未接 AI 审核供应商、未做前端** | 派单明示不在本片范围 |

## 7 残留风险

- **R1（中）注销不清社区数据**：`community_posts/comments/likes/reports` 的 `author_id`/`user_id` 外键是默认
  `NO ACTION`（不带 CASCADE），因此未来若引入物理删用户，会被 FK 报错**挡住**（fail-safe，不静默留孤儿），
  但**当前没有**把社区行纳入「注销在线 7 日」的清理清单 —— 需在注销切片补 `deleteAllByOwner` 等价物。
- **R2（低）台账只增不减的残余**：过期行依赖下一次同 `(scope,key_hash)` 查询顺带删除；只重放一次就再没人查的
  key 会一直留到该行的 `expires_at` 之后仍存在（占空间，不影响语义）。需要后台清理任务才能彻底收敛。
- **R3（中）两套 posts 并存**：0001 的 `posts`/`post_versions` 与本片 `community_posts` 语义不同且互不同步；
  未来若接 `public_authors`（真名/假名投影落库）需做一次迁移合并，届时要处理 revision 归属与 `audit_state` 可变性冲突。
- **R4（低）计数非物化**：`countLikes` 每次 `count(*)`，热门对象上是全表扫；当前无缓存、无冗余计数列。
- **R5（低）集成测试需手建库**：`community-pg.mjs` 要求空库 `gengyun_community_test`，且每轮前必须 `dropdb`+`createdb`；
  未自动化（F2 的连带）。

## 8 复跑命令（本机实测有效）

```powershell
# 0) 依赖
cd E:\GengYunCommander\.pg17\wt-community-pg; npm ci --offline --ignore-scripts
# 1) 类型
npx tsc -p services/api/tsconfig.json --noEmit
# 2) 单元（契约测 + 全部社区单测）
node --test --test-isolation=none tests/unit/community-store-pg-contract.test.mjs
node --test --test-isolation=none tests/unit/community-*.test.mjs
# 3) 起隔离集群（已起过则跳过）
$bin='E:\GengYunCommander\.pg17\pgsql\bin'
& "$bin\pg_ctl.exe" -D E:\GengYunCommander\.pg17\pgtmp-community\data -l E:\GengYunCommander\.pg17\pgtmp-community\data\server.log -o "-p 55432 -c listen_addresses=127.0.0.1" -w start
# 4) 真库集成（必须先重建空库）
& "$bin\dropdb.exe" -h 127.0.0.1 -p 55432 -U postgres --if-exists gengyun_community_test
& "$bin\createdb.exe" -h 127.0.0.1 -p 55432 -U postgres gengyun_community_test
$env:COMMUNITY_PG_TEST_URL='postgres://postgres@127.0.0.1:55432/gengyun_community_test'
node tests/integration/community-pg.mjs
# 5) 门禁
node tools/verify-contract-status.mjs
node tools/verify-release-materials.mjs
```

> 本页只写**实测读数与未取得项**；「离线/本机通过」不等于部署、云端或运行期已验收，也不等于审核准确率证据。

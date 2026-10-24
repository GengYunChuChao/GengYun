# GY-R34 / #19 片 2 证据页：媒体行侧物理删除（迁移 0035）

- 日期 2026-10-24｜分支 `feat/gy-r34-media-purge`｜基线 `upstream/main`（#528 已合入，`0034` 在树上）
- 片 2 只做「媒体行」这一段；注销闭集 #19 的其余段落另立片
- 结论：**只加一条窄函数 + 一条 EXECUTE**。`public.media` 对运行时仍然零表级 DELETE；探针、`expected_42501`、`deploy-sql-gate.yml` **逐字未动**（读数见 §6）
## 1. 交付面

| 文件 | 变化 |
| --- | --- |
| `services/api/db/migrations/0035_r34_media_row_purge.sql` | 新增：定义 `public.purge_owner_media(uuid)` |
| `services/api/db/migrations/rollback/0035_r34_media_row_purge.down.sql` | 新增：`DROP FUNCTION IF EXISTS`（只有函数可逆） |
| `deploy/postgres-cvm/sql/20-login-roles.sql` | 新增段 D4：`REVOKE ALL` + **仅** `GRANT EXECUTE`，一张表都没加权限 |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | `function_surface_manifest` 17 → 18 行（`purge_owner_media` = `runtime`） |
| `tests/unit/r34-media-row-purge-migration.test.mjs` | 新增：迁移/回滚/授权面静态形状测试（**11 列引用面逐条断言** + **逐桶列绑定** + **守卫位置/形态** + 22 条负控制，其中 3 条做「改坏⇒红 / 逐字节还原⇒绿」双向自证 + 回滚/授权面 3 条） |
| `tests/unit/least-privilege-expected-parity.test.mjs` | 扩写：`media` 进「禁止 DELETE」清单 + 新增第 6 个成对测试 |
| `tests/integration/media-row-purge-pg.mjs` | 新增：真库臂（缺 `GY_PG_BIN` 显式 77 退出，见 §8）；返修补 `[5b]` **无外键八列**引用面 case |
| `tests/unit/ci-integration-chain-structure.test.mjs` | 未接线白名单登记上面那条真库臂 |
## 2. 为什么不用表级 `GRANT DELETE`（裁定，不是权衡）

`20-login-roles.sql` 段 M 的原句，逐字：

```
\echo '20-login-roles.sql：media 故意不授 DELETE —— 删除是状态机（deleting→deleted，UPDATE state），媒体行是审计与计费事实，不物理删。'
```

片 2 **没有**推翻这句，反而用上了它：`public.media` 仍然一个表级 DELETE 都没有（`media_derivatives` /
`media_object_cleanup` 的表级 DELETE 是既有的，本片未动）。PostgreSQL **没有列级 DELETE**，所以「删一行 media」
没法用列级授权表达；唯一既能删行、又只放开四个谓词的写法，就是一条 `SECURITY DEFINER` 窄函数 ——
把「谁能删」交给 `GRANT EXECUTE`，把「删什么」锁在函数体里。
## 3. 函数签名与读数

```
CREATE FUNCTION public.purge_owner_media(p_owner uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
  SET TimeZone = 'UTC'
```

- 三件套齐；函数体内业务对象全部 `public.` 限定（`public.media` / `public.media_derivatives` /
  `public.media_object_cleanup` / 下面 §4③ 列的 **11 列**引用面所在 11 张表）。
- 结尾 `REVOKE ALL ON FUNCTION public.purge_owner_media(uuid) FROM PUBLIC;` ⇒ 默认 PUBLIC EXECUTE 被收回，授权面只剩段 D4 一条。
- 参数域：`p_owner IS NULL` ⇒ `RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST'`（与 0016/0017/0031/0034
  同码同义：NULL 主体是调用错误，不是「没有目标」）。
- 返回读数键（`jsonb`，**5 个**）：`media`＝本次物理删除的媒体行数；`derivatives`＝随之删掉的派生行数（显式先删，不从级联里藏）；
  `queued`＝目标集里已入队的清理意图行数；`skipped_referenced`＝终态但被引用、因此刻意留原地的行数；
  **`skipped_referenced_by`（返修新增，嵌套对象）**＝按引用**类别**再分一层的计数，键闭集恰好 8 个：

  | 桶 | 覆盖的列（共 11 列） |
  | --- | --- |
  | `content` | `public.content_media_refs.media_id` |
  | `grants` | `public.community_media_grants.media_id` |
  | `avatar` | `public.public_authors.avatar_media_id` |
  | `user_avatar` | `public.users.avatar_media_id` |
  | `ocr` | `public.ocr_jobs.media_id` **或** `public.ocr_records.media_id` |
  | `recognition` | `public.recognition_jobs.media_id` **或** `public.recognition_records.media_id` |
  | `speech` | `public.speech_jobs.media_id` **或** `public.transcriptions.media_id` |
  | `community` | `public.community_posts.media_ids`（`text[]`，按元素比） |

  **桶之间互不排斥**：一行终态媒体同时被 OCR 与社区引用时 `ocr` 与 `community` 各 +1，而 `skipped_referenced` 只 +1 ⇒
  恒有 `sum(桶) ≥ skipped_referenced`（相等表示本批无重叠）。⛔ 不要把它当成分区读数去求和当总数。
## 4. 三条硬条件怎么落的

- **① 入队先于删行**：先对目标集逐行比对「仍存活的对象引用数」与「台账行数」，只要有目标「活引用 > 台账行」，就
  `RAISE EXCEPTION USING ERRCODE = 'G0007', MESSAGE = 'MEDIA_CLEANUP_NOT_QUEUED'` —— 异常在**任何 DELETE 之前**抛出，整批不删。
  「已清空」的判据是密文列的空信封（`v1.<iv 16>.<tag 22>.` 以 `.` 收尾）；**认不出来的形状一律按「仍持有对象」处理**（fail-closed）。
  边界如实写：这是**计数式**前置，不是摘要级比对 —— SQL 侧没有 HMAC 密钥，无法把意图行与具体对象键对上，所以它证明的是
  「没有未入队的活引用」，而非「每条意图都恰好对应一个活引用」。
- **② 只删终态**：`m.state IN ('rejected', 'deleted')`。`initiated/uploaded/processing/ready/deleting` 一律不碰
  （`deleting` 是状态机中间态，桶删除未确认 ⇒ 该行留到清理器确认之后）。
- **③ 不越过引用（返修：口径从「三处」扩到「11 列 / 8 类」）**：上一版只认三处，而审计实测本库还有 **8 列只存 media
  uuid、且故意没有外键**的引用列 —— 这些行指着某条 media 时，上一版函数**照样把 `public.media` 行删掉**；因为**没有外键**，
  数据库**不会**报 `23503`，结果是一串**悬空 uuid**（图片/识别/语音链路之后按 `media_id` 取对象只会拿到空），而且**无法自查**
  （media 行没了，连「这行曾经是什么」都查不回来）。这是本片唯一的阻塞项，已按下表逐列补齐（列 → 迁移:行）：

  | # | 表.列 | 迁移:行 | 外键 |
  | --- | --- | --- | --- |
  | 1 | `public.content_media_refs.media_id` | `0001:298` | 有（无级联） |
  | 2 | `public.community_media_grants.media_id` | `0001:315` | 有（无级联） |
  | 3 | `public.public_authors.avatar_media_id` | `0001:236` | — |
  | 4 | `public.users.avatar_media_id` | `0001:40` | — |
  | 5 | `public.ocr_jobs.media_id` | `0024:90` | — |
  | 6 | `public.ocr_records.media_id` | `0024:113` | — |
  | 7 | `public.recognition_jobs.media_id` | `0025:113` | — |
  | 8 | `public.recognition_records.media_id` | `0025:135` | — |
  | 9 | `public.speech_jobs.media_id` | `0026:95` | — |
  | 10 | `public.transcriptions.media_id` | `0026:116` | — |
  | 11 | `public.community_posts.media_ids` | `0022:70` | —（`text[]`，CHECK 上限 3 项） |

  语义不变：**被任何一处引用 ⇒ 该 media 行不删、计入 `skipped_referenced`**，并按 §3 的 8 个桶给出 `skipped_referenced_by`。
  形状要点（都有静态断言钉着，见 §7）：
  · 目标集 11 条 `NOT EXISTS`，与「跳过读数子查询」里的 11 条 `EXISTS` **逐字同形**（每列各恰好出现两次：一处被 `NOT`
    包住、一处裸的）—— 少写一处就是「删了不该删的」或「少报」二选一；
  · 分层计数只写**一遍** `EXISTS`：作为子查询的 8 个布尔列 `ref_<桶>`，`skipped_referenced` 与 8 个桶都从同一批布尔列聚合，
    再靠 `count(*) FILTER (WHERE t.ref_<桶>)` 取数（逐字重写第二遍才是错报的温床）；
  · 数组列（第 11 处）用 `m.id::text = ANY (p.media_ids)`：把 **uuid 侧**转文本后与数组元素直接比（`text = text`），
    **不拼字符串、不猜分隔符、不取下标**；等价于 `EXISTS (SELECT 1 FROM unnest(p.media_ids) e WHERE e = m.id::text)`。
    第 4 处（`users.avatar_media_id`）今天**没有写入方**，仍并入口径：口径按「库里有这一列」定，不按「今天有人写」定。
  · **刻意不算引用**（免得下一轮当漏项）：
    `media_derivatives.media_id`（同一个删除单元的子行，本函数先删它）；
    `media_object_cleanup.media_id`（**入队台账**，算成引用会自锁成「什么也不删」）；
    `jobs.target_id`（多态列，`0013:19` 已记明 `INSERT INTO jobs` 在 `services/api/src` 为空）；
    `jobs.result_ref`（`0001:223` 的 `uuid` 列，今天**0 个写入方**：`services/api/src` 与迁移里都没有写它的语句；
    等多态目标侧真长出来再并入）；
    `exports.object_id`（外发**账本**：`services/api/src/privacy/ledger-pg.ts:52-56` 的哨兵注释与 `:106-111` 的 `toRecord`
    注释都写明**媒体维确实把 media uuid 写进 `object_id`**（非媒体维才走 `object_key` + 全零哨兵）⇒ 注销后账本行确实会
    **指向一条已被删掉的 media 行**；但 `0003:120` 的 `object_id` **没有外键**，而外发证据属**保留要求**（注销后 30 日证据），
    ⇒ 刻意保留这个悬空指针，不把它算成「活引用」：否则「外发过一次的媒体」永远删不掉、账本也永远关不掉）。
  · 索引现状如实披露：第 3–11 处**都没有索引**（本片不建；补索引属于各域自己的 schema 变更）⇒ 这些 `EXISTS` 是逐目标行的
    顺序扫描，边界由「单个 owner 的终态 media 行数」兜住。
- **子先父后**：先删 `public.media_derivatives`，再删 `public.media`，两个 `GET DIAGNOSTICS ROW_COUNT` 分开报。
- **并发是 fail-closed，但不是全封**：目标集先查后删。第 1/2 处有外键 ⇒ 若此刻另一事务新插一条引用，第二条 DELETE 会撞
  `23503` 并让整批（含已删的派生行）回滚 —— 安全失败，⛔ 不要吞异常把它变成绿（映射见「语义裁定」段的 `blocked`）。
  **第 3–11 处没有外键** ⇒ 同一窗口内新插的引用**拦不住**，那一行会被删掉、新引用变悬空；函数侧能做的只有「查得比删早一点」，
  真正的护栏是**运行顺序**（见 §10）+ 重试。⛔ 不要为了关掉这个窗口在函数里 `LOCK TABLE` 那 8 张表：那会把注销/撤回的删除
  路径扩成跨域写阻塞，且 READ COMMITTED 下已提交的插入照样拦不住。
## 5. 与 0034 的分工

`0034` 是两个**业务表行**窄函数（`purge_owner_recognitions` / `purge_owner_speech`），清识别/语音域的记录与幂等台账；`0035`
只清**媒体实体行**。两者共用同一套形态（三件套、`G0001`、单事务、`jsonb` 读数、`REVOKE ALL`），但**不合并**：媒体域的删除时机、
引用面（**11 列 / 8 类**，其中 9 列无外键）与失败码（`G0007`）都不同，合并会把媒体域的引用语义塞进业务表函数，让两类账混在一个读数里。
另：0034 删掉识别/语音的行之后，`skipped_referenced_by.recognition` / `.speech` 才会掉下来 —— 这是 §10 顺序前提的一半依据；
另一半是社区域自己清 `media_ids`（`services/api/src/community/store-pg.ts:866 purgeOwnerData`，但其 `visibility='deleted'` 行会
`continue` 不清，故 `community` 桶不会完全降到 0）。
## 6. 禁止面逐字未变的证据

- `deploy/postgres-cvm/evidence/probe-runtime-grants.sql`：对 `public.media`（表）的引用 **0 处**（文件里 15 处 `media` 全是
  别的表的 `media_id` / `media_ids` **列名**）⇒ 媒体域在探针里零命中，本片没有、也不需要新增禁止面。
- 禁止面对象仍然恰好 **9** 个（5 张表 + 2 个 schema + 2 个函数），拆解 6+5+3+2+2 = **18**；`deploy-sql-gate.yml` 未改
  ⇒ `expected_42501=18` 逐字未动。
- `90-assert` 里 `media` 的 expected 行（`expected.del = false`）未改；`media_derivatives` 与 `media_object_cleanup` 的 `true` 未改。
- `git status` 里没有 `.github/**`、`miniprogram/**`、`apps/admin/**`、探针文件、`tools/doc-anchors-baseline.json`。
## 7. 门禁读数

| 命令 | 读数 |
| --- | --- |
| `node tools/verify-migrations-unique.mjs --strict` | EXIT 0；`PASS：5 项判据全部满足（surface / runner / dup / coexist / rollback）；34 条配对 + 1 条登记允许缺省 = 35 条正向迁移逐条有交代` |
| `node --test tests/unit/migration-reservations.test.mjs` | 8 pass / 0 fail |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | 7 pass / 0 fail（返修后复跑，白名单文案同步更新） |
| `node --test tests/unit/sql-column-coverage.test.mjs` | 17 pass / 0 fail（本片不改 store SQL） |
| `node --test tests/unit/deploy-sql-gate-probe.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/least-privilege-expected-parity.test.mjs` | 6 pass / 0 fail |
| `node --test tests/unit/roles-file-disposition.test.mjs` | 11 pass / 0 fail |
| `node --test tests/unit/r34-media-row-purge-migration.test.mjs` | **9 pass / 0 fail**（11 列引用面逐条断言 + 分层计数 + **逐桶列绑定** + **守卫位置/形态**，后两条各带双向变异自证） |
| `node --test tests/unit/doc-anchors-guard.test.mjs` | 10 pass / 0 fail |
| `node tools/verify-doc-anchors.mjs --strict` | EXIT 0；`BASELINE: … 登记 103 条；本次命中 103 条、基线外新增 0 条、陈旧 0 条` |
| `node tools/verify-contract-status.mjs` | EXIT 0；`符号形态锚点 1 条` / `行号区间 244 条` / `中文表格一致` |
| `node --check tests/integration/media-row-purge-pg.mjs` | EXIT 0（返修后重跑） |
| `node tests/integration/media-row-purge-pg.mjs`（无 `GY_PG_BIN`） | **EXITCODE=77**，3 行 SKIP：`SKIP: 未设置 GY_PG_BIN…` / `本次**未验证**…（未取得，不是通过）` / `EXITCODE=77 表示未取得…` |
| `node tests/integration/media-row-purge-pg.mjs`（**真跑**，便携 PG 17.11） | **EXITCODE=0**，`PASS 1`…`PASS 18` + `ALL PASS：18 条真库断言（exit code 0）`；`server_version=17.11`；回环端口取自 **55700–55999**（`pickPort()` 逐字 `55700 + randomInt(0, 300)`；三次实跑 55998 / 55830 / 合并后一次，读数一致 —— 旧版此处误写上界 55799，而 55998 本身就越界，故更正）；收尾集群已停、数据目录已删（`GY_R34_PG_ROOT` 下只剩空目录、端口无监听） |
| `git diff --check` | EXIT 0 |
| `git merge-tree --write-tree upstream/main HEAD` | EXIT 0，无冲突 |

⚠ 门禁本身**不依赖 `node_modules`**（`r34-media-row-purge-migration.test.mjs` 是纯静态形状测试，正是为了让「依赖缺失 ⇒ 静默跳过」
不变成假绿）；真库臂单独用便携 PG 17.11 跑，见上表倒数第三行。
## 8. 已取得 / 未取得

> 取得与未取得分开写：把「已真跑绿」挂在「未取得项（⛔ 都不是通过）」标题下面，读起来是反的。

### 8.1 已取得（本次实测，仅此一条）

1. **真库臂本机真跑绿（便携 PG 17.11）**：`EXITCODE=0`，`PASS 1`…`PASS 18` + `ALL PASS：18 条真库断言（exit code 0）`。
   缺 `GY_PG_BIN` 时仍打印 3 行 SKIP 并 **exit 77**（未取得，不是通过；不认 `--allow-skip`）——同一个脚本两种环境给两种答案，
   这正是它该有的形状。**取得的是「本机真跑」，未取得的是「接进 CI」**，后者见 §8.2 第 1 条。
   ⚠ 真跑共抓到**三处「只有真跑才会暴露」的缺陷**；其中 ① ② 属本 commit，③ **早于本 commit 已修，本 commit 只是复验**：
   · ① `pg_ctl -o` 拿到数组 ⇒ `spawnSync` 用 `,` 拼接成单个字符串，postgres 收到 `-p 55902,-c listen_addresses=…`，日志逐字
     `FATAL:  invalid value for parameter "port": "55902,-c"` + `pg_ctl: could not start server`；改成 `serverOptions().join(' ')`。
   · ② 夹具计数与断言不符：`idsOfMedia()` 只按 `owner_id` 过滤、**不区分 state**，A 组共 **9** 行（3 终态可删 + 3 非终态 +
     3 被引用），原断言写 **6**（把「终态 6 条」当成了「全部行数」）⇒ `A 的媒体行应为 6 条，实际 9`；改成 9，并另加一条
     「终态恰好 6 条」的独立断言，让两个口径各自钉住。
   · ③ **不是本 commit 的战果**：`import pg from 'pg'` 写成静态 import 会被提升到 `GY_PG_BIN` 闸门**之前**，无 `node_modules`
     的树里 `ERR_MODULE_NOT_FOUND` 以 **exit 1** 退出、**根本没走到** SKIP（`skipped` 与 `failed` 在 CI 上语义完全不同）。
     `git show cc89825a:tests/integration/media-row-purge-pg.mjs` 第 54 行交付时**已是** `pg = (await import('pg')).default;`，
     本 commit 的 diff 只动 `startCluster()` 与夹具断言 ⇒ 该修**先在 `cc89825a` 落地**，本轮只复验「闸门后动态 import」这个形状仍在
     （缺 `GY_PG_BIN` ⇒ 77，设了但缺依赖 ⇒ exit 1）。

### 8.2 未取得项（⛔ 都不是通过）

1. **真库臂未接进 CI**：它登记在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 白名单里
   ⇒ CI 上恒 exit 77，**这条臂的缺陷在 CI 上永远不会暴露**（本轮 ①② 两处就是这么活到现在的）；`.github/**` 不在本片授权范围。
2. **桶对象回收仍归 `cleanupOrphans`**：本片只删数据库行，`media_object_cleanup` 台账行**刻意保留**（0029 故意不建外键）——
   字节回收不在本片范围内，台账行留下来正是为了让清理器还能枚举到它们。
3. **运行时接线未做**（理由见 §9）：`services/api/src/privacy/user-data-deletion.ts` 目前**还没有**媒体模块，函数的唯一调用方还不存在。
4. **`23503` 分支仍未取得**：11 列里只有前 2 列有外键、且它们的引用行本来就被 `NOT EXISTS` 排除 ⇒ 构造不出该错误。
   已真库验证的是 `up`、`G0007`（缺入队 ⇒ 整批不删）、`G0001`（NULL 主体）；`42883`（回滚后调用）需先 down 一次，本片未跑。
## 9. 为什么本片不接线（留作下一片）

要做「media 模块」至少牵动五处，且第 ⑤ 条需要产品裁定，不是写手能单方面定的：

1. `services/api/src/media/store.ts` 的 `MediaStore` 接口**新增** `purgeOwnerData`（该接口目前没有任何 purge 原语），连带改
   `createMemoryMediaStore` 与 `createPostgresMediaStore`；
2. `user-data-deletion.ts` 新增 `MEDIA_DELETION_MODULE` 常量、进 `CONDITIONAL_DELETION_MODULES` 与 `ONLINE_EVIDENCE_MODULES`、
   `requiredModules.push` 与 `coordinator.registerModule`；
3. `services/api/src/app.ts` 的注销装配区注入 port（至少一行 import + 一处构造）；
4. `tests/unit/deletion-registration-coverage.test.mjs` 的三处硬编码清单（`['community','recognitions','speech']` → 四域、
   `effective.length === 7` → 8、`MODULE_TABLE_COVERAGE` / `DECLARED_UNREGISTERED` 的 `media` 处置）；
5. **语义裁定（已定，见文末「语义裁定」段）**：`skipped_referenced > 0` 意味着「被引用的行刻意留在原地」。D-9 + U-11 已裁定为
   **两态**：非 0 仍算 `completed`，但证据串必须如实带非零计数（⛔ 不许说「已清干净」）；`partial` **不在冻结协议里**
   （`packages/privacy/constants.mjs:80` 的 `HANDLER_STATES` 只有 `pending/running/completed/blocked`），写它会落非法态分支、
   把 `evidenceRef` 置 null、整条证据串丢掉。

本片只交付「函数 + 授权面 + 清单 + 测试」这一层：可编译、可回滚、可单独上线，且不给后续接线留需要返工的形状。

边界：⛔ 本片不 `DROP TABLE`（`public.jobs` 的 DROP 另立一片）；⛔ 不动探针 / `expected_42501` / `deploy-sql-gate.yml`；⛔ 不放宽任何断言；⛔ 不把新锚点写进 `tools/doc-anchors-baseline.json`。

## 10. 运行顺序前提（**裁定的一部分**，不是免责声明）

本函数**不是**「跑一次就干净」的清洁器，它是「把**此刻已经没有活引用**的终态媒体行删掉」。由此推出一条对运行时接线的硬要求：

> **运行时接线必须把媒体模块排在 `ocr` / `recognition` / `speech` / `community` 各模块之后。**

排在前面**不会报错**，只会稳定地跳过 —— 那是最坏的一类 bug：读数看起来「正常完成」，实际一行都没删。所以这件事不能只在注释里，
必须能被观测到（下面的判据就是它的观测面）。

现状（`services/api/src/privacy/user-data-deletion.ts` 实测，非推测）：

- 必需闭集 `USER_DATA_DELETION_MODULES` = `[favorites, history, messages, conversations]`；条件闭集
  `CONDITIONAL_DELETION_MODULES` = `[community, recognitions, speech]`（装配处按此顺序 `requiredModules.push`）。
- **没有 `ocr` 模块，也没有 `media` 模块**（整份协调器里这两个名字都不存在）⇒ 今天没有任何东西会去清 `ocr_jobs` / `ocr_records`。
  这意味 `skipped_referenced_by.ocr` 是**死桶**：桶里的行数只会随注销量增长，**不会**自己下降。要让它下降，前提是 OCR 域
  先有自己的清理器（另一片的事），本片只负责把它**如实报出来**，而不是假装它是 0。

判定方法（给接线与复审用，两句话即可执行）：

1. 在同一主体的注销里，等**其它模块全部跑完之后**再调媒体模块，比较两次调用的 `skipped_referenced`：
   **它必须单调不增**（⛔ 不是「必然下降」—— 有一类桶恒不降，见下）。0034 的识别/语音清理、社区域清 `media_ids`
   各自让对应桶掉下来是**预期**；但 **`ocr` 桶（今天没有清理器，死桶）与 `community` 的软删行
   （`store-pg.ts:916` 对 `visibility='deleted'` 行 `continue`）这两类恒不降**，所以判据只能是「不增」而不是「下降」。
   若某个**有清理器**的桶两轮之间一点都不降，才说明顺序反了或那个模块没跑。
2. 用 `skipped_referenced_by` 定位**该先跑哪个模块**：哪个桶非 0 就去看那个域有没有清理器 —— 这比只看总数能省一轮排查。
   `media` 读数偏小 + 某个桶长期非 0 = 顺序问题，不是函数 bug。

⛔ 不要用「把 `skipped_referenced` 从读数里去掉」或「把跳过改成照删」来消掉这个现象：前者让顺序问题彻底不可见，后者就是本片
返修前的那条悬空 uuid 缺陷。

## 语义裁定（指挥 D-9 + U-11，2026-10-24）

§9 第 ⑤ 条列出的语义空白，已由指挥 D-9 裁定、**U-11 把三态收敛成两态**，落成可执行口径（本片不实现运行时，只把口径钉在证据页）：

- `skipped_referenced > 0` **不等于**失败：被 §4③ 那 **11 列 / 8 类**引用面（`content_media_refs`、`community_media_grants`、
  `public_authors.avatar_media_id`、`users.avatar_media_id`、`ocr_jobs`、`ocr_records`、`recognition_jobs`、`recognition_records`、
  `speech_jobs`、`transcriptions`、`community_posts.media_ids`）中任一处引用的行本就该留原地。返修只扩了「引用面」的枚举，
  **没有**改这条语义。
- 未来运行时媒体模块的映射（唯一口径，**两态**，指挥 U-11 裁定；`partial` 已删除）：
  · `completed` —— 函数正常返回，**无论 `skipped_referenced` 是否为 0**。`> 0` 时**仍然** `completed`，但证据串里
    `media_skipped_referenced` 与 `;media_skipped_by:…` 必须如实写非零，且**不许在证据文案里说「已清干净」**
    （「被引用 ⇒ 留原地」是设计，不是失败）。
  · `blocked` + `HANDLER_FAILED` —— 函数抛 **`G0007`（未入队）/ `G0001`（NULL 主体）/ `42883`（down 之后函数不在岗）**
    **或 `23503`（外键拒绝）**。⛔ 不许折成 `completed`，也不许折成「0 行」。
    `23503` 今天碰不到（11 列里只有前 2 列有外键，且它们指向的行本来就会被 `NOT EXISTS` 排除），但**将来给第 3–11 列补外键
    就会走这里**：那时「先查后删」之间的并发插入会以 `23503` 整批回滚 —— 这是**安全失败**，必须映射成 `blocked`，不能吞。
  · 为什么**不能**用 `partial`：冻结协议里根本没有这个值 —— `packages/privacy/constants.mjs:80` 的
    `HANDLER_STATES = ['pending','running','completed','blocked']`、`0003:46` 的
    `deletion_state ENUM('requested','processing','blocked','completed')`，`git grep partial -- packages/privacy services/api/src/privacy`
    **0 命中**。写 `partial` 会落 `deletion.mjs` 的非法态分支 ⇒ `status='blocked'`、`errorCode='INVALID_HANDLER_RESULT'`、
    **`evidenceRef` 被置 null（证据串整条丢掉）**——正好是我们要避免的结果。⛔ 本片不扩 `HANDLER_STATES` / `deletion_state` /
    协调器聚合（跨包契约变更，另立片）。
  · `G0001` / `G0007` / `23503` 都不在 `SAFE_ERROR_CODES` 里 ⇒ 会**自动**折叠成 `HANDLER_FAILED`，运行时侧不需要为它们写分支。
- 证据串格式（**新旧对照，逐字**）：

  | | 证据串 |
  | --- | --- |
  | 上一版（旧） | `media_rows:<media>;media_derived:<derivatives>;media_skipped_referenced:<n>` |
  | 本版（新） | `media_rows:<media>;media_derived:<derivatives>;media_skipped_referenced:<n>;media_skipped_by:content=<n>,grants=<n>,avatar=<n>,user_avatar=<n>,ocr=<n>,recognition=<n>,speech=<n>,community=<n>` |

  兼容性：三个 `media_*` 基础字段**逐字未变且保持前缀顺序**，新增字段一律追加在末尾，分隔符沿用 `;`（外层）/ `,`（桶内），
  桶内用 `=` 而不是 `:`，避免外层「按第一个 `:` 切」的解析器把桶名当字段名。旧解析器读到新串只是多一个不认识的字段；
  `skipped_referenced` 的**语义与取值口径都没变**（`completed` 的判定因此不变）。桶计数的口径见 §3 的表格
  （**互不排斥**，`sum(桶) ≥ skipped_referenced`）——证据串里**不许**用桶和替代 `media_skipped_referenced`。
- 运行时接线**不阻塞本片**：本片交付的是「有唯一可调用的删除入口 + 授权面 + 形状与真库臂」；
  接线单独立片，开工前提是本片与 0034 都已进 main，且**接线时必须遵守 §10 的顺序前提**。

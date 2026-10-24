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
| `tests/unit/r34-media-row-purge-migration.test.mjs` | 新增：迁移/回滚/授权面静态形状测试（15 条负控制） |
| `tests/unit/least-privilege-expected-parity.test.mjs` | 扩写：`media` 进「禁止 DELETE」清单 + 新增第 6 个成对测试 |
| `tests/integration/media-row-purge-pg.mjs` | 新增：真库臂（缺 `GY_PG_BIN` 显式 77 退出，见 §8） |
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

- 三件套齐；函数体内业务对象全部 `public.` 限定（`public.media` / `public.media_derivatives` / `public.media_object_cleanup` /
  `public.content_media_refs` / `public.community_media_grants` / `public.public_authors`）。
- 结尾 `REVOKE ALL ON FUNCTION public.purge_owner_media(uuid) FROM PUBLIC;` ⇒ 默认 PUBLIC EXECUTE 被收回，授权面只剩段 D4 一条。
- 参数域：`p_owner IS NULL` ⇒ `RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST'`（与 0016/0017/0031/0034
  同码同义：NULL 主体是调用错误，不是「没有目标」）。
- 返回读数键（`jsonb`，4 个）：`media`＝本次物理删除的媒体行数；`derivatives`＝随之删掉的派生行数（显式先删，不从级联里藏）；
  `queued`＝目标集里已入队的清理意图行数；`skipped_referenced`＝终态但被引用、因此刻意留原地的行数。
## 4. 三条硬条件怎么落的

- **① 入队先于删行**：先对目标集逐行比对「仍存活的对象引用数」与「台账行数」，只要有目标「活引用 > 台账行」，就
  `RAISE EXCEPTION USING ERRCODE = 'G0007', MESSAGE = 'MEDIA_CLEANUP_NOT_QUEUED'` —— 异常在**任何 DELETE 之前**抛出，整批不删。
  「已清空」的判据是密文列的空信封（`v1.<iv 16>.<tag 22>.` 以 `.` 收尾）；**认不出来的形状一律按「仍持有对象」处理**（fail-closed）。
  边界如实写：这是**计数式**前置，不是摘要级比对 —— SQL 侧没有 HMAC 密钥，无法把意图行与具体对象键对上，所以它证明的是
  「没有未入队的活引用」，而非「每条意图都恰好对应一个活引用」。
- **② 只删终态**：`m.state IN ('rejected', 'deleted')`。`initiated/uploaded/processing/ready/deleting` 一律不碰
  （`deleting` 是状态机中间态，桶删除未确认 ⇒ 该行留到清理器确认之后）。
- **③ 不越过引用**：目标集带三个 `NOT EXISTS` —— `public.content_media_refs`、`public.community_media_grants`、
  `public.public_authors.avatar_media_id`（第三处**无外键**，数据库不会替我们挡，必须显式判）。被引用的终态行留原地并计入
  `skipped_referenced`；同一组三谓词在「跳过计数」里**逐字同形**再写一遍（少写一处 ⇒ 少报 ⇒ 一个「看起来删干净了」的假读数）。
- **子先父后**：先删 `public.media_derivatives`，再删 `public.media`，两个 `GET DIAGNOSTICS ROW_COUNT` 分开报。
- **并发是 fail-closed，不是缺口**：目标集先查后删，若此刻另一事务新插一条引用，第二条 DELETE 会撞外键 `23503` 并让整批
  （含已删的派生行）回滚 —— 安全失败，⛔ 不要吞异常把它变成绿。
## 5. 与 0034 的分工

`0034` 是两个**业务表行**窄函数（`purge_owner_recognitions` / `purge_owner_speech`），清识别/语音域的记录与幂等台账；`0035`
只清**媒体实体行**。两者共用同一套形态（三件套、`G0001`、单事务、`jsonb` 读数、`REVOKE ALL`），但**不合并**：媒体域的删除时机、
引用面（三条，其中一条无外键）与失败码（`G0007`）都不同，合并会把媒体域的引用语义塞进业务表函数，让两类账混在一个读数里。
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
| `node tools/verify-migrations-unique.mjs --strict` | EXIT 0；`[gap] 0001..0035 连续`；`[rollback] 已配对 34 / 允许缺省 1（0001）/ 缺回滚 0 / 孤儿 0` |
| `node --test tests/unit/migration-reservations.test.mjs` | 8 pass / 0 fail |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/sql-column-coverage.test.mjs` | 17 pass / 0 fail（本片不改 store SQL） |
| `node --test tests/unit/deploy-sql-gate-probe.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/least-privilege-expected-parity.test.mjs` | 6 pass / 0 fail |
| `node --test tests/unit/roles-file-disposition.test.mjs` | 11 pass / 0 fail |
| `node --test tests/unit/r34-media-row-purge-migration.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/doc-anchors-guard.test.mjs` | 10 pass / 0 fail |
| `node tools/verify-doc-anchors.mjs --strict` | EXIT 0；基线 103 条、命中 103、**基线外新增 0 / 陈旧 0** |
| `node tools/verify-contract-status.mjs` | EXIT 0；114 条契约操作、形状错误 0、语义错误 0 |
| `node --check`（4 个改过的 `.mjs`） | 全部 EXIT 0 |
| `git diff --check` | EXIT 0 |
| `git merge-tree --write-tree upstream/main HEAD` | EXIT 0，无冲突 |

⚠ 本树**没有 `node_modules`**（依赖靠 CI）：`migrations-constraint.test.mjs`（PGlite 臂）等需要依赖的用例本机跑不了 ——
这也是我把 0035 的形状测试写成**纯静态**的原因：不让「依赖缺失 ⇒ 静默跳过」变成假绿。
## 8. 未取得项（⛔ 都不是通过）

1. **真库未跑**：`tests/integration/media-row-purge-pg.mjs` 已写好，但本机无 PG 二进制、且本片明令不起 PostgreSQL ⇒ 它没有被
   真库验证过。缺 `GY_PG_BIN` 时打印 3 行 SKIP 并 **exit 77**（未取得，不是通过；不认 `--allow-skip`）；它也**未**接进
   `.github/workflows/real-pg-integration.yml`（`.github/**` 不在本片授权范围）。
2. **桶对象回收仍归 `cleanupOrphans`**：本片只删数据库行，`media_object_cleanup` 台账行**刻意保留**（0029 故意不建外键）——
   字节回收不在本片范围内，台账行留下来正是为了让清理器还能枚举到它们。
3. **运行时接线未做**（理由见 §9）：`services/api/src/privacy/user-data-deletion.ts` 目前**还没有**媒体模块，函数的唯一调用方还不存在。
4. 0035 的 `up` 在真实 PG 17.11 上的行为、以及 `G0007` / `G0001` 的 SQLSTATE 传播，都只在静态测试里被断言过形状。
## 9. 为什么本片不接线（留作下一片）

要做「media 模块」至少牵动五处，且第 ⑤ 条需要产品裁定，不是写手能单方面定的：

1. `services/api/src/media/store.ts` 的 `MediaStore` 接口**新增** `purgeOwnerData`（该接口目前没有任何 purge 原语），连带改
   `createMemoryMediaStore` 与 `createPostgresMediaStore`；
2. `user-data-deletion.ts` 新增 `MEDIA_DELETION_MODULE` 常量、进 `CONDITIONAL_DELETION_MODULES` 与 `ONLINE_EVIDENCE_MODULES`、
   `requiredModules.push` 与 `coordinator.registerModule`；
3. `services/api/src/app.ts` 的注销装配区注入 port（至少一行 import + 一处构造）；
4. `tests/unit/deletion-registration-coverage.test.mjs` 的三处硬编码清单（`['community','recognitions','speech']` → 四域、
   `effective.length === 7` → 8、`MODULE_TABLE_COVERAGE` / `DECLARED_UNREGISTERED` 的 `media` 处置）；
5. **语义裁定**：`skipped_referenced > 0` 意味着「被引用的行刻意留在原地」。映射成 `blocked` 会让所有「有社区引用媒体」的注销
   常态 blocked；映射成 `completed` 则是谎称清完。这是删除协议的对外语义，必须先定，再写代码。

本片只交付「函数 + 授权面 + 清单 + 测试」这一层：可编译、可回滚、可单独上线，且不给后续接线留需要返工的形状。

边界：⛔ 本片不 `DROP TABLE`（`public.jobs` 的 DROP 另立一片）；⛔ 不动探针 / `expected_42501` / `deploy-sql-gate.yml`；⛔ 不放宽任何断言；⛔ 不把新锚点写进 `tools/doc-anchors-baseline.json`。

## 语义裁定（指挥 D-9，2026-10-24）

§9 第 ⑤ 条列出的语义空白，已由指挥 D-9 裁定，落成可执行口径（本片不实现运行时，只把口径钉在证据页）：

- `skipped_referenced > 0` **不等于**失败：被 `content_media_refs` / `community_media_grants` /
  `public_authors.avatar_media_id` 引用的行本就该留原地。
- 未来运行时媒体模块的映射（唯一口径）：`completed` 仅当函数正常返回且 `skipped_referenced === 0`；
  `skipped_referenced > 0` ⇒ `partial`，证据串追加
  `media_rows:<media>;media_derived:<derivatives>;media_skipped_referenced:<n>`；
  函数抛 `G0007` / `G0001` / `42883`（down 之后）⇒ `blocked` + `HANDLER_FAILED`，⛔ 不许折成 `completed` 或 `0 行`。
- 运行时接线**不阻塞本片**：本片交付的是「有唯一可调用的删除入口 + 授权面 + 形状与真库臂」；
  接线单独立片，开工前提是本片与 0034 都已进 main。

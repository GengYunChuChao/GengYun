/**
 * 结构门禁：`package.json` 的 `test:integration:http` 集成链。
 *
 * 为什么需要它（实测过的两处证据）：
 *  1. 该脚本是**扁平 `&&` 链**：`node A && node B && ...`。从链里**删掉任意一条**，
 *     剩下的命令照样全部退出 0 ⇒ 整条 `npm run test:integration:http` 仍然绿，
 *     门禁被静默削弱而 CI 不会红。
 *  2. `docs/architecture/contract-status.json` 等文档把 `tests/integration/*.mjs`
 *     当作"证据"引用，但没有任何校验器解析这些引用 ⇒ 引用腐烂也不红。
 *
 * 本文件是**纯静态**检查：只读仓库内的 `package.json` 与 `tests/integration/` 目录。
 * ⛔ 不起服务、不连 PG、不联网、不写任何文件、不新增依赖。
 *
 * 判据（六条，与派单 §1 逐条对应）：
 *  1) 引用存在性：链里每个 `node <path>` 的 `<path>` 必须真实存在于仓库内。
 *  2) 无重复：同一路径不得在链里出现两次。
 *  3) 已接线集合 ⊇ 冻结清单：冻结清单里的 8 条必须始终在链里（删任何一条即红）；
 *     **允许新增**（在途片往链里加条不会被打红，见下方"刻意的兼容性设计"）。
 *  4) 未接线必须显式声明：`tests/integration/*.mjs` 中不在链里的文件必须出现在
 *     下方 `UNWIRED_DECLARATIONS` 白名单里，并写明原因；既不接线也不声明 ⇒ 红。
 *  5) 白名单不得腐烂：白名单条目若**已不存在**或**其实已在链里** ⇒ 红。
 *  6) 解析口径：解析 `package.json` 的**真值**（`JSON.parse` ＋ 按 `&&` 切分），
 *     ⛔ 不在测试里硬编码"链条字符串"自比（那是同义反复）；仓库根由
 *     `import.meta.url` 推出，⛔ 不依赖 `process.cwd()`。
 *
 * 刻意的兼容性设计（`⊇` 而非 `==`）：断言 3 只要求"链 ⊇ 冻结清单"，
 * 不要求"链 == 冻结清单"。这样在途分支往链里**新增**一条回环脚本时，本门禁仍然绿；
 * 但新增的脚本会立刻受到断言 1／2／4 的约束（路径必须存在、不得重复、
 * 若未接线则必须进白名单），不会变成新的静默缺口。反向的代价（漏接检测）由断言 4 兜住。
 *
 * 已知边界（本片不改，见交接 §6）：断言 1 只校验链里 `node <path>` 的**路径存在性**，
 * 不校验"该脚本真的能跑通"；断言 4 只覆盖 `tests/integration/*.mjs`，
 * 不覆盖同目录的 `.cjs` / `.ps1` 辅助脚本（它们本来就不属于这条链的候选集）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 process.cwd()。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json');
const INTEGRATION_DIR = 'tests/integration';
const INTEGRATION_DIR_ABS = join(REPO_ROOT, INTEGRATION_DIR);
const SCRIPT_NAME = 'test:integration:http';

/**
 * 冻结清单：必须**始终**留在 `test:integration:http` 链里的 8 条（顺序即当前链序）。
 * 第 8 条 `ocr-http.mjs` 是 `#216` 并入的。删除其中任意一条 ⇒ 断言 3 红。
 */
const FROZEN_CHAIN = Object.freeze([
  'tests/integration/knowledge-consumer-http.mjs',
  'tests/integration/miniprogram-login-loop.mjs',
  'tests/integration/admin-http.mjs',
  'tests/integration/profile-ui-http.test.mjs',
  'tests/integration/recognitions-http.mjs',
  'tests/integration/jobs-http.mjs',
  'tests/integration/favorites-history-isolation-http.mjs',
  'tests/integration/ocr-http.mjs',
]);

/**
 * 未接线白名单：`tests/integration/*.mjs` 中**不在**链里的文件，必须在此逐条声明并写明原因。
 * 未声明的未接线脚本 ⇒ 断言 4 红；白名单条目已不存在或其实已接线 ⇒ 断言 5 红。
 */
const UNWIRED_DECLARATIONS = Object.freeze([
  {
    path: 'tests/integration/account-deletion-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（同一 `run:` 行先 `CREATE DATABASE gengyun_deletion_test`，再把该库 owner URL 作 argv[2]）；'
      + '该臂证注销受理的持久化与同事务内撤销。'
      + '该 job 用 `postgres:17.11` service，失败即整 job 红；'
      + '判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/third-party-deletion-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（同一 `run:` 行先 `CREATE DATABASE gengyun_third_party_deletion_test`，再把该库 owner URL 作 argv[2]）。'
      + '该臂只碰库、不装配 HTTP：两条 `SECURITY DEFINER` 函数 + 运行时 EXECUTE + 最小权限断言；'
      + '硬钉 hostname=127.0.0.1 与 pathname=/gengyun_third_party_deletion_test，'
      + '口令 `randomBytes(24)` 生成并写进它自己用的运行时 URL（scram 下自洽）'
      + '，D5 授权区从出厂 `deploy/postgres-cvm/sql/20-login-roles.sql` 原样抽取执行'
      + '（不复制 SQL：授权被删或被改宽就变红），收尾按 `pg_roles` 快照差集 DROP 并复核为空；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/account-suspend-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（同一 `run:` 行先 `CREATE DATABASE gengyun_suspend_test`，只给 owner URL 作 argv[2]）。'
      + '该臂证账号停用／恢复接真实认证权威：要求空库，自己 apply 0001–0017 后把 0017 单独跑 UP/ROLLBACK/REPLAY 三连；'
      + 'argv[3]（运行时角色 URL）可省略——省略时脚本自己生成口令、建／改同一个角色，给了 argv[3] 就取 URL 里的口令去建／改'
      + '（旧版把 `CREATE ROLE … PASSWORD` 与 argv[3] 的口令割裂 ⇒ scram 下必 28P01，本版两种形态在 scram-sha-256 上都自洽）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/admin-accounts-read-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_admin_accounts_read_test`，再传 **两个** URL：owner + `gengyun_api_runtime` 运行时）；'
      + '运行时角色的 `CREATE ROLE` 口令取自 argv[3] 的 URL（省略 argv[3] 时脚本自己生成口令建／改同一角色），scram 下自洽；'
      + '判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/admin-audit-logs-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「审计读面'
      + '（#34 / 迁移 0033 的 list_admin_audit_logs / 键集 / 筛选 / 脱敏 / 权限形状）'
      + '」跑 `node tests/integration/admin-audit-logs-pg.mjs`。'
      + '它是**自起集群**族：step 给 `GY_PG_BIN`（装包 step 装出的 `/usr/lib/postgresql/17/bin`）'
      + '与 `GY_R34_PG_ROOT`（数据根），⛔ 本 step 不 `CREATE DATABASE`；'
      + '脚本自己 `initdb` 起一次性集群（端口在 55436–55467 内先探活再起、只监听 127.0.0.1）、'
      + '跑生产路径 `migrate.ts up` 到 0033，再钉 `public.list_admin_audit_logs()` 的读面：'
      + '参数绑定、键集 `(created_at, id)` 分页、同一毫秒不同微秒不漏行，以及运行时角色直读 `admin_audit_events` 仍恰好 42501（零新增授权）。'
      + '缺 `GY_PG_BIN` 时它打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过；'
      + '也不加任何吞红开关）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/admin-scopes-authority-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-admin-write-17-11` 的 step「授权写入面'
      + '（R67-C：admin-scopes-authority-pg / 自起集群 / 授撤 + 委派 + 审计）'
      + '」跑 `node tests/integration/admin-scopes-authority-pg.mjs`'
      + '（`2>&1 | tee` 后按 `rc` 判红，紧随的判断把 exit 77 升级成硬失败并打 `::error::`）。'
      + '自起集群族：`GY_PG_BIN` + `GY_R37_PG_ROOT`；'
      + '脚本 `initdb` 后以 `postgres -D … -p … -h 127.0.0.1` 前台起一次性集群（端口在 55600–55639 里先探活再起），'
      + '按生产顺序跑 `migrate.ts up` ⇒ `roles/*.sql` ⇒ `20-login-roles.sql` ⇒ `90-assert-least-privilege.sql`'
      + '（末行必须 ok、新增断言 103/104 必须为真），'
      + '最后以 `gengyun_api_runtime` 身份直调迁移 0041 的 `grant_admin_scope` / `revoke_admin_scope`：'
      + '正常授予与撤销、幂等（不写第二条审计、不 bump revision）'
      + '、自授与「授予自己未持有的 scope」被拒、目标停用被拒、版本冲突、撤销后复活（重置 granted_at）、最后授权者守卫（含停用账号不计入）、审计撞主键整笔回滚（零写入）、闭集外取值由库层 CHECK 拒绝（23514）。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过；'
      + '也不加任何吞红开关）。'
      + '它**会写库**，因此归 admin-write 那个 job 而不是只读 job；'
      + '`ci-real-pg-wiring.test.mjs` 的 `MANAGED_SCRIPTS` 与其冻结清单里已登记；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/admin-scopes-read-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-admin-read-17-11` 的 step「授权范围读面'
      + '（R67-C：admin-scopes-read-pg / 自起集群 / 只读）'
      + '」跑 `node tests/integration/admin-scopes-read-pg.mjs`'
      + '（`2>&1 | tee "$log" || rc=$?` 形态，exit 77 由紧随的判断升级成硬失败并打 `::error::`）。'
      + '自起集群族：`GY_PG_BIN`（该 job 第一步先装 PG 17 服务端二进制）+ `GY_R37_PG_ROOT`，'
      + '⛔ 本 step 不 `CREATE DATABASE`（守卫按「自起集群 step 出现 CREATE DATABASE」判红）；'
      + '脚本 `initdb` 起只监听 127.0.0.1 的一次性集群（端口在 55468–55499 里先探活再起），'
      + '再按生产顺序跑 `migrate.ts up` 与 `roles/*.sql`、`20-login-roles.sql`、'
      + '`90-assert-least-privilege.sql` 落授权，最后以运行时角色钉读面：'
      + '`GET /admin/administrators` 与 `GET /admin/administrators/{id}/scopes` 的列表、'
      + '筛选、分页，以及「无权限即 42501」的形状。'
      + '为什么要独立 job 而不是塞进 real-pg-17-11：它只读，但需要 `initdb`/`pg_ctl`，与 service 形态的三十多条臂不是同一套依赖。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过；'
      + '也不加任何吞红开关）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/admin-community-posts-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「后台社区帖域'
      + '（#18 / 列表·单条读面 / 下架处置 / 审计留痕 / 失败隔离）」'
      + '跑 `node tests/integration/admin-community-posts-pg.mjs <owner URL>`'
      + '（该 step 先 `CREATE DATABASE gengyun_admin_community_posts_test`，'
      + '`2>&1 | tee "$log"` 后按 `rc` 判红）。'
      + '该 job 用 `postgres:17.11` service、'
      + '不是自起集群，所以不需要 `GY_PG_BIN`；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接）'
      + '，真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/admin-post-hide-audit-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「后台社区帖域 · 下架审计'
      + '（#18 / post.hide 审计函数专证 / fail-closed / 幂等）」'
      + '跑 `node tests/integration/admin-post-hide-audit-pg.mjs <owner URL>`'
      + '（该 step 先 `CREATE DATABASE gengyun_admin_post_hide_audit_test`，'
      + '`2>&1 | tee "$log" || rc=$?` 后按 `rc` 判红）。'
      + '它专证 R64 的下架审计：下架一次写一条审计、'
      + '重放同一请求不写第二条（幂等）、审计写失败时整笔回滚'
      + '（fail-closed）、'
      + '运行时角色直写 `admin_audit_events` 仍 42501。'
      + '该 job 用 `postgres:17.11` service、'
      + '不是自起集群，所以既不需要 `GY_PG_BIN` 也不需要数据根键。'
      + '旧理由「需真实 PG，留作后续接线」'
      + '在这条上早就是假话——它已经在 CI 真跑，'
      + 'R67-D01 按接线事实改写；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接）'
      + '，真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/admin-jobs-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「作业台域'
      + '（#9 / 全链迁移 0001→0027 / 作业与错误可见 / 变更留痕 A→B / 最小权限）'
      + '」跑 `node tests/integration/admin-jobs-pg.mjs <owner URL>`'
      + '（先 `CREATE DATABASE gengyun_admin_jobs_test`）。'
      + '该臂证后台 AI 作业读面、取消、开关变更留痕与投稿开关真实生效，每条都给「改前真红」的判别力；'
      + '走全链迁移到 0027；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/admin-content-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-admin-write-17-11` 的 step「内容域持久化（R67-C：'
      + 'admin-content-pg / 自起集群 / 建表 + 造数 + 回滚）」'
      + '跑 `node tests/integration/admin-content-pg.mjs`'
      + '（`2>&1 | tee "$log" || rc=$?`，exit 77 升级成硬失败）。'
      + '自起集群族：`GY_PG_BIN` + **`GY_I18_PG_ROOT`**（源码唯一取值点，'
      + '⛔ 不是同族的 `GY_R34_PG_ROOT`／`GY_R37_PG_ROOT`）'
      + '，⛔ step 里不许出现 `CREATE DATABASE`：'
      + '库名 `gengyun_admin_content_pg_test` 由脚本在自己的临时集群里建。'
      + '读数形态是 `PASS n: label`（脚本自证 11 组）'
      + '：建表 → 造数 → 事务回滚后行数不变、失败不留半条。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/admin-flags-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（同一 `run:` 行先 `CREATE DATABASE gengyun_flags_test`，再传该库 owner URL）；'
      + '该臂钉 `0020_feature_flags.sql` 的持久化面。'
      + '该 job 用 `postgres:17.11` service；'
      + '判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/auth-privacy-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/auth-privacy-postgres.yml#auth-privacy-pg` 的无名 step 直接 `node` 它（该 job 自带 `postgres:17.11` service，owner 装库、API 用独立限权 LOGIN）；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/backup-purge-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「备份副本域'
      + '（迁移 0023 / 受理同事务 / 30 天清除）」跑 `node tests/integration/backup-purge-pg.mjs`。'
      + '自起集群族：`GY_PG_BIN` + `GY_I19_PG_ROOT`，⛔ 本 step 不 `CREATE DATABASE`（库名硬钉在脚本自己起的临时集群里）；'
      + '它钉 0023 的受理同事务与 30 天清除。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/backup-copies-purge-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「备份副本到期清除驱动'
      + '（迁移 0023 / 到期枚举 / 逐组清除 / 失败重排 / CLI 幂等）」'
      + '跑 `node tests/integration/backup-copies-purge-pg.mjs`。'
      + '自起集群族：`GY_PG_BIN` + `GY_I19_PG_ROOT`，'
      + '⛔ 不 `CREATE DATABASE`；'
      + '它自证 14 条（权限形状／到期边界／批量上限／失败留痕与重排／幂等重跑／CLI 退出码）。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过，也不加任何吞红开关）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/catalog-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/catalog-postgres.yml#catalog-pg` 的无名 step 直接 `node` 它（该 job 自带 `postgres:17.11` service；夹具与凭据全是合成的，未审种子另行单独测）；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/community-filter-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（同一 `run:` 行先 `CREATE DATABASE gengyun_community_filter_test` 再 `node tests/integration/community-filter-pg.mjs`，不带 argv）；'
      + '该臂钉社区域列表筛选下推与分页确定性，并登记举报状态推进通道的残留缺口。'
      + '该 job 用 `postgres:17.11` service、'
      + '不是自起集群，不需要 `GY_PG_BIN`；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/qa-citations-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「问答引用可溯源'
      + '（#12 / 迁移子集 7 段 / 引用反算对账 / 零命中必拒答）」'
      + '跑 `node tests/integration/qa-citations-pg.mjs`'
      + '（先 `CREATE DATABASE gengyun_qa_citations_test`，带 `2>&1 | tee "$log" || rc=$?`）。'
      + '⛔ 它跑的是迁移子集 7 段（0001/0002/0005/0008/0010/0012/0013），不是全链；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/community-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_community_test` 再 `node tests/integration/community-pg.mjs`，不带 argv）；'
      + '该臂钉社区域 PG 持久化；'
      + '判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/consent-grant-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/consent-grant-postgres.yml#consent-grant-pg` 的无名 step 直接 `node` 它（该 job 自带 `postgres:17.11` service；策略与收件人全为合成值，不调供应商）；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/conversations-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（同一 `run:` 行先 `CREATE DATABASE gengyun_conversations_test` 再 `node tests/integration/conversations-pg.mjs`，'
      + '**不带** argv）；'
      + '该臂钉会话链的 PG 持久化（迁移 0001/0002/0005/0008/0010/0012/0013）。'
      + '该 job 用 `postgres:17.11` service；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/egress-ledger-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/consent-grant-postgres.yml#consent-grant-pg` 的无名 step 真跑它（同一 `run:` 行先 `CREATE DATABASE gengyun_egress_test`）；该臂钉外发账本的端到端；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/egress-object-key-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/consent-grant-postgres.yml#consent-grant-pg` 的无名 step 以 `W116_PSQL="$(command -v psql)" node tests/integration/egress-object-key-pg.mjs` 真跑它：本 step 不起库也不建库，它跑在同一 job 前一步已建好的库上；'
      + '判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/egress-revoke-race-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/consent-grant-postgres.yml#consent-grant-pg` 的无名 step 真跑它（同一 `run:` 行先 `CREATE DATABASE gengyun_egress_revoke_race_test`，再 `node tests/integration/egress-revoke-race-pg.mjs`）；'
      + '该臂钉在途—撤回／注销—回写的竞态守卫与回写诚实性；'
      + '判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/favorites-history-isolation-http.reverse-control.mjs',
    reason: '非门禁入口：**反向控制运行器**，由 `tests/integration/favorites-history-isolation-http.mjs` 的 `reverse-control` 注释指向，用法是在 worktree 根手动 `node tests/integration/favorites-history-isolation-http.reverse-control.mjs`——把会话 B 换成 A 后期望隔离断言变红（证明原断言不空），原文件 blob 不变；⛔ 接进任何链都会让整链变红，故不是漏接线。'
  },
  {
    path: 'tests/integration/favorites-history-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它（先 `CREATE DATABASE gengyun_favorites_history_test` 再 `node tests/integration/favorites-history-pg.mjs`）；该臂只在显式回环库上破坏性写入；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/knowledge-native-consumer.mjs',
    reason: '非门禁入口：**三参驱动**的原生侧消费者，不是自证读数的臂——用法见 `docs/verification/gy-i07-native-business-consumer-20261011.md` 的 `node <证据目录>/tests/integration/knowledge-native-consumer.mjs <组合目录> <新 runtime 目录> <脱敏输出目录>`，缺任一目录即退出；它要隔离的原生 PG 与外部组合目录，⛔ 不是漏接线。'
  },
  {
    path: 'tests/integration/local-knowledge-smoke.mjs',
    reason: '非门禁入口：取 `argv[2]` 当**窗口目录**的冒烟脚本，用法 `node tests/integration/local-knowledge-smoke.mjs .local/local-dev`（需先跑 `tools/local-dev` 生成该被忽略目录）；证据页 `docs/verification/local-knowledge-native-20261011.md` 记了整串 prepare→start→smoke 编排，仓里没有 npm 脚本编排它，⛔ 不是漏接线。'
  },
  {
    path: 'tests/integration/media-persistence-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_media_test`，'
      + '再 `node tests/integration/media-persistence-pg.mjs <owner URL>`）；'
      + '该臂证媒体三个事实源真落库、重启可读、装配 fail-closed。'
      + '⛔ 本地 `npm run test:integration:media-persistence-pg` 那条还带 `--experimental-strip-types`，与 CI 的直跑不是同一条命令。'
      + '该 job 用 `postgres:17.11` service；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/media-concurrency-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_media_concurrency_test`，'
      + '再 `node tests/integration/media-concurrency-pg.mjs <owner URL>`）。'
      + '它是 `media-persistence-pg` 的合流补测，只补并发面三个读数：'
      + '同一媒体对象两次并发 complete（不同 scope 判定）、并发删除与在途写、幂等键并发重放。'
      + '该 job 用 `postgres:17.11` service、'
      + '不是自起集群，不需要 `GY_PG_BIN`；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接）'
      + '，真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/media-row-purge-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-admin-write-17-11` 的 step「媒体行清除驱动'
      + '（R67-C3：media-row-purge-pg / 自起集群 / 迁移号按保留台账口径）'
      + '」跑 `node tests/integration/media-row-purge-pg.mjs`'
      + '（`2>&1 | tee "$log" || rc=$?`，'
      + 'exit 77 升级成硬失败并打 `::error::`）。'
      + '它钉 `public.purge_owner_media(uuid)` 的真库语义：'
      + '0035 的四谓词（本人 + 终态 + 未被任何一处引用面指向 + 已入队）'
      + '与「`public.media` 对运行时零表级 DELETE」这两件事，静态测试只能证明 SQL 文本长这样，'
      + '证明不了 PG 真跑起来会这样——所以它自己 `initdb` 出一次性集群、跑全链迁移、把整条链真跑一遍。'
      + '自起集群族：`GY_PG_BIN` + **`GY_R34_PG_ROOT`**'
      + '（源码取值点 `process.env.GY_R34_PG_ROOT ?? tmpdir()`；'
      + '⛔ 不是 `GY_I19_PG_ROOT`／`GY_W11_PG_ROOT`／`GY_I18_PG_ROOT`）'
      + '，并且 ⛔ 本 step 不建库：库在脚本自己的临时集群里。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**'
      + '（未取得，⛔ 不是通过，也不加任何吞红开关）。'
      + 'R67-C3 已把它接进这个 job，'
      + '`ci-real-pg-wiring.test.mjs` 的五张清单同位置登记；'
      + '旧理由「本片未接进 workflow」是过期假话，R67-D01 按接线事实改写；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/messages-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它（先 `CREATE DATABASE gengyun_messages_test`，再传该库 owner URL）；该臂钉 0019 的并发、分页与归属；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    // R34（#17「社区事件 → 消息域」）：**紧挨着 `messages-pg`** 登记（同一条「消息域落库」链的两面：
    // 消息域自己写 vs 经社区事件投递进来）；⛔ 不要追加到清单末尾，那里紧邻 admin 域条目。
    path: 'tests/integration/message-events-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_message_events_test`，'
      + '再 `node tests/integration/message-events-pg.mjs <owner URL>`）；'
      + '该臂钉「社区事件 → 消息域」的投递与恢复，补的是社区事件端口与消息域之间那条真库缺口。'
      + '该 job 用 `postgres:17.11` service；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/messages-purge-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「消息域注销行数'
      + '（#17 / 迁移 0019 messages + 0008 idempotency_keys）」'
      + '跑 `node tests/integration/messages-purge-pg.mjs`。'
      + '自起集群族：`GY_PG_BIN` + `GY_W11_PG_ROOT`（⚠️ 数据根键与同 job 的 `GY_I19_PG_ROOT`／`GY_R34_PG_ROOT` 不同，'
      + '抄错键只会多一条装饰性 env），⛔ 不 `CREATE DATABASE`；'
      + '它自证 8 条（授权形状／消息与台账行数／他人零影响／负控制／幂等重放／回执）。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/migrations-negative-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/auth-privacy-postgres.yml#auth-privacy-pg` 的无名 step 直接 `node` 它；'
      + '三臂逐臂可读：A 半截失败 ⇒ 非 0 退出且同次已执行 DDL 全回滚、台账不留行；B 重放（对已迁移的库再跑同一批 ⇒ 台账幂等跳过、绝不重放语句）；'
      + 'C 回滚（0016 先 up 再跑 migrations/rollback/0016_*.down.sql ⇒ up 前不存在的对象在 down 后消失）；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/moderation-ledger-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_moderation_test`，'
      + '再 `node tests/integration/moderation-ledger-pg.mjs <owner URL>`）；'
      + '该臂钉 0028 审核判定台账的落库与读取。'
      + '该 job 用 `postgres:17.11` service；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/moderation-full-chain-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-admin-write-17-11` 的 step「审核全链（R67-C：'
      + 'moderation-full-chain-pg / 自起集群 / 建帖→编辑→审核→下架）」'
      + '跑 `node tests/integration/moderation-full-chain-pg.mjs`'
      + '（`2>&1 | tee "$log" || rc=$?`，exit 77 升级成硬失败）。'
      + '自起集群族：`GY_PG_BIN` + `GY_I14C_PG_ROOT`，⛔ 不 `CREATE DATABASE`；'
      + '它证版本重审、失败隔离与下架缓存失效的整线联调，会写库；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/ocr-corrections-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「OCR 校正台账域'
      + '（#10 / jsonb 台账 append-only / 原文零改写 / HTTP 五字段）'
      + '」跑 `node tests/integration/ocr-corrections-pg.mjs`（先 `CREATE DATABASE gengyun_ocr_corrections_test`，带 `2>&1 | tee "$log" || rc=$?`）。'
      + '它只主张四件事，且每件都在真 PG 上取证：内存 store 证不了 jsonb 往返与重启后仍在；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/ocr-jobs-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_ocr_jobs_test` 再 `node tests/integration/ocr-jobs-pg.mjs`，不带 argv）；'
      + '该臂只讲一件事：OCR 任务与记录真落库，关掉连接重开还在（迁移 0024）；'
      + '判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/profile-ui-fixture.mjs',
    reason: '非门禁入口：**被 import 的夹具模块**（导出 `createProfileFixture`），由 `tests/integration/profile-ui-http.test.mjs` 用 `import` 语句从 `./profile-ui-fixture.mjs` 取 `createProfileFixture` 后调用；它自己不是可执行的门禁臂（直接 `node` 它只导出、不跑断言），在 npm 链里的是调用它的那个 `profile-ui-http.test.mjs`，⛔ 不是漏接线。'
  },
  {
    path: 'tests/integration/recognition-chain-e2e.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「识别端到端链路'
      + '（上传→结果→历史→删除→读空）」'
      + '跑 `node tests/integration/recognition-chain-e2e.mjs || rc=$?`'
      + '（该 step 先 `CREATE DATABASE gengyun_recognition_chain_test`）。'
      + '它走本机回环真 HTTP + fetch，把上传识别、拿结果、看可信度与理由、加入识别历史、读回、删除、再读为空串成一条链；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/recognitions-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_recognitions_test` 再 `node tests/integration/recognitions-pg.mjs`）；'
      + '该臂钉识别域真库裁决：假池能钉住发了哪条 SQL，钉不住数据库真的这样裁决；'
      + '判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/recognitions-speech-purge-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-admin-write-17-11` 的 step「识别与语音域清理（R67-C：'
      + 'recognitions-speech-purge-pg / 自起集群 / 真删 + 幂等）」'
      + '跑 `node tests/integration/recognitions-speech-purge-pg.mjs`（`2>&1 | tee "$log" || rc=$?`）。'
      + '自起集群族：`GY_PG_BIN` + `GY_R34_PG_ROOT`，⛔ 不 `CREATE DATABASE`；'
      + '它全是真删，因此归 write job；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    // GY-I19（#19 片B-演练）：加速时钟演练——把时间推到第 7/30 日边界，在 stub（纯逻辑，不碰 PG）与
    // PG（一次性临时集群）两层各证一遍「未到期不删／刚好到期删（闭区间）／到期删」。按路径序落在
    // `recognitions-speech-purge-pg` 与 `retention-purge-pg` 之间登记（同属 #19 的到期/保留族）。
    path: 'tests/integration/retention-clock-drill-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-admin-write-17-11` 的 step「保留期时钟演练（R67-C：'
      + 'retention-clock-drill-pg / 自起集群 / 7/30 日三态）」'
      + '跑 `node tests/integration/retention-clock-drill-pg.mjs`（`2>&1 | tee "$log" || rc=$?`）。'
      + '自起集群族：`GY_PG_BIN` + `GY_I19_PG_ROOT`，⛔ 不 `CREATE DATABASE`；'
      + '它是纯演练、无迁移，钉 7／30 日三态。'
      + '⛔ 该 step 不传「本机取 0」的放宽开关（守卫的 `FORBIDDEN_ESCAPE_HATCHES` 两条）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    // R34（#19 的**保留策略侧**，GY-R34-RETENTION）：按路径序落在 `recognitions-pg` 与 `source-lifecycle-pg`
    // 之间登记。它与 `messages-purge-pg`／`online-purge-pg` **同族**：自起临时集群、自建库、跑完即删。
    path: 'tests/integration/retention-purge-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「保留策略到期清理'
      + '（#19 保留策略侧 / 两张有出处的表 / 分批 500 / 幂等重跑 / 匿名化 revision+1）'
      + '」跑 `node tests/integration/retention-purge-pg.mjs`。'
      + '它是 `tools/purge-retention-expired.mjs` 的真库臂：数据根键是 **`GY_R34_PG_ROOT`**'
      + '（脚本 `:51` 的 `process.env.GY_R34_PG_ROOT ?? tmpdir()`），⛔ 不是 `GY_I19_PG_ROOT`／`GY_W11_PG_ROOT`；'
      + '守卫按脚本源码交叉核对（`SELF_CLUSTERED_ROOT_KEY`）。'
      + '端口可钉 `GY_PG_PORT`、只监听 127.0.0.1、自建 `gengyun_retention_purge_test`、'
      + '跑完 `pg_ctl stop`，⛔ 不 `CREATE DATABASE`；'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/source-lifecycle-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/source-lifecycle-postgres.yml#lifecycle-pg` 的无名 step 直接 `node` 它（该 job 自带 `postgres:17.11` service，起库与建库都在这个 job 里）；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/speech-pg.mjs',
    reason: '已接线（workflow）：'
      + '`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的无名 step 真跑它'
      + '（先 `CREATE DATABASE gengyun_speech_test` 再 `node tests/integration/speech-pg.mjs`，不带 argv）；'
      + '该臂只讲一件事：转写任务与转写记录真落库，关掉连接重开还在（迁移 0026）。'
      + '该 job 用 `postgres:17.11` service；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链），真库 job 不算接线 ⇒ 条目留在白名单。'
  },
  {
    path: 'tests/integration/staging-intake-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/staging-intake-postgres.yml#intake-pg` 的无名 step 直接 `node` 它（该 job 自带 `postgres:17.11` service）；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    path: 'tests/integration/user-chain-e2e.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「用户链路端到端'
      + '（登录→手选→搜索→详情→收藏/取消→来源失效→退出 / 142 条断言 / 7 步）」跑 `node tests/integration/user-chain-e2e.mjs`。'
      + '自起集群族：`GY_PG_BIN` + `GY_USER_CHAIN_PG_ROOT`（脚本 `:286` 的 `process.env.GY_USER_CHAIN_PG_ROOT`'
      + '（取不到时回落空串），⛔ 不是同族的其它根键），⛔ 不 `CREATE DATABASE`：夹具与全链迁移直接落在自己临时集群的 `postgres` 库里；'
      + '跑的是原样 API（`buildApp` 真装配，不 mock 路由）。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/online-purge-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「在线数据 7 日到期清除驱动'
      + '（#19 / 到期闭区间 / 跨进程游标 / 失败不阻塞 / 回执 backupState）」跑 `node tests/integration/online-purge-pg.mjs`。'
      + '自起集群族：`GY_PG_BIN` + `GY_I19_PG_ROOT`，⛔ 不 `CREATE DATABASE`；'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/workbook-staging-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/workbook-staging.yml#staging-pg17` 的无名 step 直接 `node` 它（该 job 自带 `postgres:17.11` service；破坏性检查只落在专用本地／CI 库，从不碰普通 DATABASE_URL）；判据 4 只认 npm 回环链，真库 job 不算接线 ⇒ 仍登记。'
  },
  {
    // ⚠ 位置**固定在清单末尾**：本文件的登记行被证据页按手写行号引用（`docs/verification/**` 里
    // 有 12 条 `…ci-integration-chain-structure.test.mjs:NN` 的手写锚点，其中 `:347` 必须仍落在
    // 实质行上，否则 `tests/unit/doc-anchors-guard.test.mjs` 判 SUSPECT 直接红）。插在字母序位置上
    // 会把后面每一条登记行整体下移、把这些锚点全部顶偏 ⇒ 新增条目一律追加在此，⛔ 不要插到中间。
    path: 'tests/integration/third-party-deletion-sql-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「第三方删除库层语义'
      + '（0044 / 闭集 G0001 / 终态 G0003 / 读面八列 / 运行时直写 42501）」跑 `node tests/integration/third-party-deletion-sql-pg.mjs`。'
      + '自起集群族：`GY_PG_BIN` + `GY_S4_PG_ROOT`（来源唯一取值点），⛔ 不 `CREATE DATABASE`：'
      + '它自己 `initdb` 出一次性 PG 17 集群 → 跑全链迁移 → 建一个只有 EXECUTE 的运行时角色，再钉库层函数语义与读面八列。'
      + '缺 `GY_PG_BIN` 时打印 SKIP 并 **exit 77**（未取得，⛔ 不是通过）；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/admin-posts-read-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-admin-read-17-11` 的 step「后台帖子读面'
      + '（R67-C：admin-posts-read-pg / 空库 + 五段迁移 + 读面读数）'
      + '」跑 `node tests/integration/admin-posts-read-pg.mjs`'
      + '（该 step 先 `CREATE DATABASE gengyun_admin_posts_read_test`，带 `2>&1 | tee "$log" || rc=$?`）。'
      + '它钉 `GET /admin/posts` 与 `GET /admin/posts/{id}` 的读面；'
      + '空库建起后只跑五段迁移，不跑全链；'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（无 PG 回环链：既没有真库、也没有能建角色的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/consent-zero-policy-pg.mjs',
    reason: '已接线（workflow）：`.github/workflows/real-pg-integration.yml#real-pg-17-11` 的 step「零政策矩阵'
      + '（R69：consent-zero-policy-pg / 全链迁移 / 生产装配零注入 / 403 矩阵 + 三级负控制）'
      + '」跑 `node tests/integration/consent-zero-policy-pg.mjs`'
      + '（该 step 先 `CREATE DATABASE gengyun_consent_zero_test`，带 `2>&1 | tee "$log"`，'
      + '并用 `awk` 数 `PASS ` 行、要求不少于 14 条读数闸门）。'
      + '它证的是 `consent_policies` **0 行**时每个入口的真实后果（侦察 `RECON.md` §7.1 那张矩阵的第一份真库读数）：'
      + '全链 48 个迁移后断言 0 行 → 生产装配零注入起真 HTTP → 12 条挂闸入口逐格 403 + 读面/撤回面 → '
      + '「闸在最外层」两条判据（逐表行数不变 + 报文无 `reason_codes`）→ 三级负控制。'
      + '判据 4 的 `wired` 只认 `package.json` 的 `test:integration:http` 链'
      + '（那条链无 PG：既没有真库、也没有能建角色/跑迁移的超管连接），真库 job 不算接线 ⇒ 条目必须留在白名单。'
  },
  {
    path: 'tests/integration/jobs-ledger-pg.mjs',
    reason: 'GY-R71（2026-10-30）新增的真库臂，**未接线**：`package.json` 的 `test:integration:http` 链'
      + '只跑本机回环 HTTP、没有 PG（既没有真库、也没有能跑迁移的超管连接），而本脚本要一个**空库**'
      + '（先断言 public 下 0 张表）再自己按 `discoverMigrations` 顺序跑完整 48 条迁移链。'
      + '它的门是自己那条 `JOBS_LEDGER_PG_TEST_URL`（缺它即 `SKIP` + 77），**刻意不用** `GY_PG_BIN`：'
      + '后者那一组脚本的条数被 `tests/unit/ai-ops-ledger-pins.test.mjs` 的钉子⑤冻结，本片不去动那份清单。'
      + '它证的是「台账与源表同一事务 / ON CONFLICT 冪等 / answer 源 / 取消」四件事（13 条 PASS 读数）。'
  },
]);

/** 读取并解析 `package.json` 真值。 */
function readPackageJson() {
  const text = readFileSync(PACKAGE_JSON_PATH, 'utf8');
  return JSON.parse(text);
}

/**
 * 从 `package.json` 真值取出 `test:integration:http` 并解析成条目列表。
 * 口径：按 `&&` 切分 ⇒ 每条 trim ⇒ 必须严格匹配 `node <相对路径>`（⛔ 不硬编码链条字符串）。
 */
function readChainEntries() {
  const scripts = readPackageJson().scripts ?? {};
  const raw = scripts[SCRIPT_NAME];
  assert.equal(
    typeof raw,
    'string',
    `package.json 的 scripts.${SCRIPT_NAME} 必须是字符串（缺失或被改成非字符串都视为门禁被削弱）`,
  );
  const rawEntries = raw.split('&&').map((part) => part.trim()).filter((part) => part.length > 0);
  assert.ok(rawEntries.length > 0, `scripts.${SCRIPT_NAME} 不得为空`);
  return rawEntries.map((entry) => {
    const match = /^node\s+(\S+)$/.exec(entry);
    assert.ok(
      match,
      `scripts.${SCRIPT_NAME} 的条目必须严格是 \`node <路径>\`（不得带 flag／重定向／子 shell）：${JSON.stringify(entry)}`,
    );
    return match[1];
  });
}

/** 枚举 `tests/integration/*.mjs` 全集（目录实读）。 */
function listIntegrationScripts() {
  return readdirSync(INTEGRATION_DIR_ABS, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => `${INTEGRATION_DIR}/${entry.name}`)
    .sort();
}

/** 链里出现的路径 → 出现次数（用于重复检测）。 */
function countOccurrences(paths) {
  const counts = new Map();
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  return counts;
}

/** 仓库内相对路径 ⇒ 是否真实存在（且留在仓库内、不是目录）。 */
function existsInRepo(relativePath) {
  const absolute = resolve(REPO_ROOT, relativePath);
  const inside = relative(REPO_ROOT, absolute);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return false;
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

test(`结构门禁：${SCRIPT_NAME} 链（删条／漏接／重复／坏引用／白名单腐烂都必须红）`, async (t) => {
  const entries = readChainEntries();
  const chainPaths = entries.slice();
  const integrationScripts = listIntegrationScripts();
  const counts = countOccurrences(chainPaths);
  const wired = new Set(chainPaths);

  await t.test('1 引用存在性：链里每个 node <path> 必须真实存在', () => {
    const missing = chainPaths.filter((path) => !existsInRepo(path));
    assert.deepEqual(
      missing,
      [],
      `链条目引用了不存在的文件（引用腐烂）：${missing.join('、')}`,
    );
  });

  await t.test('2 无重复：同一路径不得在链里出现两次', () => {
    const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([path]) => path);
    assert.deepEqual(
      duplicated,
      [],
      `链里出现重复条目（会重复跑同一个脚本，通常是删改时的手误）：${duplicated.join('、')}`,
    );
  });

  await t.test('3 已接线集合 ⊇ 冻结清单：删任何一条即红（允许新增）', () => {
    const missingFrozen = FROZEN_CHAIN.filter((path) => !wired.has(path));
    assert.deepEqual(
      missingFrozen,
      [],
      `冻结清单里的脚本已从 ${SCRIPT_NAME} 链中消失（静默删条）：${missingFrozen.join('、')}。`
        + '若确属有意下线，必须同时改本文件的 FROZEN_CHAIN 并说明理由，⛔ 不得只删 package.json。',
    );
  });

  await t.test('4 未接线必须显式声明：新脚本既不接线也不声明 ⇒ 红', () => {
    const declared = new Set(UNWIRED_DECLARATIONS.map((item) => item.path));
    const undeclared = integrationScripts.filter((path) => !wired.has(path) && !declared.has(path));
    assert.deepEqual(
      undeclared,
      [],
      `tests/integration 下有既未接线、也未在本文件 UNWIRED_DECLARATIONS 声明的脚本：${undeclared.join('、')}。`
        + `请二选一：接进 ${SCRIPT_NAME} 链，或在白名单里写明原因。`,
    );
  });

  await t.test('5 白名单不得腐烂：已不存在或其实已接线的条目 ⇒ 红', () => {
    const absent = UNWIRED_DECLARATIONS.map((item) => item.path)
      .filter((path) => !integrationScripts.includes(path));
    assert.deepEqual(
      absent,
      [],
      `白名单条目已不存在（文件被删／改名，白名单腐烂）：${absent.join('、')}`,
    );
    const alreadyWired = UNWIRED_DECLARATIONS.map((item) => item.path).filter((path) => wired.has(path));
    assert.deepEqual(
      alreadyWired,
      [],
      `白名单条目其实已在 ${SCRIPT_NAME} 链里（声明与事实不符，白名单腐烂）：${alreadyWired.join('、')}。`
        + '接线后必须从 UNWIRED_DECLARATIONS 移除该条。',
    );
    const reasonless = UNWIRED_DECLARATIONS
      .filter((item) => typeof item.reason !== 'string' || item.reason.trim().length < 8)
      .map((item) => item.path);
    assert.deepEqual(reasonless, [], `白名单条目必须写明原因（≥8 字符）：${reasonless.join('、')}`);
  });

  await t.test('6 解析口径：真值解析、条目格式、冻结清单自洽', () => {
    // 真值解析：链确实来自 package.json，且至少覆盖冻结清单（不是拿硬编码字符串自比）。
    assert.ok(chainPaths.length >= FROZEN_CHAIN.length, '链条数少于冻结清单，说明有删条');
    assert.deepEqual(
      entries.filter((path) => path.startsWith('/') || path.includes('..')),
      [],
      '链条目必须是仓库内相对路径（不得绝对路径或越出仓库）',
    );
    // 冻结清单／白名单自身不得有重复项，否则断言 2／4／5 会互相掩盖。
    assert.equal(
      new Set(FROZEN_CHAIN).size,
      FROZEN_CHAIN.length,
      'FROZEN_CHAIN 自身有重复项',
    );
    assert.equal(
      new Set(UNWIRED_DECLARATIONS.map((item) => item.path)).size,
      UNWIRED_DECLARATIONS.length,
      'UNWIRED_DECLARATIONS 自身有重复项',
    );
    // 冻结清单必须全部是 tests/integration 下的 .mjs，且都在目录实读结果里（防冻结清单本身腐烂）。
    const frozenOutsideScope = FROZEN_CHAIN.filter(
      (path) => !path.startsWith(`${INTEGRATION_DIR}/`) || !path.endsWith('.mjs'),
    );
    assert.deepEqual(frozenOutsideScope, [], `冻结清单条目越出 tests/integration/*.mjs 范围：${frozenOutsideScope.join('、')}`);
    const frozenAbsent = FROZEN_CHAIN.filter((path) => !integrationScripts.includes(path));
    assert.deepEqual(frozenAbsent, [], `冻结清单条目已不在 tests/integration 目录里：${frozenAbsent.join('、')}`);
    // 链里不得混进非 tests/integration 的条目（该脚本的语义就是回环集成脚本）。
    const outsideChain = chainPaths.filter((path) => !path.startsWith(`${INTEGRATION_DIR}/`));
    assert.deepEqual(outsideChain, [], `${SCRIPT_NAME} 链里出现了 tests/integration 之外的条目：${outsideChain.join('、')}`);
  });
});

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
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_deletion_test`（脚本自己断言 hostname=127.0.0.1、'
      + 'pathname=/gengyun_deletion_test、public 下无表）：自建 5 组角色 + 运行时 LOGIN，口令在脚本内'
      + ' `randomBytes(24)` 生成**并写进它自己用的运行时 URL**（scram 下自洽），收尾逐个 DROP 且复核为空；'
      + '由 `.github/workflows/real-pg-integration.yml` 的独立真库 job（`postgres:17.11` service）运行，'
      + '不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/account-suspend-pg.mjs',
    reason: '需真实 PG 17.11（硬钉库名 `gengyun_suspend_test`；脚本要求**空库**，自己 apply 0001–0017 后把 0017 '
      + '单独跑 UP/ROLLBACK/REPLAY 三连）：R28-S39 已把它接进 `.github/workflows/real-pg-integration.yml`，'
      + '由该 workflow 的独立真库 job（`postgres:17.11` service）里一个**独立 step** 真跑'
      + '（自带 `CREATE DATABASE gengyun_suspend_test`；argv 只给 owner URL，运行时角色由脚本自建并派生 URL ⇒ '
      + 'scram 下自洽，旧版「口令割裂 ⇒ 28P01」的缺陷已由 R28-S15 修掉）；它**不进**无 PG 的回环链——'
      + '回环链里既没有真 PG 也没有可建角色的超管连接，接进真库 job 不等于进 `test:integration:http`，'
      + '故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/admin-accounts-read-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_admin_accounts_read_test`：运行时角色的口令由脚本'
      + '**从 argv[3] 的 URL 解出来**再 `CREATE ROLE`（`admin-accounts-read-pg.mjs:190-192`）⇒ scram 下自洽；'
      + '由 `.github/workflows/real-pg-integration.yml` 的独立真库 job（`postgres:17.11` service）运行，'
      + '不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/admin-audit-logs-pg.mjs',
    reason: '需真实 PG 17.11，且是**自起集群**脚本（R34 / #18 交付）：要求 `GY_PG_BIN` 指向服务端'
      + '二进制目录，自行 `initdb`/`pg_ctl` 起一次性集群（仅回环；端口在 55436–55467 里**先探活再起**，'
      + '数据目录父目录走可选的 `GY_R34_PG_ROOT`，收尾 `pg_ctl stop` + 删目录），再 apply 迁移 0033 起的读面：'
      + '`public.list_admin_audit_logs()` 的七参数绑定、键集 `(created_at, id)` 分页、'
      + '同一毫秒不同微秒不漏行，并断言运行时角色直读 `admin_audit_events` 仍恰好 42501（零新增授权）。'
      + '缺 `GY_PG_BIN` 时脚本打印 3 行 SKIP 并 **exit 77**（未取得，⛔ 不是通过；也不认 --allow-skip）。'
      + '本片（R34）**未**把它接进 `.github/workflows/real-pg-integration.yml`：`.github/workflows/**` 不在'
      + '本片授权范围，接线会连带改 `ci-real-pg-wiring.test.mjs` 的 `MANAGED_SCRIPTS`／'
      + '`FROZEN_MANAGED_SCRIPTS`／`REQUIRED_STEP_ORDER` 三张清单与证据页（那是独立的一次门禁变更，'
      + '须由指挥裁定），故在此如实登记为未接线；本地已用本机 PG 17.11 二进制跑通该臂。'
      + '它同样**不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`，'
      + '接进真库 job 不等于进 `test:integration:http`。',
  },
  {
    path: 'tests/integration/admin-scopes-authority-pg.mjs',
    reason: '需真实 PG 17.11，且是**自起集群**脚本（R37 / `#18` S2 片1 交付）：要求 `GY_PG_BIN` 指向服务端'
      + '二进制目录，自行 `initdb` 后以 `postgres -D … -p … -h 127.0.0.1` 前台进程起一次性集群'
      + '（仅回环；端口在 55600–55639 里**先探活再起**，数据目录父目录走可选的 `GY_R37_PG_ROOT`，'
      + '收尾 `pg_ctl stop -m fast` + 删目录），再按**生产顺序**跑 `migrate.ts up` ⇒ `roles/*.sql` ⇒'
      + ' `20-login-roles.sql` ⇒ `90-assert-least-privilege.sql`（末行必须 ok、新增断言 103/104 必须为真），'
      + '最后以 `gengyun_api_runtime` 身份直调迁移 0041 的 `grant_admin_scope` / `revoke_admin_scope`：'
      + '正常授予与撤销、幂等（不写第二条审计、不 bump revision）、自授与「授予自己未持有的 scope」被拒、'
      + '目标停用被拒、版本冲突、撤销后复活（重置 granted_at）、最后授权者守卫（含停用账号不计入）、'
      + '审计撞主键整笔回滚（零写入）、闭集外取值由库层 CHECK 拒绝（23514）。'
      + '缺 `GY_PG_BIN` 时脚本打印 3 行 SKIP 并 **exit 77**（未取得，⛔ 不是通过；也不认 --allow-skip）。'
      + '本片**未**把它接进 `.github/workflows/real-pg-integration.yml`：`.github/workflows/**` 不在'
      + '本片授权范围，接线会连带改 `ci-real-pg-wiring.test.mjs` 的 `MANAGED_SCRIPTS`／'
      + '`FROZEN_MANAGED_SCRIPTS`／`REQUIRED_STEP_ORDER` 三张清单与证据页（那是独立的一次门禁变更，'
      + '须由指挥裁定），故在此如实登记为未接线；本地已用本机 PG 17.11 二进制跑通该臂。'
      + '它同样**不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`，'
      + '接进真库 job 不等于进 `test:integration:http`。',
  },
  {
    path: 'tests/integration/admin-scopes-read-pg.mjs',
    reason: '需真实 PG 17.11，且是**自起集群**脚本（R37 / `#18` S2 片2 读面交付）：要求 `GY_PG_BIN` 指向'
      + '服务端二进制目录，自行 `initdb` 后 `pg_ctl start` 起一次性集群（仅回环；端口在 55468–55499 里'
      + '**先探活再起**，数据目录父目录走可选的 `GY_R37_PG_ROOT`，收尾 `pg_ctl stop -m immediate` + 删目录），'
      + '按**生产顺序**跑全链迁移（含 0041），再断言：`admin_scopes_scope_closed_set` 的取值集合与'
      + ' `services/api/src/admin/scopes.ts` 的 `ADMIN_SCOPES` 逐项相等、闭集外取值插入即 23514；'
      + '运行时角色（`gengyun_auth_privacy`）能读 `admin_scopes.scope` 与 `admin_accounts` 的窄列，'
      + '但直读 `granted_by`/`granted_at` 一律 42501、`has_column_privilege` 为 false、表级 '
      + '`INSERT`/`UPDATE`/`DELETE` 全 false（零新增授权）；最后以 real 装配 + 真库池跑两条读面：'
      + '列表 / 单条只返 scope 字符串数组（⛔ 无 granted_by/granted_at）、列表 id 来自 `admin_accounts`'
      + '（⛔ 不是 `users.id`）、缺 `scopes:read` 一律 403、不存在 404、无令牌 401。'
      + '缺 `GY_PG_BIN` 时脚本打印 3 行 SKIP 并 **exit 77**（未取得，⛔ 不是通过；也不认 --allow-skip）。'
      + '本片**未**把它接进 `.github/workflows/real-pg-integration.yml`：`.github/workflows/**` 不在'
      + '本片授权范围，接线会连带改 `ci-real-pg-wiring.test.mjs` 的 `MANAGED_SCRIPTS`／'
      + '`FROZEN_MANAGED_SCRIPTS`／`REQUIRED_STEP_ORDER` 三张清单与证据页（那是独立的一次门禁变更，'
      + '须由指挥裁定），故在此如实登记为未接线。'
      + '它同样**不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`，'
      + '接进真库 job 不等于进 `test:integration:http`。',
  },
  {
    path: 'tests/integration/admin-community-posts-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_admin_community_posts_test`：脚本要求**空库**'
      + '（先断言 `public` 下 0 张表），只 apply 0001+0022+0030+0032（社区帖读/写真正依赖的四段：'
      + '身份底座、社区六表（含 `community_moderation_decisions`，读面 `effectiveState()` 每次都要它）、'
      + '0030 的 `anonymized_author_ref`、0032 的同一套列口径），⛔ 不是全链，也不引 0007 的 pgcrypto 扩展；'
      + '再用 **real 装配 + 真库池**跑列表/单条读面、`POST /admin/posts/{id}/hide` 的下架处置'
      + '（真库行 visibility+revision、`post.hide` 审计留痕、社区可见性联动）与失败隔离'
      + '（八条被拒路径逐列不动 + 并发只成功一笔）。连接串只走 argv[2]（owner URL），不建组角色；'
      + '缺 URL 时脚本打印 SKIP 并 exit 77 ⇒ workflow 把 77 显式升级成硬失败。'
      + 'R34 已把它接进 `.github/workflows/real-pg-integration.yml` 的 `real-pg-17.11` job'
      + '（自带 `CREATE DATABASE gengyun_admin_community_posts_test` 空库、一个**独立 step** 真跑）；'
      + '它**不进**无 PG 的回环链——接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/admin-jobs-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_admin_jobs_test`：本脚本自带迁移全量应用（0001→0027）、'
      + '运行时角色最小权限探针（只跑开关/审计两条出厂授权区域，作业表的列级读授权归 0024/0025/0026 各自的区域，'
      + '本脚本只断言「未授列读不到」而**不代发授权**）、以及开关关/开/再关与作业读/取消的 HTTP 真读数；'
      + '缺 argv[2] 时回落到回环默认 URL（与 `admin-flags-pg.mjs` 同形：连不上就硬失败，不打印 SKIP），'
      + '故不进无 PG 的回环链。'
      + 'R29-S5 交付脚本与本地真读数（PG 17.11 / 127.0.0.1:55432）；R31 已把它接进'
      + ' `.github/workflows/real-pg-integration.yml` 的 `real-pg-17.11` job（自带 `CREATE DATABASE gengyun_admin_jobs_test`'
      + ' 空库、只传 argv[2]、把 77 显式升级成硬失败），由该 job 一个**独立 step** 真跑；'
      + '它**不进**无 PG 的回环链——接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/admin-content-pg.mjs',
    reason: '需真实 PG 17.11，且是**自起集群**脚本（R34 / #18 交付）：要求 `GY_PG_BIN` 指向服务端二进制目录，'
      + '自行 `initdb`/`pg_ctl` 起一次性集群（仅回环；端口在 55600–55699 里**先探活再起**，并硬挡 55436/55437，'
      + '数据目录父目录走可选的 `GY_I18_PG_ROOT`，收尾 `pg_ctl stop` + 删目录），再 apply 全链迁移（含本片 0036）、'
      + '跑 `deploy/postgres-cvm/sql` 的 `gy-r34-content-grant` 授权区域，然后用 **real 装配 + 真库池**走完'
      + '内容域 24 条路由（建草稿/幂等重放/列表/读/改/发布/撤回）与归属隔离，并断言运行时角色直连'
      + '`DELETE`/`TRUNCATE`/改未授权列一律 42501（列级而非表级的负控制），最后在独立库里跑 rollback 脚本确认三表删净。'
      + '缺 `GY_PG_BIN` 时脚本打印 3 行 SKIP 并 **exit 77**（未取得，⛔ 不是通过；也不认 --allow-skip），'
      + '`pg` 依赖在闸门之后才 `await import`，避免把「没二进制」报成「依赖缺失 ⇒ 失败」。'
      + '本片（R34）**未**把它接进 `.github/workflows/real-pg-integration.yml`：`.github/workflows/**` 不在'
      + '本片授权范围，接线会连带改 `ci-real-pg-wiring.test.mjs` 的 `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS`／'
      + '`REQUIRED_STEP_ORDER` 三张清单与证据页（那是独立的一次门禁变更，须由指挥裁定），故在此如实登记为未接线；'
      + '本地已用本机 PG 17.11 二进制跑通该臂（10 组 ALL PASS，EXITCODE=0）。'
      + '它同样**不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`，'
      + '接进真库 job 不等于进 `test:integration:http`。',
  },
  {
    path: 'tests/integration/admin-flags-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_flags_test`：argv[3] 省略时脚本自己 `CREATE ROLE`（**只接受'
      + '自己本轮新建的角色** —— `preflightRuntimeRole` 在任何写库动作之前硬拒「同名角色已存在」，⛔ 不再'
      + '`ALTER ROLE … PASSWORD` 接管）并把随机口令写进它自己的 URL（`admin-flags-pg.mjs` 的 `provisionRoles`）'
      + '⇒ scram 下自洽（这也正是 workflow 里只传一个参数的原因）；由 `.github/workflows/real-pg-integration.yml` '
      + '的独立真库 job（`postgres:17.11` service）运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/auth-privacy-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/auth-privacy-postgres.yml` 用独立测试集群运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/backup-purge-pg.mjs',
    reason: '需真实 PG 17.11 且是**自起集群**脚本：要求 `GY_PG_BIN` 指向**服务端二进制目录**'
      + '（自行 `initdb`/`pg_ctl` 起第二个 17.11 集群，仅回环；端口 `55500 + randomInt(0, 500)`'
      + ' 无环境变量可覆盖）；缺 `GY_PG_BIN` 时脚本打印 SKIP 并 exit 77（⛔ 不得用 --allow-skip 读成 0）。'
      + 'R28-S49 已把它接进 `.github/workflows/real-pg-integration.yml`：先用 PGDG apt 装 `postgresql-17`'
      + '取 `initdb`/`pg_ctl`，再以 `GY_PG_BIN=/usr/lib/postgresql/17/bin`、'
      + '`GY_I19_PG_ROOT=${{ runner.temp }}/gy-i19-pg` 真跑 ⇒ **已接真库 job**。'
      + '但它**仍不进无 PG 的回环链**：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`'
      + '（装 PG 服务端是那个真库 job 自己的事），故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/backup-copies-purge-pg.mjs',
    reason: '需真实 PG 17.11，且与 `backup-purge-pg.mjs` 同为**自起集群**脚本：要求 `GY_PG_BIN` 指向服务端'
      + '二进制目录（自行 `initdb`/`pg_ctl` 起临时集群，仅回环；端口取 556xx 且**先探活再起**，'
      + '因为同机可能已有别人的临时集群）；缺 `GY_PG_BIN` 时打印 SKIP 并 exit 77'
      + '（⛔ 不得用 --allow-skip 读成 0）。它验证的是备份副本 30 日到期**驱动**'
      + '（到期枚举 / 逐组清除 / 失败不阻塞 / failed 重排 / 幂等重跑 / CLI 退出码），没有真库就没有读数。'
      + 'R28-E5 已把它接进 `.github/workflows/real-pg-integration.yml`：复用该 job 里那条装 `postgresql-17`'
      + '（PGDG `noble-pgdg`）的 step 装出来的 `/usr/lib/postgresql/17/bin`（`GY_PG_BIN`）＋'
      + ' `GY_I19_PG_ROOT=${{ runner.temp }}/gy-i19-pg` 真跑，⛔ 不自己 `CREATE DATABASE`（受管脚本第 13 条）'
      + ' ⇒ **已接真库 job**。但它**仍不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`'
      + '（装 PG 服务端是那个真库 job 自己的事），故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/catalog-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/catalog-postgres.yml` 用独立测试集群运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/community-filter-pg.mjs',
    reason: '需真实 PG17 且硬钉库名 `gengyun_community_filter_test`（脚本自己断言 hostname 回环、'
      + 'pathname=/gengyun_community_filter_test、public 下无表）：取 `GET /posts` 的 `crop_id`/`region_code`/'
      + '`mine` 三类筛选的**真库读数**（逐条与同条件 SELECT 对照）、游标绑定筛选集、参数闭集 400、'
      + '以及「筛选未下推 SQL」的语句读数 + `community_posts_feed_idx` 的 EXPLAIN 读数；'
      + '未配置 `COMMUNITY_FILTER_PG_TEST_URL` 时**显式打印 SKIP 并以 77 退出**'
      + '（未取得，不是通过；仅 `--allow-skip`／`GY_ALLOW_SKIP=1` 显式取 0，⛔ 不得用于门禁）；'
      + '由 `.github/workflows/real-pg-integration.yml` 的独立真库 job（`postgres:17.11` service）运行，'
      + '不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/qa-citations-pg.mjs',
    reason: '需真实 PG 17.11 且要求**空库** `gengyun_qa_citations_test`（脚本自己 apply 迁移子集'
      + ' 0001/0002/0005/0008/0010/0012/0013）；连接串只走 env `QA_CITATIONS_PG_TEST_URL`，'
      + '未设时打印 SKIP 并 exit 77（⛔ 不得用 --allow-skip 读成 0、⛔ 不得接进无 PG 的回环链）。'
      + 'R31 已把它接进 `.github/workflows/real-pg-integration.yml` 的 `real-pg-17.11` job（连同受管清单'
      + ' `MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS`／`REQUIRED_STEP_ORDER` 与证据页'
      + ' `docs/verification/gy-r31-pg-arms-wiring-20261022.md`），由一个**独立 step** 真跑并把 77 升级成硬失败；'
      + '它**不进**无 PG 的回环链——接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/community-pg.mjs',
    reason: '需真实 PG17 且硬钉库名 `gengyun_community_test`：未配置 `COMMUNITY_PG_TEST_URL` 时'
      + '**显式打印 SKIP 并以 77 退出**（未取得，不是通过；仅 `--allow-skip`／`GY_ALLOW_SKIP=1` 显式取 0）；'
      + '由 `.github/workflows/real-pg-integration.yml` 的独立真库 job（`postgres:17.11` service）运行，'
      + '不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/consent-grant-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/consent-grant-postgres.yml` 用独立测试集群运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/conversations-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_conversations_test`（本机隔离集群，仅回环端口）：'
      + '本片用它取"引用只能取自本次检索集合"的真库读数（真读面视图 → 真检索端口 → 真守卫 → 真 PG store）；'
      + '未配置 `CONVERSATIONS_PG_TEST_URL` 时**显式打印 SKIP 并以 77 退出**（未取得，不冒充通过；'
      + '仅 `--allow-skip`／`GY_ALLOW_SKIP=1` 显式取 0），'
      + '由 `.github/workflows/real-pg-integration.yml` 的独立真库 job（`postgres:17.11` service）运行，'
      + '不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/egress-ledger-pg.mjs',
    reason: '需真实 PG 且硬钉库名 `gengyun_egress_test`：由 `consent-grant-postgres.yml` 先建库再运行。',
  },
  {
    path: 'tests/integration/egress-object-key-pg.mjs',
    reason: '需真实 PG 且硬钉前置：由 `consent-grant-postgres.yml` 在同一 `gengyun_egress_test` 上紧跟'
      + ' `egress-ledger-pg.mjs`（`EGRESS_LEDGER_KEEP=1` 保留角色/夹具行）之后运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/egress-revoke-race-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_egress_revoke_race_test`（首行断言 `public` 表数 = 0）：由'
      + ' `consent-grant-postgres.yml` 先建库再运行。它与 `gengyun_egress_test` **刻意不共库**（两套夹具的账号/撤回时序'
      + '互不兼容），故不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/favorites-history-isolation-http.reverse-control.mjs',
    reason: '反向控制运行器，**故意**不在门禁名单内（需显式运行，自证见同目录正向脚本注释）。',
  },
  {
    path: 'tests/integration/favorites-history-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/real-pg-integration.yml` 用独立测试集群运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/knowledge-native-consumer.mjs',
    reason: '需外部组合目录／runtime 目录作参数（微信原生侧业务消费者），不在 CI 回环链内。',
  },
  {
    path: 'tests/integration/local-knowledge-smoke.mjs',
    reason: '需先跑 `tools/local-dev` 生成 `.local/local-dev` 本机目录，属本机任务而非 CI 回环。',
  },
  {
    path: 'tests/integration/media-persistence-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_media_test`（脚本只允许回环地址）：脚本要求**空库**，'
      + '自己 `applyMigrations(discoverMigrations())` 套用 26 个迁移（与 `npm run db:migrate` 同一条代码路径），'
      + '随后跑三段式上传／owner 逐字节读／非 owner NOT_FOUND／同键重复 complete 行数不变／**子进程真重启**后'
      + '同 uploadId 仍可读／缺 `MEDIA_OBJECT_REF_KEY` 时整域 503／空仓储负控制。'
      + 'R28-W12 已把它接进 `.github/workflows/real-pg-integration.yml` 的独立真库 job'
      + '（`postgres:17.11` service，一个**独立 step** 自带 `CREATE DATABASE gengyun_media_test`），'
      + '但它**不进**无 PG 的回环链：回环链里既没有真 PG、也没有对象存储替代物以外的任何准备，'
      + '接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/media-concurrency-pg.mjs',
    reason: '需真实 PG 17.11 且库名硬钉 `gengyun_media_concurrency_test`（脚本只允许回环地址，`:64`）：要求**空库**，'
      + '自己 `applyMigrations(discoverMigrations())` 套用全链迁移，随后跑三条并发读数——同一媒体对象两次**并发**'
      + ' complete（恰好一个 202、一个 409 `REVISION_CONFLICT`）／同一 `Idempotency-Key` **跨主体**的 scope 判定'
      + '（各自 201、不回放他人回执、同主体同键异请求体才 409 `IDEMPOTENCY_CONFLICT`）／`reject()` 的条件写布尔语义'
      + '（落库 1 行 true，行已被 `delete` 推进到 deleted 时 0 行 false 且不覆盖终态）。'
      + 'R28-W12 已把它接进 `.github/workflows/real-pg-integration.yml` 的独立真库 job：与 `media-persistence-pg.mjs`'
      + ' **同型但不同库**（`postgres:17.11` service，一个自带 `CREATE DATABASE gengyun_media_concurrency_test` 的'
      + ' 独立 step）——⛔ 不能共库：上一步的读数里有**全库** `count(*)`（`media-persistence-pg.mjs:273-275`、'
      + '`:289-291`、`:426`），共库会让「同一幂等键重复 complete 行数不变」与并发臂的行数互相污染。'
      + '但它**不进**无 PG 的回环链：回环链里既没有真 PG、也没有对象存储之外任何准备，'
      + '接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/media-row-purge-pg.mjs',
    reason: '需真实 PG 17.11，且是**自起集群**脚本（R34 / #19 片 2 交付）：要求 `GY_PG_BIN` 指向服务端'
      + '二进制目录，自行 `initdb`/`pg_ctl` 起一次性集群（仅回环；端口在 55700–55799 里**先探活再起**，'
      + '数据目录父目录走可选的 `GY_R34_PG_ROOT`，收尾 `pg_ctl stop` + 删目录），再应用全链迁移并把'
      + '`20-login-roles.sql` 的段 M（媒体域生产授权面）与本片新增的段 D4（仅一条 EXECUTE）切出来真跑：'
      + '断言运行时对 `public.media` 仍**零表级 DELETE/TRUNCATE**（直删恰好 42501）而'
      + '`media_derivatives`/`media_object_cleanup` 的表级 DELETE 仍在；再以运行时身份调'
      + '`public.purge_owner_media(uuid)`，逐键核对读数 `media/derivatives/queued/skipped_referenced/skipped_referenced_by`，'
      + '并把三条硬条件各钉一段：缺清理意图行 ⇒ `G0007` 且**整批不删**、非终态五行一行不动、'
      + '**11 列 / 8 类**引用面（有外键的 `content_media_refs`／`community_media_grants`／`public_authors.avatar_media_id`，'
      + '加上**无外键**的 `users.avatar_media_id`／`ocr_jobs`／`ocr_records`／`recognition_jobs`／`recognition_records`／'
      + '`speech_jobs`／`transcriptions`／`community_posts.media_ids`）'
      + '指向的行留原地；另测幂等第二次全 0、`p_owner IS NULL` ⇒ `G0001`、清理台账不随父行消失'
      + '（0029 故意不建外键）。缺 `GY_PG_BIN` 时脚本打印 3 行 SKIP 并 **exit 77**'
      + '（未取得，⛔ 不是通过；也不认 --allow-skip）；⚠ `pg` 只在这道闸门**之后**动态加载 —— '
      + '静态 import 会被提升到闸门之上，在无 `node_modules` 的树里以 exit 1 死在 SKIP 之前（把「未取得」报成「失败」）。'
      + '本片（R34 / #19 片 2）**未**把它接进 `.github/workflows/real-pg-integration.yml`：'
      + '`.github/workflows/**` 不在本片授权范围，接线会连带改 `ci-real-pg-wiring.test.mjs` 的'
      + '`MANAGED_SCRIPTS`／`FROZEN_MANAGED_SCRIPTS`／`REQUIRED_STEP_ORDER` 三张清单与证据页'
      + '（那是独立的一次门禁变更，须由指挥裁定），故在此如实登记为未接线。'
      + '它同样**不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`，'
      + '接进真库 job 不等于进 `test:integration:http`。',
  },
  {
    path: 'tests/integration/messages-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/real-pg-integration.yml` 用独立测试集群运行，不进无 PG 的回环链。',
  },
  {
    // R34（#17「社区事件 → 消息域」）：**紧挨着 `messages-pg`** 登记（同一条「消息域落库」链的两面：
    // 消息域自己写 vs 经社区事件投递进来）；⛔ 不要追加到清单末尾，那里紧邻 admin 域条目。
    path: 'tests/integration/message-events-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/real-pg-integration.yml` 用专用空库 `gengyun_message_events_test` 运行'
      + '（`psql … CREATE DATABASE … && node <脚本> <owner url>`），不进无 PG 的回环链——'
      + '回环链里既没有真库可 `CREATE DATABASE`、也没有迁移/唯一键可裁决，'
      + '而本脚本证明的正是「社区事件经装配层投递进 `public.messages`、同一事件键只有一行、'
      + '投递失败不拖垮内容写入、进程内状态清空后仍能读回未读/已读」这条**只有真库能证明**的链。'
      + '它没有 77 跳过分支（缺 argv 就退回默认端口、连不上即非 0 失败）⇒ 缺库必红。',
  },
  {
    path: 'tests/integration/messages-purge-pg.mjs',
    reason: '需真实 PG 17.11：自己用 `GY_PG_BIN`（含 `initdb`/`pg_ctl`）起临时集群、跑全链迁移与运行时角色授权，'
      + '再经真实 `purgeOwnerData` 取「本主体 messages 行数 → 0／他人行原样」的注销行数读数；未设 `GY_PG_BIN` 时'
      + '**显式打印「未取得，不是通过」并以 77 退出**（不提供 `--allow-skip`），故不进无 PG 的回环链。'
      + 'R29-W13 已把它接进 `.github/workflows/real-pg-integration.yml`：复用该 job 里装 `postgresql-17`'
      + '（PGDG `noble-pgdg`）那条 step 装出来的 `/usr/lib/postgresql/17/bin`（`GY_PG_BIN`），以**独立 step** 真跑，'
      + '⛔ 不自己 `CREATE DATABASE`。⚠️ 它的数据根目录键是 `GY_W11_PG_ROOT`（脚本 `:92`），'
      + '⛔ 不是同族脚本的 `GY_I19_PG_ROOT`——守卫按脚本映射键名并与源码真值交叉核对，给错键即红。'
      + '但它**仍不进**无 PG 的回环链：回环链里既没有真 PG、也没有 `initdb`/`pg_ctl`'
      + '（装 PG 服务端是那个真库 job 自己的事），故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/migrations-negative-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/auth-privacy-postgres.yml` 另起一步、以 `MIGRATIONS_NEGATIVE_TEST_URL`'
      + ' 运行并自建/自删 `gengyun_migrations_negative_{a,b,c}` 三个库；未设 env 时显式 SKIP 打印原因并以 77 退出（未取得），'
      + '故不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/moderation-ledger-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_moderation_test`（脚本自己断言 hostname=127.0.0.1、pathname='
      + '`/gengyun_moderation_test`，连接串只认 argv[2]）：它要跑**整条迁移链**（0001..0026 ⇒ #428 的 0027 DDL 夹具 ⇒ '
      + '0028 的 UP/ROLLBACK/REPLAY 三连），再用真库判审核台账的四条写语句（INSERT/UPDATE/supersede/下架）与并发唯一性，'
      + '无 PG 的回环链里既没有服务端也没有迁移链，故不进 `test:integration:http`。'
      + 'R29 已把它接进 `.github/workflows/real-pg-integration.yml`：由该 workflow 的独立真库 job（`postgres:17.11` service）'
      + '里一个**独立 step**（先 `CREATE DATABASE gengyun_moderation_test` 再 `node …`）真跑，'
      + '接进真库 job 不等于进回环链，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/moderation-full-chain-pg.mjs',
    reason: '需真实 PG 17.11 且是**自起集群**脚本（GY-I14 片 C / #14 交付）：要求 `GY_PG_BIN` 指向服务端'
      + '二进制目录（自行 `initdb`/`pg_ctl` 起一次性集群，仅回环、端口 55600–55999 先探活再起、数据目录父目录'
      + '可选 `GY_I14C_PG_ROOT`，收尾 `pg_ctl stop` + 删目录），只 apply 0001+0022+0028+0030+0032，'
      + '再用 stub 装配 + 真 pool + 合成模型端口（`provider.synthetic === true`）跑 post→edit→review→takedown'
      + ' 全链，真库证明三态：编辑后旧结论不套新版本（rev1/rev2 各绑定各自正文摘要 + 审核域两条版本级任务）、'
      + '超时/结构错误不发布（RULE_TIMEOUT / RULE_ENGINE_ERROR ⇒ 422 且内容行零落库）、下架驱动缓存失效'
      + '（审核域读缓存 1→0 + `moderation_withdrawals` 落库）。缺 `GY_PG_BIN` 时打印 SKIP 并 exit 77'
      + '（⛔ 不是通过，不认 --allow-skip）；本片未把它接进任何 workflow（`.github/workflows/**` 不在本片授权范围），'
      + '故不进无 PG 的回环链，如实登记为未接线。',
  },
  {
    path: 'tests/integration/ocr-corrections-pg.mjs',
    reason: '需真实 PG 17.11（硬钉空库名 `gengyun_ocr_corrections_test`，开头断言 `public` 下 0 张表并 `applyMigrations()` 跑全链；'
      + '未配置 `OCR_PG_TEST_URL` 时**显式打印 SKIP 并以 77 退出**：未取得，不是通过）：R31 已把它接进'
      + ' `.github/workflows/real-pg-integration.yml` 的 `real-pg-17.11` job（一个**独立 step**、自带'
      + ' `CREATE DATABASE gengyun_ocr_corrections_test` 空库、把 77 升级成硬失败；本地真跑 7 项 PASS）；'
      + '它**不进**无 PG 的回环链——接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/ocr-jobs-pg.mjs',
    reason: '需真实 PG 17.11（硬钉库名 `gengyun_ocr_jobs_test`；未配置 `OCR_PG_TEST_URL` 时**显式打印 SKIP 并以 77 退出**：'
      + '未取得，不是通过；仅 `--allow-skip`／`GY_ALLOW_SKIP=1` 显式取 0）：R28-S17 已把它接进'
      + ' `.github/workflows/real-pg-integration.yml`，由该 workflow 的独立真库 job（`postgres:17.11` service）里'
      + '一个**独立 step** 真跑（自带 `CREATE DATABASE gengyun_ocr_jobs_test` 空库）；它**不进**无 PG 的回环链——'
      + '接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/profile-ui-fixture.mjs',
    reason: '夹具模块：被已接线的 `profile-ui-http.test.mjs` import，不是独立可执行脚本。',
  },
  {
    path: 'tests/integration/recognition-chain-e2e.mjs',
    reason: '需真实 PG 17.11（**专用空库** `gengyun_recognition_chain_test`——脚本 `preparePg()` 先数 `public` 下'
      + '的表，非 0 直接断言失败；真库臂只 apply 它需要的两段迁移 0001 身份 + 0018 历史并断言「恰好一次、'
      + '重复 no-op」，⛔ 不跑全链；连接串只走 env `RECOGNITION_CHAIN_PG_TEST_URL`，全程**库 owner** 身份，'
      + '脚本自己从不建角色、也不用运行时角色；链路本身走 loopback 真 HTTP）。'
      + 'R28-S65 已把它接进 `.github/workflows/real-pg-integration.yml` 的独立 step（受管脚本第 13 条，'
      + '自带 `CREATE DATABASE gengyun_recognition_chain_test`，并把缺 env 的 exit 77 显式升级成硬失败）；'
      + '它**仍不进**无 PG 的回环链 `test:integration:http`——缺库即 77，挂进去只会让整链显式失败，'
      + '故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/recognitions-pg.mjs',
    reason: '需真实 PG 17.11（硬钉库名 `gengyun_recognitions_test`；未配置 `RECOGNITIONS_PG_TEST_URL` 时**显式打印 SKIP 并以 77 退出**：'
      + '未取得，不是通过；仅 `--allow-skip`／`GY_ALLOW_SKIP=1` 显式取 0）：R28-S36 已把它接进'
      + ' `.github/workflows/real-pg-integration.yml`，由该 workflow 的独立真库 job（`postgres:17.11` service）里'
      + '一个**独立 step** 真跑（自带 `CREATE DATABASE gengyun_recognitions_test` 空库，脚本自己 apply「除 0025 外全部 → 0025」）；'
      + '它**不进**无 PG 的回环链——接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/recognitions-speech-purge-pg.mjs',
    reason: '需真实 PG 17.11：自己用 `GY_PG_BIN`（含 `initdb`/`pg_ctl`）起临时集群、跑全链迁移与运行时角色授权，'
      + '再经真实 `createUserDataDeletion` 与识别/语音两域的 `purgeOwnerData` 取「本主体七表 → 0 行／他人行原样／'
      + '`public.users` 行仍在（证明不是外键级联的副作用）／两本台账按 scope 前缀只删本主体」的注销读数；'
      + '未设 `GY_PG_BIN` 时**显式打印「未取得，不是通过」并以 77 退出**（不提供 `--allow-skip`），'
      + '故不进无 PG 的回环链。⚠️ 它的数据根目录键是 `GY_R34_PG_ROOT`（脚本 `:92`），⛔ 不是同族脚本的'
      + ' `GY_W11_PG_ROOT`——守卫按脚本映射键名并与源码真值交叉核对，给错键即红。'
      + '本片（GY-R34-I19）未把它接进任何 workflow：真库读数以本地临时集群取得（见'
      + ' `docs/verification/gy-r34-i19-deletion-closure-20261023.md` §4），接 CI 留待总监安排。',
  },
  {
    // GY-I19（#19 片B-演练）：加速时钟演练——把时间推到第 7/30 日边界，在 stub（纯逻辑，不碰 PG）与
    // PG（一次性临时集群）两层各证一遍「未到期不删／刚好到期删（闭区间）／到期删」。按路径序落在
    // `recognitions-speech-purge-pg` 与 `retention-purge-pg` 之间登记（同属 #19 的到期/保留族）。
    path: 'tests/integration/retention-clock-drill-pg.mjs',
    reason: '需真实 PG 17.11：自己用 `GY_PG_BIN`（含 `initdb`/`pg_ctl`）起一次性临时集群'
      + '（端口 55600+randomInt(0,300)、**先探活再起**、只监听 127.0.0.1，数据目录根 `GY_I19_PG_ROOT` 默认 `tmpdir()`、'
      + '跑完 `pg_ctl stop` + 删目录），再把可注入时钟推到第 7/30 日边界，经在线/备份两份到期驱动取'
      + '「未到期不删／刚好到期删（闭区间）／到期删」三态真库读数（stub 臂纯逻辑不碰 PG、不读墙钟）；'
      + '未设 `GY_PG_BIN` 时**显式打印「未取得，不是通过」并以 77 退出**（`--allow-skip`／`GY_ALLOW_SKIP=1` 仅降级为 0，'
      + '⛔ 不得接进门禁）。本片只改 `tests/`、不新增 workflow（`.github/workflows/**` 不在本片授权范围），'
      + '故不进无 PG 的回环链，如实登记为未接线。',
  },
  {
    // R34（#19 的**保留策略侧**，GY-R34-RETENTION）：按路径序落在 `recognitions-pg` 与 `source-lifecycle-pg`
    // 之间登记。它与 `messages-purge-pg`／`online-purge-pg` **同族**：自起临时集群、自建库、跑完即删。
    path: 'tests/integration/retention-purge-pg.mjs',
    reason: '需真实 PG 17.11：自己用 `GY_PG_BIN`（含 `initdb`/`pg_ctl`）起临时 17 集群'
      + '（端口 55432–55467 且**先探活再起**，可用 `GY_PG_PORT` 钉死）、只监听 127.0.0.1、'
      + '自建 `gengyun_retention_purge_test`，跑全链迁移后造「过期／未过期／贴边」三类真数据，'
      + '再经 `npm run purge:retention` 的执行器取「只删过期、未过期零改动、第二轮删 0 行」的读数；'
      + '未设 `GY_PG_BIN` 时**显式打印「未取得，不是通过」并以 77 退出**（不提供 `--allow-skip`），'
      + '故不进无 PG 的回环链。R34 已把它接进 `.github/workflows/real-pg-integration.yml`：'
      + '复用该 job 里装 `postgresql-17`（PGDG）那条 step 装出来的 `/usr/lib/postgresql/17/bin`（`GY_PG_BIN`），'
      + '以**独立 step** 真跑，⛔ 不自己 `CREATE DATABASE`（库名由脚本在自己临时集群里建）。'
      + '⚠️ 它的数据根目录键是 `GY_R34_PG_ROOT`（脚本取值点 `process.env.GY_R34_PG_ROOT ?? tmpdir()`），'
      + '⛔ 不是同族脚本的 `GY_I19_PG_ROOT`／`GY_W11_PG_ROOT`——守卫按脚本映射键名并与源码真值交叉核对，'
      + '给错键即红。但接进真库 job 不等于进 `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/source-lifecycle-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/source-lifecycle-postgres.yml` 用独立测试集群运行。',
  },
  {
    path: 'tests/integration/speech-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_speech_test`：脚本先断言 public 下 0 张表（**必须是空库**），'
      + '再跑 0026 的 UP／ROLLBACK／REPLAY 与 12 方法语义；未配置 `SPEECH_PG_TEST_URL` 时'
      + '**显式打印 SKIP 并以 77 退出**（未取得，不是通过；仅 `--allow-skip`／`GY_ALLOW_SKIP=1` 显式取 0）：'
      + 'R28-S40 已把它接进 `.github/workflows/real-pg-integration.yml`，由该 workflow 的独立真库 job'
      + '（`postgres:17.11` service）里一个**独立 step** 真跑（自带 `CREATE DATABASE gengyun_speech_test` 空库，'
      + '连接串走 env `SPEECH_PG_TEST_URL`）；它**不进**无 PG 的回环链——接进真库 job 不等于进'
      + ' `test:integration:http`，故在此如实登记为未接线。',
  },
  {
    path: 'tests/integration/staging-intake-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/staging-intake-postgres.yml` 用独立测试集群运行。',
  },
  {
    path: 'tests/integration/user-chain-e2e.mjs',
    reason: '需真实 PostgreSQL 17：脚本自己用 `initdb` 起一次性隔离集群（随机端口、独立数据目录，'
      + '跑完 `pg_ctl stop` 并逐个文件删除数据目录），依赖本机 PG 二进制（`USER_CHAIN_PG_BIN`，缺省走 PATH）；'
      + '缺 PG17 时显式跳过并以 **77** 退出（未取得，⛔ 不是通过）；'
      + '本片未新增对应 CI workflow（如实登记为未取得项），故不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/online-purge-pg.mjs',
    reason: '需真实 PostgreSQL 17：脚本自己用 `initdb` 起一次性隔离集群（随机端口 556xx、独立数据目录，'
      + '跑完 `pg_ctl stop` 并递归删除数据目录），依赖本机 PG 二进制（`GY_PG_BIN`）；缺 `GY_PG_BIN` 时'
      + '显式跳过并以 **77** 退出（未取得，⛔ 不是通过）。还要真跑 `20-login-roles.sql` 主体里的'
      + '四域 GRANT（运行时角色四域 DELETE 的既有授权面），回环链里既没有真 PG 也没有可建角色的超管连接，'
      + '故如实登记为未接线（本片不新增 workflow：`.github/workflows/**` 不在本片授权范围）。',
  },
  {
    path: 'tests/integration/workbook-staging-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/workbook-staging.yml` 用独立测试集群运行。',
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

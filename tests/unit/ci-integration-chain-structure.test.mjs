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
    path: 'tests/integration/admin-flags-pg.mjs',
    reason: '需真实 PG 17.11 且硬钉库名 `gengyun_flags_test`：argv[3] 省略时脚本自建/ALTER 运行时角色、'
      + '把随机口令写进它自己的 URL（`admin-flags-pg.mjs:249-262`）⇒ scram 下自洽（这也正是 workflow 里'
      + '只传一个参数的原因）；由 `.github/workflows/real-pg-integration.yml` 的独立真库 job'
      + '（`postgres:17.11` service）运行，不进无 PG 的回环链。',
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
    path: 'tests/integration/messages-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/real-pg-integration.yml` 用独立测试集群运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/migrations-negative-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/auth-privacy-postgres.yml` 另起一步、以 `MIGRATIONS_NEGATIVE_TEST_URL`'
      + ' 运行并自建/自删 `gengyun_migrations_negative_{a,b,c}` 三个库；未设 env 时显式 SKIP 打印原因并以 77 退出（未取得），'
      + '故不进无 PG 的回环链。',
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

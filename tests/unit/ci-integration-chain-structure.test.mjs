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
    reason: '需真实 PG 且硬钉库名 `gengyun_deletion_test`（本机原生 PG 隔离集群，仅回环端口）；'
      + '本片未新增对应 CI workflow（如实登记为未取得项），故不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/account-suspend-pg.mjs',
    reason: '需真实 PG 17.11 隔离集群且必须传两个连接串参数（管理员 URL + 运行时角色 URL）：'
      + '本片用它取迁移三连／最小权限／A–F／失败注入回滚的真库读数；'
      + '本片未新增对应 CI workflow（如实登记为未取得项），故不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/admin-flags-pg.mjs',
    reason: '需真实 PG 17.11 隔离集群且硬钉库名 `gengyun_flags_test`（脚本自建运行时角色并重放'
      + ' `gy-i18-flags-grant` 区域）；本片未新增对应 CI workflow（如实登记为未取得项），'
      + '故不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/auth-privacy-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/auth-privacy-postgres.yml` 用独立测试集群运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/catalog-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/catalog-postgres.yml` 用独立测试集群运行，不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/consent-grant-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/consent-grant-postgres.yml` 用独立测试集群运行，不进无 PG 的回环链。',
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
    reason: '需真实 PG17 且硬钉库名 `gengyun_favorites_history_test`：未配置 `FAVORITES_HISTORY_PG_TEST_URL` 时'
      + '**显式打印 SKIP 并以 0 退出**（不静默绿）；本片未新增对应 CI workflow（如实登记为未取得项），故不进无 PG 的回环链。',
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
    path: 'tests/integration/migrations-negative-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/auth-privacy-postgres.yml` 另起一步、以 `MIGRATIONS_NEGATIVE_TEST_URL`'
      + ' 运行并自建/自删 `gengyun_migrations_negative_{a,b,c}` 三个库；未设 env 时显式 SKIP 打印原因，'
      + '故不进无 PG 的回环链。',
  },
  {
    path: 'tests/integration/profile-ui-fixture.mjs',
    reason: '夹具模块：被已接线的 `profile-ui-http.test.mjs` import，不是独立可执行脚本。',
  },
  {
    path: 'tests/integration/source-lifecycle-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/source-lifecycle-postgres.yml` 用独立测试集群运行。',
  },
  {
    path: 'tests/integration/staging-intake-pg.mjs',
    reason: '需真实 PG：由 `.github/workflows/staging-intake-postgres.yml` 用独立测试集群运行。',
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

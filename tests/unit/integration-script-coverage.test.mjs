// GY-I23：tests/integration 脚本接线守卫（前向 + 反向控制 + 豁免表锁定）
//
// 缺口：`tests/integration/user-chain-e2e.mjs` 一直没有任何 npm 脚本引用它，却也没有任何门禁
// 会因此变红——脚本写好了、没人跑、也没人知道没人跑。本测试把这条缺口变成**结构性**的：
// 新增一个纯回环／E2E 集成脚本，若既不接进 npm 脚本、又没把「接不进去的前置条件」登记进
// 下面的裁决豁免表，本测试立刻红并**点名文件**。
//
// 判类口径（刻意收窄，见 docs/verification/gy-i23-integration-script-coverage-20261020.md）：
//   tests/integration/*.mjs 且文件名以 `-http.mjs` | `-http.test.mjs` | `-e2e.mjs` 结尾。
// 收窄的两条理由：
//   ① `*-pg.mjs` 需要真实 PostgreSQL（连接串来自 env、库名硬钉），**恒不可**进无 PG 的
//      `test:integration:http`；把它们算进「必接线集合」只会制造永红。
//   ② 夹具（profile-ui-fixture.mjs / knowledge-http-fixture.cjs）、反向控制运行器
//      （favorites-history-isolation-http.reverse-control.mjs）、本机工具脚本
//      （local-dev-*.cjs / demo-reference.cjs / knowledge-native-consumer.mjs）本就不是门禁入口，
//      是否需要接线是另一个问题，由文档清单逐条登记，不进本守卫。
// 反过来，`miniprogram-login-loop.mjs` 是纯回环 HTTP 但名字不含 `-http`，由既有
// `tests/unit/ci-integration-chain-structure.test.mjs` 的 FROZEN_CHAIN 断言守护，本守卫不重复。
//
// 第二条规则（追加）：**整链跳过必须给 77**。集成脚本打印「跳过／未取得」却以 0 退出时，
// 任何 `&&` 串联、CI、本地一键都会把它读成「通过」——那是假绿。故本文件另断言：脚本自己
// 打印 SKIP 的分支附近必须出现 77 出口，`*-e2e.mjs` 还必须写明「EXITCODE=77 表示未取得」。
// 只认整链跳过；node:test 的用例级 `{ skip }`（如 rejections-http.mjs 的两个）不在此列。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INTEGRATION_DIR = 'tests/integration';

// ── 判类：哪些集成脚本属于「纯回环／E2E，必须被门禁引用」 ───────────────────────────────
export function isPureHttpOrE2e(fileName) {
  return fileName.endsWith('-http.mjs') || fileName.endsWith('-http.test.mjs') || fileName.endsWith('-e2e.mjs');
}

export function selectPureHttpOrE2e(files) {
  return files.filter(isPureHttpOrE2e).sort();
}

// ── 引用判定：脚本被某个 npm script 的**命令文本**提到即算「已接线」 ─────────────────────
// 口径是 `tests/integration/<file>` 全相对路径出现在 script 文本里；只写裸文件名不算，
// 免得 yml 注释、测试自述里的一次名字提及就把守卫糊弄过去。
export function scriptTextsOf(packageJson) {
  return Object.values(packageJson.scripts ?? {});
}

export function isReferenced(scriptTexts, relPath) {
  return scriptTexts.some((text) => text.includes(relPath));
}

// 返回「既没被任何 npm 脚本引用、也没登记进豁免表」的脚本（相对路径，升序）。
export function unreferencedPureScripts({ pureScripts, scriptTexts, exemptions }) {
  const exempt = new Set(exemptions);
  return pureScripts.filter((file) => !exempt.has(file) && !isReferenced(scriptTexts, file));
}

// ── 裁决豁免表：只有「实测确认接不进门禁」的脚本才允许在这里出现 ──────────────────────────
// 每行都必须写清「为什么接不进去 + 需要什么前置」。增删任何一行都要同时改下面的
// FROZEN_EXEMPTION_PATHS，并更新文档清单——这是刻意的：放宽或收紧门禁都必须留下 diff。
const EXEMPTIONS = Object.freeze([
  Object.freeze({
    path: 'tests/integration/user-chain-e2e.mjs',
    reason:
      'E2E 需要真实 PostgreSQL 17（initdb 起集群，且硬断言服务端为 17.x）：环境里找不到 17 的 initdb 时脚本只逐字打印 3 行 SKIP 并以 0 退出，' +
      '接进无 PG 的 test:integration:http 等于把门禁变成静默绿灯，故本单落「未取得」；前置＝CI 里提供 PostgreSQL 17 二进制并单独开一个带 PG 的 workflow。',
  }),
]);

const FROZEN_EXEMPTION_PATHS = Object.freeze(['tests/integration/user-chain-e2e.mjs']);

// ── 被测断言本体：真实输入与反向控制输入都走这一个函数，保证「红的逻辑」与「绿的条件」同源 ──
function assertAllWired({ pureScripts, scriptTexts, exemptions }) {
  const missing = unreferencedPureScripts({ pureScripts, scriptTexts, exemptions });
  assert.deepEqual(
    missing,
    [],
    [
      '有「纯回环／E2E」集成脚本既没有被任何 npm 脚本引用（＝没有门禁会跑它），也没有登记进本文件的裁决豁免表：',
      ...missing.map((file) => `  · ${file}`),
      '',
      '两条出路：①把它接进 wires（通常是 package.json 里 `npm run test:integration:http` 的纯回环链）；',
      '②若它需要真实 PG／网络／本机工具，连同「所需前置」登记进上面的 EXEMPTIONS，并同步 FROZEN_EXEMPTION_PATHS 与文档清单。',
    ].join('\n'),
  );
}

function readPackageJson() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
}

function listIntegrationFiles() {
  return readdirSync(join(REPO_ROOT, INTEGRATION_DIR))
    .map((name) => `${INTEGRATION_DIR}/${name}`)
    .sort();
}

// `test:integration:http` 链里被 `tests/integration/<file>` 点名的脚本（用于交叉核对判类没漏人）。
function chainEntries(packageJson) {
  const chain = packageJson.scripts?.['test:integration:http'] ?? '';
  return [...new Set(chain.match(/tests\/integration\/[A-Za-z0-9.\-_]+/g) ?? [])].sort();
}

test('前向守卫：每个纯回环／E2E 集成脚本都被某个 npm 脚本引用，或已在豁免表登记', () => {
  const packageJson = readPackageJson();
  const pureScripts = selectPureHttpOrE2e(listIntegrationFiles());

  assertAllWired({
    pureScripts,
    scriptTexts: scriptTextsOf(packageJson),
    exemptions: EXEMPTIONS.map((entry) => entry.path),
  });

  // 反空转：判类口径一旦被改名/迁移打破（选中 0 个），上面的断言会「扫了个寂寞」地变绿。
  assert.ok(pureScripts.length >= 12, `只判出 ${pureScripts.length} 个纯回环／E2E 脚本，口径可能已失效`);
});

test('反向控制：塞进一个未接线的纯脚本，同一断言必须红并点名它', () => {
  const packageJson = readPackageJson();
  const realPureScripts = selectPureHttpOrE2e(listIntegrationFiles());
  const probe = `${INTEGRATION_DIR}/guard-probe-not-wired-http.mjs`;
  const exemptions = EXEMPTIONS.map((entry) => entry.path);

  // 探针只活在内存里：不得落盘，也不得在 package.json 里留痕。
  assert.equal(existsSync(join(REPO_ROOT, probe)), false, '反向控制探针必须是内存假文件');
  assert.equal(isReferenced(scriptTextsOf(packageJson), probe), false, '探针不得在 package.json 里被引用');
  assert.deepEqual(
    unreferencedPureScripts({ pureScripts: [...realPureScripts, probe], scriptTexts: scriptTextsOf(packageJson), exemptions }),
    [probe],
    '未接线的纯脚本必须且只能被标出它自己',
  );

  // 红：失败消息必须点名文件。
  assert.throws(
    () => assertAllWired({ pureScripts: [...realPureScripts, probe], scriptTexts: scriptTextsOf(packageJson), exemptions }),
    (error) => /guard-probe-not-wired-http\.mjs/.test(error.message),
    '未接线时同一个断言必须失败，且失败消息要点名文件',
  );

  // 不永红：接进一个 scripts 命令文本后必须转绿（证明「接线」这个出口真的可走通）。
  assertAllWired({
    pureScripts: [...realPureScripts, probe],
    scriptTexts: [...scriptTextsOf(packageJson), `node ${probe}`],
    exemptions,
  });

  // 不糊弄：加一个与探针无关的脚本，不能救它。
  assert.throws(
    () =>
      assertAllWired({
        pureScripts: [...realPureScripts, probe],
        scriptTexts: [...scriptTextsOf(packageJson), 'node tests/integration/tts-http.mjs --unrelated'],
        exemptions,
      }),
    /guard-probe-not-wired-http\.mjs/,
    '不相干的脚本不得把未接线的探针救绿',
  );

  // 豁免出口也必须真的生效（否则「两条出路」只有一条是真的）。
  assertAllWired({ pureScripts: [...realPureScripts, probe], scriptTexts: scriptTextsOf(packageJson), exemptions: [...exemptions, probe] });
});

test('豁免表锁定：只能是被裁决过的文件，且理由必须写明所需前置', () => {
  const packageJson = readPackageJson();
  const scriptTexts = scriptTextsOf(packageJson);
  const paths = EXEMPTIONS.map((entry) => entry.path).sort();

  // 冻结：增删豁免行＝放宽或收紧门禁，必须同时改这里（留下可审的 diff）。
  assert.deepEqual(
    paths,
    [...FROZEN_EXEMPTION_PATHS].sort(),
    '裁决豁免表被改动：增删豁免都必须同步 FROZEN_EXEMPTION_PATHS 并更新文档清单',
  );

  for (const entry of EXEMPTIONS) {
    assert.ok(existsSync(join(REPO_ROOT, entry.path)), `豁免项 ${entry.path} 不存在（改名或删除后请一并删掉这一行）`);
    assert.ok(
      isPureHttpOrE2e(basename(entry.path)),
      `豁免项 ${entry.path} 不在判类口径内，本就不该进「必接线集合」，无需豁免`,
    );
    // 豁免项必须「真的接不进去」：一旦它被接上了，这行豁免就是陈旧的门禁松动。
    assert.equal(
      isReferenced(scriptTexts, entry.path),
      false,
      `豁免项 ${entry.path} 已经被 npm 脚本引用，豁免失效，请删掉这一行`,
    );
    assert.ok(entry.reason.length >= 60, `豁免项 ${entry.path} 的理由太短，没写清「为什么接不进去 + 需要什么前置」`);
    assert.match(entry.reason, /PG|PostgreSQL/, `豁免项 ${entry.path} 的理由必须点名前置条件（PG／PostgreSQL）`);
  }
});

test('判类口径边界：不扫 PG／夹具／本机工具脚本，但链上的纯回环必须被看见', () => {
  const packageJson = readPackageJson();
  const files = listIntegrationFiles();

  // ① `*-pg.mjs` 一律不入选：它们要真实 PostgreSQL，进了必接线集合只会制造永红。
  const pgScripts = files.filter((file) => file.endsWith('-pg.mjs'));
  assert.ok(pgScripts.length >= 12, `盘点到 ${pgScripts.length} 个 -pg.mjs，数量不对劲`);
  assert.deepEqual(selectPureHttpOrE2e(pgScripts), [], '需真实 PG 的脚本不得进必接线集合');

  // ② 夹具／反向控制／本机工具／非 .mjs 也不入选。
  for (const file of [
    'tests/integration/profile-ui-fixture.mjs',
    'tests/integration/knowledge-http-fixture.cjs',
    'tests/integration/favorites-history-isolation-http.reverse-control.mjs',
    'tests/integration/local-dev-ui.cjs',
    'tests/integration/demo-reference.cjs',
    'tests/integration/knowledge-native-consumer.mjs',
    'tests/integration/local-knowledge-smoke.mjs',
    'tests/integration/knowledge-native-pg.ps1',
  ]) {
    assert.deepEqual(selectPureHttpOrE2e([file]), [], `${file} 不是纯回环／E2E 门禁入口，不该被本守卫判进来`);
  }

  // ③ 反向核对：链上点名的纯回环脚本必须都被判类看见（否则守卫「什么都没扫」也会变绿）。
  const pureInChain = chainEntries(packageJson).filter((file) => isPureHttpOrE2e(file));
  assert.ok(pureInChain.length >= 10, `test:integration:http 链里只解析到 ${pureInChain.length} 个纯回环脚本`);
  const scanned = new Set(selectPureHttpOrE2e(files));
  for (const file of pureInChain) {
    assert.ok(scanned.has(file), `链上的 ${file} 没被守卫扫到——判类或扫描目录坏了`);
  }
});

// ── 跳过即未取得：整链跳过必须给 77，不允许「一条都没跑」被读成通过 ─────────────────────
// 只认**脚本自己打印的** SKIP（`console.log/error` 里的 SKIP 字样）。用例级
// `test('…', { skip })`（如 rejections-http.mjs 的两个 skip）不算整链跳过：那一段仍会跑完其余
// 用例并以 0 退出，语义与「整链未取得」不同，本守卫刻意不管它们。
const SKIP_OUTPUT_RE = /console\.(?:log|error)\(\s*[`'"][^`'"]*SKIP/g;
const SKIP_WINDOW = 1600;
// 必须是真的**退出码语句**，不是输出里出现「77」字样——只写 `EXITCODE=77` 却 `return 0`
// 仍然是假绿（这正是本守卫要抓的形状）。
const EXIT_77_RE = /process\.exit\(\s*77\s*\)|process\.exitCode\s*=\s*77\b|return\s+77\s*;/;

export function skipOutputIndexes(source) {
  const indexes = [];
  const re = new RegExp(SKIP_OUTPUT_RE.source, 'g');
  let match = re.exec(source);
  while (match !== null) {
    indexes.push(match.index);
    match = re.exec(source);
  }
  return indexes;
}

/** 打印了整链 SKIP，却在附近没有任何 77 退出码语句 ⇒ 这是假绿（调用方会把「没跑」读成「通过」）。 */
export function wholeChainSkipWithout77({ fileName, source }) {
  if (!fileName.endsWith('.mjs')) return false;
  const indexes = skipOutputIndexes(source);
  if (indexes.length === 0) return false;
  return !indexes.some((index) => EXIT_77_RE.test(source.slice(index, index + SKIP_WINDOW)));
}

/** `*-e2e.mjs` 还必须在输出里写明「EXITCODE=77 表示未取得」，免得读数的人以为 77 是崩溃。 */
export function e2eSkipExitCodeTextMissing({ fileName, source }) {
  if (!fileName.endsWith('-e2e.mjs')) return false;
  if (skipOutputIndexes(source).length === 0) return false;
  return !source.includes('EXITCODE=77');
}

function assertSkipUses77({ entries }) {
  const violations = entries
    .filter((entry) => wholeChainSkipWithout77(entry) || e2eSkipExitCodeTextMissing(entry))
    .map((entry) => entry.fileName)
    .sort();
  assert.deepEqual(
    violations,
    [],
    [
      '有集成脚本打印「整链 SKIP」却没有按约定给退出码 77（POSIX：skipped）——',
      '这类脚本用 `&&` 串进任何脚本链／CI，都会被读成「通过」，也就是假绿：',
      ...violations.map((file) => `  · ${file}`),
      '',
      '改法：跳过分支 `process.exitCode = 77`（或 `return 77`），输出补一行 `EXITCODE=77 表示未取得，不是通过`；',
      '真跑通过仍 0、真失败仍非 0。本机开发者可用 `--allow-skip`／`GY_ALLOW_SKIP=1` 显式取 0（⛔ 不得进门禁）。',
    ].join('\n'),
  );
}

test('整链跳过必须给 77：打印 SKIP 却没给 77 出口的脚本一律红（点名文件）', () => {
  const entries = readdirSync(join(REPO_ROOT, INTEGRATION_DIR))
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => ({
      fileName: `${INTEGRATION_DIR}/${name}`,
      source: readFileSync(join(REPO_ROOT, INTEGRATION_DIR, name), 'utf8'),
    }));

  assertSkipUses77({ entries });

  // 反空转：至少要扫到「有整链 SKIP 分支」的那几个脚本，否则这条守卫等于没扫。
  const skipCapable = entries.filter((entry) => skipOutputIndexes(entry.source).length > 0);
  assert.ok(skipCapable.length >= 3, `只扫到 ${skipCapable.length} 个有整链 SKIP 分支的脚本，判据可能已失效`);
  assert.ok(
    skipCapable.some((entry) => entry.fileName.endsWith('-e2e.mjs')),
    '至少要把 E2E 的跳过分支扫进来',
  );
});

test('反向控制：零出口的假 SKIP 脚本必须红，写明 77 的才绿，用例级 skip 不误伤', () => {
  const zeroExitProbe = {
    fileName: `${INTEGRATION_DIR}/guard-probe-skip-zero-e2e.mjs`,
    source: "async function main() {\n  if (x) {\n    console.log('SKIP real PG17 guard probe');\n    return 0;\n  }\n}\nprocess.exitCode = await main();\n",
  };
  const honestProbe = {
    fileName: `${INTEGRATION_DIR}/guard-probe-skip-honest-e2e.mjs`,
    source:
      "async function main() {\n  if (x) {\n    console.log('SKIP real PG17 guard probe');\n    console.log('EXITCODE=77 表示未取得，不是通过');\n    return 77;\n  }\n}\nprocess.exitCode = await main();\n",
  };

  // ① 红：打印 SKIP 却 return 0，且消息点名文件。
  assert.equal(wholeChainSkipWithout77(zeroExitProbe), true, '零出口假脚本必须被判为违规');
  assert.throws(
    () => assertSkipUses77({ entries: [zeroExitProbe] }),
    (error) => /guard-probe-skip-zero-e2e\.mjs/.test(error.message),
    '零出口假脚本必须让守卫变红，且消息点名文件',
  );

  // ② 绿：同样打印 SKIP，但给了 77 出口并把语义写进输出。
  assert.equal(wholeChainSkipWithout77(honestProbe), false);
  assert.equal(e2eSkipExitCodeTextMissing(honestProbe), false);
  assertSkipUses77({ entries: [honestProbe] });

  // ③ 红：给了 77 却没写「EXITCODE=77」——读数的人会把 77 当崩溃，仍然红。
  const silentProbe = {
    fileName: `${INTEGRATION_DIR}/guard-probe-skip-silent-e2e.mjs`,
    source: "if (x) {\n  console.log('SKIP real PG17 guard probe');\n  process.exit(77);\n}\n",
  };
  assert.equal(e2eSkipExitCodeTextMissing(silentProbe), true);
  assert.throws(
    () => assertSkipUses77({ entries: [silentProbe] }),
    /guard-probe-skip-silent-e2e\.mjs/,
    '缺「EXITCODE=77」说明文字时必须红，且点名文件',
  );

  // ④ 不误伤：用例级 skip（node:test 的 `{ skip }`）不算整链跳过，本守卫不得因此变红。
  const caseLevelProbe = {
    fileName: `${INTEGRATION_DIR}/guard-probe-case-level-skip-http.mjs`,
    source: "test('SKIP AC08 真实审核供应商批准路径', { skip: '需要真实凭据' }, () => {});\n",
  };
  assert.equal(skipOutputIndexes(caseLevelProbe.source).length, 0, '用例级 skip 不是整链跳过');
  assertSkipUses77({ entries: [caseLevelProbe] });

  // ⑤ 不误伤：根本没有 skip 分支的脚本。
  assertSkipUses77({ entries: [{ fileName: `${INTEGRATION_DIR}/guard-probe-no-skip-http.mjs`, source: 'console.log("PASS");\n' }] });
});

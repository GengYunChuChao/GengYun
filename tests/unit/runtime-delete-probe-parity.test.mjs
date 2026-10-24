/**
 * R34 片 3（#19 / #10）：**运行期 DELETE 权限面的探针防漂移闸门**。
 *
 * 为什么需要它：运行时的表级 DELETE 面被三份文件共同描述，任何一份单独改动都会产生「单测全绿、
 * 真库却不对」的第三种漂移：
 *   1. 授权面 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `GRANT DELETE ON public.<t>`；
 *   2. 探针面 `deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 的**正向** DELETE 语句
 *      （`DELETE … WHERE false`，必须真能跑通 ⇒ 证明「授了、也确实能用」）；
 *   3. 同一个探针文件的**禁止面** DELETE 语句（同样是 `WHERE false`，但必须 42501 ⇒
 *      证明「没授的表一行都删不掉」）。
 *
 * 本片新增两条正向探针（`ocr_jobs` / `ocr_records`，用户 2026-10-24 批准的表级 DELETE 例外）时，
 * 禁止面**一条未增**，所以 `.github/workflows/deploy-sql-gate.yml` 的 `expected_42501` 仍是 18
 * （该常量由 `tests/unit/deploy-sql-gate-probe.test.mjs` 测试⑥ 对「探针源码数出来的禁止面条数」钉死）。
 *
 * 钉住的四件事（全部按**实测**表名与张数写死，⛔ 不用 `>=` / `includes` 这种能悄悄放过的写法）：
 *   ⓐ 正向 DELETE 对象集合 = 13 张表；ⓑ 禁止面 DELETE 对象集合 = 5 张表；ⓒ 两者互斥、并集 = 18 个对象；
 *   ⓓ 正向集合 ⊆ `20-login-roles.sql` 实际授出的 16 张表，禁止面与实际授出**零交集**。
 * 另外记下既有事实：16 张授权表里有 3 张（`media_derivatives` / `media_object_cleanup` / `messages`）
 * 本片之前就没有 DELETE 探针，本片不改变这一点 —— 写死成差集，避免它被误当成「探针已全覆盖」。
 *
 * 纯静态：只 `readFileSync` 读三份文本，⛔ 不连库、不 spawn、不 import 兄弟测试（会把那边的 test 注册进本进程）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROBE_SQL = 'deploy/postgres-cvm/evidence/probe-runtime-grants.sql';
const ROLES_SQL = 'deploy/postgres-cvm/sql/20-login-roles.sql';
const ASSERT_SQL = 'deploy/postgres-cvm/sql/90-assert-least-privilege.sql';

/** 探针里「应当成功」的 DELETE 对象：13 张（本片新增 `ocr_records` / `ocr_jobs`）。 */
const EXPECTED_POSITIVE = Object.freeze([
  'community_idempotency', 'community_likes', 'conversation_turns', 'conversations',
  'favorites', 'favorites_idempotency', 'history', 'history_idempotency',
  'ocr_idempotency', 'ocr_jobs', 'ocr_records', 'recognition_idempotency', 'speech_idempotency',
]);

/** 探针里「必须 42501」的 DELETE 对象：5 张（识别三表 + 语音两表；只由注销级联，运行时不授 DELETE）。 */
const EXPECTED_DENY = Object.freeze([
  'recognition_jobs', 'recognition_records', 'recognition_selections',
  'speech_jobs', 'transcriptions',
]);

/** `20-login-roles.sql` 实际授出的表级 DELETE：16 张。 */
const EXPECTED_GRANTED = Object.freeze([
  'community_idempotency', 'community_likes', 'conversation_turns', 'conversations',
  'favorites', 'favorites_idempotency', 'history', 'history_idempotency',
  'media_derivatives', 'media_object_cleanup', 'messages',
  'ocr_idempotency', 'ocr_jobs', 'ocr_records', 'recognition_idempotency', 'speech_idempotency',
]);

/** 已授权、但探针没有 DELETE 语句的 3 张表（本片之前的既有状态；改动它必须改本行并说明理由）。 */
const GRANTED_WITHOUT_PROBE = Object.freeze(['media_derivatives', 'media_object_cleanup', 'messages']);

/** 90-assert 里内联的同形正向探针（`SET LOCAL ROLE` 之后、SAVEPOINT 里逐条真跑）：6 张表。 */
const EXPECTED_ASSERT_PROBES = Object.freeze([
  'community_idempotency', 'community_likes', 'idempotency_keys',
  'ocr_idempotency', 'ocr_jobs', 'ocr_records',
]);

function readRepoText(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 把探针源码拆成「每条 `DELETE FROM public.<表>` 语句 + 它属于正向面还是禁止面」。
 *
 * 归属判定只看**探针自己的段落话术**（不靠硬编码表名，否则就成了循环论证）：
 *   * `\echo '-- [<表>] …'` 这类对象标记行 ⇒ 回到正向面；
 *   * `\echo '-- 以下是禁止面…'` ⇒ 进入禁止面。
 * 每段禁止面都以自己的一句「以下是禁止面」开头、且内部不再出现对象标记行，
 * 所以「最近一次遇到的标记」就是该语句的归属。
 */
function classifyProbeDeletes(source) {
  const lines = source.split('\n');
  const statements = [];
  let inDeny = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\\echo\s+'--\s*\[/.test(line)) inDeny = false;
    if (line.includes('以下是禁止面')) inDeny = true;
    const head = /^\s*DELETE FROM public\.(\w+)/.exec(line);
    if (!head) continue;
    // 语句可能跨行（长 WHERE）：收集到本行或后续行出现分号为止。
    let text = line;
    let cursor = index;
    while (!text.includes(';') && cursor + 1 < lines.length) {
      cursor += 1;
      text += `\n${lines[cursor]}`;
    }
    statements.push({ table: head[1], deny: inDeny, text: text.trim(), line: index + 1 });
  }
  return statements;
}

/** 零行判据：探针的写语句必须带 `WHERE false`（否则就不是「零行探针」而是真删）。 */
function nonZeroRowDeletes(statements) {
  return statements
    .filter((statement) => !/\bWHERE\s+false\b/i.test(statement.text))
    .map((statement) => `${statement.table}（第 ${statement.line} 行）`);
}

/** 从 `20-login-roles.sql` 数出实际授出的表级 DELETE 表名（按授权文本，不读注释）。 */
function grantedDeleteTables(source) {
  const tables = new Set();
  for (const match of source.matchAll(/^\s*GRANT DELETE ON public\.(\w+) TO gengyun_api_runtime;\s*$/gm)) {
    tables.add(match[1]);
  }
  return [...tables].sort();
}

/** 从 `90-assert-least-privilege.sql` 数出内联正向 DELETE 探针的表名。 */
function assertInlineProbes(source) {
  const tables = new Set();
  for (const match of source.matchAll(/^\s*DELETE FROM public\.(\w+) WHERE false;\s*$/gm)) {
    tables.add(match[1]);
  }
  return [...tables].sort();
}

const PROBE_SOURCE = readRepoText(PROBE_SQL);
const ROLES_SOURCE = readRepoText(ROLES_SQL);
const ASSERT_SOURCE = readRepoText(ASSERT_SQL);
const PROBE_STATEMENTS = classifyProbeDeletes(PROBE_SOURCE);

test('① 探针的正向 DELETE 对象恰好 13 张（本片新增 ocr_records / ocr_jobs）', () => {
  const positive = [...new Set(PROBE_STATEMENTS.filter((s) => !s.deny).map((s) => s.table))].sort();
  assert.deepEqual(positive, [...EXPECTED_POSITIVE],
    '正向 DELETE 对象集合变了：加一条 `DELETE FROM public.<表> WHERE false` 就要同步本清单，'
    + '否则「哪些表真能删」这件事会没有唯一出处');
  assert.ok(positive.includes('ocr_records') && positive.includes('ocr_jobs'),
    'R34 片 3 的两条正向探针（ocr_records / ocr_jobs）必须都在正向面');
});

test('② 探针的禁止面 DELETE 对象恰好 5 张（识别三表 + 语音两表），且一条未增', () => {
  const deny = [...new Set(PROBE_STATEMENTS.filter((s) => s.deny).map((s) => s.table))].sort();
  assert.deepEqual(deny, [...EXPECTED_DENY],
    '禁止面 DELETE 对象集合变了：这会直接改变 `expected_42501`（workflow 常量由 '
    + 'tests/unit/deploy-sql-gate-probe.test.mjs 测试⑥ 与探针源码逐条对账），必须成对改并说明理由');
});

test('③ 正向 ∪ 禁止面 = 18 个对象，两者互斥；每条都是零行探针（WHERE false）', () => {
  const positive = new Set(PROBE_STATEMENTS.filter((s) => !s.deny).map((s) => s.table));
  const deny = new Set(PROBE_STATEMENTS.filter((s) => s.deny).map((s) => s.table));
  const overlap = [...positive].filter((table) => deny.has(table)).sort();
  assert.deepEqual(overlap, [], `同一张表不得既是正向面又是禁止面：${overlap.join(' / ')}`);
  const union = [...new Set([...positive, ...deny])].sort();
  assert.equal(union.length, 18, `DELETE 探针覆盖的对象数是 ${union.length}，实测口径为 18（13 正向 + 5 禁止）`);
  assert.deepEqual(union, [...new Set([...EXPECTED_POSITIVE, ...EXPECTED_DENY])].sort(),
    '并集与两份清单的并集不一致 ⇒ 有一边漏项或多出未登记的对象');
  assert.deepEqual(nonZeroRowDeletes(PROBE_STATEMENTS), [],
    '探针里出现了不带 `WHERE false` 的 DELETE：那会真的删数据（探针必须可反复跑、零行）');
});

test('④ 正向面 ⊆ 20-login-roles.sql 实授的 16 张表；禁止面与实授零交集', () => {
  const granted = grantedDeleteTables(ROLES_SOURCE);
  assert.deepEqual(granted, [...EXPECTED_GRANTED],
    '`20-login-roles.sql` 的表级 DELETE 清单变了（本片改了两张表：ocr_jobs / ocr_records）');
  const positive = [...new Set(PROBE_STATEMENTS.filter((s) => !s.deny).map((s) => s.table))].sort();
  const deny = [...new Set(PROBE_STATEMENTS.filter((s) => s.deny).map((s) => s.table))].sort();
  const missingGrant = positive.filter((table) => !granted.includes(table)).sort();
  assert.deepEqual(missingGrant, [],
    `这些表有「应当成功」的 DELETE 探针，但 20-login-roles.sql 并没有授 DELETE：${missingGrant.join(' / ')} `
    + '（正探针等于在证明一条并不存在的授权，真库会红）');
  const denyGranted = deny.filter((table) => granted.includes(table)).sort();
  assert.deepEqual(denyGranted, [],
    `这些表既有 GRANT DELETE 又在禁止面：${denyGranted.join(' / ')}（禁止面会失效，42501 不再出现）`);
  const unprobed = granted.filter((table) => !positive.includes(table)).sort();
  assert.deepEqual(unprobed, [...GRANTED_WITHOUT_PROBE],
    '已授权但没有 DELETE 探针的表清单变了：本片不新增这类缺口，若确要新增必须显式登记到 GRANTED_WITHOUT_PROBE');
});

test('⑤ 90-assert 的内联正向探针恰好 6 张（本片补 ocr_records / ocr_jobs）', () => {
  const inline = assertInlineProbes(ASSERT_SOURCE);
  assert.deepEqual(inline, [...EXPECTED_ASSERT_PROBES],
    '`90-assert` 的 `DELETE … WHERE false` 探针清单变了：变量名与断言 45 的复述必须成对改');
  // 变量与断言复述成对：每条内联探针都要有自己的 :ERROR 变量，并真的被断言 45 引用。
  const missingVariable = EXPECTED_ASSERT_PROBES.filter(
    (table) => !ASSERT_SOURCE.includes(`\\set r28_probe_del_${table} :ERROR`),
  );
  assert.deepEqual(missingVariable, [], `这些探针缺 :ERROR 变量记录：${missingVariable.join(' / ')}（断言 45 会读不到）`);
  const missingAssertion = EXPECTED_ASSERT_PROBES.filter(
    (table) => !ASSERT_SOURCE.includes(`:'r28_probe_del_${table}' = 'false'`),
  );
  assert.deepEqual(missingAssertion, [], `这些探针没被断言 45 复述：${missingAssertion.join(' / ')}（探针失败会静默过去）`);
});

test('⑥ 反向变异自证：解析器真的抓得住「少一条正探针」与「正探针不再是零行」', () => {
  // 变异 1：删掉 ocr_jobs 的正向探针 ⇒ 正向集合少一项（单测必须红）。
  const dropped = PROBE_SOURCE.replace('DELETE FROM public.ocr_jobs WHERE false;\n', '');
  const droppedPositive = [...new Set(classifyProbeDeletes(dropped).filter((s) => !s.deny).map((s) => s.table))].sort();
  assert.deepEqual(
    EXPECTED_POSITIVE.filter((table) => !droppedPositive.includes(table)),
    ['ocr_jobs'],
    '删掉 ocr_jobs 的正向探针后，解析器必须恰好点名 ocr_jobs（否则这条闸门抓不住漏项）',
  );

  // 变异 2：把 ocr_records 的正探针从「零行」改成「真删已有行」的形状 ⇒ 零行判据必须点名它。
  const destructive = PROBE_SOURCE.replace(
    'DELETE FROM public.ocr_records WHERE false;',
    'DELETE FROM public.ocr_records WHERE id IS NOT NULL RETURNING id;',
  );
  const offenders = nonZeroRowDeletes(classifyProbeDeletes(destructive));
  assert.deepEqual(
    offenders.map((entry) => entry.replace(/（第 \d+ 行）$/, '')),
    ['ocr_records'],
    '把正探针改成不带 `WHERE false` 的 DELETE 后，零行判据必须恰好点名 ocr_records',
  );

  // 变异 3：把 ocr_jobs 的 GRANT 行删掉 ⇒ 正探针变成「证明一条不存在的授权」，必须点名。
  const noGrant = ROLES_SOURCE.replace('GRANT DELETE ON public.ocr_jobs TO gengyun_api_runtime;\n', '');
  const grantedAfter = grantedDeleteTables(noGrant);
  const positiveAfter = [...new Set(classifyProbeDeletes(PROBE_SOURCE).filter((s) => !s.deny).map((s) => s.table))].sort();
  assert.deepEqual(
    positiveAfter.filter((table) => !grantedAfter.includes(table)),
    ['ocr_jobs'],
    '删掉 GRANT DELETE 行后，正向面必须恰好点名 ocr_jobs 失去授权',
  );
});

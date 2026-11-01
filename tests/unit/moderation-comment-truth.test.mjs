/**
 * R72-W46 · 审核域**持久台账**陈旧注释「真话化」的钉线回归（**纯注释、零行为改动**）。
 *
 * 被修的东西：`ledger-pg.ts` / `service.ts` / `90-assert-least-privilege.sql` 里还留着两套旧叙述——
 *   ① 「重启后一条迟到的旧回调就能把已下架的版本重新翻成 `published`」；
 *   ② 「台账只写不读」（对 `moderation_decisions` 仍真，对 `moderation_withdrawals` 自 W43 起已成假话）。
 *
 * 事实（W45 `#825` 与本机真库臂 `[R2]` 实测）：重启后迟到回调在 `service.ts:1260` 就先
 * `ledger.byJobId(...)`、取不到 ⇒ `:1261` 以 `CALLBACK_JOB_UNKNOWN` 拒，`:1287` 的
 * `CALLBACK_TARGET_WITHDRAWN` 在那个窗口**不可达**；真正可达的风险是**发布闸门** `:939` 读
 * `ledger.isWithdrawn`（`#825` 的处置是发布前先 `flushLedger()`）。
 *
 * 本文件判七件事：
 *   T1 `ledger-pg.ts` 的旧断言删除、新事实（`:939` / `:1260` `CALLBACK_JOB_UNKNOWN`）在位；
 *   T2 `service.ts:1059`（±1 行内）说的是 `publish` 的 `:939` 闸门，不再是「旧回调复活内容」；
 *   T3 `90-assert:454-455` 把「只写不读」限定到 `moderation_decisions`、点明 withdrawals 的 W43 回填；
 *      `1510` 行同样限定，不再把两张表一起概括成「台账只写不读」；
 *   T4 防误伤：`jobs/ledger.ts:45` 的「只写不读」是**作业台账** `public.jobs` 的真话，不许被顺手改；
 *   T5 零漂移：四个被改文件的行数与基线逐字相等（插入行 === 删除行）；
 *   T6 负向自检：每条「不得包含」常量都在本文件里被真正 `includes(...) === false` 判过一次（防空跑）；
 *   T7 `moderation-withdraw-hydration.test.mjs` 头注释的旧结论同样改成「发布闸门 `:939`」。
 *
 * 声明：**纯静态**读文件文本、逐行断言（不用正则跨行匹配整段，避免脆弱）；不连库、不连网、
 * 不跑 git。判的是「注释说了真话」，不是行为——行为面由 `moderation-*.test.mjs` 那几支负责。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const LEDGER_PG = 'services/api/src/moderation/ledger-pg.ts';
const SERVICE = 'services/api/src/moderation/service.ts';
const ASSERT_SQL = 'deploy/postgres-cvm/sql/90-assert-least-privilege.sql';
const JOBS_LEDGER = 'services/api/src/jobs/ledger.ts';
const HYDRATION_TEST = 'tests/unit/moderation-withdraw-hydration.test.mjs';

/** 全文（UTF-8）。 */
function source(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 逐行（`split('\n')`，空文件返回 `['']`）。 */
function sourceLines(rel) {
  return source(rel).split('\n');
}

/** 行数（与派单同一算法：`split('\n').length - 1`）。 */
function lineCount(rel) {
  return sourceLines(rel).length - 1;
}

/** 1-based 取一行。 */
function lineAt(rel, lineNo) {
  return sourceLines(rel)[lineNo - 1];
}

/** 1-based 取 `lineNo` 前后各 `pad` 行拼起来（默认 ±1）。 */
function windowAt(rel, lineNo, pad = 1) {
  return sourceLines(rel)
    .slice(lineNo - 1 - pad, lineNo + pad)
    .join('\n');
}

/**
 * 旧机制叙述的**逐字**原话（三条是「不得再出现」，都是从基线 `e59973d3` 上抄下来的，不是编的）。
 * `T6` 把这张表逐条再判一次，防的是「常量写了却没人判」的空跑。
 */
const STALE_LEDGER_CALLBACK = '一条迟到的旧回调就能把已下架的版本重新翻成';
const STALE_SERVICE_REVIVE = '旧回调就能把内容复活';
const STALE_SQL_BLANKET = '台账只写不读，';
const STALE_HYDRATION_ROLLBACK = '一条迟到的旧回调可以把已下架的版本重新翻成';

const NEGATIVE_CASES = [
  { label: 'ledger-pg.ts 的「旧回调复活」旧叙述', file: LEDGER_PG, text: STALE_LEDGER_CALLBACK },
  { label: 'service.ts 的「旧回调复活内容」旧叙述', file: SERVICE, text: STALE_SERVICE_REVIVE },
  { label: '90-assert 把两张表一起概括成「台账只写不读」', file: ASSERT_SQL, text: STALE_SQL_BLANKET },
  { label: 'hydration 头注释的「旧回调重翻 published」旧结论', file: HYDRATION_TEST, text: STALE_HYDRATION_ROLLBACK },
];

test('T1 ledger-pg.ts：旧叙述删除，风险落在发布闸门 `:939`、回调闸门被 `:1260` 的 CALLBACK_JOB_UNKNOWN 挡住', () => {
  const text = source(LEDGER_PG);

  assert.ok(
    text.includes(STALE_LEDGER_CALLBACK) === false,
    `ledger-pg.ts 仍在断言「${STALE_LEDGER_CALLBACK}」——重启后的风险不在回调闸门`,
  );

  // 必须出现的事实（缺一条就说明这次改写丢事实，而不是"写短了"）
  const required = [
    ['CALLBACK_JOB_UNKNOWN', '回调闸门在重启窗口被作业结论缺失拒掉的那条码'],
    ['service.ts:1260', '`ledger.byJobId(...)` 那一行'],
    ['939', '真正可达的发布闸门'],
    ['#825', '`#825` 的处置（发布前先 `flushLedger()`）'],
    ['TARGET_WITHDRAWN', '发布闸门的理由码'],
    ['CALLBACK_TARGET_WITHDRAWN', '回调闸门的理由码（说明它在该窗口不可达）'],
  ];
  for (const [fact, why] of required) {
    assert.ok(text.includes(fact), `ledger-pg.ts 必须出现 \`${fact}\`（${why}）`);
  }

  // 下架标记的定性不许被削成"缓存"：终态、只增不减
  assert.ok(text.includes('终态'), 'ledger-pg.ts 必须仍把下架标记定性为**终态**');
  // 回填的读面（三列）与它的授权来源仍要在位
  assert.ok(text.includes('`hydrate()` 只读三列'), 'ledger-pg.ts 必须仍落到「hydrate() 只读三列」');
});

test('T2 service.ts:1059（±1 行）：讲的是 `publish` 的 `:939` 闸门，不是「旧回调复活内容」', () => {
  const text = source(SERVICE);
  assert.ok(
    text.includes(STALE_SERVICE_REVIVE) === false,
    `service.ts 仍在断言「${STALE_SERVICE_REVIVE}」`,
  );

  const pinned = lineAt(SERVICE, 1059);
  assert.ok(pinned.trim().startsWith('// 下架标记同样要落定'), `service.ts:1059 已漂移：${pinned}`);

  const context = windowAt(SERVICE, 1059);
  assert.ok(context.includes('publish'), 'service.ts:1059 附近必须点名受影响的 `publish`');
  assert.ok(context.includes('939'), 'service.ts:1059 附近必须点名 `:939` 闸门');
  assert.ok(context.includes('CALLBACK_JOB_UNKNOWN'), 'service.ts:1059 附近必须点明回调路径更早被挡的那条码');
});

test('T3 90-assert：只写不读限定到 moderation_decisions；withdrawals 三列 SELECT 另有 W43 回填用途', () => {
  const text = source(ASSERT_SQL);
  assert.ok(
    text.includes(STALE_SQL_BLANKET) === false,
    `90-assert 仍把两张表一起概括成「${STALE_SQL_BLANKET}」`,
  );
  // 同一句概括换个说法（无全角逗号）也不许回来
  assert.ok(
    !/台账只写不读/.test(text),
    '90-assert 仍在用「台账只写不读」概括两张表',
  );

  // 454-455：探针那段话必须点名 decisions 仍只写不读 + withdrawals 的 W43 读回，且探针仍是**写**语句
  const probeHead = sourceLines(ASSERT_SQL).slice(453, 455).join('\n');
  assert.ok(probeHead.includes('moderation_decisions'), '454-455 必须点名单张表 moderation_decisions');
  assert.ok(
    probeHead.includes('W43') || probeHead.includes('回填'),
    '454-455 必须点明 moderation_withdrawals 自 W43 起被读回（回填）',
  );
  assert.ok(probeHead.includes('**写**'), '454-455 必须仍说明三条探针是**写**语句（形状逐字对着 ledger-pg.ts 抄）');

  // 1510-1511：列清单那段话必须点名 decisions，且 withdrawals 的三列 SELECT 另有用途
  assert.ok(lineAt(ASSERT_SQL, 1510).includes('moderation_decisions'), '1510 行必须点名 moderation_decisions');
  const columnBlock = sourceLines(ASSERT_SQL).slice(1509, 1511).join('\n');
  assert.ok(columnBlock.includes('moderation_withdrawals'), '1510-1511 必须点名 moderation_withdrawals');
  assert.ok(
    columnBlock.includes('W43') || columnBlock.includes('回填'),
    '1510-1511 必须说明 withdrawals 的三列 SELECT 另有用途（W43 回填）',
  );
  assert.ok(columnBlock.includes('6 列'), '1510-1511 必须仍解释 decisions 那 6 列读权的来源');
});

test('T4 防误伤：jobs/ledger.ts:45 的「只写不读」是作业台账 public.jobs 的真话，本片不动它', () => {
  const text = source(JOBS_LEDGER);
  assert.ok(text.includes('只写不读'), 'jobs/ledger.ts 必须仍写着「只写不读」——那是作业台账，仍为真');

  const pinned = lineAt(JOBS_LEDGER, 45);
  assert.ok(pinned.includes('**只写不读**'), `jobs/ledger.ts:45 已漂移：${pinned}`);
  assert.ok(pinned.includes('本片不改任何既有读面'), `jobs/ledger.ts:45 的限定语已漂移：${pinned}`);
});

test('T5 零漂移：四个被改文件的行数逐字相等（插入行 === 删除行）', () => {
  assert.equal(lineCount(LEDGER_PG), 546, 'ledger-pg.ts 行数变了 —— 本片是纯注释改写，必须 546');
  assert.equal(lineCount(SERVICE), 1450, 'service.ts 行数变了 —— 必须 1450');
  assert.equal(lineCount(ASSERT_SQL), 4443, '90-assert-least-privilege.sql 行数变了 —— 必须 4443');
  assert.equal(lineCount(HYDRATION_TEST), 170, 'moderation-withdraw-hydration.test.mjs 行数变了 —— 必须 170');
});

test('T6 负向自检：每条「不得包含」常量都真的被判过一次（防空跑）', () => {
  assert.equal(NEGATIVE_CASES.length, 4, '负向常量表条数变了：T1/T2/T3/T7 与它对不上');

  for (const item of NEGATIVE_CASES) {
    assert.ok(typeof item.text === 'string' && item.text.length >= 6, `负向常量「${item.label}」是空的`);
    assert.ok(item.text.isWellFormed(), `负向常量「${item.label}」含孤立代理项`);
    const text = source(item.file);
    // 这一句就是本片的判据本体：常量必须真的被判、且真的不在（写成空跑就判不出来）
    assert.ok(
      text.includes(item.text) === false,
      `「${item.label}」仍出现在 ${item.file}`,
    );
  }
});

test('T7 hydration 测试头注释：旧结论改成「发布闸门 `:939`」，回调路径被 CALLBACK_JOB_UNKNOWN 先挡', () => {
  const text = source(HYDRATION_TEST);
  assert.ok(
    text.includes(STALE_HYDRATION_ROLLBACK) === false,
    `moderation-withdraw-hydration.test.mjs 仍在断言「${STALE_HYDRATION_ROLLBACK}」`,
  );

  // 4-7 行：保留「内层是新的内存台账、只写库不读库 ⇒ 重启后 isWithdrawn 恒 false」这半段事实
  const header = sourceLines(HYDRATION_TEST).slice(3, 7).join('\n');
  assert.ok(header.includes('`markWithdrawn` 只写库'), '4-7 行必须保留「只写库」这半段');
  assert.ok(header.includes('从不读库'), '4-7 行必须保留「从不读库」这半段');
  assert.ok(header.includes('一律答 `false`'), '4-7 行必须保留「重启后 isWithdrawn 恒 false」这半段');
  // 结论换成真正可达的那道闸门，并点明回调路径更早被挡
  assert.ok(header.includes('939'), '4-7 行必须点明发布闸门 `:939`');
  assert.ok(header.includes('#825'), '4-7 行必须点明 `#825` 的处置（发布前先 `flushLedger()`）');
  assert.ok(header.includes('CALLBACK_JOB_UNKNOWN'), '4-7 行必须点明回调路径更早被 `CALLBACK_JOB_UNKNOWN` 挡住');
});

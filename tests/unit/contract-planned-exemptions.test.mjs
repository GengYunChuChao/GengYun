// R28-S73 · planned operation 零证据登记守卫。
//
// 为什么需要这一层：`tools/verify-contract-status.mjs:127` 已经**反向**钉死了
// `planned ⇒ evidence.length === 0`（planned 必须没有证据，非 planned 必须有证据），
// 所以「某个契约操作一条证据都没有」这件事在 planned 上是合法形态、永远不会变红。
// 本测试补的正是这条缝：**planned 的零证据不得无登记**，且每条登记必须指向真实可核的计划依据。
//
// 口径：
//   ① evidence 为空的操作 ⇒ 必须 status==='planned' 且逐字登记在 PLANNED_EXEMPT；
//   ② PLANNED_EXEMPT 的每个键 ⇒ 必须在台账中存在、仍是 planned、证据仍为空（陈旧/错位即红）；
//   ③ 每条登记的 plan_ref ⇒ path 真实存在、lines 在界内、symbol 在该区间（容差 ±2 行）内逐字出现；
//   ④ evidence 非空的操作 ⇒ 至少要有一条带锚（symbol/anchor/name），只有 path 的「弱锚」按无锚计。
//
// 计划证据 ≠ 实现证据：plan_ref 只证明「这条 operation 有契约/需求/领域层依据」，
// 不证明 HTTP 实现存在。状态为人工判定，本测试不替它背书。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATUS_FILE = 'docs/architecture/contract-status.json';
// 与 tools/verify-contract-status.mjs 的 ANCHOR_TOLERANCE 同口径：区间裁掉声明行后的空行/注释属常见形态。
const ANCHOR_TOLERANCE = 2;

// 空豁免表：planned operation 的零证据登记当前为 **0 条**，条数同样钉死（0 就是 0）——
// 新增/删除都必须改这里并在证据页留痕。owner 取自主仓库任务台账（docs/initial-issues.json）的
// 责任项；why 说明为什么只能给计划证据。
//
// 并集推导（#561 与 #563 合流后实测，`upstream/main` 18f2b913 × 本分支 ab9bbd9f）：
//   基座 9669aa8a ＝ 2 条空证据 planned 操作 [listSpecies, verifyRegistration]
//   − #561（GY-I04）把 verifyRegistration 装配成 `partial`（10 条实现证据）并移出豁免表
//   − #563（GY-I07）把 listSpecies 装配成 `implemented`（4 条实现证据）并移出豁免表
//   ＝ **并集 0 条**
// 两片各自只删自己那一条、各自把钉死的条数改写成 1（这两处改动逐字相同 ⇒ git 不报冲突），
// 所以谁后合，谁的断言就会从「期望 1 / 实际 1」变成「期望 1 / 实际 0」⇒ `unit-tests` 必红。
// 本表随之清空：守卫规则不变（空证据 ⇒ 必须 planned 且已登记），只是当前没有需要登记的项。
const PLANNED_EXEMPT = Object.freeze({});

const readText = path => readFileSync(resolve(ROOT, path), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const evidenceOf = entry => (Array.isArray(entry.evidence) ? entry.evidence : []);
const label = entry => entry.id ?? `${entry.method} ${entry.path}`;
// 锚点三选一：symbol / anchor 同义，test 引用的 name 本身就是用例名锚点。
const hasAnchor = item => ['symbol', 'anchor', 'name'].some(key => typeof item[key] === 'string' && item[key].trim() !== '');
const occurrences = (text, value) => {
  const hits = [];
  for (let index = text.indexOf(value); index !== -1; index = text.indexOf(value, index + 1)) {
    hits.push(text.slice(0, index).split('\n').length);
  }
  return hits;
};

function planRefViolations(id, entry) {
  const violations = [];
  if (typeof entry?.owner !== 'string' || entry.owner.trim() === '') violations.push(`${id}: 豁免登记缺 owner`);
  if (typeof entry?.why !== 'string' || entry.why.trim() === '') violations.push(`${id}: 豁免登记缺 why`);
  const ref = entry?.plan_ref;
  if (ref === null || typeof ref !== 'object') { violations.push(`${id}: 豁免登记缺 plan_ref`); return violations; }
  if (typeof ref.path !== 'string' || ref.path.trim() === '') { violations.push(`${id}: plan_ref.path 必须是非空字符串`); return violations; }
  if (typeof ref.symbol !== 'string' || ref.symbol.trim() === '') violations.push(`${id}: plan_ref.symbol 必须是非空字符串`);
  const match = /^(\d+)-(\d+)$/.exec(typeof ref.lines === 'string' ? ref.lines : '');
  if (match === null) { violations.push(`${id}: plan_ref.lines 必须是 起-止`); return violations; }
  const absolute = resolve(ROOT, ref.path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) { violations.push(`${id}: plan_ref.path 不是仓内文件 ${ref.path}`); return violations; }
  const text = readFileSync(absolute, 'utf8');
  const total = text.split('\n').length;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from < 1 || to < from || to > total) { violations.push(`${id}: ${ref.path} plan_ref.lines=${ref.lines} 越界（文件 ${total} 行）`); return violations; }
  if (typeof ref.symbol === 'string' && ref.symbol.trim() !== '') {
    if (!text.includes(ref.symbol)) { violations.push(`${id}: ${ref.path} 中找不到 plan_ref.symbol「${ref.symbol}」`); return violations; }
    const hits = occurrences(text, ref.symbol);
    if (!hits.some(line => from - ANCHOR_TOLERANCE <= line && line <= to + ANCHOR_TOLERANCE)) {
      violations.push(`${id}: plan_ref.symbol「${ref.symbol}」出现在第 ${hits.slice(0, 5).join('、')} 行，不在引用区间 ${ref.lines}（容差 ±${ANCHOR_TOLERANCE} 行）`);
    }
  }
  return violations;
}

/** 纯函数：台账 + 豁免表 ⇒ 违规清单。夹具只改入参，断言与正控制走同一条路径。 */
export function audit(ledger, exemptions = PLANNED_EXEMPT) {
  const violations = [];
  const operations = Array.isArray(ledger?.operations) ? ledger.operations : [];
  for (const entry of operations) {
    const id = label(entry);
    const items = evidenceOf(entry);
    if (items.length === 0) {
      if (entry.status !== 'planned') violations.push(`${id}: evidence 为空但状态是 ${entry.status}（只有 planned 允许登记豁免）`);
      else if (!Object.hasOwn(exemptions, id)) violations.push(`${id}: evidence 为空且未在 PLANNED_EXEMPT 登记`);
      continue;
    }
    if (!items.some(hasAnchor)) {
      violations.push(`${id}: ${items.length} 条证据全部无锚（symbol/anchor/name 皆缺；只有 path 的弱锚按无锚计）`);
    }
  }
  for (const [id, entry] of Object.entries(exemptions)) {
    const operation = operations.find(candidate => candidate.id === id);
    if (operation === undefined) { violations.push(`PLANNED_EXEMPT 登记的 ${id} 在台账中不存在（陈旧或错位登记）`); continue; }
    if (operation.status !== 'planned') violations.push(`PLANNED_EXEMPT 登记的 ${id} 状态是 ${operation.status}，不是 planned（陈旧登记）`);
    if (evidenceOf(operation).length !== 0) violations.push(`PLANNED_EXEMPT 登记的 ${id} 已有 ${evidenceOf(operation).length} 条证据，登记已陈旧`);
    violations.push(...planRefViolations(id, entry));
  }
  return violations;
}

const ledger = JSON.parse(readText(STATUS_FILE));

test('f4 正控制：仓内台账与空豁免表自洽（0 违规 / 空证据 0 条）', () => {
  assert.deepEqual(audit(ledger), []);
  // 守卫自身的反向断言：扫空台账/扫空集合都能「很绿」，所以先钉住扫描面。
  assert.ok(ledger.operations.length > 100, `解析出的 operations 只有 ${ledger.operations.length} 条，疑似读错台账`);
  const emptyEvidence = ledger.operations.filter(entry => evidenceOf(entry).length === 0);
  const emptyEvidenceIds = emptyEvidence.map(entry => entry.id);
  // 并集 = 0 之后，「空证据集合为空：守卫没扫到任何 planned 缺口」这句话没有作用面了，
  // 所以判据不能靠「长度 > 0」维持强度，改为**双向钉死**：空证据集合与空豁免表必须同时成立。
  //   ① 台账里再冒出空证据操作 ⇒ 那就是新的 planned 零证据缺口（audit 已红，这里再点名）；
  //   ② 豁免表留着旧条目 ⇒ 每条都会被判陈旧登记（audit 已红，这里同样点名）。
  // 两条合起来就是「空证据 ⇔ 已登记」在并集态下的唯一合法解：等价于原判据，不是放宽。
  assert.deepEqual(emptyEvidenceIds, [], `空证据操作应恰为 0 条（并集 = 0）；实测 ${emptyEvidence.length} 条：${emptyEvidenceIds.join('、')}`);
  assert.deepEqual(
    Object.keys(PLANNED_EXEMPT),
    [],
    `空证据集合为空时 PLANNED_EXEMPT 必须为空表；实测仍有 ${Object.keys(PLANNED_EXEMPT).length} 条：${Object.keys(PLANNED_EXEMPT).join('、')}`,
  );
  assert.equal(
    Object.keys(PLANNED_EXEMPT).length,
    emptyEvidenceIds.length,
    '豁免登记条数必须等于空证据操作条数（并集 = 0 ⇒ 两边都为 0）',
  );
});

test('f1 新建空证据 operation 未登记 ⇒ 红在「未登记」', () => {
  const fixture = clone(ledger);
  fixture.operations.push({ id: 'fixtureUnregistered', method: 'get', path: '/fixture', status: 'planned', evidence: [] });
  const violations = audit(fixture);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0], /^fixtureUnregistered: evidence 为空且未在 PLANNED_EXEMPT 登记$/);
});

test('f2 豁免表登记台账不存在的键 ⇒ 红在「不存在」', () => {
  const exemptions = clone(PLANNED_EXEMPT);
  exemptions.ghostOperation = { owner: 'fixture', why: 'fixture', plan_ref: { path: 'packages/privacy/egress.mjs', lines: '402-404', symbol: 'listExportsForUser' } };
  const violations = audit(ledger, exemptions);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0], /^PLANNED_EXEMPT 登记的 ghostOperation 在台账中不存在/);
});

test('f3 plan_ref.symbol 写成不存在的串 ⇒ 红在「找不到」', () => {
  // 并集 = 0 后真实豁免表为空，「改某个真实键的 symbol」已无处可改（表里没有键）。
  // 改为夹具：造一条 planned 空证据 operation ＋ 与之匹配的登记，只让 symbol 是假串，
  // 走的仍是 audit() 的同一条路径（不降级为直接调内部函数），报错文案逐字不变。
  const fixture = clone(ledger);
  fixture.operations.push({ id: 'fixturePlanRef', method: 'get', path: '/fixture', status: 'planned', evidence: [] });
  const exemptions = clone(PLANNED_EXEMPT);
  exemptions.fixturePlanRef = {
    owner: 'fixture',
    why: 'fixture',
    plan_ref: { path: 'packages/reference/service.mjs', lines: '61-71', symbol: 'noSuchSymbolR28S73' },
  };
  const violations = audit(fixture, exemptions);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0], /中找不到 plan_ref\.symbol「noSuchSymbolR28S73」/);
});

test('f5 非空证据全是弱锚（只有 path）⇒ 红在「全部无锚」', () => {
  const fixture = clone(ledger);
  const target = fixture.operations.find(entry => evidenceOf(entry).length > 0);
  target.evidence = [{ path: 'package.json' }];
  const violations = audit(fixture);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.match(violations[0], new RegExp(`^${target.id}: 1 条证据全部无锚`));
});

test('plan_ref 落点与工具同口径：symbol 必须落在引用区间 ±2 行内', () => {
  // 并集 = 0 后真实豁免表为空，原「逐条遍历登记」会退化成零次迭代的恒真用例 ⇒
  // 改为对**真实仓内文件**跑正/负两次控制，判据（symbol 逐字落在区间、越界即红）逐字不变。
  const ref = { path: 'packages/reference/service.mjs', lines: '61-71', symbol: 'listSpecies' };
  assert.deepEqual(
    planRefViolations('fixturePlanRefOk', { owner: 'fixture', why: 'fixture', plan_ref: ref }),
    [],
    'fixturePlanRefOk 的 plan_ref 不可核',
  );
  const text = readText(ref.path);
  const from = Number(ref.lines.split('-')[0]);
  const to = Number(ref.lines.split('-')[1]);
  const hits = occurrences(text, ref.symbol);
  assert.ok(hits.some(line => line >= from && line <= to), `${ref.symbol} 未逐字落在 ${ref.lines} 内，实测第 ${hits.join('、')} 行`);
  // 负控制：把区间挪到 symbol 实际出现位置之外 ⇒ 必须判红（否则该判据对空表就是恒真）。
  const shifted = planRefViolations('fixturePlanRefShifted', {
    owner: 'fixture',
    why: 'fixture',
    plan_ref: { path: ref.path, lines: '1-3', symbol: ref.symbol },
  });
  assert.equal(shifted.length, 1, `区间挪到 1-3 后仍判绿：${shifted.join('\n')}`);
  assert.match(shifted[0], /不在引用区间 1-3/);
  // 真实表为空时上面这个遍历恒空集；表一旦有人加条目，仍会在这里被逐条核（保留原口径）。
  for (const [id, entry] of Object.entries(PLANNED_EXEMPT)) {
    assert.deepEqual(planRefViolations(id, entry), [], `${id} 的 plan_ref 不可核`);
  }
});

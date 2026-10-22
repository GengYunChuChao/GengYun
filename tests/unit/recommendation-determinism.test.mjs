// GY-I26（issue #26）· AI 推荐排序的确定性/可解释性回归：**只新增断言，不改既有断言**。
//
// 被测模块：services/api/src/recommendation/rank.ts（纯函数：无 IO、无环境变量、无网络）。
// 数据：仓库里**真实**的 `packages/knowledge/**` 结构，不另造数据结构。
//
// 本文件的断言分三类：
//   1) 契约类：确定性、同分稳定序、score = reasons 加权和、空输入、越权输入；
//   2) 安全类：剂量被忽略、免责口径过 risk-wording 守卫、不出现剂量数字；
//   3) 负控制伴随项：`排序契约` 那条把「score 降序 / 同分 id 升序」钉死——
//      把比较函数改成不倒序（升序）时它必红，改回即绿（一次性变异读数记在证据页）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RECOMMENDATION_DISCLAIMER,
  RECOMMENDATION_POLICY_VERSION,
  RECOMMENDATION_WEIGHTS,
  rankRecommendations,
} from '../../services/api/src/recommendation/rank.ts';
import { assertRiskWordingSafe } from '../../packages/reference/risk-wording.mjs';

/** 读仓库内的真实 JSON（只读，不复制常量，避免与仓库数据脱钩）。 */
function loadJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8'));
}

const RECORDS = loadJson('packages/knowledge/herbicides/records-2026.json').records;
const CROPS = loadJson('packages/knowledge/catalog/crops.json').crops;
const SPECIES = loadJson('packages/knowledge/catalog/species.json').species;

/** 统一调用形状：真实三段数据 + 查询。 */
function rank(query, records = RECORDS) {
  return rankRecommendations({ records, crops: CROPS, species: SPECIES, query });
}

function ids(result) {
  return result.items.map((item) => item.id);
}

function reasonsOf(item, factor) {
  return item.reasons.filter((reason) => reason.factor === factor);
}

/** 剂量数字的形状（克/毫升/亩/g/ml）：输出正文里一个都不许出现。 */
const DOSE_NUMBER = /\d+(?:\.\d+)?\s*(?:克|毫升|毫升\/亩|g|ml|亩)/i;

test('确定性：同一入参两次调用逐字节一致', () => {
  const query = { crop_id: 'crop_rice', symptoms: ['稗草'], keywords: ['莠去津', '水稻移栽田'] };
  const first = rank(query);
  const second = rank(query);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first, second);
  assert.equal(first.policy_version, RECOMMENDATION_POLICY_VERSION);
  assert.equal(first.disclaimer, RECOMMENDATION_DISCLAIMER);
});

test('同分稳定序：score 降序，同分按 id 升序（与记录传入顺序无关）', () => {
  const forward = rank({ crop_id: 'crop_rice', symptoms: ['稗草'] });
  const reversed = rank({ crop_id: 'crop_rice', symptoms: ['稗草'] }, [...RECORDS].reverse());

  assert.equal(forward.items.length, RECORDS.length);
  // 首条是唯一把「稗草」写进防治对象的水稻记录。
  assert.equal(forward.items[0].id, 'gy-i03-hb-006');
  assert.equal(forward.items[0].score, 81);

  // 水稻同分组的 id 升序：其余水稻记录同分，靠 id 定序。
  const riceIds = RECORDS.filter((record) => record.crop_ids.includes('crop_rice'))
    .map((record) => record.record_id)
    .filter((id) => id !== 'gy-i03-hb-006')
    .sort();
  assert.deepEqual(forward.items.slice(1, 1 + riceIds.length).map((item) => item.id), riceIds);
  const riceScores = forward.items.slice(1, 1 + riceIds.length).map((item) => item.score);
  assert.deepEqual(new Set(riceScores), new Set([51]));

  // 输入顺序反转后，输出必须**逐字节**相同（稳定性不依赖输入次序或 v8 排序细节）。
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test('分数 = 理由加权和（逐条求和相等，且权重取自公开权重表）', () => {
  const result = rank({ crop_id: 'crop_corn', symptoms: ['稗草'], keywords: ['莠去津', '玉米田'] });
  assert.ok(result.items.length > 0);
  for (const item of result.items) {
    const summed = item.reasons.reduce((total, reason) => total + reason.weight, 0);
    assert.equal(item.score, summed, `${item.id} 的 score 与 reasons 求和不一致`);
    assert.equal(Number.isInteger(item.score), true);
    for (const reason of item.reasons) {
      assert.equal(typeof reason.detail, 'string');
      assert.ok(reason.detail.length > 0);
    }
  }
  // 玉米记录：作物 40 + 证据 6 + 来源 10 - 未核对 5 = 51；命中「莠去津」「玉米田」两个关键词再 +20。
  const corn = result.items.find((item) => item.id === 'gy-i03-hb-007');
  assert.ok(corn);
  assert.equal(corn.score, 51 + 2 * RECOMMENDATION_WEIGHTS.keyword_match);
  assert.equal(reasonsOf(corn, 'keyword_match').length, 2);

  // 没有任何匹配的记录也不能凭空得分：来源 10 + 证据 6 - 未核对 5 = 11。
  const rice = result.items.find((item) => item.id === 'gy-i03-hb-001');
  assert.ok(rice);
  assert.equal(rice.score, 11);
});

test('空输入不抛异常并返回空列表', () => {
  for (const input of [undefined, null, {}, { records: [] }, { records: [], query: {} }]) {
    const result = rankRecommendations(input);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.notes, []);
    assert.equal(result.disclaimer, RECOMMENDATION_DISCLAIMER);
    assert.equal(result.policy_version, RECOMMENDATION_POLICY_VERSION);
  }
  // 只有查询、没有记录：同样是空列表而不是异常。
  const queryOnly = rankRecommendations({ query: { crop_id: 'crop_rice', symptoms: ['稗草'] } });
  assert.deepEqual(queryOnly.items, []);
});

test('未知症状降权而非崩：全部候选仍返回，每条低 15 分，相对次序不变', () => {
  const baseline = rank({ crop_id: 'crop_rice' });
  const unknown = rank({ crop_id: 'crop_rice', symptoms: ['根本不是杂草甲', '不存在的草乙'] });

  assert.equal(unknown.items.length, baseline.items.length);
  assert.deepEqual(ids(unknown), ids(baseline));
  for (const [index, item] of unknown.items.entries()) {
    const base = baseline.items[index];
    assert.ok(base);
    assert.equal(item.score, base.score + 2 * RECOMMENDATION_WEIGHTS.unknown_symptom);
    const unknownReasons = reasonsOf(item, 'unknown_symptom');
    assert.equal(unknownReasons.length, 2);
    for (const reason of unknownReasons) {
      assert.equal(reason.weight, RECOMMENDATION_WEIGHTS.unknown_symptom);
      assert.match(reason.detail, /不在 catalog\/species\.json 别名表内/);
    }
  }
});

test('剂量被忽略：不采纳、不参与打分、不输出剂量数字', () => {
  const [first] = RECORDS;
  assert.ok(first);
  // 1) 记录自身带剂量字段（顶层）：整条丢弃，score 与去掉该字段时完全相同。
  const withRecordDose = { ...first, dosage: '制剂 12.5克/亩，兑水 30 公斤喷雾' };
  const clean = rankRecommendations({ records: [first], crops: CROPS, species: SPECIES });
  const dosed = rankRecommendations({ records: [withRecordDose], crops: CROPS, species: SPECIES });
  assert.equal(dosed.items.length, 1);
  assert.equal(dosed.items[0].score, clean.items[0].score);
  const recordDoseReasons = reasonsOf(dosed.items[0], 'dosage_ignored');
  assert.equal(recordDoseReasons.length, 1);
  assert.equal(recordDoseReasons[0].weight, 0);
  const recordJson = JSON.stringify(dosed);
  assert.equal(recordJson.includes('12.5'), false);
  assert.equal(recordJson.includes('克/亩'), false);

  // 2) 查询上下文带剂量字段：同样丢弃，并留一条结果级说明 + 每条候选一条理由。
  const queryDose = rank({ crop_id: 'crop_rice', dosage: '12.5克/亩' });
  assert.ok(queryDose.notes.some((note) => note.code === 'dosage_ignored'));
  for (const item of queryDose.items) {
    const reasons = reasonsOf(item, 'dosage_ignored');
    assert.equal(reasons.length, 1);
    assert.equal(reasons[0].weight, 0);
  }
  assert.equal(JSON.stringify(queryDose).includes('12.5'), false);
  // 查询剂量不改变排序结果（不是「带剂量就重排」的隐式通道）。
  assert.equal(JSON.stringify(ids(queryDose)), JSON.stringify(ids(rank({ crop_id: 'crop_rice' }))));

  // 3) 真实记录的 `verification.not_collected` 里写着「用药量（制剂量/亩）」——
  //    那是**缺项声明**，不得被误判成剂量输入（只扫浅层键的缘故）。
  const plain = rank({ crop_id: 'crop_rice' });
  for (const item of plain.items) {
    assert.equal(reasonsOf(item, 'dosage_ignored').length, 0);
  }
});

test('越权输入被安全处理：超长字符串与控制字符不崩、输出有界、仍可匹配', () => {
  const huge = `${'A'.repeat(10_000)}\u0000\u001b\u202e`;
  const controlWrappedSymptom = '\u0000稗草\u0007\u200b';
  const result = rank({ crop_id: 'crop_rice', symptoms: [controlWrappedSymptom], keywords: [huge] });
  assert.equal(result.items.length, RECORDS.length);
  assert.ok(result.notes.some((note) => note.code === 'input_sanitized'));
  // 剥掉控制字符后仍能按真实别名命中「稗草」。
  assert.equal(result.items[0].id, 'gy-i03-hb-006');
  const response = JSON.stringify(result);
  assert.equal(response.includes('\u0000'), false);
  assert.equal(response.includes('\u001b'), false);
  assert.equal(response.includes('\u202e'), false);
  assert.ok(response.length < 20_000, `输出长度失控：${response.length}`);
  // 超长输入不产生无界回显：一旦回显必须带截断标记。
  for (const reason of result.items[0].reasons) {
    assert.ok(reason.detail.length <= 240, `detail 过长：${reason.detail.length}`);
  }
  // 同样的越权输入仍然确定。
  const again = rank({ crop_id: 'crop_rice', symptoms: [controlWrappedSymptom], keywords: [huge] });
  assert.equal(JSON.stringify(result), JSON.stringify(again));
});

test('排序契约（把比较函数改成不倒序 ⇒ 必红）', () => {
  const result = rank({ crop_id: 'crop_rice', symptoms: ['稗草'], keywords: ['水稻移栽田'] });
  assert.ok(result.items.length > 1);
  for (let index = 1; index < result.items.length; index += 1) {
    const previous = result.items[index - 1];
    const current = result.items[index];
    assert.ok(previous && current);
    assert.ok(
      previous.score > current.score || (previous.score === current.score && previous.id < current.id),
      `第 ${index} 条破坏了 (score 降序, id 升序)：${previous.id}/${previous.score} → ${current.id}/${current.score}`,
    );
  }
  // 最高分必须在首位（「不倒序」的实现会把这句打红）。
  assert.equal(result.items[0].score, Math.max(...result.items.map((item) => item.score)));
});

test('纯函数：不改入参、结果不可变', () => {
  const records = RECORDS.map((record) => structuredClone(record));
  const query = { crop_id: 'crop_rice', symptoms: ['稗草'], keywords: ['移栽田'] };
  const recordsBefore = JSON.stringify(records);
  const queryBefore = JSON.stringify(query);
  const result = rankRecommendations({ records, crops: CROPS, species: SPECIES, query });
  assert.equal(JSON.stringify(records), recordsBefore);
  assert.equal(JSON.stringify(query), queryBefore);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.items), true);
  const [item] = result.items;
  assert.ok(item);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.reasons), true);
  assert.equal(Object.isFrozen(item.reasons[0]), true);
});

test('坏记录被跳过并留说明，不抛异常', () => {
  const [first] = RECORDS;
  assert.ok(first);
  const result = rankRecommendations({
    records: [{}, null, 42, [], { registered_name: '只有药名没有 id' }, first],
    crops: CROPS,
    species: SPECIES,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, first.record_id);
  const rejected = result.notes.filter((note) => note.code === 'record_rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].detail, /跳过 5 条记录/);
});

test('未知作物：不猜作物、不加作物分、也不抛异常', () => {
  const result = rank({ crop_id: 'crop_banana' });
  assert.equal(result.items.length, RECORDS.length);
  assert.ok(result.notes.some((note) => note.code === 'unknown_crop'));
  for (const item of result.items) {
    assert.equal(reasonsOf(item, 'crop_match').length, 0);
    const unknown = reasonsOf(item, 'unknown_crop');
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].weight, 0);
    // 没有任何匹配 ⇒ 来源 10 + 证据 6 - 未核对 5 = 11，不多不少。
    assert.equal(item.score, 11);
  }
});

test('安全口径：免责文案与全部理由通过 risk-wording 守卫，且无剂量数字', () => {
  const result = rank({ crop_id: 'crop_rice', symptoms: ['稗草'], keywords: ['水稻移栽田'] });
  assert.match(result.disclaimer, /不能作为用药依据/);
  assert.equal(assertRiskWordingSafe(result.disclaimer, { channel: 'reason' }), result.disclaimer);
  for (const item of result.items) {
    for (const reason of item.reasons) {
      assertRiskWordingSafe(reason.detail, { channel: 'reason' });
      assert.equal(DOSE_NUMBER.test(reason.detail), false, `理由里出现剂量数字：${reason.detail}`);
    }
    assert.equal(DOSE_NUMBER.test(item.name), false);
  }
});

test('重复 id 不吞掉候选：留说明、次序仍确定', () => {
  const [first] = RECORDS;
  assert.ok(first);
  const duplicated = rankRecommendations({ records: [first, first], crops: CROPS, species: SPECIES });
  assert.equal(duplicated.items.length, 2);
  assert.deepEqual(duplicated.items[0], duplicated.items[1]);
  assert.ok(duplicated.notes.some((note) => note.code === 'duplicate_id'));
  const again = rankRecommendations({ records: [first, first], crops: CROPS, species: SPECIES });
  assert.equal(JSON.stringify(duplicated), JSON.stringify(again));
});

// GY-R71 · 「标签原文用量 / 可执行建议」只读出口（`GET /dose-cards`）的回归与安全边界。
//
// 覆盖（issue #8 核心缺口的验收面）：
//   A. **九道门逐道各一条**「不过门 ⇒ 不出现」用例 —— 每条只打一门，其余八门全部保持通过，
//      因此每条用例都能把「哪一道门拦下的」判成**唯一**的门 id；
//   B. **一条正控制**：九门 + 外层 executable 门全过 ⇒ 出现，且字段齐全（出处 / 条件 / 原文用量）；
//   C. **不做混配换算**：原文数字与单位必须逐字出现，出口里不存在任何换算辅助或换算字段；
//   D. **零真实外呼 / 零读库**：模块不引网络与数值换算设施；HTTP 面在没有数据库池时照常 200；
//   E. **真实 20 条记录**：九道门全过的条目数为 0 ⇒ 如实空 + 可判定原因（不是静默空数组）；
//   F. **HTTP 面契约**：封套、`no-store`、不发 ETag、未登录 401、`additionalProperties:false` 键闭包。
//
// 纪律：本文件**不写任何 `文件:行号`**（行号会漂，仓库有专门闸门判红那种写法）；
// 不设环境变量、不读 `process.cwd()` / `process.platform`、不做真实网络调用、不连数据库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import {
  DOSE_GATE_ID,
  DOSE_GATE_LEDGER,
  assertDoseGateMappingComplete,
  isEmittable,
  readDoseCards,
} from '../../services/api/src/knowledge/dose-cards.ts';

const contract = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
);
const schemas = contract.components.schemas;
const IDEM = 'idem-key-r71-dose-0001';
const SESSION_KEY = 'synthetic-session-signing-key-r71-dose';

/** 模块源码（D/E 两段做静态扫描，防止「出口里悄悄长出换算/外呼」）。 */
const MODULE_SOURCE = readFileSync(
  new URL('../../services/api/src/knowledge/dose-cards.ts', import.meta.url),
  'utf8',
);

function stubConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
}

/** 装配一个**没有数据库池**的 app：本路由若偷偷读库就会 503，用例因而能证明「不读库」。 */
async function newApp() {
  const app = buildApp({
    config: stubConfig(),
    store: createMemoryAuthStore(),
    idempotency: createMemoryIdempotencyStore(),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'idempotency-key': IDEM },
    payload: { code: 'synthetic-r71-dose' },
  });
  assert.equal(res.statusCode, 200);
  return { app, token: res.json().data.access_token };
}

// ---------------------------------------------------------------------------
// 判定替身：一条「九门全过」的条目。★ 只有这一份夹具，负例逐个改一门、其余不动。
// ---------------------------------------------------------------------------

/** 原文用量（逐字：数字 / 单位 / 条件 / 原文定位）。⛔ 这些值是「来源原文」，不是算出来的。 */
const ORIGINAL_DOSE = Object.freeze({
  number: '40',
  unit: '克/公顷',
  condition: '苗后茎叶喷雾',
  reference: '登记公告附表第 3 行「制剂用量」列',
});

const FORMULATION = Object.freeze({
  registration_number: 'PD20210001',
  registered_name: '测试剂',
  dosage_form: '水分散粒剂',
  ingredients_text: '唑草酮 40%',
});

function fullItem(over = {}) {
  const base = {
    record_id: 'r71-full',
    registration_number: FORMULATION.registration_number,
    registered_name: FORMULATION.registered_name,
    dosage_form: FORMULATION.dosage_form,
    ingredients_text: FORMULATION.ingredients_text,
    crop_ids: ['crop_rice'],
    use_scene: '水稻移栽田',
    source_version: 'sv-r71@1',
    visibility: 'published',
    simulated: false,
    source: {
      source_kind: 'verified_seed',
      evidence_kind: 'research',
      source_validity: 'valid',
      review_status: 'verified',
      source_id: 'src_r71_test',
      url: 'https://example.gov.cn/r71.xls',
    },
    verification: {
      usable_as_dose: true,
      review_status: 'verified',
      restriction_status: 'unrestricted',
      dose: { ...ORIGINAL_DOSE, record_id: 'r71-full', source_version: 'sv-r71@1', formulation: { ...FORMULATION } },
    },
  };
  return { ...base, ...over };
}

/** 改「一门」而不动其余：`patch(verification)` 只覆盖 verification 的指定键。 */
function withVerification(patch) {
  const base = fullItem();
  return fullItem({ verification: { ...base.verification, ...patch } });
}

function withDose(patch) {
  const base = fullItem();
  return fullItem({
    verification: { ...base.verification, dose: { ...base.verification.dose, ...patch } },
  });
}

const run = (item, options = {}) => readDoseCards({ items: [item], ...options });

// ---------------------------------------------------------------------------
// A. 九道门逐道各一条负例：不过门 ⇒ 不出现（且点名是哪一道）
// ---------------------------------------------------------------------------

/**
 * 每条只打一门。`expected` 是本出口应当点名的门 id；`label` 是门在
 * `packages/reference/labels.mjs#doseCardDescriptor` 文档注释里的第几条。
 */
const GATE_CASES = [
  {
    gate: DOSE_GATE_ID.FEATURE_SWITCH,
    index: 1,
    name: '门 1 功能开关关闭（doseCardEnabled=false）',
    build: () => ({ item: fullItem(), options: { doseCardEnabled: false } }),
  },
  {
    gate: DOSE_GATE_ID.USABLE_AS_DOSE,
    index: 2,
    name: '门 2 未采集可用作依据的用量字段（usable_as_dose !== true）',
    build: () => ({ item: withVerification({ usable_as_dose: false }), options: {} }),
  },
  {
    gate: DOSE_GATE_ID.ORIGINAL_CONDITION,
    index: 3,
    name: '门 3 缺原文可绑定条件（dose.condition 为空串）',
    build: () => ({ item: withDose({ condition: '   ' }), options: {} }),
  },
  {
    gate: DOSE_GATE_ID.NUMBER_UNIT,
    index: 4,
    name: '门 4 缺可绑定数字用量与单位（dose.unit 为空串）',
    build: () => ({ item: withDose({ unit: '' }), options: {} }),
  },
  {
    gate: DOSE_GATE_ID.APPLICABILITY,
    index: 5,
    name: '门 5 当前适用判定不通过（禁限用状态未采集 ⇒ fail-closed）',
    build: () => ({ item: withVerification({ restriction_status: 'unknown' }), options: {} }),
  },
  {
    gate: DOSE_GATE_ID.REVIEW_VERIFIED,
    index: 6,
    name: '门 6 记录级未核对（review_status=unverified）',
    build: () => ({ item: withVerification({ review_status: 'unverified' }), options: {} }),
  },
  {
    gate: DOSE_GATE_ID.SOURCE_VERSION,
    index: 7,
    name: '门 7 用量未绑定当前来源版本（陈旧用量）',
    build: () => ({ item: withDose({ source_version: 'sv-r71@0-陈旧' }), options: {} }),
  },
  {
    gate: DOSE_GATE_ID.FORMULATION_BINDING,
    index: 8,
    name: '门 8 用量未绑定当前登记制剂（成分含量不一致 ⇒ 挪用他人用量卡）',
    build: () => ({
      item: withDose({ formulation: { ...FORMULATION, ingredients_text: '吡氟酰草胺 2%' } }),
      options: {},
    }),
  },
  {
    gate: DOSE_GATE_ID.NOT_SIMULATED,
    index: 9,
    name: '门 9 模拟来源（simulated=true）',
    build: () => ({ item: fullItem({ simulated: true }), options: {} }),
  },
];

for (const gateCase of GATE_CASES) {
  test(`R71 门 ${gateCase.index}｜${gateCase.name} ⇒ 该条不出现，且原因点名这道门`, () => {
    const { item, options } = gateCase.build();
    const page = run(item, options);

    assert.deepEqual(page.dose_cards, [], `门 ${gateCase.index} 未通过时 dose_cards 必须为空`);
    assert.equal(page.empty, true, '不过门 ⇒ empty=true');
    assert.equal(page.rejections.length, 1, '不过门的记录必须留在 rejections 里（不许静默丢弃）');
    assert.equal(page.rejections[0].failed_gate, gateCase.gate, `点名门不唯一：期望 ${gateCase.gate}`);
    assert.equal(typeof page.rejections[0].reason, 'string');
    assert.ok(page.rejections[0].reason.length > 0, '拒绝原因不得为空');
    assert.equal(page.rejections[0].renderable, false);
    assert.equal(typeof page.empty_reason, 'string');
    assert.ok(
      page.empty_reason !== null && page.empty_reason.includes(gateCase.gate),
      '空结果的原因里必须写出第一道未过之门',
    );
  });
}

// ---------------------------------------------------------------------------
// B. 正控制：九门 + 外层门全过 ⇒ 出现且字段齐全
// ---------------------------------------------------------------------------

test('R71 正控制｜九门 + 外层 executable 门全过 ⇒ 出现，且出处/条件/原文用量字段齐全', () => {
  const page = run(fullItem());

  assert.equal(page.dose_cards.length, 1, '全过 ⇒ 恰好一张卡');
  assert.deepEqual(page.rejections, [], '全过 ⇒ 无拒绝记录');
  assert.equal(page.empty, false);
  assert.equal(page.empty_reason, null, '非空结果不应带空原因');
  assert.equal(page.evaluated, 1);

  const card = page.dose_cards[0];

  // 键闭包：与契约 schema 逐键一致（additionalProperties:false）。
  const cardSchema = schemas.DoseCardReadout;
  assert.deepEqual(Object.keys(card).sort(), [...cardSchema.required].sort());
  assert.deepEqual(
    Object.keys(card.provenance).sort(),
    [...schemas.DoseCardProvenance.required].sort(),
  );
  assert.deepEqual(
    Object.keys(card.conditions).sort(),
    [...schemas.DoseCardConditionsReadout.required].sort(),
  );
  assert.deepEqual(Object.keys(card.dose).sort(), ['condition', 'number', 'reference', 'unit']);

  // 可核验出处三条：登记号 / 来源版本 / 原文 condition。
  assert.equal(card.provenance.registration_number, 'PD20210001');
  assert.equal(card.provenance.source_version, 'sv-r71@1');
  assert.equal(card.conditions.original_condition, ORIGINAL_DOSE.condition);
  assert.equal(card.provenance.record_id, 'r71-full');
  assert.equal(card.provenance.source_review_status, 'verified');

  // 原文用量逐字。
  assert.equal(card.dose.number, ORIGINAL_DOSE.number);
  assert.equal(card.dose.unit, ORIGINAL_DOSE.unit);
  assert.equal(card.dose.condition, ORIGINAL_DOSE.condition);
  assert.equal(card.dose.reference, ORIGINAL_DOSE.reference);

  // 三层门的结论都要如实出现（外层 executable / 九门 renderable / 计数）。
  assert.equal(card.executable, true);
  assert.equal(card.renderable, true);
  assert.equal(card.dose_count, 1);
  assert.equal(card.rule_version, page.rule_version);

  // 未采集的维度必须显式列出，不许静默省略成「没有这一维」。
  assert.deepEqual(card.conditions.crop_ids, ['crop_rice']);
  assert.equal(card.conditions.use_scene, '水稻移栽田');
  assert.equal(card.conditions.region_code, null);
  assert.ok(card.conditions.not_collected.includes('region_code'));
  assert.ok(!card.conditions.not_collected.includes('use_scene'), '已采集的维度不得出现在未采集清单里');

  // 门清单必须完整下发（9 道 + 外层 1 道），且 order 可核。
  assert.equal(page.gate_ledger.length, 10);
  assert.deepEqual(page.first_failed_gates, [], '全过 ⇒ 无第一道未过之门');
});

// ---------------------------------------------------------------------------
// C. 不做混配换算（仓规：原文用量绑定登记制剂和条件，不生成处方混配换算）
// ---------------------------------------------------------------------------

test('R71 不混配｜原文数字与单位逐字出现，出口里没有换算设施、没有换算字段', () => {
  const page = run(fullItem());
  const card = page.dose_cards[0];

  // ① 逐字：不是「等值」，是同一个字符串。
  assert.equal(card.dose.number, ORIGINAL_DOSE.number);
  assert.equal(card.dose.unit, ORIGINAL_DOSE.unit);

  // ② 字段闭包：没有任何「每亩用量 / 稀释倍数 / 混配组合 / 折算」类字段。
  const doseKeys = Object.keys(card.dose).sort();
  assert.deepEqual(doseKeys, ['condition', 'number', 'reference', 'unit']);
  const forbiddenFieldNames = ['per_mu', 'mu', 'dilution', 'mix', 'mixture', 'converted', 'conversion', 'rate_per_hectare', 'dosage'];
  const cardJson = JSON.stringify(card);
  for (const name of forbiddenFieldNames) {
    assert.equal(cardJson.includes(`"${name}"`), false, `卡片里出现了换算/混配字段：${name}`);
  }

  // ③ 模块里不存在任何数值换算设施（出现即说明有人开始「算」用量）。
  const forbiddenHelpers = ['parseFloat', 'parseInt', 'toFixed', 'Math.', 'Number('];
  for (const helper of forbiddenHelpers) {
    assert.equal(MODULE_SOURCE.includes(helper), false, `出口模块里出现了数值换算设施：${helper}`);
  }

  // ④ 出口里不做「混配/处方」措辞：只在明确禁止的注释里出现，不得出现在下发字段的取值里。
  for (const word of ['混配', '配伍', '处方', '稀释倍数']) {
    for (const value of Object.values(card.dose)) {
      assert.equal(String(value).includes(word), false, `用量字段里出现了混配/处方措辞：${word}`);
    }
  }

  // ⑤ 响应里的用量数字集合与原文数字集合逐个相同（多一个数就说明被算过）。
  const numbersOf = (text) => String(text).match(/\d+(?:\.\d+)?/g) ?? [];
  assert.deepEqual(numbersOf(card.dose.number), numbersOf(ORIGINAL_DOSE.number));
  assert.deepEqual(numbersOf(card.dose.unit), numbersOf(ORIGINAL_DOSE.unit));
});

// ---------------------------------------------------------------------------
// D. 零真实外呼 / 零读库
// ---------------------------------------------------------------------------

test('R71 零外呼｜模块不引网络/数据库设施，HTTP 面在没有数据库池时照常 200', async () => {
  for (const token of ['fetch(', 'node:http', 'node:https', 'undici', "from 'pg'"]) {
    assert.equal(MODULE_SOURCE.includes(token), false, `出口模块里出现了网络/数据库设施：${token}`);
  }
  // 装配层没给池（`buildApp` 的 pool 缺省为空）⇒ 若本路由读库就会 503。
  const { app, token } = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/dose-cards',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, '无数据库池时本路由必须照常 200（证明不读库）');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.etag, undefined, '不产生资源版本 ⇒ 不发 ETag');
});

// ---------------------------------------------------------------------------
// E. 真实 20 条记录：九门全过 = 0 条 ⇒ 如实空 + 可判定原因
// ---------------------------------------------------------------------------

test('R71 真实数据｜仓内 20 条记录里没有一条能同时过九门与外层门 ⇒ 空 + 原因', () => {
  const page = readDoseCards({ executableEnabled: true, doseCardEnabled: true });

  assert.equal(page.evaluated, 20, '仓内公开登记公告记录应为 20 条（变了就要重新读口径）');
  assert.deepEqual(page.dose_cards, []);
  assert.equal(page.empty, true);
  assert.equal(page.rejections.length, page.evaluated, '每条候选都要有拒绝记录');
  assert.equal(typeof page.empty_reason, 'string');
  assert.ok(page.empty_reason !== null && page.empty_reason.length > 0, '空结果必须带非空原因');
  assert.equal(page.empty_reason.includes('dose_cards 为空'), true);

  // 原因必须可判定：第一道未过之门是门 2（仓内记录一律 usable_as_dose=false）。
  assert.deepEqual(page.first_failed_gates, [{ gate: DOSE_GATE_ID.USABLE_AS_DOSE, count: 20 }]);
  for (const rejection of page.rejections) {
    assert.equal(rejection.failed_gate, DOSE_GATE_ID.USABLE_AS_DOSE);
    assert.equal(rejection.executable, false);
    assert.ok(rejection.reason.length > 0);
    assert.ok(rejection.registration_number !== null && rejection.registration_number.length > 0);
  }

  // 域库同时给出的其它阻断类别也要如实出现（未核对 / 禁限用未知 / 无用量来源）。
  const codes = page.block_codes.map((entry) => entry.code);
  assert.ok(codes.includes('unreviewed'), '20 条记录都是 unverified ⇒ unreviewed 必须出现');
  assert.ok(codes.includes('restriction_unknown'), '禁限用状态未采集 ⇒ restriction_unknown 必须出现');

  // 反面：真正不可用的口径是「永不出现卡片」，而不是「返回空数组了事」。
  assert.equal(
    page.rejections.every((entry) => entry.renderable === false),
    true,
  );
});

// ---------------------------------------------------------------------------
// F. 门清单与映射的总覆盖自检
// ---------------------------------------------------------------------------

test('R71 门清单｜九道门 + 外层门齐全，且域库每个拒绝原因都有门归属（新增原因即判红）', () => {
  const { covered, reasons } = assertDoseGateMappingComplete();
  assert.equal(covered, reasons.length);
  assert.ok(covered >= 16, `拒绝原因数量异常：${covered}`);

  const ids = DOSE_GATE_LEDGER.map((entry) => entry.id);
  for (const gate of GATE_CASES) {
    assert.ok(ids.includes(gate.gate), `门清单缺 ${gate.gate}`);
  }
  assert.equal(ids.includes(DOSE_GATE_ID.EXECUTABLE_ADVICE), true, '外层 executable 门必须在清单里');
  // 编号 1..9 必须一一对应，不许重号/缺号。
  const indexes = DOSE_GATE_LEDGER.map((entry) => entry.index).filter((index) => index !== 0).sort((a, b) => a - b);
  assert.deepEqual(indexes, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // 清单里不许出现裸行号（锚点纪律）。
  for (const entry of DOSE_GATE_LEDGER) {
    assert.equal(/:\d+/.test(entry.rule_ref), false, `门清单里出现裸行号：${entry.rule_ref}`);
  }
});

// ---------------------------------------------------------------------------
// G. 外层 executable 门：与门是**同时**成立，不是二选一
// ---------------------------------------------------------------------------

test('R71 与门｜isEmittable 要求 executable 与 renderable 同时为真，任一为假即不放行', () => {
  const boundary = (over) => ({
    executable: true,
    renderable: true,
    dose_count: 1,
    dose_card: { renderable: true },
    advice: { executable: true },
    ...over,
  });
  assert.equal(isEmittable(boundary({})), true, '全真 ⇒ 放行');
  assert.equal(isEmittable(boundary({ executable: false })), false, '外层 executable=false ⇒ 不放行');
  assert.equal(isEmittable(boundary({ advice: { executable: false } })), false, '建议判定=false ⇒ 不放行');
  assert.equal(isEmittable(boundary({ renderable: false })), false, '九门未全过 ⇒ 不放行');
  assert.equal(isEmittable(boundary({ dose_card: { renderable: false } })), false, '描述符未渲染 ⇒ 不放行');
  assert.equal(isEmittable(boundary({ dose_count: 0 })), false, '剂量计数非 1 ⇒ 不放行');
  assert.equal(isEmittable(boundary({ dose_count: 2 })), false, '多卡 ⇒ 不放行');
});

test('R71 外层门｜可执行建议总开关关闭 ⇒ 一条卡片都不出现（开关必须被逐层传下去）', () => {
  // `APP_GY_I08_EXECUTABLE_ENABLED` 是「可执行建议」的总闸；域库把用量卡开关作为它的下位
  // （`resolveFeatureSwitches` 的 `dose_card_enabled: doseCardRequested && executableEnabled`），
  // 因此总闸关闭时描述符给出的拒绝原因是门 1 的 `closed`，而 `block_codes` 里同时带 `feature_closed`。
  // 本用例钉的是**出口有没有把这两个开关传下去**：不传 ⇒ 域库回落到环境变量默认（开）⇒ 卡片会冒出来。
  const page = run(fullItem(), { executableEnabled: false });
  assert.deepEqual(page.dose_cards, [], '总闸关闭时不得出现任何用量卡');
  assert.equal(page.empty, true);
  assert.ok(page.empty_reason !== null && page.empty_reason.length > 0);
  assert.equal(page.rejections.length, 1);
  assert.equal(page.rejections[0].failed_gate, DOSE_GATE_ID.FEATURE_SWITCH);
  assert.equal(page.rejections[0].executable, false);
  assert.ok(
    page.rejections[0].block_codes.includes('feature_closed'),
    `外层总闸关闭必须在域库阻断类别里如实出现：${page.rejections[0].block_codes.join(',')}`,
  );
});

// ---------------------------------------------------------------------------
// H. HTTP 面：契约封套 / 无会话 401 / 空结果仍带原因
// ---------------------------------------------------------------------------
test('R71 HTTP｜GET /dose-cards 契约封套、no-store、无 ETag，空结果如实带原因', async () => {
  const { app, token } = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/dose-cards',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // 封套：data + meta（契约 Meta 三键）。
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.deepEqual(Object.keys(body.meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
  assert.equal(body.meta.contract_version, '1.0.0');

  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), [...schemas.DoseCardReadoutPage.required].sort());
  assert.equal(data.evaluated, 20);
  assert.deepEqual(data.dose_cards, []);
  assert.equal(data.empty, true);
  assert.equal(typeof data.empty_reason, 'string');
  assert.ok(data.empty_reason.length > 0, 'HTTP 面上的空结果也必须带原因');
  assert.equal(data.rejections.length, 20);
  assert.equal(data.gate_ledger.length, 10);
  assert.equal(typeof data.rule_spec_digest, 'string');
  assert.ok(data.rule_spec_digest.startsWith('gy-i08-spec+sha256:'));

  // 每条拒绝记录都要能对上契约（键闭包）。
  for (const rejection of data.rejections) {
    assert.deepEqual(
      Object.keys(rejection).sort(),
      [...schemas.DoseCardRejection.required].sort(),
    );
    assert.equal(schemas.DoseGateId.enum.includes(rejection.failed_gate), true);
  }
  for (const tally of data.first_failed_gates) {
    assert.equal(schemas.DoseGateId.enum.includes(tally.gate), true);
  }
});

test('R71 HTTP｜无会话 ⇒ 401，不泄露任何用量数据', async () => {
  const { app } = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/dose-cards' });
  assert.equal(res.statusCode, 401);
  const text = res.body;
  assert.equal(text.includes('dose_cards'), false, '未授权响应里不得出现任何用量字段');
});

test('R71 HTTP｜未知查询参数 ⇒ 400（querystring 为闭集，不接受任何过滤旁路）', async () => {
  const { app, token } = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/dose-cards?limit=1',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 400);
});

/**
 * GY-I08 · 剂量「空真」性守卫（真实用量正例 N=0）。
 *
 * 背景（测量时点 2026-10-17；快照 `upstream/main` = `6c2200087ae5f8841a04505cb1c226284cee7f1b`）：
 *
 *   源 A `packages/knowledge/herbicides/records-2026.json`
 *     records 20 条；`usable_as_dose=true` 0 条；`dose_text` 与 `dose_status` 两个键**整体缺席**（0/20）
 *     ⇒ 正例 0。
 *   源 B `packages/knowledge/zhejiang/materials-zhejiang-v1.json`
 *     `herbicide_items` 96 条；`dose_text` 非空 0 条（96/96 为 null）；`dose_status` **96/96 有值**
 *     且全为 `absent_in_source`；`usable_as_dose=true` 0 条；`card_ready=true` 0 条 ⇒ 正例 0。
 *   两源正例合计 **N=0**。证据页 `docs/verification/gy-i08-applicability-rules-20261014.md`
 *   登记的「真实资料 DosCard 渲染计数=0」与之一致。
 *
 * 本文件挡的是**空真**（vacuously true）：功能开关 `APP_GY_I08_DOSE_CARD_ENABLED` 默认 true，
 * 守卫与用例全绿，但真实资料里一条可产出的剂量正例都没有 —— 绿是因为「没数据」而不是「逻辑对」。
 *
 * 四条判据：
 *   1) N 必须等于证据页与缺口台账里**登记**的值（当前 0）。数据一变而登记值没同步 ⇒ 第一条转红；
 *      正确修法是更新登记值（或在补齐真实数据后同步），**不是**改数据凑绿。
 *   2) N=0 时，真实资料对外只能是「缺项/未取得」形态：不产用量卡、不出现 `dose` 物件、
 *      阻断码含 `no_dose_source`；`dose_status` 与 `dose_text` 必须自洽。
 *   3) 产出文本里出现的任何剂量串（数字+单位），必须逐条能在两源原始 JSON 里找到原样出处，
 *      不得兜底编造。
 *   4) **正例控制**：内存合成夹具（确有完整原文用量）必须真的产出 —— 否则这条守卫自己也是空真。
 *      复跑「必红」证据：设 `GY_I08_GUARD_POSITIVE_CONTROL_EMPTY=1` 把夹具的剂量掏空，
 *      第 4 条与第 3 条的正例控制断言必须转红（不改文件、不写盘）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_CODES,
  ZHEJIANG_DOSE_ABSENT_NOTE,
  doseDisplayFor,
  evaluateDoseBoundary,
  loadHerbicideRecords,
  loadZhejiangKnowledge,
} from '../../packages/reference/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const SOURCE_A_PATH = 'packages/knowledge/herbicides/records-2026.json';
const SOURCE_B_PATH = 'packages/knowledge/zhejiang/materials-zhejiang-v1.json';
const EVIDENCE_PAGE_PATH = 'docs/verification/gy-i08-applicability-rules-20261014.md';
const VERIFICATION_DIR = path.join(ROOT, 'docs', 'verification');
const LEDGER_FILE_PATTERN = /^gy-i08-dose-gap-ledger-(\d{8})\.md$/;
const LEDGER_LINE_PATTERN = /剂量真实正例数（N，机器登记行）=(\d+)/;
const REGISTERED_COUNT_PATTERN = /真实资料 DosCard 渲染计数=(\d+)/g;

/** 正例控制开关：只为复现「掏空夹具 ⇒ 正例断言必红」，不是产品开关。 */
const POSITIVE_CONTROL_EMPTY = process.env.GY_I08_GUARD_POSITIVE_CONTROL_EMPTY === '1';

/** 剂量串：数字 + 剂量单位（用于「产出不得出现数据里没有的剂量串」的逐条回查）。 */
const DOSE_TOKEN_PATTERN =
  /(\d+(?:\.\d+)?)\s*(毫升|毫克|千克|公斤|公顷|克|升|亩|mL|ml|mg|kg|L|l)(?![A-Za-z])/g;

const readText = (relPath) => readFileSync(path.join(ROOT, relPath), 'utf8').replace(/^\uFEFF/, '');
const readJson = (relPath) => JSON.parse(readText(relPath));
const isNonEmptyText = (value) => typeof value === 'string' && value.trim() !== '';

/** 收集文本里的剂量串（归一为「数字+单位」）。 */
function doseTokensOf(text) {
  const tokens = new Set();
  for (const match of String(text).matchAll(DOSE_TOKEN_PATTERN)) tokens.add(`${match[1]}${match[2]}`);
  return tokens;
}

const doseTextOf = (item) => item?.verification?.dose_text ?? item?.dose_text ?? null;
const doseStatusOf = (item) => item?.verification?.dose_status ?? item?.dose_status ?? null;
const usableAsDose = (item) =>
  item?.verification?.usable_as_dose === true || item?.usable_as_dose === true;

/** 一个「真实用量正例」＝标为可用于用量 **且** 确有原文剂量文本；缺任一即非正例。 */
const isDosePositive = (item) => usableAsDose(item) && isNonEmptyText(doseTextOf(item));

/** 缺项型状态词（`absent_in_source` 等）：声称未取得原文时，剂量文本必须为空。 */
const ABSENT_STATUS_PATTERN = /absent|missing|unobtained|uncollected|not_collected/i;
const isAbsentStatus = (status) => typeof status === 'string' && ABSENT_STATUS_PATTERN.test(status);

const sourceA = readJson(SOURCE_A_PATH);
const sourceB = readJson(SOURCE_B_PATH);
const recordsA = Array.isArray(sourceA.records) ? sourceA.records : [];
const itemsB = Array.isArray(sourceB.herbicide_items) ? sourceB.herbicide_items : [];

function countSource(items) {
  return {
    total: items.length,
    usable: items.filter(usableAsDose).length,
    doseText: items.filter((item) => isNonEmptyText(doseTextOf(item))).length,
    doseStatus: items.filter((item) => isNonEmptyText(doseStatusOf(item))).length,
    doseStatusAbsent: items.filter((item) => isAbsentStatus(doseStatusOf(item))).length,
    positive: items.filter(isDosePositive).length,
  };
}

const countsA = countSource(recordsA);
const countsB = countSource(itemsB);
const POSITIVE_TOTAL = countsA.positive + countsB.positive;
const SUMMARY_LINE =
  `N=${POSITIVE_TOTAL}（A 正例 ${countsA.positive}；B 正例 ${countsB.positive}）` +
  `｜A ${countsA.total} 条：usable_as_dose=true ${countsA.usable}、dose_text 非空 ${countsA.doseText}、` +
  `dose_status 有值 ${countsA.doseStatus}（缺项状态词 ${countsA.doseStatusAbsent}）` +
  `｜B ${countsB.total} 条：usable_as_dose=true ${countsB.usable}、dose_text 非空 ${countsB.doseText}、` +
  `dose_status 有值 ${countsB.doseStatus}（缺项状态词 ${countsB.doseStatusAbsent}）`;

/** 证据页里登记的全部「真实资料 DosCard 渲染计数」。 */
function registeredCountsFromEvidencePage() {
  const text = readText(EVIDENCE_PAGE_PATH);
  return [...text.matchAll(REGISTERED_COUNT_PATTERN)].map((match) => Number(match[1]));
}

/** 缺口台账里的机器登记行（取日期最新的一份）。 */
function registeredCountFromLedger() {
  const files = readdirSync(VERIFICATION_DIR).filter((name) => LEDGER_FILE_PATTERN.test(name)).sort();
  assert.ok(
    files.length > 0,
    '缺少缺口台账 docs/verification/gy-i08-dose-gap-ledger-<YYYYMMDD>.md（机器登记行的唯一出处）',
  );
  const file = files[files.length - 1];
  const text = readFileSync(path.join(VERIFICATION_DIR, file), 'utf8');
  const hit = text.match(LEDGER_LINE_PATTERN);
  assert.ok(
    hit,
    `台账 ${file} 缺少机器登记行「剂量真实正例数（N，机器登记行）=<N>」；守卫靠它对齐登记值`,
  );
  return { file, value: Number(hit[1]) };
}

/**
 * 内存正例夹具：**合成**记录（非真实公告、不写盘），形状对齐
 * `tests/reference/i08-scenarios-100.test.mjs` 的 `defaultItem()/doseItem()`。
 * @param {boolean} omitDose true = 掏空剂量（只用于复跑「正例必红」证据）
 */
function positiveFixture(omitDose) {
  const dose = {
    number: '40',
    unit: '克/公顷',
    condition: '苗后茎叶喷雾',
    reference: '合成夹具（非真实公告）',
    record_id: 'guard-synthetic-1',
    source_version: 'sv-guard@1',
    formulation: {
      registration_number: 'PD20210001',
      registered_name: '空真性守卫夹具剂',
      dosage_form: '水分散粒剂',
      ingredients_text: '唑草酮 40%',
    },
  };
  const item = {
    record_id: 'guard-synthetic-1',
    registration_number: 'PD20210001',
    registered_name: '空真性守卫夹具剂',
    crop_ids: ['crop_rice'],
    dosage_form: '水分散粒剂',
    ingredients_text: '唑草酮 40%',
    use_scene: '水稻移栽田',
    growth_stage: '苗后',
    region_codes: ['330100'],
    visibility: 'published',
    simulated: false,
    source_version: 'sv-guard@1',
    source: {
      source_kind: 'verified_seed',
      evidence_kind: 'research',
      source_validity: 'valid',
      review_status: 'verified',
    },
    verification: {
      usable_as_dose: true,
      review_status: 'verified',
      restriction_status: 'unrestricted',
      ...(omitDose ? {} : { dose }),
    },
  };
  return { item, dose };
}

test('GY-I08 空真性：双源真实用量正例 N=0，且与证据页/缺口台账登记值一致', () => {
  console.log(`[GY-I08] 真实用量正例 ${SUMMARY_LINE}`);
  assert.equal(
    POSITIVE_TOTAL,
    countsA.positive + countsB.positive,
    '正例合计必须等于两源正例之和',
  );
  assert.ok(recordsA.length >= 20, `源 A 至少 20 条真实记录，实际 ${recordsA.length}`);
  assert.ok(itemsB.length >= 96, `源 B 至少 96 条 herbicide_items，实际 ${itemsB.length}`);

  // 投影视图与原始 JSON 条数一致（否则守卫量的是另一个数据面）。
  assert.equal(
    loadHerbicideRecords().items.length,
    recordsA.length,
    'loadHerbicideRecords() 的条目数必须等于源 A 的 records 数',
  );

  const pageValues = registeredCountsFromEvidencePage();
  assert.ok(
    pageValues.length > 0,
    `证据页 ${EVIDENCE_PAGE_PATH} 必须登记「真实资料 DosCard 渲染计数=<N>」`,
  );
  for (const value of pageValues) {
    assert.equal(
      POSITIVE_TOTAL,
      value,
      `证据页登记的 DosCard 渲染计数=${value} 与实测 N=${POSITIVE_TOTAL} 不一致：` +
        `数据变了就同步登记值（⛔ 不得改数据凑绿）｜${SUMMARY_LINE}`,
    );
  }

  const ledger = registeredCountFromLedger();
  assert.equal(
    POSITIVE_TOTAL,
    ledger.value,
    `缺口台账 ${ledger.file} 登记的 N=${ledger.value} 与实测 N=${POSITIVE_TOTAL} 不一致｜${SUMMARY_LINE}`,
  );

  if (POSITIVE_TOTAL === 0) {
    console.log('[GY-I08] 空真性状态成立：两源真实资料里没有一条可产出用量卡的正例');
  }
});

test('GY-I08 空真性：N=0 时真实资料对外只能是「缺项/未取得」，不得产出用量卡或剂量文本', () => {
  const projectedB = loadZhejiangKnowledge().items.filter(
    (item) => item?.kind === 'herbicide_applicability',
  );
  assert.ok(
    projectedB.length >= 35,
    `浙江首批 herbicide_applicability 条目应≥35（96 条原表按首批筛选），实际 ${projectedB.length}`,
  );

  const counts = { realRenderable: 0, cardsWithDose: 0, checked: 0 };
  for (const [label, items] of [
    ['A records-2026.json', loadHerbicideRecords().items],
    ['B zhejiang(首批)', projectedB],
  ]) {
    for (const item of items) {
      const id = item.registration_number ?? item.item_id ?? item.record_id ?? '(无标识)';
      counts.checked += 1;

      // 数据层自洽：dose_status 若存在必须非空；缺项状态词 ⇒ dose_text 为空；否则 ⇒ dose_text 非空。
      const status = doseStatusOf(item);
      const doseText = doseTextOf(item);
      if (status !== null) {
        assert.ok(
          isNonEmptyText(status),
          `${label} ${id} 的 dose_status 若存在必须为缺项值（不得为空串）`,
        );
        if (isAbsentStatus(status)) {
          assert.equal(
            isNonEmptyText(doseText),
            false,
            `${label} ${id} 的 dose_status=${status} 声称未取得原文，dose_text 必须为空（不得一边缺项一边有量）`,
          );
        } else {
          assert.ok(
            isNonEmptyText(doseText),
            `${label} ${id} 的 dose_status=${status} 声称已取得原文，dose_text 不得为空（状态与原文不一致）`,
          );
        }
      }

      // 产出层：边界必须拒绝渲染，且不带任何剂量物件。
      const boundary = evaluateDoseBoundary(item, {});
      if (boundary.renderable) counts.realRenderable += 1;
      if (Object.prototype.hasOwnProperty.call(boundary.dose_card ?? {}, 'dose')) {
        counts.cardsWithDose += 1;
      }
      assert.equal(boundary.dose_count, 0, `${label} ${id} 在 N=0 时不得产出用量卡`);
      assert.equal(
        boundary.dose_card?.renderable,
        false,
        `${label} ${id} 的 DoseCard 在 N=0 时必须为不可渲染（缺项形态）`,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(boundary.dose_card ?? {}, 'dose'),
        false,
        `${label} ${id} 的 DoseCard 不得挂 dose 物件（不得兜底编造剂量）`,
      );
      assert.ok(
        boundary.block_codes.includes(BLOCK_CODES.NO_DOSE_SOURCE),
        `${label} ${id} 必须给出缺项阻断码 no_dose_source，实际 ${JSON.stringify(boundary.block_codes)}`,
      );

      // 展示层：占位文案不得含任何剂量串。
      const display = doseDisplayFor(item);
      assert.equal(
        doseTokensOf(display).size,
        0,
        `${label} ${id} 的展示文案出现了剂量串：${display}`,
      );
      if (!isNonEmptyText(doseText)) {
        assert.ok(
          display.includes('未采集用量字段') || display.includes('不提供用量'),
          `${label} ${id} 的展示文案必须是缺项占位，实际：${display}`,
        );
      }
    }
  }

  assert.equal(
    counts.realRenderable,
    0,
    `N=${POSITIVE_TOTAL}：真实资料用量卡可渲染计数必须为 0，实际 ${counts.realRenderable}｜${SUMMARY_LINE}`,
  );
  assert.equal(counts.cardsWithDose, 0, `真实资料不得挂出任何 dose 物件，实际 ${counts.cardsWithDose}`);

  // 浙江条目体内的统一缺项文案（「不出现任何数值用量」），逐条核对。
  for (const item of projectedB) {
    const body = JSON.stringify(item.body ?? '');
    assert.ok(
      body.includes(ZHEJIANG_DOSE_ABSENT_NOTE),
      `浙江条目 ${item.item_id ?? '(无标识)'} 的正文必须带统一缺项文案`,
    );
    assert.equal(
      doseTokensOf(body).size,
      0,
      `浙江条目 ${item.item_id ?? '(无标识)'} 的正文出现了剂量串（缺项不得写量）`,
    );
  }

  console.log(
    `[GY-I08] 真实资料用量卡可渲染计数=${counts.realRenderable}（逐条 ${counts.checked} 条；` +
      `B 首批 ${projectedB.length} 条，缺项文案「${ZHEJIANG_DOSE_ABSENT_NOTE.slice(0, 14)}…」）｜${SUMMARY_LINE}`,
  );
});

test('GY-I08 空真性：产出文本不得出现两源数据里不存在的剂量串（逐条回查原文）', () => {
  const dataTokens = new Set([
    ...doseTokensOf(readText(SOURCE_A_PATH)),
    ...doseTokensOf(readText(SOURCE_B_PATH)),
  ]);
  // 「对外产出」＝边界 JSON + 展示占位文案 + 卡片里数字/单位/原文条件的**拼接形态**
  // （JSON 里数字与单位是两个字段，拼起来才是用户看到的剂量串）。
  const cardDoseTexts = (boundary) => {
    const dose = boundary?.dose_card?.dose;
    return dose ? [`${dose.number ?? ''}${dose.unit ?? ''}`, String(dose.condition ?? '')] : [];
  };
  const outputs = [];
  for (const item of loadHerbicideRecords().items) {
    const boundary = evaluateDoseBoundary(item, {});
    outputs.push(JSON.stringify(boundary), doseDisplayFor(item), ...cardDoseTexts(boundary));
  }
  const projectedB = loadZhejiangKnowledge().items.filter(
    (item) => item?.kind === 'herbicide_applicability',
  );
  for (const item of projectedB) {
    const boundary = evaluateDoseBoundary(item, {});
    outputs.push(
      JSON.stringify(boundary),
      doseDisplayFor(item),
      ...cardDoseTexts(boundary),
      JSON.stringify(item.body ?? ''),
      JSON.stringify(item.verification ?? ''),
    );
  }

  const fabricated = new Set();
  for (const text of outputs) {
    for (const token of doseTokensOf(text)) if (!dataTokens.has(token)) fabricated.add(token);
  }
  assert.equal(
    fabricated.size,
    0,
    `产出了数据里不存在的剂量串：${[...fabricated].join('、')}（⛔ 不得兜底编造）｜${SUMMARY_LINE}`,
  );

  // 正例控制：同一条回查逻辑作用在合成夹具上**必须**看见剂量串，否则「编造 0」本身是空真。
  const { item: fixtureItem, dose: fixtureDose } = positiveFixture(false);
  const fixtureBoundary = evaluateDoseBoundary(fixtureItem, {});
  const fixtureTokens = new Set(cardDoseTexts(fixtureBoundary).flatMap((text) => [...doseTokensOf(text)]));
  assert.ok(
    fixtureTokens.size > 0,
    '正例控制失败：合成夹具的产出里必须出现剂量串，否则上面的「编造 0」无法证明比对有效',
  );
  const fixtureDataTokens = doseTokensOf(`${fixtureDose.number}${fixtureDose.unit}`);
  for (const token of fixtureTokens) {
    assert.ok(
      fixtureDataTokens.has(token),
      `正例控制失败：夹具产出 ${token} 不在夹具原文「${fixtureDose.number}${fixtureDose.unit}」里`,
    );
  }

  // 负控制：把数据侧没有的剂量串塞进「产出」，回查必须点名它 —— 否则「差集恒空」也是空真。
  const INJECTED_TOKEN = '999千克';
  assert.equal(dataTokens.has(INJECTED_TOKEN), false, `负控制前提不成立：数据侧竟有 ${INJECTED_TOKEN}`);
  const injectedHits = [...doseTokensOf(`对外文案：${INJECTED_TOKEN}/公顷`)].filter(
    (token) => !dataTokens.has(token),
  );
  assert.deepEqual(
    injectedHits,
    [INJECTED_TOKEN],
    '负控制失败：回查必须能抓到数据里不存在的剂量串，否则「编造 0」不可判真假',
  );

  console.log(
    `[GY-I08] 剂量串回查：数据侧 ${dataTokens.size} 个、产出侧 ${outputs.length} 段文本、编造 0 个；` +
      `正例控制（夹具）产出 ${[...fixtureTokens].join('、')}；负控制抓到 ${injectedHits.join('、')}｜${SUMMARY_LINE}`,
  );
});

test('GY-I08 空真性守卫的正例控制：内存夹具确有原文用量时必须真的产出（否则守卫自己也是空真）', () => {
  if (POSITIVE_CONTROL_EMPTY) {
    console.log(
      '[GY-I08] 正例控制：已按 GY_I08_GUARD_POSITIVE_CONTROL_EMPTY=1 掏空夹具剂量（预期本用例转红）',
    );
  }
  const { item, dose } = positiveFixture(POSITIVE_CONTROL_EMPTY);
  const boundary = evaluateDoseBoundary(item, {});

  assert.equal(boundary.renderable, true, '夹具带完整绑定原文用量时必须可渲染');
  assert.equal(boundary.dose_count, 1, '夹具可渲染时 dose_count 必须为 1');
  assert.equal(boundary.dose_card?.renderable, true, '夹具的 DoseCard 必须可渲染');
  assert.deepEqual(
    boundary.dose_card?.dose,
    { number: dose.number, unit: dose.unit, condition: dose.condition },
    '产出的数字/单位/原文条件必须逐字来自夹具（不得补写或换算）',
  );
  assert.deepEqual(boundary.block_codes, [], '可渲染时不得带任何阻断码');

  console.log(
    `[GY-I08] 正例控制：合成夹具 renderable=${boundary.renderable}、dose_count=${boundary.dose_count}、` +
      `剂量「${dose.number}${dose.unit}」、条件「${dose.condition}」`,
  );
});

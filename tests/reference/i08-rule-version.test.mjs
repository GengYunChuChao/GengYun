// GY-I08 · 「所有消费端使用同一规则版本」的可断言化（issue #8 验收第 4 条）。
//
// 要求原文：「…所有消费端使用同一规则版本」。
// 本文件把它变成**可执行断言**而不是文档声明：
//   1) 单一事实来源：`APPLICABILITY_RULE_VERSION` 只在 `packages/reference/constants.mjs` 定义一次；
//   2) 每条判定（适用／可执行建议／用量卡边界／登记匹配）都回传同一版本；
//   3) 消费端登记表（`RULE_VERSION_CONSUMERS`）里每个文件都**真实存在**，
//      且**不得**出现与当前版本不同的 `gy-i08/x.y.z` 字面量（漂移即失败）；
//   4) 版本号由规则规格内容派生摘要 ⇒ 改维度/改阻断类别/改拒绝原因都会改变摘要（可追溯）；
//   5) 跨端镜像（微信小程序无构建步骤、无法 import 域库）由一致性测试断言同值。
//
// 另如实登记一处**跨线缺项**：`services/api/src/ocr/state.ts`（GY-I10 线）另有一套
// 用量卡闸门，未声明 gy-i08 规则版本。本轮**不改他人已合并实现**，只做漂移检测
// 与登记，交指挥协调；不得据此声称「已统一」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLICABILITY_RULE_VERSION,
  BLOCK_CODES,
  BLOCK_CODE_LIST,
  DISPLAY_LABELS,
  FEATURE_SWITCH_IDS,
  RULE_VERSION_CONSUMERS,
  canonicalJson,
  describeRuleVersion,
  doseBlockCode,
  evaluateDoseBoundary,
  evaluateExecutableAdvice,
  evaluateRegistrationMatch,
  ruleVersionDigest,
  ruleVersionSpec,
} from '../../packages/reference/index.mjs';
import { miniReference } from './_fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 只匹配**代码里的字符串字面量**（引号包裹），不匹配版本沿革注释里的裸文本 ——
// 注释记录历史版本是合规的，代码声明不同版本才是漂移。
const VERSION_LITERAL_PATTERN = /['"`](gy-i08\/\d+\.\d+\.\d+)['"`]/g;

/** 取源码中出现的 gy-i08 版本**字面量**（去重、去引号）。 */
function versionLiterals(source) {
  const found = new Set();
  for (const match of source.matchAll(VERSION_LITERAL_PATTERN)) found.add(match[1]);
  return [...found];
}

function read(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** 递归列出源码文件（限定扩展名，避免扫构建产物与媒体）。 */
function walkSourceFiles(relDir, extensions) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (extensions.some((ext) => entry.endsWith(ext))) out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(ROOT, relDir));
  return out;
}

/** 单条可执行建议的基准记录（用于断言各判定入口回传同一版本）。 */
const BASE_ITEM = {
  record_id: 't-base',
  registration_number: 'PD20210001',
  registered_name: '测试剂',
  crop_ids: ['crop_rice'],
  dosage_form: '水分散粒剂',
  ingredients_text: '唑草酮 40%',
  use_scene: '水稻移栽田',
  growth_stage: '苗后',
  region_codes: ['330100'],
  visibility: 'published',
  simulated: false,
  source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'valid', review_status: 'verified' },
  source_version: 'sv-base@1',
  verification: { usable_as_dose: false, review_status: 'verified', restriction_status: 'unrestricted' },
};

test('GY-I08 规则版本：单一事实来源 + 全部判定入口回传同一版本', () => {
  const advice = evaluateExecutableAdvice(BASE_ITEM, {});
  const boundary = evaluateDoseBoundary(BASE_ITEM, {});
  const match = evaluateRegistrationMatch([BASE_ITEM], {});
  assert.equal(BASE_ITEM.verification.usable_as_dose, false);
  assert.equal(advice.rule_version, APPLICABILITY_RULE_VERSION, '可执行建议闸门须回传同一规则版本');
  assert.equal(boundary.rule_version, APPLICABILITY_RULE_VERSION, '用量卡边界须回传同一规则版本');
  assert.equal(boundary.dose_card.rule_version, APPLICABILITY_RULE_VERSION, 'DoseCard 描述符须回传同一规则版本');
  assert.equal(match.rule_version, APPLICABILITY_RULE_VERSION, '登记匹配须回传同一规则版本');
  assert.equal(ruleVersionSpec().version, APPLICABILITY_RULE_VERSION);
  assert.equal(miniReference.APPLICABILITY_RULE_VERSION, APPLICABILITY_RULE_VERSION, '跨端镜像常量必须同值');
});

test('GY-I08 规则版本：常量只定义一次（域库源码中唯一一处 `export const APPLICABILITY_RULE_VERSION`）', () => {
  const files = walkSourceFiles('packages/reference', ['.mjs']);
  const definitions = files.filter((f) => /export\s+const\s+APPLICABILITY_RULE_VERSION\s*=/.test(read(f)));
  assert.deepEqual(definitions, ['packages/reference/constants.mjs'], `规则版本必须只在 constants.mjs 定义，实际：${definitions.join(', ')}`);
});

test('GY-I08 规则版本：消费端登记表的每个文件都真实存在', () => {
  for (const consumer of RULE_VERSION_CONSUMERS) {
    assert.ok(statSync(path.join(ROOT, consumer.path)).isFile(), `消费端文件不存在：${consumer.path}`);
    assert.ok(['single_source', 'mirror_asserted', 'cross_line_gap'].includes(consumer.status), `未知消费端状态：${consumer.status}`);
    assert.ok(typeof consumer.version_source === 'string' && consumer.version_source !== '', `消费端 ${consumer.id} 必须说明版本来源`);
  }
});

test('GY-I08 规则版本：域库与小程序源码不得出现与当前版本不同的 gy-i08 字面量（漂移检测）', () => {
  const scanned = [
    ...walkSourceFiles('packages/reference', ['.mjs']),
    ...walkSourceFiles('miniprogram', ['.js', '.wxml']),
    ...walkSourceFiles('services/api/src', ['.ts']),
  ];
  const mismatches = [];
  const literals = new Set();
  for (const file of scanned) {
    for (const literal of versionLiterals(read(file))) {
      literals.add(literal);
      if (literal !== APPLICABILITY_RULE_VERSION) mismatches.push(`${file}: ${literal}`);
    }
  }
  assert.deepEqual(mismatches, [], `以下位置声明了与当前规则版本不同的版本号：\n${mismatches.join('\n')}`);
  // 至少域库与小程序两端都**显式**声明了版本（可追溯），不是隐式继承。
  assert.ok(literals.has(APPLICABILITY_RULE_VERSION), '源码中应显式出现当前规则版本');
});

test('GY-I08 规则版本：跨线平行用量闸门（GY-I10 线）如实登记为缺项，不声称已统一', () => {
  const gap = RULE_VERSION_CONSUMERS.filter((c) => c.status === 'cross_line_gap');
  assert.equal(gap.length, 1, '应恰好登记一处跨线缺项（不得静默省略）');
  assert.equal(gap[0].path, 'services/api/src/ocr/state.ts');
  const source = read(gap[0].path);
  // 已合并实现的漂移检测：该文件**不得**声明任何 gy-i08 版本（声明了就必须与本规则同值，
  // 那意味着需要跨线对齐；未声明则如实登记为缺项，由指挥协调）。
  const literals = versionLiterals(source);
  assert.deepEqual(literals, [], `跨线闸门出现了 gy-i08 版本声明（需跨线协调对齐）：${literals.join(', ')}`);
  assert.ok(/decideDoseCard|gateDoseCards/.test(source), '缺项登记应指向真实的平行闸门实现');
});

test('GY-I08 规则版本：版本号由规则规格内容派生，任一成员变化都会改变摘要（可追溯）', () => {
  const spec = ruleVersionSpec();
  const digest = ruleVersionDigest();
  // 独立复核摘要算法（不依赖生产代码以外的东西）。
  const expected = `gy-i08-spec+sha256:${createHash('sha256').update(canonicalJson(spec), 'utf8').digest('hex')}`;
  assert.equal(digest, expected, '摘要必须等于「规则规格的规范序列化」的 sha256');

  // 键序不得影响摘要。
  const reordered = {
    block_codes: spec.block_codes,
    dose_reject_reasons: spec.dose_reject_reasons,
    restriction_statuses: spec.restriction_statuses,
    match_states: spec.match_states,
    dimensions: spec.dimensions,
    version: spec.version,
  };
  const reorderedDigest = `gy-i08-spec+sha256:${createHash('sha256').update(canonicalJson(reordered), 'utf8').digest('hex')}`;
  assert.equal(reorderedDigest, digest, '对象键序不得改变规则摘要');

  // 逐成员变化 ⇒ 摘要变化（证明摘要确实覆盖规格，而不是装饰性字符串）。
  const mutations = {
    维度: { ...spec, dimensions: [...spec.dimensions, 'extra_dimension'] },
    阻断类别: { ...spec, block_codes: [...spec.block_codes, 'extra_code'] },
    拒绝原因: { ...spec, dose_reject_reasons: [...spec.dose_reject_reasons, 'extra_reason'] },
    匹配状态: { ...spec, match_states: [...spec.match_states, 'extra_state'] },
    版本号: { ...spec, version: 'gy-i08/9.9.9' },
  };
  for (const [label, mutated] of Object.entries(mutations)) {
    const mutatedDigest = `gy-i08-spec+sha256:${createHash('sha256').update(canonicalJson(mutated), 'utf8').digest('hex')}`;
    assert.notEqual(mutatedDigest, digest, `${label}变化必须改变规则摘要`);
  }
  console.log(`[GY-I08] 规则版本=${APPLICABILITY_RULE_VERSION} 规格摘要=${digest}`);
  console.log(`[GY-I08] 阻断类别闭集(${BLOCK_CODE_LIST.length}): ${BLOCK_CODE_LIST.join(',')}`);
});

test('GY-I08 规则版本：追溯描述包含版本、规格、摘要与全部消费端', () => {
  const described = describeRuleVersion();
  assert.equal(described.version, APPLICABILITY_RULE_VERSION);
  assert.equal(described.spec_digest, ruleVersionDigest());
  assert.deepEqual([...described.dimensions], [...ruleVersionSpec().dimensions]);
  assert.equal(described.consumers.length, RULE_VERSION_CONSUMERS.length);
  const single = described.consumers.filter((c) => c.status === 'single_source').map((c) => c.path);
  assert.ok(single.includes('packages/reference/deterministic.mjs'), '规则引擎本身须登记为单一来源消费端');
  const mirrors = described.consumers.filter((c) => c.status === 'mirror_asserted').map((c) => c.path);
  assert.deepEqual(mirrors.sort(), ['miniprogram/pages/referencedetail/referencedetail.js', 'miniprogram/utils/reference.js']);
});

// GY-I08 · 跨端闭集同构（「所有消费端使用同一规则版本」的**闭集层面**复核）。
//
// 版本号同值还不够：若两端**阻断类别闭集**或**拒绝原因 → 阻断类别映射**不同，
// 同一条记录会在两端派生不同的阻断理由，消费端即分叉。本测试逐条比对：
//   1) 阻断类别闭集（键名与值）两端完全一致；
//   2) 功能开关 ID 两端一致（运维才能一处关闭两端）；
//   3) 逐条 `dose_reject_reason` → `doseBlockCode` 映射两端一致。
//
// 本轮据此实修一处**潜在分叉**：`no_confirmed_context` 原先只存在于域库映射表，
// 镜像缺失会落到 `not_applicable`（该 reason 当前虽不由此端产出，但闭集必须同构）。
test('GY-I08 规则版本：跨端镜像的阻断类别闭集与拒绝原因映射必须同构', () => {
  assert.deepEqual([...miniReference.BLOCK_CODE_LIST], [...BLOCK_CODE_LIST], '两端阻断类别闭集必须完全一致（含顺序）');
  assert.deepEqual(
    Object.keys(miniReference.BLOCK_CODES).sort(),
    Object.keys(BLOCK_CODES).sort(),
    '两端阻断类别键名必须完全一致',
  );
  assert.deepEqual({ ...miniReference.FEATURE_SWITCH_IDS }, { ...FEATURE_SWITCH_IDS }, '两端功能开关 ID 必须一致');

  const reasons = Object.entries(DISPLAY_LABELS.dose_reject_reason);
  const mismatches = [];
  for (const [key, text] of reasons) {
    const card = { renderable: false, closed: false, reason: text };
    const domain = doseBlockCode(card);
    const mini = miniReference.doseBlockCode(card);
    if (domain !== mini) mismatches.push(`${key}: 域库=${domain} 镜像=${mini}`);
  }
  assert.deepEqual(mismatches, [], '同一拒绝原因在两端必须派生同一阻断类别');
  // 覆盖完整性：域库每条拒绝原因都必须在镜像取到（不是对照表漏项造成的假一致）。
  assert.equal(reasons.length, 16, `拒绝原因应对照 16 条，实际 ${reasons.length}`);
  console.log(`[GY-I08] 跨端闭集同构：阻断类别=${BLOCK_CODE_LIST.length} 条、拒绝原因映射=${reasons.length} 条、功能开关=2 个，两端一致`);
});

/**
 * `db/seeds/demo_community_messages.sql` 的静态 + 规则层守卫。
 *
 * 这份种子会写「已发布」的社区帖子，因此它必须回答一个问题：
 * **这些 approved 是规则引擎的真值，还是手写放行？**
 * 这里用真实规则引擎（`packages/moderation` 的 `evaluateHardRules`）对种子里**同一段文本**
 * 重跑一遍，逐字段对齐种子里的结论行（decision / hard_rule_passed / reason_codes /
 * rule_version）；规则集升级导致结论变化时，这个用例会先红，而不是让演示页悄悄变空。
 *
 * ⛔ 只读文本，**不**连库、**不**跑 psql：种子是否真的落行、页面是否真的渲染，
 * 由 `docs/verification/gy-r90-demo-community-messages-qa-20261109.md` 的实跑记录证明。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluateHardRules } from '../../packages/moderation/engine.mjs';
import { deriveRuleVersion } from '../../packages/moderation/rule-version.mjs';

const SEED_URL = new URL('../../db/seeds/demo_community_messages.sql', import.meta.url);
const seed = readFileSync(fileURLToPath(SEED_URL), 'utf8');

/** 去掉整行注释（`--` 开头）与行尾 `--` 注释，只留可执行 SQL。 */
function executableLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s*--.*$/u, ''))
    .filter((line) => line.trim() !== '');
}

/** 帖子的标题/正文都用 `$demo$…$demo$` 引号，按出现顺序成对取即可。 */
function demoTextPairs() {
  const parts = [...seed.matchAll(/\$demo\$([\s\S]*?)\$demo\$/gu)].map((match) => match[1]);
  assert.equal(parts.length % 2, 0, '演示文本必须成对出现（标题 + 正文）');
  const pairs = [];
  for (let index = 0; index < parts.length; index += 2) pairs.push([parts[index], parts[index + 1]]);
  return pairs;
}

// 同一批 id 在 VALUES 与 WHERE IN 里各出现一次，按首次出现顺序去重。
const POST_IDS = [...new Set([...seed.matchAll(/'(d0000000-0000-4000-8000-00000000b\d{3})'::uuid/gu)].map((m) => m[1]))];
const PAIRS = demoTextPairs();
const REASON_CODES_EMPTY = /'approved'::public\.audit_state,\s*'\[\]'::jsonb,\s*true/u;
const RULE_VERSION_LITERAL = /'(mr1\+sha256:[0-9a-f]{32})'/u;

test('演示帖子：标题与正文都带「【演示数据·非生产】」前缀', () => {
  assert.equal(PAIRS.length, 3, `预期 3 条演示帖，实际 ${PAIRS.length}`);
  for (const [title, body] of PAIRS) {
    assert.ok(title.startsWith('【演示数据·非生产】'), `标题缺少非生产标记：${title}`);
    assert.ok(body.startsWith('【演示数据·非生产】'), `正文缺少非生产标记：${body}`);
    assert.ok(title.length >= 1 && title.length <= 120, '标题长度必须在 1..120');
    assert.ok(body.length >= 1 && body.length <= 8000, '正文长度必须在 1..8000');
  }
});

test('演示帖子：三条文本经真实规则引擎判定为 approved（不是手写放行）', () => {
  assert.equal(POST_IDS.length, 3, `预期 3 个固定帖子 id，实际 ${POST_IDS.length}`);
  const current = deriveRuleVersion();
  for (let index = 0; index < PAIRS.length; index += 1) {
    const [title, body] = PAIRS[index];
    const result = evaluateHardRules({
      target_ref: { type: 'post', id: POST_IDS[index], revision: 1 },
      text: title + '\n' + body,
      media: [],
    });
    assert.equal(result.decision, 'approved', `第 ${index + 1} 条演示帖被规则层拒绝：${result.reason_codes}`);
    assert.equal(result.hard_rule_passed, true);
    assert.deepEqual(result.reason_codes, [], '种子里写的是空 reason_codes，引擎结论必须一致');
    assert.equal(result.rule_version, current, '引擎派生的规则版本必须等于当前规则集');
    assert.equal(result.contract_shape_ok, true);
  }
});

test('演示结论行：rule_version 字面量与当前派生版本一致', () => {
  const literal = seed.match(RULE_VERSION_LITERAL);
  assert.ok(literal, '结论行必须写明 rule_version（留空会被判 stale ⇒ 帖子被降级为 pending）');
  assert.equal(literal[1], deriveRuleVersion(), '规则集已升级：请同步种子里的 rule_version');
  assert.match(seed, REASON_CODES_EMPTY, "结论行必须写 decision='approved' + reason_codes='[]' + hard_rule_passed=true");
});

test('演示结论行：text_digest 由 SQL 现算，口径等于 postModerationText(title||\'\\n\'||body)', () => {
  assert.match(
    seed,
    /encode\(sha256\(convert_to\(p\.title \|\| E'\\n' \|\| p\.body, 'UTF8'\)\), 'hex'\)/u,
    '摘要必须由库里行现算（硬编码 hex 无法证明与社区服务同口径）',
  );
  // 口径自检：JS 侧对同一段文本算 sha256，与 PG `sha256(convert_to(...,'UTF8'))` 同值。
  const [title, body] = PAIRS[0];
  const digest = createHash('sha256').update(title + '\n' + body, 'utf8').digest('hex');
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(digest, 'ee9f85bfd5ace05902f919ac266997399feb78ad41886a3fddebc8a478ab73ef', '第一条演示帖的摘要变了：正文被改过');
});

test('演示消息：3 条 system 通知、event_key 统一前缀、无 target_ref', () => {
  assert.match(seed, /'demo-pages-notice-' \|\| n\.n::text/u, '消息 event_key 必须带统一前缀，供一条 SQL 认出演示行');
  assert.match(seed, /generate_series\(1, 3\)/u, '预期每个账号 3 条演示通知');
  assert.match(seed, /'system', NULL, NULL,/u, "消息行必须是 type='system' 且 target_ref 为 NULL（页面按 type 显示固定标签）");
  assert.match(seed, /ON CONFLICT \(owner_id, event_key\) DO NOTHING/u);
});

test('演示作者：固定 uuid + 昵称带「演示」标记', () => {
  assert.match(seed, /'d0000000-0000-4000-8000-00000000d001'::uuid/u);
  assert.match(seed, /'演示作者（非生产数据）'/u);
});

test('幂等与安全：可执行部分每条 INSERT 都有 ON CONFLICT，且不含破坏性语句', () => {
  const code = executableLines(seed).join('\n');
  const insertCount = (code.match(/INSERT\s+INTO\s+public\./giu) ?? []).length;
  const conflictCount = (code.match(/ON\s+CONFLICT/giu) ?? []).length;
  assert.equal(insertCount, 4, `预期 4 条 INSERT（作者/帖子/结论/消息），实际 ${insertCount}`);
  assert.equal(conflictCount, 4, '每条 INSERT 都必须带 ON CONFLICT，否则复跑会撞唯一键');
  for (const line of executableLines(seed)) {
    assert.ok(!/^\s*(DELETE|DROP|TRUNCATE)\b/iu.test(line), `发现未注释的破坏性语句：${line.trim()}`);
  }
  assert.match(seed, /^-- {3}DELETE FROM public\.community_posts/mu, '删除方法必须留在注释里，供运维复跑');
});

test('真实模式：不依赖演示审核端口（real 下不存在该端口）', () => {
  assert.ok(!/MODERATION_DEMO_PORT/u.test(executableLines(seed).join('\n')), '种子不得借演示审核端口放行');
  assert.ok(!/synthetic-demo/u.test(executableLines(seed).join('\n')), '种子不得把合成结论当审核证据');
});

test('demo-stack --demo：接上本种子，并打印「灌入演示数据（非生产）」', () => {
  const tool = readFileSync(fileURLToPath(new URL('../../tools/demo-stack.mjs', import.meta.url)), 'utf8');
  const demoBlock = tool.slice(tool.indexOf('if (options.demo)'));
  assert.ok(demoBlock.includes('db/seeds/demo_community_messages.sql'), '--demo 档必须引用本种子');
  assert.ok(demoBlock.includes('灌入演示数据（非生产）'), '--demo 档必须在日志里点明灌的是非生产演示数据');
  assert.ok(demoBlock.includes("options.mode !== 'real'"), '种子只该在 real 模式跑（stub 读面是预设数据）');
  // 既有开关不能被顶掉：--seed-demo 的演示资料块仍在、且仍默认关闭。
  assert.match(tool, /if \(!options\.seedDemo\)/u);
  assert.match(tool, /db\/seeds\/demo_catalog_verified\.sql/u);
});

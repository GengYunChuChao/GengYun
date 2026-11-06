/**
 * GY-R83 · `#1003`：外发回包元数据（`usage` / 剖面版本串）的**收口**单测。零网络、零 IO。
 *
 * 钉两件事：
 * 1. `readCallMetadata`：只认**顶层对象**、只留**非负整数**、**至多 8 键**、键名形状受限。
 *    ⛔ 这不是「供应商确实这么回」的证据 —— 本仓**没有实测样本**，所以这里只断言
 *    「无论回什么都只能落这几种形状」，即**不信任外来数据**的那一侧。
 * 2. `providerConfigVersionOf`：串形状与迁移 0055 的 CHECK **逐字一致**；只把**主机名**的
 *    8 字符摘要带出去（⛔ 端点原文/路径/query/密钥一个字节都不出现）；超长/非法字符按
 *    阶梯降级（先丢摘要、再退剖面名、最后 `unknown`），⛔ 不抛错。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CALL_USAGE_MAX_KEYS,
  CALL_VERSION_SHAPE,
  providerConfigVersionOf,
  readCallMetadata,
} from '../../services/api/src/recognitions/call-metadata.ts';

/** 迁移 `0055_provider_call_ledger.sql` 里 `provider_call_ledger_version_shape` 的正则原文。 */
const SQL_VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/#+@-]{0,79}$/;

test('usage 只从顶层对象读：非对象 / 缺键 / 数组一律 null', () => {
  assert.equal(readCallMetadata(null), null);
  assert.equal(readCallMetadata(undefined), null);
  assert.equal(readCallMetadata('usage={}'), null);
  assert.equal(readCallMetadata(42), null);
  assert.equal(readCallMetadata([]), null);
  // 缺 usage 键 ⇒ 没给用量（与「给了但一个键都不合法」同为 null，两者对落库等价）。
  assert.equal(readCallMetadata({ choices: [] }), null);
  // usage 本身不是对象 ⇒ null，⛔ 不把数组下标当键。
  assert.equal(readCallMetadata({ usage: [] }), null);
  assert.equal(readCallMetadata({ usage: 'prompt_tokens=1' }), null);
  assert.equal(readCallMetadata({ usage: null }), null);
  // 嵌套在别处（非顶层）的 usage **不认**（只读 `payload.usage` 这一个位置）。
  assert.equal(readCallMetadata({ result: { usage: { prompt_tokens: 1 } } }), null);
});

test('usage 只留非负整数：负数 / 小数 / 字符串 / 布尔 / null / 超大值全丢', () => {
  const usage = readCallMetadata({
    usage: {
      prompt_tokens: 120,
      completion_tokens: 34,
      total_tokens: 154,
      negative: -1,
      fraction: 1.5,
      text: '99',
      flag: true,
      nothing: null,
      // 上界 1e12：超过即丢（防溢出与异常回包把列撑爆）。
      astronomically_large: 1_000_000_000_001,
    },
  });
  assert.deepEqual(usage, { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 });
  // 0 是合法计数（缓存命中时存在合法的 0）。
  assert.deepEqual(readCallMetadata({ usage: { cached_tokens: 0 } }), { cached_tokens: 0 });
  // 全是非法键值 ⇒ null（与「没给」同形）。
  assert.equal(readCallMetadata({ usage: { bad_key_VALUE: 1, '9lives': 2 } }), null);
});

test('usage 键名形状受限 + 至多 8 键（多出来的按回包顺序丢弃）', () => {
  assert.equal(CALL_USAGE_MAX_KEYS, 8);
  const accepted = readCallMetadata({
    usage: {
      Prompt_Tokens: 1, // 大写开头：不认
      'prompt-tokens': 2, // 连字符：不认
      '9prompt': 3, // 数字开头：不认
      p: 4, // 单字符合法
      [`k${'x'.repeat(40)}`]: 5, // 41 字符：超出 40 上限，不认
      [`k${'x'.repeat(39)}`]: 6, // 40 字符：合法
    },
  });
  assert.deepEqual(accepted, { p: 4, [`k${'x'.repeat(39)}`]: 6 });

  const many = {};
  for (let index = 0; index < 20; index += 1) many[`field_${index}`] = index;
  const capped = readCallMetadata({ usage: many });
  assert.equal(Object.keys(capped).length, 8);
  assert.deepEqual(Object.keys(capped), [
    'field_0',
    'field_1',
    'field_2',
    'field_3',
    'field_4',
    'field_5',
    'field_6',
    'field_7',
  ]);
});

test('版本串形状与迁移 0055 的 CHECK 逐字一致', () => {
  // 同一份正则：`CALL_VERSION_SHAPE.source` 必须等于 SQL 里那段（改一边不改另一边 = 运行时 CHECK 拒写）。
  assert.equal(CALL_VERSION_SHAPE.source, SQL_VERSION_SHAPE.source);
  assert.equal(CALL_VERSION_SHAPE.flags, SQL_VERSION_SHAPE.flags);
  for (const sample of [
    'openai-vision-v1#vision-model-test@1a2b3c4d',
    'openai-vision-v1',
    'unknown',
    'a',
  ]) {
    assert.ok(CALL_VERSION_SHAPE.test(sample), sample);
  }
  for (const sample of [
    '',
    ' leading-space',
    'has space',
    '@leading-at', // 首字符必须在 `[A-Za-z0-9]` 里
    'a'.repeat(81), // 80 字符上限
  ]) {
    assert.equal(CALL_VERSION_SHAPE.test(sample), false, sample);
  }
});

test('版本串 = 剖面#模型@主机摘要8，且⛔ 不含端点原文/路径/query/密钥', () => {
  const version = providerConfigVersionOf(
    'openai-vision-v1',
    'vision-model-test',
    'https://vision.example.invalid/v1/chat/completions?api_key=sk-should-never-appear',
  );
  assert.ok(CALL_VERSION_SHAPE.test(version), version);
  assert.match(version, /^openai-vision-v1#vision-model-test@[0-9a-f]{8}$/);
  assert.ok(version.length <= 80);
  // 端点原文、主机名、路径、query、密钥一律不出现（只有 8 字符摘要）。
  for (const secret of ['example.invalid', 'chat/completions', 'api_key', 'sk-should-never-appear', 'https']) {
    assert.equal(version.includes(secret), false, secret);
  }
  // 摘要只吃主机名：换路径/换 query 不改变版本串（否则同等配置会被记成两套剖面）。
  assert.equal(
    providerConfigVersionOf('openai-vision-v1', 'vision-model-test', 'https://vision.example.invalid/v2/other?x=1'),
    version,
  );
  // 稳定：同一输入两次同一串。
  assert.equal(providerConfigVersionOf('openai-vision-v1', 'vision-model-test', 'https://vision.example.invalid/a'), version);
  // 换主机 ⇒ 换摘要。
  assert.notEqual(
    providerConfigVersionOf('openai-vision-v1', 'vision-model-test', 'https://other.example.invalid/v1/chat/completions'),
    version,
  );
});

test('版本串降级阶梯：丢主机摘要 → 退剖面名 → 最后 unknown（⛔ 不抛错）', () => {
  // 模型名含字符类外的空格（`@` 是**允许**的：它是本格式自己的分隔符）⇒ 完整串非法 ⇒ 退到剖面名。
  assert.equal(providerConfigVersionOf('openai-vision-v1', 'model beta', 'https://vision.example.invalid/v1'), 'openai-vision-v1');
  // 模型名 ≥70 字符 ⇒ 完整串超 80 ⇒ 退到剖面名。
  const longModel = 'm'.repeat(70);
  assert.equal(providerConfigVersionOf('openai-vision-v1', longModel, 'https://vision.example.invalid/v1'), 'openai-vision-v1');
  // 端点不是合法 URL（取不到主机名）⇒ 不带摘要，但 `剖面#模型` 仍合法。
  assert.equal(providerConfigVersionOf('openai-vision-v1', 'vision-model-test', 'not-a-url'), 'openai-vision-v1#vision-model-test');
  // 模型名为空 ⇒ 只用剖面名 + 主机摘要（⛔ 不产 `剖面#@摘要` 这种悬空分隔符）。
  const emptyModel = providerConfigVersionOf('openai-vision-v1', '', 'https://vision.example.invalid/v1');
  assert.match(emptyModel, /^openai-vision-v1@[0-9a-f]{8}$/);
  assert.equal(emptyModel.includes('#'), false);
  // 剖面名自己就不合法（空格）⇒ 连剖面名都不可用 ⇒ `unknown`（⛔ 绝不返回空串：列是 NOT NULL）。
  assert.equal(providerConfigVersionOf('bad profile', 'model', 'https://vision.example.invalid/v1'), 'unknown');
  assert.equal(providerConfigVersionOf('x'.repeat(200), 'model', 'https://vision.example.invalid/v1'), 'unknown');
  // 空剖面名 + 空模型名 + 不可解析端点 ⇒ `unknown`。
  assert.equal(providerConfigVersionOf('', '', ''), 'unknown');
});

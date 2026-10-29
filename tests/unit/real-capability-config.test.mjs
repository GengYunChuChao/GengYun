/**
 * GY-R69 · 「真实能力配置自检」的单测。
 *
 * 纪律：**测试从不读真环境**。`tools/lib/real-capability-config.mjs` 是纯函数，
 * `tools/verify-real-capability-config.mjs` 的 `runCli({ argv, env, stdout, stderr })`
 * 把环境与输出收集器都做成形参——所以这里所有用例都是「注入 env → 断言报告」，
 * 不 `delete process.env.X`、不 `process.env.X = ...`、不 spawn 子进程。
 *
 * 覆盖（对应派发要求）：
 *   ① 全缺 ⇒ 每组 needs-user 且缺字段名逐个列出；
 *   ② 全齐 ⇒ 全 ready；
 *   ③ 形态非法（SESSION_SIGNING_KEY 太短／OBJECT_STORAGE_ENDPOINT 不是 URL／CHAT_LLM_MODEL 空串）
 *      ⇒ 仍 needs-user 且形态布尔 false；
 *   ④ 泄密回归：env 里塞哨兵值，人读 + `--json` + stderr + 异常路径都不得出现该串；
 *   ⑤ `--strict` 的 exit 1 与 `--require` 的过滤；
 *   ⑥ 三态口径：非 real ⇒ 全 n-a；`--json` 确定性（同环境两次逐字节相同）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_GROUPS,
  EXIT_STRICT_FAILURE,
  EXIT_USAGE,
  GROUP_IDS,
  evaluateCapabilityConfig,
  exitCodeFor,
  parseCliArgs,
  readExecutionMode,
  renderHuman,
  renderJson,
} from '../../tools/lib/real-capability-config.mjs';
import { runCli } from '../../tools/verify-real-capability-config.mjs';

/** 哨兵：任何输出里出现它就算泄密回归失败。 */
const SENTINEL = 'SENTINEL-SECRET-DO-NOT-PRINT';

/**
 * 「全齐」夹具：**全部是假值**（测试网段 `.invalid`），但每一条都满足对应形态规则。
 * 这些值同时充当「值不得出现在输出里」的探针（见 `no-values` 用例）。
 */
const READY_ENV = Object.freeze({
  APP_EXECUTION_MODE: 'real',
  DATABASE_URL: 'postgresql://gy-test-user:gy-test-pass@db.test.invalid:5432/gengyun',
  SESSION_SIGNING_KEY: 'session-signing-key-material-32b',
  DELETION_LEDGER_KEY: 'deletion-ledger-test-material',
  WECHAT_APP_ID: 'wx0123456789abcdef',
  WECHAT_APP_SECRET: 'wechat-app-secret-test-material',
  OBJECT_STORAGE_ENDPOINT: 'https://cos.test.invalid',
  OBJECT_STORAGE_BUCKET: 'gengyun-media-test',
  OBJECT_STORAGE_ACCESS_KEY: 'object-storage-access-key-test',
  OBJECT_STORAGE_SECRET_KEY: 'object-storage-secret-key-test',
  MEDIA_OBJECT_REF_KEY: 'a'.repeat(64),
  MEDIA_ACCESS_GRANT_ORIGIN: 'https://media-gateway.test.invalid',
  RECOGNITION_PROVIDER_URL: 'https://recognition.test.invalid/v1',
  RECOGNITION_PROVIDER_KEY: 'recognition-provider-key-test',
  TENCENTCLOUD_SECRET_ID: 'tencent-shared-secret-id-test',
  TENCENTCLOUD_SECRET_KEY: 'tencent-shared-secret-key-test',
  CHAT_LLM_ENDPOINT: 'https://chat-llm.test.invalid/v1/chat',
  CHAT_LLM_MODEL: 'gengyun-test-model',
  CHAT_LLM_API_KEY: 'chat-llm-api-key-test-0001',
});

/** 跑一次 CLI 并收集 stdout/stderr（不碰真环境、不起子进程）。 */
function run(args, env) {
  const out = [];
  const err = [];
  const code = runCli({
    argv: args,
    env,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function groupOf(report, id) {
  const group = report.groups.find((item) => item.id === id);
  assert.ok(group, `报告里没有能力组 ${id}`);
  return group;
}

function fieldOf(report, groupId, name) {
  const group = groupOf(report, groupId);
  const field = group.fields.find((item) => item.name === name);
  assert.ok(field, `${groupId} 里没有字段 ${name}`);
  return field;
}

// ---------------------------------------------------------------------------
// ① 全缺
// ---------------------------------------------------------------------------

test('① 全缺（real 模式）⇒ 每一组都是 needs-user，且缺的字段名逐个列出', () => {
  const report = evaluateCapabilityConfig({ env: { APP_EXECUTION_MODE: 'real' } });

  assert.equal(report.executionMode, 'real');
  assert.equal(report.applicable, true);
  assert.equal(report.groups.length, GROUP_IDS.length);
  assert.deepEqual(report.groups.map((group) => group.id), [...GROUP_IDS]);
  assert.deepEqual(report.summary, { ready: 0, 'needs-user': GROUP_IDS.length, 'n-a': 0 });

  for (const group of report.groups) {
    assert.equal(group.state, 'needs-user', `${group.id} 在 real 全缺时必须是 needs-user`);
    assert.equal(group.stateReason, 'fields-missing', group.id);
    // 每条「替代要求」都逐字段点名，不是只报一个总数。
    for (const requirement of group.requirements) {
      assert.deepEqual(requirement.missing, [...requirement.fields], group.id);
      assert.deepEqual(requirement.invalid, [], group.id);
      assert.equal(requirement.satisfied, false, group.id);
    }
    for (const field of group.fields) {
      assert.equal(field.present, false, `${group.id}.${field.name} 应为 missing`);
      assert.equal(field.shapeOk, false, `${group.id}.${field.name} 缺失时形态布尔必须是 false`);
    }
  }

  const human = renderHuman(report);
  for (const group of report.groups) {
    assert.ok(human.includes(group.id), `人读输出缺少能力组 ${group.id}`);
    for (const field of group.fields) {
      assert.ok(human.includes(field.name), `人读输出缺少字段名 ${field.name}`);
    }
  }
});

// ---------------------------------------------------------------------------
// ② 全齐
// ---------------------------------------------------------------------------

test('② 全齐 ⇒ 每一组都是 ready，且逐字段 present + 形态 ok', () => {
  const report = evaluateCapabilityConfig({ env: { ...READY_ENV } });

  assert.deepEqual(report.summary, { ready: GROUP_IDS.length, 'needs-user': 0, 'n-a': 0 });
  for (const group of report.groups) {
    assert.equal(group.state, 'ready', `${group.id} 全齐时必须是 ready（要求：${JSON.stringify(group.requirements)}）`);
    assert.equal(group.stateReason, null, group.id);
    const satisfied = group.requirements.find((requirement) => requirement.satisfied);
    assert.ok(satisfied, group.id);
    // 满足的那一组要求：每个字段都必须 present + 形态 ok。
    for (const name of satisfied.fields) {
      const field = group.fields.find((item) => item.name === name);
      assert.equal(field.present, true, `${group.id}.${name}`);
      assert.equal(field.shapeOk, true, `${group.id}.${name} 形态应合法（规则 ${field.shapeRule}）`);
    }
    // 组内任何「已填」字段都不许形态非法（二选一里没填的那一支可以 missing）。
    for (const field of group.fields) {
      if (field.present) assert.equal(field.shapeOk, true, `${group.id}.${field.name} 已填但形态非法`);
    }
  }
  assert.equal(renderHuman(report).includes('needs-user'), true, '表头里应有 needs-user 这一态的字样');
});

test('②b 二选一：只给 DEEPSEEK_API_KEY（无 CHAT_LLM_API_KEY）也算 chat-llm ready', () => {
  const env = { ...READY_ENV };
  delete env.CHAT_LLM_API_KEY;
  env.DEEPSEEK_API_KEY = 'deepseek-api-key-test-0001';

  const report = evaluateCapabilityConfig({ env });
  assert.equal(groupOf(report, 'chat-llm').state, 'ready');
});

test('②c ASR 专用对缺一半时回退共享对 ⇒ 仍 ready', () => {
  const env = { ...READY_ENV, TENCENTCLOUD_ASR_SECRET_ID: 'tencent-asr-only-id' };
  const report = evaluateCapabilityConfig({ env });
  assert.equal(groupOf(report, 'asr').state, 'ready');
});

// ---------------------------------------------------------------------------
// ③ 形态非法
// ---------------------------------------------------------------------------

test('③ 形态非法 ⇒ 仍 needs-user，且形态布尔为 false（不透露值/长度）', () => {
  const env = {
    ...READY_ENV,
    SESSION_SIGNING_KEY: 'too-short', // 太短
    OBJECT_STORAGE_ENDPOINT: 'cos.test.invalid', // 不是 URL
    CHAT_LLM_MODEL: '', // 空串＝未设
  };

  const report = evaluateCapabilityConfig({ env });

  const session = groupOf(report, 'session');
  assert.equal(session.state, 'needs-user');
  assert.equal(fieldOf(report, 'session', 'SESSION_SIGNING_KEY').shapeOk, false);
  assert.equal(fieldOf(report, 'session', 'SESSION_SIGNING_KEY').present, true, '太短是「填了但非法」，不是 missing');
  assert.equal(session.stateReason, 'fields-missing', '短到不满足要求集合 ⇒ 记 fields-missing');

  const storage = groupOf(report, 'object-storage');
  assert.equal(storage.state, 'needs-user');
  const endpoint = fieldOf(report, 'object-storage', 'OBJECT_STORAGE_ENDPOINT');
  assert.equal(endpoint.present, true);
  assert.equal(endpoint.shapeOk, false);
  assert.equal(endpoint.shapeRule, 'https-url');
  assert.deepEqual(storage.requirements[0].invalid, ['OBJECT_STORAGE_ENDPOINT']);

  const chat = groupOf(report, 'chat-llm');
  assert.equal(chat.state, 'needs-user');
  const model = fieldOf(report, 'chat-llm', 'CHAT_LLM_MODEL');
  assert.equal(model.present, false, '空串按「未设」处理（与 config.ts 的 trimmed() 同口径）');
  assert.equal(model.shapeOk, false);

  // 形态非法的组不得算 ready，也不得在汇总里被吞掉。
  assert.equal(report.summary.ready, GROUP_IDS.length - 3);
});

test('③b 已有一组满足、但组内另一个已填字段非法 ⇒ 仍 needs-user（present-field-invalid）', () => {
  const env = {
    ...READY_ENV,
    CHAT_LLM_API_KEY: 'short', // 1..7 字符 ⇒ 非法
    DEEPSEEK_API_KEY: 'deepseek-api-key-test-0001', // 另一条替代要求是齐的
  };

  const report = evaluateCapabilityConfig({ env });
  const chat = groupOf(report, 'chat-llm');
  assert.ok(chat.requirements.some((requirement) => requirement.satisfied), '替代要求里确实有一条满足');
  assert.equal(chat.state, 'needs-user', '服务会因那个非法字段报错 ⇒ 不许算 ready');
  assert.equal(chat.stateReason, 'present-field-invalid');
  assert.equal(fieldOf(report, 'chat-llm', 'CHAT_LLM_API_KEY').shapeOk, false);
});

test('③c 形态规则 id 是静态常量（不随值变化）', () => {
  const short = evaluateCapabilityConfig({ env: { ...READY_ENV, SESSION_SIGNING_KEY: 'x' } });
  const long = evaluateCapabilityConfig({ env: { ...READY_ENV, SESSION_SIGNING_KEY: 'y'.repeat(40) } });
  assert.equal(fieldOf(short, 'session', 'SESSION_SIGNING_KEY').shapeRule,
    fieldOf(long, 'session', 'SESSION_SIGNING_KEY').shapeRule);
  assert.equal(fieldOf(short, 'session', 'SESSION_SIGNING_KEY').shapeRule, 'length>=32');
});

// ---------------------------------------------------------------------------
// ④ 泄密回归
// ---------------------------------------------------------------------------

test('④ 泄密回归：哨兵值不出现于人读、--json、stderr、异常路径', () => {
  const poisoned = { APP_EXECUTION_MODE: 'real' };
  for (const group of CAPABILITY_GROUPS) {
    for (const field of group.fields) poisoned[field.name] = SENTINEL;
  }
  // 让哨兵既可能「形态合法」也可能「形态非法」，两条分支都要过一遍：
  // 这里刻意混入短值/非 URL 形状，保证形态判定真的跑了。
  poisoned.SESSION_SIGNING_KEY = SENTINEL.slice(0, 5);
  poisoned.OBJECT_STORAGE_ENDPOINT = SENTINEL;
  poisoned.MEDIA_OBJECT_REF_KEY = SENTINEL.repeat(2).slice(0, 64);

  const report = evaluateCapabilityConfig({ env: poisoned, strict: true });
  const texts = [
    renderHuman(report),
    renderJson(report),
    renderHuman(evaluateCapabilityConfig({ env: poisoned, strict: false })),
  ];

  for (const args of [[], ['--json'], ['--strict'], ['--strict', '--require=asr,chat-llm'], ['--help']]) {
    const result = run(args, poisoned);
    texts.push(result.stdout, result.stderr);
  }

  // 用法错误路径（未知参数 / 未知组名）也不许回显环境值。
  for (const args of [['--bogus'], ['--require=nope'], []]) {
    const result = run(args, poisoned);
    texts.push(result.stdout, result.stderr);
  }

  const joined = texts.join('\n');
  assert.ok(joined.length > 0, '输出收集为空 ⇒ 本用例失去意义');
  assert.equal(joined.includes(SENTINEL), false, `输出里出现了哨兵值：${SENTINEL}`);
  assert.equal(joined.includes(SENTINEL.slice(0, 5)), false, '输出里出现了哨兵前缀');
  assert.equal(joined.includes(SENTINEL.slice(-4)), false, '输出里出现了哨兵后 4 位');
  assert.equal(joined.includes('SENTINEL'), false, '输出里出现了哨兵的任何片段');
});

test('④b 异常路径：env getter 抛异常（消息里带哨兵）⇒ 按缺失处理，且不外传异常文本', () => {
  const env = { APP_EXECUTION_MODE: 'real' };
  Object.defineProperty(env, 'DATABASE_URL', {
    enumerable: true,
    get() {
      throw new Error(`refusing to read ${SENTINEL}`);
    },
  });

  const report = evaluateCapabilityConfig({ env, strict: true });
  const database = groupOf(report, 'database');
  assert.equal(database.state, 'needs-user');
  assert.equal(fieldOf(report, 'database', 'DATABASE_URL').present, false);

  const result = run(['--strict'], env);
  assert.equal(result.code, EXIT_STRICT_FAILURE);
  assert.equal(`${result.stdout}${result.stderr}`.includes(SENTINEL), false);
  assert.equal(renderJson(report).includes(SENTINEL), false);
});

test('④c 合法值也不进输出（present 之外不透露任何片段）', () => {
  const report = evaluateCapabilityConfig({ env: { ...READY_ENV }, strict: true });
  const probes = [
    READY_ENV.DATABASE_URL,
    READY_ENV.SESSION_SIGNING_KEY,
    READY_ENV.MEDIA_OBJECT_REF_KEY,
    READY_ENV.OBJECT_STORAGE_SECRET_KEY,
    READY_ENV.WECHAT_APP_SECRET,
    READY_ENV.CHAT_LLM_API_KEY,
  ];
  const joined = `${renderHuman(report)}${renderJson(report)}`;
  for (const probe of probes) {
    assert.equal(joined.includes(probe), false, `输出里出现了配置值：${probe.slice(0, 8)}…`);
  }
  assert.equal(JSON.stringify(report).includes('postgresql://'), false, '输出里出现了连接串形状的值');
});

// ---------------------------------------------------------------------------
// ⑤ --strict 与 --require
// ---------------------------------------------------------------------------

test('⑤ --strict：关注组里缺字段 ⇒ exit 1，并点名组与字段', () => {
  const result = run(['--strict'], { APP_EXECUTION_MODE: 'real' });
  assert.equal(result.code, EXIT_STRICT_FAILURE);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /严格模式判定：FAIL/);
  assert.match(result.stdout, /database（缺 \[DATABASE_URL\]）/);
  assert.match(result.stdout, /asr（缺 \[TENCENTCLOUD_ASR_SECRET_ID、TENCENTCLOUD_ASR_SECRET_KEY\] 或 \[TENCENTCLOUD_SECRET_ID、TENCENTCLOUD_SECRET_KEY\]）/);
});

test('⑤b --strict：全齐 ⇒ exit 0，判定 PASS', () => {
  const result = run(['--strict'], { ...READY_ENV });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /严格模式判定：PASS/);
});

test('⑤c 默认（无 --strict）恒 exit 0：缺字段也不当闸门', () => {
  for (const env of [{ APP_EXECUTION_MODE: 'real' }, {}, { ...READY_ENV }]) {
    const result = run([], env);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /自检模式：退出码恒 0/);
  }
});

test('⑤d --require 过滤：只评估点名的组，汇总也只算它们', () => {
  const result = run(['--json', '--require=asr,chat-llm'], { APP_EXECUTION_MODE: 'real' });
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope, 'explicit');
  assert.deepEqual(report.requiredGroups, ['asr', 'chat-llm']);
  assert.deepEqual(report.groups.map((group) => group.id), ['asr', 'chat-llm']);
  assert.deepEqual(report.summary, { ready: 0, 'needs-user': 2, 'n-a': 0 });
});

test('⑤e --require 只关注齐备的组 ⇒ strict exit 0；关注缺字段的组 ⇒ exit 1', () => {
  assert.equal(run(['--strict', '--require=tts'], { ...READY_ENV }).code, 0);

  const failing = run(['--strict', '--require=tts,media-encryption'], { ...READY_ENV, MEDIA_OBJECT_REF_KEY: 'x' });
  assert.equal(failing.code, EXIT_STRICT_FAILURE);
  assert.match(failing.stdout, /media-encryption（缺 \[MEDIA_OBJECT_REF_KEY\]）/);
  assert.equal(failing.stdout.includes('database'), false, '--require 之外的组不该出现在输出里');
});

test('⑤f --require 同时支持 `--require=a,b` 与 `--require a,b` 两种写法', () => {
  assert.deepEqual(parseCliArgs(['--require=asr,tts']).require, ['asr', 'tts']);
  assert.deepEqual(parseCliArgs(['--require', 'asr,tts']).require, ['asr', 'tts']);
  assert.deepEqual(parseCliArgs(['--require= asr , tts ']).require, ['asr', 'tts']);
});

test('⑤g 用法错误 ⇒ exit 2（未知参数／未知组名／空 --require），不误判为能力缺失', () => {
  for (const args of [['--bogus'], ['--require=nope'], ['--require='], ['--require=,']]) {
    const result = run(args, { APP_EXECUTION_MODE: 'real' });
    assert.equal(result.code, EXIT_USAGE, `参数 ${args.join(' ')} 应判用法错误`);
    assert.equal(result.stdout, '', '用法错误不该产出一份报告');
    assert.match(result.stderr, /用法错误/);
    assert.match(result.stderr, /用法：node tools\/verify-real-capability-config\.mjs/);
  }
});

test('⑤h --help ⇒ exit 0，只打用法', () => {
  const result = run(['--help'], {});
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--strict/);
  assert.match(result.stdout, /可用组：database/);
});

// ---------------------------------------------------------------------------
// ⑥ 三态口径与确定性
// ---------------------------------------------------------------------------

test('⑥ 非 real 模式 ⇒ 所有能力组判 n-a；字段行照样报 present/形态', () => {
  for (const [env, mode, source] of [
    [{ APP_EXECUTION_MODE: 'stub' }, 'stub', 'declared'],
    [{ APP_EXECUTION_MODE: 'preset_demo' }, 'preset_demo', 'declared'],
    [{ APP_EXECUTION_MODE: undefined }, 'stub', 'default'],
    [{ APP_EXECUTION_MODE: 'REAL-TYPO' }, 'stub', 'invalid'],
  ]) {
    const report = evaluateCapabilityConfig({ env: { ...READY_ENV, ...env }, strict: true });
    assert.equal(report.executionMode, mode, JSON.stringify(env));
    assert.equal(report.executionModeSource, source, JSON.stringify(env));
    assert.equal(report.applicable, false);
    for (const group of report.groups) {
      assert.equal(group.state, 'n-a', `${group.id} 在非 real 模式下必须是 n-a`);
      assert.equal(group.stateReason, 'mode-not-real');
      // n-a 不等于「字段信息被抹掉」：已填的字段仍然 present + 形态 ok。
      const present = group.fields.filter((field) => field.present);
      assert.ok(present.length > 0, `${group.id} 在夹具里应有已填字段`);
      assert.equal(present.every((field) => field.shapeOk), true, group.id);
    }
    assert.deepEqual(report.summary, { ready: 0, 'needs-user': 0, 'n-a': GROUP_IDS.length });
    // n-a 不进 strict 失败项：否则 stub 机器上 --strict 天天红。
    assert.equal(report.strict.verdict, 'pass');
    assert.equal(exitCodeFor(report), 0);
  }
});

test('⑥b 未声明/非法模式各留一条 note（口径写进输出，不靠人记）', () => {
  assert.ok(evaluateCapabilityConfig({ env: {} }).notes.some((note) => note.startsWith('mode-undeclared:')));
  assert.ok(evaluateCapabilityConfig({ env: { APP_EXECUTION_MODE: 'nope' } })
    .notes.some((note) => note.startsWith('mode-invalid:')));
  assert.deepEqual(readExecutionMode({}), { mode: 'stub', source: 'default' });
  assert.deepEqual(readExecutionMode({ APP_EXECUTION_MODE: '  real  ' }), { mode: 'real', source: 'declared' });
});

test('⑥c --json 确定性：同一环境两次输出逐字节相同，且键序固定', () => {
  const first = renderJson(evaluateCapabilityConfig({ env: { ...READY_ENV }, strict: true }));
  const second = renderJson(evaluateCapabilityConfig({ env: { ...READY_ENV }, strict: true }));
  assert.equal(first, second);
  assert.equal(renderHuman(evaluateCapabilityConfig({ env: { ...READY_ENV } })),
    renderHuman(evaluateCapabilityConfig({ env: { ...READY_ENV } })));

  const report = JSON.parse(first);
  assert.deepEqual(Object.keys(report), [
    'schemaVersion',
    'tool',
    'executionMode',
    'executionModeSource',
    'applicable',
    'scope',
    'requiredGroups',
    'summary',
    'strict',
    'groups',
    'notes',
  ]);
  assert.deepEqual(Object.keys(report.groups[0]), [
    'id',
    'label',
    'state',
    'stateReason',
    'requirements',
    'fields',
    'missing',
    'alternatives',
  ]);
  assert.deepEqual(Object.keys(report.groups[0].fields[0]), ['name', 'present', 'shapeOk', 'shapeRule']);
  assert.deepEqual(Object.keys(report.groups[0].requirements[0]), [
    'fields',
    'satisfied',
    'missing',
    'invalid',
  ]);
  assert.equal(first.includes('time'), false, '--json 不许带时间戳');
});

test('⑥d 报告里没有值为内容的字段：字段对象只有四个键（name/present/shapeOk/shapeRule）', () => {
  for (const group of evaluateCapabilityConfig({ env: { ...READY_ENV } }).groups) {
    for (const field of group.fields) {
      assert.deepEqual(Object.keys(field), ['name', 'present', 'shapeOk', 'shapeRule']);
      assert.equal(typeof field.present, 'boolean');
      assert.equal(typeof field.shapeOk, 'boolean');
      assert.equal(typeof field.shapeRule, 'string');
    }
  }
});

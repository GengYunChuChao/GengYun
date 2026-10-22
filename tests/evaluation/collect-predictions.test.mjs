// collect-predictions 定向测试：只跑离线路径（--from-file）与"未授权即拒绝"的准入闸门。
// 不发任何网络请求、不读取任何密钥、不写仓库内文件（临时目录 + 结束即清理）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, EXIT, collectFromFile, checkLiveAuthorization, checkSecretArgs } from '../../tools/evaluation/collect-predictions.mjs';
import { toPredictionMap } from '../../tools/evaluation/lib.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'collect-predictions-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

const writeJson = (name, value) => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
};

const moderationBatch = () => [
  { sampleId: 's-002', output: { decision: 'published', hard_rule_passed: true } },
  { sampleId: 's-001', output: { decision: 'blocked', hard_rule_passed: false } },
];

test('[from-file] 合法预测：逐条通过评分口径校验，按 sampleId 排序落盘，可被评分侧读回', () => {
  const raw = writeJson('raw-ok.json', moderationBatch());
  const out = join(tmp, 'pred-ok.json');
  const code = main(['--from-file', raw, '--task', 'ai_moderation', '--out', out]);
  assert.equal(code, EXIT.OK);

  const text = readFileSync(out, 'utf8');
  assert.ok(text.endsWith('\n'), '落盘文件应以换行结束，便于逐字节复算');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['s-001', 's-002'], '必须按 sampleId 排序（同一内容不同顺序 ⇒ 同一文件）');
  // 采集端产物必须能被评分侧原样读回，且额外字段（hard_rule_passed）不被丢。
  const map = toPredictionMap(JSON.parse(text));
  assert.equal(map.size, 2);
  assert.equal(map.get('s-001').hard_rule_passed, false);
});

test('[from-file] 任一条不可评分（缺合法 decision）⇒ 整批拒收、不落盘、exit 4', () => {
  const raw = writeJson('raw-bad.json', [
    { sampleId: 's-001', output: { decision: 'blocked', hard_rule_passed: false } },
    { sampleId: 's-002', output: { decision: 'unknown', hard_rule_passed: true } },
  ]);
  const out = join(tmp, 'pred-bad.json');
  const code = main(['--from-file', raw, '--task', 'ai_moderation', '--out', out]);
  assert.equal(code, EXIT.USAGE, '含不可评分输出必须以 4 退出，不得部分落盘');
  assert.equal(existsSync(out), false, '验收端不能拿到半成品预测文件');
});

test('[from-file] 空预测与未知 task 一律拒收（空文件会被当成"采过数据"）', () => {
  const empty = writeJson('raw-empty.json', {});
  assert.throws(() => collectFromFile({ file: empty, task: 'ai_moderation', out: join(tmp, 'never.json') }), /拒绝落盘：预测为空/);
  const some = writeJson('raw-some.json', moderationBatch());
  assert.throws(() => collectFromFile({ file: some, task: 'not_a_task', out: join(tmp, 'never2.json') }), /未知 task/);
  assert.equal(existsSync(join(tmp, 'never.json')), false);
});

test('[拒绝] 供应商调用开关未授权 ⇒ exit 2、中文原因、不生成任何文件', () => {
  const out = join(tmp, 'must-not-exist.json');
  const code = main(['--live', '--task', 'ai_moderation', '--out', out]);
  assert.equal(code, EXIT.REFUSED);
  assert.equal(existsSync(out), false);

  const verdict = checkLiveAuthorization({ provider: 'tencent' });
  assert.equal(verdict.code, EXIT.REFUSED);
  assert.match(verdict.reason, /拒绝执行/);
  assert.match(verdict.reason, /confirm-paid-calls/, '必须告诉用户授权开关叫什么，而不是静默降级');
});

test('[拒绝] 已带授权开关但本片未实现真实调用 ⇒ exit 3，不用空文件冒充采集结果', () => {
  const out = join(tmp, 'must-not-exist-2.json');
  const code = main(['--live', '--task', 'ai_moderation', '--confirm-paid-calls', '--out', out]);
  assert.equal(code, EXIT.UNIMPLEMENTED);
  assert.equal(existsSync(out), false);
  const verdict = checkLiveAuthorization({ live: true, 'confirm-paid-calls': true });
  assert.match(verdict.reason, /未实现/);
});

test('[拒绝] 密钥类参数一律拒收且不回显取值', () => {
  const value = 'sk-do-not-echo-0123456789';
  const verdict = checkSecretArgs({ 'api-key': value });
  assert.equal(verdict.code, EXIT.REFUSED);
  assert.ok(!verdict.reason.includes(value), '拒绝原因不得回显密钥取值');
  assert.equal(main(['--live', '--api-key', value, '--confirm-paid-calls']), EXIT.REFUSED);
});

test('[dry-run] 默认不联网、不写盘，exit 0', () => {
  const code = main(['--task', 'ai_moderation', '--out', join(tmp, 'dry.json')]);
  assert.equal(code, EXIT.OK);
  assert.equal(existsSync(join(tmp, 'dry.json')), false, 'dry-run 不得写文件');
});

/**
 * 下架页「读取帖子确认」（读面）的纯函数单测 —— `apps/admin/src/lib/post-takedown-read.mjs`。
 *
 * 为什么单独一份：读面是这个页面里最容易被写成「假话」的部分。硬约束有三条，逐条钉在这里：
 * ① 读面成功只用契约字段回填 revision，畸形回执**不回填**；
 * ② 读面失败（403／404／会话过期／网络／5xx）必须给出「为什么读不到 + 手填风险 + 提交照常可用」；
 * ③ 读面状态**不进** `submitBlockReason` —— 读不到不许禁提交按钮。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MANUAL_REVISION_RISK,
  POST_READ_SCOPE,
  READ_FALLBACK_NOTE,
  describePostReadFailure,
  postReadSummary,
  readBlockReason,
} from '../../apps/admin/src/lib/post-takedown-read.mjs';
import { emptyTakedownForm, submitBlockReason, validateTakedownForm } from '../../apps/admin/src/lib/post-takedown-form.mjs';

const POST = {
  id: '3f1d2c9a-1111-4222-8333-444455556666',
  revision: 7,
  author_id: '22222222-2222-4222-8222-222222222222',
  anonymized_author_ref: null,
  title: '玉米地里的草地贪夜蛾怎么打',
  body: '早上打药比中午好，避开高温时段。',
  crop_id: 'corn',
  region_code: '330100',
  media_ids: [],
  visibility: 'private',
  audit_state: 'pending',
  created_at: '2026-10-23T08:12:33.000Z',
  updated_at: '2026-11-01T09:00:00.000Z',
  linked_knowledge_ref: null,
};

function failure(kind, extra = {}) {
  return { ok: false, kind, status: null, code: null, message: '', inContract: true, ...extra };
}

test('读面 scope 与审核队列读面同一个门：sources:read', () => {
  assert.equal(POST_READ_SCOPE, 'sources:read');
});

test('postReadSummary：合法 AdminPost ⇒ 只搬契约字段（标题／作者／可见性／audit_state／revision）', () => {
  const summary = postReadSummary(POST);
  assert.equal(summary.ok, true);
  assert.equal(summary.postId, POST.id);
  assert.equal(summary.title, POST.title);
  assert.equal(summary.author, POST.author_id);
  assert.equal(summary.visibility, 'private');
  assert.equal(summary.auditState, 'pending');
  assert.equal(summary.revision, 7);
  assert.equal(typeof summary.updatedAtLabel, 'string');
  assert.notEqual(summary.updatedAtLabel, '');
});

test('postReadSummary：作者注销（author_id=null）时用匿名引用，不编造「未知作者」', () => {
  const anonymized = postReadSummary({ ...POST, author_id: null, anonymized_author_ref: 'gy-anon-0123456789abcdef' });
  assert.equal(anonymized.ok, true);
  assert.equal(anonymized.author, 'gy-anon-0123456789abcdef');

  const both = postReadSummary({ ...POST, author_id: null, anonymized_author_ref: null });
  assert.equal(both.ok, true);
  assert.equal(both.author, '（作者已注销）');
});

test('postReadSummary：畸形回执（缺必填／revision 非正整数）⇒ ok:false，**不回填** revision', () => {
  const { title: _dropped, ...withoutTitle } = POST;
  const missing = postReadSummary(withoutTitle);
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.length > 0);
  assert.equal('revision' in missing, false, '畸形回执不得带出 revision（否则页面会拿错值回填）');

  const badRevision = postReadSummary({ ...POST, revision: 0 });
  assert.equal(badRevision.ok, false);
  assert.match(badRevision.problems.map((problem) => problem.field).join(','), /revision/);
});

test('postReadSummary：不是对象也走 ok:false（不抛异常）', () => {
  for (const value of [null, undefined, 'x', 42, []]) {
    const summary = postReadSummary(value);
    assert.equal(summary.ok, false);
  }
});

test('describePostReadFailure：非失败输入（成功回执／null）⇒ null，页面不显示回落提示', () => {
  assert.equal(describePostReadFailure(null), null);
  assert.equal(describePostReadFailure(undefined), null);
  assert.equal(describePostReadFailure({ ok: true, post: POST, etag: '"7"' }), null);
  // `ok:false` 但没有 kind：走 default 分支，仍然是「读不到」而不是静默。
  const unknown = describePostReadFailure({ ok: false });
  assert.equal(unknown.code, 'read_failed');
  assert.equal(unknown.tone, 'warn');
});

test('describePostReadFailure：每种失败 kind 都有 title／risk／fallback，且都写明「提交照常可用」', () => {
  const kinds = [
    'forbidden',
    'not_found',
    'signed_out',
    'network_error',
    'unavailable',
    'rate_limited',
    'invalid_request',
    'invalid_response',
    'something_new',
  ];
  for (const kind of kinds) {
    const view = describePostReadFailure(failure(kind, { status: 403, message: '样例失败' }));
    assert.ok(view !== null, `${kind} 必须有提示`);
    assert.equal(view.tone, 'warn', `${kind} 是 warn，不是成功语气`);
    assert.equal(view.risk, MANUAL_REVISION_RISK, `${kind} 必须带手填风险口径`);
    assert.equal(view.fallback, READ_FALLBACK_NOTE, `${kind} 必须带「读失败不阻塞下架」口径`);
    assert.equal(typeof view.title, 'string');
    assert.notEqual(view.title, '', `${kind} 必须说清为什么读不到`);
    assert.match(view.fallback, /提交按钮照常可用/, `${kind} 的回落口径必须明确不禁提交`);
  }
});

test('describePostReadFailure：403 说清缺哪个 scope；404 说明「未找到 ≠ 已删除」', () => {
  const forbidden = describePostReadFailure(failure('forbidden', { status: 403, code: 'SCOPE_DENIED', message: '缺少所需权限：sources:read' }));
  assert.match(forbidden.title, /403/);
  assert.match(forbidden.title, /sources:read/);
  assert.match(forbidden.detail, /SCOPE_DENIED/);
  assert.match(forbidden.detail, /HTTP 403/);

  const notFound = describePostReadFailure(failure('not_found', { status: 404 }));
  assert.match(notFound.title, /404/);
  assert.match(notFound.detail, /409/);
  assert.match(notFound.detail, /已删除/);
});

test('describePostReadFailure：契约外错误码要标注（不假装认识它）', () => {
  const view = describePostReadFailure(failure('network_error', { status: 418, code: 'TEAPOT', inContract: false }));
  assert.match(view.detail, /TEAPOT/);
  assert.match(view.detail, /契约外码/);
});

test('describePostReadFailure：超长服务端消息截断，不把整段原文糊进页面', () => {
  const long = 'x'.repeat(600);
  const view = describePostReadFailure(failure('unavailable', { status: 503, message: long }));
  assert.ok(view.detail.length < 400, '服务端消息必须截断');
  assert.match(view.detail, /已截断/);
});

test('readBlockReason：读面可点 ⇒ null；缺 scope／正在读／ID 非法各有话说', () => {
  assert.equal(readBlockReason({ hasReadScope: true, reading: false, postId: POST.id }), null);

  const missingScope = readBlockReason({ hasReadScope: false, reading: false, postId: POST.id });
  assert.equal(missingScope.code, 'read_scope_missing');
  assert.match(missingScope.message, /sources:read/);
  assert.match(missingScope.message, /不禁提交/, '缺读面 scope 只是读不了，必须说清提交不受影响');

  const reading = readBlockReason({ hasReadScope: true, reading: true, postId: POST.id });
  assert.equal(reading.code, 'reading');

  const badId = readBlockReason({ hasReadScope: true, reading: false, postId: 'not-a-uuid' });
  assert.equal(badId.code, 'post_id');
  assert.match(badId.message, /uuid/);
});

test('读面状态不进 submitBlockReason：读不到帖子时，手填齐了照样可提交（硬约束）', () => {
  const form = { ...emptyTakedownForm(), post_id: POST.id, revision: '7', reason: '社区举报核实', confirmed: true };
  const checked = validateTakedownForm(form);
  assert.equal(checked.ok, true, '手填齐了本地校验必须过');
  assert.deepEqual(checked.problems, []);

  // `submitBlockReason` 只认写面四要素 + scope + 提交中；它没有、也不该有「读面是否成功」这一项。
  assert.equal(submitBlockReason(form, { hasWriteScope: true, submitting: false }), null);
  assert.equal(submitBlockReason(form, { hasWriteScope: false, submitting: false }).code, 'scope_missing');
  assert.equal(submitBlockReason({ ...form, revision: '' }, { hasWriteScope: true, submitting: false }).code, 'revision');
});

/**
 * GY-R72 契约钉子：`/jobs/{id}/cancel` 的 description **必须**把"六个源都按 `Idempotency-Key` 回放"
 * 写成事实，并给出三件事：
 *   ① 同一 Key + 同一 `If-Match` 的原样重试 ⇒ 回放首次结果（200，不写台账、revision 不再 +1）；
 *   ② 同一 Key **换** `If-Match` ⇒ 409 `IDEMPOTENCY_CONFLICT`；
 *   ③ 占位仍在途 ⇒ 409 `REQUEST_IN_PROGRESS`（`retryable:true`）。
 *
 * 为什么值得一条钉子：这句话是本片**唯一**对外的语义承诺。删掉它，`moderation` 会悄悄退回
 * "只校验不回放"，而各域的代码测试（只测 HTTP 状态码）**不会**跟着变红——所以要在这里钉住
 * 契约文本本身（负控制 N4 就删这一句，本条必须红）。
 *
 * 相对路径与读法与 `tests/contract/contract-codes.test.mjs` 同口径（`readFileSync` + `resolve`，不联网）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));

const cancelPath = openapi.paths['/jobs/{id}/cancel'];
const description = cancelPath.post.description;

test('取消端点 description：六个源全部按 Idempotency-Key 回放（审核域不再是例外）', () => {
  assert.match(
    description,
    /六个源（识别／转写／合成／OCR／文字问答／审核）\*\*全部\*\*按 Idempotency-Key 回放/,
    '必须逐源点名"六个源全部回放"；只写"四源"或含糊其辞会让审核域重新变成隐性例外',
  );
});

test('取消端点 description：同键同 If-Match ⇒ 回放首次结果，且不写台账、revision 不再 +1', () => {
  assert.match(
    description,
    /同一 Key \+ 同一 If-Match 的原样重试回放首次结果（200，不再写台账、revision 不再 \+1）/,
    '回放必须写明"不写台账、revision 不再 +1"——否则"回放"和"又取消了一次"在字面上无法区分',
  );
});

test('取消端点 description：同键异体与在途各自的契约码', () => {
  assert.match(description, /同一 Key 换 If-Match ⇒ 409 IDEMPOTENCY_CONFLICT/);
  assert.match(description, /占位仍在途 ⇒ 409 REQUEST_IN_PROGRESS（retryable:true）/);
});

test('取消端点 description：未接线的审核域是唯一例外，且如实写明仍 409 REVISION_CONFLICT', () => {
  assert.match(description, /「未接线的审核域」是唯一例外/);
  assert.match(description, /如实 409 REVISION_CONFLICT/);
});

test('取消端点 409：响应体只引 Error409，而这个响应已登记 REPLAY 相关的两个码', () => {
  assert.deepEqual(cancelPath.post.responses['409'], { $ref: '#/components/responses/Error409' });
  const listed = openapi.components.responses.Error409.description.split(',').map((code) => code.trim());
  for (const code of ['IDEMPOTENCY_CONFLICT', 'REQUEST_IN_PROGRESS', 'REVISION_CONFLICT', 'OBJECT_UNAVAILABLE']) {
    assert.ok(listed.includes(code), `Error409.description 必须登记 ${code}（实得：${listed.join(', ')}）`);
  }
});

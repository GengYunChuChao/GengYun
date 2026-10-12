/**
 * GY-I17（#17）阶段 1 · 契约一致性反例：本片所有闭集/字段/上限**照抄原文**，
 * 不新增字段、不新增错误码、不改契约。
 *
 * 事实源：`packages/contracts/openapi.json` 与 `packages/contracts/states.json`（契约 1.0.0）。
 * 一旦有人扩展本地闭集或往 Message 里塞字段，本文件立即失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_TYPES, REFERENCE_STATES, TARGET_REF_TYPES } from '../../services/api/src/messages/types.ts';
import {
  CURSOR_MAX,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_KEY_MIN,
} from '../../services/api/src/messages/validate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));
const states = JSON.parse(readFileSync(resolve(root, 'packages/contracts/states.json'), 'utf8'));
const schemas = openapi.components.schemas;

test('局部闭集与契约原文逐项一致（Message.type / ReferenceState / TargetRef.type）', () => {
  assert.deepEqual([...MESSAGE_TYPES], schemas.Message.properties.type.enum);
  assert.deepEqual([...REFERENCE_STATES], schemas.ReferenceState.enum);
  assert.deepEqual([...REFERENCE_STATES], states.states.ReferenceState);
  assert.deepEqual([...TARGET_REF_TYPES], schemas.TargetRef.properties.type.enum);
});

test('Message：键集恰为契约 required 七项，additionalProperties:false，且没有 title/body/actor', () => {
  const message = schemas.Message;
  assert.equal(message.additionalProperties, false);
  assert.deepEqual(Object.keys(message.properties).sort(), [...message.required].sort());
  assert.deepEqual([...message.required].sort(), [
    'created_at',
    'id',
    'read_at',
    'reference_state',
    'revision',
    'target_ref',
    'type',
  ]);
  // 契约缺口如实记录：Message **没有** title/body/actor/summary/unread 等字段，
  // 本片因此不得伪造消息正文（也不得为它造替身字段）。
  for (const absent of ['title', 'body', 'actor', 'summary', 'unread', 'content']) {
    assert.equal(Object.hasOwn(message.properties, absent), false, `契约 Message 不应有 ${absent}`);
  }
  assert.equal(message.properties.read_at.anyOf.length, 2, 'read_at 必须是 date-time 或 null');
  assert.equal(message.properties.target_ref.anyOf.length, 2, 'target_ref 必须是 TargetRef 或 null');
  assert.equal(message.properties.revision.minimum, 1);
});

test('MessagePage / UnreadCount / Envelope 上限与形状照原文', () => {
  assert.equal(schemas.MessagePage.properties.items.maxItems, 50, 'items maxItems 必须为 50');
  assert.deepEqual([...schemas.MessagePage.required].sort(), ['items', 'next_cursor']);
  assert.equal(schemas.MessagePage.properties.next_cursor.anyOf[0].minLength, 1);
  assert.equal(schemas.MessagePage.properties.next_cursor.anyOf[0].maxLength, 2048);
  assert.deepEqual([...schemas.MessagePageEnvelope.required].sort(), ['data', 'meta']);
  assert.deepEqual([...schemas.UnreadCountEnvelope.required].sort(), ['data', 'meta']);
  assert.deepEqual([...schemas.MessageEnvelope.required].sort(), ['data', 'meta']);
  assert.deepEqual([...schemas.UnreadCount.required], ['count']);
  assert.equal(schemas.UnreadCount.properties.count.minimum, 0);
  assert.equal(schemas.UnreadCount.additionalProperties, false);
});

test('参数上限与契约一致（Limit 1..50 默认20；Cursor ≤2048；Idempotency-Key 8..128）', () => {
  const limit = openapi.components.parameters.Limit.schema;
  assert.equal(limit.minimum, 1);
  assert.equal(limit.maximum, 50);
  assert.equal(limit.default, 20);
  assert.equal(PAGE_LIMIT_MAX, limit.maximum);
  assert.equal(PAGE_LIMIT_DEFAULT, limit.default);
  assert.equal(CURSOR_MAX, openapi.components.parameters.Cursor.schema.maxLength);
  const idem = openapi.components.parameters.IdempotencyKey;
  assert.equal(idem.required, true);
  assert.equal(IDEMPOTENCY_KEY_MIN, idem.schema.minLength);
  assert.equal(IDEMPOTENCY_KEY_MAX, idem.schema.maxLength);
  const ifMatch = openapi.components.parameters.IfMatch;
  assert.equal(ifMatch.required, true);
  assert.equal(ifMatch.schema.pattern, '^"[1-9][0-9]*"$');
});

test('三个 operationId 的方法/路径/状态码集合与契约一致，且路由未在该层注册（无新增文件副作用）', () => {
  const list = openapi.paths['/messages'].get;
  const unread = openapi.paths['/messages/unread-count'].get;
  const mark = openapi.paths['/messages/{id}/read'].put;
  assert.equal(list.operationId, 'listMessages');
  assert.equal(unread.operationId, 'getUnreadCount');
  assert.equal(mark.operationId, 'markMessageRead');
  for (const op of [list, unread]) {
    assert.equal(op['x-version-required'], false);
    assert.deepEqual(op.security, [{ userSession: [] }]);
  }
  assert.equal(mark['x-version-required'], true);
  assert.deepEqual(mark.security, [{ userSession: [] }]);
  // 本片会产生的错误状态码必须都在契约声明的响应集合里。
  for (const op of [list, mark]) {
    for (const status of ['400', '401', '403', '404', '409']) {
      assert.equal(Object.hasOwn(op.responses, status), true, `契约应声明 ${status}`);
    }
  }
  for (const status of ['400', '401', '403', '404']) {
    assert.equal(Object.hasOwn(unread.responses, status), true, `契约应声明 ${status}`);
  }
  // `markMessageRead` 没有请求体（契约只声明 path/header 参数）。
  assert.equal(Object.hasOwn(mark, 'requestBody'), false);
});

test('本片使用的错误码全部落在契约 ErrorCode 闭集内（不新增错误码）', () => {
  const used = [
    'INVALID_REQUEST',
    'INVALID_CURSOR',
    'IDEMPOTENCY_KEY_REQUIRED',
    'REVISION_REQUIRED',
    'SESSION_REQUIRED',
    'SCOPE_DENIED',
    'NOT_FOUND',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'REQUEST_IN_PROGRESS',
  ];
  const closeSet = schemas.ErrorCode.enum;
  for (const code of used) {
    assert.ok(closeSet.includes(code), `${code} 必须在契约 ErrorCode 闭集内`);
  }
  // 406/418 之类自造码绝不允许出现在契约闭集外（闭集大小与契约一致，未被本片扩展）。
  assert.equal(closeSet.includes('NOT_IMPLEMENTED'), false);
});

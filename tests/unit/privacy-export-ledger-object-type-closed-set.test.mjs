/**
 * N1 · 外发账本写入端口的 `object_type` 闭集校验。
 *
 * 缺口（改前）：`PostgresExportLedger.reserve` 只校验 `objectType` 是 1..40 的字符串，
 * 不校验它是否属于契约 `TargetRef.type` 的 17 值闭集（`packages/privacy/constants.mjs`
 * 的 `EXPORT_OBJECT_TYPES`）。库层 `exports.object_type` 是 `varchar(40)`，0040 明确
 * 未加枚举 CHECK ⇒ 闭集外的值会真实写进账本，随后 `/me/exports` 在
 * `packages/privacy/egress.mjs` 投影时整页 503（fail-closed 但不可用）。
 *
 * 本用例用假 pool（零网络、零真库）：只模拟 `reserve` 所需的 SQL。
 *   1. 正例：闭集内 `media` 照常预留并提交；
 *   2. 负例：闭集外的值（`checked_content` / `turn` / `not_a_type` / 大小写变体）⇒
 *      `INVALID_REQUEST`(400)，且**零查询**（校验必须在任何 SQL 之前，连 provisioned 探测都不发）。
 * 负控制：把 `reserve` 里的闭集校验注释掉，负例立刻变红（见交付报告）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresExportLedger } from '../../services/api/src/privacy/ledger-pg.ts';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const CONSENT_ID = '55555555-5555-4555-8555-555555555555';
const EXPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECIPIENT_ID = 'fixture-weed';
const TEXT_KEY = '44444444-4444-4444-8444-444444444444';
const SENTINEL = '00000000-0000-0000-0000-000000000000';

const BASE = Object.freeze({
  userId: USER_ID,
  authEpoch: 1,
  objectType: 'media',
  objectId: OBJECT_ID,
  objectRevision: 1,
  dataType: 'weed_recognition',
  purpose: 'external_inference',
  recipientId: RECIPIENT_ID,
});

/** `reserve` 成功路径所需的最小假连接池；按 SQL 文本返回固定夹具行。 */
function createFakePool() {
  const queries = [];
  const push = (text, params = []) => queries.push({ text: String(text), params });

  const exportRow = (params) => ({
    id: EXPORT_ID,
    user_id: params[0],
    object_type: params[1],
    object_id: params[2],
    object_key: params[3],
    object_revision: params[4],
    purpose: params[5],
    consent_id: params[6],
    consent_epoch: params[7],
    required_consents: JSON.parse(params[8]),
    recipient_id: params[9],
    recipient_config_version: params[10],
    source_version: params[11],
    state: 'reserved',
    auth_epoch: params[12],
    revision: 1,
    error_code: null,
    job_id: null,
    cancelled_at: null,
    cancellation_reason: null,
    deletion_state: 'active',
    requested_at: '2026-01-01T00:00:00.000Z',
    sent_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });

  const client = {
    release() {},
    async query(text, params = []) {
      push(text, params);
      const sql = String(text);
      if (sql === 'BEGIN' || sql === 'COMMIT' || /SET LOCAL lock_timeout/.test(sql)) return { rows: [] };
      if (/FROM public\.users/.test(sql)) return { rows: [{ id: USER_ID, state: 'active', auth_epoch: 1 }] };
      if (/FROM public\.exports\s+WHERE user_id=[\s\S]*cancelled_at IS NOT NULL/.test(sql)) return { rows: [] };
      if (/FROM public\.privacy_epochs/.test(sql)) return { rows: [{ current_epoch: 1, state: 'granted' }] };
      if (/FROM public\.consent_records/.test(sql)) {
        return {
          rows: [{
            id: CONSENT_ID,
            state: 'granted',
            epoch: 1,
            recipient_ids: [RECIPIENT_ID],
            policy_version: 'v1',
          }],
        };
      }
      if (/FROM public\.recipients/.test(sql)) {
        return {
          rows: [{
            id: RECIPIENT_ID,
            enabled: true,
            config_version: 'fixture-config-v1',
            no_training_verified: true,
            deletion_verified: true,
          }],
        };
      }
      if (/INSERT INTO public\.exports/.test(sql)) return { rows: [exportRow(params)] };
      throw new Error(`未模拟的 SQL：${sql}`);
    },
  };

  return {
    queries,
    async connect() {
      return client;
    },
    async query(text, params = []) {
      push(text, params);
      if (/to_regclass\('public\.export_writebacks'\)/.test(String(text))) {
        return { rows: [{ wb: 'export_writebacks', upd: true, upd_cancel: true }] };
      }
      throw new Error(`未模拟的 pool SQL：${String(text)}`);
    },
  };
}

test('正例：闭集内 object_type=media 照常预留并提交', async () => {
  const pool = createFakePool();
  const ledger = createPostgresExportLedger({ pool });
  const record = await ledger.reserve({ ...BASE });

  assert.equal(record.objectType, 'media');
  assert.equal(record.objectId, OBJECT_ID);
  assert.equal(record.state, 'reserved');

  const insert = pool.queries.find((query) => /INSERT INTO public\.exports/.test(query.text));
  assert.ok(insert, '成功路径应发出 INSERT');
  assert.equal(insert.params[1], 'media');
  assert.ok(pool.queries.some((query) => query.text === 'BEGIN'), '应在事务内写入');
  assert.ok(pool.queries.some((query) => query.text === 'COMMIT'), '应提交事务');
});

test('正例：闭集内 object_type=conversation_turn 走非媒体文本键路径', async () => {
  const pool = createFakePool();
  const ledger = createPostgresExportLedger({ pool });
  const record = await ledger.reserve({
    ...BASE,
    objectType: 'conversation_turn',
    objectId: undefined,
    objectKey: TEXT_KEY,
    dataType: 'checked_content',
    purpose: 'external_inference',
  });

  assert.equal(record.objectType, 'conversation_turn');
  assert.equal(record.objectId, TEXT_KEY);

  const insert = pool.queries.find((query) => /INSERT INTO public\.exports/.test(query.text));
  assert.ok(insert, '成功路径应发出 INSERT');
  assert.equal(insert.params[1], 'conversation_turn');
  assert.equal(insert.params[2], SENTINEL);
  assert.equal(insert.params[3], TEXT_KEY);
});

for (const objectType of ['checked_content', 'turn', 'not_a_type', 'Media']) {
  test(`负例：闭集外 object_type=${JSON.stringify(objectType)} ⇒ INVALID_REQUEST 且零查询`, async () => {
    const pool = createFakePool();
    const ledger = createPostgresExportLedger({ pool });

    await assert.rejects(
      () => ledger.reserve({ ...BASE, objectType }),
      (error) => {
        assert.ok(error instanceof PrivacyError, `应为 PrivacyError，实际 ${error?.name}`);
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.equal(error.status, 400);
        return true;
      },
    );

    assert.deepEqual(pool.queries, [], '闭集校验必须在任何 SQL 之前（零查询）');
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEDIA_STATES, MEDIA_PURPOSES, MEDIA_MAX_DURATION_MS, MEDIA_ACCESS_TTL_MS } from '../../packages/media/constants.mjs';

// GY-I06 不新增迁移：媒体相关表/枚举已由 GY-I02 的 0001 初始迁移冻结。
// 本测试断言 0001 中媒体结构与本模块的限额/枚举一致，防止契约漂移。
const sql = readFileSync(new URL('../../services/api/db/migrations/0001_initial_schema.sql', import.meta.url), 'utf8');

test('0001 已冻结 media_purpose / media_state 枚举且与本模块一致', () => {
  const purposeLine = sql.match(/CREATE TYPE media_purpose AS ENUM \(([^)]*)\)/);
  assert.ok(purposeLine, '未找到 media_purpose 枚举');
  const purposes = [...purposeLine[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(purposes, MEDIA_PURPOSES);

  const stateLine = sql.match(/CREATE TYPE media_state AS ENUM \(([^)]*)\)/);
  const states = [...stateLine[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(states, MEDIA_STATES);
});

test('0001 已冻结 media 表（owner/purpose/sha256/state/revision/object_ref）', () => {
  for (const col of ['owner_id', 'purpose', 'mime', 'bytes', 'sha256', 'state', 'object_ref_cipher', 'revision']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(sql), `media 表缺少列 ${col}`);
  }
  assert.ok(/CREATE TABLE media /.test(sql));
  assert.ok(/CREATE TABLE media_derivatives /.test(sql));
  assert.ok(/CREATE TABLE content_media_refs /.test(sql));
  assert.ok(/CREATE TABLE community_media_grants /.test(sql));
});

test('0001 的 CHECK 约束与本模块限额一致（语音 60 秒 / 正字节数）', () => {
  assert.ok(/duration_ms <= 60000/.test(sql), '缺少 60 秒上限 CHECK');
  assert.ok(/purpose <> 'voice_question' OR duration_ms IS NOT NULL/.test(sql), '缺少语音必须带时长 CHECK');
  assert.ok(/CHECK \(bytes > 0\)/.test(sql), '缺少字节数正数 CHECK');
  assert.equal(MEDIA_MAX_DURATION_MS, 60000);
});

test('0001 的社区取图句柄 TTL ≤ 300 秒与本模块一致', () => {
  assert.ok(/expires_at <= created_at \+ interval '300 seconds'/.test(sql), '缺少 300 秒 TTL CHECK');
  assert.ok(MEDIA_ACCESS_TTL_MS <= 300000);
});

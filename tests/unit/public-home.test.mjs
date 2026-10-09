import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { readRegistrationEvidence } from '../../services/api/src/db/catalog.ts';

const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub' }), logLevel: 'silent', executionMode: 'real', requiresRealCredentials: true };

test('public home refuses missing DB and non-real modes without issuing queries', async () => {
  for (const mode of ['real', 'stub', 'preset_demo']) {
    const app = buildApp({ config: { ...config, executionMode: mode } });
    try {
      const res = await app.inject('/api/v1/public/home');
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(res.json().meta.execution_mode, mode);
      assert.equal(res.headers['cache-control'], 'no-store');
    } finally { await app.close(); }
  }
  const app = buildApp({ config: { ...config, executionMode: 'preset_demo' }, pool: { query() { assert.fail('must not query real DB'); } } });
  try { assert.equal((await app.inject('/api/v1/public/home')).statusCode, 503); }
  finally { await app.close(); }
});

test('public home empty successful query is empty real evidence, no fabricated previews', async () => {
  const app = buildApp({ config, pool: { async query() { return { rows: [] }; } } });
  try {
    const res = await app.inject('/api/v1/public/home');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, { previews: [], human_review_state: 'under_construction' });
    assert.equal(res.json().meta.execution_mode, 'real');
  } finally { await app.close(); }
});

test('database failures use safe contract errors, including statement timeout', async () => {
  for (const [code, status] of [['ECONNREFUSED', 503], ['28P01', 503], ['42501', 503], ['57014', 504]]) {
    const app = buildApp({ config, pool: { async query() { throw Object.assign(new Error('SECRET_DSN SQL private-user'), { code }); } } });
    try {
      const res = await app.inject('/api/v1/public/home');
      assert.equal(res.statusCode, status);
      assert.equal(res.body.includes('SECRET_DSN'), false);
      assert.equal(res.body.includes('private-user'), false);
    } finally { await app.close(); }
  }
});

test('internal registration lookup parameterizes identifiers and refuses demo modes', async () => {
  let captured;
  const pool = { async query(q) { captured = q; return { rows: [] }; } };
  const input = "SYNTHETIC-' OR true --";
  await readRegistrationEvidence(pool, 'real', input);
  assert.deepEqual(captured.values, [input]);
  assert.equal(captured.text.includes(input), false);
  await assert.rejects(readRegistrationEvidence(pool, 'real', ''), { code: 'INVALID_REQUEST' });
  await assert.rejects(readRegistrationEvidence(pool, 'stub', input), { code: 'PROVIDER_UNAVAILABLE' });
});

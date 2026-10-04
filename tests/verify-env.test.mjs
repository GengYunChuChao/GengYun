import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyEnvironment, probeHTTPS, PROVIDERS } from '../tools/verify-env.mjs';

function fixture(endpoint) {
  const config = JSON.parse(readFileSync(new URL('../docs/verification/config.example.json', import.meta.url), 'utf8'));
  config.domain.apiBase = 'https://api.invalid'; config.database.urlEnv = 'DB_URL';
  config.providers.moderation.bizType = 'synthetic_text'; config.providers.moderation.image.bizType = 'synthetic_image';
  if (endpoint !== undefined) for (const [key] of PROVIDERS) { config.providers[key].endpoint = endpoint; if (key === 'moderation') config.providers[key].image.endpoint = endpoint; }
  return config;
}
const env = { WECHAT_APP_SECRET: 'synthetic-secret-value', DB_URL: 'synthetic-db-secret', TOKENHUB_API_KEY: 'synthetic-tokenhub', DEEPSEEK_API_KEY: 'synthetic-deepseek', TENCENTCLOUD_SECRET_ID: 'synthetic-id', TENCENTCLOUD_SECRET_KEY: 'synthetic-key' };
test('six non-HTTPS or invalid endpoints yield zero requests even with probe', async () => {
  for (const endpoint of ['http://vendor.invalid/not-an-api', 'not a URL', 'https://user:synthetic@vendor.invalid', 'https://vendor.invalid?token=synthetic', 'ftp://vendor.invalid', 'https://vendor.invalid/#secret']) {
    let requests = 0;
    const report = await verifyEnvironment({ config: fixture(endpoint), env, probe: true, fetchImpl: async () => { requests++; return { status: 200 }; } });
    assert.equal(requests, 0); assert.ok(report.counts.FAIL >= 6);
    for (const result of Object.values(report.providers)) { assert.equal(result.reachability.state, 'SKIPPED_INVALID_CONFIG'); assert.equal(result.capabilityVerified, false); }
    const direct = await probeHTTPS(endpoint, async () => { requests++; return { status: 200 }; });
    assert.equal(direct.state, 'SKIPPED_INVALID_CONFIG'); assert.equal(requests, 0);
  }
});
test('default valid configuration never fetches or claims capability success', async () => {
  let requests = 0;
  const report = await verifyEnvironment({ config: fixture(), env, fetchImpl: async () => { requests++; } });
  assert.equal(requests, 0); assert.equal(report.counts.FAIL, undefined);
  assert.equal(report.taskVerified, false);
  for (const result of Object.values(report.providers)) { assert.equal(result.configurationComplete, true); assert.equal(result.reachability.state, 'NOT_REQUESTED'); assert.equal(result.capabilityVerified, false); }
  const output = JSON.stringify(report);
  for (const value of Object.values(env)) assert.equal(output.includes(value), false);
});
test('HTTPS host HEAD is unauthenticated, manual redirect, and not API verification', async () => {
  const calls = [];
  const report = await verifyEnvironment({ config: fixture(), env, probe: true, fetchImpl: async (url, options) => { calls.push({ url, options }); return { status: 401 }; } });
  assert.equal(calls.length, 7);
  for (const { url, options } of calls) { assert.ok(url.startsWith('https://')); assert.equal(new URL(url).pathname, '/'); assert.equal(options.method, 'HEAD'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers, undefined); }
  assert.equal(report.taskVerified, false);
  for (const result of Object.values(report.providers)) { assert.equal(result.reachability.state, 'HOST_RESPONDED'); assert.equal(result.capabilityVerified, false); }
  const redirect = await probeHTTPS('https://vendor.invalid', async () => ({ status: 302 }));
  assert.equal(redirect.state, 'REDIRECT_REFUSED'); assert.equal(redirect.capabilityVerified, false);
});
test('privacy/env gate, missing credentials/config, database secrets and network errors fail safely', async () => {
  let requests = 0;
  const unsafe = fixture(); unsafe.privacy.sendRealUserDataBeforeConsent = true;
  const gated = await verifyEnvironment({ config: unsafe, env, probe: true, fetchImpl: async () => { requests++; } });
  assert.equal(requests, 0); assert.ok(gated.counts.FAIL);
  assert.ok((await verifyEnvironment()).counts.FAIL);
  assert.ok((await verifyEnvironment({ config: fixture(), env: {} })).counts.FAIL >= 8);
  assert.ok((await verifyEnvironment({ config: fixture(), env, nodeVersion: '26.0.0' })).counts.FAIL);
  const legacy = fixture(); legacy.database.url = 'postgres://synthetic-password';
  const bad = await verifyEnvironment({ config: legacy, env });
  assert.ok(bad.counts.FAIL); assert.equal(JSON.stringify(bad).includes('synthetic-password'), false);
  const error = await probeHTTPS('https://vendor.invalid', async () => { throw new Error('synthetic-sensitive-response'); });
  assert.equal(error.state, 'NETWORK_ERROR'); assert.equal(JSON.stringify(error).includes('sensitive'), false);
  const timeout = await probeHTTPS('https://vendor.invalid', async () => { const e = new Error(); e.name = 'AbortError'; throw e; });
  assert.equal(timeout.state, 'TIMEOUT');
});

test('Tencent identity and image moderation cannot be silently omitted', async () => {
  const config = fixture(); config.providers.ocr.secretIdEnv = 'MISSING_ID'; delete config.providers.moderation.image;
  const report = await verifyEnvironment({ config, env });
  assert.equal(report.providers.ocr.configurationComplete, false);
  assert.equal(report.providers.moderation.configurationComplete, false);
  assert.equal(report.providers.moderation.imageReachability.state, 'SKIPPED_INVALID_CONFIG');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CHAINS, HARD_LIMITS, PER_CALL_RESERVE_CNY, QUOTED_CEILING_CNY,
  assertCapsOpen, countCredentialLeaks, createCallLedger, installOutboundCounter, resolveLimits, summarizeAccounting,
} from '../../tools/verify-chain-e2e-r29.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(ROOT, 'tools', 'verify-chain-e2e-r29.mjs');

function outDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-chain-e2e-'));
  t.after(() => {
    // 递归清理只针对本用例自己建的临时目录。
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('gy-chain-e2e-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// —— 负控制（派单 §B 自检①与④）：没有 --approve-real-chain 就一次都不许外呼 ——
test('无 --approve-real-chain ⇒ 台账拒绝预留，calls=0 且零外呼', async () => {
  const ledger = createCallLedger({ limits: resolveLimits({}), approveRealChain: false });
  await assert.rejects(
    () => ledger.reserve({ capability: 'tts', authorization: 'gy-r29-chain-e2e', attemptKey: 'k1' }),
    error => error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(ledger.calls, 0, '被拒绝的预留不得计入 calls');
  assert.equal(ledger.reservedCny, 0);
});

test('外呼计数器可证伪：真的调 fetch 会让 outboundSends 从 0 变 1', async () => {
  const counter = installOutboundCounter();
  try {
    assert.equal(counter.outboundSends, 0);
    await assert.rejects(() => fetch('https://tts.tencentcloudapi.com'), error => error.code === 'OUTBOUND_FORBIDDEN');
    assert.equal(counter.outboundSends, 1, '计数器必须真的数到——否则「零外呼」是空话');
  } finally {
    counter.restore();
  }
  assert.equal(counter.outboundSends, 1, 'restore 不得抹掉读数');
});

// —— 上限闸：只许收紧，不许放宽；收到 0 立刻拒绝 ——
test('上限只允许收紧，放宽一律拒绝', () => {
  assert.equal(resolveLimits({ tts: 1 }).tts, 1);
  assert.equal(resolveLimits({}).total, HARD_LIMITS.total);
  for (const [key, value] of [['tts', 3], ['ocr', 9], ['asr', 2 + 1], ['total', 7]]) {
    assert.throws(() => resolveLimits({ [key]: value }), error => error.code === 'LIMIT_WIDENING_FORBIDDEN', `${key}=${value}`);
  }
  assert.throws(() => resolveLimits({ tts: -1 }), error => error.code === 'INVALID_LIMIT');
  assert.throws(() => resolveLimits({ ocr: 1.5 }), error => error.code === 'INVALID_LIMIT');
});

test('上限收到 0 ⇒ 立刻拒绝（合计与单链两条路径都要拦）', () => {
  assert.throws(() => assertCapsOpen(resolveLimits({ total: 0 }), CHAINS), error => error.code === 'CAP_ZERO');
  assert.throws(() => assertCapsOpen(resolveLimits({ asr: 0 }), CHAINS), error => error.code === 'CAP_ZERO');
});

// —— 预算闸：平摊预留让 6 次调用无论单价如何都不会超出派单给的 ¥2.00 ——
test('预留合计不超过预算上限；有授权时第 7 次被合计闸拦住', async () => {
  const limits = resolveLimits({});
  const ledger = createCallLedger({ limits, approveRealChain: true });
  const kinds = ['tts', 'tts', 'ocr', 'ocr', 'asr', 'asr'];
  for (const [index, kind] of kinds.entries()) {
    await ledger.reserve({ capability: kind, authorization: 'gy-r29-chain-e2e', attemptKey: `k${index}` });
  }
  assert.equal(ledger.calls, 6);
  assert.ok(ledger.reservedCny <= QUOTED_CEILING_CNY, `预留 ${ledger.reservedCny} 不得超过 ${QUOTED_CEILING_CNY}`);
  assert.equal(Number((PER_CALL_RESERVE_CNY * HARD_LIMITS.total).toFixed(4)) <= QUOTED_CEILING_CNY, true);
  await assert.rejects(
    () => ledger.reserve({ capability: 'tts', authorization: 'gy-r29-chain-e2e', attemptKey: 'k7' }),
    error => error.code === 'PER_KIND_LIMIT' || error.code === 'TOTAL_LIMIT',
  );
  assert.equal(ledger.calls, 6, '第 7 次被拒后不得留下条目');
});

test('同一尝试键重复预留被拒（防同一请求计费两次）；授权不符等价于未接线', async () => {
  const ledger = createCallLedger({ limits: resolveLimits({}), approveRealChain: true });
  await ledger.reserve({ capability: 'ocr', authorization: 'gy-r29-chain-e2e', attemptKey: 'same' });
  await assert.rejects(
    () => ledger.reserve({ capability: 'ocr', authorization: 'gy-r29-chain-e2e', attemptKey: 'same' }),
    error => error.code === 'ATTEMPT_ALREADY_RESERVED',
  );
  await assert.rejects(
    () => ledger.reserve({ capability: 'ocr', authorization: 'someone-else', attemptKey: 'other' }),
    error => error.code === 'AUTHORIZATION_REQUIRED',
  );
  assert.equal(ledger.calls, 1);
});

// —— 凭据自检只返回值命中数，绝不把值写进任何输出 ——
test('凭据自检只返回值命中数', () => {
  const env = { TENCENTCLOUD_SECRET_ID: 'synthetic-not-a-real-secret-id-value', TENCENTCLOUD_SECRET_KEY: 'synthetic-not-a-real-key' };
  assert.equal(countCredentialLeaks(['无害日志'], env), 0);
  assert.equal(countCredentialLeaks(['x synthetic-not-a-real-key y'], env), 1);
  assert.equal(countCredentialLeaks(['synthetic-not-a-real-secret-id-value synthetic-not-a-real-key'], env), 2);
  // 太短的值（<8）不参与扫描：避免把 'dev' 这类普通词当成泄漏。
  assert.equal(countCredentialLeaks(['dev'], { A: 'dev' }), 0);
});

// —— 端到端负控制：真跑工具，plan-only 臂零外呼且退出 0；上限为 0 臂退出非 0 ——
test('CLI plan-only 臂零外呼、退出 0、证据落盘且 calls=0', t => {
  const dir = outDir(t);
  const result = spawnSync(process.execPath, [TOOL, '--tts', '--ocr', '--asr', `--out-dir=${dir}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SCOPE=plan_only/);
  assert.match(result.stdout, /calls=0 outboundSends=0/);
  assert.match(result.stdout, /value_hits=0/);
  const evidence = JSON.parse(readFileSync(join(dir, 'chain-e2e-r29-phase1-plan.json'), 'utf8'));
  assert.equal(evidence.phase, 'phase1-plan');
  assert.equal(evidence.calls, 0);
  assert.equal(evidence.outboundSends, 0, 'plan-only 必须零外呼');
  assert.equal(evidence.approveRealChain, false);
  assert.deepEqual(evidence.chains.map(chain => chain.chain), ['tts', 'ocr', 'asr']);
  // 三链的闸位勘察必须随证据一起落盘（阶段二不用再翻源码）。
  for (const chain of evidence.chains) {
    assert.ok(chain.gates.length >= 2, chain.chain);
    for (const gate of chain.gates) assert.match(gate.file, /^services\/api\/src\//);
    assert.ok(chain.to200.length > 0);
    assert.ok(chain.unobtainable.some(item => item.startsWith('actualChargeCny')), `${chain.chain} 必须预先把真实扣费写死为未取得`);
  }
});

test('CLI 上限为 0 臂立刻拒绝且退出码非 0，且不写证据', t => {
  const dir = outDir(t);
  for (const flags of [['--limit-total=0'], ['--asr', '--limit-asr=0'], ['--tts', '--limit-tts=9']]) {
    const result = spawnSync(process.execPath, [TOOL, ...flags, `--out-dir=${dir}`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${flags.join(' ')} 必须以非 0 退出`);
    assert.match(result.stderr, /REFUSED /);
    assert.doesNotMatch(result.stdout, /calls=/, '被拒绝的运行不得产出证据读数');
  }
  assert.throws(() => readFileSync(join(dir, 'chain-e2e-r29-phase1-plan.json'), 'utf8'));
});

// —— 正控制：用**纯合成**配置与凭据把「构造路径」真跑一遍 ——
// 值是 synthetic-not-a-real-*，不会命中任何真实账号；本臂只构造、不 synthesize，故零外呼零扣费。
// 它证明的不是「供应商能通」，而是「配置→providerFor→resolveTc3Credentials→createLiveTtsProvider
// 这条链在本 harness 里真的走得通」，从而阶段二的失败不会与 harness 自身的接线错误混为一谈。
function syntheticFixtures(t, credentialsOverride = {}) {
  const dir = outDir(t);
  const config = {
    env: 'dev',
    privacy: { allowUserDataForTraining: false, sendRealUserDataBeforeConsent: false },
    providers: {
      tts: {
        endpoint: 'https://tts.tencentcloudapi.com', authentication: 'TC3-HMAC-SHA256',
        action: 'TextToVoice', apiVersion: '2019-08-23', sdkVersion: '4.1.237', region: 'ap-shanghai',
        timeoutMs: 10000, maxRetries: 0, maxVerificationCalls: 2,
        secretIdEnv: 'TENCENTCLOUD_SECRET_ID', apiKeyEnv: 'TENCENTCLOUD_SECRET_KEY',
        voiceType: 101001, codec: 'mp3', sampleRate: 16000, maxTextCharacters: 100,
      },
      ocr: {
        endpoint: 'https://ocr.tencentcloudapi.com', authentication: 'TC3-HMAC-SHA256',
        action: 'GeneralAccurateOCR', apiVersion: '2018-11-19', sdkVersion: '4.1.322', region: 'ap-shanghai',
        timeoutMs: 10000, maxRetries: 0, maxVerificationCalls: 2,
        secretIdEnv: 'TENCENTCLOUD_SECRET_ID', apiKeyEnv: 'TENCENTCLOUD_SECRET_KEY',
        maxImageBytes: 2097152, mediaTransport: 'inlineBase64',
      },
      asr: {
        endpoint: 'https://asr.tencentcloudapi.com', authentication: 'TC3-HMAC-SHA256',
        action: 'SentenceRecognition', apiVersion: '2019-06-14', sdkVersion: '4.1.315', region: 'ap-shanghai',
        timeoutMs: 10000, maxRetries: 0, maxVerificationCalls: 2,
        secretIdEnv: 'TENCENTCLOUD_SECRET_ID', apiKeyEnv: 'TENCENTCLOUD_SECRET_KEY',
        model: '16k_zh', voiceFormat: 'wav', sampleRate: 16000, channels: 1,
        maxAudioSeconds: 60, maxAudioBase64Bytes: 3145728,
      },
    },
  };
  const credentials = {
    appid: 'wx4407a4b908a69a54',
    appsecret: 'synthetic-not-a-real-appsecret-value',
    deepseekApiKey: 'synthetic-not-a-real-deepseek-key',
    tencentSecretId: 'synthetic-not-a-real-secret-id',
    tencentSecretKey: 'synthetic-not-a-real-secret-key',
    tokenhubApiKey: 'synthetic-not-a-real-tokenhub-key',
    databaseUrl: 'postgres://synthetic-not-a-real-database',
    ...credentialsOverride,
  };
  const configPath = join(dir, 'config.local.json');
  const credentialsPath = join(dir, 'credentials.local.json');
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(credentialsPath, JSON.stringify(credentials));
  return { dir, configPath, credentialsPath, credentials };
}

test('正控制：合成配置 + 合成凭据下 TTS 构造路径真的走到 wired=true，且仍零外呼', t => {
  const { dir, configPath, credentialsPath, credentials } = syntheticFixtures(t);
  const result = spawnSync(process.execPath, [
    TOOL, '--approve-real-chain', `--config=${configPath}`, `--private-env=${credentialsPath}`, `--out-dir=${dir}`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /calls=0 outboundSends=0/);
  assert.match(result.stdout, /value_hits=0/);

  const evidence = JSON.parse(readFileSync(join(dir, 'chain-e2e-r29-phase2-live.json'), 'utf8'));
  assert.equal(evidence.phase, 'phase2-live');
  assert.equal(evidence.calls, 0);
  assert.equal(evidence.outboundSends, 0, '只构造不 synthesize ⇒ 不得有外呼');
  assert.equal(evidence.value_hits, 0, '凭据值不得出现在任何日志里');
  const byChain = new Map(evidence.chains.map(chain => [chain.chain, chain]));

  // TTS：配置零 issue ⇒ 真的构造出可用提供者（live 适配器已在 main）。
  assert.deepEqual(byChain.get('tts').configIssues, []);
  assert.equal(byChain.get('tts').wired, true, `TTS 应构造成功，实际 ${byChain.get('tts').refused}`);
  assert.equal(byChain.get('tts').available, true);
  assert.equal(byChain.get('tts').mediaPort, 'substitute');
  assert.equal(byChain.get('tts').sends, 0);

  // OCR：配置过关，但 main 无注入点 —— 结构性缺口，不是配置问题。
  assert.deepEqual(byChain.get('ocr').configIssues, []);
  assert.equal(byChain.get('ocr').refused, 'BLOCKED_NO_INJECTION_POINT');

  // ASR：配置过关，但 main 无 live 适配器；且凭据名必须是主账号共享配对。
  assert.deepEqual(byChain.get('asr').configIssues, []);
  assert.equal(byChain.get('asr').refused, 'PROVIDER_ADAPTER_ABSENT');
  assert.match(byChain.get('asr').credentialNote, /已使用主账号共享配对/);

  // 证据里不得出现任何凭据值（连片段都不许）。
  const raw = readFileSync(join(dir, 'chain-e2e-r29-phase2-live.json'), 'utf8');
  for (const value of Object.values(credentials)) {
    if (value === credentials.appid) continue; // appid 是公开的微信 AppID，不是密钥
    assert.equal(raw.includes(value), false, '证据文件泄漏了凭据值');
  }
});

// —— 监工 1021-1806 [P2]：最终 CLI/JSON 必须保留**真实**命中数 ——
// 回归面：入口曾无条件 `evidence.value_hits = 0`，把 live 臂的检查结果改写成常量。
// 正控制做法：把合成凭据值设成「某条 say 行里必然出现的一段文字」（≥8 字符才参与扫描），
// 于是 countCredentialLeaks 在 live 臂自己的日志里真的会命中 ⇒ 最终证据必须保留该非零值。
// 值仍是 synthetic（'live provider 构造完成' 是日志文案，不是密钥），不命中任何真实账号。
test('CLI live 臂保留非零凭据命中数：入口不得把 value_hits 无条件清零', t => {
  const canary = 'live provider 构造完成';
  const { dir, configPath, credentialsPath } = syntheticFixtures(t, { tencentSecretKey: canary });
  const result = spawnSync(process.execPath, [
    TOOL, '--approve-real-chain', '--tts', `--config=${configPath}`, `--private-env=${credentialsPath}`, `--out-dir=${dir}`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  // 最终读数里看得见（不是 0），且证据 JSON 与它一致。
  assert.match(result.stdout, /value_hits=1\b/);
  const outFile = join(dir, 'chain-e2e-r29-phase2-live.json');
  const evidence = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(evidence.phase, 'phase2-live');
  assert.equal(evidence.value_hits, 1, 'live 臂的真实命中数必须原样落进证据，不得被入口清零');
  // TTS 构造路径确实走通了 ⇒ 这条日志真的被产出过（不是空跑出来的哨兵）。
  assert.equal(evidence.chains.find(chain => chain.chain === 'tts').wired, true);
  // 证据文件本身仍只留计数：连这个合成长串也不许落盘。
  const raw = readFileSync(outFile, 'utf8');
  assert.equal(raw.includes(canary), false, '证据文件只许出现命中数，不许出现被扫描的值');
});

// —— 逐次记账（指挥 m00277-A「任一次之外的外呼算超出，不得隐瞒」）——
test('summarizeAccounting 把「预留几次」和「实际发几次包」分开对账', async () => {
  let outbound = 0;
  const ledger = createCallLedger({
    limits: resolveLimits({}),
    approveRealChain: true,
    readOutboundSends: () => outbound,
  });
  const before = ledger.snapshot();
  const ticket = await ledger.reserve({ capability: 'tts', authorization: 'gy-r29-chain-e2e', attemptKey: 'k1' });
  outbound += 1; // 模拟真实适配器发了一次包
  await ledger.settle(ticket, { state: 'succeeded', actualChargeCny: null, resultMayHaveBeenProcessed: true });
  const accounting = summarizeAccounting({ snapshotBefore: before, snapshotAfter: ledger.snapshot(), entries: ledger.entries });

  assert.equal(accounting.total.calls, 1);
  assert.equal(accounting.total.outboundSends, 1);
  assert.equal(accounting.total.reservedCny, PER_CALL_RESERVE_CNY);
  assert.equal(accounting.perCall.length, 1);
  assert.equal(accounting.perCall[0].ordinal, 1);
  assert.equal(accounting.perCall[0].outboundDelta, 1, '这一次的外呼必须归到这一次账上');
  assert.equal(accounting.overage.exceeds, false);
});

test('summarizeAccounting 抓得住「绕过台账的第二包」并标成超限', () => {
  // 台账只记 1 次，计数器却走了 2 次 —— 正是必须暴露的那类越限。
  const accounting = summarizeAccounting({
    snapshotBefore: { calls: 0, outboundSends: 0, reservedCny: 0 },
    snapshotAfter: { calls: 1, outboundSends: 2, reservedCny: PER_CALL_RESERVE_CNY },
    entries: [{
      ordinal: 1, kind: 'tts', state: 'succeeded',
      snapshotBefore: { calls: 0, outboundSends: 0, reservedCny: 0 },
      snapshotAfter: { calls: 1, outboundSends: 2, reservedCny: PER_CALL_RESERVE_CNY },
    }],
  });
  assert.equal(accounting.overage.outboundBeyondLedger, 1);
  assert.deepEqual(accounting.overage.excessPerCall, [1]);
  assert.equal(accounting.overage.exceeds, true, '越限必须被判成 exceeds=true，不许静默');
});

test('CLI 证据里带逐次记账读数，且离线两跑都是 calls=0 / overage=none', t => {
  const dir = outDir(t);
  for (const [flags, phase] of [[[], 'phase1-plan'], [['--approve-real-chain'], 'phase2-live']]) {
    const result = spawnSync(process.execPath, [TOOL, ...flags, `--out-dir=${dir}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /accounting calls=0 outbound_delta=0 reserved_delta_cny=0\.0000 overage=none/);

    const evidence = JSON.parse(readFileSync(join(dir, `chain-e2e-r29-${phase}.json`), 'utf8'));
    assert.equal(evidence.accounting.total.calls, 0);
    assert.equal(evidence.accounting.total.outboundSends, 0);
    assert.equal(evidence.accounting.total.reservedCny, 0);
    assert.deepEqual(evidence.accounting.perCall, [], '没外呼就不该有逐次条目');
    assert.equal(evidence.accounting.overage.exceeds, false);
    assert.deepEqual(evidence.accounting.snapshotBefore, { calls: 0, outboundSends: 0, reservedCny: 0 });
  }
});

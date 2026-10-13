// 共用默认值的真实服务回归；时钟、媒体及提供者均为合成夹具，无真实外发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecognitionService } from '../../services/api/src/recognitions/service.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createOcrService } from '../../services/api/src/ocr/service.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { createOcrProvider } from '../../services/api/src/ocr/provider.ts';
import { createOcrMediaPort } from '../../services/api/src/ocr/media.ts';
import { createOcrReferencePort, createOcrDosePort } from '../../services/api/src/ocr/reference.ts';
import { createSpeechService } from '../../services/api/src/speech/service.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';
import { createSpeechProvider } from '../../services/api/src/speech/provider.ts';
import { createSpeechMediaPort } from '../../services/api/src/speech/media.ts';
import { createSynthesisService } from '../../services/api/src/tts/service.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';
import { createTtsProvider } from '../../services/api/src/tts/provider.ts';
import { createSynthesisMediaPort } from '../../services/api/src/tts/media.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const body = { media_id: '22222222-2222-4222-8222-222222222222', media_revision: 1 };
const mode = { executionMode: 'stub' };
const cases = [
  { kind: 'recognition', create: createRecognitionService, store: createMemoryRecognitionStore,
    provider: createStubRecognitionProvider, providerMethod: 'recognize', method: 'createRecognition',
    ports: () => ({ media: createSubstituteMediaPort() }), body },
  { kind: 'ocr', create: createOcrService, store: createMemoryOcrStore,
    provider: () => createOcrProvider(mode), providerMethod: 'extract', method: 'createOcr',
    ports: () => ({ media: createOcrMediaPort('stub'), reference: createOcrReferencePort('stub'), dose: createOcrDosePort('stub') }), body },
  { kind: 'transcription', create: createSpeechService, store: createMemorySpeechStore,
    provider: () => createSpeechProvider(mode), providerMethod: 'transcribe', method: 'createTranscription',
    ports: () => ({ media: createSpeechMediaPort('stub') }), body },
  { kind: 'synthesis', create: createSynthesisService, store: createMemorySynthesisStore,
    provider: () => createTtsProvider(mode), providerMethod: 'synthesize', method: 'createSynthesis',
    ports: () => ({ media: createSynthesisMediaPort('stub'), content: createMemoryCheckedContentPort([
      { type: 'answer', id: 'synthetic-ttl-answer', revision: 1, auditState: 'approved', text: '合成测试文本，不构成资料或能力验收。' },
    ]) }),
    body: { checked_content_ref: { type: 'answer', id: 'synthetic-ttl-answer', revision: 1 }, locale: 'zh-CN' } },
];

for (const fixture of cases) {
  test(`${fixture.kind}: 24小时内复用任务，不滑动、不再次调用提供者；到期回执清理`, async (t) => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    let clockMs = start;
    let calls = 0;
    const provider = fixture.provider();
    assert.equal(typeof provider[fixture.providerMethod], 'function');
    const original = provider[fixture.providerMethod].bind(provider);
    provider[fixture.providerMethod] = async (...args) => { calls++; return original(...args); };
    const baseStore = fixture.store();
    const claims = [];
    const store = { ...baseStore, async claimIdempotent(...args) {
      claims.push(args[2]);
      return baseStore.claimIdempotent(...args);
    } };
    const service = fixture.create({ store, provider, ...fixture.ports(),
      idempotencyHmacKey: 'synthetic-job-ttl-key', now: () => new Date(clockMs) });
    t.after(() => service.settle());
    const input = { userId: USER, body: fixture.body, idempotencyKey: `ttl-${fixture.kind}-0001` };
    const first = await service[fixture.method](input);
    await service.settle();
    assert.equal(first.replayed, false);
    assert.equal(calls, 1);
    assert.equal(claims[0].expiresAt.getTime(), start + 24 * 60 * 60 * 1000);
    for (const at of [start + 6 * 60 * 1000, start + 24 * 60 * 60 * 1000 - 1]) {
      clockMs = at;
      const replay = await service[fixture.method](input);
      assert.equal(replay.replayed, true);
      assert.equal(replay.job.id, first.job.id);
      assert.equal(calls, 1, '窗口内重放不能重复调用提供者');
    }
    clockMs = start + 24 * 60 * 60 * 1000;
    assert.equal(await baseStore.purgeIdempotent(new Date(clockMs)), 1, '重放不滑动：普通回执在首次到期边界实际清理');
    assert.equal(await baseStore.purgeIdempotent(new Date(clockMs)), 0);
    // 仅断言普通回执过期；不据此要求持久业务唯一键也失效或再次计费。
  });
}

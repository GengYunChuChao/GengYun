/**
 * GY-R80 · 识别闭集的**来源锁定**（对应 `#1003` 的「模型答得出、客户端认不出」）。
 *
 * 断言三件事：
 * 1. 已发布物种目录（`packages/knowledge/catalog/species.json` 经 `loadCatalog()`）非空，
 *    且与小程序的随包目录 `miniprogram/data/species.js` **id 集合逐条一致**——两者同源，
 *    模型闭集与客户端主键就不会错位；
 * 2. 目录里的每个 id 都能被适配器的闭集过滤接受（不会因为大小写/空白被判成 no_result）；
 * 3. 生产装配路径里**不再有内置的物种 id 清单**：`provider.ts` / `openai-vision-adapter.ts`
 *    源码中不得出现 `OPENAI_VISION_SKELETON_SPECIES_IDS`，也不得出现 `species_` 字面量常量表。
 *
 * 零网络：不调用任何真实供应商；本文件只读本地文件。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../../packages/reference/catalog.mjs';
import {
  OPENAI_VISION_PROTOCOL,
  buildOpenAiVisionPrompt,
  createOpenAiVisionRecognitionProvider,
  normalizeOpenAiVisionCandidates,
} from '../../services/api/src/recognitions/openai-vision-adapter.ts';
import { RecognitionWiringError } from '../../services/api/src/recognitions/live-ports.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const require = createRequire(import.meta.url);

function catalogIds() {
  const catalog = loadCatalog();
  return (catalog.species ?? []).map((row) => row.id);
}

function miniprogramIds() {
  const raw = require('../../miniprogram/data/species.js');
  const rows = Array.isArray(raw) ? raw : (raw.species ?? []);
  return rows.map((row) => row.id);
}

test('已发布物种目录非空，且与小程序的随包目录 id 集合完全一致', () => {
  const fromCatalog = catalogIds();
  const fromMini = miniprogramIds();
  assert.ok(fromCatalog.length > 0, '物种目录不能为空（空目录会让识别闭集失效）');
  assert.deepEqual([...fromCatalog].sort(), [...fromMini].sort(), '服务端闭集与客户端目录必须同源');
  for (const id of fromCatalog) {
    assert.match(String(id), /^species_[a-z0-9_]+$/, `物种 id 形状不对：${String(id)}`);
  }
});

test('目录里的每个 id 都能过闭集过滤（不会被静默判成 no_result）', () => {
  const ids = catalogIds();
  const payload = {
    candidates: ids.map((id, index) => ({ species_id: id, confidence: 0.9 - index * 0.01, reason: 'ok' })),
  };
  const normalized = normalizeOpenAiVisionCandidates(payload, ids);
  assert.ok(normalized.length > 0, '闭集过滤把全部合法 id 都丢了');
  for (const item of normalized) {
    assert.ok(ids.includes(item.species_id), `产出了闭集外的 id：${item.species_id}`);
  }
  assert.equal(buildOpenAiVisionPrompt(ids).includes(ids[0]), true, '提示词里必须列出目录 id');
});

test('闭集为空时构造期直接拒绝（fail-closed，不构造任何替代实现）', () => {
  assert.throws(
    () =>
      createOpenAiVisionRecognitionProvider({
        endpoint: 'https://example.invalid/v1/chat/completions',
        apiKey: 'test-key',
        model: 'test-model',
        speciesIds: [],
      }),
    (error) => error instanceof RecognitionWiringError,
  );
});

test('生产装配路径不再内置物种 id 清单（闭集只能来自目录）', () => {
  // 通用：两个文件都不得再引用那个骨架常量。
  for (const rel of [
    'services/api/src/recognitions/provider.ts',
    'services/api/src/recognitions/openai-vision-adapter.ts',
  ]) {
    const source = readFileSync(resolve(REPO, rel), 'utf8');
    assert.equal(
      source.includes('OPENAI_VISION_SKELETON_SPECIES_IDS'),
      false,
      `${rel} 里仍有内置的闭集清单：${OPENAI_VISION_PROTOCOL} 的闭集必须来自已发布目录`,
    );
  }

  // 适配器里不得出现任何硬编码物种 id（它的闭集只能由装配处传入）。
  const adapter = readFileSync(resolve(REPO, 'services/api/src/recognitions/openai-vision-adapter.ts'), 'utf8');
  for (const id of catalogIds()) {
    assert.equal(adapter.includes(`'${id}'`), false, `适配器里出现了硬编码物种 id 字面量：${id}`);
  }

  // `provider.ts` 的 openai 分支必须走目录助手，而不是常量。
  const provider = readFileSync(resolve(REPO, 'services/api/src/recognitions/provider.ts'), 'utf8');
  const branch = provider.slice(provider.indexOf('if (profile === OPENAI_VISION_PROTOCOL)'));
  const branchBody = branch.slice(0, branch.indexOf('if (endpoint !== null && apiKey !== null)'));
  assert.match(branchBody, /speciesIds: openAiVisionSpeciesIds\(\)/, 'openai-vision 分支没有从目录取闭集');
});

/**
 * GY-R80 · 识别闭集的**来源锁定**（对应 `#1003` 的「模型答得出、客户端认不出」）。
 *
 * 断言四件事：
 * 1. 已发布物种目录（`packages/knowledge/catalog/species.json` 经 `loadCatalog()`）非空，
 *    且与小程序的随包目录 `miniprogram/data/species.js` **id 多重集一致且各自无重复**——两者同源，
 *    模型闭集与客户端主键就不会错位；
 * 2. 目录里的**每一个** id 都能单独通过闭集过滤（逐条喂，不会被静默判成 no_result），
 *    而闭集外的 id 必须被丢弃；
 * 3. 闭集为空时构造期抛**空集**错误（补 `imageSource`，确保它因「闭集为空」而不是因缺端口失败）；
 * 4. 生产装配路径里**不再有内置的物种 id 清单**：`provider.ts` 的 `openai-vision` 分支切片内
 *    不得出现任何目录 id 字面量，且必须调 `openAiVisionSpeciesIds()`。
 *
 * 每条用例都经过变异验证（见 `#1014`）：删空集守卫 / helper 静默回退常量 / 闭集只给未知 id /
 * 过滤器只留首个 id —— 四种回归各自至少让一条用例变红。
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
  openAiVisionAllowedIds,
} from '../../services/api/src/recognitions/openai-vision-adapter.ts';
import { openAiVisionSpeciesIds } from '../../services/api/src/recognitions/provider.ts';
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

function counts(ids) {
  const map = new Map();
  for (const id of ids) map.set(id, (map.get(id) ?? 0) + 1);
  return map;
}

/** 构造期可用的最小 imageSource：只为让「空集」这条判据先于端口判据触发。 */
function usableImageSource() {
  return { read: () => Buffer.from('r80-fixture-bytes') };
}

test('已发布物种目录非空，且与小程序的随包目录 id 多重集一致、各自无重复', () => {
  const fromCatalog = catalogIds();
  const fromMini = miniprogramIds();
  assert.ok(fromCatalog.length > 0, '物种目录不能为空（空目录会让识别闭集失效）');

  const dupes = [...counts(fromCatalog)].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], `物种目录出现重复 id：${dupes.join(', ')}`);

  const a = counts(fromCatalog);
  const b = counts(fromMini);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), '服务端闭集与客户端目录必须同源（集合）');
  for (const [id, n] of a) {
    assert.equal(b.get(id), n, `id ${id} 在两边的条数不一致（服务端 ${n}，客户端 ${String(b.get(id))}）`);
  }
  for (const id of fromCatalog) {
    assert.match(String(id), /^species_[a-z0-9_]+$/, `物种 id 形状不对：${String(id)}`);
  }
});

test('目录里的每个 id 都能单独通过闭集过滤（逐个喂，不会被静默判成 no_result）', () => {
  const ids = catalogIds();
  assert.ok(ids.length > 0, '物种目录不能为空');

  for (const id of ids) {
    const payload = { candidates: [{ species_id: id, confidence: 0.9, reason: 'ok' }] };
    const normalized = normalizeOpenAiVisionCandidates(payload, ids);
    assert.equal(normalized.length, 1, `id ${id} 被闭集过滤丢掉了（单条候选应原样通过）`);
    assert.equal(normalized[0].species_id, id, `闭集过滤改写了 id：期望 ${id}`);
    assert.equal(normalized[0].rank, 1);
  }

  const prompt = buildOpenAiVisionPrompt(ids);
  for (const id of ids) {
    assert.equal(prompt.includes(id), true, `提示词里缺少目录 id：${id}`);
  }
});

test('装配处从目录拿到的闭集与目录逐条一致（不能裁剪、不能替换）', () => {
  const ids = catalogIds();
  const fromWiring = openAiVisionSpeciesIds();
  assert.deepEqual([...fromWiring], [...ids], '装配处拿到的闭集必须与已发布目录逐条一致');

  const allowed = openAiVisionAllowedIds(ids);
  assert.equal(allowed.length, ids.length, `闭集被裁剪了：目录 ${ids.length} 条，规范后只剩 ${allowed.length} 条`);
  for (const id of ids) {
    assert.equal(allowed.includes(id), true, `闭集里缺了 id：${id}`);
  }
});

test('闭集外的 id 必须被丢弃（不能因为它长得像就放行）', () => {
  const ids = catalogIds();
  const unknown = 'species_not_in_catalog_r80';
  assert.equal(ids.includes(unknown), false, '前置：该 id 不应存在于目录里');
  const payload = { candidates: [{ species_id: unknown, confidence: 0.99, reason: 'should be dropped' }] };
  assert.deepEqual(normalizeOpenAiVisionCandidates(payload, ids), [], '闭集外 id 被放行了');
});

test('闭集为空时构造期直接拒绝（fail-closed，且失败原因是空集本身）', () => {
  assert.throws(
    () =>
      createOpenAiVisionRecognitionProvider({
        endpoint: 'https://example.invalid/v1/chat/completions',
        apiKey: 'test-key',
        model: 'test-model',
        speciesIds: [],
        imageSource: usableImageSource(),
      }),
    (error) => {
      assert.ok(error instanceof RecognitionWiringError, `期望 RecognitionWiringError，实得 ${String(error)}`);
      assert.match(String(error.message), /闭集物种列表为空/, `失败原因不是空集：「${error.message}」`);
      return true;
    },
  );
});

test('生产装配路径不再内置物种 id 清单（闭集只能来自目录）', () => {
  const providerRel = 'services/api/src/recognitions/provider.ts';
  const adapterRel = 'services/api/src/recognitions/openai-vision-adapter.ts';

  for (const rel of [providerRel, adapterRel]) {
    const source = readFileSync(resolve(REPO, rel), 'utf8');
    assert.equal(
      source.includes('OPENAI_VISION_SKELETON_SPECIES_IDS'),
      false,
      `${rel} 里仍有内置的闭集清单：${OPENAI_VISION_PROTOCOL} 的闭集必须来自已发布目录`,
    );
  }

  const adapter = readFileSync(resolve(REPO, adapterRel), 'utf8');
  for (const id of catalogIds()) {
    assert.equal(adapter.includes(`'${id}'`), false, `适配器里出现了硬编码物种 id 字面量：${id}`);
  }

  const provider = readFileSync(resolve(REPO, providerRel), 'utf8');
  assert.match(
    provider,
    /import\s*\{\s*loadCatalog\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/\.\.\/packages\/reference\/catalog\.mjs'/,
    'provider.ts 没有从目录装载器取闭集',
  );

  const start = provider.indexOf('if (profile === OPENAI_VISION_PROTOCOL)');
  assert.ok(start >= 0, '找不到 openai-vision 分支');
  const end = provider.indexOf('if (endpoint !== null && apiKey !== null)');
  assert.ok(end > start, '找不到分支结束标记');
  const branch = provider.slice(start, end);

  assert.match(branch, /speciesIds: openAiVisionSpeciesIds\(\)/, 'openai-vision 分支没有从目录取闭集');
  for (const id of catalogIds()) {
    assert.equal(branch.includes(id), false, `openai-vision 分支里出现了目录 id 字面量（静默回退形态）：${id}`);
  }
  assert.equal(
    /species_[a-z0-9_]{3,}/.test(branch.replace(/speciesIds/g, '')),
    false,
    'openai-vision 分支里出现了 species_ 字面量',
  );

  // 目录助手自身也不许静默回退：它必须只从 loadCatalog() 取，不许出现任何目录 id 字面量。
  const helperStart = provider.indexOf('export function openAiVisionSpeciesIds');
  assert.ok(helperStart >= 0, '找不到目录助手 openAiVisionSpeciesIds');
  const helperEnd = provider.indexOf('\n}', helperStart);
  assert.ok(helperEnd > helperStart, '找不到目录助手的结束位置');
  const helper = provider.slice(helperStart, helperEnd);
  assert.match(helper, /loadCatalog\(\)/, '目录助手没有调用 loadCatalog()');
  for (const id of catalogIds()) {
    assert.equal(helper.includes(id), false, `目录助手里出现了目录 id 字面量（静默回退形态）：${id}`);
  }
  assert.equal(/species_[a-z0-9_]{3,}/.test(helper), false, '目录助手里出现了 species_ 字面量');
});

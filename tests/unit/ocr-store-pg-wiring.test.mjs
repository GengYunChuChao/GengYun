/**
 * GY-R27 S10（#10）· OCR 域**持久化接线选择**的单元判据（不起服务、不连库）。
 *
 * 判据（与派单 §4.3/§4.4 逐条对应）：
 *   1) `real` 且 `pool !== null` ⇒ `app.ocrService.describe().storePersistent === true`（PG store 接上）；
 *   2) `real` 但 `pool === null` ⇒ **false**（如实内存，绝不冒充持久化）；
 *   3) `stub` / `preset_demo` 即使有池 ⇒ **false**（非 real 不换实现，行为与接线前逐字一致）；
 *   4) PG store 在**构造期不发任何查询**（`real + 池` 不得在启动时偷偷打库）；
 *   5) 结构钉子（源码级）：装配行仍恰四个键、`app.ts` 仍不引用 OCR 域适配器模块、
 *      且"有池才给池"的判定表达式仍在 —— 这三条一起防止"某天有人把实现换成永远 PG/永远内存"。
 *
 * 反向控制（本文件自带牙齿）：
 *   * 判据 2 的正向反例就是判据 1：同一条断言在两种池状态下必须给出**不同**结果
 *     （若接线退化成"永远内存"或"永远 PG"，必有一条红）；
 *   * 结构钉子里的表达式若被删掉，判据 5 红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_SOURCE = readFileSync(join(ROOT, 'services/api/src/app.ts'), 'utf8');

/** 记录型假池：只实现 `query`（`buildApp` 的隐私账本需要 `connect()`，缺它会走"未装配"分支并只记警告）。 */
function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(text, values) {
      queries.push({ text: String(text).replace(/\s+/g, ' ').trim(), values });
      return { rows: [] };
    },
  };
}

function makeApp({ executionMode, pool = null }) {
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode };
  return buildApp({ config, pool, store: createMemoryAuthStore() });
}

test('接线选择：real + 池 ⇒ PG store（persistent=true）', async (t) => {
  const pool = makeRecordingPool();
  const app = makeApp({ executionMode: 'real', pool });
  t.after(() => app.close());

  assert.equal(
    app.ocrService.describe().storePersistent,
    true,
    'real + pool 必须接 PostgreSQL store（否则"重启不丢"无从谈起）',
  );
  // 构造期不得打库：接线不是"启动时先查一次库"。
  assert.deepEqual(pool.queries, [], `OCR 域构造期不得发任何查询（现场 ${pool.queries.length} 条）`);
});

test('不冒充持久：real + 无池 ⇒ 内存 store（persistent=false）', async (t) => {
  const app = makeApp({ executionMode: 'real', pool: null });
  t.after(() => app.close());

  assert.equal(
    app.ocrService.describe().storePersistent,
    false,
    'real 但无池必须如实标注不持久（⛔ 不得回退内存并声称已持久化）',
  );
});

test('非 real 不换实现：stub / preset_demo 即使有池也用内存 store', async (t) => {
  for (const executionMode of ['stub', 'preset_demo']) {
    const pool = makeRecordingPool();
    const app = makeApp({ executionMode, pool });
    t.after(() => app.close());
    assert.equal(
      app.ocrService.describe().storePersistent,
      false,
      `${executionMode} + pool 必须仍是内存 store（接线前行为逐字不变）`,
    );
    assert.deepEqual(pool.queries, [], `${executionMode} + pool 不得发出任何查询`);
  }
});

test('结构钉子：装配行恰四键、app.ts 不引用 OCR 适配器、有池才给池', () => {
  // ① 装配行仍是「guards + 隐私域 consent/egress + 历史域 history」四个键。
  //    `tests/integration/ocr-http.mjs` 用同一条判据（本文件只是让它在 unit 层也红得起来）。
  const registrationLine = APP_SOURCE.split(/\r?\n/).find((line) =>
    line.includes('registerOcrRoutes(app, config,'),
  );
  assert.notEqual(registrationLine, undefined, 'app.ts 必须有 OCR 域装配行');
  const keys = [...registrationLine.matchAll(/([A-Za-z]+):/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    keys,
    ['consent', 'egress', 'guards', 'history'],
    `装配行只允许这四个键（不得塞入 store/provider/pool 等适配器端口）：${registrationLine.trim()}`,
  );

  // ② `app.ts` 不得引用任何 OCR 适配器模块（provider/store/media/reference）。
  for (const forbidden of ['ocr/provider', 'ocr/store', 'ocr/media', 'ocr/reference']) {
    assert.equal(
      APP_SOURCE.includes(forbidden),
      false,
      `app.ts 不得引用 ${forbidden}（存储实现在域内选定，装配路径不接触适配器）`,
    );
  }

  // ③ 「`real` 才把池交出去」的判定必须**在装配层**可见（删掉它 ⇒ 非 real 也会接库）。
  assert.match(
    APP_SOURCE,
    /const ocrPersistencePool = config\.executionMode === 'real' \? pool : null;/,
    'app.ts 必须有 `real ? pool : null` 的池选择判定（否则非 real 模式会意外接库）',
  );
  // ④ 池必须以**位置实参**传进去（不是 deps 的键），否则键集判据会被绕过/打红。
  assert.match(
    registrationLine,
    /\}, ocrPersistencePool\);$/,
    `装配行的第 4 个实参必须是 ocrPersistencePool：${registrationLine.trim()}`,
  );
});

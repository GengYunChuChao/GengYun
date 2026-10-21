/**
 * GY-R28 S20（#20）· 语音域**持久化接线选择**的单元判据（不起服务、不连库）。
 *
 * 判据（与派单 §2.3 及裁决 B 逐条对应；选择点落在此片的装配路径上）：
 *   0) 注入优先：即便 `real + 池`，显式注入的 store 也不被替换；
 *   1) `real` 且 `pool !== null` ⇒ `app.speechService.describe().storePersistent === true`（PG store 接上）；
 *   2) `real` 但 `pool === null` ⇒ **false**（如实内存，绝不冒充持久化）；
 *   3) `stub` / `preset_demo` 即使有池 ⇒ **false**（非 real 不换实现，行为与接线前逐字一致）；
 *   4) PG store 在**构造期不发任何查询**（`real + 池` 不得在启动时偷偷打库）；
 *   5) 结构钉子（源码级）：装配行仍恰七个键且池以**位置实参**传入、`app.ts` 只以
 *      `import type` 接触 `speech/store`（不接触 provider/media 适配器）、路由层的三态表达式仍在。
 *
 * 反向控制（本文件自带牙齿）：
 *   * 判据 2 的正向反例就是判据 1：同一条断言在两种池状态下必须给出**不同**结果
 *     （若接线退化成"永远内存"或"永远 PG"，必有一条红）；
 *   * 判据 0 是判据 1 的反例：注入存在的同一模式下判据 1 为 true、判据 0 为 false；
 *   * 结构钉子里的表达式/键集若被改动，判据 5 红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_SOURCE = readFileSync(join(ROOT, 'services/api/src/app.ts'), 'utf8');
const ROUTE_SOURCE = readFileSync(join(ROOT, 'services/api/src/routes/speech.ts'), 'utf8');

/** 记录型假池：只实现 `query`（`buildApp` 的隐私账本需要 `connect()`，缺它只记警告、不抛错）。 */
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

function makeApp({ executionMode, pool = null, speechStore = undefined }) {
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode };
  return buildApp({
    config,
    pool,
    store: createMemoryAuthStore(),
    ...(speechStore === undefined ? {} : { speechStore }),
  });
}

test('接线选择：注入优先（显式注入的 store 不被 real + 池替换）', async (t) => {
  const pool = makeRecordingPool();
  const injected = createMemorySpeechStore();
  const app = makeApp({ executionMode: 'real', pool, speechStore: injected });
  t.after(() => app.close());

  assert.equal(
    app.speechService.describe().storePersistent,
    false,
    '显式注入的内存在 real + 池 下也必须保留（注入优先，不得被替换成 PG）',
  );
  assert.equal(app.speechService.describe().storePersistent, injected.persistent);
  // 注入被尊重时也不得为"准备 PG"而打库
  assert.deepEqual(pool.queries, [], `注入优先路径不得发任何查询（现场 ${pool.queries.length} 条）`);
});

test('接线选择：real + 池 ⇒ PG store（persistent=true），且构造期零查询', async (t) => {
  const pool = makeRecordingPool();
  const app = makeApp({ executionMode: 'real', pool });
  t.after(() => app.close());

  assert.equal(
    app.speechService.describe().storePersistent,
    true,
    'real + pool 必须接 PostgreSQL store（否则"重启不丢"无从谈起）',
  );
  assert.deepEqual(pool.queries, [], `语音域构造期不得发任何查询（现场 ${pool.queries.length} 条）`);
});

test('不冒充持久：real + 无池 ⇒ 内存 store（persistent=false）', async (t) => {
  const app = makeApp({ executionMode: 'real', pool: null });
  t.after(() => app.close());

  assert.equal(
    app.speechService.describe().storePersistent,
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
      app.speechService.describe().storePersistent,
      false,
      `${executionMode} + pool 必须仍是内存 store（接线前行为逐字不变）`,
    );
    assert.deepEqual(pool.queries, [], `${executionMode} + pool 不得发出任何查询`);
  }
});

test('结构钉子：装配行恰七键、池以位置实参传入、app.ts 只 import type 语音存储、路由三态仍在', () => {
  // ① 装配行仍是「guards + 历史域三个端口 + 隐私域 consent/egress」七个键。
  //    `tests/integration/speech-http.mjs:495-521` 用同一条判据（本文件只是让它在 unit 层也红得起来）。
  const registrationLine = APP_SOURCE.split(/\r?\n/).find((line) => line.includes('registerSpeechRoutes(app, config,'));
  assert.notEqual(registrationLine, undefined, 'app.ts 必须有语音域装配行');
  const keys = [...registrationLine.matchAll(/([A-Za-z]+):/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    keys,
    ['consent', 'egress', 'guards', 'jobDeadlineMs', 'media', 'provider', 'store'],
    `装配行只允许这七个键（不得塞入 pool 等适配器端口）：${registrationLine.trim()}`,
  );
  // 池必须以位置实参传进去（不是 deps 的键），否则键集判据会被绕过/打红。
  assert.match(
    registrationLine,
    /\}, config\.executionMode === 'real' \? pool : null\);$/,
    `装配行的第 4 个实参必须是"real 才给池"的判定：${registrationLine.trim()}`,
  );

  // ② `app.ts` 对 speech/* 只允许**类型**接触（provider/media 是类型端口，store 也必须是 type）。
  //    （这正是 `tests/integration/speech-http.mjs:530-540` 的源码判据；此处同口径复刻。）
  const TYPE_ONLY = /^import type \{[^}]+\} from '\.\/speech\/(store|provider|media)\.ts';$/;
  for (const adapter of ['speech/provider', 'speech/media']) {
    const lines = APP_SOURCE.split(/\r?\n/).filter((line) => line.includes(adapter));
    assert.equal(lines.length, 1, `app.ts 应恰有一行引用 ${adapter}（现场 ${lines.length} 行）`);
    assert.match(
      lines[0],
      TYPE_ONLY,
      `app.ts 对 ${adapter} 只允许 import type（⛔ 不得在装配层 import 值实现）：${lines[0].trim()}`,
    );
  }
  const storeLines = APP_SOURCE.split(/\r?\n/).filter((line) => line.includes('speech/store'));
  assert.equal(storeLines.length, 1, `app.ts 只应有一行引用 speech/store（现场 ${storeLines.length} 行）`);
  assert.match(
    storeLines[0],
    /^import type \{[^}]+\} from '\.\/speech\/store\.ts';$/,
    `app.ts 对 speech/store 只允许 import type（⛔ 不得在装配层直接 import 值实现）：${storeLines[0].trim()}`,
  );

  // ③ 三态选择必须在路由层**可见**（删掉任一支 ⇒ 会退化成"永远 PG"或"永远内存"）。
  assert.match(ROUTE_SOURCE, /persistencePool: TransactionalPool \| null = null/, '路由层必须收一个位置池实参（缺省 null）');
  assert.match(ROUTE_SOURCE, /deps\.store\s*\?\?/, '路由层必须有"注入优先"分支');
  assert.match(ROUTE_SOURCE, /createPostgresSpeechStore\(\{ pool: persistencePool \}\)/, '路由层必须有 real+池 ⇒ PG store 分支');
  assert.match(ROUTE_SOURCE, /: createMemorySpeechStore\(\)\)/, '路由层必须有内存兜底分支（persistent=false）');
  assert.match(
    ROUTE_SOURCE,
    /config\.executionMode === 'real' && persistencePool !== null/,
    '路由层必须显式判定"real 且有池"（不得只看池，否则非 real 也会接库）',
  );
});

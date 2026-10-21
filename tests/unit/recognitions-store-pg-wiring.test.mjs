/**
 * GY-R28 S13（#9）· 识别域**持久化接线选择**的单元判据（不起服务、不连库）。
 *
 * 判据（与派单 §1.4 逐条对应）：
 *   1) `real` 且 `pool !== null` ⇒ `app.recognitionService.describe().storePersistent === true`；
 *   2) `real` 但 `pool === null` ⇒ **false**（如实内存，绝不冒充持久化）；
 *   3) `stub` / `preset_demo` 即使有池 ⇒ **false**（非 real 不换实现，行为与接线前逐字一致）；
 *   4) PG store 在**构造期不发任何查询**（`real + 池` 不得在启动时偷偷探库）；
 *   5) 显式注入优先：给了 `recognitionStore` ⇒ 无论模式与池，都不换实现；
 *   6) 结构钉子（源码级）：装配表达式仍是「注入 ?? (real && 有池 ? PG : 内存)」三段式，
 *      且 `createPostgresRecognitionStore` 的 import 仍在**文件最末尾**（app.ts 行号是契约台账
 *      锚点，顶部 import 区零插入）。
 *
 * 反向控制（本文件自带牙齿）：
 *   * 判据 1 与判据 2/3 用的是同一条断言（`storePersistent`）：若接线退化成"永远内存"或
 *     "永远 PG"，必有一半红；
 *   * 判据 6 的表达式若被删/被改写（例如去掉 `pool !== null` 守卫），对应用例红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_SOURCE = readFileSync(join(ROOT, 'services/api/src/app.ts'), 'utf8');

/** 记录型假池：只实现 `query`（构造期不得有任何查询 ⇒ 这里同时是"没打库"的证物）。 */
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

function makeApp({ executionMode, pool = null, store = undefined }) {
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode };
  return buildApp({ config, pool, store: createMemoryAuthStore(), ...(store ? { recognitionStore: store } : {}) });
}

test('接线选择：real + 池 ⇒ PG store（persistent=true），且构造期零查询', async (t) => {
  const pool = makeRecordingPool();
  const app = makeApp({ executionMode: 'real', pool });
  t.after(() => app.close());

  assert.equal(
    app.recognitionService.describe().storePersistent,
    true,
    'real + pool 必须接 PostgreSQL store（否则"重启不丢"无从谈起）',
  );
  assert.deepEqual(pool.queries, [], `识别域构造期不得发任何查询（现场 ${pool.queries.length} 条）`);
});

test('不冒充持久：real + 无池 ⇒ 内存 store（persistent=false）', async (t) => {
  const app = makeApp({ executionMode: 'real', pool: null });
  t.after(() => app.close());
  assert.equal(
    app.recognitionService.describe().storePersistent,
    false,
    'real 但无池必须如实标注不持久（⛔ 不得回退内存并声称已持久化）',
  );
});

test('非 real 不换实现：stub / preset_demo 即使有池也用内存 store，且不探库', async (t) => {
  for (const executionMode of ['stub', 'preset_demo']) {
    const pool = makeRecordingPool();
    const app = makeApp({ executionMode, pool });
    t.after(() => app.close());
    assert.equal(
      app.recognitionService.describe().storePersistent,
      false,
      `${executionMode} + pool 必须仍是内存 store（接线前行为逐字不变）`,
    );
    assert.deepEqual(pool.queries, [], `${executionMode} + pool 不得发出任何查询`);
  }
});

test('显式注入优先：给了 recognitionStore ⇒ real + 池也不换实现', async (t) => {
  const injected = createMemoryRecognitionStore();
  const app = makeApp({ executionMode: 'real', pool: makeRecordingPool(), store: injected });
  t.after(() => app.close());
  assert.equal(app.recognitionService.describe().storePersistent, false);
});

test('结构钉子：装配表达式是三段式、有池才给池、import 在文件最末尾', () => {
  const lines = APP_SOURCE.replace(/\r?\n$/, '').split(/\r?\n/);

  // ① 装配表达式：`recognitionStore ?? (real && pool !== null ? PG : 内存)`。
  const assembly = lines.find((line) => line.includes('store: recognitionStore ??'));
  assert.notEqual(assembly, undefined, 'app.ts 必须有识别 store 装配行');
  assert.match(
    assembly,
    /store: recognitionStore \?\? \(config\.executionMode === 'real' && pool !== null \? createPostgresRecognitionStore\(\{ pool \}\) : createMemoryRecognitionStore\(\)\),/,
    `装配表达式被改写了（三段式：注入 ?? (real && 有池 ? PG : 内存)）：${assembly.trim()}`,
  );

  // ② `pool !== null` 守卫必须在（删掉它 ⇒ 非 real / 无池也会接库）。
  assert.match(assembly, /pool !== null \?/, '必须有 `pool !== null` 守卫');

  // ③ 适配器只在"装配"与"文件末尾 import"两处出现（不在顶部 import 区，也不在多处乱接）。
  const mentions = APP_SOURCE.match(/createPostgresRecognitionStore/g) ?? [];
  assert.equal(
    mentions.length,
    2,
    `createPostgresRecognitionStore 只允许出现在装配表达式与末尾 import（实际 ${mentions.length} 处）`,
  );

  // ④ import 必须是**最后一行**：app.ts 的行号是 `docs/architecture/contract-status.json` 的锚点，
  //    任何既有行位移都会让证据静默失效 —— 这条钉子防止有人"顺手"把 import 挪回顶部。
  const last = lines[lines.length - 1];
  assert.match(
    last,
    /^import \{ createPostgresRecognitionStore \} from '\.\/recognitions\/store-pg\.ts';/,
    `识别 PG store 的 import 必须是 app.ts 最后一行（现为：${last.trim()}）`,
  );
  assert.equal(
    (APP_SOURCE.match(/from '\.\/recognitions\/store-pg\.ts'/g) ?? []).length,
    1,
    '该模块只允许 import 一次（重复 import 会同时打红行数与装配钉）',
  );

  // ⑤ 内存 fallback 仍在同一表达式里（不许"只留 PG 分支"）。
  assert.match(assembly, /: createMemoryRecognitionStore\(\)/, '内存 fallback 必须保留');
});

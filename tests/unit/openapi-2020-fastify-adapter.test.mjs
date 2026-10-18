/**
 * GY-I02（#2）适配实测：Fastify 运行时校验器**真的**在用 JSON Schema 2020-12。
 *
 * 背景：契约 `packages/contracts/openapi.json:2` 声明 `"openapi": "3.1.1"`、`:8` 钉住
 * `jsonSchemaDialect` 为 `https://json-schema.org/draft/2020-12/schema`，而 Fastify 5 的默认校验器是
 * `@fastify/ajv-compiler` ⇒ `ajv` 的 **draft-07** 入口。
 * 只把契约写成 3.1 而不换运行时校验器时，2020-12 专有关键字有两条坏路径：
 *   - draft-07 + strict（改前口径）⇒ **编译期**就抛 `unknown keyword`；
 *   - draft-07 + strict:false ⇒ 编译通过但关键字被**静默忽略**，非法载荷照常放行。
 * 后者正是「schema 通过、语义丢失」，所以本文件不满足于「正例通过」。
 *
 * 四层证据（缺一不可）：
 *  1) 走 `buildApp` 的真实装配（不是测试里另起 Ajv）：2020-12 专有关键字 `prefixItems` 的正例放行、
 *     反例 400 `INVALID_REQUEST` 且字段路径指到具体元组槽位；
 *  2) 同一 schema **同一载荷**交给改前口径的 draft-07：strict 默认编译失败；strict:false 静默忽略并放行
 *     该反例 ⇒ 与 (1) 的 400 构成对照；
 *  3) 反方向对照：draft-07 合法写法（`items` 数组元组，2019-09 之前丢掉的语法）在改后的真实 app 上
 *     **编译失败** ⇒ 证明不是「两边都接受」这种无效切换；
 *  4) 两条保持性断言：`removeAdditional:false`（多余字段 400 而不是静默剔除）与 `ajv-formats`
 *     （`format:'uuid'` 仍在校验——默认编译器同样内置加载它，换方言不能把它弄丢）。
 *
 * 反向控制（手工实跑，不在本文件内）：临时删掉 `services/api/src/app.ts` 里的
 * `app.setValidatorCompiler(...)` 一行，本文件必须整批变红（默认 draft-07 下 `prefixItems` 在
 * `ready()` 即抛 `strict mode: unknown keyword: "prefixItems"`）。读数见
 * `docs/verification/gy-i02-openapi-2020-fastify-20261017.md`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';

const require = createRequire(import.meta.url);
// 改后运行时用的入口（2020-12）；改前 Fastify 默认用的入口（draft-07）。同一份 ajv@8.20.0。
const Ajv2020 = require('ajv/dist/2020.js');
const AjvDraft07 = require('ajv').default;
const addFormats = require('ajv-formats').default;

/**
 * 改前口径的选项：逐项抄自 `node_modules/@fastify/ajv-compiler/lib/default-ajv-options.js`
 * 并叠加 `app.ts` 里显式的 `removeAdditional:false`。`strict` 不写 ⇒ 走 ajv 默认 `true`
 * （与改前 Fastify 一致；下面要显式 `strict:false` 的地方会自己覆盖）。
 */
const PRE_CHANGE_OPTIONS = Object.freeze({
  coerceTypes: 'array',
  useDefaults: true,
  removeAdditional: false,
  addUsedSchema: false,
  allErrors: false,
});

/** 改前口径的 draft-07 编译器（对照用，不参与运行时）。 */
function draft07(options = {}) {
  const ajv = new AjvDraft07({ ...PRE_CHANGE_OPTIONS, ...options });
  addFormats(ajv);
  return ajv;
}

const PROBE_PATH = '/api/v1/__schema-2020-probe';

/** 只在 2020-12 成立：`prefixItems` 逐槽校验（draft-07 不认识它）。 */
const PROBE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'pair'],
  properties: {
    label: { type: 'string', minLength: 1 },
    id: { type: 'string', format: 'uuid' },
    // `minItems/maxItems` 与槽位数一致：只为了让 ajv 的 `strictTuples` 不必打 warning；
    // 判别力仍来自 `prefixItems`（draft-07 不认识它，见下面的对照）。
    pair: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'integer' }],
      minItems: 2,
      maxItems: 2,
    },
  },
};

const VALID_PAIR = ['a', 1];
// prefixItems[1] 要求 integer；'b' 无法被 `coerceTypes:'array'` 变成整数（数字型字符串才可能被解成整数）。
const INVALID_PAIR = ['a', 'b'];

/** 真实装配（`buildApp`）+ 一条最小探针路由：走的就是 app.ts 装的那台校验器。 */
function probeApp() {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const app = buildApp({ config });
  app.post(PROBE_PATH, { schema: { body: PROBE_BODY } }, async (request) => ({ received: request.body }));
  return app;
}

test('2020-12 语义在真实装配上被执行：prefixItems 正例放行、反例 400 INVALID_REQUEST', async () => {
  const app = probeApp();
  try {
    const ok = await app.inject({ method: 'POST', url: PROBE_PATH, payload: { label: 'x', pair: VALID_PAIR } });
    assert.equal(ok.statusCode, 200, `正例应放行，实得 ${ok.statusCode}：${ok.body}`);
    assert.deepEqual(ok.json(), { received: { label: 'x', pair: VALID_PAIR } });

    const bad = await app.inject({ method: 'POST', url: PROBE_PATH, payload: { label: 'x', pair: INVALID_PAIR } });
    assert.equal(bad.statusCode, 400, `反例应被 400 拒绝，实得 ${bad.statusCode}：${bad.body}`);
    const envelope = bad.json();
    assert.equal(envelope.error.code, 'INVALID_REQUEST');
    // 字段路径必须指到被 prefixItems 校验的槽位 —— 证明是按槽位校验，不是泛泛的数组校验。
    assert.equal(envelope.error.details[0].field, '/pair/1');
    assert.match(envelope.error.details[0].code, /integer/);
  } finally {
    await app.close();
  }
});

test('对照①：同一 schema 交给改前口径 draft-07（strict 默认）编译即失败（不是运行期才拦）', () => {
  const ajv = draft07();
  assert.throws(
    () => ajv.compile(PROBE_BODY),
    /unknown keyword: "prefixItems"/,
    'draft-07 不认识 2020-12 关键字：改前口径在 ready() 阶段就会失败',
  );
});

test('对照②：draft-07 关掉 strict 后编译通过，但 prefixItems 被静默忽略、同一反例被判合法', () => {
  const validateDraft07 = draft07({ strict: false }).compile(PROBE_BODY);
  assert.equal(
    validateDraft07({ label: 'x', pair: INVALID_PAIR }),
    true,
    'draft-07 下 prefixItems 不生效：同一反例被判合法（改前「schema 通过、语义丢失」的形态）',
  );

  const ajv2020 = new Ajv2020({ ...PRE_CHANGE_OPTIONS, strict: false });
  addFormats(ajv2020);
  const validate2020 = ajv2020.compile(PROBE_BODY);
  assert.equal(validate2020({ label: 'x', pair: INVALID_PAIR }), false, '同一反例在 2020-12 下必须非法');
});

test('反方向对照：draft-07 合法写法（items 数组元组）在改后的真实 app 上编译即失败', async () => {
  // 2019-09 之前的 tuple 语法：draft-07 认它（只是缺 minItems/items 会打 warning，不报错）。
  const tupleBody = {
    type: 'object',
    additionalProperties: false,
    required: ['pair'],
    properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } },
  };
  assert.doesNotThrow(() => draft07({ strict: false }).compile(tupleBody), 'draft-07 应接受该写法');

  const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }) });
  app.post('/api/v1/__schema-2020-tuple-probe', { schema: { body: tupleBody } }, async () => ({ ok: true }));
  try {
    // 2020-12 已删除 items 数组元组语法 ⇒ 真实 app 编译期失败（证明确实换了方言，而非两边都接受）。
    await assert.rejects(() => app.ready(), /items must be object,boolean/);
  } finally {
    await app.close().catch(() => {});
  }
});

test('removeAdditional:false 保持：多余字段被 400 拒绝，而不是被静默剔除后放行', async () => {
  const app = probeApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: PROBE_PATH,
      payload: { label: 'x', pair: VALID_PAIR, openid: 'attacker-chosen' },
    });
    assert.equal(res.statusCode, 400, `多余字段必须被拒绝（若被剔除会变 200）：${res.body}`);
    const envelope = res.json();
    assert.equal(envelope.error.code, 'INVALID_REQUEST');
    assert.equal(envelope.received, undefined, 'handler 不应执行（请求在校验层就被拒）');
    assert.match(
      envelope.error.details.map((item) => item.code).join(' '),
      /additional properties/i,
      '错误明细应指明 additionalProperties 违规',
    );
  } finally {
    await app.close();
  }
});

test('ajv-formats 随编译器存活：format:"uuid" 仍在被校验（换方言没有把它弄丢）', async () => {
  const app = probeApp();
  try {
    const bad = await app.inject({
      method: 'POST',
      url: PROBE_PATH,
      payload: { label: 'x', pair: VALID_PAIR, id: 'not-a-uuid' },
    });
    assert.equal(bad.statusCode, 400, `非法 uuid 应被 400 拒绝：${bad.body}`);
    assert.match(bad.json().error.details.map((item) => item.code).join(' '), /format "uuid"/i);

    const ok = await app.inject({
      method: 'POST',
      url: PROBE_PATH,
      payload: { label: 'x', pair: VALID_PAIR, id: '3f1a2b3c-4d5e-4f60-8172-8a9b0c1d2e3f' },
    });
    assert.equal(ok.statusCode, 200, `合法 uuid 应放行：${ok.body}`);
  } finally {
    await app.close();
  }
});

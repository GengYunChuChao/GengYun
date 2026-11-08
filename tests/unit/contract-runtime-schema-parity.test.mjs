/**
 * 契约 ↔ 运行期 body schema **字段级**等价守卫（GY-R90）。
 *
 * ## 为什么需要它
 *
 * `tools/openapi-route-parity.mjs:236` 自己写明了口径局限：「**字段级 schema 未纳入**：请求/响应体的
 * 字段、类型、必填与枚举差异不在本表判定范围内」，所以路由表全绿并不代表契约里的字段和运行期校验的
 * 字段一致。以档案为例：契约 `ProfileInput`（`packages/contracts/openapi.json:12982`）与
 * `services/api/src/routes/profile.ts:29-33` 的 body schema 今天逐字同构，但**没有任何一处把两份
 * 结构比过** —— `tests/unit/profile-api.test.mjs:542-550` 只从契约侧读了三件事实（闭集、三个属性名、
 * 地区码 pattern），`:640-648` 只把契约 schema 丢给运行期同一个校验器编译，运行期那份 schema 从头到尾
 * 没被当作比较对象。任何一边单方面加字段、改 `required`、改 `additionalProperties`，现有测试都不会红。
 *
 * ## 运行期 schema 从哪来（没有为测试改生产代码）
 *
 * 三个 `register*Routes` 函数都是 `services/api/src/app.ts` 里逐条调用的**同一个**注册函数，schema 字面量
 * 就写在函数体里（`profile.ts:29-33`、`community.ts:72-89`、`community.ts:100-121`、`consents.ts:42-46`），
 * 没有任何导出面能直接拿到它们。本文件不改生产代码，而是给真实的 Fastify 实例挂 `onRoute` 钩子、
 * 再调用这三个注册函数（`service`/`pool` 传 `null` ⇒ 只注册路由，不碰数据库），从而拿到
 * **注册时实际交给 Fastify 的那一份** `routeOptions.schema.body` —— 也就是 `buildApp` 之后
 * `createJsonSchema2020ValidatorCompiler()`（`services/api/src/schema-validator.ts:64-68`）会编译的那一份。
 * 不是另抄一份 fixture：抄一份就只能证明「抄得对」，证明不了「运行期还是它」。
 *
 * ## 规范化规则（`canonicalizeSchema`）
 *
 * 1. 递归解析**本地** `$ref`（`#/components/schemas/<Name>`）后比较：契约用 `$ref` 复用的
 *    `KnowledgeTarget`/`ConsentPurpose`/`ReportTarget`，运行期是内联展开的同一份结构，不解析就全是假分叉。
 *    非本地 `$ref` 一律抛错（宁可红，也不要静默跳过一段没比的树）。
 * 2. 丢掉纯文档键：`$schema`、`title`、`description`、`examples`、`example`、`deprecated`、`$comment`、`summary`
 *    —— 它们不进 Ajv 的接受/拒绝判定，只影响阅读（因此 M3 变异必须**不**红）。
 * 3. `required` 数组先排序再比（必填项的顺序没有语义）；**其它数组保序**（`enum`、`anyOf`、`allOf` 的顺序
 *    本身承载优先级与分支顺序，排序会把真分叉抹平）。
 * 4. 其它键（`pattern`、`minLength`、`maxItems`、`format`、`uniqueItems`、`additionalProperties`、
 *    `minimum`/`maximum`…）逐字比，不做任何等价代换 —— 少一个 `required`、把 `false` 改成 `true` 都必须红。
 *
 * ## 覆盖（4 个 schema，见 `CASES` 的 `why`）
 *
 * 只覆盖「登记在 `CASES` 里的这几条路由 × 请求体」，见 `docs/verification/gy-r90-contract-runtime-schema-parity-20261109.md`
 * 的「不声称」：不覆盖全部契约、不覆盖响应体、不判语义级分叉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import Fastify from 'fastify';
import { registerProfileRoutes } from '../../services/api/src/routes/profile.ts';
import { registerCommunityRoutes } from '../../services/api/src/routes/community.ts';
import { registerConsentRoutes } from '../../services/api/src/routes/consents.ts';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const CONTRACT = JSON.parse(read('packages/contracts/openapi.json'));

/** 契约 `servers[0].url` ＝ 运行期路由前缀（`/api/v1`）。两边靠它对上号，写死前缀会掩盖漂移。 */
const API_PREFIX = CONTRACT.servers[0]?.url;

/** 只影响阅读、不进 Ajv 判定的键（规范化规则 2）。 */
const DOC_ONLY_KEYS = new Set(['$schema', 'title', 'description', 'examples', 'example', 'deprecated', '$comment', 'summary']);

// ---------------------------------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------------------------------

/**
 * 递归解析本地 `$ref`：`#/components/schemas/<Name>`。
 *
 * `$ref` 兄弟键按 JSON Schema 2020-12 的口径合并（后者覆盖前者），不认识的指针直接抛错 ——
 * 将来契约改用外部引用或 `$defs` 时，这里会以「不认识的 $ref」红掉，而不是安静地比一棵空树。
 */
export function resolveLocalRefs(node, doc) {
  if (Array.isArray(node)) return node.map(item => resolveLocalRefs(item, doc));
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const matched = /^#\/components\/schemas\/([^/]+)$/.exec(node.$ref);
    assert.ok(matched, `不认识的 $ref：「${node.$ref}」—— 本守卫只解析 #/components/schemas/<Name>，请先扩这里再信任绿读数`);
    const target = doc.components?.schemas?.[matched[1]];
    assert.ok(target, `$ref 指向的 schema 不存在：「${node.$ref}」`);
    const siblings = {...node};
    delete siblings.$ref;
    const resolved = resolveLocalRefs(target, doc);
    return Object.keys(siblings).length === 0 ? resolved : {...resolved, ...resolveLocalRefs(siblings, doc)};
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = resolveLocalRefs(value, doc);
  return out;
}

/** 规则 2＋3：丢文档键、`required` 排序；其它数组保序（见文件头）。返回新对象，不改入参。 */
export function canonicalizeSchema(node) {
  if (Array.isArray(node)) return node.map(canonicalizeSchema);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (DOC_ONLY_KEYS.has(key)) continue;
    out[key] = key === 'required' && Array.isArray(value) && value.every(item => typeof item === 'string')
      ? [...value].sort()
      : canonicalizeSchema(value);
  }
  return out;
}

/** 稳定序列化：键排序后 `JSON.stringify`，只用于失败信息可读（`deepEqual` 本身不看键序）。 */
function stableStringify(node) {
  const sortKeys = value => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  };
  return JSON.stringify(sortKeys(node));
}

// ---------------------------------------------------------------------------------------------------
// 运行期捕获：调用真实注册函数，用 Fastify 的 onRoute 钩子取 routeOptions.schema.body
// ---------------------------------------------------------------------------------------------------

function captureRegisteredRoutes() {
  const app = Fastify({logger: false});
  const captured = [];
  app.addHook('onRoute', route => {
    captured.push({method: route.method, url: route.url, schema: route.schema});
  });
  // 鉴权钩子在注册期不被调用，给一个同形的桩即可；`null` 的 pool/service 让各模块只注册路由、不连库。
  const guards = {requireUser: async () => {}};
  registerProfileRoutes(app, {}, null, guards);
  registerCommunityRoutes(app, {}, guards, null);
  registerConsentRoutes(app, {}, null, guards);
  return captured;
}

const REGISTERED = captureRegisteredRoutes();

/** 按 `method + url` 取运行期 body schema；取不到就抛（静默返回 undefined 会让下面的等价断言空转）。 */
function runtimeBodyOf({method, route}) {
  const found = REGISTERED.find(entry => entry.method === method && entry.url === route);
  assert.ok(found, `没有捕获到 ${method} ${route}：注册函数换了调用形态，或这条路由被删了（本守卫不能空转）`);
  const body = found.schema?.body;
  assert.ok(body && typeof body === 'object', `${method} ${route} 没有 schema.body（本守卫要比较的那一份不存在）`);
  return body;
}

// ---------------------------------------------------------------------------------------------------
// 契约侧取值：走 operation 的 requestBody（而不是直接点 components），顺带钉住「哪条 operation 用哪个 schema」
// ---------------------------------------------------------------------------------------------------

function contractBodyOf({method, route}, doc = CONTRACT) {
  assert.equal(typeof API_PREFIX, 'string', '契约 servers[0].url 缺失，路由前缀无从对上号');
  assert.ok(route.startsWith(API_PREFIX), `运行期路由 ${route} 不在契约 servers[0].url（${API_PREFIX}）之下`);
  const contractPath = route.slice(API_PREFIX.length);
  const [httpMethod] = [method.toLowerCase()];
  const operation = doc.paths?.[contractPath]?.[httpMethod];
  assert.ok(operation, `契约里没有 ${method} ${contractPath}（运行期 :id 在契约里写作 {id}，新增用例时注意）`);
  const raw = operation.requestBody?.content?.['application/json']?.schema;
  assert.ok(raw, `契约 ${method} ${contractPath} 没有 application/json 请求体 schema`);
  const refName = typeof raw.$ref === 'string' ? raw.$ref.split('/').pop() : null;
  return {refName, schema: resolveLocalRefs(raw, doc), path: contractPath};
}

// ---------------------------------------------------------------------------------------------------
// 被守卫的 4 条路由（`why` 就是挑选理由，写在这里而不是只写在证据页）
// ---------------------------------------------------------------------------------------------------

export const CASES = [
  {
    schema: 'ProfileInput',
    method: 'PUT',
    route: '/api/v1/me/profile',
    why: '审查点名的盲区本体：契约 ProfileInput 与 profile.ts:29-33 手写 body 今天逐字同构，却只有「闭集 + 三个属性名 + pattern」被间接钉过。',
  },
  {
    schema: 'PostInput',
    method: 'POST',
    route: '/api/v1/posts',
    why: '最能分辨「有没有解析 $ref」的一条：契约 linked_knowledge_ref 是 anyOf:[{$ref:KnowledgeTarget},{type:null}]，运行期是内联展开的同一结构；不解析 $ref 的实现会在这里假红。',
  },
  {
    schema: 'ConsentInput',
    method: 'POST',
    route: '/api/v1/me/consents',
    why: '属性级的 $ref（purpose → ConsentPurpose，纯 enum schema）＋数组约束（maxItems:30、uniqueItems）。契约改枚举成员、运行期改 CONSENT_PURPOSES，两边会各自漂移。',
  },
  {
    schema: 'ReportInput',
    method: 'POST',
    route: '/api/v1/reports',
    why: '嵌套闭集对象（target_ref → ReportTarget）＋五个枚举的 reason_code：字段级分叉最容易在这种「两层对象 + 枚举」的形状上漏掉。',
  },
];

// ---------------------------------------------------------------------------------------------------
// 断言本体：真实用例与三条变异都走同一个函数（变异若只测一个旁路函数，证明不了真守卫会红）
// ---------------------------------------------------------------------------------------------------

function assertFieldParity(definition, {contractDoc = CONTRACT, runtimeBody = runtimeBodyOf(definition)} = {}) {
  const contractSide = contractBodyOf(definition, contractDoc);
  assert.equal(contractSide.refName, definition.schema,
    `契约 ${definition.method} ${contractSide.path} 的 requestBody 不再指向 ${definition.schema}（现指向 ${contractSide.refName}）——守卫绑错了对象`);
  const contractSchema = canonicalizeSchema(contractSide.schema);
  const runtimeSchema = canonicalizeSchema(runtimeBody);
  assert.deepEqual(runtimeSchema, contractSchema,
    `契约 ${definition.schema} 与运行期 body schema 分叉：\n  契约：${stableStringify(contractSchema)}\n  运行期：${stableStringify(runtimeSchema)}`);
  return {contractSchema, runtimeSchema};
}

// ---------------------------------------------------------------------------------------------------
// 判据①：捕获面（先证明「能拿到」，否则下面的等价断言全是空转）
// ---------------------------------------------------------------------------------------------------

test('判据①：三个注册函数被真实调用，4 条路由的 schema.body 都拿得到', () => {
  assert.ok(REGISTERED.length >= 30, `捕获到的路由数偏少（${REGISTERED.length} 条），注册函数可能没被完整调用`);
  for (const definition of CASES) {
    const body = runtimeBodyOf(definition);
    assert.equal(body.type, 'object', `${definition.schema}：运行期 body 的根类型不是 object`);
    assert.ok('properties' in body, `${definition.schema}：运行期 body 没有 properties`);
  }
});

test('判据①b：契约侧每条 operation 的 requestBody $ref 都指向本表登记的 schema 名', () => {
  for (const definition of CASES) {
    const {refName} = contractBodyOf(definition);
    assert.equal(refName, definition.schema, `${definition.method} ${definition.route} 的契约 requestBody 指向 ${refName}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// 判据②：字段级等价（本片的主体）
// ---------------------------------------------------------------------------------------------------

for (const definition of CASES) {
  test(`判据②：${definition.schema}（${definition.method} ${definition.route}）与契约逐字段等价 —— ${definition.why}`, () => {
    const {contractSchema, runtimeSchema} = assertFieldParity(definition);
    // 等价之外再钉一条「不是空树对空树」：至少三个属性、闭集。防止将来两边一起退化成 {}。
    assert.ok(Object.keys(contractSchema.properties).length >= 3, `${definition.schema}：比较面的属性数意外偏少`);
    assert.equal(contractSchema.additionalProperties, false, `${definition.schema}：两份都必须是闭集，否则坐标/额外字段在契约与运行期同时合法`);
    assert.deepEqual(runtimeSchema, contractSchema);
  });
}

// ---------------------------------------------------------------------------------------------------
// 判据③：规范化自身的分辨率（既不过敏，也不迟钝）
// ---------------------------------------------------------------------------------------------------

test('判据③：规范化 —— 只差文档键不算分叉，少一个 required 算分叉，required 换序不算，enum 换序算', () => {
  const base = {
    type: 'object',
    additionalProperties: false,
    required: ['alpha', 'beta'],
    properties: {alpha: {type: 'string'}, beta: {type: 'string', enum: ['x', 'y']}},
  };

  // 只差文档键 ⇒ 相等（否则 M3 那种「只改 description」会被误判成漂移）。
  const documented = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: '示例',
    description: '纯说明',
    examples: [{alpha: 'a', beta: 'x'}],
    ...base,
  };
  assert.equal(isDeepStrictEqual(canonicalizeSchema(documented), canonicalizeSchema(base)), true, '只差文档键必须判为等价');

  // 少一个 required ⇒ 分叉（必填面变化是真实的接受/拒绝差异）。
  const fewerRequired = {...base, required: ['alpha']};
  assert.equal(isDeepStrictEqual(canonicalizeSchema(fewerRequired), canonicalizeSchema(base)), false, '少一个 required 必须判为分叉');

  // required 换序 ⇒ 不算分叉。
  const reorderedRequired = {...base, required: ['beta', 'alpha']};
  assert.equal(isDeepStrictEqual(canonicalizeSchema(reorderedRequired), canonicalizeSchema(base)), true, 'required 换序不算分叉');

  // enum 换序 ⇒ 算分叉（本守卫对除 required 外的数组保序：顺序变化要人看一眼）。
  const reorderedEnum = {...base, properties: {alpha: {type: 'string'}, beta: {type: 'string', enum: ['y', 'x']}}};
  assert.equal(isDeepStrictEqual(canonicalizeSchema(reorderedEnum), canonicalizeSchema(base)), false, 'enum 换序必须判为分叉（数组保序）');

  // 闭集开关 ⇒ 算分叉。
  const openedUp = {...base, additionalProperties: true};
  assert.equal(isDeepStrictEqual(canonicalizeSchema(openedUp), canonicalizeSchema(base)), false, 'additionalProperties:true 必须判为分叉');

  // 规范化不许改入参（否则第二次比较会拿到被排过序的副本）。
  assert.deepEqual(base.required, ['alpha', 'beta'], 'canonicalizeSchema 改写了入参的 required 顺序');
});

test('判据③b：$ref 与内联同构必须判为等价，未知 $ref 必须抛错（不许静默跳过）', () => {
  const doc = {
    components: {schemas: {
      Inner: {type: 'object', additionalProperties: false, required: ['id'], properties: {id: {type: 'string'}}},
    }},
  };
  const withRef = {type: 'object', properties: {inner: {$ref: '#/components/schemas/Inner'}}};
  const inlined = {type: 'object', properties: {inner: {type: 'object', additionalProperties: false, required: ['id'], properties: {id: {type: 'string'}}}}};
  assert.deepEqual(canonicalizeSchema(resolveLocalRefs(withRef, doc)), canonicalizeSchema(inlined), '$ref 解析后必须与内联同构等价');

  assert.throws(() => resolveLocalRefs({$ref: '#/components/schemas/Missing'}, doc), /不存在/, '指向不存在 schema 的 $ref 必须抛错');
  assert.throws(() => resolveLocalRefs({$ref: 'https://example.test/x.json'}, doc), /不认识的 \$ref/, '非本地 $ref 必须抛错');
});

// ---------------------------------------------------------------------------------------------------
// 判据④：三条变异自证（全部在内存里做，不落盘改契约/生产代码）
// ---------------------------------------------------------------------------------------------------

test('判据④-M1：契约侧给 ProfileInput 加一个字段 ⇒ 必须红（同一个 assertFieldParity 抛错）', () => {
  const mutated = structuredClone(CONTRACT);
  mutated.components.schemas.ProfileInput.properties.latitude = {type: 'number', minimum: -90, maximum: 90};
  // 先证明变异真的落在「被比较的那一份」上，否则下面的 throws 可能来自别的错。
  assert.deepEqual(mutated.components.schemas.ProfileInput.properties.latitude, {type: 'number', minimum: -90, maximum: 90});
  const definition = CASES.find(item => item.schema === 'ProfileInput');
  assert.throws(() => assertFieldParity(definition, {contractDoc: mutated}), /分叉/, '契约侧多一个字段，守卫必须红');
});

test('判据④-M2：运行期侧把 additionalProperties:false 改成 true ⇒ 必须红', () => {
  const definition = CASES.find(item => item.schema === 'ProfileInput');
  const original = runtimeBodyOf(definition);
  const mutated = {...original, additionalProperties: true};
  assert.equal(mutated.additionalProperties, true);
  assert.equal(original.additionalProperties, false, '运行期原本就是闭集，变异前提不成立');
  assert.throws(() => assertFieldParity(definition, {runtimeBody: mutated}), /分叉/, '运行期开集，守卫必须红');
});

test('判据④-M3：只在运行期加 description/title/examples ⇒ 不许红（证明没有过度敏感）', () => {
  const definition = CASES.find(item => item.schema === 'ProfileInput');
  const decorated = {
    ...runtimeBodyOf(definition),
    title: '档案写入',
    description: '纯文档键，不进 Ajv 判定',
    examples: [{crop_id: 'crop_rice', region_code: '330102', region_catalog_version: 'mca-xzqh-2023'}],
  };
  assert.doesNotThrow(() => assertFieldParity(definition, {runtimeBody: decorated}), '只加文档键却判成分叉 ⇒ 守卫过度敏感');
  // 反向对照：同一份变异体上再动一个实质键，必须立刻红 —— 证明 M3 的绿不是「比较器瞎了」。
  assert.throws(() => assertFieldParity(definition, {runtimeBody: {...decorated, required: ['crop_id']}}), /分叉/,
    'M3 的绿必须能被同一条链上的实质变异推翻，否则它只是比较器失效');
});

test('判据④-M4：契约侧把地区码 pattern 改宽 ⇒ 必须红（字段级语义面，不只字段名）', () => {
  const mutated = structuredClone(CONTRACT);
  mutated.components.schemas.ProfileInput.properties.region_code.pattern = '^[0-9]{6}$';
  const definition = CASES.find(item => item.schema === 'ProfileInput');
  assert.throws(() => assertFieldParity(definition, {contractDoc: mutated}), /分叉/, 'pattern 放宽后省外地区码在契约上变合法，守卫必须红');
});

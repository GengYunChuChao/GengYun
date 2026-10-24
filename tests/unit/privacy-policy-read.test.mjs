// 隐私政策读面（契约 `getPrivacyPolicy`：`GET /api/v1/me/privacy-policy`）单测。
//
// 为什么这一族单测不需要 `pg` / PGlite：读面只依赖「一次查询」这一个端口
// （`services/api/src/privacy/privacy-policy.ts` 的 `PrivacyPolicySql`），
// 所以空态、版本映射、拒收形状都能用内存桩覆盖；真库臂（受限角色 42501 / 行级门禁）
// 不在本片范围，本片也**不新增** `tests/integration/*`（避免撞 `ci-integration-chain-structure`
// 的白名单条数）。
//
// 覆盖：
//   ① 空态诚实：没有政策行 ⇒ `version:'unpublished'` + 两个空数组 + `training_enabled:false`，不 5xx、不编造正文；
//   ② 有行时字段映射正确（含闭集顺序、接收方只取当前版本、旧版本行被排除）；
//   ③ 数据不符合契约形状 / 多版本并存 ⇒ fail-closed 503，而不是挑一个版本凑出来；
//   ④ 无连接池 ⇒ fail-closed 503 `PROVIDER_UNAVAILABLE`（与 `routes/consents.ts` 既有 `requireService()` 同口径）；
//   ⑤ 路由已装配：静态读 `routes/consents.ts`，钉住路径、`noStoreHook`、`guards.requireUser` 与响应封套；
//   ⑥ 闭集与契约逐字一致：`capability` / `ConsentPurpose` / `PrivacyPolicy` 的必填与上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RECIPIENT_CAPABILITIES,
  UNPUBLISHED_POLICY_VERSION,
  createPostgresPrivacyPolicyReader,
  createPrivacyPolicyReaderForPool,
  createUnwiredPrivacyPolicyReader,
} from '../../services/api/src/privacy/privacy-policy.ts';

const CONTRACT = new URL('../../packages/contracts/openapi.json', import.meta.url);
const ROUTES = new URL('../../services/api/src/routes/consents.ts', import.meta.url);
const MODULE = new URL('../../services/api/src/privacy/privacy-policy.ts', import.meta.url);

/**
 * 内存 SQL 桩：按语句首行分派，并记录「接收方查询收到的版本参数」，
 * 用来证明清单确实按当前版本过滤，而不是把整表倒出来。
 */
function stub({ policies = [], recipients = [] } = {}) {
  const seen = [];
  const query = async (text, values) => {
    seen.push({ text, values });
    if (text.startsWith('SELECT purpose,policy_version')) return { rows: policies };
    if (text.startsWith('SELECT id,display_name')) {
      return { rows: recipients.filter(row => row.policy_version === values[0]) };
    }
    throw new Error(`未预期的 SQL：${text.slice(0, 40)}`);
  };
  return { query, seen };
}

const recipient = (overrides = {}) => ({
  id: 'rcp_asr',
  display_name: '语音转写服务商',
  capability: 'asr',
  policy_version: 'v2',
  retention_online_days: 0,
  retention_backup_days: 0,
  no_training_verified: true,
  deletion_verified: true,
  ...overrides,
});

test('空态诚实：没有政策行 ⇒ 200 + version=unpublished，不编造政策文本也不 5xx', async () => {
  const { query, seen } = stub();
  const view = await createPostgresPrivacyPolicyReader({ query }).read();
  // 唯一合法空态：契约 PrivacyPolicy 四个字段全部 required、version 还有 minLength:1，所以不能是 null。
  assert.deepEqual(view, {
    version: UNPUBLISHED_POLICY_VERSION,
    purposes: [],
    recipients: [],
    training_enabled: false,
  });
  assert.equal(UNPUBLISHED_POLICY_VERSION, 'unpublished');
  assert.ok(view.version.length >= 1 && view.version.length <= 80, 'version 必须落在契约 minLength 1 / maxLength 80 内');
  // 空表只查政策表：没有版本就没有可披露的接收方清单，不去拿上一版凑数。
  assert.equal(seen.length, 1, `空态只应发出 1 条查询，实际 ${seen.length} 条`);
  assert.ok(!seen[0].text.includes('public.recipients'), '空态不得查询 recipients');
  // 读面不得返回任何政策正文（契约没有 body 字段，编造文本就是编造内容）。
  assert.deepEqual(Object.keys(view).sort(), ['purposes', 'recipients', 'training_enabled', 'version']);
});

test('有行时字段映射正确：版本/用途闭集顺序/接收方挂在当前版本上', async () => {
  const recipients = [
    recipient({ id: 'rcp_llm', display_name: '知识问答模型', capability: 'llm', policy_version: 'v2' }),
    recipient({ id: 'rcp_old', display_name: '上一版服务商', capability: 'ocr', policy_version: 'v1' }),
  ];
  const { query, seen } = stub({
    policies: [
      { purpose: 'public_posting', policy_version: 'v2' },
      { purpose: 'recording', policy_version: 'v2' },
      { purpose: 'media_processing', policy_version: 'v2' },
    ],
    recipients,
  });
  const view = await createPostgresPrivacyPolicyReader({ query }).read();
  assert.equal(view.version, 'v2');
  // 闭集顺序（recording → media_processing → external_inference → public_posting），不是字典序。
  assert.deepEqual(view.purposes, ['recording', 'media_processing', 'public_posting']);
  assert.deepEqual(view.recipients.map(row => row.id), ['rcp_llm'], '只返回挂在当前版本上的启用接收方');
  assert.deepEqual(view.recipients[0], {
    id: 'rcp_llm',
    display_name: '知识问答模型',
    capability: 'llm',
    policy_version: 'v2',
    retention_online_days: 0,
    retention_backup_days: 0,
    no_training_verified: true,
    deletion_verified: true,
  });
  assert.equal(view.training_enabled, false);
  // 清单查询必须带上当前版本参数（防止把整表倒出来）。
  const recipientsQuery = seen.find(entry => entry.text.startsWith('SELECT id,display_name'));
  assert.deepEqual(recipientsQuery.values, ['v2']);
});

test('哨兵撞车：库里真存了 policy_version=unpublished ⇒ 503，不冒充空态', async () => {
  // 库列没有 CHECK 约束，哨兵语义只由 readVersion 守；这里证明它真的被守住了。
  await rejectsUnavailable(
    createPostgresPrivacyPolicyReader({
      query: stub({ policies: [{ purpose: 'recording', policy_version: UNPUBLISHED_POLICY_VERSION }] }).query,
    }).read(),
    '政策表撞哨兵',
  );
  await assert.rejects(
    createPostgresPrivacyPolicyReader({
      query: stub({ policies: [{ purpose: 'recording', policy_version: UNPUBLISHED_POLICY_VERSION }] }).query,
    }).read(),
    error => {
      assert.match(error.message, /哨兵/, '错误文案必须点明「与空态哨兵撞车」，否则运维看不出该改数据');
      return true;
    },
  );
  // 接收方的 policy_version 走同一个守卫：接收方行也不会把哨兵带进响应。
  // 这里故意绕开桩的版本过滤（直连查询函数），否则「policy_version 不等于当前版本」的行
  // 会被 SQL 层滤掉，守卫在接收方这条路径上就测不到。
  const mixedQuery = async (text) => (text.startsWith('SELECT purpose,policy_version')
    ? { rows: [{ purpose: 'recording', policy_version: 'v2' }] }
    : { rows: [recipient({ policy_version: UNPUBLISHED_POLICY_VERSION })] });
  await rejectsUnavailable(
    createPostgresPrivacyPolicyReader({ query: mixedQuery }).read(),
    '接收方撞哨兵',
  );
});

const rejectsUnavailable = (promise, label) => assert.rejects(promise, error => {
  assert.equal(error.name, 'ApiError', `${label}：应抛 ApiError`);
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${label}：错误码应为 PROVIDER_UNAVAILABLE`);
  assert.equal(error.status, 503, `${label}：应为 503（不是 500/4xx）`);
  assert.equal(error.retryable, false, `${label}：重试不会成功，retryable 必须为 false`);
  return true;
}, `${label}：应 fail-closed`);

test('多版本并存或行不符契约形状 ⇒ fail-closed 503，不挑一个版本凑出来', async () => {
  // 各用途各自升版 ⇒ 单一 version 字段无法诚实表达（契约只有一个 version）。
  await rejectsUnavailable(
    createPostgresPrivacyPolicyReader({
      query: stub({ policies: [
        { purpose: 'recording', policy_version: 'v1' },
        { purpose: 'public_posting', policy_version: 'v2' },
      ] }).query,
    }).read(),
    '多版本并存',
  );
  // 枚举越界（契约 ConsentPurpose 闭集之外）。
  await rejectsUnavailable(
    createPostgresPrivacyPolicyReader({
      query: stub({ policies: [{ purpose: 'advertising', policy_version: 'v2' }] }).query,
    }).read(),
    '用途越界',
  );
  // 版本超长（契约 maxLength 80）。
  await rejectsUnavailable(
    createPostgresPrivacyPolicyReader({
      query: stub({ policies: [{ purpose: 'recording', policy_version: 'v'.repeat(81) }] }).query,
    }).read(),
    '版本超长',
  );
  // 保留期越过契约上限（online 7 / backup 30）。
  await rejectsUnavailable(
    createPostgresPrivacyPolicyReader({
      query: stub({ policies: [{ purpose: 'recording', policy_version: 'v2' }], recipients: [recipient({ retention_backup_days: 31 })] }).query,
    }).read(),
    '保留期越界',
  );
  // 能力越界（契约 Recipient.capability 闭集之外）。
  await rejectsUnavailable(
    createPostgresPrivacyPolicyReader({
      query: stub({ policies: [{ purpose: 'recording', policy_version: 'v2' }], recipients: [recipient({ capability: 'ad_targeting' })] }).query,
    }).read(),
    '能力越界',
  );
  // 布尔列给了字符串（"true"/"f" 一类真库返回值糊成布尔就是编造核验状态）。
  await rejectsUnavailable(
    createPostgresPrivacyPolicyReader({
      query: stub({ policies: [{ purpose: 'recording', policy_version: 'v2' }], recipients: [recipient({ no_training_verified: 'true' })] }).query,
    }).read(),
    '核验标志非布尔',
  );
});

test('无连接池 ⇒ fail-closed 503 PROVIDER_UNAVAILABLE（不冒充确定空态）', async () => {
  await rejectsUnavailable(createPrivacyPolicyReaderForPool(null).read(), '无连接池');
  await rejectsUnavailable(createUnwiredPrivacyPolicyReader('隐私政策数据库未配置').read(), '未接线实现');
  // 接线实现必须真的把查询转给连接池（否则「装配成功」只是个空壳）。
  const seen = [];
  const pool = { query: async (text, values) => { seen.push({ text, values }); return { rows: [] }; } };
  const view = await createPrivacyPolicyReaderForPool(pool).read();
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /FROM public\.consent_policies/);
  assert.equal(view.version, UNPUBLISHED_POLICY_VERSION);
});

test('路由已装配：routes/consents.ts 里有路径、noStoreHook 与 requireUser 闸门', () => {
  const text = readFileSync(ROUTES, 'utf8');
  const path = 'app.get(`${API_PREFIX}/me/privacy-policy`';
  // 只允许一处注册：重复注册会让 Fastify 启动即报 FST_ERR_DUPLICATED_ROUTE。
  assert.equal(text.split(path).length - 1, 1, `routes/consents.ts 里必须恰好一处 ${path}`);
  const from = text.indexOf(path);
  const block = text.slice(from, text.indexOf('  });', from));
  assert.match(block, /onRequest: noStoreHook/, '必须挂 noStoreHook（错误分支也要 no-store）');
  assert.match(block, /preHandler: guards\.requireUser/, '必须挂 requireUser（契约 security: userSession）');
  assert.match(block, /querystring: \{ type: 'object', additionalProperties: false \}/, 'GET 不接受任何查询参数');
  assert.match(block, /await policyReader\.read\(\)/, '必须走读面，不得就地编造政策内容');
  assert.match(block, /send\(\{ data, meta: buildMeta\(request, config\) \}\)/, '成功响应必须是 { data, meta } 封套');
  // noStoreHook 必须真实存在且真的写 no-store（否则路由引用的就是 undefined）。
  const hook = text.slice(text.indexOf('const noStoreHook'), text.indexOf('export function registerConsentRoutes'));
  assert.match(hook, /reply\.header\('Cache-Control', 'no-store'\)/);
  // 读面用未接线工厂装配：无连接池时 fail-closed，而不是让路由 500。
  assert.match(text, /createPrivacyPolicyReaderForPool\(pool\)/);
});

test('SQL 的生效条件与接收方过滤被源码文本钉住：删任一条必须红', () => {
  // 为什么要在源码上钉：内存桩是按语句首行匹配的替身，删掉真实 SQL 里的
  // `valid_until>clock_timestamp()` 或接收方的 `enabled`，上面所有行为测试仍然全绿
  // （桩不看条件），于是一条过期政策 / 一个已下线接收方就能悄悄流到用户面前。
  const policySrc = readFileSync(MODULE, 'utf8');
  // 当前政策的三个生效条件：启用、已评审、在有效窗口内。
  assert.match(policySrc, /WHERE enabled AND reviewed_at<=clock_timestamp\(\)/, '政策 SQL 丢了 enabled / reviewed_at 生效条件');
  assert.match(policySrc, /AND valid_from<=clock_timestamp\(\)/, '政策 SQL 丢了 valid_from 下界（未来生效的政策会被提前当成生效）');
  assert.match(policySrc, /valid_until>clock_timestamp\(\)/, '政策 SQL 丢了 valid_until 上界（过期政策会被当成仍在生效）');
  assert.match(policySrc, /ORDER BY purpose/, '政策 SQL 丢了确定性排序（用途顺序由 byPurposeOrder 兜底，但查询本身也要稳定）');
  // 接收方：必须同时有 enabled 与按当前版本过滤；漏 enabled 会披露已下线的接收方。
  assert.match(policySrc, /WHERE enabled AND policy_version=\$1/, '接收方 SQL 丢了 enabled 或按 policy_version 过滤');
});

test('闭集与契约逐字一致：capability / ConsentPurpose / PrivacyPolicy 必填与上限', () => {
  const openapi = JSON.parse(readFileSync(CONTRACT, 'utf8'));
  const { Recipient, ConsentPurpose, PrivacyPolicy, PrivacyPolicyEnvelope } = openapi.components.schemas;
  assert.deepEqual([...RECIPIENT_CAPABILITIES], Recipient.properties.capability.enum);
  assert.deepEqual(ConsentPurpose.enum, ['recording', 'media_processing', 'external_inference', 'public_posting']);
  // 空态口径的契约依据：version 不能是 null（minLength 1），四个字段全部必填。
  assert.deepEqual(PrivacyPolicy.required, ['version', 'purposes', 'recipients', 'training_enabled']);
  assert.equal(PrivacyPolicy.properties.version.minLength, 1);
  assert.equal(PrivacyPolicy.properties.version.maxLength, 80);
  assert.equal(PrivacyPolicy.properties.purposes.maxItems, 4);
  assert.equal(PrivacyPolicy.properties.recipients.maxItems, 30);
  assert.equal(PrivacyPolicy.properties.training_enabled.const, false);
  assert.equal(Recipient.properties.retention_online_days.maximum, 7);
  assert.equal(Recipient.properties.retention_backup_days.maximum, 30);
  assert.deepEqual([...Recipient.required].sort(), Object.keys(Recipient.properties).sort(), 'Recipient 八列全部必填，读面必须逐列取值');
  assert.deepEqual(PrivacyPolicyEnvelope.required, ['data', 'meta']);
  // 操作本身在契约里必须是 200 + userSession，否则本片装的是另一条路由。
  const operation = openapi.paths['/me/privacy-policy'].get;
  assert.equal(operation.operationId, 'getPrivacyPolicy');
  assert.deepEqual(operation.security, [{ userSession: [] }]);
  assert.ok('200' in operation.responses);
});

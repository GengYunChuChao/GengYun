/**
 * B7 小程序端统一失败/空态/模拟标记（Refs #28）
 * ----------------------------------------------------------------------------
 * 本文件把「统一状态层」从口头约定变成可复算的断言，覆盖四件事：
 *   1. 契约覆盖（**双向**）：`services/api/src/contract.ts` 的每一个错误码，`utils/states.js` 都有归类
 *      ——漏一个码就等于某个接口失败时页面无状态可渲染（静默空白），必须红；反过来，
 *      `states.js` 多出契约里没有、又不在显式客户端许可清单（`CLIENT_ONLY_CODES`）里的码，同样红。
 *   2. 分类语义：401→guest、403→denied、404→invalid、其余→error；「可重试」只给
 *      服务侧临时故障与冲突类，请求不合法/无权限/找不到不提供原地重试（重试无效）。
 *   3. 组件行为：`components/state-view` 用**真实模块**在 vm 里跑 refresh()，逐态断言
 *      渲染结果（含 403 自动升级成 denied 语气、denied 默认收起重试按钮、
 *      `mock` 等价既有 `stub`）——不是文本 grep 出来的「看起来对」。
 *   4. 五 Tab 接入与模拟标记：五个 Tab 的状态块都走同一组件并透传错误码；
 *      「替身/模拟」字样保持显式，禁止改成「真实」。
 *
 * 边界：这是静态文本 + 纯函数/组件生命周期模拟，**不是**微信开发者工具编译或真机渲染。
 * 开发者工具在本环境未取得，见 docs/verification/gy-i28-unified-states-20261021.md。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const states = require(join(root, 'miniprogram/utils/states.js'));
const read = relative => readFileSync(join(root, relative), 'utf8');

/** 从契约源读错误码闭集（唯一事实来源，不在测试里另抄一份）。 */
function contractCodes() {
  const source = read('services/api/src/contract.ts');
  const block = source.slice(source.indexOf('ERROR_STATUS_MAP'), source.indexOf('export const ERROR_CODES'));
  const codes = [];
  const pattern = /\b(\d{3}):\s*\[([^\]]+)\]/g;
  let match;
  while ((match = pattern.exec(block)) !== null) {
    for (const raw of match[2].split(',')) {
      const code = raw.trim().replace(/['"]/g, '');
      if (code) codes.push({ status: Number(match[1]), code });
    }
  }
  assert.ok(codes.length >= 20, '未能从 contract.ts 解析出错误码闭集——正则失配必须失败，不得静默通过');
  return codes;
}

/**
 * 用**真实** `utils/states.js` 载入组件定义，返回可直接调用的一层薄壳。
 * require 白名单只登记 `../../utils/states`：组件将来新增依赖会显式失败带依赖名，
 * 而不是被 blanket require 静默喂成替身。
 */
function loadStateView() {
  const source = read('miniprogram/components/state-view/state-view.js');
  const dependencies = new Map([['../../utils/states', states]]);
  let definition = null;
  const box = {
    module: { exports: {} },
    require: id => {
      if (!dependencies.has(id)) throw Error('Unexpected component dependency ' + id);
      return dependencies.get(id);
    },
    Component: value => { definition = value; },
    console
  };
  vm.runInNewContext(source, box);
  assert.ok(definition, 'state-view.js 未调用 Component()');
  return definition;
}

/** 按组件声明的 properties 默认值 + 传入属性造一个实例，跑一遍 refresh()。 */
function renderComponent(passed) {
  const definition = loadStateView();
  const data = Object.assign({}, definition.data);
  for (const [name, schema] of Object.entries(definition.properties)) data[name] = schema.value;
  Object.assign(data, passed || {});
  const instance = {
    data,
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent() {}
  };
  definition.methods.refresh.call(instance);
  return instance.data;
}

test('契约错误码全覆盖（双向）：契约里的每个码都有状态归类，states.js 也不许多出未登记的码', () => {
  const contract = contractCodes();
  for (const { status, code } of contract) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(states.CODE_KIND, code),
      `${code}（HTTP ${status}）在 utils/states.js 里没有归类——该错误发生时页面将无状态可渲染`
    );
    const kind = states.CODE_KIND[code];
    assert.ok(states.KIND_LABEL[kind], `${code} 的分类 ${kind} 没有中文标签`);
  }

  // 反方向：states.js 的每个码要么在契约里，要么在**显式**的客户端自造码许可清单里。
  // 多一个未登记的码同样算红——它要么是页面会按一个契约永远给不出的码渲染状态，
  // 要么是契约删码后留下的僵尸归类，两种都让这张表不再可信。
  const inContract = new Set(contract.map((entry) => entry.code));
  const allowlist = new Set(states.CLIENT_ONLY_CODES);
  const unregistered = Object.keys(states.CODE_KIND).filter(
    code => !inContract.has(code) && !allowlist.has(code)
  );
  assert.deepEqual(
    unregistered,
    [],
    'states.js 有契约里没有、也不在 CLIENT_ONLY_CODES 里的码：' + unregistered.join('、')
  );
  assert.equal(
    new Set(states.CLIENT_ONLY_CODES).size,
    states.CLIENT_ONLY_CODES.length,
    'CLIENT_ONLY_CODES 有重复项'
  );
  // 许可清单不得空转：每条都要真的在 CODE_KIND 里，且真的不在契约里（真在契约里就该删掉这一条）。
  for (const code of states.CLIENT_ONLY_CODES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(states.CODE_KIND, code),
      `CLIENT_ONLY_CODES 的 ${code} 在 CODE_KIND 里没有归类——清单与实现已漂移`
    );
    assert.ok(!inContract.has(code), `CLIENT_ONLY_CODES 的 ${code} 其实已在契约里——应从允许清单删除`);
  }
});

test('409 的两个业务规则拒绝：形态同 denied（锁住、无重试），但不得冒充「内容已变更」', () => {
  for (const code of ['LAST_SCOPE_MANAGER', 'SELF_DISABLE_DENIED']) {
    assert.equal(states.statusForCode(code), states.STATUS.DENIED, code + ' 必须按拒绝呈现，不能落成通用 error');
    assert.equal(states.retryableForCode(code), false, code + ' 换谁再点一次都是同样结果，不该给重试按钮');
    assert.equal(states.resolve(code).kindLabel, '操作不被允许', code + ' 的标签必须说清是「规则不让做」');
    assert.notEqual(states.CODE_KIND[code], 'conflict', code + ' 不是「内容已变更」——归 conflict 会给出假的可重试提示');
  }
  // refused 与 denied 必须分开：utils/auth.js 的 FORBIDDEN_CODES 由 kind === 'denied' 反推（契约 403 闭集），
  // 把 409 混进去会让 401/403 归因多出两个永不出现的成员。
  const deniedKinds = Object.keys(states.CODE_KIND).filter(code => states.CODE_KIND[code] === 'denied');
  for (const code of ['LAST_SCOPE_MANAGER', 'SELF_DISABLE_DENIED']) {
    assert.ok(deniedKinds.indexOf(code) === -1, code + ' 是 409，不该混进按 kind==="denied" 反推的 403 归因闭集');
  }
  // 组件层：页面即使按 error 传入，也渲染成锁住语气并按 denied 收起重试。
  const view = renderComponent({ status: 'error', errorCode: 'LAST_SCOPE_MANAGER', actionText: '重新尝试' });
  assert.equal(view.effectiveStatus, 'denied');
  assert.equal(view.kindTag, '操作不被允许');
  assert.equal(view.retryable, false);
  assert.equal(view.actionSuppressed, true, '规则拒绝下「重新尝试」必须收起');
});

test('分类语义：401→guest、403→denied、404→invalid、服务端故障→error 且可重试', () => {
  for (const code of ['SESSION_REQUIRED', 'SESSION_EXPIRED']) {
    assert.equal(states.statusForCode(code), states.STATUS.GUEST, code + ' 必须按未登录处理');
    assert.equal(states.retryableForCode(code), false, code + ' 不该提供原地重试');
  }
  for (const code of ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE', 'SELF_SCOPE_GRANT_DENIED']) {
    assert.equal(states.statusForCode(code), states.STATUS.DENIED, code + ' 必须与 guest 分开');
    assert.equal(states.retryableForCode(code), false, code + ' 重试不会变好，不该给重试');
    assert.equal(states.resolve(code).kindLabel, '没有权限');
  }
  assert.equal(states.statusForCode('NOT_FOUND'), states.STATUS.INVALID);
  assert.equal(states.statusForCode('OBJECT_UNAVAILABLE'), states.STATUS.INVALID);
  for (const code of ['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_OUTCOME_UNKNOWN', 'RATE_LIMITED', 'PROVIDER_QUOTA_EXCEEDED', 'REVISION_CONFLICT']) {
    assert.equal(states.statusForCode(code), states.STATUS.ERROR, code);
    assert.equal(states.retryableForCode(code), true, code + ' 属临时故障/冲突，应给原地重试');
  }
  for (const code of ['INVALID_REQUEST', 'INVALID_CURSOR', 'IDEMPOTENCY_KEY_REQUIRED', 'MEDIA_TOO_LARGE', 'MEDIA_TYPE_UNSUPPORTED', 'INPUT_UNCERTAIN']) {
    assert.equal(states.retryableForCode(code), false, code + ' 需用户改条件，原样重试无效');
  }
  // 未知码：宁可显示通用失败，也不得假装成功或伪造分类。
  assert.equal(states.statusForCode('SOMETHING_NEW'), states.STATUS.ERROR);
  assert.equal(states.retryableForCode('SOMETHING_NEW'), false);
  assert.equal(states.kindLabel('SOMETHING_NEW'), '');
});

test('替身/演示模式判定唯一：stub 与 preset_demo 算，「real」不算', () => {
  assert.equal(states.isMockMode('stub'), true);
  assert.equal(states.isMockMode('preset_demo'), true);
  assert.equal(states.isMockMode('real'), false);
  assert.equal(states.isMockMode(undefined), false);
});

test('组件：403 即使按 error 传入也渲染成 denied 语气，并收起重试按钮', () => {
  const denied = renderComponent({ status: 'error', errorCode: 'SCOPE_DENIED', title: '社区内容没有取到', desc: '这项内容不在你的可见范围。', actionText: '重新读取' });
  assert.equal(denied.effectiveStatus, 'denied');
  assert.equal(denied.kindTag, '没有权限');
  assert.equal(denied.retryable, false);
  assert.equal(denied.actionSuppressed, true, 'denied 下「重新读取」必须收起，403 重试无效');
  // 页面自己的领域文案仍然优先，不被组件覆盖。
  assert.equal(denied.resolvedTitle, '社区内容没有取到');
  assert.equal(denied.resolvedDesc, '这项内容不在你的可见范围。');
  assert.equal(denied.resolvedAction, '重新读取');
  // 针对性动作（如「去授权」）可显式保留。
  const grant = renderComponent({ status: 'error', errorCode: 'CONSENT_REQUIRED', actionText: '去授权', allowDeniedAction: true });
  assert.equal(grant.effectiveStatus, 'denied');
  assert.equal(grant.actionSuppressed, false);
});

test('组件：临时故障保留 error 语气并标可重试；未登录/失效/替身各有独立形态', () => {
  const unavailable = renderComponent({ status: 'error', errorCode: 'PROVIDER_UNAVAILABLE' });
  assert.equal(unavailable.effectiveStatus, 'error');
  assert.equal(unavailable.kindTag, '服务暂时不可用');
  assert.equal(unavailable.retryable, true);
  assert.equal(unavailable.actionSuppressed, false);

  const guest = renderComponent({ status: 'guest' });
  assert.equal(guest.effectiveStatus, 'guest');
  assert.equal(guest.resolvedTitle, '请先登录');
  assert.equal(guest.resolvedAction, '去登录');

  const invalid = renderComponent({ status: 'invalid' });
  assert.equal(invalid.effectiveStatus, 'invalid');

  // mock 是既有 stub 的别名：同一形态、同一文案，不新造第二套。
  const mock = renderComponent({ status: 'mock' });
  const stub = renderComponent({ status: 'stub' });
  assert.equal(mock.effectiveStatus, 'stub');
  assert.equal(mock.resolvedDesc, stub.resolvedDesc);
  assert.equal(mock.preset.icon, stub.preset.icon);

  // ready 不渲染（wxml 以 effectiveStatus 判定），且别名下也必须保持 ready。
  assert.equal(renderComponent({ status: 'ready' }).effectiveStatus, 'ready');
});

test('组件模板：渲染用 effectiveStatus，替身标签与分类标签都在，且无「真实」改写', () => {
  const wxml = read('miniprogram/components/state-view/state-view.wxml');
  assert.match(wxml, /wx:if="\{\{effectiveStatus !== 'ready'\}\}"/, 'ready 判定必须走 effectiveStatus，否则 mock 别名会漏渲染');
  assert.match(wxml, /wx:if="\{\{kindTag\}\}"/, '失败分类标签缺失');
  assert.match(wxml, /wx:if="\{\{effectiveStatus === 'stub'\}\}"/, '替身标签判定未跟随别名');
  assert.match(wxml, /替身数据 · 仅开发模式可见/, '替身标记文案被改动了——模拟标记必须保持显式');
  assert.match(wxml, /!actionSuppressed/, '无权限时收起按钮的条件缺失');

  const js = read('miniprogram/components/state-view/state-view.js');
  assert.match(js, /require\('\.\.\/\.\.\/utils\/states'\)/, '组件未接入统一状态层');
  assert.match(js, /denied: \{/, '缺少 denied 预设');
  assert.match(js, /const STATUS_ALIAS = \{\s*mock: 'stub'/, '缺 mock→stub 别名');
});

test('五 Tab 接入：状态块走统一组件，失败时透传契约错误码', () => {
  // home：mock + loading + error 三态，且失败不再与成功说明混成一行灰字。
  const home = read('miniprogram/pages/home/home.wxml');
  assert.match(home, /<state-view[\s\S]*?status="stub"/, 'home 缺少替身（mock）状态块');
  assert.match(home, /status="loading"/, 'home 缺少 loading 状态块');
  assert.match(home, /status="error"/, 'home 缺少 error 状态块');

  // community / messages：失败态透传错误码（403 由统一层升级为 denied）。
  for (const page of ['community', 'messages']) {
    const wxml = read(`miniprogram/pages/${page}/${page}.wxml`);
    assert.match(wxml, /error-code="\{\{errorCode\}\}"/, page + ' 失败态未把错误码交给统一状态层');
    assert.match(wxml, /status="loading"/, page + ' 缺少 loading 态');
    assert.match(wxml, /status="empty"|status="guest"/, page + ' 缺少空态或未登录态');
    assert.match(read(`miniprogram/pages/${page}/${page}.js`), /errorCode: \(error && error\.code\) \|\| ''/, page + '.js 未透传错误码');
  }

  // profile：读取失败同样透传码值（档案读取是最容易撞 403 的入口）。
  const profile = read('miniprogram/pages/profile/profile.wxml');
  assert.match(profile, /error-code="\{\{loadErrorCode\}\}"/, 'profile 失败态未透传错误码');
  assert.match(read('miniprogram/pages/profile/profile.js'), /loadErrorCode: \(e && e\.code\) \|\| ''/, 'profile.js 未透传错误码');

  // identify：permission_denied 分支即契约 CONSENT_REQUIRED，按 denied 呈现但保留「去授权」。
  const identify = read('miniprogram/pages/identify/identify.wxml');
  assert.match(identify, /error-code="\{\{branch === 'permission_denied' \? 'CONSENT_REQUIRED' : ''\}\}"/, 'identify 未把权限分支映射成契约码');
  assert.match(identify, /allow-denied-action="\{\{branch === 'permission_denied'\}\}"/, 'identify 的「去授权」动作会被 denied 收起');
});

test('模拟标记不得被改写：替身/演示字样在状态层与列表页均显式保留', () => {
  const statesSource = read('miniprogram/utils/states.js');
  const viewWxml = read('miniprogram/components/state-view/state-view.wxml');
  assert.match(viewWxml, /替身数据/, '统一组件里的替身标记消失');
  for (const page of ['community', 'messages']) {
    const wxml = read(`miniprogram/pages/${page}/${page}.wxml`);
    assert.match(wxml, /notice--stub/, page + ' 的置顶替身标注被删');
    assert.match(wxml, /🧪/, page + ' 的替身图标被删（不能只靠颜色区分）');
  }
  // 统一层不得出现「把模拟说成真实」的措辞。
  assert.doesNotMatch(statesSource, /真实(数据|结果|提供者)?（?无|已接入真实/, '统一状态层出现「模拟当真实」措辞');
  assert.match(statesSource, /替身|模拟/, '统一状态层应显式保留替身/模拟口径');
});

test('打包允许清单包含统一状态层：漏登记会让 state-view 在隔离工程里 MODULE_NOT_FOUND', () => {
  const prepare = read('tools/prepare-wechat.mjs');
  assert.match(prepare, /'utils\/states\.js'/, 'prepare-wechat 的文件允许清单未登记 utils/states.js');
});

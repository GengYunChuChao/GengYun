// PR #82 阻塞 C：详情页如何**真实消费**已确认档案上下文（页面级回归）。
//
// 以 vm 载入真实页面脚本 + 真实 miniprogram/utils/reference.js 适配层；
// profile-api 用可控替身驱动三种真实结果：已确认、未确认（空档案）、读取失败。
// 断言：
//   1) 门禁未通过不装载；
//   2) 档案已确认 → 上下文由档案派生，DoseCard 与该上下文同源；
//   3) 档案未确认 → 不产出适用结论与 DoseCard（不按空上下文放行）；
//   4) 档案读取失败 → 资料仍可查阅，但明确拒绝用量资格；
//   5) toggleDoseCard 与 load 消费**同一**已确认上下文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reference = require(path.join(root, 'miniprogram/utils/reference.js'));
const read = (p) => readFileSync(path.join(root, 'miniprogram', p), 'utf8');

/**
 * 载入真实页面。
 * @param {object} opts
 * @param {boolean} [opts.verified] 门禁是否通过
 * @param {{mode:'ok'|'empty'|'fail', crop_id?:string, region_code?:string}} [opts.profile]
 *        profile-api.read() 的模拟结果
 */
function loadPage({ verified = true, profile = { mode: 'ok', crop_id: 'crop_rice', region_code: '330100' } } = {}) {
  let page;
  const calls = { gate: 0, reads: 0 };
  // 身份世代：changeIdentity() 模拟换账号/重新登录，使旧 binding 不再 current。
  const identity = { epoch: 1 };
  const auth = { isLoggedIn: () => verified, requireLogin(cb) { calls.gate += 1; cb(verified); } };
  const gate = { exports: {} };
  vm.runInNewContext(read('utils/page-gate.js'), { module: gate, require: () => auth });
  const font = { exports: {} };
  vm.runInNewContext(read('utils/font-scale.js'), { module: font });
  const profileApi = {
    binding: () => ({ token: 't', epoch: identity.epoch }),
    current: (b) => Boolean(b) && b.epoch === identity.epoch,
    changeIdentity() { identity.epoch += 1; },
    read() {
      calls.reads += 1;
      if (profile.mode === 'fail') {
        const e = new Error('NETWORK_UNCERTAIN');
        e.code = 'NETWORK_UNCERTAIN';
        return Promise.reject(e);
      }
      if (profile.mode === 'empty') {
        return Promise.resolve({ crop_id: null, region_code: null, region_catalog_version: null, revision: 1 });
      }
      return Promise.resolve({
        crop_id: profile.crop_id ?? 'crop_rice',
        region_code: profile.region_code ?? '330100',
        region_catalog_version: 'v1',
        revision: 1,
      });
    },
    crops: () => Promise.resolve([]),
    regions: () => Promise.resolve([]),
    save: () => Promise.reject(new Error('not used')),
  };
  const sandbox = {
    Page(def) { page = { ...def, data: structuredClone(def.data), setData(p) { Object.assign(this.data, p); } }; },
    wx: { navigateBack() {}, redirectTo() {}, setClipboardData() {} },
    require: (id) => (id.endsWith('/page-gate') ? gate.exports : id.endsWith('/font-scale') ? font.exports : id.endsWith('/auth') ? auth : id.endsWith('/profile-api') ? profileApi : reference),
  };
  vm.runInNewContext(read('pages/referencedetail/referencedetail.js'), sandbox);
  return { page, calls, profileApi };
}

/** 等待页面内的 Promise 链结算（微任务队列）。 */
async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const REAL_ID = reference.records[0].record_id;
assert.ok(typeof REAL_ID === 'string' && REAL_ID !== '', '真实资料应存在');

test('阻塞 C：门禁未通过时详情不装载', () => {
  const { page } = loadPage({ verified: false });
  page.onLoad({ id: REAL_ID });
  assert.equal(page.data.found, false);
  assert.equal(page.data.detail, null);
});

test('阻塞 C：档案已确认 → 上下文由 /me/profile 派生，DoseCard 与适用结论同源', async () => {
  const { page, calls } = loadPage({ verified: true, profile: { mode: 'ok', crop_id: 'crop_rice', region_code: '330100' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  assert.equal(calls.reads, 1, '应真实读取一次档案');
  assert.equal(page.data.profileConfirmed, true, '档案已确认');
  // 按**真实 payload** 核对：profile-api 返回 { crop_id, region_code, region_catalog_version, revision }，
  // 页面原样保留该对象（不删真实字段来迎合测试）。
  assert.deepEqual(page.data.profileContext, {
    crop_id: 'crop_rice',
    region_code: '330100',
    region_catalog_version: 'v1',
    revision: 1,
  });
  // 但**适用上下文**只取已确认的作物与地区（不把目录版本/revision 当适用条件）。
  assert.equal(page.data.applicability.rule_version.length > 0, true);
  assert.equal(page.data.found, true, '资料仍可查阅');
  // 真实记录未标注地区 → 档案要求地区即不适用。
  assert.ok(page.data.applicability, '应产出适用结论');
  assert.equal(page.data.applicability.applicable, false, '未标注地区而档案要求地区 → 不适用');
  assert.ok(page.data.applicability.blocked.includes('region'));
  assert.equal(page.data.doseCard.renderable, false, '不适用 → DoseCard 不得渲染');
});

test('阻塞 C：档案未确认（空档案）→ 不产出用量资格，不按空上下文放行', async () => {
  const { page } = loadPage({ verified: true, profile: { mode: 'empty' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  assert.equal(page.data.profileConfirmed, false, '空档案不算已确认');
  assert.equal(page.data.profileContext, null);
  assert.equal(page.data.applicability, null, '未确认时不得给出适用结论');
  assert.equal(page.data.doseCard, null, '未确认时不得给出 DoseCard');
  assert.ok(page.data.profileError.length > 0, '应明确说明未确认原因');
  // 资料内容仍可查阅（「可以查阅」与「适用」分离）。
  assert.equal(page.data.found, true);
  assert.ok(page.data.detail, '资料本体仍可查阅');
});

test('阻塞 C：档案读取失败（网络/身份）→ 资料可查阅但明确拒绝用量资格', async () => {
  const { page } = loadPage({ verified: true, profile: { mode: 'fail' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  assert.equal(page.data.profileConfirmed, false, '读取失败不算已确认');
  assert.equal(page.data.applicability, null, '读取失败不得给出适用结论');
  assert.equal(page.data.doseCard, null, '读取失败不得给出 DoseCard');
  assert.ok(page.data.profileError.includes('未确认') || page.data.profileError.includes('重试'), '应给出可读失败原因');
  assert.equal(page.data.found, true, '资料本体仍可查阅');
});

test('阻塞 C：toggleDoseCard 与 load 消费同一已确认上下文', async () => {
  const { page } = loadPage({ verified: true, profile: { mode: 'ok', crop_id: 'crop_rice', region_code: '330100' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  const before = page.data.applicability;
  page.toggleDoseCard({ detail: { value: false } });
  assert.equal(page.data.doseCard.closed, true, '关闭开关应标记 closed');
  assert.equal(page.data.doseCard.renderable, false);
  page.toggleDoseCard({ detail: { value: true } });
  assert.equal(page.data.doseCard.closed, false);
  assert.deepEqual(page.data.applicability, before, '开关切换不得改变适用结论');
});

test('阻塞 C（监工补充）：档案确认后身份变更 → toggleDoseCard 不得用旧档案产出资格', async () => {
  const { page, profileApi } = loadPage({ verified: true, profile: { mode: 'ok', crop_id: 'crop_rice', region_code: '330100' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  // 前置：档案已确认且资格已产出。
  assert.equal(page.data.profileConfirmed, true, '前置：档案应已确认');
  assert.ok(page.data.applicability, '前置：应已产出适用结论');
  assert.ok(page.data.doseCard, '前置：应已产出 DoseCard');

  // 身份变更（换账号/重新登录）：旧 binding 不再 current。
  profileApi.changeIdentity();
  page.toggleDoseCard({ detail: { value: true } });

  assert.equal(page.data.profileConfirmed, false, '身份变更后档案不得仍视为已确认');
  assert.equal(page.data.profileContext, null, '身份变更后不得保留旧档案');
  assert.equal(page.data.doseCard, null, '身份变更后 toggle 不得产出 DoseCard');
  assert.equal(page.data.applicability, null, '身份变更后 toggle 不得产出适用结论');
  assert.ok(page.data.profileError.length > 0, '应说明档案已失效');
  // 资料本体仍可查阅（「可以查阅」与「适用」分离）。
  assert.equal(page.data.found, true, '资料仍可查阅');
  assert.ok(page.data.detail, '资料本体应保留');
});

test('阻塞 C（监工补充）：身份变更后 load 也不得用旧档案产出资格', async () => {
  const { page, profileApi } = loadPage({ verified: true, profile: { mode: 'ok', crop_id: 'crop_rice', region_code: '330100' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  assert.ok(page.data.applicability, '前置：应已产出适用结论');
  profileApi.changeIdentity();
  page.load(REAL_ID);
  assert.equal(page.data.profileConfirmed, false, '身份变更后 load 不得保留已确认档案');
  assert.equal(page.data.doseCard, null, '身份变更后 load 不得产出 DoseCard');
  assert.equal(page.data.applicability, null, '身份变更后 load 不得产出适用结论');
});

test('阻塞 C：同一身份下正例仍正常（不因身份绑定收紧而误拒）', async () => {
  const { page, profileApi } = loadPage({ verified: true, profile: { mode: 'ok', crop_id: 'crop_rice', region_code: '330100' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  // 未变更身份：资格正常产出。
  assert.equal(page.data.profileConfirmed, true);
  assert.ok(page.data.applicability);
  assert.ok(page.data.doseCard);
  // 再次确认绑定仍当前（不应误判为失效）。
  assert.equal(profileApi.current(profileApi.binding()), true);
  page.toggleDoseCard({ detail: { value: true } });
  assert.equal(page.data.profileConfirmed, true, '同一身份不得被误判为失效');
  assert.ok(page.data.applicability, '同一身份应保留适用结论');
});

test('阻塞 C：档案未确认时 toggleDoseCard 不得凭空产生用量资格', async () => {
  const { page } = loadPage({ verified: true, profile: { mode: 'empty' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  page.toggleDoseCard({ detail: { value: false } });
  page.toggleDoseCard({ detail: { value: true } });
  assert.equal(page.data.doseCard, null, '未确认档案时开关不得产生 DoseCard');
  assert.equal(page.data.applicability, null);
});

test('阻塞 C：页面经 profile-api 读取档案，不凭未接线字段构造上下文', () => {
  const src = read('pages/referencedetail/referencedetail.js');
  assert.ok(src.includes('profileApi.read()'), '应经 profile-api 读取档案');
  assert.ok(src.includes('profileConfirmed'), '应有已确认标志');
  assert.ok(!src.includes('this.data.profile.ingredient_content'), '不得凭未接线字段构造上下文');
});

// GY-I03 公开登记标签事实抽取器：离线回归（只用合成夹具，任何真实网络调用一律禁止）。
//
// 负控制（必红）：凭空构造的用量字段必须被 `assertNoUnsourcedFacts` 判为 UNSOURCED_FACT；
// 去掉该字段后同一记录必须通过（改回复绿）——这条证明工具不会无中生有地补用量/安全字段。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MIN_INTERVAL_FLOOR_MS,
  UsageError,
  assertNoUnsourcedFacts,
  assertOutPathOutsideRepo,
  buildLabelUrl,
  computeFactsSha256,
  extractLabelFacts,
  makeRunPlan,
  runFetch,
  sha256Hex,
  validateRegistrationNo
} from '../../tools/knowledge/fetch-icama-label.mjs';
import { main } from '../../tools/knowledge/fetch-icama-label.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/icama-label/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXED_NOW = '2026-10-15T00:00:00.000Z';

const readFixture = (registrationNo) =>
  readFileSync(join(FIXTURE_DIR, `label-${registrationNo}.html`), 'utf8');

const extractFixture = (registrationNo) => {
  const html = readFixture(registrationNo);
  return extractLabelFacts(html, {
    sourceUrl: buildLabelUrl('https://www.icama.cn', registrationNo),
    retrievedAt: FIXED_NOW,
    payloadSha256: sha256Hex(Buffer.from(html, 'utf8')),
    registrationNo,
    mode: 'fixture'
  });
};

test('合成标签页：身份/用量逐字照录，且不改写不换算', () => {
  const record = extractFixture('PD99999901');
  assert.equal(record.status, 'ok');
  assert.equal(record.registrationNoInPage, 'PD99999901');
  assert.equal(record.productName, '示例除草剂甲');
  assert.equal(record.holder, '示例农化（合成）有限公司');
  assert.equal(record.formulation, '示例悬浮剂');
  assert.equal(record.activeIngredient, '示例有效成分20%');
  assert.deepEqual(record.dosageAsPublished, ['40-60毫升/亩', '30毫升/亩']);
  assert.deepEqual(record.usageTable, [
    { cropSite: '示例水稻移栽田', target: '示例一年生杂草', dosage: '40-60毫升/亩', method: '药土法' },
    { cropSite: '示例水稻直播田', target: '示例莎草', dosage: '30毫升/亩', method: '喷雾' }
  ]);
  assert.equal(record.shelfLifeAsPublished, '2年');
  assert.equal(record.approvedAt, '2020-01-01');
  assert.equal(record.reapprovedAt, '2024-01-01');
  // 安全与治理字段：不推断、不冒充核实人、不写成已许可。
  assert.equal(record.validity, 'unknown');
  assert.equal(record.nullReasons.validity, 'label_page_does_not_state_registration_validity_period');
  assert.equal(record.reviewedBy, null);
  assert.equal(record.licensed, false);
  assert.equal(record.licenseSurveyStatus, 'not_established');
  assert.match(record.factsSha256, /^[0-9a-f]{64}$/);
  // 禁限用只做标签原文文本扫描，逐句原文照录。
  assert.ok(record.restrictedOrBanned.some((clause) => clause.includes('示例场景禁用')));
  assert.equal(record.restrictedOrBannedCheck, 'label_text_scan_only');
  // 本工具不抽取中毒急救/储运正文（避免把健康指导当结论落地）。
  assert.equal(record.firstAidAsPublished, undefined);
  assert.equal(record.storageTransportAsPublished, undefined);
});

test('负例必红：凭空构造的剂量字段必须被拒（改回复绿）', () => {
  const html = readFixture('PD99999901');
  const record = extractFixture('PD99999901');
  assert.doesNotThrow(() => assertNoUnsourcedFacts(record, html));

  const fabricated = { ...record, dosageAsPublished: ['100毫升/亩'] };
  assert.throws(
    () => assertNoUnsourcedFacts(fabricated, html),
    (error) => error.code === 'UNSOURCED_FACT' && error.field === 'dosageAsPublished[0]'
  );

  // 同一记录、只在表格里凭空加一行用量 ⇒ 同样必须红。
  const fabricatedRow = {
    ...record,
    usageTable: [...record.usageTable, { cropSite: '示例水稻移栽田', target: '示例一年生杂草', dosage: '100毫升/亩', method: '药土法' }]
  };
  assert.throws(() => assertNoUnsourcedFacts(fabricatedRow, html), /UNSOURCED_FACT/);

  const recovered = { ...fabricated, dosageAsPublished: record.dosageAsPublished };
  assert.doesNotThrow(() => assertNoUnsourcedFacts(recovered, html));
});

test('用量源缺（占位符）⇒ null 并记原因，不补 0、不推断', () => {
  const record = extractFixture('PD99999902');
  assert.equal(record.status, 'ok');
  assert.equal(record.dosageAsPublished, null);
  assert.equal(record.nullReasons.dosageAsPublished, 'dosage_cell_empty_or_placeholder_in_source');
  assert.deepEqual(record.usageTable, [
    { cropSite: '示例玉米田', target: '示例一年生杂草', dosage: null, method: '喷雾' }
  ]);
  assert.doesNotThrow(() => assertNoUnsourcedFacts(record, readFixture('PD99999902')));
});

test('站点报"查找无结果"⇒ not_found，全部事实字段保持 null', () => {
  const record = extractFixture('PD99999903');
  assert.equal(record.status, 'not_found');
  for (const field of ['productName', 'holder', 'activeIngredient', 'formulation', 'dosageAsPublished', 'usageTable', 'precautionsAsPublished']) {
    assert.equal(record[field], null, `${field} 必须为 null`);
  }
  assert.equal(record.nullReasons.all, 'source_reported_no_result_for_this_registration_no');
  assert.equal(record.factsSha256, null, '查不到就没有事实指纹，不得凭空生成');
});

test('返回登录/验证码页 ⇒ blocked，立即停止整轮（不绕过）', () => {
  const record = extractFixture('PD99999904');
  assert.equal(record.status, 'blocked');
  assert.equal(record.blockedKind, 'login_or_captcha_wall');
  assert.equal(record.productName, null);
  assert.equal(record.dosageAsPublished, null);
  assert.equal(record.nullReasons.all, 'source_returned_login_or_captcha_wall');
});

test('离线运行：默认模式绝不发起任何网络请求，遇墙即停', async () => {
  const calls = [];
  const runDir = mkdtempSync(join(tmpdir(), 'gy-icama-run-'));
  try {
    const plan = makeRunPlan({
      registrations: ['PD99999901', 'PD99999904', 'PD99999902'],
      baseUrl: 'https://www.icama.cn',
      outPath: join(runDir, 'out.json'),
      minIntervalMs: MIN_INTERVAL_FLOOR_MS,
      mode: 'fixture'
    });
    const { records, aborted } = await runFetch({
      plan,
      fixtureDir: FIXTURE_DIR,
      now: () => FIXED_NOW,
      fetchImpl: (...args) => {
        calls.push(args);
        throw new Error('离线模式不得发起网络请求');
      },
      sleepImpl: async () => {}
    });
    assert.deepEqual(calls, []);
    assert.equal(records.length, 2, '遇到登录墙后不得继续抓后面的证号');
    assert.equal(records[0].status, 'ok');
    assert.equal(records[1].status, 'blocked');
    assert.deepEqual(aborted, { kind: 'login_or_captcha_wall', registrationNo: 'PD99999904' });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('输出守卫：仓内路径一律拒绝（抽取结果与原始页面都不入仓）', () => {
  assert.throws(() => assertOutPathOutsideRepo(join(REPO_ROOT, 'out.json'), REPO_ROOT), UsageError);
  assert.throws(() => assertOutPathOutsideRepo(REPO_ROOT, REPO_ROOT), /不能指向仓库内路径/);
  const outside = join(tmpdir(), 'gy-icama-outside.json');
  assert.equal(assertOutPathOutsideRepo(outside, REPO_ROOT), outside);
});

test('登记证号格式校验：拒绝非法输入（避免被拼进 URL）', () => {
  assert.equal(validateRegistrationNo(' PD20080626 '), 'PD20080626');
  for (const bad of ['PD2008062', 'PD200806266', 'pd20080626', '../../etc/passwd', 'PD20080626&x=1', '', null, 'PD2008062a']) {
    assert.throws(() => validateRegistrationNo(bad), UsageError, `应拒绝：${String(bad)}`);
  }
  assert.equal(
    buildLabelUrl('https://www.icama.cn', 'PD20080626'),
    'https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD20080626'
  );
});

test('礼貌限速：默认 4000ms，硬下限 3000ms 低于即拒绝', () => {
  const base = {
    registrations: ['PD20080626'],
    baseUrl: 'https://www.icama.cn',
    outPath: join(tmpdir(), 'gy-icama-plan.json'),
    mode: 'fixture'
  };
  assert.equal(makeRunPlan(base).minIntervalMs, 4000);
  assert.equal(makeRunPlan({ ...base, minIntervalMs: 3000 }).minIntervalMs, 3000);
  assert.throws(() => makeRunPlan({ ...base, minIntervalMs: 2000 }), /不得低于礼貌下限/);
  assert.equal(makeRunPlan(base).urls[0].url.endsWith('pdno=PD20080626'), true);
});

test('CLI（离线）：只写仓外 JSON，含来源指针与哈希，不含任何原始页面标记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-icama-cli-'));
  const out = join(dir, 'labels.json');
  try {
    await main([
      '--fixture-dir', FIXTURE_DIR,
      '--registration', 'PD99999901',
      '--registration', 'PD99999903',
      '--out', out,
      '--now', FIXED_NOW
    ]);
    const written = readFileSync(out, 'utf8');
    const parsed = JSON.parse(written);
    assert.equal(parsed.mode, 'fixture');
    assert.equal(parsed.concurrency, 1);
    assert.equal(parsed.okCount, 1);
    assert.equal(parsed.notFoundCount, 1);
    const ok = parsed.records[0];
    assert.equal(ok.payloadSha256, sha256Hex(Buffer.from(readFixture('PD99999901'), 'utf8')));
    assert.equal(ok.retrievedAt, FIXED_NOW);
    assert.equal(
      ok.sourceUrl,
      'https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD99999901'
    );
    // 原始页面不入库/不落盘：输出里不得出现任何 HTML 结构。
    assert.equal(written.includes('<table'), false);
    assert.equal(written.includes('<!DOCTYPE'), false);
    assert.equal(written.includes('<span'), false);
    for (const value of Object.values(ok)) {
      if (typeof value === 'string') assert.ok(value.length < 500, '不得落整页文本');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('确定性：同输入同时间 ⇒ 抽取结果逐字一致', () => {
  assert.deepEqual(extractFixture('PD99999901'), extractFixture('PD99999901'));
});

test('两个指纹语义不同：载荷随 _SESSIONID 变化，事实层不变（内容比对用 factsSha256）', () => {
  const base = readFixture('PD99999901');
  const withToken = (token) => {
    const injected = base.replace(
      '<head>',
      `<head><script>var _ctx='/BasicdataSystem';\n\tvar _SESSIONID = '${token}';</script>`
    );
    assert.notEqual(injected, base, '注入必须生效');
    return injected;
  };
  const mk = (html) => extractLabelFacts(html, {
    sourceUrl: 'https://www.icama.cn/BasicdataSystem/pesticideRegistration/tagview.do?pdno=PD99999901',
    retrievedAt: FIXED_NOW,
    payloadSha256: sha256Hex(Buffer.from(html, 'utf8')),
    registrationNo: 'PD99999901',
    mode: 'network'
  });
  const first = mk(withToken('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
  const second = mk(withToken('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'));
  // 载荷指纹必然不同（站点每次请求换令牌）⇒ 不能当内容寻址 ID。
  assert.notEqual(first.payloadSha256, second.payloadSha256);
  // 事实指纹必须相同 ⇒ 事实层与令牌无关，可用于内容变更比对。
  assert.equal(first.factsSha256, second.factsSha256);
  assert.equal(first.factsSha256, computeFactsSha256(first));
  // 事实真的变了（改一个用量数字）⇒ factsSha256 必须变。
  const changedHtml = base.replace('40-60毫升/亩', '41-60毫升/亩');
  assert.notEqual(changedHtml, base);
  const changed = mk(changedHtml);
  assert.notEqual(changed.factsSha256, mk(base).factsSha256);
  // 事实指纹不含检索时刻/载荷哈希：换 retrievedAt 不影响。
  const laterAt = mk(base);
  laterAt.retrievedAt = '2030-01-01T00:00:00.000Z';
  assert.equal(computeFactsSha256(laterAt), mk(base).factsSha256);
});

// ------------------------------------------------- 返修回归（对抗审查 B1/B2/B3/B4）
const TOOL_SOURCE_PATH = fileURLToPath(new URL('../../tools/knowledge/fetch-icama-label.mjs', import.meta.url));
const NOTICE_PHRASES = ['书面许可', 'licensed=false', '不入库', '不得用于训练', '不得作为真实用量依据或评估答案键'];
const FAKE_REPO_ROOT = 'C:\\gy-fake-repo';

test('B1/B2 口径回归：工具头与产物 sourceNotice 必须写明"不得用于训练"等全部口径', async () => {
  const source = readFileSync(TOOL_SOURCE_PATH, 'utf8');
  assert.ok(source.includes('训练'), '工具头必须出现"训练"字样（本片返修前全文件 0 命中）');
  for (const phrase of NOTICE_PHRASES) {
    assert.ok(source.includes(phrase), `工具头必须写明：${phrase}`);
  }
  // B2：反补造不变式的覆盖边界必须写明是"页级包含"检查、不保证字段归属。
  for (const phrase of ['页级包含', '不保证字段归属']) {
    assert.ok(source.includes(phrase), `工具头必须写明反补造不变式的覆盖边界：${phrase}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'gy-icama-notice-'));
  const out = join(dir, 'labels.json');
  try {
    await main(['--fixture-dir', FIXTURE_DIR, '--registration', 'PD99999901', '--out', out, '--now', FIXED_NOW]);
    const { sourceNotice } = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(typeof sourceNotice, 'string');
    for (const phrase of NOTICE_PHRASES) {
      assert.ok(sourceNotice.includes(phrase), `产物 sourceNotice 必须写明：${phrase}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B3 守卫：显式拒绝 \\\\?\\ / \\\\.\\ 扩展前缀与 UNC 路径', () => {
  const benign = join(tmpdir(), 'gy-icama-benign.json');
  const rejected = [
    `\\\\?\\${benign}`,
    `\\\\.\\${benign}`,
    `\\\\?\\UNC\\localhost\\E$\\tmp\\x.json`,
    '\\\\localhost\\E$\\GengYunCommander\\x.json',
    '//localhost/E$/GengYunCommander/x.json'
  ];
  for (const raw of rejected) {
    assert.throws(
      () => assertOutPathOutsideRepo(raw, FAKE_REPO_ROOT),
      /UNC|扩展长度/,
      `必须拒绝：${raw}`
    );
  }
});

test('B3 守卫：junction 指向仓库时 realpath 判仓内 ⇒ 拒绝（词法上看似仓外也不算过关）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-icama-guard-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'gy-icama-guard-out-'));
  try {
    const toRepo = join(dir, 'to-repo');
    symlinkSync(resolve(REPO_ROOT), toRepo, 'junction');
    assert.throws(
      () => assertOutPathOutsideRepo(join(toRepo, 'out-probe.json'), REPO_ROOT),
      /不能指向仓库内路径/
    );
    // 正控制：junction 指向仓外目录 ⇒ 放行（守卫不是"一律拒绝"）。
    const toOutside = join(dir, 'to-outside');
    symlinkSync(outsideDir, toOutside, 'junction');
    const okPath = join(toOutside, 'ok.json');
    assert.equal(assertOutPathOutsideRepo(okPath, REPO_ROOT), okPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('B3 守卫：同仓库其它 worktree 与主检出也一律拒绝（跨 worktree 不放行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-icama-wt-'));
  try {
    // 合成仓库骨架：主检出 .git 是目录，链接工作树 .git 是指针文件（与真实布局同构）。
    const mainRoot = join(dir, 'main');
    const thisWt = join(dir, 'wt-a');
    const otherWt = join(dir, 'wt-b');
    for (const entry of ['wt-a', 'wt-b']) {
      mkdirSync(join(mainRoot, '.git', 'worktrees', entry), { recursive: true });
    }
    for (const [wt, name] of [[thisWt, 'wt-a'], [otherWt, 'wt-b']]) {
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, '.git'), `gitdir: ${join(mainRoot, '.git', 'worktrees', name)}\n`, 'utf8');
      writeFileSync(join(mainRoot, '.git', 'worktrees', name, 'gitdir'), `${join(wt, '.git')}\n`, 'utf8');
    }
    assert.throws(() => assertOutPathOutsideRepo(join(otherWt, 'out.json'), thisWt), /不能指向仓库内路径/);
    assert.throws(() => assertOutPathOutsideRepo(join(mainRoot, 'out.json'), thisWt), /不能指向仓库内路径/);
    const okPath = join(dir, 'outside.json');
    assert.equal(assertOutPathOutsideRepo(okPath, thisWt), okPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B4 记录形状：blocked / not_found 与 ok 用同一套键，缺项用 null 而不是缺键', async () => {
  const okKeys = Object.keys(extractFixture('PD99999901')).sort();
  const dirs = [];
  const tmpFor = (prefix) => {
    const made = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(made);
    return made;
  };
  try {
    // ① 页面报"查无结果"与 ② 登录/验证码墙：走抽取值路径。
    for (const no of ['PD99999903', 'PD99999904']) {
      assert.deepEqual(Object.keys(extractFixture(no)).sort(), okKeys, `${no} 的键形状必须与 ok 一致`);
    }

    // ③ 联网遇 403 ⇒ blocked（fetchImpl 为桩，绝不触达任何站点）。
    const plan403 = makeRunPlan({
      registrations: ['PD99999901'],
      baseUrl: 'https://www.icama.cn',
      outPath: join(tmpFor('gy-icama-403-'), 'out.json'),
      minIntervalMs: MIN_INTERVAL_FLOOR_MS,
      mode: 'network'
    });
    const blocked403 = (await runFetch({
      plan: plan403,
      now: () => FIXED_NOW,
      fetchImpl: async () => ({ status: 403, arrayBuffer: async () => new ArrayBuffer(0) }),
      sleepImpl: async () => {}
    })).records[0];
    assert.equal(blocked403.status, 'blocked');
    assert.deepEqual(Object.keys(blocked403).sort(), okKeys, 'http 403 记录的键形状必须与 ok 一致');
    assert.equal(blocked403.factsSha256, null, '阻断记录没有事实指纹');
    assert.equal(blocked403.registrationNoInPage, null);
    assert.equal(blocked403.validity, 'unknown', '阻断 ≠ 无效：有效期只是未查明');
    assert.equal(blocked403.payloadSha256, sha256Hex(Buffer.alloc(0)));

    // ④ 离线 fixture 缺失 ⇒ blocked。
    const planMissing = makeRunPlan({
      registrations: ['PD99999901'],
      baseUrl: 'https://www.icama.cn',
      outPath: join(tmpFor('gy-icama-miss-'), 'out.json'),
      minIntervalMs: MIN_INTERVAL_FLOOR_MS,
      mode: 'fixture'
    });
    const missing = (await runFetch({
      plan: planMissing,
      fixtureDir: tmpFor('gy-icama-empty-'),
      now: () => FIXED_NOW,
      sleepImpl: async () => {}
    })).records[0];
    assert.equal(missing.status, 'blocked');
    assert.deepEqual(Object.keys(missing).sort(), okKeys, 'fixture 缺失记录的键形状必须与 ok 一致');
    assert.equal(missing.payloadSha256, null);
    assert.equal(missing.factsSha256, null);
  } finally {
    for (const made of dirs) rmSync(made, { recursive: true, force: true });
  }
});

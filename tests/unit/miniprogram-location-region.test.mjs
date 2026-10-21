import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// —— GY-I05（#5）定位模块三条不变量（模块级 · 只钉既有实现，不改实现）——
//
// 覆盖分工（**不重复造**，已覆盖的部分如实登记）：
//   · tests/unit/miniprogram-profile.test.mjs:56-119 —— 页面侧：五类失败/无资源/省外/转换抛错
//     的可见文案 + 手选编辑态保留 + 坐标不进页面数据/存储/请求体；
//   · tests/unit/miniprogram-profile.test.mjs:120-129 —— locate 的 ok/out_of_coverage/
//     转换抛错/wxApi 缺失四分支，以及「模块**导出**里没有跟踪 API」；
//   · tests/integration/local-dev-profile-location.cjs —— 真实微信开发者工具模拟器
//     （需本机 automator SDK 与已开自动化端口的隔离工程，本次**未取得**，见交接）。
//
// 本文件只补模块级**尚未覆盖**的部分：
//   ① unavailable 分支本身的返回值与文案可达性（既有用例只钉了页面文案）；
//   ② locate 返回值**逐字段**形状：任何分支都不得出现坐标/平台原文；
//   ③ getLocation 的**入参**逐字段固定 + 坐标只交给内存转换资源；
//   ④ 跟踪/存储/请求接口**被调用即失败**（替身抛错），比「查模块导出」有牙；
//   ⑤ 一次 getLocation 只结算一次（首个回调定结果，后续回调不得改写）；
//   ⑥ classify 逐档 + message() 闭集兜底；
//   ⑦ 边界值：转换结果必须匹配 ^33[0-9]{4}$、wxApi 同步抛错、unavailable 的可达前提。
//
// 全部替身自造：不依赖真机、网络、微信开发者工具，也不发起任何真实定位。

const root = resolve(import.meta.dirname, '../..');
const locationRegion = createRequire(import.meta.url)(root + '/miniprogram/utils/location-region.js');
const MANUAL = /手选浙江市县/;
// 合成哨兵，不是任何真实位置；只用于证明坐标不外泄（与 profile 用例同一量级）。
const SENTINEL = { latitude: 123.4567, longitude: 89.0123 };
const SENTINEL_TEXT = ['123.4567', '89.0123'];
const COORD_KEYS = ['latitude', 'longitude', 'lat', 'lng', 'latitudeType', 'longitudeType', 'errMsg'];

// 替身 wxApi：只允许 getLocation。跟踪/存储/请求接口**记录后抛错**，
// 使「实现偷偷开持续跟踪或把坐标落盘」直接变红——比只查模块导出键名有牙。
function harness(reply, convert) {
  const seen = { getLocationOptions: [], convertArgs: [], forbidden: [] };
  const forbid = (name) => { seen.forbidden.push(name); throw new Error('forbidden platform call: ' + name); };
  const wx = {
    getLocation(options) { seen.getLocationOptions.push(options); reply(options); },
    startLocationUpdate: () => forbid('startLocationUpdate'),
    startLocationUpdateBackground: () => forbid('startLocationUpdateBackground'),
    onLocationChange: () => forbid('onLocationChange'),
    offLocationChange: () => forbid('offLocationChange'),
    chooseLocation: () => forbid('chooseLocation'),
    getFuzzyLocation: () => forbid('getFuzzyLocation'),
    setStorageSync: () => forbid('setStorageSync'),
    setStorage: () => forbid('setStorage'),
    removeStorageSync: () => forbid('removeStorageSync'),
    request: () => forbid('request'),
  };
  // convert 非函数时必须原样透传，才能走到 unavailable 分支。
  const wrapped = typeof convert === 'function'
    ? (latitude, longitude) => { seen.convertArgs.push([latitude, longitude]); return convert(latitude, longitude); }
    : convert;
  return { wx, seen, spawn: () => locationRegion.locate(wx, wrapped) };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

// —— 不变量 1：未注入转换资源 ⇒ unavailable，且页面回退手选文案可达 ——
test('不变量1 未注入地区转换资源：locate 如实返回 unavailable，手选回退文案可达', async () => {
  const h = harness((options) => options.success(SENTINEL), undefined);
  const result = plain(await h.spawn());
  assert.deepEqual(result, { status: 'unavailable' });
  // 页面回退手选的可达文案：模块自述的 MESSAGES.unavailable 与逐字一致，且带「手选浙江市县」。
  assert.equal(locationRegion.MESSAGES.unavailable, '地区转换资源尚未接入，请手选浙江市县。');
  assert.equal(locationRegion.message('unavailable'), '地区转换资源尚未接入，请手选浙江市县。');
  assert.match(locationRegion.message('unavailable'), MANUAL);
  // 无转换资源时坐标不得交给任何东西，也不得顺手开跟踪。
  assert.deepEqual(h.seen.convertArgs, []);
  assert.deepEqual(h.seen.forbidden, []);
  assert.equal(h.seen.getLocationOptions.length, 1);
  for (const text of SENTINEL_TEXT) assert.equal(JSON.stringify(result).includes(text), false);
});

// —— 不变量 2：坐标不外泄（返回值逐字段）——
test('不变量2 locate 任何分支的返回值只含 status 与可选 region_code，不含坐标与平台原文', async () => {
  const branches = [
    ['ok', [{ status: 'region_code', keys: ['region_code', 'status'] }], harness((o) => o.success(SENTINEL), () => '330102')],
    ['out_of_coverage', null, harness((o) => o.success(SENTINEL), () => null)],
    ['unavailable', null, harness((o) => o.success(SENTINEL), undefined)],
    ['failed·转换抛错', null, harness((o) => o.success(SENTINEL), () => { throw new Error('synthetic converter failure'); })],
    ['failed·平台原文含哨兵', null, harness((o) => o.fail({ errMsg: 'getLocation:fail platform boom 123.4567/89.0123' }), () => '330102')],
    ['denied', null, harness((o) => o.fail({ errMsg: 'getLocation:fail auth deny' }), () => '330102')],
    ['cancelled', null, harness((o) => o.fail({ errMsg: 'getLocation:fail cancel' }), () => '330102')],
    ['timeout', null, harness((o) => o.fail({ errMsg: 'getLocation:fail timeout' }), () => '330102')],
  ];
  for (const [label, expected, h] of branches) {
    const value = plain(await h.spawn());
    const keys = Object.keys(value).sort();
    const wantKeys = label === 'ok' ? ['region_code', 'status'] : ['status'];
    assert.deepEqual(keys, wantKeys, label + ' 返回字段集合不符：' + JSON.stringify(keys));
    assert.equal(typeof value.status, 'string', label);
    if (label === 'ok') assert.equal(value.region_code, '330102', label);
    for (const key of COORD_KEYS) assert.equal(key in value, false, label + ' 返回值不得含 ' + key);
    for (const text of SENTINEL_TEXT) assert.equal(JSON.stringify(value).includes(text), false, label + ' 返回值泄漏哨兵 ' + text);
    assert.equal(JSON.stringify(value).includes('errMsg'), false, label + ' 返回值不得回抄平台原文');
    assert.equal(JSON.stringify(value).includes('getLocation:fail'), false, label + ' 返回值不得回抄平台原文');
    if (expected) assert.deepEqual(value, { status: 'ok', region_code: '330102' });
  }
});

// —— 不变量 2：坐标只交给内存转换资源，不落存储、不发请求 ——
test('不变量2 locate 只把坐标交给内存转换资源：getLocation 入参逐字段固定，不落存储不发请求', async () => {
  const h = harness((o) => o.success(SENTINEL), () => '330102');
  assert.deepEqual(plain(await h.spawn()), { status: 'ok', region_code: '330102' });
  assert.equal(h.seen.getLocationOptions.length, 1, '一次 locate 只请求一次定位');
  const options = h.seen.getLocationOptions[0];
  assert.deepEqual(Object.keys(options).sort(), ['fail', 'success', 'type']);
  assert.equal(options.type, 'wgs84');
  assert.equal(typeof options.success, 'function');
  assert.equal(typeof options.fail, 'function');
  assert.equal('latitude' in options, false);
  assert.equal('longitude' in options, false);
  // 坐标恰好按 (latitude, longitude) 交给转换资源，且只交一次。
  assert.deepEqual(plain(h.seen.convertArgs), [[SENTINEL.latitude, SENTINEL.longitude]]);
  assert.deepEqual(h.seen.forbidden, [], '不得调用跟踪/存储/请求接口');
});

// —— 不变量 3：不做持续跟踪 ——
test('不变量3 不做持续跟踪：跟踪/存储/请求替身被调用即失败，成功与失败两条路径都不碰', async () => {
  for (const [label, reply] of [['定位成功', (o) => o.success(SENTINEL)], ['定位失败', (o) => o.fail({ errMsg: 'getLocation:fail timeout' })]]) {
    const h = harness(reply, () => '330102');
    // 替身自检：这些键被调用一定抛错，所以「seen.forbidden 为空」才等于「没被调用」。
    assert.throws(() => h.wx.startLocationUpdate(), /forbidden platform call: startLocationUpdate/);
    assert.throws(() => h.wx.onLocationChange(), /forbidden platform call: onLocationChange/);
    assert.throws(() => h.wx.setStorageSync('k', 'v'), /forbidden platform call: setStorageSync/);
    assert.throws(() => h.wx.request({}), /forbidden platform call: request/);
    const probe = harness(reply, () => '330102');
    await probe.spawn();
    assert.deepEqual(probe.seen.forbidden, [], label + ' 路径调用了跟踪/存储/请求接口');
    assert.equal(probe.seen.getLocationOptions.length, 1, label + ' 路径请求定位的次数不是 1');
  }
});

// —— 不变量 3：一次 getLocation 只结算一次 ——
test('不变量3 一次 getLocation 只结算一次：首个回调定结果，后续回调不得改写', async () => {
  // ① 先成功：后到的成功/失败都不得把结果改写成 cancelled/failed，也不得改写 region_code。
  let first;
  const h = harness((o) => { first = o; }, () => '330102');
  const pending = h.spawn();
  first.success(SENTINEL);
  first.success({ latitude: 9, longitude: 9 });
  first.fail({ errMsg: 'getLocation:fail cancel' });
  first.fail({ errMsg: 'getLocation:fail timeout' });
  assert.deepEqual(plain(await pending), { status: 'ok', region_code: '330102' });
  // ② 先失败：后到的成功不得把结果改写成 ok（"被忽略的失败"）。
  let second;
  const h2 = harness((o) => { second = o; }, () => '330102');
  const pending2 = h2.spawn();
  second.fail({ errMsg: 'getLocation:fail cancel' });
  second.success(SENTINEL);
  second.success({ latitude: 9, longitude: 9 });
  assert.deepEqual(plain(await pending2), { status: 'cancelled' });
  // ③ 先省外：后到的成功不得把结果改写成 ok（"被擅自改写的地区"）。
  let third;
  const h3 = harness((o) => { third = o; }, () => null);
  const pending3 = h3.spawn();
  third.success(SENTINEL);
  third.success({ latitude: 1, longitude: 2 });
  assert.deepEqual(plain(await pending3), { status: 'out_of_coverage' });
});

test('如实登记结算口径：settled 只挡 resolve，不挡 success 里对转换资源的调用（每次回调都转一次）', async () => {
  // 这一条**不是不变量判据**，是既有实现口径的characterization：
  //   location-region.js 的 success 回调先做 settled 早退检查再调用 convert，
  //   但 settled 只作用于 finish()；因此重复 success 会把坐标重复交给转换资源，
  //   **结果仍以首次为准**（上一条已钉）。实测：2 次 success ⇒ convert 被调用 2 次。
  // 若将来把守卫前移到 convert 之前使计数下降，那是改进而非回归——届时须显式更新本行。
  let cb; const h = harness((o) => { cb = o; }, () => '330102');
  const pending = h.spawn();
  cb.success(SENTINEL);
  cb.success(SENTINEL);
  assert.deepEqual(plain(await pending), { status: 'ok', region_code: '330102' });
  assert.equal(h.seen.convertArgs.length, 2, '既有口径：重复 success 每次都转一次');
  // 无论如何，每次调用拿到的都是同一对坐标——不得出现坐标串档/错配。
  for (const args of h.seen.convertArgs) assert.deepEqual(plain(args), [SENTINEL.latitude, SENTINEL.longitude]);
});

// —— 分类逐档：平台失败四档 + 文案同档 ——
test('平台失败分类逐档：授权类⇒denied、cancel⇒cancelled、timeout⇒timeout、其它⇒failed', async () => {
  const table = [
    ['getLocation:fail auth deny', 'denied'],
    ['getLocation:fail auth denied', 'denied'],
    ['getLocation:fail authorize no response', 'denied'],
    ['getLocation:fail authorization', 'denied'],
    ['getLocation:fail permission deny', 'denied'],
    ['getLocation:fail cancel', 'cancelled'],
    ['getLocation:fail:cancel', 'cancelled'],
    ['getLocation:fail timeout', 'timeout'],
    ['getLocation:fail the api need to be declared in the requiredPrivateInfos field in app.json', 'failed'],
    ['getLocation:fail unknown platform error', 'failed'],
  ];
  for (const [errMsg, expected] of table) {
    const h = harness((o) => o.fail({ errMsg }), () => '330102');
    assert.deepEqual(plain(await h.spawn()), { status: expected }, errMsg);
    assert.equal(locationRegion.classify(errMsg), expected, 'classify 与 locate 同档：' + errMsg);
    assert.equal(locationRegion.message(expected), locationRegion.MESSAGES[expected], errMsg);
    assert.match(locationRegion.message(expected), MANUAL, errMsg);
  }
  // 非字符串 / 缺失 errMsg 一律落 failed，不得因取属性而抛错。
  for (const errMsg of [undefined, null, 123, {}, []]) assert.equal(locationRegion.classify(errMsg), 'failed', JSON.stringify(errMsg));
});

test('如实登记分类口径：裸 permission / permission denied / system permission denied 落 failed', async () => {
  // 派单假设「permission ⇒ denied」；实读实现的 AUTH_FAILURES 只收完整短语
  // （auth deny / auth denied / authorize / authorization / permission deny）⇒
  // 下面三条常见平台原文实际落 failed。**只登记既有口径，本片不改实现**；
  // 是否收窄/放宽属另议，改动时本条会红，必须显式更新。
  for (const errMsg of ['permission', 'permission denied', 'getLocation:fail:system permission denied']) {
    assert.equal(locationRegion.classify(errMsg), 'failed', errMsg);
    const h = harness((o) => o.fail({ errMsg }), () => '330102');
    assert.deepEqual(plain(await h.spawn()), { status: 'failed' }, errMsg);
  }
});

// —— 边界：转换结果闭集 ——
test('转换结果必须是 ^33[0-9]{4}$ 字符串：其余一律 out_of_coverage，且不回显原值', async () => {
  for (const value of ['330000', '330102', '339999']) {
    const h = harness((o) => o.success(SENTINEL), () => value);
    assert.deepEqual(plain(await h.spawn()), { status: 'ok', region_code: value }, value);
  }
  const rejected = ['33010', '3301022', '440102', '330102 ', ' 330102', '330102\n', '330102\t', 'abc', '', '33０１０２', null, undefined, 330102, ['330102'], { code: '330102' }, true, NaN];
  for (const value of rejected) {
    const h = harness((o) => o.success(SENTINEL), () => value);
    const result = plain(await h.spawn());
    assert.deepEqual(result, { status: 'out_of_coverage' }, JSON.stringify(value));
    assert.equal(JSON.stringify(result).includes('330102'), false, '不得回显非法原值：' + JSON.stringify(value));
  }
});

// —— 边界：wxApi 形态与同步抛错 ——
test('边界 wxApi 缺失或 getLocation 非函数/同步抛错：一律 failed，不把异常抛给调用方', async () => {
  for (const wxApi of [null, undefined, {}, { getLocation: 'not-a-function' }, { getLocation: null }, { getLocation: 0 }]) {
    assert.deepEqual(plain(await locationRegion.locate(wxApi, () => '330102')), { status: 'failed' }, JSON.stringify(wxApi));
  }
  const syncThrow = { getLocation() { throw new Error('synthetic synchronous getLocation failure'); } };
  assert.deepEqual(plain(await locationRegion.locate(syncThrow, () => '330102')), { status: 'failed' });
  const typedThrow = { getLocation() { throw new TypeError('synthetic synchronous failure 123.4567'); } };
  const result = plain(await locationRegion.locate(typedThrow, () => '330102'));
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(JSON.stringify(result).includes('123.4567'), false);
});

// —— 边界：unavailable 的可达前提（如实登记 ordering）——
test('边界 unavailable 只在定位成功之后可达：定位失败时如实报告平台失败档，不冒充资源未接入', async () => {
  // 未注入转换资源 + 平台失败 ⇒ 报平台失败档（如 cancelled），**不是** unavailable。
  const h = harness((o) => o.fail({ errMsg: 'getLocation:fail cancel' }), undefined);
  assert.deepEqual(plain(await h.spawn()), { status: 'cancelled' });
  assert.equal(h.seen.getLocationOptions.length, 1);
  assert.deepEqual(h.seen.convertArgs, []);
  const denied = harness((o) => o.fail({ errMsg: 'getLocation:fail auth deny' }), undefined);
  assert.deepEqual(plain(await denied.spawn()), { status: 'denied' });
});

// —— message()/MESSAGES 闭集与兜底 ——
test('message(status) 是 MESSAGES 闭集加 failed 兜底：六档文案都指向手选浙江市县', async () => {
  assert.deepEqual(Object.keys(locationRegion.MESSAGES).sort(), ['cancelled', 'denied', 'failed', 'out_of_coverage', 'timeout', 'unavailable']);
  for (const status of Object.keys(locationRegion.MESSAGES)) assert.match(locationRegion.message(status), MANUAL, status);
  // 未知/空状态不得返回 undefined 或抛错：一律兜底到 failed 文案（ok 无失败文案，同样兜底）。
  for (const unknown of ['ok', 'bogus', '', null, undefined, 0, {}]) assert.equal(locationRegion.message(unknown), locationRegion.MESSAGES.failed, JSON.stringify(unknown));
  // 模块自述：不持续跟踪、不保存原始坐标。
  assert.match(locationRegion.EXPLAIN, /不会持续跟踪/);
  assert.match(locationRegion.EXPLAIN, /不会保存原始坐标/);
  assert.match(locationRegion.EXPLAIN, /确认/);
});

// —— GY-I05 补漏（Refs #5）：AC21 的「超时」必须是**可达的显式状态**，不能指望平台一定回调 ——
//
// 缺口（改前实读实现）：timeout 这一档**只能**由 wx.getLocation 的 fail 回调带
// `errMsg: 'getLocation:fail timeout'` 进入。若平台**永不回调** success／fail（系统授权弹窗被挂起、
// 部分 Android 机型吞掉回调），Promise 永不结算 ⇒ 页面停在「正在获取位置…」且 locating 恒为 true，
// 定位入口被 `if (... || this.data.locating) return` 长期挡住，也没有任何可见状态。
// 修法（本片）：locate 增加墙钟兜底，到点结算 { status: 'timeout' }，页面按既有 timeout 文案回落手选。
// 兜底不改端点、不新增错误码、不重试、不写存储、不上报，坐标仍只在内存里。
//
// 计时器替身自造：**不使用真实时钟**（真等 15s 会让单测变慢且不稳），也不依赖会被 mock 的全局 setTimeout。

function fakeClock() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = next; next += 1; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    // 只触发「到期」的计时器；未到期的保留，用来证明「没提前结算」。
    tick(ms) {
      const due = [...pending].filter(([, item]) => item.ms <= ms);
      for (const [id] of due) pending.delete(id);
      for (const [, item] of due) item.fn();
      return due.length;
    },
    get size() { return pending.size; },
    get delays() { return [...pending.values()].map((item) => item.ms); },
  };
}
const settleProbe = async (promise) => {
  let value = null;
  promise.then((result) => { value = result; });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return value;
};

// —— 超时兜底 1：平台永不回调 ⇒ 到点结算 timeout，不挂死、不重试 ——
test('超时兜底 平台永不回调：到点结算显式 timeout 状态，页面手选文案可达且只请求一次定位', async () => {
  const clock = fakeClock();
  const h = harness(() => {}, () => '330102'); // 既不 success 也不 fail
  const pending = locationRegion.locate(h.wx, () => '330102', { timer: clock });
  assert.equal(clock.size, 1, '必须装且只装一个兜底计时器');
  assert.deepEqual(clock.delays, [locationRegion.LOCATE_TIMEOUT_MS], '缺省兜底时长必须取模块常量');
  // 未到点绝不提前结算（否则就成了「动辄报超时」的假状态）。
  assert.equal(clock.tick(locationRegion.LOCATE_TIMEOUT_MS - 1), 0);
  assert.equal(await settleProbe(pending), null, '未到点前不得结算');
  // 到点：显式 timeout，任务真的是 timeout 这一档文案（带「手选浙江市县」）。
  assert.equal(clock.tick(locationRegion.LOCATE_TIMEOUT_MS), 1);
  assert.equal(clock.size, 0, '结算后不得留下悬挂计时器');
  const result = plain(await pending);
  assert.deepEqual(result, { status: 'timeout' });
  assert.equal(locationRegion.message(result.status), locationRegion.MESSAGES.timeout);
  assert.match(locationRegion.message(result.status), MANUAL);
  // 超时不是「重试」：仍只请求过一次定位，也没碰跟踪/存储/请求接口。
  assert.equal(h.seen.getLocationOptions.length, 1);
  assert.deepEqual(h.seen.forbidden, []);
  for (const text of SENTINEL_TEXT) assert.equal(JSON.stringify(result).includes(text), false);
});

// —— 超时兜底 2：超时后迟到的平台回调不得改写结果 ——
test('超时兜底 超时后迟到的 success/fail 一律不改写结果（不偷偷改成功、不改成取消）', async () => {
  const clock = fakeClock();
  let late = null;
  const h = harness((o) => { late = o; }, () => '330102');
  const pending = locationRegion.locate(h.wx, () => '330102', { timer: clock });
  clock.tick(locationRegion.LOCATE_TIMEOUT_MS);
  assert.deepEqual(plain(await pending), { status: 'timeout' });
  // 平台随后才回调（真实场景：用户很晚才在系统弹窗点允许）。
  late.success(SENTINEL);
  late.fail({ errMsg: 'getLocation:fail cancel' });
  assert.deepEqual(plain(await pending), { status: 'timeout' }, '超时结果不得被迟到回调改写');
  assert.deepEqual(h.seen.forbidden, [], '迟到回调也不得触发存储/请求');
});

// —— 超时兜底 3：正常结算即清计时器，且不改变既有六档口径 ——
test('超时兜底 先到先结算：平台成功/失败都立刻清掉兜底计时器，其后到点不产生第二次结算', async () => {
  const branches = [
    ['成功', (o) => o.success(SENTINEL), () => '330102', { status: 'ok', region_code: '330102' }],
    ['省外', (o) => o.success(SENTINEL), () => null, { status: 'out_of_coverage' }],
    ['拒绝授权', (o) => o.fail({ errMsg: 'getLocation:fail auth deny' }), () => '330102', { status: 'denied' }],
    ['取消', (o) => o.fail({ errMsg: 'getLocation:fail cancel' }), () => '330102', { status: 'cancelled' }],
    ['平台超时原文', (o) => o.fail({ errMsg: 'getLocation:fail timeout' }), () => '330102', { status: 'timeout' }],
  ];
  for (const [label, reply, convert, expected] of branches) {
    const clock = fakeClock();
    const h = harness(reply, convert);
    const result = plain(await locationRegion.locate(h.wx, convert, { timer: clock }));
    assert.deepEqual(result, expected, label);
    assert.equal(clock.size, 0, label + '：结算后必须清掉兜底计时器');
    // 计时器已清 ⇒ 即使再「拨表」也不会产生第二次结算，结果不变。
    assert.equal(clock.tick(10 * locationRegion.LOCATE_TIMEOUT_MS), 0);
    assert.deepEqual(plain(result), expected, label + '：结果不得被改写');
  }
});

// —— 超时兜底 4：时长可配、非法值退回缺省、可显式关掉 ——
test('超时兜底 时长可注入：非法值退回模块常量，timer:null 表示不设兜底（旧行为）', async () => {
  assert.equal(locationRegion.LOCATE_TIMEOUT_MS, 15000, '兜底时长是对外可见的常量，改动须显式更新本行');
  assert.equal(Number.isFinite(locationRegion.LOCATE_TIMEOUT_MS), true);
  assert.ok(locationRegion.LOCATE_TIMEOUT_MS > 0);
  for (const timeoutMs of [undefined, null, 0, -1, -15000, NaN, Infinity, '5000', {}, []]) {
    const clock = fakeClock();
    const h = harness(() => {}, () => '330102');
    locationRegion.locate(h.wx, () => '330102', { timeoutMs, timer: clock });
    assert.deepEqual(clock.delays, [locationRegion.LOCATE_TIMEOUT_MS], '非法时长必须退回缺省：' + String(timeoutMs));
    clock.tick(locationRegion.LOCATE_TIMEOUT_MS);
  }
  const clock = fakeClock();
  const h = harness(() => {}, () => '330102');
  const pending = locationRegion.locate(h.wx, () => '330102', { timeoutMs: 1234, timer: clock });
  assert.deepEqual(clock.delays, [1234], '合法时长必须被采用');
  clock.tick(1234);
  assert.deepEqual(plain(await pending), { status: 'timeout' });
  // timer:null ⇒ 不设兜底：平台不回调就保持 pending（与改前逐字相同，留给现场排查用）。
  const none = locationRegion.locate(harness(() => {}, () => '330102').wx, () => '330102', { timer: null });
  assert.equal(await settleProbe(none), null, 'timer:null 时不得凭空结算');
});

// —— 超时兜底 5：兜底只补状态来源，不改既有分支口径（回归哨兵）——
test('超时兜底 不影响既有分支：wxApi 缺失仍立刻 failed，且不会留下计时器', async () => {
  const clock = fakeClock();
  assert.deepEqual(plain(await locationRegion.locate(null, () => '330102', { timer: clock })), { status: 'failed' });
  assert.equal(clock.size, 0, '同步结算同样要清掉兜底计时器');
  const throwClock = fakeClock();
  const syncThrow = { getLocation() { throw new Error('synthetic synchronous getLocation failure'); } };
  assert.deepEqual(plain(await locationRegion.locate(syncThrow, () => '330102', { timer: throwClock })), { status: 'failed' });
  assert.equal(throwClock.size, 0);
});

// —— GY-I05 D2：地区转换资源**装配**（miniprogram/utils/region-converter.js）——
//
// 本片把 pages/profile/profile.js 的 `regionConverter: null` 硬编码换成装配模块的 build()。这里钉三件事：
//   ① 资源缺席 ⇒ build() 返回 null ⇒ locate 如实 unavailable（fail-closed，不假装转换成功）；
//   ② 资源**存在但校验不通过** ⇒ 同样不接线（宁可回退手选，也不用来源不明/口径不符的数据）；
//   ③ 资源**存在且校验通过** ⇒ 自动接线并返回浙江行政区代码，且该代码**必须能在
//      miniprogram/data/regions.js 与 packages/knowledge/catalog/regions-zhejiang.json 两份目录里查到**。
//      下文所有期望值都**从目录派生**（省根 → 市 → 县区），⛔ 不硬编码 region_code 绕过校验。
//
// 合成资源坐标为下标确定性生成的**假坐标**，不是任何真实质心，也不代表仓库取得了几何数据；
// 真实的 miniprogram/data/region-centroids.js 截至 2026-10-17 仍**未取得**（见交接 U3）。

const regionConverter = createRequire(import.meta.url)(root + '/miniprogram/utils/region-converter.js');
const mpCatalog = createRequire(import.meta.url)(root + '/miniprogram/data/regions.js');
const knowledgeCatalog = createRequire(import.meta.url)(root + '/packages/knowledge/catalog/regions-zhejiang.json');
const RESOURCE_ABSENT = !existsSync(resolve(root, 'miniprogram/data/region-centroids.js'));
const MP_CODES = new Set(mpCatalog.regions.map((r) => r.code));
const KNOWLEDGE_CODES = new Set(knowledgeCatalog.regions.map((r) => r.code));
const PROVINCE_ROOT = mpCatalog.regions.find((r) => r.parent_code === null);
const CITY_CODES = new Set(mpCatalog.regions.filter((r) => r.parent_code === PROVINCE_ROOT.code).map((r) => r.code));
const COUNTY_CODES = mpCatalog.regions.filter((r) => CITY_CODES.has(r.parent_code)).map((r) => r.code);
// 形状合法（^33[0-9]{4}$）但**不在目录里**的代码，由目录枚举得出，不是手写的。
const ABSENT_CODE = (() => {
  for (let i = 0; i < 10000; i += 1) { const code = '33' + String(i).padStart(4, '0'); if (!KNOWLEDGE_CODES.has(code)) return code; }
  throw new Error('无法从 33xxxx 空间里找到不在目录中的代码');
})();

function syntheticDocument(overrides) {
  const points = COUNTY_CODES.slice(0, 6).map((code, index) => ({ code, latitude: 27.9 + index * 0.05, longitude: 119.9 + index * 0.05 }));
  return Object.assign({
    schema: regionConverter.SCHEMA, state: 'available',
    source: '测试合成（不是真实几何数据）', license: '测试合成', retrieved_at: '2026-10-17',
    catalog_version: mpCatalog.catalog_version, max_distance_km: 5, points,
  }, overrides);
}

test('D2 装配·U3 未取得：仓库内没有 region-centroids.js ⇒ build() 返回 null，locate 落 unavailable 且坐标不外泄', async () => {
  const described = regionConverter.describe();
  assert.equal(described.resource_file, 'miniprogram/data/region-centroids.js');
  assert.equal(described.resource_module, '../data/region-centroids.js');
  assert.equal(described.wired, false);
  assert.equal(described.reason, 'resource-missing');
  assert.equal(described.point_count, 0);
  assert.equal(described.max_distance_km, null);
  assert.equal(described.source, null);
  assert.equal(described.license, null);
  // U3 如实登记：本片**未取得**几何资源。资源落地后本条必红，须显式更新交接与文档。
  assert.equal(RESOURCE_ABSENT, true, 'miniprogram/data/region-centroids.js 已出现：请更新 U3 登记与来源标注');
  const converter = regionConverter.build();
  assert.equal(converter, null);
  const h = harness((o) => o.success(SENTINEL), converter);
  const result = plain(await h.spawn());
  assert.deepEqual(result, { status: 'unavailable' });
  assert.match(locationRegion.message(result.status), MANUAL);
  assert.deepEqual(h.seen.convertArgs, []);
  assert.equal(h.seen.getLocationOptions.length, 1);
  assert.deepEqual(h.seen.forbidden, []);
  for (const text of SENTINEL_TEXT) assert.equal(JSON.stringify(result).includes(text), false);
});

test('D2 装配·资源存在但校验不通过一律不接线：逐条 reason + build() 为 null + locate 仍 unavailable', async () => {
  const valid = syntheticDocument();
  assert.equal(typeof regionConverter.build({ resource: valid }), 'function', '正例自检：合规文档必须接线，否则下表可能因恒不接线而全绿');
  const cases = [
    ['资源显式缺席', { resource: null }, 'resource-missing'],
    ['资源是字符串', { resource: 'region-centroids' }, 'resource-invalid'],
    ['资源是数组', { resource: [] }, 'resource-invalid'],
    ['schema 不符', { resource: syntheticDocument({ schema: 'gengyun.knowledge.regions.v1' }) }, 'schema'],
    ['state 未声明 available', { resource: syntheticDocument({ state: 'unavailable' }) }, 'state:unavailable'],
    ['缺 source', { resource: syntheticDocument({ source: '' }) }, 'source'],
    ['缺 license', { resource: syntheticDocument({ license: '   ' }) }, 'license'],
    ['缺 retrieved_at', { resource: syntheticDocument({ retrieved_at: null }) }, 'retrieved_at'],
    ['max_distance_km 非正', { resource: syntheticDocument({ max_distance_km: 0 }) }, 'max_distance_km'],
    ['points 为空', { resource: syntheticDocument({ points: [] }) }, 'points'],
    ['catalog_version 与目录不符', { resource: syntheticDocument({ catalog_version: 'mca-xzqh-1999' }) }, 'catalog-version'],
    ['点不是对象', { resource: syntheticDocument({ points: [null] }) }, 'point-invalid:0'],
    ['点 code 形状非法', { resource: syntheticDocument({ points: [{ code: '440102', latitude: 28, longitude: 120 }] }) }, 'point-code:0'],
    ['点 code 不在目录', { resource: syntheticDocument({ points: [{ code: ABSENT_CODE, latitude: 28, longitude: 120 }] }) }, 'code-not-in-catalog:' + ABSENT_CODE],
    ['点 code 重复', { resource: syntheticDocument({ points: [valid.points[0], Object.assign({}, valid.points[0], { latitude: 28.5 })] }) }, 'duplicate-code:' + valid.points[0].code],
    ['纬度越界', { resource: syntheticDocument({ points: [{ code: valid.points[0].code, latitude: 91, longitude: 120 }] }) }, 'point-latitude:0'],
    ['纬度非有限数', { resource: syntheticDocument({ points: [{ code: valid.points[0].code, latitude: '28', longitude: 120 }] }) }, 'point-latitude:0'],
    ['经度越界', { resource: syntheticDocument({ points: [{ code: valid.points[0].code, latitude: 28, longitude: 181 }] }) }, 'point-longitude:0'],
  ];
  for (const [label, options, reason] of cases) {
    const described = regionConverter.describe(options);
    assert.equal(described.reason, reason, label + ' 的 reason 不符');
    assert.equal(described.wired, false, label + ' 不得接线');
    const converter = regionConverter.build(options);
    assert.equal(converter, null, label + ' 不得给出转换函数');
    const h = harness((o) => o.success(SENTINEL), converter);
    assert.deepEqual(plain(await h.spawn()), { status: 'unavailable' }, label + ' 不得假装转换成功');
    assert.deepEqual(h.seen.convertArgs, [], label + ' 不得把坐标交给任何东西');
  }
});

test('D2 装配·资源合规即接线：region_code 经两份目录校验、最近质心、超出范围即 null、附来源', async () => {
  const document = syntheticDocument();
  const snapshot = plain(document);
  const convert = regionConverter.build({ resource: document });
  assert.equal(typeof convert, 'function');
  for (let index = 0; index < document.points.length; index += 1) {
    const point = document.points[index];
    const code = convert(point.latitude, point.longitude);
    assert.equal(code, point.code, '最近质心应命中该点自身（第 ' + index + ' 点）');
    assert.match(code, /^33[0-9]{4}$/);
    assert.equal(MP_CODES.has(code), true, 'miniprogram/data/regions.js 目录里必须有：' + code);
    assert.equal(KNOWLEDGE_CODES.has(code), true, 'packages/knowledge/catalog/regions-zhejiang.json 目录里必须有：' + code);
    assert.equal(COUNTY_CODES.includes(code), true);
  }
  // 超出 max_distance_km 一律 null（不是「就近猜一个」）：0.01° 纬度约 1.11km，阈值取 0.5km。
  const near = regionConverter.build({ resource: syntheticDocument({ max_distance_km: 0.5 }) });
  assert.equal(near(document.points[0].latitude + 0.01, document.points[0].longitude), null);
  assert.equal(near(document.points[0].latitude, document.points[0].longitude), document.points[0].code);
  // 合成哨兵离所有合成点都很远 ⇒ null；非法入参一律 null 且不得抛错。
  assert.equal(convert(SENTINEL.latitude, SENTINEL.longitude), null);
  for (const args of [[undefined, undefined], [null, null], ['28', 120], [NaN, 120], [28, NaN], [Infinity, 120], [{}, []]]) {
    assert.equal(convert(args[0], args[1]), null, '非法入参必须 null：' + JSON.stringify(args));
  }
  // 来源可追溯：装配结果自带 provenance，且与资源声明一致。
  assert.equal(convert.provenance.schema, regionConverter.SCHEMA);
  assert.equal(convert.provenance.source, document.source);
  assert.equal(convert.provenance.license, document.license);
  assert.equal(convert.provenance.retrieved_at, document.retrieved_at);
  assert.equal(convert.provenance.catalog_version, mpCatalog.catalog_version);
  assert.equal(convert.provenance.point_count, document.points.length);
  assert.equal(convert.provenance.max_distance_km, document.max_distance_km);
  assert.equal(convert.provenance.method, 'nearest-centroid');
  assert.equal(regionConverter.describe({ resource: document }).wired, true);
  assert.equal(regionConverter.describe({ resource: document }).source, document.source);
  // 只读消费：转换不得改写资源文档。
  assert.deepEqual(plain(document), snapshot);
});

test('D2 装配·接线后 locate 成功路径：region_code 来自目录校验、坐标只在入参出现一次、省外仍 out_of_coverage', async () => {
  const document = syntheticDocument();
  const convert = regionConverter.build({ resource: document });
  const target = document.points[2];
  const h = harness((o) => o.success({ latitude: target.latitude, longitude: target.longitude }), convert);
  const result = plain(await h.spawn());
  assert.deepEqual(Object.keys(result).sort(), ['region_code', 'status']);
  assert.equal(result.status, 'ok');
  assert.equal(result.region_code, target.code);
  assert.equal(MP_CODES.has(result.region_code), true);
  assert.equal(KNOWLEDGE_CODES.has(result.region_code), true);
  // getLocation 入参逐字段固定；坐标只交给内存转换资源一次；不碰跟踪/存储/请求接口。
  const options = h.seen.getLocationOptions[0];
  assert.deepEqual(Object.keys(options).sort(), ['fail', 'success', 'type']);
  assert.equal(options.type, 'wgs84');
  assert.equal(typeof options.success, 'function');
  assert.equal(typeof options.fail, 'function');
  assert.equal('latitude' in options, false);
  assert.equal('longitude' in options, false);
  assert.deepEqual(plain(h.seen.convertArgs), [[target.latitude, target.longitude]]);
  assert.deepEqual(h.seen.forbidden, []);
  for (const text of [String(target.latitude), String(target.longitude)]) {
    assert.equal(JSON.stringify(result).includes(text), false);
    assert.equal(JSON.stringify(plain(h.seen.getLocationOptions)).includes(text), false);
  }
  // 覆盖范围之外：接线了也不假装成功，如实回 out_of_coverage。
  const far = harness((o) => o.success(SENTINEL), convert);
  assert.deepEqual(plain(await far.spawn()), { status: 'out_of_coverage' });
});

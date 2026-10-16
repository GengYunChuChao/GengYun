import { test } from 'node:test';
import assert from 'node:assert/strict';
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

// GY-I05（#5）工具链定位分支：真实微信开发者工具模拟器 + 真实页面代码 + 真实 loopback HTTP。
//
// 前提（与既有 tests/integration/local-dev-*.cjs 相同）：官方 miniprogram-automator 目录、已用
// tools/prepare-wechat.mjs 生成并开启自动化端口的隔离工程、runtime 指向本地替身 API（.local/ 内，
// 不进版本库）。本脚本不新增业务依赖：SDK 目录由参数传入，仅作为本机工具使用。
//
// 覆盖与边界（**分开标注**，不把受控替身当真实授权）：
//   - 受控注入：拒绝/取消/超时/平台不支持 四类 getLocation 失败、确认框"改用手选"、
//     哨兵坐标成功但无转换资源、省外（转换资源返回 null）、有转换资源时只预选不自动保存；
//   - 真实：模拟器真实 wx.login 换取会话、真实 wx.request 走本地 API、真实 wx.getLocation 原始返回；
//   - **不在本脚本内**：工具原生授权弹窗的允许/拒绝点击、真机（Tool.enableRemoteDebug 需手机扫码，
//     自动化会一直等 Tool.onRemoteDebugConnected），它们需要 GUI／手机操作。
//
// 用法：node tests/integration/local-dev-profile-location.cjs <automator 目录> <输出目录> [端口=9420]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [sdkDir, outDir, portArg = '9420'] = process.argv.slice(2);
if (!sdkDir || !outDir) throw Error('SDK directory and output directory required');
const port = Number(portArg);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const sdk = require(path.resolve(sdkDir));
const SENTINEL = { lat: 123.4567, lng: 89.0123 };
const SENTINEL_TEXT = ['123.4567', '89.0123'];
let mini;
const stage = { value: 'connect' };
const timer = setTimeout(() => { console.error('Timeout at ' + stage.value); process.exitCode = 2; try { mini.disconnect(); } catch (e) {} }, 240000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  mini = await sdk.connect({ wsEndpoint: 'ws://127.0.0.1:' + port });
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  const info = await mini.systemInfo();
  const report = {
    kind: 'actual native devtools simulator + real page code + real loopback HTTP; 平台失败分支为受控注入，不是真实授权弹窗',
    platform: { platform: info.platform, SDKVersion: info.SDKVersion, windowWidth: info.windowWidth, windowHeight: info.windowHeight },
    branches: [],
  };

  // 确保登录态并进入"我的"页（真实 wx.login → 本地 API；顺序可能是 登录页 → 微信登录 → 首页）
  stage.value = 'login';
  let profile = null;
  for (let attempt = 0; attempt < 3 && !profile; attempt++) {
    if ((await mini.currentPage()).path === 'pages/login/login') {
      for (const b of await (await mini.currentPage()).$$('button')) {
        if ((await b.text()).includes('微信登录')) { await b.tap(); break; }
      }
      for (let i = 0; i < 120; i++) { if ((await mini.currentPage()).path !== 'pages/login/login') break; await sleep(250); }
    }
    try { await mini.switchTab('/pages/profile/profile'); } catch (e) {}
    for (let i = 0; i < 80; i++) {
      const p = await mini.currentPage();
      if (p.path === 'pages/profile/profile') { profile = p; break; }
      if (p.path === 'pages/login/login') break;
      await sleep(250);
    }
  }
  assert.ok(profile, '"我的"页未进入');
  for (let i = 0; i < 120; i++) { if (await profile.data('loaded') && !(await profile.data('busy'))) break; await sleep(250); }
  assert.equal(await profile.data('guest'), false, '登录态未建立');
  report.catalog = { crops: (await profile.data('crops')).length, regions: (await profile.data('regions')).length };

  // 受控确认框：confirm=true 表示"允许并定位"，false 表示"改用手选"（工具原生弹窗自动化点不到）
  await mini.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' });

  async function enterEdit() {
    const p = await mini.currentPage();
    if (!(await p.data('editing'))) {
      for (const b of await p.$$('button')) { if ((await b.text()).includes('手选作物')) { await b.tap(); break; } }
      for (let i = 0; i < 60; i++) { if (await p.data('editing')) break; await sleep(150); }
    }
    return p;
  }
  async function tapLocate() {
    const p = await mini.currentPage();
    for (const b of await p.$$('button')) {
      if ((await b.text()).includes('使用定位选地区')) {
        const pos = await b.offset();
        await mini.pageScrollTo(Math.max(0, pos.top - 100));
        await sleep(120);
        await b.tap();
        return;
      }
    }
    throw new Error('定位按钮未渲染');
  }
  async function branch(label, expected, setup, options) {
    stage.value = 'branch:' + label;
    const p = await enterEdit();
    if (setup) await setup();
    await tapLocate();
    for (let i = 0; i < 60; i++) { if (!(await p.data('locating'))) break; await sleep(150); }
    await sleep(250);
    const entry = { label, message: await p.data('message'), editing: await p.data('editing'), locating: await p.data('locating') };
    if (options && options.selection) entry.selection = { cityIndex: await p.data('cityIndex'), countyIndex: await p.data('countyIndex') };
    report.branches.push(entry);
    assert.match(String(entry.message), new RegExp(expected), label + ' 文案不符：' + entry.message);
    assert.equal(entry.editing, true, label + ' 失败后没有保留手选编辑态');
    assert.equal(entry.locating, false, label + ' 结束后仍显示定位中');
    if (options && options.selection) {
      assert.ok(entry.selection.cityIndex >= 0, label + ' 未预选到浙江市级');
      const counties = await p.data('counties');
      assert.ok(counties.some(c => c.code === '330102'), label + ' 未按定位预选县区');
    }
    return entry;
  }
  const fail = errMsg => () => mini.evaluate(msg => { wx.__gyGetLocation = wx.__gyGetLocation || wx.getLocation; wx.getLocation = o => o.fail({ errMsg: msg }); }, errMsg);
  const succeed = (withConverter) => async () => {
    await mini.evaluate(() => { const p = getCurrentPages().slice(-1)[0]; p.regionConverter = null; });
    if (withConverter) await mini.evaluate(code => { getCurrentPages().slice(-1)[0].regionConverter = function () { return code; }; }, withConverter === 'out' ? null : withConverter);
    await mini.evaluate((lat, lng) => { wx.__gyGetLocation = wx.__gyGetLocation || wx.getLocation; wx.getLocation = o => o.success({ latitude: lat, longitude: lng }); }, SENTINEL.lat, SENTINEL.lng);
  };
  const storageDump = () => mini.evaluate(() => {
    const info2 = wx.getStorageInfoSync();
    const values = {};
    for (const key of info2.keys) values[key] = wx.getStorageSync(key);
    return { keys: info2.keys, values: JSON.stringify(values) };
  });

  // 1. 确认框里改用手选（不触发任何定位 API）
  await mini.mockWxMethod('showModal', { confirm: false, cancel: true, errMsg: 'showModal:ok' });
  await branch('确认框选改用手选', '已选择手选', null, null);
  await mini.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' });

  // 2-5. 平台侧四类失败（受控注入 errMsg，分类逻辑来自 miniprogram/utils/location-region.js）
  await branch('拒绝授权', '未获得定位授权', fail('getLocation:fail auth deny'), null);
  await branch('用户取消', '已取消定位', fail('getLocation:fail cancel'), null);
  await branch('定位超时', '定位超时', fail('getLocation:fail timeout'), null);
  await branch('平台不支持', '定位不可用或平台不支持', fail('getLocation:fail the api need to be declared in the requiredPrivateInfos field in app.json'), null);

  // 6. 允许 + 哨兵坐标 + 无转换资源（首版真实状态：不内置坐标→地区资源）⇒ 只回退手选
  await branch('哨兵坐标·无转换资源', '地区转换资源尚未接入', succeed(false), null);

  // 7. 省外：有转换资源但返回 null
  await branch('省外', '不在首版覆盖的浙江省', succeed('out'), null);

  // 8. 有转换资源 ⇒ 只预选县区，不自动保存
  const revisionBeforeSelection = (await (await mini.currentPage()).data('profile')).revision;
  await branch('受控转换资源预选县区', '已按定位预选', succeed('330102'), { selection: true });
  assert.equal((await (await mini.currentPage()).data('profile')).revision, revisionBeforeSelection, '定位预选不得自动保存档案');

  // 哨兵坐标不得进入存储或页面数据（页面只把坐标交给内存里的转换资源）
  const storage = await storageDump();
  const pageDataJson = await mini.evaluate(() => JSON.stringify(getCurrentPages().slice(-1)[0].data));
  report.privacy = {
    sentinelInStorage: SENTINEL_TEXT.filter(t => storage.values.includes(t)),
    sentinelInPageData: SENTINEL_TEXT.filter(t => pageDataJson.includes(t)),
    storageKeys: storage.keys,
  };
  assert.deepEqual(report.privacy.sentinelInStorage, [], '哨兵坐标进入存储');
  assert.deepEqual(report.privacy.sentinelInPageData, [], '哨兵坐标进入页面数据');

  // 9. 定位失败若干次之后仍能手选并真实保存（以 revision 递增为准，不依赖请求拦截器）
  stage.value = 'manual-save-after-locate-failures';
  const p = await enterEdit();
  if (await p.data('needsReload')) {
    p.loadProfile();
    for (let i = 0; i < 120; i++) { if (await p.data('loaded') && !(await p.data('busy'))) break; await sleep(250); }
  }
  const revisionBeforeSave = (await p.data('profile')).revision;
  const pickers = await p.$$('picker');
  const crops = await p.data('crops');
  const cities = await p.data('cities');
  await pickers[0].trigger('change', { value: crops.findIndex(c => c.id === 'crop_rice') });
  await pickers[1].trigger('change', { value: cities.findIndex(c => c.code === '330100') });
  await p.waitFor(async () => (await p.data('counties')).some(c => c.code === '330102'));
  await (await p.$$('picker'))[2].trigger('change', { value: (await p.data('counties')).findIndex(c => c.code === '330102') });
  await sleep(200);
  for (const b of await p.$$('button')) {
    if ((await b.text()).includes('确认并保存')) {
      const pos = await b.offset();
      await mini.pageScrollTo(Math.max(0, pos.top - 150));
      await sleep(200);
      await b.tap();
      break;
    }
  }
  for (let i = 0; i < 150; i++) { if (!(await p.data('busy')) && !(await p.data('editing'))) break; await sleep(200); }
  const saved = await p.data('profile');
  report.manualSaveAfterFailures = { revisionBeforeSave, revisionAfterSave: saved && saved.revision, crop_id: saved && saved.crop_id, region_code: saved && saved.region_code };
  assert.ok(saved && saved.revision > revisionBeforeSave, '定位失败后手选保存未生效：' + JSON.stringify(report.manualSaveAfterFailures));
  assert.equal(saved.crop_id, 'crop_rice');
  assert.equal(saved.region_code, '330102');

  // 10. 真实平台坐标（放最后：模拟器可能弹工具原生授权弹窗）：返回数字坐标，页面同样只回退手选
  stage.value = 'real-platform-coordinates';
  await mini.mockWxMethod('showModal', { confirm: true, cancel: false, errMsg: 'showModal:ok' });
  await mini.evaluate(() => { if (wx.__gyGetLocation) wx.getLocation = wx.__gyGetLocation; if (getCurrentPages().length) getCurrentPages().slice(-1)[0].regionConverter = null; });
  const raw = await Promise.race([
    mini.evaluate(() => new Promise(resolve => {
      wx.getLocation({ type: 'wgs84', success: p => resolve({ ok: true, latitudeType: typeof p.latitude, longitudeType: typeof p.longitude }), fail: e => resolve({ ok: false, errMsg: e.errMsg }) });
    })).then(r => ({ status: 'returned', result: r }), e => ({ status: 'error', name: e && e.name, message: e && e.message })),
    sleep(20000).then(() => ({ status: 'no-response-within-20s' })),
  ]);
  report.realGetLocation = raw;
  if (raw.status === 'returned' && raw.result.ok) {
    await branch('允许·真实平台坐标无转换资源', '地区转换资源尚未接入', null, null);
  }
  await mini.restoreWxMethod('showModal');
  await mini.evaluate(() => { if (wx.__gyGetLocation) wx.getLocation = wx.__gyGetLocation; if (getCurrentPages().length) getCurrentPages().slice(-1)[0].regionConverter = null; });

  fs.writeFileSync(path.join(out, 'location-observations.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PASS ' + report.branches.length + ' 个定位分支（真实页面/真实 loopback HTTP；平台失败响应为受控注入）；手选保存 revision ' + revisionBeforeSave + '->' + saved.revision + '；真实 wx.getLocation=' + raw.status);
})().catch(e => { console.error(stage.value + ': ' + e.name + ' | ' + e.message); process.exitCode = 1; })
  .finally(async () => { clearTimeout(timer); if (mini) { try { await mini.restoreWxMethod('showModal'); } catch (e) {} try { mini.disconnect(); } catch (e) {} } });

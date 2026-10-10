// Official SDK + actual native project; loopback backend identity is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const [sdkPath, outPath, widthArg = '320', portArg = '9422'] = process.argv.slice(2);
if (!sdkPath || !outPath) throw Error('Usage: node tests/integration/local-dev-ui.cjs <official SDK directory> <output directory> [expected width=320] [automation port=9422]');
const width = Number(widthArg), port = Number(portArg);
assert.ok(Number.isInteger(width) && width >= 320 && width <= 1024);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const sdk = require(path.resolve(sdkPath)), out = path.resolve(outPath);
fs.mkdirSync(out, { recursive: true });
let mini, stage = 'connect';
const deadline = setTimeout(() => { console.error('UI timeout at ' + stage); mini?.disconnect(); process.exit(2); }, 180000);
async function route(expected) {
  for (let i = 0; i < 60; i++) {
    const p = await mini.currentPage();
    if (p && p.path === expected) return p;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('UnexpectedRoute');
}
async function fontObservation() {
  return mini.evaluate(() => {
    const base = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : {};
    const sys = wx.getSystemInfoSync();
    let manager = {}; try { if (typeof wx.getFontSizeManager === 'function') manager = wx.getFontSizeManager(); } catch {}
    const page = getCurrentPages().slice(-1)[0];
    const bar = typeof page.getTabBar === 'function' ? page.getTabBar() : null;
    return { managerSupported: typeof wx.getFontSizeManager === 'function', basePx: base.fontSizeSetting,
      baseFactor: base.fontSizeScaleFactor, managerFactor: manager.fontSizeScaleFactor,
      systemPx: sys.fontSizeSetting, systemFactor: sys.fontSizeScaleFactor,
      appScale: getApp().globalData.fontScale, pageScale: page.data.fontScale,
      tabScale: bar && bar.data.fontScale, selected: bar && bar.data.selected, route: page.route };
  });
}
(async () => {
  mini = await sdk.connect({ wsEndpoint: 'ws://127.0.0.1:' + port });
  const sys = await mini.systemInfo();
  assert.equal(sys.windowWidth, width, 'Actual simulator viewport must match; no spoofed widths');
  const report = { kind: 'actual native WeChat simulator; no auth override or injected font scale; loopback server uses synthetic identity',
    width: sys.windowWidth, height: sys.windowHeight, SDKVersion: sys.SDKVersion, pages: [], details: [] };
  stage = 'guest-home'; await mini.callWxMethod('removeStorageSync', 'gengyun.session'); await mini.reLaunch('/pages/home/home');
  const home = await route('pages/home/home'); await home.waitFor(async () => await home.data('guest'));
  await mini.screenshot({ path: path.join(out, 'guest-home.png') });
  stage = 'real-guest-redirect'; try { await mini.switchTab('/pages/community/community'); } catch {}
  const login = await route('pages/login/login');
  await login.waitFor(async () => !(await login.data('busy')));
  await mini.screenshot({ path: path.join(out, 'guest-login.png') });
  stage = 'actual-wx-login'; let button;
  for (const b of await login.$$('button')) if ((await b.text()).includes('微信登录')) button = b;
  assert.ok(button); await button.tap(); const community = await route('pages/community/community');
  await community.waitFor(async () => !(await community.data('guest')));
  report.guestRedirectAndReturn = true;
  for (const name of ['home','community','identify','messages','profile']) {
    stage = 'tab-' + name; await mini.switchTab('/pages/' + name + '/' + name);
    const p = await route('pages/' + name + '/' + name); await p.waitFor(async () => !(await p.data('guest')));
    await mini.pageScrollTo(0); await p.waitFor(150);
    await mini.screenshot({ path: path.join(out, name + '-top.png') });
    const buttons = [];
    for (const b of await p.$$('button')) buttons.push({ text: await b.text(), size: await b.size(), offset: await b.offset(), fontSize: await b.style('font-size') });
    const font = await fontObservation(); assert.equal(font.pageScale, font.appScale); assert.equal(font.tabScale, font.appScale);
    assert.equal(font.selected, p.path);
    await mini.pageScrollTo(10000); await p.waitFor(150);
    await mini.screenshot({ path: path.join(out, name + '-bottom.png') });
    report.pages.push({ name, font, buttons, scrollTop: await p.scrollTop() });
  }
  for (const [name, id] of [['referencedetail','gy-i03-hb-001'],['referenceseeddetail','gy-i07-seed-hb-001']]) {
    stage = name; await mini.reLaunch('/pages/' + name + '/' + name + '?id=' + id);
    const p = await route('pages/' + name + '/' + name);
    await p.waitFor(async () => await p.data('gatePassed') && await p.data('found'));
    await mini.screenshot({ path: path.join(out, name + '.png') });
    report.details.push({ name, id, gatePassed: true, found: true, font: await fontObservation() });
  }
  stage = 'write-observations'; fs.writeFileSync(path.join(out,'observations.json'),JSON.stringify(report,null,2)+'\n');
  await mini.reLaunch('/pages/home/home'); console.log('PASS native UI at actual '+width+'px: guest redirect/login return, five authenticated Tabs, actual font read chain, two verified details.');
  mini.disconnect(); clearTimeout(deadline);
})().catch(e => { console.error('UI failed at '+stage+'; type='+e.name+'; no identity/token/code printed.'); mini?.disconnect(); clearTimeout(deadline); process.exitCode=1; });

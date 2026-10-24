import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { once } from 'node:events';
import { readLocalConfig, privateIPv4, clientBasePath } from '../tools/local-debug-config.mjs';
import { startLocalServer } from '../tools/local-debug-server.mjs';

const root = resolve(import.meta.dirname, '..');
const fixture = mkdtempSync(join(tmpdir(), 'gengyun-local-test-'));
// 每次调用写一份独立配置：共用同一文件时后一次 config() 会覆盖前一次的 apiBaseUrl（曾造成假通过）
let configSeq = 0;
function config(overrides = {}) {
  const path = join(fixture, `config-${++configSeq}.json`);
  writeFileSync(path, JSON.stringify({ mode: 'local', bindHost: '127.0.0.1', port: 4318, apiBaseUrl: 'http://127.0.0.1:4318', ...overrides }));
  return path;
}
test('missing, public, wildcard, credential, unsafe path and mismatched configs fail', () => {
  assert.throws(() => readLocalConfig());
  assert.throws(() => readLocalConfig(join(fixture, 'absent')));
  for (const overrides of [ { mode: 'production' }, { bindHost: '0.0.0.0' }, { apiBaseUrl: 'https://example.com' }, { apiBaseUrl: 'http://127.0.0.1:9999' }, { apiBaseUrl: 'http://user:pass@127.0.0.1:4318' }, { apiBaseUrl: 'http://127.0.0.1:4318?secret=1' }, { apiBaseUrl: 'http://127.0.0.1:4318#fragment' }, { apiBaseUrl: 'http://127.0.0.1:4318/api//v1' }, { apiBaseUrl: 'http://127.0.0.1:4318/api%2Fv1' }, { bindHost: '192.168.1.10' }, { secret: 'synthetic' } ]) assert.throws(() => readLocalConfig(config(overrides)));
  assert.equal(privateIPv4('172.32.1.1'), false);
  assert.equal(privateIPv4('192.168.1.2'), true);
  assert.equal(readLocalConfig(config()).mode, 'local');
});
// —— 工具链修正：`apiBaseUrl` 是**客户端拼接基址**，既要支持 origin（诊断替身），
// 也要支持 origin + 业务前缀（真实本地 API 的 /api/v1），且不得因此放宽任何安全拒绝 ——
test('apiBaseUrl accepts origin or origin plus a client-append base path without widening rejections', () => {
  assert.equal(readLocalConfig(config()).apiBaseUrl, 'http://127.0.0.1:4318');
  assert.equal(readLocalConfig(config({ apiBaseUrl: 'http://127.0.0.1:4318/api/v1' })).apiBaseUrl, 'http://127.0.0.1:4318/api/v1');
  assert.equal(readLocalConfig(config({ apiBaseUrl: 'http://127.0.0.1:4318/api/v1/' })).apiBaseUrl, 'http://127.0.0.1:4318/api/v1', '尾斜杠规范化为同一形态');
  assert.equal(readLocalConfig(config({ apiBaseUrl: 'http://127.0.0.1:4318/' })).apiBaseUrl, 'http://127.0.0.1:4318');
  assert.equal(readLocalConfig(config({ bindHost: '192.168.1.10', apiBaseUrl: 'http://192.168.1.10:4318/api/v1' })).apiBaseUrl, 'http://192.168.1.10:4318/api/v1', '同网私网地址同样支持路径形态');
  // URL 解析器会先消解 `.`／`..` 段（不残留路径穿越），这里显式记录该规范化结果
  assert.equal(readLocalConfig(config({ apiBaseUrl: 'http://127.0.0.1:4318/api/./v1' })).apiBaseUrl, 'http://127.0.0.1:4318/api/v1');
  assert.equal(readLocalConfig(config({ apiBaseUrl: 'http://127.0.0.1:4318/api/../v1' })).apiBaseUrl, 'http://127.0.0.1:4318/v1');
  assert.equal(clientBasePath('/'), '');
  assert.equal(clientBasePath(''), '');
  assert.equal(clientBasePath('/api/v1'), '/api/v1');
  assert.equal(clientBasePath('/api/v1///'), '/api/v1');
  for (const bad of [null, 42, {}, 'api/v1', '//api/v1', '/api//v1', '/api/./v1', '/api/../v1', '/api/v1/../..', '/api%2Fv1', '/api v1', '/api/v1;x']) assert.equal(clientBasePath(bad), null, `不该接受该路径：${String(bad)}`);
});
test('actual HTTP service is synthetic, no-store and has no business routes', async () => {
  const server = startLocalServer({ bindHost: '127.0.0.1', port: 0 });
  try {
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await fetch(base + '/__local__/status');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { service: 'gengyun-local-diagnostic', execution_mode: 'local_stub', synthetic: true, capabilities: [] });
    for (const path of ['/api/v1/auth/login', '/__local__/status?token=x', '/media']) assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base + '/__local__/status', { method: 'POST' })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
  // 带路径基址（/api/v1）时 debug.js 请求的是 `${apiBaseUrl}/__local__/status`：两种前缀都必须可达，
  // 否则工具打印出来的诊断地址自己取不到；同时不得因此多开任何业务路径。
  const scoped = startLocalServer({ bindHost: '127.0.0.1', port: 0, apiBaseUrl: 'http://127.0.0.1:1/api/v1' });
  try {
    await once(scoped, 'listening');
    const base = 'http://127.0.0.1:' + scoped.address().port;
    for (const path of ['/__local__/status', '/api/v1/__local__/status']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), { service: 'gengyun-local-diagnostic', execution_mode: 'local_stub', synthetic: true, capabilities: [] });
    }
    for (const path of ['/api/v1/media', '/api//__local__/status', '/api/v1/__local__/status?token=x', '/v1/__local__/status']) assert.equal((await fetch(base + path)).status, 404, path);
  } finally { await new Promise(resolve => scoped.close(resolve)); }
});
test('client blocks trial/release/unknown environments and labels stub or failure', () => {
  const script = readFileSync(join(root, 'miniprogram/utils/debug.js'), 'utf8');
  function load(runtime) {
    // 兜底说明：`miniprogram/utils/debug.js` 只 require `../config/runtime` 一条；这里把它**按完整说明符**
    // 登记为传入的替身（**非真实模块**，用于注入 local／disabled 两态，本用例的注入机制本身）。
    // 改前是 `require: () => runtime` 的 blanket：debug.js 将来新增任何 require 都会被静默喂成 runtime。
    // 现在未登记 ⇒ 显式失败并带依赖名（已登记项的取值与改前逐字相同）。
    const debugDependencies = new Map([['../config/runtime', runtime]]);
    const box = { module: { exports: {} }, require: (id) => { if (!debugDependencies.has(id)) throw Error('Unexpected page dependency ' + id); return debugDependencies.get(id); } };
    vm.runInNewContext(script, box); return box.module.exports;
  }
  const local = load({ mode: 'local', apiBaseUrl: 'http://127.0.0.1:4318' });
  let requests = 0;
  const api = env => ({ getAccountInfoSync: () => ({ miniProgram: { envVersion: env } }), request: () => requests++ });
  for (const env of ['trial', 'release', undefined]) local.diagnose(api(env), () => {});
  load({ mode: 'disabled' }).diagnose(api('develop'), () => {});
  assert.equal(requests, 0);
  let message;
  const run = handler => local.diagnose({ ...api('develop'), request: handler }, text => { message = text; });
  run(options => options.success({ statusCode: 200, data: { execution_mode: 'real', synthetic: true } }));
  assert.match(message, /不符合/);
  run(options => options.fail({ errMsg: 'sensitive mock diagnostic' }));
  assert.match(message, /连接失败/); assert.doesNotMatch(message, /sensitive/);
  run(options => options.success({ statusCode: 200, data: { service: 'gengyun-local-diagnostic', execution_mode: 'local_stub', synthetic: true } }));
  assert.match(message, /未接入/);
});
test('isolated packaging excludes private files and rejects release overrides/stale output', () => {
  const project = join(fixture, 'project'); mkdirSync(project);
  cpSync(join(root, 'tools'), join(project, 'tools'), { recursive: true });
  cpSync(join(root, 'miniprogram'), join(project, 'miniprogram'), { recursive: true });
  cpSync(join(root, 'project.config.json'), join(project, 'project.config.json'));
  writeFileSync(join(project, 'project.private.config.json'), '{"setting":{"urlCheck":false}}');
  writeFileSync(join(project, 'miniprogram/private.local.json'), '{"secret":"synthetic"}');
  const run = args => spawnSync(process.execPath, [join(project, 'tools/prepare-wechat.mjs'), ...args], { encoding: 'utf8' });
  // 本地替身工程按**客户端拼接基址**生成：这里直接用真实本地 API 的业务前缀形态（/api/v1）
  const apiConfig = config({ apiBaseUrl: 'http://127.0.0.1:4318/api/v1' });
  assert.notEqual(run(['local']).status, 0);
  assert.notEqual(run(['release', '--config', config()]).status, 0);
  assert.equal(run(['local', '--config', apiConfig]).status, 0);
  const local = join(project, '.local/wechat-local');
  assert.equal(existsSync(join(local, 'project.private.config.json')), false);
  assert.equal(existsSync(join(local, 'miniprogram/private.local.json')), false);
  const generatedRuntime = readFileSync(join(local, 'miniprogram/config/runtime.js'), 'utf8');
  assert.deepEqual(JSON.parse(generatedRuntime.split('= ')[1]), { mode: 'local', apiBaseUrl: 'http://127.0.0.1:4318/api/v1' }, '生成物必须逐字保留带业务前缀的客户端拼接基址');
  assert.notEqual(run(['local', '--config', config()]).status, 0);
  assert.equal(run(['release']).status, 0);
  const release = join(project, '.local/wechat-release');
  assert.equal(JSON.parse(readFileSync(join(release, 'project.config.json'), 'utf8')).setting.urlCheck, true);
  assert.doesNotMatch(readFileSync(join(release, 'miniprogram/config/runtime.js'), 'utf8'), /http:|local_stub|"mode":"local"/);
  // —— F2 回归：打包允许清单须随 app.json（21 页 = 13 页 + GY-I15 社区投稿/详情 + GY-I16 收藏/历史/历史详情
  // + GY-I13 播报页 + GY-I12 文字提问页 + GY-R34 授权清单页）
  // 同步，且参考域/社区域依赖须一并复制 ——
  const appJson = JSON.parse(readFileSync(join(release, 'miniprogram/app.json'), 'utf8'));
  assert.equal(appJson.pages.length, 21);
  assert.ok(appJson.pages.includes('pages/qa/qa'), 'release package must include the text question page');
  assert.ok(appJson.pages.includes('pages/consent/consent'), 'release package must include the consent page');
  for (const page of appJson.pages) {
    for (const suffix of ['.js', '.json', '.wxml']) {
      assert.equal(existsSync(join(release, 'miniprogram', page + suffix)), true, `打包缺失页面文件 ${page}${suffix}`);
    }
    const sourceWxss = join(root, 'miniprogram', page + '.wxss');
    if (existsSync(sourceWxss)) {
      assert.equal(existsSync(join(release, 'miniprogram', page + '.wxss')), true, `打包缺失页面样式 ${page}.wxss`);
    }
  }
  for (const dep of [
    'custom-tab-bar/index.js',
    'custom-tab-bar/index.json',
    'custom-tab-bar/index.wxml',
    'custom-tab-bar/index.wxss',
    // 设计令牌／图标／组件样式层（GY-I26）：app.wxss 依赖它们，漏打包会整站丢样式
    'styles/tokens.wxss',
    'styles/icons.wxss',
    'styles/components.wxss',
    'utils/reference.js',
    'utils/profile-api.js',
    'utils/location-region.js',
    // 地区转换资源装配（GY-I05 D2）：profile 页 require 它，漏打包会让标准包 MODULE_NOT_FOUND
    'utils/region-converter.js',
    'utils/knowledge-api.js',
    // 社区域适配层（GY-I15）：社区三页依赖它
    'utils/community-api.js',
    // 收藏与识别历史适配层（GY-I16）：收藏/历史/历史详情三页依赖它们
    'utils/favorites-api.js',
    'utils/history-api.js',
    // 文字问答域适配层（GY-I12）：qa 页依赖它，漏打包会让标准包 MODULE_NOT_FOUND
    'utils/qa-api.js',
    // 授权清单读取层（GY-R34 / #29 P1，只读）：consent 页依赖它，漏打包会让标准包 MODULE_NOT_FOUND
    'utils/consent-api.js',
    'utils/font-scale.js',
    'utils/system-font.js',
    'components/state-view/state-view.js',
    'components/state-view/state-view.json',
    'components/state-view/state-view.wxml',
    'components/state-view/state-view.wxss',
    ...['gy-ui-button', 'gy-ui-card', 'gy-ui-chip', 'gy-ui-search'].flatMap(name =>
      ['.js', '.json', '.wxml', '.wxss'].map(ext => `components/${name}/${name}${ext}`)),
    // GY-I13 播报域 + GY-I11 语音问答录音域：统一语音球组件与六个适配层
    // （漏打包 ⇒ 播报/录音页 MODULE_NOT_FOUND / 组件解析失败）
    ...['gy-voice-ball'].flatMap(name =>
      ['.js', '.json', '.wxml', '.wxss'].map(ext => `components/${name}/${name}${ext}`)),
    'utils/speech-text.js',
    'utils/audio-playback.js',
    'utils/inner-audio-port.js',
    'utils/substitute-player.js',
    'utils/voice-api.js',
    'utils/recorder-port.js',
    'data/crops.js',
    'data/species.js',
    'data/regions.js',
    'data/sources.js',
    'data/records-2026.js',
    'data/seed-herbicides.js',
    'data/seed-weeds.js',
    'data/seed-weed-master.js',
    'data/seed-province-index.js',
    'data/seed-control-timing.js',
  ]) {
    assert.equal(existsSync(join(release, 'miniprogram', dep)), true, `打包缺失参考域依赖 ${dep}`);
  }
  // Evaluate the real standard products, not a parallel local-dev copy or a mocked loader.
  const loader = `const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    const dir=process.argv[1],mode=process.argv[2];global.Page=()=>{};global.App=()=>{};global.Component=()=>{};
    const auth=require(path.join(dir,'miniprogram/utils/auth.js'));
    assert.equal(auth.networkEnabled(),mode==='local');
    assert.equal(typeof require(path.join(dir,'miniprogram/utils/page-gate.js')).start,'function');
    require(path.join(dir,'miniprogram/app.js'));
    require(path.join(dir,'miniprogram/custom-tab-bar/index.js'));
    for(const page of JSON.parse(fs.readFileSync(path.join(dir,'miniprogram/app.json'))).pages)require(path.join(dir,'miniprogram',page+'.js'));`;
  for (const [product, mode] of [[local, 'local'], [release, 'disabled']]) {
    for (const name of ['gy-ui-button', 'gy-ui-card', 'gy-ui-chip', 'gy-ui-search']) {
      for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
        const dep = `components/${name}/${name}${ext}`;
        assert.equal(readFileSync(join(product, 'miniprogram', dep), 'utf8'),
          readFileSync(join(root, 'miniprogram', dep), 'utf8'), `${mode} component copy differs: ${dep}`);
      }
    }
    const loaded = spawnSync(process.execPath, ['-e', loader, product, mode], { encoding: 'utf8' });
    assert.equal(loaded.status, 0, `Standard ${mode} product must load auth/App/all pages: ${loaded.stderr}`);
  }
  // Negative control: a missing navigation dependency must remain a hard error.
  const broken = join(fixture, 'broken-product'); mkdirSync(join(broken, 'utils'), { recursive: true }); mkdirSync(join(broken, 'config'));
  cpSync(join(local, 'miniprogram/utils/auth.js'), join(broken, 'utils/auth.js'));
  cpSync(join(local, 'miniprogram/config/runtime.js'), join(broken, 'config/runtime.js'));
  const missing = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', join(broken, 'utils/auth.js')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /MODULE_NOT_FOUND/); assert.match(missing.stderr, /navigation/);
  writeFileSync(join(project, 'miniprogram/config/runtime.js'), "module.exports = {mode:'local',apiBaseUrl:'http://127.0.0.1:4318'}");
  const unsafe = run(['release']);
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /Shared runtime changed/);
});
// —— 协作者真实登录（没有「小程序项目成员」资格 → 用自己的测试号 AppID）——
// 可选 `--appid` 只改**被忽略的生成副本**里的 appid：仓库里两份共享 project.config.json
// 必须逐字节不变（覆盖值绝不能回流），非法值必须在 mkdir 之前被拒、不留半成品目录。
test('local --appid overrides only the generated copy and rejects illegal ids without leftovers', () => {
  // 合成值：形状合法（wx + 16 位小写 hex），不对应任何真实小程序（真实 AppSecret 从不入库）
  const TEST_APP_ID = 'wx0123456789abcdef';
  const OFFICIAL_APP_ID = 'wx4407a4b908a69a54';
  function product(name) {
    const dir = join(fixture, name); mkdirSync(dir);
    cpSync(join(root, 'tools'), join(dir, 'tools'), { recursive: true });
    cpSync(join(root, 'miniprogram'), join(dir, 'miniprogram'), { recursive: true });
    cpSync(join(root, 'project.config.json'), join(dir, 'project.config.json'));
    return { dir, run: args => spawnSync(process.execPath, [join(dir, 'tools/prepare-wechat.mjs'), ...args], { encoding: 'utf8' }) };
  }
  const repoRoot = readFileSync(join(root, 'project.config.json'));
  const repoSub = readFileSync(join(root, 'miniprogram/project.config.json'));

  // ① 覆盖成功：生成物 appid = 传入值，其余字段与运行时输出不变；共享工程字节不变
  const ok = product('project-appid');
  const sharedPaths = ['project.config.json', 'miniprogram/project.config.json', 'miniprogram/config/runtime.js'];
  const sharedBefore = sharedPaths.map(path => readFileSync(join(ok.dir, path)));
  const apiBaseUrl = 'http://127.0.0.1:4318/api/v1';
  const override = ok.run(['local', '--config', config({ apiBaseUrl }), '--appid', TEST_APP_ID]);
  assert.equal(override.status, 0, override.stderr);
  const generated = JSON.parse(readFileSync(join(ok.dir, '.local/wechat-local/project.config.json'), 'utf8'));
  assert.equal(generated.appid, TEST_APP_ID, '生成副本必须改用传入的 AppID');
  assert.equal(generated.miniprogramRoot, 'miniprogram/');
  assert.equal(generated.setting.urlCheck, true, '覆盖 appid 不得顺带放松域名校验');
  assert.deepEqual(JSON.parse(readFileSync(join(ok.dir, '.local/wechat-local/miniprogram/config/runtime.js'), 'utf8').split('= ')[1]), { mode: 'local', apiBaseUrl });
  sharedPaths.forEach((path, index) => {
    assert.equal(readFileSync(join(ok.dir, path)).equals(sharedBefore[index]), true, `共享文件被改写：${path}`);
  });
  // stdout 必须点名 AppID 来源、服务端同号要求与测试号入口（协作者据此判断下一步）
  assert.match(override.stdout, new RegExp(TEST_APP_ID), 'stdout 必须打印实际生效的 AppID');
  assert.match(override.stdout, /--appid 覆盖值/);
  assert.match(override.stdout, new RegExp(OFFICIAL_APP_ID), '覆盖时仍须显示共享工程的官方 AppID');
  assert.match(override.stdout, /WECHAT_APP_ID/);
  assert.match(override.stdout, /WECHAT_APP_SECRET/);
  assert.match(override.stdout, /同一个号/);
  assert.match(override.stdout, /https:\/\/mp\.weixin\.qq\.com\/wxamp\/sandbox\?doc=1/);
  assert.match(override.stdout, /不互通/);

  // ② 非法格式／缺值／等号写法：退出非零、报错点名 --appid，且不生成任何目录
  const rejected = product('project-appid-rejected');
  const illegalValues = ['wx123', 'WX0123456789ABCDEF', 'wx0123456789abcdeg', 'wx0123456789abcde'];
  for (const bad of illegalValues) {
    const failed = rejected.run(['local', '--config', config(), '--appid', bad]);
    assert.notEqual(failed.status, 0, `非法 AppID 必须失败：${bad}`);
    assert.match(failed.stderr, /--appid/);
    assert.equal(existsSync(join(rejected.dir, '.local')), false, `非法 AppID 不得留下生成目录：${bad}`);
  }
  for (const args of [
    ['local', '--config', config(), '--appid'],
    ['local', '--config', config(), '--appid=' + TEST_APP_ID],
  ]) {
    const failed = rejected.run(args);
    assert.notEqual(failed.status, 0, `参数残缺必须失败：${args.join(' ')}`);
    assert.match(failed.stderr, /--appid/);
    assert.equal(existsSync(join(rejected.dir, '.local')), false);
  }

  // ③ release 副本固定官方 AppID：传 --appid 直接报错，同样不建目录
  const releaseRejected = rejected.run(['release', '--appid', TEST_APP_ID]);
  assert.notEqual(releaseRejected.status, 0);
  assert.match(releaseRejected.stderr, /release 不接受 --appid/);
  assert.equal(existsSync(join(rejected.dir, '.local')), false);

  // ④ 不传 --appid：行为与改动前逐字一致（仍是共享工程官方 AppID）
  const plain = rejected.run(['local', '--config', config()]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(readFileSync(join(rejected.dir, '.local/wechat-local/project.config.json'), 'utf8')).appid, OFFICIAL_APP_ID);
  assert.match(plain.stdout, /共享工程 project\.config\.json 默认值/);

  // 仓库内两份共享配置在整轮用例后仍逐字节等于开始时的快照
  assert.equal(readFileSync(join(root, 'project.config.json')).equals(repoRoot), true);
  assert.equal(readFileSync(join(root, 'miniprogram/project.config.json')).equals(repoSub), true);
});

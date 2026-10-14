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
    const box = { module: { exports: {} }, require: () => runtime };
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
  // —— F2 回归：打包允许清单须随 app.json（19 页 = 13 页 + GY-I15 社区投稿/详情 + GY-I16 收藏/历史/历史详情
  // + GY-I13 播报页）
  // 同步，且参考域/社区域依赖须一并复制 ——
  const appJson = JSON.parse(readFileSync(join(release, 'miniprogram/app.json'), 'utf8'));
  assert.equal(appJson.pages.length, 19);
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
    'utils/knowledge-api.js',
    // 社区域适配层（GY-I15）：社区三页依赖它
    'utils/community-api.js',
    // 收藏与识别历史适配层（GY-I16）：收藏/历史/历史详情三页依赖它们
    'utils/favorites-api.js',
    'utils/history-api.js',
    'utils/font-scale.js',
    'utils/system-font.js',
    'components/state-view/state-view.js',
    'components/state-view/state-view.json',
    'components/state-view/state-view.wxml',
    'components/state-view/state-view.wxss',
    ...['gy-ui-button', 'gy-ui-card', 'gy-ui-chip', 'gy-ui-search'].flatMap(name =>
      ['.js', '.json', '.wxml', '.wxss'].map(ext => `components/${name}/${name}${ext}`)),
    // GY-I13 播报域：统一语音球组件与五个适配层（漏打包 ⇒ 播报页 MODULE_NOT_FOUND / 组件解析失败）
    ...['gy-voice-ball'].flatMap(name =>
      ['.js', '.json', '.wxml', '.wxss'].map(ext => `components/${name}/${name}${ext}`)),
    'utils/speech-text.js',
    'utils/audio-playback.js',
    'utils/inner-audio-port.js',
    'utils/substitute-player.js',
    'utils/voice-api.js',
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

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalConfig, configArgument } from './local-debug-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID_PATTERN = /^wx[0-9a-f]{16}$/;
// 测试号申请入口（微信公众平台 → 开发 → 开发管理 → 开发设置 → 开发者工具 → 测试号）。
// 2026-10-19 实测该 URL 可打开，但正文由微信公众平台前端渲染，需在浏览器登录后查看。
const TEST_ACCOUNT_URL = 'https://mp.weixin.qq.com/wxamp/sandbox?doc=1';

/**
 * 从 local 的参数里摘出可选的 `--appid <wx…>`，其余参数原样交给 --config 校验。
 * 只改**被忽略的生成副本**里的 appid：协作者账号不是共享工程的小程序项目成员时，
 * 共享工程的官方 AppID 在微信开发者工具里会直接拦住登录调试；换成自己扫码的测试号 AppID
 * 即可零成员资格走通 wx.login → code2session。共享工程本身绝不改写。
 * 所有校验都在 mkdir 之前完成，非法值不会留下任何半成品目录。
 */
function takeAppId(args) {
  const rest = [];
  let appId = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--appid') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--appid 缺少取值：应写成 `--appid wx…`（wx + 16 位小写十六进制）；未生成任何目录。');
      if (!APP_ID_PATTERN.test(value)) throw new Error('--appid 格式非法：' + JSON.stringify(value) + ' 不匹配 ^wx[0-9a-f]{16}$；未生成任何目录，共享工程与 release 副本不受影响。');
      if (appId !== null) throw new Error('--appid 只能出现一次；未生成任何目录。');
      appId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--appid=')) throw new Error('--appid 只支持空格分隔写法 `--appid wx…`，不支持等号形式；未生成任何目录。');
    rest.push(arg);
  }
  return { appId, rest };
}

try {
  const [mode, ...argv] = process.argv.slice(2);
  if (!['local', 'release'].includes(mode)) throw new Error('Usage: node tools/prepare-wechat.mjs local --config <file> [--appid <wx…>] | release');
  // release 副本固定沿用共享工程的官方 AppID：覆盖只服务于本地调试，越界即拒。
  if (mode === 'release' && argv.some(arg => arg.startsWith('--appid'))) throw new Error('release 不接受 --appid：release 副本固定使用共享工程官方 AppID。协作者本地调试请用 `local --config <file> --appid wx…`。');
  const { appId: appIdOverride, rest: args } = mode === 'local' ? takeAppId(argv) : { appId: null, rest: argv };
  const runtime = mode === 'local' ? readLocalConfig(configArgument(args)) : { mode: 'disabled', apiBaseUrl: '' };
  if (mode === 'release' && args.length) throw new Error('Release does not accept a local configuration.');
  const config = JSON.parse(readFileSync(join(root, 'project.config.json'), 'utf8'));
  if (config.compileType !== 'miniprogram' || config.miniprogramRoot !== 'miniprogram/' || config.setting.urlCheck !== true) throw new Error('Shared project must use native miniprogram and domain validation.');
  const sharedAppId = config.appid;
  const sharedRuntime = readFileSync(join(root, 'miniprogram/config/runtime.js'), 'utf8').replace(/\r\n/g, '\n');
  if (sharedRuntime !== "// Shared source always has networking disabled. Local preparation writes only an ignored copy.\nmodule.exports = { mode: 'disabled', apiBaseUrl: '' }\n") throw new Error('Shared runtime changed. Refuse to package a possible local/stub configuration.');
  const out = join(root, '.local', 'wechat-' + mode);
  // Refuse reuse so personal overrides or stale generated files cannot survive preparation.
  if (existsSync(out)) throw new Error('Output already exists: ' + out + '. Keep it for inspection or remove that exact generated directory before preparing again.');
  mkdirSync(out, { recursive: true });
  const app = JSON.parse(readFileSync(join(root, 'miniprogram/app.json'), 'utf8'));
  const files = [
    'app.js',
    'app.json',
    'app.wxss',
    'sitemap.json',
    'custom-tab-bar/index.js',
    'custom-tab-bar/index.json',
    'custom-tab-bar/index.wxml',
    'custom-tab-bar/index.wxss',
    // 设计令牌／图标／组件样式层（GY-I26）：app.wxss 通过 @import 引用，
    // 漏加会让隔离工程编译后整站样式丢失。
    'styles/tokens.wxss',
    'styles/icons.wxss',
    'styles/components.wxss',
    'config/runtime.js',
    'utils/debug.js',
    'utils/auth.js',
    'utils/profile-api.js',
    // 定位即时选地区（GY-I05／F02）：仅授权与失败分支，不内置坐标→地区转换资源。
    'utils/location-region.js',
    // 地区转换资源装配（GY-I05 D2）：profile 页 require 它；漏加会导致标准包 MODULE_NOT_FOUND。
    // 资源就位（U3 取得）后，转换数据副本也必须一并加入本清单：
    // 'data/region-centroids.js',
    'utils/region-converter.js',
    'utils/knowledge-api.js',
    // 识别域适配层（GY-I09）：识别页依赖它；漏加会导致标准包 MODULE_NOT_FOUND。
    'utils/identify-api.js',
    // 收藏与识别历史适配层（GY-I16）：新页面依赖它们；漏加同样会导致 MODULE_NOT_FOUND。
    'utils/favorites-api.js',
    'utils/history-api.js',
    // 社区域适配层（GY-I15）：社区列表/投稿/详情页依赖它；漏加会导致标准包 MODULE_NOT_FOUND。
    'utils/community-api.js',
    // 消息域适配层（GY-I17）：消息页与底部 Tab 未读角标依赖它；漏加会导致标准包 MODULE_NOT_FOUND。
    'utils/messages-api.js',
    // 播报域适配层（GY-I13）：播报页依赖它们；漏加会导致标准包 MODULE_NOT_FOUND。
    //   audio-playback：播放生命周期控制器（端口注入，纯逻辑）
    //   inner-audio-port：wx.createInnerAudioContext 的唯一出现处
    //   substitute-player：明确标注的替身播放端口（仅本地替身工程走查，不计「已听取」）
    //   speech-text：安全检查闸门与播报计划复核（数字/单位/制剂条件/否定词）
    //   voice-api：POST /speech/synthesis 与 GET /jobs/{id} 的消费层
    //   recorder-port：wx.getRecorderManager 的唯一出现处（GY-I11 语音问答真实录音）
    //   speech-transcript：GY-I11 转写四端点 + 确认/发送消费层（可编辑、确认后发送、取消/失败/迟到不外发）
    'utils/speech-text.js',
    'utils/audio-playback.js',
    'utils/inner-audio-port.js',
    'utils/substitute-player.js',
    'utils/voice-api.js',
    'utils/recorder-port.js',
    'utils/speech-transcript.js',
    'assets/knowledge/leaf.png',
    'assets/knowledge/search.png',
    'assets/knowledge/back.png',
    'utils/font-scale.js',
    'utils/system-font.js',
    'components/state-view/state-view.js',
    'components/state-view/state-view.json',
    'components/state-view/state-view.wxml',
    'components/state-view/state-view.wxss',
    ...['gy-ui-button', 'gy-ui-card', 'gy-ui-chip', 'gy-ui-search'].flatMap(name =>
      ['.js', '.json', '.wxml', '.wxss'].map(ext => `components/${name}/${name}${ext}`)),
    // GY-I13 统一语音球（播报页依赖；漏加会导致自定义组件解析失败）。
    ...['gy-voice-ball'].flatMap(name =>
      ['.js', '.json', '.wxml', '.wxss'].map(ext => `components/${name}/${name}${ext}`)),
    'utils/navigation.js',
    'utils/page-gate.js',
    // 参考查询域适配层与数据（GY-I07）：随页面一同打包。
    'utils/reference.js',
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
  ];
  const pages = [
    'pages/home/home',
    'pages/identify/identify',
    'pages/knowledge/knowledge',
    'pages/knowledgedetail/knowledgedetail',
    'pages/reference/reference',
    'pages/referencedetail/referencedetail',
    'pages/referenceseed/referenceseed',
    'pages/referenceseeddetail/referenceseeddetail',
    'pages/community/community',
    // GY-I15 社区投稿与详情页（必须与 miniprogram/app.json 的 pages 逐项同序）。
    'pages/communitycreate/communitycreate',
    'pages/communitydetail/communitydetail',
    'pages/messages/messages',
    'pages/profile/profile',
    'pages/login/login',
    // 样式走查页（GY-I26 demo 对齐）：只在本地替身工程可见（runtime.mode === 'local'）
    'pages/specimen/specimen',
    // 收藏与识别历史（GY-I16）：页面清单须与 app.json 的 pages 逐项一致（下方断言）。
    'pages/favorites/favorites',
    'pages/history/history',
    'pages/historydetail/historydetail',
    // 播报页（GY-I13）：页面清单须与 app.json 的 pages 逐项一致（下方断言）。
    'pages/voice/voice',
  ];
  if (JSON.stringify(app.pages) !== JSON.stringify(pages)) throw new Error('Unexpected page routes; review packaging allowlist.');
  for (const page of pages) {
    for (const suffix of ['.js', '.json', '.wxml']) files.push(page + suffix);
    // 页面样式按需打包（仅参考域页面提供 .wxss，其余页面无样式文件）。
    const pageWxss = join(root, 'miniprogram', page + '.wxss');
    if (existsSync(pageWxss)) files.push(page + '.wxss');
  }
  for (const file of files) {
    const target = join(out, 'miniprogram', file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, 'miniprogram', file), target);
  }
  // 只有**生成副本**的 appid 允许覆盖；共享工程两份 project.config.json 全程只读
  // （tests/local-debug.test.mjs 按字节比对原文，覆盖值不可能回流到仓库）。
  if (appIdOverride !== null) config.appid = appIdOverride;
  writeFileSync(join(out, 'project.config.json'), JSON.stringify(config, null, 2) + '\n');
  // 生成物里的 apiBaseUrl 就是**客户端拼接基址**（客户端以 `runtime.apiBaseUrl + '/auth/…'` 等自行拼接）：
  // 指向真实本地 API 时须含业务前缀（如 http://127.0.0.1:3100/api/v1），诊断替身用 origin 形态即可。
  writeFileSync(join(out, 'miniprogram/config/runtime.js'), 'module.exports = ' + JSON.stringify({ mode: runtime.mode, apiBaseUrl: runtime.apiBaseUrl }) + '\n');
  console.log(mode.toUpperCase() + ' import root: ' + out);
  console.log(mode === 'local'
    ? 'Local client base (runtime.apiBaseUrl): ' + runtime.apiBaseUrl + ' ; diagnostic stub only; enable the personal domain exception only in this isolated project if needed.'
    : 'Networking disabled, urlCheck=true. This is not a working competition release.');
  // 以下三行是协作者真实登录的判据：AppID 用哪个号、服务端必须配同一个号、测试号入口在哪。
  const appIdInCopy = appIdOverride === null ? sharedAppId : appIdOverride;
  console.log('生成副本 AppID：' + appIdInCopy + (appIdOverride === null
    ? '（来源：共享工程 project.config.json 默认值）'
    : '（来源：--appid 覆盖值；共享工程仍为 ' + sharedAppId + '，未被改写）'));
  console.log('服务端必须同号：WECHAT_APP_ID 必须等于上面这个 AppID，WECHAT_APP_SECRET 必须是同一个号后台生成的密钥；两者不配对时 code2session 必然返回 appid/secret 不匹配类错误，登录一定失败。');
  console.log('测试号申请入口（没有「小程序项目成员」资格也能扫码登录）：' + TEST_ACCOUNT_URL + ' ；该页需在浏览器登录微信公众平台后由前端渲染。');
  if (appIdOverride !== null) console.log('注意：测试号 openid 与正式号不同，服务端身份摘要把 appId 与 openid 一起做 HMAC，故测试号账号/数据与正式环境不互通，不能作为正式验收证据。');
} catch (error) { console.error(error.message); process.exitCode = 1; }

#!/usr/bin/env node
// GY-I25 configuration and optional unauthenticated host HEAD only.
// Derived from PR #32 / 3513c104; no vendor capability or database access verification.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const PROVIDERS = [
  ['weedRecognition', '识草'], ['ocr', '标签 OCR'], ['asr', '普通话 ASR'],
  ['tts', '普通话 TTS'], ['llm', '大模型'], ['moderation', '文字/图片 AI 筛查']
];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'docs/verification/config.local.json');
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;

export function validatedHTTPS(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || /\s/.test(endpoint)) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch (_) { return null; }
}

export async function probeHTTPS(endpoint, fetchImpl = globalThis.fetch) {
  // Direct callers cannot bypass the URL/HTTPS guard.
  const url = validatedHTTPS(endpoint);
  if (!url) return { state: 'SKIPPED_INVALID_CONFIG', capabilityVerified: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url.origin, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) return { state: 'REDIRECT_REFUSED', httpStatus: response.status, capabilityVerified: false };
    return { state: 'HOST_RESPONDED', httpStatus: response.status, capabilityVerified: false };
  } catch (error) {
    return { state: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', capabilityVerified: false };
  } finally { clearTimeout(timer); }
}

export async function verifyEnvironment({ config, env = process.env, nodeVersion = process.versions.node, probe = false, fetchImpl = globalThis.fetch } = {}) {
  const results = [];
  const providers = {};
  const add = (level, area, item, detail) => results.push({ level, area, item, detail });
  const secretPresent = (name, item) => {
    if (typeof name !== 'string' || !ENV_NAME.test(name)) { add('FAIL', '服务端配置', item, '缺少合法环境变量名称'); return false; }
    if (typeof env[name] !== 'string' || !env[name].trim()) { add('FAIL', '服务端配置', item, '所声明环境变量未设置'); return false; }
    add('PASS', '服务端配置', item, '环境变量存在；未验证凭据有效性'); return true;
  };
  add(Number(nodeVersion.split('.')[0]) === 24 ? 'PASS' : 'FAIL', '环境', 'Node major', Number(nodeVersion.split('.')[0]) === 24 ? 'Node24；不代表框架兼容' : '需要Node24基线');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    add('FAIL', '配置', '配置文件', '不存在、无法读取或不是JSON对象；先复制安全example到忽略的config.local.json');
  } else {
    add('PASS', '配置', '配置文件', 'JSON对象；不会输出原文或解析异常中的片段');
    add(config.env === 'dev' ? 'PASS' : 'FAIL', '配置', '验证环境', config.env === 'dev' ? 'dev；非部署命令' : '仅接受dev接入验证配置');
    add(typeof config.appid === 'string' && /^wx[0-9a-f]{16}$/.test(config.appid) ? 'PASS' : 'FAIL', '配置', 'AppID格式', '只检查公开标识格式，不验证账号或成员资格');
    secretPresent(config.appSecretEnv, 'AppSecret');
    const api = validatedHTTPS(config.domain?.apiBase);
    add(api ? 'PASS' : 'FAIL', '配置', '正式API URL', api ? 'HTTPS格式；域名登记、TLS及真机尚未验证' : '缺少安全HTTPS URL；不以local HTTP代替');
    if (config.database?.url) add('FAIL', '配置', '数据库连接', '禁止在JSON直接填写连接秘密；迁移至服务端urlEnv环境变量');
    else secretPresent(config.database?.urlEnv, '数据库连接');
    const privacyValid = config.privacy?.allowUserDataForTraining === false && config.privacy?.sendRealUserDataBeforeConsent === false;
    add(privacyValid ? 'PASS' : 'FAIL', '配置', '隐私守卫声明', privacyValid ? '声明禁止未授权真实外发及用户训练；不证明运行守卫或供应商条款' : '两项必须显式false');
    const canProbe = privacyValid && config.env === 'dev';
    for (const [key, label] of PROVIDERS) {
      const p = config.providers?.[key];
      const endpoint = validatedHTTPS(p?.endpoint);
      const vendor = typeof p?.vendor === 'string' && Boolean(p.vendor.trim());
      add(endpoint && vendor ? 'PASS' : 'FAIL', '供应商配置', label, endpoint && vendor ? '供应商与HTTPS端点已填写；未认证/未调用' : '缺供应商或安全HTTPS端点；不会请求无效URL');
      const credential = secretPresent(p?.apiKeyEnv, label);
      const identity = p?.secretIdEnv ? secretPresent(p.secretIdEnv, label + ' SecretId') : true;
      const imageEndpoint = key === 'moderation' ? validatedHTTPS(p?.image?.endpoint) : null;
      const imageConfigured = key !== 'moderation' || Boolean(imageEndpoint);
      if (key === 'moderation') add(imageConfigured ? 'PASS' : 'FAIL', '供应商配置', '图片审核', imageConfigured ? '图片审核HTTPS端点已填写；未认证/未调用' : '缺少独立图片审核HTTPS端点；文字接口不能代替图片审核');
      const complete = Boolean(endpoint && vendor && credential && identity && imageConfigured);
      const network = !endpoint || !vendor || !canProbe
        ? { state: 'SKIPPED_INVALID_CONFIG', capabilityVerified: false }
        : probe ? await probeHTTPS(p.endpoint, fetchImpl) : { state: 'NOT_REQUESTED', capabilityVerified: false };
      providers[key] = { configurationComplete: complete, reachability: network, capabilityVerified: false };
      if (key === 'moderation') providers[key].imageReachability = !imageEndpoint || !vendor || !canProbe
        ? { state: 'SKIPPED_INVALID_CONFIG', capabilityVerified: false }
        : probe ? await probeHTTPS(p.image.endpoint, fetchImpl) : { state: 'NOT_REQUESTED', capabilityVerified: false };
      if (key === 'moderation' && ['NETWORK_ERROR', 'TIMEOUT', 'REDIRECT_REFUSED'].includes(providers[key].imageReachability.state)) add('FAIL', '主机探测', '图片审核', providers[key].imageReachability.state);
      add(['NETWORK_ERROR', 'TIMEOUT', 'REDIRECT_REFUSED'].includes(network.state) ? 'FAIL' : 'INFO', '主机探测', label,
        network.httpStatus ? network.state + ': HTTP ' + network.httpStatus + '；HEAD响应不验证API能力' : network.state + '；真实能力未验证');
    }
  }
  const counts = results.reduce((acc, row) => { acc[row.level] = (acc[row.level] || 0) + 1; return acc; }, {});
  return { scope: 'configuration_and_optional_host_reachability_only', probeRequested: probe, taskVerified: false, capabilityVerified: false, counts, results, providers };
}

async function main() {
  const args = process.argv.slice(2);
  let env = process.env;
  const credentialOption = args.indexOf('--credentials');
  if (credentialOption !== -1) {
    const file = args[credentialOption + 1];
    if (!file || file.startsWith('--')) { console.error('Missing credential file path.'); process.exitCode = 1; return; }
    args.splice(credentialOption, 2);
    try {
      const privateConfig = JSON.parse(readFileSync(file, 'utf8'));
      if (privateConfig.appid !== 'wx4407a4b908a69a54') throw new Error('mismatch');
      env = { ...process.env };
      for (const [field, variable] of [['appsecret', 'WECHAT_APP_SECRET'], ['deepseekApiKey', 'DEEPSEEK_API_KEY'], ['tencentSecretId', 'TENCENTCLOUD_SECRET_ID'], ['tencentSecretKey', 'TENCENTCLOUD_SECRET_KEY'], ['databaseUrl', 'GENGYUN_DATABASE_URL']]) {
        if (typeof privateConfig[field] === 'string' && privateConfig[field]) env[variable] = privateConfig[field];
      }
    } catch (_) { console.error('Private credential file unavailable or mismatched; no content logged.'); process.exitCode = 1; return; }
  }
  if (args.some(arg => !['--json', '--probe'].includes(arg))) { console.error('Usage: node tools/verify-env.mjs [--json] [--probe] [--credentials <private file>]'); process.exitCode = 1; return; }
  let config;
  try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { /* Never echo parsing errors: they may contain secrets. */ }
  const report = await verifyEnvironment({ config, env, probe: args.includes('--probe') });
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('GY-I25 配置检查；默认零网络，--probe仅无鉴权HTTPS主机HEAD。');
    for (const row of report.results) console.log(row.level + ' ' + row.area + '/' + row.item + ': ' + row.detail);
    console.log('taskVerified=false / capabilityVerified=false。缺真实成功+受控失败、真机及数据库证据不能验收整项。');
  }
  process.exitCode = report.counts.FAIL ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Verification failed without exposing configuration.'); process.exitCode = 1; });

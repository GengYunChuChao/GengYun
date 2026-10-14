import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export function privateIPv4(host) {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 客户端拼接基址允许的路径段：保守字符集；空段与 `.`／`..` 一律拒绝。 */
const BASE_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * 校验并规范化 `apiBaseUrl` 的路径部分。客户端一律以该值为基址自行拼接
 * （`miniprogram/utils/auth.js` 的 `runtime.apiBaseUrl + '/auth/…'`、`profile-api.js` 等同理），
 * 所以 `apiBaseUrl` 就是**客户端拼接基址**：
 *   - origin 形态（`http://127.0.0.1:4318`）⇒ 返回 `''`（诊断替身用这一形态即可）；
 *   - origin + 路径（`http://127.0.0.1:3100/api/v1`，真实本地 API 的业务前缀）⇒ 保留路径并去掉尾斜杠。
 * 含空段／`.`／`..`／`//`／百分号编码的路径返回 `null`，由调用方 fail-closed 拒绝。
 */
export function clientBasePath(pathname) {
  if (typeof pathname !== 'string') return null;
  if (pathname === '' || pathname === '/') return '';
  if (!pathname.startsWith('/') || pathname.includes('%')) return null;
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed === '') return null;               // `//`、`///` 这类只有斜杠的写法不是干净的 origin
  if (trimmed.includes('//')) return null;       // 空段
  for (const segment of trimmed.split('/').slice(1)) {
    if (segment === '' || segment === '.' || segment === '..' || !BASE_PATH_SEGMENT.test(segment)) return null;
  }
  return trimmed;
}

export function readLocalConfig(path) {
  if (!path) throw new Error('Missing --config. Copy config/debug.local.json.example to ignored config/debug.local.json.');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const keys = ['mode', 'bindHost', 'port', 'apiBaseUrl'];
  if (Object.keys(config).length !== keys.length || keys.some(k => !(k in config))) throw new Error('Only mode, bindHost, port, apiBaseUrl are supported.');
  if (config.mode !== 'local' || !privateIPv4(config.bindHost) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Local mode requires an explicit loopback/private IPv4 bind and port 1024..65535.');
  const url = new URL(config.apiBaseUrl);
  if (url.protocol !== 'http:' || !privateIPv4(url.hostname) || url.hostname !== config.bindHost || Number(url.port || 80) !== config.port || url.username || url.password || url.search || url.hash) throw new Error('apiBaseUrl must match the local IPv4 bind/port, without credentials, query or fragment.');
  const basePath = clientBasePath(url.pathname);
  if (basePath === null) throw new Error('apiBaseUrl path must be plain path segments only (no empty/./.. segment, no percent-encoding).');
  // 保留路径：客户端在此基址后自行拼接；真实本地 API 的业务前缀为 /api/v1。
  config.apiBaseUrl = url.origin + basePath;
  return config;
}

export function configArgument(args) {
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: --config <ignored local JSON file>');
  return args[1];
}

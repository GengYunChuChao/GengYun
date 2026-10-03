import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export function privateIPv4(host) {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function readLocalConfig(path) {
  if (!path) throw new Error('Missing --config. Copy config/debug.local.json.example to ignored config/debug.local.json.');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const keys = ['mode', 'bindHost', 'port', 'apiBaseUrl'];
  if (Object.keys(config).length !== keys.length || keys.some(k => !(k in config))) throw new Error('Only mode, bindHost, port, apiBaseUrl are supported.');
  if (config.mode !== 'local' || !privateIPv4(config.bindHost) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Local mode requires an explicit loopback/private IPv4 bind and port 1024..65535.');
  const url = new URL(config.apiBaseUrl);
  if (url.protocol !== 'http:' || !privateIPv4(url.hostname) || url.hostname !== config.bindHost || Number(url.port || 80) !== config.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('apiBaseUrl must match the local IPv4 bind/port, without credentials, path, query or fragment.');
  config.apiBaseUrl = url.origin;
  return config;
}

export function configArgument(args) {
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: --config <ignored local JSON file>');
  return args[1];
}

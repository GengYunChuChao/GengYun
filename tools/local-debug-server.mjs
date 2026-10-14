import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readLocalConfig, configArgument, clientBasePath } from './local-debug-config.mjs';

/**
 * 诊断端点路径集合：历史 origin 形态在根路径；`apiBaseUrl` 带路径（如 `/api/v1`）时，
 * `miniprogram/utils/debug.js` 请求的是 `${apiBaseUrl}/__local__/status`，所以两种前缀都服务，
 * 保证本工具打印出来的 URL 一定取得到。
 */
function localStatusPaths(config) {
  let basePath = '';
  try { basePath = clientBasePath(new URL(String(config.apiBaseUrl ?? '')).pathname) ?? ''; } catch { basePath = ''; }
  return new Set(['/__local__/status', basePath + '/__local__/status']);
}

export function startLocalServer(config) {
  const statusPaths = localStatusPaths(config);
  const server = createServer((req, res) => {
    const success = req.method === 'GET' && statusPaths.has(req.url);
    res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Execution-Mode': 'local_stub' });
    res.end(JSON.stringify(success
      ? { service: 'gengyun-local-diagnostic', execution_mode: 'local_stub', synthetic: true, capabilities: [] }
      : { execution_mode: 'local_stub', error: 'LOCAL_ROUTE_NOT_FOUND' }));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(config.port, config.bindHost);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readLocalConfig(configArgument(process.argv.slice(2)));
    const server = startLocalServer(config);
    server.on('listening', () => console.log('LOCAL STUB ONLY: ' + config.apiBaseUrl + '/__local__/status (Ctrl+C to stop)'));
    server.on('error', () => { console.error('Local server failed to bind. Check address availability and port.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

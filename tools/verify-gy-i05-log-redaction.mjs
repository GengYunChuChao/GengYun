/**
 * GY-I05（#5）坐标红线探针 —— 「服务端不接收原始坐标（不落库、不进日志、不回封套）」的**负例对照**工具。
 *
 * 与 `tests/unit/profile-log-redaction.test.mjs` 的分工：
 *   - 单测断言**改后**必须全 0（正向对照 + 负例，含 logStream 注入）；
 *   - 本探针只依赖 `buildApp`（改前/改后都存在），所以在「改前」的 `app.ts` 上也能跑，
 *     用来证明探针**确实抓得到泄漏**（否则"全 0"可能是假通过）。
 *
 * 出口清单（用合成哨兵坐标 latitude=123.4567 / longitude=89.0123 依次触达）：
 *   1. `incoming request` 与 `request completed` 请求日志；
 *   2. 请求子日志中继（`request.log.*({req})`）；
 *   3. 错误日志出口（`request.log.error({err})`）与未处理错误出口；
 *   4. 响应封套：404 的 message、400 的 message/details/field、500 的 message；
 *   5. 请求体（写档案时夹带坐标/哨兵文本）是否被任何出口回显。
 *
 * 用法：
 *   node tools/verify-gy-i05-log-redaction.mjs            # 探针自己 tee stdout 抓日志
 *   node tools/verify-gy-i05-log-redaction.mjs > before.log  # 也可用 shell 重定向双保险
 * 判定输出走 **stderr**（stdout 要留给应用日志）；退出码 0 = 全 0 命中，1 = 有命中。
 */
import { buildApp } from '../services/api/src/app.ts';
import { loadConfig } from '../services/api/src/config.ts';

// 合成哨兵：明显越界、不是任何真实位置，仅用于证明原文不进入日志/封套。
const LAT = '123.4567';
const LNG = '89.0123';
const SENTINELS = [LAT, LNG, 'latitude=', 'longitude=', 'lat=', 'lng=', '?limit='];

// stderr 是判定通道；pino 默认写 stdout，这里 tee 一份，另外用 shell 重定向兜底。
const say = text => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);

const chunks = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  chunks.push(String(chunk));
  return realWrite(chunk, ...rest);
};

const hits = text => SENTINELS.filter(sentinel => text.includes(sentinel));

async function main() {
  const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'info' }) });
  // 探针钩子（只在本进程里挂，生产 app.ts 无此钩子）：触达请求子日志中继/错误日志，可按标记触发未处理错误。
  // 注意：钩子里抛出的错误**不能**自带哨兵文本，否则命中来自探针自己而不是请求原文，判据失效。
  app.addHook('preValidation', async request => {
    request.log.info({ req: request }, 'probe child logger relay');
    request.log.error({ err: new Error('probe synthetic failure') }, 'probe error logger relay');
    if (request.headers['x-probe-unhandled'] === '1') throw new Error('probe unhandled error');
  });

  const cases = [
    ['catalog-regions-query', { url: `/api/v1/catalog/regions?latitude=${LAT}&longitude=${LNG}` }],
    ['profile-query', { url: `/api/v1/me/profile?lat=${LAT}&lng=${LNG}` }],
    ['unknown-path-404', { url: `/api/v1/unknown/endpoint?latitude=${LAT}&longitude=${LNG}` }],
    ['catalog-schema-invalid', { url: `/api/v1/catalog/crops?limit=abc&latitude=${LAT}` }],
    ['unhandled-error', { url: `/api/v1/catalog/crops?latitude=${LAT}&longitude=${LNG}`, headers: { 'x-probe-unhandled': '1' } }],
    ['profile-body-coordinates', {
      method: 'PUT', url: '/api/v1/me/profile',
      headers: { 'idempotency-key': 'probe-key-0001', 'if-match': '"1"' },
      payload: { crop_id: 'crop_rice', region_code: '330102', region_catalog_version: 'v1', latitude: Number(LAT), longitude: Number(LNG) },
    }],
    ['profile-body-extra-field', {
      method: 'PUT', url: '/api/v1/me/profile',
      headers: { 'idempotency-key': 'probe-key-0002', 'if-match': '"1"' },
      payload: { crop_id: 'crop_rice', region_code: '330102', region_catalog_version: 'v1', note: `${LAT},${LNG}` },
    }],
  ];
  const responses = new Map();
  for (const [label, options] of cases) responses.set(label, await app.inject(options));
  await app.close();
  // 等一拍，确保同步 fd 之外的日志也落进本次 tee。
  await new Promise(resolve => setTimeout(resolve, 50));

  const log = chunks.join('');
  const lines = log.split('\n').filter(Boolean);
  const byMsg = new Map();
  for (const line of lines) {
    let msg = '<unparsed>';
    try { msg = JSON.parse(line).msg ?? '<no-msg>'; } catch { /* 保留 <unparsed> */ }
    if (!byMsg.has(msg)) byMsg.set(msg, []);
    byMsg.get(msg).push(line);
  }

  say('=== GY-I05 坐标红线探针 ===');
  say(`哨兵：latitude=${LAT} longitude=${LNG}（合成值，非真实位置）`);
  say(`探针 tee 到的 stdout 日志块：${chunks.length}（为 0 时请用 shell 重定向抓 stdout）`);
  say('');
  say('--- 日志出口（按 msg 分组：命中行数 / 该 msg 总行数）---');
  const logHits = [];
  for (const [msg, msgLines] of [...byMsg.entries()].sort()) {
    const offending = msgLines.filter(line => hits(line).length > 0);
    say(`  msg=${JSON.stringify(msg)}  ${offending.length}/${msgLines.length}`);
    for (const line of offending) {
      logHits.push(line);
      say(`    !! 命中：${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
    }
  }
  say(`  日志整体命中：${hits(log).length} 类哨兵 / 命中行 ${logHits.length}`);
  say('');

  // 正向对照：日志出口确实在工作、路径确实落下来了——避免"没有日志所以没有坐标"的假通过。
  const incomingLines = lines.filter(line => line.includes('"msg":"incoming request"'));
  const childRelayLines = lines.filter(line => line.includes('"msg":"probe child logger relay"'));
  const errorRelayLines = lines.filter(line => line.includes('"msg":"probe error logger relay"'));
  const unhandledLines = lines.filter(line => line.includes('"msg":"unhandled error"'));
  const pipeline = incomingLines.length > 0 && childRelayLines.length > 0 && errorRelayLines.length > 0
    && unhandledLines.length > 0;
  const pathStripped = log.includes('"/api/v1/catalog/regions"') && log.includes('"/api/v1/unknown/endpoint"');
  say('--- 正向对照（日志确实在工作；改后还要求路径以"无查询串"形态落下）---');
  say(`  incoming request 行：${incomingLines.length}；子日志中继：${childRelayLines.length}；错误日志中继：${errorRelayLines.length}；unhandled error：${unhandledLines.length}`);
  say(`  日志管线在工作（判定可信）：${pipeline ? 'OK' : '不成立'}`);
  say(`  路径以无查询串形态落日志（仅改后应为 true）：${pathStripped}`);
  say('');

  say('--- 响应封套出口 ---');
  const envelopeHits = [];
  for (const [label, response] of responses) {
    const offending = hits(response.body);
    say(`  ${label.padEnd(26)} status=${response.statusCode} 命中=${offending.length === 0 ? 0 : offending.join(',')}`);
    if (offending.length > 0) envelopeHits.push([label, response.body]);
  }
  const notFound = responses.get('unknown-path-404').json();
  say(`  404 封套 message：${JSON.stringify(notFound.error.message)}`);
  say(`  400 封套样例：${responses.get('catalog-regions-query').body.slice(0, 300)}`);
  say('');

  say('--- 请求体出口（哨兵文本是否被回显）---');
  const bodyHits = envelopeHits.filter(([, body]) => hits(body).length > 0);
  say(`  被回显的请求体内容：${bodyHits.length} 处`);
  say('');

  const total = logHits.length + envelopeHits.length;
  const verdict = total === 0 && pipeline;
  say(`RESULT: ${verdict ? 'PASS' : 'FAIL'} —— 坐标/查询串原文命中 ${total} 处（日志 ${logHits.length} + 封套 ${envelopeHits.length}），日志管线 ${pipeline ? '在工作' : '不在工作'}`);
  process.exitCode = verdict ? 0 : 1;
}

await main();

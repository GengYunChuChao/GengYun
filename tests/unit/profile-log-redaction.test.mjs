// GY-I05（#5）：坐标必须不落任何持久面**或日志**。
//
// 改前实测的真实落点（原始输出见 docs/verification/gy-i05-region-profile-20261014.md §3）：
//   1. Fastify 默认 `serializers.req` 把含查询串的原始 URL 逐字写进 `incoming request`；
//   2. 任何 `request.log.*({ req })` 中继（请求子日志沿用同一序列化器）；
//   3. 404 封套 `error.message` 回显完整 `request.url`（含查询串）。
// 本用例把这三处与「错误日志 / 未处理错误 / 请求体 details」一起做负例，并要求正向对照
// （日志确实开着、路径确实落下来了），避免"因为没日志所以没坐标"的假通过。
//
// 只读契约与 app.ts 的导出：不新增路由、不改 packages/**、不放开任何既有断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp, logSafePath, requestLogFields } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';

const root = resolve(import.meta.dirname, '../..');
// 合成哨兵坐标：明显越界、不是任何真实位置，仅用于证明原文不进入日志/封套。
const LAT = '123.4567';
const LNG = '89.0123';
const SENTINELS = [LAT, LNG, 'latitude=', 'longitude=', 'lat=', 'lng=', '?limit='];

function assertNoSentinel(text, label) {
  for (const sentinel of SENTINELS) {
    assert.equal(text.includes(sentinel), false, `${label} 出现坐标/查询串原文：${sentinel}`);
  }
}

function memoryLog() {
  const chunks = [];
  return {
    chunks,
    stream: { write(chunk) { chunks.push(chunk); } },
    text() { return chunks.join(''); },
  };
}

test('GY-I05 日志序列化器：只留 method 与不含查询串的路径', () => {
  const fields = requestLogFields({
    method: 'GET',
    url: `/api/v1/catalog/regions?latitude=${LAT}&longitude=${LNG}`,
    host: 'localhost:80',
    ip: '127.0.0.1',
    socket: { remotePort: 51234 },
  });
  assert.deepEqual(fields, {
    method: 'GET', url: '/api/v1/catalog/regions', host: 'localhost:80', remoteAddress: '127.0.0.1', remotePort: 51234,
  });
  assertNoSentinel(JSON.stringify(fields), '序列化后的请求日志字段');
  assert.equal(JSON.stringify(fields).includes('?'), false, '日志字段里不得出现任何查询串');
  // 片段（#）同样剥离；正常路径逐字保留。
  assert.equal(requestLogFields({ method: 'GET', url: '/api/v1/me/profile?a=1#frag' }).url, '/api/v1/me/profile');
  assert.equal(requestLogFields({ method: 'PUT', url: '/api/v1/me/profile' }).url, '/api/v1/me/profile');
});

test('GY-I05 日志序列化器：解析不出的 URL 一律 fail-closed，只落 method', () => {
  const rejected = [
    undefined, null, '', '   ', 123, 0, true, {}, [], ['/api/v1/x'],
    `http://localhost/api/v1/x?latitude=${LAT}`,        // absolute-form（代理可转发）
    `//localhost/api/v1/x?latitude=${LAT}`,             // 协议相对
    `api/v1/x?latitude=${LAT}`,                         // 无前导 /
    '/api/v1/x/30.2741,120.1551',                       // 坐标形态落在路径里
    '/api/v1/30.2741/120.1551',
  ];
  for (const url of rejected) {
    const fields = requestLogFields({ method: 'GET', url });
    assert.equal(Object.hasOwn(fields, 'url'), false, `不该落 URL 原文：${String(url)}`);
    assert.equal(fields.method, 'GET', 'method 之外不落原文，但 method 本身要保留');
    assertNoSentinel(JSON.stringify(fields), `被拒 URL 的日志字段：${String(url)}`);
  }
  // 解析得出来时才落路径；只读、纯函数。
  assert.equal(logSafePath('/api/v1/me/profile'), '/api/v1/me/profile');
  assert.equal(logSafePath('/api/v1/me/profile?user_id=x'), '/api/v1/me/profile');
  assert.equal(logSafePath('/api/v1/me/profile#x'), '/api/v1/me/profile');
  assert.equal(logSafePath('/catalog/regions?latitude=1.2345'), '/catalog/regions');
});

test('GY-I05 端到端：坐标经任何一个日志出口或响应封套都不得落原文', async t => {
  const log = memoryLog();
  const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'info' }), logStream: log.stream });
  t.after(() => app.close());
  // 探针钩子（只在本用例里挂，生产 app.ts 无此钩子）：触达请求子日志中继与错误日志出口，
  // 并可按标记触发 app.ts 的「未处理错误」出口。
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

  const text = log.text();
  // 正向对照：日志出口**确实在工作**，且路径仍在日志里（不是"没有日志"造成的假通过）。
  for (const msg of ['"msg":"incoming request"', '"msg":"request completed"', '"msg":"probe child logger relay"',
    '"msg":"probe error logger relay"', '"msg":"unhandled error"']) {
    assert.equal(text.includes(msg), true, `日志出口缺失，正向对照失败：${msg}`);
  }
  assert.equal(text.includes('"/api/v1/catalog/regions"'), true, '路径本身仍应落日志');
  assert.equal(text.includes('"/api/v1/unknown/endpoint"'), true, '未匹配路径本身仍应落日志');
  assert.equal(text.includes('"remoteAddress":"127.0.0.1"'), true);
  // 负例：全部日志输出都不得出现坐标或查询串原文（改前此处有 10 处命中）。
  assertNoSentinel(text, '捕获到的全部日志输出');
  assert.equal(text.includes('?latitude'), false);
  assert.equal(text.includes('?lat='), false);

  // 404 封套（改前回显完整 URL）：剥查询串，但不影响状态码与错误码。
  const notFound = responses.get('unknown-path-404').json();
  assert.equal(notFound.error.code, 'NOT_FOUND');
  assert.equal(notFound.error.message, '未实现的路径：GET /api/v1/unknown/endpoint');
  assertNoSentinel(JSON.stringify(notFound), '404 响应封套');

  // 400 封套的 message/details/field 不回显坐标或查询串（查询串与请求体两条路径都测）。
  for (const [label, expected] of [['catalog-regions-query', 400], ['profile-query', 400], ['catalog-schema-invalid', 400],
    ['profile-body-coordinates', 400], ['profile-body-extra-field', 400], ['unhandled-error', 500]]) {
    assert.equal(responses.get(label).statusCode, expected, label);
    assertNoSentinel(responses.get(label).body, `${label} 响应封套`);
  }
  assert.equal(responses.get('catalog-regions-query').json().error.code, 'INVALID_REQUEST');
  assert.equal(responses.get('unhandled-error').json().error.message, '服务器内部错误');
});

test('GY-I05: logStream 仅测试注入——生产入口与配置层都不得引用', () => {
  const server = readFileSync(resolve(root, 'services/api/src/server.ts'), 'utf8');
  assert.equal(server.includes('logStream'), false, '生产入口不得注入 logStream（日志仍写 stdout）');
  // W2（GY-R28）收紧了这条钉子：媒体域真实端口的装配是本仓**唯一**允许出现在 `buildApp` 调用里的
  // 额外实参（`[媒体域接线]` 断点），因此这里从「必须逐字等于 `{ config, pool }`」改成
  // 「必须是 `{ config, pool }` + 恰好这一处 `mediaAssembly` spread」，并追加两条更强的不变量：
  // 该 spread 的取值只允许来自 `mediaRealPortsAssemblyOptions`（唯一来源）、且 `server.ts` 里
  // `buildApp(` 只能出现一次 —— `logStream` 仍然注入不进来（本测试的主旨不变）。
  //
  // ⚠ 2026-10-28（GY-R68 合成产物端口补装配）**有据变更，不是放宽**：合成域的产物端口
  //   `synthesisMediaWiring` 同样只认「生产入口显式注入」（`app.ts` 只转发不铸造），此前 `server.ts`
  //   从不传它 ⇒ `--approve-real-media-wiring` 对 TTS 完全无效、`real` 下恒 `unwired`。修法是在同一处
  //   判定后追加**第二个**同族 spread（`synthesisMediaAssembly`）。因此本钉子由「恰好一处 spread」
  //   改为「恰好这两处、且各自只有唯一来源」，并**新增**两条更强的不变量：
  //   ① `synthesisMediaWiringAssemblyOptions(` 全文件恰好 1 次（不得有第二个来源，也不得自带默认值）；
  //   ② `synthesisMediaAssembly` 的赋值恰好 1 次，且该赋值与 `mediaAssembly` 的赋值**同处一个
  //      `if (mediaRealPorts !== null)` 分支**（= 共用同一次批准判定，没有第二条开启路径）。
  //   `logStream` 仍注入不进来：两处 spread 的取值都只来自具名派生函数，调用点是唯一的。
  //
  // ⚠ 2026-10-30（GY-R70 · 审核域批准通道，`--approve-moderation-live-wiring`）**有据变更，不是放宽**：
  //   审核域的真实接线批准能力此前没有任何生产调用点（`server.ts` 不铸造 ⇒ `real` 下审核整域恒 503）。
  //   修法是在入口追加**第三个**同族 spread（`moderationAssembly`），因此本钉子由「恰好这两处」改为
  //   「恰好这三处、且各自只有唯一来源」，并**新增**两条更强的不变量：
  //   ① `moderationStartupAssemblyOptions(` 全文件恰好 1 次；② `moderationAssembly` 的赋值恰好 1 次，
  //      且**不得**落在 `if (mediaRealPorts !== null)` 判定块内——审核域与媒体域是**两条独立的门**，
  //      焊死会让 `--approve-real-media-wiring` 变成审核域的前置条件。
  //   `logStream` 仍注入不进来：三处 spread 的取值都只来自具名派生函数，调用点是唯一的。
  assert.match(
    server,
    /buildApp\(\{ config, pool, \.\.\.\(mediaAssembly \?\? \{\}\), \.\.\.\(synthesisMediaAssembly \?\? \{\}\), \.\.\.moderationAssembly \}\)/,
  );
  assert.equal(server.match(/mediaRealPortsAssemblyOptions\(/g)?.length, 1, '媒体装配选项只允许一个来源');
  assert.equal(
    server.match(/synthesisMediaWiringAssemblyOptions\(/g)?.length,
    1,
    '合成产物装配选项只允许一个来源（不得出现第二处派生/默认值）',
  );
  assert.equal(
    server.match(/moderationStartupAssemblyOptions\(/g)?.length,
    1,
    '审核域批准通道只允许一个来源（不得出现第二处派生/默认值）',
  );
  assert.equal(server.match(/buildApp\(/g)?.length, 1, '生产入口只允许调用一次 buildApp');
  assert.equal(
    server.match(/^\s*synthesisMediaAssembly = /gm)?.length,
    1,
    'synthesisMediaAssembly 只允许赋值一次（不得在别处补一条开启路径）',
  );
  assert.equal(
    server.match(/^\s*const moderationAssembly = /gm)?.length,
    1,
    'moderationAssembly 只允许赋值一次（不得在别处补一条开启路径）',
  );
  const synthBranch = server.match(/if \(mediaRealPorts !== null\) \{\n[\s\S]*?\n {4}\}/);
  assert.ok(synthBranch !== null, 'server.ts 必须有 mediaRealPorts !== null 的判定块');
  assert.match(synthBranch[0], /mediaAssembly = mediaRealPortsAssemblyOptions\(mediaRealPorts\);/);
  assert.match(
    synthBranch[0],
    /synthesisMediaAssembly = synthesisMediaWiringAssemblyOptions\(mediaRealPorts\);/,
    '合成产物派生必须与媒体域派生同处一次批准判定之内',
  );
  assert.equal(
    synthBranch[0].includes('moderationAssembly'),
    false,
    '审核域的批准通道不得落进媒体域的判定块（两条门必须解耦，否则媒体开关成了审核域的前置条件）',
  );
  const config = readFileSync(resolve(root, 'services/api/src/config.ts'), 'utf8');
  assert.equal(config.includes('logStream'), false, '配置层不得暴露日志捕获开关');
  // 默认（不传 logStream）时 logger 选项只有 level + serializers，不新增文件/级别/格式开关。
  const source = readFileSync(resolve(root, 'services/api/src/app.ts'), 'utf8');
  assert.match(source, /serializers: \{ req: requestLogFields \}/);
  assert.match(source, /\.\.\.\(logStream === undefined \? \{\} : \{ stream: logStream \}\)/);
});

/**
 * GY-I27 · 「用途授权的错误码前后端同集合」的钉子（纯静态：只读文件文本，不 import 产品代码）。
 *
 * ## 缺口（改前，实测）
 * #29 的验收要求「输出前后端一致的授权错误码」，但两端各持一张表、**没有任何机器检查**保证同集合：
 * 服务端在 `routes/consents.ts` / `privacy/grant-pg.ts` / `privacy/consent-pg.ts` 里 `throw` 码，
 * 客户端在 `miniprogram/utils/consent-api.js` 里用 `MESSAGES` / `GRANT_MESSAGES` / `WITHDRAW_MESSAGES`
 * 查文案、用两个 `*_BLOCKING_CODES` 决定置灰。今天实测（2026-11-02，基线 `28291489`）：
 *   - 服务端三份文件共抽出 **14** 个码；
 *   - 客户端五张表并集 **21** 个码；
 *   - 服务端码里只有 **`SESSION_EXPIRED`** 不在客户端表里 —— 它是真例外：`consent-api.js` 的 401/403
 *     分支统一交 `utils/auth.js` 的 `failureFor()`，而 `attribution()` 把**所有 401**（含 `SESSION_EXPIRED`）
 *     归一为 `SESSION_REQUIRED`（`miniprogram/utils/auth.js:98-105`），所以客户端表按归一后的码建；
 *   - 客户端表里另有 **8** 个码不在本闸门冻结的服务端扫描面里（`CONFIRM_STALE` / `INVALID_INPUT` /
 *     `INVALID_RESPONSE` / `NETWORK_UNCERTAIN` / `NOT_GRANTED` / `SESSION_CHANGED` / `UNEXPECTED_STATUS`
 *     是客户端前置码；`INVALID_CURSOR` **不是**纯客户端码 —— 服务端 `privacy/signed-list-cursor.ts:61`
 *     经 `consent-pagination.ts` 在 `GET /me/consents` 上真的会抛，只是不在冻结的三份扫描面内）。
 * 也就是说：今天两端**没有一条真的漏处理的授权码**，缺的是「以后也不会漏」的机器约束。
 *
 * ## 扫描面（冻结）
 * 服务端只读这三份（相对仓库根）：
 *   - `services/api/src/routes/consents.ts`（路由层：幂等键 / `If-Match` / 无实例兜底）
 *   - `services/api/src/privacy/grant-pg.ts`（授予落库）
 *   - `services/api/src/privacy/consent-pg.ts`（清单 / 撤回 / 事务身份守卫）
 * 客户端只读 `miniprogram/utils/consent-api.js` 的五张表。
 * 每份都用 `readFileSync` 直接读；⛔ 不 try/catch：路径写错、文件被挪走必须当场 ENOENT（下界守卫）。
 *
 * ## 服务端按哪几个正则抽、为什么不会漏
 *   - `api-error`：`new ApiError('CODE', …)` 的**直接字面量**码。`\s*` 允许换行，所以跨行调用也命中；
 *     消息串是中文，不会落进 `[A-Z][A-Z0-9_]{1,63}`。
 *   - `api-error-ternary`：`new ApiError(cond ? 'A' : 'B', …)` 的**两个分支**。今天只有
 *     `consent-pg.ts:97` 一处（`PROVIDER_TIMEOUT` / `PROVIDER_UNAVAILABLE`）；只写直接字面量正则会把
 *     `PROVIDER_TIMEOUT` 漏掉。
 *   - `error-envelope`：`{ code: 'CODE' }` 形状。今天 0 命中，留着是为了将来改成手写错误封套时也被抓到。
 *   - `pg-code-guard`：`code === 'CODE'` 的比较。它专门覆盖 `consent-pg.ts:95` 的
 *     `new ApiError(code, …)` **动态透传**：上一行把可透传的 PG 错误码闭集钉成三个字面量
 *     （`ACCOUNT_INACTIVE` / `CONSENT_REQUIRED` / `SCOPE_DENIED`）。纯数字 SQLSTATE（`'57014'` / `'55P03'`）
 *     不匹配 `[A-Z]`，它们的映射目标由上面的三元正则抽。
 *   - **结构下界**：每个文件的 `new ApiError(` 总数必须等于「直接 + 三元 + `new ApiError(code,`」三类
 *     调用点之和。新增一种没被覆盖的写法会在这里变红，不会「正则失配 ⇒ 零命中 ⇒ 全绿」。
 *
 * ## 判据（白名单式，不是「至少 N 次」）
 *   ① 扫描面逐字冻结，三份文件都必须存在且非空。
 *   ② 抽到的服务端码集合必须与 `EXPECTED_SERVER_CODES`（14 个，实测后写死）**逐条相等**。
 *   ③ 服务端码 ⊆ 客户端五张表并集 ∪ `SERVER_ONLY_EXCEPTIONS`；例外每条给 `{ code, reason, where }`，
 *      必须真的在服务端码里（过期条目要红）、必须不在客户端表里（补上就该删例外）。
 *   ④ 客户端表并集 ⊆ 服务端码 ∪ `CLIENT_ONLY_CODES`；白名单每条给理由，必须真的在客户端表里
 *      （过期条目要红）、必须不是服务端码（一旦服务端也抛就该删白名单，改走判据 ③）。
 *
 * ## 负控制（纯函数 + 夹具，不改仓库文件；实跑打红读数见证据页）
 *   ① 往服务端码里塞 `TOTALLY_FAKE_CODE` ⇒ 判据 ③ 点名它；
 *   ② 从 `WITHDRAW_MESSAGES` 的夹具副本里删掉 `REVISION_REQUIRED` ⇒ 判据 ③ 点名它；
 *   ③ 往 `CLIENT_ONLY_CODES` 塞服务端真有的 `NOT_FOUND` ⇒ 判据 ④ 点名它。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 服务端授权面（冻结的三份）。⛔ 加文件必须同时补 `EXPECTED_SERVER_CODES` 与证据页。 */
const SCANNED_FILES = Object.freeze([
  'services/api/src/routes/consents.ts',
  'services/api/src/privacy/grant-pg.ts',
  'services/api/src/privacy/consent-pg.ts',
]);

const CLIENT_FILE = 'miniprogram/utils/consent-api.js';

/**
 * 服务端错误码的抽取形状。四条合起来覆盖今天全部 41 个 `new ApiError(` 调用点；
 * 结构下界另见 `apiErrorShapeCounts()`。正则每次 `new RegExp(source, flags)` 重建，避免 `lastIndex` 残留。
 */
const SERVER_PATTERNS = Object.freeze([
  { kind: 'api-error', re: /\bnew\s+ApiError\(\s*'([A-Z][A-Z0-9_]{1,63})'/g },
  { kind: 'api-error-ternary', re: /\bnew\s+ApiError\([^()\n]*\?\s*'([A-Z][A-Z0-9_]{1,63})'\s*:\s*'([A-Z][A-Z0-9_]{1,63})'/g },
  { kind: 'error-envelope', re: /\bcode\s*:\s*'([A-Z][A-Z0-9_]{1,63})'/g },
  { kind: 'pg-code-guard', re: /\bcode\s*===\s*'([A-Z][A-Z0-9_]{1,63})'/g },
]);

/** 实测后写死：基线 `28291489` 上三份扫描面共 14 个码。多一个少一个都红。 */
const EXPECTED_SERVER_CODES = Object.freeze([
  'ACCOUNT_INACTIVE',
  'CONSENT_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_KEY_REQUIRED',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'OBJECT_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'REVISION_CONFLICT',
  'REVISION_REQUIRED',
  'SCOPE_DENIED',
  'SESSION_EXPIRED',
  'SESSION_REQUIRED',
]);

/** 客户端五张表（逐表冻结；表名、缩进、键名任一漂移都红）。 */
const EXPECTED_MESSAGE_TABLES = Object.freeze({
  MESSAGES: Object.freeze([
    'ACCOUNT_INACTIVE',
    'CONSENT_REQUIRED',
    'INVALID_CURSOR',
    'INVALID_RESPONSE',
    'NETWORK_UNCERTAIN',
    'PROVIDER_UNAVAILABLE',
    'SCOPE_DENIED',
    'SESSION_CHANGED',
    'SESSION_REQUIRED',
    'UNEXPECTED_STATUS',
  ]),
  GRANT_MESSAGES: Object.freeze([
    'ACCOUNT_INACTIVE',
    'CONSENT_REQUIRED',
    'IDEMPOTENCY_CONFLICT',
    'IDEMPOTENCY_KEY_REQUIRED',
    'INVALID_INPUT',
    'INVALID_REQUEST',
    'INVALID_RESPONSE',
    'NETWORK_UNCERTAIN',
    'OBJECT_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
    'REVISION_CONFLICT',
    'SCOPE_DENIED',
    'SESSION_CHANGED',
    'SESSION_REQUIRED',
  ]),
  WITHDRAW_MESSAGES: Object.freeze([
    'ACCOUNT_INACTIVE',
    'CONFIRM_STALE',
    'IDEMPOTENCY_CONFLICT',
    'IDEMPOTENCY_KEY_REQUIRED',
    'INVALID_INPUT',
    'INVALID_REQUEST',
    'INVALID_RESPONSE',
    'NETWORK_UNCERTAIN',
    'NOT_FOUND',
    'NOT_GRANTED',
    'OBJECT_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
    'REVISION_CONFLICT',
    'REVISION_REQUIRED',
    'SCOPE_DENIED',
    'SESSION_CHANGED',
    'SESSION_REQUIRED',
  ]),
});

const EXPECTED_CODE_ARRAYS = Object.freeze({
  GRANT_BLOCKING_CODES: Object.freeze([
    'CONSENT_REQUIRED',
    'OBJECT_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
  ]),
  WITHDRAW_BLOCKING_CODES: Object.freeze([
    'NOT_FOUND',
    'NOT_GRANTED',
    'OBJECT_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
  ]),
});

/**
 * 服务端有、客户端表里没有的码。⛔ 例外表不许当逃生门：每条必须写清 `where`（服务端哪一行抛）
 * 与「客户端为什么不建词条」，且一旦客户端补了词条，判据 ③ 会要求删掉这条。
 */
const SERVER_ONLY_EXCEPTIONS = Object.freeze([
  {
    code: 'SESSION_EXPIRED',
    reason:
      '401 在客户端被 utils/auth.js:attribution() 统一归一为 SESSION_REQUIRED（utils/auth.js:98-105），' +
      'consent-api.js 的 401/403 分支只把归一后的码交给 MESSAGES；所以三张表都不需要 SESSION_EXPIRED 词条。',
    where:
      'services/api/src/privacy/consent-pg.ts:84、:87（会话行缺失/已失效时抛 401 SESSION_EXPIRED）；' +
      'miniprogram/utils/auth.js:98-105（401 一律归一为 SESSION_REQUIRED）',
  },
]);

/**
 * 客户端表里有、本闸门冻结的服务端扫描面里没有的码。⛔ 每条必须写理由；
 * 其中 `INVALID_CURSOR` 是「服务端会抛、但抛出点在扫描面外」，不是纯客户端自造码（见 reason）。
 */
const CLIENT_ONLY_CODES = Object.freeze([
  {
    code: 'CONFIRM_STALE',
    reason: '客户端前置码：撤回的 guard 在每一步请求前判定失效，一条请求都不发（consent-api.js:509-517）。',
  },
  {
    code: 'INVALID_CURSOR',
    reason:
      '服务端真会抛（privacy/signed-list-cursor.ts:61，经 consent-pagination.ts 用于 GET /me/consents），' +
      '但抛出点不在本闸门冻结的三份扫描面内；按「扫描面外」登记，不是纯客户端前置码。',
  },
  {
    code: 'INVALID_INPUT',
    reason: '客户端前置码：用途/政策版本/接收方/幂等键的自检失败，未发出请求（consent-api.js:432、:447、:450、:503）。',
  },
  {
    code: 'INVALID_RESPONSE',
    reason: '客户端前置码：封套/实体闭集核对失败（consent-api.js:106、:138、:223、:340）。',
  },
  {
    code: 'NETWORK_UNCERTAIN',
    reason: '客户端前置码：wx.request 失败且会话未变，结果未知（consent-api.js:238）。',
  },
  {
    code: 'NOT_GRANTED',
    reason: '客户端前置码：清单里没有该用途的当前记录，因此不发注定 404 的 DELETE（consent-api.js:552）。',
  },
  {
    code: 'SESSION_CHANGED',
    reason: '客户端前置码：在途响应回来时会话令牌/世代已变（consent-api.js:198、:238）。',
  },
  {
    code: 'UNEXPECTED_STATUS',
    reason: '客户端前置码：封套合法但 HTTP 状态不是本次期望值（consent-api.js:214）。',
  },
]);

function read(relPath) {
  // ⚠ 不 try/catch：路径写错、文件被挪走必须当场抛（下界守卫）。
  return readFileSync(join(ROOT, relPath), 'utf8');
}

function countMatches(text, re) {
  return [...text.matchAll(new RegExp(re.source, re.flags))].length;
}

/** `new ApiError(` 的调用点分类；三类之和必须等于总数（新增未覆盖写法立刻红）。 */
function apiErrorShapeCounts(text) {
  return {
    total: countMatches(text, /\bnew\s+ApiError\(/g),
    direct: countMatches(text, /\bnew\s+ApiError\(\s*'[A-Z][A-Z0-9_]{1,63}'/g),
    ternary: countMatches(
      text,
      /\bnew\s+ApiError\([^()\n]*\?\s*'[A-Z][A-Z0-9_]{1,63}'\s*:\s*'[A-Z][A-Z0-9_]{1,63}'/g,
    ),
    dynamic: countMatches(text, /\bnew\s+ApiError\(code\s*,/g),
  };
}

/** 扫三份冻结文件，返回 `文件:码`（保留重复，便于结构读数；集合由 `uniqueServerCodes` 去重）。 */
function scanServerHits() {
  const hits = [];
  for (const relPath of SCANNED_FILES) {
    const text = read(relPath);
    for (const { re } of SERVER_PATTERNS) {
      for (const match of text.matchAll(new RegExp(re.source, re.flags))) {
        for (const code of match.slice(1)) {
          if (code) hits.push(`${relPath}:${code}`);
        }
      }
    }
  }
  return hits.sort();
}

function uniqueServerCodes(hits) {
  return [...new Set(hits.map((hit) => hit.slice(hit.lastIndexOf(':') + 1)))].sort();
}

/** 解析 `const NAME = { CODE: '…', … }` 的键；表名或两空格缩进变了会返回空并由调用方判红。 */
function parseMessageTable(source, name) {
  const block = new RegExp(`const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(block, `客户端表 ${name} 不见了：表名/结尾大括号形状变了，必须同步本闸门`);
  return [...block[1].matchAll(/^\s{2}([A-Z][A-Z0-9_]{1,63}):/gm)].map((match) => match[1]).sort();
}

/** 解析 `const NAME = ['CODE', …]` 的成员。 */
function parseCodeArray(source, name) {
  const block = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  assert.ok(block, `客户端数组 ${name} 不见了：数组名/方括号形状变了，必须同步本闸门`);
  return [...block[1].matchAll(/'([A-Z][A-Z0-9_]{1,63})'/g)].map((match) => match[1]).sort();
}

function readClientTables() {
  const source = read(CLIENT_FILE);
  const tables = {
    MESSAGES: parseMessageTable(source, 'MESSAGES'),
    GRANT_MESSAGES: parseMessageTable(source, 'GRANT_MESSAGES'),
    WITHDRAW_MESSAGES: parseMessageTable(source, 'WITHDRAW_MESSAGES'),
    GRANT_BLOCKING_CODES: parseCodeArray(source, 'GRANT_BLOCKING_CODES'),
    WITHDRAW_BLOCKING_CODES: parseCodeArray(source, 'WITHDRAW_BLOCKING_CODES'),
  };
  for (const [name, codes] of Object.entries(tables)) {
    assert.ok(codes.length > 0, `客户端表 ${name} 解析为空：零命中不能当通过`);
  }
  return tables;
}

function clientCodeSet(tables) {
  return [
    ...new Set([
      ...tables.MESSAGES,
      ...tables.GRANT_MESSAGES,
      ...tables.WITHDRAW_MESSAGES,
      ...tables.GRANT_BLOCKING_CODES,
      ...tables.WITHDRAW_BLOCKING_CODES,
    ]),
  ].sort();
}

/** 判据 ③ 的纯函数：返回服务端有、客户端与已登记例外都没有的码。 */
function missingFromClient(serverCodes, clientCodes, exceptions) {
  const allowed = new Set([...clientCodes, ...exceptions.map((entry) => entry.code)]);
  return serverCodes.filter((code) => !allowed.has(code)).sort();
}

/** 判据 ③ 的例外表自检：每条都在服务端、都不在客户端，字段齐全、不重复。 */
function exceptionProblems(serverCodes, clientCodes, exceptions) {
  const problems = [];
  const seen = new Set();
  for (const entry of exceptions) {
    const { code, reason, where } = entry || {};
    if (!code || !reason || !where) {
      problems.push(`${String(code)}：例外条目必须同时给 code/reason/where`);
      continue;
    }
    if (seen.has(code)) problems.push(`${code}：例外表重复登记`);
    seen.add(code);
    if (!serverCodes.includes(code)) problems.push(`${code}：例外表里已过期（服务端码集合里没有它）`);
    if (clientCodes.includes(code)) {
      problems.push(`${code}：客户端表里已经有它，必须从 SERVER_ONLY_EXCEPTIONS 删掉`);
    }
  }
  return problems.sort();
}

/** 判据 ④ 的纯函数：返回客户端有、服务端与白名单都没有的码。 */
function unlistedClientCodes(clientCodes, serverCodes, clientOnly) {
  const allowed = new Set([...serverCodes, ...clientOnly.map((entry) => entry.code)]);
  return clientCodes.filter((code) => !allowed.has(code)).sort();
}

/** 判据 ④ 的白名单自检：每条都在客户端表里、都不是服务端码，理由齐全、不重复。 */
function clientOnlyProblems(serverCodes, clientCodes, clientOnly) {
  const problems = [];
  const seen = new Set();
  for (const entry of clientOnly) {
    const { code, reason } = entry || {};
    if (!code || !reason) {
      problems.push(`${String(code)}：CLIENT_ONLY_CODES 每条必须给 code/reason`);
      continue;
    }
    if (seen.has(code)) problems.push(`${code}：CLIENT_ONLY_CODES 重复登记`);
    seen.add(code);
    if (!clientCodes.includes(code)) {
      problems.push(`${code}：客户端表里已没有它，必须删掉过期白名单条目`);
    }
    if (serverCodes.includes(code)) {
      problems.push(`${code}：它是服务端码，不得登记为 CLIENT_ONLY_CODES（走判据 ③ 或补客户端表）`);
    }
  }
  return problems.sort();
}

test('扫描面是冻结的三份服务端文件，且每份都真实存在非空（下界守卫）', () => {
  assert.deepEqual([...SCANNED_FILES], [
    'services/api/src/routes/consents.ts',
    'services/api/src/privacy/grant-pg.ts',
    'services/api/src/privacy/consent-pg.ts',
  ]);
  for (const relPath of SCANNED_FILES) {
    const text = read(relPath);
    assert.ok(text.length > 0, `扫描面文件为空：${relPath}`);
  }
});

test('服务端授权错误码是精确的 14 个（多一个 / 少一个 / 改一个码都红）', () => {
  const codes = uniqueServerCodes(scanServerHits());
  assert.deepEqual(
    codes,
    [...EXPECTED_SERVER_CODES].sort(),
    '服务端授权码集合漂移了：新增/删除/改码必须同步 EXPECTED_SERVER_CODES 与证据页',
  );
  assert.equal(codes.length, 14, '服务端码数必须等于冻结清单长度（零命中不能当通过）');
});

test('每个 new ApiError(...) 调用点都被抽取形状覆盖（新写法不会静默漏抽）', () => {
  const totals = { total: 0, direct: 0, ternary: 0, dynamic: 0 };
  for (const relPath of SCANNED_FILES) {
    const counts = apiErrorShapeCounts(read(relPath));
    assert.ok(counts.total > 0, `${relPath} 里没有 new ApiError(...)，扫描面是不是失效了？`);
    assert.equal(
      counts.total,
      counts.direct + counts.ternary + counts.dynamic,
      `${relPath} 有 ${counts.total} 个 new ApiError(...)，但只有 ` +
        `${counts.direct} 直接 + ${counts.ternary} 三元 + ${counts.dynamic} 动态被识别：` +
        '新增了未覆盖的写法，必须补 SERVER_PATTERNS 后再放行',
    );
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }
  assert.ok(totals.direct + totals.ternary + totals.dynamic > 0, '三类调用点合计为 0：抽取形状失效');
});

test('客户端五张表可解析，且逐表与冻结清单相等（删键/加键/改名都红）', () => {
  const tables = readClientTables();
  for (const [name, expected] of Object.entries(EXPECTED_MESSAGE_TABLES)) {
    assert.deepEqual(tables[name], [...expected].sort(), `客户端文案表 ${name} 漂移了`);
  }
  for (const [name, expected] of Object.entries(EXPECTED_CODE_ARRAYS)) {
    assert.deepEqual(tables[name], [...expected].sort(), `客户端置灰码数组 ${name} 漂移了`);
  }
});

test('判据 ③：服务端码 ⊆ 客户端处理集合 ∪ 已登记的 SERVER_ONLY_EXCEPTIONS', () => {
  const serverCodes = uniqueServerCodes(scanServerHits());
  const clientCodes = clientCodeSet(readClientTables());

  const missing = missingFromClient(serverCodes, clientCodes, SERVER_ONLY_EXCEPTIONS);
  assert.deepEqual(
    missing,
    [],
    `服务端会抛、客户端五张表都不处理、也没登记例外的授权码：${missing.join(', ')}`,
  );
  assert.deepEqual(
    exceptionProblems(serverCodes, clientCodes, SERVER_ONLY_EXCEPTIONS),
    [],
    'SERVER_ONLY_EXCEPTIONS 自检失败（过期条目 / 与客户端表并存 / 字段缺失）',
  );
});

test('判据 ④：客户端码 ⊆ 服务端码 ∪ CLIENT_ONLY_CODES（白名单每条都必须成立）', () => {
  const serverCodes = uniqueServerCodes(scanServerHits());
  const clientCodes = clientCodeSet(readClientTables());

  const unlisted = unlistedClientCodes(clientCodes, serverCodes, CLIENT_ONLY_CODES);
  assert.deepEqual(
    unlisted,
    [],
    `客户端表里有、服务端扫描面没有、也没登记 CLIENT_ONLY_CODES 的码：${unlisted.join(', ')}`,
  );
  assert.deepEqual(
    clientOnlyProblems(serverCodes, clientCodes, CLIENT_ONLY_CODES),
    [],
    'CLIENT_ONLY_CODES 自检失败（服务端已有的码 / 过期条目 / 理由缺失）',
  );
});

test('负控制 ①：往服务端码里塞假码 ⇒ 判据 ③ 必须点名它', () => {
  const serverCodes = [...uniqueServerCodes(scanServerHits()), 'TOTALLY_FAKE_CODE'];
  const clientCodes = clientCodeSet(readClientTables());
  assert.deepEqual(
    missingFromClient(serverCodes, clientCodes, SERVER_ONLY_EXCEPTIONS),
    ['TOTALLY_FAKE_CODE'],
  );
});

test('负控制 ②：删掉 WITHDRAW_MESSAGES 的 REVISION_REQUIRED 键 ⇒ 判据 ③ 必须点名它', () => {
  const tables = readClientTables();
  const pruned = clientCodeSet({
    ...tables,
    // 选一个只在这张表里出现的服务端码（NOT_FOUND 同时是 WITHDRAW_BLOCKING_CODES 成员，
    // 删文案键不会离开「处理集合」，不能用来验证判据 ③）。
    WITHDRAW_MESSAGES: tables.WITHDRAW_MESSAGES.filter((code) => code !== 'REVISION_REQUIRED'),
  });
  assert.deepEqual(
    missingFromClient(uniqueServerCodes(scanServerHits()), pruned, SERVER_ONLY_EXCEPTIONS),
    ['REVISION_REQUIRED'],
  );
});

test('负控制 ③：往 CLIENT_ONLY_CODES 塞服务端真有的 NOT_FOUND ⇒ 判据 ④ 必须红', () => {
  const serverCodes = uniqueServerCodes(scanServerHits());
  const clientCodes = clientCodeSet(readClientTables());
  const problems = clientOnlyProblems(serverCodes, clientCodes, [
    ...CLIENT_ONLY_CODES,
    { code: 'NOT_FOUND', reason: '负控制夹具：服务端真有的码' },
  ]);
  assert.equal(problems.length, 1, `负控制应只报一条，实际：${problems.join(' | ')}`);
  assert.match(problems[0], /NOT_FOUND/);
});

/**
 * R28-S62 · 数据库错误折叠的 `retryable` 分档判据（7 个子域 + 与问答域参照实现的一致性）。
 *
 * 背景（本仓 2026-10-20/21 连续四例「运行时授权缺失」S26/S28/S38/S45 的可见症状）：
 * `services/api/src/favorites/store-pg.ts:45-52` 曾把非超时错误一律折成
 * `ApiError('PROVIDER_UNAVAILABLE', …, { retryable: true })` ⇒ 权限缺失表现为**永久 503 且标记可重试**，
 * 监控里像下游抖动，不像"运维必须改配置"。本文件把「通用分支按瞬态判定」这条口径钉成可执行断言：
 *
 *  - `42501`（权限不足）/ `42P01`（表缺失）/ `3D000`（库缺失）/ `28P01`（凭据）/ `42883`（函数缺失）/
 *    `XX000`（内部错误）/ `22P02`（数据表示错误）⇒ 重试永远不会好 ⇒ `retryable === false`；
 *  - `08xxx`（连接层）/ `57P0x`（含管理员重启）/ `40001`（串行化失败）/ `40P01`（死锁）/
 *    `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` ⇒ 瞬态 ⇒ `retryable === true`；
 *  - `57014` / `55P03` ⇒ 仍是 `PROVIDER_TIMEOUT`(504) 且 `retryable === true`（专用分支不动）；
 *  - 无法归类的普通 `Error` ⇒ `retryable === false`（与 `conversations/store-pg.ts:68` 参照实现一致）；
 *    `speech` 的既有语义是**原样抛出**无 `code` 的错误（不折成 provider 故障），本文件按现状钉住。
 *
 * 状态码与错误码**一律不变**：`PROVIDER_UNAVAILABLE` 仍是 503、`PROVIDER_TIMEOUT` 仍是 504，
 * 本文件断言的差异只有 `retryable`。另含**反向守卫**与内存夹具（见文件末两节）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError } from '../../services/api/src/errors.ts';
import { isTransientDatabaseError } from '../../services/api/src/db/pool.ts';
import {
  classifyConversationDatabaseError,
} from '../../services/api/src/conversations/store-pg.ts';
import { classifyFavoritesDatabaseError } from '../../services/api/src/favorites/store-pg.ts';
import { classifyHistoryDatabaseError } from '../../services/api/src/history/store-pg.ts';
import { classifyCommunityDatabaseError } from '../../services/api/src/community/store-pg.ts';
import { classifyMessagesDatabaseError } from '../../services/api/src/messages/store-pg.ts';
import {
  OcrTablesMissingError,
  classifyOcrDatabaseError,
  createPostgresOcrStore,
} from '../../services/api/src/ocr/store-pg.ts';
import {
  SpeechTablesMissingError,
  classifySpeechDatabaseError,
  createPostgresSpeechStore,
} from '../../services/api/src/speech/store-pg.ts';
import {
  RecognitionTablesMissingError,
  classifyRecognitionDatabaseError,
  createPostgresRecognitionStore,
} from '../../services/api/src/recognitions/store-pg.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OWNER = '11111111-1111-4111-8111-111111111111';
const MEDIA = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-10-21T08:00:00.000Z');

/** 7 个待判子域 + 正确参照（`conversations`）的分档入口与文案。 */
const DOMAINS = [
  {
    name: 'conversations（正确参照）',
    classifier: classifyConversationDatabaseError,
    unavailable: '问答数据库暂不可用',
    timeout: '问答数据库响应超时',
  },
  {
    name: 'favorites',
    classifier: classifyFavoritesDatabaseError,
    unavailable: '收藏数据库暂不可用',
    timeout: '收藏数据库响应超时',
  },
  {
    name: 'history',
    classifier: classifyHistoryDatabaseError,
    unavailable: '历史数据库暂不可用',
    timeout: '历史数据库响应超时',
  },
  {
    name: 'community',
    classifier: classifyCommunityDatabaseError,
    unavailable: '社区数据库暂不可用',
    timeout: '社区数据库响应超时',
  },
  {
    name: 'messages',
    classifier: classifyMessagesDatabaseError,
    unavailable: '消息数据库暂不可用',
    timeout: '消息数据库响应超时',
  },
  {
    name: 'ocr',
    classifier: classifyOcrDatabaseError,
    unavailable: 'OCR 数据库暂不可用',
    timeout: 'OCR 数据库响应超时',
  },
  {
    name: 'speech',
    classifier: classifySpeechDatabaseError,
    unavailable: '转写数据库暂不可用',
    timeout: '转写数据库响应超时',
  },
  {
    name: 'recognitions',
    classifier: classifyRecognitionDatabaseError,
    unavailable: '识别数据库暂不可用',
    timeout: '识别数据库响应超时',
  },
];

/**
 * 判定矩阵：驱动码 ⇒ 期望的契约错误码 / HTTP 状态 / `retryable`。
 *
 * `kind` 只决定文案用哪个（`timeout` 分支有专用文案），**不改**错误码集合。
 */
const MATRIX = [
  { code: '42501', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false },
  { code: '42P01', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false },
  { code: '3D000', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false },
  { code: '28P01', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false },
  { code: '42883', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false },
  { code: 'XX000', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false },
  { code: '22P02', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false },
  { code: '08006', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  { code: '08001', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  { code: '57P01', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  { code: '40001', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  { code: '40P01', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  { code: 'ECONNREFUSED', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  { code: 'ECONNRESET', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  { code: 'ETIMEDOUT', kind: 'unavailable', out: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  { code: '57014', kind: 'timeout', out: 'PROVIDER_TIMEOUT', status: 504, retryable: true },
  { code: '55P03', kind: 'timeout', out: 'PROVIDER_TIMEOUT', status: 504, retryable: true },
];

const driverError = (code, message = `合成用例：驱动错误 ${code}`) =>
  Object.assign(new Error(message), { code });

/** 收集同步折叠器抛出的错误（折叠器的返回类型是 `never`）。 */
function thrownBy(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** 收集异步调用的拒绝值。 */
async function rejectedBy(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function assertMatrixRow(domain, row) {
  const error = thrownBy(() => domain.classifier(driverError(row.code)));
  assert.ok(error instanceof ApiError, `${domain.name} ${row.code}: 必须抛 ApiError`);
  assert.equal(error.code, row.out, `${domain.name} ${row.code}: 错误码必须不变（契约闭集）`);
  assert.equal(error.status, row.status, `${domain.name} ${row.code}: HTTP 状态必须不变`);
  assert.equal(
    error.retryable,
    row.retryable,
    `${domain.name} ${row.code}: retryable 应为 ${row.retryable}（口径见 services/api/src/errors.ts 的 ApiError 注释）`,
  );
  assert.equal(
    error.message,
    row.kind === 'timeout' ? domain.timeout : domain.unavailable,
    `${domain.name} ${row.code}: 文案必须保持不变`,
  );
  return error;
}

// ---------------------------------------------------------------------------
// 1. 判定矩阵：逐域 × 逐驱动码
// ---------------------------------------------------------------------------

test('判定矩阵：42501 / 42P01 / 08006 / ECONNREFUSED / 57014 / 未知 Error 在 7 个 classifier 上逐条读数正确', () => {
  for (const domain of DOMAINS) {
    for (const row of MATRIX) assertMatrixRow(domain, row);
  }
});

test('权限/配置类（42501 / 42P01 / 3D000 / 28P01 / 42883）在 7 个 classifier 上都是不可重试', () => {
  const configCodes = ['42501', '42P01', '3D000', '28P01', '42883'];
  for (const domain of DOMAINS) {
    for (const code of configCodes) {
      const row = MATRIX.find((item) => item.code === code);
      const error = assertMatrixRow(domain, row);
      assert.equal(error.retryable, false, `${domain.name} ${code}: 权限/配置类不得声称可重试`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. 42P01：三个域的「表未迁移」专用分支（分类器之外的调用点）仍走专用文案
// ---------------------------------------------------------------------------

/** 记录型假池：只答就绪探测；任何业务 SQL 都算夹具错误（证明 fail-closed 发生在发 SQL 之前）。 */
function makeProbePool(probeRows) {
  const probes = [];
  const query = async (text) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (sql.includes('to_regclass')) {
      probes.push(sql);
      return { rows: probeRows };
    }
    throw new Error(`测试夹具：缺表路径不应发出业务 SQL（收到 ${sql}）`);
  };
  const pool = {
    query,
    async connect() {
      return { query, release() {} };
    },
  };
  return { pool, probes };
}

const jobInput = (overrides = {}) => ({
  id: randomUUID(),
  revision: 1,
  ownerUserId: OWNER,
  mediaId: MEDIA,
  mediaRevision: 2,
  state: 'queued',
  deadlineAt: new Date(T0.getTime() + 30_000),
  createdAt: T0,
  updatedAt: T0,
  errorCode: null,
  ...overrides,
});

const SPECIALIZED_TABLE_BRANCHES = [
  {
    name: 'ocr',
    classifier: classifyOcrDatabaseError,
    errorClass: OcrTablesMissingError,
    message: 'OCR 持久化表未迁移（0024_ocr_persistence.sql）：拒绝写入，避免静默丢数据',
    store: () => createPostgresOcrStore({ pool: makeProbePool([{ ready: false }]).pool }),
    insert: (store) => store.insertJob(jobInput({ kind: 'ocr', ocrId: randomUUID() })),
  },
  {
    name: 'speech',
    classifier: classifySpeechDatabaseError,
    errorClass: SpeechTablesMissingError,
    message: '转写持久化表未迁移（0026_speech_persistence.sql）：拒绝写入，避免静默丢数据',
    store: () => createPostgresSpeechStore({ pool: makeProbePool([{ ready: false }]).pool }),
    insert: (store) => store.insertJob(jobInput({ kind: 'transcription', transcriptionId: randomUUID() })),
  },
  {
    name: 'recognitions',
    classifier: classifyRecognitionDatabaseError,
    errorClass: RecognitionTablesMissingError,
    message: '识别持久化表未迁移（0025_recognitions_persistence.sql）：拒绝写入，避免静默丢数据',
    store: () => createPostgresRecognitionStore({ pool: makeProbePool([{ ready: false }]).pool }),
    insert: (store) => store.insertJob(jobInput({ kind: 'recognition', recognitionId: randomUUID() })),
  },
];

test('42P01：ocr / speech / recognitions 的写类仍走「表未迁移」专用分支（专用文案 + retryable=false）', async () => {
  for (const branch of SPECIALIZED_TABLE_BRANCHES) {
    const error = await rejectedBy(() => branch.insert(branch.store()));
    assert.ok(error instanceof branch.errorClass, `${branch.name}: 42P01 必须走专用错误类`);
    assert.ok(error instanceof ApiError, `${branch.name}: 专用错误仍是 ApiError`);
    assert.equal(error.message, branch.message, `${branch.name}: 专用文案必须点名迁移号`);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${branch.name}: 错误码不变`);
    assert.equal(error.status, 503, `${branch.name}: HTTP 状态不变`);
    assert.equal(error.retryable, false, `${branch.name}: 迁移未执行不可重试`);
  }
});

test('42P01：分类器本身把 42P01 折成通用分支（不可重试），与专用分支文案互不冒充', () => {
  for (const branch of SPECIALIZED_TABLE_BRANCHES) {
    const error = thrownBy(() => branch.classifier(driverError('42P01')));
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /未迁移/, '分类器不得冒充「表未迁移」专用文案');
    assert.equal(error.message, DOMAINS.find((domain) => domain.name === branch.name).unavailable);
  }
});

// ---------------------------------------------------------------------------
// 3. 未知 Error：非瞬态即 false（speech 的既有语义原样抛出，按现状钉住）
// ---------------------------------------------------------------------------

test('无法归类的普通 Error：除 speech 原样抛出外，一律 PROVIDER_UNAVAILABLE 且 retryable=false', () => {
  for (const domain of DOMAINS) {
    const boom = new Error('实现缺陷（无驱动错误码）');
    const error = thrownBy(() => domain.classifier(boom));
    if (domain.name === 'speech') {
      assert.equal(error, boom, 'speech 既有语义：无 code 的原样抛出，不折成 provider 故障');
      continue;
    }
    assert.ok(error instanceof ApiError, `${domain.name}: 应折成 ApiError`);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${domain.name}: 错误码不变`);
    assert.equal(error.status, 503, `${domain.name}: HTTP 状态不变`);
    assert.equal(error.retryable, false, `${domain.name}: 无法归类 ⇒ 重试不会好 ⇒ false`);
  }
});

// ---------------------------------------------------------------------------
// 4. 与共享判定函数同源（抽样交叉验证，防两套口径）
// ---------------------------------------------------------------------------

test('抽样交叉：分类器读数与 db/pool.ts 的 isTransientDatabaseError 逐条一致', () => {
  for (const row of MATRIX) {
    if (row.kind === 'timeout') continue; // 57014/55P03 走专用分支，恒 true
    assert.equal(
      isTransientDatabaseError(driverError(row.code)),
      row.retryable,
      `${row.code}: 共享判定函数与期望矩阵不一致`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. 反向守卫：7 个 store-pg.ts 不得把「数据库暂不可用」通用分支写回恒 retryable: true
// ---------------------------------------------------------------------------

const STORE_FILES = [
  'services/api/src/favorites/store-pg.ts',
  'services/api/src/history/store-pg.ts',
  'services/api/src/community/store-pg.ts',
  'services/api/src/messages/store-pg.ts',
  'services/api/src/ocr/store-pg.ts',
  'services/api/src/speech/store-pg.ts',
  'services/api/src/recognitions/store-pg.ts',
];

/**
 * 通用分支的源码形态：`new ApiError('PROVIDER_UNAVAILABLE', '<域>数据库暂不可用', { retryable: <expr> })`。
 *
 * 只匹配「`PROVIDER_UNAVAILABLE` + 文案含『数据库暂不可用』」这一对，因此**不会**误伤：
 *  - 超时分支的 `retryable: true`（`PROVIDER_TIMEOUT` + 『响应超时』文案）；
 *  - 就绪探测「结果未知」的 503（文案是『探测结果未知』，且原因已先经过分类器折叠）。
 */
const UNAVAILABLE_BRANCH =
  /new ApiError\(\s*'PROVIDER_UNAVAILABLE'\s*,\s*'([^']*数据库暂不可用[^']*)'\s*,\s*\{([^}]*)\}/g;

function scanUnavailableBranches(text) {
  const branches = [];
  for (const match of text.matchAll(UNAVAILABLE_BRANCH)) {
    const options = match[2].replace(/\s+/g, ' ').trim().replace(/,$/, '');
    branches.push({
      message: match[1],
      options,
      delegated: options === 'retryable: isTransientDatabaseError(error)',
      literalTrue: options === 'retryable: true',
    });
  }
  return branches;
}

test('反向守卫：7 个 store-pg.ts 的通用分支必须委托 isTransientDatabaseError，禁止恒 true 回潮', () => {
  const scanned = [];
  for (const file of STORE_FILES) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const branches = scanUnavailableBranches(text);
    assert.equal(
      branches.length,
      1,
      `${file}: 应恰有 1 处「数据库暂不可用」通用分支（正则失配会静默放过，故按数量钉住）`,
    );
    scanned.push(...branches.map((branch) => ({ file, ...branch })));
  }
  assert.equal(scanned.length, 7, '7 个 store-pg.ts 必须各命中一处');
  assert.deepEqual(
    scanned.filter((branch) => branch.literalTrue).map((branch) => `${branch.file} ${branch.message}`),
    [],
    '「通用分支恒 retryable: true」回潮：权限缺失会再次被伪装成下游抖动',
  );
  assert.deepEqual(
    scanned.filter((branch) => !branch.delegated).map((branch) => `${branch.file} retryable=${branch.options}`),
    [],
    '通用分支的 retryable 必须逐字为 isTransientDatabaseError(error)',
  );
});

test('反向守卫自检：内存夹具上「恒 true / 字面 false」必红，「共享判定」必绿，别处 true 不误报', () => {
  const regression = scanUnavailableBranches(
    "throw new ApiError('PROVIDER_UNAVAILABLE', '收藏数据库暂不可用', { retryable: true });",
  );
  assert.equal(regression.length, 1, '守卫必须能抓到恒 true 的旧写法（否则恒绿等于没有守卫）');
  assert.equal(regression[0].literalTrue, true);
  assert.equal(regression[0].delegated, false);

  const fixed = scanUnavailableBranches(
    "throw new ApiError('PROVIDER_UNAVAILABLE', '收藏数据库暂不可用', { retryable: isTransientDatabaseError(error) });",
  );
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].delegated, true);
  assert.equal(fixed[0].literalTrue, false);

  const multiline = scanUnavailableBranches(
    "throw new ApiError(\n  'PROVIDER_UNAVAILABLE',\n  '社区数据库暂不可用',\n  { retryable: isTransientDatabaseError(error) },\n);",
  );
  assert.equal(multiline.length, 1, '多行书写的通用分支同样要被扫到');
  assert.equal(multiline[0].delegated, true);

  // 用字面量 false 换掉共享判定同样会红：08006 等瞬态会被误报成不可重试。
  const literalFalse = scanUnavailableBranches(
    "throw new ApiError('PROVIDER_UNAVAILABLE', '收藏数据库暂不可用', { retryable: false });",
  );
  assert.equal(literalFalse.length, 1);
  assert.equal(literalFalse[0].delegated, false);
  assert.equal(literalFalse[0].literalTrue, false);

  // 不得误伤：超时分支的 retryable: true 与别的「未接线」文案都不是本守卫的目标。
  assert.deepEqual(
    scanUnavailableBranches("throw new ApiError('PROVIDER_TIMEOUT', '收藏数据库响应超时', { retryable: true });"),
    [],
  );
  assert.deepEqual(
    scanUnavailableBranches("throw new ApiError('PROVIDER_UNAVAILABLE', '功能未接线（审批面）', { retryable: true });"),
    [],
  );
});

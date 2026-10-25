/**
 * GY-I18（#18）· 作业台列表**服务端过滤**（`state` / `error_code`）单元测试。
 *
 * 用假池（fake pool）+ 内存端口钉住三件事，全部离线可跑：
 * 1. **过滤下推到 SQL**：`WHERE state = $2::text` / `WHERE error_code = $2::text` /
 *    `WHERE state = $2::text AND error_code = $3::text` 出现在语句里，值只出现在**绑定参数**里
 *    （语句文本里不许出现过滤值本身 —— 那是字符串拼接的特征）；`$1` 恒为硬上限。
 * 2. **不传过滤 ≡ 改动前**：语句逐字相同（无 `WHERE`）、绑定只有 `[limit]`。
 * 3. **闭集外的入参 ⇒ 400 `INVALID_REQUEST`**（不是 503、不是静默空页）：
 *    `state` 用契约 `JobState` 七值、`error_code` 用契约 `ErrorCode` 二十四值；
 *    非字符串（重复查询参数会变数组）也是 400，但 `code` 是 `type` 而不是 `enum`。
 *
 * 另外钉住容易回归的两条边界：
 * - **未接线端口（503）优先于入参非法（400）**：端口没接线时"这个状态有没有作业"本就无法回答；
 * - **游标 watermark 绑筛选组合**：换一组筛选条件 ⇒ 旧游标 `INVALID_CURSOR`（回第一页），
 *   同一组筛选条件翻页照常。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresAdminJobPort, ADMIN_JOB_LIST_LIMIT, ADMIN_JOB_SQL } from '../../services/api/src/admin/ops/jobs-pg.ts';
import { createMemoryAdminJobPort, parseAdminJobFilter } from '../../services/api/src/admin/ops/jobs.ts';
import { JOB_STATES } from '../../services/api/src/admin/ops/types.ts';
import { ERROR_CODES } from '../../services/api/src/contract.ts';
import {
  JOB_CANCELLED,
  JOB_QUEUED,
  JOB_RUNNING,
  JOB_SUCCEEDED,
  createOpsHarness,
  expectApiError,
  jobSeed,
  makeUuid,
  opsContext,
} from './admin-ops-fixtures.mjs';

// ---------------------------------------------------------------------------
// 假池：记录调用 + 按语句里真实出现的 WHERE 片段过滤（不是"按入参过滤"）
// ---------------------------------------------------------------------------

const ROWS_BY_TABLE = {
  'public.ocr_jobs': [
    {
      id: makeUuid(901),
      revision: 1,
      ocr_id: makeUuid(911),
      state: 'failed',
      deadline_at: '2026-10-12T01:00:00.000Z',
      created_at: '2026-10-12T00:03:00.000Z',
      error_code: 'PROVIDER_TIMEOUT',
    },
  ],
  'public.recognition_jobs': [
    {
      id: makeUuid(902),
      revision: 1,
      recognition_id: makeUuid(912),
      state: 'queued',
      deadline_at: '2026-10-12T01:00:00.000Z',
      created_at: '2026-10-12T00:02:00.000Z',
      error_code: null,
    },
  ],
  'public.speech_jobs': [
    {
      id: makeUuid(903),
      revision: 1,
      transcription_id: makeUuid(913),
      state: 'running',
      deadline_at: '2026-10-12T01:00:00.000Z',
      created_at: '2026-10-12T00:01:00.000Z',
      error_code: null,
    },
  ],
};

/** 语句里出现的是哪种 WHERE 组合（顺序重要：组合片段包含单条件片段）。 */
function whereKind(text) {
  const fragments = ADMIN_JOB_SQL.listWhere;
  if (text.includes(fragments.state_and_error_code)) return 'state_and_error_code';
  if (text.includes(fragments.state)) return 'state';
  if (text.includes(fragments.error_code)) return 'error_code';
  return 'none';
}

/** 单表行：按语句里**真实出现**的 WHERE 片段筛，再用 `$1` 截断（模拟库自己做的事）。 */
function rowsForStatement(text, values, rows) {
  const kind = whereKind(text);
  const state = kind === 'state' || kind === 'state_and_error_code' ? values[1] : null;
  const errorCode =
    kind === 'state_and_error_code' ? values[2] : kind === 'error_code' ? values[1] : null;
  return rows
    .filter((row) => state === null || row.state === state)
    .filter((row) => errorCode === null || row.error_code === errorCode)
    .slice(0, values[0]);
}

function fakePool(rowsByTable = ROWS_BY_TABLE) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values: [...values] });
      const table = Object.keys(rowsByTable).find((candidate) => text.includes(candidate));
      if (table === undefined) throw new Error(`假池不认识这条语句：${text}`);
      return { rows: rowsForStatement(text, values, rowsByTable[table]) };
    },
    async connect() {
      // 列表用例不该开事务；真开了就是回归，直接炸。
      throw new Error('列表读面不应 connect() 开事务');
    },
  };
}

function portWith(pool) {
  return createPostgresAdminJobPort({ pool, limit: ADMIN_JOB_LIST_LIMIT });
}

// ---------------------------------------------------------------------------
// 1. SQL 下推：WHERE 出现、值只走绑定、$1 恒为 limit
// ---------------------------------------------------------------------------

test('list(state)：三源语句都拼 WHERE state = $2::text，过滤值只出现在绑定参数里', async () => {
  const pool = fakePool();
  const jobs = await portWith(pool).list({ state: 'failed' });

  assert.equal(pool.calls.length, 3, '三张域表各一次查询');
  for (const call of pool.calls) {
    assert.ok(
      call.text.includes(' WHERE state = $2::text'),
      `语句必须把 state 条件下推：${call.text}`,
    );
    assert.ok(call.text.endsWith(' ORDER BY created_at DESC, id DESC LIMIT $1::integer'));
    assert.deepEqual(call.values, [ADMIN_JOB_LIST_LIMIT, 'failed'], '绑定顺序必须是 [$1=limit, $2=state]');
    assert.equal(call.text.includes('failed'), false, '过滤值不得被拼进语句文本（参数化）');
  }
  // WHERE 必须在表名之后、ORDER BY 之前（拆段拼接没有把子句放错位置）。
  for (const call of pool.calls) {
    assert.ok(
      call.text.indexOf(' WHERE ') > call.text.indexOf(' FROM public.'),
      `WHERE 必须落在 FROM 之后：${call.text}`,
    );
    assert.ok(call.text.indexOf(' WHERE ') < call.text.indexOf(' ORDER BY '));
  }
  assert.deepEqual(jobs.map((job) => job.state), ['failed'], '只有 ocr 源那条 failed');
  assert.equal(jobs[0].error_code, 'PROVIDER_TIMEOUT', '失败分类原样透出（不折叠）');
});

test('list(error_code)：三源语句都拼 WHERE error_code = $2::text，按文本列比较、不做枚举转换', async () => {
  const pool = fakePool();
  const jobs = await portWith(pool).list({ error_code: 'PROVIDER_TIMEOUT' });

  assert.equal(pool.calls.length, 3);
  for (const call of pool.calls) {
    assert.ok(
      call.text.includes(' WHERE error_code = $2::text'),
      `语句必须把 error_code 条件下推：${call.text}`,
    );
    assert.deepEqual(call.values, [ADMIN_JOB_LIST_LIMIT, 'PROVIDER_TIMEOUT']);
    assert.equal(call.text.includes('PROVIDER_TIMEOUT'), false, '过滤值不得被拼进语句文本');
    // 三张域表的 error_code 是 varchar(80)（不是枚举列）：⛔ 不许出现枚举类型转换/多余的列转换。
    assert.equal(/::(job_state|error_code|public\.)/i.test(call.text), false, `不得做枚举类型转换：${call.text}`);
    assert.equal(/error_code\s*::\s*\w+/i.test(call.text), false, 'error_code 不得左值转型（按文本列直接比）');
  }
  assert.deepEqual(jobs.map((job) => job.kind), ['ocr']);
});

test('list(state + error_code)：两个条件按 $2/$3 顺序绑定', async () => {
  const pool = fakePool();
  const jobs = await portWith(pool).list({ state: 'failed', error_code: 'PROVIDER_TIMEOUT' });

  for (const call of pool.calls) {
    assert.ok(
      call.text.includes(' WHERE state = $2::text AND error_code = $3::text'),
      `两个条件必须同时下推：${call.text}`,
    );
    assert.deepEqual(call.values, [ADMIN_JOB_LIST_LIMIT, 'failed', 'PROVIDER_TIMEOUT']);
    assert.equal(call.text.includes('failed'), false);
    assert.equal(call.text.includes('PROVIDER_TIMEOUT'), false);
  }
  assert.deepEqual(jobs.map((job) => job.id), [makeUuid(901)]);
});

test('list() 不传过滤：语句与改动前逐字相同（无 WHERE）、绑定只有 [limit]', async () => {
  const pool = fakePool();
  const jobs = await portWith(pool).list();

  // 与 `ADMIN_JOB_SQL.list`（"无过滤时的列表语句"）逐字比对：这才是"没变"的硬证据。
  assert.deepEqual(
    pool.calls.map((call) => call.text).sort(),
    [...ADMIN_JOB_SQL.list].sort(),
    '不传过滤时的语句必须与 ADMIN_JOB_SQL.list 逐字相同',
  );
  for (const call of pool.calls) {
    assert.equal(/\bWHERE\b/.test(call.text), false, `不传过滤不得出现 WHERE：${call.text}`);
    assert.deepEqual(call.values, [ADMIN_JOB_LIST_LIMIT], '不传过滤时只绑 limit');
  }
  // 三源合并后按 created_at DESC（最新在前），与改前一致。
  assert.deepEqual(jobs.map((job) => job.kind), ['ocr', 'recognition', 'transcription']);
});

test('list({}) / list({state: undefined}) 等价于不传过滤（空对象不产生 WHERE）', async () => {
  const pool = fakePool();
  await portWith(pool).list({});
  await portWith(pool).list({ state: undefined, error_code: undefined });
  for (const call of pool.calls) {
    assert.equal(/\bWHERE\b/.test(call.text), false, `空过滤不得出现 WHERE：${call.text}`);
    assert.deepEqual(call.values, [ADMIN_JOB_LIST_LIMIT]);
  }
});

// ---------------------------------------------------------------------------
// 2. 闭集外入参 ⇒ 400 INVALID_REQUEST（端口这一层，不查库）
// ---------------------------------------------------------------------------

test('list：闭集外的 state ⇒ 400 INVALID_REQUEST，且一条查询都不发', async () => {
  for (const bogus of ['FAILED', 'queued ', 'done', 'タイムアウト']) {
    const pool = fakePool();
    const error = await expectApiError(() => portWith(pool).list({ state: bogus }), 'INVALID_REQUEST');
    assert.equal(error.status, 400, `闭集外入参必须是 400（不是 503）：state=${bogus}`);
    assert.deepEqual(
      error.details,
      [{ field: 'state', code: 'enum' }],
      '必须指出是哪个字段、哪种非法（enum），供 UI 定位',
    );
    assert.equal(pool.calls.length, 0, '入参非法时不得读库');
  }
});

test('list：闭集外的 error_code ⇒ 400 INVALID_REQUEST（不是 503 "读出来的值不认识"）', async () => {
  const pool = fakePool();
  const error = await expectApiError(
    () => portWith(pool).list({ error_code: 'PROVIDER_TIMEOUTS' }),
    'INVALID_REQUEST',
  );
  assert.equal(error.status, 400);
  assert.deepEqual(error.details, [{ field: 'error_code', code: 'enum' }]);
  assert.equal(pool.calls.length, 0);
});

test('list：非字符串（重复查询参数变数组）⇒ 400 INVALID_REQUEST，code=type', async () => {
  const pool = fakePool();
  const error = await expectApiError(
    () => portWith(pool).list({ state: ['queued', 'failed'] }),
    'INVALID_REQUEST',
  );
  assert.deepEqual(error.details, [{ field: 'state', code: 'type' }]);
  assert.equal(pool.calls.length, 0);
});

test('契约闭集就是判定依据：JOB_STATES 七值全收、闭集外全拒；ERROR_CODES 二十四值全收', async () => {
  // 正面：闭集内每个取值都能通过（不会因为判定表漏项而误拒）。
  for (const state of JOB_STATES) {
    const pool = fakePool();
    await portWith(pool).list({ state });
    assert.deepEqual(pool.calls[0].values, [ADMIN_JOB_LIST_LIMIT, state]);
  }
  for (const code of ERROR_CODES) {
    const pool = fakePool();
    await portWith(pool).list({ error_code: code });
    assert.deepEqual(pool.calls[0].values, [ADMIN_JOB_LIST_LIMIT, code]);
  }
  assert.equal(JOB_STATES.length, 7);
  assert.equal(ERROR_CODES.length, 24);
});

test('过滤入参的空串/undefined/null 视为"没给"，不返回 400', async () => {
  const pool = fakePool();
  await portWith(pool).list({ state: '', error_code: null });
  for (const call of pool.calls) {
    assert.equal(/\bWHERE\b/.test(call.text), false, `空串/null 不得产生 WHERE：${call.text}`);
    assert.deepEqual(call.values, [ADMIN_JOB_LIST_LIMIT]);
  }
});

test('parseAdminJobFilter：判定结果只含给过的字段（读面据此决定要不要下推 WHERE）', () => {
  assert.deepEqual(parseAdminJobFilter({}), {});
  assert.deepEqual(parseAdminJobFilter({ state: 'failed' }), { state: 'failed' });
  assert.deepEqual(parseAdminJobFilter({ error_code: 'PROVIDER_TIMEOUT' }), { error_code: 'PROVIDER_TIMEOUT' });
  assert.deepEqual(parseAdminJobFilter({ state: '', error_code: '' }), {});
  assert.deepEqual(parseAdminJobFilter({ state: 'failed', error_code: 'PROVIDER_TIMEOUT' }), {
    state: 'failed',
    error_code: 'PROVIDER_TIMEOUT',
  });
});

// ---------------------------------------------------------------------------
// 3. 服务层：过滤生效、400/503 的优先序、游标 watermark 绑筛选组合
// ---------------------------------------------------------------------------

test('listAdminJobs：state 过滤在服务层生效（200，只回该状态的作业）', async () => {
  const { service } = createOpsHarness();
  const response = await service.listAdminJobs(opsContext(), { state: 'queued' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.items.map((job) => job.id), [JOB_QUEUED]);
  assert.equal(response.body.data.next_cursor, null);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('listAdminJobs：error_code 过滤生效；匹配不到 ⇒ 200 空页（不是 404、不是 503）', async () => {
  const { service } = createOpsHarness();
  const hit = await service.listAdminJobs(opsContext(), { error_code: 'PROVIDER_TIMEOUT' });
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.body.data.items, [], '种子作业的 error_code 全是 null');

  const miss = await service.listAdminJobs(opsContext(), { error_code: 'RATE_LIMITED' });
  assert.equal(miss.status, 200);
  assert.deepEqual(miss.body.data.items, []);
  assert.equal(miss.body.data.next_cursor, null);
});

test('listAdminJobs：不传过滤 ≡ 改动前的全量读面（4 条种子全回，顺序不变）', async () => {
  const { service } = createOpsHarness();
  const response = await service.listAdminJobs(opsContext());
  assert.equal(response.status, 200);
  // 种子行 created_at 全相同 ⇒ 端口按 id DESC 排序（改动前后都必须是这样）。
  assert.deepEqual(
    response.body.data.items.map((job) => job.id),
    [JOB_CANCELLED, JOB_SUCCEEDED, JOB_RUNNING, JOB_QUEUED],
  );
  assert.equal(response.body.data.items.length, jobSeed().length);
});

test('listAdminJobs：闭集外的 state / error_code ⇒ 400 INVALID_REQUEST（服务层）', async () => {
  const { service } = createOpsHarness();
  for (const query of [{ state: 'canceled' }, { error_code: 'TIMEOUT' }]) {
    const error = await expectApiError(() => service.listAdminJobs(opsContext(), query), 'INVALID_REQUEST');
    assert.equal(error.status, 400);
  }
});

test('未接线端口（503）优先于入参非法（400）：先报"读不到"，不先挑入参的刺', async () => {
  const { service } = createOpsHarness({ wireJobs: false });
  await expectApiError(
    () => service.listAdminJobs(opsContext(), { state: 'canceled' }),
    'PROVIDER_UNAVAILABLE',
  );
});

test('游标 watermark 绑筛选组合：同一组筛选可翻页，换一组筛选 ⇒ 400 INVALID_CURSOR', async () => {
  const failedSeed = [901, 902, 903].map((n) => ({
    id: makeUuid(n),
    revision: 1,
    kind: 'ocr',
    target_ref: { type: 'ocr', id: makeUuid(n + 10), revision: 1 },
    state: 'failed',
    deadline_at: '2026-10-12T01:00:00.000Z',
    created_at: `2026-10-12T00:0${n - 900}:00.000Z`,
    error_code: 'PROVIDER_TIMEOUT',
    result: null,
  }));
  const { service } = createOpsHarness({ jobPort: createMemoryAdminJobPort(failedSeed) });

  const first = await service.listAdminJobs(opsContext(), { state: 'failed', limit: 2 });
  assert.equal(first.body.data.items.length, 2);
  assert.equal(typeof first.body.data.next_cursor, 'string', '3 条 + limit=2 ⇒ 必须有下一页');
  const cursor = first.body.data.next_cursor;

  // 同一组筛选：翻页照常（watermark 只由"筛选组合 + 该组 id 列表"决定）。
  const second = await service.listAdminJobs(opsContext(), { state: 'failed', limit: 2, cursor });
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.body.data.items.map((job) => job.id),
    [makeUuid(901)],
    '按 created_at DESC：第二页是创建最早的 901',
  );

  // 换一组筛选（这里只留 error_code）：旧游标必须失效，⛔ 不许把上一组的位置套到这一组。
  const error = await expectApiError(
    () => service.listAdminJobs(opsContext(), { error_code: 'PROVIDER_TIMEOUT', limit: 2, cursor }),
    'INVALID_CURSOR',
  );
  assert.equal(error.message.includes('集合已变化'), true, `实际消息：${error.message}`);
});

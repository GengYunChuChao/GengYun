/**
 * GY-I18（#18）· 作业台列表**服务端过滤**（`state` / `error_code`）单元测试。
 *
 * 用假池（fake pool）+ 内存端口钉住三件事，全部离线可跑：
 * 1. **过滤下推到 SQL**：`WHERE state = $2::<cast>` / `WHERE error_code = $2::text` /
 *    `WHERE state = $2::<cast> AND error_code = $3::text` 出现在语句里，值只出现在**绑定参数**里
 *    （语句文本里不许出现过滤值本身 —— 那是字符串拼接的特征）；`$1` 恒为硬上限。
 *    ⚠ `state` 的 cast **逐源不同**：`ocr_jobs.state` 是 `text`+`CHECK`（`0024:93-95`），
 *    `recognition_jobs.state` / `speech_jobs.state` 是 `job_state` 枚举（`0025:117` / `0026:98`）。
 *    PG 里「枚举列 = text 参数」没有隐式转换，统一 `::text` 会让枚举源抛
 *    `42883 operator does not exist: job_state = text` ⇒ 真库臂 500（#587 CI 实测）。
 *    本文件逐源断言 cast，专门挡「有人改回统一 `::text`」这类回归。
 * 2. **不传过滤 ≡ 没有 `WHERE`**：语句与 `ADMIN_JOB_SQL.list` 逐字相同、绑定只有 `[limit]`。
 * 3. **闭集外的入参 ⇒ 400 `INVALID_REQUEST`**（不是 503、不是静默空页）：
 *    `state` 用契约 `JobState` 七值、`error_code` 用契约 `ErrorCode` 全集（不写死条数）；
 *    非字符串（重复查询参数会变数组）也是 400，但 `code` 是 `type` 而不是 `enum`。
 *
 * 末尾第 4 节钉住 `target_ref.revision` 的**真实来源**（`LEFT JOIN` 记录表取 `r.revision`）：
 * 记录已存在时透出记录行的真实版本、记录未创建时退回初始值 `1`、库里读出非法版本一律 503，
 * 以及取消面（`updateSql` 故意不 JOIN）回传前后 `target_ref` 三字段不变 —— 那正是
 * `services/api/src/admin/ops/service.ts:801-818` 对端口的硬要求（`revision` +1 而 `target_ref` 不变）。
 *
 * 另外钉住容易回归的两条边界：
 * - **未接线端口（503）优先于入参非法（400）**：端口没接线时"这个状态有没有作业"本就无法回答；
 * - **游标 watermark 绑筛选组合**：换一组筛选条件 ⇒ 旧游标 `INVALID_CURSOR`（回第一页），
 *   同一组筛选条件翻页照常。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      // GY-R71：取消事务要写统一台账，故 lockSql 现在带回 owner/media 三列（台账 target_id /
      // entity_revision）。夹具照真表补上这三列 —— 缺了它们取消路径会 fail-closed 抛 503。
      owner_user_id: makeUuid(921),
      media_id: makeUuid(931),
      media_revision: 2,
      state: 'failed',
      deadline_at: '2026-10-12T01:00:00.000Z',
      created_at: '2026-10-12T00:03:00.000Z',
      updated_at: '2026-10-12T00:03:00.000Z',
      error_code: 'PROVIDER_TIMEOUT',
    },
  ],
  'public.recognition_jobs': [
    {
      id: makeUuid(902),
      revision: 1,
      recognition_id: makeUuid(912),
      owner_user_id: makeUuid(922),
      media_id: makeUuid(932),
      media_revision: 4,
      state: 'queued',
      deadline_at: '2026-10-12T01:00:00.000Z',
      created_at: '2026-10-12T00:02:00.000Z',
      updated_at: '2026-10-12T00:02:00.000Z',
      error_code: null,
    },
  ],
  'public.speech_jobs': [
    {
      id: makeUuid(903),
      revision: 1,
      transcription_id: makeUuid(913),
      owner_user_id: makeUuid(923),
      media_id: makeUuid(933),
      media_revision: 1,
      state: 'running',
      deadline_at: '2026-10-12T01:00:00.000Z',
      created_at: '2026-10-12T00:01:00.000Z',
      updated_at: '2026-10-12T00:01:00.000Z',
      error_code: null,
    },
  ],
};

/** 语句命中的是哪张域表 → 哪个作业源 kind（cast 期望按 kind 查）。 */
const KIND_BY_TABLE = {
  'public.ocr_jobs': 'ocr',
  'public.recognition_jobs': 'recognition',
  'public.speech_jobs': 'transcription',
};

/** 语句里出现的是哪张域表（三源语句各不相同，故可反查）。 */
function tableOf(text) {
  const table = Object.keys(KIND_BY_TABLE).find((candidate) => text.includes(candidate));
  if (table === undefined) throw new Error(`语句不来自任何已知域表：${text}`);
  return table;
}

function kindOf(text) {
  return KIND_BY_TABLE[tableOf(text)];
}

/** 该源的 WHERE 片段表（导出的 `listWhere` 与运行时同一函数现算，见 jobs-pg.ts）。 */
function fragmentsOf(kind) {
  const entry = ADMIN_JOB_SQL.listWhere.find((candidate) => candidate.kind === kind);
  if (entry === undefined) throw new Error(`ADMIN_JOB_SQL.listWhere 缺 ${kind} 源`);
  return entry;
}

/** 语句里出现的是哪种 WHERE 组合（顺序重要：组合片段包含单条件片段）。 */
function whereKind(text) {
  const fragments = fragmentsOf(kindOf(text)).where;
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
      // `getSql` 的形状（`WHERE j.id = $1::uuid`）：按 id 定位单行，别拿 `$1` 当 LIMIT 截断。
      if (text.includes('WHERE j.id = $1::uuid')) {
        return { rows: rowsByTable[table].filter((row) => row.id === values[0]) };
      }
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

test('list(state)：三源各自按真实列类型拼 WHERE（ocr ⇒ ::text，枚举源 ⇒ ::job_state）', async () => {
  const pool = fakePool();
  const jobs = await portWith(pool).list({ state: 'failed' });

  assert.equal(pool.calls.length, 3, '三张域表各一次查询');
  for (const call of pool.calls) {
    const kind = kindOf(call.text);
    const cast = kind === 'ocr' ? 'text' : 'job_state';
    assert.ok(
      call.text.includes(` WHERE state = $2::${cast}`),
      `${kind} 源的 state 条件必须按真实列类型下推（::${cast}）：${call.text}`,
    );
    assert.ok(call.text.endsWith(' ORDER BY j.created_at DESC, j.id DESC LIMIT $1::integer'));
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

test('list(state + error_code)：两个条件按 $2/$3 顺序绑定，state 的 cast 仍逐源区分', async () => {
  const pool = fakePool();
  const jobs = await portWith(pool).list({ state: 'failed', error_code: 'PROVIDER_TIMEOUT' });

  for (const call of pool.calls) {
    const kind = kindOf(call.text);
    const cast = kind === 'ocr' ? 'text' : 'job_state';
    assert.ok(
      call.text.includes(` WHERE state = $2::${cast} AND error_code = $3::text`),
      `${kind} 源的两个条件必须同时下推且 cast 正确（::${cast}）：${call.text}`,
    );
    assert.deepEqual(call.values, [ADMIN_JOB_LIST_LIMIT, 'failed', 'PROVIDER_TIMEOUT']);
    assert.equal(call.text.includes('failed'), false);
    assert.equal(call.text.includes('PROVIDER_TIMEOUT'), false);
  }
  assert.deepEqual(jobs.map((job) => job.id), [makeUuid(901)]);
});

test('逐源 cast 钉子：枚举源绝不出现 state = $2::text（挡住「改回统一 ::text」的回归）', async () => {
  // 三种组合 × 三个源全扫一遍：真库 42883 的触发条件就是「枚举列配 text 参数」。
  for (const filter of [{ state: 'failed' }, { state: 'running', error_code: 'PROVIDER_TIMEOUT' }]) {
    const pool = fakePool();
    await portWith(pool).list(filter);
    assert.equal(pool.calls.length, 3);
    for (const call of pool.calls) {
      const kind = kindOf(call.text);
      const isEnumSource = kind === 'recognition' || kind === 'transcription';
      if (isEnumSource) {
        assert.equal(
          call.text.includes('state = $2::text'),
          false,
          `${kind}.state 是 job_state 枚举，写 ::text 会 42883 ⇒ 500：${call.text}`,
        );
        assert.ok(
          call.text.includes('state = $2::job_state'),
          `${kind}.state 必须显式转成 job_state：${call.text}`,
        );
      } else {
        assert.equal(
          call.text.includes('state = $2::job_state'),
          false,
          `ocr_jobs.state 是 text+CHECK，不该转成枚举：${call.text}`,
        );
        assert.ok(call.text.includes('state = $2::text'), `ocr_jobs.state 按文本比：${call.text}`);
      }
      // 枚举源与文本源都不许把 state 值拼进语句（否则闭集校验就白做了）。
      assert.equal(call.text.includes(filter.state), false);
    }
  }

  // 导出的片段表也要逐源正确：它由运行时同一函数现算，改统一 ::text 会先在这里红。
  assert.deepEqual(
    ADMIN_JOB_SQL.listWhere.map((entry) => [entry.kind, entry.stateCast]),
    [
      ['ocr', 'text'],
      ['recognition', 'job_state'],
      ['transcription', 'job_state'],
    ],
    'state 的 cast 必须按源区分（0024:93-95 是 text+CHECK，0025:117 / 0026:98 是 job_state 枚举）',
  );
  for (const entry of ADMIN_JOB_SQL.listWhere) {
    const cast = entry.stateCast;
    assert.deepEqual(entry.where, {
      state: ` WHERE state = $2::${cast}`,
      error_code: ' WHERE error_code = $2::text',
      state_and_error_code: ` WHERE state = $2::${cast} AND error_code = $3::text`,
    });
  }
});

test('list() 不传过滤：语句与 ADMIN_JOB_SQL.list 逐字相同（无 WHERE）、绑定只有 [limit]', async () => {
  const pool = fakePool();
  const jobs = await portWith(pool).list();

  // 与 `ADMIN_JOB_SQL.list`（"无过滤时的列表语句"）逐字比对：拼段（listSelect + where + listTail）
  // 不会多吐一个空 `WHERE`，也不会在无过滤时悄悄换成另一条语句。
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

test('契约闭集就是判定依据：JOB_STATES 七值全收、闭集外全拒；ERROR_CODES 全收（数目与契约枚举双边相等）', async () => {
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
  // 错误码闭集不钉死条数：与契约 `components.schemas.ErrorCode.enum` **双边**对拍
  // （集合相等 ⇒ 条数自然相等；单侧 `assert.equal(ERROR_CODES.length, N)` 会在契约加码后永久绿）。
  const contractEnum = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'))
    .components.schemas.ErrorCode.enum;
  assert.ok(contractEnum.length > 0, 'packages/contracts/openapi.json 里读不到 ErrorCode.enum');
  assert.deepEqual(
    [...ERROR_CODES].sort(),
    [...contractEnum].sort(),
    `jobs 列表过滤接受的错误码闭集必须与契约 ErrorCode 枚举逐项相等：代码 ${ERROR_CODES.length} / 契约 ${contractEnum.length}`,
  );
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

// ---------------------------------------------------------------------------
// 4. target_ref.revision：真实来源 = 记录表的 revision（LEFT JOIN），不是恒 1 占位
// ---------------------------------------------------------------------------

/**
 * 一条 **succeeded** 作业 + 它的记录行（真实形状）。
 *
 * 为什么必须是 `succeeded`：记录行只由终态事务那一笔写入（`ocr/store-pg.ts:597` 的
 * `commitTerminal`），所以「记录存在」蕴含「作业已到终态」——两者不能各说各话。
 * `revision: 3` 是作业的状态迁移计数，`target_revision: 4` 是记录被校正三次后的版本，
 * **两条时钟故意取不同值**：写死 1 的占位实现在这条种子上必然红。
 */
const SUCCEEDED_OCR_JOB = {
  id: makeUuid(921),
  revision: 3,
  ocr_id: makeUuid(931),
  state: 'succeeded',
  deadline_at: '2026-10-12T05:00:00.000Z',
  created_at: '2026-10-12T00:04:00.000Z',
  error_code: null,
  target_revision: 4,
};

/** 三源的库行：ocr 是「已产出记录」的 succeeded，另两条是「记录尚未创建」的非终态。 */
function rowsWithRecordRevision(ocrRow = {}) {
  return {
    'public.ocr_jobs': [{ ...SUCCEEDED_OCR_JOB, ...ocrRow }],
    'public.recognition_jobs': [
      { ...ROWS_BY_TABLE['public.recognition_jobs'][0], target_revision: null },
    ],
    'public.speech_jobs': [{ ...ROWS_BY_TABLE['public.speech_jobs'][0], target_revision: null }],
  };
}

/** #589 起取消端口要带审计入参（`AdminJobCancelAuditInput`）：本臂只借它走进真实取消路径。 */
const CANCEL_AUDIT = { actorId: makeUuid(941), reasonCode: 'job_cancelled', requestId: makeUuid(942) };

/** 取消面的假池：事务外的读面同 `fakePool`，`connect()` 给出记调用的假事务客户端。 */
function cancelPool(rowsByTable, updatedRowsByTable) {
  const base = fakePool(rowsByTable);
  const clientCalls = [];
  const client = {
    released: false,
    async query(text, values = []) {
      clientCalls.push({ text, values: [...values] });
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text) || /^SET LOCAL\b/i.test(text)) {
        return { rows: [] };
      }
      // #589 的取消审计调用（`CANCEL_AUDIT_SQL`，`SELECT public.record_admin_job_cancel_audit(…)`）：
      // 它没有 `FROM`、不碰任何作业/记录表，假池只要回一个 uuid 回执即可。
      if (text.includes('INSERT INTO public.jobs')) {
        // GY-R71：取消事务里的统一台账 upsert（`services/api/src/jobs/ledger.ts`）。假池只回"写成功"：
        // 台账行的**形状**由 tests/unit/jobs-ledger-mapping.test.mjs 逐格断言、真库由
        // tests/integration/jobs-ledger-pg.mjs 断言，这里不重复第三遍。
        return { rows: [] };
      }
      if (text.includes('record_admin_job_cancel_audit')) {
        return { rows: [{ audit_event_id: makeUuid(943) }] };
      }
      const table = Object.keys(rowsByTable).find((candidate) => text.includes(candidate));
      if (table === undefined) throw new Error(`假池不认识这条语句：${text}`);
      if (/^\s*UPDATE\b/i.test(text)) {
        return { rows: updatedRowsByTable[table] ?? [] };
      }
      // `lockSql`：按 id 定位（三源按顺序试，命中的那一条就是来源）。
      return { rows: rowsByTable[table].filter((row) => row.id === values[0]) };
    },
    release() {
      client.released = true;
    },
  };
  return { calls: base.calls, clientCalls, client, query: base.query, connect: async () => client };
}

test('list：记录已存在 ⇒ target_ref.revision 取记录行真实版本（≠ 作业行的 revision）', async () => {
  const pool = fakePool(rowsWithRecordRevision());
  const jobs = await portWith(pool).list();

  // created_at DESC：succeeded ocr(00:04) → queued recognition(00:02) → running speech(00:01)。
  assert.deepEqual(
    jobs.map((job) => [job.kind, job.target_ref.revision]),
    [
      ['ocr', 4],
      ['recognition', 1],
      ['transcription', 1],
    ],
    '有记录的作业必须透出记录行的真实 revision；没记录的退回初始值 1',
  );
  // 两条时钟互不冒充：作业行 revision 是 3，目标记录版本是 4。
  assert.equal(jobs[0].revision, 3, '作业行 revision 必须原样是状态迁移计数');
  assert.equal(jobs[0].target_ref.revision, 4, 'target_ref.revision 必须来自记录表');
  // 目标 id/type 与作业的产出记录一致（本片不动这两个字段）。
  assert.deepEqual(jobs[0].target_ref, { type: 'ocr', id: makeUuid(931), revision: 4 });
});

test('list：记录尚未创建（LEFT JOIN 无匹配）⇒ 1（记录行初始版本），不是 0 也不是 null', async () => {
  const pool = fakePool(); // 种子行不带 target_revision：模拟三张记录表零行
  const jobs = await portWith(pool).list();
  assert.deepEqual(jobs.map((job) => job.target_ref.revision), [1, 1, 1]);
});

test('get：单条读面同一条 JOIN 口径，透出记录真实版本', async () => {
  const pool = fakePool(rowsWithRecordRevision());
  const job = await portWith(pool).get(makeUuid(921));
  assert.deepEqual(job.target_ref, { type: 'ocr', id: makeUuid(931), revision: 4 });
  assert.ok(
    pool.calls[0].text.includes('LEFT JOIN public.ocr_records AS r ON r.id = j.ocr_id'),
    `get 语句必须走同一条 JOIN：${pool.calls[0].text}`,
  );
});

test('库里读出非法记录版本（0 / 2.5 / "4" / -1）⇒ 503，不折算成 1、不夹到下限', async () => {
  for (const bogus of [0, 2.5, '4', -1]) {
    const pool = fakePool(rowsWithRecordRevision({ target_revision: bogus }));
    const error = await expectApiError(() => portWith(pool).list(), 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503, `非法记录版本必须是 503（不是静默改值）：${String(bogus)}`);
    assert.equal(error.message.includes('目标记录 revision'), true, `实际消息：${error.message}`);
  }
});

test('SQL 钉子：三源 list/get 用 LEFT JOIN 取 r.revision；⛔ 不许退成 INNER JOIN 或标量子查询', () => {
  const expected = [
    ['public.ocr_jobs', 'public.ocr_records', 'j.ocr_id'],
    ['public.recognition_jobs', 'public.recognition_records', 'j.recognition_id'],
    ['public.speech_jobs', 'public.transcriptions', 'j.transcription_id'],
  ];
  for (const [index, [jobTable, recordTable, joinKey]] of expected.entries()) {
    for (const sql of [ADMIN_JOB_SQL.list[index], ADMIN_JOB_SQL.get[index]]) {
      assert.ok(
        sql.includes(`FROM ${jobTable} AS j LEFT JOIN ${recordTable} AS r ON r.id = ${joinKey}`),
        `语句必须 LEFT JOIN 记录表（INNER 会让排队中的作业整条消失）：${sql}`,
      );
      assert.ok(sql.includes('r.revision AS target_revision'), sql);
      assert.equal(/\bINNER\s+JOIN\b/i.test(sql), false, sql);
      // 标量子查询会被静态列审计当成列名（`ocr_records` 会变成 `ocr_jobs` 的列）⇒ 必红。
      assert.equal(sql.includes('(SELECT'), false, sql);
    }
  }
  // 取消面故意不读记录表：可被取消的作业必然还没有记录（记录只由终态事务写）。
  for (const sql of [...ADMIN_JOB_SQL.lock, ...ADMIN_JOB_SQL.update]) {
    assert.equal(sql.includes('JOIN'), false, sql);
    assert.equal(sql.includes('target_revision'), false, sql);
  }
});

test('取消面：回传的 target_ref 与取消前全等，只有 revision 迁移 +1（service.ts:801-818 的硬要求）', async () => {
  const queued = { ...ROWS_BY_TABLE['public.recognition_jobs'][0], target_revision: null };
  const pool = cancelPool(
    { ...rowsWithRecordRevision(), 'public.recognition_jobs': [queued] },
    { 'public.recognition_jobs': [{ ...queued, revision: 2, state: 'cancelled' }] },
  );
  const port = portWith(pool);

  const before = await port.get(queued.id);
  assert.deepEqual(before.target_ref, { type: 'recognition', id: queued.recognition_id, revision: 1 });

  const outcome = await port.cancel(queued.id, 1, CANCEL_AUDIT);
  assert.equal(outcome.ok, true);
  // service.ts:801-808：取消前后 target_ref 的 type / id / revision 必须完全一致。
  assert.deepEqual(outcome.job.target_ref, before.target_ref, 'target_ref 三字段取消前后必须全等');
  // service.ts:818：作业行自己的 revision 必须正好 +1。
  assert.equal(outcome.job.revision, before.revision + 1);
  assert.equal(outcome.job.state, 'cancelled');
  assert.equal(
    pool.clientCalls.some((call) => call.text.includes('target_revision')),
    false,
    '取消事务（lock/update）不得读记录表：记录只由终态事务写，可被取消的作业必然还没有记录',
  );
  // 两条时钟互不冒充：#589 的取消审计写进 `target_ref.revision` 的是**作业** revision（取消前 1），
  // 而本片 `AdminJob.target_ref.revision` 是**记录**版本 —— 同一笔取消里两个数各走各的。
  const auditCall = pool.clientCalls.find((call) =>
    call.text.includes('record_admin_job_cancel_audit'),
  );
  assert.ok(auditCall, '取消事务里必须调用 #589 的审计函数（本片不改它的签名与迁移）');
  assert.deepEqual(
    auditCall.values,
    [CANCEL_AUDIT.actorId, queued.id, 1, CANCEL_AUDIT.reasonCode, CANCEL_AUDIT.requestId],
    'p_job_revision 必须是取消前的作业 revision（1），不是记录版本、也不是取消后的 2',
  );
  assert.equal(pool.client.released, true, '事务客户端必须 release');
});

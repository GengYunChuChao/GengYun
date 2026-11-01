/**
 * W36 钉子：`public.conversation_turns` 作为**第 4 个作业源**接进运维台读面。
 *
 * 本文件只做一件事：把「问答作业在 `/admin/jobs` 里可见、可取消」这句话拆成可执行断言（T1–T8）。
 * 全是**静态读 + 假池**，不需要真 PG（本机绑不上 127.0.0.1，真库读数由 tests/integration/** 覆盖）：
 *   T1 读面可见：`ADMIN_JOB_SQL` 的四组语句都多出 answer 源，且它的 WHERE 换列名（轮次表没有 `state` 列）。
 *   T2 单条读面：按 `j.job_id = $1::uuid` 命中（`0013_conversations.sql:92` 的唯一索引）。
 *   T3 updateSql 逐字镜像域内 `cancelTurnJob`（`conversations/store-pg.ts:413-416`）。
 *   T4 视图映射：`target_ref.revision` **不**取作业行的 revision（恒 1 占位，见 `jobs-pg.ts:443`）。
 *   T5 台账映射：走 `ledgerRowFromTurn`，绑定值与它逐格相等（`job_state` / `revision` 取取消后的行）。
 *   T6 头注释 4–9 行改真话：缺口句消失、四源全接。
 *   T7 parity：同一笔取消在运维台与域内落成**同样三列**（谓词按角色不同，别混）。
 *   T8 静态列审计的逐文件计数器与本文件的源数自洽（`sql-column-coverage.test.mjs`）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ADMIN_JOB_LIST_LIMIT,
  ADMIN_JOB_SQL,
  createPostgresAdminJobPort,
} from '../../services/api/src/admin/ops/jobs-pg.ts';
import {
  JOB_LEDGER_UPSERT_SQL,
  ledgerParams,
  ledgerRowFromTurn,
} from '../../services/api/src/jobs/ledger.ts';
import { makeUuid } from './admin-ops-fixtures.mjs';

const jobsPgText = readFileSync(
  new URL('../../services/api/src/admin/ops/jobs-pg.ts', import.meta.url),
  'utf8',
);
const storePgText = readFileSync(
  new URL('../../services/api/src/conversations/store-pg.ts', import.meta.url),
  'utf8',
);
const coverageText = readFileSync(new URL('./sql-column-coverage.test.mjs', import.meta.url), 'utf8');

/** `ALL_SOURCES` 的顺序是「三张域表 + answer」：既有三源的 index 本片不动（锚点行号靠它稳定）。 */
const ANSWER_INDEX = 3;

/**
 * 一条轮次行的**投影形状**（列名照 `ANSWER_SOURCE.lockSql` 的别名）。
 *
 * 注意三个 id 各就各位：`id` 是**作业** id（`j.job_id`），`record_id` 是**轮次** id（`j.id`）。
 * 本表没有 `media_id` / `media_revision`（0013:63-78 就没有这两列）—— 取消路径因此不能拿域内那套
 * 三列守卫去要求它。
 */
const TURN = {
  id: makeUuid(904),
  revision: 1,
  record_id: makeUuid(914),
  owner_user_id: makeUuid(924),
  state: 'queued',
  deadline_at: '2026-10-12T01:00:00.000Z',
  created_at: '2026-10-12T00:00:30.000Z',
  updated_at: '2026-10-12T00:00:30.000Z',
  error_code: null,
};

/** 取消事务里的假事务客户端所回的那一行（`revision + 1`、`job_state = 'cancelled'`、`job_error_code = NULL`）。 */
const TURN_CANCELLED = {
  ...TURN,
  revision: 2,
  state: 'cancelled',
  updated_at: '2026-10-12T00:00:31.000Z',
};

const CANCEL_AUDIT = { actorId: makeUuid(941), reasonCode: 'job_cancelled', requestId: makeUuid(942) };

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

const portWith = (pool) => createPostgresAdminJobPort({ pool, limit: ADMIN_JOB_LIST_LIMIT });

/** 读面假池：只认轮次表那一条，其余三源一律零行（`get` 逐源试，命中的那一条就是来源）。 */
function readPool(rows) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values: [...values] });
      return { rows: text.includes('public.conversation_turns') ? rows : [] };
    },
    async connect() {
      throw new Error('读面不该开事务');
    },
  };
}

/** 取消面假池：`lock` 只命中轮次表，`UPDATE` 回取消后的那一行，台账/审计只回执。 */
function cancelPool() {
  const clientCalls = [];
  const client = {
    released: false,
    async query(text, values = []) {
      clientCalls.push({ text, values: [...values] });
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text) || /^SET LOCAL\b/i.test(text)) {
        return { rows: [] };
      }
      if (text.includes('record_admin_job_cancel_audit')) {
        return { rows: [{ audit_event_id: makeUuid(943) }] };
      }
      if (text.includes('INSERT INTO public.jobs')) {
        return { rows: [] };
      }
      if (/^\s*UPDATE\b/i.test(text)) {
        return { rows: [TURN_CANCELLED] };
      }
      if (text.includes('public.conversation_turns') && /\bFOR UPDATE\b/i.test(text)) {
        return { rows: [TURN] };
      }
      return { rows: [] };
    },
    release() {
      this.released = true;
    },
  };
  return {
    clientCalls,
    client,
    // 取消前的 `get`（事务外读面）也要能命中轮次表：返回取消**前**的那一行。
    async query(text) {
      return { rows: text.includes('public.conversation_turns') ? [TURN] : [] };
    },
    connect: async () => client,
  };
}

/** 从源码里切一段语句（`store-pg.ts` 那边是模板字面量，切出来带反引号，比较前统一 collapse）。 */
function statementOf(text, from, to) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(from));
  assert.ok(start >= 0, `源码里找不到起点 \`${from}\``);
  const end = lines.findIndex((line, index) => index > start && line.includes(to));
  assert.ok(end > start, `源码里找不到终点 \`${to}\``);
  return lines.slice(start, end + 1).join('\n');
}

/** `SET … WHERE` 之间的赋值清单（剥空白后切逗号）。 */
function setClauseOf(sql) {
  const match = /SET\s+([\s\S]+?)\s+WHERE\s+/i.exec(collapse(sql));
  assert.ok(match, `语句里找不到 SET … WHERE：${sql}`);
  return match[1];
}

const assignmentsOf = (sql) =>
  setClauseOf(sql)
    .split(',')
    .map((part) => part.trim());

// ---------------------------------------------------------------------------
// T1 读面可见
// ---------------------------------------------------------------------------

test('T1 读面可见：ADMIN_JOB_SQL 四组语句都含 answer 源，state 过滤换列名（轮次表没有 state 列）', () => {
  assert.equal(ADMIN_JOB_SQL.list.length, 4, '读面必须是四源（三张域表 + conversation_turns）');
  assert.equal(ADMIN_JOB_SQL.listWhere.length, 4);
  assert.equal(ADMIN_JOB_SQL.get.length, 4);
  assert.equal(ADMIN_JOB_SQL.lock.length, 4);
  assert.equal(ADMIN_JOB_SQL.update.length, 4);

  assert.deepEqual(
    ADMIN_JOB_SQL.listWhere.map((entry) => [entry.kind, entry.stateCast]),
    [
      ['ocr', 'text'],
      ['recognition', 'job_state'],
      ['transcription', 'job_state'],
      ['answer', 'text'],
    ],
    'answer 的 job_state 是 varchar(20) + CHECK（0013:71-72），不是枚举列 ⇒ 按文本比',
  );

  const answer = ADMIN_JOB_SQL.listWhere[ANSWER_INDEX];
  assert.equal(answer.kind, 'answer');
  // ⛔ 不能只把 cast 换成 ::text：`WHERE` 里的 `state` 是**输出别名**，PG 不认（42703）。
  // 轮次表的真实列叫 `job_state` / `job_error_code`（0013:71-75），过滤片段必须跟着换列名。
  assert.deepEqual(
    answer.where,
    {
      state: ' WHERE job_state = $2::text',
      error_code: ' WHERE job_error_code = $2::text',
      state_and_error_code: ' WHERE job_state = $2::text AND job_error_code = $3::text',
    },
    'answer 源的过滤片段必须用 job_ 前缀的真实列',
  );

  for (const sql of [ADMIN_JOB_SQL.list[ANSWER_INDEX], ADMIN_JOB_SQL.get[ANSWER_INDEX]]) {
    assert.ok(sql.includes('FROM public.conversation_turns j'), sql);
    assert.ok(sql.includes('j.job_id AS id'), '作业 id 是轮次的 job_id（GET /jobs/{id} 认的那个）');
    assert.ok(sql.includes('j.id AS record_id'), '轮次主键必须投影成 record_id（它本来就叫 id）');
    // ⛔ 不 JOIN conversation_answers：answer 行不投影 target_revision，让 :443 退回 1 占位；
    // 一旦投影，service.ts 的逐字段比对会看到 target_ref.revision 变化 ⇒ portIntegrityFailure 503。
    assert.equal(/\bJOIN\b/i.test(sql), false, `不许 JOIN：${sql}`);
    assert.equal(sql.includes('target_revision'), false, `不许投影 target_revision：${sql}`);
  }
  assert.ok(
    ADMIN_JOB_SQL.list[ANSWER_INDEX].endsWith(
      ' ORDER BY j.job_created_at DESC, j.id DESC LIMIT $1::integer',
    ),
    ADMIN_JOB_SQL.list[ANSWER_INDEX],
  );
});

// ---------------------------------------------------------------------------
// T2 单条读面
// ---------------------------------------------------------------------------

test('T2 单条读面：按 j.job_id = $1::uuid 命中（唯一索引 0013:92），绑定只有作业 id', async () => {
  const pool = readPool([TURN]);
  const job = await portWith(pool).get(TURN.id);

  assert.equal(pool.calls.length, 4, '四源各试一次，answer 是第 4 次');
  const call = pool.calls[ANSWER_INDEX];
  assert.ok(call.text.includes('public.conversation_turns'), call.text);
  assert.ok(
    call.text.includes('FROM public.conversation_turns j WHERE j.job_id = $1::uuid'),
    `单条读面必须按 job_id 定位（conversation_turns_job_id_key）：${call.text}`,
  );
  assert.deepEqual(call.values, [TURN.id], '绑定只有作业 id');
  assert.equal(/\bJOIN\b/i.test(call.text), false);
  assert.equal(call.text.includes('target_revision'), false);
  assert.equal(job.id, TURN.id);
  assert.equal(job.kind, 'answer');
});

// ---------------------------------------------------------------------------
// T3 updateSql 镜像域内取消（逐字）
// ---------------------------------------------------------------------------

test('T3 answer.updateSql 的 SET 与 IN 谓词逐字镜像域内取消语句（store-pg.ts 末尾的 CANCEL_TURN_JOB_SQL）', () => {
  // GY-R72 W37 把这条 SQL 从 `cancelTurnJob` 函数体搬进了文件末尾的命名常量（零位移）：切段起点跟着改，
  // 断言一个字没动 —— 仍比「同一笔取消在两侧落成同一组 SET」。
  const domain = statementOf(storePgText, 'const CANCEL_TURN_JOB_SQL', 'RETURNING ${TURN_COLUMNS}');
  const ops = ADMIN_JOB_SQL.update[ANSWER_INDEX];

  assert.equal(
    setClauseOf(ops),
    setClauseOf(domain),
    'SET 子句必须与域内那一条逐字同形（归并空白后比）：取消落地的那三列不能各写各的',
  );
  assert.ok(ops.includes("SET job_state = 'cancelled', job_error_code = NULL, revision = revision + 1, updated_at = now()"), ops);
  // 逗号后带空格 —— 与 store-pg.ts:415 逐字一致（其余三源是 `('queued','running')`，本片不动它们）。
  assert.ok(ops.includes("job_state IN ('queued', 'running')"), ops);
  assert.ok(storePgText.includes("job_state IN ('queued', 'running')"), '域内谓词的字面量变了，两侧必须同步');
});

// ---------------------------------------------------------------------------
// T4 视图映射
// ---------------------------------------------------------------------------

test('T4 视图映射：kind=answer、result=null、target_ref.revision 恒 1（不取作业行 revision）', async () => {
  // 故意取 revision 7：`target_ref.revision` 若跟着它走，这里立刻红。
  const pool = readPool([{ ...TURN, revision: 7 }]);
  const job = await portWith(pool).get(TURN.id);

  assert.equal(job.kind, 'answer');
  assert.equal(job.revision, 7, '作业行的 revision 原样透出（状态迁移计数）');
  assert.deepEqual(
    job.target_ref,
    { type: 'answer', id: TURN.record_id, revision: 1 },
    'target_ref = {轮次 id, revision 1}：不 JOIN 回答表、不投影 target_revision ⇒ 退回 UNCREATED_RECORD_REVISION',
  );
  assert.equal(
    job.target_ref.revision === job.revision,
    false,
    '目标记录版本与作业 revision 是两条时钟，不许互相冒充',
  );
  assert.equal(job.result, null);
});

// ---------------------------------------------------------------------------
// T5 台账映射
// ---------------------------------------------------------------------------

test('T5 台账映射：走 ledgerRowFromTurn，绑定值逐格相等（job_state / revision 取取消后的行）', async () => {
  const pool = cancelPool();
  const port = portWith(pool);

  const before = await port.get(TURN.id);
  assert.equal(before.kind, 'answer');

  const outcome = await port.cancel(TURN.id, 1, CANCEL_AUDIT);
  assert.equal(outcome.ok, true);
  // 取消面的硬要求（service.ts）：target_ref 全等、作业 revision 正好 +1。
  assert.deepEqual(outcome.job.target_ref, before.target_ref);
  assert.equal(outcome.job.revision, before.revision + 1);
  assert.equal(outcome.job.state, 'cancelled');

  const insertCall = pool.clientCalls.find((call) => call.text.includes('INSERT INTO public.jobs'));
  assert.ok(insertCall, '取消事务必须写统一台账（同一个事务，不能只是域内那一笔）');
  assert.equal(
    collapse(insertCall.text),
    collapse(JOB_LEDGER_UPSERT_SQL),
    '台账写入必须走唯一那条 upsert（jobs/ledger.ts:268-281）',
  );
  assert.deepEqual(
    insertCall.values,
    ledgerParams(
      ledgerRowFromTurn({
        id: TURN.record_id,
        revision: TURN_CANCELLED.revision,
        owner_id: TURN.owner_user_id,
        job_id: TURN.id,
        job_state: TURN_CANCELLED.state,
        job_deadline_at: new Date(TURN.deadline_at),
        job_created_at: new Date(TURN.created_at),
        job_error_code: null,
        answer_id: null,
        updated_at: new Date(TURN_CANCELLED.updated_at),
      }),
    ),
    '台账行必须由 ledgerRowFromTurn 生成：job_state / revision 取取消后的行，answer_id 恒 null',
  );
  // 逐项点名（deepEqual 红了也能一眼看出是哪一格串了）：
  const values = insertCall.values;
  assert.equal(values[0], TURN.id, '$1 台账主键 = 作业 id（轮次的 job_id）');
  assert.equal(values[2], 'answer', '$3 kind');
  assert.equal(values[3], 'conversation_turn', '$4 target_type');
  assert.equal(values[4], TURN.record_id, '$5 target_id = 轮次 id');
  assert.equal(values[7], 'cancelled', '$8 state 取 updated.state（lock 行还是 queued）');
  assert.equal(values[8], TURN_CANCELLED.revision, '$9 revision 取 updated.revision');
  assert.equal(values[11], null, '$12 result_ref = answer_id（未产出）');
  assert.equal(pool.client.released, true);
});

// ---------------------------------------------------------------------------
// T6 头注释
// ---------------------------------------------------------------------------

test('T6 头注释 4–9 行改真话：四源全接，缺口句（不可见／不可取消）消失', () => {
  const lines = jobsPgText.split('\n');
  const start = lines.findIndex((line) => line.includes('## 为什么读域内作业表'));
  assert.ok(start >= 0, '`## 为什么读域内作业表` 这段不见了（标题被改回三张或删了？）');
  const end = lines.findIndex((line, index) => index > start && line.trim() === '*');
  assert.ok(end > start, '这段的段尾（单独一个 ` *`）不见了');

  // 段边界必须仍是 4–9 行：docs/architecture/ai-ops-spec-status.md:134 与 T1b 都按这个区间引它。
  assert.equal(start + 1, 4, '这一段的起始行必须仍是第 4 行');
  assert.equal(end, 9, '段尾 ` *` 必须仍落在第 10 行 ⇒ 内容行仍恰是 4–9 行');

  const section = lines.slice(start, end).join('\n');
  assert.equal(/不可见|不可取消/.test(section), false, '缺口句必须删掉（四源已全接）');
  assert.ok(section.includes('四源'), section);
  assert.ok(section.includes('public.conversation_turns'), '要指名第 4 张域表');
  // 台账那条 upsert 语句字面量刻意不进注释（tests/unit/ai-ops-ledger-pins.test.mjs 钉子①）。
  assert.equal(section.includes('INSERT INTO public.jobs'), false, section);
});

// ---------------------------------------------------------------------------
// T7 parity（运维台 vs 域内）
// ---------------------------------------------------------------------------

test('T7 parity：同一笔取消在两侧落成同样三列，谓词按角色不同但都得挡已结算作业', () => {
  const ops = ADMIN_JOB_SQL.update[ANSWER_INDEX];
  // 同上：域内取消语句现在住在文件末尾的 `CANCEL_TURN_JOB_SQL` 常量里（GY-R72 W37 零位移搬移）。
  const domain = statementOf(storePgText, 'const CANCEL_TURN_JOB_SQL', 'RETURNING ${TURN_COLUMNS}');

  // 三列同形：job_state / job_error_code / revision（`updated_at` 是时钟，单独留着不算）。
  assert.deepEqual(
    assignmentsOf(ops).slice(0, 3),
    assignmentsOf(domain).slice(0, 3),
    '运维台取消与域内 cancelTurnJob 必须把同样三列改成同样的值',
  );

  // 谓词按角色不同，但「只动未结算作业」这一条两边都必须有（否则会被 settleTurnJob 覆盖）。
  assert.ok(ops.includes("job_state IN ('queued', 'running')"), ops);
  assert.ok(domain.includes("job_state IN ('queued', 'running')"), domain);
  // 运维台的并发保护是 expectedRevision CAS（AdminJobPort 的契约）。
  assert.ok(ops.includes('WHERE job_id = $1::uuid AND revision = $2::integer'), ops);
  // 域内的保护是 owner 授权（HTTP 侧已过 owner，SQL 再挡一次的既有写法）；它没有 revision CAS。
  assert.ok(domain.includes('owner_id = $2::uuid'), domain);
  assert.equal(
    domain.includes('revision = $2::integer'),
    false,
    '域内 cancelTurnJob 不按 revision CAS —— 这是现状，本片不改它（诚实边界）',
  );
});

// ---------------------------------------------------------------------------
// T8 静态列审计计数器自洽
// ---------------------------------------------------------------------------

test('T8 静态列审计的逐文件计数器与本文件源数自洽（四源 × 四条 + 审计一条）', () => {
  const match = /'admin\/ops\/jobs-pg\.ts': (\d+),/.exec(coverageText);
  assert.ok(match, 'sql-column-coverage.test.mjs 里找不到 `admin/ops/jobs-pg.ts` 的逐文件计数');
  assert.equal(
    Number(match[1]),
    ADMIN_JOB_SQL.list.length * 4 + 1,
    'ADDITIONAL_SQL_HOST_FILES 的逐文件读数必须跟着源数走（4 源 × list/get/lock/update + CANCEL_AUDIT_SQL）',
  );
});

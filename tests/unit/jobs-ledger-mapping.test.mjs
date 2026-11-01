/**
 * GY-R71 · 统一作业台账（`public.jobs`）的**映射矩阵**单测：六源 × 五态，逐格断言。
 *
 * ## 这一层在证明什么
 * 台账行的每一个字段都是**状态机与源的事实**，不是常量：`kind` 随源、`state`/`revision` 随迁移、
 * `target_*` 随输入对象、`result_ref` 随产出行。单测直接把「源 × 态」的每一格求出来比对，
 * 而不是在测试里重写一份 `switch`（那会与生产代码各写一份映射，漂移了也测不出来 —— 生产侧
 * 唯一的取行口就是 `ledgerRowForSource`）。
 *
 * ## 六源的命名（两个名字体系，别混）
 * 用户口径的 **speech** 在契约 `JobKind` 里叫 **transcription**（域目录叫 `speech`，kind 叫
 * `transcription`）；六源在契约里是 `recognition / ocr / transcription / answer / synthesis /
 * moderation`（`services/api/src/admin/ops/types.ts` 的 `JOB_KINDS`，与 `packages/contracts/openapi.json`
 * 的 `AdminJob.kind` 同值）。本文件在矩阵标签里写「speech(transcription)」，在断言里用契约值。
 *
 * ## 五态是哪五个
 * 创建 / 开始 / 成功 / 失败 / 取消 = `queued` / `running` / `succeeded` / `failed` / `cancelled`。
 * 契约闭集还有 `timed_out` / `uncertain` 两态，矩阵之后另有**一整条**用例把七态全覆盖
 * （五态矩阵是派单要求的最小面，七态是"别让闭集里剩下的两个值没人管"）。
 *
 * ## 未接的两个源怎么"逐格断言"
 * `moderation` / `synthesis` 没有可落库的作业行（理由登记在 `UNWIRED_SOURCES_REASON`），
 * 所以它们的五格断言是「取不到台账行（`null`）+ 理由非空」。⛔ 不写成 `assert.fail('TODO')`：
 * 那会让"没接"与"接坏了"长得一样。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  JOB_LEDGER_UPSERT_SQL,
  UNWIRED_SOURCES_REASON,
  assertJobState,
  ledgerInputHash,
  ledgerParams,
  ledgerRowForSource,
  ledgerRowFromTurn,
} from '../../services/api/src/jobs/ledger.ts';
import { JOB_KINDS } from '../../services/api/src/admin/ops/types.ts';

/** 稳定 uuid（`makeUuid` 式，便于在失败信息里一眼认出是哪一格的哪一列）。 */
function uuid(prefix, n) {
  const tail = String(n).padStart(12, '0');
  return `${prefix}0000-0000-4000-8000-${tail}`;
}

const OWNER = uuid('1111', 1);
const MEDIA = uuid('2222', 2);
const RECORD = uuid('3333', 3);

/** 五态 → 该态在域内的 `revision`（状态迁移计数：创建 1、开始 2、三个终态 3）。 */
const FIVE_STATES = Object.freeze([
  { state: 'queued', revision: 1, step: '创建' },
  { state: 'running', revision: 2, step: '开始' },
  { state: 'succeeded', revision: 3, step: '成功' },
  { state: 'failed', revision: 3, step: '失败' },
  { state: 'cancelled', revision: 3, step: '取消' },
]);

/** 六源：四源已接、两源未接（未接的两个在矩阵里断言 `null` + 已登记理由）。 */
const SOURCES = Object.freeze([
  { key: 'ocr', label: 'ocr', wired: true, kind: 'ocr', targetType: 'media' },
  { key: 'recognition', label: 'recognition', wired: true, kind: 'recognition', targetType: 'media' },
  { key: 'transcription', label: 'speech(transcription)', wired: true, kind: 'transcription', targetType: 'media' },
  { key: 'answer', label: 'answer', wired: true, kind: 'answer', targetType: 'conversation_turn' },
  { key: 'synthesis', label: 'synthesis', wired: false },
  { key: 'moderation', label: 'moderation', wired: false },
]);

const AT = new Date('2026-10-30T01:00:00.000Z');
const DEADLINE = new Date('2026-10-30T01:00:30.000Z');

/** 域内三源作业行夹具（列名差异只在 `记录 id` 那一列，映射函数统一吃 `resultRef`）。 */
function domainJob(source, state, revision) {
  return {
    id: uuid('aaaa', revision + 10),
    revision,
    kind: source,
    ownerUserId: OWNER,
    state,
    deadlineAt: DEADLINE,
    createdAt: AT,
    updatedAt: AT,
    errorCode: state === 'failed' ? 'PROVIDER_TIMEOUT' : null,
    mediaId: MEDIA,
    mediaRevision: 4,
  };
}

/** 会话轮次行夹具（answer 源：作业 id 在 `job_id`、目标在轮次 `id`、产出在 `answer_id`）。 */
function turnJob(state, revision) {
  return {
    id: uuid('bbbb', revision + 20),
    revision,
    owner_id: OWNER,
    job_id: uuid('cccc', revision + 30),
    job_state: state,
    job_deadline_at: DEADLINE,
    job_created_at: AT,
    job_error_code: state === 'failed' ? 'PROVIDER_OUTCOME_UNKNOWN' : null,
    answer_id: state === 'succeeded' ? RECORD : null,
    updated_at: AT,
  };
}

/** 独立重算 `input_hash`（⛔ 不调用生产函数：那样"两边一起错"也会绿）。 */
function expectedHash({ kind, targetType, targetId, entityRevision }) {
  const canonical = [kind, targetType, targetId, String(entityRevision)].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

test('矩阵：六源 × 五态逐格断言（已接四源给行、未接两源给 null + 理由）', () => {
  const seen = [];
  for (const source of SOURCES) {
    for (const { state, revision, step } of FIVE_STATES) {
      const cell = `${source.label} × ${state}(${step})`;
      const input = source.key === 'answer'
        ? { turn: turnJob(state, revision) }
        : { job: domainJob(source.key, state, revision), resultRef: RECORD };
      const row = ledgerRowForSource(source.key, input);

      if (!source.wired) {
        assert.equal(row, null, `${cell}：未接台账的源不得产出任何台账行（⛔ 不许造一行占位）`);
        assert.ok(
          (UNWIRED_SOURCES_REASON[source.key] ?? '').length >= 20,
          `${cell}：未接源必须在 UNWIRED_SOURCES_REASON 里写明理由`,
        );
        seen.push({ cell, row: 'null（未接：' + UNWIRED_SOURCES_REASON[source.key].slice(0, 18) + '…）' });
        continue;
      }

      assert.notEqual(row, null, `${cell}：已接源必须产出台账行`);
      // ① 身份：台账主键 = 作业 id（answer 源取轮次的 `job_id`），属主原样透传。
      assert.equal(row.kind, source.kind, `${cell}：kind 必须等于该源在契约里的取值`);
      assert.equal(row.state, state, `${cell}：state 必须原样透传（⛔ 不许写成固定值）`);
      assert.equal(row.revision, revision, `${cell}：revision 必须是域内那一刻的真实迁移计数`);
      // ② 目标：作业的**输入对象**（媒体 / 轮次），不是产出行。
      assert.equal(row.targetType, source.targetType, `${cell}：target_type 随源固定`);
      assert.equal(row.ownerId, OWNER, `${cell}：owner_id 必须透传（jobs_single_actor 靠它）`);
      // ③ input_hash：48+16 位十六进制，且等于独立重算值。
      assert.equal(row.inputHash.length, 64, `${cell}：input_hash 必须是 char(64) 长度`);
      assert.equal(
        row.inputHash,
        expectedHash({
          kind: source.kind,
          targetType: source.targetType,
          targetId: row.targetId,
          entityRevision: row.entityRevision,
        }),
        `${cell}：input_hash 必须是对"输入身份四元组"的 sha256（独立重算不一致说明口径漂了）`,
      );

      if (source.key === 'answer') {
        const turn = turnJob(state, revision);
        assert.equal(row.id, turn.job_id, `${cell}：answer 的台账主键是**作业 id**（job_id），不是轮次 id`);
        assert.equal(row.targetId, turn.id, `${cell}：answer 的 target_id 是轮次 id`);
        assert.equal(row.entityRevision, turn.revision, `${cell}：answer 的 entity_revision 是轮次 revision`);
        assert.equal(row.resultRef, turn.answer_id, `${cell}：answer 的 result_ref 是回答 id（未产出时 null）`);
        assert.equal(row.errorCode, turn.job_error_code, `${cell}：answer 的 error_code 透传`);
      } else {
        const job = domainJob(source.key, state, revision);
        assert.equal(row.id, job.id, `${cell}：台账主键是域内作业行 id`);
        assert.equal(row.targetId, MEDIA, `${cell}：媒体域三源的 target_id 是 media_id`);
        assert.equal(row.entityRevision, 4, `${cell}：entity_revision 是 media_revision`);
        assert.equal(row.resultRef, RECORD, `${cell}：result_ref 是域内预分配的产出行 id`);
        assert.equal(row.errorCode, job.errorCode, `${cell}：error_code 透传（成功/取消为 null）`);
      }

      // ④ 绑定值：与 SQL 的 `$1..$14` 逐个对齐（顺序错位＝把 owner 写进 kind 这类事故）。
      const params = ledgerParams(row);
      assert.equal(params.length, 14, `${cell}：绑定值必须恰 14 个（SQL 的 $1..$14）`);
      assert.deepEqual(
        params,
        [
          row.id, row.ownerId, row.kind, row.targetType, row.targetId, row.entityRevision, row.inputHash,
          row.state, row.revision, row.deadlineAt, row.errorCode, row.resultRef, row.createdAt, row.updatedAt,
        ],
        `${cell}：绑定值顺序必须与 JOB_LEDGER_UPSERT_SQL 的 $1..$14 一致`,
      );
      seen.push({ cell, row: `${row.kind}/${row.state}/rev=${row.revision}/ref=${row.resultRef ?? 'null'}` });
    }
  }
  // 30 格全过一遍（6 源 × 5 态）：数量本身也是判据，防止循环被条件跳过。
  assert.equal(seen.length, 30, `矩阵必须走满 6 × 5 = 30 格，实际 ${seen.length} 格`);
  for (const item of seen) console.log(`[jobs-ledger-matrix] ${item.cell} ⇒ ${item.row}`);
});

test('矩阵补充：契约七态全覆盖（含 timed_out / uncertain），且 state 与 revision 不脱钩', () => {
  const contractStates = JSON.parse(
    // 契约真源：闭集七值，顺序也是契约顺序。
    '["queued","running","succeeded","uncertain","failed","timed_out","cancelled"]',
  );
  const revisions = {
    queued: 1,
    running: 2,
    succeeded: 3,
    uncertain: 3,
    failed: 3,
    timed_out: 3,
    cancelled: 3,
  };
  for (const state of contractStates) {
    const row = ledgerRowForSource('ocr', { job: domainJob('ocr', state, revisions[state]), resultRef: RECORD });
    assert.equal(row.state, state);
    assert.equal(row.revision, revisions[state], `${state}：台账 revision 必须跟着域内迁移走`);
    // 同一格的 state 换掉、revision 不动 ⇒ 行必须真的变了（反过来说明 state 没被写死）。
    if (state !== 'queued') {
      const other = ledgerRowForSource('ocr', { job: domainJob('ocr', 'queued', revisions[state]), resultRef: RECORD });
      assert.notEqual(other.state, row.state, `${state}：换 state 后台账行必须跟着变（否则 state 是常量）`);
      assert.equal(other.revision, row.revision, '同一 revision 下换 state 只应改 state 一列');
    }
  }
});

test('源闭集：四源已接 + 两源未接 === 契约 JOB_KINDS（不重不漏）', () => {
  const wired = SOURCES.filter((source) => source.wired).map((source) => source.kind);
  const unwired = Object.keys(UNWIRED_SOURCES_REASON);
  assert.deepEqual(
    [...wired, ...unwired].sort(),
    [...JOB_KINDS].sort(),
    '已接 + 未接的源必须恰好等于契约 JobKind 闭集：多一个（接了个不存在的源）或少一个（悄悄漏掉一个源）都必须红',
  );
  assert.equal(new Set([...wired, ...unwired]).size, JOB_KINDS.length, '源清单不得有重复项');
});

test('幂等与失败面：同输入同映射；陌生状态/源必须抛错而不是静默吞掉', () => {
  const job = domainJob('ocr', 'running', 2);
  const first = ledgerRowForSource('ocr', { job, resultRef: RECORD });
  const second = ledgerRowForSource('ocr', { job, resultRef: RECORD });
  assert.deepEqual(first, second, '同一输入必须产出同一条台账行（幂等的前提：映射本身无随机量）');
  // 输入对象换版本 ⇒ input_hash 必须换（否则"同一输入"的判据形同虚设）。
  const bumped = ledgerRowForSource('ocr', { job: { ...job, mediaRevision: 5 }, resultRef: RECORD });
  assert.notEqual(bumped.inputHash, first.inputHash, '输入对象换版本后 input_hash 必须变');
  // 状态闭集外：⛔ 不许静默写成某个"合法"值。
  assert.throws(() => assertJobState('done'), /不在契约 JobState 闭集内/);
  // 陌生源：⛔ 不许静默返回 null（那会让"拼错源名"看起来像"这个源本来就没接"）。
  assert.throws(() => ledgerRowForSource('ocrr', { job }), /台账不认识/);
  // 缺输入：⛔ 不许拿空值凑一行。
  assert.throws(() => ledgerRowForSource('answer', {}), /缺 turn 输入/);
  assert.throws(() => ledgerRowForSource('ocr', {}), /缺 job 输入/);
  // 源与 kind 不符（把识别行当 OCR 写）：⛔ 必须抛错。
  assert.throws(
    () => ledgerRowForSource('ocr', { job: domainJob('recognition', 'queued', 1), resultRef: RECORD }),
    /kind 与作业源不符/,
  );
});

test('语句形状：$1..$14 与绑定值一一对应，且台账列只写 15 列', () => {
  const placeholders = [...JOB_LEDGER_UPSERT_SQL.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(
    [...new Set(placeholders)].sort((a, b) => a - b),
    Array.from({ length: 14 }, (_, index) => index + 1),
    'SQL 的占位符必须恰是 $1..$14（少一个＝某列永远写不到，多一个＝绑定值错位）',
  );
  // `$2`（owner）在语句里出现两次（`owner_id` 与 `auth_epoch` 子查询），绑定值仍只传一次。
  assert.equal(placeholders.filter((value) => value === 2).length, 2, 'owner 必须在 owner_id 与 auth_epoch 子查询里各用一次');
  assert.equal(new Set(placeholders).size, 14);
  const insertColumns = /INSERT INTO public\.jobs\s*\(([\s\S]*?)\)\s*VALUES/.exec(JOB_LEDGER_UPSERT_SQL);
  assert.ok(insertColumns !== null, '语句的列清单形状变了：本断言与静态列审计都靠它取列');
  const columns = insertColumns[1].split(',').map((column) => column.trim());
  assert.equal(columns.length, 15, `台账 INSERT 必须显式写 15 列，实际 ${columns.length} 列`);
  assert.deepEqual(columns, [
    'id', 'owner_id', 'kind', 'target_type', 'target_id', 'entity_revision', 'input_hash',
    'auth_epoch', 'state', 'revision', 'deadline_at', 'error_code', 'result_ref', 'created_at', 'updated_at',
  ], '列顺序变了：绑定值按位置对齐，列序一动就是全表错位');
});

test('轮次入口：ledgerRowFromTurn 与统一入口同形（answer 源只有一个构造路径）', () => {
  const turn = turnJob('succeeded', 3);
  assert.deepEqual(ledgerRowFromTurn(turn), ledgerRowForSource('answer', { turn }));
  assert.equal(ledgerInputHash({ kind: 'answer', targetType: 'conversation_turn', targetId: turn.id, entityRevision: turn.revision }).length, 64);
});

/**
 * 接线钉子（静态）：**哪个文件该有几处 `writeJobLedger`**。
 *
 * 为什么需要它：上面那些用例证明的是「映射对了」，证明不了「**每个**状态迁移都真的调了映射」——
 * 删掉某域 `commitTerminal` 里那一行，映射矩阵照样全绿，而那份台账从此不再随终态前进。
 * 所以这里把"每域三处（创建 / 开始或取消 / 终态）+ 管理台取消一处"写成**精确读数**（answer 域自 GY-R72 起是**四处**：`cancelTurnJob` 的取消也是终态迁移、与 `settleTurnJob` 不同路径 ⇒ 单独一个写点）：
 * 少一处（漏接）或多一处（多接了个没想清楚的路径）都必须红。
 *
 * 域内三源的 `updateJob` 是**一个**写点覆盖两种迁移（`running` 与 `cancelled`），所以是 3 处而不是 4 处；
 * 这一句写在这里，免得下一个人按状态数去数。
 */
const WIRING_READINGS = Object.freeze([
  ['services/api/src/ocr/store-pg.ts', 3, 'insertJob（queued）/ updateJob（running、cancelled）/ commitTerminal（终态）'],
  ['services/api/src/recognitions/store-pg.ts', 3, '同 ocr：三个写点一个不少'],
  ['services/api/src/speech/store-pg.ts', 3, '同 ocr：三个写点一个不少'],
  ['services/api/src/conversations/store-pg.ts', 4, 'insertTurn（queued）/ claimTurnJob（running）/ cancelTurnJob（cancelled）/ settleTurnJob（终态）'],
  ['services/api/src/admin/ops/jobs-pg.ts', 1, '管理台取消（同一事务里，紧跟审计写入）'],
]);

test('接线钉子：每个写点都必须真的调用一次（漏一源/漏一处即红）', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const readings = [];
  for (const [file, expected, what] of WIRING_READINGS) {
    const text = readFileSync(`${root}${file}`, 'utf8');
    const actual = [...text.matchAll(/writeJobLedger\(/g)].length;
    assert.equal(
      actual,
      expected,
      `${file} 的 writeJobLedger 调用数是 ${actual}，应为 ${expected}（${what}）：`
        + '少一处＝那条状态迁移不再进台账（台账静默落后于域内表），多一处＝多了一个没人复核的写点',
    );
    readings.push(`${file} = ${actual}`);
  }
  // 每个域的映射调用必须带**自己的**源键（把 recognition 写成 ocr 会让 kind 整列错）。
  const sourceKeyByFile = Object.freeze([
    ['services/api/src/ocr/store-pg.ts', "ledgerRowFromDomainJob('ocr'"],
    ['services/api/src/recognitions/store-pg.ts', "ledgerRowFromDomainJob('recognition'"],
    ['services/api/src/speech/store-pg.ts', "ledgerRowFromDomainJob('transcription'"],
    ['services/api/src/conversations/store-pg.ts', 'ledgerRowFromTurn('],
    ['services/api/src/admin/ops/jobs-pg.ts', 'ledgerRowFromDomainJob('],
  ]);
  for (const [file, needle] of sourceKeyByFile) {
    const text = readFileSync(`${root}${file}`, 'utf8');
    assert.ok(text.includes(needle), `${file} 里找不到 \`${needle}\`：映射入口被换掉或源键写错了`);
  }
  console.log(`[jobs-ledger-wiring] ${readings.join('；')}`);
});

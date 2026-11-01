/**
 * 钉线：`getJob` 台账 blocker 的 answer 读面与审核台账两处口径必须与基线代码事实一致（R72／W49 状态真话化片）。
 *
 * ## 为什么要有这条
 *
 * `docs/architecture/contract-status.json:737`（`getJob`，`status` = `partial`）的 `blocker` 长期含两句
 * 已经**失真**的断言：
 *
 * 1. 「⇒ 经该路径读取 answer 作业现可返回契约 Job 与 error_code（**真值来自入库快照**，绝不凭空升级为
 *    succeeded）」——「真值只来自入库快照」这半句在 GY-R72（#814）之后不再完整：answer 的读面现在**会写库**。
 *    `services/api/src/conversations/service.ts:1097` 的 `findByJobId` 只有一句
 *    `return adjudicateExpiredAnswerJob(store, now, input.userId, input.jobId);`，而同文件
 *    `:1391-1418` 的 `adjudicateExpiredAnswerJob` 在 `isDeadlineExpired(...)`（`services/api/src/jobs/expiry.ts:38-43`，
 *    宽限 5 秒、判据**含等号**）成立且作业仍 `queued/running` 时调
 *    `store.settleTurnJob({ ..., state: 'timed_out', errorCode: 'PROVIDER_TIMEOUT', answer: null, at })`；
 *    落库走 `services/api/src/conversations/store-pg.ts:423` 的 `settleTurnJob`，
 *    `:429-435` 的 `UPDATE ... set job_state = $3, job_error_code = $4, revision = revision + 1 ... WHERE ... job_state IN ('queued', 'running')`
 *    ——一次 CAS、`revision` 恰好 +1。所以「读面只读、真值只来自入库快照」是**不完整**的：读面自己也会写一条新快照。
 *    但「**绝不凭空升级为 succeeded**」这半句**仍然真**（最坏只降级成 `timed_out`，且该路径一律 `answer: null`
 *    ⇒ 投影 `result` 恒 `null`），所以订正只改前半句的绝对化，不推翻后半句。
 * 2. 「审核任务的持久队列与租约仍待接线（**本片为内存台账**）」——「本片为内存台账」这半句**已假**：
 *    审核台账的**写面**早在 0028 落 PG（`services/api/db/migrations/0028_moderation_persistence.sql` 建了
 *    `public.moderation_decisions` 与 `public.moderation_withdrawals`；`services/api/src/app.ts:954` 装配
 *    `createPostgresModerationLedger({ pool })`，只有 `pool === null` 才退回内存台账），GY-R72（#824/#825）又让
 *    下架集合在发布前跨进程回填（`services/api/src/moderation/ledger-pg.ts:189` 的 `HYDRATE_WITHDRAWALS_SQL`，
 *    在 `flush()` 里 `await hydrate()`）。“仍待接线”的范围因此必须收窄到两件**确实**还缺的事：作业**结论**
 *    读面不回填（`services/api/src/moderation/ledger-pg.ts:465` 的 `byJobId` 仍只答本进程内存里的结论）、
 *    **租约与队列**仍未持久化（0028 里没有 `moderation_jobs` 表）。
 *
 * 也就是说：**错的是台账文字，不是代码，也不是断言**。本片只订正 `blocker` 文字，**不**动 `status`
 * （`partial` 照旧：真实 tms/ims 未授权、real 整域 fail-closed、租约与队列未持久化都还在）。
 *
 * ## 红了怎么办（先判哪一侧错，别改断言凑绿）
 *
 * - T1 红：`blocker` 里 answer 读面那半句要么被改回「真值来自入库快照」的绝对化表述，要么丢了
 *   `timed_out`／`succeeded` 的语义。改 JSON，⛔ 不要改断言。
 * - T2 红：审核台账那半句要么被改回「本片为内存台账」，要么把「结论不回填／租约与队列未持久化」这两件
 *   确实还缺的事一起删了（那是**过度声称**，与 T1 方向相反的红）。
 * - T3 红：`docs/architecture/contract-implementation-status.md` 的镜像行与 JSON 不一致 —— 改 JSON 后跑
 *   `node tools/verify-contract-status.mjs --write-doc` 让它**渲染**出 md（⛔ 不许只手改 md，下一次
 *   `--write-doc` 会把手改冲掉；也⛔ 不许改断言）。
 * - T4 红：说明**代码**变了（`createPostgresModerationLedger` 装配被摘、下架集合回填被删、
 *   `adjudicateExpiredAnswerJob` 读面裁定被拔）。那时要判断的是台账该写什么，别改这条测试去迎合代码；
 *   若确属代码回退，本条按红灯上报。
 * - T5 红：`services/api/src/jobs/ledger.ts` 的「只写不读」表述被删了 —— 那是 public.jobs 台账（与审核台账
 *   无关）的既有事实，本片不许顺手改动它。
 *
 * 本文件只读文件文本、不 import 任何服务代码（不建池、不连 PG、不起 HTTP）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATUS_JSON = join(ROOT, 'docs/architecture/contract-status.json');
const STATUS_MD = join(ROOT, 'docs/architecture/contract-implementation-status.md');
const APP_TS = join(ROOT, 'services/api/src/app.ts');
const LEDGER_PG_TS = join(ROOT, 'services/api/src/moderation/ledger-pg.ts');
const CONVERSATIONS_SERVICE_TS = join(ROOT, 'services/api/src/conversations/service.ts');
const JOBS_LEDGER_TS = join(ROOT, 'services/api/src/jobs/ledger.ts');

const read = (path) => readFileSync(path, 'utf8');

/** 台账里的 `getJob` 条目（找不到就红：操作被改名/删除属于本片判据失效）。 */
function getJobOperation() {
  const operations = JSON.parse(read(STATUS_JSON)).operations;
  const operation = operations.find((entry) => entry.id === 'getJob');
  assert.ok(operation, 'docs/architecture/contract-status.json 里找不到 id=getJob 的条目（操作被改名/删除？）');
  return operation;
}

/** 表格单元文本 → 与 JSON 字符串可比的形式：还原 `\|` 转义、压平空白、去首尾空白。 */
const normalizeCell = (cell) => cell.replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();

/** 中文对照表里 `getJob` 那一行（必须恰好 1 行、5 列）。 */
function renderedGetJobRow() {
  const rows = read(STATUS_MD)
    .split('\n')
    .filter((line) => line.startsWith('| `getJob` |'));
  assert.equal(rows.length, 1, `docs/architecture/contract-implementation-status.md 里 getJob 行数应为 1，实际 ${rows.length}`);
  const cells = rows[0].replace(/^\|/, '').replace(/\|$/, '').split('|');
  assert.equal(cells.length, 5, `getJob 行应为 5 列（操作／路径／状态／证据／缺口），实际 ${cells.length} 列`);
  return { statusCell: normalizeCell(cells[2]), blocker: normalizeCell(cells[4]) };
}

test('T1 answer 读面：说清「读面自己也会写一条新快照」，但不再绝对化且不推翻「绝不凭空升级为 succeeded」', () => {
  const { blocker, status } = getJobOperation();
  assert.equal(typeof blocker, 'string', 'getJob.blocker 必须是字符串');
  assert.ok(blocker.length > 0, 'getJob.blocker 不能为空');
  // 单行：blocker 是一行 JSON 字符串，换行会把渲染出的表格行拆开（行数漂移）。
  assert.ok(!/[\r\n]/.test(blocker), 'getJob.blocker 不许含换行（必须保持单行，否则中文对照表行数漂移）');
  // 竖线会被渲染成 `\|`，就不再与 JSON 逐字相等（T3 的前提）。
  assert.ok(!blocker.includes('|'), 'getJob.blocker 不许含竖线（渲染会转义成 `\\|`，破坏「JSON 与镜像逐字相等」）');
  // 旧绝对化表述必须消失。
  assert.ok(
    !blocker.includes('真值来自入库快照'),
    `getJob.blocker 仍写着「真值来自入库快照」（services/api/src/conversations/service.ts:1097 起读面会写库，已不完整）：${blocker}`,
  );
  // 两处语义都在：读面裁定的落点 timed_out，以及「不升级」这一侧 succeeded。
  assert.ok(blocker.includes('timed_out'), 'getJob.blocker 缺少 answer 读面裁定落点 timed_out（过期作业就地裁定写库）');
  assert.ok(blocker.includes('succeeded'), 'getJob.blocker 缺少「不凭空升级为 succeeded」这一侧的语义');
  // 新事实的落点：裁定函数与 CAS 写库。
  assert.ok(
    blocker.includes('adjudicateExpiredAnswerJob'),
    'getJob.blocker 缺少 adjudicateExpiredAnswerJob（answer 读面就地裁定的实现）',
  );
  assert.ok(
    blocker.includes('JOB_EXPIRY_GRACE_MS'),
    'getJob.blocker 缺少 JOB_EXPIRY_GRACE_MS（裁定判据的 5 秒宽限常量）',
  );
  // 状态不许被顺手改掉：本片只订正文字。
  assert.equal(status, 'partial', `getJob.status 仍应是 partial（本片只订正 blocker 文字），实际 ${status}`);
});

test('T2 审核台账：写面已落 PG（0028），只剩「结论读面不回填」与「租约/队列未持久化」两件真缺口', () => {
  const { blocker } = getJobOperation();
  // 旧谎言必须消失。
  assert.ok(
    !blocker.includes('本片为内存台账'),
    `getJob.blocker 仍写着「本片为内存台账」（与 services/api/src/app.ts:954 的 createPostgresModerationLedger({ pool }) 装配相反）：${blocker}`,
  );
  // 写面已落库的证据（工厂装配 与 迁移号，任一即可，这里两样都要）。
  assert.ok(
    blocker.includes('createPostgresModerationLedger'),
    'getJob.blocker 缺少 createPostgresModerationLedger（审核台账落 PG 的装配点）',
  );
  assert.ok(blocker.includes('0028'), 'getJob.blocker 缺少迁移号 0028（moderation_decisions／moderation_withdrawals 落库的出处）');
  assert.ok(
    blocker.includes('HYDRATE_WITHDRAWALS_SQL'),
    'getJob.blocker 缺少 HYDRATE_WITHDRAWALS_SQL（下架集合跨进程回填的证据）',
  );
  // 反向要求：不许过度声称——两件真缺口必须留着。
  assert.match(
    blocker,
    /结论[^；]{0,40}(不回填|仍不回填)|byJobId[^；]{0,30}(内存|不回填)/,
    'getJob.blocker 删掉了「作业结论读面不回填」这一真缺口（过度声称）',
  );
  assert.match(
    blocker,
    /租约[^；]{0,20}队列[^；]{0,20}(未持久化|仍待接线)|队列[^；]{0,20}租约[^；]{0,20}(未持久化|仍待接线)|moderation_jobs/,
    'getJob.blocker 删掉了「租约与队列仍未持久化」这一真缺口（过度声称）',
  );
});

test('T3 中文对照表那一行逐字等于 JSON blocker（镜像只许由工具渲染）', () => {
  const { blocker } = getJobOperation();
  const { statusCell, blocker: rendered } = renderedGetJobRow();
  assert.equal(statusCell, '`partial`', '对照表里 getJob 状态列应是 `partial`，实际 ' + statusCell);
  assert.equal(
    rendered,
    normalizeCell(blocker),
    'docs/architecture/contract-implementation-status.md 的 getJob 行 blocker 与 JSON 不一致 —— 改 JSON 后跑 node tools/verify-contract-status.mjs --write-doc 渲染，⛔ 不许手改 md、也不许改断言',
  );
  // 更严的一条：blocker 不含竖线/换行时，镜像里必须**整段逐字**出现（不只是规范化后相等）。
  assert.ok(
    read(STATUS_MD).includes(blocker),
    'blocker 未在 docs/architecture/contract-implementation-status.md 里逐字出现（镜像被手改或渲染转义了？）',
  );
});

test('T4 代码事实钉子：审核台账真落 PG、下架集合真回填、answer 读面真会写库', () => {
  const app = read(APP_TS);
  const ledgerPg = read(LEDGER_PG_TS);
  const conversationsService = read(CONVERSATIONS_SERVICE_TS);

  // ① 审核台账装配到 PG 工厂（只有无池才退回内存台账）。
  assert.ok(
    app.includes('createPostgresModerationLedger({ pool })'),
    'services/api/src/app.ts 里没有 createPostgresModerationLedger({ pool }) 装配（审核台账落库被摘掉？）',
  );
  assert.ok(
    /pool === null \? \{\} : \{ store: createPostgresModerationLedger\(\{ pool \}\) \}/.test(app),
    'services/api/src/app.ts 里「无池 ⇒ 内存台账／有池 ⇒ PG 台账」的条件装配形态变了',
  );

  // ② 下架集合跨进程回填。
  assert.ok(
    ledgerPg.includes('HYDRATE_WITHDRAWALS_SQL'),
    'services/api/src/moderation/ledger-pg.ts 里没有 HYDRATE_WITHDRAWALS_SQL（下架集合回填被删？）',
  );
  assert.ok(
    /await hydrate\(\);/.test(ledgerPg),
    'services/api/src/moderation/ledger-pg.ts 里没有 await hydrate() 调用（回填不再发生？）',
  );
  // ③ 结论读面仍只答内存（这正是不许删的真缺口）。
  assert.ok(
    /byJobId: \(jobId\) => inner\.byJobId\(jobId\)/.test(ledgerPg),
    'services/api/src/moderation/ledger-pg.ts 的 byJobId 委托形态变了（结论读面若不回填这一缺口已变，需人工复核台账口径）',
  );

  // ④ answer 读面：findByJobId 转就地裁定。
  assert.ok(
    conversationsService.includes('adjudicateExpiredAnswerJob'),
    'services/api/src/conversations/service.ts 里没有 adjudicateExpiredAnswerJob（answer 读面就地裁定被拔？）',
  );
  assert.ok(
    /return adjudicateExpiredAnswerJob\(store, now, input\.userId, input\.jobId\);/.test(conversationsService),
    'services/api/src/conversations/service.ts 的 findByJobId 不再转 adjudicateExpiredAnswerJob（读面回到只读？）',
  );
  assert.ok(
    /settleTurnJob\(\{[\s\S]{0,240}state: 'timed_out'[\s\S]{0,240}errorCode: 'PROVIDER_TIMEOUT'/.test(conversationsService),
    'services/api/src/conversations/service.ts 里没有 settleTurnJob({ ... state: timed_out ... errorCode: PROVIDER_TIMEOUT ... }) 的读面写库（裁定落点变了？）',
  );
});

test('T5 作业台账「只写不读」表述仍在（public.jobs 与本片的审核台账无关，不许顺手改）', () => {
  const jobsLedger = read(JOBS_LEDGER_TS);
  assert.ok(
    jobsLedger.includes('只写不读'),
    'services/api/src/jobs/ledger.ts 的「只写不读」表述不见了 —— 那是 public.jobs 台账的既有事实，本片一个字都不该动它',
  );
  assert.ok(
    jobsLedger.includes('/admin/jobs'),
    'services/api/src/jobs/ledger.ts 里「/admin/jobs 仍读三张域内表」的说明不见了',
  );
});

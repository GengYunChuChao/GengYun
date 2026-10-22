/**
 * GY-I27（#29）第六片 · **真 PostgreSQL 17.11**：在途—撤回／注销—回写 的竞态守卫与回写诚实性。
 *
 * 运行（本机隔离集群，仅回环；库必须为空）：
 *   CREATE DATABASE gengyun_egress_revoke_race_test;
 *   EGRESS_RACE_TEST_URL='postgres://<owner>@127.0.0.1:55445/gengyun_egress_revoke_race_test' \
 *   node tests/integration/egress-revoke-race-pg.mjs
 *
 * 本脚本只用 **owner（迁移属主）** 连接：它不测最小权限（那一面由 `egress-ledger-pg.mjs` 的
 * `gengyun_egress_ledger` 覆盖），只测**竞态与守卫**；因此无需建角色，也不碰 HTTP 装配。
 *
 * 覆盖（每条都是真库行为，不是替身）：
 *   1. 回写**诚实性**：首次回写 1 行并如实报 `written:true`；同一外发的第二次回调 **0 行新写入**，
 *      如实报 `written:false, replay:true`，且**不覆盖**第一次的载荷（改前：第二次也报 written:true，
 *      并把「写了 0 行」说成「写了」）。
 *   2. **撤回已提交 ⇒ 在途结果零回写**：账本最后一道闸 `guardWriteback` 拒绝（用途 epoch 前进），
 *      `export_writebacks` **0 行**；服务层 `saveResult` 同样拒绝且 0 行。
 *   3. **不丢缝隙的交错**：写回事务已过快照校验、尚未落库时，撤回消费者与用途 epoch 事务**被行锁
 *      真实挡在门外**（`pg_stat_activity.wait_event_type='Lock'` 计数为实测值、行状态仍 sent、0 行回写），
 *      释放后回写先提交、撤回后提交（顺序由锁等待证明，时间戳仅作旁证），随后**晚到回调被拒且不增行**。
 *   4. **注销已提交 ⇒ 在途结果零回写**：state+auth_epoch 在同一事务前进后，`guardWriteback` 抛
 *      `ACCOUNT_INACTIVE`、0 行；服务层 `saveResult` 同样 0 行。
 *   5. **账号维度的交错**：注销事务同样被写回事务的 `users FOR SHARE` 挡住；放行后回写 1 行、
 *      注销提交后的晚到回调被拒且不增行。
 *
 * 不联网（除本机回环 PG）；不发任何真实第三方请求；不打印凭据。
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createPool } from '../../services/api/src/db/pool.ts';
import { createPostgresExportLedger, createPostgresPrivacyPorts } from '../../services/api/src/privacy/ledger-pg.ts';
import { createEgressRevoker, createInFlightGuard } from '../../packages/privacy/in-flight.mjs';

const url = new URL(process.env.EGRESS_RACE_TEST_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'EGRESS_RACE_TEST_URL 必须是 postgres URL');
assert.equal(url.search, '', '不接受额外连接参数');
assert.equal(url.hash, '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '只允许回环地址');
assert.equal(url.pathname, '/gengyun_egress_revoke_race_test', '只允许专用临时库');

const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};

/** 观察/断言用的只读连接（owner），与被测连接池分开，避免自己占满 max=4。 */
const scalar = async (sql, params = []) => (await owner.query(sql, params)).rows[0] ?? null;
const writebacksOf = async (exportId) =>
  Number((await scalar('SELECT count(*)::int AS n FROM public.export_writebacks WHERE export_id=$1::uuid', [exportId])).n);
const exportRow = async (exportId) =>
  scalar('SELECT state,error_code,cancelled_at,revision FROM public.exports WHERE id=$1::uuid', [exportId]);
const epochOf = async (userId, purpose) =>
  scalar('SELECT current_epoch,state FROM public.privacy_epochs WHERE user_id=$1::uuid AND purpose=$2', [userId, purpose]);
const userStateOf = async (userId) => String((await scalar('SELECT state FROM public.users WHERE id=$1::uuid', [userId])).state);
const waitingLocks = async () =>
  Number(
    (
      await scalar(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )
    ).n,
  );

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}（最后读数：${JSON.stringify(last)}）`);
}

/* ------------------------------------------------------------------ 夹具（owner 直接写库，不经 HTTP） */

const hmacKey = randomBytes(32).toString('hex');
const syntheticSubject = (code) => createHmac('sha256', hmacKey).update(`synthetic\n${code}`).digest('hex');
const RECIPIENT = 'fixture-race-weed';
const CONFIG_VERSION = 'fixture-race-config-v1';
const POLICY_VERSION = 'fixture-race-policy-v1';

async function seedUser(code) {
  const row = (
    await owner.query(
      `INSERT INTO public.users(wechat_subject_cipher, wechat_subject_lookup)
       VALUES($1, decode($2,'hex')) RETURNING id`,
      ['synthetic-subject-cipher', syntheticSubject(code)],
    )
  ).rows[0];
  return String(row.id);
}

async function seedGrant(userId, purpose) {
  await owner.query(
    `INSERT INTO public.privacy_epochs(user_id,purpose,current_epoch,state)
     VALUES($1,$2,1,'granted')
     ON CONFLICT (user_id,purpose) DO UPDATE SET current_epoch=1, state='granted'`,
    [userId, purpose],
  );
  await owner.query(
    `INSERT INTO public.consent_records(user_id,purpose,policy_version,recipient_ids,state,epoch)
     VALUES($1,$2,$3,$4::jsonb,'granted',1)
     ON CONFLICT (user_id,purpose,epoch) DO UPDATE SET state='granted', withdrawn_at=NULL`,
    [userId, purpose, POLICY_VERSION, JSON.stringify([RECIPIENT])],
  );
}

/** 一个新用户 + 三类用途授权（recording/media_processing/external_inference 覆盖 weed 数据类型的必需集）。 */
async function seedConsentedUser(code) {
  const userId = await seedUser(code);
  for (const purpose of ['recording', 'media_processing', 'external_inference']) await seedGrant(userId, purpose);
  return userId;
}

let ledger;
async function reserveAndSend(userId) {
  const record = await ledger.reserve({
    userId,
    authEpoch: 1,
    objectType: 'weed_photo',
    objectId: randomUUID(),
    objectRevision: 1,
    dataType: 'weed_recognition',
    purpose: 'external_inference',
    recipientId: RECIPIENT,
    sourceVersion: 'race-v1',
  });
  await ledger.markSent(record.id);
  return record;
}

/* ------------------------------------------------------- 可暂停连接池（在 SQL 边界上制造"不丢缝隙"时序） */

function instrumentPool(inner) {
  let armed = null;
  const wrap = (client) => ({
    async query(text, params) {
      const sql = typeof text === 'string' ? text : String(text?.text ?? '');
      if (armed && armed.match(sql)) {
        const current = armed;
        armed = null; // 只拦截一次，避免波及后续事务
        current.reached();
        await current.gate; // 暂停点：由调用方决定何时放行
      }
      return client.query(text, params);
    },
    release() {
      client.release();
    },
  });
  return {
    query: (text, params) => inner.query(text, params),
    async connect() {
      return wrap(await inner.connect());
    },
    arm(match) {
      let reached;
      let open;
      const reachedSignal = new Promise((resolve) => {
        reached = resolve;
      });
      const gate = new Promise((resolve) => {
        open = resolve;
      });
      armed = { match, reached, gate };
      return {
        async waitReached(label) {
          await Promise.race([
            reachedSignal,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`暂停点未被触达：${label}`)), 5000)),
          ]);
        },
        release: open,
      };
    },
  };
}

const isWritebackInsert = (sql) => /^\s*INSERT INTO public\.export_writebacks/.test(sql);

/* ------------------------------------------------------------------------------------- 迁移与夹具落库 */

const version = String((await scalar('SHOW server_version')).server_version);
assert.match(version, /^17\.11(?:\D|$)/, `需要 PostgreSQL 17.11，实际 ${version}`);
const existing = Number(
  (await scalar(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`)).n,
);
assert.equal(existing, 0, 'EGRESS_RACE_TEST_URL 指向的库必须为空（本脚本自己做迁移）');

for (const migration of [
  'migrations/0001_initial_schema.sql',
  'migrations/0003_privacy_consent.sql',
  'migrations/0008_auth_session.sql',
  'migrations/0009_consent_policy.sql',
  'migrations/0011_export_ledger.sql',
  'migrations/0014_export_object_key.sql',
]) {
  await owner.query(sqlFile(migration));
}
say(`真 PG ${version}：0001/0003/0008/0009/0011/0014 迁移应用完成，public 由空到就绪`);

await owner.query(
  `INSERT INTO public.recipients(id,display_name,capability,policy_version,retention_online_days,retention_backup_days,
                                 no_training_verified,deletion_verified,enabled,config_version)
   VALUES($1,'合成接收方（测试）','weed',$2,0,0,true,true,true,$3)`,
  [RECIPIENT, POLICY_VERSION, CONFIG_VERSION],
);

const realPool = createPool(url.href);
assert.ok(realPool, '连接池创建失败');
const pool = instrumentPool(realPool);
ledger = createPostgresExportLedger({ pool });
const ports = createPostgresPrivacyPorts({ pool });
const inFlight = createInFlightGuard({
  ledger,
  account: ports.account,
  consentStore: ports.consentStore,
  now: () => new Date(),
});
const revoker = createEgressRevoker({ ledger });

/* ------------------------------------------------------------------- 1. 回写诚实性：重放不得谎报写入 */

const userA = await seedConsentedUser('race-user-a');
const exportA = await reserveAndSend(userA);
{
  const first = await inFlight.saveResult({ exportId: exportA.id, userId: userA, objectVersion: 1, result: { text: '合成结果-A' } });
  assert.deepEqual(first, { written: true, exportId: exportA.id, objectVersion: 1 }, '首次回写必须如实报 written:true');
  assert.equal(await writebacksOf(exportA.id), 1, '首次回写必须恰好落 1 行');

  const replay = await inFlight.saveResult({ exportId: exportA.id, userId: userA, objectVersion: 1, result: { text: '重放的-合成结果-B' } });
  assert.deepEqual(
    replay,
    { written: false, replay: true, exportId: exportA.id, objectVersion: 1 },
    '同一外发的第二次回调：0 行新写入 ⇒ 必须如实报 written:false, replay:true',
  );
  assert.equal(await writebacksOf(exportA.id), 1, '重放不得新增回写行');
  const stored = await scalar('SELECT result FROM public.export_writebacks WHERE export_id=$1::uuid', [exportA.id]);
  assert.deepEqual(stored.result, { text: '合成结果-A' }, '重放不得覆盖第一次的载荷（第一个结果即最终结果）');

  const direct = await ledger.guardWriteback({ exportId: exportA.id, userId: userA, result: { text: '重放的-合成结果-C' } });
  assert.deepEqual(direct, { written: false, replay: true, exportId: exportA.id }, '账本层的第二次 guardWriteback 同样如实报 0 行');
  say('回写诚实性：首次 1 行 written:true；重放 0 行 written:false/replay:true 且不覆盖载荷（真库 rowCount）');
}

/* ------------------------------------------- 2. 撤回已提交 ⇒ 在途结果零回写（账本闸 + 服务层闸各一条） */

const userB = await seedConsentedUser('race-user-b');
const exportB = await reserveAndSend(userB);
{
  // 只前进用途 epoch（不触发在途撤销消费者）：记录仍在 sent，唯一能拦住回写的是账本的快照复核。
  const bumped = (
    await owner.query(
      `UPDATE public.privacy_epochs SET current_epoch=current_epoch+1, state='withdrawn', revision=revision+1
        WHERE user_id=$1::uuid AND purpose='external_inference' RETURNING current_epoch`,
      [userB],
    )
  ).rows[0];
  await owner.query(
    `UPDATE public.consent_records SET state='withdrawn', withdrawn_at=now(), revision=revision+1
      WHERE user_id=$1::uuid AND purpose='external_inference' AND epoch < $2`,
    [userB, bumped.current_epoch],
  );
  assert.equal(Number((await epochOf(userB, 'external_inference')).current_epoch), 2, '用途 epoch 已提交为 2');

  let ledgerError = null;
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: exportB.id, userId: userB, result: { text: '撤回后晚到的旧结果' } }),
    (error) => {
      ledgerError = error;
      return error?.code === 'OBJECT_UNAVAILABLE';
    },
  );
  assert.match(String(ledgerError?.message), /禁止外发/, '账本闸必须如实说明撤回/版本原因');
  assert.equal(await writebacksOf(exportB.id), 0, '撤回已提交后，账本闸必须 0 行写入');

  let serviceError = null;
  await assert.rejects(
    () => inFlight.saveResult({ exportId: exportB.id, userId: userB, objectVersion: 1, result: { text: '撤回后晚到的旧结果' } }),
    (error) => {
      serviceError = error;
      return ['CONSENT_REQUIRED', 'OBJECT_UNAVAILABLE'].includes(error?.code);
    },
  );
  assert.equal(await writebacksOf(exportB.id), 0, '撤回已提交后，服务层 saveResult 必须 0 行写入');
  assert.equal((await exportRow(exportB.id)).state, 'sent', '本条未触发在途撤销：记录仍为 sent（证明拦住它的是快照复核）');
  say(`撤回已提交 ⇒ 在途零回写：guardWriteback 抛 ${ledgerError?.code}「${ledgerError?.message}」，`
    + `saveResult 抛 ${serviceError?.code}，export_writebacks 0 行`);
}

/* ------------------------------------------------- 3. 不丢缝隙的交错：回写持锁 ⇒ 撤回被真实挡住 */

const userC = await seedConsentedUser('race-user-c');
const exportC = await reserveAndSend(userC);
{
  const pause = pool.arm(isWritebackInsert);
  const saving = inFlight.saveResult({ exportId: exportC.id, userId: userC, objectVersion: 1, result: { text: '交错中的合法结果' } });
  await pause.waitReached('写回 INSERT 之前');
  // 此刻写回事务已 lockExport（exports FOR UPDATE）+ verifySnapshot（users/privacy_epochs/recipients FOR SHARE），
  // 但 INSERT 尚未执行 ⇒ 正是「已过闸门、尚未落库」的窗口。
  assert.equal(await writebacksOf(exportC.id), 0, '暂停点处回写尚未落库');
  assert.equal((await exportRow(exportC.id)).state, 'sent', '暂停点处记录仍是在途态');

  const revoking = revoker.onConsentWithdrawn({ userId: userC, purpose: 'external_inference' });
  const bumping = (async () => {
    const client = await realPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE public.privacy_epochs SET current_epoch=current_epoch+1, state='withdrawn', revision=revision+1
          WHERE user_id=$1::uuid AND purpose='external_inference'`,
        [userC],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  })();

  const blocked = await waitFor(async () => {
    const count = await waitingLocks();
    return count >= 2 ? count : 0;
  }, '撤回消费者与 epoch 事务被行锁挡住');
  // 被挡住期间：行状态未变、零回写 ⇒ 撤回**不可能**发生在写回提交之前（顺序由锁保证，不靠时间戳）。
  assert.equal((await exportRow(exportC.id)).state, 'sent', '撤回在被挡期间不得先于回写生效');
  assert.equal(await writebacksOf(exportC.id), 0, '被挡期间仍无回写行');
  assert.equal(Number((await epochOf(userC, 'external_inference')).current_epoch), 1, '被挡期间 epoch 未前进');

  pause.release();
  const written = await saving;
  const wroteAt = Date.now();
  assert.equal(written.written, true, '放行后回写必须真的写入（此时撤回尚未提交，写入合法）');
  const revoked = await revoking;
  await bumping;
  const revokedAt = Date.now();
  assert.ok(wroteAt <= revokedAt, '顺序：回写提交时刻不晚于撤回完成时刻');
  assert.ok(Number(revoked?.revokedInFlight) >= 1, `撤回消费者必须真的撤销在途外发（实际 ${JSON.stringify(revoked)}）`);

  const final = await exportRow(exportC.id);
  assert.equal(final.state, 'failed', '撤回后外发必须置 failed');
  assert.equal(final.error_code, 'CONSENT_WITHDRAWN', '撤回后必须留 CONSENT_WITHDRAWN 证据');
  assert.equal(Number((await epochOf(userC, 'external_inference')).current_epoch), 2, '用途 epoch 前进到 2');
  assert.equal(await writebacksOf(exportC.id), 1, '交错后回写恰好 1 行（不丢、不重）');

  // 撤回提交之后的晚到回调：终态挡住，零新增。
  let late = null;
  await assert.rejects(
    () => inFlight.saveResult({ exportId: exportC.id, userId: userC, objectVersion: 1, result: { text: '撤回提交后才到的结果' } }),
    (error) => {
      late = error;
      return error?.code === 'OBJECT_UNAVAILABLE';
    },
  );
  assert.match(String(late?.message), /回写被阻断|已终态/, '晚到回调必须如实拒绝（不得复活）');
  assert.equal(await writebacksOf(exportC.id), 1, '晚到回调不得新增回写行');
  say(`不丢缝隙交错：等待锁的后端数=${blocked}（真实 pg_stat_activity），回写 t=${wroteAt} ≤ 撤回 t=${revokedAt}，`
    + `最终 failed/CONSENT_WITHDRAWN、epoch=2、回写仍 1 行、晚到回调抛 ${late?.code}`);
}

/* --------------------------------------------- 4. 注销已提交 ⇒ 在途结果零回写（账本闸 + 服务层闸） */

const userD = await seedConsentedUser('race-user-d');
const exportD = await reserveAndSend(userD);
{
  // 与 0016 request_account_deletion 同一口径的**同一事务**：state + auth_epoch 一起前进（其余副作用归 #19）。
  const client = await realPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE public.users SET state='deletion_pending', auth_epoch=auth_epoch+1, revision=revision+1 WHERE id=$1::uuid`,
      [userD],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  assert.equal(String((await scalar('SELECT auth_epoch FROM public.users WHERE id=$1::uuid', [userD])).auth_epoch), '2');
  assert.equal(await userStateOf(userD), 'deletion_pending');

  let ledgerError = null;
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: exportD.id, userId: userD, result: { text: '注销后晚到的旧结果' } }),
    (error) => {
      ledgerError = error;
      return error?.code === 'ACCOUNT_INACTIVE';
    },
  );
  assert.equal(await writebacksOf(exportD.id), 0, '注销已提交后，账本闸必须 0 行写入');

  let serviceError = null;
  await assert.rejects(
    () => inFlight.saveResult({ exportId: exportD.id, userId: userD, objectVersion: 1, result: { text: '注销后晚到的旧结果' } }),
    (error) => {
      serviceError = error;
      return error?.code === 'ACCOUNT_INACTIVE';
    },
  );
  assert.equal(await writebacksOf(exportD.id), 0, '注销已提交后，服务层 saveResult 必须 0 行写入');
  say(`注销已提交 ⇒ 在途零回写：guardWriteback 抛 ${ledgerError?.code}「${ledgerError?.message}」，`
    + `saveResult 抛 ${serviceError?.code}，export_writebacks 0 行`);
}

/* ------------------------------------- 5. 账号维度的交错：注销事务同样被写回事务的行锁挡住 */

const userE = await seedConsentedUser('race-user-e');
const exportE = await reserveAndSend(userE);
{
  const pause = pool.arm(isWritebackInsert);
  const saving = inFlight.saveResult({ exportId: exportE.id, userId: userE, objectVersion: 1, result: { text: '交错中的合法结果-2' } });
  await pause.waitReached('写回 INSERT 之前（账号维度）');

  const deleting = (async () => {
    const client = await realPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE public.users SET state='deletion_pending', auth_epoch=auth_epoch+1, revision=revision+1 WHERE id=$1::uuid`,
        [userE],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  })();

  const blocked = await waitFor(async () => {
    const count = await waitingLocks();
    return count >= 1 ? count : 0;
  }, '注销事务被写回事务的 users FOR SHARE 挡住');
  assert.equal(await userStateOf(userE), 'active', '被挡期间账号状态未变（注销不得先于回写生效）');
  assert.equal(await writebacksOf(exportE.id), 0, '被挡期间仍无回写行');

  pause.release();
  assert.equal((await saving).written, true, '放行后回写必须真的写入');
  await deleting;
  assert.equal(await userStateOf(userE), 'deletion_pending');
  assert.equal(await writebacksOf(exportE.id), 1, '交错后回写恰好 1 行');

  let late = null;
  await assert.rejects(
    () => inFlight.saveResult({ exportId: exportE.id, userId: userE, objectVersion: 1, result: { text: '注销提交后才到的结果' } }),
    (error) => {
      late = error;
      return error?.code === 'ACCOUNT_INACTIVE';
    },
  );
  assert.equal(await writebacksOf(exportE.id), 1, '注销提交后的晚到回调不得新增回写行');
  say(`账号维度交错：等待锁的后端数=${blocked}，注销被挡期间账号仍 active，放行后回写 1 行、晚到回调抛 ${late?.code}`);
}

/* ----------------------------------------------------------------------------------------------- 收尾 */

console.log(`总计 PASS ${passed} 项`);
await realPool.end();
await owner.end();
console.log('DONE: egress-revoke-race-pg 全部通过');

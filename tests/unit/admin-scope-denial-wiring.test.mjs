/**
 * `#18` S2 收尾片 PR-4 · **应用层**接线：后台 scope 操作被拒后补记留痕（迁移 `0046`）。
 *
 * 库层（`0046` 的 `public.record_admin_scope_denial` + 授权 + 最小权限清单）已经在 main 上，
 * 由 `tests/unit/admin-scope-denial-trace.test.mjs` 静态守着。本文件守的是**另一侧**：
 * 应用层到底怎么调用它 —— 那一侧只能靠假池看语句序列，真库臂看不出来。
 *
 * 三条纪律，逐条对应下面的用例（顺序即纪律编号）：
 *   0. **只有被拒才留痕**：成功路径、以及「不是被拒」的失败（`XX000`/`42501`/`42883`/`57014`/
 *      断连）一行都不许写 —— 那是服务端缺陷，冒充「被拒」会把值班引向错误的排查方向。
 *   1. **先 ROLLBACK、再 release、然后才留痕**，而且留痕必须在**另一条**新连接上以单条语句
 *      自提交。同一连接同事务里写 ⇒ 跟着 `ROLLBACK` 一起消失（负控制正是打这一点）。
 *   2. **整段吞错**：留痕失败只 `log.warn`，主响应不变 —— 403/409 绝不升 500，也绝不因此变 200。
 *
 * ⛔ 本文件不写任何 `文件:行号` 断语（行号由运行时算/不引用），避免
 * `tests/unit/test-line-anchors-guard.test.mjs` 判红；要引用证据用**函数名/语句文本**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_SCOPE_DENIAL_REASONS,
  ADMIN_SCOPE_DENIAL_SCOPE,
  RECORD_ADMIN_SCOPE_DENIAL_FUNCTION,
  denialReasonOf,
} from '../../services/api/src/admin/ops/scope-denial-trace.ts';
import { createPostgresAdminScopeAuthority } from '../../services/api/src/admin/ops/scope-authority-pg.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SIDECAR_SOURCE = 'services/api/src/admin/ops/scope-denial-trace.ts';
const AUTHORITY_SOURCE = 'services/api/src/admin/ops/scope-authority-pg.ts';
const DENIAL_MIGRATION = 'services/api/db/migrations/0046_admin_scope_denial_trace.sql';

/** 固定 uuid（形状与 `ADMIN_SCOPES` 无关；只要求过 `UUID_RE`）。 */
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR_ID = uuid(901);
const TARGET_ID = uuid(902);
const AUDIT_ID = uuid(903);
const REQUEST_ID = uuid(904);

/** 一次撤销调用的入参（`scopes:write` 上的撤销 = 本片的典型被拒场景）。 */
function revokeAction(overrides = {}) {
  return {
    actorId: ACTOR_ID,
    auditId: AUDIT_ID,
    targetId: TARGET_ID,
    scope: 'scopes:write',
    reason: '拒绝留痕接线回归',
    requestId: REQUEST_ID,
    expectedRevision: null,
    ...overrides,
  };
}

/** 0041 两条写函数返回的成功形状（`toOutcome` 认的键名）。 */
const SUCCESS_RESULT = Object.freeze({
  admin_id: TARGET_ID,
  revision: 4,
  scopes: ['accounts:read'],
  changed: true,
  audit_id: AUDIT_ID,
});

/**
 * 记账假池：每次 `connect()` 发一条**新**连接（`conn` 递增），所有事件按发生顺序入 `events`。
 *
 * `sqlState` = 主事务里那条 `SELECT public.grant/revoke_admin_scope(...)` 抛的 SQLSTATE；
 * `denial` 控制留痕那一步的行为：`'ok'`（默认）/ `'throw'`（查询抛错）/ `'connect-throw'`
 * （第二条连接的 `connect()` 本身就抛，用来证明「拿不到连接也不影响主响应」）。
 * `releaseThrows` 让**归还连接**这一步抛错（`pg` 的 `release()` 会因重复释放/池已关闭而抛），
 * 用来证明「收尾失败同样不得改写主响应」。
 */
function scriptedPool({ sqlState = 'G0009', denial = 'ok', success = false, releaseThrows = false } = {}) {
  const events = [];
  let opened = 0;
  const pool = {
    async connect() {
      opened += 1;
      const conn = opened;
      if (conn > 1 && denial === 'connect-throw') {
        events.push({ conn, phase: 'connect-throw' });
        const error = new Error('pool exhausted');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      events.push({ conn, phase: 'connect' });
      return {
        async query(text, params) {
          events.push({ conn, phase: 'query', text, params });
          if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text.startsWith('SET LOCAL')) {
            return { rows: [] };
          }
          if (text.includes(RECORD_ADMIN_SCOPE_DENIAL_FUNCTION)) {
            if (denial === 'throw') {
              const error = new Error('denial sidecar exploded');
              // ⚠ 故意用非 G 码：留痕自己失败不构成「被拒」，日志里也只该出现这个码。
              error.code = 'XX000';
              throw error;
            }
            return { rows: [{ audit_id: uuid(905) }] };
          }
          if (success) return { rows: [{ result: SUCCESS_RESULT }] };
          const error = new Error('synthetic write failure');
          error.code = sqlState;
          throw error;
        },
        release() {
          events.push({ conn, phase: 'release' });
          if (releaseThrows) {
            const error = new Error('Release called on client which has already been released to the pool');
            error.code = 'ERELEASE';
            throw error;
          }
        },
      };
    },
  };
  return { events, pool };
}

/** 只收集 `log.warn` 的日志口（形状同 `AdminScopeDenialLogPort`）。 */
function recordingLog() {
  const warns = [];
  return { warns, log: { warn(payload, message) { warns.push({ payload, message }); } } };
}

const isDenialQuery = (event) => event.phase === 'query' && event.text.includes(RECORD_ADMIN_SCOPE_DENIAL_FUNCTION);

// ---------------------------------------------------------------------------
// 纪律 1：先 ROLLBACK、再 release、再在**新连接**上单语句留痕
// ---------------------------------------------------------------------------
test('纪律 1：被拒后留痕落在 ROLLBACK 与 release 之后的**另一条**连接上，且不包事务', async () => {
  const { events, pool } = scriptedPool({ sqlState: 'G0009', denial: 'ok' });
  const authority = createPostgresAdminScopeAuthority({ pool });

  // 主响应原样：409 / LAST_SCOPE_MANAGER（留痕**成功**也不许把 409 变成 200）。
  await assert.rejects(() => authority.revoke(revokeAction()), (error) => {
    assert.equal(error.code, 'LAST_SCOPE_MANAGER');
    assert.equal(error.status, 409);
    return true;
  });

  const mainConn = events.find((event) => event.phase === 'connect').conn;
  const denialIndex = events.findIndex(isDenialQuery);
  assert.notEqual(denialIndex, -1, `被拒必须留痕：没找到 ${RECORD_ADMIN_SCOPE_DENIAL_FUNCTION} 的调用`);

  const denial = events[denialIndex];
  assert.notEqual(denial.conn, mainConn, '留痕必须在**新**连接上：同一连接上写会跟着主事务一起回滚');

  const rollbackIndex = events.findIndex((event) => event.phase === 'query' && event.text === 'ROLLBACK');
  assert.notEqual(rollbackIndex, -1, '主事务失败必须先 ROLLBACK');
  assert.ok(rollbackIndex < denialIndex, '留痕必须发生在 ROLLBACK **之后**（顺序反了就是在脏事务里写）');

  const mainReleaseIndex = events.findIndex((event) => event.phase === 'release' && event.conn === mainConn);
  assert.notEqual(mainReleaseIndex, -1, '主连接必须 release()');
  assert.ok(mainReleaseIndex < denialIndex, '留痕必须在主连接 release() **之后**：⛔ 不得占着连接做旁路写');

  // 单语句自提交：留痕那条连接上**只有**这一条 query，没有 BEGIN / COMMIT 包着。
  const denialConnQueries = events.filter((event) => event.conn === denial.conn && event.phase === 'query');
  assert.equal(denialConnQueries.length, 1, '留痕连接上只许发一条语句（多一条就意味着包了事务或做了别的事）');
  assert.ok(
    denialConnQueries[0].text.startsWith(`SELECT ${RECORD_ADMIN_SCOPE_DENIAL_FUNCTION}(`),
    `留痕语句必须直接是 SELECT ${RECORD_ADMIN_SCOPE_DENIAL_FUNCTION}(…)：实际 ${denialConnQueries[0].text.slice(0, 60)}`,
  );
  assert.equal(
    denialConnQueries.some((event) => event.text === 'BEGIN' || event.text === 'COMMIT'),
    false,
    '留痕不得包事务：被回滚的那笔与留痕必须彻底解耦',
  );
});

test('纪律 1：留痕入参口径固定 —— actor/target 来自本次请求，scope 恒 scopes:write，reason 由 SQLSTATE 映射', async () => {
  const cases = [
    ['G0008', 'self_scope_grant_denied'],
    ['G0009', 'last_scope_manager'],
    ['G0010', 'scope_denied'],
    ['G0011', 'scope_not_held'],
  ];
  for (const [sqlState, reasonCode] of cases) {
    const { events, pool } = scriptedPool({ sqlState });
    const authority = createPostgresAdminScopeAuthority({ pool });
    // G0008 只能由「授予给自己」触发，但那只是库层判据；应用层这侧四个码走同一条留痕路径，
    // 因此用同一个 grant 入参逐码驱动即可（这里证的是**映射与口径**，不是库层判据）。
    await assert.rejects(() => authority.grant(revokeAction()), (error) => typeof error.code === 'string');
    const denial = events.find(isDenialQuery);
    assert.notEqual(denial, undefined, `${sqlState} 必须留痕`);
    assert.deepEqual(
      denial.params,
      [ACTOR_ID, TARGET_ID, ADMIN_SCOPE_DENIAL_SCOPE, reasonCode, REQUEST_ID],
      `${sqlState} 的留痕入参顺序/取值不对：应为 (actor, target, 'scopes:write', reason, request_id)`,
    );
    // `p_audit_id` 不传：拒绝没有「调用方已知的审计 id」，由函数内生成。
    assert.equal(denial.params.length, 5, '不得给 p_audit_id 传值（留了指定审计 id 的缝）');
  }
});

// ---------------------------------------------------------------------------
// 纪律 2：留痕整段吞错 —— 403/409 原样返回，绝不升 500、绝不因此变 200
// ---------------------------------------------------------------------------
test('纪律 2：留痕那一步抛错 ⇒ 主响应仍是 409/403（不是 500，也不是 200），且只 warn 一次', async () => {
  const cases = [
    ['G0009', 'LAST_SCOPE_MANAGER', 409],
    ['G0008', 'SELF_SCOPE_GRANT_DENIED', 403],
    ['G0010', 'SCOPE_DENIED', 403],
    ['G0011', 'SCOPE_DENIED', 403],
  ];
  for (const [sqlState, code, status] of cases) {
    const { events, pool } = scriptedPool({ sqlState, denial: 'throw' });
    const { warns, log } = recordingLog();
    const authority = createPostgresAdminScopeAuthority({ pool, log });

    await assert.rejects(() => authority.revoke(revokeAction()), (error) => {
      assert.equal(error.code, code, `${sqlState} 的错误码必须原样，⛔ 不许被留痕失败改写成别的`);
      assert.equal(error.status, status, `${sqlState} 必须是 ${status}，⛔ 留痕失败不得升 500`);
      return true;
    });

    // 留痕**确实**被尝试过（否则这条用例证明不了吞错）。
    assert.ok(events.some(isDenialQuery), `${sqlState} 的留痕应至少被尝试一次`);
    assert.equal(warns.length, 1, '留痕失败必须 warn 恰好一次');
    const { payload, message } = warns[0];
    assert.equal(payload.sqlstate, sqlState, '日志要带主事务的 SQLSTATE');
    assert.equal(payload.reason_code, denialReasonOf(sqlState), '日志要带映射后的 refuse 口径');
    assert.equal(payload.actor_id, ACTOR_ID);
    assert.equal(payload.target_id, TARGET_ID);
    assert.equal(payload.request_id, REQUEST_ID);
    assert.equal(payload.denial_error_sqlstate, 'XX000', '日志要带留痕自己的失败码（区分「被拒」与「留痕坏了」）');
    assert.match(String(message), /留痕未落库/u, '文案要让值班看出是留痕侧失败，而主响应未被改变');
    // ⛔ 不得把驱动原文 message 记进日志（可能带 SQL/连接串片段）。
    assert.equal(Object.hasOwn(payload, 'message'), false);
    assert.equal(JSON.stringify(payload).includes('denial sidecar exploded'), false);
  }
});

test('纪律 2：第二条连接**拿不到**（connect 抛错）时同样只 warn，主响应不变', async () => {
  const { pool } = scriptedPool({ sqlState: 'G0009', denial: 'connect-throw' });
  const { warns, log } = recordingLog();
  const authority = createPostgresAdminScopeAuthority({ pool, log });

  await assert.rejects(() => authority.revoke(revokeAction()), (error) => {
    assert.equal(error.code, 'LAST_SCOPE_MANAGER');
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(warns.length, 1, '拿不到连接也必须 warn，不得静默');
  assert.equal(warns[0].payload.denial_error_sqlstate, 'ECONNREFUSED');
});

test('纪律 2：不给 log 也不炸（留痕失败是本片唯一允许的静默降级）', async () => {
  const { pool } = scriptedPool({ sqlState: 'G0009', denial: 'throw' });
  const authority = createPostgresAdminScopeAuthority({ pool });
  await assert.rejects(() => authority.revoke(revokeAction()), (error) => {
    assert.equal(error.status, 409);
    return true;
  });
});

test('纪律 2：`log.warn` **自己**抛错时也不得把 403/409 升成 500', async () => {
  // 为什么必须钉这一条：`warn()` 就在 `catch` 里。logger 一旦抛错（配置坏、payload 序列化环、
  // 替身故意抛），异常会顺着 `recordAdminScopeDenial` 冒到路由层 ⇒ 403/409 变成 500。
  // 断言的是**状态码与错误码**（不是「没抛」）：吞掉日志故障之后主响应必须逐字原样。
  const cases = [
    ['G0009', 'LAST_SCOPE_MANAGER', 409],
    ['G0008', 'SELF_SCOPE_GRANT_DENIED', 403],
  ];
  for (const [sqlState, code, status] of cases) {
    const { events, pool } = scriptedPool({ sqlState, denial: 'throw' });
    let warnCalls = 0;
    const log = {
      warn() {
        warnCalls += 1;
        const error = new Error('logger backend unavailable');
        error.code = 'ELOGGER';
        throw error;
      },
    };
    const authority = createPostgresAdminScopeAuthority({ pool, log });
    await assert.rejects(() => authority.revoke(revokeAction()), (error) => {
      assert.equal(error.code, code, `${sqlState}：logger 抛错后主错误码被改写了`);
      assert.equal(error.status, status, `${sqlState}：logger 抛错把 ${status} 改成了别的状态`);
      assert.notEqual(error.status, 500, `${sqlState}：留痕告警失败不得冒成 500`);
      return true;
    });
    // 必须真的走到「留痕失败 ⇒ 告警」这一步，否则本用例吞掉的是别的异常，没有证明力。
    assert.ok(events.some(isDenialQuery), `${sqlState}：留痕应至少被尝试一次`);
    assert.equal(warnCalls, 1, `${sqlState}：必须走到 warn 且只走一次`);
  }
});

test('纪律 2：归还连接时 `release()` 抛错也不得把 409 升成 500', async () => {
  // `pg` 的 `release()` 会因「重复释放」「池已关闭」抛错。它发生在 `catch` 的收尾与 `finally` 里，
  // 一旦外泄同样会顶掉主错误 ⇒ 必须由 `releaseQuietly` 收口，而不是靠调用点各自记得 try。
  const { events, pool } = scriptedPool({ sqlState: 'G0009', denial: 'ok', releaseThrows: true });
  const { warns, log } = recordingLog();
  const authority = createPostgresAdminScopeAuthority({ pool, log });

  await assert.rejects(() => authority.revoke(revokeAction()), (error) => {
    assert.equal(error.code, 'LAST_SCOPE_MANAGER', '释放失败后主错误码被改写了');
    assert.equal(error.status, 409, '释放失败把 409 改成了别的状态');
    return true;
  });
  // 主连接确实被尝试归还过（否则本用例没打到 `releaseQuietly`），且留痕不受牵连。
  assert.ok(events.some((event) => event.phase === 'release'));
  assert.ok(events.some(isDenialQuery), '释放失败不该阻断留痕旁路');
  assert.equal(warns.length, 0, '留痕本身成功 ⇒ 不该有留痕失败告警');
});

// ---------------------------------------------------------------------------
// 纪律 0：只在四个 G 码上写；成功与否都不写
// ---------------------------------------------------------------------------
test('纪律 0：表外 SQLSTATE 一行都不留痕（XX000/42501/42883/57014/断连 ≠ 被拒）', async () => {
  const cases = [
    ['XX000', 'PROVIDER_UNAVAILABLE'],
    ['42501', 'PROVIDER_UNAVAILABLE'],
    ['42883', 'PROVIDER_UNAVAILABLE'],
    ['57014', 'PROVIDER_TIMEOUT'],
    ['55P03', 'PROVIDER_TIMEOUT'],
    ['ECONNRESET', 'PROVIDER_UNAVAILABLE'],
    ['', 'PROVIDER_UNAVAILABLE'],
  ];
  for (const [sqlState, expectedCode] of cases) {
    const { events, pool } = scriptedPool({ sqlState });
    const { warns, log } = recordingLog();
    const authority = createPostgresAdminScopeAuthority({ pool, log });
    await assert.rejects(() => authority.revoke(revokeAction()), (error) => {
      // 这些属服务端缺陷 ⇒ 如实失败（503/504），⛔ 不得冒充「被拒」。
      assert.equal(error.code, expectedCode, `${sqlState || '(无 code)'} 的分流变了：它不属于「被拒」`);
      assert.notEqual(error.status, 403, `${sqlState || '(无 code)'} 不得伪装成 403 被拒`);
      assert.notEqual(error.status, 409, `${sqlState || '(无 code)'} 不得伪装成 409 被拒`);
      return true;
    });
    assert.equal(events.some(isDenialQuery), false, `${sqlState || '(无 code)'} 不得写留痕行`);
    assert.equal(warns.length, 0, `${sqlState || '(无 code)'} 不是「被拒」，不该有留痕失败告警`);
    // 主事务仍然被回滚、连接仍然被释放（不留半成品、不漏连接）。
    assert.ok(events.some((event) => event.phase === 'query' && event.text === 'ROLLBACK'));
    assert.ok(events.some((event) => event.phase === 'release'));
  }
});

test('纪律 0：授予/撤销**成功**时不得留痕，也不得多开连接', async () => {
  const { events, pool } = scriptedPool({ success: true });
  const { warns, log } = recordingLog();
  const authority = createPostgresAdminScopeAuthority({ pool, log });
  const outcome = await authority.grant(revokeAction());
  assert.equal(outcome.changed, true);
  assert.equal(events.some(isDenialQuery), false, '成功路径不得写拒绝留痕');
  assert.equal(events.filter((event) => event.phase === 'connect').length, 1, '成功路径只开一条连接');
  assert.equal(warns.length, 0);
});

// ---------------------------------------------------------------------------
// 映射表与库层闭集同源（两侧清单逐值对拍）
// ---------------------------------------------------------------------------
test('映射表恰四个键，且四个 reason_code 与 0046 的闭集逐字同源', () => {
  assert.deepEqual(Object.keys(ADMIN_SCOPE_DENIAL_REASONS), ['G0008', 'G0009', 'G0010', 'G0011']);
  assert.deepEqual(Object.values(ADMIN_SCOPE_DENIAL_REASONS), [
    'self_scope_grant_denied',
    'last_scope_manager',
    'scope_denied',
    'scope_not_held',
  ]);
  // 表外取值一律 undefined（⇒ 不留痕）。用 `Object.hasOwn` 而不是 `in`：原型键不得命中。
  for (const outside of ['G0007', 'G0012', 'XX000', 'toString', 'constructor', '__proto__']) {
    assert.equal(denialReasonOf(outside), undefined, `${outside} 不在表内，必须判成「不是被拒」`);
  }
  // 与迁移里的两个闭集逐值对拍：两侧任一单边改名都必须红。
  //
  // ⚠ 这里**必须**解析 `x_scope_allowed`/`x_reason_allowed` 的 `ARRAY[...]::text[]` 字面量本身。
  // 早先的写法是 `sql.includes('scopes:write')` —— 那是近乎恒真的断言：该字符串在 `0046` 的
  // 文件头注释里出现了十几遍，闭集里被删掉也照样命中。用「整文件出现过」证明「闭集里有它」，
  // 正是本片要杀死的伪证。
  const sql = readFileSync(join(REPO_ROOT, DENIAL_MIGRATION), 'utf8');
  const closedSet = (variable) => {
    const match = new RegExp(`${variable}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\]::text\\[\\]`).exec(sql);
    assert.notEqual(
      match,
      null,
      `0046 里找不到 ${variable} 的 \`ARRAY[...]::text[]\` 声明：缺了它下面的断言会退化成恒真`,
    );
    return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
  };
  const allowedReasons = closedSet('x_reason_allowed');
  assert.deepEqual(
    [...allowedReasons].sort(),
    [...Object.values(ADMIN_SCOPE_DENIAL_REASONS)].sort(),
    '应用层四个 reason_code 与 0046 的 reason 闭集不再逐值相等（单边改名/拓宽即红，会撞 G0001）',
  );
  // 留痕 `p_scope` 恒 `scopes:write`，且它必须真在 0046 的 13 项 scope 闭集里 —— 否则库层判
  // G0001、整条留痕静默丢失（失败只 warn，主响应照旧 403/409，没有任何人会发现）。
  assert.equal(ADMIN_SCOPE_DENIAL_SCOPE, 'scopes:write');
  const allowedScopes = closedSet('x_scope_allowed');
  assert.equal(allowedScopes.length, 13, `0046 的 scope 闭集应为 13 项，实际 ${allowedScopes.length} 项`);
  assert.ok(
    allowedScopes.includes(ADMIN_SCOPE_DENIAL_SCOPE),
    `${ADMIN_SCOPE_DENIAL_SCOPE} 不在 0046 的 \`x_scope_allowed\` 闭集内 ⇒ 库层会 G0001，留痕会静默丢失`,
  );
});

test('接线点唯一：`scope-authority-pg.ts` 里只有一处调用留痕，且不在 `BEGIN…COMMIT` 之间', async () => {
  // 静态判据（补假池看不到的那一半）：源文本里留痕函数只被**一处**调用 ——
  // 多一处就意味着有第二条路径可能绕开「先回滚再留痕」的纪律。
  const source = readFileSync(join(REPO_ROOT, AUTHORITY_SOURCE), 'utf8');
  const callSites = [...source.matchAll(/recordAdminScopeDenial\(/g)].length;
  assert.equal(callSites, 1, `留痕函数在写权威里应只有一处调用，实际出现 ${callSites} 次`);
  const callIndex = source.indexOf('await recordAdminScopeDenial(');
  const rollbackIndex = source.indexOf("client.query('ROLLBACK')");
  assert.notEqual(callIndex, -1);
  assert.notEqual(rollbackIndex, -1);
  assert.ok(rollbackIndex < callIndex, '源码顺序也必须是「ROLLBACK → 留痕」');
  // 留痕调用必须在主连接**归还之后**（文本上就是归还语句在它前面）。
  const releaseIndex = source.indexOf('releaseQuietly(client);');
  assert.ok(releaseIndex !== -1 && releaseIndex < callIndex, '留痕调用必须在主连接归还（releaseQuietly）之后');
  // 归还本身也必须走收口函数：`release()` 抛错同样会顶掉主响应，不许裸调。
  assert.ok(source.includes('function releaseQuietly('), '归还连接必须走自带 try 的收口函数');
  assert.equal(
    source.includes('client?.release();'),
    true,
    '收口函数里仍应保留唯一的 `client?.release();` —— 它一旦消失，说明有人把归还逻辑改散了',
  );
});

test('留痕旁路自成一档：单条自提交语句、无 BEGIN/COMMIT、失败只 warn', async () => {
  const sidecar = readFileSync(join(REPO_ROOT, SIDECAR_SOURCE), 'utf8');
  // 单条语句自提交（纪律 1 的库层面）：旁路里不得发出任何事务控制语句。
  assert.ok(
    !/query\(\s*['"`](?:BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sidecar),
    '留痕旁路不得发出 BEGIN/COMMIT/ROLLBACK/SET LOCAL（必须单语句自提交）',
  );
  // 唯一一条写语句就是 0046 的窄口径函数，五个形参全显式转型（防重载误选）。
  assert.ok(
    sidecar.includes(
      `SELECT ${RECORD_ADMIN_SCOPE_DENIAL_FUNCTION}(\n  $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid\n) AS audit_id`,
    ),
    '留痕语句必须直接是 SELECT public.record_admin_scope_denial($1..$5)（不传 p_audit_id）',
  );
  // 纪律 3：失败只走 log.warn，⛔ 不得 console、⛔ 不得再次抛。
  assert.ok(
    !/\bconsole\s*\.\s*(?:warn|log|error|info|debug)\s*\(/.test(sidecar),
    '旁路不得 console.*（会绕过结构化日志与脱敏）',
  );
  // 告警必须经 `warnQuietly` 收口：`log.warn` 自己抛错也不许外泄（否则 403/409 会变 500）。
  assert.ok(sidecar.includes('function warnQuietly('), '告警必须走自带 try 的收口函数 warnQuietly');
  assert.ok(sidecar.includes('log.warn('), '旁路失败必须只 warn（⛔ 不许 throw、⛔ 不许 console）');
  assert.ok(
    /try \{\n\s+await writeAdminScopeDenial\(args\);/.test(sidecar),
    '导出入口必须把整段留痕包在 try 里 —— 「全吞」要是结构性的，不能靠每处都记得加 try',
  );
});

/**
 * 受理层接线（`#19` 片1）：`services/api/src/privacy/deletion-requests-pg.ts` 里
 * 「注销去身份」这一步的**位置、连接、错误语义**，以及它**不进 HTTP 体**。
 *
 * 这条接线的三个坑都不是类型系统能拦的：
 *
 * 1. **位置**：`public.request_account_deletion(...)` 已经把该 `public.users` 行 `FOR UPDATE` 锁住；
 *    去身份必须在**同一个事务里、`COMMIT` 之前**、并且**排在函数调用之后**。放 `COMMIT` 之后就
 *    变成「202 已签发、身份却没擦」，放前面则事务里还没有 `deletion_pending` 的状态（`G0015`）。
 * 2. **连接**：必须复用 `createRequest()` 里那一个 `client`。另开连接会在 `lock_timeout='4s'` 之后
 *    `55P03` 自死锁——而这是**真库才看得见**的故障，单测只能钉住「没有第二个 `pool.connect()`」。
 * 3. **失败语义（fail-closed）**：任何异常走既有 `catch` → `ROLLBACK` ⇒ 零写入、不签发 202。
 *    `G0015`（账号不在 `deletion_pending`）必须映射成 `PROVIDER_UNAVAILABLE` + `retryable:false`，
 *    ⛔ 不能被 `isTransientDatabaseError()` 兜底判成「可重试」——重试永远也不会通过。
 *
 * 另外钉住「读数不外泄」：`deidentified` 只活在服务端记录里。契约 `DeletionReceipt` 是
 * `additionalProperties: false`（`packages/contracts/openapi.json`），多塞一个键就是**破坏契约**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { lexSegments } from './line-anchor-scan.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STORE = join(ROOT, 'services/api/src/privacy/deletion-requests-pg.ts');
const PROJECTION = join(ROOT, 'services/api/src/privacy/account-deletion.ts');
const CONTRACT = join(ROOT, 'packages/contracts/openapi.json');

const source = readFileSync(STORE, 'utf8');

/** `createRequest()` 的函数体（从方法签名到下一个方法/类尾的 `}` 之前）。 */
function createRequestBody() {
  const start = source.indexOf('async createRequest(input)');
  assert.notEqual(start, -1, '`createRequest()` 必须存在（受理路径的唯一入口）');
  const commit = source.indexOf("await client.query('COMMIT')", start);
  assert.notEqual(commit, -1, '`createRequest()` 里必须有 `COMMIT`');
  return source.slice(start, commit);
}

/** `lexSegments()` 掩码里「代码」段的取值：0（字符串/模板/正则/注释段都非 0）。 */
const SEG_CODE = 0;

/**
 * `createRequest()` **方法体自身**的边界（方法签名 → 配对的 `}`），半开区间 `[start, end)`。
 *
 * 为什么不能「从签名一路切到文件尾」：同文件里 `createRequest()` **之后**还有成员（将来也还会有）。
 * 谁在那之后加一次 `pool.connect()`（完全合法的改动）都会被算进本方法的账，判据当场**假红**。
 * 「只允许一次连接」这条判据只该覆盖本方法体，所以切片终点必须是方法体自己的 `}`。
 *
 * 为什么用仓内词法器 `lexSegments()` 配平、而不是裸数花括号：注释/字符串/模板/正则里的花括号
 * 不参与配对。裸数会被注释里一个孤立的 `{`、或模板里的花括号带偏，边界**静默**算错（比假红更糟）。
 */
function createRequestSpan() {
  const start = source.indexOf('async createRequest(input)');
  assert.notEqual(start, -1, '`createRequest()` 必须存在（受理路径的唯一入口）');
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, '`createRequest()` 的方法体必须由 `{` 开始');
  const kind = lexSegments(source);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (kind[i] !== SEG_CODE) continue;
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const end = i + 1;
        // 边界自证：方法体之后必须紧跟**成员分隔符**（`,` 或对象字面量的 `}`）。
        // 落在别处（例如把默认参数里的对象当成了方法体）⇒ 当场报错，⛔ 不回落到文件尾。
        assert.match(
          source.slice(end).trimStart(),
          /^[,}]/,
          '`createRequest()` 的切片终点必须落在成员边界上（`,` 或对象字面量的 `}`）',
        );
        return { start, end };
      }
    }
  }
  assert.fail('`createRequest()` 的方法体没有配对的 `}`：切片终点无法确定（⛔ 不回落到文件尾）');
}

test('`DEIDENTIFY_SQL` 逐字：`SELECT public.deidentify_account($1::uuid) AS result`', () => {
  assert.ok(
    source.includes("const DEIDENTIFY_SQL = 'SELECT public.deidentify_account($1::uuid) AS result';"),
    'SQL 必须逐字是 `SELECT public.deidentify_account($1::uuid) AS result`'
      + '（函数名全限定、`$1::uuid` 显式转型、别名 `result` 供 toDeidentified 取值）',
  );
  // 只读一条 SELECT：⛔ 不许在 TS 侧拼 UPDATE —— 擦除必须发生在函数体内（唯一写路径）。
  assert.equal(
    /UPDATE\s+public\.(users|exports)/i.test(source),
    false,
    '`deletion-requests-pg.ts` 全文不得出现 `UPDATE public.users` / `UPDATE public.exports`：'
      + '四列与 exports 的擦除只能在 `public.deidentify_account()` 里做（运行时角色对这些列没有任何写权限，'
      + '写在 TS 里必然 42501）',
  );
});

test('位置：`DEIDENTIFY_SQL` 紧跟 `LOCK_TIMEOUT_SQL`；调用在 `CALL_FUNCTION_SQL` 之后、`COMMIT` 之前', () => {
  assert.ok(
    source.indexOf('LOCK_TIMEOUT_SQL') < source.indexOf('const DEIDENTIFY_SQL'),
    '`DEIDENTIFY_SQL` 必须定义在 `LOCK_TIMEOUT_SQL` 之后（同一段常量区，顺序即文档）',
  );
  const body = createRequestBody();
  const callAt = body.indexOf('client.query(CALL_FUNCTION_SQL');
  const deidentifyAt = body.indexOf('client.query(DEIDENTIFY_SQL');
  assert.notEqual(callAt, -1, '`createRequest()` 必须先调受理函数 `CALL_FUNCTION_SQL`');
  assert.notEqual(deidentifyAt, -1, '`createRequest()` 必须调用 `DEIDENTIFY_SQL`');
  assert.ok(
    callAt < deidentifyAt,
    `去身份必须排在受理函数之后（受理函数先落 deletion_pending 状态，去身份才有依据）；现场 ${callAt} vs ${deidentifyAt}`,
  );
  // 备份副本清单（可选）也在同一事务里；去身份排在它之后是设计 §6.1 第 3 步的顺序。
  const seedsAt = body.indexOf('insertBackupCopySeeds');
  if (seedsAt !== -1) {
    assert.ok(seedsAt < deidentifyAt, '去身份必须排在备份清单写入之后（设计 §6.1 第 3 步）');
  }
});

test('同一连接：`createRequest()` 只允许一次 `pool.connect()`（另开会 4s 后 55P03 自死锁）', () => {
  const { start, end } = createRequestSpan();
  const body = source.slice(start, end);
  const connects = body.match(/pool\.connect\(\)/g) ?? [];
  assert.equal(
    connects.length,
    1,
    '`createRequest()` 里必须只有一次 `pool.connect()`：受理函数已对该行 `FOR UPDATE`，'
      + '另开连接再写同一行会在 `lock_timeout=\'4s\'` 之后 `55P03` 自死锁',
  );
  // 去身份调用必须复用同一个 `client` 变量（而不是 `pool.query` / 新建 client）。
  assert.ok(
    /await client\.query\(DEIDENTIFY_SQL, \[input\.userId\]\)/.test(source),
    '去身份必须走同一个 `client`：`await client.query(DEIDENTIFY_SQL, [input.userId])`',
  );
  assert.equal(
    /pool\.query\(\s*DEIDENTIFY_SQL/.test(source),
    false,
    '⛔ 不许用 `pool.query(DEIDENTIFY_SQL)`：那是另一条连接，会与受理函数的行锁自死锁',
  );
});

test('`G0015` 映射：`PROVIDER_UNAVAILABLE` 且 **retryable:false**（重试永远不会通过）', () => {
  assert.ok(
    /if \(sqlState === 'G0015'\) throw new ApiError\('PROVIDER_UNAVAILABLE', [^)]*\{ retryable: false \}\)/.test(source),
    "`mapDeletionError()` 必须把 G0015 映射成 `new ApiError('PROVIDER_UNAVAILABLE', …, { retryable: false })`",
  );
  // G0015 必须排在「瞬时错误兜底」之前（否则会被判成可重试）。兜底指 `mapDeletionError()` 里
  // 那次 `if (isTransientDatabaseError(error))` 调用 —— 文件头注释里也提到这个函数名，故按调用形态定位。
  const mapAt = source.indexOf('export function mapDeletionError');
  assert.notEqual(mapAt, -1, '`mapDeletionError()` 必须存在');
  const branchAt = source.indexOf("sqlState === 'G0015'", mapAt);
  const fallbackAt = source.indexOf('isTransientDatabaseError(error)', mapAt);
  assert.notEqual(branchAt, -1, 'G0015 分支必须存在');
  assert.notEqual(fallbackAt, -1, '既有瞬时错误兜底必须还在（本片不动它）');
  assert.ok(
    branchAt < fallbackAt,
    `G0015 分支（偏移 ${branchAt}）必须排在瞬时错误兜底（偏移 ${fallbackAt}）之前`,
  );
});

test('返回值合流 `{ ...toRecord(raw), deidentified }`，且 `deidentified` 是可选三数字对象', () => {
  assert.ok(
    /deidentified\?:\s*\{\s*identity: number;\s*exports: number;\s*generation: number\s*\};/.test(source),
    '`DeletionRequestRecord` 必须加可选字段 `deidentified?: { identity: number; exports: number; generation: number }`',
  );
  assert.ok(
    /return \{ \.\.\.toRecord\(raw\), deidentified \};/.test(source),
    '返回值必须合流成 `{ ...toRecord(raw), deidentified }`（既有 13 个字段一个不改）',
  );
  // 读数必须在 `COMMIT` 之前解析：形状不符 ⇒ throw ⇒ 整笔 ROLLBACK ⇒ 不签发 202。
  const commitAt = source.indexOf("await client.query('COMMIT')");
  const parseAt = source.indexOf('toDeidentified(deidentifyResult.rows[0]');
  assert.ok(commitAt !== -1 && parseAt !== -1 && parseAt < commitAt,
    '`toDeidentified(...)` 必须在 `COMMIT` 之前执行（形状不符就回滚，真 fail-closed）');
});

test('`deidentified` 不进 HTTP 体：投影函数按白名单取键，契约是 additionalProperties:false', () => {
  const projection = readFileSync(PROJECTION, 'utf8');
  assert.equal(
    /deidentified/.test(projection),
    false,
    '`account-deletion.ts` 的回执投影不得出现 `deidentified`：去身份读数只回给服务端记录，不进 HTTP 体',
  );
  const contract = readFileSync(CONTRACT, 'utf8');
  const receiptAt = contract.indexOf('"DeletionReceipt"');
  assert.notEqual(receiptAt, -1, '契约里必须有 `DeletionReceipt` schema');
  const window = contract.slice(receiptAt, receiptAt + 6000);
  assert.ok(
    /"additionalProperties":\s*false/.test(window),
    '`DeletionReceipt` 必须是 `additionalProperties: false`（多塞一个键就是破坏契约）',
  );
});

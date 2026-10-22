/**
 * GY-R31 · 复盘页 G5（`#17`）· 共享幂等台账「按前缀删」的跨域副作用 —— **结构性守卫**（不连库）。
 *
 * 被守卫的现状（实测见 `docs/verification/gy-r31-i17-g5-20261022.md`）：
 *   ① 台账是一张**共享表** `public.idempotency_keys`（`services/api/db/migrations/0008_auth_session.sql:46-58`，
 *      唯一索引 `idempotency_keys_scope_key (scope, key_hash)`），auth / profile / privacy(consent,grant) /
 *      messages 四域共用；favorites / history / community / ocr / recognition / speech 六域各自另有
 *      `*_idempotency` 表（与共享表**互不相干**）。
 *   ② `scope` 的首段**恒为主体 uuid**，没有、也不允许有域标签（`msg:` / `ocr:` 之类）。
 *   ③ 注销清理按「主体 + 分隔符」**精确**前缀删（`services/api/src/messages/store-pg.ts:234-237`）。
 *
 * 于是「跨域副作用」的真相**不是**「域前缀相撞」，而是**同主体的他域回执被连坐删掉**：首段是主体
 * ⇒ 删不到别的主体；但同主体在 auth/profile/privacy 写下的回执**会**被一并删。这是决策者知情并
 * 写进注释（`store-pg.ts:207-215`）、且由真库臂逐字量过的既有语义（`tests/integration/messages-purge-pg.mjs`
 * `[5]` 断言 A 的 `/auth/logout` 行必须被计入 `messages:idempotency-purged`）。
 *
 * 本文件不动那条语义，只把「不可能跨主体」依赖的三个前提变成会红的断言：
 *   - 分隔符与主体前缀**一处定义**（`auth/idempotency.ts`），生产端不再自拼字面量；
 *   - 任意两个主体两两不相交，且「像主体但不是主体」的诱饵不被命中；
 *   - 主体永不携带分隔符（数据库主体列是 `uuid`，因此上述前提成立）—— 一旦有人放开这条，
 *     下面的负控制证明前缀删会立即变成**跨主体**误删。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as idempotency from '../../services/api/src/auth/idempotency.ts';
import { USER_A, USER_B, ADMIN } from './messages-fixtures.mjs';

/** 第三个真实主体（`messages-fixtures.mjs` 里的 `ADMIN`，uuid 形态与其他两个同族）。 */
const USER_C = ADMIN;

/**
 * 命名空间成员**延迟取值**（不在 import 处解构）：守卫要在「常量/helper 还没落地」时
 * 逐条给出有意义的红，而不是整文件因缺导出直接崩掉。
 */
const SEP = idempotency.IDEMPOTENCY_SCOPE_SEPARATOR;
const subjectPrefix = idempotency.idempotencySubjectPrefix;
const scopeOf = idempotency.idempotencyScope;

const API_SRC = new URL('../../services/api/src/', import.meta.url);
const MIGRATIONS = new URL('../../services/api/db/migrations/', import.meta.url);

const readSrc = (relPath) => readFileSync(fileURLToPath(new URL(relPath, API_SRC)), 'utf8');

/** 遍历 `services/api/src/**` 的全部 `.ts`，返回 `{ 相对路径(正斜杠) → 内容 }`。 */
function allApiSources() {
  const root = fileURLToPath(API_SRC);
  const out = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const absolute = `${entry.parentPath ?? entry.path}${pathSep}${entry.name}`;
    const relative = absolute.slice(root.length).replace(/^[/\\]+/u, '').split(pathSep).join('/');
    out.set(relative, readFileSync(absolute, 'utf8'));
  }
  return out;
}

/**
 * 与 PG 谓词**逐字同口径**的 JS 等价式：
 *   `left(scope, char_length($1::text) + 1) = $1::text || chr(10)`
 * ⇒ 取 `scope` 前 `subject.length + 1` 个字符，必须恰好等于 `subject + 分隔符`。
 */
function isUnderSubject(scope, subject, separator = SEP) {
  return scope.slice(0, subject.length + 1) === `${subject}${separator}`;
}

/**
 * 守卫本体：这组主体两两不得相交（任一主体的 scope 都不得落在另一主体的前缀下）。
 * 故意做成「会抛」的形状——负控制要断言它在这组主体上**必须红**。
 */
function assertSubjectPrefixesDisjoint(subjects) {
  for (const a of subjects) {
    for (const b of subjects) {
      if (a === b) continue;
      assert.equal(
        isUnderSubject(scopeOf(b, 'POST', '/messages'), a),
        false,
        `主体前缀相交：${JSON.stringify(b)} 的 scope 落在 ${JSON.stringify(a)} 的前缀下`
          + '（按主体前缀删会跨主体误删）',
      );
    }
  }
}

const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ---------------------------------------------------------------------------
// T1 · 语法单点：分隔符与「主体前缀」只有一处定义
// ---------------------------------------------------------------------------

test('T1 语法单点 · 分隔符常量唯一、码点 10 与 PG 的 chr(10) 同值，scope 由它拼出', () => {
  assert.equal(typeof SEP, 'string', '缺少集中定义的 `IDEMPOTENCY_SCOPE_SEPARATOR`（前缀不该靠散落字面量）');
  assert.equal(SEP.length, 1, `分隔符必须单字符，实际 ${JSON.stringify(SEP)}`);
  assert.equal(SEP.charCodeAt(0), 10, '分隔符必须与 SQL 的 `chr(10)`（换行 0x0A）同值，否则 PG 前缀删与内存实现分叉');
  assert.equal(
    typeof subjectPrefix,
    'function',
    '缺少 `idempotencySubjectPrefix()`：共享台账的按主体清理必须有唯一的前缀来源',
  );
  assert.equal(subjectPrefix(UUID), `${UUID}${SEP}`, '主体前缀必须是「主体 + 分隔符」，不多不少');

  const scope = scopeOf(UUID, 'put', '/messages/{id}/read');
  assert.equal(scope, [UUID, 'PUT', '/messages/{id}/read'].join(SEP), 'scope 必须仍由分隔符拼成三段');
  assert.deepEqual(scope.split(SEP), [UUID, 'PUT', '/messages/{id}/read'], '首段必须是主体、共三段');
  assert.equal(scope.startsWith(subjectPrefix(UUID)), true, '本主体的 scope 必须落在自己的主体前缀下');
});

test('T1b 语法单点 · 分隔符常量在源码里只定义一次（§不再散落第二份字节串）', () => {
  const source = readSrc('auth/idempotency.ts');
  const definitions = source.match(/IDEMPOTENCY_SCOPE_SEPARATOR\s*=/g) ?? [];
  assert.equal(definitions.length, 1, `\`IDEMPOTENCY_SCOPE_SEPARATOR\` 必须恰好定义一次，实际 ${definitions.length} 处`);
  assert.match(
    source,
    /export function idempotencyScope\(subject: string, method: string, routePath: string\): string \{[\s\S]{0,400}?IDEMPOTENCY_SCOPE_SEPARATOR/,
    '`idempotencyScope` 必须用同一个常量拼段，不得再写第二份 `\\n` 字面量',
  );
});

// ---------------------------------------------------------------------------
// T2 · 两两不相交（含「像主体但不是主体」的诱饵）
// ---------------------------------------------------------------------------

test('T2 主体两两不相交 · 任一主体的 scope 都不落在别的主体前缀下，诱饵不命中', () => {
  const subjects = [
    USER_A.userId,
    USER_B.userId,
    USER_C.userId,
    '00000000-0000-4000-8000-000000000000',
    randomUUID(),
    randomUUID(),
  ];
  assertSubjectPrefixesDisjoint(subjects);

  // 每个主体自己的行必须**全部**命中（否则「按主体清空」会漏行、旧回执永远可重放）。
  for (const subject of subjects) {
    assert.equal(isUnderSubject(scopeOf(subject, 'POST', '/messages'), subject), true, `${subject} 自己的行必须命中`);
    assert.equal(
      isUnderSubject(scopeOf(subject, 'DELETE', '/me/consents/privacy'), subject),
      true,
      `${subject} 在他域写的行同样落在自己的主体前缀下（这正是「按主体删」会连坐他域的机制）`,
    );
  }

  // 诱饵：首段只比主体多/少一点，**不是**同一主体 ⇒ 必须零命中。
  const decoys = [`${UUID}0`, `${UUID}-`, UUID.slice(0, 35), `${UUID} `, ` ${UUID}`];
  for (const decoy of decoys) {
    assert.equal(
      isUnderSubject(scopeOf(decoy, 'POST', '/messages'), UUID),
      false,
      `诱饵 ${JSON.stringify(decoy)} 不得被主体 ${UUID} 的前缀命中（否则就是裸字符串前缀，不是「主体 · 分隔符」边界）`,
    );
  }
});

// ---------------------------------------------------------------------------
// T3 · 负控制：人为让两个主体相撞 ⇒ 守卫必须红
// ---------------------------------------------------------------------------

test('T3 负控制 · 主体含分隔符即相撞 ⇒ 守卫必须红（所以「主体是裸 uuid」是承重前提）', () => {
  const base = 'aa';
  const shadow = `aa${SEP}b`;
  // 机制本身：shadow 的 scope 首段是 `aa` + 分隔符 + `b` ⇒ 落在 base 的前缀下。
  assert.equal(
    isUnderSubject(scopeOf(shadow, 'POST', '/messages'), base),
    true,
    '负控制失效：主体里带分隔符时，前缀删本应跨主体误删，这里却判不相交',
  );
  // 守卫必须把这种组合判红。
  assert.throws(
    () => assertSubjectPrefixesDisjoint([base, shadow]),
    /主体前缀相交/,
    '守卫必须对相撞主体报红 —— 否则它守不住「跨主体误删」这条底线',
  );
  // 而真实主体集合必须绿。
  assert.doesNotThrow(() => assertSubjectPrefixesDisjoint([USER_A.userId, USER_B.userId, USER_C.userId]));
});

// ---------------------------------------------------------------------------
// T4 · 承重前提：主体列是 uuid ⇒ 不含分隔符
// ---------------------------------------------------------------------------

test('T4 承重前提 · 主体恒为 uuid（数据库定义 + 形态），故分隔符永不出现在首段', () => {
  const migration = readdirSync(fileURLToPath(MIGRATIONS)).find((name) => name.startsWith('0001') && name.endsWith('.sql'));
  assert.ok(migration, '找不到 0001 迁移（主体列的定义所在）');
  const ddl = readFileSync(fileURLToPath(new URL(migration, MIGRATIONS)), 'utf8');
  assert.match(
    ddl,
    /CREATE TABLE users\s*\([\s\S]{0,200}?\bid\s+uuid\s+PRIMARY KEY/,
    '`users.id` 必须是 `uuid PRIMARY KEY`：这是「首段不含分隔符」的唯一来源',
  );

  for (const subject of [USER_A.userId, USER_B.userId, USER_C.userId, randomUUID()]) {
    assert.equal(subject.includes(SEP), false, `主体 ${subject} 不得含分隔符`);
    assert.match(subject, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `主体必须是 uuid 形态：${subject}`);
  }
});

// ---------------------------------------------------------------------------
// T5 · 反向棘轮：共享台账里的 scope 没有、也不许有域标签
// ---------------------------------------------------------------------------

test('T5 反向棘轮 · scope 首段恒为主体，不出现 msg: / ocr: / recognition: 之类域标签', () => {
  const DOMAIN_TAGS = ['msg:', 'messages:', 'ocr:', 'recognition:', 'conversation:', 'speech:', 'community:', 'favorites:', 'history:', 'auth:', 'profile:'];
  const routes = ['/messages', '/messages/{id}/read', '/me/profile', '/me/consents', '/me/consents/privacy', '/auth/logout', '/auth/wechat'];
  for (const routePath of routes) {
    const firstSegment = scopeOf(UUID, 'POST', routePath).split(SEP)[0];
    assert.equal(firstSegment, UUID, `首段必须是主体本体（${routePath}），出现域标签就会让「按主体前缀删」失效`);
    for (const tag of DOMAIN_TAGS) {
      assert.equal(firstSegment.startsWith(tag), false, `首段不得以域标签 ${tag} 开头（${routePath}）`);
    }
  }
});

// ---------------------------------------------------------------------------
// T6 · 生产端只允许从 helper 取前缀（PG 侧保留等价 SQL，但被静态钉住）
// ---------------------------------------------------------------------------

test('T6 收敛 · 前缀只经 `idempotencySubjectPrefix()` 产出，内存实现不再自拼字面量', () => {
  const sources = allApiSources();
  const callSites = [...sources.entries()]
    .filter(([, text]) => text.includes('idempotencySubjectPrefix'))
    .map(([relative]) => relative)
    .sort();
  assert.deepEqual(
    callSites,
    ['auth/idempotency.ts', 'messages/store.ts'],
    '前缀的产出与消费只允许这两处；新增一处必须回来把「它为什么也要按主体前缀删」写清楚再放行',
  );

  const memoryStore = sources.get('messages/store.ts');
  assert.equal(
    /`\$\{ownerId\}\\n`/.test(memoryStore),
    false,
    '`messages/store.ts` 不得再自拼 `${ownerId}\\n`：前缀必须来自集中常量',
  );
  assert.match(memoryStore, /const scopePrefix = idempotencySubjectPrefix\(ownerId\);/, '内存实现必须用 helper 取前缀');
});

test('T6b 收敛 · PG 侧谓词与 helper 同口径（`chr(10)` 与分隔符常量同值，且仍是精确前缀）', () => {
  const pgStore = readSrc('messages/store-pg.ts');
  const predicate = 'left(scope, char_length($1::text) + 1) = $1::text || chr(10)';
  assert.equal(pgStore.split(predicate).length - 1, 1, `PG 谓词必须恰好出现一次：${predicate}`);
  assert.equal(/LIKE/i.test(predicate), false, '不得用 LIKE：`_`/`%` 会走样');
  assert.equal(SEP.charCodeAt(0), 10, '`chr(10)` 与分隔符常量必须同值，否则 PG 与内存实现分叉');
  // 谓词的真实语义由 T2/T3 的 `isUnderSubject()` 表达：同一主体全命中、他主体零命中。
  assert.equal(isUnderSubject(`${USER_A.userId}${SEP}POST${SEP}/messages`, USER_A.userId), true);
  assert.equal(isUnderSubject(`${USER_B.userId}${SEP}POST${SEP}/messages`, USER_A.userId), false);
});

/**
 * GY-R34（#19 片2 / 迁移 0035）：**媒体行物理删除**迁移文件的形状契约。
 *
 * ## 这条测试为什么存在
 * `public.media` 对运行时角色**没有**表级 DELETE，而且那是一条书面裁定（`20-login-roles.sql`
 * 段 M 的 `\echo`：「media 故意不授 DELETE —— 删除是状态机…不物理删。」）。0035 是唯一一次
 * 让媒体行**真的消失**的路径，所以它的安全性不靠"调用方守规矩"，只靠三处硬编码事实：
 *   ① 入队先于删行（缺 `media_object_cleanup` 意图行 ⇒ `G0007` 整批不删）；
 *   ② 只删终态（`state IN ('rejected','deleted')`）；
 *   ③ 不越过别人的引用（`content_media_refs` / `community_media_grants` / 头像三面都留原地）。
 * 这三条**只存在于函数体谓词里**——一旦有人在评审时删掉一个 `EXISTS`、或把 `IN` 列表放宽成
 * `'ready'`，真库上不会有任何断言变红（`90-assert` 管的是 ACL，不是函数体语义），
 * 而后果是永久无主孤儿或删掉别人正在用的头像。故此处把它钉成**纯静态**结构契约。
 *
 * ## 为什么是静态文本而不是 PGlite
 * 本仓有些迁移测试用 PGlite（内存 PostgreSQL 内核）真跑 DDL。这里刻意不用：
 *   · 本函数的价值全在**谓词形状**，不跑数据也能判（真跑语义要靠真库臂
 *     `tests/integration/media-row-purge-pg.mjs`，未设 `GY_PG_BIN` 时 EXITCODE=77=未取得）；
 *   · 静态臂在**没有 node_modules 的树**里也能跑（`node --test` 零依赖），不会被依赖缺失
 *     静默跳过——那正是"假的绿"。
 *
 * ## 判据形态
 * `collectForwardViolations` / `collectRollbackViolations` / `collectGrantViolations` 三个
 * **纯函数**返回问题清单（空 = 合格）。把判定写成"返回清单"而不是直接 assert，是为了让每条
 * 判据都能被**负控制**打一遍（见最后一个 test：逐条破坏必须逐条判红）。
 * ⛔ 不要把这些判据换成"文件里出现过某字符串就绿"——那测不出极性（NOT EXISTS 改成 EXISTS 会照样绿）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FORWARD_URL = new URL('../../services/api/db/migrations/0035_r34_media_row_purge.sql', import.meta.url);
const ROLLBACK_URL = new URL(
  '../../services/api/db/migrations/rollback/0035_r34_media_row_purge.down.sql',
  import.meta.url,
);
const ROLES_URL = new URL('../../deploy/postgres-cvm/sql/20-login-roles.sql', import.meta.url);

const forward = readFileSync(FORWARD_URL, 'utf8');
const rollback = readFileSync(ROLLBACK_URL, 'utf8');
const roles = readFileSync(ROLES_URL, 'utf8');

/**
 * 去掉整行注释。
 *
 * 为什么必须去：本迁移的头注释里**故意**写着 `GRANT`、`deleting`、`ready` 这些词来讲道理，
 * 拿原文做关键字判据会把文档当成违规（也会让"删掉注释里的说明"变成假红）。
 */
function stripComments(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

const forwardCode = stripComments(forward);

/** 三条引用面：必须**同时**出现在目标集（NOT EXISTS）与跳过读数（EXISTS）里。 */
const REFERENCE_SURFACES = [
  { table: 'public.content_media_refs', note: '社区内容引用' },
  { table: 'public.community_media_grants', note: '取图授权' },
  { table: 'public.public_authors', note: '作者头像（avatar_media_id，无外键）' },
];

/** 只允许删这两张表：任何别的 `DELETE FROM` 都判违规。 */
const ALLOWED_DELETE_TARGETS = ['public.media', 'public.media_derivatives'];

/**
 * 正向迁移的形状判据。返回 `string[]`（空 = 合格）。
 * 每条消息都点名**缺了什么**，因为"不一致"三个字在 CI 日志里没法定位。
 */
export function collectForwardViolations(sql) {
  const bad = [];
  const code = stripComments(sql);

  // ---- A. 三件套 + 返回类型（与 0034 同形；少一件就是可劫持的 SECURITY DEFINER）----
  if (!/SECURITY\s+DEFINER/.test(code)) bad.push('缺少 SECURITY DEFINER');
  if (!/SET\s+search_path\s*=\s*pg_catalog/.test(code)) bad.push('缺少 SET search_path = pg_catalog');
  if (!/SET\s+TimeZone\s*=\s*'UTC'/.test(code)) bad.push('缺少 SET TimeZone = ' + "'UTC'");
  if (!/LANGUAGE\s+plpgsql/.test(code)) bad.push('缺少 LANGUAGE plpgsql');
  if (!/CREATE\s+FUNCTION\s+public\.purge_owner_media\s*\(\s*p_owner\s+uuid\s*\)/.test(code)) {
    bad.push('缺少 CREATE FUNCTION public.purge_owner_media(p_owner uuid)');
  }
  if (!/RETURNS\s+jsonb/.test(code)) bad.push('缺少 RETURNS jsonb');
  if (!/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.purge_owner_media\s*\(\s*uuid\s*\)\s+FROM\s+PUBLIC/.test(code)) {
    bad.push('缺少 REVOKE ALL ON FUNCTION public.purge_owner_media(uuid) FROM PUBLIC');
  }

  // ---- B. 参数域自检（NULL 主体是调用错误，不是"没有目标"）----
  if (!/IF\s+p_owner\s+IS\s+NULL\s+THEN/.test(code)) bad.push('缺少 p_owner IS NULL 的参数域自检');
  if (!/ERRCODE\s*=\s*'G0001'/.test(code) || !/'INVALID_REQUEST'/.test(code)) {
    bad.push('缺少 G0001 / INVALID_REQUEST（本仓 0016/0017/0031/0034 同码同义）');
  }

  // ---- C. 硬条件 ①：入队先于删行（G0007，整批不删）----
  if (!/'G0007'/.test(code) || !/'MEDIA_CLEANUP_NOT_QUEUED'/.test(code)) {
    bad.push('缺少 G0007 / MEDIA_CLEANUP_NOT_QUEUED（硬条件①：队列没写好就整批不删）');
  }
  if (!/public\.media_object_cleanup/.test(code)) {
    bad.push('缺少 public.media_object_cleanup（硬条件①的唯一依据是 0029 的台账）');
  }
  // 队列校验必须发生在两条 DELETE **之前**：先删后校验等于没校验。
  const queueGuardAt = code.search(/'G0007'/);
  const firstDeleteAt = code.search(/DELETE\s+FROM\s+public\./);
  if (queueGuardAt < 0 || firstDeleteAt < 0 || queueGuardAt > firstDeleteAt) {
    bad.push('G0007 校验必须在任何 DELETE 之前（先删后校验 = 没有校验）');
  }

  // ---- D. 硬条件 ②：只删终态；其余状态一个字都不许出现在 DELETE 谓词里 ----
  const terminalIn = code.match(/state\s+IN\s*\(\s*'rejected'\s*,\s*'deleted'\s*\)/g) ?? [];
  if (terminalIn.length !== 2) {
    bad.push(`「state IN ('rejected','deleted')」应恰好出现 2 次（目标集 + 跳过读数），实际 ${terminalIn.length}`);
  }
  for (const state of ['initiated', 'uploaded', 'processing', 'ready', 'deleting']) {
    if (code.includes(`'${state}'`)) {
      bad.push(`代码里出现非终态 '${state}'：目标集只能含 rejected/deleted（活引用还在状态机里）`);
    }
  }

  // ---- E. 硬条件 ③：三处引用面在两条查询里**极性成对**出现 ----
  // ⚠ `positive` 必须用 lookbehind 排掉 `NOT ` 前缀：`NOT EXISTS (...)` 里就含 `EXISTS (`，
  //   不排的话 `positive` 只在 `negated` 成立时才成立——极性判据退化成一条，删掉读数会照样绿。
  for (const { table, note } of REFERENCE_SURFACES) {
    const escaped = table.replace(/\./g, '\\.');
    const negated = new RegExp(`NOT\\s+EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+${escaped}\\s`);
    const positive = new RegExp(`(?<!NOT\\s)EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+${escaped}\\s`);
    if (!negated.test(code)) bad.push(`${table}（${note}）缺少 NOT EXISTS 排除：被引用的行会被删掉`);
    if (!positive.test(code)) bad.push(`${table}（${note}）缺少 EXISTS 读数：被跳过多少行将无法解释`);
  }

  // ---- F. 只删两张表；越过 users / jobs / 三张引用表一律判红 ----
  for (const match of code.matchAll(/DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_.]*)/g)) {
    if (!ALLOWED_DELETE_TARGETS.includes(match[1])) {
      bad.push(`不允许的 DELETE 目标 ${match[1]}：本片只删 ${ALLOWED_DELETE_TARGETS.join(' / ')}`);
    }
  }
  if (/\bDROP\s+TABLE\b/i.test(code)) bad.push('本片不 DROP TABLE（public.jobs 的 DROP 另立一片）');

  // ---- G. 零授权：迁移里一条 GRANT 都不许有（授权只在 20-login-roles.sql 里成对出现）----
  if (/\bGRANT\b/i.test(code)) bad.push('迁移里不允许出现 GRANT（授权面只许在 20-login-roles.sql）');

  // ---- H. 读数：jsonb 四个键（调用方要把这几个数写进注销证据串）----
  for (const key of ['media', 'derivatives', 'queued', 'skipped_referenced']) {
    if (!new RegExp(`'${key}'\\s*,`).test(code)) bad.push(`jsonb 读数缺少键 '${key}'`);
  }

  // ---- I. 单事务 ----
  const begins = code.match(/^BEGIN;$/gm) ?? [];
  const commits = code.match(/^COMMIT;$/gm) ?? [];
  if (begins.length !== 1) bad.push(`应有且仅有一处 BEGIN;，实际 ${begins.length}`);
  if (commits.length !== 1) bad.push(`应有且仅有一处 COMMIT;，实际 ${commits.length}`);

  return bad;
}

/** 回滚文件判据：只撤函数面，不伪造数据、不动表。 */
export function collectRollbackViolations(sql) {
  const bad = [];
  const code = stripComments(sql);
  if (!/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.purge_owner_media\s*\(\s*uuid\s*\)/.test(code)) {
    bad.push('回滚缺少 DROP FUNCTION IF EXISTS public.purge_owner_media(uuid)');
  }
  if (/\bDROP\s+TABLE\b/i.test(code)) bad.push('回滚不许 DROP TABLE（本迁移没建表）');
  if (/\bDELETE\s+FROM\b/i.test(code)) bad.push('回滚不许 DELETE（已删掉的媒体行不伪造恢复）');
  if (/\bCREATE\b/i.test(code)) bad.push('回滚不许 CREATE（只撤函数面）');
  if (/\bGRANT\b/i.test(code)) bad.push('回滚不许 GRANT');
  return bad;
}

/** 授权面判据：只授 EXECUTE、前置存在性、不发表级权限。 */
export function collectGrantViolations(sql) {
  const bad = [];
  const code = stripComments(sql);

  if (!/to_regprocedure\('public\.purge_owner_media\(uuid\)'\)\s+IS\s+NULL/.test(code)) {
    bad.push('缺少 to_regprocedure 前置校验：迁移未执行时必须显式失败，而不是留一个「看似收敛」的运行态');
  }
  const grants = code.match(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.purge_owner_media\s*\(\s*uuid\s*\)\s+TO\s+gengyun_api_runtime/g) ?? [];
  if (grants.length !== 1) {
    bad.push(`GRANT EXECUTE ON FUNCTION public.purge_owner_media(uuid) TO gengyun_api_runtime 应恰好 1 条，实际 ${grants.length}`);
  }
  if (/\bGRANT\s+DELETE\b/i.test(code)) {
    // ⛔ 这是本片的裁定红线：PG 没有列级 DELETE ⇒ 表级 DELETE 会把四个谓词一起送掉。
    const mediaDeletes = [...code.matchAll(/GRANT\s+DELETE\s+ON\s+([\s\S]*?)\s+TO\s+/gi)]
      .flatMap((m) => m[1].split(',').map((part) => part.trim()))
      .filter((name) => /^public\.media$/i.test(name));
    if (mediaDeletes.length > 0) bad.push('给 public.media 加了表级 GRANT DELETE（本片裁定禁止）');
  }
  return bad;
}

// ---------------------------------------------------------------------------
// 正例：三份文件都必须干净
// ---------------------------------------------------------------------------

test('迁移 0035 的形状：三件套 / 窄签名 / jsonb 读数 / 零授权 / 单事务', () => {
  assert.deepEqual(collectForwardViolations(forward), [], '正向迁移形状不合格');
});

test('迁移 0035 的三条硬条件都能在函数体里被指认', () => {
  // ① 入队先于删行：G0007 出现在两条 DELETE 之前。
  assert.match(forwardCode, /'G0007'/, '硬条件①需要 G0007');
  assert.ok(
    forwardCode.indexOf("'G0007'") < forwardCode.indexOf('DELETE FROM public.media_derivatives'),
    '硬条件①：G0007 必须在 DELETE 之前',
  );
  // ② 只删终态。
  assert.match(forwardCode, /state\s+IN\s*\(\s*'rejected'\s*,\s*'deleted'\s*\)/, '硬条件②需要终态闭集');
  // ③ 三处引用面极性成对：每处**恰好**一次排除 + 一次读数（用 lookbehind 排掉 `NOT ` 前缀，
  //    否则「读数那一处」会被「排除那一处」冒充，只剩一条判据）。
  for (const { table, note } of REFERENCE_SURFACES) {
    const escaped = table.replace(/\./g, '\\.');
    const negated = forwardCode.match(new RegExp(`NOT\\s+EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+${escaped}\\s`, 'g')) ?? [];
    const positive = forwardCode.match(new RegExp(`(?<!NOT\\s)EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+${escaped}\\s`, 'g')) ?? [];
    assert.equal(negated.length, 1, `硬条件③：${table}（${note}）在目标集里必须恰好排除一次`);
    assert.equal(positive.length, 1, `硬条件③：${table}（${note}）在跳过读数里必须恰好统计一次`);
  }
});

test('回滚 0035 的形状：DROP FUNCTION IF EXISTS，且不伪造数据、不动表', () => {
  assert.deepEqual(collectRollbackViolations(rollback), [], '回滚文件形状不合格');
});

test('授权面成对：20-login-roles.sql 只授 EXECUTE、有前置校验、没碰表级 DELETE', () => {
  assert.deepEqual(collectGrantViolations(roles), [], '授权面不合格');
  // 区域标记成对出现（本仓既有 region 约定）。
  assert.ok(roles.includes('-- #region gy-r34-i19-media-row-purge-grant'), '缺少 region 起始标记');
  assert.ok(roles.includes('-- #endregion gy-r34-i19-media-row-purge-grant'), '缺少 region 结束标记');
});

test('跨文件一致：迁移建的函数签名与授权面引用的签名逐字相同', () => {
  // 迁移里建 `(p_owner uuid)`，授权面写 `(uuid)`：两者必须指向同一个签名，否则 42883 只在真库上暴露。
  assert.match(forwardCode, /CREATE\s+FUNCTION\s+public\.purge_owner_media\s*\(\s*p_owner\s+uuid\s*\)/);
  const signatureInRoles = [...roles.matchAll(/purge_owner_media\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(signatureInRoles.length > 0, '授权面必须至少引用一次 purge_owner_media(...) 签名');
  for (const signature of signatureInRoles) {
    assert.equal(signature, 'uuid', `授权面里的签名必须是 (uuid)（形参名不进签名），实际 (${signature})`);
  }
});

// ---------------------------------------------------------------------------
// 负控制：逐条破坏必须逐条判红（否则上面的"全绿"可能只是没测东西）
// ---------------------------------------------------------------------------

/**
 * 只在**代码行**上做替换。
 *
 * 为什么必须有这一层：本迁移的头注释里**故意**写着 `SECURITY DEFINER` / `SET search_path =
 * pg_catalog` / `SET TimeZone = 'UTC'` 这些词来讲道理。直接对全文 `replace` 会先命中注释、
 * 代码一个字没动，负控制就变成"改了注释所以必红"的假绿（第一次写这条负控制时正是如此：
 * 「去掉 SECURITY DEFINER」被判全绿，因为删掉的是第 35 行注释里的那个词）。
 */
function mutateCode(sql, pattern, replacement) {
  return sql
    .split('\n')
    .map((line) => (/^\s*--/.test(line) ? line : line.replace(pattern, replacement)))
    .join('\n');
}

test('负控制：破坏任意一条硬条件/铁律都必须被点名', () => {
  const mutations = [
    ['去掉 SECURITY DEFINER', mutateCode(forward, 'SECURITY DEFINER', ''), /SECURITY DEFINER/],
    ['去掉 search_path 固定', mutateCode(forward, 'SET search_path = pg_catalog', ''), /search_path/],
    ['去掉 TimeZone 固定', mutateCode(forward, "SET TimeZone = 'UTC'", ''), /TimeZone/],
    [
      '去掉 REVOKE ALL',
      mutateCode(forward, 'REVOKE ALL ON FUNCTION public.purge_owner_media(uuid) FROM PUBLIC;', ''),
      /REVOKE ALL/,
    ],
    ['去掉 G0007 队列校验', mutateCode(forward, "'G0007'", "'G0099'"), /G0007/],
    [
      '把终态闭集放宽到 ready',
      mutateCode(forward, /state IN \('rejected', 'deleted'\)/g, "state IN ('rejected', 'deleted', 'ready')"),
      /ready/,
    ],
    [
      '目标集漏掉头像引用面',
      mutateCode(forward, 'AND NOT EXISTS (SELECT 1 FROM public.public_authors a WHERE a.avatar_media_id = m.id)', ''),
      /public_authors/,
    ],
    [
      '跳过读数漏掉取图授权',
      mutateCode(forward, 'OR EXISTS (SELECT 1 FROM public.community_media_grants g WHERE g.media_id = m.id)', ''),
      /community_media_grants/,
    ],
    ['读数少一个键', mutateCode(forward, "'skipped_referenced', x_skipped", "'skipped', x_skipped"), /skipped_referenced/],
    [
      '偷偷加一条 GRANT',
      mutateCode(forward, 'COMMIT;', 'GRANT DELETE ON public.media TO gengyun_api_runtime;\n\nCOMMIT;'),
      /GRANT/,
    ],
    ['偷偷加 DROP TABLE', mutateCode(forward, 'COMMIT;', 'DROP TABLE public.media;\n\nCOMMIT;'), /DROP TABLE/],
    ['删掉 RETURN jsonb 改 void', mutateCode(forward, 'RETURNS jsonb', 'RETURNS void'), /RETURNS jsonb/],
  ];
  for (const [label, mutated, expected] of mutations) {
    assert.notEqual(mutated, forward, `负控制「${label}」没改动任何字节（替换锚点已漂移，负控制失效）`);
    const bad = collectForwardViolations(mutated);
    assert.ok(bad.length > 0, `负控制「${label}」应当判红，实际全绿`);
    assert.ok(
      bad.some((line) => expected.test(line)),
      `负控制「${label}」的报错没有点名预期项 ${expected}：${bad.join(' / ')}`,
    );
  }
});

test('负控制：回滚与授权面被破坏时同样判红', () => {
  const badRollback = collectRollbackViolations(
    rollback.replace('DROP FUNCTION IF EXISTS public.purge_owner_media(uuid);', 'DROP TABLE public.media;'),
  );
  assert.ok(badRollback.some((line) => /DROP TABLE/.test(line)), '回滚改成 DROP TABLE 必须判红');
  assert.ok(badRollback.some((line) => /DROP FUNCTION/.test(line)), '回滚丢了 DROP FUNCTION 必须判红');

  const badGrant = collectGrantViolations(roles.replace("to_regprocedure('public.purge_owner_media(uuid)') IS NULL", 'true'));
  assert.ok(badGrant.some((line) => /to_regprocedure/.test(line)), '授权面丢了前置校验必须判红');

  const mediaDeleteGrant = collectGrantViolations(
    `${roles}\nGRANT DELETE ON public.media TO gengyun_api_runtime;\n`,
  );
  assert.ok(
    mediaDeleteGrant.some((line) => /public\.media 加了表级 GRANT DELETE/.test(line)),
    '给 public.media 加表级 GRANT DELETE 必须判红（本片裁定禁止）',
  );
});

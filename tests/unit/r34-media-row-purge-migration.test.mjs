/**
 * GY-R34（#19 片2 / 迁移 0035）：**媒体行物理删除**迁移文件的形状契约。
 *
 * ## 这条测试为什么存在
 * `public.media` 对运行时角色**没有**表级 DELETE，而且那是一条书面裁定（`20-login-roles.sql`
 * 段 M 的 `\echo`：「media 故意不授 DELETE —— 删除是状态机…不物理删。」）。0035 是唯一一次
 * 让媒体行**真的消失**的路径，所以它的安全性不靠"调用方守规矩"，只靠三处硬编码事实：
 *   ① 入队先于删行（缺 `media_object_cleanup` 意图行 ⇒ `G0007` 整批不删）；
 *   ② 只删终态（`state IN ('rejected','deleted')`）；
 *   ③ **不越过任何一处引用**（**11 列 / 8 类**引用面全部留原地）。
 * 这三条**只存在于函数体谓词里**——一旦有人在评审时删掉一个 `EXISTS`、或把 `IN` 列表放宽成
 * `'ready'`，真库上不会有任何断言变红（`90-assert` 管的是 ACL，不是函数体语义），
 * 而后果是永久无主孤儿，或一串**悬空 media uuid**（第 4–11 处没有外键 ⇒ 数据库连 23503
 * 都不会报，删了也查不回来）。故此处把它钉成**纯静态**结构契约。
 *
 * ## 判据形态：列级逐条，不数总数
 * 引用面清单是**列级 11 条**（`REFERENCE_SURFACES`），每条按「表名 + 别名 + 列条件」拼成**完整
 * SQL 片段**再计数：
 *   · 目标集里必须**恰好一次** `NOT EXISTS (… )`；
 *   · 同一条 `EXISTS (… )`（不含 `NOT`）在整个文件里必须**恰好两次** —— 一次被 `NOT` 包住、
 *     一次在分层读数的子查询里。
 * ⛔ 不许退化成「文件里 `NOT EXISTS` 至少出现 N 次」：那种写法删掉**任何一条**都还能过，
 * 而删掉的后果正是本测试存在的理由。负数/下标写法（`ANY`、`p.media_ids[1]`）同理逐条钉。
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
 * 判据都能被**负控制**打一遍（见负控制 test：逐条破坏必须逐条判红）。
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
 * 为什么必须去：本迁移的头注释里**故意**写着 `GRANT`、`deleting`、`ready`、`LOCK TABLE` 这些词
 * 来讲道理（也逐个列了 11 处引用面的 `表.列`），拿原文做关键字判据会把文档当成违规。
 */
function stripComments(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

/** 把连续空白压成一个空格：判据按**内容**钉死，不因换行/缩进漂移而假红。 */
function squash(sql) {
  return sql.replace(/\s+/g, ' ');
}

/** 子串出现次数（`split` 计数，不做正则解释）。 */
function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const forwardCode = stripComments(forward);

/**
 * 引用面清单：**列级 11 条**（迁移:列 → 桶）。
 * 桶是**聚合口径**（调用方用它判断「该先跑哪个模块」），列是**判定口径**（每一列都必须真被排除）。
 * 8 个桶：content / grants / avatar / user_avatar / ocr / recognition / speech / community。
 */
const REFERENCE_SURFACES = [
  {
    bucket: 'content',
    table: 'public.content_media_refs',
    alias: 'r',
    condition: 'r.media_id = m.id',
    note: '社区内容引用（0001:298，有外键、无级联）',
  },
  {
    bucket: 'grants',
    table: 'public.community_media_grants',
    alias: 'g',
    condition: 'g.media_id = m.id',
    note: '取图授权（0001:315，有外键、无级联）',
  },
  {
    bucket: 'avatar',
    table: 'public.public_authors',
    alias: 'a',
    condition: 'a.avatar_media_id = m.id',
    note: '作者头像（0001:236，无外键）',
  },
  {
    bucket: 'user_avatar',
    table: 'public.users',
    alias: 'u',
    condition: 'u.avatar_media_id = m.id',
    note: '账号头像（0001:40，无外键）',
  },
  {
    bucket: 'ocr',
    table: 'public.ocr_jobs',
    alias: 'j',
    condition: 'j.media_id = m.id',
    note: 'OCR 任务（0024:90，无外键）',
  },
  {
    bucket: 'ocr',
    table: 'public.ocr_records',
    alias: 'j',
    condition: 'j.media_id = m.id',
    note: 'OCR 记录（0024:113，无外键）',
  },
  {
    bucket: 'recognition',
    table: 'public.recognition_jobs',
    alias: 'j',
    condition: 'j.media_id = m.id',
    note: '识别任务（0025:113，无外键）',
  },
  {
    bucket: 'recognition',
    table: 'public.recognition_records',
    alias: 'j',
    condition: 'j.media_id = m.id',
    note: '识别记录（0025:135，无外键）',
  },
  {
    bucket: 'speech',
    table: 'public.speech_jobs',
    alias: 'j',
    condition: 'j.media_id = m.id',
    note: '语音任务（0026:95，无外键）',
  },
  {
    bucket: 'speech',
    table: 'public.transcriptions',
    alias: 'j',
    condition: 'j.media_id = m.id',
    note: '转写记录（0026:116，无外键）',
  },
  {
    bucket: 'community',
    table: 'public.community_posts',
    alias: 'p',
    condition: 'm.id::text = ANY (p.media_ids)',
    note: '社区帖子 media_ids（0022:70，text[] 数组、无外键）',
  },
];

/** 桶的闭集与**声明顺序**（读数里 `skipped_referenced_by` 的键序、FILTER 与 INTO 的顺序都按它）。 */
const REFERENCE_BUCKETS = ['content', 'grants', 'avatar', 'user_avatar', 'ocr', 'recognition', 'speech', 'community'];

/** 一条引用面的两条正负片段（`NOT ` 前缀是唯一的差别 ⇒ 极性判据不会自我满足）。 */
function surfaceFragments({ table, alias, condition }) {
  const positive = `EXISTS (SELECT 1 FROM ${table} ${alias} WHERE ${condition})`;
  return { positive, negated: `NOT ${positive}` };
}

/** 只允许删这两张表：任何别的 `DELETE FROM` 都判违规。 */
const ALLOWED_DELETE_TARGETS = ['public.media', 'public.media_derivatives'];

/**
 * 正向迁移的形状判据。返回 `string[]`（空 = 合格）。
 * 每条消息都点名**缺了什么**，因为"不一致"三个字在 CI 日志里没法定位。
 */
export function collectForwardViolations(sql) {
  const bad = [];
  const code = stripComments(sql);
  const flat = squash(code);

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

  // ---- E. 硬条件 ③：**11 列**引用面逐条「一处 NOT EXISTS + 一处读数」----
  // 逐列拼完整片段再计数：删掉任何一条 NOT EXISTS ⇒ 被引用的行会被删成悬空 uuid（无外键时
  // 数据库不会报错）；删掉任何一处读数 EXISTS ⇒ 分层计数少报、调用方看不出该先跑哪个模块。
  for (const surface of REFERENCE_SURFACES) {
    const { positive, negated } = surfaceFragments(surface);
    const negatedCount = occurrences(flat, negated);
    const positiveCount = occurrences(flat, positive);
    if (negatedCount !== 1) {
      bad.push(
        `${surface.table}（${surface.note}）在目标集里应恰好 NOT EXISTS 一次，实际 ${negatedCount}：`
          + '被它引用的行会被删成悬空 media uuid',
      );
    }
    if (positiveCount !== 2) {
      bad.push(
        `${surface.table}（${surface.note}）的 EXISTS 应恰好出现 2 次（NOT EXISTS 内 1 次 + 读数子查询 1 次），`
          + `实际 ${positiveCount}：少的那一处会让分层跳过计数少报`,
      );
    }
  }

  // ---- E2. 数组列不许退化成猜格式（拼接 / LIKE / position / 取下标）----
  for (const banned of ['|| p.media_ids', 'LIKE', 'position(', 'p.media_ids[', 'p.media_ids @>']) {
    if (flat.includes(banned)) {
      bad.push(`community_posts.media_ids 的比较里出现被禁止的写法「${banned}」：必须是 m.id::text = ANY (p.media_ids)`);
    }
  }

  // ---- E3. 分层读数：8 个桶各一条 FILTER，顺序与闭集逐字一致 ----
  const filterSequence = [...flat.matchAll(/count\(\*\) FILTER \(WHERE t\.(ref_[a-z_]+)\)/g)].map((m) => m[1]);
  const expectedFilters = REFERENCE_BUCKETS.map((bucket) => `ref_${bucket}`);
  if (filterSequence.join(',') !== expectedFilters.join(',')) {
    bad.push(
      `分层 FILTER 的顺序/闭集应逐字为 [${expectedFilters.join(', ')}]，实际 [${filterSequence.join(', ')}]：`
        + '顺序错位会把一类引用记到另一类头上',
    );
  }
  // 桶别名必须真的在子查询里定义（否则 FILTER 引用的列不存在，函数根本建不起来）。
  for (const bucket of REFERENCE_BUCKETS) {
    if (occurrences(flat, `AS ref_${bucket}`) !== 1) {
      bad.push(`子查询缺少桶别名 AS ref_${bucket}（或者出现了不止一次）`);
    }
    if (occurrences(flat, `x_ref_${bucket} integer := 0;`) !== 1) {
      bad.push(`DECLARE 里缺少 x_ref_${bucket} integer := 0;（分层计数的落点）`);
    }
  }
  // `skipped_referenced` 必须是 8 个桶的 OR（少一个桶 ⇒ 那一类引用会被"看不见地"跳过）。
  const chainMatch = flat.match(/count\(\*\) FILTER \(WHERE (t\.ref_[a-z_]+(?: OR t\.ref_[a-z_]+)+)\)/);
  const chain = chainMatch ? chainMatch[1].split(' OR ') : [];
  const expectedChain = expectedFilters.map((filter) => `t.${filter}`);
  if (chain.join(',') !== expectedChain.join(',')) {
    bad.push(
      `skipped_referenced 的 OR 链应逐字为 [${expectedChain.join(', ')}]，实际 [${chain.join(', ')}]：`
        + '「community」等桶漏进 OR 链会让总数少报',
    );
  }
  // SELECT 的 9 个输出必须按同一顺序落进 9 个变量（错位 = 把 OCr 的数记成语音的数）。
  const intoExpected = [
    ...REFERENCE_BUCKETS.map((bucket) => `x_ref_${bucket}`),
    'x_skipped',
  ].join(', ');
  if (occurrences(flat, `INTO ${intoExpected}`) !== 1) {
    bad.push(`分层读数的 INTO 目标应逐字为 [${intoExpected}]：错位会把一类引用记到另一类头上`);
  }

  // ---- F. 只删两张表；越过 users / jobs / 引用表一律判红 ----
  for (const match of code.matchAll(/DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_.]*)/g)) {
    if (!ALLOWED_DELETE_TARGETS.includes(match[1])) {
      bad.push(`不允许的 DELETE 目标 ${match[1]}：本片只删 ${ALLOWED_DELETE_TARGETS.join(' / ')}`);
    }
  }
  if (/\bDROP\s+TABLE\b/i.test(code)) bad.push('本片不 DROP TABLE（public.jobs 的 DROP 另立一片）');

  // ---- G. 零授权：迁移里一条 GRANT 都不许有（授权只在 20-login-roles.sql 里成对出现）----
  if (/\bGRANT\b/i.test(code)) bad.push('迁移里不允许出现 GRANT（授权面只许在 20-login-roles.sql）');

  // ---- H. 读数：jsonb 键（调用方要把这几个数写进注销证据串）----
  for (const key of ['media', 'derivatives', 'queued', 'skipped_referenced', 'skipped_referenced_by']) {
    if (!new RegExp(`'${key}'\\s*,`).test(code)) bad.push(`jsonb 读数缺少键 '${key}'`);
  }
  // 分层键必须**每个桶一个**且落进同名变量（摊平成一个数就等于没分层）。
  for (const bucket of REFERENCE_BUCKETS) {
    if (!flat.includes(`'${bucket}', x_ref_${bucket}`)) {
      bad.push(`skipped_referenced_by 里缺少 '${bucket}': x_ref_${bucket}（分层计数没接到读数上）`);
    }
  }

  // ---- I. 单事务 ----
  const begins = code.match(/^BEGIN;$/gm) ?? [];
  const commits = code.match(/^COMMIT;$/gm) ?? [];
  if (begins.length !== 1) bad.push(`应有且仅有一处 BEGIN;，实际 ${begins.length}`);
  if (commits.length !== 1) bad.push(`应有且仅有一处 COMMIT;，实际 ${commits.length}`);

  // ---- J. 逐桶**列集合绑定**（不只比总数/顺序）----
  // 为什么单列一条：E3 钉的是 FILTER 顺序、INTO 顺序与 OR 链，**聚合体本身没有任何判据**。
  // 把 `ref_ocr` 与 `ref_speech` 的 EXISTS 整块对调（只换桶标签、列不动）之后，E/E2/E3 全绿、
  // 总数不变 ⇒ 真库上 OCR 的数会记进语音桶，调用方按读数「先跑语音」，而真正该跑的 OCR
  // 压根没有清理器。所以桶与列必须**逐桶**对上，不能只对总账。
  const bucketBlock = flat.match(/SELECT EXISTS \(SELECT 1 FROM public\.[\s\S]*?\) t;/);
  if (!bucketBlock) {
    bad.push('找不到分层读数的派生表子查询（`SELECT EXISTS (…) … ) t;`）：8 个桶的落点无法校验');
  } else {
    // 派生表尾部的 `FROM public.media m WHERE …` 属于外层扫描，不属于任何桶：先切掉再分段。
    const body = bucketBlock[0].split(/\sFROM public\.media m\b/)[0];
    const segments = new Map();
    const parts = body.split(/AS ref_([a-z_]+)/);
    for (let i = 1; i < parts.length; i += 2) {
      const bucket = parts[i];
      if (segments.has(bucket)) bad.push(`派生表里桶 ref_${bucket} 出现了不止一次`);
      // 一个桶的子查询就是**它自己的标签之前**那一段（`AS ref_x` 后缀式）。
      segments.set(bucket, parts[i - 1]);
    }
    for (const bucket of REFERENCE_BUCKETS) {
      const surfaces = REFERENCE_SURFACES.filter((surface) => surface.bucket === bucket);
      const expectedTables = surfaces.map((surface) => `${surface.table} ${surface.alias}`);
      const segment = segments.get(bucket);
      if (segment === undefined) {
        bad.push(`派生表里缺少桶 ref_${bucket} 的子查询（该桶的引用会被记成 0）`);
        continue;
      }
      for (const surface of surfaces) {
        const fragment = `FROM ${surface.table} ${surface.alias} WHERE ${surface.condition}`;
        if (!segment.includes(fragment)) {
          bad.push(
            `桶 ref_${bucket} 的子查询里缺少「${fragment}」：桶与列**绑错了**`
              + `（${bucket} 桶必须正好覆盖 [${expectedTables.join(', ')}]）`,
          );
        }
      }
      const found = [...segment.matchAll(/FROM (public\.[a-z_]+) ([a-z]+) WHERE/g)]
        .map((m) => `${m[1]} ${m[2]}`);
      if (found.join(' | ') !== expectedTables.join(' | ')) {
        bad.push(
          `桶 ref_${bucket} 读的列集合应逐字为 [${expectedTables.join(', ')}]，实际 [${found.join(', ')}]：`
            + '列集合与桶绑错会把一类引用记到另一类头上（总数不变 ⇒ 只比总数抓不住）',
        );
      }
    }
  }

  // ---- K. 队列守卫的**位置 + 形态**（复审自测 M3/M4 的补丁）----
  // M3「把守卫整块搬到两条 DELETE 之后」与 M4「把条件改成 IF false」在 A–J 之外都能蒙过：
  // 前者只在 `'G0007'` 仍早于 DELETE 时才由 C 兜住（守卫文本可被拆开写绕过），后者干脆一条判据都不碰。
  const guardShape = /IF x_unqueued > 0 THEN RAISE EXCEPTION USING ERRCODE = 'G0007'/;
  if (!guardShape.test(flat)) {
    bad.push(
      "队列守卫必须逐字为「IF x_unqueued > 0 THEN RAISE EXCEPTION USING ERRCODE = 'G0007'」"
        + '：恒真/恒假条件、拆成两句、或先 RAISE 后判断，都等于没有入队检查',
    );
  }
  if (/\bIF (?:false|true)\b/i.test(flat)) {
    bad.push('函数体里出现恒真/恒假 IF：守卫被短路了（`IF false THEN RAISE …` 只是装饰）');
  }
  const unqueuedCountAt = flat.indexOf('SELECT count(*) INTO x_unqueued');
  const guardAt = flat.search(guardShape);
  const firstDeleteInFlat = flat.search(/DELETE FROM public\./);
  if (unqueuedCountAt < 0) bad.push('缺少 `SELECT count(*) INTO x_unqueued`（硬条件①的计数没落点）');
  if (guardAt >= 0) {
    if (unqueuedCountAt > guardAt) bad.push('x_unqueued 的计数必须排在守卫之前（先算再判，不能先判后算）');
    if (firstDeleteInFlat < 0 || guardAt > firstDeleteInFlat) {
      bad.push('队列守卫（G0007）必须排在**所有** DELETE 之前：守卫挪到删行之后等于没有守卫');
    }
  }

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
    // ⛔ 这是本片的裁定红线：PG 没有列级 DELETE ⇒ 表级 DELETE 会把所有谓词一起送掉。
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
  const flat = squash(forwardCode);
  // ① 入队先于删行：G0007 出现在两条 DELETE 之前。
  assert.match(forwardCode, /'G0007'/, '硬条件①需要 G0007');
  assert.ok(
    forwardCode.indexOf("'G0007'") < forwardCode.indexOf('DELETE FROM public.media_derivatives'),
    '硬条件①：G0007 必须在 DELETE 之前',
  );
  // ② 只删终态。
  assert.match(forwardCode, /state\s+IN\s*\(\s*'rejected'\s*,\s*'deleted'\s*\)/, '硬条件②需要终态闭集');
  // ③ 11 列引用面逐条：目标集里否定一次、读数里肯定一次（总数 2 = 1 否定 + 1 肯定）。
  assert.equal(REFERENCE_SURFACES.length, 11, '引用面清单必须是 11 列（3 处既有 + 7 处补强 + users 头像）');
  for (const surface of REFERENCE_SURFACES) {
    const { positive, negated } = surfaceFragments(surface);
    assert.equal(
      occurrences(flat, negated),
      1,
      `硬条件③：${surface.table}（${surface.note}）在目标集里必须恰好排除一次`,
    );
    assert.equal(
      occurrences(flat, positive),
      2,
      `硬条件③：${surface.table}（${surface.note}）必须同时出现在目标集（被 NOT 包住）与读数子查询里`,
    );
  }
  // 删行的三段顺序不许变：派生行先、媒体行后，且都在 G0007 之后。
  const derivativesDeleteAt = flat.indexOf('DELETE FROM public.media_derivatives');
  const mediaDeleteAt = flat.indexOf('DELETE FROM public.media m');
  assert.ok(derivativesDeleteAt > 0, '缺少 DELETE FROM public.media_derivatives');
  assert.ok(mediaDeleteAt > derivativesDeleteAt, '派生行必须排在媒体行之前删除');
  assert.ok(flat.indexOf("'G0007'") < derivativesDeleteAt, '两条 DELETE 都必须在 G0007 之后');
});

test('分层计数：8 个桶各一条 FILTER，OR 链与 INTO 顺序与闭集一致', () => {
  assert.deepEqual(REFERENCE_BUCKETS.length, 8, '桶闭集必须是 8 类');
  assert.deepEqual(
    [...new Set(REFERENCE_SURFACES.map((surface) => surface.bucket))],
    REFERENCE_BUCKETS,
    '11 列必须恰好覆盖 8 个桶，且桶的顺序与闭集一致',
  );
  const flat = squash(forwardCode);
  const filters = [...flat.matchAll(/count\(\*\) FILTER \(WHERE t\.(ref_[a-z_]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(filters, REFERENCE_BUCKETS.map((bucket) => `ref_${bucket}`), 'FILTER 顺序必须与桶闭集一致');
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
 * pg_catalog` / `SET TimeZone = 'UTC'` / 11 处 `表.列` 这些词来讲道理。直接对全文 `replace`
 * 会先命中注释、代码一个字没动，负控制就变成"改了注释所以必红"的假绿。
 */
function mutateCode(sql, pattern, replacement) {
  return sql
    .split('\n')
    .map((line) => (/^\s*--/.test(line) ? line : line.replace(pattern, replacement)))
    .join('\n');
}

/**
 * 把 `[start, end]` 这几行（0 基、闭区间）整块搬到 `before` 行之前，其余行序不变。
 *
 * 为什么要一个"搬行"helper：负控制要证明的是**位置**判据，而位置是行的属性；用字符串 `replace`
 * 搬代码块既要求缩进逐字对得上，也容易在还原时留下多余空行 —— 那样"逐字节还原 ⇒ 绿"就变成
 * "差不多还原 ⇒ 绿"，证明力归零。
 */
function moveLineRange(sql, start, end, before) {
  const lines = sql.split('\n');
  const block = lines.splice(start, end - start + 1);
  const target = before > start ? before - block.length : before;
  lines.splice(target, 0, ...block);
  return lines.join('\n');
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
    // ---- 以下 7 条是**本版新增**引用面的负控制：每一条都对应一个真实的漏删路径 ----
    [
      '目标集漏掉作者头像引用面',
      mutateCode(forward, 'AND NOT EXISTS (SELECT 1 FROM public.public_authors a WHERE a.avatar_media_id = m.id)', ''),
      /public_authors/,
    ],
    [
      '目标集漏掉 OCR 记录引用面（删掉一条 NOT EXISTS ⇒ 必须红）',
      mutateCode(forward, 'AND NOT EXISTS (SELECT 1 FROM public.ocr_records j WHERE j.media_id = m.id)', ''),
      /public\.ocr_records/,
    ],
    [
      '目标集漏掉账号头像引用面（无写入方也不许漏）',
      mutateCode(forward, 'AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.avatar_media_id = m.id)', ''),
      /public\.users/,
    ],
    [
      '把数组列条件写坏（只取第一个元素 ⇒ 必须红）',
      mutateCode(forward, 'm.id::text = ANY (p.media_ids)', 'm.id::text = p.media_ids[1]'),
      /community_posts/,
    ],
    [
      '把转写记录从「跳过」改成「继续删」（删掉读数那一处 EXISTS ⇒ 必须红）',
      mutateCode(forward, 'OR EXISTS (SELECT 1 FROM public.transcriptions j WHERE j.media_id = m.id)', ''),
      /public\.transcriptions/,
    ],
    [
      // lookbehind 排掉目标集那一行：`AND NOT EXISTS (…)` 里也含 `EXISTS (…)`，直接拿字符串删
      // 会把两处一起删掉，负控制就变成「一次改两处」，说不清是哪条判据红了。
      '跳过读数漏掉取图授权（只删读数子查询里那一处 EXISTS）',
      mutateCode(
        forward,
        /(?<!NOT )EXISTS \(SELECT 1 FROM public\.community_media_grants g WHERE g\.media_id = m\.id\)/,
        '',
      ),
      /community_media_grants/,
    ],
    [
      '把 community 桶从 skipped_referenced 的 OR 链里删掉',
      mutateCode(forward, 'OR t.ref_ocr OR t.ref_recognition OR t.ref_speech OR t.ref_community)', 'OR t.ref_ocr OR t.ref_recognition OR t.ref_speech)'),
      /community/,
    ],
    [
      '把 INTO 目标顺序打乱（ocr 与 speech 对调）',
      mutateCode(forward, 'x_ref_ocr, x_ref_recognition, x_ref_speech, x_ref_community, x_skipped', 'x_ref_speech, x_ref_recognition, x_ref_ocr, x_ref_community, x_skipped'),
      /INTO/,
    ],
    [
      '把分层读数摊平成一个键',
      mutateCode(forward, "'skipped_referenced_by'", "'skipped_total'"),
      /skipped_referenced_by/,
    ],
    [
      '读数少一个键',
      mutateCode(forward, "'skipped_referenced',    x_skipped", "'skipped',    x_skipped"),
      /skipped_referenced/,
    ],
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

test('负控制：逐桶列绑定与守卫形态（改坏必红，逐字节还原必绿）', () => {
  // 这一组对应复审自测的 M2b / M3 / M4：三条在旧判据下**都是 GREEN**（真实盲区，不是措辞问题）。
  // 每条都做双向证明：改坏 ⇒ 必须被**点名**；逆变换逐字节还原 ⇒ 必须重新全绿。
  // 只证明"改坏会红"是不够的 —— 一个恒报错的判据也能让负控制全红，却毫无防守力。
  //
  // ⚠ 文案限定：「（全绿）」在这组里只表示**改坏后没被点名**，不表示代码没问题。极端情形是 forward 基线本身已被改坏
  // （主正例先红）——此时「桶对调」会二次对调抵消，本条照样打印「（全绿）」。行为是 fail-closed（确实红了），
  // 但读数顺序必须是：先看主正例，再看本条。
  const RED_HINT = '（若主正例已红，先看主正例再看本条：「（全绿）」只说明改坏没被点名）';

  // ---- M2b：ocr 桶 ↔ speech 桶整块对调（只换桶标签，列一个字没动，总数不变）----
  const swapBuckets = (sql) =>
    mutateCode(
      mutateCode(mutateCode(sql, 'AS ref_ocr', 'AS ref_swap'), 'AS ref_speech', 'AS ref_ocr'),
      'AS ref_swap',
      'AS ref_speech',
    );
  const swapped = swapBuckets(forward);
  assert.notEqual(swapped, forward, '桶对调没改动任何字节（锚点已漂移，负控制失效）');
  const swappedBad = collectForwardViolations(swapped);
  assert.ok(
    swappedBad.some((line) => /桶 ref_ocr/.test(line) && /绑错|列集合/.test(line)),
    `「ocr 桶 ↔ speech 桶对调」必须由逐桶绑定判据点名 ref_ocr，实际：${swappedBad.join(' / ') || '（全绿）'}${RED_HINT}`,
  );
  assert.ok(
    swappedBad.some((line) => /桶 ref_speech/.test(line)),
    `对调必须同时点名 ref_speech，实际：${swappedBad.join(' / ') || '（全绿）'}${RED_HINT}`,
  );
  const swappedBack = swapBuckets(swapped);
  assert.equal(swappedBack, forward, '逆变换必须**逐字节**还原原文（否则「还原后变绿」证明不了任何事）');
  assert.deepEqual(collectForwardViolations(swappedBack), [], '还原后必须重新全绿');

  // ---- M3：把队列守卫整块搬到两条 DELETE 之后（位置盲区）----
  const forwardLines = forward.split('\n');
  const guardFrom = forwardLines.findIndex((line) => /^\s*IF x_unqueued > 0 THEN\s*$/.test(line));
  assert.ok(guardFrom > 0, '找不到守卫起始行 `IF x_unqueued > 0 THEN`（负控制锚点漂移）');
  const guardTo = forwardLines.findIndex((line, index) => index > guardFrom && /^\s*END IF;\s*$/.test(line));
  assert.ok(guardTo > guardFrom, '找不到守卫的 `END IF;`（负控制锚点漂移）');
  const commitLine = forwardLines.findIndex((line) => /^COMMIT;$/.test(line));
  assert.ok(commitLine > guardTo, '找不到 `COMMIT;` 行（负控制锚点漂移）');
  const guardLength = guardTo - guardFrom + 1;
  const movedGuard = moveLineRange(forward, guardFrom, guardTo, commitLine);
  assert.notEqual(movedGuard, forward, '搬迁守卫没改动任何字节');
  const movedBad = collectForwardViolations(movedGuard);
  assert.ok(
    movedBad.some((line) => /DELETE 之前/.test(line)),
    `守卫搬到删行之后必须判红，实际：${movedBad.join(' / ') || '（全绿）'}`,
  );
  const movedBack = moveLineRange(movedGuard, commitLine - guardLength, commitLine - 1, guardFrom);
  assert.equal(movedBack, forward, '守卫搬回原位必须**逐字节**还原');
  assert.deepEqual(collectForwardViolations(movedBack), [], '还原后必须重新全绿');

  // ---- M4：守卫条件改成恒假（`IF false THEN` 仍在 DELETE 之前 ⇒ 位置判据全绿）----
  const shortedGuard = mutateCode(forward, 'IF x_unqueued > 0 THEN', 'IF false THEN');
  assert.notEqual(shortedGuard, forward, '短路守卫没改动任何字节');
  const shortedBad = collectForwardViolations(shortedGuard);
  assert.ok(
    shortedBad.filter((line) => /守卫|恒真\/恒假/.test(line)).length >= 2,
    `守卫改成 IF false 必须被点名（形态 + 恒假两条），实际：${shortedBad.join(' / ') || '（全绿）'}`,
  );
  const shortedBack = mutateCode(shortedGuard, 'IF false THEN', 'IF x_unqueued > 0 THEN');
  assert.equal(shortedBack, forward, '还原必须逐字节');
  assert.deepEqual(collectForwardViolations(shortedBack), [], '还原后必须重新全绿');
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

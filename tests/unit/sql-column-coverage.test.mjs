// 静态守卫：运行时 SQL 的**列面** ⊆ 授权面的**列权限**（角色 `gengyun_api_runtime`）。
//
// 为什么需要这一层：本仓 2026-10-20/21 连续四次踩同一个坑（S26 七张表整张零授权、S28 四张
// `recognition_*` 零命中、S38 三张 `speech_*` 零授权且 90-assert 假绿、S45 `users` 列级 INSERT
// 缺 `wechat_subject_cipher`），每一次都只有「人盯着反推」才发现。`90-assert-least-privilege.sql`
// 只核对「授权面 = 预期清单」，没有任何东西核对「预期清单 ⊇ 运行时真实用到的列」——本文件补这一层。
//
// 为什么不连库：本片要防的是**文本回退**（谁把 store 的列清单改了、或把某条列级 GRANT 删了/改成
// 表级），这种东西只有读源码才看得见；真库行为（42501）另有 S24/S26/S28/S38/S45 的矩阵实验背书。
//
// 双向核对：
//   正向（判红）—— 运行时 TypeScript 里写出的 SQL 引用到的每个列，运行时角色必须有对应权限；
//   反向（只报告）—— 授权面里存在、但 8 个 store-pg 从未引用的列，只计数不判红（避免变噪音）。
//
// 四条负控制（「不是恒绿」的证明，见文件末尾 tests）：
//   NC1 内存夹具：假 store 用了未授权列 ⇒ 必须红；
//   NC2 内存夹具：表级 GRANT 吞掉同类型列级条目 ⇒ 必须标记为「整表」，不许当成「无列」或「全列」；
//   NC3 从**真实**授权文本里删掉一条真实授权列 ⇒ 必须红并精确点名该 table.column；复原回绿；
//   NC4 `OPAQUE_ALLOWLIST` 加一条源码里不存在的 file:line ⇒ 必须红（防躺平）；
//   NC5 从**真实**授权文本里注释掉 `GRANT DELETE ON public.messages` ⇒ 必须红并点名整表缺 DELETE；
//       另证明「列级 DELETE 授权不能满足整表需求」（PG 里根本不存在 `GRANT DELETE (col)`）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 被审计的运行时角色（本仓唯一 LOGIN；INHERIT 见 20-login-roles.sql 的 CREATE/ALTER ROLE）。 */
const RUNTIME_ROLE = 'gengyun_api_runtime';
/** 授权面①：每次 provision 都会跑的登录角色引导（运行时域 H/I/J/K 段都在这里）。 */
const GRANT_MAIN_FILE = 'deploy/postgres-cvm/sql/20-login-roles.sql';
/** 授权面②：只在**建组那一次**执行的组文件（`idempotency_keys` 等老表授权只在这里）。 */
const ROLES_DIR = 'services/api/db/roles';
/** 运行时 SQL 的唯一来源：8 个 store-pg（派单 §3.2）。 */
const STORE_ROOT = 'services/api/src';
const EXPECTED_STORE_FILES = [
  'community',
  'conversations',
  'favorites',
  'history',
  'messages',
  'ocr',
  'recognitions',
  'speech',
];

/**
 * 正向核对的**全部例外登记**。元素形状（缺字段一律判红）：
 *   { ref: 'table.column', privilege: 'SELECT' | 'INSERT' | 'UPDATE',
 *     reason: '为什么这里确实缺', owner: '留给哪一片修' }
 *
 * 2026-10-21 实测：**0 条**。8 个 store-pg 引用到的 24 张表的全部列权限都已授权
 * （S24/S26/S28/S38/S45 已逐域补齐）。本表因此空着，但机制照常生效：
 * `staleExemptions` 会把「登记了但实际不再缺」的条目判红，NC3 会把「删掉一条真实授权 ⇒ 红」
 * 走一遍真流程（见文件末尾）。
 *
 * 形状校验故意写得很硬：`ref` 必须正好是 `schema.table.column`（三段），`privilege` 必须大写，
 * 免得有人塞一条 `''` 进来把守卫变成恒绿。
 */
const COVERAGE_EXEMPT = [];

/**
 * 无法静态求值的插值登记表。元素：{ ref: 'file:line', reason: '…' }。
 *
 * 规则（两条方向都判红）：
 *   * 源码里出现、但这里没登记的插值 ⇒ 红（防「悄悄跳过」）；
 *   * 这里登记了、但源码里已经没有该 file:line ⇒ 红（防躺平：源码改了却没人复查）。
 *
 * 2026-10-21 实测只有 2 条，都是 conversations 的 keyset 分页谓词。
 */
const OPAQUE_ALLOWLIST = [
  {
    ref: 'services/api/src/conversations/store-pg.ts:247',
    reason: '`${where}` = listWhere(\'conversations\', …) 拼出的 keyset 分页谓词（` AND (conversations.created_at < $n …)`）；'
      + '它引用的 created_at / id 已在 CONVERSATION_COLUMNS 里被 SELECT 授权，故不影响判定，但仍按不可静态求值登记。',
  },
  {
    ref: 'services/api/src/conversations/store-pg.ts:325',
    reason: '同上，`${where}` 用于 conversation_turns 的列表分页；引用的 created_at / id 已在 TURN_COLUMNS 里。',
  },
];

/**
 * 8 个 store-pg 的解析读数钉死值（2026-10-21 实测；同日 #17 注销清理新增 2 条 DELETE 后重测，
 * 并随「DELETE 语句也产出整表权限需求」把 columnRequirements 由 1157 抬到 1184 —— 抬高的差额
 * 正好等于 DELETE 语句条数 27，见覆盖读数的正向控制；C1b-2 又给消息域补了一条 snapshotOwner
 * 的 `SELECT id FROM public.messages`，故 SELECT 66→67、字面量 141→142、要求 1184→1185）。
 */
const EXPECTED_READINGS = {
  storeFiles: 8,
  sqlLiterals: 142,
  statements: { INSERT: 27, UPDATE: 21, SELECT: 67, DELETE: 27 },
  returningClauses: 56,
  onConflictClauses: 17,
  selectStar: 0,
  referencedTables: 25,
  columnRequirements: 1185,
  opaqueExpressions: 2,
};

/** 逐文件读数（钉死条数）：任何一条归零或暴增都说明解析器出事了，而不是 store 改了。 */
const EXPECTED_PER_FILE = {
  community: 28,
  conversations: 16,
  favorites: 15,
  history: 16,
  messages: 15,
  ocr: 16,
  recognitions: 20,
  speech: 16,
};

/** 运行时 SQL 里被引用到的表（逐张钉死，漏一张就说明某段解析掉了）。 */
const EXPECTED_TABLES = [
  'public.community_comments',
  'public.community_idempotency',
  'public.community_likes',
  'public.community_moderation_decisions',
  'public.community_posts',
  'public.community_reports',
  'public.conversation_answers',
  'public.conversation_turns',
  'public.conversations',
  'public.favorites',
  'public.favorites_idempotency',
  'public.history',
  'public.history_idempotency',
  'public.idempotency_keys',
  'public.messages',
  'public.ocr_idempotency',
  'public.ocr_jobs',
  'public.ocr_records',
  'public.recognition_idempotency',
  'public.recognition_jobs',
  'public.recognition_records',
  'public.recognition_selections',
  'public.speech_idempotency',
  'public.speech_jobs',
  'public.transcriptions',
];

/** 表级（整表）授权是「全列」，不是「无列」—— 判定时按全列处理，报告里单列。 */
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/**
 * 表级权限需求的**哨兵列**：`DELETE` 在 PostgreSQL 里**没有列级形态**（不存在
 * `GRANT DELETE (col)`），整行删除只能靠表级授权。因此 `DELETE` 语句产出的需求用
 * `column: '*'`（整表）表示，并且**只有** `kind: 'table'` 的授权才算覆盖 ——
 * 列级授权再多也不能满足它（这正是 2026-10-21 #17 那次的坑：`public.messages` 只授了
 * 列级 SELECT/INSERT/UPDATE，`DELETE FROM public.messages` 在真库上必然 42501）。
 */
const TABLE_WIDE_COLUMN = '*';

/* ============================================================================
 * 一、文本工具（全部保持长度不变，便于把偏移映射回 file:line）
 * ========================================================================== */

/** 1-based 行号。 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** 跳过 `'…'` / `"…"`（SQL 里 `''` 是转义的单引号）。返回闭合引号之后的下标。 */
function skipQuoted(text, index, quote) {
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** 把若干区间抹成空格（换行保留）——长度与偏移不变。 */
function blankRanges(text, ranges) {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue;
    out += text.slice(cursor, range.start);
    out += text.slice(range.start, range.end).replace(/[^\n]/g, ' ');
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

/**
 * 剥离 SQL 行注释与块注释（不碰引号串与美元引用体）。长度与偏移不变。
 * @param {string} text
 * @returns {string}
 */
function stripSqlComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(text, i, ch);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag !== null) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? text.length : close + tag[0].length;
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === '-' && text[i + 1] === '-') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j += 1;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 收集美元引用段（`$$ … $$` / `$tag$ … $tag$`），递归进每个段的段体（`EXECUTE $gy$GRANT …$gy$`）。
 * 返回**绝对偏移**（相对入参 text 的 0 点）。
 * @param {string} text
 * @param {number} base
 * @returns {{tag: string, start: number, bodyStart: number, bodyEnd: number, end: number, children: unknown[]}[]}
 */
function collectDollarSegments(text, base = 0) {
  const pattern = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
  const segments = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const tag = match[0];
    const bodyStart = match.index + tag.length;
    const close = text.indexOf(tag, bodyStart);
    if (close === -1) break; // 未闭合：不猜，直接放弃本段（下面的断言会因「一条 GRANT 都没解析到」而红）
    const node = {
      tag,
      start: base + match.index,
      bodyStart: base + bodyStart,
      bodyEnd: base + close,
      end: base + close + tag.length,
      children: collectDollarSegments(text.slice(bodyStart, close), base + bodyStart),
    };
    segments.push(node);
    pattern.lastIndex = close + tag.length;
    match = pattern.exec(text);
  }
  return segments;
}

/**
 * 从 SQL 文本里扫出 `GRANT …;` / `REVOKE …;` 语句（跳过注释、引号串、美元引用体）。
 * 返回语句文本 + 绝对起始偏移。
 * @param {string} text 已去注释的文本
 * @param {number} offset 该文本首字符在**原文件**里的偏移
 * @returns {{sql: string, offset: number}[]}
 */
function scanGrantStatements(text, offset) {
  const segments = collectDollarSegments(text); // 相对 text 的偏移
  const statementScan = blankRanges(text, segments.map((segment) => ({ start: segment.start, end: segment.end })));
  const statements = [];
  const pushFrom = (scanText, base) => {
    let i = 0;
    while (i < scanText.length) {
      const ch = scanText[i];
      if (ch === "'" || ch === '"') {
        i = skipQuoted(scanText, i, ch);
        continue;
      }
      const head = /^(GRANT|REVOKE)\s/i.exec(scanText.slice(i, i + 8));
      const atLineStart = i === 0 || /\n/.test(scanText.slice(Math.max(0, i - 200), i).slice(-1));
      if (head !== null && atLineStart) {
        const end = scanText.indexOf(';', i);
        if (end === -1) break;
        statements.push({ sql: scanText.slice(i, end), offset: base + i });
        i = end + 1;
        continue;
      }
      i += 1;
    }
  };
  pushFrom(statementScan, offset);
  const walk = (nodes) => {
    for (const node of nodes) {
      const body = text.slice(node.bodyStart, node.bodyEnd);
      const local = blankRanges(body, node.children.map((child) => ({
        start: child.start - node.bodyStart,
        end: child.end - node.bodyStart,
      })));
      pushFrom(local, offset + node.bodyStart);
      walk(node.children);
    }
  };
  walk(segments);
  return statements;
}

/* ============================================================================
 * 二、授权面解析（20-login-roles.sql + services/api/db/roles/*.sql）
 * ========================================================================== */

/** 对象名 → `schema.name`；未限定一律落到 public（本仓 SQL 的 search_path 口径）。 */
function normalizeTable(schema, name) {
  return `${(schema ?? 'public').toLowerCase()}.${name.toLowerCase()}`;
}

/** 逗号列表按**顶层**逗号切分（括号内的逗号属于函数签名/列清单）。 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** 列清单 → 小写列名数组（去引号、去空白、忽略 `*`）。 */
function parseColumnList(text) {
  return splitTopLevel(text)
    .map((item) => item.replace(/^"|"$/g, '').trim().toLowerCase())
    .filter((item) => item !== '' && item !== '*');
}

/**
 * 解析一条 GRANT 语句。
 * @param {string} sql 语句文本（不含结尾分号）
 * @returns {null | {kind: string, [k: string]: unknown}}
 */
function parseGrantStatement(sql) {
  const text = sql.replace(/\s+/g, ' ').trim();
  const body = text.replace(/^GRANT\s+/i, '');
  const onMatch = /\s+ON\s+/i.exec(body);
  const toMatch = /\s+TO\s+/i.exec(onMatch === null ? body : body.slice(onMatch.index + onMatch[0].length));

  if (onMatch === null) {
    // 成员关系：`GRANT <组>[, <组>] TO <成员>`。
    if (toMatch === null) return { kind: 'unparsed', sql: text };
    const roles = splitTopLevel(body.slice(0, toMatch.index)).map((role) => role.toLowerCase());
    const members = splitTopLevel(body.slice(toMatch.index + toMatch[0].length))
      .map((member) => member.replace(/\s+WITH\s+ADMIN\s+OPTION$/i, '').trim().toLowerCase());
    return { kind: 'membership', roles, members, sql: text };
  }

  const privilegeClause = body.slice(0, onMatch.index).trim();
  const afterOn = body.slice(onMatch.index + onMatch[0].length);
  if (toMatch === null) return { kind: 'unparsed', sql: text };
  const objectClause = afterOn.slice(0, toMatch.index).trim();
  const granteeClause = afterOn.slice(toMatch.index + toMatch[0].length).trim();

  // `ON SCHEMA` / `ON FUNCTION` / `ON ALL TABLES IN SCHEMA` 等不是表级列权限。
  const nonTable = /^(SCHEMA|FUNCTION|PROCEDURE|ROUTINE|SEQUENCE|DATABASE|TYPE|LANGUAGE|LARGE\s+OBJECT|TABLESPACE|ALL\s+TABLES\s+IN\s+SCHEMA|ALL\s+SEQUENCES\s+IN\s+SCHEMA)\b/i.exec(objectClause);
  if (nonTable !== null) {
    return { kind: 'ignored', subject: nonTable[1].toUpperCase(), sql: text };
  }

  let columns = null;
  let privileges;
  const columnForm = /^([A-Za-z_]+)\s*\(([^)]*)\)$/.exec(privilegeClause);
  if (columnForm !== null) {
    privileges = [columnForm[1].toUpperCase()];
    columns = parseColumnList(columnForm[2]);
  } else {
    privileges = splitTopLevel(privilegeClause).map((item) => item.toUpperCase());
    // `GRANT SELECT (a) , UPDATE ON …` 这种混合形态本仓没有；出现就报出来，不猜。
    if (privileges.some((item) => /\(/.test(item))) return { kind: 'unparsed', sql: text };
  }

  const unknown = privileges.filter((item) => !PRIVILEGES.includes(item) && item !== 'ALL');
  if (unknown.length > 0) return { kind: 'ignored', subject: unknown.join(','), sql: text };
  if (privileges.includes('ALL')) return { kind: 'ignored', subject: 'ALL', sql: text };

  const objectList = splitTopLevel(objectClause.replace(/^TABLE\s+/i, ''));
  const tables = objectList.map((object) => {
    const matched = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(object);
    if (matched === null) return null;
    return normalizeTable(matched[1], matched[2]);
  });
  if (tables.some((table) => table === null)) return { kind: 'unparsed', sql: text };

  const grantees = splitTopLevel(granteeClause)
    .map((grantee) => grantee.replace(/\s+WITH\s+GRANT\s+OPTION$/i, '').replace(/^"|"$/g, '').trim().toLowerCase());

  return { kind: 'table', privileges, columns, tables, grantees, sql: text };
}

/**
 * 读授权面文件并解析成模型。
 * @param {{file: string, text: string}[]} sources
 * @returns {{grants: object[], memberships: object[], revocations: object[], problems: string[], stats: object}}
 */
function parseGrantSources(sources) {
  const grants = [];
  const memberships = [];
  const revocations = [];
  const problems = [];
  const ignored = [];
  let statementCount = 0;

  for (const { file, text } of sources) {
    const stripped = stripSqlComments(text);
    for (const { sql: raw, offset } of scanGrantStatements(stripped, 0)) {
      statementCount += 1;
      const line = lineOf(text, offset);
      const parsed = raw.trim().toUpperCase().startsWith('REVOKE')
        ? { kind: 'revoke', sql: raw.replace(/\s+/g, ' ').trim() }
        : parseGrantStatement(raw);
      if (parsed === null) continue;
      if (parsed.kind === 'unparsed') {
        problems.push(`${file}:${line} 授权语句无法解析（不静默跳过）：${parsed.sql}`);
        continue;
      }
      if (parsed.kind === 'ignored') {
        ignored.push({ file, line, subject: parsed.subject });
        continue;
      }
      if (parsed.kind === 'membership') {
        for (const role of parsed.roles) {
          for (const member of parsed.members) memberships.push({ role, member, file, line });
        }
        continue;
      }
      if (parsed.kind === 'revoke') {
        revocations.push({ file, line, sql: parsed.sql });
        continue;
      }
      for (const table of parsed.tables) {
        for (const privilege of parsed.privileges) {
          for (const grantee of parsed.grantees) {
            grants.push({ file, line, table, privilege, columns: parsed.columns, grantee });
          }
        }
      }
    }
  }

  return {
    grants,
    memberships,
    revocations,
    problems,
    stats: { statements: statementCount, grants: grants.length, memberships: memberships.length, ignored: ignored.length },
  };
}

/**
 * 计算运行时角色的**有效列权限**（自身直授 ∪ 所属组 ∪ 组的组 …；INHERIT 为真）。
 *
 * 每个 {table, privilege} 是三态之一：
 *   { kind: 'table' }            整表授权（全列）——表级 GRANT，**不是**「无列」；
 *   { kind: 'columns', columns } 列级授权的并集；
 *   undefined                    未授权。
 * 表级一旦出现就吞掉同类型的列级条目（PG 实测行为），被吞的列单独记 `swallowed`。
 *
 * @param {{file: string, text: string}[]} sources
 * @param {string} role
 * @returns {object}
 */
function buildGrantModel(sources, role = RUNTIME_ROLE) {
  const parsed = parseGrantSources(sources);
  const problems = [...parsed.problems];

  // 成员闭包（只按「GRANT 组 TO 成员」的方向）。
  const closure = new Set([role]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of parsed.memberships) {
      if (closure.has(edge.member) && !closure.has(edge.role)) {
        closure.add(edge.role);
        changed = true;
      }
    }
  }

  const tables = new Map();
  const swallowed = [];
  const decider = [];

  for (const grant of parsed.grants) {
    if (!closure.has(grant.grantee)) continue;
    decider.push(grant);
    if (!tables.has(grant.table)) tables.set(grant.table, {});
    const slot = tables.get(grant.table);
    const current = slot[grant.privilege];
    if (grant.columns === null) {
      if (current !== undefined && current.kind === 'columns') {
        // 表级吞列级：把同类型列级条目记下来（报告里单列），不要静默丢弃。
        swallowed.push({
          table: grant.table,
          privilege: grant.privilege,
          columns: [...current.columns],
          file: grant.file,
          line: grant.line,
        });
      }
      slot[grant.privilege] = { kind: 'table', file: grant.file, line: grant.line };
      continue;
    }
    if (current !== undefined && current.kind === 'table') {
      swallowed.push({
        table: grant.table,
        privilege: grant.privilege,
        columns: [...grant.columns],
        file: grant.file,
        line: grant.line,
      });
      continue;
    }
    const columns = new Set(current === undefined ? [] : current.columns);
    for (const column of grant.columns) columns.add(column);
    slot[grant.privilege] = { kind: 'columns', columns, file: grant.file, line: grant.line };
  }

  // 本仓不存在针对运行时角色的 REVOKE；一旦出现，解析器拒绝猜（表级 REVOKE 会连带撤列级）。
  for (const revocation of parsed.revocations) {
    const hit = [...closure].some((name) => new RegExp(`\\b${name}\\b`, 'i').test(revocation.sql));
    if (hit) {
      problems.push(`${revocation.file}:${revocation.line} 出现针对运行时角色（或其组）的 REVOKE，静态模型不推算其连锁效果，请人工扩写解析器：${revocation.sql}`);
    }
  }

  // INHERIT：运行时 LOGIN 必须是 INHERIT，否则「所属组的授权」根本不生效。
  const mainSource = sources.find((source) => source.file === GRANT_MAIN_FILE);
  if (mainSource !== undefined) {
    if (!/CREATE ROLE %I LOGIN INHERIT/.test(mainSource.text)) {
      problems.push(`${GRANT_MAIN_FILE} 里找不到 \`CREATE ROLE %I LOGIN INHERIT\`：运行时角色可能不是 INHERIT，组授权不生效`);
    }
    if (/\bNOINHERIT\b/i.test(mainSource.text)) {
      problems.push(`${GRANT_MAIN_FILE} 出现 NOINHERIT：组授权不生效`);
    }
  }

  return { role, closure, tables, swallowed, problems, stats: parsed.stats, grants: decider };
}

/**
 * 查某表某权限的**覆盖情况**。
 * @returns {{kind: 'table'} | {kind: 'columns', columns: Set<string>} | {kind: 'none'} | {kind: 'missing-column', columns: Set<string>}}
 */
function lookupPrivilege(model, table, privilege) {
  const slot = model.tables.get(table);
  if (slot === undefined || slot[privilege] === undefined) return { kind: 'none' };
  return slot[privilege];
}

/* ============================================================================
 * 三、运行时 SQL 解析（8 个 store-pg）
 * ========================================================================== */

/** 跳过 TypeScript 字符串（含反引号模板）与注释，返回字面量清单。 */
function scanTsLiterals(text) {
  const literals = [];
  let i = 0;
  const readTemplate = (start) => {
    const chunks = [];
    let buffer = '';
    let offset = start + 1;
    let j = start + 1;
    const flush = () => {
      if (buffer !== '') chunks.push({ type: 'text', value: buffer, offset: offset - buffer.length });
      buffer = '';
    };
    while (j < text.length) {
      const ch = text[j];
      if (ch === '\\') {
        buffer += text[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (ch === '`') {
        flush();
        return { kind: 'template', start, end: j + 1, chunks };
      }
      if (ch === '$' && text[j + 1] === '{') {
        flush();
        const exprStart = j + 2;
        let depth = 1;
        let k = exprStart;
        while (k < text.length && depth > 0) {
          if (text[k] === "'" || text[k] === '"') {
            k = skipQuoted(text, k, text[k]);
            continue;
          }
          if (text[k] === '`') {
            k = readTemplate(k).end;
            continue;
          }
          if (text[k] === '{') depth += 1;
          if (text[k] === '}') depth -= 1;
          if (depth === 0) break;
          k += 1;
        }
        chunks.push({ type: 'expr', value: text.slice(exprStart, k), offset: exprStart });
        j = k + 1;
        offset = j;
        continue;
      }
      buffer += ch;
      j += 1;
    }
    flush();
    return { kind: 'template', start, end: text.length, chunks };
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(text, i, ch);
      const raw = text.slice(i + 1, end - 1).replace(/\\(.)/g, '$1');
      literals.push({ kind: 'quoted', start: i, end, chunks: [{ type: 'text', value: raw, offset: i + 1 }] });
      i = end;
      continue;
    }
    if (ch === '`') {
      const node = readTemplate(i);
      literals.push(node);
      i = node.end;
      continue;
    }
    i += 1;
  }
  return literals;
}

/** 文件内的 `const NAME = 'a' + 'b';` 常量表（只收「纯字符串拼接」形态）。 */
function buildConstMap(text) {
  const map = new Map();
  const stripped = text
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*((?:\s*(?:'[^']*'|"[^"]*")\s*\+?)+);/g;
  let match = pattern.exec(stripped);
  while (match !== null) {
    const value = [...match[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map((item) => item[1] ?? item[2]).join('');
    map.set(match[1], value);
    match = pattern.exec(stripped);
  }
  return map;
}

const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i;

/**
 * 抽出 8 个 store-pg 里的 SQL 字面量，并把列清单常量代入。
 * @returns {{statements: object[], opaque: object[], stats: object}}
 */
function extractRuntimeSql(sources) {
  const statements = [];
  const opaque = [];
  const stats = {
    storeFiles: sources.length,
    sqlLiterals: 0,
    statements: { INSERT: 0, UPDATE: 0, SELECT: 0, DELETE: 0 },
    returningClauses: 0,
    onConflictClauses: 0,
    selectStar: 0,
    noTargetTable: 0,
    byFile: {},
  };

  for (const { file, text } of sources) {
    const constants = buildConstMap(text);
    const domain = file.split('/').slice(-2)[0];
    const perFile = { file, sqlLiterals: 0, statements: { INSERT: 0, UPDATE: 0, SELECT: 0, DELETE: 0 } };
    stats.byFile[domain] = perFile;
    for (const literal of scanTsLiterals(text)) {
      const firstText = literal.chunks.find((chunk) => chunk.type === 'text');
      if (firstText === undefined || !SQL_START.test(firstText.value)) continue;
      stats.sqlLiterals += 1;
      perFile.sqlLiterals += 1;
      const startLine = lineOf(text, literal.start);

      let sql = '';
      for (const chunk of literal.chunks) {
        if (chunk.type === 'text') {
          sql += chunk.value;
          continue;
        }
        const expr = chunk.value.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(expr) && constants.has(expr)) {
          sql += constants.get(expr);
          continue;
        }
        opaque.push({
          ref: `${file}:${lineOf(text, chunk.offset)}`,
          file,
          line: lineOf(text, chunk.offset),
          expr: `\${${expr}}`,
          statementLine: startLine,
        });
        sql += ' ';
      }

      const parsedStatements = parseSqlText(sql, { file, line: startLine });
      for (const statement of parsedStatements) {
        stats.statements[statement.verb] = (stats.statements[statement.verb] ?? 0) + 1;
        perFile.statements[statement.verb] = (perFile.statements[statement.verb] ?? 0) + 1;
        if (statement.returningColumns.length > 0 || statement.hasReturning) stats.returningClauses += 1;
        if (statement.conflict !== null) stats.onConflictClauses += 1;
        if (statement.selectStar) stats.selectStar += 1;
        if (statement.table === null) stats.noTargetTable += 1;
        statements.push(statement);
      }
    }
  }

  return { statements, opaque, stats };
}

/** 顶层（括号外、引号外）词元扫描。 */
function topLevelTokens(text) {
  const tokens = [];
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i, ch) - 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      tokens.push({ word: text.slice(i, j).toUpperCase(), index: i, end: j });
      i = j - 1;
    }
  }
  return tokens;
}

/** 从 `schema.table` / `table` 里取表名；未限定 → public。 */
function readQualifiedName(text) {
  const matched = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*))?/.exec(text);
  if (matched === null) return null;
  return matched[2] === undefined ? normalizeTable(null, matched[1]) : normalizeTable(matched[1], matched[2]);
}

/** 表达式里「被读取的列」——剥别名、剥 `::type`、剥 `extract(field FROM x)`、剥表限定、去函数名与关键字。 */
const EXPR_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'AS', 'IN', 'IS', 'DISTINCT', 'ALL', 'ORDER', 'BY', 'GROUP', 'LIMIT', 'OFFSET', 'FOR', 'UPDATE', 'SHARE',
  'INSERT', 'INTO', 'VALUES', 'SET', 'DELETE', 'RETURNING', 'ON', 'CONFLICT', 'DO', 'NOTHING', 'EXCLUDED',
  'USING', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'JOIN', 'ASC', 'DESC', 'UNION', 'INTERVAL', 'DEFAULT', 'COALESCE',
]);

/**
 * @param {string} expression
 * @returns {string[]}
 */
function extractExpressionColumns(expression) {
  let text = expression;
  text = text.replace(/\s+AS\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i, '');
  text = text.replace(/::\s*[A-Za-z_][A-Za-z0-9_]*(\s*\[\s*\])?/g, ' ');
  // `extract(<field> FROM <expr>)`：字段名不是列，括号里的 expr 才是。
  text = text.replace(/\bextract\s*\(\s*[A-Za-z_]+\s+FROM\s+/gi, '(');
  text = text.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g, '$2');

  const columns = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i, ch) - 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) continue;
    let j = i;
    while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
    const name = text.slice(i, j);
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k += 1;
    const isCall = text[k] === '(';
    if (!isCall && !EXPR_KEYWORDS.has(name.toUpperCase())) columns.push(name.toLowerCase());
    i = j - 1;
  }
  return columns;
}

/**
 * 解析一段（已代入常量、已抹掉不可判插值的）SQL。
 * @param {string} sql
 * @param {{file: string, line: number}} origin
 * @returns {object[]}
 */
function parseSqlText(sql, origin) {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (text === '') return [];
  const tokens = topLevelTokens(text);
  if (tokens.length === 0) return [];
  const verb = tokens[0].word;
  const locate = (word) => tokens.find((token) => token.word === word) ?? null;

  const base = {
    verb,
    file: origin.file,
    line: origin.line,
    sql: text.length > 220 ? `${text.slice(0, 220)}…` : text,
    table: null,
    selectColumns: [],
    insertColumns: [],
    updateColumns: [],
    returningColumns: [],
    hasReturning: false,
    conflict: null,
    selectStar: false,
  };

  const returningToken = locate('RETURNING');
  if (returningToken !== null) {
    base.hasReturning = true;
    const tail = text.slice(returningToken.end);
    base.returningColumns = parseColumnList(tail.replace(/;+\s*$/, ''));
  }

  if (verb === 'INSERT') {
    const into = locate('INTO');
    if (into !== null) base.table = readQualifiedName(text.slice(into.end));
    if (into !== null) {
      const afterTable = text.slice(into.end).replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_]*)?/, '');
      const columnList = /^\s*\(([^)]*)\)/.exec(afterTable);
      if (columnList !== null) base.insertColumns = parseColumnList(columnList[1]);
    }
    const conflictToken = locate('CONFLICT');
    if (conflictToken !== null) {
      const afterConflict = text.slice(conflictToken.end);
      const target = /^\s*\(([^)]*)\)/.exec(afterConflict);
      const setToken = tokens.find((token) => token.word === 'SET' && token.index > conflictToken.index) ?? null;
      let updateColumns = [];
      if (setToken !== null) {
        const tail = text.slice(setToken.end);
        const stop = /\s(WHERE|RETURNING)\s/i.exec(tail);
        const setClause = stop === null ? tail : tail.slice(0, stop.index);
        updateColumns = splitTopLevel(setClause)
          .map((item) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(item))
          .filter((item) => item !== null)
          .map((item) => item[1].toLowerCase());
      }
      base.conflict = {
        target: target === null ? null : parseColumnList(target[1]),
        updateColumns,
        doNothing: /DO\s+NOTHING/i.test(afterConflict),
      };
    }
    return [base];
  }

  if (verb === 'UPDATE') {
    base.table = readQualifiedName(text.slice(tokens[0].end));
    const setToken = locate('SET');
    if (setToken !== null) {
      const tail = text.slice(setToken.end);
      const stop = /\s(WHERE|RETURNING)\s/i.exec(tail);
      const setClause = stop === null ? tail : tail.slice(0, stop.index);
      base.updateColumns = splitTopLevel(setClause)
        .map((item) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(item))
        .filter((item) => item !== null)
        .map((item) => item[1].toLowerCase());
    }
    return [base];
  }

  if (verb === 'DELETE') {
    const from = locate('FROM');
    if (from !== null) base.table = readQualifiedName(text.slice(from.end));
    return [base];
  }

  if (verb === 'SELECT') {
    const from = locate('FROM');
    if (from === null) return [base]; // 纯标量子查询（count(*)），没有目标表
    base.table = readQualifiedName(text.slice(from.end));
    const selectList = text.slice(tokens[0].end, from.index).trim();
    if (selectList === '*') {
      base.selectStar = true;
      return [base];
    }
    base.selectColumns = extractExpressionColumns(selectList);
    return [base];
  }

  return [];
}

/* ============================================================================
 * 四、把「运行时引用」与「有效列权限」对上
 * ========================================================================== */

/**
 * 每条语句 → 需要的 {table, column, privilege}。
 * SET 的左侧 = UPDATE；INSERT 列清单 = INSERT；SELECT 列与 RETURNING 列 = SELECT；
 * ON CONFLICT 的冲突目标 = SELECT（本仓口径，见 20-login-roles.sql 「ON CONFLICT 的推断 … 要 SELECT 权」）；
 * **DELETE 语句 = 表级 DELETE**（PG 无列级 DELETE，用哨兵列 `*` 表达整表需求）。
 *
 * 为什么必须收 DELETE：2026-10-21 #17 注销清理新增了 `DELETE FROM public.messages`，而当次
 * 授权面只给了列级 SELECT/INSERT/UPDATE —— 这条守卫当时**结构上不可能发现**它（它从不产出
 * DELETE 需求），最后靠人读 20-login-roles.sql 才撞见。现在补上这一面。
 * @param {object[]} statements
 * @returns {object[]}
 */
function collectRequirements(statements) {
  const requirements = [];
  const add = (statement, column, privilege, clause) => {
    requirements.push({
      table: statement.table,
      column,
      privilege,
      clause,
      ref: `${statement.file}:${statement.line}`,
    });
  };
  for (const statement of statements) {
    if (statement.table === null) continue;
    for (const column of statement.insertColumns) add(statement, column, 'INSERT', 'INSERT 列清单');
    for (const column of statement.selectColumns) add(statement, column, 'SELECT', 'SELECT 列清单');
    for (const column of statement.updateColumns) add(statement, column, 'UPDATE', 'UPDATE SET');
    for (const column of statement.returningColumns) add(statement, column, 'SELECT', 'RETURNING');
    if (statement.verb === 'DELETE') add(statement, TABLE_WIDE_COLUMN, 'DELETE', 'DELETE 整表（PG 无列级 DELETE）');
    if (statement.conflict !== null) {
      for (const column of statement.conflict.target ?? []) add(statement, column, 'SELECT', 'ON CONFLICT 冲突目标');
      for (const column of statement.conflict.updateColumns) add(statement, column, 'UPDATE', 'ON CONFLICT DO UPDATE SET');
    }
  }
  return requirements;
}

/**
 * 正向核对 + 例外 / 陈旧例外。
 * @param {object[]} requirements
 * @param {object} model
 * @param {object[]} exemptions
 * @returns {{problems: string[], staleExemptions: string[], missing: object[], covered: number}}
 */
function evaluateCoverage(requirements, model, exemptions) {
  const problems = [];
  const staleExemptions = [];
  const missing = [];
  const exempt = new Map();
  for (const exemption of exemptions) {
    const shapeOk = typeof exemption?.ref === 'string'
      && /^[a-z_]+\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(exemption.ref)
      && typeof exemption.privilege === 'string'
      && PRIVILEGES.includes(exemption.privilege)
      && typeof exemption.reason === 'string' && exemption.reason.trim() !== ''
      && typeof exemption.owner === 'string' && exemption.owner.trim() !== '';
    if (!shapeOk) {
      problems.push(`COVERAGE_EXEMPT 条目形状不合规（必须含 ref=table.column / privilege / reason / owner）：${JSON.stringify(exemption)}`);
      continue;
    }
    exempt.set(`${exemption.ref}|${exemption.privilege}`, exemption);
  }

  const seen = new Set();
  const genuinelyMissing = new Set();
  let covered = 0;
  // 覆盖来源拆分：靠「表级（整表）授权」蒙过去的条数 vs 靠「列级精确授权」命中的条数。
  // 这个读数决定本守卫有多硬：表级占比越高，说明核对越粗。
  let viaTableLevel = 0;
  let viaColumnLevel = 0;
  for (const requirement of requirements) {
    const key = `${requirement.table}.${requirement.column}|${requirement.privilege}`;
    seen.add(key);
    const granted = lookupPrivilege(model, requirement.table, requirement.privilege);
    // 整表需求（`column: '*'`，目前只有 DELETE）：**只认表级授权**。
    // 列级授权无论给了多少列都不满足「能删整行」—— PG 里没有 `GRANT DELETE (col)` 这种东西。
    const tableWide = requirement.column === TABLE_WIDE_COLUMN;
    const ok = tableWide
      ? granted.kind === 'table'
      : (granted.kind === 'table' || (granted.kind === 'columns' && granted.columns.has(requirement.column)));
    if (ok) {
      covered += 1;
      if (granted.kind === 'table') viaTableLevel += 1;
      else viaColumnLevel += 1;
      continue;
    }
    genuinelyMissing.add(key);
    if (exempt.has(key)) continue;
    missing.push(requirement);
    const target = tableWide ? `${requirement.table}（整表）` : `${requirement.table}.${requirement.column}`;
    problems.push(
      `${requirement.ref} → ${target} 缺 ${requirement.privilege}（${requirement.clause}）；`
      + `授权面现状：${granted.kind === 'none' ? '该表该权限未授任何列' : `只授了 [${[...granted.columns].join(', ')}]`}`,
    );
  }

  // 陈旧例外 = 登记了、但**实际并不缺**（两种：该引用已不存在，或该列其实已授权）。
  for (const [key, exemption] of exempt) {
    if (!genuinelyMissing.has(key)) {
      staleExemptions.push(
        `COVERAGE_EXEMPT 里登记的 ${exemption.ref}（${exemption.privilege}）已不再缺失`
        + `${seen.has(key) ? '（该列在授权面里其实已授权）' : '（运行时 SQL 已不再引用该列）'} —— 陈旧例外，删掉它`,
      );
    }
  }

  return { problems, staleExemptions, missing, covered, viaTableLevel, viaColumnLevel };
}

/** 不可判插值的双向核对。 */
function evaluateOpaque(observed, allowlist) {
  const problems = [];
  const allowed = new Set(allowlist.map((entry) => entry.ref));
  const seen = new Set();
  for (const item of observed) {
    if (!allowed.has(item.ref)) {
      problems.push(`未登记的不可判插值 ${item.ref}（${item.expr}）：要么让它可静态求值，要么登记进 OPAQUE_ALLOWLIST 并写清理由`);
    }
    seen.add(item.ref);
  }
  for (const entry of allowlist) {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`OPAQUE_ALLOWLIST 条目缺 reason：${entry.ref}`);
    }
    if (!seen.has(entry.ref)) {
      problems.push(`OPAQUE_ALLOWLIST 登记的 ${entry.ref} 在源码里已不存在（陈旧登记，删掉它以免守卫躺平）`);
    }
  }
  return { problems };
}

/** 反向报告：授权面里存在、但运行时 SQL 从未引用的列（只报告，不判红）。 */
function buildSupersetReport(requirements, model) {
  const referenced = new Map();
  for (const requirement of requirements) {
    if (!referenced.has(requirement.table)) referenced.set(requirement.table, new Set());
    referenced.get(requirement.table).add(`${requirement.privilege}|${requirement.column}`);
  }

  const unusedOnReferencedTables = [];
  const wholeTableUnused = [];
  const tableLevel = [];
  for (const [table, slot] of model.tables) {
    const refs = referenced.get(table);
    if (refs === undefined) {
      wholeTableUnused.push({ table, privileges: Object.keys(slot) });
      continue;
    }
    for (const privilege of PRIVILEGES) {
      const granted = slot[privilege];
      if (granted === undefined) continue;
      if (granted.kind === 'table') {
        tableLevel.push({ table, privilege, file: granted.file, line: granted.line });
        continue;
      }
      for (const column of granted.columns) {
        if (!refs.has(`${privilege}|${column}`)) unusedOnReferencedTables.push({ table, privilege, column });
      }
    }
  }
  return { unusedOnReferencedTables, wholeTableUnused, tableLevel };
}

/* ============================================================================
 * 五、装载真实输入 + 总装
 * ========================================================================== */

/** @returns {{file: string, text: string}[]} */
function loadGrantSources(dir = undefined) {
  const absolute = (relativePath) => resolve(root, relativePath);
  const sources = [{ file: GRANT_MAIN_FILE, text: readFileSync(absolute(GRANT_MAIN_FILE), 'utf8') }];
  const rolesPath = dir ?? resolve(root, ROLES_DIR);
  for (const name of readdirSync(rolesPath).filter((entry) => entry.endsWith('.sql')).sort()) {
    sources.push({ file: `${ROLES_DIR}/${name}`, text: readFileSync(resolve(rolesPath, name), 'utf8') });
  }
  return sources;
}

/** @returns {{file: string, text: string}[]} */
function loadStoreSources() {
  return EXPECTED_STORE_FILES.map((domain) => {
    const file = `${STORE_ROOT}/${domain}/store-pg.ts`;
    const absolute = resolve(root, file);
    assert.ok(existsSync(absolute), `缺少 ${file}（派单 §3.2 的 8 个 store-pg 之一）`);
    return { file, text: readFileSync(absolute, 'utf8') };
  });
}

/**
 * 总装：同一套流水线既跑真实输入，也跑负控制的内存夹具（这是「不恒绿」的结构前提）。
 * @param {{grantSources?: object[], storeSources?: object[], exemptions?: object[], opaqueAllowlist?: object[]}} [input]
 */
function auditAll(input = {}) {
  const grantSources = input.grantSources ?? loadGrantSources();
  const storeSources = input.storeSources ?? loadStoreSources();
  const exemptions = input.exemptions ?? COVERAGE_EXEMPT;
  const opaqueAllowlist = input.opaqueAllowlist ?? OPAQUE_ALLOWLIST;

  const model = buildGrantModel(grantSources);
  const sql = extractRuntimeSql(storeSources);
  const requirements = collectRequirements(sql.statements);
  const coverage = evaluateCoverage(requirements, model, exemptions);
  const opaque = evaluateOpaque(sql.opaque, opaqueAllowlist);
  const superset = buildSupersetReport(requirements, model);
  const referencedTables = [...new Set(sql.statements.filter((item) => item.table !== null).map((item) => item.table))].sort();

  return {
    model,
    sql,
    requirements,
    coverage,
    opaque,
    superset,
    referencedTables,
    problems: [...model.problems, ...coverage.problems, ...coverage.staleExemptions, ...opaque.problems],
  };
}

const baseline = auditAll();

/* ============================================================================
 * 六、断言
 * ========================================================================== */

test('sql-column-coverage/覆盖读数：解析器确实在看东西（8 文件 / 语句条数 / 表列数钉死）', () => {
  const readings = [
    `[sql-column-coverage] 授权面文件 ${baseline.model.stats ? loadGrantSources().length : 0} 个：${GRANT_MAIN_FILE} + ${ROLES_DIR}/*.sql`,
    `[sql-column-coverage] 运行时角色 ${RUNTIME_ROLE} 的成员闭包 ${baseline.model.closure.size} 个角色：${[...baseline.model.closure].sort().join(', ')}`,
    `[sql-column-coverage] store-pg 文件 ${baseline.sql.stats.storeFiles} 个，SQL 字面量 ${baseline.sql.stats.sqlLiterals} 条`,
    ...Object.entries(baseline.sql.stats.byFile).map(([domain, value]) => (
      `[sql-column-coverage]   ${domain}/store-pg.ts：字面量 ${value.sqlLiterals} 条`
      + `（INSERT ${value.statements.INSERT} / UPDATE ${value.statements.UPDATE} / SELECT ${value.statements.SELECT} / DELETE ${value.statements.DELETE}）`
    )),
    `[sql-column-coverage] 语句：INSERT ${baseline.sql.stats.statements.INSERT} / UPDATE ${baseline.sql.stats.statements.UPDATE} / SELECT ${baseline.sql.stats.statements.SELECT} / DELETE ${baseline.sql.stats.statements.DELETE}`,
    `[sql-column-coverage] RETURNING ${baseline.sql.stats.returningClauses} 处 / ON CONFLICT ${baseline.sql.stats.onConflictClauses} 处 / SELECT * ${baseline.sql.stats.selectStar} 处 / 无顶层 FROM ${baseline.sql.stats.noTargetTable} 处`,
    `[sql-column-coverage] 引用到的表 ${baseline.referencedTables.length} 张，列权限要求 ${baseline.requirements.length} 条，已覆盖 ${baseline.coverage.covered} 条，缺 ${baseline.coverage.missing.length} 条`,
    `[sql-column-coverage] 覆盖来源：列级精确授权命中 ${baseline.coverage.viaColumnLevel} 条 / 表级（整表）授权命中 ${baseline.coverage.viaTableLevel} 条`,
    `[sql-column-coverage] 不可判插值 ${baseline.sql.opaque.length} 条；表级授权 ${baseline.superset.tableLevel.length} 条`,
  ];
  for (const line of readings) console.log(line);

  assert.deepEqual(
    baseline.sql.stats.statements,
    EXPECTED_READINGS.statements,
    `语句条数变了（实际 ${JSON.stringify(baseline.sql.stats.statements)}）：要么 store 真的改了，要么解析器瞎了 —— 先查是哪一种`,
  );
  assert.equal(baseline.sql.stats.storeFiles, EXPECTED_READINGS.storeFiles);
  assert.equal(baseline.sql.stats.sqlLiterals, EXPECTED_READINGS.sqlLiterals);
  assert.equal(baseline.sql.stats.returningClauses, EXPECTED_READINGS.returningClauses);
  assert.equal(baseline.sql.stats.onConflictClauses, EXPECTED_READINGS.onConflictClauses);
  assert.equal(baseline.sql.stats.selectStar, EXPECTED_READINGS.selectStar);
  assert.equal(baseline.sql.opaque.length, EXPECTED_READINGS.opaqueExpressions);
  assert.deepEqual(baseline.referencedTables, [...EXPECTED_TABLES].sort(), '运行时引用到的表清单变了：逐张核对，别让它悄悄少一张');
  assert.equal(
    baseline.requirements.length,
    EXPECTED_READINGS.columnRequirements,
    `列权限要求条数变了（实际 ${baseline.requirements.length}）：要么 store 真的改了，要么解析器没看见某些列清单`,
  );

  // 正向控制：DELETE 语句必须**每条**都产出一条「整表 DELETE」需求。
  // 没有这两行断言，「collectRequirements 开始产 DELETE 需求」这件事就只是注释里的说法，
  // 守卫哪怕哪天把这一面又丢了也一样是绿的。
  const deleteRequirements = baseline.requirements.filter((item) => item.privilege === 'DELETE');
  assert.equal(
    deleteRequirements.length,
    baseline.sql.stats.statements.DELETE,
    `DELETE 语句条数（${baseline.sql.stats.statements.DELETE}）与整表 DELETE 需求条数（${deleteRequirements.length}）必须相等：`
    + '不等说明有 DELETE 语句没被收进需求（解析器漏面），或者有人给 DELETE 造了列级需求（PG 里不存在这种授权形态）',
  );
  assert.equal(
    deleteRequirements.every((item) => item.column === TABLE_WIDE_COLUMN),
    true,
    'DELETE 需求必须一律是整表哨兵列 `*`（PG 没有 `GRANT DELETE (col)`，列级 DELETE 需求是假需求）',
  );
  assert.equal(
    baseline.coverage.covered,
    baseline.requirements.length,
    `已覆盖条数必须等于要求条数（零缺口）；实际 ${baseline.coverage.covered}/${baseline.requirements.length}`,
  );
  assert.equal(
    baseline.coverage.viaColumnLevel + baseline.coverage.viaTableLevel,
    baseline.coverage.covered,
    '覆盖来源拆分必须自洽（列级 + 表级 = 总数）',
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(baseline.sql.stats.byFile).map(([key, value]) => [key, value.sqlLiterals])),
    EXPECTED_PER_FILE,
    '逐文件字面量条数变了：先确认是 store 真改了还是解析器瞎了',
  );
});

test('sql-column-coverage/runtime_sql_columns_are_granted：运行时列面 ⊆ 授权列面（缺一列即红）', () => {
  assert.deepEqual(baseline.model.problems, [], `授权面解析出问题：\n${baseline.model.problems.join('\n')}`);
  if (baseline.coverage.missing.length > 0) {
    console.log(`[sql-column-coverage] 真实缺口 ${baseline.coverage.missing.length} 条：`);
    for (const item of baseline.coverage.missing) {
      console.log(`[sql-column-coverage]   ${item.ref} → ${item.table}.${item.column} 缺 ${item.privilege}（${item.clause}）`);
    }
  }
  assert.deepEqual(
    baseline.coverage.problems,
    [],
    `运行时 SQL 引用的列缺少授权（本片只加检查、不加授权：发现即登记 COVERAGE_EXEMPT 并逐条写进证据页 §4）：\n${baseline.coverage.problems.join('\n')}`,
  );
  assert.deepEqual(
    baseline.coverage.staleExemptions,
    [],
    `COVERAGE_EXEMPT 有陈旧条目（登记了但已不再缺，防躺平）：\n${baseline.coverage.staleExemptions.join('\n')}`,
  );
});

test('sql-column-coverage/runtime_sql_opaque_expressions_accounted：不可静态求值的插值逐条登记', () => {
  for (const item of baseline.sql.opaque) {
    console.log(`[sql-column-coverage] 不可判插值 ${item.ref} ${item.expr}（语句起点 :${item.statementLine}）`);
  }
  assert.deepEqual(
    baseline.opaque.problems,
    [],
    `不可判插值与 OPAQUE_ALLOWLIST 不一致（新增未登记 / 已登记但源码不再存在，两个方向都判红）：\n${baseline.opaque.problems.join('\n')}`,
  );
  assert.equal(baseline.sql.opaque.length, OPAQUE_ALLOWLIST.length, '不可判插值条数与登记条数必须一一对应');
});

test('sql-column-coverage/grant_surface_superset_report：反向只报告计数，不判红', () => {
  const { unusedOnReferencedTables, wholeTableUnused, tableLevel } = baseline.superset;
  const byPrivilege = { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0 };
  for (const item of unusedOnReferencedTables) byPrivilege[item.privilege] += 1;
  console.log(
    `[sql-column-coverage] 反向报告：运行时基准表 ${baseline.referencedTables.length} 张；`
    + `授权了但运行时 SQL 从未引用的列 ${unusedOnReferencedTables.length} 条`
    + `（SELECT ${byPrivilege.SELECT} / INSERT ${byPrivilege.INSERT} / UPDATE ${byPrivilege.UPDATE} / DELETE ${byPrivilege.DELETE}）`,
  );
  for (const item of unusedOnReferencedTables) {
    console.log(`[sql-column-coverage]   未引用列 ${item.table}.${item.column}（${item.privilege}）`);
  }
  console.log(
    `[sql-column-coverage] 反向报告：授权面里整表未被 8 个 store-pg 引用的表 ${wholeTableUnused.length} 张：`
    + `${wholeTableUnused.map((item) => `${item.table}(${item.privileges.join('/')})`).join(', ') || '（无）'}`,
  );
  console.log(
    `[sql-column-coverage] 表级（整表）授权 ${tableLevel.length} 条（按「全列」判定，不属于列级最小权限）：`
    + `${tableLevel.map((item) => `${item.table}:${item.privilege}@${item.file}:${item.line}`).join(', ') || '（无）'}`,
  );
  // 不判红：这里只保证报告本身是「算出来的」，不是常量。
  assert.ok(Array.isArray(unusedOnReferencedTables));
  assert.ok(wholeTableUnused.length >= 0);
  assert.ok(tableLevel.every((item) => typeof item.table === 'string'));
});

/* ============================================================================
 * 七、负控制（缺一不可）
 * ========================================================================== */

test('sql-column-coverage/parser_negative_controls NC1：假 store 用了未授权列 ⇒ 必须红', () => {
  const fakeStore = {
    file: 'tests/unit/fixtures/sql-column-coverage/nc1-fake-store-pg.ts',
    text: [
      "const SENTINEL_COLUMNS = 'id, revision, not_granted_column';",
      'export function fake(pool) {',
      '  return pool.query(`SELECT ${SENTINEL_COLUMNS} FROM public.messages WHERE id = $1`);',
      '}',
    ].join('\n'),
  };
  const audited = auditAll({ storeSources: [fakeStore] });
  assert.equal(audited.coverage.problems.length, 1, `应当恰好 1 条缺失，实际：\n${audited.coverage.problems.join('\n')}`);
  const message = audited.coverage.problems[0];
  assert.ok(message.includes('public.messages.not_granted_column'), `判红必须点名 public.messages.not_granted_column，实际：${message}`);
  assert.ok(message.includes('缺 SELECT'), `判红必须点名缺 SELECT，实际：${message}`);
  assert.ok(message.includes('nc1-fake-store-pg.ts:3'), `判红必须点名文件:行，实际：${message}`);
  assert.equal(audited.coverage.covered, 2, '同一语句里已授权的 id / revision 仍应算覆盖（解析器不是在乱杀）');
  console.log(`[sql-column-coverage] NC1 红字（假 store 用了未授权列）：${message}`);
});

test('sql-column-coverage/parser_negative_controls NC2：表级 GRANT 吞列级 ⇒ 必须标记为「整表」', () => {
  const fakeRoles = {
    file: 'services/api/db/roles/nc2-fake.sql',
    text: [
      'BEGIN;',
      'GRANT UPDATE (revision) ON public.favorites TO gengyun_api_runtime;',
      'GRANT UPDATE ON public.favorites TO gengyun_api_runtime;',
      'COMMIT;',
    ].join('\n'),
  };
  const model = buildGrantModel([fakeRoles]);
  const granted = model.tables.get('public.favorites')?.UPDATE;
  assert.ok(granted !== undefined, 'public.favorites 的 UPDATE 必须存在');
  assert.equal(granted.kind, 'table', `表级 GRANT 必须被标记为「整表」，实际 kind=${granted.kind}`);
  assert.equal(
    Object.prototype.hasOwnProperty.call(granted, 'columns'),
    false,
    '「整表」绝不能带 columns 字段 —— 否则下游会把它当成「列清单为空」而不是「全列」',
  );
  assert.notEqual(
    granted.kind,
    'columns',
    '表级 GRANT 不能被降级成列级（S26 写手实测的「表级吞列级」就在这里）',
  );
  assert.equal(model.swallowed.length, 1, `同类型列级条目被表级吞掉时必须单列记录，实际 ${model.swallowed.length} 条`);
  assert.equal(model.swallowed[0].table, 'public.favorites');
  assert.deepEqual(model.swallowed[0].columns, ['revision'], '被吞的列级条目必须逐列记录（报告里单列）');

  // 整表语义：列级清单里没写的列，也必须算「已授权」——否则就是误判成未授权。
  const lookup = lookupPrivilege(model, 'public.favorites', 'UPDATE');
  assert.equal(lookup.kind, 'table');
  console.log(`[sql-column-coverage] NC2 读数：public.favorites 的 UPDATE 被标记 kind=${granted.kind}（整表）；被吞的同类型列级条目 ${JSON.stringify(model.swallowed[0])}`);
});

test('sql-column-coverage/parser_negative_controls NC3：从真实授权文本删掉一条真实授权 ⇒ 必须红并点名', () => {
  // 本片实测 0 条真实缺口，COVERAGE_EXEMPT 为空 —— 因此按「零缺口」要求做等价且更强的证明：
  // 直接从**真实** 20-login-roles.sql 的文本里删掉一条真实存在的列授权，看正向断言是否变红。
  const target = 'GRANT UPDATE (payload, pending)';
  const source = loadGrantSources().find((item) => item.file === GRANT_MAIN_FILE);
  assert.ok(source !== undefined, `缺少 ${GRANT_MAIN_FILE}`);
  assert.ok(source.text.includes(target), `负控制前置：${GRANT_MAIN_FILE} 里没有 \`${target}\`（形态已变，先同步本文件）`);
  const mutated = source.text.replace(target, 'GRANT UPDATE (pending)');
  assert.notEqual(mutated, source.text, '负控制前置：变异没有真正生效');

  const brokenSources = loadGrantSources().map((item) => (item.file === GRANT_MAIN_FILE ? { file: item.file, text: mutated } : item));
  const broken = auditAll({ grantSources: brokenSources });
  const hit = broken.coverage.problems.filter((message) => message.includes('public.speech_idempotency.payload') && message.includes('缺 UPDATE'));
  assert.equal(hit.length, 1, `删掉 payload 的 UPDATE 授权后必须恰好红 1 条并点名 public.speech_idempotency.payload，实际：\n${broken.coverage.problems.join('\n') || '（没有变红 —— 守卫已恒绿！）'}`);
  assert.ok(hit[0].includes('缺 UPDATE'), `红字必须点名权限：${hit[0]}`);

  // 复原 ⇒ 回绿。
  const restored = auditAll();
  assert.deepEqual(restored.coverage.problems, [], '复原真实授权文本后必须回绿');

  // 登记例外 ⇒ 也回绿（证明例外机制真的在起作用）；但把例外用在**没有缺口**的基准上 ⇒ 必须判陈旧。
  const withExemption = auditAll({
    grantSources: brokenSources,
    exemptions: [
      {
        ref: 'public.speech_idempotency.payload',
        privilege: 'UPDATE',
        reason: '负控制：证明例外表能把已登记的真实缺口压绿',
        owner: 'NC3',
      },
    ],
  });
  assert.deepEqual(withExemption.coverage.problems, [], `登记例外后应变绿，实际：\n${withExemption.coverage.problems.join('\n')}`);

  const stale = auditAll({
    exemptions: [
      {
        ref: 'public.speech_idempotency.payload',
        privilege: 'UPDATE',
        reason: '负控制：该列在真实授权面里其实已授权',
        owner: 'NC3',
      },
    ],
  });
  assert.equal(stale.coverage.staleExemptions.length, 1, '在没有缺口的基准上登记例外必须判「陈旧例外」');
  assert.ok(stale.coverage.staleExemptions[0].includes('public.speech_idempotency.payload'));
  console.log(`[sql-column-coverage] NC3 红字（删掉真实授权后）：${hit[0]}`);
  console.log(`[sql-column-coverage] NC3 复原后红字条数 ${restored.coverage.problems.length}；登记例外后 ${withExemption.coverage.problems.length}；基准上登记例外判陈旧：${stale.coverage.staleExemptions[0]}`);
});

test('sql-column-coverage/parser_negative_controls NC4：登记源码里不存在的 file:line ⇒ 必须红（防躺平）', () => {
  const bogus = [
    ...OPAQUE_ALLOWLIST,
    { ref: 'services/api/src/messages/store-pg.ts:99999', reason: '负控制：源码里根本没有这一行' },
  ];
  const audited = auditAll({ opaqueAllowlist: bogus });
  assert.equal(audited.opaque.problems.length, 1, `陈旧登记必须恰红 1 条，实际：\n${audited.opaque.problems.join('\n')}`);
  assert.ok(
    audited.opaque.problems[0].includes('services/api/src/messages/store-pg.ts:99999'),
    `红字必须点名该 file:line，实际：${audited.opaque.problems[0]}`,
  );

  // 反方向：源码里出现未登记的插值同样判红。
  const fakeStore = {
    file: 'tests/unit/fixtures/sql-column-coverage/nc4-fake-store-pg.ts',
    text: [
      'export function fake(pool, dynamicFilter) {',
      '  return pool.query(`SELECT id FROM public.messages WHERE owner_id = $1${dynamicFilter}`);',
      '}',
    ].join('\n'),
  };
  const unregistered = auditAll({ storeSources: [fakeStore], opaqueAllowlist: [] });
  assert.equal(unregistered.opaque.problems.length, 1, `未登记插值必须恰红 1 条，实际：\n${unregistered.opaque.problems.join('\n')}`);
  assert.ok(unregistered.opaque.problems[0].includes('nc4-fake-store-pg.ts:2'));
  console.log(`[sql-column-coverage] NC4 红字（未登记插值）：${unregistered.opaque.problems[0]}`);
  console.log(`[sql-column-coverage] NC4 红字（陈旧登记）：${audited.opaque.problems[0]}`);
});

test('sql-column-coverage/parser_negative_controls NC5：注释掉真实的 GRANT DELETE ⇒ 必须红并点名整表缺 DELETE', () => {
  // 为什么这条负控制非做不可：DELETE 需求这一面是 2026-10-21 才补进 collectRequirements 的，
  // 而它补进来的直接动机就是「`GRANT DELETE ON public.messages` 忘了给，守卫却一直是绿的」。
  // 因此必须从**真实**授权文本里把这一行注释掉，看正向断言是否真的变红 —— 否则「补了 DELETE 面」
  // 就只是一句注释里的说法。
  const target = 'GRANT DELETE ON public.messages TO gengyun_api_runtime;';
  const source = loadGrantSources().find((item) => item.file === GRANT_MAIN_FILE);
  assert.ok(source !== undefined, `缺少 ${GRANT_MAIN_FILE}`);
  assert.ok(source.text.includes(target), `负控制前置：${GRANT_MAIN_FILE} 里没有 \`${target}\`（形态已变，先同步本文件；`
    + '若这行是被删掉的，那不是“形态变了”，而是又退回了 #17 那个 P0 缺口）');

  // 正向自证①：注释掉 ⇒ 必须红，且恰好点名「public.messages（整表）缺 DELETE」。
  const commented = source.text.replace(target, `-- ${target}`);
  assert.notEqual(commented, source.text, '负控制前置：变异没有真正生效');
  const brokenSources = loadGrantSources().map((item) => (item.file === GRANT_MAIN_FILE ? { file: item.file, text: commented } : item));
  const broken = auditAll({ grantSources: brokenSources });
  const hit = broken.coverage.problems.filter((message) => message.includes('public.messages（整表）') && message.includes('缺 DELETE'));
  assert.equal(
    hit.length,
    1,
    '注释掉 `GRANT DELETE ON public.messages` 后必须恰好红 1 条并点名 public.messages（整表）缺 DELETE，实际：\n'
    + `${broken.coverage.problems.join('\n') || '（没有变红 —— DELETE 这一面又没人看了！）'}`,
  );
  assert.ok(hit[0].includes('services/api/src/messages/store-pg.ts:'), `红字必须点名运行时 SQL 的出处：${hit[0]}`);

  // 复原 ⇒ 必须回绿（证明红字来自这一条授权，不是别的东西在冒烟）。
  const restored = auditAll();
  assert.deepEqual(restored.coverage.problems, [], '复原真实授权文本后必须回绿');

  // 正向自证②：**列级 DELETE 授权不能满足整表需求**。
  // 这一条是把「PG 没有 `GRANT DELETE (col)`」变成断言：哪怕列级 DELETE 列清单覆盖了整张表的每一列，
  // 也不能满足 `DELETE FROM …`（真实 PG 会直接语法/权限报错）。用内存夹具证明判定逻辑没有偷偷放宽。
  const fakeStore = {
    file: 'tests/unit/fixtures/sql-column-coverage/nc5-fake-store-pg.ts',
    text: [
      'export function fake(pool, ownerId) {',
      "  return pool.query('DELETE FROM public.favorites WHERE owner_id = $1', [ownerId]);",
      '}',
    ].join('\n'),
  };
  const fakeGrants = {
    file: 'services/api/db/roles/nc5-fake.sql',
    text: [
      'BEGIN;',
      'GRANT DELETE (id, revision, owner_id) ON public.favorites TO gengyun_api_runtime;',
      'COMMIT;',
    ].join('\n'),
  };
  const columnOnly = auditAll({ storeSources: [fakeStore], grantSources: [fakeGrants] });
  const columnHit = columnOnly.coverage.problems.filter((message) => message.includes('public.favorites（整表）') && message.includes('缺 DELETE'));
  assert.equal(
    columnHit.length,
    1,
    '列级 DELETE 授权不得满足整表 DELETE 需求（PG 无 `GRANT DELETE (col)` 这种形态），实际：\n'
    + `${columnOnly.coverage.problems.join('\n') || '（判定被偷偷放宽成“有列就算有表权限”了！）'}`,
  );
  assert.equal(
    columnOnly.coverage.missing.length,
    1,
    `列级 DELETE 不满足整表需求时，缺口条数必须恰为 1（实际 ${columnOnly.coverage.missing.length}）`,
  );
  console.log(`[sql-column-coverage] NC5 红字（注释掉真实 GRANT DELETE）：${hit[0]}`);
  console.log(`[sql-column-coverage] NC5 红字（只给了列级 DELETE）：${columnHit[0]}`);
});

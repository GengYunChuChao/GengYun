/**
 * GY-I07 · **台账 ↔ 代码** 的排序口径防漂移钉子（台账半边）。
 *
 * 为什么需要这一条（实测事实，不是推测）：
 *   代码侧的排序有两个既有钉子：
 *     · `tests/unit/knowledge-order-created-at.test.mjs`（JS 归并半边 + 真实 HTTP 读数）；
 *     · `tests/unit/knowledge-order-sql-direction.test.mjs`（DB `ORDER BY` 半边）。
 *   两者都只钉**代码**。而 `docs/architecture/contract-status.json` 里关于「知识列表排序」的
 *   **文字**没有任何机械检查：
 *     · `:716`（`operations.listKnowledge.blocker`）写「当前 id_asc 排序仍不同于冻结
 *       (created_at DESC,id DESC)，实际表/投影无 created_at」；
 *     · `:3164`（`dimensions.pagination.blocker`）写「知识 id_asc 仍偏离冻结 …缺历史创建时点字段」。
 *   事实是：排序早在 `b56ba9d`（PR #209，2026-10-16 合入 main）就已改成
 *   `services/api/src/knowledge/service.ts:76` 的 `ORDER BY created_at DESC, id DESC`，
 *   迁移 `services/api/db/migrations/0012_knowledge_created_at.sql` 也把 `created_at` 落到了投影里。
 *   ⇒ 台账这两处是**滞后文字**，不是功能缺失。
 *
 * 后果已经发生过：`docs/verification/gy-i07-knowledge-miniprogram-wiring-20261021.md:76`
 *   （2026-10-21，晚于 #209 五天）据台账写下「现行实现为 `id_asc`」，把滞后文字当成了实现事实。
 *   本文件把「台账怎么说 / 代码怎么做」两侧一起钉住，让同类复制粘贴漂移在下一次就红。
 *
 * 四条判据（错一条即红）：
 *   ① **三方逐字一致**：冻结契约 `docs/architecture/state-contract.md:32` 的排序子句、
 *      `service.ts` 实际发出的读语句 `ORDER BY` 子句、本文件内置的字面量必须逐字相同
 *      ⇒ 改代码或改契约任一侧都会红。
 *   ② **滞后登记必须同时与台账和代码成立**：登记的 `ledger_line` 必须仍指向该条目的
 *      `blocker` 行、`blocker` 原文必须逐字未改、其中仍含 `id_asc`、而代码里**已经**不再有
 *      `id_asc` ⇒ 台账被修正（或又被改回）都必须同步更新登记，不能沉默漂移。
 *   ③ **未登记的新漂移直接红**：台账里任何条目（operation 或 8 条横切维度）只要在
 *      `blocker` 里声称了 `id_asc`／`id_desc` 口径，就必须出现在登记表里；新增一处即红。
 *   ④ **零放宽自证**：本文件不得含软化钩子；登记表不得为空、不得与台账脱钩。
 *
 * 红线：本文件**只读**仓库文件，不写台账、不改任何 `status` 字段。
 * `status` 变更属监工权限；本文件与登记表只提供证据，不代替判定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置反推（tests/unit/ → ../..），不用 `process.cwd()`。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readText = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const LEDGER = 'docs/architecture/contract-status.json';
const SERVICE = 'services/api/src/knowledge/service.ts';
const FROZEN_DOC = 'docs/architecture/state-contract.md';
const REGISTRY = 'docs/verification/gy-r29-i07-ledger-lags.json';

/** 冻结契约的排序子句字面量（第二重独立来源：即使代码与文档同时被改，也必须与此相符）。 */
const REQUIRED_ORDER_BY = 'ORDER BY created_at DESC, id DESC';

/** 去掉块注释与行尾 `//` 注释：注释是说明，不是被判的语句本体。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * 从 `service.ts` 源码里取出服务**实际执行**的那条读语句：
 * 必须是单引号字符串字面量（不接受拼接/模板，避免「文档写一套、执行另一套」）。
 */
function executedReadStatement(source) {
  const bare = stripComments(source);
  const at = bare.indexOf('SELECT * FROM catalog_read.current_knowledge');
  assert.notEqual(at, -1, '`service.ts` 必须仍发出 `SELECT * FROM catalog_read.current_knowledge`（读视图是唯一读面）');
  assert.equal(bare[at - 1], "'", '读语句必须是**单引号字符串字面量**（否则排序口径存在第二处来源）');
  const close = bare.indexOf("'", at);
  assert.notEqual(close, -1, '读语句的单引号字面量必须闭合');
  return bare
    .slice(at, close)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
}

/** 取 `ORDER BY` 子句本体（含方向关键字与键位，逐字保留），供逐字比较。 */
function orderByClause(sql) {
  const start = sql.indexOf('ORDER BY');
  assert.notEqual(start, -1, `读语句里必须出现 ORDER BY，实际语句：${sql}`);
  return sql.slice(start).replace(/\s+/g, ' ').trim();
}

/** 冻结契约里的排序子句：取 `docs/architecture/state-contract.md` 里「游标列表统一」那一行的 `(…)`。 */
function frozenClause() {
  const line = readText(FROZEN_DOC)
    .split('\n')
    .find((text) => text.includes('游标列表统一'));
  assert.ok(line, `${FROZEN_DOC} 必须仍含「游标列表统一 …」那一行（它是排序口径的唯一冻结出处）`);
  const match = line.match(/`\(([^`]+)\)`/);
  assert.ok(match, `${FROZEN_DOC} 的冻结排序必须仍以反引号括号 (…) 形式给出，实际该行：${line}`);
  return 'ORDER BY ' + match[1].split(',').map((part) => part.trim()).join(', ');
}

/** 台账 JSON。 */
const ledgerJson = () => JSON.parse(readText(LEDGER));
/** 台账原文行（用来核对登记的 `ledger_line` 是否仍指向那一行）。 */
const ledgerLines = () => readText(LEDGER).split('\n');

/** 把 `operations.listKnowledge.blocker` / `dimensions.pagination.blocker` 解析成台账里的字符串。 */
function resolvePointer(json, pointer) {
  const parts = pointer.split('.');
  assert.ok(parts.length === 3 && parts[2] === 'blocker', `登记 pointer 形状必须是 <集合>.<键>.blocker，实际：${pointer}`);
  const [collection, key] = parts;
  const list = json[collection];
  assert.ok(Array.isArray(list), `台账必须仍有 \`${collection}\` 集合`);
  const item = list.find((entry) => entry.id === key || entry.key === key);
  assert.ok(item, `台账 \`${collection}\` 里必须仍有 \`${key}\` 条目（登记已成孤儿 ⇒ 需更新登记）`);
  assert.equal(typeof item.blocker, 'string', `台账 \`${pointer}\` 必须仍是非空字符串`);
  return item.blocker;
}

/** 登记表。 */
const registry = () => JSON.parse(readText(REGISTRY));

/** 本次核对的实况：代码发出的读语句 `ORDER BY` 子句。 */
const codeClause = () => orderByClause(executedReadStatement(readText(SERVICE)));

test('① 三方逐字一致：冻结契约 = service.ts 实际发出的语句 = 内置字面量', () => {
  const clause = codeClause();
  assert.equal(clause, REQUIRED_ORDER_BY,
    `知识列表读语句的 ORDER BY 必须逐字为 \`${REQUIRED_ORDER_BY}\`，实际：${clause}`);
  assert.equal(frozenClause(), REQUIRED_ORDER_BY,
    `冻结契约的排序子句必须仍是 \`${REQUIRED_ORDER_BY}\``);
  assert.equal(clause, frozenClause(),
    `代码排序与冻结契约必须一致；实际代码：${clause}`);

  const record = registry().code_of_record;
  assert.equal(record.path, SERVICE, '登记的实现文件必须就是本次被钉的读路径');
  const line = readText(record.path).split('\n')[record.line - 1];
  assert.ok(line, `登记的实现行号 ${record.line} 越界（代码行数已变 ⇒ 需更新登记）`);
  assert.ok(line.includes(record.needle),
    `登记的实现行 ${record.path}:${record.line} 必须仍含 \`${record.needle}\`，实际该行：${line.trim()}`);
  assert.equal(record.needle, clause, '登记的实现语句必须与代码实际发出的 ORDER BY 子句逐字一致');
});

test('② 台账滞后登记必须同时与台账和代码成立（任一侧变化即红）', () => {
  const json = ledgerJson();
  const lines = ledgerLines();
  const clause = codeClause();
  const lags = registry().lags;
  assert.ok(Array.isArray(lags) && lags.length > 0, '滞后登记不得为空');

  for (const lag of lags) {
    const blocker = resolvePointer(json, lag.pointer);

    // 台账侧：文字必须逐字未改；一旦被修正或改写，本条即红，迫使同步维护登记。
    assert.equal(blocker, lag.ledger_blocker_verbatim,
      `台账 \`${lag.pointer}\` 的 blocker 已变更（可能滞后已被修掉）⇒ 请更新或删除 \`${REGISTRY}\` 里的这条登记。`
      + `\n现文：${blocker}\n登记：${lag.ledger_blocker_verbatim}`);

    // 台账侧：仍必须真的在声称 id_* 口径。
    assert.ok(blocker.includes(lag.claimed_sort_absent_from_code),
      `台账 \`${lag.pointer}\` 的 blocker 必须仍含 \`${lag.claimed_sort_absent_from_code}\`（否则该条不再是「滞后」）`);

    // 代码侧：代码里不得真的还有那个口径 —— 否则本登记就是在替真缺陷打掩护。
    assert.equal(clause.includes(lag.claimed_sort_absent_from_code), false,
      `代码里不得再出现 \`${lag.claimed_sort_absent_from_code}\`（登记的前提是「代码已更新」）；实际语句：${clause}`);

    // 代码侧：登记的实现排序必须与代码实际子句一致。
    assert.equal(lag.code_sort, clause.replace(/^ORDER BY /, ''),
      `登记的实现排序 \`${lag.code_sort}\` 必须与代码实际一致；实际：${clause}`);

    // 行号侧：登记的 ledger_line 必须仍指向该 blocker 行（行号漂移即红）。
    const anchored = lines[lag.ledger_line - 1];
    assert.ok(typeof anchored === 'string', `登记的 ledger_line ${lag.ledger_line} 越界（台账行数已变）`);
    assert.ok(anchored.includes(lag.ledger_blocker_verbatim.slice(0, 25)),
      `\`${lag.ledger_file}:${lag.ledger_line}\` 必须仍是该 blocker 行；实际该行：${anchored.trim().slice(0, 80)}`);

    // 状态侧：不改 status，但要钉住「当时读到的 status 是哪个值」，供监工核对。
    const statusLine = lines[lag.status_field_line - 1];
    assert.ok(typeof statusLine === 'string', `登记的 status_field_line ${lag.status_field_line} 越界`);
    assert.ok(statusLine.includes(`"status": ${JSON.stringify(lag.status_value)}`),
      `\`${lag.ledger_file}:${lag.status_field_line}\` 必须仍是 status 行且值为 \`${lag.status_value}\`；`
      + `实际：${statusLine.trim()}（status 变更属监工权限：若监工已改，请同步登记表，不要在本文件放过）`);
  }
});

test('③ 台账里任何未登记的 id_* 排序声称都必须判红', () => {
  const json = ledgerJson();
  const registered = new Set(registry().lags.map((lag) => lag.pointer));
  const claims = [];
  for (const operation of json.operations) claims.push([`operations.${operation.id}.blocker`, operation.blocker]);
  for (const dimension of json.dimensions) claims.push([`dimensions.${dimension.key}.blocker`, dimension.blocker]);

  const claiming = claims.filter(([, blocker]) => typeof blocker === 'string' && /\bid_(asc|desc)\b/.test(blocker));
  for (const [pointer, blocker] of claiming) {
    assert.ok(registered.has(pointer),
      `台账 \`${pointer}\` 在 blocker 里声称了 id_* 排序口径，但未登记在 \`${REGISTRY}\` ⇒ `
      + `请先按代码事实核对：若代码已是 ${REQUIRED_ORDER_BY}，这就是又一处「台账滞后」，登记它；`
      + `若代码真的退回了 id_*，那是真缺陷，不许用登记掩盖。\n原文：${blocker}`);
  }

  // 知识域两条入口（列表/详情）必须在被核对的集合里，避免「换个 id 就绕过」。
  const knowledgeOps = json.operations.filter((operation) => String(operation.path).includes('/knowledge'));
  assert.ok(knowledgeOps.length >= 2, `台账里知识域 operation 至少 2 条（列表 + 详情），实际 ${knowledgeOps.length}`);
  for (const operation of knowledgeOps) {
    assert.equal(typeof operation.blocker, 'string', `台账 ${operation.id} 必须带 blocker（否则无从核对）`);
  }
});

test('④ 零放宽自证：本文件不含软化钩子，登记表与台账同源', () => {
  const self = readText('tests/unit/knowledge-ledger-sort-drift.test.mjs');
  const tokens = ['t' + 'est.' + 'skip', 't' + 'est.' + 'only', '{ ' + 'todo', 'sk' + 'ip:'];
  for (const token of tokens) {
    assert.equal(self.includes(token), false, `本文件不得含软化钩子 \`${token}\`：判据只许增，不许被改成跳过`);
  }
  const table = registry();
  assert.equal(table.schema, 'gy-i07-ledger-lag-registry/v1', `登记表 schema 必须是 gy-i07-ledger-lag-registry/v1`);
  assert.equal(table.frozen_sort.pointer, `${FROZEN_DOC}:32`, '登记的冻结出处必须仍是 state-contract.md:32');
  assert.equal('ORDER BY ' + table.frozen_sort.clause, REQUIRED_ORDER_BY,
    `登记的冻结子句必须与内置字面量一致，实际：${table.frozen_sort.clause}`);  assert.equal(table.lags.length, 2, `本基线登记 2 条（listKnowledge 与 pagination 维度）；数目变化必须显式改本行`);
});

/**
 * GY-R60 · 「外发账本 `public.exports.error_code` 只收契约码」的钉子（纯静态：只读文件文本）。
 *
 * ## 缺口（改前，实测）
 * `services/api/src/privacy/task-egress.ts:153` 与 `services/api/src/privacy/synthesis-egress.ts:267`
 * 在「受理在预留之后失败」时把 `'ACCEPTANCE_FAILED'` 写进账本行 —— 该值**不在**
 * `services/api/src/contract.ts:29` 的 `ERROR_CODES`（24 值）里，全仓也没有任何文档定义它
 * （`docs/**` grep `ACCEPTANCE_FAILED` 零命中）。而同文件 `task-egress.ts:203-206` 的
 * `errorCodeOf()` 注释却写着「只认契约闭集 … 账本只收短 token」：**写入点自相违背**。
 * 契约外的码一旦被读面投影出来，`statusForErrorCode()` 抛错、后台「码→文案」表没有词条
 * （`tests/ui-unified-states.test.mjs` 只覆盖 `ERROR_STATUS_MAP` 的成员），只能退化成未知码。
 *
 * ## 判据形态（白名单式，不是「至少 N 次」）
 *   ① 扫描面是**冻结的 6 个文件**（见 `SCANNED_FILES`）：账本有内存（`packages/privacy/ledger.mjs`）
 *      与真库（`services/api/src/privacy/ledger-pg.ts`）两套实现，只扫 `services/api/src` 会漏一半写入点。
 *   ② 命中的 `文件:码` 多重集必须与 `KNOWN_SITES` **逐条相等**（`deepEqual`）：多一处、少一处、改一个码、
 *      把扫描正则该匹配的形状改了，都红。⛔ 不是「至少命中 N 次」——那种写法在正则失配时零命中即全绿。
 *   ③ 下界守卫：`SCANNED_FILES` 里每个文件都必须**存在**（`readFileSync` 直接抛 ENOENT，不吞），
 *      且总命中数必须等于 `KNOWN_SITES.length`。扫描面被收窄到不存在的路径时立刻红。
 *   ④ 每个命中的码必须 ∈ `ERROR_CODES`，**或者**在 `DOCUMENTED_EXCEPTIONS` 里逐条登记过理由；
 *      且 `DOCUMENTED_EXCEPTIONS` 的每个成员都必须真的出现在命中里（不许留过期条目）、
 *      必须 ∉ `ERROR_CODES`（一旦它进了契约就该从例外表删掉，逼人回来改口径）。
 *
 * ## `DOCUMENTED_EXCEPTIONS` 为什么今天还留着 2 个值
 * 它们是**已登记、未在本片修**的既有缺口，不是"合法自造码"：
 *   - `OBJECT_CANCELLED`（`ledger-pg.ts:699/722` 的取消墓碑、`in-flight.mjs:210`）：语义是「该对象版本
 *     已被取消，迟到的回调不得复活它」，与 `OBJECT_UNAVAILABLE`（对象不可用）不是一回事，硬改字面量
 *     会把语义差掩盖掉。它目前**没有臂级断言**（两条真库臂 `egress-ledger-pg.mjs:420`、
 *     `egress-revoke-race-pg.mjs:355` 断言的是 `CONSENT_WITHDRAWN`，`OBJECT_CANCELLED` 零命中），
 *     正确出路是给它一个契约内专用码并补臂，属契约文件改动 ⇒ 本片范围不含，留给后续切片。
 *   - `CONSENT_WITHDRAWN`（`ledger-pg.ts:741` 的撤回 SQL、`ledger.mjs:478` 的内存账本）：
 *     语义是「因同意被撤回而失败」，比 `CONSENT_REQUIRED`（403，缺授权）更准；被上面两条真库臂
 *     与 `tests/unit/account-deletion-egress-revoker-reachability.test.mjs:33` 的 SQL 正则钉住。
 *
 * ## 负控制（仓库外临时副本，原始失败行见交付报告）
 *   ① 往 `packages/privacy/ledger.mjs` 塞 `record.errorCode = 'TOTALLY_FAKE_CODE';` ⇒ 红
 *   ② 从 `KNOWN_SITES` 删掉一条 ⇒ 红
 *   ③ 把 `SCANNED_FILES` 里一项改成不存在的路径 ⇒ 红
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES } from '../../services/api/src/contract.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 账本 `error_code` 的写入面（相对仓库根，正斜杠）。
 * ⛔ 加文件必须同时补 `KNOWN_SITES`：漏登记的写入点不会被扫到，等于自己把钉子拆了。
 */
const SCANNED_FILES = Object.freeze([
  'services/api/src/privacy/task-egress.ts',
  'services/api/src/privacy/synthesis-egress.ts',
  'services/api/src/privacy/ledger-pg.ts',
  'packages/privacy/egress.mjs',
  'packages/privacy/ledger.mjs',
  'packages/privacy/in-flight.mjs',
]);

/**
 * 写入形态。今天命中的是 `option` / `sql-eq` / `sql-then` / `assign` / `ternary`；
 * `field`（`error_code: 'X'` 这种对象字面量）今天 0 命中，留着是为了将来改成分列写入时也被抓到。
 */
const PATTERNS = Object.freeze([
  { kind: 'option', re: /\berrorCode\s*:\s*'([A-Z][A-Z0-9_]{1,63})'/g },
  { kind: 'field', re: /\berror_code\s*:\s*'([A-Z][A-Z0-9_]{1,63})'/g },
  { kind: 'sql-eq', re: /\berror_code\s*=\s*'([A-Z][A-Z0-9_]{1,63})'/g },
  { kind: 'sql-then', re: /\bTHEN\s+'([A-Z][A-Z0-9_]{1,63})'/g },
  { kind: 'assign', re: /\.errorCode\s*=\s*'([A-Z][A-Z0-9_]{1,63})'/g },
  { kind: 'ternary', re: /\?\s*'([A-Z][A-Z0-9_]{1,63})'\s*:\s*'([A-Z][A-Z0-9_]{1,63})'/g },
]);

/**
 * 今天已知的账本写入点（`文件:码`，多重集：同一个文件同一码出现两次就写两条）。
 * ⛔ 这张表是**精确断言**，不是上界：加宽（塞新写入点）与过期（删了代码没删表）都要红。
 */
const KNOWN_SITES = Object.freeze([
  'packages/privacy/egress.mjs:PROVIDER_OUTCOME_UNKNOWN',
  'packages/privacy/egress.mjs:PROVIDER_UNAVAILABLE',
  'packages/privacy/in-flight.mjs:OBJECT_CANCELLED',
  'packages/privacy/ledger.mjs:CONSENT_WITHDRAWN',
  'services/api/src/privacy/ledger-pg.ts:CONSENT_WITHDRAWN',
  'services/api/src/privacy/ledger-pg.ts:OBJECT_CANCELLED',
  'services/api/src/privacy/ledger-pg.ts:OBJECT_CANCELLED',
  'services/api/src/privacy/synthesis-egress.ts:OBJECT_UNAVAILABLE',
  'services/api/src/privacy/task-egress.ts:OBJECT_UNAVAILABLE',
]);

/** 已登记、未在本片修的例外（理由见文件头）。⛔ 加宽必须同时写清为什么不改，不许当逃生门用。 */
const DOCUMENTED_EXCEPTIONS = Object.freeze(['OBJECT_CANCELLED', 'CONSENT_WITHDRAWN']);

function scanSites() {
  const hits = [];
  for (const relPath of SCANNED_FILES) {
    // ⚠ 不 try/catch：路径写错、文件被挪走必须当场抛（下界守卫）。
    const text = readFileSync(join(ROOT, relPath), 'utf8');
    for (const { re } of PATTERNS) {
      for (const match of text.matchAll(new RegExp(re.source, re.flags))) {
        for (const code of match.slice(1)) {
          if (code) hits.push(`${relPath}:${code}`);
        }
      }
    }
  }
  return hits.sort();
}

test('扫描面是冻结的 6 个文件，且每个都真实存在（下界守卫）', () => {
  assert.deepEqual([...SCANNED_FILES], [
    'services/api/src/privacy/task-egress.ts',
    'services/api/src/privacy/synthesis-egress.ts',
    'services/api/src/privacy/ledger-pg.ts',
    'packages/privacy/egress.mjs',
    'packages/privacy/ledger.mjs',
    'packages/privacy/in-flight.mjs',
  ]);
  for (const relPath of SCANNED_FILES) {
    const text = readFileSync(join(ROOT, relPath), 'utf8');
    assert.ok(text.length > 0, `扫描面文件为空：${relPath}`);
  }
});

test('账本 error_code 的写入点是精确的已知集合（多一处 / 少一处 / 改一个码都红）', () => {
  const hits = scanSites();
  assert.deepEqual(
    hits,
    [...KNOWN_SITES].sort(),
    '账本 error_code 写入点漂移了：新增/删除写入点必须同步 KNOWN_SITES，改码必须过语义审查',
  );
  assert.equal(hits.length, KNOWN_SITES.length, '命中数必须等于冻结清单长度（不许零命中即全绿）');
});

test('写入点用到的码必须属于契约 ERROR_CODES，例外只能来自已登记例外表', () => {
  const hits = scanSites();
  const usedCodes = [...new Set(hits.map((hit) => hit.slice(hit.lastIndexOf(':') + 1)))].sort();
  const contractCodes = [...ERROR_CODES].sort();
  const illegal = usedCodes.filter(
    (code) => !contractCodes.includes(code) && !DOCUMENTED_EXCEPTIONS.includes(code),
  );
  assert.deepEqual(illegal, [], `账本写入了契约外、且未登记理由的错误码：${illegal.join(', ')}`);

  for (const code of DOCUMENTED_EXCEPTIONS) {
    assert.ok(
      usedCodes.includes(code),
      `例外表里的 ${code} 在扫描面上已不存在：请从 DOCUMENTED_EXCEPTIONS 删掉过期条目`,
    );
    assert.equal(
      contractCodes.includes(code),
      false,
      `${code} 已进契约 ERROR_CODES：应从 DOCUMENTED_EXCEPTIONS 删掉（例外表不许并存）`,
    );
  }
});

test('改掉的那两处（受理失败释放预留）用的是契约码 OBJECT_UNAVAILABLE，不是自造码', () => {
  // 只判**代码**，不判注释：这两处原位留了「⛔ 不得写自造码（原写法 …）」的说明，注释里提到旧值
  // 是刻意的翻值记录，不该让钉子变红。
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const relPath of [
    'services/api/src/privacy/task-egress.ts',
    'services/api/src/privacy/synthesis-egress.ts',
  ]) {
    const source = stripComments(readFileSync(join(ROOT, relPath), 'utf8'));
    assert.equal(
      source.includes('ACCEPTANCE_FAILED'),
      false,
      `${relPath} 的代码里仍在写契约外的 ACCEPTANCE_FAILED`,
    );
    assert.match(
      source,
      /markFailed\([^)]*\{\s*errorCode:\s*'OBJECT_UNAVAILABLE'\s*\}/,
      `${relPath} 的受理失败分支必须用契约既有码 OBJECT_UNAVAILABLE`,
    );
    assert.ok(ERROR_CODES.includes('OBJECT_UNAVAILABLE'));
  }
});

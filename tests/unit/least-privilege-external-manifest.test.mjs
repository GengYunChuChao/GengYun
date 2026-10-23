/**
 * 清单**内容**的静态门禁：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 里
 * `external_manifest` 与 `allow_table_dml` 的行集合。
 *
 * 为什么要这条测试（R34 对抗性复审 P3）：把 `jobs` 三元组加回 `external_manifest`，
 * 11 个单测 + `verify-migrations-unique --strict` + `verify-doc-anchors --strict` +
 * `verify-contract-status` **全部 EXIT=0** —— 清单的行集合本身没有任何门禁覆盖，
 * 「后人静默把一张已下线的表加回可见面」可以一路绿灯合入。本测试只读文本、不连库，
 * 把行集合钉成具名清单；多一行、少一行、换一张表都会红。
 *
 * 判红自证（R34 返修时实测）：把 `('jobs', 'auth_privacy', …)` 三行加回 `external_manifest`
 * ⇒ 本文件第 1 条测试转红（`external_manifest 当前 17 行（应为 16）`，EXIT=1），其余 2 条仍绿
 * （jobs 三元组全 false，进不了 `allow_table_dml`）；还原后 3/3 复绿，源文件字节恢复（sha256 前 16 位
 * `6e97cd723f2d84e5`）。
 *
 * 已知过紧（登记，不放松）：本文件把表名与三元组集合都钉成**字面量**，连列数组的书写顺序、
 * 空白都不放宽；若后人确需改动清单，必须同时改本测试与展开区编号——放宽需安全评审，⛔ 不要
 * 为了让某次改动过门禁而在这里加白名单/正则通配。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(
  new URL('../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql', import.meta.url),
  'utf8',
);

/** 取 `名字(...) AS (VALUES` 定义块的行（不含首尾行）：收尾按同层缩进的 `  ),` 认。 */
function valuesBlock(text, headPattern) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => headPattern.test(line));
  assert.notEqual(start, -1, `找不到定义块：${headPattern}`);
  const end = lines.findIndex((line, i) => i > start && /^\s{2}\),\s*$/.test(line));
  assert.notEqual(end, -1, `找不到定义块收尾：${headPattern}`);
  return lines.slice(start + 1, end);
}

/** R34 落定后的 `external_manifest` 表集合（16 张；jobs 于 R34 下线、media 于 R28-W12 下线）。 */
const EXTERNAL_MANIFEST_TABLES = [
  'admin_accounts',
  'admin_scopes',
  'admin_sessions',
  'author_links',
  'consent_policies',
  'consent_records',
  'crops',
  'exports',
  'feature_flags',
  'idempotency_keys',
  'privacy_epochs',
  'recipients',
  'regions',
  'sessions',
  'single_profiles',
  'users',
];

/** `allow_table_dml` 的 16 个三元组（本文件是表级写权限的唯一事实来源）。 */
const ALLOW_TABLE_DML_TRIPLES = [
  'public.community_idempotency.DELETE',
  'public.community_likes.DELETE',
  'public.conversation_turns.DELETE',
  'public.conversations.DELETE',
  'public.favorites.DELETE',
  'public.favorites_idempotency.DELETE',
  'public.history.DELETE',
  'public.history_idempotency.DELETE',
  'public.idempotency_keys.DELETE',
  'public.idempotency_keys.INSERT',
  'public.media_derivatives.DELETE',
  'public.media_object_cleanup.DELETE',
  'public.messages.DELETE',
  'public.ocr_idempotency.DELETE',
  'public.recognition_idempotency.DELETE',
  'public.speech_idempotency.DELETE',
];

test('external_manifest 恰是 16 张具名表，且 jobs / media 不在其中', () => {
  const body = valuesBlock(SOURCE, /external_manifest\(tbl/);
  const names = body
    .map((line) => (/^\s*\('([a-z_][a-z0-9_]*)',/.exec(line) || [])[1])
    .filter(Boolean);

  assert.equal(
    names.length,
    16,
    `external_manifest 当前 ${names.length} 行（应为 16）：行数一变，断言 69-84 的逐表展开区与总数口径都要跟着变`,
  );
  assert.deepEqual(
    [...names].sort(),
    EXTERNAL_MANIFEST_TABLES,
    'external_manifest 的表集合漂移：这条清单是「运行时经 NOLOGIN 组继承来的 public 授权面」快照，改它必须同步 20-login-roles 授权面与证据页',
  );

  for (const retired of ['jobs', 'media']) {
    assert.equal(
      names.includes(retired),
      false,
      `${retired} 不得回到 external_manifest（jobs 于 R34 下线、media 于 R28-W12 移出；加回来等于把一张无人读的表重新算进可见面）`,
    );
  }
});

test('allow_table_dml 恰是 16 个三元组，且不含 jobs', () => {
  const body = valuesBlock(SOURCE, /allow_table_dml\(sch, tbl, priv\) AS \(VALUES/);
  const triples = [];
  for (const line of body) {
    const m = /^\s*\('([a-z_]+)',\s*'([a-z_]+)',\s*'([A-Z]+)'\)/.exec(line);
    if (m) triples.push(`${m[1]}.${m[2]}.${m[3]}`);
  }

  assert.equal(triples.length, 16, `allow_table_dml 当前 ${triples.length} 组（应为 16）`);
  assert.deepEqual(
    [...triples].sort(),
    ALLOW_TABLE_DML_TRIPLES,
    'allow_table_dml 漂移：表级写权限白名单是唯一事实来源，多一组 = 悄悄给了某张表表级写权',
  );
  assert.equal(
    triples.some((t) => t.includes('.jobs.')),
    false,
    'jobs 不得出现在表级写权限白名单里（它连读者都没有）',
  );
});

test('全文不得再把 public.jobs 说成「零写入」', () => {
  // 复审阻塞 2 的防回归：本片一度在 :1506 附近的注释里写「零生产写入」，与证据页立论冲突。
  const lines = SOURCE.split('\n');
  const marker = lines.findIndex((line) => /R34（2026-10-24）/.test(line));
  assert.notEqual(marker, -1, '应保留 R34 的下线注释（说明 jobs 为何移出清单）');
  assert.match(
    lines.slice(marker, marker + 6).join('\n'),
    /零读者/,
    'R34 注释必须按「零读者 / 零入向外键 / 无外发账本关联」的口径写',
  );
  assert.equal(
    /零生产写入|0 生产写入|永不写入/.test(SOURCE),
    false,
    '不得再写「零生产写入」：恢复演练至今仍有文档化手工 INSERT 种子（gy-i24 证据页），本片撤的是授权与判定臂、不是写入能力',
  );
});

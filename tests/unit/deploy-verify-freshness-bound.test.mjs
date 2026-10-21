import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S7 静态守卫：`backup_freshness_days_ok` 是**上界**判据（verify-checklist.md 期望 `<=1` 天），
 * 必须真的会红。
 *
 * 背景：原实现是 `report_ge 'backup_freshness_days_ok' '0' "$age_days"`，判的是
 * `age_days >= 0`；而 `age_days` 由 `(( now - mtime ) / 86400)` 得来，对任何真实 dump
 * （mtime 在过去）恒非负 ⇒ 该判据**永远 PASS**：400 天前的旧备份也记 PASS、脚本退出 0。
 * `report_ge` 只有下界语义，表达不了 `<=1`，故新增 `report_le`；本测试同时核对
 * 「脚本上界 == checklist 上界」，防两处各改一份再漂。
 *
 * 本测试只做**文本结构**核对（不是行为测试）：真正跑该脚本要 Linux 的 root / runuser /
 * unix socket / postgres 系统用户，本机（Windows）跑不了。行为级复现见 PR 正文。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = 'deploy/postgres-cvm/verify-cvm-postgres.sh';
const checklistPath = 'deploy/postgres-cvm/verify-checklist.md';
const script = readFileSync(resolve(root, scriptPath), 'utf8');
const checklist = readFileSync(resolve(root, checklistPath), 'utf8');

const KEY = 'backup_freshness_days_ok';

test('verify-cvm-postgres.sh 有上界判定器 report_le（-le 语义，期望串写 <=N）', () => {
  const line = script.split('\n').find((l) => /^report_le\(\)/.test(l));
  assert.ok(line, `${scriptPath} 里找不到 report_le()：上界判据没有判定器，只能退化成恒真比较`);
  assert.match(line, /\[\[\s*"\$3"\s+-le\s+"\$2"\s*\]\]/, 'report_le 必须用 -le 比较');
  assert.match(line, /_pass "\$1" "<=\$\{2\}"/, 'report_le 的期望串必须写成 <=${2}');
  assert.match(line, /_fail "\$1" "<=\$\{2\}"/, 'report_le 的失败分支也必须写期望 <=${2}');
});

test(`verify-cvm-postgres.sh 的 ${KEY} 是上界判据，不再是恒真的 report_ge '0'`, () => {
  const hits = script.split('\n').filter((l) => l.includes(`'${KEY}'`));
  assert.equal(hits.length, 1, `${KEY} 的判据行应恰好 1 行，实际 ${hits.length} 行`);
  const judge = hits[0].trim();
  assert.match(
    judge,
    new RegExp(`^report_le '${KEY}' '1' "\\$age_days"$`),
    `${KEY} 必须用 report_le 判上界（age_days 恒非负，report_ge '0' 永不红），实际：${judge}`,
  );
});

test(`checklist 与脚本对 ${KEY} 的上界同口径`, () => {
  const row = checklist.split('\n').find((l) => l.includes('`' + KEY + '`'));
  assert.ok(row, `${checklistPath} 里找不到 ${KEY} 的判据行`);
  const declared = row.match(/`<=(\d+)`/);
  assert.ok(declared, `${checklistPath} 的 ${KEY} 行没有写明上界（形如 \`<=1\`），实际：${row.trim()}`);
  const bound = declared[1];
  assert.match(
    script,
    new RegExp(`report_le '${KEY}' '${bound}'`),
    `脚本上界与 checklist 不一致：checklist 写 <=${bound} 天`,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R28-S37 静态守卫：`deploy/postgres-cvm/verify-cvm-postgres.sh` 的「最小权限断言」段必须
 * **同时**判 psql 退出码与末行文本。
 *
 * 背景：`sql/90-assert-least-privilege.sql` 判红时 RAISE EXCEPTION（psql 退出 3），stderr 的
 * `ERROR:` / `CONTEXT:` 经 `2>&1` 排在 `FAIL:` 判决文本之后 ⇒ 末行不再是判决文本。旧写法
 * `… | tr -d '\r' || true` 把退出码吞掉、只比末行，于是「退出码非 0 而末行恰为 ok」会假绿。
 *
 * 本测试只做**文本结构**核对（不是行为测试）：真正跑该脚本要 Linux 的 root / runuser /
 * unix socket / postgres 系统用户，本机（Windows）跑不了。行为级复现见
 * docs/verification/gy-r28-verify-cvm-assert-rc-20261021.md §4。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = 'deploy/postgres-cvm/verify-cvm-postgres.sh';
const script = readFileSync(resolve(root, scriptPath), 'utf8');

const endMarker = `report_eq 'least_privilege_assert' 'ok' "$verdict"`;
const blockStart = script.indexOf('\nassert_rc=0\n');
const blockEnd = script.indexOf(endMarker);

/** 取出「最小权限断言」这一段的原文（从 assert_rc=0 到 report_eq 报告行）。 */
function assertBlock() {
  assert.ok(blockStart >= 0, `${scriptPath} 里找不到 assert_rc=0 初始化（段起始标记）`);
  assert.ok(blockEnd > blockStart, `${scriptPath} 里找不到 ${endMarker}（段结束标记）`);
  return script.slice(blockStart, blockEnd + endMarker.length);
}

test('verify-cvm-postgres.sh 的 90-assert 段捕 psql 退出码，且不再用 `|| true` 吞掉它', () => {
  const block = assertBlock();
  assert.match(block, /\|\| assert_rc=\$\?/, '缺少 `|| assert_rc=$?`：psql 退出码未被捕获');
  assert.doesNotMatch(block, /\|\|\s*true\b/, '段内仍有 `|| true`：退出码会被吞掉');
});

test('verify-cvm-postgres.sh 的 90-assert 段是「退出码 != 0 或末行 != ok」双判', () => {
  const block = assertBlock();
  assert.match(
    block,
    /\[\[\s*"\$assert_rc"\s+-ne\s+0\s+\|\|\s+"\$verdict"\s*!=\s*'ok'\s*\]\]/,
    '缺少双判条件：[[ "$assert_rc" -ne 0 || "$verdict" != \'ok\' ]]',
  );
  // 退出码非 0 时必须让报告行也变成 FAIL：末行恰好是 ok 时不能靠 report_eq 的字符串比较放行。
  assert.match(
    block,
    /\[\[\s*"\$assert_rc"\s+-eq\s+0\s*\]\]\s*\|\|\s*verdict=/,
    '退出码非 0 时未改写 verdict：末行恰为 ok 时 report_eq 会判 PASS',
  );
});

test('verify-cvm-postgres.sh 的报告键 least_privilege_assert 与「失败仍打印完整输出」都保留', () => {
  assert.equal(
    script.split(endMarker).length - 1,
    1,
    `报告键行应恰好出现一次：${endMarker}`,
  );
  // 缺前置时 90-assert 会打印三步补救指引，只留最后一行会把它丢掉。
  assert.ok(
    script.includes(`printf '%s\\n' "$assert_out" | sed 's/^/         /' >&2`),
    '失败路径未打印 $assert_out 全文（三步补救指引会丢）',
  );
});


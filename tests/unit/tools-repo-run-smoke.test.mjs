/**
 * 真仓冒烟：把几个「有判定、但一直没人接线」的 tools/*.mjs 在**仓库根**上跑一遍并断言退出码。
 *
 * 为什么单独开一个文件（而不是并进 ci-orphan-tools-wired.test.mjs）：元闸门只负责**判接线**，
 * 它自己不去跑被测工具——否则「判据」与「被判对象」混在一起，一个工具挂掉会把元闸门也带红，
 * 分不清是判据坏了还是工具坏了。这里承接的是元闸门白名单里 `kind: "gap"` 的几条：
 *
 *   - tools/run-python.mjs              → npm run test:docs 的第一环，而 test:docs 在 15 份
 *                                         workflow 里 0 命中（本片发现的第二个空档）。
 *   - tools/openapi-route-parity.mjs    → package.json 的 verify:parity 就是它，但没人调用。
 *   - tools/verify-gy-i09-candidates.mjs → 头注自称「供人工与 CI 复核」，0 命中。
 *
 * 接线强度（**如实写明，不拔高**）：
 *   - openapi-route-parity / verify-gy-i09-candidates 跑的是它们的完整判定（真仓路由表 vs 契约、
 *     六类分支与用量守卫），退出码 0/1 就是判定结果；
 *   - run-python 这里只断言 **argv 契约**（不带参数 ⇒ exit 2 并打印用法），不证明 python 启动器
 *     本身可用——真正的使用面在 test:docs 链里，那需要 python3 与文档校验脚本。
 *
 * ⛔ 这个文件**不是** CI 接线的替代品：它只在 `npm run test:unit` 的 glob 里跑，而 test:unit
 * 本身被 engineering-shell.yml:63 点名——所以它确实进了 CI，但它给的判定面比在 workflow 里
 * 单列一步要窄（没有独立 job、没有 failure annotation、没有路径过滤）。证据页的「不声称」写了这条。
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('tools/run-python.mjs：不带参数必须 exit 2 并打印用法（argv 契约）', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'run-python.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, `不带参数应 exit 2，实际 ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /用法：node tools\/run-python\.mjs/, '缺少用法提示');
});

test('tools/openapi-route-parity.mjs：真仓路由表与契约一致（退出码即判定）', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'openapi-route-parity.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `openapi 路由对齐失败（exit ${result.status}）\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.missing.length, 0, `契约里有、实现里没有的路由：${report.missing.join(', ')}`);
  assert.equal(report.extra.length, 0, `实现里有、契约里没有的路由：${report.extra.join(', ')}`);
  assert.equal(report.ledgerDrift.length, 0, `台账漂移：${report.ledgerDrift.join(', ')}`);
});

test('tools/verify-gy-i09-candidates.mjs：六类分支与用量守卫逐条通过', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'verify-gy-i09-candidates.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `GY-I09 候选判定失败（exit ${result.status}）\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ALL PASS/, '缺少结论行 ALL PASS');
});

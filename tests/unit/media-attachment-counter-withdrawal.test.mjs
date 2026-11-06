import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

/**
 * 结构锁：`#1029` 的口径不得回来。
 *
 * 2026-11-06 我实现过「用同一 owner 名下存活图片记录数近似每帖上限」，被监工合入（`5f5e8ca7`），
 * 随后按仓库自己的禁令撤回（`#1031`，`main` 上不留实现）。`services/api/src/media/service.ts`
 * 的 docblock 明写：「⛔ 不得用同一 owner 名下存活记录数顶替 `unwired`……累计数会让用户传满 3 张后
 * 永久锁死」。这条禁令此前没有任何机器可读的守护——`#1029` 的实现搬进新文件
 * `services/api/src/media/attachment-counter-pg.ts` 后，结构闸门（只扫 `service.ts`）也放过了它。
 *
 * 这个用例把三件事钉住：
 *   1. 默认计数器表达式**不引用**持久化端口（real 一律 fail-closed 到 `unwired`）；
 *   2. 承载「按 storage 计数」的模块不存在；
 *   3. `CommunityAttachmentCounter.kind` 的联合类型没有新增持久化取值。
 *
 * 它不证明「每帖 ≤3」已实现——那条属 `#1030`（post-scoped 挂载），不在本用例范围。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const servicePath = join(repoRoot, 'services/api/src/media/service.ts');
const withdrawnModulePath = join(repoRoot, 'services/api/src/media/attachment-counter-pg.ts');

function readService() {
  assert.ok(existsSync(servicePath), `找不到 ${servicePath}`);
  return readFileSync(servicePath, 'utf8');
}

test('默认计数器不得按持久化端口分派（#1029 的口径）', () => {
  const source = readService();
  // 抓默认计数器那一行的表达式（createSubstituteAttachmentCounter / createUnwiredAttachmentCounter 的调用点）
  const match = source.match(
    /attachmentCounter\s*=\s*[\s\S]{0,400}?createSubstituteAttachmentCounter\(\)\);\s*\n/
  );
  assert.ok(match, '在 service.ts 里没找到默认附计数器表达式（判据可能已过时，需人工核对）');
  const expression = match[0];
  assert.equal(
    /persistence/i.test(expression),
    false,
    `默认计数器表达式引用了持久化端口，#1029 的口径回来了：\n${expression}`
  );
  assert.match(
    expression,
    /executionMode === 'real' \? createUnwiredAttachmentCounter\(\) : createSubstituteAttachmentCounter\(\)/,
    'real 分支必须落到 createUnwiredAttachmentCounter()（fail-closed），否则每帖上限会被静默放行'
  );
});

test('承载「按 storage 计数」的模块不得存在', () => {
  assert.equal(
    existsSync(withdrawnModulePath),
    false,
    `${withdrawnModulePath} 又出现了：这正是 #1029 搬文件绕结构闸门的路径（#1031 已撤回）`
  );
});

test('CommunityAttachmentCounter.kind 不得新增持久化取值', () => {
  const source = readService();
  const match = source.match(/readonly kind:\s*([^;]+);/);
  assert.ok(match, '在 service.ts 里没找到 CommunityAttachmentCounter.kind 的联合类型');
  const union = match[1];
  for (const bad of ['postgres', 'persistence', 'storage', 'pg']) {
    assert.equal(
      union.includes(`'${bad}'`),
      false,
      `kind 联合里出现 '${bad}'：${union.trim()}（#1029 撤回后应为 'substitute' | 'unwired' | 'injected'）`
    );
  }
});

test('禁令原文仍在（撤回的理由不能被悄悄删掉）', () => {
  const source = readService();
  assert.match(
    source,
    /不得\*\*用同一 owner 名下存活记录数顶替/,
    'service.ts 里那句「⛔ 不得用同一 owner 名下存活记录数顶替 unwired」不见了——那是 #1029 被撤回的依据'
  );
  assert.match(source, /永久锁死/, '禁令的后果描述（累计口径会让用户传满 3 张后永久锁死）不见了');
});

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

/**
 * 结构锁：`#1029` 的**口径**不得回来。
 *
 * 2026-11-06 我实现过「用同一 owner 名下存活图片记录数近似每帖上限」，被监工合入（`5f5e8ca7`），
 * 随后按仓库自己的禁令撤回（`#1031`）。`services/api/src/media/service.ts` 的 docblock 明写：
 * 「⛔ 不得用同一 owner 名下存活记录数顶替 `unwired`……累计数会让用户传满 3 张后永久锁死」。
 *
 * 这条禁令此前没有机器可读的守护——`#1029` 把实现搬进新文件后，只扫 `service.ts` 的结构闸门就放过了它。
 *
 * 本用例锁的是**口径**，不是名字：owner 存活记录数只允许出现在 `substitute`（stub/演示替身）与
 * `injected`（测试注入缝）这两种计数器里；一旦有持久化计数器（`'postgres'` 之类，见 `#1030`/`#1037`），
 * 它必须走**待用池**计数（`countPendingCommunityImages`），不得回落到 owner 生命周期累计。
 *
 * 它不证明「每帖 ≤3」已实现——那条属 `#1030`（post-scoped 挂载），不在本用例范围。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const mediaDir = join(repoRoot, 'services/api/src/media');
const servicePath = join(mediaDir, 'service.ts');

/** 允许消费 `liveCommunityImages` 的计数器种类：替身与测试注入缝。 */
const ALLOWED_KINDS = ["kind: 'substitute'", "kind: 'injected'"];

/** 持久化计数器必须使用的待用池计数口（`#1030` 的正确方向）。 */
const PENDING_POOL_CALL = 'countPendingCommunityImages';

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1 ');
}

function listTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
      continue;
    }
    if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function read(file) {
  assert.ok(existsSync(file), `找不到 ${file}`);
  return stripComments(readFileSync(file, 'utf8'));
}

test('owner 存活记录数只允许出现在 substitute / injected 计数器里（#1029 的口径）', () => {
  const files = listTsFiles(mediaDir);
  assert.ok(files.length > 0, `在 ${mediaDir} 下没有找到 .ts 文件（判据可能已过时，需人工核对）`);

  let sites = 0;
  const violations = [];
  for (const file of files) {
    const source = read(file);
    // 只认**实现**（`countFor(...) { ... }` 或 `countFor(...): T { ... }`），不认调用点
    // （`attachmentCounter.countFor({ ownerId, liveCommunityImages })` 是消费方，不应被本条判据判红）。
    const implementations = [...source.matchAll(/countFor\s*\([^)]*\)\s*(?::[^{;]*)?\{/g)];
    for (const hit of implementations) {
      sites += 1;
      const start = Math.max(0, hit.index - 600);
      const window = source.slice(start, hit.index + 600);
      if (!window.includes('liveCommunityImages')) continue;
      if (ALLOWED_KINDS.some((kind) => window.includes(kind))) continue;
      violations.push(`${file.slice(repoRoot.length + 1)}：${window.trim().slice(0, 240)}`);
    }
  }

  assert.ok(sites > 0, '一个 countFor 实现都没找到（判据可能已过时，需人工核对）');
  assert.deepEqual(
    violations,
    [],
    '有 countFor 在消费「同一 owner 名下存活记录数」，但所在计数器不是 substitute / injected：\n' +
      `${violations.join('\n---\n')}\n` +
      '这正是 #1029 被撤回的口径（生命周期累计 ⇒ 传满 3 张后永久锁死）。'
  );
});

test('持久化计数器必须走待用池计数，不得回落到 owner 累计', () => {
  const source = read(servicePath);
  const union = source.match(/readonly kind:\s*([^;]+);/);
  assert.ok(union, '在 service.ts 里没找到 CommunityAttachmentCounter.kind 的联合类型');

  const persistenceKinds = ['postgres', 'persistence', 'storage', 'pg'].filter((kind) =>
    union[1].includes(`'${kind}'`)
  );
  if (persistenceKinds.length === 0) {
    // 未接线的现状：没有任何持久化计数器。此时只要求 real 默认仍是 fail-closed。
    assert.match(
      source,
      /executionMode === 'real'[\s\S]{0,120}?createUnwiredAttachmentCounter\(\)/,
      'real 默认必须落 createUnwiredAttachmentCounter()（fail-closed），否则每帖上限会被静默放行'
    );
    return;
  }

  assert.ok(
    source.includes(PENDING_POOL_CALL),
    `kind 联合里出现了持久化计数器（${persistenceKinds.map((k) => `'${k}'`).join('／')}），` +
      `但 service.ts 没有引用 ${PENDING_POOL_CALL}——持久化计数器必须数待用池，不能数 owner 存活记录` +
      '（#1029 的口径会让用户传满 3 张后永久锁死）'
  );
});

test('kind 联合只有一处声明（黑名单不能被第二份声明绕过）', () => {
  const source = read(servicePath);
  const declarations = [...source.matchAll(/readonly kind:\s*[^;]+;/g)];
  assert.equal(
    declarations.length,
    1,
    `service.ts 里有 ${declarations.length} 处 CommunityAttachmentCounter.kind 声明：\n` +
      declarations.map((d) => d[0]).join('\n')
  );
});

test('承载「按 owner 存活记录计数」的新模块不得出现', () => {
  const offenders = [];
  for (const file of listTsFiles(mediaDir)) {
    const name = file.slice(mediaDir.length + 1);
    if (!/^attachment-counter[-.]/.test(name)) continue;
    const source = read(file);
    if (source.includes('liveCommunityImages')) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join('、')} 在按 owner 存活记录计数：这正是 #1029 搬文件绕结构闸门的路径（#1031 已撤回）`
  );
});

test('测试注入缝不得成为生产默认计数器', () => {
  const source = read(servicePath);
  const match = source.match(/attachmentCounter\s*=\s*[\s\S]{0,400}?createSubstituteAttachmentCounter\(\)\);\s*\n/);
  assert.ok(match, '在 service.ts 里没找到默认附计数器表达式（判据可能已过时，需人工核对）');
  const expression = match[0];
  assert.equal(
    expression.includes('createInjectedAttachmentCounter'),
    false,
    `默认计数器落到了测试注入缝（kind:'injected'）——那是测试专用入口，放它当默认等于把「按 owner 计数」\n` +
      `重新变成生产口径：\n${expression}`
  );
});

test('禁令原文仍在（撤回的理由不能被悄悄删掉）', () => {
  // 禁令本身写在 docblock 里，所以这一条用**原始文本**，不做注释剥离。
  assert.ok(existsSync(servicePath), `找不到 ${servicePath}`);
  const source = readFileSync(servicePath, 'utf8');
  assert.match(
    source,
    /不得\*\*用同一 owner 名下存活记录数顶替/,
    'service.ts 里那句「⛔ 不得用同一 owner 名下存活记录数顶替 unwired」不见了——那是 #1029 被撤回的依据'
  );
  assert.match(source, /永久锁死/, '禁令的后果描述（累计口径会让用户传满 3 张后永久锁死）不见了');
});

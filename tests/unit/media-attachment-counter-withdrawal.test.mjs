import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import * as mediaService from '../../services/api/src/media/service.ts';

/**
 * 结构锁：`#1029` 的**口径**不得回来。
 *
 * 2026-11-06 我实现过「用同一 owner 名下存活图片记录数近似每帖上限」，被监工合入（`5f5e8ca7`），
 * 随后按仓库自己的禁令撤回（`#1031`）。`services/api/src/media/service.ts` 的 docblock 明写：
 * 「⛔ 不得用同一 owner 名下存活记录数顶替 `unwired`……累计数会让用户传满 3 张后永久锁死」。
 *
 * 前两版把判据写成「源码文本形状」（正则抓默认表达式、黑名单抓 `kind` 字面量），结果是：
 * 它会把 `#1030` 的**正确**实现判红，同时被「别名 / 展开运算符 / 换目录 / 邻居窗口」一句话绕过。
 * 现在锁的是**运行时行为**：把 `service.ts` 里导出的每一个 `create*AttachmentCounter()` 工厂造出来，
 * 用两个不同的 `liveCommunityImages` 喂它 —— 除 `substitute`（替身）与 `injected`（测试注入缝）之外，
 * 任何计数器都**不得**让返回值随 owner 存活记录数变化。
 *
 * 它不证明「每帖 ≤3」已实现——那条属 `#1030`（post-scoped 挂载），不在本用例范围。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const servicePath = join(repoRoot, 'services/api/src/media/service.ts');
const srcRoot = join(repoRoot, 'services/api/src');

/** owner 存活记录数只允许作为这两种计数器的输入（替身与测试注入缝）。 */
const LIVE_COUNT_KINDS = new Set(['substitute', 'injected']);

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

async function probe(counter) {
  const base = { ownerId: 'r83-probe-owner' };
  let low;
  let high;
  try {
    low = await counter.countFor({ ...base, liveCommunityImages: 0 });
    high = await counter.countFor({ ...base, liveCommunityImages: 7 });
  } catch {
    // 需要真实存储/网络的持久化计数器：构造得出但查询会抛（本机无 PG）。这里不下判断，
    // 因为「抛错」本身不构成「按 owner 计数」的证据。
    return { inconclusive: true };
  }
  return { low, high };
}

test('除替身与测试缝外，任何计数器的返回值都不得随 owner 存活记录数变化', async () => {
  const factories = Object.entries(mediaService).filter(
    ([name, value]) => typeof value === 'function' && /^create\w*AttachmentCounter$/.test(name)
  );
  assert.ok(
    factories.length > 0,
    'service.ts 里没有导出任何 create*AttachmentCounter() 工厂（判据可能已过时，需人工核对）'
  );

  const violations = [];
  let probed = 0;
  for (const [name, factory] of factories) {
    if (factory.length > 0) continue; // 需要注入参数的工厂（如 createInjectedAttachmentCounter）另行构造
    let counter;
    try {
      counter = factory();
    } catch {
      continue;
    }
    if (!counter || typeof counter.countFor !== 'function') continue;
    if (LIVE_COUNT_KINDS.has(counter.kind)) continue;
    const result = await probe(counter);
    if (result.inconclusive) continue;
    probed += 1;
    if (result.low !== result.high) {
      violations.push(
        `${name}()：kind=${String(counter.kind)}，countFor 对 liveCommunityImages=0 返回 ${String(
          result.low
        )}、对 =7 返回 ${String(result.high)}`
      );
    }
  }

  assert.ok(probed > 0, '一个可探的计数器都没有（判据可能已过时，需人工核对）');
  assert.deepEqual(
    violations,
    [],
    '有计数器在按「同一 owner 名下存活记录数」计数，但它不是替身/测试缝：\n' +
      `${violations.join('\n')}\n` +
      '这正是 #1029 被撤回的口径（生命周期累计 ⇒ 传满 3 张后永久锁死）。'
  );
});

test('测试注入缝不得出现在生产装配里（只允许它在 service.ts 的定义处）', () => {
  const offenders = [];
  const serviceRel = servicePath.slice(repoRoot.length + 1);
  for (const file of listTsFiles(srcRoot)) {
    const rel = file.slice(repoRoot.length + 1);
    const source = readFileSync(file, 'utf8');

    const calls = [...source.matchAll(/createInjectedAttachmentCounter\s*\(/g)].length;
    if (calls > 0) {
      // 允许的唯一一处：service.ts 里的定义本身 `export function createInjectedAttachmentCounter(`。
      const definitions = [
        ...source.matchAll(/export function createInjectedAttachmentCounter\s*\(/g),
      ].length;
      if (calls > definitions) {
        offenders.push(`${rel}：调用注入缝 ${calls} 次（定义 ${definitions} 处）`);
      }
    }

    // `kind: 'injected'` 是同一个注入缝的另一种写法：换个文件自己造一个同 kind 的计数器，
    // 就能让判据以为「这是测试缝」而放行。除定义处外不允许出现。
    if (rel !== serviceRel && /kind:\s*'injected'/.test(source)) {
      offenders.push(`${rel}：自己声明了 kind: 'injected' 的计数器`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '生产装配里出现了测试注入缝（`createInjectedAttachmentCounter` / `kind: \'injected\'`）——' +
      `它是测试专用入口，放它进装配等于把「按 owner 计数」变成生产口径：\n${offenders.join('\n')}`
  );
});

test('禁令原文仍在（撤回的理由不能被悄悄删掉）', () => {
  assert.ok(existsSync(servicePath), `找不到 ${servicePath}`);
  const source = readFileSync(servicePath, 'utf8');
  assert.match(
    source,
    /不得\*\*用同一 owner 名下存活记录数顶替/,
    'service.ts 里那句「⛔ 不得用同一 owner 名下存活记录数顶替 unwired」不见了——那是 #1029 被撤回的依据'
  );
  assert.match(source, /永久锁死/, '禁令的后果描述（累计口径会让用户传满 3 张后永久锁死）不见了');
});

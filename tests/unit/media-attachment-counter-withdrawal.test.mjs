import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import * as mediaService from '../../services/api/src/media/service.ts';
import { approveRealMediaWiring, createAppMediaService } from '../../services/api/src/media/service.ts';
import { createUnwiredObjectStore } from '../../services/api/src/media/object-store.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';

/**
 * 结构锁：`#1029` 的**口径**不得回来。
 *
 * 2026-11-06 我实现过「用同一 owner 名下存活图片记录数近似每帖上限」，被监工合入（`5f5e8ca7`），
 * 随后按仓库自己的禁令撤回（`#1031`）。`services/api/src/media/service.ts` 的 docblock 明写：
 * 「⛔ 不得用同一 owner 名下存活记录数顶替 `unwired`……累计数会让用户传满 3 张后永久锁死」。
 *
 * 前两版把判据写成「源码文本形状」（正则抓默认表达式、黑名单抓 `kind` 字面量），结果是：
 * 它会把 `#1030` 的**正确**实现判红，同时被「别名 / 展开运算符 / 换目录 / 邻居窗口」一句话绕过。
 * 第三版改成**运行时行为**：把 `service.ts` 里导出的每一个 `create*AttachmentCounter()` 工厂造出来，
 * 用两个不同的 `liveCommunityImages` 喂它 —— 除 `substitute`（替身）与 `injected`（测试注入缝）之外，
 * 任何计数器都**不得**让返回值随 owner 存活记录数变化。
 *
 * 第三版仍有洞（第三轮独立审查 P1）：`#1029` 的计数器在**独立模块**
 * `services/api/src/media/attachment-counter-pg.ts`，**不从** `service.ts` 导出，是**单参**工厂
 * （被 `factory.length > 0` 跳过），且只在 `options.persistence?.kind === 'postgres'` 时接线。
 * 也就是说：把那个实现原样放回来，上面两条判据一条都不会响。所以本文件再加一条
 * **装配断言**——直插 `createAppMediaService` 的默认计数器选择：real + 有 PG 持久化、
 * 但没有任何权威计数能力时，默认计数器必须是 `unwired` 且对 owner 存活数不敏感。
 *
 * 它不证明「每帖 ≤3」已实现——那条属 `#1030`（post-scoped 挂载），不在本用例范围。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const servicePath = join(repoRoot, 'services/api/src/media/service.ts');
const srcRoot = join(repoRoot, 'services/api/src');

/** owner 存活记录数只允许作为这两种计数器的输入（替身与测试注入缝）。 */
const LIVE_COUNT_KINDS = new Set(['substitute', 'injected']);

/**
 * `kind` 字面量的注入面：单引号、双引号、反引号都算。
 *
 * 反引号在正则字面量的字符类里是普通字符，无需转义（用模板串拼正则时才要写成 `\\``）。
 */
const INJECTED_KIND_RE = /kind\s*:\s*["'`]injected["'`]/;

/** 单次 `countFor` 的探针预算：真实存储/网络搭不上时不许两秒两秒地拖住整个用例。 */
const PROBE_TIMEOUT_MS = 2_000;

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

/** 给一次 `countFor` 加超时：超时是**可疑**（不是「无法判定」），由调用方计入违规。 */
/** 去掉行注释与块注释后再扫描：本仓注释里引用判据是常态（JSDoc 写 `kind: 'injected'` 很自然），
 * 而扫描要找的是**代码里的**注入缝。剥注释不是放宽判据——保留代码、删掉注释文本即可。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx < 0) return line;
      // 只在「// 之前不是引号内的字符」时截断：够用即可，判据统计的是存在性。
      const head = line.slice(0, idx);
      const quotes = (head.match(/'/g) || []).length + (head.match(/"/g) || []).length;
      return quotes % 2 === 0 ? head : line;
    })
    .join('\n');
}

function withProbeTimeout(promise, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} 在 ${PROBE_TIMEOUT_MS}ms 内没有返回`);
      error.code = 'PROBE_TIMEOUT';
      reject(error);
    }, PROBE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** 问一次 `countFor`，把「答了」「抛错」「超时」三种结局分开，不合并成一个 catch。 */
async function ask(counter, liveCommunityImages) {
  try {
    const value = await withProbeTimeout(
      Promise.resolve().then(() =>
        counter.countFor({ ownerId: 'r83-probe-owner', liveCommunityImages })
      ),
      `countFor(liveCommunityImages=${liveCommunityImages})`
    );
    return { status: 'answered', value };
  } catch (error) {
    if (error && error.code === 'PROBE_TIMEOUT') return { status: 'timeout', error };
    return { status: 'threw', error };
  }
}

function describeAttempt(result) {
  if (result.status === 'answered') return `返回 ${String(result.value)}`;
  if (result.status === 'timeout') return `超时（>${PROBE_TIMEOUT_MS}ms 未返回）`;
  return `抛错（${result.error && result.error.message ? result.error.message : 'unknown'}）`;
}

/**
 * 探针：分别问 `liveCommunityImages` 取 0 与取 7。
 *
 * 三次返修后的判定表（第三轮审查 P2-1／P2-4）：
 * - **任一次超时** ⇒ suspicious（超时不等于「不依赖」，不许落进 inconclusive 被静默跳过）；
 * - **恰好一次抛错** ⇒ suspicious（「一半能查一半不能查」本身就可疑）；
 * - **两次都抛错** ⇒ inconclusive（需要真实存储/网络的持久化计数器：本机没有 PG，抛错不构成
 *   「按 owner 计数」的证据）；
 * - 两次都答 ⇒ 比较返回值。
 */
async function probe(counter) {
  const low = await ask(counter, 0);
  const high = await ask(counter, 7);

  if (low.status === 'timeout' || high.status === 'timeout') {
    return {
      suspicious:
        `探针超时（liveCommunityImages=0 ${describeAttempt(low)}、=7 ${describeAttempt(high)}）` +
        `：计数查询 ${PROBE_TIMEOUT_MS}ms 内没有结论，按可疑处理`,
    };
  }
  if (low.status === 'threw' && high.status === 'threw') {
    return { inconclusive: true };
  }
  if (low.status === 'threw' || high.status === 'threw') {
    return {
      suspicious:
        `一半能查一半不能查：liveCommunityImages=0 ${describeAttempt(low)}、` +
        `=7 ${describeAttempt(high)}`,
    };
  }
  return { low: low.value, high: high.value };
}

test('real + PG 持久化、但没有权威计数能力时，默认计数器必须是 unwired（#1029 的接线口）', async () => {
  // 这是第三轮审查 P1 的判据：`#1029` 的计数器在独立模块、不从 service.ts 导出、单参工厂
  // （被 `factory.length > 0` 跳过），只在 `persistence.kind === 'postgres'` 时接线。
  // 前三层判据都摸不到「默认计数器被换成了 PG 计数器」这件事，所以这里直接查装配结果。
  const app = createAppMediaService({
    executionMode: 'real',
    objectStore: { ...createUnwiredObjectStore('r83 lock probe'), kind: 's3_compatible' },
    tokenSecret: 'x'.repeat(48),
    realMediaApproval: approveRealMediaWiring({ reason: 'r83 structural lock' }),
    // 有 PG 持久化，但没有 countPendingCommunityImages。`persistent: true` 必须给：
    // 生产端口（`services/api/src/media/store-pg.ts`）返回的就是 `{ kind: 'postgres', persistent: true }`，
    // 缺这个字段的假 store 会让「`&& options.persistence.persistent === true`」这类旁路绕过本断言
    // （第二轮审查 P1-1 实测过这条旁路）。
    persistence: { kind: 'postgres', persistent: true },
  });

  // 防「拿 fail-closed 服务凑出 unwired」：那条分支的计数器同样是 unwired，不设这个前提断言就会假绿。
  assert.equal(app.failClosedReason, null, '本用例要探的是真装配，不能靠 fail-closed 分支拿到 unwired');

  assert.equal(
    app.attachmentCounter.kind,
    'unwired',
    'real + PG 持久化时默认计数器不是 unwired：这正是 #1029 的接线口（' +
      '`persistence?.kind === \'postgres\' ? createPostgresAttachmentCounter(...)`），' +
      '该实现的返回值就是同一 owner 的存活记录数 = 累计口径'
  );
  assert.equal(
    await app.attachmentCounter.countFor({ ownerId: 'o', liveCommunityImages: 3 }),
    null,
    'real 默认计数器必须对 owner 存活记录数不敏感（恒 null）；返回 3 就是 #1029 的累计口径'
  );
});

test('生产装配位点（buildApp 透传 PG mediaStore）注入后，默认计数器仍必须是 unwired', async (t) => {
  // 第二轮审查 P1-2：第 1 条只查 `createAppMediaService` 的默认；生产真正透传持久化端口的是
  // `services/api/src/app.ts` 的 `mediaStore`（`:1824` 传入 `createAppMediaService`），而那里没有用例——
  // 把 `#1029` 的计数器接在 app 层（而不是 service 默认）能让上一版全部判据保持绿色。
  const app = buildApp({
    config: {
      // 第三轮审查 P1：app 层自己的「真库」判词是 `pool !== null`（`services/api/src/app.ts:1304`），
      // 所以这里必须给一个非空 pool——否则「只看 pool 的接线」在 CI 里全绿，而它在生产里是活的。
      // `MEDIA_OBJECT_REF_KEY` 同理：缺它 app 会走 fail-closed，探不到真装配。
      ...loadConfig({
        APP_EXECUTION_MODE: 'stub',
        LOG_LEVEL: 'silent',
        MEDIA_OBJECT_REF_KEY: '0'.repeat(64),
      }),
      executionMode: 'real',
    },
    // 假 pool：本用例不查库（mediaStore 显式给出），只要能过 `pool !== null` 这道门并让 app 装配成功。
    pool: {
      query: async () => {
        throw new Error('r83 lock probe：本用例不查库');
      },
      connect: async () => {
        throw new Error('r83 lock probe：本用例不查库');
      },
      end: async () => {},
    },
    store: createMemoryAuthStore(),
    mediaObjectStore: { ...createUnwiredObjectStore('r83 lock probe'), kind: 's3_compatible' },
    // 用真实形状的持久化端口：`kind: 'postgres'` + `persistent: true`（缺后者就是 P1-1 的旁路）。
    mediaStore: { ...createMemoryMediaStore(), kind: 'postgres', persistent: true },
    realMediaApproval: approveRealMediaWiring({ reason: 'r83 structural lock' }),
  });
  t.after(() => app.close());

  assert.equal(
    app.mediaService.failClosedReason,
    null,
    '本用例要探的是真装配，不能靠 fail-closed 分支拿到 unwired'
  );
  assert.equal(
    app.mediaService.attachmentCounter.kind,
    'unwired',
    'buildApp 透传 PG mediaStore 后默认计数器不是 unwired：这正是把 #1029 接在 app 层的旁路'
  );
  assert.equal(
    await app.mediaService.attachmentCounter.countFor({ ownerId: 'o', liveCommunityImages: 3 }),
    null,
    '生产装配位点的默认计数器必须对 owner 存活记录数不敏感（恒 null）'
  );
});

test('除替身与测试缝外，任何计数器的返回值都不得随 owner 存活记录数变化', async (t) => {
  const factories = Object.entries(mediaService).filter(
    ([name, value]) => typeof value === 'function' && /^create\w*AttachmentCounter$/.test(name)
  );
  assert.ok(
    factories.length > 0,
    'service.ts 里没有导出任何 create*AttachmentCounter() 工厂（判据可能已过时，需人工核对）'
  );

  const violations = [];
  let probed = 0;
  let inconclusive = 0;
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
    if (result.inconclusive) {
      inconclusive += 1;
      continue;
    }
    probed += 1;
    if (result.suspicious) {
      violations.push(`${name}()：kind=${String(counter.kind)}，${result.suspicious}`);
      continue;
    }
    if (result.low !== result.high) {
      violations.push(
        `${name}()：kind=${String(counter.kind)}，countFor 对 liveCommunityImages=0 返回 ${String(
          result.low
        )}、对 =7 返回 ${String(result.high)}`
      );
    }
  }

  if (inconclusive > 0) {
    // 两次都抛错 ⇒ 不判红（需要真实存储/网络的持久化计数器），但不能**无声**：把它数出来，
    // 否则「坏实现靠抛错永久藏进 inconclusive 桶」会被静默放过（第二轮审查 P2-2）。
    t.diagnostic(
      `inconclusive ${inconclusive} 个：这些计数器两次 countFor 都抛错，本次未判定其口径`
    );
  }

  assert.ok(
    probed > 0,
    `一个可探的计数器都没有（inconclusive ${inconclusive} 个；判据可能已过时，需人工核对）`
  );
  assert.deepEqual(
    violations,
    [],
    '有计数器在按「同一 owner 名下存活记录数」计数（或对探针不给出稳定结论），但它不是替身/测试缝：\n' +
      `${violations.join('\n')}\n` +
      '这正是 #1029 被撤回的口径（生命周期累计 ⇒ 传满 3 张后永久锁死）。'
  );
});

test('测试注入缝不得出现在生产装配里（只允许它在 service.ts 的定义处）', () => {
  const offenders = [];
  const serviceRel = servicePath.slice(repoRoot.length + 1);
  for (const file of listTsFiles(srcRoot)) {
    const rel = file.slice(repoRoot.length + 1);
    // 扫描对象是**代码**：先剥注释（审查 P2-2 残余——JSDoc 里写 `kind: 'injected'` 曾被判红）。
    const source = stripComments(readFileSync(file, 'utf8'));

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
    // 就能让判据以为「这是测试缝」而放行。除定义处外不允许出现——引号形态（单/双/反引号）都要抓。
    if (rel !== serviceRel && INJECTED_KIND_RE.test(source)) {
      offenders.push(`${rel}：自己声明了 kind: 'injected'（或双引号/反引号同义写法）的计数器`);
    }

    // 上面那条正则只管「字面量形状」。换个文件把 `injected` 与 `countFor` 拼在一起（模板串、
    // 常量、类型断言……）同样是自造测试缝：计数方法定义在 `countFor` 旁边、kind 里带 `injected`，
    // 就等于在 service.ts 之外复刻了那个注入缝。同一文件同时出现两者即违规。
    // 第三轮审查 P2-2：原来的「同文件同时出现 injected 与 countFor」判据会误伤合法生产代码——
    // `services/api/src/app.ts` 本来就有 `injected:`/`injectedDeletionRequests` 等标识符，任何在 app 层
    // 包一层计数器的正当改动都会被判成「自造测试缝」。收窄成「**带引号的 'injected' 字面量** 与 countFor 同文件」，
    // 这才是绕过实际用的写法（`kind: 'injected'`），也不会把裸标识符当证据。
    if (rel !== serviceRel && /['"`]injected['"`]/.test(source) && source.includes('countFor')) {
      offenders.push(`${rel}：service.ts 之外同时出现带引号的 'injected' 字面量与 countFor（自造测试注入缝）`);
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

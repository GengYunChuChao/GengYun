/**
 * R67-A01 · **real 模式里恒 503 的后台 operation，契约必须如实声明 503 并写明「未接线」**。
 *
 * ## 为什么需要这条钉子
 * real 模式下有两类后台 operation：一类**接得上**（有真实库池/端口时才放行，否则 503），
 * 一类**根本还没接线**（`services/api/src/admin/ops/accounts-only.ts` 的返回字面量里直接绑 `reject`，
 * 无论注入什么都恒 503）。后一类最容易在契约里说谎：路径、scope、200 封套都写全了，读契约的人
 * 完全看不出这个 operation 现在一按就 503。同仓的 `listAdministrators` 已经示范了如实写法
 * （描述里明写「未接线 ⇒ 503 PROVIDER_UNAVAILABLE」），本文件把这种写法**钉成规则**而不是一次性的自觉。
 *
 * ## 判据来自源码，不是手抄清单
 * 恒 503 的清单**只有一份**：外壳返回的对象字面量里形如 `name: reject,` 的绑定
 * （`listAdminCategories` / `editCategory` 两条；其余条目要么带门 `X ? inner.y : reject`，
 * 要么是唯一一条无门转发 `suspendUser: inner.suspendUser`，见下面 `UNGATED_FORWARDS`）。
 * 本文件**解析源码**取集合，不在测试里手抄 operationId —— 手抄的清单会和源码各自漂移。
 *
 * ## 反向断言为什么是这种形状
 * 任务原话是「契约里声明了 503 的 admin operation，都要在这个清单里或另有说明」。
 * 字面版做不到，原因是可核的：`503` 属**全局错误码表**，`tools/validate_contracts.py` 要求
 * 每个 operation 的 `responses` 都含该表的全部码（实测 126/126 条 operation 都声明了 503），
 * 所以「声明了 503」这件事**没有任何信息量** —— 按字面断言会把 47 条与本外壳无关的 admin
 * operation（认证/审计/媒体/帖子读面等）一并判红。
 * 因此反向改成两条**可核实**的等价物：
 *   (R1) 契约里**自称**未接线的 admin operation，必须真声明 503，且必须能在本外壳清单或
 *        `services/api/src/**` 的实现面里找到出处（找不到出处＝契约在编造一条不存在的接线）；
 *   (R2) 外壳里**没有门**的转发必须登记在 `UNGATED_FORWARDS`（登记即"另有说明"）——
 *        防止有人把 `reject` 悄悄换成 `inner.x`，而契约还写着"恒 503"。
 *
 * ⛔ 本文件不写任何 `文件:行号` 断语（行号会漂；`tests/unit/test-line-anchors-guard.test.mjs`
 * 专门判红那种写法）。引用证据一律用**文件路径 + 语句文本 / 符号名**。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ACCOUNTS_ONLY = 'services/api/src/admin/ops/accounts-only.ts';
const OPENAPI = 'packages/contracts/openapi.json';
const ADMIN_SOURCE_DIR = 'services/api/src';

const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

/** 契约里每个 operationId → `{ method, path, op }`。 */
const OPERATIONS = new Map();
for (const [path, item] of Object.entries(JSON.parse(read(OPENAPI)).paths ?? {})) {
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    const op = item[method];
    if (op && typeof op.operationId === 'string') OPERATIONS.set(op.operationId, { method, path, op });
  }
}

/**
 * 外壳里**没有门**的转发：必须在这里逐条登记理由（"另有说明"的落点）。
 * 目前只有一条 —— `suspendUser` 走迁移 0017 的单事务停用权威，装配期就一定有权威对象，
 * 所以它不需要 wiring 布尔；它仍是 503 面的理由在服务层（拿不到库池时抛 `PROVIDER_UNAVAILABLE`）。
 */
const UNGATED_FORWARDS = new Map([
  ['suspendUser', '放行 1：真实单事务停用权威（迁移 0017 的 suspend_account()），装配期必有权威对象，无独立 wiring 布尔'],
]);

/** 解析 `return { … };` 里的 `name: expr,` 绑定（只认一层、四空格缩进）。 */
function shellBindings() {
  const lines = read(ACCOUNTS_ONLY).split('\n');
  const start = lines.findIndex((line) => line.trim() === 'return {');
  assert.notEqual(start, -1, '在 accounts-only.ts 里找不到 `return {`：外壳形状变了，本钉子要跟着改');
  const bindings = new Map();
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    if (line.trim() === '};') break;
    const matched = /^ {4}([A-Za-z_$][\w$]*): (.+),$/.exec(line);
    if (matched) bindings.set(matched[1], matched[2].trim());
  }
  assert.ok(bindings.size > 0, 'accounts-only.ts 的返回字面量里一条绑定都没解析出来：解析器或外壳形状失效');
  return bindings;
}

/** 只看契约里的 operation（`store` / `jobPort` / `accountsWired` / `operationIds` 这些非 operation 键滤掉）。 */
function operationBindings() {
  return [...shellBindings()].filter(([name]) => OPERATIONS.has(name));
}

const GATED_SHAPE = /^[A-Za-z_$][\w$]* \? inner\.[A-Za-z_$][\w$]* : reject$/;
const FORWARD_SHAPE = /^inner\.[A-Za-z_$][\w$]*$/;

/** 恒 503（无门 `reject`）的 operationId 集合 —— 本文件的**唯一事实源**是外壳源码。 */
const ALWAYS_CLOSED = operationBindings()
  .filter(([, value]) => value === 'reject')
  .map(([name]) => name);

test('钉子自带非空证明：外壳里确实有恒 reject 的 operation，且本文件解析到了它们', () => {
  assert.ok(ALWAYS_CLOSED.length > 0, '外壳里一条 `name: reject,` 都没解析到：不是"全接通了"，而是本钉子失明');
  for (const name of ALWAYS_CLOSED) {
    assert.ok(OPERATIONS.has(name), `外壳恒 reject 的 \`${name}\` 在 openapi.json 里没有同名 operationId：源码与契约已各说各话`);
  }
});

test('正向：外壳恒 reject 的 operation，契约里都声明了 503 响应', () => {
  const missing = [];
  for (const name of ALWAYS_CLOSED) {
    const { method, path, op } = OPERATIONS.get(name);
    const declared = op.responses?.['503'];
    const ref = typeof declared === 'object' && declared !== null ? declared.$ref : undefined;
    if (ref !== '#/components/responses/Error503') {
      missing.push(`${method.toUpperCase()} ${path} ${name} → responses.503 = ${JSON.stringify(declared) ?? 'undefined'}`);
    }
  }
  assert.deepEqual(missing, [], '恒 503 的 operation 未按仓内既有写法声明 503（期望 $ref: #/components/responses/Error503）');
});

test('正向：外壳恒 reject 的 operation，契约描述写明「未接线时返回 503」', () => {
  // 判据只认两个事实：描述里出现「未接线」+ 出现 `503 PROVIDER_UNAVAILABLE`（与 Error503
  // 组件描述里的码同名）。连接词（`⇒` / `时返回`）不作断言，避免把风格变成钉子。
  const unexplained = [];
  for (const name of ALWAYS_CLOSED) {
    const { method, path, op } = OPERATIONS.get(name);
    const description = typeof op.description === 'string' ? op.description : '';
    const saysUnwired = description.includes('未接线');
    const saysCode = description.includes('503 PROVIDER_UNAVAILABLE');
    if (!saysUnwired || !saysCode) {
      unexplained.push(`${method.toUpperCase()} ${path} ${name} → 未接线=${saysUnwired} / 503码=${saysCode} / 现描述=${JSON.stringify(description)}`);
    }
  }
  assert.deepEqual(unexplained, [], 'real 模式恒 503 的 operation 在契约描述里没有任何"未接线"说明：读契约的人看不出它一按就 503');
});

test('反向(R1)：契约自称未接线的 admin operation，都在恒 503 清单里或能在实现面找到出处', () => {
  // 「另有说明」的机械判据：该 operationId 作为标识符出现在 `services/api/src/**`（认证/审计/媒体
  // /帖子读面等自有外壳都在这里），即它不是一条凭空写进契约的 operation。
  const sourceFiles = [];
  (function walk(directory) {
    for (const entry of readdirSync(join(REPO_ROOT, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(entry.name)) sourceFiles.push(relative);
    }
  })(ADMIN_SOURCE_DIR);
  assert.ok(sourceFiles.length > 0, `在 ${ADMIN_SOURCE_DIR} 下没扫到任何源码：反向判据会静默通过，故先断言扫描面非空`);
  const sourceText = sourceFiles.map((relative) => read(relative)).join('\n');

  const unaccounted = [];
  for (const [name, { method, path, op }] of OPERATIONS) {
    if (!(op.tags ?? []).includes('admin')) continue;
    const description = typeof op.description === 'string' ? op.description : '';
    if (!description.includes('未接线')) continue;
    const declares503 = (op.responses?.['503'] ?? null) !== null;
    const inShell = ALWAYS_CLOSED.includes(name);
    const inSource = new RegExp(`\\b${name}\\b`).test(sourceText);
    if (!declares503 || !(inShell || inSource)) {
      unaccounted.push(`${method.toUpperCase()} ${path} ${name} → 声明503=${declares503} / 外壳清单=${inShell} / 源码出处=${inSource}`);
    }
  }
  assert.deepEqual(
    unaccounted,
    [],
    '契约里自称未接线的 admin operation 既不在恒 503 清单、也在 services/api/src 找不到出处：契约在编造一条不存在的接线',
  );
});

test('反向(R2)：外壳里没有门的转发必须登记理由，不许把 reject 悄悄换成 inner.x', () => {
  const unregistered = [];
  const unknownShape = [];
  for (const [name, value] of operationBindings()) {
    if (value === 'reject') continue;
    if (GATED_SHAPE.test(value)) continue;
    if (FORWARD_SHAPE.test(value)) {
      if (!UNGATED_FORWARDS.has(name)) unregistered.push(`${name}: ${value}`);
      continue;
    }
    unknownShape.push(`${name}: ${value}`);
  }
  assert.deepEqual(unknownShape, [], '外壳出现本文件无法分类的绑定形状：先判清它是"带门"还是"无门转发"，再让它通过');
  assert.deepEqual(
    unregistered,
    [],
    '外壳新增了**无门**转发（等于从"恒 503 清单"里移除了它），但契约可能还写着"未接线恒 503"：请在 UNGATED_FORWARDS 登记理由，并同步契约描述',
  );
  for (const name of UNGATED_FORWARDS.keys()) {
    assert.ok(OPERATIONS.has(name), `UNGATED_FORWARDS 里登记的 \`${name}\` 已不在契约 operationId 里：过期登记要删掉`);
  }
});

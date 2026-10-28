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
 * （R67 时的两条是 `listAdminCategories` / `editCategory`；其余条目要么带门 `X ? inner.y : reject`，
 * 要么是无门转发 `suspendUser: inner.suspendUser`，见下面 `UNGATED_FORWARDS`）。
 * 本文件**解析源码**取集合，不在测试里手抄 operationId —— 手抄的清单会和源码各自漂移。
 *
 * ## 2026-10-28 R68-A01：清单**空了**，判别力改由合成样本正控制扛
 * R68-A01 把 `listAdminCategories` / `editCategory` 接到了真库（迁移 0049 的
 * `public.admin_categories` + 窄函数 `record_admin_category_update`），两条裸 `reject` 变成
 * `categoriesWired ? inner.x : reject` 的**带门**形态 ⇒ 源码里的恒 503 集合**实测为空**。
 * 「集合非空」这条自证因此不再成立，但它原来防的病（解析器失明 ⇒ 全部按空集通过）**必须继续防**：
 * 现在改成把分类器与两条正向判据抽成**纯函数**，用**合成样本**（一段带 `x: reject,` 的假外壳文本 +
 * 假 operation）做正/负控制 —— 判据证明自己能把坏样本判红，再把同一判据施加到真实源码上。
 * ⛔ 这不是放宽断言：真样本为空只说明「眼下没有恒 503 的 operation」，而判据的判别力由合成样本逐条
 * 证明（`assert` 里给的是坏样本的期望红字，不是「跳过」）。
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
  return parseShellBindings(read(ACCOUNTS_ONLY));
}

/**
 * `shellBindings` 的纯函数形态：把一段源码文本里的 `return { … };` 绑定解析出来。
 * 单独抽出来是为了能用**合成样本**证明解析器不失明（见「合成样本正控制」用例）。
 * @param {string} text
 * @returns {Map<string, string>}
 */
function parseShellBindings(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'return {');
  if (start === -1) return new Map();
  const bindings = new Map();
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    if (line.trim() === '};') break;
    const matched = /^ {4}([A-Za-z_$][\w$]*): (.+),$/.exec(line);
    if (matched) bindings.set(matched[1], matched[2].trim());
  }
  return bindings;
}

/** 只看契约里的 operation（`store` / `jobPort` / `accountsWired` / `operationIds` 这些非 operation 键滤掉）。 */
function operationBindings() {
  return [...shellBindings()].filter(([name]) => OPERATIONS.has(name));
}

const GATED_SHAPE = /^([A-Za-z_$][\w$]*) \? inner\.[A-Za-z_$][\w$]* : reject$/;
const FORWARD_SHAPE = /^inner\.[A-Za-z_$][\w$]*$/;

/**
 * 门的**命名**约束（N8）：只有「wiring 布尔」才配当门 —— 名字必须以 `Wired` / `Enabled` 结尾。
 *
 * 为什么非要管名字：`false ? inner.x : reject` 这种**恒假三目**在形状上与真门一模一样，
 * 只看 `GATED_SHAPE` 会把它判成「带门」（= 已接线），于是恒 503 被伪装成放行、清单读数变 0
 * 而没人知道。把「门必须是 wiring 布尔」写成命名判据之后，恒假三目落到 `unknown`，
 * 由反向判据 R2 / 外壳用例判红。本仓真实外壳的九个门（`categoriesWired` / `accountsReadWired` /
 * `jobsWired` / `flagsWired` / `hidePostWired` / `administratorsWired` / `postReviewWired` /
 * `scopeWriteWired` / `adminAccountWriteWired`）全部满足这条命名，故不产生误报。
 */
const GATE_NAME_SHAPE = /^[A-Za-z_$][\w$]*(?:Wired|Enabled)$/;

/**
 * 绑定形状分类器（纯函数）：`reject` / `gated` / `forward` / `unknown`。
 * `gated` 是「有 wiring 布尔兜底」的放行，`forward` 是「无门直转」，两者都不是恒 503。
 * 门名不像 wiring 布尔（例如 `false`/`0` 这类字面量）时**不算 gated**，一律降成 `unknown`。
 * @param {string} value 绑定右侧的表达式文本
 * @returns {'reject' | 'gated' | 'forward' | 'unknown'}
 */
function classifyBinding(value) {
  if (value === 'reject') return 'reject';
  const gated = GATED_SHAPE.exec(value);
  if (gated !== null) return GATE_NAME_SHAPE.test(gated[1]) ? 'gated' : 'unknown';
  if (FORWARD_SHAPE.test(value)) return 'forward';
  return 'unknown';
}

/** 恒 503（无门 `reject`）的 operationId 集合 —— 本文件的**唯一事实源**是外壳源码。 */
const ALWAYS_CLOSED = operationBindings()
  .filter(([, value]) => classifyBinding(value) === 'reject')
  .map(([name]) => name);

/**
 * 正向判据①（纯函数）：该 operation 是否按仓内既有写法声明了 503。
 * 抽成纯函数是为了让合成样本能证明它**会**判红（否则真样本为空时它就成了空断言）。
 * @param {{method: string, path: string}} entry
 * @param {Record<string, unknown>} op
 * @returns {string | null} 判红理由；null 表示合格
 */
function declares503Problem(name, entry, op) {
  const declared = op.responses?.['503'];
  const ref = typeof declared === 'object' && declared !== null ? declared.$ref : undefined;
  if (ref !== '#/components/responses/Error503') {
    return `${entry.method.toUpperCase()} ${entry.path} ${name} → responses.503 = ${JSON.stringify(declared) ?? 'undefined'}`;
  }
  return null;
}

/**
 * 正向判据②（纯函数）：该 operation 的描述是否写明「未接线 + 503 PROVIDER_UNAVAILABLE」。
 * 判据只认两个事实，连接词（`⇒` / `时返回`）不作断言，避免把风格变成钉子。
 * @returns {string | null} 判红理由；null 表示合格
 */
function descriptionProblem(name, entry, op) {
  const description = typeof op.description === 'string' ? op.description : '';
  const saysUnwired = description.includes('未接线');
  const saysCode = description.includes('503 PROVIDER_UNAVAILABLE');
  if (saysUnwired && saysCode) return null;
  return `${entry.method.toUpperCase()} ${entry.path} ${name} → 未接线=${saysUnwired} / 503码=${saysCode} / 现描述=${JSON.stringify(description)}`;
}

test('合成样本正控制：带 `x: reject,` 的假外壳文本必须被解析并判成恒 503（防解析器失明）', () => {
  // 真实源码在 R68-A01 之后**没有**恒 503 的 operation 了；若只断言"解析到了"，这条钉子会
  // 在解析器坏掉时静默通过。故先用一段形状与真外壳相同的合成文本证明三段解析都还在工作：
  // ① 只看 `return { … };` 之内；② 只认四空格缩进的 `name: expr,`；③ 遇 `};` 收手。
  const sample = [
    'function shell(inner, options) {',
    '  return {',
    '    store: inner.store,',
    '    alwaysClosedOp: reject,',
    '    gatedOp: categoriesWired ? inner.gatedOp : reject,',
    '    falseGateOp: false ? inner.falseGateOp : reject,',
    '    forwardedOp: inner.forwardedOp,',
    '    unknownOp: wired && inner.unknownOp,',
    '  };',
    '}',
    '',
    'const decoy = {',
    '    outsideReturn: reject,',
    '};',
  ].join('\n');
  const bindings = parseShellBindings(sample);
  assert.deepEqual(
    [...bindings.keys()],
    ['store', 'alwaysClosedOp', 'gatedOp', 'falseGateOp', 'forwardedOp', 'unknownOp'],
    '`return { … };` 之内的绑定必须被完整解析、之外的 `decoy` 必须不被收进来',
  );
  assert.deepEqual(
    [...bindings].filter(([, value]) => classifyBinding(value) === 'reject').map(([name]) => name),
    ['alwaysClosedOp'],
    '合成样本里的 `alwaysClosedOp: reject` 必须被判成恒 503（分类器失明的话，真样本为空就再没人看得见）',
  );
  assert.equal(classifyBinding(bindings.get('gatedOp')), 'gated', '带门转发必须判 gated');
  assert.equal(
    classifyBinding(bindings.get('falseGateOp')),
    'unknown',
    '`false ? inner.x : reject` 是恒假三目（等价于恒 503），必须判 unknown 而不是 gated —— 否则恒 503 会被伪装成已接线',
  );
  assert.equal(classifyBinding(bindings.get('forwardedOp')), 'forward', '无门转发必须判 forward');
  assert.equal(classifyBinding(bindings.get('unknownOp')), 'unknown', '无法分类的形状必须判 unknown（由 R2 判红）');
});

test('合成样本正控制：两条正向判据的负控制 —— 坏 operation 必须被判红，好 operation 必须通过', () => {
  const entry = { method: 'patch', path: '/admin/sample/{id}' };
  // ①503 声明：没声明 / 声明成别的 ref / 声明成 inline schema，三种都必须判红。
  const bad503 = [
    { op: { responses: {} }, expect: 'undefined' },
    { op: { responses: { 503: { $ref: '#/components/responses/Error500' } } }, expect: 'Error500' },
    { op: { responses: { 503: { description: 'inline' } } }, expect: 'inline' },
  ];
  for (const { op, expect } of bad503) {
    const problem = declares503Problem('sampleOp', entry, op);
    assert.notEqual(problem, null, `合成样本 ${expect} 必须被判红：判据对 503 声明失明了`);
    assert.ok(problem.includes(expect), `判红理由必须点出现场值（期望含 ${expect}，实际 ${problem}）`);
  }
  assert.equal(
    declares503Problem('sampleOp', entry, { responses: { 503: { $ref: '#/components/responses/Error503' } } }),
    null,
    '按仓内写法声明了 Error503 的合成 operation 必须通过（否则判据变成了"逢样必红"）',
  );
  // ②描述：缺「未接线」/ 缺码 / 描述不是字符串，都必须判红。
  const badDescription = [
    { op: { description: '未接线时返回 PROVIDER_UNAVAILABLE' }, needle: '503码=false' },
    { op: { description: '恒 503 PROVIDER_UNAVAILABLE' }, needle: '未接线=false' },
    { op: {}, needle: '未接线=false' },
  ];
  for (const { op, needle } of badDescription) {
    const problem = descriptionProblem('sampleOp', entry, op);
    assert.notEqual(problem, null, `合成样本缺 ${needle} 必须被判红：描述判据失明了`);
    assert.ok(problem.includes(needle), `判红理由必须点出缺哪一半（期望含 ${needle}，实际 ${problem}）`);
  }
  assert.equal(
    descriptionProblem('sampleOp', entry, { description: '未接线时返回 503 PROVIDER_UNAVAILABLE（retryable:false）' }),
    null,
    '两个事实都写全的合成描述必须通过',
  );
});

/**
 * 真实语料的**计数钉**（防「真样本变空」被静默接受）。
 *
 * 为什么现在是 0：R68-A01 之前这里实测 **2 条** —— `listAdminCategories` / `editCategory`，
 * 它们在 `services/api/src/admin/ops/accounts-only.ts:175-176` 是两条**字面裸 `reject`**，
 * 于是 real 模式下恒 503。R68-A01 把这两行改成
 * `categoriesWired ? inner.listAdminCategories : reject`（同 `editCategory`），
 * 并且在真的构造出 `createPostgresAdminCategories({ pool })` 时才置 `categoriesWired: true`
 * ⇒ 这两条不再是「恒 reject」，真实语料因此**降到 0**。
 *
 * ⛔ 这不是把断言放宽：这里钉的是**具体计数与具体名单**。下一次有人
 *   ① 把带门的绑定改回裸 `reject`（计数会 +1）、或
 *   ② 为了让清单变空而把恒 reject 的 op 从外壳里删掉（名单/计数会变），
 * 都必须显式改这个常量 —— 改的时候就得回答「为什么」。
 *   判据本身的判别力另由两条合成样本正控制扛（真样本为空时它们仍然会红）。
 */
const ALWAYS_CLOSED_BASELINE = Object.freeze({
  /** R68-A01（2026-10-28）实测：外壳里恒 reject 的 operation 恰好 0 条。 */
  count: 0,
  /** 逐名钉住（空数组＝「一条都没有」本身是被断言的读数，不是被跳过的分支）。 */
  names: [],
  /** 上一版读数：R68-A01 之前是这 2 条（留作对照，解释"为什么变空"）。 */
  beforeR68A01: ['listAdminCategories', 'editCategory'],
});

test('真实外壳：每条 operation 绑定都被分类，且恒 503 集合与契约 operationId 同名', () => {
  const bindings = operationBindings();
  assert.ok(bindings.length > 0, '在外壳返回字面量里一条 operation 绑定都没解析到：本钉子失明');
  const unclassified = bindings.filter(([, value]) => classifyBinding(value) === 'unknown').map(([name]) => name);
  assert.deepEqual(unclassified, [], '外壳出现本文件无法分类的绑定形状：先判清它是"带门"还是"无门转发"，再让它通过');
  for (const name of ALWAYS_CLOSED) {
    assert.ok(OPERATIONS.has(name), `外壳恒 reject 的 \`${name}\` 在 openapi.json 里没有同名 operationId：源码与契约已各说各话`);
  }

  // 真实语料计数钉：空也要空得**被告知**。改这个读数必须同时说明理由（见常量注释）。
  assert.equal(
    ALWAYS_CLOSED.length,
    ALWAYS_CLOSED_BASELINE.count,
    `外壳恒 reject 的 operation 条数变了（实测 ${ALWAYS_CLOSED.length}：${ALWAYS_CLOSED.join('、') || '空'}）。`
      + `R68-A01 之后应当是 ${ALWAYS_CLOSED_BASELINE.count} 条（那 2 条 ${ALWAYS_CLOSED_BASELINE.beforeR68A01.join(' / ')}`
      + ' 已改成 categoriesWired ? inner.x : reject）。要改这条读数，先在注释里写清这次是"新增恒 503 的 op"还是"把裸 reject 摘掉了"。',
  );
  assert.deepEqual(ALWAYS_CLOSED, ALWAYS_CLOSED_BASELINE.names, '恒 503 的 operation 名单与登记的不一致（空名单也是被断言的读数）');

  // 反向自证：那两条被摘掉裸 reject 的 op **仍然在外壳里**，且现在必须被判成「带门」。
  // （否则「计数变 0」可以被"直接把绑定删掉"伪造出来 —— 这条把那条路堵住。）
  for (const name of ALWAYS_CLOSED_BASELINE.beforeR68A01) {
    const binding = bindings.find(([bound]) => bound === name);
    assert.ok(binding !== undefined, `外壳里找不到 \`${name}\`：不许用"删绑定"的方式把恒 503 清单清空`);
    assert.equal(
      classifyBinding(binding[1]),
      'gated',
      `\`${name}\` 必须仍然带门（wired ? inner.x : reject），实测绑定：${binding[1]}`,
    );
  }

  // 真样本为空是**当前事实**（R68-A01 之后两条都接上了），不是断言目标：这里只如实打印，
  // 判别力由上面两条合成样本正控制兜住。
  console.log(`[admin-unwired-operations] 外壳恒 503 的 operation 实测 ${ALWAYS_CLOSED.length} 条：${ALWAYS_CLOSED.join('、') || '（空：全部带门或无门转发已登记）'}`);
});

test('正向：外壳恒 reject 的 operation，契约里都声明了 503 响应', () => {
  const missing = [];
  for (const name of ALWAYS_CLOSED) {
    const entry = OPERATIONS.get(name);
    const problem = declares503Problem(name, entry, entry.op);
    if (problem !== null) missing.push(problem);
  }
  assert.deepEqual(missing, [], '恒 503 的 operation 未按仓内既有写法声明 503（期望 $ref: #/components/responses/Error503）');
});

test('正向：外壳恒 reject 的 operation，契约描述写明「未接线时返回 503」', () => {
  const unexplained = [];
  for (const name of ALWAYS_CLOSED) {
    const entry = OPERATIONS.get(name);
    const problem = descriptionProblem(name, entry, entry.op);
    if (problem !== null) unexplained.push(problem);
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
    const shape = classifyBinding(value);
    if (shape === 'reject' || shape === 'gated') continue;
    if (shape === 'forward') {
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

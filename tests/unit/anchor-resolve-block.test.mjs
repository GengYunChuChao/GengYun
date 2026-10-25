// 块体判定（`tools/lib/anchor-resolve.mjs` 的 `locateBlockBody`）的三类样例 + 真实文件自证。
//
// 缺口（为什么需要这个文件）：修复前这里是「从声明行起，遇到第一个 `{` 就返回」，
// 于是下面三类都被算错，而 verify-contract-status 的符号锚点、--reanchor 的归属块全建在它上面：
//   ① 参数解构：`function buildApp({ config, ... }: BuildAppOptions) { ... }`
//      ⇒ 第一个 `{` 是解构模式，块被算成声明行本身（单行块）。真实实例见 services/api/src/app.ts。
//   ② 箭头函数 / 调用括号内的回调：`app.get('/x', async (req, reply) => { ... })`
//      ⇒ 块体本来就在调用括号内，「括号深度必须为 0」这类修法会把这两类全判成「没有块体」。
//   ③ 类型字面量：`function make(input: string): { id: string } { ... }`
//      ⇒ 第一个 `{` 是返回类型的字面量，块被算成单行。
//   ④ 无分号（ASI）文件：`const items = a.concat(b)` 这一行**没有块**，但扫描会一路吃到下一条语句/
//      下一个方法的 `{`，把几十行的别人家的块算成它的块。真实实例：
//      `miniprogram/pages/messages/messages.js`（修复前一行 `const items = …` 的块是 175-235，
//      跨过了 `items`/`that`/`epoch` 三个假归属，直到 `refreshUnread` 才收尾）。
//
// 本文件钉住：三类样例的**起止行**、两类不能退化的既有行为（调用括号里的对象实参、路由回调）、
// ④ ASI 与行预算两条硬约束、以及真实文件里 buildApp 的块必须覆盖真实函数体（不是声明行那一行）。
// 夹具是合成源码 + 真实文件原样读取，不写仓内任何文件、不联网、不起子进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  braceBlockEnd, declarationBlock, declarationBlocks, enclosingBlock, resolveSymbolBlock,
} from '../../tools/lib/anchor-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 夹具里按「声明行里的一段文字」取 1-based 行号，再让工具算块体。 */
function blockFor(source, needle) {
  const lines = source.split('\n');
  const line = lines.findIndex(candidate => candidate.includes(needle)) + 1;
  assert.ok(line > 0, `夹具里找不到声明行：${needle}`);
  return { line, block: declarationBlock(source, line) };
}

/** 独立于工具的「真实函数体结束行」：从声明行起按花括号配平（字符串/注释不参与判定的简化版足够用）。 */
function braceBalancedEnd(source, declarationLine) {
  const lines = source.split('\n');
  let depth = 0;
  let opened = false;
  for (let number = declarationLine; number <= lines.length; number += 1) {
    for (const char of lines[number - 1]) {
      if (char === '{') { depth += 1; opened = true; }
      else if (char === '}') depth -= 1;
    }
    if (opened && depth === 0) return number;
  }
  return -1;
}

// —— ① 参数解构：第一个 `{` 是解构模式，不是块体 ——————————————————————————
const DESTRUCTURED_PARAMS = [
  'import { buildAppOptions } from "./options.ts";',
  '',
  'export function buildApp({ config, pool = null, now }: BuildAppOptions): FastifyInstance {',
  '  const app = createApp(config);',
  '  app.decorate("now", now);',
  '  return app;',
  '}',
  '',
  'const after = 1;',
].join('\n');

test('① 解构参数函数：块体是函数体，不是那一行本身', () => {
  const { line, block } = blockFor(DESTRUCTURED_PARAMS, 'export function buildApp(');
  assert.equal(line, 3);
  assert.deepEqual(block, { start: 3, end: 7 }, '块体应覆盖 3-7（函数体），修复前是 {start:3,end:3} 的单行块');
});

test('① 多行解构参数：解构跨行时块体仍从函数体的 `{` 起算', () => {
  const source = [
    'export function configure({',
    '  host,',
    '  port = 5432,',
    '}: ConfigureOptions): void {',
    '  apply(host, port);',
    '}',
  ].join('\n');
  const { block } = blockFor(source, 'export function configure({');
  assert.deepEqual(block, { start: 1, end: 6 }, '解构跨 4 行，块体应到第 6 行（函数体结束），不是第 1 或第 4 行');
});

// —— ② 箭头函数 + 调用括号内的回调 ————————————————————————————————————
const ARROW_AND_CALLBACK = [
  'const handler = async (req, reply) => {',
  '  reply.send({ ok: true });',
  '};',
  '',
  'const route = app.get("/x", async (req, reply) => {',
  '  reply.send({ ok: false });',
  '});',
  '',
  'const plain = (value) => {',
  '  return value;',
  '};',
].join('\n');

test('② 箭头函数：`const x = (a) => { ... }` 的块体是函数体', () => {
  const { block } = blockFor(ARROW_AND_CALLBACK, 'const plain = (value) => {');
  assert.deepEqual(block, { start: 9, end: 11 });
});

test('② 异步箭头函数：`const x = async () => { ... }` 的块体是函数体', () => {
  const { block } = blockFor(ARROW_AND_CALLBACK, 'const handler = async');
  assert.deepEqual(block, { start: 1, end: 3 });
});

test('② 路由回调：块体在调用括号内，不能被判成「括号深度不为 0 ⇒ 没有块体」', () => {
  const { block } = blockFor(ARROW_AND_CALLBACK, 'const route = app.get(');
  assert.deepEqual(block, { start: 5, end: 7 }, '块体是回调函数体（5-7），不是整个调用语句也不是 null');
});

test('② 调用括号里的对象实参：既有「路由注册块」口径不变（对象实参就是那一块）', () => {
  const source = [
    'registerAccountDeletionRoutes(app, config, guards, {',
    '  service: null,',
    '  receipts: null,',
    '});',
  ].join('\n');
  const { block } = blockFor(source, 'registerAccountDeletionRoutes(app');
  assert.deepEqual(block, { start: 1, end: 4 });
});

// —— ③ 类型字面量：第一个 `{` 是类型，不是块体 ————————————————————————
const TYPE_LITERALS = [
  'function makeDescriptor(input: string): { id: string; label: string } {',
  '  return { id: input, label: input };',
  '}',
  '',
  'const mapped: { a: number } = {',
  '  a: 1,',
  '};',
  '',
  'interface Shape {',
  '  id: string;',
  '}',
  '',
  'type Alias = {',
  '  ok: boolean;',
  '};',
].join('\n');

test('③ 返回类型字面量：`function f(): { a: 1 } { ... }` 的块体是函数体', () => {
  const { line, block } = blockFor(TYPE_LITERALS, 'function makeDescriptor(');
  assert.equal(line, 1);
  assert.deepEqual(block, { start: 1, end: 3 }, '返回类型里的 `{ id: string }` 不是块体，函数体才是（修复前是单行块）');
});

test('③ 变量类型字面量：`const x: { a: 1 } = { ... }` 取赋值的对象，不取类型', () => {
  const { block } = blockFor(TYPE_LITERALS, 'const mapped: { a: number } = {');
  assert.deepEqual(block, { start: 5, end: 7 });
});

test('③ interface / type 声明的 `{` 本来就是块体（不能因为「类型字面量」被误排除）', () => {
  assert.deepEqual(blockFor(TYPE_LITERALS, 'interface Shape {').block, { start: 9, end: 11 });
  assert.deepEqual(blockFor(TYPE_LITERALS, 'type Alias = {').block, { start: 13, end: 15 });
});

test('③ 泛型返回类型里的类型字面量：`Promise<{ a: 1 }>` 不能当成块体', () => {
  const source = [
    'async function listAll(query: ListQuery): Promise<{ items: Row[] }> {',
    '  return { items: [] };',
    '}',
  ].join('\n');
  assert.deepEqual(blockFor(source, 'async function listAll(').block, { start: 1, end: 3 });
});

// —— ④ 无分号（ASI）文件 + 行预算 ————————————————————————————————————————
// 两类都是「扫描跑过了头」：ASI 让语句在换行处就结束；行预算不让块跳过白送几十行。
const ASI_PAGE = [
  'const api = require("../../utils/api")', //      1 —— 没有块
  '',
  'function load() {', //                           3
  '  const items = that.data.items.concat(rows)', // 4 —— 这一行**没有块**
  '  that.setData({', //                            5
  '    items: items', //                            6
  '  })', //                                        7
  '}', //                                           8
  '',
  'function refreshUnread() {', //                 10
  '  return 1', //                                 11
  '}', //                                          12
].join('\n');

test('④ ASI：无分号文件里 `const x = f(...)` 没有块，不许把下一条语句的 `{` 当块体', () => {
  const { block } = blockFor(ASI_PAGE, 'const items = that.data.items.concat');
  assert.equal(
    block, null,
    '这一行以 `)` 收尾、下一行以标识符开头 ⇒ ASI 新语句；修复前会把 `that.setData({…})` 的块算成它的块',
  );
});

test('④ ASI：整行没有 `{` 的声明不会跨到后面的函数上', () => {
  const { line, block } = blockFor(ASI_PAGE, 'const api = require');
  assert.equal(block, null, `第 ${line} 行是纯赋值语句，不该有块体；修复前会一路吃到第 10 行的函数上`);
});

test('④ 行预算：被跳过的块也要计入 20 行预算，不许 `close + 1` 之后重新起算', () => {
  // 一个 25 行的**类型字面量**（签名里的一段，不是块体）之后才是真函数体。
  // 跳过它时若不计换行，预算就白送 25 行，扫描会摸到第 28 行的真函数体并把它当块体。
  const lines = ['export function describe(): {'];
  for (let index = 0; index < 25; index += 1) lines.push(`  field${index}: string`);
  lines.push('} {', '  return 1', '}');
  const source = lines.join('\n');
  const typeLiteralClose = lines.length - 2; // `} {` 那一行（类型字面量收尾）
  const block = declarationBlock(source, 1);
  assert.ok(block !== null, '预算用尽 ≠ 没有块体：仍要给一个块，但必须有标记');
  assert.equal(block.end, typeLiteralClose, '预算用尽就该停在被跳过的类型字面量收尾行，不许再往下摸到真函数体');
  assert.equal(block.bodyFallback, true, '这种块必须标 bodyFallback（块体可能不准），不许静默当对块');
});

// —— 真实文件自证：services/api/src/app.ts 的 buildApp ————————————————————
// 这一条是本片的派单证据：修复前 `resolveSymbolBlock('buildApp')` 返回 {731,731}（单行），
// 修复后必须覆盖真实函数体（末端由花括号配平现算，不写死数字）。
const APP_SOURCE = readFileSync(join(ROOT, 'services/api/src/app.ts'), 'utf8');
const BUILD_APP_LINE = APP_SOURCE.split('\n').findIndex(line => line.trim().startsWith('export function buildApp(')) + 1;

test('真实文件：buildApp 的块体覆盖真实函数体（修复前是单行块）', () => {
  assert.ok(BUILD_APP_LINE > 1, 'services/api/src/app.ts 里应能找到 buildApp 声明');
  const realEnd = braceBalancedEnd(APP_SOURCE, BUILD_APP_LINE);
  assert.ok(realEnd > BUILD_APP_LINE + 100, `buildApp 的真实函数体应远长于一行（现算 ${BUILD_APP_LINE}-${realEnd}）`);
  assert.deepEqual(
    declarationBlock(APP_SOURCE, BUILD_APP_LINE),
    { start: BUILD_APP_LINE, end: realEnd },
    `buildApp（第 ${BUILD_APP_LINE} 行，参数是解构对象）的块体应为 ${BUILD_APP_LINE}-${realEnd}`,
  );
});

test('真实文件：符号形态解析 buildApp 只给一个候选，且覆盖函数体内部的行', () => {
  const resolved = resolveSymbolBlock(APP_SOURCE, 'buildApp');
  assert.equal(resolved.status, 'OK', resolved.reason);
  assert.equal(resolved.candidates.length, 1, '同名声明只应有一个归属块');
  const [block] = resolved.candidates;
  assert.equal(block.start, BUILD_APP_LINE);
  assert.equal(block.end, braceBalancedEnd(APP_SOURCE, BUILD_APP_LINE));
  // 函数体中段的一行：归属块必须包住它，且不能退化成「命中行 ±0」。
  const middle = Math.floor((block.start + block.end) / 2);
  const enclosing = enclosingBlock(APP_SOURCE, middle);
  assert.ok(enclosing.start <= middle && middle <= enclosing.end, `第 ${middle} 行的归属块必须覆盖它自身`);
  assert.ok(enclosing.end - enclosing.start > 0, `第 ${middle} 行不应退化成单行块：${JSON.stringify(enclosing)}`);
});

// —— ⑤ 声明行自带对象字面量时，ASI 仍要生效（不许设 latch） ————————————————
// 这是被打回两次的根因：一旦「本行出现过 `{`」就把 ASI 永久关掉，扫描会跨过语句，把下一条
// `if (…) {` 或函数表达式的块抢过来（`语句级候选立即返回` 让它更容易得手）。
const DECIDE_INLINE_OBJECT = [
  'function run(job) {', //                        1
  '  const decision = this.policy().decide({', //  2 —— 行内含对象字面量（括号深度 1）
  '    targetRef: job', //                         3
  '  })', //                                       4
  '  if (job.size === 0) {', //                    5 —— 下一条语句，绝不是第 2 行的块体
  '    return', //                                 6
  '  }', //                                        7
  '  return decision', //                          8
  '}', //                                          9
].join('\n');

test('⑤ 行内对象字面量不许把 ASI 关掉：块不许跨到下一条 `if (…) {` 上', () => {
  const { line, block } = blockFor(DECIDE_INLINE_OBJECT, 'const decision = this.policy().decide');
  assert.ok(block !== null, `第 ${line} 行应取到它自己的对象实参块`);
  assert.ok(
    block.end < 5,
    `块 ${block.start}-${block.end} 跨到了第 5 行的 if 语句上（说明 ASI 被行内 { 关掉了）`,
  );
});

test('⑤ 同类：`const x = list.filter(function (e) { … })[0]` 之后不许吃掉后面的函数表达式', () => {
  const source = [
    'function open(id) {', //                                    1
    '  const item = list.filter(function (e) { return e.id === id })[0]', // 2
    '  if (!item) return', //                                    3
    '  const openIt = function (postId) {', //                   4
    '    go(postId)', //                                         5
    '  }', //                                                    6
    '}', //                                                      7
  ].join('\n');
  const { block } = blockFor(source, 'const item = list.filter');
  assert.ok(block === null || block.end < 4, `块 ${block?.start}-${block?.end} 吃掉了第 4 行的函数表达式`);
});

// —— 真实文件自证：无分号小程序页（ASI 的活样本） ——————————————————————
// 行号一律按内容现算，不写死 `文件:行号`（`test-line-anchors-guard` 的判据）。
const MESSAGES_JS = readFileSync(join(ROOT, 'miniprogram/pages/messages/messages.js'), 'utf8');
const MESSAGES_LINES = MESSAGES_JS.split('\n');
const MESSAGES_ITEMS_LINE = MESSAGES_LINES.findIndex(line => line.trim().startsWith('const items = that.data.items.concat')) + 1;
const MESSAGES_REFRESH_LINE = MESSAGES_LINES.findIndex(line => line.trim().startsWith('refreshUnread: function')) + 1;

test('真实文件：无分号页里 `const items = …` 不是块声明，块不许跨到下一条方法', () => {
  assert.ok(MESSAGES_ITEMS_LINE > 1, 'messages.js 里应能找到 `const items = that.data.items.concat(…)`');
  assert.ok(MESSAGES_REFRESH_LINE > MESSAGES_ITEMS_LINE, '下一条方法应在它之后');
  assert.equal(
    declarationBlock(MESSAGES_JS, MESSAGES_ITEMS_LINE), null,
    '这一行没有 `{`，修复前会把 `setData({…})` 的块算成它的块（一路到 `refreshUnread` 才收尾）',
  );
  const blocks = declarationBlocks(MESSAGES_JS);
  assert.deepEqual(
    blocks.filter(block => block.start === MESSAGES_ITEMS_LINE).map(block => block.symbol),
    [],
    `第 ${MESSAGES_ITEMS_LINE} 行不该产出任何声明块`,
  );
  // 覆盖它的只能是**起自更早**的真外层声明（`Page({…})`）；修复前那三个假块
  // （items／that／epoch，起点不早于 169）都在这一行起算或紧随其后，且都收尾在下一条方法上。
  const covering = blocks.filter(block => block.start <= MESSAGES_ITEMS_LINE && MESSAGES_ITEMS_LINE <= block.end);
  for (const block of covering) {
    assert.ok(block.start < MESSAGES_ITEMS_LINE, `块 ${block.start}-${block.end}（${block.symbol}）不该由这一行起始`);
  }
  assert.equal(
    covering.some(block => ['items', 'that', 'epoch'].includes(block.symbol)), false,
    `覆盖该行的块里仍有假归属：${covering.map(block => block.symbol).join('、')}`,
  );
});

// —— 真实文件自证：voice.js 的 `const decision = …decide({`（行内对象字面量）——————
// 这一条盯的正是被打回的 6 条误命中之一：`571-574` 曾被算进 `decision(566-575)`。
const VOICE_JS = readFileSync(join(ROOT, 'miniprogram/pages/voice/voice.js'), 'utf8');
const VOICE_DECISION_LINE = VOICE_JS.split('\n').findIndex(line => line.includes('const decision = this.autoSpeakPolicy().decide({')) + 1;
const VOICE_IF_LINE = VOICE_JS.split('\n').findIndex(line => line.includes('if (segments.length === 0) {')) + 1;

test('真实文件：voice.js 的 `const decision = …decide({…})` 块不许跨到后面的 if', () => {
  assert.ok(VOICE_DECISION_LINE > 1, 'voice.js 里应能找到 `const decision = …decide({`');
  assert.ok(VOICE_IF_LINE > VOICE_DECISION_LINE, '后面的 if 应在它之后');
  const block = declarationBlock(VOICE_JS, VOICE_DECISION_LINE);
  assert.ok(block !== null, '这一行有自己的对象实参块');
  assert.ok(
    block.end < VOICE_IF_LINE,
    `块 ${block.start}-${block.end} 跨到了 if 语句上；第 ${VOICE_IF_LINE} 行起的内容不属于这一行`,
  );
});

// —— 不回归：braceBlockEnd 仍然按配平走 ——————————————————————————————
test('braceBlockEnd 仍然跳过字符串/模板/注释里的花括号', () => {
  const source = '{\n  const s = "}";\n  const t = `}`;\n  // }\n  /* } */\n}';
  assert.equal(braceBlockEnd(source, 0), source.lastIndexOf('}'));
});

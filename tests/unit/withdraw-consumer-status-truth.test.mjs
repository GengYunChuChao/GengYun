/**
 * 钉线：`withdrawConsent` 台账的 blocker 必须与基线代码事实一致（R72／W32 状态同步片）。
 *
 * ## 为什么要有这条
 *
 * `docs/architecture/contract-status.json` 的 `withdrawConsent`（`status` = `partial`）曾长期在
 * `blocker` 里写「#128提供外发账本/在途守卫/模块删除注册协议，**但本基线尚未接入撤回消费者**」。
 * 这句与基线代码事实**相反**，四处证据：
 *
 *   1. `services/api/src/app.ts:1021-1023` —— 撤回消费者真的被**构造**：
 *      `const egressRevoker: EgressRevoker | undefined = privacyInjection?.egressRevoker ??`
 *      `(egressLedger === null || config.executionMode !== 'real' ? undefined : createEgressRevoker({ ledger: egressLedger }));`
 *   2. `services/api/src/app.ts:2445-2448` —— 它真的被**注入**授权路由：
 *      `registerConsentRoutes(app, config, pool, guards, { ...(consentGrantTestOptions ?? {}), ...(egressRevoker === undefined ? {} : { egressRevoker }) });`
 *   3. `services/api/src/privacy/consent-pg.ts:178` —— 缺消费者才 **fail-closed**：
 *      `if (!serviceOptions.egressRevoker) throw new ApiError('OBJECT_UNAVAILABLE', '已有资料或任务的撤回消费者尚未接入');`
 *      而 `services/api/src/privacy/consent-pg.ts:183` 在有消费者时**真调用**：
 *      `await serviceOptions.egressRevoker.onConsentWithdrawn({ userId: input.identity.userId, purpose: options.purpose });`
 *   4. 仓内已两次自认过期：`docs/verification/gy-i29-closure-20261018.md:204`（「与基线事实相反」）、
 *      `:212`（「同一仓内自相矛盾，旧 status 行未随 #128 更新」），并在 `:216` 明写「留待状态同步片处理」。
 *
 * 也就是说：**错的是台账文字，不是代码，也不是断言**。本片只做文字订正，**不**把 `partial` 改成
 * `implemented`（真实外发政策与接收方、注销全链仍未验，#133 未合不计入本基线）。
 *
 * ## 红了怎么办（先判哪一侧错，别改断言凑绿）
 *
 * - T1／T2 红：说明 `docs/architecture/contract-status.json` 的 `blocker` 与
 *   `docs/architecture/contract-implementation-status.md` 的镜像行有一侧被改回去了。
 *   正确做法是改 JSON，再跑 `node tools/verify-contract-status.mjs --write-doc` 让它**渲染**出 md
 *   （⛔ 不许只手改 md —— 那样下一次 `--write-doc` 会把它冲掉；也⛔ 不许改断言）。
 * - T3 红：说明**代码**变了（撤回消费者被摘掉／注入被删／fail-closed 被绕过）。那时要判断的是
 *   台账该写什么，**不要**动这条测试去迎合代码；若确属代码回退，本条按红灯上报。
 * - T4 红：说明有人把「未验」限定词删了、或把 `partial` 说成已完成。
 * - T5 红：说明有人动了只读历史页 `docs/verification/**`（本片一个字都不该改）。
 *
 * 本文件只读文件文本、不 import 任何服务代码（不建池、不连 PG、不起 HTTP）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATUS_JSON = join(ROOT, 'docs/architecture/contract-status.json');
const STATUS_MD = join(ROOT, 'docs/architecture/contract-implementation-status.md');
const APP_TS = join(ROOT, 'services/api/src/app.ts');
const CONSENT_PG_TS = join(ROOT, 'services/api/src/privacy/consent-pg.ts');
const CLOSURE_PAGE = join(ROOT, 'docs/verification/gy-i29-closure-20261018.md');

const read = (path) => readFileSync(path, 'utf8');

/** 台账里的 `withdrawConsent` 条目（找不到就红：操作被改名/删除属于本片判据失效）。 */
function withdrawConsentOperation() {
  const operations = JSON.parse(read(STATUS_JSON)).operations;
  const operation = operations.find((entry) => entry.id === 'withdrawConsent');
  assert.ok(operation, 'docs/architecture/contract-status.json 里找不到 id=withdrawConsent 的条目（操作被改名/删除？）');
  return operation;
}

/**
 * 去掉行注释与块注释行后再做「代码事实」匹配。
 *
 * 为什么必须去注释：T3 要钉的是「消费者**真的**被构造/注入/调用」，而不是「这几个标识符在文件里出现过」。
 * 把构造块整段注释掉时文本仍在，若不去注释 T3 会假绿 —— 负控制 N1 正是这个形状。
 */
function stripCommentLines(source) {
  const kept = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** 取出 `registerConsentRoutes(...)` 调用的实参块文本（从调用行到其后首个 `});`）。 */
function consentRoutesCallBlock(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.includes('registerConsentRoutes(app, config, pool, guards, {'));
  assert.notEqual(start, -1, 'services/api/src/app.ts 里找不到 registerConsentRoutes(app, config, pool, guards, {...}) 调用（注入点被删/改形）');
  const end = lines.findIndex((line, index) => index > start && line.trim() === '});');
  assert.notEqual(end, -1, 'registerConsentRoutes 调用块没有以 `});` 收尾（结构变了，本钉线需人工复核）');
  return lines.slice(start, end + 1).join('\n');
}

/**
 * 对大文件做「必须命中」断言：用 `assert.ok(regex.test(...))` 而不是 `assert.match`。
 *
 * 为什么：`assert.match(整份 app.ts, ...)` 失败时会把 6 万多字符的 `actual` 整段打印出来，
 * 真正的红点（哪条判据没命中）被淹掉；这里只回显未命中的正则与原因。
 */
function expectMatch(text, pattern, message) {
  assert.ok(pattern.test(text), `${message}（未命中 /${pattern.source}/）`);
}

/** 表格单元文本 → 与 JSON 字符串可比的形式：还原 `\|` 转义、压平空白、去首尾空白。 */
const normalizeCell = (cell) => cell.replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();

/** 中文对照表里 `withdrawConsent` 那一行的 blocker 单元（最后一列）。 */
function renderedBlockerCell() {
  const rows = read(STATUS_MD)
    .split('\n')
    .filter((line) => line.startsWith('| `withdrawConsent` |'));
  assert.equal(rows.length, 1, `docs/architecture/contract-implementation-status.md 里 withdrawConsent 行数应为 1，实际 ${rows.length}`);
  const cells = rows[0].replace(/^\|/, '').replace(/\|$/, '').split('|');
  assert.equal(cells.length, 5, `withdrawConsent 行应为 5 列（操作／路径／状态／证据／缺口），实际 ${cells.length} 列`);
  return { statusCell: normalizeCell(cells[2]), blocker: normalizeCell(cells[4]) };
}

test('T1 台账 blocker 说的是「已接线 + 条件注入 + 缺失时 fail-closed」，不再说未接入', () => {
  const { blocker, status } = withdrawConsentOperation();
  assert.equal(typeof blocker, 'string', 'withdrawConsent.blocker 必须是字符串');
  assert.ok(blocker.length > 0, 'withdrawConsent.blocker 不能为空');
  // 单行：blocker 是一行 JSON 字符串，换行会把渲染出的表格行拆开（行数漂移）。
  assert.ok(!/[\r\n]/.test(blocker), 'withdrawConsent.blocker 不许含换行（必须保持单行，否则中文对照表行数漂移）');
  // 旧谎言必须消失。
  assert.ok(!blocker.includes('尚未接入撤回消费者'), `withdrawConsent.blocker 仍写着「尚未接入撤回消费者」（与 services/api/src/app.ts:1021-1023／:2445-2448 事实相反）：${blocker}`);
  // 四件事：已接线（构造 + 注入）、条件注入、缺失时 fail-closed、真调用。
  for (const needle of ['createEgressRevoker', 'registerConsentRoutes', 'onConsentWithdrawn', 'OBJECT_UNAVAILABLE']) {
    assert.ok(blocker.includes(needle), `withdrawConsent.blocker 缺少「${needle}」（订正必须同时说清接线事实与 fail-closed 落点）`);
  }
  assert.match(blocker, /未验/, 'withdrawConsent.blocker 必须保留「未验」类限定词（真实外发政策与接收方、注销全链仍未验）');
  // 状态不许被顺手改掉：本片只订正文字。
  assert.equal(status, 'partial', `withdrawConsent.status 仍应是 partial（本片只订正 blocker 文字），实际 ${status}`);
});

test('T2 中文对照表那一行逐字等于 JSON blocker（镜像只许由工具渲染）', () => {
  const { blocker } = withdrawConsentOperation();
  const { statusCell, blocker: rendered } = renderedBlockerCell();
  assert.equal(statusCell, '`partial`', `对照表里 withdrawConsent 状态列应是 \`partial\`，实际 ${statusCell}`);
  assert.equal(
    rendered,
    normalizeCell(blocker),
    'docs/architecture/contract-implementation-status.md:66 的 blocker 与 JSON 不一致 —— 改 JSON 后跑 node tools/verify-contract-status.mjs --write-doc 渲染，⛔ 不许手改 md、也不许改断言',
  );
});

test('T3 代码事实钉子：消费者真的被构造、真的被注入、缺它才 fail-closed', () => {
  const app = stripCommentLines(read(APP_TS));
  const consentPg = stripCommentLines(read(CONSENT_PG_TS));

  // ① 真的被构造（且声明类型就是 EgressRevoker | undefined）。
  expectMatch(
    app,
    /const egressRevoker: EgressRevoker \| undefined =/,
    'services/api/src/app.ts 里 egressRevoker 的构造声明不见了（撤回消费者被摘掉？）',
  );
  expectMatch(app, /createEgressRevoker\(/, 'services/api/src/app.ts 里没有 createEgressRevoker( 调用（构造块被注释/删除？）');
  // ② 条件注入：仅 real 且账本非空才构造（否则 undefined），并以可选展开注入授权路由。
  expectMatch(
    app,
    /egressLedger === null \|\| config\.executionMode !== 'real' \? undefined : createEgressRevoker\(\{ ledger: egressLedger \}\)/,
    'services/api/src/app.ts 的条件注入判据（egressLedger === null || executionMode !== real ⇒ undefined）不见了',
  );
  const callBlock = consentRoutesCallBlock(app);
  assert.match(callBlock, /consentGrantTestOptions/, 'registerConsentRoutes 调用块里的 consentGrantTestOptions 展开不见了');
  assert.match(
    callBlock,
    /egressRevoker === undefined \? \{\} : \{ egressRevoker \}/,
    'services/api/src/app.ts 的 registerConsentRoutes 调用块里没有 `...(egressRevoker === undefined ? {} : { egressRevoker })` 注入形态',
  );

  // ③ 缺消费者才 fail-closed；有消费者时真调用。
  expectMatch(
    consentPg,
    /if \(!serviceOptions\.egressRevoker\) throw new ApiError\('OBJECT_UNAVAILABLE'/,
    'services/api/src/privacy/consent-pg.ts 的「缺消费者 ⇒ OBJECT_UNAVAILABLE」fail-closed 不见了',
  );
  assert.ok(
    consentPg.includes('尚未接入'),
    'services/api/src/privacy/consent-pg.ts 的 fail-closed 文案「…尚未接入」不见了（那是「缺消费者」的运行时错误文案，不是台账口径）',
  );
  expectMatch(
    consentPg,
    /await serviceOptions\.egressRevoker\.onConsentWithdrawn\(/,
    'services/api/src/privacy/consent-pg.ts 里没有真正调用 onConsentWithdrawn( 的语句（接线被摘掉？）',
  );
  assert.ok(
    consentPg.includes('OBJECT_UNAVAILABLE'),
    'services/api/src/privacy/consent-pg.ts 里 OBJECT_UNAVAILABLE 不见了',
  );
});

test('T4 口径钉子：不许把 partial 说成已完成，且必须保留「未验」限定词', () => {
  const { blocker, status } = withdrawConsentOperation();
  const overclaims = ['已完全实现', '完全实现', '已全部实现', '全部实现', 'fully implemented', 'Fully implemented', 'fully-implemented', 'implemented'];
  for (const phrase of overclaims) {
    assert.ok(!blocker.includes(phrase), `withdrawConsent.blocker 出现「${phrase}」：status 仍是 ${status}，不许把未验部分说成已完成`);
  }
  assert.match(blocker, /未验/, 'withdrawConsent.blocker 丢了「未验」限定词（真实外发政策与接收方、注销全链仍未验）');
  assert.equal(status, 'partial', `withdrawConsent.status 不许被改成 ${status}（本片只订正文字，不改状态）`);
});

test('T5 历史页只读钉子：docs/verification 的过期说明一个字未改，仍留待状态同步片', () => {
  const page = read(CLOSURE_PAGE);
  assert.ok(
    page.includes('留待状态同步片处理'),
    'docs/verification/gy-i29-closure-20261018.md:216 的「留待状态同步片处理」不见了 —— 该页是只读历史证据，本片不许改它',
  );
  assert.ok(
    page.includes('与基线事实相反'),
    'docs/verification/gy-i29-closure-20261018.md:204 的「与基线事实相反」判定不见了（历史页被改写？本片应一个字未改）',
  );
});

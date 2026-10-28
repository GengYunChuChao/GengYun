/**
 * GY-R68-C4：后台审计**三读面合并读数**（`apps/admin/src/views/AuditLogsView.vue` +
 * `apps/admin/src/lib/admin-audit-logs.mjs` 的合并层）。
 *
 * 三条读面是三个接口（不是三个页面），服务端零改动：
 *   `/admin/audit-logs`（全表库函数）、`/admin/audit-events`（内存）、`/admin/flag-audit-events`（开关库）。
 * 本文件钉四件事：
 *   1. 合并条数 = 三源之和（有重复时 = 和 − 重复数），`(created_at, id)` 降序，`source` 取值在闭集内；
 *   2. **失败隔离**：一源失败（500／抛错）⇒ 另两源仍照常出数，失败源单独 `role="alert"` 点名；
 *   3. 「来源」筛选切到单一来源后只剩该源的行；
 *   4. 两条负控制：把排序键改成「只按 created_at」、把失败隔离改成「任一源失败即整页失败」都必须红
 *      （见本文件顶部 `NEGATIVE CONTROL` 注释与回报里的手工变异记录）。
 *
 * 为什么必须渲染级：合并逻辑本身在 `.mjs` 里可纯函数断言，但「一张表真的渲染出 N 行」「失败源真的
 * 只播报自己」「筛选切换后表格真的只剩该源」这三条**模板**结论只有挂真 SFC 才能证明。
 * `apps/admin` 没有 vitest / @vue/test-utils / jsdom，所以沿用
 * `tests/unit/admin-ui-audit-logs-render.test.mjs` 的内联最小渲染夹具（不新增依赖、不联网）：
 * `@vue/compiler-sfc` 编 SFC → `../auth/session` 换成 data: URL 桩 → `vue` 的 `createRenderer()`
 * 造内存宿主 → 网络层用 `globalThis.fetch` 桩。
 *
 * ⛔ 不能改用 `tests/unit/admin-ui-sfc-harness.mjs`：那个夹具只把 `vue` 映射到绝对 URL，其余相对
 * 说明符直接 `new URL(spec).href`，`../auth/session`（无扩展名的 .ts）会解析成不存在的 `file:` URL。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

import {
  AUDIT_MERGE_FILTER_ANY,
  AUDIT_MERGE_SOURCES,
  AUDIT_MERGE_SOURCE_LABELS,
  describeMergeCounts,
  filterMergedRows,
  loadAuditMergeSources,
  mergeAuditSources,
} from '../../apps/admin/src/lib/admin-audit-logs.mjs';

if (globalThis.document === undefined) globalThis.document = { activeElement: null };
if (globalThis.Document === undefined) globalThis.Document = class Document {};
if (globalThis.ShadowRoot === undefined) globalThis.ShadowRoot = class ShadowRoot {};

const VIEW_URL = new URL('../../apps/admin/src/views/AuditLogsView.vue', import.meta.url);
const LIB_URL = new URL('../../apps/admin/src/lib/admin-audit-logs.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const SESSION = { accessToken: 'synthetic-admin-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: ['audit:read'] };
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

/** 三条读面的 URL 前缀（桩按 pathname 分流）。 */
const LOGS_PATH = '/api/v1/admin/audit-logs';
const EVENTS_PATH = '/api/v1/admin/audit-events';
const FLAGS_PATH = '/api/v1/admin/flag-audit-events';

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

/** `apps/admin/src/auth/session.ts` 的桩：只提供本页用到的四个导出（真模块要 Vite 环境）。 */
const SESSION_STUB_URL = moduleUrl(`
export const ADMIN_AUTH_API_IMPLEMENTED = true;
export const API_BASE_URL = '/api/v1';
export function loadAdminSession() {
  return Promise.resolve(globalThis.__GY_TEST_SESSION__ ?? null);
}
export function signInAdmin() {
  const session = globalThis.__GY_TEST_SESSION__ ?? null;
  return session === null ? Promise.reject(new Error('后台登录失败：SESSION_REQUIRED')) : Promise.resolve(session);
}
export function signOutAdmin() {
  globalThis.__GY_TEST_SESSION__ = null;
  return Promise.resolve();
}
`);

let componentPromise = null;

function loadViewComponent() {
  if (componentPromise !== null) return componentPromise;
  const source = readFileSync(VIEW_URL, 'utf8');
  const { descriptor, errors } = parse(source, { filename: fileURLToPath(VIEW_URL) });
  assert.deepEqual(errors, [], 'AuditLogsView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-audit-merge-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../auth/session')}["']`, 'g'), `from '${SESSION_STUB_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/admin-audit-logs.mjs')}["']`, 'g'), `from '${LIB_URL.href}'`);
  assert.deepEqual(
    [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((spec) => !/^(data:|file:)/.test(spec)),
    [],
    '编译产物里不得残留裸模块说明符（data: 模块无法解析它们）',
  );
  componentPromise = import(moduleUrl(code)).then((namespace) => namespace.default);
  return componentPromise;
}

/** 内存宿主：节点足够支撑 Vue 的元素/文本/注释与事件 prop。 */
function createHost() {
  const make = (kind) => ({
    kind,
    children: [],
    parent: null,
    props: {},
    text: '',
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    removeEventListener(type) {
      this.listeners.delete(type);
    },
    getRootNode() {
      return globalThis.document;
    },
    dispatch(type, event = {}) {
      const handler = this.listeners.get(type);
      return handler === undefined ? undefined : handler({ target: this, ...event });
    },
  });

  const insert = (child, parent, anchor = null) => {
    const previous = child.parent;
    if (previous !== null) {
      const index = previous.children.indexOf(child);
      if (index !== -1) previous.children.splice(index, 1);
    }
    child.parent = parent;
    if (anchor === null) {
      parent.children.push(child);
      return;
    }
    const index = parent.children.indexOf(anchor);
    if (index === -1) parent.children.push(child);
    else parent.children.splice(index, 0, child);
  };

  const nodeOps = {
    insert,
    remove(node) {
      const parent = node.parent;
      if (parent === null) return;
      const index = parent.children.indexOf(node);
      if (index !== -1) parent.children.splice(index, 1);
      node.parent = null;
    },
    createElement: (type) => make(String(type)),
    createText: (text) => {
      const node = make('#text');
      node.text = text;
      return node;
    },
    createComment: (text) => {
      const node = make('#comment');
      node.text = text;
      return node;
    },
    setText(node, text) {
      node.text = text;
    },
    setElementText(el, text) {
      el.children = [];
      if (text !== '') insert(nodeOps.createText(text), el);
    },
    parentNode: (node) => node.parent,
    nextSibling(node) {
      const parent = node.parent;
      if (parent === null) return null;
      const index = parent.children.indexOf(node);
      return index === -1 || index + 1 >= parent.children.length ? null : parent.children[index + 1];
    },
    querySelector: () => null,
    setScopeId: () => {},
  };

  return { make, nodeOps, patchProp: (el, key, previous, next) => { el.props[key] = next; } };
}

async function settle() {
  await nextTick();
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();
}

function findAll(root, predicate, hits = []) {
  if (predicate(root)) hits.push(root);
  for (const child of root.children) findAll(child, predicate, hits);
  return hits;
}

function findBy(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const hit = findBy(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

function textOf(node) {
  if (node.kind === '#text') return node.text;
  return node.children.map(textOf).join('');
}

const byTestId = (id) => (node) => node.props['data-testid'] === id;
const countOf = (root, id) => findAll(root, byTestId(id)).length;

/** 合并表的每一行 → `{source, time, requestId, sourceText}`（用于排序与来源断言）。 */
function mergedRows(container) {
  return findAll(container, byTestId('audit-merge-row')).map((row) => {
    const cells = findAll(row, (node) => node.kind === 'td');
    const sourceCell = findBy(row, byTestId('audit-merge-row-source'));
    return {
      source: row.props['data-source'],
      time: textOf(cells[0] ?? null),
      requestId: textOf(cells[cells.length - 1] ?? null),
      sourceText: textOf(sourceCell),
    };
  });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

function page(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } };
}

function errorEnvelope(code, message, retryable = false) {
  return { error: { code, message, retryable, details: [] }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } };
}

function auditEvent(overrides = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    action: 'set_flag',
    scope: 'flags:write',
    target_ref: { type: 'flag', id: 'answer.public', revision: 4 },
    reason_code: 'manual',
    request_id: REQUEST_ID,
    result: 'accepted',
    created_at: '2026-10-23T08:12:33.000Z',
    actor: null,
    target_hint: null,
    before_value: null,
    after_value: null,
    ...overrides,
  };
}

/** 按 pathname 分流的 fetch 桩（三源各一条路由；未登记的路由直接抛，避免漏请求被静默放过）。 */
function routeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const path = String(url).split('?')[0];
    const handler = routes[path];
    if (handler === undefined) throw new Error(`未预期的请求：${url}`);
    return handler({ url, init });
  };
  impl.calls = calls;
  return impl;
}

async function mountView({ fetchImpl } = {}) {
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const originalFetch = globalThis.fetch;
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  globalThis.__GY_TEST_SESSION__ = SESSION;
  const app = createApp(await loadViewComponent());
  app.mount(container);
  await settle();
  return {
    container,
    async click(id) {
      const node = findBy(container, byTestId(id));
      assert.ok(node !== null, `找不到 data-testid="${id}" 的节点`);
      assert.equal(typeof node.props.onClick, 'function', `${id} 必须挂着 click 处理器`);
      node.props.onClick({});
      await settle();
    },
    async choose(value) {
      const node = findBy(container, byTestId('audit-merge-filter'));
      assert.ok(node !== null, '合并面板必须有来源筛选');
      assert.equal(typeof node.props.onChange, 'function', '来源筛选必须挂着 change 处理器');
      node.props.onChange({ target: { value } });
      await settle();
    },
    unmount() {
      app.unmount();
      globalThis.fetch = originalFetch;
      globalThis.__GY_TEST_SESSION__ = null;
    },
  };
}

// ---------------------------------------------------------------------------
// 一、合并规则（纯函数层）
// ---------------------------------------------------------------------------

test('合并：条数 = 三源之和；同一 id 跨源只留一行但重复数进汇总，来源标成全部贡献源', () => {
  const merged = mergeAuditSources([
    {
      source: 'audit-logs',
      result: {
        items: [
          auditEvent({ id: 'aaa', created_at: '2026-10-23T08:00:00.000Z', request_id: 'req-a' }),
          auditEvent({ id: 'bbb', created_at: '2026-10-23T09:00:00.000Z', request_id: 'req-b' }),
        ],
      },
    },
    { source: 'audit-events', result: { ok: true, page: { items: [auditEvent({ id: 'bbb', created_at: '2026-10-23T09:00:00.000Z' }), auditEvent({ id: 'ccc', created_at: '2026-10-23T07:00:00.000Z' })] } } },
    { source: 'flag-audit', items: [auditEvent({ id: 'ddd', created_at: '2026-10-23T06:00:00.000Z' })] },
  ]);

  assert.equal(merged.counts.totalInput, 5, '三源合计必须是 2+2+1');
  assert.equal(merged.counts.deduped, 1, '跨源同 id 重复 1 条，必须进汇总（不是静默丢）');
  assert.equal(merged.rows.length, merged.counts.totalInput - merged.counts.deduped, '合并行数 = 三源之和 − 重复数');
  assert.equal(
    merged.rows.length + merged.counts.deduped,
    merged.counts.totalInput,
    '恒等式 merged + deduped === totalInput（恒真；空 id 的行也进 merged，只是不参与去重）',
  );
  assert.equal(merged.counts.merged, merged.rows.length, 'counts.merged 就是合并后的行数');
  assert.equal(
    Object.values(merged.counts.bySource).reduce((sum, count) => sum + count, 0),
    merged.counts.totalInput,
    'bySource 是「按源计的输入条数」，sum === totalInput',
  );
  assert.deepEqual(merged.counts.bySource, { 'audit-logs': 2, 'audit-events': 2, 'flag-audit': 1 });
  assert.deepEqual(merged.failures, []);
  assert.equal(merged.summary, '三源合计 5 条，去重 1 条');

  const duplicated = merged.rows.find((row) => row.id === 'bbb');
  assert.deepEqual(duplicated.sources, ['audit-logs', 'audit-events'], '重复行的来源必须列全部贡献源（闭集顺序）');
  assert.equal(duplicated.source, 'audit-logs', '主来源取闭集顺序里的第一个');
  assert.match(duplicated.sourceText, /审计总台账/);
  assert.match(duplicated.sourceText, /审计事件/);
  for (const row of merged.rows) {
    assert.ok(AUDIT_MERGE_SOURCES.includes(row.source), `source 必须在闭集内，实际是 ${row.source}`);
  }
});

test('纯函数：空 id 行进 merged 但不参与去重（5 = 4 + 1，不是 4 = 5 − 3）', () => {
  const blank = auditEvent({ id: '', created_at: '2026-10-23T03:00:00.000Z' });
  const merged = mergeAuditSources([
    { source: 'audit-logs', items: [blank, blank, auditEvent({ id: 'shared', created_at: '2026-10-23T02:00:00.000Z' })] },
    { source: 'flag-audit', items: [blank, auditEvent({ id: 'shared', created_at: '2026-10-23T02:00:00.000Z' })] },
  ]);
  assert.equal(merged.counts.totalInput, 5);
  assert.equal(merged.counts.unidentified, 3, '三条读面返回的行没有 id');
  assert.equal(merged.counts.deduped, 1, '只有 shared 那条算跨源重复');
  assert.equal(merged.rows.length, 4, '三条空 id 行各自保留（不猜、也不静默丢）');
  assert.equal(merged.rows.length + merged.counts.deduped, merged.counts.totalInput, '恒等式 merged + deduped === totalInput 仍成立');
  assert.equal(
    merged.rows.length + merged.counts.deduped === merged.counts.totalInput - merged.counts.unidentified,
    false,
    '旧口径「merged + deduped === totalInput − unidentified」在这组数据上是假的（5 ≠ 2）',
  );
  assert.equal(merged.rows.filter((row) => row.id === '').length, 3, '空 id 行共享同一个空 id，但仍是 3 行');
});

test('排序：(created_at, id) 降序——同一时间戳靠 id 降序定序，不靠插入顺序', () => {
  const merged = mergeAuditSources([
    { source: 'audit-logs', items: [auditEvent({ id: '11111111-1111-4111-8111-aaaaaaaaaaaa', created_at: '2026-10-23T09:00:00.000Z' })] },
    { source: 'audit-events', items: [auditEvent({ id: '11111111-1111-4111-8111-bbbbbbbbbbbb', created_at: '2026-10-23T09:00:00.000Z' })] },
    { source: 'flag-audit', items: [auditEvent({ id: '11111111-1111-4111-8111-cccccccccccc', created_at: '2026-10-23T10:00:00.000Z' })] },
  ]);
  assert.deepEqual(
    merged.rows.map((row) => row.id),
    ['11111111-1111-4111-8111-cccccccccccc', '11111111-1111-4111-8111-bbbbbbbbbbbb', '11111111-1111-4111-8111-aaaaaaaaaaaa'],
    '时间新的在前；时间相同则 id 大的在前（只按 created_at 排会得到 …aaaa 在前）',
  );
});

test('失败隔离（纯函数层）：一源 `{ok:false}` 只记进 failures，另两源的行照常在', () => {
  const merged = mergeAuditSources([
    { source: 'audit-logs', result: { ok: false, kind: 'unavailable', status: 503, code: 'PROVIDER_UNAVAILABLE', message: '审计日志读取尚未接线' } },
    { source: 'audit-events', result: { items: [auditEvent({ id: 'eee', created_at: '2026-10-23T05:00:00.000Z' })] } },
    { source: 'flag-audit', result: { items: [auditEvent({ id: 'fff', created_at: '2026-10-23T04:00:00.000Z' })] } },
  ]);
  assert.equal(merged.rows.length, 2, '两个成功源必须照常出数');
  assert.equal(merged.failures.length, 1);
  assert.equal(merged.failures[0].source, 'audit-logs');
  assert.match(merged.failures[0].message, /服务暂不可用|读取尚未接线|PROVIDER_UNAVAILABLE/, '失败文案要能看出原因');
  assert.equal(merged.counts.bySource['audit-logs'], 0, '失败源不计条数（页面用「读取失败」而不是 0 条）');
  assert.equal(describeMergeCounts(merged.counts), '三源合计 2 条，去重 0 条');
});

test('失败隔离（异步层）：一源网络中断，另两源仍返回成功结果', async () => {
  const fetchImpl = async (url) => {
    const path = String(url).split('?')[0];
    if (path === LOGS_PATH) throw new Error('网络中断');
    if (path === EVENTS_PATH) return jsonResponse(200, page([auditEvent({ id: 'h1' })]));
    if (path === FLAGS_PATH) return jsonResponse(200, page([auditEvent({ id: 'h2' })]));
    throw new Error(`未预期的请求：${url}`);
  };
  const entries = await loadAuditMergeSources({ fetchImpl, baseUrl: '/api/v1', token: 'synthetic-admin-token', limit: 20 });
  assert.equal(entries.length, 3, '三条读面各交一条结果，失败也在里面（不是抛出去）');
  const bySource = new Map(entries.map((entry) => [entry.source, entry]));
  const logsResult = bySource.get('audit-logs').result;
  assert.equal(logsResult.ok, false, '网络中断要收敛成失败结果，而不是让整次读取 reject');
  assert.equal(logsResult.kind, 'network_error');
  assert.match(String(logsResult.message), /网络中断/);
  assert.equal(bySource.get('audit-events').result.ok, true, '另两源必须仍成功');
  assert.equal(bySource.get('flag-audit').result.ok, true);

  const merged = mergeAuditSources(entries);
  assert.equal(merged.rows.length, 2, '成功源的 2 条必须出数');
  assert.equal(merged.failures.length, 1);
  assert.equal(merged.failures[0].source, 'audit-logs');
  assert.match(merged.failures[0].message, /网络/);
});

// ---------------------------------------------------------------------------
// 二、渲染级：一张表 + 来源列 + 来源筛选 + 失败点名
// ---------------------------------------------------------------------------

/** 三源样例：`audit-logs` 2 条、`audit-events` 2 条（其中 1 条与 audit-logs 同 id）、`flag-audit` 1 条。 */
function threeSourceRoutes() {
  return {
    [LOGS_PATH]: () =>
      jsonResponse(
        200,
        page([
          auditEvent({ id: '44444444-4444-4444-8444-44444444444b', created_at: '2026-10-23T08:12:33.000Z', request_id: 'req-logs-newest', action: 'set_flag' }),
          auditEvent({ id: '44444444-4444-4444-8444-44444444444a', created_at: '2026-10-23T08:00:00.000Z', request_id: 'req-logs-older', action: 'account.suspend' }),
        ]),
      ),
    [EVENTS_PATH]: () =>
      jsonResponse(
        200,
        page([
          auditEvent({ id: '44444444-4444-4444-8444-44444444444b', created_at: '2026-10-23T08:12:33.000Z', request_id: 'req-events-dup' }),
          auditEvent({ id: '44444444-4444-4444-8444-44444444444c', created_at: '2026-10-23T07:00:00.000Z', request_id: 'req-events-only' }),
        ]),
      ),
    [FLAGS_PATH]: () => jsonResponse(200, page([auditEvent({ id: '44444444-4444-4444-8444-44444444444d', created_at: '2026-10-23T06:00:00.000Z', request_id: 'req-flag-only' })])),
  };
}

test('渲染：点「读取三源」后一张表 = 5 条 − 1 条重复 = 4 行，按时间降序，来源列标出全部贡献源', async () => {
  const fetchImpl = routeFetch(threeSourceRoutes());
  const mounted = await mountView({ fetchImpl });
  try {
    // 合并读数必须是显式动作：挂载时只发单源台账那 1 个请求（既有渲染用例也钉了这一条）。
    assert.equal(fetchImpl.calls.length, 1, '挂载时不得替用户读三源');
    assert.equal(countOf(mounted.container, 'audit-merge-row'), 0, '没点之前合并表不得有行');

    await mounted.click('audit-merge-load');
    assert.equal(fetchImpl.calls.length, 4, '点一次 = 单源台账 1 次 + 三源各 1 次');

    const rows = mergedRows(mounted.container);
    assert.equal(rows.length, 4, '三源合计 5 条、跨源重复 1 条 ⇒ 合并后 4 行');
    assert.deepEqual(
      rows.map((row) => row.time),
      ['2026-10-23 08:12:33Z', '2026-10-23 08:00:00Z', '2026-10-23 07:00:00Z', '2026-10-23 06:00:00Z'],
      '(created_at, id) 降序：时间新的在前',
    );
    for (const row of rows) {
      assert.ok(AUDIT_MERGE_SOURCES.includes(row.source), `行上的 source 必须在闭集内，实际是 ${row.source}`);
    }

    const summary = findBy(mounted.container, byTestId('audit-merge-summary'));
    assert.ok(summary !== null, '顶部必须有合计读数');
    assert.match(textOf(summary), /三源合计 5 条，去重 1 条/, '去重必须在汇总里体现，不能静默丢掉');

    // 逐源计数：三个来源各一个 pill。
    assert.equal(countOf(mounted.container, 'audit-merge-count-audit-logs'), 1);
    assert.match(textOf(findBy(mounted.container, byTestId('audit-merge-count-audit-logs'))), /2 条/);
    assert.match(textOf(findBy(mounted.container, byTestId('audit-merge-count-audit-events'))), /2 条/);
    assert.match(textOf(findBy(mounted.container, byTestId('audit-merge-count-flag-audit'))), /1 条/);

    // 重复行的来源列列出两个来源（不是只留一条、也不是丢一行）。
    const duplicated = rows.find((row) => row.sourceText.includes(' + '));
    assert.ok(duplicated !== undefined, '同 id 跨源重复的行必须标出多个来源');
    assert.match(duplicated.sourceText, /审计总台账/);
    assert.match(duplicated.sourceText, /审计事件/);

    assert.equal(countOf(mounted.container, 'audit-merge-failure'), 0, '三源都成功时不得有失败播报');
  } finally {
    mounted.unmount();
  }
});

test('渲染：一源 503 ⇒ 另两源照常出数，失败源单独 role="alert" 点名（整页不判失败）', async () => {
  const routes = threeSourceRoutes();
  routes[EVENTS_PATH] = () => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '审计事件读面尚未接线', false));
  const fetchImpl = routeFetch(routes);
  const mounted = await mountView({ fetchImpl });
  try {
    await mounted.click('audit-merge-load');

    const alerts = findAll(mounted.container, byTestId('audit-merge-failure'));
    assert.equal(alerts.length, 1, '只有一源失败就只播报一条');
    assert.equal(alerts[0].props.role, 'alert', '失败播报必须是 alert 语义');
    const alertText = textOf(alerts[0]);
    assert.match(alertText, /审计事件（内存读面）读取失败：/, '文案必须点名失败的是哪一源');
    assert.match(alertText, /服务暂不可用|尚未接线|PROVIDER_UNAVAILABLE/, '文案必须带上原因');
    assert.equal(alerts[0].props['data-source'], 'audit-events');

    // 失败隔离的反面：整页判失败会连一行都没有 / 单源台账被清空。
    const rows = mergedRows(mounted.container);
    assert.equal(rows.length, 3, 'audit-logs 2 条 + flag-audit 1 条必须照常出数');
    assert.deepEqual(
      [...new Set(rows.map((row) => row.source))].sort(),
      ['audit-logs', 'flag-audit'],
      '剩下两源的行必须都在',
    );
    assert.equal(countOf(mounted.container, 'audit-log-row'), 2, '上面那张单源台账不得被合并读数影响');

    const summary = findBy(mounted.container, byTestId('audit-merge-summary'));
    assert.match(textOf(summary), /三源合计 3 条，去重 0 条/, '合计只数成功源的条数');
    assert.match(textOf(findBy(mounted.container, byTestId('audit-merge-count-audit-events'))), /读取失败/, '失败源写「读取失败」，不是「0 条」');
  } finally {
    mounted.unmount();
  }
});

test('渲染：三源全成功且都 0 行 ⇒ 空态必须说「都读成功」，且不得出现「失败」字样', async () => {
  const routes = {
    [LOGS_PATH]: () => jsonResponse(200, page([])),
    [EVENTS_PATH]: () => jsonResponse(200, page([])),
    [FLAGS_PATH]: () => jsonResponse(200, page([])),
  };
  const fetchImpl = routeFetch(routes);
  const mounted = await mountView({ fetchImpl });
  try {
    await mounted.click('audit-merge-load');
    assert.equal(mergedRows(mounted.container).length, 0);
    assert.equal(countOf(mounted.container, 'audit-merge-failure'), 0, '三源都成功时不得有失败播报');
    assert.match(textOf(findBy(mounted.container, byTestId('audit-merge-summary'))), /三源合计 0 条，去重 0 条/);

    const empty = findBy(mounted.container, byTestId('audit-merge-empty'));
    assert.ok(empty !== null, '0 行时必须有空态');
    const emptyText = textOf(empty);
    assert.match(emptyText, /都读成功/, '三源都读成功时必须说清这是空台账，不是故障');
    assert.doesNotMatch(emptyText, /失败/, '三源都成功时空态不得出现「失败」字样（否则空台账会被读成故障）');
  } finally {
    mounted.unmount();
  }
});

test('渲染：三源全失败 ⇒ 空态照出但不得自称「三条读面都读成功」，3 条 alert 仍在', async () => {
  const routes = {
    [LOGS_PATH]: () => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '全表读面尚未接线', false)),
    [EVENTS_PATH]: () => jsonResponse(500, errorEnvelope('INTERNAL', '内存读面内部错误', false)),
    [FLAGS_PATH]: () => {
      throw new Error('开关库读面网络中断');
    },
  };
  const fetchImpl = routeFetch(routes);
  const mounted = await mountView({ fetchImpl });
  try {
    await mounted.click('audit-merge-load');
    assert.equal(mergedRows(mounted.container).length, 0, '三源全失败时合并表 0 行');
    assert.equal(countOf(mounted.container, 'audit-merge-table'), 0, '0 行时不出空表头');

    const alerts = findAll(mounted.container, byTestId('audit-merge-failure'));
    assert.equal(alerts.length, 3, '三条读面各失败一次就要三条播报');
    for (const alert of alerts) assert.equal(alert.props.role, 'alert');

    const empty = findBy(mounted.container, byTestId('audit-merge-empty'));
    assert.ok(empty !== null, '0 行时仍要有空态，不能白屏');
    const emptyText = textOf(empty);
    assert.doesNotMatch(emptyText, /都读成功/, '三源全失败时不得把失败说成「三条读面都读成功」');
    assert.match(emptyText, /失败/, '空态必须指向上面点名的失败，而不是自称成功');
  } finally {
    mounted.unmount();
  }
});

test('渲染：来源筛选切到单一来源后只剩该源行，切回全部恢复', async () => {
  const fetchImpl = routeFetch(threeSourceRoutes());
  const mounted = await mountView({ fetchImpl });
  try {
    await mounted.click('audit-merge-load');
    assert.equal(mergedRows(mounted.container).length, 4);

    await mounted.choose('flag-audit');
    const onlyFlag = mergedRows(mounted.container);
    assert.equal(onlyFlag.length, 1, '开关库读面只有 1 条');
    assert.deepEqual([...new Set(onlyFlag.map((row) => row.source))], ['flag-audit']);
    assert.equal(findBy(mounted.container, byTestId('audit-merge-empty')), null);

    await mounted.choose('audit-logs');
    assert.equal(mergedRows(mounted.container).length, 2, '全表读面 2 条');

    await mounted.choose(AUDIT_MERGE_FILTER_ANY);
    assert.equal(mergedRows(mounted.container).length, 4, '切回「全部来源」恢复 4 行');

    // 筛选只是筛已读到的行，不重发请求。
    assert.equal(fetchImpl.calls.length, 4, '切筛选不得再发请求');
  } finally {
    mounted.unmount();
  }
});

test('渲染：负控制——同一时间戳两条必须靠 id 降序定序（只按 created_at 排会在这里红）', async () => {
  const LOW = '11111111-1111-4111-8111-aaaaaaaaaaaa';
  const HIGH = '11111111-1111-4111-8111-bbbbbbbbbbbb';
  const routes = {
    [LOGS_PATH]: () => jsonResponse(200, page([auditEvent({ id: LOW, created_at: '2026-10-23T09:00:00.000Z', request_id: 'req-low-id' })])),
    [EVENTS_PATH]: () => jsonResponse(200, page([auditEvent({ id: HIGH, created_at: '2026-10-23T09:00:00.000Z', request_id: 'req-high-id' })])),
    [FLAGS_PATH]: () => jsonResponse(200, page([])),
  };
  const fetchImpl = routeFetch(routes);
  const mounted = await mountView({ fetchImpl });
  try {
    await mounted.click('audit-merge-load');
    const rows = mergedRows(mounted.container);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.requestId),
      ['req-high-id', 'req-low-id'],
      'created_at 相同时必须 id 降序（…bbbb 在 …aaaa 之前）；插入顺序是 …aaaa 先，所以「只按 created_at」的稳定排序会给出相反结果',
    );
  } finally {
    mounted.unmount();
  }
});

test('来源筛选白名单：闭集外的取值只当「没有行」，不抛错', () => {
  const rows = [{ sources: ['audit-logs'], source: 'audit-logs' }, { sources: ['flag-audit'], source: 'flag-audit' }];
  assert.equal(filterMergedRows(rows, AUDIT_MERGE_FILTER_ANY).length, 2);
  assert.deepEqual(filterMergedRows(rows, 'nope'), []);
  assert.equal(filterMergedRows(rows, 'flag-audit').length, 1);
  assert.equal(AUDIT_MERGE_SOURCE_LABELS['flag-audit'].includes('开关'), true);
});

// ---------------------------------------------------------------------------
// 七、会话隔离（换账号前后，合并读数不得跨会话残留）
//
// 这三条读面都是「后台会话令牌」授权的：A 读到 → 退出 → B 登录，若合并读数只在 `signOut()` 里
// 清单源表格而不清合并表，B 会看到 A 已读的审计行（跨账号泄露）。在途响应同理：请求是在旧会话里
// 发出去的，回来时必须因为「代号过期」被丢弃，而不能只看 `currentToken` 是否为空。
// ---------------------------------------------------------------------------

/** B 会话：登录成功，但 scope 列表里**没有** `audit:read`（读面应被 403 拒绝）。 */
const SESSION_B = { accessToken: 'synthetic-b-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: [] };

/** 从请求头取令牌（本页每条请求都带 `authorization: Bearer <token>`）。 */
function tokenOf(init) {
  const headers = init?.headers ?? {};
  const raw = headers.authorization ?? headers.Authorization ?? '';
  return String(raw).replace(/^Bearer\s+/i, '');
}

/** 提交登录表单：调 `onSubmit`（`.prevent` 需要 `preventDefault`）。 */
async function submitSignInForm(container) {
  const form = findBy(container, byTestId('audit-log-signin'));
  assert.ok(form !== null, '退出后必须回到登录表单');
  assert.equal(typeof form.props.onSubmit, 'function', '登录表单必须挂着 submit 处理器');
  form.props.onSubmit({ preventDefault() {} });
  await settle();
}

const SCOPE_DENIED_403 = () => jsonResponse(403, errorEnvelope('SCOPE_DENIED', '后台会话缺少所需 scope', false));

test('会话隔离：换账号后合并读数必须清空，B 看不到 A 读到的审计行', async () => {
  const aOnlyRow = auditEvent({ id: 'aaaa1111-1111-4111-8111-111111111111', request_id: 'req-a-only' });
  const routes = {
    [LOGS_PATH]: ({ init }) => (tokenOf(init) === SESSION_B.accessToken ? SCOPE_DENIED_403() : jsonResponse(200, page([aOnlyRow]))),
    [EVENTS_PATH]: ({ init }) => (tokenOf(init) === SESSION_B.accessToken ? SCOPE_DENIED_403() : jsonResponse(200, page([]))),
    [FLAGS_PATH]: ({ init }) => (tokenOf(init) === SESSION_B.accessToken ? SCOPE_DENIED_403() : jsonResponse(200, page([]))),
  };
  const fetchImpl = routeFetch(routes);
  const mounted = await mountView({ fetchImpl });
  try {
    await mounted.click('audit-merge-load');
    assert.equal(countOf(mounted.container, 'audit-merge-row'), 1, 'A 会话先读到 1 条合成审计行');
    assert.equal(countOf(mounted.container, 'audit-merge-counts'), 1, 'A 会话合并读数已落地');

    await mounted.click('audit-log-sign-out');
    assert.equal(countOf(mounted.container, 'audit-merge-row'), 0, '退出后合并表不得继续渲染');

    globalThis.__GY_TEST_SESSION__ = SESSION_B;
    await submitSignInForm(mounted.container);

    assert.equal(countOf(mounted.container, 'audit-log-signin'), 0, 'B 登录后 signedIn 必须为 true（登录表单消失）');
    assert.ok(findBy(mounted.container, byTestId('audit-log-sign-out')) !== null, 'B 登录后应有退出按钮');
    assert.equal(countOf(mounted.container, 'audit-merge-row'), 0, 'B 不得看到 A 读到的审计行（会话隔离）');
    assert.equal(countOf(mounted.container, 'audit-merge-table'), 0, 'B 的合并表必须是空态，不能残留 A 的行');
    assert.equal(countOf(mounted.container, 'audit-merge-counts'), 0, 'mergeLoaded 必须复位：未读三源就不得显示合计');

    // 失败隔离 / 空态诚实保持：B 没有 audit:read，该报失败就报失败，不伪装成空台账。
    const status = findBy(mounted.container, byTestId('audit-log-status'));
    assert.ok(status !== null, 'B 的单源读面必须给出状态块');
    assert.equal(status.props.role, 'alert', 'B 无权限时必须是 alert，不是「空台账」');
    assert.match(textOf(status), /权限不足/, 'B 的 403 必须点名权限不足');
  } finally {
    mounted.unmount();
  }
});

test('会话隔离：换会话之前发出的三源在途响应回来后必须被丢弃（不落地、不置 mergeLoaded）', async () => {
  let releaseStale = null;
  const stale = new Promise((resolve) => {
    releaseStale = resolve;
  });
  const routes = {
    [LOGS_PATH]: ({ init }) => (tokenOf(init) === SESSION.accessToken ? stale : SCOPE_DENIED_403()),
    [EVENTS_PATH]: ({ init }) => (tokenOf(init) === SESSION.accessToken ? stale : SCOPE_DENIED_403()),
    [FLAGS_PATH]: ({ init }) => (tokenOf(init) === SESSION.accessToken ? stale : SCOPE_DENIED_403()),
  };
  const fetchImpl = routeFetch(routes);
  const mounted = await mountView({ fetchImpl });
  try {
    // 触发合并读取但**不 await**：三个请求都挂着（在途）。
    const loadNode = findBy(mounted.container, byTestId('audit-merge-load'));
    assert.ok(loadNode !== null, '合并面板必须有「读取三源」按钮');
    loadNode.props.onClick({});
    await settle();
    assert.equal(countOf(mounted.container, 'audit-merge-row'), 0, '在途期间不该有任何行');

    await mounted.click('audit-log-sign-out');
    globalThis.__GY_TEST_SESSION__ = SESSION_B;
    await submitSignInForm(mounted.container);
    assert.equal(countOf(mounted.container, 'audit-log-signin'), 0, 'B 已登录');

    // 旧会话的响应现在才回来：代号已过期，必须整份丢掉。
    releaseStale(jsonResponse(200, page([auditEvent({ id: 'bbbb2222-2222-4222-8222-222222222222', request_id: 'req-stale' })])));
    await settle();
    await settle();

    assert.equal(countOf(mounted.container, 'audit-merge-row'), 0, '旧会话的在途响应不得跨会话落地');
    assert.equal(countOf(mounted.container, 'audit-merge-table'), 0, '旧响应也不得把合并表建出来');
    assert.equal(countOf(mounted.container, 'audit-merge-counts'), 0, '旧响应不得把 mergeLoaded 置 true');
  } finally {
    mounted.unmount();
  }
});

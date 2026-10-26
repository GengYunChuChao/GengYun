/**
 * 最小 SFC 渲染夹具（`apps/admin` 没有 vitest／@vue/test-utils／jsdom，仓内前端测试一律纯 Node）。
 *
 * 三步，与 `tests/unit/admin-ui-post-takedown-render.test.mjs` 的内联版本**逐字同源**：
 *   1. `@vue/compiler-sfc` 把 `.vue` 编成 ESM（`inlineTemplate: true`，关掉静态提升与事件缓存），
 *      并把裸模块说明符换成绝对 URL（`data:` 模块解析不了裸说明符；`.vue` 子组件递归编译）；
 *   2. `vue` 的 `createRenderer()` 造内存宿主，挂**真实组件**、派发真实事件处理器；
 *   3. 网络层由用例注入 `globalThis.fetch` 桩（与被测页面生产路径同一条 `fetch`）。
 *
 * 这里只做「编译 + 挂载 + 找节点 + 派发」，**不断言任何业务结论**——断言留在各 *.test.mjs 里。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

export const VUE_URL = import.meta.resolve('vue');
export const UNIT_DIR = new URL('./', import.meta.url);

if (globalThis.document === undefined) globalThis.document = { activeElement: null };
if (globalThis.Document === undefined) globalThis.Document = class Document {};
if (globalThis.ShadowRoot === undefined) globalThis.ShadowRoot = class ShadowRoot {};

const componentCache = new Map();
const urlCache = new Map();

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

/** 把 `.vue`／`.mjs` 说明符解析成可导入的绝对 URL（`.vue` 递归编译成 `data:` 模块）。 */
async function specifierUrl(spec, baseUrl) {
  if (spec === 'vue') return VUE_URL;
  assert.match(spec, /^\.\.?\//, `编译产物里出现了未处理的裸模块说明符：${spec}`);
  const target = new URL(spec, baseUrl);
  return target.pathname.endsWith('.vue') ? loadComponentUrl(target) : target.href;
}

/**
 * 编译 `.vue` → `data:` 模块 URL（供父 SFC 的 `import` 说明符使用）；`.mjs` 直接给 `file:` URL。
 * 按绝对路径记忆化，重复编译同一子组件不会产生第二份模块。
 */
export async function loadComponentUrl(relativePath) {
  const url = relativePath instanceof URL ? relativePath : new URL(relativePath, UNIT_DIR);
  if (urlCache.has(url.href)) return urlCache.get(url.href);
  const promise = (async () => {
    if (!url.pathname.endsWith('.vue')) return url.href;
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { descriptor, errors } = parse(source, { filename: fileURLToPath(url) });
    assert.deepEqual(errors, [], `${url.pathname} 必须能被 @vue/compiler-sfc 解析`);
    const compiled = compileScript(descriptor, {
      id: `gy-sfc-${url.pathname.replace(/[^a-z0-9]/gi, '-')}`,
      inlineTemplate: true,
      templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
    });
    const specs = [...new Set([...compiled.content.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]))];
    const mapping = new Map();
    for (const spec of specs) mapping.set(spec, await specifierUrl(spec, url));
    const code = compiled.content.replace(
      /from\s+(["'])([^"']+)\1/g,
      (_match, _quote, spec) => `from '${mapping.get(spec) ?? spec}'`,
    );
    assert.deepEqual(
      [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((id) => !/^(data:|file:)/.test(id)),
      [],
      '编译产物里不得残留裸模块说明符（data: 模块无法解析它们）',
    );
    return dataUrl(code);
  })();
  urlCache.set(url.href, promise);
  return promise;
}

/** 编译并导入一个 `.vue` 组件，返回其默认导出（记忆化）。 */
export async function loadComponent(relativePath) {
  const url = relativePath instanceof URL ? relativePath : new URL(relativePath, UNIT_DIR);
  if (componentCache.has(url.href)) return componentCache.get(url.href);
  const promise = (async () => {
    const moduleUrl = await loadComponentUrl(url);
    return (await import(moduleUrl)).default;
  })();
  componentCache.set(url.href, promise);
  return promise;
}

/** 内存宿主：节点足够支撑 Vue 的元素/文本/注释与事件 prop。 */
export function createHost() {
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

/** 挂载真实组件到内存宿主，并把 `app`/`container` 返回给用例。 */
export async function mountComponent(component, props) {
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const app = createApp(component, props);
  app.mount(container);
  await settle();
  return { app, container };
}

/** 等一次渲染 + 一次微任务/宏任务，覆盖 `onMounted` 里的 `await fetch`。 */
export async function settle() {
  await nextTick();
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();
}

export function findBy(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const hit = findBy(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

export function findAll(root, predicate, found = []) {
  if (predicate(root)) found.push(root);
  for (const child of root.children) findAll(child, predicate, found);
  return found;
}

export function textOf(node) {
  if (node === null || node === undefined) return '';
  if (node.kind === '#text') return node.text;
  return node.children.map(textOf).join('');
}

export const byTestId = (id) => (node) => node.props['data-testid'] === id;

/** 按 `data-testid` 找节点；找不到直接报错（比 assert 后接 null 检查更早失败）。 */
export function requireTestId(container, id) {
  const node = findBy(container, byTestId(id));
  assert.ok(node !== null, `找不到 data-testid="${id}" 的节点`);
  return node;
}

/** 往 `<input>`/`<textarea>` 里「打字」：调生产模板挂的 `onInput`。 */
export function typeInto(container, testId, value) {
  const node = requireTestId(container, testId);
  assert.equal(typeof node.props.onInput, 'function', `${testId} 必须挂着 input 处理器`);
  node.props.onInput({ target: { value } });
}

/** 改 `<select>`：调 `onChange`。 */
export function chooseOption(container, testId, value) {
  const node = requireTestId(container, testId);
  assert.equal(typeof node.props.onChange, 'function', `${testId} 必须挂着 change 处理器`);
  node.props.onChange({ target: { value } });
}

/** 提交表单：调 `onSubmit`。 */
export function submitForm(container, testId) {
  const node = requireTestId(container, testId);
  assert.equal(typeof node.props.onSubmit, 'function', `${testId} 必须是挂着 submit 处理器的表单`);
  node.props.onSubmit({ preventDefault() {} });
}

/** 点一下：调 `onClick`。 */
export function clickNode(node) {
  assert.equal(typeof node.props.onClick, 'function', '目标节点必须挂着 click 处理器');
  node.props.onClick({});
}

export function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      return body;
    },
  };
}

/** 记录 `(url, init)` 的 fetch 桩；`handler` 返回 Response 形状即可。 */
export function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  impl.calls = calls;
  return impl;
}

/** 装/卸 `globalThis.fetch`；配合 try/finally 使用。 */
export function withFetch(fetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => {
    globalThis.fetch = original;
  };
}

/** 成功信封 `{data, meta}`。 */
export function envelope(data, requestId = '00000000-0000-4000-9000-000000000001') {
  return { data, meta: { request_id: requestId, contract_version: '1.0.0', execution_mode: 'stub' } };
}

/** 错误信封 `{error:{code,message,retryable}, meta}`。 */
export function errorEnvelope(code, message, retryable = false, executionMode = 'stub') {
  return {
    error: { code, message, retryable, details: [] },
    meta: { request_id: '00000000-0000-4000-9000-0000000000ff', contract_version: '1.0.0', execution_mode: executionMode },
  };
}

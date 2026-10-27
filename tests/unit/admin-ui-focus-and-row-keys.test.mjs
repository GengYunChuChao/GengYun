/**
 * 键盘可达性（审查 R67-B08／B09）：
 *
 *  - **B08**：`apps/admin/src` 此前 `:focus`／`:focus-visible`／`outline` 零命中——键盘用 Tab 走一圈，
 *    屏幕上分不出焦点落在「重试／清除回执／退出登录」哪一颗，因为各页的链接样式按钮都是
 *    `border: 0` + 无外框,浏览器默认焦点环在没有边框的按钮上几乎不可见。修法是在全应用**唯一**的
 *    非 scoped 样式块（`App.vue`）里加一组统一 `:focus-visible`，而不是给 19 个 scoped 样式各抄一份。
 *  - **B09**：11 个视图把 `<tr @click>` 当详情／选中入口，行本身没有 `tabindex`／键处理，
 *    键盘只能撞到行内那颗「详情」按钮，而它自己没挂处理器——能不能进详情全看浏览器把 click 派发给谁。
 *    修法是行级 `tabindex="0"` + Enter/Space（走与 `@click` **同一个**函数）+ 带行标识的 `aria-label`。
 *
 * 为什么样式用源码文本断言、行为用渲染断言：样式规则没有可断言的 DOM 形态（管理端没有 vitest／
 * jsdom，`getComputedStyle` 无从谈起），只能对源文本做结构化断言（按选择器取规则体，不写死行号）；
 * 而「按键真的打开了详情」可以直接挂在 `tests/unit/admin-ui-sfc-harness.mjs` 的内存宿主上，
 * 派发真实的 `onKeydown`、看真实的 `fetch` 调用。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';

import {
  envelope,
  fakeFetch,
  findBy,
  jsonResponse,
  loadComponent,
  mountComponent,
  settle,
  textOf,
  withFetch,
} from './admin-ui-sfc-harness.mjs';

const SOURCE_ID = '00000000-0000-4000-8000-0000000000aa';
const SRC_DIR = new URL('../../apps/admin/src/', import.meta.url);
const VIEWS_DIR = new URL('views/', SRC_DIR);

/** 主色：`.tab.active`／`.primary`／`.link` 早就在用的那个（本片不新增色值）。 */
const PRIMARY = '#0f766e';

/** 行内「详情」按钮与行本身承担**同一个**动作的视图（B09 里的「两个入口」）。 */
const DUPLICATE_ENTRY_VIEWS = [
  'SourcesView.vue',
  'KnowledgeAdminView.vue',
  'RegistrationAdminView.vue',
  'RestrictionAdminView.vue',
  'CategoriesView.vue',
  'ModerationQueueView.vue',
  'AuditEventsView.vue',
  'FlagAuditView.vue',
];

function appSource() {
  return readFileSync(new URL('App.vue', SRC_DIR), 'utf8');
}

function viewSource(file) {
  return readFileSync(new URL(file, VIEWS_DIR), 'utf8');
}

function vueFiles() {
  return readdirSync(VIEWS_DIR).filter((name) => name.endsWith('.vue')).sort();
}

/** 取「含 needle 的那个开标签」的原文（左扩到最后一个 `<`，右扩到第一个 `>`）。 */
function openingTagOf(source, needle) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `源码里找不到片段：${needle}`);
  const start = source.lastIndexOf('<', at);
  const end = source.indexOf('>', at);
  assert.ok(start !== -1 && end > at, `片段 ${needle} 必须落在一个开标签里`);
  return source.slice(start, end + 1);
}

/** 取 SFC 里第一个 `<style>` 块的「开标签 + CSS 正文」。 */
function styleBlockOf(source) {
  const start = source.indexOf('<style');
  assert.notEqual(start, -1, 'SFC 里必须有 <style> 块');
  const bodyStart = source.indexOf('>', start) + 1;
  const end = source.indexOf('</style>', bodyStart);
  assert.notEqual(end, -1, '<style> 块必须闭合');
  return { opening: source.slice(start, bodyStart), css: source.slice(bodyStart, end) };
}

/** 把 CSS 拆成 `{selector, body}`（先去注释；选择器/声明里的换行压成单空格）。 */
function styleRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({
      selector: match[1].trim().replace(/\s+/g, ' '),
      body: match[2].trim().replace(/\s+/g, ' '),
    });
  }
  return rules;
}

function ruleFor(rules, selector) {
  const rule = rules.find((item) => item.selector === selector);
  assert.ok(rule !== undefined, `样式里必须有这条规则：${selector}（现有：${rules.map((item) => item.selector).join(' | ')}）`);
  return rule;
}

/** 某个视图里「含 `@click` 的那个 `<tr>` 开标签」。 */
function clickableRowTagOf(file) {
  const match = [...viewSource(file).matchAll(/<tr\b[^>]*>/gs)].find((item) => item[0].includes('@click'));
  assert.ok(match !== undefined, `${file} 里应当有 <tr @click>`);
  return match[0];
}

/** 每个含 `@click` 的 `<tr>` 开标签（B09 的全部入口）。 */
function clickableRows() {
  const rows = [];
  for (const file of vueFiles()) {
    const source = viewSource(file);
    for (const match of source.matchAll(/<tr\b[^>]*>/gs)) {
      if (!match[0].includes('@click')) continue;
      rows.push({ file, tag: match[0] });
    }
  }
  return rows;
}

/** `<tr>` 上挂的 click／Enter／Space 三处处理函数表达式（用于断言「同一个函数」）。 */
function handlersOf(tag) {
  const read = (pattern) => {
    const match = tag.match(pattern);
    return match === null ? null : match[1];
  };
  return {
    click: read(/(?:^|\s)@click="([^"]+)"/),
    enter: read(/@keydown\.enter\.self\.prevent="([^"]+)"/),
    space: read(/@keydown\.space\.self\.prevent="([^"]+)"/),
  };
}

/** 行节点的键处理在内存宿主里是数组（Enter／Space 各一条），统一摊平成一次性派发。 */
function dispatchKeydown(node, event) {
  const handler = node.props.onKeydown;
  const list = Array.isArray(handler) ? handler : [handler];
  assert.ok(list.length > 0 && list.every((fn) => typeof fn === 'function'), '行必须挂着 keydown 处理器');
  for (const fn of list) fn(event);
}

/**
 * 记一份「有没有被 preventDefault」的探针。
 * 返回值必须是 `undefined`：Vue 的 `.prevent` 修饰符编译成 `e.preventDefault()`，而
 * `withModifiers()` 把**任何真值返回**当成「中止后续处理器」——`() => calls.push(…)` 会返回新长度，
 * 于是处理器根本不会被调用（真浏览器的 `preventDefault()` 返回 undefined，不会有这问题）。
 */
function preventProbe() {
  const calls = [];
  return {
    calls,
    preventDefault() {
      calls.push('prevent');
    },
  };
}

// ── B08：样式落点与焦点规则 ──────────────────────────────────────────────────

test('B08：全应用唯一的非 scoped 样式块在 App.vue，焦点规则必须写在这里', () => {
  const { opening } = styleBlockOf(appSource());
  assert.equal(opening.trim(), '<style>', `App.vue 的样式块必须是非 scoped 的全局块，实际是 ${opening.trim()}`);

  // 各视图都是 scoped：局部规则覆盖不到别人的模板，所以统一焦点样式只能落在全局块里。
  const scoped = vueFiles().filter((file) => /<style\s+scoped/.test(viewSource(file)));
  assert.ok(scoped.length >= 10, `各视图应当仍是 <style scoped>（当前 ${scoped.length} 个）`);
});

test('B08：:focus-visible 给出 2px 主色外框 + 2px 偏移，:focus 兜底，鼠标点击不画框', () => {
  const rules = styleRules(styleBlockOf(appSource()).css);

  for (const selector of [':focus', ':focus-visible']) {
    const rule = ruleFor(rules, selector);
    assert.match(rule.body, new RegExp(`outline: 2px solid ${PRIMARY}`), `${selector} 必须画 2px 主色外框`);
    assert.match(rule.body, /outline-offset: 2px/, `${selector} 必须留 2px 外扩，免得贴住相邻元素`);
  }

  const mouseOnly = ruleFor(rules, ':focus:not(:focus-visible)');
  assert.match(mouseOnly.body, /outline: none/, '鼠标点出来的焦点要关掉外框，否则每次点击都闪一圈');
});

test('B08：程序聚焦容器（tabindex="-1"）只关外框，表格行外框画在内侧', () => {
  const rules = styleRules(styleBlockOf(appSource()).css);

  const container = ruleFor(rules, "[tabindex='-1']:focus, [tabindex='-1']:focus-visible");
  assert.match(container.body, /outline: none/, '程序把焦点搬进容器时不该给整个面板套一圈框');

  const row = ruleFor(rules, 'tr:focus-visible');
  assert.match(row.body, /outline-offset: -2px/, '行外框要画在行框内侧，别被相邻行的下边框裁掉');
});

test('B08：不许用 outline:none 了事——全仓只有那两处允许关外框', () => {
  const rules = styleRules(styleBlockOf(appSource()).css);
  const muted = rules
    .filter((rule) => /outline:\s*(none|0)\b/.test(rule.body))
    .map((rule) => rule.selector)
    .sort();
  assert.deepEqual(
    muted,
    [':focus:not(:focus-visible)', "[tabindex='-1']:focus, [tabindex='-1']:focus-visible"].sort(),
    '除「鼠标焦点」与「程序聚焦容器」外，任何地方都不许把外框关掉',
  );

  for (const file of vueFiles()) {
    assert.doesNotMatch(
      viewSource(file),
      /outline:\s*(none|0)\b/,
      `${file} 的 scoped 样式不得单独关掉外框（统一规则在 App.vue 里）`,
    );
  }
});

// ── B09：表格行的键盘语义 ────────────────────────────────────────────────────

test('B09：SourcesView 的表格行带 tabindex / Enter+Space 键处理 / 带行标识的 aria-label', () => {
  const source = viewSource('SourcesView.vue');
  const row = openingTagOf(source, '@click="openDetail(row.id)"');

  assert.match(row, /\stabindex="0"/, '行必须能被 Tab 聚焦');
  assert.match(row, /@keydown\.enter\.self\.prevent="openDetail\(row\.id\)"/, 'Enter 必须走行级入口');
  assert.match(row, /@keydown\.space\.self\.prevent="openDetail\(row\.id\)"/, 'Space 必须走行级入口');
  assert.match(row, /:aria-label="[^"]*\$\{row\.id\}/, 'aria-label 必须带行标识（不能只写「详情」）');
  assert.match(row, /:aria-label="[^"]*row\.title/, 'aria-label 要说清打开的是哪一行');
  assert.doesNotMatch(row, /role="button"/, '<tr> 保留隐式 row 语义，不冒充 button');
});

test('B09：11 个视图里凡是 <tr @click> 都补齐了 tabindex + Enter/Space + 行标识', () => {
  const rows = clickableRows();
  assert.ok(rows.length >= 11, `含 @click 的 <tr> 至少 11 个（当前 ${rows.length}）`);

  for (const { file, tag } of rows) {
    assert.match(tag, /\stabindex="0"/, `${file} 的行必须能被 Tab 聚焦`);
    const handlers = handlersOf(tag);
    assert.ok(handlers.click !== null, `${file} 的行应当保留 @click`);
    assert.equal(handlers.enter, handlers.click, `${file} 的 Enter 必须走与 @click 同一个处理函数`);
    assert.equal(handlers.space, handlers.click, `${file} 的 Space 必须走与 @click 同一个处理函数`);
    assert.match(tag, /:aria-label="[^"]*row\./, `${file} 的行必须有含行标识的 aria-label`);
  }
});

test('B09：行内「详情」按钮自己挂处理器，且与行同一个动作（不靠冒泡侥幸）', () => {
  for (const file of DUPLICATE_ENTRY_VIEWS) {
    const source = viewSource(file);
    const row = clickableRowTagOf(file);
    const { click } = handlersOf(row);
    assert.ok(click !== null, `${file} 的行应当保留 @click`);

    const own = [...source.matchAll(/@click\.stop="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(
      own.includes(click),
      `${file} 的行内按钮必须自己挂 @click.stop="${click}"（现有：${own.join(' | ') || '无'}）`,
    );
  }
});

test('B09：改过的 SFC 全部过得去 @vue/compiler-sfc 编译门', () => {
  const files = ['App.vue', ...vueFiles()];
  for (const file of files) {
    const source = readFileSync(new URL(file, file === 'App.vue' ? SRC_DIR : VIEWS_DIR), 'utf8');
    const { descriptor, errors } = parse(source, { filename: file });
    assert.deepEqual(errors, [], `${file} 必须能被 @vue/compiler-sfc 解析`);
    const compiled = compileScript(descriptor, { id: `gy-focus-${file.replace(/[^a-z0-9]/gi, '-')}` });
    assert.ok(compiled.content.length > 0, `${file} 的 <script> 必须能编译`);
    if (descriptor.template !== null) {
      const template = compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id: `gy-focus-${file.replace(/[^a-z0-9]/gi, '-')}`,
      });
      assert.deepEqual(template.errors, [], `${file} 的模板必须能编译`);
    }
  }
});

// ── B09：键盘真的能打开详情（渲染级） ────────────────────────────────────────

/** 一页资料来源（字段与 `admin-ui-sources-receipt-render.test.mjs` 的夹具同构）。 */
function sourceDraft() {
  return {
    id: SOURCE_ID,
    revision: 2,
    visibility: 'private',
    source: {
      id: SOURCE_ID,
      version: '2026.1',
      title: '稻田稗草抗性监测',
      url: 'https://example.test/source',
      publisher: '示例农科院',
      source_kind: 'database',
      evidence_kind: 'research',
      validity: 'valid',
      review_status: 'verified',
      updated_at: '2026-10-01T00:00:00.000Z',
    },
  };
}

/** 列表回一页、详情回单条；`calls` 里记下真实请求（GET 方法与 URL）。 */
function pageFetch() {
  const detail = sourceDraft();
  const impl = fakeFetch(({ url, init }) => {
    const method = init?.method ?? 'GET';
    return url.includes(`/admin/sources/${SOURCE_ID}`)
      ? jsonResponse(200, envelope(detail), { etag: '"2"' })
      : jsonResponse(200, envelope({ items: [detail], next_cursor: null }));
  });
  return {
    impl,
    reads: () => impl.calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`),
    detailCalls: () => impl.calls.filter((call) => call.url.includes(`/admin/sources/${SOURCE_ID}`)).length,
  };
}

async function mountSources() {
  const component = await loadComponent('../../apps/admin/src/views/SourcesView.vue');
  const { container } = await mountComponent(component, {
    baseUrl: '/api/v1',
    token: 'synthetic-admin-token',
    scopes: ['sources:read', 'sources:write'],
  });
  const row = findBy(container, (node) => node.kind === 'tr' && typeof node.props.onClick === 'function');
  assert.ok(row !== null, '表格里必须有一行可点');
  return { container, row };
}

test('B09：行节点带上 tabindex / aria-label / keydown，@click 仍然在（既有用例靠它找行）', async () => {
  const page = pageFetch();
  const restore = withFetch(page.impl);
  try {
    const { row } = await mountSources();
    assert.equal(row.props.tabindex, '0', '行必须可聚焦');
    assert.equal(row.props['aria-label'], `打开资料来源《稻田稗草抗性监测》详情（${SOURCE_ID}）`);
    assert.equal(typeof row.props.onClick, 'function', '行必须保留 click 处理器');
    dispatchKeydown(row, { key: 'Enter', target: row, currentTarget: row, preventDefault() {} });
  } finally {
    restore();
  }
});

test('B09：Enter 与 Space 真的打开详情，与鼠标点击走同一条请求路径', async () => {
  const expected = `GET /api/v1/admin/sources/${SOURCE_ID}`;

  for (const key of ['Enter', ' ']) {
    const page = pageFetch();
    const restore = withFetch(page.impl);
    try {
      const { row } = await mountSources();
      assert.equal(page.detailCalls(), 0, '进页面时不该先拉详情');
      const probe = preventProbe();
      dispatchKeydown(row, { key, target: row, currentTarget: row, preventDefault: probe.preventDefault });
      await settle();
      assert.deepEqual(probe.calls, ['prevent'], `${JSON.stringify(key)} 必须 preventDefault（否则 Space 会滚页、行内按钮会二次激活）`);
      assert.equal(page.detailCalls(), 1, `${JSON.stringify(key)} 必须打开详情`);
      assert.equal(page.reads().at(-1), expected);
      assert.match(String(row.props.class), /selected/, '打开后该行要落到选中态');
    } finally {
      restore();
    }
  }

  // 鼠标点击：同一行、同一个处理函数、同一个请求。
  const page = pageFetch();
  const restore = withFetch(page.impl);
  try {
    const { row } = await mountSources();
    row.props.onClick({});
    await settle();
    assert.equal(page.reads().at(-1), expected, '键盘与鼠标必须落到同一条请求上');
  } finally {
    restore();
  }
});

test('B09：.self 闸门挡住了行内按钮冒泡上来的 Enter，不会重复开详情', async () => {
  const page = pageFetch();
  const restore = withFetch(page.impl);
  try {
    const { row } = await mountSources();
    const button = findBy(row, (node) => node.kind === 'button' && textOf(node).trim() === '详情');
    assert.ok(button !== null, '行内应当还有那颗「详情」按钮');

    const bubble = preventProbe();
    dispatchKeydown(row, { key: 'Enter', target: button, currentTarget: row, preventDefault: bubble.preventDefault });
    await settle();
    assert.deepEqual(bubble.calls, [], '冒泡上来的按键不该被行拦下（否则行内按钮自己按 Enter 会被吃掉默认行为）');
    assert.equal(page.detailCalls(), 0, '这次按键属于行内按钮，行不该替它开详情');

    // 行内按钮自己有处理器：点一下只发一次请求（不靠冒泡、也不重复）。
    button.props.onClick({ stopPropagation() {} });
    await settle();
    assert.equal(page.detailCalls(), 1, '行内按钮点一次只该开一次详情');
  } finally {
    restore();
  }
});

test('B09：与入口无关的按键既不拦默认行为也不发请求', async () => {
  const page = pageFetch();
  const restore = withFetch(page.impl);
  try {
    const { row } = await mountSources();
    const other = preventProbe();
    dispatchKeydown(row, { key: 'a', target: row, currentTarget: row, preventDefault: other.preventDefault });
    await settle();
    assert.deepEqual(other.calls, [], '字母键不该被拦');
    assert.equal(page.detailCalls(), 0, '字母键不该开详情');
  } finally {
    restore();
  }
});

// #1020 历史详情页 + 收藏入口：候选 `species_id` 的**展示文本**改成中文组名，查不到回落原始 id。
//
// 这不是真机 / 微信开发者工具证据：用模块替身驱动页面与组件的投影函数，只证明三件事：
//   * 目录内 id（`species_barnyardgrass`）→ 中文组名，名字来自 `miniprogram/utils/reference.js`
//     的 species 索引（目录字段 `group_name`），**不是**本文件或被测文件里写死的中文表；
//   * 目录外 id → 展示回落**原始 id 本身**（不是空串、不是 `undefined`、不是「未知物种」类新文案）；
//   * 绑定/键位没被展示文本顶替：`species_id`、`speciesId`、`wx:key` 仍指向原始 id。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');

/** 仓库内相对路径 → 归一化绝对路径（Windows 反斜杠统一成正斜杠，便于做替身键）。 */
function p(rel) { return resolve(root, rel).replace(/\\/g, '/'); }

const PAGE_JS = p('miniprogram/pages/historydetail/historydetail.js');
const PAGE_WXML = p('miniprogram/pages/historydetail/historydetail.wxml');
const COMPONENT_JS = p('miniprogram/components/fav-entry/fav-entry.js');

// 目录内真实物种（`miniprogram/data/species.js` 是 packages/knowledge 目录的构建产物，禁手改）。
const KNOWN_ID = 'species_barnyardgrass';
const KNOWN_NAME = '稗草';
// 目录外 id：UUID 形态（能过 fav-entry 的 UUID 闸门）但 species 目录里没有它。
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const JOB = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';

/**
 * 装配模块加载器：`stubs` 里的路径直接返回替身，其余按 CommonJS 语义在 vm 里真加载
 * （`utils/reference.js` 与其 data 依赖都走真文件 —— 中文名必须来自真实目录）。
 * `append` 允许在某个模块源码末尾追加探针，用来读到不对外导出的内部函数。
 */
function makeLoader({ stubs, append, fail }) {
  const cache = new Map();
  const defs = {};
  function load(path) {
    const key = resolve(path).replace(/\\/g, '/');
    // `fail` 模拟目录装载失败（模块解析/构建缺件）：被测代码必须吞掉并按「查不到」兜底。
    if (fail && fail.indexOf(key) !== -1) throw new Error('synthetic module failure: ' + key);
    if (Object.prototype.hasOwnProperty.call(stubs, key)) return stubs[key];
    if (cache.has(key)) return cache.get(key).exports;
    const m = { exports: {} };
    cache.set(key, m);
    const tail = append && append[key] ? '\n' + append[key] : '';
    const source = readFileSync(key, 'utf8') + tail;
    const factory = vm.runInNewContext(
      '(function(require,module,Component,Page){' + source + '\n})',
      { wx: {}, console: console }
    );
    factory(
      // reference.js 已有带扩展名的 `require('../data/crops.js')`，两种写法都要吃得下。
      (id) => load(resolve(dirname(key), /\.js$/.test(id) ? id : id + '.js')),
      m,
      (d) => { defs[key] = d; return d },
      (d) => { defs[key] = d; return d }
    );
    return m.exports;
  }
  return { load, defs };
}

/** 候选夹具：一条目录内 slug、一条目录外 UUID（`rank` 是 wxml 的 wx:key）。 */
function candidates() {
  return [
    { species_id: KNOWN_ID, rank: 1, scoreText: '0.92' },
    { species_id: UNKNOWN_ID, rank: 2, scoreText: '0.31' }
  ];
}

/** 挂载 `pages/historydetail`：只替身页面直接依赖的 5 个模块，其余真加载。 */
async function mountPage(options) {
  const rows = candidates();
  const stubs = {};
  stubs[p('miniprogram/utils/font-scale.js')] = { DEFAULT_FONT_SCALE: 1, applyFontScale: function () {} };
  stubs[p('miniprogram/utils/auth.js')] = { networkEnabled: function () { return true }, requireLogin: function (cb) { cb(true) } };
  stubs[p('miniprogram/utils/page-gate.js')] = { start: function (page, cb) { cb(true) }, cancel: function () {} };
  stubs[p('miniprogram/utils/history-api.js')] = {
    PAGE_LIMIT_MAX: 50,
    parseDetailQuery: function () { return { id: JOB, valid: true, ignored: [] } },
    locateHistory: async function () {
      return {
        id: JOB, kind: 'recognition', targetId: REC, jobState: 'succeeded',
        referenceState: 'available', locatedBy: 'live',
        createdAt: '2026-11-01T00:00:00.000Z', historyRevision: 3
      };
    },
    recognitionDetailView: function () {
      return {
        recognized: true,
        modelCandidates: rows.slice(),
        modelCandidateNote: '',
        manualSelection: null,
        uncertaintyReasons: [],
        sourceVersion: 'gy-model-1',
        raw: null,
        corrected: null,
        correctedDiffers: false,
        verification: null,
        doseSafetyNote: ''
      };
    }
  };
  stubs[p('miniprogram/utils/identify-api.js')] = {
    describeJobState: function () { return { title: '识别完成', desc: '', tone: 'ok' } },
    getRecognition: async function () { return { recognition: { id: REC, revision: 2, candidates: rows.slice() } } }
  };
  const { load, defs } = makeLoader({ stubs: stubs, append: null, fail: (options && options.fail) || null });
  load(PAGE_JS);
  const def = defs[PAGE_JS];
  assert.ok(def && typeof def.load === 'function', '页面定义未装载');
  // 直接调 load()：跳过 onShow/pageGate/login（与「点进来就是已登录本地读数」同形），
  // 只读它把 recognitionDetailView 的候选投影进 data 的那一段。
  const page = Object.assign({}, def, {
    data: JSON.parse(JSON.stringify(def.data || {})),
    setData(patch) { Object.assign(this.data, patch) }
  });
  page._query = { id: JOB, valid: true, ignored: [] };
  page._epoch = 0;
  await page.load();
  return { page: page, rows: rows };
}

/** 挂载 `components/fav-entry`：替身 3 个依赖，并把内部 `speciesNameOf` 探针取出。 */
function mountComponent(options) {
  const stubs = {};
  stubs[p('miniprogram/utils/identify-api.js')] = { describeJobState: function () { return { title: '识别完成', desc: '', tone: 'ok' } } };
  stubs[p('miniprogram/utils/favorites-api.js')] = { listFavorites: async function () { return { items: [] } } };
  stubs[p('miniprogram/utils/knowledge-api.js')] = {
    // 服务端 detail 一定带非空 title（knowledge-api.js:46/:49-50 校验），这里照抄该形状。
    detail: async function (id) {
      const title = options && typeof options.title === 'string' ? options.title : '稗草';
      return { item: { id: id, type: 'species', revision: 5, title: title } };
    }
  };
  const { load, defs } = makeLoader({ stubs: stubs, append: null });
  load(COMPONENT_JS);
  const def = defs[COMPONENT_JS];
  assert.ok(def && def.methods && typeof def.methods.resolve === 'function', '组件定义未装载');
  return { def: def };
}

test('目录内 id → 中文组名来自 reference.js 的 species 索引（group_name），不是写死表', function () {
  const { load } = makeLoader({ stubs: {}, append: null });
  const reference = load(p('miniprogram/utils/reference.js'));
  const entry = (reference.species || []).filter(function (s) { return s && s.id === KNOWN_ID })[0];
  assert.ok(entry, '真实物种目录缺少夹具 id：' + KNOWN_ID);
  assert.equal(entry.group_name, KNOWN_NAME);
  assert.equal(typeof entry.name_cn, 'undefined', '目录字段是 group_name，不是 name_cn');
});

test('历史详情页：候选带 speciesName，目录内取中文名、目录外留空串且 species_id 原样', async function () {
  const mounted = await mountPage();
  const shown = mounted.page.data.modelCandidates;
  assert.equal(shown.length, 2);
  // 目录内：多出一个展示字段，中文名取自目录。
  assert.equal(shown[0].species_id, KNOWN_ID, '绑定 id 不得被中文名顶替');
  assert.equal(shown[0].speciesName, KNOWN_NAME);
  // 目录外：空串（由 wxml 的 `||` 回落），并保留原始字段。
  assert.equal(shown[1].species_id, UNKNOWN_ID);
  assert.equal(shown[1].speciesName, '');
  // 页面实际显示的文本 = wxml 的 `{{item.speciesName || item.species_id}}`。
  assert.equal(shown[1].speciesName || shown[1].species_id, UNKNOWN_ID, '未知 id 必须回落原始 id');
  // 夹具其余字段不被顺手改写。
  assert.equal(shown[1].rank, 2);
  assert.equal(shown[1].scoreText, '0.31');
});

test('收藏入口：resolve 用资料标题当 label（UUID 真通路），取不到标题才回落原始 id', async function () {
  const mounted = mountComponent();
  const resolveFn = mounted.def.methods.resolve;
  // 既有 UUID 闸门不变：slug 形态仍被丢弃，本 PR 不放宽它。
  const known = await resolveFn.call({}, [{ species_id: KNOWN_ID, rank: 1 }], {});
  assert.equal(known.length, 0, 'slug 形态仍被既有 UUID 闸门丢弃（未放宽）');
  // UUID 候选走真实通路：label 取 knowledgeApi.detail 返回的 item.title。
  const items = await resolveFn.call({}, [{ species_id: UNKNOWN_ID, rank: 2 }], {});
  assert.equal(items.length, 1);
  assert.equal(items[0].speciesId, UNKNOWN_ID, '绑定键仍是原始 id');
  assert.equal(items[0].label, '稗草', 'label 取资料标题，不再回落 UUID 原文');
  // 服务端没给标题时回落原始 id，不出现空串/undefined。
  const noTitle = await mountComponent({ title: '' }).def.methods.resolve.call({}, [{ species_id: UNKNOWN_ID, rank: 3 }], {});
  assert.equal(noTitle[0].label, UNKNOWN_ID, '没有标题时回落原始 id');
});


test('历史详情页：物种目录装载失败时不抛错，留空串由 wxml 回落原始 id', async function () {
  const mounted = await mountPage({ fail: [p('miniprogram/data/species.js')] });
  const shown = mounted.page.data.modelCandidates;
  assert.equal(shown.length, 2, '目录失败不得打断候选投影');
  assert.equal(shown[0].speciesName, '', '取不到名字只留空串，不编造文案');
  assert.equal(shown[0].speciesName || shown[0].species_id, KNOWN_ID);
});

test('静态锁：wxml/组件不再把原始 id 直接当展示文案，且中文名不写死在代码里', function () {
  const wxml = readFileSync(PAGE_WXML, 'utf8');
  assert.match(wxml, /\{\{item\.speciesName \|\| item\.species_id\}\}/, 'wxml 必须走中文名兜底表达式');
  assert.doesNotMatch(wxml, /\{\{item\.species_id\}\}/, 'wxml 不得再裸渲染 species_id');
  assert.match(wxml, /wx:key="rank"/, '候选列表 key 未变');

  const component = readFileSync(COMPONENT_JS, 'utf8');
  assert.match(component, /label: \(title \|\| speciesId\),/, 'label 必须走标题兜底');
  assert.doesNotMatch(component, /label: speciesId,/, '组件不得再把原始 id 当 label');
  assert.doesNotMatch(component, /speciesNameOf/, '组件不再保留未生效的目录查表 helper');
  assert.match(component, /title = typeof item\.title === 'string'/, '标题必须来自 knowledgeApi.detail 的 item.title');

  const page = readFileSync(PAGE_JS, 'utf8');
  assert.match(page, /speciesName: name\b/, '页面要给候选补 speciesName');
  assert.match(page, /const s = \(require\('\.\.\/\.\.\/data\/species'\)\.species \|\| \[\]\)/, '页面只引 3.8KB 物种目录，不引 474KB 的 reference.js');
  assert.match(page, /catch \(error\) \{ name = '' \}/, '目录装载失败必须吞掉并留空串（回落原始 id）');
  // 硬约束：不自己写死物种中文名映射表。
  assert.doesNotMatch(page + component, /require\('\.\.\/\.\.\/utils\/reference'\)/, '不得再为物种名拉进 reference.js');
  for (const file of [page, component]) {
    assert.doesNotMatch(file, /稗草|狗尾草|牛筋草/, '不得把物种中文名写死在页面/组件里');
  }
});

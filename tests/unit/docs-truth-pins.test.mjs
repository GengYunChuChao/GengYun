// 「文档说真话」的机器钉子（R67-A2）。
//
// 背景：`docs/architecture/ai-ops-spec-status.md` 曾是「24 个错误码」「后台无入口」「`target_ref.revision`
// 恒取 1」三处假陈述的产地，2026-10-27 由 R67-A1 改正（提交 1a8af906）。这三类假话都是「读起来像事实、
// 但没人真去核」的产物，只靠人眼复读守不住——所以这里把它们翻成可执行的断言：
//
//   a. 错误码计数双向相等（代码侧逐档等于 `packages/contracts/states.json` 的 error_status_map，
//      页面侧写的「N 码」必须等于代码实数；两边都不钉死具体数字），d 另钉 `/admin/posts` 家族条数；
//   b. 「后台无页面消费」这一族断言不许复活；
//   c. `target_ref.revision` 不许再写成恒 1，且页面必须给出真值锚点、该锚点必须真的还是真值取用。
//
// 本文件只读仓库里的文本/JSON，不联网、不起 PG、不写任何文件，可以在任何 Node 上单跑。
//
// 关于 `apps/admin/src/lib/admin-contract.mjs` 的 24：那是 B01（管理端镜像片）的已登记差异，属另一片的
// 范围，**本文件不钉它**。这里钉的是服务端单源（services/api/src/contract.ts）与架构页的读数一致。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (relativePath) => readFileSync(join(REPO_ROOT, relativePath), 'utf8');
const toLines = (text) => text.split('\n');

/** 仓库相对路径 → 源码行数组；报错时带上路径，免得只看到行号。 */
function sourceLines(relativePath) {
  return toLines(read(relativePath));
}

// ---------------------------------------------------------------------------
// 共用：撤回句剥离
// ---------------------------------------------------------------------------

// 「原写「后台无入口」为误」这类句子是在**引用**旧陈述并说明它错了，不是新陈述。剥掉引号内容再判，
// 否则每修一处假话就要顺手删掉「它曾经错在哪」这段最有价值的信息。
const RETRACTION_QUOTE = /(?:原写|原文|旧稿|早先写作)「[^」]*」为误/g;

/**
 * 把一行里的撤回引号整段剥掉。
 * 剥离后可能只剩空白或标点，调用方据此决定「不判」（见 hasStatement）。
 */
export function stripRetractions(line) {
  return line.replace(RETRACTION_QUOTE, '');
}

/** 剥完撤回引号后是否还剩一句实质陈述；只剩标点/空白就当作「本行没有现陈述」。 */
export function hasStatement(line) {
  return stripRetractions(line).replace(/[\s`|·、，。；：（）()【】「」\-—>→/]/g, '').length > 0;
}

/** 收集页面里命中某正则的现陈述行（已剥撤回引号），带行号与原行原文供报错打印。 */
function findStatements(lines, pattern) {
  const hits = [];
  for (const [index, line] of lines.entries()) {
    if (!hasStatement(line)) continue;
    const stripped = stripRetractions(line);
    if (pattern.test(stripped)) hits.push({ line: index + 1, text: line });
    pattern.lastIndex = 0;
  }
  return hits;
}

function formatHits(hits) {
  return hits.map((hit) => `第 ${hit.line} 行：${hit.text}`).join('\n');
}

// ---------------------------------------------------------------------------
// a. 错误码计数双向相等
// ---------------------------------------------------------------------------

const CONTRACT_PATH = 'services/api/src/contract.ts';
const PAGE_PATH = 'docs/architecture/ai-ops-spec-status.md';

/** 从 contract.ts 里抽出 ERROR_STATUS_MAP 的源码块（到 `} as const;` 收尾，不能只认 `};`）。 */
function readErrorStatusMapBlock() {
  const source = read(CONTRACT_PATH);
  const match = source.match(/export const ERROR_STATUS_MAP = \{([\s\S]*?)\} as const;/);
  assert.ok(match, `${CONTRACT_PATH} 里找不到 ERROR_STATUS_MAP 的 {...} as const 块；锚点身份变了，需人工重定位`);
  return match[1];
}

function readErrorCodeFacts() {
  const block = readErrorStatusMapBlock();
  const statuses = [...block.matchAll(/^\s*(\d{3}):\s*\[/gm)].map((match) => Number(match[1]));
  const codes = [...block.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]);
  return { statuses, codes, uniqueCodes: [...new Set(codes)] };
}

describe('钉 a：错误码计数双向相等', () => {
  test('代码侧：ERROR_STATUS_MAP 逐档等于契约 states.json 的 error_status_map（档数与码数都从契约数出来，不钉死数字）', () => {
    const { statuses, codes, uniqueCodes } = readErrorCodeFacts();

    // 期望值不再写死「27 码 / 12 档」：档位集合与每档码集都从契约事实源数出来。
    // 这比「条数相等」更强——服务端镜像少一档、多一码、或把码挂到错的状态档都会红，
    // 而条数相同的错法（例如 429 与 500 各少一个码）不会被条数钉发现。
    const states = JSON.parse(read('packages/contracts/states.json'));
    const contractMap = states.error_status_map;
    const contractStatuses = Object.keys(contractMap).map(Number);
    const pairs = [...readErrorStatusMapBlock().matchAll(/^\s*(\d{3}):\s*\[([\s\S]*?)\]/gm)]
      .map((match) => [match[1], [...match[2].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((item) => item[1])]);
    assert.deepEqual(
      Object.fromEntries(pairs),
      contractMap,
      'ERROR_STATUS_MAP 与契约 states.json 的 error_status_map 必须逐档相等（档位、每档码集、码的归属）',
    );

    assert.deepEqual(statuses, contractStatuses, `状态档集合应与契约一致，实际 ${statuses.join('/')}`);
    assert.deepEqual(uniqueCodes, [...new Set(Object.values(contractMap).flat())], '去重后的错误码集合应与契约一致');
    // 「摊平去重」才是真读数：ERROR_CODES = Object.values(ERROR_STATUS_MAP).flat()，
    // 同一码若挂在两个状态档下会被 flat() 摊出来两次，所以还要单独钉「不跨档重复登记」。
    assert.equal(codes.length, uniqueCodes.length, `ERROR_STATUS_MAP 里出现了重复登记的码：${codes.join(', ')}`);
    assert.ok(uniqueCodes.length > 0 && contractStatuses.length > 0, '契约错误码映射读成空集：下面的相等没有意义');

    // 与派生常量对拍：ERROR_CODES 就是摊平结果，不是另一份手写清单。
    const source = read(CONTRACT_PATH);
    assert.match(source, /export const ERROR_CODES = Object\.values\(ERROR_STATUS_MAP\)\.flat\(\);/);
    assert.match(source, /const ERROR_CODE_STATUS: ReadonlyMap<string, number> = new Map\(/);
  });

  test('页面侧：写的「错误码单源 N 码」与代码实数一致（改成任何别的数字都必须红）', () => {
    const { uniqueCodes } = readErrorCodeFacts();
    const expected = uniqueCodes.length;
    const lines = sourceLines(PAGE_PATH);

    const singleSource = [];
    const gapRow = [];
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(/错误码单源\s*(\d+)\s*码/g)) {
        singleSource.push({ line: index + 1, value: Number(match[1]), text: line });
      }
      for (const match of line.matchAll(/恰好\s*(\d+)\s*个错误码/g)) {
        gapRow.push({ line: index + 1, value: Number(match[1]), text: line });
      }
    }

    assert.ok(singleSource.length > 0, `${PAGE_PATH} 里找不到「错误码单源 N 码」这句读数；读数被删掉也算信息丢失，需人工确认`);
    assert.ok(gapRow.length > 0, `${PAGE_PATH} 里找不到「恰好 N 个错误码」这句读数`);

    for (const hit of [...singleSource, ...gapRow]) {
      assert.equal(
        hit.value,
        expected,
        `第 ${hit.line} 行写的错误码数与 ${CONTRACT_PATH} 的实数不符：页面 ${hit.value} / 代码 ${expected}\n${hit.text}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// b. 「后台无页面消费」不许复活
// ---------------------------------------------------------------------------

// 目标只是「后台没有页面在读这个读面」这一族断言。注意 `无入口` 单独出现多半是**真话**：
//   · `docs/architecture/admin-console-capability-map.md:17`／`:210`「后端有面、UI 无入口 12 个 operation」；
//   · `docs/architecture/README.md:21`「UI 有入口 32 个、无入口 12 个」。
// 反例（已不再成立）：ai-ops 页原 P08「库侧过滤能力无入口」与同页 :221「能力无入口」——#694 已把
// `state`／`error_code` 筛选接到作业台页面（该页 E41），所以这两句不再是现状。
// 所以正则必须带「后台/页面消费」这层限定，不能把「无入口」当禁词；否则等于用假绿灯换真话。
const FORBIDDEN_NO_PAGE_CONSUMER = /无页面消费|后台(?:仍|也|端|侧)?(?:没有|无)(?:页面)?入口/;

describe('钉 b：「后台无页面消费」这一族断言不许复活', () => {
  test('架构页不得再断言后台没有页面消费该读面', () => {
    const hits = findStatements(sourceLines(PAGE_PATH), FORBIDDEN_NO_PAGE_CONSUMER);
    assert.deepEqual(
      hits,
      [],
      [
        `${PAGE_PATH} 又出现了「后台无页面消费／后台无入口」这一族断言（真值：apps/admin/src/views/AuditLogsView.vue 已在消费 GET /admin/audit-logs，见 P10）：`,
        formatHits(hits),
        '若这是引用旧陈述，请写成「原写「…」为误」的撤回句；若是新判断，请先核实页面是否真的没有入口。',
      ].join('\n'),
    );
  });

  test('真话不受牵连：「能力无入口」「三读面读数已在页面层合并」仍然可以写', () => {
    // 正向控制：这两句只是正则的负控制（「无入口」单独出现不是禁词）；页面里仍在的真话是 P10 的「三读面读数已在页面层合并」。
    assert.doesNotMatch('库侧过滤能力无入口', FORBIDDEN_NO_PAGE_CONSUMER);
    assert.doesNotMatch('能力无入口：后台 UI 的列表 URL 只 set `limit` 与 `cursor`', FORBIDDEN_NO_PAGE_CONSUMER);
    const page = read(PAGE_PATH);
    assert.match(page, /三读面读数已在页面层合并/);
  });
});

// ---------------------------------------------------------------------------
// c. `target_ref.revision` 不许再写成恒 1
// ---------------------------------------------------------------------------

const JOBS_PG_PATH = 'services/api/src/admin/ops/jobs-pg.ts';
const REVISION_CONSTANT = /恒取\s*1|恒\s*1/;

describe('钉 c：target_ref.revision 不许再写成恒 1', () => {
  test('页面不得再写「恒取 1」／「恒 1」', () => {
    const hits = findStatements(sourceLines(PAGE_PATH), REVISION_CONSTANT);
    assert.deepEqual(
      hits,
      [],
      [
        `${PAGE_PATH} 又出现了「target_ref.revision 恒取 1／恒 1」（真值：${JOBS_PG_PATH}:413 是 targetRevision ?? UNCREATED_RECORD_REVISION，只有记录尚未创建时才退回 1）：`,
        formatHits(hits),
      ].join('\n'),
    );
  });

  test('页面必须给出真值锚点（行号按源码实时定位，不写死）', () => {
    // ⛔ 不许在这里写死 `jobs-pg.ts:413`：`tests/unit/test-line-anchors-guard.test.mjs` 会判红
    //（「断言里不许写死 源文件:行号」）。按源码实时定位——这也是本片对别人的要求。
    const anchorLine = sourceLines(JOBS_PG_PATH)
      .findIndex((line) => /revision:\s*targetRevision\s*\?\?/.test(line)) + 1;
    assert.ok(anchorLine > 0, `${JOBS_PG_PATH} 里找不到「revision: targetRevision ??」那行赋值，锚点前提没了`);
    const page = read(PAGE_PATH);
    assert.match(
      page,
      new RegExp(`jobs-pg\\.ts:${anchorLine}`),
      `${PAGE_PATH} 里找不到真值锚点 jobs-pg.ts:${anchorLine}（这个行号是按源码实时定位算出的；把锚点删掉等于让「恒 1」无处对质）`,
    );
  });

  test('锚点必须仍然指在真值取用上（文件行数变动请去文本重定位，不要只改数字）', () => {
    const lines = sourceLines(JOBS_PG_PATH);
    // GY-R71（2026-10-30）：这个文件的台账写入点让 `toAdminJobView` 整块下移，原来冻死的
    // 「410-420」窗口不再覆盖那行赋值。窗口改为**按符号实时定位**（与上一条用例同一口径）：
    // 判据从「数字落在某个固定区间」变成「窗口绕着那行赋值展开」，文件再长也不会假红；
    // 而「页面里写的行号必须等于它」这条约束仍由上面那条用例把住，不会因为窗口变活而放宽。
    const anchorIndex = lines.findIndex((line) => /revision:\s*targetRevision\s*\?\?/.test(line));
    assert.ok(
      anchorIndex >= 0,
      `${JOBS_PG_PATH} 里找不到「revision: targetRevision ??」那行赋值：真值取用点没了，本钉子的前提已失效`,
    );
    const window = lines.slice(Math.max(0, anchorIndex - 4), anchorIndex + 5);
    const joined = window.join('\n');

    assert.match(
      joined,
      /targetRevision|UNCREATED_RECORD_REVISION/,
      [
        `${JOBS_PG_PATH}:${anchorIndex + 1} 附近既没有 targetRevision 也没有 UNCREATED_RECORD_REVISION——`,
        '说明这个文件的形状变了（插入/删除了代码），锚点已失效。',
        '处理办法：去文本重定位——在文件里搜索「revision: targetRevision ??」这行赋值，把页面里的行号改成它的真实行号；',
        '⛔ 不要只把数字挪 1-2 行凑过校验，那等于用假锚点换绿。',
      ].join('\n'),
    );
    assert.match(joined, /revision:\s*targetRevision\s*\?\?/);
  });
});

// ---------------------------------------------------------------------------
// d. `/admin/posts` 家族条数
// ---------------------------------------------------------------------------

const OPERATIONS_PATH = 'packages/contracts/operations.json';
const OPENAPI_PATH = 'packages/contracts/openapi.json';
const ADMIN_POSTS_IDS = ['approvePost', 'getAdminPost', 'hidePost', 'listAdminPosts', 'rejectPost'];

// 窄口子：只抓「该家族恰好/只有一条操作」这类单条断言。`getAdminPost` 里「一条帖子的管理视图」
// 指的是单条资源，不是「家族只有一条操作」，不能被误伤。
const SINGLE_OPERATION_CLAIM = /恰好[一1两二]条|只有[一1]条|仅[一1]条|唯一(?:的)?(?:一条|操作)|只(?:暴露|提供|有)[一1]个操作/;

describe('钉 d：/admin/posts 家族条数', () => {
  test('契约里 /admin/posts 前缀恰好 5 条操作，id 集合固定', () => {
    const contract = JSON.parse(read(OPERATIONS_PATH));
    const operations = contract.operations;
    assert.ok(Array.isArray(operations), `${OPERATIONS_PATH} 的 operations 不是数组`);

    const family = operations.filter((operation) => typeof operation.path === 'string' && operation.path.startsWith('/admin/posts'));
    assert.equal(family.length, 5, `/admin/posts 家族应有 5 条操作，实际 ${family.length}：${family.map((operation) => operation.id).join(', ')}`);
    assert.deepEqual(
      family.map((operation) => operation.id).sort(),
      ADMIN_POSTS_IDS,
      `/admin/posts 家族的 operation id 集合变了：${family.map((operation) => operation.id).sort().join(', ')}`,
    );
    assert.deepEqual(
      family.map((operation) => `${operation.method.toUpperCase()} ${operation.path}`).sort(),
      [
        'GET /admin/posts',
        'GET /admin/posts/{id}',
        'POST /admin/posts/{id}/approve',
        'POST /admin/posts/{id}/hide',
        'POST /admin/posts/{id}/reject',
      ],
    );
  });

  test('OpenAPI 里同样 5 条 path，且没有「恰好一条」这类单条断言', () => {
    const spec = JSON.parse(read(OPENAPI_PATH));
    const familyPaths = Object.keys(spec.paths ?? {}).filter((path) => path === '/admin/posts' || path.startsWith('/admin/posts/'));
    assert.deepEqual(familyPaths.sort(), [
      '/admin/posts',
      '/admin/posts/{id}',
      '/admin/posts/{id}/approve',
      '/admin/posts/{id}/hide',
      '/admin/posts/{id}/reject',
    ]);

    // 单一的事实源：任何一处 summary/description 里写「该家族恰好一条」都要红。
    // 负控制：这句假话本身必须能被这条正则抓住，否则口径等于形同虚设。
    assert.equal(SINGLE_OPERATION_CLAIM.test('该家族恰好一条 hidePost 操作'), true);
    assert.equal(SINGLE_OPERATION_CLAIM.test('后台帖子详情（管理视角）：一条帖子的管理视图'), false);

    const offenders = [];
    for (const path of familyPaths) {
      const item = spec.paths[path];
      const texts = [item.summary, item.description];
      for (const [method, operation] of Object.entries(item)) {
        if (typeof operation !== 'object' || operation === null) continue;
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        texts.push(operation.summary, operation.description, operation.operationId);
      }
      const joined = texts.filter(Boolean).join('\n');
      if (SINGLE_OPERATION_CLAIM.test(joined)) offenders.push(`${path}：${joined.slice(0, 200)}`);
    }
    assert.deepEqual(offenders, [], `${OPENAPI_PATH} 里 /admin/posts 家族又出现单条断言：\n${offenders.join('\n')}`);
  });
});

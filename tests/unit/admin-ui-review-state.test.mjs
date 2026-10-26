import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  HUMAN_REVIEW_COLLECTIONS_COUNT,
  REVIEW_CODE_ANCHORS,
  REVIEW_COUNT,
  REVIEW_COUNT_BADGE,
  reviewCountSources,
} from '../../apps/admin/src/lib/review-state.mjs'

// B5：人审入口空态的事实核对。页面上的"0 与出处"必须仍能被这些断言证实，
// 否则页面就是在引用失效证据（或悄悄变成假数据）。

const repoRoot = new URL('../../', import.meta.url)

function repoFile(relativePath) {
  return readFileSync(new URL(relativePath, repoRoot), 'utf8')
}

function lines(relativePath) {
  return repoFile(relativePath).split(/\r?\n/)
}

test('review state: 待审计数是结构性零，标签说明来源', () => {
  assert.equal(REVIEW_COUNT, 0)
  assert.match(REVIEW_COUNT_BADGE, /wired: false/)
  assert.equal(HUMAN_REVIEW_COLLECTIONS_COUNT, 4)
  assert.ok(reviewCountSources.length >= 3, '计数口径至少要有三条出处')
  for (const source of reviewCountSources) {
    assert.equal(typeof source.file, 'string')
    assert.match(source.file, /\.(ts|json|mjs)(:\d+(-\d+)?)?$/, `出处应带具体文件：${source.file}`)
    assert.ok(source.note.length > 0)
  }
})

// ---------------------------------------------------------------------------
// R64：把「契约里没有 review 路径」这条**假绿**断言换成集合级强断言
//
// 旧写法（已删）：`paths.filter((path) => /review/i.test(path))` ⇒ `deepEqual([], ...)`，
// 声称守护 `review-state.mjs` 的「全仓没有审核队列读接口与审核动作接口」。
// 实测（基线 `68dec742`：93 条 path / 122 个 operation）：
//   · `/review/i` 命中 **0** 条；把正则换成「恒不匹配」同样命中 **0** 条 ⇒ 两种写法都过，
//     这条断言分不清「真的没有审核面」与「只是名字里没写 review」；
//   · 契约里**有** 5 条 `/admin/posts` 后台审核面，其中 3 条是动作（`hidePost`／`approvePost`／
//     `rejectPost`），path 与 operationId 都不含 "review" ⇒ 被守护的那句自述**是假的**，
//     而断言恒绿。这就是假绿的判据：断言对它声称要保护的命题**不敏感**。
// 新写法：从契约**结构性枚举**审核面与审核动作集合（非空、逐条反查存在、scope 落在后台闭集），
// 并断言 `review-state.mjs` 自己的机读语义判定（`REVIEW_CODE_ANCHORS` 钉的 `OPS_OPERATION_IDS`
// 闭集）**覆盖**这三个动作 —— 模块一改判定，这里就会红。
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete'];

/** 把契约摊平成 operation 列表（只取真有 `operationId` 的 method 键）。 */
function contractOperations(spec) {
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (item === null || typeof item !== 'object') continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (operation === null || typeof operation !== 'object') continue;
      if (typeof operation.operationId !== 'string') continue;
      operations.push({ path, method, operationId: operation.operationId, scope: operation['x-scope'] });
    }
  }
  return operations;
}

/** 按 `mustInclude` 找到 `review-state.mjs` 导出的代码锚点，取出它覆盖的源码切片。 */
function anchorSlice(needle) {
  const anchor = REVIEW_CODE_ANCHORS.find((item) => item.mustInclude.includes(needle));
  assert.ok(anchor !== undefined, `review-state.mjs 的 REVIEW_CODE_ANCHORS 里找不到钉 ${needle} 的锚点`);
  const fileLines = lines(anchor.file);
  assert.ok(
    anchor.start >= 1 && anchor.end <= fileLines.length && anchor.start <= anchor.end,
    `${anchor.file}:${anchor.start}-${anchor.end} 越界（文件共 ${fileLines.length} 行）`,
  );
  return fileLines.slice(anchor.start - 1, anchor.end).join('\n');
}

/** 锚点覆盖的是 `Object.freeze([ 'a', 'b', ... ])`：取出其中的单引号标识符。 */
function quotedIdentifiers(slice) {
  return [...slice.matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].map((match) => match[1]);
}

test('review state: 后台审核动作是契约里的集合级事实（非空），且 review-state 的机读闭集覆盖它们', () => {
  const spec = JSON.parse(repoFile('packages/contracts/openapi.json'));
  const paths = Object.keys(spec.paths ?? {});
  const operations = contractOperations(spec);
  // 前提：数的是 `paths` 的键与摊平后的 operation，不是关键词命中 —— 先确认表真的解析出来了。
  assert.ok(paths.length > 80, `openapi.json 只有 ${paths.length} 条 path ⇒ 契约文件结构变了，本用例失去前提`);
  assert.ok(operations.length > 100, `只有 ${operations.length} 个 operation ⇒ 摊平判据失效`);

  // ① 旧断言唯一还成立的那半句：**命名**层面确实没有 review 字样。
  //    这是事实，但它只能证明命名习惯，证明不了「没有审核面」⇒ 保留为事实记录，
  //    ⛔ 不再充当守护断言（它匹配不到真正的审核动作，见 ②）。
  assert.deepEqual(paths.filter((path) => /review/i.test(path)), []);
  assert.deepEqual(operations.filter((op) => /review/i.test(op.operationId)), []);
  // 同一条判据换成「恒不匹配」谓词照样过 ⇒ 它与「有无审核面」无关（假绿的直接证据，写死在这里防回归）。
  assert.deepEqual(paths.filter(() => false), []);

  // ② 结构性枚举后台审核面：`/admin/posts` 家族 = 读面 2 + 动作面 3（逐条钉死方法+路径）。
  const family = operations.filter((op) => op.path.startsWith('/admin/posts'));
  assert.deepEqual(
    family.map((op) => `${op.method.toUpperCase()} ${op.path}`).sort(),
    [
      'GET /admin/posts',
      'GET /admin/posts/{id}',
      'POST /admin/posts/{id}/approve',
      'POST /admin/posts/{id}/hide',
      'POST /admin/posts/{id}/reject',
    ],
    '契约里 `/admin/posts` 家族变了：新增/改名/挪路径都必须同步本用例与 `review-state.mjs` 的判定',
  );

  // ③ 审核动作集合：非空 + 逐个反查存在（不是只数个数）。
  const actions = family.filter((op) => op.method === 'post');
  assert.ok(actions.length > 0, '后台审核动作集合不得为空 —— 这正是旧断言抹掉的事实');
  assert.deepEqual(
    actions.map((op) => op.operationId).sort(),
    ['approvePost', 'hidePost', 'rejectPost'],
    '审核动作 operationId 集合变了',
  );
  for (const action of actions) {
    const hits = operations.filter((op) => op.operationId === action.operationId);
    assert.equal(hits.length, 1, `operationId ${action.operationId} 必须恰好在契约里出现一次`);
    assert.equal(hits[0].path, action.path);
    assert.equal(hits[0].method, 'post');
  }

  // 动作必须落在**后台** scope 闭集里（不是 user scope）—— scope 闭集从契约取，不硬编码。
  const adminScopes = spec.components.schemas.AdminScope.enum;
  assert.ok(Array.isArray(adminScopes) && adminScopes.length > 0, '契约 AdminScope.enum 必须存在');
  for (const action of actions) {
    assert.ok(adminScopes.includes(action.scope), `${action.operationId} 的 x-scope=${String(action.scope)} 不在 AdminScope 闭集内`);
  }

  // ④ **review-state.mjs 的语义判定必须覆盖这些动作**：取模块自己钉的 `OPS_OPERATION_IDS`
  //    闭集（`REVIEW_CODE_ANCHORS` 的机读证据），逐个断言动作 operationId 在集合里。
  //    模块若删掉/换掉这段判定，或后端从闭集里摘掉某个动作，这里立刻红。
  const opsClosedSet = quotedIdentifiers(anchorSlice('OPS_OPERATION_IDS'));
  assert.ok(opsClosedSet.length >= 14, `OPS_OPERATION_IDS 只解析出 ${opsClosedSet.length} 项 ⇒ 锚点或格式变了`);
  for (const action of actions) {
    assert.ok(
      opsClosedSet.includes(action.operationId),
      `review-state.mjs 的语义判定（OPS_OPERATION_IDS 闭集）不再覆盖审核动作 ${action.operationId}`,
    );
  }

  // ⑤ 反混淆：「0 / wired:false」是人审**占位族**（四个集合）的判定，不能被读成「没有审核动作」。
  const humanReviewCollections = quotedIdentifiers(anchorSlice('HUMAN_REVIEW_COLLECTIONS'));
  assert.equal(humanReviewCollections.length, HUMAN_REVIEW_COLLECTIONS_COUNT, '四个集合名的解析条数必须等于模块自述的集合数');
  for (const action of actions) {
    assert.equal(humanReviewCollections.includes(action.operationId), false, '审核动作不得被人审集合名吞掉');
  }
  assert.equal(REVIEW_COUNT, 0);
  assert.notEqual(actions.length, REVIEW_COUNT, 'REVIEW_COUNT=0 只能表示人审队列为空；契约里确有 3 个审核动作');
});

test('review state: routes 目录里没有 review 路由', () => {
  const routesIndex = repoFile('services/api/src/routes/admin.ts') + repoFile('services/api/src/routes/public-home.ts')
  assert.equal(/human-review|humanReview\)/.test(routesIndex), false)
})

test('review state: 四集合名与 human-review.ts 的闭集一致', () => {
  const source = repoFile('services/api/src/admin/human-review.ts')
  const match = source.match(/HUMAN_REVIEW_COLLECTIONS = Object\.freeze\(\[([\s\S]*?)\] as const\)/)
  assert.ok(match, '未找到 HUMAN_REVIEW_COLLECTIONS 定义')
  const names = match[1]
    .split(',')
    .map((item) => item.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
  assert.equal(names.length, HUMAN_REVIEW_COLLECTIONS_COUNT)
  assert.deepEqual(names, ['tasks', 'reviewers', 'votes', 'expert_certifications'])
})

test('review state: 引用的行区间仍包含锚点（引用不失效）', () => {
  for (const anchor of REVIEW_CODE_ANCHORS) {
    const fileLines = lines(anchor.file)
    assert.ok(
      anchor.start >= 1 && anchor.end <= fileLines.length && anchor.start <= anchor.end,
      `${anchor.file}:${anchor.start}-${anchor.end} 越界（文件共 ${fileLines.length} 行）`,
    )
    const slice = fileLines.slice(anchor.start - 1, anchor.end).join('\n')
    for (const needle of anchor.mustInclude) {
      assert.ok(slice.includes(needle), `${anchor.file}:${anchor.start}-${anchor.end} 不再包含 ${needle}`)
    }
  }
})

test('review state: humanReviewQueue 的 items 恒为空数组（不是"还没加载"）', () => {
  const source = repoFile('services/api/src/moderation/nonbypass.ts')
  const body = source.slice(source.indexOf('export function humanReviewQueue'))
  assert.match(body, /return \{[^}]*items: \[\]/, 'humanReviewQueue 必须恒返回 items: []')
  assert.match(body, /human_review_state: HUMAN_REVIEW_STATE/)
})

test('review state: 人审目录快照冻结且 wired 为 false', () => {
  const source = repoFile('services/api/src/admin/human-review.ts')
  assert.match(source, /const EMPTY: readonly never\[\] = Object\.freeze\(\[\]\)/)
  assert.match(source, /wired: false/)
  assert.match(source, /assertNoReviewClaim\(surface: string\): never \{/)
  assert.match(source, /throw new ApiError\('OBJECT_UNAVAILABLE'/)
})

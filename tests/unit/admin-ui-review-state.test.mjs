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
// R64 × S3b 并集（2026-10-26）：两个 PR 动的是同一条用例、同一个语义点，
// 这里取**并集**——两侧断言一条都不许被另一侧覆盖。
//
// 旧写法（**用它当守护断言的那半句已删**，谓词本身仅留作事实记录）：
// `paths.filter((path) => /review/i.test(path))` ⇒ `deepEqual([], ...)`，曾声称守护
// `review-state.mjs` 的「全仓没有审核队列读接口与审核动作接口」。
// 实测（基线 `68dec742`：93 条 path / 122 个 operation）：
//   · `/review/i` 命中 **0** 条；把正则换成「恒不匹配」同样命中 **0** 条 ⇒ 两种写法都过，
//     这条断言分不清「真的没有审核面」与「只是名字里没写 review」；
//   · 契约里**有** 5 条 `/admin/posts` 后台审核面，其中 3 条是动作（`hidePost`／`approvePost`／
//     `rejectPost`），path 与 operationId 都不含 "review" ⇒ 被守护的那句自述**是假的**，
//     而断言恒绿。这就是假绿的判据：断言对它声称要保护的命题**不敏感**。
//
// 并入的两侧：
//   #642 —— 从契约**结构性枚举**审核面与审核动作集合（非空、逐条反查存在、scope 落在后台闭集），
//            并断言 `review-state.mjs` 自己的机读语义判定（`REVIEW_CODE_ANCHORS` 钉的
//            `OPS_OPERATION_IDS` 闭集）**覆盖**这三个动作 —— 模块一改判定，这里就会红。
//   S3b  —— 钉子**条件化**：原判据把「今天没有审核读面」当成「永远不许有」，真做人审工作台时
//            会逼人先删钉子再实现。改成有条件的诚实守卫：今天 0 条 `/review|vote/` 路径时只核对
//            占位页前提；一旦出现，每条 operation 必须带非空 `x-scope`，且响应 schema 的属性名
//            不得暴露「他人票数」。另加一条**恒跑**的反向控制，保证 0 条时那句字段禁令不是空话。
//
// 两层判据的宽度不同是刻意保留的：`①` 的 `/review/i` 是硬钉（改读面要先按
// `docs/verification/r59-community-premoderation-20261026.md` 的钉 4 改期望值）；
// `⑦` 的 `/review|vote/i` 比它更宽 —— 只带 `vote` 字样的评审路径不触发 `①`，才会落到 `⑦`
// 的逐条收口。窄的不漏、宽的兜住。
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

test('review state: 后台审核动作是契约里的集合级事实（非空）且机读闭集覆盖它们，审核/评审路径有则必须收口', () => {
  const spec = JSON.parse(repoFile('packages/contracts/openapi.json'));
  const paths = Object.keys(spec.paths ?? {});
  assert.ok(paths.length > 0, 'openapi 应有路径');
  const operations = contractOperations(spec);
  // 前提：数的是 `paths` 的键与摊平后的 operation，不是关键词命中 —— 先确认表真的解析出来了。
  assert.ok(paths.length > 80, `openapi.json 只有 ${paths.length} 条 path ⇒ 契约文件结构变了，本用例失去前提`);
  assert.ok(operations.length > 100, `只有 ${operations.length} 个 operation ⇒ 摊平判据失效`);

  // ① 命名层面的事实记录：契约里 path 与 operationId 都不含 "review" 字样。
  //    ⚠ 这条**不具区分力**（事实，写在这里免得下一个人再把它当守护）：同一套谓词换成「恒不匹配」，
  //    结果仍是 `[]` —— 它证明的是命名习惯，证明不出「没有审核面」。真正的审核面见 ②：
  //    `/admin/posts` 家族 3 个动作的 path 与 operationId 都不含 "review"，① 对它们完全不敏感。
  //    保留 ① 只作事实登记与改钉提示：真加 review 读面时先按
  //    `docs/verification/r59-community-premoderation-20261026.md` 的钉 4 流程改期望值。
  //    ⛔ 原先紧跟其后的那条「用恒不匹配谓词跑同一个 filter 再 deepEqual([])」的断言是恒真断言、
  //    零检测力，已删除；「命名判据不具区分力」这件事改用上面这段注释陈述，不再用断言充数。
  assert.deepEqual(paths.filter((path) => /review/i.test(path)), []);
  assert.deepEqual(operations.filter((op) => /review/i.test(op.operationId)), []);

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

  // ⑥ S3b 反向控制（**恒跑，不 skip**）：把一段合成的「含他人票数」响应喂给同一收集器 + 同一正则，
  //    必须被认出。没有这一臂，⑦ 的字段禁令在「0 条审核路径」时是空集，等于写了句永远为真的话。
  //    刻意放在 ⑦ 的提前 return 之前，保证它无条件执行。
  const syntheticNames = [...responsePropertyNames({
    responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { other_votes: { type: 'integer' } } } } } } },
  }, spec)];
  assert.deepEqual(syntheticNames, ['other_votes'], '响应字段收集器失灵：合成 schema 里只有一个 other_votes');
  assert.match(syntheticNames[0], OTHERS_VOTE_FIELDS, '「他人票数」判据失灵：other_votes 必须命中');

  // ⑦ S3b 条件式外壳：`/review|vote/` 比 ① 的 `/review/i` 更宽，只带 `vote` 字样的评审路径
  //    不触发 ①，才会落到这里。今天 0 条时只核对占位页前提；将来出现时逐条收口。
  const reviewPaths = paths.filter((path) => /review|vote/i.test(path));
  if (reviewPaths.length === 0) {
    // 今天契约里 0 条 ⇒ 占位页「不发起任何网络请求」与「待审计数是结构性零」同时成立。
    // 这一臂不写「必须永远为空」，只把页面的事实绑在契约现状上：读面一出现，页面就得改（P5）。
    assert.equal(REVIEW_COUNT, 0, '契约无审核读面时占位页仍是结构性零；改成真实计数就必须同步改本臂');
    assert.match(REVIEW_COUNT_BADGE, /wired: false/);
    return;
  }

  // 有审核/评审路径 ⇒ 每条 operation 必须按后台资格收口，且响应不得暴露他人票数。
  const reviewOperations = [];
  for (const path of reviewPaths) {
    for (const [method, operation] of Object.entries(spec.paths[path] ?? {})) {
      if (operation === null || typeof operation !== 'object' || operation.responses === undefined) continue;
      const at = `${method.toUpperCase()} ${path}`;
      reviewOperations.push(at);
      const scope = operation['x-scope'];
      assert.equal(typeof scope, 'string', `${at} 是审核/评审类路径，必须声明 x-scope（否则后台读面无法按资格收口）`);
      assert.ok(scope.length > 0, `${at} 的 x-scope 不能是空串`);
      for (const name of responsePropertyNames(operation, spec)) {
        assert.doesNotMatch(name, OTHERS_VOTE_FIELDS, `${at} 的响应字段「${name}」会暴露他人票数：需求 F08:197 明令不展示他人实时票数`);
      }
    }
  }
  // 反向控制 ②：路径能被解析成 operation（响应体为空/204 也算通过 —— 不拿"必须有字段"当门槛）。
  assert.equal(reviewOperations.length > 0, true, `审核/评审路径 ${reviewPaths.join(', ')} 上没解析出任何 operation`);
})

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

// ---------------------------------------------------------------------------
// S3b 钉子条件化用的两个帮手（刻意放在文件末尾：`function` 声明会提升，
// 且上移会挪动既有行号——`docs/verification/r59-community-premoderation-20261026.md`
// 按 `:38-44` 引用本文件的审核路径判据）。
// ---------------------------------------------------------------------------

/**
 * 「他人票数」类字段：能反推**别人**投了什么、投了多少（需求 F08:197「不展示其他人的实时票数以减少跟票」）。
 * 刻意**不**把总票数／剩余时间／自己已投算进来 —— 那三项的可展示边界需求尚未量化（见 S3b 取证 §7 缺需求 7），
 * 由需求补齐后再决定是否收紧，不在本片替产品做决定。
 */
const OTHERS_VOTE_FIELDS = /(^|_)(others?|other_voters?|per_voter|voter_ids?|voter_list|votes_by|vote_breakdown|live_votes|remaining_votes|tally|who_voted)(_|$)/i

/** 收集一个 operation 全部响应 schema 的属性名（跟随 `$ref`，与 G6b 的收集口径一致）。 */
function responsePropertyNames(operation, spec) {
  const names = new Set()
  const seenRefs = new Set()
  const walk = (schema, depth = 0) => {
    if (schema === null || typeof schema !== 'object' || depth > 12) return
    if (typeof schema.$ref === 'string') {
      const name = schema.$ref.split('/').at(-1)
      if (seenRefs.has(name)) return
      seenRefs.add(name)
      walk(spec.components?.schemas?.[name], depth + 1)
      return
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [name, child] of Object.entries(schema.properties)) {
        names.add(name)
        walk(child, depth + 1)
      }
    }
    for (const key of ['items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf']) {
      const child = schema[key]
      if (Array.isArray(child)) child.forEach((entry) => walk(entry, depth + 1))
      else if (child && typeof child === 'object') walk(child, depth + 1)
    }
  }
  for (const response of Object.values(operation.responses ?? {})) {
    for (const media of Object.values(response?.content ?? {})) {
      if (media?.schema) walk(media.schema)
    }
  }
  return names
}

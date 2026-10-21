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

test('review state: 契约里没有任何 review 路径（本页因此不发请求）', () => {
  const spec = JSON.parse(repoFile('packages/contracts/openapi.json'))
  const paths = Object.keys(spec.paths ?? {})
  assert.ok(paths.length > 0, 'openapi 应有路径')
  const reviewPaths = paths.filter((path) => /review/i.test(path))
  assert.deepEqual(reviewPaths, [], `契约新增了 review 读面，人审入口页必须改成读真实数据：${reviewPaths.join(', ')}`)
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

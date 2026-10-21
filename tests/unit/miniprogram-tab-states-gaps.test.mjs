// #28「五个 Tab 的正常使用收尾」前端一片的钉证据：reference 家族三页此前没有状态层——
// 列表页把「请求中」和「请求失败」都落到「没有可展示的资料」，种子页 0 命中只剩「共 0 条」，
// 详情页在服务端读取在途时直接渲染「未找到该记录」（用户会当成记录不存在而返回）。
//
// 本测试静态锁定补齐结果，防止以后有人把状态分支改回一行灰字、或把失败并进空内容态：
//   A 列表页 pages/reference：加载态、失败态（带 error-code 与重试）与空态互斥
//   B 详情页 pages/referencedetail：读取中 ≠ 未找到；只有 404／不可用算「没有这条」
//   C 种子页 pages/referenceseed：0 命中给「为什么空 + 下一步做什么」
//   D 三页都用统一状态组件，模拟标识（替身／整理稿／来源标记）一字未删
//
// 只读页面源码，不装载 vm 夹具：`tests/reference/*` 的夹具按完整说明符逐字登记页面 require，
// 给页面新增 require（例如 states.js）会破坏它们，因此失败分类交给 state-view 组件按错误码完成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pages = resolve(import.meta.dirname, '../../miniprogram/pages')
const read = (relative) => readFileSync(resolve(pages, relative), 'utf8')

test('A1 列表页：加载态与失败态都在，且空态不再抢在两者之前', () => {
  const wxml = read('reference/reference.wxml')
  // 加载态：仅在「请求在途且还没有任何记录」时出现。
  assert.match(wxml, /wx:if="\{\{busy && !items\.length\}\}"/)
  assert.match(wxml, /status="loading"/)
  assert.match(wxml, /正在向服务端查询登记资料/)
  // 失败态：走统一组件，错误码原样透传，且给得出重试入口。
  assert.match(wxml, /wx:if="\{\{queryError\}\}"/)
  assert.match(wxml, /status="\{\{querySession \? 'guest' : 'error'\}\}"/)
  assert.match(wxml, /error-code="\{\{queryErrorCode\}\}"/)
  assert.match(wxml, /action-text="\{\{querySession \? '核实登录后重试' : '重试查询'\}\}"/)
  assert.match(wxml, /bind:action="onRetry"/)
  // 空态：三重互斥守卫，失败／加载中都不会被渲染成「没有资料」。
  assert.match(wxml, /wx:if="\{\{!items\.length && !busy && !queryError && matchState !== 'invalid'\}\}"/)
  // 失败不得再退回一行灰字（docs/ui-state-inventory.md:98 明令禁止的形态）。
  assert.doesNotMatch(wxml, /class="reason">\{\{queryError\}\}/)
})

test('A2 列表页：错误码与会话标记落进 data，重试先重新核验门禁', () => {
  const js = read('reference/reference.js')
  assert.match(js, /queryErrorCode: ''/)
  assert.match(js, /querySession: false/)
  assert.match(js, /queryErrorCode: \(error && error\.code\) \|\| ''/)
  assert.match(js, /querySession: session/)
  assert.match(js, /onRetry: function \(\) \{/)
  assert.match(js, /if \(this\.data\.querySession \|\| !this\.data\.gatePassed\) \{ this\.checkGate\(\); return \}/)
})

test('B1 详情页：读取中不再渲染成「未找到该记录」，失败带重试', () => {
  const wxml = read('referencedetail/referencedetail.wxml')
  const js = read('referencedetail/referencedetail.js')
  const loading = wxml.indexOf('wx:if="{{busy}}"')
  const failed = wxml.indexOf('wx:elif="{{detailFailed}}"')
  const notFound = wxml.indexOf('wx:elif="{{!found}}"')
  assert.ok(loading >= 0, '详情页必须有加载态分支')
  assert.ok(failed > loading, '失败态必须紧跟加载态（单一兄弟链）')
  assert.ok(notFound > failed, '「未找到」必须排在失败态之后，不能抢在加载/失败前面')
  assert.match(wxml, /正在读取这条登记资料/)
  assert.match(wxml, /error-code="\{\{notFoundCode\}\}"/)
  assert.match(wxml, /action-text="重试读取"/)
  assert.match(wxml, /bind:action="retryDetail"/)
  // 「未找到」卡片本身（文案 + 返回继续查询）保持原样，真 404 仍是合法结论。
  assert.match(wxml, /该记录不存在，或已被下架、失效而不在有效资料中。/)
  assert.match(js, /retryDetail: function \(\) \{/)
  assert.match(js, /if \(this\.data\.busy\) return/)
})

test('B2 详情页：只有 NOT_FOUND / OBJECT_UNAVAILABLE 算「没有这条」，其余都是可重试失败', () => {
  const js = read('referencedetail/referencedetail.js')
  assert.match(js, /const code = \(error && error\.code\) \|\| ''/)
  assert.match(js, /const absent = code === 'NOT_FOUND' \|\| code === 'OBJECT_UNAVAILABLE'/)
  assert.match(js, /notFoundCode: code/)
  assert.match(js, /detailFailed: !absent/)
  // 冻结闭集文案仍来自 knowledgeApi.message（不在页面里另写未核对文本）。
  assert.match(js, /notFoundText: knowledgeApi\.message\(error\)/)
})

test('C1 种子页：0 命中给空内容态与「下一步做什么」，不是只剩「共 0 条」', () => {
  const wxml = read('referenceseed/referenceseed.wxml')
  const js = read('referenceseed/referenceseed.js')
  assert.match(wxml, /wx:if="\{\{gatePassed && !list\.length\}\}"/)
  assert.match(wxml, /status="empty"/)
  assert.match(wxml, /action-text="\{\{keyword \? '清空检索词看全部' : '回除草剂名录'\}\}"/)
  assert.match(wxml, /bind:action="emptyAction"/)
  // 文案由页面按「有无检索词」决定，模板里不拼字符串。
  assert.match(js, /emptyCopy: function \(keyword, count\) \{/)
  assert.match(js, /emptyTitle: ''/)
  assert.match(js, /emptyDesc: ''/)
  assert.match(js, /emptyTitle: empty\.title/)
  assert.match(js, /emptyAction: function \(\) \{/)
  // 空态说清原因与出口，不补写条目。
  assert.match(js, /不合并不同记录，也不会用近似条目顶替/)
  assert.match(js, /不补写、不用近似条目顶替/)
})

test('D1 三页都通过统一状态组件渲染，不各自另写一套', () => {
  for (const page of ['reference', 'referencedetail', 'referenceseed']) {
    const json = JSON.parse(read(`${page}/${page}.json`))
    assert.equal(
      json.usingComponents && json.usingComponents['state-view'],
      '/components/state-view/state-view',
      `${page}.json 必须声明 state-view 组件`
    )
  }
})

test('D2 跳转失败不再静默：列表页 navigateTo 带可见提示', () => {
  for (const page of ['reference/reference.js', 'referenceseed/referenceseed.js']) {
    const js = read(page)
    assert.match(js, /fail: function \(\) \{ wx\.showToast\(\{ title: '没能打开这条资料，请重试', icon: 'none' \}\) \}/)
  }
})

test('D3 模拟标识未被改写：替身说明、来源标记与整理稿标注都还在', () => {
  const reference = read('reference/reference.wxml')
  assert.match(reference, /\{\{modeNote\}\}/)
  assert.match(reference, /已排除 \{\{simulatedExcluded\}\} 条模拟演示记录/)
  const detail = read('referencedetail/referencedetail.wxml')
  assert.match(detail, /\{\{modeNote\}\}/)
  assert.match(detail, /来源标记：\{\{sourceMarker\}\}/)
  const seed = read('referenceseed/referenceseed.wxml')
  assert.match(seed, /data_origin=\{\{dataOrigin\}\} · authority=\{\{authority\}\}/)
})

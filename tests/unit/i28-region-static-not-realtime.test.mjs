/**
 * GY-I28：「静态地区候选 ≠ 实时预警」口径的**防回退**守卫
 * ---------------------------------------------------------------------------
 * 本片只补「可机检的口径」与「如实登记」，不改产品行为：
 *   1) `docs/ui-state-inventory.md` §9.1 必须仍写着这条口径的三个要件：
 *      「静态地区候选 ≠ 实时预警能力」「不产出、不展示任何『你所在地区将……』式预警」
 *      「不得把 102 项行政区候选写成『已覆盖』」。删掉任一句即变红。
 *   2) 负控制：`miniprogram/**` 里 `预警`／`weather`／`forecast` **零命中**。
 *      一旦有人偷偷接一个「实时预警」源或写死一条预警文案，本用例立刻变红——
 *      这正是「不假发预警」的可机检形式（走查记录见
 *      `docs/verification/gy-i26-five-tabs-20261103.md:33`）。
 *   3) 地区未设置时页面必须显示「未设置」，不得回落到上级行政区或猜一个：
 *      `miniprogram/pages/profile/profile.js:154` 的 `region_code === null ? '未设置'` 仍在。
 *   4) 静态候选仍是随包生成物且与契约同源：
 *      `miniprogram/data/regions.js` 的 `catalog_version` 与 `region_count` 来自
 *      `packages/knowledge/catalog/regions-zhejiang.json`，两边的 `region_count` 必须一致。
 *
 * 能证明什么：口径文字没被删、扫描面（`miniprogram/**` 的 `.js`／`.json`／`.wxml`／`.wxss`）内
 * 没有出现预警字样或天气数据源标识、地区缺省显示没有回退、静态候选表与契约同源且条数一致。
 * 不能证明什么：三个词零命中**只覆盖扫描面**，不能穷尽证明仓里不存在任何实时预警数据源；
 * 本文件**不启动微信开发者工具、不接触真机**，真机逐页渲染仍未取得（属 #23 的真机项），
 * 也不证明地区候选在真实业务里够用。
 *
 * Refs #28
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INVENTORY_DOC = 'docs/ui-state-inventory.md'
const MINIPROGRAM_DIR = join(ROOT, 'miniprogram')
const REGIONS_JS = join(ROOT, 'miniprogram', 'data', 'regions.js')
const REGIONS_CONTRACT = join(ROOT, 'packages', 'knowledge', 'catalog', 'regions-zhejiang.json')
const PROFILE_JS = join(ROOT, 'miniprogram', 'pages', 'profile', 'profile.js')

/** 口径三要件：逐句匹配，缺一句都算回退。 */
const REQUIRED_SENTENCES = [
  '静态地区候选 ≠ 实时预警能力',
  '不产出、不展示任何「你所在地区将……」式预警',
  '不得把 102 项行政区候选写成「已覆盖」',
]

/** 实时预警的三种「偷偷接入」痕迹：中文词与两个英文数据源名。 */
const FORBIDDEN_TOKENS = ['预警', 'weather', 'forecast']

function readUtf8 (abs) {
  return readFileSync(abs, 'utf8')
}

/** 递归收集某目录下指定后缀的文件绝对路径。 */
function walk (dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(abs)
  }
  return out
}

test('§9.1 口径三要件仍在（删任一句即红）', () => {
  const doc = readUtf8(join(ROOT, INVENTORY_DOC))
  for (const sentence of REQUIRED_SENTENCES) {
    assert.ok(
      doc.includes(sentence),
      `${INVENTORY_DOC} 里找不到口径句：「${sentence}」——删掉它等于放弃「不假发预警」的成文约束`,
    )
  }
})

test('负控制：miniprogram 里没有任何实时预警痕迹（预警/weather/forecast 零命中）', () => {
  const files = walk(MINIPROGRAM_DIR, ['.js', '.json', '.wxml', '.wxss'])
  assert.ok(files.length > 50, `miniprogram 文件数异常（${files.length}），先确认遍历没坏`)
  const hits = []
  for (const abs of files) {
    const text = readUtf8(abs)
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) hits.push(`${abs.slice(ROOT.length + 1)} → ${token}`)
    }
  }
  assert.deepEqual(
    hits,
    [],
    `本版没有任何实时预警能力，仓里出现这些词就说明有人接了一个未登记的数据源或写死了预警文案：\n${hits.join('\n')}`,
  )
})

test('地区未设置时显示「未设置」，不回落到上级行政区', () => {
  const src = readUtf8(PROFILE_JS)
  assert.match(
    src,
    /region_code === null\s*\?\s*'未设置'/,
    `${PROFILE_JS} 里「region_code === null ? '未设置'」不见了：地区缺省显示一旦改成回落或猜测，页面就会凭空给出一个用户没设过的地区`,
  )
})

test('静态候选与契约同源：region_count 与 catalog_version 两边一致', () => {
  const js = readUtf8(REGIONS_JS)
  const contract = JSON.parse(readUtf8(REGIONS_CONTRACT))
  const countInJs = Number((js.match(/"region_count"\s*:\s*(\d+)/) || [])[1])
  const versionInJs = (js.match(/"catalog_version"\s*:\s*"([^"]+)"/) || [])[1]
  assert.ok(Number.isFinite(countInJs), 'miniprogram/data/regions.js 里读不到 region_count')
  assert.equal(
    countInJs,
    contract.regions.length,
    `region_count 与契约不一致：regions.js=${countInJs}，contract=${contract.regions.length}（重新跑 tools/knowledge/build_miniprogram_data.mjs）`,
  )
  assert.equal(
    versionInJs,
    contract.catalog_version,
    `catalog_version 与契约不一致：regions.js=${versionInJs}，contract=${contract.catalog_version}`,
  )
})

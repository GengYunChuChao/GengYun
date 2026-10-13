import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// 解析级防护：当前真实的 miniprogram/utils/reference.js 必须能被 ESM 解析器接受，
// 不得在文件作用域内重复声明同名函数（如 isSimulatedSource 在 line 146 与 line 774 重复）。
// CommonJS 函数提升会静默让后者覆盖前者，普通业务测试因此漏检；此处只解析、不执行源码。
// 仅用 node 内置模块，不引任何依赖；不镜像“函数计数”，直接对源码做 --check。
test('miniprogram/utils/reference.js parses cleanly under ESM --check (no duplicate declarations)', () => {
  const src = readFileSync(
    new URL('../../miniprogram/utils/reference.js', import.meta.url),
    'utf8'
  )

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--check'],
    { input: src, encoding: 'utf8' }
  )

  assert.strictEqual(
    result.status,
    0,
    `reference.js 解析失败（status=${result.status}）：\n${result.stderr}`
  )
  assert.ok(
    !result.stderr || result.stderr.trim() === '',
    `reference.js 解析存在告警：\n${result.stderr}`
  )
})

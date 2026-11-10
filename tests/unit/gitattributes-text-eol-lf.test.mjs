/**
 * 守卫：`.gitattributes` 的文本扩展名声明，以及索引里不得有 CRLF。
 *
 * 本机 `core.autocrlf=true` 时，未声明 `eol=lf` 的文本文件会在工作区检出为 CRLF；
 * `tools/demo-align.mjs` 等做逐字比对时就会在本机假红。这里同时钉住两件事：
 *   1. `.gitattributes` 里 11 类文本扩展名都必须是 `text eol=lf`；
 *   2. 已入库的索引（`git ls-files --eol` 的 `i/` 列）不得出现 `i/crlf`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），不依赖当前工作目录。 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TEXT_EXTENSIONS = [
  '.wxss',
  '.wxml',
  '.js',
  '.css',
  '.sql',
  '.html',
  '.md',
  '.mjs',
  '.ts',
  '.json',
  '.yml',
];

/** 读取根 `.gitattributes` 的非注释规则行，拆成 `{ pattern, attributes }`。 */
function readAttributeRules() {
  return readFileSync(join(ROOT, '.gitattributes'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [pattern, ...attributes] = line.split(/\s+/u);
      return { pattern, attributes };
    });
}

/** 扩展名 → 规则属性列表。同一扩展名重复声明时，后出现的规则生效。 */
function rulesByExtension(rules) {
  return new Map(
    rules
      .filter(({ pattern }) => /^\*\.[^.]+$/u.test(pattern))
      .map(({ pattern, attributes }) => [pattern.slice(1), attributes]),
  );
}

test('gitattributes/11 类文本扩展名都带 text 与 eol=lf', () => {
  const rules = rulesByExtension(readAttributeRules());

  for (const extension of TEXT_EXTENSIONS) {
    const attributes = rules.get(extension);
    assert.ok(attributes, `.gitattributes 缺少「*${extension} text eol=lf」规则`);
    assert.ok(attributes.includes('text'), `*${extension} 缺少 text 属性：${attributes.join(' ')}`);
    assert.ok(attributes.includes('eol=lf'), `*${extension} 缺少 eol=lf 属性：${attributes.join(' ')}`);
  }
});

test('gitattributes/规则解析非空，避免什么都没解析到也算通过', () => {
  const rules = readAttributeRules();
  assert.ok(rules.length >= 10, `.gitattributes 只解析出 ${rules.length} 条规则，明显不是真实规则集`);
});

test('gitattributes/索引中不得存在 i/crlf', () => {
  const output = execFileSync('git', ['ls-files', '--eol'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const rows = output
    .split(/\r?\n/u)
    .filter((line) => line !== '')
    .map((line) => {
      const tabIndex = line.indexOf('\t');
      const metadata = tabIndex === -1 ? line : line.slice(0, tabIndex);
      const path = tabIndex === -1 ? '' : line.slice(tabIndex + 1);
      const [indexEol] = metadata.trim().split(/\s+/u);
      return { path, indexEol };
    });

  assert.ok(rows.length > 0, 'git ls-files --eol 没有返回任何行，无法判断索引行尾');

  const violations = rows.filter(({ indexEol }) => indexEol === 'i/crlf');
  const sample = violations
    .slice(0, 10)
    .map(({ path, indexEol }) => `${indexEol} ${path}`)
    .join('\n');

  assert.equal(
    violations.length,
    0,
    `索引中存在 ${violations.length} 个 CRLF 条目，前 ${Math.min(violations.length, 10)} 个：\n${sample}`,
  );
});

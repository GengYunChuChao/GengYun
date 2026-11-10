/**
 * 守卫：`.gitattributes` 的文本扩展名声明，以及索引里不得有 CRLF。
 *
 * 本机 `core.autocrlf=true` 时，未声明 `eol=lf` 的文本文件会在工作区检出为 CRLF；
 * `tools/demo-align.mjs` 等做逐字比对时就会在本机假红。这里同时钉住三件事：
 *   1. `git ls-files` 里每个被跟踪的文本扩展名（二进制白名单除外）都必须被
 *      `text eol=lf` 规则覆盖（可直接 `*.ext`，也可由 `*` 等更宽规则覆盖）；
 *   2. `.gitattributes` 能解析出真实规则集，防止空文件/全注释也通过；
 *   3. 已入库的索引（`git ls-files --eol` 的 `i/` 列）不得出现 `i/crlf`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），不依赖当前工作目录。 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 二进制扩展名：不做文本行尾转换，守卫不要求它们声明 `eol=lf`。 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.pmi',
]);

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

/**
 * 取被 git 跟踪的全部文件路径。
 *
 * 用 `-z` 拿 NUL 分隔的原始路径：默认输出会把非 ASCII 路径转义成 `\350...`，
 * 扩展名解析会多出尾引号（例如 `".md"`）。
 */
function readTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter((file) => file !== '');
}

/**
 * 取文件扩展名（含点、小写）。
 * `LICENSE` 这类无扩展名文件返回空串；`.gitignore` 这类点文件整体视为扩展名。
 */
function extensionOf(file) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** 统计被跟踪的文本扩展名 → `{ count, sample }`。 */
function collectTextExtensions(files) {
  const extensions = new Map();

  for (const file of files) {
    const extension = extensionOf(file);
    if (extension === '' || BINARY_EXTENSIONS.has(extension)) continue;

    const entry = extensions.get(extension);
    if (entry) {
      entry.count += 1;
    } else {
      extensions.set(extension, { count: 1, sample: file });
    }
  }

  return extensions;
}

/** 极简 glob：只服务扩展名规则（`*` 任意非分隔符、`?` 单个非分隔符）。 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  const source = escaped.replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]');
  return new RegExp(`^${source}$`, 'u');
}

/**
 * 找出覆盖某扩展名的生效规则。
 * 按 gitattributes 的「后匹配覆盖先匹配」语义取最后一条；`*` 等更宽规则也算覆盖。
 */
function findPinningRule(rules, extension) {
  const name = `file${extension}`;
  let matched = null;

  for (const rule of rules) {
    if (rule.pattern.startsWith('!')) continue;
    if (globToRegExp(rule.pattern).test(name)) matched = rule;
  }

  return matched;
}

test('gitattributes/所有被跟踪文本扩展名都必须带 text 与 eol=lf', () => {
  const files = readTrackedFiles();
  assert.ok(files.length > 0, 'git ls-files 没有返回任何文件，无法判断扩展名覆盖');

  const textExtensions = collectTextExtensions(files);
  assert.ok(textExtensions.size > 0, '没有收集到任何文本扩展名，无法判断 .gitattributes 覆盖');

  const rules = readAttributeRules();
  const missing = [];

  for (const [extension, { count, sample }] of textExtensions) {
    const rule = findPinningRule(rules, extension);

    if (!rule) {
      missing.push({
        extension,
        count,
        sample,
        reason: '找不到匹配的规则',
      });
      continue;
    }

    const missingAttributes = ['text', 'eol=lf'].filter(
      (attribute) => !rule.attributes.includes(attribute),
    );

    if (missingAttributes.length > 0) {
      missing.push({
        extension,
        count,
        sample,
        reason: `最后匹配的「${rule.pattern} ${rule.attributes.join(' ')}」缺 ${missingAttributes.join('、')}`,
      });
    }
  }

  const detail = missing
    .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension))
    .map(({ extension, count, sample, reason }) => `  ${extension}（${count} 个文件，如 ${sample}）：${reason}`)
    .join('\n');

  assert.equal(
    missing.length,
    0,
    `.gitattributes 未钉住 ${missing.length} 类被跟踪文本扩展名：\n${detail}\n请补「*.ext text eol=lf」规则。`,
  );
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

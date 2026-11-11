/**
 * 守卫：真实 tracked 路径的生效 `text`/`eol` 属性，以及索引侧不得有 CRLF / 混合行尾。
 *
 * 旧版只读根 `.gitattributes` 的规则文本，再用合成名 `file.ext` 推断覆盖。那样看不到
 * 更深目录的 `.gitattributes`（本仓证据快照正依赖 `* -text` 覆盖根规则），也看不到
 * `git add` 后索引里的真实字节。这里改成：
 *   1. `git ls-files --eol -z` 一次取回每个 tracked 文件的 `i/`、`w/`、`attr/`；
 *      老 Git 不支持 `--eol` 时回退到 `git ls-files -z` + `git check-attr --stdin -z`；
 *   2. 对每个非二进制文本扩展名路径断言生效属性 `text: set`、`eol: lf`；
 *   3. 对同一批路径断言索引侧 `i/` 只能是 `lf`/`none`，拒绝 `crlf` 与 `mixed`；
 *   4. 证据快照的两个目录按**显式路径前缀**排除，并反过来断言其 `text` 全是 `unset`，
 *      防止例外被悄悄扩大。
 *
 * ⛔ 本文件不解析 `.gitattributes` 文本、不拼合成文件名；判断只来自 git 命令。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），不依赖当前工作目录。 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 二进制扩展名：不做文本行尾转换，也不要求 `text`/`eol`。 */
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

/**
 * 证据快照例外：显式列到目录（带尾斜杠），不用 `docs/verification/assets/` 这种宽前缀。
 * 这两处各有更深的 `* -text`，里面的字节必须原样保留；守卫断言它们的有效 `text` 为 `unset`。
 */
const EVIDENCE_EXCEPTION_PREFIXES = Object.freeze([
  'docs/verification/assets/i07-wechat-main8932ba5-pr80b5a6468/',
  'docs/verification/assets/local-knowledge-native-20261011/',
]);

/** 索引侧允许的行尾：`none` 是空文件/无行尾；`lf` 是唯一允许的换行。 */
const ALLOWED_INDEX_EOLS = new Set(['lf', 'none']);

const MAX_BUFFER = 64 * 1024 * 1024;

/** 统一跑 git；`input` 用于 `check-attr --stdin -z` 的 NUL 分隔路径。 */
function runGit(args, { cwd = ROOT, input } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    ...(input === undefined ? {} : { input }),
  });
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

/** 是否是二进制白名单路径。 */
function isBinaryPath(file) {
  return BINARY_EXTENSIONS.has(extensionOf(file));
}

/** 是否落在显式证据快照例外里。 */
function isEvidenceExceptionPath(file) {
  return EVIDENCE_EXCEPTION_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/**
 * 守卫扫描面：非二进制、且带扩展名的 tracked 路径，再剔除证据快照例外。
 *
 * 无扩展名的 `Dockerfile` / `CODEOWNERS` 不在这条**扩展名**守卫的扫描面内：
 * 它们没有可分类的扩展名，当前也不在根 `.gitattributes` 的声明面里。本片不扩这个面。
 */
function isCheckedTextPath(file) {
  return !isEvidenceExceptionPath(file) && !isBinaryPath(file) && extensionOf(file) !== '';
}

/**
 * 解析 `git ls-files --eol -z` 的一条记录。
 *
 * 实际格式是 `i/<eol> w/<eol> attr/<eolattr>\t<path>`；`<eolattr>` 可能是空串、`-text`、
 * `text`、`text=auto`、`text eol=lf` 等。这里只归一化 `text` / `eol` 两个值。
 */
function parseEolAttribute(raw) {
  const result = { text: 'unspecified', textValue: null, eol: 'unspecified' };

  for (const token of raw === '' ? [] : raw.split(/\s+/u)) {
    if (token === '-text') {
      result.text = 'unset';
    } else if (token === 'text') {
      result.text = 'set';
    } else if (token.startsWith('text=')) {
      result.text = 'value';
      result.textValue = token.slice('text='.length);
    } else if (token === 'eol') {
      result.eol = 'set';
    } else if (token.startsWith('eol=')) {
      result.eol = token.slice('eol='.length);
    }
  }

  return result;
}

/** 解析 `git ls-files --eol -z` 的 NUL 分隔输出。 */
function parseEolOutput(output) {
  const rows = [];

  for (const record of output.split('\0')) {
    if (record === '') continue;

    const tabIndex = record.indexOf('\t');
    if (tabIndex === -1) {
      throw new Error(`git ls-files --eol -z 返回了无法解析的记录：${JSON.stringify(record)}`);
    }

    const metadata = record.slice(0, tabIndex);
    const path = record.slice(tabIndex + 1);
    const match = /^i\/([^ \t]+)\s+w\/([^ \t]+)\s+attr\/(.*?)\s*$/u.exec(metadata);
    if (!match) {
      throw new Error(`git ls-files --eol -z 的元数据无法解析：${JSON.stringify(metadata)}`);
    }

    const [, indexEol, workingEol, attrRaw] = match;
    const attributes = parseEolAttribute(attrRaw);

    rows.push({
      path,
      indexEol,
      workingEol,
      attrRaw,
      ...attributes,
    });
  }

  return rows;
}

/** 在老 Git 上把 `check-attr` 的 `text`/`eol` 值拼成与 `attr/` 类似的展示串。 */
function attrRawFromValues(text, eol) {
  const textToken =
    text === 'unset' ? '-text' : text === 'set' ? 'text' : text === 'unspecified' ? '' : `text=${text}`;
  const eolToken = eol === 'unspecified' ? '' : eol === 'set' ? 'eol' : `eol=${eol}`;
  return [textToken, eolToken].filter((token) => token !== '').join(' ');
}

/**
 * 回退：`git ls-files -z` 拿路径，`git check-attr --stdin -z text eol` 一次批量查生效属性。
 * 该分支没有索引行尾字段（`--eol` 不可用）；索引测试会 fail-closed，不用猜测。
 */
function readTrackedByCheckAttr(cwd) {
  const files = runGit(['ls-files', '-z'], { cwd })
    .split('\0')
    .filter((file) => file !== '');

  const input = files.map((file) => `${file}\0`).join('');
  const output = runGit(['check-attr', '--stdin', '-z', 'text', 'eol'], { cwd, input });
  const fields = output.split('\0');
  const attributes = new Map();

  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index];
    if (path === '') continue;

    const name = fields[index + 1];
    const value = fields[index + 2];
    const entry = attributes.get(path) ?? {};
    entry[name] = value;
    attributes.set(path, entry);
  }

  return files.map((path) => {
    const entry = attributes.get(path) ?? {};
    const text = entry.text ?? 'unspecified';
    const eol = entry.eol ?? 'unspecified';
    return {
      path,
      indexEol: null,
      workingEol: null,
      attrRaw: attrRawFromValues(text, eol),
      text,
      textValue: null,
      eol,
    };
  });
}

/** 取回 tracked 文件的真实行尾/生效属性；优先 `--eol`，明确不支持时才回退。 */
function readTrackedEol(cwd = ROOT) {
  try {
    const output = runGit(['ls-files', '--eol', '-z'], { cwd });
    const rows = parseEolOutput(output);
    if (rows.length > 0) return { rows, source: 'git ls-files --eol -z' };
  } catch (error) {
    const message = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;
    if (!/unknown option|unrecognized option|usage: git ls-files/iu.test(message)) throw error;
  }

  return { rows: readTrackedByCheckAttr(cwd), source: 'git ls-files -z + git check-attr --stdin -z' };
}

/** 仓内元数据只取一次：正面的四条断言共用同一份真实路径读数。 */
let repoMetadata;
function readRepoMetadata() {
  repoMetadata ??= readTrackedEol();
  return repoMetadata;
}

/** 生效属性违例：非二进制文本路径的 `text` 必须 set、`eol` 必须 lf。 */
function findAttributeViolations(rows) {
  return rows.filter(
    (row) => isCheckedTextPath(row.path) && (row.text !== 'set' || row.eol !== 'lf'),
  );
}

/** 索引违例：非二进制文本路径的 `i/` 只能是 lf/none；`crlf` 与 `mixed` 都拒。 */
function findIndexViolations(rows) {
  return rows.filter(
    (row) => isCheckedTextPath(row.path) && !ALLOWED_INDEX_EOLS.has(row.indexEol),
  );
}

/** 单行诊断：路径 + `i/` + `attr/` + 归一化后的 `text`/`eol`。 */
function describeRow(row) {
  const attr = row.attrRaw === '' ? '(unspecified)' : row.attrRaw;
  return `  ${row.path}  i/${row.indexEol ?? '(unknown)'}  attr/${attr}  text:${row.text} eol:${row.eol}`;
}

/** 失败时只打印前 10 条，避免整仓刷屏。 */
function describeRows(rows) {
  const head = rows.slice(0, 10).map(describeRow).join('\n');
  return rows.length > 10 ? `${head}\n  ……另有 ${rows.length - 10} 条` : head;
}

/** 在隔离 tmpdir 造临时 Git 仓；跑完由调用方删除。 */
function withTempRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-gitattributes-eol-'));
  try {
    runGit(['init', '-q'], { cwd: dir });
    runGit(['config', 'core.autocrlf', 'false'], { cwd: dir });
    runGit(['config', 'core.safecrlf', 'false'], { cwd: dir });
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('gitattributes/真实 tracked 文件元数据非空，避免零行假绿', () => {
  const { rows, source } = readRepoMetadata();

  assert.ok(rows.length >= 2000, `${source} 只返回 ${rows.length} 行，明显没有拿到全仓 tracked 文件`);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const sample = byPath.get('tests/unit/gitattributes-text-eol-lf.test.mjs');
  assert.ok(sample, `${source} 的结果里没有本测试文件，读取口径不可信`);
  assert.equal(sample.text, 'set', `本测试文件的有效 text 应为 set：${describeRow(sample)}`);
  assert.equal(sample.eol, 'lf', `本测试文件的有效 eol 应为 lf：${describeRow(sample)}`);
  assert.equal(sample.indexEol, 'lf', `本测试文件的索引行尾应为 lf：${describeRow(sample)}`);
});

test('gitattributes/所有被跟踪文本扩展名路径的生效属性必须是 text:set 与 eol:lf', () => {
  const { rows, source } = readRepoMetadata();
  const violations = findAttributeViolations(rows);

  assert.equal(
    violations.length,
    0,
    `${source} 查到 ${violations.length} 个文本路径的生效属性不是 text:set + eol:lf，前 10 个：\n${describeRows(violations)}`,
  );
});

test('gitattributes/证据快照例外的有效 text 必须全是 unset，防止例外扩大', () => {
  const { rows } = readRepoMetadata();

  for (const prefix of EVIDENCE_EXCEPTION_PREFIXES) {
    const scoped = rows.filter((row) => row.path.startsWith(prefix));
    assert.ok(scoped.length > 0, `证据快照前缀 ${prefix} 下没有任何 tracked 文件，例外清单已失效`);

    const notUnset = scoped.filter((row) => row.text !== 'unset');
    assert.equal(
      notUnset.length,
      0,
      `${prefix} 下有 ${notUnset.length} 个路径的有效 text 不是 unset（例外被扩大或更深规则丢失）：\n${describeRows(notUnset)}`,
    );
  }
});

test('gitattributes/索引行尾只能是 lf/none，不得 crlf 或 mixed', () => {
  const { rows, source } = readRepoMetadata();
  const unknown = rows.filter((row) => isCheckedTextPath(row.path) && row.indexEol === null);
  assert.equal(
    unknown.length,
    0,
    `${source} 不支持读取索引行尾，无法 fail-closed 地检查 i/crlf 与 i/mixed；前 10 个：\n${describeRows(unknown)}`,
  );

  const violations = findIndexViolations(rows);
  assert.equal(
    violations.length,
    0,
    `索引中存在 ${violations.length} 个非 lf/none 的文本条目，前 10 个：\n${describeRows(violations)}`,
  );
});

test('负控制：子目录 eol=crlf 覆盖根规则时，按真实路径必须判红', () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=lf\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', '.gitattributes'), '*.txt eol=crlf\n');
    writeFileSync(join(dir, 'plain.txt'), 'plain\n');
    writeFileSync(join(dir, 'sub', 'override.txt'), 'override\n');
    runGit(['add', '--', '.'], { cwd: dir });

    const { rows } = readTrackedEol(dir);
    const byPath = new Map(rows.map((row) => [row.path, row]));
    const override = byPath.get('sub/override.txt');
    assert.ok(override, '临时仓库里没有取到 sub/override.txt 的真实行尾/属性');
    assert.equal(override.text, 'set', `子目录只覆盖 eol，text 应仍为 set：${describeRow(override)}`);
    assert.equal(override.eol, 'crlf', `子目录覆盖后的有效 eol 应为 crlf：${describeRow(override)}`);

    const violations = findAttributeViolations(rows);
    assert.ok(
      violations.some((row) => row.path === 'sub/override.txt'),
      `根规则 *.txt text eol=lf 盖不住子目录 eol=crlf，守卫必须判红；实际违例：\n${describeRows(violations)}`,
    );
    assert.ok(
      !violations.some((row) => row.path === 'plain.txt'),
      `同仓的 plain.txt 命中根规则，不应被误判：\n${describeRows(violations)}`,
    );
  });
});

test('负控制：索引 first\\r\\nsecond\\n 必须是 i/mixed，守卫必须判红', () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, 'mixed.txt'), Buffer.from('first\r\nsecond\n', 'utf8'));
    runGit(['add', '--', 'mixed.txt'], { cwd: dir });

    const { rows } = readTrackedEol(dir);
    const mixed = rows.find((row) => row.path === 'mixed.txt');
    assert.ok(mixed, '临时仓库里没有取到 mixed.txt 的真实行尾/属性');
    assert.equal(mixed.indexEol, 'mixed', `索引应被 Git 识别为 i/mixed：${describeRow(mixed)}`);

    const violations = findIndexViolations(rows);
    assert.ok(
      violations.some((row) => row.path === 'mixed.txt'),
      `i/mixed 必须被判红；实际违例：\n${describeRows(violations)}`,
    );
  });
});

export {
  ROOT,
  EVIDENCE_EXCEPTION_PREFIXES,
  readTrackedEol,
  readTrackedByCheckAttr,
  findAttributeViolations,
  findIndexViolations,
  describeRow,
  describeRows,
  withTempRepo,
};

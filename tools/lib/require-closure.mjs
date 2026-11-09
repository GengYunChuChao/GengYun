/**
 * 生成副本里的相对 require 闭合检查。
 *
 * `tools/prepare-wechat.mjs` 的 `files` 清单是逐项白名单：清单漏了某个被页面 require 的模块时，
 * 复制阶段不会报错，副本在微信开发者工具里才以 `MODULE_NOT_FOUND` 暴露；页面侧又常把 require
 * 包在 try/catch 里，最终只剩「时间不显示」「页面数据没装载」这类远离根因的表象。
 *
 * 本模块在复制完成后、打印成功提示之前，按 Node 的相对路径解析口径（`base`、`base + '.js'`、
 * `base/index.js`）把副本里所有 `.js` 的相对 require 扫一遍。任何一条解析不到都当场抛错，
 * 并在报错里点名文件、specifier、解析目标，以及目标是否登记在本次 `files` 清单里。
 *
 * ⛔ 不 try/catch 兜底，不引入依赖：这是打包期的硬闸门，不是尽力而为的提示。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** 只认 `require('…')`／`require("…")`；specifier 是否相对由调用处再筛。 */
const REQUIRE_PATTERN = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
/** 与 Node 的相对模块写法一致：`./` 或 `../` 开头才参与闭合检查。 */
const RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//;

/** 递归收集目录下所有 `.js`；排序只为让报错顺序稳定。 */
function collectJavaScriptFiles(directory) {
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
    }
  };
  visit(directory);
  return files.sort();
}

/** 副本内路径统一用 `/`，报错在任何平台上都可读。 */
function displayPath(copyRoot, path) {
  return relative(copyRoot, path).replaceAll('\\', '/');
}

/**
 * `files` 条目的口径是「相对 `miniprogram/`」，而 `copyRoot` 既可能是副本根目录
 * （其下还有 `miniprogram/`），也可能直接是小程序目录；两种都归一成同一种写法。
 */
function normalizeEntry(entry) {
  return String(entry)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^miniprogram\//, '');
}

/** 目标是否登记在本次清单里：清单按文件登记，所以把三种解析候选都算上。 */
function manifestState({ copyRoot, base, entries }) {
  const relativeBase = displayPath(copyRoot, base).replace(/^miniprogram\//, '');
  const candidates = [relativeBase, relativeBase + '.js', relativeBase + '/index.js'];
  return candidates.some(candidate => entries.has(candidate))
    ? '清单里有但没复制成功'
    : '清单里没有';
}

/**
 * 递归扫描 `copyRoot` 下所有 `.js` 的相对 require，并断言每一条都能解析到文件。
 *
 * @param {object} options
 * @param {string} options.copyRoot 副本根目录（`<root>/.local/wechat-<mode>`）。
 * @param {string[]} [options.entries] 本次复制清单，用于在报错里区分「清单里没有」与「清单里有但没复制成功」。
 * @returns {{ scannedFiles: number, requires: number, dangling: Array<{ file: string, specifier: string, resolved: string }> }}
 * @throws {Error} 只要存在一条悬空的相对 require 就抛出，消息逐条点名文件、specifier 与解析目标。
 */
export function assertRequireClosure({ copyRoot, entries = [] } = {}) {
  const files = collectJavaScriptFiles(copyRoot);
  const manifest = new Set(entries.map(normalizeEntry));
  const dangling = [];
  let requires = 0;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(REQUIRE_PATTERN)) {
      const specifier = match[2];
      if (!RELATIVE_SPECIFIER_PATTERN.test(specifier)) continue;
      requires += 1;
      const base = resolve(dirname(file), specifier);
      // 与 Node 的常见解析顺序一致：精确文件、补 `.js`、目录下的 `index.js`。
      const candidates = [base, base + '.js', join(base, 'index.js')];
      if (candidates.some(candidate => existsSync(candidate))) continue;
      dangling.push({ file: displayPath(copyRoot, file), specifier, resolved: base });
    }
  }

  if (dangling.length !== 0) {
    const lines = dangling.map(item =>
      '· ' + item.file + ' -> ' + item.specifier + '（解析到 ' + item.resolved + '）—— ' +
      manifestState({ copyRoot, base: item.resolved, entries: manifest }));
    throw new Error(
      '副本里存在悬空的相对 require：' + dangling.length + ' 处（复制清单没覆盖，运行时 MODULE_NOT_FOUND）\n' +
      lines.join('\n') + '\n' +
      '把目标文件加进 tools/prepare-wechat.mjs 的 files 清单。',
    );
  }

  return { scannedFiles: files.length, requires, dangling };
}

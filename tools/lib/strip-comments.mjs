/**
 * 去注释（**保留行号**）的逐字符状态机 —— 结构钉子判据的公共前置步骤。
 *
 * > 阅读约定：本文里的 `*\/` 表示块注释的**闭合二字符**（星号紧跟斜杠）。这里不写那两个字符本身，
 * > 否则本注释会在讲它的那一行把自己闭合掉——这正是下面要修的缺陷的同一种病。
 *
 * ## 为什么需要它（缺陷，不只是洁癖）
 *
 * 结构钉子惯用「先把注释抹掉、再在剩下的代码里找符号」来避免「注释里提了一嘴函数名就算违规」。
 * 常见写法是惰性正则：
 *
 *     source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
 *
 * 这个正则**不知道自己在注释里**，只要文本里出现 `/**` 形状（最典型的是把仓内路径写成
 * `services/api/src/**` 这种 glob），它就会把 `/**` 里的开注释二字符当成新的注释开头，
 * 一路吃到**下一个**闭合二字符——而那中间是真实代码：
 *
 * - **误红**：注释正文里的符号留在「代码」里 ⇒ 判据看见一条根本不存在的行为。
 *   典型形状：docblock 里写 `services/api/src/**\/*.ts`，`**\/` 让惰性匹配提前闭合，
 *   注释后半段（可能提到被钉的符号）整体变成「代码」。
 * - **假绿**：字符串字面量里写 `'services/api/src/**'`，其中的开注释二字符被当成注释开头，
 *   一路吃到下一处闭合二字符，**真实代码连同违规写法一起被删掉** ⇒ 判据看不见它。
 *
 * 两个方向同一个根因：**正则没有状态**。本模块用显式状态机取代它。
 *
 * ## 规则（状态 × 输入 → 动作）
 *
 * | 状态 | 看到 | 动作 |
 * | --- | --- | --- |
 * | 代码 | 双斜杠 | 进「行注释」，两个字符都置空 |
 * | 代码 | 斜杠加星号 | 进「块注释」，两个字符都置空（`/**` 天然包含在内） |
 * | 代码 | `'` / `"` | 进对应字符串态，引号**保留** |
 * | 代码 | 反引号 | 进模板态，反引号**保留** |
 * | 代码（由模板插值进入） | 插值开头 | 压栈、花括号深度归零，继续按**代码**处理插值 |
 * | 代码 | `{` / `}` | 维护花括号深度；深度归零且栈非空 ⇒ 插值结束，回模板态 |
 * | 行注释 | 任意（不含换行） | 置空 |
 * | 行注释 | 换行 | 回「代码」，换行**原样输出** |
 * | 块注释 | 闭合二字符 | 回「代码」，两个字符都置空 |
 * | 块注释 | 其它（**含开注释二字符，含 `/**`**） | 置空——只有闭合二字符能结束块注释，`/**` 既不能终止也不能另起 |
 * | 字符串 | 反斜杠 | 与下一字符**成对**原样输出（双斜杠、开注释二字符在串里都不是注释） |
 * | 字符串 | 自身引号 | 回「代码」，引号保留 |
 * | 字符串 | 未转义换行 | 回「代码」（普通字符串不能跨行；反斜杠续行已在上一条成对吃掉） |
 * | 模板 | 反斜杠 / 自身反引号 | 同上 |
 * | 模板 | 插值开头 | 按上面「代码」的插值规则处理 |
 *
 * ## 行号保留
 *
 * **换行符永远原样输出**，注释里的非换行字符逐个替换为一个空格（`placeholder`）。于是：
 *
 * - 输出的行数与输入**逐行相等**（`split('\n')` 长度一致）⇒ 报错里的行号可以直接念；
 * - 注释字符被换成等长空格 ⇒ 列偏移也不漂移；
 * - 整行注释变成一行空白 ⇒ 视觉上就是「空行占位」。
 *
 * ## 明确的边界（本工具**不**处理，均已在证据页登记）
 *
 * - 正则字面量里的开注释二字符（例如字符类里同时含斜杠与星号）会被当成块注释开头。JS 的
 *   「除号 vs 正则」需要上下文解析，本工具不做；扫描面已用 `git grep` 确认没有这种形态（见证据页 §3）。
 * - 模板插值里再嵌模板、插值里花括号不平衡的畸形源码：按字符计深度，畸形输入结果不可信。
 * - 注释指令（如 `@ts-expect-error`）与 `#!` shebang 都按普通注释/普通文本处理。
 * - 本工具**只**做「抹注释」，不解析语法，也不保证输出是合法 JS/TS。
 *
 * ⛔ 本模块不读文件、不碰 IO、不看环境变量：纯函数，便于在测试里直接构造样例。
 */

const STATE_CODE = 'code';
const STATE_LINE_COMMENT = 'line-comment';
const STATE_BLOCK_COMMENT = 'block-comment';
const STATE_SINGLE_QUOTED = 'single-quoted';
const STATE_DOUBLE_QUOTED = 'double-quoted';
const STATE_TEMPLATE = 'template';

const QUOTE_OF = new Map([
  [STATE_SINGLE_QUOTED, "'"],
  [STATE_DOUBLE_QUOTED, '"'],
]);

/**
 * 把源码里的注释抹成空白，**不改变行数与列偏移**。
 *
 * @param {string} source 原始源码文本。
 * @param {{ placeholder?: string }} [options] `placeholder` 是注释字符的替身（默认一个空格；
 *   必须是单个、且不是换行符的字符，否则抛 `TypeError`——用换行当替身会直接毁掉行号口径）。
 * @returns {string} 与 `source` 行数相同、注释位置被 `placeholder` 填满的文本。
 */
export function stripComments(source, options = {}) {
  if (typeof source !== 'string') {
    throw new TypeError('stripComments 需要字符串源码（收到：' + typeof source + '）');
  }
  const placeholder = options.placeholder === undefined ? ' ' : options.placeholder;
  if (typeof placeholder !== 'string' || placeholder.length !== 1) {
    throw new TypeError('placeholder 必须是单个字符（收到：' + JSON.stringify(placeholder) + '）');
  }
  if (placeholder === '\n' || placeholder === '\r') {
    throw new TypeError('placeholder 不得是换行符：它会破坏「输出行数 === 输入行数」这条口径');
  }

  const out = [];
  let state = STATE_CODE;
  /** 当前插值层的花括号深度；不在插值里时对顶层 `{}` 同样增减，无害。 */
  let braceDepth = 0;
  /** 模板插值栈：每层记住**进入插值前**的花括号深度，闭合时还原。 */
  const templateStack = [];

  const blank = () => out.push(placeholder);

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // 换行符：一切状态下都原样输出（行号口径的唯一保证）。
    if (ch === '\n' || ch === '\r') {
      out.push(ch);
      if (state === STATE_LINE_COMMENT) {
        state = STATE_CODE;
      } else if (state === STATE_SINGLE_QUOTED || state === STATE_DOUBLE_QUOTED) {
        // 普通字符串不能跨行；能走到这里说明该行字符串没闭合（反斜杠续行已在转义分支成对吃掉）。
        // 复位而不是继续吞：畸形源码最多让本行判据失真，不会把余下全文变成字符串。
        state = STATE_CODE;
      }
      i += 1;
      continue;
    }

    // 字符串／模板里的转义：与下一字符成对原样输出。这条必须排在注释判定之前，
    // 否则串里被转义的斜杠可能被误当成注释开头。
    if (
      (state === STATE_SINGLE_QUOTED || state === STATE_DOUBLE_QUOTED || state === STATE_TEMPLATE) &&
      ch === '\\'
    ) {
      out.push(ch);
      if (next !== undefined) out.push(next);
      i += next === undefined ? 1 : 2;
      continue;
    }

    switch (state) {
      case STATE_LINE_COMMENT: {
        blank();
        i += 1;
        break;
      }

      case STATE_BLOCK_COMMENT: {
        // ⚠ 这里**只**认闭合二字符。注释正文里的开注释二字符 / `/**` 一律当普通字符吞掉：
        // 既不能提前终止本注释，也不能另起一层（JS 块注释不嵌套，`/**` 只是块注释的一种开头）。
        if (ch === '*' && next === '/') {
          state = STATE_CODE;
          blank();
          blank();
          i += 2;
          break;
        }
        blank();
        i += 1;
        break;
      }

      case STATE_SINGLE_QUOTED:
      case STATE_DOUBLE_QUOTED: {
        if (ch === QUOTE_OF.get(state)) state = STATE_CODE;
        out.push(ch);
        i += 1;
        break;
      }

      case STATE_TEMPLATE: {
        if (ch === '`') {
          state = STATE_CODE;
          out.push(ch);
          i += 1;
          break;
        }
        if (ch === '$' && next === '{') {
          templateStack.push(braceDepth);
          braceDepth = 0;
          state = STATE_CODE;
          out.push(ch);
          out.push(next);
          i += 2;
          break;
        }
        out.push(ch);
        i += 1;
        break;
      }

      default: {
        // STATE_CODE
        if (ch === '/' && next === '/') {
          state = STATE_LINE_COMMENT;
          blank();
          blank();
          i += 2;
          break;
        }
        if (ch === '/' && next === '*') {
          state = STATE_BLOCK_COMMENT;
          blank();
          blank();
          i += 2;
          break;
        }
        if (ch === "'") {
          state = STATE_SINGLE_QUOTED;
          out.push(ch);
          i += 1;
          break;
        }
        if (ch === '"') {
          state = STATE_DOUBLE_QUOTED;
          out.push(ch);
          i += 1;
          break;
        }
        if (ch === '`') {
          state = STATE_TEMPLATE;
          out.push(ch);
          i += 1;
          break;
        }
        if (ch === '{') {
          braceDepth += 1;
          out.push(ch);
          i += 1;
          break;
        }
        if (ch === '}') {
          if (templateStack.length > 0 && braceDepth === 0) {
            braceDepth = templateStack.pop();
            state = STATE_TEMPLATE;
          } else if (braceDepth > 0) {
            braceDepth -= 1;
          }
          out.push(ch);
          i += 1;
          break;
        }
        out.push(ch);
        i += 1;
        break;
      }
    }
  }

  return out.join('');
}

/**
 * 把 `text` 里的字符下标换算成 **1 起算**的行号（只数换行符，CRLF 算一行）。
 *
 * 与 `stripComments` 配套：抹注释不改行数，所以在抹过的文本上算出的行号就是原文件的行号。
 *
 * @param {string} text 任意文本。
 * @param {number} index 字符下标（越界会被夹到 `[0, text.length]`）。
 * @returns {number} 行号，从 1 开始。
 */
export function lineNumberAt(text, index) {
  if (typeof text !== 'string') {
    throw new TypeError('lineNumberAt 需要字符串（收到：' + typeof text + '）');
  }
  if (!Number.isFinite(index)) {
    throw new TypeError('lineNumberAt 需要有限的字符下标（收到：' + String(index) + '）');
  }
  const limit = Math.min(Math.max(Math.trunc(index), 0), text.length);
  let line = 1;
  for (let i = 0; i < limit; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * 在抹过注释的文本里找出 `needle` 的全部出现位置，并带上**原文件行号**。
 *
 * 报错信息想写「第几行」时用这个，不要自己再数：数错一次就会把读者指到别处。
 *
 * @param {string} text 通常是 `stripComments(...)` 的输出。
 * @param {string} needle 要查找的字面量子串（空串返回空数组，不做无限涨的傻事）。
 * @returns {Array<{ index: number, line: number, endLine: number }>}
 */
export function occurrencesWithLines(text, needle) {
  if (typeof text !== 'string') {
    throw new TypeError('occurrencesWithLines 需要字符串文本（收到：' + typeof text + '）');
  }
  if (typeof needle !== 'string' || needle.length === 0) {
    return [];
  }
  const found = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    found.push({
      index,
      line: lineNumberAt(text, index),
      endLine: lineNumberAt(text, index + needle.length),
    });
    from = index + needle.length;
  }
  return found;
}

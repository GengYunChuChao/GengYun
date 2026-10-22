/**
 * GY-I15（#15）· F13 注销保留：**保留正文**时对个人信息做可核查的清除。
 *
 * 依据 `docs/implementation-requirements.md` F13（第 280 行）：
 * 「保留正文／附件清除联系方式、精确位置等个人信息；不能可靠脱敏的媒体隐藏／移除。」
 *
 * ## 边界（如实声明，不得误读）
 *   - 这是**确定性模式清除**（手机号／座机／邮箱／身份证号／小区门牌级住址），不是内容理解，
 *     **不是**"已识别全部个人信息"的证明。识别不到的形态仍可能留在正文里，本模块不谎称全清。
 *   - 清除是**结构性替换**：命中片段整体替换为 `_[个人信息已清除]_`，不保留原文、不保留长度，
 *     无法由替换结果反推原值。
 *   - **不改写**任何非个人信息文本：没有命中就**逐字不动**（调用方据此判断"是否需要重审"）。
 *   - 规则层（`packages/moderation` 的 MR-04/MR-05）在**发布时**就拦手机号/身份证/地址链；
 *     本模块处理的是**存量行**与规则层未覆盖的形态（邮箱、座机、小区门牌）。两者不互相替代。
 *
 * ## 为什么占位符带方括号
 * 前端与审核员要能一眼看出"这里原来有个人信息、已被清除"，而不是读到一句被静默改得不通顺的话；
 * 同时占位符本身不含数字/字母连续串，不会被本模块的模式再次命中。
 */

/** 命中片段的统一替换文本（不含任何原值片段）。 */
export const PERSONAL_INFO_PLACEHOLDER = '_[个人信息已清除]_';

export interface PersonalInfoRedaction {
  /** 清除后的文本。 */
  text: string;
  /** 被清除的**片段数**（不是字符数；0 表示逐字未动）。 */
  removed: number;
}

interface Rule {
  /** 规则名（只进诊断，不含命中原文）。 */
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * 模式顺序＝从"最具体/最长"到"最一般"：身份证先于手机号（18 位里可能含 11 位手机号形态），
 * 带标签的联系方式先于裸号码（尽量把"电话：xxx"整体清掉，而不是留下标签+占位符的残句）。
 */
const RULES: readonly Rule[] = Object.freeze([
  {
    name: 'id_card',
    pattern: /(?<![0-9A-Za-z])\d{17}[0-9Xx](?![0-9A-Za-z])/g,
  },
  {
    name: 'labeled_id_card',
    pattern: /(?:身份证|证件)(?:号(?:码)?)?\s*[:：]?\s*[0-9Xx]{15,18}/g,
  },
  {
    name: 'labeled_contact',
    pattern: /(?:联系电话|联系方式|电话|手机|座机|传真)\s*[:：]?\s*\d[\d\s-]{5,14}\d/g,
  },
  {
    name: 'mobile',
    pattern: /(?<![0-9A-Za-z])1[3-9]\d(?:[\s-]?\d{4}){2}(?![0-9A-Za-z])/g,
  },
  {
    name: 'landline',
    pattern: /(?<![0-9A-Za-z])0\d{2,3}[-—－\s]?\d{7,8}(?![0-9A-Za-z])/g,
  },
  {
    name: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    name: 'im_handle',
    pattern: /(?:微信|WeChat|wechat|WECHAT|QQ|qq)\s*(?:号|ID|id)?\s*[:：]\s*[A-Za-z0-9_-]{4,24}/g,
  },
  {
    // 行政区划链 + 门牌级词（与 MR-05 的"同一句读段 ≥3 级 + 门牌"同一思路，但用于**清除**）。
    name: 'address_chain',
    pattern:
      /(?:[\u4e00-\u9fa5]{2,10}(?:省|自治区|市))?[\u4e00-\u9fa5]{2,10}(?:区|县)[\u4e00-\u9fa5]{0,12}(?:路|街|道|巷|镇|乡)[0-9]{1,5}(?:号|栋|幢|单元|室)/g,
  },
  {
    // 小区/村/院 + 栋/单元/室（不带行政区划的精确门牌，规则层不覆盖）。
    name: 'residence',
    // 至少要有 1 个门牌级词，否则「王村3亩地」这类正常农事描述会被误清（误清会迫使重审）。
    pattern:
      /[\u4e00-\u9fa5]{2,12}(?:小区|村|院|花园|公寓)[0-9]{1,5}(?:栋|幢|号楼)?(?:[0-9]{1,5}(?:单元|室|号|栋|幢|号楼))+/g,
  },
]);

function replacePattern(text: string, pattern: RegExp): { text: string; count: number } {
  // `String.prototype.replace` 的回调次数＝真实命中次数（空匹配不会发生：所有模式都要求至少 1 个字符）。
  let count = 0;
  const next = text.replace(pattern, () => {
    count += 1;
    return PERSONAL_INFO_PLACEHOLDER;
  });
  return { text: next, count };
}

/**
 * 清除文本中的个人信息片段。
 *
 * 只依赖输入字符串（无环境变量、无网络、无时钟），因此同一输入永远得到同一输出；
 * 调用方可以安全地在事务里对同一行重复调用（幂等：第二次 `removed` 为 0）。
 */
export function redactPersonalInfo(text: string): PersonalInfoRedaction {
  if (typeof text !== 'string' || text.length === 0) return { text: typeof text === 'string' ? text : '', removed: 0 };
  let current = text;
  let removed = 0;
  for (const rule of RULES) {
    // 每条规则单独计数：`lastIndex` 不影响（`replace` 用全局模式时每次从头扫）。
    const result = replacePattern(current, rule.pattern);
    current = result.text;
    removed += result.count;
  }
  return { text: current, removed };
}

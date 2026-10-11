/**
 * GY-I14 确定性硬规则审核层 · 文本匹配器。
 *
 * 纪律：
 *   1) 纯函数、确定性、无随机、无 I/O、无时间依赖；同一输入永远同一结果；
 *   2) 证据只回传**偏移与长度**，**绝不**回传命中原文——避免把手机号／身份证号／住址／坐标
 *      抄进结果、日志或 reason_codes（隐私红线）；
 *   3) 匹配器实现本身参与 `rule_version` 派生（见 rule-version.mjs）：改这里 = 改规则集 = 旧结果失效。
 *
 * 每个匹配器返回 `{ matched, field, offset, length, suppressed }`；
 * `suppressed` 记录被"否定护栏"压掉的命中数（用于回归与过度拦截审计）。
 */

/** 句读边界：否定词不能跨越标点去否定后文。 */
const BOUNDARY = /[，。；！？、,.!?;:\n\r（）()【】\[\]「」《》""'']/;

/** 默认否定词。 */
const DEFAULT_NEGATORS = Object.freeze([
  '不',
  '别',
  '禁止',
  '严禁',
  '勿',
  '莫',
  '避免',
  '无需',
  '没有必要',
  '没有',
]);

/** 单条规则最多接受的匹配数（防止病态输入放大成本）。 */
const MAX_MATCHES = 64;

/** 匹配器版本：改动匹配器语义时必须 +1（并会同步改变 rule_version）。 */
export const MATCHER_REVISIONS = Object.freeze({
  any_pattern: 1,
  negation_guarded_pattern: 1,
  address_chain: 1,
  coordinate_pair: 1,
  commerce_link: 1,
});

function toRegExp(pattern) {
  return pattern instanceof RegExp ? pattern : new RegExp(pattern, 'u');
}

function toGlobalRegExp(pattern) {
  const source = toRegExp(pattern);
  return source.flags.includes('g')
    ? new RegExp(source.source, source.flags)
    : new RegExp(source.source, `${source.flags}g`);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns ?? []) {
    const regex = toRegExp(pattern);
    const found = regex.exec(text);
    if (found) {
      return { offset: found.index, length: found[0].length };
    }
  }
  return null;
}

/** 命中窗口前是否存在否定词（以标点为界回溯）。 */
function isNegated(text, index, negators, window = 12) {
  const start = Math.max(0, index - window);
  const before = text.slice(start, index);
  let cut = -1;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (BOUNDARY.test(before[i])) {
      cut = i;
      break;
    }
  }
  const windowText = cut === -1 ? before : before.slice(cut + 1);
  return negators.some((negator) => windowText.includes(negator));
}

/** 任一模式命中（不设否定护栏）。 */
export function anyPattern(text, rule) {
  const found = firstMatch(text, rule.patterns);
  if (!found) return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0 };
  return { matched: true, field: 'text', offset: found.offset, length: found.length, suppressed: 0 };
}

/**
 * 任一模式命中，但被"否定护栏"压掉的匹配不算命中。
 *
 * 已知边界（如实登记）：这是**确定性启发式**，不是语义理解。
 * "不要把 A 和 B 混配" 被压掉（正确）；而 "不要单独用，要混配" 这种
 * "否定 + 转折" 句式在同一句读段内仍可能被误压掉（漏拦）。
 * 因此本层**不承担**语义级判断，语义覆盖由后续模型层增量补齐；
 * 漏拦风险登记在 docs/moderation/README.md 的已知限制一节。
 */
export function negationGuardedPattern(text, rule) {
  const negators = rule.negators ?? DEFAULT_NEGATORS;
  const window = rule.negation_window ?? 12;
  let suppressed = 0;
  let matchCount = 0;
  for (const pattern of rule.patterns ?? []) {
    const regex = toGlobalRegExp(pattern);
    let found = regex.exec(text);
    while (found !== null && matchCount < MAX_MATCHES) {
      matchCount += 1;
      if (isNegated(text, found.index, negators, window)) {
        suppressed += 1;
      } else {
        return { matched: true, field: 'text', offset: found.index, length: found[0].length, suppressed };
      }
      if (found.index === regex.lastIndex) regex.lastIndex += 1;
      found = regex.exec(text);
    }
  }
  return { matched: false, field: 'text', offset: null, length: 0, suppressed };
}

const SEGMENT_SPLIT = /[，。；！？,;!?\n\r、]/;
const ADMIN_TOKENS = ['省', '自治区', '市', '自治州', '盟', '地区', '区', '县', '旗', '乡', '镇', '街道', '村', '社区'];
const PRECISE_TOKENS = ['号', '室', '栋', '幢', '单元', '弄', '组', '队', '门牌', '号楼'];

/**
 * 精确住址链：同一句读段内出现 ≥3 个行政区划层级词，且其后还有门牌级词。
 * 只写"浙江省杭州市余杭区"这种层级地名不算（不拦截正常地区讨论）。
 */
export function addressChain(text, rule) {
  const minAdmin = rule.min_admin_levels ?? 3;
  let cursor = 0;
  for (const segment of text.split(SEGMENT_SPLIT)) {
    const offset = text.indexOf(segment, cursor);
    cursor = offset === -1 ? cursor : offset + segment.length;
    if (segment.length === 0) continue;
    const adminHits = ADMIN_TOKENS.filter((token) => segment.includes(token)).length;
    if (adminHits < minAdmin) continue;
    const lastAdmin = Math.max(...ADMIN_TOKENS.map((token) => segment.lastIndexOf(token)));
    const precise = PRECISE_TOKENS.find((token) => segment.indexOf(token) > lastAdmin);
    if (precise) {
      return { matched: true, field: 'text', offset, length: segment.length, suppressed: 0 };
    }
  }
  return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0 };
}

/**
 * 原始坐标：高精度十进制、经纬度键值、度分秒或 GPS 前缀四种形态任一命中。
 * 只写城市/地区名不算；不带小数位（如"纬度约三十度"）不算高精度坐标。
 */
export function coordinatePair(text, rule) {
  const found = firstMatch(text, rule.patterns);
  if (!found) return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0 };
  return { matched: true, field: 'text', offset: found.offset, length: found.length, suppressed: 0 };
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s，。；；、)）"'<>]+/gi;
const SHOP_HOST = /(?:^|\.)(taobao|tmall|jd|pinduoduo|yangkeduo|1688|weidian|youzan|douyin|kuaishou|xianyu)\.(?:com|cn|net|com\.cn)/i;
const STRONG_COMMERCE_CUE = /(购买|下单|批发|代购|团购|秒杀|包邮|优惠券|进店|货源)/;
const WEAK_COMMERCE_CUE = /(价格|店铺|链接|二维码|优惠|促销|便宜|出货)/;

/**
 * 购买/交易链接：命中已知电商域名；或文本存在交易语境词并附外链。
 * （F05／AC16：广告、购买链接、私下交易导流不发布。）
 */
export function commerceLink(text, rule) {
  const regex = new RegExp(URL_PATTERN.source, URL_PATTERN.flags);
  const cueWindow = rule.cue_window ?? 40;
  let found = regex.exec(text);
  while (found !== null) {
    const url = found[0];
    if (SHOP_HOST.test(url)) {
      return { matched: true, field: 'text', offset: found.index, length: url.length, suppressed: 0 };
    }
    if (STRONG_COMMERCE_CUE.test(text)) {
      return { matched: true, field: 'text', offset: found.index, length: url.length, suppressed: 0 };
    }
    const start = Math.max(0, found.index - cueWindow);
    const windowText = text.slice(start, found.index + url.length + cueWindow);
    if (WEAK_COMMERCE_CUE.test(windowText)) {
      return { matched: true, field: 'text', offset: found.index, length: url.length, suppressed: 0 };
    }
    if (found.index === regex.lastIndex) regex.lastIndex += 1;
    found = regex.exec(text);
  }
  return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0 };
}

/**
 * 匹配器登记表。**id 与实现源码共同参与 rule_version 派生**，
 * 因此任何语义改动都会使既有审核结果失效（宁多失效，不静默复用）。
 */
export const MATCHERS = Object.freeze({
  any_pattern: anyPattern,
  negation_guarded_pattern: negationGuardedPattern,
  address_chain: addressChain,
  coordinate_pair: coordinatePair,
  commerce_link: commerceLink,
});

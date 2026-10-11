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
 * `suppressed` 记录被"否定护栏"压掉的命中数，`cancelled` 记录被"取消词"顶掉否定的次数
 * （两者都只用于回归与过度拦截审计，不回传命中原文）。
 */

/** 句读边界：否定词与取消词都必须落在同一句读段内。 */
const BOUNDARY = /[，。；！？、,.!?;:\n\r（）()【】\[\]「」《》""'']/;

/**
 * 默认否定词。同一位置优先取最长匹配：`不要` 必须整体识别，
 * 否则会把 `不要` 里的 `要` 误当成"取消词"（见 DANGEROUS_NEGATION_CANCELLERS）。
 */
const DEFAULT_NEGATORS = Object.freeze([
  '不建议',
  '没有必要',
  '不要',
  '不用',
  '不必',
  '无需',
  '不能',
  '禁止',
  '严禁',
  '避免',
  '没有',
  '别',
  '甭',
  '勿',
  '莫',
  '不',
]);

/**
 * **危险类专用**的"否定取消词"。
 *
 * 背景（fail-open 方向返修）：「不要单独用而要混配」「不建议这么打但可以混着打」这类
 * **否定 + 转折/祈使**句式中，真正的危险请求在转折词**之后**；否定护栏若整句压掉，
 * 等于把危险用量/混配请求放行。危险用法与用量两类（`dangerous_usage` / `label_bound_dose`）
 * **宁可多拦**：同一句读段内、否定词之后出现下列任一词，否定护栏即失效，命中照常成立。
 *
 * 代价（如实事先声明）：`不要随意混配需要注意…` 这类**无标点**且恰好含「要／应」的句子
 * 可能被误拦。危险类接受该代价——漏拦（放行危险用量/混配）远比误拦严重。
 * 该列表只挂在 MR-01／MR-02／MR-03 上，其它类别的否定护栏行为完全不变。
 */
export const DANGEROUS_NEGATION_CANCELLERS = Object.freeze([
  '但',
  '但是',
  '而',
  '而是',
  '要',
  '应',
  '应该',
  '建议',
  '最好',
]);

/** 单条规则最多接受的匹配数（防止病态输入放大成本）。 */
const MAX_MATCHES = 64;

/** 取消词向后扫描的上限（限制在同一句读段内，且限制单条规则成本）。 */
const FORWARD_CLAUSE_LIMIT = 64;

/** 匹配器版本：改动匹配器语义时必须 +1（并会同步改变 rule_version）。 */
export const MATCHER_REVISIONS = Object.freeze({
  any_pattern: 1,
  negation_guarded_pattern: 3,
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

/**
 * 否定护栏判定。
 *
 * 第一步与旧实现完全一致：在命中点之前 **12 字符窗口内、以句读边界截断** 找否定词。
 * 第二步是本次返修新增的"取消"：**仅当规则声明了 `negation_cancellers`**（危险两类）时，
 * 从否定词之后一直看到本句读段末尾（含命中词之后，因为有「不能脱离标签**而**随意加倍」
 * 这种转折词出现在命中词之后的形态），若出现取消词，则**否定失效、命中成立**。
 *
 * @returns {{ negated: boolean, cancelled_by: string|null }}
 */
function evaluateNegation(text, index, rule) {
  const negators = rule.negators ?? DEFAULT_NEGATORS;
  const window = rule.negation_window ?? 12;
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
  const windowOffset = cut === -1 ? start : start + cut + 1;

  // 取最右侧的否定词（同一位置取最长），取消词只从它之后开始找。
  let negatorIndex = -1;
  let negatorLength = 0;
  for (let i = 0; i < windowText.length; i += 1) {
    for (const negator of negators) {
      if (!windowText.startsWith(negator, i)) continue;
      if (i > negatorIndex || (i === negatorIndex && negator.length > negatorLength)) {
        negatorIndex = i;
        negatorLength = negator.length;
      }
    }
  }
  if (negatorIndex === -1) return { negated: false, cancelled_by: null, truncated: false };

  const cancellers = rule.negation_cancellers;
  if (Array.isArray(cancellers) && cancellers.length > 0) {
    const from = windowOffset + negatorIndex + negatorLength;
    const stop = Math.min(text.length, index + FORWARD_CLAUSE_LIMIT);
    let clauseEnd = stop;
    let scanComplete = stop >= text.length;
    for (let i = index; i < stop; i += 1) {
      if (BOUNDARY.test(text[i])) {
        clauseEnd = i;
        scanComplete = true;
        break;
      }
    }
    const afterNegator = text.slice(from, clauseEnd);
    const cancelledBy = cancellers.find((word) => afterNegator.includes(word));
    if (cancelledBy !== undefined) return { negated: false, cancelled_by: cancelledBy, truncated: false };
    // 上界用尽且仍未走到句读段末尾：取消词可能在界外 ⇒ **不得**当作"否定成立"（那是 fail-open）。
    if (!scanComplete) return { negated: false, cancelled_by: null, truncated: true };
    return { negated: true, cancelled_by: null, truncated: false };
  }
  return { negated: true, cancelled_by: null, truncated: false };
}

/** 任一模式命中（不设否定护栏）。 */
export function anyPattern(text, rule) {
  const found = firstMatch(text, rule.patterns);
  if (!found) return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0, truncated: false };
  return { matched: true, field: 'text', offset: found.offset, length: found.length, suppressed: 0, truncated: false };
}

/**
 * 任一模式命中，但被"否定护栏"压掉的匹配不算命中；**危险类**的否定可被取消词顶掉。
 *
 * 行为分层（如实说明）：
 *   - 未声明 `negation_cancellers` 的规则（MR-04 无护栏；MR-07／MR-08／MR-09 走本匹配器）
 *     **完全保持原有语义**：「不代表完全没有残留」仍被压掉，不因本次返修而改变；
 *   - 声明了取消词的规则（MR-01／MR-02／MR-03）在"否定 + 转折/祈使"句式中**不再压掉命中**，
 *     宁可多拦——漏拦会放行危险混配与无依据用量，比误拦严重得多。
 *
 * 仍属**确定性启发式**，不是语义理解：取消词列表是有限闭集，未列出的转折说法
 * （如"不如""倒不如"）仍可能被压掉；语义级覆盖由后续模型层增量补齐。
 * 该残留限制登记在 docs/moderation/README.md 的已知限制一节。
 *
 * **限额纪律（返修轮 3，P1）**：本匹配器对候选匹配数有上界 `MAX_MATCHES`。
 * 上界一旦用尽而**仍有未检查的匹配**（或否定取消扫描被上界截断），就**不得**得出
 * "未命中"的结论——那会把未检查的尾部当作"干净"（fail-open）。
 * 此时返回 `truncated: true`，由引擎压到 `quarantined` + `hard_rule_passed=false`。
 */
export function negationGuardedPattern(text, rule) {
  let suppressed = 0;
  let cancelled = 0;
  let matchCount = 0;
  let truncated = false;
  for (const pattern of rule.patterns ?? []) {
    const regex = toGlobalRegExp(pattern);
    let found = regex.exec(text);
    while (found !== null) {
      // 限额已满且仍有未检查的匹配 ⇒ 截断，不得结论为"未命中"。
      if (matchCount >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      matchCount += 1;
      const verdict = evaluateNegation(text, found.index, rule);
      if (verdict.truncated) {
        // 否定取消扫描被上界截断：压不压掉都不可信，交回引擎 fail-closed。
        truncated = true;
        break;
      }
      if (!verdict.negated) {
        if (verdict.cancelled_by !== null) cancelled += 1;
        return {
          matched: true,
          field: 'text',
          offset: found.index,
          length: found[0].length,
          suppressed,
          cancelled,
          cancelled_by: verdict.cancelled_by,
          truncated: false,
        };
      }
      suppressed += 1;
      if (found.index === regex.lastIndex) regex.lastIndex += 1;
      found = regex.exec(text);
    }
    if (truncated) break;
  }
  return {
    matched: false,
    field: 'text',
    offset: null,
    length: 0,
    suppressed,
    cancelled,
    cancelled_by: null,
    truncated,
  };
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
      return { matched: true, field: 'text', offset, length: segment.length, suppressed: 0, truncated: false };
    }
  }
  return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0, truncated: false };
}

/**
 * 原始坐标：高精度十进制、经纬度键值、度分秒或 GPS 前缀四种形态任一命中。
 * 只写城市/地区名不算；不带小数位（如"纬度约三十度"）不算高精度坐标。
 */
export function coordinatePair(text, rule) {
  const found = firstMatch(text, rule.patterns);
  if (!found) return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0, truncated: false };
  return { matched: true, field: 'text', offset: found.offset, length: found.length, suppressed: 0, truncated: false };
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
      return { matched: true, field: 'text', offset: found.index, length: url.length, suppressed: 0, truncated: false };
    }
    if (STRONG_COMMERCE_CUE.test(text)) {
      return { matched: true, field: 'text', offset: found.index, length: url.length, suppressed: 0, truncated: false };
    }
    const start = Math.max(0, found.index - cueWindow);
    const windowText = text.slice(start, found.index + url.length + cueWindow);
    if (WEAK_COMMERCE_CUE.test(windowText)) {
      return { matched: true, field: 'text', offset: found.index, length: url.length, suppressed: 0, truncated: false };
    }
    if (found.index === regex.lastIndex) regex.lastIndex += 1;
    found = regex.exec(text);
  }
  return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0, truncated: false };
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

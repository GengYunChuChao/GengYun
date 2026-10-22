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

/** 分句（句读段）处理上界：防止病态输入把成本放大。 */
const MAX_SEGMENTS = 512;

/** 单个句读段内最多检查的候选出现次数（上界用尽即按"未判定"处理，不得当成未命中）。 */
const MAX_OCCURRENCES = 64;

/** 匹配器版本：改动匹配器语义时必须 +1（并会同步改变 rule_version）。 */
export const MATCHER_REVISIONS = Object.freeze({
  any_pattern: 1,
  negation_guarded_pattern: 3,
  address_chain: 1,
  coordinate_pair: 1,
  commerce_link: 1,
  exempted_pattern: 2,
  separator_tolerant_pattern: 1,
  sale_cooccurrence: 2,
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

/** 把文本切成「句读段」（含偏移），用于同分句判定与整段豁免。 */
function splitSegments(text) {
  const result = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const atEnd = i === text.length;
    if (!atEnd && !BOUNDARY.test(text[i])) continue;
    if (i > start) result.push({ offset: start, text: text.slice(start, i) });
    start = i + 1;
    if (result.length >= MAX_SEGMENTS) break;
  }
  return result;
}

/** 句读段与句子（MR-12 的共现窗口按"同一句"算，允许跨逗号、不允许跨句号）。 */
const SENTENCE_BOUNDARY = /[。；！？;!\?\n\r]/;

/** 把文本切成「句子」（按句末标点），用于"标的 × 交易信号"的距离窗口。 */
function splitSentences(text) {
  const result = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const atEnd = i === text.length;
    if (!atEnd && !SENTENCE_BOUNDARY.test(text[i])) continue;
    if (i > start) result.push({ offset: start, text: text.slice(start, i) });
    start = i + 1;
    if (result.length >= MAX_SEGMENTS) break;
  }
  return result;
}

/** 命中点所在的句读段（用于整段豁免判定）。 */
function clauseAt(text, index) {
  let start = index;
  while (start > 0 && !BOUNDARY.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !BOUNDARY.test(text[end])) end += 1;
  return text.slice(start, end);
}

/** 命中点所在的「句子」（按句末标点切分；举报/被骗类豁免的邻域判定以句为单位）。 */
function sentenceAt(text, index) {
  let start = index;
  while (start > 0 && !SENTENCE_BOUNDARY.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !SENTENCE_BOUNDARY.test(text[end])) end += 1;
  return text.slice(start, end);
}

/**
 * 举报/被骗**报告框**：第一人称作报告者（`我要举报`）或第一人称／对象作受事（`我被骗`、`被人举报`）。
 * 只被这个框命中的豁免不足以说明"在描述自己被举报/被骗"，还要过下面的独立售卖动作闸门。
 */
const REPORT_FRAME =
  /(?:我|我们|本人|咱|俺)[^，。；！？]{0,6}(?:举报|投诉|报案)|(?:我|我们|本人|咱|俺)[^，。；！？]{0,6}(?:被骗|上当|受骗|被诈骗|挨骗|被坑)|(?:被|遭)(?:人)?(?:举报|投诉|诈骗|骗)/;

/** `不要举报`、`别投诉` 是**请求别人别举报**，不是在自述被举报 ⇒ 不构成报告框。 */
const REPORT_PLEA = /(?:不要|别|请勿|切勿|勿|不许|不准|不能|不用|甭|莫)[^，。；！？]{0,4}(?:举报|投诉)/;

/**
 * 独立、明确的商业售卖／联系方式／下单动作。
 *
 * 存在理由（监工 1927 轮 [P1]）：只要整句出现「举报/被骗」就跳过意图匹配，
 * 会让 `不要举报我百草枯现货加微信下单` 这类句子连**独立的售卖与联系方式动作**一起被放行。
 * 这些动作不属于"举报/被骗"所描述的内容，必须照常命中。
 */
const INDEPENDENT_COMMERCE_ACTION =
  /(?:加|私)(?:我|你)?(?:的)?(?:微信|weixin|vx|V信|v信|威信|QQ)|(?:私|加|v)\s?(?:我|我一下)|(?:私聊|私下|私信)[^，。；！？]{0,8}(?:购买|下单|发货|交易|转账|便宜|优惠|订货)|扫码|扫[^，。；！？]{0,3}码|扫一扫|要的留言|联系我|加好友|面交|自提|转手|倒卖|便宜出|低价出|清仓|甩卖|包邮|一件代发|厂家直销|批发价|内部价|现货秒发|有货|现货|库存|出售|转让|(?:加微信|私聊|私信|微信|扫码|联系我)[^，。；！？]{0,6}(?:下单|购买|拍下)|(?:拍下|付款|转账)(?:就|即|马上|立刻)?(?:发|给|走)/;

/** 第三方转述框：`他让我加微信`、`有人私我` —— 独立动作是被举报/被骗的经过，不是发帖人自己在导流。 */
const THIRD_PARTY_ATTRIBUTION =
  /(?:他|她|对方|商家|卖家|微商|骗子|有人|那个人|别人)[^，。；！？]{0,4}(?:说|让|叫|要|喊|发|加|拉|私|卖|骗)/;

/**
 * 「报告／被骗」词表（规则侧 `report_exemptions` 的唯一定义，避免检测器与规则目录漂移）。
 *
 * 这些词本身**不再是充分豁免条件**：命中后还要过 `isReportContext()` 的主语／邻域判定。
 * 迁移自 MR-10 的 `exemptions`（原 `/举报|投诉|诈骗|被骗|上当/`）与 MR-12 的
 * `PROHIBITED_SALE_STATEMENT_EXEMPTIONS` 中的 `/举报|投诉|…/`。
 */
export const REPORT_CONTEXT_PATTERNS = Object.freeze([
  /举报|投诉|报案|受骗|被骗|上当|被诈骗|诈骗/,
]);

/** 把一段文本切成句读段原文（用于"独立动作是否被第三方转述"的逐段判定）。 */
function clauseTexts(text) {
  const clauses = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const atEnd = i === text.length;
    if (!atEnd && !BOUNDARY.test(text[i])) continue;
    if (i > start) clauses.push(text.slice(start, i));
    start = i + 1;
    if (clauses.length >= MAX_SEGMENTS) break;
  }
  return clauses;
}

/**
 * 举报/被骗语境是否成立（**主语／邻域判定**，替代"整句见到豁免词就放行"）。
 *
 * 三个条件同时成立才算"确实在描述自己被举报/被骗"：
 *   1) 句内存在报告框（`我要举报`／`我被骗`／`被人举报`）；
 *   2) 句内不是"请求别人别举报"（`不要举报我…`）；
 *   3) 句内没有**独立**的售卖/联系方式/下单动作——除该动作所在句读段有第三方转述（`他让我加微信`）。
 *
 * @returns {boolean} true ⇒ 举报类豁免成立（抑制命中）；false ⇒ 豁免不成立（照常命中）。
 */
export function isReportContext(text) {
  if (!REPORT_FRAME.test(text)) return false;
  if (REPORT_PLEA.test(text)) return false;
  for (const clause of clauseTexts(text)) {
    if (!INDEPENDENT_COMMERCE_ACTION.test(clause)) continue;
    if (THIRD_PARTY_ATTRIBUTION.test(clause)) continue;
    return false;
  }
  return true;
}

/**
 * 任一模式命中，但豁免成立时不算命中。豁免分两档：
 *
 * - `rule.exemptions`：**整句读段**口径，命中所在句读段出现陈述标记即豁免（产品／规则陈述：
 *   `私信通知`、`私聊功能已上线`、`请勿私下交易`）。
 * - `rule.report_exemptions`：**举报／被骗语境**口径，命中所在**句子**命中报告词、且
 *   `isReportContext()` 的主语／邻域判定通过才豁免（见上方 `isReportContext`）。
 *
 * 为什么报告词不能再走整段口径（监工 1927 轮 [P1]）：`/举报|投诉|诈骗|被骗|上当/` 只要在句读段
 * 任意位置命中就跳过意图匹配，于是 `不要举报我百草枯现货加微信下单`、`我这有百草枯现货，举报也没用`
 * 这类句子把**独立的售卖与联系方式动作**一起抹掉了。
 *
 * 代价（如实事先声明）：`exemptions` 仍是整段口径，`平台禁止私聊下单，但我可以私聊你`
 * 这类"陈述+导流"同段混写依旧被豁免放行；`report_exemptions` 的取舍是**宁可误拦报告、
 * 不放行售卖**——句内出现独立售卖动作时按命中处理。
 */
export function exemptedPattern(text, rule) {
  const exemptions = rule.exemptions ?? [];
  const reportExemptions = rule.report_exemptions ?? [];
  let suppressed = 0;
  let matchCount = 0;
  let truncated = false;
  for (const pattern of rule.patterns ?? []) {
    const regex = toGlobalRegExp(pattern);
    let found = regex.exec(text);
    while (found !== null) {
      if (matchCount >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      matchCount += 1;
      const clause = clauseAt(text, found.index);
      const sentence = sentenceAt(text, found.index);
      const statementExempt = exemptions.some((item) => toRegExp(item).test(clause));
      const reportExempt =
        reportExemptions.length > 0 &&
        reportExemptions.some((item) => toRegExp(item).test(sentence)) &&
        isReportContext(sentence);
      if (statementExempt || reportExempt) {
        suppressed += 1;
        if (found.index === regex.lastIndex) regex.lastIndex += 1;
        found = regex.exec(text);
        continue;
      }
      return {
        matched: true,
        field: 'text',
        offset: found.index,
        length: found[0].length,
        suppressed,
        truncated: false,
      };
    }
    if (truncated) break;
  }
  return { matched: false, field: 'text', offset: null, length: 0, suppressed, truncated };
}

/** 拆分关键词时常用的分隔符（空格、全角空格、间隔号、下划线、连字符）。 */
const SEPARATOR = /[\s\u3000\u00a0·・‧∙∗*_\-—–－]/;

/** 去掉分隔符并保留"压缩后位置 → 原文位置"的映射。 */
function compactWithMap(text) {
  let compact = '';
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    if (SEPARATOR.test(text[i])) continue;
    compact += text[i];
    map.push(i);
  }
  return { compact, map };
}

/**
 * 分隔符容忍匹配（先原文、再"去分隔符"文本），用于提示注入这类**故意拆字规避**的输入。
 *
 * 背景（改前真红）：`忽 略 你 收 到 的 规 则` 这类在关键词里插空格/间隔号的表述，
 * 逐字模式全部漏拦（与 #420 在输出侧踩过的「绝 对 安 全」同一手法，这里是输入侧）。
 * 代价（如实事先声明）：压缩后跨词意外拼出关键词的极少数正常句子可能被误拦。
 */
export function separatorTolerantPattern(text, rule) {
  const direct = firstMatch(text, rule.patterns);
  if (direct) {
    return {
      matched: true,
      field: 'text',
      offset: direct.offset,
      length: direct.length,
      suppressed: 0,
      truncated: false,
    };
  }
  const { compact, map } = compactWithMap(text);
  if (compact.length === 0) {
    return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0, truncated: false };
  }
  const tolerant = firstMatch(compact, rule.patterns);
  if (!tolerant || tolerant.length < 1) {
    return { matched: false, field: 'text', offset: null, length: 0, suppressed: 0, truncated: false };
  }
  const start = map[tolerant.offset];
  const end = map[tolerant.offset + tolerant.length - 1] + 1;
  return { matched: true, field: 'text', offset: start, length: end - start, suppressed: 0, truncated: false };
}

/** 列出 words 在 segment 中的出现位置（上界 MAX_OCCURRENCES）。 */
function collectOccurrences(segment, words) {
  const hits = [];
  for (let i = 0; i < segment.length && hits.length < MAX_OCCURRENCES; i += 1) {
    for (const word of words) {
      if (word.length > 0 && segment.startsWith(word, i)) {
        hits.push({ index: i, length: word.length, word });
        break;
      }
    }
  }
  return hits;
}

/**
 * 标的 × 交易信号共现（禁售／限用农药的售卖与私下转让）。
 *
 * 判定：**同一句**（按句末标点切分，允许跨逗号）内同时出现标的与信号，且两者相距
 * ≤ `max_distance` 字。豁免分两档，与 `exemptedPattern` 一致：
 * - `rule.exemptions`：规则陈述／普法／急救，整句口径直接豁免；
 * - `rule.report_exemptions`：举报／被骗，必须过 `isReportContext()` 的主语／邻域判定
 *   （句内出现独立售卖动作时**不**豁免，见监工 1927 轮 [P1]：
 *   `我这有百草枯现货，被骗过的人互相提醒` 这类句子不能因为顺带一个报警词就整句放行）。
 * 只提标的不算（`百草枯毒性很强` 不拦），只提信号也不算（`到货通知` 不拦），
 * 标的与信号跨句号（`……登记早就到期了。价格我记不清`）不算共现。
 */
export function saleCooccurrence(text, rule) {
  const targets = rule.targets ?? [];
  const signals = rule.signals ?? [];
  const maxDistance = rule.max_distance ?? 24;
  const exemptions = rule.exemptions ?? [];
  const reportExemptions = rule.report_exemptions ?? [];
  let inspected = 0;
  for (const segment of splitSentences(text)) {
    if (segment.text.length === 0) continue;
    inspected += 1;
    if (inspected > MAX_SEGMENTS) break;
    if (exemptions.some((item) => toRegExp(item).test(segment.text))) continue;
    if (
      reportExemptions.length > 0 &&
      reportExemptions.some((item) => toRegExp(item).test(segment.text)) &&
      isReportContext(segment.text)
    ) {
      continue;
    }
    const targetHits = collectOccurrences(segment.text, targets);
    if (targetHits.length === 0) continue;
    const signalHits = collectOccurrences(segment.text, signals);
    if (signalHits.length === 0) continue;
    let best = null;
    for (const target of targetHits) {
      for (const signal of signalHits) {
        const distance = Math.abs(signal.index - target.index);
        if (best === null || distance < best.distance) best = { distance, target, signal };
      }
    }
    if (best === null || best.distance > maxDistance) continue;
    const start = Math.min(best.target.index, best.signal.index);
    const end = Math.max(
      best.target.index + best.target.length,
      best.signal.index + best.signal.length,
    );
    return {
      matched: true,
      field: 'text',
      offset: segment.offset + start,
      length: end - start,
      suppressed: 0,
      truncated: false,
    };
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
  exempted_pattern: exemptedPattern,
  separator_tolerant_pattern: separatorTolerantPattern,
  sale_cooccurrence: saleCooccurrence,
});

/**
 * GY-I14 确定性硬规则审核层 · 规则集**集中定义处**（唯一事实来源）。
 *
 * 设计纪律：
 *   - 规则全部在这里声明，便于一次性审计；**不得**在引擎里散落硬编码判断；
 *   - 每条规则有稳定标识（`id`）、类别（`category`）、原因码（`reason_code`）与说明（`title`/`description`）；
 *   - 全部确定性：无随机、无时间、无 I/O；同一文本永远同一结论；
 *   - 规则集**内容**（含匹配器实现源码）派生 `rule_version`，见 rule-version.mjs。
 *
 * 类别覆盖（派单 §3 最低要求 + F05/AC16 商业禁止）：
 *   dangerous_usage    危险用法／处方混配、脱离标签的随意加量
 *   label_bound_dose   用量脱离登记制剂与标签条件
 *   privacy            手机号／身份证号／精确住址、原始坐标
 *   prompt_injection   提示注入／越权指令
 *   authority_spoofing 伪权威／专家认证冒用／社区经验当官方结论
 *   safety_claim       "绝对安全"承诺／保证无残留
 *   commerce           广告、购买链接、私下交易导流、禁售／限用农药售卖（F05、AC16）
 *
 * 隐私说明：规则的 reason_code 与证据**只含偏移**，不含命中原文（见 matchers.mjs）。
 */
import { DANGEROUS_NEGATION_CANCELLERS, MATCHERS, MATCHER_REVISIONS, REPORT_CONTEXT_PATTERNS } from './matchers.mjs';
import {
  PROHIBITED_PESTICIDES,
  PROHIBITED_SALE_SIGNALS,
  PROHIBITED_SALE_STATEMENT_EXEMPTIONS,
} from './sale-targets.mjs';
import {
  ALL_REASON_CODES,
  REASON_CODE_MAX_LENGTH,
  REASON_CODE_MIN_LENGTH,
  RULE_CATEGORIES,
  RULE_SEVERITIES,
} from './constants.mjs';

/** 规则集（声明顺序即 reason_codes 的次级排序依据，保持稳定）。 */
export const RULES = Object.freeze([
  {
    id: 'MR-01',
    category: 'dangerous_usage',
    reason_code: 'DANGEROUS_MIX',
    title: '危险混配：要求把多种药剂混在一起施用',
    description:
      '命中"把 A 和 B 一起打""三瓶药混着打""混配／复配／交叉混用"等混配诉求。' +
      '带否定护栏：「不要随意混配」这类同句读段内相邻否定不命中；' +
      '但危险类**可被转折/祈使词取消否定**：「不要单独用而要混配」仍命中（宁可多拦）。',
    severity: 'block',
    matcher: 'negation_guarded_pattern',
    patterns: [
      /混配|复配/,
      /混(?:着|起来|在一块)?(?:一起)?(?:打|喷|拌|用|兑)/,
      /(?:几种|多种|两种|三瓶|几瓶|多瓶|几种药).{0,6}(?:一起|同时|一块|混)(?:打|喷|用|兑|拌)?/,
      /互相混用|交叉混用|混合使用/,
      /(?:把|将)[^，。；]{0,10}(?:和|跟|与)[^，。；]{0,10}(?:一起|同时)(?:打|喷|用|兑)/,
      // 口语形态（改前真红：「敌敌畏和百草枯一起打，效果更好」曾 approved 并 HTTP 201 公开）：
      // 没有「把／将」启句的「A 和 B 一起打/喷/兑/拌」同样属于混配诉求。
      // 起始位置显式避开否定词与祈使词（否则匹配会把「不 要」吞进左操作数，
      // 让否定护栏看不到否定词，等于把「不要把 A 和 B 一起打」判成命中）。
      // 谓词只收施用类动作（打/喷/兑/拌）；`一起用` 是兼容性提问的常态说法
      // （`除草剂可以和叶面肥一起用吗？` 属既有零误杀对照面，CI 上真实红过一次），
      // 因此「用」只放行「同时用」这一叠加施用形态，`一起用` 留给带「把/将」的上一条。
      /(?<![不勿莫别禁止要应])(?!(?:不要|不用|不必|无需|别|勿|莫|禁止|严禁))[^，。；]{1,12}(?:和|跟|与)[^，。；]{1,12}(?:(?:一起|同时|一块|混着)(?:打|喷|兑|拌)|同时用)/,
    ],
    negation_cancellers: DANGEROUS_NEGATION_CANCELLERS,
  },
  {
    id: 'MR-02',
    category: 'dangerous_usage',
    reason_code: 'DOSE_UNBOUNDED',
    title: '脱离标签的用量：随意加量、"加多少都行"',
    description:
      '命中"随便加""加多少都行""不用计量""浓度高点没关系"等不定量诉求；' +
      '这类诉求跳过登记制剂与标签条件，属于不得生成的用量口径。' +
      '危险类否定护栏可被转折/祈使词取消（宁可多拦）。',
    severity: 'block',
    matcher: 'negation_guarded_pattern',
    patterns: [
      /(?:随便|随意|任意|想加多少|爱加多少|胡乱).{0,8}(?:加|用|兑|掺|打)/,
      /(?:加|用|兑|掺).{0,4}(?:多少|多点|一些)?(?:都行|都可以|无所谓|没限制|没讲究)/,
      /(?:不用|不必|无需|没必要)(?:计量|过秤|称重|按量|计量器|量具)/,
      /(?:加|用|兑)(?:多|大)(?:点|些)(?:也)?(?:没事|没关系|无妨|不要紧)/,
      /浓度(?:高点|大点|多点)?(?:没|无)(?:关系|事|妨)/,
    ],
    negation_cancellers: DANGEROUS_NEGATION_CANCELLERS,
  },
  {
    id: 'MR-03',
    category: 'label_bound_dose',
    reason_code: 'DOSE_NOT_BOUND_TO_LABEL',
    title: '用量脱离登记制剂与标签条件',
    description:
      '命中"不用看标签""不管登记条件""直接加倍"等脱离标签／登记条件的用量指令；' +
      '原文用量必须绑定单位制剂与标签条件，此类内容不得发布。' +
      '危险类否定护栏可被转折/祈使词取消（宁可多拦）：如「不能脱离标签而随意加倍」。',
    severity: 'block',
    matcher: 'negation_guarded_pattern',
    patterns: [
      /(?:不用|不必|无需|别|不要)(?:看|管|理会|参考|遵守)(?:标签|说明书|登记|登记证)/,
      /(?:脱离|抛开|不管|无视)(?:标签|登记|说明书|条件)/,
      /标签(?:上|里|中)?(?:的)?(?:用量|条件|要求)?(?:不用|不必|别|甭)(?:管|看|理)/,
      /(?:不用|不必|无需)(?:管|看)(?:什么|啥)?(?:登记)?(?:制剂|条件)/,
      /(?:直接|就)(?:说|给|用|按)(?:我|这个)?(?:剂量|用量|毫升|克数)(?:就)?(?:行|可以|好)/,
    ],
    negation_cancellers: DANGEROUS_NEGATION_CANCELLERS,
  },
  {
    id: 'MR-04',
    category: 'privacy',
    reason_code: 'PRIVACY_PII',
    title: '隐私：手机号／身份证号',
    description:
      '命中中国大陆手机号、18 位身份证号或显式标注的身份证号；' +
      '本规则**不设否定护栏**——正文里出现真实号码本身就不该发布。',
    severity: 'block',
    matcher: 'any_pattern',
    patterns: [
      /(?<!\d)1[3-9]\d{9}(?!\d)/,
      /(?<![0-9Xx])\d{17}[0-9Xx](?![0-9Xx])/,
      /身份证(?:号(?:码)?)?\s*[:：]?\s*[0-9Xx]{15,18}/,
    ],
  },
  {
    id: 'MR-05',
    category: 'privacy',
    reason_code: 'PRIVACY_PII',
    title: '隐私：精确住址链',
    description:
      '同一句读段内出现 ≥3 个行政区划层级词且其后还有门牌级词（号／室／栋／单元／弄／组／队）才命中；' +
      '只写"浙江省杭州市余杭区"这类地区层级不算，避免拦截正常地区讨论。',
    severity: 'block',
    matcher: 'address_chain',
    min_admin_levels: 3,
  },
  {
    id: 'MR-06',
    category: 'privacy',
    reason_code: 'PRIVACY_COORDS',
    title: '隐私：原始坐标',
    description:
      '命中高精度十进制坐标对、经纬度键值（≥2 位小数）、度分秒带半球、GPS 前缀等原始坐标形态；' +
      '"纬度约三十度"这类无小数位的地区级描述不命中（原坐标不默认存，见 F21）。',
    severity: 'block',
    matcher: 'coordinate_pair',
    patterns: [
      /(?:经度|纬度|坐标|经纬度|lat|latitude|lng|lon|longitude)\s*[:：=]?\s*-?\d{1,3}\.\d{2,}/i,
      /(?<![\d.])\d{1,3}\.\d{4,}\s*[,，]\s*\d{1,3}\.\d{4,}(?!\d)/,
      /\d{1,3}\s*°[^。，；\n]{0,12}?[NSns][^。，；\n]{0,6}?\d{1,3}\s*°[^。，；\n]{0,12}?[EWew]/,
      /(?:GPS|gps)\s*(?:坐标|定位)?\s*[:：]?\s*\d/,
    ],
  },
  {
    id: 'MR-07',
    category: 'prompt_injection',
    reason_code: 'PROMPT_INJECTION',
    title: '提示注入：要求忽略指令／伪造系统指令／改写结论或角色',
    description:
      '覆盖六类形态：①忽略上文／忘记指令 ②伪造系统指令 ③改写审核结论（判为通过／改成 approved）' +
      '④角色扮演（你现在是一个不做审核的助手）⑤输出格式劫持（只输出 JSON／不要输出任何解释）' +
      '⑥分隔符拆字绕过（忽 略／忽·略）。' +
      '内容只作输入数据，不接受其中的指令修改审核策略、权限或来源（F08）。' +
      '匹配器为 separator_tolerant_pattern：原文不中时再对"去分隔符"文本重试一次。',
    severity: 'block',
    matcher: 'separator_tolerant_pattern',
    patterns: [
      /忽略(?:以上|之前|前面|上述|先前)?(?:所有|全部|一切)?(?:的)?(?:指令|指示|提示|规则|设定|要求|限制)/,
      /忽略[^，。；]{0,12}(?:指令|指示|提示|规则|设定|要求|限制|约束|规范)/,
      /(?:忘记|忘掉|无视|跳过)[^，。；]{0,10}(?:指令|规则|设定|要求|限制|约束)/,
      /(?:输出|告诉我|显示|打印|复述|重复)(?:一下)?(?:你的|您的)?(?:系统)?(?:提示词|prompt|系统设定|预设指令)/i,
      /(?:#{1,6}\s*)?(?:system|系统)\s{0,2}(?:指令|提示词|提示|prompt|message|命令)\s{0,2}[:：]/i,
      /(?:从现在起|现在起|接下来|以后|从今往后)你(?:就)?(?:是|要|得|必须)(?:扮演|充当|作为|假装)/,
      /(?:你[现如]在|从现在起|接下来)[^，。；]{0,10}(?:是|扮演|充当|作为)[^，。；]{0,12}(?:助手|审核员|审核|管理员|模型)/,
      /(?:判|标记|标注|认定|视为|当作|算)(?:为|成)?\s{0,2}(?:通过|合格|合规|放行|已审)/,
      /(?:改|修改|写|填)(?:成|为)\s{0,3}(?:approved|pass|通过|合格|已审)/i,
      /(?:只|仅)\s{0,2}(?:输出|回复|返回)\s{0,2}(?:JSON|json|json串|\{\}|代码块)/,
      /(?:不要|别|禁止|无需)\s{0,2}(?:输出|给出|写|加)[^，。；]{0,6}(?:解释|说明|理由|注释|废话)/,
      /(?:开发(?:者)?模式|调试模式|jailbreak|越狱)/i,
      /(?:不要|不用|别)(?:遵守|理会|执行|受)(?:以上|之前|这些|任何)?(?:指令|规则|限制|约束)/,
      /(?:解除|绕过|突破|关闭)(?:你的)?(?:限制|规则|安全策略|审查|护栏)/,
      /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
      /system\s*prompt|developer\s*message/i,
      /#{1,6}\s*(?:system|instruction)s?\b/i,
      /<\|?\s*(?:im_start|im_end|system)\s*\|?>|\[INST\]|<<\/?SYS>>/i,
    ],
  },
  {
    id: 'MR-08',
    category: 'authority_spoofing',
    reason_code: 'FALSE_AUTHORITY',
    title: '伪权威：冒充专家认证或把社区经验当官方结论',
    description:
      '命中自称专家／持证、声称机构认证背书、把"官方结论"挂在无依据内容上；' +
      'F05：不冒充专家或标"已验证安全"。否定护栏挡掉"我不是专家"这类自述。',
    severity: 'block',
    matcher: 'negation_guarded_pattern',
    patterns: [
      /(?:我|本人|咱)(?:是|就是)(?:资深|高级|著名|知名|认证|持证)?(?:农业|植保|农技|农药|作物)?(?:专家|教授|研究员|农艺师|博士|大师)/,
      /(?:认证|持证)(?:植保|农业|农技)?(?:专家|技师|农艺师|医师)/,
      /(?:专家|官方|权威|国家|农业农村部|农业部|农业局|农科院)(?:已经|已|均)?(?:认证|审核|认可|背书|推荐|指定|盖章)/,
      /(?:农业农村部|农业部|中国农科院|省农科院|农技推广中心)(?:推荐|指定|认证|背书|认可)/,
      /(?:官方|权威)(?:结论|说法|认定|背书)/,
    ],
  },
  {
    id: 'MR-09',
    category: 'safety_claim',
    reason_code: 'ABSOLUTE_SAFETY_CLAIM',
    title: '安全承诺：保证无残留／绝对安全',
    description:
      '命中"绝对安全""保证无残留""零残留放心用""永久有效／万能药"等绝对化承诺；' +
      '项目不得承诺绝对安全（AC14、需求红线）。否定护栏挡掉"不代表完全没有残留"这类限定说法。',
    severity: 'block',
    matcher: 'negation_guarded_pattern',
    patterns: [
      /(?:绝对|百分之百|100%|百分百|完全|肯定|保证|确保|一定).{0,6}(?:安全|无毒|无害|无残留|没有残留|零残留|不残留|不会有药害|不死苗|没风险)/,
      /(?:保证|确保|绝对|肯定).{0,4}(?:无|没有|零)(?:任何)?(?:残留|药害|风险|危害)/,
      /(?:无|没有|零)(?:任何)?(?:残留|药害|风险)(?:保证|绝对)?[，,]?(?:放心)/,
      /(?:放心|随便|尽管)(?:用|打|喷|使)[，,]?(?:绝对|肯定|保证)?(?:没事|安全|不会有事|出不了事)/,
      /永久有效|万能药|包治|一劳永逸|永远不会/,
    ],
  },
  {
    id: 'MR-10',
    category: 'commerce',
    reason_code: 'COMMERCE_SOLICITATION',
    title: '商业导流：加微信／私聊下单／面交／转手',
    description:
      '命中加微信、私聊下单、扫码购买、微店／拼团／代购、厂家直销／批发价、' +
      '口语导流（私我／v我／要的留言／面交／自提／转手／便宜出）等私下交易动作；' +
      'F05／AC16：广告、购买链接、私下交易导流不发布。' +
      '匹配器为 exempted_pattern：命中所在句读段命中 exemptions（产品陈述／规则陈述）时豁免' +
      '（`私信通知`、`私聊功能已上线`、`请勿私下交易`、`农药包装废弃物不得转手`）；' +
      '举报／被骗语境走 report_exemptions，须同时通过主语／邻域判定（`我要举报有人在群里私我卖百草枯` 豁免，' +
      '`不要举报我百草枯现货加微信下单`、`我这有百草枯现货，举报也没用` 照常命中）。',
    severity: 'block',
    matcher: 'exempted_pattern',
    patterns: [
      /(?:加|私)(?:我|你)?(?:的)?(?:微信|weixin|vx|V信|v信|威信|QQ)(?:号)?/i,
      /(?:私|加|v|微)\s?(?:我|我一下)(?:吧|哈|啊|就行|即可)?/i,
      /(?:私聊|私下|私信).{0,8}(?:购买|下单|发货|交易|转账|便宜|优惠|订货)/,
      /(?:要|需要|有意|想买|想卖|有要)(?:的|的话)?(?:私聊|私信|私我|留言|联系我|找我)/,
      /(?:扫码|扫一扫|长按)(?:购买|下单|进店|加|识别)/,
      /微店|拼团|代购|厂家直销|一件代发|批发价|内部价|低价出|现货秒发|免费寄样/,
      /(?:联系|找)我(?:购买|下单|买|发货|订货)/,
      /同城面交|面交|当面交易|自提|同城交易/,
      /转手|倒卖|甩卖/,
      /(?:便宜|低价|清仓|半价)(?:出|卖|处理)/,
      /(?:淘宝|天猫|京东|拼多多|闲鱼|抖音|快手)(?:店|店铺|链接|下单|同款|橱窗)/,
      /(?:优惠|促销|秒杀|下单|购买|团购|包邮).{0,8}(?:链接|二维码|店铺|微信)/,
    ],
    exemptions: [
      /私信通知|私聊功能|私信功能|私聊已(?:上线|开通)|私信已(?:上线|开通)/,
      /(?:请勿|不要|禁止|严禁|不得|不能|勿|莫)[^，。；]{0,8}(?:私下?交易|私下?买卖|私下?转账|转手|倒卖|面交|加好友)/,
    ],
    report_exemptions: REPORT_CONTEXT_PATTERNS,
  },
  {
    id: 'MR-11',
    category: 'commerce',
    reason_code: 'COMMERCE_LINK',
    title: '商业导流：外链指向电商或附交易语境',
    description:
      '命中淘宝／天猫／京东／拼多多／闲鱼等电商域名的外链；或正文存在强交易语境词（购买／下单／批发等），' +
      '或外链附近 40 字内出现弱交易语境词（价格／店铺／二维码等）。',
    severity: 'block',
    matcher: 'commerce_link',
    cue_window: 40,
  },
  {
    id: 'MR-12',
    category: 'commerce',
    reason_code: 'PROHIBITED_SALE',
    title: '禁售／限用农药的售卖与私下转让',
    description:
      '同一句内同时出现禁用／限用农药标的名与交易信号（有货／现货／私聊／私我／转手／便宜出等），' +
      '且两者相距 ≤24 字才命中（允许跨逗号，不跨句号：`甲胺磷，私我` 命中，' +
      '`……登记早就到期了。价格我记不清` 不命中）。' +
      '规则陈述、普法与急救句式整句豁免（exemptions）' +
      '（`百草枯已被禁用，误服请立即就医`、`敌敌畏中毒急救措施`、`关于甲胺磷限用的法规解读`、' +
      '`平台禁止售卖禁用农药`）；举报／被骗句式走 report_exemptions，须同时通过主语／邻域判定' +
      '（`我要举报有人在卖百草枯`、`我被人举报了，百草枯不是我卖的` 豁免；' +
      '`我这有百草枯现货，被骗过的人互相提醒`、`不要举报我，甲胺磷现货私我` 照常命中）。' +
      'F05／AC16：禁售农药的售卖与私下交易不发布。只覆盖文本层；图片与真实供应商仍属未取得。',
    severity: 'block',
    matcher: 'sale_cooccurrence',
    targets: PROHIBITED_PESTICIDES,
    signals: PROHIBITED_SALE_SIGNALS,
    max_distance: 24,
    exemptions: PROHIBITED_SALE_STATEMENT_EXEMPTIONS,
    report_exemptions: REPORT_CONTEXT_PATTERNS,
  },
]);

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,40}$/;

/** 支持 `report_exemptions`（举报／被骗语境豁免）的匹配器。 */
export const REPORT_CONTEXT_MATCHERS = Object.freeze(['exempted_pattern', 'sale_cooccurrence']);

/**
 * 校验规则集结构是否合法（供引擎自检与测试使用）。
 * **不抛错**，返回 `{ valid, errors }`；引擎在校验失败时按 fail-closed 隔离处理。
 */
export function validateRuleCatalog(rules = RULES, matchers = MATCHERS) {
  const errors = [];
  if (!Array.isArray(rules) || rules.length === 0) {
    return { valid: false, errors: ['规则集必须是非空数组'] };
  }
  const seen = new Set();
  for (const rule of rules) {
    const where = rule?.id ?? '(无 id)';
    if (!rule || typeof rule !== 'object') {
      errors.push('规则项必须是对象');
      continue;
    }
    if (typeof rule.id !== 'string' || !ID_PATTERN.test(rule.id)) {
      errors.push(`${where}: id 必须是 1..40 的稳定标识`);
    } else if (seen.has(rule.id)) {
      errors.push(`${where}: id 重复`);
    } else {
      seen.add(rule.id);
    }
    if (!RULE_CATEGORIES.includes(rule.category)) errors.push(`${where}: 未知类别 ${rule.category}`);
    if (typeof rule.reason_code !== 'string' || !ALL_REASON_CODES.includes(rule.reason_code)) {
      errors.push(`${where}: reason_code 不在自带闭集内`);
    } else if (
      rule.reason_code.length < REASON_CODE_MIN_LENGTH ||
      rule.reason_code.length > REASON_CODE_MAX_LENGTH
    ) {
      errors.push(`${where}: reason_code 长度必须为 ${REASON_CODE_MIN_LENGTH}..${REASON_CODE_MAX_LENGTH}`);
    }
    if (!RULE_SEVERITIES.includes(rule.severity)) errors.push(`${where}: 未知 severity ${rule.severity}`);
    if (typeof rule.title !== 'string' || rule.title.length === 0) errors.push(`${where}: 缺 title`);
    if (typeof rule.description !== 'string' || rule.description.length === 0) {
      errors.push(`${where}: 缺 description`);
    }
    if (typeof rule.matcher !== 'string' || typeof matchers[rule.matcher] !== 'function') {
      errors.push(`${where}: 未知匹配器 ${rule.matcher}`);
      continue;
    }
    if (rule.patterns !== undefined) {
      if (!Array.isArray(rule.patterns) || rule.patterns.length === 0) {
        errors.push(`${where}: patterns 必须是非空数组`);
      } else {
        for (const pattern of rule.patterns) {
          if (!(pattern instanceof RegExp)) {
            errors.push(`${where}: patterns 必须是 RegExp`);
            continue;
          }
          // 有状态的正则（g／y）会让"同一文本两次求值结果不同"，直接禁止。
          if (pattern.flags.includes('g') || pattern.flags.includes('y')) {
            errors.push(`${where}: patterns 不得带 g/y 标志（有状态，破坏确定性）`);
          }
        }
      }
    }
    // 豁免表：`exemptions`（整段口径）与 `report_exemptions`（举报语境口径）都必须是无状态模式表。
    for (const [field, value] of [
      ['exemptions', rule.exemptions],
      ['report_exemptions', rule.report_exemptions],
    ]) {
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.length === 0) {
        errors.push(`${where}: ${field} 必须是非空数组`);
        continue;
      }
      value.forEach((pattern, index) => {
        if (typeof pattern === 'string') {
          if (pattern.length === 0) errors.push(`${where}: ${field}[${index}] 不得为空字符串`);
          return;
        }
        if (!(pattern instanceof RegExp)) {
          errors.push(`${where}: ${field}[${index}] 必须是 RegExp`);
          return;
        }
        if (pattern.flags.includes('g') || pattern.flags.includes('y')) {
          errors.push(`${where}: ${field}[${index}] 不得带 g/y 标志（有状态，破坏确定性）`);
        }
      });
    }
    // 举报语境豁免只对支持"报告框＋主语/邻域判定"的匹配器生效，写错位置属于假配置。
    if (rule.report_exemptions !== undefined && !REPORT_CONTEXT_MATCHERS.includes(rule.matcher)) {
      errors.push(
        `${where}: report_exemptions 只对 ${REPORT_CONTEXT_MATCHERS.join('／')} 生效，当前匹配器为 ${rule.matcher}`,
      );
    }
    if (rule.negation_cancellers !== undefined) {
      // 否定取消词：只对否定护栏有效；写在不生效的匹配器上属于"看起来配了其实没用"，直接判非法。
      if (rule.matcher !== 'negation_guarded_pattern') {
        errors.push(`${where}: negation_cancellers 只对 negation_guarded_pattern 生效，当前匹配器为 ${rule.matcher}`);
      }
      if (
        !Array.isArray(rule.negation_cancellers) ||
        rule.negation_cancellers.length === 0 ||
        rule.negation_cancellers.some((word) => typeof word !== 'string' || word.length === 0)
      ) {
        errors.push(`${where}: negation_cancellers 必须是非空的非空字符串数组`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** 匹配器版本快照（与实现源码一起参与 rule_version 派生）。 */
export function matcherFingerprint(matchers = MATCHERS, revisions = MATCHER_REVISIONS) {
  return Object.keys(matchers)
    .sort()
    .map((id) => ({ id, revision: revisions[id] ?? null, source: String(matchers[id]) }));
}

/** 类别 -> 规则 id 清单（文档与测试复用）。 */
export function rulesByCategory(rules = RULES) {
  const grouped = {};
  for (const category of RULE_CATEGORIES) grouped[category] = [];
  for (const rule of rules) {
    if (!grouped[rule.category]) grouped[rule.category] = [];
    grouped[rule.category].push(rule.id);
  }
  return grouped;
}

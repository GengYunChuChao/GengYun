/**
 * GY-I14 模型层（第二片）· **prompt 定义**（唯一集中定义处，便于一次性审计）。
 *
 * 纪律（与规则层 `rules.mjs` 同构）：
 *   - prompt 文本集中在这里声明，**不得**散落在合流层里硬编码；
 *   - 全部确定性：无随机、无时间、无 I/O；
 *   - prompt 定义**内容**（含正文每一个字符）参与 `prompt_version` 派生（见 prompt-version.mjs），
 *     因此**改一个字就换版本**，旧结论随之失效（否则旧结论会被静默复用）。
 *
 * 边界（必须与派单 §7、PR 正文一致）：
 *   本文件只是**声明式 prompt 定义**，不发起任何请求、不持有凭据、不联网。
 *   真实模型调用一律由**注入式端口**承担（见 model-ports.mjs），应用装配路径在本阶段**永不提供**。
 *
 * 隐私：prompt 模板里的 `{{text}}` 只在**注入端口的请求对象**里被替换；本包不落盘、不打印正文。
 */

/** prompt 定义允许出现的键（未知键在派生时一律计入 `options`，不静默丢弃）。 */
export const PROMPT_DEFINITION_KEYS = Object.freeze([
  'id',
  'purpose',
  'system',
  'user_template',
  'placeholders',
  'required_output_fields',
  'verdict_labels',
  'policy_notes',
]);

/** 本片声明的 prompt id 闭集。 */
export const PROMPT_IDS = Object.freeze(['text_moderation', 'image_moderation']);

/**
 * 端口 kind -> prompt id 的**唯一**映射（不允许同一 kind 换 prompt 而不换版本）。
 * tms = 腾讯文本审核端口，ims = 腾讯图片审核端口；命名沿用 tools/ai-config.mjs 既有词汇。
 */
export const PROMPT_ID_BY_PORT_KIND = Object.freeze({
  tms: 'text_moderation',
  ims: 'image_moderation',
});

/**
 * prompt 定义（声明式）。
 *
 * `required_output_fields` 是**我们要求端口回报**的字段；端口回报缺字段即 `MODEL_RESPONSE_SHAPE_UNKNOWN`
 * （形状未知不得当作通过）。`model_version` 不在其中：它由端口的绑定声明回报，单独校验。
 */
export const PROMPT_DEFINITIONS = Object.freeze({
  text_moderation: Object.freeze({
    id: 'text_moderation',
    purpose:
      '文本内容模型侧筛查：识别危险用法与用量口径、隐私泄露、导流交易、伪权威与绝对安全承诺等风险。',
    system:
      '你是内容安全筛查组件。只对给定文本做风险分类，不回答农业技术问题，不生成用量、混配或处方建议。' +
      '不得复述原文中的手机号、住址、坐标或链接。',
    user_template:
      '目标类型：{{target_type}}\n' +
      '待筛查文本：\n{{text}}\n' +
      '请只输出 JSON：{"label":"pass|block|unsure","reason_codes":[...],"summary":"不超过 80 字的说明"}。',
    placeholders: Object.freeze(['target_type', 'text']),
    required_output_fields: Object.freeze(['label', 'reason_codes', 'summary']),
    verdict_labels: Object.freeze(['pass', 'block', 'unsure']),
    policy_notes: Object.freeze([
      '不得生成个人处方、混配或自动剂量换算；原文用量必须绑定单位制剂与标签条件。',
      '不确定时输出 unsure：unsure 一律不得被当成通过（见合流层的 fail-closed 口径）。',
    ]),
  }),
  image_moderation: Object.freeze({
    id: 'image_moderation',
    purpose:
      '图片内容模型侧筛查：识别图片中的联系方式、二维码、交易导流、危险操作与隐私信息。',
    system:
      '你是图片内容安全筛查组件。只对给定图片引用做风险分类，不猜测图片之外的上下文，不输出图片原文。' +
      '不得复述图片中出现的手机号、住址、坐标或二维码内容。',
    user_template:
      '目标类型：{{target_type}}\n' +
      '图片引用（不传原图字节，只有不透明引用与 MIME）：{{media_refs}}\n' +
      '请只输出 JSON：{"label":"pass|block|unsure","reason_codes":[...],"summary":"不超过 80 字的说明"}。',
    placeholders: Object.freeze(['target_type', 'media_refs']),
    required_output_fields: Object.freeze(['label', 'reason_codes', 'summary']),
    verdict_labels: Object.freeze(['pass', 'block', 'unsure']),
    policy_notes: Object.freeze([
      '只接收不透明媒体引用（media_id／mime），本组件不读取、不传输图片字节。',
      '带媒体的目标规则层一律不得判为通过；图片端口只补充证据，不得据此把 quarantined 改判为通过。',
    ]),
  }),
});

/** 按端口 kind 取 prompt id；未知 kind 返回 null（调用方必须按 fail-closed 处理）。 */
export function promptIdForPortKind(kind) {
  if (typeof kind !== 'string') return null;
  return PROMPT_ID_BY_PORT_KIND[kind] ?? null;
}

/** 按 prompt id 取定义；未知 id 返回 null。 */
export function promptDefinition(id) {
  if (typeof id !== 'string') return null;
  return PROMPT_DEFINITIONS[id] ?? null;
}

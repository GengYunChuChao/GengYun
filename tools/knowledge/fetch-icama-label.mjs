#!/usr/bin/env node
// GY-I03 公开农药登记标签**事实抽取器**（来源：中国农药信息网公开标签查看页）。
//
// 用途：以匿名、串行、限速的方式读取**公开**的核准标签查看页，只产出**抽取后的事实字段**：
//   registrationNo / productName / holder / activeIngredient / formulation / dosageAsPublished /
//   usageTable / precautionsAsPublished / technicalRequirementsAsPublished / shelfLifeAsPublished /
//   approvedAt / reapprovedAt / validity / restrictedOrBanned +
//   sourceUrl / retrievedAt / payloadSha256 / factsSha256 / reviewedBy(null) / licensed(false)。
//
// 硬约束（任何一条都不放宽）：
//   1) 只依赖 Node 标准库；**默认离线**：不传 `--allow-network` 时只读本地 fixture，绝不发起任何网络请求；
//   2) 礼貌限速：默认 4000ms/请求，**硬下限 3000ms**（更低直接拒绝启动），并发恒为 1，无重试风暴；
//   3) **不绕过**任何登录 / 验证码 / 反爬：只用站点公开的标签查看地址；一旦出现登录页、验证码、
//      HTTP 403/429，立即停止整轮并如实报告（不换 UA、不换代理、不猜口令继续试）；
//   4) **不补造**：抓不到的字段写 null 并在 `nullReasons` 记原因；任何非空字段都必须能在 payload
//      原文（空白归一化后）中**逐字定位**，否则 `assertNoUnsourcedFacts` 抛 UNSOURCED_FACT ——
//      这条不变式使"凭空构造的用量字段"无法通过校验；
//   5) `reviewedBy` 恒为 null（AI 不是独立核实人）；`licensed` 恒为 false、`licenseSurveyStatus`
//      恒为 `not_established`（未取得书面许可，站方声明保留版权）；
//   6) 原始页面/图片/大段文本**一律不入库**：输出必须写到**仓库之外**，仓内路径一律拒绝；本工具
//      不提供"保存原始 payload"的开关；
//   7) `validity` 只在标签页明确载明登记有效期时才落值，否则 `unknown` 并记原因；`restrictedOrBanned`
//      只是**标签原文文本扫描**的结果，不是法律判定，也不替代全国/地方禁限用公告核对；
//   8) 两个指纹语义不同、不得混用：`payloadSha256` 是**该次检索**的载荷指纹（站点每次请求都会换一个
//      `_SESSIONID` 令牌，实测同一标签两次抓取该哈希不同 ⇒ 不能当内容寻址 ID、不能当 source content_hash）；
//      `factsSha256` 是对**抽取后事实字段**做确定性 JSON 哈希（与检索时刻、载荷令牌无关），
//      实测同一标签两次抓取事实层逐字段一致 ⇒ 内容变更比对请用 `factsSha256`。
//
// 内容指纹口径（**已由指挥采纳，供后续切片引用** ✓）：
//   `source_versions.content_hash` 等"内容哈希"一律取 **`factsSha256`** ✓；
//   `payloadSha256` 只作**抓取证据**（记录某一次取回的字节）✓，**不得**当内容哈希 ✗。
// 产物与许可状态（**抓取内容尚未入库**）：
//   抓取产物只落**仓外**（例如 `<仓外>/icama-labels/labels-20.json`）；来源站点的网站声明要求
//   书面许可，在取得明确许可前**不把抓取内容入库、不对外分发**；记录内 `licensed=false` 只表示
//   许可未确立，**不得**写成已许可 ✗。`validity=unknown` / `reviewedBy=null` / `restrictedOrBanned`
//   仅为标签原文扫描 ⇒ 这批事实**不得作为真实用量依据或评估答案键** ✗。
//
// 用法（离线自测）：node tools/knowledge/fetch-icama-label.mjs --fixture-dir <fixture 目录> \
//   --registration PD99999901 --out <仓外 JSON>
// 用法（联网，需显式开关）：node tools/knowledge/fetch-icama-label.mjs --allow-network \
//   --registrations docs/research/gy-i03-public-label-index-20261011.json --bucket in_scope_text_candidate \
//   --out <仓外 JSON> [--min-interval-ms 4000] [--limit 20]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

export const SCHEMA = 'gengyun.knowledge.icama-label-facts.v1';
export const TOOL_ID = 'tools/knowledge/fetch-icama-label.mjs';
export const DEFAULT_BASE_URL = 'https://www.icama.cn';
export const LABEL_PATH = '/BasicdataSystem/pesticideRegistration/tagview.do';
export const DEFAULT_MIN_INTERVAL_MS = 4000;
export const MIN_INTERVAL_FLOOR_MS = 3000;
export const USER_AGENT =
  'GengYunCommander-icama-label-fetch/1.0 (+https://github.com/GengYunChuChao/GengYun; ' +
  'polite single-threaded reader of public approved-label pages)';
export const REGISTRATION_NO_PATTERN = /^PD\d{8}$/;

/** 站点声明要点（转述，不复制原文）：页面所涉资料版权归农业农村部农药检定所与资料提供者，
 *  未经书面许可不得引用/复制/转载/摘编。站点声明页：{@link SITE_STATEMENT_URL}。
 *  因此本工具只入"抽取后的事实字段 + 来源指针"，且输出强制落在仓库之外。 */
export const SITE_STATEMENT_URL = 'http://www.chinapesticide.org.cn/zwb/website_statement';

/** 标签页内的分节标签（顺序即出现顺序，用于取"本节文本"的右边界）。 */
export const SECTION_LABELS = [
  '使用技术要求',
  '产品性能',
  '注意事项',
  '中毒急救措施',
  '储存和运输方法',
  '质量保证期',
  '核准日期',
  '重新核准日期'
];

/** 身份字段的取值右边界（避免把下一行标签吞进值里）。 */
const VALUE_STOP_LABELS = [
  '登记证持有人',
  '农药名称',
  '剂型',
  '毒性及其标识',
  '有效成分及其含量',
  '使用范围和使用方法',
  ...SECTION_LABELS
];

/** 用量单元格里的"非数值占位"，视为**源缺**而不是 0，也不做任何换算。 */
const DOSAGE_PLACEHOLDERS = new Set(['', '/', '—', '-', '--', '无', '无。', '不适用', 'null']);

const NO_RESULT_MARKERS = ['查找无结果', '没有查询到', '无查询结果'];
const LOGIN_WALL_MARKERS = ['用户登录', '忘记密码', '农药数字监督管理平台'];
const CREDENTIAL_FIELD_MARKERS = ['验证码', '密码'];

export class UnsourcedFactError extends Error {
  constructor(field, value) {
    super(`UNSOURCED_FACT: 字段 ${field} 的取值无法在 payload 原文中逐字定位：${JSON.stringify(value)}`);
    this.name = 'UnsourcedFactError';
    this.code = 'UNSOURCED_FACT';
    this.field = field;
    this.value = value;
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'USAGE';
  }
}

// ---------------------------------------------------------------- 基础工具
export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function decodeEntities(input) {
  return String(input)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/** HTML → 行文本：块级结束标签与 <br> 变行，标签去掉，实体解码，逐行 trim 后丢弃空行。 */
export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '\n');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|td|th|span)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** 空白归一化：用于"逐字定位"校验与跨行取值比较（不改变字符本身，不做同义/单位换算）。 */
export function normalizeForMatch(input) {
  return String(input).replace(/\s+/g, ' ').trim();
}

/** 单元格文本：比整页文本更严，去标签后只做空白折叠。 */
export function cellText(html) {
  const only = String(html).replace(/<[^>]*>/g, ' ');
  return normalizeForMatch(decodeEntities(only));
}

/** 从归一化文本里取 `标签[：:] 值` 的值，右边界取下一个标签出现处。 */
export function labeledValue(flatText, label, stopLabels = VALUE_STOP_LABELS) {
  const start = flatText.indexOf(label);
  if (start === -1) return null;
  let from = start + label.length;
  if (flatText[from] === '：' || flatText[from] === ':') from += 1;
  let end = flatText.length;
  for (const stop of stopLabels) {
    if (stop === label) continue;
    const at = flatText.indexOf(stop, from);
    if (at !== -1 && at < end) end = at;
  }
  const value = normalizeForMatch(flatText.slice(from, end));
  return value === '' ? null : value;
}

/** 取某一分节的正文（标签后的全部文本，直到下一个分节标签）。
 *  站点在这些字段之间还会插一个独立的「备注：」标签，故末尾若残留"短标签："则剪掉并记警告
 *  （剪掉的是**非本字段的标签**，不改变本字段的取值文字）。 */
export function sectionValue(flatText, label, warnings = null) {
  const start = flatText.indexOf(label);
  if (start === -1) return null;
  let from = start + label.length;
  if (flatText[from] === '：' || flatText[from] === ':') from += 1;
  let end = flatText.length;
  for (const stop of SECTION_LABELS) {
    if (stop === label) continue;
    const at = flatText.indexOf(stop, from);
    if (at !== -1 && at < end) end = at;
  }
  const value = normalizeForMatch(flatText.slice(from, end));
  if (value === '') return null;
  const trailing = /^(.*?)\s*([^\s：:]{1,8})[：:]$/.exec(value);
  if (trailing !== null && trailing[2] !== label) {
    warnings?.push(`trimmed_trailing_label:${label}:${trailing[2]}`);
    const trimmed = normalizeForMatch(trailing[1]);
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

/** 标签原文里的禁限用表述：只做文本扫描，按句切开，逐句原文照录。 */
export function scanRestrictedClauses(flatText) {
  const sentences = flatText
    .split(/(?<=[。；;!！?？])/)
    .map((s) => normalizeForMatch(s))
    .filter((s) => s !== '');
  return sentences.filter((s) => /禁用|禁止|限制使用|停止使用/.test(s));
}

/** 计数某个**独立**标签在文中出现几次（排除「重新核准日期」「原核准日期」这类复合标签）。 */
export function countLabelOccurrences(flatText, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...flatText.matchAll(new RegExp(`(?<!重新|原|新)${escaped}`, 'g'))].length;
}

// ---------------------------------------------------------------- 抽取
/**
 * 纯函数抽取：同样入参 ⇒ 同样结果（时间与来源由调用方注入）。
 * 返回记录带 `status`：ok / not_found / blocked / unrecognized。
 */
export function extractLabelFacts(html, options = {}) {
  const sourceUrl = options.sourceUrl ?? null;
  const retrievedAt = options.retrievedAt ?? null;
  const payloadSha256 = options.payloadSha256 ?? null;
  const requestedRegistrationNo = options.registrationNo ?? null;
  const text = htmlToText(html);
  const flat = normalizeForMatch(text);
  const warnings = [];
  const nullReasons = {};

  const base = {
    schema: SCHEMA,
    status: 'unrecognized',
    registrationNo: requestedRegistrationNo,
    registrationNoInPage: null,
    productName: null,
    holder: null,
    activeIngredient: null,
    formulation: null,
    toxicityAsPublished: null,
    dosageAsPublished: null,
    usageTable: null,
    technicalRequirementsAsPublished: null,
    precautionsAsPublished: null,
    shelfLifeAsPublished: null,
    approvedAt: null,
    reapprovedAt: null,
    validity: 'unknown',
    restrictedOrBanned: null,
    restrictedOrBannedCheck: 'label_text_scan_only',
    sourceUrl,
    retrievedAt,
    payloadSha256,
    factsSha256: null,
    reviewedBy: null,
    licensed: false,
    licenseSurveyStatus: 'not_established',
    extraction: { tool: TOOL_ID, mode: options.mode ?? 'fixture', schema: SCHEMA },
    nullReasons,
    extractionWarnings: warnings
  };

  // 先判阻断与"无结果"，避免把墙页当成标签页。
  // 注意：登录墙的"验证码/账号/密码"只出现在 input 的 placeholder 属性里，故同时扫原文属性。
  const raw = String(html);
  const hasCredentialWall =
    CREDENTIAL_FIELD_MARKERS.some((marker) => flat.includes(marker) || raw.includes(marker)) &&
    (LOGIN_WALL_MARKERS.some((marker) => flat.includes(marker) || raw.includes(marker)) ||
      /id\s*=\s*["']?loginfrm/i.test(raw));
  if (hasCredentialWall) {
    return {
      ...base,
      status: 'blocked',
      blockedKind: 'login_or_captcha_wall',
      nullReasons: { all: 'source_returned_login_or_captcha_wall' }
    };
  }
  if (NO_RESULT_MARKERS.some((marker) => flat.includes(marker))) {
    return { ...base, status: 'not_found', nullReasons: { all: 'source_reported_no_result_for_this_registration_no' } };
  }

  const registrationNoInPage = labeledValue(flat, '农药登记证号');
  const productName = labeledValue(flat, '农药名称');
  if (registrationNoInPage === null && productName === null) {
    return { ...base, status: 'unrecognized', nullReasons: { all: 'payload_has_no_label_identity_markers' } };
  }

  base.status = 'ok';
  base.registrationNoInPage = registrationNoInPage;
  base.productName = productName;
  base.holder = labeledValue(flat, '登记证持有人');
  base.activeIngredient = labeledValue(flat, '有效成分及其含量');
  base.formulation = labeledValue(flat, '剂型');
  base.toxicityAsPublished = labeledValue(flat, '毒性及其标识');
  base.technicalRequirementsAsPublished = sectionValue(flat, '使用技术要求', warnings);
  base.precautionsAsPublished = sectionValue(flat, '注意事项', warnings);
  base.shelfLifeAsPublished = sectionValue(flat, '质量保证期', warnings);
  base.approvedAt = sectionValue(flat, '核准日期', warnings);
  base.reapprovedAt = sectionValue(flat, '重新核准日期', warnings);

  // 用量：只照录 4 列表格里的"用药量"单元格，不改写、不换算、不补 0。
  const usage = extractUsageTable(html);
  if (usage.tableFound) {
    base.usageTable = usage.rows;
    const dosages = usage.rows.map((row) => row.dosage).filter((d) => d !== null);
    base.dosageAsPublished = dosages.length > 0 ? dosages : null;
    if (dosages.length === 0) {
      nullReasons.dosageAsPublished = usage.rows.length > 0
        ? 'dosage_cell_empty_or_placeholder_in_source'
        : 'usage_table_has_no_data_row';
    }
  } else {
    base.usageTable = null;
    nullReasons.usageTable = 'usage_table_not_found';
    nullReasons.dosageAsPublished = 'usage_table_not_found';
  }

  // 登记有效期：只有页面明确载明才落值。
  const validityText =
    labeledValue(flat, '登记有效期') ??
    (/(有效期至[:：]?\s*[0-9]{4}[-年][0-9]{1,2}[-月][0-9]{1,2})/.exec(flat)?.[1] ?? null);
  if (validityText === null) {
    nullReasons.validity = 'label_page_does_not_state_registration_validity_period';
  } else {
    base.validity = validityText;
  }

  const restricted = scanRestrictedClauses(flat);
  if (restricted.length === 0) {
    nullReasons.restrictedOrBanned = 'no_restriction_wording_in_label_text';
  } else {
    base.restrictedOrBanned = restricted;
  }

  for (const field of ['productName', 'holder', 'activeIngredient', 'formulation']) {
    if (base[field] === null) nullReasons[field] = 'label_marker_not_found_or_empty';
  }
  for (const field of ['technicalRequirementsAsPublished', 'precautionsAsPublished', 'shelfLifeAsPublished', 'approvedAt', 'reapprovedAt']) {
    if (base[field] === null) nullReasons[field] = 'section_marker_not_found_or_empty';
  }
  // 标签页把"毒性及其标识"做成图示的很多，文字位为空属正常，不算缺项。
  if (base.toxicityAsPublished === null) nullReasons.toxicityAsPublished = 'toxicity_shown_as_icon_or_empty_text';

  for (const label of ['农药登记证号', '农药名称', ...SECTION_LABELS]) {
    const seen = countLabelOccurrences(flat, label);
    if (seen > 1) warnings.push(`duplicate_marker:${label}x${seen}`);
  }
  if (registrationNoInPage !== null && requestedRegistrationNo !== null && registrationNoInPage !== requestedRegistrationNo) {
    warnings.push(`registration_no_mismatch:requested=${requestedRegistrationNo};in_page=${registrationNoInPage}`);
  }
  base.factsSha256 = computeFactsSha256(base);
  return base;
}

/**
 * 事实层的规范化视图：**只含事实字段与状态**，按固定键序；刻意排除 retrievedAt / payloadSha256 /
 * sourceUrl / extraction 这类"每次检索都会变"的来源指针，使哈希可用于内容变更比对。
 */
export function canonicalFacts(record) {
  return {
    status: record.status,
    registrationNo: record.registrationNo ?? null,
    registrationNoInPage: record.registrationNoInPage ?? null,
    productName: record.productName ?? null,
    holder: record.holder ?? null,
    activeIngredient: record.activeIngredient ?? null,
    formulation: record.formulation ?? null,
    toxicityAsPublished: record.toxicityAsPublished ?? null,
    dosageAsPublished: record.dosageAsPublished ?? null,
    usageTable: (record.usageTable ?? null) === null
      ? null
      : record.usageTable.map((row) => ({
        cropSite: row.cropSite ?? null,
        target: row.target ?? null,
        dosage: row.dosage ?? null,
        method: row.method ?? null
      })),
    technicalRequirementsAsPublished: record.technicalRequirementsAsPublished ?? null,
    precautionsAsPublished: record.precautionsAsPublished ?? null,
    shelfLifeAsPublished: record.shelfLifeAsPublished ?? null,
    approvedAt: record.approvedAt ?? null,
    reapprovedAt: record.reapprovedAt ?? null,
    validity: record.validity ?? null,
    restrictedOrBanned: record.restrictedOrBanned ?? null
  };
}

/** 事实内容指纹：同一条标签两次抓取（载荷令牌不同）应当得到同一个 factsSha256。 */
export function computeFactsSha256(record) {
  return sha256Hex(Buffer.from(JSON.stringify(canonicalFacts(record)), 'utf8'));
}

/** 取"使用范围和使用方法"4 列表（作物/场所, 防治对象, 用药量, 施用方式）。 */
export function extractUsageTable(html) {
  const tables = [...String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]);
  const target = tables.find((t) => htmlToText(t).includes('使用范围和使用方法'));
  if (target === undefined) return { tableFound: false, rows: [] };
  const rows = [];
  for (const tr of target.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1]));
    if (cells.length < 4) continue;
    const joined = cells.join(' ');
    if (/使用范围和使用方法|作物\s*\/\s*场所|用药量|施用方式/.test(joined)) continue;
    const dosage = dosageOrNull(cells[2]);
    rows.push({ cropSite: cells[0] || null, target: cells[1] || null, dosage, method: cells[3] || null });
  }
  return { tableFound: true, rows };
}

function dosageOrNull(cell) {
  const value = normalizeForMatch(cell ?? '');
  if (DOSAGE_PLACEHOLDERS.has(value) || DOSAGE_PLACEHOLDERS.has(value.toLowerCase())) return null;
  return value;
}

// ---------------------------------------------------------------- 反补造不变式
/** 收集记录里所有"非空且必须来自 payload 原文"的字符串。 */
export function collectSourcedValues(record) {
  const out = [];
  const push = (field, value) => {
    if (typeof value === 'string' && value.trim() !== '') out.push({ field, value });
  };
  push('registrationNoInPage', record.registrationNoInPage);
  push('productName', record.productName);
  push('holder', record.holder);
  push('activeIngredient', record.activeIngredient);
  push('formulation', record.formulation);
  push('toxicityAsPublished', record.toxicityAsPublished);
  push('technicalRequirementsAsPublished', record.technicalRequirementsAsPublished);
  push('precautionsAsPublished', record.precautionsAsPublished);
  push('shelfLifeAsPublished', record.shelfLifeAsPublished);
  push('approvedAt', record.approvedAt);
  push('reapprovedAt', record.reapprovedAt);
  push('validity', record.validity === 'unknown' ? null : record.validity);
  for (const [i, dosage] of (record.dosageAsPublished ?? []).entries()) push(`dosageAsPublished[${i}]`, dosage);
  for (const [i, row] of (record.usageTable ?? []).entries()) {
    push(`usageTable[${i}].cropSite`, row.cropSite);
    push(`usageTable[${i}].target`, row.target);
    push(`usageTable[${i}].dosage`, row.dosage);
    push(`usageTable[${i}].method`, row.method);
  }
  for (const [i, clause] of (record.restrictedOrBanned ?? []).entries()) push(`restrictedOrBanned[${i}]`, clause);
  return out;
}

/**
 * 反补造不变式：记录里每个非空的"原文照录"字段，都必须能在 payload 原文（空白归一化后）
 * 逐字定位；否则抛 UNSOURCED_FACT。凭空构造的用量/注意事项在这里被拒。
 */
export function assertNoUnsourcedFacts(record, payloadText) {
  const haystack = normalizeForMatch(htmlToText(payloadText));
  for (const { field, value } of collectSourcedValues(record)) {
    if (!haystack.includes(normalizeForMatch(value))) throw new UnsourcedFactError(field, value);
  }
  return true;
}

// ---------------------------------------------------------------- 地址与输出守卫
export function validateRegistrationNo(registrationNo) {
  const value = String(registrationNo ?? '').trim();
  if (!REGISTRATION_NO_PATTERN.test(value)) {
    throw new UsageError(`登记证号格式不合法（应为 PD + 8 位数字）：${JSON.stringify(registrationNo)}`);
  }
  return value;
}

export function buildLabelUrl(baseUrl, registrationNo) {
  const no = validateRegistrationNo(registrationNo);
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new UsageError(`--base-url 只允许 http/https：${baseUrl}`);
  }
  return `${base.origin}${LABEL_PATH}?pdno=${no}`;
}

/** 输出必须落在仓库之外：本工具不把抓取结果写进受版本管理的目录。 */
export function assertOutPathOutsideRepo(outPath, repoRoot = REPO_ROOT) {
  const abs = resolve(isAbsolute(outPath) ? outPath : resolve(process.cwd(), outPath));
  const rel = relative(resolve(repoRoot), abs).replace(/\\/g, '/');
  // 注意：Windows 上跨盘符时 relative() 会返回绝对路径，故用 isAbsolute(rel) 一并判定"在仓外"。
  const outside = isAbsolute(rel) || rel === '..' || rel.startsWith('../');
  if (!outside) {
    throw new UsageError(
      `--out 不能指向仓库内路径（原始标签内容与抽取结果都不入仓）：${abs}；本工具只写仓外路径`
    );
  }
  return abs;
}

// ---------------------------------------------------------------- 抓取计划与执行
export function parseArgs(argv) {
  const args = { _: [], registration: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        // --registration 可重复出现；其余键最后一次生效。
        if (key === 'registration') args.registration.push(next);
        else args[key] = next;
        i += 1;
      }
    } else args._.push(token);
  }
  return args;
}

function collectRegistrations(args) {
  const list = [];
  for (const raw of [].concat(args.registration ?? [])) {
    if (raw === true) continue;
    list.push(validateRegistrationNo(raw));
  }
  const file = typeof args.registrations === 'string' ? args.registrations : null;
  if (file !== null) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : (parsed.labels ?? []);
    const bucket = typeof args.bucket === 'string' ? args.bucket : null;
    for (const entry of entries) {
      const no = typeof entry === 'string' ? entry : entry?.registration_number;
      if (no === undefined || no === null) continue;
      if (bucket !== null && (typeof entry === 'string' || entry.bucket !== bucket)) continue;
      list.push(validateRegistrationNo(no));
    }
  }
  const unique = [...new Set(list)];
  const limit = args.limit === undefined || args.limit === true ? null : Number(args.limit);
  return limit !== null && Number.isFinite(limit) && limit > 0 ? unique.slice(0, limit) : unique;
}

async function sleep(ms) {
  await new Promise((done) => { setTimeout(done, ms); });
}

/** 网络读取器：单请求、带超时、不问凭据、不跟随到登录页。 */
export async function httpFetchPayload(url, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, body: new TextDecoder('utf-8').decode(bytes) };
}

export function makeRunPlan({ registrations, baseUrl, outPath, minIntervalMs, mode }) {
  if (registrations.length === 0) throw new UsageError('未提供任何登记证号（--registration 或 --registrations）');
  if (outPath === undefined || outPath === null) throw new UsageError('必须用 --out 指定仓外输出路径');
  const interval = minIntervalMs === undefined || minIntervalMs === null
    ? DEFAULT_MIN_INTERVAL_MS
    : Number(minIntervalMs);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_FLOOR_MS) {
    throw new UsageError(
      `--min-interval-ms 不得低于礼貌下限 ${MIN_INTERVAL_FLOOR_MS}ms（并发恒为 1，建议 4000ms 以上）`
    );
  }
  const out = assertOutPathOutsideRepo(outPath);
  return {
    mode,
    baseUrl,
    out,
    minIntervalMs: interval,
    urls: registrations.map((no) => ({ registrationNo: no, url: buildLabelUrl(baseUrl, no) }))
  };
}

export function fixturePathFor(fixtureDir, registrationNo) {
  return join(fixtureDir, `label-${registrationNo}.html`);
}

/** 执行一轮（离线 fixture 或显式联网），返回 { records, aborted }。 */
export async function runFetch({
  plan,
  fixtureDir = null,
  now = () => new Date().toISOString(),
  fetchImpl = fetch,
  sleepImpl = sleep,
  log = () => {}
}) {
  const records = [];
  let aborted = null;
  for (const [index, item] of plan.urls.entries()) {
    if (index > 0) await sleepImpl(plan.minIntervalMs);
    let payload;
    if (plan.mode === 'network') {
      const res = await httpFetchPayload(item.url, { fetchImpl });
      if (res.status === 403 || res.status === 429) {
        aborted = { kind: 'site_blocked', registrationNo: item.registrationNo, httpStatus: res.status };
        records.push({
          schema: SCHEMA,
          status: 'blocked',
          registrationNo: item.registrationNo,
          sourceUrl: item.url,
          retrievedAt: now(),
          payloadSha256: sha256Hex(res.bytes),
          httpStatus: res.status,
          reviewedBy: null,
          licensed: false,
          licenseSurveyStatus: 'not_established',
          nullReasons: { all: `http_${res.status}_stop_run_no_retry_no_bypass` },
          extractionWarnings: []
        });
        log(`ABORT ${item.registrationNo} http=${res.status} —— 站点阻断，停止整轮（不重试、不绕过）`);
        break;
      }
      payload = { status: res.status, bytes: res.bytes, body: res.body };
    } else {
      const file = fixturePathFor(fixtureDir, item.registrationNo);
      if (!existsSync(file)) {
        aborted = { kind: 'fixture_missing', registrationNo: item.registrationNo };
        records.push({
          schema: SCHEMA,
          status: 'blocked',
          registrationNo: item.registrationNo,
          sourceUrl: item.url,
          retrievedAt: now(),
          payloadSha256: null,
          reviewedBy: null,
          licensed: false,
          licenseSurveyStatus: 'not_established',
          nullReasons: { all: 'offline_fixture_not_found' },
          extractionWarnings: []
        });
        break;
      }
      const bytes = readFileSync(file);
      payload = { status: 200, bytes, body: new TextDecoder('utf-8').decode(bytes) };
    }
    const retrievedAt = now();
    const record = extractLabelFacts(payload.body, {
      sourceUrl: item.url,
      retrievedAt,
      payloadSha256: sha256Hex(payload.bytes),
      registrationNo: item.registrationNo,
      mode: plan.mode
    });
    record.httpStatus = payload.status;
    if (record.status === 'ok') assertNoUnsourcedFacts(record, payload.body);
    records.push(record);
    if (record.status === 'blocked') {
      aborted = { kind: 'login_or_captcha_wall', registrationNo: item.registrationNo };
      log(`ABORT ${item.registrationNo} —— 返回登录/验证码页，停止整轮（不绕过）`);
      break;
    }
    log(
      `${record.status.toUpperCase().padEnd(12)} ${item.registrationNo} ` +
      `product=${record.productName ?? 'null'} dosageRows=${record.dosageAsPublished?.length ?? 0} ` +
      `payload=${record.payloadSha256.slice(0, 12)}… facts=${String(record.factsSha256 ?? 'null').slice(0, 12)}…`
    );
  }
  return { records, aborted };
}

// ---------------------------------------------------------------- CLI
async function main(argv) {
  const args = parseArgs(argv);
  const mode = args['allow-network'] === true ? 'network' : 'fixture';
  const registrations = collectRegistrations(args);
  const plan = makeRunPlan({
    registrations,
    baseUrl: typeof args['base-url'] === 'string' ? args['base-url'] : DEFAULT_BASE_URL,
    outPath: typeof args.out === 'string' ? args.out : null,
    minIntervalMs: args['min-interval-ms'],
    mode
  });
  const fixtureDir = typeof args['fixture-dir'] === 'string' ? args['fixture-dir'] : null;
  if (mode === 'fixture' && fixtureDir === null) {
    throw new UsageError('离线模式需要 --fixture-dir；联网需显式加 --allow-network（默认离线）');
  }
  const fixedNow = typeof args.now === 'string' ? args.now : null;
  const { records, aborted } = await runFetch({
    plan,
    fixtureDir,
    now: () => fixedNow ?? new Date().toISOString(),
    log: (line) => console.log(line)
  });
  const payload = {
    schema: SCHEMA,
    tool: TOOL_ID,
    mode,
    baseUrl: plan.baseUrl,
    minIntervalMs: plan.minIntervalMs,
    sequential: true,
    concurrency: 1,
    sourceNotice:
      '来源为公开标签查看页；站方声明保留版权、未取得书面许可，故本文件只含抽取后事实字段与来源指针，' +
      '不得再分发；不随仓库提交。',
    requestedCount: plan.urls.length,
    okCount: records.filter((r) => r.status === 'ok').length,
    notFoundCount: records.filter((r) => r.status === 'not_found').length,
    blockedCount: records.filter((r) => r.status === 'blocked').length,
    aborted,
    records
  };
  mkdirSync(dirname(plan.out), { recursive: true });
  writeFileSync(plan.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\n写入 ${plan.out}（仓外）：ok=${payload.okCount} not_found=${payload.notFoundCount} blocked=${payload.blockedCount}`);
  if (aborted !== null) {
    console.error(`站点阻断/中断：${JSON.stringify(aborted)} —— 已按红线停止整轮，不重试、不绕过。`);
    process.exitCode = 2;
  }
  return payload;
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`失败：${error?.message ?? error}`);
    process.exitCode = error instanceof UsageError ? 1 : 1;
  });
}

export { main };

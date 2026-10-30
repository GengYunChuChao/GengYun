/**
 * `consent_policies` 导入的**纯逻辑**（零 I/O、零 `pg`、零真实时钟）。
 *
 * ## 这个文件解决什么
 *
 * `public.consent_policies` 是三层闸序的**第一道门**：`privacy/grant-pg.ts` 的
 * `persistConsentGrant` 找不到「enabled + reviewed_at<=now + valid_from<=now + valid_until>now」的行就
 * 抛 `CONSENT_REQUIRED`，于是 `POST /posts`（`public_posting`）、媒体上传（`media_processing`）、
 * OCR/识别/问答外发（`external_inference`）全部 403，审核代码根本不执行。而这张表在 `0009` 里
 * 明确「No production policy or recipient seeds」，产品代码/后台路由/运维工具/种子都没有写入途径
 * ——唯一会写它的是测试夹具。本文件是那条**唯一的写入途径**的可单测一半。
 *
 * 契约口径（`services/api/db/migrations/0009_consent_policy.sql`，逐条实测）：
 *   * `UNIQUE(purpose,policy_version)` ⇒ 同一版本只能有一行；
 *   * 部分唯一索引 `consent_policies_enabled_purpose` ⇒ 同 `purpose` 至多一行 `enabled`；
 *   * `CHECK (NOT enabled OR reviewed_at IS NOT NULL)` ⇒ 启用必须同时有 `reviewed_at`
 *     （`(reviewed_by IS NULL)=(reviewed_at IS NULL)` 又把 `reviewed_by` 绑上）；
 *   * `consent_policy_immutable()` 触发器 ⇒ 一旦 `reviewed_at` 非空，除 `enabled`/`updated_at`
 *     之外的列**一律不可就地修改**（错误码 `23514`）。所以「换正文」只能是**新版本新行**。
 *
 * ## 同版本重放/启用：**正文 sha 与安全元数据必须同时一致**（本片新增的第五道边界）
 *
 * 判「幂等重放」原来只看 `content_sha256`：于是「同版本、同正文、但来源/有效期/复核人/绑定不同」会被判
 * `unchanged`，而库里那一行可能仍是 `synthetic`、可能已经过期 —— 报告却按**清单**打印 `verified` 与未来日期。
 * 那是把「没导入过的东西」说成「已生效」，所以现在：
 *
 *   * `unchanged` = 正文 sha **且** `POLICY_SAFETY_METADATA_FIELDS` 里每一列都相等；
 *   * 任何一列不等 ⇒ `METADATA_CONFLICT`（退出码沿用 `POLICY_CONFLICT` 的 4），报错点名字段与旧值→新值；
 *   * 库行缺列（调用方 SELECT 没取全）同样判冲突，⛔ 不许把「读不到」当成「一致」；
 *   * `--enable` 也一样：先过这一关，才谈「开起来」，否则就是「启用旧元数据」。
 *
 * ⛔ 报错与报告都**不打印正文**（`policy` 里本来就没有正文，只有 sha 与两个长度读数）。
 *
 * ## 四条硬边界（都在这里，不在命令行里）
 *
 * 1. **`content_sha256` 由本工具算，调用方不许传**：清单里出现这个键 ⇒ 直接判 `INVALID_POLICY`。
 *    否则「改了正文、sha 不变」就成了合法输入，核验列彻底失去意义。
 * 2. **闭集从代码里 import，不另抄一份**：`purpose` 的合法取值来自
 *    `privacy/consent-pg.ts` 的 `CONSENT_PURPOSES`（运行时 `dto()` 与 `privacy/grant-pg.ts` 的
 *    `persistConsentGrant` 用的正是这一份）；接收方能力闭集来自 `privacy/privacy-policy.ts` 的
 *    `RECIPIENT_CAPABILITIES`；版本号里禁用的保留值 `unpublished` 来自同一文件的
 *    `UNPUBLISHED_POLICY_VERSION`（读面把它当空态哨兵，真写进库即 fail-closed）。
 * 3. **单调只追加**：新版本必须严格大于该 `purpose` 已有的最大版本；已有同一版本但正文 sha 不同
 *    ⇒ 拒绝（不许静默覆盖历史）。理由同 1：历史是账，不是配置。
 * 4. **应用层先挡一遍，数据库只作第二道防线**：`valid_until > valid_from`、`source_kind` 闭集、
 *    接收方绑定的七个字段与留存上限、`reviewed_by` 的 uuid 形状、以及「`verified` 却拿着夹具措辞」
 *    的启发式筛，全在这里判；`0009` 的 `CHECK`/触发器是兜底而不是唯一判据。
 *
 * ## 正文怎么进 sha，不进日志
 *
 * 清单里的 `body` 只用于算 sha 与量长度，**返回的 `policy` 对象里没有正文**
 * （只有 `body_chars` / `body_first_line_chars` / `content_sha256`）。于是「打印一行政策形状」
 * 这件事在类型上就不可能顺带把正文打出去。
 *
 * 归一化规则（`normalizePolicyBody`）：去 BOM ⇒ `\r\n`/`\r` 统一成 `\n` ⇒ 去掉尾部空白。
 * 只此三步 —— 行尾空格、空行、标点一律原样参与哈希，避免「看起来一样、哈希不一样」的歧义。
 */
import { createHash } from 'node:crypto';

import { CONSENT_PURPOSES } from '../../services/api/src/privacy/consent-pg.ts';
import { RECIPIENT_CAPABILITIES, UNPUBLISHED_POLICY_VERSION } from '../../services/api/src/privacy/privacy-policy.ts';

/**
 * `purpose` 的合法取值 = **代码里的闭集真值**（import 而非抄写）。
 * 导出的是一份冻结副本，方便测试与命令行共用同一份判据。
 */
export const CONSENT_PURPOSE_CLOSED_SET = Object.freeze([...CONSENT_PURPOSES]);

/** `source_kind` 闭集（`0009` 的 `CHECK (source_kind IN ('verified','synthetic'))`）。 */
export const SOURCE_KINDS = Object.freeze(['verified', 'synthetic']);

/** 接收方能力闭集（`RECIPIENT_CAPABILITIES` 的冻结副本；`grant-pg` 逐个比对的就是它）。 */
export const RECIPIENT_CAPABILITY_CLOSED_SET = Object.freeze([...RECIPIENT_CAPABILITIES]);

/** 版本号上限（`0009` 的 `policy_version varchar(80)`，与契约 `PrivacyPolicy.version.maxLength` 同口径）。 */
export const MAX_POLICY_VERSION_CHARS = 80;

/** 正文长度下界（按 Unicode 码点计）：低于它的一律当成「没写正文」。 */
export const MIN_BODY_CHARS = 200;

/** 接收方留存上限（契约 `Recipient.retention_online_days <= 7` / `retention_backup_days <= 30`）。 */
export const RETENTION_ONLINE_MAX = 7;
export const RETENTION_BACKUP_MAX = 30;

/**
 * 占位正文的识别词。⛔ 不要放宽：本工具存在的意义就是「库里的政策行是真的」，
 * 一行 `TODO` 会让整条 AI 链路的闸门看似打开、实则没有可披露的政策。
 */
const LATIN_PLACEHOLDERS = ['todo', 'tbd', 'fixme', 'lorem', 'ipsum', 'placeholder'];
const CJK_PLACEHOLDERS = ['占位', '待填', '待补', '示例正文', '样例正文'];

/**
 * 「这份东西其实是合成夹具」的措辞（只在 `source_kind=verified` 时用来判伪）。
 * 与 `SOURCE_KINDS` 的 `synthetic` 分支相反：`synthetic` 是**如实标注**，这里抓的是**冒充**。
 */
const FIXTURE_BODY_TOKENS = ['synthetic', 'fixture', '测试正文', '样例', '演示样本', 'dummy'];
const FIXTURE_HOSTS = ['example.com', 'example.org', 'example.net'];

/** 清单允许出现的键（白名单：写错键名不能被静默忽略）。 */
export const POLICY_MANIFEST_KEYS = Object.freeze([
  'purpose',
  'policy_version',
  'source_kind',
  'source_ref',
  'review_evidence_ref',
  'recipient_bindings',
  'body',
  'valid_from',
  'valid_until',
]);

/**
 * ⛔ 调用方绝不许传的键（工具自算）。
 * `reviewed_by` 也在这一列：**谁复核**是运维在命令行上的断言（`--reviewed-by`），
 * 不是政策清单里的一个字段 —— 否则「清单自带 reviewer」就等于让文件给自己签字。
 */
export const FORBIDDEN_MANIFEST_KEYS = Object.freeze(['content_sha256', 'reviewed_by']);

/** 三种可能的判定（⛔ 不要用裸字符串比较，避免拼错后「静默走 unchanged」）。 */
export const PLAN_ACTIONS = Object.freeze({
  INSERT: 'insert',
  ENABLE: 'enable',
  UNCHANGED: 'unchanged',
});

/**
 * 同 `(purpose, policy_version)` 的重放/启用必须**逐列相等**的安全元数据。
 *
 * 为什么是这几列而不是「全部列」：`id` / `enabled` / `updated_at` 本就会变（启用就是改它们），
 * `reviewed_at` 由库钟写、清单里没有对应字段（无可比对象），`content_sha256` 由上面的 sha 判据单独管。
 * 剩下的这七列**决定这一行说了什么**：来源是什么（`source_kind`/`source_ref`）、依据什么复核
 * （`review_evidence_ref`）、有效期到哪天（`valid_from`/`valid_until`）、谁复核的（`reviewed_by`）、
 * 绑了哪些接收方（`recipient_bindings`）。它们任何一个与清单不同，「重放成功」就等于把没导入过的
 * 来源/有效期/复核主体说成已生效。
 *
 * ⚠ 调用方的 `SELECT` 必须**取全**这七列（缺列判冲突，见 `comparePolicySafetyMetadata`）。
 */
export const POLICY_SAFETY_METADATA_FIELDS = Object.freeze([
  'source_kind',
  'source_ref',
  'review_evidence_ref',
  'valid_from',
  'valid_until',
  'reviewed_by',
  'recipient_bindings',
]);

/**
 * 进程退出码（命令行与测试共用一套；⛔ 不要在命令行里另写数字）。
 *
 * | 码 | 名称 | 含义 |
 * | --- | --- | --- |
 * | 0 | `OK` | 成功（dry-run 已出形状 / apply 已落库 / 二次执行 `unchanged=true`） |
 * | 2 | `CONFIG` | 参数或环境问题：缺子命令、缺 `--file`、缺 `DATABASE_URL`、清单读不到、JSON 解析失败 |
 * | 3 | `INVALID_POLICY` | 政策内容强校验失败（闭集/占位/有效期/调用方传 sha/来源形状/绑定/复核主体） |
 * | 4 | `POLICY_CONFLICT` | 版本回退、同版本不同正文、启用非最新版本，**以及同版本安全元数据不一致（`METADATA_CONFLICT`）** |
 * | 5 | `DB_ERROR` | 数据库错误（连不上 / 权限 / 表缺失 / 未知），事务已回滚 |
 */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  CONFIG: 2,
  INVALID_POLICY: 3,
  POLICY_CONFLICT: 4,
  DB_ERROR: 5,
});

/**
 * 失败类别（字符串码，进报错行；与 `EXIT_CODES` 一一对应）。
 *
 * `METADATA_CONFLICT` 是「政策冲突」的**细分标签**：它不新增退出码，仍按 `POLICY_CONFLICT` 的 4 退出
 * ——「同版本、但库行与清单说的不是同一件事」在语义上是冲突，不是内容格式错误（3），也不是库故障（5）。
 */
export const FAILURE_KINDS = Object.freeze({
  CONFIG: 'CONFIG',
  INVALID_POLICY: 'INVALID_POLICY',
  POLICY_CONFLICT: 'POLICY_CONFLICT',
  METADATA_CONFLICT: 'METADATA_CONFLICT',
  DB_ERROR: 'DB_ERROR',
});

/** 把失败类别映射成退出码（唯一映射点）。 */
export function exitCodeFor(failureKind) {
  switch (failureKind) {
    case FAILURE_KINDS.INVALID_POLICY:
      return EXIT_CODES.INVALID_POLICY;
    case FAILURE_KINDS.POLICY_CONFLICT:
    case FAILURE_KINDS.METADATA_CONFLICT:
      return EXIT_CODES.POLICY_CONFLICT;
    case FAILURE_KINDS.DB_ERROR:
      return EXIT_CODES.DB_ERROR;
    default:
      return EXIT_CODES.CONFIG;
  }
}

/** 小写 uuid（`reviewed_by` / `recipients.id` 的形状判据）。 */
export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/**
 * 归一化正文：去 BOM ⇒ 统一行尾 ⇒ 去尾部空白。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizePolicyBody(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\s+$/u, '');
}

/**
 * 正文的 `content_sha256`：归一化后 UTF-8 字节的 sha256，**小写十六进制**
 * （`0009` 的 `CHECK (content_sha256 ~ '^[0-9a-f]{64}$')` 只认这个形状）。
 * @param {string} normalizedBody 已由 `normalizePolicyBody` 归一化
 * @returns {string}
 */
export function contentSha256ForBody(normalizedBody) {
  return createHash('sha256').update(normalizedBody, 'utf8').digest('hex');
}

/** 正文首行的码点数（dry-run 只报长度，不报内容）。 */
export function firstLineChars(normalizedBody) {
  const [first = ''] = normalizedBody.split('\n');
  return [...first].length;
}

/** 码点长度（中文按字算，不按 UTF-16 单元算）。 */
const charCount = (text) => [...text].length;

/** 版本号的「自然序」切分：数字段与文本段分开，数字段按数值比。 */
function versionTokens(version) {
  const tokens = [];
  const pattern = /(\d+)|(\D+)/g;
  let match;
  while ((match = pattern.exec(version)) !== null) {
    if (match[1] !== undefined) tokens.push({ numeric: true, value: match[1] });
    else tokens.push({ numeric: false, value: match[2] });
  }
  return tokens;
}

/**
 * 版本号比较（自然序）：`v2 < v10`，`2026.10-1 < 2026.10-2`，数字段按数值、文本段按码点。
 * 前缀更短的排在前（`v1 < v1.1`）。相等返回 0。
 * @param {string} left @param {string} right
 * @returns {number} -1 | 0 | 1
 */
export function comparePolicyVersions(left, right) {
  if (left === right) return 0;
  const a = versionTokens(left);
  const b = versionTokens(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x.numeric && y.numeric) {
      // 去掉前导零再比：`007` 与 `7` 同值，位数更多者更大。
      const xn = x.value.replace(/^0+(?=\d)/, '');
      const yn = y.value.replace(/^0+(?=\d)/, '');
      if (xn.length !== yn.length) return xn.length < yn.length ? -1 : 1;
      if (xn !== yn) return xn < yn ? -1 : 1;
      continue;
    }
    if (x.numeric !== y.numeric) {
      // 数字段与文本段混排时退回字符串序（`v1` vs `vX`），保证是**全序**、不会两边都 -1。
      return x.value < y.value ? -1 : 1;
    }
    if (x.value !== y.value) return x.value < y.value ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * 该 `purpose` 已有的最大版本（空数组返回 `null`）。
 * @param {string[]} versions
 * @returns {string|null}
 */
export function maxPolicyVersion(versions) {
  let max = null;
  for (const version of versions) {
    if (max === null || comparePolicyVersions(version, max) > 0) max = version;
  }
  return max;
}

/** `0009` 的 `CHECK (content_sha256 ~ '^[0-9a-f]{64}$')`：小写十六进制、恰好 64 位。 */
export function isContentSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * 来源 / 复核证据的**形状**（与 `privacy/grant-pg.ts` 的 `evidence()` 同口径）：
 * `verified` ⇒ 无凭据的 `https:` URL；`synthetic` ⇒ `fixture://<路径>`。
 * 形状不符的行能被写进库，但 `persistConsentGrant` 会判「来源尚未核验」⇒ 闸门依旧关着。
 * 工具在写入前就拒掉，免得运维以为「导入了就通了」。
 * @param {unknown} value @param {boolean} synthetic
 * @returns {boolean}
 */
export function isEvidenceRef(value, synthetic) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return false;
  if (synthetic) return /^fixture:\/\/[a-z0-9/_-]+$/i.test(value);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** RFC 3339 时间戳（必须带时区，不许裸日期）。 */
function parseInstant(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** 命中占位词？拉丁词要求词边界，中文词按子串。 */
function placeholderHit(normalizedBody) {
  const lower = normalizedBody.toLowerCase();
  for (const token of LATIN_PLACEHOLDERS) {
    const pattern = new RegExp(`(?:^|[^a-z])${token}(?:[^a-z]|$)`);
    if (pattern.test(lower)) return token;
  }
  for (const token of CJK_PLACEHOLDERS) {
    if (normalizedBody.includes(token)) return token;
  }
  return null;
}

/** 这个 URL 指向的显然是「不存在的域」？ */
function isNonRealHost(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (host.endsWith('.invalid') || host.endsWith('.test') || host.endsWith('.example')) return true;
  return FIXTURE_HOSTS.includes(host);
}

/** 正文里出现「我其实是夹具」的措辞？（只在 `verified` 时用来判伪） */
function fixtureWording(body) {
  const lower = body.toLowerCase();
  for (const token of FIXTURE_BODY_TOKENS) {
    if (lower.includes(token)) return token;
  }
  return null;
}

/**
 * `recipient_bindings` 的逐条形状校验（与 `privacy/grant-pg.ts` 逐字段比对的那七项同口径）。
 *
 * 为什么政策行也要管这里：`persistConsentGrant` 会拿绑定逐项比 `recipients` 行
 * （`config_version` / `policy_version` / `capability` / 两个留存天数），并再验两条证据的形状。
 * 绑定写歪了，政策行能进库，但**授予永远 403** —— 「导入成功」与「闸门开了」就成了两件事。
 *
 * @param {Record<string, unknown>} bindings
 * @param {{ synthetic: boolean }} options
 * @returns {string[]} 逐条错误（空数组 = 通过）
 */
export function validateRecipientBindings(bindings, { synthetic }) {
  /** @type {string[]} */
  const errors = [];
  for (const [id, raw] of Object.entries(bindings)) {
    if (id.length < 1 || id.length > 80) errors.push(`recipient_bindings 的键「${id}」长度必须 1..80`);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`recipient_bindings['${id}'] 必须是对象`);
      continue;
    }
    const binding = /** @type {Record<string, unknown>} */ (raw);
    const capability = binding['capability'];
    if (typeof capability !== 'string' || !RECIPIENT_CAPABILITY_CLOSED_SET.includes(capability)) {
      errors.push(`recipient_bindings['${id}'].capability 必须是 ${RECIPIENT_CAPABILITY_CLOSED_SET.join(' / ')} 之一`);
    }
    for (const key of ['config_version', 'policy_version']) {
      const value = binding[key];
      if (typeof value !== 'string' || value.length < 1 || value.length > 80) {
        errors.push(`recipient_bindings['${id}'].${key} 必须是 1..80 字符的字符串`);
      }
    }
    for (const [key, max] of [['retention_online_days', RETENTION_ONLINE_MAX], ['retention_backup_days', RETENTION_BACKUP_MAX]]) {
      const value = binding[key];
      if (!Number.isSafeInteger(value) || value < 0 || value > max) {
        errors.push(`recipient_bindings['${id}'].${key} 必须是 0..${max} 的整数（契约上限）`);
      }
    }
    for (const key of ['no_training_evidence_ref', 'deletion_evidence_ref']) {
      if (!isEvidenceRef(binding[key], synthetic)) {
        errors.push(`recipient_bindings['${id}'].${key} 形状不符（${synthetic ? 'fixture://<路径>' : '无凭据的 https:// URL'}）`);
      }
    }
  }
  return errors;
}

/**
 * 读一份**仓外**政策清单并做全部强校验（唯一入口；命令行与测试都走它）。
 *
 * @param {string|object} input JSON 文本或已解析对象
 * @param {{ now?: Date }} [options] 注入的「当前时刻」（用于 `valid_until` 的早期发现；权威判据在库里的 `clock_timestamp()`）
 * @returns {{ ok: true, policy: object } | { ok: false, code: string, errors: string[] }}
 */
export function readPolicyManifest(input, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  /** @type {string[]} */
  const errors = [];
  let manifest = input;
  if (typeof input === 'string') {
    try {
      manifest = JSON.parse(input);
    } catch {
      return { ok: false, code: FAILURE_KINDS.CONFIG, errors: ['政策清单不是合法 JSON'] };
    }
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, code: FAILURE_KINDS.CONFIG, errors: ['政策清单必须是一个 JSON 对象'] };
  }
  const record = /** @type {Record<string, unknown>} */ (manifest);

  // ── 键白名单 + 自算/越权字段禁传 ───────────────────────────────────────
  for (const key of Object.keys(record)) {
    if (key === 'content_sha256') {
      errors.push('content_sha256 由工具自算，不接受调用方传入（清单里删掉这个键）');
      continue;
    }
    if (key === 'reviewed_by') {
      errors.push('reviewed_by 不是清单字段：复核主体由命令行 --reviewed-by <admin uuid> 断言');
      continue;
    }
    if (!POLICY_MANIFEST_KEYS.includes(key)) errors.push(`未知字段「${key}」：清单只接受 ${POLICY_MANIFEST_KEYS.join(' / ')}`);
  }

  // ── purpose：闭集真值 ──────────────────────────────────────────────────
  const purpose = record['purpose'];
  if (typeof purpose !== 'string' || !CONSENT_PURPOSE_CLOSED_SET.includes(purpose)) {
    errors.push(`purpose 必须是 CONSENT_PURPOSES 闭集成员（${CONSENT_PURPOSE_CLOSED_SET.join(' / ')}），实测 ${JSON.stringify(purpose)}`);
  }

  // ── policy_version：长度 / 形状 / 保留值 ───────────────────────────────
  const version = record['policy_version'];
  if (typeof version !== 'string') {
    errors.push('policy_version 必须是字符串');
  } else if (charCount(version) < 1 || charCount(version) > MAX_POLICY_VERSION_CHARS) {
    errors.push(`policy_version 长度必须在 1..${MAX_POLICY_VERSION_CHARS} 之间，实测 ${charCount(version)}`);
  } else if (version.trim() !== version || /\s/.test(version)) {
    errors.push('policy_version 不许含空白，也不许首尾带空白');
  } else if (version === UNPUBLISHED_POLICY_VERSION) {
    errors.push(`policy_version 不许用保留哨兵「${UNPUBLISHED_POLICY_VERSION}」：读面拿它表示「尚无已发布政策」`);
  }

  // ── source_kind / 两个证据引用 ─────────────────────────────────────────
  const sourceKind = record['source_kind'];
  if (typeof sourceKind !== 'string' || !SOURCE_KINDS.includes(sourceKind)) {
    errors.push(`source_kind 必须是 ${SOURCE_KINDS.join(' / ')} 之一，实测 ${JSON.stringify(sourceKind)}`);
  }
  const synthetic = sourceKind === 'synthetic';
  for (const key of ['source_ref', 'review_evidence_ref']) {
    const value = record[key];
    if (!isEvidenceRef(value, synthetic)) {
      errors.push(`${key} 形状不符：${synthetic ? 'synthetic 需 fixture://<路径>' : 'verified 需无凭据的 https:// URL'}（与 grant-pg 的 evidence() 同口径）`);
    }
  }

  // ── body：非空 / 够长 / 不是占位 ⇒ 自算 sha ────────────────────────────
  const normalizedBody = normalizePolicyBody(record['body']);
  const bodyChars = charCount(normalizedBody);
  if (bodyChars === 0) {
    errors.push('body 不许为空：正文由仓外政策清单提供，工具不内置任何政策文本');
  } else if (bodyChars < MIN_BODY_CHARS) {
    errors.push(`body 太短（${bodyChars} < ${MIN_BODY_CHARS} 码点）：疑似占位或截断`);
  }
  const hit = placeholderHit(normalizedBody);
  if (hit !== null) errors.push(`body 命中占位词「${hit}」：请换成真正的政策正文`);

  // ── verified 不许拿夹具冒充（启发式，不是证明）────────────────────────
  if (sourceKind === 'verified') {
    const fakeHost = ['source_ref', 'review_evidence_ref'].find((key) => isNonRealHost(record[key]));
    if (fakeHost !== undefined) {
      errors.push(`${fakeHost} 指向不存在的域：source_kind=verified 要求真实可核验的出处（合成夹具请如实标 synthetic）`);
    }
    const wording = fixtureWording(normalizedBody);
    if (wording !== null) {
      errors.push(`body 出现夹具措辞「${wording}」但 source_kind=verified：冒充会被读面当成真政策（合成请如实标 synthetic）`);
    }
  }

  // ── recipient_bindings：JSON 对象 + 逐条形状 ───────────────────────────
  // ⚠ 用 `undefined` 判缺省而不是 `?? {}`：`null` 是**非法值**，不能被静默当成 `{}`
  // （`0009` 的 CHECK 只接受 object，静默补默认值等于替调用方编了个值）。
  const bindings = record['recipient_bindings'] === undefined ? {} : record['recipient_bindings'];
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    errors.push('recipient_bindings 必须是 JSON 对象（0009 的 CHECK 只接受 object）');
  } else {
    errors.push(...validateRecipientBindings(bindings, { synthetic }));
  }

  // ── valid_from / valid_until：形状 + 先后 + 早于 now 的早期发现 ─────────
  const validUntil = parseInstant(record['valid_until']);
  if (validUntil === null) errors.push('valid_until 必须是带时区的 RFC 3339 时间戳（例如 2027-10-29T00:00:00Z）');
  else if (validUntil.getTime() <= now.getTime()) errors.push('valid_until 必须晚于当前时刻（否则导入即过期，闸门依旧关着）');

  let validFrom = null;
  let validFromIso = null;
  if (record['valid_from'] !== undefined) {
    const parsed = parseInstant(record['valid_from']);
    if (parsed === null) errors.push('valid_from 若给，必须是带时区的 RFC 3339 时间戳');
    else {
      validFrom = parsed;
      validFromIso = parsed.toISOString();
    }
  }
  if (validFrom !== null && validUntil !== null && validFrom.getTime() >= validUntil.getTime()) {
    errors.push('valid_from 必须早于 valid_until（0009 的 CHECK (valid_until>valid_from)）');
  }

  if (errors.length > 0) return { ok: false, code: FAILURE_KINDS.INVALID_POLICY, errors };

  return {
    ok: true,
    policy: {
      purpose,
      policy_version: version,
      source_kind: sourceKind,
      source_ref: record['source_ref'],
      review_evidence_ref: record['review_evidence_ref'],
      recipient_bindings: bindings,
      content_sha256: contentSha256ForBody(normalizedBody),
      valid_from: validFromIso,
      valid_until: validUntil.toISOString(),
      // ⛔ 正文不返回：只在下面两个计数与 sha 里存在。
      body_chars: bodyChars,
      body_first_line_chars: firstLineChars(normalizedBody),
    },
  };
}

/** 稳定键序的 JSON（用于比对 `recipient_bindings`：键序不同不等于绑定不同，值不同才等于）。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const pairs = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** `jsonb` 列在不同驱动/手写夹具下可能是对象也可能是 JSON 文本 ⇒ 统一成对象再比。 */
function bindingsObject(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value ?? {};
}

/** 时刻的毫秒值（非法/缺省 ⇒ `null`）：同一时刻的不同写法（`…Z` 与 `….000Z`）不算冲突。 */
function instantMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 一列安全元数据的**规范化文本**（比对与报告共用同一个渲染，避免「报告说相等、比对说不同」）。
 * 时刻 ⇒ `toISOString()`（毫秒精度、UTC）；`null` ⇒ 字面量 `(null)`；绑定 ⇒ 稳定键序 JSON。
 * @param {string} field `POLICY_SAFETY_METADATA_FIELDS` 的成员
 * @param {unknown} value 库行或清单侧的原值
 * @returns {string}
 */
export function renderSafetyMetadataValue(field, value) {
  switch (field) {
    case 'valid_from':
    case 'valid_until': {
      const ms = instantMillis(value);
      return ms === null ? '(null)' : new Date(ms).toISOString();
    }
    case 'recipient_bindings':
      return canonicalJson(bindingsObject(value));
    default:
      return value === null || value === undefined ? '(null)' : String(value);
  }
}

/** 清单侧那一列的值（`reviewed_by` 不在清单里，来自命令行 `--reviewed-by`）。 */
function manifestMetadataValue(field, policy, reviewedBy) {
  switch (field) {
    case 'source_kind': return policy.source_kind;
    case 'source_ref': return policy.source_ref;
    case 'review_evidence_ref': return policy.review_evidence_ref;
    case 'valid_from': return policy.valid_from;
    case 'valid_until': return policy.valid_until;
    case 'reviewed_by': return reviewedBy;
    case 'recipient_bindings': return policy.recipient_bindings;
    default: return null;
  }
}

/**
 * 库行那一列的值（报告用；⛔ 读不到就说读不到，不许拿清单顶替）。
 * @param {string} field @param {object} row
 * @returns {string} 规范化文本；列缺失 ⇒ `(缺列)`
 */
export function libraryMetadataValue(field, row) {
  if (row === null || row === undefined || !(field in row) || row[field] === undefined) return '(缺列)';
  return renderSafetyMetadataValue(field, row[field]);
}

/**
 * **同版本重放/启用的安全元数据一致性**（纯函数，唯一判据点）。
 *
 * 规则（逐字段，⛔ 不许「有一项不同就整体放过」）：
 *
 * 1. `source_kind` / `source_ref` / `review_evidence_ref` / `valid_until` / `recipient_bindings`：
 *    清单一定声明了它们 ⇒ **无条件比对**；
 * 2. `valid_from`：清单省略它时库列由库钟生成（工具自己写的），清单没有可断言的值 ⇒ 该维度跳过
 *    （报告里如实写 `(清单未声明)`）；清单声明了就必须与库行**同一时刻**；
 * 3. `reviewed_by`：清单不许带它，断言来自命令行 `--reviewed-by`。没给 `--reviewed-by` ⇒ 本次不主张
 *    任何复核主体 ⇒ 跳过；给了而与**已有**的 `reviewed_by` 不同 ⇒ 冲突（否则就是「拿别人的复核记录
 *    冒充本次复核」，而 `enabled` 那条 UPDATE 的 `COALESCE` 会让它静默不生效）。库行 `reviewed_by`
 *    仍是 `null`（草稿从未复核）⇒ 不算冲突：本次启用正要写它；
 * 4. 库行缺列（调用方 `SELECT` 没取全）⇒ **冲突**，不是「一致」：读不到就不能证明相等。
 *
 * @param {{ policy: object, row: object|null, reviewedBy?: string|null }} input
 * @returns {{ ok: true, compared: string[], skipped: string[] }
 *   | { ok: false, code: string, reason: string, conflicts: Array<{field: string, library: string, manifest: string}> }}
 */
export function comparePolicySafetyMetadata({ policy, row, reviewedBy = null }) {
  /** @type {Array<{field: string, library: string, manifest: string}>} */
  const conflicts = [];
  if (row === null || row === undefined) {
    return { ok: false, code: FAILURE_KINDS.METADATA_CONFLICT, reason: '没有库行可比对安全元数据（调用方必须先读出该行）', conflicts };
  }
  const missing = POLICY_SAFETY_METADATA_FIELDS.filter((field) => !(field in row) || row[field] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      code: FAILURE_KINDS.METADATA_CONFLICT,
      reason: `现库行的安全元数据读不全（缺列：${missing.join(' / ')}）⇒ 无法证明与清单一致，判冲突。`
        + 'SELECT 必须取全 source_kind/source_ref/review_evidence_ref/valid_from/valid_until/reviewed_by/recipient_bindings（⛔ 不许把「没取」当成「相同」）。',
      conflicts: missing.map((field) => ({ field, library: '(缺列)', manifest: renderSafetyMetadataValue(field, manifestMetadataValue(field, policy, reviewedBy)) })),
    };
  }

  /** @type {string[]} */
  const compared = [];
  /** @type {string[]} */
  const skipped = [];
  for (const field of POLICY_SAFETY_METADATA_FIELDS) {
    const asserted = (field !== 'valid_from' || (policy.valid_from !== null && policy.valid_from !== undefined))
      && (field !== 'reviewed_by' || (reviewedBy !== null && reviewedBy !== undefined));
    if (!asserted) {
      skipped.push(field);
      continue;
    }
    compared.push(field);
    const library = renderSafetyMetadataValue(field, row[field]);
    const manifest = renderSafetyMetadataValue(field, manifestMetadataValue(field, policy, reviewedBy));
    if (library === manifest) continue;
    // 库行还没复核过（草稿）⇒ 本次启用正要写 reviewed_by，不是「旧元数据」。
    if (field === 'reviewed_by' && (row[field] === null || row[field] === undefined)) continue;
    conflicts.push({ field, library, manifest });
  }

  if (conflicts.length === 0) return { ok: true, compared, skipped };
  const detail = conflicts.map((item) => `${item.field}: 库行 ${item.library} → 清单 ${item.manifest}`).join('；');
  return {
    ok: false,
    code: FAILURE_KINDS.METADATA_CONFLICT,
    reason: `同 (purpose, policy_version) 已存在，但安全元数据与清单不一致（${detail}）。`
      + '这一行不能就地改（0009 的 consent_policy_immutable 只放 enabled/updated_at），'
      + '所以「重放」不能把它变成清单说的样子：要么改用新的 policy_version，要么按库行现状处理 —— '
      + '⛔ 不许把清单的来源/有效期/复核主体当成已生效。',
    conflicts,
  };
}

/**
 * **幂等 / 单调 / 启用的判定**（纯函数；`existing` 由调用方在事务里读出来）。
 *
 * `existing` 只取目标 `purpose` 的行，元素形状：
 * `{ policy_version, content_sha256, enabled, reviewed_at }` **加上** `POLICY_SAFETY_METADATA_FIELDS`
 * 那七列（`source_kind` / `source_ref` / `review_evidence_ref` / `valid_from` / `valid_until` /
 * `reviewed_by` / `recipient_bindings`）。⚠ 缺列会被判冲突，不是「一致」。
 *
 * @param {object} input
 * @param {object} input.policy `readPolicyManifest` 返回的 policy
 * @param {Array<object>} input.existing 该 purpose 的现库行
 * @param {boolean} input.wantEnable 是否 `--enable`
 * @param {string|null} [input.reviewedBy] 命令行 `--reviewed-by` 的 admin uuid（启用时必需）
 * @param {string|Date|null} [input.dbNow] 库钟（`clock_timestamp()`）；给了就据此复核 `valid_until`
 * @returns {{ ok: true, action: 'insert'|'enable'|'unchanged', disabled_others: string[], enabled_after: boolean }
 *   | { ok: false, code: string, reason: string }}
 */
export function planConsentPolicyImport({ policy, existing, wantEnable, reviewedBy = null, dbNow = null }) {
  if (dbNow !== null) {
    const nowMs = dbNow instanceof Date ? dbNow.getTime() : new Date(dbNow).getTime();
    if (!Number.isFinite(nowMs)) return { ok: false, code: FAILURE_KINDS.INVALID_POLICY, reason: '库钟不可读：无法核对 valid_until' };
    if (new Date(policy.valid_until).getTime() <= nowMs) {
      return { ok: false, code: FAILURE_KINDS.INVALID_POLICY, reason: 'valid_until 不晚于库里的 clock_timestamp()（导入即过期）' };
    }
    if (policy.valid_from !== null && new Date(policy.valid_from).getTime() >= new Date(policy.valid_until).getTime()) {
      return { ok: false, code: FAILURE_KINDS.INVALID_POLICY, reason: 'valid_from 不早于 valid_until（撞 0009 的 CHECK）' };
    }
  }
  if (wantEnable && reviewedBy !== null && !isUuid(reviewedBy)) {
    return { ok: false, code: FAILURE_KINDS.INVALID_POLICY, reason: '--reviewed-by 必须是 admin_accounts.id 的小写 uuid' };
  }

  const target = existing.find((row) => row.policy_version === policy.policy_version) ?? null;
  const maxVersion = maxPolicyVersion(existing.map((row) => row.policy_version));

  if (target !== null) {
    if (target.content_sha256 !== policy.content_sha256) {
      return {
        ok: false,
        code: FAILURE_KINDS.POLICY_CONFLICT,
        reason: `同 (purpose, policy_version) 已存在但正文 sha256 不同：库内 ${target.content_sha256} / 清单 ${policy.content_sha256}。`
          + '政策正文不可就地修改（0009 的 consent_policy_immutable 触发器），请改用新的 policy_version。',
      };
    }
    // 正文相同还不够：来源 / 有效期 / 复核主体 / 绑定也必须与**库行**一致，否则「unchanged」与
    // 「--enable 旧行」都会把没导入过的元数据说成已生效。这一关在 enable 判定之前。
    const metadata = comparePolicySafetyMetadata({ policy, row: target, reviewedBy });
    if (metadata.ok !== true) {
      return { ok: false, code: metadata.code, reason: metadata.reason, conflicts: metadata.conflicts };
    }
    if (wantEnable && target.enabled !== true) {
      if (maxVersion !== null && comparePolicyVersions(policy.policy_version, maxVersion) < 0) {
        return {
          ok: false,
          code: FAILURE_KINDS.POLICY_CONFLICT,
          reason: `不许启用比库里最新版本更旧的 ${policy.policy_version}（最新 ${maxVersion}）：那是版本回退。`,
        };
      }
      if ((target.reviewed_at === null || target.reviewed_at === undefined) && reviewedBy === null) {
        return { ok: false, code: FAILURE_KINDS.INVALID_POLICY, reason: '启用需要 --reviewed-by <admin uuid>（0009 的 CHECK (NOT enabled OR reviewed_at IS NOT NULL)）' };
      }
      return {
        ok: true, action: PLAN_ACTIONS.ENABLE, disabled_others: otherEnabled(existing, policy.policy_version), enabled_after: true,
      };
    }
    return { ok: true, action: PLAN_ACTIONS.UNCHANGED, disabled_others: [], enabled_after: target.enabled === true };
  }

  if (maxVersion !== null && comparePolicyVersions(policy.policy_version, maxVersion) < 0) {
    return {
      ok: false,
      code: FAILURE_KINDS.POLICY_CONFLICT,
      reason: `policy_version 回退：清单 ${policy.policy_version} 早于该 purpose 已有的最大版本 ${maxVersion}。只允许追加更新版本。`,
    };
  }
  if (wantEnable && reviewedBy === null) {
    return { ok: false, code: FAILURE_KINDS.INVALID_POLICY, reason: '--enable 需要 --reviewed-by <admin uuid>（见 0009 的 CHECK 与 reviewed_by 外键）' };
  }
  return {
    ok: true,
    action: PLAN_ACTIONS.INSERT,
    disabled_others: wantEnable ? otherEnabled(existing, policy.policy_version) : [],
    enabled_after: wantEnable === true,
  };
}

/** 同 purpose 里「当前 enabled、且不是目标版本」的那些版本号（启用时要被关掉）。 */
function otherEnabled(existing, targetVersion) {
  return existing
    .filter((row) => row.enabled === true && row.policy_version !== targetVersion)
    .map((row) => row.policy_version)
    .sort();
}

/**
 * 只能提示、不能拒绝的两件事（打印成 `warning=` 行，⛔ 不许静默）。
 *
 * 二者的共同点：这一行**能写进库**，但闸门不会因此打开。工具没有权限替产品语义决定「要不要写」，
 * 于是把「写进去了也不生效」如实说出来。
 */
export function policyImportWarnings({ policy, dbNow = null }) {
  /** @type {string[]} */
  const warnings = [];
  if (policy.purpose === 'external_inference' && Object.keys(policy.recipient_bindings).length === 0) {
    warnings.push(
      'purpose=external_inference 但 recipient_bindings 为空：grant-pg 会以「对外推理需要已核验接收方」403，'
        + '本行单独不能打开这条用途（public.recipients 目前仍是零写入，本工具不写它）。',
    );
  }
  if (dbNow !== null && policy.valid_from !== null && new Date(policy.valid_from).getTime() > new Date(dbNow).getTime()) {
    warnings.push(`valid_from=${policy.valid_from} 在未来 ⇒ 该政策尚未生效，闸门此刻仍关着。`);
  }
  return warnings;
}

/**
 * 政策清单的报告行（**⛔ 不含正文**，只含正文的两项读数）。
 *
 * ## 来源纪律（⛔ 这一节就是本片修的东西）
 *
 * `source_kind` / `source_ref` / `review_evidence_ref` / `valid_from` / `valid_until` / `reviewed_by` /
 * `recipient_bindings` 这七行**一律取实际库行**（`row`）：
 *
 *   * 重放（`unchanged`）⇒ 传库里的那一行；
 *   * 写入（`insert` / `enable`）⇒ 传**刚写完再读回来**的那一行；
 *   * 一行都还没有（首次插入的 dry-run）⇒ 这些键打印 `(未写入)`，并且 `metadata_source=none`，
 *     清单值只以 `manifest_*` 前缀出现，⛔ 不许用一个裸键冒充库行状态。
 *
 * `recipient_bindings` 在报告里是**条数** + `recipient_binding_ids`（键名），不打印绑定正文：
 * 逐字段的**值**比对在 `comparePolicySafetyMetadata` 里做（不一致就已经 exit 4，轮不到报告），
 * 报告只需要说明「库行绑了谁、几条」。两处都取自库行，⛔ 不取清单。
 *
 * 于是「报告说 verified、库里还是 synthetic」在结构上不可能：报告没有第二个取值来源。
 * `request_reviewed_by` 是命令行断言（请求），与库行的 `reviewed_by`（事实）分开列。
 *
 * @param {{ policy: object, plan: object, mode: 'dry-run'|'apply', file: string,
 *   row?: object|null, enabledAfter: boolean, reviewedBy: string|null, warnings?: string[] }} input
 * @returns {string[]}
 */
export function renderPolicyImportReport({ policy, plan, mode, file, row = null, enabledAfter, reviewedBy, warnings = [] }) {
  const hasRow = row !== null && row !== undefined;
  const fromRow = (field) => (hasRow ? libraryMetadataValue(field, row) : '(未写入)');
  const bindings = hasRow && row.recipient_bindings !== undefined ? bindingsObject(row.recipient_bindings) : null;
  const bindingIds = bindings !== null && typeof bindings === 'object' && !Array.isArray(bindings)
    ? Object.keys(bindings).sort()
    : [];
  const lines = [
    `mode=${mode}`,
    `file=${file}`,
    `action=${plan.action}`,
    `unchanged=${plan.action === PLAN_ACTIONS.UNCHANGED ? 'true' : 'false'}`,
    `metadata_source=${hasRow ? 'library_row' : 'none'}`,
    `purpose=${hasRow ? (row.purpose ?? policy.purpose) : policy.purpose}`,
    `policy_version=${hasRow ? (row.policy_version ?? policy.policy_version) : policy.policy_version}`,
    `content_sha256=${hasRow ? (row.content_sha256 ?? policy.content_sha256) : policy.content_sha256}`,
    `source_kind=${fromRow('source_kind')}`,
    `source_ref=${fromRow('source_ref')}`,
    `review_evidence_ref=${fromRow('review_evidence_ref')}`,
    `recipient_bindings=${bindings === null ? '(未写入)' : bindingIds.length}`,
    `recipient_binding_ids=${bindings === null ? '(未写入)' : (bindingIds.length === 0 ? '(none)' : bindingIds.join(','))}`,
    `valid_from=${hasRow ? fromRow('valid_from') : '(未写入)'}`,
    `valid_until=${fromRow('valid_until')}`,
    `reviewed_by=${fromRow('reviewed_by')}`,
    `request_reviewed_by=${reviewedBy ?? '(null)'}`,
    `enabled_after=${enabledAfter ? 'true' : 'false'}`,
    // 正文只有这两项读数：首行长度 + 总长。⛔ 不打印正文本身。
    `body_first_line_chars=${policy.body_first_line_chars}`,
    `body_chars=${policy.body_chars}`,
  ];
  // 一行都还没有时，清单里声明的形状只以 manifest_* 出现：看得见「会写成什么」，但不可能被读成库行状态。
  if (!hasRow) {
    for (const field of POLICY_SAFETY_METADATA_FIELDS) {
      lines.push(`manifest_${field}=${renderSafetyMetadataValue(field, manifestMetadataValue(field, policy, reviewedBy))}`);
    }
  }
  if (plan.disabled_others.length > 0) lines.push(`disabled_others=${plan.disabled_others.join(',')}`);
  for (const warning of warnings) lines.push(`warning=${warning}`);
  return lines;
}

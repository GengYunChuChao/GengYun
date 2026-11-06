/**
 * GY-R83 · `#1003`：识别链路的**调用元数据**（用量 + 剖面版本串）的读取口。
 *
 * 本文件只做两件事，都是**纯函数**、零 IO、零网络：
 *   1. {@link readCallMetadata} —— 从 OpenAI 兼容回包里读**结构用量**（`usage`）；
 *   2. {@link providerConfigVersionOf} —— 把「哪套剖面 / 哪个模型 / 打到哪个端点」压成一个
 *     **可落库、可回查、不含端点原文**的版本串。
 *
 * ## 为什么这两件事必须在一处
 * 迁移 `0055_provider_call_ledger` 的两列（`usage` / `provider_config_version`）是同一个问题的
 * 两半：「这次外发烧了多少」与「用的是哪套配置」。两者都只从**回包与装配参数**派生，不读库、
 * 不读 env；写在适配器里会让适配器同时承担「发请求」和「定计量口径」，写在账本侧则拿不到回包。
 * 所以抽成一个不依赖任何端口的模块，由适配器在**成功分支**填、由记账层在**落库前**复核。
 *
 * ## 口径（与既有实现逐条对齐，不得各自发明）
 * - 用量只认**顶层** `usage` 对象，⛔ 不读 `choices`、⛔ 不读正文/图片字节；
 * - 只保留**非负整数**键值（`number` 且 `Number.isSafeInteger`），键名走
 *   `^[a-z][a-z0-9_]{0,39}$`、最多 {@link CALL_USAGE_MAX_KEYS} 键 —— 与
 *   `privacy/ledger-pg.ts` 的 `sanitizedUsage`（0050 那张表的 `usage` 列收口）同一套
 *   规则，两处对同一份回包必须得同一个结果；
 * - 版本串形状 = 迁移 `0055` 的 CHECK：`^[A-Za-z0-9][A-Za-z0-9._:/#+@-]{0,79}$`（1..80 字符）。
 *
 * ## 证据边界（诚实标注）
 * ⚠ 本仓**没有实测样本**：OpenAI 兼容回包 `usage` 的键名与值类型来自供应商文档
 * （`prompt_tokens` / `completion_tokens` / `total_tokens`），不是本仓跑出来的观测值。因此这里
 * **只做形状收口**（键名合法、值是非负整数、键数有上限），不认识具体键名 —— 供应商多给一个
 * 合法键也不会丢，乱给一个嵌套对象/负数/超长键也不会进库。
 */
import { createHash } from 'node:crypto';

/**
 * `usage` 最多保留的键数（与 `privacy/ledger-pg.ts:112` 的 `USAGE_MAX_KEYS` 同值）。
 *
 * 为什么有上限：`usage` 是**结构读数**不是自由文本；无上限时一个畸形/恶意的回包可以用几万个
 * 键把 jsonb 撑大，而账本是追加式表、没有任何清理路径。
 */
export const CALL_USAGE_MAX_KEYS = 8;

/** `usage` 的键形状：小写字母开头、其后小写字母/数字/下划线，总长 1..40。 */
const CALL_USAGE_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** 单个计数的上界：超过一万亿的「token 数」只可能是脏数据或溢出，不进库。 */
const CALL_USAGE_MAX_VALUE = 1_000_000_000_000;

/**
 * 版本串形状（**与迁移 `0055` 的 CHECK 逐字一致**）。
 *
 * 改这里必须同时改 `0055_provider_call_ledger.sql` 的 `provider_call_ledger_version_shape`：
 * 前端宽后窄 ⇒ 落库 42501/23514（记账丢行）；前窄后宽 ⇒ 版本串被静默拒（更坏的假绿）。
 *
 * ⚠ 与 0050 的版本串约束（`…_version_shape`）差**一个字符**：这里多允许 `@`。
 * 因为本片的版本串格式是 `` `${profile}#${model}@${sha256(hostname).slice(0,8)}` `` —— 分隔符
 * 就是 `@`，而 0050 那套字符类里没有它；照抄会让每个带主机摘要的串都被 CHECK 拒掉。
 */
export const CALL_VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/#+@-]{0,79}$/;

/** 版本串的**最后兜底**：形状本身合法、且明确表示「不知道」。⛔ 绝不写空串（列是 NOT NULL）。 */
const CALL_VERSION_UNKNOWN = 'unknown';

/**
 * 从一次外发的**返回值**里读结构用量。
 *
 * 入参是「回包根对象」或「适配器已经挂好 `usage` 的 outcome」，两者形状相同：都只读**顶层**
 * `usage`。因此本函数天然可重入（适配器写一次、记账层再核一次，结果不变）。
 *
 * @returns 收口后的 `{键: 非负整数}`；没有可用的 `usage` 时 `null`（⛔ 不返回 `{}` —— 空对象会让
 *          「供应商根本没说用量」与「说了但一个键都不合法」在库里长得一样）。
 */
export function readCallMetadata(payload: unknown): Record<string, number> | null {
  const usage = (payload as { usage?: unknown } | null | undefined)?.usage;
  if (usage === null || usage === undefined) return null;
  if (typeof usage !== 'object' || Array.isArray(usage)) return null;
  const out: Record<string, number> = {};
  for (const key of Object.keys(usage as Record<string, unknown>)) {
    if (Object.keys(out).length >= CALL_USAGE_MAX_KEYS) break;
    if (!CALL_USAGE_KEY.test(key)) continue;
    const raw = (usage as Record<string, unknown>)[key];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > CALL_USAGE_MAX_VALUE) continue;
    out[key] = raw;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** 取端点的主机名（**只有主机名**进摘要；路径/查询串/密钥一律不读、不落）。 */
function hostnameOf(endpoint: unknown): string | null {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null;
  try {
    const host = new URL(endpoint).hostname;
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * 把「哪套剖面 / 哪个模型 / 打到哪个端点」压成版本串：`` `${profile}#${model}@${hostHash8}` ``。
 *
 * 形状取舍（三条都是刻意的）：
 * - **`profile` 与 `model` 是明文**：它们不是机密（`openai-vision-v1` / `gpt-4o-mini`），而排障时
 *   最需要的恰恰是「这次用的是哪套剖面」；0050 那张表的 `model_version` 也一直是明文。
 * - **端点只留 8 位主机摘要**：端点常带租户/区域信息，完整 URL 还会夹带查询串与凭据片段；
 *   摘要足以回答「换没换端点」，不足以还原端点本身。⛔ 本函数不产出 endpoint 的任何原文。
 * - **非法/超长 ⇒ 降级**：先降 `profile`，再降 `unknown`。降级**不是**静默丢字段，而是「写一个
 *   形状合法、且明确表示不知道」的值 —— 列是 `NOT NULL` + CHECK，宁可有损也不让记账行整条丢。
 *
 * 已知边界（诚实）：模型名含空格、中文、`!` 等 CHECK 字符类外字符时，完整串会被降级成 `profile`；
 * 模型名 ≥ 70 字符时（`profile` + `#` + 模型 + `@` + 8 位 > 80）同样降级。两种情况下
 * `model_version` 列仍会单独写模型名（那一列的上限也是 80，超长的模型名在那里会被拒）。
 * 另外 `@` 在字符类里（它是本格式自己的分隔符），所以**模型名里带 `@` 不会被降级** ——
 * 代价是这种串解析时可能有歧义（`a#b@c@d`），排障时以 `model_version` 列为准。
 */
export function providerConfigVersionOf(profile: unknown, model: unknown, endpoint: unknown): string {
  const profilePart = typeof profile === 'string' ? profile.trim() : '';
  const modelPart = typeof model === 'string' ? model.trim() : '';
  const base = modelPart === '' ? profilePart : `${profilePart}#${modelPart}`;
  const host = hostnameOf(endpoint);
  const hostHash = host === null ? null : createHash8(host);
  const candidates = [hostHash === null ? base : `${base}@${hostHash}`, profilePart, CALL_VERSION_UNKNOWN];
  for (const candidate of candidates) {
    if (CALL_VERSION_SHAPE.test(candidate)) return candidate;
  }
  return CALL_VERSION_UNKNOWN;
}

/** 主机名的 8 位十六进制摘要（`sha256`；与小写化后的 hostname 一一对应）。 */
function createHash8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

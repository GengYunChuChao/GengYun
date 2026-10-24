/**
 * 隐私政策读面（契约 `getPrivacyPolicy`：`GET /api/v1/me/privacy-policy`）。
 *
 * ## 契约映射
 *
 * | 契约字段（`#/components/schemas/PrivacyPolicy`） | 来源 |
 * | --- | --- |
 * | `version` | `public.consent_policies.policy_version`（当前生效版本的唯一取值） |
 * | `purposes` | 当前生效政策覆盖的 `purpose`（闭集，顺序同 `CONSENT_PURPOSES`） |
 * | `recipients[]` | `public.recipients` 中 `enabled` 且 `policy_version` = 当前版本的行 |
 * | `training_enabled` | 恒 `false`：本仓不开展用户数据训练（`AGENTS.md`「首版不开启用户训练」），无对应列 |
 *
 * 契约 `PrivacyPolicy` **没有正文（body）字段** ⇒ 本读面不返回政策文本，因此也不需要
 * `content_sha256` / `source_kind` 一类核验列：正文由运维导入的 `consent_policies` 行承载，
 * 界面只消费「版本 + 用途清单 + 接收方清单」，不在这里二次解释政策内容。
 *
 * ## 数据来源与授权（本片零迁移、零 GRANT）
 *
 * - `services/api/db/migrations/0009_consent_policy.sql:4-20` 建 `public.consent_policies`
 *   （`purpose` / `policy_version` / `enabled` / `reviewed_at` / `valid_from` / `valid_until`，
 *   并有 `UNIQUE(purpose,policy_version)` 与部分唯一索引 `consent_policies_enabled_purpose`
 *   ⇒ 同一用途至多一条启用行）；
 *   `services/api/db/migrations/0003_privacy_consent.sql` 建 `public.recipients`，列与契约
 *   `#/components/schemas/Recipient` 一一对应。
 * - `services/api/db/roles/consent_granter.sql:15` 已把这两张表的 `SELECT` 授给
 *   `gengyun_consent_granter`，`deploy/postgres-cvm/sql/20-login-roles.sql` 再
 *   `GRANT gengyun_consent_granter TO gengyun_api_runtime` ⇒ 运行时角色**已有**表级 `SELECT`，
 *   本片不新增任何授权，也不新增迁移。
 *
 * ## 空态：诚实的空，不是错误
 *
 * `0009` 头注释原文「GY-I27 operator-reviewed grant authority. No production policy or recipient seeds.」
 * ⇒ 这两张表现在**一行都没有**。契约 `PrivacyPolicy` 的四个字段全部 `required`、`version` 还有
 * `minLength: 1`，所以「没有政策」既不能写成 `version: null`，也不许编造一段内置政策文本。合法表达是：
 *
 * ```json
 * { "version": "unpublished", "purposes": [], "recipients": [], "training_enabled": false }
 * ```
 *
 * 配 200 —— 没有政策不等于读面故障，不能报 4xx/5xx。`UNPUBLISHED_POLICY_VERSION` 是**保留哨兵值**，
 * 语义是「尚无已发布政策」而不是版本号；它不可能等于任何真实 `policy_version`——库列没有 CHECK
 * 约束，这条由 `readVersion` 用代码强制（真写进库里即 fail-closed，不冒充空态），
 * 它也不会被回灌成授权记录：
 * `privacy/grant-pg.ts:52` 找不到生效政策行时直接抛 `CONSENT_REQUIRED`，
 * `privacy/grant-pg.ts:54` 再用 `policy.policy_version !== input.policy_version` 逐字比对。
 * 没有当前生效政策时 `recipients` 也返回空数组：接收方清单挂在 `recipients.policy_version` 上
 * （见契约 `Recipient.policy_version`），没有版本就没有可披露的清单 —— 不拿上一版凑数。
 *
 * ## 披露面比授权面宽 —— 刻意的，不是漏洞
 *
 * 本读面的 `recipients[]` = 当前版本上 `enabled` 的**全部**接收方；授权面（`privacy/grant-pg.ts`
 * 与 `recipient_bindings`）还要额外满足 `no_training_verified AND deletion_verified`，并与该用户
 * 已绑定的接收方求交。两边**故意不等**：授权面回答「此刻能不能把这位用户的数据交给它」，
 * 披露面回答「这份政策允许哪些第三方处理数据」。少披露 = 用户看不到实际可能接触数据的一方
 * （隐私缺陷）；多披露 = 用户看到尚未对他启用的一方（无害，且更保守）。因此取宽的一侧，
 * **不**拿授权面的严格条件反向收窄披露。`no_training_verified` / `deletion_verified` 仍逐行
 * 原样返回，由界面标注核验状态，读面不改写也不据此过滤。
 *
 * ## 错误分级（口径同 `errors.ts` 的 `ApiError` 注释）
 *
 * - 没有连接池（`real` 模式未配 `DATABASE_URL`）⇒ `PROVIDER_UNAVAILABLE`（503）：fail-closed，
 *   **不返回空政策冒充「确定没有政策」**（「连不上」与「确认没有」是两件事）；
 * - 库里的行不符契约形状（用途越界、版本长度越界、保留期越过 7/30 天上限、接收方超过 30 条、
 *   启用中的政策行出现多个 `policy_version`）⇒ 同样 `PROVIDER_UNAVAILABLE`，且消息只报类别、
 *   不带行内容（同 `privacy/consent-pg.ts` 的 `dto`：不回显库里的原始值）。
 *
 * 多版本为何判错而不是「挑一个」：契约 `PrivacyPolicy` 只有一个 `version`，各用途各自升版时
 * 唯一诚实的表达是把 `purposes` 挂在同一个版本下；混着返回等于告诉用户「这一份政策覆盖了 A、B」，
 * 而实际 A 在 v1、B 在 v2 —— 那是编造。要支持多版本并存必须改契约（`version` 下移成 purpose 级），
 * 超出本片范围，留给契约片/种子片裁定。
 */
import type { PgPool } from '../db/pool.ts';
import { ApiError } from '../errors.ts';
import { CONSENT_PURPOSES } from './consent-pg.ts';

/** 空态哨兵版本号：语义「尚无已发布政策」，不是真实版本（理由见文件头「空态」）。 */
export const UNPUBLISHED_POLICY_VERSION = 'unpublished';

/** 接收方能力闭集（契约 `#/components/schemas/Recipient.capability.enum`，逐字一致）。 */
export const RECIPIENT_CAPABILITIES = ['weed', 'ocr', 'asr', 'tts', 'llm', 'moderation'] as const;

/** 契约上限：`Recipient.retention_online_days <= 7`、`retention_backup_days <= 30`、`recipients.maxItems = 30`。 */
const RETENTION_ONLINE_MAX = 7;
const RETENTION_BACKUP_MAX = 30;
const RECIPIENTS_MAX = 30;

type Row = Record<string, unknown>;
type ConsentPurpose = typeof CONSENT_PURPOSES[number];

/** 当前生效政策：条件与 `privacy/grant-pg.ts:46-48` 同口径，读面与授权面看到的是同一批行。 */
const CURRENT_POLICY_SQL = `SELECT purpose,policy_version FROM public.consent_policies
  WHERE enabled AND reviewed_at<=clock_timestamp() AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp()
  ORDER BY purpose`;

/** 接收方清单：只取挂在当前政策版本上的启用行（`Recipient` 八个字段逐个显式取列，不用 `*`）。 */
const ENABLED_RECIPIENTS_SQL = `SELECT id,display_name,capability,policy_version,
  retention_online_days,retention_backup_days,no_training_verified,deletion_verified
  FROM public.recipients WHERE enabled AND policy_version=$1 ORDER BY display_name,id`;

export interface RecipientView {
  id: string;
  display_name: string;
  capability: string;
  policy_version: string;
  retention_online_days: number;
  retention_backup_days: number;
  no_training_verified: boolean;
  deletion_verified: boolean;
}

export interface PrivacyPolicyView {
  version: string;
  purposes: string[];
  recipients: RecipientView[];
  training_enabled: false;
}

export interface PrivacyPolicyReader {
  read(): Promise<PrivacyPolicyView>;
}

/** 只依赖「一次查询」，故连接池实现与内存桩共用同一接口（单测不需要 `pg`）。 */
export interface PrivacyPolicySql {
  (text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

/** `retryable` 取缺省 `false`：同一条请求重试不会改变结局（需运维改配置或修数据）。 */
const unavailable = (message: string) => new ApiError('PROVIDER_UNAVAILABLE', message);

const purposeRank = (purpose: string): number => (CONSENT_PURPOSES as readonly string[]).indexOf(purpose);
const byPurposeOrder = (purposes: string[]): string[] => [...purposes].sort((left, right) => purposeRank(left) - purposeRank(right));

/**
 * 版本串约束同契约 `minLength: 1` / `maxLength: 80`；越界即数据不可信。
 *
 * 同时把 `UNPUBLISHED_POLICY_VERSION` 当**保留值**守住：`consent_policies.policy_version` /
 * `recipients.policy_version` 两列都没有 CHECK 约束，运维若真往库里写 `'unpublished'`，空态哨兵
 * 就会被真实数据冒充 —— 用户看到「尚无已发布政策」，而库里其实有一行生效政策。库里没做的约束
 * 在这里补上：撞车即 fail-closed（不静默当成空态，也不原样回显那个值）。
 */
function readVersion(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80) throw unavailable('用途政策不可用');
  // 哨兵是读面自己的保留值，不是合法 policy_version：库里出现它只能是数据/导入出错。
  if (value === UNPUBLISHED_POLICY_VERSION) throw unavailable('库里的 policy_version 与空态哨兵 "unpublished" 撞车');
  return value;
}

/** 用途必须是闭集成员：超出闭集的 `purpose` 会让响应的 `ConsentPurpose` 枚举失效。 */
function readPurpose(value: unknown): string {
  if (typeof value !== 'string' || purposeRank(value) === -1) throw unavailable('用途政策不可用');
  return value;
}

function readDays(value: unknown, max: number): number {
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 0 || days > max) throw unavailable('接收方清单不可用');
  return days;
}

function readText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw unavailable('接收方清单不可用');
  return value;
}

function readFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw unavailable('接收方清单不可用');
  return value;
}

/** 行 ⇒ 契约 `Recipient`：任一列不符形状都 fail-closed，不「尽力而为」地编出默认值。 */
function recipientDto(row: Row): RecipientView {
  const capability = String(row['capability']);
  if (!(RECIPIENT_CAPABILITIES as readonly string[]).includes(capability)) throw unavailable('接收方清单不可用');
  return {
    id: readText(row['id'], 80),
    display_name: readText(row['display_name'], 200),
    capability,
    policy_version: readVersion(row['policy_version']),
    retention_online_days: readDays(row['retention_online_days'], RETENTION_ONLINE_MAX),
    retention_backup_days: readDays(row['retention_backup_days'], RETENTION_BACKUP_MAX),
    no_training_verified: readFlag(row['no_training_verified']),
    deletion_verified: readFlag(row['deletion_verified']),
  };
}

/**
 * PostgreSQL 读面。两次 `SELECT` 都是单语句快照，不需要事务：
 * 若版本在两次查询之间翻页，第二次查询按**旧**版本过滤，返回的仍是那一版的真实清单（不是混合结果）。
 */
export function createPostgresPrivacyPolicyReader(input: { query: PrivacyPolicySql }): PrivacyPolicyReader {
  return {
    async read(): Promise<PrivacyPolicyView> {
      const { rows } = await input.query(CURRENT_POLICY_SQL);
      const versions = new Set<string>();
      const purposes: string[] = [];
      for (const row of rows) {
        purposes.push(readPurpose(row['purpose']));
        versions.add(readVersion(row['policy_version']));
      }
      if (versions.size > 1) throw unavailable('启用中的用途政策版本不唯一');
      const [onlyVersion] = [...versions];
      const version = onlyVersion ?? UNPUBLISHED_POLICY_VERSION;
      const recipients = onlyVersion === undefined
        ? []
        : (await input.query(ENABLED_RECIPIENTS_SQL, [onlyVersion])).rows.map(recipientDto);
      if (recipients.length > RECIPIENTS_MAX) throw unavailable('接收方清单不可用');
      return {
        version,
        purposes: byPurposeOrder([...new Set(purposes)]),
        recipients,
        training_enabled: false,
      };
    },
  };
}

/**
 * 未接线实现：没有连接池时**不假装有政策**，直接 `PROVIDER_UNAVAILABLE`（503）。
 * 与 `routes/consents.ts` 的 `requireService()` 同一口径（「授权数据库未配置」），
 * 也与 `routes/community.ts` 的 `ready()` 一致：未接线绝不返回空页/假成功。
 */
export function createUnwiredPrivacyPolicyReader(message: string): PrivacyPolicyReader {
  return {
    read: async (): Promise<PrivacyPolicyView> => {
      throw unavailable(message);
    },
  };
}

/** 装配入口：`pool === null` ⇒ 未接线实现（fail-closed）；否则走 PostgreSQL 读面。 */
export function createPrivacyPolicyReaderForPool(pool: PgPool | null): PrivacyPolicyReader {
  if (pool === null) return createUnwiredPrivacyPolicyReader('隐私政策数据库未配置');
  // 收窄成局部常量：闭包捕获 `const` 才保有 `PgPool` 类型（捕获可变的参数会让收窄失效）。
  const db = pool;
  return createPostgresPrivacyPolicyReader({ query: (text, values) => db.query(text, values) });
}

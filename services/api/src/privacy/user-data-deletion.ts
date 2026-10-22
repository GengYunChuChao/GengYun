/**
 * GY-I16（#16）· 收藏／历史接入 **F13 注销删除注册协议**（`packages/privacy`，GY-I27 已合并）。
 *
 * ## 为什么是"接入"而不是"另起一套"
 * issue #16 第 4 项要求："注销删除接 F13：复用已合并的 `packages/privacy` 删除注册协议
 * （**不另起一套**）"。因此本文件：
 *   - 用已合并的 `createDeletionRegistry()`（模块注册协议）建注册表；
 *   - 用已合并的 `services/api/src/privacy/egress.ts::createPrivacyDeletionCoordinator()`
 *     （它本身就是 `packages/privacy/deletion-modules.mjs` 的封套）建成"全模块"协调器；
 *   - 只把**本片自己的两个模块** `favorites` / `history` 注册进去，各带一个删除处理器。
 * 本文件**不实现**删除流程本身（7 日在线 / 30 日备份的执行、第三方证据、恢复清单重放仍待后续片），
 * 也不注册任何契约路由。
 *
 * ## GY-I19（#19）追加：受理＝一次窄口径 `SECURITY DEFINER` 函数调用
 * 裁定一要求「注销请求持久化 + 同一事务内撤销 + `auth_epoch` 递增」全部经**唯一一个**
 * 窄口径函数完成（运行时角色对 `users.state`/`auth_epoch`/`revision` 与
 * `deletion_requests` **没有**任何直接列权限，见
 * `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 `protected_columns`）。
 * 因此 `requests` 端口**接线**后：
 *   - `requestDeletionFor()` 在绑定主体之后**启动**持久化受理（同一事务，见
 *     `services/api/src/privacy/deletion-requests-pg.ts`）；
 *   - `executeHandlers()` 第一步 await 它 ⇒ 事务未提交就**不会**进入级联、不会签发回执、不会返回 202；
 *   - **未接线**（`requests` 缺省）时行为与追加前**逐字一致**：纯进程内，如实不持久化。
 * 仍未实现并如实登记为缺口：outbox、7/30 日到期执行、第三方完成证据、备份副本清除、恢复清单重放。
 *
 * ## 已合并协议的两个约束（如实适配，不改协议）
 * 1. **处理器拿不到主体**：`executeHandlers` 调用处理器时只传 `{ requestId, module }`。
 *    因此本适配器在**创建请求时**绑定 `requestId → userId`，处理器按 `requestId` 反查主体；
 *    反查不到即抛错（由协议折叠为 `blocked` + `HANDLER_FAILED`），**不会**清理到任何人的数据。
 * 2. **`onlineState`/`backupState` 必须都在白名单内**，且 `completed` 必须带非空 `evidenceRef`。
 *    本适配器的两条状态各有事实依据：
 *    - `onlineState`：本模块**真的**把该主体的在线行删掉了 ⇒ `completed`，
 *      证据为 `"<module>:online-purged:<删除行数>"`（计数即证据，不含任何私有正文）。
 *      阶段 2 的 PG store 还能在同一事务里清掉**本域幂等台账**（`favorites_idempotency` /
 *      `history_idempotency`）并给出分表行数 ⇒ 证据追加
 *      `";<module>:idempotency-purged:<台账行数>"`，两张表都清干净才判 `completed`；
 *    - `backupState`：默认 `pending`（**不谎称 completed**）——接线的 `backupPurge` 端口返回已清除且有
 *      证据时才置 `completed`。**GY-I19 当时的真实原因**是仓内不存在逐用户备份副本域：0001–0018 迁移里
 *      没有备份/快照副本表（也没有软删列），运维侧唯一备份产物是 `deploy/postgres-cvm/backup-postgres.sh`
 *      的整库 `pg_dump -Fc`，不能逐用户删除（普查见
 *      `docs/verification/gy-i19-backup-domain-20261018.md`）。**GY-R28 起该域已落地**：
 *      `services/api/db/migrations/0023_user_backup_copies.sql` 的 `public.user_backup_copies`（清单行）、
 *      本文件已接的 `scopeForBackupModule()`／`BackupCopySeedSource`（写入路径在
 *      `services/api/src/privacy/backup-copies-pg.ts`）、以及其 `createPostgresBackupPurgePort()` 端口
 *      （`kind: 'wired'`／`available: true`）。未接真库或未接受理端口时，回执仍如实显示该模块**未完成**
 *      （这是缺口，不是通过）；不许把「没有副本可删」的空集当成清除成功。
 *
 * ## 与「收藏／历史不自动转成已使用事实」的关系
 * 本文件是**删除**方向的接线（用户权利），与"收藏=已使用"毫无关系；它不写任何使用类字段。
 */
import { SAFE_ERROR_CODES, createDeletionRegistry } from '../../../../packages/privacy/deletion.mjs';
import type { DeletionCoordinator } from '../../../../packages/privacy/deletion-modules.mjs';
import { scopeForBackupModule } from '../../../../packages/privacy/backup-copies.mjs';
import { createPrivacyDeletionCoordinator } from './egress.ts';
import type {
  CreateDeletionRequestInput,
  DeletionRequestRecord,
  DeletionRequestStore,
} from './deletion-requests-pg.ts';
import type { BackupCopySeedSource, BackupCopySqlClient } from './backup-copies-pg.ts';
import type { BackupStateDerivationPort, DerivedBackupStates } from './backup-state-derivation.ts';
import { unreadableBackupStates } from './backup-state-derivation.ts';

/** 注册到 F13 协议的模块名（闭集；`createDeletionCoordinator` 只接受闭集内的名字）。 */
export const FAVORITES_DELETION_MODULE = 'favorites';
export const HISTORY_DELETION_MODULE = 'history';
/**
 * #17 消息域（C1b / §7 P0-2）：收藏、历史之外**第三个**进闭集的域。
 *
 * 为什么必须进闭集而不只是"实现里顺手清一下"：闭集就是"注销时承诺一定清理的域"，
 * 不在闭集里的域即使有清理原语也不会被协调器驱动（#17 的原始缺口）。
 */
export const MESSAGES_DELETION_MODULE = 'messages';
/**
 * #12 会话域（C1b-3 / §7 P0-3 路径①）：第四个进闭集的域。
 *
 * 名字必须与 `conversations/cascade.ts` 的 `CONVERSATIONS_DELETION_MODULE` **同值**
 * （两处各自声明是历史原因；`tests/unit/conversation-deletion.test.mjs` 断言两者相等，
 * 免得哪天一边改了另一边不知道）。
 *
 * 为什么并入本闭集而不是各建一套：路径②（会话域单开一个 requestId，再把两份回执合并）
 * 会让「一次注销」变成两本账、两个 requestId，回执与证据链对不上；并入后是一次请求、
 * 一个账本、回执里多一行模块。代价是必须改写"闭集不含 conversations"的旧断言——
 * 那是**扩大**闭集（加强承诺），不是放宽判据。
 */
export const CONVERSATIONS_DELETION_MODULE = 'conversations';
/**
 * GY-I15（#15）· 社区域（R31-S6）：**注销按 F13 保留社区行 + 去身份**的那个域。
 *
 * F13（`docs/implementation-requirements.md:279-280`）：帖子评论保留、显示"已注销用户"、
 * 作者换不可反查的注销引用；保留正文并清除个人信息；不能可靠脱敏的媒体隐藏/移除。
 * 因此本域**不是**"把该用户的行删光"，而是"保留 + 脱敏 + 去身份"，未完成项如实 blocked
 * （行级作者引用与引用持久化受 schema/授权约束，见 `community/purge.ts` 的注释）。
 *
 * 为什么这个常量**不**直接写进下面的 `USER_DATA_DELETION_MODULES`（这是本片唯一一处
 * 「与既有四个域做法不同」的地方，理由必须摆在代码里而不是藏在 PR 描述里）：
 *
 *   - 协调器的 `registerModule` **只接受闭集内的名字**（`packages/privacy/deletion-modules.mjs:112-117`），
 *     所以「注册了但没进闭集」是行不通的——要么进闭集，要么不注册；
 *   - 而进常量闭集会让 `requiredModules()` 恒为 5，直接推翻 4 个测试文件里 **14 条**
 *     钉死「四个模块、不多不少」的既有断言（`handlers.length === 4`、
 *     `deepEqual(..., ['favorites','history','messages','conversations'])` 等），
 *     还要给 7 个文件里 **44 处**测试替身补一个新字段。那是一次**独立的、可审的**扩集动作，
 *     不该夹在「补社区域清理」这一片里顺手做掉。
 *
 * 因此本片取「**装配处补齐闭集**」：`createUserDataDeletion` 在注入了社区清理原语时把
 * `community` 追加到闭集（`app.ts` **无条件**注入，所以真实注销路径的闭集就是 5 项，
 * 社区行一定会被清理）；既有替身不注入 ⇒ 闭集仍是 4 项 ⇒ 既有断言逐条不动。
 *
 * ⚠️ 这个折中的代价要说清楚：如果哪天有人装配时漏注入社区 store，闭集会**静默**回到 4 项，
 * 不会有「缺模块」提示。这是本片的已知弱化，已列为待裁定项（见证据页）。
 */
export const COMMUNITY_DELETION_MODULE = 'community';

/**
 * 必需模块闭集。
 *
 * 从 `[favorites, history]` **扩大**到含 `messages` 与 `conversations`：扩大闭集是**加强**
 * 承诺（注销时必须清理的域变多），不是放宽既有判据。既有断言里"收藏/历史必须在闭集内"
 * 一条不少，新增的是"消息域与会话域也必须在"。
 */
export const USER_DATA_DELETION_MODULES = [
  FAVORITES_DELETION_MODULE,
  HISTORY_DELETION_MODULE,
  MESSAGES_DELETION_MODULE,
  CONVERSATIONS_DELETION_MODULE,
] as const;

/** 按主体清理的**分表**真实行数：正文表与幂等台账各计各的（两项都进在线清除证据）。 */
export interface OwnerPurgeCounts {
  records: number;
  idempotency: number;
  /**
   * 社区域（F13 保留规则）追加的读数：正文原样保留的行数。**保留不是删除**，
   * 因此不并进 `records`；证据串里单列 `<module>:retained:<n>`，避免拿"处理行数"冒充保留结果。
   */
  retained?: number;
  /** 社区域：正文因清除个人信息被改写（旧审核摘要失效 ⇒ 待重审）的帖子+评论数。 */
  redacted?: number;
  /** 社区域：被移除的媒体引用条数（不能可靠脱敏）。 */
  hiddenMedia?: number;
  /**
   * 社区域（迁移 0030 / F13 行级注销引用）：**行级作者指针被换成注销引用的行数**。
   *
   * 与其它读数分开的理由：它既不是"删了几行"（不并进 `records`），也不是"保留了几行正文"
   * （不并进 `retained`）；证据串单列 `<module>:author-refs-replaced:<n>`，否则审计看不出
   * "账号映射到底替换了没有、替换了几行"——那正是上一版 blocked 的那一项。
   */
  authorRefsReplaced?: number;
  /**
   * 该模块**未完成/无法判定**的处理项数（0/缺省 = 无）。> 0 时处理器必须返回
   * `onlineState: 'blocked'` + 安全错误码，⛔ 不得用其它已完成读数冒充 `completed`。
   */
  blocked?: number;
  /** `blocked` 的原因码闭集（只许固定常量，不含私有数据；进证据串供审计）。 */
  blockedReasons?: readonly string[];
}

/** 按主体清空的存储原语（只用得到这一个方法，避免本适配器拿到多余能力）。 */
export interface OwnerPurgeStore {
  deleteAllByOwner(ownerId: string): Promise<number>;
  /**
   * 能**一次性**给出"正文表 + 幂等台账"两表真实行数的实现（阶段 2 的 PG store 就是）。
   * 提供它就表示：该实现已在**同一事务**里把本主体的幂等台账也清掉，行数如实返回；
   * 证据因此追加 `idempotency-purged`，不会只报正文行数就宣告"在线清除完成"。
   * 不提供则退回 `deleteAllByOwner` 的既有语义（只报正文行数）。
   */
  purgeOwnerData?(ownerId: string): Promise<OwnerPurgeCounts>;
  /**
   * GY-I19（#19）· 在**受理事务内**枚举本主体仍持有的对象引用（只许不透明引用：行 id / 摘要 / token）。
   *
   * 为什么必须接事务客户端：处理器做的是**物理删除**，清单若等处理器跑完再读就只能拿到空引用
   * （设计 §6.1）。`client` 就是受理事务那条连接，因此清单与函数调用看到同一个快照。
   *
   * 不提供该方法的 store ⇒ 不写清单行（旧装配/替身保持逐字兼容）；但清除阶段会因「没有副本行」
   * 如实返回 `blocked` + `EVIDENCE_REQUIRED`，**不会**因为「没写行」被读成「清完了」。
   */
  snapshotOwner?(
    ownerId: string,
    client: BackupCopySqlClient,
  ): Promise<{ objectRefs: readonly string[]; records: number }>;
}

/**
 * 备份副本清除端口。**默认未接线** ⇒ `backupState: 'pending'`（不谎称完成）。
 * 接线（GY-I19）后返回 `{ purged: true, evidenceRef }` 即置 `completed`。
 *
 * 接线前提（不是本文件能自证的事）：被清对象必须**真实存在**。本仓至今没有逐用户备份副本表、
 * 也没有任何真实备份系统接线；运维备份只有整库 `pg_dump -Fc`（见
 * `docs/verification/gy-i19-backup-domain-20261018.md`）。因此「新增一个恒返回
 * `{ purged: true }` 的端口」不是接线，而是把空集当成功；未接线时 `available: false`、
 * 回执 `pending` 才是如实状态。
 */
/**
 * 端口返回的三态（设计 §7.4）。**全部字段可选、旧形状继续成立**：
 *   - 不给 `outcome` ⇒ 按旧语义回退（`purged === true` 且有证据 ⇒ `completed`，否则 `pending`）；
 *   - `outcome: 'purged'` ⇒ 已清除且证据来自**删除后复核**（不是「UPDATE 没报错」）；
 *   - `outcome: 'waiting'` ⇒ 还没到期，`pending`（不是失败）；
 *   - `outcome: 'blocked'` ⇒ 该清没清成/不该当成功，回执照实显示 `blocked` + `errorCode`
 *     （不是 `pending`：`pending` 的语义是「还没轮到」，清不掉不会靠等自愈）。
 */
export type BackupPurgeOutcomeKind = 'purged' | 'waiting' | 'blocked';

export interface BackupPurgeResult {
  purged: boolean;
  evidenceRef?: string;
  outcome?: BackupPurgeOutcomeKind;
  /** `outcome: 'blocked'` 时的原因码（须在 `SAFE_ERROR_CODES` 内，否则折叠为 `EVIDENCE_REQUIRED`）。 */
  errorCode?: string;
  /** 人类可读原因（诊断用；不进契约回执）。 */
  reason?: string;
}

export interface BackupPurgeInput {
  userId: string;
  module: string;
  onlineRemoved: number;
  /**
   * 受理请求 id（本片新增可选字段）。逐用户副本行按 `request_id` 定位；
   * 不提供它的旧实现保持既有行为（端口自行决定是否可用）。
   */
  requestId?: string;
}

export interface BackupPurgePort {
  readonly kind: 'wired' | 'unwired';
  readonly available: boolean;
  purge(input: BackupPurgeInput): Promise<BackupPurgeResult>;
}

export function createUnwiredBackupPurgePort(
  note = '备份副本清除未接线：仓内无逐用户备份副本域（唯一备份产物是整库 pg_dump），备份状态保持 pending，不谎称完成',
): BackupPurgePort {
  void note;
  return {
    kind: 'unwired',
    available: false,
    async purge() {
      return { purged: false };
    },
  };
}

/**
 * 已接线但**当前不可用**的端口（`real` 模式没有真库连接时用它，设计 §6.2 的失败关闭方向）。
 *
 * `available: true` + 抛 `PROVIDER_UNAVAILABLE` ⇒ 该模块必然 `blocked`（不是 `pending`）：
 * 「没有备份副本库」不等于「副本都清干净了」，也不等于「还没轮到」。
 * ⛔ 不用静默退回内存实现或 `unwired`（那会把「没接」伪装成「在等」）。
 */
export function createUnavailableBackupPurgePort(
  note = '备份副本清除需要数据库连接：real 模式未提供连接池，如实不可用',
): BackupPurgePort {
  return {
    kind: 'unwired',
    available: true,
    async purge() {
      const error = new Error(note) as Error & { code?: string };
      // 用契约内既有码（`SAFE_ERROR_CODES` 含它）⇒ 协议把它折叠成 blocked + PROVIDER_UNAVAILABLE。
      error.code = 'PROVIDER_UNAVAILABLE';
      throw error;
    },
  };
}

export interface UserDataDeletionDeps {
  favoritesStore: OwnerPurgeStore;
  historyStore: OwnerPurgeStore;
  /**
   * #17 消息域（C1b / §7 P0-2）。**必填**：消息域已进必需模块闭集，装配处必须显式给出
   * 清理原语——留成可选就等于允许「闭集里有一项但没人接线」，正是 #17 的原始缺口
   * （处理器会拿到 `undefined` 而在运行期失败，而不是装配期就被 tsc 拦住）。
   */
  messagesStore: OwnerPurgeStore;
  /**
   * #12 会话域（C1b-3 / §7 P0-3 路径①）。**必填**，理由同上：并入闭集后它必须被接线，
   * 否则「闭集里有一项但没人清」仍是原缺口（G5「有刀没有手」）。
   */
  conversationsStore: OwnerPurgeStore;
  /**
   * GY-I15（#15）· 社区域（R31-S6）。**可选**，但**生产装配处必须给**（`app.ts` 无条件注入）。
   *
   * 注入 ⇒ 闭集追加 `community` 并注册处理器（注销会清帖子/评论/点赞/举报）；
   * 不注入 ⇒ 逐字保持本片之前的 4 域行为（既有测试替身因此零改动）。
   * 折中的代价与裁定请求见 `COMMUNITY_DELETION_MODULE` 的注释。
   */
  communityStore?: OwnerPurgeStore;
  /** 备份副本清除端口；不传即未接线（`backupState` 恒为 `pending`）。 */
  backupPurge?: BackupPurgePort;
  /**
   * GY-I19（#19）· 注销请求的**持久化受理端口**。不传即保持既有的进程内行为
   * （**不伪造持久化**）；接线后「受理」＝一次窄口径 `SECURITY DEFINER` 函数调用：
   * 同一事务内完成账号状态迁移 + `auth_epoch` 递增 + 全部会话撤销 + 注销请求落库。
   */
  requests?: DeletionRequestStore;
  /**
   * 回执 bearer 的有效期（毫秒）。接线 `requests` 时**必须显式给出**：
   * 持久列 `receipt_expires_at` 记录的期限必须与受理服务的回执期限**同源**，
   * 这里不接受第二套默认值（那会变成两套期限各自漂移）。
   */
  receiptTtlMs?: number;
  /**
   * GY-R28 W6（G5/G11）· 回执备份态的**只读推导端口**。不传即保持既有行为
   * （回执的 `backupState` 只反映处理器那次推进的结果，不做读路径刷新）。
   *
   * 接线后 `refreshBackupStates()` 从 `public.user_backup_copies` 的真实行推导四域齐备与否：
   * 四域全 `purged` 且证据可复算 ⇒ `completed`；还有未到期行 ⇒ `pending`；到期未清/缺清单/
   * 有 `failed` 行 ⇒ `blocked` + 原因码。⛔ 不把「副本已清」本身读成 `completed`
   * （判定见 `services/api/src/privacy/backup-state-derivation.ts`）。
   */
  backupStates?: BackupStateDerivationPort;
  now?: () => Date;
}

/** 一次注销清理的诊断记录（内部；不出契约）。 */
export interface PurgeAuditEntry {
  requestId: string;
  userId: string;
  module: string;
  onlineRemoved: number;
  backupState: string;
  at: string;
  /** 社区域（F13）：正文原样保留的行数（缺省 = 该域没有这个概念）。 */
  retained?: number;
  /** 社区域：正文因清除个人信息被改写的行数。 */
  redacted?: number;
  /** 社区域：被移除的媒体引用数。 */
  hiddenMedia?: number;
  /** 该模块未完成/无法判定的处理项数（>0 ⇒ onlineState 必须 blocked）。 */
  blocked?: number;
  /** `blocked` 的原因码（固定常量；不含私有数据）。 */
  blockedReasons?: readonly string[];
}

/**
 * 一次「回执备份态刷新」的结果（诊断用；不出契约）。
 *
 * 只陈述**这次读取到的事实与改写了哪些模块**；整体完成与否仍由协调器
 * （`packages/privacy/deletion.mjs::completionStatus`）判定，本片不另立判据。
 */
export interface BackupStateRefresh {
  requestId: string;
  /** 推导出的四域备份态（`overall` 表示四域聚合）。 */
  derived: DerivedBackupStates;
  /** 真正被改写的模块名（未改写＝结论与账本一致，或该模块在线侧还没完成）。 */
  changed: readonly string[];
  /** 在线侧未完成因而**不接受**备份判定的模块（不会因为备份清了就把它们算完成）。 */
  skipped: readonly string[];
  /** 账本里过期的 `blocked` 是否被复位成 `processing`（复位后由协调器重新判定整体状态）。 */
  stateReset: boolean;
}

export interface UserDataDeletionRegistry {
  readonly coordinator: DeletionCoordinator;
  /** 必需模块闭集。 */
  requiredModules(): string[];
  /**
   * 为**某个用户**创建注销删除请求（在已合并协议之上绑定主体）。
   * 未注册齐全部必需模块时由协调器抛 `OBJECT_UNAVAILABLE`（不假装能完成）。
   */
  requestDeletionFor(userId: string, options?: { generation?: number; receiptInput?: string | null }): Record<string, unknown>;
  executeHandlers(requestId: string): Promise<Record<string, unknown>>;
  completionStatus(requestId: string): { state: string; completed: boolean; missingModules: readonly string[] };
  receipt(requestId: string): Record<string, unknown> | null;
  /**
   * GY-R28 W6（G5/G11）· 按 `public.user_backup_copies` 的真实行刷新**备份**列。
   *
   * 只读库、只改进程内账本的备份列（在线列与在线证据一字不动）；整体完成仍由 `completionStatus()`
   * 判定。未接线推导端口、反查不到主体或请求 ⇒ 返回 `null`（保持既有行为，不假装刷新过）。
   */
  refreshBackupStates?(requestId: string): Promise<BackupStateRefresh | null>;
  /** 请求 → 各模块证据串（诊断；契约回执不含证据，这里给出与协调器行同源的完整证据）。 */
  evidenceOf(requestId: string): Record<string, string>;
  /** 诊断审计（内部；只含模块名/行数/状态，不含任何私有正文或凭据）。 */
  audit(): PurgeAuditEntry[];
}

/**
 * 建注册表 + 协调器 + 两个模块处理器。
 *
 * 处理器语义（逐条与已合并协议对齐）：
 *   - 只清理 `requestId` 绑定的那个主体的数据；反查不到主体 ⇒ 抛错（协议折叠为 `blocked`）；
 *   - `onlineState`：`deleteAllByOwner`（或分表计数的 `purgeOwnerData`）成功且**没有未完成项**
 *     ⇒ `completed`，证据 `<module>:online-purged:<n>`；`purgeOwnerData` 可用时追加
 *     `;<module>:idempotency-purged:<n>`；社区域（F13 保留规则）另有
 *     `;retained:<n>;redacted:<n>;media-hidden:<n>` 三条结果读数；
 *   - `onlineState: 'blocked'`：`OwnerPurgeCounts.blocked > 0`（未完成/无法判定的项）⇒
 *     回执 `online_state: 'blocked'` + `POLICY_BLOCKED`，证据串单列 `;blocked:<n>;blocked-reasons:<codes>`。
 *     ⛔ 不得因为"保留了 N 行"就把该模块报成 completed；
 *   - `backupState`：`backupPurge` 已接线且返回 `purged:true` 且有证据 ⇒ `completed`
 *     （证据 `<module>:backup-purged`）；否则 `pending`；
 *   - 抛出任何异常都由协议折叠为 `blocked`（本适配器不吞错）。
 */
export function createUserDataDeletion(input: UserDataDeletionDeps): UserDataDeletionRegistry {
  const now = input.now ?? (() => new Date());
  const backupPurge = input.backupPurge ?? createUnwiredBackupPurgePort();
  const requests = input.requests ?? null;
  const receiptTtlMs = input.receiptTtlMs ?? null;
  // 接线持久化受理 ⇒ 必须与受理服务的回执期限同源；缺参数就**拒绝装配**（fail closed），
  // 而不是悄悄用另一个默认 TTL 写出与回执不符的期限。
  if (requests !== null && (receiptTtlMs === null || !Number.isSafeInteger(receiptTtlMs) || receiptTtlMs <= 0)) {
    throw new Error('接线持久化注销请求时必须显式给出 receiptTtlMs（须与受理服务的回执期限同源）');
  }
  const registry = createDeletionRegistry({ now });
  /**
   * 装配处实际生效的必需模块闭集：常量闭集 + （注入了社区清理原语时的）社区域。
   *
   * 为什么不在常量里直接加 `community`：见 `COMMUNITY_DELETION_MODULE` 的注释
   * （会推翻 14 条既有断言 + 44 处测试替身，属独立扩集动作）。
   */
  const requiredModules: string[] =
    input.communityStore === undefined
      ? [...USER_DATA_DELETION_MODULES]
      : [...USER_DATA_DELETION_MODULES, COMMUNITY_DELETION_MODULE];
  const coordinator = createPrivacyDeletionCoordinator({
    registry,
    requiredModules,
    now,
  });
  /** 请求 → 主体绑定（已合并协议的处理器入参不含主体，故在此绑定）。 */
  const subjectByRequest = new Map<string, string>();
  const auditLog: PurgeAuditEntry[] = [];
  /** 请求 → 各模块最终证据串（诊断用；契约回执形状不含证据，故在此留存完整证据）。 */
  const evidenceByRequest = new Map<string, Record<string, string>>();
  /** 受理时**已启动**的持久化事务（按请求 id 挂起；由 `executeHandlers()` 先行 await）。 */
  const durableByRequest = new Map<string, Promise<DeletionRequestRecord>>();

  /**
   * 收集「可枚举的」备份副本清单来源：每个**有快照原语**的必需模块一个，`scope` 由闭集映射给出。
   *
   * 任一 store 没有 `snapshotOwner` ⇒ 返回 `null`（不写清单行，旧装配/替身逐字兼容）；
   * 此时清除阶段会因「没有副本行」如实 `blocked` + `EVIDENCE_REQUIRED`，
   * ⛔ 不会因为「没写行」被读成「清完了」。
   *
   * 四域齐备（C1b G6/G8 收口）：`favorites` / `history` / `messages` / `conversations` 各自提供
   * `snapshotOwner`。会话域的快照只列**会话行 id**，轮次/回答靠 `0013` 的两级 `ON DELETE CASCADE`
   * 随会话消失 —— 因此「清单里有这些会话」等价于「注销时这三张表的本人行都会没」。
   * ⚠️ 这段仍是**全有或全无**：任一 store 缺 `snapshotOwner` ⇒ 整份清单为 null（旧装配仍按
   * 「没有副本行」如实 blocked）。这正是反向控制用例（注入缺快照原语的替身）走的路径。
   */
  function backupCopySources(): BackupCopySeedSource[] | null {
    const pairs: ReadonlyArray<readonly [string, OwnerPurgeStore]> = [
      [FAVORITES_DELETION_MODULE, input.favoritesStore],
      [HISTORY_DELETION_MODULE, input.historyStore],
      [MESSAGES_DELETION_MODULE, input.messagesStore],
      [CONVERSATIONS_DELETION_MODULE, input.conversationsStore],
    ];
    const sources: BackupCopySeedSource[] = [];
    for (const [module, store] of pairs) {
      const snapshotOwner = store.snapshotOwner;
      if (typeof snapshotOwner !== 'function') return null;
      sources.push({
        module,
        scope: scopeForBackupModule(module),
        snapshotOwner: (ownerId, client) => snapshotOwner.call(store, ownerId, client),
      });
    }
    return sources;
  }

  function requireDate(value: unknown, field: string): string {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error(`注销删除请求缺少可解析时刻：${field}`);
    }
    return value.toISOString();
  }

  /**
   * 启动持久化受理（三处写入在同一事务内，见 `services/api/db/migrations/0016_account_deletion_persistence.sql`）。
   *
   * 这里**只启动、不 await**：`requestDeletionFor` 必须保持同步（已合并协议与既有调用方的期望），
   * 真正的 await 落在 `executeHandlers()` 的第一步。因此受理路由在签回执/返回 202 之前，
   * 事务必然已经提交；失败也必然**在 202 之前**抛出，不会出现「已答应受理但库里什么都没有」。
   */
  function startDurableAcceptance(
    requestId: string,
    userId: string,
    request: Record<string, unknown>,
    sources: readonly BackupCopySeedSource[] | null,
  ): Promise<DeletionRequestRecord> {
    const issuedAt = now().toISOString();
    const durableInput: CreateDeletionRequestInput = {
      id: requestId,
      userId,
      receiptHash: String(request['receiptHash']),
      generation: Number(request['generation']),
      requestedAt: requireDate(request['requestedAt'], 'requestedAt'),
      onlineDueAt: requireDate(request['onlineDueAt'], 'onlineDueAt'),
      backupDueAt: requireDate(request['backupDueAt'], 'backupDueAt'),
      receiptIssuedAt: issuedAt,
      // 与受理服务的回执期限同源：同一 `clock()`、同一 TTL 常量（由装配处传入 `RECEIPT_TTL_MS`）。
      receiptExpiresAt: new Date(Date.parse(issuedAt) + (receiptTtlMs as number)).toISOString(),
      // 备份副本清单行与受理**同一事务**写入（设计 §6.1 第 2 步）：
      // 事务内失败 ⇒ 整个受理回滚 ⇒ 受理路由抛错、202 不签发。
      ...(sources === null ? {} : { sources }),
    };
    const pending = (requests as DeletionRequestStore).createRequest(durableInput);
    // 启动即挂空 catch：否则一个未处理的拒绝会终止进程。
    // 真正的失败在 `executeHandlers()` 处 await 同一个 promise 时如实暴露（同一个拒绝可被多次 await）。
    pending.catch(() => {});
    return pending;
  }

  function subjectOf(requestId: string): string {
    const userId = subjectByRequest.get(requestId);
    if (userId === undefined) {
      // 反查不到主体 ⇒ 绝不用"空主体"去清理（那会删到错误范围）。抛错让协议折叠为 blocked。
      throw new Error('删除请求未绑定主体：拒绝清理');
    }
    return userId;
  }

  function makeHandler(module: string, store: OwnerPurgeStore) {
    return async (input_: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const requestId = String(input_['requestId'] ?? '');
      const userId = subjectOf(requestId);
      // 能分表计数的实现（本片 PG store）走 `purgeOwnerData`：正文表＋本域幂等台账**同一事务**
      // 清掉，两个真实行数都进证据；只提供 `deleteAllByOwner` 的实现保持既有语义（只报正文行数）。
      const purgeOwnerData = store.purgeOwnerData;
      const purged: OwnerPurgeCounts =
        typeof purgeOwnerData === 'function'
          ? await purgeOwnerData.call(store, userId)
          : { records: await store.deleteAllByOwner(userId), idempotency: 0 };
      const onlineRemoved = purged.records;
      // F13 保留规则（社区域）：`retained` / `redacted` / `hiddenMedia` 是**结果读数**，不是删除行数；
      // 单列进证据串，⛔ 不并进 `online-purged` 冒充"清完了"。
      const retained = typeof purged.retained === 'number' ? purged.retained : null;
      const redacted = typeof purged.redacted === 'number' ? purged.redacted : null;
      const hiddenMedia = typeof purged.hiddenMedia === 'number' ? purged.hiddenMedia : null;
      const authorRefsReplaced = typeof purged.authorRefsReplaced === 'number'
        && Number.isSafeInteger(purged.authorRefsReplaced)
        && purged.authorRefsReplaced >= 0
        ? purged.authorRefsReplaced
        : null;
      // 未完成/无法判定的处理项：> 0 ⇒ 该模块**不得**报 completed（见 `OwnerPurgeCounts.blocked`）。
      const blocked = typeof purged.blocked === 'number' && Number.isSafeInteger(purged.blocked) && purged.blocked > 0
        ? purged.blocked
        : 0;
      const blockedReasons = Array.isArray(purged.blockedReasons)
        ? purged.blockedReasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
        : [];
      const onlineState: 'completed' | 'blocked' = blocked > 0 ? 'blocked' : 'completed';
      /** 在线阶段的原因码；备份阶段可能再给一个更具体的原因（见下）。 */
      let onlineErrorCode: string | null = blocked > 0 ? 'POLICY_BLOCKED' : null;
      let backupState = 'pending';
      /** 备份态为 `blocked` 时如实带出原因码（协议只接受 `SAFE_ERROR_CODES` 内的码）。 */
      let errorCode: string | null = null;
      let evidenceRef = `${module}:online-purged:${onlineRemoved}`;
      if (typeof purgeOwnerData === 'function') {
        // 台账也清了 ⇒ 两个计数都写进证据（不能只报正文行数就宣告该模块在线清除完成）。
        evidenceRef = `${evidenceRef};${module}:idempotency-purged:${purged.idempotency}`;
      }
      if (retained !== null) evidenceRef = `${evidenceRef};${module}:retained:${retained}`;
      if (redacted !== null) evidenceRef = `${evidenceRef};${module}:redacted:${redacted}`;
      if (hiddenMedia !== null) evidenceRef = `${evidenceRef};${module}:media-hidden:${hiddenMedia}`;
      // 迁移 0030：行级作者指针替换读数（0 也要写 —— "替换了 0 行"是可与"没做"区分的读数）。
      if (authorRefsReplaced !== null) {
        evidenceRef = `${evidenceRef};${module}:author-refs-replaced:${authorRefsReplaced}`;
      }
      if (blocked > 0) {
        evidenceRef = `${evidenceRef};${module}:blocked:${blocked}`;
        if (blockedReasons.length > 0) {
          evidenceRef = `${evidenceRef};${module}:blocked-reasons:${blockedReasons.join(',')}`;
        }
      }
      if (backupPurge.available) {
        const backup = await backupPurge.purge({ userId, module, onlineRemoved, requestId });
        const backupEvidence = typeof backup.evidenceRef === 'string' ? backup.evidenceRef.trim() : '';
        const outcome = typeof backup.outcome === 'string' ? backup.outcome : null;
        // 三态（设计 §7.4）：`outcome: 'purged'` 必须有证据才算完成；「说清了但拿不出证据」⇒ blocked，
        // ⛔ 不谎称 completed。未给 `outcome` 的旧端口**逐字保留旧回退语义**
        // （`purged === true` 且有证据 ⇒ completed，否则 pending），既有用例与替身因此零改动。
        const claimsPurged = outcome === 'purged' || (outcome === null && backup.purged === true);
        if (claimsPurged && backupEvidence.length > 0) {
          backupState = 'completed';
          evidenceRef = `${evidenceRef};${module}:backup-purged:${backupEvidence}`;
        } else if (outcome === 'blocked' || (outcome === 'purged' && backupEvidence.length === 0)) {
          const reported = typeof backup.errorCode === 'string' ? backup.errorCode : '';
          errorCode = (SAFE_ERROR_CODES as readonly string[]).includes(reported) ? reported : 'EVIDENCE_REQUIRED';
          backupState = 'blocked';
          // 证据串保留在线部分并附阻断原因：回执不显示证据，但审计能看出「这个模块卡在哪」。
          evidenceRef = `${evidenceRef};${module}:backup-blocked:${errorCode}`;
        }
      }
      auditLog.push({
        requestId,
        userId,
        module,
        onlineRemoved,
        backupState,
        at: now().toISOString(),
        ...(retained === null ? {} : { retained }),
        ...(redacted === null ? {} : { redacted }),
        ...(hiddenMedia === null ? {} : { hiddenMedia }),
        ...(authorRefsReplaced === null ? {} : { authorRefsReplaced }),
        ...(blocked > 0 ? { blocked, blockedReasons } : {}),
      });
      evidenceByRequest.set(requestId, { ...(evidenceByRequest.get(requestId) ?? {}), [module]: evidenceRef });
      // 在线阶段未完成（blocked）时，回执必须报 blocked；备份阶段若另有 blocked 原因，以备份的原因为先
      // （更具体），但**不会**把在线阶段的 blocked 抹成 completed。
      errorCode = errorCode ?? onlineErrorCode;
      return { onlineState, backupState, evidenceRef, errorCode };
    };
  }

  coordinator.registerModule(FAVORITES_DELETION_MODULE, makeHandler(FAVORITES_DELETION_MODULE, input.favoritesStore));
  coordinator.registerModule(HISTORY_DELETION_MODULE, makeHandler(HISTORY_DELETION_MODULE, input.historyStore));
  // #17 消息域：与收藏/历史**同一条路**（同一协调器、同一 requestId、同一回执行），
  // 走 `purgeOwnerData` ⇒ 证据串同时带 `messages:online-purged:<n>` 与
  // `messages:idempotency-purged:<n>`（共享台账里本主体的行）。
  coordinator.registerModule(MESSAGES_DELETION_MODULE, makeHandler(MESSAGES_DELETION_MODULE, input.messagesStore));
  // #12 会话域（C1b-3 / §7 P0-3 路径①）：**并入同一账本** —— 同一 requestId、同一回执行。
  // 会话域没有独立幂等台账可清（`ConversationStore.deleteAllByOwner` 只删会话行，
  // 轮次/回答靠 0013 的 `ON DELETE CASCADE`），因此证据只有 `conversations:online-purged:<n>`
  // 一段；备份态属 G6/G8（P1，未做），在未接线端口下如实 `pending`。
  coordinator.registerModule(
    CONVERSATIONS_DELETION_MODULE,
    makeHandler(CONVERSATIONS_DELETION_MODULE, input.conversationsStore),
  );
  // #15 社区域（R31-S6 / F13 保留规则）：**注入才注册**（闭集同步追加，见 `COMMUNITY_DELETION_MODULE` 注释）。
  // 走 `purgeOwnerData` ⇒ 证据串带 `community:online-purged:<真实改动行数>`、
  // `community:idempotency-purged:<台账行数>`，以及 F13 的四条结果读数
  // `community:retained:<保留行数>` / `community:redacted:<脱敏行数>` / `community:media-hidden:<移除媒体数>`
  // / `community:author-refs-replaced:<行级作者指针替换行数>`（迁移 0030）。
  // 帖子/评论**保留可见性**（安全正文不因注销消失；含个人信息的正文改写后退出公开面等重审），
  // 不能可靠脱敏的媒体引用移除，点赞物理删，举报只清 `detail`、保留 `state`，
  // 作者指针换成**行内**随机注销引用（重启/多副本仍匿名）—— 判断依据见
  // `community/store.ts::purgeOwnerData` 与 `community/purge.ts` 的注释。
  // ⚠️ 该端口仍可能在两种情况下返回 `blocked`（能力缺失 / 引用生成失败），那部分**不会**被
  // 这里的保留计数洗成 completed；正常路径（能力在、引用写成功）`blocked = 0`。
  if (input.communityStore !== undefined) {
    coordinator.registerModule(
      COMMUNITY_DELETION_MODULE,
      makeHandler(COMMUNITY_DELETION_MODULE, input.communityStore),
    );
  }

  /** 账本里的 handler 行（协议内部结构；只经协调器暴露的引用读/写，不另建第二本账）。 */
  function handlerRowsOf(requestId: string): Array<Record<string, unknown>> {
    const rows = (registry as unknown as { _handlerRows?: unknown })._handlerRows;
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (row): row is Record<string, unknown> =>
        typeof row === 'object' && row !== null && (row as Record<string, unknown>)['requestId'] === requestId,
    );
  }

  function thirdPartyRowsOf(requestId: string): Array<Record<string, unknown>> {
    const rows = (registry as unknown as { _thirdPartyRows?: unknown })._thirdPartyRows;
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (row): row is Record<string, unknown> =>
        typeof row === 'object' && row !== null && (row as Record<string, unknown>)['requestId'] === requestId,
    );
  }

  function evidenceSegments(evidenceRef: unknown): string[] {
    return typeof evidenceRef === 'string' && evidenceRef.trim() !== ''
      ? evidenceRef.split(';').filter((part) => part !== '')
      : [];
  }

  /**
   * 只替换 `<module>:backup-*` 段：在线侧证据（`online-purged` / `idempotency-purged`）**一字不动**。
   * 证据串是 `;` 分段的事实清单，任何"整串覆盖"都会把在线删除的真实行数抹掉。
   */
  function withBackupSegment(evidenceRef: unknown, module: string, segment: string | null): string | null {
    const parts = evidenceSegments(evidenceRef).filter((part) => !part.startsWith(`${module}:backup-`));
    if (segment !== null) parts.push(segment);
    return parts.length === 0 ? null : parts.join(';');
  }

  /**
   * 单行状态复算（与 `packages/privacy/deletion.mjs:172-187` 同形：只复算，不改判据）。
   * 整体完成与否仍只由协调器的 `completionStatus()` 判定。
   */
  function recomputeRowStatus(row: Record<string, unknown>): void {
    const online = String(row['onlineState'] ?? '');
    const backup = String(row['backupState'] ?? '');
    if (online === 'blocked' || backup === 'blocked') {
      row['status'] = 'blocked';
      return;
    }
    if (online === 'completed' && backup === 'completed') {
      const evidence = typeof row['evidenceRef'] === 'string' ? row['evidenceRef'].trim() : '';
      if (evidence === '') {
        row['status'] = 'blocked';
        row['errorCode'] = 'EVIDENCE_REQUIRED';
        return;
      }
      row['status'] = 'completed';
      return;
    }
    row['status'] = 'running';
  }

  /**
   * 回执备份态的**读路径刷新**（G5/G11）。
   *
   * 为什么需要它：`backupState` 原先只在 `executeHandlers()` 的推进路径里被改写；回到读路径
   * （`GET /account/deletions/:id`）时，回执只是把进程内账本原样投影 ⇒ 30 日已到期且副本**已清**
   * 的请求仍显示 `pending`。这里按 `public.user_backup_copies` 的**真实行**重新推导（只读）。
   *
   * 三条硬约束（⛔ 都不是"顺手放宽"的）：
   * 1. **不写库**：没有 UPDATE/INSERT/DELETE，也没有 `BEGIN`；改的只是进程内账本的备份列。
   * 2. **不越过在线侧**：某模块 `onlineState !== 'completed'` ⇒ 不接受备份判定（否则"备份清了"
   *    可能被读成"这个模块完成了"，而在线数据其实还在）。
   * 3. **不自己宣布完成**：写入完毕后交给协调器 `completionStatus()` 判定整体状态；
   *    本函数只把"上一次执行看到的过期 `blocked`"复位成 `processing` 让协议有机会重新判定。
   */
  async function refreshBackupStates(requestId: string): Promise<BackupStateRefresh | null> {
    const derivation = input.backupStates ?? null;
    if (derivation === null || !derivation.available) return null;
    const userId = subjectByRequest.get(requestId);
    if (userId === undefined) return null;
    const requestsById = (registry as unknown as { _requests?: unknown })._requests;
    if (!(requestsById instanceof Map)) return null;
    const request = requestsById.get(requestId) as Record<string, unknown> | undefined;
    if (request === undefined) return null;

    const modules = [...USER_DATA_DELETION_MODULES];
    let derived: DerivedBackupStates;
    try {
      derived = await derivation.derive({ requestId, userId, modules });
    } catch {
      // 读不到 ≠ 清完了（也 ≠ 还没轮到）：如实折叠成 blocked，⛔ 不返回 pending。
      derived = unreadableBackupStates({ requestId, modules });
    }

    const changed: string[] = [];
    const skipped: string[] = [];
    for (const one of derived.modules) {
      const row = handlerRowsOf(requestId).find((candidate) => candidate['module'] === one.module);
      if (row === undefined) {
        skipped.push(one.module);
        continue;
      }
      if (row['onlineState'] !== 'completed') {
        skipped.push(one.module);
        continue;
      }
      const before = {
        backupState: row['backupState'],
        evidenceRef: row['evidenceRef'],
        errorCode: row['errorCode'],
        status: row['status'],
      };
      if (one.state === 'completed') {
        row['backupState'] = 'completed';
        row['errorCode'] = null;
        row['evidenceRef'] = withBackupSegment(
          before.evidenceRef,
          one.module,
          `${one.module}:backup-purged:${one.evidenceRef as string}`,
        );
      } else if (one.state === 'pending') {
        // 「还没到期」是唯一正当的 pending：清掉旧的备份证据段，但保留在线证据。
        row['backupState'] = 'pending';
        row['errorCode'] = null;
        row['evidenceRef'] = withBackupSegment(before.evidenceRef, one.module, null);
      } else {
        const code = one.errorCode ?? 'EVIDENCE_REQUIRED';
        row['backupState'] = 'blocked';
        row['errorCode'] = code;
        row['evidenceRef'] = withBackupSegment(
          before.evidenceRef,
          one.module,
          `${one.module}:backup-blocked:${code}`,
        );
      }
      recomputeRowStatus(row);
      row['updatedAt'] = now();
      if (
        before.backupState !== row['backupState'] ||
        before.evidenceRef !== row['evidenceRef'] ||
        before.errorCode !== row['errorCode'] ||
        before.status !== row['status']
      ) {
        changed.push(one.module);
      }
    }

    // 证据账本同步：回执本身不展示证据，但 `evidenceOf()` 必须与账本行说同一件事——
    // 否则「备份已清」的摘要只活在 handler 行里，审计侧读不到（也就等于没写证据）。
    if (changed.length > 0) {
      const ledger = evidenceByRequest.get(requestId) ?? {};
      for (const module of changed) {
        const row = handlerRowsOf(requestId).find((candidate) => candidate['module'] === module);
        const value = row === undefined ? '' : String(row['evidenceRef'] ?? '');
        if (value === '') delete ledger[module];
        else ledger[module] = value;
      }
      evidenceByRequest.set(requestId, ledger);
    }

    let stateReset = false;
    if (request['state'] === 'blocked') {
      const handlerBlocked = handlerRowsOf(requestId).some(
        (row) => row['onlineState'] === 'blocked' || row['backupState'] === 'blocked',
      );
      const thirdPartyBlocked = thirdPartyRowsOf(requestId).some(
        (row) =>
          row['onlineStatus'] === 'failed' ||
          row['backupStatus'] === 'failed' ||
          row['onlineStatus'] === 'unsupported' ||
          row['backupStatus'] === 'unsupported',
      );
      // `deletion.mjs:311` 要求 `request.state !== 'blocked'` 才可能升为 completed；旧 blocked 是
      // 「上一次执行看到的事实」，不是永久判决 —— 读完新事实后无人再 blocked ⇒ 复位，交给协议重判。
      if (!handlerBlocked && !thirdPartyBlocked) {
        request['state'] = 'processing';
        request['revision'] = Number(request['revision'] ?? 0) + 1;
        stateReset = true;
      }
    }

    // 整体完成判定仍只由协议做（并负责写 `state`/`completedAt`/`revision`）。
    coordinator.completionStatus(requestId);
    return { requestId, derived, changed, skipped, stateReset };
  }

  return {
    coordinator,
    requiredModules: () => coordinator.requiredModules(),
    requestDeletionFor(userId, options = {}) {
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new Error('注销删除请求必须绑定非空主体');
      }
      const request = coordinator.createDeletionRequest(options);
      const id = String(request['id']);
      subjectByRequest.set(id, userId);
      if (requests !== null) {
        durableByRequest.set(id, startDurableAcceptance(id, userId, request, backupCopySources()));
      }
      return request;
    },
    async executeHandlers(requestId) {
      // 持久化受理（同一事务）必须先有结论：失败 ⇒ 在此抛出，**不进入级联、不签发回执、不返回 202**。
      const pending = durableByRequest.get(requestId);
      if (pending !== undefined) await pending;
      return coordinator.executeHandlers(requestId);
    },
    completionStatus: (requestId) => coordinator.completionStatus(requestId),
    receipt: (requestId) => coordinator.receipt(requestId),
    refreshBackupStates,
    evidenceOf: (requestId) => ({ ...(evidenceByRequest.get(requestId) ?? {}) }),
    audit: () => auditLog.map((entry) => ({ ...entry })),
  };
}

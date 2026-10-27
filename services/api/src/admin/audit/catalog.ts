/**
 * 后台审计日志查询面（`GET /admin/audit-logs`）的枚举**单一来源**（R34 切片 · Refs #18）。
 *
 * ## 为什么枚举不写死在路由/契约两处
 * 查询参数 `action` / `entity` 的闭集**不是**从契约里编出来的，而是从「谁在写这张表」反推的。
 * 今天往 `public.admin_audit_events` 落库写审计的地方全在 `services/api/db/migrations/` 里，
 * 一共十种 `action`：
 *
 * | 写入点（库内函数） | `action` | `scope`（查询参数 `entity` 的取值来源） | 迁移 |
 * | --- | --- | --- | --- |
 * | `public.suspend_account(...)`  | `account.suspend` | `accounts:suspend` | 0017 |
 * | `public.restore_account(...)`  | `account.restore` | `accounts:suspend` | 0017 |
 * | `public.set_feature_flag(...)` | `set_flag`        | `flags:write`      | 0020 / 0027 |
 * | `public.grant_admin_scope(...)`  | `admin_scope.grant`  | `scopes:write`（见下「一变多」注） | 0041 |
 * | `public.revoke_admin_scope(...)` | `admin_scope.revoke` | `scopes:write`（同上） | 0041 |
 * | `public.record_admin_job_cancel_audit(...)` | `job.cancel` | `jobs:cancel` | 0043 `:168-175` |
 * | `public.record_admin_scope_denial(...)` | `admin_scope.deny` | `scopes:write` | 0046 |
 * | `public.record_admin_post_hide_audit(...)` | `post.hide` | `sources:write` | 0047 `:185-198` |
 * | `public.disable_admin_account(...)` | `admin_account.disable` | `scopes:write`（共享，见下「admin_account 也需要护栏」） | 0048 `:282-290` |
 * | `public.enable_admin_account(...)`  | `admin_account.enable`  | `scopes:write`（同上） | 0048 `:413-421` |
 *
 * `account.suspend` 与 `account.restore` 共用同一个 `scope`，因此 `entity=account` 一次取回
 * 「停用 + 恢复」两类行；`entity=flag` 只取开关变更；`entity=job` 只取作业取消；
 * `entity=admin_scope` 取 scope 授予/撤销/被拒（并见下「一处必须如实登记的读数放宽」——
 * `0048` 之后这个筛选维度还会带上 `admin_account.*` 行）；`entity=admin_account` 取后台
 * 管理员账号的停用/恢复；`entity=post` 只取下架 —— 但 `post` 与 `admin_account` 都不是靠
 * `scope` 列收窄出来的，它们是**带动作护栏**的实体，理由见下面两节。
 * **未知取值一律 400**（fail-closed）：
 * ⛔ 不静默返回空页 —— 空页会被读成「平台从未发生过这类操作」，那是一条无法确认的结论。
 *
 * ## 一处必须如实登记的读数瑕疵：「一变多」的 `scope` 列
 * `0041` 的审计行把 `scope` 写成**被授/被撤的那个 scope 值本身**（`0041:65` 的口径，
 * `p_scope` 直传），而 `0046` 的拒绝行写死 `'scopes:write'`（`0046` 的 `p_scope` 由调用方
 * 固定申报）。所以 `entity=admin_scope` 映射到单个 `scopes:write` 时：
 *   - `admin_scope.deny` 行 **全部命中**（它们恒为 `scopes:write`）；
 *   - `admin_scope.grant` / `admin_scope.revoke` 行**只命中**动到 `scopes:write` 的那些，
 *     例如「授予 `accounts:read`」这类行不在 `entity=admin_scope` 的结果里。
 * 这是**已知且被接受**的收窄：`?entity=` 是单值筛选维度（`service.ts` 把
 * `scopeOfAuditEntity(entity)` 包成单元素数组），要完整覆盖需把 `entity` 语义改成「多值集」，
 * 那是读面的形状变更、不在本片范围。⛔ 不得为此把映射改成 `null`/空数组——那会退化成
 * 「静默全量」，比收窄更糟。要按 `action` 精确取，`?action=admin_scope.grant` 是全量命中的。
 *
 * 本文件同时是「枚举与契约/台账保持一致」的锚点：`tests/unit/admin-audit-logs.test.mjs`
 * 逐项核对这里的三张表与 `packages/contracts/openapi.json` 的 `parameters` 枚举、
 * `operations.json` 的 `scope`，以及迁移里的写入语句；跨文件的闭集/顺序双锚在
 * `tests/unit/ai-ops-ledger-pins.test.mjs`，`post.hide` 的库内写入点单源在
 * `tests/unit/community-audit-channel-pins.test.mjs`。
 *
 * ## 为什么 `post` 需要**动作护栏**（`AUDIT_ENTITY_ACTION_GUARDS`）
 *
 * 别的实体靠 `entity → scope` 一对一收窄就够用：它们的 `scope` 列取值是**该域专属**的
 * （`accounts:suspend` / `flags:write` / `jobs:cancel`）。`sources:write` 不是 ——
 * 它是**共享**命名空间，同一个字面量在库里至少被两类审计行写着：
 *
 *   1. `0047` 的下架行：`action='post.hide'`、`scope='sources:write'`、`target_ref.type='post'`；
 *   2. `0041` / `0046` 的**权限行**：`grant_admin_scope` / `revoke_admin_scope` /
 *      `record_admin_scope_denial` 把 `p_scope` **直传**进 `scope` 列（`0041:319-326`、
 *      `0041:472-479`、`0046:167-176`）。管理员授予/撤销 `sources:write` 这个能力时，
 *      落库的审计行 `scope` 恰好也是 `'sources:write'`，而 `target_ref` 是 `NULL`、
 *      `target_hint` 是 `'admin_account:<id>'` —— **跟帖子毫无关系**。
 *
 * 所以「`entity=post` ⇒ `scopes=['sources:write']`」这种纯 scope 映射会把「某管理员被授予
 * `sources:write` 能力」这类行也筛进一个**标着 post 的**结果集：读者看到的是「这些帖子被下架了」，
 * 实际其中混着权限变更。这不是收窄，是**错误命名**，比空页更难发现。
 *
 * 因此 `post` 必须加一层动作护栏：`entity=post` 只等于 `action='post.hide'`。
 * 三条派生规则都由 `service.ts` 落实：
 *
 *   - 只给 `?entity=post` ⇒ `actions` 取护栏清单（`['post.hide']`），`scopes` 仍取
 *     `[scopeOfAuditEntity('post')]`；
 *   - `?entity=post&action=post.hide` ⇒ 与上一条同样的结果集（显式写法）；
 *   - `?entity=post&action=<护栏外的合法 action>` ⇒ **400**，不是空页。这一组合在护栏语义下
 *     根本**不可表达**：按护栏算恒空（`post.hide` ∩ `admin_scope.grant` = ∅），不按护栏算
 *     又会把非 post 行塞进 post 的结果里。两种读法都是假话 —— 一个说「平台从未发生」，
 *     一个说「这些是下架」—— 所以只能 fail-closed 报参数错。
 *
 * ⛔ 不要把这条护栏做成「忽略 `?action=` 静默取交集」或「忽略护栏返回全 scope」：
 * 前者伪造空页，后者重现上面那个命名错误。护栏是**语义边界**，违反它的请求必须被拒。
 *
 * ## 为什么 `admin_account` 也需要**动作护栏**（理由比 `post` 更强）
 *
 * `0048` 的两个写入口（`public.disable_admin_account` / `public.enable_admin_account`）把审计行
 * 的 `scope` 列写成 `'scopes:write'` —— 那是**门控该动作的权限本身**，且是函数体内的字面量
 * （`0048:286` / `0048:417`，调用方伪造不了）。但 `scopes:write` 同时是 `admin_scope` 实体的
 * 映射值，`0041`/`0046` 的权限行把 `p_scope` 直传进同一个 `scope` 列。于是：
 *
 *   - `?entity=admin_account` 若不设护栏，会把 scope 授予/撤销/被拒行一起筛进来，
 *     而读者看到的是「这些后台管理员账号被停用了」—— 与 `post` 那条一模一样的**错误命名**；
 *   - 因此 `admin_account` 的护栏是 `['admin_account.disable', 'admin_account.enable']`，
 *     `?entity=admin_account&action=<护栏外>` 一律 **400**（不静默取交集）。
 *
 * 与 `post` 的差别只在「共享字面量的另一半是谁」：`post` 抢的是 `sources:write`，`admin_account`
 * 抢的是 `scopes:write`（后者更敏感：它正是本动作的权限门）。两条护栏各自独立登记，⛔ 不复用。
 *
 * ## 一处必须如实登记的读数放宽：`?entity=admin_scope` 现在也会带上 `admin_account.*` 行
 *
 * 护栏是**逐实体**的，只收窄被点名的那一个。`0048` 之后 `scope='scopes:write'` 这个字面量被
 * 两类行共用（`admin_scope.*` 与 `admin_account.*`），而 `admin_scope` **故意不加护栏**：
 * 派单硬约束是「⛔ 不给别的实体补护栏」，且真给 `admin_scope` 加护栏会把
 * `?entity=admin_scope&action=account.suspend` 这类既有「能查、返回空页」的组合改成 400 —
 * 那是协议行为变更，不在本片授权范围。代价：`?entity=admin_scope` 的结果里会混入
 * `admin_account.disable` / `admin_account.enable` 行。每行都带着自己的 `action`，类型读得出来，
 * 但**筛选维度**确实被放宽了。精确读法：
 *   - 账号停用/恢复 ⇒ `?entity=admin_account`（护栏生效）或 `?action=admin_account.disable`；
 *   - 权限变更 ⇒ `?action=admin_scope.grant` / `.revoke` / `.deny`（action 维度不做 scope 收窄）。
 * ⛔ 不要为了「看起来更干净」给 `admin_scope` 补护栏，或把这层映射改成 `null`/空数组：
 * 前者改既有协议、后者退化成静默全量。这条放宽是**已知代价**，登记在本节与验证文档里。
 */

/** 账号停用（迁移 0017 `public.suspend_account`）。 */
export const AUDIT_ACTION_ACCOUNT_SUSPEND = 'account.suspend';
/** 账号恢复（迁移 0017 `public.restore_account`）。 */
export const AUDIT_ACTION_ACCOUNT_RESTORE = 'account.restore';
/** 功能开关变更（迁移 0020，0027 同签名替换）。 */
export const AUDIT_ACTION_SET_FLAG = 'set_flag';
/**
 * 作业取消（迁移 0043 `public.record_admin_job_cancel_audit`，审计行写在 `:168-175`）。
 *
 * 为什么第 4 项必须在这里：`0043` 已经把 `action='job.cancel'` / `scope='jobs:cancel'`
 * 写进表，但闭集不认它 ⇒ 读面「能看见（全量翻页）、不能筛（`?action=` 一律 400）」。
 * 闭集是**从写入点反推**的，所以新增写入点必须同时登记到这张表，否则就是这一片要修的漂移。
 */
export const AUDIT_ACTION_JOB_CANCEL = 'job.cancel';

/**
 * 管理员 scope 的**授予**（迁移 `0041` 的 `public.grant_admin_scope`，审计行在 `:319-326`）。
 *
 * 为什么这条必须补：`0041` 早就把 `action='admin_scope.grant'` 写进表了，闭集却不认它 ⇒
 * 读面「能看见（全量翻页）、不能筛（`?action=admin_scope.grant` 一律 400）」。这和下面
 * `job.cancel` 是同一个漂移，只是没人在读面上撞到过。
 */
export const AUDIT_ACTION_ADMIN_SCOPE_GRANT = 'admin_scope.grant';
/** 管理员 scope 的**撤销**（迁移 `0041` 的 `public.revoke_admin_scope`，审计行在 `:472-479`）。 */
export const AUDIT_ACTION_ADMIN_SCOPE_REVOKE = 'admin_scope.revoke';
/**
 * 管理员 scope 操作**被拒**的留痕（迁移 `0046` 的 `public.record_admin_scope_denial`）。
 *
 * 与上面两条是同一个动作的两面：`accepted`（`0041`，主事务内）↔ `denied`（`0046`，第二个事务）。
 * 这一行是**应用层申报**，不是库层证明（见 `0046` 文件头与
 * `services/api/src/admin/ops/scope-authority-pg.ts` 的「拒绝留痕」一段）。
 */
export const AUDIT_ACTION_ADMIN_SCOPE_DENY = 'admin_scope.deny';

/**
 * 后台下架社区帖（迁移 `0047` 的 `public.record_admin_post_hide_audit`，审计行在 `:185-198`）。
 *
 * 它是**第 8 项**、也是当前唯一需要配「动作护栏」的实体动作：`0047` 早已把
 * `action='post.hide'` / `scope='sources:write'` 写进表，但读面闭集不认它 ⇒ 又一次
 * 「能看见（全量翻页）、不能筛（`?action=post.hide` 一律 400）」。而 `sources:write`
 * 同时是权限行（`0041`/`0046` 直传 `p_scope`）的 `scope` 取值，所以补闭集还不够，
 * 还得给 `entity=post` 加护栏 —— 理由见文件头「为什么 `post` 需要动作护栏」。
 */
export const AUDIT_ACTION_POST_HIDE = 'post.hide';

/**
 * 后台管理员账号**停用**（迁移 `0048` 的 `public.disable_admin_account`，审计行在 `:282-290`）。
 *
 * 它是**第 9 项**。`0048` 把 `action='admin_account.disable'` / `scope='scopes:write'` 写进表，
 * 闭集不登记就是又一次「能看见（全量翻页）、不能筛（`?action=admin_account.disable` 一律 400）」。
 * `scopes:write` 与 `admin_scope` 实体共用 ⇒ 必须配动作护栏，见文件头那一节。
 *
 * ⛔ 这条 action **不是**「终端用户停用」（那是 `account.suspend`，`0017`），也不是
 * 「撤销某个 scope」（那是 `admin_scope.revoke`）。三者语义与门都不同，别互相冒充。
 */
export const AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE = 'admin_account.disable';
/** 后台管理员账号**恢复**（迁移 `0048` 的 `public.enable_admin_account`，审计行在 `:413-421`）。 */
export const AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE = 'admin_account.enable';

/** `GET /admin/audit-logs` 的 `action` 闭集（= 库内写入点的 `action` 列取值）。 */
export const AUDIT_ACTIONS = Object.freeze([
  AUDIT_ACTION_ACCOUNT_SUSPEND,
  AUDIT_ACTION_ACCOUNT_RESTORE,
  AUDIT_ACTION_SET_FLAG,
  AUDIT_ACTION_JOB_CANCEL,
  AUDIT_ACTION_ADMIN_SCOPE_GRANT,
  AUDIT_ACTION_ADMIN_SCOPE_REVOKE,
  AUDIT_ACTION_ADMIN_SCOPE_DENY,
  AUDIT_ACTION_POST_HIDE,
  AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE,
  AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE,
] as const);

export type AdminAuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * `entity` → 审计表 `scope` 列。
 *
 * 用「域名词」而不是直接暴露 `scope` 字符串，是因为 `scope` 是**权限命名空间**的形状
 * （`accounts:suspend` 里的 `:suspend` 是动作），而审计日志的使用者关心的是「哪一类对象」。
 * 映射关系只在这里写一遍：路由层与服务层都不许再抄一份。
 */
export const AUDIT_ENTITY_SCOPES = Object.freeze({
  account: 'accounts:suspend',
  flag: 'flags:write',
  /**
   * `job` → `jobs:cancel`（**不是** `jobs:read`）。
   *
   * 这张表映射的是「审计行 `scope` 列**实际写的值**」，不是「读这类对象要哪个权限」。
   * 0043 的 `record_admin_job_cancel_audit` 在 `:175` 写的是 `'jobs:cancel'`，映射成
   * `jobs:read` 会让 `?entity=job` 永远返回空页 —— 那恰好是本片要杀死的「静默空页」伪造。
   */
  job: 'jobs:cancel',
  /**
   * `admin_scope` → `scopes:write`。
   *
   * ⚠ 这是一条**已知的收窄**，不是笔误：`0046` 的拒绝行恒写 `scope='scopes:write'`（写死），
   * 而 `0041` 的授予/撤销行写的是**被授/被撤的那个 scope 值本身**（`p_scope` 直传）⇒
   * 本映射只命中「动到 `scopes:write`」的授予/撤销行，以及**全部**拒绝行。完整的逐 scope
   * 读法走 `?action=admin_scope.grant`（action 维度不做 scope 收窄）。理由与取舍见文件头
   * 「一处必须如实登记的读数瑕疵」那段。
   */
  admin_scope: 'scopes:write',
  /**
   * `post` → `sources:write`。
   *
   * 这张表只记「审计行 `scope` 列实际写的值」（`0047:192` 写死 `'sources:write'`）。
   * ⚠ 但它**单独用不足以定义 `entity=post`**：`sources:write` 同时是 `0041`/`0046` 权限行
   * 的 `scope` 取值（`p_scope` 直传），所以 `post` 另配一条动作护栏收窄到 `post.hide`，
   * 见下面 `AUDIT_ENTITY_ACTION_GUARDS` 与文件头那一节。
   */
  post: 'sources:write',
  /**
   * `admin_account` → `scopes:write`。
   *
   * 这张表只记「审计行 `scope` 列实际写的值」：`0048:286` / `0048:417` 写死 `'scopes:write'`
   * （门控该动作的权限，函数体内是字面量）。
   * ⚠ 与 `post` 同构：`scopes:write` 也是 `0041`/`0046` 权限行的 `scope` 取值（`p_scope` 直传），
   * 所以单独用这个映射会把权限变更行混进「管理员账号停用」的结果里 ⇒ `admin_account` 另配
   * 动作护栏收窄到两个新 action，见下面 `AUDIT_ENTITY_ACTION_GUARDS` 与文件头那一节。
   */
  admin_account: 'scopes:write',
} as const);

export type AdminAuditEntity = keyof typeof AUDIT_ENTITY_SCOPES;

/** `GET /admin/audit-logs` 的 `entity` 闭集（= `AUDIT_ENTITY_SCOPES` 的键）。 */
export const AUDIT_ENTITIES: readonly AdminAuditEntity[] = Object.freeze(
  Object.keys(AUDIT_ENTITY_SCOPES) as AdminAuditEntity[],
);

/** `entity` → 库内 `scope` 列取值；调用方必须先判 `entity` 属于闭集。 */
export function scopeOfAuditEntity(entity: AdminAuditEntity): string {
  return AUDIT_ENTITY_SCOPES[entity];
}

/**
 * `entity` → **动作护栏**：该实体在 `?entity=` 语义下只允许出现的 `action` 清单。
 *
 * 为什么是独立一张表、而不是往 `AUDIT_ENTITY_SCOPES` 里加第二个字段：只有 `scope` 列取值
 * **不专属**的实体才需要护栏（今天有 `post` 与 `admin_account`，两者都栽在共享字面量上，
 * 见文件头两节）；其余实体在这里查不到键 ⇒ 「无护栏」= `?action=` 不受额外限制。用「缺席」
 * 表达「无护栏」，比给每个实体编一份假的「全量清单」更诚实 —— 后者会让读者以为所有实体都被
 * 动作维度过了一遍。
 *
 * ⛔ 护栏不是「建议值」：`services/api/src/admin/audit/service.ts` 在 `?action=` 落在清单外时
 * **400 fail-closed**（不静默取交集 —— 交集恒空，会被读成「平台从未发生过这类操作」）。
 */
export const AUDIT_ENTITY_ACTION_GUARDS: Readonly<
  Partial<Record<AdminAuditEntity, readonly AdminAuditAction[]>>
> = Object.freeze({
  post: Object.freeze([AUDIT_ACTION_POST_HIDE] as const),
  admin_account: Object.freeze([AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE, AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE] as const),
});

/**
 * 取某个 `entity` 的动作护栏。
 *
 * @returns 护栏清单（至少一项）；`null` = 该实体**没有**护栏，`?action=` 不受额外限制。
 *   调用方必须先判 `entity` 属于闭集（`AUDIT_ENTITIES`），本函数不重复校验。
 */
export function actionsOfAuditEntity(entity: AdminAuditEntity): readonly AdminAuditAction[] | null {
  return AUDIT_ENTITY_ACTION_GUARDS[entity] ?? null;
}

/**
 * 游标里记的 `family`。
 *
 * 与 `flag_audit` 分开是必要的：两类审计读面各有自己的筛选维度，共用 `family` 会让
 * 「用开关留痕的游标去翻通用审计」这种串用悄悄通过。
 */
export const AUDIT_LOG_CURSOR_FAMILY = 'audit_logs';

/** 权限 scope（复用既有后台 scope，不新造一套鉴权）。 */
export const AUDIT_LOG_SCOPE = 'audit:read';

/** 本片对外的唯一 operationId。 */
export const AUDIT_LOG_OPERATION_ID = 'listAuditLogs';

/**
 * 后台审计日志查询面（`GET /admin/audit-logs`）的枚举**单一来源**（R34 切片 · Refs #18）。
 *
 * ## 为什么枚举不写死在路由/契约两处
 * 查询参数 `action` / `entity` 的闭集**不是**从契约里编出来的，而是从「谁在写这张表」反推的。
 * 今天往 `public.admin_audit_events` 落库写审计的地方全在 `services/api/db/migrations/` 里，
 * 一共十一种 `action`：
 *
 * | 写入点（库内函数） | `action` | `scope`（查询参数 `entity` 的取值来源） | 迁移 |
 * | --- | --- | --- | --- |
 * | `public.suspend_account(...)`  | `account.suspend` | `accounts:suspend` | 0017 |
 * | `public.restore_account(...)`  | `account.restore` | `accounts:suspend` | 0017 |
 * | `public.set_feature_flag(...)` | `set_flag`        | `flags:write`      | 0020 / 0027 |
 * | `public.grant_admin_scope(...)`  | `admin_scope.grant`  | `scopes:write`（见下「一变多」注） | 0041 |
 * | `public.revoke_admin_scope(...)` | `admin_scope.revoke` | `scopes:write`（同上） | 0041 |
 * | `public.record_admin_job_cancel_audit(...)` | `job.cancel` | `jobs:cancel` | 0043 `:168-175` |
 * | `public.record_admin_scope_denial(...)` | `admin_scope.deny` | `p_scope`（调用点固定申报 `scopes:write`，见下「一变多」注） | 0046 |
 * | `public.record_admin_post_hide_audit(...)` | `post.hide` | `sources:write` | 0047 `:185-198` |
 * | `public.disable_admin_account(...)` | `admin_account.disable` | `scopes:write`（共享，见下「admin_account 也需要护栏」） | 0048 `:282-290` |
 * | `public.enable_admin_account(...)`  | `admin_account.enable`  | `scopes:write`（同上） | 0048 `:413-421` |
 * | `public.record_admin_category_update(...)` | `category.update` | `sources:write`（与 `post` 共享，靠动作护栏分开；**没有** `entity=category`） | 0049 `:413` |
 *
 * ## `?entity=X` 到底匹配哪些行（本文件的**筛选语义**，唯一定义处）
 *
 * 一条审计行进不进 `?entity=X` 的结果集，由两个维度共同决定：
 *
 *   1. **必选**：该行 `scope` 列 === `scopeOfAuditEntity(X)`（`AUDIT_ENTITY_SCOPES`）；
 *   2. **动作护栏**：该行 `action` ∈ `actionsOfAuditEntity(X)`（`AUDIT_ENTITY_ACTION_GUARDS`；
 *      表里对该实体显式写 `null` = 没有专属动作清单，本维度不生效）。
 *
 * ⚠ 维度 1 从来**不足以**定义 `entity`：`scope` 列不是「域」列，它记的是「这笔操作动了哪个
 * 权限名」，而 `0041` / `0046` 把调用方给的 `p_scope` 直传进去（见下「一变多」注）。后台 13 项
 * 闭集里的**每一个** scope 都能出现在授权行上，所以**没有任何一个 scope 字面量是域专属的**。
 * 凡是「域内动作 ≠ 落库 scope 全部来源」的实体，都必须靠维度 2 收窄。今天：
 *
 * | `entity` | 匹配的行 |
 * | --- | --- |
 * | `account` | `action ∈ {account.suspend, account.restore}` 且 `scope='accounts:suspend'` |
 * | `job` | `action='job.cancel'` 且 `scope='jobs:cancel'` |
 * | `post` | `action='post.hide'` 且 `scope='sources:write'` |
 * | `admin_account` | `action ∈ {admin_account.disable, admin_account.enable}` 且 `scope='scopes:write'` |
 * | `flag` | `action='set_flag'` 且 `scope='flags:write'` |
 * | `admin_scope` | `action ∈ {admin_scope.grant, admin_scope.revoke, admin_scope.deny}` 且 `scope='scopes:write'` |
 *
 * 前四行之外的直觉都不成立：`account.suspend` 与 `account.restore` 共用一个 `scope`，所以
 * `entity=account` 一次取回「停用 + 恢复」两类行 —— 这是**同一实体**的两个动作，不是串味；
 * 串味指的是「另一个实体的动作因为共用同一个 scope 字面量而漏进来」，那才是护栏要挡的东西。
 *
 * 六个实体**全部**带护栏（`account` / `job` / `flag` / `post` / `admin_account` 由 R68 收口，
 * `admin_scope` 由本片收口，见「`admin_scope` 已收口」）。护栏表是**穷尽**的
 * （`Record<AdminAuditEntity, …>`）：新增实体时忘了登记，`tsc` 会在护栏表处报缺项，而不是静默
 * 让它走「无护栏」的宽读数。没有专属动作的实体**显式写 `null`** —— 那表示「本实体的动作维度
 * 不生效，按 `scope` 兜底」，⛔ 不是「不过滤」或「全返回」：`scope` 维度照样精确匹配
 * （`services/api/src/admin/audit/service.ts` 下传单元素数组，不是 `null`）。`scopes=null` 在本读面
 * 等于「该维度不作为条件」⇒ 那是静默全量，⛔ 绝不允许出现。
 * **未知取值一律 400**（fail-closed）：
 * ⛔ 不静默返回空页 —— 空页会被读成「平台从未发生过这类操作」，那是一条无法确认的结论。
 *
 * ## 「一变多」的 `scope` 列：库层没有域专属字面量
 * `0041` 的审计行把 `scope` 写成**被授/被撤的那个 scope 值本身**（`0041:65` 的口径，
 * `p_scope` 直传；落列见 `:319-326`、`:472-479`）。`0046` 的拒绝行**同样**是 `p_scope` 直传
 * （`:213`），⛔ 不是函数体里写死的 `'scopes:write'` —— 那个字面量来自**调用方**
 * （`services/api/src/admin/ops/scope-denial-trace.ts` 的 `ADMIN_SCOPE_DENIAL_SCOPE`，注释写明
 * 「本片只处理元权限域，故 `p_scope` 写死为它」）。⇒ 口径是「库函数不写死、应用层写死」，
 * 后者是**调用方纪律，不是库层保证**：将来任何一条路径按真实被拒 scope 申报，拒绝行的 `scope`
 * 就会跟着变。所以 `entity=admin_scope` 映射到单个 `scopes:write` 时：
 *   - `admin_scope.deny` 行**今天**全部命中（调用点固定申报 `scopes:write`）；
 *   - `admin_scope.grant` / `admin_scope.revoke` 行**只命中**动到 `scopes:write` 的那些，
 *     例如「授予 `accounts:read`」这类行不在 `entity=admin_scope` 的结果里。
 * 同一枚硬币的另一面是**串味**：「授予 `jobs:cancel`」的行 `scope` 恰好是 `'jobs:cancel'`，
 * 于是它会落进 `?entity=job` 的 scope 条件里 —— 那正是 R68 · GY-R67-C07 修掉的东西（见下
 * 「为什么 `account` / `job` 也需要动作护栏」）。两头都指向同一个结论：**`scope` 不能单独承担
 * `entity` 语义**。
 * 收窄那一半是**已知且被接受**的取舍：`?entity=` 是单值筛选维度（`service.ts` 把
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
 * 这条护栏要挡的不是「`sources:write` 特别脏」，而是「域内动作 ≠ 落库 `scope` 的全部来源」：
 * `sources:write` 是**共享**命名空间，同一个字面量在库里至少被两类审计行写着：
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
 * ## 为什么 `account` / `job` 也需要**动作护栏**（R68 · GY-R67-C07）
 *
 * 同样的串味，只是共用的另一半不同：`accounts:suspend` 与 `jobs:cancel` 都在后台 13 项 scope
 * 闭集里（`services/api/src/admin/scopes.ts` 的 `ADMIN_SCOPES`），所以「管理员被授予/撤销了
 * `jobs:cancel`」这类**授权行**的 `scope` 列恰好是 `'jobs:cancel'`（`0041` 的 `p_scope` 直传，
 * 拒绝行同理）。R68 之前 `job` / `account` 没有护栏 ⇒ 端口只收到 `scopes=['jobs:cancel']`，于是：
 *
 *   - `?entity=job` 把 `admin_scope.grant` / `admin_scope.revoke` / `admin_scope.deny` 的行
 *     一起筛出来 —— 页面标着「作业」，实际列的是权限变更；
 *   - `?entity=account` 同理（`accounts:suspend` 被授予/撤销时漏进来）。
 *
 * 这是**读面错误命名**，不是权限泄漏（能读到这些行的人本来就有 `audit:read`），但它会让
 * 「按实体查审计」的结论变假，且比空页更难发现 —— 与 `post` 那一节同一判据。
 *
 * 修法是**给这些实体补护栏，而不是在 `service.ts` 里另加一层推导**：
 *   - `account` → `[account.suspend, account.restore]`（同一实体的两个动作，共用一个 scope）；
 *   - `job` → `[job.cancel]`（`0043` 只写这一个）；
 *   - `flag` → `[set_flag]`（同一判据，见下「`flag` 已收口」）。
 * 补完之后六个实体（`account` / `job` / `flag` / `post` / `admin_account` / `admin_scope`）走
 * **同一条**路径（`actions` ∩ `scopes` 双维 AND，`service.ts` 一行不动），不再有「豁免护栏」的
 * 实体（`admin_scope` 的收口见下一节）。
 *
 * ⛔ 不要改成「按 action 名字前缀过滤」：前缀是字符串猜谜，而**「哪个 action 属于哪个实体」的
 * 权威映射就是下面这张护栏表**。把判据散成两处（表 + 前缀启发式），下一次新增写入点时会各自
 * 漂移，而漂移的方向恰好是「静默放过」。
 *
 * ## `admin_scope` 已收口：`?entity=admin_scope` 不再带上 `admin_account.*` 行（PR #684 审查遗留项）
 *
 * `0048` 之后 `scope='scopes:write'` 这个字面量被**两类**行共用（`admin_scope.*` 与
 * `admin_account.*`）。R68 给 `admin_account` 补护栏时，`admin_scope` 一侧留成了已登记的
 * 「读数放宽①」：`?entity=admin_scope` 的读面会把 `admin_account.disable` / `.enable` 的行
 * 一起筛出来 —— 与 `job` / `account` / `flag` 修之前**同一个缺陷**（读者看到「权限变更」，
 * 其中混着账号停用）。每行都带着自己的 `action`，类型读得出来，但**筛选维度**确实被放宽了。
 *
 * 那时不补的理由是「补护栏会把 `?entity=admin_scope&action=account.suspend` 这类既有
 * 「能查、返回空页」的组合改成 400 ⇒ 协议行为变更，不在 PR #684 的授权范围」。
 * **本片正是那个被追认的范围**：`admin_scope` 的护栏 = `[grant, revoke, deny]`，于是
 *   - `?entity=admin_scope` ⇒ 三类授权行，⛔ 不含任何 `admin_account.*`；
 *   - `?entity=admin_scope&action=<护栏外>` ⇒ **400**（`service.ts` 的 fail-closed，不静默取交集）。
 *     这是**刻意的**协议变严，不是回归：该组合在护栏语义下不可表达（按护栏算恒空 ⇒ 伪造
 *     「平台从未发生过」；不按护栏算 ⇒ 把账号停用命名成权限变更）。受影响的可观测性只是
 *     「拿 `entity=admin_scope` 去查别的实体的 action」这种本就自相矛盾的用法。
 *   - 精确读法不变：账号停用/恢复 ⇒ `?entity=admin_account` 或 `?action=admin_account.disable`；
 *     权限变更 ⇒ `?action=admin_scope.grant` / `.revoke` / `.deny`（action 维度不做 scope 收窄）。
 * ⛔ 仍不要把映射改成 `null`/空数组：那会退化成「静默全量」，比收窄更糟。收窄（只命中动到
 * `scopes:write` 的 grant/revoke 行）是**已知且被接受**的代价，理由见上一节「一变多」注。
 *
 * ## `flag` 已收口：不再混入动到 `flags:write` 的授权行（R68 · GY-R67-C07）
 *
 * `flags:write` 也在 13 项闭集里，所以「管理员被授予/撤销 `flags:write`」的授权行与 `set_flag`
 * 行共用这个 `scope` 字面量 —— 收口前 `?entity=flag` 一样会混入前者，与 `job` / `account`
 * 修之前是**同一个缺陷**。同一判据 ⇒ 同一修法：`flag` 的护栏只有 `[set_flag]`，于是
 * `?entity=flag` = `action='set_flag'` ∧ `scope='flags:write'`。
 *
 * ⛔ 不要把「今天还没人抱怨」当成「不必收口」：被混入的行是**权限变更**，把这批行命名成
 * 「开关变更」和把它命名成「作业事件」一样假。也不要在测试里把「混入的读数」钉成期望值 ——
 * 那是把已知缺陷写成断言。
 *
 * ⚠ 收口 `flag` **不**牵连授权面的可观测性：`?entity=admin_scope` 仍然看得到
 * `admin_scope.grant` / `.revoke` / `.deny` 三类授权行（`scope` 维度仍按 `scopes:write` 收窄，
 * 三类动作全在护栏清单内 ⇒ 与 `flag` 的 `action` 维度互不干扰）。
 */

/** 账号停用（迁移 0017 `public.suspend_account`）。 */
export const AUDIT_ACTION_ACCOUNT_SUSPEND = 'account.suspend';
/** 账号恢复（迁移 0017 `public.restore_account`）。 */
export const AUDIT_ACTION_ACCOUNT_RESTORE = 'account.restore';
/**
 * 功能开关变更（迁移 0020，0027 同签名替换）。
 *
 * `scope` 列写的是 `'flags:write'`，而这个字面量同时能被授权行写上（授予/撤销 `flags:write`），
 * 故 `?entity=flag` 需要动作护栏收窄到本动作，见文件头「`flag` 已收口」。
 */
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
 * 它是**第 8 项**、也是第一个需要配「动作护栏」的实体动作（R68 起 `account` / `job` 加入同一层）：
 * `0047` 早已把
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

/**
 * 后台改**分类目录**（迁移 `0049` 的 `public.record_admin_category_update`，审计行在该函数体内）。
 *
 * 它是**第 11 项**，也是第一个「有落库写入点、但没有对应 `entity`」的动作：`0049` 把
 * `action='category.update'` / `scope='sources:write'` 写进表，闭集不登记就是又一次
 * 「能看见（全量翻页）、不能筛（`?action=category.update` 一律 400）」。
 *
 * ⚠ `sources:write` 与 `post` 实体共用 ⇒ **靠 `post` 的动作护栏挡串味**：护栏把 `entity=post`
 * 收窄到 `action='post.hide'`，分类行不会漏进帖子视图。反方向今天**没有** `entity=category`
 * （分类不是六个实体之一，也没有 `?entity=` 取值），分类行只能靠 `?action=category.update`
 * 或不过滤的全量翻页拿到 —— 这是刻意的：新增一个 `entity` 要连带改契约 `AuditEntity` 枚举、
 * 后台筛选栏与 `AUDIT_ENTITY_SCOPES`，超出「让既有落库行可筛」的范围。
 *
 * ⛔ 这条 action **不是** `set_flag`（那是 `feature_flags` 的开关值），也不是「内容下架」
 * （那是 `post.hide`）：三者都写过 `sources:write` / `flags:write` 一类共享 scope，但语义、
 * 实体与控制面都不同，别互相冒充。
 */
export const AUDIT_ACTION_CATEGORY_UPDATE = 'category.update';

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
  AUDIT_ACTION_CATEGORY_UPDATE,
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
  /**
   * `account` → `accounts:suspend`（`0017` 的 `suspend_account` / `restore_account` 都写这个值）。
   *
   * ⚠ 它**不是**域专属字面量：`accounts:suspend` 在后台 13 项 scope 闭集里，授予/撤销该 scope 的
   * 授权行 `scope` 列也是它（`0041` 的 `p_scope` 直传）⇒ 单靠本映射会让 `?entity=account` 混入
   * 权限变更行。故 `account` 另配动作护栏收窄到 `account.suspend` / `account.restore`，
   * 见 `AUDIT_ENTITY_ACTION_GUARDS` 与文件头「为什么 `account` / `job` 也需要动作护栏」。
   */
  account: 'accounts:suspend',
  /**
   * `flag` → `flags:write`。
   *
   * ⚠ 同样**不是**域专属：授予/撤销 `flags:write` 的授权行 `scope` 列也是它 ⇒ `flag` 另配动作
   * 护栏收窄到 `set_flag`（见文件头「`flag` 已收口」）。
   */
  flag: 'flags:write',
  /**
   * `job` → `jobs:cancel`（**不是** `jobs:read`）。
   *
   * 这张表映射的是「审计行 `scope` 列**实际写的值**」，不是「读这类对象要哪个权限」。
   * 0043 的 `record_admin_job_cancel_audit` 在 `:175` 写的是 `'jobs:cancel'`，映射成
   * `jobs:read` 会让 `?entity=job` 永远返回空页 —— 那恰好是本片要杀死的「静默空页」伪造。
   *
   * ⚠ 同样**不是**域专属：`jobs:cancel` 在 13 项 scope 闭集里，授予/撤销它的授权行 `scope`
   * 列也是 `'jobs:cancel'` ⇒ `job` 另配动作护栏收窄到 `job.cancel`（见文件头那一节）。
   */
  job: 'jobs:cancel',
  /**
   * `admin_scope` → `scopes:write`。
   *
   * ⚠ 这是一条**已知的收窄**，不是笔误：`0046` 的拒绝行把库函数收到的 `p_scope` 直传进
   * `scope` 列（不是函数体内的字面量），**今天的调用点**固定申报 `scopes:write`
   * （`services/api/src/admin/ops/scope-denial-trace.ts` 的 `ADMIN_SCOPE_DENIAL_SCOPE`）；而
   * `0041` 的授予/撤销行写的是**被授/被撤的那个 scope 值本身**（同为 `p_scope` 直传）⇒
   * 本映射只命中「动到 `scopes:write`」的授予/撤销行，以及今天**全部**拒绝行。完整的逐 scope
   * 读法走 `?action=admin_scope.grant`（action 维度不做 scope 收窄）。理由与取舍见文件头
   * 「「一变多」的 `scope` 列」与「`admin_scope` 已收口」两段。
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
 * **不专属**的实体才需要护栏。今天**六个实体全部**需要：`account` / `job` / `flag` / `post` /
 * `admin_account` / `admin_scope`，六者都栽在「域内动作 ≠ 落库 scope 的全部来源」上（见文件头
 * 对应六节）。`scope` 维度照样生效（`service.ts` 仍下传 `[scopeOfAuditEntity(entity)]`，
 * ⛔ 不是 `null`）——护栏只收窄**动作**维度。
 *
 * ## 为什么类型是穷尽的 `Record`（⛔ 不是 `Partial<Record>`）
 * 用 `Partial<Record<…>>` 时「缺席 = 无护栏」：将来新增一个实体（往 `AUDIT_ENTITY_SCOPES` 加键）
 * 却忘了登记护栏，`tsc` **不会报错**，那个实体就静默退回「只按 `scope` 匹配」的宽读数 ——
 * 也就是本片要杀死的串味。改成 `Record<AdminAuditEntity, … | null>` 后：
 *   - 新增实体 ⇒ 这里**必须**补一个键，否则 `tsc` 报 TS2741（缺属性）；
 *   - 确实没有专属动作的实体 ⇒ **显式写 `null`**（「动作维度不生效，按 scope 兜底」）。
 *     显式的 `null` 是一句可审的声明；「漏写」不是 —— 前者能被 review，后者只能被事故发现。
 *   - `null` ⛔ 不等于「返回全部」：`scopes` 仍取 `[scopeOfAuditEntity(entity)]`（见上）。
 *
 * ⚠ 键名必须是 `AdminAuditEntity` 的成员：闭集外的实体在 `AUDIT_ENTITIES` 判 400，本表不承担
 * 这个判断（`validate` 由调用方先做）。
 *
 * ⛔ 护栏不是「建议值」：`services/api/src/admin/audit/service.ts` 在 `?action=` 落在清单外时
 * **400 fail-closed**（不静默取交集 —— 交集恒空，会被读成「平台从未发生过这类操作」）。
 */
export const AUDIT_ENTITY_ACTION_GUARDS: Readonly<
  Record<AdminAuditEntity, readonly AdminAuditAction[] | null>
> = Object.freeze({
  account: Object.freeze([AUDIT_ACTION_ACCOUNT_SUSPEND, AUDIT_ACTION_ACCOUNT_RESTORE] as const),
  admin_account: Object.freeze([AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE, AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE] as const),
  admin_scope: Object.freeze([
    AUDIT_ACTION_ADMIN_SCOPE_GRANT,
    AUDIT_ACTION_ADMIN_SCOPE_REVOKE,
    AUDIT_ACTION_ADMIN_SCOPE_DENY,
  ] as const),
  flag: Object.freeze([AUDIT_ACTION_SET_FLAG] as const),
  job: Object.freeze([AUDIT_ACTION_JOB_CANCEL] as const),
  post: Object.freeze([AUDIT_ACTION_POST_HIDE] as const),
});

/**
 * 取某个 `entity` 的动作护栏。
 *
 * @returns 护栏清单（至少一项）；`null` = 该实体**没有**专属动作清单（表里显式写 `null`），
 *   `?action=` 不受额外限制、但 `scopes` 维度照样收窄。
 *   调用方必须先判 `entity` 属于闭集（`AUDIT_ENTITIES`），本函数不重复校验。
 *   `?? null` 只为运行期兜底：类型上表是穷尽的，键必在；但 `entity` 可能是绕过类型的字符串。
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

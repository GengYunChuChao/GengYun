/**
 * GY-I18 阶段 1b · 后台运营与开关存储（**进程内内存实现**，非真实 PostgreSQL 接线）。
 *
 * 复用（而不是另写一套）：
 * - 幂等台账 / 串行临界区 / 只可追加审计 ← `admin/runtime.ts`（阶段 1 抽出）；
 * - 契约字段校验 ← `admin/fields.ts` 的同一套实现（`ops/fields.ts` 只换注册表）；
 * - 输入冻结 / 出口深拷贝 ← `admin/immutable.ts`（阶段 1 的不可变边界）。
 *
 * 本层提供三样东西：
 *   1. **分类**（只读 + CAS 编辑；契约无创建/删除 ⇒ 本层也不提供）；
 *   2. **账号视图**（只读 + CAS 停用；只投影契约允许的 4 个字段，不泄露任何私有数据）；
 *   3. **功能开关**（契约闭集 3 个 key，默认全 false；CAS 编辑）。
 *
 * 数据来源如实声明：分类与账号**没有真实库**，必须由调用方注入种子（默认空）；
 * 开关的 key 来自契约闭集，初值恒为 `false`（最严格的一侧）。
 */
import { cloneDeep, freezeDeep, takeOwnershipDeep } from '../immutable.ts';
import { createAdminRuntime } from '../runtime.ts';
import type { AdminRuntime } from '../runtime.ts';
import { CONTRACT_FLAG_KEYS, defaultFlagStates } from './flags.ts';
import type { FlagKey } from './flags.ts';
import { opsValidator } from './fields.ts';
import { ACCOUNT_STATES, CATEGORY_TYPES } from './types.ts';
import type { AccountState, AccountView, CategoryType, CategoryView, FlagView } from './types.ts';

export type OpsCommitFailure = 'NOT_FOUND' | 'REVISION_CHANGED';
export type OpsCommitResult<T> = { ok: true; record: T } | { ok: false; reason: OpsCommitFailure };

export interface OpsStoreOptions {
  runtime?: AdminRuntime;
  /** 分类种子（阶段 2 由真实库注入）。默认空 ⇒ 列表为空页、编辑一律 NOT_FOUND。 */
  categorySeed?: readonly CategoryView[];
  /**
   * 账号种子（阶段 2 由 `users` 表注入）。**不给 = 账号面未接线**：没有一份权威账号清单，
   * 服务层据此 fail-closed（503），不返回空页。传 `[]` 是**明确声明**（"权威说当前没有账号"）。
   */
  accountSeed?: readonly AccountView[];
  /** 开关初值；缺省用契约 3 键 + `enabled:false`。 */
  flagSeed?: readonly FlagView[];
}

export interface AdminOpsStore {
  readonly persistent: false;
  readonly runtime: AdminRuntime;
  readonly audit: AdminRuntime['audit'];
  /**
   * 账号面是否已接线到**认证权威**（今天唯一形态 = 构造时给定了 `accountSeed`）。
   * `false` ⇒ 账号读/写面一律 fail-closed：本 store 里的账号数组只是**内存投影**，
   * 既不是"平台当前没有账号"的证据，也不能承接停用（会伪造一次成功）。
   */
  readonly accountsWired: boolean;

  listCategories(): readonly CategoryView[];
  getCategory(id: string): CategoryView | null;
  commitCategoryIfCurrent(
    id: string,
    expectedRevision: number,
    patch: { name: string; description: string; active: boolean },
  ): OpsCommitResult<CategoryView>;

  listAccounts(): readonly AccountView[];
  getAccount(id: string): AccountView | null;
  commitAccountIfCurrent(id: string, expectedRevision: number, patch: { state: AccountState }): OpsCommitResult<AccountView>;
  /** 供阶段 2 的鉴权层查询的**只读**端口（本片不实现鉴权改动，也不声称已生效）。 */
  isSuspended(userId: string): boolean;

  listFlags(): readonly FlagView[];
  getFlag(key: FlagKey): FlagView | null;
  commitFlagIfCurrent(key: FlagKey, expectedRevision: number, patch: { enabled: boolean }): OpsCommitResult<FlagView>;

  snapshotCounts(): { categories: number; accounts: number; flags: number };
}

/**
 * 种子必须是**契约合法**的记录：接线期就 fail-closed，
 * 而不是把一条形状不对的库行投影成响应（那等于伪造字段）。
 */
function assertSeedContract(schemaName: string, record: unknown): void {
  const issues = opsValidator.collectIssues(schemaName, cloneDeep(record));
  if (issues.length > 0) {
    throw new Error(
      `接线期种子不符合契约 ${schemaName}：${issues.map((issue) => `${issue.field}:${issue.code}`).join(', ')}`,
    );
  }
}

function assertUniqueIds(records: readonly { id: string }[], what: string): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) throw new Error(`${what}种子存在重复 id：${record.id}`);
    seen.add(record.id);
  }
}

export function createAdminOpsStore(options: OpsStoreOptions = {}): AdminOpsStore {
  const runtime = options.runtime ?? createAdminRuntime();
  const categories = new Map<string, CategoryView>();
  const accounts = new Map<string, AccountView>();
  const flags = new Map<FlagKey, FlagView>();

  const categorySeed = options.categorySeed ?? [];
  assertUniqueIds(categorySeed, '分类');
  for (const record of categorySeed) {
    assertSeedContract('Category', record);
    if (!(CATEGORY_TYPES as readonly string[]).includes(record.type)) throw new Error(`分类类型不在契约闭集：${record.type}`);
    categories.set(record.id, takeOwnershipDeep(record));
  }

  const accountSeed = options.accountSeed ?? [];
  // 接线状态**只看"有没有被给定权威来源"**，不看种子条数：空种子是一句明确声明，不是"没接线"。
  const accountsWired = options.accountSeed !== undefined;
  assertUniqueIds(accountSeed, '账号');
  for (const record of accountSeed) {
    assertSeedContract('AdminAccountView', record);
    if (!(ACCOUNT_STATES as readonly string[]).includes(record.state)) throw new Error(`账号状态不在契约闭集：${record.state}`);
    accounts.set(record.id, takeOwnershipDeep(record));
  }

  const flagSeed = options.flagSeed ?? defaultFlagStates();
  const seenKeys = new Set<string>();
  for (const record of flagSeed) {
    if (!(CONTRACT_FLAG_KEYS as readonly string[]).includes(record.key)) {
      throw new Error(`开关 key 不在契约闭集：${record.key}`);
    }
    if (seenKeys.has(record.key)) throw new Error(`开关种子存在重复 key：${record.key}`);
    seenKeys.add(record.key);
    assertSeedContract('Flag', record);
    flags.set(record.key as FlagKey, takeOwnershipDeep(record));
  }
  // 契约闭集里的每个 key 都必须有状态（缺一不可，避免"读不到就等于关"的静默歧义）。
  for (const key of CONTRACT_FLAG_KEYS) {
    if (!flags.has(key)) flags.set(key, freezeDeep({ key, enabled: false, revision: 1 }));
  }

  const listOf = <T>(map: Map<string, T>, order: (record: T) => string): readonly T[] =>
    Object.freeze([...map.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0)).map((r) => cloneDeep(r)));

  return {
    persistent: false,
    runtime,
    audit: runtime.audit,
    accountsWired,

    listCategories() {
      return listOf(categories, (record) => record.id);
    },
    getCategory(id) {
      const record = categories.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    commitCategoryIfCurrent(id, expectedRevision, patch) {
      const current = categories.get(id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CHANGED' };
      // 只允许改契约 `CategoryInput` 里的三个字段；`id`/`type` 不可变（契约输入里没有它们）。
      const next = freezeDeep({
        id: current.id,
        type: current.type as CategoryType,
        revision: current.revision + 1,
        name: patch.name,
        description: patch.description,
        active: patch.active,
      });
      categories.set(id, next);
      return { ok: true, record: cloneDeep(next) };
    },

    listAccounts() {
      return listOf(accounts, (record) => record.id);
    },
    getAccount(id) {
      const record = accounts.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    commitAccountIfCurrent(id, expectedRevision, patch) {
      const current = accounts.get(id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CHANGED' };
      const next = freezeDeep({ ...current, revision: current.revision + 1, state: patch.state });
      accounts.set(id, next);
      return { ok: true, record: cloneDeep(next) };
    },
    isSuspended(userId) {
      return accounts.get(userId)?.state === 'suspended';
    },

    listFlags() {
      return listOf(flags, (record) => record.key);
    },
    getFlag(key) {
      const record = flags.get(key);
      return record === undefined ? null : cloneDeep(record);
    },
    commitFlagIfCurrent(key, expectedRevision, patch) {
      const current = flags.get(key);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CHANGED' };
      const next = freezeDeep({ key: current.key, enabled: patch.enabled, revision: current.revision + 1 });
      flags.set(key, next);
      return { ok: true, record: cloneDeep(next) };
    },

    snapshotCounts() {
      return { categories: categories.size, accounts: accounts.size, flags: flags.size };
    },
  };
}

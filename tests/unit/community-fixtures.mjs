/**
 * GY-I15（#15）阶段 1 · 社区域测试夹具。
 *
 * 声明（必须如实，不得被引用为模型证据）：
 *   这里的文本与规则夹具都是**合成输入**，用于验证确定性硬规则层与发布 gate 的行为。
 *   它们**不是**真实样本评估：`docs/evaluation/sample-gap-register.md` 已确认
 *   `ai_moderation_risk` / `ai_moderation_normal` 的真实样本**各为 0**，
 *   因此本文件与所有用例**不得**被引用为审核准确率／召回率或端到端可用性证据。
 *
 * 规则文本夹具直接复用 `tests/moderation/_fixtures.mjs`（GY-I14 的同一份夹具），
 * 避免在社区侧复制一份会漂移的规则样本。
 */
import { ApiError } from '../../services/api/src/errors.ts';
import { createCommunityService } from '../../services/api/src/community/service.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createPublishGate } from '../../services/api/src/community/moderation-gate.ts';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';

export { buildScanLimitText, makeExtraRule, scriptedClock, RULE_TEXT_FIXTURES, NEGATION_CANCELLATION_FIXTURES } from '../moderation/_fixtures.mjs';

/** 仅测试用签名密钥（不是真实密钥、不入库、不入日志）。 */
export const TEST_SIGNING_KEY = 'community-phase1-test-signing-key';

/**
 * **冻结时钟**：本片测试默认注入给发布 gate 的引擎时钟。
 *
 * 为什么：`evaluateHardRules` 的默认预算是 `DEFAULT_RULE_BUDGET_MS = 50`（真实墙钟，
 * `packages/moderation/constants.mjs:223`），并在**每条规则开始前**比较
 * `now - started > budgetMs`（`engine.mjs:373`）。机器负载／调度停顿一旦让两次时钟读取
 * 间隔超过 50ms，判决就变成 `quarantined(RULE_TIMEOUT)`，经社区映射成 422 `INPUT_UNCERTAIN`
 * ——**把机器速度变成了测试结果**。
 *
 * 冻结时钟让 `now - started` 恒为 0：引擎照样**逐条求值全部规则**（预算检查代码路径仍执行），
 * 但"过了多少墙钟"不再参与判定，用例因此只反映规则语义。
 *
 * 语义覆盖**没有被删掉**：「预算耗尽 ⇒ 不得判通过」由两条专门用例（极小预算 + 脚本化时钟）继续覆盖
 *   - `tests/unit/community-gate.test.mjs`「反例 6：规则求值超时（预算耗尽）…」
 *   - `tests/unit/community-service.test.mjs`「反例 4：规则求值超时…」
 * 并由 `community-gate.test.mjs` 的「确定性」用例加固：同一个"同步忙等 >50ms"的匹配器，
 * 在**真实时钟**下必然 `RULE_TIMEOUT`（不得发布），在**冻结时钟**下正常 `approved`。
 */
export const FROZEN_CLOCK = () => 0;

/**
 * 构造社区测试用的发布闸门：默认冻结时钟；`options` 中显式的 `clock`/`budget_ms` 仍可覆盖
 * （超时类用例就是这样写的）。
 */
export function makeGate(options = {}) {
  return createPublishGate({ clock: FROZEN_CLOCK, ...options });
}

export const USER_A = Object.freeze({
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'user',
  authEpoch: 1,
});
export const USER_B = Object.freeze({
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: 'user',
  authEpoch: 1,
});
export const ADMIN = Object.freeze({
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  role: 'admin',
  authEpoch: 1,
});

/** 干净文本（不含任何规则命中形态，也不含需要 fail-closed 的异常）。 */
export const CLEAN_TITLE = '稗草防除经验交流';
export const CLEAN_BODY = '今年雨水偏多，我按标签说明选择登记药剂，先看苗情再决定，注意轮换。';
/** 另一条干净文本：不含"稗草"，用于"规则集新增规则后重审仍可通过"的对照。 */
export const CLEAN_TITLE_NO_HIT = '苗期观察记录';
export const CLEAN_BODY_NO_HIT = '这段时间天气转凉，我记录了田间长势，准备按标签说明处理。';
/** 确定性规则命中（MR-01 危险混配夹具）。 */
export const DANGEROUS_BODY = '我想把草甘膦和乙草胺一起打，效果会不会更好？';

/** 生成契约格式的确定性 uuid（避免随机性影响断言）。 */
export function makeIdFactory(namespace = '5') {
  let counter = 0;
  return () => {
    counter += 1;
    const suffix = String(counter).padStart(12, '0');
    return `00000000-0000-4000-8${namespace}00-${suffix}`;
  };
}

/** 合法幂等键（契约要求 8..128 字符）。 */
export function idem(seed) {
  return `idem-${String(seed).padStart(4, '0')}`;
}

export function assertApiError(code, status) {
  return (error) => {
    assertApiErrorShape(error, code, status);
    return true;
  };
}

export function assertApiErrorShape(error, code, status) {
  if (!(error instanceof ApiError)) {
    throw new Error(`应为 ApiError，实际：${String(error)}`);
  }
  if (typeof error.code !== 'string') throw new Error(`错误码应为字符串，实际 ${typeof error.code}`);
  if (error.code !== code) throw new Error(`错误码应为 ${code}，实际 ${error.code}`);
  if (typeof error.status !== 'number') throw new Error(`HTTP 状态应为数字，实际 ${typeof error.status}`);
  if (error.status !== status) throw new Error(`HTTP 状态应为 ${status}，实际 ${error.status}`);
}

export async function captureError(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出错误，但没有抛出');
}

/**
 * 构造一套完整依赖（内存 store + 出厂 gate + 假名作者目录 + 确定性 id/时钟）。
 * `now` 每次调用递增 1 秒，保证 created_at 排序稳定可断言。
 */
export function makeHarness(options = {}) {
  let tick = 0;
  const base = Date.UTC(2026, 9, 12, 3, 0, 0);
  const now = options.now ?? (() => new Date(base + (tick += 1) * 1000));
  const baseStore = options.store ?? createMemoryCommunityStore({ now: () => now().getTime() });
  const store = options.storeWrapper === undefined ? baseStore : options.storeWrapper(baseStore);
  // 默认闸门使用**冻结时钟**与出厂预算：预算检查照跑，但"过了多少墙钟"不参与判定
  // （避免机器负载把 approved 变成 quarantined(RULE_TIMEOUT)）。超时语义由专门用例覆盖。
  const gate = options.gate ?? makeGate(options.gateOptions ?? {});
  const baseAuthors = options.authors ?? createLocalPseudonymousAuthorDirectory();
  const authors = options.authorsWrapper === undefined ? baseAuthors : options.authorsWrapper(baseAuthors);
  const newId = options.newId ?? makeIdFactory();
  const service = createCommunityService({
    store,
    authors,
    gate,
    signingKey: TEST_SIGNING_KEY,
    now,
    newId,
    ...(options.idempotencyWaitMs === undefined ? {} : { idempotencyWaitMs: options.idempotencyWaitMs }),
    ...(options.idempotencyTtlMs === undefined ? {} : { idempotencyTtlMs: options.idempotencyTtlMs }),
  });
  return { store, rawStore: baseStore, gate, service, authors, newId, now };
}

/**
 * 用**同一份存储**、**同一个主体**构造另一套服务实例，只替换发布闸门。
 * 模拟"规则集升级后重新部署"：既有内容的旧结论必须随之失效。
 */
export function withGate(harness, gateOptions) {
  return createCommunityService({
    store: harness.store,
    authors: harness.authors,
    gate: makeGate(gateOptions),
    signingKey: TEST_SIGNING_KEY,
    now: harness.now,
    newId: harness.newId,
  });
}

/**
 * 手动放行的挂起点：用于**交错复现**——把一条请求停在"已读、未写"的窗口里，
 * 让另一条请求先完成（这正是"检查与写入之间隔着 await"的复现手段）。
 *
 * 用法：`arm()` 之后，**第一次**经过指定依赖的调用会挂起；`entered` 表示已挂起，
 * `release()` 放行。未 `arm()` 时调用直接放行（避免把准备阶段的请求也挂住）。
 */
export function makePausePoint() {
  let release;
  let entered;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  let armed = false;
  let used = false;
  return {
    arm() {
      armed = true;
    },
    /** 只在"已 arm 且尚未使用"时挂起一次。 */
    async pauseOnce() {
      if (!armed || used) return;
      used = true;
      entered();
      await blocker;
    },
    get entered() {
      return enteredPromise;
    },
    release() {
      release();
    },
  };
}

/** 便捷：发一条干净帖子（返回契约 Post）。 */
export async function publishPost(service, actor, overrides = {}, key = idem(1)) {
  return service.createPost(
    actor,
    {
      title: CLEAN_TITLE,
      body: CLEAN_BODY,
      media_ids: [],
      ...overrides,
    },
    { idempotencyKey: key },
  );
}

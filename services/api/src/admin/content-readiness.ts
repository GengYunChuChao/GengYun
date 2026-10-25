/**
 * GY-I18（`Refs #18`）· **内容存储就绪探测 × 公开读引用解析**的唯一接线点（三态，不吞故障）。
 *
 * ## 解决什么问题
 * 迁移 `0036` 之前，内容域只有内存 store（`persistent: false`），公开读的"引用失效"解析恒为
 * `unverifiable` ⇒ 内容照旧可见。0036 之后 `real` ＋有池时 store 换成 PG 实现
 * （`persistent: true`），于是**只要部署里没有这三张表**（子集库、还没跑 0036 的环境），
 * `getEntity` 就会以 `42P01`／`42501` 折成 `503 PROVIDER_UNAVAILABLE`，把**公开读**
 * （`/knowledge`、`/herbicides`）一起打成 503 —— 一个"后台存储没装好"的问题被放大成
 * "前台查不了资料"。这正是 `admin-flags-pg.mjs` 的场景 1（子集库，刻意无 0036）撞到的那条红。
 *
 * ## 三态（逐条落实监工批复，⛔ 不允许合并成两态）
 * | 探测结论 | 含义 | 公开读行为 |
 * |---|---|---|
 * | `ready` | 三张表都在 | 按**已接线**解析：引用不可用 ⇒ 隐藏；**下架/失效一律不可见**（不放宽） |
 * | `missing` | `to_regclass` 明确回 `NULL` ⇒ **确认未配置**（不是故障） | 退回接线前行为：整段引用过滤**跳过**（`unverifiable` ⇒ 可见），200 |
 * | `unknown` | 探测出错（连接／超时／权限）或形状读不懂 | **状态未知 ≠ 未安装** ⇒ **不着手降级**，走真实解析，由 `foldDatabaseError` fail-closed 成 503 |
 *
 * ⛔ 红线：`unknown` **不得**降级。把"连不上库"当成"没配置"放行，是监工批复明确否决的那条
 * （旧裁定「所有库错误无差别落 `unverifiable`」）。因此本模块只在 `missing` 一个分支上短路。
 *
 * ## 时点（与 `featureFlagGate` 同一范式）
 * 探测在 Fastify **`onReady`** 阶段跑一次（装配层 `createFeatureFlagGate` 的 `armingProbe`
 * 也是这么接的，见 `app.ts` 的 `gatePrepare` 钩子）：此时 `listen()`／`inject()` 之前，
 * 迁移已跑完，探测与建表不存在竞态。
 *
 * **`unknown` 不缓存**（与 `flags-pg.ts`／`flag-gate.ts` 的既有纪律一致）：`ready`／`missing` 是
 * 定型结论，请求期不再探测；`unknown` 表示"这次没探到"，下一次公开读会**重探一次**——故障是
 * 瞬时的，把一次连接抖动永久冻结成"内容域永久 503"是 #282 已经修过的坑，不在这里重犯。
 * 重探期间状态仍是 `unknown` ⇒ 该次请求**照样 fail-closed**（⛔ 绝不因"没探到"就降级放行）。
 *
 * ## 不做的事
 * - 不新建第二份 store、不改 store 的创建口径、不动任何既有实参；
 * - 不缓存"某条引用可不可见"的结论（判定仍在读取时逐条重算）；
 * - 不改任何路由、不改任何错误码文案。
 */
import type { AdminFamily } from './types.ts';
import { createAsyncReferenceIntegrity, unresolvedReference } from './reference-integrity.ts';
import type { ReferenceResolution } from './reference-integrity.ts';
import { probeAdminContentTables } from './ops/content-pg.ts';
import type { AdminContentTablesProbe } from './ops/content-pg.ts';
import type { AdminContentStoreLike } from './store.ts';
import type { PgPool } from '../db/pool.ts';

/** 与 `knowledge/public-invalidation.ts#ReferenceResolver` 同形（不 import 该模块，免生依赖环）。 */
type AdminContentReferenceResolver = (
  family: AdminFamily,
  content: unknown,
) => ReferenceResolution | Promise<ReferenceResolution>;

/**
 * 装配层只需给出"注册一个就绪钩子"的能力：不把整个 Fastify 实例类型引进来，
 * 单测也能传一个两行假 host（见 `tests/unit/admin-content-readiness.test.mjs`）。
 */
export interface AdminContentReadinessHost {
  addHook(name: 'onReady', hook: () => Promise<void>): unknown;
}

export interface AdminContentReadinessOptions {
  readonly host: AdminContentReadinessHost;
  /** 本函数上方**已经建好的那一个** `adminContentStore`（不新建第二份）。 */
  readonly store: AdminContentStoreLike;
  /** `real` 且接了池时的那一个 `PgPool`；无池 ⇒ `null`／`undefined`。 */
  readonly pool: Pick<PgPool, 'query'> | null | undefined;
}

/** 就绪状态：`pending` 仅存在于"钩子还没跑完"的瞬间（请求期遇到它按未接线处理，仍 fail-closed）。 */
export type AdminContentReadinessState = 'pending' | AdminContentTablesProbe['state'];

/**
 * 建**公开读**用的引用解析器，并在需要时挂上就绪探针。
 *
 * - `store.persistent !== true`（内存 store／注入的假 store）⇒ **原样**返回既有解析器：
 *   一个字节的行为都不变，也不发探测查询；
 * - `persistent === true` ＋无池（理论上不会出现，PG store 只在有池时构造）⇒ 记 `unknown`，
 *   不探测、不降级；
 * - `persistent === true` ＋有池 ⇒ `onReady` 时探测一次，`missing` 才短路成降级结论；
 *   `unknown` 保留"下次公开读再探一次"的机会（见上）。
 */
export function createAdminContentReferenceResolver(
  options: AdminContentReadinessOptions,
): AdminContentReferenceResolver {
  const { host, store, pool } = options;
  const integrity = createAsyncReferenceIntegrity(store);
  if (store.persistent !== true) return integrity.resolve;

  const readiness: { state: AdminContentReadinessState } = { state: 'pending' };
  let inflight: Promise<AdminContentReadinessState> | null = null;

  /** 探测一次（并发合并成一次查询，不放大库压）。**不抛**：`probeAdminContentTables` 自己吞。 */
  const probeOnce = async (): Promise<AdminContentReadinessState> => {
    if (pool === null || pool === undefined) {
      readiness.state = 'unknown';
      return readiness.state;
    }
    if (inflight === null) {
      inflight = probeAdminContentTables(pool).then((probe) => {
        readiness.state = probe.state;
        return probe.state;
      });
      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    }
    return inflight;
  };

  host.addHook('onReady', async () => {
    await probeOnce();
  });

  const resolve: AdminContentReferenceResolver = async (family, content) => {
    // `ready` / `missing` 是定型结论，不再探测；`pending`（钩子未跑到）与 `unknown` 重探。
    const settled = readiness.state === 'ready' || readiness.state === 'missing';
    const state = settled ? readiness.state : await probeOnce();
    return state === 'missing'
      // **确认未配置**：退回接线前行为（`unverifiable` ⇒ 可见），不折 503。
      // `ready` / `unknown` 一律走真实解析 ⇒ 故障仍然是 503（fail-closed 未放宽）。
      ? unresolvedReference(family, content)
      : integrity.resolve(family, content);
  };

  return resolve;
}

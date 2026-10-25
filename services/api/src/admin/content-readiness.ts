/**
 * GY-I18（`Refs #18`）· **内容存储就绪探测 × 公开读引用解析**的唯一接线点（四态，不吞故障）。
 *
 * ## 解决什么问题
 * 迁移 `0036` 之前，内容域只有内存 store（`persistent: false`），公开读的"引用失效"解析恒为
 * `unverifiable` ⇒ 内容照旧可见。0036 之后 `real` ＋有池时 store 换成 PG 实现
 * （`persistent: true`），于是**只要部署里没有这三张表**（子集库、还没跑 0036 的环境），
 * `getEntity` 就会以 `42P01`／`42501` 折成 `503 PROVIDER_UNAVAILABLE`，把**公开读**
 * （`/knowledge`、`/herbicides`）一起打成 503 —— 一个"后台存储没装好"的问题被放大成
 * "前台查不了资料"。这正是 `admin-flags-pg.mjs` 的场景 1（子集库，刻意无 0036）撞到的那条红。
 *
 * ## 四态（监工 2026-10-25T04:15:22Z 复核后从三态改为四态，⛔ 不允许再合并）
 * | 探测结论 | 库形状 | 公开读行为 |
 * |---|---|---|
 * | `ready` | `entities` ＋ `revisions` 都在（`idempotency` 可缺） | 按**已接线**解析：引用不可用 ⇒ 隐藏；**下架/失效一律不可见** |
 * | `unwired` | 三张表**全都不在** ⇒ **全域确认未配置** | 退回接线前行为：引用过滤**跳过**（`unverifiable` ⇒ 可见），200 |
 * | `incomplete` | 部分存在（半套 schema） | **明确 503 fail-closed**（`PROVIDER_UNAVAILABLE`，`retryable: false`） |
 * | `unknown` | 探测出错（连接／超时／权限）或形状读不懂 | 状态未知 ⇒ 不着手降级，走真实解析，由 `foldDatabaseError` fail-closed 成 503 |
 *
 * ⛔ 红线一：`unknown` **不得**降级。把"连不上库"当成"没配置"放行，是监工批复明确否决的那条
 * （旧裁定「所有库错误无差别落 `unverifiable`」）。因此本模块只在 `unwired` 一个分支上短路。
 *
 * ⛔ 红线二：`incomplete` **既不回落也不真读**。这是本轮复核的核心：库里可能仍存着**已 withdrawn**
 * 的来源，读真值所需的数据就在 `entities`/`revisions` 里；若因"另外某张表缺"就当成整域从未配置，
 * 已下架内容会重新变成**可见**。「部分缺表不能绕过已存来源失效状态」——监工原话。
 *
 * ## 时点（与 `featureFlagGate` 同一范式）
 * 探测在 Fastify **`onReady`** 阶段跑一次（装配层 `createFeatureFlagGate` 的 `armingProbe`
 * 也是这么接的，见 `app.ts` 的 `gatePrepare` 钩子）：此时 `listen()`／`inject()` 之前，
 * 迁移已跑完，探测与建表不存在竞态。
 *
 * **`unknown` 不缓存**（与 `flags-pg.ts`／`flag-gate.ts` 的既有纪律一致）：`ready`／`unwired`／
 * `incomplete` 是定型结论，请求期不再探测；`unknown` 表示"这次没探到"，下一次公开读会**重探一次**
 * ——故障是瞬时的，把一次连接抖动永久冻结成"内容域永久 503"是 #282 已经修过的坑，不在这里重犯。
 * 重探期间状态仍是 `unknown` ⇒ 该次请求**照样 fail-closed**（⛔ 绝不因"没探到"就降级放行）。
 *
 * **定型结论在进程内不再自愈**（运维须知）：`ready`／`unwired`／`incomplete` 探到之后请求期不再
 * 重探 ⇒ 服务起来**之后再补跑迁移 `0036` 不会自动改变结论**，必须**重启服务**（下一次 `onReady`
 * 才会重新探测）。这是刻意的：`to_regclass` 的读数是"表确实在不在"的确定事实，每请求重探只会把
 * 每次公开读都换成一次额外库往返；而"补了迁移但不重启"在部署语义上本就算一次发布。
 * ⚠ 本进程内**没有**任何把其中一态翻成另一态的入口。
 *
 * ## 不做的事
 * - 不新建第二份 store、不改 store 的创建口径、不动任何既有实参；
 * - 不缓存"某条引用可不可见"的结论（判定仍在读取时逐条重算）；
 * - 不改任何路由、不改任何错误码文案（`incomplete` 复用的是既有的 `PROVIDER_UNAVAILABLE`）。
 */
import type { AdminFamily } from './types.ts';
import { createAsyncReferenceIntegrity, unresolvedReference } from './reference-integrity.ts';
import type { ReferenceResolution } from './reference-integrity.ts';
import { probeAdminContentTables } from './ops/content-pg.ts';
import type { AdminContentTables, AdminContentTablesProbe } from './ops/content-pg.ts';
import { ApiError } from '../errors.ts';
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

/** 就绪状态：`pending` 仅存在于"钩子还没跑完"的瞬间（请求期遇到它按未定型处理，仍 fail-closed）。 */
export type AdminContentReadinessState = 'pending' | AdminContentTablesProbe['state'];

/** `incomplete` 的对外文案：写明探测读数，便于运维一眼看出"缺哪张表"。 */
function incompleteMessage(tables: AdminContentTables | undefined): string {
  const read = tables === undefined
    ? 'entities=未知, revisions=未知'
    : `entities=${String(tables.entities)}, revisions=${String(tables.revisions)}`;
  return `后台资料库 schema 不完整（就绪探测：${read}）：内容域读面所需的两张表未就绪，`
    + '公开读按 fail-closed 拒绝（⛔ 不得回落成"未配置"）';
}

/**
 * 建**公开读**用的引用解析器，并在需要时挂上就绪探针。
 *
 * - `store.persistent !== true`（内存 store／注入的假 store）⇒ **原样**返回既有解析器：
 *   一个字节的行为都不变，也不发探测查询；
 * - `persistent === true` ＋无池（理论上不会出现，PG store 只在有池时构造）⇒ 记 `unknown`，
 *   不探测、不降级；
 * - `persistent === true` ＋有池 ⇒ `onReady` 时探测一次，只有 `unwired` 才短路成降级结论；
 *   `incomplete` 明确 503；`unknown` 保留"下次公开读再探一次"的机会（见上）。
 */
export function createAdminContentReferenceResolver(
  options: AdminContentReadinessOptions,
): AdminContentReferenceResolver {
  const { host, store, pool } = options;
  const integrity = createAsyncReferenceIntegrity(store);
  if (store.persistent !== true) return integrity.resolve;

  const readiness: { state: AdminContentReadinessState; tables?: AdminContentTables } = { state: 'pending' };
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
        if ('tables' in probe) readiness.tables = probe.tables;
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
    // `ready` / `unwired` / `incomplete` 是定型结论，不再探测；`pending`（钩子未跑到）与 `unknown` 重探。
    const settled = readiness.state === 'ready'
      || readiness.state === 'unwired'
      || readiness.state === 'incomplete';
    const state = settled ? readiness.state : await probeOnce();
    if (state === 'unwired') {
      // **全域确认未配置**（三张表全都不在）：退回接线前行为（`unverifiable` ⇒ 可见），不折 503。
      return unresolvedReference(family, content);
    }
    if (state === 'incomplete') {
      // **部分 schema**：库里可能仍有已 withdrawn 的来源 ⇒ 既不能回落（会泄露/复活），也不能真读
      // （撞 42P01）⇒ 明确 503。⛔ 不得回落成 unverifiable。
      throw new ApiError('PROVIDER_UNAVAILABLE', incompleteMessage(readiness.tables), { retryable: false });
    }
    // `ready` / `unknown` 一律走真实解析 ⇒ 失效仍然不可见、故障仍然是 503（fail-closed 未放宽）。
    return integrity.resolve(family, content);
  };

  return resolve;
}

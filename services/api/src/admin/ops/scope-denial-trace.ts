/**
 * 后台 scope 操作被拒之后的**留痕旁路**（`#18` S2 收尾片 · 应用层这一半；写入口是迁移 `0046`）。
 *
 * ## 为什么这件事必须在应用层做
 *
 * `0041` 的 `public.grant_admin_scope` / `public.revoke_admin_scope` 判定拒绝时会 `RAISE`，
 * 整个事务随之回滚 —— 连它自己刚写的审计行一起没。那个瞬间 `pg_advisory_xact_lock` 也随事务
 * 释放，库里不再留「刚才被拒过」的任何痕迹。所以只有**本层**补得了这一行。
 *
 * 口径必须如实：这是**应用层申报**，不是**库层证明**。第二事务里已无从复算「当时有几个持有者」
 * 「操作者当时到底持不持 `scopes:write`」。因此本模块只记录「哪个操作者、对谁、在哪个请求上、
 * 因为哪一类拒绝规则被挡下」，⛔ 不假装能重建库层当时的判定依据。
 *
 * ## 三条硬纪律（每条都有对应负控制，见 `tests/unit/admin-scope-denial-wiring.test.mjs`）
 *
 *   1. **必须第二条连接**：主事务先 `ROLLBACK`、主连接先 `release()`，留痕才在**新**连接上以
 *      **单条语句自提交**发出（不包 `BEGIN`…`COMMIT`）。⛔ 不得在还占着连接时做旁路写 ——
 *      那会把一笔已回滚的事务重新拖进同一个事务域，「留痕行的去留」就跟着主响应一起被决定。
 *      库层也干脆不给这条路：函数 `RAISE` 之后事务已 aborted，同事务里任何语句只会拿
 *      `25P02 current transaction is aborted`（负控制实测就是在这一条上红的）。
 *   2. **只认四个 SQLSTATE**（`ADMIN_SCOPE_DENIAL_REASONS` 的键）：`XX000` / `42501` / `42883` /
 *      连接断开等是**服务端缺陷**，不是「被拒」。给它们写一行 `result='denied'` 会把平台事故
 *      伪装成一次正常的权限拒绝 —— 值班会去查操作者，而不是去查故障。⛔ 不得冒充。
 *   3. **整段吞错**：留痕是旁路。它失败**不得**改变主响应（错误映射那一步决定的 403/409 原样
 *      返回，绝不升 500）；它成功也**不得**把 403/409 变 200（返回值仍由那条映射决定，留痕的
 *      成败不参与判断）。唯一观测面是 `log.warn`。
 *
 * 独立成文件而不是塞进 `scope-authority-pg.ts`：那边是写权威本体（advisory 锁 + 事务 + 错误
 * 映射），这边是「事务之外的一次追加写」，两者的失败语义正好相反（一个必须抛，一个必须吞）。
 * 放在一起，读者很容易以为留痕也在主事务里。
 */
import type { PoolClient } from 'pg';

import type { PgPool } from '../../db/pool.ts';

/**
 * 拒绝留痕的**唯一**写路径（迁移 0046）。五个形参全显式转型 —— 否则 PostgreSQL 会按 `unknown`
 * 选候选函数，0046 一旦出现重载就会落到别的签名上（与 `scope-authority-pg.ts` 里那两条同纪律）。
 * `p_audit_id` 有默认值 ⇒ **不传**，由函数内 `gen_random_uuid()` 生成：拒绝没有「调用方已知的
 * 审计 id」这回事，硬传一个反而是给调用方留了指定 id 的缝。
 */
export const RECORD_ADMIN_SCOPE_DENIAL_FUNCTION = 'public.record_admin_scope_denial';

export const RECORD_DENIAL_SQL = `SELECT public.record_admin_scope_denial(
  $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid
) AS audit_id`;

/**
 * SQLSTATE → `reason_code` 的**唯一**映射（闭集四值，与迁移 0046 的 `x_reason_allowed` 逐字同源；
 * `tests/unit/admin-scope-denial-wiring.test.mjs` 拿两侧清单对拍）。
 *
 * 表**外**的 SQLSTATE ⇒ **不留痕** —— 见文件头纪律 2：那不是「被拒」，是服务端缺陷。
 */
export const ADMIN_SCOPE_DENIAL_REASONS = Object.freeze({
  G0008: 'self_scope_grant_denied',
  G0009: 'last_scope_manager',
  G0010: 'scope_denied',
  G0011: 'scope_not_held',
} as const);

export type AdminScopeDenialSqlState = keyof typeof ADMIN_SCOPE_DENIAL_REASONS;

/**
 * 留痕行 `scope` 列的固定值。
 *
 * 口径来源：本片只处理**元权限域**（`scopes:write`）上的授予/撤销被拒，故 `p_scope` 写死为它，
 * ⛔ 不跟 `action.scope` 走 —— 被拒的那笔操作可能针对任意 scope，但「操作被拒」这件事的
 * 主题是元权限本身，且库层 `scope` 列取值更窄（13 项闭集）时才有意义。
 */
export const ADMIN_SCOPE_DENIAL_SCOPE = 'scopes:write';

/**
 * 装配层可注入的日志口（Fastify/pino 子集；只用到 `warn`）。与 `admin/ops/account-events.ts`
 * 的 `AccountEventLogPort` 同形 —— ⛔ 不在这里 `console.warn`：那会绕过结构化日志与脱敏。
 */
export interface AdminScopeDenialLogPort {
  warn(payload: Record<string, unknown>, message?: string): void;
}

/** 留痕只需要操作者、目标、请求 id 三样，其余字段（scope/reason/revision）不参与。 */
export interface AdminScopeDenialSubject {
  readonly actorId: string;
  readonly targetId: string;
  readonly requestId: string;
}

/** 从驱动错误里取 SQLSTATE（没有 `code` / 不是字符串 ⇒ 空串，不猜）。 */
export function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/** 取该 SQLSTATE 对应的拒绝理由码；表外取值 ⇒ `undefined`（⇒ 不留痕）。 */
export function denialReasonOf(sqlState: string): string | undefined {
  // `Object.hasOwn` 而不是 `in`：后者会把 `toString`/`constructor` 这类原型键判成命中。
  return Object.hasOwn(ADMIN_SCOPE_DENIAL_REASONS, sqlState)
    ? ADMIN_SCOPE_DENIAL_REASONS[sqlState as AdminScopeDenialSqlState]
    : undefined;
}

/**
 * 日志口只许「尽力而为」：`log.warn` **自身**抛错（logger 配置错、payload 序列化环、测试替身
 * 故意抛）不得穿透。这不是假想路径 —— 它是旁路唯一还能把 403/409 升成 500 的通道：`warn()`
 * 就在 `catch` 里，一旦外泄会顺着 `recordAdminScopeDenial` 冒到路由层，主响应被改写成 500。
 */
function warnQuietly(
  log: AdminScopeDenialLogPort | undefined,
  payload: Record<string, unknown>,
  message: string,
): void {
  if (log === undefined) return;
  try {
    log.warn(payload, message);
  } catch {
    // 连告警都发不出去时唯一正确的动作是静默：主响应（403/409）比一条日志重要。
  }
}

/**
 * 在**新连接**上补记一条拒绝留痕（迁移 0046 的唯一写入口）。
 *
 * 调用前提是调用方**已经**完成两件事：主事务 `ROLLBACK`、主连接 `release()`。因此这里的语句
 * 以**单条语句自提交**落库（⛔ 不包 `BEGIN`），与被回滚的那笔操作彻底解耦 —— 这正是「拒绝也
 * 留得住痕」的唯一可能形状（同一事务里写的行会跟着 `ROLLBACK` 一起没，见 `0041` 文件头）。
 *
 * 失败语义：**全吞**，只 `log.warn`。旁路写失败**不得**改变主响应（403/409 原样，绝不升 500）。
 * 返回 `void` 是刻意的：调用方拿不到「留痕成没成」这个信号，就不可能让主响应依赖它。
 *
 * 「全吞」是**结构性**的，不是靠内部每一处都记得加 try：本入口把整段实现包在 `try` 里，
 * 将来谁往 `writeAdminScopeDenial` 里加一行会抛的代码，也越不过这道边界。
 */
export async function recordAdminScopeDenial(args: {
  pool: PgPool;
  subject: AdminScopeDenialSubject;
  sqlState: string;
  log?: AdminScopeDenialLogPort;
}): Promise<void> {
  try {
    await writeAdminScopeDenial(args);
  } catch {
    // 兜底：留痕这一步的任何异常到此为止（不变量：旁路写失败不得改变主响应）。
  }
}

async function writeAdminScopeDenial({
  pool,
  subject,
  sqlState,
  log,
}: {
  pool: PgPool;
  subject: AdminScopeDenialSubject;
  sqlState: string;
  log?: AdminScopeDenialLogPort;
}): Promise<void> {
  const reasonCode = denialReasonOf(sqlState);
  // 表外 SQLSTATE（`XX000`/`42501`/断连…）⇒ 那不是「被拒」，一行都不写（纪律 2）。
  if (reasonCode === undefined) return;
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query(RECORD_DENIAL_SQL, [
      subject.actorId,
      subject.targetId,
      ADMIN_SCOPE_DENIAL_SCOPE,
      reasonCode,
      subject.requestId,
    ]);
  } catch (error) {
    // 只记 SQLSTATE 与拒绝口径，⛔ 不记驱动 message（可能带 SQL 上下文/连接串片段）。
    warnQuietly(
      log,
      {
        sqlstate: sqlState,
        reason_code: reasonCode,
        actor_id: subject.actorId,
        target_id: subject.targetId,
        request_id: subject.requestId,
        denial_error_sqlstate: sqlStateOf(error),
      },
      '后台 scope 操作被拒后的留痕未落库（旁路失败：主响应不变，403/409 原样返回）',
    );
  } finally {
    // `release()` 也可能抛（连接已被池回收/重复释放）⇒ 同样不许外泄到主响应。
    try {
      client?.release();
    } catch {
      // 释放失败只影响这条连接的归还，主响应与留痕结果都不该受它牵连。
    }
  }
}

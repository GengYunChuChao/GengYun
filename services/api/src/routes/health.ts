/**
 * 运营健康检查路由。不属于业务契约（packages/contracts/openapi.json 只描述 /api/v1 业务接口）。
 * 响应含契约 meta，便于监控区分执行模式。
 */
import type { FastifyInstance } from 'fastify';
import { CONTRACT_VERSION } from '../contract.ts';
import type { AppConfig } from '../config.ts';
import { checkDatabase, type PgPool } from '../db/pool.ts';

export function registerHealthRoutes(app: FastifyInstance, config: AppConfig, pool: PgPool | null): void {
  app.get('/health', async (request, reply) => {
    const database = await checkDatabase(pool, config.databaseHealthTimeoutMs);
    // real 模式下未配置数据库属于降级；stub/preset_demo 下未配置数据库是预期状态。
    const databaseOk = database.status === 'ok' || (!config.requiresRealCredentials && database.status === 'not_configured');
    const status = databaseOk ? 'ok' : 'degraded';

    return reply.status(status === 'ok' ? 200 : 503).send({
      status,
      checks: {
        api: { status: 'ok' },
        database,
      },
      meta: {
        request_id: request.id,
        contract_version: CONTRACT_VERSION,
        execution_mode: config.executionMode,
      },
      uptime_s: Math.round(process.uptime()),
    });
  });
}

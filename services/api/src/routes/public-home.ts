import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.ts';
import { CONTRACT_VERSION } from '../contract.ts';
import type { PgPool } from '../db/pool.ts';
import { readHomePreviews } from '../db/catalog.ts';

/** Existing contract's guest preview only. No authenticated knowledge/detail route. */
export function registerPublicHomeRoute(app: FastifyInstance, config: AppConfig, pool: PgPool | null): void {
  app.get('/api/v1/public/home', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const previews = await readHomePreviews(pool, config.executionMode);
    return {
      data: { previews, human_review_state: 'under_construction' },
      meta: { request_id: request.id, contract_version: CONTRACT_VERSION, execution_mode: config.executionMode },
    };
  });
}

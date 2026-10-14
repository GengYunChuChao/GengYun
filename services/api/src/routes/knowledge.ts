import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { PgPool } from '../db/pool.ts';
import { currentIdentity, type AuthGuards } from '../auth/middleware.ts';
import { readBearerToken } from '../auth/tokens.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { createKnowledgeService, type KnowledgeQuery } from '../knowledge/service.ts';
import { createReferenceQueryService } from '../knowledge/reference-query.ts';
import { buildMeta } from './support.ts';

export function registerKnowledgeRoutes(app: FastifyInstance,config: AppConfig,pool: PgPool|null,guards: AuthGuards): void {
  // GY-I07（#7）装配点。
  //
  // `/herbicides`、`/herbicides/{id}`：领域逻辑与数据来自已合入的 `packages/reference`
  // 适配层（真实公告附表记录；制剂身份 = 登记号 + 剂型/成分含量哈希，
  // **不按模糊药名合并不同含量剂型**）。
  //
  // `/knowledge` 的浙江首批真实资料：**默认关闭**，需要两道闸同时放行 ——
  //   1) 执行模式非 `real`（real 模式只返回已核对 + 已发布的数据库投影，
  //      绝不把未核对/未发布资料提升为权威来源）；
  //   2) 显式接线开关 `APP_KNOWLEDGE_UNVERIFIED_SEED`（取值 `1` / `true`）。
  // 之所以要显式开关：这批条目 `visibility='private'`（未发布）+ `review_status='unverified'`，
  // 让未发布内容进入用户查询面必须是一次**可审查的接线决定**，而不是默认发生的事；
  // 这与仓库既有口径一致（`v_queryable_seed_version` 仅供 stub 联调，消费方必须标注未核对）。
  // 逐条仍以 `SourceRef.review_status='unverified'` 如实呈现（见 knowledge/reference-query.ts）。
  const unverifiedSeedEnabled = /^(1|true)$/i.test(process.env['APP_KNOWLEDGE_UNVERIFIED_SEED'] ?? '');
  const reference = createReferenceQueryService({
    includeUnverifiedSeed: config.executionMode !== 'real' && unverifiedSeedEnabled,
  });
  const service = pool === null ? null : createKnowledgeService(pool,config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
    {extraRows: () => reference.seedRows()});
  const text = {type:'string',minLength:1,maxLength:80};
  const filters = {crop_id:text,region_code:{type:'string',pattern:'^33[0-9]{4}$'},species_id:text,growth_stage:text,planting_method:text,use_scene:text};
  const pagination = {cursor:{type:'string',minLength:1,maxLength:2048},limit:{type:'integer',minimum:1,maximum:50,default:20}};
  function input(request: FastifyRequest) {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) throw new ApiError('SESSION_REQUIRED','需要用户会话');
    return {identity:currentIdentity(request),token};
  }
  function ready() {
    if (!service) throw new ApiError('PROVIDER_UNAVAILABLE','资料数据库尚未配置');
    return service;
  }
  function queryOf(request: FastifyRequest): Record<string, unknown> {
    return { ...(request.query as Record<string, unknown>) };
  }
  app.get(`${API_PREFIX}/knowledge`,{preHandler:guards.requireUser,schema:{querystring:{type:'object',additionalProperties:false,properties:{...filters,
    q:text,...pagination}}}},async(request,reply)=>{
    const data = await ready().list(input(request),request.query as KnowledgeQuery);
    return reply.header('Cache-Control','no-store').send({data,meta:buildMeta(request,config)});
  });
  app.get(`${API_PREFIX}/knowledge/:id`,{preHandler:guards.requireUser,schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}},
    querystring:{type:'object',additionalProperties:false,properties:filters}}},async(request,reply)=>{
    const data = await ready().get(input(request),(request.params as {id:string}).id,request.query as KnowledgeQuery) as {revision:number};
    return reply.header('Cache-Control','no-store').header('ETag',`"${data.revision}"`).send({data,meta:buildMeta(request,config)});
  });
  // 契约 /herbicides：仅 q 与 registration_number 两个收窄条件（无额外字段）。
  app.get(`${API_PREFIX}/herbicides`,{preHandler:guards.requireUser,schema:{querystring:{type:'object',additionalProperties:false,
    properties:{q:text,registration_number:text,...pagination}}}},async(request,reply)=>{
    const {data} = reference.listHerbicides(queryOf(request));
    // 契约 200 头说明：授权访问 no-store；列表不带 ETag（与 /knowledge 列表一致）。
    return reply.header('Cache-Control','no-store').send({data,meta:buildMeta(request,config)});
  });
  app.get(`${API_PREFIX}/herbicides/:id`,{preHandler:guards.requireUser,schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}},
    querystring:{type:'object',additionalProperties:false,properties:{}}}},async(request,reply)=>{
    const {data,etag} = reference.getHerbicide((request.params as {id:string}).id,queryOf(request));
    const headers = reply.header('Cache-Control','no-store');
    if (etag !== undefined) headers.header('ETag',etag);
    return headers.send({data,meta:buildMeta(request,config)});
  });
}

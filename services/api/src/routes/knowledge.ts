import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { PgPool } from '../db/pool.ts';
import { currentIdentity, type AuthGuards } from '../auth/middleware.ts';
import { readBearerToken } from '../auth/tokens.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { createKnowledgeService, type KnowledgeQuery } from '../knowledge/service.ts';
import { buildMeta } from './support.ts';

export function registerKnowledgeRoutes(app: FastifyInstance,config: AppConfig,pool: PgPool|null,guards: AuthGuards): void {
  const service = pool === null ? null : createKnowledgeService(pool,config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY);
  const text = {type:'string',minLength:1,maxLength:80};
  const filters = {crop_id:text,region_code:{type:'string',pattern:'^33[0-9]{4}$'},species_id:text,growth_stage:text,planting_method:text,use_scene:text};
  function input(request: FastifyRequest) {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) throw new ApiError('SESSION_REQUIRED','需要用户会话');
    return {identity:currentIdentity(request),token};
  }
  function ready() {
    if (!service) throw new ApiError('PROVIDER_UNAVAILABLE','资料数据库尚未配置');
    return service;
  }
  app.get(`${API_PREFIX}/knowledge`,{preHandler:guards.requireUser,schema:{querystring:{type:'object',additionalProperties:false,properties:{...filters,
    q:text,cursor:{type:'string',minLength:1,maxLength:2048},limit:{type:'integer',minimum:1,maximum:50,default:20}}}}},async(request,reply)=>{
    const data = await ready().list(input(request),request.query as KnowledgeQuery);
    return reply.header('Cache-Control','no-store').send({data,meta:buildMeta(request,config)});
  });
  app.get(`${API_PREFIX}/knowledge/:id`,{preHandler:guards.requireUser,schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}},
    querystring:{type:'object',additionalProperties:false,properties:filters}}},async(request,reply)=>{
    const data = await ready().get(input(request),(request.params as {id:string}).id,request.query as KnowledgeQuery) as {revision:number};
    return reply.header('Cache-Control','no-store').header('ETag',`"${data.revision}"`).send({data,meta:buildMeta(request,config)});
  });
}

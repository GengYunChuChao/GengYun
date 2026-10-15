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
import { decidePublicVisibility, type ReferenceResolver } from '../knowledge/public-invalidation.ts';
import { buildMeta } from './support.ts';

/**
 * GY-I07 第二片 · **公开读路由的接线依赖**（`Refs #7`；跨线 `Refs #18`）。
 *
 * **纯追加**：不传任何依赖时（`{}` / 省略）与接线前**逐字节同行为** —— 不判定 ⇒
 * 详情面照旧可见，既有装配点（`app.ts:852`）与既有回归不需要同步改动。
 */
export interface KnowledgeRouteDeps {
  /**
   * 既有「读取时重算」解析器：`createReferenceIntegrity(store).resolve`
   * （`admin/reference-integrity.ts`）。本片**只消费不改写**它的结论。
   *
   * 缺省 `undefined` ⇒ 详情面不判定（接线前行为）。
   */
  resolve?: ReferenceResolver;
}

/**
 * 「与不存在**逐字节同形**」的 404 文案。
 *
 * 刻意与两条既有「查不到」路径的文案**保持一字不差**，因为只要码/文案/`details` 任一不同，
 * 攻击者就能用状态差异判断「这条内容存在但被引用失效拦掉了」：
 *   - `/knowledge/{id}`：`knowledge/service.ts` 的空结果分支 `throw new ApiError('NOT_FOUND','资料不可用')`；
 *   - `/herbicides/{id}`：`packages/reference` 的 `NOT_FOUND`（`未找到该除草剂记录`），
 *     经 `reference-query.ts#rethrowDomainError` 原样转发。
 * 回归用例对两条路径的 404 响应做**逐字节**比对（仅 `meta.request_id` 不同）。
 */
const NOT_FOUND_MESSAGE = Object.freeze({
  knowledge: '资料不可用',
  herbicide: '未找到该除草剂记录',
});

/**
 * 从**响应投影**里还原判定输入：既有 `source_id` / `source_version`。
 *
 * `decidePublicVisibility` 的判定只读这两个字段（见 `knowledge/public-invalidation.ts`），
 * 而投影把它们放在契约既有的 `source.id` / `source.version` 上，故这里只做一次等价还原，
 * **不新增字段名**。投影里读不到可用引用（缺 `source` 或不是字符串）时返回 `null`
 * ⇒ 调用方**不判定**（保持可见）：投影缺字段说明"核不到"，而"核不到"**不得**被当成"已失效"。
 */
function sourceReferenceOf(data: unknown): { source_id: string; source_version: string } | null {
  if (data === null || typeof data !== 'object') return null;
  const source = (data as { source?: unknown }).source;
  if (source === null || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  const id = record['id'];
  const version = record['version'];
  if (typeof id !== 'string' || id === '' || typeof version !== 'string' || version === '') return null;
  return { source_id: id, source_version: version };
}

/**
 * 详情面的公开读判定（本片唯一的新增拦截点）。
 *
 * | `resolve()` 结论 | 详情面 |
 * |---|---|
 * | `unavailable` | 抛**同形** 404（与"不存在"同响应，不泄露存在性） |
 * | `available` | 正常返回 |
 * | `unverifiable` | **正常返回**（未接真实库核不到 ⇒ 不谎称失效，生产默认行为不变） |
 *
 * 判定是**每次请求重算**的纯函数，不缓存、不落"失效标记"，因此失效前的缓存副本与旧 ETag
 * 不会让内容复活（响应恒 `Cache-Control: no-store`，且本函数在写响应头之前抛出）。
 */
function assertPubliclyVisible(
  resolve: ReferenceResolver,
  family: 'knowledge',
  data: unknown,
  message: string,
): void {
  const content = sourceReferenceOf(data);
  // 投影还原不出引用 ⇒ 不判定（核不到 ≠ 失效）。
  if (content === null) return;
  if (decidePublicVisibility({ family, content, resolve }).visible) return;
  throw new ApiError('NOT_FOUND', message);
}

export function registerKnowledgeRoutes(app: FastifyInstance,config: AppConfig,pool: PgPool|null,guards: AuthGuards,deps: KnowledgeRouteDeps = {}): void {
  // GY-I07 第二片 · 公开读「引用失效」判定接线（`Refs #7`；跨线 `Refs #18`）。
  //
  // 只接线**详情面**（`/knowledge/{id}`、`/herbicides/{id}`）：判定走既有
  // `createReferenceIntegrity(store).resolve`（由装配点注入，本文件不导入实现），
  // `unavailable ⇒ 同形 404`、`unverifiable ⇒ 保持可见`。
  // **列表面本片刻意不改**（理由、影响面与回退方式见 PR 正文"跨线"一节）。
  const resolveReference = deps.resolve;
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
    // 本片接线：引用失效 ⇒ 抛在写响应头**之前**，故失败响应不带 ETag，旧 ETag/条件请求无从复活。
    if (resolveReference !== undefined) assertPubliclyVisible(resolveReference,'knowledge',data,NOT_FOUND_MESSAGE.knowledge);
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
    // 本片接线：与 `/knowledge/{id}` 同一判定、同形 404（文案与该域既有"查不到"一致）。
    if (resolveReference !== undefined) assertPubliclyVisible(resolveReference,'knowledge',data,NOT_FOUND_MESSAGE.herbicide);
    const headers = reply.header('Cache-Control','no-store');
    if (etag !== undefined) headers.header('ETag',etag);
    return headers.send({data,meta:buildMeta(request,config)});
  });
}

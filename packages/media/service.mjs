/**
 * GY-I06 私有媒体模块 · 服务（生命周期 + 访问控制 + 孤立对象清理）。
 *
 * 覆盖冻结契约（packages/contracts/openapi.json）：
 *   POST /media/uploads                 createUpload
 *   POST /media/uploads/{id}/complete   completeUpload
 *   GET  /media/{id}                    getMedia
 *   DELETE /media/{id}                  deleteMedia
 *   POST /media/{id}/access             grantMediaAccess
 *   POST /community/media-access        grantCommunityMediaAccess
 *   GET  /community/media/{grant_id}/content  readCommunityMediaContent
 *
 * 状态机（state-contract）：initiated → uploaded → processing → ready；
 *   任一非删除状态可 rejected 或 deleting → deleted。
 *
 * 会话/归属（GY-I04 未合并）：本模块**不实现登录**。身份由调用方（会话层）注入
 *   `{ ownerId, authEpoch }`；未注入即视为未认证（401 SESSION_REQUIRED）。
 *   这是**明确标注的替身边界**——真实微信登录态由 GY-I04(#4)/#49 合并后接线。
 *
 * 孤立清理：initiated 超过 24h 未完成 → rejected('expired') 并回收对象；
 *   rejected / deleted 记录的对象与句柄统一清理。
 */
import { randomUUID } from 'node:crypto';
import { MediaError } from './errors.mjs';
import {
  MEDIA_ACCESS_TTL_MS,
  MEDIA_INITIATED_TTL_MS,
  COMMUNITY_MAX_IMAGES_PER_POST,
  kindOf,
  canTransition,
} from './constants.mjs';
import { createPrivateObjectStore } from './store.mjs';
import { createAccessTokenFactory } from './tokens.mjs';
import {
  validateUploadInput,
  validateCompleteInput,
  assertBytesMatchDeclaration,
  sha256Hex,
} from './validate.mjs';
import { stripImageMetadata } from './exif.mjs';
import { redactForLog } from '../privacy/redact.mjs';

/** 默认内容提供者：**默认关闭**（未注入即视为无公开内容），避免误放行社区取图。 */
function nullContentProvider() {
  return { getPublishedContent() { return null; } };
}

function requireSession(actor) {
  if (!actor || typeof actor.ownerId !== 'string' || actor.ownerId.length === 0) {
    throw new MediaError('SESSION_REQUIRED', '缺少登录会话');
  }
}

function requireIdempotencyKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new MediaError('IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key');
  }
}

/** 解析 If-Match（契约：缺失 428，不匹配 409）。 */
function requireIfMatch(ifMatch, currentRevision) {
  if (ifMatch === undefined || ifMatch === null || ifMatch === '') {
    throw new MediaError('REVISION_REQUIRED', '缺少 If-Match 版本头');
  }
  const parsed = Number(String(ifMatch).replaceAll('"', ''));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new MediaError('INVALID_REQUEST', 'If-Match 版本非法');
  }
  if (parsed !== currentRevision) {
    throw new MediaError('REVISION_CONFLICT', 'If-Match 版本与当前版本不一致');
  }
  return parsed;
}

/**
 * 创建媒体服务。
 * @param {{
 *   tokenSecret: string,
 *   store?: ReturnType<typeof createPrivateObjectStore>,
 *   tokenFactory?: ReturnType<typeof createAccessTokenFactory>,
 *   clock?: () => number,
 *   idFactory?: () => string,
 *   contentProvider?: { getPublishedContent: Function },
 *   logger?: (event: object) => void,
 * }} options
 */
export function createMediaService(options = {}) {
  const {
    tokenSecret,
    store = createPrivateObjectStore(),
    tokenFactory = createAccessTokenFactory(tokenSecret),
    clock = () => Date.now(),
    idFactory = () => randomUUID(),
    contentProvider = nullContentProvider(),
    logger = () => {},
  } = options;

  const records = new Map(); // mediaId -> record
  const idempotency = new Map(); // `${ownerId}:${key}` -> { requestHash, mediaId }
  const grants = new Map(); // grantId -> community grant record

  const expiresIso = (ms) => new Date(ms).toISOString();

  /** 公开投影：只含契约 Media 字段，绝不含 object_ref / owner / 桶路径。 */
  function toMedia(record) {
    return {
      id: record.id,
      revision: record.revision,
      purpose: record.purpose,
      mime: record.mime,
      bytes: record.bytes,
      duration_ms: record.duration_ms,
      state: record.state,
      sha256: record.sha256,
      failure_code: record.failure_code,
    };
  }

  /** 日志安全视图：经 packages/privacy/redact.mjs 脱敏，不含私有媒体/引用。 */
  function logSafe(event) {
    return redactForLog(event);
  }

  function transition(record, to, at) {
    if (!canTransition(record.state, to)) {
      throw new MediaError('OBJECT_UNAVAILABLE', `非法状态迁移 ${record.state} → ${to}`);
    }
    record.state = to;
    record.updatedAt = at;
  }

  function dropObjects(record) {
    let removed = 0;
    for (const ref of [record.rawRef, record.derivativeRef]) {
      if (ref && store.has(ref)) {
        store.delete(ref);
        removed += 1;
      }
    }
    record.rawRef = null;
    record.derivativeRef = null;
    return removed;
  }

  function revokeGrantsForMedia(mediaId, at) {
    let n = 0;
    for (const grant of grants.values()) {
      if (grant.mediaId === mediaId && grant.revokedAt === null) {
        grant.revokedAt = at;
        n += 1;
      }
    }
    return n;
  }

  function requestHashOf(input) {
    return sha256Hex(Buffer.from(JSON.stringify(input), 'utf8'));
  }

  // ---------------------------------------------------------------- 生命周期

  function initiateUpload({ ownerId, authEpoch = 0, input, idempotencyKey, mediaCountForPost = 0 }) {
    requireSession({ ownerId });
    requireIdempotencyKey(idempotencyKey);
    const key = `${ownerId}:${idempotencyKey}`;
    const requestHash = requestHashOf(input);
    const prior = idempotency.get(key);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new MediaError('IDEMPOTENCY_CONFLICT', '同一幂等键携带了不同内容');
      }
      const record = records.get(prior.mediaId);
      return issueUploadGrant(record, authEpoch);
    }

    const declared = validateUploadInput(input, { mediaCountForPost });
    const at = clock();
    const record = {
      id: idFactory(),
      ownerId,
      revision: 1,
      purpose: declared.purpose,
      mime: declared.mime,
      bytes: declared.bytes,
      duration_ms: declared.duration_ms,
      sha256: declared.sha256,
      state: 'initiated',
      failure_code: null,
      rawRef: null,
      derivativeRef: null,
      metadata_removed: [],
      consentEpoch: 0,
      createdAt: at,
      updatedAt: at,
      /** 初始化 24h 未完成可回收。 */
      expiresAt: at + MEDIA_INITIATED_TTL_MS,
    };
    records.set(record.id, record);
    idempotency.set(key, { requestHash, mediaId: record.id });
    logger(logSafe({ evt: 'media.initiate', id: record.id, purpose: record.purpose, state: record.state }));
    return issueUploadGrant(record, authEpoch);
  }

  function issueUploadGrant(record, authEpoch) {
    const token = tokenFactory.issue({
      kind: 'upload',
      mediaId: record.id,
      revision: record.revision,
      ownerId: record.ownerId,
      authEpoch,
      exp: record.expiresAt,
    });
    return {
      media: toMedia(record),
      upload: {
        url: `https://media.gengyun.local/api/v1/media/uploads/${record.id}/content`,
        expires_at: expiresIso(record.expiresAt),
        method: 'PUT',
        access_token: token,
      },
    };
  }

  function completeUpload({ ownerId, mediaId, ifMatch, input, body, idempotencyKey }) {
    requireSession({ ownerId });
    requireIdempotencyKey(idempotencyKey);
    const record = records.get(mediaId);
    // 非本人 / 不存在统一 404，不泄露存在性。
    if (!record || record.ownerId !== ownerId) {
      throw new MediaError('NOT_FOUND', '媒体不存在');
    }
    requireIfMatch(ifMatch, record.revision);

    const declared = validateCompleteInput(input);
    if (declared.sha256 !== record.sha256 || declared.bytes !== record.bytes) {
      throw new MediaError('INVALID_REQUEST', '完成上传声明与初始化声明不一致');
    }

    // 幂等：已完成且声明一致 -> 直接回放。
    if (record.state === 'ready') {
      return toMedia(record);
    }
    if (record.state !== 'initiated' && record.state !== 'uploaded') {
      throw new MediaError('OBJECT_UNAVAILABLE', `当前状态不可完成上传：${record.state}`);
    }

    const detected = assertBytesMatchDeclaration({
      bytes: body,
      declared: { mime: record.mime, bytes: record.bytes, sha256: record.sha256, purpose: record.purpose },
    });

    const at = clock();
    transition(record, 'uploaded', at);
    record.rawRef = store.put(body, detected.mime);

    if (kindOf(record.purpose) === 'image') {
      const stripped = stripImageMetadata(body, detected.mime);
      if (!stripped.ok) {
        transition(record, 'rejected', at);
        record.failure_code = 'decode_failed';
        dropObjects(record);
        throw new MediaError('MEDIA_TYPE_UNSUPPORTED', '图片解码失败，无法去除元数据');
      }
      transition(record, 'processing', at);
      // 仅对外提供去元数据后的受控衍生件；原始对象保留为私有参考。
      record.derivativeRef = store.put(stripped.data, detected.mime);
      record.metadata_removed = stripped.removed;
      transition(record, 'ready', at);
    } else {
      transition(record, 'processing', at);
      transition(record, 'ready', at);
    }
    record.revision += 1;
    logger(logSafe({ evt: 'media.complete', id: record.id, state: record.state, removed: record.metadata_removed.length }));
    return toMedia(record);
  }

  function getMedia({ ownerId, mediaId }) {
    requireSession({ ownerId });
    const record = records.get(mediaId);
    if (!record || record.ownerId !== ownerId) {
      throw new MediaError('NOT_FOUND', '媒体不存在');
    }
    return toMedia(record);
  }

  function deleteMedia({ ownerId, mediaId, ifMatch }) {
    requireSession({ ownerId });
    const record = records.get(mediaId);
    if (!record || record.ownerId !== ownerId) {
      throw new MediaError('NOT_FOUND', '媒体不存在');
    }
    if (record.state === 'deleted') return { id: record.id, revision: record.revision, deleted: true };
    requireIfMatch(ifMatch, record.revision);
    const at = clock();
    if (record.state !== 'deleting') transition(record, 'deleting', at);
    const removed = dropObjects(record);
    transition(record, 'deleted', at);
    revokeGrantsForMedia(record.id, at);
    record.revision += 1;
    logger(logSafe({ evt: 'media.delete', id: record.id, removed_objects: removed }));
    return { id: record.id, revision: record.revision, deleted: true };
  }

  // ------------------------------------------------- 私有 owner 访问（仅 owner）

  function grantOwnerAccess({ ownerId, mediaId, ifMatch }) {
    requireSession({ ownerId });
    const record = records.get(mediaId);
    if (!record || record.ownerId !== ownerId) {
      throw new MediaError('NOT_FOUND', '媒体不存在');
    }
    requireIfMatch(ifMatch, record.revision);
    if (record.state !== 'ready') {
      throw new MediaError('OBJECT_UNAVAILABLE', '媒体尚未就绪');
    }
    const exp = clock() + MEDIA_ACCESS_TTL_MS;
    const token = tokenFactory.issue({
      kind: 'owner_read',
      mediaId: record.id,
      revision: record.revision,
      ownerId,
      exp,
    });
    return {
      url: `https://media.gengyun.local/api/v1/media/${record.id}/content`,
      expires_at: expiresIso(exp),
      method: 'GET',
      access_token: token,
    };
  }

  function readOwnerContent({ ownerId, mediaId, token }) {
    requireSession({ ownerId });
    const record = records.get(mediaId);
    if (!record || record.ownerId !== ownerId || record.state !== 'ready') {
      throw new MediaError('NOT_FOUND', '媒体不存在');
    }
    const payload = tokenFactory.verify(token);
    if (!payload || payload.kind !== 'owner_read' || payload.mediaId !== mediaId || payload.ownerId !== ownerId) {
      throw new MediaError('NOT_FOUND', '媒体不存在');
    }
    if (payload.exp < clock() || payload.revision !== record.revision) {
      throw new MediaError('NOT_FOUND', '媒体不存在');
    }
    const ref = kindOf(record.purpose) === 'image' ? record.derivativeRef : record.rawRef;
    const bytes = ref ? store.get(ref) : null;
    if (!bytes) throw new MediaError('NOT_FOUND', '媒体不存在');
    return { bytes, contentType: record.mime };
  }

  // --------------------------------------------- 社区公开取图（带内容上下文）

  function grantCommunityAccess({ requesterId, requesterAuthEpoch = 0, sessionRef, input }) {
    requireSession({ ownerId: requesterId });
    const { content_ref: contentRef, media_ref: mediaRef, slot, author_revision: authorRevision } = input ?? {};
    if (!contentRef || !mediaRef || (slot !== 'attachment' && slot !== 'author_avatar')) {
      throw new MediaError('INVALID_REQUEST', '社区取图请求结构非法');
    }
    const content = contentProvider.getPublishedContent({
      type: contentRef.type,
      id: contentRef.id,
      revision: contentRef.revision,
    });
    // 不存在 / 非公开 / 未审核 / 版本不符 -> 统一 404。
    if (!content || !content.published || !content.approved || content.revision !== contentRef.revision) {
      throw new MediaError('NOT_FOUND', '公开内容不存在');
    }

    const record = records.get(mediaRef.media_id);
    if (!record || record.state !== 'ready' || record.purpose !== 'community_image') {
      throw new MediaError('NOT_FOUND', '公开内容不存在');
    }

    if (slot === 'attachment') {
      const authorized = (content.media ?? []).some(
        (m) => m.mediaId === mediaRef.media_id && m.mediaRevision === mediaRef.media_revision,
      );
      if (!authorized || record.revision !== mediaRef.media_revision) {
        throw new MediaError('NOT_FOUND', '公开内容不存在');
      }
    } else {
      const avatar = content.avatarMedia;
      if (
        !avatar ||
        avatar.mediaId !== mediaRef.media_id ||
        avatar.mediaRevision !== mediaRef.media_revision ||
        authorRevision !== content.authorRevision ||
        record.revision !== mediaRef.media_revision
      ) {
        throw new MediaError('NOT_FOUND', '公开内容不存在');
      }
    }

    const at = clock();
    const exp = at + MEDIA_ACCESS_TTL_MS;
    const grantId = idFactory();
    const token = tokenFactory.issue({
      kind: 'community_read',
      grantId,
      mediaId: record.id,
      revision: record.revision,
      requesterId,
      sessionRef,
      exp,
    });
    grants.set(grantId, {
      grantId,
      tokenHash: tokenFactory.hash(token),
      requesterId,
      sessionRef,
      requesterAuthEpoch,
      mediaId: record.id,
      mediaRevision: record.revision,
      contentRef: { ...contentRef },
      slot,
      authorRevision: slot === 'author_avatar' ? content.authorRevision : null,
      expiresAt: exp,
      revokedAt: null,
    });
    logger(logSafe({ evt: 'media.community_grant', grant_id: grantId, media_id: record.id, slot }));
    return {
      grant_id: grantId,
      content_ref: { ...contentRef },
      media_ref: { media_id: record.id, media_revision: record.revision },
      slot,
      author_revision: slot === 'author_avatar' ? content.authorRevision : null,
      access: {
        url: `https://media.gengyun.local/api/v1/community/media/${grantId}/content`,
        expires_at: expiresIso(exp),
        method: 'GET',
        access_token: token,
      },
    };
  }

  function readCommunityContent({ grantId, token, requesterId, sessionRef, authEpoch }) {
    requireSession({ ownerId: requesterId });
    const grant = grants.get(grantId);
    if (!grant) throw new MediaError('NOT_FOUND', '授权不存在');
    if (grant.tokenHash !== tokenFactory.hash(token)) throw new MediaError('NOT_FOUND', '授权不存在');
    // 会话失效（登录态不再有效）-> 401；其余版本/授权变化 -> 404（即使未到期也拒绝）。
    if (grant.requesterId !== requesterId || grant.sessionRef !== sessionRef) {
      throw new MediaError('SESSION_EXPIRED', '会话已失效');
    }
    if (grant.requesterAuthEpoch !== authEpoch) {
      throw new MediaError('SESSION_EXPIRED', '会话已失效');
    }
    if (grant.revokedAt !== null || grant.expiresAt < clock()) {
      throw new MediaError('NOT_FOUND', '授权不存在');
    }
    const record = records.get(grant.mediaId);
    if (!record || record.state !== 'ready' || record.purpose !== 'community_image' || record.revision !== grant.mediaRevision) {
      throw new MediaError('NOT_FOUND', '授权不存在');
    }
    const content = contentProvider.getPublishedContent({
      type: grant.contentRef.type,
      id: grant.contentRef.id,
      revision: grant.contentRef.revision,
    });
    if (!content || !content.published || !content.approved || content.revision !== grant.contentRef.revision) {
      throw new MediaError('NOT_FOUND', '授权不存在');
    }
    if (grant.slot === 'author_avatar' && content.authorRevision !== grant.authorRevision) {
      throw new MediaError('NOT_FOUND', '授权不存在');
    }
    const bytes = record.derivativeRef ? store.get(record.derivativeRef) : null;
    if (!bytes) throw new MediaError('NOT_FOUND', '授权不存在');
    return { bytes, contentType: record.mime };
  }

  // ------------------------------------------------------------ 过期与清理

  /** 回收初始化超时记录（24h）：initiated → rejected('expired') 并删除已存对象。 */
  function expireInitiated({ now = clock() } = {}) {
    let expired = 0;
    for (const record of records.values()) {
      if (record.state === 'initiated' && record.expiresAt <= now) {
        record.state = 'rejected';
        record.failure_code = 'expired';
        record.updatedAt = now;
        dropObjects(record);
        expired += 1;
      }
    }
    if (expired) logger(logSafe({ evt: 'media.expire_initiated', count: expired }));
    return { expired };
  }

  /** 清理孤立对象：rejected / deleted 记录的对象与句柄统一回收。 */
  function cleanupOrphans() {
    const at = clock();
    let removedObjects = 0;
    let removedGrants = 0;
    for (const record of records.values()) {
      if (record.state === 'rejected' || record.state === 'deleted') {
        removedObjects += dropObjects(record);
        removedGrants += revokeGrantsForMedia(record.id, at);
      }
    }
    for (const [grantId, grant] of grants) {
      if (grant.expiresAt < at || grant.revokedAt !== null) {
        grants.delete(grantId);
      }
    }
    return { removedObjects, removedGrants };
  }

  /** 统计（供测试/诊断；不含私有引用）。 */
  function stats() {
    return { mediaCount: records.size, objectCount: store.size, grantCount: grants.size };
  }

  return {
    // 生命周期
    initiateUpload,
    completeUpload,
    getMedia,
    deleteMedia,
    // 私有访问
    grantOwnerAccess,
    readOwnerContent,
    // 社区访问
    grantCommunityAccess,
    readCommunityContent,
    // 维护
    expireInitiated,
    cleanupOrphans,
    stats,
    // 常量导出便于调用方校验
    COMMUNITY_MAX_IMAGES_PER_POST,
    toMedia,
  };
}

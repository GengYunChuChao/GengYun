import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_VERSION,
  MEDIA_PURPOSES,
  MEDIA_STATES,
  MEDIA_PURPOSE_MIME,
  MEDIA_PURPOSE_MAX_BYTES,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_DURATION_MS,
  MEDIA_ACCESS_TTL_MS,
  COMMUNITY_MAX_IMAGES_PER_POST,
  ERROR_STATUS_MAP,
  statusForErrorCode,
  isErrorCode,
  canTransition,
} from '../../packages/media/constants.mjs';
import { createMediaService } from '../../packages/media/service.mjs';

const states = JSON.parse(readFileSync(new URL('../../packages/contracts/states.json', import.meta.url), 'utf8'));
const openapi = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const S = openapi.components.schemas;

test('contract_version 与 states.json 一致', () => {
  assert.equal(CONTRACT_VERSION, states.contract_version);
});

test('MediaPurpose / MediaState 与 states.json 逐一一致', () => {
  assert.deepEqual(MEDIA_PURPOSES, states.states.MediaPurpose);
  assert.deepEqual(MEDIA_STATES, states.states.MediaState);
});

test('error_status_map 与 states.json 双向一致（档位集合与码表都必须相等）', () => {
  // 档位集合先钉：双向遍历仍可能被「两侧同时少同一档」骗过；而集合断言若放在遍历之后，
  // 会被「先红的那一轮」挡成不可达（写了永远不响）—— 所以它必须在两个遍历之前判。
  // 消息里点名缺/多了哪几档：只说「集合必须相等」时，读测试的人还得自己 diff 才看得出是 500。
  const mirrorStatuses = Object.keys(ERROR_STATUS_MAP).map(Number).sort((a, b) => a - b);
  const contractStatuses = Object.keys(states.error_status_map).map(Number).sort((a, b) => a - b);
  const missingInMirror = contractStatuses.filter((s) => !mirrorStatuses.includes(s));
  const extraInMirror = mirrorStatuses.filter((s) => !contractStatuses.includes(s));
  assert.deepEqual(
    mirrorStatuses,
    contractStatuses,
    `镜像与契约的档位集合必须相等（镜像缺档：[${missingInMirror.join(', ')}]；镜像多档：[${extraInMirror.join(', ')}]）`,
  );
  // 方向一：states → 镜像。契约里有的档，镜像必须逐项相同。
  // 缺档时先点名再比：否则 `[...undefined]` 只会抛
  // `TypeError: ERROR_STATUS_MAP[status] is not iterable`，只报行号、不报缺的是哪一档。
  for (const [status, codes] of Object.entries(states.error_status_map)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ERROR_STATUS_MAP, status),
      `镜像缺档：ERROR_STATUS_MAP 没有 ${status}（states.json 有）`,
    );
    assert.deepEqual([...ERROR_STATUS_MAP[status]], codes, `状态 ${status} 错误码漂移`);
  }
  // 方向二：镜像 → states。镜像里多出来的档同样算漂移（单向遍历时它只会静默通过）。
  for (const [status, codes] of Object.entries(ERROR_STATUS_MAP)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(states.error_status_map, status),
      `契约缺档：states.error_status_map 没有 ${status}（镜像有）`,
    );
    assert.deepEqual(
      [...codes],
      states.error_status_map[status],
      `镜像档 ${status} 在 states.json 里不存在或码表不同`,
    );
  }
  assert.equal(statusForErrorCode('MEDIA_TOO_LARGE'), 413);
  assert.equal(statusForErrorCode('MEDIA_TYPE_UNSUPPORTED'), 415);
  assert.equal(statusForErrorCode('NOT_FOUND'), 404);
  assert.equal(statusForErrorCode('REVISION_REQUIRED'), 428);
  assert.equal(statusForErrorCode('REVISION_CONFLICT'), 409);
  assert.equal(statusForErrorCode('INTERNAL_ERROR'), 500);
  assert.equal(isErrorCode('IDEMPOTENCY_CONFLICT'), true);
  assert.equal(isErrorCode('NOT_A_CODE'), false);
});

test('每用途允许的 MIME 都在 UploadInput.mime 枚举内', () => {
  const enumMime = S.UploadInput.properties.mime.enum;
  for (const list of Object.values(MEDIA_PURPOSE_MIME)) {
    for (const m of list) assert.ok(enumMime.includes(m), `${m} 不在上传枚举内`);
  }
});

test('字节/时长上限与契约及 state-contract 一致', () => {
  assert.equal(MEDIA_MAX_BYTES, S.UploadInput.properties.bytes.maximum);
  assert.equal(MEDIA_MAX_DURATION_MS, S.UploadInput.properties.duration_ms.maximum);
  const MIB = 1048576;
  assert.equal(MEDIA_PURPOSE_MAX_BYTES.weed_recognition, 2 * MIB);
  assert.equal(MEDIA_PURPOSE_MAX_BYTES.label_ocr, 2 * MIB);
  assert.equal(MEDIA_PURPOSE_MAX_BYTES.voice_question, 10 * MIB);
  assert.equal(MEDIA_PURPOSE_MAX_BYTES.community_image, 5 * MIB);
  assert.equal(COMMUNITY_MAX_IMAGES_PER_POST, 3);
  assert.ok(MEDIA_ACCESS_TTL_MS <= 300000, '短效句柄不得超过 300 秒');
});

test('Media 公开投影字段与契约 Media 的 required 一致（不含 object_ref/owner）', () => {
  const required = new Set(S.Media.required);
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789' });
  const grant = svc.initiateUpload({
    ownerId: 'u1',
    input: { purpose: 'weed_recognition', mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64) },
    idempotencyKey: 'k1',
  });
  const keys = Object.keys(grant.media);
  assert.deepEqual(new Set(keys), required);
  for (const forbidden of ['object_ref', 'objectRef', 'owner_id', 'ownerId', 'rawRef', 'derivativeRef']) {
    assert.equal(keys.includes(forbidden), false, `投影不应含 ${forbidden}`);
  }
});

test('状态机与 state-contract 描述一致', () => {
  assert.equal(canTransition('initiated', 'uploaded'), true);
  assert.equal(canTransition('uploaded', 'processing'), true);
  assert.equal(canTransition('processing', 'ready'), true);
  assert.equal(canTransition('ready', 'deleting'), true);
  assert.equal(canTransition('deleting', 'deleted'), true);
  assert.equal(canTransition('deleted', 'ready'), false);
  assert.equal(canTransition('initiated', 'ready'), false, '不得跳过 uploaded/processing');
});

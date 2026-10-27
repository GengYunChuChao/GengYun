import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_VERSION,
  CONSENT_PURPOSES,
  MEDIA_PURPOSES,
  CONSENT_STATES,
  EXPORT_STATES,
  THIRD_PARTY_STATES,
  DELETION_STATES,
  HANDLER_STATES,
  ERROR_STATUS_MAP,
  statusForErrorCode,
  isErrorCode,
} from '../../packages/privacy/constants.mjs';

const states = JSON.parse(
  readFileSync(new URL('../../packages/contracts/states.json', import.meta.url), 'utf8'),
);

test('contract_version 与 states.json 一致', () => {
  assert.equal(CONTRACT_VERSION, states.contract_version);
});

test('ConsentPurpose / MediaPurpose / ThirdPartyState / DeletionState 与 states.json 一致', () => {
  assert.deepEqual(CONSENT_PURPOSES, states.states.ConsentPurpose);
  assert.deepEqual(MEDIA_PURPOSES, states.states.MediaPurpose);
  assert.deepEqual(THIRD_PARTY_STATES, states.states.ThirdPartyState);
  assert.deepEqual(DELETION_STATES, states.states.DeletionState);
});

test('error_status_map 与 states.json 双向一致（前后端一致授权错误码）', () => {
  // 档位集合先钉：两侧同时少同一档时双向遍历仍会全绿；而集合断言若放在遍历之后，
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
  // 方向一：镜像 → states。镜像里每一档都必须与契约同档逐项相同。
  // 契约缺档时先点名再比（否则只会抛 TypeError / 报「码表不同」而不说缺哪一档）。
  for (const [status, codes] of Object.entries(ERROR_STATUS_MAP)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(states.error_status_map, status),
      `契约缺档：states.error_status_map 没有 ${status}（镜像有）`,
    );
    assert.deepEqual([...codes], states.error_status_map[status], `状态 ${status} 的错误码漂移`);
  }
  // 方向二：states → 镜像。契约里有的档，镜像不许缺 —— 单向遍历时「镜像缺一档」
  // 只是少跑一轮循环、会静默通过（这正是 500 漏同步时本文件仍绿的原因），所以补上这一方向。
  for (const [status, codes] of Object.entries(states.error_status_map)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ERROR_STATUS_MAP, status),
      `镜像缺档：ERROR_STATUS_MAP 没有 ${status}（states.json 有）`,
    );
    assert.deepEqual([...ERROR_STATUS_MAP[status]], codes, `镜像缺档或码表不同：契约状态 ${status}`);
  }
  // 403 必须包含授权相关错误码
  assert.ok(ERROR_STATUS_MAP[403].includes('CONSENT_REQUIRED'));
  assert.ok(ERROR_STATUS_MAP[403].includes('SCOPE_DENIED'));
  assert.ok(ERROR_STATUS_MAP[403].includes('ACCOUNT_INACTIVE'));
  assert.ok(ERROR_STATUS_MAP[409].includes('OBJECT_UNAVAILABLE'));
  assert.ok(ERROR_STATUS_MAP[428].includes('REVISION_REQUIRED'));
});

test('statusForErrorCode 与 isErrorCode 映射正确', () => {
  assert.equal(statusForErrorCode('CONSENT_REQUIRED'), 403);
  assert.equal(statusForErrorCode('SCOPE_DENIED'), 403);
  assert.equal(statusForErrorCode('ACCOUNT_INACTIVE'), 403);
  assert.equal(statusForErrorCode('OBJECT_UNAVAILABLE'), 409);
  assert.equal(statusForErrorCode('REVISION_REQUIRED'), 428);
  assert.equal(statusForErrorCode('INTERNAL_ERROR'), 500);
  assert.equal(isErrorCode('CONSENT_REQUIRED'), true);
  assert.equal(isErrorCode('NOT_A_CODE'), false);
  assert.throws(() => statusForErrorCode('NOT_A_CODE'));
});

test('本地枚举合法值自洽（不包含契约外值）', () => {
  assert.deepEqual(CONSENT_STATES, ['granted', 'withdrawn']);
  assert.deepEqual(EXPORT_STATES, ['reserved', 'sent', 'failed', 'outcome_unknown']);
  assert.deepEqual(HANDLER_STATES, ['pending', 'running', 'completed', 'blocked']);
  // 首版无 training 用途
  assert.equal(CONSENT_PURPOSES.includes('training'), false);
});

test('Export.state 与 DeletionHandler 状态枚举与 openapi.json 一致', () => {
  const openapi = JSON.parse(
    readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(EXPORT_STATES, openapi.components.schemas.Export.properties.state.enum);
  assert.deepEqual(
    HANDLER_STATES,
    openapi.components.schemas.DeletionHandler.properties.online_state.enum,
  );
  assert.deepEqual(
    HANDLER_STATES,
    openapi.components.schemas.DeletionHandler.properties.backup_state.enum,
  );
});

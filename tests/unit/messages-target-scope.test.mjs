/**
 * GY-R31 · #17 / G2 裁定臂 —— 消息跳转目标的**本版范围**（不依赖真机、不依赖 Postgres）。
 *
 * 裁定（见 `docs/verification/gy-r31-i17-g2-ruling-20261022.md`）：本版可跳转目标 = 社区
 * `post` / `comment`；契约闭集里其余 15 型**如实降级为 `unavailable`**：不返回 500、
 * 不抛错、不给原因文案。本文件钉住这条裁定，防三种腐烂：
 *
 *   1. 契约闭集扩容而代码闭集不跟（或反之）⇒ 两组枚举必须逐项相等；
 *   2. 有人为了让 15 型「看起来可用」而在类型闸门后面加兜底/放宽 ⇒ 未支持类型必须
 *      **一次都不问**可见性判据（闸门在判据之前，不存在"先问再降级"的旁路）；
 *   3. 有人把「不支持」实现成异常/500 ⇒ 端口层不抛错，HTTP 读面必须 200 且每行
 *      取值都在契约闭集内、字段不夹带原因。
 *
 * `UNSUPPORTED_COUNT` 是**显式登记**：本版不支持 15 型。若本版真扩容（接线了新的
 * 目标类型），必须同时改这里与裁定页「范围与登记」一节，不允许只改代码。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { API, idem, makeWiredHarness, passingPort, postInput } from './community-moderation-fixtures.mjs';

/** 本版声明可跳转的目标类型（与 `services/api/src/messages/reference-community.ts` 闸门同源）。 */
const SUPPORTED_TARGET_TYPES = ['post', 'comment'];
/** 本版**显式登记**的不支持类型数量（契约闭集 17 − 支持 2）。 */
const UNSUPPORTED_COUNT = 15;

function readOpenApi() {
  return JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
}

/** 契约 `TargetRef.type` 闭集（唯一权威：`packages/contracts/openapi.json`）。 */
function contractTargetTypes() {
  return readOpenApi().components.schemas.TargetRef.properties.type.enum;
}

/** 契约 `Message` 的必填字段集（用于确认读面没有夹带原因/内容字段）。 */
function contractMessageKeys() {
  return [...readOpenApi().components.schemas.Message.required].sort();
}

function unsupportedTargetTypes(all, supported) {
  return all.filter(type => !supported.includes(type));
}

/** 固定装置用的确定性 uuid（不依赖随机数，失败可复现）。 */
function fixtureUuid(prefix, index) {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** 契约 `MessagePage` ⇒ `data.items`（并与调用方一样把 200 当作硬前提）。 */
const items = (response) => {
  assert.equal(response.status, 200, `GET /messages 必须 200，实际 ${response.status}`);
  return response.body.data.items;
};

// ---------------------------------------------------------------------------
// 1. 闭集一致性 + 显式登记
// ---------------------------------------------------------------------------

test('G2-1 契约闭集 = 代码闭集，且本版支持集恰为 post/comment（未支持 15 型）', async () => {
  const { TARGET_REF_TYPES } = await import('../../services/api/src/messages/types.ts');
  const declared = [...TARGET_REF_TYPES];
  const enumTypes = contractTargetTypes();

  // 两个方向都断：契约扩了代码没跟 / 代码加了契约没有的类型，都要在这里红。
  assert.deepEqual([...declared].sort(), [...enumTypes].sort(), '代码闭集与 openapi TargetRef.type 枚举不一致');
  assert.equal(enumTypes.length, 17, 'TargetRef.type 闭集应为 17 型');

  for (const type of SUPPORTED_TARGET_TYPES) {
    assert.ok(enumTypes.includes(type), `支持集里的 ${type} 必须在契约闭集内`);
  }

  // 显式登记：本版不支持 = 17 − 2 = 15。改这里必须同步改裁定页。
  const unsupported = unsupportedTargetTypes(enumTypes, SUPPORTED_TARGET_TYPES);
  assert.equal(
    unsupported.length, UNSUPPORTED_COUNT,
    `本版不支持类型数量变了（现 ${unsupported.length} 型：${unsupported.join('/')}）；`
    + '若确为扩容，请同时更新 docs/verification/gy-r31-i17-g2-ruling-20261022.md「范围与登记」',
  );
  // 不重叠：支持集与不支持集必须恰好互补，不许有"两边都算"的第三种状态。
  assert.deepEqual(
    [...SUPPORTED_TARGET_TYPES, ...unsupported].sort(), [...enumTypes].sort(),
    '支持集与不支持集必须恰好互补',
  );
});

// ---------------------------------------------------------------------------
// 2. 端口层：未支持类型在可见性判据**之前**被拦下，且不抛错
// ---------------------------------------------------------------------------

test('G2-2 未支持类型 ⇒ unavailable，且一次都不问可见性判据（不抛错）', async () => {
  const { createCommunityReferencePort } = await import('../../services/api/src/messages/reference-community.ts');
  const unsupported = unsupportedTargetTypes(contractTargetTypes(), SUPPORTED_TARGET_TYPES);

  const probes = [];
  const port = createCommunityReferencePort({
    // 恒真的判据：任何"降级 = 判据说不可见"的解释都会被对照组反驳。
    community: () => ({
      async isPubliclyVisible(kind, id) {
        probes.push({ kind, id });
        return true;
      },
    }),
  });
  assert.equal(port.available, true, '本用例必须跑在已接线端口上，否则 unavailable 是接线缺失而非类型闸门');

  // 2a. 15 型未支持：unavailable + 判据零调用 + 不抛错。
  for (const type of unsupported) {
    const before = probes.length;
    const targetRef = { type, id: fixtureUuid('11111111', before) };
    await assert.doesNotReject(
      async () => assert.equal(
        await port.stateOf({ target_ref: targetRef, userId: 'g2-ruling-user' }),
        'unavailable', `${type} 必须如实降级为 unavailable`,
      ),
      `${type} 走不支持分支时不得抛错`,
    );
    assert.equal(probes.length, before, `${type} 不得触达可见性判据（类型闸门必须在判据之前）`);
  }

  // 2b. 控制组：同样恒真的判据 + 同一端口，post/comment 就可以是 available ⇒
  // 上面的 unavailable 只能由「类型不在支持集」解释，而不是判据坏了或端口没接线。
  for (const type of SUPPORTED_TARGET_TYPES) {
    const before = probes.length;
    assert.equal(
      await port.stateOf({ target_ref: { type, id: fixtureUuid('22222222', before) }, userId: 'g2-ruling-user' }),
      'available', `${type} 在恒真判据下应为 available`,
    );
    assert.equal(probes.length, before + 1, `${type} 必须实际问一次可见性判据`);
    assert.equal(probes[before].kind, type, '判据必须收到类型（证明真的问了）');
  }
});

test('G2-3 判据自身抛错时，未支持类型仍 unavailable 且不抛错', async () => {
  const { createCommunityReferencePort } = await import('../../services/api/src/messages/reference-community.ts');
  const unsupported = unsupportedTargetTypes(contractTargetTypes(), SUPPORTED_TARGET_TYPES);

  const port = createCommunityReferencePort({
    community: () => ({
      async isPubliclyVisible() {
        throw new Error('synthetic visibility failure');
      },
    }),
  });

  for (const type of unsupported) {
    await assert.doesNotReject(
      async () => assert.equal(
        await port.stateOf({ target_ref: { type, id: fixtureUuid('33333333', 0) }, userId: 'g2-ruling-user' }),
        'unavailable', `${type} 在判据抛错时也必须 unavailable`,
      ),
    );
  }
});

// ---------------------------------------------------------------------------
// 3. HTTP 读面：15 型与对照组同页，200（不是 500），字段不夹带原因
// ---------------------------------------------------------------------------

test('G2-4 读面同页：15 型全部 unavailable、同页 post 仍 available、整体 200 且字段合契约', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const a = await h.session('g2');
  const unsupported = unsupportedTargetTypes(contractTargetTypes(), SUPPORTED_TARGET_TYPES);

  // 对照组：一条真实社区帖子（走真实生产者链路），证明"同页里 post 是 available"。
  const live = await h.service.createPost(a.actor, postInput(), { idempotencyKey: idem(1) });

  // 15 型：存储层固定装置（本版生产者不会产出这些组合，这里只行使读路径）。
  const createdAt = new Date(h.time + 1000).toISOString();
  for (const [index, type] of unsupported.entries()) {
    const inserted = await h.messages.insertMessage({
      id: fixtureUuid('dddddddd', index),
      revision: 1,
      owner_id: a.userId,
      type: 'moderation',
      target_ref: { type, id: fixtureUuid('eeeeeeee', index) },
      read_at: null,
      created_at: createdAt,
      event_key: `gy-r31-g2-${type}`,
    });
    assert.equal(inserted, 'inserted', `固定装置写入失败：${type}`);
  }

  const response = await h.inject('GET', `${API}/messages?limit=50`, { token: a.token });
  assert.equal(response.status, 200, '未支持类型必须返回 200，不得 500');

  const rows = items(response);
  assert.ok(Array.isArray(rows) && rows.length >= unsupported.length + 1, '读面应同时包含对照组与 15 型');

  const byTargetId = new Map(
    rows.filter(row => row.target_ref !== null).map(row => [row.target_ref.id, row]),
  );
  const contractKeys = contractMessageKeys();

  // 3a. 对照组在同一次响应里是 available。
  const control = byTargetId.get(live.id);
  assert.ok(control !== undefined, '同页应含指向真实帖子的消息');
  assert.equal(control.reference_state, 'available', '同页 post 目标应为 available（证明这不是"整页不可用"的假象）');

  // 3b. 15 型全部 unavailable，字段恰为契约必填集（不含原因/降级说明/target 内容）。
  for (const [index, type] of unsupported.entries()) {
    const row = byTargetId.get(fixtureUuid('eeeeeeee', index));
    assert.ok(row !== undefined, `${type} 的消息行应出现在读面`);
    assert.equal(row.reference_state, 'unavailable', `${type} 必须如实降级为 unavailable`);
    assert.equal(row.target_ref.type, type, `${type} 的 target_ref 必须原样回传`);
    assert.deepEqual(
      Object.keys(row).sort(), contractKeys,
      `${type} 的消息行字段必须恰为契约 Message 必填集（不得夹带原因字段）`,
    );
  }

  // 3c. 响应体不得夹带任何"为何不可用"的人类可读原因（降级必须是静默的）。
  const raw = JSON.stringify(response.body);
  for (const hint of ['not_supported', 'unsupported', '不支持', '未接线', 'reason']) {
    assert.equal(raw.includes(hint), false, `读面不得出现原因字样：${hint}`);
  }
});

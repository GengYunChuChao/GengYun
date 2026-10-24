/**
 * GY-I19（#19）第 3 步 · **备份恢复重放清单** + 「恢复后不得复活」负例 单测。
 *
 * 本文件同时是**回归用例**：时间口径、阶段状态闭集、失败码白名单全部消费
 * `packages/privacy`（GY-I27 已合并）与 `services/api/src/privacy/deletion-aging.ts`（本分支第 1 步）的
 * **既有实现**，`packages/privacy/**` 与既有 `.ts` 一个字节都没改。
 *
 * 覆盖（四类关键负例，逐条都会真红）：
 *   ① 恢复一份**含已删对象**的备份快照 → 通过清单重放 ⇒ 该对象**仍不可见/不可用**；
 *   ② **漏重放**（目标失败/未接/清单未执行/清单被裁剪）⇒ 可判别 `pending`/`failed`（带原因码），
 *      **绝不**表现为「已恢复成功」；
 *   ③ 主键冲突 / 重复重放 ⇒ **幂等**（不产生第二份事实，不报含糊结论）；
 *   ④ 清单条目与 7 日 / 30 日期限：**期限是上限、不是完成条件** —— 没有完成证据时（期限内/已逾期）
 *      都不得仅凭时钟判完成；反过来，**期限内提前完成且带证据必须如实判安全**。
 * 另覆盖 fail-closed：坏行不静默跳过、越权、入参不可信、清单不含用户可识别信息。
 *
 * **替身声明**：本文件里的「备份快照」与「恢复目标存储」都是**内存替身**（不是真实备份系统），
 * 第三方重播端口也是替身 —— 本片**零真实第三方调用**，`real` 未接真实依赖一律 fail-closed。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDLER_STATES, THIRD_PARTY_STATES } from '../../packages/privacy/constants.mjs';
import { SAFE_ERROR_CODES } from '../../packages/privacy/deletion.mjs';
import {
  REPLAY_ENTRY_STATUSES,
  REPLAY_MANIFEST_VERSION,
  REPLAY_REASON_CODES as REASON,
  REPLAY_SCOPES,
  backupReplayIsRestoreSafe,
  buildBackupReplayManifest,
  executeBackupReplay,
  replayKeyOf,
} from '../../services/api/src/privacy/backup-replay-manifest.ts';

const T = '2026-10-01T00:00:00.000Z'; // 删除请求受理时刻 / tombstone 落库时刻
const T_MS = Date.parse(T);
const DAY1 = new Date(T_MS + 24 * 3600 * 1000).toISOString();
const DAY6 = new Date(T_MS + 6 * 24 * 3600 * 1000).toISOString();
const DAY7 = new Date(T_MS + 7 * 24 * 3600 * 1000).toISOString();
const DAY30 = new Date(T_MS + 30 * 24 * 3600 * 1000).toISOString();
const DAY30_MINUS_1MS = new Date(T_MS + 30 * 24 * 3600 * 1000 - 1).toISOString();
const OLD = new Date(T_MS - 24 * 3600 * 1000).toISOString(); // 比 tombstone 更早的落库时刻

/** 一条合法 tombstone（缺省：身份范围、已完成、带证据、落库于 T）。 */
function tombstone(overrides = {}) {
  return {
    object_ref: 'opaque:obj-1',
    delete_generation: 1,
    scope: 'identity',
    recorded_at: T,
    requested_at: T,
    state: 'completed',
    evidence_ref: 'ev:identity:1',
    ...overrides,
  };
}

/** 合法快照（缺省：水位 = T，含对象清单为空 ⇒ 只按「比水位新」判定）。 */
function snapshot(overrides = {}) {
  return {
    snapshot_id: 'snap-2026-10-31',
    lineage: 'lineage-a',
    watermark: T,
    created_at: T,
    contains_object_refs: [],
    ...overrides,
  };
}

/**
 * 恢复目标**替身**：真在内存里删/查对象，并用 `replay_key → 证据` 的账本模拟
 * 目标端的原子幂等（同一键重复调用返回 `duplicate`，不产生第二份事实）。
 */
function fakeTarget({
  live = [],
  failKeys = [],
  skipApply = false,
  noThirdParty = false,
  thirdPartyUnavailable = false,
  throwOnVisible = false,
} = {}) {
  const liveSet = new Set(live);
  /** 幂等账本：replay_key → evidenceRef（唯一一份事实）。 */
  const ledger = new Map();
  const calls = [];
  const appliedOrder = [];
  /** **第三方**实际被发送的重放次数（用于断言"未接线 ⇒ 零发送"）。 */
  let thirdPartySends = 0;
  const target = {
    kind: 'wired',
    available: true,
    live: liveSet,
    ledger,
    calls,
    appliedOrder,
    get thirdPartySends() {
      return thirdPartySends;
    },
    apply(entry) {
      calls.push(entry.replay_key);
      if (skipApply) return { outcome: 'pending', errorCode: 'STORE_UNREACHABLE' };
      if (failKeys.includes(entry.replay_key) || failKeys.includes(entry.object_ref)) {
        return { outcome: 'failed', errorCode: 'STORE_REJECTED' };
      }
      if (ledger.has(entry.replay_key)) {
        // 主键冲突 / 重复重放：返回**已存在的那一份**事实。
        return { outcome: 'duplicate', evidenceRef: ledger.get(entry.replay_key) };
      }
      const evidenceRef = `replay:${entry.replay_key.slice(0, 16)}`;
      ledger.set(entry.replay_key, evidenceRef);
      appliedOrder.push(entry.replay_key);
      liveSet.delete(entry.object_ref); // 真正把对象从恢复出来的存储里再删掉
      return { outcome: 'applied', evidenceRef };
    },
    isVisible(ref) {
      if (throwOnVisible) throw new Error('restore store unreachable');
      return liveSet.has(ref);
    },
  };
  if (thirdPartyUnavailable) {
    // 端口**存在但不可用**：`available: false`，且任何调用都要被计为一次"发送"（用于断言 0 发送）。
    target.thirdParty = {
      available: false,
      replay(entry) {
        thirdPartySends += 1;
        calls.push(entry.replay_key);
        return { outcome: 'failed', errorCode: 'PROVIDER_UNAVAILABLE' };
      },
    };
  } else if (!noThirdParty) {
    target.thirdParty = {
      available: true,
      replay(entry) {
        thirdPartySends += 1;
        calls.push(entry.replay_key);
        if (skipApply) return { outcome: 'pending', errorCode: 'PROVIDER_TIMEOUT' };
        if (ledger.has(entry.replay_key)) {
          return { outcome: 'duplicate', evidenceRef: ledger.get(entry.replay_key), confirmed: true };
        }
        const evidenceRef = `third-party:${entry.replay_key.slice(0, 16)}`;
        ledger.set(entry.replay_key, evidenceRef);
        appliedOrder.push(entry.replay_key);
        liveSet.delete(entry.object_ref);
        return { outcome: 'applied', evidenceRef, confirmed: true };
      },
    };
  }
  return target;
}

/** 全量不变量：状态闭集、`restore_safe` 的口径、原因码必非空、冻结对象。 */
function assertReplayInvariants(result, label = '') {
  const where = label.length > 0 ? `${label}：` : '';
  assert.ok(Object.isFrozen(result), `${where}结论应为冻结对象`);
  for (const entry of result.entries) {
    assert.ok(REPLAY_ENTRY_STATUSES.includes(entry.status), `${where}status 必属闭集：${entry.status}`);
    if (entry.restore_safe) {
      assert.equal(entry.reason_code, null, `${where}单条安全时不得有原因码`);
      assert.equal(entry.settled, true, `${where}单条安全必须有证据确定的完成事实`);
      assert.equal(entry.visible_after, false, `${where}单条安全必须已回查确认不可见`);
      if (entry.needed) {
        assert.ok(entry.status === 'applied' || entry.status === 'duplicate', where);
        assert.equal(typeof entry.evidence_ref, 'string', `${where}重放成功必须带证据`);
      }
    } else {
      assert.equal(typeof entry.reason_code, 'string', `${where}未安全必须带可判别原因码`);
      assert.ok(entry.reason_code.length > 0, where);
    }
    // 复活是事实：可见时 status 只能是 pending/failed。
    if (entry.visible_after === true) {
      assert.ok(entry.status === 'pending' || entry.status === 'failed', `${where}复活时不得报成功`);
      assert.equal(entry.restore_safe, false, where);
    }
  }
  if (result.restore_safe) {
    assert.equal(result.reason_code, null, `${where}整单安全时不得有原因码`);
    assert.equal(result.verified_no_revival, true, where);
    assert.equal(result.isolation_required, false, where);
    assert.deepEqual([...result.revived_object_refs], [], where);
    assert.ok(result.entries.length > 0, `${where}空集合不得真空真`);
  } else {
    assert.equal(result.isolation_required, true, `${where}未安全必须保持隔离`);
    assert.equal(typeof result.reason_code, 'string', `${where}整单未安全必须带原因码`);
    assert.ok(result.reason_code.length > 0, where);
    assert.ok([...result.reasons].includes(result.reason_code), `${where}reason_code 应出现在 reasons 里`);
  }
}

test('清单形状：逐条给出范围/顺序/幂等键/证据要求，且清单本身恒不声称恢复安全', () => {
  const manifest = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: T, contains_object_refs: ['opaque:obj-1', 'opaque:obj-2', 'opaque:obj-3'] }),
    tombstones: [
      tombstone({ object_ref: 'opaque:obj-2', scope: 'media' }),
      tombstone({ object_ref: 'opaque:obj-1', scope: 'identity' }),
      tombstone({
        object_ref: 'opaque:obj-3',
        scope: 'third_party',
        third_party: { recipient_id: 'vendor-a', online_status: 'confirmed', backup_status: 'confirmed', evidence_ref: 'tp-ev-1' },
      }),
    ],
    now: DAY30,
  });

  assert.equal(manifest.manifest_version, REPLAY_MANIFEST_VERSION);
  assert.equal(manifest.state, 'ready');
  assert.equal(manifest.entries_total, 3);
  assert.equal(manifest.entries_required, 3, '快照实际含有这三个对象 ⇒ 全部必须重放');
  assert.equal(manifest.entries_covered, 0);
  // 铁律：清单只是计划 —— 没重放、没验证，就绝不能声称恢复安全。
  assert.equal(manifest.restore_safe, false);
  assert.equal(manifest.reason_code, REASON.NOT_EXECUTED);
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.entries));

  // 顺序：身份 → 媒体 → 第三方待删（state-contract：先删本地，再重播第三方）。
  assert.deepEqual([...manifest.entries].map((e) => e.scope), ['identity', 'media', 'third_party']);
  assert.deepEqual([...manifest.entries].map((e) => e.seq), [0, 1, 2]);
  assert.deepEqual(
    [...manifest.replay_order],
    [...manifest.entries].map((e) => e.replay_key),
  );

  // 幂等键：稳定、确定性、可被目标端当主键用。
  assert.equal(manifest.entries[0].replay_key, replayKeyOf('opaque:obj-1', 1));
  assert.match(manifest.entries[0].replay_key, /^[0-9a-f]{64}$/);

  // 证据要求：逐条给出（身份要销毁映射、第三方要确认与证据索引）。
  assert.deepEqual([...manifest.entries[0].evidence_required], ['replay_receipt', 'identity_mapping_destroyed']);
  assert.deepEqual([...manifest.entries[1].evidence_required], ['replay_receipt']);
  assert.deepEqual([...manifest.entries[2].evidence_required], ['third_party_confirmation', 'evidence_ref']);

  // 既有协议闭集原样保留（不自造枚举）；白名单内失败码原样透出、自由文本折叠。
  for (const entry of manifest.entries) {
    assert.ok(HANDLER_STATES.includes(entry.protocol_state), entry.protocol_state);
    assert.ok(entry.third_party_state === null || THIRD_PARTY_STATES.includes(entry.third_party_state), entry.third_party_state);
    assert.ok(REPLAY_SCOPES.includes(entry.scope), entry.scope);
  }
  assert.equal(manifest.entries[0].recorded_error_code, null);
  assert.equal(manifest.entries[2].third_party_state, 'confirmed');
  assert.equal(manifest.entries[2].third_party_confirmed, true);

  const folded = buildBackupReplayManifest({
    snapshot: snapshot({ contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ error_code: 'RAW_VENDOR_SDK_TEXT_should_not_leak' })],
    now: DAY30,
  });
  assert.equal(folded.entries[0].recorded_error_code, null, '非白名单错误码折叠，不透出原文');
  assert.equal(JSON.stringify(folded).includes('RAW_VENDOR'), false);
  assert.ok(SAFE_ERROR_CODES.includes('STORE_UNREACHABLE'));
  const kept = buildBackupReplayManifest({
    snapshot: snapshot({ contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ error_code: 'STORE_UNREACHABLE' })],
    now: DAY30,
  });
  assert.equal(kept.entries[0].recorded_error_code, 'STORE_UNREACHABLE', '白名单码原样透出');
});

test('负例①：恢复一份含已删对象的快照 → 重放后该对象仍不可见/不可用（只比水位会误判为已覆盖）', async () => {
  // 水位比 tombstone 新（旧实现只比水位 ⇒ 会判「被快照覆盖、无需重放」），但快照**实际含有**该对象。
  const coveredOnly = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: [] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-secret' })],
    now: DAY30,
  });
  assert.equal(coveredOnly.entries[0].needed, false, '水位更新且未列出该对象 ⇒ 无必须重放项');
  assert.equal(coveredOnly.entries[0].covered_by_snapshot, true);
  assert.equal(coveredOnly.reason_code, REASON.NOTHING_REQUIRED);

  // 同一 tombstone、同一水位，但快照**含有**它 ⇒ 必须重放（这就是「水位不足以判定覆盖」的洞）。
  const manifest = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-secret'] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-secret' })],
    now: DAY30,
  });
  assert.equal(manifest.entries[0].needed, true);
  assert.equal(manifest.entries[0].covered_by_snapshot, false);

  // 恢复后的存储里**确实**有这个被删对象（含已删对象的快照）。
  const target = fakeTarget({ live: ['opaque:obj-secret'] });
  assert.equal(target.isVisible('opaque:obj-secret'), true, '恢复后对象可见（这就是危险局面）');

  const result = await executeBackupReplay({ manifest, target });
  assertReplayInvariants(result, '重放后');
  assert.equal(result.entries[0].status, 'applied');
  assert.equal(result.verified_no_revival, true);
  assert.deepEqual([...result.revived_object_refs], []);
  assert.equal(result.restore_safe, true);
  assert.equal(result.reason_code, null);
  // 关键断言：重放之后该对象**仍不可见/不可用**（不得复活）。
  assert.equal(target.isVisible('opaque:obj-secret'), false);
  assert.equal(await backupReplayIsRestoreSafe({ manifest, target }), true);
});

test('负例②：漏重放 ⇒ 可判别的 pending/failed（带原因码），绝不表现为「已恢复成功」', async () => {
  const mkManifest = () => buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-secret'] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-secret' })],
    now: DAY30,
  });

  // (a) 清单产出但**从未执行重放** ⇒ 清单本身绝不声称成功。
  const manifest = mkManifest();
  assert.equal(manifest.restore_safe, false);
  assert.equal(manifest.reason_code, REASON.NOT_EXECUTED);
  assert.equal(JSON.stringify(manifest).includes('"restore_safe":true'), false);

  // (b) 目标端报告失败（漏重放/未删净）：状态 failed + 白名单原因码原样透出 + 对象仍可见。
  const failing = fakeTarget({ live: ['opaque:obj-secret'], failKeys: ['opaque:obj-secret'] });
  const failed = await executeBackupReplay({ manifest: mkManifest(), target: failing });
  assertReplayInvariants(failed, '目标失败');
  assert.equal(failed.entries[0].status, 'failed');
  assert.equal(failed.entries[0].reason_code, 'STORE_REJECTED');
  assert.equal(failed.entries[0].visible_after, true, '没删掉 ⇒ 仍可见（复活）');
  assert.deepEqual([...failed.revived_object_refs], ['opaque:obj-secret']);
  assert.equal(failed.verified_no_revival, false);
  assert.equal(failed.restore_safe, false);
  assert.equal(failed.isolation_required, true);
  assert.ok([...failed.reasons].includes(REASON.REVIVED));
  assert.ok([...failed.reasons].includes('STORE_REJECTED'));
  assert.equal(failing.isVisible('opaque:obj-secret'), true);

  // (c) 目标端未完成（pending）：状态 pending + 原因码，仍不得判成功。
  const pendingTarget = fakeTarget({ live: ['opaque:obj-secret'], skipApply: true });
  const pending = await executeBackupReplay({ manifest: mkManifest(), target: pendingTarget });
  assertReplayInvariants(pending, 'pending');
  assert.equal(pending.entries[0].status, 'pending');
  assert.equal(pending.entries[0].reason_code, 'STORE_UNREACHABLE');
  assert.equal(pending.restore_safe, false);
  assert.equal(pending.isolation_required, true);

  // (d) 端口未接线/不可用（`real` 未接真实依赖）⇒ fail-closed，零调用。
  const unwired = { kind: 'unwired', available: false, apply() { throw new Error('不得被调用'); }, isVisible() { throw new Error('不得被调用'); } };
  const closed = await executeBackupReplay({ manifest: mkManifest(), target: unwired });
  assertReplayInvariants(closed, '未接线');
  assert.equal(closed.entries[0].status, 'failed');
  assert.equal(closed.entries[0].reason_code, REASON.TARGET_UNAVAILABLE);
  assert.equal(closed.restore_safe, false);
  const noTarget = await executeBackupReplay({ manifest: mkManifest() });
  assert.equal(noTarget.entries[0].reason_code, REASON.TARGET_UNAVAILABLE);
  assert.equal(noTarget.restore_safe, false);

  // (e) 底层事实与清单不符（水位+快照清单都说「没有」，对象其实还在）⇒ 覆盖条目也必须红。
  const liarManifest = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: [] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-secret' })],
    now: DAY30,
  });
  assert.equal(liarManifest.entries[0].needed, false);
  const liar = fakeTarget({ live: ['opaque:obj-secret'] });
  const caught = await executeBackupReplay({ manifest: liarManifest, target: liar });
  assertReplayInvariants(caught, '覆盖但可见');
  assert.equal(caught.entries[0].status, 'failed');
  assert.equal(caught.entries[0].reason_code, REASON.REVIVED);
  assert.equal(caught.restore_safe, false);

  // (f) 可见性回查不可用 ⇒ 不能算「已验证无复活」。
  const blind = fakeTarget({ live: [], throwOnVisible: true });
  const unverified = await executeBackupReplay({ manifest: mkManifest(), target: blind });
  assertReplayInvariants(unverified, '回查不可用');
  assert.equal(unverified.verified_no_revival, false);
  assert.equal(unverified.restore_safe, false);

  // (g) 报称完成但**缺证据**（空白不算证据）⇒ 不得判成功（沿用既有协议 EVIDENCE_REQUIRED 口径）。
  const noEvidenceTarget = fakeTarget({ live: ['opaque:obj-secret'] });
  noEvidenceTarget.apply = () => ({ outcome: 'applied', evidenceRef: '   ' });
  const noEvidence = await executeBackupReplay({ manifest: mkManifest(), target: noEvidenceTarget });
  assertReplayInvariants(noEvidence, '缺证据');
  assert.equal(noEvidence.entries[0].status, 'failed');
  assert.equal(noEvidence.entries[0].reason_code, REASON.NO_EVIDENCE);
  assert.equal(noEvidence.restore_safe, false);
});

test('负例③：主键冲突/重复重放 ⇒ 幂等（一份事实、稳定键、无含糊结论）', async () => {
  const build = () => buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-1' })],
    now: DAY30,
  });

  const manifest = build();
  const target = fakeTarget({ live: ['opaque:obj-1'] });

  const first = await executeBackupReplay({ manifest, target });
  assertReplayInvariants(first, '首次重放');
  assert.equal(first.entries[0].status, 'applied');
  assert.equal(first.replayed, 1);
  assert.equal(target.ledger.size, 1);
  const firstEvidence = first.entries[0].evidence_ref;
  assert.equal(typeof firstEvidence, 'string');

  // 同一清单再跑一次（模拟重复重放 / 主键冲突）：目标端返回 duplicate，本模块判**明确成功**。
  const second = await executeBackupReplay({ manifest, target });
  assertReplayInvariants(second, '重复重放');
  assert.equal(second.entries[0].status, 'duplicate');
  assert.equal(second.duplicated, 1);
  assert.equal(second.replayed, 0);
  assert.equal(second.entries[0].evidence_ref, firstEvidence, '同一份事实，证据一致');
  assert.equal(target.ledger.size, 1, '不得产生第二份事实');
  assert.equal(second.restore_safe, true, '重复重放是幂等成功，不是含糊结论');
  assert.equal(second.reason_code, null);

  // 同一对象同一代次的重复行（PK 冲突）⇒ 同一 replay_key、仍只有一份事实。
  const duplicatedRows = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-9'] }),
    tombstones: [
      tombstone({ object_ref: 'opaque:obj-9' }),
      tombstone({ object_ref: 'opaque:obj-9' }),
    ],
    now: DAY30,
  });
  assert.equal(duplicatedRows.entries[0].replay_key, duplicatedRows.entries[1].replay_key);
  const pkTarget = fakeTarget({ live: ['opaque:obj-9'] });
  const pk = await executeBackupReplay({ manifest: duplicatedRows, target: pkTarget });
  assertReplayInvariants(pk, 'PK 冲突');
  assert.deepEqual([...pk.entries].map((e) => e.status), ['applied', 'duplicate']);
  assert.equal(pkTarget.ledger.size, 1, 'PK 冲突不产生第二份事实');
  assert.equal(pk.restore_safe, true);
  assert.deepEqual(pkTarget.appliedOrder, [pk.entries[0].replay_key]);

  // 键只由「对象身份 + 删除代次」决定 ⇒ 跨快照、跨 now 稳定（不同快照重建清单，键不变）。
  const rebuilt = buildBackupReplayManifest({
    snapshot: snapshot({ snapshot_id: 'snap-B', watermark: OLD, contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-1' })],
    now: DAY30,
  });
  assert.equal(rebuilt.entries[0].replay_key, manifest.entries[0].replay_key);
  assert.notEqual(rebuilt.manifest_digest, manifest.manifest_digest, '摘要绑定快照身份');

  // 代次递增 ⇒ 新键（同一对象的第二次删除是**新**事实，不是重复）。
  assert.notEqual(replayKeyOf('opaque:obj-1', 2), replayKeyOf('opaque:obj-1', 1));
});

test('负例④：期限是上限、不是完成条件 —— 不得仅凭时钟判完成，也不得埋没期限内提前完成', async () => {
  // 被快照覆盖的条目**不重放**，只能靠清单里**既成**的完成证据 ⇒ 正好用来暴露「事实未完成」。
  const coveredManifest = (state, now) => buildBackupReplayManifest({
    snapshot: snapshot({ watermark: now, contains_object_refs: [] }),
    tombstones: [tombstone({
      object_ref: 'opaque:obj-c',
      state,
      evidence_ref: state === 'completed' ? 'ev:c:1' : null,
    })],
    now,
  });

  // (a) 期限内（第 6 日）+ **无完成证据** ⇒ 不得声称恢复安全（不得仅凭时钟判完成）。
  const undue = await executeBackupReplay({ manifest: coveredManifest('pending', DAY6), target: fakeTarget({ live: [] }) });
  assertReplayInvariants(undue, '期限内未完成');
  assert.equal(undue.entries[0].needed, false);
  assert.equal(undue.entries[0].status, 'covered');
  assert.equal(undue.entries[0].window_due, false, '事实：仍在期限内');
  assert.equal(undue.entries[0].settled, false);
  assert.equal(undue.entries[0].reason_code, REASON.UNDUE_NO_EVIDENCE);
  assert.equal(undue.restore_safe, false, '没有完成证据 ⇒ 不得声称恢复安全');
  assert.ok([...undue.reasons].includes(REASON.UNDUE_NO_EVIDENCE));

  // (b) 已逾期（第 30 日）+ **仍无完成证据** ⇒ 逾期未执行，不得声称恢复安全。
  const overdue = await executeBackupReplay({ manifest: coveredManifest('pending', DAY30), target: fakeTarget({ live: [] }) });
  assertReplayInvariants(overdue, '逾期未执行');
  assert.equal(overdue.entries[0].window_due, true);
  assert.equal(overdue.entries[0].settled, false);
  assert.equal(overdue.entries[0].reason_code, REASON.OVERDUE_NOT_EXECUTED);
  assert.equal(overdue.restore_safe, false);

  // (c) **期限内提前完成（有证据）⇒ 必须如实判安全**（期限是上限；不得因未到期而隐去）。
  const earlyDone = await executeBackupReplay({ manifest: coveredManifest('completed', DAY6), target: fakeTarget({ live: [] }) });
  assertReplayInvariants(earlyDone, '期限内提前完成');
  assert.equal(earlyDone.entries[0].window_due, false, '事实：仍在期限内');
  assert.equal(earlyDone.entries[0].settled, true);
  assert.equal(earlyDone.restore_safe, true, '期限内提前完成 + 证据 ⇒ 如实安全');
  assert.equal(earlyDone.reason_code, null);

  // (d) 已逾期 + 有证据 ⇒ 同样安全（只有「无证据」才不安全，时钟不决定完成）。
  const overdueDone = await executeBackupReplay({ manifest: coveredManifest('completed', DAY30), target: fakeTarget({ live: [] }) });
  assert.equal(overdueDone.entries[0].window_due, true);
  assert.equal(overdueDone.restore_safe, true);

  // (e) 闭区间边界只影响「事实」与原因码分支：第 30 日差 1ms 仍在期限内。
  assert.equal(coveredManifest('pending', DAY30_MINUS_1MS).entries[0].window_due, false);
  assert.equal(coveredManifest('pending', DAY30).entries[0].window_due, true);
  assert.equal(coveredManifest('pending', DAY30).entries[0].due_at, DAY30);

  // (f) 必须重放的条目：**本次重放的证据**即可定案 —— 第 7 日在线/备份两阶段的 due 事实不同，
  //     但两阶段都已提前完成 ⇒ 都可安全（期限不与完成挂钩）。
  const mixed = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: T, contains_object_refs: ['opaque:obj-online', 'opaque:obj-backup'] }),
    tombstones: [
      tombstone({ object_ref: 'opaque:obj-online', phase: 'online' }),
      tombstone({ object_ref: 'opaque:obj-backup', phase: 'backup' }),
    ],
    now: DAY7,
  });
  const dueByRef = new Map(mixed.entries.map((e) => [e.object_ref, e.window_due]));
  assert.deepEqual([...dueByRef], [['opaque:obj-backup', false], ['opaque:obj-online', true]]);
  const mixedResult = await executeBackupReplay({ manifest: mixed, target: fakeTarget({ live: ['opaque:obj-online', 'opaque:obj-backup'] }) });
  assertReplayInvariants(mixedResult, '混合阶段');
  assert.deepEqual([...mixedResult.entries].map((e) => e.settled), [true, true]);
  assert.equal(mixedResult.restore_safe, true, '两阶段都已带证据重放 ⇒ 可开流量（期限只是事实）');
  assert.equal(mixedResult.reason_code, null);
});

test('P1 返修：历史完成事实不得覆盖本轮失败 —— 必重放条目只认本轮证据（含监工场景）', async () => {
  // 监工场景：快照明确含该第三方对象；tombstone 已有**历史** confirmed + 证据（deletion_settled=true）；
  // 本轮第三方端口 **available=false**；isVisible 只对本地恢复对象回查 false。
  const manifest = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: T, contains_object_refs: ['opaque:third-party-object'] }),
    tombstones: [tombstone({
      object_ref: 'opaque:third-party-object',
      scope: 'third_party',
      state: 'completed',
      evidence_ref: 'ev:tp:historical',
      third_party: {
        recipient_id: 'vendor-a',
        online_status: 'confirmed',
        backup_status: 'confirmed',
        evidence_ref: 'tp-historical-receipt',
      },
    })],
    now: DAY30,
  });
  assert.equal(manifest.entries[0].needed, true);
  assert.equal(manifest.entries[0].deletion_settled, true, '历史事实：确已确认且有证据（仅背景信息）');

  const target = fakeTarget({ live: [], thirdPartyUnavailable: true });
  const result = await executeBackupReplay({ manifest, target });
  assertReplayInvariants(result, '历史事实+本轮未接线');
  assert.equal(result.entries[0].status, 'failed');
  assert.equal(result.entries[0].reason_code, REASON.THIRD_PARTY_UNWIRED, '必须保留可判别失败原因');
  assert.equal(result.entries[0].evidence_ref, null, '本轮没有证据');
  assert.equal(result.entries[0].replayed_this_round, false);
  assert.equal(result.entries[0].settled, false, '历史事实不得兜成本轮成功');
  assert.equal(result.entries[0].needed, true, '该条目必须重放（required=1）');
  assert.equal(result.replayed, 0);
  assert.equal(result.failed, 1, '本轮确为失败（failed=1），不得被历史事实改写');
  assert.equal(result.entries[0].visible_after, false, '本地确实不可见（这正是陷阱）');
  assert.equal(result.restore_safe, false, '本轮第三方重放未完成 ⇒ 不得放行');
  assert.equal(result.isolation_required, true);
  assert.equal(typeof result.reason_code, 'string');
  assert.ok(result.reason_code.length > 0);
  assert.ok([...result.reasons].includes(REASON.THIRD_PARTY_UNWIRED));
  assert.equal(target.thirdPartySends, 0, '端口未接线 ⇒ 零发送');

  // 正向对照（同一份清单）：端口可用且**本轮**确认 ⇒ 才如实放行。
  const wired = fakeTarget({ live: [] });
  const wiredResult = await executeBackupReplay({ manifest, target: wired });
  assert.equal(wiredResult.entries[0].status, 'applied');
  assert.equal(wiredResult.entries[0].replayed_this_round, true);
  assert.equal(wiredResult.entries[0].settled, true);
  assert.equal(wiredResult.restore_safe, true);
  assert.equal(wiredResult.reason_code, null);
  assert.equal(wired.thirdPartySends, 1);

  // 同一缺陷的非第三方实例：本轮 failed / pending，而本地恰好不可见
  // （旧口径会由历史 `deletion_settled` 兜成 `restore_safe:true`）。
  const localManifest = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: T, contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-1' })],
    now: DAY30,
  });
  assert.equal(localManifest.entries[0].deletion_settled, true, '历史事实（背景）');
  for (const [label, opts, expectedReason] of [
    ['本轮 failed', { failKeys: ['opaque:obj-1'] }, 'STORE_REJECTED'],
    ['本轮 pending', { skipApply: true }, 'STORE_UNREACHABLE'],
  ]) {
    const broken = fakeTarget({ live: [], ...opts });
    const brokenResult = await executeBackupReplay({ manifest: localManifest, target: broken });
    assertReplayInvariants(brokenResult, label);
    assert.equal(brokenResult.entries[0].visible_after, false, `${label}：本地不可见`);
    assert.equal(brokenResult.entries[0].replayed_this_round, false, label);
    assert.equal(brokenResult.entries[0].settled, false, `${label}：历史事实不得兜成本轮成功`);
    assert.equal(brokenResult.entries[0].reason_code, expectedReason, label);
    assert.equal(brokenResult.restore_safe, false, `${label}：不得放行`);
    assert.equal(brokenResult.isolation_required, true, label);
    assert.ok([...brokenResult.reasons].includes(expectedReason), label);
  }

  // **保留**：覆盖条目（`needed=false`）仍可合法复用既成证据；`duplicate` 仍是本轮幂等成功。
  const covered = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: [] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-covered', state: 'completed', evidence_ref: 'ev:c:1' })],
    now: DAY30,
  });
  const coveredResult = await executeBackupReplay({ manifest: covered, target: fakeTarget({ live: [] }) });
  assert.equal(coveredResult.entries[0].needed, false);
  assert.equal(coveredResult.entries[0].settled, true, '覆盖条目：既成证据可合法复用');
  assert.equal(coveredResult.restore_safe, true);

  const replayTwice = fakeTarget({ live: ['opaque:obj-1'] });
  await executeBackupReplay({ manifest: localManifest, target: replayTwice });
  const second = await executeBackupReplay({ manifest: localManifest, target: replayTwice });
  assert.equal(second.entries[0].status, 'duplicate');
  assert.equal(second.entries[0].replayed_this_round, true, 'duplicate 仍是本轮幂等成功');
  assert.equal(second.entries[0].settled, true);
  assert.equal(second.restore_safe, true);
});

test('fail-closed：坏行不静默跳过 / 入参不可信 / 越权 / 清单不含用户可识别信息', async () => {
  const bad = [
    ['tombstone 不是对象', [null]],
    ['缺 object_ref', [tombstone({ object_ref: '  ' })]],
    ['delete_generation 非法', [tombstone({ delete_generation: 0 })]],
    ['scope 不在闭集', [tombstone({ scope: 'not_a_scope' })]],
    ['state 不在既有协议闭集', [tombstone({ state: 'weird' })]],
    ['phase 非法', [tombstone({ phase: 'weekly' })]],
    ['requested_at 非法', [tombstone({ requested_at: '2026/10/01 00:00:00' })]],
    ['third_party 缺合法接收方状态', [tombstone({ scope: 'third_party', third_party: null })]],
  ];
  for (const [label, tombstones] of bad) {
    const manifest = buildBackupReplayManifest({ snapshot: snapshot({ contains_object_refs: ['opaque:obj-1'] }), tombstones, now: DAY30 });
    assert.equal(manifest.state, 'blocked', `${label}：应 fail-closed`);
    assert.deepEqual([...manifest.entries], [], `${label}：不得返回任何条目（不静默跳过坏行）`);
    assert.equal(manifest.restore_safe, false, label);
    assert.equal(manifest.reason_code, REASON.INPUT_INVALID, label);
  }

  // 空清单（无 tombstone）：非真空真 —— 空集合不得声称恢复安全。
  const empty = buildBackupReplayManifest({ snapshot: snapshot(), tombstones: [], now: DAY30 });
  assert.equal(empty.state, 'blocked');
  assert.equal(empty.reason_code, REASON.NONE);
  assert.equal(empty.restore_safe, false);
  const emptyRun = await executeBackupReplay({ manifest: empty, target: fakeTarget({ live: [] }) });
  assert.equal(emptyRun.restore_safe, false);
  assert.equal(emptyRun.isolation_required, true);

  // 入参不可信：快照缺失 / 水位非法 / tombstones 非数组 / now 非法 / 时间线倒置。
  assert.equal(buildBackupReplayManifest({ snapshot: undefined, tombstones: [], now: DAY30 }).reason_code, REASON.INPUT_INVALID);
  assert.equal(buildBackupReplayManifest({ snapshot: snapshot({ watermark: 'not-a-time' }), tombstones: [], now: DAY30 }).reason_code, REASON.INPUT_INVALID);
  assert.equal(buildBackupReplayManifest({ snapshot: snapshot({ snapshot_id: '' }), tombstones: [], now: DAY30 }).reason_code, REASON.INPUT_INVALID);
  assert.equal(buildBackupReplayManifest({ snapshot: snapshot(), tombstones: 'nope', now: DAY30 }).reason_code, REASON.INPUT_INVALID);
  assert.equal(buildBackupReplayManifest({ snapshot: snapshot(), tombstones: [], now: 'yesterday' }).reason_code, REASON.INPUT_INVALID);
  // tombstone 落库时刻晚于当前时间（时间线倒置）⇒ 不可信。
  const futureTombstone = buildBackupReplayManifest({
    snapshot: snapshot({ contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ recorded_at: DAY30 })],
    now: T,
  });
  assert.equal(futureTombstone.state, 'blocked');
  assert.equal(futureTombstone.reason_code, REASON.INPUT_INVALID);
  // 快照 created_at 晚于当前时间同样不可信。
  assert.equal(
    buildBackupReplayManifest({ snapshot: snapshot({ created_at: DAY30 }), tombstones: [], now: T }).reason_code,
    REASON.INPUT_INVALID,
  );

  // 越权 / 无法核实归属 ⇒ 不返回任何条目。
  const mismatch = buildBackupReplayManifest({
    snapshot: snapshot({ contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone()],
    now: DAY30,
    subject: 'user-a',
    requestId: 'req-1',
    ownerOf: () => 'user-b',
  });
  assert.equal(mismatch.reason_code, REASON.SUBJECT_MISMATCH);
  assert.deepEqual([...mismatch.entries], []);
  const unverified = buildBackupReplayManifest({
    snapshot: snapshot({ contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone()],
    now: DAY30,
    subject: 'user-a',
    requestId: 'req-1',
  });
  assert.equal(unverified.reason_code, REASON.OWNERSHIP_UNVERIFIED);
  assert.deepEqual([...unverified.entries], []);

  // 清单**不含**用户可识别信息（state-contract：「清单不可恢复出用户关联数据」）。
  const owned = buildBackupReplayManifest({
    snapshot: snapshot({ contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ object_ref: 'opaque:with-no-owner-data' })],
    now: DAY30,
    subject: 'user-secret-42',
    requestId: 'req-42',
    ownerOf: () => 'user-secret-42',
  });
  assert.equal(owned.subject_verified, true);
  const text = JSON.stringify(owned);
  assert.equal(text.includes('user-secret-42'), false, '主体标识不得进清单');
  assert.equal(text.includes('req-42'), false, '请求 id 不得进清单');
  assert.equal(text.includes('opaque:with-no-owner-data') === true, true, '只保留受限的 opaque 引用');
  assert.deepEqual([...owned.entries].map((e) => e.scope), ['identity']);
});

test('fail-closed：清单被裁剪/篡改 ⇒ 拒绝重放（漏重放的根因），零调用', async () => {
  const manifest = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-1', 'opaque:obj-2'] }),
    tombstones: [
      tombstone({ object_ref: 'opaque:obj-1' }),
      tombstone({ object_ref: 'opaque:obj-2', scope: 'media' }),
    ],
    now: DAY30,
  });
  assert.equal(manifest.entries_required, 2);

  // 裁剪：少一条（典型的「漏重放」）
  const trimmed = Object.freeze({ ...manifest, entries: Object.freeze([manifest.entries[0]]) });
  const target = fakeTarget({ live: ['opaque:obj-1'] });
  const trimmedResult = await executeBackupReplay({ manifest: trimmed, target });
  assert.equal(trimmedResult.reason_code, REASON.MANIFEST_TAMPERED);
  assert.deepEqual([...trimmedResult.entries], []);
  assert.equal(trimmedResult.restore_safe, false);
  assert.equal(target.calls.length, 0, '摘要不符 ⇒ 零调用，绝不进入重放');

  // 篡改：把「被快照覆盖」的条目标成必须重放（needed 翻转）
  const covered = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: [] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-1' })],
    now: DAY30,
  });
  assert.equal(covered.entries[0].needed, false);
  const flipped = Object.freeze({
    ...covered,
    entries: Object.freeze([Object.freeze({ ...covered.entries[0], needed: true })]),
  });
  const flippedResult = await executeBackupReplay({ manifest: flipped, target: fakeTarget({ live: [] }) });
  assert.equal(flippedResult.reason_code, REASON.MANIFEST_TAMPERED);
  assert.equal(flippedResult.restore_safe, false);

  // 未 ready 的清单（bad 入参产出）不可用于重放。
  const blockedManifest = buildBackupReplayManifest({ snapshot: snapshot(), tombstones: [null], now: DAY30 });
  const blockedRun = await executeBackupReplay({ manifest: blockedManifest, target: fakeTarget({ live: [] }) });
  assert.equal(blockedRun.reason_code, REASON.INPUT_INVALID);
  assert.equal(blockedRun.restore_safe, false);
});

test('第三方待删重播：未接线 fail-closed；requested 绝不等于 confirmed', async () => {
  const manifest = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-tp'] }),
    tombstones: [
      tombstone({
        object_ref: 'opaque:obj-tp',
        scope: 'third_party',
        third_party: { recipient_id: 'vendor-a', online_status: 'requested', backup_status: 'requested' },
      }),
    ],
    now: DAY30,
  });
  assert.equal(manifest.entries[0].third_party_state, 'requested');
  assert.equal(manifest.entries[0].third_party_confirmed, false);

  // 第三方端口未接线（`noThirdParty`）⇒ fail-closed，且**不得**调用普通 apply 冒充完成。
  const noThirdParty = fakeTarget({ live: ['opaque:obj-tp'], noThirdParty: true });
  const unwired = await executeBackupReplay({ manifest, target: noThirdParty });
  assertReplayInvariants(unwired, '第三方未接线');
  assert.equal(unwired.entries[0].status, 'failed');
  assert.equal(unwired.entries[0].reason_code, REASON.THIRD_PARTY_UNWIRED);
  assert.equal(unwired.restore_safe, false);
  assert.equal(noThirdParty.calls.length, 0, '未接线 ⇒ 零调用');

  // 已接线但**未确认**（重放报称 applied 却没 confirmed）⇒ pending + 原因码，不得判成功。
  const notConfirmed = fakeTarget({ live: ['opaque:obj-tp'] });
  notConfirmed.thirdParty = { available: true, replay: (entry) => ({ outcome: 'applied', evidenceRef: `ev:${entry.replay_key.slice(0, 8)}`, confirmed: false }) };
  const pendingTp = await executeBackupReplay({ manifest, target: notConfirmed });
  assertReplayInvariants(pendingTp, '第三方未确认');
  assert.equal(pendingTp.entries[0].status, 'pending');
  assert.equal(pendingTp.entries[0].reason_code, REASON.THIRD_PARTY_NOT_CONFIRMED);
  assert.equal(pendingTp.restore_safe, false);
  assert.equal(JSON.stringify(pendingTp).includes('"restore_safe":true'), false);
});

test('风险A：带密钥 HMAC 摘要 —— 篡改后重算无密钥摘要仍被拒（零调用）', async () => {
  const hmacKey = 'test-manifest-hmac-key';
  const mkKeyed = () => buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-1', 'opaque:obj-2'] }),
    tombstones: [
      tombstone({ object_ref: 'opaque:obj-1' }),
      tombstone({ object_ref: 'opaque:obj-2', scope: 'media' }),
    ],
    now: DAY30,
    hmacKey,
  });

  const manifest = mkKeyed();
  assert.equal(manifest.entries_required, 2);

  // 带密钥摘要必须区别于无密钥摘要（同一内容）—— 证明 digest 已被密钥绑定。
  const unkeyed = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-1', 'opaque:obj-2'] }),
    tombstones: [
      tombstone({ object_ref: 'opaque:obj-1' }),
      tombstone({ object_ref: 'opaque:obj-2', scope: 'media' }),
    ],
    now: DAY30,
  });
  assert.notEqual(manifest.manifest_digest, unkeyed.manifest_digest, '带密钥摘要必须不同于无密钥摘要');

  // 攻击者：把条目裁剪为 1 条，并用**无密钥 sha256** 重算摘要（他不知道密钥）。
  // 这里用「同内容、无密钥重建清单」的 digest 当作攻击者伪造的摘要。
  const forgedOne = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-1' })],
    now: DAY30,
  });
  const forged = Object.freeze({
    ...manifest,
    entries: Object.freeze([manifest.entries[0]]),
    manifest_digest: forgedOne.manifest_digest,
  });

  const target = fakeTarget({ live: ['opaque:obj-1'] });
  const result = await executeBackupReplay({ manifest: forged, target, hmacKey });
  assertReplayInvariants(result, '风险A 伪造摘要');
  assert.equal(result.reason_code, REASON.MANIFEST_TAMPERED);
  assert.deepEqual([...result.entries], []);
  assert.equal(result.restore_safe, false);
  assert.equal(target.calls.length, 0, '伪造摘要 ⇒ 零调用，绝不进入重放');

  // 正向对照：同一密钥、未篡改清单 ⇒ 正常重放，可安全。
  const ok = await executeBackupReplay({ manifest, target: fakeTarget({ live: ['opaque:obj-1', 'opaque:obj-2'] }), hmacKey });
  assertReplayInvariants(ok, '风险A 正向');
  assert.equal(ok.restore_safe, true);
  assert.equal(ok.reason_code, null);
});

test('风险B：isVisible 返回非布尔 ⇒ fail-closed（不静默放行，视作无法验证）', async () => {
  const manifest = buildBackupReplayManifest({
    snapshot: snapshot({ watermark: DAY30, contains_object_refs: ['opaque:obj-1'] }),
    tombstones: [tombstone({ object_ref: 'opaque:obj-1' })],
    now: DAY30,
  });
  assert.equal(manifest.entries[0].needed, true);

  for (const [label, nonBool] of [['undefined', undefined], ['null', null], ['字符串', 'yes'], ['数字', 1]]) {
    const target = fakeTarget({ live: ['opaque:obj-1'] });
    target.isVisible = () => nonBool;
    const result = await executeBackupReplay({ manifest, target });
    assertReplayInvariants(result, `isVisible=${label}`);
    assert.equal(result.entries[0].visible_after, null, `isVisible 返回 ${label} ⇒ 视作无法验证`);
    assert.equal(result.entries[0].restore_safe, false, label);
    assert.equal(result.entries[0].reason_code, REASON.VERIFY_UNAVAILABLE, label);
    assert.equal(result.verified_no_revival, false, label);
    assert.equal(result.restore_safe, false, label);
    assert.equal(result.isolation_required, true, label);
    assert.ok([...result.reasons].includes(REASON.VERIFY_UNAVAILABLE), label);
  }

  // 正向对照：isVisible 严格布尔 false ⇒ 正常安全。
  const ok = await executeBackupReplay({ manifest, target: fakeTarget({ live: ['opaque:obj-1'] }) });
  assertReplayInvariants(ok, 'isVisible=false');
  assert.equal(ok.entries[0].visible_after, false);
  assert.equal(ok.restore_safe, true);
});

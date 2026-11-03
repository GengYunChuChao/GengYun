// GY-R74 · 媒体保留期限的**同源**与**成文依据**（单测）。
//
// 本片拒绝「凭感觉给一个天数」。所以这里不测行为，只钉三件事：
//   [1] `services/api/src/media/retention.ts` 的天数**不是自己写的**——它就是
//       `services/api/src/privacy/deletion-aging.ts` 的 `ONLINE_RETENTION_DAYS/MS`；
//   [2] 上面那份又等于 `packages/privacy/deletion.mjs` 的 `ONLINE_HOURS = 7 * 24`，
//       且等于成文条文 `docs/implementation-requirements.md` 里那句「私有原媒体 N 日内删除」的 N；
//   [3] 媒体行的到期走**绝对时刻列**（`media.expires_at`），因此**不**进
//       `packages/privacy/retention-policy.mjs` 的 `RETENTION_POLICY`（那张表的 `retentionDays`
//       语义是「年龄列之后再过 N 天」，塞进去就得再发明一个宽限期）。
//
// 这些断言的方向：条文或上游常量一改，本文件立刻转红——⛔ 不许把它改成「跟随上游自动变绿」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  MEDIA_ONLINE_RETENTION_DAYS,
  MEDIA_ONLINE_RETENTION_MS,
  MEDIA_RETENTION_EXPIRED,
  mediaRetentionDeadline,
} from '../../services/api/src/media/retention.ts';
import {
  ONLINE_RETENTION_DAYS as PRIVACY_ONLINE_RETENTION_DAYS,
  ONLINE_RETENTION_MS as PRIVACY_ONLINE_RETENTION_MS,
} from '../../services/api/src/privacy/deletion-aging.ts';
import { assertRetentionPolicy, RETENTION_POLICY } from '../../packages/privacy/retention-policy.mjs';

const REPO_ROOT = new URL('../../', import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

function readRepoFile(relative) {
  return readFileSync(new URL(relative, REPO_ROOT), 'utf8');
}

// ---------------------------------------------------------------------------- [1]

test('[1] 媒体域的天数就是注销链那份常量（不是第二份手写数字）', () => {
  assert.equal(MEDIA_ONLINE_RETENTION_DAYS, PRIVACY_ONLINE_RETENTION_DAYS);
  assert.equal(MEDIA_ONLINE_RETENTION_MS, PRIVACY_ONLINE_RETENTION_MS);
  assert.equal(MEDIA_ONLINE_RETENTION_MS, MEDIA_ONLINE_RETENTION_DAYS * DAY_MS);

  // 万一将来有人把 `retention.ts` 自己写死，这两条会立刻转红。
  const source = readRepoFile('services/api/src/media/retention.ts');
  assert.match(
    source,
    /export const MEDIA_ONLINE_RETENTION_DAYS = ONLINE_RETENTION_DAYS;/,
    '天数必须来自 privacy/deletion-aging.ts，⛔ 不许在本文件里再写一个 7',
  );
  assert.match(source, /export const MEDIA_ONLINE_RETENTION_MS = ONLINE_RETENTION_MS;/);
});

// ---------------------------------------------------------------------------- [2]

test('[2] 上游常量与成文条文一致：deletion.mjs 的 7×24 与 requirements:278 的「N 日内删除」', () => {
  const deletionSource = readRepoFile('packages/privacy/deletion.mjs');
  const hours = /const ONLINE_HOURS = (\d+) \* 24;/.exec(deletionSource);
  assert.notEqual(hours, null, 'deletion.mjs 的 ONLINE_HOURS 必须仍是「N * 24」这种可解析写法');
  assert.equal(Number(hours[1]), MEDIA_ONLINE_RETENTION_DAYS, 'in在线 7×24h 与媒体域天数必须同源');

  // 逐字条文：`docs/implementation-requirements.md:278`
  // 「注销立即撤会话和角色、停新外发／训练，生成分对象删除任务。在线个人数据／私有原媒体7日内删除，
  //   备份30日内滚动清理，恢复时重放删除清单。」
  const requirements = readRepoFile('docs/implementation-requirements.md').split(/\r?\n/);
  const line = requirements.find((text) => text.includes('在线个人数据／私有原媒体'));
  assert.notEqual(line, undefined, '成文条文必须还在：在线个人数据／私有原媒体…日内删除');
  const days = /私有原媒体(\d+)日内删除/.exec(line);
  assert.notEqual(days, null, '条文里必须能读到「私有原媒体 N 日内删除」的 N');
  assert.equal(
    Number(days[1]),
    MEDIA_ONLINE_RETENTION_DAYS,
    '代码里的天数必须等于条文里的天数（改条文就要同步改常量，⛔ 不许反过来让代码去凑）',
  );
});

// ---------------------------------------------------------------------------- [3]

test('[3] 媒体行的到期是绝对时刻列 ⇒ 不进 RETENTION_POLICY（日历条目的语义对不上）', () => {
  const tables = RETENTION_POLICY.map((entry) => entry.table);
  assert.equal(
    tables.includes('public.media'),
    false,
    'media 的截止时刻在 expires_at 上，塞进「年龄列 + N 天」的表就必须再发明一个宽限期',
  );

  // 既有校验器照常通过：本片没有把策略表改坏（`retentionDays` ≥ 1 整数、`ageColumn` 显式、`basisRef` 可解析）。
  assert.doesNotThrow(() => assertRetentionPolicy());

  // `failure_code` 是 `varchar(80)`（0001 初始迁移）⇒ 标记值必须放得下。
  assert.ok(MEDIA_RETENTION_EXPIRED.length <= 80);
  assert.match(MEDIA_RETENTION_EXPIRED, /^[a-z][a-z0-9_]*$/);

  // 注销受理时刻 → 截止时刻，逐毫秒等于「受理 + 7×24h」。
  const at = Date.parse('2026-10-31T00:00:00.000Z');
  assert.equal(mediaRetentionDeadline(at), at + 7 * DAY_MS);
});

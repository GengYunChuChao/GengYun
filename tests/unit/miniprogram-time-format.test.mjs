// GY-R92：社区／消息／收藏／历史卡片的时间戳格式化（展示层，单机型排版）。
//
// 背景：这些页面此前把服务端契约里的 ISO-8601 UTC 串（`2026-11-09T09:00:35.053Z`）
// 直接印在卡片标题行上：既不可读，又因为 24 个定宽字符把后面的 `· 未读`／`· 作物` 挤到下一行。
// 本文件钉住 `miniprogram/utils/time-format.js` 的口径（任务书给的四种说法 + 记录类时间），
// 并显式注入 `now`，使断言与运行日期、时区无关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const hostRequire = createRequire(import.meta.url);
const { formatRelative, formatDateTime, formatDate } = hostRequire('../../miniprogram/utils/time-format.js');

// 2026-11-09 10:00 本地时间。用例里一律用本地时刻构造，再转成 ISO 串喂进去，
// 这样断言既走「字符串解析」这条真实路径，又不会因为 CI 的时区而漂。
const NOW = new Date(2026, 10, 9, 10, 0, 0);
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatRelative：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / MM-DD / YYYY-MM-DD', () => {
  assert.equal(formatRelative(iso(0), NOW), '刚刚');
  assert.equal(formatRelative(iso(30 * 1000), NOW), '刚刚');
  assert.equal(formatRelative(iso(MIN), NOW), '1 分钟前');
  assert.equal(formatRelative(iso(5 * MIN), NOW), '5 分钟前');
  assert.equal(formatRelative(iso(59 * MIN), NOW), '59 分钟前');
  // 满一小时起给出具体时刻（当天）
  assert.equal(formatRelative(iso(HOUR), NOW), '今天 09:00');
  assert.equal(formatRelative(new Date(2026, 10, 9, 0, 5), NOW), '今天 00:05');
  // 昨天 / 前天（同年）
  assert.equal(formatRelative(new Date(2026, 10, 8, 22, 30), NOW), '昨天 22:30');
  assert.equal(formatRelative(new Date(2026, 10, 7, 8, 0), NOW), '11-07');
  // 跨年
  assert.equal(formatRelative(new Date(2025, 11, 31, 23, 59), NOW), '2025-12-31');
});

test('formatRelative：边界与兜底不编造', () => {
  // 服务端时钟略快 ⇒ 负差值按「刚刚」，不渲染「-3 分钟前」
  assert.equal(formatRelative(new Date(NOW.getTime() + 3 * MIN), NOW), '刚刚');
  // 解析不了的值原样返回（不吞数据）
  assert.equal(formatRelative('not-a-time', NOW), 'not-a-time');
  assert.equal(formatRelative('', NOW), '');
  assert.equal(formatRelative(null, NOW), '');
  assert.equal(formatRelative(undefined, NOW), '');
  // 也接受 Date 与毫秒时间戳（90 分钟前 ⇒ 满一小时，给具体时刻）
  assert.equal(formatRelative(new Date(2026, 10, 9, 8, 30), NOW), '今天 08:30');
  assert.equal(formatRelative(new Date(2026, 10, 9, 8, 30).getTime(), NOW), '今天 08:30');
  // 不传 now 时用当前时刻：一小时前的值必须落在「N 分钟前」以外的可读形态里
  assert.doesNotMatch(formatRelative(new Date(Date.now() - DAY).toISOString()), /T\d{2}:\d{2}/);
});

test('formatDateTime：记录类时间带时刻（今天 / 昨天 HH:mm、MM-DD HH:mm）', () => {
  assert.equal(formatDateTime(new Date(2026, 10, 9, 8, 12), NOW), '今天 08:12');
  assert.equal(formatDateTime(new Date(2026, 10, 8, 23, 5), NOW), '昨天 23:05');
  assert.equal(formatDateTime(new Date(2026, 9, 14, 6, 0), NOW), '10-14 06:00');
  assert.equal(formatDateTime(new Date(2025, 9, 14, 6, 0), NOW), '2025-10-14 06:00');
  // 与 formatRelative 的差别只在「今天内不再压缩成刚刚／N 分钟前」——记录需要具体时刻
  assert.equal(formatDateTime(iso(5 * MIN), NOW), '今天 09:55');
  assert.equal(formatDateTime('2026-10-14T06:00:00.000Z', NOW), formatDateTime(new Date('2026-10-14T06:00:00.000Z'), NOW));
});

test('formatDate：来源取得时间只到日', () => {
  assert.equal(formatDate('2026-10-14T06:00:00.000Z', NOW), '2026-10-14');
  assert.equal(formatDate(new Date(2026, 0, 3, 23, 59), NOW), '2026-01-03');
  assert.equal(formatDate('', NOW), '');
  assert.equal(formatDate('2026-13-40', NOW), '2026-13-40', '解析不了就原样返回，不猜日期');
});

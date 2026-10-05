// 置信区间与统计工具（仅用 Node 标准库）。
// 规约：比例类指标用 Wilson 得分区间；聚合字符错误率(CER)用对样本的 bootstrap 百分位区间。
// 目标：确定性、可重复（bootstrap 使用固定种子）。

export const Z_95 = 1.959963984540054; // 双侧 95%

/** 比例 + Wilson 95% 置信区间。n=0 时返回 null 区间，避免 0 样本伪造结果。 */
export function wilsonInterval(successes, total, z = Z_95) {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total < 0 || successes < 0 || successes > total) {
    throw new Error(`wilsonInterval: 非法入参 successes=${successes} total=${total}`);
  }
  if (total === 0) return { p: null, low: null, high: null, n: 0, successes: 0 };
  const phat = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (phat + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total))) / denom;
  return {
    p: phat,
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
    n: total,
    successes,
  };
}

/** 确定性 PRNG（mulberry32），保证 bootstrap 可重复。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 聚合比率（如 CER = 总编辑距离 / 总参考长度）的 bootstrap 95% 百分位区间。
 * items: [{ distance, referenceLength }]（逐条样本）。
 * 返回 { p, low, high, n }，对样本有放回重采样 resamples 次。
 */
export function bootstrapRatioInterval(items, { seed = 20261004, resamples = 10000, alpha = 0.05 } = {}) {
  const usable = items.filter((it) => it && Number.isFinite(it.distance) && Number.isFinite(it.referenceLength));
  const totalRef = usable.reduce((s, it) => s + it.referenceLength, 0);
  if (usable.length === 0 || totalRef === 0) return { p: null, low: null, high: null, n: usable.length };
  const point = usable.reduce((s, it) => s + it.distance, 0) / totalRef;
  const rand = mulberry32(seed);
  const estimates = new Array(resamples);
  for (let i = 0; i < resamples; i += 1) {
    let d = 0;
    let r = 0;
    for (let j = 0; j < usable.length; j += 1) {
      const pick = usable[Math.floor(rand() * usable.length)];
      d += pick.distance;
      r += pick.referenceLength;
    }
    estimates[i] = r === 0 ? 0 : d / r;
  }
  estimates.sort((a, b) => a - b);
  const lo = estimates[Math.floor((alpha / 2) * (resamples - 1))];
  const hi = estimates[Math.floor((1 - alpha / 2) * (resamples - 1))];
  return { p: point, low: lo, high: hi, n: usable.length };
}

/** 字符级 Levenshtein 编辑距离（标准库实现，无依赖）。 */
export function levenshtein(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

/** 按统一去标点规则归一化：去除空白与常见中英文标点，用于字符错误率计算。 */
export function normalizeForCER(text) {
  return String(text)
    .replace(/[\s]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’（）()《》〈〉【】\[\]{}—–\-…·~`]/g, '');
}

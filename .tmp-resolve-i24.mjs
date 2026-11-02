import { readFileSync, writeFileSync } from 'node:fs';

const path = 'docs/verification/gy-i24-release-materials-index-20261017.md';
const src = readFileSync(path, 'utf8');

const START = '<<<<<<< HEAD\n';
const MID = '=======\n';
const END = '>>>>>>> origin/main\n';

/** 取第 n 个冲突块（1-based）。 */
function nthConflict(text, n) {
  let cursor = 0;
  for (let i = 1; i <= n; i += 1) {
    const start = text.indexOf(START, cursor);
    if (start < 0) throw new Error(`no start marker #${i}`);
    const mid = text.indexOf(MID, start);
    const end = text.indexOf(END, mid);
    if (mid < 0 || end < 0) throw new Error(`bad markers #${i}`);
    if (i === n) {
      return {
        start,
        end: end + END.length,
        ours: text.slice(start + START.length, mid),
        theirs: text.slice(mid + MID.length, end),
      };
    }
    cursor = end + END.length;
  }
  throw new Error('unreachable');
}

// 「当前读数」段起点 / 下一段（上一片读数）起点：用短锚点定位，避免复述整段超长文本
const CUR_START = '**当前读数（2026-11-03 GY-R73';
const PREV_START = '上一片读数（2026-11-02 GY-R72-W54';

const mergedPrefixCell = '**当前读数（2026-11-03 合流 origin/main：GY-R73 的 `0054` 与 R72 #838 的 `0053` 并存）**：'
  + '正向 `.sql` **53** 个（`0001..0054`，缺 `0037`＝#14 一个保留号）、`rollback/` **52** 个，'
  + '即 52 个 down 脚本（53 + 1 保留 === max 54）；合流前两条分支各自的读数并列保留（各自都对、不是谁让位）——'
  + '**（A）GY-R73 单独在树（迁移 `0054`）**：正向 `.sql` **52** 个（`0001..0054`，缺 `0037`＝#14 与 `0053`＝#838 两个保留号）、'
  + '`rollback/` **51** 个，即 51 个 down 脚本（52 + 2 保留 === max 54）；'
  + '**（B）R72 #838 单独在树（迁移 `0053`）**：正向 `.sql` **52** 个（`0001..0053`，缺 `0037`＝#14 保留）、'
  + '`rollback/` **51** 个，即 51 个 down 脚本（52 + 1 保留 === max 53）；';

const mergedPrefixGate = '**当前读数（2026-11-03 合流 origin/main：`0053` 与 `0054` 并存）**：'
  + '`migrations/` **53** 个（`0001..0054`，缺 `0037`，已在保留台账登记）、'
  + '`rollback/` **52** 个（`0002..0054`，缺 `0037`，共 52 个 down 脚本，53 正向 + 1 保留 === max 54）；'
  + '合流前两条分支各自的读数并列保留（各自都对、不是谁让位）——**（A）GY-R73 单独在树（`0054`）**：'
  + '`migrations/` **52** 个（`0001..0054`，缺 `0037` 与 `0053`）、`rollback/` **51** 个（52 + 2 保留 === max 54）；'
  + '**（B）R72 #838 单独在树（`0053`）**：`migrations/` **52** 个（`0001..0053`，缺 `0037`）、'
  + '`rollback/` **51** 个（52 + 1 保留 === max 53）；';

function resolveOurs(ours, mergedPrefix, label) {
  const a = ours.indexOf(CUR_START);
  const b = ours.indexOf(PREV_START, a + CUR_START.length);
  if (a < 0 || b < 0) throw new Error(`${label}: anchors not found (a=${a}, b=${b})`);
  return ours.slice(0, a) + mergedPrefix + ours.slice(b);
}

// 从后往前替，避免下标错位：先取块信息，再整体重写
const c1 = nthConflict(src, 1);
const c2 = nthConflict(src, 2);

const r1 = resolveOurs(c1.ours, mergedPrefixCell, 'cell');
const r2 = resolveOurs(c2.ours, mergedPrefixGate, 'gate8');

const out = src.slice(0, c1.start) + r1 + src.slice(c1.end, c2.start) + r2 + src.slice(c2.end);
writeFileSync(path, out, 'utf8');

console.log('ok. old bytes', src.length, 'new bytes', out.length);
console.log('theirs cell starts:', c1.theirs.slice(0, 120));
console.log('theirs gate8 starts:', c2.theirs.slice(0, 120));

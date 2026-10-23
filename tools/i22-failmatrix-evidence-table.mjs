/**
 * GY-I22（#22）失败矩阵 · 证据表生成器。
 *
 * 为什么要有这个工具：矩阵的期望值全部来自**真读数**，文档里的三列表
 * （用例 id → #22 acceptance 条目 → 实际读数）如果靠手抄，早晚会与代码漂移。
 * 这里改成「跑真矩阵 → 取机读结果 → 生成 Markdown → 写进证据页标记之间」：
 * 文档里的每一行读数都出自一次真实运行，重跑一次即可复核。
 *
 * 用法：
 *   node tests/failmatrix/run.mjs --json=tests/failmatrix/.artifacts/matrix.json
 *   node tools/i22-failmatrix-negative-control.mjs --json=tests/failmatrix/.artifacts/negative-control.json
 *   node tools/i22-failmatrix-evidence-table.mjs                                    # 打印到 stdout（对账，只读）
 *   node tools/i22-failmatrix-evidence-table.mjs --write --page=<目标页>            # 写进目标页标记之间
 *   node tools/i22-failmatrix-evidence-table.mjs --write --page=docs/verification/gy-i22-failmatrix-20261022.md \
 *        --i-know-this-rewrites-archive                                             # 归档页：带旗标也仍受条数一致性约束（当前必被拒）
 *
 * 标记（证据页里各一对，工具只替换标记之间的内容）：
 *   <!-- BEGIN:MATRIX-TABLE --> … <!-- END:MATRIX-TABLE -->
 *   <!-- BEGIN:NEGATIVE-CONTROL-TABLE --> … <!-- END:NEGATIVE-CONTROL-TABLE -->
 *
 * 归档页保护：真实路径比较 + 仓库内包含性校验；`--write` 无隐式默认页。本工具原来默认写
 * `docs/verification/gy-i22-failmatrix-20261022.md`——那是 R29 建页时的**归档快照**
 * （表格 168 行、负控制 23 条）。`EXPECTED` 随当前矩阵校正到 230 / 26 之后，
 * 那个默认值就变成「裸跑一次 --write 就把归档快照无报错重写成 230 行」，所以：
 *   1. `--write` 无隐式默认页：裸 `--write` 一律 exit 1，必须显式 `--page=`；
 *   2. 目标页先按仓库根解析成绝对路径，再取**真实路径**（`realpathSync.native`）后才比是不是归档页，
 *      Windows 上再统一小写。`docs/verification/./x.md`、`docs/verification/../verification/x.md`、
 *      `DOCS/verification/x.md` 这类**字符串别名**因此归到同一个真实路径，绕不过去；
 *   3. 目标页必须**在仓库内**：真实路径不以 `<仓库根><分隔符>` 开头就拒绝写入
 *      （`../outside.md` 这种越界目标在打开文件之前就被拒，不会写到仓库外）；
 *   4. 归档页只允许「同一基线刷新读数」：即便给了 `--i-know-this-rewrites-archive`，
 *      页内表格行数 / 负控制行数仍必须与 `EXPECTED` 逐项相等才放行。本页当前是 168 / 23、
 *      `EXPECTED` 是 230 / 26，所以带旗标也**必然被拒**——旗标只是一句「我知道这是归档页」的
 *      确认，不是绕过条数校验的开关；要刷新得先迁移台账口径，不是加个旗标改写历史快照；
 *   5. 所有写盘都在 `problems` 对账**之后**：对账不通过一律不写盘、exit 1。
 *
 * 退出码：0 = 生成成功且与运行结果自洽；1 = 条数/判定与文档声明不符，或写盘请求被拒绝
 * （不许悄悄少用例，也不许绕过上面的归档页保护）。
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 归档快照页：R29 建页时点（表格 168 行 / 负控制 23 条）的冻结记录。
 * 生成器**不再默认写它**；显式点名时按**真实路径**识别（字符串别名不算另一个目标），
 * 且即便给了 `--i-know-this-rewrites-archive` 也仍要过条数校验：本页 168 / 23 ≠ `EXPECTED` 230 / 26
 * ⇒ 当前必然被拒（见 `planWrite`）。
 */
const ARCHIVE_PAGE = 'docs/verification/gy-i22-failmatrix-20261022.md';

/** 页内两对生成器标记。写盘要求两对都在，否则拒绝。 */
const MARKERS = Object.freeze(['MATRIX-TABLE', 'NEGATIVE-CONTROL-TABLE']);

/** 每条用例的族 → #22 的 acceptance 条目（自评映射；最终由监工裁决）。 */
const FAMILY_ACCEPTANCE = Object.freeze({
  C1: 'AC01',
  C2: 'AC01/AC02',
  C3: 'AC02/AC07',
  C4: 'AC08/AC09',
  C5: 'AC09/AC13',
  C6: 'AC16',
  C7: 'AC19',
  E1: 'AC21（F08 提示注入只作数据）',
  E2: 'AC13/AC22（F20 媒体访问凭据）',
  D1: 'AC23（F13 任务状态机：旧回调不复活）',
  D2: 'AC21/AC23（F13/F20 AI 失败不得发布）',
  D3: 'AC22（G4 下架 ⇒ 缓存失效）',
  D4: 'AC22/AC29（内容版本变更 ⇒ 旧结论不复用）',
});

/**
 * 文档声明的条数；生成结果与之不符即失败（防止有人删用例让矩阵「变绿」）。
 *
 * 口径（三项都必须对得上才放行）：
 *   - `total` 数的是**失败矩阵的用例条数**：`run.mjs --json` 机读结果里「一行一条用例」的
 *     `rows.length`，本版 `totals.total` 与 `rows.length` 同为 230，逐族求和与逐批求和也都是 230。
 *   - `families` / `batches` 是同一批行的**分组计数**，各自的全集必须等于 `total`：
 *     C1…C7 + E1 + E2 + C10 + C11 + D1…D4 = 230；B1…B5 = 230。
 *   - `negativeControls` 数的是 `tests/failmatrix/mutations.mjs` 的 `MUTATIONS.length`（26）。
 *
 * 时点：`168` 是 R29 建页时点（只有 C1…C7 + E1 + E2 + D1…D4，见 `docs/verification/gy-i22-failmatrix-20261022.md`）
 * 的**同一口径旧读数**，不是另一个维度；R31 补上异步 AI 域 C10(23) + C11(39) ⇒ 168 + 23 + 39 = 230，
 * R34 负控制 23 → 26。本常量跟**当前**矩阵走。
 * ⚠️ 归档页那份 R29 快照（168 行 / 23 条）**不允许**被本常量改写成 230 行：`--write` 无隐式默认页，
 * 显式点名时按**真实路径**识别归档页，并且页内条数必须已经等于本常量（见 `planWrite`）。
 * 也就是说 `--i-know-this-rewrites-archive` 也改写不了它：本页当前 168 / 23 与 230 / 26 不一致 ⇒ 必然被拒。
 */
const EXPECTED = Object.freeze({
  families: { C1: 37, C2: 24, C3: 27, C4: 18, C5: 10, C6: 10, C7: 16, E1: 3, E2: 3, C10: 23, C11: 39, D1: 11, D2: 4, D3: 2, D4: 3 },
  batches: { B1: 106, B2: 36, B3: 17, B4: 9, B5: 62 },
  total: 230,
  negativeControls: 26,
});

function parseArgs(argv) {
  const out = {
    matrix: 'tests/failmatrix/.artifacts/matrix.json',
    nc: 'tests/failmatrix/.artifacts/negative-control.json',
    page: null,
    write: false,
    rewriteArchive: false,
  };
  for (const arg of argv) {
    if (arg === '--write') out.write = true;
    else if (arg === '--i-know-this-rewrites-archive') out.rewriteArchive = true;
    else if (arg.startsWith('--matrix=')) out.matrix = arg.slice('--matrix='.length);
    else if (arg.startsWith('--nc=')) out.nc = arg.slice('--nc='.length);
    else if (arg.startsWith('--page=')) out.page = arg.slice('--page='.length);
    else throw new Error(`未知参数：${arg}`);
  }
  return out;
}

function readJson(relative) {
  const file = path.join(ROOT, relative);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读不到运行结果 ${relative}：${error.message}\n先把矩阵与负控制各跑一遍并写 --json。`);
  }
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 16 ? `${sha.slice(0, 16)}…` : String(sha);
}

/**
 * 统一成仓库相对的 posix 形式，只用于**打印**与「`--page=` 是不是空」的判断。
 * ⚠️ 不要拿它判「是不是归档页」或「在不在仓库内」：`docs/verification/./x.md`、
 * `docs/verification/../verification/x.md`、`DOCS/verification/x.md` 都能从它手里溜过去，
 * 那三种写法指向的却是同一个文件。路径判定一律走下面的真实路径比较。
 */
function normalizeRel(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * 真实路径：存在就 `realpathSync.native`（一次解掉 `.`、`..`、符号链接与 Windows 大小写）；
 * 不存在时先解父目录、再把 basename 接回去（父目录也解不出来就退回原绝对路径）。
 * 只用于**比较**，不改变 `--page=` 的解析口径（按仓库根解析并校验包含性，越界拒绝）。
 */
function realPathOf(absolute) {
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(realPathOf(parent), path.basename(absolute));
  }
}

/** Windows（以及默认大小写不敏感的 macOS）上路径比较必须折叠大小写，否则 `DOCS/…` 能绕过。 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function foldCase(value) {
  return CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

/** 两个路径是不是同一个文件（按真实路径比；大小写不敏感的文件系统上折叠大小写）。 */
function samePath(left, right) {
  return foldCase(realPathOf(left)) === foldCase(realPathOf(right));
}

/**
 * `target` 的真实路径是否落在 `root` 之内（判的是 `<root><分隔符>` 前缀，不是字符串包含）：
 * 所以 `../outside.md`、`docs/../../outside.md` 这类越界目标一律 false，而 `root` 自身也是 false
 * ——目标页必须是一个仓库内的**文件**，不能是仓库根目录本身。
 */
function isInside(root, target) {
  const base = realPathOf(root);
  const prefix = foldCase(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
  return foldCase(realPathOf(target)).startsWith(prefix);
}

/** 标记对之间「以 `| \`` 开头」的表格行数；标记缺失返回 null。 */
function countGeneratedRows(page, marker) {
  const begin = `<!-- BEGIN:${marker} -->`;
  const end = `<!-- END:${marker} -->`;
  const start = page.indexOf(begin);
  const stop = page.indexOf(end);
  if (start < 0 || stop < 0 || stop < start) return null;
  return page.slice(start + begin.length, stop).split('\n').filter((line) => line.startsWith('| `')).length;
}

/** 页内声明的基线（矩阵表首行的「基线 xxxxxxxx」）；取不到就记「基线未知」。 */
function declaredBaseline(page) {
  const match = page.match(/基线\s+([0-9a-f]{7,40})/i);
  return match ? match[1] : '基线未知';
}

/**
 * 写盘意图闸门：**只读**，一个字节都不写。
 * 返回 `{ error }`（拒绝，调用方 exit 1）或 `{ rel, pagePath, page }`。
 *
 * 顺序上把「允许写哪里」放在对账之前：它判的是**意图**（是不是要拿生成器覆写归档页），
 * 与工件条数无关；真正落盘仍然在 `problems` 判定之后。
 *
 * 判据一律走**真实路径**（`realPathOf`），不走 `normalizeRel` 的字符串：后者只能把 `\` 换成 `/`、
 * 剥掉开头 `./` 与结尾 `/`，于是 `docs/verification/./x.md`、`docs/verification/../verification/x.md`、
 * `DOCS/verification/x.md` 三种写法都能绕过「是不是归档页」的字符串相等判断，真把归档快照改写掉。
 */
function planWrite(opts) {
  if (opts.page === null || normalizeRel(opts.page) === '') {
    return {
      error: [
        '拒绝写入：--write 必须显式指定 --page=<目标页>（本工具不再有隐式默认页）。',
        `  原来的默认页就是归档快照 ${ARCHIVE_PAGE}（R29 基线，表格 168 行 / 负控制 23 条），`,
        `  而当前 EXPECTED 是 ${EXPECTED.total} 行 / ${EXPECTED.negativeControls} 条；默认写盘等于把它悄悄重写成另一份快照。`,
        `  只读对账请直接跑 node tools/i22-failmatrix-evidence-table.mjs（不写盘）。`,
      ].join('\n'),
    };
  }

  const rel = normalizeRel(opts.page);
  // ① 按仓库根解析成绝对路径，再取真实路径：`.`、`..`、符号链接、Windows 大小写都在这一步归一，
  //    后面「是不是归档页」「在不在仓库内」都判这个值，不再判用户原样给的字符串。
  const pagePath = path.resolve(ROOT, rel);
  // ② 包含性校验放在读文件之前：越界目标（如 ../outside.md）在被打开之前就拒绝，绝不写到仓库外。
  if (!isInside(ROOT, pagePath)) {
    return {
      error: [
        `拒绝写入：目标不在仓库内（--page=${opts.page} ⇒ ${pagePath}）。`,
        '  --page= 按仓库根解析并校验包含性（越界拒绝）：目标页的真实路径必须落在仓库根之内，',
        '  否则生成器会写到仓库外（例如 ../outside.md 改掉的是兄弟目录里的文件），这里在写盘之前就拒绝。',
      ].join('\n'),
    };
  }
  let page;
  try {
    page = readFileSync(pagePath, 'utf8');
  } catch (error) {
    return {
      error: `拒绝写入：读不到目标页 ${rel}（${error.message}）。--page= 按仓库根解析并校验包含性（越界拒绝）。`,
    };
  }
  for (const marker of MARKERS) {
    if (!page.includes(`<!-- BEGIN:${marker} -->`) || !page.includes(`<!-- END:${marker} -->`)) {
      return { error: `拒绝写入：目标页 ${rel} 缺少标记 <!-- BEGIN:${marker} --> … <!-- END:${marker} -->` };
    }
  }

  // ③ 归档页判定：真实路径比较（`rel === ARCHIVE_PAGE` 那种字符串比较会被上面三种别名绕过）。
  //    死参数说明（选定方案 a：保留 `--i-know-this-rewrites-archive`，把提示语改成与实际行为一致）：
  //    该旗标现在**永远成功不了**——它只关掉「没给旗标」那道提示，条数校验仍然在；本页是 168 / 23 的
  //    冻结快照、EXPECTED 是 230 / 26，两者必然不等。所以旗标的语义只剩「我确认这是归档页，请按条数
  //    规则判」，真正的刷新路径是**迁移台账口径另建新页**，不是加旗标改写历史。提示语必须与这条一致。
  if (samePath(pagePath, path.resolve(ROOT, ARCHIVE_PAGE))) {
    const baseline = declaredBaseline(page);
    const rows = countGeneratedRows(page, 'MATRIX-TABLE');
    const ncRows = countGeneratedRows(page, 'NEGATIVE-CONTROL-TABLE');
    if (!opts.rewriteArchive) {
      return {
        error: [
          `拒绝写入归档快照：页 ${rel} 是基线 ${baseline} 的归档快照（页内表格 ${rows} 行 / 负控制 ${ncRows} 条），`,
          `当前 EXPECTED 是 ${EXPECTED.total} 行 / ${EXPECTED.negativeControls} 条。这份快照是 R29 的时点记录，`,
          '  --write 不再默认写它，也不提供「一步刷新历史快照」的路径。',
          '  若只是要补一句「我知道这是归档页」的确认，可以加 --i-know-this-rewrites-archive；',
          `  但即使给了旗标也仍受条数一致性约束：本页当前条目（${rows} / ${ncRows}）已过期，与 EXPECTED（${EXPECTED.total} / ${EXPECTED.negativeControls}）不一致 ⇒ 需要先迁移台账口径。`,
        ].join('\n'),
      };
    }
    if (rows !== EXPECTED.total || ncRows !== EXPECTED.negativeControls) {
      return {
        error: [
          `拒绝写入归档快照：页 ${rel} 是基线 ${baseline} 的快照，条数 ${rows} 与 EXPECTED ${EXPECTED.total} 不一致`,
          `（负控制 ${ncRows} 条 vs EXPECTED ${EXPECTED.negativeControls} 条）。`,
          '  即使给了 --i-know-this-rewrites-archive 也仍受条数一致性约束：本页当前条目已过期',
          '  （168 / 23 是 R29 时点读数），需要先迁移台账口径——把新口径落成新页或人工建页，',
          '  不要让生成器改写历史记录。',
        ].join('\n'),
      };
    }
  }

  return { rel, pagePath, page };
}

function renderMatrix(matrix) {
  const lines = [];
  lines.push(`一次真跑：${matrix.generated_at} · node ${matrix.node} · 基线 ${String(matrix.base_commit).slice(0, 10)} · 传输方式 \`${matrix.transport}\`。`);
  lines.push('');
  lines.push('| 用例 id | 族 | 期望 | 实际读数（status · code · cache · etag） | #22 acceptance（自评） | 判定 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of matrix.rows) {
    const expected = row.expected.status + (row.expected.code ? ` ${row.expected.code}` : '');
    const actual = [
      row.actual.status,
      row.actual.code ?? '—',
      row.actual.cache ?? '—',
      row.actual.etag ?? '—',
    ].join(' · ');
    lines.push(`| \`${row.id}\` | ${row.family} | ${cell(expected)} | ${cell(actual)} | ${cell(FAMILY_ACCEPTANCE[row.family] ?? '—')} | ${row.verdict} |`);
  }
  return lines.join('\n');
}

function renderNegativeControls(nc) {
  const lines = [];
  lines.push(`一次真跑：${nc.generated_at} · node ${nc.node} · **合计 ${nc.total} 条：PASS ${nc.pass} / FAIL ${nc.fail}**。`);
  lines.push('');
  lines.push('| 负控制 | 真改的那一处 | watch（必须真红） | sha256 改前（前 16 位） | 恢复后一致 | 判定 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const entry of nc.entries) {
    const files = entry.files ?? [entry.file];
    const before = entry.evidence?.sha256_before ?? {};
    const restored = Object.entries(before).map(([file, sha]) => `${path.basename(file)}=${shortSha(sha)}`).join('；');
    const same = String(entry.verdict === 'PASS');
    lines.push(
      `| \`${entry.id}\` ${cell(entry.title)} | ${cell(files.map((file) => `\`${file}\``).join(' + '))} | ${cell(entry.watch.join(', '))} | ${cell(restored)} | ${same} | ${entry.verdict} |`,
    );
  }
  return lines.join('\n');
}

function cell(text) {
  return String(text).replaceAll('|', '\\|');
}

function replaceBetween(page, marker, body) {
  const begin = `<!-- BEGIN:${marker} -->`;
  const end = `<!-- END:${marker} -->`;
  const start = page.indexOf(begin);
  const stop = page.indexOf(end);
  if (start < 0 || stop < 0 || stop < start) throw new Error(`证据页缺少标记 ${begin} … ${end}`);
  return `${page.slice(0, start + begin.length)}\n${body}\n${page.slice(stop)}`;
}

function check(expected, actual, where, problems) {
  if (expected !== actual) problems.push(`${where} 期望 ${expected} 条，实际 ${actual} 条`);
}

function main(argv) {
  const opts = parseArgs(argv);

  // ① 写盘意图闸门（只读）：裸 --write / 越权写归档页在这里就被拒，一个字节都不写。
  const target = opts.write ? planWrite(opts) : null;
  if (target?.error) {
    console.error(`✗ ${target.error}`);
    return 1;
  }

  const matrix = readJson(opts.matrix);
  const nc = readJson(opts.nc);
  const problems = [];

  check(EXPECTED.total, matrix.totals.total, '总条数', problems);
  for (const [family, count] of Object.entries(EXPECTED.families)) check(count, matrix.families[family]?.total, `族 ${family}`, problems);
  for (const [batch, count] of Object.entries(EXPECTED.batches)) {
    const row = (matrix.batches ?? []).find((one) => one.id === batch);
    check(count, row?.total, `批次 ${batch}`, problems);
  }
  const failed = matrix.rows.filter((row) => row.verdict !== 'PASS');
  if (failed.length > 0) problems.push(`矩阵有 ${failed.length} 条非 PASS：${failed.map((row) => row.id).join(', ')}`);
  check(EXPECTED.negativeControls, nc.total, '负控制条数', problems);
  if (nc.fail !== 0) problems.push(`负控制有 ${nc.fail} 条 FAIL`);

  const matrixTable = renderMatrix(matrix);
  const ncTable = renderNegativeControls(nc);

  // 打印口径与原来一致：无论写不写盘，都把两张表打到 stdout。
  console.log(matrixTable);
  console.log('');
  console.log(ncTable);

  // ② 对账不过 ⇒ 一律不写盘（写盘在 ③，且只在对账全绿时才到得了）。
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (target) console.error(`✗ 拒绝写入 ${target.rel}：对账不通过（上面 ${problems.length} 条），一个字节都没写。`);
    return 1;
  }

  // ③ 落盘。
  if (target) {
    let page;
    try {
      page = replaceBetween(target.page, 'MATRIX-TABLE', matrixTable);
      page = replaceBetween(page, 'NEGATIVE-CONTROL-TABLE', ncTable);
    } catch (error) {
      console.error(`✗ 拒绝写入 ${target.rel}：${error.message}`);
      return 1;
    }
    writeFileSync(target.pagePath, page, 'utf8');
    console.log(`写入 ${target.rel}：矩阵 ${matrix.rows.length} 行、负控制 ${nc.entries.length} 行`);
  }

  console.log(`自洽：矩阵 ${matrix.totals.total} 条全 PASS、负控制 ${nc.total} 条全 PASS，与文档声明一致。`);
  return 0;
}

process.exit(main(process.argv.slice(2)));

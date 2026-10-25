/**
 * 药害（除草剂药害 / herbicide damage）面「零实现」的只读回归钉（六条）。
 *
 * ## 这个文件是什么
 *
 * 取证复核（基线提交 `d16a2178` 是 `origin/main` 当日现值 `45345d3b` 的**祖先**，2026-10-26 核；
 * 本文件期望值在 `d16a2178` 上实测，5 个判据面自该提交起未变）：药害这条线是**零实现** ——
 * 真实样本 0、标注 0、契约 operation 0、端点 0、对样本的测试 0。
 * 仓库**有意**如此，不是遗漏：`docs/evaluation/sample-gap-register.md:36`（表 #18）把它登记成
 * 「无需求条目，门槛 N/A」，`:43-48` 的说明段原文是「第 18 行是「缺需求」而不是「缺数据」…
 * 故该行**门槛 N/A、不计入任何分母、不列为阻塞**」。
 *
 * 所以本文件**不**验证「药害识别准不准」（没有样本、没有需求、没有实现，无从验证），
 * 它验证**这条线没有被「顺手」接线**：
 *
 * | # | 判据位置 | 断言什么 | 什么改动会让它红 |
 * | - | --- | --- | --- |
 * | 1 | `packages/contracts/openapi.json` 的 `paths`（`:20` 起，118 个 `operationId`，`:23`–`:11303`） | `operationId` 与 `path` **都不含** `damage` / `herbicide_damage` / `phytotox` / `injury`（大小写不敏感）；正向控制：`operationId` 总数 118、去重后 118、`admin` 子集恰好 17 条、herbicide 参照面恰好 `getHerbicide`/`listHerbicides`、`path` 总数 89 | 任何 damage 类 operation 被塞进契约（含把现成 operation **改名**成 `…Damage…`，总数不变也会红） |
 * | 2 | 同文件的 `operationId` 全集 | 不含 `observation` / `feedback` / `symptom` / `observe`（整条线**本无任何 operation**，连只读观察面都没有） | 给这条线补「观察/反馈/症状」端点，或把现成 operation 改名带这些词 |
 * | 3 | `tests/evaluation/fixtures/synthetic-index.json`（顶层**数组**，50 条，首条 `task` 在 `:5`） | `task` 取值集合 `deepEqual` 到实际七类 `['ai_moderation','asr','label_ocr','qa','registration_match','tts','weed_photo']`，且逐类条数 `deepEqual` 到 `{weed_photo:16,label_ocr:6,registration_match:4,ai_moderation:8,tts:4,asr:4,qa:8}`；并单独断 damage 零命中 | 往评测夹具里塞一条 `damage` 任务（哪怕同时删掉一条别的，逐类计数也会红） |
 * | 4 | `packages/evaluation/samples/gy-i20-weeds-labels.json` 的 `entries`（`:23` 起，172 条，`labelClass` 在 `:27`–`:1672`） | `labelClass` 前缀**只**有 `ext_weed`（165 条，`^\d{3}$`）与 `species`（7 条，`[a-z_]+`）两类，172 条**互不相同**；损伤类字面量（`damage`/`injury`/`phytotox`/`symptom`）零命中 | 给标签集加一个损伤类 `labelClass`（如 `damage_light`）——它既破前缀集合，也破计数 |
 * | 5 | `services/api/src/routes/` 下全部 `.ts`（恰好 22 个文件） | 全部文件内容**不含** `damage` / `phytotox`（大小写不敏感）；命中时打印 `文件:行号` | 路由层出现 damage 端点/注释/字段名 |
 * | 6 | `docs/evaluation/sample-gap-register.md:36`（表 #18 整行）与 `:43-48`（「缺需求」说明段 6 行） | 表 #18 **整行逐字**保持「无需求条目，门槛 N/A / 空（无样本，也无需求）/ N/A / 否」；说明段 6 行**逐行 deepEqual**，且「缺需求」「门槛 N/A」「不计入任何分母」「不列为阻塞」四个关键词各自**只**落在原行上 | 谁把「缺需求」改成「有门槛」（哪怕只改一个格子、或把「不计入任何分母」改成「计入分母」） |
 *
 * ## 为什么「精确」而非「模糊」判据
 *
 * 缺口钉子的全部价值是「一被接线就红」。一旦放宽成 `includes` / `>=` / `> 0`，
 * 「加一条 damage 任务」这种**只多一条**的改动就会漏过去（总数从 50 变 51，`>=` 仍然绿）。
 * 所以这里全部用 `assert.equal` / `assert.deepEqual`（`node:assert/strict`），
 * 连正向控制都是**逐条集合相等**，不接受「至少 N 条」。
 *
 * 判据里的「关键词出现」同样用 `deepEqual(文档真实行.filter(含该词), [原行…])` 表达 ——
 * 既钉住「这个词还在」，也钉住「它没跑到别的行去」。
 * ⚠ 过滤对象必须是**读进来的文档行**；过滤期望值常量自己是恒真判据（判据与数据同源，
 * 永远不会失败），旧版就在这里翻了车（见钉 6 主断言 ③）。
 *
 * ## 红的时候怎么办
 *
 * 红 ≠ 你写错了，红 = **这条线的登记状态变了**。正确处置是**走需求评审**，不是放宽判据：
 * 立需求条目（`docs/implementation-requirements.md`、`docs/product-requirements.md`）
 * → 同步 `docs/evaluation/sample-gap-register.md` 第 18 行与其说明段、`docs/evaluation/threshold-basis.md`
 * → 再把本文件对应的钉子翻到新事实。
 *
 * ## 硬约束（改本文件时不许破）
 *
 * - **只读**：不建临时目录、不写仓内任何文件、不起子进程、不连库、不 import 被测模块
 *   （**故意**：import 会让「文件还在、内容被换掉」这类漂移测不出来）。
 * - **零外部依赖**：只用 `node:fs` / `node:path` / `node:url` + `node:test` / `node:assert`。
 * - **断言只用严格相等**：⛔ 不用 `assert.ok(x.length >= 1)`、⛔ 不用 `assert.match` 兜模糊匹配。
 * - **`includes` 只干两件事（实测，不是声称）**：本文件**代码里还剩 2 处** `includes` ——
 *   ① **判据位 1 处**（钉 6 主断言 ③：`lines.filter((line) => line.includes(needle))`，在**文档
 *   真实行**里挑出命中行），它**包在 `assert.deepEqual` 里做精确集合相等**：挑出来的行必须与
 *   期望行**逐行逐字**相等 —— 多一行、少一行、改一个字都红，⛔ 不是「至少包含」式裸判据；
 *   ② **行号换算 1 处**（`labelLines.findIndex(...)` 那一处：把命中的 `labelClass` 换算成
 *   `文件:行号` 供失败文案打印），不参与判据。其余 `includes` 只出现在注释与失败文案字符串里
 *   （文案里的 `includes` 不构成判据）。
 * - 用例数固定 6；⛔ 无 `skip` / `only` / `todo`。
 *
 * 单跑：`node --test tests/unit/herbicide-damage-absence-pins.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` 的上两级），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 基线提交（`origin/main` 的**祖先**；钉子读取的 5 个判据面自该提交起未变）：
 * 所有期望值都是在这个 SHA 上**实测**出来的，不是抄文档。
 *
 * 实测依据（2026-10-26，`origin/main` = `45345d3b`）：
 * `git merge-base --is-ancestor d16a2178 45345d3b` ⇒ 0（是祖先）；
 * `git diff d16a2178 45345d3b -- packages/contracts/openapi.json
 * tests/evaluation/fixtures/synthetic-index.json packages/evaluation/samples/gy-i20-weeds-labels.json
 * services/api/src/routes docs/evaluation/sample-gap-register.md` ⇒ 空（5 个判据面未变），
 * 该区间的差异只在 `docs/architecture/**`、`docs/verification/**` 与 `tests/unit/**`。
 * ⛔ 别把本常量改成「现值」来「对齐」：期望值是在**这个** SHA 上测的。
 */
const BASELINE_SHA = 'd16a2178a4489101933c6907ccfa682da746f7a8';

/** 药害线的登记处（钉 1/2/6 的「口径出处」）。 */
const REGISTER = 'docs/evaluation/sample-gap-register.md';

/**
 * 每条钉子红的时候都要说的同一段话：这是**登记状态变了**，请走需求评审 + 翻转钉子，
 * ⛔ 不是把判据改松。
 */
const PIN_HINT = '\n\n👉 药害线的**现状口径**（基线 ' + BASELINE_SHA + '）：「缺需求」、无真实样本、无标注、'
  + '无契约 operation、无端点、无对样本的测试 —— 是**缺需求**，不是缺数据。'
  + `\n  真要动这条线，先走需求评审：立需求条目（docs/implementation-requirements.md、docs/product-requirements.md）`
  + `→ 同步 ${REGISTER} 第 18 行（:36）与其说明段（:43-48）、docs/evaluation/threshold-basis.md`
  + ' → 再把本文件对应的钉子翻到新事实。'
  + '\n⛔ 不要为了让本文件变绿而放宽判据（换成 `includes` / `>=` / `> 0` / 模糊正则都算），'
  + '也不要删掉这一条 —— 本文件的全部价值就是「药害面一被顺手接线就红」。';

/** 遍历时跳过的目录：依赖、构建产物、VCS。判据面是**源码树**。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/** Windows 分隔符归一化成 `/`，让「仓库相对路径」在所有平台上都是同一个字符串。 */
const toPosix = (p) => p.split(sep).join('/');

/**
 * 读一个**仓库相对路径**的 UTF-8 文本。
 *
 * @param {string} relPosix 例：`packages/contracts/openapi.json`
 * @returns {string}
 */
function readRepoText(relPosix) {
  const abs = join(REPO_ROOT, ...relPosix.split('/'));
  assert.equal(
    existsSync(abs),
    true,
    `判据位置不存在：${relPosix}\n`
      + '本钉子的判据面少了一个文件 ⇒ 若它只是搬家，请先确认新位置再改本文件；'
      + '⛔ 不要靠删断言让它变绿。'
      + PIN_HINT,
  );
  return readFileSync(abs, 'utf8');
}

/**
 * 按行切分（先归一 CRLF）。本仓全为 LF，但 EOL 规范化轮次动过行尾，
 * 归一后本文件的「逐行 deepEqual」不会因为行尾变了而假红。
 *
 * @param {string} text
 * @returns {string[]}
 */
const linesOf = (text) => text.replace(/\r\n/g, '\n').split('\n');

/**
 * 递归列出某个仓库相对目录下的**全部文件**（仓库相对 POSIX 路径，已排序）。
 *
 * @param {string} rootRelPosix 例：`services/api/src/routes`
 * @returns {string[]}
 */
function walkFiles(rootRelPosix) {
  const absRoot = join(REPO_ROOT, ...rootRelPosix.split('/'));
  assert.equal(
    existsSync(absRoot),
    true,
    `扫描根不存在：${rootRelPosix}（目录改名/被删 ⇒ 本钉子的「零命中」会退化成空转，故先在这里 red）`
      + PIN_HINT,
  );
  /** @type {string[]} */
  const out = [];
  const visit = (dirAbs) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      // 软链不跟：可能指回本目录造成环，也可能指到 node_modules。
      if (entry.isSymbolicLink()) continue;
      const childAbs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        visit(childAbs);
      } else if (entry.isFile()) {
        out.push(toPosix(relative(REPO_ROOT, childAbs)));
      }
    }
  };
  visit(absRoot);
  return out.sort();
}

/**
 * 在若干行里挑出**匹配**的行，带 1 起行号（和 `git grep -n` 口径一致）。
 *
 * 用于「命中时打印 文件:行号」：本文件的所有扫描面都是文本，行号是最短的定位方式。
 *
 * @param {string[]} lines
 * @param {RegExp} pattern 必须是**无 `g` 标志**的正则（否则 `test` 会因 `lastIndex` 抖动）
 * @returns {Array<{ line: number, text: string }>}
 */
function scanLines(lines, pattern) {
  /** @type {Array<{ line: number, text: string }>} */
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim() });
  }
  return hits;
}

/**
 * 读契约并抽出 `{ paths, operations }`。
 *
 * 只抽 `paths[*][method].operationId` 为字符串的条目 —— 这正是「operation」的定义面。
 * 抽漏会在钉 1 的总数正向控制上直接红（118 条），不会静默空转。
 *
 * @returns {{
 *   text: string,
 *   lines: string[],
 *   paths: string[],
 *   operations: Array<{ operationId: string, method: string, path: string }>,
 * }}
 */
function readContract() {
  const rel = 'packages/contracts/openapi.json';
  const text = readRepoText(rel);
  const doc = JSON.parse(text);
  /** @type {Array<{ operationId: string, method: string, path: string }>} */
  const operations = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (item === null || typeof item !== 'object') continue;
    for (const [method, op] of Object.entries(item)) {
      if (op === null || typeof op !== 'object') continue;
      if (typeof op.operationId !== 'string') continue;
      operations.push({ operationId: op.operationId, method, path });
    }
  }
  return { text, lines: linesOf(text), paths: Object.keys(doc.paths), operations };
}

/** 契约里每个 `operationId` 落在第几行（命中打印用）。 */
function operationIdLineMap(lines) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const matched = /"operationId":\s*"([^"]+)"/.exec(lines[i]);
    if (matched !== null) map.set(matched[1], i + 1);
  }
  return map;
}

/** 契约里每个 `path` 键落在第几行（命中打印用）。 */
function pathLineMap(lines) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const matched = /^ {4}"([^"]+)":\s*\{$/.exec(lines[i]);
    if (matched !== null) map.set(matched[1], i + 1);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 钉 1 · 契约零 damage operation
// ---------------------------------------------------------------------------

/** 药害面的禁用词（大小写不敏感）。`herbicide_damage` 被 `damage` 覆盖，留着是为了**自证**禁用词表。 */
const DAMAGE_NEEDLE = /damage|herbicide_damage|phytotox|injury/i;

/** 基线实测：`operationId` 总数（`paths[*][method].operationId`）。 */
const CONTRACT_OPERATION_COUNT = 118;

/** 基线实测：`path` 总数（`Object.keys(doc.paths)`）。 */
const CONTRACT_PATH_COUNT = 89;

/** 基线实测：`operationId` 里含 `admin` 的**全部** 17 条（逐条钉住，⛔ 不是 `>=`）。 */
const ADMIN_OPERATION_IDS = [
  'cancelAdminJob',
  'getAdminKnowledge',
  'getAdminRegistration',
  'getAdminRestriction',
  'getAdminSession',
  'getAdminSource',
  'listAdminCategories',
  'listAdminJobs',
  'listAdminKnowledge',
  'listAdminRegistration',
  'listAdminRestriction',
  'listAdminSources',
  'listAdminUsers',
  'listAdministratorScopes',
  'listAdministrators',
  'loginAdmin',
  'logoutAdmin',
];

/**
 * 基线实测：契约里**唯一**含 `herbicide` 的 operation —— 除草剂**资料查询**（正面参照面，
 * 与「药害」无关）。它证明禁用词是 `herbicide_damage` 这条**合成词**，不是 `herbicide` 本身：
 * 「除草剂」是既有能力，「药害」不是。
 */
const HERBICIDE_REFERENCE_OPERATION_IDS = ['getHerbicide', 'listHerbicides'];

test('钉 1 · 契约零 damage operation：operationId 与 path 都不含 damage/herbicide_damage/phytotox/injury', () => {
  const { lines, paths, operations } = readContract();
  const operationIds = operations.map((operation) => operation.operationId);

  // ── 正向控制（三条）────────────────────────────────────────────────────
  // ① 总数：证明上面真的把 118 个 operation 抽出来了（不是 0 条空转）。
  assert.equal(
    operationIds.length,
    CONTRACT_OPERATION_COUNT,
    '【钉 1 · 正向控制破了】`operationId` 总数不再是基线值。'
      + `\n  实测：${operationIds.length}（基线 ${CONTRACT_OPERATION_COUNT}）`
      + '\n  这条控制的作用：证明本钉子真的抽完了契约的 operation 面，而不是「零命中」其实什么都没读到。'
      + '\n  若你**新增/删除了契约 operation**（与药害无关的正常需求）⇒ 把本常数改成新读数即可，'
      + '下面的 damage 判据不受影响；若你动的正是药害面 ⇒ 按钉 1 主断言的提示走需求评审。'
      + PIN_HINT,
  );

  // ② 去重后仍是 118：`operationId` 在契约里必须唯一（重复会让「按名判 damage」失真）。
  assert.equal(
    new Set(operationIds).size,
    CONTRACT_OPERATION_COUNT,
    '【钉 1 · 正向控制破了】`operationId` 出现重复（去重后条数 < 总数）。'
      + `\n  实测：总数 ${operationIds.length} / 去重后 ${new Set(operationIds).size}`
      + '\n  契约里 `operationId` 必须唯一；重复会让「按名判 damage」这类判据失真。'
      + PIN_HINT,
  );

  // ③ admin 子集逐条相等（`deepEqual`：17 条，多一条/少一条/改名都红）。
  assert.deepEqual(
    operationIds.filter((id) => /admin/i.test(id)).sort(),
    ADMIN_OPERATION_IDS,
    '【钉 1 · 正向控制破了】`operationId` 里含 `admin` 的那组变了：'
      + `\n  实测：${JSON.stringify(operationIds.filter((id) => /admin/i.test(id)).sort())}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(ADMIN_OPERATION_IDS)}`
      + '\n  这条控制的作用：`admin` 是**必定存在**的命名族，它逐条相等才说明「按名扫契约」这条路是通的；'
      + '否则「damage 零命中」可能只是扫错了地方。'
      + '\n  若后台端新增/改名了 admin operation（与药害无关）⇒ 同步这份清单。'
      + PIN_HINT,
  );

  // ④ herbicide 正面参照：证明禁用词表精确到 `herbicide_damage`，没误伤既有的「除草剂资料查询」。
  assert.deepEqual(
    operationIds.filter((id) => /herbicide/i.test(id)).sort(),
    HERBICIDE_REFERENCE_OPERATION_IDS,
    '【钉 1 · 参照面变了】契约里含 `herbicide` 的 operation 集合变了：'
      + `\n  实测：${JSON.stringify(operationIds.filter((id) => /herbicide/i.test(id)).sort())}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(HERBICIDE_REFERENCE_OPERATION_IDS)}`
      + '（除草剂**资料查询**，既有能力，与药害无关）。'
      + '\n  这条同时守住禁用词表的口径：禁的是 `herbicide_damage`（药害），**不是** `herbicide`（除草剂）。'
      + '\n  若新增的是除草剂资料类 operation ⇒ 同步这份清单；若新增的带 damage/phytotox/injury ⇒ '
      + '那不是「参照面变了」，是药害面被接线，按主断言处理。'
      + PIN_HINT,
  );

  // ⑤ path 总数：证明 `path` 面也被完整读到了。
  assert.equal(
    paths.length,
    CONTRACT_PATH_COUNT,
    '【钉 1 · 正向控制破了】契约 `path` 总数不再是基线值。'
      + `\n  实测：${paths.length}（基线 ${CONTRACT_PATH_COUNT}）`
      + '\n  若你新增/删除了 path（与药害无关）⇒ 改本常数；若新增的 path 带 damage/phytotox/injury ⇒ 按主断言处理。'
      + PIN_HINT,
  );

  // ── 主断言 ①：operationId 零命中 ───────────────────────────────────────
  const idHits = operations.filter((operation) => DAMAGE_NEEDLE.test(operation.operationId));
  const idLineMap = operationIdLineMap(lines);
  assert.deepEqual(
    idHits.map((hit) => hit.operationId).sort(),
    [],
    '【钉 1 破了】契约里出现了 damage 类 `operationId`（药害面被接进契约）：'
      + `\n  实测命中：${JSON.stringify(
        idHits.map((hit) => `packages/contracts/openapi.json:${idLineMap.get(hit.operationId) ?? '?'}`
          + ` ${hit.operationId}（${hit.method.toUpperCase()} ${hit.path}）`).sort(),
      )}`
      + `\n  基线（${BASELINE_SHA}）：118 个 operation 里 damage / herbicide_damage / phytotox / injury **零命中** —— `
      + '药害是「缺需求」，契约里从来没有这条线（证据：' + REGISTER + ':36、:43-48）。'
      + '\n  ⚠ 注意这条钉子连「**改名**」也能抓：把现成 operation 改成 `…Damage…`、总数不变，同样会红。'
      + '\n  处置：⛔ 不要删这条断言、也不要把判据改宽。先走需求评审（见下），再翻转本钉子。'
      + PIN_HINT,
  );

  // ── 主断言 ②：path 零命中 ────────────────────────────────────────────
  const pathHits = paths.filter((path) => DAMAGE_NEEDLE.test(path));
  const pathLines = pathLineMap(lines);
  assert.deepEqual(
    pathHits.sort(),
    [],
    '【钉 1 破了】契约里出现了 damage 类 `path`（药害面被接进契约）：'
      + `\n  实测命中：${JSON.stringify(
        pathHits.map((path) => `packages/contracts/openapi.json:${pathLines.get(path) ?? '?'} ${path}`).sort(),
      )}`
      + `\n  基线（${BASELINE_SHA}）：89 条 path 里 damage / herbicide_damage / phytotox / injury **零命中**。`
      + PIN_HINT,
  );
});

// ---------------------------------------------------------------------------
// 钉 2 · 契约零观察 / 反馈面
// ---------------------------------------------------------------------------

/** 药害线「观察/反馈/症状」面的禁用词（大小写不敏感）。 */
const OBSERVATION_NEEDLE = /observation|feedback|symptom|observe/i;

test('钉 2 · 契约零观察/反馈面：operationId 不含 observation/feedback/symptom/observe', () => {
  const { paths, operations } = readContract();
  const operationIds = operations.map((operation) => operation.operationId);

  // 正向控制：总数仍是 118（口径同钉 1 ①；这条独立重算，避免两条钉子共用一次读取而互相掩盖）。
  assert.equal(
    operationIds.length,
    CONTRACT_OPERATION_COUNT,
    '【钉 2 · 正向控制破了】`operationId` 总数变了，本钉子的「零命中」不可信。'
      + `\n  实测：${operationIds.length}（基线 ${CONTRACT_OPERATION_COUNT}）`
      + '\n  先看钉 1 ①：口径与它一致；若你确实改了契约 operation 面，两处一起改。'
      + PIN_HINT,
  );

  // 主断言 ①：operationId 零命中。
  const idHits = operations.filter((operation) => OBSERVATION_NEEDLE.test(operation.operationId));
  assert.deepEqual(
    idHits.map((hit) => hit.operationId).sort(),
    [],
    '【钉 2 破了】契约里出现了「观察/反馈/症状」类 `operationId`：'
      + `\n  实测命中：${JSON.stringify(
        idHits.map((hit) => `${hit.operationId}（${hit.method.toUpperCase()} ${hit.path}）`).sort(),
      )}`
      + `\n  基线（${BASELINE_SHA}）：118 个 operation 里 observation / feedback / symptom / observe **零命中**。`
      + '\n  这条钉的是取证结论的另一半：药害线不只是「没有 damage operation」，而是**整条线连一个 operation 都没有** —— '
      + '没有「药害观察记录」「药害反馈」「症状上报」这类只读面，故也不能用「只是加了个只读观察接口」来绕过钉 1。'
      + '\n  处置：先走需求评审，再翻转本钉子。'
      + PIN_HINT,
  );

  // 主断言 ②：path 零命中（同一口径落到 URL 面 —— 观察面常常先落在路径上）。
  const pathHits = paths.filter((path) => OBSERVATION_NEEDLE.test(path));
  assert.deepEqual(
    pathHits.sort(),
    [],
    '【钉 2 破了】契约里出现了「观察/反馈/症状」类 `path`：'
      + `\n  实测命中：${JSON.stringify(pathHits.sort())}`
      + `\n  基线（${BASELINE_SHA}）：89 条 path 里 observation / feedback / symptom / observe **零命中**。`
      + PIN_HINT,
  );
});

// ---------------------------------------------------------------------------
// 钉 3 · 评测任务集合不含 damage
// ---------------------------------------------------------------------------

/** 基线实测：`synthetic-index.json` 的 `task` 取值全集（实际 7 类，逐条列出）。 */
const EVAL_TASKS = [
  'ai_moderation',
  'asr',
  'label_ocr',
  'qa',
  'registration_match',
  'tts',
  'weed_photo',
];

/** 基线实测：逐类条数（合计 50，与下面的总数控制互相印证）。 */
const EVAL_TASK_COUNTS = {
  weed_photo: 16,
  label_ocr: 6,
  registration_match: 4,
  ai_moderation: 8,
  tts: 4,
  asr: 4,
  qa: 8,
};

/** 基线实测：夹具条数。 */
const EVAL_SAMPLE_COUNT = 50;

test('钉 3 · 评测任务集合不含 damage：task 取值恰为七类且逐类条数不变', () => {
  const rel = 'tests/evaluation/fixtures/synthetic-index.json';
  const samples = JSON.parse(readRepoText(rel));

  assert.equal(
    Array.isArray(samples),
    true,
    `【钉 3 · 判据位置变了】${rel} 的顶层不再是数组（判据假设它是样本数组）：`
      + `\n  实测类型：${Array.isArray(samples) ? 'array' : typeof samples}`
      + '\n  若夹具被换成「带 tasks 字段的对象」⇒ 先确认新形状，再同步本钉子的读法（⛔ 别直接删）。'
      + PIN_HINT,
  );

  // 正向控制 ①：条数。
  assert.equal(
    samples.length,
    EVAL_SAMPLE_COUNT,
    `【钉 3 · 正向控制破了】${rel} 的样本条数变了：`
      + `\n  实测：${samples.length}（基线 ${EVAL_SAMPLE_COUNT}）`
      + '\n  若你新增/删除了与药害无关的合成样本 ⇒ 改本常数与下面的逐类计数。'
      + PIN_HINT,
  );

  const tasks = samples.map((sample) => sample.task);

  // 正向控制 ②：task 取值集合逐条相等。
  assert.deepEqual(
    [...new Set(tasks)].sort(),
    EVAL_TASKS,
    `【钉 3 破了】${rel} 的 \`task\` 取值集合变了：`
      + `\n  实测：${JSON.stringify([...new Set(tasks)].sort())}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(EVAL_TASKS)}`
      + '\n  处置：若新增的是**药害**任务（damage / phytotox / injury / symptom…）⇒ 那是把药害面接进了评测，'
      + '必须先走需求评审（药害目前「无需求条目、门槛 N/A、不计入任何分母」，见 '
      + `${REGISTER}:36、:43-48），再翻转本钉子；\n  若是与药害无关的正常任务 ⇒ 同步这份清单与下方逐类计数。`
      + PIN_HINT,
  );

  // 正向控制 ③：逐类条数逐项相等（同时挡住「加一条 damage、删一条别的」这种配平手法）。
  /** @type {Record<string, number>} */
  const counts = {};
  for (const task of tasks) counts[task] = (counts[task] ?? 0) + 1;
  assert.deepEqual(
    counts,
    EVAL_TASK_COUNTS,
    `【钉 3 破了】${rel} 的逐类条数变了：`
      + `\n  实测：${JSON.stringify(counts)}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(EVAL_TASK_COUNTS)}`
      + '\n  这条判据的意义：只钉「集合」时，删一条无关样本、加一条 damage 样本仍可能让集合相等；'
      + '逐类计数相等把这种**配平**也挡住。'
      + PIN_HINT,
  );

  // 主断言：damage 零命中（单独一条，红的时候点得更准，并给出条目下标/样本 id）。
  const damageSamples = samples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => DAMAGE_NEEDLE.test(String(sample.task)) || DAMAGE_NEEDLE.test(String(sample.sampleId)));
  assert.deepEqual(
    damageSamples.map(({ sample }) => `${sample.sampleId}(task=${sample.task})`).sort(),
    [],
    `【钉 3 破了】${rel} 里出现了 damage 类样本（task 或 sampleId 命中禁用词）：`
      + `\n  实测命中：${JSON.stringify(
        damageSamples.map(({ sample, index }) => `[${index}] ${sample.sampleId} task=${sample.task}`),
      )}`
      + `\n  基线（${BASELINE_SHA}）：50 条合成样本里 damage / herbicide_damage / phytotox / injury **零命中**。`
      + '\n  药害没有需求、没有样本、没有标签 —— 往夹具里加一条「damage 样本」等于凭空造出一个评测分母。'
      + PIN_HINT,
  );
});

// ---------------------------------------------------------------------------
// 钉 4 · 标签集无损伤类 labelClass
// ---------------------------------------------------------------------------

/**
 * 基线实测：`labelClass` 的合法前缀规则（`ext_weed_###` 与 `species_xxx` 两类）。
 *
 * 前缀是**闭集**：`split('_')[0]` 那种切法会把 `ext_weed_002` 切成 `ext`，看不出「两类」，
 * 所以这里用完整模式判定，前缀即模式名。
 */
const LABEL_PREFIX_RULES = [
  { prefix: 'ext_weed', pattern: /^ext_weed_\d{3}$/ },
  { prefix: 'species', pattern: /^species_[a-z_]+$/ },
];

/** 基线实测：各前缀条数（合计 172 = 标签集条数）。 */
const LABEL_PREFIX_COUNTS = { ext_weed: 165, species: 7 };

/** 基线实测：标签集条数 / `labelClass` 去重后条数。 */
const LABEL_ENTRY_COUNT = 172;

/** 损伤类禁用词（大小写不敏感）。 */
const INJURY_LABEL_NEEDLE = /damage|injury|phytotox|symptom/i;

test('钉 4 · 标签集无损伤类 labelClass：前缀只有 ext_weed / species 两类', () => {
  const rel = 'packages/evaluation/samples/gy-i20-weeds-labels.json';
  const text = readRepoText(rel);
  const doc = JSON.parse(text);

  assert.equal(
    Array.isArray(doc.entries),
    true,
    `【钉 4 · 判据位置变了】${rel} 的 \`entries\` 不再是数组：`
      + `\n  实测：${Array.isArray(doc.entries) ? 'array' : typeof doc.entries}`
      + '\n  该文件是 `gengyun.evaluation.weed-labels.v1`，逐条标注在 `entries[]`；'
      + '若结构改了 ⇒ 先确认新位置再改本钉子。'
      + PIN_HINT,
  );

  const entries = doc.entries;
  const labelClasses = entries.map((entry) => entry.labelClass);

  // 正向控制 ①：条数。
  assert.equal(
    labelClasses.length,
    LABEL_ENTRY_COUNT,
    `【钉 4 · 正向控制破了】${rel} 的 \`entries\` 条数变了：`
      + `\n  实测：${labelClasses.length}（基线 ${LABEL_ENTRY_COUNT}）`
      + '\n  若你新增/删除了拍草样本 ⇒ 改本常数与下方两类计数（拍草域的样本口径见 '
      + 'docs/evaluation/sample-gap-register.md:19-22）。'
      + PIN_HINT,
  );

  // 正向控制 ②：`labelClass` 逐条互不相同（172 条 → 172 个不同值；同名会让逐类计数失真）。
  assert.equal(
    new Set(labelClasses).size,
    LABEL_ENTRY_COUNT,
    `【钉 4 · 正向控制破了】${rel} 的 \`labelClass\` 出现重复：`
      + `\n  实测：${labelClasses.length} 条 / 去重后 ${new Set(labelClasses).size} 个不同值`
      + '\n  基线（' + BASELINE_SHA + '）：172 条标签逐条不同名（`ext_weed_###` 与 `species_*` 各一）。'
      + PIN_HINT,
  );

  // 主断言 ①：前缀**闭集**恰好两类（`deepEqual` 集合，多一类/少一类都红）。
  const prefixes = [...new Set(labelClasses.map((value) => {
    const rule = LABEL_PREFIX_RULES.find((candidate) => candidate.pattern.test(value));
    // 规则外的值按原值登记，让「悄悄多一类前缀」在 deepEqual 上直接现形。
    return rule === undefined ? `<未登记前缀>:${value}` : rule.prefix;
  }))].sort();
  assert.deepEqual(
    prefixes,
    ['ext_weed', 'species'],
    `【钉 4 破了】${rel} 的 \`labelClass\` 前缀集合变了：`
      + `\n  实测：${JSON.stringify(prefixes)}`
      + `\n  基线（${BASELINE_SHA}）：只有 ${JSON.stringify(['ext_weed', 'species'])} 两类 —— `
      + '`ext_weed_###`（172 条里的 165 条，来源文档条目）与 `species_*`（7 个规范物种 ID）。'
      + '\n  标签集是**拍草识别**的答案键，不是药害分级的答案键：药害没有需求条目、没有样本、没有门槛'
      + `（${REGISTER}:36、:43-48），故这里不允许出现损伤类前缀。`
      + PIN_HINT,
  );

  // 主断言 ②：两类条数逐项相等。
  /** @type {Record<string, number>} */
  const prefixCounts = {};
  for (const value of labelClasses) {
    const rule = LABEL_PREFIX_RULES.find((candidate) => candidate.pattern.test(value));
    const key = rule === undefined ? `<未登记前缀>:${value}` : rule.prefix;
    prefixCounts[key] = (prefixCounts[key] ?? 0) + 1;
  }
  assert.deepEqual(
    prefixCounts,
    LABEL_PREFIX_COUNTS,
    `【钉 4 破了】${rel} 的两类 \`labelClass\` 条数变了：`
      + `\n  实测：${JSON.stringify(prefixCounts)}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(LABEL_PREFIX_COUNTS)}（合计 ${LABEL_ENTRY_COUNT}）`
      + PIN_HINT,
  );

  // 主断言 ③：损伤类字面量零命中（带行号 —— 该 JSON 一值一行，行号可精确定位到条目）。
  const labelLines = linesOf(text);
  const injuryHits = labelClasses.filter((value) => INJURY_LABEL_NEEDLE.test(value));
  const injuryLineNumbers = injuryHits.map((value) => {
    const index = labelLines.findIndex((line) => line.includes(`"labelClass": "${value}"`));
    return `packages/evaluation/samples/gy-i20-weeds-labels.json:${index + 1} ${value}`;
  });
  assert.deepEqual(
    injuryHits.sort(),
    [],
    '【钉 4 破了】标签集里出现了损伤类 `labelClass`：'
      + `\n  实测命中：${JSON.stringify(injuryLineNumbers.sort())}`
      + `\n  基线（${BASELINE_SHA}）：172 条 \`labelClass\` 里 damage / injury / phytotox / symptom **零命中**。`
      + '\n  药害分级没有需求条目（产品不承诺药害分级、也不承诺药害与病害的图像区分），'
      + `因此标签集**不可能**有损伤类答案键（${REGISTER}:43-45）。`
      + '\n  ⚠ 这条连 `SYN_…` 之外的「自造类别名」也挡：只要字面带 damage/injury/phytotox/symptom 就红。'
      + PIN_HINT,
  );
});

// ---------------------------------------------------------------------------
// 钉 5 · 路由层无 damage 端点
// ---------------------------------------------------------------------------

/** 基线实测：`services/api/src/routes/` 下 `*.ts` 文件的**全集**（22 个，逐条钉住）。 */
const ROUTE_FILES = [
  'account-deletion.ts',
  'admin-auth.ts',
  'admin.ts',
  'auth.ts',
  'community.ts',
  'consents.ts',
  'conversations.ts',
  'exports.ts',
  'favorites.ts',
  'health.ts',
  'history.ts',
  'knowledge.ts',
  'media.ts',
  'messages.ts',
  'ocr.ts',
  'profile.ts',
  'public-home.ts',
  'recognitions.ts',
  'registrations.ts',
  'speech.ts',
  'support.ts',
  'synthesis.ts',
];

test('钉 5 · 路由层无 damage 端点：services/api/src/routes 的 22 个 .ts 零命中', () => {
  const ROUTES_DIR = 'services/api/src/routes';
  const files = walkFiles(ROUTES_DIR);

  // 正向控制 ①：扫描面就是那 22 个文件（`deepEqual`：少一个 ⇒ 扫描面缩了；多一个 ⇒ 有人加了路由文件）。
  assert.deepEqual(
    files,
    ROUTE_FILES.map((name) => `${ROUTES_DIR}/${name}`),
    '【钉 5 · 正向控制破了】`services/api/src/routes/` 的 `.ts` 文件集合变了：'
      + `\n  实测：${JSON.stringify(files)}`
      + `\n  基线（${BASELINE_SHA}）：恰好 ${ROUTE_FILES.length} 个路由文件（见清单）。`
      + '\n  这条控制的作用：证明「零命中」是真的逐个文件读过了，而不是目录改名后扫了个空。'
      + '\n  若只是新增了一个与药害无关的路由文件 ⇒ 把新文件加进 `ROUTE_FILES` 即可（判据不变）。'
      + PIN_HINT,
  );

  // 主断言：零命中，命中时打印 `文件:行号`（与 `git grep -n` 口径一致）。
  /** @type {string[]} */
  const hits = [];
  for (const file of files) {
    const lines = linesOf(readRepoText(file));
    for (let i = 0; i < lines.length; i += 1) {
      if (DAMAGE_NEEDLE.test(lines[i]) || /phytotox/i.test(lines[i])) {
        hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    '【钉 5 破了】`services/api/src/routes/` 下出现了 damage 端点（或 damage 字样）：'
      + `\n  实测命中：\n  ${JSON.stringify(hits, null, 2)}`
      + `\n  基线（${BASELINE_SHA}）：22 个路由文件里 damage / phytotox **零命中**（连注释与字段名都没有）。`
      + '\n  路由层是「端点存在」的最后一道实锤：契约里加 operation 是纸面，路由里注册才是真端点。'
      + `\n  药害没有需求条目（${REGISTER}:36、:43-48），故不允许在这里出现任何 damage 路由。`
      + PIN_HINT,
  );
});

// ---------------------------------------------------------------------------
// 钉 6 · 需求登记仍是「缺需求」
// ---------------------------------------------------------------------------

/** 基线实测：`docs/evaluation/sample-gap-register.md` 的表 #18 整行（逐字）。 */
const GAP_ROW_18 = "| 18 | 药害分级／药害-病害区分 | 无需求条目，门槛 N/A | 无（第6.1节无此项） | 0（无样本，也无需求） | N/A | 否 |";

/** 基线实测：`docs/evaluation/sample-gap-register.md` 的文字标题（liveness 控制）。 */
const GAP_DOC_TITLE = "# 样本缺口清单（GY-I20）";

/**
 * 基线实测：#18 的说明段（`:43-48`，六行逐字）。
 *
 * 这六行是「缺需求」这个口径的**唯一正文出处**：门槛 N/A、不计入任何分母、不列为阻塞，
 * 且「在此之前不预置任何门槛值」。
 */
const GAP_PARAGRAPH = [
  "> **第 18 行是「缺需求」而不是「缺数据」**：药害分级、药害与病害的图像区分当前**没有需求条目**——产品不承诺药害分级，",
  "> 也不承诺图像区分（`docs/implementation-requirements.md:184`、`docs/product-requirements.md:166`），第6.1节也没有对应样本要求，",
  "> 故该行**门槛 N/A、不计入任何分母、不列为阻塞**，不得用「样本不够」解释本项。",
  "> 若将来为本项立需求，再按同口径逐条列门槛（缺口 + 需求出处 + 目标量；列式见",
  "> `docs/verification/gy-i03-i20-materials-gap-ledger-20261015.md` 第 3 节 `L01`–`L12`，同页 §5.1 的 `G1`–`G15` 同类列式），",
  "> 并同步 `docs/evaluation/threshold-basis.md` 的逐条依据；在此之前不预置任何门槛值。",
];

/**
 * 基线实测：四个口径关键词**在整份登记处里的落行**（期望值，逐行逐字）。
 *
 * 这是钉 6 主断言 ③ 的期望值 —— **只当期望值**，判据过滤的是读回来的文档真实行。
 * （旧版把这里当过滤对象，写成 `GAP_PARAGRAPH.filter(...)`，判据与数据同源，恒真。）
 *
 * 实测（`docs/evaluation/sample-gap-register.md`）：
 * 「缺需求」1 行（说明段首行 :43）；「门槛 N/A」2 行（表 #18 行内一格 :36 + 说明段第三行 :45）；
 * 「不计入任何分母」「不列为阻塞」各 1 行（说明段第三行 :45）。
 */
const KEYWORD_ROWS = [
  { needle: '缺需求', rows: [GAP_PARAGRAPH[0]] },
  { needle: '门槛 N/A', rows: [GAP_ROW_18, GAP_PARAGRAPH[2]] },
  { needle: '不计入任何分母', rows: [GAP_PARAGRAPH[2]] },
  { needle: '不列为阻塞', rows: [GAP_PARAGRAPH[2]] },
];

test('钉 6 · 需求登记仍是「缺需求」：#18 门槛 N/A、不计入分母', () => {
  const lines = linesOf(readRepoText(REGISTER));

  // 正向控制 ①：标题恰一份（证明读的就是这份登记处，且没被替换成另一份文档）。
  assert.deepEqual(
    lines.filter((line) => line === GAP_DOC_TITLE),
    [GAP_DOC_TITLE],
    `【钉 6 · 正向控制破了】${REGISTER} 的标题行不再是唯一一份：`
      + `\n  实测命中：${JSON.stringify(lines.filter((line) => line === GAP_DOC_TITLE))}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(GAP_DOC_TITLE)} 恰好出现 1 次。`
      + '\n  若文档改名/搬家 ⇒ 先确认新登记处，再改本钉子（⛔ 别指向一份不存在的口径）。'
      + PIN_HINT,
  );

  // 主断言 ①：表 #18 **整行逐字**不变（含「无需求条目，门槛 N/A」「空（无样本，也无需求）」「N/A」「否」四格）。
  const rowMatches = lines.filter((line) => /^\| 18 \|/.test(line));
  assert.deepEqual(
    rowMatches,
    [GAP_ROW_18],
    `【钉 6 破了】${REGISTER} 表 #18 那一行被改动了（药害的登记口径变了）：`
      + `\n  实测：${JSON.stringify(rowMatches)}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(GAP_ROW_18)}`
      + '\n  这一行的四格口径分别是：「无需求条目，门槛 N/A」、「无（第6.1节无此项）」、'
      + '「0（无样本，也无需求）」、「N/A」、阻塞「否」。'
      + '\n  谁把一个数字门槛填进「缺口」格（例如 ≥30 张药害照片），就是把「缺需求」悄悄改成了「有门槛」——'
      + '那必须先有需求条目，并同时改说明段与 docs/evaluation/threshold-basis.md。'
      + PIN_HINT,
  );

  // 主断言 ②：说明段逐行相等（六行；行内容、顺序、行数都钉住）。
  const anchorIndex = lines.indexOf(GAP_PARAGRAPH[0]);
  assert.equal(
    anchorIndex === -1,
    false,
    `【钉 6 破了】${REGISTER} 里找不到「缺需求」说明段的首行：`
      + `\n  期望首行：${JSON.stringify(GAP_PARAGRAPH[0])}`
      + '\n  说明段整段消失/首行被改写，都意味着「缺需求」这条口径失去了正文出处 —— '
      + '仅剩表格里的 `N/A` 六个字符不足以表达「不计入任何分母」。'
      + PIN_HINT,
  );
  assert.deepEqual(
    lines.slice(anchorIndex, anchorIndex + GAP_PARAGRAPH.length),
    GAP_PARAGRAPH,
    `【钉 6 破了】${REGISTER} 的「缺需求」说明段被改动了：`
      + `\n  实测（首行起 ${GAP_PARAGRAPH.length} 行）：${JSON.stringify(lines.slice(anchorIndex, anchorIndex + GAP_PARAGRAPH.length), null, 2)}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(GAP_PARAGRAPH, null, 2)}`
      + '\n  这一段是药害「缺需求 / 门槛 N/A / 不计入任何分母 / 不列为阻塞」的**唯一**正文出处，'
      + '也是本文件其余五条钉子的口径依据。改它 = 改口径，必须走需求评审。'
      + PIN_HINT,
  );

  // 主断言 ③：四个口径关键词各自**只**落在原行上 —— 过滤对象是**读回来的文档真实行**。
  //
  // 旧版（审查者 34d69578 的阻塞级观察，虽记为非阻塞但必须修）：
  //   const paragraph = GAP_PARAGRAPH;                       // ← 过滤的是期望值常量自己
  //   assert.deepEqual(paragraph.filter((l) => l.includes('缺需求')), [GAP_PARAGRAPH[0]]);
  // 判据与数据同源 ⇒ 四条形同 `assert.ok(true)`，是「纸面钉子」，**永远不可能红**。
  //
  // 现版两处收紧：
  //   ① 过滤对象换成 `lines`（`readRepoText(REGISTER)` 读回来的真实文档行）；
  //      `GAP_ROW_18` / `GAP_PARAGRAPH` 退回**纯期望值**，不再参与挑行。
  //   ② 扫描面从「说明段 6 行切片」扩到**整份登记处**：只扫那 6 行的话，窗口内容已被上面主断言
  //      ②（`:790` 的六行 `deepEqual`）钉死，窗口内的改动必先在 ② 红，它拿不到独立于 ② 的检测力。
  //      实测：把同一份 `KEYWORD_ROWS` 套在 6 行窗口上，它不是「永不红」而是**恒红**（「门槛 N/A」
  //      的期望行里有一行是表 #18、落在窗口外），整天红着只能算噪声。而窗口**外**的漂移它同样
  //      看不见：「关键词被搬到别的表行 / 第 2、3 节」而窗口一字未动时，窗口版照样绿。
  //      所以改用**文档全域**过滤 —— 这才是能在 ② 之外独立真红的那一版。
  // 判据形状：每个词 → 命中行**逐行逐字**相等（多一行、少一行、改一个字都红），⛔ 不是
  // 「至少包含」式裸判据；`includes` 只负责挑行，相等由 `deepEqual` 判。
  const keywordRows = KEYWORD_ROWS.map(({ needle }) => ({
    needle,
    rows: lines.filter((line) => line.includes(needle)),
  }));
  assert.deepEqual(
    keywordRows,
    KEYWORD_ROWS,
    '【钉 6 破了】四个口径关键词在登记处的落行变了（措辞被改，或词跑到了别的行）：'
      + `\n  实测（词 → 命中行）：${JSON.stringify(keywordRows, null, 2)}`
      + `\n  基线（${BASELINE_SHA}）：${JSON.stringify(KEYWORD_ROWS, null, 2)}`
      + '\n  口径要求：「缺需求」只在说明段首行；「门槛 N/A」只在表 #18 行内一格与说明段第三行；'
      + '「不计入任何分母」「不列为阻塞」只在说明段第三行 —— 多一行、少一行、改一个字都红。'
      + '\n  这条与主断言 ② 不是重复：② 只看说明段 6 行，这条看**整份登记处**，'
      + '能抓住「关键词被搬到别的表行 / 第 2、3 节」这类 ② 看不见的漂移。'
      + PIN_HINT,
  );
});

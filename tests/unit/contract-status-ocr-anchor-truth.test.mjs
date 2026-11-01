/**
 * 钉线：契约台账正文里「OCR 取消」的域内地址必须真的指到 `cancelJob` 那一行（R72／W51 锚点真值片）。
 *
 * ## 缺陷形状（不是「行号过期」这么轻）
 *
 * `docs/architecture/contract-status.json` 有 8 处正文写着同一句话：
 *
 * > …ocr 的**取消**已于 GY-I10 取消片接线（`services/api/src/jobs/sources.ts:208`、域内
 * > `services/api/src/ocr/service.ts:<n>`）…
 *
 * 这 8 处原本都写 `:687`。`#811`（读面裁定）把这个文件的 `getJob` 撑长之后，`:687` 变成了
 * `const row = await adjudicateExpiredOcrJob(() => getOwnedJob(...), store, now);` —— **读面裁定**，
 * 与取消毫无关系；`cancelJob` 的声明已经下移到 `:702`（`async function cancelJob(input: {`）。
 *
 * 所以病根不是「数字旧了」，而是**地址指向了错函数**：读者按地址跳过去，看到的是读面裁定，
 * 却被正文告知「这就是取消」。这类错比行号漂移更贵——行号漂移顶多让人多翻两屏，
 * 指错函数会让人把「读会写库」误读成「取消会写库」。
 *
 * ## 为什么钉真值而不是钉数字
 *
 * 「把 687 改成 702」这种修法靠人眼守不住：下一次有人在 `getJob` 里加一行，702 又会错位。
 * 所以本文件**不钉数字**：`cancelJob` 的声明行由源码实时定位（`function cancelJob(` 那一行），
 * 然后再要求台账里每一处地址都落在那一行上。行号怎么漂，判据都跟着它走。
 *
 * ## 红了怎么办（先判哪一侧错，别改断言凑绿）
 *
 * - T1 红（出现 `:687` 这种旧地址，或地址不足 8 处）：把 JSON 正文里的地址改回
 *   `services/api/src/ocr/service.ts:<cancelJob 声明行>`，再跑
 *   `node tools/verify-contract-status.mjs --write-doc` 让中文对照表重新渲染。
 * - T2 红：**这是真值钉，最严重**。说明台账地址指到了不含 `cancelJob` 的行（例如读面裁定那一行），
 *   或者指到了同文件里别的 `cancelJob` 提及（导出清单、注释）而不是声明行。
 *   要么改台账地址，要么是 `cancelJob` 真被挪走/改名了——后者要判断台账口径，别改本条去迎合代码。
 * - T3 红：中文对照表与 JSON 不一致（被手改，或改了 JSON 没重新渲染）——跑
 *   `node tools/verify-contract-status.mjs --write-doc`，⛔ 不许只手改 md（下次渲染会冲掉）。
 * - T4 红：`docs/development-progress.md` 的进度行又写回旧地址。
 * - T5 红：这两个文件的体积变了。**先看它是不是正常台账变更**：若是，同步更新下面的基线即可，
 *   这不是回归；⚠️ 这条只钉「本片交付时这两个文件的体积」，⛔ 不是跨分支的永久断言。
 *
 * 本文件只读文件文本、不 import 任何服务代码（不建池、不连 PG、不起 HTTP、不写文件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATUS_JSON = join(ROOT, 'docs/architecture/contract-status.json');
const STATUS_MD = join(ROOT, 'docs/architecture/contract-implementation-status.md');
const PROGRESS_MD = join(ROOT, 'docs/development-progress.md');
const OCR_SERVICE_TS = join(ROOT, 'services/api/src/ocr/service.ts');

/** 被引用的域内实现文件（POSIX 相对路径，与台账正文里的写法一致）。 */
const OCR_SERVICE_REL = 'services/api/src/ocr/service.ts';

/**
 * `#811` 之前 `cancelJob` 的行号（也就是这次要清掉的旧地址）。
 * 这里只作为一个**数字**参与比较，⛔ 不要在断言里写死 `…service.ts:687` 这种锚点字面量
 * （`tests/unit/test-line-anchors-guard.test.mjs` 会判红，而且写死了下次照样过期）。
 */
const PRE_811_CANCEL_LINE = 687;

const read = (path) => readFileSync(path, 'utf8');

/** 台账正文里全部 `services/api/src/ocr/service.ts:<n>` 的行号（按出现顺序，含重复）。 */
function bodyAnchorLines() {
  const pattern = new RegExp(`${OCR_SERVICE_REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`, 'g');
  return [...read(STATUS_JSON).matchAll(pattern)].map((match) => Number(match[1]));
}

/** `services/api/src/ocr/service.ts` 的源码行（1-based 取用时 `[n - 1]`）。 */
function ocrServiceLines() {
  return read(OCR_SERVICE_TS).split('\n');
}

/**
 * `cancelJob` 的**声明行**（1-based），由源码实时定位。
 * ⛔ 不写死 702：文件里 `cancelJob` 另有两处提及（导出的方法表、说明注释），声明行只能靠签名找。
 */
function cancelJobDeclarationLine() {
  const index = ocrServiceLines().findIndex((line) => /function cancelJob\s*\(/.test(line));
  assert.ok(
    index >= 0,
    `${OCR_SERVICE_TS} 里找不到「function cancelJob(」的声明——取消实现被改名/删除？本钉子的前提已失效，需人工重定位`,
  );
  return index + 1;
}

/** 某个文本里 `services/api/src/ocr/service.ts:<n>` 的全部行号。 */
function anchorLinesIn(text) {
  const pattern = new RegExp(`${OCR_SERVICE_REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`, 'g');
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

/** 文件行数：以 `\n` 计数，末尾换行不算多一行。 */
function countLines(text) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

test('T1 台账正文里的域内地址至少 8 处，且没有一处还指向 #811 之前那一行', () => {
  const anchors = bodyAnchorLines();
  assert.ok(
    anchors.length >= 8,
    `docs/architecture/contract-status.json 正文里形如 ${OCR_SERVICE_REL}:<n> 的地址只有 ${anchors.length} 处（应至少 8 处）——地址被删掉也算信息丢失，需人工确认`,
  );

  const stale = anchors.filter((line) => line === PRE_811_CANCEL_LINE);
  assert.deepEqual(
    stale,
    [],
    [
      `docs/architecture/contract-status.json 仍有 ${stale.length} 处地址指向第 ${PRE_811_CANCEL_LINE} 行——`,
      '那一行今天是 getJob 的读面裁定（adjudicateExpiredOcrJob 调用），不是 cancelJob。',
      `改成 ${OCR_SERVICE_REL}:<cancelJob 声明行>，再跑 node tools/verify-contract-status.mjs --write-doc 重新渲染中文对照表。`,
    ].join(''),
  );

  // 再按原文直接查一遍：上面只比数字，这里防「同一行里出现两次、形状被正则吃掉」这类漏网。
  assert.equal(
    read(STATUS_JSON).includes(`${OCR_SERVICE_REL}:${PRE_811_CANCEL_LINE}`),
    false,
    `docs/architecture/contract-status.json 里仍逐字出现旧的域内地址（${OCR_SERVICE_REL} 的第 ${PRE_811_CANCEL_LINE} 行）`,
  );
});

test('T2 真值钉：每一处地址指向的那一行必须真的是 cancelJob（不许指到读面裁定）', () => {
  const anchors = bodyAnchorLines();
  assert.ok(anchors.length > 0, 'docs/architecture/contract-status.json 正文里一处域内地址都没读到，本钉子空转');

  const source = ocrServiceLines();
  const declaration = cancelJobDeclarationLine();
  const problems = [];

  for (const lineNumber of anchors) {
    const line = source[lineNumber - 1];
    if (line === undefined) {
      problems.push(`指向第 ${lineNumber} 行，但 ${OCR_SERVICE_REL} 只有 ${source.length - 1} 行（越界）`);
      continue;
    }
    // ① 必须含 cancelJob（正文说的就是「取消」）。
    if (!line.includes('cancelJob')) {
      problems.push(`指向第 ${lineNumber} 行，那一行不含 cancelJob：${line.trim().slice(0, 120)}`);
      continue;
    }
    // ② 反向：绝不许指向读面裁定那一行（今天就是这个错）。
    if (line.includes('adjudicateExpiredOcrJob')) {
      problems.push(`指向第 ${lineNumber} 行，那是读面裁定（adjudicateExpiredOcrJob），不是取消：${line.trim().slice(0, 120)}`);
      continue;
    }
    // ③ 也不许指向同文件里别的 cancelJob 提及（导出方法表 / 说明注释）：地址是给读者跳转用的，得跳到声明。
    if (lineNumber !== declaration) {
      problems.push(`指向第 ${lineNumber} 行，那一行虽含 cancelJob 但不是声明行（声明在 ${declaration}）：${line.trim().slice(0, 120)}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    [
      'docs/architecture/contract-status.json 的域内地址与代码事实不符（真值钉）：\n',
      problems.map((problem) => `  · ${problem}`).join('\n'),
      `\n真值：cancelJob 声明在 ${OCR_SERVICE_REL} 第 ${declaration} 行。⛔ 不要改本条断言去迎合台账。`,
    ].join(''),
  );
});

test('T3 中文对照表镜像：同样没有旧地址，且同样至少 8 处落在 cancelJob 声明行', () => {
  const markdown = read(STATUS_MD);
  assert.equal(
    markdown.includes(`${OCR_SERVICE_REL}:${PRE_811_CANCEL_LINE}`),
    false,
    `docs/architecture/contract-implementation-status.md 里仍有旧的域内地址（第 ${PRE_811_CANCEL_LINE} 行）——改 JSON 后跑 node tools/verify-contract-status.mjs --write-doc 渲染，⛔ 不许手改 md`,
  );

  const declaration = cancelJobDeclarationLine();
  const atDeclaration = anchorLinesIn(markdown).filter((line) => line === declaration);
  assert.ok(
    atDeclaration.length >= 8,
    `docs/architecture/contract-implementation-status.md 里落在 cancelJob 声明行（${declaration}）的地址只有 ${atDeclaration.length} 处（应至少 8 处）——镜像没跟上 JSON，或单元格被手改过`,
  );
});

test('T4 进度台账：docs/development-progress.md 不再引用旧地址', () => {
  const progress = read(PROGRESS_MD);
  assert.equal(
    progress.includes(`${OCR_SERVICE_REL}:${PRE_811_CANCEL_LINE}`),
    false,
    `docs/development-progress.md 里仍有旧的域内地址（第 ${PRE_811_CANCEL_LINE} 行）——同一行内替换成 cancelJob 的声明行即可（行数与字节数都不变）`,
  );

  const declaration = cancelJobDeclarationLine();
  assert.ok(
    anchorLinesIn(progress).includes(declaration),
    `docs/development-progress.md 里没有一处地址落在 cancelJob 声明行（${declaration}）——进度行把 OCR 取消的域内地址删了？`,
  );
});

/**
 * 本片交付时这两个文件的体积（同一提交内的自洽读数）。
 *
 * ⚠️ 这**不是**「以后谁都不许改这个文件」的永久钉子：台账本来就会随代码与判定变化，
 * 届时把这里的基线同步改掉即可 —— 那不是回归。它存在的唯一理由是：本片做的是**等长文本替换**
 * （`687` → `702`，`--write-doc` 渲染同样等长），所以行数与字节数**必须一个都不许变**；
 * 变了就说明改的不止那 8 处地址（例如 JSON 被重排、md 被工具顺手改了别的），那要停下来查。
 */
const DELIVERY_SIZE_BASELINE = [
  { label: 'docs/architecture/contract-status.json', path: STATUS_JSON, bytes: 267773, lines: 4407 },
  { label: 'docs/architecture/contract-implementation-status.md', path: STATUS_MD, bytes: 191569, lines: 217 },
];

test('T5 本片交付时两个台账文件的体积（等长替换 ⇒ 行数与字节数都不许变）', () => {
  const drift = [];
  for (const expected of DELIVERY_SIZE_BASELINE) {
    const bytes = statSync(expected.path).size;
    const lines = countLines(read(expected.path));
    if (bytes !== expected.bytes) drift.push(`${expected.label} 字节数 ${bytes} ≠ 本片基线 ${expected.bytes}`);
    if (lines !== expected.lines) drift.push(`${expected.label} 行数 ${lines} ≠ 本片基线 ${expected.lines}`);
  }
  assert.deepEqual(
    drift,
    [],
    [
      '本片做的是等长替换（687 → 702），这两个文件的行数与字节数应当一个不少也一个不多：\n',
      drift.map((item) => `  · ${item}`).join('\n'),
      '\n如果你只是**正常改台账**（不是本片），请同步更新 tests/unit/contract-status-ocr-anchor-truth.test.mjs 的 DELIVERY_SIZE_BASELINE —— 这不是回归；',
      '但如果本片里它变了，先查是不是 JSON 被重排 / 工具顺手改了别处。',
    ].join(''),
  );
});

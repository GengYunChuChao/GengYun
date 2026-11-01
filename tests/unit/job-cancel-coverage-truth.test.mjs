/**
 * 钉：能力台账的「取消覆盖面」必须说真话（W38 / GY-R72 取消覆盖面订正片）。
 *
 * ① 三处假话的产地，以及为什么只钉「当前状态台账」
 *    · `docs/architecture/ai-ops-spec-status.md` 的 P01 行原写「取消能力按域分派：识别／OCR／转写／合成
 *      四域提供；审核与问答两域不提供 ⇒ 503 `retryable:false`」＋缺口列「缺的两域不是漏接线，是域内
 *      确无取消入口；问答取消「仍如实 503」已写进台账」；同页 §1 计数矩阵「作业面公共」行的末格
 *      （「取消能力按域分派，问答与审核域无取消（P01）」）与 E03 的末句（「取消能力另按域判定」）是
 *      同一句假话的两个镜像；`docs/development-progress.md` 的能力列又写「转写／合成／问答／审核公共
 *      作业源取消仍 503」。
 *    · 真值（2026-11-01 实测）：转写与合成由 GY-R27 接线、OCR 由 GY-I10 接线、审核与问答由 GY-R71
 *      接线 ⇒ **六源全部接了 `cancel`**；`services/api/src/jobs/registry.ts` 的分派闸门是
 *      `if (source.cancel === undefined)`，只有**没接 cancel 的源**才会走到 503
 *      `PROVIDER_UNAVAILABLE` ＋ `retryable: false`。也就是说「按域分派」这个读法今天等于反话：
 *      不是「有的域不能取消」，而是「接了的源都能取消，没接的源才 503」。
 *    · 只钉这两页，是因为它们自称**当前状态**（一份能力台账、一份进度基线）；状态写错就是假话，
 *      而历史证据页写的不是当前状态（见 ②）。
 *
 * ② 为什么不钉 `docs/verification/**` 的历史页
 *    GY-I01／GY-I13／GY-I14／GY-I12 那几页取证时，取消入口**确实还不存在**——它们记录的是「当时为什么
 *    判 503」，是历史事实。为了「统一口径」去改写历史页，等于把「当时凭什么这么写」的证据抹掉。
 *    本文件反过来把「历史页保持原状」也钉住（T6）：防止将来有人顺手把旧页一起「订正」了。
 *
 * ③ 本文件是「文档说真话」这一类钉子
 *    风格参照 `tests/unit/docs-truth-pins.test.mjs`：断言对象是**文档文本**而不是运行行为；并且沿用它
 *    「剥掉撤回引文再判」的思路——「原写「…」为误」是在引用旧陈述并说明它错了，不是新陈述，不该判红
 *    （否则每修一处假话，就得顺手删掉「它曾经错在哪」这段最有价值的信息）。
 *    本文件只读仓库文本（两页文档 + 四份源码），不起服务、不联网、不写任何文件。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (relativePath) => readFileSync(join(REPO_ROOT, relativePath), 'utf8');
const toLines = (text) => text.split('\n');

const PAGE = 'docs/architecture/ai-ops-spec-status.md';
const PROGRESS = 'docs/development-progress.md';

// ---------------------------------------------------------------------------
// 共用：撤回引文剥离 ＋ 定行取行
// ---------------------------------------------------------------------------

// 与 `docs-truth-pins.test.mjs` 同一套思路（这里各自实现，不 import 那个文件：import 一个 test 文件
// 会把它的用例在本进程里再注册一遍，等于凭空多跑一份）。
const RETRACTION_QUOTE = /(?:原写|原文|旧稿|早先写作)「[^」]*」为误/g;

/** 把一行里的撤回引号整段剥掉，再拿去判「现陈述」。 */
const stripRetractions = (line) => line.replace(RETRACTION_QUOTE, '');

/**
 * 取文档里**以 `prefix` 开头**的那一行。0 行或多行都判红：这类钉子的前提是「这行唯一」，
 * 排版一变（表格被拆开、行首缩进变了）就该人工来重定位，而不是让断言悄悄失效。
 */
function uniqueRow(relativePath, prefix) {
  const hits = toLines(read(relativePath))
    .map((text, index) => ({ line: index + 1, text }))
    .filter((item) => item.text.startsWith(prefix));
  assert.equal(
    hits.length,
    1,
    `${relativePath} 里以「${prefix}」开头的行应当恰好 1 行，实际 ${hits.length} 行：`
      + '钉子的定位前提变了，请按文本重新定位（不要改成「模糊包含」糊过去）',
  );
  return { line: hits[0].line, text: hits[0].text, judged: stripRetractions(hits[0].text) };
}

/** Markdown 表格行 → 数据格数组（去掉首尾边框留下的空串；`|` 两侧空白一并 trim）。 */
const cellsOf = (rowText) => rowText.split('|').slice(1, -1).map((cell) => cell.trim());

// ---------------------------------------------------------------------------
// T1  P01 行说真话：六源全接，只有未接线的源才 503
// ---------------------------------------------------------------------------

describe('T1 P01 行说真话：六源全接，只有未接线的源才 503', () => {
  test('不得再出现三句旧话：两域不提供／确无取消入口／仍如实 503', () => {
    const { line, judged } = uniqueRow(PAGE, '| P01 |');
    for (const forbidden of ['两域不提供', '确无取消入口', '仍如实 503']) {
      assert.equal(
        judged.includes(forbidden),
        false,
        `${PAGE}:${line} 仍写着旧话「${forbidden}」。真值：审核与问答由 GY-R71 接线，两个域都是 200 取消`
          + '（tests/unit/jobs-cancel-moderation-answer.test.mjs 的 moderation·① 与 answer·①），不是 503',
      );
    }
  });

  test('必须写出「六源」与「GY-R71」这两个真值口径', () => {
    const { line, judged } = uniqueRow(PAGE, '| P01 |');
    assert.match(
      judged,
      /六源/,
      `${PAGE}:${line} 没有写「六源」：覆盖面已经是识别／转写／合成／OCR／审核／问答六源全接，`
        + '还写成「四域提供」就是在说旧话',
    );
    assert.match(
      judged,
      /GY-R71/,
      `${PAGE}:${line} 没有写「GY-R71」：审核与问答这两源是 GY-R71 取消片接的线，抹掉出处等于把「接过了」`
        + '又退回「不是漏接线、是域内没有入口」那套说法',
    );
  });

  test('判定列仍是「部分实现」（覆盖面文字订正，不是改判）', () => {
    const { line, text } = uniqueRow(PAGE, '| P01 |');
    const cells = cellsOf(text);
    assert.equal(cells.length, 5, `${PAGE}:${line} 不是 5 格的表格行（列结构变了），实际 ${cells.length} 格`);
    assert.equal(
      cells[2],
      '部分实现',
      `P01 的判定格是「${cells[2]}」而不是「部分实现」：` + '覆盖面可以订正，判定档不归文字订正改',
    );
  });
});

// ---------------------------------------------------------------------------
// T2  摘要行与 E03 备注：同一句假话的两个镜像
// ---------------------------------------------------------------------------

describe('T2 摘要行与 E03 备注：同一句假话的两个镜像', () => {
  test('§1 计数矩阵「作业面公共」行末格：不含「问答与审核域无取消」，含「六源」', () => {
    const { line, judged } = uniqueRow(PAGE, '| 作业面公共（');
    assert.equal(
      judged.includes('问答与审核域无取消'),
      false,
      `${PAGE}:${line} 的末格仍写着「问答与审核域无取消」：这是 P01 那句假话的镜像，`
        + '真值是六源全接、只有未接线源才 503',
    );
    assert.match(
      judged,
      /六源/,
      `${PAGE}:${line} 的末格没有写「六源」：摘要行必须与 P01 的真值口径对齐（六源全接）`,
    );
  });

  test('E03 备注：不含「取消能力另按域判定」，含「六源」', () => {
    const { line, judged } = uniqueRow(PAGE, '| E03 |');
    assert.equal(
      judged.includes('取消能力另按域判定'),
      false,
      `${PAGE}:${line} 的备注仍写着「取消能力另按域判定」：今天读起来等于「有的源不能取消」，`
        + '与六源全接的事实相反；E03 判「已实现」不用动，错的是这句备注',
    );
    assert.match(
      judged,
      /六源/,
      `${PAGE}:${line} 的备注没有写「六源」：应写成「注册 ≠ 可取消；取消能力按源判定，六源今已全接」`,
    );
  });
});

// ---------------------------------------------------------------------------
// T3  进度基线：公共作业源取消不再写「仍 503」
// ---------------------------------------------------------------------------

describe('T3 进度基线：公共作业源取消不再写「仍 503」', () => {
  test('`docs/development-progress.md` 的能力列：不含「取消仍 503」，含「六源」', () => {
    const { line, judged } = uniqueRow(PROGRESS, '| 识别／OCR／语音 |');
    assert.equal(
      judged.includes('取消仍 503'),
      false,
      `${PROGRESS}:${line} 仍写着「…取消仍 503」：转写与合成在 GY-R27 就接线了、问答与审核在 GY-R71`
        + '接线，公共作业源取消早已不是 503',
    );
    assert.match(
      judged,
      /六源/,
      `${PROGRESS}:${line} 没有写「六源」：这一格应改成「六源取消均已接线（识别／转写／合成／OCR／审核／问答）」`,
    );
  });
});

// ---------------------------------------------------------------------------
// T4  代码事实钉子：六源真的接了 cancel（文档敢写「六源」的凭据）
// ---------------------------------------------------------------------------

describe('T4 代码事实钉子：六源真的接了 cancel', () => {
  // 四个源在共享作业面里各有一处 `cancelJob(` 调用点。行号只写在这条注释里，**不写进 docs**
  // （写进文档就成了新锚点，锚点计数由 tools/doc-anchors-*-baseline.json 管，属另一片的事）：
  //   识别 services/api/src/jobs/sources.ts:68、转写 :109（GY-R27）、合成 :155（GY-R27）、OCR :211（GY-I10）
  // 另两源在各自域内委托：审核 services/api/src/moderation/job-source.ts:66、问答
  // services/api/src/conversations/job.ts:89（GY-R71）。六源合计六处，共享作业面里是四处。
  const MIN_SHARED_SOURCES = 4;

  test(`共享作业面 sources.ts 的 cancelJob( 调用点 ≥ ${MIN_SHARED_SOURCES}（识别／转写／合成／OCR）`, () => {
    const source = read('services/api/src/jobs/sources.ts');
    const sites = [...source.matchAll(/cancelJob\(/g)].length;
    assert.ok(
      sites >= MIN_SHARED_SOURCES,
      `services/api/src/jobs/sources.ts 里只有 ${sites} 处 cancelJob(，少于 ${MIN_SHARED_SOURCES}：`
        + '识别／转写／合成／OCR 四源里至少有一源被摘掉了取消接线，台账那句「六源」说过头了',
    );
  });

  test('审核源（moderation/job-source.ts）把取消委托给域内服务', () => {
    const source = read('services/api/src/moderation/job-source.ts');
    assert.ok(
      source.includes('cancelJob('),
      'services/api/src/moderation/job-source.ts 里找不到 cancelJob(：审核源的取消接线没了，'
        + 'P01 就不能再说「六源全接」',
    );
  });

  test('问答源（conversations/job.ts）既声明 cancelJob 依赖也真的调用它', () => {
    const source = read('services/api/src/conversations/job.ts');
    assert.ok(
      source.includes('cancelJob(input: {'),
      'services/api/src/conversations/job.ts 里找不到 cancelJob(input: {：AnswerJobSourceDeps 不再要求'
        + '取消端口，等于把「问答能取消」这件事从类型上摘掉',
    );
    assert.ok(
      source.includes('deps.cancelJob({'),
      'services/api/src/conversations/job.ts 里找不到 deps.cancelJob({：声明了依赖却没调用，'
        + '问答取消会退回 503',
    );
  });

  test('分派闸门仍在 registry.ts：只有没接 cancel 的源才 503 retryable:false', () => {
    const source = read('services/api/src/jobs/registry.ts');
    assert.ok(
      source.includes('if (source.cancel === undefined) {'),
      'services/api/src/jobs/registry.ts 里找不到 `if (source.cancel === undefined) {`：'
        + '「只有没接 cancel 的源才 503」这条语义的落点变了，P01 的新口径要跟着改',
    );
    assert.ok(
      source.includes('retryable: false'),
      'services/api/src/jobs/registry.ts 里找不到 retryable: false：503 拒绝通道必须保持不可重试，'
        + '别为了过门禁把它放宽成可重试',
    );
  });
});

// ---------------------------------------------------------------------------
// T5  不许借订正改档
// ---------------------------------------------------------------------------

describe('T5 不许借订正改档', () => {
  test('P01 的判定格必须仍是「部分实现」', () => {
    const { line, text } = uniqueRow(PAGE, '| P01 |');
    const judgeCell = cellsOf(text)[2];
    assert.equal(
      judgeCell,
      '部分实现',
      `${PAGE}:${line} 的判定格被改成「${judgeCell}」：改判属监工权限，本片只管「取消覆盖面」这段文字`,
    );
  });
});

// ---------------------------------------------------------------------------
// T6  历史页保持原状（不要为了统一口径改写）
// ---------------------------------------------------------------------------

describe('T6 历史页保持原状', () => {
  test('GY-I01 作业面取证页仍写着当时的事实「域内无取消入口」', () => {
    const page = 'docs/verification/gy-i01-jobs-surface-20261012.md';
    assert.ok(
      read(page).includes('域内无取消入口'),
      `${page} 里再也找不到「域内无取消入口」：历史页是当时记录（GY-I01 取证时取消入口确实还没有），`
        + '不要为了统一口径改写——删掉这句就再也看不到「当时为什么判 503」',
    );
  });

  test('GY-I13 合成作业取证页仍写着当时的事实「无取消能力：cancel 如实 503」', () => {
    const page = 'docs/verification/gy-i13-synthesis-jobs-20261014.md';
    assert.ok(
      read(page).includes('无取消能力：cancel 如实 503'),
      `${page} 里再也找不到「无取消能力：cancel 如实 503」：历史页是当时记录，不要为了统一口径改写`,
    );
  });
});

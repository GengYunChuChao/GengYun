/**
 * GY-R72 · 作业台账「写入面是真的、后台读面与已接源对齐」的**真话钉子**（W31 / W36）。
 *
 * ## 为什么要有这条
 * `services/api/src/admin/ops/jobs-pg.ts:4-9` 的头注释曾断言「全仓**没有任何代码向它 INSERT**」。
 * 自 GY-R71 起这是假话，而且**同一个文件自己就矛盾**：`:618-621` 的取消事务就在写统一台账行。
 * 注释给错了理由，读代码的人会以为「读台账」这件事无从下手 —— 这类假话在 R70/R71 已把改动带偏过一次。
 *
 * 本文件只钉**事实与缺口**，不碰任何 SQL／`SOURCES`／type 签名（本片零运行时行为改动）：
 * 1. T1  注释真话钉子：旧断言消失，且事实（写入点、四源、未接两源）与缺口闭合写得明白；
 * 2. T1b `jobs-pg.ts:4-9` **仍是这段注释**（文档按 `:4-9` 引用它，段一漂移，锚点就撒谎）；
 * 3. T2  台账写入面仍存在：`jobs/ledger.ts` 里那条语句仍是导出常量，本文件的取消事务仍调它；
 * 4. T3  已接源集合 = `ocr`/`recognition`/`transcription`/`answer`；未接键集只有 `moderation`/`synthesis`；
 * 5. T4  后台读面 = **四源**（三张域内作业表 + `public.conversation_turns`），与已接源集合**等号**；
 * 6. T5  闭合钉子：`answer` 已接台账**且**在读面上 ⇒ 旧缺口（「问答作业在运维台不可见／不可取消」）已被实现消掉；
 * 7. T6  缺口声明与读面**双向一致**：谁把 `answer` 从读面摘掉却留着「四源」的注释（或反之）⇒ 红。
 *
 * ## 红了怎么办（别只改一边）
 * T3/T5 红 ⇒ 台账已接源或未接集变了：**同时**改 `jobs-pg.ts:4-9` 的注释、本文件与
 * `tests/unit/ai-ops-ledger-pins.test.mjs`（钉子①的注释级白名单）。
 * T4/T6 红 ⇒ 后台读面源集变了（W36 之前是「接上 `answer` 读面」，现在是「把 `answer` 摘掉」）：
 * **同时**改 `ALL_SOURCES`、`AdminJobView` 映射、`jobs-pg.ts:4-9` 的注释与本文件的 T4/T5/T6 ——
 * 只改测试改成"通过"、或把断言弱化成 `>= 3`，都是不允许的（那正是本片负控制要演的假动作）。
 *
 * ## 断言口径
 * 文本断言只锁**关键短语与行级事实**（不整段硬匹配）：改一个词不该红一片，但"说明白了"必须锁住。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ADMIN_JOB_SQL } from '../../services/api/src/admin/ops/jobs-pg.ts';
import { LEDGER_WIRED_SOURCES, UNWIRED_SOURCES_REASON } from '../../services/api/src/jobs/ledger.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const JOBS_PG = 'services/api/src/admin/ops/jobs-pg.ts';
const LEDGER = 'services/api/src/jobs/ledger.ts';

/** 后台读面的四源（`ALL_SOURCES` 数组的 `kind`；顺序见 `ADMIN_JOB_SQL.listWhere`）。 */
const READ_FACE_SOURCES = ['ocr', 'recognition', 'transcription', 'answer'];

function read(relativePath) {
  return readFileSync(`${ROOT}${relativePath}`, 'utf8');
}

/** 文件头那段文档注释（第一个 `/** … *\/`），论据只在这里找 —— 别拿整个文件当证据。 */
function headerComment(text) {
  const start = text.indexOf('/**');
  const end = text.indexOf('*/', start);
  assert.ok(start >= 0 && end > start, '文件头没有文档注释：本片的全部论据都写在那段注释里');
  return text.slice(start, end + 2);
}

/** 1-based 行号 → 该行文本（越界即抛，避免 `undefined` 混进断言）。 */
function lineAt(text, lineNumber) {
  const lines = text.split('\n');
  assert.ok(lineNumber >= 1 && lineNumber <= lines.length, `行号 ${lineNumber} 越界（文件只有 ${lines.length} 行）`);
  return lines[lineNumber - 1];
}

/**
 * 「为什么读域内作业表（四源）」这一段的 1-based 行区间：从段标题到**下一个空注释行**（` *`）之前。
 * 直接把这把尺子架在文档锚点 `jobs-pg.ts:4-9` 上（见 T1b）。
 */
function ledgerRationaleSectionRange(text) {
  const lines = text.split('\n');
  const startIndex = lines.findIndex((line) => line.includes('## 为什么读域内作业表'));
  assert.ok(startIndex >= 0, '`## 为什么读域内作业表` 这段不见了：本片订正的就是它，删掉等于把理由抹了');
  let endIndex = lines.length - 1;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '*') {
      endIndex = index - 1;
      break;
    }
  }
  return { from: startIndex + 1, to: endIndex + 1, text: lines.slice(startIndex, endIndex + 1).join('\n') };
}

// ---------------------------------------------------------------------------
// T1 · 注释真话钉子（旧断言必须消失；事实与缺口必须写明白）
// ---------------------------------------------------------------------------

test('T1 注释不再断言「没有任何代码向它 INSERT」，且写清写入点 / 四源 / 未接两源 / 缺口', () => {
  const jobsPgText = read(JOBS_PG);
  // 旧断言逐字消失（整文件级：留着它出现在哪里都是假话）。
  assert.ok(
    !jobsPgText.includes('没有任何代码向它 INSERT'),
    '`jobs-pg.ts` 里还留着「没有任何代码向它 INSERT」：这句自 GY-R71 起就是假话（同文件 :618-621 的取消事务自己就在写台账），'
      + '读代码的人会据此以为台账是死的。删掉它，改写成「谁在写」+「为什么读面仍读域内表」',
  );

  const header = headerComment(jobsPgText);
  // 写入点（路径 + 常量名）：缺任何一个，「有人写」就只是一句没有出处的主张。
  assert.ok(
    header.includes('jobs/ledger.ts'),
    '头注释没有指向写入点 `services/api/src/jobs/ledger.ts`：说「台账有人写」必须给出写入点的路径',
  );
  assert.ok(
    header.includes('JOB_LEDGER_UPSERT_SQL'),
    '头注释没有点名 `JOB_LEDGER_UPSERT_SQL`：那是台账的唯一写入语句（`jobs/ledger.ts:268-281`），'
      + '写出常量名，读者才能顺着找到语句',
  );
  // 已接源集合（常量名，或等价地把四个源逐个列出）。
  const fourSourcesNamed = LEDGER_WIRED_SOURCES.every((kind) => header.includes(`\`${kind}\``))
    && header.includes('LEDGER_WIRED_SOURCES');
  assert.ok(
    fourSourcesNamed,
    `头注释没有写清已接源：要么给常量名 \`LEDGER_WIRED_SOURCES\` 并逐个列出 ${LEDGER_WIRED_SOURCES.join(' / ')}，`
      + '要么别声称「已接」——两可的措辞会把下一个改动者带偏',
  );
  // `answer` 必须在（W36 起它是**读面上的第四个源**，不再是「已接但看不到」的缺口）。
  assert.ok(
    header.includes('answer'),
    '头注释没有提到 `answer` 源：它是 W36 接进读面的第四源（`ALL_SOURCES` 末尾追加 `ANSWER_SOURCE`）',
  );
  // 缺口已闭合：注释必须**写明闭合的事实**，而不是把缺口句删掉了事。
  assert.ok(
    header.includes('四源'),
    '头注释没有写「四源」：`answer` 已在读面与取消面上，注释必须按四源的事实写（旧口径是「三张域内作业表」）',
  );
  assert.ok(
    header.includes('public.conversation_turns'),
    '头注释没有点名第 4 张域表 `public.conversation_turns`：四源里新增的那个源读的就是它',
  );
  assert.ok(
    header.includes('ALL_SOURCES'),
    '头注释没有点名 `ALL_SOURCES`：读面/取消面用它取四源（`SOURCES` 本体保持三源不动），不写常量名读者会以为改的是 `SOURCES`',
  );
  assert.equal(
    /不可见|不可取消/.test(header),
    false,
    '头注释还在说 `answer` 作业「不可见／不可取消」：W36 已把 `answer` 接进读面与取消面，这句话现在是假话。'
      + '改写时要写出闭合的事实（四源 / `ALL_SOURCES` / `public.conversation_turns`），不是删词了事',
  );
});

// ---------------------------------------------------------------------------
// T1b · 文档锚点 `:4-9` 仍覆盖这段注释（段一漂移，锚点就撒谎）
// ---------------------------------------------------------------------------

test('T1b 文档按 `jobs-pg.ts:4-9` 引用的那段注释仍恰好是第 4-9 行', () => {
  const jobsPgText = read(JOBS_PG);
  const section = ledgerRationaleSectionRange(jobsPgText);
  assert.equal(
    section.from,
    4,
    `「为什么读域内作业表（四源）」这一段现在从第 ${section.from} 行开始，文档锚点写的是 \`:4-9\`（见`
      + ' docs/architecture/ai-ops-spec-status.md 的 N04 与 docs/verification/gy-r31-i18-recon-20261022.md）——'
      + '要么把这段挪回第 4 行，要么按 `node tools/verify-doc-anchors.mjs --strict --scan docs` 的报错把文档行号改对',
  );
  assert.equal(
    section.to,
    9,
    `这一段现在到第 ${section.to} 行结束，文档锚点写的是 \`:4-9\`：段尾挪动同样要让文档行号跟上（本片刻意等行替换，6 行进、6 行出）`,
  );
});

// ---------------------------------------------------------------------------
// T2 · 台账写入面仍存在（语句在、导出在、本文件的取消事务仍调它）
// ---------------------------------------------------------------------------

test('T2 台账写入面：`INSERT INTO public.jobs` 仍在 `jobs/ledger.ts`，且仍是导出常量', () => {
  const ledgerText = read(LEDGER);
  assert.ok(
    ledgerText.includes('INSERT INTO public.jobs'),
    '`jobs/ledger.ts` 里已经没有 `INSERT INTO public.jobs` 了：头注释（`jobs-pg.ts:4-9`）声称的「唯一写入点」随即变成假话，'
      + '要么恢复语句，要么同 PR 改注释与 T1',
  );
  assert.match(
    ledgerText,
    /export const JOB_LEDGER_UPSERT_SQL\s*[:=]/,
    '`JOB_LEDGER_UPSERT_SQL` 不再是 `jobs/ledger.ts` 的导出常量：真库臂与单测都靠它拿语句文本，'
      + '改成内部常量会让「写入面是什么」重新变成口头约定',
  );

  // 本文件的取消事务确实在写同一张表（`jobs-pg.ts:618-621` 的注释说的就是这件事）。
  const jobsPgText = read(JOBS_PG);
  assert.match(
    jobsPgText,
    /await writeJobLedger\(/,
    '`jobs-pg.ts` 的取消事务不再调 `writeJobLedger(` 了：那 `:618-621` 的注释与头注释都要跟着改（本片不动行为，但事实必须一致）',
  );
  assert.match(
    jobsPgText,
    /ledgerRowFromDomainJob\(/,
    '`jobs-pg.ts` 不再用 `ledgerRowFromDomainJob(` 映射台账行：取消事务与台账的接线断了，注释里的「同一事务写台账」就不成立',
  );
});

// ---------------------------------------------------------------------------
// T3 · 已接源集合与未接源键集（常量一变，注释与测试必须同时改）
// ---------------------------------------------------------------------------

test('T3 已接源恰四源 ocr/recognition/transcription/answer；未接键只有 moderation/synthesis', () => {
  assert.deepEqual(
    [...LEDGER_WIRED_SOURCES],
    ['ocr', 'recognition', 'transcription', 'answer'],
    '台账已接源集合变了：`jobs-pg.ts:4-9` 的注释、本文件与 `ai-ops-ledger-pins.test.mjs` 必须同 PR 改（⛔ 不许只改测试）',
  );
  assert.deepEqual(
    Object.keys(UNWIRED_SOURCES_REASON).sort(),
    ['moderation', 'synthesis'],
    '未接源键集变了：`UNWIRED_SOURCES_REASON` 是「为什么这两个源接不进来」的唯一登记处，'
      + '增减键都要同步注释（`jobs-pg.ts:4-9` 的「未接的只有 …」）',
  );
});

// ---------------------------------------------------------------------------
// T4 · 后台读面 = 四源，且与已接源集合**等号**（不是子集）
// ---------------------------------------------------------------------------

test('T4 后台读面（`ALL_SOURCES`）恰四源，且与已接源集合等号', () => {
  assert.equal(
    ADMIN_JOB_SQL.list.length,
    4,
    '后台列表读面不是四源了：`ALL_SOURCES` 变了就同 PR 改 `jobs-pg.ts:4-9` 的注释与本文件 T4/T5/T6'
      + '（⛔ 不许只改测试，也不许把断言弱化成 `>= 3`）',
  );
  for (const key of ['get', 'lock', 'update']) {
    assert.equal(
      ADMIN_JOB_SQL[key].length,
      ADMIN_JOB_SQL.list.length,
      `\`ADMIN_JOB_SQL.${key}\` 与 \`list\` 的源数不一致：四源必须逐条对齐（否则某个源读得到、取消不到）`,
    );
  }
  const readFaceKinds = ADMIN_JOB_SQL.listWhere.map((entry) => entry.kind).sort();
  assert.deepEqual(
    readFaceKinds,
    [...READ_FACE_SOURCES].sort(),
    '后台读面源集不是 ocr/recognition/transcription/answer：注释的四源口径与 T5/T6 要跟着改',
  );
  for (const kind of READ_FACE_SOURCES) {
    assert.ok(
      LEDGER_WIRED_SOURCES.includes(kind),
      `后台读面源 \`${kind}\` 不在已接源 \`LEDGER_WIRED_SOURCES\` 里：读面只能读已接台账的源（取消事务要在同一事务写台账）`,
    );
  }
  // W36 起是**等号**：读面不得比已接源少（漏源 ⇒ 运维台看不到／取消不到），也不得多（多 ⇒ 取消事务写不出台账行）。
  assert.deepEqual(
    readFaceKinds,
    [...LEDGER_WIRED_SOURCES].sort(),
    '后台读面源集与已接台账源集不再等号：少一个 ⇒ 那个源的作业在运维台不可见、取消时写不出台账行；'
      + '多一个 ⇒ 取消事务走不到 `ledgerRowFromDomainJob`/`ledgerRowFromTurn`',
  );
});

// ---------------------------------------------------------------------------
// T5 + T6 · 缺口闭合钉子与「缺口声明 ↔ 读面」双向一致
// ---------------------------------------------------------------------------

test('T5 缺口已闭合：`answer` 已接台账**且**在读面上（旧缺口不许复活）', () => {
  assert.equal(
    LEDGER_WIRED_SOURCES.includes('answer'),
    true,
    '`answer` 不在已接源里了：若真的撤掉了它，`jobs-pg.ts:4-9` 的注释与本文件 T4/T5/T6 要一起改',
  );
  // 缺口闭合的机械判据：读面源数 == 已接源数，且 `answer` 在其中。
  assert.equal(
    ADMIN_JOB_SQL.list.length,
    LEDGER_WIRED_SOURCES.length,
    `后台读面源数 ${ADMIN_JOB_SQL.list.length} 不等于已接源数 ${LEDGER_WIRED_SOURCES.length}：W36 把 \`answer\` 接进读面后，`
      + '两边必须等号 —— 谁把 `answer` 从 `ALL_SOURCES` 摘掉，T4 与 T5 同时红'
      + '（⛔ 也不许把这条断言弱化成 `>= 3`：那等于允许缺口重新长回来）',
  );
  assert.ok(
    ADMIN_JOB_SQL.listWhere.some((entry) => entry.kind === 'answer'),
    '读面里没有 `answer` 源：问答作业（`public.conversation_turns`）会退回「运维台不可见／不可取消」的旧缺口',
  );
});

test('T6 缺口声明与读面双向一致：摘掉 answer 读面却没改注释（或反之）必须红', () => {
  const header = headerComment(read(JOBS_PG));
  const commentDeclaresGap = /不可见|不可取消/.test(header);
  // 四源读面（三张域内作业表 + `answer` 的会话轮次）：只看 `answer` 在不在 `listWhere` 里，比数长度更难糊弄。
  const readFaceCoversAnswer = ADMIN_JOB_SQL.listWhere.some((entry) => entry.kind === 'answer');
  assert.notEqual(
    commentDeclaresGap,
    readFaceCoversAnswer,
    readFaceCoversAnswer
      ? '后台读面已经覆盖 `answer`（四源），但头注释仍宣称问答作业「不可见／不可取消」：注释落后于实现，改注释（并让 T5 保持闭合口径）'
      : '后台读面没有 `answer`（退回三源），但头注释不再声明这个缺口：缺口被悄悄抹掉了，把「已知缺口 + 后果」写回去',
  );
});

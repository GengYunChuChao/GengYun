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
 *
 * 2026-11-02 同步过两次（都不是回归）：
 *   ① R72 把 `docs/architecture/contract-implementation-status.md` 的 :19 与 :205 两行散文
 *      改成「以 X 为准」的指针（**行数不变、字节 +174**）；
 *   ② R72 把 `advanceReport` 的 blocker 第 ③ 条从「已在 KNOWN_NO_UI_ENTRY 登记」——那是假话
 *      （该表实测为空数组，且该 op 因路由落在 `services/api/src/routes/admin-reports.ts`、
 *      闸门只扫 `routes/admin.ts` 而没进能力图）——改成如实描述。
 *
 * 2026-11-03 再同步一次（GY-R73-C 审核理由码读面片，与 #838 合并后重锚）：**正常改台账**，
 * 全部是「同一行的引用换了写法／按当前树重取行号」，没有改判定、没有加豁免条目 ——
 * ① `services/api/src/community/service.ts` 涨了 45 行（#838 又在其 :1676 之后加了 24 行），
 *    `listPosts`/`createPost`/`createComment` 等 16 条 evidence 的 `lines` 由
 *    `--reanchor --write-doc` 重写；
 * ② 其中 8 条原来只写裸方法名（`listPosts` 等，纯子串会命中注释与 `store.listPosts(`）⇒
 *    补成完整签名文本才可重锚；`createPost`/`createComment` 两条取机械位移区间；
 * ③ `editPost` 那条 evidence 的裸 `:1030-1157` 按 `git diff -U0` 端点映射改成 `:1075-1202`；
 *    16 处 blocker 文案里的裸 `（`:1213`）` 补成显式 `services/api/src/app.ts:1309`。
 * 本条钉的是「这个切片没有顺手改到别处」，不是「台账不许改」：改台账就同步基线。
 *
 * 2026-11-03 同日第二次同步（同一 PR #857 的后续提交：`reason_codes` 从「可选/缺席」改成
 * 「required 且没有码时给空数组 `[]`」）：`services/api/src/community/service.ts` 再涨 9 行，
 * 9 条 evidence 的 `lines` 按 `base(ef22d5a9)→HEAD` 端点映射重取（`960-1026`→`969-969` 等），
 * 中文表格由 `verify-contract-status.mjs --write-doc` 从 JSON 重生成 ⇒ 两个文件各**少 1 字节**、
 * 行数不变（4407 / 218）。仍是「正常改台账」，故同步基线。
 * 2026-11-03 同日第三次同步（GY-R74 注销真清片，`feat/gy-r74-deletion-real`）：**正常改台账** ——
 * 本片把注销受理门从「real ⇒ 整域 503」改成「real + 真库 ⇒ 可受理」，并把 30 日备份域按域如实降级
 * （`services/api/src/app.ts` 的 `backupPurgeWiring` real 臂恒 `createUnavailableBackupPurgePort()`）、
 * 第三方回执补能力布尔、媒体域缺 `MEDIA_OBJECT_REF_KEY` 时识别域如实 blocked。台账侧只有两类变化：
 * ① 6 条 evidence 的 `lines` 按 `base(7a25d900)→HEAD` 端点映射重取（`account-deletion.ts` 三个文件都长了行）；
 * ② 3 条 blocker 文案按新真值重写（原「real 模式整域 503」已作废）并改写 `ACCOUNT_DELETION_UNAVAILABLE_MESSAGE`；
 * 中文表格仍由 `verify-contract-status.mjs --write-doc` 从 JSON 重生成；写回时顺手去掉了这两个文件末尾
 * 多出来的空行（`git diff --check` 报的 `new blank line at EOF`）⇒ 与分支侧基线相比**各 +814 字节、行数不变**
 * （4407 / 218）。没有改判定、没有加豁免条目，故按本文件既定规则同步基线。
 * 2026-11-03 第四次同步（R74 音频读面片，`origin/main` 侧）：新增 `readSynthesisAudio`
 * （`GET /speech/synthesis/{id}/audio`）⇒ 台账多一条 operation 行（+27 行 / +2219 字节），
 * `contract-implementation-status.md` 多一行（+1 行 / +1680 字节）。仍是「正常改台账」
 * （operations 128 → 129、中文表格由 `verify-contract-status.mjs --write-doc` 重生成），
 * 故同步基线；没有改判定、没有加豁免条目。
 * 2026-11-03 同日第五次同步（同片、同一 PR 的锚点恒等修正）：`tools/doc-anchor-relocation-identity`
 * 要求「目标文件本提交有改动 ⇒ 行号必须落在该文件自己的端点映射上」，于是 timeout 维度的 evidence
 * 行号 `977-1003` → `964-989`（少 1 个字符位）；中文表格再由 `--write-doc` 从 JSON 重生成 ⇒
 * 两个文件各**少 1 字节**、行数不变（4434 / 219）。仍是「正常改台账」，故同步基线。
 * 2026-11-03 第六次同步（同片后续返修：音频读面在返回字节前重查）：tts/service.ts 再涨行，
 * timeout 维度的 evidence 先由 `--reanchor --write-doc` 重锚到 `1004-1030`，随后为满足
 * `doc-anchor-relocation-identity` 的端点映射要求改成 `982-1007`（区间仍含声明行 `:1004`）⇒
 * 两份台账各**多 1 字节**、行数不变（4434 / 219）。仍是「正常改台账」，故同步基线。
 * 2026-11-03 第六次同步（GY-R75 契约计数口径订正，与 OCR 锚点无关）：`contract-status.json` 的 media blocker
 * 里「冻结契约（86 条路径 / 113 条 operation，实测 `packages/contracts/openapi.json`）」按基线 `3cdf4740`
 * 实测改成「99 条路径 / 129 条 operation」并补「，基线 `3cdf4740`」⇒ 两份台账各**多 20 字节**、行数不变
 * （4434 / 219）。仍是「正常改台账」，故同步基线。
 * 2026-11-04 第七次同步（R75 历史详情读面片）：新增 `getHistory`（`GET /history/{id}`）⇒
 * 台账多一条 operation 条目（+31 行 / +2430 字节），`contract-implementation-status.md`
 * 多一行 operation 行与标题计数（+1 行 / +1821 字节）。`listHistory`/`deleteHistory` 的 evidence
 * 行号由 `--reanchor --write-doc` 重写（80-83→88-88、85-98→103-105），中文表格同次重生成。
 * 仍是「正常改台账」（operations 129 → 130），故同步基线；没有改判定、没有加豁免条目。
 * 2026-11-04 第八次同步（`git merge origin/main` = 3b89782f 之后重取实测值）：上面第六条（#875，在 main 上）
 * 与第七条（R75，在本分支上）是两条并行分支各自记的「同序号一次同步」，合并后按时间顺序重编号，
 * 正文逐字保留。合并把 #875 的计数口径订正与 `getHistory` 条目叠在同一份台账上。
 * ⚠️ 第六／第七次记的行数是按 `split('\n').length` 数出来的（末尾换行多算一行），
 * 本条改按本用例 `countLines` 的口径实测：合并后 `contract-status.json` 276447 字节 / 4465 行、
 * `contract-implementation-status.md` 198007 字节 / 220 行（= 本分支 276427/4465 与 197987/220
 * 各 +20 字节，正是 #875 那一行的增量）。仍是「正常改台账」，故同步基线；没有改判定、没有加豁免条目。
 * 以下两段是 main 侧（#857／#873 线）自己的历史注释，其「第七／第八次」与本分支的编号撞号，
 * 按历史注释原样保留、不重编号（历史注释不重写）：
 * 2026-11-03 合入 `origin/main`（3d9b2369）后第七次同步：两侧基线在此取**并集** —— 分支侧（注销真清片）
 * 与 main 侧（音频读面）的台账改动同时保留：取消维度按合流树实测为 `services/api/src/app.ts:2553`
 * （六源 `:2554`/`:2560`/`:2566`/`:2572`/`:2580`/`:2590`），超时维度同时保留分支侧的装配点
 * `services/api/src/app.ts:2678` 与 main 侧的 `services/api/src/tts/service.ts:982-1007`，
 * `## 3 已装配操作` 为 129 条（main 新增 `readSynthesisAudio`）。合流后的实际体积：JSON 274811 字节 /
 * 4434 行、md 196980 字节 / 219 行（行数与 main 一致；字节各比 main 多 814，是分支侧注销片重写文案的净增）。
 * 没有改判定、没有加豁免条目，故按本文件既定规则同步基线。
 * 2026-11-03 合入 `origin/main`（3b89782f）后第八次同步：基线停在上面那次合流（274811 / 196980）之后，
 * 又有两笔「正常改台账」没进来 —— ① 分支侧 `c971c11b`（真库臂证据串）把两份台账里「证据串只有两段」
 * 改成如实描述「两段 + real 模式下按模块追加 `;<module>:backup-<状态>:<码>`」，两份台账各 +864 / +867 字节，
 * 但该提交没同步基线（于是 T5 在分支 HEAD 上就已经红）；② main 侧 #875 的 media blocker 计数订正各 +20 字节
 * （即上面那条「第六次同步（GY-R75…）」——它与本片 #857 线的第六次不是同一片，两条编号撞了，这里是历史注释，
 * 按原样保留不改号）。合流树实测：JSON 275695 字节 / 4434 行、md 197867 字节 / 219 行
 * （= 274811+20+864、196980+20+867；行数与两侧都一致）。两笔都是正常改台账，没有改判定、
 * 没有加豁免条目，故按本文件既定规则同步基线。
 * 2026-11-04 第九次同步：再一次 `git merge origin/main`（3b89782f → 5dd6da3a，即 #873
 * 「接通注销在线域清理并如实披露备份阻塞」合入 main）。合流后按本用例 `countLines` 口径实测：
 * `contract-status.json` 278125 字节 / 4465 行、`contract-implementation-status.md` 199688 字节
 * / 220 行 —— 行数与上一次同步相同（#873 只改 evidence 文案与中文表格，没有增删 operation 行），
 * 字节数是两侧文案的净增。仍是「正常改台账」，故同步基线；没有改判定、没有加豁免条目。
 * 2026-11-04 第十次同步（`readCommunityMediaContent` 的 blocker 与代码正面矛盾）：该条 blocker 原写
 * 「真实内容来源未接线（来源关闭时统一 404）」，但 `services/api/src/media/content-source.ts` 的头注释
 * 自述「真实来源（GY-I06/G3）已接线：默认装配是 `createRealContentSource(communityService, mediaStore)`」，
 * 装配点也在 `services/api/src/app.ts`（`contentSource: mediaContentSource ?? createRealContentSource(...)`）。
 * 故改成「……真实内容来源已接线（默认 `createRealContentSource(communityService, mediaStore)`，社区域未接线时
 * 回落 `createClosedContentSource()` ⇒ 取图统一 404）……」。中文表格同次用 `--write-doc` 重生成。
 * 两份台账各 +118 字节、行数不变（278243 / 4465、199806 / 220）。仍是「正常改台账」，故同步基线；
 * 没有改判定、没有加豁免条目。
 * 2026-11-04 第十一次同步（六条 admin 的 blocker 把「后台 UI 未消费」写成待办，实际页面已消费）：
 * `listAdministrators`、`listAdministratorScopes`、`grantAdministratorScope` 由
 * `apps/admin/src/views/AdministratorsView.vue` 消费；`listAdminUsers`（`GET /admin/accounts`）由
 * `apps/admin/src/views/AccountsView.vue`、`listFlags`（`GET /admin/feature-flags`）由 `FlagsView.vue`、
 * `listAuditEvents`（`GET /admin/audit-events`）由 `AuditEventsView.vue` 消费。文案改成「后台 UI 已消费本接口
 * （路径）……真实环境联调未做」，其余「真实存储／端口／审计待完成」的判断维持不动。中文表格同次重生成。
 * 两份台账各 +472 字节、行数不变（278715 / 4465、200278 / 220）。仍是「正常改台账」，故同步基线；
 * 没有改判定、没有加豁免条目。
 * 2026-11-04 第十二次同步（台账 blocker 散文的 file:line 首次有了可执行校验）：新增
 * `tests/unit/contract-blocker-anchor-truth.test.mjs`，对该 JSON 里 `blocker` / `source_anchor` 散文中以
 * `services/ apps/ packages/ tools/ tests/ docs/ miniprogram/ deploy/ scripts/` 开头的 `path:line[-line]` 判三件事：
 * 文件存在、行号在界内（两端都判）、起点不落在空行／纯闭合括号／纯注释行。按它扫出的明确漂移重锚 7 处（3 组）：
 * `services/api/src/app.ts:802-806`→`893-897`（`listMessages`/`getUnreadCount`/`markMessageRead` 各一处，按
 * `createPostgresMessagesStore` 的唯一装配点 897 定位）、同样这三条的 `:1126-1130`→`1217-1221`（按
 * `createMessagesCommunityEventsPort` 的唯一装配点 1221 定位；旧区间落在识别域装配块上）、
 * `deploy/postgres-cvm/backup-postgres.sh:24`→`188`（脚本里 `pg_dump` 的唯一执行点）。
 * 前两组等长、只有 `:24`→`:188` 多一个字符位 ⇒ 两份台账各**多 1 字节**，行数不变。
 * 中文表格由 `verify-contract-status.mjs --write-doc` 从 JSON 重生成。仍是「正常改台账」，故同步基线；
 * 没有改判定、没有加豁免条目（新用例的锚点白名单为空）。
 * 2026-11-04 第十三次同步（`requestAccountDeletion` 的 blocker 把自己引的部署文档锚点指错了）：该条 blocker 用
 * 「`deploy/postgres-cvm/README.md:459-460`／`runbook.md:540` 均自认未实现」当证据，实测 README 的第 459 行是
 * SCRAM 加固句、真正的「备份不实现"注销后备份 30 日内清理个人数据"」在第 460-461 行；runbook 的第 540 行是
 * 「`sudo cp -r <备份的 conf.d>`」，真正的自认在 614 行（U9「逐用户删除，本交付未实现」）。另把同段
 * 「仓根 `README.md` 全文只有 270 行」改回实测的「221 行」（`README.md` 共 222 个 split 行），并把旧文案里那处裸
 * `README.md:459` 改写成散文「误记到仓根 README 的第 459 行」，免得它继续挂在 relocation 的「未判」桶里。
 * 两份台账各 +11 字节、行数不变（278727 / 4465、200290 / 220）。仍是「正常改台账」，故同步基线；
 * 没有改判定、没有加豁免条目。
 * 2026-11-04 第十四次同步（封面散文里三处手抄读数过期，只动 md、不动 JSON）：`docs/architecture/contract-implementation-status.md`
 * 把「34 个后台端点」当事实沿用（`node tools/verify-admin-capability-map.mjs --check` 实测 `totalOps=50`，媒体仍 7 个）、
 * 把「113 条业务契约」当现值（`node tools/verify-contract-status.mjs` 实测 130 条）、把「141 条带 `name` 的证据／32／70／39」
 * 当现值（实测 595 条证据中 243 条带 `name`，三类拆分随证据增补而变，已改成「以当次工具输出为准」），三处都改成
 * 「数字 + 复核日期 + 指向脚本」的写法。JSON 未动 ⇒ 体积变为 278727 / 4465 与 **200749 / 220**，行数都不变。
 * 仍是「正常改台账」，故同步基线；没有改判定、没有加豁免条目。
 * 2026-11-04 第十五次同步（四条 blocker 散文与今日代码对齐：停用/启用、发帖入口、注销媒体）：
 * ①`disableAdministratorAccount` 与 `enableAdministratorAccount` 原写「剩余：后台 UI 无停用/恢复入口（属 GY-I18 联调）」，
 * 实际 `apps/admin/src/views/AdministratorsView.vue` 有「停用」「恢复」按钮，经 `apps/admin/src/lib/administrator-state-api.mjs`
 * 真发 `POST /admin/administrators/{id}/disable` 与 `.../enable` ⇒ 改成「后台 UI 已消费本接口（路径）……，真实环境联调未做
 * （属 GY-I18）」，两条的 `partial` 判定与其余缺口一字不动；②「小程序发帖页仍无填写入口」这句不是只出现在 `createPost`，
 * 而是 16 条社区 operation 的 blocker 共用（`listPosts`／`createPost`／`getPost`／`editPost`／`deletePost`／四个评论读写／
 * 四个点赞／`createReport`／`getOwnReport`），而 `miniprogram/pages/communitycreate/communitycreate.wxml` 已有标题 input、
 * 正文 textarea 与「提交审核」按钮（`miniprogram/pages/communitycreate/communitycreate.js` 调 `api.createPost`），提交经
 * `miniprogram/utils/community-api.js` 的 `createPost`／`createComment`，`miniprogram/app.json` 已注册该页 ⇒ 16 处一并改成
 * 「发帖页已具备填写与提交入口（路径）」，先审后发、正式微信身份/真机与真实审核验收等其余阻塞原样保留；
 * ③`deleteMedia` 原把「注销 7/30 天删除闭环、备份与第三方完成证据未接线未验收」与**已接线**的媒体逐用户清除原语写在一起，
 * 实际 `services/api/src/media/store-pg.ts` 的 `purgeOwnedMedia` 调 `public.purge_owner_media`、
 * `services/api/src/privacy/user-data-deletion.ts` 的 `MediaPurgePort` 经识别域 `input.mediaStore` 注入 ⇒ 改成
 * 「媒体逐用户清除原语已接线（路径）……；仍成立的是注销 7/30 天删除闭环未执行、备份介质逐用户清理未接线、第三方完成证据未验收」，
 * 并把「桶对象真删仍走 `cleanupOrphans` 清扫通道（`tools/purge-expired-media.mjs`）」一并写明，不把登记台账说成已删桶对象。
 * 共 19 条 blocker（16＋2＋1），中文表格同次用 `verify-contract-status.mjs --write-doc` 重生成。两份台账各 +4977 字节、
 * 行数不变（283704 / 4465、205726 / 220）。仍是「正常改台账」，故同步基线；没有改判定、没有加豁免条目。
 * 另：同日 #925（第十六次同步）只改第 17 行一句语义（取消已覆盖识别/转写/合成/OCR/审核/文字问答六域，
 * PROVIDER_UNAVAILABLE 退为兜底），未动闸门块、未动 JSON；它先合入，本片在其上重放。
 * 合并后实测：JSON **283704 / 4465**、md **206173 / 220**（本片 +4977 与 #925 的 +447 相加）。
 * 仍是「正常改台账」，故同步基线；没有改判定、没有加豁免条目。
 * 2026-11-04 第十七次同步（`deleteMedia` 的 blocker 把两个媒体清除原语写成了一次直接调用）：
 * 上文第十五次③虽然写明了「原语已接线」，但仍写成 `purgeOwnedMedia` 调 `public.purge_owner_media`。
 * 实测 `services/api/src/media/store-pg.ts` 的 `purgeOwnedMedia(ownerId)`（单事务：软隐藏社区句柄 ⇒
 * 把对象键登记进待删台账 ⇒ 清引用 ⇒ 删衍生物）**不调** `public.purge_owner_media` —— 迁移 0035 那个按主体
 * 删媒体行的窄函数只删 rejected/deleted、且要求台账意图先存在，与本原语「先软隐藏、再动对象」的顺序相反；
 * 真正执行 `SELECT public.purge_owner_media(...)` 的是同文件另一方法 `purgeOwnerMediaRows()`，由
 * `purgeRetiredRows()` 调用。故改成「注销路径的媒体逐用户清除原语已接线（`purgeOwnedMedia`，由
 * `services/api/src/privacy/user-data-deletion.ts` 的 `MediaPurgePort` 经识别域 `input.mediaStore` 注入）：
 * 注销时在单事务内软隐藏社区句柄、把对象键登记进待删台账、清引用并删衍生物——它不调 `public.purge_owner_media`；
 * 真实桶对象删除仍由 `cleanupOrphans` 清扫通道承担，物理终态媒体行另由 `purgeOwnerMediaRows()`／
 * `purgeRetiredRows()` 收口；真实桶／排班仍待集成验收」，`partial` 判定与其余缺口一字不动。
 * 中文表格同次用 `verify-contract-status.mjs --write-doc` 重生成。两份台账各 +426 字节、行数不变
 * （284130 / 4465、206599 / 220）。仍是「正常改台账」，故同步基线；没有改判定、没有加豁免条目。
 * 2026-11-04 第十八次同步（超时维度把同一识别截止声明块写成了两条几乎相同的重复区间）：
 * 第 43 行原对 `services/api/src/recognitions/service.ts` 的 `runProviderWithDeadline` 同时登记 `525-542`
 * 与 `525-544` 两条证据锚点，可 525 行今天是 `      deleted: false,`（前一个 `commitTerminal` 分支的收尾），
 * 真正的声明块是 530-549 行：530 `  async function runProviderWithDeadline(job: JobRow): Promise<`
 * … 537-539 建 timeout（`timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);`）…
 * 545 `      return await Promise.race([call, timeout]);` … 549 `  }`。故删掉重复的那条、把留存的一条改成
 * `530-549`，同句散文锚点 `services/api/src/recognitions/service.ts:525` 一并改成 `:530`。
 * 同句裸锚点 `:531-533`（今天 531-533 是返回类型联合，计时器构造在 537-539）未动：它在
 * `tools/doc-anchors-orphan-baseline.json` 里按原文登记，改文本会让该键陈旧，本片不改 `tools/**`。
 * `partial` 判定与其余缺口一字不动。中文表格同次用 `verify-contract-status.mjs --write-doc` 重生成。
 * JSON −159 字节、−5 行（重复证据对象整块删掉），md −51 字节、行数不变
 * （283971 / 4460、206548 / 220）。仍是「正常改台账」，故同步基线；没有改判定、没有加豁免条目。
 * 2026-11-04 第十九次同步（台账第 68 行「一行 21 个锚点」的大格子里四处测试锚点指错）：改的是
 * `docs/architecture/contract-status.json` 里 `requestAccountDeletion` 的 blocker 散文，中文对照表的那一格由
 * `verify-contract-status.mjs --write-doc` 从 JSON 重生成（该行的证据列与缺口列都是 JSON 的镜面，直接手改 md 会被
 * 重生成打回去）。该格写 F13 注销回执的四类实跑读数，但引的三个测试锚点都落到无关行上：
 * `tests/unit/user-data-deletion.test.mjs:88` 是「必需模块闭集含四域」的 `MESSAGES_DELETION_MODULE` 常量断言，
 * 散文说的却是「无真库默认装配下各模块 backup_state 为 pending」，真值在同文件 `:136` 的四模块 for 循环里
 * （`assert.equal(row.backup_state, 'pending', '备份副本清除未接线 ⇒ 如实 pending，不得谎称 completed')`，132-138）；
 * `tests/unit/backup-copies-port-contract.test.mjs:572-582` 是「接线三态」（带证据 ⇒ completed／没证据 ⇒ blocked +
 * EVIDENCE_REQUIRED）的断言，散文要的「real 且注入持久台账但无池 ⇒ 端口显式不可用、模块 blocked +
 * PROVIDER_UNAVAILABLE」在 `:606-616`；`tests/integration/backup-purge-pg.mjs:413-414` 是臂 A 的种子数据、
 * `tests/unit/user-data-deletion.test.mjs:196` 是「未绑定主体」用例的标题，两句要的「被驱动的一次重放里可判
 * completed」分别在 `:481-493`（481 `await deletionA.executeHandlers(requestA.id);`，483-487 四域 completed、
 * 489-493 整体 completed）与 `:269`（wired 端口驱动一次后 `completionStatus(...).completed === true`，270-271 判不重跑）。
 * 同格另有一处同文件同符号的重复锚点（`services/api/src/app.ts:2012-2013` 是 `:2009-2016` 的真子区间、同一个 real
 * 分支的 `createUnavailableBackupPurgePort()`），按 #949 的办法收成一条，散文改写成「该备份清除装配在 real 下恒 …」；
 * 该重复锚点是同行最后一个 `app.ts` 锚点，收掉后配对不位移，故只登记 4 条按文本重锚（无「非内容重锚」条目）。
 * 裸锚点（`:132-135`、`:138-145`、`:70-76`、`:469`、`:464-465`、`:103-105`）按规矩一律不动数字，
 * completionStatus 的真值改用散文写出（第 153-155 行）。体积数字在 #949 删掉那块重复证据对象之后重算：
 * 两份台账各 +36 字节、行数不变（284007 / 4460、206584 / 220）。仍是「正常改台账」，故同步基线；
 * 没有改判定、没有加豁免条目。
 * 2026-11-05 第二十次同步（cancel 维度去冗余 + 两条裸锚点显式化 + 修 bfbe12cd 括注；基线 9143a4db）：
 * 第 42 行四处。①evidence 里 `services/api/src/routes/admin.ts` 的取消路由原记 `483-488`，那 6 行只到
 * `app.post(` 与 schema（488 是 `    },`），没覆盖 handler 与收尾 `);`，改成 `483-491`；②blocker 里
 * `POST /jobs/:id/cancel` 又抄了一遍 `services/api/src/jobs/routes.ts:64-80`（与本段 evidence 完全重复）⇒
 * 改成「路由见上表」，不新增锚点；③同句 `services/api/src/jobs/registry.ts:306` 那条 503 分支已被 evidence 的
 * `283-309` 整块包含 ⇒ 改成「同文件 `cancel` 的 503 分支」，同句两条裸锚点 `:265`（`createJobRegistry` 声明行）
 * 与 `:42`（`registerJobRoutes` 声明行）补成 `services/api/src/jobs/registry.ts:265`／
 * `services/api/src/jobs/routes.ts:42`（数字一个没动）：这两条原本按 `ambiguous-block` 登记在
 * `tools/doc-anchors-orphan-baseline.json`，补前缀后那两条会「册上陈旧」，故按工具允许的方式重跑
 * `--scan docs --write-orphan-baseline --accept=0` 重建（实测新增 0 条、孤儿 3495→3493、作用域外 117 条不变），
 * 没有手删条目；④「（下列行号为本基线 `bfbe12cd` 实测）」的反引号让它被符号配对当成紧邻
 * `services/api/src/jobs/sources.ts:65` 的标识符（中间只隔 9 个字符，判据上限 12）⇒ 去掉反引号写成
 * 「本基线 bfbe12cd 实测」，该条 `sources.ts:65（ZERO_HIT）` 消失，`SYMBOL-COVERAGE-UNDECLARED`／
 * `SYMBOL-COVERAGE-MISS` 各 16→15 条，`SYMBOL-COVERAGE-VERIFICATION` 的 805 条与 `-MISS` 的 393 条不变。
 * `partial` 判定与其余缺口一字不动。中文表格同次用 `verify-contract-status.mjs --write-doc` 重生成。
 * JSON +32 字节、行数不变；md +32 字节、行数不变（284039 / 4460、206616 / 220）。仍是「正常改台账」，
 * 故同步基线；没有改判定、没有加豁免条目。
 */
const DELIVERY_SIZE_BASELINE = [
  { label: 'docs/architecture/contract-status.json', path: STATUS_JSON, bytes: 284039, lines: 4460 },
  { label: 'docs/architecture/contract-implementation-status.md', path: STATUS_MD, bytes: 206616, lines: 220 },
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

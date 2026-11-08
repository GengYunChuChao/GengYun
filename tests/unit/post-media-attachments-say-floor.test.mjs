/**
 * GY-R87 · #1030 的「⑩ / ⑪ 不许被静默删除」静态守卫（A 档内闭合）。
 *
 * 背景（#1037 审查 `369b9d9a`）：`.github/workflows/real-pg-integration.yml` 的读数闸门**原本**是
 *
 *     if [ "$readings" -lt 13 ]; then … exit 1
 *
 * 而 `tests/integration/post-media-attachments-pg.mjs` 现在真跑产出 **19** 条 `PASS n:` ——
 * 把 ⑩（同帖并发）/ ⑪（owner_id / state 行为级负控制）两节**整段删掉** ⇒ 16 条仍 ≥ 13，step 照样绿。
 * 这个缺口已由 workflow 侧的 `-lt 19` 堵上（本 PR，B 档）：删节后真跑只剩 16 条 ⇒ CI step 当场红。
 * 这里再补一条**更快的纯静态**守卫：不连库，`tests/unit` 一遍就红。
 * 三处数字必须同时改：workflow 的 `-lt 19` ＋ `tests/unit/ci-real-pg-readings-gates.test.mjs`
 * 的 `baseline: 19` ＋ 本文件的 `SAY_FLOOR = 19`。末尾「跨文件互校」那两条断言就是钉这件事的：
 * 三者不一致即红，且 `SAY_FLOOR` 还必须等于臂脚本实测的 `say(` 调用点数（只改数字会红）。
 *
 * 两条判据：
 *   ① **计数**：**可执行** `say(` 调用点 ≥ 19（⑩ 占 1 个、⑪ 占 2 个）。删掉 ⑩ 或 ⑪ 的 state 支 ⇒ 18，
 *      本文件立刻红；workflow 侧 `-lt 19` 那道也会在真跑时跟着红（本守卫只是更快的静态补位）。
 *   ② **锚点**：⑩/⑪ 的关键文案与结构串必须仍在（每节的 say 行前缀、⑩ 的并发断言文案、
 *      ⑪ 的 owner/state 夹具与 4 个 state 值）。这条比①硬：只删节、别处补 `say(` 凑够 19
 *      也照样红。
 *
 * 计数口径（`stripCommentsAndLiterals`）：先把 `//` 行注释、`/* … *​/` 块注释，以及 `'…'` /
 * `"…"` / `` `…` `` 三种字面量整段抹成空格，再对**代码面**匹配 `\bsay\s*\(`。于是：
 *   · 注释里写的 `say(` 不计（本仓注释经常贴反例）；
 *   · `say('…')` 实参文本里再出现的 `say(` 不计（整段已被抹掉）—— 这正是「数调用点」与
 *     「grep 命中数」的差别，后者会被文案撑大；
 *   · `say ('…')` 带空格算**同一个**调用点。
 * 抹注释/字面量时用一个空格占位，避免把两侧 token 粘成一个词。
 *
 * ⛔ 本文件不判 ⑩/⑪ 的**语义正确性**（那是真库臂的事）：它只挡「整节被悄悄拿走」。
 *
 * 边界（R88 审查 P2，设计使然）：本守卫只保证「条数**不减少**」，**不保证每条读数仍是真话** ——
 * 「净 0 换条」（删一条 `say(`、在别处补一条）与「删断言但留着 `say(` 文案」都能过。
 * 每条读数是否仍为真，由真库实跑（workflow 的读数闸门 + 臂里的断言本身）与 review 负责，
 * 静态计数替代不了它。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 被守卫的真库臂脚本。 */
export const INTEGRATION_RELATIVE = 'tests/integration/post-media-attachments-pg.mjs';

/**
 * 读数下限：本文件实测 19 个**可执行** `say(` 调用点（①–⑨ + 迁移那节 12 个既有 + ⑩ 1 + ⑪ 2；
 * 另有 3 处 `say(` 只出现在注释里 —— 裸 `grep` 会数出 22，别拿它当基线）。
 * ⛔ 这个数字**不是** workflow 的 `-lt 19` 那道读数闸门的替代：那条看的是真跑 `PASS n:` 条数，
 * 这条数的是脚本里的调用点（不连库）。两者互补，数字必须同时改。
 */
export const SAY_FLOOR = 19;

/**
 * 把注释与字符串/模板字面量抹成空格，只留代码面。
 * 不追求完整 JS 词法：本仓这两个文件里没有正则字面量、没有嵌套模板里的反引号，
 * 遇到 `\\` 就跳过下一个字符，够用且不会误吞代码。
 */
export function stripCommentsAndLiterals(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out.push(' ');
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      out.push(' ');
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** 代码面上的 `say(` 调用点数（不含 `x.say(` 这类成员调用）。 */
export function countSayCalls(source) {
  const code = stripCommentsAndLiterals(source);
  return (code.match(/(?<![\w$.])say\s*\(/g) ?? []).length;
}

const SOURCE = readFileSync(`${ROOT}${INTEGRATION_RELATIVE}`, 'utf8');

/**
 * ⑩/⑪ 的锚点。`face: 'code'` 在**抹掉注释与字面量**的代码面上判（所以「整节注释掉」也会丢锚点），
 * `face: 'raw'` 在原文上判（文案本身就在字符串里，正是要钉的东西）。
 */
const SECTION_ANCHORS = [
  {
    label: '⑩ 的 say 行（读数文案以 ⑩ 开头）',
    face: 'raw',
    pattern: /say\(\s*['`]⑩/,
    why: '⑩「同帖并发」整节被删 / 被换成别的读数时，这条先红',
  },
  {
    label: '⑩ 的并发断言文案',
    face: 'raw',
    needle: '同一帖子并发挂两张不同的图必须恰好 1 笔成功',
    why: '这句只出现在 ⑩ 的 assert 里，是「一节还在不在」的实质判据（不能靠别处补 say 凑数）',
  },
  {
    label: '⑩ 的持锁 blocker（FOR SHARE）',
    face: 'raw',
    needle: 'FOR SHARE',
    why: '两笔并发必须先被同一个帖子行挡住；删了 blocker，⑩ 就退化成顺序调用',
  },
  {
    label: '⑩ 的在飞探测（pg_stat_activity）',
    face: 'raw',
    needle: 'pg_stat_activity',
    why: '不等到两笔都在飞就 COMMIT，⑩ 证明不了「并发」',
  },
  {
    label: '⑩ 的输家判据（raceLoss）',
    face: 'code',
    needle: 'const raceLoss = raceSettled.find(',
    why: '输家必须被判成 { ok: false, reason: REVISION_CHANGED }（P3-a 收窄后只此一支）',
  },
  {
    label: '⑪ owner_id 的 say 行',
    face: 'raw',
    pattern: /say\(\s*['`]⑪ owner_id/,
    why: '⑪ 支一整段被删时先红',
  },
  {
    label: '⑪ state 的 say 行',
    face: 'raw',
    pattern: /say\(\s*['`]⑪ state/,
    why: '⑪ 的 state 支被整段删掉时先红（这是审查 V2 的落点）',
  },
  {
    label: '⑪ owner 支的配额夹具',
    face: 'code',
    needle: 'const quotaOwner = randomUUID();',
    why: 'owner_id 负控制靠两个真用户各自的待用池，夹具没了这条支就空了',
  },
  {
    label: '⑪ state 支：deleted 负控制',
    face: 'code',
    needle: 'const unusableMedia = await newMediaInState(stateOwner,',
    why: 'deleted 那条是「不可用态不占名额」的原始判据（⛔ code 面已抹掉字面量，锚点只能用标识符，不能带引号里的值）',
  },
  {
    label: '⑪ state 支：rejected 负控制',
    face: 'code',
    needle: 'const rejectedMedia = await newMediaInState(stateOwner,',
    why: 'media_state 有 7 值，只测 deleted 一条时无法区分「按 state 过滤」与「按 deleted 过滤」',
  },
  {
    label: '⑪ state 支：processing 正控制',
    face: 'code',
    needle: 'const inFlightProcessing = await newMediaInState(stateOwner,',
    why: 'processing 属于「在途 4 态」却不叫 initiated/ready：IN 列表被缩窄成 (initiated, ready) 时靠它咬住',
  },
  {
    label: '⑪ 的上限常量派生',
    face: 'code',
    needle: 'const maxPerPost = COMMUNITY_MAX_IMAGES_PER_POST;',
    why: '上限必须从 packages/media/constants.mjs 派生（P3-b），硬编码 2/3/4 会在常量改动后假绿',
  },
  {
    label: '⑪ state 支：processing 那条的**实参**（state 值 = processing）',
    face: 'raw',
    needle: "newMediaInState(stateOwner, 'state-processing1', 'processing')",
    why: 'code 面抹掉了字面量，所以「把 processing 改成 ready」这种改值只有原文锚点抓得住',
  },
  {
    label: '⑪ state 支：deleted 那条的实参（state 值 = deleted）',
    face: 'raw',
    needle: "newMediaInState(stateOwner, 'state-deleted1', 'deleted')",
    why: '同上：状态值本身是这条负控制的判据，改一个词就等于换掉了断言',
  },
  {
    label: '⑪ state 支：rejected 那条的实参（state 值 = rejected）',
    face: 'raw',
    needle: "newMediaInState(stateOwner, 'state-rejected1', 'rejected')",
    why: '同上：把 rejected 换成 deleting/deleted 会与第一条负控制重复，覆盖面对不上矩阵',
  },
];

test('计数器自身可靠：注释与字面量里的 say( 都不计', () => {
  const toy = [
    '// 注释里写 say( 不算：say(\'假的\')',
    '/* 块注释里的 say( 也不算 */',
    "const a = say('文案里提到 say( 也不算');",
    'const b = `模板里的 say( 同样不算 ${x}`;',
    'say (\'带字母与空格的调用点算一个\');',
    'obj.say(\'成员调用不算\');',
  ].join('\n');
  assert.equal(countSayCalls(toy), 2, '只有两个真调用点（say(' + ' 与 say (' + '）');
  assert.equal(stripCommentsAndLiterals('//x\nsay(1)').includes('//'), false);
});

test(`真库臂的 say( 调用点不少于 ${SAY_FLOOR} 个（删 ⑩/⑪ 必红）`, () => {
  const count = countSayCalls(SOURCE);
  assert.ok(
    count >= SAY_FLOOR,
    `${INTEGRATION_RELATIVE} 只剩 ${count} 个 say( 调用点（下限 ${SAY_FLOOR}）。\n` +
      '⑩（同帖并发）/ ⑪（owner_id、state 行为级负控制）两节被整段删除时这条会红；\n' +
      'workflow 侧已有一条 `-lt 19` 的读数闸门（真跑删节后只剩 16 条 ⇒ CI 红）；本守卫是更快的静态补位，' +
      '两个数字（`SAY_FLOOR` 与 workflow 的 `-lt 19`）必须同时改。\n' +
      '新增/改写读数请同步上调 SAY_FLOOR，⛔ 不要靠调低它来变绿。',
  );
});

test('⑩ / ⑪ 的关键文案与结构锚点仍在（补 say 凑数也挡得住）', () => {
  const code = stripCommentsAndLiterals(SOURCE);
  for (const anchor of SECTION_ANCHORS) {
    const subject = anchor.face === 'code' ? code : SOURCE;
    const present = anchor.pattern ? anchor.pattern.test(subject) : subject.includes(anchor.needle);
    assert.ok(
      present,
      `缺少锚点「${anchor.label}」${anchor.needle ? `（找不到 \`${anchor.needle}\`）` : ''}：\n` +
        `  ${anchor.why}\n` +
        `  判据面：${anchor.face === 'code' ? '抹掉注释与字面量后的代码面（注释掉也算丢）' : '原文'}；\n` +
        '  ⑩/⑪ 是 #1030 的验收本体；被删/被注释/被改写时本节守卫必须红，⛔ 不要放宽锚点。',
    );
  }
});

test('⑩ 恰好 1 个、⑪ 恰好 2 个 say 调用点（读数条数不许悄悄变）', () => {
  const sectionSays = (marker) => (SOURCE.match(new RegExp(`say\\(\\s*['\\\`]${marker}`, 'g')) ?? []).length;
  assert.equal(sectionSays('⑩'), 1, '⑩ 应恰好 1 条 say（同帖并发那种「恰好 1 笔成功」的读数）');
  assert.equal(sectionSays('⑪'), 2, '⑪ 应恰好 2 条 say（owner_id 支 + state 支各一条）');
});

// ---------------------------------------------------------------------------
// 跨文件互校（R88 独立审查 P2）：`SAY_FLOOR` 此前**全仓只有本文件引用**，没有任何跨文件比对
// ⇒ 单改 `SAY_FLOOR 19→18` 全绿；把 workflow 的 `-lt 18` ＋ `::error::` 文案 ＋ 读数表的
// `baseline: 18` ＋ `SAY_FLOOR=18` 四处一起改也全绿。下面两条补的正是「静态守卫 ↔ yml / 读数表」
// 这一环；「yml ↔ 表」那一环已由 `ci-real-pg-readings-gates.test.mjs` 的判据① / ⑥ 双向核对。
//
// ⛔ 不 import `./ci-real-pg-readings-gates.test.mjs`：那个文件顶层有 7 个 `test(...)`，import 会把
//    它们**重复注册**进本文件的运行（`node --test post-media-attachments-say-floor.test.mjs` 会从
//    6 条变成 13 条，两个文件的红/绿表面互相污染）。所以这里只按它的判据形状写两个最小正则，
//    并靠「同一份 yml 文本 + 同一个脚本路径」保证与它看到的是同一处闸门。
// ---------------------------------------------------------------------------

/** 读数闸门所在的 workflow（与 `ci-real-pg-readings-gates.test.mjs` 的 `WORKFLOW_RELATIVE` 同值）。 */
export const WORKFLOW_RELATIVE = '.github/workflows/real-pg-integration.yml';

/** 逐条比对「workflow ↔ 读数表」的那个静态守卫：本文件只读它的 `baseline:`，不 import（理由见上）。 */
export const GATES_TEST_RELATIVE = 'tests/unit/ci-real-pg-readings-gates.test.mjs';

const WORKFLOW_TEXT = readFileSync(`${ROOT}${WORKFLOW_RELATIVE}`, 'utf8');
const GATES_TEST_TEXT = readFileSync(`${ROOT}${GATES_TEST_RELATIVE}`, 'utf8');

/** 整行注释抹成空行（**保留行号**）：注释里正当地写着旧写法 `-lt 1` 作反面例子。 */
function blankCommentLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

/**
 * 本臂那个 step 的正文（按 `- name:` 切块，取**点名本臂脚本**的那一块）。
 * 找不到返回 `null`：让断言报「闸门整体消失」，⛔ 不要静默返回一个默认值。
 */
export function armStepText(workflowText = WORKFLOW_TEXT, script = INTEGRATION_RELATIVE) {
  const lines = blankCommentLines(workflowText).split(/\r?\n/);
  const starts = [];
  lines.forEach((line, index) => {
    if (/^\s*- name:/.test(line)) starts.push(index);
  });
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const chunk = lines.slice(from, to).join('\n');
    if (chunk.includes(script)) return chunk;
  }
  return null;
}

/** step 正文里「`readings` 与 `-lt N` 同一行」的那个 N；找不到返回 `null`。 */
export function workflowFloor(stepText) {
  if (stepText === null) return null;
  for (const line of stepText.split(/\r?\n/)) {
    if (!line.includes('readings') || !line.includes('-lt')) continue;
    const matched = /(?<![\w-])-lt\s+["']?(\d+)["']?/.exec(line);
    if (matched !== null) return Number(matched[1]);
  }
  return null;
}

/** 读数表里本臂那条的 `baseline`：从 `script:` 那行往下 12 行内找 `baseline: N`。 */
export function tableBaseline(gatesText = GATES_TEST_TEXT, script = INTEGRATION_RELATIVE) {
  const lines = gatesText.split(/\r?\n/);
  const pattern = new RegExp(`script:\\s*'${script.replace(/\./g, '\\.')}'`);
  const anchor = lines.findIndex((line) => pattern.test(line));
  if (anchor < 0) return null;
  for (const line of lines.slice(anchor + 1, anchor + 12)) {
    const matched = /baseline:\s*(\d+)/.exec(line);
    if (matched !== null) return Number(matched[1]);
  }
  return null;
}

test('三处读数下限必须相等：workflow 的 -lt / 读数表 baseline / SAY_FLOOR（跨文件互校）', () => {
  const stepText = armStepText();
  assert.notEqual(
    stepText,
    null,
    `${WORKFLOW_RELATIVE} 里找不到点名 ${INTEGRATION_RELATIVE} 的 step`
      + ' ⇒ 本臂的读数闸门整体消失了，静态守卫不该在闸门不在时还绿。',
  );
  const gate = workflowFloor(stepText);
  const baseline = tableBaseline();
  assert.notEqual(
    gate,
    null,
    `${WORKFLOW_RELATIVE} 的「帖子级媒体挂载」step 正文里找不到 \`readings … -lt N\`。`,
  );
  assert.notEqual(
    baseline,
    null,
    `${GATES_TEST_RELATIVE} 的 \`READING_GATE_BASELINES\` 里找不到本臂的 \`baseline: N\`。`,
  );

  const places = [
    { where: `${WORKFLOW_RELATIVE} 的 \`-lt\``, value: gate },
    { where: `${GATES_TEST_RELATIVE} 的 \`baseline\``, value: baseline },
    { where: '本文件的 `SAY_FLOOR`', value: SAY_FLOOR },
  ];
  const differing = [];
  for (let i = 0; i < places.length; i += 1) {
    for (let j = i + 1; j < places.length; j += 1) {
      if (places[i].value !== places[j].value) {
        differing.push(`  · ${places[i].where} = ${places[i].value} ⇎ ${places[j].where} = ${places[j].value}`);
      }
    }
  }
  assert.deepEqual(
    differing,
    [],
    '三处读数下限不一致（下面每行就是「哪两处不等、各自的值」）：\n'
      + differing.join('\n')
      + '\n三处必须同时改：workflow 的 `-lt N`、读数表的 `baseline: N`、本文件的 `SAY_FLOOR`。\n'
      + '（第四处 `::error::` 文案里的「基线 N / < N」由 `ci-real-pg-readings-gates.test.mjs` 的判据⑥ 校，'
      + '这里不重复造轮子。）',
  );
});

test('SAY_FLOOR 必须等于臂脚本实测的 say( 调用点数（四处一致地改小也拦得住）', () => {
  const count = countSayCalls(SOURCE);
  assert.equal(
    count,
    SAY_FLOOR,
    `${INTEGRATION_RELATIVE} 实测 ${count} 个**可执行** \`say(\` 调用点，而本文件 \`SAY_FLOOR\` = ${SAY_FLOOR}。\n`
      + '这条钉的是「读数下限 = 当前真实产量」：只改数字（哪怕把 workflow 的 `-lt N`、读数表的 `baseline`、\n'
      + '`::error::` 文案与本处的 `SAY_FLOOR` **四处一起**改小）会在「实测 vs 声明」这里红。\n'
      + '真要把下限降下来，必须真的从臂脚本里删掉对应读数（`say(` 调用点跟着减少），并在 PR 描述里写明\n'
      + '删了哪条、为什么 —— ⛔ 只改数字不算。',
  );
});

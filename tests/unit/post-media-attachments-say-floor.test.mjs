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
 * 这里再补一条**更快的纯静态**守卫：不连库、不读 workflow，`tests/unit` 一遍就红。
 * 两个数字必须同时改：workflow 的 `-lt 19` ＋ `tests/unit/ci-real-pg-readings-gates.test.mjs`
 * 的 `baseline: 19` ＋ 本文件的 `SAY_FLOOR = 19`。
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

/**
 * GY-R68-D05 · 真库 CI 的「读数闸门」守卫：`-lt 1` ⇒ **冻结基线常量 N**。
 *
 * 背景：`.github/workflows/real-pg-integration.yml` 里每条真库臂在脚本 `exit 0` 之后都会数一遍自己
 * 打到日志里的读数（`PASS ` 行 / `[X]` 注释行 / 脚本自报 `READINGS=`），再用
 *
 *     if [ "$readings" -lt 1 ] || ! grep -Fq '[ALL PASS]' "$log"; then … exit 1
 *
 * 兜一层「这一步到底有没有真跑出读数」。问题就在这个 `1`：**每条臂每跑一次都会打出自己的读数**，
 * 所以 `-lt 1` 实际上只挡得住「零读数 / 脚本根本没跑」，挡不住「断言组被悄悄删掉一半」——把 12 条
 * 读数改成 3 条，闸门照样绿。这一层于是形同虚设：它守的是「文件存在」，不是「读数量级」。
 *
 * 修法：N 换成**该臂当前稳定产出**的读数条数（冻结基线，逐臂一张表，见 `READING_GATE_BASELINES`），
 * 闸门语义从「至少 1 条」变成「至少 N 条 ⇒ 少了就是断言组被删」。N 的来源必须能从仓库复算：
 * 本机 PG 17.11 真跑该臂一遍、按 workflow 里同一条 awk/sed 口径数条数；起不了集群的那一条退到
 * 静态计数（数脚本里 `pass(` 的调用点），逐条记录在下面表里的 `source` 字段。
 *
 * 判据（每条都要能单独红、并且**点名**是哪一条 step）：
 *   ① 有效行里不再出现 `-lt 1` 形式的读数闸门——正则同时抓 `-lt  1`（多空格）、`-lt "1"`、
 *      `-lt '1'`、`-lt 01` 这些变体，且不许把 `-lt 12` 误判成 `-lt 1`（见 `LITERAL_ONE`）。
 *      只扫**有效行**（注释被抹掉）：顶部口径注释里会正当地写出旧写法 `-lt 1` 作反面例子。
 *   ② 每个读数闸门在**代码内的表**里都有条目，且 yml 里的数字与表里的 `baseline` **逐条相等**；
 *      反向同样成立（表里有、yml 里没有也要红）。单边改动——只改 yml 不改表、或只改表不改 yml
 *      ——都必须红：这正是「数字靠人肉记在脑子里」会散的路径。
 *   ③ 表里每个 N ≥ 2（`-lt 2` 以下就没有「挡断言组被删」的意义了），且**表条目数 == yml 读数闸门数**
 *      （防止只登记一部分：剩下的闸门照样能悄悄退回 `-lt 1`）。
 *   ④ 反空转：真解析到 ≥ 3 个 job、≥ 10 个读数闸门；每个闸门都能对应到一个**真实存在**的
 *      `tests/integration/*.mjs` 脚本（脚本不存在 / 表里写的脚本与该 step 跑的不是同一个 ⇒ 红并点名）。
 *   ⑤ 「数数字的表达式」也必须冻结：每个闸门 step 里 `readings=$(…)` 的整段命令替换体要与表里的
 *      `counter` **逐字相等**，且该 step 里**只有一处**在给 `readings` 赋值/追加。原缺口：冻结的只有
 *      数字，把 `awk … {n+=1}` 改成 `{n+=10}`（yml 的 N 与表都不动）⇒ 读数轻易「达标」而闸门被放空，
 *      旧版守卫 5/5 全绿。只数 `readings=$(…)` 的条数还不够（复审实测）：`export readings=$((readings * 10))`、
 *      `readings=${readings}0`、`export readings=$(grep -c …)` 这三种**追加式**写法不碰冻结的那一行、
 *      表也逐字相等，读数却在闸门前被放大 ⇒ 唯一性按「任何给 readings 赋值/追加的行」判，见
 *      `readingsAssignments`。
 *   ⑥ 文案也算声明：14 个闸门 step 的 `::error::` 文案里，阈值（`基线 N` / `< N` 两种写法）必须与
 *      `-lt N` 相等。本片 B1 的原形就是文案（15 条 / 23 组）与闸门数字（25 / 41）对不上；只改文案、
 *      `-lt` 与表都不动时 ①–⑤ 全绿（复审实测 P10），所以文案单独钉一条。
 *
 * 判别力自证（⑦）把上面六条各敲一遍：数字改回 1 / 只改 yml / 只改表 / 下调基线 / 删闸门 /
 * 计数式改 10 倍 / 多塞一处计数式 / 三种追加式赋值 / 文案数字漂移 —— 九种变异都必须红并点名。
 *
 * ⚠️ 关于④里的 job 数：本 workflow 实际只有 **3 个 job**（`real-pg-17-11` / `real-pg-admin-read-17-11`
 * / `real-pg-admin-write-17-11`），所以下限取 3 而不是凭空的「≥5」——取一个文件里根本达不到的数只会
 * 让这条断言永远红（或逼着后人放宽它）。真正的反空转靠的是「解析出的 job 集合 == `jobs:` 段的键集合」
 * 加上「闸门数 ≥ 10」：前者防解析器漏读 job，后者防闸门被挪出扫描面。
 *
 * ⛔ 本文件**不读臂脚本的断言内容**，也不代替臂本身：它只校「闸门数字与账目表是否同源」。
 * ⛔ 本文件不依赖任何 YAML 库（仓内没有 `yaml` / `js-yaml`，跑 `npm ci` 后也不会有），
 *    所以走与 `tests/unit/ci-real-pg-step-timeouts.test.mjs` 同一套缩进结构解析。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 被守卫的 workflow（本片只动这一份）。 */
export const WORKFLOW_RELATIVE = '.github/workflows/real-pg-integration.yml';

/** 反空转下限：job 数与读数闸门数（本文件实测 3 / 14；见文件头对「≥5」的说明）。 */
export const MIN_JOBS = 3;
export const MIN_GATES = 10;

/**
 * `-lt` 后面跟「字面量 1」的检测（不含 `-lt 12` 这类更多位数的数）。
 * 抓得到的变体：`-lt 1`、`-lt  1`（多空格）、`-lt "1"`、`-lt '1'`、`-lt 01`、`-lt 001`。
 */
export const LITERAL_ONE = /(?<![\w-])-lt\s+(?:"|')?0*1(?:"|')?(?![\d])/;

/** 读数闸门里那个数字的读取（与 `LITERAL_ONE` 同一套引号/空格容忍度）。 */
export const GATE_NUMBER = /(?<![\w-])-lt\s+(?:"|')?(\d+)(?:"|')?/;

/**
 * 读数闸门的**冻结基线表**：step 名 → 该臂稳定产出的读数条数，**外加「数数字的那段表达式」**。
 *
 * 五列口径（与回报里的五列表一一对应）：
 *   · `step`：workflow 里该 step 的 `- name:`（改名即等于换了闸门，守卫会要求同步改表）；
 *   · `script`：该 step 真跑的臂脚本（守卫会核它存在、且确实是这个 step 跑的那一个）；
 *   · `baseline`：写进 yml 的 N；
 *   · `counter`：该 step 里**真正在数数字**的表达式，逐字冻结——取 `readings=$(…)` 的**整段命令
 *     替换体**（含 `"$log"` 参数与 `| tail -n 1` 这类下游管道）。为什么不只冻结 `awk` 程序：
 *     `sed -n 's/^READINGS=…/' | tail -n 1` 与 `awk … {print n+0}` 是两种计数口径，
 *     「有没有 `tail -n 1`」「`n++` 还是 `n+=1`」本身就是被守的东西；只冻结程序体，
 *     剩下的部分就成了新的后门。
 *   · `source`：这个 N 怎么来的——`真跑` 指本机 PG 17.11 实跑该臂一遍、按 workflow 里同一条
 *     awk/sed 口径数出条数；`静态计数` 指起不了集群时数脚本里 `pass(` 的调用点（并注明原因）。
 *
 * ⛔ 只许上调：断言组增加 ⇒ 读数变多 ⇒ 把 `baseline` 与 yml 里的数字**同一次**一起调上去。
 *    不许下调来凑绿；下调等于把「断言组被删」重新放回闸门之外。
 *
 * ⛔ **确需下调**的规程（唯一例外，写在这里而不是只写在脑子里）：
 *    ① 断言组合并/删除后读数**确实变少**时，才允许下调；
 *    ② 必须在 PR 里贴出**这次实测的读数**——怎么跑的、按本表 `counter` 那条口径数出几条——与下调原因；
 *    ③ 必须**同一个提交**里同时改 yml 的 N 与本表的 `baseline`（并同步 `source` 的说明）。
 *    只改一边 ⇒ 判据② 当场红；两边一起改却拿不出读数 ⇒ 审查打回。守卫只能证明「表与 yml 同源」，
 *    证明不了「这个数该降」——所以②只能靠 PR 里的人和读数，别指望这里自动兜住。
 *
 * ⛔ `counter` 与 `baseline` 一样是**冻结**的：把某条闸门的计数式从 `{n+=1}` 改成 `{n+=10}`
 *    （闸门数字、本表都不动）会让读数照样「够」而闸门形同虚设 ⇒ 判据⑤ 必须红并点名那条 step。
 */
export const READING_GATE_BASELINES = [
  {
    step: '问答引用可溯源（#12 / 迁移子集 7 段 / 引用反算对账 / 零命中必拒答）',
    script: 'tests/integration/qa-citations-pg.mjs',
    baseline: 8,
    counter: `awk '/^PASS /{n++} END{print n+0}' "$log"`,
    source: '真跑（awk /^PASS / ⇒ 8 条）',
  },
  {
    step: '作业台域（#9 / 全链迁移 0001→0027 / 作业与错误可见 / 变更留痕 A→B / 最小权限）',
    script: 'tests/integration/admin-jobs-pg.mjs',
    baseline: 25,
    counter: `awk '/^\\[[A-Z]\\]/{n++} END{print n+0}' "$log"`,
    source: '真跑（awk /^\\[[A-Z]\\]/ ⇒ 25 条；旧注释里的「15 条」已过时）',
  },
  {
    step: '后台社区帖域（#18 / 列表·单条读面 / 下架处置 / 审计留痕 / 失败隔离）',
    script: 'tests/integration/admin-community-posts-pg.mjs',
    baseline: 41,
    counter: `awk '/^\\[[A-Z]\\]/{n++} END{print n+0}' "$log"`,
    source: '真跑（awk /^\\[[A-Z]\\]/ ⇒ 41 条；旧注释里的「23 组」已过时）',
  },
  {
    step: '后台社区帖域 · 下架审计（#18 / post.hide 审计函数专证 / fail-closed / 幂等）',
    script: 'tests/integration/admin-post-hide-audit-pg.mjs',
    baseline: 10,
    counter: `awk '/^\\[[A-Z0-9]+\\]/{n++} END{print n+0}' "$log"`,
    source: '真跑（awk /^\\[[A-Z0-9]+\\]/ ⇒ 10 条）',
  },
  {
    step: 'OCR 校正台账域（#10 / jsonb 台账 append-only / 原文零改写 / HTTP 五字段）',
    script: 'tests/integration/ocr-corrections-pg.mjs',
    baseline: 7,
    counter: `awk '/^PASS /{n++} END{print n+0}' "$log"`,
    source: '真跑（awk /^PASS / ⇒ 7 条）',
  },
  {
    step: '后台帖子读面（R67-C：admin-posts-read-pg / 空库 + 五段迁移 + 读面读数）',
    script: 'tests/integration/admin-posts-read-pg.mjs',
    baseline: 12,
    counter: `sed -n 's/^READINGS=\\([0-9][0-9]*\\).*/\\1/p' "$log" | tail -n 1`,
    source: '真跑（sed 取最后一个 READINGS= ⇒ 12）',
  },
  {
    step: '授权范围读面（R67-C：admin-scopes-read-pg / 自起集群 / 只读）',
    script: 'tests/integration/admin-scopes-read-pg.mjs',
    baseline: 3,
    counter: `awk '/PASS [0-9]+:/{n+=1} /✓/{n+=1} END{print n+0}' "$log"`,
    source: '静态计数（本机 TCP 保留区间 55441–55540 占住了该臂写死的 55468–55499，起不了集群 ⇒ 数 `pass(` 调用点：第 259 / 381 / 396 行各一条，exit 0 时三条必打）',
  },
  {
    step: '内容域持久化（R67-C：admin-content-pg / 自起集群 / 建表 + 造数 + 回滚）',
    script: 'tests/integration/admin-content-pg.mjs',
    baseline: 11,
    counter: `awk '/PASS [0-9]+:/{n+=1} /✓/{n+=1} END{print n+0}' "$log"`,
    source: '真跑（awk PASS n: / ✓ 合计 ⇒ 11 条）',
  },
  {
    step: '授权写入面（R67-C：admin-scopes-authority-pg / 自起集群 / 授撤 + 委派 + 审计）',
    script: 'tests/integration/admin-scopes-authority-pg.mjs',
    baseline: 34,
    counter: `awk '/PASS [0-9]+:/{n+=1} /✓/{n+=1} END{print n+0}' "$log"`,
    source: '真跑（awk PASS n: / ✓ 合计 ⇒ 34 条）',
  },
  {
    step: '审核全链（R67-C：moderation-full-chain-pg / 自起集群 / 建帖→编辑→审核→下架）',
    script: 'tests/integration/moderation-full-chain-pg.mjs',
    baseline: 5,
    counter: `awk '/PASS [0-9]+:/{n+=1} /✓/{n+=1} END{print n+0}' "$log"`,
    source: '真跑（awk PASS n: / ✓ 合计 ⇒ 5 条）',
  },
  {
    step: '识别与语音域清理（R67-C：recognitions-speech-purge-pg / 自起集群 / 真删 + 幂等）',
    script: 'tests/integration/recognitions-speech-purge-pg.mjs',
    baseline: 10,
    counter: `awk '/PASS [0-9]+:/{n+=1} /✓/{n+=1} END{print n+0}' "$log"`,
    source: '真跑（awk PASS n: / ✓ 合计 ⇒ 10 条）',
  },
  {
    step: '保留期时钟演练（R67-C：retention-clock-drill-pg / 自起集群 / 7/30 日三态）',
    script: 'tests/integration/retention-clock-drill-pg.mjs',
    baseline: 10,
    counter: `awk '/PASS [0-9]+:/{n+=1} /✓/{n+=1} END{print n+0}' "$log"`,
    source: '真跑（awk PASS n: / ✓ 合计 ⇒ 10 条）',
  },
  {
    step: '媒体行清除驱动（R67-C3：media-row-purge-pg / 自起集群 / 迁移号按保留台账口径）',
    script: 'tests/integration/media-row-purge-pg.mjs',
    baseline: 18,
    counter: `awk '/PASS [0-9]+:/{n+=1} /✓/{n+=1} END{print n+0}' "$log"`,
    source: '真跑（awk PASS n: / ✓ 合计 ⇒ 18 条）',
  },
  {
    step: '零政策矩阵（R69：consent-zero-policy-pg / 全链迁移 / 生产装配零注入 / 403 矩阵 + 三级负控制）',
    script: 'tests/integration/consent-zero-policy-pg.mjs',
    baseline: 14,
    counter: `awk '/^PASS /{n++} END{print n+0}' "$log"`,
    source: '真跑（本机 PG 17.11 + 空库 + 全链 48 迁移 ⇒ `PASS n:` 14 条；与脚本里 `say(` 的调用点数相等）',
  },
];

/** 把整行注释替换成空行（**保留行号**）：注释里正当地写着旧写法 `-lt 1` 作反面例子。 */
export function blankCommentLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

/**
 * 臂脚本的仓内相对路径（**一律正斜杠**）。
 * ⛔ 不要在这里用 `path.join`：Windows 上它会拼成 `tests\integration\…`，与表里的正斜杠路径
 *    逐字比较就永远不等（这是本守卫第一版的真实缺陷）。
 */
export function stepScriptPath(script) {
  return `tests/integration/${script}`;
}

/** 一个 step 的可读标签：优先 `name:`，其次点名的脚本，都没有就报行号。 */
export function stepLabel(gate) {
  if (gate.step !== null) return gate.step;
  if (gate.script !== null) return `(无 name) → tests/integration/${gate.script}`;
  return `(无 name，第 ${gate.lineNumber} 行)`;
}

function parseSteps(jobLines, lineOffset) {
  const starts = [];
  jobLines.forEach((line, index) => {
    if (/^ {6}- /.test(line)) starts.push(index);
  });
  const steps = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : jobLines.length;
    const chunkLines = jobLines.slice(from, to);
    const chunk = chunkLines.join('\n');
    const nameMatch = /^ {6}- name:\s*(.+)$/.exec(chunkLines[0]) ?? /^ {8}name:\s*(.+)$/m.exec(chunk);
    const scriptMatch = /tests\/integration\/([A-Za-z0-9._-]+\.mjs)/.exec(chunk);
    steps.push({
      name: nameMatch === null ? null : nameMatch[1].trim(),
      script: scriptMatch === null ? null : scriptMatch[1],
      lineNumber: lineOffset + from + 1,
      text: chunk,
    });
  }
  return steps;
}

/** 解析出 job 与 step（只认缩进结构：job 键两空格、step 六空格 `- `）。 */
export function parseJobs(rawText) {
  const lines = blankCommentLines(rawText).split(/\r?\n/);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) throw new Error('workflow 里没有 `jobs:` 段');
  const jobs = [];
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (key === null) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    jobs.push({ id: key[1], lineNumber: index + 1, steps: parseSteps(lines.slice(index, end), index) });
    index = end - 1;
  }
  return jobs;
}

/** `jobs:` 之下两空格缩进的全部 job 键（声明侧，用来钉住解析器没漏读）。 */
export function declaredJobKeys(rawText) {
  const lines = blankCommentLines(rawText).split(/\r?\n/);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) throw new Error('workflow 里没有 `jobs:` 段');
  const keys = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const matched = /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+)):\s*(?:#.*)?$/.exec(line);
    if (matched) keys.push(matched[1] || matched[2] || matched[3]);
  }
  return keys;
}

/**
 * 文件里的**读数闸门**：同一行既出现 `readings` 又出现 `-lt <数字>`。
 *
 * 这个判据刻意宽（不要求 `[ "$readings"` 那种写法、也不要求后面跟 `then`）：`-lt` 的比较对象
 * 换了写法不该让闸门从扫描面里消失。它只认「这一行在拿读数跟某个数字比」。
 */
export function gateLines(rawText) {
  const lines = blankCommentLines(rawText).split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    if (!line.includes('readings') || !line.includes('-lt')) return;
    const matched = GATE_NUMBER.exec(line);
    if (matched === null) return;
    hits.push({ lineNumber: index + 1, value: Number(matched[1]), text: line.trim() });
  });
  return hits;
}

/** 给每个读数闸门找到它所在的 job / step（最近的那个在前面开始的 step）。 */
export function gateFacts(rawText) {
  const jobs = parseJobs(rawText);
  const flat = jobs.flatMap((job) => job.steps.map((step) => ({ job, step })));
  return gateLines(rawText).map((gate) => {
    const owner = flat
      .filter(({ step }) => step.lineNumber <= gate.lineNumber)
      .sort((left, right) => right.step.lineNumber - left.step.lineNumber)[0] ?? null;
    return {
      ...gate,
      job: owner === null ? null : owner.job.id,
      step: owner === null ? null : owner.step.name,
      script: owner === null ? null : owner.step.script,
      stepText: owner === null ? null : owner.step.text,
    };
  });
}

/**
 * 从一个 step 的 run 体里抽出「真正在数数字」的表达式。
 *
 * 口径：`readings=$(…)` 的**整段命令替换体**（`$(` 与行尾 `)` 之间，逐字，含 `"$log"` 与
 * `| tail -n 1` 这类下游管道）。为什么是整段而不是只取 `awk` 程序：`sed` + `tail -n 1` 与
 * `awk … {n+0}` 是两种计数口径，「有没有 `tail`」「`n++` 还是 `n+=1`」本身就是被守的东西；
 * 只冻结程序体会把剩下的部分留成新的后门。
 *
 * 局限（写清楚，别当成万能）：这是**字符串相等**，证明不了这段 shell 在语义上「数对了」；
 * 它挡的是「闸门数字不动、把计数式悄悄换成数 10 倍」这一类单边改动。
 * 它**只认** `readings=$(…)` 这一种写法 —— 所以「唯一性」不能只数它的条数，见 `readingsAssignments`。
 */
export function counterExpressions(stepText) {
  const found = [];
  for (const line of stepText.split(/\r?\n/)) {
    const matched = /^\s*readings=\$\((.*)\)\s*$/.exec(line);
    if (matched !== null) found.push(matched[1]);
  }
  return found;
}

/**
 * 抽出一个 step 里**所有**在给 `readings` 赋值/追加的行 —— 判据⑤ 的「唯一性」建立在这上面。
 *
 * 为什么不数 `counterExpressions` 的条数：那个正则只认 `^\s*readings=\$\((.*)\)\s*$`，于是下面
 * 三种**追加式**改动它一条都看不见（旧版实测 6/6 全绿，与「`{n+=1}`→`{n+=10}`」同效）：
 *   · `export readings=$((readings * 10))`（重建赋值，10 倍）
 *   · `readings=${readings}0`（字符串拼接，10 倍）
 *   · `export readings=$(grep -c 'PASS ' "$log")`（换成另一条计数式）
 * 这三行逐字未动冻结的那一行、表也逐字相等，读数却在闸门前被放大。
 *
 * 正则 `(^|[^\w.$])readings\s*(=|\+=)` 覆盖 `readings=` / `export readings=` / `readings+=` /
 * `readings=$((…))` / `readings=${readings}0`，且**不**误伤：
 *   · `[ "$readings" -lt N ]`（`$readings` 后面没有 `=`）；
 *   · `"${readings} 条"` / `"${readings:-0}"`（`}` 或 `:` 后面不是 `=`）；
 *   · 脚本自报标记 `READINGS=`（大写，大小写敏感）。
 */
export function readingsAssignments(stepText) {
  const found = [];
  for (const line of stepText.split(/\r?\n/)) {
    if (/(^|[^\w.$])readings\s*(=|\+=)/.test(line)) found.push(line.trim());
  }
  return found;
}

/**
 * 判据⑤：每个闸门 step 里**只有一处**在给 `readings` 赋值/追加，且那一处就是表里冻结的
 * `counter`（逐字相等）。
 *
 * 原缺口：冻结的只有数字。把某条闸门的 `awk … {n+=1}` 改成 `{n+=10}`，yml 的 N 与表都不动 ⇒
 * 读数轻松「达标」而闸门形同虚设，旧版守卫 5/5 全绿。这里把「数数字的表达式」也钉在表里。
 *
 * 两个层次，缺一不可（第二个层次是复审补的）：
 *   · 「唯一」——除冻结的那一行外，**任何**再给 `readings` 赋值/追加的行都红（`export readings=…`、
 *     `readings+=…`、`readings=${readings}0`、第二处 `readings=$(…)`）。只数 `readings=$(…)`
 *     的条数会漏掉前几类「追加式」写法：那行逐字未动、表也逐字相等，读数却在闸门前被放大；
 *   · 「逐字」——那唯一一处的命令替换体必须与表里 `counter` 完全一致。
 */
export function counterProblems(rawText, table = READING_GATE_BASELINES) {
  const problems = [];
  const tableByStep = new Map();
  for (const entry of table) {
    if (typeof entry.counter !== 'string' || entry.counter.trim() === '') {
      problems.push(
        `表里 step「${entry.step}」没有 \`counter\`（或它是空串）⇒ 这条闸门只冻结了数字，`
          + '「数数字的表达式」照样能被改（`{n+=1}` → `{n+=10}`）而守卫看不见',
      );
    }
    tableByStep.set(entry.step, entry);
  }
  for (const gate of gateFacts(rawText)) {
    if (gate.stepText === null) {
      problems.push(
        `job \`${gate.job}\` 第 ${gate.lineNumber} 行的读数闸门找不到所属 step ⇒ 计数式无从核对`,
      );
      continue;
    }
    const assignments = readingsAssignments(gate.stepText);
    if (assignments.length !== 1) {
      problems.push(
        `job \`${gate.job}\` · step「${stepLabel(gate)}」里有 ${assignments.length} 处给 \`readings\` 赋值/追加`
          + `（${assignments.length === 0 ? '一处都没有' : assignments.map((item) => `\`${item}\``).join(' / ')}）`
          + ' ⇒ 计数式必须唯一：除冻结的那一行外，任何再给 `readings` 赋值/追加的行'
          + '（`export readings=$((readings * 10))`、`readings=${readings}0`、第二处 `readings=$(…)`）'
          + '都能在闸门前把读数放大，而表里的 `counter` 还对着那行逐字未动的原文',
      );
      continue;
    }
    const expressions = counterExpressions(gate.stepText);
    if (expressions.length !== 1) {
      problems.push(
        `step「${stepLabel(gate)}」里唯一那处 \`readings\` 赋值不是冻结的 \`readings=$(…)\` 整段命令替换体：`
          + `\`${assignments[0]}\` ⇒ 换写法（\`export readings=$(…)\`、\`readings =$(…)\`）同样能把闸门放空`,
      );
      continue;
    }
    const entry = gate.step === null ? undefined : tableByStep.get(gate.step);
    if (entry === undefined) continue; // 判据② 已经单独报「表里没这条 step」
    if (typeof entry.counter !== 'string' || entry.counter === '') continue; // 上面已报
    if (entry.counter !== expressions[0]) {
      problems.push(
        `step「${entry.step}」的计数式与表里的 \`counter\` 不一致：`
          + `yml 是 \`${expressions[0]}\`（第 ${gate.lineNumber} 行所在 step），`
          + `表里是 \`${entry.counter}\` ⇒ 闸门数字与基线都对、数数字的表达式却能随便改`
          + '（`{n+=1}` → `{n+=10}` 正是这样把闸门放空的）',
      );
    }
  }
  return problems;
}

/**
 * 判据⑥：`::error::` 文案里的阈值数字必须与闸门的 `-lt N` 相等。
 *
 * 为什么单独一条：文案是**给人看的**，写错就是在骗读日志的人 —— 而这正是本片 B1 的原形
 * （旧注释写「15 条」而闸门是 `-lt 25`、写「23 组」而闸门是 `-lt 41`）。只改文案（`< 12` → `< 9`）、
 * `-lt` 与表都不动时，①–⑤ 全绿（复审实测 P10），所以文案也得钉住。
 *
 * 口径：只看该 step 里提到 `readings` / `基线` / `< N` 的 `::error::` 行（同一 step 里
 * 「迁移失败（exit $rc）」这类与读数无关的 error 行不参与）。每行出现的阈值数字（`基线 N` 与
 * `< N` 两种写法）必须**全部**等于 `-lt N`；一行都找不到（文案不写阈值）同样红。
 * 局限：只校「文案里写的数字」；`${readings}` 的格式化、措辞是否易读，本判据不管。
 */
export function errorTextProblems(rawText) {
  const problems = [];
  for (const gate of gateFacts(rawText)) {
    if (gate.stepText === null) {
      problems.push(
        `job \`${gate.job}\` 第 ${gate.lineNumber} 行的读数闸门找不到所属 step ⇒ 文案阈值无从核对`,
      );
      continue;
    }
    const messages = gate.stepText
      .split(/\r?\n/)
      .filter((line) => line.includes('::error::'))
      .filter((line) => line.includes('readings') || line.includes('基线') || /<\s*\d/.test(line));
    if (messages.length === 0) {
      problems.push(
        `step「${stepLabel(gate)}」（第 ${gate.lineNumber} 行 \`-lt ${gate.value}\`）的 \`::error::\` 文案里`
          + '没有可核对的阈值数字（应写成 `基线 N` 或 `< N`）⇒ 读日志的人无从判断基线是多少',
      );
      continue;
    }
    for (const line of messages) {
      const numbers = new Set();
      for (const matched of line.matchAll(/基线\s*(\d+)/g)) numbers.add(Number(matched[1]));
      for (const matched of line.matchAll(/<\s*(\d+)/g)) numbers.add(Number(matched[1]));
      if (numbers.size === 0) {
        problems.push(
          `step「${stepLabel(gate)}」的 \`::error::\` 文案里没有阈值数字：\`${line.trim()}\``,
        );
        continue;
      }
      const wrong = [...numbers].filter((value) => value !== gate.value);
      if (wrong.length === 0) continue;
      problems.push(
        `step「${stepLabel(gate)}」的 \`::error::\` 文案写着 ${wrong.join(' / ')}，`
          + `而闸门是 \`-lt ${gate.value}\`（第 ${gate.lineNumber} 行）⇒ 文案里的阈值必须与闸门数字相等`
          + '（旧注释的「15 条 / 23 组」就是同一类错）；原文：'
          + `\`${line.trim()}\``,
      );
    }
  }
  return problems;
}

/** 判据①：有效行里不许再有 `-lt 1` 形式的读数闸门。 */
export function literalOneProblems(rawText) {
  const lines = blankCommentLines(rawText).split(/\r?\n/);
  const facts = gateFacts(rawText);
  const problems = [];
  lines.forEach((line, index) => {
    if (!LITERAL_ONE.test(line)) return;
    const gate = facts.find((item) => item.lineNumber === index + 1) ?? null;
    problems.push(
      `第 ${index + 1} 行仍是「至少 1 条」口径：\`${line.trim()}\``
        + `${gate === null ? '' : `（job \`${gate.job}\` · step「${stepLabel(gate)}」）`}`
        + ' ⇒ 每条臂每跑一次都会打出自己的读数，`-lt 1` 只挡得住「零读数」，挡不住「断言组被删掉一半」',
    );
  });
  return problems;
}

/**
 * 判据②：yml 里的数字与代码内的表**逐条相等**（双向）。
 * 单边改动（只改 yml / 只改表）都必须红，并点名那条 step。
 */
export function baselineProblems(rawText, table = READING_GATE_BASELINES) {
  const gates = gateFacts(rawText);
  const problems = [];
  const byStep = new Map();
  for (const gate of gates) {
    const key = gate.step;
    if (!byStep.has(key)) byStep.set(key, []);
    byStep.get(key).push(gate);
  }
  for (const [key, entries] of byStep) {
    if (key !== null && entries.length > 1) {
      problems.push(
        `step「${key}」里有 ${entries.length} 处读数闸门（第 ${entries.map((item) => item.lineNumber).join(' / ')} 行）`
          + '⇒ 表只能给这一个 step 登记一个基线，闸门必须收敛成一处',
      );
    }
  }
  const tableByStep = new Map();
  for (const entry of table) {
    if (tableByStep.has(entry.step)) problems.push(`表里把 step「${entry.step}」登记了两次 ⇒ 基线冲突`);
    tableByStep.set(entry.step, entry);
  }
  for (const gate of gates) {
    const entry = gate.step === null ? undefined : tableByStep.get(gate.step);
    if (entry === undefined) {
      problems.push(
        `job \`${gate.job}\` · step「${stepLabel(gate)}」有读数闸门（第 ${gate.lineNumber} 行，\`-lt ${gate.value}\`）`
          + '但**表里没有它的条目** ⇒ 这个闸门的基线没人看住，随时能悄悄退回 `-lt 1`',
      );
      continue;
    }
    if (entry.baseline !== gate.value) {
      problems.push(
        `step「${entry.step}」的基线对不上：yml 写 \`-lt ${gate.value}\`（第 ${gate.lineNumber} 行），`
          + `表里是 \`baseline: ${entry.baseline}\` ⇒ 两边必须逐条相等 `
          + `（${gate.value < entry.baseline ? 'yml 被下调/表没跟着改' : '表被下调/yml 没跟着改'} 都会让这条闸门失真）`,
      );
    }
  }
  const allSteps = parseJobs(rawText).flatMap((job) => job.steps.map((step) => step.name));
  for (const entry of table) {
    if (byStep.has(entry.step)) continue;
    problems.push(
      `表里登记了 step「${entry.step}」（baseline ${entry.baseline}），但 yml 里没有它的读数闸门`
        + `（${allSteps.includes(entry.step) ? '这个 step 还在，是闸门被删了' : '这个 step 名已经不存在' }）`
        + ' ⇒ 表与 yml 脱钩',
    );
  }
  return problems;
}

/** 判据③：每个 N ≥ 2，且表条目数 == yml 读数闸门数（防只登记一部分）。 */
export function floorAndCountProblems(rawText, table = READING_GATE_BASELINES) {
  const gates = gateFacts(rawText);
  const problems = [];
  for (const entry of table) {
    if (!Number.isInteger(entry.baseline) || entry.baseline < 2) {
      problems.push(
        `表里 step「${entry.step}」的 baseline 是 ${String(entry.baseline)} ⇒ 必须 ≥ 2：`
          + '`-lt 1` / `-lt 0` 这档数字（「至少 1 条」）挡不住断言组被删，等于把这层闸门作废',
      );
    }
  }
  if (table.length !== gates.length) {
    problems.push(
      `表条目数 ${table.length} ≠ yml 读数闸门数 ${gates.length}`
        + `（闸门在第 ${gates.map((gate) => gate.lineNumber).join(' / ')} 行）⇒ 只登记一部分等于给剩下的闸门留后门`,
    );
  }
  return problems;
}

/**
 * 判据④：反空转——扫描面必须真的扫到东西，且每个闸门都对应到一个**存在的**臂脚本。
 */
export function scanSurfaceProblems(rawText, table = READING_GATE_BASELINES) {
  const problems = [];
  const jobs = parseJobs(rawText);
  const declared = [...declaredJobKeys(rawText)].sort();
  const parsed = jobs.map((job) => job.id).sort();
  if (parsed.join(',') !== declared.join(',')) {
    const missed = declared.filter((id) => !parsed.includes(id));
    problems.push(
      `解析出的 job 集合 [${parsed.join(', ')}] 与 \`jobs:\` 段的键 [${declared.join(', ')}] 不一致`
        + `（漏读：${missed.length === 0 ? '无' : missed.join(', ')}）⇒ 判据② 会在那个 job 上静默变绿`,
    );
  }
  if (jobs.length < MIN_JOBS) problems.push(`job 数实测 ${jobs.length}，少于 ${MIN_JOBS} ⇒ 解析器可能只读到一半`);
  for (const job of jobs) {
    if (job.steps.length === 0) problems.push(`job \`${job.id}\` 解析不出任何 step ⇒ 读数闸门会全部落到扫描面之外`);
  }
  const gates = gateFacts(rawText);
  if (gates.length < MIN_GATES) {
    problems.push(`读数闸门数实测 ${gates.length}，少于 ${MIN_GATES} ⇒ 判据①②③ 都在空转`);
  }
  const tableByStep = new Map(table.map((entry) => [entry.step, entry]));
  for (const gate of gates) {
    const entry = gate.step === null ? undefined : tableByStep.get(gate.step);
    if (gate.script === null) {
      problems.push(`job \`${gate.job}\` · step「${stepLabel(gate)}」的 run 里点不到任何 tests/integration/*.mjs`);
      continue;
    }
    const relative = stepScriptPath(gate.script);
    if (!existsSync(join(ROOT, relative))) {
      problems.push(`step「${stepLabel(gate)}」跑的 ${relative} **不存在** ⇒ 这条闸门守的是一个空壳`);
    }
    if (entry !== undefined && entry.script !== relative) {
      problems.push(
        `step「${entry.step}」的基线表写的是 ${entry.script}，但这个 step 实际跑的是 ${relative}`
          + ' ⇒ 表绑错了臂，基线数字也就不是这条臂的读数',
      );
    }
  }
  for (const entry of table) {
    if (!existsSync(join(ROOT, entry.script))) {
      problems.push(`表里 step「${entry.step}」登记的臂脚本 ${entry.script} **不存在**`);
    }
  }
  return problems;
}

function readWorkflow() {
  return readFileSync(join(ROOT, WORKFLOW_RELATIVE), 'utf8');
}

/** 把一个读数闸门的数字换成 `replacement`：先按 step 名定位那个 step，再在其中找闸门行。 */
function replaceGateNumber(text, stepNeedle, replacement) {
  const lines = text.split('\n');
  const stepAt = lines.findIndex((line) => /^ {6}- /.test(line) && line.includes(stepNeedle));
  assert.notEqual(stepAt, -1, `自证前提：必须存在含「${stepNeedle}」的 step（否则这条自证测的是空替换）`);
  for (let index = stepAt + 1; index < lines.length; index += 1) {
    if (/^ {6}- /.test(lines[index])) break;
    if (!lines[index].includes('readings') || !lines[index].includes('-lt')) continue;
    const before = lines[index];
    lines[index] = lines[index].replace(GATE_NUMBER, `-lt ${replacement}`);
    assert.notEqual(lines[index], before, `自证前提：闸门数字必须真的被改动（${before.trim()}）`);
    return lines.join('\n');
  }
  throw new Error(`自证前提：step「${stepNeedle}」里没有读数闸门行`);
}

/** 读出某个 step 当前在 yml 里的闸门数字（变异自证要用**相对**数字，才不会与文件现状撞车）。 */
function gateNumberFor(text, stepNeedle) {
  const gate = gateFacts(text).find((item) => item.step !== null && item.step.includes(stepNeedle));
  assert.ok(gate !== undefined, `自证前提：step「${stepNeedle}」必须有读数闸门`);
  return gate.value;
}

/**
 * 只改**某一个 step 里**的计数式片段（变异自证 M6 用）：把 `from` 换成 `to`，并断言真的改了。
 * 只动这一个 step，是为了让「红」必须点名它——全文件替换会让所有同款计数式一起变，
 * 那种红证明不了判据⑤ 能定位。
 */
function replaceCounterInStep(text, stepNeedle, from, to) {
  const lines = text.split('\n');
  const stepAt = lines.findIndex((line) => /^ {6}- /.test(line) && line.includes(stepNeedle));
  assert.notEqual(stepAt, -1, `自证前提：必须存在含「${stepNeedle}」的 step（否则这条自证测的是空替换）`);
  for (let index = stepAt + 1; index < lines.length; index += 1) {
    if (/^ {6}- /.test(lines[index])) break;
    if (!/^\s*readings=\$\(/.test(lines[index]) || !lines[index].includes(from)) continue;
    lines[index] = lines[index].replace(from, to);
    return lines.join('\n');
  }
  throw new Error(`自证前提：step「${stepNeedle}」的 \`readings=$(…)\` 里必须有 \`${from}\``);
}

/** 往某一个 step 里再塞一处 `readings=$(…)`（变异自证 M7 用）：计数式就不唯一了。 */
function duplicateCounterInStep(text, stepNeedle) {
  const lines = text.split('\n');
  const stepAt = lines.findIndex((line) => /^ {6}- /.test(line) && line.includes(stepNeedle));
  assert.notEqual(stepAt, -1, `自证前提：必须存在含「${stepNeedle}」的 step`);
  for (let index = stepAt + 1; index < lines.length; index += 1) {
    if (/^ {6}- /.test(lines[index])) break;
    if (!/^\s*readings=\$\(/.test(lines[index])) continue;
    lines.splice(index + 1, 0, '          readings=$(grep -c \'PASS \' "$log")');
    return lines.join('\n');
  }
  throw new Error(`自证前提：step「${stepNeedle}」里必须有 \`readings=$(…)\` 才能再加一处`);
}

/**
 * 在某个 step 的计数式那一行**后面**插一行任意赋值（变异自证 M8 用）：模拟复审的三种追加式
 * 绕过（`export readings=$((readings * 10))` / `readings=${readings}0` / 换一条计数式）。
 * 插在冻结行之后，是为了让「冻结的那一行逐字未变」这个前提成立 —— 红只能来自「多了一处」。
 */
function appendAssignmentInStep(text, stepNeedle, assignment) {
  const lines = text.split('\n');
  const stepAt = lines.findIndex((line) => /^ {6}- /.test(line) && line.includes(stepNeedle));
  assert.notEqual(stepAt, -1, `自证前提：必须存在含「${stepNeedle}」的 step`);
  for (let index = stepAt + 1; index < lines.length; index += 1) {
    if (/^ {6}- /.test(lines[index])) break;
    if (!/^\s*readings=\$\(/.test(lines[index])) continue;
    lines.splice(index + 1, 0, `          ${assignment}`);
    return lines.join('\n');
  }
  throw new Error(`自证前提：step「${stepNeedle}」里必须有 \`readings=$(…)\` 才能在它后面追加`);
}

/** 只改某一个 step 里**任意一行**的第一次出现（变异自证 M9 用：改文案里的阈值数字）。 */
function replaceInStep(text, stepNeedle, from, to) {
  const lines = text.split('\n');
  const stepAt = lines.findIndex((line) => /^ {6}- /.test(line) && line.includes(stepNeedle));
  assert.notEqual(stepAt, -1, `自证前提：必须存在含「${stepNeedle}」的 step`);
  for (let index = stepAt + 1; index < lines.length; index += 1) {
    if (/^ {6}- /.test(lines[index])) break;
    if (!lines[index].includes(from)) continue;
    lines[index] = lines[index].replace(from, to);
    return lines.join('\n');
  }
  throw new Error(`自证前提：step「${stepNeedle}」里必须有一行含 \`${from}\``);
}

test('① 全文件不再出现 `-lt 1` 口径的读数闸门（含 `-lt  1` / `-lt "1"` 变体）', () => {
  assert.deepEqual(
    literalOneProblems(readWorkflow()),
    [],
    '读数闸门必须是冻结基线 N，不是「至少 1 条」：1 只挡得住零读数，挡不住断言组被删掉一半',
  );
});

test('② 每个读数闸门都在表里有条目，且 yml 数字与表里的 baseline 逐条相等（双向）', () => {
  assert.deepEqual(
    baselineProblems(readWorkflow()),
    [],
    '表与 yml 必须逐条相等：单边改动（只改 yml 或只改表）都会让闸门数字失去来源',
  );
});

test('③ 表里每个 N ≥ 2，且表条目数 == yml 读数闸门数', () => {
  assert.deepEqual(
    floorAndCountProblems(readWorkflow()),
    [],
    '基线必须 ≥ 2 且一条不漏地登记：漏登记的闸门随时能悄悄退回 `-lt 1`',
  );
});

test('④ 反空转：真解析到 ≥3 个 job、≥10 个读数闸门，且每个闸门都对应存在的臂脚本', () => {
  assert.deepEqual(
    scanSurfaceProblems(readWorkflow()),
    [],
    '解析面必须自证：job / 闸门少读一条，判据② 就会在那条闸门上静默变绿',
  );
});

test('⑤ 每个闸门 step 里只有一处给 `readings` 赋值/追加，且它必须与表里的 `counter` 逐字相等', () => {
  assert.deepEqual(
    counterProblems(readWorkflow()),
    [],
    '数字冻结了、数数字的表达式也必须冻结：把 `{n+=1}` 改成 `{n+=10}`，或用'
      + ' `export readings=$((readings * 10))` / `readings=${readings}0` / 第二处 `readings=$(…)`'
      + ' 在闸门前把读数放大（闸门与表都不动）——都是「读数照样够、闸门已被放空」',
  );
});

test('⑥ 14 个闸门的 `::error::` 文案里，阈值数字必须与 `-lt N` 相等（文案不能骗读日志的人）', () => {
  assert.deepEqual(
    errorTextProblems(readWorkflow()),
    [],
    '文案里的阈值与闸门数字是同一件事的两种声明（本片 B1 的原形就是「文案 15 条 / 闸门 -lt 25」）：'
      + '只改 `::error::` 里的数字、而 `-lt` 与表都不动时，①–⑤ 全绿',
  );
});

test('⑦ 判别力自证：数字改回 1／只改 yml／只改表／下调基线／删闸门／计数式改 10 倍／多塞一处计数式／三种追加式赋值／文案数字漂移，九种变异都必须红并点名', () => {
  const text = readWorkflow();

  // M1：某一处数字改回 1 ⇒ 判据① 与② 都必须红，并点名那条 step。
  const mediaBaseline = READING_GATE_BASELINES.find((entry) => entry.step.includes('媒体行清除驱动')).baseline;
  const backToOne = replaceGateNumber(text, '媒体行清除驱动', 1);
  assert.notEqual(backToOne, text, '自证前提：M1 必须真的改动了文本');
  const literal = literalOneProblems(backToOne);
  assert.equal(literal.length, 1, `改回 1 必须正好报一处：${literal.join(' / ')}`);
  assert.ok(literal[0].includes('媒体行清除驱动'), `判据① 必须点名 step：${literal[0]}`);
  assert.ok(literal[0].includes('第 ') && literal[0].includes(' 行'), `判据① 必须给出行号：${literal[0]}`);
  const drifted = baselineProblems(backToOne);
  assert.ok(
    drifted.some((problem) => problem.includes('媒体行清除驱动') && problem.includes(`表里是 \`baseline: ${mediaBaseline}\``)),
    `判据② 必须同时点名 step 与表里的基线：${drifted.join(' / ')}`,
  );

  // M2：只改 yml 不改表（数字动一格，**相对**现状 ⇒ 任何时点都不会与文件现状撞车）⇒ 判据② 红并点名。
  const auditBaseline = READING_GATE_BASELINES.find((entry) => entry.step.includes('审核全链')).baseline;
  const auditNow = gateNumberFor(text, '审核全链');
  const ymlOnly = replaceGateNumber(text, '审核全链', auditNow + 1);
  assert.notEqual(ymlOnly, text, '自证前提：M2 必须真的改动了文本');
  const ymlOnlyProblems = baselineProblems(ymlOnly);
  assert.equal(ymlOnlyProblems.length, 1, `只改 yml 必须正好报一处：${ymlOnlyProblems.join(' / ')}`);
  assert.ok(ymlOnlyProblems[0].includes('审核全链'), `M2 必须点名 step：${ymlOnlyProblems[0]}`);
  assert.ok(
    ymlOnlyProblems[0].includes(`-lt ${auditNow + 1}`) && ymlOnlyProblems[0].includes(`baseline: ${auditBaseline}`),
    `M2 必须打出两边数字（yml ${auditNow + 1} / 表 ${auditBaseline}）：${ymlOnlyProblems[0]}`,
  );

  // M3：只改表不改 yml ⇒ 判据② 红并点名（这里改的是「表里那条」：把 yml 的数字当作表的期望）。
  const retentionBaseline = READING_GATE_BASELINES.find((entry) => entry.step.includes('保留期时钟演练')).baseline;
  const tableOnly = READING_GATE_BASELINES.map((entry) => (
    entry.step.includes('保留期时钟演练') ? { ...entry, baseline: entry.baseline + 1 } : entry
  ));
  const tableOnlyProblems = baselineProblems(text, tableOnly);
  assert.equal(tableOnlyProblems.length, 1, `只改表必须正好报一处：${tableOnlyProblems.join(' / ')}`);
  assert.ok(tableOnlyProblems[0].includes('保留期时钟演练'), `M3 必须点名 step：${tableOnlyProblems[0]}`);
  assert.ok(
    tableOnlyProblems[0].includes(`baseline: ${retentionBaseline + 1}`),
    `M3 必须打出表里的新数字：${tableOnlyProblems[0]}`,
  );

  // 判据③ 的判别力：把某条基线下调到 1 ⇒ 必须红并点名。
  const floored = READING_GATE_BASELINES.map((entry) => (
    entry.step.includes('内容域持久化') ? { ...entry, baseline: 1 } : entry
  ));
  const flooredProblems = floorAndCountProblems(text, floored);
  assert.ok(
    flooredProblems.some((problem) => problem.includes('内容域持久化') && problem.includes('≥ 2')),
    `基线 < 2 必须红并点名：${flooredProblems.join(' / ')}`,
  );

  // 判据③ 的计数面：表少登记一条 ⇒ 「表条目数 ≠ 闸门数」必须红。
  const shortTable = READING_GATE_BASELINES.filter((entry) => !entry.step.includes('OCR 校正台账域'));
  const shortProblems = floorAndCountProblems(text, shortTable);
  assert.ok(
    shortProblems.some((problem) => problem.includes(`表条目数 ${shortTable.length} ≠ yml 读数闸门数 ${gateFacts(text).length}`)),
    `表少登记一条必须红：${shortProblems.join(' / ')}`,
  );

  // 判据④ 的判别力：把某个 step 点的脚本改成不存在的名字 ⇒ 必须红并点名。
  const ghostScript = text.replace(
    'tests/integration/media-row-purge-pg.mjs',
    'tests/integration/media-row-purge-pg-ghost.mjs',
  );
  assert.notEqual(ghostScript, text, '自证前提：判据④ 的变异必须真的改动了文本');
  const ghostProblems = scanSurfaceProblems(ghostScript);
  assert.ok(
    ghostProblems.some((problem) => problem.includes('media-row-purge-pg-ghost.mjs') && problem.includes('不存在')),
    `点到不存在的臂脚本必须红并点名：${ghostProblems.join(' / ')}`,
  );

  // M6（复审 B1 的同类缺口）：把**表里冻结的**计数式改掉一处（10 倍步长），闸门数字与表都不动
  // ⇒ 判据⑤ 必须红并点名那条 step。变异锚点从 `moderationEntry.counter` 取，**不写死** `{n+=1}`：
  // 否则「合法地把 yml 与表同步改成 `{n+=2}`」会让这里报「自证前提…必须有 {n+=1}」的假红（复审 T1）。
  const moderationEntry = READING_GATE_BASELINES.find((entry) => entry.step.includes('审核全链'));
  assert.ok(moderationEntry !== undefined, '自证前提：表里必须有「审核全链」这一条');
  const decupled = moderationEntry.counter
    .replace('{n+=1}', '{n+=10}')
    .replace('{n++}', '{n+=10}');
  const mutatedCounter = decupled === moderationEntry.counter
    ? `${moderationEntry.counter} # ×10`
    : decupled;
  assert.notEqual(mutatedCounter, moderationEntry.counter, '自证前提：M6 必须真给出一个不同的计数式');
  const counterTen = replaceCounterInStep(text, '审核全链', moderationEntry.counter, mutatedCounter);
  assert.notEqual(counterTen, text, '自证前提：M6 必须真的改动了文本');
  const counterDrift = counterProblems(counterTen);
  assert.equal(counterDrift.length, 1, `只改计数式必须正好报一处：${counterDrift.join(' / ')}`);
  assert.ok(counterDrift[0].includes('审核全链'), `判据⑤ 必须点名 step：${counterDrift[0]}`);
  assert.ok(counterDrift[0].includes(mutatedCounter), `判据⑤ 必须打出 yml 里被改后的计数式：${counterDrift[0]}`);
  assert.ok(counterDrift[0].includes(moderationEntry.counter), `判据⑤ 必须打出表里的 \`counter\`：${counterDrift[0]}`);
  // 这一处变异**不**该惊动别的判据（否则「红」定位不到计数式）：数字没动 ⇒ 判据② 仍然绿。
  assert.deepEqual(
    baselineProblems(counterTen),
    [],
    'M6 只改计数式、不改数字 ⇒ 判据② 必须仍然绿（红要出在判据⑤ 上，定位才准）',
  );

  // M7：给同一个 step 再塞一处 `readings=$(…)` ⇒ 「计数式唯一」这条必须红并点名（否则塞一条假的
  // 计数式、把真闸门挪到它上面，表格里冻结的那条就对着一条不再被使用的表达式）。
  const twoCounters = duplicateCounterInStep(text, '内容域持久化');
  assert.notEqual(twoCounters, text, '自证前提：M7 必须真的改动了文本');
  const twoCounterProblems = counterProblems(twoCounters);
  assert.equal(twoCounterProblems.length, 1, `多塞一处计数式必须正好报一处：${twoCounterProblems.join(' / ')}`);
  assert.ok(twoCounterProblems[0].includes('内容域持久化'), `M7 必须点名 step：${twoCounterProblems[0]}`);
  assert.ok(twoCounterProblems[0].includes('2 处'), `M7 必须报出「2 处」：${twoCounterProblems[0]}`);

  // M8（复审阻塞项的原形）：三种**追加式**赋值，都不改冻结的那一行、表也逐字相等，却能读在闸门
  // 之前把读数放大 ⇒ 判据⑤ 的「唯一性」必须红并点名那条 step。旧版只数 `readings=$(…)` 的条数，
  // 这三种一条都看不见（复审实测 6/6 全绿）。
  const appendForms = [
    'export readings=$((readings * 10))',
    'readings=${readings}0',
    'export readings=$(grep -c \'PASS \' "$log")',
  ];
  for (const form of appendForms) {
    const appended = appendAssignmentInStep(text, '审核全链', form);
    assert.notEqual(appended, text, `自证前提：M8 必须真的插入了 \`${form}\``);
    const appendedProblems = counterProblems(appended);
    assert.equal(appendedProblems.length, 1, `追加 \`${form}\` 必须正好报一处：${appendedProblems.join(' / ')}`);
    assert.ok(appendedProblems[0].includes('审核全链'), `M8 必须点名 step（${form}）：${appendedProblems[0]}`);
    assert.ok(appendedProblems[0].includes('2 处'), `M8 必须报出「2 处」赋值（${form}）：${appendedProblems[0]}`);
    assert.ok(appendedProblems[0].includes(form), `M8 必须把注入的那一行原样打出来（${form}）：${appendedProblems[0]}`);
    // 只多了赋值、数字没动 ⇒ 判据② 仍然绿（红要出在判据⑤ 上，定位才准）。
    assert.deepEqual(baselineProblems(appended), [], `M8（${form}）不该惊动判据②`);
  }

  // M9：只改 `::error::` 文案里的阈值数字（闸门 `-lt N` 与表都不动）⇒ 判据⑥ 必须红并点名。
  const moderationNow = gateNumberFor(text, '审核全链');
  const messageDrift = replaceInStep(text, '审核全链', `< ${moderationNow}）`, `< ${moderationNow + 3}）`);
  assert.notEqual(messageDrift, text, '自证前提：M9 必须真的改动了文案里的数字');
  const messageProblems = errorTextProblems(messageDrift);
  assert.equal(messageProblems.length, 1, `只改文案数字必须正好报一处：${messageProblems.join(' / ')}`);
  assert.ok(messageProblems[0].includes('审核全链'), `判据⑥ 必须点名 step：${messageProblems[0]}`);
  assert.ok(
    messageProblems[0].includes(String(moderationNow + 3)) && messageProblems[0].includes(`-lt ${moderationNow}`),
    `判据⑥ 必须打出两边的数字（文案 ${moderationNow + 3} / 闸门 ${moderationNow}）：${messageProblems[0]}`,
  );
  assert.deepEqual(
    counterProblems(messageDrift),
    [],
    'M9 只改文案 ⇒ 判据⑤ 必须仍然绿（红要出在判据⑥ 上，定位才准）',
  );
});

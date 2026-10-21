# GY 契约台账校验器：给 evidence 引用补「锚点/符号」结构性校验（R28-S31）

- 日期：2026-10-21
- 分片：契约台账证据锚点校验（交接队列 §7 第 ⑧ 条，S31）
- 分支：`test/gy-r28-contract-status-symbols`，基线 `56042f7`（rebase 后 = `upstream/main`；原派单基线 `c06d232`，`56042f7` 只改 `deploy/**` 与本目录另一证据页，不含 `tools/**` 与台账）
- 实现提交：`c8d133e`（校验器 ＋ 新测试 ＋ 说明文档两行原位改写）；本页单独提交
- 环境：Windows（PowerShell 5.1.26100）、Node v24.16.0、仓库依赖已装（`node_modules` 为真实目录）
- 本页所有数字都有可复跑命令；标「未取得」的一律**没有验证过**。

## 0 结论（先看这五条）

1. **缺口是「有行号、没锚点」**：基线 409 条证据里 `symbol`/`anchor` **0 条**，141 条 `name` 只证「文本在文件里出现过」，229 条纯行号只证「行号在文件长度内」。引用到底指到哪一行、哪个符号，机器此前**从没问过**（`checkEntry` 只做存在性/格式/边界；`checkSemantics` 只验路由注册块与断言区间，且只跑 operations）。
2. **本片只加一层锚点校验**：引用自带 `symbol` 或 `anchor`（二者同义、二选一）时，锚点文本必须出现在引用行范围内，容差 **±2 行**；`test` 引用的 `name` 等同锚点。找不到锚点＝**形状错误**判红；锚点在文件里但落在区间外＝**语义错误**判红；压根没有锚点＝只计「不可核」并列可疑，**不判红**。另加一档**与锚点无关**的区间内容可疑计数：任何带行号引用都量「这段里有没有实质内容行」，整段只剩空白/收尾行、或首行为空行只计可疑不判红（§1.1）。
3. **基线锚点覆盖率是 0%，所以缺锚点不判红**：409 条 = 141 条 `name`（计「仅整文件」）+ 229 条纯行号 + 9 条无行号 + 30 条无用例名 ⇒ 无锚点 268 条（65.5%）。若把「缺锚点」判红，main 立刻红，而台账行号漂移的订正是并行切片 S30 的活；本片只让「写了锚点却指不到/指偏」立刻红。
4. **±2 不是拍的**：229 条带行号引用距最近 `function`/`const`/`class` 声明行的偏移分布是 0→41、1→25、2→9、3→12、>3→121，另有 21 条上方找不到声明行。取 0 会误杀 34 条（14.85%）「引用把声明行后的空行/注释裁掉了」的正确锚点；取 3 只多覆盖 12 条（5.24%）却开始把「隔一条语句」算命中。
5. **测试与门禁**：新增 11 个用例（1 个仓内台账正控制 + 10 个临时目录夹具，其中 6 个判红、4 个绿），未改仓内台账当夹具；7 条门禁命令全部 exit 0（§4）。

## 1 改前实测：证据长什么样

台账是 [contract-status.json](../architecture/contract-status.json)，证据项由 [verify-contract-status.mjs](../../tools/verify-contract-status.mjs) 校验。基线 `56042f7` 实测（在仓根运行下面三段脚本，输出即表中读数）：

| 统计项 | 读数 |
| --- | --- |
| evidence 总数（operations 359 + dimensions 50） | 409 |
| 带 `path` / 带 `test` | 238 / 171 |
| 带 `lines`（operations 193 + dimensions 36） | 229 |
| 其中整段无实质内容（仅空白/收尾行） | 15 |
| 其中区间首行为空行 | 24 |
| 带 `name` | 141 |
| 带 `symbol` | 0 |
| 带 `anchor` | 0 |
| `path` 但无 `lines` | 9 |
| `test` 但无 `name` | 30 |

```js
// s31-anchors-shape.mjs —— 仓根运行：node s31-anchors-shape.mjs
import { readFileSync } from 'node:fs';
const status = JSON.parse(readFileSync('docs/architecture/contract-status.json', 'utf8'));
const items = [...status.operations, ...status.dimensions].flatMap(entry => entry.evidence ?? []);
const count = predicate => items.filter(predicate).length;
console.log('total', items.length);
console.log('path', count(item => typeof item.path === 'string'), 'test', count(item => typeof item.test === 'string'));
console.log('lines', count(item => item.lines !== undefined), 'name', count(item => item.name !== undefined));
console.log('symbol', count(item => item.symbol !== undefined), 'anchor', count(item => item.anchor !== undefined));
console.log('path-without-lines', count(item => item.path !== undefined && item.lines === undefined));
console.log('test-without-name', count(item => item.test !== undefined && item.name === undefined));
```

补充读数（同一次实测）：带 `lines` 的 229 条全是 `.ts`（227）与 `.mjs`（2）；9 条无行号 `path` 全在 conversations（`service.ts`×4、`store-pg.ts`、`0013_conversations.sql`、`job.ts`、`guard.ts`、`cascade.ts`）；`path` 与 `test` 同时出现的 **0** 条。

### 1.1 纯行号区间的内容实测（229 条每一条都能量到）

锚点档在基线恒不触发（0 条 `symbol`/`anchor`），所以另加一档不依赖锚点的结构度量：**这段行区间里有没有「实质内容行」**（去空白后非空，且不是 `}`、`);`、`end`、`--`、`/* */` 这类纯收尾行），以及**区间首行是不是空行**。

| 度量 | 读数 |
| --- | --- |
| 合法行区间引用 | 229 |
| 整段仅空白/收尾行（无实质内容） | 15 |
| 区间首行为空行 | 24 |

```js
// s31-anchors-content.mjs —— 仓根运行：node s31-anchors-content.mjs
import { readFileSync } from 'node:fs';
const status = JSON.parse(readFileSync('docs/architecture/contract-status.json', 'utf8'));
const items = [...status.operations, ...status.dimensions].flatMap(entry => entry.evidence ?? []);
const closing = /^(?:[}\]\)]+;?|end;?|--|\/\*.*\*\/)$/i;
const substantive = line => { const trimmed = line.trim(); return trimmed !== '' && !closing.test(trimmed); };
let refs = 0, contentless = 0, startsBlank = 0;
for (const item of items) {
  if (typeof item.path !== 'string' || item.lines === undefined) continue;
  const lines = readFileSync(item.path, 'utf8').split('\n');
  const [from, to] = item.lines.split('-').map(Number);
  if (from < 1 || to < from || to > lines.length) continue;
  refs += 1;
  const slice = lines.slice(from - 1, to);
  if (!slice.some(substantive)) contentless += 1;
  if (slice[0].trim() === '') startsBlank += 1;
}
console.log('lineRefs', refs, 'contentless', contentless, 'startsBlank', startsBlank);
// 期望：lineRefs 229 contentless 15 startsBlank 24
```

- 15 条整段无实质内容**全部**是 `services/api/src/routes/community.ts` 的单行区间 `:N-N`（200、210、222、231、240、250、263、275、284、293、313、322、331、340、352），实测这些行都是**空行**——引用等于没指到任何实现。
- 命中率 15/229 = 6.55%，不为 0 ⇒ 按派单口径**不判红**，只计入统计并列出前 5 条 `WARN`（§3.4）；命中率若为 0 才升级为形状错误，测试里没有这条红臂，证据页如实记录该阈值决定（§5）。
- 区间首行为空行 24/229 = 10.48%，同样只计数：首行空行多数是「区间从上一个函数收尾的空行开始」，属排版噪声，不足以判错。

`docs/architecture/contract-implementation-status.md:17` 这类行号型证据的脆弱性已有前科（#325 修过一次行号漂移）；本片的差别是：**从「人读 diff 发现」变成「写了锚点就机器每次问」**，但基线还没有任何一条锚点可问。

## 2 容差 ±2 行的实测依据

对 229 条带行号证据，从区间起点（含起点那一行）向上找最近的 `function`/`const`/`class` 声明行，统计「区间起点 − 声明行」：

| 偏移 | 条数 | 占比 | 含义 |
| --- | --- | --- | --- |
| 0 | 41 | 17.9% | 区间从声明行开始（最常见：`export function x` 那一行被引用） |
| 1 | 25 | 10.9% | 区间从声明后 1 行开始（裁掉声明行） |
| 2 | 9 | 3.9% | 区间从声明后 2 行开始（裁掉声明行与一个空行/注释） |
| 3 | 12 | 5.2% | 区间从声明后 3 行开始（已隔一条语句） |
| >3 | 121 | 52.8% | 区间落在声明体内部（引用的是函数里的一段，不是函数声明） |
| 上方无声明行 | 21 | 9.2% | 起始行往上直到文件头都没有声明（如 `.sql`/`.mjs` 片段、文件头部区间） |

```js
// s31-anchors-offset.mjs —— 仓根运行：node s31-anchors-offset.mjs
import { readFileSync } from 'node:fs';
const status = JSON.parse(readFileSync('docs/architecture/contract-status.json', 'utf8'));
const items = [...status.operations, ...status.dimensions].flatMap(entry => entry.evidence ?? []);
const buckets = new Map([[0, 0], [1, 0], [2, 0], [3, 0], ['>3', 0]]);
const declaration = /^\s*(export\s+)?(async\s+)?(function|const|class)\b/;
let missing = 0;
for (const item of items) {
  if (typeof item.path !== 'string' || item.lines === undefined) continue;
  const lines = readFileSync(item.path, 'utf8').split('\n');
  const from = Number(item.lines.split('-')[0]);
  let nearest = 0;
  for (let line = from; line >= 1; line -= 1) {
    if (declaration.test(lines[line - 1])) { nearest = line; break; }
  }
  if (nearest === 0) { missing += 1; continue; }
  const key = from - nearest > 3 ? '>3' : from - nearest;
  buckets.set(key, buckets.get(key) + 1);
}
console.log([...buckets], 'missing', missing);
// 期望：[ [ 0, 41 ], [ 1, 25 ], [ 2, 9 ], [ 3, 12 ], [ '>3', 121 ] ] missing 21
```

取 **2** 的理由：容差 0 会把「声明行后 1–2 行」这一类引用（34 条）误判成错位，而它们恰恰是把声明后的空行/注释裁掉的常见写法；容差 3 只多救 12 条（5.24%），代价是「隔一条语句」也算命中，判别力下降。**容差只放宽行位置，不放宽锚点文本**：文本是精确子串匹配。

同时这组数据决定了锚点的语义定义：**锚点＝这段引用里属于本操作的那一行/那几行，不是「所属函数名」**。因为 133/229（58.1%）的区间起点在声明后 ≥3 行（其中 21 条上方根本没有声明），若把锚点理解成外层声明名，这类引用天然在区间外，会把「合法引用」判成错位。该口径写进了工具函数注释与 [说明文档的第 0 节](../architecture/contract-implementation-status.md)。

## 3 改了什么（三档口径与字段）

### 3.1 字段与三档归类

字段：`symbol` 与 `anchor` 同义、二选一；同给且取值不同＝形状错误。空串/非字符串＝形状错误。`test` 引用的 `name` 自动当锚点（既有 141 条无需迁移）。示例：

```json
{ "path": "services/api/src/jobs/store.ts", "lines": "3-5", "symbol": "getJob" }
```

| 情形 | 归类 | 退出码 |
| --- | --- | --- |
| 锚点文本在被引用文件里根本找不到 | 形状错误 | 1 |
| 锚点字段形状非法（空串/非字符串）或 `symbol` 与 `anchor` 冲突 | 形状错误 | 1 |
| 锚点存在，但不在 `lines` 区间 ±2 行内 | 语义错误（不计入可核） | 1 |
| 有锚点但无 `lines`（含 `test`+`name`） | 计「仅整文件」，只能证「文件里出现过」 | 0 |
| 无锚点：纯行号 / 无行号源文件 / 无用例名 | 计「不可核」＋列前 5 条可疑 | 0 |
| 带行号引用整段仅空白/收尾行（基线 15 条） | 计可疑＋列前 5 条 | 0 |
| 带行号引用区间首行为空行（基线 24 条） | 计可疑计数 | 0 |

### 3.2 代码位置（用符号定位，不写行号）

都在 [tools/verify-contract-status.mjs](../../tools/verify-contract-status.mjs)：

- `const ANCHOR_TOLERANCE = 2`：容差，注释里写清 §2 的分布与取舍。
- `anchorSpec(item)`：判定锚点来源与形状，返回 `{ kind: 'conflict' | 'invalid' | 'value' | 'none' }`；`symbol`/`anchor` 同义，`test`+`name` 也算锚点。
- `anchorLineNumbers(text, value)`：锚点在文件里出现的全部行号（精确子串，非正则）。
- `checkEntry(entry, owner)`：新增三条形状判定——`symbol`/`anchor` 同给且不同值、锚点非空字符串、锚点文本必须能在被引用文件里找到（文案 `中找不到锚点「…」`）。
- `checkAnchors(entry, owner)`：**同时遍历 operations 与 dimensions**；`referenced` / `inRange` / `fileOnly` 三个计数与 `lineOnly` / `noLines` / `testNoName` 三个「不可核」分类；区间外写 `semanticErrors`，无锚点写 `anchorSuspicions`。
- `isSubstantiveLine(line)` 与 `CLOSING_LINE`：区间内容度量，纯收尾符（`}`、`);`、`end`、`--`、`/* */`）不算实质内容。
- `contentCounts` / `contentlessSuspicions`：对每条带行号引用（含无锚点的 229 条）统计 `lineRefs` / `contentless` / `blankStart`，只计数不判红。
- 输出：在两行既有 PASS 之后**追加**四行（锚点统计、无锚点 WARN、纯行号区间统计、整段无内容 WARN），不改既有文案（`tests/unit/contract-status-tool.test.mjs:372` 冻结了「语义可核 … 不可核 …」那行）。

### 3.3 区间内容可疑档（与锚点无关）

`checkAnchors` 对每条带行号引用（无论有没有锚点）都量两件事，均**只计数不判红**（基线命中 15 与 24）：

- `contentless`：整段没有一行实质内容（去空白后为空，或只是纯收尾符）；`blankStart`：区间首行为空行。
- `contentlessSuspicions` 列前 5 条 `WARN`；越界区间仍由形状检查判红，不进入这里。
- 判红阈值：派单口径是「基线命中为 0 才升级为硬失败」。实测 15 ≠ 0 ⇒ 保持可疑档；将来若清理到 0，应把 `contentless` 升为形状错误并补一条红臂测试。

### 3.4 基线实跑输出（新增四行原文）

```
PASS: 证据锚点 141 条引用自带锚点（区间内 0 条 + 仅整文件 141 条）；无锚点不可核 268 条（纯行号 229 + 无行号源文件 9 + 无用例名 30），只计数不判红
WARN: 无锚点可疑引用前 5/268 条：getPublicHome services/api/src/routes/public-home.ts:9-16、getPublicHome services/api/src/db/catalog.ts:14-27、loginWechat services/api/src/routes/auth.ts:42-83、loginWechat services/api/src/auth/wechat.ts:66-131、loginAdmin services/api/src/routes/admin-auth.ts:46-86
PASS: 纯行号区间 229 条（有实质内容 214 条；整段仅空白/收尾行 15 条、区间首行为空行 24 条，只计可疑不判红）
WARN: 整段无实质内容的前 5/15 条：listPosts services/api/src/routes/community.ts:200-200、createPost services/api/src/routes/community.ts:210-210、getPost services/api/src/routes/community.ts:222-222、editPost services/api/src/routes/community.ts:231-231、deletePost services/api/src/routes/community.ts:240-240
```

- 「仅整文件 141」与第 1 行「不可核 131 条片段」是**不同轴**：前者说的是「证据项有没有锚点、锚点能不能定位到行」，后者说的是「`name` 片段能不能落到断言实参里」。两者都不计入通过。
- 141 + 268 = 409，与 §1 的条目数闭合（测试 ① 每次跑都会重算这个恒等式，台账增删证据不会让断言失效）。

### 3.5 一个附带的好性质

`renderStatusTables` 渲染证据列时只认 `path:lines` 与 `test::name`，**忽略 `symbol`/`anchor`** ⇒ 给证据加锚点不会改变中文对照表、不会触发「表格漂移」。S30 订正行号时可以顺手补锚点而不必同步表格。

## 4 测试与门禁读数

### 4.1 新增测试：`tests/unit/contract-status-anchors.test.mjs`（11 个用例）

夹具全部建在 `mkdtempSync(join(tmpdir(), 'gy-contract-anchors-'))` 下，`t.after` 校验父目录确在系统临时目录后递归删除；工具文件用 `copyFileSync` 拷进夹具，**不读写仓内台账**。夹具源码行号是断言的一部分：`getJob` 在第 3 行、`listJobs` 第 7 行、`JOB_LIMIT` 第 11 行、`removeJob` 第 12 行。

| 用例 | 断言 | 实测 |
| --- | --- | --- |
| ① 正控制（仓内台账） | exit 0、stderr 空、`中文表格一致`；锚点数 + 不可核数 = 台账 evidence 总数、区间内 + 仅整文件 = 锚点总数、三分类 = 不可核总数 | pass，exit 0 |
| ② 路径不存在 | `证据文件不存在或不是文件 …` + `形状错误 1 / 语义错误 0 / 表格漂移 0` | exit 1 |
| ③ 行号越界（`0-3` 与 `999-1000`，纯行号无 symbol） | `lines=0-3 越界`、`lines=999-1000 越界` | exit 1 |
| ④ 无锚点纯行号 | exit 0、`证据锚点 0 条…；无锚点不可核 9 条（纯行号 9 …）`、`WARN: 无锚点可疑引用前 5/9 条`、`纯行号区间 9 条（有实质内容 9 …）` | exit 0 |
| ⑤ 纯行号区间整段仅空白/收尾行（`5-5` 只指到 `}`） | exit 0、`整段仅空白/收尾行 1 条`、`WARN: 整段无实质内容的前 1/1 条：getJob …store.ts:5-5` | exit 0 |
| ⑥ 纯行号区间首行为空行（`2-5`） | exit 0、`区间首行为空行 1 条`、无「整段无实质内容」WARN | exit 0 |
| ⑦ 锚点命中（3 个方向） | 区间首行 / 区间起点上方 2 行 / 区间终点下方 2 行（含 `symbol`+同值 `anchor` 并存）均 `区间内 1 条` | exit 0 ×3 |
| ⑧ 锚点落在区间外 | `锚点「getJob」不在引用行范围内（容差 ±2 行；实际出现在第 3 行）` + `语义错误 1` | exit 1 |
| ⑨ 锚点在文件里没有 | `中找不到锚点「noSuchSymbol」` + `形状错误 1` | exit 1 |
| ⑩ 锚点字段非法 | `锚点 symbol 必须是非空字符串`、`symbol 与 anchor 同给且取值不同` | exit 1 ×2 |
| ⑪ 语义错误 + `--write-doc` | `因存在语义错误，--write-doc 未写盘`，文档逐字节不变 | exit 1 |

复跑：`node --test --test-concurrency=1 tests/unit/contract-status-anchors.test.mjs` → `pass 11 / fail 0`，exit 0。

### 4.2 门禁逐条

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 静态检查 | `npm run lint` | exit 0（`PASS tsc --noEmit services/api`、`PASS tsc --noEmit apps/admin`、`PASS 仓库卫生扫描`） |
| 校验器本体 | `node tools/verify-contract-status.mjs` | exit 0，输出含新增四行统计（§3.4） |
| 文档校验 | `npm run test:docs` | exit 0（`PASS: 27 initial tasks…`；研究记录 5 通过 / 0 失败 / 4 legacy 钉住） |
| 契约测试 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | exit 0（6 pass） |
| 新增测试单跑 | `node --test --test-concurrency=1 tests/unit/contract-status-anchors.test.mjs` | exit 0（11 pass） |
| 单元 contract 全量 | `node --test --test-concurrency=1 tests/unit/*contract*.test.mjs`（命中 11 个文件） | exit 0（134 pass） |
| 发布材料 | `node tools/verify-release-materials.mjs` | exit 0（15/15 项通过） |

既有 `tests/unit/contract-status-tool.test.mjs`（413 行 / 18 个 test）与 `tests/unit/ci-contract-status-gate.test.mjs`（含「校验器文本不得含 `--force`/`--skip`」断言）都在上面 134 pass 里，未被本片改动。

## 5 取舍理由

- **为什么不把「缺锚点」判红**：基线 0/409 有锚点，268 条无锚点（65.5%）。把缺失判红等于用新规则否定整本台账，且与 S30 的行号订正抢同一件事；而「写了锚点却指错」是本片能独立判、且新写入能立刻受益的口子。
- **为什么「整段无实质内容」只计可疑、不判红**：基线 229 条里命中 15 条（6.55%），不为 0 ⇒ 按派单口径不升级为硬失败。这 15 条全在 `community.ts` 且都指向空行，是真实的可疑引用；若将来清理到 0 条，再把 `contentless` 升为形状错误并补红臂，届时判定力更强。区间首行空行 24 条（10.48%）同理只计数：它多是「区间从上一函数收尾的空行开始」的排版噪声。
- **为什么锚点缺失仍要高调出现**：只计数会让人以为「没有缺失」。所以输出把 268 拆成三类（纯行号 229 / 无行号源文件 9 / 无用例名 30），并列出前 5 条可疑引用（`WARN` 行），不判红但始终可见。
- **为什么 ±2**：见 §2 的 41/25/9/12/121（另 21 条上方无声明）；取 0 误杀 34 条（14.85%），取 3 只多 12 条（5.24%）且开始跨语句。
- **为什么 dimensions 也进锚点统计、但既有 72/121 计数行不动**：`checkSemantics` 只遍历 operations，dimensions 的 36 条带行号证据从没被区间检查覆盖（72+121=193 正是 operations 的 193 条）。本片不改那一行文案（被 `tests/unit/contract-status-tool.test.mjs:372` 冻结），锚点与区间内容作为独立统计行追加，并且**对 operations 与 dimensions 一视同仁**。
- **为什么 `name` 只计「仅整文件」**：141 条 `name` 没有行号，只能证「文本在文件里出现过」，不能冒充区间可核；若把 `name` 一律当区间可核，等于把「存在性」包装成「位置可核」。
- **为什么「找不到锚点」是形状错误、不叫语义错误**：与既有 `找不到用例名`（`tests/unit/contract-status-tool.test.mjs:120` 冻结文案）同级——都是「引用形式不成立」；语义错误只留给「锚点在文件里、只是不在引用行范围内」这种可证伪的错位。
- **为什么 `--write-doc` 在锚点语义错误时不写盘**：沿用既有的保护（`因存在语义错误，--write-doc 未写盘`），新语义错误自动继承；否则错位引用会被固化进对照表、从此不可见。用例 ⑪ 证明文档逐字节未变。
- **为什么不加绕过开关**：`tests/unit/ci-contract-status-gate.test.mjs` 冻结了「校验器文本不含 `--force`/`--skip`」，本片不引入任何跳过锚点校验的口子。

## 6 未取得（如实）

1. **没有在真 GitHub runner 上跑过**：本片未动 `.github/**`，锚点校验随 S19 接好的那一步在 CI 里跑，但本页没有新的 runner 读数。
2. **锚点判红的证据全部来自临时夹具**：基线 409 条里 0 条锚点，所以「区间外判红」「找不到锚点判红」在真实台账上没有样本；**229 条纯行号引用仍无符号可核**，基线「区间内 0 条」只是因为台账里没有任何 `symbol`/`anchor` 字段，不代表这些引用都指对了行。真实台账里的错位要到 S30 补锚点后才会出现。
3. **没有验证「锚点语义正确」**：脚本只证明「锚点文本出现在引用的行范围内」，不证明这段代码真的实现了该操作（与既有免责一致：`状态为人工判定；脚本不证明语义正确、真实能力或整项验收`）。
4. **没有重跑 `--runtime` 臂**：本片未改装配扫描（`scanMountedRoutes`/`runtimeMountedRoutes`），该臂的既有证据见 [S19 证据页](gy-r28-contract-status-gate-20261020.md)，本页未复测。
5. **没有做「故意写坏仓内台账」的变异测试**：红线禁止改 `docs/architecture/contract-status.json`，所有负控制都在临时目录夹具上；也因此没有「台账写了错锚点被本工具抓到」的真实案例。
6. **S30 的行号订正不在本片**：本片只加校验能力，未改任何一条证据的 `path`/`lines`/`symbol`；台账仍 0 锚点。
7. **「整段无实质内容」的红臂没有写成硬失败**：基线实测 15 条（≠0），按派单口径降为可疑档，因此测试只有「只计可疑不判红」的绿臂；若未来基线清到 0 再升级判红，本页的阈值决定需同步改写。

## 7 复跑清单

```
node tools/verify-contract-status.mjs                        # exit 0，看「证据锚点 …」「纯行号区间 …」与两条 WARN
node --test --test-concurrency=1 tests/unit/contract-status-anchors.test.mjs   # 11 pass
node --test --test-concurrency=1 tests/unit/*contract*.test.mjs                # 134 pass
node --test --test-concurrency=1 "tests/contract/*.test.mjs"                   # 6 pass
npm run lint                                                 # exit 0
npm run test:docs                                            # exit 0
node tools/verify-release-materials.mjs                      # 15/15
```

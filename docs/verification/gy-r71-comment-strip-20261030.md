# GY-R71（#781 已知判据缺陷）· 结构钉子的「去注释」正则会被人写的一段注释骗过：取证、状态机、回归钉子（2026-10-30）

> 一句话：结构钉子惯用「先把注释抹掉、再在剩下的代码里找符号」。`#781` 的写手发现这个前置步骤用的是
> **一条没有状态**的惰性正则。只要 `/**` 出现在块注释**之外**——`//` 注释正文里写 `services/api/src/**`，
> 或者字符串字面量里写同一个 glob——正则就把那里的**开注释二字符**当成注释开头，一路吃到**下一个**闭合
> 二字符，把中间的**真实代码**整段删掉。**误红**（真实调用被吞，钉子红而代码是对的）与**假绿**（违规写法被
> 吞，判据看不见它）是同一个根因。本片把它换成逐字符状态机（保留行号），并用两棵合成树先红后绿钉住。

本页只做五件事：把缺陷的**四种形状**逐字复现；把**全仓同类剔除点**逐条分档；给出状态机的**规则表与边界**；
用**四条负控制**证明新钉子不是恒绿装饰；给出**九条门禁**读数。
**零产品代码改动**：只动 `tests/**`、`tools/**`、`docs/**`（新增 2 个文件、改 1 个文件；`git diff --name-only 8b646ae1..HEAD` 里没有任何非这三类的路径）——**没有一个字落在 `services/api/src/**` 上** ⇒ **无需** `--reanchor`（dry-run 读数在 §9）。

---

## 1 基线与口径

| 项 | 值 |
| --- | --- |
| `upstream/main` | `8b646ae1cf8c02a7a55a659cbe3b91f95fc5a7cc`（`git rev-parse '8b646ae1^{commit}'` 与 `git log -1` 逐字一致；提交标题 `Add explicit moderation startup approval (#781)`） |
| 工作树 | `E:\GengYunCommander\wt-r71-strip`，分支 `fix/gy-r71-comment-strip`（从 `8b646ae1` 起） |
| 依赖 | `npm ci --prefer-offline --no-audit --no-fund --ignore-scripts --cache E:\GengYunCommander\.npm-cache`（`added 103 packages in 3s`，exit 0） |
| `TMP`/`TEMP` | 仓外 `E:\GengYunCommander\.pg17\tmp\gy-r71-strip` |
| 运行时 | Windows / node v24.16.0 / npm 11.x |

**本片没有**：真实凭据、真实外呼、真 PG、任何网络动作。全部读数是本机合成夹具。

---

## 2 缺陷复现形状（逐字读数）

四种形状跑同一段旧正则与新状态机。**旧**＝⑧ 原先那行
`source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')`；
读数＝在剔除结果里数 `approveModerationLiveWiring(` 出现几次。

### 2.1 形状A · `//` 注释正文里写 glob ⇒ **假绿／误红同源**

```js
// 动态枚举 services/api/src/** 下的所有 .ts（不写死文件清单）
export const VIOLATION = approveModerationLiveWiring();
/* 尾部说明 */
```

| | 剔除结果 | 看见 `approveModerationLiveWiring(` |
| --- | --- | --- |
| 旧 | `""`（整段没了） | **0 次** |
| 新 | 第 1 行空白、第 2 行原样、第 3 行空白 | **1 次** |

旧正则从 `src/**` 里的开注释二字符起，一路吃到第 3 行那个块注释的闭合二字符 ⇒
**真实调用被删**。若被删的是获准调用点 ⇒ **误红**；若被删的是违规调用 ⇒ **假绿**。

### 2.2 形状B · 字符串字面量里写 glob ⇒ 同上

```js
const GLOB = 'services/api/src/**';
export const VIOLATION = approveModerationLiveWiring();
/* 尾部说明 */
```

| | 剔除结果 | 看见 |
| --- | --- | --- |
| 旧 | `const GLOB = 'services/api/src` | **0 次** |
| 新 | 三行俱在（字符串原样） | **1 次** |

### 2.3 形状C · 行尾 `//` 注释 ⇒ **纯误红**（同一个函数的第二个毛病）

```js
export const ok = 1; // 这里不是铸造：approveModerationLiveWiring( 只是被提到
```

| | 看见 | 说明 |
| --- | --- | --- |
| 旧 | **1 次** | 旧口径的 `^\s*\/\/` 只剥**行首** `//`，行尾这条留在「代码」里 |
| 新 | **0 次** | `//` 在任何位置都进行注释（状态机不关心列位置） |

这条与 `/**` 无关，但**同属「⑧ 的前置步骤不可信」**，一并钉住（⑨ 的夹具第 4 行就是这种混排，
负控制③就打在它上面）。

> ⚠ **诚实边界**：`#781` 写手第一版注释的**原文没有进仓**。`git show b9759cbe:tests/unit/moderation-live-wiring-assembly.test.mjs`
> 里那行已经是 `/** 动态枚举 services/api/src/**：… */`（§2.5 的形状，**不会**触发本缺陷）。
> 所以「他当时到底踩了哪一种形状」**无法从历史复原**——本页只主张**已复现**的这几种形状，
> 不替历史下结论，也不把「形状C 就是他那一次」写成事实。

### 2.4 形状D · **不是判据缺陷**（登记在此，防被算成修复项）

```js
/**
 * 扫描 services/api/src/**/*.ts
 * ⛔ 不得调用 approveModerationLiveWiring(。
 */
```

`src/**/*.ts` 里的 `**/` **本身**就含闭合二字符。**JS 自己的块注释也在那里结束**——
所以旧正则看见 1 次、新状态机**也**看见 1 次。这不是判据错，是**源码本身不是合法 JS**（`tsc` 会报错，
`npm run lint` 会红）。**本片不"修"它**，也不允许把「新状态机在形状D上等同于旧正则」当成回归。

### 2.5 今天的源码**没踩到**（这是巧合，不是健壮）

`git grep -n 'approveModerationLiveWiring' 8b646ae1 -- services/api/src` 的注释只有两处：
`services/api/src/app.ts:512`（同行 `/** … */`，正文提 `approveModerationLiveWiring()`）与
`services/api/src/moderation/live-assembly.ts:114`（`{@link …}`，无括号）。两处正文里都没有
「`/**` 后紧跟斜杠」的形状 ⇒ 旧正则在**今天**的产品源码上恰好是对的。
⇒ ⑧ 在基线是绿的，**但那是巧合**：只要有人把注释里的路径写成形状A/B，⑧ 就会误红或假绿。
这正是「已知判据缺陷」的含义——**判据面比它自称的窄**。

---

## 3 全仓同类扫描（`git grep -n "\[\\\\s\\\\S\]\*?" 8b646ae1 -- tests tools`）

命中 **118 行**，按「有没有同样的吞代码风险」分三档。判据：剔除结果是否被用来**判定符号在场／不在场**。

| 档 | 条数 | 含义 |
| --- | --- | --- |
| **高** | **28**（本片已修 1，余 **27**） | 剥的是 **JS/TS 源码**，随后判「某符号必须/不得出现」⇒ 吞代码即误红或假绿 |
| **中** | 7 | 剥的是 **CSS/WXSS** 块注释：语法上不嵌套、不用 glob，且判定目标不是代码符号 |
| **低／不适用** | 2 | 一处**不是**剥离器；一处是**已经做对了**的先例 |
| （另一类） | 11 | `<!-- … -->` **HTML/WXML** 注释：`<!--` 不会在注释里"另起"，风险形态不同，未计入高/中档 |
| （不计） | 70 | 虽然也含 `[\s\S]*?`，但**不是剥注释**（配块、切 SQL、抓标签），与本缺陷无关 |

> **重跑这条 grep 的注意**：本片合入后，把同一条命令**不加 rev**（在工作树上）重跑会命中 **120** 行而不是 118。
> 多出的 2 条是 `tests/unit/moderation-live-wiring-assembly.test.mjs` **注释里引用**了旧正则
> （`tests/unit/moderation-live-wiring-assembly.test.mjs:62` 的「不要重写它」提示、
> `tests/unit/moderation-live-wiring-assembly.test.mjs:545` 的缺陷说明）——是**散文，不是剥离点**。
> 本页的 118 / 28 / 7 / 2 全部按 `-- 8b646ae1` 钉在被比对的提交上数，不在工作树上数。

### 3.1 高档（28 条，逐条）

`tests/integration/tts-http.mjs:800`、`tests/integration/tts-http.mjs:844`、`tests/integration/tts-http.mjs:855`、
`tests/ui-adaptive.test.mjs:497`、
`tests/unit/conversation-retrieval-validity.test.mjs:402`、`tests/unit/conversation-retrieval-validity.test.mjs:497`、
`tests/unit/doc-anchors-guard.test.mjs:357`、`tests/unit/g-drill-readings.test.mjs:126`、
`tests/unit/i11-audio-source-wiring.test.mjs:508`、`tests/unit/i11-real-media-wiring.test.mjs:515`、
`tests/unit/i11-real-media-wiring.test.mjs:523`、
`tests/unit/knowledge-ledger-sort-drift.test.mjs:62`、`tests/unit/knowledge-order-sql-direction.test.mjs:74`、
`tests/unit/miniprogram-qa-text-question.test.mjs:951`、
`tests/unit/miniprogram-speech-autoplay.test.mjs:219`、`tests/unit/miniprogram-speech-autoplay.test.mjs:228`、
`tests/unit/miniprogram-speech-autoplay.test.mjs:249`、
`tests/unit/miniprogram-transcript-confirm.test.mjs:981`、
`tests/unit/miniprogram-voice-playback.test.mjs:955`、`tests/unit/miniprogram-voice-playback.test.mjs:1137`、
`tests/unit/moderation-approval-flag.test.mjs:530`、`tests/unit/moderation-image-source.test.mjs:620`、
`tests/unit/moderation-live-adapter.test.mjs:883`、
`tests/unit/moderation-live-wiring-assembly.test.mjs:457`（**本片已修**，现改走 `tools/lib/strip-comments.mjs`）、
`tests/unit/ocr-image-source.test.mjs:588`、`tests/unit/ocr-media-port.test.mjs:647`、
`tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs:162`、`tests/unit/sql-column-coverage.test.mjs:1409`

这一档里有几条**风险面更大**，值得指挥单独立片（见 §10）：

- `tests/unit/moderation-live-adapter.test.mjs:883` 与 `tests/unit/moderation-approval-flag.test.mjs:530`：
  扫的正是 `services/api/src/app.ts` / `services/api/src/server.ts` / `services/api/src/moderation/startup-approval.ts`
  ——与 ⑧ **同一批文件**，同一个吞代码风险。
- `tests/unit/doc-anchors-guard.test.mjs:357`：剥 `tools/verify-doc-anchors.mjs` 后判「不得用内容哈希」。
  这条自己写在判据闸门的**自检**里，被吞代码的后果是「闸门退化了也看不出来」。
- `tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs:162`：`//` 用的是 `(^|[^:])\/\/[^\n]*`
  ——带 `://` 前缀豁免，比 `^\s*\/\/` 好一些，但**字符串里的 `//`** 仍会被当注释（形状B 的镜像风险）。

### 3.2 中档（7 条，CSS/WXSS）

`tests/ui-adaptive.test.mjs:223`、`tests/unit/admin-ui-focus-and-row-keys.test.mjs:88`、
`tests/unit/miniprogram-qa-text-question.test.mjs:974`、`tests/unit/miniprogram-voice-playback.test.mjs:1789`、
`tools/demo-align.mjs:53`、`tools/demo-align.mjs:372`、`tools/verify-layout.mjs:27`

CSS 块注释不嵌套、也没有 `**` glob 习惯，且这七处判的是**声明/字号**而不是「代码里有没有某符号」⇒
吞代码的**爆炸半径**比高档小得多。**不代表没风险**，只是不构成本缺陷的同形。

### 3.3 低／不适用（2 条）

- `tests/unit/ocr-image-source.test.mjs:552`：**不是**剥离器。它是「期望两个 token 之间夹一段注释」的
  **匹配模式**（`const ocrImageMedia = /*…*/ { objectStore: … }`）。误判后果是「注释格式变了就红」，不是吞代码。
- `tools/contract-status-core.mjs:13`：**已经做对了的同类实现**——`withoutComments()` 用
  `("…"|'…'|`…`)|(//…|/*…*/)` 的**先字符串、后注释**轮换，并且把命中段替换成等长空格以保行偏移。
  它同时解决了形状A（`//` 里的 glob 被当成行注释吃掉）与形状B（字符串先被吃掉）。
  **本片不是"发明"了更好的东西，而是把这条正确口径抽成独立、可复用、带行号接口的模块**；
  `tools/contract-status-core.mjs` 保持原样（它在别的钉子面，收敛与否见 §10 第 2 条）。

### 3.4 顺带发现：仓里已有两条「保行号」的注释置空先例

`tests/reference/knowledge-client.test.mjs:43` 与 `tools/verify-research-records.mjs:147` 都用
`block.replace(/[^\n]/gu, ' ')` 把注释换成等长空白。本模块的 `placeholder` 就是同一口径的**通用化**。

---

## 4 状态机：规则表与边界

实现：`tools/lib/strip-comments.mjs:85` 的 `stripComments(source, { placeholder })`（纯函数、无 IO、不看环境变量）。
配套：`tools/lib/strip-comments.mjs:258` 的 `lineNumberAt`、`tools/lib/strip-comments.mjs:282` 的 `occurrencesWithLines`。

### 4.1 规则表（状态 × 输入 → 动作）

| 状态 | 看到 | 动作 |
| --- | --- | --- |
| 代码 | `//` | 进「行注释」，两字符置空 |
| 代码 | `/*` | 进「块注释」，两字符置空（`/**` 天然包含在内） |
| 代码 | `'` / `"` | 进对应字符串态，引号**保留** |
| 代码 | 反引号 | 进模板态，反引号**保留** |
| 代码（由模板插值进入） | `${` | 压栈、花括号深度归零，继续按**代码**处理插值 |
| 代码 | `{` / `}` | 维护花括号深度；深度归零且栈非空 ⇒ 插值结束，回模板态 |
| 行注释 | 任意（不含换行） | 置空 |
| 行注释 | 换行 | 回「代码」，换行**原样输出** |
| **块注释** | **闭合二字符** | 回「代码」，两字符置空 |
| **块注释** | **其它（含开注释二字符、含 `/**`）** | **置空——只有闭合二字符能结束块注释；`/**` 既不能终止也不能另起** |
| 字符串 | 反斜杠 | 与下一字符**成对**原样输出（`//`、`/*` 在串里都不是注释） |
| 字符串 | 自身引号 | 回「代码」，引号保留 |
| 字符串 | 未转义换行 | 回「代码」（普通字符串不能跨行；反斜杠续行已在上一条成对吃掉） |
| 模板 | 反斜杠 / 自身反引号 | 同上 |
| 模板 | `${` | 按上面「代码」的插值规则处理 |

块注释那两行是**本缺陷的正解**，实现在 `tools/lib/strip-comments.mjs:144`；字符串态在
`tools/lib/strip-comments.mjs:159`。三条边界性质：

1. **`/**` 在注释正文里不终止、不跨界**：块注释态只认闭合二字符，所以形状A/B 里那个"第二个注释开头"
   根本不存在。
2. **字符串里的 `//` 不是注释**：URL 字面量（`https://…`）不会被切掉行尾代码（负控制③）。
3. **行号与列偏移都不动**：换行符永远原样输出；注释字符逐个换成一个空格。于是
   `输出行数 === 输入行数`、报错里的行号直接可念、整行注释视觉上就是空行占位。

### 4.2 明确的边界（**没**做到的）

- **正则字面量里的开注释二字符**（例如字符类里同时含斜杠与星号）会被当成块注释开头。JS 的「除号 vs 正则」
  需要上下文解析，本模块不做。扫描面已核：`git grep -nE '\\/\\\*|\[/\*\]|\\/\*' 8b646ae1 -- 'services/api/src/**/*.ts'`
  **零命中** ⇒ 本缺陷面上不触发。
- 模板插值里再嵌模板、插值花括号不平衡的**畸形**源码：按字符计深度，结果不可信（合法源码不受影响）。
- 注释指令（`@ts-expect-error`）与 `#!` shebang 按普通注释/普通文本处理。
- 只做「抹注释」，**不解析语法**，不保证输出是合法 JS/TS。
- ⚠ 写本模块时自己踩了一次：**文件头注释里写字面的闭合二字符会把注释提前闭合**（`node --check` 直接报
  `SyntaxError`）。所以头注里用 `*\/` 这个写法指代它。这不是八卦——它正是本缺陷的**最小自证**：
  无状态的东西（人和正则一样）都会在"讲它"的那一行把自己闭合掉。

---

## 5 ⑧ 的新旧对比

| | 旧（`8b646ae1`） | 新 |
| --- | --- | --- |
| 去注释 | 本地一行 `const strip = (source) => source.replace(…)` | `tools/lib/strip-comments.mjs` 的状态机 |
| 扫描逻辑 | 内联在 ⑧ 里 | 抽成 `tests/unit/moderation-live-wiring-assembly.test.mjs:477` 的 `scanWiringCallSites(root)`（⑧ 与 ⑨ 共用同一份判据） |
| 行号 | 无（吞了代码也不知道吞了哪几行） | `callSiteLines` 带**原文件**行号 |
| **⑧ 的断言数量** | **8 个断言点 / 执行 13 条** | **8 个断言点 / 执行 13 条 — 不变** |
| 判据强度 | — | **变强**：同一个判据现在对形状A/B/C 都成立；且 ⑧ 的扫描面**不再能被注释改写** |
| 新增用例 | — | ⑨（`tests/unit/moderation-live-wiring-assembly.test.mjs:624`）**8 条断言** |

**为什么 ⑧ 的断言数不变却不是放宽**：⑧ 钉的还是同一件事（铸造点恰好两处：定义处 ＋ 唯一获准调用点），
只是把「前置步骤」换成了正确的实现。**没有删断言、没有改期望值、没有放宽容差**。
新增的强度落在 ⑨：它把「去注释本身对不对」变成可执行断言。

---

## 6 ⑨ 回归用例：先红后绿

夹具（合成树，`mkdtempSync(join(tmpdir(), 'gy-r71-strip-'))`，`finally` 里 `rmSync`）：

| 文件 | 关键内容 | 作用 |
| --- | --- | --- |
| `moderation/live-assembly.ts` | `export function approveModerationLiveWiring(` | 定义处（不算调用点） |
| `tests/unit/moderation-live-wiring-assembly.test.mjs:584`（获准调用点夹具） | 第 3 行 `// … services/api/src/** …`；第 4 行**真实调用**，同一行还有 `'https://api.example.test/v1/moderation'`；第 5 行块注释 | 形状A + 形状C + 负控制③的判别式 |
| `tests/unit/moderation-live-wiring-assembly.test.mjs:597`（合规 `app.ts` 夹具） | 块注释正文含 `` `services/api/src/**` `` 且**提到**铸造点名；无真实调用 | ⑧ 的「注释里提到不算」方向 |
| `tests/unit/moderation-live-wiring-assembly.test.mjs:612`（违规 `app.ts` 夹具） | 第 1 行 `// … services/api/src/**`、第 3 行**真的铸造**、第 5 行块注释 | 假绿方向 |

断言（8 条）：

1. `stripComments` 输出**行数** === 输入行数（行号保留）；
2. 剔除结果里**没有** `services/api/src`（`//` 注释正文被整体抹掉，含里面的 `/**`）；
3. 合规树 `offenders === []`（注释里提到铸造点名**不**算铸造）；
4. 合规树 `callSites === [{ file: 'moderation/startup-approval.ts', calls: 1 }]` ——**获准调用点必须被看见**；
5. 合规树 `occurrences === 2`；
6. 合规树 `callSiteLines === [{ …, line: 4 }]` —— 行号是**原文件**行号；
7. 违规树 `offenders === ['app.ts']` ——**违规写法必须被点名**；
8. 违规树 `occurrences === 3`。

**先红后绿的读法**：合规树在旧正则下会变成红（断言 4/5 断），违规树在旧正则下会变成绿（断言 7 断）。
⇒ ⑨ 同时挡住两个方向，且**对新旧实现的判定不同**（不是恒真）。

---

## 7 负控制（打红 → 恢复复绿）

四条都做过：改一处实现 → 跑本文件 → 记录**红在哪条断言、红成什么** → 从备份恢复 → 复跑全绿。
每条都只说「哪条断言被点红」，不做演绎。

| # | 打的洞 | 红在哪 | 逐字读数（`actual` vs `expected`） |
| --- | --- | --- | --- |
| ① | 用回旧正则（把 `scanWiringCallSites` 里的 `stripComments(...)` 换回 `s.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'')`） | ⑨ 断言 4 | `[]` vs `[{ calls: 1, file: 'moderation/startup-approval.ts' }]` —— 调用点被吞（**误红**） |
| ② | 状态机把 `/**` 当**终止符**（块注释态额外在见到开注释二字符时退出） | ⑨ 断言 3 | `['app.ts']` vs `[]` —— 注释正文里的 `services/api/src/**` 提前闭合，注释后半段变「代码」（**误红**） |
| ③ | 把**字符串里的 `//`** 当注释（字符串态额外识别 `//` 并切行） | ⑨ 断言 4 | `[]` vs `[{ calls: 1, … }]` —— URL 字面量把同一行后面的真实调用整段切掉（**假绿**） |
| ④a | 输出**丢行号**（换行符不再原样输出） | ⑨ 断言 1 | `1` vs `9` —— 输出行数塌成一行 |
| ④b | 输出**丢行号**（`lineNumberAt` 恒返 1） | ⑨ 断言 6 | `[{ …, line: 1 }]` vs `[{ …, line: 4 }]` |

④ 拆成两档，是因为「丢行号」有两种丢法：**行数塌了**（④a）与**行数还在但换算错了**（④b）；
只钉一种会漏掉另一种。

**复绿**：四条洞全部从备份恢复后，`node --test tests/unit/moderation-live-wiring-assembly.test.mjs`
= `tests 10 / pass 10 / fail 0`（含 ⑧ 与 ⑨）。

---

## 8 证明了什么 / 没证明什么

### 8.1 证明了什么

1. **缺陷是真的，且有两个方向**：形状A/B 会让真实代码**整段消失**（误红＝获准调用点被吞；假绿＝违规调用被吞），
   形状C 会让**行尾注释**混进「代码」造成纯误红。四种形状各有逐字读数（§2）。
2. **旧判据今天绿是巧合**：产品源码的两处注释恰好不含「`/**` 后紧跟斜杠」的形状（§2.5）。
   本片没有把巧合当健壮。
3. **新判据对形状A/B/C 都成立**：⑨ 的合规树绿、违规树红，且**同一组断言在旧实现下结论相反**（§6、§7）。
4. **新判据不是恒绿**：四条（五档）负控制都能把它打红，且红的落点各不相同（§7）。
5. **全仓同类面已量化**：28 条高档、7 条中档、2 条低/不适用、11 条 HTML 类、70 条非剥离（§3）。
   本片只修高档里的 1 条（⑧），其余逐条登记。
6. **⚠ 未改产品代码**：`services/api/src/**` 零改动 ⇒ `--reanchor` 不需要（§9 有一条 dry-run 读数佐证）。

### 8.2 没证明什么

1. **没证明其余 27 条高档判据是安全的**：它们逐个都可能踩同一个坑，本片只做了分档，**没有**逐条
   构造触发器复现。要下结论必须逐条做，不能从"同形"推"同犯"。
2. **没证明新状态机对所有 JS/TS 合法**：正则字面量里的开注释二字符、畸形插值、模板里嵌模板都未覆盖（§4.2）。
   扫描面已 grep 确认**当前**无此形态，但那是**今天**的读面，不是永恒性质。
3. **没证明形状D 被修好**——它是**源码不合法**，不是判据缺陷（§2.4）。
4. **没证明 `tools/contract-status-core.mjs` 需要改**：它已经做对了，本片不动它（§3.3、§9）。
5. **没跑真 PG / 真外呼 / 真凭据**：门禁全是离线读数。
6. **门禁读数取本机**（Windows / node v24.16.0）；CI 数值可能略有差异，但**同一条判据的红/绿不会不同**
   ——本片断言与平台无关（无路径分隔符硬编码、无 `process.platform`、无 `process.cwd()`、无墙钟、无环境变量依赖）。
7. **没证明「注释里提到函数名」在所有文件里都不算违规**：⑨ 只钉了 `approveModerationLiveWiring` 这一族。

---

## 9 门禁读数（九条 + CI-exact，全部 exit 0）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | **提交后**：`tests 5853 / pass 5849 / fail 0 / cancelled 0 / skipped 2 / todo 2`；**提交前**同一命令是 `tests 5853 / pass 5849 / fail 1 / skipped 1 / todo 2`，唯一红是 `doc-anchor-relocation-identity`（见 §9.1；`todo 2` 是既有的两条 I11 缺口本体用例，不计 fail） | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（覆盖 126 条契约操作；已装配 126；implemented 18 / partial 108 / planned 0；形状错误 0、语义错误 0；行号区间 313 条）；`verify-doc-anchors --strict` PASS（`BARE_ORPHAN` 命中 3479、基线外新增 **0**、陈旧 0；`ANCHOR-COUNT` 6326 条 / 227 份，下降 **0** 份、上升 12 份） | 0 |
| **CI-exact** `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `SYMBOL-STRICT` 可判 801 条：落代码行 761 通过、未落代码行 36 进基线、基线外新增 **0**（作用域外同形状 223 条只统计）；`ANCHOR_DRIFT` 15 条全在基线内；`BARE-ORPHAN` 3543 / 3543 全在基线内（作用域外 134 / 134 亦全在基线内）；`ANCHOR-COUNT` 6582 条 / 237 份，下降 **0** 份、上升 15 份；`PASS: --strict 下没有基线之外的新增` | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []`（`missing 0`、`planned 0`） | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`；文档标记块与重算一致 | 0 |
| `npm run test:docs` | 研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住`；`docs/research` 结构校验 PASS | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run build` | api + admin `built`；**build 后、unit 前已删 `services/api/dist` 与 `apps/admin/dist`**（`Test-Path` 双双 `False`） | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |
| 额外·`node tools/verify-contract-status.mjs --reanchor`（dry-run） | **无需**重定位：本片未改任何被台账引用的 `services/api/src/**` 行 | 0 |

### 9.1 提交前后 `test:unit` 的差异（不是代码红）

`doc-anchor-relocation-identity` 的判据是 `git merge-base HEAD origin/main`。**未提交**时 `base == HEAD`、
没有判定面，它按设计硬红，报错原文：

> `base 与 HEAD 同一提交（git merge-base HEAD origin/main），本用例没有判定面却也不是 CI 浅克隆 ——
> 取 base 的逻辑有问题，不允许静默通过`

**提交后**复跑即 `fail 0`，`skipped` 由 1 变 2（那条自我保护的 skip 路径回到正常档）。
本条在派单里已被预先点名，不是本片引入的缺陷——两次读数都记在这里，**没有把"提交前红"改写成"一直绿"**。

两条 `⚠ I11·缺口本体（未修）` 是 `{ todo: … }` 用例（`tests/unit/i11-audio-mp3-wav-guard.test.mjs:191` 与
`tests/unit/i11-audio-mp3-wav-guard.test.mjs:206`，都带 `todo` 原因）。它们出现在 `✖ failing tests:`
标题下，但计入 `todo 2`、**不计入 `fail`**——两次读数的 `fail` 分别是 1（提交前，只有 identity 闸门）
与 0（提交后）。

---

## 10 需裁定点

1. **其余 27 条高档判据要不要一起迁？** 本片按派单只修 ⑧。`tests/unit/moderation-live-adapter.test.mjs:883`
   与 `tests/unit/moderation-approval-flag.test.mjs:530` 扫的是**同一批文件**、同一个风险，
   优先级最高；`tests/unit/doc-anchors-guard.test.mjs:357` 守的是闸门自检，次之。**是否开后续片、一次多片还是逐片**，请裁定。
2. **`tools/contract-status-core.mjs` 要不要反向收敛到本模块？** 它的 `withoutComments()` 已经做对了同类事，
   但有两点差异：① 它是单条正则、没有可复用的行号接口；② 它把模板插值里的代码当字符串（对它的用途无碍）。
   收敛会动到台账扫描面（**别人的钉子面**），本片**不做**。
3. **形状D 要不要加闸门？** `**/*.ts` 写在块注释里会让注释提前闭合——`tsc` 已经会红（`npm run lint` 覆盖），
   是否需要一条更直白的判据（"源码里不得出现被提前闭合的块注释"）请裁定。本片按「不加功能」不做。
4. **⑨ 的夹具依赖具体文本**：断言 2 依赖 `SANCTIONED_SOURCE` 里出现 `services/api/src`。将来若有人改写夹具，
   这条会跟着失效（不会假绿，只会变弱）。是否需要一个更结构化的判别式，请裁定。
5. **本片是否需要更新 `docs/architecture/acceptance-map.md`**：⑧ 的判据强度变了但**断言数没变**、也没放宽。
   本片按「不动别人的钉子面」没有改 acceptance-map；如果口径要求每次判据变更都登记，请裁定补登。

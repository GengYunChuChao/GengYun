# R90 路 #1112 断言审计页：永真恒等式、重复数据点与「变异 C 按正文复现不出来」

| 项 | 值 |
| --- | --- |
| 取证时刻 | `2026-11-09`（本机 Node 自带 `node --test`，PowerShell 5.1） |
| 仓库 / 基线 | `GengYunChuChao/GengYun`，`origin/main` = `bc9c28d82d632c8255ac1905a23de66cc1a3988e` |
| 被审对象 | `#1112`（已合入 `ed423956`；正文已冻结，本页只做补正，不改正文） |
| 本 PR 改动面 | A 档：只改 `tests/unit/miniprogram-voice-hardening.test.mjs` + 新增本页；`miniprogram/**` 0 行 |
| 结论 | `tests/unit/miniprogram-voice-hardening.test.mjs:903` 恒等式断言删除并换成端口侧**身份**判据；`srcs`/`handles` 同一数据点去重一条；正文的变异 C 写法与行数口径在本页更正 |

本页处理两件事：一是**写进证据但测不出东西**（`tests/unit/miniprogram-voice-hardening.test.mjs:903` 那条恒等式断言在假修法下仍绿），二是**写进证据但复现不出来**（正文的变异 C 写法逐字照抄是 no-op，「918 → 959 行」两种口径混用）。

## 0 取证口径

- 页内每条 `path:line` 都是先用 `node -e "readFileSync(p,'utf8').split('\n')"` 逐行读出原文再写下的。产品代码行号按 `bc9c28d8` 的树（本 PR 未动 `miniprogram/**`，行号未漂移）；测试文件行号按**本 PR 之后**的树。
- 只跑两个文件：`tests/unit/miniprogram-voice-hardening.test.mjs`、`tests/unit/miniprogram-voice-playback.test.mjs`；没有跑全量 `npm run test:unit`。
- 变异一律直接改工作区里的 `miniprogram/utils/audio-playback.js`，跑完 `git checkout --` 还原，再核 `git status --porcelain` 只剩测试文件一行。
- 探针读取的是**端口侧**计数：`created` / `destroyed` / `live` 与句柄存活表 `aliveHandles`（`isDestroyed()` 为假者，按 create 顺序）。

## 1 缺陷一：那条断言是 spy 自己的记账恒等式

### 1.1 代数证明：不变量恒为零

记 `I = created − destroyed − live`。spy 只在四个地方动这三个计数：

| 位置 | 代码 | 对 `I` 的作用 |
| --- | --- | --- |
| `tests/unit/miniprogram-voice-hardening.test.mjs:52` | `const state = { created: 0, destroyed: 0, live: 0, plays: 0, srcs: [] };` | 初值 `I = 0` |
| `tests/unit/miniprogram-voice-hardening.test.mjs:58` | `state.created += 1;` | `I += 1` |
| `tests/unit/miniprogram-voice-hardening.test.mjs:59` | `state.live += 1;` | `I -= 1` |

`create()` 一次：`+1 − 0 − 1 = 0`，`I` 不变。

| 位置 | 代码 | 对 `I` 的作用 |
| --- | --- | --- |
| `tests/unit/miniprogram-voice-hardening.test.mjs:92` | `state.destroyed += 1;` | `I -= 1` |
| `tests/unit/miniprogram-voice-hardening.test.mjs:93` | `state.live -= 1;` | `I += 1` |

`destroy()` 一次：`0 − 1 + 1 = 0`，`I` 不变。另有 `tests/unit/miniprogram-voice-hardening.test.mjs:90` 的 `if (destroyed) return;` 保证同一句柄不重复记账——这条只保护 `live` 不为负，与恒等式无关。

端口只在这四行上动 `created` / `destroyed` / `live`，而且**每处都把 `I` 的增量写成 0**。所以对任何执行序列（无论控制器调了几次 `create`、几次 `destroy`、调用顺序如何），`I ≡ 0` 恒成立。于是

```js
assert.equal(state.created - state.destroyed, state.live, '计数自洽：created - destroyed === live');
```

断的是「spy 的加减法没写错」，不是「`replay()` 先彻底停掉再从头播」。要让这条为假，只能改 spy 自己的两行赋值——那时测的就不再是被测代码了。

### 1.2 判别力的判据

一条断言有判别力 ⇔ 存在**对被测代码**的变异使它为假。对 `I` 不存在这样的变异：控制器只能决定「调了几次 `create` / `destroy`」，而任何次数组合代进 `I` 都是 0。这就是它必须被删掉的正式理由。

## 2 现场：假修法（变异 B）下恒等式仍然成立

变异 B = 不调 `stop()`，直接 `generation += 1; index = 0; listened = false; failure = null; autoInitiated = false; startSegment(); return { ok: true }`，即「看起来从头播、实际旧句柄没销毁」。

探针读数（一次播放 + 一次重播后读端口）：

```
{"ok": true, "code": null, "created": 2, "destroyed": 0, "live": 2, "createdMinusDestroyed": 2, "algebraHolds": true, "aliveHandles": ["a.mp3", "a.mp3"]}
```

| 项 | 读数 | 含义 |
| --- | --- | --- |
| `created` / `destroyed` / `live` | 2 / 0 / 2 | 两个句柄同时存活，正是叠音 |
| `created - destroyed === live` | `2 - 0 === 2` 成立 | 原 `tests/unit/miniprogram-voice-hardening.test.mjs:903` 在 B 下**绿**，零判别力 |
| `algebraHolds` | `true` | 与 §1 的代数结论一致 |
| `aliveHandles` | `["a.mp3","a.mp3"]` | 端口侧真实可观察：两个句柄都没销毁 |

同一份 B 打在改后的测试上：`tests 31 / pass 29 / fail 2`，红在 `tests/unit/miniprogram-voice-hardening.test.mjs:901`（`0 !== 1`，`destroyed`）与 `tests/unit/miniprogram-voice-hardening.test.mjs:940`（`2 !== 1`，`live`）。

## 3 处置一：删恒等式，换端口侧的**身份**判据

### 3.1 为什么不写「端口侧未销毁句柄数 === 1」

「未销毁句柄数」= `handles.filter((h) => h.isDestroyed() === false).length`，而 `state.live` 恰好就是 `created − destroyed` 的净数、且 `destroy` 只在 `tests/unit/miniprogram-voice-hardening.test.mjs:91` 置真时才记账 ⇒ 两者**数值恒等**。新增这条等于把 `tests/unit/miniprogram-voice-hardening.test.mjs:902` 的 `live === 1` 换个写法再说一遍，正好是 §4 要修的那类「同一数据点断言两次」。

真正缺的维度不是「几个」，而是「**哪一个**」：只销毁新句柄、把旧句柄留着，计数照样 1 / 1 自洽，但两端同时出声。

### 3.2 实际写进去的判据

`tests/unit/miniprogram-voice-hardening.test.mjs:906`：

```js
assert.deepEqual(handles.map((handle) => handle.isDestroyed()), [true, false], '端口侧：旧句柄已销毁、重播新建的句柄存活');
```

`handles` 按 create 顺序追加（`tests/unit/miniprogram-voice-hardening.test.mjs:101` 的 `handles.push(handle)`），所以 `[true, false]` 精确表达「第 1 个（原播）句柄已销毁、第 2 个（重播）句柄存活」；「只销毁新句柄」的假实现会得到 `[false, true]`，计数判据看不出来，这条会红。原恒等式那 1 行换成了 4 行：`tests/unit/miniprogram-voice-hardening.test.mjs:903` 起的注释说明为什么删（永真、无判别力）。

多段用例里本来就有同族判据（`tests/unit/miniprogram-voice-hardening.test.mjs:943-947` 的 `['a.mp3']` deepEqual）；缺的正是单段这一侧，所以这是补齐而不是重复造轮子。

### 3.3 它有牙：静音 `destroyed`/`live` 两条后，身份判据在 B 下转红（`tests/unit/miniprogram-voice-hardening.test.mjs:906`）

B 下执行在 `tests/unit/miniprogram-voice-hardening.test.mjs:901` 就停了，跑不到 `:906`，所以单独取证：临时把 `:901` 与 `:902` 注掉、再打同一份 B：

```
ℹ tests 31 / pass 29 / fail 2
AssertionError: 端口侧：旧句柄已销毁、重播新建的句柄存活
    at .../tests/unit/miniprogram-voice-hardening.test.mjs:906:10
AssertionError: 重播后只允许一个活动句柄
    at .../tests/unit/miniprogram-voice-hardening.test.mjs:940:10
```

即 B 下端口真实状态是 `[false, false] ≠ [true, false]`。取证后按备份还原测试文件（SHA-256 与原文件一致），`git checkout --` 还原产品代码。

## 4 处置二：`srcs` / `handles` 同一数据点，与内部字段断言

改前（`bc9c28d8` 的树）多段用例里：第 927 行读 `snapshot().index === 0`、第 928 行读 `state.srcs` 末项 `=== 'a.mp3'`、第 929 行读 `handles` 末项 `.src === 'a.mp3'`、第 930 行读 `snapshot().total === 2`。第 928 与 929 说的是同一件事（末次 create 的 src），只是分别从 `srcs` 数组和 `handles` 数组取。

| 处置 | 现状 | 理由 |
| --- | --- | --- |
| 保留 `srcs` 末项 | `tests/unit/miniprogram-voice-hardening.test.mjs:933` | 冻结正文的变异 C 红行就是它（改前第 928 行），保留它让本页与正文的交叉引用继续对得上；而且 `srcs` 的采集（`tests/unit/miniprogram-voice-hardening.test.mjs:52` 初始化、`:60` 追加）若删掉这条就成了死代码 |
| 删除 `handles` 末项 | 改前第 929 行已删 | 与上一条同一数据点；`handles` 仍被 `tests/unit/miniprogram-voice-hardening.test.mjs:906` 与 `tests/unit/miniprogram-voice-hardening.test.mjs:943-947` 使用，不会变死代码 |
| 内部字段加注保留 | `tests/unit/miniprogram-voice-hardening.test.mjs:937`（`snapshot().index`）、`:938`（`snapshot().total`） | 端口侧没有等价物（段号与计划长度只在 `snapshot()` 里露出），删掉会丢「接着播会停在 idx=1 / total 掉到 1」的辅助读数；`tests/unit/miniprogram-voice-hardening.test.mjs:934` 起三条注释明写它们读的是**状态机内部字段**、主判据在上面那条端口侧 `src` 断言 |

## 5 缺陷三：正文的变异 C 写法逐字照抄是 no-op

正文（已冻结）写：「改成『接着播』而不是『从头』—— `play(plan.slice(index), { auto: false })`」。

### 5.1 为什么它等价于原实现

`replay()` 在 `miniprogram/utils/audio-playback.js:396`；`miniprogram/utils/audio-playback.js:400` 先 `stop()`；`stop()` 在 `miniprogram/utils/audio-playback.js:383`，其中 `miniprogram/utils/audio-playback.js:389` 是 `teardown(false)`；`teardown` 在 `miniprogram/utils/audio-playback.js:356`，其中 `miniprogram/utils/audio-playback.js:358` 是 `index = 0`。

⇒ 求值 `play(plan.slice(index), …)` 时 `index` 已被归零，`slice(0)` 就是整个计划，与原 `miniprogram/utils/audio-playback.js:401` 的 `play(plan.slice(), { auto: false })` 行为完全相同。

### 5.2 实测：两种写法、两种结论

改法一（正文逐字照抄），`git diff` 只有一行：

```
-    return play(plan.slice(), { auto: false })
+    return play(plan.slice(index), { auto: false })
```

`node --test tests/unit/miniprogram-voice-hardening.test.mjs` → **EXIT=0，`tests 31 / pass 31 / fail 0`**。⇒ 照正文复现只能得出「变异无效」的假结论。

改法二（真 C：**先**存 `at`，再 slice），共 2 增 2 删：

```js
// replay()（miniprogram/utils/audio-playback.js:396）内，stop 之前取段号
const at = index
if (state === 'playing' || state === 'loading' || state === 'paused') stop()
return play(plan.slice(at), { auto: false })
```

→ **EXIT=1，`tests 31 / pass 30 / fail 1`**，只有多段用例红、单段用例仍绿：

```
AssertionError: 重播的新句柄 src 必须是 plan[0]（端口侧：按 create 顺序采集）
'b.mp3' !== 'a.mp3'
    at .../tests/unit/miniprogram-voice-hardening.test.mjs:933:10
```

要点：`at` 必须在 `stop()` **之前**取；放在之后拿到的永远是 0，变异就退回 no-op。

## 6 缺陷四：正文「918 → 959 行」混用了两种口径

| 口径 | 改前（`ed423956^`） | 改后（`ed423956`） | 本 PR 后 |
| --- | --- | --- | --- |
| `wc -l`（末尾换行计行） | 918 行 | 958 行 | 966 行 |
| `split('\n').length`（末尾换行多出一个空尾项） | 919 行 | 959 行 | 967 行 |

正文的「918 → 959」是**旧值的 `wc -l` 配新值的 `split('\n')`**，两种口径混用。成对写法只有两种：`wc -l` 918 → 958，或 `split('\n')` 919 → 959。两种口径的增量一致（+40 行），与正文自述的「+43 / −3」互洽（43 − 3 = 40）。

## 7 变异自证汇总

| 变异 | 对 `miniprogram/utils/audio-playback.js` 的改动 | numstat | 探针 | EXIT | tests / pass / fail | 首个红行 |
| --- | --- | --- | --- | --- | --- | --- |
| 无（基线） | 无 | 无 | `created 2 / destroyed 1 / live 1`，`aliveHandles ["a.mp3"]` | 0 | 31 / 31 / 0 | 无 |
| A 删 `stop()` | 删掉 `miniprogram/utils/audio-playback.js:400` 整行 | 0 增 1 删 | 未取（红行已足够定位） | 1 | 31 / 29 / 2 | `tests/unit/miniprogram-voice-hardening.test.mjs:897`（`replayed.ok === true`），次 `:927` |
| B 假修法 | 不 `stop()`，直接 `index = 0` + `startSegment()` + `return { ok: true }` | 7 增 3 删 | `created 2 / destroyed 0 / live 2`，`aliveHandles ["a.mp3","a.mp3"]` | 1 | 31 / 29 / 2 | `tests/unit/miniprogram-voice-hardening.test.mjs:901`（`0 !== 1`），次 `:940` |
| C 真（先存 `at`） | 插 `const at = index`（在 `stop()` 前）+ 第 401 行改 `slice(at)` | 2 增 2 删 | 与基线同 | 1 | 31 / 30 / 1 | `tests/unit/miniprogram-voice-hardening.test.mjs:933`（`'b.mp3' !== 'a.mp3'`） |
| C 正文照抄 | 第 401 行改 `slice(index)` | 1 增 1 删 | 与基线同 | 0 | 31 / 31 / 0 | 无（no-op） |

每次变异后都 `git checkout -- miniprogram/utils/audio-playback.js` 还原；三次还原后 `git status --porcelain` 均为 1 行（只有 ` M tests/unit/miniprogram-voice-hardening.test.mjs`），说明产品代码没有残留改动。

## 8 复现命令

```
node --test tests/unit/miniprogram-voice-hardening.test.mjs
node --test tests/unit/miniprogram-voice-playback.test.mjs
```

变异与探针脚本是临时的（改工作区文件 → 跑 → `git checkout --` 还原），不随本 PR 提交；上表已给出每一行的改动位置、numstat、探针读数与红行，按行改即可重放。

## 9 未削弱的既有判据

| 判据 | 位置 | 处置 |
| --- | --- | --- |
| `destroyed === 1` | `tests/unit/miniprogram-voice-hardening.test.mjs:901` | 原样保留（B 的首个红行就是它） |
| `live === 1`（重播后 / 停止后重播 / 多段重播） | `tests/unit/miniprogram-voice-hardening.test.mjs:902`、`:912`、`:924`、`:940` | 原样保留 |
| 身份 deepEqual `['a.mp3']` | `tests/unit/miniprogram-voice-hardening.test.mjs:943-947` | 原样保留 |
| `created === 2` / `destroyed === 2` / `created === 3` | `tests/unit/miniprogram-voice-hardening.test.mjs:898`、`:941`、`:942` | 原样保留 |

单段用例的目视核对也做了：改后 `tests 31 / pass 31 / fail 0`，两处 `replayed.ok === true`（`tests/unit/miniprogram-voice-hardening.test.mjs:897`、`:927`）在 A 下如预期转红。

## 10 本页不声称什么

- **不声称替代真机验收**：本页只有 Node 单测与端口探针读数，没有真机、没有真实基础库播放器、没有真实音频链路；「不叠音」在真机上的表现不由本页证明。
- **不声称 `#23` 可关**：`#23` 的关闭依据仍是真机与集成验收；本页只证明「测试判据不再永真、变异描述可复现」。
- 不声称 `#1112` 正文已更正：正文已冻结，本页是补正，不是改写。
- 不声称产品行为有任何变化：`miniprogram/**` 0 行改动，本 PR 只有测试与这一页。
- 不声称三种变异穷尽了 `replay()` 的失败模式：只覆盖「不先停」「假从头」「接着播」三条。
- 不声称本页的行数口径适用于其它文档：只针对 `#1112` 正文里那两处数字。

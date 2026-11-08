# 小程序语音「重播」语义取证（#23 / GY-I13 播放球）（2026-11-09）

- **文档性质**：证据页。只登记**可复核的读数**与**边界**；**不代监工判定**、**不代关 `#23`**，页内不出现「通过／达标」结论。
- **取证时刻**：2026-11-09 02:39–02:52 +08:00（本机 Windows，PowerShell 7；`git fetch origin main` 于 02:39 实测）。
- **基线**：`origin/main = af39bfe657b965042dec81a6c397509d04166a5d`（**写作时的 main**；本页所有行号都按这个树读）。
- **被取证对象**：三次提交——`#1101` `8515518473476dfe596e85d8f045decaaca5fa5a`（改代码）、`#1112` `ed423956dfeec4b23fe7bbad9948a96ff3d5a560`（加断言）、`#1118` `bef0ba63eb80b30f0855b4fbbfa4f4256caa79e4`（换掉无判别力断言）。
- **本页建立提交**：只新增本文件（`docs/verification/`）；**0 行产品代码改动、0 行测试代码改动**。因此「被取证代码的 SHA」= 基线 `af39bfe6`，「本页所在提交」是另一个 SHA，两者不可混用。
- **复跑入口**：单测 `node --test tests/unit/miniprogram-voice-hardening.test.mjs`；变异读数用仓外探针（逐字复制同一份假端口，见 §2 末、§5 末），**探针不入库**。
- **一句话结论**：`#1101` 在 `replay()` 里插了一行「先 `stop()`」（`miniprogram/utils/audio-playback.js:400`），`#1112`／`#1118` 在注入端口侧钉住「旧句柄已销毁、重播只留一个新句柄、新句柄的 src 回到 `plan[0]`」；本机读数单段 `created 2 / destroyed 1 / live 1`、多段 `created 3 / destroyed 2 / live 1` 且 `srcs` 末项 `a.mp3`。**真机项（不叠音、从头发起、后台切回）未取得**，故 `#23` 不可关。

## 0 本页不声称什么

1. **不声称 `#23` 已完成、不声称可关 `#23`**。`#23` 的提交证据里有真机项（`docs/initial-issues.md:392`：「Android／iOS真机音频及交互记录」），本页**一条真机读数都没有**（§4）。
2. **不声称单测绿 = 真机通过**。本页全部判据跑在**注入的假端口**上：无 `wx`、无真实音频、无时钟（§3）；假端口能把「句柄计数」钉住，钉不住「耳朵听到几声」。
3. **不声称重播在所有机型／所有音频格式下等价**。假端口没有解码、时长、采样率、平台中断；真机侧的差异（扬声器／蓝牙／系统静音／来电打断）本页 0 覆盖。
4. **不声称 `#1112`／`#1118` 的 PR 正文与代码逐字一致**。本页只读 git 对象与工作树文本；PR 正文里若写 `play(plan.slice(index))`，那是 no-op——`stop()` 走 `teardown(false)`，`teardown` 在 `miniprogram/utils/audio-playback.js:358` 已把 `index` 归零，`play()` 在 `miniprogram/utils/audio-playback.js:343` 又归零一次——但本页不复核 PR 正文措辞。
5. **不声称变异读数穷尽**。本页自己只做两处变异（M1 删先停、M2 接着播），另引用前一轮三处（A/B/C，见 §2 末表）；未做的变异一律写「未取」。
6. **不代监工判定**。本页的「红／绿」只描述**断言在某个变异下会不会失败**，不等于「验收条款成立」。

## 1 代码面：`replay()` 到底改了什么

### 1.1 提交面（`git show --stat` 原文）

```
$ git show --stat --oneline 85155184
85155184 fix(miniprogram): 重播时先停止当前播放再从头重播 (#1101)
 miniprogram/utils/audio-playback.js             |  2 ++
 tests/unit/miniprogram-voice-hardening.test.mjs | 13 +++++++------
 2 files changed, 9 insertions(+), 6 deletions(-)

$ git show --stat --oneline ed423956
ed423956 test(miniprogram): 加固 replay 不叠音断言 (#1112)
 tests/unit/miniprogram-voice-hardening.test.mjs | 46 +++++++++++++++++++++++--
 1 file changed, 43 insertions(+), 3 deletions(-)

$ git show --stat --oneline bef0ba63
bef0ba63 test(miniprogram): 修正 #1112 断言判别力 (#1118)
 .../gy-r90-i1112-assertion-audit-20261109.md       | 204 +++++++++++++++++++++
 tests/unit/miniprogram-voice-hardening.test.mjs    |  24 ++-
 2 files changed, 220 insertions(+), 8 deletions(-)
```

⇒ 产品代码只被 `#1101` 动过，且只有 **2 行**（1 行注释 + 1 行代码）；`#1112`／`#1118` 是**纯测试/文档**，不改变行为。

### 1.2 `replay()` 逐行（`miniprogram/utils/audio-playback.js`，全文 446 行）

| 行锚 | 原文 | 性质 |
| --- | --- | --- |
| `miniprogram/utils/audio-playback.js:396` | `function replay() {` | 实质行（函数头） |
| `miniprogram/utils/audio-playback.js:397` | `if (released) return { ok: false, code: 'RELEASED' }` | 实质行（守卫） |
| `miniprogram/utils/audio-playback.js:398` | `if (plan.length === 0) return { ok: false, code: 'NOTHING_TO_REPLAY' }` | 实质行（守卫） |
| `miniprogram/utils/audio-playback.js:400` | `if (state === 'playing' \|\| state === 'loading' \|\| state === 'paused') stop()` | 实质行（**`#1101` 唯一新增的代码行**） |
| `miniprogram/utils/audio-playback.js:401` | `return play(plan.slice(), { auto: false })` | 实质行（改动前既有） |

`#1101` 的 hunk 里另有一行同义注释（就在先停分支正上方）：本页**不把注释行当锚点**，故不上表；它的意思已由本节链条复述。

`git show 85155184 -- miniprogram/utils/audio-playback.js` 的 hunk 只有这两行（`+` 注释、`+` 先停），上下文是 `miniprogram/utils/audio-playback.js:396-401`。⇒ 「修复」= **在既有 `play()` 入口之前插入一次 `stop()`**，没有新增分支、没有改 `play()`。

### 1.3 为什么 `stop()` 能让 `play()` 不再短路

| 行锚 | 原文 | 作用 |
| --- | --- | --- |
| `miniprogram/utils/audio-playback.js:383` | `function stop() {` | `stop()` 入口 |
| `miniprogram/utils/audio-playback.js:385-387` | `if (handle === null && state !== 'loading' && state !== 'playing' && state !== 'paused') { return { ok: false, code: 'NOT_PLAYING' } }` | 空转守卫（无句柄且非活动态才拒绝） |
| `miniprogram/utils/audio-playback.js:388` | `generation += 1` | 代次自增（作废在飞回调） |
| `miniprogram/utils/audio-playback.js:389` | `teardown(false)` | 销毁句柄（`miniprogram/utils/audio-playback.js:357` 的 `destroyHandle()`），保留计划 |
| `miniprogram/utils/audio-playback.js:391` | `setState('stopped')` | **状态离开 `playing`/`loading`** |
| `miniprogram/utils/audio-playback.js:392` | `return { ok: true }` | 返回 |
| `miniprogram/utils/audio-playback.js:336` | `if ((state === 'playing' \|\| state === 'loading') && samePlan(plan, next)) {` | `ALREADY_PLAYING` 的**唯一**判据 |
| `miniprogram/utils/audio-playback.js:338` | `return { ok: false, code: 'ALREADY_PLAYING' }` | 短路返回 |

链条：`replay()` 在 `miniprogram/utils/audio-playback.js:400` 调 `stop()`；`stop()` 在 `miniprogram/utils/audio-playback.js:391` 把播放状态置为 `'stopped'`；于是回到 `miniprogram/utils/audio-playback.js:401` 的 `play(plan.slice(), …)` 时，`miniprogram/utils/audio-playback.js:336` 的条件 `state === 'playing' || state === 'loading'` 已为假 ⇒ 不短路，正常走 `miniprogram/utils/audio-playback.js:340-348`（`teardown(false)`、`plan = next`、`index = 0`、`startSegment()`）。
`samePlan(plan, next)` 仍然为真（`plan.slice()` 内容相同），但**它只是 `&&` 的右项**，左项为假即整条不成立——`#1101` 在 `miniprogram/utils/audio-playback.js:400` 正上方新增的那行注释就是这句话（本页不拿纯注释行当锚点，见 §1.2 表的「性质」列）。

### 1.4 一个实测出来的反向结论：`'paused'` 那一支不是新增判据

`miniprogram/utils/audio-playback.js:336` 只认 `playing` / `loading`，**不认 `paused`**。所以修复前在 `paused` 态点重播本来就不会被短路。本机实测（同一假端口，基线 vs 删掉 `miniprogram/utils/audio-playback.js:400` 的 M1 副本）：

| 变体 | 步骤 | 读数 |
| --- | --- | --- |
| 基线 | `play('a.mp3')` → `pause()` → `replay()` | `{ok:true}`；`created 2 / destroyed 1 / live 1`；`srcs ['a.mp3','a.mp3']`；`stateAfter 'playing'` |
| M1（无先停） | 同上 | `{ok:true}`；`created 2 / destroyed 1 / live 1`；`srcs ['a.mp3','a.mp3']`；`stateAfter 'playing'` |

⇒ `miniprogram/utils/audio-playback.js:400` 里的 `|| state === 'paused'` 只让**三种活动态统一走「先停后播」**，不改变 `paused` 的可播结果；`#1101` 真正修的是 `playing` / `loading` 两态。
附带代价（读码可核，未测 UI 影响）：`playing`/`paused` 下重播会多发布一次 `setState('stopped')`（`miniprogram/utils/audio-playback.js:391`），随后 `startSegment()` 再进 `loading`（`miniprogram/utils/audio-playback.js:288-320`），即一次重播多一次状态跳变。

## 2 判据面：每条断言为什么能红、本机读数

前置：`node --test tests/unit/miniprogram-voice-hardening.test.mjs` 在本机 **EXIT=0**，`tests 31 / pass 31 / fail 0 / cancelled 0 / skipped 0 / todo 0`（duration_ms 171.0522）。下面「本机读数」来自仓外探针（同一份假端口逐字复制，读同名计数），**不是**逐断言的插桩输出。
「M1」= 删掉 `miniprogram/utils/audio-playback.js:400` 整行（= 修复前的 `replay()`）；「M2」= 把 `miniprogram/utils/audio-playback.js:400` 换成 `const at = index`、`miniprogram/utils/audio-playback.js:401` 换成 `play(plan.slice(at), { auto: false })`（= 「接着播」的假修法）。

### 2.1 单段用例（`tests/unit/miniprogram-voice-hardening.test.mjs:890-913`）

| 断言（锚点） | 断言内容 | 为什么能红 | 本机读数 |
| --- | --- | --- | --- |
| `tests/unit/miniprogram-voice-hardening.test.mjs:894` | `snapshot().state === 'playing'` | 前置条件：`play()` 之后状态机必须真在 `playing`。红法：`play()` 被拒（`SOURCE_UNAVAILABLE` 等）。**不是**重播判据 | 三变体均 `'playing'` ⇒ 不红（本片未构造红法） |
| `tests/unit/miniprogram-voice-hardening.test.mjs:897` | `replayed.ok === true` | M1／M2 单段都返回 `{ok:false, code:'ALREADY_PLAYING'}` ⇒ 红 | 基线 `{ok:true}`；M1／M2 `ALREADY_PLAYING` |
| `tests/unit/miniprogram-voice-hardening.test.mjs:898` | `state.created === 2` | M1／M2 `created 1` ⇒ 红。但**单独看无判别力**：假修法「不销毁旧句柄、直接从第 0 段再建一个」下 `created` 同样为 2（前页 B 变异读数 `created 2 / destroyed 0 / live 2`，首个红行落在 `tests/unit/miniprogram-voice-hardening.test.mjs:901`，本条仍绿） | 基线 2；M1／M2 1 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:901` | `state.destroyed === 1` | M1／M2 `destroyed 0`（旧句柄没销毁）⇒ 红 | 基线 1；M1／M2 0 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:902` | `state.live === 1` | **本片两处变异都不红**（M1／M2 单段 `live` 仍为 1）。能红的机制只有「不销毁旧句柄、直接再建一个」（前页 B：`live 2`） | 三变体均 1 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:906` | `assert.deepEqual(handles.map((h) => h.isDestroyed()), [true, false], …)` | 端口侧直接读句柄存活：M1／M2 得到 `[false]`／`[false]` ⇒ 数组长度与元素都不等 ⇒ 红。**这是 `#1118` 换掉恒等式后新增的主判据** | 基线 `[true,false]`；M1／M2 `[false]` |
| `tests/unit/miniprogram-voice-hardening.test.mjs:907` | `snapshot().hasHandle === true` | 红法：重播后手里没有句柄（`stop()` 之后不重建） | 三变体均 `true` ⇒ 不红（本片未构造） |
| `tests/unit/miniprogram-voice-hardening.test.mjs:908` | `isListened() === false` | 红法：`replay()` 把「已听取」置真 | 三变体均 `false` ⇒ 不红（`play()` 在 `miniprogram/utils/audio-playback.js:344` 置 `listened = false`） |
| `tests/unit/miniprogram-voice-hardening.test.mjs:910-912` | `stop()` 后再 `replay().ok === true` 且 `live === 1` | 红法：先停分支把「停止态重播」也破坏掉（例如 `stop()` 清空 `plan`） | 三变体均 `ok true` / `live 1` ⇒ 不红（M1 里 `state='stopped'` 本来就不短路，故这条对「有无先停」不敏感） |

### 2.2 多段用例（`tests/unit/miniprogram-voice-hardening.test.mjs:915-949`）

| 断言（锚点） | 断言内容 | 为什么能红 | 本机读数 |
| --- | --- | --- | --- |
| `tests/unit/miniprogram-voice-hardening.test.mjs:919` | `snapshot().index === 0` | 前置：`play(['a.mp3','b.mp3'])` 后停在第 0 段 | 三变体均 0 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:922` | `snapshot().index === 1` | 前置：`deliver('ended')` 推进到第 2 段 | 三变体均 1 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:923` | `handles[1].src === 'b.mp3'` | 前置：第 2 段的句柄确实是 `b.mp3` | 三变体均 `'b.mp3'` |
| `tests/unit/miniprogram-voice-hardening.test.mjs:924` | `state.live === 1` | 前置：换段时旧句柄已销毁 | 三变体均 1 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:927` | `replayed.ok === true` | M1 返回 `ALREADY_PLAYING` ⇒ 红；M2 返回 `{ok:true}` ⇒ 绿 | 基线 `{ok:true}`；M1 `ALREADY_PLAYING`；M2 `{ok:true}` |
| `tests/unit/miniprogram-voice-hardening.test.mjs:933` | `state.srcs[state.srcs.length - 1] === 'a.mp3'` | 端口侧「最后一次 create 的源」：M1 末项 `b.mp3`、M2 末项 `b.mp3` ⇒ 都红。**本用例唯一有「从头 vs 接着播」判别力的断言** | 基线 `a.mp3`（`srcs ['a.mp3','b.mp3','a.mp3']`）；M1 `b.mp3`；M2 `b.mp3`（`srcs ['a.mp3','b.mp3','b.mp3']`） |
| `tests/unit/miniprogram-voice-hardening.test.mjs:937` | `snapshot().index === 0` | M1 停在 1 ⇒ 红；**M2 仍绿**（`play()` 自己把 `index` 归零，见 `miniprogram/utils/audio-playback.js:343`）⇒ 对「接着播」**无判别力** | 基线 0；M1 1；M2 0 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:938` | `snapshot().total === 2` | M2 计划被截成 1 段（`plan.slice(at)`）⇒ 红；M1 计划未动 ⇒ 绿 | 基线 2；M1 2；M2 1 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:940` | `state.live === 1` | **本片两处变异都不红**（M1／M2 均为 1） | 三变体均 1 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:941` | `state.destroyed === 2` | M1 `destroyed 1`（没停 b 段）⇒ 红；M2 `2` ⇒ 绿 | 基线 2；M1 1；M2 2 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:942` | `state.created === 3` | M1 `created 2`（少建一次）⇒ 红；M2 `3` ⇒ 绿 | 基线 3；M1 2；M2 3 |
| `tests/unit/miniprogram-voice-hardening.test.mjs:943-947` | `handles.filter((h) => h.isDestroyed() === false).map((h) => h.src)` deepEqual `['a.mp3']` | 端口侧「活下来的是哪一个」：M1／M2 都只剩 `['b.mp3']` ⇒ 红 | 基线 `['a.mp3']`；M1／M2 `['b.mp3']` |
| `tests/unit/miniprogram-voice-hardening.test.mjs:948` | `isListened() === false` | 红法：中段重播记「已听取」 | 三变体均 `false` ⇒ 不红 |

### 2.3 判据面的净读数

- **有判别力（本片实测能红）**：单段用例里 `replayed.ok`／`state.created`／`state.destroyed`／`isDestroyed()` 数组四条（对「有没有先停」）；多段用例里 `replayed.ok`／`state.srcs` 末项／`state.destroyed`／`state.created`／存活句柄 `src` 数组五条（对「有没有先停」）；多段用例里 `state.srcs` 末项／`snapshot().total`／存活句柄 `src` 数组三条（对「接着播」假修法）。逐行锚与原文见 §2.1、§2.2 两表。
- **无判别力或本片未取**：单段的 `state.live`／`snapshot().hasHandle`／`isListened()`／「停止后再重播」，多段的 `state.live`／`isListened()`——这六条在 M1／M2 下都不红，本页没有构造出让它们红的变异；多段的 `snapshot().index` 对「接着播」不红（见 §3.3）。
- 该文件此前的一版还在断言 `created - destroyed === live`（`#1112` 引入），`#1118` 把它换成了端口侧 `isDestroyed()` 数组判据（`tests/unit/miniprogram-voice-hardening.test.mjs:906`）——理由见 §3.2。

## 3 已知边界：这套判据钉不到哪儿

### 3.1 假端口假在哪（实测，按文件逐个确认）

| 维度 | 实际情况 | 依据 |
| --- | --- | --- |
| 没有 `wx` | 全文件 0 处 `wx.`（grep 计数 0）；控制器只接收注入的 `player` 端口对象 | `tests/unit/miniprogram-voice-hardening.test.mjs:50-111`（`spyPlayer()`） |
| 没有 `wx.createInnerAudioContext` 桩 | 真端口在 `miniprogram/utils/inner-audio-port.js:203` 调用 `wx.createInnerAudioContext()`；**本用例不经过它** | 全仓 `createInnerAudioContext` 只出现在真端口与该文件外的另一套用例 `tests/unit/miniprogram-voice-playback.test.mjs:682` |
| 没有时钟 | `miniprogram/utils/audio-playback.js` 内 `setTimeout`/`setInterval`/`clearTimeout`/`Promise`/`Date.now`/`Math.random` **0 命中** ⇒ 模块本来就没有计时器可假 | grep 实测 |
| 事件是同步投递的 | 假端口 `play()` 直接 `emitActive('play')`（`tests/unit/miniprogram-voice-hardening.test.mjs:83`），`stop()` 只在 `emitStopOnStop === true` 时才回发（`tests/unit/miniprogram-voice-hardening.test.mjs:87`） | 同上 |
| 迟到的平台回调 | `deliver()` 遍历**追加式** `log` 直投包装器，**故意绕过退订与 `destroyed`**（`tests/unit/miniprogram-voice-hardening.test.mjs:97-99`），模拟「回调还在飞行」 | 同上 |
| `stop()` 没有副作用 | 假端口的 `stop()` 只按开关发事件，不改变任何状态（`tests/unit/miniprogram-voice-hardening.test.mjs:86-88`）⇒ **「声音真的停了」在端口侧不可观测** | 同上 |
| 没有音频 | 无解码、无时长、无播放位置、无音量；`ended` 由测试手动 `deliver('ended')`（`tests/unit/miniprogram-voice-hardening.test.mjs:921`） | 同上 |
| 句柄计数自洽 | `create()` 里 `state.created += 1; state.live += 1`（`tests/unit/miniprogram-voice-hardening.test.mjs:58-59`），`destroy()` 里 `state.destroyed += 1; state.live -= 1`（`tests/unit/miniprogram-voice-hardening.test.mjs:92-93`） | 同上 |

⇒ 这层替身能证「**句柄记账**与**创建顺序**」，证不了「**出声**」。

### 3.2 为什么 `created - destroyed === live` 没有判别力

- 它在假端口的 `create()`／`destroy()` 里**被同步加减**（`tests/unit/miniprogram-voice-hardening.test.mjs:58-59`、`tests/unit/miniprogram-voice-hardening.test.mjs:92-93`），只要句柄走过端口就恒成立 ⇒ 任何假修法下都绿。
- `#1112` 曾把它写成断言（`assert.equal(state.created - state.destroyed, state.live, '计数自洽：created - destroyed === live')`），`#1118` 删除并替换为 `tests/unit/miniprogram-voice-hardening.test.mjs:906` 的 `isDestroyed()` 数组判据（`git show bef0ba63 -- tests/unit/miniprogram-voice-hardening.test.mjs` 可见该 `-`／`+`）。
- 本页复查：该文件**现在没有**这条断言——grep `created - destroyed` 在 `tests/unit/miniprogram-voice-hardening.test.mjs` 里只命中一处解释性注释，不再有 `assert.*`。§2 表里 `state.live === 1` 的两条（`tests/unit/miniprogram-voice-hardening.test.mjs:902`、`tests/unit/miniprogram-voice-hardening.test.mjs:940`）仍保留，但它们在 M1／M2 下都不红——只有「不销毁旧句柄直接再建」才会红（前页 B：`live 2`）。

### 3.3 多段用例的 `index === 0` 只证「回到第一段」

- `snapshot().index` / `snapshot().total` 是**状态机内部字段**，不是端口可观察行为（`tests/unit/miniprogram-voice-hardening.test.mjs:933-938` 这段把主判据说成端口侧 `src`、把 `index`/`total` 降为「辅助读数」；本页实测 M2 印证：`index 0` 仍绿、`total 1` 才红）。
- 端口侧能证的只有两件：**最后一次 `create()` 的 `src` 是 `plan[0]`**（`tests/unit/miniprogram-voice-hardening.test.mjs:933`）、**存活句柄只有一个且其 `src` 是 `plan[0]`**（`tests/unit/miniprogram-voice-hardening.test.mjs:943-947`）。
- 这三条都**证不了「从头播放」的听感**：没有播放位置、没有时长、没有真实 `currentTime`；也**证不了「不叠音」的听感**：只证句柄计数与存活集合，不证音频输出。真实端口的中断/路由（`miniprogram/utils/inner-audio-port.js:201` 的 `bindInterruptionOnce()`）在本用例完全没被覆盖。

## 4 不在本页的手动／真机项（全部**未取得**）

| 项 | 依据 | 本页状态 | 为什么本片不能代 |
| --- | --- | --- | --- |
| 真机重播不叠音（听感：两次播报不同时出声） | `docs/initial-issues.md:392`（提交证据「Android／iOS真机音频及交互记录」） | **未取得** | 假端口无音频输出，只能数句柄 |
| 真机从头发起（听感：从第 1 段第 0 秒开始） | 同上 | **未取得** | 无播放位置、无时长 |
| 后台切回后的行为（切后台/回前台不重复播报、不留残留） | `docs/initial-issues.md:380`（「页面退出取消任务、释放音频和监听，避免重复播报和后台残留」） | **未取得** | 假端口无 `appHide`/`appShow`、无中断事件 |
| 30 段普通话播报样例准确 | `docs/initial-issues.md:385` | **未取得**（属真实音频样例项） | 本页 0 音频 |

⇒ 这四项都必须由**真机 + 真实音频**取得；本页不提供、也不推断它们的结论。

## 5 闸门读数（实跑，逐字）

基线 `origin/main = af39bfe657b965042dec81a6c397509d04166a5d`；六道闸门在**本页所在提交**上按下列顺序实跑，全部 `EXIT=0`。

| # | 闸门命令 | 读数（逐字，EXIT 均 0） | 结论 |
| --- | --- | --- | --- |
| 1 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 尾行 `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）` | `EXIT=0` |
| 2 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 用例 1（本提交的位移恒等）打出 `# SKIP: 本次文档提交只有新增行，没有锚点位移面（1 个纯新增 hunk）`；汇总 `ℹ tests 37` / `ℹ pass 36` / `ℹ fail 0` / `ℹ skipped 1` | `EXIT=0` |
| 3 | `node tools/verify-contract-status.mjs` | 尾行 `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` | `EXIT=0` |
| 4 | `npm run test:docs` | 尾行 `PASS: 识别 5 页 / 跳过 361 页（扫描面 366 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` | `EXIT=0` |
| 5 | `node tools/verify-g-drill-readings.mjs --check` | 尾行 `✓ 八条判据全过：workflows 15 / jobs 29 / 演练 21 条 / 测试文件 608（glob 合计 578）；生长型读数按**下界**判（--tolerant-growth），其中 8 条滞后已逐行打印` | `EXIT=0` |
| 6 | `git merge-tree --write-tree --name-only origin/main HEAD` | 只输出一行内容派生的树对象 SHA，无冲突行 | `EXIT=0` |

闸门 1 的 verification 面另有逐字读数（同一次运行）：`不在区间 44、UNDECLARED 252、配成对 1271`（基线册 `tools/doc-anchors-symbol-coverage-verification-baseline.json` 记 `44 / 265 / 1051`）——该面只判「不在区间」上升；把本页**单独**扫描得到 `SYMBOL-COVERAGE-VERIFICATION: 可判 4 条——OK 4、符号不在区间 0`。

- 闸门 2 必须**排在 commit 之后**：纯新增 docs 提交在提交前会让「base 与 HEAD 同一提交」这一条自证判红，提交后应显式 SKIP。
- 闸门 2／6 的逐字输出里都带**由本页内容派生的 SHA**（2 是 `base..HEAD` 提交对，6 是树对象）。把它们抄进本页会改变本页内容、从而改变它们自己，故本表只登记**不变部分**（2 的 SKIP 判据文本 + 用例计数、6 的「无冲突行」形态）；带 SHA 的原文留在 PR 正文与对话记录里，可按上列命令复跑复现。
- 本页是纯新增文档：`doc-anchor-relocation-identity` 的「旧锚点搬迁」面不适用；锚点闸门真正会判红的只有 BROKEN／OUT_OF_RANGE／SUSPECT（区间无实质行）／BARE_ORPHAN（裸 `:NNN`）／ANCHOR-COUNT 下降，本页**零裸锚点**、每条锚点都落在实质行上。
- 影子闸门（**不在上面六道之内**，且本页基线树上还没有这个工具）：`origin/main` 在本页写作之后前进到 `7835bfe5ef5ff4a72ecaefacd5a49091214466e8`（`#1129` 引入 `tools/verify-verification-comment-anchors.mjs`，专判 `docs/verification/**` 里锚在**注释行**上的引用）。把本页放进那棵树实跑该工具：`VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 1422、基线 1422、基线外新增 0、可收紧 0`，`EXIT=0`。本页先前有 1 条锚在注释区间上（测试文件 `tests/unit/miniprogram-voice-hardening.test.mjs` 的解释性注释），已按该闸门要求改锚到 `miniprogram/utils/audio-playback.js:358` 与 `miniprogram/utils/audio-playback.js:343` 两处实质行。

## 6 边界

1. 本页**只给证据**：行锚、提交、断言、变异读数、闸门读数。**判定权在监工**，本页不写「通过／达标／可关」。
2. 与本页同口径的既有判断：`#1101` 钉的是「小程序播放态」，本身不是任何产品 AC 的读数（`docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:327`）⇒ 本页同样**不把** `replay()` 的单测绿当作 `#23` 的 AC 读数。
3. `#23` 的时延／容量面另有取证（`docs/verification/gy-i23-latency-capacity-local-20261020.md:3` 自述「条件受限／不关闭 #23」）；本页不重复、不覆盖那一面。
4. 若本页任一读数与后续 `main` 不符，以**回读代码树**为准：本页所有行号只对基线 `af39bfe657b965042dec81a6c397509d04166a5d` 有效。

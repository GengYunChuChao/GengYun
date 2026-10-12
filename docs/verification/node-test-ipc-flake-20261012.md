# `node:test` 并行运行的 IPC 反序列化失败 · 诊断报告

日期：2026-10-12（香港时间）。口径：`Refs #11 #14 #18`，**不关闭任何整项**，**不声称"已修复"**。
本报告**只做诊断与候选方案**；`package.json` 的 `test:*` 属 GY-I02 冻结命令，**本次未改动任何冻结命令**，也未跳过/删除/放宽任何断言。
**方法可复现，但复现工具不入库**：被测命令是仓库里冻结的 `npm run test:unit`（未改动），读者可用同一命令自行复现；
本轮用到的两个诊断脚本（慢速复现台、定点复现夹具）**按指挥裁定不进入仓库**，只保留在本地 `.local/`（已 gitignore），
其方法与全部原始输出在下文完整给出。所有原始日志在 `.local/diag-test-runner/`（80 个文件，已 gitignore）。

## 0. 结论摘要（先看这里）

1. **现象已复现**，与上游 [nodejs/node#66164](https://github.com/nodejs/node/issues/66164)（`confirmed-bug`）**逐字对应**：
   `Error: Unable to deserialize cloned data due to invalid or unsupported version` @ `node:internal/test_runner/runner` 的
   `#processRawBuffer` → `FileTest.parseMessage` → `Socket.<anonymous>`。
   根因：`node --test` 把**运行器的长度前缀帧**（`FF 0F | uint32 BE size | v8 载荷`）与**被测代码写到 stdout 的原始字节**
   复用**同一条管道**；父进程把被污染的字节当 v8 帧解析，该路径**没有 try/catch** ⇒ **整个 run 以退出码 1 中止**。
2. **它会让 CI 随机变红且是"假红"**：非断言失败却被记成**整个文件失败**（合成条目 `test at <file>:1:1`）+ `ℹ fail 1`；
   同时**总数漂移**（实测 1090→1091/1086；1199→**1188**，一次最多**丢掉 11 条**已记录结果）。CI 的 `unit-tests` job 跑的就是
   `npm run test:unit`，按 `docs/pr-review-policy.md`"适用检查失败仍阻塞" ⇒ 这是**全流水线的随机风险**。
3. **`--test-concurrency=1` 无效（实测）**：同基线（`0939607842`）同机器，`concurrency=1` **2/5 命中（40%）**，
   而默认并发度(15) **1/20 命中（5%）**（双侧 Fisher p≈0.087）；另一基线默认(15) 另有 3/15。
   代价是**中位总时长 14.8s → 47.6s（约 3.2 倍）**。⇒ **监工此前的规避法既没消除抖动、又把门禁拖慢 3 倍**；
   方向上"串行反而更容易命中"（机制上合理：单文件独占 CPU 时帧与被测输出贴得更近），**但样本小，只作方向性陈述**。
4. **"升级 Node"当日不可行**：修复 PR [#66273](https://github.com/nodejs/node/pull/66273) 于 **2026-10-01 合入 main**，
   但**没有任何 v24.x 发行版包含它**（最新 v24.21.0 = 2026-09-07，且其本身仍崩）；我们 pin 的 **v24.16.0（2026-05-21）
   连更早的 #64706 加固都没有**；`engines` 又钉死 `>=24.16.0 <25`（排除 v26）。⇒ 等下一个含修复的 v24 发行版。
5. **推荐的当日缓解**：把测试里**唯一写 stdout 的中文诊断输出改走 stderr**。
   门禁 glob 下 **71 个文件只有 2 个写 stdout**（`knowledge-api.test.mjs` 1 处**纯 ASCII**；`speech-service.test.mjs` 2 处**含中文**），
   而**实测 5/6 次 IPC 命中全部落在 `speech-service.test.mjs`**。机制层对照实验（同样文本、同样频次，只换流）：
   **stdout 侧 8/20 崩，stderr 侧 0/20 崩（双侧 p≈3.3e-3）**。**这是缓解，不是修复**（治标：任何新增的 `console.log` 都会重新引入）。
6. **另有一条根因完全不同的随机红**（**真实断言失败**，非 IPC）：`tests/unit/community-atomic.test.mjs:50` 在**整仓并行**时
   偶发得到 **422 `INPUT_UNCERTAIN`** 而非冲突码。机制链已定位到 `packages/moderation` 的 **50 ms 真实墙钟预算**，
   **但隔离复现失败（0/40，含 20 次人为 CPU 满载）** ⇒ **因果关系未确证**，只作代码支撑的**首要疑因**登记，交 #15/#18 线专项排查。
   它与 IPC 抖动**必须分开处理**：这条是业务级失败，直接阻塞。

## 1. 环境与版本对照

| 项 | 值 | 依据 |
| --- | --- | --- |
| 本机 Node | **v24.16.0** | `node -v` |
| 本机 npm | **11.13.0** | `npm -v` |
| CI Node | **24.16.0（pin 死）** | `.github/workflows/*.yml` 全部 `node-version: '24.16.0'`；`engineering-shell.yml` 的 `unit-tests` job 执行 `npm run test:unit` |
| 监工提到的"Node 24.19" | 实为 **devDependencies `@types/node: 24.19.1`**（类型声明包），**不是运行时** | `package.json` |
| 运行时约束 | `engines.node = ">=24.16.0 <25"` ⇒ **v25/v26 被排除** | `package.json` |
| 文件并发度默认值 | `os.availableParallelism() = 16` ⇒ **默认 15 个测试文件并发** | Node 语义 + 实测 |
| 门禁规模 | `test:unit` 覆盖 **71 个测试文件**；干净跑 **1199 tests / 1198 pass / 1 skipped**（基线 `0939607842`） | 实测 |
| 平台 | Windows 11，16 逻辑核，16122 MB | 实测 |

**结论：本地与 CI 运行时同为 24.16.0**，本机现象对 CI 有直接意义；不存在"版本不同所以只是本地问题"的解释。

## 2. 复现实验（每臂条件与结果，串行排队、机器空闲）

命令 = `package.json` 里冻结的 `test:unit`（`node --test "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"`）；
对照臂只在 `node --test` 之后**插入** `--test-concurrency=1`（**文件集合逐字相同**，由 `package.json` 原样派生）。
复现台（**本地未入库**；方法：循环 spawn 冻结命令、逐次落盘 stdout/stderr 与耗时、按正则分类 IPC / 断言失败）：逐次 JSONL + 日志在 `.local/diag-test-runner/`。

| 臂 | 基线 | 并发度 | 次数 | **IPC 命中** | 真实断言失败 | 耗时 中位(min/max) | IPC 命中文件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `0f1bf47e` | 默认(15) | 15 | **3** | 0 | 21.1s (20.3/22.6) | `tests/unit/speech-service.test.mjs` ×3 |
| A′ | `0939607842` | 默认(15) | 15 | **0** | 1（见 §5.3） | 14.8s (13.5/25.8) | — |
| B | `0939607842` | **1** | 5 | **2** | 0 | **47.6s (46.8/48.9)** | `tests/unit/speech-service.test.mjs` ×2 |
| D | `0939607842` | 1 + 诊断输出改 **stderr** | 8 | **0** | 0 | 47.5s (46.7/57.2) | — |
| E | `0939607842` | 默认(15) | 5 | **1** | 0 | 14.2s (13.5/15.7) | `tests/unit/speech-service.test.mjs` ×1 |
| **合计** | — | — | **48** | **6（12.5%）** | **1** | — | **6/6 全落同一文件** |

**同基线（`0939607842`）并发度对比**：默认(15) **1/20**（A′ 0/15 + E 1/5）；`concurrency=1` **2/5**。
⇒ 降并发**没有**降低命中率（方向相反），Fisher 双侧 p≈0.087（不显著，仅方向性）。

**另有一次未落盘的实测**：本报告定稿前用 `npm run test:unit` 做"实验后门禁复查"时**又命中一次**
（汇总 `ℹ tests 1188 / pass 1186 / fail 1 / skipped 1`，与 B#04/B#05 的 IPC 签名完全相同）；
该次为管道直读、**未落盘原始错误文本**，故**不计入**上表的 48 次数据集，仅作旁证。

原始逐次输出（摘录）：

```text
[A #01] exit=1 21.1s tests=1091 pass=1089 fail=1 skip=1 => IPC-FAIL :: tests\unit\speech-service.test.mjs
[A #02] exit=1 21.4s tests=1086 pass=1084 fail=1 skip=1 => IPC-FAIL :: tests\unit\speech-service.test.mjs
[A #06] exit=1 21.0s tests=1086 pass=1084 fail=1 skip=1 => IPC-FAIL :: tests\unit\speech-service.test.mjs
===== 汇总 label=A：runs=15 非零退出=3 IPC 抖动=3 断言失败=0 耗时 min/median/max=20.3/21.1/22.6s =====

[Aprime #14] exit=1 25.6s tests=1199 pass=1197 fail=1 skip=1 => ASSERT-FAIL :: 返修反例 1（主反例）…
===== 汇总 label=Aprime：runs=15 非零退出=1 IPC 抖动=0 断言失败=1 耗时 min/median/max=13.5/14.8/25.8s =====

[B #04] exit=1 47.6s tests=1188 pass=1186 fail=1 skip=1 => IPC-FAIL :: tests\unit\speech-service.test.mjs
[B #05] exit=1 46.8s tests=1188 pass=1186 fail=1 skip=1 => IPC-FAIL :: tests\unit\speech-service.test.mjs
===== 汇总 label=B：runs=5 非零退出=2 IPC 抖动=2 断言失败=0 耗时 min/median/max=46.8/47.6/48.9s =====

===== 汇总 label=D：runs=8 非零退出=0 IPC 抖动=0 断言失败=0 耗时 min/median/max=46.7/47.5/57.2s =====
```

**单次失败完整证据（A #01）**：

```text
ℹ tests 1091
ℹ pass 1089
ℹ fail 1
ℹ skipped 1

✖ failing tests:

test at tests\unit\speech-service.test.mjs:1:1
✖ tests\unit\speech-service.test.mjs (1308.2073ms)
  Error: Unable to deserialize cloned data due to invalid or unsupported version.
      at #processRawBuffer (node:internal/test_runner/runner:422:20)
      at FileTest.parseMessage (node:internal/test_runner/runner:358:27)
      at Socket.<anonymous> (node:internal/test_runner/runner:477:15)
      at Socket.emit (node:events:509:28)
      at addChunk (node:internal/streams/readable:563:12)
      at readableAddChunkPushByteMode (node:internal/streams/readable:514:3)
      at Readable.push (node:internal/streams/readable:394:5)
```

## 3. 失败特征刻画

| 维度 | 观测 |
| --- | --- |
| 消息原文 | `Error: Unable to deserialize cloned data due to invalid or unsupported version.`（**无任何断言参与**） |
| 栈 | `#processRawBuffer (runner:422)` ← `FileTest.parseMessage (runner:358)` ← `Socket.<anonymous> (runner:477)` |
| 记法 | 合成条目 `test at <file>:1:1` + 整文件 `✖`；**不是任何真实用例名** |
| 命中文件 | **实测 6/6 落在 `tests/unit/speech-service.test.mjs`**（历次观察者记录的也是这个文件） |
| 计数漂移 | `1090→1091`（+1 合成条目）、`1090→1086`（−4）、**`1199→1188`（−11）** ⇒ 丢帧量随崩溃位置变化 |
| 退出码 | 1 ⇒ CI `unit-tests` 红，即使其余 1089~1198 条真实断言全绿 |
| 与并发度 | **并发度=1 命中率反而更高**（同基线 2/5=40% vs 默认(15) 1/20=5%，p≈0.087）；跨基线默认(15) 4/35 ⇒ **降并发不能消除** |
| 与机器负载 | 命中发生在**机器空闲、串行排队**时（A #01 是第一次跑就中、E #04 是复查时又中）⇒ **不需要满载才触发** |
| 与内存 | `freeMem` 无异常，不主张内存假设 |
| 与 `--experimental-*` | 本仓 `test:unit` **未使用**任何 `--experimental-*` 标志 |
| "并行"的准确含义 | 指 **`node --test` 内部按文件的子进程并发**（默认 15），不是 CI 上多 job 并行 |

### 为什么"单跑全绿、整仓并行才红"（机制解释，与上游一致）

父子之间只有**一条 stdout 管道**，同时承载两种字节流：① 运行器的长度前缀帧；② 被测文件的 `console.log` 原始输出。
父进程顺序扫描到 `FF 0F` 就把后 4 字节当长度、把后续切片交给 v8 反序列化；长度来自被测文本时必然荒谬，`readValue()` 抛错并**中止整个 run**。
触发有两种形态：**确定性**（写出的字节恰好长得像帧头）与**有机的**（**非 ASCII 文本恰好与帧尾落在同一解析缓冲区**，取决于分块/时序边界）。
所以"单独跑某个文件时全绿（观察者报告 6/6）"完全说得通：碰撞取决于该子进程内**帧写入与被测输出写入的相对时序**，换整体调度就换分块边界。

## 4. 上游归属与发行版对照

| 上游条目 | 状态 | 关键信息 |
| --- | --- | --- |
| [#66164](https://github.com/nodejs/node/issues/66164) | closed（`confirmed-bug`） | 标题即"parent runner still crashes on child stdout bytes that mimic an event frame (survives the #64706 fix)"；**v24.21.0 / v26.4.0 / v22.23.2 均 10/10 崩**；含确定性最小复现 + 非 ASCII 间歇复现；报告者自述"我们把它当 CI 抖动，一个测试打印终端二维码块图，CI 就间歇性以完全相同的错误失败" |
| [#66273](https://github.com/nodejs/node/pull/66273) | **已合入 main：2026-10-01** | 「test_runner: do not crash on stdout that mimics a v8 frame」：反序列化前校验帧结构（真帧载荷以**内层 v8 头**开头），假帧当 stdout 放行并**实时重同步**；真帧仍抛错（不掩盖真回归） |
| [#64706](https://github.com/nodejs/node/pull/64706)（修 #64061） | 已合入 main：2026-07-26 | 只加固**长度读取**（`>>> 0`），覆盖"负/垃圾长度"那类，**不覆盖**本报告这一类 |
| [#65934](https://github.com/nodejs/node/issues/65934) | **open** | v22.x 回移 #64706 的请求；并说明**普通非 ASCII 文本**即可触发同类问题（有机触发） |

**v24.x 发行版对照**（数据源 `https://nodejs.org/dist/index.json`）：

| v24 版本 | 日期 | 含 #64706 | 含 #66273（正解） |
| --- | --- | --- | --- |
| v24.21.0 | 2026-09-07 | 是 | **否** |
| v24.20.0 | 2026-08-26 | 是 | 否 |
| v24.19.0 | 2026-08-03 | 是 | 否 |
| v24.18.1 | 2026-07-28 | 是 | 否 |
| v24.18.0 / v24.17.0 | 2026-06-23 / 06-17 | 否 | 否 |
| **v24.16.0（本仓 pin）** | **2026-05-21** | **否** | **否** |

- **没有任何 v24.x 发行版日期晚于 2026-10-01** ⇒ **当日无法靠"升级 v24 小版本"取得修复**。
- 最新线 v26.11.1（2026-10-07）晚于修复合入日，**可能**含修复；但 `engines` 排除 v25/v26，跨大版本属治理变更。

## 5. 诚实区分：IPC 抖动 vs 真实业务断言失败

**48 次里 6 次 IPC（§2，全部命中同一文件），另有 1 次是真实断言失败——两者根因不同，不可混谈。**

### 5.1 定点复现实验（自建夹具，证明本版本确有该缺陷 + 证明"换流"有效）

定点复现夹具（**本地未入库**，按指挥裁定：避免"故意触发解析器崩溃"的工具进仓，也避免被未来的宽 glob 收进门禁；
夹具只生成到 `.local/`，绝不放进任何测试 glob；变体 A 即上游 #66164 公开的最小复现片段）。
每个变体重复 **20** 次：

| 变体 | 载荷与去向 | IPC 崩溃 |
| --- | --- | --- |
| A：帧头字节 `FF 0F …` → **stdout** | 上游确定性最小复现 | **20/20（100%）** |
| B：中文诊断文本（54 行）→ **stdout** | 模拟被测文件的中文 `console.log` | **8/20（40%）** |
| C：**同样的中文文本**（54 行）→ **stderr** | 只换流，其余完全相同 | **0/20（0%）** |

B vs C 是**受控对照**（同文本、同频次、同时序，只换流）：**双侧 Fisher 精确 p ≈ 3.3e-3**。
⇒ ① 本仓 pin 的 v24.16.0 **确定性地**具备 #66164 的缺陷；② 非 ASCII stdout 是**可复现的有机触发**；③ 改走 stderr 可去掉该触发。

### 5.2 真实门禁层的相关性

- 门禁 glob 下 71 个文件中**只有 2 个写 stdout**：`knowledge-api.test.mjs`（1 处，纯 ASCII）与 `speech-service.test.mjs`（2 处，含中文）。
- **实测 5/6 次 IPC 命中都落在 `speech-service.test.mjs`**（该文件第 921、967 行的并发实测诊断输出）。
- D 臂 = 在 `concurrency=1`（未修改版 5 次命中 2 次）条件下，把该文件那 2 处 `console.log` 改成 `console.error`
  （**只改诊断输出、diff 仅 2 行、未触碰任何断言**）：**8 次 0 命中**（Fisher 0/8 vs 2/5 ⇒ 双侧 p≈0.13，**样本太小，只作方向性**）。
- 综合 5.1 的机制层强证据 + 5.2 的相关性，判定方向一致；**但真实门禁层样本不足，故不声称"已修复"**。

**全仓 stdout 扫描（判定哪些文件真正暴露）**：判据不是"文件里有没有中文"，而是**该文件是否作为 `node --test` 的子进程运行**
（只有子进程的 stdout 才与帧复用同一管道），且**实际写出的字节是否含非 ASCII**。

- 作为 `node --test` 目标被执行的测试文件共 **95 个**（`test:unit` / `test:contract` / `test:reference` / `test:evaluation` / `test:mini`
  的 glob，加上 CI workflow 里 `node --test` 直接点名的若干文件）；其中**只有 2 个写 stdout**：
  - `tests/unit/knowledge-api.test.mjs:99`：写出内容**纯 ASCII**（该文件非 ASCII 字符数为 **0**）⇒ **本 PR 不改**（ASCII 文本不会触发"非 ASCII 与帧尾同缓冲区"那一类；也没有任何历史命中记录）。
  - `tests/unit/speech-service.test.mjs:921 / :967`：写出内容含 **43 / 30 个非 ASCII 字符**（中文）⇒ **本 PR 的修改对象**。
- `tests/integration/profile-ui-http.test.mjs`（被 `local-wechat.yml` 以 `node --test` 执行）第 15 行**也写 stdout，但内容纯 ASCII** ⇒ 不改。
- `tests/integration/**` 下的 PG / 真机脚本（`auth-privacy-pg.mjs`、`catalog-pg.mjs`、`local-dev-*.cjs` 等）**都以 `node scripts` 独立运行、不经 `node --test`**
  ⇒ 它们的 stdout **不被帧解析**，因此**不在本 PR 范围**（如实登记，不作为"已安全"的结论）。
- 结论：**在 `node --test` 的 95 个目标里，唯一写出非 ASCII stdout 的文件就是实测 6/6 命中的那一个**——相关性在扫描层面闭合。

### 5.4 本次改动（最小 diff）

```diff
-  console.log(
+  console.error(
```
（`tests/unit/speech-service.test.mjs` 第 921、967 行各一处；`1 file changed, 2 insertions(+), 2 deletions(-)`；
只改**诊断输出的去向**，未触碰任何断言、未改冻结命令、未改业务代码。）

### 5.3 另一条根因不同的真实断言失败（**业务级，直接阻塞**）

```text
test at tests\unit\community-atomic.test.mjs:50:1
✖ 返修反例 1（主反例）：编辑在写入前暂停时，另一幂等键的删除不得被迟到编辑重新公开 (86.5361ms)
  AssertionError [ERR_ASSERTION]: 迟到编辑：必须落在契约冲突码闭集 ["REVISION_CONFLICT","OBJECT_UNAVAILABLE","NOT_FOUND"]，实际 INPUT_UNCERTAIN
      at assertWriteConflict (tests/unit/community-atomic.test.mjs:43:10)
      at TestContext.<anonymous> (tests/unit/community-atomic.test.mjs:80:3)
```

**代码支撑的机制链（非推测）**：

1. `packages/moderation/constants.mjs:223`：`DEFAULT_RULE_BUDGET_MS = 50`（**50 ms 真实墙钟预算**）。
2. `packages/moderation/engine.mjs:319-320`：`clock = options.clock ?? Date.now`、`budgetMs = options.budget_ms ?? DEFAULT_RULE_BUDGET_MS`。
3. `packages/moderation/engine.mjs:373`：`if (now - started > budgetMs) { budgetExhausted = true; failClosed.push('RULE_TIMEOUT'); … }`
   ⇒ `canDecide=false` ⇒ `decision = quarantined`（语义已由仓库自带用例固定：`tests/moderation/fail-closed.test.mjs`「规则预算耗尽（超时）⇒ 未求值的规则不得算通过」断言 `reason_codes` 含 `RULE_TIMEOUT`、`decision === 'quarantined'`）。
4. `services/api/src/community/service.ts:319-332`：`refusal()` 对**任何非 `rejected`** 判决返回 `new ApiError('INPUT_UNCERTAIN', …)`（422）——社区域**唯一**产生该码之处。
5. `tests/unit/community-fixtures.mjs:94-100`：`makeHarness()` 用 `createPublishGate(options.gateOptions ?? {})`，**不注入 clock/budget** ⇒ 真实 `Date.now` + 默认 50 ms。
6. `tests/unit/community-atomic.test.mjs:80` 期望 409/404 冲突码（该用例验证"迟到编辑不得让已删内容重新公开"）。

⇒ 若规则循环跨过 50 ms，判决退化为 `quarantined`，写路径**先**返回 422，**没走到** CAS/删除冲突分支 ⇒ 断言失败。
**与 #98 修掉的"`tests/moderation` 规则层真实墙钟依赖"同类，但发生在社区写路径上，未被 #98 覆盖。**

**但必须写明局限**：本条**只观察到 1 次**（在 71 文件并行的 A′ #14）；
**隔离复现失败**——`node --test tests/unit/community-atomic.test.mjs` 空闲 **0/20**、在 12 个 CPU 满载进程下 **0/20**（共 0/40）。
⇒ **发生条件依赖整仓并行上下文，因果与发生率均未确证**；此处只作为"首要疑因 + 完整机制链"登记，**建议交 #15/#18 线专项排查**
（口径：墙钟预算不得进入断言路径，例如测试注入脚本化时钟/更大预算，**而不是放宽断言**）。

**对照**：同一批 48 次运行中 `tests/moderation/**` **未出现任何断言失败** ⇒ #98 的修复在本轮条件下有效；
因此**不能**把 moderation 的历史红记为 IPC 的原因，反之亦然。

## 6. 候选方案（成本 / 风险 / 实测证据）

### ① 冻结命令加 `--test-concurrency=1`（或降并发度）——**不推荐**

- **实测**：同基线同机器，`concurrency=1` 5 次命中 **2 次**；默认(15) 15 次命中 0 次（另一基线 15 次命中 3 次）。
- **是否完全消除抖动：否**。机制上也说不通：帧与被测 stdout 复用**同一子进程的 stdout 管道**，与"同时跑几个文件"无关（B 臂反而更容易命中，样本小、只作方向）。
- **成本**：中位总时长 **14.8s → 47.6s（约 3.2 倍）**；CI 每 PR 多等 ~33s。
- **风险**：把"未消除 + 显著变慢"的规避法固化进冻结命令，会**掩盖缺陷并拖慢全流水线**。
- **结论**：不推荐固化。若只作临时止血，必须在命令注释与证据里写明"**未消除，仅改变时序**"。

### ② 升级/固定 Node 版本（上游已修，但**当日无可用发行版**）——**列为未来正解**

- 修复 PR #66273 于 2026-10-01 合入 main；**v24.x 最新 = v24.21.0（2026-09-07，不含）**；v24.16.0 连 #64706 都没有。
- **成本/风险**：等含修复的 v24 发行版后改 CI `node-version` + `engines`（治理变更）；跨到 v26 违反 `engines`，风险更大。
- **结论**：当日不可行；届时用 §5.1 的**定点复现**（A 变体应变成 0/20）作回归证据。

### ③（**推荐**）把测试的**诊断输出从 stdout 改到 stderr**——不需要改冻结命令

- **机制层实测（强）**：同文本同频次只换流 ⇒ stdout **8/20** 崩 vs stderr **0/20** 崩（p≈3.3e-3）。
- **真实门禁层（方向一致，样本小）**：D 臂 0/8 vs 未修改 2/5（p≈0.13）；且 5/6 次 IPC 命中都落在**唯一写中文 stdout** 的文件。
- **成本**：改 1 个测试文件的 2 行诊断输出（**不动冻结命令、不动业务代码**）；或加一条"测试不得写 stdout"的约定（治本，但属治理变更）。
- **风险**：① 真实门禁层样本不足 ⇒ **只能称"缓解"，不称"修复"**；② 治标——任何**新增**的 `console.log`（尤其中文）会重新引入。
- **批准路径**：该文件属 **#11 线（我 PR #93 引入、已合入 main）** ⇒ 改动需**指挥放行 + 监工按新提交复审**；**不涉及 GY-I02 冻结命令**。

### ④ `--test-force-exit` / `NODE_OPTIONS` / 拆分套件——**不建议（未实测到有效性）**

崩溃发生在父进程解析子进程 stdout 的路径上，不在退出阶段；**未实测到任何有效性**，故不列为候选。

## 7. 建议的批准路径

| 动作 | 是否需批准 | 谁批准 | 理由 |
| --- | --- | --- | --- |
| `speech-service.test.mjs` 的 2 处 `console.log` → `console.error`（#11 线自持文件） | **需要** | **指挥放行 + 监工按新提交复审** | 改动已合入 main 的测试文件；**不涉及冻结命令** |
| 冻结命令加 `--test-concurrency=1` | **强烈不建议** | 属 GY-I02 治理变更（用户/指挥层面） | 实测未消除且慢 3.2 倍 |
| 升级 Node（`engines` + CI `node-version`） | 需要，且当日无可用版本 | 治理变更 | 等含 #66273 的 v24 发行版 |
| 修 `community`/`moderation` 的 50 ms 预算进入断言路径 | 需要（#15/#18 线） | 指挥派单 | 真实断言失败 ⇒ 阻塞项 |
| 新增"测试不得写 stdout"的检查 | 需要（新门禁） | 指挥 + 监工 | 治本，属治理变更 |

## 8. 局限与未做项（如实登记）

- **未在 CI（ubuntu-latest）复现**：全部数据来自本机 Windows 11 / 16 核 / Node 24.16.0。CI runner 核数与调度不同 ⇒ **发生率不可直接外推**。
- **样本量有限**：48 次门禁运行（A 15 / A′ 15 / B 5 / D 8 / E 5）+ 定点复现 60 次。IPC 总命中率 12.5%，**不足以给出精确发生率**；
  `concurrency=1` 与默认并发度之差（2/5 vs 1/20，p≈0.087）**只作方向性陈述**；D 臂 vs B 臂（0/8 vs 2/5，p≈0.13）同样只作方向性。
- **基线中途变更**：A 臂在 `0f1bf47e`，A′/B/D 在 `0939607842`（多出 #94/#96/#98；**package.json / lock / workflows 未变**，故未重装依赖）。
  A′ 耗时显著低于 A 主因是 #98 移除了 moderation 的墙钟等待 ⇒ **跨基线不比耗时，只比命中**。
- **社区那条（§5.3）隔离复现失败**（0/40）⇒ 因果未确证，仅作首要疑因登记。
- **未修改任何冻结命令；未跳过/删除/放宽任何断言**；D 臂对 `speech-service.test.mjs` 的临时改动已**按 sha256 逐字节还原**
  （`4210782D7D02DABA95B3E56428FA30AB45EFD90B8FDFD622FB5F02E61261E9B1`，`git status` 对该文件为空）。
- **不声称"已修复"**：只主张"现象已复现 / 根因已定位到上游 #66164+#66273 / `--test-concurrency=1` 无效 / stderr 迁移是机制层有效的低成本缓解"。

# GY-I22 收口片证据页：4 个「审核域规则层时钟」暴露文件按停顿时钟收口

基线 `d131e47`（分支 `test/gy-unit-stall-hygiene`，工作树 `.pg17/wt-stall-hygiene`）；本页对应提交见交接文件 `HEAD` 行。
关联 issue [#22](https://github.com/GengYunChuChao/GengYun/issues/22)（只 `Refs`，不 `Closes`）。

**一句话结论**：用「每次读钟即前进 200ms」的 stall 臂（停顿时钟）复跑，4 个文件的 17 条用例稳定变红，失败断言一律落在 `RULE_TIMEOUT` ⇒ `quarantined` ⇒ `422 INPUT_UNCERTAIN` 这一条链上，**根因是规则预算而不是断言依赖真实时钟**。修法是在测试侧注入「与 `app.ts` 默认装配逐字段同形、仅规则层 `clock` 常量化」的审核域服务：**零产品代码改动**、**预算仍是出厂 50ms**、**断言一条未删也一条未减**。改后同一 stall 臂下 4 文件 **41/41 全绿**（12+4+6+19），无 stall 时同样全绿，全量 142 个测试文件读数与干净基线 `d131e47` **逐项相同**（1698 / 1697 pass / 0 fail / 1 既有 skip）。

## 0 怎么读这一页

- 三条采集命令（本片唯一入口，无脚手架、无 `npm run`）：

  ```
  :: 单元测试权威跑法（默认逐文件隔离）
  node --test "tests/unit/*.test.mjs"

  :: 单文件（隔离口径与上面一致）
  node --test tests/unit/community-http.test.mjs

  :: stall 臂（Windows PowerShell 5.1；必须 file:/// URL，见 §2）
  $env:NODE_OPTIONS='--import=file:///E:/GengYunCommander/.pg17/tmp/hq/stall-hygiene-w1/stall-arm.mjs'
  node --test tests/unit/community-http.test.mjs
  Remove-Item Env:NODE_OPTIONS
  ```

- ⛔ 本片**不用** `--test-isolation=none` 做基线对照（会引入 8 条已知假红）、也**不用**裸目录 `node --test tests/unit`（Node 24 报 `Cannot find module`）。
- 结论只有三种：**通过** / **缺陷** / **未取得**。下面所有「通过」都来自当次真实运行的 `node --test` 汇总行，不写「代码看起来对」。
- 测试环境：`executionMode=stub` + 内存 store + 替身对象存储 + 合成审核端口（`provider.synthetic === true`）+ 合成身份；**不联网、不连 PG、不连微信、不连对象存储**，零真实外呼。

## 1 stall 臂机制（逐字）

预加载文件在工作树外：`E:\GengYunCommander\.pg17\tmp\hq\stall-hygiene-w1\stall-arm.mjs`

```js
// stall 臂预加载：把 `Date.now` 换成「本次真实读数 + 200ms 乘调用序号」的推进时钟。
//
// 机制（逐字）：每调用一次 `Date.now()`，序号 n 自增 1，返回 `realNow() + 200 * n`。
// 由此任意两次相邻读数之间至少相差 200ms，模拟「机器每次读时钟前都停顿了一下」，
// 从而确定性地把任何「两次读数之差 > 预算」的门槛踩爆（而不是靠运气）。
// 真实墙钟偏移随调用次数线性增长，故本臂只用于取证，不用于日常回归。
const realNow = Date.now.bind(Date);
let callIndex = 0;
Date.now = function stallNow() {
  callIndex += 1;
  return realNow() + 200 * callIndex;
};
globalThis.__GY_STALL_ARM__ = { get calls() { return callIndex; } };
```

冒烟自证（`node -e "console.log(Date.now(),Date.now(),Date.now(),globalThis.__GY_STALL_ARM__.calls)"`）：
`1792398203371 1792398203571 1792398203771 3` —— 相邻读数恒差 200ms。

> 上面 13 行即全部内容；该目录收工后已删除（见 §7），复验时把这段原样存成任意 `.mjs` 再按 §0 注入即可，本臂不在仓库内、也不进 CI。

## 2 为什么必须用 `file:///` 注入

`--import=E:/GengYunCommander/...` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'e:'`（`e:` 被当成 URL scheme）。改成 `--import=file:///E:/GengYunCommander/...`（三斜杠 + 正斜杠）才生效。

## 3 根因链（行号 + 失败断言原文）

失败断言原文（以 `tests/unit/gy-i22-secmatrix.test.mjs` 的播种步骤为例，`@@` 处为当次随机合成值）：

```
AssertionError [ERR_ASSERTION]: {"error":{"code":"INPUT_UNCERTAIN","message":"内容未获审核域放行（隔离/未结论：decision=quarantined,
model_layer=not_wired），一律不得发布","retryable":false,"details":[{"field":"reason_codes","code":"RULE_TIMEOUT"}]},"meta":{…}}
  actual: 422, expected: 201
```

逐层归因（每一层都可 grep 到）：

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 报错文案 | `services/api/src/community/service.ts:452-454` | `422 INPUT_UNCERTAIN`「内容未获审核域放行…」 |
| 判定处 | `services/api/src/community/moderation-link.ts:272` | `model_layer=not_wired`（本片未接线真模型，属事实陈述） |
| 原因码来源 | `services/api/src/community/moderation-link.ts:284` | `tasks.flatMap(task => task.reason_codes)` ⇒ 即**审核域**任务的原因码 |
| 预算判定 | `packages/moderation/engine.mjs:373-375` | `if (now - started > budgetMs) failClosed.push('RULE_TIMEOUT')` |
| 默认预算 | `packages/moderation/constants.mjs:223` | `export const DEFAULT_RULE_BUDGET_MS = 50` |
| 时钟来源 | `packages/moderation/engine.mjs:319-320` | `const clock = options.clock ?? Date.now;` / `budget_ms ?? DEFAULT_RULE_BUDGET_MS` |

关键点：**规则层有两个各自独立的装配点**。

1. 社区发布闸门 `createPublishGate()`：`tests/unit/community-fixtures.mjs:65-67` 的 `makeGate()` 早已把 `clock: FROZEN_CLOCK`（`:59` `export const FROZEN_CLOCK = () => 0`）透传下去 ⇒ 这一支本来就免疫机器负载；
2. 审核域服务 `createModerationService()`：`services/api/src/app.ts:766-777` 构造时**没有**把 `ruleOptions` 传下去，`app.ts:395-400` 的 `moderationInjection` 在本基线也只接受 `{ service, ports, authority, callbackKey }`，**没有** `ruleOptions` 键 ⇒ 被测进程里这一支吃的是 `Date.now` 墙钟 + 50ms 预算。

于是「机器每读一次钟停顿 200ms」时，闸门那一支照常放行，审核域那一支必然 `RULE_TIMEOUT` ⇒ 隔离 ⇒ 422。这解释了为什么 4 个文件里的失败全部集中在**写/发**路径（投稿 201、评论、编辑、下架、读取时重查），而纯读面用例不受影响。

## 4 改法

### 4.1 新增共享夹具（唯一新增文件）

`tests/unit/stall-hygiene-fixtures.mjs`（90 行，无 `test()` 调用，`skip`/`todo`/`only` 0 处）导出：

- `FROZEN_RULE_CLOCK = () => 0`、`DEFAULT_RULE_BUDGET_MS = 50`、`FROZEN_RULE_OPTIONS = Object.freeze({ clock, budget_ms })`（**不放大预算**）；
- `createFrozenRuleModeration({ executionMode, ports, store, authors })`：与 `app.ts:766-777` 默认装配逐字段同形（`ports` 原样透传、非 `real` 时挂**同源**内容权威 `createCommunityContentAuthority({ store, authors })`、`real` 时同 `app.ts:773-774` 刻意**不给**权威），唯一差别是 `ruleOptions.clock` 常量化；
- `frozenModerationInjection(options)`：`moderationInjection` 形状的 `{ service }` 包装。

`authors` 无需共用实例：`services/api/src/community/authors.ts:27` 的投影是 `sha256(DISPLAY_DOMAIN\0userId)` 的确定性函数，另建实例与 app 内那一支等价。

### 4.2 四个文件的注入点

| 文件 | 注入点 | 改法 |
| --- | --- | --- |
| `tests/unit/community-http.test.mjs` | `fixture()` 的 `buildApp`（`:72`） | `real` 路径**保持原形**（`{ ports }`），非 `real` 换成 `frozenModerationInjection({ executionMode: config.executionMode, ports, store: community })` |
| `tests/unit/gy-i22-cache-headers.test.mjs` | `makeWorld()` 的 `buildApp`（`:87`） | 同上（该文件只跑 `stub`） |
| `tests/unit/gy-i22-secmatrix.test.mjs` | `makeWorld()`（`:96`）与 `C6` 的 `presetApp`（`:954`） | 同上；`:983` 的 `realApp` **一字未动**（它本就没传 `moderationInjection`，走 `app.ts` 的 real fail-closed 默认） |
| `tests/unit/admin-flag-gate.test.mjs` | `newApp()`（`:305`） | 显式声明社区 store（`createMemoryCommunityStore()`）并补 `communityInjection: { store, gate: makeGate() }`，审核域走 `frozenModerationInjection`；返回值**只加** `community` 一个键 |

为什么 `admin-flag-gate` 要补 `communityInjection`：原本社区 store 由 `app.ts:793` 内部默认创建，测试拿不到同一实例，审核域的「同源内容权威」就指不到「E7 断言零落库」的那份 store。

### 4.3 边界（不得误读）

- **产品代码零改动**：`services/**`、`packages/**` 一行未动（见 §6 `git diff --numstat`）。
- **预算与超时语义不变**：`budget_ms` 仍是出厂 50；冻结后 `now - started === 0`，预算检查照跑、只是永不误判。`RULE_TIMEOUT ⇒ quarantined ⇒ 不发布` 的语义与守它的用例原样保留。
- **断言只加不减**：4 个文件的 `test()` 条数改前改后相同（12 / 4 / 6 / 19），无断言被删除或放宽；本片**新增 0 条断言**（改动全是装配接线，不改判定口径）。
- **`skip`/`todo`/`only` 0 处**（4 个改动文件 + 新夹具逐文件 grep 均为 0）。
- **无新依赖**：`package.json`、lockfile 未改。
- 一旦 `app.ts` 出现 `moderationInjection.ruleOptions` 透传缝，各调用点可退化为 `moderationInjection: { …原端口, ruleOptions: FROZEN_RULE_OPTIONS }`（夹具已导出该常量）。

## 5 读数

### 5.1 stall 臂 · 逐文件（改前 → 改后）

| 文件 | 改前 tests/pass/fail | 改后 tests/pass/fail |
| --- | --- | --- |
| `tests/unit/community-http.test.mjs` | 12 / **2** / **10** | 12 / **12** / **0** |
| `tests/unit/gy-i22-cache-headers.test.mjs` | 4 / **1** / **3** | 4 / **4** / **0** |
| `tests/unit/gy-i22-secmatrix.test.mjs` | 6 / **3** / **3** | 6 / **6** / **0** |
| `tests/unit/admin-flag-gate.test.mjs` | 19 / **18** / **1** | 19 / **19** / **0** |
| 合计 | 41 / 24 / **17** | 41 / **41** / **0** |

（表中 `skipped` 两项皆为 0；改前合计 fail 17 与派单给出的 10/3/3/1 逐项吻合。）

### 5.2 无 stall · 4 文件

`node --test tests/unit/community-http.test.mjs tests/unit/gy-i22-cache-headers.test.mjs tests/unit/gy-i22-secmatrix.test.mjs tests/unit/admin-flag-gate.test.mjs`
⇒ `tests 41 / pass 41 / fail 0 / cancelled 0 / skipped 0 / todo 0`。

### 5.3 全量 · 与干净基线对照

| 轮次 | tests | pass | fail | cancelled | skipped | todo | duration |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 干净基线 `d131e47`（未改任何文件） | 1698 | 1697 | **0** | 0 | 1 | 0 | 71999.58ms |
| 本片改后（无 stall） | 1698 | 1697 | **0** | 0 | 1 | 0 | 88310.39ms |

唯一 skip 是**既有项**，与本片无关（`baseline-full.txt:841`）：
`﹣ native separate-connection withdrawal and account state changes at guarded read boundary (0.1872ms) # SKIP`。
即：全量**失败集合同名同数（空集）**，pass/skip/tests 三项与基线一致。

### 5.4 范围外读数（同臂、仅供参考，本片未处置）

同一 stall 臂跑全量：`tests 1698 / pass 1639 / fail 58 / skipped 1`。即本片收口后，**臂下仍有 58 条红，全部落在本片 4 个文件之外**（本片改动不被任何其它测试文件 import，故这些红与本片无因果关系）。按堆栈归属分组：

| 组 | 文件（栈帧计数） | 判断 |
| --- | --- | --- |
| 审核域/会话域夹具未冻钟 | `community-moderation-*`（6+6+3+3+3，另有夹具 1）、`conversation-risk-screen`(9)、`conversation-followup-context`(7)、`conversation-failure-visibility`(3)、`conversation-answer-guard`(2)、`conversation-retrieval-validity`(2)、`conversation-http`(2) | 同一根因的另一批装配点（`tests/unit/community-moderation-fixtures.mjs`、`tests/unit/conversation-fixtures.mjs`），不在本片范围 |
| 时间语义类用例 | `pg-write-idempotency-ttl`(18)、`favorites-history-store-pg`(1) | 断言 TTL 到期语义；停顿时钟本身就会改变其输入，**不应**用本臂当判据 |
| 其它 | `speech-service`(1) | 未归因 |

⛔ 不得把 §5.4 读成「本片让全量变红」或「本片已收口全部 flake」：本片只对派单点名的 4 个文件负责，且它们的红已在 §5.1/§5.2/§5.3 三重读数下清零。

## 6 改动清单（`git diff --numstat d131e47 HEAD`）

```
19	3	tests/unit/admin-flag-gate.test.mjs
14	1	tests/unit/community-http.test.mjs
10	1	tests/unit/gy-i22-cache-headers.test.mjs
19	2	tests/unit/gy-i22-secmatrix.test.mjs
90	0	tests/unit/stall-hygiene-fixtures.mjs
```

`services/**`、`packages/**`、`package.json`、lockfile：**0 行** ⇒ 本片是纯测试片。`git status --porcelain`：0 行（收工后）。

四个测试文件的 `+` 行里，断言主体 0 行变化（全部是装配接线与注释），可逐行核对：`−1`/`−2`/`−3` 被删的都是原先那一行 `moderationInjection: { ports: … }`。本证据页自身（`docs/verification/gy-stall-hygiene-20261019.md`）同在本提交内、但不是被测面，故上表只列被测定面；跑同一条命令时还会多出一行 `~176 0 docs/verification/gy-stall-hygiene-20261019.md`（本页行数随改写浮动，属自指，不列数值）。

## 7 临时物自证

取证物全部在 `E:\GengYunCommander\.pg17\tmp\hq\stall-hygiene-w1\`（工作树之外、不进仓库），收工后整目录删除，并以 `Test-Path` 返回 `False` + 父目录列表自证（见交接文件「临时物」节）。

# GY-R70 · 审核域真实接线的启动批准开关（`--approve-moderation-live-wiring`）证据页

- 日期：2026-10-30
- 基线：**`eb16af28`**（＝ `#777` 分支 `feat/gy-r70-moderation-live-wiring` 的 head，它自己已 `merge: 合入 upstream/main c609ce7f`）。`upstream/main` 当天实测 **`c609ce7f`**，`#777` 的 `moderation/live-assembly.ts` **尚未**合入 main ⇒ 本片按派单**从 `#777` 分支切工作树**，base 即 `eb16af28`。
- 分支：`feat/gy-r70-moderation-approval`
- 范围：`services/api/src/moderation/startup-approval.ts`（新增）、`services/api/src/server.ts`（转发 ＋ 致命判定）、`tests/unit/moderation-approval-flag.test.mjs`（新增）、三处既有结构钉子（登记式变更）、`docs/reference/configuration.md`（末尾追加）、本页
- 本片**不推**、不调用 `gh`、不发起任何真实供应商调用、不打印任何凭据值

---

## 0. 一句话

`#777` 已经把装配决定点（`moderationServiceAssemblyOption`）与**唯一铸造点**（`approveModerationLiveWiring`）做好，但**生产入口从不调用铸造点** ⇒ 今天 `real` 下审核域仍整域 503、批准能力是死码。本片补上那一道**有名启动开关**：

> **仅当**「开关给了 **∧** 运维在命令行给出的 `policySource`/`bizType` 齐备且形状合法 **∧** 共享凭据齐备 **∧** 铸造后的剖面复核通过」四条**同时**成立，才在启动期铸造一份批准能力并交给 `buildApp({ moderationInjection: { liveApproval } })`。
> **开关给了但任一条不成立 ⇒ 不铸造 ＋ 一行 `stderr` ＋ `exit 1`（服务不会起来）**；**开关没给 ⇒ 静默、`exit 0`**，与改前逐字相同（审核域仍是那个 fail-closed 503）。

⛔ 不从 env／配置文件取 `policySource`／`bizType`（「配置即门控」，媒体域两轮对抗复审已否掉）；⛔ 不给默认值；⛔ 不「尽力而为」。

**口径来源（2026-10-30 裁定）**：与先例 `--approve-real-media-wiring` **一致**——实测那条在「开关给了但前置不满足」时就是 `exit 1`（见 §1 最后一行）。本片第一版选的是「只 warn 不退出」，被裁定推翻，理由记在这里备查：**同一台机器上两个批准开关行为不一致本身就是坑**；要防的不是「审核没开」（那本来就是 503），而是「**运维以为自己把审核开了**」——一条 warn 混在启动日志里等于没有。

---

## 1. 断点与先例（逐条可复核）

| 事实 | 复核命令／位置 | 读数 |
|---|---|---|
| `#777` 的铸造点存在且唯一 | `services/api/src/moderation/live-assembly.ts` 的 `approveModerationLiveWiring`（定义在第 98 行）、模块私有 `WeakSet`（第 77 行） | 对象身份判定：形状相同字面量／`Object.create` 派生／克隆一律无效 |
| `#777` 的纯决定函数 | 同文件 `resolveModerationLiveWiring`（第 225 行） | 拒绝原因闭集 `missing_approval` / `missing_credentials` / `invalid_configuration`（第 80 行） |
| `app.ts` 已接上装配点 | `services/api/src/app.ts:938` | `...moderationServiceAssemblyOption({ executionMode, approval: moderationInjection?.liveApproval, credentials: config.moderationLive?.credentials ?? null, log })` |
| **改前**生产入口从不铸造 | `git grep -n "approveModerationLiveWiring(" -- services/api/src`（base `eb16af28`） | 仅**定义处** 1 处，零调用点 |
| 既有先例的形状 | `services/api/src/media/real-ports.ts` 的 `resolveMediaRealPorts` ＋ `services/api/src/server.ts:47` 的 `resolveMediaRealPorts({ config, argv: process.argv.slice(2) })` | 「有名启动参数 → 前置校验 → 铸造 → 装配」四步，本片逐条对齐 |
| 既有先例在**前置不满足**时的口径（实测） | `APP_EXECUTION_MODE=stub node services/api/src/server.ts --approve-real-media-wiring` | **`exit 1`**：`[execution_mode_not_real → PROVIDER_UNAVAILABLE, retryable=false] …` ⇒ 本片照此口径 |

---

## 2. 参数契约表

| 参数 | 形状／判据 | 缺了或非法时 |
|---|---|---|
| `--approve-moderation-live-wiring` | **整串精确匹配** `argv` 某一项（`--approve-moderation-live-wiring=true` 不算给了） | **未给** ⇒ 与改前逐字相同：不铸造、**不发声**、`exit 0` |
| `--moderation-policy-source=<标识>` | `MODERATION_POLICY_SOURCE_PATTERN`＝`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{2,119}$`（上限 120 与 `live-ports.ts` 的 `assertModerationPolicyOpen` 同口径；**不 trim**，带空白的手误必须被挡） | 缺 ⇒ `missing_approval`；空串／裸参数名／异值重复／形状不符 ⇒ `invalid_configuration`。两种都 ⇒ **一行 stderr ＋ `exit 1`** |
| `--moderation-biz-type=<BizType>` | 复用 `live-ports.ts` 的 `MODERATION_BIZ_TYPE_PATTERN`＝`^[A-Za-z0-9_-]{1,32}$`（**不写第二套真理**） | 同上 |
| （不存在的入口）env／配置文件 | ⛔ 不读：`startup-approval.ts` **去注释后** `process.env` 命中 **0** 条（用例钉住） | — |

**判定位置**：`services/api/src/moderation/startup-approval.ts` 的 `resolveModerationStartupApproval()`（第 189 行，纯函数：只吃 `config` 与 `argv`，不读 env、不碰网络、不写台账、不 `process.exit`）；**铸造点**：同文件第 270 行对 `#777` 的 `approveModerationLiveWiring()` 的**唯一**生产调用；**装配层入口**：`moderationStartupAssemblyOptions()`（第 320 行）。生产入口只转发那三件事：`services/api/src/server.ts:61` 取装配片段 → `:62`–`:66` 判致命（`console.error` ＋ `process.exitCode = 1` ＋ `return`）→ `:68` `buildApp(...)`。

---

## 3. 改了什么（逐文件职责 ＋ 行号策略）

| 文件 | 性质（vs base `eb16af28`） | 职责 |
|---|---|---|
| `services/api/src/moderation/startup-approval.ts` | **新增 328 行** | 参数解析（`parseModerationStartupArgs`，纯函数）＋ 决定点（`resolveModerationStartupApproval`：四条前置、闭集原因、`fatal` ＋ `fatalLine`）＋ 装配片段（`moderationStartupAssemblyOptions`：成功只多 `moderationInjection` 一个键，失败只回一行诊断）。**不含网络实现、不含凭据值、不读 `process.env`、不读文件、不写台账、不 `process.exit`、从不抛错。** |
| `services/api/src/server.ts` | 改 **27 / 删 14** | 第 30–43 行**等行重写**（媒体域/TTS 口径压紧后腾出 4 行写审核域四条前置）；第 61–68 行是新增的转发 ＋ 致命判定（**这一处刻意接受行号漂移**，见下）；文件**末尾**追加 import（ESM 提升 ⇒ 语义等价，与 `routes/ocr.ts`、`ocr/media.ts` 既有做法同源）。 |
| `tests/unit/moderation-approval-flag.test.mjs` | **新增 573 行 / 11 条用例** | 六臂参数矩阵（含 `fatal`）、闭集原因与「恰好一行 stderr」、参数解析边界、**进程级子进程用例**（真起 `server.ts`，断言 `exit 1` ＋ 一行 stderr）、**零外呼绊线**（六臂 `globalThis.fetch` 计数 0）、**等价性**（与「完全不给开关」逐字段相同）、正控制（四臂全过 ⇒ `wired`）、**对象身份**（克隆/派生/结构化克隆/同形状字面量一律不被接受）、**输入只认 argv**、凭据判据与 `#777` 同口径。 |
| `tests/unit/moderation-live-wiring-assembly.test.mjs` | 改 25 / 删 5 | 结构钉子 ⑧ 的**登记式变更**（见下表）。 |
| `tests/unit/profile-log-redaction.test.mjs` | 改 32 / 删 1 | `buildApp` 实参形状钉子 ＋ 新增「致命判定必须是 `exitCode = 1`」（见下表）。 |
| `tests/unit/tts-synthesis-media-wiring.test.mjs` | 改 4 / 删 1 | 同一行 `buildApp` 的第二处逐字钉子。 |
| `docs/reference/configuration.md` | **末尾追加 16 行** | 新增「启动参数：审核域真实接线的批准开关（GY-R70）」小节（⛔ 中段未插行：文件原有 67 行逐行未动）。 |
| `docs/verification/gy-r70-moderation-approval-20261030.md` | **新增** | 本页。 |

### 行号策略（按裁定：**接受漂移，不为保行号压注释**）

- 本片第一版为了保 `server.ts:62` 曾把注释压到 14 行；裁定明确「⛔ 不要为了保行号去压注释」，因此现在**保留完整注释**（第 30–43 行仍 14 行、内容写全），把新代码插在 61–68 行，`buildApp` 由 `:62` 漂到 **`:68`**。
- `node tools/verify-contract-status.mjs --reanchor`（dry-run）读数：**「无可重定位项（带锚点且带行号的引用 302 条，锚点都在 ±2 行容差内；符号形态 11 条按运行时解析，不写盘）」** ⇒ **台账不需要 `--write-doc`**，因为台账里唯一直接指向 `server.ts` 的锚点是 **`:50`（符号 `synthesisMediaWiringAssemblyOptions(mediaRealPorts)`）**，它在漂移点**之上**、一位没动。
- ⚠ **doc 级（不是台账级）漂移，如实登记**：`docs/verification/**` 里另有三处按行号引用 `server.ts:62` 的**历史证据页**现在指短 6 行——`gy-i06-media-real-provider-plan-20261021.md`（第 17 行表格、第 77 行「| 8 |」行）、`gy-r28-w2-media-ports-20261021.md`（第 32 行）、`gy-r31-i15-recon-20261022.md`（第 133 行）。本片**没有改它们**（仓规：历史读数页不改数字；且这些行都自带「本片测量时为第 N 行」的时点说明）。它们不参与任何门禁判红（`ANCHOR_DRIFT` 只判 `docs/architecture/**`）。

### 既有结构断言的变更（前 → 后，逐条登记，口径同 `docs/verification/gy-r70-ocr-media-port-20261030.md` §5 的登记表）

| 断言 | 前 | 后 | 是否放宽 |
|---|---|---|---|
| `moderation-live-wiring-assembly.test.mjs` ⑧：`approveModerationLiveWiring(` 在 `services/api/src/**` 的出现次数 | 恰好 **1**（只有定义处）＝「装配层从不铸造」 | 恰好 **2**（定义处 ＋ **唯一获准调用点** `moderation/startup-approval.ts`），调用点**逐名登记**，新增调用点仍判红；并新增：`app.ts`/`server.ts` 去注释后**不得**出现该调用 | **否**：`#777` 那条钉子原本把铸造点钉成死码（`real` 下审核域永远开不了）；本片只把「生产入口必须能用它一次」这条**显式**开出来，装配层自我批准仍被逐条否定。原断言的另外两段（适配器符号不得进入 `app.ts`/`server.ts`）**一字未改**。 |
| `profile-log-redaction.test.mjs`：`buildApp` 实参形状 | `{ config, pool, ...(mediaAssembly ?? {}), ...(synthesisMediaAssembly ?? {}) }` 逐字 | 追加第三个同族 spread `...(moderationInjection === undefined ? {} : { moderationInjection })`；并新增三条：`moderationStartupAssemblyOptions(` 恰好 1 次、`moderationAssembly` 赋值恰好 1 次、**且不得落进 `if (mediaRealPorts !== null)` 判定块**（两条门必须解耦），以及**致命判定必须是 `console.error(...)` ＋ `process.exitCode = 1` ＋ `return`** | **否**：`logStream` 仍注入不进来（第 142 行断言未动），三处 spread 的取值都只来自具名派生函数。 |
| `tts-synthesis-media-wiring.test.mjs` ①：`buildApp` 行逐字 | 同上（两处 spread） | 追加第三处 spread | **否**：该用例的 `logStream` 断言（「补装配不得顺手引入测试专用注入项」）一字未改。 |

---

## 4. 六臂实测（含**进程退出码**）

读数脚本逐臂打印 `resolveModerationStartupApproval({ config: loadConfig(合成 env), argv })`（仓外脚本，不提交；env 是合成占位，不联网、不读凭据文件）：

| 臂 | 开关 | `--moderation-policy-source=` | `--moderation-biz-type=` | 共享凭据 | `minted` | `liveApproval` | `reason` | `fatal` | stderr 行数 | **进程退出码** |
|---|---|---|---|---|---|---|---|---|---|---|
| ① | **缺** | — | — | 齐备 | `false` | `null` | `null` | `false` | **0（不发声）** | **0（照常启动）** |
| ② | 给了 | **缺** | 齐备 | 齐备 | `false` | `null` | `missing_approval` | `true` | 1 | **1** |
| ③ | 给了 | 齐备 | **缺** | 齐备 | `false` | `null` | `missing_approval` | `true` | 1 | **1** |
| ④ | 给了 | **非法** | **非法** | 齐备 | `false` | `null` | `invalid_configuration` | `true` | 1 | **1** |
| ⑤ | 给了 | 齐备 | 齐备 | **缺** | `false` | `null` | `missing_credentials` | `true` | 1 | **1** |
| ⑥ | 给了 | 齐备 | 齐备 | 齐备 | **`true`** | **已铸造对象** | `null` | `false` | 0 | **0（照常启动、审核域 `wired`）** |
| ⑦（补充） | 给了 | 齐备 | 齐备 | 齐备 | `false` | `null` | `invalid_configuration` | `true` | 1 | **1** |

⑦＝`APP_EXECUTION_MODE=stub`：真实审核接线只在 `real` 下成立；`#777` 的闭集**没有** `execution_mode_not_real`，本片**不新造**原因串，按闭集里最贴近的 `invalid_configuration` 上报（⚠ 可读性欠佳，见 §9 第 3 条）。

退出码一列取自**真的起进程**的子进程用例（不是从 `fatal` 推断的）：`execFileSync(node, [server.ts, ...argv], { env: <显式合成 env>, timeout: 20000 })`；「超时」会被判成**红**（那意味着进程起来了 ⇒ 不是一次启动失败）。

### 五条拒绝路径的 stderr 原文（逐字摘录，⚠ 每条都是**一行**，随后 `exit 1`）

② 缺 `policySource`：

```
GY-R70 审核域真实接线未获批准：reason=missing_approval（缺少 --moderation-policy-source=<策略来源标识>，必须由运维在启动命令行给出） ⇒ 本次启动**不铸造**批准能力、不给 moderationInjection.liveApproval 任何默认值，real 下审核域保持既有整域 fail-closed 503（PROVIDER_UNAVAILABLE，retryable=false）；补齐 --approve-moderation-live-wiring 与 --moderation-policy-source=<策略来源标识> / --moderation-biz-type=<真实 BizType> 及共享凭据后重启
```

③ 缺 `bizType`：同上，括号内为 `缺少 --moderation-biz-type=<真实 BizType>，必须由运维在启动命令行给出`。

④ 两者非法：

```
GY-R70 审核域真实接线未获批准：reason=invalid_configuration（--moderation-policy-source= 的值不是合法的策略标识） ⇒ …（后半同上）
```

⑤ 凭据缺：

```
GY-R70 审核域真实接线未获批准：reason=missing_credentials（共享凭据不齐备：TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY 未成对配置，或执行模式不是 real） ⇒ …（后半同上）
```

⑦ 非 real：

```
GY-R70 审核域真实接线未获批准：reason=invalid_configuration（执行模式是 "stub"，真实审核接线只在 real 下成立） ⇒ …（后半同上）
```

### 进程级实测（子进程，两条臂）

| 臂 | 命令（合成的显式 env） | 实测 |
|---|---|---|
| P1 | `APP_EXECUTION_MODE=stub LOG_LEVEL=warn API_PORT=<测试端口> node services/api/src/server.ts --approve-moderation-live-wiring` | **exit 1**，stderr 里 `GY-R70 …` 恰好 **1** 行，含 `reason=invalid_configuration`；**没有进入监听** |
| P2 | 同 `real`（凭据齐备）＋开关＋只给 `--moderation-policy-source=` | **exit 1**，含 `reason=missing_approval` 且点名 `--moderation-biz-type=`；**没有进入监听** |

⚠️ 如实补充：`real` 模式下若批准没铸成，`app.ts` 的装配决定点还会另打**一行** `reason=missing_approval`（`#777` 既有行为：从它的视角"没有批准能力"）——但在生产入口里这条路径**走不到**，因为进程在 `buildApp` **之前**就 `exit 1` 了；它只在测试里「绕过退出、直接把片段喂给 `buildApp`」的等价性用例中出现。本片**没有**去抑制它（`app.ts` 是锚点对象，本片刻意不动）。

---

## 5. 证明了什么

1. **开关真的能把决定点接到装配上**（正控制）：四条全过 ⇒ `app.moderationService.capabilities().text` 从 `state:'none'/ready:false/origin:'none'` 变成 `state:'wired'/ready:true/origin:'injected'`，`fatalLine === null`；装配片段只产出 `moderationInjection` ＋ 空 `fatalLine`，里面只有 `liveApproval`。
2. **不成立 ⇒ 进程起不来**（比 plan 字段更强）：P1／P2 两条子进程臂实测 **exit 1** ＋ **恰好一行** stderr ＋ 未进入监听；`fatal` 的口径被硬钉住——**开关给了一律 fatal、开关没给一律不 fatal**（矩阵用例逐臂断言）。
3. **不成立时装配面与改前逐字段相同**（等价性）：②③④⑤ 四臂的 `capabilities()` 与「**完全不给开关**」的基准臂 `deepEqual`；送审拒绝 `{code, message, retryable}` 与基准臂 `deepEqual`，且仍是 `PROVIDER_UNAVAILABLE` / `retryable:false`（＝ 503 fail-closed，绝不回退替身）。**「审核域不会被半开」与「进程不会假装启动成功」是两条各自独立的钉子。**
4. **输入只认启动参数**：把 `MODERATION_POLICY_SOURCE` / `MODERATION_BIZ_TYPE` / `MODERATION_LIVE_WIRING_APPROVED=true` 塞进 env、argv 只给开关 ⇒ 仍然 `missing_approval` ＋ fatal；且 `startup-approval.ts` **去注释后** `process.env` 命中 0。
5. **对象身份判定有牙齿**：浅克隆／`Object.create` 派生／`structuredClone`／同形状字面量四种伪造传进 `buildApp` 一律 `state:'none'` ＋ 503；只有铸造产物 `isModerationLiveWiringApproved(...) === true`。
6. **零外呼**：六臂整条「解析 + 装配」路径（`loadConfig` + 决定点 + `buildApp` + `capabilities()`）`globalThis.fetch` 计数 **0**（手法照 `tests/unit/ai-live-provider-wiring.test.mjs` 头注：绊线是计数器 + 立即拒绝，判据只看**次数**）。
7. **原因码没漂移**：所有诊断的 `reason=` 都逐字是 `#777` 的闭集成员（用例逐臂正则抽取后断言 `MODERATION_LIVE_REFUSAL_REASONS.includes(...)`）；诊断里不含异常文本、配置值、凭据值（`secretKey`/`secretId` 断言 0 命中）。
8. **铸造点仍唯一、装配层仍不自我批准**：`services/api/src/**` 去注释后 `approveModerationLiveWiring(` 恰好 2 处（定义处 ＋ `moderation/startup-approval.ts` 的唯一调用点），`app.ts`/`server.ts` 各 0 处；`server.ts` 里 `moderationStartupAssemblyOptions(` 恰好 1 处、`console.error(moderationAssembly.fatalLine)` 恰好 1 处、**`console.warn(` 0 处**（口径已与媒体域统一）。
9. **台账级行号零漂移**：`verify-contract-status --reanchor` 判「**无可重定位项**（302 条带行号引用全在 ±2 容差内）」——台账唯一指向 `server.ts` 的锚点 `:50` 在漂移点之上（doc 级漂移已如实登记在 §3）。

---

## 6. 没证明什么（诚实边界）

- **没有真实凭据 ⇒ 不证明审核有效**：⑥ 臂里端口是**真实适配器对象**（`provider.synthetic === false`），但**一次真实外呼都没发**（网络被绊线）。「启动期能铸出批准能力」≠「供应商接受这份剖面」≠「违规样本会被拦」≠「审核策略正确」。
- **`policySource` / `bizType` 只是形状合法**：本片没有任何东西能证明 `--moderation-policy-source=` 里的值**真的**对应一次独立核对过的策略，也不证明 `bizType` 对应腾讯云控制台里那份策略。铸造就等于「运维对着这两个值签名」，这是**声明**不是**证据**。
- **不证明计费/配额/账号**：真实账号、付费授权、配额都不在本片范围。
- **图片端口仍拿不到字节**：`imageSource` 缺省是未接线来源（对象存储属媒体域）⇒ 图片送审在「取不到待审图片」处 fail-closed。⑥ 臂里 `image.state === 'wired'` 只表示「端口是真实端口」。
- **不证明跨域效果**：社区投递（`POST /posts`）的 422/503 语义、结论落库、发布闸门都在既有用例里，本片未改；本片只改「这次启动要不要传 `liveApproval`」以及「不成立时要不要退出」。
- **没跑真实链路**：真实 tms/ims → 合流 → 台账 → 发布闸门一次都没跑；本页全部读数来自离线合成夹具 ＋ 两个子进程启动。
- **不覆盖 `deploy/**`**：本仓没有自动化的部署清单渲染，「启动参数怎么进容器」未验证。
- **进程级用例只覆盖「该退出」的两条臂**：⑥ 臂若也起子进程，进程会长期监听（会把测试跑成 hang），因此「该起来」的那条只在 in-process 装配面证（`capabilities().text === 'wired'`）。这是刻意的取舍，不是遗漏。

---

## 7. 门禁读数（九条 ＋ CI-exact anchors，全部 exit 0）

读数取自提交 `58aba374`（代码 ＋ 测试 ＋ 配置文档）；本页是紧随其后的**纯文档**提交，两笔只差文档（§7.1 是本页加入后的复跑读数）。

| 门禁 | 命令 | 读数 | exit |
|---|---|---|---|
| 单测 | `npm run test:unit`（`GY_BASH=D:\Git\bin\bash.exe`） | `tests 5818 / pass 5814 / fail 0 / cancelled 0 / skipped 2 / todo 2`（本片 11 条用例全绿，含 1 条子进程用例） | 0 |
| 锚点（npm 扫描面） | `npm run verify:anchors` | `contract-status` PASS（覆盖 126 条操作、行号区间 313 条、中文表格一致）；`doc-anchors --strict` PASS（基线外新增 0、陈旧 0）；`BARE_ORPHAN 3479/3543`；`ANCHOR-COUNT 6214 条 / 224 份`（清册 6287/227；**下降 0 份**、上升 9 份、面内本次未扫 8 个合法跳过） | 0 |
| **CI-exact** | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `--strict` 无基线外新增；`SYMBOL-STRICT-BASELINE 31/31`；`ANCHOR_DRIFT 15` 全部落在基线内；`BARE-ORPHAN 3543/3543`、`outsideRed 134/134`；`ANCHOR-COUNT 6470 条 / 234 份`（上升 12 份、下降 0 份） | 0 |
| 契约漂移 | `npm run verify:parity` | `extra: []` / `missing: []` / `ledgerDrift: []` | 0 |
| 能力图 | `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`；「文档标记块与重算一致」 | 0 |
| 文档 | `npm run test:docs` | 研究记录 **5 通过 / 0 失败 / 4 legacy 已钉住**；`docs/research` 结构校验 PASS | 0 |
| 静态检查 | `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| 契约测试 | `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| 构建 | `npm run build`（`TMP`/`TEMP` 指到**仓外**；构建后删 `services/api/dist` 与 `apps/admin/dist`） | api `tsc` 无错、admin `vite build` 通过（629.18 kB 主包告警是既有体积提示，非错误）；两处 `dist` 已删（`Test-Path` 均为 `False`） | 0 |
| 失败矩阵 | `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |
| 额外·重定位复核 | `node tools/verify-contract-status.mjs --reanchor`（dry-run） | **`无可重定位项（带锚点且带行号的引用 302 条，锚点都在 ±2 行容差内；符号形态 11 条按运行时解析，不写盘）`** ⇒ 台账无需 `--write-doc`（`server.ts` 漂移发生在台账锚点 `:50` 之后） | 0 |

### 7.1 本页加入后的复跑（纯文档面）

见文末「附录 C · 复跑读数」。

---

## 8. 负控制（四条，逐条实际打红 → 立刻还原 → 复跑复绿）

脚本在仓外（`…\tmp\gy-r70-modflag\buildtmp\r70-negative-controls.mjs`），不提交。每轮：改一处 → `node --test tests/unit/moderation-approval-flag.test.mjs` → 记录红 → `git checkout --` 还原 → 复跑绿 → 核对 SHA256 与打红前**逐字节相同**。

| # | 怎么打的（改哪一行） | 红在哪（逐字摘录） | 还原后 |
|---|---|---|---|
| ① | **参数缺失也铸造**：`readFlagValue` 在「没给」时直接返回默认值（`state:'value', value:'r70-nc-default-policy'`） | `exit 1`，`pass 5 / fail 6`：✖ 矩阵：六臂逐条实测…、✖ 矩阵：拒绝原因只用闭集…、✖ 参数解析…、**✖ 进程级：开关给了但前置不成立 ⇒ 退出码非 0 ＋ 一行 stderr**（＝**进程起来了，本该起不来**） | ✅ `11 / 11` 绿，`RESTORED_MATCH=true` |
| ② | **把 `policySource`/`bizType` 改成读 env**：`readFlagValue` 在「没给」时改读 `process.env['MODERATION_POLICY_SOURCE']` / `['MODERATION_BIZ_TYPE']` | `exit 1`，`pass 9 / fail 2`：✖ 输入只认启动参数（同名值塞进 env 而不进 argv ⇒ 仍然不铸造）、✖ 参数解析… | ✅ `11 / 11` 绿，`RESTORED_MATCH=true` |
| ③ | **让克隆对象通过身份判定**：`live-assembly.ts` 的 `isModerationLiveWiringApproved` 从 `WeakSet.has(value)` 换成形状判定 | `exit 1`，`pass 10 / fail 1`：✖ 对象身份：克隆/派生一份合法 approval 传进 buildApp 必须不被接受（仍 503） | ✅ `11 / 11` 绿，`RESTORED_MATCH=true`（`live-assembly.ts` 与打红前逐字节相同） |
| ④ | **铸造失败后回退成「无审核放行」**：`moderationStartupAssemblyOptions` 在 `liveApproval === null` 时改为注入 `createModerationService({ executionMode: 'stub' })`（替身服务整体顶掉审核域） | `exit 1`，`pass 10 / fail 1`：✖ 等价性：不批准的臂，capabilities() 与「完全不给开关」逐字段相同，且送审仍 503 fail-closed | ✅ `11 / 11` 绿，`RESTORED_MATCH=true` |

**打红前的 SHA256（还原后再核一次，全部 MATCH）**：

```
services/api/src/moderation/startup-approval.ts  87AF20F46E32F673373849F18FD4B0D486C5AFFA3CB582CAF1D8CEC9EC21CE9F
services/api/src/moderation/live-assembly.ts     AB862D17795D56F3AD7123310FE8BA744B39865FC3A20569C9F2225928B62E16
```

**两条如实结论**：

- ④ 若改成「注入一个**替身端口**（`moderationInjection.ports`）」而不是「注入替身**服务**」，本片的等价性用例**仍会绿**——因为 `#777` 的 `resolveModerationPorts` 在 `real` 下**忽略**注入的替身端口（`tests/unit/moderation-live-adapter.test.mjs` ⑥ 已有钉）。「不批准就塞替身端口」这条回退**已被 `#777` 的既有闸门挡住**，本片不需要重复实现；本片要挡的是「整个审核域被替身服务顶掉」。
- ① 的第一次尝试（替换锚点写成单行、结果留下两段 ternary）让**整个用例文件加载失败**（`ERR_INVALID_TYPESCRIPT_SYNTAX`）——那种红**不算数**（它红的不是断言，是语法）。上表 ① 的读数是**修正替换锚点之后**重打的：`pass 5 / fail 6`，四条具体断言各自变红。

---

## 9. 需要裁定的点（以及已裁定的记录）

1. **【已裁定 · 已实现】非法值时 `warn` 还是 `exit 1`** ⇒ **`exit 1`**。本片第一版选 warn 并写下三条理由（无半接线可防／交付项把 warn 写成硬要求／爆炸半径），裁定逐条驳回，采纳结论：**同一台机器上两个批准开关行为必须一致**；要防的是「运维以为自己把审核开了」，一条 warn 在启动日志里等于没有；安全相关手误的正确爆炸半径就是起不来。实现：`plan.fatal` ＋ `plan.fatalLine` ＋ `server.ts:62`–`:66`。
2. **【已裁定 · 保持】开关与参数命名**：`--approve-moderation-live-wiring` ＋ `--moderation-policy-source=` / `--moderation-biz-type=`（照派单例子逐字）。
3. **【已裁定 · 保持】非 `real` 的原因映射**：闭集无 `execution_mode_not_real`，按 `invalid_configuration` 上报（⛔ 不新造原因串、⛔ 不跨片改 `#777` 闭集）。⚠ **可读性欠佳**：同一个 `invalid_configuration` 同时表示「模式不对」与「值非法」，区分只能看括号里的 detail。
4. **【已裁定 · 保持】批准状态不挂只读面**（不新增 contract operation）。
5. **【本片发现的判据缺陷，未修，建议另开一片】**：结构钉子 ⑧ 与若干同类用例用
   `source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')` 去注释——**只要注释里出现 `/**`（例如写 `services/api/src/**`），非贪婪匹配就会从那里开始吞掉其后的一大段真实代码**。
   - **复现形状**：在 `services/api/src/**` 里任一 `.ts` 的注释中写下 `services/api/src/**`（或任何含 `/*` 的片段），再跑 `tests/unit/moderation-live-wiring-assembly.test.mjs` ⇒ 该文件里**真实存在的** `approveModerationLiveWiring(` 调用会从"去注释后源码"里消失，⑧ 报 `callSites` 为空并**误红**（本片第一版实测踩到，见 §8 末条）。
   - **反向风险**：同一个缺陷也能让**本该抓到的**调用点被吞掉 ⇒ 判据在「别人写了 `src/**` 的注释」之后**可能静默失效**（假绿）。本片因此在自己源码里避开了该写法并把这条写在这里，**没有**去改那条判据（改它会动到别人的钉子面）。
6. **是否把 `docs/verification/**` 里三处 `server.ts:62` 的历史引用重取为 `:68`**：本片按「历史读数页不改数字」未动（清单见 §3）。需要的话是 3 处、每处 1 行的机械改动。

---

## 附录 A · `server.ts` 的最终形状（接受漂移后）

```
 61   const moderationAssembly = moderationStartupAssemblyOptions({ config, argv: process.argv.slice(2) });
 62   if (moderationAssembly.fatalLine !== null) {
 63     console.error(moderationAssembly.fatalLine);
 64     process.exitCode = 1;
 65     return;
 66   }
 67   const moderationInjection = moderationAssembly.moderationInjection;
 68   const app = buildApp({ config, pool, ...(mediaAssembly ?? {}), ...(synthesisMediaAssembly ?? {}), ...(moderationInjection === undefined ? {} : { moderationInjection }) });
```

媒体域的判定块（`:47`／`:48-51`／`:50`）与 `let mediaAssembly`（`:44-45`）**一位没动**；`buildApp` 由 `:62` 漂到 `:68`（＋6 行，正好是上面 62–67 那 6 行）。

## 附录 B · 「零外呼」怎么数的

```
const original = globalThis.fetch;
const calls = [];
globalThis.fetch = (...args) => { calls.push(args); return Promise.reject(new Error('zero-outbound tripwire')); };
try { /* loadConfig × 6 + resolveModerationStartupApproval × 6 + buildApp × 6 + capabilities() */ } finally { globalThis.fetch = original; }
assert.equal(calls.length, 0);
```

判据不是「抛了什么」，而是**计数**：装配期只要碰一次网络，`calls.length` 立刻 > 0。⑥ 臂（全齐）**不**调用 `submitScreening`——真实端口一旦被调用就会碰网络，本片明确不发起任何真实外呼。

## 附录 C · 复跑读数（本页加入后，纯文档面）

<!-- RERUN -->

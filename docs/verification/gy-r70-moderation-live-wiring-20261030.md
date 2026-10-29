# GY-R70 · 审核域真实端口的生产装配（`liveWiring` 接线）证据页

- 日期：2026-10-30
- 基线：`53354fe7`（`upstream/main` 当天实测为 `2bbb9e38`，本片按**派单钉住的** `53354fe7` 建树；两者差一个 miniprogram 提交）
- 分支：`feat/gy-r70-moderation-live-wiring`
- 范围：`services/api/src/{app.ts,config.ts,moderation/live-assembly.ts}` ＋ 一个单测 ＋ 一条既有清单登记 ＋ 本页
- 本片**不推**、不调用 `gh`、不发起任何真实供应商调用、不打印任何凭据值

---

## 0. 一句话

审核域的库件（`tms-live-adapter.ts` / `ims-live-adapter.ts` / `live-wiring.ts`）早就齐了，但**全仓没有一处生产代码传
`liveWiring`** ⇒ `real` 下审核整域恒 503。本片补上那个「另一次显式、可审查的接线变更」：

> **仅当** `executionMode === 'real'` **且** 凭据齐备 **且** 显式批准能力存在（三与门）才构造并传入 `liveWiring`；
> 任一不满足 ⇒ 一个字段都不传，**保持今天的整域 503 `PROVIDER_UNAVAILABLE`（`retryable: false`）**。

⛔ 不放行、⛔ 不回退替身、⛔ 不把「本地通过」当真实审核。

---

## 1. 断点（改前代码事实，逐条可复核）

| 事实 | 复核命令/位置 | 读数 |
|---|---|---|
| 服务端有注入点 | `services/api/src/moderation/service.ts` 的 `ModerationServiceDeps.liveWiring?` | 存在（`services/api/src/moderation/service.ts:134`） |
| 注释承诺「有凭据且显式打开 ⇒ 用真实端口」 | 同文件 `services/api/src/moderation/service.ts:453-455` | 实现是 `deps.liveWiring === undefined ? null : createLiveModerationPortsFromWiring(...)` |
| **生产装配从不传它** | `git grep -n liveWiring -- services/api/src` | 仅 `moderation/service.ts` 三处（`grep` 输出见下方「附录 A」） |
| 库件齐备 | `moderation/{tms-live-adapter,ims-live-adapter,live-wiring,live-ports,live-tc3,live-vendor}.ts` | 均在，单测 `tests/unit/moderation-live-adapter.test.mjs` 已覆盖 |
| 因此 `real` 恒 503 | `createModerationService({ executionMode: 'real' })` | `capabilities().{text,image}.state === 'none'`，送审抛 `PROVIDER_UNAVAILABLE`(`retryable:false`) |

⚠️ 与本片无关的两个同名文件：`ai/checked-content-live-adapter.ts` / `ai/checked-content-live-ports.ts` 是 **TTS 的「已核对内容」只读端口**，不是审核层。本片一行未动。

---

## 2. 改了什么（逐文件职责）

| 文件 | 性质 | 职责 |
|---|---|---|
| `services/api/src/moderation/live-assembly.ts` | **新增** | 装配决定点：批准能力铸造点 `approveModerationLiveWiring()`（模块私有 `WeakSet` 对象身份判定，照 `media/service.ts` 的 `approveRealMediaWiring`）＋ 纯决定函数 `resolveModerationLiveWiring()` ＋ 装配层唯一入口 `moderationServiceAssemblyOption()`。**不含网络实现、不含凭据值、不读 `process.env`、不读文件、不写台账、从不抛错。** |
| `services/api/src/app.ts` | 改 **6 行 / 删 6 行（净 0 行）** | `services/api/src/app.ts:229` 同一行追加 import；`services/api/src/app.ts:512` 在既有注入项类型行内追加 `liveApproval?: unknown`；`services/api/src/app.ts:932-934` 把原有三行注释改写成三与门口径；`services/api/src/app.ts:938` 把 `executionMode: config.executionMode,` 换成 `...moderationServiceAssemblyOption({...})`（返回 `{ executionMode, liveWiring? }`）。**刻意净 0 行**：`app.ts` 的行号是 `docs/architecture/contract-status.json` 与 `docs/**` 手写锚点的指向对象，插行会让成批锚点漂移（见 `tools/verify-doc-anchors.mjs` 的基线说明与其 accept 账本里的历史事故）。 |
| `services/api/src/config.ts` | 追加块（文件末尾）＋ `loadConfig` 返回对象**追加 1 个键** | `asModerationLiveConfig()`：仅 `real` 才非 `null`；只读共享 `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` / `TENCENTCLOUD_SESSION_TOKEN`（id/key 任一缺失即 `null`，**不逐字段混配**）；`redactedCredentials()` 使 `JSON.stringify` 只看到 `[REDACTED]`。**不给** `policySelectionVerified` / `executionAllowed` / `bizType`（`tools/ai-config.mjs` 对审核恒 `false`、BizType 是占位值）。 |
| `tests/unit/moderation-live-wiring-assembly.test.mjs` | **新增** | 四臂矩阵、零外呼绊线、与改前逐字段等价、假 wiring 的 seam 被真的用上、拒绝形状与原因码闭集、构造失败不回显凭据、装配层从不铸造。 |
| `tests/fixtures/retryable-fallbacks.json` | 登记 +1 条 | 新站点 `moderation/live-assembly.ts` 的 `refusalOf`（`retryable: false`，判据是「未接线 ⇒ 不可重试」），`owner: GY-I14`。 |
| `docs/verification/gy-r70-moderation-live-wiring-20261030.md` | **新增** | 本页。 |

### 三与门的精确口径

| 与门 | 判据 | 不满足时的行为 |
|---|---|---|
| ① 执行模式 | `executionMode === 'real'`（字面量） | 不接线；**不算失败**（`refusal === null`），走既有替身端口 |
| ② 显式批准能力 | `moderationInjection.liveApproval` 必须是 `approveModerationLiveWiring()` **铸造的对象身份**（形状相同的字面量 / `Object.create` 派生 / 结构化克隆一律无效） | `refusal.reason = 'missing_approval'` ⇒ 503 |
| ③ 凭据齐备 | `config.moderationLive.credentials`（仅 real 且共享配对齐备才非 `null`） | `refusal.reason = 'missing_credentials'` ⇒ 503 |
| （构造期复核） | 剖面/凭据/策略任何一项不合法 ⇒ `createLiveModerationPortsFromWiring` 返回 `null` 或抛错 | `refusal.reason = 'invalid_configuration'` ⇒ 503，**不重抛** |

### 可判定性（失败长什么样）

- 对外仍是**既有契约码** `PROVIDER_UNAVAILABLE`（HTTP 503，`retryable: false`），message 与改前**逐字相同**；
- 拒绝描述 `ModerationLiveWiringRefusal` 与 HTTP 错误封套的 `details[]` 同形：
  `{ errorCode: 'PROVIDER_UNAVAILABLE', retryable: false, reason: <闭集>, details: [{ field: 'reason_codes', code: 'MODEL_NOT_EVALUATED' }] }`；
- ⚠️ `MODEL_NOT_EVALUATED` **不是** HTTP 错误码（422/503 才是），它只作 `details[].code`；本页与会话记录都不把它读成状态码；
- 启动日志只有一行闭集原因：`GY-R70 审核域真实接线未成立：reason=<闭集>（PROVIDER_UNAVAILABLE/MODEL_NOT_EVALUATED）⇒ …`。
  **日志里没有异常文本、没有任何配置值**（构造失败在 `catch {}` 里折成闭集原因，异常对象不外传）。

---

## 3. 证明了什么

1. **矩阵 A（三与门全过）**：`app.moderationService.capabilities()` 从 `state:'none', ready:false, origin:'none'` 变成
   `state:'wired', ready:true, origin:'injected'`，且**不出现**拒绝日志。`wired` 只可能来自 `liveWiring`：
   `resolveModerationPorts` 的 real 分支只认 `live`。
2. **矩阵 B/C/D（任一不满足）**：`liveWiring` 键**根本不出现**，服务回到既有整域 fail-closed：
   `capabilities().{text,image}.state === 'none'`，送审抛 `PROVIDER_UNAVAILABLE` / `retryable:false`。
3. **等价性**：「不满足条件」时与**改前**逐字段相同——用例不是凭印象写死字符串，而是直接拿改前的那次调用
   `createModerationService({ executionMode: 'real' })` 做对照，断言 `{code, message, retryable}` 三者 `deepEqual`。
4. **零外呼**：见 §5。
5. **假 wiring 被真的用上**：注入的 `fetchImpl` 就是真实端口的 `seams.fetchImpl`（`ports.tms.seams.fetchImpl === seamFetch`），
   一次送审**恰好**调用它 1 次（零重试），而 `globalThis.fetch` 计数仍为 0。
6. **装配层从不自我批准**：全 `services/api/src/**` 去注释后 `approveModerationLiveWiring(` 只出现 **1** 次（定义处）；
   任何装配层调用都会让用例 ⑧ 变红。
7. **既有结构钉子照旧成立**：`app.ts` / `server.ts` 仍不 import `tms-live-adapter` / `ims-live-adapter` / `live-tc3` /
   `live-vendor` / `createLiveModerationTextPort` / `createLiveModerationImagePort`。
8. **原因码闭集未漂移**：`MODERATION_LIVE_REFUSAL_REASON_CODE` 与 `packages/moderation/model-reason-codes.mjs` 的
   `MODEL_REASON_CODES` / `MODEL_FAILURE_REASON_CODES` 逐项一致（用例 ⑦ 直接调 `isModelReasonCode` 断言）。

---

## 4. 没证明什么（诚实边界）

- **没有真实凭据 ⇒ 本页不证明审核策略有效，也不证明违规样本会被拦。** 三与门全过的臂里，端口是**真实适配器对象**
  （`provider.synthetic === false`、`provider.biz_type` 来自批准能力），但**一次真实外呼都没发**（网络被绊线）。
  「能构造出真实端口」≠「供应商会接受这份剖面」≠「审核结论正确」。
- **不证明 BizType 正确**：`bizType` 由批准能力注入，本片没有任何东西能证明它对应腾讯云控制台里那份策略。
- **不证明申请/计费/配额**：真实账号、付费授权、配额都不在本片范围内。
- **图片端口仍拿不到字节**：`imageSource` 缺省是 `createUnwiredModerationImageSource`（对象存储属媒体域，本片不接）
  ⇒ 图片送审在**取不到待审图片**处 fail-closed。所以矩阵 A 里 `image.state === 'wired'` 只表示「端口是真实端口」，
  **不表示**图片能被审。
- **生产入口 `server.ts` 仍不铸造批准能力** ⇒ 今天的生产行为与改前**逐字相同**（仍是整域 503）。这是刻意的：
  派单把交付面钉在 `app.ts`，而「要不要开、用哪个启动开关开」是需要裁定的点（见 §8）。
- **不证明跨域效果**：社区投递（`POST /posts`）的 422/503 语义、审核结论落库、发布闸门都在既有用例里，本片未改；
  本片只改「装配是否传 `liveWiring`」。
- **`real` 下的真实链路（真实 tms/ims → 合流 → 台账 → 发布闸门）没有跑过**，本页所有读数都来自离线夹具。

---

## 5. 四种装配矩阵实测

环境：`loadConfig(<合成 env>)` ＋ `buildApp({ config, store: persistentAuthStore(), logStream })`；
监听面**只读**（不调 `submitScreening` 于 real 臂，避免任何端口调用）；`globalThis.fetch` 已被换成计数器。

| 臂 | 执行模式 | 凭据 | 显式批准 | `capabilities().text` | `capabilities().image` | 送审 | 拒绝原因（日志） |
|---|---|---|---|---|---|---|---|
| **A** | `real` | 齐备 | 已铸造 | `wired` / `ready:true` / `origin:'injected'` | `wired` / `ready:true` | 不再 503（未在本臂调用） | 无（不写拒绝日志） |
| **B** | `real` | **缺失** | 已铸造 | `none` / `ready:false` / `origin:'none'` | `none` / `ready:false` | `PROVIDER_UNAVAILABLE` / `retryable:false` | `reason=missing_credentials` |
| **C** | `stub` | 环境里有 | 已铸造 | `substitute` / `ready:false` / `origin:'substitute'` | `substitute` / `ready:false` | 走既有替身（隔离，不放行） | — （非 real 不算失败） |
| **D** | `real` | 齐备 | **缺失/伪造** | `none` / `ready:false` | `none` / `ready:false` | `PROVIDER_UNAVAILABLE` / `retryable:false` | `reason=missing_approval` |
| **D′** | `real` | 齐备 | 伪造（`Object.create(approval)` 派生） | 同上 | 同上 | 同上 | 同上（身份判定不认派生） |
| **E**（构造失败） | `real` | 齐备 | 已铸造但 `bizType='bad biz*type'` | `none` | `none` | `503`（**不抛错**） | `reason=invalid_configuration` |

「送审」两列的 `{code, message, retryable}` 与**改前**同一次调用 `deepEqual`（用例 ② 的等价性断言）。

判据读数的空转反查：A 臂若把 `liveWiring` 去掉，`capabilities()` 立刻回到 `none`（用例 ① 就是钉这个）；
B/C/D 臂若强行传 `liveWiring`（负控制 ①/③），用例立刻变红。

---

## 6. 「零外呼」怎么证的

手法照 `tests/unit/ai-live-provider-wiring.test.mjs` 的头注：把 `globalThis.fetch` 换成**计数器 + 立即拒绝**，跑完整条装配路径。

```
const original = globalThis.fetch;
const calls = [];
globalThis.fetch = (...args) => { calls.push(args); return Promise.reject(new Error('zero-outbound tripwire')); };
try { /* loadConfig + buildApp × 四臂 + capabilities() */ } finally { globalThis.fetch = original; }
assert.equal(calls.length, 0);
```

- 用例 ⑤ 一次覆盖**四臂**（A/B/C/D）的 `loadConfig` + `buildApp` + `capabilities()`：`calls.length === 0`；
- 用例 ①③④ 各自在 `withFetchTripwire` 里跑完同样路径，同样断言 0；
- 用例 ⑥ 是**反向**的：它用一个假的 `fetchImpl` 注入 wiring，断言「被调用的是**这个 seam**（恰好 1 次）」
  且「`globalThis.fetch` 一次都没被碰」——证明我们数的不是"没人用网络"而是"用了我们指定的那条 seam"；
- 判据不是"抛了什么"，只数**次数**：装配期只要碰一次网络，`calls.length` 立刻 > 0。

---

## 7. 门禁读数

| 门禁 | 命令 | 结果 |
|---|---|---|
| 单测 | `npm run test:unit`（`GY_BASH=D:\Git\bin\bash.exe`） | 见 §7.1 |
| 锚点（npm 扫描面） | `npm run verify:anchors` | exit 0（`PASS: 中文表格一致`；`PASS: --strict 下没有基线之外的新增`；`ANCHOR_DRIFT 15 条全在基线内`） |
| **锚点（CI 口径）** | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | **exit 0**（`--strict` 无基线外新增；`BARE_ORPHAN 3543/3543`、`outsideRed 135/135`、`SYMBOL 31/31`、`ANCHOR-COUNT` 无「面内却扫不到」） |
| 契约漂移 | `npm run verify:parity` | exit 0（`extra: []`、`missing: []`、`ledgerDrift: []`） |
| 能力图 | `npm run verify:capability-map` | exit 0（`totalOps=46，有入口=46，无入口=0，死按钮=0`；`文档标记块与重算一致`） |
| 文档 | `npm run test:docs` | exit 0（研究记录 5 通过 / 0 失败 / 4 legacy 钉住；research 结构校验 PASS） |
| 静态检查 | `npm run lint` | exit 0（`tsc --noEmit` 两个 tsconfig ＋ 仓库卫生扫描） |
| 契约测试 | `npm run test:contract` | exit 0 |
| 构建 | `npm run build`（`TMP`/`TEMP` 指到仓外；构建后删 `services/api/dist` 与 `apps/*/dist`） | exit 0（`tsc -p tsconfig.json` 无错；admin `vite build` 通过） |
| 失败矩阵 | `npm run test:failmatrix` | 见 §7.2 |

### 7.1 单测

`npm run test:unit`（`tests/unit/**` + `tests/privacy/**` + `tests/media/**` + `tests/reference/**` + `tests/moderation/**`）：
**5783 条：通过 5779 / 失败 0 / skipped 2 / todo 2**（exit 0；本片新增的 9 条用例全绿）。
- 2 条 `todo` 是 `i11-audio-mp3-wav-guard` 里**本片之前就登记**的缺口（带原因的 `todo`，不是失败）；
- skipped 2 条是既有的「环境不满足 ⇒ 带原因跳过」（不是静默通过）；
- ⚠️ 若在同一棵树上**未提交**就跑这条门禁，`tests/unit/doc-anchor-relocation-identity.test.mjs` 会以
  「base 与 HEAD 同一提交 ⇒ 本用例没有判定面却也不是 CI 浅克隆」**硬红**——那是它刻意的自我保护
  （不许静默通过），提交后 `base=53354fe7`、文档改动面只有本页这一份**新增文件**（纯新增 hunk ⇒ 显式 SKIP），
  该用例转绿（读数见 §7.3）。

### 7.2 失败矩阵

`npm run test:failmatrix`：**矩阵合计 249 条：PASS 249 / FAIL 0**（exit 0）。
其中与本片同域的两组：`D1 审核回调（重复/旧版本/下架/授权撤回 ⇒ 拒绝；回调绝不发布）` 11 条全 PASS、
`B3 批次 3：审核回调 / AI 失败 / 下架缓存（受信 seam）` 17 条全 PASS。

### 7.3 提交后复跑的两条（读数为提交后的树）

| 命令 | 结果 |
|---|---|
| `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 通过（文档改动面＝本页纯新增 ⇒ 显式 SKIP，报出纯新增 hunk 数） |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | exit 0，且**三份锚点册一条未改**（`git status` 只含本片 6 个文件） |

---

## 8. 负控制（实际打红 → 恢复复绿）

改一处 → 跑 `node --test tests/unit/moderation-live-wiring-assembly.test.mjs` → 记录红 → 还原 → 再跑绿。
脚本在仓外（`E:\GengYunCommander\.tmp-r70-nc.mjs`），不提交。

| # | 负控制（把某条判据打掉） | 改动 | 结果 |
|---|---|---|---|
| ① | 让「缺凭据」也传 `liveWiring` | `if (false && !hasCredentials(...))` ＋ 用占位凭据硬造 | **exit 1**，`pass 7 / fail 2`：✖ ② 矩阵 B、✖ ⑦ 拒因形状 |
| ② | 构造失败后回退成「无审核放行」 | 装配片段在 `wiring === null` 时返回 `executionMode: 'stub'`（退回替身端口，不再是 503） | **exit 1**，`pass 6 / fail 3`：✖ ② 矩阵 B、✖ ④ 矩阵 D、✖ ⑦ 构造失败 |
| ③ | 让非 real 也传 | 删掉 `if (input.executionMode !== 'real') return …` 的守卫 | **exit 1**，`pass 8 / fail 1`：✖ ③ 矩阵 C |
| ④ | 把 `details[].code` 抹掉 | `details: Object.freeze([])` | **exit 1**，`pass 7 / fail 2`：✖ ② 矩阵 B、✖ ⑦ 拒因形状 |
| — | 复原后 | 原文件逐字节恢复 | **exit 0**，`pass 9 / fail 0` |

四条都真的把对应判据打红了，且复原后立刻复绿——说明这些断言看的是**行为**，不是自言自语。

---

## 9. 需要裁定的点

1. **「批准能力」的口径要不要做成启动开关？** 现状：铸造点 `approveModerationLiveWiring()` 只存在于库里，
   生产入口 `server.ts` **不调用**（因此今天的行为与改前逐字相同）。若要真开，需要第二步（同样是显式、可审查的一行变更）：
   `server.ts` 解析一个 `--approve-moderation-live-wiring`（或等价的有名开关）→ 用**运维给的** `policySource` 与 `bizType` 铸造
   → 放进 `buildApp({ moderationInjection: { liveApproval } })`。派单把交付面钉在 `app.ts`，所以本片**没有**接这一步。
   - 备选：把 `bizType` / `policySource` 放进部署配置（env 或私密配置），由装配层读进来。**不建议**：那等于「配置即门控」，
     `media/service.ts` 的两轮对抗复审结论（`RealMediaWiringApproval` 的注释）已经否掉过这条路。
2. **图片字节来源（`imageSource`）谁接？** 现在缺省未接线 ⇒ 图片送审只能 fail-closed。若要真审图，需要媒体域提供
   「按 `media_id` + `revision` 取字节」的只读端口（并解决社区侧只传 `media_id`、ims 端口收不到 `mime` 的既有缺口）。
   这属于跨域改动，本片不做。
3. **拒绝原因要不要有可读面？** 现在只有一行启动 warn 日志 ＋ 单测可读的 `refusal` 对象。是否要把
   `moderation_live_wiring` 状态挂到 `/health` 或后台只读面（会让 `docs/architecture/contract-status.json` 多一条 operation）？
   需要派单决定——本片按「不新增 op」处理。
4. **`policySelectionVerified` 的语义**：本片让「批准」这一动作直接给出 `policySelectionVerified: true` / `executionAllowed: true`
   （因为 `tools/ai-config.mjs` 对审核恒 `false`，配置侧永远推不出授权）。如果监工认为这两个布尔必须有**独立于批准**的核对证据
   （例如控制台截图/策略导出），那批准能力就要拆成两段（核对 + 授权），本片需要返修。

---

## 附录 A · `git grep -n liveWiring -- services/api/src`（改前）

```
services/api/src/moderation/service.ts:134:  liveWiring?: ModerationLiveWiring;
services/api/src/moderation/service.ts:453:    // real：**永不**回退替身。有凭据且显式打开（`liveWiring`）⇒ 用真实端口走完整服务；
services/api/src/moderation/service.ts:455:    const livePorts = deps.liveWiring === undefined ? null : createLiveModerationPortsFromWiring(deps.liveWiring);
```

（改后新增 `app.ts:229` / `app.ts:512` / `app.ts:938` 三处引用，以及新文件 `moderation/live-assembly.ts`。）

## 附录 B · 为什么 `app.ts` 一定要「净 0 行」

`docs/architecture/contract-status.json` 与 `docs/**` 里有一批**手写行号**锚点指向 `app.ts`；`app.ts` 一插行，
这些锚点会成批漂移，触发 `verify-doc-anchors` 的 `ANCHOR_DRIFT` / `COMMENT_ANCHOR` / `BARE_ORPHAN` 三套基线，
而 `docs/verification/**` 是**历史读数、按仓规不许改数字**。本片因此把「三与门 + 理由」放进
`moderation/live-assembly.ts` 的 `moderationServiceAssemblyOption()`，让 `app.ts` 只做一处**等行替换**
（6 行换 6 行），从而三套锚点基线一条都不动。

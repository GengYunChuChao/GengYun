# GY-I13 语音合成任务语义收口（超时可见 / 重试幂等 / 归属与访问 / 模式交叉）验证

日期：2026-10-19（北京时间）。口径：`Refs #13`，**不关闭整项**（本片只交付可离线验证的服务端语义与断言，不声称任何真实合成能力）。

- 写手＝本 worktree、本分支；推送＝指挥。**本 worktree 内不 push、不改共享 remote/配置、不评论 issue/PR**。
- 本片**未**接入任何真实 TTS 供应商，**未**发起任何付费或真实模型调用，**未**产生任何真实音频。
- 本页所有数字与结论都来自下方逐条原始输出；凡未跑的命令一律不写「通过」。
- GY-I11（转写确认）**不在本片**：由他线 PR #294（作者 `cxhhandsome`，分支 `step/gy-i11-transcript-confirm-20261019`）覆盖，本片不重复、未触碰其文件（见 §3.4）。

## 0 工作区与基线

| 项 | 值 |
| --- | --- |
| 共享仓库 | `E:\GengYunCommander\GengYun_Agent2`（本片**只读**，未改其分支/文件） |
| worktree | `E:\GengYunCommander\.pg17\wt-i11i13-voice` |
| 分支 | `feat/gy-i11i13-voice` |
| 基线 `upstream/main` | `8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`（与同仓 `upstream` 引用一致；本片未 `fetch`，未动远端） |
| 干净对照树 | `E:\GengYunCommander\.pg17\tmp\i11i13-base`（`git worktree add --detach … 8cc9dd8`，`git status --porcelain` 为空） |
| 依赖 | 两棵树各自 `npm ci --ignore-scripts`：added 103 packages，0 vulnerabilities（**无** junction/symlink 指向别处 `node_modules`） |
| HEAD | 本页自身随最后一个提交落地，SHA 以回传为准（§6） |

## 1 先审后改：两处「不成立」与一处「受限成立」

审计覆盖 `services/api/src/tts/**`、`services/api/src/routes/{synthesis,media}.ts`、`services/api/src/jobs/**`、`services/api/src/app.ts` 与相关单测/集成脚本。结论：**受理、占位幂等、失败面、归属面在基线已相当完整**，真正的语义缺口只有两处，且都在「读面」这一侧：

1. **读面无超时裁定（AC-2 后半不成立）**。`inspectJob`（`services/api/src/tts/service.ts:652`）在 `getOwnedJob` 之后直接投影；若执行器没落终态（受理后进程重启、`store.updateJob` 抛错/返回 null、执行器缺失），任务停在 `queued`/`running`，读面会**永远**回报 `queued` —— 与「任务失败/超时必须显式状态（不得静默变成功）」相冲突。既有断言只覆盖执行器自己的 deadline 竞速（`tests/unit/tts-service.test.mjs:640`：注入 `jobDeadlineMs: 30` 让 `runProviderWithDeadline` 自己超时），**没有**覆盖「执行器缺席时读面怎么呈现」。
2. **模式交叉会撒谎（AC-4 后半不成立）**。任务行不记录受理时的执行模式（改前 `services/api/src/tts/store.ts:26-33` 无该字段），`real` 装配可以直接把 `stub` 受理的 `succeeded` 任务读成 `error_code: null` + `result` —— 替身标注产物就此冒充真实合成结果。既有断言只有「real 缺凭据 ⇒ 受理前 503」（`tests/unit/tts-jobs-http.test.mjs:307`），**没有**「已受理的任务标识在另一种装配下如何呈现」的断言。
3. **音频访问受限成立（AC-3 后半）**。合成产物的 `media_id` 属 TTS 替身产物自持 Map（`services/api/src/tts/media.ts:67`），与媒体域表（`services/api/src/media/media.ts:467`）不同源；契约 85 条路径里**没有** owner 私有媒体字节读取 operation（唯一返回字节者要求 `community_image` + `published/approved`，且需 `X-Media-Access-Token`：`services/api/src/routes/media.ts:337-345`）。该事实已由裁定 `E:\GengYunCommander\.pg17\ruling-451-narrow-scope.md` 缩片，本片只补「无隐式出口」的断言，**不放开契约**。

## 2 逐条对照

| # | 范围条目 | 代码锚（路径:行号 + 符号） | 既有断言（文件:行号） | 结论 | 本片动作 |
| --- | --- | --- | --- | --- | --- |
| A | 任务创建：202 + queued Job + `ETag`/`no-store` + `Idempotency-Key` | `services/api/src/routes/synthesis.ts:112`（`app.post`）、`:171`（ETag）、`:47-52`（缺键 ⇒ `IDEMPOTENCY_KEY_REQUIRED`）；`services/api/src/tts/service.ts:231`（`createSynthesisService`） | `tests/unit/tts-jobs-http.test.mjs:129`、`:219`；`tests/unit/tts-service.test.mjs`「反例·缺失或非法 Idempotency-Key」 | 成立 | 无改动 |
| B | 轮询/完成：`GET /jobs/{id}` 九键投影、`result` 四键、ETag=revision、`no-store`、终态不被迟到结果复活 | `services/api/src/jobs/registry.ts:278`（`assertContractJob`）、`:177`；`services/api/src/tts/service.ts:209`（`toJob`） | `tests/unit/tts-jobs-http.test.mjs:129`；`tests/unit/tts-service.test.mjs`「存储不变量·终态任务不可被迟到结果复活」 | 成立 | 无改动 |
| C | 失败显式：配额/未知/抛异常/落库失败 ⇒ `failed`，超时 ⇒ `timed_out`，绝不 `succeeded`，`result=null` | `services/api/src/tts/service.ts:535`（`execute`）；`services/api/src/tts/state.ts:379`（`stateForProviderFailure`） | `tests/unit/tts-service.test.mjs:640`、`:651`、`:661`、`:670`、`:702`、`:715`；`tests/unit/tts-jobs-http.test.mjs:219` | 成立 | 无改动 |
| D | **失败/超时在「读面」也显式**（执行器缺席时不得永远 `queued`） | 改后新增 `services/api/src/tts/service.ts:399`（`adjudicateExpiredJob`）、`:106`（`JOB_EXPIRY_GRACE_MS`） | 改前**无**（`tests/unit/tts-service.test.mjs:640` 只覆盖执行器内竞速） | **不成立 → 已补** | 服务端 +1 语义函数；用例 `tests/unit/tts-service.test.mjs:1130` |
| E | 重试路径存在且幂等：不得重复计费、不得两条活跃任务 | 占位幂等 `services/api/src/tts/service.ts:231`（`claimIdempotentScope`/`awaitPlaceholder`/`commitTerminal`）；live 适配器零重试 `services/api/src/tts/provider.ts:196-209`（`assertLiveTtsProfile`：`maxRetries !== 0` 即拒） | `tests/unit/tts-service.test.mjs:877`（成功任务重放）、「并发·同键同体」「并发·同键异体」 | 成功路径成立；**失败任务重放/换键重试无断言** | 用例 `tests/unit/tts-service.test.mjs:1187` |
| F | 归属：跨用户访问同形 404 | `services/api/src/tts/service.ts:359`（`getOwnedJob`）、`:366`（`getOwnedSynthesis`） | `tests/unit/tts-service.test.mjs:1036`；`tests/unit/tts-jobs-http.test.mjs:183` | 成立 | 无改动（新用例顺带加固媒体域一侧） |
| G | 归属与 revision 绑定：结果必须属于受理时的 `target_ref`+revision，改后 fail-closed | `services/api/src/tts/service.ts:535`（执行期重读 `readAndDecide(…, 'execute')`）；`services/api/src/tts/state.ts:335`（`decideCheckedContent`） | `tests/unit/tts-service.test.mjs`「受理后内容被修订 ⇒ REVISION_CONFLICT」「受理后核对被撤销 ⇒ INPUT_UNCERTAIN」「受理后核对源读取失败 ⇒ OBJECT_UNAVAILABLE」、`:963` | 成立 | 无改动 |
| H | 音频访问：需要显式凭据，合成 `media_id` 在媒体域无隐式出口 | `services/api/src/routes/media.ts:298`（`POST /media/:id/access`，`ifMatch`/`idempotencyKey` 交服务层校验）、`:337-345`（字节出口 + `X-Media-Access-Token`）；`services/api/src/tts/media.ts:67` | 媒体域既有单测（非本片）；**合成产物跨域读取无断言** | **受限成立 → 补断言** | 用例 `tests/unit/tts-jobs-http.test.mjs:389` |
| I | **模式交叉不撒谎**：stub 受理的任务标识在 real 装配下 503 可解释 | 改后新增 `services/api/src/tts/service.ts:383`（`assertJobMode`）、`:473`（任务行写入受理模式）、`services/api/src/tts/store.ts:33`（`executionMode` 内部字段） | 改前**无**（仅有 `tests/unit/tts-jobs-http.test.mjs:307` 的「real 缺凭据受理前 503」） | **不成立 → 已补** | 服务端 +1 护栏；用例 `tests/unit/tts-jobs-http.test.mjs:348` |
| J | real 装配缺供应商 fail-closed | `services/api/src/tts/provider.ts:141`（`createRealTtsProvider`，缺 endpoint/apiKey ⇒ `available:false`）；`services/api/src/tts/service.ts:444` | `tests/unit/tts-jobs-http.test.mjs:307`；`tests/unit/tts-service.test.mjs`「反例·real 缺凭据」 | 成立 | 无改动 |
| K | 真实音频可播 | —（契约层无客户端音频字节出口） | 无（不可能有） | **结构性不可达** | 不在本片；如实登记 §7/§8 |

## 3 改动

### 3.1 服务端（2 文件，最小改动）

| 文件 | 改动 |
| --- | --- |
| `services/api/src/tts/store.ts` | `SynthesisJobRow` 增必填内部字段 `executionMode: ExecutionMode`（`:33`，注释标明「不是契约字段、不进任何投影」）；`import type` 加 `ExecutionMode`（`:21`）。**无迁移**：该 store 本基线只有内存实现。 |
| `services/api/src/tts/service.ts` | ① 文件头 fail-closed 清单增两条（超时读面显式化、模式交叉不撒谎）；② 新增 `export const JOB_EXPIRY_GRACE_MS = 5 * 1000`（`:106`）；③ 新增 `assertJobMode`（`:383`）；④ 新增 `adjudicateExpiredJob`（`:399`）；⑤ `createSynthesis` 落任务行写入 `executionMode: provider.executionMode`（`:473`）；⑥ 重放分支先 `assertJobMode` 再 `adjudicateExpiredJob`；⑦ `inspectJob` 先 `assertJobMode` 再 `adjudicateExpiredJob`，用裁定后的行投影（`:652`）。 |

**`assertJobMode(row)`**：`row.executionMode !== provider.executionMode` ⇒ `ApiError('PROVIDER_UNAVAILABLE', '该任务由 <记录模式> 模式受理，当前装配为 <当前模式> 模式，无法解释其状态', { retryable: false })`。选 `PROVIDER_UNAVAILABLE`/`retryable:false` 的理由：这是「能力未装配」，不是瞬时故障，与既有「real 缺凭据」同族；错误封套由既有全局处理器统一产出，客户端无需新分支。**验收范围（对齐裁定 ②）**：模式护栏的验收范围＝**同一 store 实例内**一致（用例让两种装配共享同一个 `createMemorySynthesisStore()`）；多实例（不同进程共享同一 PG）下的行为**未取得**——本片没有 PG store，也没有多进程夹具。

**`adjudicateExpiredJob(row)`**：只处理 `queued`/`running`；`now() < deadlineAt + JOB_EXPIRY_GRACE_MS` 则原样返回；否则 `store.commitTerminal(row.id, row.revision, { state:'timed_out', errorCode:'PROVIDER_TIMEOUT' }, null, at)`（CAS，期望 revision 为刚读到的 revision）。CAS 返回 `null` ⇒ 以 `store.getJob(row.id)` 为准，不覆盖、不重试。**不写合成记录**：超时没有产物，绝不凭空给 `media_id`。宽限 5s 的用途：只把「截止前已完成、提交晚了几毫秒」这条竞态让给执行器（成功与超时谁先提交由 store 的 CAS 决出）。**为什么是这个值**：相对默认 `jobDeadlineMs = 30s` 取 ≈1/6 的余量——足够覆盖一次 CAS 提交加事件循环/往返的收尾延迟，又远小于截止期，不会把「真挂起」拖到很久之后才显式化；宽限窗口内读面只会看到 `queued`/`running`（绝不误报成功），所以放宽几秒不改变「不得静默变成功」。`JOB_EXPIRY_GRACE_MS` 是导出常量，若将来截止期调到秒级，可据此按比例复核。

不改契约、不改 `docs/architecture/contract-status.json`、不新增端点、不改接口形状、不写迁移、不动 `app.ts` 装配（仍是零端口注入）：两处语义都落在既有 `Job`/`JobState` 闭集之内（`timed_out` 与 `PROVIDER_TIMEOUT` 均为既有取值，`executionMode` 不进投影）。

### 3.2 测试（2 文件，4 例，均只用既有夹具）

| 文件 | 新增用例（pin 住什么） |
| --- | --- |
| `tests/unit/tts-service.test.mjs:1130` | 超时裁定：让 `store.updateJob` 返回 `null` 使任务停在 `queued`（等价执行器缺席）；冻结时钟推进到 `deadline+grace-1` 仍 `queued`，`+1ms` ⇒ `timed_out` + `PROVIDER_TIMEOUT` + `result=null` + `revision+1` + 二次读 revision 不变 + 提供者调用 0 次 + 只建了 1 个任务 + 无合成记录。 |
| `tests/unit/tts-service.test.mjs:1187` | 重试幂等：配额失败 ⇒ `failed`；同键重放 `replayed=true`、同 id、仍 `failed`、提供者调用不增、任务数不增、revision 不变（**不复活**）；换新键 ⇒ 新任务 succeeded，旧任务仍 `failed`（**不留两条活跃任务**，每个新任务恰好一次提供者调用）。 |
| `tests/unit/tts-jobs-http.test.mjs:348` | 模式交叉：stub 装配受理并成功读出 `media_id`，real 装配（共享内存 store/auth）读同一任务退 `503`/`PROVIDER_UNAVAILABLE`/`retryable:false`、message 含 stub 与 real、无 `data`、不泄露 `media_id`；stub 复读 `revision` 与 `result` 不变。 |
| `tests/unit/tts-jobs-http.test.mjs:389` | 归属与访问：合成 `media_id` 在媒体域 `GET /media/{id}` 属主 404 与不存在媒体同形（`error` 深等）、他人 404 同形；`POST /media/{id}/access`（带 `If-Match`/`Idempotency-Key`）属主与他人皆 404 `NOT_FOUND`。 |

夹具：`tests/unit/tts-jobs-http.test.mjs` 的 `buildFixture` 增**可选** `options.auth` / `options.store` / `options.actorA` / `options.actorB`（不传时行为与改前逐字相同），仅用于让两个装配共享同一 store 与同一认证体，以构造「同一任务被另一种模式读取」这一跨装配场景。

### 3.3 重试三态实测（同键成功重放 / 同键失败重放 / 换新键）

| 场景 | 响应字段（`data` + `meta.replayed`） | `providerCalls` | `insertJobs` | `revision` |
| --- | --- | --- | --- | --- |
| A 同键**成功**重放（首次 `succeeded` 后再 POST 同键同体） | `replayed:true`、id 与首次相同、`state:succeeded`、`error_code:null`、`result.kind:"synthesis"` | 1（不增） | 1（不增） | 3（不增；首次成功即 3） |
| B 同键**失败**重放（配额失败后再 POST 同键同体） | `replayed:true`、id 相同、`state:failed`、`error_code:"PROVIDER_QUOTA_EXCEEDED"`、`result:null` | 1（不增） | 1（不增） | 3（不增；**不复活**） |
| C **换新键**（失败后换 `Idempotency-Key` 再 POST） | `replayed:false`、**新 id**、受理响应 `state:"queued"`/`revision:1`；落定后 `state:"succeeded"`/`revision:3` | 2（旧 1 + 新 1） | 2（旧 + 新） | 旧任务仍 `failed`/`3`；新任务终态 3 |

取数方式：一次性探针 `.pg17\tmp\i13-probe.mjs`（stub 提供者 + 内存 store，对 `insertJob` 与 `synthesize` 计数；**不入库、不在仓库内**），revision 走 `queued(1) → running(2) → 终态(3)`。C 行同时证明「不留两条活跃任务」：旧任务已是终态 `failed`，新的才是活跃/成功任务。

### 3.4 未改动的相邻面

`packages/contracts/**`、`docs/architecture/contract-status.json`、`db/**`（含迁移）、`miniprogram/**`、`services/api/src/app.ts`、`services/api/src/routes/**`、`services/api/src/jobs/**`、`services/api/src/media/**`、`services/api/src/speech/**` 全部**未改**。禁改清单（`docs/ui-state-inventory.md`、`docs/verification/gy-i11-transcript-confirm-20261016.md`、`miniprogram/pages/voice/**`、`miniprogram/utils/speech-transcript.js`、`package.json`、`tests/integration/transcript-confirm-http.mjs`、`tests/unit/miniprogram-transcript-confirm.test.mjs`、`tests/unit/miniprogram-voice-playback.test.mjs`、`tools/prepare-wechat.mjs`）**一处未碰**（见 §5 `git status --porcelain` 与 §6 提交清单）。

## 4 测试原始输出

### 4.1 受影响单测（本树，`node --test <file>`，默认逐文件隔离）

```
✔ 超时裁定·执行器没落终态时，过截止（+宽限）的任务必须在读面显式落 timed_out，绝不永远报 queued (0.324ms)
✔ 重试·失败任务同键重放不复活、不再调提供者；换新键重试允许，旧失败任务保持原样且不留两条活跃任务 (0.4919ms)
✔ 模式交叉·stub 受理的任务标识在 real 装配下 503 可解释，绝不把替身产物当成 real 的成功作业读出 (85.1311ms)
✔ 音频归属与访问·合成 media_id 在媒体域无隐式出口：属主读与不存在同形 404，他人读同形 404（需显式凭据） (47.4426ms)
ℹ tests 56   (tts-service.test.mjs 45 + tts-jobs-http.test.mjs 11)
ℹ pass 56
ℹ fail 0
ℹ skipped 0
```

### 4.2 全量单测与干净基线对照（默认逐文件隔离）

同一命令：`node --test "tests/unit/*.test.mjs"`（**不加** `--test-isolation=none`，按 `.pg17\ruling-test-method-20261019.md` 的新口径）。

| 树 | tests | pass | fail | skipped | 退出码 |
| --- | --- | --- | --- | --- | --- |
| 本片 worktree（含新增 4 例） | 1621 | 1620 | 0 | 1 | 0 |
| 干净基线 `8cc9dd8`（`.pg17\tmp\i11i13-base`） | 1617 | 1616 | 0 | 1 | 0 |

两树失败集合均为空，无「仅在本树失败」项；增量 1621−1617 = 4 恰好是本片新增用例。

**口径更正**：早前以 `--test-isolation=none` 跑同一套件时，本树报 8 条 `knowledge-*` 失败（干净基线同样 8 条、同名同数）。该现象已被 `.pg17\ruling-test-method-20261019.md` 裁定为**环境现象，不是回归**：`tests/unit/favorites-visibility-wiring.test.mjs:34` 在共进程模式下写模块级 env，串染到后续 knowledge 用例；默认隔离下自动消失。本页此后一律以默认隔离读数为准，之前的 8 红清单不再作为回归判据（保留于交接记录中备查）。

### 4.3 集成（逐个直跑，不经 `npm`）

`node tests/integration/tts-http.mjs`（真实产品装配 `buildApp` + 回环 HTTP；合成身份 + 替身提供者 + 内存 store；未发出任何对外/付费请求）：

```
PASS  S01 结构·app.ts（去注释）不 import 真实适配器端口构造器；接线恰好一处调用，且 guards 槽位装旗标门 gatedGuards
PASS  T01 终态·提供者超时（注入短截止）⇒ job timed_out + PROVIDER_TIMEOUT，且 result=null
PASS  T02 终态·提供者配额失败 ⇒ job failed + PROVIDER_QUOTA_EXCEEDED，且 result=null（绝不 succeeded）
CHECKS pass=42 fail=0
SUMMARY counters: providerCalls=6 insertJobs=8（含正控制/幂等/终态用例的正常用量）
RESULT=PASS
SCOPE=product_assembly_http_loopback; 共享读面 GET /jobs/{id} 已接入 synthesis kind；缩片：stub/preset_demo 受理与读面打通；可播放来源仍不可得（P04）；real 未接线仍 503（P05）
exit=0
```

`node tests/integration/jobs-http.mjs`：`exit=0`，含「嵌套 result.value 守卫：坏投影经路由 503（改前 200 透出）」「如实性：succeeded(result≠null,error_code=null) / failed(result=null,error_code=PROVIDER_OUTCOME_UNKNOWN)」「单一注册：`/jobs/{id}` 与 `/jobs/{id}/cancel` 各 1 处」等检查。

### 4.4 类型检查

`node node_modules/typescript/bin/tsc -p services/api/tsconfig.json --noEmit` ⇒ `exit=0`（**未用** `npm run lint`：本机沙箱拦截管道 spawn，改直调 tsc）。

## 5 门禁清单（命令 + 退出码 + 关键输出）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm ci --ignore-scripts`（worktree 与基线树各一次） | 0 | added 103 packages；0 vulnerabilities |
| `node node_modules/typescript/bin/tsc -p services/api/tsconfig.json --noEmit` | 0 | 无诊断 |
| `node --test tests/unit/tts-service.test.mjs tests/unit/tts-jobs-http.test.mjs`（默认隔离） | 0 | tests 56 / pass 56 / fail 0 |
| `node --test "tests/unit/*.test.mjs"`（worktree，默认隔离） | 0 | tests 1621 / pass 1620 / fail 0 / skipped 1 |
| 同命令（基线树 `.pg17\tmp\i11i13-base`，默认隔离） | 0 | tests 1617 / pass 1616 / fail 0 / skipped 1 |
| `node tests/integration/tts-http.mjs` | 0 | `CHECKS pass=42 fail=0`；`RESULT=PASS` |
| `node tests/integration/jobs-http.mjs` | 0 | 全部检查通过（含嵌套 `result.value` 守卫 503） |
| `node tools/verify-contract-status.mjs` | 0 | PASS：覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；形状错误 0 项；语义错误 0 项 |
| `node tools/verify-contract-status.mjs --runtime` | 0 | 同上 + 「无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致」 |
| `python -B tools/validate_development_docs.py` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| `git diff upstream/main --check` | 0 | 无空白错误（`upstream/main` = `8cc9dd8`） |
| `git status --porcelain` | 0 | 仅本片 5 个文件（见 §6）；收工为空 |

## 6 提交清单（本地，未 push）

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `fix(GY-I13): 任务读面超时显式化与模式交叉护栏` | `services/api/src/tts/service.ts`、`services/api/src/tts/store.ts` |
| 2 | `fix/test(GY-I13): 语音合成任务语义收口（Refs #13）` | `tests/unit/tts-service.test.mjs`、`tests/unit/tts-jobs-http.test.mjs`、`docs/verification/gy-i13-synthesis-20261019.md`（本页） |
| 3 | `docs(GY-I13): 证据页补模式护栏验收范围与重试三态实测（Refs #13）` | `docs/verification/gy-i13-synthesis-20261019.md`（本页；评审返修：BLK-1 范围口径 + §7 一行、BLK-2 三态实测表、两处非阻塞去重/补理由，并同步默认隔离的复跑读数） |

（第 1、2 个提交对应评审 `reviewed_sha = 8fdbc02`；第 3 个提交只动本页，**未改产品代码、未改断言**。本页不记录自身 SHA，权威 HEAD 以回传为准。未 `push`，未改共享 remote，未在任何 issue/PR 上留评论。）

## 7 未取得 · 未验证

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 真实 TTS 供应商调用（腾讯云 `TextToVoice`） | **未取得** | 无真实 endpoint/apiKey；live 适配器只有单测与回环合成端口，`realAudioProduced` 恒为 `false` |
| 真实音频样本 / 音质与自然度结论 | **未取得** | 同上：替身产物是标注文本，非音频，本片不声称任何合成质量 |
| 真实 ASR / 转写确认端到端 | **未取得**（他线 PR #294 范围） | 本片不重复、未触碰其文件 |
| 真机 / 微信开发者工具 / 音频播放验收 | **未取得** | 本片未改 `miniprogram/**`；且契约层无客户端音频字节出口（§1 第 3 条） |
| PG 持久化 store 与迁移 | **未取得**（按派单不写迁移） | 本基线 TTS store 只有内存实现；`execution_mode` 落 PG 需另行加列 |
| 多实例模式交叉（不同进程共享同一 PG、各自装配不同模式） | **未取得** | 护栏验收范围＝**同一 store 实例内**一致（§3.1）；本片无 PG store、无多进程夹具，跨进程行为未观测 |
| 依赖 `bash` 的脚本校验（如 `bash -n`） | **未取得** | 本机 `bash` 为 WSL 存根，`bash -n` 空转 |
| 独立评审 / CI | **未取得** | 本片不 push、不开 PR；以上全部为本地读数 |

## 8 风险与需裁定项

1. **读面写终态（机制与理由见 §3.1，此处不重复）**：若产品要求读路径严格只读，需要裁定扫尾责任方（后台巡检 vs 读面裁定）；本片选择读面裁定，因为它是唯一能保证「用户永远看不到僵尸 queued」的位置。
2. **模式护栏的触发面**：护栏比较「任务行记录的模式」与「当前装配模式」。默认产品装配的 store 是**进程内**内存实现，两种模式共存只可能出现在共享 store（将来 PG/多实例）或显式注入场景；用例用共享 store 显式构造该场景。也就是说：本片修的是**将来会踩到的语义陷阱**，不是默认装配下可复现的故障——这一点请指挥在验收口径上认领。**验收范围仅「同一 store 实例内」一致；多实例（跨进程共享同一 PG）行为未取得（§7）。**
3. **持久化字段**：`SynthesisJobRow.executionMode` 是内部字段、不进契约投影，本片不写迁移；TTS store 落 PG 时需新增列（`execution_mode`），否则旧行无法判定模式。
4. **同键重试的产品口径**：本片按「同键 = 同一请求」实现并断言（失败任务同键重放**不复活**、不再调提供者）；「换新键重试」是允许的新任务。若产品希望「同键重试失败任务」，那是另一条语义，需要明确裁定后再改。
5. **GY-I11 交接缺口**：转写确认整链由他线 PR #294 覆盖，本片未验证其内容，证据页不代替其验收。

# GY-R72-I11 转写音频格式闸（受理期 415 + 失败码分流）· 证据页

- 日期：2026-11-02
- 分支 / 基线：`feat/gy-r72-audio-format-gate`，基线 `e62b5c98`（`git rev-parse e62b5c98` = `e62b5c983b1ed9ff80b24e912d9020cf53fb9ee0`）。
- 本片只碰：`services/api/src/speech/service.ts`、`services/api/src/speech/media.ts`、`services/api/src/speech/provider.ts`、`services/api/src/ai/asr-live-adapter.ts`、四份测试（`tests/unit/i11-audio-mp3-wav-guard.test.mjs`、`tests/unit/i11-audio-source-wiring.test.mjs`、`tests/unit/i11-real-media-wiring.test.mjs`、`tests/unit/speech-service.test.mjs`）、本页（新）。
- **没有**碰：`services/api/src/contract.ts`、`packages/contracts/**`、任何迁移、`docs/architecture/state-contract.md`、`tools/doc-anchors-*.json`、`tests/unit/doc-anchor-relocations.json`、`docs/architecture/contract-status.json` 的 `lines`（只由 `--reanchor --write-doc` 落盘）。

## 0 结论先说

1. **受理期就拦**：MP3 今天拿到的是 415 `MEDIA_TYPE_UNSUPPORTED`（点名 WAV、说清登记的类型），不再是「202 受理 → 后台 `failed`」。闸门在**幂等占位之前**（`services/api/src/speech/service.ts:447`，占位在 `services/api/src/speech/service.ts:457`），所以被拒请求**不消耗 `Idempotency-Key`**、不落作业。
2. **失败码分流**：转写期仍先做本地 WAV 剖面校验（零预留、零发包、不裁剪、不转码，判据一字未改），但**拿到字节却认得出是另一种音频容器**（MP3/AAC）时报 `MEDIA_TYPE_UNSUPPORTED`（`services/api/src/ai/asr-live-adapter.ts:221`）；**字节来源没接线 / 读不到 / 空字节 / 认不出 / 认出来是 WAV 只是剖面不符** 一律维持 `PROVIDER_UNAVAILABLE`。这条边界的理由是硬的：`tests/unit/ai-live-provider-wiring.test.mjs` 的四例（unwired / 空字节 / 全零 100 字节 / 61 秒 WAV）共用同一条断言，全都得是 `PROVIDER_UNAVAILABLE`。
3. **`mime` 未知 ⇒ 放行（fail-open）**：`substitute` 端口恒 `null`，历史行/外部登记册可能缺字段或空串，一律当「未知」放行；受理期**不读字节、不猜格式**，字节与声明的一致性继续由转写期兜底。
4. **不新增错误码**：`MEDIA_TYPE_UNSUPPORTED` 本来就在 `services/api/src/contract.ts` 的 `ERROR_STATUS_MAP` 里映射 415（`services/api/src/contract.ts:14-31`）。本片只把它加进 `failed` 结局可携带的错误码并集（`services/api/src/speech/provider.ts:39`）。
5. **两条 `todo` 变成真断言**：`tests/unit/i11-audio-mp3-wav-guard.test.mjs` 现在 6 个用例、**0 个 todo**、全绿。

## 1 缺陷链（带 `path:line`）

| # | 现场 | 读数 |
| --- | --- | --- |
| 1 | 上传契约允许 `audio/mpeg`（媒体层确实接收 MP3） | `packages/contracts/openapi.json` 的 `UploadInput.mime.enum`；`packages/media/detect.mjs` 认 `ID3` ⇒ `audio/mpeg` |
| 2 | 转写档位只有 WAV 一种载体 | `services/api/src/ai/asr-live-adapter.ts:37`（`LIVE_ASR_FROZEN_PROFILE`，`voiceFormat: 'wav'`） |
| 3 | 受理期**完全不看格式**：`resolve()` 只回 `revision` | 改前 `services/api/src/speech/media.ts` 的成功支 `{ ok: true; revision: number }` |
| 4 | ⇒ MP3 被受理成 202、落库、排队 | `services/api/src/speech/service.ts` 的 `createTranscription`（`store.insertJob(row)` 在占位之后） |
| 5 | 转写期本地拒绝，但**一律报供应商故障** | 改前 `services/api/src/ai/asr-live-adapter.ts` 的 `catch { return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' } }`，其注释自相矛盾（「不把它说成供应商故障」却报的就是供应商故障） |
| 6 | ⇒ 客户端看到 `PROVIDER_UNAVAILABLE`（503 语义），永远学不到「请传 WAV」 | `services/api/src/contract.ts:14-31`（`503: ['PROVIDER_UNAVAILABLE', ...]` vs `415: ['MEDIA_TYPE_UNSUPPORTED']`） |

**为什么这条链只在「格式」上显形**：字节来源没接线时 `read()` 返回 `null`，那本来就**不是**格式问题；把它报成 `MEDIA_TYPE_UNSUPPORTED` 会让客户端去换文件，而换了也没用。这就是分流判据必须看**字节本身认不认得出来**、而不是「校验是否失败」的原因。

## 2 改法

### 2.1 端口形状：`resolve()` 多回一个 `mime`

`services/api/src/speech/media.ts` 的成功结局改为 `{ ok: true; revision: number; mime: string | null }`：

| 实现 | `mime` 取值 | 读数 |
| --- | --- | --- |
| `createSubstituteMediaPort`（stub / preset_demo） | 恒 `null`（未知） | `services/api/src/speech/media.ts:137` |
| `createRealMediaPort`（real，登记册是 `mime` 的唯一事实源） | `normalizeSpeechMime(record.mime)` | `services/api/src/speech/media.ts:292` |
| `createUnwiredMediaPort`（real 但接线不全） | 走不到（恒 `OBJECT_UNAVAILABLE`） | `services/api/src/speech/media.ts:148` 原样 |

- `MediaRecord.mime` **不是新增列**：`services/api/src/media/store.ts:35-51` 的 `MediaRecord` 一直有 `mime`，由上传期「字节与声明必须一致」写入。本片只是让它流到受理期。
- 端口视图 `SpeechMediaRecordView.mime` 声明成**可选**（`services/api/src/speech/media.ts:178`）：另一支同样读登记册的窄视图（`ai/asr-audio-source.ts` 的 `SpeechRecordingRecord`）不含该字段，两者必须能互相赋值（`services/api/src/routes/speech.ts` 就同时用）；缺字段在运行期由 `normalizeSpeechMime` 归一成「未知」。
- 判据集中在一处：`WAV_ONLY_SPEECH_MIMES`（`services/api/src/speech/media.ts:86`，`audio/wav` / `audio/x-wav` / `audio/wave` / `audio/vnd.wave`）、`normalizeSpeechMime`（`services/api/src/speech/media.ts:89`）、`speechAudioMimeRefusal`（`services/api/src/speech/media.ts:106`）。真实端口**不判格式**，只把登记册的事实交出来。

### 2.2 受理期格式闸（位置是硬要求）

`services/api/src/speech/service.ts:447`：

```
    if (speechAudioMimeRefusal(resolution.mime) !== null) throw new ApiError('MEDIA_TYPE_UNSUPPORTED', `转写只收 WAV（不裁剪、不转码）：登记类型是 ${String(resolution.mime)}`, { retryable: false });
```

放在 `if (!resolution.ok) throw new ApiError(...)`（`services/api/src/speech/service.ts:443`）**之后**、幂等占位 `claimIdempotentScope(...)`（`services/api/src/speech/service.ts:457`）**之前**：

- **为什么之后**：`mime` 只能来自登记册。`real` 分支在 `createRealMediaPort` 里已经逐条确认了归属（越权与不存在同形）、版本、就绪状态、音频用途、对象键（`services/api/src/speech/media.ts:259-292`）⇒ 这里的拒绝**不泄露**任何调用者不该知道的东西。
- **为什么之前**：占位一旦落下，同一个 `Idempotency-Key` 就被「消耗」了（重试读到 `REQUEST_IN_PROGRESS` 或回放原来的错误），而格式问题是**客户端可修复**的：换上 WAV 之后用同一个键重试必须能成功。`D·受理期` 用例就是钉这一条（改前把闸门放到占位之后，那条 `replayed === false` 会红）。

### 2.3 失败路径分流（`services/api/src/ai/asr-live-adapter.ts`）

原来「取字节 + 剖面校验」在一个 `try/catch` 里，两类失败都落 `PROVIDER_UNAVAILABLE`。现在拆成三步（`services/api/src/ai/asr-live-adapter.ts:203-223`）：

1. `read()` 抛错 ⇒ `PROVIDER_UNAVAILABLE`（字节来源问题，不是格式问题）；
2. `raw === null || raw.length === 0` ⇒ `PROVIDER_UNAVAILABLE`（没有字节，认不出格式，不构成格式结论）；
3. `requireLiveAsrWav(raw, profile)` 抛错 ⇒ `foreignAudioMime(raw)`：认得出是**非 WAV 的另一种音频容器** ⇒ `MEDIA_TYPE_UNSUPPORTED`；`null`（认不出，或认出来就是 WAV）⇒ `PROVIDER_UNAVAILABLE`。

`foreignAudioMime`（`services/api/src/ai/asr-live-adapter.ts:150`）复用媒体层自己的嗅探器 `packages/media/detect.mjs` 的 `detectMediaType`（`services/api/src/ai/asr-live-adapter.ts:39` 的 import）——**与上传期认定 `audio/mpeg` 合法的是同一支**，不另立魔数表。`requireLiveAsrWav` 一字未改（仍抛 `AsrLocalInputError('OBJECT_UNAVAILABLE', ...)`）。

`failed` 结局可携带的错误码并集加一项（`services/api/src/speech/provider.ts:39-45`：`PROVIDER_FAILURE_CODES` 现含 `MEDIA_TYPE_UNSUPPORTED`）。`stateForProviderFailure` 未改 ⇒ 该码落 `failed`（不是 `timed_out`）。

## 3 测试读数

### 3.1 `tests/unit/i11-audio-mp3-wav-guard.test.mjs`（两条 `todo` → 真断言）

```
ℹ tests 6
ℹ pass 6
ℹ fail 0
ℹ todo 0
```

| 用例 | 钉什么 | 改前 |
| --- | --- | --- |
| A（原样保留） | 媒体层确实接收 MP3（`audio/mpeg`、时长 131ms、伪扩展名防线拦 `audio/wav` 谎报） | 绿 |
| B | 适配器层对 MP3 零预留零发包、不夹带转写；失败码由 `PROVIDER_UNAVAILABLE` 改判 `MEDIA_TYPE_UNSUPPORTED` | 红（`actual: { kind: 'failed', code: 'MEDIA_TYPE_UNSUPPORTED' }` vs `expected: { … 'PROVIDER_UNAVAILABLE' }`） |
| C（原样保留） | 契约面：`UploadInput.mime` 含 `audio/mpeg`；档位 `voiceFormat: 'wav'` / 16000Hz / 单声道 / ≤60s；`state-contract.md` 的 `mp3/wav/aac` 与「仍待GY-I25验证」 | 绿 |
| D·受理期（原 todo 1） | 登记册说 `audio/mpeg` ⇒ ApiError `MEDIA_TYPE_UNSUPPORTED`、`status === 415`、文案点名 WAV 与 `audio/mpeg`、`insertedJobs === 0`；同键再打仍 415（不是 `REQUEST_IN_PROGRESS`、不是回放）；**同键换 WAV ⇒ 202 且 `replayed === false`**（键没被消耗） | 红（`AssertionError: 今天 MP3 的 POST /speech/transcriptions 返回 202…`） |
| D·受理期·fail-open | `substitute` 端口 `mime: null` ⇒ 202；real 端口登记册 `mime: ''` / 全是空白 ⇒ 202；real + `audio/wav` ⇒ 202（正控）；real + `audio/mpeg` ⇒ 415（反控：判据来自登记册，不是端口类型） | 改前无此用例 |
| E（原 todo 2） | MP3 ⇒ `MEDIA_TYPE_UNSUPPORTED` 且 `reserves === 0` / `calls === 0`；反面对照：全零 100 字节与空字节**仍** `PROVIDER_UNAVAILABLE`（不许顺手放宽） | 红（`outcome.code !== 'PROVIDER_UNAVAILABLE'` 不成立） |

### 3.2 因端口形状变更而**机械加严**的既有断言（没有一条放宽）

| 文件 | 读数 | 改动 |
| --- | --- | --- |
| `tests/unit/speech-service.test.mjs` | 替身端口 resolve | `{ ok: true, revision: 3 }` → 加 `mime: null` |
| `tests/unit/i11-real-media-wiring.test.mjs` | 替身分支 resolve / real 分支 resolve | 加 `mime: null`；real 加 `mime: 'audio/wav'`（两处） |
| `tests/unit/i11-audio-source-wiring.test.mjs` | `B·剖面校验仍拦在适配器层` 三例 | MP3 一例由 `PROVIDER_UNAVAILABLE` 改判 `MEDIA_TYPE_UNSUPPORTED`（**这是本片要改的那件事本身**），61 秒 WAV 与空字节两例**逐字保留** `PROVIDER_UNAVAILABLE` |

`C·fail-closed 矩阵`（12 例，`read()` 全返回 `null`）、`C·端口未配置`、`D·零外呼` 与 `tests/unit/ai-live-provider-wiring.test.mjs` 的 unwired 期望**一字未改**，全绿——「字节来源未接线 ⇒ `PROVIDER_UNAVAILABLE`」这条正确行为没被动过。

## 4 门禁读数

每条都是真跑，`exit` 是原样的退出码（`$LASTEXITCODE`）。编号 14/15 按派单要求「commit 之后」跑，读数在本页提交后补登在 §7。

| # | 命令 | exit | 读数（原样片段） |
| --- | --- | --- | --- |
| 1 | `git diff --check` | 0 | 无输出（没有空白/尾随空格问题） |
| 2 | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（…）`；末行 `lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| 3 | `node --test tests/unit/i11-audio-mp3-wav-guard.test.mjs` | 0 | `ℹ tests 6 / ℹ pass 6 / ℹ fail 0 / ℹ todo 0` |
| 4 | `node --test tests/unit/i11-audio-source-wiring.test.mjs` | 0 | `ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / ℹ todo 0` |
| 5 | `node --test tests/unit/ai-live-provider-wiring.test.mjs` | 0 | `ℹ tests 16 / ℹ pass 16 / ℹ fail 0 / ℹ todo 0` |
| 6 | `node --test tests/unit/speech-service.test.mjs` | 0 | `ℹ tests 49 / ℹ pass 49 / ℹ fail 0 / ℹ todo 0` |
| 7 | `node --test tests/unit/i11-real-media-wiring.test.mjs` | 0 | `ℹ tests 5 / ℹ pass 5 / ℹ fail 0 / ℹ todo 0` |
| 8 | `npm run test:contract` | 0 | `ℹ tests 17 / ℹ pass 17 / ℹ fail 0` |
| 9 | `node tools/verify-contract-status.mjs` | 0 | `覆盖 127 条契约操作；implemented 18 / partial 109 / planned 0`、`语义可核 103 条区间 + 4 条片段`、`行号区间 317 条`、`中文表格一致` |
| 10 | `node tools/verify-doc-anchors.mjs --strict --scan docs` | 0 | 末行 `PASS: --strict 下没有基线之外的新增（…）`；`DRIFT-BASELINE … 基线外新增 0 条`、`BARE-ORPHAN-OUTSIDE … 基线外新增 0 条`、`ANCHOR-COUNT … 下降 0 份` |
| 11 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | 0 | `SYMBOL-STRICT-BASELINE … 基线外新增 0 条`；末行 `PASS: …` |
| 12 | `npm run test:docs` | 0 | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住`、`PASS docs/research 结构校验（…）` |
| 13 | `npm run lint`（复跑） | 0 | 与 #2 同读数 |
| 14 | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs`（commit 后） | 0 | `ℹ tests 33 / pass 32 / fail 0 / skipped 1`。主用例是**按设计 SKIP**：`﹣ 文档锚点位移恒等：… # SKIP: e62b5c983b1e..<HEAD> 本次文档提交只有新增行，没有锚点位移面（1 个纯新增 hunk）`——这正是该文件 `A1` 钉住的行为（纯新增 docs 提交显式 SKIP，不静默记 PASS）；提交前它是**判红**的（`base 与 HEAD 同一提交…不允许静默通过`），所以这条门禁必须排在 commit 之后 |
| 15 | `$env:GY_BASH='D:\Git\bin\bash.exe'; npm run test:unit` | 0 | `ℹ tests 6277 / pass 6274 / fail 0 / cancelled 0 / skipped 3 / todo 0`，`duration_ms 169000.9464`。改前同一套是 `tests 6277 / pass 6267 / fail 8 / skipped 2`（8 条红点全部由本片位移引起）；现在 `fail 0`，而 `skipped` 从 2 变 3 的那一条就是上面这个按设计的 SKIP |

`--reanchor` 的读数（§3 要求的 dry-run → `--write-doc` → 复跑）：

```
$ node tools/verify-contract-status.mjs --reanchor
REANCHOR: 无可重定位项（带锚点且带行号的引用 306 条，锚点都在 ±2 行容差内；符号形态 11 条按运行时解析，不写盘）
… 七行 PASS …
exit=0

$ node tools/verify-contract-status.mjs --reanchor --write-doc
（同样七行 PASS，exit=0；git status --short -- docs/architecture/contract-status.json 无输出 ⇒ 台账零字节改动）
```

**为什么「无可重定位项」而不是「重写了一批行号」**：本片把 `services/api/src/speech/service.ts` 的净行数改动做成 **0**（`git diff --numstat` = `6 6`）。这不是为了凑容差，而是硬约束：`docs/architecture/contract-implementation-status.md:77` 用**符号引脚**引 `services/api/src/speech/service.ts:666` 的 `cancelJob`，而符号引脚**没有 ±2 容差**（行号上的注释块落在符号 span 内即判 `NOT_SYMBOL_LINE`）；台账里 `timeout` 维度的 `runProviderWithDeadline`（`598-616`）又只有 ±2 容差，而该符号在文件里出现 3 次（注释/调用点/声明），一旦漂移就会被判 `AMBIGUOUS` 而拒绝写盘。所以做法是把闸门写成 1 行、把 `media.resolve(...)` 的调用压成 1 行、把 import 合并到既有那一行，净位移 0，**没有任何锚点需要重写**。

## 5 负控制（改 → 跑 → 还原 → 核 sha256）

改前与还原后的 sha256（三份文件同一组值，逐次核对相等）：

```
5f613d4b3442abb989e05fd8310f4f1696d5dad6ceb32e1220fbd5596415de7c  services/api/src/speech/service.ts
8c0e4e463f37dbcdc89758135ce4c427a5f8d1074783cf46ba0849e9fb70ac3f  services/api/src/ai/asr-live-adapter.ts
c917f44bbc2ce5a2f1f8f402d240977703db7a8613771fda87973c42a0f60583  services/api/src/speech/media.ts
```

| # | 改什么 | 期望红点 | 实际 |
| --- | --- | --- | --- |
| N1 | 受理期闸门恒 `false`（`services/api/src/speech/service.ts:447` 的 `if (speechAudioMimeRefusal(...) !== null)` → `if (false && …)`） | `D·受理期` 必红 | **红**，`node --test --test-name-pattern="受理期" tests/unit/i11-audio-mp3-wav-guard.test.mjs` ⇒ `ℹ tests 2 / pass 0 / fail 2`，exit=1。红点原文：`✖ D·受理期：登记册说 audio/mpeg ⇒ 415 MEDIA_TYPE_UNSUPPORTED，不落作业，且不吃掉 Idempotency-Key` + `AssertionError [ERR_ASSERTION]: 应当抛出 ApiError，却成功返回了`；另一条 `✖ D·受理期·fail-open：…` 同文案（第 4 段「real + audio/mpeg ⇒ 415」也靠这道闸）。还原后 sha256 = `5f613d4b…` ✓ |
| N2 | 失败路径揉回单 `catch`（`services/api/src/ai/asr-live-adapter.ts:203-223` 三步并成 `const raw = await audioSource.read(...); audio = requireLiveAsrWav(raw, profile);` 一个 `catch { return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' } }`） | `B` 与 `E` 必红 | **红**，`node --test tests/unit/i11-audio-mp3-wav-guard.test.mjs` ⇒ `ℹ tests 6 / pass 4 / fail 2`，exit=1。红点原文：`✖ I11·ASR 层对 MP3 本地 fail-closed：…` + `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + actual - expected` / `+ code: 'PROVIDER_UNAVAILABLE',` / `- code: 'MEDIA_TYPE_UNSUPPORTED'`；`✖ E·作业失败码：…` + `Expected values to be strictly equal: + 'PROVIDER_UNAVAILABLE' - 'MEDIA_TYPE_UNSUPPORTED'`。还原后 sha256 = `8c0e4e46…` ✓ |
| N3 | 真实端口不交类型（`services/api/src/speech/media.ts:292` 的 `mime: normalizeSpeechMime(record.mime)` → `mime: null`） | 受理期 MP3 用例必红 | **红**，`node --test tests/unit/i11-audio-mp3-wav-guard.test.mjs` ⇒ `ℹ tests 6 / pass 5 / fail 1`，exit=1。红点原文：`✖ D·受理期·fail-open：mime 未知（null / 空串 / 缺字段）一律放行，WAV 正控放行` + `AssertionError [ERR_ASSERTION]: 应当抛出 ApiError，却成功返回了`。**位置说明**：真正走 `createRealMediaPort` 的 MP3 反控在本片写法里落在 `D·受理期·fail-open` 的第 4 段（`real 端口 + mediaRow({ mime: 'audio/mpeg' }) ⇒ 415`），而 `D·受理期` 用的是替身端口 `mimePort('audio/mpeg')`，所以 N3 的红点落在前者而不是后者——判据同一条（`speechAudioMimeRefusal`），落点由端口类型决定。还原后 sha256 = `c917f44b…` ✓ |

## 6 边界与未做

1. **不裁剪、不转码**：本片只把「格式不合格」提前说清楚，**没有**做 MP3→WAV 解码（仓内与运行环境都没有解码器，引依赖须先裁定）。上传 MP3 仍然合法（社区/留档用途），只是不能拿来转写。
2. **受理期只看声明，不看字节**：`mime` 来自登记册（上传期已用字节校验过声明），受理期**不**再 `getObject()` 读 12 字节头部——那会把整段录音多下载一遍，且把「受理」变成 I/O 路径。因此**伪造声明能骗过受理期**，但骗不过转写期的 `requireLiveAsrWav`（该路径仍零预留零发包拒绝，且现在报 `MEDIA_TYPE_UNSUPPORTED`）。
3. **`substitute` 面 fail-open**：替身端口没有类型信息，恒 `null` ⇒ 受理期放行。这是刻意的（否则一批合法请求被凭空拒绝），代价是替身模式下 MP3 仍会走到转写期才被拒——但那时的码已经是 `MEDIA_TYPE_UNSUPPORTED`，不再冒充供应商故障。
4. **不新增错误码**：只复用 `MEDIA_TYPE_UNSUPPORTED`（415）。`413` 是 `MEDIA_TOO_LARGE`，与本片无关。
5. **没有**接真实 ASR 调用，也不产生任何准确率/转写质量结论；本页全部读数来自离线的合成音频与进程内端口。
6. **`413` 没有出现在本片**：本片收到的口径写作「413→415」，但仓库事实是 `MEDIA_TYPE_UNSUPPORTED` 在 `services/api/src/contract.ts` 里唯一映射 **415**（`413` 属于 `MEDIA_TOO_LARGE`，是另一码）。按「以仓库事实为准」执行，全部拒绝都是 415。

## 7 提交后读数（门禁 14/15）

`doc-anchor-relocation-identity` 需要真实提交才有判定面，所以这两条排在 commit 之后（本页随同一提交落地，读数按提交后实跑回填）。

- 门禁 14 `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` ⇒ **exit 0**，`ℹ tests 33 / pass 32 / fail 0 / skipped 1`；SKIP 原文（区间右端就是本条提交的 HEAD，会随笔更新，故按 `<HEAD>` 记）：
  `﹣ 文档锚点位移恒等：目标文件没改 ⇒ 行号恒等（陈旧锚点必须走登记表）；改了 ⇒ 必须落在这个文件自己的端点映射上，且旧行原文 === 新行原文 # SKIP: e62b5c983b1e..<HEAD> 本次文档提交只有新增行，没有锚点位移面（1 个纯新增 hunk）`
- 门禁 15 `$env:GY_BASH='D:\Git\bin\bash.exe'; npm run test:unit` ⇒ **exit 0**，`ℹ tests 6277 / pass 6274 / fail 0 / cancelled 0 / skipped 3 / todo 0`，`duration_ms 169000.9464`。

## 8 未做 / 做不到

1. **没有**做 MP3→WAV 解码或任何转码（见 §6.1）。
2. **没有**在受理期读对象头部（见 §6.2）。
3. **没有**新增错误码、没有改契约、没有改迁移、没有动 `state-contract.md` 与任何锚点登记册。
4. **没有**接真实 ASR／真实对象存储：本页所有读数来自进程内替身与合成字节，不构成任何真实转写质量、时延或供应商行为的结论。

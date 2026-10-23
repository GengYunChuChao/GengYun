# GY-R34 · I13 合成产物（TTS）真实存储端口接线（2026-10-23）

> 基线：`upstream/main` = `765b6a31d993995e5dacbf6a3227ebcbb97fd8df`（开工时 `git rev-parse upstream/main` 实测，与派单给的值一致）。
> 分支：`fix/gy-r34-i13-tts-media`；工作树：`E:\GengYunCommander\wt-r34-i13-tts-media`。
> Refs #13（**不**含任何可解析关单关键字）。
> 本页只提供证据与「未取得项」登记：**不构成 #13 的验收、也不构成它的完成**（见 §7），不代替监工判定。

## 0 摘要

1. **数据面（库件）**：`services/api/src/tts/media.ts` 新增 `s3_compatible` 产物端口
   `createObjectStoreSynthesisMediaPort`，**复用**媒体域既有对象存储实现
   （`services/api/src/media/object-store.ts` 的 `MediaObjectStore`；⛔ 本片没有新写第二套 S3/OSS
   客户端、没有自拼 URL/签名）。键名走媒体域**同一条**规则 `newObjectRef()`
   （`packages/media/store.mjs`：不透明 `obj_` + 18 字节 base64url），⛔ 不自造 `tts/…` 路径前缀。
2. **闸门（运行期构造期）**：真实端口**只能**由调用方**显式注入**一个
   `approveRealSynthesisMediaWiring()` 铸造的批准对象 ＋ 一个 `kind === 's3_compatible'` 的端口才能
   构造。未注入、或批准对象不是铸造产物、或端口 kind 不对 ⇒ 仍是 `unwired`
   （`put` → `OBJECT_UNAVAILABLE`）。**`env` 从不是开启依据**：本文件零处读取 `process.env`。
3. **装配（一次可审查的接线）**：`app.ts` 的 `BuildAppOptions.synthesisMediaWiring` 只做**转发**，
   装配层没有 `approveRealSynthesisMediaWiring` 调用点（`git grep` 实测：生产源码里只有定义处与
   本文件的注释提到它）。**生产入口 `server.ts` 不铸造**该批准能力 ⇒ 真实模式的合成产物存储
   在默认装配下**仍然是 fail-closed**（§7）。
4. **测试**：新增 `tests/unit/tts-media-real-store.test.mjs`（18 条），覆盖派单要求的 ①②③④ 四组
   ＋ 装配层/服务层读数；相邻回归与门禁读数见 §5。
5. **未取得**：真实对象存储往返、真实 TTS 供应商音频、真机播放、30 段真实 TTS 评估、产物删除/回收
   路径、`media_id ↔ 对象键` 索引的可恢复化（§6）。

## 1 改了什么、为什么

### 1.1 开工实测的断点（基线 `765b6a3`）

`services/api/src/tts/media.ts` 的工厂只有一个实参：`createSynthesisMediaPort(executionMode)`，`real`
分支**恒**返回 `createUnwiredMediaPort()` ⇒ `tts/service.ts` 的受理前判定 `media.kind === 'unwired'`
⇒ `POST /speech/synthesis` 一律 `409 OBJECT_UNAVAILABLE`，**合成产物在真实模式无处存放**，
且产品里**没有任何**构造真实产物端口的路径（连库件都没有）。

### 1.2 改动面（逐文件）

| 文件 | 改了什么 |
| --- | --- |
| `services/api/src/tts/media.ts` | 新增批准能力（铸造/判定/文案）、接线拒绝闭集与错误类型、`SynthesisMediaPortOptions`、`s3_compatible` 端口实现、读回端口（`readArtifact` / `objectKeyFor`）、`createSynthesisMediaPort` 的 `real` 分支门控 |
| `services/api/src/app.ts` | `BuildAppOptions.synthesisMediaWiring`（与 `synthesisMedia` 同行声明）＋ 装配处一次转发；**净 0 行**（6 增 6 删，见 §3） |
| `tests/unit/tts-media-real-store.test.mjs` | 新增 18 条离线用例（§4） |
| `tests/unit/runtime-strings-truth.test.mjs` | 该文件原本钉住「合成域 `mediaNote` 逐字等于旧文案」；默认 `real` 文案改为点名「缺少显式批准能力」⇒ 同步为**新的逐字期望**，并加一条 `mediaPort === 'unwired'` 断言（**只加不减、仍然逐字相等**，不是放宽） |
| 本页 | 证据 |

**没改**：`packages/contracts/**`、`docs/architecture/contract-status.json`、`services/api/db/migrations/**`、
依赖清单（无新增依赖）、`server.ts`（生产入口不铸造批准能力，见 §7）。

### 1.3 三种端口（改后的行为）

| `kind` | 何时 | `put` | `exists` | 读回端口 |
| --- | --- | --- | --- | --- |
| `substitute` | `stub` / `preset_demo`（与接线前逐字一致） | 只登记**非音频**标注；真实产物/`audio/*`/带 MP3 头一律拒绝 | 内存 Map | 无 |
| `unwired` | `real` 且缺批准能力／缺 `s3_compatible` 端口（默认装配也走这里） | `OBJECT_UNAVAILABLE` | `false` | 无（`readArtifact` 不存在） |
| `s3_compatible` | `real` ＋ 显式批准能力 ＋ 显式注入的 `s3_compatible` 端口 | 写真实字节到对象存储 | 查对象存储（查询失败 ⇒ `false`） | 有 |

### 1.4 为什么复用媒体域实现（而不是本域自建一套）

1. **不新写第二套 S3/OSS 客户端**（派单红线）：签名、路径样式、`https` 断言、`MediaError` 语义
   全部留在 `media/object-store.ts`，本域只调 `hasObject` / `putObject` / `getObject`。
2. **键规则与既有媒体域一致**：媒体域的对象键是 `newObjectRef()` 的**不透明引用**（不是路径、
   不含桶名、不含用途前缀），私有不外露是媒体域红线；本域沿用同一函数，因此两域的对象键**同形**，
   运维/审计只需认一条规则。
3. **真实适配器的「已审语义」不复制**：`s3_compatible` 的 `note`、失败码、retryable 口径都在媒体域
   那一份里；本域只决定「写什么键、写什么字节、失败怎么向上回报」。

### 1.5 失败语义（与 `tts/service.ts` 既有分类对齐）

`tts/service.ts` 的落库分支是「`media.put` 返回 `{ok:false, code}` ⇒ 作业落 `failed` + `code`」，
且**只有提供者失败**才走 `stateForProviderFailure`（`PROVIDER_TIMEOUT` → `timed_out`，其余 → `failed`）。
因此本端口把**所有**存储侧故障收敛到契约闭集里语义最贴切的两个码，并且都不落 `succeeded`：

| 端口侧情形 | 返回 | 服务层落点 |
| --- | --- | --- |
| 写入/存在性查询抛错、超时、分配冲突用尽（`media_id` 或对象键） | `OBJECT_UNAVAILABLE`(409) | `failed` + `OBJECT_UNAVAILABLE` |
| 声明 `audio/mpeg` 但字节没有 MPEG/ID3 头（错误 JSON/HTML 冒充音频）、或非 `audio/mpeg` 类型 | `MEDIA_TYPE_UNSUPPORTED`(415) | `failed` + `MEDIA_TYPE_UNSUPPORTED` |
| 替身产物进了真实端口 | `PROVIDER_OUTCOME_UNKNOWN`(503) | `failed` + `PROVIDER_OUTCOME_UNKNOWN` |
| `exists` 查询失败 | 返回 `false`（fail-closed） | `verifyUsable` 判「产物不可用」，不声称可用 |

**超时为什么不返回 `PROVIDER_TIMEOUT`**：那样会得到「同一错误码在提供者分支 ⇒ `timed_out`、在落库分支
⇒ `failed`」的自相矛盾；按 409「对象当前不可用」记，与 `media/**` 的 fail-closed 语义同口径。
超时用 `storageTimeoutMs`（默认 10000ms）兜底，保证作业不会因为端口挂住而永远停在 `running`。

## 2 批准能力：形状、铸造点、注入点（可审查）

**形状逐条照抄媒体域 #193（`.pg17/ruling-i193-runtime-gate.md` §2.1）**：

- 接口 `RealSynthesisMediaApproval { reason, approvedAt }`，对象 `Object.freeze`；
- 判定只认**模块私有 `WeakSet`** 里的**对象身份**（`isRealSynthesisMediaWiringApproved`）：同形字面量、
  `Object.create(token)` 派生、`Proxy` 包装、JSON 往返副本**一律无效**（用例 ④c 逐条断言）；
- 取值走 `Object.hasOwn`（不读原型链）：`Object.prototype` 上同名属性不算给出；
- 唯一铸造点 `approveRealSynthesisMediaWiring`（显式、可 grep、可审查的一次调用）。

**注入点（唯一）**：

```
调用方（测试 / 将来的运维入口）
  └─ approveRealSynthesisMediaWiring({ reason })           ← 铸造（本分支生产源码 0 处调用）
  └─ createSynthesisMediaPort('real', {
        objectStore,                                        ← 必须是 kind === 's3_compatible'
        realSynthesisMediaApproval,                         ← 必须是铸造产物
     })
       ├─ 门控①：isRealSynthesisMediaWiringApproved(approval) 失败 ⇒ unwired（文案点名缺批准能力）
       ├─ 门控②：objectStore 缺失/kind 不对                   ⇒ unwired（文案点名缺端口）
       └─ createObjectStoreSynthesisMediaPort(...)             ← 真实端口（再次自校验身份）
```

装配层（`app.ts`）只把调用方给的 `synthesisMediaWiring` 原样转给工厂，**不解释、不补默认值、不铸造**；
`server.ts` **没有**任何铸造点。因此「谁能开真实产物存储」在代码里是**有限且可枚举**的：
一个铸造函数 + 一个转发点。

**跨域隔离**：媒体域（`#193`）的 `approveRealMediaWiring()` 铸造对象**不能**打开本域端口
（两个独立 `WeakSet`），用例 ④b 钉住。

**负控制（用例 ④）**：`real` ＋ 四键齐备的 `env`（既作实参传 `{ env }`，也写进 ambient
`process.env`）＋ 甚至再塞一个 `s3_compatible` 端口但**不给批准能力** ⇒ 端口仍 `unwired`、
`put` 仍 `OBJECT_UNAVAILABLE`。撤销「注入批准能力」这一步，用例即红。

## 3 `app.ts` 为什么写成「净 0 行」

本片的装配改动是 6 增 6 删（`git diff --numstat` 实测），**没有净增行**。原因与代价如实登记：

- `docs/architecture/contract-status.json` 里 `services/api/src/app.ts` 的 `idempotencyStore` 区间锚点
  距 `±2` 行容差**只剩 1 行余量**；派单⛔禁止改该台账，故不能 `--reanchor`。
- `tools/verify-doc-anchors.mjs --strict`（散文行号闸门）在 HEAD 上是**绿的**（实测「基线外新增 0 条」）；
  一旦 `app.ts` 净增行，6 条基线内文档引用的 `app.ts:NNN` 会落到空行/右括号上，变成「基线外新增 6 条」。
- ⇒ 取最小改法：新字段与原字段**同行声明**、原注释就地扩写、装配行原地替换。**没有**改动任何台账
  `lines`、没有改 `tools/doc-anchors-baseline.json`、没有放宽任何判据。
- 代价（如实）：`app.ts` 里承载不了本片的长注释，理由集中放在 `tts/media.ts` 的文件头/接口注释与本页；
  若后续切片需要给 `app.ts` 加行，应在**允许改台账**的切片里先跑 `node tools/verify-contract-status.mjs --reanchor`。

## 4 测试清单（`tests/unit/tts-media-real-store.test.mjs`，18 条，全离线）

| # | 用例 | 钉住什么 |
| --- | --- | --- |
| ① | real 未注入批准能力 | 端口 `unwired`、note 逐字、无 `readArtifact`、`put`/`exists`/`describeObject` 全受控 |
| ①b | 只给批准能力、没给端口 | 仍 `unwired`，note 点名「缺 `s3_compatible` 端口」 |
| ①c | 批准能力 ＋ 替身 kind 端口 | 仍 `unwired`（判据是端口 `kind`，不是自述），且零写入 |
| ② | 批准能力 ＋ 假对象存储 | `put`/读回往返；键名匹配媒体域 `obj_` 规则且不是路径；长度与 sha256 逐字节一致；`describeObject`/`exists`/二次 `put` 用新键 |
| ③-1 | 写入抛错 | `OBJECT_UNAVAILABLE`、无索引残留、无 `media_id` 返回 |
| ③-2 | 写入挂住 | 截止时间后 `OBJECT_UNAVAILABLE`（不断言无限等待） |
| ③-3 | 键冲突（存在性恒 true） | `OBJECT_UNAVAILABLE`、**零写入**（不覆盖别人的对象）、尝试有界（3 次） |
| ③-4 | 存在性检查抛错 | `OBJECT_UNAVAILABLE`、不尝试写入 |
| ③-5 | 替身产物进真实端口 | `PROVIDER_OUTCOME_UNKNOWN`、零写入 |
| ③-6 | 声明 `audio/mpeg` 但无 MPEG/ID3 头；非 `audio/mpeg` 类型 | `MEDIA_TYPE_UNSUPPORTED`、零写入 |
| ③-7 | 存在性查询故障 / 对象被外部删除 | `exists` 分别返回 `false`（fail-closed） |
| ③-8 | 读回时存储故障 | `readArtifact` **抛错**（调用方必须能区分「没有」与「读不到」） |
| ④ | real ＋ 只有 env（含 ambient `process.env`） | 四种组合全部 `unwired` + `put` 受控失败（负控制） |
| ④b | 媒体域批准能力 | 打不开本域端口 |
| ④c | 同形/派生/Proxy/JSON 副本 | 一律无效；直接用假批准对象构造真实端口 ⇒ 抛 `SynthesisMediaWiringError` |
| ④d | 直接构造的拒绝原因 | 三条拒绝原因均落在 `SYNTHESIS_MEDIA_WIRING_REFUSALS` 闭集内 |
| ⑤ | `buildApp` 装配 | 零注入 ⇒ `unwired`；完整注入 ⇒ `s3_compatible`；只有端口无批准能力 ⇒ `unwired`；`stub` 注入真实端口 ⇒ 仍 `substitute` |
| ⑥ | 服务层（真实端口） | 写入失败 ⇒ 作业 `failed` + `OBJECT_UNAVAILABLE`、`result=null`、桶里 0 字节；写入成功 ⇒ `succeeded` 且 `result.media_id` 读回的 sha256 与提供者产物一致 |

## 5 门禁读数（本机实测，时点＝本页写作时的分支 HEAD）

| 命令 | 读数 |
| --- | --- |
| `node --test tests/unit/tts-media-real-store.test.mjs` | tests 18 / pass 18 / fail 0 |
| `node --test tests/unit/tts-service.test.mjs tests/unit/tts-cancel.test.mjs tests/unit/tts-state.test.mjs tests/unit/tts-jobs-http.test.mjs` | tests 109 / pass 109 / fail 0 |
| `node --test tests/unit/runtime-strings-truth.test.mjs tests/unit/idempotency-job-ttl.test.mjs tests/unit/media-port-injection-wiring.test.mjs tests/unit/tts-live-adapter.test.mjs tests/unit/tts-checked-content-wiring.test.mjs` | tests 45 / pass 45 / fail 0 |
| `node --test tests/unit/chain-e2e-tool.test.mjs` | tests 14 / pass 14 / fail 0 |
| `node tests/integration/tts-http.mjs` | `CHECKS pass=42 fail=0`、`RESULT=PASS`、`EXIT=0` |
| `node tests/integration/tts-content-wiring.mjs` | `PASS W3 核对端口接线读数：pass=8 fail=0`、`EXIT=0` |
| `npm run test:integration:http`（14 个脚本全链） | `EXIT=0` |
| `npx tsc -p services/api/tsconfig.json --noEmit` | `EXIT=0` |
| `node tools/verify-contract-status.mjs` | `EXIT=0`（覆盖 113 条操作；形状错误 0 / 语义错误 0；行号区间 240 条 PASS） |
| `node tools/verify-doc-anchors.mjs --strict` | `EXIT=0`（基线外新增 0 条、陈旧 0 条） |

## 6 未取得（不得据本页声称）

1. **真实对象存储往返**：没有对任何真实 COS/S3 桶发起过请求（无凭据、未授权外呼）。本页的所有
   往返都在**测试替身**（`MediaObjectStore` 的进程内假实现）下完成；真实适配器的 SigV4 签名正确性
   由媒体域既有用例覆盖，**不在本片**。
2. **真实 TTS 音声**：真实供应商样本 **0**；用例里的「真实产物」是 `ID3` + 合成载荷的**夹具字节**，
   不是音频，不可播放，也不构成任何音质/音色/自然度/听感结论。
3. **真机播放**：未取得（契约也没有「取合成音频字节」的 operation；本片的 `readArtifact` 只服务
   服务端/测试）。
4. **30 段真实 TTS 评估**：未取得（`docs/evaluation/sample-gap-register.md` 的 `tts` 缺口仍在）。
5. **产物删除/回收路径**：未接线（本域没有删除入口；`deleteObject` 在本片一次都没被调用，用例里
   假对象存储的 `deleteObject` 直接抛错以保证「没人偷偷调」）。
6. **元数据可恢复化**：`media_id ↔ 对象键` 索引仍是**进程内 Map**（与 `tts/store.ts` 的内存作业 store
   同口径）⇒ 进程重启后索引丢失，桶里的对象变成**不可达孤儿**。
7. **生产开启**：`server.ts` 不铸造批准能力 ⇒ 真实模式默认装配仍 `unwired`（见 §7）。

## 7 这一片不构成 #13 完成（声明）

**本片只交付「真实产物存储端口可被构造 + 一次可审查的显式注入 + 未授权时仍然 fail-closed」。**

具体地，以下任何一条都**没有**因为本片而成立，不得据此写「#13 已接线 / 可播放 / 可上线」：

- `real` 模式的产品默认装配**仍**是 `unwired`：`POST /speech/synthesis` 仍 `409 OBJECT_UNAVAILABLE`；
- 没有任何真实桶、真实 TTS、真机播放、真实样本评估的证据（§6）；
- 合成产物**没有**删除/回收路径，元数据索引**未持久化** ⇒ 一旦真的对真实桶开门，会产生无法回收的
  孤儿对象，且重启后作业与产物对不上；
- 因此「真实用户音频存进真实桶」这件事**本片刻意没做**（与媒体域 #193 的 P1 口径一致：先补齐
  可恢复元数据与回收依据，再谈开门）。

⇒ 结论：**这一片不构成 #13 完成**，也不构成任何真机/真实供应商验收。

## 8 复核后推翻/订正的前提（开工时按实测核对）

1. 派单写的 `mediaPortFor(executionMode)` —— 基线里**没有**这个名字（`git grep mediaPortFor` 0 命中）；
   真实名字是 `createSynthesisMediaPort(executionMode, options = {})`，`real` 分支恒返回
   `createUnwiredMediaPort()`。**结论不变**（真实模式产物无处存放），只是函数名需订正。
2. 派单说 `tts/media.ts` 的断点在 `:142` 一带 —— 开工实测（基线 `765b6a3`）：`:141` 是函数签名、
   `:142` 是 `return executionMode === 'real' ? createUnwiredMediaPort() : createSubstituteMediaPort(options);`。
   **一致**（本片改完后该 return 已换成门控分支）。
3. 派单转述的「#13 监工判定把『真实产物存储未接线』列为缺代码一片」：本子代理**未独立核实**监工原文
   （无该 issue 的读取授权/上下文），按派单转述登记，不作为本页的证据。
4. `tests/unit/runtime-strings-truth.test.mjs` 原本把合成域 `mediaNote` 钉成
   `真实对象存储尚未接线，无法存放合成产物（fail-closed）`。本片把默认文案改为点名「缺少显式批准能力」
   ⇒ 该断言**必须**同步（仍是逐字相等，并额外加了一条 `mediaPort === 'unwired'`）。这不是「改测试迁就实现」，
   而是文案本身变了；旧文案在本片之后会**误导**读者（真实端口已经存在，缺的是显式接线决定）。

## 9 残余风险（非阻塞，如实登记）

- **超时孤儿**：写入超时后底层请求不会被中止（没有 `AbortSignal` 的注入位置），迟到完成的写入仍可能
  在桶里留下**没有 `media_id` 指向**的对象；本片没有 list 权限也没有回收路径 ⇒ 未消除。
- **索引易失**：见 §6.6。
- **`audio/mpeg` 收窄**：真实适配器当前唯一产出是 `audio/mpeg`；将来若产出别的容器，须同时改
  `REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE` 与用例（⛔ 不得放宽成「任意 `audio/*` 都收」）。
- **读回端口没有 HTTP 出口**：`readArtifact` 只服务服务端/测试；播放面（短效句柄/网关）仍属未接线。

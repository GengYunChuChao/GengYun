# GY-R31：媒体端口注入补进 OCR / 识别 / 语音三域（#9 #10 #11 的共同代码缺口）

Refs #9 #10 #11。**本片只补「装配层可选注入」**：`real` 下未注入时的 fail-closed 行为、错误码与文案**逐字未改**，
`stub` / `preset_demo`（纯内存装配）行为未改；未接真实供应商调用、未改 openapi、未新增迁移、未改任何 HTTP 路由契约。

- 基线：`1a33392031ed8e49a14797209d1e84dc1e2cd548`（`origin/main` = `1a333920`）
- 分支／工作树：`feat/gy-r31-media-port` @ `E:\GengYunCommander\wt-r31-tts-media`
  （⚠ 派单里写的 `wt-r31-media-port` 在本机**不存在**；本片实际工作树是 `wt-r31-tts-media`，分支名与基线一致，已核实）
- 本页读数全部来自本机实跑：改前读数用 `git stash push -- services/api/src/app.ts` 把装配文件回滚到基线复现；
  改后读数在同一工作树的最终改动上取得。原始输出摘要见 §5。

## 1 一句话结论

基线里**识别域与语音域本来就有**媒体引用端口注入口（`recognitionMedia` / `speechMedia`），**只有 OCR 域**在装配层
（`services/api/src/app.ts` 的 `registerOcrRoutes(...)`）没有把端口交下去、`BuildAppOptions` 也没有任何 OCR 媒体字段
⇒ `real` 下 OCR 只能拿到 `createUnwiredMediaPort()`（`kind: 'unwired'`），注入的端口永远接不进来。本片补上
`BuildAppOptions.ocrMedia` 并在装配行交下去，三域现在**逐域**都能被注入接管；不注入时三域行为逐字不变。

## 2 现状（改前）三域装配表

| 域 | 装配点（基线 `1a333920`） | 端口从哪来 | `real` 零注入拿到什么 | 缺失时的错误码 / 文案（实测原文） |
| --- | --- | --- | --- | --- |
| 识别 | `services/api/src/app.ts:975`（服务在 `:968` 构造）`media: recognitionMedia ?? createRecognitionMediaPort(config.executionMode)` | `BuildAppOptions.recognitionMedia`（`:318`，**已有**） | `createUnwiredMediaPort()`，`kind: 'unwired'` | 供应商闸门在前：503 `PROVIDER_UNAVAILABLE` `缺少真实识别供应商凭据（fail-closed，不回退替身）`；媒体步若可达 ⇒ 409 `OBJECT_UNAVAILABLE` `媒体引用不可用` |
| 语音 | `services/api/src/app.ts:1743`（基线 1711 ⇒ 合流 main 后）`registerSpeechRoutes(..., { …, media: speechMedia, … }, real ? pool : null)` | `BuildAppOptions.speechMedia`（`:329`，**已有**） | 同上，`kind: 'unwired'`（note 是「录音字节」版本） | 503 `PROVIDER_UNAVAILABLE` `缺少真实 ASR 供应商凭据（fail-closed，不回退替身）`；媒体步若可达 ⇒ 409 `OBJECT_UNAVAILABLE` `媒体引用不可用` |
| OCR | `services/api/src/app.ts:1791`（基线 1730 ⇒ 合流 main 后）`registerOcrRoutes(app, config, { guards: gatedGuards, consent: consentGate, egress: ocrEgress, history: ocrTerminalHistory }, ocrPersistencePool)` —— **装配行没有 `media` 键；`BuildAppOptions`（`:300-344`）无任何 OCR 媒体字段** | 只能由 `services/api/src/routes/ocr.ts:197` 的 `deps.media ?? createOcrMediaPort(config.executionMode)` 域内自建 | `createUnwiredMediaPort()`，`kind: 'unwired'` | 503 `PROVIDER_UNAVAILABLE` `缺少真实 OCR 供应商凭据（fail-closed，不回退替身）`；媒体步若可达 ⇒ 409 `OBJECT_UNAVAILABLE` `媒体引用不可用` |

补充（如实记录，避免误判「三域都缺」）：

- 三域**路由层**早已支持注入：`routes/ocr.ts:72 media?: OcrMediaPort`、`routes/speech.ts:99 media?: SpeechMediaPort`、
  识别域直接构造服务（`app.ts:975`）。缺的只是 OCR 的**装配层**传值。
- 三域 `describe()` 都暴露 `mediaPort: media.kind` / `mediaNote: media.note`
  （`services/api/src/ocr/service.ts:961-962`、`services/api/src/recognitions/service.ts:835-836`、
  `services/api/src/speech/service.ts:815-816`）⇒ 端口形态可被断言直接读到，不需要跑真实任务。

## 3 已存在的端口接口（⛔ 未新造平行接口，逐字复用）

```ts
// services/api/src/ocr/media.ts:26-36
export type MediaResolutionCode = 'NOT_FOUND' | 'REVISION_CONFLICT' | 'OBJECT_UNAVAILABLE';
export type MediaResolution = { ok: true; revision: number } | { ok: false; code: MediaResolutionCode };
export interface OcrMediaPort {
  readonly kind: 'substitute' | 'unwired';
  readonly note: string;
  resolve(input: { ownerUserId: string; mediaId: string; mediaRevision: number }): Promise<MediaResolution>;
}
// :45 createSubstituteMediaPort(): OcrMediaPort
// :65 createUnwiredMediaPort(reason = '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有媒体字节'): OcrMediaPort
// :76 createOcrMediaPort(executionMode: string): OcrMediaPort   // real ⇒ unwired；其余 ⇒ substitute
```

`services/api/src/recognitions/media.ts` 与 `services/api/src/speech/media.ts` **同形**（同三成员、同一套
`MediaResolutionCode`；speech 的 unwired 默认 `reason` 是「…无法读取私有录音字节」）。

另有一个**不同用途**的既有端口，本片**没有**拿它来顶替：

```ts
// services/api/src/media/object-store.ts:54
export interface MediaObjectStore {
  readonly kind: 'substitute' | 's3_compatible' | 'unwired';
  readonly note: string;
  readonly externalRequestCount: number;
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<StoredObject | null>;
  hasObject(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<boolean>;
  objectCount(): Promise<number>;
  presignUpload(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<PresignedHandle>;
  presignDownload(input: { key: string; expiresInSeconds: number }): Promise<PresignedHandle>;
}
```

它是**字节存储**端口（媒体域 7 条路由用），不是三域受理前要的「媒体引用归属/版本校验」端口；两者不可互换。

## 4 改动点（1 产品文件 + 2 既有断言 + 1 新测试 + 1 台账行号同步；均为最小改动）

1. `services/api/src/app.ts:46`：`import { registerOcrRoutes, type OcrRouteDeps } from './routes/ocr.ts';`
   —— 只取**类型** `OcrRouteDeps['media']`，**不** import `./ocr/media.ts`（`app.ts` 的 OCR 适配器 import 禁项因此逐字保持）。
2. `services/api/src/app.ts:353`：`BuildAppOptions` 增可选字段
   `ocrMedia?: OcrRouteDeps['media'];`（命名对齐既有 `recognitionMedia` / `speechMedia`），并写明「缺省 undefined ⇒ 域内
   按 `executionMode` 自建；默认装配不注入、`real` 仍 fail-closed」。
3. `services/api/src/app.ts:662`：解构新增 `ocrMedia`。
4. `services/api/src/app.ts:1764`：装配行改为
   `registerOcrRoutes(app, config, { guards: gatedGuards, consent: consentGate, egress: ocrEgress, history: ocrTerminalHistory, media: ocrMedia }, ocrPersistencePool);`
   —— 行尾仍是 `}, ocrPersistencePool);`，`ocrPersistencePool` 仍是第 4 个位置实参。
5. `tests/unit/ocr-store-pg-wiring.test.mjs:86-107`：结构判据的**允许键集**由四键扩为五键（新增 `media`），
   测试名与注释同步登记口径变更；四条 import 禁项与「`real ? pool : null` 判定」「行尾必须是 `ocrPersistencePool`」未动。
6. `tests/integration/ocr-http.mjs:1576-1594`：同一条键集判据同步为五键 + 口径登记注释；`appText` 的四条 import
   禁项（`ocr/provider`、`ocr/store`、`ocr/media`、`ocr/reference`）**逐字未动**，`evaluateOcrImports` 未动。
7. 新增 `tests/unit/media-port-injection-wiring.test.mjs`（5 条断言，见 §5.2）。
8. `docs/architecture/contract-status.json` 两处行号 + `docs/architecture/contract-implementation-status.md`（由
   `node tools/verify-contract-status.mjs --write-doc` 重生成）：因第 2/3 步在 `app.ts` 插入 11 行，
   台账里指向 `app.ts` 的两处**行号锚点**随之位移（`accountDeletionWired` `1791-1795`→`1802-1806`；
   `idempotencyStore` `834-840`→`845-851`，位移量 +11）。**只改行号，不改任何状态判定、不改文案、不改证据锚点**。

### 4.1 为什么必须动那两条既有断言（无法零改动）

三处结构钉子叠加，使「任何新增注入口」都必然触发其中至少一条：

- 键集判据（两处）：装配行只能出现 `consent/egress/guards/history`；
- `tests/unit/ocr-store-pg-wiring.test.mjs:116-119`：装配行**必须以 `}, ocrPersistencePool);` 结尾**
  ⇒ 追加第 5 个位置实参（`registerOcrRoutes(..., ocrPersistencePool, ocrMedia)`）同样判红；
- `tests/integration/ocr-http.mjs:1610-1611`：`app.ts` 全文不得出现 `ocr/media` 字样 ⇒ 只能用
  `OcrRouteDeps['media']` 这类型别名。

因此选了**改动面最小、且不删除任何断言**的一条：deps 增 `media` 键（与 `#181` 的 `history` 同性质），只把两处
**允许键集**各加一项，其余判据逐字保留。口径变宽这件事本身在两条断言的注释里**如实登记**（不主张「零端口注入仍成立」）。

## 5 两次读数

### 5.1 改前（`app.ts` 回滚到基线；`git stash push -- services/api/src/app.ts`）

`node --test tests/unit/media-port-injection-wiring.test.mjs` ⇒ **1 pass / 4 fail**：

```
✖ ① 注入可用端口 ⇒ 三域都拿到该端口（逐域断言；OCR 一支改前必红）
  AssertionError [ERR_ASSERTION]: OCR域：注入替身端口后 describe().mediaPort 必须是 substitute（实际 unwired ⇒ 注入口未接线）
  + 'unwired'  - 'substitute'
✔ ② 未注入且 real ⇒ 三域保持原有 fail-closed（端口形态 + HTTP 错误码/文案逐字）
✖ ③ memory 模式（stub / preset_demo）不受影响：默认替身，注入仍生效
  AssertionError: stub 下 OCR域注入必须仍然生效
  + '替身媒体引用端口（stub/preset_demo）：任意合法 uuid 媒体引用视为调用者名下、已就绪、版本一致；不上传、不读取真实照片。'
  - 'gy-r31-stub-…:ocr'
✖ ④ 注入的是同一个实例（不是内部又 new 了一个）
  AssertionError: OCR域：首次 describe 必须直接读到注入实例的 getter
✖ ⑤ 结构：BuildAppOptions 有 ocrMedia 槽位、装配行把它交下去、import 禁项仍成立
```

同一基线下的**端口/错误读数**（独立探针，`real` + 零注入）：

```
DESCRIBE ocr:         mediaPort=unwired mediaNote="媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有媒体字节（fail-closed）"
DESCRIBE recognition: mediaPort=unwired mediaNote="媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有媒体字节（fail-closed）"
DESCRIBE speech:      mediaPort=unwired mediaNote="媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有录音字节（fail-closed）"
HTTP ocr:         503 {"error":{"code":"PROVIDER_UNAVAILABLE","message":"缺少真实 OCR 供应商凭据（fail-closed，不回退替身）","retryable":false,"details":[]},…}
HTTP recognition: 503 {"error":{"code":"PROVIDER_UNAVAILABLE","message":"缺少真实识别供应商凭据（fail-closed，不回退替身）","retryable":false,"details":[]},…}
HTTP speech:      503 {"error":{"code":"PROVIDER_UNAVAILABLE","message":"缺少真实 ASR 供应商凭据（fail-closed，不回退替身）","retryable":false,"details":[]},…}
```

### 5.2 改后（最终改动）

`node --test tests/unit/media-port-injection-wiring.test.mjs` ⇒ **5 pass / 0 fail**：

```
✔ ① 注入可用端口 ⇒ 三域都拿到该端口（逐域断言；OCR 一支改前必红）
✔ ② 未注入且 real ⇒ 三域保持原有 fail-closed（端口形态 + HTTP 错误码/文案逐字）
✔ ③ memory 模式（stub / preset_demo）不受影响：默认替身，注入仍生效
✔ ④ 注入的是同一个实例（不是内部又 new 了一个）
✔ ⑤ 结构：BuildAppOptions 有 ocrMedia 槽位、装配行把它交下去、import 禁项仍成立
```

断言逐条对应派单要求：

| 派单要求 | 断言 | 判据（关键处） |
| --- | --- | --- |
| ① 注入 ⇒ 三域都拿到 | ① | 逐域 `describe().mediaPort === 'substitute'` 且 `mediaNote === 注入实例的 note`，且 ≠ 未接线文案 |
| ② 未注入 + real ⇒ 原错误码/文案 | ② | 逐域 `mediaPort === 'unwired'` + note 逐字；三域 `POST` 均 503 + `code` / `message` / `retryable=false` 逐字 |
| ③ memory 模式不受影响 | ③ | `stub` / `preset_demo` 默认 `substitute`；注入仍生效 |
| ④ 注入的是同一个实例 | ④ | `note` 用 getter 逐次递增：两次 `describe()` 必须读到 `#1` → `#2`（拷贝/新建都不可能递增） |
| （防回退）结构 | ⑤ | `ocrMedia?: OcrRouteDeps['media']` 在、装配行含 `media: ocrMedia`、四条 import 禁项仍 `false` |

三域改动前后对照：

| 域 | 改前（注入 `ocrMedia`/`recognitionMedia`/`speechMedia` 后） | 改后 |
| --- | --- | --- |
| OCR | `mediaPort=unwired`（注入被忽略） | `mediaPort=substitute`，`mediaNote` 回显注入实例 |
| 识别 | `mediaPort=substitute`（已生效） | 不变（仍生效；本片未改其装配） |
| 语音 | `mediaPort=substitute`（已生效） | 不变（仍生效；本片未改其装配） |

### 5.3 回归读数（改后）

- `node --test tests/unit/ocr-store-pg-wiring.test.mjs` ⇒ 4 pass / 0 fail（含「装配行恰五键 + 行尾 `ocrPersistencePool` + 四条 import 禁项」）。
- `node tests/integration/ocr-http.mjs` ⇒ exit 0（`PASS 14 组`；其中「产品装配 real 默认关闭」组仍断言
  `described.mediaPort === 'unwired'` 与 503 `PROVIDER_UNAVAILABLE`，本片未改该组）。
- `node tests/integration/recognitions-http.mjs` ⇒ exit 0。
- `node tests/integration/speech-http.mjs` ⇒ exit 0（其结构判据把语音装配行键集钉为八键，`media: speechMedia` 仍在）。
- `node --test tests/unit/media-port-injection-wiring.test.mjs` ⇒ 5 pass / 0 fail。
- `node --test "tests/unit/*.test.mjs"` ⇒ `tests 2617 / pass 2616 / fail 0 / skipped 1`，exit 0（本机需把
  `D:\Git\bin` 前置到 `PATH`，否则 `tests/unit/release-materials-index.test.mjs` 会因本机 `wsl.exe` 的
  `localhost 代理` stderr 噪声假红；该用例与本片无交集，前置 Git bash 后 5/5 通过）。
- 台账门禁：`node tools/verify-contract-status.mjs` ⇒ `形状错误 0 / 语义错误 0 / 表格漂移 0`，exit 0。
  **改前该门禁是红的**（`语义错误 2`，两条 `app.ts` 行号锚点因 +11 位移落到容差 ±2 之外），
  这正是第 8 条改动存在的理由，原文见下：

  ```
  ERROR: 语义错误 · requestAccountDeletion: services/api/src/app.ts:1791-1795 的锚点「accountDeletionWired」不在引用行范围内（容差 ±2 行；实际出现在第 1802、1804、1805、1806 行）
  ERROR: 语义错误 · dimension idempotency: services/api/src/app.ts:834-840 的锚点「idempotencyStore」不在引用行范围内（容差 ±2 行；实际出现在第 831、845 行）
  FAIL: 契约实现状态对照校验未通过（2 项）[形状错误 0 / 语义错误 2 / 表格漂移 0]
  ```

## 6 未取得 / 需裁定

1. **真实供应商调用未做，属另一片**（需要凭据与付费额度）：本片只证明「端口能被注入、能贯穿到域内」，**不**证明真实
   OCR/识别/ASR 供应商链路可用，也不声称任何准确率。
2. **媒体步（409 `OBJECT_UNAVAILABLE` / `媒体引用不可用`）在「产品装配 + real」下不可达**（供应商闸门在 `media.resolve`
   之前）。因此 ② 的「原错误码/文案」取的是**实际会返回的那一条**（503 `PROVIDER_UNAVAILABLE`），媒体端口自身的
   fail-closed 形态由 `mediaPort === 'unwired'` + `mediaNote` 原文钉住。若要求在 HTTP 面真实触达 409，需要为 OCR 域
   注入已接线 provider（属测试接缝，`ocr-http.mjs` 组 3d/12 已演示），本片未新增该接缝。
3. **口径变宽需裁定**：两处结构断言的允许键集从四键变五键（OCR 装配行多了 `media`）。这等价于承认「OCR 域的装配行
   允许一个可选端口槽位」。若不接受，可选替代是「第 5 个位置实参」，但那会打红
   `tests/unit/ocr-store-pg-wiring.test.mjs:116-119`（行尾必须是 `}, ocrPersistencePool);`），取舍见 §4.1。
4. 工作树路径与派单不一致（派单 `wt-r31-media-port`，实际 `wt-r31-tts-media`），已按实际路径施工；分支名与基线一致。

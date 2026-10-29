# GY-R69 · OCR 待识别图片字节来源接线（2026-10-29）

**一句话**：本片把「OCR 适配器从哪儿拿到待识别的图片字节」这件事从一个**写死、永远返回 `null` 的未接线来源**，换成一个**真实端口实现**（媒体登记册 → 媒体域对象存储 → 去元数据衍生件），并把端口接进装配。
**它证明的是「字节端口已接线、六类失败语义可判定」；它不证明「OCR 能力可用」** —— 没有真实凭据时仍然拿不到任何真实 OCR 结果，而且（见 §5）即使配齐凭据，`POST /ocr` 目前仍被**另一个**未接线端口挡在 `409`，本片一个字都没有改变这一点。

## 0 元信息

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-29（Asia/Hong_Kong） |
| 基线 sha | `b44f79418e57eaa5afab28915981223c33174af7`（`upstream/main`，提交信息 `docs: explain local knowledge visibility and seed diagnostics (#759)`） |
| 分支 / worktree | `feat/gy-r69-ocr-image-source` / `E:\GengYunCommander\wt-r69-ocr-bytes` |
| 改动范围 | `services/api/src/ai/ocr-image-source.ts`（新增）、`services/api/src/ocr/provider.ts`、`services/api/src/routes/ocr.ts`、`services/api/src/app.ts`、`services/api/src/speech/provider.ts`（仅注释改准，逐行等长）、`tests/unit/ocr-image-source.test.mjs`（新增）、`tests/unit/ocr-store-pg-wiring.test.mjs` 与 `tests/integration/ocr-http.mjs`（装配键集 5 → 6 如实登记）、`tests/unit/media-real-mode-fail-closed.test.mjs`（端口溯源 `objectStore` 实参 2 处 → 3 处如实登记）、本页 |
| 未碰 | `services/api/src/config.ts`（必填清单未改）、`services/api/src/ocr/state.ts`、`services/api/src/ocr/media.ts`、`services/api/src/registrations/**`、契约、迁移、CI |

## 1 缺口（改前读数，逐条可复核）

1. `services/api/src/ocr/provider.ts` 的 `createOcrProvider()` 在 `real` + 有被校验快照（`config.aiProviders.ocr`）的分支里**写死**了一个永远取不到字节的图片源：
   `imageSource: createUnwiredImageSource('真实对象存储未接线：取不到待识别的私有图片字节')`。
   `createUnwiredImageSource()`（`services/api/src/ai/ocr-live-adapter.ts`）恒返回 `null` ⇒ 适配器在 `extract` 第一步就落
   `failed PROVIDER_UNAVAILABLE`，**一个字节都发不出去**。
2. `createOcrProvider` 的入参里**没有**任何媒体端口（只有 `executionMode` / `endpoint` / `apiKey` / `aiProviders`）。
3. 另有**独立**的一处未接线：`services/api/src/ocr/media.ts` 的 `createOcrMediaPort('real')` 恒为 `createUnwiredMediaPort()`，
   它让 `POST /ocr` 的**受理前媒体校验**（`ocr/service.ts` 的 `createOcr` → `media.resolve`）恒返回 `OBJECT_UNAVAILABLE`。
   **本片没有动它**（不在本片范围，见 §5）。

## 2 改了什么

| 文件 | 职责（一句话） |
| --- | --- |
| `services/api/src/ai/ocr-image-source.ts`（新） | 真实 `OcrImageSource`：按 `media_id` + `revision` 读媒体登记册 → 只从对象存储取**去元数据衍生件**（`derivativeRef`）→ 校验 `Content-Type`；任一环节不成立即 `read() → null` 并留下既有契约码。 |
| `services/api/src/ocr/provider.ts` | `createOcrProvider()` 增**可选** `imageSource?: OcrImageSource \| null`：不给（`undefined` / `null`）⇒ 继续用写死的 `createUnwiredImageSource(…)`（**与接线前逐字节相同**）；给了 ⇒ 用它替换那一句。`authorization: PRODUCT_GATE_AUTHORIZATION` 原样保留；装配失败仍回落 `createRealOcrProvider(…)` 的 fail-closed，绝不回退替身。 |
| `services/api/src/routes/ocr.ts` | `OcrRouteDeps` 增 `imageMedia` **端口槽位**；缺省 `undefined` ⇒ 不传 `imageSource`（行为不变）；给了 ⇒ `createObjectStoreOcrImageSource(deps.imageMedia)` 交给 `createOcrProvider`。 |
| `services/api/src/app.ts` | OCR 装配点把媒体域**既有**的 `mediaObjectStore` + `mediaStore` 按语音侧 `speechAudioMedia` 同形转发（`const ocrImageMedia = { objectStore: mediaObjectStore, mediaRecords: mediaStore }`）：不新建对象存储、不读 env、不铸造批准能力。 |
| `services/api/src/speech/provider.ts` | 仅**注释改准**：文件头「没有已审真实 ASR 供应商适配器」属过期陈述（同文件已 import 并装上真实适配器），改为如实描述。逐行等长替换，行数未变。 |
| `tests/unit/ocr-image-source.test.mjs`（新） | 10 条用例：正控制（字节真的进请求体）、六类坏输入矩阵、端口未配置、等价性、零外呼绊线、装配点行为与结构、结构性自证。 |
| `tests/unit/ocr-store-pg-wiring.test.mjs`、`tests/integration/ocr-http.mjs` | 两条既有的「装配行键集」结构钉子按本仓口径**只加白名单**：五键 → 六键（新增 `imageMedia`），原意（不得塞入 `store`/`provider`/`reference` 等实现层适配器）逐字保留。 |

**为什么读衍生件而不是原件**（与语音侧 `asr-audio-source.ts` 读 `rawRef` 的唯一刻意差异）：媒体域的口径是「对外只提供**已去元数据**的衍生件；原始对象不出网」（`services/api/src/media/service.ts` 的社区取图路径自述，证据见 [gy-i06 真实存储方案](gy-i06-media-real-provider-plan-20261021.md) §6「两个对象」）。图片原件含相机 GPS/EXIF，把它送去第三方 OCR 等于把定位一起送出去 ⇒ 本端口**只**读 `derivativeRef`，没有衍生件就 fail-closed（绝不回退读原件）。

## 3 什么被证明了

1. **字节真的能流到适配器**：`tests/unit/ocr-image-source.test.mjs` 的
   `A·正控制：只读去元数据衍生件取到字节，且字节逐字节进请求体、恰好一次发送` ——
   `ImageBase64` 解码后与对象存储端口里的那 24 字节合成 PNG **逐字节相同**，`getObject` 只被以衍生件键调用**一次**、原件键**一次都没被读**。
2. **失败语义可判定**：`B·失败矩阵` 覆盖 13 个分支（记录不存在 / 两键皆空 / 只有原件 / 对象不存在 / 端口抛 `MediaError('PROVIDER_UNAVAILABLE')`（码原样保留）/ 端口抛无码错误 / `Content-Type` 为 `image/webp` / `Content-Type` 缺失 / 空字节 / 未就绪 / 跨用途 / 版本不符 / 登记册抛错），每条都断言 `read() === null`、`lastFailure()` 为**既有契约码**、原因文本可读且**不含对象键**，并且经适配器后一律 `{kind:'failed', code:'PROVIDER_UNAVAILABLE'}`、**零预留、零结算、零发包**。
3. **「不给端口 ⇒ 行为不变」**：`C·等价性` 用同一输入把 `createOcrProvider({...})`（不给 / 显式 `null`）与**接线前的装配**（`createLiveOcrProviderFromConfig` + 写死的未接线来源）逐字段对比：`executionMode` / `modelVersion` / `available` / `unavailableReason` / `extract` 结局**全部相同**；并用源码断言钉住那一句装配表达式（含逐字未变的 reason）仍在。
4. **零外呼**：`D·零外呼` 用 `globalThis.fetch` 绊线，证明「没给端口」「给了端口但端口未配置」「端口齐备但登记册没有该行」三条路径**一次请求都不发**（绊线计数为 `0`）。
5. **装配点真的把端口交下去了**：`E·装配点行为` 走**产品同一个** `registerOcrRoutes()`，只注入 `imageMedia`（媒体登记册 + 对象存储），任务落 `succeeded`、`describe().providerCalls === 1`、请求体里就是那一段字节 —— 说明槽位没有被吞掉、没有回退未接线来源；`E·装配点结构` 另外钉住 `app.ts` 的转发形状（`{ objectStore: mediaObjectStore, mediaRecords: mediaStore }`）、装配行六键、以及 `app.ts` 仍不引用任何 OCR 适配器模块。
6. **统计口径**：`F·结构性自证` 断言新文件不读 ambient env、不碰文件系统、不出现 `fetch(`；失败码四值全在契约 `ERROR_CODES` 闭集内；用途/类型与 `packages/media/constants.mjs` 逐条对齐（`image/webp` 上传合法但本适配器不吃 ⇒ 明确拒绝）。

## 4 什么**没有**被证明（不得外推）

1. **没有真实凭据时仍然拿不到真实 OCR 结果。** 本片全部字节都是 24 字节合成 PNG 头，全部检出文本是合成占位串；**零**真实标签照片、**零**真实供应商响应。
2. **不证明「OCR 能力可用」**，也不产生任何识别准确率/字段抽取正确率结论（样本为 0，见 [样本缺口登记](../evaluation/sample-gap-register.md)）。
3. **不证明 `POST /ocr` 能到 202。** 见 §5：受理前的媒体引用端口仍 `unwired`，`POST /ocr` 仍是 `409 OBJECT_UNAVAILABLE`（本片**改前改后同读数**，由下面的探针记录）。
4. **不证明真实对象存储/真实桶可用**：`getObject` 全部走注入的假端口或仓内替身端口，**零**真实网络往返；`s3_compatible` 适配器的真实签名/桶策略未在本片验收。
5. **不证明衍生件的字节身份**：媒体登记册的 `bytes` / `sha256` 描述的是**原件**；衍生件是去元数据后的另一份字节，**没有**可比对的登记摘要 ⇒ 本端口只校验「对象存在 + 非空 + `Content-Type` 可接受」，**没有**语音侧那样的长度/sha256 身份校验。这是本片如实登记的**弱点**（换对象/换版本的风险由 `revision` 一致性与 `Content-Type` 承担，强度弱于语音侧）。
6. **不证明归属校验**：语音侧会拿任务归属源核对「这段录音归谁」；OCR 侧没有把 `OcrStore` 接进本端口（本片只转发媒体域既有两个端口），归属仍由 `ocr/service.ts` 的 `media.resolve` 在上游负责 —— 本端口**不重复也不替代**它。
7. **不证明 EXIF 清除的实际效果**：只证明「读的是衍生件键」这一结构事实，未用真实相机原图验证衍生件里确实没有 EXIF。

## 5 本片未关闭的缺口（探针实测，需裁定）

用 `loadConfig`（`real` + 合成占位凭据，`TENCENTCLOUD_SECRET_ID/KEY` 齐备）+ **产品装配** `buildApp(...)` 起真实应用（不连库、不联网，`globalThis.fetch` 换成绊线），直接 `POST /api/v1/ocr`。
同一探针在两棵树上各跑一次（**改前** = 干净的 `b44f7941` 工作树；**改后** = 本片 HEAD），读数**逐字段相同**：

```
{"status": 409,
 "body": {"error": {"code": "OBJECT_UNAVAILABLE", "message": "媒体引用不可用", "retryable": false}},
 "providerAvailable": true, "mediaPort": "unwired", "providerCalls": 0}
```

即：**凭据齐备时 provider 已经可用（`tencent-generalaccurateocr-2018-11-19`、`mediaNote` 为「媒体 HTTP 路由已注册，但未接真实对象存储…」），但受理在 `media.resolve` 处被 `createOcrMediaPort('real')` 恒拒；本片改前改后都是这个 409。** 这是与「图片字节来源」并列的**第二个**未接线端口，本片按范围没有动它（`services/api/src/ocr/media.ts` 一个字节未改）。要让 `POST /ocr` 到 202 并真正发出一次请求，需要另起一片把 `OcrMediaPort` 也接到媒体域（同一对 `mediaStore` + `mediaObjectStore`），这属于业务语义变更（`409` → `202`），需指挥裁定。

## 6 失败语义表（六类坏输入 + 四类附带）

| 触发条件 | `lastFailure()`（诊断） | `lastFailureReason()`（诊断，不含对象键） | 适配器对外 |
| --- | --- | --- | --- |
| 媒体记录不存在 | `NOT_FOUND` | 媒体记录不存在 | `failed PROVIDER_UNAVAILABLE`，零预留零发包 |
| `rawRef` 与 `derivativeRef` 均为空 | `OBJECT_UNAVAILABLE` | 媒体没有对象键（…均为空） | 同上 |
| 只有含元数据的原件（`derivativeRef` 空） | `OBJECT_UNAVAILABLE` | 媒体只有含元数据的原件…按「原始对象不出网」不外发 | 同上 |
| `getObject` 返回 `null` | `OBJECT_UNAVAILABLE` | 对象存储里没有该对象 | 同上 |
| `getObject` 抛 `MediaError('PROVIDER_UNAVAILABLE')` | `PROVIDER_UNAVAILABLE`（**原样保留**） | 对象存储取字节失败 | 同上 |
| `getObject` 抛其它错误 | `OBJECT_UNAVAILABLE` | 对象存储取字节失败 | 同上 |
| `Content-Type` 不在 `image/png` / `image/jpeg` 内（含缺失） | `OBJECT_UNAVAILABLE` | 对象 Content-Type 不在 OCR 可接受类型内（…） | 同上 |
| 对象字节为空 | `OBJECT_UNAVAILABLE` | 对象字节为空 | 同上 |
| 媒体未就绪 / 用途非 `label_ocr` | `OBJECT_UNAVAILABLE` | 媒体未就绪（state=…）/ 用途不是标签 OCR | 同上 |
| 登记册 `revision` ≠ 请求 `revision` | `REVISION_CONFLICT` | 媒体版本已推进（登记 N，请求 M） | 同上 |
| 端口未配置（缺登记册/对象存储） | `PROVIDER_UNAVAILABLE` | 端口未配置：缺 … | 同上 |

内部码**不**改变对外结局是既有红线（适配器把本地拒绝统一映射成 `PROVIDER_UNAVAILABLE`，见 `services/api/src/ai/ocr-live-adapter.ts` 的 `extract`），内部码只作诊断：不落库、不含私有引用、不含图片内容。

## 7 门禁读数（本片自跑，全部 exit 0）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | `tests 5743 / pass 5739 / fail 0 / cancelled 0 / skipped 2` | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（行号区间 313 条；中文表格一致）；`verify-doc-anchors --strict` PASS（基线外新增 0、陈旧 0、`BARE_ORPHAN` 基线外新增 0） | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`，标记块与重算一致 | 0 |
| `npm run test:docs` | 研究记录 5 通过 / 0 失败 / 4 legacy 已钉住；`docs/research` 结构校验 PASS | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `fail 0` | 0 |
| `npm run build` | api + admin 均 `built`（见下方环境注记） | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |

> 环境注记（如实登记，与本片代码无关）：`npm run build` 在**默认用户 TEMP**下会在 `apps/admin` 的 `vite:esbuild-transpile` 阶段报
> `remove C:\Users\MR\AppData\Local\Temp\esbuild-…: Access is denied`；把 `TEMP`/`TMP` 指向本机可写目录后同一条命令 exit 0。
> 该失败在**未改动的基线工作树**（`wt-r69-consent-import`，`b44f7941`）上**同样复现**，因此判为环境限制，不是本片引入。
> 另：`services/api/dist` 一旦存在，`tests/moderation/model-ports.test.mjs` 的「文书边界」会把构建产物算作模型合流消费者而判红 —— 这与本片无关，
> 但**跑 `test:unit` 前不要留着 `dist/`**（CI 顺序是先测后构建）。

行号策略：`services/api/src/**` 的改动**全部等长替换**（新增 import / 字段 / 装配实参都并到既有行上，`app.ts` 的 `ocrImageMedia` 声明与 `ocrPersistencePool` 同行），`git diff --numstat` 逐文件读数 5/5、8/8、3/3、2/2，因此**没有**产生行号漂移、不需要 `--reanchor`。三处测试文件的结构钉子也按新键集/新处数**等长**更新（`media-real-mode-fail-closed.test.mjs` 为 20/20，净值 0 行），所以 `docs/verification/gy-i06-media-real-provider-plan-20261021.md` 里对该测试文件的**两处行号引用**（原写 `1121` 行与 `1298` 行）仍然落在原来的实质行上。

## 8 负控制（每条实际打出并记录红在哪）

| # | 怎么打的 | 红在哪（逐字摘录） | 恢复后 |
| --- | --- | --- | --- |
| ① | 删掉 `ocr-image-source.ts` 里「无对象键」判据（`derivativeRef` 空判），配一个**对任意键都返回那段 PNG** 的假对象存储 | 探针读数由 `REJECTED / OBJECT_UNAVAILABLE / objectKeysRead: []` 变成 **`PASSED_24_BYTES / lastFailure: null / objectKeysRead: ["null"]`** —— 即**没有对象键的媒体直接拿到了 24 字节**；同时 `B·失败矩阵` 红：`rawRef 与 derivativeRef 均为空（无对象键）：原因应为「没有对象键」，实际「对象存储里没有该对象」` | 10/10 绿 |
| ② | 把 `getObject` 的 `catch` 改成吞掉异常并塞空字节包 | `B·失败矩阵` 红：`getObject 抛 MediaError(PROVIDER_UNAVAILABLE)（未接线端口）——码必须原样保留：内部失败码` ⇒ `+ 'OBJECT_UNAVAILABLE'` / `- 'PROVIDER_UNAVAILABLE'`（**码变了**） | 10/10 绿 |
| ③ | 把 `provider.ts` 里硬编码的 `createUnwiredImageSource(…)` 直接换成 `createObjectStoreOcrImageSource({})`（不给端口） | `C·等价性` 红：`未给端口时必须仍用写死的未接线来源（含逐字未变的 reason）`（此形态下 `extract` 结局仍相同 ⇒ 这正是「装配表达式逐字」那条钉子的作用） | 10/10 绿 |
| ④ | 把 `Content-Type` 校验改成恒真（`if (false as boolean)`） | `B·失败矩阵` 红：`Content-Type 不受支持（image/webp：label_ocr 合法上传、本适配器不可识别）：必须返回 null（绝不返回空字节/替身图）` | 10/10 绿 |

恢复方式与自证：每次用改动前的副本覆盖回源文件，并核对 SHA256 与负控制前一致
（`ocr-image-source.ts` = `24DFC2D3A6EEE685…`、`provider.ts` = `8BE395BE7F09CF15…`），再复跑本片用例到 `10 / 10 绿`；
全套 `test:unit` 的成绩（`5743 / 5739 / 0 / 2`）是在这**同一份字节**上取得的。

## 9 未取得项（本页不声称）

| 项 | 状态 |
| --- | --- |
| 真实腾讯云 OCR 调用、真实返回 | **未取得**（无凭据；本片全程零外呼，`globalThis.fetch` 绊线计数 0） |
| `POST /ocr` 到 202 | **未取得**（卡在 `OcrMediaPort` 未接线，见 §5；本片改前改后同为 409） |
| 真实对象存储取字节 / 去 EXIF 衍生件的真实内容 | **未取得**（只用假端口与合成 24 字节 PNG 头） |
| 衍生件字节与登记 `sha256` 的身份比对 | **不做**（登记摘要描述的是原件，衍生件无摘要可比，见 §4 第 5 条） |
| 标签类真实样本与任何准确率 | **0**（见 [样本缺口登记](../evaluation/sample-gap-register.md)） |

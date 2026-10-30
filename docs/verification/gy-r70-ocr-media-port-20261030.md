# GY-R70 · OCR 受理前媒体端口接线（2026-10-30）

**一句话**：本片把 `POST /ocr` 的**受理前媒体门**（`ocr/service.ts` 的 `media.resolve`）在 `real` 下从一个**写死、恒拒**的未接线端口，换成**真实的 `OcrMediaPort` 实现**（媒体域既有的 `mediaStore` + `mediaObjectStore` 两个端口），并把端口接进装配。
**它证明的是「受理前的媒体门不再恒拒、且坏输入逐条可判定」；它不证明「OCR 能力可用」** —— 没有真实腾讯云凭据时，受理后是否真的发包、识别质量如何，都不在本片（§4、§9）。

## 0 元信息

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-30（Asia/Hong_Kong） |
| 基线 sha | `53354fe71381cd363c1a0220dec5649daa7d3b63`（提交信息 `test(privacy): exercise empty consent policies in PostgreSQL CI (#767)`） |
| ⚠ 基线复核读数 | 任务书给的是「`upstream/main` = `53354fe7`」；**实测 `upstream/main` = `2bbb9e38`**（`fix(miniprogram): isolate stale history detail delete callbacks`，是 `53354fe7` 之后**一个** miniprogram 提交；`origin/main` 仍是 `53354fe7`）。本片按任务书**逐字**在 `53354fe7` 上开分支（该提交不触及 `services/api/**`）⇒ 合并时需以当时的 `upstream/main` 为准重跑门禁。**此项请裁定**（§7 第 4 条）。 |
| 分支 / worktree | `feat/gy-r70-ocr-media-port` / `E:\GengYunCommander\wt-r70-ocr-media` |
| 代码提交 | `c2fdf409`（本页为其后追加的文档提交；代码内容未变） |
| 改动范围 | `services/api/src/ocr/media.ts`、`services/api/src/routes/ocr.ts`、`services/api/src/app.ts`、`tests/unit/ocr-media-port.test.mjs`（新增）、`tests/unit/ocr-store-pg-wiring.test.mjs` / `tests/unit/ocr-image-source.test.mjs` / `tests/integration/ocr-http.mjs`（装配键集 6 → 7 如实登记）、本页 |
| 未碰 | `services/api/src/config.ts`（必填清单未改、未新增任何环境变量）、`services/api/src/media/**`（未新建对象存储、未铸造批准能力）、`services/api/src/ocr/service.ts`（受理顺序未动）、`services/api/src/ocr/state.ts`、契约 `packages/contracts/**`、迁移、CI、`docs/architecture/contract-status.json`（未改，见 §8） |

## 1 缺口（改前读数，逐条可复核）

1. `services/api/src/ocr/media.ts:76-78`（改前）只有一行分派：
   `return executionMode === 'real' ? createUnwiredMediaPort() : createSubstituteMediaPort();`
   ⇒ `real` **恒为未接线端口**，`resolve()` 恒 `{ ok: false, code: 'OBJECT_UNAVAILABLE' }`（`services/api/src/ocr/media.ts:69-71`）。
2. 该端口只在受理函数的**媒体校验步骤**被触达，而它前面还有域级供应商闸门：
   `services/api/src/ocr/service.ts:474-484` 先判 `provider.available`，再 `await media.resolve(...)`。
   因此改前实测的失败序是：`real` 缺凭据 ⇒ **503**；凭据齐备 ⇒ 走到媒体门 ⇒ **409**；**没有 202 这一档**。
3. 上一片 #766（GY-R69）已经把**图片字节来源**接上，但其证据页 §5/§9 明确登记
   「`POST /ocr` 仍被**另一个**未接线端口挡在 409 … 本片没有动它」「`POST /ocr` 到 202：**未取得**」。
   **本片关的就是那一格**；#766 的那一页保持为当时事实的历史记录，本片不改写它。

## 2 改了什么

| 文件 | 职责（一句话） |
| --- | --- |
| `services/api/src/ocr/media.ts` | 新增**真实端口** `createObjectStoreOcrMediaPort()`（`services/api/src/ocr/media.ts:223`）：按 `media_id` 读媒体登记册校验归属/版本/就绪/用途/衍生件键 → 从对象存储取**去元数据衍生件** → 校验 `Content-Type`；任一环节不成立即落**既有三码闭集**。新增身份判据 `ocrMediaRealRefusal()`（`:173`）与闭集 `OCR_MEDIA_REAL_REFUSALS`（`:141`）：对象存储必须是 `s3_compatible` 真实适配器，否则仍是 `unwired`。`createOcrMediaPort(executionMode, wiring?)` 增**可选**第二参（`:76-78`，逐行等长）；`real` 的唯二分派口 `createRealOrUnwiredPort()`（`:281`）**只**落真实端口或未接线端口，⛔ 永不落替身。 |
| `services/api/src/routes/ocr.ts` | `OcrRouteDeps` 增 `mediaWiring?: OcrMediaPortWiring` **端口槽位**（可选，缺省 `undefined`）；`services/api/src/routes/ocr.ts:197` 由 `createOcrMediaPort(config.executionMode)` 改为 `createOcrMediaPort(config.executionMode, deps.mediaWiring)`，**逐行等长**。 |
| `services/api/src/app.ts` | 装配点把**同一个** `ocrImageMedia`（媒体域既有的 `mediaObjectStore` + `mediaStore`）**再**交给 `mediaWiring`（`services/api/src/app.ts:2482`）：⛔ 不新建第二个字面量、不读 env、不铸造批准能力、不在装配层做放行判断。 |
| `tests/unit/ocr-media-port.test.mjs`（新） | 10 条用例：25 种坏输入矩阵、正控制（端口 `ok` + HTTP **202**）、等价性探针（不给端口 ⇒ 逐字段相同）、失败序（503 → 409/404 → 202）、零外呼绊线、产品装配（`buildApp` 注入真实对象存储 ⇒ `mediaPort=real`）、装配点结构、结构性自证。 |
| `tests/unit/ocr-store-pg-wiring.test.mjs`、`tests/unit/ocr-image-source.test.mjs`、`tests/integration/ocr-http.mjs` | 三处既有的「装配行键集」结构钉子按本仓口径**只加白名单**：六键 → 七键（新增 `mediaWiring`）。原意（不得塞入 `store`/`provider`/`reference` 等实现层适配器）**逐字保留**。 |

### 2.1 与语音侧 `speech/media.ts` 的同与异（刻意，不是漏抄）

- **同**：`kind` 即身份（`substitute` / `real` / `unwired`）、`wiring` 全可缺、对象存储必须 `s3_compatible` 才认、拒绝原因走闭集且只进 `note`/诊断、绝不新造对外错误码。
- **异一（刻意）**：本端口**真的取一次字节**。语音侧受理期只读登记册、把字节与 `sha256` 留给转写期 `AudioSource`（那里有逐字节校验兜底，且整段录音不该下载两遍）。OCR 侧没有这层兜底：适配器只认 PNG/JPEG **头部**，一个「登记册说 ready、对象却是 `application/octet-stream` 或 0 字节」的媒体会被受理、再在识别期失败，客户端拿到一个必然失败的 202。故这里当场证明**对象取得到、类型吃得下**。代价见 §7 第 1 条。
- **异二（本片范围外，需裁定）**：语音侧还有**第三道门** `mediaDomainRefusal`（沿用媒体域构造期裁决 `AppMediaService.failClosedReason`）。任务书给本片的输入是**两个端口**，故本片**没有**接入这道门 —— 含义与风险见 §4 第 5 条、§7 第 2 条。

## 3 什么被证明了

1. **受理前的媒体门不再恒拒**：给了端口 + 合法媒体 + 有可用提供者 ⇒ 端口 `resolve()` 返回 `{ ok: true, revision: 1 }`，`POST /ocr` 返回 **202**（`data.state = "queued"`），且 `describe().mediaPort === 'real'`、`mediaNote` 是真实端口文案。
2. **装配点是真转发，不是变量摆设**：`buildApp` 注入真实对象存储 + 已就绪登记册 ⇒ `app.ocrService.describe().mediaPort === 'real'`；**不**注入 ⇒ 仍是 `'unwired'`。同一份产物里，"注入了什么"直接决定端口身份。
3. **坏输入逐条可判定**（25 种，§6）：记录不存在 / 越权 / 版本不符 / 四种未就绪态 / 三种跨用途 / 无衍生件键 / 空键 / 对象不存在 / 零字节 / 四种不受支持的类型 / 端口抛错（无码、带 `NOT_FOUND`、未接线端口） / 登记册抛错 …… 全部落到既有三码闭集，且**不泄露**对象键（拒绝结果只有 `{ok, code}` 两个字段）。
4. **「不给端口 ⇒ 行为不变」**：同一个 `POST /ocr` 探针在「改前装配」（显式装 `createUnwiredMediaPort()`）与「改后装配」（`deps.mediaWiring` 缺省）上的读数**逐字段相同** —— `status=409`、`errorCode=OBJECT_UNAVAILABLE`、`errorMessage` 逐字相同、`retryable=false`、`mediaPort="unwired"`、`mediaNote` 逐字相同、`providerCalls=0`、`jobState=null`。另：`app.ts` **无条件转发** `mediaWiring` 的那一格也不会偷放行 —— 对象存储是未接线端口时仍是 `unwired`，`note` 与本片之前逐字相同（`tests/unit/runtime-strings-truth.test.mjs` 的逐字钉子仍绿）。
5. **失败序正确**（§5）：`503` 在**前**（域级供应商闸门），媒体门是第二道（`409`/`404`），全成立才 `202`。
6. **零外呼**：全部拒绝路径 + 202 路径（含 `buildApp` 产品装配路径）全程 `globalThis.fetch` 绊线**计数 0**。
7. **只读、不越界**：端口只读衍生件（`derivativeRef`），**原件键一次都不读**；不 `putObject`、不 `deleteObject`、不读 ambient env、不碰文件系统、不新造错误码。

## 4 什么**没有**被证明（不得外推）

1. **不证明「OCR 能力可用」**。没有真实腾讯云凭据；受理后是否真的发包、模型返回什么、识别质量如何，**全不在本片**。本片证的是「受理前的媒体门不再恒拒」。
2. **202 的正控制用的是「注入的 available 提供者」**（接缝替身，标注 `stub-seam-r70-v1`），**不是**真实凭据。刻意如此：若用合成凭据去构造真实适配器，202 之后的执行期会**真的尝试外呼**（本片禁止）。因此「202」证明的是**装配顺序与媒体门**，不是「真实凭据下也一定 202」。
3. **不证明真实对象存储往返**。对象存储是 `MediaObjectStore` 的测试替身（进程内 `Map`，`kind: 's3_compatible'`），⛔ 不是第二套 S3/COS 客户端；字节是合成 24 字节 PNG 头，不含任何真实照片/EXIF。
4. **不证明受理之后的任何一环**：真实发包、去元数据衍生件的真实内容、`sha256` 身份比对、识别结果、`dose_cards`、准确率，均未取得（§9）。
5. **未接入媒体域构造期裁决**（与语音侧的第三道门差异，§2.1 异二）。可观测含义：若媒体域因「缺批准能力 / 缺持久化键」**整域 503**，而对象存储端口**仍是**真实 `s3_compatible` 适配器、登记册**仍是**真实 PG，则本端口**仍可能**为一条已就绪的 `label_ocr` 媒体放行。本片不改这一点（任务口径只给两个端口），**请裁定是否需要补第三道门**（§7 第 2 条）。
6. **不构成多实例/多进程一致性结论**：受理期的对象读取与识别期的字节读取是**两次**读取，两者之间对象被替换/删除的竞态未做任何处理（识别期仍会 fail-closed，但受理已发 202）。

## 5 失败序实测表（同一 `POST /ocr` 探针，逐条打出）

| # | 条件 | 状态码 | 错误码 | `providerCalls` | 建任务 |
| --- | --- | --- | --- | --- | --- |
| ① | `real` + **无** OCR 凭据（`provider.available=false`）+ 媒体端口**完全合法** | **503** | `PROVIDER_UNAVAILABLE`（`retryable=false`） | 0 | 否 |
| ② | `real` + 凭据齐备 + 媒体**未就绪** / 用途不符 / 无衍生件键 / 对象取不到 / 类型不受支持 | **409** | `OBJECT_UNAVAILABLE` | 0 | 否 |
| ③ | `real` + 凭据齐备 + 媒体**记录不存在**（或归属者不符，同形） | **404** | `NOT_FOUND` | 0 | 否 |
| ④ | `real` + 凭据齐备 + **合法媒体** | **202** | —（`data.state="queued"`） | 1（执行期，`settle()` 后） | 是 |

顺序的判据就是「① 的媒体端口完全合法却仍 503」：这证明 `provider.available` 的判定**先于** `media.resolve`，即**503 在前 → 端口 → 202**。①↔② 的状态码不同 ⇒ 两道门没有互相冒充。

## 6 失败语义表（端口内部 → 对外）

| 触发条件 | 返回码 | HTTP | 备注 |
| --- | --- | --- | --- |
| `mediaRevision` 不是 `>=1` 整数（0 / 小数 / 负数） | `REVISION_CONFLICT` | 409 | 与替身端口同口径（形状不合法即版本冲突） |
| 登记册读不起来，且抛出的码在闭集内 | 该闭集码原样保留 | 404 / 409 | 不掩盖来源 |
| 登记册读不起来，抛出的码不在闭集内 | `OBJECT_UNAVAILABLE` | 409 | 保守拒绝 |
| 记录不存在 **或** 归属者不符 | `NOT_FOUND` | 404 | **同形**，不泄露存在性 |
| 请求 `revision` ≠ 登记册 `revision` | `REVISION_CONFLICT` | 409 | |
| `state` ∉ {`ready`}（`initiated` / `processing` / `rejected` / `deleted`） | `OBJECT_UNAVAILABLE` | 409 | |
| `purpose` ∉ {`label_ocr`}（`weed_recognition` / `community_image` / `voice_question`） | `OBJECT_UNAVAILABLE` | 409 | 跨用途取值一律拒 |
| `derivativeRef` 为 `null` 或 `''`（只有含 EXIF 的原件） | `OBJECT_UNAVAILABLE` | 409 | 「原始对象不出网」 |
| 对象存储里没有该对象 | `OBJECT_UNAVAILABLE` | 409 | |
| 对象字节为 0 | `OBJECT_UNAVAILABLE` | 409 | ⛔ 绝不把空字节当成功数据 |
| `Content-Type` ∉ {`image/jpeg`, `image/png`}（含 `image/webp` / `application/octet-stream` / 缺失 / `text/plain`） | `OBJECT_UNAVAILABLE` | 409 | 与适配器真正能解析的类型**同源**（见下） |
| 对象存储端口抛错（无码 / 未接线端口的 `PROVIDER_UNAVAILABLE` / 闭集码） | 闭集码原样保留，否则 `OBJECT_UNAVAILABLE` | 404 / 409 | 未接线端口的 `PROVIDER_UNAVAILABLE` **不进**受理码闭集（那是契约面码，不为诊断扩容） |

**口径同源**：`image/jpeg` + `image/png` 与「只许 `label_ocr`」这两份判据**不是**复制品 —— 它们从 `services/api/src/ai/ocr-image-source.ts:56-78` **import**（与 #766 的识别期字节来源吃同一份常量），因此「受理通过、取字节却拒绝」这种错位只可能来自**事实在两次读取之间变了**，不会是两处口径漂移。`media.ts` 的 import 写在**文件末尾**（ESM 提升，语义等价），目的是让前 78 行的行号与本片之前**逐字不动**（理由见 §8）。

## 7 已知成本与需裁定项

1. **受理期多一次对象下载**（§2.1 异一）：真实桶上每受理一次 = 取一次衍生件全量字节。备选是新增「只读类型/元数据」的端口方法（`headObject`）或只读头部若干字节 —— 那要改媒体域端口面或契约，本片**未做**。是否值得改，请裁定。
2. **是否补「媒体域构造期裁决」第三道门**（与 `speech/media.ts` 对齐）。本片按任务口径只用两个端口；风险见 §4 第 5 条。
3. **一个 deps 键喂两个消费点**：`mediaWiring` 与 `imageMedia` 是**同一个对象**（`app.ts:2481-2482`），因此两者永不漂移，但将来若「受理门」需要不同端口（例如只做 `headObject` 的窄端口），必须拆开。当前这是**有意的**同源。
4. **基线漂移**：`upstream/main` 已是 `2bbb9e38`（本片基线 `53354fe7` 之后一个 miniprogram 提交）。合并前需在当时的 `upstream/main` 上复跑门禁。**请裁定是否以 `2bbb9e38` 为合并基线重开分支。**

## 8 门禁读数（九条 + CI-exact anchors + 两条额外，全部 exit 0）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | `tests 5784 / pass 5780 / fail 0 / cancelled 0 / skipped 2 / todo 2` | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（覆盖 126 条操作；行号区间 313 条 + 4 条片段；中文表格一致）；`verify-doc-anchors --strict` PASS（基线外新增 0、陈旧 0） | 0 |
| **CI-exact**：`node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `SYMBOL-STRICT-BASELINE` 31 条全命中、基线外新增 0、陈旧 0；`ANCHOR_DRIFT` 15 条全部落在基线内（基线外新增 0） | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`；标记块与重算一致 | 0 |
| `npm run test:docs` | 研究记录 5 通过 / 0 失败 / 4 legacy 已钉住；`docs/research` 结构校验 PASS | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run build` | api + admin 均 `built`（`TMP`/`TEMP` 指向**仓外** `E:\GengYunCommander\.pg17\tmp\gy-r70-ocr-media\buildtmp`；build 后已删除 `services/api/dist` 与 `apps/admin/dist`） | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |
| 额外·`node tests/integration/ocr-http.mjs` | `PASS 14 组`；OCR 域装载边 12 条**全部命中冻结基线**、基线之外 **0** 条、丢失基线 0 条 | 0 |
| 额外·`node --test tests/unit/ocr-media-port.test.mjs` | `tests 10 / pass 10 / fail 0` | 0 |
| 额外·`node tools/verify-contract-status.mjs --reanchor`（dry-run） | `无可重定位项（带锚点且带行号的引用 302 条，锚点都在 ±2 行容差内）` ⇒ **台账未改、无需 `--write-doc`** | 0 |

**行号策略（零漂移，因此台账不用动）**：`git diff --numstat 53354fe7..HEAD` 逐文件为
`app.ts 2/2`、`ocr/media.ts 243/21`、`routes/ocr.ts 3/3`、`ocr-http.mjs 2/2`、`ocr-image-source.test.mjs 3/3`、`ocr-store-pg-wiring.test.mjs 5/5`。
其中三处代码文件的改动**全部等长**：

- `services/api/src/app.ts:2481-2482`（新说明写成行尾块注释，`{...}` 里只加 `mediaWiring: ocrImageMedia`）；
- `services/api/src/routes/ocr.ts:35`、`:72`、`:197`（各 1 行换 1 行，import 与字段并到既有行）；
- `ocr/media.ts` 的 **1-78 行行号逐字不动**（头注等长改写、`createOcrMediaPort` 仍占 76-78），全部新增内容在 78 行之后；新增的 import 放在**文件末尾**（ESM 提升 ⇒ 语义等价，与本仓 `routes/ocr.ts` 既有做法同源）。

因此 `docs/verification/gy-r28-w12-media-persistence-20261022.md`、`gy-r29-chain-e2e-20261022.md`、`gy-r31-i14-image-path-20261022.md` 里对 `services/api/src/ocr/media.ts:69-71` / `:76-78` / `:77` / `:26-36` 的四组行号引用**仍然落在原来的实质行上**，`--reanchor` 判「无可重定位项」。

**既有结构断言更新（前 → 后，逐条登记）**：

| 断言 | 前 | 后 | 是否放宽 |
| --- | --- | --- | --- |
| 装配行键集（`ocr-store-pg-wiring.test.mjs`、`ocr-image-source.test.mjs`、`ocr-http.mjs` 三处） | 六键 `consent/egress/guards/history/imageMedia/media` | 七键，+`mediaWiring` | **否**：只把新增的**端口槽位**列进白名单，`store`/`provider`/`reference` 仍不得成为装配键，`import` 禁项逐字保留 |
| `app.ts` 端口溯源审计（`media-real-mode-fail-closed.test.mjs`：`objectStore` 赋值位点） | 3 处 | **3 处（未变）** | **否**：本片靠**复用**同一个 `ocrImageMedia` 对象做到，审计一个字符都没改 |

## 9 负控制（五条，每条实际打出并记录红在哪；恢复后逐条复绿）

| # | 怎么打的（改哪一行） | 红在哪（逐字摘录） | 恢复后 |
| --- | --- | --- | --- |
| ① | 删掉「未就绪」判据：`if (record.state !== 'ready') …` | `A·失败语义表` 红：`未就绪 initiated：必须拒绝（绝不静默放过）`，`actual: true`（**未就绪媒体被放行**）；连带 `E·失败序` 红（第②档不再是 409） | 10/10 绿 |
| ② | 把 `getObject` 的 `catch` 改成吞成空字节包（`{ bytes: new Uint8Array(0), contentType: 'image/png' }`） | `A·失败语义表` 红：`对象存储抛 NOT_FOUND（闭集码原样保留）：错误码应为 NOT_FOUND，实际 OBJECT_UNAVAILABLE` —— **码变了**（闭集码不再被保留） | 10/10 绿 |
| ③ | 给了端口仍走未接线：`if (refusal === null) return createUnwiredMediaPort();` | `B·正控制` 红：`给了端口 + 合法媒体 ⇒ 必须受理（实际 409 {"error":{"code":"OBJECT_UNAVAILABLE","message":"媒体引用不可用","retryable":false}}）`；连带 `E·失败序`、`B·产品装配` 红 | 10/10 绿 |
| ④ | 撤掉本片：把 `services/api/src/ocr/media.ts:77` 改回改前那一行 `executionMode === 'real' ? createUnwiredMediaPort() : …` | 同 ③ 的三条红（`B·正控制` 409、`E·失败序`、`B·产品装配`）—— 即**本片整体回退**时正控制必红 | 10/10 绿 |
| ⑤ | 让「真实适配器身份」判据失效：`if (objectStore === null)`（去掉 `kind !== 's3_compatible'`） | `C·等价性` 红：`对象存储是未接线端口 ⇒ 媒体门必须仍是 unwired`，`actual: 'real'`（**未接线端口冒充了真实端口**）；连带 `C·缺省判定`、`B·产品装配` 红 | 10/10 绿 |

**恢复自证**：每次都先用改动前的副本覆盖回源文件，再核对 SHA256 与负控制前**逐字节相同**
（`services/api/src/ocr/media.ts` = `E02EA987AB1B92D9C4091F2EF498715B810089BC5C3BB2C6189EA1B578BCF801`，五次全部 `RESTORED_MATCH=True`，末次 `FINAL_HASH` 与 `ORIG_HASH` 相等），随后复跑本片用例到 `10 / 10 绿`。
全套门禁读数（§8）是在**这同一份字节**（提交 `c2fdf409`）上取得的。

**负控制的一个如实结论**：③/④ 只红正控制与产品装配，`C·等价性` 在 ③/④ 下**仍绿** —— 因为等价性用例的判定面本来就是「不给端口 ⇒ 仍是 unwired」，它与「给了端口要放行」是两条**互不替代**的钉子。真正让等价性变红的是 ⑤（身份判据失效），这正好说明两条钉子各守一边。

## 10 未取得项（本页不声称）

| 项 | 状态 |
| --- | --- |
| 真实腾讯云 OCR 调用与真实返回 | **未取得**（无凭据；全程零外呼，`globalThis.fetch` 绊线计数 0） |
| 「真实凭据下 `POST /ocr` 一定 202」 | **未取得**（202 的正控制用注入的 available 提供者，见 §4 第 2 条） |
| 真实对象存储（S3/COS）往返、真实去元数据衍生件内容 | **未取得**（假端口 + 合成 24 字节 PNG 头） |
| 识别质量 / 准确率 / 标签类真实样本 | **0**（见[样本缺口登记](../evaluation/sample-gap-register.md)） |
| 媒体域批准能力（`approveRealMediaWiring`）与真实对象存储的联合放行 | **不涉及**：本片只判对象存储端口的 `kind`，不铸造、不校验批准能力（§4 第 5 条） |
| 受理期与识别期两次读取之间的对象竞态 | **不做**（§4 第 6 条） |

## 11 收尾：进程与端口（实测）

| 项 | 读数 |
| --- | --- |
| 本片启动过什么 | 只有 `node --test`（单测）与 `node tests/integration/ocr-http.mjs`（自建**回环** HTTP，`listen({ port: 0 })`）。两者都在用例结束时 `app.close()`；**没有**常驻进程、**没有**遗留后台任务、**没有**任何真实外网连接 |
| 收尾实测（`Get-CimInstance Win32_Process` 过滤 `node.exe` 且命令行匹配 `wt-r70-ocr-media`／`ocr-http`／`ocr-media-port`／`run test:unit`） | **0 个** |
| 收尾实测（本片实测中出现过的两个临时端口能否重新绑定 —— 能绑定即已释放） | `127.0.0.1:63869` **可绑定 ⇒ 已释放**；`127.0.0.1:63870` **可绑定 ⇒ 已释放** |
| 60000–65535 段内仍在 LISTEN 的端口 | 1 条 `127.0.0.1:65499`，owner `GameViewerServer.exe` —— **与本片无关**的既有第三方程序（本片不曾启动、也不曾占用；对照：该 pid 不是 `node.exe`） |
| 一次真实的中断收尾（如实登记） | 早前有一轮 `npm run test:unit` 因 `dist/` 与单测并发而**主动中止**；中止后核出**两棵**遗留的 `npm run test:unit` 进程树（`npm-cli.js` + `node --test`），用 `taskkill /PID <pid> /T /F` 逐棵停掉，再核到残留 **0 个**。`services/api/dist`、`apps/admin/dist` 也已删除（构建输出不入库、不入扫描面） |
| 工作树 | `git status --porcelain` **0 条**（干净） |
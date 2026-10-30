# GY-R70 · 审核域图片字节来源接线（2026-10-30）

**一句话**：本片把审核域的 `ModerationImageSource` 从「缺省即未接线、`read()` 恒 `null`」接成**真实实现** ——
按 `media_id`（＋可选 `revision`）读媒体域既有的 `mediaStore` + `mediaObjectStore`，**只取去元数据衍生件**
（⛔ 不读原件 `rawRef`），坏输入一律 `read() → null` 并留**既有契约码**。
**它证明的是「字节端口已接线、失败语义可判定、不给端口时行为逐字节不变」；它不证明「审核策略有效」，也不证明「图片真的被审过」**（无真实凭据，全程零外呼 —— 见 §4、§9）。

## 0 元信息

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-30（Asia/Hong_Kong） |
| 基线 sha | `c609ce7f2be6f5e0bfa3d30fd26ca95aa90067dd`（`upstream/main`，提交信息 `feat(ocr): connect admission media validation`；任务书给的就是它，`git rev-parse upstream/main` **实测复核一致**） |
| 分支 / worktree | `feat/gy-r70-moderation-image-source` / `E:\GengYunCommander\wt-r70-modimg` |
| 代码提交 | `ca3c1d7f`（本页为其后追加的文档提交；代码内容未变） |
| 改动范围 | 新增 `services/api/src/moderation/image-source.ts`、新增 `tests/unit/moderation-image-source.test.mjs`；等行替换 `services/api/src/moderation/live-wiring.ts`（4/4）、`services/api/src/moderation/service.ts`（3/3）、`services/api/src/app.ts`（**1/1，净 0 行**）；两处既有结构钉子同步（`tests/unit/media-real-mode-fail-closed.test.mjs` 9/9、`tests/unit/ocr-media-port.test.mjs` 2/2）；本页 |
| 未碰 | 契约 `packages/contracts/**`、迁移、CI、`services/api/src/config.ts`（未新增任何环境变量）、`services/api/src/media/**`（未新建对象存储、未铸造批准能力）、`services/api/src/moderation/live-vendor.ts`（未接线实现原样保留）、任何真实供应商 |

## 1 缺口（改前读数，逐条可复核）

1. `services/api/src/moderation/live-ports.ts:274` 定义 `ModerationImageSource`，入参只有
   `{ mediaId, mediaRevision }`（**没有调用者身份**）；同一文件 `services/api/src/moderation/live-ports.ts:402`
   的注释写明「**必填**：没有字节来源就拿不到要审的图（产品侧尚未接线）」。
2. `services/api/src/moderation/live-vendor.ts:397` 的 `createUnwiredModerationImageSource(reason)` 诚实返回
   `null`；`services/api/src/moderation/live-wiring.ts:71` 的**改前**唯一取值就是它
   （`wiring.imageSource ?? createUnwiredModerationImageSource('对象存储属媒体域，本片未接线')`）。
3. 适配器的调用形状是 `services/api/src/moderation/ims-live-adapter.ts:107`：
   `await imageSource.read({ mediaId: ref.mediaId, mediaRevision: ref.mediaRevision })`，随后立刻做
   `requireModerationImageBytes()`（PNG/JPEG 头部 + 2 MiB 上限）。因此**拿不到字节 ⇒ 本地拒绝、零发包**：
   改前即使凭据齐备、策略显式打开，图片送审也**永远**停在 `failed payload_invalid:image_bytes_missing`。
4. 图片引用的**唯一真实来源**是社区投稿：`services/api/src/community/service.ts` 的 `mediaInputs()` 只回
   `{ media_id }`（**不带** `media_revision`），社区取图路径本身只接受 `purpose === 'community_image'`
   （`services/api/src/media/service.ts:1378`）。这两条事实决定了本端口的两处口径（用途闭集、版本口径），见 §2.1。

## 2 改了什么

| 文件 | 职责（一句话） |
| --- | --- |
| `services/api/src/moderation/image-source.ts`（新） | 真实字节来源 `createObjectStoreModerationImageSource()`（`services/api/src/moderation/image-source.ts:215`）：① 取端口（**取值器**，晚绑定）② 读媒体登记册（归属/版本/状态/用途/衍生件键）③ **只按 `derivativeRef`** 取字节 ④ 校验 `Content-Type`。坏输入一律 `read() → null` ＋ `lastFailure()` 留闭集码（`services/api/src/moderation/image-source.ts:76` 的四码，与 OCR/识别/语音三侧逐字同集合）。闭集常量：`MODERATION_IMAGE_CONTENT_TYPES`（`services/api/src/moderation/image-source.ts:91`，只认 `image/jpeg`+`image/png`）、`MODERATION_IMAGE_PURPOSES`（`services/api/src/moderation/image-source.ts:101`，只认 `community_image`）。 |
| `services/api/src/moderation/live-wiring.ts` | `imageSource` 由「两档」变「三档」（`services/api/src/moderation/live-wiring.ts:71`）：**显式 `imageSource`** > **`imageMedia` 取值器**（新字段，`services/api/src/moderation/live-wiring.ts:50`）> **`createUnwiredModerationImageSource('对象存储属媒体域，本片未接线')`**。`imageMedia` 为 `undefined` **或** `null` 都落第三档 ⇒ **不给端口时逐字节不变**。 |
| `services/api/src/moderation/service.ts` | `ModerationServiceDeps` 增可选 `imageMedia`（`services/api/src/moderation/service.ts:134`）；`real` 分支把它**并进** `liveWiring`（`services/api/src/moderation/service.ts:455`，wiring 自带的 `imageMedia` 优先、显式 `imageSource` 最高）；**无 `liveWiring` 时不消费**。 |
| `services/api/src/app.ts` | 装配点按 `speechAudioMedia` / `ocrImageMedia` **同形**，以取值器转发媒体域**既有**的两个实例（`services/api/src/app.ts:950`）：`imageMedia: () => ({ objectStore: mediaObjectStore, mediaRecords: mediaStore })`。⛔ 不新建存储、不读 env、不铸造批准能力、不 import 字节端口实现。**等行替换，净 0 行**。 |
| `tests/unit/moderation-image-source.test.mjs`（新） | 11 条用例：**28 种**坏输入矩阵、正控制（衍生件字节逐字节 ≠ 原件字节）、端到端 `FileContent`、**等价性**（不给端口 ⇒ 逐字段相同）、**零外呼绊线**、装配点结构、闭集同源、服务装配（`deps.imageMedia` 真的被消费）。 |
| `tests/unit/media-real-mode-fail-closed.test.mjs`、`tests/unit/ocr-media-port.test.mjs` | 两处既有「`app.ts` 端口溯源」结构钉子按新事实同步：`objectStore` 实参 **3→4**（新增审核域取值器那一处）、`{ objectStore, mediaRecords }` 字面量 **2→3**。**判据强度未放宽**：仍是逐行钉死、逐字相等、越界即红；两处改动均**等行数**（9/9、2/2），不造成行号漂移。 |

### 2.1 与同族两份的同与异（刻意，不是漏抄）

- **同（逐条对齐 `services/api/src/ai/ocr-image-source.ts`）**：只读 `derivativeRef`、不读 `rawRef`；就绪＋用途双判据；
  `Content-Type` 收窄到适配器真正能吃的两种（`image/webp` 是**合法上传**类型但不是适配器可识别类型 ⇒ 明确拒绝，
  测试逐条核对这份**真收窄**关系）；失败码闭集四值；端口缺省/取值器缺省一律 fail-closed；**绝不新造码、绝不回退替身、绝不发空字节包**。
- **异一（本片特有，如实说明）**：`read()` 入参**没有调用者身份**（`services/api/src/moderation/live-ports.ts:274` 的形状
  就这样），因此本端口的归属判据只能是「登记册行**必须有归属主体**（非空 `ownerId`）」＋「装配层若给
  `ownerUserId` 就必须相符（不一致与不存在**同形** `NOT_FOUND`，不泄露存在性）」。**越权判定不属于本层**：
  社区侧按 `me` 路由 + 审核域内容权威端口判，本端口不假装自己判了。
- **异二（版本口径，本片与同族两份的唯一实质差异）**：`mediaRevision === null` 时**不清零**，而是读该媒体
  **登记册当前那一版**的衍生件。理由是可复核的事实而非偏好：社区送审载荷 `mediaInputs()` 只回 `{ media_id }`，
  **从不带** `media_revision`；若把 `null` 也判冲突，本端口在唯一真实存在的送审路径上**永远不会返回字节**（等于没接线）。
  约束没有放宽：对象键仍**只**取自登记册行（不猜、不拼、不回退）；**一旦给了版本**（整数 ≥ 1）就必须**逐字相同**
  （否则 `REVISION_CONFLICT`）；版本形状不合法（`0` / `1.5` / `NaN`）同样 `REVISION_CONFLICT`。
  这一格**请裁定**（§7 第 1 条）。

## 3 什么被证明了

1. **字节真的来自衍生件**：正控制里 `read()` 返回的正是对象存储里 `derivativeRef` 那一段，且**逐字节 ≠ `rawRef` 那一段**
   （两份都是**合法 PNG 头**，所以「读了原件」不会被头部嗅探提前挡掉、而是被断言抓住）；`getObject` 的调用序列恒为
   `[derivativeRef]`，原件键**一次都不出现**。
2. **端到端送达**：适配器把同一段字节放进 `FileContent`（base64 逐字相等），且 `≠ 原件 base64`；恰好一次发送（零重试）。
3. **失败逐条可判定**（28 种，§5）：媒体引用为空 / 记录不存在 / 无归属主体（空串、null）/ 归属不符 / 版本已推进 /
   版本形状不合法（0、1.5、NaN）/ 三种未就绪 / 三种跨用途 / 衍生件键 null、空串 / 对象不存在 / 零字节 /
   三种不受支持的类型 / 对象存储抛闭集码、抛无码错误 / 登记册抛闭集码、抛无码错误 / 端口未配置 / 取值器自己抛错 ——
   全部 `read() → null`、`lastFailure()` 落在**既有契约码**闭集内、**原因不含对象键**；抽四档验到适配器面一律
   `payload_invalid` ＋ `result_may_have_been_processed=false` ＋ **零发包**。
4. **`getObject` 异常原样保留既有码**：注入 `MediaError('PROVIDER_UNAVAILABLE')`（未接线端口就是如此）⇒
   `lastFailure()` 就是 `PROVIDER_UNAVAILABLE`，**不被改写成 `OBJECT_UNAVAILABLE`**（等价于
   `ai/ocr-image-source.ts` 对同一种异常的处理）。
5. **「不给端口 ⇒ 行为不变」**（§4 之外的正面结论，逐字段比对见 §3 第 5 条下一段）：`createLiveModerationPortsFromWiring()`
   在**键缺省**与**显式 `imageMedia: null`** 两种形态下，与接线前那份显式
   `createUnwiredModerationImageSource('对象存储属媒体域，本片未接线')` 的读数**逐字段相同** ——
   `kind` / `model_version` / `provider` / seam 闭集、抛出异常的 `name` / `message` / `model_failure` /
   `http_status` / `provider_error_code` / `result_may_have_been_processed`、`onObservation` 收到的观测对象，
   全部相等；三条路径的假 `fetch` 调用数都是 0。
6. **零外呼**：正控制（走注入的 `fetchImpl`）与全部失败路径，`globalThis.fetch` 绊线**一次都没被触发**。
7. **服务层真的消费装配层的端口**：`createModerationService({ liveWiring, imageMedia })` 在 `real` 下
   `capabilities().image.ready === true`，`runModelScreening()` 对带图内容**真的发出一次**送审、`FileContent` 是衍生件字节；
   **不给 `imageMedia`** 时图片层**一次都不外呼**（取不到字节 ⇒ 本地拒绝）。

## 4 什么**没有**被证明（不得外推）

1. **不证明「审核策略有效」**。没有任何真实腾讯云凭据，`tools/ai-config.mjs` 里 `policySelectionVerified` / `executionAllowed`
   对 `moderation*` 恒为 `false`。本片所有"可用"读数都来自**合成策略快照 + 合成凭据 + 注入的假 `fetch`**。
2. **不证明「图片真的被审过」**。全程零真实供应商调用；本片证的是"字节端口能把衍生件交到适配器手上"，
   不是"供应商看到了这张图、并给出了结论"。
3. **不证明真实对象存储往返**。`mediaStore` / `mediaObjectStore` 在用例里是**进程内替身**（`kind: 'substitute'`），
   字节是**合成 24 字节 PNG 头**（不含任何真实照片/EXIF）；`createUnwiredObjectStore()` 那条只用来证明
   「未接线端口的 `PROVIDER_UNAVAILABLE` 被原样保留」。
4. **不证明社区端到端「带图投稿」在 `real` 下走得通**。`app.ts` **不转发** `moderationInjection.liveWiring`
   （本片刻意不改，理由见 §7 第 2 条）⇒ 产品装配路径下审核域仍整域 fail-closed；带图投稿的公开面行为**与本片之前一致**。
5. **不证明归属/越权的完整性**（§2.1 异一）：本层拿不到调用者身份，只判"有主体 + 可选钉死不匹配"。
6. **不证明并发/多实例一致性**：登记册读取与对象读取是**两次**独立读取，两者之间对象被替换/删除的竞态未处理
   （对象缺失会在本端口 fail-closed，但"读到的是哪一版"只由登记册那一行决定）。
7. **不证明 `media_revision === null` 的版本口径正确**（§2.1 异二）：这是本片的**产品口径选择**，请裁定。

## 5 失败语义表（端口内部码 → 对外结局）

| 触发条件 | `lastFailure()`（内部诊断码） | 适配器对外 | 外呼 |
| --- | --- | --- | --- |
| 端口未配置（缺登记册 / 缺对象存储）或取值器自己抛错 | `PROVIDER_UNAVAILABLE` | `payload_invalid:image_bytes_missing` | 0 |
| `mediaId` 不是非空字符串 / 媒体记录不存在 / **无归属主体** / 归属不符 | `NOT_FOUND` | 同上 | 0 |
| 请求版本形状不合法（`0` / 小数 / `NaN`）/ 请求版本 ≠ 登记册版本 | `REVISION_CONFLICT` | 同上 | 0 |
| `state ≠ 'ready'`（`initiated` / `uploaded` / `processing` / `rejected` / `deleting` / `deleted`） | `OBJECT_UNAVAILABLE` | 同上 | 0 |
| `purpose ≠ 'community_image'`（`label_ocr` / `weed_recognition` / `voice_question`） | `OBJECT_UNAVAILABLE` | 同上 | 0 |
| `derivativeRef` 为 `null` 或 `''`（只有含元数据的原件） | `OBJECT_UNAVAILABLE` | 同上 | 0 |
| 对象存储里没有该对象 / 字节为 0 | `OBJECT_UNAVAILABLE` | 同上 | 0 |
| `Content-Type` ∉ {`image/jpeg`, `image/png`}（含 `image/webp` / `application/octet-stream` / 缺失 / 空串） | `OBJECT_UNAVAILABLE` | 同上 | 0 |
| 对象存储端口抛**闭集内**码（如未接线端口的 `PROVIDER_UNAVAILABLE`） | **原样保留该码** | 同上 | 0 |
| 对象存储端口抛无码错误 | `OBJECT_UNAVAILABLE` | 同上 | 0 |
| 媒体登记册抛无码错误 | `PROVIDER_UNAVAILABLE` | 同上 | 0 |
| 全部成立（`ready` + `community_image` + 衍生件 + PNG/JPEG） | `null`（成功） | 交给 `requireModerationImageBytes()` 继续（头部/2 MiB 上界仍由适配器判） | 1（恰好一次） |

**口径同源**：`Content-Type` 闭集与「只许 `community_image`」两份判据**不是**复制品 —— 前者与
`services/api/src/moderation/live-vendor.ts` 的 `requireModerationImageBytes()` 头部嗅探同集合、后者与
`services/api/src/media/service.ts:1378` 的社区取图判据同一用途，测试逐条核对这两份关系（防止两处漂移）。
**尺寸判据留在适配器**：2 MiB 上界由 `requireModerationImageBytes()` 按被校验剖面判，本端口**不压缩、不裁剪**。

## 6 门禁读数（九条 + CI-exact anchors + 两条额外，全部 exit 0）

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `npm run test:unit` | `tests 5809 / pass 5805 / fail 0 / cancelled 0 / skipped 2 / todo 2` | 0 |
| `npm run verify:anchors` | `verify-contract-status` PASS（覆盖 126 条操作；行号区间 313 条 + 4 条片段；中文表格一致）；`verify-doc-anchors --strict` PASS（基线外新增 0、陈旧 0） | 0 |
| **CI-exact**：`node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | `SYMBOL-STRICT-BASELINE` 31 条全命中、基线外新增 0；`BARE_ORPHAN` 册上 3543 条、基线外新增 0、陈旧 0；`ANCHOR_COUNT` 面内未扫 0、扫不到 0、计数下降 0 份；`ANCHOR_DRIFT` 15 条全在基线内 | 0 |
| `npm run verify:parity` | `extra []` / `missing []` / `ledgerDrift []` | 0 |
| `npm run verify:capability-map` | `totalOps=46，有入口=46，无入口=0，死按钮=0`；标记块与重算一致 | 0 |
| `npm run test:docs` | 研究记录 5 通过 / 0 失败 / 4 legacy 已钉住；`docs/research` 结构校验 PASS | 0 |
| `npm run lint` | `tsc --noEmit` services/api PASS、apps/admin PASS；仓库卫生扫描 PASS | 0 |
| `npm run test:contract` | `tests 17 / pass 17 / fail 0` | 0 |
| `npm run build` | api + admin 均 `built`（`TMP`/`TEMP` 指向**仓外** `E:\GengYunCommander\.pg17\tmp\gy-r70-modimg\buildtmp`；build 后已删除 `services/api/dist` 与 `apps/admin/dist`） | 0 |
| `npm run test:failmatrix` | `矩阵合计 249 条：PASS 249 / FAIL 0` | 0 |
| 额外·`node --test tests/unit/moderation-image-source.test.mjs` | `tests 11 / pass 11 / fail 0` | 0 |
| 额外·`node tools/verify-contract-status.mjs --reanchor`（dry-run） | `无可重定位项（带锚点且带行号的引用 302 条，锚点都在 ±2 行容差内）` ⇒ **台账未改、无需 `--write-doc`** | 0 |

**行号策略（零漂移）**：`git diff --numstat c609ce7f..HEAD` 里五个既有文件全部**等行数**
（`app.ts 1/1`、`moderation/live-wiring.ts 4/4`、`moderation/service.ts 3/3`、
`media-real-mode-fail-closed.test.mjs 9/9`、`ocr-media-port.test.mjs 2/2`）。因此
`docs/architecture/**` 与 `docs/verification/**` 里对 `app.ts` / `service.ts` / `live-wiring.ts` 的既有行号引用
**一条都没动**，`--reanchor` 判「无可重定位项」。

- `app.ts` 的 1 行改动是**行内追加**（`imageMedia: () => ({...})` 与说明块注释挤在同一条既有行上）——
  这是本仓既有做法（`routes/ocr.ts` 的 import 与字段同样挤在同行），代价可读性、收益是**净 0 行**：
  少一次全仓锚点重算。
- 两次结构钉子的同步也做成**等行数**：新增的 `const`、`assert.ok`、tuple 三条都并到既有行上。
  这不是风格偏好 —— 若让 `media-real-mode-fail-closed.test.mjs` 长 10 行，
  `docs/verification/gy-i06-media-real-provider-plan-20261021.md` 里那条指向该测试文件的裸锚点会**落到行外**，
  CI-exact anchors 立刻红（本片实测过这一次，见 §8 的「一次真实红」）。

**既有结构断言更新（前 → 后，逐条登记）**：

| 断言 | 前 | 后 | 是否放宽 |
| --- | --- | --- | --- |
| `media-real-mode-fail-closed.test.mjs` 的 `objectStore` 实参位点 | 3 处 | **4 处**（+审核域取值器） | **否**：仍逐行钉死、每行恰一处、越界即红；新增那处也要求**逐字**只转发既有实例 |
| `ocr-media-port.test.mjs` 的 `{ objectStore, mediaRecords }` 字面量数 | 2 处 | **3 处**（+审核域取值器） | **否**：仍是"逐字相等"的白名单，`store`/`provider`/`reference` 仍不得成为装配键 |

## 7 已知成本与需裁定项

1. **`media_revision === null` 的口径**（§2.1 异二）：本片选「读登记册当前版本」。取舍是
   「社区送审路径可用」vs「严格的版本钉死」。若要求 `null` 一律拒绝，社区投稿（唯一真实送审路径）会**永远**取不到字节，
   本片就退化成"接线了但不可用"。**请裁定**是否接受这一口径；若要更严，需要先在社区侧把 `media_revision`
   传进送审载荷（那是**另一片**的改动：`community/service.ts` 的 `mediaInputs()`）。
2. **`app.ts` 不转发 `moderationInjection.liveWiring`**：本片只把媒体域端口以取值器交到
   `createModerationService` 的 deps 上（`services/api/src/app.ts:950`）。审核域真实端口仍需 `liveWiring`
   （含凭据 + 策略闸门）显式注入，而**产品装配路径从不注入它** ⇒ 审核域在 `real` 下仍整域 fail-closed。
   本片刻意不改这一点：转发 `liveWiring` 会让真实审核端口**首次可从装配层触发**，与 `app.ts` 上方
   「应用装配路径永不注入真实适配器端口（零端口注入）」的既有断言冲突。**请裁定**是否需要另开一片做这道门。
   代价：本片的 `app.ts` 转发在**当前**装配路径上是**惰性**的 —— 它的"真转发"由服务层用例
   （§3 第 7 条）与结构钉子证明，而不是由一次产品级请求证明（§4 第 4 条）。
3. **端口用取值器晚绑定**：`app.ts` 里审核域装配（`createModerationService`）发生在媒体域两个端口解析之前，
   与识别域同形，故取值器每次 `read()` 调用一次。它只读**既有**实例（不新建存储、不读 env、不铸造批准能力）。
4. **与在飞切片 #775 的顺序**：同族 `recognitions/image-source.ts`（#775）也在改
   `app.ts` 的 `objectStore` 位点与同样的两条结构钉子（`3→4` / `2→3`）。两片合并顺序会影响那两条断言的数字；
   本片按**本基线**的真实计数登记，后合入者只需再 +1/+1。

## 8 负控制（四条，每条实际打出并记录红在哪；恢复后逐条复绿）

| # | 怎么打的（改哪一行） | 红在哪（逐字摘录） | 恢复后 |
| --- | --- | --- | --- |
| ① | 把取字节的对象键从 `derivativeRef` 换成原件 `rawRef`（`image-source.ts` 的 `objectStore.getObject(record.derivativeRef)`） | `A·正控制` 红：`返回的必须是衍生件字节`（**6 条**连带红：A×3、B、C、G —— 原件字节一路送进了 `FileContent`） | 11/11 绿 |
| ② | 删掉「未就绪」判据（`if (record.state !== 'ready') …` 整行） | `B·失败矩阵` 红：`未就绪（processing）：必须 fail-closed（read() → null），绝不返回空字节或替身` | 11/11 绿 |
| ③ | 把 `getObject` 的 `catch` 吞成空字节（`return new Uint8Array(0)`） | `B·失败矩阵` 红：`对象存储抛闭集码（未接线端口的 PROVIDER_UNAVAILABLE，原样保留）：必须 fail-closed（read() → null），绝不返回空字节或替身`；连带 `D·零外呼` 红（空字节包不再被当成"取不到"） | 11/11 绿 |
| ④ | 把「不给端口 ⇒ 未接线」那一档删掉，改成**无条件**构造真实来源（`createObjectStoreModerationImageSource(...)`） | `C·等价性` 红：`` `live-wiring.ts` 里「不给端口 ⇒ 未接线」那一档必须逐字保留（含原因为字符串字面量） ``；`E·装配点` 红：`live-wiring.ts 必须是「显式来源 > 取值器 > 未接线」三档` | 11/11 绿 |

**恢复自证**：每次都先用改动前的副本覆盖回源文件，再核对 SHA256 与负控制前**逐字节相同**
（四次全部 `restored_match=True`），随后复跑本片用例到 `11 / 11 绿`；`git status --porcelain` 为空。
全套门禁读数（§6）取自**这同一份字节**（提交 `ca3c1d7f`）。

**负控制的一个如实结论**：④ 只红**结构**两条 —— 因为「不给端口」与「给了取值器但端口为空」在**适配器面**的结局
本来就相同（都是 `payload_invalid` 零发包、异常字段逐字相同）。这正是为什么 C/E 两组钉子必须同时存在：
行为面不区分它，**只有**"默认值那句话必须是未接线"的结构判据能区分。

**一次真实红（登记为过程事实）**：本片第一次把结构钉子按 +10 行写完时，
CI-exact anchors 变红：`docs/verification/gy-i06-media-real-provider-plan-20261021.md:120` 的裸锚点指向
`tests/unit/media-real-mode-fail-closed.test.mjs` 的行号落到行外（`SUSPECT`，作用域外本会红）。
修法不是改历史取证页的数字，而是把那处改动**压成等行数**（并到既有行上）⇒ 复跑 exit 0。

## 9 未取得项（本页不声称）

| 项 | 状态 |
| --- | --- |
| 真实腾讯云审核调用与真实返回 | **未取得**（无凭据；全程零外呼，`globalThis.fetch` 绊线计数 0） |
| 「真实凭据下带图投稿一定被审」 | **未取得**（`app.ts` 不转发 `liveWiring`，产品装配路径下审核域仍整域 fail-closed，§7 第 2 条） |
| 审核策略有效性 / 违规召回 / 误报率 | **0**（无样本、无调用；见[样本缺口登记](../evaluation/sample-gap-register.md)） |
| 真实对象存储（S3/COS）往返、真实去元数据衍生件内容 | **未取得**（假端口 + 合成 24 字节 PNG 头） |
| 社区投稿「带图」在 `real` 下的端到端公开面 | **未取得**（同上，需 `liveWiring` 与真实存储同时到位） |
| 归属/越权的完整判定 | **不在本层**（§2.1 异一） |

## 10 收尾：进程与端口（实测）

| 项 | 读数 |
| --- | --- |
| 本片启动过什么 | 只有 `node --test`（单测）、`node tools/*.mjs`（门禁脚本）与 `npm run build`（一次性）。**没有**常驻进程、**没有**监听端口、**没有**任何真实外网连接（所有供应商调用都走注入的假 `fetch`） |
| 收尾实测（`Get-CimInstance Win32_Process` 过滤 `node.exe` 且命令行匹配 `wt-r70-modimg`） | **0 个**（见交付回报的实测输出） |
| 收尾实测（本片工作树内是否有 `dist/` 残留） | `services/api/dist`、`apps/admin/dist` **已删除**；`docs/ui-demo/dist` 是**版本控制内**的既有产物（非本片生成，未改动） |
| 工作树 | `git status --porcelain` **0 条**（干净） |

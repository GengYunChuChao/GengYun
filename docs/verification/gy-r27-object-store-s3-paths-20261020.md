# R27-S8 · S3 兼容对象存储适配器：真实代码路径跑通 + 独立 SigV4 复算（2026-10-20）

- 分支：`test/gy-r27-object-store-paths`（worktree `E:\GengYunCommander\wt-r27-s8`）
- 父提交（基线）：`13dd429a02db57953ad604e17951901ebbc9d2ab`（`upstream/main`）
- 新增测试：`tests/unit/media-object-store-s3-paths.test.mjs`（599 行，11 条用例：10 条判据 + 1 条文案护栏）
- 产品代码：**一行可执行语句都没有改**（`services/api/src/media/object-store.ts` 只改注释与 `note` 文案，总行数 455 → 455 不变、被其它文档引用的行号不变）

## 0 一句话结论

`createS3CompatibleObjectStore` 的 `putObject` / `getObject` / `hasObject` / `deleteObject` / `objectCount` / `presignUpload` / `presignDownload`
此前在本仓库内**只有结构断言**（https 前缀、必需 `X-Amz-*` 参数、未发网络请求），**没有任何一条可执行语句被执行过**。
本片用**进程内 `fetch` 替身**把这些真实路径全部跑起来，并在测试里**独立重算一遍 SigV4**（自写规范化查询串 + `node:crypto` 的 HMAC-SHA256 链）
与适配器产出的 `X-Amz-Signature` **逐字节比对**：11 条用例全绿，5 个负控制全部按预期变红，且每次变异后**逐字节还原**。

## 1 边界与如实声明（必读）

- **合成本地 `fetch` 替身，非真实供应商**：测试用 `globalThis.fetch = …` 换掉出口，替身只返回构造出来的 `Response`，
  `http(s).request/get` 被换成绊线（真实外呼一律抛 `REAL_NETWORK_FORBIDDEN`）。**未对接任何真实桶**（没有腾讯云 COS、没有 S3、没有任何账号），
  **未做真实签名往返核验**，**未发起任何真实网络请求**。
- 因此本片取得的结论是「**适配器的代码路径按契约工作、签名与独立实现逐字节一致**」，
  **不是**「已对接真实 COS/S3」。本片**不**声称后者。
- 产品装配路径（`services/api/src/media/*` 的真实端口注入）在本仓库内仍**从未被实际调用**——跑通只发生在测试的进程内替身下。
  这条口径被产品注释与 `note` 保留，并被 `tests/unit/media-real-mode-fail-closed.test.mjs:182,315` 的既有断言继续钉住。
- 测试里的桶名/凭据全是占位值（`gengyun-media-placeholder` / `synthetic-access-key-id` / `synthetic-secret-key-value`）。

## 2 环境与基线

| 项 | 实测值 |
| --- | --- |
| 系统 / 沙箱 | Windows，沙箱 `workspace-write` |
| Shell | Windows PowerShell **5.1.26100.8875**（工具入口声明为 `pwsh`，`$PSVersionTable.PSVersion` 实测报 5.1.26100.8875） |
| Node | **v24.16.0**（原生 TypeScript type stripping ⇒ 测试可直接 `import … from '../../services/api/src/media/object-store.ts'`） |
| 父提交 | `13dd429a02db57953ad604e17951901ebbc9d2ab` |
| 依赖 | `npm ci --ignore-scripts --no-audit --no-fund`（普通 `npm ci` 在 lifecycle rebuild 阶段 `npm error code EPERM / syscall spawn / errno -4048` 并回滚） |

## 3 跑法（含沙箱降级说明）

权威跑法是默认隔离；**本机实测默认隔离必然失败**：

```powershell
# 实测：默认隔离 ⇒ EPERM（原始输出节选）
cd E:\GengYunCommander\wt-r27-s8
node --test tests/unit/media-object-store-s3-paths.test.mjs
#     at runTestFile (node:internal/test_runner/runner:536:32)
#     at node:internal/test_runner/runner:925:25
#     at node:internal/per_context/primordials:561:37
#     at new Promise (<anonymous>) {
#   errno: -4048,
#   code: 'EPERM',
#   syscall: 'spawn'
# }
# [exit code: 1]
```

⇒ 本片**全部**结论均由下面的降级跑法取得，并在此**显式声明降级**（同进程跑 ⇒ 用例之间共享 `globalThis`，
所以每条用例的 `fetch` 替身都在 `try/finally` 里还原，且替身队列为空时直接抛错，不会串味）：

```powershell
node --test --test-isolation=none tests/unit/media-object-store-s3-paths.test.mjs
```

## 4 §4 十条判据逐条（原始输出）

**独立重算的实现边界**：`independentSigV4()` 只吃「人给的输入」（`config` / `method` / `key` / `expiresInSeconds` / `amzDate`），
自己用 `encodeURIComponent + [!'()*]` 还原 RFC3986、自己排序查询串、自己拼 `canonicalRequest` / `stringToSign` / 签名密钥链；
**没有从被测文件 import 任何中间量**（只 import 公开 API `createS3CompatibleObjectStore` / `presignS3Url`）。否则等于自己验自己。

```text
✔ 判据 1：测试独立重算 SigV4（自写规范化串 + HMAC 链），与 presignS3Url 的签名逐字节相等
✔ 判据 2：key／method／expiresInSeconds／now 任一变更 ⇒ 签名必变（四个方向）
✔ 判据 3：forcePathStyle=true ⇒ host 不含桶且 path 以 /<bucket>/ 开头；false ⇒ host 为 <bucket>.<host>
✔ 判据 4：putObject 真实路径 —— 一次 PUT、头/体/六个查询参数齐备、externalRequestCount 恰好 +1
✔ 判据 5：getObject —— 200 逐字节/带 content-type、404 ⇒ null、500 ⇒ retryable、400 ⇒ 非 retryable
✔ 判据 6：hasObject —— 200 ⇒ true、404 ⇒ false（都经由 GET 探测）
✔ 判据 7：deleteObject —— 204 ⇒ true、404 ⇒ true（幂等）、500 ⇒ 抛错且 retryable
✔ 判据 8：objectCount 恒抛 PROVIDER_UNAVAILABLE，且一个请求都不发
✔ 判据 9：presignUpload/presignDownload —— 方法、expires_at 自洽、URL 与 presignS3Url 直调全串一致
✔ 判据 10：构造期拒绝 —— 必填字段为空/仅空白一律抛错（http:// 与空 bucket 复用既有用例）
✔ 如实标注：note 保留「未对接任何真实桶」「未做真实签名往返」，并点名替身跑通
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 130.2686
```

| 判据 | 断言点（证据） | 结果 |
| --- | --- | --- |
| 1 签名可独立复算 | `X-Amz-Signature` 与独立重算逐字节相等；**整条查询串**（含参数排序）逐字节相等；六个 `X-Amz-*` 参数名排序后精确相等；`X-Amz-Credential` 展开为 `<ak>/20261020/ap-shanghai/s3/aws4_request`；`secretKey` **不出现在 URL**；非 ASCII 键按 RFC3986 编码为 `%E7%94%A8%E6%88%B7%20%E5%A4%B4%E5%83%8F%20v1.jpg` | ✔ |
| 2 四向敏感 | `key` / `method`（GET⇒PUT、GET⇒DELETE）/ `expiresInSeconds`（600⇒601）/ `now`（+1s、+1d）任一变更 ⇒ 签名必变；改 key 后再次独立复算命中 | ✔ |
| 3 `forcePathStyle` 两分支 | `true`：`host = cos.ap-shanghai.myqcloud.com`、`pathname = /<bucket>/media/…`、host 不含桶名；`false`：`host = <bucket>.cos.ap-shanghai.myqcloud.com`、`pathname` 不含桶名；两分支签名不同且各自独立复算命中 | ✔ |
| 4 `putObject` | `init.method === 'PUT'`；`headers['content-type'] === 'image/jpeg'`；`headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD'`；`init.body` 是 `Uint8Array` 且字节逐个相等；六个 `X-Amz-*` 齐备；`X-Amz-Expires === '300'`（`send` 里的硬编码契约）；独立复算命中；`externalRequestCount` 0⇒1⇒2（**每次外呼恰 +1**） | ✔ |
| 5 `getObject` 三态 | 200：字节逐字节相等、`content-type` 透传；200 缺头 ⇒ 回落 `application/octet-stream`；404 ⇒ `null`（不抛错）；500 ⇒ `MediaError` code `PROVIDER_UNAVAILABLE`、`retryable=true`、`status=503`；400 ⇒ 同 code 但 `retryable=false`；5 次调用方法全为 GET | ✔ |
| 6 `hasObject` | 200 ⇒ `true`、404 ⇒ `false`，两次都是 `GET` 探测，计数 2 | ✔ |
| 7 `deleteObject` | 204 ⇒ `true`；**404 ⇒ `true`（幂等）**；500 ⇒ 抛 `MediaError`、`retryable=true`（调用方保留引用可重试）；3 次调用方法全为 DELETE | ✔ |
| 8 `objectCount` | 恒抛 `PROVIDER_UNAVAILABLE`、`retryable=false`，且**一次 `fetch` 都没发**（`calls.length === 0`、计数仍 0）——不允许「先试一次再报错」 | ✔ |
| 9 `presignUpload`/`presignDownload` | 方法是 `PUT` / `GET`；产出 URL 的 `X-Amz-Date` 喂回 `presignS3Url` 后**整串逐字节相同**（时钟无关）；两个签名各自独立复算命中且互不相同；`expires_at` 是标准 ISO 串且与 900s/1800s 自洽（容差 −5s/+1s）；全程 `externalRequestCount === 0` | ✔ |
| 10 构造期拒绝 | **复用既有覆盖**：`tests/unit/media-real-mode-fail-closed.test.mjs:249-254` 已断言空 `bucket` 与 `http://` endpoint 抛错；本用例只补 `endpoint`/`accessKey`/`secretKey` 的「空串」与「仅空白」共 6 条，加「缺协议 ⇒ 抛 `https endpoint`」；正向对照：齐备配置可构造、`kind === 's3_compatible'`、构造期零外呼 | ✔ |

## 5 §5 负控制（变异 ⇒ 变红 ⇒ 逐字节还原）

方法：每次变异前把文件备份到 `E:\GengYunCommander\.pg17\tmp\r27-s8\`，变异 → 跑 → `git hash-object` + SHA-256 双证还原。
`byte_exact_restore` 判据 = 还原后 `git hash-object` 与备份 SHA-256 **两者都**与变异前一致（基线 blob：`object-store.ts = 20a86a9e2813bf2ba07bab0812c876686a0a569b`、测试文件 = `ca0ca07ac8859dd1d2e8c915726f697c05fdb13f`）。

| # | 变异点（diff 原文） | 变异后结果 | 变红输出（原始） | 还原 |
| --- | --- | --- | --- | --- |
| NC1 | `object-store.ts:305` 查询串比较子反转：`-    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))` / `+    .sort((left, right) => (left[0] > right[0] ? -1 : left[0] < right[0] ? 1 : 0))` | **5 fail / 6 pass** | ✖ 判据 1/2/3/4/9；判据 1：`AssertionError: 独立重算的签名必须与适配器产出的逐字节相等` `actual: '7ee540f08e5d3236e5d7af37ec7817b9dff585d81c24e1dd2cb1fbda2c2f08d1'` `expected: '6103eaadf3e660af7c56344142be4cb43ec716a1570585e8c6f9fc2866b5fa62'` | `byte_exact_restore=true` |
| NC2a | `object-store.ts:340`（`send` 内）：`-    const url = presignS3Url({ config, method, key, expiresInSeconds: 300 });` / `+    … expiresInSeconds: 900 });` | **1 fail / 10 pass** | ✖ 判据 4：`AssertionError: Expected values to be strictly equal:` `actual: '900'` `expected: '300'` | `byte_exact_restore=true` |
| NC2b | `object-store.ts:300`：`-    ['X-Amz-Expires', String(options.expiresInSeconds)],` / `+    ['X-Amz-Expires', String(300)],` | **3 fail / 8 pass** | ✖ 判据 1/2/9；判据 2 精确报：`AssertionError: 600⇒601 秒 ⇒ 签名必变` | `byte_exact_restore=true` |
| NC3 | 测试侧：`tests/unit/media-object-store-s3-paths.test.mjs:312`（判据 4 的替身预置响应）`200 → 500` | **1 fail / 0 pass**（只跑判据 4） | ✖ 判据 4：`MediaError: 对象存储写入失败（HTTP 500）` `code: 'PROVIDER_UNAVAILABLE'` | `byte_exact_restore=true` |
| NC4 | `object-store.ts:383` 删掉 404 幂等分支：`-      if (response.ok \|\| response.status === 404) return true;` / `+      if (response.ok) return true;` | **1 fail / 0 pass**（只跑判据 7） | ✖ 判据 7：`MediaError: 对象存储删除失败（HTTP 404）` | `byte_exact_restore=true` |
| NC5 | 正向对照：全部还原后三个文件同跑 | **37 pass / 0 fail** | `ℹ tests 37` `ℹ pass 37` `ℹ fail 0` `ℹ skipped 0` `ℹ todo 0` | 基线 blob 复原：`20a86a9e…` |

**派单前提订正（如实登记）**：派单 §5 第 2 条写「`expiresInSeconds` 在 `send` 里改成常量 ⇒ 断言 2/4 必红」。
实际上 `send` 里的 `expiresInSeconds: 300` **本来就是一个硬编码常量**，把它改成 900 只影响传输层，**只有判据 4 变红**（NC2a 实测 1 fail）。
为了让「`expiresInSeconds` 被常量吞掉」这一变异真正打到签名敏感性上，另加了 NC2b（把 `presignS3Url` 里的 `X-Amz-Expires` 也写成常量 `String(300)`），
它让判据 1/2/9 变红，并在判据 2 上精确落在 `600⇒601 秒 ⇒ 签名必变` 这条断言上。

## 6 既有守卫测试（未削弱任何断言）

```text
# ① tests/unit/media-real-mode-fail-closed.test.mjs（含 :182/:315 的 note 断言、:249-254 的构造期拒绝）
ℹ tests 20
ℹ pass 20
ℹ fail 0

# ② tests/unit/media-attachment-limit.test.mjs（含 :189 的 externalRequestCount === 0 零外呼断言）
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

**额外加跑**：所有 `git grep -l "object-store" -- tests/` 命中的 8 个测试文件 + `runtime-strings-truth.test.mjs` + 本片新文件，一次性跑：

```powershell
node --test --test-isolation=none `
  tests/unit/media-object-store-s3-paths.test.mjs `
  tests/unit/media-real-mode-fail-closed.test.mjs `
  tests/unit/media-attachment-limit.test.mjs `
  tests/unit/media-consent-wiring.test.mjs `
  tests/unit/media-grant-url-origin.test.mjs `
  tests/unit/media-http-access.test.mjs `
  tests/unit/media-http-upload.test.mjs `
  tests/unit/gy-i22-cache-headers.test.mjs `
  tests/unit/gy-i22-secmatrix.test.mjs `
  tests/unit/runtime-strings-truth.test.mjs
# ℹ tests 99
# ℹ pass 99
# ℹ fail 0
# ℹ cancelled 0
# ℹ skipped 0
# ℹ todo 0
# ℹ duration_ms 6459.2067
```

既有断言**一条都没删、没放宽**（`git diff` 里没有任何 `tests/**` 既有文件的改动）。

## 7 如实话术订正（10 处；全部行号不变）

派单 §6 说「共 4 处」，实测 `git grep -n "从未被实际调用\|只写好"` 命中 **8 处**（跨 3 个文件）。按「不留旧话术」全部订正，
并**严格保持总行数不变**，以免 `gy-i01-contract-status-20261011.md:247`、`gy-i02-stale-claims-20261016.md:136-145`、
`gy-i24-release-materials-index-20261017.md:228` 等文档引用的 `object-store.ts:447/:450/:209/:214/:226` 行号失效。
（该锚点原为 `:222`（`## 1. 部署` 标题行），GY-R34-I19 在索引页头部追加一段「并流刷新（2026-10-23）」后整体下移 6 行，2026-10-23 同步改指 `:228`。）

| 文件 | 位置 | 订正要点 |
| --- | --- | --- |
| `services/api/src/media/object-store.ts` | `:24-28`（文件头声明） | 「未验证声明」⇒「已跑通声明」：全路径已在测试的**进程内 `fetch` 替身**下跑通、签名由测试**独立重算**；**产品装配路径仍从未被实际调用**、未对接真实桶、不发起真实请求 |
| 同上 | `:280-281`（`presignS3Url` docstring） | 「未验证 / 只有结构断言」⇒「已独立复算、仍未真实往返」 |
| 同上 | `:318`（工厂 docstring） | 「本仓库内从未被实际调用」⇒「产品装配路径从未被实际调用（全路径只在测试替身下跑通）」 |
| 同上 | `:364`（运行期 `note`） | 补「put/get/has/delete/presign 全路径已在测试的进程内 fetch 替身下跑通，签名由测试独立重算校验；未对接任何真实桶、未做真实签名往返」，**保留 `从未被实际调用` 子串**（否则 `media-real-mode-fail-closed.test.mjs:182,315` 会红） |
| `docs/verification/gy-i06-private-media-20261014.md` | `:90`、`:242`、`:389` | 「只写好、从未被调用」「测试只覆盖结构断言」⇒ 如实写明替身跑通范围 + 仍未对接真实桶 + 装配路径仍未被调用 |
| `docs/verification/gy-i19-backup-domain-20261018.md` | `:16`、`:159`、`:160` | 「仓内从未被调用」⇒「**产品装配路径**仓内从未被调用（R27-S8 替身跑通全路径）」 |

行数实测（worktree vs `HEAD`）：`object-store.ts` 456 = 456、`gy-i06…md` 463 = 463、`gy-i19…md` 487 = 487（按 `\n` 切分计数，含末尾空行）。
`git grep -n "只写好"` 与 `git grep -n "本仓库内从未被实际调用"` 均**零命中**。

## 8 未取得项（如实列出）

| 项 | 状态 |
| --- | --- |
| 真实对象存储（腾讯云 COS / S3 / MinIO 等任意真实桶） | **未完成，且本片不具备条件**。没有真实桶、没有真实凭据、未被授权发真实网络请求。本片所有结论来自**合成的进程内 `fetch` 替身**。 |
| 真实签名往返核验（用真实桶验证签名是否被接受） | **未取得**。只做到「与本地独立实现逐字节一致」，**不等于**「供应商会接受该签名」；签名算法的正确性由两套独立实现互证 + 5 个负控制支撑。 |
| 默认隔离跑法（`node --test <file>`） | **未取得**：实测 `errno: -4048 / code: 'EPERM' / syscall: 'spawn'`。全部结论改用 `--test-isolation=none`，并在 §3 显式声明降级。 |
| 全仓 `npm test` / 集成套件 | **未跑**。本片只跑与对象存储相关的 10 个单测文件（99 条），其中包含 2 个派单点名的既有守卫。 |
| 主检出既有脏 | 与本片无关的 70 行既有脏**未清理**（按纪律不动）。本片 worktree 的 `git status --porcelain` 见 PR/回报。 |

## 9 复现清单

```powershell
cd E:\GengYunCommander\wt-r27-s8
npm ci --ignore-scripts --no-audit --no-fund
node --test --test-isolation=none tests/unit/media-object-store-s3-paths.test.mjs   # 11/11
node --test --test-isolation=none tests/unit/media-real-mode-fail-closed.test.mjs   # 20/20
node --test --test-isolation=none tests/unit/media-attachment-limit.test.mjs        # 6/6
```

负控制的复现：把 §5 表里 `-` 行替换成 `+` 行，重跑 `node --test --test-isolation=none tests/unit/media-object-store-s3-paths.test.mjs`，
即可看到同一条变红输出；把 `+` 行换回 `-` 行即恢复全绿（`git hash-object services/api/src/media/object-store.ts` 应回到 `20a86a9e2813bf2ba07bab0812c876686a0a569b`）。

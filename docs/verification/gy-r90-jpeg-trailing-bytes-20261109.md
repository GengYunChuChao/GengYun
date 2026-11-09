# GY-R90 · JPEG 的 EOI 之后允许尾随字节：`stripJpeg` 不再整张拒绝真实照片

- 日期：2026-11-09（HKT）
- 分支：`fix/gy-jpeg-trailing-bytes`，基线 `origin/main` = `8dc192ca`
- 修订原因：用户端到端实测 6 张真实手机相册 JPEG 全部在 `POST /media/uploads/:id/complete` 拿到 **415 `MEDIA_TYPE_UNSUPPORTED`／「图片解码失败，无法去除元数据」**；根因是 `stripJpeg` 要求 JPEG 恰好在 EOI（`FF D9`）处结束，而真实照片普遍在 EOI 之后还挂着几十字节到几十 KB 的尾随数据。
- 改动面：`packages/media/exif.mjs`（一处判据）、`packages/media/README.md`（一行口径）、`tests/media/detect-exif.test.mjs`（一条既有断言随行为改写）、`tests/unit/media-exif-trailing.test.mjs`（新增）
- 一句话结论：EOI 之后的尾随字节改为**丢弃**而不是放行——输出只保留 `0..EOI`，尾随字节（以及随后夹带的元数据）不进衍生物；本机 33 张真实照片的读数由 **ok 9 / 拒 24** 变为 **ok 32 / 拒 1**（唯一仍拒的那张其实是 RIFF/WebP 改名成 `.jpg`，拒绝正确）。五类 fail-closed 边界一条没放宽，11 条新用例在改前红 3 条、改后 11 条全绿。

## 1. 缺陷：一条「必须精确到文件尾」的判据

改前 `stripJpeg` 的尾部收尾是三条：

```js
if (!sawSOS) return failed(bytes);            // 无图像数据（无 SOS）
if (!sawEOI) return failed(bytes);            // 未以 EOI 正常结束
if (i !== bytes.length) return failed(bytes); // EOI 之后仍有尾部字节 → 拒绝
```

前两条是对的，第三条把「EOI 之后还有字节」当成容器损坏。它原本的用意写在模块头红线 2 里：**杜绝「写入 EOI 之后仍被下游读取」的走私通道**。用意成立，但取证方式过头了——真实相册／IM 转存的 JPEG 几乎都带尾随数据，于是整张照片被判死，用户看到的是「图片解码失败」。

改后（`packages/media/exif.mjs:288`）：

```js
if (!sawSOS) return failed(bytes); // 无图像数据（无 SOS）
if (!sawEOI) return failed(bytes); // 未以 EOI 正常结束（截断）
// R90：EOI 之后允许存在尾随字节（真实相册 / IM 转存照片普遍如此，实测尾随 24 B 至 37 KB），
// 但**不把它放进输出**：chunks 只累积到 EOI 为止，尾随字节连带其中夹带的元数据一并丢弃。
// 红线 2 的「EOI 之后仍被下游读取」因此依旧不成立，只是不再把整张真实照片判死。
return { ok: true, data: concat(chunks), removed };
```

关键在**输出侧**：`chunks` 在命中 `0xd9` 时就 `break` 了，`i` 之后的内容从来没被 `push` 进去，所以删掉这条判据**不会**让尾随字节进入衍生物。红线 2 的走私通道靠「不写进输出」关闭，而不是靠「整张拒收」关闭——这是本次改动的全部安全论证。

## 2. PNG / WebP 的同类假设：查了，**没改**

同一文件里确有两处同形的「必须精确到文件尾」，本轮**保持原样**：

| 位置 | 判据 | 为什么不动 |
| --- | --- | --- |
| `packages/media/exif.mjs:338` | `if (iendEnd !== bytes.length) return failed(bytes);`（PNG IEND 之后） | PNG 的 IEND 是**自述结束**标记，IEND 之后有字节说明容器被拼接；本轮没有用户侧证据表明真实相册 PNG 会带尾随 |
| `packages/media/exif.mjs:373` | `if (riffSize + 8 !== bytes.length) return failed(bytes);`（WebP RIFF 声明之外） | RIFF 头**自述总长**，声明长度与实际不符属结构损坏；放宽它等于放过一个长度字段与实际不符的文件 |

两者的语义与 JPEG 的 EOI 不同：JPEG 的 EOI 之后没有任何长度字段声称「到这里为止」，尾随字节是**无害的冗余**；PNG/WebP 的收尾判据直接对应容器自述长度。把三者一起改会顺手放宽两条没有证据支撑的边界，超出本轮范围，故只留记录。

## 3. 新增用例：11 条，坏的仍然红

`tests/unit/media-exif-trailing.test.mjs`（158 行，全部**合成最小样本**，不提交任何真实图片）：`minimalJpeg()` 是 34 字节的 SOI + APP0(JFIF) + SOS(len 8) + 两字节熵数据 + `FF D9`；`minimalJpegWithExif()` 在它之上插一段带 `Exif\0\0` + `GPS-SYNTH` 的 APP1。

| 用例 | 判据 | 改前 | 改后 |
| --- | --- | --- | --- |
| ① EOI 后 1 字节 | `ok === true` 且 `data` 末两字节是 `FF D9`、长度 = 34 | ✖ 红 | ✔ 绿 |
| ② EOI 后 37 KiB（内含合成元数据串） | `ok === true`，输出 34 字节，标记串不残留 | ✖ 红 | ✔ 绿 |
| ⑤ 正常无尾随（回归） | 输出与输入**逐字节**相同 | ✔ 绿 | ✔ 绿 |
| ⑥ 同一张含 Exif 的图，有无尾随 | 两种输入的输出**逐字节**相同（尾随不改变清理结果） | ✖ 红 | ✔ 绿 |
| ③ 截断（无 EOI） | `ok === false` | ✔ 绿 | ✔ 绿 |
| ③b 熵数据后无任何终止标记 | `ok === false` | ✔ 绿 | ✔ 绿 |
| ④ 非 JPEG 头（PNG 魔数） | `ok === false` | ✔ 绿 | ✔ 绿 |
| 空输入 | `ok === false` | ✔ 绿 | ✔ 绿 |
| 仅 SOI（无 SOS） | `ok === false` | ✔ 绿 | ✔ 绿 |
| SOS 段长度越界／段长度非法 | `ok === false` | ✔ 绿 | ✔ 绿 |
| 结构损坏（该见标记却读到非 `0xFF` 前缀） | `ok === false` | ✔ 绿 | ✔ 绿 |

改前 `node --test tests/unit/media-exif-trailing.test.mjs`：`tests 11 / pass 8 / fail 3`，退出码 1，三条红全是「本该通过」的 ①②⑥，报 `AssertionError: EOI 后 37 KiB 尾随字节不应整张拒绝`（`false !== true`）；八条 fail-closed 用例**一条都没红**——这正是「只放宽尾随、不放宽坏样本」的直接证据。改后同一命令：`tests 11 / pass 11 / fail 0`。

既有套件 `tests/media/detect-exif.test.mjs:203` 原断言 `stripImageMetadata(jpegWithTrailing(), 'image/jpeg').ok === false` 与新行为冲突，随行为改为三句：`ok === true`、`data` 里不含 `TRAILING-SECRET`、`data` 与 `jpegPlain()` 逐字节相等——行为变了，但「尾随字节不得存活」这条原始意图被完整保留为断言。

## 4. 六样本判定表（本机真实相册照片）

样本取自 `C:\Users\MR\Pictures`（递归 33 张 `.jpg/.jpeg`）。探针把文件读成 `Uint8Array` 直接喂 `stripImageMetadata`，不经过任何服务端；判定列「改前／改后」是同一份字节在同一条路径上的两次读数。

| # | 样本（相对 `C:\Users\MR\Pictures`） | 大小 | EOI 后残留 | 改前 | 改后 | 输出字节 | Pillow 12.3.0 解码 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| s1 | `cdd8cfaf…38880697.jpg` | 1409517 | 0 | ok | ok | 1409517 | `JPEG 4240x4240 RGB` → 同 |
| s2 | `Saved Pictures\微信图片_20251222180318_111_26.jpg` | 953616 | 24 B | **拒** | ok | 953592 | `JPEG 1240x2772 RGB` → 同 |
| s3 | `微信图片_20260831090623_19_42.jpg` | 552451 | 24 B | **拒** | ok | 552427 | `JPEG 1005x955 RGB` → 同 |
| s4 | `微信图片_20260827111129_15_42.jpg` | 531253 | 24 B | **拒** | ok | 531229 | `JPEG 1706x1280 RGB` → 同 |
| s5 | `IMG_20260921_170945.jpg` | 65182 | 1651 B | **拒** | ok | 63531 | `JPEG 707x380 RGB` → 同 |
| s6 | `2981f03daac9ef99bbf1ff8467949d94122166603.jpg` | 50612 | — | **拒** | **拒** | — | Pillow 读作 `WEBP 1192x1192` |

读法：

- s2／s3／s4／s5 的输出长度精确等于「命中 EOI 的位置 + 2」（953592、552427、531229；s5 另外去掉了 1 段 `APP1:Exif`，所以是 65182 → 63531）。这直接印证输出只保留 `0..EOI`，不是「碰巧没崩」。
- s6 是本轮唯一仍拒的样本，也是唯一**不是 JPEG** 的样本：文件头是 `RIFF`（`52494646`），Pillow 判为 `WEBP`。它被 `stripJpeg` 的第一条判据（SOI 检查）挡下，拒绝是正确的。
- 全量 33 张：改前 **ok 9 / 拒 24**，改后 **ok 32 / 拒 1**；被救回 23 张（22 张尾随 24 B，1 张尾随 1651 B）。被拒的 24 张里尾随字节最常见的形状是固定 24 字节（`bfa2c1090000000043a6fb29377efd738046bfe5b44d5f86` 这一类），既不是 JFIF 段也不是 Exif 段。
- Pillow 解码：5 张通过样本的 `format/size/mode` 与清理前完全一致（`DECODE_FAILURES 0`），说明截断尾部没有伤到图像数据。

## 5. fail-closed 边界复核

| 边界 | 改后行为 | 证据 |
| --- | --- | --- |
| 无 SOI 开头 | 仍拒（第一句判据） | 用例 ④；真实样本 s6（RIFF 改名 `.jpg`）仍红 |
| 找不到 `FF D9`（截断） | 仍拒（`!sawEOI`） | 用例 ③、③b |
| 仅 SOI／无 SOS（无图像数据） | 仍拒（`!sawSOS`） | 用例「仅 SOI」 |
| 段长度越界／非法 | 仍拒 | 用例「SOS 段长度越界」 |
| 结构损坏（该见标记却读到非 `FF`） | 仍拒 | 用例「结构损坏」 |
| 空输入 | 仍拒 | 用例「空输入」 |
| EOI 之后仍有字节 | **由「整张拒」改为「丢弃尾随、保留图像」** | 用例 ①②⑥；真实样本 s2-s5 |

## 6. 闸门

全部在本工作树实测（跑前确认仓内无 `.local/wechat-local`）：

| # | 命令 | 退出码 | 尾行 |
| --- | --- | --- | --- |
| ① | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红…）`；回归闸门那行：`本次：不在区间 44、UNDECLARED 259、配成对 1333`（基线 44／265／1051） |
| ② | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `ℹ tests 37 / pass 37 / fail 0`（首跑红过一次，原因见下） |
| ③ | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 372 页（扫描面 377 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）` |
| ④ | `node tools/verify-verification-comment-anchors.mjs` | 0 | `VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 1422、基线 1422、基线外新增 0、可收紧 0`／`VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 1422 条注释锚点只告警，没有基线外新增` |
| ⑤ | `node --test "tests/unit/media*.test.mjs"` | 0 | `ℹ tests 179 / pass 179 / fail 0 / skipped 0` |

另跑两道（不必答，但本改动落在它们的判定面上）：`node --test "tests/media/*.test.mjs"` ⇒ `tests 140 / pass 140 / fail 0`（被改写的 `detect-exif.test.mjs` 在这一组）；`node --test tests/unit/doc-anchors-guard.test.mjs` ⇒ `tests 28 / pass 28 / fail 0`（它会把本页的行号锚点也过一遍）。

两处必须交代的闸门故事：

1. **② 首跑是红的，但红在「没有判定面」，不是红在判据。** 第一次跑（改动尚未提交、`HEAD` 仍等于 `git merge-base HEAD origin/main` = `2261f92e`）报 `AssertionError: base 与 HEAD 同一提交（git merge-base HEAD origin/main），本用例没有判定面却也不是 CI 浅克隆 —— 取 base 的逻辑有问题，不允许静默通过`，`actual === expected === 2261f92e…`。提交之后同一命令 37/37 绿——它不是被「改绿」的，是它本来就需要一个提交才有判定面。
2. **④ 首跑也是红的，红得有价值。** 我给 `exif.mjs` 的 JSDoc 多折了一行、尾部注释也多加了行，`stripImageMetadata` 从第 432 行挪到第 438 行；于是三张历史证据页里指着旧号（432 与 432-440）的 4 条锚点落到了注释行上，报 `VERIFICATION-COMMENT-ANCHOR-FAIL: 基线外新增 4 条注释锚点`，逐条点名（`gy-i06-media-real-provider-plan-20261021.md` 第 165 行、`gy-i11-voice-input-20261021.md` 第 36／112 行、`gy-r87-i06-i15-ac-evidence-20261108.md` 第 47 行）。处理方式是**重锚到新行号**（432 → 438、432-440 → 438-446）而不是 `--write-baseline` 登记：这 4 条指的是同一个函数，行号只是随本提交平移，登记进基线等于把漂移固化。重锚后 1422/1422/0/0。顺带把 `gy-i06…` 第 165 行那句「JPEG EOI 之后一律判失败」改成 R90 的新口径——它描述的是本提交改掉的行为，不改就是留一句假话。

## 7. 本页不声称什么

1. **不声称本机 33 张代表真实相册的分布。** 它们是这台机器上碰巧存在的样本；「24 B 最常见、最大 1651 B」只是本地读数。用户报告的「约 37 KB 尾随」本机没有实物，只由合成用例 ② 覆盖，本页不把它当成实测。
2. **不声称已知尾随字节的来源。** 只观测到「在 EOI 之后」「不是 JFIF/Exif 段结构」；没有做来源归因（微信转存／相册导出／某 SDK 的固定尾巴都只是猜测）。
3. **不声称 PNG / WebP 的收尾判据也放宽了**，也不声称它们不需要放宽。见第 2 节：本轮只动 JPEG，那两处保持原判据。
4. **不声称 `/media/uploads/:id/complete` 的 HTTP 全链路已验。** 本页所有读数都停在 `stripImageMetadata` 这一层（直接喂字节），没有起 API、没有走 HTTP。415 是用户侧观察到的**现象**，本页证明的是该现象的一个必要成因已消除。
5. **不声称输出与输入逐像素相同。** Pillow 只核到 `format/size/mode` 一致；`stripJpeg` 对熵编码数据是原样复制，所以像素理应不变，但本页没有做像素级 diff，不做这个断言。
6. **不声称尾随字节里一定有元数据。** 用例 ② 与 ⑥ 里塞的合成标记是为了证明「万一夹带也不会进输出」；真实样本的 24 B 尾巴里没有解析出可识别的元数据段。

## 8. 复现

```powershell
cd E:\GengYunCommander\.pg17\wt-jpeg
node --test tests/unit/media-exif-trailing.test.mjs      # 11 pass / 0 fail
node --test tests/media/detect-exif.test.mjs             # 41 pass / 0 fail
node --test "tests/unit/media*.test.mjs"                 # 第 6 节 ⑤
```

真实样本探针不入库（它读的是本机 `C:\Users\MR\Pictures`，且会把清理后的照片写进临时目录）：脚本在临时目录里，跑完即删；本页第 4 节的读数由它产出。合成样本的构造见 `tests/unit/media-exif-trailing.test.mjs` 顶部 `minimalJpeg()`，无外部依赖、无图片文件。

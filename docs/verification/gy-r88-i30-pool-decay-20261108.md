# GY-R88 · 待用池的 24h 自衰减与 `state` 四值矩阵：真库 HTTP 端到端补测

- 日期：2026-11-08（HKT）
- 分支：`feat/gy-r88-i30-pool-decay`，基线 `origin/main` = `ecbe343c`（`#1071` 的 squash，2026-11-08 04:45:47 +0800；含迁移 0056）
- 修订原因：`#1030` 的待用池口径里「24h 自衰减」与「`state` 四值全占位」两段仍无人覆盖——既有 PASS 1-8 造的样例行 `created_at` 全是 `now()`，库里真出现过的 `state` 只有 `initiated`／`ready`／`deleted`。本版给同一条用例加 PASS 9／10／11 与相应夹具，**既有 8 条断言一字未改**。
- 新增用例：`tests/integration/post-media-attach-http-pg.mjs`（真 PostgreSQL 17.11 + `buildApp` 的 `executionMode='real'` + `app.inject`），672 行 → 930 行
- 一句话结论：24h 是**硬边界**——把 `created_at` 拨到 25h 前，待用池读数从 3 掉到 0、第 4 张立刻 201；再拨回 `now()`，读数从 0 涨回 4、第 5 张立刻 400，所以它是「暂时放过」而不是「永久释放」。`state` 谓词逐值生效：四值各 1 张数到 4，`deleted`／`rejected` 各 1 张不占位。`/complete` 迁移能把 `initiated` 推到 `ready`（`ETag` `"2"`、`revision=2`、衍生件已去 GPS），挂帖成功即把待用池从 1 降到 0。

## 1. 口径：待用池是什么，哪三条路径释放它

计数端口的真实现是 `services/api/src/media/store-pg.ts:365-385` 的 `countPendingCommunityImages(ownerId)`，SQL 在 `services/api/src/media/store-pg.ts:368-377`：

```sql
SELECT count(*) AS count FROM public.media m
 WHERE m.owner_id = $1::uuid
   AND m.purpose = 'community_image'
   AND m.state IN ('initiated','uploaded','processing','ready')   -- 状态谓词
   AND m.created_at > now() - interval '24 hours'                 -- 时间窗
   AND NOT EXISTS (SELECT 1 FROM public.post_media_attachments a
                     JOIN public.community_posts p ON p.id = a.post_id
                    WHERE a.media_id = m.id AND p.visibility <> 'deleted')  -- 未挂载
```

口径一句话：**每用户「已上传、还没挂到未删除的帖子上、且 24h 内」的社区图 ≤ 3 张**。上限常量在 `packages/media/constants.mjs:75`（`COMMUNITY_MAX_IMAGES_PER_POST = 3`），上传侧判定在 `packages/media/validate.mjs:84-91`，HTTP 首拒信封是 `400 INVALID_REQUEST` + `details[0] = { field: '/purpose', code: 'post_image_limit' }`。

| 释放路径 | 靠 SQL 的哪一句 | 库里留下什么 | 本页哪个用例钉它 |
| --- | --- | --- | --- |
| 挂载即释放 | `NOT EXISTS (… a.media_id = m.id …)`（`services/api/src/media/store-pg.ts:372-377`） | 行还在，多一条 `post_media_attachments` | PASS 11（新）；反证 PASS 7 |
| 删帖即释放 | 同一 `NOT EXISTS` 的 `p.visibility <> 'deleted'` | 帖子行 `visibility='deleted'` | 既有 PASS 6 |
| **24h 自衰减** | `m.created_at > now() - interval '24 hours'`（`services/api/src/media/store-pg.ts:371`） | 行与 `state` 都不变，只是滑出时间窗 | **PASS 9（新）** |
| （对照）`deleted`／`rejected` 不占位 | `m.state IN (…)`（`services/api/src/media/store-pg.ts:370`） | 行 `state` 变成 `deleted` | **PASS 10（新）** + 既有 PASS 6 |

两点必须先说清，否则后面的读数会被误读：

1. **24h 不是「扔掉」**：SQL 只问 `created_at` 落不落在窗口内，不改 `state`、不删行。所以把 `created_at` 拨回 `now()`，同一批行会**重新占位**——PASS 9 的第二段就是为此设计的（反向读数 `0 → 4`）。这也是为什么本页不把它写成「过期清理」。
2. **待用池 ≠ owner 生命周期累计**：`services/api/src/media/store-pg.ts:342` 的 `liveCommunityImageCount(ownerId)` 数的是「名下所有存活记录」，`services/api/src/media/service.ts:826-838` 明令禁止拿它顶替待用池。既有 PASS 7 用「A 名下累计 7 行仍可继续挂载」把这条钉死。

## 2. 缺口对照：既有 8 组覆盖到了哪、漏了哪

| 维度 | 既有 PASS 1-8 的真实数据 | 漏掉的那一段 |
| --- | --- | --- |
| `state` | 库里出现过 `initiated`（上传后未完成）、`ready`（`/complete` 之后，但既有用例**不调** `/complete`，PASS 1-8 全程停在 `initiated`）、`deleted`（PASS 6 的 `DELETE /media/:id`） | **`uploaded`／`processing`／`rejected` 三个值从未在库里出现过**；`services/api/src/media/store-pg.ts:370` 的 4 值谓词里有值没被真实数据问过 |
| 时间 | 所有行的 `created_at` 都是 `now()`（默认值） | **没有任何一行滑出 24h 窗口**；`services/api/src/media/store-pg.ts:371` 的时间窗条件从未被越界数据检验 |
| `/complete` | 既有用例的合成 S3 端点只做本地预签名、零 PUT ⇒ `getObject` 拿不到字节，`completeUpload` 只会走 `reject(record,'upload_missing')` | **`202 + ready + revision=2` 这条成功路径在真库 HTTP 面上没人走过**（只有 `tests/unit/media-http-upload.test.mjs` 的替身桶走过） |

为什么用 SQL 直接造状态／时间：HTTP 面没有把 `uploaded`／`processing` 写回库的端点——`services/api/src/media/service.ts:1514` 的注释写明「`uploaded`/`processing` 只在内存里过渡、结尾一次性条件写落库 ⇒ 库内 `media.state` 实际只有 `initiated`/`ready`/`rejected`/`deleted`」。所以「库里有 `uploaded`／`processing` 行时计数怎么算」这件事，**只能**用 SQL 造行来问；这不是绕过实现，而是把 `services/api/src/media/store-pg.ts:370` 的谓词当成被测对象。

## 3. 新增三组用例的判据

### 3.1 PASS 9 · 24h 自衰减（时间穿越，只动 SQL 行）

夹具：新用户 C（`tests/integration/post-media-attach-http-pg.mjs:347` 一带的 `createUser('c')`），一个干净的待用池。判据是 4 个读数连成一条闭链，任一环断掉整组就红：

| # | 动作 | 断言 | 为什么这条断言只可能被真实现满足 |
| --- | --- | --- | --- |
| 1 | C 连传 c1／c2／c3 | 3× 201，待用池读数 **3** | 建立「满」状态；读数取 `attachmentCounter.countFor`（`kind=postgres`，`tests/integration/post-media-attach-http-pg.mjs:509`） |
| 2 | 第 4 张 | **400** + `details[0]={field:/purpose,code:post_image_limit}` | 与既有 PASS 2 同信封 ⇒ 上限确实由计数端口裁决 |
| 3 | `UPDATE public.media SET created_at = now() - interval '25 hours' WHERE id = ANY($1::uuid[])`（`tests/integration/post-media-attach-http-pg.mjs:770`，`rowCount` 断言 3） | 读数 **0**；第 4 张 **201** | 这就是「25h 前的不该占位」。把 `24 hours` 改成 `48 hours`（变异 M1）读数会变 3、上传会变 400 ⇒ 断言对时间窗敏感 |
| 4 | `UPDATE … SET created_at = now() …`（`tests/integration/post-media-attach-http-pg.mjs:786`，`rowCount` 3） | 读数 **4**（3 张旧 + 刚传的第 4 张）；第 5 张 **400** | 反向读数：证明第 3 步是「滑出窗口」而不是「行被清掉／被标记」，否则读数回不到 4 |

第 3、4 步都在同一条断言里同时取「端口读数」与「HTTP 状态码」：端口读数说明 SQL 数的行数变了，HTTP 状态码说明**路由层真的按这个读数裁决**（不是只把数字读出来好看）。

### 3.2 PASS 10 · `state` 四值矩阵 + `deleted`／`rejected` 不占位

造行方式：先 HTTP 传 1 张真行作种子（拿到真 `object_ref_cipher`，避免造伪密文），再用 `INSERT … SELECT … FROM public.media WHERE id = $1`（`tests/integration/post-media-attach-http-pg.mjs:521` 的 `cloneMedia(seedId, state)`）克隆出 `uploaded`／`processing`／`ready` 各 1 行。判据：

| # | 动作 | 断言 |
| --- | --- | --- |
| 1 | 四态各 1 行（`initiated` 是种子本身） | 聚合查询（`tests/integration/post-media-attach-http-pg.mjs:813`）逐字等于四态各 1 行 |
| 2 | 读待用池 | **必须 4**（断言文案：`initiated/uploaded/processing/ready 各 1 张 ⇒ 待用池必须读到 4`） |
| 3 | 再克隆 `deleted` + `rejected` 各 1 行 | 六态清单（`tests/integration/post-media-attach-http-pg.mjs:838`）逐字等于 `['deleted','initiated','processing','ready','rejected','uploaded']` |
| 4 | 再读待用池 | **仍 4**（断言文案：`deleted/rejected 各 1 张不占位 ⇒ 读数必须仍是 4`）；第 5 张上传 **400** |

第 4 步的「第 5 张 400」是把端口读数钉到 HTTP 面的同一条证据：如果 `deleted` 混进谓词，读数会变成 5、而 5 > 3 ⇒ 第 5 张就不是 400 而是「随便传都行」；反过来若谓词把 `processing` 漏了，第 2 步读数就会是 3 而不是 4。两个方向都由断言钉住，不靠人看日志。

### 3.3 PASS 11 · `/complete` 迁移 → 挂帖释放

真路由是 `POST /api/v1/media/uploads/:id/complete`（`services/api/src/routes/media.ts:236-257`），body 必须 `{ sha256, bytes }`（`additionalProperties: false`），必须带 `Idempotency-Key` 与 `If-Match`。判据：

| # | 动作 | 断言 | 说明 |
| --- | --- | --- | --- |
| 1 | 用 `jpegWithExif()`（`tests/media/_fixtures.mjs:46`）走真上传端点 | 201，`state='initiated'` | 真 JPEG 字节（含 `GPSDATA-1.2345,103.9876` 的 APP1 段） |
| 2 | `serverObjectKeys(e1)`（`tests/integration/post-media-attach-http-pg.mjs:872`）→ `putObject(rawRef, jpegBytes, 'image/jpeg')`（`tests/integration/post-media-attach-http-pg.mjs:874`） | 步骤本身无断言，只为让 `completeUpload` 的 `getObject(record.rawRef)` 有字节 | 合成 S3 端点不发网络请求，故本脚本给它包了一层进程内 `Map`（`tests/integration/post-media-attach-http-pg.mjs:396` 起，`kind` 仍是 `'s3_compatible'`——`services/api/src/media/service.ts:611` 的 real 模式硬闸只认这个 `kind`） |
| 3 | `POST ${API}/media/uploads/${e1}/complete`（`tests/integration/post-media-attach-http-pg.mjs:877`），headers 带 `idempotency-key` 与 `if-match: "1"` | **202**、`body.data.state==='ready'`、`revision===2`、`failure_code===null`、`headers.etag==='"2"'` | 信封是 `body.data.*`，不是上传的 `body.data.media.*` |
| 4 | 回查 `public.media`（`tests/integration/post-media-attach-http-pg.mjs:886`） | 库内 `state='ready'`、`revision=2` | 证明迁移**落库**，不只是响应好看 |
| 5 | 取回衍生件（`tests/integration/post-media-attach-http-pg.mjs:897`） | 字节里**不含** `GPSDATA` | 迁移真的走了 `stripImageMetadata` |
| 6 | `POST /posts` 带 `media_ids:[e1]`（`tests/integration/post-media-attach-http-pg.mjs:902`） | 201 且 `media_ids` 逐字等于 `[e1]`；待用池 **1 → 0** | `ready` 的行照样占位（第 3 步后读数仍是 1），挂上帖子才释放 |
| 7 | 收尾 | `syntheticRealStore.externalRequestCount === 0` | 全程零外呼：注入的包装只碰进程内 `Map` |

## 4. 真库读数

命令（自起簇，约 10s；每次跑前脚本自己 `DROP DATABASE` + `CREATE DATABASE`）：

```powershell
$env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'
node --test tests/integration/post-media-attach-http-pg.mjs
```

运行环境读数（本版实测）：`PostgreSQL 17.11`；一次性簇数据目录 `…\pgsql\r87-http-pg-tmp\gy-r87-i30http-dafb94e2`、端口 `61579`（只监听 `127.0.0.1`）；`迁移：55 段全链 apply（最大号 0056），重跑 0 条`；`开关：public.feature_flags.submissions_enabled=true（revision=2，真实开关表）`；`计数端口：kind=postgres`；`ℹ tests 1 / pass 1 / fail 0 / duration_ms 9958.1879`。

| # | 断言要点 | 真库读数 |
| --- | --- | --- |
| PASS 1-8 | 既有八组（一字未改） | 与本目录 `docs/verification/gy-r87-i30-http-e2e-20261107.md` 里记的 PASS 行**逐字相同**（同一份合成装配、同一批断言） |
| PASS 9 | 24h 自衰减（时间穿越） | 池 `3 → 400`；拨 25h 前 ⇒ 池 `0`、第 4 张 `201`；拨回 `now()` ⇒ 池 `4`、第 5 张 `400` |
| PASS 10 | `state` 四值矩阵 + `deleted`／`rejected` | 四态各 1 ⇒ 池 `4`；再加 `deleted`+`rejected` ⇒ 池仍 `4`、库里 6 行、第 5 张 `400` |
| PASS 11 | `/complete` 迁移 → 挂帖释放 | `202` + `ETag "2"` + 库内 `ready`／`revision=2` + 衍生件无 GPS；挂帖 `201`、池 `1 → 0`、零外呼 |

PASS 9-11 行原文（本次运行，11 条全绿，退出码 0）：

```
PASS 9: 24h 自衰减（时间穿越）：C 连传 3 张 ⇒ 池=3、第 4 张 400；把 3 行 created_at 拨到 25h 前 ⇒ 池读数 0、第 4 张 201；再改回 now() ⇒ 池读数 4、第 5 张 400（24h 只是「暂时」放过，不是永久释放）
PASS 10: state 四值矩阵：initiated/uploaded/processing/ready 各 1 张 ⇒ 池读数 4；再造 deleted + rejected 各 1 张 ⇒ 读数仍 4（不占位）；库里 6 行 ⇒ 第 5 张上传仍 400
PASS 11: /complete 迁移：真 JPEG 种字节 → complete ⇒ 202 + ETag "2" + 库内 state=ready、revision=2（衍生件已去 GPS） ⇒ 挂帖 201、待用池 1 → 0
[ALL PASS] 真库 HTTP 端到端：#1030 图片上限的「真 SQL → 路由 → 信封」链路＋待用池的 24h 自衰减 / state 四值矩阵 / complete 迁移，共 11 组 PASS
```

`[ALL PASS]` 尾行因为多了三组而补了文案；PASS 1-8 的正文逐字未动（diff 里那 4 行删除全部落在头注与 `[ALL PASS]` 一行上，既有断言行零改动——见第 7 节的 `--numstat`）。

## 5. 变异自证：改坏必须红，还原必须绿

每次变异都先 `git checkout -- <被改文件>` 回基线，跑完整条用例，跑完再 `git checkout --` 还原。四个变异各打一组：

| 变异 | 改法 | 首个变红的用例（行） | 读数（本版实测） |
| --- | --- | --- | --- |
| M1 放宽时间窗 | `services/api/src/media/store-pg.ts:371` 的 `interval '24 hours'` → `'48 hours'` | PASS 9（`tests/integration/post-media-attach-http-pg.mjs:751`） | `AssertionError: 3 行都拨到 25h 前 ⇒ 25h 前的不该占位（待用池读数必须 0，实际 3）`，退出码 1；PASS 1-8 仍绿 |
| M2 状态谓词漏 `processing` | `services/api/src/media/store-pg.ts:370` 的 `state IN ('initiated','uploaded','processing','ready')` → 去掉 `'processing'` | PASS 10（`tests/integration/post-media-attach-http-pg.mjs:804`） | `AssertionError: initiated/uploaded/processing/ready 各 1 张 ⇒ 待用池必须读到 4，实际 3`，退出码 1；PASS 9 仍绿 |
| M3 状态谓词混进已删除态 | `services/api/src/media/store-pg.ts:370` 的 `state IN (…)` 末尾追加「已删除」那一档枚举值（值名见下一行） | **既有 PASS 6**（`tests/integration/post-media-attach-http-pg.mjs:682`），不是 PASS 10 | `AssertionError: A 第 7 张（删一张之后）：上传必须 201，实际 400 {"error":{"code":"INVALID_REQUEST","message":"每个帖子最多 3 张图片","retryable":false,"details":[{"field":"/purpose","code":"post_image_limit"}]}}`，退出码 1 |
| M3′ 隔离探针（只为归因） | 同一改法（塞进的是 `deleted`），另在临时副本里把 PASS 6 造的那张已删行拨到 25h 前，使既有组不再先红 | PASS 10（`tests/integration/post-media-attach-http-pg.mjs:804`） | `AssertionError: deleted/rejected 各 1 张不占位 ⇒ 读数必须仍是 4，实际 5`，退出码 1；PASS 6、PASS 9 均绿 |
| M4 跳过 `/complete` | 把 PASS 11 的 complete 调用换成「直接复用上传响应」 | PASS 11（`tests/integration/post-media-attach-http-pg.mjs:861`） | `AssertionError: complete 必须 202，实际 201 {"data":{"media":{…"state":"initiated"…`，退出码 1 |

两件必须如实交代的事：

1. **M3 的首红不是新用例。** `deleted` 一旦混进谓词，既有 PASS 6 会先炸——它先跑，且它自己就依赖「已删的行不占位」。这说明变异确实被感知到了，但归因链不如 M1／M2 干净，故补跑 M3′：在**临时副本**里只把 PASS 6 造的那行拨出 24h 窗口（不改任何断言），让既有组恢复绿，再看新用例是否红。结果见上表最后一行：新用例对 `deleted` 敏感，且红在「读数 5 ≠ 4」这个读数上。临时副本跑完即删，不留在提交里。
2. **还原后必须重新全绿。** 四条变异跑完，`git status --short` 只剩 `M tests/integration/post-media-attach-http-pg.mjs`（`services/api/src/media/store-pg.ts` 回到基线），重跑得 11 组 PASS、退出码 0——第 6 节闸门①就是这次还原后的读数。

## 6. 闸门

全部在本工作树（上述改动落盘后）实测：

| # | 命令 | 退出码 | 尾行 |
| --- | --- | --- | --- |
| ① | `node --test tests/integration/post-media-attach-http-pg.mjs`（`GY_PG_BIN` 已指） | 0 | `[ALL PASS] … 共 11 组 PASS`；`ℹ tests 1 / pass 1 / fail 0`；`duration_ms 9958.1879` |
| ② | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）`；回归闸门那一行：`本次：不在区间 44、UNDECLARED 251、配成对 1143`（基线 44／265／1051） |
| ③ | `node tools/verify-contract-status.mjs` | 0 | `PASS: 行号区间 324 条（台账直写 312 条 + 符号解析 12 条；有实质内容 324 条；…）`／`PASS: 中文表格一致`／`PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| ④ | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 343 页（扫描面 348 页：docs/verification）——读数七条判据全部自洽（…）` |
| ⑤ | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json`／`PASS tsc --noEmit apps/admin/tsconfig.json`／`PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）`／`lint 通过（静态检查；不代表运行期或真实服务已通过）。` |
| ⑥ | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 输出第一行是一个树对象，其后**没有任何冲突路径名** ⇒ 与 `origin/main` 干净可合（树对象哈希随提交内容变化，故本页不抄它） |
| ⑦ | `node --test "tests/unit/*.test.mjs"`（`GY_BASH=D:\Git\bin\bash.exe`） | 0 | 见下方「单元闸门读数」 |

单元闸门读数：`ℹ tests 6735 / pass 6732 / fail 0 / skipped 3`（本机实测；带 `GY_BASH` 是因为 `tests/unit` 里有真 bash 用例，PATH 上的 `bash` 是 WSL 存根）。这一道必须跑，因为 `tests/unit/doc-anchors-guard.test.mjs:353` 会把本页的行号锚点也过一遍：**只跑** `node tools/verify-doc-anchors.mjs --symbol=strict` 会假绿（`--symbol=strict` 单独跑不动 `--strict` 那一层的基线比较），所以第 ② 道给的是四档全开。

## 7. 零位移：既有证据页的行号锚点怎么办

`tests/integration/post-media-attach-http-pg.mjs` 从 672 行变成 930 行，`docs/verification/gy-r87-i30-http-e2e-20261107.md` 里有 5 处指向它的行号锚点会整体后移。处理方式与本版实测：

- 第 ② 道闸门第一次跑是**红的**：`tests/unit/doc-anchors-guard.test.mjs:353`（本页写作时写作该文件的第 338 行；围栏片给该文件净加 15 行后按内容重锚）报 `FAIL: 文档行号闸门未通过（基线之外新增 1 条）`，逐条只有一条 SUSPECT——R87 页那张表里，本来指着 PASS 5 `assert.deepEqual(` 的那处锚点（当时写作该脚本的第 538 行）在 `+258` 行之后落到了一段空行上，审计语是「区间内没有任何实质内容行（全空行／全右括号）」。
- 重锚按「同一行内容在新树里的位置」逐个定位，不用算术平移：`509→603`（PASS 4 的 `a4` 上传行）、`588→682`（PASS 6 的 `a7` 上传行）、`540→634`（PASS 5 的期望对象）、`538→632`（PASS 5 的 `assert.deepEqual(`）、`267→286`（必需迁移版本清单 `['0001','0008','0022','0056']`）。
- 重锚后该页补了一句「行号重锚（2026-11-08，GY-R88 增补之后）」，说明「被指内容未变、第 6 节闸门①仍是本版 8 组的历史读数，不以 GY-R88 的 11 组顶替」——历史读数不许被后来的运行覆盖。
- 本页自身不拿那条脚本的**易漂**行号当「判据」的替代——第 3 节引的三个位置（它现在的第 751、804、861 行）在新树里由本版自己钉住；将来再有插入，重锚清单在本节可直接复算。

`git diff --numstat`（本版全部改动）：`tests/integration/post-media-attach-http-pg.mjs` 262 插入 / 4 删除；`docs/verification/gy-r87-i30-http-e2e-20261107.md` 7 插入 / 5 删除（5 处锚点改写 + 一段重锚说明）；`docs/verification/gy-r88-i30-pool-decay-20261108.md` 新增。被删的 4 行全部在测试脚本的头注与 `[ALL PASS]` 尾行上：既有 8 条 `say(...)` 断言行一行都没动（可 `git diff -U0` 逐条核对）。

## 8. 本页不声称什么

1. **不声称 HTTP 面已进 CI。** 这条用例需要真 `initdb`／`pg_ctl`（`tests/integration/lib/free-port.mjs` 取端口），本版只证明「在本机真库上它是绿的」，没有把它接进 `.github/**` 的任何工作流——档位判定也因此仍是 A 档（只动 `tests/**` 与 `docs/verification/**`）。
2. **不声称覆盖并发。** 计数端口只是**预检**：两个并发上传可能都读到 2 然后都放行。本页所有读数都是串行取得的；「并发下 3 张上限会不会被突破」不在本页范围内，也不因本页变绿而成立。
3. **不声称替代 `#1037`／`#1065` 已有的用例。** 本页只补「时间窗」与「`state` 谓词」两段的真库证据；`#1037` 的挂载侧校验层、`#1065` 的其它媒体生命周期用例仍按各自页面记载，本页不改写、不重跑、也不替它们背书。
4. **不声称 `/complete` 的失败分支已覆盖。** PASS 11 只走成功路径（202 + ready）。`upload_missing`、`decode_failed`、状态不可完成、sha256/bytes 不一致这些分支仍只有单元面的替身桶证据（`tests/unit/media-http-upload.test.mjs`），本页不声称它们已在真库 HTTP 面验过。
5. **不声称计数端口的 `note` 文案受本版保护。** 本页只引用它的逐字读数；文案由实现侧维护，改动它不会让本页的任何断言变红（本页的断言全部绑在读数和 HTTP 信封上）。

## 9. 复现

```powershell
git -C E:\GengYunCommander\GengYun_Agent2 worktree add E:\GengYunCommander\.pg17\wt-r88-pool24 -b feat/gy-r88-i30-pool-decay origin/main
cd E:\GengYunCommander\.pg17\wt-r88-pool24
npm ci
$env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'
node --test tests/integration/post-media-attach-http-pg.mjs   # 期望 11 组 PASS、退出码 0
```

四个变异按第 5 节的「改法」逐条做：改完先 `git checkout -- services/api/src/media/store-pg.ts`，再跑同一条命令，确认红在**对应**的那一组；M4 改的是测试脚本自己（改完从 `git checkout -- tests/integration/post-media-attach-http-pg.mjs` 还原）。

注意：本页所有 `E:\…` 路径只用于复现说明；脚本体不读这些常量以外的任何路径，簇目录与端口每次由内核与 `tests/integration/lib/free-port.mjs` 重新分配。

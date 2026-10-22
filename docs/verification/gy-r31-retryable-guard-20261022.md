# R31 · 「确定性失败却声称 `retryable: true`」：静态守卫扩域 + 全仓清单

> 切片：`#455` 落地后暴露的两个已知缺口 —— 守卫白名单只覆盖 `{db, privacy, conversations}` 三域；全仓还有别的「兜底恒 `retryable: true`」形状且没有任何清单或守卫。
> 分支：`test/gy-r31-retryable-guard-domains`（从主检出 `E:\GengYunCommander\GengYun_Agent2` 新开工作树 `E:\GengYunCommander\wt-r31-guarddom`；起点 `origin/main` = `d4d48088`，随后并入 `#455` 的 head `0eaf1bde`，见下节）。
> 交付物：`tests/unit/retryable-guard-scan.mjs`（判据唯一实现）、`tests/unit/retryable-guard-allowlist.mjs`（白名单数据）、`tests/unit/error-retryable-static-guard.test.mjs`（扩域，改写）、`tests/unit/retryable-fallback-inventory.test.mjs`（新增清单守卫）、`tests/fixtures/retryable-fallbacks.json`（版本控制的全仓清单）。
> 问题一句话：`errors.ts:28-40` 写的是「`retryable: true` 仅当同一请求在无人工/运维介入下稍后重试可能成功」，但**每一个调用点各自写字面量**；守卫能守的只是它被允许看的那几个目录，而「兜底恒 true」在别处照样能悄悄长回来。

**取证范围声明**：本片只动**守卫与清单**（测试、fixture、本证据页），⛔ 不改任何业务代码、不改 `contract-status.json`、不删既有断言。本页出现的业务代码改动**全部来自 `#455`**（见下节），不是本片改的；本片对它们的唯一动作是「扩域后把它们扫出来、登记、再在 `#455` 合进来之后按新事实改写判定」。

## 时点：本片基线含 `#455`（`0eaf1bde`）与合并顺序

扩域扫描是**在 `origin/main` = `d4d48088` 上**做的（那时 `#455` 还没进 main）。扩域当场红出来的 9 处里，有 5 处正是 `#455` 分支 `feat/gy-r31-retryable-b` 在改的东西。如果本片带着「`#455` 之前」的清单上 main，而 CI 先合 `#455`，那份逐条精确匹配的 manifest 会立刻与实际不符 ⇒ 守卫在 main 上变红（那是精确匹配在按设计工作，但等于给仓库埋一颗定时炸弹）。因此本片在交付前把自己的基线**推进到含 `#455` 的世界**：

```
git merge origin/main          # Already up to date（origin/main 仍 d4d48088）
git merge --no-ff 0eaf1bde     # #455 的 head；ort 策略，无冲突
# ⇒ merge commit 5d0e0308「merge: 并入 #455（2026-10-22 head 0eaf1bde）以对齐兜底清单与本片守卫」
```

⛔ 未 rebase、未强推、未改 `#455` 的任何生产语义（合并是干净快进式的 merge，`#455` 的 14 个文件逐字未动）。

**合并顺序要求：先合 `#455`，再合本片。** 理由：本清单是按「含 `#455`」的事实生成的（32 处 / `none` 1 处）；若把本片合到**不含** `#455` 的 main 上，`retryable-fallback-inventory` 会红出 `#455` 修掉的那 2 处 `none`。反过来，先合 `#455` 再合本片不需要任何额外动作。

本页因此给**两套读数**并标明口径：§3 的表格里「扩域当日」= 基线 `d4d48088`，「交付态」= 已并入 `#455`；§5 的清单与 §6/§7 的读数是**交付态**。

## 0. 结论摘要

| 项 | 改前（基线 `d4d48088`） | 改后（本片交付态：已并入 `#455`） |
| --- | --- | --- |
| 受控域 | 3（`db` / `privacy` / `conversations`） | 8（+ `admin/ops` / `ocr` / `speech` / `recognitions` / `media`） |
| 受控 `.ts` 文件 | 33 | 72 |
| 判据 | 1 条（`new ApiError/PrivacyError` + `PROVIDER_UNAVAILABLE` 且 `retryable` 非字面 `false`） | 同一条 + 第 2 条（catch 通道上的裸 `retryable: true`），**同一个 AST + 同一份白名单** |
| 扫描到的 `PROVIDER_UNAVAILABLE` 非 false 站点 | 6（全部命中白名单） | 扩域当日 15 → 合 `#455` 后 **12**（全部命中；`#455` 把 3 处 `tablesReady` 改成 `false`，站点不再计入） |
| catch 兜底站点（受控范围内） | 11（`judgement: none` 0 处） | 扩域当日 24（`none` 2 处）→ 合 `#455` 后 **22**（`none` **0** 处） |
| 白名单 | 6 条，内联在守卫文件里，无 owner | **12 条**，独立文件，逐条 `reason` + `owner`，且**未命中也判红**（扩域当日曾 15 条，3 条 `tablesReady` 随 `#455` 按「不腐烂」删除） |
| 全仓清单 | 无 | `tests/fixtures/retryable-fallbacks.json`：**32 处**（`has` 31 / `none` 1），222 个源文件 |
| 守卫 test 数 | 3 | 4（+ 兜底判据自检） |

一句话读数：**扩域瞬间在基线 `d4d48088` 上红 9 处**（这就是缺口 1 的证据 —— 过去这 9 处不会被判红）；其中 5 处曾判为「确定性失败却声称可重试」，**已由 `#455` 修掉**，本片并进来之后这 5 条判定全部归零。全仓清单 32 处 catch 兜底站点里 `none` 只剩 **1** 处（`auth/wechat.ts:109`，端口契约使然），其余 31 处都有判据（缺口 2 的证据与现状）。

## 1. 范围

### 1.1 做了什么

1. **判据抽成单一实现** `tests/unit/retryable-guard-scan.mjs`（240 行）：`scanProviderUnavailableSites()` 是 `#455` 那条判据的逐行搬迁（未改语义，`scanSource` 别名保留），`scanFallbackClaims()` 是本片新增的第 2 条判据。两个消费者（静态守卫、清单守卫）调用同一份代码 ⇒ 不存在「另起一套判据」。
2. **白名单数据与守卫逻辑分离** `tests/unit/retryable-guard-allowlist.mjs`：原 6 条**原文保留**、补 `owner: 'GY-I22'`；新增 6 条 `owner: 'R31'`（扩域当时是 9 条，`#455` 修掉 3 处 `tablesReady` 后按「条目必须被命中」的规则删掉 3 条）。每条必须有 `reason`、必须有 `owner`（`GY-Ixx` / `R31`）、必须有 `message` 或 `function` 之一，否则 `assertEntriesWellFormed()` 直接判红。
3. **静态守卫扩域**：`SCOPE_DIRS` 由 3 域扩到 8 域 —— `db` / `privacy` / `conversations` 之外加 `admin/ops`（即 `services/api/src/admin/ops/**`）、`ocr`、`speech`、`recognitions`、`media`，共 72 个 `.ts`。原 3 个 test 一条断言都没删，另加第 4 个「兜底判据自检」。
4. **新增全仓清单守卫** `tests/unit/retryable-fallback-inventory.test.mjs`：扫 `services/api/src/**`（196 个 `.ts`）+ `miniprogram/**/utils/**`（26 个 `.js`），把 catch 通道上的 `retryable` 站点落成受版本控制的 JSON，**多一处少一处都红**。

### 1.2 没做什么（边界）

- **不修**清单里 `judgement: none` 的条目（只登记 + 本页给判断）；⛔ 为了让扩域变绿去改业务代码。`#455` 修掉的那 5 处是 `#455` 的改动，本片只是把判定从「真缺陷」改写成「已修复」。
- `media` 域实测 0 处（它的封套是 `MediaError`，不在 `ERROR_CLASSES` 内；`media/service.ts:487`、`:763-768` 是 `retryable: false`、`media/service.ts:361` 是 `retryable: error.retryable`）—— 仍纳入受控范围，作为「将来有人在这里写回 true」的兜底。
- `recognitions/branches.ts:98-153`、`miniprogram/utils/identify-api.js:88-94/143-188` 的 `retryable: true` 是**展示描述符**（UI 是否给重试入口），不是错误封套，**不计入**清单（判据也不覆盖：它们不在 catch 通道上）。
- `auth/wechat.ts:109` 是清单里唯一「端口契约使然」的 `none`，但它**不在**受控范围内 —— 本片只登记，不扩域到 `auth`。

## 2. 两个缺口分别是什么

**缺口 1（守卫覆盖面）**：`#455` 的白名单只列了三域，`SCOPE_DIRS` 也只有三域。于是 `admin/ops`、`ocr`、`speech`、`recognitions` 的 store/gate 将来写回「兜底恒 `true`」时，守卫**看不见**，CI 全绿。这不是理论风险：把 `SCOPE_DIRS` 扩到 8 域、白名单不动，守卫在基线上立刻红 9 处 —— 说明这 9 处**一直存在**，只是没人被允许看。

**缺口 2（没有清单）**：`#455` 的判据只认 `new ApiError/PrivacyError(...)` 的**第 3 个参数**。但「兜底恒 true」最常见的形状根本不经过错误类构造：`catch (e) { return { retryable: true } }`、或者 `catch` 调一个 mapper 函数、mapper 里 `return { retryable: true }`。这类站点全仓**没有任何东西在数**，所以 §6 的证明 A（临时写一个 `catch (e) { return { retryable: true } }`）在本片之前只会让 `npm run test:unit` 全绿。

两者是同一个病的两面：**判据只看一处、范围只覆盖一段**。本片的解法是「判据收进一个模块、范围收进一个清单」，而不是再加几句注释。

## 3. 守卫扩域：读数与判据

第 2 条判据（`scanFallbackClaims`）的站点 population：对象字面量里名为 `retryable` 的成员，且物理位置满足其一 —— ①在某个 `catch` 块内；②在本文件某个 `catch` 块里被调用的函数内（mapper，跨文件不跟）。`retryable: false` 与缺省不入清单（缺省即 `errors.ts` 的 `options.retryable ?? false`）。

`judgement` 的判法（同一套 AST，不引入新模式匹配）：

| 形态 | `judgement` | 理由 |
| --- | --- | --- |
| `retryable: true`，到所在函数之间**没有**具名条件 | `none` | 兜底恒 true —— 这是本片要抓的形状 |
| `retryable: true`，位于 `if` 的 then 分支 / `switch` 的 `case` / 三元的一臂 | `has` | 有判据（分支就是把错误分了类） |
| `retryable: true`，位于 `else` / `switch` 的 `default`（残差分档） | `none` | 残差＝「其余一律 true」，仍是兜底 |
| 计算表达式（`isTransientDatabaseError(error)`、`error.retryable`、`unknown \|\| ...`） | `has` | 判据在表达式里 |

扩域读数（用守卫自己的扫描器实测，命令见 §7）：

| 范围 | 受控 `.ts` | `PROVIDER_UNAVAILABLE` 非 false 站点 | catch 兜底站点 | 其中 `none` |
| --- | --- | --- | --- | --- |
| 改前 3 域 · 基线 `d4d48088` | 33 | 6 | 11 | 0 |
| 扩到 8 域 · 基线 `d4d48088`（扩域当日，白名单不动） | 72 | **15** | 24 | **2** |
| 扩到 8 域 · 并入 `#455` 后（本片交付态） | 72 | **12** | **22** | **0** |

**扩域新增 9 处**（= 15 − 6）就是缺口 1 的实证。下表保留扩域当日的逐条判定，并给出合 `#455` 之后的实际状态：

| 站点（扩域当日） | 函数 | `retryable` 表达式 | 当日判定 | 合 `#455` 后 |
| --- | --- | --- | --- | --- |
| `services/api/src/admin/ops/flag-gate.ts:394`（现 `:420`） | `failClosedError` | `failClosedRetryableFor(cause)` | 有判据（合法放宽） | **仍存在，仍有判据** |
| `services/api/src/admin/ops/flags-pg.ts:317` | `mapFlagReadError` | `true` | **兜底恒 true（真缺陷）** | **已被 `#455` 修掉**：现 `:347` 为 `flagReadFailure(error)`（走 `isTransientDatabaseError`） |
| `services/api/src/admin/ops/service.ts:650` | `flagReadFailure` → 改名 `throwFlagReadFailure` | `true` | **兜底恒 true（真缺陷）** | **已被 `#455` 修掉**：`throwFlagReadFailure`，委托同一判据 |
| `services/api/src/ocr/store-pg.ts:137` | `classifyOcrDatabaseError` | `isTransientDatabaseError(error)` | 有判据 | **仍存在，仍有判据** |
| `services/api/src/ocr/store-pg.ts:424` | `tablesReady` | `true` | **确定性失败却声称可重试** | **已被 `#455` 修掉**：`retryable: false` + `details: PROBE_SHAPE_UNKNOWN`（站点不再是非 false） |
| `services/api/src/recognitions/store-pg.ts:150` | `classifyRecognitionDatabaseError` | `isTransientDatabaseError(error)` | 有判据 | **仍存在，仍有判据** |
| `services/api/src/recognitions/store-pg.ts:478` | `tablesReady` | `true` | **确定性失败却声称可重试** | **已被 `#455` 修掉**（同上） |
| `services/api/src/speech/store-pg.ts:122` | `classifySpeechDatabaseError` | `isTransientDatabaseError(error)` | 有判据 | **仍存在，仍有判据** |
| `services/api/src/speech/store-pg.ts:369` | `tablesReady` | `true` | **确定性失败却声称可重试** | **已被 `#455` 修掉**（同上） |

**合 `#455` 之后，当日判为「真缺陷」的 5 条：仍存在 0 条，全部已修复。** 逐条见上表最后两列；对应的 3 条 `tablesReady` 白名单条目与 2 条「兜底恒 true」条目已随之改写/删除 —— 守卫对它们的记忆方式是「表达式文本 + 必须命中」，所以业务代码一改，白名单必须跟着改，否则立刻红。

## 4. 白名单理由表（12 条，逐条给「为什么可以不是 false」）

原 6 条（`owner: GY-I22`）理由原文保留在 `tests/unit/retryable-guard-allowlist.mjs:29-83`，此处只摘判定：`db/catalog.ts` ×2、`conversations/store-pg.ts:63-69`、`privacy/deletion-requests-pg.ts:183-188`、`db/source-lifecycle.ts:69-78`、`privacy/ledger-pg.ts:86-90` —— 都是「瞬时类分类器 / 已识别的瞬时分支」⇒ 合法放宽。

新增 6 条（`owner: R31`）的判定与理由：

| 站点 | 判定 | 为什么这一处可以非 false |
| --- | --- | --- |
| `admin/ops/flag-gate.ts:420` | 有判据 | `retryable` 由 `FlagGateFailCause` 决定（`flag-gate.ts:81-83` `failClosedRetryableFor`）：`read_error`（读取抛错＝存储抖动/超时）⇒ true；`unrecognized`（行缺失 / `enabled` 非布尔 / `key` 越界 / `revision` 非法＝配置或数据事故，需运维修复）⇒ false。复核结论原文见 `flag-gate.ts:372-381`。**这是「确定性失败必须 false」的正确样板**，守卫只钉表达式文本。 |
| `admin/ops/flags-pg.ts:347` | 有判据（`#455` 修后） | 原判定是「兜底恒 true（真缺陷）」。`#455` 把尾部兜底改为委托同文件导出的 `flagReadFailure(error)`：直接走 `db/pool.ts` 的 `isTransientDatabaseError`（08xxx/53xxx/57P0x/40001/40P01 ⇒ true；无 `code` 的无法归类错误、其余 SQLSTATE ⇒ false），原始 `code` 落 `details` 供排障。 |
| `admin/ops/service.ts:650` | 有判据（`#455` 修后） | 原判定是「兜底恒 true（真缺陷）」。`#455` 把本地兜底改为委托 `flags-pg.ts` 的同一判据，并把函数改名 `throwFlagReadFailure`（避免与判据重名）。同一功能面于是只有一套口径，与 `flag-gate.ts` 的 `read_error`/`unrecognized` 分档不再互相矛盾。 |
| `ocr/store-pg.ts:137` | 有判据 | 与 `messages/favorites/history/community/conversations` 的 `classify*DatabaseError` 逐条同口径：57014/55P03 已在上方折成 `PROVIDER_TIMEOUT`，此处 `isTransientDatabaseError` 只放行 08xxx/53xxx/57P0x/40001/40P01；42501/3D000/28P01/42P01/42883 与无法归类一律 false（注释原文 `ocr/store-pg.ts:133-136`）。 |
| `recognitions/store-pg.ts:150` | 有判据 | 与 ocr/speech 同一分类器、同一条分档注释（瞬时类 true；权限/缺表/缺函数/无法归类 false）。 |
| `speech/store-pg.ts:122` | 有判据 | 与 ocr/recognitions 同一分类器、同一条分档注释。 |

### 已删除的 3 条（历史判定：真缺陷，现已被 `#455` 修掉）

| 当时站点 | 当时的判定（保留作历史） |
| --- | --- |
| `ocr/store-pg.ts:424`、`recognitions/store-pg.ts:478`、`speech/store-pg.ts:369` 的 `tablesReady` | **确定性失败却声称可重试**：该分支只在 `probeFailure === null` 时可达（探测 SQL **真的执行成功**但形状读不懂：无行 / `ready` 非布尔），属确定性状态，不是瞬时抖动；消息文案自称「未知 ≠ 未迁移」＝fail-closed，却给了 `retryable: true`，与 `errors.ts:28-40` 冲突。三处逐字同构 ＝ 复制粘贴传播的同一个错。`#455` 改为 `retryable: false` + `details: [{ field: 'ocr_tables' \| 'recognition_tables' \| 'speech_tables', code: 'PROBE_SHAPE_UNKNOWN' }]`，消息文案改为「应答形状无法识别」⇒ 站点不再是非 false，白名单条目按「不腐烂」规则删除。 |

## 5. 全仓清单（32 处）

`tests/fixtures/retryable-fallbacks.json`：`{version, generatedBy, scanned, counts, entries}`，条目字段 `{file, line, function, judgement, owner}`，按 `file` / `line` 排序。**这份读数是「已并入 `#455`」的交付态。**

| 项 | 读数 |
| --- | --- |
| 扫描范围 | `services/api/src/**` 196 个 `.ts` + `miniprogram/**/utils/**` 26 个 `.js`（共 222 个源文件） |
| 总站点 | **32** |
| `judgement: has`（有判据） | **31** |
| `judgement: none`（catch 里裸 `retryable: true`） | **1** |
| `miniprogram/utils` 侧站点 | 0（26 个文件全是封套透传 `payload.error.retryable === true` 与展示状态表，没有 catch 兜底形状） |

`has` 的典型：`admin/ops/flags-pg.ts:341/359`（按 SQLSTATE 分档）、`community/store-pg.ts:90/97`（分支 true + `isTransientDatabaseError(error)`）、`db/source-lifecycle.ts:69/78`（分支 + `unknown || isTransientDatabaseError(error)`）、`media/service.ts:361`（`error.retryable`）、`privacy/egress.ts:75`（`candidate?.retryable === true`）、`privacy/ledger-pg.ts:86/90`、`db/catalog.ts:29/52`、`favorites|history|messages|ocr|speech|recognitions|conversations/store-pg.ts` 各有「分支 + 分类器」一对、`admin/ops/accounts-pg.ts:105`、`admin/ops/account-authority-pg.ts:168`、`auth/wechat.ts:106`。

注意一处**判据边界**：三个 `tablesReady` 站点**不在**清单里 —— 它们既不在 catch 内，其函数也不是被 catch 调用的 mapper。它们由第 1 条判据（`new ApiError` + `PROVIDER_UNAVAILABLE`）覆盖（`#455` 之后它们已不是非 false 站点，两条判据都不再报它们）。两条判据在此互补，不是漏。

### 并入 `#455` 的逐条差异（pre → post，用 `$env:TEMP\r31-inv-premerge.json` 对账）

- **消失 2 条**：`services/api/src/admin/ops/flags-pg.ts::mapFlagReadError::none`（`:317`）、`services/api/src/admin/ops/service.ts::flagReadFailure::none`（`:650`）—— `#455` 把这两处从「裸 `true`」改成「调判据」，站点形状本身消失。
- **新出现 0 条**：`#455` 没有引入新的 catch 兜底站点（它的 `flagReadFailure(error)` 不是对象字面量，`tablesReady` 改的是既有站点）。
- **`none` → `has` 1 条**：`admin/ops/flags-pg.ts::mapFlagReadError`（`:311` → `:341`，值由 `true` 变成 `flagReadFailure(error)`）。
- **行号漂移 13 处**（键不含行号所以不判红，仅定位提示）：`flags-pg.ts mapFlagReadError has 311→341`、`mapFlagWriteError has 329→359`、`community/store-pg.ts 97→90`、`conversations/store-pg.ts 69→63`、`db/source-lifecycle.ts applySourceOperation 78→69`、`favorites/store-pg.ts 67→60`、`history/store-pg.ts 62→55`、`messages/store-pg.ts 90→83`、`ocr/store-pg.ts 137→131`、`privacy/deletion-requests-pg.ts mapDeletionError 188→183`、`privacy/ledger-pg.ts mapPgError 90→86`、`recognitions/store-pg.ts 150→144`、`speech/store-pg.ts 122→116`（`#455` 在分类器里补了 `details`、在 `flags-pg.ts` 顶部补了 `flagReadFailure`，行号因此整体上移/下移）。
- counts：`{"total":34,"has":31,"none":3}` → `{"total":32,"has":31,"none":1}`。

### 唯一的 1 处 `none`：现状是否合理

| 站点 | 函数 | 现状是否合理 |
| --- | --- | --- |
| `services/api/src/auth/wechat.ts:109` | `exchange` | **合理（端口契约使然）**。`code` 已换发出去、对方可能已受理，此时网络异常属 `PROVIDER_OUTCOME_UNKNOWN`：重试**可能**成功，而谎称失败会让用户重复登录、产生歧义。这里 `true` 是「结果未知」的语义，不是「兜底」；要收紧只能改成 `false` + 引导用同一 `state` 核对，属于登录链路的行为改动，不在守卫片范围。 |

并入 `#455` 之前的另外 2 处 `none`（`admin/ops/flags-pg.ts:317`、`admin/ops/service.ts:650`）当时判定为**不合理（真缺陷）**：前者把「无法归类的驱动错误」也说成可重试，与同族分类器「无法归类 ⇒ false」的口径冲突；后者声称「传输/超时类按可重试」但代码看不见错误类型，且与同一功能面 `flag-gate.ts` 的分档互相矛盾。两条判定都已被 `#455` 的修复消解 —— 判定保留在 §4，修复事实见 §3。

## 6. 非空证明（两条，原文）

> 两条证明都在**交付态**（已并入 `#455`、清单 32/31/1）上重跑过；基线 `d4d48088` 上的同两条证明读数一致（当时的差异只是清单条目多 2 条、行号不同），机制未变。

### 证明 A：临时写一处 catch 兜底 ⇒ 守卫点名 `文件:行`

临时文件 `services/api/src/ocr/retryable-proof-scratch.ts`（新函数，不进生产路径，验完即删）：

```ts
export function retryableProofScratch(probe: () => unknown): { retryable: boolean } {
  try {
    probe();
  } catch (error) {
    return { retryable: true };
  }
  return { retryable: false };
}
```

`node --test tests/unit/error-retryable-static-guard.test.mjs` 原文：

```
ℹ pass 3
ℹ fail 1
AssertionError [ERR_ASSERTION]: 受控范围内出现未登记的「兜底恒 retryable: true」站点（catch 分支里没有判据就声称可重试）：要么给出具体判据（如 isTransientDatabaseError），要么改成 false，要么登记白名单并写理由
    actual: [ 'services/api/src/ocr/retryable-proof-scratch.ts:6 retryableProofScratch retryable=true' ]
  expected: []
```

同一次还有全仓清单守卫同时红（两侧判据都覆盖到这一处）：

```
ℹ pass 1
ℹ fail 1
AssertionError [ERR_ASSERTION]: 清单**少了**实际存在的站点：新增 catch 兜底（或给现有站点写入 `retryable: true`）后必须登记并写明判据，⛔ 不许当成没看见
    actual: [ 'services/api/src/ocr/retryable-proof-scratch.ts:6 retryableProofScratch [none]' ]
  expected: []
```

删掉该文件后：`node --test tests/unit/error-retryable-static-guard.test.mjs tests/unit/retryable-fallback-inventory.test.mjs` ⇒ `tests 6 / pass 6 / fail 0`。

### 证明 B：清单里删一条 ⇒ 清单守卫说「少了哪一处」

从 `tests/fixtures/retryable-fallbacks.json` 精确删 1 条（唯一剩下的 `none`：`auth/wechat.ts` / `exchange` / `none`；先备份到 `$env:TEMP\r31-inventory-backup-postmerge.json`）：

```
deleted 1 entry; now 31
ℹ pass 1
ℹ fail 1
AssertionError [ERR_ASSERTION]: 清单**少了**实际存在的站点：新增 catch 兜底（或给现有站点写入 `retryable: true`）后必须登记并写明判据，⛔ 不许当成没看见
    actual: [ 'services/api/src/auth/wechat.ts:109 exchange [none]' ]
  expected: []
```

复原备份后：`counts` 回到 `{"total":32,"has":31,"none":1}`，`tests 2 / pass 2 / fail 0`。

> 顺带记一笔自查：第一次（`#455` 之前）删的时候误按 `file` 过滤，把 `flags-pg.ts` 的 3 条一起删了，`missing` 一次列出 3 条 —— 这也说明 `missing` 断言是**逐条列出**而不是只报个数。

## 7. 读数表

| 命令 | 读数 |
| --- | --- |
| `node --test tests/unit/error-retryable-static-guard.test.mjs` | tests 4 / pass 4 / fail 0 |
| `node --test tests/unit/error-retryable-behavior.test.mjs` | tests 9 / pass 9 / fail 0 |
| `node --test tests/unit/retryable-fallback-inventory.test.mjs` | tests 2 / pass 2 / fail 0 |
| `node --test tests/unit/error-retryable-static-guard.test.mjs tests/unit/retryable-fallback-inventory.test.mjs` | tests 6 / pass 6 / fail 0 |
| `npm run test:unit`（`D:\Git\bin` 前置 PATH） | tests 3627 / pass 3626 / fail 0 / cancelled 0 / skipped 1 / duration 61211.0ms |
| `node tools/verify-contract-status.mjs` | 6 行全 `PASS`（见下），台账未弄红 |

`verify-contract-status` 原文（摘 3 行）：

```
PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 13 / partial 96 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 语义可核 105 条区间 + 0 条片段；不可核 99 条区间 + 158 条片段（不可核不计入通过）
PASS: 证据锚点 412 条引用自带锚点（区间内 240 条 + 仅整文件 172 条）；无锚点不可核 0 条
```

扩域读数用的命令（仓库外探测脚本，复用守卫自己的扫描器；不随仓库提交）：

```powershell
node E:\GengYunCommander\.r31-probe\scope.mjs
# OLD(3 domains) {"files":33,"providerUnavailable":6,"fallbackSites":11,"fallbackNone":0}
# NEW(8 domains) {"files":72,"providerUnavailable":12,"fallbackSites":22,"fallbackNone":0}
```

清单的重写模式（改范围/新增站点后跑一次，务必连同 diff 一起提交）：

```powershell
$env:GY_RETRYABLE_INVENTORY_UPDATE = '1'
node --test tests/unit/retryable-fallback-inventory.test.mjs
Remove-Item Env:\GY_RETRYABLE_INVENTORY_UPDATE
```

## 8. 红线自查

- ⛔ 未合并到 `main` / 未 approve / 未强推；本片只在自己的分支 `test/gy-r31-retryable-guard-domains` 上工作。
- ⛔ 未改业务行为：本片自己的提交只碰 `tests/**` 与 `docs/verification/**`。`services/api/src` 里出现的改动**全部来自 `#455` 的 merge commit `5d0e0308`**，逐字未改（`git diff --stat 0eaf1bde..HEAD -- services miniprogram` 只应看到本片对 `tests/**` 的改动；`git log --oneline -- services` 只应有 `#455` 的提交）。
- ⛔ 未改 `contract-status.json`（`verify-contract-status` 6 行 PASS 即台账未动）。
- ⛔ 未删既有断言：原 3 个 test 的断言逐条保留，只新增。
- 白名单条目**必须被命中恰好一次**（未被命中⇒红），所以它不是 `eslint-disable` 墙。
- **本轮只本地提交，未 push**（由父 agent 推）。
- 依赖未跨树：`npm ci --prefer-offline --no-audit --no-fund --ignore-scripts`，`node_modules/typescript` = 5.9.3。

## 9. 遗留：最该先修的三条（`#455` 之后的世界）

1. `services/api/src/auth/wechat.ts:109` `exchange` —— 全仓清单里**唯一**剩下的 `none`。它现在的 `true` 有理由（结果未知），但语义靠注释维系、客户端拿不到「这次到底成没成」：建议改成显式的「结果未知」封套（或 `retryable: false` + 用同一 `state` 核对），否则下一个读代码的人只会看到一处裸 `true`。
2. `retryable` 的**双语义**：`recognitions/branches.ts:98-153`、`miniprogram/utils/identify-api.js:143-188` 用同名 `retryable` 表达「UI 给不给重试入口」，与 `errors.ts` 的错误封套同名不同义。建议改名（如 `canRetry`）—— 否则下一次「统一 retryable」的清扫要么把展示表扫成缺陷，要么把缺陷当成展示表豁免。
3. 判据只看**catch 通道**：`media/service.ts:781-793` `withKeyClaim` 在普通 `if` 分支里 `{ retryable: true }`（幂等冲突），既不在 catch 内也没有被 catch 调用的 mapper，因此在边界外。建议把判据扩到「所有返回带 `retryable` 的对象字面量」，或在 `errors.ts` 收口（让 `ApiError` 只接受带判据的 verdict 类型），别指望每个调用点都自觉。

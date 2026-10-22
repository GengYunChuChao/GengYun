# R31 · 「确定性失败却声称 `retryable: true`」：静态守卫扩域 + 全仓清单

> 切片：`#455` 落地后暴露的两个已知缺口 —— 守卫白名单只覆盖 `{db, privacy, conversations}` 三域；全仓还有别的「兜底恒 `retryable: true`」形状且没有任何清单或守卫。
> 分支：`test/gy-r31-retryable-guard-domains`（基线 `origin/main` = `d4d48088`，从主检出 `E:\GengYunCommander\GengYun_Agent2` 新开工作树 `E:\GengYunCommander\wt-r31-guarddom`）。
> 交付物：`tests/unit/retryable-guard-scan.mjs`（判据唯一实现）、`tests/unit/retryable-guard-allowlist.mjs`（白名单数据）、`tests/unit/error-retryable-static-guard.test.mjs`（扩域，改写）、`tests/unit/retryable-fallback-inventory.test.mjs`（新增清单守卫）、`tests/fixtures/retryable-fallbacks.json`（版本控制的全仓清单）。
> 问题一句话：`errors.ts:28-40` 写的是「`retryable: true` 仅当同一请求在无人工/运维介入下稍后重试可能成功」，但**每一个调用点各自写字面量**；守卫能守的只是它被允许看的那几个目录，而「兜底恒 true」在别处照样能悄悄长回来。

**取证范围声明**：本片只动**守卫与清单**（测试、fixture、本证据页），⛔ 不改任何业务代码、不改 `contract-status.json`、不删既有断言。所有「登记不修」的条目都是**实测出的既有站点**，逐条给理由与责任片，修不修留在后续切片 —— 所以本文的「缺陷」是**判定**，不是本片修好的结果。

## 0. 结论摘要

| 项 | 改前（基线 `d4d48088`） | 改后 |
| --- | --- | --- |
| 受控域 | 3（`db` / `privacy` / `conversations`） | 8（+ `admin/ops` / `ocr` / `speech` / `recognitions` / `media`） |
| 受控 `.ts` 文件 | 33 | 72 |
| 判据 | 1 条（`new ApiError/PrivacyError` + `PROVIDER_UNAVAILABLE` 且 `retryable` 非字面 `false`） | 同一条 + 第 2 条（catch 通道上的裸 `retryable: true`），**同一个 AST + 同一份白名单** |
| 扫描到的 `PROVIDER_UNAVAILABLE` 非 false 站点 | 6（全部命中白名单） | 15（6 + 扩域新增 9，全部登记） |
| catch 兜底站点（受控范围内） | 11（`judgement: none` 0 处） | 24（`none` 2 处，均在 `admin/ops`，均已登记） |
| 白名单 | 6 条，内联在守卫文件里，无 owner | 15 条，独立文件，逐条 `reason` + `owner`，且**未命中也判红** |
| 全仓清单 | 无 | `tests/fixtures/retryable-fallbacks.json`：34 处（`has` 31 / `none` 3），222 个源文件 |
| 守卫 test 数 | 3 | 4（+ 兜底判据自检） |

一句话读数：**扩域瞬间红 9 处**（这就是缺口 1 的证据 —— 过去这 9 处不会被判红），登记后归零；**全仓另有 3 处「catch 里裸 `retryable: true`」**（缺口 2 的证据），其中 2 处已经是真缺陷、1 处是端口契约使然。

## 1. 范围

### 1.1 做了什么

1. **判据抽成单一实现** `tests/unit/retryable-guard-scan.mjs`（240 行）：`scanProviderUnavailableSites()` 是 `#455` 那条判据的逐行搬迁（未改语义，`scanSource` 别名保留），`scanFallbackClaims()` 是本片新增的第 2 条判据。两个消费者（静态守卫、清单守卫）调用同一份代码 ⇒ 不存在「另起一套判据」。
2. **白名单数据与守卫逻辑分离** `tests/unit/retryable-guard-allowlist.mjs`（225 行）：原 6 条**原文保留**、补 `owner: 'GY-I22'`；新增 9 条 `owner: 'R31'`。每条必须有 `reason`、必须有 `owner`（`GY-Ixx` / `R31`）、必须有 `message` 或 `function` 之一，否则 `assertEntriesWellFormed()` 直接判红。
3. **静态守卫扩域**：`SCOPE_DIRS` 由 3 域扩到 8 域 —— `db` / `privacy` / `conversations` 之外加 `admin/ops`（即 `services/api/src/admin/ops/**`）、`ocr`、`speech`、`recognitions`、`media`，共 72 个 `.ts`。原 3 个 test 一条断言都没删，另加第 4 个「兜底判据自检」。
4. **新增全仓清单守卫** `tests/unit/retryable-fallback-inventory.test.mjs`：扫 `services/api/src/**`（196 个 `.ts`）+ `miniprogram/**/utils/**`（26 个 `.js`），把 catch 通道上的 `retryable` 站点落成受版本控制的 JSON，**多一处少一处都红**。

### 1.2 没做什么（边界）

- **不修**清单里 `judgement: none` 的条目（只登记 + 本页给判断）；⛔ 为了让扩域变绿去改业务代码。
- `media` 域实测 0 处（它的封套是 `MediaError`，不在 `ERROR_CLASSES` 内；`media/service.ts:487`、`:763-768` 是 `retryable: false`、`media/service.ts:361` 是 `retryable: error.retryable`）—— 仍纳入受控范围，作为「将来有人在这里写回 true」的兜底。
- `recognitions/branches.ts:98-153`、`miniprogram/utils/identify-api.js:88-94/143-188` 的 `retryable: true` 是**展示描述符**（UI 是否给重试入口），不是错误封套，**不计入**清单（判据也不覆盖：它们不在 catch 通道上）。
- `auth/wechat.ts:109` 是清单里唯一「端口契约使然」的 `none`，但它**不在**受控范围内 —— 本片只登记，不扩域到 `auth`。

## 2. 两个缺口分别是什么

**缺口 1（守卫覆盖面）**：`#455` 的白名单只列了三域，`SCOPE_DIRS` 也只有三域。于是 `admin/ops`、`ocr`、`speech`、`recognitions` 的 store/gate 将来写回「兜底恒 `true`」时，守卫**看不见**，CI 全绿。这不是理论风险：把 `SCOPE_DIRS` 扩到 8 域、白名单不动，守卫立刻红 9 处 —— 说明这 9 处**一直存在**，只是没人被允许看。

**缺口 2（没有清单）**：`#455` 的判据只认 `new ApiError/PrivacyError(...)` 的**第 3 个参数**。但「兜底恒 true」最常见的形状根本不经过错误类构造：`catch (e) { return { retryable: true } }`、或者 `catch` 调一个 mapper 函数、mapper 里 `return { retryable: true }`。这类站点全仓**没有任何东西在数**，所以第 3 节里的证明 A（临时写一个 `catch (e) { return { retryable: true } }`）在过去只会让 `npm run test:unit` 全绿。

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

扩域读数（用守卫自己的扫描器实测，命令见第 7 节）：

| 范围 | 受控 `.ts` | `PROVIDER_UNAVAILABLE` 非 false 站点 | catch 兜底站点 | 其中 `none` |
| --- | --- | --- | --- | --- |
| 改前 3 域 | 33 | 6 | 11 | 0 |
| 扩到 8 域（白名单不动） | 72 | **15** | 24 | **2** |
| 扩到 8 域（登记后，本片交付态） | 72 | 15 / 全部命中 | 24 / `none` 全部命中 | 0 未登记 |

**新增 9 处**（= 15 − 6）就是缺口 1 的实证。它们**全部登记、一处未修**：

| 站点 | 函数 | `retryable` 表达式 | 判定 | owner |
| --- | --- | --- | --- | --- |
| `services/api/src/admin/ops/flag-gate.ts:394` | `failClosedError` | `failClosedRetryableFor(cause)` | 有判据（合法放宽） | R31 |
| `services/api/src/admin/ops/flags-pg.ts:317` | `mapFlagReadError` | `true` | **兜底恒 true（真缺陷）** | R31 |
| `services/api/src/admin/ops/service.ts:650` | `flagReadFailure` | `true` | **兜底恒 true（真缺陷）** | R31 |
| `services/api/src/ocr/store-pg.ts:137` | `classifyOcrDatabaseError` | `isTransientDatabaseError(error)` | 有判据 | R31 |
| `services/api/src/ocr/store-pg.ts:424` | `tablesReady` | `true` | **确定性失败却声称可重试** | R31 |
| `services/api/src/recognitions/store-pg.ts:150` | `classifyRecognitionDatabaseError` | `isTransientDatabaseError(error)` | 有判据 | R31 |
| `services/api/src/recognitions/store-pg.ts:478` | `tablesReady` | `true` | **确定性失败却声称可重试** | R31 |
| `services/api/src/speech/store-pg.ts:122` | `classifySpeechDatabaseError` | `isTransientDatabaseError(error)` | 有判据 | R31 |
| `services/api/src/speech/store-pg.ts:369` | `tablesReady` | `true` | **确定性失败却声称可重试** | R31 |

## 4. 白名单理由表（15 条，逐条给「为什么可以不是 false」）

原 6 条（`owner: GY-I22`）理由原文保留在 `tests/unit/retryable-guard-allowlist.mjs:29-83`，此处只摘判定：`db/catalog.ts` ×2、`conversations/store-pg.ts:63-69`、`privacy/deletion-requests-pg.ts:183-188`、`db/source-lifecycle.ts:69-78`、`privacy/ledger-pg.ts:86-90` —— 都是「瞬时类分类器 / 已识别的瞬时分支」⇒ 合法放宽。

新增 9 条（`owner: R31`）的判定与理由：

| 站点 | 判定 | 为什么这一处可以非 false（或为什么它是缺陷） |
| --- | --- | --- |
| `flag-gate.ts:394` | 有判据 | `retryable` 由 `FlagGateFailCause` 决定（`flag-gate.ts:80-83` `failClosedRetryableFor`）：`read_error`（读取抛错＝存储抖动/超时）⇒ true；`unrecognized`（行缺失 / `enabled` 非布尔 / `key` 越界 / `revision` 非法＝配置或数据事故，需运维修复）⇒ false。复核结论原文见 `flag-gate.ts:372-381`。**这是「确定性失败必须 false」的正确样板**，守卫只钉表达式文本。 |
| `flags-pg.ts:317` | **真缺陷** | `mapFlagReadError` 尾部对「无法归类的驱动错误」也 `retryable: true`（注释：连接被掐/网络抖动等 ⇒ 可重试）。与同族分类器「无法归类 ⇒ false」的口径冲突 —— 无法归类的错误完全可能是列名拼错这类确定性缺陷。 |
| `service.ts:650` | **真缺陷** | `flagReadFailure(error)` 只放行已分类的 `ApiError`，其余一律 503 + `retryable: true`；注释声称「传输/超时类按可重试」，代码并不区分传输/超时与代码缺陷。且与同一功能面的 `flag-gate.ts` 分档**互相矛盾**：同一种「开关读不出来」在两处给出相反结论。 |
| `ocr/store-pg.ts:137` | 有判据 | 与 `messages/favorites/history/community/conversations` 的 `classify*DatabaseError` 逐条同口径：57014/55P03 已在上方折成 `PROVIDER_TIMEOUT`，此处 `isTransientDatabaseError` 只放行 08xxx/53xxx/57P0x/40001/40P01；42501/3D000/28P01/42P01/42883 与无法归类一律 false（注释原文 `ocr/store-pg.ts:133-136`）。 |
| `ocr/store-pg.ts:424` | **真缺陷** | 该分支只在 `probeFailure === null` 时可达（`ocr/store-pg.ts:400-407` / `417-432`）：探测 SQL **真的执行成功**但形状读不懂（无行 / `ready` 非布尔）—— 确定性状态，不是瞬时抖动。消息文案自称「未知 ≠ 未迁移」＝fail-closed，却给了 `retryable: true`。 |
| `recognitions/store-pg.ts:150` | 有判据 | 与 ocr/speech 同一分类器、同一条分档注释（瞬时类 true；权限/缺表/缺函数/无法归类 false）。 |
| `recognitions/store-pg.ts:478` | **真缺陷** | 与 `ocr/store-pg.ts:424` 逐字同构（只有分类器名字不同）：可达条件是「探测成功但形状读不懂」⇒ 确定性状态。 |
| `speech/store-pg.ts:122` | 有判据 | 与 ocr/recognitions 同一分类器、同一条分档注释。 |
| `speech/store-pg.ts:369` | **真缺陷** | 与 `ocr/store-pg.ts:424` 逐字同构。三处同构说明这是**复制粘贴传播的同一个错**，修的时候必须一起改，否则守卫会立刻红回来。 |

## 5. 全仓清单（34 处）

`tests/fixtures/retryable-fallbacks.json`：`{version, generatedBy, scanned, counts, entries}`，条目字段 `{file, line, function, judgement, owner}`，按 `file` / `line` 排序。

| 项 | 读数 |
| --- | --- |
| 扫描范围 | `services/api/src/**` 196 个 `.ts` + `miniprogram/**/utils/**` 26 个 `.js`（共 222 个源文件） |
| 总站点 | **34** |
| `judgement: has`（有判据） | **31** |
| `judgement: none`（catch 里裸 `retryable: true`） | **3** |
| `miniprogram/utils` 侧站点 | 0（26 个文件全是封套透传 `payload.error.retryable === true` 与展示状态表，没有 catch 兜底形状） |

`has` 的典型：`community/store-pg.ts:90/97`（分支 true + `isTransientDatabaseError(error)`）、`db/source-lifecycle.ts:69/78`（分支 + `unknown || isTransientDatabaseError(error)`）、`media/service.ts:361`（`error.retryable`）、`privacy/egress.ts:75`（`candidate?.retryable === true`）、`privacy/ledger-pg.ts:86/90`、`db/catalog.ts:29/52`、`favorites|history|messages|ocr|speech|recognitions/store-pg.ts` 各有「分支 + 分类器」一对、`admin/ops/flags-pg.ts:311/329`（按 SQLSTATE 分档）、`admin/ops/accounts-pg.ts:105`、`admin/ops/account-authority-pg.ts:168`、`auth/wechat.ts:106`。

注意一处**判据边界**：`ocr/store-pg.ts:424`、`speech/store-pg.ts:369`、`recognitions/store-pg.ts:478` 三个 `tablesReady` 站点**不在**清单里 —— 它们既不在 catch 内，其函数也不是被 catch 调用的 mapper。它们由第 1 条判据（`new ApiError` + `PROVIDER_UNAVAILABLE`）覆盖，两条判据在此互补，不是漏。

### 3 处 `none`：现状是否合理

| 站点 | 函数 | 现状是否合理 |
| --- | --- | --- |
| `services/api/src/admin/ops/flags-pg.ts:317` | `mapFlagReadError` | **不合理（真缺陷）**。字典化失败读面是幂等的没错，但「无法归类的驱动错误」里有确定性缺陷（列名/类型不匹配、SQL 语法错），对这些重试永远失败；同族分类器的口径是「无法归类 ⇒ false」，这里是唯一例外，且没有任何注释解释为什么开关读面可以例外。 |
| `services/api/src/admin/ops/service.ts:650` | `flagReadFailure` | **不合理（真缺陷）**。它声称「传输/超时类按可重试」，但代码看不见错误类型；同一功能面的 `flag-gate.ts` 已经把 `unrecognized` 判成 false，这里却给 true ⇒ 同一故障两种口径，客户端会按 `retryable` 决定退避与提示，等于把「配置事故」包装成「稍后再试」。 |
| `services/api/src/auth/wechat.ts:109` | `exchange` | **合理（端口契约使然）**。`code` 已换发出去、对方可能已受理，此时网络异常属 `PROVIDER_OUTCOME_UNKNOWN`：重试**可能**成功，而谎称失败会让用户重复登录、产生歧义。这里 `true` 是「结果未知」的语义，不是「兜底」；要收紧只能改成 `false` + 引导用同一 `state` 核对，属于登录链路的行为改动，不在守卫片范围。 |

## 6. 非空证明（两条，原文）

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
AssertionError [ERR_ASSERTION]: 受控范围内出现未登记的「兜底恒 retryable: true」站点（catch 分支里没有判据就声称可重试）：要么给出具体判据（如 isTransientDatabaseError），要么改成 false，要么登记白名单并写理由
...
actual: [ 'services/api/src/ocr/retryable-proof-scratch.ts:7 retryableProofScratch retryable=true' ]
```

同一次还有全仓清单守卫同时红（两侧判据都覆盖到这一处）：

```
AssertionError [ERR_ASSERTION]: 清单**少了**实际存在的站点：新增 catch 兜底（或给现有站点写入 `retryable: true`）后必须登记并写明判据，⛔ 不许当成没看见
actual: [ 'services/api/src/ocr/retryable-proof-scratch.ts:7 retryableProofScratch [none]' ]
```

删掉该文件后：静态守卫 `tests 4 / pass 4 / fail 0`，清单守卫 `tests 2 / pass 2 / fail 0`。

### 证明 B：清单里删一条 ⇒ 清单守卫说「少了哪一处」

从 `tests/fixtures/retryable-fallbacks.json` 精确删 1 条（`flags-pg.ts` / `mapFlagReadError` / `none`，此前备份到 `$env:TEMP\r31-inventory-backup.json`）：

```
deleted 1 entry; now 33 {"total":33,"has":31,"none":2}
AssertionError [ERR_ASSERTION]: 清单**少了**实际存在的站点：新增 catch 兜底（或给现有站点写入 `retryable: true`）后必须登记并写明判据，⛔ 不许当成没看见
actual: [ 'services/api/src/admin/ops/flags-pg.ts:317 mapFlagReadError [none]' ]
```

复原备份后：`tests 2 / pass 2 / fail 0`，`counts` 回到 `{"total":34,"has":31,"none":3}`。

> 顺带记一笔自查：第一次删的时候误按 `file` 过滤，把 `flags-pg.ts` 的 3 条一起删了（`missing` 一次列出 3 条），已从备份还原 —— 这也说明 `missing` 断言是**逐条列出**而不是只报个数。

## 7. 读数表

| 命令 | 读数 |
| --- | --- |
| `node --test tests/unit/error-retryable-static-guard.test.mjs` | tests 4 / pass 4 / fail 0 |
| `node --test tests/unit/error-retryable-behavior.test.mjs` | tests 9 / pass 9 / fail 0 |
| `node --test tests/unit/retryable-fallback-inventory.test.mjs` | tests 2 / pass 2 / fail 0 |
| `npm run test:unit`（`D:\Git\bin` 前置 PATH） | tests 3623 / pass 3622 / fail 0 / cancelled 0 / skipped 1 / duration 77094.8ms |
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
# NEW(8 domains) {"files":72,"providerUnavailable":15,"fallbackSites":24,"fallbackNone":2}
```

清单的重写模式（改范围/新增站点后跑一次，务必连同 diff 一起提交）：

```powershell
$env:GY_RETRYABLE_INVENTORY_UPDATE = '1'
node --test tests/unit/retryable-fallback-inventory.test.mjs
Remove-Item Env:\GY_RETRYABLE_INVENTORY_UPDATE
```

## 8. 红线自查

- ⛔ 未合并 / 未 approve / 未推 `main` / 未强推；只推自己的分支 `test/gy-r31-retryable-guard-domains`。
- ⛔ 未改业务行为：`services/api/src` 下**零改动**（证明 A 的临时文件在校验后删除，`git status` 里不存在）。
- ⛔ 未改 `contract-status.json`（`verify-contract-status` 6 行 PASS 即台账未动）。
- ⛔ 未删既有断言：原 3 个 test 的断言逐条保留，只新增。
- 白名单条目**必须被命中恰好一次**（未被命中⇒红），所以它不是 `eslint-disable` 墙。
- 依赖未跨树：`npm ci --prefer-offline --no-audit --no-fund --ignore-scripts`，`node_modules/typescript` = 5.9.3。

## 9. 遗留：最该先修的三条

1. `speech/store-pg.ts:369` / `recognitions/store-pg.ts:478` / `ocr/store-pg.ts:424` 的 `tablesReady` 三处同构 —— 确定性状态（探测成功但形状读不懂）却声称可重试，按 `errors.ts:28-40` 应为 `false`；改一处就得同时改三处，并同步白名单（守卫会立刻红回来，这正是它该做的事）。
2. `admin/ops/service.ts:650` `flagReadFailure` —— 与同一功能面的 `flag-gate.ts` 分档直接矛盾，建议接入 `FlagGateFailCause`（`read_error` ⇒ true / `unrecognized` ⇒ false），而不是自己判「传输/超时」。
3. `admin/ops/flags-pg.ts:317` `mapFlagReadError` —— 把「无法归类」从 `true` 改成 `false`（与 `conversations/store-pg.ts:63-69`、`isTransientDatabaseError` 同口径），只保留 57014/55P03 的 `PROVIDER_TIMEOUT` 分档。

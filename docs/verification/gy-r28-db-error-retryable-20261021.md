# R28-S62 · 7 个 store 的错误折叠 `retryable` 分档（权限/配置类不再声称可重试）

> 切片：R28-S62；分支 `fix/gy-r28-db-error-retryable`；基线 `76b0e86`（`upstream/main`，`git fetch` 后无需 rebase）。
> 交付物：`services/api/src/{favorites,history,community,messages,ocr,speech,recognitions}/store-pg.ts` 各自 `classify*DatabaseError` 的**通用折叠分支**（7 处，各 +1 行 import、+4 行注释、表达式一处）；`tests/unit/db-error-retryable-classification.test.mjs`（新增，8 条）；`tests/unit/{community-store-pg-contract,ocr-store-pg,speech-store-pg}.test.mjs` 三条**旧口径断言**的订正；本页；报告 `.pg17/handoff/r28-s62-report.md`。
> 问题一句话：这 7 个折叠器把「非 57014/55P03 的一切错误」都折成 `ApiError('PROVIDER_UNAVAILABLE', …, { retryable: true })` ⇒ **权限不足（42501）/ 表或库缺失（42P01 / 3D000）/ 凭据错误（28P01）也对外声称"可重试"**。本仓 2026-10-20/21 连续四例「运行时授权缺失」（S26 / S28 / S38 / S45）的可见症状正是它：接口**永久 503 且 `retryable: true`**，监控上像下游抖动、不像"运维必须改配置"。

**取证范围声明**：本页证据是**单元级 + 静态级**——7 个折叠器是纯函数（`(error: unknown) => never`），判定矩阵与反例全部在 `node --test tests/unit/...` 内可复现；反向守卫既扫 7 个真实文件，也在**内存夹具**上证明它会红，另用基线 `76b0e86` 的 7 个旧文件做**真实负控制**（§4.3）。⛔ 本页不得读作「已在真 PG / HTTP 面端到端验证」：需要真库与 HTTP 面的部分逐条列在 §7。

## 0. 结论摘要

| 项 | 改前（`76b0e86`） | 改后 |
|---|---|---|
| 通用分支的 `retryable` | 字面量 `true`（7 处） | `isTransientDatabaseError(error)`（7 处，与 `conversations/store-pg.ts` 同一函数） |
| `42501` 权限不足 | `PROVIDER_UNAVAILABLE` · 503 · **可重试** | `PROVIDER_UNAVAILABLE` · 503 · **不可重试** |
| `42P01` 表缺失 | 同上 | 同上（`ocr` / `speech` / `recognitions` 的写类仍先走各自的「表未迁移」专用错误，文案点名迁移号，**未改**） |
| `3D000` 库缺失 / `28P01` 凭据 / `42883` 函数缺失 | 可重试 | 不可重试 |
| `08006` / `ECONNREFUSED` / `40001` / `40P01` / `57P01` | 可重试 | **不变，仍可重试** |
| `57014` / `55P03` | `PROVIDER_TIMEOUT` · 504 · 可重试 | **不变**（专用分支未动） |
| 无法归类的普通 `Error` | 可重试（`speech` 为原样抛出） | 不可重试（`speech` 仍原样抛出，按现状钉住） |
| 错误码 / HTTP 状态 / 文案 | — | **一律不变**：`PROVIDER_UNAVAILABLE` 503、`PROVIDER_TIMEOUT` 504、7 条域文案逐字未动 |
| 契约 JSON / 新错误码 | — | **未改、未新增**（`ErrorCode` 闭集不变，契约测试 6/6 见 §6） |
| 反向守卫 | 无 | 正则扫 7 文件，禁止通用分支写回恒 `true`；内存夹具 + 基线文件双负控制（§4） |

## 1. 范围

### 1.1 做了什么

1. 7 个 `store-pg.ts` 各改三处：①`import { isTransientDatabaseError } from '../db/pool.ts'`；②通用分支前加 4 行注释（写清哪些码可重试、哪些码重试永远不会好）；③`{ retryable: true }` → `{ retryable: isTransientDatabaseError(error) }`。
2. `tests/unit/db-error-retryable-classification.test.mjs`（新增）：判定矩阵（8 个分类器 × 17 个驱动码）、三个「表未迁移」专用分支、未知 `Error`、与共享判定函数的抽样交叉、**反向守卫**及其自检夹具。
3. 三条既有断言的订正（全部是「把非瞬态码钉成可重试」的旧口径，逐条见 §5），每条同时补了一条瞬态码 `08006` 正向断言，避免「收紧」被误读成「砍掉可重试面」。
4. 本页 + 报告。

### 1.2 没做什么（边界）

- 没有改 HTTP 状态、错误码、文案、路由行为、响应封套字段；没有新增错误码；没有改 `services/api/src/contract.ts` 或任何契约 JSON。
- 没有改 `ocr` / `speech` / `recognitions` 的「表未迁移」专用分支（`*TablesMissingError`，各自点名 `0024` / `0026` / `0025`）——它们本来就是 `retryable: false`。
- 没有改 `conversations/store-pg.ts`（正确参照，本片只读它做一致性断言）。
- 没有碰 `deploy/**`、`migrations/**`、`roles/**`、`.github/**`、`docs/architecture/**`、`tests/integration/**`。
- 没有把 `speech` 的「无 `code` 的普通 `Error` 原样抛出」统一成其它 6 域的「折成 `PROVIDER_UNAVAILABLE`」：这是该域既有语义（其测试与注释都明确要求原样抛出），统一它属于改契约行为，超出本片。
- 没有改 `tests/unit/error-retryable-static-guard.test.mjs` 的白名单（其受控范围是 `services/api/src/{db,privacy,conversations}`，**不含**这 7 个 store，故本片改动本不会触发它；实测该文件仍全绿，见 §6）。

## 2. 缺陷机制

7 个折叠器形状相同（改前，以 `favorites` 为例）：

```
export function classifyFavoritesDatabaseError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '收藏数据库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  throw new ApiError('PROVIDER_UNAVAILABLE', '收藏数据库暂不可用', { retryable: true });   // ← 问题所在
}
```

`errors.ts:28-40` 的口径是「能力未装配／配置与权限类 `PROVIDER_UNAVAILABLE` 一律 `false`，只有瞬时类才可 `true`」。`conversations/store-pg.ts:68` 已是正确形态（`retryable: isTransientDatabaseError(error)`），但这 7 个域各自写了字面量 `true`，于是：

1. **症状误导**：S26 / S28 / S38 / S45 四例里，真因是「运行时授权缺失」（`GRANT` 没执行 / 角色没有列级权限 / 表没迁移），但客户端与监控读到的是「503 可重试」⇒ 像下游抖动，重试队列会把确定性失败重放成噪声。
2. **判据丢失**：`42501`（权限不足）、`42P01`（表缺失）、`3D000/28P01`（库/凭据）、`42883`（函数缺失）与 `08006/ECONNREFUSED` 被压成同一读数，运维无法从响应区分「改配置」与「等一等」。
3. **正解就近存在**：`services/api/src/db/pool.ts` 的 `isTransientDatabaseError` 就是本仓既定分类器（`db/catalog.ts`、`conversations`、`db/source-lifecycle.ts` 已在用），7 个域只是没接上。

## 3. 判定矩阵（8 个分类器 × 驱动码，实测读数）

`tests/unit/db-error-retryable-classification.test.mjs` 对 7 个域 + 参照实现 `conversations` 逐条断言。下表「改前」来自基线 `76b0e86` 源码（7 域通用分支恒 `true`），「改后」为本片实测：

| 驱动错误 | 含义 | 折叠后错误码 | HTTP | 改前 retryable | 改后 retryable |
|---|---|---|---|---|---|
| `42501` | 权限不足 | `PROVIDER_UNAVAILABLE` | 503 | true | **false** |
| `42P01` | 表缺失 | `PROVIDER_UNAVAILABLE` | 503 | true | **false** |
| `3D000` | 库缺失 | `PROVIDER_UNAVAILABLE` | 503 | true | **false** |
| `28P01` | 凭据错误 | `PROVIDER_UNAVAILABLE` | 503 | true | **false** |
| `42883` | 函数缺失 | `PROVIDER_UNAVAILABLE` | 503 | true | **false** |
| `XX000` | 内部错误 | `PROVIDER_UNAVAILABLE` | 503 | true | **false** |
| `22P02` | 数据表示错误 | `PROVIDER_UNAVAILABLE` | 503 | true | **false** |
| `08006` | 连接失败 | `PROVIDER_UNAVAILABLE` | 503 | true | true（不变） |
| `08001` | 连接建立失败 | `PROVIDER_UNAVAILABLE` | 503 | true | true（不变） |
| `57P01` | 管理员关连接 | `PROVIDER_UNAVAILABLE` | 503 | true | true（不变） |
| `40001` | 串行化失败 | `PROVIDER_UNAVAILABLE` | 503 | true | true（不变） |
| `40P01` | 死锁 | `PROVIDER_UNAVAILABLE` | 503 | true | true（不变） |
| `ECONNREFUSED` | 端口拒连 | `PROVIDER_UNAVAILABLE` | 503 | true | true（不变） |
| `ECONNRESET` | 连接被重置 | `PROVIDER_UNAVAILABLE` | 503 | true | true（不变） |
| `ETIMEDOUT` | 连接超时 | `PROVIDER_UNAVAILABLE` | 503 | true | true（不变） |
| `57014` | 语句超时 | `PROVIDER_TIMEOUT` | 504 | true | true（专用分支，未动） |
| `55P03` | 等锁超时 | `PROVIDER_TIMEOUT` | 504 | true | true（专用分支，未动） |
| 普通 `Error`（无 `code`） | 实现缺陷 | `PROVIDER_UNAVAILABLE`（`speech` 原样抛） | 503 / — | true | **false** |

补充事实：

- **7 个域的读数逐条相同**，也与参照实现 `conversations` 相同（测试里 8 个分类器一起跑同一张矩阵）。
- `ocr` / `speech` / `recognitions` 在 `42P01` 上**有两层**：分类器通用分支给 `PROVIDER_UNAVAILABLE` + `false`（无「未迁移」文案）；写类方法在发 SQL 前先 `to_regclass` 探测，缺表则抛各自的 `*TablesMissingError`（`PROVIDER_UNAVAILABLE` · 503 · `false`，文案点名 `0024_ocr_persistence.sql` / `0026_speech_persistence.sql` / `0025_recognitions_persistence.sql`）。两层都由测试钉住，且断言分类器**不冒充**专用文案。
- `57014` / `55P03` 走的是各文件上方独立分支，本片**一行未动**；矩阵里它们仍是 504 + true。

## 4. 反向守卫（防回潮）与负控制

### 4.1 守卫形状

`tests/unit/db-error-retryable-classification.test.mjs` 末两条测试：正则扫 7 个文件的
`new ApiError('PROVIDER_UNAVAILABLE', '<域>数据库暂不可用', { <options> })`，要求

1. 每个文件**恰命中 1 处**（正则失配会静默放过，故按数量钉死；将来改写法会先红）；
2. `options` 归一化后**逐字**等于 `retryable: isTransientDatabaseError(error)`；
3. 出现 `retryable: true` 即单独报「恒 true 回潮」。

守卫只匹配「`PROVIDER_UNAVAILABLE` + 文案含『数据库暂不可用』」这一对，因此不误伤超时分支的 `retryable: true`，也不误伤「功能未接线」类文案。

### 4.2 内存夹具（证明守卫真能抓）

| 夹具（内存字符串，不落盘） | 期望 | 实测 |
|---|---|---|
| `新建 ApiError('PROVIDER_UNAVAILABLE', '收藏数据库暂不可用', { retryable: true })` | 判定为回潮 | 红 ✔ |
| 同上但 `{ retryable: isTransientDatabaseError(error) }` | 通过 | 绿 ✔ |
| 多行书写（参数换行、对象尾逗号） | 仍被扫到并判绿 | 绿 ✔ |
| `{ retryable: false }`（用字面量换掉共享判定） | 判红（否则 `08006` 会被误报成不可重试） | 红 ✔ |
| `PROVIDER_TIMEOUT` + 『响应超时』+ `retryable: true` | 不命中（超时分支合法） | 0 命中 ✔ |
| `PROVIDER_UNAVAILABLE` + 『功能未接线』+ `retryable: true` | 不命中（非本守卫目标） | 0 命中 ✔ |

### 4.3 真实基线负控制

另用一次性脚本（`.pg17\tmp\r28-s62-guard-check.mjs`，**不提交**）把同一正则分别喂给「当前工作树」与「`git show 76b0e86:<file>`」的 7 个文件：

| 输入 | 命中站点 | 判红 |
|---|---|---|
| 基线 `76b0e86` 的 7 个 `store-pg.ts` | 7 | **7**（每处都是 `retryable: true`） |
| 本片改后的 7 个 `store-pg.ts` | 7 | **0** |

⇒ 守卫不是恒绿：对真实旧文件它 7/7 判红，对改后文件 0 判红。

## 5. 被改动的既有断言逐条（3 条；每条都改的是「错误行为」）

全量 `tests/unit` 在改实现后先红了 3 条，全部是同一类旧口径（把确定性失败钉成可重试）。逐条：

**① `tests/unit/community-store-pg-contract.test.mjs:612`（改前行号）**

- 改前：`assert.equal(other?.retryable, true, '数据库暂不可用是可重试的瞬时故障');`，`other` 来自 `code: '22P02'`。
- 改后：`assert.equal(other?.retryable, false, '数据表示错误重试不会成功，不得标可重试');`，并新增 `08006 ⇒ retryable === true` 正向断言（现 :626）。
- 理由：`22P02`（invalid_text_representation）是数据/表示层错误，同一请求原样重试恒定失败；旧断言把「数据库暂不可用」整体当成瞬态，正是本片要订正的口径。状态码断言（`PROVIDER_UNAVAILABLE`）未动。测试标题同步改为区分「配置/权限/数据类不可重试」与「瞬态类可重试」。

**② `tests/unit/ocr-store-pg.test.mjs:473`（改前行号）**

- 改前：`code: '42P01'` ⇒ `error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true`。
- 改后：同条件但 `retryable === false`，并新增 `08006 ⇒ true` 正向断言（现 :478-481）。
- 理由：`42P01` 是表缺失，属「跑迁移/改配置」类；OCR 域另有专用 `OcrTablesMissingError`（`retryable: false`），分类器却对同一 `42P01` 声称可重试，自相矛盾。`57014/55P03 ⇒ PROVIDER_TIMEOUT` 与冲突错误直通两段**未动**。

**③ `tests/unit/speech-store-pg.test.mjs:485`（改前行号）**

- 改前：`code: 'XX000'` 经 `store.getJob` 抛出 ⇒ `error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true`。
- 改后：同条件但 `retryable === false`，并新增 `08006 ⇒ true` 正向断言（现 :489-494）。
- 理由：`XX000`（internal_error）是内部错误，同一请求原样重试大概率原样复现，不应劝客户端重试。该测试的其余部分——`57014/55P03 ⇒ 504`、普通 `Error` 原样抛出、`SpeechStoreConflictError` 与 `ApiError` 直通——**一字未动**，且全绿。

**未改的**：`tests/unit/recognitions-store-pg.test.mjs:753` 的同类测试用的是 `08006`（真瞬态），断言 `retryable === true` 正确，**未改**；`favorites` / `history` / `messages` 的既有单测里没有断言旧口径（全绿）。除上述 3 处外，本片对既有测试**0 改动**。（该行号由 GY-R71 按文本重定位：本片给 `recognitions/store-pg.ts` 的写点加事务与台账行，同一批单测文件整体下移 28 行，原来的行号即现在这条 `08006` 断言。）

## 6. 门禁读数

| 序 | 门禁 | 结果 |
|---|---|---|
| 1 | `node --test tests/unit/db-error-retryable-classification.test.mjs`（新测试） | 8/8 通过，fail 0 |
| 2 | `npm run lint`（tsc 两包 + 卫生扫描） | exit 0：`PASS tsc services/api` / `PASS tsc apps/admin` / `PASS 仓库卫生扫描` |
| 3 | `node tools/verify-release-materials.mjs` | exit 0：**15/15 项通过** |
| 4 | `npm run test:docs` | exit 0（见 §6.1） |
| 5 | `node tools/verify-contract-status.mjs` | exit 0：覆盖 112 条契约操作、形状错误 0、语义错误 0 |
| 6 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 6/6 通过，fail 0 |
| 7 | 受影响既有单测：`community-store-pg-contract` / `ocr-store-pg` / `speech-store-pg` / `recognitions-store-pg` | 76/76 通过；全量 `tests/unit` 2081 条（2080 通过、0 失败、1 跳过） |
| 8 | `git diff --check` | 无输出（exit 0） |

### 6.1 门禁 4 的读数

`npm run test:docs` = `node tools/run-python.mjs tools/validate_development_docs.py` + `node tools/verify-research-records.mjs`，两者 exit 0；本页的中文表格由该门禁的「中文表格一致」检查覆盖。

## 7. 未取得（逐条）

1. **未在真 PG 上复现 42501/42P01 的 HTTP 响应封套**：本片证据止于折叠器纯函数与 store 写类的单元级（`to_regclass` 用假池）。真库注入（`REVOKE` / 缺表）与 HTTP 面读数属 `tests/integration/**`，本片红线不可碰，也未在本机跑。
2. **未验证客户端重试策略的实际变化**：仓库内未见消费 `error.retryable` 做自动重试的客户端实现（小程序 / 后台），因此「改成 false 后重试队列不再重放」只有契约语义依据，没有端到端观测。
3. **未审计其它域的同类恒 true 站点**：`tests/unit/error-retryable-static-guard.test.mjs` 白名单里仍有 `privacy/deletion-requests-pg.ts`、`privacy/ledger-pg.ts`、`db/source-lifecycle.ts` 的 `retryable: true` 站点（各自有瞬时分支理由）；本片未复核其分类正确性，也未动它们。
4. **`speech` 的「普通 `Error` 原样抛出」未统一**：其余 6 域折成 `PROVIDER_UNAVAILABLE(false)`，`speech` 原样抛（无 `code`）。本片按现状钉住；是否统一需另开切片。
5. **未跑 `npm run test:integration:*` 与真库 CI**：无真 PG 集群与 HTTP 环境，且 `tests/integration/**` 在本片红线内。
6. **未做性能/压测**：`isTransientDatabaseError` 是一次属性读取与正则匹配，但本片未测高错误率下的开销（判定为无意义：仅错误路径执行）。

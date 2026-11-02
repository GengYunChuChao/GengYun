# GY-I27 授权错误码前后端对拍闸门 · 证据页（2026-11-02）

> **一句话**：新增一条**纯静态**闸门，把「服务端三份授权文件里 `throw` 的码」与「客户端
> `consent-api.js` 五张表处理的码」钉成同集合：服务端 **14** 个、客户端并集 **21** 个，
> 服务端只差 `SESSION_EXPIRED`（已登记为 401 归一例外），客户端多出 8 个（逐个登记理由）。
> 它证明的是**码集合一致**；**不**证明运行时真的走到那些分支、**不**证明文案正确、**不**证明真机交互。

## 1 基线与范围

- 基线：`upstream/main` = `28291489`（`docs(architecture): 活文档里的契约总数改指针，并加形状闸门禁止手抄 (#839)`）。
- 分支：`codex/gy-i27-error-parity-20261102`，从上述提交拉出；本片**不** commit / push / rebase。
- 新增两个文件，**零产品代码、零既有测试改动**：
  - `tests/unit/consent-error-code-parity.test.mjs`（闸门本体，9 条用例，含 3 条负控制）
  - `docs/verification/gy-i27-error-code-parity-20261102.md`（本页）
- 没有碰：`services/api/src/**`、`miniprogram/**`、`packages/contracts/**`、迁移、CI、
  `tools/doc-anchors-*.json`。`git status --short` 只应出现这两个未跟踪文件。

## 2 为什么需要这条闸门（实测缺口）

#29 的验收有一条「输出**前后端一致**的授权错误码与交互」。改前两端各持一张表，但**没有任何机器检查**
保证它们同集合：服务端在路由/落库层直接 `throw new ApiError('CODE', …)`，客户端在
`miniprogram/utils/consent-api.js:313-324`（读面 `MESSAGES`）、`:565-581`（`GRANT_MESSAGES`）、
`:582-601`（`WITHDRAW_MESSAGES`）查文案，在 `:617-618` 用两个 `*_BLOCKING_CODES` 决定置灰。
两张表靠人工同步，改一边不改另一边不会红。

### 2.1 服务端扫描面实测：14 个码

扫描面冻结为三份（`readFileSync` 直接读，缺一份即 ENOENT）：

| 文件 | 抽到的码（去重） | 调用点数 |
| --- | --- | --- |
| `services/api/src/routes/consents.ts` | `SESSION_REQUIRED`、`PROVIDER_UNAVAILABLE`、`IDEMPOTENCY_KEY_REQUIRED`、`REVISION_REQUIRED`、`INVALID_REQUEST` | 6 |
| `services/api/src/privacy/grant-pg.ts` | `PROVIDER_UNAVAILABLE`、`INVALID_REQUEST`、`IDEMPOTENCY_KEY_REQUIRED`、`IDEMPOTENCY_CONFLICT`、`CONSENT_REQUIRED`、`REVISION_CONFLICT`、`OBJECT_UNAVAILABLE` | 16 |
| `services/api/src/privacy/consent-pg.ts` | `PROVIDER_UNAVAILABLE`、`SCOPE_DENIED`、`INVALID_REQUEST`、`ACCOUNT_INACTIVE`、`SESSION_EXPIRED`、`IDEMPOTENCY_CONFLICT`、`NOT_FOUND`、`REVISION_CONFLICT`、`OBJECT_UNAVAILABLE`、`PROVIDER_TIMEOUT` | 19 |
| **并集** | **14 个**（上表三份的并集） | **41** |

14 个码原样（按字典序）：

```text
ACCOUNT_INACTIVE, CONSENT_REQUIRED, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_KEY_REQUIRED,
INVALID_REQUEST, NOT_FOUND, OBJECT_UNAVAILABLE, PROVIDER_TIMEOUT, PROVIDER_UNAVAILABLE,
REVISION_CONFLICT, REVISION_REQUIRED, SCOPE_DENIED, SESSION_EXPIRED, SESSION_REQUIRED
```

### 2.2 客户端五张表实测：并集 21 个码

| 表 | 条数 | 说明 |
| --- | --- | --- |
| `MESSAGES` | 10 | 读面文案 |
| `GRANT_MESSAGES` | 15 | 授予文案 |
| `WITHDRAW_MESSAGES` | 18 | 撤回文案 |
| `GRANT_BLOCKING_CODES` | 4 | 授予置灰；4 个成员**全部**已是 `GRANT_MESSAGES` 的键 |
| `WITHDRAW_BLOCKING_CODES` | 5 | 撤回置灰；5 个成员**全部**已是 `WITHDRAW_MESSAGES` 的键 |
| **并集** | **21** | 三张文案表的并集；两个置灰数组没有引入新码 |

### 2.3 两端差在哪几条

- **服务端有、客户端表没有：1 条 —— `SESSION_EXPIRED`。**
  - 服务端点：`services/api/src/privacy/consent-pg.ts:84`、`:87`（会话行缺失/已失效时抛 401）。
  - 客户端不建词条的原因：`consent-api.js` 的 401/403 分支统一交 `utils/auth.js` 的 `failureFor()`，
    而 `attribution()` 把**所有 401** 归一为 `SESSION_REQUIRED`（`miniprogram/utils/auth.js:98-105`）；
    三张文案表只按归一后的码建。
  - 这是**真例外**，不是漏处理；登记在 `SERVER_ONLY_EXCEPTIONS`，一旦客户端补了词条，闸门会要求删掉例外。
- **客户端有、服务端扫描面没有：8 条。**
  - 纯客户端前置码 7 条：`CONFIRM_STALE`、`INVALID_INPUT`、`INVALID_RESPONSE`、`NETWORK_UNCERTAIN`、
    `NOT_GRANTED`、`SESSION_CHANGED`、`UNEXPECTED_STATUS`。
  - **`INVALID_CURSOR` 不是纯客户端码**：服务端 `privacy/signed-list-cursor.ts:61` 真的会抛，
    经 `privacy/consent-pagination.ts:53-60` 用在 `GET /me/consents` 上；只是它不在本闸门冻结的三份
    扫描面内。闸门把它登记为「扫描面外」，理由里写明服务端来源，**不**把它说成客户端自造码。
- **交集 13 条**：`ACCOUNT_INACTIVE`、`CONSENT_REQUIRED`、`IDEMPOTENCY_CONFLICT`、
  `IDEMPOTENCY_KEY_REQUIRED`、`INVALID_REQUEST`、`NOT_FOUND`、`OBJECT_UNAVAILABLE`、
  `PROVIDER_TIMEOUT`、`PROVIDER_UNAVAILABLE`、`REVISION_CONFLICT`、`REVISION_REQUIRED`、
  `SCOPE_DENIED`、`SESSION_REQUIRED`。

**结论（如实）**：今天两端**没有一条真的漏处理的授权码**。缺口不是某条码没写，而是
（a）没有机器约束防止以后漏；（b）冻结的扫描面**不覆盖**整条授权链（见 §5）。这条闸门补的是（a），
并把（b）明确登记出来，而不是假装扫描面等于全部服务端。

## 3 判据形态

新文件照抄 `tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs` 的四段式
（冻结扫描面 + 下界守卫、精确集合、白名单式例外、负控制），**不是**「至少命中 N 次」：

1. **扫描面冻结**：`SCANNED_FILES` 逐字等于三份路径；每份都 `readFileSync` 直接读，不 try/catch。
   目录写错、文件被挪走 ⇒ ENOENT 当场红。
2. **服务端码集合精确相等**：`assert.deepEqual(uniqueServerCodes(...), [...EXPECTED_SERVER_CODES].sort())`，
   并用 `assert.equal(codes.length, 14)` 钉住下界；多一个、少一个、改一个码都红。
3. **抽取形状 + 结构下界**（文件头注释逐条写清正则与理由）：
   - `api-error`：`new ApiError('CODE', …)`，`\s*` 允许跨行；
   - `api-error-ternary`：`new ApiError(cond ? 'A' : 'B', …)`，两个分支都抽（`consent-pg.ts:95-97` 的
     `PROVIDER_TIMEOUT` 只有这个形状能抽到）；
   - `error-envelope`：`{ code: 'CODE' }`，今天 0 命中，留给未来手写封套；
   - `pg-code-guard`：`code === 'CODE'`，专门覆盖 `new ApiError(code, …)` 动态透传的闭集白名单；
   - 每个文件的 `new ApiError(` 总数必须等于「直接 + 三元 + 动态」三类之和 —— 新增未覆盖写法会红，
     不会「正则失配 ⇒ 零命中 ⇒ 全绿」。实测 41 = 39 直接 + 1 三元 + 1 动态。
4. **客户端五张表逐表冻结**：表名/两空格缩进/键名任一漂移都红；空表不算通过。
5. **判据 ③（正向）**：服务端码 ⊆ 客户端并集 ∪ `SERVER_ONLY_EXCEPTIONS`；例外每条 `{code, reason, where}`，
   必须真在服务端码里、必须不在客户端表里、不许重复、字段不许缺。
6. **判据 ④（反向）**：客户端并集 ⊆ 服务端码 ∪ `CLIENT_ONLY_CODES`；白名单每条给理由，
   必须真在客户端表里、必须**不是**服务端码（服务端也抛了就该删白名单，改走例外或补客户端）。
7. **负控制**：三个纯函数 + 夹具副本，见 §6。

## 4 证明了什么

全部为本地可复跑的机器断言（`node --test tests/unit/consent-error-code-parity.test.mjs`，9/9 通过）：

1. **服务端码集合是精确的 14 个**：三份冻结文件里所有 `new ApiError` 字面量/三元分支/动态白名单
   都被抽到；新增/删除/改码会立刻红。
2. **正向覆盖**：14 个服务端码里 13 个在客户端五张表中有处理，唯一例外 `SESSION_EXPIRED` 有可核对的
   服务端点与客户端 401 归一依据；没有第二条「服务端会抛、客户端完全不知道」的码。
3. **反向覆盖**：21 个客户端码里 13 个与扫描面交集，另外 8 个逐个有理由；没有「客户端凭空处理、
   服务端从不产生、也没登记」的码。
4. **白名单不是逃生门**：例外/客户端白名单的每个成员都要双向核对（在一边、不在另一边），
   过期条目会红；服务端已有的码塞进 `CLIENT_ONLY_CODES` 会红。
5. **抽取不是「碰巧命中」**：41 个 `new ApiError(` 调用点全部被三类形状分类；任何新写法都会在
   结构下界处红，而不是静默漏抽。
6. **负控制真的会红**：三个夹具分别把判据 ③/③/④ 打红，且报错**点名**对应码（原始读数见 §6）。

## 5 没证明什么（**这一节比上一节重要**）

1. **只证明「码集合一致」，不证明运行时真的走到那些分支。** 全程只读文件文本，没有发一条请求、
   没有起服务、没有连库。某条 `throw` 是否可达、是否在真实/替身模式下被触发，本页**没有**证据。
2. **不证明文案正确。** 闸门只比对键名；`MESSAGES`/`GRANT_MESSAGES`/`WITHDRAW_MESSAGES` 的值是否
   说清了原因、是否会把 428 与 409 糊成一句、是否误导用户，一律没判。
3. **不证明真机交互。** 没有微信编译器、没有真机、没有截图；错误码最终有没有显示在页面上、
   按钮有没有按 `*_BLOCKING_CODES` 正确置灰，属页面层证据，本页不覆盖。
4. **不证明扫描面 = 整条授权链。** 冻结的三份只是路由 + 授予落库 + 撤回/清单服务；至少还有
   `services/api/src/auth/middleware.ts`（401/403 守卫）、`services/api/src/privacy/consent-pagination.ts`
   （`INVALID_REQUEST`/`PROVIDER_UNAVAILABLE`）、`services/api/src/privacy/signed-list-cursor.ts`
   （`INVALID_CURSOR`）在面外。`INVALID_CURSOR` 就是被这条边界挡在外面、只能登记为
   `CLIENT_ONLY_CODES` 的实例。
5. **不证明「每个端点各自一致」。** 判据用的是三张文案表的**并集**：某码只在 `GRANT_MESSAGES` 里、
   却由撤回面抛出，仍会通过。要证明逐端点一致，需要按 `grant`/`withdraw`/`list` 分别建集合，
   本片没做。
6. **不证明码属于契约 `ERROR_CODES`。** 闸门只判两端同集合，不判「这个码是否在
   `services/api/src/contract.ts` 的契约闭集里」、也不判 HTTP 状态映射；契约闭集与状态映射由
   `contract.ts` 和既有 `contract-tests` 负责，本闸门不重复判。
7. **不证明客户端白名单永远完备。** 新加一个客户端前置码会红，但「这个理由是否成立」仍需人工审查；
   闸门只能强制它被写下来，不能判断写得对不对。

## 6 闸门读数与负控制读数

### 6.1 四条自检命令（原始读数）

```text
$ node --test tests/unit/consent-error-code-parity.test.mjs
✔ 扫描面是冻结的三份服务端文件，且每份都真实存在非空（下界守卫）
✔ 服务端授权错误码是精确的 14 个（多一个 / 少一个 / 改一个码都红）
✔ 每个 new ApiError(...) 调用点都被抽取形状覆盖（新写法不会静默漏抽）
✔ 客户端五张表可解析，且逐表与冻结清单相等（删键/加键/改名都红）
✔ 判据 ③：服务端码 ⊆ 客户端处理集合 ∪ 已登记的 SERVER_ONLY_EXCEPTIONS
✔ 判据 ④：客户端码 ⊆ 服务端码 ∪ CLIENT_ONLY_CODES（白名单每条都必须成立）
✔ 负控制 ①：往服务端码里塞假码 ⇒ 判据 ③ 必须点名它
✔ 负控制 ②：删掉 WITHDRAW_MESSAGES 的 REVISION_REQUIRED 键 ⇒ 判据 ③ 必须点名它
✔ 负控制 ③：往 CLIENT_ONLY_CODES 塞服务端真有的 NOT_FOUND ⇒ 判据 ④ 必须红
ℹ tests 9
ℹ pass 9
ℹ fail 0
EXIT=0
```

```text
$ node --test tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs
✔ 扫描面是冻结的 6 个文件，且每个都真实存在（下界守卫）
✔ 账本 error_code 的写入点是精确的已知集合（多一处 / 少一处 / 改一个码都红）
✔ 写入点用到的码必须属于契约 ERROR_CODES，例外只能来自已登记例外表
✔ 改掉的那两处（受理失败释放预留）用的是契约码 OBJECT_UNAVAILABLE，不是自造码
ℹ tests 4
ℹ pass 4
ℹ fail 0
EXIT=0
```

`node tools/verify-doc-anchors.mjs --strict` 与 `node tools/check-wechat-project.mjs` 的读数见 §6.3。

### 6.2 负控制（仓库外临时副本，实跑打红后还原）

三处打红都是把**测试里的调用参数**换成夹具，产品代码与客户端表一行未动；跑完从备份还原，
复跑 9/9 全绿。

| # | 夹具 | 期望 | 实测（原始断言行） | 退出码 |
| --- | --- | --- | --- | --- |
| ① | 判据 ③ 的服务端码尾部追加 `TOTALLY_FAKE_CODE` | 判据 ③ 点名它 | `服务端会抛、客户端五张表都不处理、也没登记例外的授权码：TOTALLY_FAKE_CODE`（`actual: ['TOTALLY_FAKE_CODE']`） | 1 |
| ② | 判据 ③ 的客户端并集删掉 `REVISION_REQUIRED`（选它是因为它只出现在 `WITHDRAW_MESSAGES`，删一个键就真的离开处理集合；`NOT_FOUND` 同时是 `WITHDRAW_BLOCKING_CODES` 成员，删文案键不会离开集合） | 判据 ③ 点名它 | `服务端会抛、客户端五张表都不处理、也没登记例外的授权码：REVISION_REQUIRED`（`actual: ['REVISION_REQUIRED']`） | 1 |
| ③ | 判据 ④ 的 `CLIENT_ONLY_CODES` 追加服务端真码 `NOT_FOUND` | 判据 ④ 点名它 | `NOT_FOUND：它是服务端码，不得登记为 CLIENT_ONLY_CODES（走判据 ③ 或补客户端表）` | 1 |

还原后复跑：`tests 9 / pass 9 / fail 0`，`EXIT=0`（见 §6.1 第一段）。

### 6.3 文档锚点与小程序工程检查

```text
$ node tools/verify-doc-anchors.mjs --strict
SCAN: 文档 340 份；抽出「路径:行号」引用 6775 条（解析成功 6540 条、同名多文件无法唯一解析 225 条不计红、同文档重复 18 条已去重）
COUNT: BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 46 / NOT_SYMBOL_LINE 9（合计 61 条；另只计数不判红：区间首行为空行 169 条、区间全是注释行 1086 条）
BASELINE: tools/doc-anchors-baseline.json 登记 61 条；本次命中 61 条、基线外新增 0 条、陈旧 0 条
ANCHOR-COUNT: 进判据锚点 6893 条 / 244 份文档——清册 tools/doc-anchors-anchor-count-baseline.json 登记 6287 条 / 227 份；本次计数下降的文档 0 份、上升 33 份、面外未扫的键 0 个、面内本次未扫 8 个（清册面内、本次面外：合法跳过）、面内却扫不到的键 0 个、永远扫不到的键 0 个
PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN）
EXIT=0

$ node tools/check-wechat-project.mjs
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
EXIT=0
```

## 7 复跑命令

```text
node --test tests/unit/consent-error-code-parity.test.mjs
node --test tests/unit/privacy-egress-ledger-error-code-closed-set.test.mjs
node tools/verify-doc-anchors.mjs --strict
node tools/check-wechat-project.mjs
```

改服务端三份文件、改客户端五张表、或改测试里的冻结清单时，四条都要重跑；前两条任一红都**不许**
靠改小数字或删例外换绿，先判断是「码漂移」还是「抽取形状失效」。

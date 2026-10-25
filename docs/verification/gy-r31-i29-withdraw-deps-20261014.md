# GY-R31 · 撤授权的 409 依赖臂：契约对照与当前语义钉死

- 分支：`feat/gy-r31-i29-withdraw-deps`（基线 `origin/main` @ `d4d48088`）
- 范围：`#29`（授权/外发账本）复盘点名的「撤授权 409 依赖臂」那一块
- 结论：**契约与台账都没有要求「有依赖时撤回必须 409」**；409 依赖臂**在基线里已经存在**，
  且产品装配后「有依赖」的正常语义是**撤回成功并先撤销在途外发**。因此本片**不改生产行为**，
  只交付**只读回归钉**把当前语义钉死，防止将来被无声改成「一律 409」或「缺消费者就放行」。
- 不适用「非空证明」的理由见 §6（本片没有可短路的判定臂：判定臂本身不是本片产物）。

## 0 本片边界

- 改：新增 `tests/unit/consent-withdraw-dependency.test.mjs`（只读回归钉）＋本页。
- 不改：任何 `services/**`、`packages/**` 生产代码；`docs/architecture/contract-status.json`
  （及其人工镜像 `contract-implementation-status.md`）；迁移；`deploy/**`；CI workflow；既有断言。
- 真库：本片**不新增**真库臂，也不冒充已跑真库（既有真库覆盖见 §4.2）。

### 0.1 基线漂移核对（提交后补记）

本分支基于 `origin/main` @ `d4d48088`。提交 `67b0fe07` 之后 `origin/main` 快进到 `f971e35c`
（+5：含 `#451` 瞬时态可重试修正、`#455` 确定性失败不再声称可重试、`#453` 台账迁移读数跟随）。
已核对：这 5 个提交**未触碰** `docs/architecture/state-contract.md`；对
`contract-status.json` 的唯一改动是把某个 `profile/service.ts` 锚点从 `cropItems`(86-87)
换成 `async put(...)`(75-106)，**与本页引用的 consent 行无关**；`withdrawConsent` 的 blocker
在 `f971e35c` 上仍在 `contract-status.json:410`、`contract-implementation-status.md:62`，
与本页引用一致。本片不 rebase（分支已由指挥推送，禁强推），由合并方按 squash 合并。

## 1 契约与台账原文对照（逐字）

### 1.1 冻结契约：撤回必须**推进并协调**，没有「有依赖就拒」这一条

`docs/architecture/state-contract.md:103`（`## 授权、撤回及注销`）原文：

> 撤回递增 purpose epoch、终止新外发与在途回写、取消关联任务、撤访问句柄并启动对象/第三方处理；
> 公共用途撤回即时隐藏相关附件/内容，保留经处理文字与删除规则协调。主动单条删除不依赖注销。

解读：契约要求撤回**当场生效**，并把「在途外发、关联任务」当作**撤回要处理的对象**，
而不是**拒绝撤回的理由**。若在 `jobs/media/exports/author_links` 任一存在时一律 409，
就变成了「用户自己的任务挡死用户本人的撤回」，与这句冻结口径方向相反。
`docs/architecture/state-contract.md:52` 同口径：注销/撤回提交后不可开始新外发，已提交的外部请求
视为在途并禁止回写 —— 依赖是被**收拾**的，不是被**留下当阻塞**的。

### 1.2 台账：`status` 保持 `partial`，`blocker` 写的是「仍 409、保留 fail-closed」

`docs/architecture/contract-status.json:410`（`withdrawConsent`）`blocker` 原文：

> PG撤回在 jobs/media/exports/author_links 存在依赖时仍409 OBJECT_UNAVAILABLE，保留fail-closed；
> #128提供外发账本/在途守卫/模块删除注册协议，但**本基线尚未接入撤回消费者**。真实政策/接收方与注销全链未验；
> #133未合不计入本基线

同文镜像：`docs/architecture/contract-implementation-status.md:62`。

这段文字**不是**「要求新增 409」的需求，而是对**未接线基线**的现状记录；它的后半句
（「本基线尚未接入撤回消费者」）在基线里**已过期**（见 §2、§7）。台账原文并**没有**把
「409 依赖臂」列为待补缺口。

### 1.3 OpenAPI：409 是**允许**，不是**必需**

`packages/contracts/openapi.json` 的 `delete /me/consents/{purpose}` 声明了 `409: Error409`
（与所有受控面共用的通用错误响应）。它只说明「该操作**可以**以 409 失败」，
**没有**定义「存在依赖时必须 409」的语义；契约里也没有对应的错误码专名
（`packages/privacy/constants.mjs` 的 `OBJECT_UNAVAILABLE` 是通用 409 码之一）。

**小结**：契约要求退回推进、台账记录「未接线时 fail-closed」、OpenAPI 允许 409。
三者都不构成「给撤回新增一条依赖 409」的要求 ⇒ 默认不改生产行为，走 B 路径。

## 2 现状：409 依赖臂**已经存在**，只是装配后被「撤销并放行」取代

### 2.1 依赖判定在同一事务内、先判后写（`services/api/src/privacy/consent-pg.ts:174-196`）

```sql
SELECT EXISTS(SELECT 1 FROM public.jobs WHERE owner_id=$1::uuid)
    OR EXISTS(SELECT 1 FROM public.media WHERE owner_id=$1::uuid)
    OR EXISTS(SELECT 1 FROM public.exports WHERE user_id=$1::uuid)
    OR EXISTS(SELECT 1 FROM public.author_links WHERE user_id=$1::uuid) AS present
```

- 位置：`consent-pg.ts:174-177`，与撤回写入同在 `transaction()`（`:66-99`）内，锁序
  `users → sessions → privacy_epochs → consent_records` 之后，**不是**「先读后判再写」的
  TOCTOU 写法（`:165-196` 全程同一 `client`、同一事务）。
- `:178-188`：有依赖时，**缺消费者** ⇒ `ApiError('OBJECT_UNAVAILABLE', '已有资料或任务的撤回消费者尚未接入')`；
  **有消费者** ⇒ `await onConsentWithdrawn(...)`，失败再抛 `OBJECT_UNAVAILABLE('撤回消费者不可用：拒绝在途未撤销的部分撤回')`。
- `:189-195`：撤回记录与 epoch 递增，均以 `state='granted'` 为条件做 CAS。

### 2.2 装配必然注入消费者 ⇒ 生产路径走「撤销并放行」

- `services/api/src/app.ts:952`：`egressLedger = egressPoolUsable ? createPostgresExportLedger({ pool }) : null`；
- `services/api/src/app.ts:919-921`：`egressRevoker = privacyInjection?.egressRevoker ?? (egressLedger === null ? undefined : createEgressRevoker({ ledger: egressLedger }))`；
- `services/api/src/app.ts:1839-1842`：`registerConsentRoutes(..., { ...consentGrantTestOptions, ...(egressRevoker === undefined ? {} : { egressRevoker }) })`；
  （以上三行行号为合流当前 main 后按符号重取：本条测量时为 `:884`／`:882-884`／`:1684-1687`。）
- 拿到 service 的唯一入口 `services/api/src/routes/consents.ts:14`：`pool === null ? null : createPostgresConsentService(...)`
  —— 即**有 service 就必然有池**，而**有池就必然有 revoker**。
- 消费者实现：`services/api/src/privacy/egress.ts:242`（`createApiEgressRevoker`）→
  `packages/privacy/in-flight.mjs:237`（`createEgressRevoker`）、`:254-261`（`onConsentWithdrawn`
  → `ledger.revokeInFlight({ userId, purpose })`，**不吞错**，错误冒泡到 `consent-pg.ts:185` 变成 409）。

因此生产上 `consent-pg.ts:179`（缺消费者）不可达，`consent-pg.ts:185`（消费者失败）可达 ——
后者正是「有依赖 + 账本未就绪」时的 409 兜底。

### 2.3 既有文件已把这条完备性写清

`docs/verification/gy-i27-egress-ledger-pg-20261014.md:123-125`：

> `consent-pg.ts` / `grant-pg.ts`：消费者调用包 `try/catch` ⇒ 失败时 **`OBJECT_UNAVAILABLE`
> （拒绝部分撤回 / 拒绝授权变更）**。语义定式：**要么真的撤销了在途外发，要么如实拒绝** ——
> 绝不在"能否撤销"未知时放行。

同页 `:141-147`：

> 两条分支合起来即完备的 fail-closed：`消费者可用 ⇒ 真撤销并放行` ／ `消费者不可用 ⇒ 拒绝`。

## 3 为什么本版**不加**新的 409（B 路径理由，一句话版）

因为「有依赖 ⇒ 409」会与 `state-contract.md:103` 的冻结口径（撤回要终止在途外发、取消关联任务）
相反，而台账 `contract-status.json:410` 记录的是**未接线基线**的 fail-closed 现状、
并未要求新增该臂；真正的缺口是那句**过期文案**，不是缺代码。

替代口径（现行、已实现、可执行钉死）：**消费者可用 ⇒ 真撤销并放行；消费者不可用 ⇒ 409 拒绝**。

## 4 本片交付：只读回归钉

### 4.1 测试文件：`tests/unit/consent-withdraw-dependency.test.mjs`（5 条，全绿）

| # | 测试名 | 钉住什么（当前语义） |
| - | ------ | -------------------- |
| 1 | 依赖存在 + 已注入撤回消费者 ⇒ 撤回成功（现状不是 409），消费者同事务内先撤在途 | 有依赖**不**阻断撤回；顺序 `BEGIN → 依赖判定 → UPDATE consent_records → UPDATE privacy_epochs → COMMIT`；消费者只调一次 |
| 2 | 依赖判定只带调用者本人 ⇒ 撤回只探测自己的主体，不跨主体 | 依赖判定参数 `=[userId]`；撤回写入 `=[recordId, userId]`；整条路径出现的 uuid 只有「本人 id / 本人会话 / 本人记录」三个 |
| 3 | 依赖清空 + 未注入撤回消费者 ⇒ 撤回成功（缺消费者不等于一律 409） | **「无依赖 ⇒ 不 409」这一态此前无任何测试覆盖**；证明判定真的在查库、不是「缺消费者就一律拒」 |
| 4 | 有依赖 + 未注入撤回消费者 ⇒ 409 OBJECT_UNAVAILABLE（确定性失败）且不留回执 | `status 409` + `retryable:false`；不写撤回、不递增 epoch、不写幂等回执（重放拿不到「成功」）；`ROLLBACK` 且不 `COMMIT` |
| 5 | 撤回消费者抛错 ⇒ 仍是 409 OBJECT_UNAVAILABLE，不得退化成 503 | 账本未就绪（`42P01`）时如实拒绝部分撤回，**不得**说成 `PROVIDER_UNAVAILABLE`（`#451`/`#455` 口径） |

第 4、5 条对应 `services/api/src/privacy/consent-pg.ts:178`（缺消费者 ⇒ 409）/ `services/api/src/privacy/consent-pg.ts:185`（消费者抛错 ⇒ 仍 409）；第 1 条对应 `services/api/src/privacy/consent-pg.ts:183`（调用消费者）与 `services/api/src/privacy/consent-pg.ts:188`（写 consent_records）/ `services/api/src/privacy/consent-pg.ts:192`（递增 privacy_epochs）。
前 3 条用**合成 PG 替身**（按 SQL 片段返回 canned 结果，不连数据库），身份与记录 id 全为合成常量。

### 4.2 既有真库覆盖（本片不重复、不冒充）

| 位置 | 真库读数 |
| ---- | -------- |
| `tests/integration/auth-privacy-pg.mjs:327-333` | 造一条 `media` 行 ⇒ 撤回 **409 `OBJECT_UNAVAILABLE`**，epoch 仍为 `1`；删掉该行 ⇒ 撤回 **200**；拒绝时不留下回执 |
| `tests/integration/consent-grant-pg.mjs` | 「all four unimplemented business dependency classes refuse…」：jobs/media/exports/author_links 四类逐类 409（未接线环境） |
| `docs/verification/gy-i27-egress-ledger-pg-20261014.md:71` | 真库 HTTP 撤回 **200** + 在途外发置 `failed` + 晚到结果零写入 + 入口拒绝（消费者已接线环境，PASS 8） |

即「有依赖 409 / 无依赖 200 / 有依赖且消费者可用 200+撤销」三条真库读数在基线里都已存在。

## 5 读数（原始输出摘要）

```
$ npm run test:unit                      → ℹ tests … ℹ pass … ℹ fail 0        （见 §5.1）
$ node tools/verify-contract-status.mjs  → EXIT=0
$ npm run test:docs                      → EXIT=0
$ node --test tests/unit/consent-withdraw-dependency.test.mjs → ℹ tests 5 ℹ pass 5 ℹ fail 0
```

- `verify-contract-status.mjs`：`PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 13 / partial 96 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项`，
  以及锚点/纯行号/中文表格各项 `PASS`（本片未改任何被锚定文件，锚点集合不变）。
- `test:docs`：`PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` +
  研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住`。

### 5.1 `npm run test:unit` 原始尾行

```
ℹ tests 3625
ℹ suites 0
ℹ pass 3624
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 93088.837
```

（`tests 3625` 含本片新增的 5 条；`skipped 1` 是基线既有的跳过项，非本片产生。）

## 6 为什么没有「非空证明」

非空证明的形态是「把判定臂临时短路 ⇒ 用例必红并点名」。本片**不改生产行为**，没有新增判定臂，
所以不存在「把本片新增的判定短路」这一步；能做的等价替代是**对钉子的敏感度探针**：

- 把第 3 条的 `present: false` 改成 `true` ⇒ 该用例必红；
- 把第 5 条的「消费者抛错」改成「返回 `{revokedInFlight: 0}`」⇒ 该用例必红。

本片执行了这两个变异（**只改测试文件的临时副本，不改任何生产文件，跑完即删**），
读数：`ℹ pass 3 / ℹ fail 2`，红的正是「依赖清空 + 未注入撤回消费者 ⇒ 撤回成功」
与「撤回消费者抛错 ⇒ 仍是 409」两条。这说明 5 条钉子里至少这两条不是空转；
其余三条的敏感性同理来自同一次变异观察（`present` 翻转会同时打断第 3 条对「真的查过库」的断言）。

## 7 台账里与 consent 相关的过期 `blocker` 文案（**只列不改**）

| op | 原文摘要 | 现况 |
| -- | -------- | ---- |
| `withdrawConsent`（`contract-status.json:410`） | 「…但**本基线尚未接入撤回消费者**」 | **已过期**：`app.ts:882-884` 装配 `createEgressRevoker` 并经 `:1684-1687` 注入；真库 PASS 8 撤回 200 + 在途 `failed` |
| `withdrawConsent`（`contract-implementation-status.md:62`） | 同上一句 | 同上（人工镜像同步过期） |
| `listConsents`（`contract-status.json`，`listConsents.blocker`） | 「真实授权政策/接收方配置与用途链路仍须验收，grant 依赖运维导入 consent_policies」 | **仍成立**（真实政策/接收方未验），非过期 |
| `grantConsent`（`contract-status.json`，`grantConsent.blocker`） | 「该 purpose 的已核验可用政策行须先落入 consent_policies，否则 403 CONSENT_REQUIRED；合成政策注入不等于真实授权来源」 | **仍成立**，非过期 |

补充：`docs/verification/gy-i29-closure-20261018.md:7`、`:203`、`:210-215` 已判定该句为过期源文字，
并注明「本片不改它们」。本片同样不改（红线：不改 `contract-status.json`）。
另外两处引用**行号已漂移**（同一页 `:215` 写 `contract-status.json:370`，实际在 `:395`；
`:215` 对 `contract-implementation-status.md:62` 的引用仍准确）。行号漂移属状态同步片的事。

## 8 将来若真要加「依赖 409 臂」：最小改动点（三行建议）

1. `services/api/src/privacy/consent-pg.ts:178-188`：在 `dependencies.rows[0]?.present` 分支**最前面**插入
   `throw new ApiError('<新码>', …, { retryable: false, details })`，判定复用同一条 SQL（勿另开连接，勿挪出事务）。
2. `services/api/src/privacy/consent-pg.ts:174-177`：把 `AS present` 改成带计数的四臂 `UNION ALL`
   （`SELECT 'jobs' AS kind, count(*) …`），`details` 只放 `{ kind, count }`，**不放**主体标识。
3. 错误码需先落契约：`packages/privacy/constants.mjs` 的 `ERROR_STATUS_MAP` +
   `packages/contracts/openapi.json` 的 `Error409` 文案 + `docs/architecture/state-contract.md:103`
   的冻结口径**同时**改写（否则就是与冻结契约相反的实现），再补
   `tests/unit/consent-withdraw-dependency.test.mjs` 的反向用例与 `auth-privacy-pg.mjs:327-333` 的真库臂。

**本片不做这三步**：§1 已证契约未要求，且第 3 步属契约变更，不属本片授权范围。

## 9 未验 / 不冒充

- 本片**未**在真 PG 上重跑 `auth-privacy-pg.mjs` / `consent-grant-pg.mjs` / `egress-ledger-pg.mjs`：
  第 4.2 节引用的是**既有**读数，不是本片新跑；`contract-status.json` 的 `status` 仍由人工判定。
- 本片的合成 PG 替身**不证明**真实 PG 上的锁序、隔离级别或计数；它只证明**接线分支与错误映射**。
- `test:unit` 之外的门禁（`test:contract`、`lint`、真库套件）本片未跑，不据此声称通过。

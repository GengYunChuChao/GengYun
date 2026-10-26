# GY-R28-W3 · TTS「已核对内容」端口接线（`checked_content` → 真实实现）

- 分支：`feat/gy-r28-w3-tts-content-port`（worktree `E:\GengYunCommander\wt-w3-tts-content`）
- 基点：`f5cca8b`（`git log -1 --oneline` 复核）
- 性质：**接线 + 单测 + 回环 HTTP 读数**，零付费、零新增外呼。
- **口径声明**：本文档**不宣布验收通过**，**不声称** TTS 在 `real` 下"端到端可用"。
  本文档区分三件不同的事：①**核对端口已接真实现**（本节 §2，可由代码与单测直接核验）；
  ②**核对闸的真判读数**（§3–§4，注入式只读查询替身 + 真实 HTTP 回环）；
  ③**产品默认装配下的 `real` 可达性**（§5，仍然停在 503/409，**不因本次改动而改变**）。
- **零付费声明**：本轮**未向任何供应商发出任何请求**，`TENCENTCLOUD_*` 凭据未被读取、
  未被使用，累计费用 **¥0.00**。派单预留的「≤2 次受控真实调用」**未动用**（理由见 §4.2）。

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| `checked_content` 是内容安全审核，还是页面内容版本核对？ | **两者都有，且还多两件**：归属 + 已核对正文。它是**服务端对该目标当前状态的读取**（快照四件套），**不是**一条独立的内容安全接口，合成期**不做**任何内容安全外呼。依据见 §1 |
| 端口现在接的是什么？ | PostgreSQL **只读**查询：`answer` → `public.conversation_answers`；`species`/`herbicide`/`scheme`/`static_region` → `catalog_read.current_knowledge`；`dose_card` 无来源 ⇒ 如实 404 |
| 未配置时行为变了吗？ | **没变，逐字节一致**：非 `real` 仍走替身端口；`real` 且无连接池仍走**同一个** `createUnwiredCheckedContentPort()`（同一句原因文本）⇒ 仍 fail-closed |
| `real` 下能走到 200 吗？ | **不能**，且在**本分支**连 202 都到不了：产品装配下 `real` 在提供者闸就 503（`services/api/src/tts/service.ts:471`），内容闸（`:480`）尚未到达。核对闸本身的真判已可跑通（§4.1 读数） |
| 与 W2（媒体端口）还有依赖吗？ | **有**，`services/api/src/tts/service.ts:475-478`：`media.kind === 'unwired'` ⇒ 409，**先于**内容闸 `:480`。细节见 §5 |

---

## 1. `checked_content` 的**真实语义**（按代码判，不按名字猜）

### 1.1 契约只给了一个三元组

- `packages/contracts/openapi.json:13514-13544` — `SynthesisTarget`：
  `{ type: SynthesisTargetType（闭集）, id: string(1..80), revision: integer >= 1 }`。
- `packages/contracts/openapi.json:13549-13550` — `checked_content_ref: { $ref: SynthesisTarget }`。
- `packages/contracts/openapi.json:13938-13941` — `checked_content_ref` 是 **required**，与 `locale` 并列。
- `services/api/src/tts/content.ts:4-6` — 本域头注：「本域**不接受**任何自由文本入参：`SynthesisInput`
  只有一个 `checked_content_ref`，因此服务端必须自己把「这个目标当前是否经核对通过、当前 revision
  是多少、正文是什么」读出来」。

⇒ 契约层面 `checked_content_ref` **既不是**一份审核结论对象，**也不是**一份正文；它只是一个
「指向某目标的某版本」的引用。**语义必须由服务端把目标当前状态读出来补全**。

### 1.2 端口形状证明「四件套同时在」

`services/api/src/tts/state.ts:267-278`（`CheckedContentSnapshot`）逐字段就是答案：

| 字段 | 语义 | 属于哪一维 |
| --- | --- | --- |
| `revision: number` | 内容**当前** revision，与调用方传入的 `revision` 比对 | **页面内容版本核对** |
| `auditState: unknown` | 核对状态（`AuditState` 闭集：`pending`/`approved`/`rejected`/`quarantined`，见 `state.ts:89`） | **内容安全审核结论** |
| `ownerUserId: string \| null` | `null` = 平台/运营公共内容；非 null = 该账号私有内容 | **归属**（越权引用必须拒绝） |
| `text: unknown` | 已核对正文；只有 `approved` 且可取时才可能非空 | **朗读正文** |

判定顺序也是刻意写死的：`services/api/src/tts/state.ts:335-378` —— 存在性 → 归属 → 目标一致
→ 核对状态（`:351-363`）→ revision（`:369`）→ 正文（`:372`）。文件头注释 `state.ts:332-333`
说明了为什么**核对状态先于版本判定**：「若反过来，攻击面就是『改一个 revision 数字让未核对内容
走完版本检查』」。

### 1.3 关键判定：合成期**不做**内容安全外呼

- `services/api/src/ai/checked-content-live-adapter.ts:13-14`：「⛔ 合成期**不做**内容安全外呼：
  这里是只读查询，不调审核 API、不写库、不改核对状态。「未通过核对」的结论来自**离线**已经落库的
  审核结果，不是这里现算的。」
- 佐证：`services/api/src/tts/*.ts` 与 `services/api/src/ai/*.ts` 全文检索
  `moderat|content.?safety|审核`，除注释外**零命中调用点**。
- 因此派单第 3 条（腾讯云内容安全受控调用）**在本片上不存在合法调用点**——不是省了预算，
  而是**硬接上去就是错的语义**（会把「离线审核结论」变成「合成期现算」，并给每一次 TTS 受理
  引入一次付费外呼与一条 egress 账）。

**判定（也是本轮唯一正确的读法）**：`checked_content` = 「这个目标在**当前版本**上
**已通过审核**、**属于你**、**有可朗读正文**」的**服务端读取 + 判定**，四者缺一即拒绝。
「内容安全」在此表现为**已落库的审核结论**（`conversation_answers.check_state`、
`catalog_read` 读面的准入），不是外呼。

### 1.4 两个真实来源，逐个说清

| `SynthesisTarget.type` | 真实来源 | 核对状态怎么来 |
| --- | --- | --- |
| `answer` | `public.conversation_answers`（`services/api/db/migrations/0013_conversations.sql:103-123`；`check_state` 列见 `:110`，`checked_text` 列见 `:109`） | `check_state='passed'` ⇒ `approved`；`'blocked'` ⇒ `rejected`；**其它取值原样透出**（判定层按「取不到核对状态」拒绝，绝不规整成 approved） |
| `species`/`herbicide`/`scheme`/`static_region` | `catalog_read.current_knowledge`（`services/api/db/migrations/0010_knowledge_read_views.sql:3-30`（原记 `:3-34`）；来源版本须 `review_status='verified'`，见 `0002_knowledge_catalog.sql:214`） | **行存在即 `approved`**：该视图的 `WHERE` 强制 `visibility='published'` + 每 `knowledge_id` 仅最新 revision，未核对/未发布的知识**不在视图里** ⇒ 查不到行 ⇒ 404（fail-closed 的自然形状） |
| `dose_card` | **没有**可核验来源 | 库内无逐卡核对结论，生产口径 `dose_cards` 恒为 `[]`（`services/api/src/ocr/reference.ts` 两处组装）⇒ 端口返回 `null` ⇒ 404，**不**从别处拼一张卡冒充 |

**如实登记的残留口径差异**：知识读面**没有**逐行 `AuditState` 列，`pending`/`quarantined`
在该读面上**不可表达**（其表现是「查不到行 ⇒ 404」而不是「409 AUDIT_PENDING」）。
这是收窄而非放宽：未核对内容在任何分支都拿不到放行。

---

## 2. 接线实现（新增 + 装配）

### 2.1 新增文件（`services/api/src/ai/**`，与 W1 的 `ocr-live-*`/`asr-live-*` 同目录同形状）

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `services/api/src/ai/checked-content-live-ports.ts` | 97 | 端口协议层：`CheckedContentQueryable`（只要求 `query(text, values)`）、`CheckedContentRow`、`CheckedContentSource`（`kind:'wired'`）、`RealCheckedContentPorts`、`KNOWLEDGE_CONTENT_TYPES` + `isKnowledgeContentType`、`isCheckedContentRow`、`CheckedContentWiringError`、`createUnwiredCheckedContentSource` |
| `services/api/src/ai/checked-content-live-adapter.ts` | 219 | 真实实现：`auditStateFromCheckState`、`createSqlCheckedContentSource(pool)`、`createLiveCheckedContentPort(ports)`、装配入口 `createCheckedContentPortFromConfig({executionMode, entries, pool})` |

两条 SQL（均**参数化**、均 `select`、均 `limit 1`）：

```
select revision, check_state, owner_id, checked_text from public.conversation_answers where id = $1::uuid limit 1
select revision, title, body from catalog_read.current_knowledge where id = $1::uuid and type = $2 limit 1
```

第二句的 `and type = $2` 是**跨类型冒用**的闸门：拿 `scheme` 的 id 当 `herbicide` 播报 ⇒
查不到行 ⇒ 404，绝不用「同 id 的别的内容」顶替。

### 2.2 装配（`services/api/src/app.ts`，只改**一处调用 + import + 注释**）

```ts
// 改前：synthesisContent ?? createCheckedContentPort(config.executionMode, SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT);
const synthesisContentResolved =
  synthesisContent ?? createCheckedContentPortFromConfig({ executionMode: config.executionMode, entries: SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT, pool });
```

- `createCheckedContentPort`（替身/未接线工厂）**逐字未动**，仍在 `services/api/src/tts/content.ts`。
- `tts/content.ts` 仅一处分型扩展：`CheckedContentPort.kind: 'substitute' | 'unwired' | 'wired'`
  （加 `'wired'` **只放宽了类型枚举**，不放宽任何断言；既有断言见 §7.2）。

### 2.3 「未配置 ⇒ 与现 main 逐字节一致」的三分支

| 分支 | 取值 | 与接线前的关系 |
| --- | --- | --- |
| `executionMode !== 'real'` | `createMemoryCheckedContentPort(entries)` | **同一函数、同一行为**（`stub`/`preset_demo` 的替身条目仍生效） |
| `real` 且 `pool === null/undefined`（未配 `DATABASE_URL`／未建池） | `createUnwiredCheckedContentPort()` | **同一个端口、同一条原因文本** ⇒ 仍 fail-closed |
| `real` 且 `pool !== null` | 真实只读端口（本文件 §2.1） | 新能力，仅此一支 |

第二条由单测 `W3-01` 直接断言：`kind` 与 `note` 与接线前**逐字相同**（不是"看起来一样"，
是 `assert.equal(kind)` + `assert.equal(note)` 字符串相等）。

### 2.4 只读性

`W3-07` 断言：适配器发出的**全部** SQL 只含 `select`，不含 `insert`/`update`/`delete`/`for update`。
端口不写库、不改核对状态、不落任何账（因为它不产生外部调用）。

---

## 3. 负控制（每条一个独立用例，码当场读出）

### 3.1 单测层（`tests/unit/tts-checked-content-wiring.test.mjs`，18 例全绿）

| 用例 | 情形 | 期望与实测 |
| --- | --- | --- |
| W3-01 | `real` + 无连接池 | 仍是 `unwired`，`note` 与接线前逐字相同 |
| W3-02 | `real` + 无池 + 注入了替身条目 | **不采用**替身（受理前拒绝，不是"退回替身"） |
| W3-03 | 替身/演示模式 | 仍是 substitute，且**零查询** |
| W3-04 | 构造期：查询端口缺失/形状不符 | `CheckedContentWiringError`（fail-closed） |
| W3-05 | `answer` 已核对行 | `approved` + 当前 revision + 正文 ⇒ 放行 |
| W3-06 | 知识行 | `catalog_read.current_knowledge`，`type` 进 WHERE，正文 = 标题 + `\n` + 正文 |
| W3-07 | 只读性 | 全部 SQL 只有 `select` |
| **W3-08** | **内容未核对（`check_state='pending'`）** | **422 `INPUT_UNCERTAIN`（`AUDIT_PENDING`），不放行** |
| W3-09 | 已驳回（`check_state='blocked'`） | 409 `OBJECT_UNAVAILABLE`（`AUDIT_REJECTED`） |
| W3-10 | 库内出现契约外核对状态 | 原样透出 ⇒ 409（`AUDIT_STATE_UNREADABLE`，绝不规整成 approved） |
| **W3-11** | **版本不一致（库内 4，请求 3）** | **409 `REVISION_CONFLICT`，不复用旧审核** |
| W3-12 | 跨账号引用（他人回答） | 404 `NOT_FOUND`，与不存在**同形** |
| **W3-13** | **跨页/跨类型引用**（知识 id 当 answer、回答 id 当 scheme） | **404 `NOT_FOUND`**，不拿别的内容顶替 |
| W3-14 | 未核对/未发布的知识 | 视图里查不到行 ⇒ 404（不是"按已核对放行"） |
| W3-15 | 核对通过但无正文 | 409 `OBJECT_UNAVAILABLE`（`CONTENT_UNREADABLE`，**绝不念空串**） |
| W3-16 | **凭据/连接缺失导致查询抛错** | **409 `OBJECT_UNAVAILABLE`（绝不当成 approved）** |
| W3-17 | `dose_card` 无来源 | 404，且**不发起查询** |
| W3-18 | 非 uuid 标识 | 404，且**不查库**（不把 22P02 误当成 409） |

### 3.2 HTTP 回环层（`tests/integration/tts-content-wiring.mjs`，8 例全绿）

真实 `buildApp` + 真实路由 + 真实服务层，`synthesisStore` 用内存实现，核对源用
**注入式只读查询替身**（`query(text, values)` 记录每次调用；按 `id` 严格命中，模拟 `where id = $1`）。

| 读数 | 情形 | 实测 |
| --- | --- | --- |
| R00 | `real` + 产品默认提供者（无凭据） | **503 `PROVIDER_UNAVAILABLE`**；核对源查询 **0 次**（核对闸根本没被走到） |
| R01 | `real` + 真实核对源（`answer` 已核对，revision 3） | **202** → `GET /jobs/{id}` **200**（`state=succeeded`）；核对源被读 **2 次**（受理闸 `accept` + 执行前复核 `execute`，见 `service.ts:480`/`:575`），每次 `values=[id]`、id 未拼进 SQL 文本 |
| **R02** | **未核对（`check_state='pending'`）** | **422 `INPUT_UNCERTAIN`（`AUDIT_PENDING`）**，不建任务 |
| **R03** | **版本不一致（库内 4，请求 3）** | **409 `REVISION_CONFLICT`（`REVISION_MISMATCH`）** |
| **R04** | **跨页/跨类型（知识 id 当 answer）** | **404**，且响应体与「不存在」**逐字相同**（不泄露存在性） |
| R05 | 跨账号（他人回答，`owner_id` 非本人） | 404，与不存在**同形** |
| R06 | 查询抛错（连接失败） | 409 `OBJECT_UNAVAILABLE`（`AUDIT_STATE_UNREADABLE`），绝不当 approved |
| **R07** | **未配置连接池（`real` + `pool:null`）** | **409 `OBJECT_UNAVAILABLE`**，核对源查询 **0 次** ⇒ fail-closed 未变 |

> 读数脚本自身的三处假红已在写脚本阶段修掉（不是产品缺陷）：假端口原先忽略 `values`（跨类型
> 负控制被喂回别人的行）；R01 原先断言"恰好 1 次查询"，实际服务层在 `accept` 与 `execute`
> 各读一次（`service.ts:480`、`:575`），故断言改为"恰好 2 次、两次参数完全相同"；
> 同形比较原先比全文（含每次不同的 `request_id`），改为比信封形状。

---

## 4. 真实读数

### 4.1 能给出的真实读数（本机环境内可复现）

- `real` + 真核对源 + 替身提供者/媒体：**202 受理 → `GET /jobs/{id}` 200，`state=succeeded`**，
  核对源恰好 2 次参数化查询（R01）。
- 负控制六条：422 / 409 `REVISION_CONFLICT` / 404 / 404 / 409 / 409（R02–R07，见 §3.2）。
- 产品默认装配下 `real`：**503 `PROVIDER_UNAVAILABLE`**（R00），核对源 0 次。

### 4.2 未取得的读数（如实登记，不用"提供者 200"冒充端到端）

| 未取得 | 原因 |
| --- | --- |
| **真库**（真 PostgreSQL）读数 | 本机**没有** PostgreSQL 服务端与客户端（`postgres`/`initdb`/`pg_ctl` 均不在 PATH，无 Docker），`DATABASE_URL` 为空。§3.2 的读数全部来自**注入式只读查询替身**，它只模拟 `where id = $1` 的命中语义与故障注入——**不构成真库已验证** |
| 真实 TTS 提供者的 HTTP 200 | 真实提供者适配器在 **W1 分支**（PR #404，**未合入** `f5cca8b`）。本分支 `real` 在 `services/api/src/tts/service.ts:471` 即 503，走不到提供者调用 |
| 合成产物落到真实对象存储 | 媒体端口在 **W2 分支**（PR #408，**未合入**）。本分支 `real` 即便有提供者，也会在 `service.ts:475-478` 因 `media.kind === 'unwired'` 409 |
| 腾讯云内容安全调用 2 次 | **不该有**（见 §1.3：合成期零外呼）。强行接上会把离线审核结论变成合成期现算 + 每受理一次付费一次 |

### 4.3 费用

| 项 | 值 |
| --- | --- |
| 供应商请求数 | **0** |
| 腾讯云内容安全请求数 | **0**（本次授权 ≤2 次，**未动用**） |
| 累计费用 | **¥0.00** |
| 凭据读取 | **0 次**（`TENCENTCLOUD_SECRET_ID/KEY` 在本片无消费方；`process.env` 未被读取该键） |

---

## 5. 与 W1 / W2 的依赖（逐行）

`real` 受理路径的闸门顺序（`services/api/src/tts/service.ts`）：

| 顺序 | 位置 | 判定 | 本分支 `real` 的实况 |
| --- | --- | --- | --- |
| 1 | `:471` | 提供者 `unavailableReason` ⇒ 503 `PROVIDER_UNAVAILABLE` | **挡住**（W1 未合入） |
| 2 | `:475-478` | `media.kind === 'unwired'` ⇒ 409 `OBJECT_UNAVAILABLE` | **挡住**（W2 未合入） |
| 3 | `:480` | `readAndDecide(..., 'accept')` ⇒ 内容核对闸 | 本次接线点（只有前两闸过后才可达） |
| 4 | `:575` | 执行前复核 `readAndDecide(..., 'execute')` | 已接线 |
| 5 | `:785` | 读面复核 `readAndDecide(..., 'verify')` | 已接线 |

**明确回答「与 W2 是否还有依赖」：有，且是硬依赖。**
依赖点在 `services/api/src/tts/service.ts:475-478`（`media.kind === 'unwired'` ⇒ 409），
它在内容闸 `:480` **之前**。也就是说：本次接线让「核对闸」有了真实现，但**在 W2 合入前，
`real` 请求仍然到不了核对闸**。同理 W1 的提供者闸 `:471` 更早。

对 egress 台账的影响：本次改动**新增零外呼**，因此**不需要**、也**没有**新增
`services/api/src/privacy/task-egress.ts` 侧的任何账目；`synthesisEgress`
（`app.ts` 内的出站包装器）仍只包在提供者 `synthesize` 派发处，核对读取不入账——因为它不出网。
若未来有人把内容安全外呼接进核对端口，**必须**同时补一条 egress 账（本文件 §1.3 已把这条
约束写死在代码注释里）。

---

## 6. 自检结果（本分支实测）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型/卫生 | `npm run lint` | **PASS** |
| TTS 域单测 | `node --test tests/unit/tts-*.test.mjs tests/unit/speech-*.test.mjs` | **全绿**（含 W1 加强后的 S01 结构断言：路由插件不构造任何提供者/产物/核对源） |
| 新增单测 | `node --test tests/unit/tts-checked-content-wiring.test.mjs` | **18/18 PASS** |
| HTTP 回环 | `node tests/integration/tts-http.mjs` | **全绿**（P01–P05 缩片读数与 S01/S02 结构断言未被破坏） |
| HTTP 回环（新增） | `node tests/integration/tts-content-wiring.mjs` | **8/8 PASS**（R00–R07） |
| SQL 列级守卫 | `node --test tests/unit/sql-column-coverage.test.mjs` | **16/16 PASS**（见 §7.1） |
| 全量单测（独占） | `npm run test:unit` | **3392 通过 / 0 失败**（1 跳过，既有） |
| 契约状态锚点 | `node tools/verify-contract-status.mjs` | **PASS**（409 条引用自带锚点；无锚点不可核 0 条） |

---

## 7. 对既有测试的改动（书面报告，**只加强、不放宽**）

### 7.1 `tests/unit/sql-column-coverage.test.mjs`（+18/−3）——**登记新 SQL 宿主**

- **为什么必须改**：该守卫用 `findHostSetProblems()` 扫「含 SQL 的宿主文件」并要求其出现在
  固定集合里。新增 `services/api/src/ai/checked-content-live-adapter.ts` 含 SQL ⇒ 宿主集合
  从 1 变 2 ⇒ NC7 断言 `actual: 2, expected: 1` 失败。这是**登记性**改动，不是放宽。
- **改动内容**：把新适配器加入宿主白名单；并为其两条 SQL 登记所需的列级读权限
  （`conversation_answers`: `revision`/`check_state`/`owner_id`/`checked_text`；
  `current_knowledge`: `revision`/`title`/`body`/`type`/`id`）。
- **是否放宽**：**否**。逐条核对运行时的**既有**列级授权（`deploy/postgres-cvm/sql/20-login-roles.sql`）：
  - `:685-687` — `GRANT SELECT (id, turn_id, owner_id, revision, status, checked_text, check_state, citations, dose_cards, model_version, prompt_version, rule_version, created_at, updated_at) ON public.conversation_answers TO gengyun_api_runtime;`
    ⇒ 本适配器读的 4 列（`revision`/`check_state`/`owner_id`/`checked_text`）**全部在既有授权内**，
    **不需要改 `deploy/**`**、不需要新增任何 `GRANT`。
  - `:225` — `GRANT gengyun_knowledge_runtime TO gengyun_api_runtime;`（`catalog_read.current_knowledge` 只读）
    ⇒ 知识读面的 `revision`/`title`/`body`/`id`/`type` 亦在既有只读面内。
  ⇒ 登记的是**已存在的权限**，不是新增授权；也没放宽任何列约束。
  （`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 是角色特权断言，不枚举应用 SQL 形状；
  本适配器的两条 `select` 只触达上述已授权列，与该断言不冲突——但**未在真库跑过**，见 §8.2。）
- 16 个用例（含 NC1–NC10 全部负控制）**全部仍绿**。

### 7.2 `tests/integration/tts-http.mjs` / `tests/unit/tts-service.test.mjs` **未改**

既有断言 `contentPort` 的 `kind`（`tests/integration/tts-http.mjs:624` 期望 `'substitute'`、
`tests/unit/tts-service.test.mjs:1086` 期望 `'substitute'`、`:1094` 期望 `real` + 无池为 `'unwired'`）
**一个字符都没动**，并且仍然通过——这正是 §2.3 两分支"逐字一致"的独立佐证。

### 7.3 `package.json`（+1/−1）

`test:integration:http` 链中插入 `node tests/integration/tts-content-wiring.mjs`（紧跟
`tts-http.mjs`）。只是把新读数脚本纳入既有入口，不改任何阈值或断言。

---

## 8. 已知缺口（**不声称**的部分）

1. **契约闭集内其它 `type` 仍未接**：`SynthesisTargetType` 是 16 值闭集，本片只接
   `answer` + 四个知识类型。`dose_card`（无可核验来源）、`recognition`/`ocr`/`transcription`/
   `post`/`comment`/`conversation`/`media`/`synthesis` 等仍返回 404 —— 这是 **fail-closed
   的如实形状**，不是"假可用"。
2. **真库未验**（§4.2）：迁移 `0013`/`0010` 的列名与视图名按仓内 DDL 对齐，但**没有**在真
   PostgreSQL 上跑过一遍。
3. **知识读面无 `AuditState` 维度**（§1.4）：`pending`/`quarantined` 在该读面上不可表达，
   只能表现为「查不到行」。
4. **`real` 端到端仍不可达**（§5）：W1 提供者闸与 W2 媒体闸均在内容闸之前。
5. 本次**未**新增任何 `ErrorCode`、未改 `packages/contracts/**`、`openapi.json`、
   `contract-status.json`、`.github/workflows/**`、`deploy/**`、迁移号；未 push、未开 PR。

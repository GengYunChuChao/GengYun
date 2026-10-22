# GY-R31 片：图片审核产品路径 + 人工复核入口裁定（GY-I14 缺口 G3／G4）

- 被测基线：`origin/main` = **`bf2f76f9`**（本片全部命令、读数都绑定该 SHA；工作树 `wt-r31-moderation-img`，分支 `feat/gy-r31-moderation-img`）。
- 复盘依据：`docs/verification/gy-r31-i14-recon-20261022.md`（分支 `origin/feat/gy-r31-i14-recon`，写作基线 `d4d48088`）的「图片审核无产品路径」（G3）与「人工复核入口未接线」（G4）两节。
- 口径：本文把「读码推断」与「实测」分开写；凡未跑过的进 §7「未取得」，不冒充实测。
- 边界：**未改 `packages/contracts/openapi.json`**、**未加迁移**、**未删任何既有断言**、未推 main、未开 PR。

## 0 结论摘要

1. **片一（带图片帖子进不了发布）**：实测证明拒的理由**不是**「图片审核能力缺失」，而是社区入口把「规则层不评估媒体」直接当成「内容不可发布」——审核域一次都没被调用（`screen_calls:0`、`ims_port_calls:0`、零任务、零内容行）。补法是给审核端口加一个**显式图片能力位**（沿用既有 `wired/ready` 语义），并在发布前作为**与门**：能力就绪 ⇒ 受理为「私有 + 待审」并建 `text`+`image` 版本级任务；能力缺失 ⇒ 仍 fail-closed 拒绝，理由码 `IMAGE_MODERATION_UNAVAILABLE` 可与「内容违规／规则未通过／未送审」区分。
2. **片二（人工复核入口）**：裁定**不接**。契约里没有对应 operation（85 条 path 零命中），模块本身是**如实声明的空态**（`wired: false` 字面量类型、`assertNoReviewClaim()` 恒抛），issue #14 的「问题与结果」原文要求「**AI 失败不能依赖未上线人工放行**」——现在硬接一条路由等于伪造一个契约外 operation 和一条不存在的评审线。

## 1 片一：现状实测（改前）

### 1.1 实测方式

临时探针 `probe-media-path.mjs`（提交前删除）用真实装配走 HTTP 单测口径：`makeWiredHarness({ ports: { tms: passingPort({ kind: 'tms' }), ims: passingPort({ kind: 'ims' }) } })`（**文本与图片端口都已注入**），然后 `POST /api/v1/posts`，`media_ids: ['22222222-2222-4222-8222-222222222222']`。

### 1.2 改前读数（`bf2f76f9` 的代码）

```json
{
  "http_status": 422,
  "error_code": "INPUT_UNCERTAIN",
  "error_message": "内容筛查未完成或未通过（decision=quarantined），一律不得发布",
  "details": [
    { "field": "reason_codes", "code": "MEDIA_NOT_EVALUATED_BY_RULE_LAYER" },
    { "field": "reason_codes", "code": "NOT_PUBLISHABLE" }
  ],
  "screen_calls": 0,
  "moderation_tasks": 0,
  "task_kinds": [],
  "tms_port_calls": 0,
  "ims_port_calls": 0,
  "posts_rows": 0,
  "publish_gate_calls": 0
}
```

同时 dump 的规则层原始结论：

```json
{
  "decision": "quarantined",
  "publishable": false,
  "reason_codes": ["MEDIA_NOT_EVALUATED_BY_RULE_LAYER"],
  "refusal_reason_codes": ["MEDIA_NOT_EVALUATED_BY_RULE_LAYER", "NOT_PUBLISHABLE"],
  "counts": { "total": 12, "evaluated": 0, "hits": 0, "errors": 0, "timeouts": 0, "truncated": 0, "not_evaluated": 12 }
}
```

`evaluated: 0 / not_evaluated: 12` 说明：**12 条硬规则一条都没跑**，因为目标带媒体。

### 1.3 拒在哪一行（与复盘页的定位差异）

- 规则层：`packages/moderation/engine.mjs:352` 把 `validation.has_media` 直接算进闸门（`!validation.valid || !validation.covered || validation.has_media || failClosed.length > 0`），`:406-407` 再补一条 `failClosed.push('MEDIA_NOT_EVALUATED_BY_RULE_LAYER')` ⇒ 带媒体恒 `quarantined`。
- 社区入口（改前）：`services/api/src/community/service.ts` 的 `createPost` 里 `gate.evaluate(...)` 之后立刻 `if (!outcome.publishable) { await recordRefusalVerdict(...); throw refusal(outcome); }` ⇒ 422 `INPUT_UNCERTAIN`，**在任何送审动作之前**。
- 复盘页 G3 把缺口定位在 `services/api/src/community/service.ts:874-877`（`throw new ApiError('PROVIDER_UNAVAILABLE', '带媒体内容不得由规则层放行（内部不变式违反）')`）。**实测修正**：那行是**第二道不变式**，改前代码根本走不到（第一道已经抛了），而且它给的是 503、与实测的 422 不是同一个错误码。⇒ 缺口真正的入口是**第一道**：把「规则层不评估媒体」误当成「内容不可发布」。

## 2 片一：缺口定性

| 缺口 | 事实 | 定位 |
| --- | --- | --- |
| A 社区入口整类拒 | 带媒体目标在规则层恒 `quarantined`，社区把它当硬拒绝 ⇒ 审核域从未被调用（`screen_calls:0`） | `services/api/src/community/service.ts`（改前 `createPost` 的 `!outcome.publishable` 分支） |
| B 图片端口「可服务性」从未被表达 | 审核域有 `ims` 端口类别、任务也确实按 `text`+`image` 生成，但没有任何地方能回答「图片审核此刻到底有没有接线」 | `services/api/src/moderation/provider.ts`、`services/api/src/moderation/service.ts`（改前无能力位） |

关键反证（说明缺口不在审核域内部）：`services/api/src/moderation/service.ts:275-287` 的 `modelLayerReachable(rule)` 对「规则层只是不评估媒体」这一种 `quarantined` **返回 true**：

```ts
function modelLayerReachable(rule: RuleLayerRead): boolean {
  if (!rule.input_valid) return false;
  if (rule.decision === 'rejected') return false;
  if (rule.decision === 'approved') return true;
  return rule.reason_codes.every((code) => code === 'MEDIA_NOT_EVALUATED_BY_RULE_LAYER');
}
```

⇒ 只要社区肯把带媒体内容送进审核域，图片端口**本来就会被尝试调用**；问题只在社区这一道门。

## 3 片一：改法（复用既有端口，不改契约、不加迁移）

### 3.1 显式图片能力位（复用 `wired/ready` 语义，不新造第二套判定）

- `services/api/src/moderation/service.ts:208-227`：`ModerationPortCapability { content_kind, port_kind, state: 'wired'|'substitute'|'none', ready, origin }`、`ModerationCapabilities { execution_mode, text, image }`、`ModerationService.capabilities(): ModerationCapabilities`。
- 实现 `services/api/src/moderation/service.ts:510-524`：`capabilityOf(kind)` 由**既有的** `portOrigin(kind)` 派生（`injected ⇒ wired/ready:true`、`substitute ⇒ substitute/ready:false`、`none ⇒ none/ready:false`），不引入第二份「哪些端口算接线」的口径。
- fail-closed 服务（real 模式）`services/api/src/moderation/service.ts:377-390`：两类都 `state:'none'`、`ready:false`。

### 3.2 联动端口只读转发 + 唯一读法

- `services/api/src/community/moderation-link.ts:145-190`：`LinkImageReadiness { ready, state: 'wired'|'substitute'|'none'|'unknown', origin, source }` 与 `readImageModerationReadiness(link: unknown)`。**只有 `state === 'wired' && ready === true` 才算就绪**；没有联动端口、端口没提供读法、读法抛错、返回值形状不对，一律 `ready:false`（`source` 分别记 `no-link`／`no-reader`／`threw`／`shape`）。
- `services/api/src/community/moderation-link.ts:275`（`ModerationDomainPort` 加可选 `capabilities?()`）、`:594-620`（`imageReadiness()` 实现，读 `capabilities()` 再走同一套判据、不缓存）、`:627`（挂到 `CommunityModerationLink`）。

### 3.3 发布前的与门（核心）

`services/api/src/community/service.ts:933-950`：

```ts
const mediaCount = body.media_ids.length;
const imageReadiness: LinkImageReadiness | null =
  mediaCount > 0 ? readImageModerationReadiness(moderationLink) : null;
const mediaAccepted =
  mediaCount > 0 &&
  ruleLayerDeferredMedia(outcome) &&
  imageReadiness !== null &&
  imageReadiness.ready === true;
if (!outcome.publishable && !mediaAccepted) {
  await recordRefusalVerdict(target, outcome, text);
  throw refusal(outcome, imageReadiness);
}
```

两个与门缺一不可：

1. **规则层只是「不评估媒体」**：`services/api/src/community/service.ts:376-379` `ruleLayerDeferredMedia(outcome)` —— `decision !== 'rejected'` 且 `outcome.reason_codes` **全部**等于 `MEDIA_NOT_EVALUATED_BY_RULE_LAYER`（注意用 `reason_codes`，不是含 `NOT_PUBLISHABLE` 的 `refusal_reason_codes`）；驳回／输入非法／引擎异常／扫描截断／任何媒体之外的原因都仍然走原拒绝路径，一处没放宽。
2. **图片端口真的有**：`imageReadiness.ready === true`。

送审之后的「已提交审核」态：`services/api/src/community/service.ts:958-966`（`mediaReview = mediaAccepted && isMediaReviewPending(screen)`；`!mediaReview` 时才走原来的 `requireDomainClearance` + 「带媒体不得由规则层放行」不变式，该 503 原样保留）、`:983-984`（落库 `visibility:'private'`、`audit_state:'pending'`）、`:992`（结论取审核域那一条，不伪造成 `approved`）、`:1013-1015`（带媒体此刻没有审核结果 ⇒ **不投递**「审核结果」事件）、`:998-1010`（`awaitingPublish` 时才调 `link.publish`，`mediaReview` 不调）。`editPost` 同口径：`services/api/src/community/service.ts:1080-1142`。

### 3.4 错误码选择（为什么不新开 503）

能力缺失时 `services/api/src/community/service.ts:565-571` 把 `IMAGE_MODERATION_UNAVAILABLE` 追加进既有 `details[].reason_codes`，HTTP 仍是 **422 `INPUT_UNCERTAIN`**。理由：

- 契约闭集：`packages/contracts/openapi.json` 的 `x-error-status-map` 里 422 只有 `CONDITIONS_INCOMPLETE`／`SOURCE_CONFLICT`／`INPUT_UNCERTAIN`，503 只有 `PROVIDER_UNAVAILABLE`／`PROVIDER_OUTCOME_UNKNOWN`。本片**不改 openapi**，可选集合就是这些。
- 没有调用任何供应商：这不是「供应商挂了/结果未知」，而是「这一类内容此刻没有可求值的图片审核端口」。用 `PROVIDER_UNAVAILABLE` 会把「没接线」和「接线了但不通」混为一谈。
- 既有的带媒体拒绝被钉在 422 + `MEDIA_NOT_EVALUATED_BY_RULE_LAYER`（`tests/unit/community-moderation-publish.test.mjs` 的 G1c、`tests/unit/community-service.test.mjs:156`），把状态码换成 503 就得删既有断言。⛔ 本片不删断言。
- 「同一个 HTTP 码」为什么可接受：调用方区分拒绝原因本来就读 `details[].code`（既有 `refusal()` 就是这么给逐条理由码的）；新增的是**第三个、专属码**，只在带媒体时出现。区分能力的实测见 §4.2 的 I2/I3。

## 4 片一：两次读数

### 4.1 探针（同一脚本、同一请求）

| 读数 | 改前（`bf2f76f9`） | 改后（本片） |
| --- | --- | --- |
| HTTP 状态 | 422 | **201** |
| 审核域被调用 | `screen_calls: 0` | `screen_calls: 1` |
| 版本级任务 | `moderation_tasks: 0` | `moderation_tasks: 2`（`['text','image']`） |
| 端口调用 | `tms 0 / ims 0` | `tms 1 / ims 0`（**见 §7-1**） |
| 内容行 | `posts_rows: 0` | `posts_rows: 1` |
| 发布闸门 | `publish_gate_calls: 0` | `publish_gate_calls: 0` |

改后同一探针的能力位／落库读数：

```json
{
  "capabilities": {
    "execution_mode": "stub",
    "text":  { "content_kind": "text",  "port_kind": "tms", "state": "wired", "ready": true, "origin": "injected" },
    "image": { "content_kind": "image", "port_kind": "ims", "state": "wired", "ready": true, "origin": "injected" }
  },
  "imageReadiness": { "ready": true, "state": "wired", "origin": "injected", "source": "capabilities" },
  "counts.substitutes": [],
  "read_own_post": { "visibility": "private", "audit_state": "quarantined", "media": [] },
  "store_row": { "visibility": "private", "audit_state": "pending", "media_ids": ["22222222-2222-4222-8222-222222222222"] },
  "stored_verdict": { "decision": "quarantined", "reason_codes": ["MEDIA_NOT_EVALUATED_BY_RULE_LAYER", "MODEL_MEDIA_UNSUPPORTED", "MODEL_PAYLOAD_INVALID"], "complete": false },
  "tasks": [
    { "content_kind": "text",  "decision": "quarantined", "reason_codes": ["MEDIA_NOT_EVALUATED_BY_RULE_LAYER", "MODEL_MEDIA_UNSUPPORTED"] },
    { "content_kind": "image", "decision": "quarantined", "reason_codes": ["MEDIA_NOT_EVALUATED_BY_RULE_LAYER", "MODEL_MEDIA_UNSUPPORTED", "MODEL_PAYLOAD_INVALID"] }
  ]
}
```

注意两处**如实的**不一致，别读成矛盾：落库列是 `pending`（「已提交审核」），而读面 `audit_state` 是 `quarantined`——读走的是「版本结论」投影（结论仍是隔离），因此这条帖子**对公众不可见**。这正是「补了路径也没变成放行」。

### 4.2 新增断言（`tests/unit/community-moderation-image.test.mjs`，5 条）

| 用例 | 断言什么 |
| --- | --- |
| I1 能力就绪 ⇒ 受理为「私有/待审」 | `POST /posts` 带 1 个 media ⇒ 201；落库行 `visibility:'private'`、`audit_state:'pending'`；审核域任务数 2 且 `content_kind` 含 `text`+`image`；`h.calls.screen.length === 1`；**未**调用发布闸门 |
| I2 能力缺失 ⇒ 拒且理由码可区分 | `ims` 只有替身 ⇒ 422 `INPUT_UNCERTAIN`；`details` 里有 `IMAGE_MODERATION_UNAVAILABLE`；零内容行、零任务 |
| I3 对照：纯文本硬规则命中 | 400 `INVALID_REQUEST`，且 `details` **不含** `IMAGE_MODERATION_UNAVAILABLE`（证明该码专属带媒体能力缺失，不与内容违规混淆） |
| I4 不变式未被放宽 | 把 gate 换成「会放行媒体」的实现、联动也「明确放行」⇒ 仍 503 `PROVIDER_UNAVAILABLE`（`services/api/src/community/service.ts:961-965` 的第二道不变式仍在） |
| I5 编辑同口径 | `PATCH /posts/{id}` 带 media ⇒ 新 revision 同样落「私有/待审」，两 revision 共 4 个任务，不调发布闸门 |

**两次读数（同一份断言文件）**：

| 时点 | 命令 | 结果 |
| --- | --- | --- |
| 改前（把三个源文件临时退回 `bf2f76f9`，断言不变） | `node --test "tests/unit/community-moderation-image.test.mjs"` | `tests 5 / pass 1 / fail 4`（I1、I2、I3、I5 红；I4 绿，因为第二道不变式改前就存在） |
| 改后（本片代码） | 同上 | `tests 5 / pass 5 / fail 0` |

改前的红证据（截取）：

```
✖ I5. 编辑带媒体 ⇒ 新 revision 同样落「私有/待审」且不调用发布闸门
  Error [ApiError]: 内容筛查未完成或未通过（decision=quarantined），一律不得发布
    at refusal (services/api/src/community/service.ts:513:12)
    code: 'INPUT_UNCERTAIN',
    details: [ { field: 'reason_codes', code: 'MEDIA_NOT_EVALUATED_BY_RULE_LAYER' },
               { field: 'reason_codes', code: 'NOT_PUBLISHABLE' } ]
```

### 4.3 既有断言一条没删（仍全绿）

`MEDIA_NOT_EVALUATED_BY_RULE_LAYER` 相关的既有断言原样保留：`tests/unit/community-gate.test.mjs:95-96`、`tests/unit/community-service.test.mjs:156`、`tests/moderation/fail-closed.test.mjs:107`、`tests/moderation/http-screening.test.mjs:114,119`、`tests/moderation/model-fail-closed.test.mjs:71,278`；`tests/unit/community-moderation-publish.test.mjs` 的 G1c/G1d 未改动。

### 4.4 全量与门禁

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量单测 | `npm run test:unit` | `tests 3751 / pass 3750 / fail 0 / skipped 1`（189s） |
| 类型检查 | `npm run typecheck --workspace @gengyun/api` | 通过（`tsc -p tsconfig.json --noEmit` 无输出） |
| 契约台账门禁 | `node tools/verify-contract-status.mjs` | `PASS`（语义可核 105 条区间、证据锚点 412 条引用、中文表格一致） |

对照：改前在**旧基线** `1a333920` 上跑全量是 `3675 / pass 3666 / fail 8`，8 条全在 `tests/unit/release-materials-index.test.mjs`（写死行号，与本片无关）；新基线 `bf2f76f9` 已把它们修掉，所以本片读数是 0 fail。

## 5 片二：人工复核入口 —— 裁定「不接」

### 5.1 现状实测

| 事实 | 定位 |
| --- | --- |
| 模块自述「**不是**一个『评审功能』，而是一个**如实声明的空态**」 | `services/api/src/admin/human-review.ts:2-19` |
| `wired: false` 是**字面量类型**（不是可翻转的布尔） | `services/api/src/admin/human-review.ts:40`、`:51`、`:70`、`:75` |
| 唯一入口 `assertNoReviewClaim()` **一律抛** `OBJECT_UNAVAILABLE`，`details: [{ field: 'human_review', code: 'NOT_WIRED' }]` | `services/api/src/admin/human-review.ts:59`、`:83-86` |
| 人审队列恒空 | `services/api/src/moderation/nonbypass.ts:161-167`（`return { human_review_state: HUMAN_REVIEW_STATE, voting: …, items: [] }`，注释「`items` 恒为空数组——只有真实人审线合并后才会返回非空」） |
| 装配存在但零路由 | `services/api/src/app.ts:1153`、`:1679`（`app.decorate('humanReviewDirectory', …)`）；`services/api/src/routes/` 20 个文件里没有 `human-review` 路由 |

### 5.2 裁定依据（原文）

1. **issue #14 原文**（`gh api repos/GengYunChuChao/GengYun/issues/14`，OPEN）：
   - 「## 问题与结果」——「社区先审后发，**AI失败不能依赖未上线人工放行**。」
   - 「## 范围」——「文字及图片均有版本级审核任务，规则先挡广告交易和硬危险边界；AI失败／超时／无结论保持隔离…」
   - 「## 验收」——「AI不授权限、改来源或标专家已审，公众票决不进入首版」。
2. **契约**：`packages/contracts/openapi.json` 共 85 条 path，`^    "/[^"]*(moderation|human|review)` **零命中**——审核域只作为 `ModerationResult` schema 出现在 `JobResult.oneOf` 里，`/jobs/{id}`、`/admin/jobs` 是作业读面，不是评审入口。
3. **台账**：`docs/architecture/contract-status.json` 里没有 moderation／human-review 的 operation（复盘的 G7 结论）。

### 5.3 裁定与理由

**不接。** 依据不是「工作量」，而是三条硬事实：

- 接一条 `/admin/human-review/...` 路由 = 造一个**契约里不存在的 operation**，而本片硬约束是「不改 openapi」；契约外的路由在本 repo 的既有做法里是不允许的（`contract-status.json` 逐 op 对账，新增无 op 的路由会让台账与实现失配）。
- 该模块的设计意图就是**空态**：`wired: false` 是字面量类型，`assertNoReviewClaim()` 的唯一职责是「让声称评审完成的调用**显式失败**」。给它接一条「列出待复核项 + 取一条 + 提交结论」的路由，要么永远返回空列表（等于把 §5.1 的空态伪装成功能），要么得先造任务表、评审人目录、投票与专家认证——那正是 issue #14 与 GY-I18 派单第 5 条明令禁止的「把基础账号管理说成人工评审已完成」。
- 业务上也不需要：issue #14 的「问题与结果」正文明写**不能依赖未上线的人工放行**。人审是后续片（GY-I18）的交付物，本片若「接上」反而是给「AI 失败有人兜底」制造假象。

⇒ **现状不是缺陷**：`wired:false` + 空队列 + 零路由是「人审未上线」的如实表达；`human_review_state = 'under_construction'` 是契约里唯一的对外事实。

### 5.4 若将来要接（前置条件，留档）

最小落点仍是 `services/api/src/routes/admin.ts` 的既有 admin guard 之后，但**先要**：契约新增 3 个 operation（列表／取单／提交结论）+ 持久表（任务、评审人、结论、审计）+ 审核状态机的一个显式入口（不得直接改 `audit_state`）+ 权限 scope 与幂等/并发（`If-Match`/`Idempotency-Key`）+ 把 `human_review_state` 从 `under_construction` 改成契约里存在的下一个值。这四件事都不在本片范围。

## 6 台账锚点漂移：怎么处理的（附工具局限）

本片在 `services/api/src/community/service.ts` 里插了代码 ⇒ 该文件 16 条 evidence 的 `lines` 失效，门禁报 `语义错误 16`。

- `node tools/verify-contract-status.mjs --reanchor` **不能直接用**，实测 `FAIL: 锚点重定位被拒绝（MISSING 0 / AMBIGUOUS 15 / UNSAFE 0）`。两个原因都可复现：
  1. 这些锚点是**裸方法名**（`listPosts`、`createPost`…），在文件头注释、方法声明、路由注册注释里都出现 ⇒ 工具要求「唯一归属块」，直接 AMBIGUOUS；
  2. `tools/contract-status-core.mjs` 的 `enclosingBlock` 对带对象默认参数的签名会把块算成单行（`async listPosts(actor: unknown, query: ListPostsQuery = {})` 里 `= {}` 的 `{` 被当成块体 ⇒ 得到 `834-834`）。
- 处理：按**该工具自己的口径**（声明行 → 花括号配平的块尾）重算并写回这 16 条 `lines`（例：`listPosts` `768-773 → 834-900`、`createPost` `840-845 → 909-1020`、`editPost` `935-940 → 1030-1157`、`createComment` `1136-1141 → 1248-1350`），再用 `--write-doc` 同步 `docs/architecture/contract-implementation-status.md`，最后门禁 `PASS`。
- ⛔ **没有**把区间改小到「凑过 ±2 容差」：区间都是真实归属块（首行是方法声明，末行是它的收尾 `}`）。
- 顺手修了一处**陈述性失真**：`createPost`／`editPost` 的 `blocker` 原本写「模型层（LLM）图文审核未接入本装配（带媒体目标因规则层媒体口径不可能 approved）」——本片补了图片路径，这句会误导，已按新事实改写（并保留全部未取得项）。

## 7 未取得项

1. **图片端口没有被真正求值**（`ims_port_calls: 0`）。原因已定位：社区侧 `mediaInputs()` 只传 `{ media_id }`，而 `packages/moderation/model-ports.mjs:273` 的 `normalizeMediaRef(item)` 要 `mime`（`image/` 前缀）或 `kind === 'image'` 才算 image-like ⇒ 任务落 `MODEL_MEDIA_UNSUPPORTED`，`packages/moderation/merge.mjs` 的载荷校验再落 `MODEL_PAYLOAD_INVALID`。⇒ **图片审核链路已可达、但输入不完整**；补齐要媒体域投影（mime/revision），而 `services/api/src/community/service.ts` 文件头明确本阶段「不做 `/community/media*`（依赖媒体接线）」。本片**没有伪造** `mime`/`kind` 去凑一个"端口被调用"的假读数。
2. 无真实图片审核供应商：real 模式整域 fail-closed（`services/api/src/moderation/service.ts` 的 `createFailClosedModerationService`），注入的合成端口也只证明链路，不证明能力。
3. 带媒体内容在审核域恒为隔离/待审（规则层不评估图片）⇒ 本片之后**也不会**出现「图片帖子被发布」；这是既有口令，不是本片遗留。
4. 审核结论台账仍是内存 Map（复盘 G2），进程重启即丢；非本片范围。
5. 没有真实端到端（小程序/真机/浏览器）验证；只有进程内探针与 HTTP 单测。

## 8 待指挥裁定（3 条）

1. **媒体元数据要不要在本片顺手接？** 现在「图片端口可达但载荷不完整」（§7-1）。补齐需要接媒体域投影（mime/revision），会扩大改动面；不补则「图片审核真的跑过」这件事仍无实测证据。
2. **能力位是否固定为跨片内部契约？** `ModerationService.capabilities()` / `LinkImageReadiness` 目前是内部接口（未进 openapi）。若后续片（人审、媒体）要复用，建议这次就固化形状；否则每次都得重新对齐。
3. **片二裁定要不要回写到 #14？** 本文的「不接」结论 + 依据是否以 COMMENT 形式贴到 issue #14，避免下一片重复讨论同一件事。

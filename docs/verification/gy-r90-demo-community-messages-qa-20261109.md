# GY-R91 演示页收口：社区 / 消息 / 问答（2026-11-09）

- 分支：`feat/gy-r91-demo-community-messages-qa`（基于 `origin/main` `209aa01a`），工作树 `E:\GengYunCommander\.pg17\wt-r91-pages`。
- 现场：API `http://127.0.0.1:38110`、PG `127.0.0.1:55510`、状态目录 `E:\GengYunCommander\.pg17\demo-stack-live`、env `E:\GengYunPrivate\demo-real.env`（本页不打印任何值）。
- 小程序副本：`E:\GengYunCommander\.pg17\wt-demo-live\.local\wechat-local`；自动化为 `E:\GengYunCommander\.pg17\mpauto`（`cli.bat auto --auto-port 9424` + `connect({wsEndpoint:'ws://127.0.0.1:9424'})`）。
- 截图目录：`E:\GengYunCommander\.pg17\demo-shots6\`。

## 1. 结论

| 页面 | 改动前的 `page.data()` | 改动后的 `page.data()` | 之前为什么"看着没做完" |
| --- | --- | --- | --- |
| 问答 | `versionState:'unknown'`、`answerGateCode:'ANSWER_NOT_PRODUCED'`、`job.state:'failed'` | `versionState:'demo'`、`job.state:'succeeded'`、`citations` 1 条 | 服务端回答作业折 `PROVIDER_UNAVAILABLE`，页面拿不到回答行，版本串自然取不到 |
| 社区 | `status:'empty'`、`modeNote` 自述"未接真实审核供应商时不会返回成功" | `status:'ready'`、3 帖（`published`/`approved`） | 读面也被审核台账卡住：缺结论行就降级 `hidden/pending` |
| 消息 | `status:'empty'` | `status:'ready'`、`unreadNote:'未读 3 条'` | 库里没有该账号的消息行（读面本身已接线） |

## 2. 问答：版本串的来源与真正卡点

页面链路（**未改** `miniprogram/**` 产品代码）：`qa.js` 的 `settle()` → `qaApi.evaluateAnswerGate(answer)` → `applyVersionState(gate.answer.model_version)`。版本串来自**回答行的 `model_version`**（装配层写：`services/api/src/conversations/service.ts:1154`），不是任何"版本表/版本配置"。页面对版本串只有三态判定：空 ⇒ `unknown`；带 `unimplemented:no-real-` 前缀 ⇒ `demo`；`real` 且干净 ⇒ `real`（`miniprogram/pages/qa/qa.js:107`）。

真跑里第一次提问的直接观测：

```text
job.case: ANSWER_JOB_DEBUG ApiError: 检索集合条目 d0000000-0000-4000-8000-00000000c008 的来源 id 与条目 id 不一致
```

根因是**跨域身份错配**，与提问内容无关：

- `catalog_read.current_knowledge`（迁移 `services/api/db/migrations/0010_knowledge_read_views.sql`）投影 `s.id AS source_id`，即 `public.sources` 行 id；同一份来源可以挂多条知识条目（演示资料种子里 8 条知识共用 1 条 source）。
- `services/api/src/conversations/retrieval.ts:210` 旧口径硬性要求 `ref.id === 条目 id`，否则抛 `PROVIDER_UNAVAILABLE`（不可重试）⇒ 真实读面上**任何带来源的问答都必失败**。
- `services/api/src/conversations/guard.ts:326` 只按 `citation.id === entry.id` 定位条目 ⇒ 即使读面放行，引用也会被判 `not_in_retrieval_set`。

本 PR 的修法（B 档允许的少量 `services/**`）：

1. `services/api/src/conversations/retrieval.ts:210`：不再要求两个 id 相等，改为 `source.id` 的 uuid 形状校验（来源身份就是 sources 行 id）。
2. `services/api/src/conversations/guard.ts:326`：先按条目 id 定位，再退回 `sameSourceRef(entry.source, citation)` 逐字段相等。
3. `services/api/src/conversations/guard.ts:341`：重复引用按**来源对象**去重（共用一份来源时不再被误判 `duplicate_citation`）。
4. `services/api/src/conversations/service.ts:309`：确定性回答器的候选引用按来源对象去重（同一来源被列三次时不再整条阻断）。

修完后的回答行（`public.conversation_answers`）：

```text
status=answered  check_state=passed  citations=1
model_version=unimplemented:no-real-model/text-qa-deterministic
prompt_version=unimplemented:no-real-prompt/citation-guard-only
rule_version=unimplemented:no-real-rule/cjk-bigram+word-match/1+dose/gy-i08/1.2.0
```

**没有伪造运行期能力**：仍是未接真实模型的确定性检索摘录，正文首行自报「（未接真实模型·确定性检索结果…）」，页面据此显示"演示"态。修的是"真实数据模型下引用身份怎么核对"，不是把演示值当真实能力。

## 3. 社区：读面确实被审核台账卡住

读路径：`GET /api/v1/posts` → `services/api/src/routes/community.ts` 的 `listPosts` → `services/api/src/community/service.ts` 的 `isPubliclyVisible`（`visibility === 'published' && audit_state === 'approved'`）。而 `effectiveState` 会读 `community_moderation_decisions`：没有结论行 ⇒ 降级 `hidden/pending`；`text_digest` 与 `sha256(title + '\n' + body)` 不符、`revision` 对不上、`rule_version` 不是当前派生版本、`hard_rule_passed` 不为真，都降级。

所以**只灌帖子行会被降级，列表仍是空**——用户的两种预案里，本机落在后者：需要"明确标注清楚的演示数据通道"。real 模式下也没有可用的演示审核端口：`services/api/src/moderation/demo-port.ts` 在 `executionMode==='real'` 时直接 `refused`（用合成 `pass` 冒充真实审核在设计上被拒绝）。

本 PR 的演示通道（`db/seeds/demo_community_messages.sql`）：

- 3 条帖子：`visibility='published'`、`audit_state='approved'`、标题与正文都以「【演示数据·非生产】」开头。
- 3 条**与帖子一致**的审核结论行：`decision='approved'`、`hard_rule_passed=true`、`rule_version` 取当前派生版本 `mr1+sha256:511e7f2cf65626bbde5c5f38be950a13`，`text_digest` 在 SQL 里用 PG 的 `encode(sha256(convert_to(title || E'\n' || body,'UTF8')),'hex')` 从库里行现算（与 `postModerationText` 逐字节一致）。
- 结论值不是手写的"放行"：`tests/unit/demo-pages-seed.test.mjs` 用**真实规则引擎** `evaluateHardRules` 逐条重跑三段文本，断言 `decision='approved'`、`reason_codes=[]`、`rule_version===deriveRuleVersion()`；SQL 里的 `rule_version` 字面量也被断言等于当前派生版本。

因此这不是"绕过审核把未审内容当已发布"：结论行落在与真跑同一张表、同一套字段口径上，由确定性规则层判定；只是把"本机演示库里应有的已审核演示帖"补齐。

## 4. 消息：读面已接线，缺的是行

`services/api/src/routes/messages.ts` 的 `GET /messages` 只列本人，`projectMessage` 恰好 7 键，`target_ref === null ⇒ reference_state='unavailable'`；页面按 `type` 显示固定标签（无正文）。种子给**所有 `state='active'` 的用户**各 3 条 `type='system'`、`target_ref NULL`、`event_key` 以 `demo-pages-notice-` 开头（`owner_id,event_key` 唯一键保证幂等）。

## 5. `tools/demo-stack.mjs --demo` 接线

- 常量：`tools/demo-stack.mjs:865` `const seedFile = join(REPO_ROOT, 'db', 'seeds', 'demo_community_messages.sql');`（在 `--demo` 档内声明，避免上移模块常量时把别的文档锚点整体推移）
- 执行：`tools/demo-stack.mjs:866`（`--demo` 档内、`applyDemoProfile` 之后；只在 `mode === 'real'` 跑，`stub` 打印跳过原因）
- 日志：`tools/demo-stack.mjs:875` `✓ 灌入演示数据（非生产）：db/seeds/demo_community_messages.sql（社区 3 帖 + 消息 3 条系统通知，幂等）`

既有 `--seed-demo`（`demo_catalog_verified.sql`）与 `--demo`（三个 feature flag）逻辑未改。本机一次 `up` 的相关日志原文：

```text
[8/9] 演示开关：已开启 submissions_enabled / specific_herbicide_output_enabled / ai_enabled（非生产）
已是演示档：3 个开关均已开启且 reason 一致，revision 未重复累加（幂等）
✓ 灌入演示数据（非生产）：db/seeds/demo_community_messages.sql（社区 3 帖 + 消息 3 条系统通知，幂等）
认行 / 删除：见该文件头注（title 前缀「【演示数据·非生产】」、event_key 前缀 demo-pages-notice-）
[9/9] 启动 API
✓ /health → 200 ok（database=ok, mode=real）（1943ms，探测 4 次）
```

## 6. 模拟器取证（三页终态）

截图（同一轮 `clearStorage → 登录 → 提问 → 社区 → 消息`）：

- `E:\GengYunCommander\.pg17\demo-shots6\qa.png`（版本说明 + 风险提示）
- `E:\GengYunCommander\.pg17\demo-shots6\qa-scroll-800.png`（回答进度"回答已生成"、正文首行自报"未接真实模型"）
- `E:\GengYunCommander\.pg17\demo-shots6\qa-scroll-1200.png`（回答正文带「【演示数据·非生产数据】」条目）
- `E:\GengYunCommander\.pg17\demo-shots6\community.png`
- `E:\GengYunCommander\.pg17\demo-shots6\messages.png`

`page.data()` 关键字段原文（问答，2026-11-09 20:26 一轮）：

```json
{
  "stage": "settled",
  "mode": "real",
  "versionState": "demo",
  "versionNote": "当前为演示数据：回答由服务端按已核对的资料条目自动摘录，不是真实大模型生成的结果，真实资料覆盖也还有限；本页不提供剂量换算或处方，实际用药请以核验登记资料与标签原文为准。（演示版本 model/text-qa-deterministic）",
  "answerGateCode": "",
  "job": { "state": "succeeded" },
  "answer.status": "answered",
  "answer.modelVersion": "unimplemented:no-real-model/text-qa-deterministic",
  "citations": [
    {
      "id": "d0000000-0000-4000-8000-00000000b001",
      "version": "demo-seed-20261109",
      "title": "【演示】耕云本机演示资料种子（非生产数据，不代表第三方审核）",
      "url": "https://example.invalid/gengyun/demo-seed-not-for-production",
      "publisher": "耕云项目开发侧（演示种子）",
      "source_kind": "verified_seed",
      "evidence_kind": "mixed",
      "validity": "valid",
      "review_status": "verified"
    }
  ]
}
```

社区（首条；另两条同形状）：

```json
{
  "status": "ready",
  "modeNote": "服务端真实模式；本机未接真实审核供应商时不会返回成功。",
  "count": 3,
  "first": {
    "id": "d0000000-0000-4000-8000-00000000b001",
    "revision": 1,
    "title": "【演示数据·非生产】玉米田除草剂药害怎么排查？",
    "author": "耕云用户03cc",
    "authorAnonymized": false,
    "visibility": "published",
    "audit_state": "approved",
    "self": false
  }
}
```

消息：

```json
{
  "status": "ready",
  "modeNote": "服务端真实模式；消息持久存储未接线时不会返回成功。",
  "unreadNote": "未读 3 条",
  "count": 3,
  "items": [
    {
      "type": "system",
      "label": "系统通知",
      "unread": true,
      "readAt": "",
      "canOpen": false,
      "referenceNote": "本条不带关联目标（服务端只给事件类型与对象引用，不给正文）。"
    }
  ]
}
```

## 7. 演示数据的边界、认行与删除/重置

所有灌入行都能被**一条 SQL** 认出来（统一标记，不靠正文文本匹配）：

```sql
-- 演示用户 / 帖子 / 结论行 / 消息
select 'user'      as kind, count(*) from public.users      where id = 'd0000000-0000-4000-8000-00000000d001'
union all select 'posts',     count(*) from public.community_posts where author_id = 'd0000000-0000-4000-8000-00000000d001'
union all select 'decisions', count(*) from public.community_moderation_decisions
  where target_id in (select id from public.community_posts where author_id = 'd0000000-0000-4000-8000-00000000d001')
union all select 'messages',  count(*) from public.messages where event_key like 'demo-pages-notice-%';
```

本机实测输出：

```text
posts | 3
decisions | 3
messages | 9
demo_user | 1
```

删除（只删演示行，不动别的数据）：

```sql
begin;
delete from public.messages where event_key like 'demo-pages-notice-%';
delete from public.community_moderation_decisions
  where target_id in (select id from public.community_posts where author_id = 'd0000000-0000-4000-8000-00000000d001');
delete from public.community_posts where author_id = 'd0000000-0000-4000-8000-00000000d001';
delete from public.users where id = 'd0000000-0000-4000-8000-00000000d001';
commit;
```

重置：`node tools/demo-stack.mjs up --reset --demo --seed-demo …`（重建演示库后重新灌）；或再执行一次 `db/seeds/demo_community_messages.sql`（4 条 INSERT 全带 `ON CONFLICT DO NOTHING`，重复执行不新增行）。

## 8. 单测与四道闸门

相关单测（不连真库）：

```text
node --test tests/unit/conversation-*.test.mjs tests/unit/demo-pages-seed.test.mjs tests/unit/demo-seed-sql.test.mjs tests/unit/demo-stack.test.mjs tests/unit/demo-stack-cli.test.mjs
ℹ tests 208
ℹ pass 208
ℹ fail 0

npm run test:unit   # 合入 origin/main 后跑全量单元面（CI unit-tests 同一条命令）
ℹ tests 6968
ℹ pass 6965
ℹ fail 0
ℹ skipped 3
```

新增 `db/seeds/demo_community_messages.sql` 会让 `tests/unit/audit-action-literal-coverage.test.mjs` 的「反向扫描面」SQL 份数真值从 21 变 22（`db` 根下多一份 `*.sql`，本文件不写审计表），已同步下界与注释（提交 `338d95f5`），该文件 12/12 绿。

契约锚点：`node tools/verify-contract-status.mjs` → 全部 PASS（130 条操作、593 条证据锚点、中文表格一致），未需要 `--reanchor`。

四道闸门（逐条真跑，尾行原文）：

```text
# ① 文档行号/符号覆盖（CI contract job 同一条命令）
node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs
PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）   # exit 0
（同时打 SYMBOL-COVERAGE-VERIFICATION-STALE：UNDECLARED 265 → 264，低于基线只提示收紧，不判红）

# ② 文档锚点位移恒等
node --test tests/unit/doc-anchor-relocation-identity.test.mjs
ℹ tests 37
ℹ pass 36
ℹ fail 0   # exit 0（1 条 skip：浅克隆自愈用例在本地非浅仓下跳过）

# ③ 文档一致性（链接/表格/27 项依赖/F‑AC‑Q 映射）
npm run test:docs
PASS: 识别 5 页 / 跳过 377 页（扫描面 382 页：docs/verification）——读数七条判据全部自洽   # exit 0

# ④ verification 注释锚点
node tools/verify-verification-comment-anchors.mjs
VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 1425 条注释锚点只告警，没有基线外新增   # exit 0
```

**为什么 services 改动是"行号中性"的**：本轮 `retrieval.ts` / `guard.ts` / `service.ts` 的改动都是**等行数替换**（`git diff --numstat` = 3/3、3/3、2/2），`tools/demo-stack.mjs` 相对 `origin/main` 只有一处新增（`--demo` 档内，第 802 行以后；`git diff --numstat origin/main` = 22/0），其余行逐字节一致。这样既不动 5 份架构/历史取证文档的行号锚点，也不改任何锚点基线 JSON——第一道闸门在**没有 reanchor、没有 `--write-baseline`** 的情况下 PASS。

## 9. 不声称项

- 不声称接入了真实审核供应商或真实大模型；问答仍是确定性检索摘录，版本串带 `unimplemented:no-real-` 前缀，页面显示"演示"。
- 不声称演示帖子代表真实用户内容或第三方审核结论；它们全部带「【演示数据·非生产】」前缀，作者是演示账号。
- 不声称 38210/55520、38310/55530 两个栈被动过；本次只碰 38110/55510 与 `E:\GengYunCommander\.pg17\demo-stack-live`（该栈原先跑的是 `wt-consent-demo` 的代码，已按用户授权重启到本分支）。
- 不声称库里别人的数据被改动：8 条演示资料、20 条除草剂、6 条识别历史保持原样；新增行全部可用第 7 节 SQL 认出并删除。

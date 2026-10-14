# GY-I08 条件匹配与原文用量 · 确定性规则引擎与整项验收接续

- **任务**：GY-I08（GitHub issue **#8**，P0／M2）——「实现药剂适用过滤与标签原文用量安全边界」
- **本轮交付**：确定性规则引擎（登记／匹配／限制阻断闭集 + 可执行建议闸门 + 功能关闭开关 +
  可追溯规则版本）、**149 组**用例集、**43 条**用量卡守卫负例，以及跨端闭集同构断言
- **日期**：2026-10-14
- **分支**：`feat/gy-i08-applicability-rules`
- **基线**：`upstream/main` = `72c4923a8ec058399a51609e1cf1e3c70a890b4a`（即 GY-I07／PR #135 合并点）
- **执行模式**：**全部离线**（纯 Node 内置模块，无第三方依赖、无网络、无付费调用、无微信／Android 端到端）
- **不关闭整项**：`Refs #8`；`Closes`／`Fixes`／`Resolves` 均为 0

## 1 本轮补的是哪一块

[PR #90 自查页](gy-i08-pr90-self-review-20261013.md)与 [GY-I07 证据页](gy-i07-knowledge-query-20261014.md)
都把同一件事登记为**未取得项**：

> 「真实微信身份交换、ACE3V Android 真机、完整核准资料／原文用量正例及**整项100组／所有消费端验收**仍缺。」

本轮**只补这一块**（其余未取得项原样保留，见 §7），不重复 PR #82／#90 已交付的组件级内容：

| 此前状态（PR #82／#90） | 本轮补齐 |
| --- | --- |
| `evaluateApplicability` 8 维度 fail-closed、`doseCardDescriptor` 原文数字／单位／条件绑定 | 加装**可执行建议闸门**与**登记侧判定**，并把这些能力做成闭集 + 逐类计数 |
| 功能开关只关**用量卡** | 开关改为关**可执行建议**（用量卡为其下位，一并关闭） |
| 「同一规则版本」为文档声明 | 变成**可执行断言**（含消费端真实存在、漂移检测、内容摘要、跨端闭集同构） |
| 无 100 组场景集 | **159 组**（登记 64／匹配 63／限制 32）+ **43 条**守卫负例 |
| **P1（监工 2026-10-14 CHANGES_REQUESTED）**：`evaluateRegistrationMatch` 先按名称／剂型／成分含量过滤、再判同登记号冲突 ⇒ **输入收窄可消除已有冲突** | **返修：冲突判定移到输入收窄之前**（只有登记号可限定范围）⇒ 见 **§10**，同形用例 MRG-031…MRG-040 + 专项用例 |

## 2 规则引擎位置与各消费端如何取同一规则版本

**规则引擎（单一事实来源）**：[`packages/reference/deterministic.mjs`](../../packages/reference/deterministic.mjs)（576 行）。

它**不另起一套**，而是在既有已合并成果上加装缺的两件能力：

- 维度判定复用 [`query.mjs`](../../packages/reference/query.mjs) 的 `evaluateApplicability`（8 维度，fail-closed）；
- 用量卡守卫复用 [`labels.mjs`](../../packages/reference/labels.mjs) 的 `doseCardDescriptor`（原文数字／单位／条件 + 绑定校验）；
- `query.mjs` 本轮**只导出一个函数**（`readRestrictionStatus`，由 `function` 改为 `export function`），
  让引擎复用**同一份**禁限用判定 —— 否则「限用」与「不适用」的归类会在引擎与卡片之间分叉。

### 2.1 版本取值（可断言、可追溯）

```text
[GY-I08] 规则版本=gy-i08/1.2.0 规格摘要=gy-i08-spec+sha256:85c8e4303d0329168a696539d8110111c48ea26a930f5d9be512a32513b8f31e
[GY-I08] 阻断类别闭集(14): no_source,simulated_source,invalid_source,ambiguous_match,field_conflict,no_match,unreviewed,banned,restricted,restriction_unknown,not_applicable,missing_condition,no_dose_source,feature_closed
```

版本号 `gy-i08/1.2.0` 由 [`constants.mjs`](../../packages/reference/constants.mjs) **唯一定义一次**（测试断言全仓仅此一处
`export const APPLICABILITY_RULE_VERSION`）；摘要由**规则规格内容**（维度／匹配状态／禁限用状态／拒绝原因／
阻断类别）经 `canonicalJson` + sha256 派生，任一成员变化都会改变摘要（测试用 5 组变异逐项证明）。

### 2.2 消费端登记表（测试**读盘核对**每个文件都真实存在）

| 消费端 | 路径 | 取值方式 | 状态 |
| --- | --- | --- | --- |
| 域常量 | `packages/reference/constants.mjs` | `APPLICABILITY_RULE_VERSION`（唯一事实来源） | `single_source` |
| 规则引擎 | `packages/reference/deterministic.mjs` | 从 constants 引入，并回传于**每一条**判定结果 | `single_source` |
| 域查询 | `packages/reference/query.mjs` | `evaluateApplicability` 的 `rule_version` 默认值 | `single_source` |
| 域标签 | `packages/reference/labels.mjs` | `doseCardDescriptor` 的 `rule_version` 字段 | `single_source` |
| 后端路由 | `services/api/src/knowledge/reference-query.ts` | 经 `packages/reference/index.mjs` 消费，不另立版本 | `single_source` |
| 小程序适配层 | `miniprogram/utils/reference.js` | 跨运行时无法 import ⇒ **常量镜像** + 一致性测试断言同值 | `mirror_asserted` |
| 小程序详情页 | `miniprogram/pages/referencedetail/referencedetail.js` | 消费小程序适配层，页面展示同值 `rule_version` | `mirror_asserted` |
| OCR 用量闸门（**他人已合并**，用户 2026-10-14 授权纳入） | `services/api/src/ocr/state.ts` | **直接 import** 单一事实来源并导出 `DOSE_GATE_RULE_VERSION`；差异见 `DOSE_GATE_RULE_VERSION_DIFFERENCES` | `single_source`（**声明同版本**；语义差异登记为闭集 + 漂移检测断言，见 §2.5） |

### 2.3 跨端闭集同构（本轮实测出并修掉一处潜在分叉）

版本号同值还不够：若两端**阻断类别闭集**或**拒绝原因 → 阻断类别映射**不同，同一条记录会在两端
派生不同阻断理由。逐条比对发现 `no_confirmed_context` 原先**只在域库映射表**，镜像缺失会落到
`not_applicable` ⇒ 已补齐镜像映射，并新增断言（14 条阻断类别键名与值、2 个功能开关 ID、
16 条拒绝原因映射逐条同判）。

**负控制（证明该断言确实会咬）**：

```text
# 临时移除镜像 no_confirmed_context 两条映射（还原修复前状态）：
patched_old_mirror: removed 2 lines
✖ GY-I08 规则版本：跨端镜像的阻断类别闭集与拒绝原因映射必须同构 (1.1862ms)
  AssertionError [ERR_ASSERTION]: 同一拒绝原因在两端必须派生同一阻断类别
ℹ pass 7  ℹ fail 1
# 还原后（文件 SHA256 与修改前一致，300C505822A824DE4C6BD34DEE1D8687D61CE66E9DA09CD272B3A5D8DDCF36D5）：
[GY-I08] 跨端闭集同构：阻断类别=14 条、拒绝原因映射=16 条、功能开关=2 个，两端一致
ℹ pass 8  ℹ fail 0
```

### 2.4 功能关闭开关（fail-closed）

| 开关 | 关闭后 | 取值口径 |
| --- | --- | --- |
| `APP_GY_I08_EXECUTABLE_ENABLED` | **不产出可执行建议，也不产出用量卡** | 未设置 ⇒ 默认开启；`0/false/off/no` ⇒ 关；`1/true/on/yes` ⇒ 开；**其它任何取值 ⇒ 关并标 `unrecognized`**（拼错不得静默当作开启） |
| `APP_GY_I08_DOSE_CARD_ENABLED` | 不产出用量卡（建议仍按适用判定给出） | 同上；且**用量卡是建议的下位** —— 上层关闭时不得单独开着 |

开关只影响「是否产出建议／卡片」，**不改变适用结论**（`applicable` 仍如实反映条件是否适用），
因此页面能把「条件不适用」与「开关已关闭」分开表达。

### 2.5 跨线纳入同一规则版本：`services/api/src/ocr/state.ts` 声明 `gy-i08/1.2.0`

> **口径（监工 2026-10-14 CHANGES_REQUESTED 第 2 点）**：本节及全文出现「统一」时，
> **一律只指「纳入同一规则版本」**（版本号同源 + 差异登记 + 漂移可检测），
> **绝不表示「判定等同」**。本层与 GY-I08 层的**判定语义不同**，差异已逐项登记（见下），
> 且本页**不得**被引用为「OCR 判定已与 #8 适用过滤一致」。

**授权与回退**：用户 **2026-10-14** 授权改他人已合并文件（GY-I10 线）。改动为**纯声明 + 测试**，
**无行为改动**（未新增/放宽/收紧任何一条阻断判定，未改对外契约与错误码）；
**回退方式 = 删除该文件顶部的 import 与 `DOSE_GATE_RULE_VERSION` / `DOSE_GATE_REASON_BLOCK_CODES` /
`DOSE_GATE_REASONS` / `DOSE_GATE_RULE_VERSION_DIFFERENCES` 四个导出**，即还原为「未声明版本」。

**做的是**：版本值直接 `import { APPLICABILITY_RULE_VERSION } from '…/packages/reference/index.mjs'`
（**不是第二份拷贝**）；本层每个拒绝原因映射到域库 `BLOCK_CODES` 的**枚举成员本身**，
并由 `Record<DoseGateReason, string>` 让**穷尽性由 tsc 保证**（新增原因不映射 ⇒ `npm run lint` 失败）。

**没做、且本轮不能做的**：把 GY-I08 的**判定**搬进本层 —— 那是**行为改动**，两层本就不同层：

| | GY-I08 闸门（域库） | GY-I10 闸门（本层） |
| --- | --- | --- |
| 判定对象 | 内部记录（含 `verification` / `source` / 适用上下文） | **冻结契约载荷**（`DoseCardPayload` + 外层候选 + 登记制剂） |
| 判定内容 | 8 维度适用性（来源／**禁限用**／作物／生育期／地区／制剂／含量剂型／使用场景）+ 原文用量绑定 | 载荷完整性与绑定（`card` ↔ 请求条件 ↔ 登记制剂）+ 来源可信度（`source_kind`／`validity`／`review_status`／`simulated`） |

**如实登记的差异**：冻结契约 `DoseSource`（`packages/contracts/openapi.json`）只有
`source_kind` / `validity` / `review_status`，**没有任何禁限用字段** ⇒ 本层**数据形状无法表达**
`banned` / `restricted` / `restriction_unknown` 三类阻断（代码内登记为 `not_enforced_block_codes`）。
禁限用筛选在 GY-I08 适用过滤层完成；**真实统一需契约侧新增字段，超出本轮范围**。
因此本层**不声称判定已与 GY-I08 等同**，只声称「**同一规则版本 + 差异已登记 + 漂移可检测**」。
`services/api/src/knowledge/reference.d.ts` 相应补了 `APPLICABILITY_RULE_VERSION` 与
`BLOCK_CODES`（14 个具体键）的只读类型声明（加法，不改既有声明）。

**漂移检测（负控制实测）**：

```text
# 人为制造版本漂移：把域库常量由 gy-i08/1.2.0 改为 gy-i08/1.2.1
✖ GY-I08 规则版本：跨线用量闸门（GY-I10 线）已纳入同一版本，且版本漂移即失败
  AssertionError [ERR_ASSERTION]: 差异登记表必须针对**当前**规则版本复核过
ℹ pass 5  ℹ fail 3
# 还原为 1.2.0（文件 SHA256 与修改前一致：45DF49DA9D728B25EA4B96EE833306E4F9761A8EA918015D494EA0CFD1767094）
✔ GY-I08 规则版本：跨线用量闸门（GY-I10 线）已纳入同一版本，且版本漂移即失败
ℹ pass 8  ℹ fail 0
```

该测试同时断言：声明值 === 域库常量；映射目标全部落在 14 类闭集内；`DoseGateReason` 联合 ↔
映射表键**完全一致**（两份清单不得漂移）；未能表达的类别逐项列出；该文件内只允许**一处**版本
字面量（即复核锚点，不得再抄一份）；交叉线**无**剩余未声明的平行闸门。

## 3 100 组用例原始输出

命令：`node --test tests/reference/i08-scenarios-100.test.mjs tests/reference/i08-dose-guard-negatives.test.mjs`

```text
[GY-I08] 用例总数=159 通过=159 失败=0
[GY-I08] 分组计数: 登记=64 匹配=63 限制=32
[GY-I08] 放行(可执行建议或 matched)计数=53
[GY-I08] 用量卡可渲染计数=4（真实资料无用量列，正例仅用合成夹具）
[GY-I08] 被阻断类别逐类计数:
  no_source=15
  simulated_source=9
  invalid_source=19
  ambiguous_match=2
  field_conflict=13
  no_match=7
  unreviewed=13
  banned=5
  restricted=4
  restriction_unknown=7
  not_applicable=21
  missing_condition=4
  no_dose_source=79
  feature_closed=7
[GY-I08 P1] 只查登记号 → conflict/field_conflict；加 ingredients_text=40% → conflict/field_conflict、matched=null（修复前为 matched 且返回 A）；剂型单边收窄 → conflict/field_conflict；查另一个登记号 → matched
[GY-I08] 真实资料 DosCard 渲染计数=0（期望 0；用量正例为缺项/未取得）
```

用例集是**数据驱动表**（`SCENARIOS` 119 条 + `MATCH_CASES` 40 条 = **159 条**），逐例断言：

1. 期望的阻断类别**必须出现**，期望放行的**必须放行**，且放行集合内 `block_codes` 必须为空；
2. **被阻断的用例一律不得产出可执行建议与用量卡**（`executable=false` ⇒ `renderable=false` 且 `dose_count=0`）；
3. 每条判定必须回传同一 `rule_version`，阻断类别必须落在 14 类**闭集**内；
4. 阻断必须给出**可读原因**（不静默返回空），且原因不得含禁用词；
5. 每个阻断类别**至少被覆盖一次**（闭集无死角）且逐类计数均为正；
6. 登记匹配用例额外断言：`matched` 时必须有命中记录，**非 `matched` 时 `matched` 必须为 `null`**（不得返回被选中的候选）。

`MATCH_CASES`（40 条，状态取契约冻结闭集 `MatchState`）覆盖：无来源、模拟、失效（过期／撤回／
冲突／有效期未知／下架／删除／不可见）、多匹配（`ambiguous`）、**条件不足**（`insufficient`，
不静默选一）、无匹配（`no_match`）、**关键字段冲突**（`conflict`）、唯一命中（`matched`）；
其中 **MRG-031…MRG-040（10 条）为 P1 返修新增**（见 §10）。
`SCENARIOS` 的 63 条「匹配」覆盖 8 个适用维度与用量卡原文绑定。

`node --test` 汇总：**9 项测试全部通过，0 失败**。

## 4 用量卡守卫负例原始输出

```text
[GY-I08 负例] 负例总数=43 全部阻断用量卡=true 其中阻断可执行建议/登记匹配=33 仅阻断用量卡=10 正例=1（放行）
[GY-I08 负例] 类别计数: 未核对=5 不适用=7 禁用=5 无来源=9 模拟=3 失效=7 多匹配=2 关键字段冲突=5
[GY-I08 负例] 覆盖阻断类别: unreviewed,not_applicable,banned,restricted,restriction_unknown,no_source,invalid_source,field_conflict,simulated_source,ambiguous_match,missing_condition,no_match,no_dose_source,feature_closed
```

issue #8 点名的**八类**阻断逐条落成负例（示例，完整 43 条见测试原始输出）：

```text
负例 NEG-UNREVIEWED-01 [未核对] 记录级审核状态 unverified → 阻断可执行建议+用量卡(code=unreviewed) | 原因: 该用量未绑定已核对的审核状态，不展示用量
负例 NEG-NAPPLICABLE-05 [不适用] 成分名称子串不得命中（磺草酮 ≠ 硝磺草酮） → 阻断可执行建议+用量卡(code=not_applicable) | 原因: 有效成分/含量与所选不符
负例 NEG-BANNED-01 [禁用] 禁用状态（记录级） → 阻断可执行建议+用量卡(code=banned) | 原因: 该药剂为禁用状态，不得进入用量建议
负例 NEG-CONFLICT-05 [关键字段冲突] 同登记号下不同剂型/含量（不合并不同制剂） → 阻断(state=conflict, code=field_conflict) | 原因: 登记号 pd20210001 下存在关键字段冲突（名称/剂型/有效成分含量不一致），不合并不同制剂、不放行
负例 NEG-AMBIG-02 [多匹配] 多候选且未给出识别条件（条件不足，不静默选一） → 阻断(state=insufficient, code=missing_condition) | 原因: 存在 2 条候选且未给出登记号/名称/剂型/成分含量等识别条件，条件不足，不静默选取一条
负例 NEG-CLOSED-01 [不适用] 功能开关关闭 → 不产出可执行建议与用量卡 → 阻断可执行建议+用量卡(code=feature_closed) | 原因: 功能开关 APP_GY_I08_EXECUTABLE_ENABLED 已关闭：不产出可执行建议与用量卡
正例 POS-DOSE-01 非禁限用 + 已核对 + 完整绑定原文用量（合成夹具） → 放行(renderable=true, dose=40克/公顷, 条件=苗后茎叶喷雾)
```

**正例对照**（合成夹具）证明守卫**不是「恒阻断」**：只有全部条件齐备且绑定正确时才放行。
另有多条负例属「**仅阻断用量卡**」（记录本身可查阅），两者在输出里分开计数，不混为一谈。

## 5 严禁补造 · 真实资料用量仍为 0

真实资料 [`packages/knowledge/herbicides/records-2026.json`](../../packages/knowledge/herbicides/records-2026.json)
**没有用量列**，因此本轮不抽取、不推断、不补造：

```text
items=20
violating=0        # 逐条核对：usable_as_dose=false、dose_text=null、card_ready=false
```

`[GY-I08] 真实资料 DosCard 渲染计数=0` —— 凡依赖**真实用量正例**的场景一律标为**缺项／未取得**
（不编造通过）；4 张可渲染卡片全部来自**合成夹具**，并在输出中明示。

## 6 门禁（本轮实际执行的命令与结果）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 静态检查 | `npm run lint` | **通过**（API／后台 `tsc --noEmit` + 仓库卫生扫描：无禁用 TLS 写法／疑似硬编码密钥／真实 `.env`） |
| 参考域全量 | `npm run test:reference` | **276 项通过，0 失败**（含 159 场景 + 43 守卫负例 + P1 专项） |
| I10 受影响 | `node --test tests/unit/ocr-state.test.mjs tests/unit/ocr-service.test.mjs tests/unit/idempotency-job-ttl.test.mjs` | **125 项通过，0 失败** |
| 全量单测 | `npm run test:unit` | **1793 项：1792 通过、1 跳过（既有可选原生数据库跨连接边界检查）、0 失败**（合并 `upstream/main` `1865c64` 之后的树） |
| 文档检查 | `npm run test:docs` | **PASS**（27 任务／依赖无环／F-AC-Q 映射／Markdown 链接与表格） |
| 空白／冲突标记 | `git diff --check` | **无输出（exit 0）** |

本机 Node `v24.16.0`、npm `11.13.0`（满足 `engines` 的 `>=24.16.0 <25`）。依赖用 `npm install`
恢复（103 个包，`node_modules/` 已被忽略，未提交）。**未跑的不写通过**：本轮未执行构建、微信开发者
工具、真机与任何联网检查。

## 7 未取得 / 未验证项（不写「通过」）

1. **真实标签原文用量正例仍为 0**：真实资料没有用量列 ⇒ DoseCard 的**真实**正样本不存在，
   本轮只验证了负例（八类阻断恒不可渲染）与**合成夹具**正例。这是资料缺口，不是实现缺口。
2. **正式微信／Android 端到端未跑**：未做真实微信身份交换、未跑 ACE3V 真机、未跑微信开发者工具；
   小程序侧改动只有本仓测试（跨端同判 + 页面消费）覆盖，**不等于**真机可用。
   真机步骤沿用[手机最小清单](gy-i08-ace3v-checklist.md)。
3. **真实供应商调用未做**（未授权、不做）：无 OCR／LLM／TTS 调用，无付费请求。
4. **跨线用量闸门：规则版本已纳入，判定**未**等同（如实登记）**：`services/api/src/ocr/state.ts`
   （GY-I10 线）已按用户 **2026-10-14** 授权**声明同一规则版本**（`single_source`，见 §2.5），
   但**禁限用维度无法在本层表达**（冻结契约 `DoseSource` 无对应字段）⇒ **不得**声称
   「两层判定已等同」或「禁限用维度已覆盖全链路」。**判定层的真实统一需契约侧新增字段，
   需指挥决定是否另开契约变更线。**（口径见 §2.5 开头：本页「统一」只指**纳入同一规则版本**。）
5. **未推送**：写手不持有 GitHub 凭据，本轮只做本地提交，由指挥推送并创建 PR。
6. **真实部署形态未验证**：`packages/reference` 为纯文件 + 域库驱动，未在真实环境验证部署与
   只读文件可用性。
7. **契约侧缺口（沿用 GY-I07 登记）**：冻结契约 `Knowledge`／`Herbicide` 无 `visibility` 字段，
   `private`（未发布）只能在装配闸门与域库内表达，**无法**字段化到响应体。

## 8 PR 正文（可粘贴）

> **GY-I08 条件匹配与原文用量：确定性规则引擎 + 149 组用例 + 用量卡守卫闭集（Refs #8，部分交付，不关闭整项）**
>
> 本轮补 **#8 的整项验收缺口**（此前 PR #82／#90 交付组件级内容，其证据页把「整项 100 组与所有
> 消费端一致性」登记为未取得）。**不重复**已合并内容，只加装缺的两件能力并把它们做成可断言：
>
> **1) 确定性规则引擎**（`packages/reference/deterministic.mjs`，576 行，纯 ESM、零第三方依赖）：
> 复用既有 `evaluateApplicability`（8 维度 fail-closed）与 `doseCardDescriptor`（原文数字／单位／
> 条件绑定），补上登记侧判定（**无来源／模拟／失效／多匹配／条件不足／关键字段冲突六类一律阻断**，
> 多匹配任何路径都不静默选一）与**可执行建议闸门**（未核对／不适用／禁用不得进入可执行建议，
> 而不仅是用量卡）。14 类阻断为**闭集**，逐类可读、可计数。
>
> **2) 功能关闭开关**（`APP_GY_I08_EXECUTABLE_ENABLED` / `APP_GY_I08_DOSE_CARD_ENABLED`）：
> 关闭后**不产出可执行建议，也不产出用量卡**（此前只关卡片）；未识别取值 fail-closed 保守关闭；
> 开关只影响「是否产出建议」，不改变适用结论 —— 页面据此区分「条件不适用」与「开关已关闭」。
>
> **3) 同一规则版本可断言**（`gy-i08/1.2.0`，规格摘要 `gy-i08-spec+sha256:85c8e430…`）：
> 版本号由规则规格内容派生；常量全仓唯一一处定义；消费端登记表由测试**读盘核对文件真实存在**；
> 漂移检测禁止源码出现不同版本字面量；**跨端闭集同构断言**（14 类阻断 + 2 个开关 + 16 条拒绝原因
> 映射逐条同判）—— 该断言本轮实测出镜像缺 `no_confirmed_context` 会派生不同类别，已修，并用
> **负控制**证明断言确实会咬。
>
> **4) 用例与负例**：登记／匹配／限制 **149 组全部通过、0 失败**（登记 54／匹配 63／限制 32，
> 覆盖冲突、失效、未知、模拟），逐类阻断计数齐备；用量卡守卫**43 条负例**覆盖 issue 点名的
> 八类阻断，**全部阻断且无可执行建议**，另设 1 条合成夹具正例证明守卫不是恒阻断。
>
> **5) 严禁补造**：真实资料无用量列 ⇒ `dose_text` 保持 `null`、`usable_as_dose=false`、
> `card_ready=false`，**真实资料 DoseCard 渲染计数=0**；依赖真实用量正例的场景如实标为**缺项／未取得**。
> 风险文案不含「绝对安全／零药害」类承诺（全量标签扫描断言）。
>
> **6) 跨线：`ocr/state.ts` 用量闸门纳入 `gy-i08/1.2.0`（用户已授权；回退=删该改动）**：
> GY-I10 线的平行用量闸门此前**未声明**本规则版本，是「所有消费端使用同一规则版本」的缺口。
> 本轮按用户 2026-10-14 授权做**最小、无行为改动**的纳入（**只统一规则版本，不统一判定**）：
> 版本值**直接 import 域库单一事实来源**（不是第二份拷贝）；本层每个拒绝原因映射到域库
> `BLOCK_CODES` 枚举成员，穷尽性由 `tsc` 保证；两层语义差异**如实登记为闭集**
> （`not_enforced_block_codes` = 禁用／限用／未采集禁限用 —— 冻结契约 `DoseSource` 无禁限用字段，
> 本层数据形状无法表达）。**未**改变任何既有阻断语义、未动对外契约与错误码。新增**漂移检测**：
> 域库版本一变，`reviewed_against` 锚点即不匹配 ⇒ 测试失败（已给负控制：改为 `1.2.1` 时该断言失败；
> 还原后通过且文件 SHA256 不变）。**口径（监工第 2 点）**：本层**不声称**判定已与 GY-I08 等同 ——
> 「统一」仅指**纳入同一规则版本**（版本同源 + 差异登记 + 漂移可检测）；判定层真实统一需契约侧新增字段。
>
> **7) 返修（监工 P1，reviewed `a1ce99b`）**：`packages/reference/deterministic.mjs` 的
> `evaluateRegistrationMatch` 原本**先按名称／剂型／成分含量过滤、再只在 `filtered` 上判同登记号冲突**，
> 于是「输入选一侧」会把资料自身的冲突消掉（监工探针：两候选同登记号 `PD20210001`、含量 40%／50%
> 矛盾 ⇒ 只查登记号返回 `conflict`，加 `ingredients_text=40%` 返回 **`matched` 且选中 A**）。
> **已修：冲突判定移到输入收窄之前** —— 范围 `scope` **只允许由登记号收窄**（登记号是登记制剂身份；
> 名称／剂型／成分含量正是互相矛盾的关键字段本身，不得用于收窄）。新增 MRG-031…MRG-040 同形用例与
> P1 专项断言（含「剂型单边收窄同样否决」的非补丁证明、「显式查另一个登记号不误伤」的边界、
> 「同登记号同身份仍判 `ambiguous`」的回归）。**负控制**：把冲突范围临时改回「按全部输入条件收窄」
> ⇒ MRG-032/033/034/035 与专项用例失败（`state 期望 conflict 实际 matched`、`缺少阻断类别 field_conflict`、
> `state 非 matched 却返回了命中记录`）；还原后 **159/159 通过**、文件 SHA256 不变。
> **未**放宽任何阻断断言；用例数由 149 **增至 159**（未改小）。
>
> **门禁**：`npm run lint` 通过（含 API `tsc --noEmit`）；`npm run test:reference` **276 项通过 0 失败**；
> `npm run test:unit` **1784 项（1783 通过、1 既有可选原生数据库检查跳过、0 失败）**；
> I10 受影响测试 `ocr-state` / `ocr-service` / `idempotency-job-ttl` **125 项通过 0 失败**；
> `npm run test:docs` PASS；`git diff --check` 无输出。
>
> **未取得（不写通过）**：真实标签用量正例仍为 0；正式微信／Android 端到端未跑；真实供应商调用未做
> （未授权）；跨线**判定未等同**（禁限用维度受契约字段限制，见上 6）；本轮只做本地提交，**由指挥推送**。

## 9 提交

| SHA | 内容 |
| --- | --- |
| `c135b6c57b618137acaa351ab8881fb9015627dc` | `feat(GY-I08)`：确定性规则引擎（`deterministic.mjs` + `query.mjs` 导出 + `index.mjs` 导出） |
| `a60b32d` | `feat(GY-I08)`：小程序镜像闸门／开关 + 详情页消费同判（含闭集补齐） |
| `9cbe50c5e30c4013cc37fda884e8abaac27ff627` | `test(GY-I08)`：149 组用例 + 43 条守卫负例 + 规则版本可断言化 |
| `8957f58` | `docs(GY-I08)`：本页初版（规则引擎／消费端同版本／原始输出／未取得项） |
| `a1ce99bc9af1b899cc9a825ccb38f7e62857c418` | `feat(GY-I08)`：跨线**纳入同一规则版本**（`ocr/state.ts` 声明 `gy-i08/1.2.0`；纯声明 + 漂移检测，**无行为改动**）—— 监工 reviewed_sha |
| **（本页所在提交）** | `fix(GY-I08)`：**P1 返修** —— `evaluateRegistrationMatch` 的**同登记号冲突判定移到输入收窄之前**（收窄条件不得消除冲突）；含 10 条同形用例 + P1 专项断言 + 本页 §2.5 口径收紧与 §10 |

`git diff --stat upstream/main...HEAD`：**12 个文件**（P1 返修只改动其中 3 个已在 diff 内的文件：
`packages/reference/deterministic.mjs`、`tests/reference/i08-scenarios-100.test.mjs`、本页）。
**本页不写自身提交的 SHA 与精确行数**（自引用会随文字微调失真）：最终 HEAD SHA 与 diffstat
由指挥在 PR 评论绑定。

**主线同步**：本轮已 `git fetch upstream --prune` 并 `git merge upstream/main`
（`upstream/main` 由 `72c4923` 前进到 **`1865c64`**，即 GY-I17 消息三端点 #138 等）；
合并提交 `0f8a55b`（两父：`a1ce99b` 与本分支 + `1865c64`），**无冲突**；P1 返修提交在其之上。
合并后的树重跑了全部门禁（见 §6，`test:unit` 计入了主线新增测试 ⇒ 1793 项）。0 提交落后 main。

## 10 P1 返修（监工 2026-10-14 CHANGES_REQUESTED）

**监工原文（逐字要点）**：
> P1：`packages/reference/deterministic.mjs:412-432` 先按名称/剂型/成分含量过滤，再只在 filtered 检查
> 同登记号冲突，查询条件会隐藏原候选的关键字段冲突。…**两候选均 published/valid/verified、同登记号
> `PD20210001`，但成分含量 40%/50% 矛盾；只查登记号返回 conflict/field_conflict；增加
> `ingredients_text=40%` 后返回 matched、block_codes=[]、选中 A。** …**请保留同登记号资料冲突的阻断，
> 不能把已存在冲突由输入选择一侧后消除。**

### 10.1 根因

判定顺序为「**先收窄、后判冲突**」：冲突检查作用在 `filtered`（已被查询条件过滤后的集合）上。
调用方给出的名称／剂型／成分含量条件会把冲突对收窄到其中一条，于是同登记号组内只剩 1 条候选、
冲突自然消失 ⇒ `matched`。而这三类条件**正是互相矛盾的关键字段本身**，用它们收窄等于「选一侧」。

### 10.2 修法（最小、fail-closed）

`evaluateRegistrationMatch` 的判定顺序改为：

```text
（原）1 空候选 → 2 来源侧分类 → 3 条件不足 → 4 按全部条件过滤 → 5 在 filtered 上判同登记号冲突 → 6 ambiguous → 7 matched
（新）1 空候选 → 2 来源侧分类 → 3 **在输入收窄之前判同登记号冲突** → 4 条件不足 → 5 按全部条件过滤 → 6 ambiguous → 7 matched
```

- 新增 `sameRegistrationConflict(candidates)`：按登记号分组，组内 `formulationIdentityHash`
  （登记号／名称／剂型／有效成分含量）出现多种 ⇒ 冲突。**只比较同一登记号内部**（跨登记号不冲突）。
- 冲突范围 `scope` **只允许由登记号收窄**：`query.registration_number` 为空时取全部合格候选，
  否则只取该登记号的候选。**名称／剂型／成分含量不参与范围收窄。**
- 因 `filtered ⊆ scope`，收窄之后再判一次是冗余的；冲突判定只保留在收窄之前（单点、不易漏改）。
- 理由与依据：登记号是**同一授权制剂的身份**，显式查询**另一个**登记号才是合法收窄；
  而「关键字段冲突均阻断」「模型或用户选中候选不能绕过」（issue #8 / 需求 §6.1）要求
  **输入不得改变冲突结论**。**未**放宽任何阻断；此处取保守阻断（fail-closed）。

### 10.3 同形用例（MRG-031…MRG-040，均为 published + valid + verified）

| 用例 | 输入收窄 | 修复前 | 修复后（断言） |
| --- | --- | --- | --- |
| MRG-031 | 只查登记号 `PD20210001` | `conflict`（对照基线） | `conflict` / `field_conflict` |
| **MRG-032** | **+ `ingredients_text=40%`（选 A 一侧，监工探针）** | **`matched`、`block_codes=[]`、返回 A** | **`conflict` / `field_conflict`、`matched=null`** |
| MRG-033 | + `ingredients_text=50%`（另一侧） | `matched` | `conflict` / `field_conflict` |
| MRG-034 | + `dosage_form`（矛盾字段之一，单边） | `matched` | `conflict` / `field_conflict` |
| MRG-035 | + `registered_name`（矛盾字段之一，单边） | `matched` | `conflict` / `field_conflict` |
| MRG-036 | 无任何识别条件 | `insufficient` | `conflict`（更具体的原因，仍阻断） |
| MRG-037 | 显式查不到的登记号 | `no_match` | `no_match`（不误判为冲突） |
| MRG-038 | 显式查**另一个无冲突**登记号 | `matched` | `matched`（冲突组在范围外，不误伤） |
| MRG-039 | 同登记号**同身份**重复两条 | `ambiguous` | `ambiguous`（不得判成冲突） |
| MRG-040 | 不同登记号 + 含量收窄 | `matched` | `matched`（跨登记号不互相冲突） |

另有专项用例 `GY-I08 P1 返修：同登记号资料冲突不得被输入收窄消除（监工 2026-10-14 探针）`，
直接断言 `matched === null`、`block_codes` 恰为 `[field_conflict]`，并覆盖 MRG-034 的剂型单边场景与
MRG-038 的边界。

### 10.4 改前 / 改后原始输出

**改前（负控制：冲突范围回退为「按全部输入条件收窄」）**：

```text
[GY-I08] 失败明细:
  MRG-032: state 期望 conflict 实际 matched | 缺少阻断类别 field_conflict（实际 无） | state 非 matched 却返回了命中记录（不得放行） | 阻断必须给出可读原因（AC02）
  MRG-033: state 期望 conflict 实际 matched | 缺少阻断类别 field_conflict（实际 无） | state 非 matched 却返回了命中记录（不得放行） | 阻断必须给出可读原因（AC02）
  MRG-034: state 期望 conflict 实际 matched | 缺少阻断类别 field_conflict（实际 无） | state 非 matched 却返回了命中记录（不得放行） | 阻断必须给出可读原因（AC02）
  MRG-035: state 期望 conflict 实际 matched | 缺少阻断类别 field_conflict（实际 无） | state 非 matched 却返回了命中记录（不得放行） | 阻断必须给出可读原因（AC02）
✖ GY-I08 用例集：登记／匹配／限制 ≥100 组，全部通过
✖ GY-I08 P1 返修：同登记号资料冲突不得被输入收窄消除（监工 2026-10-14 探针）
  AssertionError [ERR_ASSERTION]: 收窄条件不得把同登记号资料冲突变成 matched
ℹ tests 7  pass 5  fail 2
```

**改后（修复态）**：

```text
[GY-I08 P1] 只查登记号 → conflict/field_conflict；加 ingredients_text=40% → conflict/field_conflict、matched=null（修复前为 matched 且返回 A）；剂型单边收窄 → conflict/field_conflict；查另一个登记号 → matched
[GY-I08] 用例总数=159 通过=159 失败=0
ℹ tests 9  pass 9  fail 0        （本文件）
```

**负控制（含文件 SHA256）**：

```text
before_sha   = 46A375B23FB585375A2160BDDDE919BC3A1CF32FE6BFEFF3FFA7EA1091C57644   # packages/reference/deterministic.mjs（修复态）
patched: 冲突范围回退为「按全部输入条件收窄」（修复前语义）  → 上述改前输出（fail 2）
restored: 冲突范围恢复为「仅登记号可收窄」（修复态）
after_restore_sha = 46A375B23FB585375A2160BDDDE919BC3A1CF32FE6BFEFF3FFA7EA1091C57644   # 与 before_sha 一致
→ 159/159 通过、9/9 测试通过
```

### 10.5 范围与边界（未扩项）

- **未**放宽任何阻断断言；**未**把用例数改小（149 → **159**）；43 条守卫负例保持不变。
- **未**新增变异／穷举／重复 PG／供应商调用；**只**针对「同登记号 + 收窄条件」这一处修复并验证。
- `evaluateRegistrationMatch` **只存在于域库**（小程序镜像无同名函数，已 grep 确认）⇒ 无同源镜像需同步；
  该函数无 HTTP 契约暴露面，**未**改动对外契约与错误码。
- 真实用量正例仍为 0、OCR 禁限用维度未贯通、正式端侧未验：**属整项 #8 剩余**，不附加到这处局部返修。

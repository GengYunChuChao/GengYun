# GY-R34 · #14 真实审核端口「库件」交付（TMS 文本 / IMS 图片）

- 基线：`upstream/main` = **`765b6a31d993995e5dacbf6a3227ebcbb97fd8df`**（开工与交付时两次实测；开工后未再前进）。
- 工作树 `wt-r34-i14-adapter`，分支 `fix/gy-r34-i14-moderation-live-adapter`。
- 口径：本文把「代码事实」与「未取得」分开写；**凡未跑过的命令一律进 §4，不冒充实测**。
- 边界（本片**没有**做的事）：不改 `services/api/src/app.ts`／`server.ts`／`moderation/provider.ts` 的 `real` 分支，
  不改 `packages/contracts/**`，不加迁移，不改 `docs/architecture/contract-status.json`，
  不重构既有 asr/ocr 适配器，零真实外呼、零真实凭据、零新增依赖。

## 0 结论摘要

1. **缺口是真的，且本片只补了它的一半。** `services/api/src/moderation/provider.ts` 的注释原文写着
   「真实端口必须由真实适配器 ＋ 一次显式、可审查的接线变更提供（**本阶段不存在这样的适配器**）」，
   对应 `real` 分支恒返回 `{ execution_mode:'real', ports:{}, substitutes:[], fail_closed:true }`
   （`services/api/src/moderation/provider.ts:104-113`）。本片交付的是**那个适配器本身**（库件），
   **不接线**：`provider.ts` 一个字符都没动，`real` 行为逐字节不变。
2. **适配器是"注入式、默认关闭"的**：策略快照 / 被校验配置快照 / 凭据三元组 / 图片字节来源全部必填、
   零默认实现；`policySelectionVerified !== true` 或 `executionAllowed !== true` ⇒ **构造期硬拒**
   （`services/api/src/moderation/live-ports.ts:208-226`）。拿不到端口对象，就不可能发出请求。
3. **失败绝不产出通过**：`Review`／未知 `Suggestion` 映射为 `unsure`（合流层记 `MODEL_NOT_EVALUATED` ⇒ 隔离）；
   其余失败一律抛 `ModerationPortError`，类别落在与既有分类器**逐项相同**的六值闭集上。
4. **未取得**（必须连同结论一起读）：零真实外呼、无真实凭据、BizType 未核（`policySelectionVerified`
   在 `tools/ai-config.mjs` 里对审核**恒为 `false`**）、无真实样本、预算/台账闸门未接。
   ⇒ 本片**不构成**「AI 审核已上线」，也不产生任何准确率/召回率/误放行率结论。
5. **R34 返修（本提交）**：订正 §4 第 3 条把 ⑥ 说成"会因 `app.ts` 变红"的**错误可执行指导**（审查 B1），
   把结构判据升级为 `moderation/**` **目录级**（两个真实装配点首次被覆盖，注入探针实测 **1 fail**，见 §4.1）；
   同时收紧 N1（端口字面拒绝前导零）、N2（构造期深拷贝＋冻结）、N5（`JSON.stringify` 脱敏），
   并订正 N3/N4/N6 的表述（见 §5 / §6）。**行为未变**：`real` 仍恒空端口表、零真实外呼。

## 1 已实现什么

全部为**新增文件**，都放在 `services/api/src/moderation/` 下，且**不从 `index.ts` 再导出**——
这样应用装配路径连"顺手 import 一下"的入口都没有（见 §3 的零命中断言）。

| 文件 | 内容 | 关键实现 |
| --- | --- | --- |
| `services/api/src/moderation/live-ports.ts` | 注入契约 + 冻结剖面 + 策略闸门 | 端点数/动作/版本/区域/上限逐字对齐 `tools/ai-config.mjs`；`assertModerationPolicyOpen` 只认 `=== true`；`ModerationLivePort` **编译器强制**扩展 `provider.ts` 的 `ModerationPortLike`（`live-ports.ts:301-319`） |
| `services/api/src/moderation/live-tc3.ts` | TC3-HMAC-SHA256 签名（`tms`/`ims` 共用） | 只用 `node:crypto`；签名绑定**实际发出的那串字节**；端点审计只放行生产端点或 `http://127.0.0.1:<1024..65535>`（端口**无前导零**）（`live-tc3.ts:71-89`、`live-tc3.ts:144-172`） |
| `services/api/src/moderation/live-vendor.ts` | 供应商回报 → 本仓闭集的唯一映射点 | 只回 `label`/`reason_codes`/`summary` 三键；控制字段整条拒绝；HTTP/供应商码 → 失败类别（`live-vendor.ts:86-95`、`live-vendor.ts:204-229`） |
| `services/api/src/moderation/tms-live-adapter.ts` | TMS 文本端口 | `createLiveModerationTextPort()`：build(本地) → sign → send 恰好一次 → 解析（`tms-live-adapter.ts:60-152`） |
| `services/api/src/moderation/ims-live-adapter.ts` | IMS 图片端口 | `createLiveModerationImagePort()`：多图逐张各一次，任一 `Block` ⇒ `block`；2 MiB 上限（`ims-live-adapter.ts:57-161`） |
| `tests/unit/moderation-live-adapter.test.mjs` | 全离线回归（**34 条**；其中 5 条为 R34 返修新增：目录级结构 1 ＋ 构造期快照 3 ＋ 脱敏序列化 1） | `node:http` 假服务器跑在 `127.0.0.1` 随机端口；签名用**独立第二实现**复算 |

### 1.1 端口形状与回报闭集

- 形状由类型强制：`ModerationLivePort extends ModerationPortLike`，因此 `kind` / `model_version` /
  `evaluate` / `seams`（`fetchImpl`/`credentials`/`liveGate`/`now` 四项齐全）/ `provider`
  （`biz_type` / `biz_type_selection_verified` / `synthetic` / `timeout_ms`）一个都不能缺。
  用例另跑 `validateModelPort(port, 'tms')` 断言合流层**接受**该端口（`reason_codes` 为空）。
- `evaluate()` 的返回值是**重新构造**的 `{ label, reason_codes, summary }`：不是把供应商对象摊平。
  控制类字段（角色 / scope / 来源 / 可见性 / 发布 / 决策 / 人审 / 票决 / 训练开关）**没有任何路径**进入结果。
  `provider.ts` 的 `guardModelPort` 是第二道闸（用例里有"故意撒谎的端口"被它拦下的反例）。

### 1.2 结果映射（`live-vendor.ts`）

| 供应商 `Suggestion` | 本仓标签 | 原因码 |
| --- | --- | --- |
| `Pass` | `pass` | `MODERATION_PROVIDER_SUGGESTION_PASS` |
| `Block` | `block` | `MODERATION_PROVIDER_SUGGESTION_BLOCK` |
| `Review` | **`unsure`**（不是通过） | `MODERATION_PROVIDER_SUGGESTION_REVIEW` |
| 其他/缺失 | **`unsure`** | `MODERATION_PROVIDER_SUGGESTION_UNKNOWN` |

- `Label` 进原因码，但只允许**供应商枚举令牌的字面**（字母开头、仅 `[A-Za-z0-9_]`、≤32 字符）：
  自由文本（空格/引号/换行/中文/链接）一个字都进不来，认不出的形态一律落
  `MODERATION_PROVIDER_LABEL_UNRECOGNIZED`。
- `Score` 只进 `summary`（合流层只保留 summary 的**长度**），**不得**成为任何控制字段。
- `summary` 会含**供应商原文**（`Label` 自由文本、`Score`、换行等），**仅受 200 字符长度限制**，未做出圈
  字符清洗；合流层当前只消费 `summary_length`，故不外泄，但将来任何展示 `summary` 的消费者都必须把它
  当作不可信文本（见 §6 第 4 条）。

### 1.3 失败映射（逐条对齐既有分类器，见 `live-vendor.ts:86-95`）

| 形态 | 类别 | 合流层原因码 |
| --- | --- | --- |
| `TimeoutError`/`AbortError`（`AbortSignal.timeout`） | `timeout` | `MODEL_TIMEOUT` |
| HTTP 429 | `quota_exceeded` | `MODEL_QUOTA_EXCEEDED` |
| HTTP 401/403 | `auth_failed` | `MODEL_AUTH_FAILED` |
| HTTP 400/413/422 | `payload_invalid` | `MODEL_PAYLOAD_INVALID` |
| HTTP 5xx / 其余状态 / 传输层异常 | `port_error` | `MODEL_PORT_ERROR` |
| 非 JSON / 缺 `Response` / `Response` 不是对象 | `port_error` | `MODEL_PORT_ERROR` |
| 供应商回体自带控制类字段 | `response_shape_unknown` | `MODEL_RESPONSE_SHAPE_UNKNOWN` |

本片**不重新实现分类器**：抛出的 `ModerationPortError` 带 `model_failure` 字段，合流层的既有分类器优先采信它；
用例对每一条都额外断言 `classifyModelFailure(错误) === 声明类别`（两份口径不一致就会红）。

## 2 结构证明：产品装配路径**没有** import 任何真实适配器

```
$ git grep -n -E "tms-live-adapter|ims-live-adapter|live-tc3|live-vendor|createLiveModerationTextPort|createLiveModerationImagePort" -- services/api/src/app.ts services/api/src/server.ts
（0 命中，退出码 1）

$ git grep -n --untracked -E "createLiveModerationTextPort|createLiveModerationImagePort" -- services/api/src
（只命中 tms-live-adapter.ts / ims-live-adapter.ts 自身的 `export function` 行，产品装配文件 0 命中）
```

同一条判据也写进了用例（`⑥ 结构回归：app.ts / server.ts 与统一出口都不 import 本片的真实适配器`）：
去注释后对 `app.ts`、`server.ts`、`moderation/index.ts` 逐个断言
`tms-live-adapter` / `ims-live-adapter` / `live-tc3` / `live-vendor` / `createLiveModeration*` 零命中。
这与 `tests/integration/tts-http.mjs` 的 S01（「app.ts（去注释）不 import 真实适配器端口构造器」）同一条纪律。

**R34 返修起，判据升级为目录级规则**（原判据只硬编码三份文件，`provider.ts` / `service.ts` 不在其中，
见 §4 第 3 条与 §4.1）：用例用 `readdir` **动态枚举** `services/api/src/moderation/**`（**不写死文件清单**，
将来新增的文件自动进入扫描面），断言除本片 `live-*` 库件（`live-ports.ts` / `live-tc3.ts` / `live-vendor.ts` /
`tms-live-adapter.ts` / `ims-live-adapter.ts`）外，任何文件出现 `createLiveModerationTextPort` /
`createLiveModerationImagePort` / `tms-live-adapter` / `ims-live-adapter` 字样即**红**；
`app.ts` / `server.ts` / `index.ts` 的既有断言保留。两个点名的装配点（`provider.ts` / `service.ts`）
因此首次真正被机器判据覆盖。

`git diff upstream/main --stat` 也证明本片**只新增文件**、不改任何既有文件（`provider.ts` 的 `real` 分支逐字节不变）。

## 3 未取得（不得当作实测）

1. **零真实外呼**：本片一次都没有调用 `tms.tencentcloudapi.com` / `ims.tencentcloudapi.com`。
   所有"真实往返"都是 `127.0.0.1` 上的 `node:http` 假服务器。
2. **BizType 未核**：`tools/ai-config.mjs:69` 的 `policySelectionVerified` 对 `moderation*` **恒为 `false`**
   （BizType 是自描述占位值，控制台策略是否与期望一致从未被独立核对）。适配器因此在本阶段**构造不出来**——
   这不是缺陷，而是如实反映"授权还没发生"。
3. **策略闸门仍关**：`executionAllowed` 对全部端点**恒为 `false`**。打开它属于**授权**动作，不是本片能做的改动。
4. **无真实凭据**：本片不读 `process.env`、不读私密文件序列化，用例里的 `secretId`/`secretKey` 是合成串
   （`synthetic-*-not-a-secret`），线上字节里也不含 SecretKey（用例有负控制断言）。
5. **无真实样本**：`docs/evaluation/sample-gap-register.md` 已确认 `ai_moderation_risk` / `ai_moderation_normal`
   真实样本**各为 0** ⇒ 本片不产生、也不声称任何准确率/召回率/误放行率结论。
6. **预算/台账闸门未接**：`LiveCallGate` 的能力闭集是 `tts|ocr|asr`（`services/api/src/tts/live-ports.ts`），
   且该文件明确写了"零共享文件、各域各自分支"。扩它属于跨域改动、且会与在飞片冲突 ⇒ 本片**不构造第二套预算闸门**，
   只做构造期硬拒；`seams.liveGate` 槽位装的是**策略闸门快照**（合流层要求四个 seam 都显式持有）。
   ⇒ **这是本片最需要在接线前解决的一项**：真实付费调用前必须有一次等价的 reserve→send→settle 台账。
7. **送审文本上限 200 码点**（口径＝`tools/ai-config.mjs` 的 `textInput(input, 200)`），超限 fail-closed
   **不截断**（截断会让"只审了前 200 字"冒充"整段已审"）。长文本口径需在接线时重新裁定。
8. **单任务最多 9 张图**，超上界整条 fail-closed（不"只审一张就放行"）。真实帖子的图片张数口径未核。
9. **`README`/证据页以外的文档未同步**：`docs/moderation/http-layer.md` 等仍描述"没有真实适配器"的旧状态，
   本片按派单不改（避免与在飞片撞车）。

## 4 后续如何授权开启（**必须是一次独立的、可审查的接线变更**）

本片**不能**自己打开真实外呼。开启需要依次做完下面四步，每一步都应是一条独立可审的改动：

1. **供应商侧**：拿到两个真实 `BizType`，并独立核对控制台策略（这是 `policySelectionVerified` 唯一可能翻成 `true` 的途径）。
2. **预算/台账闸门**：给审核域补一个与 `LiveCallGate` 语义等价的 reserve→send→settle 台账
   （见 §3 第 6 条），并把 `seams.liveGate` 从"策略快照"换成真正的闸门对象。
3. **装配点（两处，缺一不可）**：① `services/api/src/moderation/provider.ts` 的 `resolveModerationPorts`
   在 `real` 下仍恒返回空端口表；② 更前一道是 `services/api/src/moderation/service.ts` 的
   `createModerationService()` —— 它在 `deps.executionMode === 'real'` 时**直接**返回
   `createFailClosedModerationService()`，**连端口解析都不会走到**。⇒ 真实接线必须**同时**改这两处，
   属本片明确排除的范围。
   **「接线发生了」的机器信号（R34 返修后已订正）**：⑥ 结构回归现在覆盖 `services/api/src/moderation/**`
   **全目录**——只有本片 `live-*` 库件自身可以出现真实构造器/模块名，`provider.ts` / `service.ts` / `index.ts`
   及任何未来新增的非 `live-*` 文件都必须 0 命中（§2）。**上一版**本条写的「改完重跑 ⑥ 会因 `app.ts`
   出现 import 而变红」**不成立**：当时 ⑥ 只硬编码扫 `app.ts` / `server.ts` / `index.ts`，按本条点名的
   两个装配点注入真实构造器 import 后全部门禁仍然全绿（审查报告 P9 / B1）。返修后的注入探针读数见 §4.1。
4. **付费授权**：真实外呼需要用户**单独授权**（`AGENTS.md`：新增付费验证需用户单独授权）。
   ⇒ 在那之前，`real` 模式继续整域 503 `PROVIDER_UNAVAILABLE`，这是当前**正确**的行为。

### 4.1 R34 返修：阻塞项的注入探针（A2，原始输出）

目的：证明「接线发生了」的机器信号真的存在，而不是只覆盖 `app.ts` 一处。做法：在 §4 第 3 条点名的
**两个装配点**各加**一行真实构造器 import**（并 `export const` 引用以免被当成未使用），跑 ⑥ 的新目录级用例。

```
$ git hash-object services/api/src/moderation/provider.ts services/api/src/moderation/service.ts
# 注入前
807e8bc82142fd1a93ba79f1413fcdcef5bc8789
89e9f8566f4a6c4bf196a0135a417145c7064d83

# 注入（各一行，均为真实构造器 import）：
#   provider.ts: import { createLiveModerationTextPort } from './tms-live-adapter.ts';
#   service.ts : import { createLiveModerationImagePort } from './ims-live-adapter.ts';
$ git hash-object …（注入后）
1d59edc89b97d8aac52737576f998974090fabac
b73e5882d2232d657f451538dbabfcdec84ecd1d

$ node --test --test-reporter=tap tests/unit/moderation-live-adapter.test.mjs
not ok 26 - ⑥ 结构回归：moderation/** 目录级 —— 除本片 live-* 库件（含 tms/ims-live-adapter）外，真实适配器符号与模块名必须 0 命中
    真实适配器只允许出现在本片 live-* 库件内部：provider.ts → createLiveModerationTextPort;
    provider.ts → tms-live-adapter; service.ts → createLiveModerationImagePort; service.ts → ims-live-adapter
# tests 34
# pass 33
# fail 1
EXIT=1
$ npx tsc -p services/api/tsconfig.json --noEmit ⇒ exit 0（注入后的接线形态类型合法，红的是结构判据）

$ git checkout -- services/api/src/moderation/provider.ts services/api/src/moderation/service.ts
$ git hash-object …（还原后）
807e8bc82142fd1a93ba79f1413fcdcef5bc8789
89e9f8566f4a6c4bf196a0135a417145c7064d83   ⇒ 与注入前逐字一致
$ git grep -n "__PROBE_A2__" -- services/api/src/moderation   ⇒ 零命中（exit 1）
$ git status --short ⇒ 6 行（仅本片本轮改动；注入探针自身零残留）
```

> 说明：注入探针运行时的 `git status` 行数 = **8**（本轮 6 处未提交改动：4 个实现文件 ＋ 1 个用例文件
> ＋ 证据页，另加 2 个被注入的装配点）；`git checkout --` 还原后回到 **6**，两个文件 blob 与注入前
> 逐字一致（`807e8bc8…` / `89e9f856…`），`__PROBE_A2__` 标记零命中。

## 5 本片实测读数（可复现命令）

Node `v24.16.0`，工作树 `wt-r34-i14-adapter`，`npm ci --prefer-offline --no-audit --no-fund --ignore-scripts`
（`added 103 packages`；`git status --short` 证明 `package-lock.json` 未变）。

| 命令 | 读数 |
| --- | --- |
| `node --test tests/unit/moderation-live-adapter.test.mjs` | tests **34** / pass **34** / fail **0**（exit 0） |
| `node --test tests/unit/community-moderation-gate-wiring.test.mjs tests/unit/community-moderation-publish.test.mjs` | tests **16** / pass **16** / fail **0**（exit 0） |
| `node --test` 枚举 `tests/moderation/*.test.mjs`（**20 个文件**） | tests **364** / pass **364** / fail **0**（exit 0）；单跑 `model-ports.test.mjs` = **39 / 39**（含"未列出的新文件命中仍判失败"的白名单扫描） |
| `node --test tests/unit/retryable-fallback-inventory.test.mjs tests/unit/runtime-strings-truth.test.mjs tests/unit/gy-i22-identity-headers.test.mjs tests/unit/error-retryable-static-guard.test.mjs` | tests **16** / pass **16** / fail **0**（exit 0）——**三份全 `services/api/src` 扫描**（`retryable-fallback-inventory` / `runtime-strings-truth` / `gy-i22-identity-headers`）＋ **一份范围不含 `moderation`**（`error-retryable-static-guard` 的 `SCOPE_DIRS = ['db','privacy','conversations','admin/ops','ocr','speech','recognitions','media']`，不含 `moderation` ⇒ 对本片零覆盖） |
| `npx tsc -p services/api/tsconfig.json --noEmit` | exit **0** |
| `node tools/verify-doc-anchors.mjs --strict` | exit **0**（本文新增的行号锚点全部落在实存文件与合法区间内） |
| `node tools/verify-contract-status.mjs` | PASS（契约台账未被本片触碰） |

## 6 口径与取舍（留档，便于审查者判断是否同意）

1. **为什么端点审计额外允许 `http://127.0.0.1:<port>`**：离线用例要把请求真的打到本地假服务器，
   才能证明"签名绑定的是实际发出的那串字节"。回环目的地**不可能**把待审内容外泄给第三方，
   因此放行它在安全性上是中性的；形态被钉死成**唯一主机＋唯一端口区间**（`127.0.0.1` + 端口
   **1024..65535** + 无路径/查询/片段），且**拒绝任何前导零写法**（`01024` / `041234` 均 REJECT；
   正则端口段以 `[1-9]` 开头，不靠 `Number()` 归一）。生产端点仍然**逐字**等于
   `tools/ai-config.mjs` 的值，差一个字符即拒绝。
2. **为什么不复用 `services/api/src/tts/tc3.ts` 的签名函数**：那份实现从端点主机名首段取 TC3 service，
   无法表达回环端点（`127.0.0.1` 的首段是 `127`）。本片把 service 与 host 显式分开，生产口径与它逐字节一致。
   ⛔ 本片**没有**去合并/抽取既有 asr/ocr 的重复签名（派单明确禁止）。
3. **为什么标签/失败类别在 `live-ports.ts` 里各留一份局部闭集**：`tests/moderation/model-ports.test.mjs` 用
   **逐文件白名单**限制 `moderation/**` 里哪些文件可以引用模型合流符号，并写明"该目录里未列出的新文件命中仍判失败"。
   本片**不申请扩大那份白名单**（放宽门禁不是本片该做的事），改为留局部副本 + 在用例里**逐项断言**它与上游相等——
   漂移会立刻变红。
4. **供应商回报也过控制字段扫描**：供应商回体是外部不可信输入，**`Response` 内**自带角色/来源/可见性等
   字段时**整条拒绝**（不是静默忽略）。**边界如实说明**：`Response` **之外**（根级）的同名字段**不触发
   拒绝**，也不会传播——返回值只从 `Response` 白名单取 3 个标量**重建**，根级字段根本没有进入结果的路径。
   扫描复用 `nonbypass.ts` 的既有实现，因此限额语义一致（**未检查 ≠ 干净**）。
   送审文本被限在 200 码点以内，正是为了让正常回报的键数远低于该扫描上界。
5. **构造期快照（深拷贝＋冻结）**：`profile` / `credentials` 在构造时**复制并冻结**，端口只读这份拷贝；
   构造之后改写调用方对象里的 `bizType` / `secretKey` / `timeoutMs` **不再影响**已构造端口的线上字节、
   签名与超时，`port.provider.biz_type` / `timeout_ms` 也从拷贝取。三条用例分别钉住这三项（N2）。
6. **`JSON.stringify(port)` 已脱敏**：端口实现 `toJSON()`，只返回 `kind` / `model_version` / `provider` /
   脱敏的 `seams`（`credentials: { kind: 'redacted' }`）/ 方法标记；`secretId` / `secretKey` /
   `sessionToken` 一个都不出现（用例断言序列化结果不含合成密钥与 SecretId）。端口对象自身仍按字段
   持有凭据（签名需要），只是不参与序列化（N5）。

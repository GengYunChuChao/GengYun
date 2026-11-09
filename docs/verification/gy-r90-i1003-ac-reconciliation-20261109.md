# GY-R90 · `#1003` 逐条 AC 对账（识别/视觉能力 · 供应商接入）

| 项 | 读数 |
| --- | --- |
| 文档性质 | 对账页（A 档证据文档）：只读仓内实现、逐条对 `#1003` 的验收口径给证据面判定。⛔ 未改产品代码与测试，只新增本文件 |
| 取证时刻 | 2026-11-09（本机 Windows，Node v24.16.0；分支 `docs/gy-r90-i1003-ac-reconciliation`）。v1 取证后按独立审查修两处阻塞 + 4 条 nit 得 **v2**（v1 那轮审查的对象已不可核，本页不再引用其编号）；v2.1 按 PR #1134 的审查记录（review id `5819401184`，reviewed_sha `d19b3974`、当时 main `a30c8adb`；`gh api repos/GengYunChuChao/GengYun/pulls/1134/reviews` 可核）合并 `origin/main`（`a4183da6`）解冲突，并修七条（§5.7） |
| 基线 SHA | `af39bfe6` —— **写作时的 main**（v1 取证开始与结束两次 `git rev-parse origin/main` 均为该提交；本页所有行号以该提交树为准）。main 此后前移到 `a372bd91`（其中 `e537a099` 是本页 v1 的 squash）、`a30c8adb`（`#1133`：把本页 6 条注释锚点改到承载语义的行）、`a40fba6c`（`#1135`：只改 i23 页）、`754efa23`（`#1137`：影子闸门接线 + 新增 2 页）、`a4183da6`（`#1127`：`#19` 片1 证据页 + 台账口径）。v2.1 合并时实测 `origin/main = a4183da6`；对同路径跑 `git diff --numstat origin/main HEAD` **不再为空**，读数本页 `67 32`、登记表 `3 3`（见 §4 闸门 6 实跑原文） |
| 被取证对象 | `#1003` 正文「## 验收口径建议」小节三条（`gh api repos/GengYunChuChao/GengYun/issues/1003` 取回原文，正文共 38 行），以及识别域的适配器／选路／状态机／小程序文案面 |
| 一句话结论 | 六条判据里 **AC①-1（无本地 shim）与 AC③-1（失败／超时两态）在默认路径上成立**；**AC② 有两种都读得通的裁定口径，判定不同**：口径 A「整次结果」只在 `RECOGNITION_PROVIDER_PROFILE=openai-vision-v1` 剖面内成立，默认的 `gy-recognition-live-v1` 剖面不读物种目录、不过滤 ⇒ 判「部分满足」（§2.4.1）；口径 B「逐候选严格」**连剖面内也不成立**——mixed 输入仍回 `completed` ⇒ 判「未满足」，要改代码（AC②-B）；AC③-2 的零候选停在「分支归类」而不是错误码；AC①-2「real 下由仓内实现完成一次真实调用并留证」被外部件阻塞 ⇒ 本页不给出可关单读数 |

## 本页不声称什么

1. **不声称 `#1003` 已完成、也不声称可以关单。** 本页只做「哪条 AC 的证据在仓内、哪条在仓外」的读数，关闭判定权在监工与产品/架构裁定（见 §5）。
2. **不声称骨架代码等于能力可用。** 骨架在代码里的可核形状是「全文唯一网络发送点」`services/api/src/recognitions/openai-vision-adapter.ts:278`（注入点与单测喂假实现的读法见 §2.6）；文件头的作者自述「零真实供应商、零真实调用、零准确率证据」在本页按**未变**处理；本页没有跑过任何一次供应商调用，一条 `usage`、一个 HTTP 状态码都不是本页产生的。
3. **不声称外部件已就位。** 真实供应商账号、付费额度、真实杂草样本、真实调用留证、独立审查这五件，本页一件都没有取得（§3 逐件列明）。
4. **不声称任何识别质量或准确率。** 本页不含 Top1/Top3、分数、误判率任何数字；仓内也没有可用于此的样本——`docs/evaluation/README.md:91` 要求原始私有媒体不入 Git。
5. **不声称行号长期有效。** 行号绑定 `af39bfe6`；`main` 前移后需重新对锚，本页不承诺自动跟随。
6. **不代监工判定「AC 能否作为关闭依据」。** 本页给的是证据面判定（词表见 §1.1），不是批复。

## §1 AC 逐条表

### 1.1 拆分口径、判定词表、锚点写法

`#1003` 正文的验收口径是三条；其中 AC① 一句里含两个可分别取证的半句，AC③ 列的三种情况里「零候选」与另两种的证据面不同，故拆成 6 行（AC①-1／AC①-2／AC②-A／AC②-B／AC③-1／AC③-2），原文对应关系写在编号列。AC② 另拆两行，是因为同一句原文有两种都读得通的裁定口径（见 §1.2 两行与 §2.4.1 末段），两种口径的判定**不同**（部分满足 / 未满足），并成一行会把两条读数混成一句。

**锚点写法**：本页一律写全路径（`路径:行号`），不使用 `:行号` 继承写法；同一行需要多个锚点时重复写路径。这样每个锚点都能单独解析，不依赖上下文推断。

- **已满足**：AC 要求的可核事实在基线树内成立，且每条都能指到实质行（有单测钉住的另行注明）。
- **部分满足**：主要行为成立，但 AC 的字面要件缺一项。缺的这项要么是**口径问题**（需先裁定选哪种表达，裁定前无法判定工作量），要么**只在某条剖面／某条路径内成立**（要覆盖其余路径就是代码改动）；两种情形都在「缺什么」列写明，本页不替它估工时。
- **未满足**：AC 要求的实现不存在；或实现存在但在该口径下不满足（此时须改代码才能成立，不是裁定问题）。
- **外部件阻塞**：AC 要求的事实必须由仓外主体或资源产生（账号、付费、真实样本、评审、裁定），仓内代码侧已无「能做完但还没做」的部分。

### 1.2 逐条对账

| 编号（原文序） | AC 原文摘要（≤60 字） | 判定 | 证据锚点 | 缺什么 |
| --- | --- | --- | --- | --- |
| AC①-1（AC (a) 前半） | 生产代码内不再有「本地 shim」 | **已满足** | `services/api/src/recognitions/openai-vision-adapter.ts:248` 组请求体；`services/api/src/recognitions/openai-vision-adapter.ts:278` 唯一发送点；`services/api/src/recognitions/provider.ts:257` 选路进新剖面。全仓 `git grep -i tokenhub` 无翻译层实现（命中仅配置/文档/验证工具） | 无。注意：`.pg17` 下那个本机 shim 从未进版本控制，也不该进——`#1003` 正文自述「只存在于本机」 |
| AC①-2（AC (a) 后半） | 识别链路在 real 下由仓内实现完成一次真实调用并留证 | **外部件阻塞** | 代码路径可走通：`services/api/src/app.ts:1124` 读三键；`services/api/src/app.ts:1125` 取真实字节端口；`services/api/src/app.ts:1131` 记账包装；`services/api/src/recognitions/provider.ts:257` 进 openai-vision 分支；`services/api/src/recognitions/openai-vision-adapter.ts:278` 发送。闸门：`services/api/src/recognitions/live-ports.ts:191` 授权串、`services/api/src/recognitions/live-ports.ts:197` 同尝试不重发 | **本页未取得键值、未获付费授权**；账号与密钥在仓外本机另有存放处（仓外本机私密目录，未入库；本页未读取其内容）但未用于本次取证。缺的三件外部件：真实 `RECOGNITION_PROVIDER_URL`／`KEY`／`MODEL` 取值；付费授权与次数上限口径（§3 第 2 条）；一次 real 跑通的调用记录与留证页（§3 第 4 条）。另需一张真实杂草照片（§3 第 3 条） |
| AC②-A（AC (b)，口径 A「整次结果」） | `species_id` 必须落在 `species.json` 闭集内，否则如实回不确定 | **部分满足** | **剖面内成立**（`RECOGNITION_PROVIDER_PROFILE=openai-vision-v1`）：`services/api/src/recognitions/openai-vision-adapter.ts:145` 闭集外直接丢弃；`services/api/src/recognitions/openai-vision-adapter.ts:123` 归一化入口；`services/api/src/recognitions/openai-vision-adapter.ts:168` 允许集只 trim 不裁剪；`services/api/src/recognitions/provider.ts:32` 读目录、`services/api/src/recognitions/provider.ts:37` 空目录即抛（fail-closed）；目录实体 `packages/knowledge/catalog/species.json:8`（8 个物种）；丢弃后落不确定 `services/api/src/recognitions/state.ts:189`、`services/api/src/recognitions/state.ts:193`；单测 `tests/unit/recognitions-species-catalog.test.mjs:117`、`tests/unit/recognitions-species-catalog.test.mjs:169`。**口径 A 的读法：丢弃后继续，不是整次回不确定**——`tests/unit/recognitions-openai-vision.test.mjs:129` 的用例喂 4 条候选（含 1 条 `not_in_catalog`），断言仍 `completed` 且只留 2 条有效候选（`tests/unit/recognitions-openai-vision.test.mjs:143`）；只有全部候选都非法才经 `services/api/src/recognitions/state.ts:189`、`services/api/src/recognitions/state.ts:193` 落 `uncertain`。**默认剖面反证**：选路缺省仍走 live（`services/api/src/recognitions/provider.ts:274`：端点与密钥齐备才走 live，判据是这行代码，不是 env 注释）；live 只判「数组 + 条数」（`services/api/src/recognitions/live-adapter.ts:410`）；状态机只判 `species_id` 是长度 1..80 的字符串（`services/api/src/recognitions/state.ts:96`）；`git grep -n species -- services/api/src/recognitions/live-adapter.ts` 命中 0 条（命令退出码 1） | **默认 real 路径不满足**：live 剖面不读物种目录、不过滤，目录外 `species_id` 会原样进候选，分数达阈值且无同分时照样落 `succeeded`（`services/api/src/recognitions/state.ts:210`）。按 AC 原文（未限定剖面）判「部分满足」；若裁定 AC② 只约束 `openai-vision-v1` 剖面，则该条在剖面内**已满足**——这是裁定项，不是本页能替它定的 |
| AC②-B（AC (b)，口径 B「逐候选严格」） | 同上原句，但「否则」按**每个候选**读：任一候选落在闭集外即整次回不确定 | **未满足** | 同一批锚点；决定性读数：`tests/unit/recognitions-openai-vision.test.mjs:129` 喂的 4 条候选里有 1 条是 `{ species_id: 'not_in_catalog', confidence: 0.99 }`（`tests/unit/recognitions-openai-vision.test.mjs:133`），`outcome.kind` 仍是 `completed`（`tests/unit/recognitions-openai-vision.test.mjs:142`）；实现只丢弃那一条（`services/api/src/recognitions/openai-vision-adapter.ts:145`）并保留 2 条（`tests/unit/recognitions-openai-vision.test.mjs:143`） | **须改代码**：口径 B 要求闭集外候选触发整次 `uncertain`，得改 `services/api/src/recognitions/openai-vision-adapter.ts:145` 的丢弃逻辑与 `services/api/src/recognitions/openai-vision-adapter.ts:347` 的空候选出口，并同步改 `tests/unit/recognitions-openai-vision.test.mjs:129` 这一族断言。**该口径在剖面内也不成立**——不是剖面限定问题，是行为本身 |
| AC③-1（AC (c) 之二态） | 失败与超时：都有明确错误码与用户可读文案 | **已满足** | 错误码闭集四条 `services/api/src/recognitions/provider.ts:42`；状态码映射调用点 `services/api/src/recognitions/openai-vision-adapter.ts:303`；超时映射 `services/api/src/recognitions/openai-vision-adapter.ts:290`；映射本体 `services/api/src/recognitions/openai-vision-adapter.ts:102`（429→配额，401/403/≥500→不可用，其余→结果未知）；码→任务态 `services/api/src/recognitions/service.ts:276`（超时→`timed_out`，其余→`failed`）；落 Job `services/api/src/recognitions/service.ts:488`；文案 `miniprogram/utils/identify-api.js:92`（识别失败）、`miniprogram/utils/identify-api.js:93`（识别超时）；单测 `tests/unit/recognitions-openai-vision.test.mjs:93`、`tests/unit/recognitions-openai-vision.test.mjs:107`、`tests/unit/recognitions-openai-vision.test.mjs:120` | 无新代码。真实供应商下这两态各触发一次并留证，属 AC①-2 的范围（`docs/architecture/adr-002-recognition-provider-route.md:62` 的证据口径同此要求） |
| AC③-2（AC (c) 之一态） | 零候选：同样要有明确错误码与用户可读文案 | **部分满足** | 有如实原因与分支归类：`services/api/src/recognitions/state.ts:141` 原因文本、`services/api/src/recognitions/state.ts:193` 空候选必带原因；适配器如实返回空候选 `services/api/src/recognitions/openai-vision-adapter.ts:347`；分支落 `no_result` `miniprogram/utils/identify-api.js:838`（按原因文本子串匹配）；分支文案 `miniprogram/utils/identify-api.js:171`；但该分支错误码按设计为 null `services/api/src/recognitions/branches.ts:146`、`services/api/src/recognitions/branches.ts:150` | **裁定前无法判定工作量**：零候选现被当作「正常调用但没结果」（`services/api/src/recognitions/live-adapter.ts:235`：`outcome.candidates.length === 0` ⇒ 显式置 `branch = 'no_result'`，同口径），只给 `uncertain` + 分支 `no_result` + 原因文本，`error_code` 恒 null。若 AC③ 字面要求「零候选也有错误码」，需先裁定是新增一个错误码，还是承认「分支归类 + 原因文本」为等价物；**若裁定新增错误码，则含契约 + 代码 + 文案 + 测试四块**（错误码闭集 `services/api/src/recognitions/provider.ts:42` 也要动），不是一句文案能收口的 |

### 1.3 判定构成

**已满足 2 条、部分满足 2 条、未满足 1 条、外部件阻塞 1 条**，合计 6 条（AC① 拆两半、AC② 拆两种可裁定口径、AC③ 拆两种态后计）。与 v1 的差别：AC② 由「已满足」改判——v1 漏了剖面限定（口径 A ⇒ 部分满足，反证见 §2.4.1）；v2 只写了口径 A，漏了「逐候选严格」在原句里同样读得通（口径 B ⇒ 未满足，反证见 §1.2 AC②-B）。两种口径并列摆着，本页不替裁定人选哪条。

## §2 代码面事实

### 2.1 适配器（`services/api/src/recognitions/openai-vision-adapter.ts`，348 行，`wc -l` 口径）

文件头逐字（作者自述，本页不拿它当判据 —— 骨架在代码里的形状见 §2.6 与 §2.7）：

```
 * 本文件是**骨架**：零真实供应商、零真实调用、零准确率证据。单测只喂假 `fetchImpl`，不联网。
```

- `services/api/src/recognitions/openai-vision-adapter.ts:46` —— 协议常量，值为 `openai-vision-v1`（与 `gy-recognition-live-v1` 并列，不替换）。
- `services/api/src/recognitions/openai-vision-adapter.ts:52` —— 冻结剖面对象起点。
- `services/api/src/recognitions/openai-vision-adapter.ts:77` —— 提示词构建，把闭集 id 写进提示词并要求 JSON 输出。
- `services/api/src/recognitions/openai-vision-adapter.ts:123` —— 归一化入口。
- `services/api/src/recognitions/openai-vision-adapter.ts:145` —— 闭集外丢弃。
- `services/api/src/recognitions/openai-vision-adapter.ts:168` —— 允许集只 trim／去空，不做裁剪。
- `services/api/src/recognitions/openai-vision-adapter.ts:195` —— 供应商工厂。
- `services/api/src/recognitions/openai-vision-adapter.ts:203` —— 取模型名并 trim；空串在下一行抛 `RecognitionWiringError`（`services/api/src/recognitions/openai-vision-adapter.ts:204`）。
- `services/api/src/recognitions/openai-vision-adapter.ts:215` —— `fetchImpl` 注入点。
- `services/api/src/recognitions/openai-vision-adapter.ts:224` —— 配置版本串拼装。
- `services/api/src/recognitions/openai-vision-adapter.ts:228` —— `modelVersion` 写剖面名。
- `services/api/src/recognitions/openai-vision-adapter.ts:231` —— 调用入口。
- `services/api/src/recognitions/openai-vision-adapter.ts:248` —— 组 OpenAI 兼容请求体。
- `services/api/src/recognitions/openai-vision-adapter.ts:270` —— 过闸门（GY-R94 起 `attemptKey` 带 `#2` 后缀标第二次派发）。
- `services/api/src/recognitions/openai-vision-adapter.ts:278` —— 唯一网络发送。
- `services/api/src/recognitions/openai-vision-adapter.ts:290` —— 超时／异常出口。
- `services/api/src/recognitions/openai-vision-adapter.ts:303` —— HTTP 状态码→错误码的调用点（`if (!response.ok)`）。
- `services/api/src/recognitions/openai-vision-adapter.ts:102` —— 上一条的映射本体：429→配额，401/403/≥500→不可用，其余→结果未知。
- `services/api/src/recognitions/openai-vision-adapter.ts:326` —— 200 但解析不出 JSON。
- `services/api/src/recognitions/openai-vision-adapter.ts:347` —— 空候选如实返回。

### 2.2 选路

- `services/api/src/recognitions/provider.ts:256` —— 取 `profile` 并 trim／小写。
- `services/api/src/recognitions/provider.ts:257` —— 等于 `openai-vision-v1` 才进新分支。
- `services/api/src/recognitions/provider.ts:271` —— 新分支装配失败 fail-closed，不回退替身。
- `services/api/src/recognitions/provider.ts:274` —— 缺省路径仍是老剖面（端点与密钥齐备才走 live）。
- `.env.example` 识别段 —— 把「缺省／留空／写错值仍走 live」写成运维口径的**注释行**。影子闸门按扩展名不扫 `.env.example`，但它字面违反「证据锚不落注释行」，故本页**不给这行注释的行号锚点、也不拿它当判据**；判据是上一行代码 `services/api/src/recognitions/provider.ts:274`。
- `services/api/src/app.ts:1124` —— 读 `RECOGNITION_PROVIDER_URL`／`PROFILE`／`MODEL`。
- `services/api/src/app.ts:1125` —— 读 `RECOGNITION_PROVIDER_KEY` 并接真实字节端口。

### 2.3 冻结剖面

| 项 | 值 | 锚点 |
| --- | --- | --- |
| 图片上限 | 2 MiB | `services/api/src/recognitions/openai-vision-adapter.ts:55` |
| 默认超时 | 15000 ms（下界 1000、上界 20000） | `services/api/src/recognitions/openai-vision-adapter.ts:59` |
| 超时下界 | 1000 ms | `services/api/src/recognitions/openai-vision-adapter.ts:57` |
| 候选上限 | 3 | `services/api/src/recognitions/openai-vision-adapter.ts:61` |
| 重试次数 | 0 | `services/api/src/recognitions/openai-vision-adapter.ts:62` |

### 2.4 闭集守卫

- `services/api/src/recognitions/provider.ts:32` —— 闭集从目录现读。
- `services/api/src/recognitions/provider.ts:37` —— 目录为空即抛（fail-closed）。
- `packages/knowledge/catalog/species.json:8` —— 目录实体起点；共 8 个 `species_*` 条目：`species_barnyardgrass`、`species_foxtail`、`species_nettle_group`、`species_crabgrass`、`species_goosegrass`、`species_shortawn_foxtail`、`species_lambsquarters`、`species_alligatorweed`。
- `services/api/src/recognitions/openai-vision-adapter.ts:145` —— 真闸在解析处，不在提示词。
- `services/api/src/recognitions/state.ts:189` —— 过滤后空候选分支。
- `services/api/src/recognitions/state.ts:193` —— 原因兜底为「模型未返回任何候选」。
- `miniprogram/utils/identify-api.js:838` —— 小程序侧按原因文本子串归类 `no_result`。

### 2.4.1 剖面限定：默认剖面没有这层过滤（v2 修正；v2.1 补第二种口径）

v1 把 AC② 记成「已满足」，漏了一句限定：**闭集过滤只在本仓新剖面 `openai-vision-v1` 里存在**。默认剖面没有这层，四条反证：

1. **选路默认仍是 live。** 端点与密钥齐备就走既有 live 剖面（`services/api/src/recognitions/provider.ts:274`）；`.env.example` 识别段把「`PROFILE` 只认得 `openai-vision-v1`，缺省／留空／写错值（不报错）⇒ 仍走既有 `gy-recognition-live-v1` 适配器，**live 仍是默认**」写成运维口径的注释行——仅作辅助说明，不作判据（故不给它的行号锚点）。
2. **live 侧只判形状。** `services/api/src/recognitions/live-adapter.ts:410` 只判「是数组 + 条数 ≤ 上限」，语义校验唯一在状态机里。
3. **状态机只判长度。** `services/api/src/recognitions/state.ts:96` 只要求 `species_id` 是长度 1..80 的字符串（上界常量在同文件 `services/api/src/recognitions/state.ts:37`），不查物种目录。
4. **live 侧完全不提物种。** 在 `services/api/src/recognitions/live-adapter.ts` 上跑 `git grep -n species` 命中 0 条（退出码 1）。

**后果**：默认 real 路径收到目录外 `species_id` 不会被丢弃，分数达阈值且无同分时照样落 `succeeded`（`services/api/src/recognitions/state.ts:210`）——这正是 v1 判「已满足」时漏掉的那半边。

**这条 AC 的同一句原文有两种都读得通的裁定口径，本页按两条并列给判定（§1.2 的 AC②-A／AC②-B）：**

- **口径 A「整次结果」**（「否则」约束整次调用）：即便在新剖面内也按「丢弃后继续」实现——`tests/unit/recognitions-openai-vision.test.mjs:129` 喂 4 条候选（含 1 条 `not_in_catalog`），断言仍是 `completed` 且只留 2 条有效候选（`tests/unit/recognitions-openai-vision.test.mjs:143`），不是整次回不确定；只有全部候选都非法，才由 `services/api/src/recognitions/state.ts:189`、`services/api/src/recognitions/state.ts:193` 落 `uncertain`。此口径下判定 = **部分满足**（剖面内成立、默认剖面不成立）。
- **口径 B「逐候选严格」**（「否则」按每个候选读：任一条非法即整次回不确定）：同一组读数直接否掉它——`outcome.kind` 仍是 `completed`（`tests/unit/recognitions-openai-vision.test.mjs:142`），`not_in_catalog` 那条只被丢弃（`services/api/src/recognitions/openai-vision-adapter.ts:145`）。此口径下判定 = **未满足**，**且不是剖面限定问题：剖面内也不成立**；要满足得改 `services/api/src/recognitions/openai-vision-adapter.ts:145` 与 `services/api/src/recognitions/openai-vision-adapter.ts:347` 一带，并同步改 `tests/unit/recognitions-openai-vision.test.mjs:129` 这一族断言。

### 2.5 env 键登记与落库面

- `.env.example:80` —— `RECOGNITION_PROVIDER_URL`。
- `.env.example:81` —— `RECOGNITION_PROVIDER_KEY`。
- `.env.example:82` —— `RECOGNITION_PROVIDER_PROFILE`。
- `.env.example:83` —— `RECOGNITION_PROVIDER_MODEL`，自述「缺它 ⇒ 该剖面受理前 503，不回落 live」。
- `docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:322` —— 登记提交 `ed0d37e5`（`#1106`）。
- `services/api/src/recognitions/call-metadata.ts:112` —— 版本串拼接。
- `services/api/src/privacy/media-call-accounting.ts:270` —— 写入账本。
- `services/api/src/privacy/provider-call-ledger-pg.ts:60` —— 账本列定义。

### 2.6 「文件头自述骨架」在代码里怎么体现

这句话不是注释里的自我贬低，而是三个可核对的结构事实：

1. **真实发送只有一个出口，而且默认被换掉。** 全文唯一网络发送在 `services/api/src/recognitions/openai-vision-adapter.ts:278`，注入点在 `services/api/src/recognitions/openai-vision-adapter.ts:215`；单测全部喂假 `fetchImpl`：`tests/unit/recognitions-openai-vision.test.mjs:93`、`tests/unit/recognitions-openai-vision.test.mjs:107`、`tests/unit/recognitions-openai-vision.test.mjs:120`、`tests/unit/recognitions-openai-vision.test.mjs:149`。⇒ 代码能跑，但从没跑过真端点。
2. **落库的版本串只到剖面、不到模型。** `services/api/src/recognitions/openai-vision-adapter.ts:228` 把 `modelVersion` 固定写成剖面常量，真实模型身份另存 `providerConfigVersion`（`services/api/src/recognitions/openai-vision-adapter.ts:224`）。⇒ 单看 `model_version` 证不出「谁答的」，这正是「零准确率证据」在库里的形状。
3. **仓内没有一条用例能触发真实分支。** 端到端脚本只跑替身提供者：`tests/integration/recognition-chain-e2e.mjs:43`（import 替身）、`tests/integration/recognition-chain-e2e.mjs:229`（替身臂装配）；real 分支缺凭据即不可用，落点 `services/api/src/recognitions/provider.ts:213`（`available: !missing`），受理前的 503 由 `services/api/src/recognitions/service.ts:397` 的 `!provider.available` 抛出。

**与哪条 AC 冲突**：与 AC①-2 **直接冲突**——文件头把「零真实调用」写成既定事实，而 AC①-2 要求的正是反过来的那一条事实。与 AC③ **不冲突**：只约束代码行为，已在假 `fetchImpl` 下逐条覆盖；与 AC② 也不冲突，但 AC② 只在 `openai-vision-v1` 剖面内成立（§2.4.1），默认剖面不覆盖。与 ADR-002 的证据口径也不冲突，两者是同一约束的两处表述（`docs/architecture/adr-002-recognition-provider-route.md:62`）。

### 2.7 行号复核（任务书说法 vs 本页实测）

本页核对 7 条：**6 条采用、1 条不采用**。行数一律 `wc -l` 口径。

| 任务书说法 | 实测（`af39bfe6` 树） | 结论 |
| --- | --- | --- |
| 适配器文件头自述骨架 | `services/api/src/recognitions/openai-vision-adapter.ts:278` 为全文唯一网络发送点（注入点与假 `fetchImpl` 单测见 §2.6） | 一致（按结构事实核，不靠注释） |
| 冻结剖面 2 MiB／15 s／3 候选／0 重试 | `services/api/src/recognitions/openai-vision-adapter.ts:55`、`services/api/src/recognitions/openai-vision-adapter.ts:59`、`services/api/src/recognitions/openai-vision-adapter.ts:61`、`services/api/src/recognitions/openai-vision-adapter.ts:62` | 一致 |
| 闭集守卫在 `provider.ts` 的 32–39 行附近 | `services/api/src/recognitions/provider.ts:32` 为函数声明、`services/api/src/recognitions/provider.ts:37` 为空集抛错 | 一致 |
| `.env.example` 已登记 PROFILE／MODEL | `.env.example:82`、`.env.example:83`（同段 `.env.example:80`、`.env.example:81` 为 URL／KEY） | 一致 |
| 真库到端到端链在 `tests/integration/recognition-chain-e2e.mjs` | 文件在，但只跑替身臂（`tests/integration/recognition-chain-e2e.mjs:229`） | 一致，需加「非真实供应商」限定 |
| 行数（供后续引用对齐） | 适配器 348 行、`provider.ts` 318 行、`state.ts` 220 行 | v1 写的 349／319／221 是「按行切分后的数组长度」口径（末尾空串多算 1）；v2 统一为 `wc -l` |
| `docs/implementation-requirements.md:585` | 该行是 AC23「注销删除与保留」，与识别／`#1003` 无关 | **不采用**：不作为本页任何判定的证据 |

## §3 为什么这是「外部件」而不是「代码缺口」

### 3.1 外部件清单（五件，逐件写「谁才能提供」）

1. **真实供应商账号与三键取值。** 缺一即 fail-closed：`services/api/src/recognitions/openai-vision-adapter.ts:203`（取模型名）、`services/api/src/recognitions/openai-vision-adapter.ts:204`（空即抛）、`services/api/src/recognitions/provider.ts:274`（端点与密钥齐备才走真实剖面）、`.env.example:80`、`.env.example:81`、`.env.example:83`（三键缺一 ⇒ 受理前 503）。仓内自查也给出同一结论：缺凭据即 `available: false`（`services/api/src/recognitions/provider.ts:213`），受理前按 `!provider.available` 抛 503（`services/api/src/recognitions/service.ts:397`）。**谁提供**：持有供应商账号与密钥的运维／用户本人；仓内只能声明键名，不能声明值。**本页状态**：未取得键值、未获付费授权；账号与密钥在仓外本机另有存放处（仓外本机私密目录，未入库；本页未读取其内容），未用于本次取证。
2. **付费授权与次数上限口径。** 识别域闸门只有三件事：授权串逐字比对（`services/api/src/recognitions/live-ports.ts:191`）、同一尝试不重发（`services/api/src/recognitions/live-ports.ts:197`）、可选次数上限（`services/api/src/recognitions/live-ports.ts:200`）；上限默认 0 = **不限次**（`services/api/src/recognitions/live-ports.ts:184`），预留金额恒 0（`services/api/src/recognitions/live-ports.ts:205`）。仓内写死的 `MAX_PAID_CALLS` 只属于问答／LLM 装置（`tools/verify-chat-live.mjs:17`、`tools/verify-llm-live.mjs:38`），那个手工 live 装置也只放行 tts（`tools/verify-provider-adapter-live.mjs:30`）。**谁提供**：能批「花一次钱」并定上限的人；代码侧能做的（闸门、去重、账本列）已经在。
3. **真实杂草照片与使用许可。** 原始私有媒体不入仓是硬约束（`docs/evaluation/README.md:91`），所以仓内不存在可用于真实验收的照片。此前唯一一次真实的 TokenHub 视觉 200 用的是合成图，该页自己写「无草种真值」（`docs/verification/gy-i27-live-ai-20261018.md:78`），且 `docs/verification/ai-configuration-evidence.md:11` 明写视觉推理与草种 Top3／分数／准确率均为 0。**谁提供**：能授权拍摄／使用真实样本的样本方，且要过脱敏与留存口径。
4. **一次真实调用记录与留证页。** ADR-002 把证据口径写成上线前置（`docs/architecture/adr-002-recognition-provider-route.md:62`），`#1003` 正文同向要求跨线登记（对照物 `docs/moderation/http-layer.md` 在仓内）。目前识别域没有任何真实调用记录；唯一的真实视觉调用属 AI 配置域，不是识别链路。**谁提供**：能拿账号与付费授权做一次受控调用、并把 `usage`／HTTP 状态／落库行如实写下的人。
5. **路线裁定与独立审查。** 两条路线（服务端适配器／协议换代）要产品与架构选一条，ADR-002 状态仍是「待产品裁定，未冻结」（`docs/architecture/adr-002-recognition-provider-route.md:3`）；R90 索引页把 `#1003` 判「待裁定」并记「一次真实调用 + 留证，另需裁定」（`docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:176`、`docs/verification/gy-r90-open-issue-acceptance-index-20261109.md:467`）。A 档还要求审查者 ∉ {实现者, 推送者, 派发者}（`docs/pr-review-policy.md:181`）。**谁提供**：裁定人与独立审查者，都不是本页作者。

### 3.2 代码侧已经做完的部分（与 §3.1 配对读）

- 协议翻译与请求体：`services/api/src/recognitions/openai-vision-adapter.ts:248`。
- 闭集过滤：`services/api/src/recognitions/openai-vision-adapter.ts:145`。
- 失败码映射的调用点与超时出口：`services/api/src/recognitions/openai-vision-adapter.ts:303`、`services/api/src/recognitions/openai-vision-adapter.ts:290`；映射本体 `services/api/src/recognitions/openai-vision-adapter.ts:102`。
- 零候选出口：`services/api/src/recognitions/openai-vision-adapter.ts:347`。
- 选路与 fail-closed：`services/api/src/recognitions/provider.ts:257`、`services/api/src/recognitions/provider.ts:271`、`services/api/src/recognitions/provider.ts:274`。
- 装配与记账：`services/api/src/app.ts:1124`、`services/api/src/app.ts:1131`；版本串落库 `services/api/src/privacy/media-call-accounting.ts:270`。
- 状态机：`services/api/src/recognitions/state.ts:172`、`services/api/src/recognitions/state.ts:189`。
- 小程序文案：`miniprogram/utils/identify-api.js:91`、`miniprogram/utils/identify-api.js:92`、`miniprogram/utils/identify-api.js:93`、`miniprogram/utils/identify-api.js:171`。

结论：仓内**没有**「本该写而没写」的识别适配代码；缺的四件都在仓外（账号、付费、样本、留证），第五件是裁定与审查。

### 3.3 一条可选的代码侧补强（不等于 AC，不改变 §1 判定）

识别域没有与问答同形的「受控付费装置」：次数上限靠装配方传 `maxCalls`（`services/api/src/recognitions/live-ports.ts:184`），仓内无对等常量；手工装置只放行 tts（`tools/verify-provider-adapter-live.mjs:30`）。若要「一次真实调用」可复现，值得另开一单补一个只放行识别的装置（沿用 reserve-then-send 与账本口径）。本条**不**属于 `#1003` 的 AC，也不因它未做而判 AC 未满足。

## §4 闸门读数

基线 `af39bfe6`（写作时的 main）；v2 提交时另合并了 `a372bd91`；v2.1 合并 `origin/main = a4183da6`（含 `#1133` `a30c8adb`、`#1135` `a40fba6c`、`#1137` `754efa23`、`#1127` `a4183da6`）。八道闸门在**合并后的提交**上逐条实跑，命令与尾行照录。

| # | 闸门 | 命令 | EXIT | 尾行（摘要） |
| --- | --- | --- | --- | --- |
| 1 | 文档锚点 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增` |
| 2 | 锚点重定位 identity | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | `ℹ pass 37` / `ℹ fail 0` |
| 3 | 契约台账 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。` |
| 4 | 文档测试 | `npm run test:docs` | 0 | `PASS: 识别 5 页 / 跳过 367 页` |
| 5 | 合并树 | `git merge-tree --write-tree --name-only origin/main HEAD` | 0 | 只打印合并树对象名，无冲突文件名 |
| 6 | 改动面 | `git diff --numstat origin/main HEAD` | 0 | 本页 `67 32`；登记表 `3 3`（共 2 个文件，无其它） |
| 7 | 注释锚点影子闸门 | `node tools/verify-verification-comment-anchors.mjs` | 0 | `本次命中 1422、基线 1422、基线外新增 0、可收紧 0` |
| 8 | 页内锚点自查 | 页内自查脚本（解析本页全部「路径:行号」，逐条打印该行原文） | 0 | `anchors=91 bad=0` |

实跑原文（末行照录）：

```
> node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs
PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN、ANCHOR-COUNT 与 COMMENT_ANCHOR 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN／STALE-SYMBOL）

> node --test tests/unit/doc-anchor-relocation-identity.test.mjs
ℹ pass 37  ℹ fail 0  EXIT 0

> node tools/verify-contract-status.mjs
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。

> npm run test:docs
PASS: 识别 5 页 / 跳过 367 页（扫描面 372 页：docs/verification）——读数七条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字 ⑦同页副本一致）

> git merge-tree --write-tree --name-only origin/main HEAD
<合并树对象名一行；不照录具体 SHA——它随本页字节变化，出现文件名即表示与 main 冲突>

> git diff --numstat origin/main HEAD
67	32	docs/verification/gy-r90-i1003-ac-reconciliation-20261109.md
3	3	tests/unit/doc-anchor-relocations.json

> node tools/verify-verification-comment-anchors.mjs
VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 1422、基线 1422、基线外新增 0、可收紧 0（--require-no-new=on、--require-no-stale=off）
VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 1422 条注释锚点只告警，没有基线外新增

> node <页内自查脚本>
anchors=91 bad=0
```

读法：

- 闸门 2 在**提交前**必红一次，属自证：纯新增文档在提交前 base 与 HEAD 是同一提交，用例据此判红，断言原文为「base 与 HEAD 同一提交（git merge-base HEAD origin/main），本用例没有判定面却也不是 CI 浅克隆 —— 取 base 的逻辑有问题，不允许静默通过」（`tests/unit/doc-anchor-relocation-identity.test.mjs:1317`）。本页提交后同命令为 EXIT 0。
- 闸门 5 打印的只有合并树对象名；一旦出现文件名即表示与 main 冲突。闸门 6 用来证明「改动面只有本页 + 登记表」：本页 v2.1 合并后行号下移，`tests/unit/doc-anchor-relocations.json` 里指向本页的 3 条登记（`from`→`to` 不变）行号随之改为 42／142／152，否则闸门 2 判「登记表陈旧」。
- 本页不含裸行号引用（全部写成完整路径），不动 `docs/architecture/**` 的符号基线面。
- 闸门 2 的比对口径是「同一文档行内、同一目标文件的锚点序列」**按位置配对**，且目标文件本提交未改动时行号必须恒等。本页 v2 曾按「只追加、旧锚点保位」写；v2.1 **撤销**这个口径：`#1133`（main `a30c8adb`）已把本页 6 条注释锚点改到承载语义的行（`services/api/src/recognitions/openai-vision-adapter.ts:278`、`services/api/src/recognitions/live-adapter.ts:235`、`services/api/src/recognitions/provider.ts:213`、`services/api/src/recognitions/service.ts:397`），合并且**以 main 侧锚点改法为准**，不回退 v2 的旧注释锚（适配器文件头、live 装配、端到端脚本文件头这三处旧锚，本页已全部不再使用）。可复核：`git diff -U0 origin/main..HEAD -- docs/verification/gy-r90-i1003-ac-reconciliation-20261109.md` 里已不再出现指向上述三处注释的锚点。
- v2.1 的做法是 `git merge --no-ff origin/main`（`a4183da6`）：冲突落在 AC 表与 §3.1 item1 两处，逐处按 **main 侧锚点改法**解，正文内容保留 v2 并补 v2.1 修订；解完闸门 5 才为 0。**未 force-push**——同分支追加提交（合并提交 `parents = d19b3974 + a4183da6`），旧提交全部保留。

## §5 边界

1. **只给证据，不给批复。** §1 的判定列是「证据面判定」，不是监工批复；`#1003` 是否可关、以哪条 AC 为关闭依据，由监工与产品/架构裁定。
2. **不代关单、不改状态。** 本页未对 `#1003` 做任何 `close`／label／assignee 操作，也未改它的正文。
3. **不声称能力。** 骨架代码在，不等于识别能力可用；没有真实调用记录之前，对外口径仍应是「未接入已审供应商」（`docs/architecture/adr-002-recognition-provider-route.md:62`）。
4. **不扩范围。** 本页没有回答「该不该做协议换代」「用哪个模型」「预算多少」，这些是 §3.1 第 5 条的裁定事项。
5. **可复核性（可兑现口径）。** 本页锚点做了两层核对：① **全量机检 `91` 条** —— 逐条解析「路径:行号」并把该行原文打出来比对，错误 0 条（工具：`node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs`，加页内自查脚本一次，读数为 `anchors=91 bad=0`）；② **人工抽查 `32` 条**逐行读原文（`live-adapter` 2 条、`state` 4 条、`provider` 5 条、`service` 2 条、`branches` 2 条、适配器 10 条、识别单测 4 条、`live-ports` 2 条、小程序文案 1 条），覆盖 §1.2 六行的判据锚、§2.4.1 四条反证、§3.1 五件外部件的落点。其余锚点只有机检层——本页**不声称**每条锚点都曾逐行人工读过。行号绑定 `af39bfe6` 树（与 `origin/main` 的代码文件逐字节相同），漂移后需重新对锚，本页不承诺自动跟随。
6. **修订记录（v2）。** v1 `c3a60b23` 已随 `#1130` squash 进 main（`e537a099`）；v2 按 v1 那轮独立审查修两处阻塞（AC② 补剖面限定、§2.7 补「不采用」行并统一 `wc -l` 口径）与 4 条 nit（`services/api/src/recognitions/openai-vision-adapter.ts:203` 与 `services/api/src/recognitions/openai-vision-adapter.ts:204` 拆开引、映射改引本体、AC③-2 工作量措辞、AC①-2 账号措辞）。v1 那轮审查引用的对象编号在本仓与 GitHub 都查不到（`git cat-file -t` 与 `gh api` 均无），故本页不再引用它。
7. **修订记录（v2.1）。** 按 PR #1134 的审查记录（review id `5819401184`，reviewed_sha `d19b3974`、当时 main `a30c8adb`；`gh api repos/GengYunChuChao/GengYun/pulls/1134/reviews` 可核）做七件事：① 合并 `origin/main`（`a4183da6`）解 P1 冲突，逐行采用 main 侧锚点改法（`services/api/src/recognitions/openai-vision-adapter.ts:278`、`services/api/src/recognitions/live-adapter.ts:235`、`services/api/src/recognitions/provider.ts:213`、`services/api/src/recognitions/service.ts:397`）；② AC② 拆成 AC②-A／AC②-B 两种可裁定口径（新增「逐候选严格 ⇒ 剖面内也不满足」）；③ `.env.example` 里那条注释锚（第 78 行）已删，改为「仅辅助说明、不作判据」，判据换 `services/api/src/recognitions/provider.ts:274`；④ §4 读数改 `origin/main` 实测、补影子闸门与页内自查两行，并删除「保留 v2 一侧」的旧合并口径；⑤ 第 7 行 `git diff --numstat origin/main HEAD` 换成本轮实测；⑥ §5 第 5 条的全称断言换成可兑现写法（全量机检 91 条 + 抽查 32 条）；⑦ 删掉不可核的对象号。改动面：本文件 + `tests/unit/doc-anchor-relocations.json` 里指向本页的 3 条登记行号（42／142／152，`from`→`to` 与理由不变）；不动 `tools/**`、`.github/**`、产品代码与其它测试。

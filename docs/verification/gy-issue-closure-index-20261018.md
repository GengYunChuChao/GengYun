# 开放 issue 关闭材料索引（2026-10-18）

## 0 本页性质与判定口径

- **基线**：`5250520cdb4ceff9da4ef04e39d6aefecf621e32`（`upstream/main`；开工时 `git fetch upstream --prune` 复核无前进）。
- **生成日期**：`2026-10-18 15:32:38 +08:00`（`Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'` 实测，见 §4）。
- **本页不是结项声明**：本页只把每张 issue 的验收条款映射到「可复核证据＋复现命令＋判定」，供监工照页签核。本页**不关闭**任何 issue、**不评论** GitHub、**不推** PR。
- **证据口径**：所有 `文件:行` 均取自基线 `5250520cdb`（`git show 5250520:<path>` 或 `git grep … 5250520` 实测）。被引文件在本页提交中**零改动**——`git diff --numstat 5250520..HEAD` 只有本页这一行新增（§4）。
- **判定四档**：

| 判定 | 含义 | 是否可据以关单 |
| --- | --- | --- |
| 可判真 | 仓库内有可复现证据（代码锚＋绿测／实测读数），本页已跑并记读数 | 是（需监工签核） |
| 待裁 | 证据已就位，但结论取决于监工或用户对口径／严重性的裁定 | 否 |
| 待真机 | 需要真机或微信开发者工具上的实测记录 | 否 |
| 待外部 | 需要外部账号、真实供应商、实库或用户侧材料 | 否 |

- **issue 级结论**（由逐条判定汇总，四档之外不另设隐含档）：

| 结论 | 含义 | 本页命中 |
| --- | --- | --- |
| 可关 | 全部条款可判真，且无待裁／待真机／待外部，也无其它列明的前置 | #7、#8 |
| 待前置 | 条款已可判真，但端到端仍缺本页逐条列明的前置。两种情形：①仍有待裁／待真机／待外部条款；②条款全可判真、缺的是运行态前置（如 #17 `real` 模式无持久存储恒 503，待阶段 2 PG 持久化）。两种均**不是**代码缺陷 | #4、#16、#17、#27 |
| 待裁 | 有权裁定方（监工／用户）对口径或严重性未定，本页不自裁（#3 的 `unverified` 形态、#22 的两个发现严重性） | #3、#22 |
| 不可关 | 存在本轮会被判否或缺关键事实的条款，本页明确不提交关闭（逐条理由见 §2） | §2 五张 |

- **引用口径**：issue 正文「验收」段为复选框列表，本页**逐字引用**该列表，不改写、不合并、不省略；判定表 `C1…Cn` 与引用顺序一一对应。
- **命令口径**：每节末尾的复现命令按 `C1…Cn` 同序排列，注释里写明预期读数；命令来自 Windows PowerShell 7，退出码取 `$LASTEXITCODE`。

## 1.1 #3 [初版 GY-I03] 建立浙江首批资料清单与可替换数据库适配

- **URL**：`https://github.com/GengYunChuChao/GengYun/issues/3`
- **状态**：`open`（`gh api repos/GengYunChuChao/GengYun/issues/3` 实测）
- **验收条款**：AC02、AC12、AC22；逐条引用共 **3** 条
- **本页结论**：**待裁** —— 三条证据均已在仓库内就位（记录 20 条、`source_validity: valid` 20 处、公开来源审计页在库），但「20 条 `review_status: unverified`／`achieved: 20` 是否算 #3 关闭」是口径裁定，本页不自裁：`.pg17/ruling-i03i20-five-items.md` 首块逐字「本裁定**不关闭** #3/#20 任何验收项 ✓；若监工另有口径，以监工批复为准 ✓」，且明确「不得声称资料/样本“已就绪/已核实/已达标”」。issue 正文「20 条」指条目数，本页如实区分「条目 20 条」与「逐字段复核 0 条」。

**逐条验收原文（逐字引用 issue 正文，未改写）**

- [ ] 缺失、过期、冲突和未核对不标为有效；不虚构20条已完成
- [ ] 模拟資料全链路标记并不得作为真实用量依据，未接真实库报告接入缺项
- [ ] 实际来源和条目清单可复核；许可调查本轮暂缓但不得写成已许可

**逐条判定**

| 条款 | 判定 | 证据（`文件:行`，绑 5250520；被引文件在本页零改动） |
| --- | --- | --- |
| **C1** | **可判真** | `packages/knowledge/herbicides/records-2026.json:13` 逐字「字段已转录自来源，但未与原文逐字段复核（本文件当前 20 条）」；同文件 `:5` `"target": 20`、`:6` `"achieved": 20`（条目数，不等于已核对）；`packages/reference/constants.mjs:157` `FORBIDDEN_LABELS` |
| **C2** | **可判真** | `records-2026.json:99` 起 `"usable_as_dose": false` 共 20 处（末处 `:2138`）；`:23` `forbidden_fill` 列「空字符串／占位符／推测值或剂量换算值／模型生成文本」；`docs/verification/provider-matrix.md:40` 关系数据库行状态列逐字「阻塞」（真实库未接即登记缺项） |
| **C3** | **可判真** | `records-2026.json:3` notice 逐字「登记证号与字段均取自农业农村部农药管理司公开公告附表（登记延续信息），非编造…记录状态为 partial，不可作为用药依据。」；`:32` `"record_id": "gy-i03-hb-001"`（20 条同构，`"source_validity": "valid"` 共 20 处）；`docs/verification/gy-i03-public-source-audit-20261011.md` |

**复现命令**

```powershell
# C1｜预期：exit 0，`tests 28 / pass 28 / fail 0`
node --test tests/unit/knowledge-herbicides-http.test.mjs tests/reference/herbicide-provenance.test.mjs tests/reference/labels.test.mjs

# C2｜预期：`20`
git show 5250520:packages/knowledge/herbicides/records-2026.json | Select-String '"usable_as_dose": false' | Measure-Object | Select-Object -ExpandProperty Count

# C3｜预期：`20`（20 条条目清单可复核；与 C2 同形，仅改匹配串）
git show 5250520:packages/knowledge/herbicides/records-2026.json | Select-String '"source_validity": "valid"' | Measure-Object | Select-Object -ExpandProperty Count
```

## 1.2 #4 [初版 GY-I04] 实现微信登录、游客限制与服务端归属权限

- **URL**：`https://github.com/GengYunChuChao/GengYun/issues/4`
- **状态**：`open`（`gh api repos/GengYunChuChao/GengYun/issues/4` 实测）
- **验收条款**：AC01、AC09；逐条引用共 **4** 条
- **本页结论**：**待前置** —— C1／C4 要求「正式 AppID 实测」「真机记录」，本轮只有服务端鉴权读数，缺真机与正式登录业务会话证据 ⇒ 待前置（真机＋正式 AppID 业务登录）。

**逐条验收原文（逐字引用 issue 正文，未改写）**

- [ ] 正常微信登录可用，拒绝额外资料仍可用基础用户功能
- [ ] 越权记录编号、直接API、分享和会话撤销检查通过
- [ ] 不使用客户端声称的角色／用户ID作为最终权限依据，不泄露登录凭据
- [ ] 微信一次性 code 经服务端换取身份，客户端不可指定 openid／角色；注销会话可立即撤销；正式 AppID 实测，不以测试号界面替代登录证据

**逐条判定**

| 条款 | 判定 | 证据（`文件:行`，绑 5250520；被引文件在本页零改动） |
| --- | --- | --- |
| **C1** | **待真机** | `docs/verification/platform-checklist.md:16` 正式 AppID 行状态列逐字「账号类型已确认／服务端鉴权已测」（不含真机登录）；`:42` 逐字「最小鉴权已测／非GY-I04业务登录完成」 |
| **C2** | **可判真** | `tests/unit/gy-i22-session-inflight-cross-module.test.mjs`（跨模块越权/受众隔离用例）；`services/api/src/auth/service.ts:5` 服务端归属口径注释 |
| **C3** | **可判真** | `services/api/src/auth/service.ts:5` 逐字「微信身份只在服务端用 `code` 换取；客户端**不可**声明 openid / 角色 / 用户 id。」 |
| **C4** | **待外部** | `docs/verification/config.example.json` 只写 `"appSecretEnv": "WECHAT_APP_SECRET"`（密钥不经文件下发）；`platform-checklist.md:16` 正式 AppID 已确认但「正式 AppID 实测」的真机/端到端记录未取得 |

**复现命令**

```powershell
# C1｜预期：1 行（正则限定表格行，GY-I25 scope 句不计数）；状态列逐字「账号类型已确认／服务端鉴权已测」，无真机／业务登录证据
git show 5250520:docs/verification/platform-checklist.md | Select-String '^\| 正式 AppID'

# C2｜预期：exit 0，`tests 9 / pass 9 / fail 0`
node --test tests/unit/gy-i22-session-inflight-cross-module.test.mjs

# C3｜预期：1 行
git show 5250520:services/api/src/auth/service.ts | Select-String '只在服务端用'

# C4｜预期：1 行
git show 5250520:docs/verification/config.example.json | Select-String 'appSecretEnv'
```

## 1.3 #7 [初版 GY-I07] 实现科普／除草剂查询、详情与来源版本展示

- **URL**：`https://github.com/GengYunChuChao/GengYun/issues/7`
- **状态**：`open`（`gh api repos/GengYunChuChao/GengYun/issues/7` 实测）
- **验收条款**：AC02、AC22；逐条引用共 **3** 条
- **本页结论**：**可关** —— 来源可追溯、下架失效退出查询、禁用专家标签三条均有代码锚与绿测；页面呈现另有 `docs/verification/gy-i07-detail-route-20261011.md` 记录。

**逐条验收原文（逐字引用 issue 正文，未改写）**

- [ ] 任一展示记录能追溯实际来源；缺项不通过空白或模型补写填充
- [ ] 下架／失效退出有效查询，详情和列表一致
- [ ] 不授AI／用户经验专家认证标签，不对模拟记录显示真实用量

**逐条判定**

| 条款 | 判定 | 证据（`文件:行`，绑 5250520；被引文件在本页零改动） |
| --- | --- | --- |
| **C1** | **可判真** | `services/api/src/knowledge/reference-query.ts:109` `createReferenceQueryService`；`:75` `toSeedRows`；`docs/verification/gy-i07-detail-route-20261011.md`；`tests/reference/detail-route.test.mjs` |
| **C2** | **可判真** | `services/api/src/knowledge/public-invalidation.ts:81` `decidePublicVisibility`；`tests/unit/knowledge-herbicides-http.test.mjs` 用例「负例·失效(expired/withdrawn/conflicting/unknown)与下架(hidden/deleted)条目退出有效查询」 |
| **C3** | **可判真** | `packages/reference/constants.mjs:157` `FORBIDDEN_LABELS`；`:97` `DISPLAY_LABELS`；`tests/reference/labels.test.mjs` |

**复现命令**

```powershell
# C1｜预期：exit 0
node --test tests/unit/knowledge-herbicides-http.test.mjs tests/reference/detail-route.test.mjs

# C2｜预期：exit 0，`fail 0`
node --test tests/unit/knowledge-herbicides-http.test.mjs

# C3｜预期：exit 0，`tests 9 / pass 9 / fail 0`
node --test tests/reference/labels.test.mjs
```

## 1.4 #8 [初版 GY-I08] 实现药剂适用过滤与标签原文用量安全边界

- **URL**：`https://github.com/GengYunChuChao/GengYun/issues/8`
- **状态**：`open`（`gh api repos/GengYunChuChao/GengYun/issues/8` 实测）
- **验收条款**：AC13、AC14、AC22；逐条引用共 **4** 条
- **本页结论**：**可关** —— 四条均有规则版本锚＋绿测；「100 组」由 `tests/reference/i08-scenarios-100.test.mjs` 内部遍历，7 组用例全绿。

**逐条验收原文（逐字引用 issue 正文，未改写）**

- [ ] 至少100组登记／匹配／限制场景全部通过，含冲突、失效、未知和模拟
- [ ] 未核对／不适用／禁用不能进入可执行建议或问答用量卡片
- [ ] 所有风险文字无绝对安全／零药害承诺，有功能关闭开关
- [ ] 需求第6节100组登记／制剂／来源冲突用例全过；无来源、模拟、失效、多匹配和关键字段冲突均阻断，所有消费端使用同一规则版本

**逐条判定**

| 条款 | 判定 | 证据（`文件:行`，绑 5250520；被引文件在本页零改动） |
| --- | --- | --- |
| **C1** | **可判真** | `tests/reference/i08-scenarios-100.test.mjs`（615 行，7 组用例内部遍历 100 组场景，含冲突／失效／未知／模拟） |
| **C2** | **可判真** | `packages/reference/deterministic.mjs:511` `evaluateDoseBoundary`；`:257` `evaluateExecutableAdvice`；`tests/reference/i08-dose-empty-vacuous-guard.test.mjs`、`tests/reference/i08-dose-guard-negatives.test.mjs` |
| **C3** | **可判真** | `packages/reference/deterministic.mjs:121` `readFeatureSwitches`（功能关闭开关，`:138` 在评估入口应用）；`packages/reference/constants.mjs:157` `FORBIDDEN_LABELS`（绝对化措辞禁列）；`tests/unit/i08-dose-switch-default.test.mjs` |
| **C4** | **可判真** | `packages/reference/constants.mjs:195` `APPLICABILITY_RULE_VERSION = 'gy-i08/1.2.0'`（所有消费端同一规则版本）；`tests/reference/i08-rule-version.test.mjs` |

**复现命令**

```powershell
# C1｜预期：exit 0，`tests 7 / pass 7 / fail 0`
node --test tests/reference/i08-scenarios-100.test.mjs

# C2｜预期：exit 0，`4 / 4` 与 `2 / 2` 全 pass
node --test tests/reference/i08-dose-empty-vacuous-guard.test.mjs tests/reference/i08-dose-guard-negatives.test.mjs

# C3｜预期：exit 0，`tests 5 / pass 5 / fail 0`
node --test tests/unit/i08-dose-switch-default.test.mjs

# C4｜预期：exit 0，`tests 8 / pass 8 / fail 0`
node --test tests/reference/i08-rule-version.test.mjs
```

## 1.5 #16 [初版 GY-I16] 实现收藏与可浏览的识别历史

- **URL**：`https://github.com/GengYunChuChao/GengYun/issues/16`
- **状态**：`open`（`gh api repos/GengYunChuChao/GengYun/issues/16` 实测）
- **验收条款**：AC17、AC09；逐条引用共 **4** 条
- **本页结论**：**待前置** —— C2 的「候选与人工选择分开、失败任务真实可见」属页面级呈现，仓库内只有组件单测，无真机证据 ⇒ 待前置（真机页面证据＋阶段 2 PG 持久化）。

**逐条验收原文（逐字引用 issue 正文，未改写）**

- [ ] 他人不能读取私有历史，旧收藏不恢复失效推荐资格
- [ ] 候选与人工选择分开，失败任务真实可见
- [ ] 识别／收藏不自动转成已使用事实
- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

**逐条判定**

| 条款 | 判定 | 证据（`文件:行`，绑 5250520；被引文件在本页零改动） |
| --- | --- | --- |
| **C1** | **可判真** | `services/api/src/favorites/service.ts:91` `favoriteEligibleForRecommendation` 逐字 `return view.reference_state === 'available';`；`:87` 注释「只看 reference_state，**不看**收藏时间新旧、不看是否曾经可用」 |
| **C2** | **待真机** | `docs/verification/platform-checklist.md:40` 的「真机设备」行状态列逐字「未验证」 |
| **C3** | **可判真** | `services/api/src/favorites/service.ts:16` 注释「可见性逐次重查、收藏不授予可见性」；`services/api/src/favorites/store.ts:4` 内存实现边界声明（不宣称端到端可用） |
| **C4** | **可判真** | `services/api/src/favorites/service.ts:19` 注释「`favoriteEligibleForRecommendation()` 只看**本次派生**的 `reference_state`」；`services/api/src/messages/store.ts:4` 同款读取时重查边界 |

**复现命令**

```powershell
# C1｜预期：exit 0，`tests 7 / pass 7 / fail 0`
node --test tests/unit/favorites-http.test.mjs

# C2｜预期：1 行，状态列「未验证」
git show 5250520:docs/verification/platform-checklist.md | Select-String '真机设备'

# C3｜预期：exit 0
node --test tests/unit/favorites-http.test.mjs tests/unit/favorites-history-visibility.test.mjs

# C4｜预期：exit 0，`tests 8 / pass 8 / fail 0`
node --test tests/unit/favorites-history-visibility.test.mjs
```

## 1.6 #17 [初版 GY-I17] 实现首版应用内消息、未读状态与权限跳转

- **URL**：`https://github.com/GengYunChuChao/GengYun/issues/17`
- **状态**：`open`（`gh api repos/GengYunChuChao/GengYun/issues/17` 实测）
- **验收条款**：AC18、AC09；逐条引用共 **4** 条
- **本页结论**：**待前置** —— 四条均有域层/HTTP 证据且全绿，但 `real` 模式因无持久存储恒 503，端到端不可用 ⇒ 待前置（阶段 2 PG 持久化）。

**逐条验收原文（逐字引用 issue 正文，未改写）**

- [ ] 重复调度不重复创建，未读计数可复核
- [ ] 发送或创建不当作已读；游客和其他用户不可读
- [ ] 首版不接微信外部推送，不虚构真人互动消息
- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

**逐条判定**

| 条款 | 判定 | 证据（`文件:行`，绑 5250520；被引文件在本页零改动） |
| --- | --- | --- |
| **C1** | **可判真** | `services/api/src/messages/store.ts:11` 注释「`insertMessage`：同 id 或同 `(owner_id, event_key)` 已存在 ⇒ 不写入、返回 'duplicate'」；`tests/unit/messages-http.test.mjs` 用例「消息列表实际HTTP：整链固定15min，读状态不改变水位，每页重查引用」 |
| **C2** | **可判真** | `services/api/src/messages/store.ts:12` 注释「`markReadIfUnread`：读状态的唯一写入口，**比较并写入（CAS）**＋**单调**」；`:131` 起存储实现 |
| **C3** | **可判真** | `docs/architecture/contract-status.json:1771` blocker 逐字「…真实事件/目标端口、PG/注销及页面/Android仍待验收，不虚构真人消息」 |
| **C4** | **可判真** | `services/api/src/messages/store.ts:4` 注释「本片交付**内存实现**…不宣称消息系统已端到端可用」；`services/api/src/favorites/service.ts:16` 读取时重查口径 |

**复现命令**

```powershell
# C1｜预期：exit 0，`tests 10 / pass 10 / fail 0`
node --test tests/unit/messages-http.test.mjs

# C2｜预期：`fail 0`
同上命令

# C3｜预期：1 行
git show 5250520:docs/architecture/contract-status.json | Select-String '不虚构真人消息'

# C4｜预期：exit 0
node --test tests/unit/messages-http.test.mjs tests/unit/favorites-history-visibility.test.mjs
```

## 1.7 #22 [初版 GY-I22] 完成权限、安全规则及首版端到端失败回归

- **URL**：`https://github.com/GengYunChuChao/GengYun/issues/22`
- **状态**：`open`（`gh api repos/GengYunChuChao/GengYun/issues/22` 实测）
- **验收条款**：AC01、AC02、AC07、AC08、AC09、AC13、AC16、AC19、AC21、AC22、AC23、AC29；逐条引用共 **3** 条
- **本页结论**：**待裁** —— C1 的「未解决严重安全／权限缺陷 0」需对已登记但未修的两个发现做严重性裁定；证据页自述「供监工/指挥裁定」⇒ 待裁。

**逐条验收原文（逐字引用 issue 正文，未改写）**

- [ ] 有限关键安全及权限用例全部通过，未解决严重安全／权限缺陷0
- [ ] 实际接口状态及数据结果可核对，不能只交截图或实现同形测试
- [ ] 任何处方混配换算、伪来源或未审内容公开均阻止发布

**逐条判定**

| 条款 | 判定 | 证据（`文件:行`，绑 5250520；被引文件在本页零改动） |
| --- | --- | --- |
| **C1** | **待裁** | `docs/verification/gy-i22-cross-module-security-e2e-20261027.md:484` 逐字「§5.1 / §5.2 两个发现：**未修**，仅登记披露」；`:498` 节标题「结论（供监工/指挥裁定）」 |
| **C2** | **可判真** | 同证据页 `:490` 逐字「生产代码…本片改动 = 0 字节」＋ §4.1–§4.4 变异自证（临时改动后 `git checkout --` 回退）；`tests/unit/gy-i22-job-inflight-guard-and-ownership.test.mjs`、`tests/unit/gy-i22-consent-withdrawal-inflight-http.test.mjs` 为同组另两份用例 |
| **C3** | **可判真** | `packages/reference/deterministic.mjs:511` `evaluateDoseBoundary`（处方/混配/换算关闭）；`services/api/src/knowledge/public-invalidation.ts:81` `decidePublicVisibility`（未审内容不放行） |

**复现命令**

```powershell
# C1｜预期：1 行
git show 5250520:docs/verification/gy-i22-cross-module-security-e2e-20261027.md | Select-String '仅登记披露'

# C2｜预期：exit 0，`tests 9 / pass 9 / fail 0`
node --test tests/unit/gy-i22-session-inflight-cross-module.test.mjs

# C3｜预期：exit 0，`tests 2 / pass 2 / fail 0`
node --test tests/reference/i08-dose-guard-negatives.test.mjs
```

## 1.8 #27 [初版 GY-I25] 提前验证正式AppID、真机域名及AI和数据库服务接入

- **URL**：`https://github.com/GengYunChuChao/GengYun/issues/27`
- **状态**：`open`（`gh api repos/GengYunChuChao/GengYun/issues/27` 实测）
- **验收条款**：AC07、AC09、AC11、AC12、AC19、AC21、AC28、AC29；逐条引用共 **3** 条
- **本页结论**：**待前置** —— C1 要求六类服务各一真实成功样例＋受控失败＋正式 AppID 真机联网录音证据；接入矩阵现状最高只到「接入局部已测」，数据库/对象存储「阻塞」⇒ 待前置（真实供应商＋真机）。

**逐条验收原文（逐字引用 issue 正文，未改写）**

- [ ] 六类服务至少各一个真实成功样例和一个受控失败路径，正式AppID／真机联网及录音格式有证据；测试号、模拟和缺失资格如实列出，不冒称可用
- [ ] 密钥只在服务端，模型／资料不公开隐私，接口权限与删除处理能力形成可核查记录；未知训练留存禁止用户数据训练
- [ ] 输出接入矩阵、阻塞及替代适配方案，GY-I01据此冻结配置；本任务验证接入，不替代需求中的全量准确率与性能验收

**逐条判定**

| 条款 | 判定 | 证据（`文件:行`，绑 5250520；被引文件在本页零改动） |
| --- | --- | --- |
| **C1** | **待外部** | `docs/verification/provider-matrix.md:34`–`:41` 八行接入矩阵；`:40` 关系数据库、`:41` 对象存储状态列均逐字「阻塞」；`docs/verification/platform-checklist.md:48`–`:52` 真机联网／录音格式／拒绝授权均「未验证」 |
| **C2** | **可判真** | `docs/verification/config.example.json` 只写 `"appSecretEnv": "WECHAT_APP_SECRET"`、`"urlEnv": "GENGYUN_DATABASE_URL"`（不含密钥本体）；`services/api/src/auth/service.ts:357` `PROVIDER_UNAVAILABLE` 缺配置即拒服务 |
| **C3** | **待裁** | `docs/verification/provider-matrix.md:30`–`:43` 总表与口径句、`:151`–`:159`「阻塞与替代方案」表（含「是否影响 GY-I01 冻结」列）；「GY-I01 据此冻结配置」属 GY-I01 判据，本页不代判 |

**复现命令**

```powershell
# C1｜预期：1 行，状态列「阻塞」
git show 5250520:docs/verification/provider-matrix.md | Select-String '对象存储'

# C2｜预期：2 行
git show 5250520:docs/verification/config.example.json | Select-String 'appSecretEnv|urlEnv'

# C3｜预期：1 行
git show 5250520:docs/verification/provider-matrix.md | Select-String '是否影响 GY-I01 冻结'
```

## 2 明确不可关的 issue（不重复全表）

| issue | 标题 | 一句原因（引用处绑 5250520） |
| --- | --- | --- |
| #19 | [初版 GY-I19] 贯通注销去身份、在线7日备份30日删除与恢复验收 | `docs/architecture/contract-status.json:419` 逐字「备份副本清除未接线 ⇒ 各模块 backup_state 停留 pending，完成判定（completionStatus）因此为 blocked」 |
| #20 | [初版 GY-I20] 冻结独立评估样本、标准答案及评估程序 | 样本冻结缺 `reviewedBy` 监工签核，签核未取得；仅登记缺项，不足以判定样本已冻结 |
| #21 | [初版 GY-I21] 持续评估各项真实AI能力并汇总首版验收门槛 | 读数仍为 `isRealEvaluation=false`／`gateStatus=not_evaluated`／`claimable=false`，无真实调用即无法汇总门槛 |
| #23 | [初版 GY-I23] 执行Android／iOS真机、时延容量及完整演示验收 | `docs/verification/platform-checklist.md:40` 的「真机设备」行状态列逐字「未验证」 |
| #24 | [初版 GY-I24] 部署联网比赛版、备份恢复并交付完整材料 | `deploy/README.md:3` 逐字「本目录只有部署准备物：没有部署、没有购买、没有扩权、没有改动既有资源。」 |

## 3 汇总表

| issue | 条款数 | 可判真 | 待裁 | 待真机 | 待外部 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| #3 | 3 | 3 | 0 | 0 | 0 | 待裁 |
| #4 | 4 | 2 | 0 | 1 | 1 | 待前置 |
| #7 | 3 | 3 | 0 | 0 | 0 | 可关 |
| #8 | 4 | 4 | 0 | 0 | 0 | 可关 |
| #16 | 4 | 3 | 0 | 1 | 0 | 待前置 |
| #17 | 4 | 4 | 0 | 0 | 0 | 待前置 |
| #22 | 3 | 2 | 1 | 0 | 0 | 待裁 |
| #27 | 3 | 1 | 1 | 0 | 1 | 待前置 |
| **合计** | **28** | **22** | **2** | **2** | **2** | 2 可关 / 4 待前置 / 2 待裁 |

- 汇总表口径见 §0「判定四档」与「issue 级结论」：`可关`＝全条款可判真且无列明前置；`待前置`＝或仍有待裁／待真机／待外部条款，或条款全可判真但端到端缺列明的前置（#17 的 `real` 模式无持久存储恒 503 属此情形）；`待裁`＝口径／严重性裁定权在监工或用户。
- 本页**不作**「验收通过」结论：判定只到「具备可关闭条件」或「待 X」。
- 注意列义不同：`待裁／待真机／待外部` 三列是**条款级**计数，`结论` 列是 **issue 级**。故 `#3` 三列均为 0 而结论为 `待裁`——其 3 条条款全部可判真，待裁的是「`review_status: unverified` 形态能否算 #3 关闭」这一口径（依据见 §1.1）。

## 4 本轮实测读数（本页作者亲自执行，原样摘录）

```text
Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
  → exit 0 ｜ 2026-10-18 15:32:38 +08:00

node tools/verify-contract-status.mjs
  → exit 0 ｜ PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项

git ls-tree -r --name-only 5250520 docs/verification | Select-String -Pattern 'i07|i08|i22'
  → exit 0 ｜ total=101（assets=85，md=16）

npm run test:docs          （新增本页**前**跑过一次）
  → exit 0 ｜ 末行 PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住

npm run lint
  → exit 0 ｜ 末行 lint 通过（静态检查；不代表运行期或真实服务已通过）。

node --test tests/unit/knowledge-herbicides-http.test.mjs tests/reference/herbicide-provenance.test.mjs tests/reference/labels.test.mjs
  → exit 0 ｜ tests 28 / pass 28 / fail 0

node --test tests/unit/gy-i22-session-inflight-cross-module.test.mjs
  → exit 0 ｜ tests 9 / pass 9 / fail 0（含「用户令牌访问全部后台面一致 403 SCOPE_DENIED」）

node --test tests/reference/i08-scenarios-100.test.mjs
  → exit 0 ｜ tests 7 / pass 7 / fail 0

node --test tests/reference/labels.test.mjs
  → exit 0 ｜ tests 9 / pass 9 / fail 0

node --test tests/unit/messages-http.test.mjs
  → exit 0 ｜ tests 10 / pass 10 / fail 0

node --test tests/unit/favorites-http.test.mjs
  → exit 0 ｜ tests 7 / pass 7 / fail 0

node --test tests/unit/favorites-history-visibility.test.mjs
  → exit 0 ｜ tests 8 / pass 8 / fail 0

node --test tests/reference/i08-dose-empty-vacuous-guard.test.mjs
  → exit 0 ｜ tests 4 / pass 4 / fail 0

node --test tests/reference/i08-dose-guard-negatives.test.mjs
  → exit 0 ｜ tests 2 / pass 2 / fail 0

node --test tests/reference/i08-rule-version.test.mjs
  → exit 0 ｜ tests 8 / pass 8 / fail 0

node --test tests/unit/i08-dose-switch-default.test.mjs
  → exit 0 ｜ tests 5 / pass 5 / fail 0

git show 5250520:packages/knowledge/herbicides/records-2026.json   （计数）
  → exit 0 ｜ usable_as_dose false = 20；card_eligible false = 20；source_validity valid = 20；review_status unverified = 40（20 条记录各 2 处）；行数 2177 行

git cat-file -s 5250520:packages/knowledge/herbicides/records-2026.json
  → exit 0 ｜ 90131（字节，按 blob 计；worktree 的 CRLF 版为 92308 字节，72693 是字符数，不作字节数用）

git diff --numstat 5250520..HEAD
  → exit 0 ｜ 只有本页一行新增；被引文件零改动
```

- **与派单示例的差异（如实记录）**：派单写的 `tests/reference/herbicides-provenance.test.mjs` 在 5250520 **不存在**；实际为 `tests/reference/herbicide-provenance.test.mjs`（单数）。本页命令一律按实测文件名。

**门禁（串行实跑；本页已在工作区时实测）**

```
npm run test:docs
  → exit 0 ｜ 研究记录校验：4 通过 / 0 失败 / 4 legacy 已钉住

npm run lint
  → exit 0 ｜ tsc 两项 PASS + 仓库卫生扫描 PASS
```

## 5 未取得（本次未跑，不得据本页推断已通过）

1. **真机 / 微信开发者工具自动化**：未跑。`docs/verification/platform-checklist.md:40` 的「真机设备」行状态列为「未验证」；`:48`–`:52` 的 Android 联网／iOS 联网／录音格式／时长上限／拒绝授权五行同为「未验证」。
2. **真实供应商调用**：本次零调用。`docs/verification/provider-matrix.md:34`–`:39` 状态列最高为「接入局部已测」，无新增真实成功样例。
3. **PostgreSQL / 对象存储实库**：未跑。`provider-matrix.md:40`、`:41` 状态列「阻塞」。
4. **部署 / 域名 / 网关 / CDN**：未做。`deploy/README.md:3` 逐字「本目录只有部署准备物：没有部署、没有购买、没有扩权、没有改动既有资源。」
5. **`npm run test:unit` 全量**：未跑。本轮只跑 §4 列出的 11 个测试文件。
6. **微信扫码登录的浏览器端到端**：未跑（需正式 AppID 与真机路径，属 #4 前置）。
7. **#22 §5.1 / §5.2 两个发现的严重性裁定**：未取得，属监工/指挥职责。
8. **新增本页后的复跑**：`npm run test:docs` exit 0、`npm run lint` exit 0（读数见 §4 的「门禁」块）；其余门禁（`git diff --check` 两点／三点、`git merge-tree --write-tree`）只能在提交后实测，读数记入交接件，不在本页伪造。
9. **本页数字与判定档位无门禁看守**：`npm run test:docs` 只校验文档结构与表格列数（`tools/validate_development_docs.py`），**不校验** §4 的读数、逐条判定与汇总表数字——这些只能人工复核；改数字或改档位不会让任何门禁变红。

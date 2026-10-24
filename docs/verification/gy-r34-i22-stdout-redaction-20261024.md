# GY-I22 验收项① · stdout 私密前缀暴露的范围与处置（证据页）

- 分支 `feat/gy-r34-likes-read`，HEAD `f59596c6`。本页只取证、不定级；定级由用户裁定（见 §5）。
- 侦察范围：`services/api/src/**`、`tools/**`、`tests/**`、`.github/workflows/**`、`miniprogram/**`。
- 页内口径：只写「文件 + 符号/函数名」。⛔ 不写 `path:123` 形式的新锚点——doc-anchors 门禁会把行号形式扫成假引用，且行号易腐。
- 本页不含任何 IP、账号、密钥片段或私密文件内容；凭据文件未打开、未读取、未打印。

## §1 结论速览

1. **原事故是一次性本地诊断命令，不在仓内。** 2026-10-23 腾讯样本会话中，一条 ad-hoc 诊断把私密 TXT 的**行首 40 字符**打到了本机 stdout，含两个 BizType 的部分字符；未入库、未入页、未入提交。出处见 `docs/verification/gy-r34-tencent-ai-samples-20261023.md` 的 §4「凭据与脱敏自证」。该命令未随代码提交，**从本仓不可复现**——因此「范围」只能按「哪些打印面能承载私密前缀」核，不能按「哪条命令」核。
2. **纪律已固化，但只是注释级。** `tools/evidence/tencent-ai-samples.mjs` 头注释第 6 条写明「私密文件内容一律不得以任何长度前缀进入 stdout / stderr / 日志 / 报告」，并给了替代做法（「行号 + 字段名 + 长度 + 正则布尔」或 `sha256(行)[:8]`）。**但没有运行期强制**：同文件的 `assertNoSecretLeak()` 只做**全值子串包含**判定（`MIN_SECRET_LENGTH = 8`），打印一个 8 字符**前缀**不会命中。它检不出「前缀」这一类。
3. **仓内仍有一处活的「凭据前缀进 stdout」。** `tests/integration/user-chain-e2e.mjs` 的 `masked()` 把真实会话 `access_token` 截前 8 字符 + 长度，经该文件步骤表的 `console.log` 落到 stdout，**通过路径与失败路径都打**。它与原事故同类不同源：不是私密文件，是运行期签发的 bearer 前缀。
4. **媒体域对象键没有明文前缀出口。** 全仓 `rawRef` / `derivativeRef` / `object_ref_cipher` 的打印零命中。唯一一处 `object_ref_cipher` 打印取的是密文信封（`services/api/src/media/object-ref-cipher.ts` 定义 `v1.<iv>.<tag>.<ct>`，IV 每次随机），前 12 字符只含 `v1.` 加 IV 前 9 个 base64url 字符，**不含任何明文片段**。
5. **是否构成泄露。** **构成一次已发生的、范围极小的私密前缀外泄**（两个 BizType 的部分字符，通道是本机终端）；**未构成凭据外泄**——`Authorization` / `SecretId` / `SecretKey` / `SessionToken` / `session_key` / 手机号 / openid 在全仓打印面**没有任何值级输出**。
6. **建议档位区间。** 已发生那一次：**「一般」偏下**（处置是重置两个 BizType，成本为零；暴露面限于本机终端与会话转录）。其余打印面：**「可接受残余」**。**不建议「严重」**——没有任何一条通道能把可用凭据或可识别个人的信息送出仓外。若用户把「终端 / agent 转录」判为长期留存面，可整体上调到「一般」。

## §2 打印面清单表

统计口径：一行含打印原语计 1 处。`services/api/src` 15 行 `console.*` + 13 行结构化 `app.log.*` / `request.log.*`；`tools` 360 行；`tests` 512 行 `console.*`，另有 57 个 integration 文件以 `note(...)` 包装 `console.log`（命中行 330，含定义与同名变量，非精确调用数）；`.github/workflows` 67 行 `echo`；`miniprogram` 1 行。**合计约 1 300 处**，逐处判读后按风险归为 17 组：

| 文件 · 符号 | 打印什么 | 触发条件 | 通道 | 判定 |
| --- | --- | --- | --- | --- |
| `tools/evidence/tencent-ai-samples.mjs` · `assertNoSecretLeak()` | RequestId、动作、耗时、字节数、摘要哈希 | 每次运行收尾自检 | 本地终端 | 无风险（自检只拦全值，见 §1.2） |
| `tools/verify-provider-adapter-live.mjs` · `say()` / `assertNoSecrets()` | 供应商响应摘要 | 每行打印前逐值比对，命中即抛 `SECRET_LEAK_IN_OUTPUT` | 本地终端 | 无风险（全仓唯一 fail-closed 打印闸） |
| `tools/verify-llm-live.mjs` · 批次回执 `console.log` | 轮次常量 `AUTHORIZATION`、case、状态、耗时、计费 | 正常收尾 | 本地终端 | 无风险：`AUTHORIZATION` 是 `'gy25-i25-llm-live-...'` 这类**轮次标签**，不是凭据；`entries` 不含请求/响应正文 |
| `tools/verify-tencent-live.mjs` · 回执 `console.log` | 轮次标签、`key`、`state`、`reservedCny` | 正常收尾 | 本地终端 | 无风险（同上；签名头不进回执） |
| `tools/verify-env.mjs`、`verify-deepseek.cjs`、`verify-tokenhub.mjs`、`verify-tencent-identity.cjs`、`verify-wechat-account.cjs` · 各 `main().catch` | 固定英文句子（如「no content logged」「credentials and responses suppressed」） | 仅异常路径 | 本地终端 | 无风险（异常对象整体丢弃，不拼 `err.message`） |
| `tools/evaluation/extract-docx-weed-samples.mjs` · `process.stdout.write` | 源 Word 文档的 `basename` + **全量 sha256** | 正常路径 | 本地终端 | 可接受残余：不是源码内容，但是原稿的文件名与稳定指纹；该脚本**不在 CI** |
| `tools/verify-research-records.mjs` · 登记行 | 研究记录全量 sha256 | 正常路径 | CI（`development-docs.yml`） | 可接受残余：只暴露合成研究台账的指纹 |
| `tests/integration/user-chain-e2e.mjs` · `masked()` | **会话 `access_token` 前 8 字符 + 总长度** | 正常路径与失败路径（步骤表两处 `console.log`） | 本地终端 | **可能泄露**（仅此一处为值级前缀）；该文件**不在 CI** |
| `tests/integration/media-persistence-pg.mjs` · `note()` 里的 `object_ref_cipher` 前缀 | 密文信封前 12 字符 | 正常路径 | CI（`real-pg-integration.yml`） | 无风险：只含 `v1.` + 随机 IV 前缀（§1.4） |
| `tests/integration/media-concurrency-pg.mjs`、`admin-jobs-pg.mjs`、`tts-http.mjs` · `note()` | 合成主体 / 媒体 / 任务的 UUID 前 8 字符 | 正常路径 | CI | 无风险：一次性集群内合成 UUID，非个人标识 |
| `tests/integration/account-deletion-pg.mjs` · `note()` | 回执 `receipt_hash` 前 16 hex | 正常路径 | CI | 无风险：sha256 摘要，回执本体为高熵值，前缀不可逆 |
| `tests/integration/user-chain-e2e.mjs` · 失败收尾 | 一次性集群 **postgres 日志末 25 行** | 仅失败路径 | 本地终端 | 可接受残余：PG 默认 `log_statement=none`，但一旦有人给该集群开全量语句日志，SQL 参数会经此出到 stdout |
| `services/api/src/server.ts` · `main().catch` | `console.error('API 启动失败：', error)` 整对象（含 `stack`） | 仅启动期未分类异常 | 容器 stdout | 可接受残余：`DATABASE_URL` 已在 `services/api/src/config.ts` 的 `isPostgresUrl()` 前置校验，非法串走 `ConfigError` 分支且只打**字段名 + 固定原因**，不带值；能漏的只剩驱动栈本身 |
| `services/api/src/ocr/service.ts`、`recognitions/service.ts` · `recordTerminalHistory()` 的 `console.warn` | 端口 `kind`、`job_state`、`error.message` | 仅历史端口写入异常 | 容器 stdout | 无风险（该函数注释即声明「不含归属身份 / 媒体引用 / 候选」） |
| `services/api/src/app.ts` · `requestLogFields()` / `logSafePath()` | `method`、去掉查询串的站内相对路径、`host`、远端地址 | 每个请求 | 容器 stdout | 无风险：**已脱敏**；查询串整条丢弃，坐标形态路径 fail-closed 丢弃 |
| `.github/workflows/*` · 各步 `echo` | 退出码、标记命中数、末行、`has_column_privilege` 布尔 | 每步 | Actions 日志（**公开可见**） | 无风险（值级）；另注：`run:` 块内联了 `synthetic-ci-owner-only` 这类**合成**口令，本就随 workflow 文件公开，不构成新泄露 |
| `miniprogram/utils/messages-api.js` · `console.warn` | 消息模块告警条目 | 客户端运行期 | 微信开发者工具控制台 | 无风险（带 `typeof console` 存在性判断） |

## §3 通道与可见性

| 通道 | 谁会看到 | 本仓读数 | 是否长期留存 |
| --- | --- | --- | --- |
| GitHub Actions 运行日志 | **任何人**：`gh api repos/GengYunChuChao/GengYun --jq '{private,visibility}'` 实测 `private=false`、`visibility=public` | 值级泄露 0 处；含 CIP 密文前缀、UUID 前缀、sha256 前缀、退出码 | 是（默认 90 天） |
| 本地终端 / agent 会话转录 | 本机操作者、以及抓取终端输出的 agent | **原事故的唯一通道**；另有 `masked()` 的 token 前缀 | **是**，且比 CI 更难清理（回滚缓冲、编辑器历史、转录存档） |
| 容器 stdout → 云托管日志采集 | 云账号内可读日志的人 | 只有 `Console` 两级信息与 pino 请求日志，均已脱敏（§2 末四行） | 是（服务商保留期） |
| 错误上报平台 | —— | **无**：全仓无 sentry / otel / datadog / bugsnag 依赖、无 DSN | 不适用 |
| Actions 产物 `upload-artifact` | 任何人（公开仓） | 仅 `failmatrix.yml` 的 `matrix.json`，实测 `actual` 只存 `{ code }` | 是 |

**真正的泄露通道排序**：① 本地终端 / 转录（唯一发生过、且所有「诊断式打印」都天然落在这里）＞ ② 公开 Actions 日志（面最大，但当前只有非敏感前缀）＞ ③ 云托管日志（面最小、已脱敏）。

## §4 处置选项对照（只给成本与风险，不给结论）

| 选项 | 成本 | 覆盖面 | 风险 / 代价 |
| --- | --- | --- | --- |
| ① 统一脱敏工具 `maskPrefix(s)`：保留前 N 位 + 省略 | 中：新增 `packages/privacy/` 一侧的工具 + 逐处替换 + 用例 | 所有 `console.*` / `note()` / `say()` | **语义上仍保留前缀**——与头注释第 6 条「任何长度前缀」直接冲突；且现有 `assertNoSecretLeak()` 用全值包含判定，**拦不住**前缀，等于没有闸 |
| ② 只打长度与哈希前 8 位 | 低：改现有几处打印拼接 | 全部前缀类打印 | 最长尾做法，与头注释第 6 条给的替代形态一致；代价是可读性下降（排障时要多跑一步才能比对） |
| ③ 打印改结构化事件，只写 `logger` | 中高：`services/api/src` 已有 Fastify/pino 与 `requestLogFields()` 先例，但 `tools/`、`tests/` 是纯 Node 脚本，没有 logger 可复用（`services/api/src/admin/ops/account-events.ts` 的日志口是装配注入式，脚本用不上） | 只有 `services/api/src` | 脚本侧要新引依赖或自建；**不解决终端面**——logger 在本地仍写 stdout |
| ④ 靠 CI 侧 `::add-mask::` | 低 | **仅** Actions | 本地终端、云托管、agent 转录**全部无效**；本仓当前一处 `add-mask` 都没有，等于从零建；且 mask 是按值匹配，前缀本身要先被知道才能 mask |
| ⑤ 不改 | 零 | —— | 残余风险 = 「诊断式打印」这条**人为**通道仍在：纪律只写在一条评论区注释里，没有 lint、没有闸、没有用例；下一个 ad-hoc 命令可以原样重演 |

补充读数（供选项 ③ 判断）：`services/api/src` 侧唯一可复用的**已落地**脱敏设施是 `packages/privacy/redact.mjs` 的 `redactForLog()`（键名黑名单含 `object_ref` / `object_ref_cipher` / `authorization` / `openid` / `phone`，值形态拦 data URI、长 base64、Bearer、坐标对）；但它在 `services/api/src` 的**运行期**只有 Fastify 请求日志经由 `requestLogFields()` 这一条路在用，`console.*` 与 `tools/`、`tests/` 全都没有走它。

## §5 待用户定级的三问

1. **「终端 / agent 会话转录」算不算泄露面？** 算 = 原事故必须定「一般」并重置两个 BizType；不算 = 可定「可接受残余」，只留纪律。这是唯一会改变档位判断的分叉。
2. **`tests/integration/user-chain-e2e.mjs` 的 `access_token` 前 8 字符，要不要一并处置？** 它不在 CI、令牌是一次性集群内签发的；但它违反了 `services/api/src/auth/tokens.ts` 头注释「不在 URL / 日志记录」的自我约定。处置成本近乎零（改一处 `masked()`），不处置则「同类问题只清了一半」容易被复审反驳。
3. **纪律要不要升级为可执行闸？** 现状是注释级（`tools/evidence/tencent-ai-samples.mjs` 头注释第 6 条）+ 全值自检。升级 = 加一条 lint/用例，把「打印里出现 `slice(0, N)` 且变量名命中凭据词表」判红；不升级 = 残余风险永久挂在人为纪律上。

## §6 未取得与盲区

- **原事故命令取不到**：它是 ad-hoc 诊断，未入仓、未入提交、未入页，只在本机终端历史里留有痕迹。本页**没有**去翻终端历史或转录文件（那本身会二次扩散），因此「40 字符里到底含哪几个 BizType 字符」未取得，也不需要取得——处置是重置。
- **未核**：GitHub Actions 历史运行日志里是否曾出现前缀类输出（需要逐 run 拉日志，本次未做；本页结论只基于**当前 HEAD 的代码**）。
- **未核**：云托管侧日志采集的实际保留期与可读范围（仓内无该配置，属用户侧信息）。
- **未核**：`tests/integration/user-chain-e2e.mjs` 的 `masked()` 是否在**其他分支**上已被改过——本次只看 `feat/gy-r34-likes-read` 的 HEAD `f59596c6`。
- **口径限制**：`tools` 的 360 行、`tests` 的 842 行打印面是按「打印原语 + 风险词表」两轮筛出来的，不是逐行人工通读；低风险组（PASS/FAIL 计数、迁移名、字节数）按模式判定，未逐条点开。
- **未做**：未运行任何测试、未起 PostgreSQL、未碰端口、未推送、未评论。
# 真实能力配置自检（`npm run verify:real-capability`）

一句话：**把「真实 AI / 真实媒体链路到底还缺什么配置」变成一条可复跑的命令**，而不是每轮靠人肉对照 [.env.example](../../.env.example)。

```powershell
npm run verify:real-capability                          # 人读表格（自检，恒 exit 0）
npm run verify:real-capability -- --json                # 机器读，稳定字段顺序、无时间戳
npm run verify:real-capability -- --strict --require=asr,chat-llm
```

工具只读**进程环境**：不读 `.env`、不读任何凭据文件、不联网、不落盘。
逐字段只输出「字段名 + present/missing + 形态布尔」——**不输出值、不输出前缀、不输出后 4 位、不输出长度数字**。

## 为什么需要它

`real` 模式的**启动必填**只有 9 项（`services/api/src/config.ts` 的 `REQUIRED_WHEN_REAL`），
而 `MEDIA_OBJECT_REF_KEY`、`MEDIA_ACCESS_GRANT_ORIGIN`、`CHAT_LLM_*`、`RECOGNITION_PROVIDER_*`
**不参与启动校验**：缺了服务照样起得来，只是对应域按域拒绝或降级——媒体域整域 503、
语音受理 409、问答退回确定性摘录、识别受理 503。于是「起得来」极易被当成「能力齐」。
本工具就是把这一格对照自动化，输出的是**能力就绪度**，不是「进程能不能启动」。

## 三态判据（只此一条规则）

| 状态 | 判据 |
| --- | --- |
| `n-a` | `APP_EXECUTION_MODE !== 'real'` ⇒ 真实域一律未接线，**任何**能力组都判「当前模式不适用」。字段行照样如实报 present／形态，所以 n-a 组也能看出「真要切 real 还缺什么」 |
| `needs-user` | 该组当前模式下适用，但要求的字段缺了（`fields-missing`），或已填字段形态非法（`fields-missing` / `present-field-invalid`） |
| `ready` | 该组至少一条「替代要求」全部齐备且形态合法，且组内**任何已填字段**都不非法 |

- 模式兜底与服务一致：`APP_EXECUTION_MODE` 未声明或声明非法 ⇒ 按 `stub` 处理（报告里 `executionModeSource` 分别为 `default`／`invalid`，并各留一条 note）。
- **为什么非 real 全判 n-a**：`config.ts` 只在 `real` 下装配真实提供者；`stub`／`preset_demo` 即使环境里有凭据也一律忽略（替身模式不得携带真实凭据）。所以「在 stub 下说某组 ready」是假话，而「说它缺字段」又是误导——两者都不如 n-a 加逐字段事实。
- ⚠ 由此带来一个必须记住的口径：**`--strict` 要在 `APP_EXECUTION_MODE=real` 下跑**，否则全部 n-a、判定恒 PASS（空转）。

## 能力组

| 组 | 覆盖字段 | real 下缺了会怎样 | 形态规则 |
| --- | --- | --- | --- |
| `database` | DATABASE_URL | 启动即失败（9 项启动必填之一）；外发账本也随之不可用 | `postgres-url` |
| `session` | SESSION_SIGNING_KEY | 启动即失败 | `length>=32`（比启动校验的「非空」更严） |
| `deletion-ledger` | DELETION_LEDGER_KEY | 启动即失败；配了也不证明独立删除账本已接线 | `non-empty` |
| `wechat-real` | WECHAT_APP_ID、WECHAT_APP_SECRET | 启动即失败（非 real 由合成 subject 派生身份，本组不适用） | `wx-app-id-16-hex`、`non-empty` |
| `object-storage` | OBJECT_STORAGE_ENDPOINT／BUCKET／ACCESS_KEY／SECRET_KEY | 启动即失败；四键齐备仍不等于接线（还要显式装配） | `https-url`、`non-empty` ×3 |
| `media-encryption` | MEDIA_OBJECT_REF_KEY | **不拦启动**：媒体域整域 503 PROVIDER_UNAVAILABLE、语音受理 409 OBJECT_UNAVAILABLE | `aes256-key-material`（64 位十六进制／32 字节 base64／32 字节原串） |
| `media-access-grant` | MEDIA_ACCESS_GRANT_ORIGIN | **不拦启动**：句柄指向占位域 `media.placeholder.invalid`；带 `--approve-real-media-wiring` 时启动拒绝 | `https-origin-only` |
| `asr` | TENCENTCLOUD_ASR_SECRET_ID／_KEY **或** TENCENTCLOUD_SECRET_ID／_KEY | ASR 域 fail-closed，语音受理 503 | `non-empty` |
| `recognition` | RECOGNITION_PROVIDER_URL、RECOGNITION_PROVIDER_KEY | 受理前 503，不回退替身；配齐也只到「能受理」（本仓无已审适配器） | `https-url`、`non-empty` |
| `chat-llm` | CHAT_LLM_ENDPOINT、CHAT_LLM_MODEL、（CHAT_LLM_API_KEY 或 DEEPSEEK_API_KEY） | 问答退回确定性摘录（`model_version` 带 `unimplemented:no-real-` 前缀），不报错 | `https-url-no-query-or-credentials`、`chat-model-name`、`chat-api-key` |
| `tts` | TENCENTCLOUD_SECRET_ID、TENCENTCLOUD_SECRET_KEY | TTS 域 fail-closed（只认共享对，不逐字段混配） | `non-empty` |
| `ocr` | TENCENTCLOUD_SECRET_ID、TENCENTCLOUD_SECRET_KEY | OCR 域 fail-closed（与 TTS 同源共享对，两域各自独立判定） | `non-empty` |

两个「比启动校验更严」的口径，是刻意的：

- `session` 按模板口径判 `length>=32`，而启动校验只看非空——本工具宁可严，别把 12 字符的签名密钥当就绪。
- `media-access-grant` 按**必填**判：它确实只在带 `--approve-real-media-wiring` 时才拦启动，但没有可用原点，真实取图链路就是不可用的。

反过来也有「本工具判不了」的：`object-storage` 四键齐备 ≠ 媒体域已接线（装配点不读 ambient env）；
`chat-llm` 三项齐备还要 `DATABASE_URL`（外发账本是硬门）。工具只回答**配置齐不齐**，不回答**端口接没接**。

## 逐字段输出口径

- `present`：trim 后非空（与 `config.ts` 的 `trimmed()` 同口径；空串＝未设）。
- `shapeOk`：该字段的形态规则过没过；**字段缺失时恒为 `false`**。
- `shapeRule`：规则 id，是**静态常量**（`length>=32`、`https-url`、`aes256-key-material`…），不是从值里算出来的。
- 因此输出里没有值、没有前缀/后 4 位；长度只以「过没过这条规则」出现，不出现实测长度。
- 环境的某个 key 读取时抛异常（getter）⇒ 按缺失处理，**异常文本不外传**（它可能带值）。

`--json` 的顶层键序固定为：`schemaVersion`、`tool`、`executionMode`、`executionModeSource`、`applicable`、
`scope`、`requiredGroups`、`summary`、`strict`、`groups`、`notes`；每组为 `id`、`label`、`state`、`stateReason`、
`requirements`、`fields`、`missing`、`alternatives`。同一环境 + 同一参数两次输出**逐字节相同**。

## `--strict` 用在哪

- **人工 / 部署前用**：在自己的机器或部署环境里 `APP_EXECUTION_MODE=real` 跑 `--strict`，
  关注组里有 `needs-user` ⇒ exit 1，并点名「哪个组的哪些字段」（多选组会保留「或」的并列结构）。
- **不要塞进 PR CI**：CI 没有凭据，跑出来只会全 n-a ⇒ 判定 PASS，是假绿；
  真绿要靠不依赖凭据的门禁（`test:unit`、`verify:anchors` 等）。
- 退出码：`0`＝自检通过（默认恒 0，它是自检不是闸门）｜`1`＝`--strict` 判定 FAIL｜`2`＝用法错误（未知参数／未知组名）。
- `--require=a,b` 只评估这些组（报告、汇总、`--strict` 都只看它们）；缺省＝全部组。

## 与 `.env.example`、`configuration.md` 的关系

- [`.env.example`](../../.env.example) 是**字段清单与取值的权威**：本工具不发明字段，覆盖的是它的子集，形态规则按 `config.ts` 的同形判据写。
- [完整配置](configuration.md) 是**语义权威**（「启动必填 ≠ 链路可用」那一节讲的就是本工具要治的病）；本工具是那条结论的**可执行版**。
- 三者分工：模板说「有哪些键」、配置参考说「每个键干什么/缺了怎样」、本命令说「**你这台机器现在到哪一格**」。
- 新增字段时：先改 `.env.example` 与 `configuration.md`，再决定是否进本工具的能力组——**不要把工具当第二份配置文档**。

## ⛔ 不许做的事

- ⛔ 不要让它读 `.env`、凭据文件、密钥管理接口或任何配置文件；输入只有进程环境。
- ⛔ 不要在输出里拼字段值——包括「只打前缀」「只打后 4 位」「只打长度」；长度只能以规则布尔出现。
- ⛔ 不要把 `--strict` 接进 PR CI 当闸门（无凭据 ⇒ 全 n-a ⇒ 假绿），也不要给它加「一律通过」的开关。
- ⛔ 不要在本工具里判「端口接没接」「供应商能不能调通」——那是 `tools/verify-*` 里各域活体装置与真实验收的范围。
- ⛔ 不要用它替代真实能力验收：`ready` 只表示**配置齐了**，不代表调用成功、不代表已接线。

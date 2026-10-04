# 六类AI服务端配置准备与实测边界

2026-10-04（UTC+8），Refs #27；基于已审main `910aec33fe3291e69c03cf60aa97d26c26e970dd`。本轮优先六类配置，不实现其他issue的应用业务，也不以配置或离线桩宣称实际能力通过。

## 真实字段与七个端点

用户授权精确私密JSON的AppSecret、DeepSeek key、腾讯SecretId/Key均存在；临时sessionToken为空，对现有长期密钥不是必填。用户另提供 `E:\GengYunPrivate\腾讯云.txt`，明确确认来自TokenHub API Key管理。该key单独映射为 `tokenhubApiKey`/TOKENHUB_API_KEY，不覆盖既有TC3字段或原文件；私密JSON与ACL继续保留。数据库字段仍缺，但不阻塞独立配置检查。

| 类别/端点 | 配置结果 | 真实局部证据 | 未验或缺项 |
| --- | --- | --- | --- |
| 识草 / TokenHub | 新端点tokenhub.tencentmaas.com/v1/chat/completions；Bearer；hy-vision-2.0-instruct；inline JPEG/PNG≤2MiB；20秒；输出128token | 只读GET /v1/models HTTP200，MODEL_LIST_AUTHENTICATED；118模型，所选视觉模型在列表；合成无效key HTTP401 | 视觉推理0、草种Top3/分数/准确率0；调用权限/额度/留存/训练/删除与跨2027-02兼容未验 |
| OCR | TC3 GeneralAccurateOCR / 2018-11-19；inline ImageBase64≤2MiB；8秒 | 固定官方SDK导出与客户端构造通过，非调用 | 服务开通/额度/实际识别与瓶身字段映射未验 |
| 普通话ASR | TC3 SentenceRecognition / 2019-06-14；16k_zh；单声道16kHz、PCM16位WAV；≤60秒，Base64≤3MiB；10秒 | 同上；离线核对DataLen为编码前文件字节数、SourceType=1 | 真机录音格式/转码、供应商真实响应未验；不把小程序10MB媒体上限当供应商上限 |
| 普通话TTS | TC3 TextToVoice / 2019-08-23；智瑜精品101001候选；16kHz mp3；文本≤100字符；8秒 | SDK局部通过；历史开通/资源包查询拒绝仍保留 | 音色适老、实际播放、开通与适用字符包未验；选择候选不是证明此账号已获准 |
| LLM问答 | DeepSeek Bearer；deepseek-flash；20秒；单次文本≤200字符、输出128token、thinking disabled、非流式 | 历史只读鉴权通过；本轮仅离线字段准备 | 实际生成0，token上限须按真实usage复核；引用/来源规则与JSON输出尚未实现/验收 |
| 文本审核 / TMS | TC3 TextModeration / 2020-12-29；UTF8 Base64；Type=TEXT、zh；≤200字符；8秒 | 官方SDK局部通过 | 用户后续交接真实BizType，已写入忽略的本机配置；策略存在/启用/调用尚未自动验证 |
| 图片审核 / IMS | TC3 ImageModeration / 2020-12-29；inline FileContent≤2MiB；8秒 | 官方SDK局部通过 | 用户后续独立交接图片BizType并私密配置；文字通过不能替代图片通过 |

所有端点拟定每端点最多2次、自动重试0；这是未获准首轮计划。当前全局budget仍false/0，实际生成/识别/审核请求0，准备库不含执行器，executionAllowed始终false。审核两个BizType已由用户后续交接并私密配置；TTS已有额度证明尚未取得，提供新key不等于额度证明。

## 视觉首选、备选与生命周期

首选改用[TokenHub图片理解](https://cloud.tencent.com/document/product/1823/136956)明确给出的hy-vision-2.0-instruct与新Bearer端点，移出旧混元TC3候选，避免已知2026-12旧接口下线依赖。新key入口为[TokenHub快速入门](https://cloud.tencent.com/document/product/1823/130058)所指API Key管理；本轮用户已有key，没有替用户开户、接受新条款或扩权。只读模型查询依据[官方API使用说明](https://intl.cloud.tencent.com/zh/document/product/1300/78941)，国内模型调用域名依据前述国内图片理解文档；不切换国际站或转发密钥。

适当备选为已有DeepSeek key对应的 `deepseek-flash` 多模态接口。[官方Vision文档](https://api-docs.deepseek.com/guides/vision/)明确接受image_url内容块和Base64图片，并非把仅文本模型冒充视觉；deepseek-v4-pro不选作图片备选。样例只记录备选，不自动切换或尝试推理。接口存在、列表可见不证明草种辨识能力。模型别名/权重/条款可能变化，compatibilityVerifiedThroughTarget=false；2027-02上线前须重新核对端点、模型、认证、条款、额度及独立评估，不能宣称永久兼容。

## SDK安装与Node24局部兼容

固定版本：ocr4.1.322、asr4.1.315、tts4.1.237、tms4.1.311、ims4.1.321。先前证书失败记录保留；本轮另用现有Node24.19.0运行时正常TLS访问官方registry成功，安装遇唯一依赖uuid9.0.1连接重置。通过现有Python正常TLS取得该精确官方tarball、核对registry SHA512，加入npm缓存；随后prefer-offline正常安装41个包至忽略缓存 `.supervisor/tencent-sdk-v2`，禁用生命周期脚本。没有关闭TLS、改变共享Git/认证配置或复制依赖到客户端。

`node tools/check-ai-sdk.cjs --modules .supervisor/tencent-sdk-v2/node_modules`在项目Node24.16.0上5模块固定版本、导出、目标动作方法和合成凭据客户端构造全部通过；HTTP/HTTPS/fetch入口被禁止，networkAttempts=0。这是局部导入/构造兼容，不是Fastify完整集成、正式运行依赖冻结、真实API或长期支持证明。传递依赖uuid9已被上游标弃用，暂只用于隔离核查，生产冻结前仍需依赖审查。CI新增固定SDK安装与同样的离线构造核验，不用真实凭据。

## 安全加载、参数审计与离线请求准备

`tools/ai-config.mjs`供后续服务端消费者使用：只把授权精确文件的允许字段映射到进程内存，不修改process.env；拒绝账号不匹配并隐藏JSON解析片段。不得日志化返回的env或请求body。配置严格匹配7个端点、认证类型、模型/动作/API/SDK版本、区域、时限、输出/次数/重试及媒体限制；不接受URL下载、动态端点或旧视觉模型替换。原verify-env同时调用这份参数核验，避免端点与凭据存在就标配置全齐。

`prepareOfflineRequest`只生成内存请求对象，无fetch或SDK执行。图片仅做文件头/大小检查，**没有实现完整解码、EXIF删除或媒体授权**；WAV核RIFF/chunk/PCM采样、声道、字节数与时长，不隐式转码。仅脱敏describe返回字段名与编码大小，保留body和凭据在私有生命周期内。未替代GY-I27的用途同意、发送/回写epoch、留存训练删除条款或GY-I06媒体处理；后续真正执行前仍须按[已审产品清单](product-readiness.md)核验，recipients当前不自动启用。

合成输入下7端点全部能离线准备；最初真实本机配置5端点参数齐、7端点凭据存在，TMS/IMS分别缺BizType，prepare CLI按预期exit1。用户后续把两个真实BizType依次存入授权私密文件后，仅更新本机忽略配置的两个值；复查7端点参数/凭据均齐，CLI exit0，预算仍false/0、executionAllowed仍false。公开模板两个值继续为空，不提交真实策略值。审核策略验证false，开通/额度/能力均不能从样例声明自动变true。全局零预算不要求等待域名/数据库才做独立配置准备。

## 可复现检查

```powershell
node --test tests/ai-config.test.mjs tests/verify-env.test.mjs tests/tokenhub-account.test.mjs tests/wechat-account.test.cjs tests/deepseek-account.test.cjs tests/tencent-identity.test.cjs
node tools/check-ai-sdk.cjs --modules <忽略缓存的node_modules>
node tools/prepare-ai-verification.mjs --credentials <获准私密JSON>
python tools/validate_development_docs.py
```

本轮21组Node离线测试通过；原13组更新为使用严格参数配置，加6组配置/媒体/敏感信息测试及2组TokenHub只读守卫。CLI没有真实生成开关。真实TokenHub本批次仅2次GET；报告只含状态、模型数量/选中模型是否列出，不输出key、身份、完整响应/URL凭据。没有上游request_id或性能/p95证据，不捏造。未采购、扩权、业务部署或发送用户媒体。

## 审核入口修正

用户反馈原tms/ims控制台链接均无法访问，已按[官方快速入门](https://cloud.tencent.com/document/product/1124/37119)和[统一控制台说明](https://cloud.tencent.com/act/solution-ai-application1-17592)改为 https://console.cloud.tencent.com/cms 。已有策略在应用管理查看；仅查看资源状态，不自动开通、授权新角色、建策略或购买。参数检查按当前文档支持英文、数字、下划线、中划线，最长32字符，保持空值为缺项。用户账号能否访问统一入口尚未验证；文档入口核实不能计为账号策略就绪。

用户随后报告“显示服务未开通／没有策略，我开通了服务，没看见策略”。这是用户自行操作声明，未分别核验文本/图片服务，不计本工具开通或已验证。已说明新控制台需从应用管理选择/新建应用，再分别配置文本、图片普通审核策略；目前未收到真实BizType，两个配置值继续为空，也未发送审核请求。

接续交接：用户明确文件中第一个是文本BizType、第二个是图片BizType；读取时按原顺序、排除已保存TokenHub key并校验格式，未覆盖既有Bearer凭据。两个字段不再是本机参数缺项，但审核策略有效性、服务类别、真实请求成功、额度和预算仍未核验，policySelectionVerified继续false。此批接续只有本地文件读取/配置与离线检查，没有新增网络请求。

后续用户新增2元人工最小测试授权，最新11请求的逐项成功/业务错误、费用预留与专用ASR交接见[真实接续证据](tencent-live-evidence.md)。此前调用0记录属于PR #40配置准备批次，不覆盖新批次；整项仍未完成。

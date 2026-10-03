# 服务候选与安全资源交接

2026-10-04。本文件是待验证资源方案，不是开通或部署证明。现有Node24/TypeScript/Fastify与PostgreSQL方案继续保留。

## 私密交接

用户授权在E盘选择位置，已创建 `E:\GengYunPrivate`，仓库外，关闭继承，仅当前用户和SYSTEM可访问。`credentials.local.json`已有微信账号、DeepSeek及腾讯云凭据；原始交接文件均保留。后续可在该私密文件添加 `tencentSecretId`、`tencentSecretKey`、`databaseUrl`，不要贴聊天或填进配置样例。这个文件不进客户端/Git/CI；ACL不等于磁盘加密或凭据轮换。

腾讯凭据应来自测试子账号，限定获准API动作；不要交接管理员权限。候选动作草案：OCR GeneralAccurateOCR、ASR SentenceRecognition、TTS TextToVoice、TMS TextModeration、IMS ImageModeration。实际CAM动作名、支持的资源范围及环境权限必须在[CAM控制台](https://console.cloud.tencent.com/cam)核查后配置；本轮没有创建或附加策略。混元旧平台迁移期间不假定ChatCompletions权限可用。

## 候选接口与限制

| 能力 | 官方资料 | 待确认事项 |
| --- | --- | --- |
| 识草 | [混元对话](https://cloud.tencent.com/document/api/1729/105701)、[兼容接口](https://cloud.tencent.com/document/product/1729/111007) | 旧TC3端点hunyuan.ai.tencentcloudapi.com公告预下线2026-12-21；vision-1.5-instruct只是历史候选。先确认新平台视觉模型/账号资格/API key，不能把兼容端点与TC3密钥混用 |
| OCR | [GeneralAccurateOCR](https://cloud.tencent.com/document/product/866/34937) | API 2018-11-19；需瓶身/标签非个人图片与字段映射；产品图片限制仍按2MB |
| ASR | [SentenceRecognition](https://cloud.tencent.com/document/api/1093/35646) | API 2019-06-14，16k_zh候选；手机录音容器/编码与60秒实际兼容未测 |
| TTS | [TextToVoice](https://cloud.tencent.com/document/api/1073/37995) | API 2019-08-23；音色、普通话剂量/单位/否定词读法与手机播放未测 |
| 大模型 | [DeepSeek模型列表](https://api-docs.deepseek.com/api/list-models/) | 已鉴权，观察到deepseek-flash和deepseek-v4-pro；生成、JSON、引用、预算、留存/训练/删除均未测 |
| 审核 | [TMS](https://cloud.tencent.com/document/product/1124/51860)、[IMS](https://cloud.tencent.com/document/product/1125/53273) | API均2020-12-29，文字和图片两个接口必须各测；业务策略/BizType尚未交接 |

所有腾讯TC3候选同时需要SecretId和SecretKey。模板只填环境变量名，留存/训练/删除字段均false表示未验证；它们不控制供应商行为。未取得用途授权不外发真实个人资料。

## SDK检查范围

官方npm registry读取到模块版本：hunyuan 4.1.318、ocr 4.1.322、asr 4.1.315、tts 4.1.237、tms 4.1.311、ims 4.1.321（各模块名为 `tencentcloud-sdk-nodejs-<服务>`）。仅查询元数据与完整性声明，未证明Node24兼容。隔离缓存安装使用固定版本、ignore-scripts，实际因CERT_HAS_EXPIRED失败；没有关闭TLS、加入运行依赖或宣称SDK导出/调用通过。待正常证书链与网络恢复后安装核查，再决定锁定版本。

## 云环境、数据库与样本

[CloudBase callContainer](https://docs.cloudbase.net/run/develop/access/mini)候选需要实际envId、服务名、AppID关联、已部署服务和授权。官方小程序通道无需单独配置服务器域名的条件不能推广到普通HTTP请求、私有媒体或管理Web/CORS。尚无已部署环境证据，本轮未部署、未开通费用、未要求购买域名。

PostgreSQL17候选需只读测试连接（私密文件）、VPC/安全组/TLS以及脱敏登记号、制剂、成分含量、来源版本字段。权威来源资料未交接前，不能造数据宣称数据库真实接入。私有存储还需桶/环境标识、ACL、短时签名与删除实验。

剩余交接：腾讯已获准服务及额度；已有CloudBase环境/服务标识或HTTPS地址；只读数据库与脱敏资料；获准非个人图片/录音/文本及Android/iOS测试设备；调用次数/费用上限。预算模板默认生成许可false、调用上限0；只读鉴权不授权购买额度或无限推理。

腾讯凭据已完成STS身份鉴权。TTS两项只读查询均被AuthFailure.UnauthorizedOperation拒绝，额度无法核实；详见[实测记录](continuation-evidence.md)。当前无需重复交接密钥，需提供已有额度证明/获准只读查询范围。

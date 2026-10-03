# 产品开通、权限与额度交接清单

2026-10-04（UTC+8），Refs #27。基线main `b499b338da3601de2454e128b571630c00c1a73c`，PR #37局部已审合入；PR #32已由监工关闭并说明替代，原贡献保留。本文没有新增真实请求或运行守卫实现，整项GY-I25及应用验收仍未完成。

## 已知证据与产品缺项

微信最小账号鉴权、DeepSeek只读鉴权/模型列表和腾讯STS身份查询已有[实际证据](continuation-evidence.md)。腾讯两项TTS查询返回 `AuthFailure.UnauthorizedOperation`，仅证明查询被拒绝；不证明密钥无效、不证明调用动作有权、不证明产品已开通。现有六个调用动作策略是交接声明，未逐项调用验证。

| 产品/入口 | 调用动作或认证 | 开通与调用权限 | 已有额度需核对 | 当前阻塞 |
| --- | --- | --- | --- | --- |
| [腾讯混元](https://console.cloud.tencent.com/hunyuan) | 旧ChatCompletions；新平台兼容API key另核 | 新平台视觉模型资格、端点与条款；TC3身份成功不能转移为兼容接口资格 | 精确模型支持的免费/预付token，生效与到期 | 旧API预下线；新视觉资格/模型/额度未验，识草暂不调用 |
| [OCR](https://console.cloud.tencent.com/ocr) | ocr:GeneralAccurateOCR | 服务已开通、测试子账号获准该动作 | 高精度接口专用或可抵扣资源包、剩余次数、有效期；其他OCR包不可直接代替 | 开通/调用权限/适用剩余额度均未验 |
| [ASR](https://console.cloud.tencent.com/asr) | asr:SentenceRecognition | 一句话识别已开通，16k_zh与该动作可用 | 一句话识别剩余次数与本月有效性，不拿录音文件识别小时包代替 | 同上；实际手机录音格式另待验 |
| [TTS](https://console.cloud.tencent.com/tts) | tts:TextToVoice | 通用基础语音合成已开通、获准动作及具体VoiceType | 所选音色类别可抵扣字符数与有效期；资源包不可跨音色类别默认抵扣 | 两项查询被拒绝，开通/调用/额度均不能推定 |
| [文本审核](https://console.cloud.tencent.com/tms) | tms:TextModeration | 文本服务已开通、动作获准、已有业务策略/BizType | 文本审核适用次数、有效期；普通审核与AI生成识别分开 | 服务、调用权限、策略及额度未验 |
| [图片审核](https://console.cloud.tencent.com/ims) | ims:ImageModeration | 图片服务独立已开通、动作获准、已有策略/BizType | 图片审核适用张数、有效期；不能用文本包代替 | 同上；文字成功不能计图片成功 |
| [DeepSeek](https://platform.deepseek.com) | 已有Bearer key；/chat/completions | 只读已鉴权，不证明生成/引用/留存条款 | 现有预付额度是否足够首轮，有无账户侧硬限额 | 缺获准生成额度/预算和非个人文本；不能把余额可用布尔当预算授权 |

额度证明可只提供“对应产品/接口或音色、足够本轮、未到期、核验时间、费用模式”的脱敏记录；余额、账号ID和密钥不贴聊天或Git。详细数量及证据存仓库外 `E:\GengYunPrivate`。公开免费权益描述不等于此账号当前仍有可用额度。

## 可选的精确只读权限增量

可以由账号管理员交接上述控制台证明，不改CAM。若希望自动重试仅TTS两项查询，可在[CAM](https://console.cloud.tencent.com/cam)人工校验后给测试子账号增加以下独立策略草案。本轮未创建或附加策略。

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": ["name/tts:DescribeOpenStatus", "name/tts:DescribePidOrders"],
    "resource": ["*"]
  }]
}
```

这两个动作是接口级权限，官方要求resource为 `*`；动作仍严格限于两个读取接口，不是TTS FullAccess。语法及粒度依据[授权策略语法](https://cloud.tencent.com/document/product/1073/95484)、[可授权资源类型](https://cloud.tencent.com/document/product/1073/95483)。不加入ActivateService、SetPayMode、SendFreePackage或购买/部署/策略管理动作；不使用Describe通配符。其他产品查询动作没有逐一核实请求契约，本清单不猜测接口或批量申请只读全集。

人工确认增量已生效后才可重试既有 `verify-tencent-identity.cjs --credentials <获准私密文件> --tts-quota`。查询成功仍需核对资源包适用范围、有效期和足够本轮；该脚本不会解析并宣称额度足够，也不会生成语音。

## 首轮计划与公开费用参考

这只是待授权计划，当前 `budget.liveInferenceAllowed=false`、maxVerificationCalls=0。先验证已有资源，再由用户决定范围；不自动领取、采购、开通后付费或部署。正常和受控失败均占请求上限；错误请求也可能计费，[OCR官方计费说明](https://cloud.tencent.com/document/product/866/17619)明确有部分计费错误码。不开自动重试；网络结果未知先查账与请求证据。

| 产品 | 首轮拟定上限（未执行） | 无资源包时公开标价参考与计算 |
| --- | --- | --- |
| OCR高精度 | 1张合成或获准非个人标签成功+1受控参数失败，最多2次，图片≤2MB | 低档后付费0.50元/次，保守按2次计1元；来自[OCR计费](https://cloud.tencent.com/document/product/866/17619) |
| ASR一句话 | ≤5秒获准非个人录音成功+1受控参数失败，最多2次 | 低档3.20元/千次，按2次约0.0064元；来自[ASR计费](https://cloud.tencent.com/document/product/1093/35686)。这不完成60秒或手机性能验收 |
| TTS | 一段安全合成文本成功+1受控参数失败，最多2次；每次≤100计费字符 | 以精品音色0.3元/万字符估算，200字符约0.006元；仅在已选音色确属精品时适用。其他音色重新估价，来自[TTS计费](https://cloud.tencent.com/document/product/1073/34112) |
| TMS普通文本审核 | 1成功+1受控参数失败，最多2条 | 25元/万条，按2条约0.005元；来自[文本服务说明](https://cloud.tencent.com/document/product/1124/37119) |
| IMS普通图片审核 | 1成功+1受控参数失败，最多2张 | 25元/万张，按2张约0.005元；来自[图片服务说明](https://cloud.tencent.com/document/product/1125/37109) |
| DeepSeek文本 | 最多2次，每次输入估算≤1000token、输出上限128token，显式关闭thinking；不发送媒体/历史对话 | deepseek-flash峰时缓存未命中输入$0.3/百万、输出$1.2/百万；按两次满额约$0.00091。来自[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)。输入token须核算，关闭thinking与输出限额须先核实实际接口，不保证本估算为硬账单上限 |
| 识草视觉 | 当前0；新平台资格与费用确认后才拟定最多2次 | 模型/输入图片计价未确认，暂不估价，不能用文本模型价格代替 |

上述五项腾讯产品条件成立时公开参考合计约1.0224元，另有DeepSeek美元计价，不换汇、不作为实际账单或预算批准；平台舍入/套餐/错误码/音色/已有累计阶梯均可能影响。确认已有资源足够且用户授权后，六个端点首轮最多12次；识草另加最多2次也须单独批准。完整样本评估额度见[原估算](quota-estimate.md)，不与这轮最小接入混淆。公开页面存在计费默认状态的版本/章节差异，必须以此账号实际控制台模式核查，不能从文章假定后付费关闭。

## 后续运行用途守卫设计与消费者映射

下列是与现有契约的设计对照，当前验证脚本没有实现应用服务端、数据库事务或GY-I27。账号验证不自动启用 `recipients.enabled`，配置中的false声明不能当真实守卫。

| 阶段 | 现有字段/消费者 | 必需检查与缺项处理 |
| --- | --- | --- |
| 接收方启用 | data-dictionary的recipients；getPrivacyPolicy、grantConsent | GY-I25真实能力及留存/训练/删除证明齐备，再锁定capability、config_version、policy_version；模型别名变化重新核查。缺证据保持disabled，当前不改收件方 |
| 用户同意 | consent_records、privacy_epochs；listConsents、grantConsent、withdrawConsent | 精确purpose、recipient_ids、policy_version及当前epoch；录音系统权限不代替用途同意；训练不在首版用途enum |
| 发送前 | exports、jobs、provider_invocations；模型/媒体消费者 | 核对归属、对象revision、接收方配置版本、授权epoch、deadline/lease及已有可用额度/获准请求上限；先写reserved记录。预算预留是后续内部设计，不擅自加公共API字段 |
| 返回与重试 | exports.state、provider_invocations.invocation_state、jobs.attempt | 再核对当前epoch/revision/lease；撤回/注销不回写旧结果。outcome_unknown不能自动重复计费，attempt上限仍按既有契约，不用额度足够放宽 |
| 撤回与删除 | withdrawConsent、requestAccountDeletion、third_party_deletions、deletion_handlers | 准确关联export、recipient配置及供应商删除证明；未支持/未成功不标completed。在线7日/备份30日要求不由账号鉴权证明 |

映射来源：[数据字典](../architecture/data-dictionary.md)、[现有消费者列表](../../packages/contracts/README.md)、[OpenAPI](../../packages/contracts/openapi.json)。本轮不变更这些契约、不建立新业务接口、不返回权威药剂用量。PostgreSQL17只是业务数据库候选，权威药剂来源、登记字段/版本需单独交接。

## 最小用户操作

1. 在上述产品控制台核对“已开通、对应接口/音色额度足够本轮、有效期和费用模式”；脱敏记录存E盘交接目录。TTS可选人工证明或仅两个查询动作增量，无需重复交密钥。
2. 提供已有CloudBase的envId/服务名/AppID关联与部署证明，或已有HTTPS测试地址；私有媒体HTTPS/存储与管理后台访问分别核查。没有就注明，本轮不要求购买域名或创建付费环境。
3. 交接只读PostgreSQL连接及脱敏权威来源字段、获准非个人标签/草图/录音/文本、可用Android/iOS设备；选定允许的首轮调用次数/费用上限。费用方案与真实输出待授权后执行，当前推理仍0。

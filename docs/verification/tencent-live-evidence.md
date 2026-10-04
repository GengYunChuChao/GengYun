# 腾讯云2元授权下的最小真实调用证据

2026-10-04（UTC+8），Refs #27。基线已审main `95b14d3783ffeda0627ecbdaca2b77606a5f884c`。用户新增授权腾讯云本轮最多2元的最小真实调用，优先五项TC3接口，每项正常与受控失败各最多1次、总计最多10次、自动重试0。DeepSeek美元账户不在授权范围，本轮不调用。公开模板和应用配置budgetfalse/0保持原样；独立人工验证CLI只认本次显式授权标识，不启用应用流。

## 实际结果

所有以下请求HTTP200；先检查Response.Error，业务错误不计成功。

| 端点 / 样例 | 业务结果 | RequestId | 本次耗时ms | 保守预留CNY |
| --- | --- | --- | --- | --- |
| tts / 正常合成输入 | UnsupportedOperation.PkgExhausted | 362b4c67-c68b-46ca-a5e7-1757c5a10321 | 304 | 0.0030 |
| ocr / 正常合成输入 | FailedOperation.UnOpenError | 34e0ce78-f148-44f0-abe8-e9e472724110 | 188 | 0.5000 |
| moderationText / 正常合成输入 | Pass | 23185f4d-2a1b-49b2-9911-183bd4a25e54 | 247 | 0.0025 |
| moderationImage / 正常合成输入 | Pass | c73724fd-8b29-4294-a755-bccc5b577ca6 | 386 | 0.0025 |
| moderationText / 受控参数失败 | InvalidParameterValue.ErrTextContentLen | ecf78456-97d3-45aa-bd6a-f2f69544adce | 108 | 0.0025 |
| moderationImage / 受控参数失败 | InvalidParameter.InvalidImageContent | 29011d80-16bd-4856-9cbc-24f854f011b5 | 185 | 0.0025 |
| asr / 正常合成输入 | FailedOperation.UserNotRegistered | 912f46cf-9c43-4c5e-b8bf-86d82a364a72 | 302 | 0.0032 |
| tts / 用户新状态人工复核 | BUSINESS_RESPONSE | e785dca0-cb9a-49c9-8b11-2292343ff967 | 494 | 0.0030 |
| ocr / 用户新状态人工复核 | ResourceUnavailable.ResourcePackageRunOut | 18ef350c-f16a-4a88-99f1-819c254e8ad3 | 204 | 0.5000 |
| asr / 用户新状态人工复核 | BUSINESS_RESPONSE | 07c761d9-8ad4-4a43-ad91-ca3263ee6e74 | 383 | 0.0032 |
| weedRecognition / 正常合成输入 | BUSINESS_RESPONSE | 未保存上游ID | 7080 | 0.2000 |
| ocr / 新后付费状态唯一追加授权 | BUSINESS_RESPONSE；2条文字且已知合成文字匹配 | d2119b64-7ecb-47bb-b82d-b1d6a4db0b1b | 290 | 0.5000 |

文本和图片审核各有正常Pass及受控参数失败证据；正常响应确认Suggestion/Label/RequestId字段。本轮证明两个传入BizType的请求被接受，未独立检查控制台策略启用/规则与实际期望是否完全一致，不等于安全召回率或完整社区验收。OCR/TTS/ASR第一阶段各一次真实业务失败。用户后续补充资源状态后，各获准一次人工复核，全部计入原账本；不是自动重试。TTS、ASR复核成功，OCR第二次返回ResourcePackageRunOut后停止；随后用户单独明确“已开启，允许再测一次”，仅新增第三次OCR正常请求成功，仍保留全部旧请求及费用，不追加负例。

ASR输入为本地Microsoft Huihui离线合成“你好，这是语音测试。”，非个人、单声道16kHz PCM16 WAV、3.06秒，已核非空与格式。本地引擎首次在受限注册表访问下失败；取得系统只读访问后成功，不安装或修改语音引擎、不云合成。ASR首次返回UserNotRegistered；用户交接专用SecretId/Key后第二次实际转写“你好，这是语音测试。”，标点规范化后与已知短句匹配。最初TTS失败未生成音频，用户新状态后的第二次TTS成功8784字节；本地soundfile0.13.1完整解码为35136帧、16kHz单声道、2.196秒非零PCM，另存PCM16 WAV。没有手机或人工听感证据，humanPlaybackVerified=false。未复用TTS音频再次调用ASR，以免超过已用2次上限。OCR/IMS输入为Pillow绘制480×240白底PNG，含“合成测试 你好 / 编号 12345”；没有用户原媒体、EXIF、身份或云下载URL。TMS/TTS仅发送上述安全合成短句。原始媒体与manifest仅放忽略缓存。

## 计费核查、已用次数与未知账单

请求前已按官方国内最高公开低档单价保守核算，资源包/免费额度不假定存在。OCR高精度0.50元/次：[OCR计费](https://cloud.tencent.cn/document/product/866/17619)；ASR一句话3.20元/千次：[ASR计费](https://cloud.tencent.cn/document/product/1093/35686)；TTS精品音色0.3元/万字符、每次按100字符预留0.003元：[TTS计费](https://cloud.tencent.com.cn/document/product/1073/34112)。TMS普通文本25元/万条：[文本说明](https://cloud.tencent.com/document/product/1124/37119)；IMS普通图片25元/万张：[当前图片价格](https://cloud.tencent.com/document/product/1124/134729)。Shanghai国内区域，不使用国际站价格或假定套餐折扣。错误/超时也按正常最高价预留；阶梯累计、舍入、计费错误码和既有套餐以实际账单为准。

五项TC3完整10次保守预留1.0224元；单次视觉另预留0.2元，原完整计划1.2224元。原11次为正常首次5次、受控参数失败2次、新状态人工复核3次、视觉1次；后续用户新增唯一OCR复测1次。本轮累计12次（TC3 11次+视觉1次），保守预留1.7224元，小于2元授权。旧11次与1.2224元没有清零或覆盖。已观察费用金额：未取得；全部actualChargeCny=null，不能把预留当实扣或声称免费。没有结果未知的网络请求，本轮仍保留unknown占次数和费用的机制。没有购买、充值、自动重试、后付费开关修改、开户/条款接受、CAM扩权、部署或外发用户媒体。

TokenHub初期因账户和单图计价边界未确认保持0次。随后用户直接确认所有状态已完成（含同一充值账号），并按官方[模型价格](https://cloud.tencent.com/document/product/1823/130055)、[模型列表](https://cloud.tencent.com/document/product/1823/130051)核hy-vision-2.0-instruct最大输入24k；保守按24576输入token、128输出token计算0.18656元，向上预留0.2元。这不是用文字字符估算图片token。单次同一合成图实际HTTP200、非空choices.message.content提及合成文字，usage输入302/输出128；按公开单价折算0.004505元，但不是实际账单。输出128token可能截断，没有草图或真实草种、Top3或准确率证据，grassRecognitionVerified=false。没有保存该次完整响应或上游ID，不补造请求编号。

## 具体资源错误与用户操作

- OCR FailedOperation.UnOpenError：官方[GeneralAccurateOCR错误码](https://cloud.tencent.com/document/product/866/34937)对应服务未开通，第二次为ResourceUnavailable.ResourcePackageRunOut（资源包耗尽）；用户到 https://console.cloud.tencent.com/ocr 核对通用文字识别（高精度版）的适用资源包有效期/余量和后付费设置。工具不替用户接受服务条款或开启计费；用户后续明确已自行开启并授权一次，第三次成功TextDetections两条，归一化为“合成测试你好编号12345”。
- ASR FailedOperation.UserNotRegistered：官方[SentenceRecognition错误码](https://cloud.tencent.com/document/product/1093/35646)对应服务未开通；用户到 https://console.cloud.tencent.com/asr 核对一句话识别服务是否开通。该首次错误不归因于音频为空或凭据无效；用户后续新专用凭据复核已成功。
- TTS UnsupportedOperation.PkgExhausted：官方[TextToVoice错误码](https://cloud.tencent.com/document/api/1073/37995)为资源包余量已用尽。用户到 https://console.cloud.tencent.com/tts 的“语音合成资源包”查看精品音色对应未到期资源包及后付费开关；[资源包管理流程](https://cloud.tencent.com/document/product/1073/56352)和计费文档说明后付费默认关闭，充值不自动开启。首次错误本身不能独立证明开关状态；用户最新声明有效资源包或后付费已启用，第二次同音色短句已成功，无需再次索取现有字段。

## 验证工具边界与回归

`tools/verify-tencent-live.mjs`是人工一次性合成接入工具，默认不执行，须显式manual-authorization、固定端点key、精确私密JSON。五端点严格沿用已审prepareOfflineRequest，固定本地合成manifest/hash，TC3签名绑定实际body；TokenHub仅一个单次视觉分支、使用独立Bearer；不含DeepSeek执行分支。固定文本非个人；样本用途声明是本次人工确认，不是应用用户同意系统。

进程互斥锁排除并发；忽略ledger在发送前预留，每种正常/受控失败只允许一次；OCR/ASR/TTS仅在用户新增状态交接后接受独立显式manual资源复核标识一次，各端点仍最多2次，视觉最多1次，原总TC3最多10次、总请求最多11次；用户追加唯一OCR后付费状态复测以独立标识最多1次，累积TC3最多11次、总12次且OCR仅此例最多3次；失败、未知及程序崩溃均不自动重发。持久保留本次已用次数/预留；账本异常/重复/超过2元、对应原TC3 10次/总11次或唯一OCR追加后的TC3 11次/总12次拒绝，受控失败必须已有正常业务响应。崩溃留锁须人工核对结果后处理，不能直接清空账本重跑。此本机账本不是供应商硬账单封顶，不能抵御人为篡改或替代服务端事务、授权epoch、注销删除与供应商留存控制。

GY-I27运行用途/预算/删除守卫仍未实现；准备库原executionAllowed=false不改，人工CLI只在这次授权下独立发合成请求，不成为生产消费者。未接管其他任务或变更公共API。新增5组人工CLI离线测试，加1组ASR专用凭据路由测试；全套27组通过，覆盖授权/账本限额及未知不重发、body签名、HTTP200业务错误与空ASR拒绝、结果脱敏/合成转写核对；CI只跑离线测试，不用实际凭据或发收费请求。

## ASR专用凭据交接与消费者兼容

用户在原授权腾讯云.txt追加明确标注的SecretId/SecretKey。格式核验后单独保存tencentAsrSecretId/tencentAsrSecretKey，映射TENCENTCLOUD_ASR_SECRET_ID/KEY；与原共享TC3配对不同，不覆盖OCR/TTS/审核或TokenHub。仅本机忽略配置的ASR选择专用变量；公共模板保留共享配对可选，严格核查只允许ASR使用完整专用配对，缺项不静默回退。原文件和其他凭据保持。没有输出值/身份或额外STS查询，账号归属不由SDK字段存在推断。

最新OCR资源事实：用户在指挥聊天明确交接“后付费尚未开启”；这是用户声明，工具未读取或修改开关。结合第二次ResourcePackageRunOut，当前没有适用可用资源包且后付费未开。本轮请求上限已用尽，待用户明确改变资源状态并授权新的限次复测后才另拟计划；不会第三次OCR或自行开通付费。收尾正常合并已审治理main `9743a122edb7ac1c55a68cbdceb77a64928029d9`，保留GY-I26原协作者和GY-I27待领取事实；实际调用批次执行基线仍为95b14d3，不重写历史。

## 唯一OCR后付费状态追加授权

此前用户声明后付费未开，原11次停止后，用户直接明确“已开启，允许再测一次”。精确独立授权标识gy25-20261004-cny2-ocr-postpaid-confirmed-once，只接受OCR正常请求和此前ResourcePackageRunOut账本证据，固定同一合成图片；在原账本中预留0.5元再发送，累计12次/1.7224元。返回HTTP200、无Response.Error、TextDetections长度2且归一化匹配已知合成字句。这个追加不重新授权其他端点、不自动重试、不改变实际账单未知状态；完成后全部停止。5组人工工具回归覆盖新标识必需/一次限额/旧账本保留。

## PR #42独立审查后的离线整改

[独立审查](https://github.com/Sek1ro-oka/GengYun/pull/42#pullrequestreview-5405331825)针对旧HEAD `79013bb91dc1e49499071c0423bc3e517aee0939`发现两项工具缺陷。本次只修改凭据选择、响应证据校验和离线回归；未读取真实密钥、未调用供应商、未改写历史账本，12次调用及1.7224元保守预留保持。实际费用仍未知，任务整体未完成。

TC3凭据按完整来源选择SecretId/SecretKey/SessionToken三元组。共享配对仅读取共享token；ASR专用配对仅读取专用token，长期专用密钥没有token时明确为空，不继承共享token。专用配对缺任一字段立即拒绝，不逐字段混配或回退。可选私密字段tencentAsrSessionToken映射TENCENTCLOUD_ASR_SESSION_TOKEN，仅支持同源专用临时凭据；公共端点配置、应用执行与预算开关保持原契约。

五项TC3正常业务成功必须先有非空字符串RequestId；工具沿用原有16至64位十六进制/连字符安全输出格式。这是本工具的保守输出限制，不声称官方要求UUID。缺失、类型错误或格式超出限制返回RESPONSE_EVIDENCE_INCOMPLETE，不列为已验证RequestId，不补造编号。TTS另按[TextToVoice接口](https://cloud.tencent.com/document/api/1073/37995)及已安装SDK的“SessionId原样返回”说明，核对非空字符串与请求值完全一致；单有非空Audio不足以成功。responseFields只列实际通过校验的字段，SessionId异常不保存音频。供应商Response.Error仍优先分类SERVICE_ERROR，不改写为成功或丢失原错误分类。

历史TTS音频字节、完整本地解码及已保存RequestId保持原证据；旧工具曾无条件声明SessionId字段，未核验其原样回传且未保存完整原响应，因此历史SessionId回传一致性未验证，不能用本次离线修复追认。保留历史业务状态是记录当时工具输出，不代表旧响应已通过新门槛。不追加真实请求来补该证据。

新增4组离线回归，使用虚构凭据与注入响应，并封锁fetch/http/https真实网络入口检查实际签名头。覆盖共享临时token与专用长期密钥隔离、专用临时token、缺半对拒绝；五端点RequestId缺失/空值/类型/格式异常；TTS SessionId缺失/类型/不一致与Audio校验；SERVICE_ERROR分类及证据字段。证据不完整仍保留次数、费用预留和actualChargeCny=null，阻止自动重发与受控负例。全套31组离线测试用于整改验证，CI不接触私密文件或收费端点。

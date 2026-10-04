# GY-I25 接续、验证证据与资源缺项

2026-10-04（UTC+8）。按用户“写手有空先把GY-I25完成”授权接续，Refs #27；整项需要真实验收，当前仍未齐。F01/F12/F13/F15/F16/F20/F08及AC07/09/11/12/19/21/28/29是对应需求边界，不把本文件/离线测试标为应用AC通过。初期无自有域名不要求先购买，但不取消正常体验/比赛HTTPS、私有媒体或供应商门槛。

## 原贡献与本轮范围

刚核查[PR #32](https://github.com/Sek1ro-oka/GengYun/pull/32)仍open，原分支feature/verify-platform-services HEAD `3513c104ef48101896c561913e26d6b4b04ba33a`，没有新修订；原协作者领取记录保留。写手从main `f40f09167869f2a2d8aa563f8c8ffdf44ccf244f`建立codex/gy-i25-access-verification，正常cherry-pick原作者唯一6文件提交，保留作者和台账结构，不推其分支、不删除其PR。本轮接续修复/更新作为单独PR，与PR #32内容重叠，合并任一前需监工判断处置，不能双份盲目合入。公开[接续记录](https://github.com/Sek1ro-oka/GengYun/issues/27#issuecomment-5971677530)有范围协调入口。

GY-I02局部[PR #36](https://github.com/Sek1ro-oka/GengYun/pull/36)已由监工合入main e3c709e82674eb351f337c7b769da89dfd0b1e79；本分支正常合并该main，其贡献保持独立，HEAD `6d0dc956a2d9c3aec63bde4c6c94c0832cf988dd`，无额外复制其源码；可复用已有工具证据，截图/SDK仍在忽略缓存。GY-I01组件合入不等于整项/运行版本冻结。

## 两条已审缺陷修复

1. 精确忽略 `/docs/verification/config.local.json`；安全example仍可提交。实际执行check-ignore，不只写注释；暂存文件核查确认无真实配置。AppID公开；AppSecret/供应商secret/数据库连接只读服务端变量或用户获准精确私密文件。原JSON database.url弃用，改urlEnv变量名。
2. 无效/非HTTPS配置不请求：网络入口再次校验URL/HTTPS，配置循环只允许校验过的端点。默认不联网；显式--probe对origin做HEAD，不发送鉴权、不跟随重定向，8秒后结束。拒绝URL凭据/query/fragment，隐藏异常原文、解析片段和任意配置原文。合成六个http://vendor.invalid/not-an-api，即使probe=true也有6个配置FAIL且fetch调用计数0；非法URL、凭据、query、fragment同样0。

报告分层为configurationComplete、reachability与capabilityVerified；HOST_RESPONDED可含401/403/200但始终capabilityVerified=false/taskVerified=false，不是真实服务成功。环境变量存在不证明凭据有效，HTTPS格式不证明域名登记/证书/真机，隐私false只是声明不证明运行守卫/条款。`--probe`不执行模型/资料/数据库验证，也不承诺任何探测一定免费。

## 实际微信账号验证

用户正式AppID `wx4407a4b908a69a54`、真实目录 `E:\WeChatProjects\GengYun` 已确认并只读核对，原模板保留不回写、不执行uploadCloudFunction.sh。用户随后获准交接AppSecret于指挥worktree精确忽略文件；写手实际git check-ignore确认，读取仅入进程内存，不复制到客户端、配置样例、Git或快照。没有扫描其他个人目录、输出密钥或URL凭据。

命令为 `node tools/verify-wechat-account.cjs --credentials <已获准忽略文件> --sdk <本机官方SDK模块目录>`。此前工具2.02.2608080在用户开启62154后islogin=true、该AppID项目auto加载成功；模拟器SDKVersion3.17.3、五Tab及local成功/失败证据属于PR #36，非真机。官方miniprogram-automator0.12.1仅隔离缓存，未新增本轮运行依赖。脚本先核对工具getAccountInfoSync的appId匹配，调用实际wx.login，不mock它。

| 实验 | 真实请求/脱敏schema | 实际结果 | 范围 |
| --- | --- | --- | --- |
| 服务端凭据 | POST https://api.weixin.qq.com/cgi-bin/stable_token；grant_type/appid/secret/force_refresh=false；返回access_token:string、expires_in:number | HTTP200，AUTHENTICATED，expires_in=7200 | token只在内存，未输出/保存；不强制刷新旧token |
| 一次受控失败 | 相同API，仅把secret替换为合成无效值 | HTTP200业务errcode=40125，REJECTED | 不是六类供应商失败测试，不提交真实坏secret |
| code交换 | 工具实际wx.login取得code；GET https://api.weixin.qq.com/sns/jscode2session，仅内存组装appid/secret/js_code/grant_type；返回openid:string、session_key:string | HTTP200，EXCHANGED，unionid未返回 | 不记录code/OpenID/session_key/完整URL；不是GY-I04会话权限/账号注销已实现 |

本地实验记录编号WX-20261004-01为本台账批次号，**不是微信服务端request_id**；本次未采集上游请求编号，未计性能/p95，不能捏造耗时、成员名册或Android/iOS结果。仅3次最小服务端请求，未用token调用AI/云部署/媒体；授权用途为当前账号接入验证。实际HTTP结果支持该账号最小鉴权成功，不支持全部账号权限/隐私声明已验。

官方参考：[稳定token](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-access-token/getStableAccessToken.html)、[code交换](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)。本次官方页读取失败，接口结果是实际证据，不把文档阅读标通过；完整条款/权限/SDK与供应商留存仍须核查。

## 可复现离线检查与缺项

```powershell
node --check tools/verify-env.mjs
node --check tools/verify-wechat-account.cjs
node --test tests/verify-env.test.mjs tests/wechat-account.test.cjs tests/deepseek-account.test.cjs tests/tencent-identity.test.cjs
git check-ignore -v docs/verification/config.local.json
git check-ignore docs/verification/config.example.json
node tools/verify-env.mjs --json
python tools/validate_development_docs.py
python tools/validate_contracts.py
python tools/test_contracts.py
```

本轮13组Node测试：5组验证器守卫/状态测试、3组微信账号、2组DeepSeek及3组腾讯身份/额度查询守卫测试；全部合成、无外网。示例已填候选供应商端点，但尚缺API正式地址/数据库；腾讯凭据存在不证明服务权限或额度，所以复制后配置检查预期exit1；不存在时也exit1，不能因为AppID和AppSecret可用标整个环境PASS。真实密钥文件仅明确带授权参数的检查命令在进程内读取，CI不读取凭据/SDK或执行真实接口。正式HTTPS不允许local HTTP；后续存在已关联、已部署云环境才评估callContainer，不擅自付费或改架构。

尚未获得以下获准资源，已在本写手聊天集中询问；可并行交接，不用重复AppID/AppSecret：六类供应商/版本/安全服务端配置及获准非个人样本；已有可验证HTTPS测试地址或已部署关联云环境；只读测试数据库及登记号/成分含量剂型/来源版本的脱敏字段；Android/iOS设备与体验成员。六类能力推理调用0（DeepSeek另有3次只读GET），数据库连接0，域名/私有桶/留存删除/用户外发守卫/真实手机请求上传录音未验。收到前仅提交修复和真实账号局部证据，保持issue #27开放；完整验收不能用Closes或标GY-I25完成。

已有架构data-dictionary可设计登记/制剂/来源字段映射，本轮不造数据库样例冒充权威来源、不返回用量、不启用训练或真实个人媒体外发。六类能力仍各需真实成功+受控失败、模型/SDK版本、请求字段/响应schema、编码大小/超时/额度与留存删除条款证据；调用预算见[估算](quota-estimate.md)，候选已列出但额度与价格尚未核准，未编造花费。所有未验项按平台/供应商矩阵持续保留。


## 实际DeepSeek只读验证及私密交接

用户明确指定桌面精确文件后，读取其中唯一格式合法的API key，不扫描其他文件、不输出原文。用户另授权选择E盘交接位置；已创建仓库外 `E:\GengYunPrivate`，限制ACL为当前用户和SYSTEM。原凭据源均保留；私密JSON不进入Git/CI/客户端。当前保存微信账号、DeepSeek及获准腾讯云凭据。

批次DS-20261004-01（本地批次号，不是上游请求号）实际执行三次GET：`/user/balance` HTTP200、AUTHENTICATED、is_available=true，仅记录schema，不记录金额；`/models` HTTP200、LISTED，模型ID deepseek-flash和deepseek-v4-pro；一次合成无效key访问`/models` HTTP401、REJECTED。未发送生成请求；inferenceRequests=0、capabilityVerified=false。没有上游request ID/性能/真实业务输出证据。

官方依据：[余额接口](https://api-docs.deepseek.com/api/get-user-balance/)、[模型列表](https://api-docs.deepseek.com/api/list-models/)。模型ID是观察值，不能当作不可变权重版本；[官方别名升级公告](https://api-docs.deepseek.com/news/news260910/)表明别名可能变更。候选Tencent API/SDK与资源阻塞见[资源交接](resource-handoff.md)。


## 腾讯云身份与查询权限实际结果

用户经指挥授权读取精确忽略的腾讯测试凭据文件；字段已有效填写，region=ap-shanghai。复制到上述受限私密文件且不覆盖不同已有值；原文件保留。TC3手动签名仅用于固定只读查询，依据[官方Node签名说明](https://intl.cloud.tencent.com/zh/document/product/1080/38767)，不代替正式业务SDK兼容核验。

实际 `sts:GetCallerIdentity` API2018-08-13两次HTTP200、AUTHENTICATED，响应身份值不记录，仅schema。第二次携带显式--tts-quota，分别尝试 `tts:DescribeOpenStatus` 与 `tts:DescribePidOrders`：均HTTP200、业务错误AuthFailure.UnauthorizedOperation，归类QUERY_FORBIDDEN，不能当凭据无效。查询动作依据[官方TTS授权资源表](https://cloud.tencent.com/document/product/1073/95483)。未自动扩权、未调用TextToVoice、未领取免费包、未设置后付费。

本轮腾讯只读请求合计4次，AI能力调用0。腾讯身份已验；六个调用动作的实际权限、产品开通、免费/预付额度及模型均未验。用户可在控制台交接已有服务及剩余额度的脱敏证明，或限定授权只读查询动作；不能仅凭身份成功启动计费推理。数据库与云部署/真机仍无实测。issue #27保持开放。

实际本机默认零网络检查（带获准私密文件）为24 PASS、2 FAIL、6 INFO；两项FAIL是正式API HTTPS地址与数据库连接变量未设置。候选配置存在与能力验证分层仍保持taskVerified=false/capabilityVerified=false。本机config.local.json已精确忽略，未提交。


## 更正与后续（2026-10-04，GY-I26 走查期间）

以下为**追加更正**，不改写上方原始记录，以便保留审计痕迹。

### 1 工程目录更正

上文「实际微信账号验证」记录的工程目录为 `E:\WeChatProjects\GengYun`。2026-10-04 实测该目录**不存在**（`Test-Path` 为 False）。

实际承载本仓库代码、并在开发者工具中打开编译的目录是 **`D:\challenge_cup`**，与 `project.config.json` 的 `miniprogramRoot` 及工具「详情 → 基本信息 → 本地目录」一致。

后续任何核查、取证与工具操作均以 `D:\challenge_cup` 为准；按 `E:\WeChatProjects\GengYun` 查找会扑空。

### 2 开发者工具版本已变更

上文记录的 `2.02.2608080` 为当时版本。2026-10-04 实测当前为 **`2.02.2609231 RC win32-x64`**，调试基础库 `3.17.3`（灰度中）。原始版本号保留，不代表当前环境。

### 3 本地配置漂移与工具改写（已修，含一次误判更正）

事实需分清两层，以下为 2026-10-04 实测结论：

**仓库侧从未出错。** `main:project.config.json` 一直为正式 AppID `wx4407a4b908a69a54` 与 `libVersion: 3.5.5`，并被 `tools/check-wechat-project.mjs` 冻结断言。远端配置与冻结契约一致。

**漂移发生在本地工作区且未提交。** 本地 `project.config.json` 的 `appid` 被写为测试号 `wx004043e9a9d2feab`（项目已开发阶段 2026-10-04 上午实测），该改动始终未进入任何提交，因此 `tools/check-wechat-project.mjs` 在 `main` 上是 PASS 的。

**开发过程中的一次误判（记录以备复查）。** 我最初把本地这个未提交状态读作「仓库配置指向测试号」并提交，同时误将 `libVersion` 改为开发者工具本地显示的 `3.17.3`（灰度中）、把中文 `description` 改为英文。这直接导致 PR #39 的 CI 在 `assert.equal(project.libVersion, '3.5.5')` 处失败（报错 `'3.17.3' !== '3.5.5'`）。已全部回退：`project.config.json` 恢复为与 `main` 逐字一致，CI 复跑 PASS。

**结论与规范。** `libVersion: 3.5.5` 是冻结契约的一部分，不得依据本地工具显示值（含灰度版本）改动；工具「调试基础库」下拉是本机调试选择，与仓库锁定值是两层概念，走查证据须分别记录。

**工具自动改写 `project.config.json`。** 微信开发者工具打开项目后会把 `setting` 从紧凑单行展开并追加 `postcss`、`compileWorklet`、`uploadWithSourceMap`、`simulatorPluginLibVersion`、`editorSetting` 等约 20 个字段，且写入后无行尾换行。该改写每次打开项目都会产生，属本地工具痕迹，**不得提交**，否则与队友产生无关冲突。

**未入库的私有配置。** `project.private.config.json` 已被精确忽略，本次仅将 `appid` 补为正式号、`projectname` 由 `challenge_cup` 改为 `GengYun`、`libVersion` 设为 `3.5.5`；本地登录信息与工具偏好留在该文件，不进 Git。

### 4 本节新增的实测范围

| 项 | 状态 |
| --- | --- |
| 工具 islogin 与正式号项目加载、编译 | 已实测（iOS 模拟器） |
| 五 Tab 路由与游客态界面走查 | 已实测，见 [GY-I26 走查证据](gui-adaptive-evidence.md) |
| 真机预览（Android／iOS） | **仍未执行**；工具「上次预览」显示为「无」 |
| 体验版上传 | **仍未执行**；工具「上次上传」显示为「无」，正式号至今无任何上传记录 |
| 主体类型、服务类目、体验成员、隐私保护指引 | 仍未核查，见 [平台核查清单](platform-checklist.md) |

真机与上传两项属 GY-I25 验收范围，赛期前必须各走通一次，本节不作完成声明。

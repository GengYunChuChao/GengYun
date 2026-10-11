# PR #69：当前登录与原生 UI 整合（2026-10-11）

Refs #28，承接 #65/#39。正常合并 main `427ddb448b7e315719de8e03ba6ca048fa2e8246`，
随后正常合并最新 main `13badea4361f4777850a85464d5edf1e5737fd51`（已合 PR72，仅问答离线判定／工作流／文档，无小程序变化），复用未变的当前 UI 证据。
保留原作者和 PR69 历史提交。已合 PR68 的三项故障不重做服务端；把其实际生命周期实现保留在本次运行树。
对应[PR69 批复](https://github.com/GengYunChuChao/GengYun/pull/69#pullrequestreview-5479016910)，
PR68 的[通过批复](https://github.com/GengYunChuChao/GengYun/pull/68#pullrequestreview-5480203275)仍绑定原已验 SHA。

## 运行树整合

| 冲突范围 | 处理与实际回归 |
| --- | --- |
| home.js / login.js | 保留核实状态、意图世代、一次性返回、旧回调失效、取消后 busy 复位；叠加 guest/entries/font。首页入口不凭缓存放行 |
| 四资料页 JS | 保留 page-gate、详情 ID、共享在途加载回调、离页清空及重返核实；补字体刷新 |
| page-gate 回归 | 同时加载真正 font-scale 与 page-gate，保留实际四页并发／重返／换账号断言 |
| prepare-wechat | 合并 navigation/page-gate 与 font/system-font/state-view 依赖；增加原生 custom-tab-bar 四文件，local/release 实际加载 |
| development-progress | 采用最新精简版，不把历史完整验收 0 项改写成完成 |

正式运行树已整合，旧[兼容补丁](pr65-pr68-compatibility.patch)与 31 项结果仅为旧 SHA 的离线历史。
本次不复制旧补丁覆盖已合修复。按 demo.html 的底部顺序改为首页、社区、居中突出的识别、消息、我的；
仍是原生 Component／WXML／WXSS，Tab 点击不能授予身份。页面预留 88px 加安全区。
四个受保护 Tab 同样使用生命周期门禁，离页后旧核实不能复活登录区。

App 返回前台及页面显示时读取官方接口。实测还修复两处样式问题：
原生按钮默认 184px 覆盖普通宽度类，首页用页面内选择器明确全宽；
字体变量定义在根 view，父级 page 的字号不能反向继承它，故根 view 自身计算普通正文。

## 固定源码与真实模拟器

应用源码 `22622f3168c5e1d66f96af363b34bcdc741eba05`。
最终后续证据提交没有再改变 miniprogram；[LF 归一化源码哈希](assets/pr69-integrated-22622f3-320/sources.json)
核对 Git 源码与真正导入的独立工程（仅本地 runtime 单列例外）。
[原始观测](assets/pr69-integrated-22622f3-320/observations.json)由官方 SDK 0.12.1 读取，基础库 3.17.3。

- 实际 `getWindowInfo`、`getSystemInfoSync` 和页面根节点宽度均 320px，窗口高 504px；不是改返回值或缩放图片。
- 用户切换机型后第一次运行实例仍是 390px；重开本项目后才读到 320px。中途打断的 390px 批次无效，不入当前证据。
- 不替换 auth.requireLogin、不注入 App/page fontScale：游客社区→真实登录页→工具内 wx.login→本地合成身份服务→原社区返回，五 Tab 经实际 HTTP 核实可见。
- 两个实际资料详情 gatePassed/found 成功。服务器身份仍 synthetic，复用既有 loopback3100；不声称真实 jscode2session 或重新完成原生 PostgreSQL 验收。
- 实际基础信息：fontSizeSetting=16、fontSizeScaleFactor=1.11；getFontSizeManager 不可用。App→页面→Tab 均 1.11，根正文及按钮计算字号 19.98px。此前 390px 读数为 0.89 并按下限归 1，属于不同模拟器环境，不推定 Android 用户字体设置已改变。
- 首页按钮实测宽 298px；标准界面观测的按钮均高于 44px。社区／消息的按钮在状态组件内，页面级查询为空不代表没有按钮；以原始截图为准。

| 页面 | 主要内容 | 末屏／底部导航 |
| --- | --- | --- |
| 首页 | [顶部](assets/pr69-integrated-22622f3-320/home-top.png) | [末屏](assets/pr69-integrated-22622f3-320/home-bottom.png) |
| 社区 | [顶部](assets/pr69-integrated-22622f3-320/community-top.png) | [末屏](assets/pr69-integrated-22622f3-320/community-bottom.png) |
| 识别 | [顶部](assets/pr69-integrated-22622f3-320/identify-top.png) | [末屏](assets/pr69-integrated-22622f3-320/identify-bottom.png) |
| 消息 | [顶部](assets/pr69-integrated-22622f3-320/messages-top.png) | [末屏](assets/pr69-integrated-22622f3-320/messages-bottom.png) |
| 我的 | [顶部](assets/pr69-integrated-22622f3-320/profile-top.png) | [末屏](assets/pr69-integrated-22622f3-320/profile-bottom.png) |

另有同目录 guest-home、guest-login、两个详情及 identify-button-1..5。
原始画面逐项核对：主要按钮文字留在按钮内，五页末屏文字与卡片未被 Tab 覆盖。
上半屏未拍出的按钮不能仅凭顶部图称通过，以补充定位图核对。

## 受控字号回归单列

[受控观测](assets/pr69-integrated-22622f3-320/controlled-font.json)临时替换 wx.getAppBaseInfo 返回的
26px／1.625，由未改 App/页面算出 1.3，正文／按钮计算为 23.4px；不直接注入 fontScale，且不覆盖鉴权。
[顶部](assets/pr69-integrated-22622f3-320/controlled-font-home-top.png)与
[末屏](assets/pr69-integrated-22622f3-320/controlled-font-home-bottom.png)检查本次根正文和首页按钮改动。
结束后原函数恢复，实际值再次为 1.11。SDK mockWxMethod 对该同步接口的尝试失败，未作为通过证据；
后续仅在独立模拟器内临时替换函数，并由 finally 恢复。
此组是合成接口回归，不是 Android 微信最大字号设置实测，也不把旧 390px 五页大字图绑定成当前源码。

```powershell
node tests/integration/local-dev-ui.cjs "<official SDK directory>" ".local/ui-current" 320 9422
node tests/integration/local-dev-ui-controls.cjs "<official SDK directory>" ".local/ui-current" 9422
```

前提为工具导入本分支的独立本地工程、automation9422、已有本地合成服务3100。
共享 runtime disabled、urlCheck=true 保留；域名例外仅在忽略的本地项目。
命令不获取生产凭据，不调用识别／语音／问答服务，服务器部署继续暂缓。

## 适用检查与剩余验收

整合后安全／资料／单元 573/573，契约6/6、UI24/24、小程序4/4、lint/build/docs 通过，实际 loopback HTTP 11 组通过。
最后根节点样式修订新增 UI 1 项，受影响 UI／实际页面／标准包 47/47（UI25、页面18、打包4），未把旧补丁31项作为新运行树证据。
最新 main 合入后，UI／实际页面／登录返回／游客门禁／资料生命周期／标准包 102/102 再次通过，微信项目静态检查通过；只合入已验且不影响 UI 的 PR72，不重复调用供应商。
源码语法及文档链接／表格／27项映射复核；完整 diff --check 仍有旧兼容补丁第8/51行的必要空白上下文告警，
补丁可解析，排除该历史嵌套补丁后其余 diff 检查通过，不冒称原始命令零告警。CI 以新 HEAD 为准，作者不批准 Fork workflows。

Android 真机／真实微信服务器身份、正式网络以及真实最大字体设置仍待整项验收，#28/#23 不关闭；iOS按用户最新要求暂缓，不作为本阶段组件阻塞。
最小 Android 协作：在获准设备上打开本版本→微信字体标准／最大各一次→返回小程序读取实际字段与 App/page 倍率，
保存五 Tab 主要按钮和末屏（含底部安全区）的截图，并走游客→登录→资料→退出；只交接脱敏结果，不提供密钥或个人媒体。
本 PR 交付整合的原生 UI 组件，不代表识别、ASR、TTS、社区业务或整项软件完成。请监工固定新 HEAD 独立复核当前320px证据与合并安全范围。

# PR #90：CI 与原生解析修订复核

2026-10-12；Refs #8。返修基线 `0da3be9a325d9bb512087a501d591fd33ded6834`，实际实现由 DSH 完成，cxhhandsome 在独立 checkout 自查。新 HEAD 见 PR；同账号自查不作为 APPROVED。

## 修订与负控制

- 原 CI unit-tests 的4个失败均为详情页新增 profile-api 后，旧生命周期夹具缺 binding/current/read。夹具现使用真实 auth 与 profile-api 的身份绑定，以及合成空档案 Promise；受影响用例等待异步装载，保留认证、旧回调、单 loader 与真实资料实体断言。新增档案断言只作用于 referencedetail，不给种子详情页强加该依赖。
- 微信模拟器中原详情页空白，运行时报告 `module 'utils/reference.js' is not defined`。该模块有两份完全相同的 isSimulatedSource 声明，严格模块解析独立检出重名错误；现在只保留一份，所有调用及模拟来源拒绝语义不变。
- 新增解析测试用 Node 的严格模块语法检查读取实际参考模块，只解析、不执行。相同测试放入基线 checkout 时失败，放入修订 checkout 时通过；避免仅用 CommonJS 测试漏检重复声明。

## 本机检查

| 检查 | 实际结果 |
| --- | --- |
| 受影响登录/返回/门禁用例 | 41通过，0失败 |
| 解析回归负控制 / 正控制 | 基线失败；修订通过 |
| 完整 test:unit 文件集，正常进程隔离，并发2 | 892项：891通过、1跳过、0失败 |
| 默认并发完整单测中的 Windows 本地密码生成器 | 一次15秒子进程超时；所属文件单独复跑4/4通过，完整并发2复跑通过；未修改该测试或跳过失败 |

完整文件集命令：

```text
node --test --test-concurrency=2 "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"
```

唯一跳过项为现有可选原生数据库跨连接撤回/账号状态检查，不据此声称本机数据库全量验收。三个实现/测试文件与 DSH 输出逐文件 SHA-256 一致。

随后主线更新至 `67d89bc476708df04cf0a93b2946e370e710aeeb`；已在自己的候选分支无冲突同步。主线新增服务端组件，没有修改本次小程序/参考域源码，原生证据复用。同步后的树另运行受影响登录/返回、解析、全部参考域与新增 OCR 检查408项，408通过；API/后台类型、仓库卫生及文档检查通过。892项结果属于同步前的修订树，不将其数量冒充新主线完整套件；新HEAD完整适用CI仍需核对。

## 实际模拟器证据

通过微信工具 MCP 在本机隔离工程取证，工具内置 skill 0.3.11，已确认客户端授权及版本一致。模拟器实测基础库3.17.3，platform为devtools；不据此冻结 Android/iOS 支持范围。
共享源码及隔离包 runtime 仍禁网，域名校验开启；未调用真实微信身份交换、供应商或生产凭据。修订参考模块 SHA-256：`A86C8A15CAD3669ECAE6066C96AD695452E6B842B367889C0670A96C10034D4D`。

| 场景 | 实际结果 | 证据 |
| --- | --- | --- |
| 首页启动 | 首页、游客标识和未接入提示实际渲染 | [首页](assets/gy-i08-pr90-native-20261012/home.jpg) |
| 原候选详情启动 | 空白；运行时参考模块未定义，未记通过 | [原空白页](assets/gy-i08-pr90-native-20261012/before-detail-blank.jpg) |
| 修订后以现有记录 ID 启动资料详情 | 新隔离副本中实际到达 pages/login/login，显示当前禁网、登录后方可使用的说明；不是资料正文走查 | [修订后门禁](assets/gy-i08-pr90-native-20261012/after-detail-login.jpg) |

部分旧窗口/工具调用超时或返回 aborted；未把它们算通过。最终结论以实际页面状态及截图为准，不把“已触发编译”当渲染成功，也不声称所有 Console 无报错。

## 剩余范围

登录后档案读取、真实资料详情及具体用量资格的完整微信链路仍未运行；相关合成 VM/参考回归证据保留，不能代替实际联网或手机。真实原文可展示用量仍0。
ACE3V 真机仍按[最小清单](gy-i08-ace3v-checklist.md)待验。PR保持草稿，等待新 HEAD 适用 CI 和其他账号复审；未合并、部署或关闭 #8。

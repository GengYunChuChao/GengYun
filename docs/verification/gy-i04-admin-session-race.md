# GY-I04：后台客户端旧响应与会话意图

Refs #4，F01/F13、AC01登录部分/AC09。此增量延续组织上游
[PR49](https://github.com/GengYunChuChao/GengYun/pull/49)，完整导入其固定HEAD
`3f2699690209e7b2539e020b5d6d32f3812637bb`及祖先提交，从个人私有Fork分支建立延续PR。
基线main=`bb3f20fd26fcefafdcdec7370a85b2e5c8af582d`。旧作者、旧PR及全部批复保留，
不写其上游分支、不关闭旧PR或自行解除线程。新PR与最终完整SHA由PR正文记录。

## 评审对应与修复

[最新总评](https://github.com/GengYunChuChao/GengYun/pull/49#pullrequestreview-5464314260)
及[剩余P2](https://github.com/GengYunChuChao/GengYun/pull/49#discussion_r4225395624)
已完整读取。小程序共享意图修复、服务端幂等/会话撤销及其他已修项保持，不重新实现。

后台`apps/admin/src/auth/session.ts`新增登录/退出共用的意图序号，在发起时、任何await之前递增。
读会话捕获序号与令牌，在fetch及JSON解析全部完成后核对，失效则返回null，不清新令牌或返回旧会话。
登录捕获序号与当时令牌，迟到成功/失败统一拒绝为本地“后台登录请求已失效”，不写缓存或返回成功会话；
该提示不是新增HTTP错误码。退出即使无缓存也淘汰旧在途登录，发出的撤销请求仍绑定退出时捕获的令牌。
退出后的新登录可成功，旧退出响应没有后置清理，因此不会清掉更新令牌。

| 触发 | 此次结果 |
| --- | --- |
| 缓存A→旧登录POST待定→退出→旧POST200(B)，两种响应顺序 | 旧登录拒绝，最终本地无会话 |
| 缓存A→旧GET待定→新登录B→旧GET200/401/畸形正文/网络失败 | 旧GET返回null，B保留 |
| POST/GET正文解析待定期间发生较新登录或退出 | 解析后再次核对，旧结果不落地 |
| 两个登录按相反顺序返回，旧成功/HTTP失败/网络失败 | 较新的登录决定状态，旧登录失效 |
| 退出后新登录B成功→旧退出200/503/网络失败 | B保留；不把退出失败宣称服务端已撤销 |

这是客户端意图/令牌绑定，**不替代服务端撤销**。signOut仍发原有服务端退出请求；
服务端失败则撤销未确认。已发出的登录请求也可能在服务端完成；丢弃迟到客户端结果不证明其服务端会话已撤销。
服务端真实撤销、账号停用/epoch及持久幂等关系必须由API/数据库验收，不能据本回归冒称通过。

## 实际验证

Node24.16.0，TypeScript5.9.3，依赖按现有锁文件安装。目标测试
`tests/unit/admin-session-client.test.mjs`在隔离VM中转译实际TS，仅将Vite公开API基址替换为合成基址，
注入假fetch/sessionStorage；每个测试独立模块状态，可控Promise实际暂停fetch和正文解析。
未使用真实后台、微信、供应商、生产或个人凭据。

- 同一26场景重放固定PR49旧源码：8通过、18失败；旧源码和测试副本只在Git忽略的`.local`，仅调整源码加载路径。
- 当前目标26场景全部通过。
- 既有单元与隐私回归（含新26项）：275通过；契约6通过。
- `npm run lint`、API/后台`npm run build`通过；`npm run test:mini`静态检查及4个调试回归通过，非微信编译器/手机证据。
- `npm run test:docs`的27任务/依赖/F-AC-Q/Markdown检查、`tools/validate_contracts.py`及`git diff --check`通过。
- 原`auth-store-pg`执行0001→0008的PGlite测试属于内存PG18证据，**非目标PostgreSQL17.11身份业务实库验收**；本轮没有启动PG或追加真实网络业务测试。

重放命令：`node --test tests/unit/admin-session-client.test.mjs`；随后沿用根目录
`npm run test:unit`、`test:contract`、`lint`、`build`、`test:mini`、`test:docs`。
固定新SHA的CI由新PR记录实际状态，CI通过不代替监工独立审查或整项验收。

## 下一增量最小边界（本PR未实施）

实际迁移编号为`0008_auth_session.sql`及其rollback；不采用旧PR正文的0004描述。
PR45隐私参考组件已合入main，GY-I27仍缺真实消费者与持久适配，不能写成整项完成或仍未合并。
下一步在独立分支，只接真实身份到用途授权读取/撤回/账号停用联调：
`services/api/src/app.ts`装配、`src/auth/middleware.ts`权威userId/authEpoch、
新的服务端隐私SQL适配与既有契约授权路由、`tests/integration`的专用PG17.11测试及独立CI。
复用`packages/privacy/guard.mjs#createPrivacyGuard().requireConsent`，不重写冻结契约或扩大通用CLI。
参考组件的同步内存commitGate不能直接宣称为异步PG事务；若实现实际写/派发，重读账号/用途epoch与副作用
必须在同一事务，不能把异步预检查当授权保证。此边界要先核对最新监工意见及0003对象和受限角色。

可复现验收须包含真实API→SQL低权限LOGIN、无凭据/伪造身份/跨用户拒绝、授权后读取、撤回后拒绝、
账号停用或auth_epoch变化后旧会话拒绝，以及并发撤回/停用不能越过实际事务写边界；全合成、零供应商。
已有旧便携PG是可用运行时历史，旧数据库专门时段不延续；新分支需核对新专用实例目录、获准资源和安全凭据，
不能复制旧私密文件或连已有业务库。正式AppID、微信工具/Android/iOS、完整隐私消费者/删除与阶段M1验收仍未完成。
#4仍open；本次小修、换GitHub身份或CI成功均不关闭整项。

# 开发指南

面向接手项目的新开发者。更新：2026-10-10；代码核对基线 main `7ec4c85`。
“已合组件”不等于整项功能验收；最新状态见[进度](development-progress.md)。

## 1 项目与范围

2026-10-11 用户确认：当前阶段仅做 Android 端微信小程序适配与真机验收；iOS 暂缓，不作为本阶段 PR 合并阻塞。暂缓不等于验收通过，后续恢复时补验，恢复时间 TODO。网页后台架构及其他功能、安全、隐私和真实能力验收不变。

耕云服务识草、查药和除草科普社区。用户端是原生微信小程序，后台独立网页，均由服务端管理身份、权限及外部能力。
初版暂定 2026-11-15 联网比赛，最终阶段暂定 2027-02-28；当前只推进初版和已确认的[视频演示增补](features/pesticide-demo-video.md)。
原有 F01–F20、AC01–AC29、27 项任务保持编号；新增视频单独记录，不冒充已有任务完成。

原需求包括实时识草、OCR、普通话 ASR／文字问答／TTS、科普、AI 审核社区、收藏历史、应用内消息和后台。
游客仅主页；定位只用于选地区。人工评审、计划反馈、专家预警及支付沙箱在二月规划内，真实交易另行决定。

## 2 架构、技术栈与目录

| 层／目录 | 技术与职责 | 当前边界 |
| --- | --- | --- |
| `miniprogram/` | WXML／WXSS／JavaScript；五 Tab、登录与参考页面 | 共享 runtime 默认关闭网络；原生工程不经 Vite 构建 |
| `apps/admin/` | Vue 3.5.43／Vite 7.3.6；独立后台 | 有鉴权框架，完整资料／任务管理待接线 |
| `services/api/` | Node 24.16.0／TypeScript 5.9.3／Fastify 5.12.5 | 已装配健康、公共科普预览、用户／后台鉴权和受限授权路由 |
| `services/api/db/` | PostgreSQL 17；版本迁移与最小权限角色 | PG17.11 有组件验证；不能据此推定全库、云部署和恢复完成 |
| `packages/` | 契约、资料、隐私、媒体、评估等共享组件 | 参考组件与实际 HTTP 服务分开；小程序不打包服务端 SDK |
| `tools/`、`tests/` | 调试、导入、评估、验证与回归 | 普通 CI、微信编译、真机和供应商证据分别记录 |
| `docs/`、`.github/` | 指南、需求、参考与 CI／提交入口 | 长字段表和历史证据不放入快速开始 |

后台和小程序通过 API 访问业务；API 访问 PostgreSQL 和私有存储，供应商调用留在服务端。
持久任务／租约、同仓 worker 是架构设计，尚不能视为通用运行服务已交付。
初版不强制引入 Redis、微服务、GPU 或向量库。实际依赖以 `package-lock.json` 为准。

## 3 模块职责与依赖

| 模块 | 职责 | 主要依赖 |
| --- | --- | --- |
| 身份／用途授权 | 微信身份交换、独立后台会话、归属、授权授予／撤回 | 工程、平台能力；真实外发先有用途守卫 |
| 资料／确定性规则 | 来源版本、作物物种、登记制剂匹配、标签原文 | 合格资料与来源审核；资料不足不生成 DoseCard |
| 私有媒体 | 上传、真实类型、EXIF、访问控制、取消清理 | 身份、用途授权、私有存储 |
| 识别／语音／问答 | 识草、OCR、ASR 确认、检索问答、已检查文本播报 | 资料、媒体、供应商适配与独立样本 |
| 社区／后台 | 版本审核、先审后发、举报、资料／账号／任务管理 | 身份、媒体、审核；旧回调不能放行新版本 |
| 收藏／消息／删除 | 归属、去重、失效引用、注销和恢复清单 | 对应业务事件；全模块删除随集成验收 |
| 情景演示视频 | 确认扫描药名后模板合成近期／十年／二十年视频 | OCR 结果、素材、播放器；新增接口尚待定义 |

先贯通登录→手选档案→有来源查询，再接安全过滤和文字问答；文字问答不等待完整 ASR，页面不等待 TTS。
资料和样本从开始持续准备；能力实现时评估，M4 汇总。完整 27 项顺序见[任务依赖](development-order.md)。

## 4 本地启动与环境

在仓库根目录使用锁文件安装。API 只读取进程环境，`npm run dev:api` 不会自动加载根 `.env`。

```powershell
npm ci
$env:APP_EXECUTION_MODE = 'stub'
npm run dev:api
```

默认 API 为 `127.0.0.1:3000`。另开终端检查健康并启动后台：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
npm run dev:admin
```

后台默认 `127.0.0.1:5173`，没有开发代理；鉴权联调需同源反向代理或另行实现并验证跨域策略。
stub 使用替身身份／存储；健康返回数据库未配置不代表真实业务可用。

| 必要配置 | 用途 |
| --- | --- |
| `APP_EXECUTION_MODE` | 必填：real／stub／preset_demo |
| `DATABASE_URL` | API、迁移使用；real 必填 |
| `SESSION_SIGNING_KEY`、`DELETION_LEDGER_KEY` | 服务端签名／删除配置；real 必填 |
| `WECHAT_APP_ID`、`WECHAT_APP_SECRET` | 正式身份交换；secret 只留服务端 |
| `OBJECT_STORAGE_*` | real 启动必填；配置齐全不证明上传服务已接通 |
| `VITE_API_BASE_URL` | 后台公开 API 基地址，默认 /api/v1；不是密钥 |

完整配置和加载方式见[配置参考](reference/configuration.md)。不要把真实值写进命令示例或提交仓库。
当前 real 启动检查完整配置，即使只联调部分业务也不会自动豁免其他必填项。

小程序：微信开发者工具导入含 `project.config.json` 的仓库根目录；基础库配置目标 3.17.3。
模拟器、Android 真机及历史候选版本的证据分开；最低支持版本按实测冻结。共享工程域名校验开启，不能提交本地例外。
隔离诊断副本可按[本地微信调试](reference/local-development.md)生成；诊断服务不是业务 API。

数据库先列迁移，再按[数据库交接](verification/database-run-handoff.md)准备独立库、角色与私密环境。
以下 up 仅在获准目标库且 `DATABASE_URL` 已安全注入时执行：

```powershell
node services/api/src/db/migrate.ts list
npm run db:migrate
npm run db:status --workspace @gengyun/api
```

迁移不自动完成角色引导，不用组件集成脚本清空已有业务库；详细前置、回滚和限制见交接与指南第 7 节。

## 5 接口契约与关键决策

- 路径、字段与状态以[OpenAPI](../packages/contracts/openapi.json)、[数据字典](architecture/data-dictionary.md)、[状态协议](architecture/state-contract.md)为准；契约列出的路径不等于已实现。实际装配见 `services/api/src/app.ts`。
- 用户、后台鉴权独立；服务端验证会话、角色及对象归属，客户端不能指定 openid／owner／role。
- 任务设计有排队、运行、成功、不确定、失败、超时及取消；终态不能被旧回调复活，幂等重试不得重复计费。
- 来源、账号、用途和对象版本在执行与保存时复核；撤回阻断在途回写。资料与媒体可查不等于可公开或可作用量依据。
- 用量只显示符合条件的登记制剂原文，不生成个人处方、混配或自动换算。问答检查通过后显示／播报。
- 首版不启用用户训练；注销立即失效会话，在线 7 日／备份 30 日删除；第三方“已请求”与“已完成”分开，恢复先重放删除清单。
- API 契约版本为 1.0.0；删改字段、权限、单位或状态语义需列消费者和兼容／迁移影响，不静默破坏接口。新增视频接口是规划，尚未写入现有 OpenAPI。
- HTTP 500 当前有 `NO_CONTRACT_CODE_FOR_500` 缺口；客户端不能假定每种失败都有既有业务码。

## 6 测试、构建与部署

按[审查规范](pr-review-policy.md)选择本次受影响检查，不要求每个组件 PR 完成整项验收。

| 命令 | 作用 |
| --- | --- |
| `npm run test:docs` | 文档链接、表格、27 项依赖和 F／AC／Q 映射 |
| `npm run lint` | 类型与仓库卫生检查 |
| `npm run test:unit` | 单元、隐私、媒体和参考组件回归 |
| `npm run test:contract` | 代码与契约一致性 |
| `npm run test:reference` | 参考查询组件 |
| `npm run test:evaluation` | 评估程序；不等于真实模型指标 |
| `npm run test:mini` | Node 静态和诊断检查；不代替微信编译 |
| `npm run build` | API→services/api/dist；后台→apps/admin/dist |

纯文档通常只做文档／链接检查；接口改动加契约检查；代码做受影响测试与必要构建。
页面改动检查对应编译／渲染；完整链路在集成节点做 Android 真机、供应商和恢复验收。
复用同版本有效实测，新增付费请求需用户单独授权；原需求第 6 节的真实能力门槛仍有效。

构建与独立契约参考检查：

```powershell
npm run build
python tools/validate_contracts.py
python tools/test_contracts.py
```

部署顺序：备份与迁移计划→安全注入 real 配置→确认迁移／最小角色→API→后台同源 /api/v1 转发→小程序 HTTPS 合法域名→健康与业务冒烟→回滚／恢复核验。
有 Node24 的服务端可使用当前源码启动入口：

```powershell
npm run start --workspace @gengyun/api
```

后台发布 `apps/admin/dist` 静态产物；API 发布包需包含源码、依赖与迁移文件。
`prepare-wechat release` 只产生关闭网络的准备副本，不能直接当比赛发布。
TODO：选定实际部署平台、合法域名／备案方案、发布配置、小程序发布步骤、全库恢复及进程托管实测。没有已验证的一键生产部署命令；合并不触发部署。

## 7 已知限制、坑与破坏性变更

- 主线已有鉴权、授权、资料和数据库组件；识别、语音、问答、社区及通用媒体 HTTP 链路仍未整项验收。
- 当前种子与暂存不等于完整核准标签；可用 DoseCard 仍为 0，不用模拟卡补齐真实验收。
- 复制 .env 不会让 Node 自动读取；后台 VITE 变量在开发启动／构建时注入，修改后重启／重建。
- 生成微信副本的工具拒绝覆盖已有输出；页面新增依赖必须同步打包清单。
- 部分旧迁移自带事务，不能把局部成功证据当所有迁移失败均原子回滚。业务撤回、批次回滚、结构 down 分开；保留审计时结构 down 可能拒绝。
- 来源／暂存 CLI 限定专用本机库及角色；不把它们的连接限制推定为所有 API 的限制。
- 独立 worktree 或 Git 作者名不形成权限隔离；写手独立账户提交 Fork，监工审核后合并。当前 Free 方案不能把 CODEOWNERS 宣称为强制保护。
- 破坏性变更清单随实际变更维护，不能用旧快照推定最新兼容。当前升级接口或迁移前先看对应固定 SHA 验证页。

## 8 参考入口

[需求](requirements.md) · [阶段计划](development-plan.md) · [进度](development-progress.md) · [完整参考索引](reference/README.md)。

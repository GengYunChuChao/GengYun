# GY-I26 H1 首页公开预览提交核查

Refs #28。2026-10-26，指挥 Codex 核查、集成和推送；实现来自原生 WorkBuddy 会话声明的 Kimi K3.1 Pro，不声称另行验证过 Kimi API。此记录不是独立监工批准。

## 版本与范围

- 原实现提交：`213b5f8702323faa0eebc7cdfc6e4f49369ee325`。
- 集成基线：`60cab9fe4ce604706e90835de2293e5af3cc2fe5`。
- 无冲突 cherry-pick 后代码提交：`ed30546b`；代码内容与原提交一致。
- 消费公开 `/public/home`，不带会话令牌，校验封套、字段闭集、枚举与数量。失败、合法空列表、禁用联网和显式重试分别呈现；离页和新读取淘汰旧响应。
- 预览仅标题、摘要、类型和来源；点击进入既有知识或社区入口并保留登录门禁，不把预览 ID 当详情授权。H2 能力标记及 Hero 排版保留。
- 不改变契约、后端、共享认证、运行配置和其他页面。仍是 #28 的组件交付，不关闭整项。

## 指挥本轮实际检查

- `node --test tests/unit/miniprogram-ui-auth-integration.test.mjs tests/reference/i26-tabbar-skeleton.test.mjs tests/local-debug.test.mjs`：62/62 通过。
- `node tools/check-wechat-project.mjs`：通过；不等于微信编译或真机测试。
- `node tools/verify-doc-anchors.mjs --strict --scan docs`：原有基线外新增 0，通过。
- `git diff --check upstream/main`：通过。
- 对照当前 OpenAPI 的 Home、Preview、Meta 和 SourceKind 定义，成功响应消费字段一致。

## 复用的模拟器证据及边界

以下为实现者在原实现版本采集的截图，指挥本轮已逐张打开检查，未重新运行模拟器。代码由原提交原样集成；截图不证明最新 main 上重新运行通过。原报告环境：隔离工程、devtools、SDK 3.17.3、376×742、fontSizeSetting=26。

- [网络失败](assets/home-preview-20261026/01-local-failure.png)：本机 4318 端口无服务响应，显示失败和重试入口，不是后端联调。
- [合成公开列表](assets/home-preview-20261026/02-synthetic-ready.png)：模拟请求回调返回两条合成数据；标题、摘要、类型、来源及替身说明可见。
- [合成合法空态](assets/home-preview-20261026/03-synthetic-empty.png)：明确空列表，无本地填充。

实现者记录：跨组件 tap 返回成功但状态未变，未计物理点击通过；改用页面 `retryPreviews()` 驱动合成响应。已恢复原请求函数并移除合成会话。

截图下方旧首页资料入口仍有窄列排版问题，由独立首页排版修复 PR 处理；本片没有把它标为修复通过。

真实 HTTP 后端、真实资料、真机、供应商与物理重试点击均未取得验收证据。以上局部证据不能替代整项业务或发布验收。

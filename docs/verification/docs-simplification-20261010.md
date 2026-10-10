# 文档精简与视频增补验证（2026-10-10）

用户确认方案，并明确授权本次直接提交 main；不创建 PR，不修改应用、契约 JSON、任务依赖或仓库权限。

## 内容与长度

- 代码核对基线：main `7ec4c855a69e5a31fe97452aefa1b3e38f2d3207`。
- 原主要文档：README、development-plan、development-order、development-progress、pr-review-policy、engineering-shell。
- 六份原文合计 46,953 个 Unicode 字符（UTF-8 解码、LF）；六份新版＋development-guide＋视频需求合计 11,948 字符，保留 25.45%，减少 74.55%。
- 比例只计主阅读内容，包含新增视频页；独立参考、完整需求与历史存档不计入，不声称整个仓库减少 74.55%。
- 11 份旧文档完整存档，只重定位相对链接；已与固定提交逐一比对。
- 原有 F／AC／Q 编号和 27 项有向无环依赖保持；视频采用单独增补 VID-DEMO，尚未实现。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| npm run test:docs | PASS：27 项任务、依赖、编号、Markdown 文件链接／表格 |
| python tools/validate_contracts.py | PASS：112 操作、29 样例、30 媒体轨迹、8 资料往返；仅设计检查 |
| python tools/test_contracts.py | PASS：8 组契约设计检查，不是应用验收 |
| 当前入口链接锚点／代码块检查 | PASS：新增／重写入口和参考页内部目标有效；代码块仅 PowerShell 命令 |
| 归档完整性与长度检查 | PASS：11 份原文保留；主阅读长度 ≤30% |
| git diff --check | PASS；未改变应用或契约文件 |
| Node24 API stub 启动 | PASS：仅自有 loopback 临时端口，GET /health HTTP200，execution_mode=stub，数据库 not_configured |
| 迁移 list | PASS：列出 0001–0009 九个文件；未连接或迁移真实数据库 |

测试子进程未注入生产／供应商凭据，已停止；未新增付费请求、原始媒体外发、部署或支付。
微信编译、真机、供应商、云部署和视频播放未在本次文档修订中验证，不记录为通过。
远端主线 CI 在提交后另看实际状态；本页不预写通过。

## 关键变更

分层审查复用未变化背景与证据，组件按本次范围合并；真实功能、权限、隐私、契约或适用检查失败仍阻塞。
模板合成视频验可播放、药名／时间段对应、明显演示标识及失败恢复，不验长期真实性；原 OCR／识草／问答指标保持。
原文档中的旧状态、12 小时巡检、历史联系与截止不再作为当前规范。

# GY-I01 验证记录与限制

日期2026-10-03；提交前同步base `90d3a0ba69dd71791f9a68f6654337baad882552`（包含指挥/写手/监工分工，初始领取基线714f5c1）。这是架构/契约PR的证据，**没有应用、模型、AppID、真机或删除恢复验收通过**。最终提交SHA与CI链接写PR，避免文件自引用提交hash。

## 已运行检查

| 检查 | 环境 / 实际命令 | 结果与范围 |
| --- | --- | --- |
| 文档/任务依赖 | Windows，Python3.14.3；`python tools/validate_development_docs.py` | PASS：27项初版任务、无环依赖、F/AC/Q、Markdown链接/表格；扩展到docs嵌套目录 |
| 契约一致性 | `python tools/validate_contracts.py` | PASS：110操作、内部引用、身份、scope、幂等/版本头、状态/错误映射、16个合成设计示例；不模拟HTTP请求或证明服务端已实现 |
| 检查器负例 | `python tools/test_contracts.py` | 4组测试PASS，涵盖坏引用/匿名私有/用户token访问后台/缺幂等与版本/状态漂移/终态复活/未确认语音/模拟用量/缺条件/未审公开/超额或用途错误音频/不足回答含用量；测试的是契约检查器 |
| 独立规范验证 | 临时Python3.12、jsonschema4.25.1；`python tools/validate_openapi_standard.py --schema .supervisor/openapi-3.1-schema.json --dependency-path .supervisor/pydeps` | PASS：官方OpenAPI3.1 schema、197个Draft2020-12组件schema、16个fixture；官方schema不独立证明业务语义，语义还需状态协议/实现测试 |
| 空白差异 | `git diff --check` | PASS；提交前再次执行 |

官方schema：[固定版本](https://spec.openapis.org/oas/3.1/schema/2022-10-07)。下载JSON解析后按Python默认 `json.dumps(data)` 写入临时文件，SHA256为 `c95d4a4bc2e7836732d78df326e67f227253eb2bb87e9a5192d353a723266a1f`。验证库装在忽略的`.supervisor/pydeps`，不改系统环境、不提交包或依赖输出。依赖组合为jsonschema4.25.1、attrs26.1.0、jsonschema-specifications2025.9.1、referencing0.37.0、rpds-py2026.6.3、typing-extensions4.16.0。普通CI只用Python标准库执行前三项；独立规范验证是本次另行实测，不假称CI执行了该项。临时pip文件ACL导致普通沙箱不可读取，使用同一已审脚本的提升权限进程执行成功，没有修改ACL。

重现独立规范验证：选择独立临时环境装上述包，使用HTTPS验证证书下载官方固定schema（不关闭TLS验证），解析并按上述规则保存；运行脚本的两个参数可指向自己的临时目录。依赖缺失时脚本明确失败，不静默跳过。OpenAPI文件只列待实现地址，无实时服务请求。

## 失败、修复和阻塞

首次一致性检查报 `Operations manifest drift`：操作清单按声明顺序、OpenAPI按同path归组枚举，顺序不同触发误报。修复为按 `(path,method)` 比较完整记录，而非忽略差异；bad authentication/version/ref等负例仍拒绝。修复后文档、契约和负例均重新通过。

候选npm官方注册表元数据已读取，版本/日期/engine/peer见[精确候选](../../packages/contracts/runtime-baseline.json)。Node24.16.0/npm11.13.0实际运行版本已读；没有声称它们是最新版本。

临时兼容目录`.supervisor/compat`尝试精确候选安装，`npm install --ignore-scripts --no-audit --no-fund`长时间无结果后中止；后续通过官方npm-cli直接运行、设置15秒网络超时和0重试，最终exit1：`CERT_HAS_EXPIRED`，同时观察`ECONNRESET`/`ETIMEDOUT`。未改TLS验证、注册表、全局Node/Git凭据或其他工作区。命令等价形式：

```powershell
node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" install --ignore-scripts --no-audit --no-fund --fetch-timeout=15000 --fetch-retries=0 --loglevel=http
```

因此**干净安装及Fastify注入/TS编译/Vue与Vite构建兼容未通过，也未执行**；没有可提交的应用锁文件。PR保持Draft/Refs #1，精确包版本是可审候选，待GY-I02/25在可信环境验证后冻结，不能据文档关闭整项。PostgreSQL17.11只有官方发布证据，未连接、未迁移。compiler-sfc同版约束未单独安装实测。

## 本次交付与剩余

- ADR、数据字典/关系/索引/迁移约定、OpenAPI、状态协议、合成成功失败示例、F/AC及消费者映射已经提交待审。
- 初版和二月边界、来源制剂、权限/幂等/竞态、媒体授权与删除闭环设计有明确契约，尚未由应用实现或真实供应商证明。
- 监工需独立核对当前HEAD、范围与设计；候选兼容/真实服务未验证不写成冻结完成。GY-I01台账仍未验证、软件完成0/27，后续任务按main和依赖重排。

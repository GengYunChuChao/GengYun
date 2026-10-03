# GY-I01 验证记录与限制

日期2026-10-03；首轮base `90d3a0ba69dd71791f9a68f6654337baad882552`，修订2已将最新main `43de3f998590b84430856cc91e4875d10355bc00` 合入原分支（不改写已推送历史）。这是架构/契约PR的证据，**没有应用、模型、AppID、真机或删除恢复验收通过**。最终提交SHA与CI链接写PR，避免文件自引用提交hash。

## 首轮已运行检查（旧HEAD f6b4497）

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

因此**干净安装及Fastify注入/TS编译/Vue与Vite构建兼容未通过，也未执行**；没有可提交的应用锁文件。首轮创建Draft/Refs #1；修订2核对远端已ready，文档与PR说明按真实状态更正，但ready不等于兼容/冻结通过。精确包版本是可审候选，待GY-I02/25在可信环境验证后冻结，不能据文档关闭整项。PostgreSQL17.11只有官方发布证据，未连接、未迁移。compiler-sfc同版约束未单独安装实测。本轮不重新安装或修改TLS/认证；上述阻塞继续保留。

## 修订2：两项P2与本轮验证

监工[review 5401300547](https://github.com/Sek1ro-oka/GengYun/pull/33#pullrequestreview-5401300547)审查旧HEAD f6b4497；其110操作/16例/4组测试证据不自动沿用至新提交。两项缺陷都按当时schema和权限路径确认，没有把意见误记为业务变更。

| 评审意见 | 字段/流程修订 | 正反例及检查 |
| --- | --- | --- |
| 其他读者无媒体版本/路径 | Post.media实际媒体版本；Author.revision/avatar_media；POST社区上下文授权+GET带userSession与专属token的二进制取图。If-Match是内容revision，媒体/头像revision另核；旧owner私有接口不扩权 | 作者/其他读者/评论头像完整合成链；独立7/11/5/13版本；私有/未审/识别/问答资源签发拒绝，内容/媒体/作者/用途/会话/父帖/注销变化后取图拒绝；错ETag/媒体版本、错grant/token、把拒绝改200均失败 |
| Post关联输入无法回传 | linked_knowledge_ref + linked_knowledge统一Post投影；无关联null，可用仅公开标题，不可用保留目标ref但summary=null；编辑省略保留、null解除、原失效引用可原样保留 | 创建→审核→详情/列表→编辑的8组合成往返；无关联/有效/下架/过期/不可见、保留/省略/解除；丢引用、目标版本不一致、旧受限标题泄漏均失败 |

本轮实际命令：`python tools/validate_development_docs.py`、`python tools/validate_contracts.py`、`python tools/test_contracts.py`、`git diff --check`；结果分别为27任务/链接依赖PASS，112操作/29设计fixture/30媒体trace/8资料往返PASS，8组测试PASS，空白检查PASS。所有trace只验证合成快照和契约断言；不是HTTP服务器、真实会话/签名、存储ACL或真实AI运行证据。

独立标准验证复用受控环境Python3.12、jsonschema4.25.1及同一官方schema/hash，运行 `python tools/validate_openapi_standard.py --schema .supervisor/openapi-3.1-schema.json --dependency-path .supervisor/pydeps`：PASS，205组件及130个wire对象（含29基本fixture和trace内请求/grant/Post往返形状）；新HEAD/CI链接记PR。没有重新下载/安装依赖或变更共享配置。新版本服务端守卫、并发、token验签、图片字节及撤销的实测仍需GY-I06/15/27/19完成，不因设计断言PASS宣称AC08/09/16/19通过。

## 本次交付与剩余

- ADR、数据字典/关系/索引/迁移约定、OpenAPI、状态协议、合成成功失败示例、F/AC及消费者映射已经提交待审。
- 初版和二月边界、来源制剂、权限/幂等/竞态、媒体授权与删除闭环设计有明确契约，尚未由应用实现或真实供应商证明。
- 监工需独立核对当前HEAD、范围与设计；候选兼容/真实服务未验证不写成冻结完成。GY-I01台账仍未验证、软件完成0/27，后续任务按main和依赖重排。

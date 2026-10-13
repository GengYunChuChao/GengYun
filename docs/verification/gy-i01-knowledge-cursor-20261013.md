# GY-I01 科普游标固定有效期与客户端恢复

2026-10-13；作者 cxhhandsome，基线正式 main `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`。
[领取记录](https://github.com/GengYunChuChao/GengYun/issues/1#issuecomment-6140837444)；仅 Refs #1，复用 #7 已合资料查询，不关闭总体任务。
证据绑定包含本记录的作者提交，实际 reviewed_sha、CI 和合并状态在 PR 自查／独立批复中记录。

## 缺陷与行为

[状态协议](../architecture/state-contract.md)约定签名游标有效期 15 分钟。
原 `/knowledge` 每页重算 `expires=Date.now()+15min`，旧分页快照能通过持续翻页延长有效期。
新分页链保留首次签发的截止时间，改 limit 仍不续期；精确到期返回 `400 INVALID_CURSOR`，从第一页重新查询生成新的分页链。

新增知识域分页组件，HMAC 使用 `knowledge-list/v1` 命名空间，绑定格式版本、服务端主体／auth_epoch、既有过滤与排序、完整当前资料投影水位、末条 ID 和绝对截止时间。
校验闭集字段、规范 base64url、签名长度、有效期及末条是否存在，不把解码后字段当身份来源。
原事务的账号／会话锁、当前资料／来源版本投影、离开事务前时效检查和详情 DTO／ETag 保持。
完整投影包含正文和来源生命周期字段，过滤外记录变化也仍会使旧游标失效；无过程缓存或替身成功回退。

小程序此前将所有此类 400 映射为“服务暂不可用”。现在只对通过错误封套／契约版本／模式校验的 `INVALID_CURSOR` 显示“查询已过期或资料已更新，请点击查询重新开始”。
复用原页面清空旧资料／游标的行为，手动查询保留筛选条件并从第一页开始，不自动重复失败游标、不清除有效登录。

## 实际检查

Windows；Node `v24.19.0`、npm `11.17.0`、TypeScript `5.9.3`、Fastify `5.12.5`。
所有身份、资料与签名测试值为合成夹具；子进程不继承真实业务配置／凭据。

| 层次 | 命令／证据 | 结果与边界 |
| --- | --- | --- |
| 组件／实际产品 HTTP／页面回调 | `node --test --test-reporter=spec tests/unit/knowledge-pagination.test.mjs tests/unit/knowledge-api.test.mjs tests/reference/knowledge-client.test.mjs tests/reference/knowledge-layout.test.mjs tests/unit/auth-routes.test.mjs tests/unit/api-errors.test.mjs tests/contract/contract-codes.test.mjs` | 97 项中 96 通过、0 失败、1 原生专用跳过；包括 PGlite SQL 和实际 Fastify 回环 HTTP，页面在 Node VM 使用受控微信回调 |
| 原生数据库补验 | 独立本机新建 PG17.11 集群，只注入合成测试库 `GY_KNOWLEDGE_TEST_OWNER_URL`，`node --test --test-reporter=spec tests/unit/knowledge-api.test.mjs` | 10 项全部通过、0 跳过；受限 LOGIN／真实回环 HTTP，含上行跳过的独立连接撤回／停用边界；集群已停止 |
| 原生客户端 HTTP 传输 | `node tests/integration/knowledge-consumer-http.mjs` | 9 组通过；加载真实客户端代码、回环传输，服务／身份／资料为合成 HTTP 夹具，不是实际 PG 产品服务 |
| 小程序工程静态检查 | `node tools/check-wechat-project.mjs` | JSON／路由／域名检查／JS 语法通过；不是微信编译或 Android 实机 |
| 类型／卫生 | `node tools/lint-workspaces.mjs` | API、后台 tsc 与仓库卫生通过 |
| 文档／diff | `node tools/run-python.mjs tools/validate_development_docs.py`、`git diff --check` | 编号、依赖、F／AC／Q、链接／表格及 diff 通过 |

关键反例：

- 注入时钟：14 分钟后翻页仍保留首次截止，15 分钟前最后 1ms 可继续，精确 15 分钟拒绝；可变 limit、尾页与空集合正确。
- 签名／主体／auth_epoch／过滤／水位／版本／排序／末条／有效期绑定；未知版本、旧域签名、非规范编码、错误 MAC、额外或缺失字段与超长游标拒绝。
- 产品 HTTP 验证第一页和第二页截止一致、变 limit 结束、跨主体／篡改／资料隐藏拒绝，详情／来源／权限回归保留。
- 页面控制回调验证失效后清空、选择失效、登录保留、无自动重试、旧“下一页”不再发送请求、点击查询无旧 cursor 且筛选保留；坏版本／模式／request_id 不被当成正常失效提示。
- 作者隔离 checkout 临时恢复基线 `knowledge/service.ts`，产品 HTTP 用例在 `second page must preserve the first 15min deadline` 断言失败；finally 按原字节恢复候选。原实现反例不是新的通过证据。

## 兼容与剩余

无迁移、公开字段或冻结契约修改。旧编码／签名格式游标拒绝，客户端需重新查询；已验证该恢复逻辑，没有保存或复活旧资料。
现有查询仍为 `id_asc`，与冻结 `(created_at DESC,id DESC)` 排序存在剩余偏差；`knowledge_versions` 与受限投影均无 created_at，不能用来源检索时间或新迁移时间冒充历史资料创建时点。
该排序与历史数据方案另行处理，本轮不宣称全部分页约定或 #1／#7 整项完成。
改动不依赖待合 #107／#108／#109／#113，也不接管 #106／#110 装配、#111／#112 部署准备。

回滚可恢复原服务／客户端文件，无存储迁移；新旧游标互不兼容，都从第一页重读，不改写实际资料。
未运行本轮微信编译、正式微信身份、Android 真机、真实资料／供应商或生产发布验收，无新增真实付费业务验证／部署。

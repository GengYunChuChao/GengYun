# GY-I01 授权列表签名游标与状态重验

日期：2026-10-13。作者 cxhhandsome；Refs #1，整项保持开放。

## 范围与基线

正式 main `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`，分支 `codex/gy-i01-consent-cursor-20261013`。已评论领取：[领取记录](https://github.com/GengYunChuChao/GengYun/issues/1#issuecomment-6138310289)。本次仅修订现有 GET /me/consents 的分页，保留授予/撤回和外发守卫，未变更冻结接口、迁移、路由注册、依赖或工作流。

原服务以裸 base64url UUID 翻页，未签名或绑定用户、身份版本、排序、数据水位与有效期。原随机 UUID 升序也不能表达最近创建的授权记录。

现在先在原身份/会话事务及用途行锁下读取完整当前快照，再验证、签名和分页。用途是四项闭集，当前列表最多四行，未改成读取全部历史。使用 HMAC-SHA256 与接口专属签名域，绑定服务端用户、auth_epoch、kind=consents、无过滤器（null）、排序、当前 DTO 水位、末项 id 与 15 分钟截止；等长签名用 timingSafeEqual 比较。连续翻页沿用初始截止，不滚动续期；limit 可变，不被当作业务过滤器。

Consent 契约与实际表没有 created_at，已有 granted_at 记录本轮授权的创建时点，因此使用 `granted_at DESC,id DESC`，不添加或伪造字段。相同时点按 id 降序；已撤回记录保留其创建时点和当前状态。记录/版本/接收方/排列变化使旧 DTO 水位失效，返回统一 400 INVALID_CURSOR，调用方须从第一页重读。

旧 UUID 游标明确不兼容，签名密钥切换也使游标失效；游标是 opaque string，无数据库迁移或缓存回填。每页仍重验当前账号/会话与授权记录，不从 cursor.user 取得主体，不把旧游标当权限。当前仓库未发现小程序/后台的该列表分页消费者；客户端收到 INVALID_CURSOR 的刷新交互尚未验证。

PR #106/#84 的实现、PR #107 的基线对照及 PR #108 的等待头各自保留，本次不接管、不依赖这些 PR 合并。#107 文档只描述其已验基线，后续按真正合入的 main 更新分页缺口，不能预记合并或把整个分页维度升档。

## 相称验证

本机 Node v24.19.0、npm 11.17.0。最终检查通过清除业务配置/凭据与 NODE_OPTIONS 的子进程运行；身份、政策与授权记录均为合成资料，非真实用户授权或已核验来源。

| 检查 | 实际结果与边界 |
| --- | --- |
| 游标专项 | 7 通过；正常/空/尾页、变更 limit、跨用户/身份版本/密钥、正文/签名篡改、旧格式/异常编码/长度、精确截止、数据水位/参数/锚点与额外字段反例 |
| 实际产品 HTTP + PGlite | 1 通过；受限 SET ROLE、固定不同时间/同时间 tie 的排序、当前四用途翻页、另一用户空列表/拒绝借用、过期/错 kind/身份版本、撤回后旧水位拒绝、退出后 401 |
| 受影响联合回归 | `node --test tests/unit/consent-pagination.test.mjs tests/unit/consent-pagination-http.test.mjs tests/unit/auth-routes.test.mjs tests/unit/api-errors.test.mjs tests/contract/contract-codes.test.mjs`：45 通过，0 失败/跳过 |
| 独立原生 PG17.11 | `node tests/integration/auth-privacy-pg.mjs`：23 组通过；独立全新测试集群/专用库、受限 LOGIN、本机回环 HTTP；签名/用户/有效期/水位/旧格式、账号/会话/锁竞争及撤回重验通过 |
| 基线反例 | 临时恢复本 checkout 的 b1f6ab0 授权服务，实际产品 HTTP 的稳定排序断言失败；测试后 finally 恢复候选源码。预期失败，单独记录，未当成功用例计数 |
| 静态/文档/diff | `npm run lint`、`npm run test:docs`、`git diff --check` 通过；完整 diff 未改冻结契约或加入凭据/原始媒体/依赖/构建输出 |

原生 PG 使用已有官方 17.11 二进制，在本任务私有目录另建临时 loopback 集群，未连接或重置用户已运行的本地开发库。初始化 trust 仅限此合成测试集群；业务脚本另建受限 LOGIN 并验证其权限。运行结束 pg_ctl fast stop 成功，测试数据/日志仅留私有目录，不提交。

原生集成仍使用合成身份交换与政策记录，grant API 独立验证，不据本轮宣称真实微信、真实授权来源、供应商、Android 或外发/注销全链通过。冻结 /knowledge 的排序及其他分页组件仍需各自核对；这不是整个分页协议验收。

## DSH 辅助与自查

使用已配置 DSH 0.2.0-rc.2 / WorkBuddy Connect 0.7.2，补齐自己辅助 profile 缺失的宿主依赖后，Step-5-Preview 成功返回反例初稿，一次调用约 80.7 秒。仅复用现有安装缓存，未更改认证/默认模型配置；这属于开发辅助，不是项目供应商能力验证。

辅助请求仅提供上述分页约定与合成场景，17 个工具插件禁用，未向其提供项目源文件、真实用户资料或业务凭据，也未派发文件读写/执行验证任务。其建议由作者核对：退出按会话撤销重验，不假定一定递增 auth_epoch；数据新增按旧水位拒绝/重开列表，不承诺用旧游标继续遍历。其输出不计作测试、独立复查或真实能力证据。

按 [PR 规范](../pr-review-policy.md)执行局部 HTTP/SQL 层作者自查；最终 HEAD、已验 base、CI 和申请合并由作者 COMMENT 绑定，不作自身 APPROVED。Fork CI 未运行前只记待维护者批准，整项 issue #1 保持开放。

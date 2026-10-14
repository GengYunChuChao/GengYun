# GY-I01 后台幂等回执到期与排队时钟修订

2026-10-13；作者 cxhhandsome，已验基线正式 main `55b95ceecf19e036169bd311037bf0607b70fe5b`。
领取时基线为 `b1f6ab0`；提交前 #107／#108 已合，已同步新 main 并复跑受影响检查。
[领取记录](https://github.com/GengYunChuChao/GengYun/issues/1#issuecomment-6141336829)；仅 Refs #1，复用 #18 已合服务，不重领或关闭整项。
证据绑定包含本记录的作者提交，实际 reviewed_sha、CI 与合并状态以 PR 自查／独立批复为准。

## 问题与结果

后台 `runIdempotentWrite` 直接调用 `findIdempotent`，命中已完成回执时不检查 expiresAt、也不清理到期记录。
运行时虽有到期清理和 claim 时的过期让位，但完成回执始终先命中，因此旧成功结果可以无限重放，绕开当前业务版本检查。
后台独立默认值另为 5 分钟，与[状态协议](../architecture/state-contract.md)普通记录 24 小时的约定不符。

修订后台默认值为 24 小时，并在获得原串行临界区后取当前时刻、实际清理已过期记录，再查回执／占位。
在队列前取时钟会遗漏排队期间的到期，也会让新记录少掉等待期间的有效期；已改为以获得临界区时刻判定。
未到期同键仍收敛到同一响应，不滑动到期时间；到期后按新请求执行当前版本校验，业务失败释放新占位，不额外写成功审计。
清理只作用于普通回执，不删除业务实体、历史修订或只可追加审计；现有权限门、键域／摘要、并发与失败处理保留。

## 已执行检查

Windows；Node `v24.19.0`、npm `11.17.0`、TypeScript `5.9.3`。
测试使用合成管理员上下文和内存 store／运行时，清理子进程环境；无生产凭据、网络供应商或实际账号验证。

| 层次 | 命令／证据 | 结果 |
| --- | --- | --- |
| 受影响组件 | `node --test --test-reporter=spec tests/unit/admin-idempotency-expiry.test.mjs tests/unit/admin-content-concurrency.test.mjs tests/unit/admin-content-immutability.test.mjs tests/unit/admin-content-lifecycle.test.mjs tests/unit/admin-content-rejections.test.mjs tests/unit/admin-contract-conformance.test.mjs tests/unit/admin-ops-concurrency.test.mjs tests/unit/admin-ops-contract.test.mjs tests/unit/admin-ops-job-integrity.test.mjs tests/unit/admin-ops-operations.test.mjs tests/unit/admin-ops-rejections.test.mjs tests/unit/auth-routes.test.mjs tests/unit/idempotency-retry-after-http.test.mjs tests/unit/api-errors.test.mjs tests/contract/contract-codes.test.mjs` | 新 main 上 141 通过、0 失败、0 跳过，含 11 项新增专项、已合等待头回环及既有正常／拒绝／并发／取消结果完整性回归 |
| 原实现反例 | 作者隔离 checkout 临时恢复基线 `admin/identity.ts` 与 `admin/idempotent-write.ts`，运行默认保留期和显式短 TTL 用例 | 6 项全部失败；finally 按原字节恢复候选 |
| 排队时钟独立变异 | 保持候选 24 小时与清理行为，仅把时钟读取移回队列前，运行两个受控排队用例 | 2 项全部失败；finally 恢复候选，候选两项通过 |
| 类型／卫生 | `node tools/lint-workspaces.mjs` | API／后台 tsc 与仓库卫生通过 |
| 文档／diff | `node tools/run-python.mjs tools/validate_development_docs.py`、`git diff --check` | 27 项编号、依赖、F／AC／Q、链接／表格及完整 diff 通过 |

初次联合回归发现两条旧清理用例仍在“未来 10 分钟”清理默认回执，因新默认 24 小时而失败；已将其清理时点对齐 24 小时，并保留显式短 TTL 的独立业务路径反例，不以删测试或跳过处理失败。

新增专项逐项核对四类草稿在 6 分钟／24 小时前最后 1ms 重放唯一 ID、精确到期建立新草稿、实际清理和非滑动截止。
后台开关回执到期后，旧 If-Match 被当前 revision 拒绝；失败无成功审计、占位释放，当前版本／新请求体可以重新使用到期键。
受控队列分别证明排队期间过期不重放旧成功、新写入得到完整保留期；未到期 pending 保持冲突／处理中状态，到期 pending 可重试。
缺失当前 scope 仍拒绝，即使普通回执未到期；审计数量与内容不受清理影响。
长窗口内同键异体仍冲突；已完成回执受到迟到／重复 release 时仍保留，之后重放不重复建立草稿。

用户本轮授权多路 DSH HY3 子程序辅助。两个独立目录／临时模型覆盖并行生成反例清单和 PR 草稿，禁用 17 个工具插件，无工具事件，未提供源文件、真实数据或业务凭据；宿主默认配置／认证未改。
起初显式 low／high 均被桥接层拒绝，错误为 `UNSUPPORTED_REASONING_EFFORT`；移除显式档位、使用 HY3 默认参数后两路成功，耗时分别约 103.8 秒和 38.7 秒，含启动及模型调用，不声称整轮净提速。
作者核对模型输出：当前过期扫描与 produce 共用同一串行临界区，不能采用“跳过所有未完成占位”的泛化建议；时钟回拨策略未由本轮新增。根据建议补长窗口内冲突及迟到释放回归，并更新草稿中的最终实测数量，模型输出不算测试通过或独立批复。

## 兼容、回滚与剩余

无迁移或冻结接口变更，无后台 HTTP 装配／页面／业务实现变更；只处理已合共享幂等外壳与默认值。
新记录默认 24 小时，已有记录不追溯延长；显式测试 TTL 覆盖保留。回滚恢复旧代码，不重写已存在的 expiresAt。
服务仍为内存实现，重启会丢失台账；未新增真实 PG 持久化、崩溃租约回收、后台 HTTP／UI、真实身份或部署验收。
原全局串行队列仍可能被异步作业端口阻塞，本轮未改分片／超时设计。
原已完成回执正文重放策略仍保留，本轮不宣称所有当前可见性重投影、键域或生命周期协议已完成。
待合 #113 认证／四类任务默认值独立，本轮不依赖其合并；#110 后台装配及其他写手范围保留。
整项 #1／#18 继续开放，无新增真实付费业务验证或部署。

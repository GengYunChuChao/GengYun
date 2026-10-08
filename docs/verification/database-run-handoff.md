# 数据库组件运行交接（2026-10-08）

Refs #3/#27。本页汇总已合组件与既有重放入口，不新增实现、部署或整项验收。
2026-10-08 香港时间16:14核对远端：main=`5c54dd53770e1a6465e7185a7e0f98c6fe735234`；
#3/#27仍open，PR54原P2线程已由监工解除。旧验证页的“待审”、当时环境缺项及截止
属于提交时的历史记录；最终状态以本表的固定SHA批复为准，不改写历史实测。

## 已合组件与证据

| PR／范围 | 最终reviewed_sha | squash提交／正式独立批复 | 运行入口 |
| --- | --- | --- | --- |
| #51：单次字节快照与0004原表未审核暂存 | `2baedd1afbc90bb0f5f592c24eaa6fa13934d01d` | `2846c34e634716523d07913cd5cfe10d695a16e9`；[批复](https://github.com/Sek1ro-oka/GengYun/pull/51#pullrequestreview-5449910941) | [暂存设计及旧SQL模式](../architecture/workbook-staging-design.md) |
| #52：0005公共科普预览与内部登记证据受限查询 | `c47dc5306179f2979616726fb29d01b0fdde8a85` | `9d1fc687e72706e86e945063324fbf0d85618b46`；[批复](https://github.com/Sek1ro-oka/GengYun/pull/52#pullrequestreview-5450061177) | [API→PG、读者角色和重放](gy-i25-catalog-pg.md) |
| #53：0006来源撤回／精确关联恢复与持久操作审计 | `1bd02e15a926dfe46794b78840974e233278e12b` | `dff3f8c9055b4368aca029d8801da6de3c8e763a`；[批复](https://github.com/Sek1ro-oka/GengYun/pull/53#pullrequestreview-5450372614) | [来源CLI、幂等和恢复前置](gy-i25-source-lifecycle.md) |
| #54：0007受限直接暂存导入／精确本批次回滚 | `46ce28ed8ef98be3a99c5e3c3ee8ec7812342e89` | `5c54dd53770e1a6465e7185a7e0f98c6fe735234`；[批复](https://github.com/Sek1ro-oka/GengYun/pull/54#pullrequestreview-5453598238) | [合成XLSX导入、重入与回滚](gy-i25-staging-intake.md) |

0004原始暂存保持unknown/unverified/card_ready=false。历史本地116行含96汇总资料行，
不是96份完整核准标签；本轮没有重读原工作簿、上传私密输出或提升资料。
0005公开HTTP仅`GET /api/v1/public/home`，最多10条科普摘要；登记制剂映射只在内部
repository，无药剂/raw HTTP端点。20条不完整公开记录、2条模拟与暂存不形成可用DoseCard，当前DoseCard=0。

作者本机、CI与监工证据分别使用：

- 作者：#52/#53/#54在自有Windows便携PostgreSQL17.11、真实低权限LOGIN及合成数据上验证；#51早期原表执行为PGlite内存证据，不冒充本机PG17。
- CI：各PR固定SHA的独立postgres:17.11合成工作流。#54最终[intake run37746340423](https://github.com/Sek1ro-oka/GengYun/actions/runs/37746340423)，job113208610473日志17.11、13组PASS，包含全行集合六类变更保留及并发插入外键23503；12项checks成功。
- 监工：独立离线检查与自己的PGlite0.5.8／内核18.3反例复验；#54仅将SHA256适配到内置函数，回滚正文未改。独立读取真实PG17.11 CI日志与自己运行PG17实库不同，不能互换来源。完整细节以各正式批复为准。

## 运行前置与权限

只在获准、全新、专用本机隔离数据库准备；测试所用固定角色名在同一PG集群中也须不存在。
角色引导遇已有角色明确失败，不能接管或删除其他使用者。管理员安全配置LOGIN及组成员，
迁移管理员、API读者、来源操作人和暂存操作人分别使用凭据；运行身份不继承executor。
秘密只从服务端私密环境或已有PGSERVICE/pgpass注入，不放argv、仓库、PR或输出；
psql不会自动读取DATABASE_URL。集成测试管理员身份仅建结构和合成夹具，不作为运行权限证明。

| 消费者 | 最小组／引导 | 边界 |
| --- | --- | --- |
| 公共科普／内部登记 | `gengyun_preview_reader`／`gengyun_evidence_reader`；[catalog_readers.sql](../../services/api/db/roles/catalog_readers.sql) | 两者分别只读对应投影，不授私有原表或暂存raw |
| 来源CLI | `gengyun_source_operator`；[source_operator.sql](../../services/api/db/roles/source_operator.sql) | 仅固定受控函数；executor为NOLOGIN，保存SESSION_USER操作审计 |
| 暂存CLI | `gengyun_staging_importer`；[staging_importer.sql](../../services/api/db/roles/staging_importer.sql) | 仅两个固定函数；没有raw/归属/审计直接读写权限 |

两个CLI使用DATABASE_URL：host仅localhost/127.0.0.1/::1；来源允许
gengyun_local或gengyun_source_ops_test，暂存允许gengyun_local或gengyun_staging_intake_test。
全部query/fragment在连接前拒绝，端口只能在URL authority，不能传host/port/service/SSL覆盖选项。
这是这两个CLI的限制，不是通用迁移运行器或所有API连接的全局网络守卫。
STAGING_PYTHON仅指定既有解释器；Python子进程不继承数据库/供应商秘密或PYTHONPATH。

## 迁移与重放入口

当前main上迁移按0001→0002→0004→0005→0006→0007排序，0003仍留独立隐私迁移，
不补占编号。后续main若新增迁移，先重新核对发现列表及依赖，不据本快照跳过待应用项。
0007要求专用库尚未安装pgcrypto，由迁移管理员安装在自身schema；已有扩展时失败，不接管。
角色引导是迁移后一次性管理员操作，不在上迁移扫描中。现有组件测试分别选择自身依赖，
没有将“同一库全组件安装、正式应用启动”写成已验证交付。

```powershell
# 仓库根，Node24.16.0；list不连接数据库。
node services/api/src/db/migrate.ts list
# 获准新专用库、迁移管理员DATABASE_URL已私密注入时才执行：
node services/api/src/db/migrate.ts up
# 之后按所需消费者的上表引导；psql已有私密PGSERVICE/pgpass配置。
```

0002/0004自带BEGIN/COMMIT，既有运行器外层事务与其嵌套的问题未在本轮改写；
成功重放和0005/新合成失败迁移的事务证据，不证明旧迁移台账失败时也整体原子回滚。
正式real入口仍要求既有完整服务端配置；测试直接装配API并不证明正式启动、云库或HTTPS部署。

实际合成复现按下表先另建各自空库并私密注入管理员测试环境。脚本有新库/角色前置，
会执行故障注入和限定回滚，不能用于已有业务库；不要复用其他人的库或通过清空审计满足前置。
安装依赖采用已冻结锁文件；不读取真实原表，不追加供应商请求。

| 重放 | 专用库／私密环境 | 命令 |
| --- | --- | --- |
| 0004快照、重复SQL暂存与限定回滚 | gengyun_staging_test／STAGING_PG_TEST_URL | `node tests/integration/workbook-staging-pg.mjs` |
| API受限查询／20不完整种子／限定结构回滚 | gengyun_catalog_test／DATABASE_TEST_URL | `node tests/integration/catalog-pg.mjs` |
| 来源撤回／重复原ID／精确恢复／事务负例 | gengyun_source_ops_test／DATABASE_TEST_URL | `node tests/integration/source-lifecycle-pg.mjs` |
| 生成合成XLSX／导入／重复／本批次回滚／显式下一代／集合与并发负例 | gengyun_staging_intake_test／STAGING_INTAKE_TEST_URL | `node tests/integration/staging-intake-pg.mjs` |

获准合成资料的人工CLI步骤链接上表各运行入口：#53撤回与恢复需实际来源/版本、预期修订、
完整审核和有效期前置，#54取脱敏回执的batch/import ID及payload_hash，原ID原内容原LOGIN
重复只返回历史回执，不证明现在状态。断连结果未知时保留原ID核对/重试，不换ID猜测失败。
旧0004生成SQL模式与0007归属隔离，0007不能接管旧手工批次。

## 回滚、停止与未交付项

来源业务撤回/恢复、本工具拥有批次的业务回滚和结构down是三个不同动作。
0006/0007任何操作审计或归属留存时结构down拒绝AUDIT_ARCHIVE_REQUIRED并保留对象；
正常运维不删审计来通过down。审计归档另需授权及实现，本轮没有归档命令。
先停对应消费者，可撤函数EXECUTE保留审计；结构重放需重新授权和转函数所有权，不能再CREATE已有角色。
0004旧down与生成回滚也不能强制删除后来引用的资料。各限定down细节见原验证页。

集成finally关闭自己HTTP、连接和测试角色。独立便携实例按[已核对自有数据目录的启停步骤](gy-i25-catalog-pg.md)
停止；先确认绝对目录归本worktree，不停其他PG实例，不安装系统服务。作者本轮临时实例已停止。

#3/#27仍open；[最新#3批复](https://github.com/Sek1ro-oka/GengYun/issues/3#issuecomment-6055596972)
及[最新#27批复](https://github.com/Sek1ro-oka/GengYun/issues/27#issuecomment-6055597506)保留原门槛。
后续按依赖准备，不重新派发或变更issue：先取得20份独立完整核准标签、有效期/禁限用及八组科普
独立评估；再实现通用规范目录导入、完整冲突处理、审核发布与审计归档，并据核准资料验用量边界。
云数据库/合法HTTPS/正式real启动、Android与iOS联网录音及六类全面能力仍需受控验收；
用途撤回、注销在线7日/备份30日、第三方删除及实际消费者接线随独立隐私任务验收。
1260样例、表数量、CI成功和本地连通均不能替代这些验收。

本页只记录交接，历史供应商12请求、1.7224元保守预留/实际账单未知不变；本轮新调用、部署、支付均0。
本轮截止香港时间2026-10-08 17:00，未完成安全停止自有进程并保留待审状态，等待用户新指令。

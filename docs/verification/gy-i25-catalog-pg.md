# GY-I25 隔离 PostgreSQL 17.11 查询与交接

Refs #3 / #27。本增量从已审 main 的 0001/0002、连接池、Fastify 和契约 1.0.0 出发。
只接契约已有的 `GET /api/v1/public/home` 游客科普预览。登记证据查询仅为内部 repository，
没有药剂、staging 或知识详情 HTTP 端点。`human_review_state=under_construction` 保持。
PR #51 的原表暂存已在 `2846c34e634716523d07913cd5cfe10d695a16e9` 合入，本增量正常同步已审main。
0005的结构依赖仍仅0001/0002；集成测试另执行已审0004并验证暂存表拒绝读，不提交用户XLSX/私密配置。

## 数据库与字段边界

0005 在 `catalog_read` 建立三个 security-barrier 视图，依赖仅 0001/0002：

| 投影 | 来源与条件 | 暴露内容 |
| --- | --- | --- |
| `current_verified_sources` | current_version_id 必须匹配；valid + verified + 审核人/时间非空；来源日期未到期且已开始；DB 的 active_mode 与 database_connected 均为 real/true；real 模式的 accepts_* 必须允许该来源 | 来源版本、哈希、定位、URL；不直接给运行角色授权 |
| `home_species` | 上述来源 + species + published + 非空标题/正文 + 没有更高修订（更高隐藏/私有版本也阻断旧版） | knowledge_id、标题、最多500字符摘要、knowledge类型、来源类型 |
| `registration_evidence` | 上述来源 + 登记 valid + 已知且有效的起止日期；同登记号另一身份或 deferred/rejected formulations 导入冲突均阻断 | 登记/制剂/来源UUID、登记号、持有人、剂型、原样ingredients JSON、identity/content哈希、版本/定位/URL/日期 |

已有字段映射以 [原字段映射](../../db/samples/field-mapping.md) 为准。
本次合成样例沿用 `ingredients[{name,content_text,unit_text}]`，不增加浓度/剂量推断。
登记投影不含 applicability、dose_text、unit_text、card_ready，不能用来生成 DoseCard。
安全过滤发生在数据库视图中；运行角色不能改查询绕过到原表。

来源类型与执行模式仍分离。服务端 `APP_EXECUTION_MODE` 必须为 real 才查询；stub/preset_demo
返回契约 503，绝不把真实查询结果贴上演示标签。DB 仍为 stub、未连接标记、或 accepts_database=false
时不会放行 database 来源；默认种子策略不由 API 自动改写。真实空集合返回空 previews，
最多10条，按UUID稳定排序，一条 MVCC SELECT，无缓存；后续请求立即看到已提交失效/新修订。
真实查询采用已有连接池，服务端 statement_timeout=5s、驱动 query_timeout=6s；错误只输出固定契约信息。
SQLSTATE 57014 映射 PROVIDER_TIMEOUT，其余数据库异常 PROVIDER_UNAVAILABLE；不输出驱动原文/DSN。

## 角色与生命周期

`services/api/db/roles/catalog_readers.sql` 是管理员对**新建专用数据库**执行一次的引导，非迁移。
创建两个 NOLOGIN、无 superuser/createdb/createrole/replication/bypassrls 的组：
preview_reader 只 SELECT home_species；evidence_reader 只 SELECT registration_evidence。
撤销 PUBLIC 在该数据库的 CREATE/TEMP 和 public schema CREATE，以及 catalog_read 的默认权限。
已有生产数据库的角色/授权需单独核对，不能照搬该引导覆盖别人的权限；脚本角色已存在时失败，
不会自动接管旧角色。LOGIN身份由运维另配秘密，再授予恰当组，不把迁移所有者放到API中。
本连接池仅对应当前公共预览能力；后续会话/私有数据所需最小角色需随独立功能审查。

0005 不增加私有表 RLS/所有权业务，不代表 #45 隐私工作完成。这里用真实登录角色验证：
不能读 users/sessions/media/sources/source_versions/knowledge_versions/formulations，不能跨投影读，
不能写、永久/临时建表、建schema/role或 SET ROLE 迁移所有者。测试未用 superuser SET ROLE
冒充运行连接。公共未授组登录也不能读原表/投影。

回滚文件 `services/api/db/migrations/rollback/0005_catalog_read_views.down.sql` 只删除0005视图/schema
和对应迁移台账，不 CASCADE、不删资料基表或角色。先停相应消费者再以迁移所有者执行；
重新应用0005后需重新 GRANT 两个视图。组角色由运维在确认无其他使用者后独立撤销。
既有0002 SQL自带 BEGIN/COMMIT，本轮没有改其已审校验和：成功重放已验证；失败原子性证据
限于本轮由运行器管理事务的0005/合成失败迁移，不能据此承诺旧0002台账写入失败仍整体回滚。

## 本机实测与重放

2026-10-08，Windows便携 PostgreSQL **17.11**、Node **24.16.0**；数据库
`gengyun_catalog_test`，监听 `127.0.0.1:55431`。没有安装系统服务、修改全局PG或碰既有库。
EDB下载源为 `https://get.enterprisedb.com/postgresql/postgresql-17.11-5-windows-x64-binaries.zip`，
本地包SHA-256 `80379b2c04d51c30225532e0ae04509899141e9957ed096fe749d7fd9df8f82f`，
381531864字节。TLS校验保留；`vendorDigestVerified=false`，本地计算值不是供应商签名/摘要核对。
运行时、集群、随机owner凭据和日志只在忽略的 `.local/pg17-window`，未入Git。

重放需要已有隔离的17.11服务器和全新专用库。测试开始前强制 loopback、精确库名、
public 无表、五个测试角色不存在；不自动删除已有库/角色。管理员有创建角色/迁移权限，
`DATABASE_TEST_URL` 从安全配置注入，不在聊天/命令记录输出：

```powershell
# 在仓库根运行；DATABASE_TEST_URL 已从安全配置注入，指向全新 gengyun_catalog_test。
node tests/integration/catalog-pg.mjs
node --test tests/unit/public-home.test.mjs
npm run lint
npm run test:unit
npm run test:contract
npm run build
```

本机隔离实例启停（二进制/数据已安全准备，凭据不输出）：

```powershell
$taskPgRoot = Join-Path (Get-Location) '.local/pg17-window'
& (Join-Path $taskPgRoot 'runtime/pgsql/bin/pg_ctl.exe') -D (Join-Path $taskPgRoot 'data') -l (Join-Path $taskPgRoot 'server.log') -o '-h 127.0.0.1 -p 55431' -w start
# 创建专用测试库、从本机安全配置注入连接串后运行上面的集成测试。
# 结束或失败后只停止这个数据目录对应的实例：
& (Join-Path $taskPgRoot 'runtime/pgsql/bin/pg_ctl.exe') -D (Join-Path $taskPgRoot 'data') -m fast -w stop
```

集成测试 finally 关闭自己启动的HTTP/连接池、撤销本次创建的五个角色；独立PG实例由操作者停止。
测试库含合成/已提交公开种子，不含用户原表，重放应另建全新库，不能把测试脚本用于生产。
独立 CI 使用 postgres:17.11 的全新 service；固定SHA/run链接记录在PR正文，不拿本机日志替代CI或监工审查。
集成测试直接装配buildApp并明确设置real测试配置；正常服务入口的real配置加载仍要求全部既有
凭据，不放宽生产配置门槛。因此该实测是当前HTTP→PG组件验证，不是六类服务与正式环境启动验收。

## 验证矩阵与剩余项

| 场景 | 本机结果 | 证据 |
| --- | --- | --- |
| 0001/0002/0005真实执行、重复跳过、checksum drift拒绝、合成失败DDL及ledger回滚 | 通过 | `tests/integration/catalog-pg.mjs` 第1组 |
| 真实LOGIN最小权限、默认PUBLIC、私有原表/跨投影/写/DDL/TEMP/升权负例 | 通过 | 第2组 |
| 现有20条不完整公开登记 + 2条明确模拟，重复导入与按ID回滚 | 通过；可用登记证据0、DoseCard0 | 第3组；未修改种子审核/有效期 |
| 真HTTP→API→PG空集合/12条上限10、字段封套、来源/日期/审核/内容反例、旧隐藏版本、配置模式切换、失效即时过滤 | 通过 | 第4组；合成正例仅验证机制，不是实际内容审核 |
| 登记制剂/来源/哈希/ingredients映射，状态/日期缺失/身份及待解决冲突/注入/演示拒绝；失败导入保留此前行 | 通过 | 第5组；全合成登记正例 |
| 0005限定回滚保留基表，API503失败关闭 | 通过 | 第6组 |
| PR #51 字节快照/原表暂存 | 已独立审入main | reviewed_sha=2baedd1afbc90bb0f5f592c24eaa6fa13934d01d，审查记录仍单独保留 |
| 云/用户运行库与受控HTTPS部署 | 未接入 | 本机/CI隔离实库不等于生产部署 |
| 20份独立核准标签、完整有效期/禁限用/用量、8组科普和真实评估标注 | 未完成 | #3保持open，实际DoseCard=0 |
| 六类全面样例、双平台真机/录音、TTS听感、用途撤回/注销7/30日/第三方删除 | 未完成 | #27及隐私任务保持open |

本增量只交付查询/权限/数据追溯与回滚机制证据，#3/#27采用 Refs，不关闭整项。
原供应商12次调用和1.7224元保守预留维持，账单未知；本轮真实供应商调用0。

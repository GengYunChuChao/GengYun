# GY-I25 来源撤回与受控恢复

Refs #3/#27。基于已审main `9d1fc687e72706e86e945063324fbf0d85618b46`，
不改变0001/0002/0004/0005校验和或既有公共查询规则。范围只有本机隔离运维CLI，
没有管理HTTP、通用导入器、资料审核/提升、身份/隐私业务、生产连接或供应商请求。
用户窗口仍为2026-10-08香港时间13:06:23截止，不因本增量重新起算。

## 持久审计与恢复边界

现有 `catalog_source_update_events` 缺操作者、请求指纹、前后源修订和精确恢复关联，
所以0006新增 `catalog_ops.operations`，关联旧事件ID：操作ID主键、动作、真实数据库
SESSION_USER、完整结构化请求、来源/版本UUID、恢复父操作ID、前后状态快照、执行时间。
快照包含源修订/当前指针、有效状态、审核状态/人/时间、来源类型、哈希、版本号/定位/URL与有效日期。
恢复父操作唯一，记录只能经受控函数INSERT；运行角色不能改/删审计。

函数参数固定、无动态SQL，search_path=pg_catalog、TimeZone=UTC，表/类型全限定。
操作ID事务级锁串行化重复请求，来源与版本行锁加预期修订/有效状态/current指针CAS。
状态、递增修订、旧事件及新审计在同一事务提交。写审计失败时全部回滚。
相同操作ID、同请求、同登录者返回历史回执；不同内容/登录者拒绝。回执中的
resulting_*是**该操作的历史结果**，replayed=true不会重写现在状态；不得作为当前有效性证明。
断连结果不明时保持同一ID/参数重试，不能换新ID猜测已失败。驱动消息、SQL、DSN均不输出。

withdraw只处理确切当前版本及预期状态；已withdrawn拒绝。restore必须引用本工具
确切成功withdraw的ID和同一来源/版本，原状态必须valid，当前完整快照须与撤回后完全相同。
原事件还须是valid→withdrawn且未恢复；缺值/错事件、源修订/指针变化及后续撤回拒绝。
恢复时再检查审核已verified且人/时间齐备、已开始且未到期、非模拟。
unknown/expired/conflicting撤回后无法被工具变成valid；工具从不修改审核人/状态、类型、
正文/哈希/日期、标签或用量。恢复后公开与否仍由0005的资料模式、审核、日期、最新修订等过滤决定。

## 最小权限与安装

以迁移管理员在**新专用隔离数据库**执行迁移，再一次性执行：

```powershell
# DATABASE_URL从私密环境配置注入，此阶段仅迁移管理员连接。
node services/api/src/db/migrate.ts up
# psql另用已有PGSERVICE/pgpass安全配置；它不自动读取DATABASE_URL。
psql -v ON_ERROR_STOP=1 -f services/api/db/roles/source_operator.sql
```

引导创建NOLOGIN、非superuser/createdb/createrole/replication/bypassrls的executor与operator。
受控函数转给executor；仅它有必要来源列UPDATE、事件INSERT/reverted_at UPDATE和审计INSERT/SELECT。
转移所有权时暂授schema CREATE，随后撤销。operator只USAGE schema与EXECUTE这一函数，
没有executor成员资格、原表/审计SELECT或任何直接写权限。PUBLIC不获函数权限，其他公共/登记
读者不能执行它。撤销专用库PUBLIC CREATE/TEMP与public schema CREATE。
角色已存在时引导失败，不接管旧角色。LOGIN由管理员另行安全配置并仅授operator组；
运行CLI改用该LOGIN的DATABASE_URL，不能沿用迁移管理员。测试确实使用独立低权限LOGIN。
后续来源选择/预期修订由现有受限运维交接提供，本CLI不建立第二套登录/管理页面。

CLI仅允许localhost/127.0.0.1/::1和数据库gengyun_local或gengyun_source_ops_test；
连接URL不允许任何查询参数或片段，在创建连接池前拒绝；端口只能放在URL authority。
pg查询参数可覆盖host/port，还可读取SSL文件，因此本工具不透传这些选项。
不接受argv里的连接串、密钥或伪造actor。以下UUID为示例，须替换成获准隔离数据的实际ID：

```powershell
node tools/database/source-lifecycle.mjs --action withdraw --operation-id 00000000-0000-4000-8000-000000000101 --source-id 00000000-0000-4000-8000-000000000001 --source-version-id 00000000-0000-4000-8000-000000000002 --expected-revision 1 --expected-validity valid --reason "来源需撤回"
node tools/database/source-lifecycle.mjs --action restore --operation-id 00000000-0000-4000-8000-000000000102 --source-id 00000000-0000-4000-8000-000000000001 --source-version-id 00000000-0000-4000-8000-000000000002 --expected-revision 2 --expected-validity withdrawn --restores-operation-id 00000000-0000-4000-8000-000000000101 --reason "恢复同一已核对来源"
```

0006 down只在operations为空时允许，避免静默擦掉持久审计；非空返回AUDIT_ARCHIVE_REQUIRED
并保持结构/状态/审计。运维须另行获准归档后才可回滚结构，CLI不提供清审计命令。
测试删除本次全合成审计仅模拟已归档条件。down只删0006函数/表/schema/台账，
不恢复来源、不删旧事件、不动其他资料/批次/角色。停消费者后执行
`services/api/db/migrations/rollback/0006_source_lifecycle.down.sql`；角色生命周期另由运维处理。
应用回退可先撤EXECUTE停CLI，保留审计。重放结构后重新转函数所有权并授权，不能重复CREATE旧角色。

## 实际验证与重放

作者Windows便携PG **17.11**、Node24.16.0、127.0.0.1:55431，复用既有隔离运行时，
新增专用gengyun_source_ops_test；没有重装系统PG、碰已有库/原始Excel或云资源。
运行时TLS与供应商摘要限制沿用[上一增量记录](gy-i25-catalog-pg.md)。
集成开始拒绝非loopback/错库名/非空public或已存在测试角色；凭据随机生成且仅环境传递给CLI。
迁移管理员仅建结构/合成夹具/故障注入；操作经真实低权限LOGIN与受控函数，HTTP另用公共只读角色。
finally关闭自己HTTP/连接并撤测试角色；PG实例由操作者按既有专用数据目录停，不能停其他实例。

```powershell
# DATABASE_TEST_URL私密注入，目标为新建空gengyun_source_ops_test（管理员，仅测试准备）。
node tests/integration/source-lifecycle-pg.mjs
node --test tests/unit/source-lifecycle.test.mjs
npm run lint
npm run test:unit
npm run test:contract
npm run build
```

| 场景 | 作者本机结果 |
| --- | --- |
| 实际LOGIN/函数所有者最小权限；直接有效性/审核/类型/raw/私有/用量/DDL/TEMP/升权及其他读者绕过拒绝 | 通过 |
| CLI撤回→下一HTTP预览消失；审计actor/前后/理由；重复不增事件、异请求ID拒绝、精确恢复、后续撤回保护 | 通过 |
| 两个不同PG backend并发CAS只有一次生效；同ID并发一个执行一个回执；故障注入状态/事件/修订共同回滚 | 通过 |
| 未知/过期/冲突、自然到期、失审、新版本、哈希变化、错目标/事件/参数及事件缺失前态拒绝 | 通过 |
| CLI断连脱敏/actor伪造拒绝；非空审计阻止down，空审计限定down保留基表和旧事件 | 通过 |
| 独立pg参数解析复现旧host/port覆盖；六种合规目标解析一致；CLI覆盖参数在socket守卫下连接前拒绝 | 通过（离线，网络0） |

CI为独立postgres:17.11全合成服务；固定SHA/run及精确server_version由PR正文补实际结果。
作者本机、CI及监工独立证据分开，配置工作流不等于通过。

## 批复与未完成项

#52公共查询/权限已独立审入：[正式批复](https://github.com/Sek1ro-oka/GengYun/pull/52#pullrequestreview-5450061177)。
[当前#3批复](https://github.com/Sek1ro-oka/GengYun/issues/3#issuecomment-6049723047)、
[当前#27批复](https://github.com/Sek1ro-oka/GengYun/issues/27#issuecomment-6049723453)均完整核对。
[本PR初审P2](https://github.com/Sek1ro-oka/GengYun/pull/53#discussion_r4213663777)：
旧CLI标准URL校验遗漏pg的host/port查询覆盖，当前修订禁止所有查询参数/片段；
实际驱动只构造参数不连接，并用socket失败守卫验证实际CLI在任何连接前拒绝。
单元回归6组，修订后需新完整SHA、全套CI及监工独立复审；旧SHA的成功CI不代替。
本增量只补持久源操作审计/恢复命令，对应此前仅测试SQL/内存演示的操作缺口。
原表unknown/unverified/card_ready=false不变，20公开缺项记录与2模拟可用证据/DoseCard均0。
完整标签/八组科普评估、正式云DB/HTTPS/双手机/六类全面样例、#45隐私消费者仍未完成。
旧适配演示和证据报告仍是历史内存证明，不据本CLI宣告通用导入/所有冲突处理完成；
提交与修订前重读最新issue/PR正文、评论、行内、回复、线程与HEAD。供应商新增请求0，整项保持open。

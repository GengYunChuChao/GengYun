# GY-I25：本机未审核暂存直接入库

Refs #3/#27。接续已审0004/#51字节快照及#53连接守卫，不替代资料审核、
目录发布、生产数据库或用户隐私删除。当前实现仅合成XLSX→内部Python管道→
参数化受控函数→本机专用PG暂存。本轮未读取/修改真实原表，DoseCard仍0。

## 输入与快照

CLI只接受仓库`.local`内经realpath核对的`.xlsx`路径；不接受SQL、外部JSON、
任意actor、连接串或密码参数。复用`inspect_workbook`一次有界不可变字节读取，
文件SHA256与OOXML行来自同一份字节。原生成SQL模式及旧默认抽取行为保留。
内部模式限25MB原文件、100MB展开内容、10000非空行、100000单元格、8MB JSON；
子进程15秒截止，输出上限8MB。拒绝宏/外链、结构和表头漂移，公式不执行。

Python环境仅PATH/SystemRoot/WINDIR/TEMP/TMP及固定UTF-8/不写pycache；
不继承数据库、供应商、PYTHONPATH等父环境。stdout只由Node私下捕获，stderr丢弃，
CLI回执/错误不输出路径、原文、raw、SQL、DSN或密码。内部JSON标志只供此管道。
Node再检查对象字段、原行坐标/顺序/重复、汇总行数、raw SHA256、确定性UUIDv5批次、
原值映射及unknown/unverified/card_ready=false；数据库独立检查UUIDv5、实际raw哈希、
行主键/完整批次、未审状态。摘要绑定输入和历史，不是来源核准或第三方身份认证。

## 0007与最小权限

0004没有操作归属、完整内容摘要或重入世代，故0007仅追加私有`staging_intake`
批次元数据（操作人、文件哈希、映射版本、内容摘要、世代、导入ID及状态）和操作审计。
审计不含raw/文件名，回滚保留元数据及历史回执；0004及旧迁移校验和不改变。
UUIDv5的SHA1与行/请求SHA256在DB独立复算，使用PG自带可安装扩展pgcrypto。
0007只在专用库**尚未安装pgcrypto**时创建到自身schema；扩展已存在时明确失败，
不接管/移动既有扩展。安装由迁移管理员完成，运行LOGIN没有安装权限。

NOLOGIN `gengyun_staging_executor`只有两张0004暂存表的必要读/插入、目标批次删除、
锁所需列UPDATE和新元数据/审计最小权限；没有来源/用户/药剂权限。
NOLOGIN `gengyun_staging_importer`仅USAGE+两个受控函数EXECUTE，没有executor成员资格。
真实LOGIN只属于importer；不直接SELECT或写raw/批次/审计，不DDL/TEMP/升权。
函数SECURITY DEFINER固定pg_catalog/UTC，全限定静态SQL；PUBLIC/预览读者不可执行。
角色引导已存在时失败，不接管他人角色。不同LOGIN的同操作ID请求或回滚均拒绝。

连接校验复用#53已审实现，新增固定暂存profile只接受
localhost/127.0.0.1/::1与`gengyun_staging_intake_test`或`gengyun_local`。
source CLI原profile保持source_ops_test/local，新CLI不接source_ops_test。
一律在任何连接前拒绝全部query/fragment，不允许host/port/service/socket/SSL文件覆盖。
仅`DATABASE_URL`环境给Node；`STAGING_PYTHON`指定既有解释器位置，不经shell。

## 幂等、冲突、回滚与重新导入

同操作ID先取事务锁，随后锁批次。状态、0004完整批次/行、归属元数据和操作记录同事务。
同ID/同载荷/同LOGIN返回历史回执，不重新执行；不同载荷/LOGIN拒绝。
提取时间不参与内容比较；文件名、质量、raw、mapped、状态、原行顺序等均参与摘要。
新ID不能接管同一正在使用的批次，即使内容相同；应重试原ID。
已有手工/生成SQL导入的0004批次无工具归属，拒绝接管，不能靠ON CONFLICT吞掉冲突。

回滚必须指定batch/import ID/内容摘要，且与当前归属LOGIN及世代一致。
函数锁定该批次及行，重构全部当前内容比较摘要；内容/来源版本关联改变则拒绝。
回滚先比较实际全批行数，再用LEFT JOIN保留清单外工作表的所有实际行参与摘要；
不能用原工作表清单的INNER JOIN过滤当前数据。真实PG负例覆盖追加清单外行和
保持总行数的清单外替换：旧提交会误删，新实现拒绝并保留全部行、状态与审计。
每类负例使用独立合成批次并保留污染状态，不由管理员删除新增行后冒称正常回滚。
批次FOR UPDATE及行锁覆盖比较到删除：真实第二连接在比较完成后插行会被父行锁阻塞，
正常回滚提交后该插入因FK缺父批次失败，不会先插入后被悄悄级联删除。
回执row_count记录已实际核对的完整行数；旧历史回执继续保持原语义。
只删除该批次与其级联行，保留其他批次和不含raw的审计。重复原回滚ID返回原回执。
旧导入/回滚回执只是历史操作证明，**不承诺当前状态**，也不能重新写入或删除下一代。
已回滚批次重入需要新操作ID、`--previous-import-id`精确指向上一代导入、同LOGIN及同摘要；
世代递增，审计串保留。新内容意味着不同文件哈希/批次，不把变化静默覆盖旧批次。
超时/断连或缺回执时结果未确认，保留同一ID核对/重试，不自动生成新ID。

## 本机交接

先在专用空库用私密PGSERVICE/pgpass执行迁移运行器或既有迁移交接，
再执行`services/api/db/roles/staging_importer.sql`。psql不会读取DATABASE_URL。
管理员自行配置独立LOGIN并授importer组，切换Node环境到该低权限LOGIN；
管理员DSN仅用于建结构/合成测试夹具，不能用作实际CLI运行证明。
命令中的UUID/摘要为合成示例，工作簿须为获准合成文件，不包含个人资料。

```powershell
# DATABASE_URL私密注入；STAGING_PYTHON为已安装解释器，不在命令参数带密码。
node tools/database/staging-intake.mjs --action import --operation-id 00000000-0000-4000-8000-000000000101 --workbook .local/synthetic.xlsx
# batch-id和payload-hash取上次不含raw回执。
node tools/database/staging-intake.mjs --action rollback --operation-id 00000000-0000-4000-8000-000000000102 --batch-id 865a60d5-861d-5835-a347-07aad5f03a95 --import-id 00000000-0000-4000-8000-000000000101 --payload-hash aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
node tools/database/staging-intake.mjs --action import --operation-id 00000000-0000-4000-8000-000000000103 --workbook .local/synthetic.xlsx --previous-import-id 00000000-0000-4000-8000-000000000101
```

业务批次回滚不同于结构down。0007存在任何归属/审计时down返回AUDIT_ARCHIVE_REQUIRED，
保留全部对象/资料；不以CASCADE删审计。停CLI可先撤EXECUTE。
经另行授权归档后空down只删除0007函数、元数据/审计、自己新建扩展及schema/台账；
不删0004批次/行、0001/0002/0005/0006、来源或其他资料。没有审计归档命令。
空down后角色另行管理；重放需重新授权/转函数所有权，不能重复创建旧角色。

## 实际验证和剩余范围

作者Windows便携PG17.11、Node24.16.0，127.0.0.1:55431新专用intake库；
复用自有便携实例，没有安装系统服务或碰其他库/原表。测试生成非个人合成XLSX，
真实LOGIN执行CLI，预览另用真实只读LOGIN及真实HTTP。

| 场景 | 作者本机结果 |
| --- | --- |
| 实际LOGIN/受控owner；raw/私有/审计读写、DDL/TEMP/升权及PUBLIC/预览调用拒绝 | 通过 |
| 合成XLSX字节哈希→环境隔离Python→真实CLI入库；未审状态、幂等、HTTP不泄raw | 通过 |
| DB重算UUIDv5/raw SHA256；结构/重复/不完整/异内容/异actor/旧批次拒绝 | 通过 |
| 两个不同PG backend同ID一写一回执、异ID一成功一冲突；中间行/审计失败使导入与回滚全事务保留原态 | 通过 |
| 精确回滚；清单内/外追加、缺行、等数清单外替换、坐标和raw变化拒绝，逐项保留批次/全部行/世代/审计 | 通过 |
| 实际两连接：全行比较后回滚保持父/行锁，后来插入不能逃逸后被级联误删；正常与历史/新世代语义 | 通过 |
| 参数/文件/行数/JSON大小限制；非空down拒绝、空down保留0004及基础表 | 通过 |

重放：`node --test tests/unit/staging-intake.test.mjs`；
`STAGING_INTAKE_TEST_URL`安全环境指向全新空专用库，运行
`node tests/integration/staging-intake-pg.mjs`；另运行既有lint/build/unit/contract/docs。
集成创建和撤销自己的测试角色；本机实例按核对后的自有目录启停，不停其他实例。
CI使用独立postgres:17.11及全合成数据，精确当前SHA/run/version/PASS由PR正文填写，
作者、CI、监工证据分开；配置工作流不等于已通过，监工独立复审尚待。

已审基线：[PR53正式复审](https://github.com/Sek1ro-oka/GengYun/pull/53#pullrequestreview-5450372614)，
[当前#3批复](https://github.com/Sek1ro-oka/GengYun/issues/3#issuecomment-6050345566)，
[当前#27批复](https://github.com/Sek1ro-oka/GengYun/issues/27#issuecomment-6050345879)。
[PR54原P2](https://github.com/Sek1ro-oka/GengYun/pull/54#discussion_r4216227681)：
作者已用真实PG17.11重放reviewed_sha=40fcf6653e3321fbbccec0a6903a53809186cc32的0007，
正常对照和清单内新增拒绝通过，清单外新增却未拒绝（同负例测试退出1）。新实现全部13组PASS。
监工此前PGlite18.3适配反例、作者原生17.11、新SHA CI及最终独立复审分开记录，不互相替代。
启动/修订前完整核对正文、评论、review、行内/回复/线程及完整SHA。
仅完成暂存入库机制，不完成通用导入/审核发布/完整标签/八组评估/云DB/HTTPS/双手机/
六类全面能力/#45隐私消费者；旧96暂存及20缺项资料不读不提升，整#3/#27保持open。
新增AI/供应商/外部DB/部署/支付0，用户最新授权截止2026-10-08香港17:00，到期未完停止等待。

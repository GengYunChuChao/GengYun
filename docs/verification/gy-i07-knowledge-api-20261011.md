# GY-I07 科普查询服务端组件验证

Refs #7，基线 main `487918856a0099d6c7ee5f083069bd415b095bee`。这是两个已冻结用户鉴权接口的部分交付，不关闭整项。未接入真实核准资料、真实微信身份、Android 页面或 herbicides 查询，不产生用量卡。

## 接口和数据边界

`GET /api/v1/knowledge` 与 `GET /api/v1/knowledge/{id}` 接受冻结字段，无额外 source_version 字段。列表的 Knowledge 实体与同一时点详情一致，详情返回资源 revision 的强 ETag，均 no-store。未配置数据库返回503；实际无合格资料返回真实空列表，不回退静态种子。

来源 id 是真实 sources.id，version 是其 current_version_id 对应 source_versions.version；updated_at 映射该版本 retrieved_at，表示来源取得时间，与 packages/reference/records.mjs 的既有 retrieved_at 分支一致，不使用请求时间冒充更新。内容或来源变更应以新不可变版本发布，接口每次重新读取当前关联，不缓存旧 SourceRef。

0010 新视图只消费既有 current_verified_sources：real 数据集开关、连接声明、允许的 database/verified_seed、当前版本、valid、verified、真实复核记录和有效时间同时满足。仅最新且 published 的知识版本可读；更新后的 hidden/private/deleted 版本阻止回退旧公开正文。字段缺失、超长正文、非 HTTPS 来源及不正确目录数组类型退出查询。没有自动审批、来源研究候选提升或模拟资料生产导入。

当前知识表只有 crop_ids/species_ids/region_codes，因此这些筛选按显式数组成员匹配，空数组不被解释为全地区适用。完整 Conditions 未存储，返回 null；growth_stage/planting_method/use_scene 任一指定而没有证据时，列表为空、详情404，不丢弃该条件继续展示。dose_cards 始终[]，不从科普正文推断登记制剂用量。

游标 HMAC 绑定用户、全部查询条件、id_asc、15分钟时限及完整当前有效投影的水位（正文、目录、来源版本/哈希/复核/有效期/来源revision）。撤回、更新、来源失效或集合变化后旧游标400 INVALID_CURSOR。分页可改变 limit，不能跨用户、篡改或换条件。读取语义线性化于资料 SELECT 的 PostgreSQL statement snapshot；其后提交的并发撤回可能与该次读重叠，下一次请求必重查，不声称所有异步竞态或实时撤回推送均已解决。

## 权限交接

迁移 owner 执行0010；另执行 services/api/db/roles/knowledge_runtime.sql 创建 NOLOGIN 最小组。独立 API LOGIN 组合既有 gengyun_auth_privacy 与 gengyun_knowledge_runtime；后者仅 USAGE catalog_read 和 SELECT current_knowledge。不授 sources/source_versions/knowledge_versions 基表读写，不授 DDL、角色管理、资料删除或审核发布。账号和会话锁使用原 auth_privacy 已审逐列权限，组不是客户端SQL登录或逐用户RLS。

现有 local-dev 引导白名单仍没有该组，此 PR 不更改它；后续接线应按已审成员链规则单独进行，不将 API 改成 owner。未经组合会返回503，不宣称已接入生产数据库。回滚只 DROP 新视图，保留来源与资料；运行角色的显式清理是独立运维操作。

## 实际验证

2026-10-11，Windows，Node24.16.0。合成正文、source审核人、资料状态、身份全部仅在隔离测试库，用 example.invalid 地址，不是批准的生产资料。

- `node --test tests/unit/knowledge-api.test.mjs tests/unit/profile-api.test.mjs tests/contract/*.test.mjs`：24项，23通过、1明确跳过（原生并发边界）；失败0。PGlite只有串行 SET ROLE，不冒充 LOGIN 或多连接验证。
- 原生 PostgreSQL17.11：相同 knowledge-api 测试9/9通过、跳过0，真实回环HTTP、独立非owner LOGIN、SCRAM随机密码。单独 owner 仅迁移和合成夹具；current_user/LOGIN属性和五项高权标志有断言。
- 来源撤回在账号/会话锁之后、正文读取之前，由另一真实连接提交：详情404。账号暂停在鉴权middleware之后、事务账号锁之前提交：ACCOUNT_INACTIVE。来源版本替换、最新隐藏资料、未来/过期/未审核/撤回/模拟/缺字段均排除；无资料/无数据库、游标主体/条件/签名/水位、退出旧会话均真实HTTP验证。
- 限权SQL读取私有知识正文/来源原表/媒体对象字段、删除知识、修改账号state、建表、CREATE ROLE、SET ROLE迁移owner均42501；组只允许公开投影视图。PGlite不验证 session_user 角色切换，原生 LOGIN 专门完成此项。
- lint（含API/admin typecheck及卫生检查）、API tsc build、docs验证和 git diff --check 通过。
- 新迁移加入后完整既有单元集合：641项，640通过、失败0、1明确原生边界跳过；不是用该串行跳过代替上述原生9/9。

原生cluster目录为自己clone的 `.local/knowledge-pg/data`（Git忽略），回环55472，postmaster PID65716。只执行外部PG17 bin，不访问其旧data或凭据。随机凭据在自己private/config.json，未输出或提交。测试后已按核对过的绝对datadir停止自己cluster，55472无监听，测试数据保留。首先测试错误媒体字段及不存在角色导致的失败已修为真实字段；最终验证结果如上，没有将失败记通过。

复验入口为 tests/unit/knowledge-api.test.mjs：默认新 PGlite。原生模式仅显式设置 GY_KNOWLEDGE_TEST_OWNER_URL 到自己新初始化回环cluster的空 `gy_i07_test_*` 数据库，fixture检查无既有public表；角色引导也要求该隔离cluster无同名组。fixture owner仅创建表/角色/合成资料，自动生成runtime随机密码并在内存连接，API用独立LOGIN。不要传生产URL或将别人的cluster作为测试环境。

## 未验证和后续

真实资料审批、用户端HTTP消费/微信工具/Android、herbicides和条件完整元数据仍待各自组件与整项验收；本轮原生身份为明确标注的微信替身，没有供应商调用、付费或部署。独立监工仍需绑定最终提交SHA复验与核对CI。

## PR79 CI 断言修订

监工 review5482050707、已审HEAD `0a72820be794f3da25d3f9178028a0ec14ba737d`：catalog-postgres-17.11 失败，实际日志运行38111910049在 catalog-pg.mjs:118 为401 !=404。旧测试仍假定知识路由未装配；其余13项CI成功。这不是身份失效，也没有通过移除 requireUser 修复。

本轮仅同步 tests/integration/catalog-pg.mjs：知识列表与详情的无登录请求必须401 SESSION_REQUIRED；尚未装配的 herbicides 列表/详情、staging、registrations仍404。保留迁移重入/漂移/失败回滚、受限真实LOGIN/PUBLIC/私有表/跨视图/写/DDL/TEMP/owner升级拒绝、未批准种子排除、source生命周期与登记证据以及0005回滚等全部原断言。

实际执行与 .github/workflows/catalog-postgres.yml 相同入口 `node tests/integration/catalog-pg.mjs`，DATABASE_TEST_URL 仅在内存指向自己PG17.11隔离cluster新空 gengyun_catalog_test 库，六组PASS、退出0。实际运行身份是独立随机密码 preview/evidence LOGIN，API不是owner；所有资料synthetic或保留未核状态的公开种子。未在该preview专用库伪造知识授权角色。有效身份空列表/无数据库503/knowledge_runtime私有表权限的既有 knowledge-api 回归保留，affected+contract重跑24项23通过、1原生专项明确跳过；上轮独立knowledge限权LOGIN9/9证据复用（service/views/roles本轮未变），不能把它替代本次实际catalog入口。

本轮docs与diff通过，自己cluster启动PID43464已按绝对datadir停止，55472关闭。CI修订后的远端结果仍待维护者允许运行与监工复验，不自批、合并或将本地PASS写成CI成功。local-dev新组接线、前后端/320px/Android、herbicides与整项#7验收仍未完成。

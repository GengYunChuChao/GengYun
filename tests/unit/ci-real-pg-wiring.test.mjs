// GY-I12／GY-I15 真库臂接线守卫：把「脚本在 main 上、却没有任何 workflow 跑过」变成结构性红
//
// 缺口（本片实测，基线 `df043a7`）：
//   `tests/integration/conversations-pg.mjs`（#313）与 `tests/integration/community-pg.mjs`（#296）都在 main，
//   但逐 workflow 检索文件名 **0 命中**——11 个 workflow 谁都不跑它们。于是「真库臂」只存在于本机，
//   CI 上无论它们坏成什么样都不会红。本测试把这条缺口变成会红的断言。
//
// 判类口径（刻意收窄）：只认下面 `MANAGED_SCRIPTS` 里登记的那几条——它们**只有真库臂**，没有可替代的替身/内存臂，
// 因此「某个 workflow 的 `run:` 行里出现它」就是唯一有意义的接线证明。其它 `-pg.mjs` 各有自己的
// workflow 或已在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 里
// 逐条声明（本文件不重复判它们，也不动那张表）。
//
// 九条判据（每条都有对应反向控制，且反向控制与正向断言**调用同一个**函数）：
//   ① 受管脚本必须出现在某个 `.github/workflows/*.yml` 的 `run:` **命令文本**里
//      （不认注释、不认裸文件名；`run: |` 块标量体里的 `#` 行是 shell 注释，同样不认）；
//   ② 任何 workflow 都不得含「放宽跳过」的开关（`GY_ALLOW_SKIP` / `--allow-skip`）——
//      真库没跑起来必须以 77 红掉，不得被写成绿（口径见 `.pg17/ruling-skip-exit-code-20261020.md`）；
//   ③ **真跑受管脚本的那个 job** 必须真的有 `services.postgres`，且镜像主版本锚定 **17**
//      （防降级到 16 / 防删 service；作用域锚定到 job，⛔ 不看「文件里第一个 `services:`」——
//      前置诱饵 job 就能把那种实现骗成绿）；
//      作用域边界（裁定）：**不跑受管脚本的 job 不在范围内**——它不跑脚本，坏镜像不构成真实风险；
//      因此把两个脚本拆成两个 job 仍必须绿（判据本来就是 job 作用域的），而诱饵自己的镜像坏了不报。
//   ④ 该 workflow 的每个 `uses:` 必须固定到 **40 位 SHA**（⛔ 不许写浮标签；口径与仓内其它 workflow 一致）；
//   ⑤ 该 workflow 不得含「吞红」构造（`continue-on-error` / `if:` / 行尾 `|| true`）——
//      真库臂的红是唯一验收信号，吞掉它就等于没有闸门。
//   ⑥ **顺序**：受管脚本在 workflow 里的执行顺序必须与 `REQUIRED_STEP_ORDER` 显式声明一致
//      （R28-S18 新增。为什么是硬要求：`admin-accounts-read-pg.mjs` 会在**集群级**留下 6 个组角色
//      ＋ 运行时角色，而 `account-suspend-pg.mjs` 的 `resetRoles()` 只清得掉「没有被跨库 ACL／成员关系
//      钉住」的角色；`account-deletion-pg.mjs` 又要求角色不存在、收尾按快照差集清空 ⇒ 这类脚本的重排
//      会让真 CI 红得莫名其妙，而此前守卫对重排**零断言**）；
//   ⑦ **建库**：每个受管脚本所在 step 的 `run:` 必须同时含 `CREATE DATABASE` 与
//      `node tests/integration/<脚本>`，且 `CREATE DATABASE` 在其之前
//      （每条受管脚本都要求**空库**，共用/漏建库会让脚本报错或 77 退出）；
//   ⑧ **库名一致**：该 step 里 `CREATE DATABASE <name>` 的 `<name>` 必须与该 step 真正传给脚本的库名
//      一致——脚本入参有三种形态（env `*_PG_TEST_URL` 的 path／`process.argv` 的 URL path／
//      脚本内部硬钉常量），三种都要各自抽取并互相一致（只覆盖一种会留下「改了 env 但 argv 还是旧库」
//      这类假绿通道）；
//   ⑨ **双向相等**：workflow 里被 `node tests/integration/*-pg.mjs`（含 R28-S65 起的 `*-e2e.mjs`）
//      执行的脚本集合与 `MANAGED_SCRIPTS` 必须**双向相等**（此前只有单向：清单里有、workflow 没有 ⇒ 红；
//      反过来「双清单同时删掉一项」⇒ 全绿，受管脚本照样没人跑）。
//
// 纯静态：只读 `.github/workflows/` 下的文本，⛔ 不起服务、不连 PG、不联网、不写任何文件、不新增依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 process.cwd()。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = '.github/workflows';
const REAL_PG_WORKFLOW = `${WORKFLOW_DIR}/real-pg-integration.yml`;

/**
 * 受管脚本清单：这几条**只能**用真库证明（没有替身臂可以替代），故必须被某个 workflow 真跑。
 * 增删任何一条＝放宽或收紧门禁，必须同时改 `FROZEN_MANAGED_SCRIPTS` 并更新证据页——刻意留 diff。
 * 前两条是 #314 接的（会话链／社区域），中间两条是 R27-S4 接的（消息域／收藏历史，同一条 workflow），
 * 后三条是 R28-S14 接的（账号注销／后台账号读取／全局开关，同一条 workflow），
 * 第 8 条是 R28-S17 接的（标签 OCR 域／迁移 0024，同一条 workflow；它跑**全链迁移**，故顺带守住迁移清单不变量）。
 * 第 9 条是 R28-S36 接的（识别域持久化／迁移 0025，同一条 workflow；它要求**空库**并自己 apply「除 0025 外全部 → 0025」，
 * 顺带断言迁移清单连续无缺号、总数 === 最大编号）。
 * 第 10 条是 R28-S39 接的（账号停用/恢复域 I22，同一条 workflow；它要求**空库**、自己 apply 0001–0017
 * 并把 0017 单独跑 UP/ROLLBACK/REPLAY 三连；argv 只给 owner URL，运行时角色它自建并派生 URL；
 * scram 缺陷由 R28-S15 修掉，见 `docs/verification/gy-r28-account-suspend-scram-20261020.md`）。
 * 第 11 条是 R28-S40 接的（语音转写域／迁移 0026，同一条 workflow；它同样跑**全链迁移**并做 0026 的
 * UP／ROLLBACK／REPLAY，故也顺带守住迁移清单不变量）。
 * 另起 17.11 集群（CI 里只有容器内的 17.11）。见证据页
 * `docs/verification/gy-r28-real-pg-wiring-3-20261020.md` 的「不接的两条」。
 * 第 12 条是 R28-W12 接的（媒体持久化 `media-persistence-pg.mjs`／#6／#16：媒体域从进程内登记册
 * 切到 PG 仓储 + `object_ref_cipher` 键接线 + 幂等落库）。它要求**空库**（硬钉 `gengyun_media_test`）、
 * 判据同第 11 条：自己 `applyMigrations(discoverMigrations())` 跑**全链 26 个迁移**，然后跑
 * 三段式上传／owner 逐字节读／非 owner `NOT_FOUND`／同键重复 complete 行数不变／**子进程真重启**后
 * 同一 uploadId 仍可读／缺 `MEDIA_OBJECT_REF_KEY` 时媒体域整域 503（fail-closed）／空仓储负控制，
 * 全程库 owner 连接、不建组角色 ⇒ 对前后脚本零耦合。
 * 第 13 条是 R28-S49 接的（备份副本域 GY-I19／迁移 0023 的 apply→rollback→replay 三连 + 注销受理在**同一事务**
 * 里写清单 + 30 天保留窗口到期清除）：它是清单里**唯一**的「自起集群」脚本——只连自己 `initdb` 出来的临时
 * 17 集群（脚本 `:89` 端口 55500+randomInt(0,500)、只监听 127.0.0.1、跑完自删数据目录），**不**连
 * `services.postgres` 的那个库，因此它的 step **没有** `CREATE DATABASE`。判据⑦⑧ 对这类脚本换成
 * `SELF_CLUSTERED_SCRIPTS` 那组等价判据（必须给 `GY_PG_BIN`／**该脚本自己读的** `GY_*_PG_ROOT`，且⛔ 不得
 * 出现 `CREATE DATABASE`；键名按脚本映射，见 `SELF_CLUSTERED_ROOT_KEY`）。
 * 早先 R28-S14 判它接不了，是因为 runner 上取不到 `initdb`/`pg_ctl`（`postgres:17.11` 只在容器内）；
 * R28-S49 改成先一步用 PGDG apt 装 `postgresql-17` 再跑，见
 * `docs/verification/gy-r28-backup-purge-ci-20261021.md` 与 `docs/verification/gy-r28-real-pg-wiring-3-20261020.md`。
 * 第 14 条是 R28-E5 接的（备份副本 30 日到期**清除驱动** `backup-copies-purge-pg.mjs`，`#398` 合入的脚本）：
 * 它与第 13 条**同类**（自起集群、只连自己 `initdb` 出来的临时 17 集群、跑完 `pg_ctl stop` 并删数据目录），
 * 因此判据⑦⑧ 走同一套 `SELF_CLUSTERED_SCRIPTS` 等价判据（必须给 `GY_PG_BIN`／**它自己读的**根键、
 * ⛔ 不得出现 `CREATE DATABASE`）；**装包 step 不重复**——它复用第 13 条那一步装的
 * `/usr/lib/postgresql/17/bin`。缺 `GY_PG_BIN` 时脚本 exit 77 ⇒ 装包/路径没弄好必红，⛔ 不是通过。
 * 见 `docs/verification/gy-r28-e5-backup-driver-ci-20261021.md`。
 * 第 15 条是 R29-W13 接的（`messages-purge-pg.mjs`，`#405`／W11 的注销**行数**脚本）：与第 13/14 条同类的
 * 自起集群脚本，唯一差别是它读的数据根目录键是 `GY_W11_PG_ROOT`（不是 `GY_I19_PG_ROOT`；键名按脚本映射，
 * 见 `SELF_CLUSTERED_ROOT_KEY`，给错键只会多一条装饰性 env 而脚本照样落 `os.tmpdir()`）。
 * 第 16 条是 R28-S65 接的（识别**端到端链路** `recognition-chain-e2e.mjs`／迁移 0001+0018 的**子集**）：
 * 它是清单里**唯一**文件名不叫 `-pg.mjs` 的脚本（`-e2e.mjs`），因此 `scriptsRunByWorkflow()` 的识别口径
 * 从「只认 `-pg.mjs`」放宽到「`-pg.mjs` 或 `-e2e.mjs`」——这不是放宽**断言**，而是放宽**被识别的脚本口径**，
 * 判据⑨的双向相等一个字没动（少了它这条脚本永远进不了判据⑨，加进清单只会变成永久假红）。
 * 它要求**空库**、只走 env `RECOGNITION_CHAIN_PG_TEST_URL`（库 owner），内部起 loopback 真 HTTP，
 * 且缺 env 时 exit 77 ⇒ step 里必须把 77 显式升级成硬失败（见 workflow 该 step 与
 * `docs/verification/gy-r28-recognition-chain-ci-20261021.md`）。
 * `/usr/lib/postgresql/17/bin`。缺 `GY_PG_BIN` 时脚本 exit 77 ⇒ 装包/路径没弄好必红，⛔ 不是通过。
 * 见 `docs/verification/gy-r28-e5-backup-driver-ci-20261021.md`。
 * 第 15 条是 R29-S13 接的（`community-filter-pg.mjs`／#15 的**筛选**真库读数：`GET /posts` 的
 * `crop_id`/`region_code`/`mine` 三类筛选逐条与同条件 SELECT 对照、游标绑定筛选集、参数闭集 400、
 * 「筛选未下推 SQL」的语句读数与 `community_posts_feed_idx` 的 EXPLAIN 读数；另有举报 `state`
 * 恒 `received` 的**缺口登记**）。它要求空库、只走 env `COMMUNITY_FILTER_PG_TEST_URL`（库 owner），
 * 缺 env 时 exit 77 ⇒ 与第 2 条同一形态；见 `docs/verification/gy-r29-i15-community-filter-20261022.md`。
 * 第 17 条是 R32 接的（`online-purge-pg.mjs`／`#19` 的**在线数据 7 日到期执行者**）：与第 13/14 条同类的
 * 自起集群脚本（`GY_PG_BIN` + `GY_I19_PG_ROOT`，⛔ 无 `CREATE DATABASE`）。它此前**不在任何 workflow** ——
 * 驱动 `services/api/src/privacy/online-purge-driver.ts` 与运维命令 `tools/purge-expired-online-data.mjs`
 * 早在 main，但「7 日到期」这条保证在 CI 上从未被真库验证过；这正是本片要补的那条缺口（与第 1 条同族）。
 * 第 18 条是 R34 接的（`message-events-pg.mjs`／`#17` 的**社区事件 → 消息域**真库臂）：它补的是另一个
 * 「有实现、有单元层、但真库上从未跑过」的缺口 —— `services/api/src/community/events.ts` 的
 * `createMessagesCommunityEventsPort`/`communityEventKey`/`communityEventMessageType` 只有**内存 store**
 * 的单元证据（`tests/unit/community-message-notifications.test.mjs`），而 `messages-pg.mjs` 手工调
 * `appendMessage`（不经社区）、`community-pg.mjs` 只看社区内容落库（不看消息域）⇒「社区事件真的落到
 * `public.messages`、靠唯一键去重、失败不拖垮内容写入、进程内状态清空后仍能读回未读/已读」这条链
 * 在真库上是空白。判据形态与第 3 条（`messages-pg`）**同形**（自建专用空库 + argv[2] 连接串 +
 * 全程库 owner），因此不需要任何新豁免；它不影响 #17 的页面端到端（那部分仍未取得）。
 */
const MANAGED_SCRIPTS = Object.freeze([
  'tests/integration/conversations-pg.mjs',
  'tests/integration/community-pg.mjs',
  'tests/integration/community-filter-pg.mjs',
  'tests/integration/qa-citations-pg.mjs',
  'tests/integration/messages-pg.mjs',
  // R34：`message-events-pg.mjs`（#17 的「社区事件 → 消息域」真库臂）。**紧挨着 `messages-pg`** 插入：
  // 两者是同一条「消息域落库」链的两面（自己写 vs 经社区事件投递进来），并排读最省事；
  // ⛔ 不追加到清单末尾——那里紧邻 admin 域条目，会与另一个切片的清单追加互相冲突。
  'tests/integration/message-events-pg.mjs',
  'tests/integration/favorites-history-pg.mjs',
  'tests/integration/account-deletion-pg.mjs',
  'tests/integration/admin-jobs-pg.mjs',
  'tests/integration/admin-accounts-read-pg.mjs',
  'tests/integration/admin-flags-pg.mjs',
  'tests/integration/ocr-jobs-pg.mjs',
  'tests/integration/ocr-corrections-pg.mjs',
  'tests/integration/recognitions-pg.mjs',
  'tests/integration/account-suspend-pg.mjs',
  'tests/integration/speech-pg.mjs',
  'tests/integration/moderation-ledger-pg.mjs',
  'tests/integration/media-persistence-pg.mjs',
  'tests/integration/media-concurrency-pg.mjs',
  'tests/integration/backup-purge-pg.mjs',
  'tests/integration/backup-copies-purge-pg.mjs',
  'tests/integration/messages-purge-pg.mjs',
  'tests/integration/online-purge-pg.mjs',
  'tests/integration/recognition-chain-e2e.mjs',
]);

const FROZEN_MANAGED_SCRIPTS = Object.freeze([
  'tests/integration/conversations-pg.mjs',
  'tests/integration/community-pg.mjs',
  'tests/integration/community-filter-pg.mjs',
  'tests/integration/qa-citations-pg.mjs',
  'tests/integration/messages-pg.mjs',
  // R34：与 `MANAGED_SCRIPTS` 同位置插入（同一份集合，只允许顺序不同）。
  'tests/integration/message-events-pg.mjs',
  'tests/integration/favorites-history-pg.mjs',
  'tests/integration/account-deletion-pg.mjs',
  'tests/integration/admin-jobs-pg.mjs',
  'tests/integration/admin-accounts-read-pg.mjs',
  'tests/integration/admin-flags-pg.mjs',
  'tests/integration/ocr-jobs-pg.mjs',
  'tests/integration/ocr-corrections-pg.mjs',
  'tests/integration/recognitions-pg.mjs',
  'tests/integration/account-suspend-pg.mjs',
  'tests/integration/speech-pg.mjs',
  'tests/integration/moderation-ledger-pg.mjs',
  'tests/integration/media-persistence-pg.mjs',
  'tests/integration/media-concurrency-pg.mjs',
  'tests/integration/backup-purge-pg.mjs',
  'tests/integration/backup-copies-purge-pg.mjs',
  'tests/integration/messages-purge-pg.mjs',
  'tests/integration/online-purge-pg.mjs',
  'tests/integration/recognition-chain-e2e.mjs',
]);

/**
 * 受管脚本在 `real-pg-integration.yml` 里的**必需执行顺序**（显式声明；⛔ 不从 workflow 反推，
 * 否则「把两步对调」会让期望顺序跟着实际顺序一起变，顺序判据就成了永绿）。
 *
 * 每条为什么在这个位置（顺序不是审美，是脚本之间的状态依赖）：
 *   1. `conversations-pg`：只在自己库内建表/迁移，收尾不 DROP 集群级角色 ⇒ 对前后无前提，排第一。
 *   2. `community-pg`：同上，只碰自己库；与会话链互不共享库/角色。
 *   3. `messages-pg`：同上。
 *   4. `favorites-history-pg`：同上。
 *   5. `account-deletion-pg`：**要求集群里没有同名角色**（`:378` 无条件执行 5 个角色文件、`:381` 无条件
 *      `CREATE ROLE`，开头**没有** `resetRoles()`），收尾按 `pg_roles` 快照差集把本轮新建的角色全部
 *      DROP 并复核为空 ⇒ 必须排在 `admin-accounts-read-pg` **之前**（后者收尾不清理，会把
 *      `gengyun_api_runtime` + 6 个组角色留在集群里，实测 7 个）。
 *   6. `admin-flags-pg`：argv[3] 省略时**只接受自己本轮新建**的 `gengyun_api_runtime` —— `preflightRuntimeRole`
 *      在**任何写库动作之前**硬拒「同名角色已存在」，收尾再复读 `pg_authid` 指纹比对「既有角色的认证材料
 *      一字不差」（#428 的同族收口，R33-i18 把这条臂的 `ALTER ROLE … LOGIN PASSWORD '<随机>'` 删掉）。
 *      它**不执行任何角色文件**（不建组角色）、收尾按基线差集清掉自己建的角色（本机 PG 17.11 空集群实测：
 *      `[ALL PASS]` 后 `pg_roles` 只剩库 owner；CI 上同一读数只剩 `gengyun_ci_owner`）⇒ 与第 5 条的
 *      `account-deletion-pg`、紧邻的 `admin-jobs-pg` **同前提**：要求集群里没有该角色，故必须排在
 *      `admin-accounts-read-pg` **之前**（后者会把 7 个角色留在集群里）。
 *   7. `admin-accounts-read-pg`：开头 `resetRoles()` 只 `DROP OWNED BY` **本库**再加 `DROP ROLE`，
 *      并 `catch(() => {})` 吞掉失败；它**不**在收尾清理自己建的 7 个角色 ⇒ 必须排在注销与 `admin-flags`
 *      之后（三条 I18 后台真库臂并排读，唯一会把角色留在集群里的这一条自然排在三者最后）。
 *
 * 与 `MANAGED_SCRIPTS` 的关系：**成员集合必须相同、顺序必须等于这里的顺序**，两条都由下面的断言钉住。
 */
export const REQUIRED_STEP_ORDER = Object.freeze([
  'tests/integration/conversations-pg.mjs',
  'tests/integration/community-pg.mjs',
  // 2b. `community-filter-pg`（R29-S13 接入，#15 的筛选真库读数 + 举报状态缺口登记）：自建专用空库
  //    （硬钉 `gengyun_community_filter_test`）、只 apply 0001+0022+0030+0032、全程只用库 owner 连接，
  //    不建组角色、也不复用别人的运行时角色 ⇒ 对前后脚本零耦合；紧跟 `community-pg` 便于两条社区臂
  //    并排读（两者**不共享库/角色**，重排也不会互相污染，但顺序判据要求与 workflow 逐条一致）。
  'tests/integration/community-filter-pg.mjs',
  // R31-a. `qa-citations-pg`（R31 接入，#12 问答引用可溯源）：自建专用空库（硬钉 `gengyun_qa_citations_test`）、
  //    只 apply 迁移**子集** 0001/0002/0005/0008/0010/0012/0013 七段（⛔ 不是全链 `discoverMigrations()`）、
  //    全程只用库 owner 连接 ⇒ 不建组角色、也不复用别人的运行时角色，对前后脚本零耦合；紧跟社区域便于
  //    「库 owner + 只 apply 需要的迁移 + 断言空库」这一类并排读。缺 env 时脚本 exit 77 ⇒ workflow 把 77 升级成硬失败。
  'tests/integration/qa-citations-pg.mjs',
  'tests/integration/messages-pg.mjs',
  // R34-a. `message-events-pg`（R34 接入，#17「社区事件 → 消息域」的真库臂）：自建专用空库
  //    （硬钉 `gengyun_message_events_test`）、`applyMigrations(discoverMigrations())` 全链自举
  //    （**不重复** `messages-pg` 的 0019 UP/ROLLBACK/REPLAY 三连）、全程只用库 owner 连接
  //    ⇒ 不建组角色、也不复用别人的运行时角色，对前后脚本零耦合。
  //    它**紧跟 `messages-pg`**：同一域的两条真库臂并排读（自己写 vs 经社区事件投递进来），两者不共享
  //    库/角色/进程状态 ⇒ 相邻纯粹是可读性，⛔ 不是执行顺序依赖；⛔ 也不要挪到清单末尾（那里紧邻
  //    admin 域条目，会与另一个切片的追加互相冲突）。
  //    连接串走 argv[2]（与 `messages-pg` 同形），所以这步同时是「argv URL 形态」的第二个样本。
  'tests/integration/message-events-pg.mjs',
  'tests/integration/favorites-history-pg.mjs',
  'tests/integration/account-deletion-pg.mjs',
  // R31-b. `admin-jobs-pg`（R31 接入，#9 作业台：开关生效／作业与错误可见／变更留痕 A→B／最小权限）：
  //    **要求集群里没有 `gengyun_api_runtime`**——只给 argv[2] 时它走 `provisionRoles()` 自己 `CREATE ROLE`
  //    并把随机口令写进自己的运行时 URL（`admin-jobs-pg.mjs:276-298`），给了 argv[3] 反而要求角色**已存在**
  //    （`:252-274`，存在且非本轮创建即「拒绝接管」）。它前面正是「收尾按 `pg_roles` 快照差集 DROP 并复核为空」的
  //    `account-deletion-pg` ⇒ 排在两者之间；它自己收尾同样按快照差集 DROP（`:859-871`），故后面的
  //    `admin-flags-pg` 又能从「不存在」开始（本机负控制：角色在时它 exit=1 且打印「拒绝接管既有角色」）。
  'tests/integration/admin-jobs-pg.mjs',
  // R33-i18. `admin-flags-pg`（#18 全局开关真库臂，R28-S14 接入）与上一条**同族收口**（#428 的做法）：
  //    argv[3] 省略时它**只接受自己本轮新建**的 `gengyun_api_runtime`（`preflightRuntimeRole` 在任何写库
  //    动作之前硬拒「同名角色已存在」，收尾 `checkRoleCredentials` 复读 `pg_authid` 比对既有角色认证材料），
  //    ⛔ 不再「存在即 `ALTER ROLE … LOGIN PASSWORD '<随机>'`」接管它。⇒ 前提从「能容忍残留角色」变成
  //    「残留即 exit=1」，与 `admin-jobs-pg` 完全一致，故必须紧跟其后（前一步收尾已把角色清空）、并排在
  //    会把 `gengyun_api_runtime` + 6 个组角色**留在集群里**的 `admin-accounts-read-pg` **之前**。
  //    ⛔ 不要把它挪回 `admin-accounts-read-pg` 之后：那一步之后角色一直在，本臂会当场 exit=1。
  'tests/integration/admin-flags-pg.mjs',
  'tests/integration/admin-accounts-read-pg.mjs',
  // 8. `ocr-jobs-pg`（`#331` 接入）：自建专用空库、跑全链迁移 0001..0024、建/清一个测试 LOGIN，
  //    不建组角色、也不复用别人的运行时角色 ⇒ 对前后脚本都无耦合（R28-S36 之后它不再是最后一步）。
  'tests/integration/ocr-jobs-pg.mjs',
  // R31-c. `ocr-corrections-pg`（R31 接入，#10 OCR 校正台账）：自建专用空库 `gengyun_ocr_corrections_test`、
  //    自己 `applyMigrations` 全链后落夹具、全程库 owner 连接、只走 env `OCR_PG_TEST_URL`（与上一条同名，
  //    但两步各用自己的库、不共享 step env）⇒ 不建组角色、不复用运行时角色，对前后脚本零耦合；
  //    紧跟同域的 OCR 作业臂便于「作业面 + 台账面」并排读。缺 env 时脚本 exit 77 ⇒ workflow 把 77 升级成硬失败。
  'tests/integration/ocr-corrections-pg.mjs',
  // 9. `recognitions-pg`（`#349` 接入）：自建专用空库 `gengyun_recognitions_test`、自己 apply
  //    0001..0025 全链（含 0025_recognitions_persistence.sql）、全程只用库 owner 连接，
  //    不建组角色、也不复用别人的运行时角色 ⇒ 对前后脚本无耦合。
  //    ⛔ 不要把它挪到 `ocr-jobs-pg` 之前：两者都以「空库 + 全链迁移」为前提，重排会同时违反
  //    判据⑥（顺序）与判据⑦⑧（建库/库名一致性）的语义。
  'tests/integration/recognitions-pg.mjs',
  // 10. `account-suspend-pg`（R28-S39 接入）：要求空库、自己 apply 0001–0017；开头 `resetRoles()` 先尽力
  //    DROP 7 个角色，删不掉（别处把权限授予了它）时改用属性逐字相同的 `ALTER ROLE` 复用 ⇒ 能容忍
  //    `admin-accounts-read-pg` 留在集群里的同名角色；收尾 `cleanup()` 按快照差集 DROP 自己建的角色。
  //    排在语音域之前（workflow 里也是第 10 步）：它清理自建角色，放前面会改变后面脚本的前置条件。
  'tests/integration/account-suspend-pg.mjs',
  // 11. `speech-pg`（`#351` 接入，R28-S40）：自建专用空库（硬钉 `gengyun_speech_test`），自己
  //    `discoverMigrations()` 跑全链迁移 0001..0026、再做 0026 的 UP／ROLLBACK／REPLAY，全程只用库 owner
  //    连接 ⇒ 不建组角色、也不复用 `admin-accounts-read` 留在集群里的运行时角色，对前后脚本无耦合，排最后。
  'tests/integration/speech-pg.mjs',
  // 11b. `moderation-ledger-pg`（R29 接入，PR #434）：自建专用空库 `gengyun_moderation_test`，脚本自己跑
  //    整条迁移链（0001..0026 ⇒ #428 的 0027 DDL 夹具 ⇒ 0028 的 UP／ROLLBACK／REPLAY），全程只用库 owner
  //    连接、不建组角色 ⇒ 与 `speech-pg` 一样对前后脚本零耦合，故紧跟其后。
  //    ⛔ 不要把它挪到那条装包 step 之后：它不需要 `initdb`/`pg_ctl`，混进自起集群那批会让两类失败读数纠缠。
  //    它的顺序同时是「0027 缺号」的机器化自证：缺号时本步红，⛔ 不靠等 #428 把红的说成绿。
  'tests/integration/moderation-ledger-pg.mjs',
  // 12. `media-persistence-pg`（R28-W12 接入，#6／#16 的媒体持久化）：与第 11 条**同型**——自建专用空库
  //    （硬钉 `gengyun_media_test`）、自己 `applyMigrations(discoverMigrations())` 跑**全链 26 个迁移**
  //    （与 `npm run db:migrate` 同一条代码路径，因此判据⑦⑧ 的「空库 + 先建库」对它同样成立）、
  //    再做三段式上传／owner 逐字节读／非 owner `NOT_FOUND`／同键重复 complete 行数不变／子进程真重启后
  //    同 uploadId 仍可读／缺 `MEDIA_OBJECT_REF_KEY` 时整域 503／空仓储负控制，全程**库 owner** 连接、
  //    不建组角色、不复用别人的运行时角色 ⇒ 对前后脚本零耦合。
  //    它排在语音域之后、自起集群那两条之前：本步只碰自己库内的表，唯一的新增前提是「库还不存在」，
  //    而 `CREATE DATABASE` 就在它自己的 step 里（判据⑦⑧）。
  'tests/integration/media-persistence-pg.mjs',
  // 12b. `media-concurrency-pg`（R28-W12 的**并发面**读数，`#6`／`#16`）：与第 12 条**同型**——自建专用空库
  //    （硬钉 `gengyun_media_concurrency_test`）、自己 `applyMigrations(discoverMigrations())` 空库自举
  //    （因此判据⑦⑧ 的「空库 + 先建库」对它同样成立）、全程**库 owner** 连接、不建组角色、不复用别人的
  //    运行时角色 ⇒ 对前后脚本零耦合。跑的是同一媒体对象的两次**并发** `complete`（恰好一个 202、一个 409）、
  //    同一 `Idempotency-Key` **跨主体**的 scope 判定（不回放他人回执）、`reject()` 的条件写布尔语义。
  //    ⛔ 必须**独立库**、⛔ 不要并进第 12 条那一步：第 12 条的读数里有**全库** `count(*)`
  //    （`media-persistence-pg.mjs:273-275`、`:289-291`、`:426`，证「同一幂等键重复 complete 行数不变」），
  //    共库会让两边的行数互相污染 ⇒ 两条臂都变成假读数。
  //    它紧跟第 12 条：同一脚本族并排读，且它的唯一前提也是「库还不存在」（`CREATE DATABASE` 在它自己的 step 里）。
  'tests/integration/media-concurrency-pg.mjs',
  // 13. `backup-purge-pg`（R28-S49 接入，#19／GY-I19）：**自起自停独立集群**（`initdb` 出临时 17 集群、只监听
  //    127.0.0.1、自建 `gengyun_backup_purge_test`、跑完 `pg_ctl stop` 并删数据目录），**不连** service 里的库、
  //    不改集群级对象 ⇒ 零耦合；`GY_PG_BIN` 必须指到 runner 上的 17 服务端 bin（`/usr/lib/postgresql/17/bin`，
  //    缺它只会 SKIP+77，见 `SELF_CLUSTERED_PG_BIN_ENV`）。它紧跟那条装包 step（装包只做一次，见第 14 条），
  //    本步也不依赖 service 口令 ⇒ 位置只受「装包在它之前」约束。
  'tests/integration/backup-purge-pg.mjs',
  // 14. `backup-copies-purge-pg`（R28-E5 接入，`#398`／GY-I19 的 P0-4 执行者）：与第 13 条**同类**的自起集群
  //    脚本（自己 `initdb` 出临时 17 集群、端口 55600+randomInt(0,300) 且先探活、自建
  //    `gengyun_backup_purge_driver_test`、跑完 `pg_ctl stop` 并删数据目录），**不连** service 里的库、
  //    **不建**组角色、也不碰集群级对象 ⇒ 对前后脚本零耦合；`GY_PG_BIN` 同样必须指到 `/usr/lib/postgresql/17/bin`。
  //    ⛔ 不要把它挪到那条装包 step 之前：装包是它唯一的 runner 侧前提，挪上去会让它 SKIP+77（77 不是通过）。
  //    它排在 `backup-purge` 之后而不是之前，是因为它复用同一次装包的结果、且与本步一样只在临时目录里活动；
  //    两步共用 `GY_I19_PG_ROOT` 也安全（数据目录名各带随机后缀、前一步收尾已删干净）。
  'tests/integration/backup-copies-purge-pg.mjs',
  // 15. `messages-purge-pg`（R29-W13 接入，`#405`／W11 合入的脚本，`#17` 消息域注销**行数**）：与第 13/14 条
  //    **同类**的自起集群脚本（自己 `initdb` 出临时 17 集群、端口 55700–55999 且**先探活**、自建
  //    `gengyun_messages_purge_test`、跑完 `pg_ctl stop` 并删数据目录），**不连** service 里的库、
  //    **不建**组角色、也不碰集群级对象 ⇒ 对前后脚本零耦合，位置只受「那条装包 step 在它之前」约束。
  //    ⚠️ 它与第 13/14 条有一处关键差异：它读的数据根目录键是 **`GY_W11_PG_ROOT`**（脚本 `:92`），
  //    ⛔ 不是 `GY_I19_PG_ROOT`。键名按脚本映射，见 `SELF_CLUSTERED_ROOT_KEY`；给错键只会多一条
  //    装饰性 env（守卫绿、脚本照样落 `os.tmpdir()`）——这正是本片修掉的假绿。
  //    它排在 `recognition-chain-e2e` **之前**：后者是唯一起 loopback 监听并反复轮询异步落库的最慢一步，
  //    其 step 注释与 `REQUIRED_STEP_ORDER` 都要求它仍排最后（别把它的读秒和别人的失败混在一起）。
  'tests/integration/messages-purge-pg.mjs',
  // 15b. `online-purge-pg`（R32 接入，`#19` 在线数据 7 日到期**执行者**——它的驱动
  //    `services/api/src/privacy/online-purge-driver.ts` 与运维命令 `tools/purge-expired-online-data.mjs`
  //    早已在 main，但此前**不在任何 workflow**：`#19` 的在线侧「7 日到期」在 CI 上从未被真库验证过）：
  //    与第 13/14 条**同类**的自起集群脚本（自己 `initdb` 出临时 17 集群、端口 55600+randomInt(0,300)
  //    且**先探活再起**、自建 `gy_w6_online_purge`、跑完 `pg_ctl stop` 并删数据目录），**不连** service
  //    里的库、**不建**组角色、也不碰集群级对象 ⇒ 对前后脚本零耦合，位置只受「那条装包 step 在它之前」约束。
  //    它的数据根目录键是 **`GY_I19_PG_ROOT`**（脚本取值点 `process.env.GY_I19_PG_ROOT ?? tmpdir()`），
  //    与第 13/14 条同键（⛔ 与第 15 条的 `GY_W11_PG_ROOT` 不同）；守卫按脚本源码交叉核对。
  //    它排在 `recognition-chain-e2e` **之前**：后者是唯一起 loopback 监听并反复轮询异步落库的最慢一步。
  'tests/integration/online-purge-pg.mjs',
  // 16. `recognition-chain-e2e`（R28-S65 接入，GY-I06／I08／I09／I10）：**唯一一条不叫 `-pg.mjs`** 的受管脚本
  //    （`-e2e.mjs`），跑的是仓内唯一的完整业务链路（上传识别→结果→可信度与理由→识别历史→读回→删除→读空，
  //    全程 loopback 真 HTTP）。前提三条：① 专用空库 `gengyun_recognition_chain_test`（脚本 `preparePg()` 先数
  //    `public` 下的表，非 0 直接断言失败）；② 只 apply 它需要的两段迁移（0001 身份 + 0018 历史）并断言
  //    「恰好一次 + 重复 no-op」——⛔ 与上面的 ocr-jobs／recognitions／speech **不同**，它不跑全链；
  //    ③ 全程**库 owner** 连接（env `RECOGNITION_CHAIN_PG_TEST_URL`），不建组角色、不用运行时角色 ⇒ 零耦合。
  //    排**最后**的两个理由：它对前后无前提（⑦⑧⑨ 都不依赖前面的库/角色），而它自己会起 loopback 监听
  //    并反复轮询「历史行异步落库」（有界等待，最慢的一步）⇒ 放最后不会把别人的失败混进它的读秒。
  'tests/integration/recognition-chain-e2e.mjs',
]);

/**
 * 「放宽跳过」的开关：出现任何一个就说明有人为了让 job 变绿把「未取得」改写成「通过」。
 * 脚本侧这两个开关只在本机开发时用（`--allow-skip` 取 0）；⛔ 永远不得进 workflow。
 */
const FORBIDDEN_ESCAPE_HATCHES = Object.freeze(['GY_ALLOW_SKIP', '--allow-skip']);

/** 真库镜像的主版本：`postgres:17.11` 的 `17`。降级成 16 会让 17 专有行为（视图/迁移）静默失真。 */
const REQUIRED_POSTGRES_MAJOR = '17';

/**
 * 「自起集群」脚本：**自己** `initdb` 起临时集群、自己建库，CI 里既没有可用的 `CREATE DATABASE`，
 * 也没有可核对的「CI 建出来的库名」。判据⑦⑧ 对这类脚本换成等价（且更强）的判据：
 *   ① step 必须显式给出 `GY_PG_BIN`，指到**含 `initdb`/`pg_ctl` 的服务端 bin 目录**；
 *   ② 必须显式给出**该脚本自己读的**数据根目录键（`GY_*_PG_ROOT`，按脚本映射、⛔ 不是对全体硬编码
 *      `GY_I19_PG_ROOT`；R29-W13 前正是硬编码，`messages-purge-pg` 读 `GY_W11_PG_ROOT` ⇒ 守卫绿而脚本
 *      回落 `os.tmpdir()`，见 `SELF_CLUSTERED_ROOT_KEY`），且落在 runner 的临时目录里（⛔ 不落仓库/系统目录）；
 *      step 里出现脚本不读的**别的** root 键也判红（装饰性 env 是假绿通道）；
 *   ③ ⛔ step 里**不得**出现 `CREATE DATABASE`——那会造出「CI 建了库、库名判据覆盖到它」的假象，
 *      而脚本连的是自己临时集群里的 `DB_NAME`（脚本 `:67`），跟 CI 建的库毫无关系。
 * 加一条进这里＝把这组判据换成豁免，必须同时更新证据页（刻意留 diff）；它也必须同时在 `MANAGED_SCRIPTS` 里。
 */
const SELF_CLUSTERED_SCRIPTS = Object.freeze([
  'tests/integration/backup-purge-pg.mjs',
  // R28-E5：`backup-copies-purge-pg.mjs`（`#398`）与上一条同形——自己 `initdb` 出临时 17 集群、自建库、
  // 跑完 `pg_ctl stop` 并删数据目录，故同样没有「CI 建的库」可核对，判据⑦⑧ 换成同一组等价判据。
  'tests/integration/backup-copies-purge-pg.mjs',
  // R29-W13：`messages-purge-pg.mjs`（`#405`）同上（自起集群、自建 `gengyun_messages_purge_test`、
  // 跑完 `pg_ctl stop` 并删数据目录）。⚠️ 它读的数据根键是 `GY_W11_PG_ROOT`（脚本 `:92`），
  // 与上面两条的 `GY_I19_PG_ROOT` **不同** ⇒ 键名必须按脚本映射，见 `SELF_CLUSTERED_ROOT_KEY`。
  'tests/integration/messages-purge-pg.mjs',
  // R32：`online-purge-pg.mjs`（`#19` 在线数据 7 日到期执行者）同上（自起集群、自建 `gy_w6_online_purge`、
  // 跑完 `pg_ctl stop` 并删数据目录）。它读的数据根键是 `GY_I19_PG_ROOT`（与第 13/14 条同键）。
  'tests/integration/online-purge-pg.mjs',
]);

/**
 * 每条自起集群脚本**自己读的**数据根目录键。键名不是共用契约，是脚本各自的契约：
 *   - `backup-purge-pg.mjs`／`backup-copies-purge-pg.mjs` 读 `GY_I19_PG_ROOT`；
 *   - `messages-purge-pg.mjs` 读 **`GY_W11_PG_ROOT`**（脚本 `:92`；它的日志键是 `GY_W11_PG_LOG`，见 `:75`）。
 * 为什么必须按脚本映射而不是硬编码一个键：给 `messages-purge-pg` 传 `GY_I19_PG_ROOT` 时，step 里只多一条
 * **装饰性 env**——守卫照样绿，脚本照样回落 `os.tmpdir()`，数据目录落在共享 tmp，与「落在 runner 临时
 * 目录」的初衷正好相反。本机实测（R29-W13，PG 17.11）：只给 `GY_I19_PG_ROOT=E:\\…\\tmp\\DECOY-i19-root`
 * 时，`messages-purge-pg.mjs` 仍要往 `C:/Users/MR/AppData/Local/Temp/gy-w11-messages-purge-pg-61a5ae9d`
 * 建目录（该 decoy 目录从未被创建），并因 tmp 目录 ACL 失败：`initdb: error: could not change permissions
 * of directory \"…\": Permission denied`（exit 1）。
 * ⚠️ 这张表**不是**唯一依据：`detectedRootKeys()` 会从脚本源码取它真正读的键并与本表交叉核对——声明漏了、
 * 声明错了、脚本改了而表没跟上，一律判红；否则「把映射改错」本身就是新的假绿通道。
 */
const SELF_CLUSTERED_ROOT_KEY = Object.freeze({
  'tests/integration/backup-purge-pg.mjs': 'GY_I19_PG_ROOT',
  'tests/integration/backup-copies-purge-pg.mjs': 'GY_I19_PG_ROOT',
  'tests/integration/messages-purge-pg.mjs': 'GY_W11_PG_ROOT',
  // R32：`online-purge-pg.mjs`（`#19`）读 `GY_I19_PG_ROOT`（源码取值点
  // `process.env.GY_I19_PG_ROOT ?? tmpdir()`）⇒ 与第 13/14 条同键。
  'tests/integration/online-purge-pg.mjs': 'GY_I19_PG_ROOT',
});

/** 数据根目录键的形状：`GY_*_PG_ROOT`。用来从脚本源码认出「它读哪个根」，也是「装饰性 env」的识别口径。 */
const SELF_CLUSTERED_ROOT_KEY_PATTERN = /^GY_[A-Z0-9_]*_PG_ROOT$/;

/** step 里数据根目录的取值形状：必须是 runner 的临时目录表达式（⛔ 不落仓库/系统目录）。 */
const SELF_CLUSTERED_ROOT_PATTERN = /\$\{\{\s*runner\.temp\s*\}\}/;

const SELF_CLUSTERED_ROOT_HINT =
  'runner 的临时目录（CI 里是 `${{ runner.temp }}/<该脚本自己的根>`，⛔ 不落地到仓库）';

/**
 * 自起集群脚本在 step 里**无条件**必须给出的 env（与服务端 bin 相关）：键 → 值的形状判据 + 缺失/走形话术。
 * 判据不是「有这个键就行」：`GY_PG_BIN` 末尾不是 `/bin` 时脚本 `:52-62` 会直接 SKIP 并 exit 77，
 * 「真跑」就变成了「静默跳过」——那正是这份清单要防的假绿。
 */
const SELF_CLUSTERED_PG_BIN_ENV = Object.freeze({
  key: 'GY_PG_BIN',
  pattern: /\/bin\/?$/,
  hint: '含 `initdb`/`pg_ctl` 的服务端 bin 目录（CI 里是 `/usr/lib/postgresql/17/bin`）',
});

// ── 纯函数：正向断言与反向控制共用同一份逻辑，避免「红的逻辑」与「绿的条件」各写一套 ──────────────

/** 只有 `.yml` / `.yaml` 才是 workflow。 */
export function isWorkflowFile(fileName) {
  return fileName.endsWith('.yml') || fileName.endsWith('.yaml');
}

export function selectWorkflowFiles(fileNames) {
  return fileNames.filter(isWorkflowFile).sort();
}

/**
 * 取出一个 workflow 文本里所有 `run:` 的**命令文本**（内联值 ＋ 其后缩进更深的块行）。
 * `run:` 之前的缩进（含 `- ` 列表前缀）就是块的边界：缩进不深于此的下一行（如 `env:`、下一个 `- `）即结束。
 * **两种注释都不算命令**——否则「注释里提一句脚本名」就能把守卫糊弄绿：
 *   ① YAML 级注释行（`#` 开头的行）；
 *   ② `run: |`／`run: >` 块标量体里的 `#` 行——GitHub 用 bash 执行块内容，那是 **shell 注释、不会执行**。
 * （块标量指示符本身如 `|` 会作为内联值进入命令文本，无害：它不含任何脚本路径。）
 */
export function runCommandTextsOf(source) {
  const lines = source.split('\n');
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (!match) continue;
    const blockIndent = match[1].length;
    const parts = [];
    const inline = match[2].trim();
    if (inline !== '' && !inline.startsWith('#')) parts.push(inline);
    for (let next = index + 1; next < lines.length; next += 1) {
      const blockLine = lines[next];
      if (blockLine.trim() === '') continue;
      const indent = blockLine.length - blockLine.trimStart().length;
      if (indent <= blockIndent) break;
      index = next;
      // ② 块标量体里的 `#` 行＝shell 注释：跳过内容但**仍推进 index**（否则外层会把它当新行重扫）。
      if (blockLine.trim().startsWith('#')) continue;
      parts.push(blockLine.trim());
    }
    if (parts.length > 0) commands.push(parts.join('\n'));
  }
  return commands;
}

/**
 * 哪些受管脚本**没有**出现在任何 workflow 的 `run:` 命令文本里（升序）。
 * `workflows` 形如 `[{ file, commands }]`：正向断言传磁盘真值，反向控制传内存变异值。
 */
export function missingManagedScripts({ workflows, managed = MANAGED_SCRIPTS }) {
  const wired = new Set();
  for (const workflow of workflows) {
    for (const command of workflow.commands) {
      for (const script of managed) {
        if (command.includes(script)) wired.add(script);
      }
    }
  }
  return managed.filter((script) => !wired.has(script)).sort();
}

/** 宽松跳过开关的命中行（`文件:行号: 开关`），空数组＝干净。 */
export function escapeHatchHits({ file, source }) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    for (const token of FORBIDDEN_ESCAPE_HATCHES) {
      if (line.includes(token)) hits.push(`${file}:${index + 1}: ${token}`);
    }
  });
  return hits;
}

/** 找到 `key:` 那一行及其缩进更深的后继块（只取第一条）。找不到返回 `null`。 */
function blockAfterKey(source, key) {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith('#')) continue;
    const match = new RegExp(`^(\\s*(?:-\\s+)?)${key}:\\s*$`).exec(line);
    if (!match) continue;
    const blockIndent = match[1].length;
    const body = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const blockLine = lines[next];
      if (blockLine.trim() === '') continue;
      const indent = blockLine.length - blockLine.trimStart().length;
      if (indent <= blockIndent) break;
      body.push(blockLine);
    }
    return { indent: blockIndent, body };
  }
  return null;
}

/**
 * 真库服务段的问题清单（空数组＝合规）：
 *   ① 缺 `services:` 段；② 缺 `services.postgres`；③ 缺 `image:`；④ 镜像不是 `postgres:<主版本>`；
 *   ⑤ 主版本不是 17。
 */
export function postgresServiceProblems(source, { requiredMajor = REQUIRED_POSTGRES_MAJOR } = {}) {
  const problems = [];
  const services = blockAfterKey(source, 'services');
  if (services === null) {
    problems.push('缺少 `services:` 段：真库服务容器被删掉了（脚本会连不上库并以 77 退出）');
    return problems;
  }
  if (!services.body.some((line) => /^\s+postgres:\s*$/.test(line))) {
    problems.push('`services:` 段里缺少 `postgres:` 服务（镜像与健康检查一并失效）');
    return problems;
  }
  const imageLine = services.body.map((line) => /^\s+image:\s*(['"]?)([^'"\s]+)\1\s*$/.exec(line)).find(Boolean);
  if (imageLine === undefined) {
    problems.push('`services.postgres` 缺少 `image:`（没有镜像就没有真库）');
    return problems;
  }
  const image = imageLine[2];
  const imageMatch = /^postgres:(\d+)/.exec(image);
  if (imageMatch === null) {
    problems.push(`\`services.postgres.image\` 不是 \`postgres:<主版本>\` 形状：${image}`);
    return problems;
  }
  if (imageMatch[1] !== requiredMajor) {
    problems.push(`\`services.postgres.image\` 主版本是 ${imageMatch[1]}，要求 ${requiredMajor}：${image}`);
  }
  return problems;
}

/**
 * 取 `jobs:` 段里每个 job 的 `{ id, body }`（`body` 是该 job 缩进更深的全部行，原样保留缩进）。
 * 用途：把判据③的作用域锚定到**具体 job**——只看「文件里第一个 `services:`」会被诱饵 job 骗过。
 */
export function jobsOf(source) {
  const jobs = blockAfterKey(source, 'jobs');
  if (jobs === null) return [];
  const collected = [];
  let current = null;
  for (const line of jobs.body) {
    if (line.trim() === '') {
      if (current !== null) current.lines.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const key = /^(\s+)([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (indent === jobs.indent + 2 && key !== null) {
      current = { id: key[2], lines: [] };
      collected.push(current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  return collected.map((job) => ({ id: job.id, body: job.lines.join('\n') }));
}

/** 哪些 job 的 `run:` **命令文本**里真的出现了受管脚本（判据③的作用域就是它们）。 */
export function jobsRunningManagedScripts(source, { managed = MANAGED_SCRIPTS } = {}) {
  return jobsOf(source).filter((job) => runCommandTextsOf(job.body).some(
    (command) => managed.some((script) => command.includes(script)),
  ));
}

/**
 * 真库服务段的判据（作用域＝**真跑受管脚本的那个 job**，不是文件里第一个 `services:`）。
 * 为什么必须锚定到 job：把两个脚本拆成两个 job 是这个 workflow 最自然的下一步演进；
 * 而在真 job **之前**插一个带 `postgres:17.11` 的诱饵 job，就能让「只取第一个 `services:`」的实现
 * 把真 job 的**镜像降级**或**整段删 services** 判成绿（审查实测 F1／F2，均 6/6 绿）。
 * 判据要能回答两件事：真 job 有 `services.postgres` 吗？真 job 的镜像主版本是 17 吗？
 */
export function postgresJobProblems(source, { managed = MANAGED_SCRIPTS, requiredMajor = REQUIRED_POSTGRES_MAJOR } = {}) {
  const jobs = jobsOf(source);
  if (jobs.length === 0) return ['`jobs:` 段解析不到任何 job（结构变了，判据③失去作用域）'];
  const running = jobsRunningManagedScripts(source, { managed });
  if (running.length === 0) {
    return [`没有任何 job 的 \`run:\` 真跑受管脚本（${managed.join('、')}），无法确认它的 \`services.postgres\` 是否合规`];
  }
  const problems = [];
  for (const job of running) {
    for (const problem of postgresServiceProblems(job.body, { requiredMajor })) {
      problems.push(`job \`${job.id}\`：${problem}`);
    }
  }
  return problems;
}

/**
 * 「吞红」构造的命中行（`文件:行号: 构造`），空数组＝干净。
 * 这一步失败却仍判绿的三种写法：step 级 `continue-on-error:`／`if:`（含 `if: false`）／
 * 命令末尾 `|| true`。真库臂的红是**唯一**的验收信号，任何「吞掉它」的构造都必须拦下。
 * 注释行不算（与判据①同一口径：注释不是命令）。
 */
export function swallowedFailureHits({ file, source }) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    if (line.trim().startsWith('#')) return;
    const where = `${file}:${index + 1}`;
    if (/^\s*continue-on-error\s*:/.test(line)) hits.push(`${where}: continue-on-error`);
    if (/^\s*(?:-\s+)?if\s*:/.test(line)) hits.push(`${where}: if`);
    if (/\|\|\s*true\b/.test(line)) hits.push(`${where}: || true`);
  });
  return hits;
}

/** 未固定到 40 位 SHA 的 `uses:`（`文件:行号: 引用`），空数组＝全部固定。 */
export function unpinnedUses({ file, source }) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    if (line.trim().startsWith('#')) return;
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#.*)?\s*$/.exec(line);
    if (match === null) return;
    if (!/@[0-9a-f]{40}$/.test(match[1])) hits.push(`${file}:${index + 1}: ${match[1]}`);
  });
  return hits;
}

/**
 * 一个 job body 里的 step 文本块：`- ` 项起头，到下一个同缩进的 `- ` 项或 job 末尾为止。
 * `steps:` 的缩进从文本里取，⛔ 不硬编码 6 空格（拆 job／加缩进层级时判据不该假红）。
 */
export function stepsOfJob(jobBody) {
  const stepsBlock = blockAfterKey(jobBody, 'steps');
  if (stepsBlock === null) return [];
  const steps = [];
  let current = null;
  for (const line of stepsBlock.body) {
    if (line.trim() === '') {
      if (current !== null) current.lines.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === stepsBlock.indent + 2 && /^\s*-\s+\S/.test(line)) {
      current = { lines: [line] };
      steps.push(current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  return steps.map((step) => step.lines.join('\n'));
}

/** 执行某受管脚本的那一个 step：`{ jobId, step, command }`；找不到返回 `null`。 */
export function stepRunningScript(source, script) {
  for (const job of jobsOf(source)) {
    for (const step of stepsOfJob(job.body)) {
      const command = runCommandTextsOf(step).find((text) => text.includes(`node ${script}`));
      if (command !== undefined) return { jobId: job.id, step, command };
    }
  }
  return null;
}

/** `CREATE DATABASE <name>` 里的库名（去掉引号）；没有这条语句时返回 `null`。 */
export function createdDatabaseName(command) {
  const match = /CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)/i.exec(command);
  if (match === null) return null;
  return match[1].replace(/^["']|["']$/g, '');
}

/** 连接串里的库名（pathname 去掉前导 `/`）；不是合法 `postgres://` URL 时返回 `null`。 */
export function databaseNameOfUrl(urlText) {
  try {
    const url = new URL(String(urlText).trim());
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/**
 * 脚本内部**硬钉**的库名：两个既有的写法都认——
 *   ① `const DB = 'gengyun_xxx_test'`；
 *   ② `assert.equal(<url>.pathname, '/gengyun_xxx_test', …)`（模板字面量 `\`/${DB}\`` 由 ① 覆盖）。
 */
export function pinnedDatabaseNames(scriptSource) {
  const names = new Set();
  for (const match of scriptSource.matchAll(/const\s+DB\s*=\s*'([A-Za-z0-9_]+)'/g)) names.add(match[1]);
  for (const match of scriptSource.matchAll(/pathname\s*,\s*['"`]\/([A-Za-z0-9_]+)['"`]/g)) names.add(match[1]);
  return [...names].sort();
}

/**
 * 某一步**真正传给脚本**的库名集合（三种入参形态各自抽取）：
 *   ① env `*_PG_TEST_URL` 的 URL path；
 *   ② `node <脚本>` 之后命令行参数里的 `postgres://` URL path（argv[2]／argv[3]…）；
 *   ③ 脚本内部硬钉常量（`pinnedDatabaseNames`）。
 * 返回值是 `Set`：正常情况下恰好一个元素；多于一个＝入参自相矛盾（必须红）。
 */
export function stepDatabaseNames({ script, step, command, scriptSource }) {
  const names = new Set();
  const add = (name) => {
    if (name !== null && name !== undefined) names.add(name);
  };
  for (const match of step.matchAll(/^\s+([A-Z0-9_]+_PG_TEST_URL)\s*:\s*(\S+)\s*$/gm)) {
    add(databaseNameOfUrl(match[2]));
  }
  const marker = `node ${script}`;
  const argumentsText = command.slice(command.indexOf(marker) + marker.length);
  for (const match of argumentsText.matchAll(/postgres(?:ql)?:\/\/\S+/g)) {
    add(databaseNameOfUrl(match[0]));
  }
  for (const name of pinnedDatabaseNames(scriptSource)) add(name);
  return names;
}

/**
 * 从脚本源码里取它**真正读的**数据根目录键（升序去重）。
 * 口径只认 `process.env.GY_*_PG_ROOT` 这一种形态：`GY_PG_BIN`／`GY_W11_PG_LOG` 都不匹配，
 * 因此日志键不会被误当根键；注释里的 `$env:GY_…` 也不会匹配（不是 `process.env.`）。
 * ⛔ 不靠文件名/字段名猜：读的是脚本文本里真正的取值点。
 */
export function detectedRootKeys(scriptSource) {
  const keys = new Set();
  for (const match of String(scriptSource).matchAll(/process\.env\.(GY_[A-Z0-9_]+)/g)) {
    if (SELF_CLUSTERED_ROOT_KEY_PATTERN.test(match[1])) keys.add(match[1]);
  }
  return [...keys].sort();
}

/**
 * 某条自起集群脚本该给的数据根目录键：**源码真值优先**，其次 `SELF_CLUSTERED_ROOT_KEY` 的声明。
 * 两者都没有时返回 `null`（由 `selfClusteredProblems` 判红，⛔ 不在这里静默放行）。
 */
export function rootKeyOf({ script, scriptSource = null, declaredRootKeys = SELF_CLUSTERED_ROOT_KEY }) {
  if (typeof scriptSource === 'string') {
    const sourceKeys = detectedRootKeys(scriptSource);
    if (sourceKeys.length === 1) return sourceKeys[0];
  }
  return declaredRootKeys[script] ?? null;
}

/** 某条自起集群脚本在 step 里必须给出的 env：`GY_PG_BIN` 在前，**它自己读的**数据根键在后。 */
export function selfClusteredEnvOf(script, { scriptSource = null, declaredRootKeys = SELF_CLUSTERED_ROOT_KEY } = {}) {
  const rootKey = rootKeyOf({ script, scriptSource, declaredRootKeys });
  if (rootKey === null) return [SELF_CLUSTERED_PG_BIN_ENV];
  return [
    SELF_CLUSTERED_PG_BIN_ENV,
    { key: rootKey, pattern: SELF_CLUSTERED_ROOT_PATTERN, hint: SELF_CLUSTERED_ROOT_HINT },
  ];
}

/**
 * 自起集群脚本的 step 判据（判据⑦⑧ 的等价替换）：返回问题清单，空数组＝合规。
 * 只在 `SELF_CLUSTERED_SCRIPTS` 里的脚本上生效；其余受管脚本仍走「先 `CREATE DATABASE` 再 `node`」。
 *
 * R29-W13 起的四处收紧（此前①只查 `GY_PG_BIN`＋硬编码 `GY_I19_PG_ROOT` 两栏）：
 *   ① **登记**：脚本在 `SELF_CLUSTERED_SCRIPTS` 里却不在 `SELF_CLUSTERED_ROOT_KEY` ⇒ 红（否则判据退化成
 *      只剩 `GY_PG_BIN`，root 传丢也不会红）；
 *   ② **源码真值**：脚本源码里必须恰好读**一个** `GY_*_PG_ROOT`，且与登记一致 ⇒ 否则红（声明错了、脚本
 *      改了而表没跟上，都不许放过）；
 *   ③ **该给哪个键**：按②的真值核对 step，⛔ 不再对全体硬编码同一个键；
 *   ④ **装饰性 env**：step 里出现脚本**不读**的其它 `GY_*_PG_ROOT` ⇒ 红（那正是本片修掉的假绿：
 *      给 `messages-purge-pg` 传 `GY_I19_PG_ROOT`，守卫绿、脚本回落 `os.tmpdir()`）。
 * `scriptSource` 可注入（只给反向控制用）；缺省读磁盘真值。
 */
export function selfClusteredProblems({ jobId, script, step, command, scriptSource = null, declaredRootKeys = SELF_CLUSTERED_ROOT_KEY }) {
  const problems = [];
  if (/CREATE\s+DATABASE/i.test(command)) {
    problems.push(
      `job \`${jobId}\` 里 \`${script}\` 是自起集群脚本，step 里不该出现 \`CREATE DATABASE\``
      + '（它连的库在它自己 initdb 出来的临时集群里，与 CI 建的这个库不是一回事）',
    );
  }

  let source = scriptSource;
  if (source === null) {
    try {
      source = readFileSync(join(REPO_ROOT, script), 'utf8');
    } catch {
      source = null; // 读不到就只按登记表核对，登记缺失那条会红
    }
  }
  const declaredKey = declaredRootKeys[script];
  const sourceKeys = typeof source === 'string' ? detectedRootKeys(source) : [];

  if (declaredKey === undefined) {
    problems.push(
      `\`${script}\` 在 \`SELF_CLUSTERED_SCRIPTS\` 里，却没在 \`SELF_CLUSTERED_ROOT_KEY\` 登记它读的数据根目录键：`
      + '那样这条判据只会核对 `GY_PG_BIN`，数据根目录传丢/传错都不会红（假绿通道）。',
    );
  }
  if (sourceKeys.length === 0) {
    problems.push(
      `\`${script}\` 的源码里没有任何 \`process.env.GY_*_PG_ROOT\` 取值点：无法确认它读哪个数据根目录键`
      + '（⛔ 不允许凭脚本名/字段名猜，也不允许只信 `SELF_CLUSTERED_ROOT_KEY` 的声明）。',
    );
  } else if (sourceKeys.length > 1) {
    problems.push(
      `\`${script}\` 的源码里读了多个数据根目录键（${sourceKeys.join(' / ')}）：一份 step env 无法判断该给哪个，`
      + '判据会变成猜。',
    );
  } else if (declaredKey !== undefined && declaredKey !== sourceKeys[0]) {
    problems.push(
      `\`SELF_CLUSTERED_ROOT_KEY\` 把 \`${script}\` 的根键登记成 \`${declaredKey}\`，但它自己读的是 `
      + `\`${sourceKeys[0]}\`（源码真值）⇒ 登记错的那一栏会按错的键核对 env，等于放行一条装饰性 env。`,
    );
  }

  for (const { key, pattern, hint } of selfClusteredEnvOf(script, { scriptSource: source, declaredRootKeys })) {
    const match = new RegExp(`^\\s+${key}\\s*:\\s*(\\S.*)$`, 'm').exec(step);
    if (match === null) {
      problems.push(
        `job \`${jobId}\` 里执行自起集群脚本 \`${script}\` 的 step 没有 \`${key}\`（必须给：${hint}）；`
        + (key === 'GY_PG_BIN'
          ? '缺它时脚本只打印 SKIP 并 exit 77，「真跑」等于没跑'
          : '缺它时脚本回落 `os.tmpdir()`，数据目录不在 runner 临时目录里（装饰性 env 的孪生兄弟）'),
      );
      continue;
    }
    const value = match[1].trim().replace(/^['"]|['"]$/g, '');
    if (!pattern.test(value)) {
      problems.push(`job \`${jobId}\` 的 \`${key}\` 取值 \`${value}\` 不是期望形状：${hint}`);
    }
  }

  const expectedKey = sourceKeys.length === 1 ? sourceKeys[0] : (declaredKey ?? null);
  if (expectedKey !== null) {
    for (const match of step.matchAll(/^\s+(GY_[A-Z0-9_]*_PG_ROOT)\s*:/gm)) {
      if (match[1] !== expectedKey) {
        problems.push(
          `job \`${jobId}\` 里执行自起集群脚本 \`${script}\` 的 step 给了 \`${match[1]}\`，但它读的是 `
          + `\`${expectedKey}\` ⇒ \`${match[1]}\` 只是一条装饰性 env：守卫看着有 root，脚本照样回落 `
          + '`os.tmpdir()`（R29-W13 修掉的假绿）。',
        );
      }
    }
  }
  return problems;
}

/**
 * 判据⑦＋⑧：每个受管脚本所在 step 必须「先 `CREATE DATABASE` 再 `node`」，且建出来的库名
 * 与真正传给脚本的库名（三种形态）一致。返回问题清单，空数组＝合规。
 * `scriptSources` 可注入（只给反向控制用）；缺省读磁盘真值。
 */
export function databaseGuardProblems(source, { scripts = MANAGED_SCRIPTS, scriptSources = null } = {}) {
  const problems = [];
  for (const script of scripts) {
    const found = stepRunningScript(source, script);
    if (found === null) {
      problems.push(`${script}：workflow 里找不到执行它的 step`);
      continue;
    }
    const { jobId, step, command } = found;
    if (SELF_CLUSTERED_SCRIPTS.includes(script)) {
      // 自起集群脚本：没有 CI 建的库可核对，换成「必须给 GY_PG_BIN／该脚本自己读的 root 键，且不得自己建库」。
      problems.push(...selfClusteredProblems({
        jobId,
        script,
        step,
        command,
        scriptSource: scriptSources === null ? null : (scriptSources[script] ?? null),
      }));
      continue;
    }
    const createIndex = command.search(/CREATE\s+DATABASE/i);
    const nodeIndex = command.indexOf(`node ${script}`);
    if (createIndex < 0) {
      problems.push(`job \`${jobId}\` 里执行 \`${script}\` 的 step 没有 \`CREATE DATABASE\`（受管脚本都要求专用空库）`);
      continue;
    }
    if (createIndex > nodeIndex) {
      problems.push(`job \`${jobId}\` 里 \`CREATE DATABASE\` 写在了 \`node ${script}\` **之后**（库要先建好）`);
      continue;
    }
    const created = createdDatabaseName(command);
    if (created === null) {
      problems.push(`job \`${jobId}\` 的 \`CREATE DATABASE\` 里取不到库名：${command}`);
      continue;
    }
    const scriptSource = scriptSources === null
      ? readFileSync(join(REPO_ROOT, script), 'utf8')
      : scriptSources[script];
    if (typeof scriptSource !== 'string') {
      problems.push(`${script}：取不到脚本源码，无法核对内部硬钉库名`);
      continue;
    }
    const expected = stepDatabaseNames({ script, step, command, scriptSource });
    if (expected.size === 0) {
      problems.push(
        `${script}：该 step 既没有 \`*_PG_TEST_URL\`／argv URL，脚本里也没有硬钉库名 —— 库名无从核对`,
      );
      continue;
    }
    if (expected.size > 1) {
      problems.push(`${script}：该 step 传给脚本的库名自相矛盾（${[...expected].sort().join(' / ')}）`);
      continue;
    }
    const [expectedName] = expected;
    if (expectedName !== created) {
      problems.push(
        `job \`${jobId}\`：\`CREATE DATABASE ${created}\` 与传给 \`${script}\` 的库名 \`${expectedName}\` 不一致`,
      );
    }
  }
  return problems;
}

/**
 * workflow 里被 `node tests/integration/*-pg.mjs`（或 `*-e2e.mjs`）真跑的全部脚本（升序）。
 *
 * 为什么认两种后缀：受管清单里从 R28-S65 起有一条不叫 `-pg.mjs` 的脚本
 * （`tests/integration/recognition-chain-e2e.mjs`——它跑的是完整业务链路，不是 store 层 SQL 面）。
 * ⛔ 这**不是**放宽判据⑨：双向相等的口径一个字没改，改的只是「哪些文件名算被执行的受管脚本」。
 * 不给它这条，它就永远进不了判据⑨两侧，而一旦登记进 `MANAGED_SCRIPTS` 就变成永久假红。
 */
export function scriptsRunByWorkflow(source) {
  const names = new Set();
  for (const command of runCommandTextsOf(source)) {
    for (const match of command.matchAll(/node\s+(tests\/integration\/[A-Za-z0-9._-]+(?:-pg|-e2e)\.mjs)/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** 判据⑨：workflow 真跑的脚本集合与 `MANAGED_SCRIPTS` 双向相等；返回问题清单。 */
export function managedScriptSetProblems({ source, managed = MANAGED_SCRIPTS }) {
  const executed = scriptsRunByWorkflow(source);
  const executedSet = new Set(executed);
  const managedSet = new Set(managed);
  const problems = [];
  for (const script of [...managedSet].sort()) {
    if (!executedSet.has(script)) problems.push(`清单里有、workflow 没跑：${script}`);
  }
  for (const script of executed) {
    if (!managedSet.has(script)) problems.push(`workflow 跑了、清单里没有：${script}`);
  }
  return problems;
}

/**
 * 判据⑥：受管脚本在 workflow 里的出现顺序必须与 `requiredOrder` 严格递增。
 * 失败消息必须能读出「实际顺序 / 期望顺序 / 第一处逆序对」——只报一句「顺序不对」等于让人猜。
 */
export function stepOrderProblems({ source, requiredOrder = REQUIRED_STEP_ORDER }) {
  const commands = runCommandTextsOf(source);
  const positions = requiredOrder.map((script) => ({
    script,
    index: commands.findIndex((command) => command.includes(`node ${script}`)),
  }));
  const problems = [];
  const absent = positions.filter((position) => position.index < 0).map((position) => position.script);
  if (absent.length > 0) {
    problems.push(`workflow 里找不到这些脚本的 \`node\` 调用（顺序判据失去对象）：${absent.join('、')}`);
  }
  const present = positions.filter((position) => position.index >= 0);
  const actualOrder = [...present].sort((a, b) => a.index - b.index).map((position) => position.script);
  const expectedOrder = present.map((position) => position.script);
  const inversions = [];
  for (let index = 1; index < present.length; index += 1) {
    if (present[index].index <= present[index - 1].index) {
      inversions.push({ previous: present[index - 1].script, next: present[index].script });
    }
  }
  if (inversions.length > 0) {
    const [first] = inversions;
    problems.push(
      `第一处逆序对：期望 \`${first.previous}\` 出现在 \`${first.next}\` 之前，实际相反；`
      + `实际顺序：${actualOrder.join(' → ')}；期望顺序：${expectedOrder.join(' → ')}`,
    );
    for (const inversion of inversions.slice(1)) {
      problems.push(`另有逆序对：期望 \`${inversion.previous}\` 出现在 \`${inversion.next}\` 之前`);
    }
  }
  return problems;
}

// ── 断言本体：失败消息必须**点名文件**（否则反向控制证明不了「红的时候能定位到谁」） ───────────────

function assertManagedScriptsWired(missing) {
  assert.deepEqual(
    missing,
    [],
    [
      '有受管真库脚本既没有被任何 workflow 的 `run:` 执行，也没有对应的真库臂——',
      '这类脚本坏了 CI 也不会红（「脚本在 main、但没人跑」的静默缺口）：',
      ...missing.map((script) => `  · ${script}`),
      '',
      `改法：在 \`${REAL_PG_WORKFLOW}\`（或另一个带 \`services.postgres\` 的 workflow）里加一步`,
      '`node <脚本>`，不要只写在注释里、也不要只写裸文件名。',
    ].join('\n'),
  );
}

function assertNoEscapeHatches(hits) {
  assert.deepEqual(
    hits,
    [],
    [
      '有 workflow 含「放宽跳过」的开关：真库没跑起来时会把「未取得」改写成「通过」，也就是假绿。',
      '缺库必须以 77 红掉，⛔ 不得在 CI 里放宽：',
      ...hits.map((hit) => `  · ${hit}`),
    ].join('\n'),
  );
}

function assertPostgresServiceHealthy(file, problems) {
  assert.deepEqual(
    problems,
    [],
    [`真库 workflow \`${file}\` 的 \`services.postgres\` 不合格：`, ...problems.map((p) => `  · ${p}`)].join('\n'),
  );
}

function assertActionsPinned(hits) {
  assert.deepEqual(
    hits,
    [],
    [
      '有 workflow 的 `uses:` 没有固定到 40 位 SHA（浮标签会随上游发版改变 CI 语义）：',
      ...hits.map((hit) => `  · ${hit}`),
    ].join('\n'),
  );
}

function assertNoSwallowedFailures(hits) {
  assert.deepEqual(
    hits,
    [],
    [
      '真库 workflow 里有「吞红」构造：这一步失败却仍会被判绿，真库闸门等于没有。',
      '真库臂的红是唯一的验收信号，⛔ 不得用这些写法把它吞掉：',
      ...hits.map((hit) => `  · ${hit}`),
    ].join('\n'),
  );
}

function assertStepOrder(problems) {
  assert.deepEqual(
    problems,
    [],
    [
      `受管脚本在 \`${REAL_PG_WORKFLOW}\` 里的执行顺序与 \`REQUIRED_STEP_ORDER\` 不一致：`,
      ...problems.map((problem) => `  · ${problem}`),
      '',
      `期望顺序：${REQUIRED_STEP_ORDER.join(' → ')}`,
      '顺序是硬要求（不是审美）：`account-deletion-pg.mjs` 要求集群里没有同名角色并在收尾按快照差集清空；',
      '`admin-accounts-read-pg.mjs` 会把运行时角色＋6 个组角色**留在集群里**（收尾不 DROP）；',
      '`admin-jobs-pg.mjs` 与 `admin-flags-pg.mjs` 都**只接受自己本轮新建**的运行时角色（`preflightRuntimeRole`：'
        + '角色已存在即 exit=1 拒跑，⛔ 不再 `ALTER ROLE … PASSWORD` 接管），故两者都必须排在 `admin-accounts-read-pg.mjs` 之前。',
    ].join('\n'),
  );
}

function assertNoDatabaseGuardProblems(problems) {
  assert.deepEqual(
    problems,
    [],
    [
      `\`${REAL_PG_WORKFLOW}\` 的「先建库＋库名一致」判据不通过：`,
      ...problems.map((problem) => `  · ${problem}`),
      '',
      '每条受管脚本都要求**专用空库**：step 的 `run:` 必须是 `psql … CREATE DATABASE <库> && node <脚本>`，',
      '且 `<库>` 必须与该 step 真正传给脚本的库名一致（env `*_PG_TEST_URL` 的 path／argv URL 的 path／',
      '脚本内部硬钉常量，三种形态都要对上；只对一种会留下「改了 env 但 argv 还是旧库」这类假绿通道）。',
      '`SELF_CLUSTERED_SCRIPTS` 里的脚本例外：它自己 `initdb` 出临时集群，故改判「必须给 `GY_PG_BIN`／',
      '它**自己读的那个** `GY_*_PG_ROOT`（按 `SELF_CLUSTERED_ROOT_KEY` 映射并与脚本源码真值交叉核对，',
      '取值须落在 runner 临时目录；step 里出现脚本不读的其它 root 键也判红）、且 step 里不得出现 `CREATE DATABASE`」。',
    ].join('\n'),
  );
}

function assertManagedScriptSetMatches(problems) {
  assert.deepEqual(
    problems,
    [],
    [
      `\`${REAL_PG_WORKFLOW}\` 真正执行的 \`-pg.mjs\` 集合与 \`MANAGED_SCRIPTS\` 不双向相等：`,
      ...problems.map((problem) => `  · ${problem}`),
      '',
      '单向相等留了一个空档：把 `MANAGED_SCRIPTS` 与 `FROZEN_MANAGED_SCRIPTS` **同时**删掉一项，',
      '前向①「清单里的都接线了」与冻结清单同步都会绿，而那条脚本从此没人跑；',
      '反过来 workflow 里多跑一条不在清单里的脚本，判据③/④也不再覆盖它。反向的一半必须有人守。',
    ].join('\n'),
  );
}

// ── 磁盘真值 ────────────────────────────────────────────────────────────────────────────────

function listWorkflowFilesOnDisk() {
  return selectWorkflowFiles(readdirSync(join(REPO_ROOT, WORKFLOW_DIR))).map((name) => `${WORKFLOW_DIR}/${name}`);
}

function readWorkflow(file) {
  return { file, source: readFileSync(join(REPO_ROOT, file), 'utf8') };
}

function readAllWorkflows() {
  return listWorkflowFilesOnDisk().map((file) => {
    const { source } = readWorkflow(file);
    return { file, source, commands: runCommandTextsOf(source) };
  });
}

// ── 变异辅助（只给反向控制用；全部在**内存**里做，⛔ 不落盘） ────────────────────────────

/**
 * 某个 job 在源码行里的区间 `[start, end)`。
 * `end` 在**下一个同缩进的 job 头**（`^ {2}\S`）处收尾——⛔ 不能「一直删到文件末尾」：
 * 不设上界的话，单 job 假设会把后续每个 job 的 `services:` 一起删掉，于是「两个脚本拆成两个 job」
 * 这种合规形态反而报 2 条问题（审查实测 `expected: 1, actual: 2`）。
 */
function jobLineRange(source, jobId) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${jobId}:\\s*$`).test(line));
  assert.ok(start >= 0, `变异找不到 job \`${jobId}\``);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { lines, start, end };
}

/**
 * 只在指定 job 的行区间内做一次替换。
 * ⛔ 不用「文件里第一条／最后一条 `image:`」这种位置假设：一旦文件里有第二块 `services:`
 * （诱饵 job／拆成两个 job），位置假设的变异点就落在判据③**不看**的地方，自测会假红或假绿。
 */
function replaceWithinJob(source, jobId, pattern, replacement) {
  const { lines, start, end } = jobLineRange(source, jobId);
  let hits = 0;
  for (let index = start; index < end; index += 1) {
    const mutated = lines[index].replace(pattern, replacement);
    if (mutated === lines[index]) continue;
    lines[index] = mutated;
    hits += 1;
  }
  assert.equal(hits, 1, `变异必须在 job \`${jobId}\` 内正好命中一处（实际 ${hits} 处）：${pattern}`);
  return lines.join('\n');
}

/** job 里每个 step 的行区间（`^ {6}- ` 起头，到下一个缩进不深于 6 的非空行为止）。 */
function stepRanges(lines, start, end) {
  const ranges = [];
  for (let index = start; index < end; index += 1) {
    if (!/^ {6}- \S/.test(lines[index])) continue;
    let stop = index + 1;
    while (stop < end) {
      const line = lines[stop];
      if (line.trim() === '') {
        stop += 1;
        continue;
      }
      if (line.length - line.trimStart().length <= 6) break;
      stop += 1;
    }
    ranges.push({ start: index, end: stop });
    index = stop - 1;
  }
  return ranges;
}

/**
 * `jobId` 里执行 `script` 的那一个 step 的行区间 `{ start, end }`。
 * 为什么需要它：`replaceWithinJob` 只认「整个 job 里正好命中一处」——自 R28-E5 起 job 里有**两条**自起集群
 * 脚本、两段 `GY_PG_BIN` 逐字相同，job 级变异会命中两处而假红（`expected: 1, actual: 2`）。
 * 变异必须落在**被测脚本自己的 step** 里，判据的作用域才对得上。
 */
function stepRangeOfScript(source, jobId, script) {
  const { lines, start, end } = jobLineRange(source, jobId);
  const steps = stepRanges(lines, start, end);
  const found = steps.find((range) => lines.slice(range.start, range.end).join('\n').includes(`node ${script}`));
  assert.ok(found !== undefined, `变异找不到 \`${script}\` 的 step`);
  return { lines, range: found };
}

/** 只在 `script` 自己的 step 区间内做一次替换（命中数必须正好 1）。 */
function replaceWithinStep(source, jobId, script, pattern, replacement) {
  const { lines, range } = stepRangeOfScript(source, jobId, script);
  let hits = 0;
  for (let index = range.start; index < range.end; index += 1) {
    const mutated = lines[index].replace(pattern, replacement);
    if (mutated === lines[index]) continue;
    lines[index] = mutated;
    hits += 1;
  }
  assert.equal(hits, 1, `变异必须在 \`${script}\` 的 step 内正好命中一处（实际 ${hits} 处）：${pattern}`);
  return lines.join('\n');
}

/** 整段删掉 `script` 自己的 step（模拟「有人把这一条从 workflow 里拿掉」）。 */
function withoutScriptStep(source, jobId, script) {
  const { lines, range } = stepRangeOfScript(source, jobId, script);
  return [...lines.slice(0, range.start), ...lines.slice(range.end)].join('\n');
}

/**
 * 把 `laterScript` 的整段 step（`- run:` ＋ 它的 `env:`）挪到 `earlierScript` 的 step 之前。
 * 只给顺序判据的反向控制用：模拟「有人为了排错把两步对调」。
 */
function withSwappedSteps(source, jobId, earlierScript, laterScript) {
  const { lines, start, end } = jobLineRange(source, jobId);
  const steps = stepRanges(lines, start, end);
  const textOf = (range) => lines.slice(range.start, range.end).join('\n');
  const earlier = steps.find((range) => textOf(range).includes(`node ${earlierScript}`));
  const later = steps.find((range) => textOf(range).includes(`node ${laterScript}`));
  assert.ok(earlier !== undefined, `变异找不到 \`${earlierScript}\` 的 step`);
  assert.ok(later !== undefined, `变异找不到 \`${laterScript}\` 的 step`);
  assert.ok(earlier.start < later.start, `变异前提：\`${earlierScript}\` 原本必须在 \`${laterScript}\` 之前`);
  const mutated = [
    ...lines.slice(0, earlier.start),
    ...lines.slice(later.start, later.end),
    ...lines.slice(earlier.start, later.start),
    ...lines.slice(later.end),
  ].join('\n');
  assert.notEqual(mutated, source, '对调 step 必须真的改到文本');
  return mutated;
}

/**
 * 把单 job 形态拆成**两个 job**（每个 job 各跑一个受管脚本、各自一块合规 `services:`）。
 * 这是本 workflow 最自然的下一步演进（文件头 docstring 已点名「把两个脚本拆成两个 job」）：
 * 拆完必须**仍然绿**，⛔ 否则守卫会反过来挡住一次正当的重构。
 * 两个 job 的 id 由调用方从 `jobsRunningManagedScripts()` 取，⛔ 不硬写字面量。
 * 返回 `null` 表示**文件本来就是**「两个 job 各跑一个脚本」的形态（拆 job 已经做完）——
 * 这时调用方直接拿磁盘形态当被测形态，⛔ 不要硬拆第二次。
 */
function withSplitJobs(source, primaryId, secondId) {
  const { lines, start, end } = jobLineRange(source, primaryId);
  const steps = stepRanges(lines, start, end);
  const stepOf = (script) => steps.find((range) => lines.slice(range.start, range.end).join('\n').includes(script));
  const conversations = stepOf(MANAGED_SCRIPTS[0]);
  const community = stepOf(MANAGED_SCRIPTS[1]);
  if (conversations === undefined || community === undefined) return null;
  assert.ok(conversations.end <= community.start, '两个受管脚本的 step 顺序变了，拆 job 的构造需要重写');

  const bodyWithout = (range) => lines
    .slice(start + 1, end)
    .filter((line, offset) => {
      const index = start + 1 + offset;
      return index < range.start || index >= range.end;
    });

  const firstJob = [lines[start], ...bodyWithout(community)];
  const secondJob = [`  ${secondId}:`, ...bodyWithout(conversations)];
  const mutated = [...lines.slice(0, start), ...firstJob, ...secondJob, ...lines.slice(end)].join('\n');
  assert.notEqual(mutated, source, '双 job 构造必须真的改到文本');
  assert.equal(jobsOf(mutated).length, jobsOf(source).length + 1, '拆 job 必须只多出一个 job');
  return mutated;
}

/** 在 `jobs:` 之后插一个**自带合规 `postgres:17.11`** 的诱饵 job（模拟「先把诱饵放前面」）。 */
function withDecoyJob(source) {
  const decoy = [
    '  zz-decoy:',
    '    runs-on: ubuntu-24.04',
    '    services:',
    '      postgres:',
    '        image: postgres:17.11',
    '    steps:',
    '      - run: echo noop',
  ].join('\n');
  const mutated = source.replace(/^jobs:\n/m, `jobs:\n${decoy}\n`);
  assert.notEqual(mutated, source, '诱饵 job 必须真的插进文本');
  return mutated;
}

/** 删掉指定 job **自己的** `services:` 段（只在该 job 的行范围内动手，⛔ 不碰别的 job 的同名段）。 */
function withoutJobServices(source, jobId) {
  const { lines, start, end } = jobLineRange(source, jobId);
  const kept = [];
  let dropping = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // job 区间之外一律原样保留 ⇒ 后续 job 的同名 `services:` 段不会被连带删掉（上界）。
    if (index < start || index >= end) {
      dropping = false;
      kept.push(line);
      continue;
    }
    if (!dropping && /^ {4}services:\s*$/.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping) {
      if (line.trim() === '' || /^ {5,}\S/.test(line)) continue;
      dropping = false;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

// ── 用例 ────────────────────────────────────────────────────────────────────────────────────

test('前向①：两个受管真库脚本都被某个 workflow 的 `run:` 真跑', () => {
  const workflows = readAllWorkflows();

  assertManagedScriptsWired(missingManagedScripts({ workflows }));

  // 反空转：扫到的 workflow 数、命令块数、受管清单都必须非空——否则「什么都没扫」也会绿。
  assert.ok(workflows.length >= 11, `只扫到 ${workflows.length} 个 workflow，判据可能已失效`);
  assert.ok(
    workflows.reduce((sum, workflow) => sum + workflow.commands.length, 0) >= 5,
    '扫到的 `run:` 命令块太少，解析口径可能已失效',
  );
  assert.ok(MANAGED_SCRIPTS.length >= 2, '受管清单为空或塌缩，本守卫会变成永远绿');
  // 冻结：增删受管脚本＝改门禁口径，必须留下可审的 diff。
  assert.deepEqual([...MANAGED_SCRIPTS].sort(), [...FROZEN_MANAGED_SCRIPTS].sort(), '受管脚本清单被改动但未同步冻结清单');
  // 受管脚本必须真实存在（改名/删除后这条会红，逼人一并更新清单而不是留个悬空引用）。
  for (const script of MANAGED_SCRIPTS) {
    assert.doesNotThrow(() => readFileSync(join(REPO_ROOT, script), 'utf8'), `受管脚本 ${script} 不存在`);
  }
});

test('反向控制①：删掉某脚本的 `run:` 行，同一断言必须红并点名它', () => {
  const workflows = readAllWorkflows();
  const target = 'tests/integration/conversations-pg.mjs';
  const witness = 'tests/integration/community-pg.mjs';
  const real = workflows.find((workflow) => workflow.file === REAL_PG_WORKFLOW);
  assert.ok(real !== undefined, `磁盘上找不到 ${REAL_PG_WORKFLOW}（本片的核心交付物）`);

  // 只在内存里变异：删掉提到目标脚本的那一行（模拟「有人把这一步删了」）。
  const mutatedSource = real.source
    .split('\n')
    .filter((line) => !line.includes(`node ${target}`))
    .join('\n');
  assert.notEqual(mutatedSource, real.source, '变异必须真的改到文本（否则反向控制是空转）');
  assert.ok(mutatedSource.includes(witness), '变异只许打断一个脚本，另一个必须仍是绿的');

  const mutated = workflows.map((workflow) =>
    workflow.file === REAL_PG_WORKFLOW
      ? { ...workflow, source: mutatedSource, commands: runCommandTextsOf(mutatedSource) }
      : workflow,
  );
  assert.deepEqual(
    missingManagedScripts({ workflows: mutated }),
    [target],
    '删掉 run 行后必须且只能点名被删的那个脚本',
  );
  assert.throws(
    () => assertManagedScriptsWired(missingManagedScripts({ workflows: mutated })),
    (error) => error.message.includes(target),
    '删掉 run 行后同一断言必须失败，且失败消息要点名该脚本',
  );

  // 不永红：只把脚本名写进注释也救不了（注释不是命令）。
  const commentOnly = [{
    file: REAL_PG_WORKFLOW,
    commands: runCommandTextsOf(`jobs:\n  x:\n    steps:\n      # - run: node ${target}\n      - run: echo hi\n`),
  }];
  assert.deepEqual(
    missingManagedScripts({ workflows: commentOnly, managed: [target] }),
    [target],
    '注释里的 `run:` 不算接线（否则守卫可被一句注释糊弄）',
  );
  // 而真的写成 `run:` 命令就立刻转绿（证明「接线」这个出口真的可走通）。
  const wired = [{
    file: REAL_PG_WORKFLOW,
    commands: runCommandTextsOf(`jobs:\n  x:\n    steps:\n      - run: node ${target}\n`),
  }];
  assert.deepEqual(missingManagedScripts({ workflows: wired, managed: [target] }), []);
});

test('前向②：任何 workflow 都不得含「放宽跳过」开关', () => {
  const hits = readAllWorkflows().flatMap((workflow) => escapeHatchHits(workflow));
  assertNoEscapeHatches(hits);
});

test('反向控制②：往 workflow 里加 `GY_ALLOW_SKIP` 或 `--allow-skip`，同一断言必须红并点名文件', () => {
  const workflows = readAllWorkflows();
  assertNoEscapeHatches(workflows.flatMap((workflow) => escapeHatchHits(workflow)));

  for (const token of FORBIDDEN_ESCAPE_HATCHES) {
    // 只在内存里注入：模拟「有人为了让 job 变绿加了一行开关」。
    const mutatedSource = `${workflows.find((workflow) => workflow.file === REAL_PG_WORKFLOW).source}\n# ${token}\n`;
    const hits = escapeHatchHits({ file: REAL_PG_WORKFLOW, source: mutatedSource });
    assert.equal(hits.length, 1, `注入 ${token} 后必须正好命中一处`);
    assert.ok(hits[0].includes(REAL_PG_WORKFLOW), `失败信息必须点名文件（${token}）`);
    assert.throws(
      () => assertNoEscapeHatches(hits),
      (error) => error.message.includes(token),
      `注入 ${token} 后同一断言必须失败，且消息里要出现该开关`,
    );
  }

  // 不误伤：语义相反的合法文字（「不得放宽」）不得被当成开关。
  assert.deepEqual(escapeHatchHits({ file: REAL_PG_WORKFLOW, source: '# 缺库必须以 77 红掉，不得放宽\n' }), []);
});

test('前向③：真 job 有 `services.postgres`，镜像主版本锚定 17，且 `uses:` 全部固定 SHA', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);

  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(source));
  assertActionsPinned(unpinnedUses({ file: REAL_PG_WORKFLOW, source }));

  // 反空转：必须真的解析到 job / 镜像行 / uses 行，否则上面的「无问题」只是没解析到东西。
  assert.ok(jobsOf(source).length >= 1, `${REAL_PG_WORKFLOW} 解析不到任何 job，判据③失去作用域`);
  assert.ok(
    jobsRunningManagedScripts(source).length >= 1,
    '没有任何 job 被判定为「真跑受管脚本」，判据③等于没扫到东西',
  );
  assert.match(source, /^\s+image:\s*postgres:17/m, `${REAL_PG_WORKFLOW} 里找不到 \`image: postgres:17…\``);
  assert.match(source, /(?:^|\s)uses:\s/m, `${REAL_PG_WORKFLOW} 里找不到任何 \`uses:\``);
  // 真库 job 必须在 runner 上有 psql 可用（建专用空库那一步依赖它，与 `consent-grant-postgres.yml` 同构）。
  const commands = runCommandTextsOf(source);
  assert.ok(commands.some((command) => command.includes('psql')), '真库 workflow 必须在某个 `run:` 里用 psql 建专用库');
  assert.ok(commands.some((command) => command.includes('npm ci')), '真库 workflow 必须装依赖');
});

test('前向④：真库 workflow 不得含「吞红」构造（`continue-on-error` / `if:` / `|| true`）', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertNoSwallowedFailures(swallowedFailureHits({ file: REAL_PG_WORKFLOW, source }));

  // 反向控制（内存变异）：三种吞红写法各自必须被判红，并点名文件与行号。
  for (const [label, line] of [
    ['continue-on-error', '        continue-on-error: true'],
    ['if', '        if: false'],
    ['or-true', '      - run: node tests/integration/community-pg.mjs || true'],
  ]) {
    const mutated = `${source}\n${line}\n`;
    const hits = swallowedFailureHits({ file: REAL_PG_WORKFLOW, source: mutated });
    assert.equal(hits.length, 1, `注入 ${label} 后必须正好命中一处`);
    assert.ok(hits[0].includes(REAL_PG_WORKFLOW), `失败信息必须点名文件（${label}）`);
    assert.throws(
      () => assertNoSwallowedFailures(hits),
      (error) => error.message.includes(REAL_PG_WORKFLOW) && error.message.includes('吞红'),
      `注入 ${label} 后同一断言必须失败，且消息点名文件`,
    );
  }
  // 不误伤：注释里提到这些写法不算（注释不是命令）。
  assert.deepEqual(
    swallowedFailureHits({ file: REAL_PG_WORKFLOW, source: '# 本 job 不得用 continue-on-error / if: / || true\n' }),
    [],
  );
});

test('反向控制③：镜像降到 16 / 删掉 services / 换成浮标签，同一断言必须红', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(source));

  // 变异点必须落在「真跑受管脚本的 job」的 body 里，job id 也从实现取——
  // 文件里出现第二块 `services:`（诱饵 job／把两个脚本拆成两个 job）时，
  // 「文件里第一条／最后一条 `image:`」就不是判据③看的那个 job，
  // 变异会落在判据**不看**的地方（审查 §3-2 B0：合规诱饵反而让套件红 `actual: 0`）。
  const runningJobs = jobsRunningManagedScripts(source);
  assert.ok(runningJobs.length >= 1, '判据③ 没找到「真跑受管脚本的 job」，下面的变异没有作用域');
  const realJobId = runningJobs[0].id;

  // ① 主版本降级：17.11 → 16.4（只降**真 job** 的那一行）。
  const downgraded = replaceWithinJob(source, realJobId, /image:\s*postgres:17[^\s]*/, 'image: postgres:16.4');
  assert.notEqual(downgraded, source, '变异必须真的改到镜像行');
  const downgradeProblems = postgresJobProblems(downgraded);
  assert.equal(downgradeProblems.length, 1, '降级必须且只能报一条问题');
  assert.ok(downgradeProblems[0].includes(`\`${realJobId}\``), '问题描述必须点名真 job');
  assert.ok(downgradeProblems[0].includes('16'), '问题描述必须写出实际主版本');
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, downgradeProblems),
    (error) => error.message.includes(REAL_PG_WORKFLOW),
    '降级后同一断言必须失败，且消息点名文件',
  );

  // ② 删掉**真 job 自己的** `services:` 段（模拟「有人嫌 CI 慢把 service 去掉」）。
  const withoutServices = withoutJobServices(source, realJobId);
  assert.notEqual(withoutServices, source, '变异必须真的删到 services 段');
  const missingServicesProblems = postgresJobProblems(withoutServices);
  assert.ok(
    missingServicesProblems.length > 0,
    '删掉 service 段后必须报问题（否则 `services` 缺失可以被静默忽略）',
  );
  assert.equal(missingServicesProblems.length, 1, '删 services 必须且只能报一条问题（否则红可能来自别的 job）');
  assert.ok(missingServicesProblems[0].includes(`\`${realJobId}\``), '删 services 的问题必须点名真 job');
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, missingServicesProblems),
    (error) => error.message.includes(REAL_PG_WORKFLOW),
    '删掉 service 段后同一断言必须失败，且消息点名文件',
  );

  // ③ 浮标签：把固定 SHA 换成 `@v4`。
  const floating = source.replace(/uses:\s*actions\/checkout@[0-9a-f]{40}/, 'uses: actions/checkout@v4');
  assert.notEqual(floating, source, '变异必须真的改到 uses 行');
  const floatingHits = unpinnedUses({ file: REAL_PG_WORKFLOW, source: floating });
  assert.equal(floatingHits.length, 1, '换成浮标签后必须且只能命中一处');
  assert.throws(
    () => assertActionsPinned(floatingHits),
    (error) => error.message.includes('actions/checkout@v4'),
    '浮标签必须让同一断言失败，且消息点名那条引用',
  );
});

test('反向控制①b：`run: |` 块体里把调用写成 shell 注释，判据①必须判红', () => {
  const target = 'tests/integration/conversations-pg.mjs';
  const witness = 'tests/integration/community-pg.mjs';
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertManagedScriptsWired(missingManagedScripts({ workflows: readAllWorkflows() }));

  // ① 合成形态：块标量体里只有 `# node <脚本>` + `echo hi` ⇒ 不得被当成接线。
  const commentedBlock = [
    'jobs:',
    '  real-pg-17-11:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - run: |',
    `          # node ${target}`,
    '          echo hi',
  ].join('\n');
  const commentedCommands = runCommandTextsOf(commentedBlock);
  assert.equal(
    commentedCommands.some((command) => command.includes(target)),
    false,
    '`run: |` 块体里的 `#` 行是 shell 注释，不得进入命令文本',
  );
  const missing = missingManagedScripts({
    workflows: [{ file: REAL_PG_WORKFLOW, commands: commentedCommands }],
    managed: [target],
  });
  assert.deepEqual(missing, [target], '块内注释不得算接线');
  assert.throws(
    () => assertManagedScriptsWired(missing),
    (error) => error.message.includes(target),
    '块内注释未接线时同一断言必须失败，且消息点名该脚本',
  );

  // ② 不永红：把块里的调用**取消注释**（真成一行命令）⇒ 判据①转绿。
  const uncommentedBlock = commentedBlock.replace(`# node ${target}`, `node ${target}`);
  assert.deepEqual(
    missingManagedScripts({
      workflows: [{ file: REAL_PG_WORKFLOW, commands: runCommandTextsOf(uncommentedBlock) }],
      managed: [target],
    }),
    [],
    '块体里真写成一行命令时必须算接线（证明这条反向控制的绿出口真的存在）',
  );

  // ③ 对**真文件**做同一改造：把会话链那一行换成「只含 shell 注释的 `run: |` 块」⇒ 必须点名该脚本。
  const mutatedSource = source
    .split('\n')
    .map((line) => (line.includes(`node ${target}`)
      ? ['      - run: |', `          # node ${target}`, '          echo hi'].join('\n')
      : line))
    .join('\n');
  assert.notEqual(mutatedSource, source, '变异必须真的改到真 workflow 的那一行');
  assert.ok(mutatedSource.includes(witness), '变异只许打断一个脚本，另一个必须仍是绿的');
  const mutatedMissing = missingManagedScripts({
    workflows: [{ file: REAL_PG_WORKFLOW, commands: runCommandTextsOf(mutatedSource) }],
    managed: [target, witness],
  });
  assert.deepEqual(mutatedMissing, [target], '对真文件做同样的「注释化」后必须且只能点名被注释的那个脚本');
  assert.throws(
    () => assertManagedScriptsWired(mutatedMissing),
    (error) => error.message.includes(target),
    '真文件被注释化后同一断言必须失败，且消息点名该脚本',
  );
});

test('反向控制④：真 job 前插**合规诱饵 job**，真 job 镜像降到 16.4 ⇒ 判据③必须判红（锚定真 job）', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(source));
  const runningJobs = jobsRunningManagedScripts(source);
  assert.ok(runningJobs.length >= 1, '判据③ 没找到「真跑受管脚本的 job」');
  const realJobId = runningJobs[0].id;

  const withDecoy = withDecoyJob(source);
  const decoy = jobsOf(withDecoy).find((job) => job.id === 'zz-decoy');
  assert.ok(decoy !== undefined, '诱饵 job 没被解析到（判据③的作用域解析坏了）');
  // 诱饵自身合规 ⇒「只看文件里第一个 `services:`」的实现会读到它并判绿——这正是要堵的假绿通道。
  assert.deepEqual(
    postgresServiceProblems(decoy.body),
    [],
    '诱饵 job 自身必须合规，否则这条反向控制没有证明力',
  );
  // 只插诱饵、真 job 不动 ⇒ 仍绿（不误伤）。**v2 在这里假红过**（`actual: 0`）：变异点落在诱饵身上。
  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(withDecoy));

  // 只降级**真 job** 的那一行（⛔ 不用「文件里最后一条 `image:`」——那是位置假设），诱饵保持 17.11。
  const decoyPlusDowngrade = replaceWithinJob(withDecoy, realJobId, /image:\s*postgres:17\.11/, 'image: postgres:16.4');
  assert.notEqual(decoyPlusDowngrade, withDecoy, '变异必须真的改到真 job 的镜像行');
  assert.ok(decoyPlusDowngrade.includes('image: postgres:17.11'), '诱饵的 17.11 必须保留（否则红可能来自诱饵）');
  assert.deepEqual(
    postgresServiceProblems(jobsOf(decoyPlusDowngrade).find((job) => job.id === 'zz-decoy').body),
    [],
    '诱饵仍必须合规：这个红只能来自真 job',
  );

  const problems = postgresJobProblems(decoyPlusDowngrade);
  assert.equal(problems.length, 1, '降级必须且只能报一条问题（否则红可能来自诱饵）');
  assert.ok(problems[0].includes(`\`${realJobId}\``), '失败消息必须点名**真 job**');
  assert.ok(problems[0].includes('16'), '失败消息必须写出实际主版本');
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, problems),
    (error) => error.message.includes(REAL_PG_WORKFLOW) && error.message.includes(realJobId),
    '诱饵 + 真 job 降级后同一断言必须失败，且消息点名文件与真 job',
  );

  // 裁定（派单 `real-pg-ci-fix2-20261020.md` §1-②）：**不跑受管脚本的 job 不在门禁范围**。
  // 诱饵 job 自己把镜像降到 16.4、甚至整段删掉 `services:`，都不构成真实风险——它不跑任何受管脚本，
  // 坏镜像不影响任何一条断言。⛔ 因此判据③**不**扩成「文件里每个 `services:` 块都要合规」
  // （那会让以后往这个 workflow 加任何非真库 job 都变红，属机械门禁把人推向更差设计）。
  // 下面两条把这条裁定的边界钉成机器读数，防止有人把它改回机械全量扫描。
  const decoyDowngraded = replaceWithinJob(withDecoy, 'zz-decoy', /image:\s*postgres:17\.11/, 'image: postgres:16.4');
  assert.deepEqual(postgresJobProblems(decoyDowngraded), [], '不跑受管脚本的诱饵 job 不在判据③范围（裁定②）');
  assert.deepEqual(
    postgresJobProblems(withoutJobServices(withDecoy, 'zz-decoy')),
    [],
    '诱饵 job 连 `services:` 一起删掉也不该红（裁定②：不在范围）',
  );
});

test('反向控制⑤：真 job 前插**合规诱饵 job**，真 job 删掉 `services` ⇒ 判据③必须判红（锚定真 job）', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  const runningJobs = jobsRunningManagedScripts(source);
  assert.ok(runningJobs.length >= 1, '判据③ 没找到「真跑受管脚本的 job」');
  const realJobId = runningJobs[0].id;

  const withDecoy = withDecoyJob(source);
  const decoyMinusRealServices = withoutJobServices(withDecoy, realJobId);
  assert.notEqual(decoyMinusRealServices, withDecoy, '变异必须真的删到真 job 的 services 段');

  // 诱饵的 `services` 必须原样保留且仍合规 ⇒ 这个红只能来自「真 job 没有 services」。
  const decoy = jobsOf(decoyMinusRealServices).find((job) => job.id === 'zz-decoy');
  assert.ok(decoy !== undefined, '诱饵 job 没被解析到');
  assert.deepEqual(
    postgresServiceProblems(decoy.body),
    [],
    '诱饵必须仍保留合规的 services，否则这条反向控制没有证明力',
  );

  const problems = postgresJobProblems(decoyMinusRealServices);
  assert.equal(problems.length, 1, '删 services 必须且只能报一条问题（否则红可能来自诱饵）');
  assert.ok(problems[0].includes(`\`${realJobId}\``), '失败消息必须点名**真 job**');
  assert.ok(problems[0].includes('services'), '失败消息必须指出缺的是 services');
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, problems),
    (error) => error.message.includes(REAL_PG_WORKFLOW) && error.message.includes(realJobId),
    '诱饵 + 真 job 删 services 后同一断言必须失败，且消息点名文件与真 job',
  );
});

test('反向控制⑥：两个脚本拆成两个 job 必须仍绿；只降**第二个 job** 的镜像必须红并点名它', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(source));
  const runningJobs = jobsRunningManagedScripts(source);
  assert.ok(runningJobs.length >= 1, '判据③ 没找到「真跑受管脚本的 job」');

  // 构造双 job 形态；若文件**本来就已经**拆成两个 job（每个各跑一个脚本），直接拿磁盘形态当被测形态。
  const primaryId = runningJobs[0].id;
  const split = withSplitJobs(source, primaryId, `${primaryId}-community`);
  const form = split === null ? source : split;
  const formJobIds = jobsRunningManagedScripts(form).map((job) => job.id);
  const firstId = formJobIds[0];
  const secondId = formJobIds[formJobIds.length - 1];
  assert.ok(formJobIds.length >= 2, '被测形态必须是「两个 job 各跑一个受管脚本」');
  assert.notEqual(firstId, secondId, '两个 job 的 id 必须不同（否则「点名第二个 job」没有意义）');

  // ① **合规的双 job 形态必须绿**：v2 在这里假红过两次（保留原 job id ⇒ `pass 9 / fail 1`
  // `删 services 必须且只能报一条问题 expected: 1, actual: 2`；两个 job 改名 ⇒ `pass 7 / fail 3`）。
  // 判据③ 本来就是 job 作用域的，假红来自测试文件的单 job 假设。
  assertPostgresServiceHealthy(REAL_PG_WORKFLOW, postgresJobProblems(form));
  for (const job of jobsRunningManagedScripts(form)) {
    assert.deepEqual(postgresServiceProblems(job.body), [], `job \`${job.id}\` 自身的 \`services:\` 必须合规`);
  }

  // ② 只降**第二个 job** 的镜像 ⇒ 必须红，且消息点名第二个 job（判据已支持，v2 缺的就是这条用例）。
  const secondDowngraded = replaceWithinJob(form, secondId, /image:\s*postgres:17[^\s]*/, 'image: postgres:16.4');
  const problems = postgresJobProblems(secondDowngraded);
  assert.equal(problems.length, 1, '只降第二个 job 必须且只能报一条问题');
  assert.ok(problems[0].includes(`\`${secondId}\``), '失败消息必须点名**第二个 job**');
  assert.ok(!problems[0].includes(`\`${firstId}\``), '失败消息不得误指第一个 job');
  assert.throws(
    () => assertPostgresServiceHealthy(REAL_PG_WORKFLOW, problems),
    (error) => error.message.includes(secondId) && error.message.includes('16'),
    '双 job 形态下第二个 job 被降级后同一断言必须失败，且消息点名它',
  );

  // ③ 只删**第二个 job** 的 `services:` ⇒ 必须且只能报一条，且第一个 job 的 `services:` 原样保留。
  //    （v2 的 `withoutJobServices` 不设上界，在双 job 形态里会把两个 job 的 `services:` 都删掉。）
  const secondWithoutServices = withoutJobServices(form, secondId);
  assert.notEqual(secondWithoutServices, form, '变异必须真的删到第二个 job 的 services 段');
  const splitProblems = postgresJobProblems(secondWithoutServices);
  assert.equal(splitProblems.length, 1, '删第二个 job 的 services 必须且只能报一条问题');
  assert.ok(splitProblems[0].includes(`\`${secondId}\``), '失败消息必须点名第二个 job');
  assert.deepEqual(
    postgresServiceProblems(jobsOf(secondWithoutServices).find((job) => job.id === firstId).body),
    [],
    '删第二个 job 的 `services:` 不得碰到第一个 job（变异的行区间上界）',
  );

  // ④ 反过来只删**第一个 job** 的 `services:` ⇒ 同样只报一条、点名第一个 job，第二个 job 不受影响。
  const firstWithoutServices = withoutJobServices(form, firstId);
  const firstProblems = postgresJobProblems(firstWithoutServices);
  assert.equal(firstProblems.length, 1, '删第一个 job 的 services 必须且只能报一条问题');
  assert.ok(firstProblems[0].includes(`\`${firstId}\``), '失败消息必须点名第一个 job');
  assert.deepEqual(
    postgresServiceProblems(jobsOf(firstWithoutServices).find((job) => job.id === secondId).body),
    [],
    '删第一个 job 的 `services:` 不得碰到第二个 job',
  );
});

test('反向控制⑦：R27-S4 追加的两条受管脚本，删掉各自的 `run:` 行后必须逐条点名（且只点名它）', () => {
  const workflows = readAllWorkflows();
  const added = [
    'tests/integration/messages-pg.mjs',
    'tests/integration/favorites-history-pg.mjs',
  ];
  // 先证明磁盘真值是绿的：否则下面的「删了就红」可能只是继承了一个已经红掉的前提。
  assertManagedScriptsWired(missingManagedScripts({ workflows }));

  const real = workflows.find((workflow) => workflow.file === REAL_PG_WORKFLOW);
  assert.ok(real !== undefined, `磁盘上找不到 ${REAL_PG_WORKFLOW}`);

  for (const target of added) {
    const witness = added.find((script) => script !== target);
    // 只在内存里变异：删掉提到该脚本的那一行（模拟「有人把这一步删了」）。
    const mutatedSource = real.source
      .split('\n')
      .filter((line) => !line.includes(`node ${target}`))
      .join('\n');
    assert.notEqual(mutatedSource, real.source, `删 ${target} 的步骤必须真的改到文本（否则反向控制是空转）`);
    assert.ok(mutatedSource.includes(`node ${witness}`), `变异只许打断 ${target}，${witness} 必须仍是绿的`);

    const mutated = workflows.map((workflow) => (workflow.file === REAL_PG_WORKFLOW
      ? { ...workflow, source: mutatedSource, commands: runCommandTextsOf(mutatedSource) }
      : workflow));
    assert.deepEqual(
      missingManagedScripts({ workflows: mutated }),
      [target],
      `删掉 ${target} 的 \`run:\` 行后必须且只能点名它（其它受管脚本仍必须算已接线）`,
    );
    assert.throws(
      () => assertManagedScriptsWired(missingManagedScripts({ workflows: mutated })),
      (error) => error.message.includes(target),
      `删掉 ${target} 的 \`run:\` 行后同一断言必须失败，且失败消息要点名该脚本`,
    );
  }

  // 两条都删 ⇒ 点名集合必须恰好是这两条（证明两条各自独立受管，不互相遮蔽）。
  const bothRemoved = real.source
    .split('\n')
    .filter((line) => !added.some((script) => line.includes(`node ${script}`)))
    .join('\n');
  assert.notEqual(bothRemoved, real.source, '两条都删的变异必须真的改到文本');
  const bothMutated = workflows.map((workflow) => (workflow.file === REAL_PG_WORKFLOW
    ? { ...workflow, source: bothRemoved, commands: runCommandTextsOf(bothRemoved) }
    : workflow));
  assert.deepEqual(
    missingManagedScripts({ workflows: bothMutated }),
    [...added].sort(),
    '两条都删掉时必须正好点名这两条',
  );
});

test('前向⑤（判据⑥）：受管脚本在 workflow 里的执行顺序必须与 REQUIRED_STEP_ORDER 一致', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertStepOrder(stepOrderProblems({ source }));

  // 顺序表不能与受管清单脱钩：集合不同 ⇒ 顺序判据会悄悄漏掉一条（或要求一条根本不存在的脚本）。
  assert.deepEqual(
    [...REQUIRED_STEP_ORDER].sort(),
    [...MANAGED_SCRIPTS].sort(),
    'REQUIRED_STEP_ORDER 与 MANAGED_SCRIPTS 必须同集合（只允许顺序不同）',
  );

  // 顺序判据必须**逐个**看到它在 workflow 里的位置：断言对象数与清单数相等（防止 findIndex 全部命中同一步）。
  const commands = runCommandTextsOf(source);
  const indices = REQUIRED_STEP_ORDER.map((script) => commands.findIndex((command) => command.includes(`node ${script}`)));
  assert.equal(new Set(indices).size, REQUIRED_STEP_ORDER.length, '每个受管脚本必须落在**不同**的 step 里，顺序判据才有对象');
});

test('前向⑥（判据⑦＋⑧）：每个受管脚本所在 step 先 CREATE DATABASE 再 node，且库名与该 step 传入的一致', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertNoDatabaseGuardProblems(databaseGuardProblems(source));

  // 「三种入参形态都覆盖」不能只是措辞：逐条统计真实 workflow 里每种形态各出现几次。
  const shapes = { envUrl: 0, argvUrl: 0, pinnedConstant: 0, selfCluster: 0 };
  for (const script of MANAGED_SCRIPTS) {
    const found = stepRunningScript(source, script);
    assert.ok(found !== null, `workflow 里找不到 \`${script}\` 的 step`);
    if (/^\s+[A-Z0-9_]+_PG_TEST_URL\s*:\s*\S+\s*$/m.test(found.step)) shapes.envUrl += 1;
    const marker = `node ${script}`;
    const argumentsText = found.command.slice(found.command.indexOf(marker) + marker.length);
    if (/postgres(?:ql)?:\/\/\S+/.test(argumentsText)) shapes.argvUrl += 1;
    const pinned = pinnedDatabaseNames(readFileSync(join(REPO_ROOT, script), 'utf8'));
    if (pinned.length > 0) shapes.pinnedConstant += 1;
    if (SELF_CLUSTERED_SCRIPTS.includes(script)) shapes.selfCluster += 1;
  }
  assert.ok(shapes.envUrl >= 1, `env URL 形态必须真的被测到（实际 ${shapes.envUrl} 条）`);
  assert.ok(shapes.argvUrl >= 1, `argv URL 形态必须真的被测到（实际 ${shapes.argvUrl} 条）`);
  assert.ok(shapes.pinnedConstant >= 1, `脚本硬钉常量形态必须真的被测到（实际 ${shapes.pinnedConstant} 条）`);
  // 自起集群豁免表不能自己长大：每条都必须在受管清单里，且统计数与表长逐一对上。
  assert.deepEqual(
    SELF_CLUSTERED_SCRIPTS.filter((script) => !MANAGED_SCRIPTS.includes(script)),
    [],
    'SELF_CLUSTERED_SCRIPTS 里出现了不在 MANAGED_SCRIPTS 的脚本（豁免只能给受管脚本用）',
  );
  assert.equal(
    shapes.selfCluster,
    SELF_CLUSTERED_SCRIPTS.length,
    `SELF_CLUSTERED_SCRIPTS 的每条都必须真的在 workflow 里被数到（实际 ${shapes.selfCluster} / 表长 ${SELF_CLUSTERED_SCRIPTS.length}）`,
  );
  // 每条受管脚本都必须至少有一种**外部入参**形态可核对（env／argv／自起集群专用 env 三选一；
  // 只靠脚本硬钉常量等于没核对 workflow 传了什么）。
  assert.ok(
    shapes.envUrl + shapes.argvUrl + shapes.selfCluster >= MANAGED_SCRIPTS.length,
    `每条受管脚本都必须至少命中 env／argv／自起集群 env 之一（实际 env ${shapes.envUrl} + argv ${shapes.argvUrl}`
    + ` + self ${shapes.selfCluster} < ${MANAGED_SCRIPTS.length}）`,
  );
});

test('前向⑦（判据⑨）：workflow 里执行的 `-pg.mjs`／`-e2e.mjs` 集合与 MANAGED_SCRIPTS 双向相等', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  assertManagedScriptSetMatches(managedScriptSetProblems({ source }));
  assert.deepEqual(
    scriptsRunByWorkflow(source),
    [...MANAGED_SCRIPTS].sort(),
    '双向相等：workflow 真跑的 `-pg.mjs`／`-e2e.mjs` 必须与受管清单逐个对上（多一条、少一条都红）',
  );
  // 作用域只锚 real-pg workflow：其它 workflow 各跑自己的 `-pg.mjs`（独立 job／独立库），不属本清单。
  assert.deepEqual(
    selectWorkflowFiles(readdirSync(join(REPO_ROOT, WORKFLOW_DIR))).filter((name) => name === REAL_PG_WORKFLOW.split('/').pop()),
    [REAL_PG_WORKFLOW.split('/').pop()],
    'REAL_PG_WORKFLOW 必须真的在磁盘的 workflow 名单里（否则前两条断言在空集合上永绿）',
  );
});

test('反向控制⑧：判据⑥⑦⑧⑨ 各自的变异都必须红，且消息能定位到脚本/库名', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  const realJobId = jobsRunningManagedScripts(source)[0].id;
  const deletion = 'tests/integration/account-deletion-pg.mjs';
  const accountsRead = 'tests/integration/admin-accounts-read-pg.mjs';
  const messages = 'tests/integration/messages-pg.mjs';
  const flags = 'tests/integration/admin-flags-pg.mjs';
  const backupPurge = 'tests/integration/backup-purge-pg.mjs';

  // 0) 先证明磁盘真值三条判据全绿：否则下面的「变异就红」可能只是继承了一个已红的前提。
  assertStepOrder(stepOrderProblems({ source }));
  assertNoDatabaseGuardProblems(databaseGuardProblems(source));
  assertManagedScriptSetMatches(managedScriptSetProblems({ source }));

  // ① 顺序（判据⑥）：把 admin-accounts-read 的 step 挪到 account-deletion 之前 ⇒ 必须报「第一处逆序对」。
  const swapped = withSwappedSteps(source, realJobId, deletion, accountsRead);
  const orderProblems = stepOrderProblems({ source: swapped });
  assert.ok(orderProblems.length >= 1, '对调两步后顺序判据必须报问题');
  assert.ok(orderProblems[0].includes('第一处逆序对'), '失败消息必须点名「第一处逆序对」');
  assert.ok(
    orderProblems[0].includes(deletion) && orderProblems[0].includes(accountsRead),
    '失败消息必须同时点名被对调的两条脚本（否则证明不了能定位）',
  );
  assert.ok(orderProblems[0].includes('实际顺序') && orderProblems[0].includes('期望顺序'), '失败消息必须给出实际顺序与期望顺序');
  assert.throws(() => assertStepOrder(orderProblems), /第一处逆序对/, '同一断言必须在变异后失败');
  // 对调 step 不得连带打红建库/库名判据（两条判据互不遮蔽，失败消息才不会张冠李戴）。
  assert.deepEqual(databaseGuardProblems(swapped), [], '只对调顺序时建库/库名判据必须仍绿');

  // ② 建库（判据⑦）：删掉 messages step 的 `CREATE DATABASE … &&`，只留 `node` ⇒ 必须点名该 step 缺建库。
  const withoutCreate = replaceWithinJob(
    source,
    realJobId,
    /psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_messages_test' && /,
    '',
  );
  const missingProblems = databaseGuardProblems(withoutCreate);
  assert.equal(missingProblems.length, 1, '删一处建库必须只报一条问题');
  assert.ok(missingProblems[0].includes(messages) && missingProblems[0].includes('CREATE DATABASE'), '失败消息必须点名脚本与缺的语句');
  assert.throws(() => assertNoDatabaseGuardProblems(missingProblems), /CREATE DATABASE/, '同一断言必须失败');

  // ③ 库名一致（判据⑧）：把 flags step 的 CREATE DATABASE 库名改错（脚本仍连 gengyun_flags_test）⇒ 必须点名两边库名。
  const typo = replaceWithinJob(source, realJobId, /CREATE DATABASE gengyun_flags_test\b/, 'CREATE DATABASE gengyun_flags_test_typo');
  const nameProblems = databaseGuardProblems(typo);
  assert.equal(nameProblems.length, 1, '改错一处库名必须只报一条问题');
  assert.ok(
    nameProblems[0].includes('gengyun_flags_test_typo') && nameProblems[0].includes('gengyun_flags_test'),
    '失败消息必须同时点名「建出来的库」与「脚本真正连的库」',
  );
  assert.ok(nameProblems[0].includes(flags), '失败消息必须点名脚本');
  assert.throws(() => assertNoDatabaseGuardProblems(nameProblems), /gengyun_flags_test_typo/, '同一断言必须失败');

  // ④ 双向相等（判据⑨）：MANAGED_SCRIPTS 与 FROZEN 同时删一项 ⇒ 既有三条口径全绿，新判据必须红。
  const trimmed = MANAGED_SCRIPTS.filter((script) => script !== deletion);
  const trimmedFrozen = FROZEN_MANAGED_SCRIPTS.filter((script) => script !== deletion);
  assert.deepEqual([...trimmed].sort(), [...trimmedFrozen].sort(), '双删形态下「冻结清单同步」的既有断言仍是绿的');
  assertManagedScriptsWired(missingManagedScripts({ workflows: readAllWorkflows(), managed: trimmed }));
  assert.deepEqual(postgresJobProblems(source, { managed: trimmed }), [], '双删形态下判据③（镜像锚定）仍是绿的');
  const setProblems = managedScriptSetProblems({ source, managed: trimmed });
  assert.equal(setProblems.length, 1, '双删一项后新判据必须正好报一条问题');
  assert.ok(
    setProblems[0].includes(deletion) && setProblems[0].includes('清单里没有'),
    '失败消息必须点名「workflow 跑了、清单里没有」的那条脚本',
  );
  assert.throws(() => assertManagedScriptSetMatches(setProblems), /清单里没有/, '同一断言必须失败');

  // ⑤ 自起集群（判据⑦⑧ 的等价替换）：**逐个**把该脚本自己 step 里的 `GY_PG_BIN` 注释掉 ⇒ 必须正好报一条、
  //    且点名那条脚本。⛔ 变异不能用 `replaceWithinJob`：自 R28-E5 起同一个 job 里有**两条**自起集群脚本、
  //    两段 `GY_PG_BIN` 逐字相同（`/usr/lib/postgresql/17/bin`），job 级变异会命中两处而假红。
  for (const selfClustered of SELF_CLUSTERED_SCRIPTS) {
    const withoutBin = replaceWithinStep(
      source,
      realJobId,
      selfClustered,
      /GY_PG_BIN: \/usr\/lib\/postgresql\/17\/bin/,
      '# GY_PG_BIN: /usr/lib/postgresql/17/bin',
    );
    const binProblems = databaseGuardProblems(withoutBin);
    assert.equal(binProblems.length, 1, `删 \`${selfClustered}\` 的 GY_PG_BIN 必须只报一条问题`);
    assert.ok(
      binProblems[0].includes(selfClustered) && binProblems[0].includes('GY_PG_BIN') && binProblems[0].includes('SKIP'),
      '失败消息必须点名脚本、缺的 env 与「缺了只会 SKIP/77」的后果',
    );
    assert.throws(() => assertNoDatabaseGuardProblems(binProblems), /GY_PG_BIN/, '同一断言必须失败');
  }
  assert.ok(SELF_CLUSTERED_SCRIPTS.includes(backupPurge), '`backup-purge-pg` 必须仍在自起集群清单里');

  // ⑥ 自起集群不得自己建库：给它补一条 `CREATE DATABASE` ⇒ 必须点名「不是一回事」，不能因为多了建库就判绿。
  const selfCreated = replaceWithinJob(
    source,
    realJobId,
    /run: node tests\/integration\/backup-purge-pg\.mjs/,
    "run: psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE gengyun_backup_purge_test' && node tests/integration/backup-purge-pg.mjs",
  );
  const selfCreatedProblems = databaseGuardProblems(selfCreated);
  assert.equal(selfCreatedProblems.length, 1, '自起集群脚本的 step 出现建库必须正好报一条问题');
  assert.ok(
    selfCreatedProblems[0].includes(backupPurge) && selfCreatedProblems[0].includes('CREATE DATABASE'),
    '失败消息必须点名脚本与不该出现的语句',
  );
  assert.throws(() => assertNoDatabaseGuardProblems(selfCreatedProblems), /CREATE DATABASE/, '同一断言必须失败');
});

/**
 * R28-E5 的负控制：把**新接的那一条**（`backup-copies-purge-pg`）整段 step 删掉。
 *
 * 为什么单独一条用例：它是清单里第二条自起集群脚本，判据⑦⑧ 走的是 `SELF_CLUSTERED_SCRIPTS` 豁免路径——
 * 这条路径此前只有一条被测对象，删掉它时哪条断言会红、红的时候点到谁，没被任何用例钉住。
 * 这里要求**四条判据各自**都红、且**每条都逐字点到该脚本**：判据①（接线）、⑥（顺序）、⑦⑧（自起集群等价判据）、
 * ⑨（双向相等）。少任何一条，都意味着「把这一步拿掉」在某个角度上是静默的。
 */
test('反向控制⑨：删掉 `backup-copies-purge-pg` 的整段 step ⇒ 四条判据必须逐条点名它', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  const copies = 'tests/integration/backup-copies-purge-pg.mjs';
  const witness = 'tests/integration/backup-purge-pg.mjs';
  assert.ok(MANAGED_SCRIPTS.includes(copies), '用例前提：它必须在受管清单里');
  assert.ok(SELF_CLUSTERED_SCRIPTS.includes(copies), '用例前提：它必须走自起集群的那组判据');

  // 0) 先证明磁盘真值是绿的，否则下面的「删了就红」可能只是继承了一个已经红掉的前提。
  const workflows = readAllWorkflows();
  assertManagedScriptsWired(missingManagedScripts({ workflows }));
  assertStepOrder(stepOrderProblems({ source }));
  assertNoDatabaseGuardProblems(databaseGuardProblems(source));
  assertManagedScriptSetMatches(managedScriptSetProblems({ source }));

  const realJobId = jobsRunningManagedScripts(source)[0].id;
  const mutated = withoutScriptStep(source, realJobId, copies);
  assert.notEqual(mutated, source, '删 step 必须真的改到文本');
  assert.equal(
    runCommandTextsOf(mutated).some((command) => command.includes(copies)),
    false,
    '整段 step 删掉后不得再有任何 `run:` 命令文本含这个脚本',
  );
  assert.ok(mutated.includes(`node ${witness}`), '变异只许打断这一条，相邻的自起集群脚本必须仍是绿的');

  // ① 判据①（接线）：必须且只能点名它。
  const allMutated = workflows.map((workflow) => (workflow.file === REAL_PG_WORKFLOW
    ? { ...workflow, source: mutated, commands: runCommandTextsOf(mutated) }
    : workflow));
  const missing = missingManagedScripts({ workflows: allMutated });
  assert.deepEqual(missing, [copies], '删掉整段 step 后必须且只点名它');
  assert.throws(
    () => assertManagedScriptsWired(missing),
    (error) => error.message.includes(copies),
    '判据①必须失败并点名它',
  );

  // ② 判据⑥（顺序）：顺序判据失去对象时必须点名它。
  const orderProblems = stepOrderProblems({ source: mutated });
  assert.ok(orderProblems.length >= 1, '删掉一条后顺序判据必须报问题');
  assert.ok(orderProblems.some((problem) => problem.includes(copies)), '顺序问题必须点名它');
  assert.throws(() => assertStepOrder(orderProblems), (error) => error.message.includes(copies), '同一断言必须失败');

  // ③ 判据⑦⑧（自起集群等价判据）：找不到执行它的 step ⇒ 必须点名它。
  const guardProblems = databaseGuardProblems(mutated);
  assert.equal(guardProblems.length, 1, '删掉这一条必须只报一条建库/自起集群判据问题');
  assert.ok(
    guardProblems[0].includes(copies) && guardProblems[0].includes('找不到执行它的 step'),
    '失败消息必须点名脚本与「找不到执行它的 step」',
  );
  assert.throws(
    () => assertNoDatabaseGuardProblems(guardProblems),
    (error) => error.message.includes(copies),
    '同一断言必须失败',
  );

  // ④ 判据⑨（双向相等）：workflow 少跑一条 ⇒ 必须点名「清单里有、workflow 没跑」。
  const setProblems = managedScriptSetProblems({ source: mutated });
  assert.equal(setProblems.length, 1, '删掉这一条后双向相等必须只报一条问题');
  assert.ok(
    setProblems[0].includes(copies) && setProblems[0].includes('workflow 没跑'),
    '失败消息必须点名脚本与「清单里有、workflow 没跑」',
  );
  assert.throws(
    () => assertManagedScriptSetMatches(setProblems),
    (error) => error.message.includes(copies),
    '同一断言必须失败',
  );
});

/**
 * R29-W13 的负控制：`SELF_CLUSTERED_ROOT_KEY` 的**键名映射**必须是被钉住的判断题，而不是一张能随便改、
 * 改了也没人管的表——否则「修掉一个假绿」只是把假绿通道从 workflow 挪到这张表里。四种变异一律要红：
 *   ① **错映射**：把 `messages-purge-pg` 登记成 `GY_I19_PG_ROOT`（本片修掉的原始缺陷形态）；
 *   ② **丢映射**：删掉它的登记 ⇒ 判据退化成只剩 `GY_PG_BIN`，root 传丢/传错都不红；
 *   ③ **装饰性 env**：step 里同时给 `GY_W11_PG_ROOT` 与 `GY_I19_PG_ROOT`——看着有 root，脚本只读其中一个；
 *   ④ **脚本改键**：源码把 `GY_W11_PG_ROOT` 换成别的键而登记表没跟上 ⇒ 证明核的是源码真值，不是表格自说自话。
 */
test('反向控制⑩：root 键按脚本映射——错映射／丢映射／装饰性 env／脚本改键，四种变异都必须红', () => {
  const { source } = readWorkflow(REAL_PG_WORKFLOW);
  const w11 = 'tests/integration/messages-purge-pg.mjs';
  const w11Key = 'GY_W11_PG_ROOT';

  // 0) 磁盘真值先绿，且「登记表 ↔ 脚本源码」两边都真的指向 GY_W11_PG_ROOT。
  assertNoDatabaseGuardProblems(databaseGuardProblems(source));
  assert.equal(SELF_CLUSTERED_ROOT_KEY[w11], w11Key, '登记表必须把 `messages-purge-pg` 映射到它真正读的键');
  const w11Source = readFileSync(join(REPO_ROOT, w11), 'utf8');
  assert.deepEqual(detectedRootKeys(w11Source), [w11Key], '源码真值必须恰好是这一个根键');
  assert.ok(w11Source.includes('GY_W11_PG_LOG'), '前提：脚本里还有日志键 `GY_W11_PG_LOG`，但它不是根键');
  assert.deepEqual(
    detectedRootKeys(readFileSync(join(REPO_ROOT, 'tests/integration/backup-purge-pg.mjs'), 'utf8')),
    ['GY_I19_PG_ROOT'],
    '同形脚本（backup-purge）读的是另一个键 ⇒ 对全体硬编码一个键必然错一半（这就是原缺陷）',
  );

  const { jobId, step, command } = stepRunningScript(source, w11);
  const problemsOf = (overrides) => selfClusteredProblems({ jobId, script: w11, step, command, ...overrides });

  // ① 错映射 ⇒ 红，消息必须同时点名「登记的键」与「源码真值键」。
  const wrongMapping = problemsOf({ declaredRootKeys: { ...SELF_CLUSTERED_ROOT_KEY, [w11]: 'GY_I19_PG_ROOT' } });
  assert.equal(wrongMapping.length, 1, '错映射必须正好报一条问题');
  assert.ok(
    wrongMapping[0].includes('GY_I19_PG_ROOT') && wrongMapping[0].includes(w11Key) && wrongMapping[0].includes(w11),
    '失败消息必须同时点名登记的键、真值键与脚本',
  );
  assert.throws(() => assertNoDatabaseGuardProblems(wrongMapping), /GY_I19_PG_ROOT/, '同一断言必须失败');

  // ② 丢映射 ⇒ 红（否则判据退化成只剩 `GY_PG_BIN`）。
  const withoutEntry = { ...SELF_CLUSTERED_ROOT_KEY };
  delete withoutEntry[w11];
  const missingEntry = problemsOf({ declaredRootKeys: withoutEntry });
  assert.equal(missingEntry.length, 1, '丢映射必须正好报一条问题');
  assert.ok(
    missingEntry[0].includes(w11) && missingEntry[0].includes('SELF_CLUSTERED_ROOT_KEY'),
    '失败消息必须点名脚本与缺的登记表',
  );
  assert.throws(() => assertNoDatabaseGuardProblems(missingEntry), /SELF_CLUSTERED_ROOT_KEY/, '同一断言必须失败');

  // ③ 装饰性 env：在该 step 里再塞一条脚本不读的 `GY_I19_PG_ROOT` ⇒ 必须点名「装饰性 env」。
  const decorative = step.replace(
    /(\n\s+GY_W11_PG_ROOT: )/,
    '\n          GY_I19_PG_ROOT: ${{ runner.temp }}/gy-i19-pg$1',
  );
  assert.notEqual(decorative, step, '变异必须真的改到 step 文本');
  const decorativeProblems = problemsOf({ step: decorative });
  assert.equal(decorativeProblems.length, 1, '多一条装饰性 env 必须正好报一条问题');
  assert.ok(
    decorativeProblems[0].includes('GY_I19_PG_ROOT') && decorativeProblems[0].includes('装饰性'),
    '失败消息必须点名那条多余的键与「装饰性 env」',
  );
  assert.throws(() => assertNoDatabaseGuardProblems(decorativeProblems), /装饰性/, '同一断言必须失败');
  // 同一条变异也要能从整份 workflow 走到底（证明确实是 `databaseGuardProblems` 这条真实路径在红）。
  const decorativeSource = replaceWithinStep(
    source,
    jobId,
    w11,
    /GY_W11_PG_ROOT: \$\{\{ runner\.temp \}\}\/gy-w11-pg/,
    'GY_I19_PG_ROOT: ${{ runner.temp }}/gy-i19-pg',
  );
  const decorativeSourceProblems = databaseGuardProblems(decorativeSource);
  assert.equal(decorativeSourceProblems.length, 2, '把真实键换成错键 ⇒ 缺键 + 装饰性各一条');
  assert.ok(
    decorativeSourceProblems.some((problem) => problem.includes('GY_I19_PG_ROOT') && problem.includes('装饰性')),
    '真实路径的失败消息必须点名「装饰性 env」',
  );

  // ④ 脚本改键（表没跟上）⇒ 红；证明核的是源码真值。
  const renamedSource = w11Source.replace('process.env.GY_W11_PG_ROOT', 'process.env.GY_ZZ_PG_ROOT');
  assert.notEqual(renamedSource, w11Source, '变异必须真的改到脚本源码');
  const renamedProblems = problemsOf({ scriptSource: renamedSource });
  assert.ok(renamedProblems.length >= 2, '脚本改键而表没跟上时至少报两条（错映射 + 缺/多键）');
  assert.ok(
    renamedProblems.some((problem) => problem.includes('GY_ZZ_PG_ROOT')),
    '失败消息必须点名脚本里**新**的键（证明读的是源码，不是登记表）',
  );
  assert.throws(() => assertNoDatabaseGuardProblems(renamedProblems), /GY_ZZ_PG_ROOT/, '同一断言必须失败');
});

// 静态守卫：运行时 SQL 的**列面** ⊆ 授权面的**列权限**（角色 `gengyun_api_runtime`）。
//
// 为什么需要这一层：本仓 2026-10-20/21 连续四次踩同一个坑（S26 七张表整张零授权、S28 四张
// `recognition_*` 零命中、S38 三张 `speech_*` 零授权且 90-assert 假绿、S45 `users` 列级 INSERT
// 缺 `wechat_subject_cipher`），每一次都只有「人盯着反推」才发现。`90-assert-least-privilege.sql`
// 只核对「授权面 = 预期清单」，没有任何东西核对「预期清单 ⊇ 运行时真实用到的列」——本文件补这一层。
//
// 为什么不连库：本片要防的是**文本回退**（谁把 store 的列清单改了、或把某条列级 GRANT 删了/改成
// 表级），这种东西只有读源码才看得见；真库行为（42501）另有 S24/S26/S28/S38/S45 的矩阵实验背书。
//
// 双向核对：
//   正向（判红）—— 运行时 TypeScript 里写出的 SQL 引用到的每个列，运行时角色必须有对应权限；
//   反向（只报告）—— 授权面里存在、但 8 个 store-pg 从未引用的列，只计数不判红（避免变噪音）。
//
// 四条负控制（「不是恒绿」的证明，见文件末尾 tests）：
//   NC1 内存夹具：假 store 用了未授权列 ⇒ 必须红；
//   NC2 内存夹具：表级 GRANT 吞掉同类型列级条目 ⇒ 必须标记为「整表」，不许当成「无列」或「全列」；
//   NC3 从**真实**授权文本里删掉一条真实授权列 ⇒ 必须红并精确点名该 table.column；复原回绿；
//   NC4 `OPAQUE_ALLOWLIST` 加一条源码里不存在的 file:line ⇒ 必须红（防躺平）。
//
// ── R28-S66 扩展（2026-10-21）────────────────────────────────────────────────
// 覆盖面从 8 个 store-pg 扩到 18 个 SQL 宿主文件（另 10 个见 ADDITIONAL_SQL_HOST_FILES），
// 并新增三条独立断言：①文件集不变量（新增 SQL 宿主却忘了登记 ⇒ 红）；②函数调用不是表访问
// （`FROM public.list_admin_accounts()` 只要求 EXECUTE，不产生列要求）；③行锁规则
// （`FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR KEY SHARE` 四条子句除 SELECT 外
//   **都**要 UPDATE 权限 —— PG 17 文档 SELECT → Description 原文；#379 遗留缺陷前这里漏了后两条）。
// `privacy/ledger-pg.ts` 在默认部署下不可达（egress_ledger.sql 从未被执行）⇒ 其缺口进
// LEDGER_COVERAGE_EXEMPT（条数钉死 + staleExemptions 反查），不静默跳过。
// 新增负控制 NC5–NC9（见文件末尾）；C1b-1 合流时补 NC10：注释掉真实的
// `GRANT DELETE ON public.messages` 必须判红（DELETE 面在 2026-10-21 之前一直是盲区）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 被审计的运行时角色（本仓唯一 LOGIN；INHERIT 见 20-login-roles.sql 的 CREATE/ALTER ROLE）。 */
const RUNTIME_ROLE = 'gengyun_api_runtime';
/** 授权面①：每次 provision 都会跑的登录角色引导（运行时域 H/I/J/K 段都在这里）。 */
const GRANT_MAIN_FILE = 'deploy/postgres-cvm/sql/20-login-roles.sql';
/** 授权面②：只在**建组那一次**执行的组文件（`idempotency_keys` 等老表授权只在这里）。 */
const ROLES_DIR = 'services/api/db/roles';
/** 运行时 SQL 的唯一来源：8 个 store-pg（派单 §3.2）。 */
const STORE_ROOT = 'services/api/src';
const EXPECTED_STORE_FILES = [
  'community',
  'conversations',
  'favorites',
  'history',
  'messages',
  'ocr',
  'recognitions',
  'speech',
];

/**
 * R28-S66：本片纳管的另外 8 个 SQL 宿主文件（相对 STORE_ROOT）；R28-W12 追加 media/store-pg.ts 成第 9 个，
 * R29-S5（origin/main）追加 admin/ops/jobs-pg.ts 成第 10 个。
 * 派单 §0 的 `git grep -l -E "INSERT INTO public\.|UPDATE public\.|FROM public\.|DELETE FROM public\."`
 * 实测 12 个文件 = 4 个带 `public.` 前缀的 store-pg（messages/ocr/recognitions/speech）
 * ＋ 本表 8 个（另 4 个 store-pg 的表名不带 schema 前缀，故不在这条 grep 的命中里）。
 * 访问它们的 SQL 与 store-pg 走**同一套** parseSqlText/collectRequirements/evaluateCoverage 管线。
 */
const ADDITIONAL_SQL_HOST_FILES = [
  'admin/ops/accounts-pg.ts',
  'admin/ops/categories-pg.ts',
  'admin/ops/content-pg.ts',
  'admin/ops/flags-pg.ts',
  'admin/ops/jobs-pg.ts',
  // GY-R71（2026-10-30）：统一作业台账 `public.jobs` 的唯一写入点（一条 upsert）。它不在 8 个
  // store-pg 目录里，但写的是**运行时的真表**，所以必须进真审计（不是 UNAUDITED / OPAQUE 桶）：
  // 15 个 INSERT 列 / 5 个 UPDATE 列 / 1 个 SELECT 列全部要有列级授权，缺一列就红。
  'jobs/ledger.ts',
  'knowledge/service.ts',
  'media/store-pg.ts',
  'moderation/ledger-pg.ts',
  'privacy/backup-copies-pg.ts',
  'privacy/consent-pg.ts',
  'privacy/grant-pg.ts',
  'privacy/ledger-pg.ts',
  'profile/service.ts',
];

/**
 * 正向核对的**全部例外登记**。元素形状（缺字段一律判红）：
 *   { ref: 'table.column', privilege: 'SELECT' | 'INSERT' | 'UPDATE',
 *     reason: '为什么这里确实缺', owner: '留给哪一片修' }
 *
 * 2026-10-21 实测：**0 条**。8 个 store-pg 引用到的 24 张表的全部列权限都已授权
 * （S24/S26/S28/S38/S45 已逐域补齐）。本表因此空着，但机制照常生效：
 * `staleExemptions` 会把「登记了但实际不再缺」的条目判红，NC3 会把「删掉一条真实授权 ⇒ 红」
 * 走一遍真流程（见文件末尾）。
 *
 * 形状校验故意写得很硬：`ref` 必须正好是 `schema.table.column`（三段），`privilege` 必须大写，
 * 免得有人塞一条 `''` 进来把守卫变成恒绿。
 */
const COVERAGE_EXEMPT = [];

/**
 * R28-S66：ledger 已知缺口的**显式豁免表**（派单 §1.3）。元素形状与 COVERAGE_EXEMPT 相同：
 *   { ref: 'table.column', privilege, reason, owner }
 * 为什么与 COVERAGE_EXEMPT 分开存：8 个 store-pg 的基线必须继续在**零豁免**下全绿，
 * 否则基线会把 33 条 ledger 条目一并判成「陈旧例外」。扩展审计显式传入本表。
 *
 * 为什么算「已知」而不是本片引入：services/api/db/roles/egress_ledger.sql 从未被任何部署脚本
 * 执行 —— deploy/postgres-cvm/provision-db.sh:285 与 deploy/postgres-cvm/README.md:440 写明
 * （S57 已核实），deploy/postgres-cvm/sql/20-login-roles.sql:54 的注释也记着这一点。于是
 * gengyun_egress_ledger 拿不到 public.exports / public.export_writebacks 的列面；是否接线属
 * 产品/安全裁定，不在本片（纯测试资产）的改动范围内。
 *
 * 条数钉死 = 33 个 table.column.privilege 唯一键（来自 54 条语句级缺口），多一条少一条都判红；
 * 反向核对由 evaluateCoverage 的 staleExemptions 负责（NC8 走一遍）。
 */
const LEDGER_COVERAGE_EXEMPT = [
  { ref: 'public.export_writebacks.committed_at', privilege: 'SELECT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 SELECT 面；SQL: privacy/ledger-pg.ts:655', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.export_writebacks.export_id', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 INSERT 面；SQL: privacy/ledger-pg.ts:642', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.export_writebacks.export_id', privilege: 'SELECT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 SELECT 面；SQL: privacy/ledger-pg.ts:642/655', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.export_writebacks.result', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 INSERT 面；SQL: privacy/ledger-pg.ts:642', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.export_writebacks.result', privilege: 'SELECT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 SELECT 面；SQL: privacy/ledger-pg.ts:655', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.export_writebacks.revision', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 INSERT 面；SQL: privacy/ledger-pg.ts:642', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.export_writebacks.revision', privilege: 'SELECT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 SELECT 面；SQL: privacy/ledger-pg.ts:655', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.export_writebacks.user_id', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 INSERT 面；SQL: privacy/ledger-pg.ts:642', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.export_writebacks.user_id', privilege: 'SELECT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.export_writebacks 的 SELECT 面；SQL: privacy/ledger-pg.ts:655', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.auth_epoch', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.cancellation_reason', privilege: 'UPDATE', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 UPDATE 面；SQL: privacy/ledger-pg.ts:684/707', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.cancelled_at', privilege: 'UPDATE', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 UPDATE 面；SQL: privacy/ledger-pg.ts:684/707', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.consent_epoch', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.consent_id', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.error_code', privilege: 'UPDATE', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 UPDATE 面；SQL: privacy/ledger-pg.ts:612/684/707/729', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.id', privilege: 'SELECT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 SELECT 面；SQL: privacy/ledger-pg.ts:396/707/729', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.job_id', privilege: 'UPDATE', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 UPDATE 面；SQL: privacy/ledger-pg.ts:570', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.object_id', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.object_key', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.object_revision', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.object_type', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.purpose', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.recipient_config_version', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.recipient_id', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.required_consents', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.revision', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.revision', privilege: 'UPDATE', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 UPDATE 面；SQL: privacy/ledger-pg.ts:591/612/684/707/729', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.sent_at', privilege: 'UPDATE', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 UPDATE 面；SQL: privacy/ledger-pg.ts:591', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.source_version', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.state', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.state', privilege: 'UPDATE', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 UPDATE 面；SQL: privacy/ledger-pg.ts:591/612/684/707/729', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.updated_at', privilege: 'UPDATE', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 UPDATE 面；SQL: privacy/ledger-pg.ts:570/591/612/684/707/729', owner: 'R28-S66/接线待裁定' },
  { ref: 'public.exports.user_id', privilege: 'INSERT', reason: 'egress_ledger 组未部署也未被 runtime 继承（provision-db.sh:285；20-login-roles.sql:54/:221-225）：运行时拿不到 public.exports 的 INSERT 面；SQL: privacy/ledger-pg.ts:443', owner: 'R28-S66/接线待裁定' },
];

/* ============================================================================
 * 〇、语句站点**按源码实时定位**，不写死 `文件:行号`（R31）
 * ========================================================================== */

/**
 * 为什么改成「算出来的行号」：2026-10-22 同一天两次 CI 红都是同一族 —— 代码一改行、测试就红。
 * ① `tools/verify-contract-status.mjs` 的证据锚点区间（另一片用 `--reanchor` 处理）；
 * ② 本文件 NC6 写死的 `profile/service.ts:61`：往 `put()` 上面加两行，61 就变 65，红的是
 *    「测试过期」而不是「行为回退」—— 噪音把真红埋了。行号本来就能算，算出来的不会过期。
 *
 * 判据强度**不降**：`siteLine` 要求锚点在文件里恰好出现一次；找不到 / 出现多次都当场判红，
 * 并点名文件与锚点原文。也就是说「语句被删 / 被改写 / 被复制成两份」仍然会红，
 * 只是「同一语句上下挪了几行」不再红。
 */

/**
 * 定位锚点所在行（1-based）。
 * @param {string} file 仓库相对路径
 * @param {string} needle 必须在文件里**唯一**出现的原文片段
 * @returns {number}
 */
function siteLine(file, needle) {
  const text = readFileSync(resolve(root, file), 'utf8');
  const first = text.indexOf(needle);
  assert.notEqual(
    first,
    -1,
    `R31 语句站点定位失败：${file} 里已找不到锚点「${needle}」`
      + '——语句被删/改名就必须重新登记豁免，不能靠写死行号蒙过去',
  );
  assert.equal(
    text.indexOf(needle, first + 1),
    -1,
    `R31 语句站点定位不唯一：${file} 里「${needle}」出现了多次，请把锚点写长一点（必须是唯一站点）`,
  );
  return lineOf(text, first);
}

/** @returns {string} `文件:行号`，行号是**现在**算出来的。 */
function siteRef(file, needle) {
  return `${file}:${siteLine(file, needle)}`;
}

/**
 * 定位锚点原文。同一份原文也用于负控制的「变异替换」，一处定义两处引用：
 * 业务代码里的 SQL 改了 ⇒ 定位与变异一起失效、一起报红，不会出现「定位还在、变异悄悄没生效」。
 */
const NEEDLE = {
  profileUserLock: 'SELECT state,auth_epoch FROM public.users WHERE id=$1::uuid FOR UPDATE',
  profileRegions: 'FROM public.regions WHERE supported',
  consentUserLock: 'SELECT id,state,auth_epoch,revision FROM public.users WHERE id=$1::uuid FOR UPDATE',
  // #379 遗留修复：users 上还有两处**共享锁**站点，同样要 UPDATE 权限（此前不计要求，故未登记站点）。
  knowledgeUserShareLock: 'SELECT state,auth_epoch FROM public.users WHERE id=$1::uuid FOR SHARE',
  ledgerUserShareLock: 'SELECT id,state,auth_epoch FROM public.users WHERE id=$1::uuid FOR SHARE',
  ledgerExportsLock: 'SELECT * FROM public.exports WHERE id=$1::uuid FOR UPDATE',
  ledgerExpectsTextKey: '${expectsTextKey ?',
  ledgerByKey: '${byKey ?',
  ledgerScoped: '${scoped ?',
  conversationsWhere: 'WHERE owner_id = $1::uuid${where}',
  turnsWhere: 'WHERE conversation_id = $1::uuid AND owner_id = $2::uuid${where}',
};

/** 十一个「语句站点」的 `文件:行号`，全部实时算。 */
const SITE = {
  profileUserLock: siteRef('services/api/src/profile/service.ts', NEEDLE.profileUserLock),
  profileRegions: siteRef('services/api/src/profile/service.ts', NEEDLE.profileRegions),
  consentUserLock: siteRef('services/api/src/privacy/consent-pg.ts', NEEDLE.consentUserLock),
  knowledgeUserShareLock: siteRef('services/api/src/knowledge/service.ts', NEEDLE.knowledgeUserShareLock),
  ledgerUserShareLock: siteRef('services/api/src/privacy/ledger-pg.ts', NEEDLE.ledgerUserShareLock),
  ledgerExportsLock: siteRef('services/api/src/privacy/ledger-pg.ts', NEEDLE.ledgerExportsLock),
  ledgerExpectsTextKey: siteRef('services/api/src/privacy/ledger-pg.ts', NEEDLE.ledgerExpectsTextKey),
  ledgerByKey: siteRef('services/api/src/privacy/ledger-pg.ts', NEEDLE.ledgerByKey),
  ledgerScoped: siteRef('services/api/src/privacy/ledger-pg.ts', NEEDLE.ledgerScoped),
  conversationsWhere: siteRef('services/api/src/conversations/store-pg.ts', NEEDLE.conversationsWhere),
  turnsWhere: siteRef('services/api/src/conversations/store-pg.ts', NEEDLE.turnsWhere),
};

/**
 * R28-S66：行锁的显式豁免表（派单 §2.5 + §1.3）。元素形状比列级豁免多一个 ref：
 *   { table, privilege, ref: 'file:line', reason, owner }
 * 行锁要求没有列名，只按表豁免会把同表上的**新**语句一起放行（躺平），所以必须精确到语句站点。
 * 反向核对：evaluateRowLocks 的 staleExemptions（登记了却对不上任何行锁要求 ⇒ 红）。
 *
 * 当前唯一一条：privacy/ledger-pg.ts 里 «SELECT * FROM public.exports … FOR UPDATE» 那条语句
 * （行号由 SITE.ledgerExportsLock 实时算，不写死），
 * 与同文件 33 条列级缺口同属「egress_ledger 未接线」这一个已知范畴。
 */
const ROW_LOCK_EXEMPT = [
  { table: 'public.exports', privilege: 'UPDATE', ref: SITE.ledgerExportsLock, reason: '同 33 条列级缺口的同一范畴：exports 对运行时角色无任何 UPDATE 授权', owner: 'R28-S66/接线待裁定' },
];

/**
 * R28-S66：ledger 的三处不可静态求值插值（派单 §2.6：与 OPAQUE_ALLOWLIST 同机制、file:line 逐条登记）。
 * 与 OPAQUE_ALLOWLIST 分开列，是为了让 8 store 基线的「opaque 条数 == 2」这条钉死读数原样不动。
 */
const LEDGER_OPAQUE_ALLOWLIST = [
  {
    ref: SITE.ledgerExpectsTextKey,
    reason: '三元选择 object_key=$3 / object_id=$3::uuid —— 两列都只出现在 exports 的列面里（已按 ledger 范畴登记），不引入新表新列。',
  },
  {
    ref: SITE.ledgerByKey,
    reason: '同上：byKey 决定锁 object_key 还是 object_id。',
  },
  {
    ref: SITE.ledgerScoped,
    reason: 'scoped 时追加 AND user_id=$4::uuid；user_id 已在 exports 的列面里（同范畴登记）。',
  },
];

/**
 * R28-S66：**未被本片纳管**的 SQL 宿主（派单 §1.2 的文件集不变量）。
 *
 * 不变量的最强诚实形式：discoverSqlHosts() 扫出来的每个文件，要么在 16 个已审计文件里，
 * 要么在这张表里（file + reason + owner）；两边都没有 ⇒ 判红（NC7 走一遍）。
 * 反过来，这张表的每一条都必须仍然被扫到（文件删了/不再含 SQL ⇒ 红，防躺平）。
 *
 * 为什么前 5 个不在本片范围：派单 §0 的清单是「含 public. 限定 SQL 的 8 个新文件」，
 * 这 5 个是 S61 之前就存在的宿主，纳入审计会引入 ledger 范畴之外的新缺口（需要指挥裁定），
 * 故本片只保证「新宿主一律判红」，把它们列进来等后续片接线。
 * 第 6 条（privacy/backup-purge-driver.ts）是 R28-E2 片新增的到期驱动：列面由真库臂实测、
 * 静态纳管需本片重定 16 文件读数，故同样登记在此等 R28-S66 统一收口。
 */
const UNAUDITED_SQL_HOSTS = [
  {
    file: 'services/api/src/app.ts',
    reason: '目录视图读取（SELECT * FROM catalog_read.current_knowledge）；catalog_read 的 SELECT 已授，列面属 catalog 片。',
    owner: 'S61 口径 / R28-S66 未纳管',
  },
  {
    file: 'services/api/src/auth/idempotency.ts',
    reason: 'public.idempotency_keys 的幂等回执读写；该表已被 8 store 的基线引用并核对，本文件的语句未纳入。',
    owner: 'S61 口径 / R28-S66 未纳管',
  },
  {
    file: 'services/api/src/auth/store.ts',
    reason: 'public.users / public.sessions / public.admin_* 的登录态读写；含表名位插值（解析会退化成 public.where / public.set 之类的噪声），纳入审计前需先修解析。',
    owner: 'S61 口径 / R28-S66 未纳管',
  },
  {
    file: 'services/api/src/db/catalog.ts',
    reason: 'catalog_read.* 目录视图读取；属 catalog 域，非本片 8 文件清单。',
    owner: 'S61 口径 / R28-S66 未纳管',
  },
  {
    file: 'services/api/src/db/migrate.ts',
    reason: 'public.schema_migrations（迁移执行器，部署期使用而非请求期）。',
    owner: 'S61 口径 / R28-S66 未纳管',
  },
  {
    file: 'services/api/src/privacy/backup-purge-driver.ts',
    reason: 'R28-E2 新增的「备份副本 30 日到期」运维驱动的 SQL（`user_backup_copies` 上的 CTE + 窗口函数 + '
      + 'FILTER + HAVING，另加一条 `state` 列 UPDATE 重排）。列面已由真库臂**实测**而非静态推断：'
      + 'tests/integration/backup-copies-purge-pg.mjs 第一臂用运行时角色跑通了枚举/重排/清除，'
      + '并断言表级 SELECT/INSERT/UPDATE=false、payload 列不可读、DELETE=42501 ⇒ 零新增授权。'
      + '纳入本管线需 R28-S66 重定 16 文件读数（auditedFiles 16→17 等），留给该片统一改。',
    owner: 'E2 / R28-E2 backup-purge-driver；静态纳管待 R28-S66 重定读数',
  },
  {
    file: 'services/api/src/privacy/online-purge-driver.ts',
    reason: 'R28-W6（#19）新增的「在线数据 7 日到期」运维驱动的 SQL：`deletion_requests` 上一条'
      + '按 `online_due_at` 闭区间取候选的 SELECT（带 `LIMIT`）与一条同 WHERE 的 `count(*)`。'
      + '列面已由真库臂**实测**：tests/integration/online-purge-pg.mjs 第一臂断言运行时角色对'
      + '`deletion_requests` 连 SELECT 都没有（实跑 `SELECT id` ⇒ 42501）⇒ 本命令必须用属主/运维角色跑'
      + '（与 `db:migrate` 同源），四域 DELETE 则用**既有**授权（零新增授权）。'
      + 'R32 片B（迁移 0031）起证据落库改走 `online-purge-evidence.ts` 的端口（本文件不再新增 SQL 面）。'
      + '纳入本管线需 R28-S66 重定 auditedFiles 读数，留给该片统一改。',
    owner: 'W6 / R28-W6 online-purge-driver；静态纳管待 R28-S66 重定读数',
  },
  {
    file: 'services/api/src/privacy/online-purge-evidence.ts',
    reason: 'R32 片B（#19，迁移 0031）新增的在线证据落库端口：两条 `SELECT public.*_online_purge_evidence(...)`'
      + ' 函数调用（**不碰任何表**）：写走 0031 的唯一写函数，读走唯一读函数。'
      + '面由**函数级**断言覆盖：90-assert 的 `online_evidence_functions_*` / `function_surface_manifest`，'
      + '以及真库臂 tests/integration/online-purge-pg.mjs [9] 实测「运行时直读 deletion_requests（含新列）'
      + '仍恰好 42501、两函数 EXECUTE 可用」。纳入本管线需 R28-S66 重定 auditedFiles 读数。',
    owner: 'R32 片B / #19；静态纳管待 R28-S66 重定读数',
  },
  {
    file: 'services/api/src/privacy/backup-state-derivation.ts',
    reason: 'R28-W6（#19）新增的「回执 backupState 由真行推导」只读 SELECT：按'
      + '`(request_id, user_id)` 读 `user_backup_copies` 的 module/scope/state/retention_until/'
      + 'payload_digest/evidence_ref（全部落在 `20-login-roles.sql` 的'
      + '`gy-i19-backup-copies-grant` 列级 SELECT 里，未新增授权）。刻意不读 `payload`：'
      + '真库臂断言该列不可读。纳入本管线需 R28-S66 重定 auditedFiles 读数，留给该片统一改。',
    owner: 'W6 / R28-W6 backup-state-derivation；静态纳管待 R28-S66 重定读数',
  },
  {
    file: 'services/api/src/admin/audit/pg.ts',
    reason: 'R34（#18，迁移 0033）新增的后台审计日志只读端口：唯一一条 SQL 是'
      + '`SELECT … FROM public.list_admin_audit_logs($1::integer, $2::timestamptz, $3::timestamptz, '
      + '$4::text[], $5::text[], $6::timestamptz, $7::uuid)` —— **函数调用**，`FROM` 后面不是表：'
      + '`public.admin_audit_events` 对运行时角色是**零表级权限**（0017 裁定的最小权限，本片不动它），'
      + '读面因此走 0033 的 `SECURITY DEFINER` 函数（固定 `search_path`、参数全绑定、`LIMIT` 函数内收口），'
      + '本文件里零字符串拼接。列面由**函数级**断言 + 真库臂覆盖：'
      + 'tests/integration/admin-audit-logs-pg.mjs 用运行时角色实测「七参数绑定 / 键集 (created_at,id) / '
      + '同一毫秒不同微秒不漏行」，并断言运行时直读 admin_audit_events 仍恰好 42501 ⇒ 零新增授权。'
      + '纳入本管线需 R28-S66 重定 auditedFiles 读数（19→20 等），留给该片统一改。',
    owner: 'R34 / #18 审计日志查询面；静态纳管待 R28-S66 重定读数',
  },
  {
    file: 'services/api/src/ai/checked-content-live-adapter.ts',
    reason: 'R28-W3 新增的 TTS「已核对内容」端口真实现，两条只读语句：'
      + '(a) `select revision, check_state, owner_id, checked_text from public.conversation_answers where id = $1::uuid limit 1`；'
      + '(b) `select revision, title, body from catalog_read.current_knowledge where id = $1::uuid and type = $2 limit 1`。'
      + '列面**零新增授权**：(a) 的四列已由 deploy/postgres-cvm/sql/20-login-roles.sql:687 的列级 SELECT 授予 '
      + 'gengyun_api_runtime（同一 GRANT 亦被 90-assert-least-privilege.sql:417 的探读臂覆盖），'
      + '(b) 的 catalog_read.current_knowledge SELECT 经 gengyun_knowledge_runtime 授予（20-login-roles.sql:225）。'
      + '纳入本管线需 R28-S66 重定 16 文件读数，留给该片统一改。',
    owner: 'W3 / R28-W3 tts checked_content 端口；静态纳管待 R28-S66 重定读数',
  },
  {
    file: 'services/api/src/privacy/privacy-policy.ts',
    reason: 'R34-S1（#29）新增的隐私政策读面，两条只读语句：'
      + '(a) `SELECT purpose,policy_version FROM public.consent_policies WHERE enabled AND reviewed_at<=clock_timestamp() … ORDER BY purpose`；'
      + '(b) `SELECT id,display_name,capability,policy_version,retention_online_days,retention_backup_days,'
      + 'no_training_verified,deletion_verified FROM public.recipients WHERE enabled AND policy_version=$1 …`。'
      + '列面**零新增授权**：`services/api/db/roles/consent_granter.sql:15` 已对这两张表授**表级** '
      + '`GRANT SELECT ON consent_policies,recipients`，`deploy/postgres-cvm/sql/20-login-roles.sql` 的 '
      + '`GRANT gengyun_consent_granter TO gengyun_api_runtime` 把该组传给运行时角色（本片零 GRANT、零迁移）。'
      + '空表即空态：两张表当前无生产种子，读面返回 version=unpublished + 空数组，不编造政策文本、也不把'
      + '「没有政策」表达成 5xx。纳入本管线需 R28-S66 重定 auditedFiles 读数（19→20 等），留给该片统一改。',
    owner: 'R34-S1 / #29 隐私政策读面；静态纳管待 R28-S66 重定读数',
  },
  {
    file: 'services/api/src/privacy/third-party-deletion-pg.ts',
    reason: 'S4-S3 P2-a（P1 迁移 0044）新增的第三方删除真库端口，两条语句都只调 SECURITY DEFINER 函数：'
      + '(a) 写 `SELECT public.record_third_party_deletion($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::timestamptz)`；'
      + '(b) 读 `SELECT recipient_id,export_ref,online_state,backup_state,requested_at,confirmed_at,evidence_ref,error_code '
      + 'FROM public.list_third_party_deletions($1::uuid)`。'
      + '列面**零新增授权**：`public.third_party_deletions` 对 `gengyun_api_runtime` 没有 INSERT/UPDATE，'
      + '**也没有 SELECT**（0044:17-22 的裁定：读写都只能过函数），0044:307-310 先 `REVOKE ALL … FROM PUBLIC`，'
      + '唯一权限面是 `deploy/postgres-cvm/sql/20-login-roles.sql` 对这两个函数的 `EXECUTE`'
      + '（本片零 GRANT、零迁移；列面已由 P1 的真库臂实测）。纳入本管线需 R28-S66 重定 auditedFiles 读数，'
      + '留给该片统一改。',
    owner: 'S4-S3 P2-a / 第三方删除真库端口；静态纳管待 R28-S66 重定读数',
  },
];

/**
 * 无法静态求值的插值登记表。元素：{ ref: 'file:line', reason: '…' }。
 *
 * 规则（两条方向都判红）：
 *   * 源码里出现、但这里没登记的插值 ⇒ 红（防「悄悄跳过」）；
 *   * 这里登记了、但源码里已经没有该 file:line ⇒ 红（防躺平：源码改了却没人复查）。
 *
 * 2026-10-21 实测只有 2 条，都是 conversations 的 keyset 分页谓词。
 */
const OPAQUE_ALLOWLIST = [
  {
    ref: SITE.conversationsWhere,
    reason: '`${where}` = listWhere(\'conversations\', …) 拼出的 keyset 分页谓词（` AND (conversations.created_at < $n …)`）；'
      + '它引用的 created_at / id 已在 CONVERSATION_COLUMNS 里被 SELECT 授权，故不影响判定，但仍按不可静态求值登记。',
  },
  {
    ref: SITE.turnsWhere,
    reason: '同上，`${where}` 用于 conversation_turns 的列表分页；引用的 created_at / id 已在 TURN_COLUMNS 里。',
  },
];

/**
 * 8 个 store-pg 的解析读数钉死值（2026-10-21 实测；同日 #17 注销清理新增 2 条 DELETE 后重测）。
 * C1b-1 合流后重算：DELETE 语句也产出「整表 DELETE」需求（+27），消息域补了 snapshotOwner 的
 * 一条 `SELECT id FROM public.messages`（+1 字面量、SELECT 66→67）；
 * C1b G6/G8 再给会话域补一条 `SELECT id FROM conversations`（+1 字面量、SELECT 67→68），故
 * 字面量 141→143、SELECT 66→68、columnRequirements 1157→1186。
 *
 * R31-S6/S1（社区域，`18005243`）重算：社区域此前**只有**读写正文的语句，注销清理与举报状态推进
 * 各新增了语句。逐条核对（文件::函数 —— 语句）后得到的增量，7 条一条不多一条不少：
 *   1. `community/store-pg.ts::commitReport` —— `SELECT ${REPORT_COLUMNS} … FOR UPDATE`（+SELECT 1、+行锁 1）
 *   2. `community/store-pg.ts::commitReport` —— `UPDATE community_reports SET revision, state`（+UPDATE 1）
 *   3. `community/store-pg.ts::purgeOwnerData` —— `UPDATE community_posts SET visibility='deleted'`（+UPDATE 1）
 *   4. `community/store-pg.ts::purgeOwnerData` —— `UPDATE community_comments SET visibility='deleted'`
 *   5. `community/store-pg.ts::purgeOwnerData` —— `UPDATE community_reports SET detail=NULL`（上两条同为 +UPDATE）
 *   6. `community/store-pg.ts::purgeOwnerData` —— `DELETE FROM community_likes`（+DELETE 1）
 *   7. `community/store-pg.ts::purgeOwnerData` —— `DELETE FROM community_idempotency WHERE scope LIKE`
 * 合计：字面量 143→150、UPDATE 21→25、SELECT 68→69、DELETE 27→29、RETURNING 56→61（3/4/5/6/7 五条
 * 都带 RETURNING 计行数）、columnRequirements 1186→1212（这 7 条引用到的列，逐列已覆盖 0 缺）。
 * 引用到的表数与 SELECT * 处数**不变**（新语句只碰已登记的表、没有新增 `*` 面）。
 *
 * R32-P2（F13 保留规则返修，`supervisor-1022-0932-pr474`）再重算：注销清理从"两条无条件软删"
 * 改为"**保留** + 逐行脱敏/媒体移除"，语句形态随之变化（**没有新增表/授权缺口**）：
 *   - 原 3/4（posts/comments 的软删 UPDATE，各带 RETURNING）删除；
 *   - 新增 `SELECT … FROM community_posts … FOR UPDATE` 与 `SELECT … FROM community_comments … FOR UPDATE`
 *     （+SELECT 2、+行锁 2）；
 *   - 新增 `UPDATE community_posts SET title,body,media_ids,revision,updated_at`（脱敏）与
 *     `UPDATE community_posts SET media_ids,updated_at`（仅移除媒体）：净 +UPDATE 1；
 *   - 新增 `UPDATE community_comments SET body,revision`（脱敏）：净 +0（抵掉原软删那条里的 UPDATE 计数）；
 *   - reports 的 `UPDATE … detail=NULL`、likes/idempotency 的 DELETE 原样保留（RETURNING 3 条不变）。
 * 合计：字面量 150→153、UPDATE 25→26、SELECT 69→71、DELETE 29（不变）、
 * RETURNING 61→59（-2，两条软删 UPDATE 的 RETURNING 消失）、columnRequirements 1212→1222。
 *
 * R31-F13（**行级作者注销引用**，迁移 0030，2026-10-22 四合流后重算）：`purgeOwnerData` 在**同一事务**里
 * 多了"把作者指针换成行内匿名引用"这一步，另有两张表的列常量各多一列 `anonymized_author_ref`：
 *   1. `UPDATE community_posts SET author_id = NULL, anonymized_author_ref = $2 … RETURNING id`
 *   2. `UPDATE community_comments` 同形
 *   3. 两条列常量各 +1 列（各被 3 条语句引用）⇒ 列要求再 +6；两条新语句自身引用
 *      `id`/`author_id`/`anonymized_author_ref` ⇒ 再 +6。
 * 合计：字面量 153→**155**、UPDATE 26→**28**、RETURNING 59→**61**、columnRequirements 1222→**1234**；
 * SELECT/DELETE/INSERT、引用表数、`SELECT *` 处数**不变**（两张表早已在清单里，两列均已授权）。
 *
 * R31-F13 P2 返修（PR #483 `[P2]`「软删行仍保留原 author_id」）：`purgeOwnerData` 的命中集不再
 * 按 `visibility` 过滤（软删行也要清作者关联），并在写入后**重新测量**剩余 owner 引用：
 *   1. 两条按主体的 `SELECT … FOR UPDATE` 去掉 `visibility <> 'deleted'` 谓词、列清单加 `visibility`
 *      —— `visibility` 原本就在同一条 WHERE 里被引用，**列要求不增**（4 处变 4 处仍各 1 条）；
 *   2. 新增一条只读语句 `SELECT count(*) … community_posts … UNION ALL … community_comments …`
 *      （+字面量 1、+SELECT 1；两表 `author_id` 各 +1 列要求 ⇒ 2 条）。
 * 实测合计：字面量 155→**156**、SELECT 71→**72**、columnRequirements 1234→**1236**（已覆盖同增，
 * 缺口仍 0）、逐文件 `community` 40→**41**；UPDATE/DELETE/INSERT/RETURNING/引用表数/`SELECT *`/
 * 无顶层 FROM 处数**不变**。
 *
 * R32（#15 在 #483 之后的去身份残留，迁移 0032，2026-10-23）：`purgeOwnerData` 多了"把举报者指针
 * 换成行内匿名引用"这一步，剩余读数多一个分支：
 *   1. 新增 `UPDATE community_reports SET reporter_id = NULL, anonymized_author_ref = $2 …`
 *      `WHERE reporter_id = $1::uuid RETURNING id`（+字面量 1、+UPDATE 1、+RETURNING 1）；
 *   2. 剩余读数那条 `SELECT count(*) … UNION ALL …` 多一个 `community_reports` 分支
 *      （同一条字面量内 ⇒ 字面量/语句数不变，`community_reports.reporter_id` +1 列要求）；
 *   3. `REPORT_COLUMNS` 常量多一列 `anonymized_author_ref`（读路径投影注销引用）。
 * 实测合计：字面量 156→**157**、UPDATE 28→**29**、RETURNING 61→**62**、
 * columnRequirements 1236→**1241**（新语句引用 `id`/`reporter_id`/`anonymized_author_ref` 3 条
 * + 剩余读数第三分支的 `reporter_id` 1 条 + `REPORT_COLUMNS` 多一列被读路径展开 1 条）、
 * 逐文件 `community` 41→**42**；SELECT/DELETE/INSERT、引用表数（举报表早已在清单里）、
 * `SELECT *`/无顶层 FROM 处数**不变**。
 *
 * R34（#19 注销闭集扩展，2026-10-23）：识别域（`recognitions`）与语音域（`speech`）接进注销
 * 闭集，两个 store-pg 各新增一个 `purgeOwnerRows`：
 *   - `recognitions/store-pg.ts` +4 条整表 DELETE（`recognition_selections` → `recognition_jobs`
 *     → `recognition_records` 按 `owner_user_id`，`recognition_idempotency` 按 scope 前缀），
 *     四条都带 `RETURNING`；列要求每条 `owner_user_id`/`id`/`scope`（均已授权）。
 *   - `speech/store-pg.ts` +3 条整表 DELETE（`speech_jobs` → `transcriptions` 按
 *     `owner_user_id`，`speech_idempotency` 按 scope 前缀），三条都带 `RETURNING`。
 *   授权面同步补齐：`deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r28-runtime-domain-grants`
 *   区新增 `GRANT DELETE ON public.recognition_jobs, recognition_records, recognition_selections`
 *   与 `GRANT DELETE ON public.speech_jobs, transcriptions`（补之前，注释里「账号注销经
 *   `request_account_deletion()` 的属主级联」是错的：该函数不删 `public.users` 行，级联永不触发）。
 * 实测合计：字面量 157→**164**、DELETE 29→**36**、RETURNING 62→**69**、
 * columnRequirements 1241→**1255**（7 条整表 DELETE 的 `*` 需求 + 各表谓词列）、
 * 逐文件 `recognitions` 20→**24**、`speech` 16→**19**；INSERT/UPDATE/SELECT、引用表数、
 * `SELECT *`/无顶层 FROM 处数**不变**。
 *
 * R34 第 2 轮（同日复审后）：**撤销**上面那 7 条整表 DELETE 与两条表级 `GRANT DELETE`，
 * 改走迁移 `0034_r34_owner_content_purge.sql` 的两条 `SECURITY DEFINER` 函数
 * （`public.purge_owner_recognitions(uuid)` / `public.purge_owner_speech(uuid)`），运行时只拿
 * `EXECUTE`。理由：`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 与
 * `tests/unit/deploy-sql-gate-probe.test.mjs` 把「运行时对 recognition_jobs / recognition_records /
 * recognition_selections / speech_jobs / transcriptions 无 DELETE」锁成**刻意的禁止面**
 * （18 条 42501 / 9 个对象）；给运行时发表级 DELETE 等于改掉一条安全不变量。
 * 存储层因此从 `DELETE … RETURNING` 改成 `SELECT public.<fn>($1::uuid) AS counts`：
 *   - `recognitions/store-pg.ts` −4 DELETE / +1 SELECT（合计 24→**21**，DELETE 6→**2**）；
 *   - `speech/store-pg.ts` −3 DELETE / +1 SELECT（合计 19→**17**，DELETE 5→**2**）。
 * 实测合计：字面量 164→**159**、DELETE 36→**29**、RETURNING 69→**62**、
 * SELECT 72→**74**（两条函数调用）、columnRequirements 1255→**1241**（回到补授权前）、
 * 逐文件 `recognitions` 24→**21**、`speech` 19→**17**；INSERT/UPDATE、引用表数、
 * `SELECT *`/无顶层 FROM 处数**不变**。授权面：五张正文表对运行时**零**表级 DELETE
 * （由 `tests/unit/least-privilege-expected-parity.test.mjs` 正向锁住）——R34 片 3 起
 * `ocr_jobs` / `ocr_records` 两表是**用户 2026-10-24 批准的**唯一例外，见下段。
 *
 * R34 片 3（2026-10-24，#19 / #10 · OCR 注销闭集）：`ocr/store-pg.ts` 新增 `purgeOwnerRows`
 * 的 3 条整表 DELETE（`ocr_records` / `ocr_jobs` 按 `owner_user_id`，`ocr_idempotency` 按 scope
 * 前缀），三条都带 `RETURNING`；授权面同步补 `GRANT DELETE ON public.ocr_jobs` 与
 * `... public.ocr_records`（与已有的 `ocr_idempotency` 合成「OCR 三表一条路线」）。
 *
 * 合并 upstream/main@997e8e5f（2026-10-24，R34 点赞只读端点）：上游新增的
 * `GET /api/v1/posts/{id}/like` 在 `community/store-pg.ts` 里只多一条 `SELECT`（读
 * `community_likes` 计数与本人点赞标记），**零**表级权限变更。
 *
 * 两笔增量**在合并树上重新实测**（不是把任一侧的旧值相加，也不是拿某一侧当基线硬减）：
 * 字面量 159→**163**、SELECT 74→**75**（点赞读面）、DELETE 29→**32**、RETURNING 62→**65**
 * （OCR 三表整表 DELETE 的三条 `RETURNING`）、columnRequirements 1241→1247→**1250**、
 * 逐文件 `ocr` 16→**19**、`community` 42→**43**；INSERT/UPDATE、引用表 25 张、
 * `SELECT *`/无顶层 FROM 处数**不变**。
 *
 * S3（迁移 0045）：`community_moderation_decisions.decided_by` 在 `store-pg.ts` 的
 * INSERT 列清单、`ON CONFLICT DO UPDATE SET`、SELECT 列清单各出现一次 ⇒ 列要求 +3，
 * 其余读数不变。
 *
 * R64（迁移 0047）：`community/store-pg.ts` 新增一条**下架审计调用** ——
 * `SELECT public.record_admin_post_hide_audit($1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid)
 * AS audit_event_id`（`COMMUNITY_POST_SQL.hideAudit`，静态整句、零插值）。与 ⑰ 的
 * `CANCEL_AUDIT_SQL` 同形：**没有 FROM** ⇒ 只让字面量、SELECT、无顶层 FROM 与逐文件
 * `community` 各 +1，**不**新增引用表/函数调用/列权限要求
 * （函数的 EXECUTE 归 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的函数面清单）。
 *   ⇒ 8 文件块：字面量 163 → **164**、SELECT 75 → **76**、逐文件 `community` 43 → **44**；
 *   20 文件块：字面量 290 → **291**、SELECT 155 → **156**、无顶层 FROM 15 → **16**、
 *   逐文件 `community` 43 → **44**；两块的 INSERT/UPDATE/DELETE、RETURNING、ON CONFLICT、
 *   `SELECT *`、引用表、行锁、不可判插值、列要求均不变。
 */
const EXPECTED_READINGS = {
  storeFiles: 8,
  sqlLiterals: 164,
  statements: { INSERT: 27, UPDATE: 29, SELECT: 76, DELETE: 32 },
  returningClauses: 65,
  onConflictClauses: 17,
  selectStar: 0,
  referencedTables: 25,
  columnRequirements: 1250,
  opaqueExpressions: 2,
};

/** 逐文件读数（钉死条数）：任何一条归零或暴增都说明解析器出事了，而不是 store 改了。 */
const EXPECTED_PER_FILE = {
  community: 44,
  conversations: 17,
  favorites: 15,
  history: 16,
  messages: 15,
  ocr: 19,
  recognitions: 21,
  speech: 17,
};

/** 运行时 SQL 里被引用到的表（逐张钉死，漏一张就说明某段解析掉了）。 */
const EXPECTED_TABLES = [
  'public.community_comments',
  'public.community_idempotency',
  'public.community_likes',
  'public.community_moderation_decisions',
  'public.community_posts',
  'public.community_reports',
  'public.conversation_answers',
  'public.conversation_turns',
  'public.conversations',
  'public.favorites',
  'public.favorites_idempotency',
  'public.history',
  'public.history_idempotency',
  'public.idempotency_keys',
  'public.messages',
  'public.ocr_idempotency',
  'public.ocr_jobs',
  'public.ocr_records',
  'public.recognition_idempotency',
  'public.recognition_jobs',
  'public.recognition_records',
  'public.recognition_selections',
  'public.speech_idempotency',
  'public.speech_jobs',
  'public.transcriptions',
];

/** 表级（整表）授权是「全列」，不是「无列」—— 判定时按全列处理，报告里单列。 */
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/**
 * 表级权限需求的**哨兵列**（C1b-1，合流后保留）：`DELETE` 在 PostgreSQL 里**没有列级形态**
 * （不存在 `GRANT DELETE (col)`），整行删除只能靠表级授权。因此 `DELETE` 语句产出的需求用
 * `column: '*'`（整表）表示，并且**只有** `kind: 'table'` 的授权才算覆盖 —— 列级授权再多
 * 也不能满足它（这正是 #17 那次的坑：`public.messages` 只授了列级 SELECT/INSERT/UPDATE，
 * `DELETE FROM public.messages` 在真库上必然 42501，而守卫当时看不见 DELETE 面）。
 */
const TABLE_WIDE_COLUMN = '*';

/**
 * R28-S66 扩展读数钉死值（2026-10-22 合流 `origin/main` @ `1aa310fa` 后按**合流树实测**重钉：**19 文件 = 8 store ＋ 11 新纳管**）。
 * 两边各加一个 SQL 宿主，读数只能按合流后的真实树重测，⛔ 不照抄任一侧的旧值：
 * ① R28-W12（本分支）把 `media/store-pg.ts` 从 UNAUDITED_SQL_HOSTS 移入真审计（17 条字面量，
 *   带来 media／media_derivatives 两表）；其中 `writeMediaRow` 的「带前置 revision/state 的原子条件 UPDATE」
 *   是返修追加的（监工 1027-1927 轮 P1）：`UPDATE … WHERE id = $1 AND revision = $14 AND state = $15::media_state
 *   RETURNING id`，让迟到的 complete 在已删除的媒体上影响 0 行、从而可判定地失败。
 * ② 2026-10-22 返修（监工 1022-0659 轮 P1「CAS=0 失利者的清理线索丢失」）给 `media/store-pg.ts` 再加 3 条：
 *   清理台账的登记（INSERT … ON CONFLICT (object_ref_digest) DO UPDATE）、扫描（SELECT … ORDER BY）、
 *   确认删除后删行（DELETE … RETURNING）；带来新表 `public.media_object_cleanup`（20-login-roles.sql 段 M2）。
 * ③ R29-S5（`origin/main`）把 `admin/ops/jobs-pg.ts` 纳入真审计（12 条字面量）。
 * ④ R29（`#434`，`origin/main`）把 `moderation/ledger-pg.ts` 纳入真审计（5 条字面量，含建行后读回确认的
 *   `SELECT superseded … WHERE job_id = $1`），带来 moderation_decisions／moderation_withdrawals 两表（段 M3）。
 * 合流树实测（`node --test tests/unit/sql-column-coverage.test.mjs` 的 console.log 原文，2026-10-22）：
 * **19 文件 / 262 条字面量 / 引用表 44 张**（合流后实测总账，见 ⑥）。
 * ⑤ 2026-10-22 再合流 `origin/main`（`7a6b7436`／`f75e1a1b`，#475／#407／#482）：`moderation/ledger-pg.ts` 的更新语句补
 *   `RETURNING job_id`（#482「命中 0 行不得标记为已持久化」）⇒ RETURNING 75 → 76、列要求 1664 → 1665、已覆盖 1610 → 1611
 *   （`public.moderation_decisions.job_id` 的 SELECT 面，已在段 M3 的列级授权清单内：未改任何 GRANT、未新增字面量）；
 *   另有 R28-W6 新登记的一个 SQL 宿主 ⇒ SQL 宿主 26 → **28**（19 已审计 + 9 登记）。
 * ⑥ 2026-10-22 三合流 `origin/main` = `1fbe7572`（#474 社区注销并入，GY-I15 社区域语句）：
 *   字面量 252 → **262**（INSERT 42 不变／UPDATE 39 → 44／SELECT 137 → 140／DELETE 34 → 36）、
 *   RETURNING 76 → **79**、行锁 FOR UPDATE 22 → **25**、rowLockRequirements 22 → **25**、
 *   列要求 1665 → **1701**、已覆盖 1611 → **1647**（缺口仍 0）、引用表 **44 张不变**（社区域没有新增表、也没有新增授权面）；
 *   与 #474 自述的增量（UPDATE +5／SELECT +3／DELETE +2／RETURNING +3／列要求 +36）逐项对齐。
 *   合流树实测：19 文件 / **262** 条字面量 / 44 张表；列要求 **1701**、已覆盖 **1647**、缺 0。
 * ⑦ 2026-10-22 四合流（最后一轮）`origin/main` = `056cf424`（#419 媒体清理并入／本片 R31-F13 行级作者注销引用）：
 *   **#419 不动本审计面**（`media/store-pg.ts` 早已在 19 文件内，见 ①/②；它的清理台账行属既有 17 条）；
 *   本片在 `community/store-pg.ts::purgeOwnerData` 新增两条
 *   `UPDATE … SET author_id = NULL, anonymized_author_ref = $2 WHERE id = ANY(…) RETURNING id`，
 *   并把 `POST_COLUMNS`/`COMMENT_COLUMNS` 各加一列 `anonymized_author_ref`（两条常量各被 3 条语句引用）。
 *   ⇒ 字面量 262 → **264**、UPDATE 44 → **46**、RETURNING 79 → **81**、列要求 1701 → **1713**
 *   （= +2×5 条新语句引用 + 2 列 × 3 语句）、已覆盖 1647 → **1659**（缺口仍 0：两列已在
 *   `20-login-roles.sql` 与 `90-assert-least-privilege.sql` **成对**授权）、逐文件 `community` 38 → **40**；
 *   INSERT/SELECT/DELETE、引用表 **44 张**、行锁 25、onConflict 26 全部不变（新语句只碰已登记的两张表）。
 *   合流树实测：19 文件 / **264** 条字面量 / 44 张表；列要求 **1713**、已覆盖 **1659**、缺 0。
 * ⑧ 2026-10-22 R31-F13 P2 返修（PR #483 `[P2]`「软删行仍保留原 author_id」）：
 *   ① 两条 `SELECT … FROM community_posts/comments … FOR UPDATE` 去掉 `visibility <> 'deleted'` 谓词、
 *      列清单加 `visibility` —— 该列本就在同一条 WHERE 里被引用 ⇒ **列要求不增**；
 *   ② 新增一条只读测量语句 `SELECT count(*)::int … community_posts … UNION ALL … community_comments …`
 *      （写入完成后重新测量「还剩几行仍指向该主体」）⇒ +字面量 1、+SELECT 1、两表 `author_id` 各 +1 列要求。
 *   ⇒ 字面量 264 → **265**、SELECT 140 → **141**、列要求 1713 → **1715**、已覆盖 1659 → **1661**（缺口仍 0：
 *   `author_id` 的 SELECT 面早已授权）、逐文件 `community` 40 → **41**；UPDATE/DELETE/INSERT/RETURNING/
 *   引用表 44 张/行锁/onConflict/无顶层 FROM 全部不变。
 *   合流树实测：19 文件 / **265** 条字面量 / 44 张表；列要求 **1715**、已覆盖 **1661**、缺 0。
 * ⑨ 2026-10-22（`#379` 遗留修复，`4de2af7d`）：行锁口径按 PG 17 文档 SELECT → Description 改正 ——
 *   `FOR SHARE` / `FOR KEY SHARE` 与 `FOR UPDATE` / `FOR NO KEY UPDATE` 一样要「至少一列 UPDATE」。
 *   口径变了，只有一项计数变：**rowLockRequirements 25 → 41**（原树 16 处共享锁语句此前一条要求都不产生，
 *   现在逐条计入；25 + 16 = 41）。`rowLocks` 分桶读数**不变**（25 FOR UPDATE／16 FOR SHARE —— 分桶只
 *   影响统计，四种强度照旧分两桶），列要求／已覆盖／引用表也不变（行锁不占列面；合流树上的
 *   1715／1661 是 `#483` 的增量，与本片无关）。真实授权面本来就给
 *   这些表授了 UPDATE（含 `profile_runtime.sql:19` 的「FOR SHARE 要 UPDATE，故只授 name」注释），
 *   所以改口径后真实基线仍 0 条行锁缺口 —— 变的只是「以后谁把 UPDATE 收回去，现在会被看见」。
 * ⑩ 2026-10-23 R32（#15 在 #483 之后的去身份残留，迁移 0032）：
 *   本片在 `community/store-pg.ts::purgeOwnerData` 新增一条
 *   `UPDATE community_reports SET reporter_id = NULL, anonymized_author_ref = $2 … RETURNING id`、
 *   剩余读数 UNION 多一个 `community_reports` 分支，`REPORT_COLUMNS` 多一列 `anonymized_author_ref`。
 *   ⇒ 字面量 265 → **266**、UPDATE 46 → **47**、RETURNING 81 → **82**、列要求 1715 → **1720**
 *   （= +3 条新语句引用 + 1 条剩余读数分支 + 1 条 `REPORT_COLUMNS` 展开）、已覆盖 1661 → **1666**
 *   （缺口仍 0：`reporter_id` 与新增的 `anonymized_author_ref` 都已在 `20-login-roles.sql` 与
 *   `90-assert-least-privilege.sql` **成对**授权）、逐文件 `community` 41 → **42**；
 *   INSERT/SELECT/DELETE、引用表 44 张、`rowLocks` 分桶、onConflict、无顶层 FROM 全部不变
 *   （本片没有新增行锁语句 ⇒ 沿用 ⑨ 的 rowLockRequirements 41，口径不因本片回退）。
 * ⑪ 2026-10-24 R34（#15 点赞读面：独立只读端点）：
 *   本片在 `community/store-pg.ts::hasLiked` 新增一条只读
 *   `SELECT 1 AS liked FROM community_likes WHERE user_id = $1::uuid AND target_type = $2::text
 *    AND target_id = $3::uuid LIMIT 1`（`liked_by_me`；计数仍复用既有 `countLikes`，未加语句）。
 *   ⇒ 字面量 266 → **267**、SELECT 141 → **142**、逐文件 `community` 42 → **43**；
 *   列要求与已覆盖**不增**（`user_id`/`target_type`/`target_id` 三列的 SELECT 面早已被
 *   `countLikes` 与 `removeLike` 计入），INSERT/UPDATE/DELETE、RETURNING、引用表 44 张、
 *   行锁、onConflict、无顶层 FROM 全部不变；本片零迁移、零 GRANT 变更。
 * 每一项都是「解析器确实在看」的硬证据：静默丢语句/丢插值会立刻改变这些数。
 * ⑪ 2026-10-23 R34（#19 注销闭集扩展）：识别域 +4 条、语音域 +3 条整表 DELETE（都带 RETURNING），
 *   授权面同步补 `GRANT DELETE`。⇒ 字面量 266 → **273**、DELETE 36 → **43**、RETURNING 82 → **89**、
 *   列要求 1720 → **1734**、已覆盖 1666 → **1680**（缺口仍 0：5 张表的整表 DELETE 已在
 *   `20-login-roles.sql` 授权）、逐文件 `recognitions` 20 → **24**、`speech` 16 → **19**；
 *   INSERT/UPDATE/SELECT、引用表 44 张、`rowLocks` 分桶、onConflict、无顶层 FROM 均不变。
 * ⑫ 2026-10-23 R34 第 2 轮（复审后改口径）：撤销 ⑪ 那 7 条整表 DELETE 与两条表级 `GRANT DELETE`，
 *   改走迁移 0034 的两条 `SECURITY DEFINER` 函数（运行时只拿 `EXECUTE`）；存储层改为
 *   `SELECT public.<fn>($1::uuid) AS counts`。⇒ 字面量 273 → **268**、DELETE 43 → **36**、
 *   RETURNING 89 → **82**、SELECT 141 → **143**、列要求 1734 → **1720**、已覆盖 1680 → **1666**、
 *   无顶层 FROM 11 → **13**（两条函数调用没有顶层 FROM）、逐文件 `recognitions` 24 → **21**、
 *   `speech` 19 → **17**；INSERT/UPDATE 42/47、引用表 44 张、`rowLocks` 分桶、onConflict、
 *   `SELECT *` 均不变。授权面：五张正文表对运行时**零**表级 DELETE（禁止面维持 18 条 42501 / 9 个对象）。
 * ⑬ 2026-10-24 本片 #18（内容域 PG 落点，迁移 0036）与上游 #19/#10（OCR 注销闭集）在
 *   合流树上**同时**存在：
 *   - #18 新增 `admin/ops/content-pg.ts`（15 条字面量：INSERT 3 / UPDATE 4 / SELECT 8，
 *     三张新表 `admin_content_entities|revisions|idempotency`）⇒ 审计文件 19 → **20**、
 *     引用表 44 → **47**、`FOR UPDATE` 25 → **26**、rowLockRequirements 41 → **42**；
 *     DELETE 不变（新域**没有**整表 DELETE、也没有任何表级 DML）。
 *   - #19/#10 给 `ocr/store-pg.ts` +3 条整表 DELETE（都带 RETURNING），授权面补
 *     `GRANT DELETE ON public.ocr_jobs` / `... public.ocr_records`（**用户 2026-10-24 批准**的
 *     表级例外）⇒ DELETE 36 → **39**、逐文件 `ocr` 16 → **19**；禁止面一字未改。
 *   合流树读数**重新实测**（不是把任一侧的旧值相加）：见下方 EXPECTED_EXTENDED_READINGS。
 * 历史读数（保留，勿据旧文案推导）：R28-S66 起始 18 文件／234 条；R31-S6/S1 社区域 +7（230→237，
 * RETURNING 71→76、行锁 +1）；R32-P2 保留/脱敏规则 +3（237→240，RETURNING 76→74、行锁 +2）。
 * ⑬ 2026-10-24 合并 upstream/main@997e8e5f：叠加本分支 `GET /api/v1/posts/{id}/like` 的那条
 *   `SELECT`（`community/store-pg.ts`）⇒ 字面量 268 → **269**、SELECT 143 → **144**；
 *   DELETE 36、RETURNING 82、列要求 1720／已覆盖 1666、引用表 44 张、`rowLocks` 分桶、
 *   INSERT/UPDATE 42/47 均不变。零迁移、零 GRANT 变更。
 * ⑭ 2026-10-25 GY-I07（Refs #7）`GET /catalog/species`：`profile/service.ts` 新增一条
 *   `SELECT … FROM public.species … FOR SHARE` ⇒ 逐文件 `profile/service.ts` 11 → **12**、
 *   字面量 272 → **273**、SELECT 144 → **145**、`rowLocks.SHARE` 16 → **17**、
 *   行锁要求 41 → **42**、引用表 44 → **45**（新增 `public.species`）、
 *   列要求 1726 → **1730**／已覆盖 1672 → **1676**（缺口仍 **0**：同步在
 *   `services/api/db/roles/profile_runtime.sql` 补了四个契约列的 SELECT 与锁列 UPDATE）。
 *   RETURNING／ON CONFLICT／`SELECT *`／函数调用／无顶层 FROM／INSERT／UPDATE／DELETE 均不变。
 * ⑮ 2026-10-25 #538 解冲突合流 `upstream/main` = `1d65b7ee`（合并后**重新实测**，非两侧旧值相加）：
 *   上游带入 `registrations` / `species` / 注销与隐私侧的 SQL 改动 ⇒ 相对本片上一版实测
 *   字面量 287 → **288**、SELECT 152 → **153**、`rowLocks.SHARE` 16 → **17**、
 *   行锁要求 42 → **43**、引用表 47 → **48**、列要求 1851 → **1855**／已覆盖 1797 → **1801**
 *   （缺口仍 **0**）；auditedFiles 20、INSERT/UPDATE/DELETE 45/51/39、RETURNING 91、
 *   ON CONFLICT 28、`SELECT *` 15（`t.*` 4）、函数调用 2、无顶层 FROM 13、不可判插值 5 均不变。
 * ⑯ 2026-10-25 #538 修红（Refs #18）：`admin/ops/content-pg.ts` 新增一条 **就绪探测 SELECT**
 *   —— `SELECT to_regclass('public.admin_content_entities') IS NOT NULL AS entities, … AS revisions,
 *   … AS idempotency`（`CONTENT_TABLES_READY_SQL`，**一次查询三列布尔**、**静态整句、零插值**：
 *   写成 `${…}` 拼接会多出一条"不可判插值"；三列而非一条 `AND` 是监工复核的要求 —— 只有把
 *   "全域未配置"与"部分 schema"分开，才判得准该不该回落）。
 *   ⇒ 字面量 288 → **289**、SELECT 153 → **154**、无顶层 FROM 13 → **14**、逐文件
 *   `admin/ops/content-pg.ts` 15 → **16**；不可判插值仍 **5**、引用表仍 **48** 张
 *   （`to_regclass` 是函数调用不是 FROM，不计引用表）、列要求 1855／已覆盖 1801（缺口 **0**）、
 *   INSERT/UPDATE/DELETE 45/51/39、RETURNING 91、ON CONFLICT 28、`SELECT *` 15、行锁 26+17、
 *   行锁要求 43、豁免 33 均不变。零迁移、零 GRANT 变更。
 * ⑰ 2026-10-25 #589 返修（Refs #18 R18，迁移 0043）：`admin/ops/jobs-pg.ts` 新增一条
 *   **取消审计调用** —— `SELECT public.record_admin_job_cancel_audit($1::uuid, $2::uuid,
 *   $3::integer, $4::text, $5::uuid) AS audit_event_id`（`CANCEL_AUDIT_SQL`）。它**没有 FROM**，
 *   所以按本文件的解析规则：table/functionCall 都算 null ⇒ 只让「无顶层 FROM」「SELECT」与字面量
 *   各 +1，**不**新增引用表、**不**新增函数调用、**不**新增列权限要求（函数的 EXECUTE 由
 *   `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的函数面清单管，不归列覆盖管）。
 *   ⇒ 字面量 289 → **290**、SELECT 154 → **155**、无顶层 FROM 14 → **15**、逐文件
 *   `admin/ops/jobs-pg.ts` 12 → **13**；auditedFiles 20、INSERT/UPDATE/DELETE 45/51/39、
 *   RETURNING 91、ON CONFLICT 28、`SELECT *` 15（`t.*` 4）、函数调用 2、引用表 48、
 *   列要求 1855／已覆盖 1801（缺口 **0**）、行锁 26+17、不可判插值 5 均不变。
 * ⑱ 2026-10-26 SPEC-S5 S-4（`admin/ops/jobs-pg.ts` 的 `target_ref.revision` 真实化；
 *   rebase 到含 #589 的 `bd3a5eaf` 后**重新实测**，⑰ 的字面量/SELECT/无顶层 FROM 三处增量独立保留）：
 *   三源的 `listSelect` / `getSql` 各加一处 `LEFT JOIN public.<记录表> AS r ON r.id = j.<记录列>`
 *   并投影 `r.revision AS target_revision` ⇒ **同一批 6 条语句**（不新增语句）各多读**一个** `revision`
 *   （与 `j.revision` 同名列，本审计按条目计数、不去重）⇒ 列要求 1855 → **1861**／
 *   已覆盖 1801 → **1807**（缺口仍 **0**：`revision` 早已在两张表的 SELECT 授权内）。
 *   字面量 **290**、语句 INSERT／UPDATE／SELECT／DELETE 45／51／155／39、引用表 48 张、
 *   无顶层 FROM **15**、逐文件 `admin/ops/jobs-pg.ts` **13**、行锁 26+17、不可判插值 5、
 *   RETURNING 91、ON CONFLICT 28、`SELECT *` 15、函数调用 2 均不变
 *   —— JOIN 的表不进表集、`ON r.id = j.…` 不被当列（`parseSqlText` 只读 `FROM` 后第一张表）。
 *   零迁移、零 GRANT 变更。
 *
 * ⑲ 2026-10-26 S3（社区帖子人工通过/驳回；迁移 0045 加 `decided_by`）：
 *   `community/store-pg.ts` 的 INSERT 列清单、`ON CONFLICT DO UPDATE SET`、SELECT 列清单
 *   各多一列 ⇒ 列要求 1861 → **1864**、已覆盖 1807 → **1810**（缺口仍 **0**：
 *   `decided_by` 已在 `20-login-roles.sql` 的列级授权与 `90-assert-least-privilege.sql`
 *   的期望清单内同步登记）。字面量与语句条数**不变**（同一条 INSERT/SELECT 内加列）。
 *
 * ⑳ 2026-10-28 R68-C1（媒体域补 `purgeOwnedMedia`：注销闭集按 owner 清媒体对象）：
 *   `media/store-pg.ts` 新增 6 条语句（读该 owner 的 media 行、读其衍生物行、软隐藏 UPDATE …
 *   RETURNING、按对象键登记 `media_object_cleanup` 的 INSERT … ON CONFLICT、清 `object_ref_cipher`
 *   的 UPDATE、删衍生物行 DELETE）⇒ 字面量 291 → **297**、逐文件 `media` 17 → **23**、
 *   语句 INSERT 45 → **46** / UPDATE 51 → **53** / SELECT 156 → **158** / DELETE 39 → **40**、
 *   RETURNING 91 → **92**、ON CONFLICT 28 → **29**；这些语句的列面 ⇒ 列要求 1864 → **1891**、
 *   已覆盖 1810 → **1837**（缺口仍 **0**：用到的列都已在 `20-login-roles.sql` 段 M 授权内，
 *   因此本片**零迁移、零 GRANT 变更**）。
 * ㉑ 2026-10-28 R68-A01（后台分类字典接线：`listAdminCategories` / `editCategory` 真读库）：
 *   `admin/ops/categories-pg.ts` 从"未纳管 SQL 宿主"移入真审计（4 条字面量：list SELECT、
 *   CAS UPDATE … RETURNING、落空分辨 SELECT、审计窄函数 SELECT）⇒ 审计文件数 20 → **21**、
 *   字面量 297 → **301**、语句 INSERT 46 / UPDATE 53 → **54** / SELECT 158 → **161** / DELETE 40、
 *   RETURNING 92 → **93**、无顶层 FROM 16 → **17**（审计那句 `SELECT public.record_admin_category_update(...)`
 *   没有 FROM）；引用表 48 → **49**（`public.admin_categories`）；列要求 1891 → **1909**、
 *   已覆盖 1837 → **1855**（缺口仍 **0**：这 6/5 列已在 `20-login-roles.sql` 段
 *   `gy-r68-catalog-grant` 授权、`90-assert` 的 `expected` 同步登记）。另一件**不动读数**的事：
 *   `admin/ops/accounts-only.ts` 里两条裸 `reject` 换成带门转发，本审计器不看 TS 逻辑，故无读数变化。
 * ㉒ 2026-10-30 GY-R71（统一作业台账 `public.jobs` 的首个写入者）：
 *   `services/api/src/jobs/ledger.ts` 进真审计（1 条字面量：那条 `INSERT … ON CONFLICT (id) DO UPDATE`
 *   upsert）⇒ 审计文件数 21 → **22**、字面量 301 → **302**、语句 INSERT 46 → **47**、ON CONFLICT
 *   29 → **30**（DO UPDATE 分支）、引用表 49 → **50**（`public.jobs`）；列要求 1909 → **1942**、
 *   已覆盖 1855 → **1888**（缺口仍 **0**：15 INSERT / 5 UPDATE / 1 SELECT 列已在
 *   `20-login-roles.sql` 的 gy-r28-runtime-domain-grants 段尾授给 `gengyun_api_runtime`，
 *   `90-assert` 的 `domain_manifest` 与 `expected` 同步登记）。另有 12 条**已有语句**的列面变化
 *   （`admin/ops/jobs-pg.ts` 的 `lockSql` 补 3 列 ×3 源、`updateSql` 的 `RETURNING` 补 `updated_at` ×3
 *   源 = 12 条 SELECT 要求；那 12 列三表本来就全授，因此只推高列要求总数，没推高缺口）。
 *   本片**零迁移**（表 0001 就有，DDL 不动），故 `verify-migrations-unique` 读数不变。
 */
const EXPECTED_EXTENDED_READINGS = {
  auditedFiles: 22,
  sqlLiterals: 303,
  statements: { INSERT: 47, UPDATE: 54, SELECT: 161, DELETE: 41 },
  returningClauses: 93,
  onConflictClauses: 30,
  selectStar: 15,
  qualifiedStar: 4,
  rowLocks: { UPDATE: 26, SHARE: 17 },
  functionCalls: 2,
  noTargetTable: 17,
  referencedTables: 50,
  columnRequirements: 1943,
  coveredRequirements: 1889,
  ledgerExemptions: 33,
  rowLockRequirements: 43,
  rowLockExemptions: 1,
  opaqueExpressions: 5,
};

/** 逐文件读数（扩展 21 文件；store 沿用域名键，新文件用 services/api/src/ 之后的相对路径）。 */
const EXPECTED_EXTENDED_PER_FILE = {
  'admin/ops/accounts-pg.ts': 1,
  'admin/ops/categories-pg.ts': 4,
  'admin/ops/content-pg.ts': 16,
  'admin/ops/flags-pg.ts': 5,
  'admin/ops/jobs-pg.ts': 13,
  'community': 44,
  'conversations': 17,
  'favorites': 15,
  'history': 16,
  'jobs/ledger.ts': 2,
  'knowledge/service.ts': 4,
  'media': 23,
  'messages': 15,
  'moderation/ledger-pg.ts': 5,
  'ocr': 19,
  'privacy/backup-copies-pg.ts': 4,
  'privacy/consent-pg.ts': 14,
  'privacy/grant-pg.ts': 12,
  'privacy/ledger-pg.ts': 24,
  'profile/service.ts': 12,
  'recognitions': 21,
  'speech': 17,
};

/** 扩展审计引用到的表（49 张；含 catalog_read 视图，迁移期不判权限）。 */
const EXPECTED_EXTENDED_TABLES = [
  'catalog_read.current_knowledge',
  'public.admin_categories',
  'public.admin_content_entities',
  'public.admin_content_idempotency',
  'public.admin_content_revisions',
  'public.community_comments',
  'public.community_idempotency',
  'public.community_likes',
  'public.community_moderation_decisions',
  'public.community_posts',
  'public.community_reports',
  'public.consent_policies',
  'public.consent_records',
  'public.conversation_answers',
  'public.conversation_turns',
  'public.conversations',
  'public.crops',
  'public.export_writebacks',
  'public.exports',
  'public.favorites',
  'public.favorites_idempotency',
  'public.feature_flags',
  'public.history',
  'public.history_idempotency',
  'public.idempotency_keys',
  'public.jobs',
  'public.media',
  'public.media_derivatives',
  'public.media_object_cleanup',
  'public.messages',
  'public.moderation_decisions',
  'public.moderation_withdrawals',
  'public.ocr_idempotency',
  'public.ocr_jobs',
  'public.ocr_records',
  'public.privacy_epochs',
  'public.recipients',
  'public.recognition_idempotency',
  'public.recognition_jobs',
  'public.recognition_records',
  'public.recognition_selections',
  'public.regions',
  'public.sessions',
  'public.single_profiles',
  'public.speech_idempotency',
  'public.speech_jobs',
  'public.species',
  'public.transcriptions',
  'public.user_backup_copies',
  'public.users',
];

/* ============================================================================
 * 一、文本工具（全部保持长度不变，便于把偏移映射回 file:line）
 * ========================================================================== */

/** 1-based 行号。 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** 跳过 `'…'` / `"…"`（SQL 里 `''` 是转义的单引号）。返回闭合引号之后的下标。 */
function skipQuoted(text, index, quote) {
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** 把若干区间抹成空格（换行保留）——长度与偏移不变。 */
function blankRanges(text, ranges) {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue;
    out += text.slice(cursor, range.start);
    out += text.slice(range.start, range.end).replace(/[^\n]/g, ' ');
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

/**
 * 剥离 SQL 行注释与块注释（不碰引号串与美元引用体）。长度与偏移不变。
 * @param {string} text
 * @returns {string}
 */
function stripSqlComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(text, i, ch);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag !== null) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? text.length : close + tag[0].length;
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === '-' && text[i + 1] === '-') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j += 1;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 收集美元引用段（`$$ … $$` / `$tag$ … $tag$`），递归进每个段的段体（`EXECUTE $gy$GRANT …$gy$`）。
 * 返回**绝对偏移**（相对入参 text 的 0 点）。
 * @param {string} text
 * @param {number} base
 * @returns {{tag: string, start: number, bodyStart: number, bodyEnd: number, end: number, children: unknown[]}[]}
 */
function collectDollarSegments(text, base = 0) {
  const pattern = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
  const segments = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const tag = match[0];
    const bodyStart = match.index + tag.length;
    const close = text.indexOf(tag, bodyStart);
    if (close === -1) break; // 未闭合：不猜，直接放弃本段（下面的断言会因「一条 GRANT 都没解析到」而红）
    const node = {
      tag,
      start: base + match.index,
      bodyStart: base + bodyStart,
      bodyEnd: base + close,
      end: base + close + tag.length,
      children: collectDollarSegments(text.slice(bodyStart, close), base + bodyStart),
    };
    segments.push(node);
    pattern.lastIndex = close + tag.length;
    match = pattern.exec(text);
  }
  return segments;
}

/**
 * 从 SQL 文本里扫出 `GRANT …;` / `REVOKE …;` 语句（跳过注释、引号串、美元引用体）。
 * 返回语句文本 + 绝对起始偏移。
 * @param {string} text 已去注释的文本
 * @param {number} offset 该文本首字符在**原文件**里的偏移
 * @returns {{sql: string, offset: number}[]}
 */
function scanGrantStatements(text, offset) {
  const segments = collectDollarSegments(text); // 相对 text 的偏移
  const statementScan = blankRanges(text, segments.map((segment) => ({ start: segment.start, end: segment.end })));
  const statements = [];
  const pushFrom = (scanText, base) => {
    let i = 0;
    while (i < scanText.length) {
      const ch = scanText[i];
      if (ch === "'" || ch === '"') {
        i = skipQuoted(scanText, i, ch);
        continue;
      }
      const head = /^(GRANT|REVOKE)\s/i.exec(scanText.slice(i, i + 8));
      const atLineStart = i === 0 || /\n/.test(scanText.slice(Math.max(0, i - 200), i).slice(-1));
      if (head !== null && atLineStart) {
        const end = scanText.indexOf(';', i);
        if (end === -1) break;
        statements.push({ sql: scanText.slice(i, end), offset: base + i });
        i = end + 1;
        continue;
      }
      i += 1;
    }
  };
  pushFrom(statementScan, offset);
  const walk = (nodes) => {
    for (const node of nodes) {
      const body = text.slice(node.bodyStart, node.bodyEnd);
      const local = blankRanges(body, node.children.map((child) => ({
        start: child.start - node.bodyStart,
        end: child.end - node.bodyStart,
      })));
      pushFrom(local, offset + node.bodyStart);
      walk(node.children);
    }
  };
  walk(segments);
  return statements;
}

/* ============================================================================
 * 二、授权面解析（20-login-roles.sql + services/api/db/roles/*.sql）
 * ========================================================================== */

/** 对象名 → `schema.name`；未限定一律落到 public（本仓 SQL 的 search_path 口径）。 */
function normalizeTable(schema, name) {
  return `${(schema ?? 'public').toLowerCase()}.${name.toLowerCase()}`;
}

/** 逗号列表按**顶层**逗号切分（括号内的逗号属于函数签名/列清单）。 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** 列清单 → 小写列名数组（去引号、去空白、忽略 `*`）。 */
function parseColumnList(text) {
  return splitTopLevel(text)
    .map((item) => item.replace(/^"|"$/g, '').trim().toLowerCase())
    .filter((item) => item !== '' && item !== '*');
}

/**
 * 解析一条 GRANT 语句。
 * @param {string} sql 语句文本（不含结尾分号）
 * @returns {null | {kind: string, [k: string]: unknown}}
 */
function parseGrantStatement(sql) {
  const text = sql.replace(/\s+/g, ' ').trim();
  const body = text.replace(/^GRANT\s+/i, '');
  const onMatch = /\s+ON\s+/i.exec(body);
  const toMatch = /\s+TO\s+/i.exec(onMatch === null ? body : body.slice(onMatch.index + onMatch[0].length));

  if (onMatch === null) {
    // 成员关系：`GRANT <组>[, <组>] TO <成员>`。
    if (toMatch === null) return { kind: 'unparsed', sql: text };
    const roles = splitTopLevel(body.slice(0, toMatch.index)).map((role) => role.toLowerCase());
    const members = splitTopLevel(body.slice(toMatch.index + toMatch[0].length))
      .map((member) => member.replace(/\s+WITH\s+ADMIN\s+OPTION$/i, '').trim().toLowerCase());
    return { kind: 'membership', roles, members, sql: text };
  }

  const privilegeClause = body.slice(0, onMatch.index).trim();
  const afterOn = body.slice(onMatch.index + onMatch[0].length);
  if (toMatch === null) return { kind: 'unparsed', sql: text };
  const objectClause = afterOn.slice(0, toMatch.index).trim();
  const granteeClause = afterOn.slice(toMatch.index + toMatch[0].length).trim();

  // `ON SCHEMA` / `ON FUNCTION` / `ON ALL TABLES IN SCHEMA` 等不是表级列权限。
  const nonTable = /^(SCHEMA|FUNCTION|PROCEDURE|ROUTINE|SEQUENCE|DATABASE|TYPE|LANGUAGE|LARGE\s+OBJECT|TABLESPACE|ALL\s+TABLES\s+IN\s+SCHEMA|ALL\s+SEQUENCES\s+IN\s+SCHEMA)\b/i.exec(objectClause);
  if (nonTable !== null) {
    return { kind: 'ignored', subject: nonTable[1].toUpperCase(), sql: text };
  }

  let columns = null;
  let privileges;
  const columnForm = /^([A-Za-z_]+)\s*\(([^)]*)\)$/.exec(privilegeClause);
  if (columnForm !== null) {
    privileges = [columnForm[1].toUpperCase()];
    columns = parseColumnList(columnForm[2]);
  } else {
    privileges = splitTopLevel(privilegeClause).map((item) => item.toUpperCase());
    // `GRANT SELECT (a) , UPDATE ON …` 这种混合形态本仓没有；出现就报出来，不猜。
    if (privileges.some((item) => /\(/.test(item))) return { kind: 'unparsed', sql: text };
  }

  const unknown = privileges.filter((item) => !PRIVILEGES.includes(item) && item !== 'ALL');
  if (unknown.length > 0) return { kind: 'ignored', subject: unknown.join(','), sql: text };
  if (privileges.includes('ALL')) return { kind: 'ignored', subject: 'ALL', sql: text };

  const objectList = splitTopLevel(objectClause.replace(/^TABLE\s+/i, ''));
  const tables = objectList.map((object) => {
    const matched = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(object);
    if (matched === null) return null;
    return normalizeTable(matched[1], matched[2]);
  });
  if (tables.some((table) => table === null)) return { kind: 'unparsed', sql: text };

  const grantees = splitTopLevel(granteeClause)
    .map((grantee) => grantee.replace(/\s+WITH\s+GRANT\s+OPTION$/i, '').replace(/^"|"$/g, '').trim().toLowerCase());

  return { kind: 'table', privileges, columns, tables, grantees, sql: text };
}

/**
 * 读授权面文件并解析成模型。
 * @param {{file: string, text: string}[]} sources
 * @returns {{grants: object[], memberships: object[], revocations: object[], problems: string[], stats: object}}
 */
function parseGrantSources(sources) {
  const grants = [];
  const memberships = [];
  const revocations = [];
  const problems = [];
  const ignored = [];
  let statementCount = 0;

  for (const { file, text } of sources) {
    const stripped = stripSqlComments(text);
    for (const { sql: raw, offset } of scanGrantStatements(stripped, 0)) {
      statementCount += 1;
      const line = lineOf(text, offset);
      const parsed = raw.trim().toUpperCase().startsWith('REVOKE')
        ? { kind: 'revoke', sql: raw.replace(/\s+/g, ' ').trim() }
        : parseGrantStatement(raw);
      if (parsed === null) continue;
      if (parsed.kind === 'unparsed') {
        problems.push(`${file}:${line} 授权语句无法解析（不静默跳过）：${parsed.sql}`);
        continue;
      }
      if (parsed.kind === 'ignored') {
        ignored.push({ file, line, subject: parsed.subject });
        continue;
      }
      if (parsed.kind === 'membership') {
        for (const role of parsed.roles) {
          for (const member of parsed.members) memberships.push({ role, member, file, line });
        }
        continue;
      }
      if (parsed.kind === 'revoke') {
        revocations.push({ file, line, sql: parsed.sql });
        continue;
      }
      for (const table of parsed.tables) {
        for (const privilege of parsed.privileges) {
          for (const grantee of parsed.grantees) {
            grants.push({ file, line, table, privilege, columns: parsed.columns, grantee });
          }
        }
      }
    }
  }

  return {
    grants,
    memberships,
    revocations,
    problems,
    stats: { statements: statementCount, grants: grants.length, memberships: memberships.length, ignored: ignored.length },
  };
}

/**
 * 计算运行时角色的**有效列权限**（自身直授 ∪ 所属组 ∪ 组的组 …；INHERIT 为真）。
 *
 * 每个 {table, privilege} 是三态之一：
 *   { kind: 'table' }            整表授权（全列）——表级 GRANT，**不是**「无列」；
 *   { kind: 'columns', columns } 列级授权的并集；
 *   undefined                    未授权。
 * 表级一旦出现就吞掉同类型的列级条目（PG 实测行为），被吞的列单独记 `swallowed`。
 *
 * @param {{file: string, text: string}[]} sources
 * @param {string} role
 * @returns {object}
 */
function buildGrantModel(sources, role = RUNTIME_ROLE) {
  const parsed = parseGrantSources(sources);
  const problems = [...parsed.problems];

  // 成员闭包（只按「GRANT 组 TO 成员」的方向）。
  const closure = new Set([role]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of parsed.memberships) {
      if (closure.has(edge.member) && !closure.has(edge.role)) {
        closure.add(edge.role);
        changed = true;
      }
    }
  }

  const tables = new Map();
  const swallowed = [];
  const decider = [];

  for (const grant of parsed.grants) {
    if (!closure.has(grant.grantee)) continue;
    decider.push(grant);
    if (!tables.has(grant.table)) tables.set(grant.table, {});
    const slot = tables.get(grant.table);
    const current = slot[grant.privilege];
    if (grant.columns === null) {
      if (current !== undefined && current.kind === 'columns') {
        // 表级吞列级：把同类型列级条目记下来（报告里单列），不要静默丢弃。
        swallowed.push({
          table: grant.table,
          privilege: grant.privilege,
          columns: [...current.columns],
          file: grant.file,
          line: grant.line,
        });
      }
      slot[grant.privilege] = { kind: 'table', file: grant.file, line: grant.line };
      continue;
    }
    if (current !== undefined && current.kind === 'table') {
      swallowed.push({
        table: grant.table,
        privilege: grant.privilege,
        columns: [...grant.columns],
        file: grant.file,
        line: grant.line,
      });
      continue;
    }
    const columns = new Set(current === undefined ? [] : current.columns);
    for (const column of grant.columns) columns.add(column);
    slot[grant.privilege] = { kind: 'columns', columns, file: grant.file, line: grant.line };
  }

  // 本仓不存在针对运行时角色的 REVOKE；一旦出现，解析器拒绝猜（表级 REVOKE 会连带撤列级）。
  for (const revocation of parsed.revocations) {
    const hit = [...closure].some((name) => new RegExp(`\\b${name}\\b`, 'i').test(revocation.sql));
    if (hit) {
      problems.push(`${revocation.file}:${revocation.line} 出现针对运行时角色（或其组）的 REVOKE，静态模型不推算其连锁效果，请人工扩写解析器：${revocation.sql}`);
    }
  }

  // INHERIT：运行时 LOGIN 必须是 INHERIT，否则「所属组的授权」根本不生效。
  const mainSource = sources.find((source) => source.file === GRANT_MAIN_FILE);
  if (mainSource !== undefined) {
    if (!/CREATE ROLE %I LOGIN INHERIT/.test(mainSource.text)) {
      problems.push(`${GRANT_MAIN_FILE} 里找不到 \`CREATE ROLE %I LOGIN INHERIT\`：运行时角色可能不是 INHERIT，组授权不生效`);
    }
    if (/\bNOINHERIT\b/i.test(mainSource.text)) {
      problems.push(`${GRANT_MAIN_FILE} 出现 NOINHERIT：组授权不生效`);
    }
  }

  return { role, closure, tables, swallowed, problems, stats: parsed.stats, grants: decider };
}

/**
 * 查某表某权限的**覆盖情况**。
 * @returns {{kind: 'table'} | {kind: 'columns', columns: Set<string>} | {kind: 'none'} | {kind: 'missing-column', columns: Set<string>}}
 */
function lookupPrivilege(model, table, privilege) {
  const slot = model.tables.get(table);
  if (slot === undefined || slot[privilege] === undefined) return { kind: 'none' };
  return slot[privilege];
}

/* ============================================================================
 * 三、运行时 SQL 解析（8 个 store-pg）
 * ========================================================================== */

/** 跳过 TypeScript 字符串（含反引号模板）与注释，返回字面量清单。 */
function scanTsLiterals(text) {
  const literals = [];
  let i = 0;
  const readTemplate = (start) => {
    const chunks = [];
    let buffer = '';
    let offset = start + 1;
    let j = start + 1;
    const flush = () => {
      if (buffer !== '') chunks.push({ type: 'text', value: buffer, offset: offset - buffer.length });
      buffer = '';
    };
    while (j < text.length) {
      const ch = text[j];
      if (ch === '\\') {
        buffer += text[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (ch === '`') {
        flush();
        return { kind: 'template', start, end: j + 1, chunks };
      }
      if (ch === '$' && text[j + 1] === '{') {
        flush();
        const exprStart = j + 2;
        let depth = 1;
        let k = exprStart;
        while (k < text.length && depth > 0) {
          if (text[k] === "'" || text[k] === '"') {
            k = skipQuoted(text, k, text[k]);
            continue;
          }
          if (text[k] === '`') {
            k = readTemplate(k).end;
            continue;
          }
          if (text[k] === '{') depth += 1;
          if (text[k] === '}') depth -= 1;
          if (depth === 0) break;
          k += 1;
        }
        chunks.push({ type: 'expr', value: text.slice(exprStart, k), offset: exprStart });
        j = k + 1;
        offset = j;
        continue;
      }
      buffer += ch;
      j += 1;
    }
    flush();
    return { kind: 'template', start, end: text.length, chunks };
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(text, i, ch);
      const raw = text.slice(i + 1, end - 1).replace(/\\(.)/g, '$1');
      literals.push({ kind: 'quoted', start: i, end, chunks: [{ type: 'text', value: raw, offset: i + 1 }] });
      i = end;
      continue;
    }
    if (ch === '`') {
      const node = readTemplate(i);
      literals.push(node);
      i = node.end;
      continue;
    }
    i += 1;
  }
  return literals;
}

/**
 * 文件内的 `const NAME = 'a' + 'b';` / `` const NAME = `…`; `` 常量表（只收「纯字符串」形态）。
 *
 * 反引号形态为什么必须收：`services/api/src/privacy/consent-pg.ts:46-48` 的
 * `` const currentRecords = `SELECT c.*,… FROM public.privacy_epochs p LEFT JOIN …` `` 是
 * **无插值**的模板串，S61 的常量表只认单/双引号拼接，于是 `:126`/`:140`/`:165` 三处
 * `` `${currentRecords} WHERE …` `` 的插值无从代入 —— 语句被静默丢弃（含 `:165` 的
 * `FOR UPDATE OF p`）。收进常量表后三条语句都能落到同一条管线上。
 * 带 `${` 的模板串仍然不入表（不是静态可判的），会走 opaque 登记。
 */
function buildConstMap(text) {
  const map = new Map();
  const stripped = text
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*((?:\s*(?:'[^']*'|"[^"]*")\s*\+?)+);/g;
  let match = pattern.exec(stripped);
  while (match !== null) {
    const value = [...match[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map((item) => item[1] ?? item[2]).join('');
    map.set(match[1], value);
    match = pattern.exec(stripped);
  }
  const templatePattern = /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`;/g;
  let templateMatch = templatePattern.exec(stripped);
  while (templateMatch !== null) {
    if (!templateMatch[2].includes('${') && !map.has(templateMatch[1])) map.set(templateMatch[1], templateMatch[2]);
    templateMatch = templatePattern.exec(stripped);
  }
  return map;
}

/**
 * SQL 字面量的起点判据。必须是「动词 + 至少一个非空白字符」，不能只判 `\b`：
 * `services/api/src/privacy/consent-pg.ts:149` 的 `idempotencyScope(userId, 'DELETE', …)`
 * 是一个 HTTP 动词串，`\b` 版本会把它计成 1 条 DELETE 语句（R28-S66 阶段二实测），
 * 凭空污染 sqlLiterals/statements 读数并对 `DELETE` 去抢 `public.*` 表。
 */
const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE)\s+\S/i;

/**
 * `stats.byFile` 的键：store-pg 沿用域目录名（community/…，与 S61 钉死读数一致），
 * 其余宿主用 `services/api/src/` 之后的相对路径。
 *
 * 为什么必须这么修：S61 用的是 `file.split('/').slice(-2)[0]`（取倒数第二段），对
 * `admin/ops/accounts-pg.ts` 与 `admin/ops/flags-pg.ts` 都会得到 `ops`、对 5 个 privacy 文件
 * 都会得到 `privacy` —— 后写覆盖前写，8 个新文件只剩 4 个键（阶段一实测），逐文件读数会失真。
 */
function hostKey(file) {
  const parts = file.split('/');
  if (parts.length >= 2 && parts[parts.length - 1] === 'store-pg.ts') return parts[parts.length - 2];
  const prefix = `${STORE_ROOT}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * 行锁口径（PG 17 文档 SELECT → Description 原文）：
 *   "You must have `SELECT` privilege on each column used in a `SELECT` command.
 *    The use of `FOR NO KEY UPDATE`, `FOR UPDATE`, `FOR SHARE` or `FOR KEY SHARE`
 *    requires `UPDATE` privilege as well (for at least one column of each table so selected)."
 * 即**四种强度一律**要「至少一列 UPDATE」，FOR SHARE / FOR KEY SHARE 不例外（#379 遗留：
 * 本文件此前只把 FOR UPDATE / FOR NO KEY UPDATE 记成要求，共享锁被整段丢掉，
 * 于是「只有 SELECT」的角色写 `SELECT … FOR SHARE` 会被判成权限齐全）。
 * 注意这是**静态模型**：本仓已在 S26 用「列级 `UPDATE (revision)` 作行锁载体」实测过
 * 42501（见证据页），所以这里按「表级或任一列 UPDATE 即可」判定（PG 允许列级 UPDATE 满足行锁）。
 * @param {{word: string, index: number}[]} tokens
 * @returns {'UPDATE' | 'NO KEY UPDATE' | 'SHARE' | 'KEY SHARE' | null}
 */
function readRowLock(tokens) {
  const index = tokens.findIndex((token, i) => token.word === 'FOR'
    && ['UPDATE', 'SHARE', 'NO', 'KEY'].includes(tokens[i + 1]?.word ?? ''));
  if (index === -1) return null;
  const words = tokens.slice(index + 1, index + 5).map((token) => token.word);
  if (words[0] === 'NO' && words[1] === 'KEY' && words[2] === 'UPDATE') return 'NO KEY UPDATE';
  if (words[0] === 'KEY' && words[1] === 'SHARE') return 'KEY SHARE';
  if (words[0] === 'UPDATE') return 'UPDATE';
  if (words[0] === 'SHARE') return 'SHARE';
  return null;
}

/**
 * 行锁读数分桶：只影响**统计口径**（既有读数 `rowLocks: {UPDATE, SHARE}` 原样保留），
 * 不影响要求收集 —— 四种强度全都要求 UPDATE（见 readRowLock 的文档原文）。
 * @param {'UPDATE' | 'NO KEY UPDATE' | 'SHARE' | 'KEY SHARE'} strength
 * @returns {'UPDATE' | 'SHARE'}
 */
function rowLockBucket(strength) {
  return strength.endsWith('SHARE') ? 'SHARE' : 'UPDATE';
}

/**
 * 抽出 8 个 store-pg 里的 SQL 字面量，并把列清单常量代入。
 * @returns {{statements: object[], opaque: object[], stats: object}}
 */
function extractRuntimeSql(sources) {
  const statements = [];
  const opaque = [];
  const stats = {
    storeFiles: sources.length,
    sqlLiterals: 0,
    statements: { INSERT: 0, UPDATE: 0, SELECT: 0, DELETE: 0 },
    returningClauses: 0,
    onConflictClauses: 0,
    selectStar: 0,
    qualifiedStar: 0,
    // 两个**分桶**（不是两种子句）：UPDATE = FOR UPDATE / FOR NO KEY UPDATE，SHARE = FOR SHARE /
    // FOR KEY SHARE。四种强度都产出行锁要求（见 readRowLock），分桶只服务于统计读数。
    rowLocks: { UPDATE: 0, SHARE: 0 },
    functionCalls: 0,
    noTargetTable: 0,
    byFile: {},
  };

  for (const { file, text } of sources) {
    const constants = buildConstMap(text);
    const key = hostKey(file);
    const perFile = { file, key, sqlLiterals: 0, statements: { INSERT: 0, UPDATE: 0, SELECT: 0, DELETE: 0 } };
    stats.byFile[key] = perFile;
    for (const literal of scanTsLiterals(text)) {
      const startLine = lineOf(text, literal.start);
      const pending = [];
      let sql = '';
      for (const chunk of literal.chunks) {
        if (chunk.type === 'text') {
          sql += chunk.value;
          continue;
        }
        const expr = chunk.value.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(expr) && constants.has(expr)) {
          sql += constants.get(expr);
          continue;
        }
        pending.push({
          ref: `${file}:${lineOf(text, chunk.offset)}`,
          file,
          line: lineOf(text, chunk.offset),
          expr: `\${${expr}}`,
          statementLine: startLine,
        });
        sql += ' ';
      }

      // 判据必须落在**代入常量之后**的 sql 上，不能看第一个 text chunk：S61 用的是
      // `literal.chunks.find(text)`，于是 `` `${currentRecords} WHERE …` ``（常量在插值位）
      // 的首个 text chunk 是 ` WHERE …` ⇒ 整条语句被静默跳过（既不成语句也不进 opaque）。
      // R28-S66 实测：`services/api/src/privacy/consent-pg.ts` 的 :126/:140/:165 三条
      // 就是这样丢的，其中 :165 还带 `FOR UPDATE OF p`（行锁要求也一起丢了）。
      if (!SQL_START.test(sql)) continue;
      stats.sqlLiterals += 1;
      perFile.sqlLiterals += 1;
      opaque.push(...pending);

      const parsedStatements = parseSqlText(sql, { file, line: startLine });
      for (const statement of parsedStatements) {
        stats.statements[statement.verb] = (stats.statements[statement.verb] ?? 0) + 1;
        perFile.statements[statement.verb] = (perFile.statements[statement.verb] ?? 0) + 1;
        if (statement.returningColumns.length > 0 || statement.hasReturning) stats.returningClauses += 1;
        if (statement.conflict !== null) stats.onConflictClauses += 1;
        if (statement.selectStar) stats.selectStar += 1;
        if (statement.qualifiedStar) stats.qualifiedStar += 1;
        if (statement.rowLock !== null) stats.rowLocks[rowLockBucket(statement.rowLock)] += 1;
        if (statement.functionCall !== null) stats.functionCalls += 1;
        if (statement.table === null) stats.noTargetTable += 1;
        statements.push(statement);
      }
    }
  }

  return { statements, opaque, stats };
}

/** 顶层（括号外、引号外）词元扫描。 */
function topLevelTokens(text) {
  const tokens = [];
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i, ch) - 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      tokens.push({ word: text.slice(i, j).toUpperCase(), index: i, end: j });
      i = j - 1;
    }
  }
  return tokens;
}

/** 从 `schema.table` / `table` 里取表名；未限定 → public。 */
function readQualifiedName(text) {
  const matched = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*))?/.exec(text);
  if (matched === null) return null;
  return matched[2] === undefined ? normalizeTable(null, matched[1]) : normalizeTable(matched[1], matched[2]);
}

/** 表达式里「被读取的列」——剥别名、剥 `::type`、剥 `extract(field FROM x)`、剥表限定、去函数名与关键字。 */
const EXPR_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'AS', 'IN', 'IS', 'DISTINCT', 'ALL', 'ORDER', 'BY', 'GROUP', 'LIMIT', 'OFFSET', 'FOR', 'UPDATE', 'SHARE',
  'INSERT', 'INTO', 'VALUES', 'SET', 'DELETE', 'RETURNING', 'ON', 'CONFLICT', 'DO', 'NOTHING', 'EXCLUDED',
  'USING', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'JOIN', 'ASC', 'DESC', 'UNION', 'INTERVAL', 'DEFAULT', 'COALESCE',
]);

/**
 * @param {string} expression
 * @returns {string[]}
 */
function extractExpressionColumns(expression) {
  let text = expression;
  // 逐项剥 `AS 别名`：S61 只剥**末尾**一项，`SELECT c.*, p.state AS epoch_state, p.current_epoch`
  // 会把中段别名 `epoch_state` 漏成假列（R28-S66 阶段一在 privacy_epochs 上实测到 `c` / `epoch_state`
  // 两个假列）。别名不是列，必须逐项剥掉。
  text = splitTopLevel(text)
    .map((item) => item.replace(/\s+AS\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i, '').trim())
    .join(', ');
  // `t.*` 是「该表的全列」——列面不可静态判定，由 parseSqlText 标记成 selectStar，
  // 这里只把残留的限定星号抹掉，免得 `t` 本身被当成列。
  text = text.replace(/[A-Za-z_][A-Za-z0-9_]*\s*\.\s*\*/g, ' ');
  text = text.replace(/::\s*[A-Za-z_][A-Za-z0-9_]*(\s*\[\s*\])?/g, ' ');
  // `extract(<field> FROM <expr>)`：字段名不是列，括号里的 expr 才是。
  text = text.replace(/\bextract\s*\(\s*[A-Za-z_]+\s+FROM\s+/gi, '(');
  text = text.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g, '$2');

  const columns = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i, ch) - 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) continue;
    let j = i;
    while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
    const name = text.slice(i, j);
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k += 1;
    const isCall = text[k] === '(';
    if (!isCall && !EXPR_KEYWORDS.has(name.toUpperCase())) columns.push(name.toLowerCase());
    i = j - 1;
  }
  return columns;
}

/**
 * 解析一段（已代入常量、已抹掉不可判插值的）SQL。
 * @param {string} sql
 * @param {{file: string, line: number}} origin
 * @returns {object[]}
 */
function parseSqlText(sql, origin) {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (text === '') return [];
  const tokens = topLevelTokens(text);
  if (tokens.length === 0) return [];
  const verb = tokens[0].word;
  const locate = (word) => tokens.find((token) => token.word === word) ?? null;

  const base = {
    verb,
    file: origin.file,
    line: origin.line,
    sql: text.length > 220 ? `${text.slice(0, 220)}…` : text,
    table: null,
    selectColumns: [],
    insertColumns: [],
    updateColumns: [],
    returningColumns: [],
    hasReturning: false,
    conflict: null,
    selectStar: false,
    qualifiedStar: false,
    starItems: [],
    rowLock: readRowLock(tokens),
    functionCall: null,
  };

  const returningToken = locate('RETURNING');
  if (returningToken !== null) {
    base.hasReturning = true;
    const tail = text.slice(returningToken.end);
    base.returningColumns = parseColumnList(tail.replace(/;+\s*$/, ''));
  }

  if (verb === 'INSERT') {
    const into = locate('INTO');
    if (into !== null) base.table = readQualifiedName(text.slice(into.end));
    if (into !== null) {
      const afterTable = text.slice(into.end).replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_]*)?/, '');
      const columnList = /^\s*\(([^)]*)\)/.exec(afterTable);
      if (columnList !== null) base.insertColumns = parseColumnList(columnList[1]);
    }
    const conflictToken = locate('CONFLICT');
    if (conflictToken !== null) {
      const afterConflict = text.slice(conflictToken.end);
      const target = /^\s*\(([^)]*)\)/.exec(afterConflict);
      const setToken = tokens.find((token) => token.word === 'SET' && token.index > conflictToken.index) ?? null;
      let updateColumns = [];
      if (setToken !== null) {
        const tail = text.slice(setToken.end);
        const stop = /\s(WHERE|RETURNING)\s/i.exec(tail);
        const setClause = stop === null ? tail : tail.slice(0, stop.index);
        updateColumns = splitTopLevel(setClause)
          .map((item) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(item))
          .filter((item) => item !== null)
          .map((item) => item[1].toLowerCase());
      }
      base.conflict = {
        target: target === null ? null : parseColumnList(target[1]),
        updateColumns,
        doNothing: /DO\s+NOTHING/i.test(afterConflict),
      };
    }
    return [base];
  }

  if (verb === 'UPDATE') {
    base.table = readQualifiedName(text.slice(tokens[0].end));
    const setToken = locate('SET');
    if (setToken !== null) {
      const tail = text.slice(setToken.end);
      const stop = /\s(WHERE|RETURNING)\s/i.exec(tail);
      const setClause = stop === null ? tail : tail.slice(0, stop.index);
      base.updateColumns = splitTopLevel(setClause)
        .map((item) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(item))
        .filter((item) => item !== null)
        .map((item) => item[1].toLowerCase());
    }
    return [base];
  }

  if (verb === 'DELETE') {
    const from = locate('FROM');
    if (from !== null) base.table = readQualifiedName(text.slice(from.end));
    return [base];
  }

  if (verb === 'SELECT') {
    const from = locate('FROM');
    if (from === null) return [base]; // 纯标量子查询（count(*)），没有目标表
    const afterFrom = text.slice(from.end);
    base.table = readQualifiedName(afterFrom);
    // 「函数调用不是表访问」（派单 §2.4）：`FROM public.list_admin_accounts()` 是
    // SECURITY DEFINER 函数，列面由函数签名钉死，调用方只需要 EXECUTE，不产生任何列要求。
    // 判据只看 `FROM <限定名>` 之后紧跟的是不是 `(`（`FROM (SELECT …)` 走 nameMatch===null 分支，
    // 本来就 table=null；`INSERT INTO t(cols)` / `UPDATE t SET` 不在这个分支）。
    const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*))?/.exec(afterFrom);
    if (nameMatch !== null && /^\s*\(/.test(afterFrom.slice(nameMatch[0].length))) {
      base.functionCall = base.table;
      base.table = null;
      return [base];
    }
    const selectList = text.slice(tokens[0].end, from.index).trim();
    const items = splitTopLevel(selectList);
    // `*` 与 `t.*` 都是「列面不可静态判定」：记 selectStar（不产生列要求），但单独记录形态，
    // 以免把「整表投影」当成「没有列要求」而悄悄放过。
    base.starItems = items.filter((item) => /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?\*\s*$/.test(item)).map((item) => item.trim());
    if (base.starItems.length > 0) {
      base.selectStar = true;
      base.qualifiedStar = base.starItems.some((item) => item.includes('.'));
    }
    const expressionItems = items.filter((item) => !base.starItems.includes(item.trim()));
    base.selectColumns = extractExpressionColumns(expressionItems.join(', '));
    return [base];
  }

  return [];
}

/* ============================================================================
 * 四、把「运行时引用」与「有效列权限」对上
 * ========================================================================== */

/**
 * 每条语句 → 需要的 {table, column, privilege}。
 * SET 的左侧 = UPDATE；INSERT 列清单 = INSERT；SELECT 列与 RETURNING 列 = SELECT；
 * ON CONFLICT 的冲突目标 = SELECT（本仓口径，见 20-login-roles.sql 「ON CONFLICT 的推断 … 要 SELECT 权」）；
 * **DELETE 语句 = 表级 DELETE**（C1b-1）：PG 没有列级 DELETE，用哨兵列 `*` 表达整表需求。
 * @param {object[]} statements
 * @returns {object[]}
 */
function collectRequirements(statements) {
  const requirements = [];
  const add = (statement, column, privilege, clause) => {
    requirements.push({
      table: statement.table,
      column,
      privilege,
      clause,
      ref: `${statement.file}:${statement.line}`,
    });
  };
  for (const statement of statements) {
    if (statement.table === null) continue;
    for (const column of statement.insertColumns) add(statement, column, 'INSERT', 'INSERT 列清单');
    for (const column of statement.selectColumns) add(statement, column, 'SELECT', 'SELECT 列清单');
    for (const column of statement.updateColumns) add(statement, column, 'UPDATE', 'UPDATE SET');
    for (const column of statement.returningColumns) add(statement, column, 'SELECT', 'RETURNING');
    if (statement.verb === 'DELETE') add(statement, TABLE_WIDE_COLUMN, 'DELETE', 'DELETE 整表（PG 无列级 DELETE）');
    if (statement.conflict !== null) {
      for (const column of statement.conflict.target ?? []) add(statement, column, 'SELECT', 'ON CONFLICT 冲突目标');
      for (const column of statement.conflict.updateColumns) add(statement, column, 'UPDATE', 'ON CONFLICT DO UPDATE SET');
    }
  }
  return requirements;
}

/**
 * 行锁要求（PG 17 文档 SELECT → Description）：`FOR UPDATE` / `FOR NO KEY UPDATE` /
 * `FOR SHARE` / `FOR KEY SHARE` **四条子句一律**额外要一条 UPDATE 要求
 * （列面不可知 —— PG 允许「任一列 UPDATE」满足行锁，故按「表级或任列」判定，
 * 见 evaluateRowLocks）。`clause` 保留具体强度，判红时能直接读出是哪条子句。
 * @param {object[]} statements
 * @returns {object[]}
 */
function collectRowLockRequirements(statements) {
  const requirements = [];
  for (const statement of statements) {
    if (statement.rowLock === null || statement.table === null) continue;
    requirements.push({
      table: statement.table,
      privilege: 'UPDATE',
      clause: `行锁 FOR ${statement.rowLock}`,
      ref: `${statement.file}:${statement.line}`,
    });
  }
  return requirements;
}

/**
 * 行锁判红的措辞与列级判红保持同一形态（能 grep 到 `缺 UPDATE` + `授权面现状`）。
 *
 * 豁免与列级豁免同构（`{table, privilege, ref, reason, owner}`），但额外要求 `ref` 精确到
 * `file:line` —— 行锁要求没有列名，只按表豁免会把同表上的新语句一起放行（躺平）。
 * 反向核对 `staleRowLockExemptions`：登记了却对不上任何行锁要求即红。
 * @param {object[]} requirements
 * @param {object} model
 * @param {object[]} [exemptions]
 * @returns {{problems: string[], staleExemptions: string[], exempted: object[]}}
 */
function evaluateRowLocks(requirements, model, exemptions = []) {
  const problems = [];
  const staleExemptions = [];
  const exempted = [];
  const matched = new Set();
  for (const requirement of requirements) {
    const granted = lookupPrivilege(model, requirement.table, requirement.privilege);
    // 本仓口径（证据页 §3 写明）：表级 UPDATE，或该表**任一列**有 UPDATE，即可满足行锁
    // （PG 17 文档 SELECT 页：四种锁定子句除 SELECT 外都要 UPDATE，
    //  "for at least one column of each table so selected"）。
    const ok = granted.kind === 'table' || (granted.kind === 'columns' && granted.columns.size > 0);
    if (ok) continue;
    const hit = exemptions.findIndex((item) => item.table === requirement.table
      && item.privilege === requirement.privilege
      && item.ref === requirement.ref);
    if (hit !== -1) {
      matched.add(hit);
      exempted.push({ requirement, exemption: exemptions[hit] });
      continue;
    }
    problems.push(
      `${requirement.ref} → ${requirement.table} 缺 ${requirement.privilege}（${requirement.clause}，`
      + 'PG 对 FOR UPDATE/FOR NO KEY UPDATE/FOR SHARE/FOR KEY SHARE 除 SELECT 外还要求 UPDATE 权限'
      + '（至少一列））；'
      + `授权面现状：${granted.kind === 'none' ? '该表该权限未授任何列' : '（不可达分支）'}`,
    );
  }
  exemptions.forEach((item, index) => {
    if (matched.has(index)) return;
    staleExemptions.push(
      `ROW_LOCK_EXEMPT 登记的 ${item.ref} → ${item.table} 缺 ${item.privilege} 在源码里已不成立`
      + '（陈旧登记，删掉它以免守卫躺平）',
    );
  });
  return { problems, staleExemptions, exempted };
}

/**
 * 正向核对 + 例外 / 陈旧例外。
 * @param {object[]} requirements
 * @param {object} model
 * @param {object[]} exemptions
 * @returns {{problems: string[], staleExemptions: string[], missing: object[], covered: number}}
 */
function evaluateCoverage(requirements, model, exemptions) {
  const problems = [];
  const staleExemptions = [];
  const missing = [];
  const exempt = new Map();
  for (const exemption of exemptions) {
    const shapeOk = typeof exemption?.ref === 'string'
      && /^[a-z_]+\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(exemption.ref)
      && typeof exemption.privilege === 'string'
      && PRIVILEGES.includes(exemption.privilege)
      && typeof exemption.reason === 'string' && exemption.reason.trim() !== ''
      && typeof exemption.owner === 'string' && exemption.owner.trim() !== '';
    if (!shapeOk) {
      problems.push(`COVERAGE_EXEMPT 条目形状不合规（必须含 ref=table.column / privilege / reason / owner）：${JSON.stringify(exemption)}`);
      continue;
    }
    exempt.set(`${exemption.ref}|${exemption.privilege}`, exemption);
  }

  const seen = new Set();
  const genuinelyMissing = new Set();
  let covered = 0;
  // 覆盖来源拆分：靠「表级（整表）授权」蒙过去的条数 vs 靠「列级精确授权」命中的条数。
  // 这个读数决定本守卫有多硬：表级占比越高，说明核对越粗。
  let viaTableLevel = 0;
  let viaColumnLevel = 0;
  for (const requirement of requirements) {
    const key = `${requirement.table}.${requirement.column}|${requirement.privilege}`;
    seen.add(key);
    const granted = lookupPrivilege(model, requirement.table, requirement.privilege);
    // 整表需求（`column: '*'`，目前只有 DELETE）：**只认表级授权**（C1b-1）。
    // 列级授权无论给了多少列都不满足「能删整行」—— PG 里没有 `GRANT DELETE (col)`。
    const tableWide = requirement.column === TABLE_WIDE_COLUMN;
    const ok = tableWide
      ? granted.kind === 'table'
      : (granted.kind === 'table' || (granted.kind === 'columns' && granted.columns.has(requirement.column)));
    if (ok) {
      covered += 1;
      if (granted.kind === 'table') viaTableLevel += 1;
      else viaColumnLevel += 1;
      continue;
    }
    genuinelyMissing.add(key);
    if (exempt.has(key)) continue;
    missing.push(requirement);
    const target = tableWide ? `${requirement.table}（整表）` : `${requirement.table}.${requirement.column}`;
    problems.push(
      `${requirement.ref} → ${target} 缺 ${requirement.privilege}（${requirement.clause}）；`
      + `授权面现状：${granted.kind === 'none' ? '该表该权限未授任何列' : `只授了 [${[...granted.columns].join(', ')}]`}`,
    );
  }

  // 陈旧例外 = 登记了、但**实际并不缺**（两种：该引用已不存在，或该列其实已授权）。
  for (const [key, exemption] of exempt) {
    if (!genuinelyMissing.has(key)) {
      staleExemptions.push(
        `COVERAGE_EXEMPT 里登记的 ${exemption.ref}（${exemption.privilege}）已不再缺失`
        + `${seen.has(key) ? '（该列在授权面里其实已授权）' : '（运行时 SQL 已不再引用该列）'} —— 陈旧例外，删掉它`,
      );
    }
  }

  return { problems, staleExemptions, missing, covered, viaTableLevel, viaColumnLevel };
}

/** 不可判插值的双向核对。 */
function evaluateOpaque(observed, allowlist) {
  const problems = [];
  const allowed = new Set(allowlist.map((entry) => entry.ref));
  const seen = new Set();
  for (const item of observed) {
    if (!allowed.has(item.ref)) {
      problems.push(`未登记的不可判插值 ${item.ref}（${item.expr}）：要么让它可静态求值，要么登记进 OPAQUE_ALLOWLIST 并写清理由`);
    }
    seen.add(item.ref);
  }
  for (const entry of allowlist) {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`OPAQUE_ALLOWLIST 条目缺 reason：${entry.ref}`);
    }
    if (!seen.has(entry.ref)) {
      problems.push(`OPAQUE_ALLOWLIST 登记的 ${entry.ref} 在源码里已不存在（陈旧登记，删掉它以免守卫躺平）`);
    }
  }
  return { problems };
}

/** 反向报告：授权面里存在、但运行时 SQL 从未引用的列（只报告，不判红）。 */
function buildSupersetReport(requirements, model) {
  const referenced = new Map();
  for (const requirement of requirements) {
    if (!referenced.has(requirement.table)) referenced.set(requirement.table, new Set());
    referenced.get(requirement.table).add(`${requirement.privilege}|${requirement.column}`);
  }

  const unusedOnReferencedTables = [];
  const wholeTableUnused = [];
  const tableLevel = [];
  for (const [table, slot] of model.tables) {
    const refs = referenced.get(table);
    if (refs === undefined) {
      wholeTableUnused.push({ table, privileges: Object.keys(slot) });
      continue;
    }
    for (const privilege of PRIVILEGES) {
      const granted = slot[privilege];
      if (granted === undefined) continue;
      if (granted.kind === 'table') {
        tableLevel.push({ table, privilege, file: granted.file, line: granted.line });
        continue;
      }
      for (const column of granted.columns) {
        if (!refs.has(`${privilege}|${column}`)) unusedOnReferencedTables.push({ table, privilege, column });
      }
    }
  }
  return { unusedOnReferencedTables, wholeTableUnused, tableLevel };
}

/* ============================================================================
 * 五、装载真实输入 + 总装
 * ========================================================================== */

/** @returns {{file: string, text: string}[]} */
function loadGrantSources(dir = undefined) {
  const absolute = (relativePath) => resolve(root, relativePath);
  const sources = [{ file: GRANT_MAIN_FILE, text: readFileSync(absolute(GRANT_MAIN_FILE), 'utf8') }];
  const rolesPath = dir ?? resolve(root, ROLES_DIR);
  for (const name of readdirSync(rolesPath).filter((entry) => entry.endsWith('.sql')).sort()) {
    sources.push({ file: `${ROLES_DIR}/${name}`, text: readFileSync(resolve(rolesPath, name), 'utf8') });
  }
  return sources;
}

/** @returns {{file: string, text: string}[]} */
function loadStoreSources() {
  return EXPECTED_STORE_FILES.map((domain) => {
    const file = `${STORE_ROOT}/${domain}/store-pg.ts`;
    const absolute = resolve(root, file);
    assert.ok(existsSync(absolute), `缺少 ${file}（派单 §3.2 的 8 个 store-pg 之一）`);
    return { file, text: readFileSync(absolute, 'utf8') };
  });
}

/** R28-S66 的另外 8 个 SQL 宿主文件（相对 STORE_ROOT 的路径在 ADDITIONAL_SQL_HOST_FILES 里登记；合流后共 10 个）。 */
function loadAdditionalSources() {
  return ADDITIONAL_SQL_HOST_FILES.map((relativePath) => {
    const file = `${STORE_ROOT}/${relativePath}`;
    const absolute = resolve(root, file);
    assert.ok(existsSync(absolute), `缺少 ${file}（R28-S66 登记的 SQL 宿主文件之一）`);
    return { file, text: readFileSync(absolute, 'utf8') };
  });
}

/** 本片审计的 16 个源文件：8 个 store-pg + 8 个新纳管文件（同一套管线，不另造判据）。 */
function loadAuditedSources() {
  return [...loadStoreSources(), ...loadAdditionalSources()];
}

/**
 * 递归列出 `directory` 下所有 `.ts`（相对**扫描基准** `baseDir` 的 posix 路径，已排序）。
 *
 * `baseDir` 默认仓库根。NC7 负控制要把它显式指到 `os.tmpdir()` 沙箱：临时宿主**不许**落进
 * `services/api/src` —— 那是全量单测的并行扫描面（详见 NC7 的注释与
 * `tests/unit/unit-suite-scan-write-isolation.test.mjs`）。
 */
function listTypeScriptFiles(directory, baseDir = root) {
  const absolute = resolve(baseDir, directory);
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(relativePath, baseDir));
    else if (entry.name.endsWith('.ts')) files.push(relativePath);
  }
  return files.sort();
}

/** 派单 §0 的 grep 谓词（`public.` 限定的 SQL），**按语句判**而非按文件原文判：注释里的 SQL 不算。 */
const PUBLIC_QUALIFIED_SQL = /(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|FROM|JOIN)\s+public\.[a-z_]/i;

/**
 * 文件集不变量的扫描器：扫 `services/api/src/**\/*.ts`，返回「解析出至少一条带目标表（或
 * SECURITY DEFINER 函数调用）的 SQL」的文件。
 * 谓词必须含 `functionCall`：`admin/ops/accounts-pg.ts` 的语句是
 * `SELECT id, revision, state, display_name FROM public.list_admin_accounts()`，解析时
 * `functionCall` 非空而 `table` 为 null（函数不是表），只判 `table` 会让这个文件从宿主集里
 * 凭空消失（R28-S66 阶段二实测 hosts 20/21 的来源）。
 * `publicQualified` 标记该文件的语句里有没有 `public.` 限定的表引用（派单 §1.2 的原谓词）。
 * @param {string} [baseDir] 扫描基准（默认仓库根）。NC7 传 `os.tmpdir()` 沙箱，见 NC7 注释。
 * @returns {{file: string, tables: string[], functions: string[], publicQualified: boolean}[]}
 */
function discoverSqlHosts(baseDir = root) {
  const hosts = [];
  for (const file of listTypeScriptFiles(STORE_ROOT, baseDir)) {
    const text = readFileSync(resolve(baseDir, file), 'utf8');
    const { statements } = extractRuntimeSql([{ file, text }]);
    const tables = [...new Set(statements.filter((item) => item.table !== null).map((item) => item.table))].sort();
    const functions = [...new Set(statements.filter((item) => item.functionCall !== null).map((item) => item.functionCall))].sort();
    if (tables.length === 0 && functions.length === 0) continue;
    hosts.push({ file, tables, functions, publicQualified: statements.some((item) => PUBLIC_QUALIFIED_SQL.test(item.sql)) });
  }
  return hosts;
}

/**
 * 总装：同一套流水线既跑真实输入，也跑负控制的内存夹具（这是「不恒绿」的结构前提）。
 * @param {{grantSources?: object[], storeSources?: object[], exemptions?: object[], opaqueAllowlist?: object[], rowLockExemptions?: object[]}} [input]
 */
function auditAll(input = {}) {
  const grantSources = input.grantSources ?? loadGrantSources();
  const storeSources = input.storeSources ?? loadStoreSources();
  const exemptions = input.exemptions ?? COVERAGE_EXEMPT;
  const opaqueAllowlist = input.opaqueAllowlist ?? OPAQUE_ALLOWLIST;
  const rowLockExemptions = input.rowLockExemptions ?? [];

  const model = buildGrantModel(grantSources);
  const sql = extractRuntimeSql(storeSources);
  const requirements = collectRequirements(sql.statements);
  const rowLockRequirements = collectRowLockRequirements(sql.statements);
  const coverage = evaluateCoverage(requirements, model, exemptions);
  const rowLocks = evaluateRowLocks(rowLockRequirements, model, rowLockExemptions);
  const opaque = evaluateOpaque(sql.opaque, opaqueAllowlist);
  const superset = buildSupersetReport(requirements, model);
  const referencedTables = [...new Set(sql.statements.filter((item) => item.table !== null).map((item) => item.table))].sort();

  return {
    model,
    sql,
    requirements,
    rowLockRequirements,
    coverage,
    rowLocks,
    opaque,
    superset,
    referencedTables,
    problems: [
      ...model.problems,
      ...coverage.problems,
      ...coverage.staleExemptions,
      ...rowLocks.problems,
      ...rowLocks.staleExemptions,
      ...opaque.problems,
    ],
  };
}

const baseline = auditAll();

/* ============================================================================
 * 六、断言
 * ========================================================================== */

test('sql-column-coverage/覆盖读数：解析器确实在看东西（8 文件 / 语句条数 / 表列数钉死）', () => {
  const readings = [
    `[sql-column-coverage] 授权面文件 ${baseline.model.stats ? loadGrantSources().length : 0} 个：${GRANT_MAIN_FILE} + ${ROLES_DIR}/*.sql`,
    `[sql-column-coverage] 运行时角色 ${RUNTIME_ROLE} 的成员闭包 ${baseline.model.closure.size} 个角色：${[...baseline.model.closure].sort().join(', ')}`,
    `[sql-column-coverage] store-pg 文件 ${baseline.sql.stats.storeFiles} 个，SQL 字面量 ${baseline.sql.stats.sqlLiterals} 条`,
    ...Object.entries(baseline.sql.stats.byFile).map(([domain, value]) => (
      `[sql-column-coverage]   ${domain}/store-pg.ts：字面量 ${value.sqlLiterals} 条`
      + `（INSERT ${value.statements.INSERT} / UPDATE ${value.statements.UPDATE} / SELECT ${value.statements.SELECT} / DELETE ${value.statements.DELETE}）`
    )),
    `[sql-column-coverage] 语句：INSERT ${baseline.sql.stats.statements.INSERT} / UPDATE ${baseline.sql.stats.statements.UPDATE} / SELECT ${baseline.sql.stats.statements.SELECT} / DELETE ${baseline.sql.stats.statements.DELETE}`,
    `[sql-column-coverage] RETURNING ${baseline.sql.stats.returningClauses} 处 / ON CONFLICT ${baseline.sql.stats.onConflictClauses} 处 / SELECT * ${baseline.sql.stats.selectStar} 处 / 无顶层 FROM ${baseline.sql.stats.noTargetTable} 处`,
    `[sql-column-coverage] 引用到的表 ${baseline.referencedTables.length} 张，列权限要求 ${baseline.requirements.length} 条，已覆盖 ${baseline.coverage.covered} 条，缺 ${baseline.coverage.missing.length} 条`,
    `[sql-column-coverage] 覆盖来源：列级精确授权命中 ${baseline.coverage.viaColumnLevel} 条 / 表级（整表）授权命中 ${baseline.coverage.viaTableLevel} 条`,
    `[sql-column-coverage] 不可判插值 ${baseline.sql.opaque.length} 条；表级授权 ${baseline.superset.tableLevel.length} 条`,
  ];
  for (const line of readings) console.log(line);

  assert.deepEqual(
    baseline.sql.stats.statements,
    EXPECTED_READINGS.statements,
    `语句条数变了（实际 ${JSON.stringify(baseline.sql.stats.statements)}）：要么 store 真的改了，要么解析器瞎了 —— 先查是哪一种`,
  );
  assert.equal(baseline.sql.stats.storeFiles, EXPECTED_READINGS.storeFiles);
  assert.equal(baseline.sql.stats.sqlLiterals, EXPECTED_READINGS.sqlLiterals);
  assert.equal(baseline.sql.stats.returningClauses, EXPECTED_READINGS.returningClauses);
  assert.equal(baseline.sql.stats.onConflictClauses, EXPECTED_READINGS.onConflictClauses);
  assert.equal(baseline.sql.stats.selectStar, EXPECTED_READINGS.selectStar);
  assert.equal(baseline.sql.opaque.length, EXPECTED_READINGS.opaqueExpressions);
  assert.deepEqual(baseline.referencedTables, [...EXPECTED_TABLES].sort(), '运行时引用到的表清单变了：逐张核对，别让它悄悄少一张');
  assert.equal(
    baseline.requirements.length,
    EXPECTED_READINGS.columnRequirements,
    `列权限要求条数变了（实际 ${baseline.requirements.length}）：要么 store 真的改了，要么解析器没看见某些列清单`,
  );
  assert.equal(
    baseline.coverage.covered,
    baseline.requirements.length,
    `已覆盖条数必须等于要求条数（零缺口）；实际 ${baseline.coverage.covered}/${baseline.requirements.length}`,
  );
  assert.equal(
    baseline.coverage.viaColumnLevel + baseline.coverage.viaTableLevel,
    baseline.coverage.covered,
    '覆盖来源拆分必须自洽（列级 + 表级 = 总数）',
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(baseline.sql.stats.byFile).map(([key, value]) => [key, value.sqlLiterals])),
    EXPECTED_PER_FILE,
    '逐文件字面量条数变了：先确认是 store 真改了还是解析器瞎了',
  );

  // 正向控制（C1b-1）：DELETE 语句必须**每条**都产出一条「整表 DELETE」需求。
  // 没有这两行断言，「守卫补了 DELETE 面」就只是注释里的说法（NC10 再从真实授权文本反着证一次）。
  const deleteRequirements = baseline.requirements.filter((item) => item.privilege === 'DELETE');
  assert.equal(
    deleteRequirements.length,
    baseline.sql.stats.statements.DELETE,
    `DELETE 语句条数（${baseline.sql.stats.statements.DELETE}）与整表 DELETE 需求条数（${deleteRequirements.length}）必须相等：`
    + '不等说明有 DELETE 语句没被收进需求（解析器漏面），或者有人给 DELETE 造了列级需求（PG 里不存在这种授权形态）',
  );
  assert.equal(
    deleteRequirements.every((item) => item.column === TABLE_WIDE_COLUMN),
    true,
    'DELETE 需求必须一律是整表哨兵列 `*`（PG 没有 `GRANT DELETE (col)`，列级 DELETE 需求是假需求）',
  );
});

test('sql-column-coverage/runtime_sql_columns_are_granted：运行时列面 ⊆ 授权列面（缺一列即红）', () => {
  assert.deepEqual(baseline.model.problems, [], `授权面解析出问题：\n${baseline.model.problems.join('\n')}`);
  if (baseline.coverage.missing.length > 0) {
    console.log(`[sql-column-coverage] 真实缺口 ${baseline.coverage.missing.length} 条：`);
    for (const item of baseline.coverage.missing) {
      console.log(`[sql-column-coverage]   ${item.ref} → ${item.table}.${item.column} 缺 ${item.privilege}（${item.clause}）`);
    }
  }
  assert.deepEqual(
    baseline.coverage.problems,
    [],
    `运行时 SQL 引用的列缺少授权（本片只加检查、不加授权：发现即登记 COVERAGE_EXEMPT 并逐条写进证据页 §4）：\n${baseline.coverage.problems.join('\n')}`,
  );
  assert.deepEqual(
    baseline.coverage.staleExemptions,
    [],
    `COVERAGE_EXEMPT 有陈旧条目（登记了但已不再缺，防躺平）：\n${baseline.coverage.staleExemptions.join('\n')}`,
  );
});

test('sql-column-coverage/runtime_sql_opaque_expressions_accounted：不可静态求值的插值逐条登记', () => {
  for (const item of baseline.sql.opaque) {
    console.log(`[sql-column-coverage] 不可判插值 ${item.ref} ${item.expr}（语句起点 :${item.statementLine}）`);
  }
  assert.deepEqual(
    baseline.opaque.problems,
    [],
    `不可判插值与 OPAQUE_ALLOWLIST 不一致（新增未登记 / 已登记但源码不再存在，两个方向都判红）：\n${baseline.opaque.problems.join('\n')}`,
  );
  assert.equal(baseline.sql.opaque.length, OPAQUE_ALLOWLIST.length, '不可判插值条数与登记条数必须一一对应');
});

test('sql-column-coverage/grant_surface_superset_report：反向只报告计数，不判红', () => {
  const { unusedOnReferencedTables, wholeTableUnused, tableLevel } = baseline.superset;
  const byPrivilege = { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0 };
  for (const item of unusedOnReferencedTables) byPrivilege[item.privilege] += 1;
  console.log(
    `[sql-column-coverage] 反向报告：运行时基准表 ${baseline.referencedTables.length} 张；`
    + `授权了但运行时 SQL 从未引用的列 ${unusedOnReferencedTables.length} 条`
    + `（SELECT ${byPrivilege.SELECT} / INSERT ${byPrivilege.INSERT} / UPDATE ${byPrivilege.UPDATE} / DELETE ${byPrivilege.DELETE}）`,
  );
  for (const item of unusedOnReferencedTables) {
    console.log(`[sql-column-coverage]   未引用列 ${item.table}.${item.column}（${item.privilege}）`);
  }
  console.log(
    `[sql-column-coverage] 反向报告：授权面里整表未被 8 个 store-pg 引用的表 ${wholeTableUnused.length} 张：`
    + `${wholeTableUnused.map((item) => `${item.table}(${item.privileges.join('/')})`).join(', ') || '（无）'}`,
  );
  console.log(
    `[sql-column-coverage] 表级（整表）授权 ${tableLevel.length} 条（按「全列」判定，不属于列级最小权限）：`
    + `${tableLevel.map((item) => `${item.table}:${item.privilege}@${item.file}:${item.line}`).join(', ') || '（无）'}`,
  );
  // 不判红：这里只保证报告本身是「算出来的」，不是常量。
  assert.ok(Array.isArray(unusedOnReferencedTables));
  assert.ok(wholeTableUnused.length >= 0);
  assert.ok(tableLevel.every((item) => typeof item.table === 'string'));
});

/* ============================================================================
 * 七、负控制（缺一不可）
 * ========================================================================== */

test('sql-column-coverage/parser_negative_controls NC1：假 store 用了未授权列 ⇒ 必须红', () => {
  const fakeStore = {
    file: 'tests/unit/fixtures/sql-column-coverage/nc1-fake-store-pg.ts',
    text: [
      "const SENTINEL_COLUMNS = 'id, revision, not_granted_column';",
      'export function fake(pool) {',
      '  return pool.query(`SELECT ${SENTINEL_COLUMNS} FROM public.messages WHERE id = $1`);',
      '}',
    ].join('\n'),
  };
  const audited = auditAll({ storeSources: [fakeStore] });
  assert.equal(audited.coverage.problems.length, 1, `应当恰好 1 条缺失，实际：\n${audited.coverage.problems.join('\n')}`);
  const message = audited.coverage.problems[0];
  assert.ok(message.includes('public.messages.not_granted_column'), `判红必须点名 public.messages.not_granted_column，实际：${message}`);
  assert.ok(message.includes('缺 SELECT'), `判红必须点名缺 SELECT，实际：${message}`);
  assert.ok(message.includes('nc1-fake-store-pg.ts:3'), `判红必须点名文件:行，实际：${message}`);
  assert.equal(audited.coverage.covered, 2, '同一语句里已授权的 id / revision 仍应算覆盖（解析器不是在乱杀）');
  console.log(`[sql-column-coverage] NC1 红字（假 store 用了未授权列）：${message}`);
});

test('sql-column-coverage/parser_negative_controls NC2：表级 GRANT 吞列级 ⇒ 必须标记为「整表」', () => {
  const fakeRoles = {
    file: 'services/api/db/roles/nc2-fake.sql',
    text: [
      'BEGIN;',
      'GRANT UPDATE (revision) ON public.favorites TO gengyun_api_runtime;',
      'GRANT UPDATE ON public.favorites TO gengyun_api_runtime;',
      'COMMIT;',
    ].join('\n'),
  };
  const model = buildGrantModel([fakeRoles]);
  const granted = model.tables.get('public.favorites')?.UPDATE;
  assert.ok(granted !== undefined, 'public.favorites 的 UPDATE 必须存在');
  assert.equal(granted.kind, 'table', `表级 GRANT 必须被标记为「整表」，实际 kind=${granted.kind}`);
  assert.equal(
    Object.prototype.hasOwnProperty.call(granted, 'columns'),
    false,
    '「整表」绝不能带 columns 字段 —— 否则下游会把它当成「列清单为空」而不是「全列」',
  );
  assert.notEqual(
    granted.kind,
    'columns',
    '表级 GRANT 不能被降级成列级（S26 写手实测的「表级吞列级」就在这里）',
  );
  assert.equal(model.swallowed.length, 1, `同类型列级条目被表级吞掉时必须单列记录，实际 ${model.swallowed.length} 条`);
  assert.equal(model.swallowed[0].table, 'public.favorites');
  assert.deepEqual(model.swallowed[0].columns, ['revision'], '被吞的列级条目必须逐列记录（报告里单列）');

  // 整表语义：列级清单里没写的列，也必须算「已授权」——否则就是误判成未授权。
  const lookup = lookupPrivilege(model, 'public.favorites', 'UPDATE');
  assert.equal(lookup.kind, 'table');
  console.log(`[sql-column-coverage] NC2 读数：public.favorites 的 UPDATE 被标记 kind=${granted.kind}（整表）；被吞的同类型列级条目 ${JSON.stringify(model.swallowed[0])}`);
});

test('sql-column-coverage/parser_negative_controls NC3：从真实授权文本删掉一条真实授权 ⇒ 必须红并点名', () => {
  // 本片实测 0 条真实缺口，COVERAGE_EXEMPT 为空 —— 因此按「零缺口」要求做等价且更强的证明：
  // 直接从**真实** 20-login-roles.sql 的文本里删掉一条真实存在的列授权，看正向断言是否变红。
  const target = 'GRANT UPDATE (payload, pending)';
  const source = loadGrantSources().find((item) => item.file === GRANT_MAIN_FILE);
  assert.ok(source !== undefined, `缺少 ${GRANT_MAIN_FILE}`);
  assert.ok(source.text.includes(target), `负控制前置：${GRANT_MAIN_FILE} 里没有 \`${target}\`（形态已变，先同步本文件）`);
  const mutated = source.text.replace(target, 'GRANT UPDATE (pending)');
  assert.notEqual(mutated, source.text, '负控制前置：变异没有真正生效');

  const brokenSources = loadGrantSources().map((item) => (item.file === GRANT_MAIN_FILE ? { file: item.file, text: mutated } : item));
  const broken = auditAll({ grantSources: brokenSources });
  const hit = broken.coverage.problems.filter((message) => message.includes('public.speech_idempotency.payload') && message.includes('缺 UPDATE'));
  assert.equal(hit.length, 1, `删掉 payload 的 UPDATE 授权后必须恰好红 1 条并点名 public.speech_idempotency.payload，实际：\n${broken.coverage.problems.join('\n') || '（没有变红 —— 守卫已恒绿！）'}`);
  assert.ok(hit[0].includes('缺 UPDATE'), `红字必须点名权限：${hit[0]}`);

  // 复原 ⇒ 回绿。
  const restored = auditAll();
  assert.deepEqual(restored.coverage.problems, [], '复原真实授权文本后必须回绿');

  // 登记例外 ⇒ 也回绿（证明例外机制真的在起作用）；但把例外用在**没有缺口**的基准上 ⇒ 必须判陈旧。
  const withExemption = auditAll({
    grantSources: brokenSources,
    exemptions: [
      {
        ref: 'public.speech_idempotency.payload',
        privilege: 'UPDATE',
        reason: '负控制：证明例外表能把已登记的真实缺口压绿',
        owner: 'NC3',
      },
    ],
  });
  assert.deepEqual(withExemption.coverage.problems, [], `登记例外后应变绿，实际：\n${withExemption.coverage.problems.join('\n')}`);

  const stale = auditAll({
    exemptions: [
      {
        ref: 'public.speech_idempotency.payload',
        privilege: 'UPDATE',
        reason: '负控制：该列在真实授权面里其实已授权',
        owner: 'NC3',
      },
    ],
  });
  assert.equal(stale.coverage.staleExemptions.length, 1, '在没有缺口的基准上登记例外必须判「陈旧例外」');
  assert.ok(stale.coverage.staleExemptions[0].includes('public.speech_idempotency.payload'));
  console.log(`[sql-column-coverage] NC3 红字（删掉真实授权后）：${hit[0]}`);
  console.log(`[sql-column-coverage] NC3 复原后红字条数 ${restored.coverage.problems.length}；登记例外后 ${withExemption.coverage.problems.length}；基准上登记例外判陈旧：${stale.coverage.staleExemptions[0]}`);
});

test('sql-column-coverage/parser_negative_controls NC4：登记源码里不存在的 file:line ⇒ 必须红（防躺平）', () => {
  const bogus = [
    ...OPAQUE_ALLOWLIST,
    { ref: 'services/api/src/messages/store-pg.ts:99999', reason: '负控制：源码里根本没有这一行' },
  ];
  const audited = auditAll({ opaqueAllowlist: bogus });
  assert.equal(audited.opaque.problems.length, 1, `陈旧登记必须恰红 1 条，实际：\n${audited.opaque.problems.join('\n')}`);
  assert.ok(
    audited.opaque.problems[0].includes('services/api/src/messages/store-pg.ts:99999'),
    `红字必须点名该 file:line，实际：${audited.opaque.problems[0]}`,
  );

  // 反方向：源码里出现未登记的插值同样判红。
  const fakeStore = {
    file: 'tests/unit/fixtures/sql-column-coverage/nc4-fake-store-pg.ts',
    text: [
      'export function fake(pool, dynamicFilter) {',
      '  return pool.query(`SELECT id FROM public.messages WHERE owner_id = $1${dynamicFilter}`);',
      '}',
    ].join('\n'),
  };
  const unregistered = auditAll({ storeSources: [fakeStore], opaqueAllowlist: [] });
  assert.equal(unregistered.opaque.problems.length, 1, `未登记插值必须恰红 1 条，实际：\n${unregistered.opaque.problems.join('\n')}`);
  assert.ok(unregistered.opaque.problems[0].includes('nc4-fake-store-pg.ts:2'));
  console.log(`[sql-column-coverage] NC4 红字（未登记插值）：${unregistered.opaque.problems[0]}`);
  console.log(`[sql-column-coverage] NC4 红字（陈旧登记）：${audited.opaque.problems[0]}`);
});

/* ============================================================================
 * 八、R28-S66 扩展：8 个新纳管文件走同一套管线 + 文件集不变量 + NC5–NC9
 *
 * 三条新断言的分工（派单 §1.1–§1.3）：
 *   6. 扩展 16 文件的读数与列覆盖（缺口只允许落在 ledger 范畴，且必须逐条登记）；
 *   7. 文件集不变量（`services/api/src` 里的 SQL 宿主恰好是 16 个已审计 + 6 个登记）；
 *   8–12. NC5–NC9（新文件的列、真实授权文本、文件集、豁免陈旧、行锁规则各反着走一遍）。
 * 基线（`baseline`，8 个 store-pg）一条都没动：它继续在零豁免下全绿，是本片「不放宽」的证据。
 * ========================================================================== */

const EXTENDED_OPAQUE_ALLOWLIST = [...OPAQUE_ALLOWLIST, ...LEDGER_OPAQUE_ALLOWLIST];
const auditedSources = loadAuditedSources();
const extended = auditAll({
  storeSources: auditedSources,
  exemptions: LEDGER_COVERAGE_EXEMPT,
  opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST,
  rowLockExemptions: ROW_LOCK_EXEMPT,
});
const sqlHosts = discoverSqlHosts();

/**
 * 文件集不变量的判据（派单 §1.2）：扫到的每个 SQL 宿主，要么在已审计的 16 个文件里，
 * 要么在 `UNAUDITED_SQL_HOSTS` 里；两边都没有 ⇒ 红。反过来每条登记都必须仍被扫到（防躺平）。
 * @param {{file: string}[]} hosts `discoverSqlHosts()` 的结果
 * @returns {string[]} 红字
 */
function findHostSetProblems(hosts) {
  const problems = [];
  const audited = new Set(auditedSources.map((source) => source.file));
  const registered = new Map(UNAUDITED_SQL_HOSTS.map((entry) => [entry.file, entry]));
  const observed = new Set();
  for (const host of hosts) {
    observed.add(host.file);
    if (!audited.has(host.file) && !registered.has(host.file)) {
      problems.push(
        `${host.file} 是新的 SQL 宿主，但既不在本片审计的 18 个文件里，也没登记进 UNAUDITED_SQL_HOSTS：` +
          '要么把它纳入同一套管线，要么登记 file + reason + owner（否则守卫会对新文件视而不见）',
      );
    }
  }
  for (const file of audited) {
    if (!observed.has(file)) {
      problems.push(`已审计的 ${file} 这次没被扫成 SQL 宿主（文件被删或语句被删光？这条守卫会躺平）`);
    }
  }
  for (const entry of UNAUDITED_SQL_HOSTS) {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`UNAUDITED_SQL_HOSTS 的 ${entry.file} 缺 reason`);
    }
    if (typeof entry.owner !== 'string' || entry.owner.trim() === '') {
      problems.push(`UNAUDITED_SQL_HOSTS 的 ${entry.file} 缺 owner`);
    }
    if (!observed.has(entry.file)) {
      problems.push(`UNAUDITED_SQL_HOSTS 登记的 ${entry.file} 已不存在或不再含 SQL（陈旧登记，删掉它以免守卫躺平）`);
    }
  }
  return problems;
}

test('sql-column-coverage/扩展 22 文件读数与列覆盖（R28-S66 / R28-W12 / R29-S5 / R68-A01 / R71）', () => {
  const stats = extended.sql.stats;
  const perFile = Object.fromEntries(Object.entries(stats.byFile).map(([key, value]) => [key, value.sqlLiterals]));
  const starStatements = extended.sql.statements.filter((item) => item.selectStar);

  console.log(`[sql-column-coverage] 扩展审计：${stats.storeFiles} 个文件、SQL 字面量 ${stats.sqlLiterals} 条、语句 INSERT ${stats.statements.INSERT} / UPDATE ${stats.statements.UPDATE} / SELECT ${stats.statements.SELECT} / DELETE ${stats.statements.DELETE}`);
  console.log(`[sql-column-coverage] 扩展审计：RETURNING ${stats.returningClauses} 处 / ON CONFLICT ${stats.onConflictClauses} 处 / SELECT * ${stats.selectStar} 处（其中 t.* ${stats.qualifiedStar} 处）/ 函数调用 ${stats.functionCalls} 处 / 无顶层 FROM ${stats.noTargetTable} 处`);
  console.log(`[sql-column-coverage] 扩展审计：行锁 FOR UPDATE ${stats.rowLocks.UPDATE} 处 / FOR SHARE ${stats.rowLocks.SHARE} 处；行锁要求 ${extended.rowLockRequirements.length} 条，豁免 ${extended.rowLocks.exempted.length} 条`);
  console.log(`[sql-column-coverage] 扩展审计：引用到的表 ${extended.referencedTables.length} 张，列权限要求 ${extended.requirements.length} 条，已覆盖 ${extended.coverage.covered} 条，缺 ${extended.coverage.missing.length} 条（唯一键 ${new Set(extended.coverage.missing.map((item) => `${item.table}.${item.column}|${item.privilege}`)).size} 个），豁免 ${LEDGER_COVERAGE_EXEMPT.length} 条`);
  console.log(`[sql-column-coverage] 扩展审计：覆盖来源 列级 ${extended.coverage.viaColumnLevel} 条 / 表级 ${extended.coverage.viaTableLevel} 条；不可判插值 ${extended.sql.opaque.length} 条`);
  console.log(`[sql-column-coverage] SELECT * 语句（列面不可判，只登记不判权限）：${starStatements.map((item) => `${item.file}:${item.line}${item.qualifiedStar ? '（t.*）' : ''}`).join('、')}`);

  assert.equal(extended.model.problems.length, 0, `扩展授权面解析出问题：\n${extended.model.problems.join('\n')}`);
  assert.equal(stats.storeFiles, EXPECTED_EXTENDED_READINGS.auditedFiles, '审计文件数必须是 22（8 store + 14 新纳管：R28-W12 media/store-pg.ts、R29-S5 admin/ops/jobs-pg.ts、R29 moderation/ledger-pg.ts、R34-I18 admin/ops/content-pg.ts、R68-A01 admin/ops/categories-pg.ts、R71 jobs/ledger.ts）');
  assert.equal(stats.sqlLiterals, EXPECTED_EXTENDED_READINGS.sqlLiterals, 'SQL 字面量条数变了：要么源文件真改了，要么解析器瞎了');
  assert.deepEqual(stats.statements, EXPECTED_EXTENDED_READINGS.statements, `语句条数变了（实际 ${JSON.stringify(stats.statements)}）`);
  assert.equal(stats.returningClauses, EXPECTED_EXTENDED_READINGS.returningClauses);
  assert.equal(stats.onConflictClauses, EXPECTED_EXTENDED_READINGS.onConflictClauses);
  assert.equal(stats.selectStar, EXPECTED_EXTENDED_READINGS.selectStar, 'SELECT * 的条数变了：列面不可判的语句数必须钉死，别让它悄悄变多');
  assert.equal(stats.qualifiedStar, EXPECTED_EXTENDED_READINGS.qualifiedStar, 't.* 的条数变了：这类投影的列面同样不可判');
  assert.deepEqual(stats.rowLocks, EXPECTED_EXTENDED_READINGS.rowLocks, `行锁条数变了（实际 ${JSON.stringify(stats.rowLocks)}）`);
  assert.equal(stats.functionCalls, EXPECTED_EXTENDED_READINGS.functionCalls, 'FROM public.fn() 的条数变了：函数不是表，必须单独计数');
  assert.equal(stats.noTargetTable, EXPECTED_EXTENDED_READINGS.noTargetTable, '无顶层 FROM 的条数变了');
  assert.deepEqual(perFile, EXPECTED_EXTENDED_PER_FILE, '逐文件字面量条数变了：先确认是源文件真改了还是解析器瞎了');
  assert.deepEqual(extended.referencedTables, [...EXPECTED_EXTENDED_TABLES].sort(), '扩展审计引用到的表清单变了：逐张核对');
  assert.equal(extended.requirements.length, EXPECTED_EXTENDED_READINGS.columnRequirements, `列权限要求条数变了（实际 ${extended.requirements.length}）`);
  assert.equal(extended.coverage.covered, EXPECTED_EXTENDED_READINGS.coveredRequirements, `已覆盖条数变了（实际 ${extended.coverage.covered}）`);
  // 扩展面同样要有正向控制（C1b-1）：16 个文件里的每条 DELETE 都产出一条整表需求。
  const extendedDeleteRequirements = extended.requirements.filter((item) => item.privilege === 'DELETE');
  assert.equal(
    extendedDeleteRequirements.length,
    stats.statements.DELETE,
    `扩展面 DELETE 语句条数（${stats.statements.DELETE}）与整表 DELETE 需求条数（${extendedDeleteRequirements.length}）必须相等`,
  );
  assert.equal(
    extendedDeleteRequirements.every((item) => item.column === TABLE_WIDE_COLUMN),
    true,
    '扩展面的 DELETE 需求同样必须是整表哨兵列 `*`',
  );
  assert.equal(extended.coverage.viaColumnLevel + extended.coverage.viaTableLevel, extended.coverage.covered, '覆盖来源拆分必须自洽');
  assert.equal(extended.sql.opaque.length, EXPECTED_EXTENDED_READINGS.opaqueExpressions, '不可判插值条数变了：多出来的必须逐条登记进 allowlist');
  assert.equal(extended.rowLockRequirements.length, EXPECTED_EXTENDED_READINGS.rowLockRequirements);
  assert.equal(extended.rowLocks.exempted.length, EXPECTED_EXTENDED_READINGS.rowLockExemptions);

  // 缺口只允许落在 ledger 范畴：任一条落到服务的其他文件 ⇒ 判红，交指挥裁定（派单 §5）。
  // `extended.coverage.missing` 已扣掉豁免，所以这里另跑一次**零豁免**审计取原始缺口。
  const raw = auditAll({ storeSources: auditedSources, exemptions: [], opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST, rowLockExemptions: [] });
  assert.equal(raw.coverage.missing.length, 54, `零豁免时扩展审计的语句级缺口条数变了（实际 ${raw.coverage.missing.length}）`);
  const rawGapKeys = [...new Set(raw.coverage.missing.map((item) => `${item.table}.${item.column}|${item.privilege}`))].sort();
  assert.equal(rawGapKeys.length, 33, `零豁免时的唯一缺口键必须是 33（实际 ${rawGapKeys.length}）`);
  assert.deepEqual(
    rawGapKeys,
    LEDGER_COVERAGE_EXEMPT.map((entry) => `${entry.ref}|${entry.privilege}`).sort(),
    '豁免表必须与零豁免审计出的真实缺口逐条相等：多一条是放水，少一条是缺口没人认得',
  );
  assert.deepEqual(
    raw.coverage.missing.filter((item) => !item.ref.startsWith('services/api/src/privacy/ledger-pg.ts:')).map((item) => `${item.ref} → ${item.table}.${item.column} 缺 ${item.privilege}`),
    [],
    'ledger 之外出现了真实缺口：本片不许自定豁免，必须停下来交指挥裁定',
  );
  assert.equal(raw.rowLocks.problems.length, 1, `零豁免时行锁缺口必须恰 1 条（ledger 的 exports 行锁），实际：\n${raw.rowLocks.problems.join('\n')}`);
  assert.ok(raw.rowLocks.problems[0].startsWith(`${SITE.ledgerExportsLock} → public.exports`), `行锁缺口必须点名 ${SITE.ledgerExportsLock}：${raw.rowLocks.problems[0]}`);
  assert.equal(extended.coverage.missing.length, 0, `扩展审计的缺口必须全被 33 条豁免压住（实际还剩 ${extended.coverage.missing.length} 条）`);
  assert.deepEqual(extended.coverage.problems, [], `扩展审计仍有多余缺口：\n${extended.coverage.problems.join('\n')}`);
  assert.deepEqual(extended.rowLocks.problems, [], `扩展审计仍有多余行锁缺口：\n${extended.rowLocks.problems.join('\n')}`);
  assert.deepEqual(extended.opaque.problems, [], `扩展审计的不可判插值未登记：\n${extended.opaque.problems.join('\n')}`);

  // 豁免表本身的形状与条数钉死（派单 §1.3：条数固定 + 逐条 reason/owner）。
  assert.equal(LEDGER_COVERAGE_EXEMPT.length, EXPECTED_EXTENDED_READINGS.ledgerExemptions, 'ledger 豁免条数必须钉死在 33');
  assert.equal(ROW_LOCK_EXEMPT.length, EXPECTED_EXTENDED_READINGS.rowLockExemptions, '行锁豁免条数必须钉死在 1');
  for (const entry of [...LEDGER_COVERAGE_EXEMPT, ...ROW_LOCK_EXEMPT]) {
    assert.match(entry.reason, /\S/, `豁免条目缺 reason：${JSON.stringify(entry)}`);
    assert.match(entry.owner, /\S/, `豁免条目缺 owner：${JSON.stringify(entry)}`);
  }
  for (const entry of LEDGER_COVERAGE_EXEMPT) {
    assert.match(entry.ref, /^[a-z_]+\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/, `豁免 ref 必须形如 schema.table.column：${entry.ref}`);
    assert.ok(entry.ref.startsWith('public.'), `ledger 豁免只覆盖 public.* 表：${entry.ref}`);
  }
  for (const entry of LEDGER_OPAQUE_ALLOWLIST) {
    assert.match(entry.ref, /^services\/api\/src\/privacy\/ledger-pg\.ts:\d+$/, `ledger 的不可判插值必须登记成 file:line：${entry.ref}`);
    assert.match(entry.reason, /\S/, `不可判插值缺 reason：${entry.ref}`);
  }

  const uniqueMissing = new Set(raw.coverage.missing.map((item) => `${item.ref}|${item.table}.${item.column}|${item.privilege}`));
  console.log(`[sql-column-coverage] 零豁免时缺口站点 ${uniqueMissing.size} 条，全部在 privacy/ledger-pg.ts，且已全部命中 33 条豁免（扩展审计 staleExemptions ${extended.coverage.staleExemptions.length} 条）`);
  assert.deepEqual(extended.coverage.staleExemptions, [], `豁免表里有对不上任何缺口的条目：\n${extended.coverage.staleExemptions.join('\n')}`);
});

test('sql-column-coverage/sql_host_file_set_is_exactly_registered：SQL 宿主 = 21 已审计 + 13 登记（R28-S66 / R28-E2 / R28-W6 / R28-W3 / R28-W12 / R29-S5 / R29 / R32 片B / R34 / R34-S1 / S4-S3 P2-a / R68-A01）', () => {
  const publicQualified = sqlHosts.filter((host) => host.publicQualified).map((host) => host.file);
  console.log(`[sql-column-coverage] SQL 宿主文件 ${sqlHosts.length} 个（含 public. 限定语句的 ${publicQualified.length} 个；派单 §0 的 grep 只看见后者）`);

  assert.equal(sqlHosts.length, 35, `SQL 宿主文件数变了（实际 ${sqlHosts.length}）：新宿主必须显式登记，不能靠忽略`);
  assert.deepEqual(findHostSetProblems(sqlHosts), [], '文件集不变量被破坏（新宿主未登记，或登记了却不复存在）');
  assert.deepEqual(
    publicQualified.sort(),
    [
      'services/api/src/admin/ops/accounts-pg.ts',
      'services/api/src/admin/ops/categories-pg.ts',
      'services/api/src/admin/ops/content-pg.ts',
      'services/api/src/admin/ops/flags-pg.ts',
      'services/api/src/admin/ops/jobs-pg.ts',
      'services/api/src/ai/checked-content-live-adapter.ts',
      'services/api/src/jobs/ledger.ts',
      'services/api/src/knowledge/service.ts',
      'services/api/src/media/store-pg.ts',
      'services/api/src/messages/store-pg.ts',
      'services/api/src/moderation/ledger-pg.ts',
      'services/api/src/ocr/store-pg.ts',
      'services/api/src/privacy/backup-copies-pg.ts',
      'services/api/src/privacy/backup-purge-driver.ts',
      'services/api/src/privacy/backup-state-derivation.ts',
      'services/api/src/privacy/online-purge-driver.ts',
      'services/api/src/privacy/online-purge-evidence.ts',
      'services/api/src/privacy/privacy-policy.ts',
      'services/api/src/privacy/consent-pg.ts',
      'services/api/src/privacy/grant-pg.ts',
      'services/api/src/privacy/ledger-pg.ts',
      'services/api/src/privacy/third-party-deletion-pg.ts',
      'services/api/src/profile/service.ts',
      'services/api/src/recognitions/store-pg.ts',
      'services/api/src/speech/store-pg.ts',
    ].sort(),
    '含 public. 限定的宿主清单变了：派单 §0 的 grep 结果必须能被这张表解释（9 个新文件 + 4 个带 public. 的 store-pg + R28-W3 的 ai/checked-content-live-adapter.ts）',
  );

  // 16 个已审计文件必须全部在扫描结果里，且每个都真的贡献了语句（不是空壳登记）。
  const byFile = extended.sql.stats.byFile;
  for (const source of auditedSources) {
    assert.ok(sqlHosts.some((host) => host.file === source.file), `已审计的 ${source.file} 没被扫成宿主`);
    assert.ok(byFile[hostKey(source.file)].sqlLiterals > 0, `已审计的 ${source.file} 一条 SQL 都没解析出来`);
  }
  console.log(`[sql-column-coverage] 未纳管登记 ${UNAUDITED_SQL_HOSTS.length} 条：${UNAUDITED_SQL_HOSTS.map((entry) => entry.file).join('、')}`);
});

test('sql-column-coverage/parser_negative_controls NC5：新纳管文件里改名出一列未授权列 ⇒ 必须红（R28-S66）', () => {
  const marker = 'SELECT state,auth_epoch,email FROM public.users WHERE id=$1::uuid FOR UPDATE';
  const mutated = auditedSources.map((source) =>
    source.file.endsWith('/profile/service.ts')
      ? { ...source, text: source.text.replace(NEEDLE.profileUserLock, marker) }
      : source,
  );
  const target = mutated.find((source) => source.file.endsWith('/profile/service.ts'));
  assert.ok(target.text.includes('state,auth_epoch,email'), 'NC5 变异没生效：profile/service.ts 的目标语句没被替换（源文件改了？）');

  const broken = auditAll({
    storeSources: mutated,
    exemptions: LEDGER_COVERAGE_EXEMPT,
    opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST,
    rowLockExemptions: ROW_LOCK_EXEMPT,
  });
  const hit = broken.coverage.problems.filter((problem) => problem.includes('public.users.email'));
  assert.equal(hit.length, 1, `新文件的一列改名成未授权列后必须恰红 1 条，实际：\n${broken.coverage.problems.join('\n') || '（没有变红 —— 守卫对新文件恒绿！）'}`);
  assert.ok(hit[0].includes('缺 SELECT'), `红字必须点名权限：${hit[0]}`);
  assert.ok(hit[0].includes(SITE.profileUserLock), `红字必须点名语句站点 ${SITE.profileUserLock}：${hit[0]}`);
  assert.equal(broken.coverage.problems.length, 1, `除 email 外不许有别的红字：\n${broken.coverage.problems.join('\n')}`);
  console.log(`[sql-column-coverage] NC5 红字（新文件里多一列）：${hit[0]}`);
});

test('sql-column-coverage/parser_negative_controls NC6：真实授权文本少授一列 ⇒ 必须红（R28-S66）', () => {
  const original = 'GRANT SELECT (code,name,parent_code,catalog_version,supported) ON public.regions';
  const mutatedGrants = loadGrantSources().map((source) =>
    source.file.endsWith('/profile_runtime.sql')
      ? { ...source, text: source.text.replace(original, 'GRANT SELECT (code,parent_code,catalog_version,supported) ON public.regions') }
      : source,
  );
  const target = mutatedGrants.find((source) => source.file.endsWith('/profile_runtime.sql'));
  assert.ok(!target.text.includes(original), 'NC6 变异没生效：profile_runtime.sql 的 regions 授权没被改（源文件改了？）');

  const broken = auditAll({
    grantSources: mutatedGrants,
    storeSources: auditedSources,
    exemptions: LEDGER_COVERAGE_EXEMPT,
    opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST,
    rowLockExemptions: ROW_LOCK_EXEMPT,
  });
  assert.deepEqual(broken.model.problems, [], `变异后的授权文本必须仍然可解析：\n${broken.model.problems.join('\n')}`);
  const hit = broken.coverage.problems.filter((problem) => problem.includes('public.regions.name'));
  assert.equal(hit.length, 1, `少授 regions.name 的 SELECT 后必须恰红 1 条，实际：\n${broken.coverage.problems.join('\n') || '（没有变红 —— 列级核对没在看新文件！）'}`);
  assert.ok(hit[0].includes('缺 SELECT'), `红字必须点名权限：${hit[0]}`);
  // 两侧意图都留：main 侧（#451）把站点行号改成「按源码实时定位」，本片（#462）把站点做成注册表引用
  // `SITE.profileRegions`（与下面的负控制变异共用同一处 needle）。两种做法都拒绝写死行号，取注册表
  // 这一种：它与变异替换同源，业务 SQL 一改就一起失效、一起报红，不会出现「定位还在、变异悄悄没生效」。
  assert.ok(hit[0].includes(SITE.profileRegions), `红字必须点名语句站点 ${SITE.profileRegions}：${hit[0]}`);
  // 两侧意图都留（`#462` × `#451` 的真实冲突）：`#451` 要求行号由源码实时定位算出，本片要求红字点名注
  // 册表里的站点名。两条断言各测一件事：前者防「定位漂移没人发现」，后者防「变异悄悄没生效」。行号
  // 不写死在测试里 —— 写死就恰好犯了本片要禁的那件事。
  const regionsSource = readFileSync(resolve(root, 'services/api/src/profile/service.ts'), 'utf8').split('\n');
  const locatedLine = regionsSource.findIndex((line) => line.includes('FROM public.regions')) + 1;
  assert.ok(locatedLine > 0, '动态定位没在 profile/service.ts 里找到 regions 语句：源文件结构变了？');
  assert.ok(
    hit[0].includes(`services/api/src/profile/service.ts:${locatedLine}`),
    `红字必须给出实时定位出来的源坐标 services/api/src/profile/service.ts:${locatedLine}：${hit[0]}`,
  );

  const restored = auditAll({
    storeSources: auditedSources,
    exemptions: LEDGER_COVERAGE_EXEMPT,
    opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST,
    rowLockExemptions: ROW_LOCK_EXEMPT,
  });
  assert.deepEqual(restored.coverage.problems, [], '复原真实授权文本后必须回绿');
  console.log(`[sql-column-coverage] NC6 红字（真实授权少一列）：${hit[0]}`);
  console.log(`[sql-column-coverage] NC6 复原后红字条数 ${restored.coverage.problems.length}`);
});

/**
 * `child` 是否落在 `parent` 目录之内（同一台机器上的绝对路径；跨盘或父级 ⇒ false）。
 * 只用于 NC7 的前提断言：临时宿主必须落在仓库**外**的沙箱里。
 * @param {string} parent @param {string} child @returns {boolean}
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

test('sql-column-coverage/parser_negative_controls NC7：services/api/src 下多一个 SQL 宿主 ⇒ 文件集必须红（R28-S66）', () => {
  // ⚠ 跨文件竞态（GY-R68 修复，别改回去）：`services/api/src` 是**全量单测的并行扫描面** ——
  // `tests/unit/s4-data-gap-pins.test.mjs` 的 `walkFiles('services/api/src')` 会「先枚举、再逐
  // 文件读」。旧版把临时宿主**写进真实源码树**再删（写 → 两次全树扫描 → 删 ≈ 1.2s 窗口），s4
  // 正好在这个窗口里枚举到它、读到它时它已被 `rmSync` ⇒ 报
  // `判据位置不存在：services/api/src/nc7-temp-sql-host.ts`（s4 的 readRepoText），全量单测偶发假红
  // （node 的 test runner 默认按文件并行）。
  // 现在：临时宿主写进 `os.tmpdir()` 的 `mkdtempSync` 沙箱，扫描基准**显式传根目录**。
  // 断言强度不变 —— 扫到的仍是磁盘上的真文件，走同一条 `listTypeScriptFiles` +
  // `extractRuntimeSql` 管线，「多一个未登记的 SQL 宿主 ⇒ 恰红 1 条并点名该文件」还是同一条命题；
  // 唯一变化是这棵树的根：仓库根 → 沙箱。
  // 永久回归：`tests/unit/unit-suite-scan-write-isolation.test.mjs`（并行跑本文件与 s4，
  // 期间扫描面里出现任何新文件即红）。
  // 复现命令（旧树偶发红）：node --test tests/unit/sql-column-coverage.test.mjs tests/unit/s4-data-gap-pins.test.mjs
  const tempFile = `${STORE_ROOT}/nc7-temp-sql-host.ts`;
  const sandbox = mkdtempSync(join(tmpdir(), 'gy-nc7-sql-host-'));
  const absolute = join(sandbox, ...tempFile.split('/'));
  const inRepo = resolve(root, ...tempFile.split('/'));
  try {
    assert.equal(
      isInside(root, absolute),
      false,
      `NC7 的临时宿主必须落在仓库外（实际路径 ${absolute}）：services/api/src 是并行扫描面，`
        + '写进去就会和 s4-data-gap-pins 的 walkFiles 抢同一个文件 ⇒ 全量单测偶发「判据位置不存在」。',
    );
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "export const NC7_SQL = 'SELECT count(*) FROM public.favorites';\n", 'utf8');

    // 前提①（动态）：仓库树里一个字节都没动 —— 写完沙箱后，扫描面里仍然没有这个临时文件。
    assert.equal(
      existsSync(inRepo),
      false,
      `NC7 不得在 services/api/src 里留下临时文件（${inRepo} 不该存在）`,
    );

    // 前提②：沙箱里那个文件确实被同一套扫描器扫成了 SQL 宿主（否则下面的红字可能只是「没扫到」）。
    const sandboxHosts = discoverSqlHosts(sandbox);
    assert.deepEqual(
      sandboxHosts.map((host) => host.file),
      [tempFile],
      `沙箱里的临时宿主没被扫成 SQL 宿主 ⇒ 本负控制退化成空转：${JSON.stringify(sandboxHosts)}`,
    );

    // 「真实扫描面（此刻新扫一遍）+ 沙箱里恰好多出来的那一个宿主」= 旧版写进源码树时的**同一个输入**，
    // 判据一字未改：旧版是「写进树里再扫」，这里是「扫树 + 把沙箱宿主拼上去」，两者喂给
    // findHostSetProblems 的 hosts 完全一样（多出来的那条 file 仍是 services/api/src/nc7-temp-sql-host.ts）。
    const dirty = findHostSetProblems([...discoverSqlHosts(), ...sandboxHosts]);
    assert.equal(dirty.length, 1, `临时新增一个 SQL 宿主后必须恰红 1 条，实际：\n${dirty.join('\n') || '（没有变红 —— 文件集不变量没在看新文件！）'}`);
    assert.ok(dirty[0].includes(tempFile), `红字必须点名该临时文件：${dirty[0]}`);
    console.log(`[sql-column-coverage] NC7 红字（新宿主未登记）：${dirty[0]}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  assert.equal(existsSync(inRepo), false, `NC7 收尾后 services/api/src 里不该有这个临时文件（${inRepo}）`);
  assert.deepEqual(findHostSetProblems(discoverSqlHosts()), [], '删掉临时宿主后必须回绿');
});

test('sql-column-coverage/parser_negative_controls NC8：豁免表登记源码里不存在的缺口 ⇒ 必须判陈旧（R28-S66）', () => {
  const staleColumn = auditAll({
    storeSources: auditedSources,
    exemptions: [
      ...LEDGER_COVERAGE_EXEMPT,
      { ref: 'public.exports.no_such_column', privilege: 'SELECT', reason: '负控制：源码里根本没有这一列', owner: 'NC8' },
    ],
    opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST,
    rowLockExemptions: ROW_LOCK_EXEMPT,
  });
  assert.equal(staleColumn.coverage.staleExemptions.length, 1, `陈旧列级豁免必须恰红 1 条，实际：\n${staleColumn.coverage.staleExemptions.join('\n')}`);
  assert.ok(staleColumn.coverage.staleExemptions[0].includes('public.exports.no_such_column'));
  assert.deepEqual(staleColumn.coverage.problems, [], '加一条陈旧豁免不应制造新缺口（真实 33 条仍被压住）');
  assert.equal(staleColumn.problems.length, 1, '陈旧豁免必须进 total problems（否则 CI 看不见）');

  const staleLock = auditAll({
    storeSources: auditedSources,
    exemptions: LEDGER_COVERAGE_EXEMPT,
    opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST,
    rowLockExemptions: [
      ...ROW_LOCK_EXEMPT,
      { table: 'public.exports', privilege: 'UPDATE', ref: 'services/api/src/privacy/ledger-pg.ts:99999', reason: '负控制：源码里没有这一行', owner: 'NC8' },
    ],
  });
  assert.equal(staleLock.rowLocks.staleExemptions.length, 1, `陈旧行锁豁免必须恰红 1 条，实际：\n${staleLock.rowLocks.staleExemptions.join('\n')}`);
  assert.ok(staleLock.rowLocks.staleExemptions[0].includes('ledger-pg.ts:99999'));
  console.log(`[sql-column-coverage] NC8 红字（陈旧列级豁免）：${staleColumn.coverage.staleExemptions[0]}`);
  console.log(`[sql-column-coverage] NC8 红字（陈旧行锁豁免）：${staleLock.rowLocks.staleExemptions[0]}`);
});

test('sql-column-coverage/parser_negative_controls NC9：撤掉 users 的 UPDATE 授权 ⇒ 四处行锁（2×FOR UPDATE + 2×FOR SHARE）必须点名（R28-S66 / #379）', () => {
  const original = 'GRANT UPDATE (updated_at) ON users TO gengyun_auth_privacy;';
  const mutatedGrants = loadGrantSources().map((source) =>
    source.file.endsWith('/auth_privacy.sql') ? { ...source, text: source.text.replace(original, '') } : source,
  );
  const target = mutatedGrants.find((source) => source.file.endsWith('/auth_privacy.sql'));
  assert.ok(!target.text.includes(original), 'NC9 变异没生效：auth_privacy.sql 的 users UPDATE 授权没被删（源文件改了？）');

  const broken = auditAll({
    grantSources: mutatedGrants,
    storeSources: auditedSources,
    exemptions: LEDGER_COVERAGE_EXEMPT,
    opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST,
    rowLockExemptions: ROW_LOCK_EXEMPT,
  });
  assert.deepEqual(broken.coverage.problems, [], '行锁不占用列面：删掉 users 的 UPDATE(updated_at) 不应产生列级缺口');
  // #379 遗留修复后，users 上的行锁站点从 2 处（FOR UPDATE）变成 4 处：
  // 另有 knowledge/service.ts 与 privacy/ledger-pg.ts 各一处 `FOR SHARE`（PG 17 同样要 UPDATE）。
  const expectedSites = [
    SITE.profileUserLock,
    SITE.consentUserLock,
    SITE.knowledgeUserShareLock,
    SITE.ledgerUserShareLock,
  ].sort();
  assert.equal(broken.rowLocks.problems.length, 4, `users 上有四处行锁（两处 FOR UPDATE + 两处 FOR SHARE），必须恰红 4 条，实际：\n${broken.rowLocks.problems.join('\n') || '（没有变红 —— 行锁规则没生效！）'}`);
  assert.deepEqual(
    broken.rowLocks.problems.map((problem) => problem.split(' → ')[0]).sort(),
    expectedSites,
    '红字必须点名这四处行锁站点',
  );
  for (const problem of broken.rowLocks.problems) {
    assert.ok(problem.includes('public.users 缺 UPDATE'), `红字必须点名表与权限：${problem}`);
    assert.ok(problem.includes('行锁 FOR '), `红字必须说明是行锁要求：${problem}`);
  }
  // 共享锁站点必须自报 FOR SHARE（不能被并进 FOR UPDATE 文案）。
  assert.deepEqual(
    broken.rowLocks.problems
      .filter((problem) => problem.startsWith(`${SITE.knowledgeUserShareLock} `) || problem.startsWith(`${SITE.ledgerUserShareLock} `))
      .map((problem) => (problem.includes('行锁 FOR SHARE') ? 'SHARE' : problem)),
    ['SHARE', 'SHARE'],
    `两处共享锁站点必须各自标成「行锁 FOR SHARE」，实际：\n${broken.rowLocks.problems.join('\n')}`,
  );

  const healed = auditAll({
    grantSources: mutatedGrants,
    storeSources: auditedSources,
    exemptions: LEDGER_COVERAGE_EXEMPT,
    opaqueAllowlist: EXTENDED_OPAQUE_ALLOWLIST,
    rowLockExemptions: [
      ...ROW_LOCK_EXEMPT,
      ...[SITE.profileUserLock, SITE.consentUserLock, SITE.knowledgeUserShareLock, SITE.ledgerUserShareLock].map((ref) => ({
        table: 'public.users', privilege: 'UPDATE', ref, reason: '负控制：证明行锁豁免按语句站点生效（含共享锁站点）', owner: 'NC9',
      })),
    ],
  });
  assert.deepEqual(healed.rowLocks.problems, [], `登记四条行锁豁免后必须回绿：\n${healed.rowLocks.problems.join('\n')}`);
  assert.deepEqual(healed.rowLocks.staleExemptions, [], '四条豁免都应命中真实站点');
  console.log(`[sql-column-coverage] NC9 红字（撤掉 FOR UPDATE/FOR SHARE 需要的 UPDATE 授权）：${broken.rowLocks.problems.join(' | ')}`);
  console.log(`[sql-column-coverage] NC9 登记四条行锁豁免后 problems ${healed.rowLocks.problems.length} / staleExemptions ${healed.rowLocks.staleExemptions.length}`);
});

test('sql-column-coverage/parser_negative_controls NC10：注释掉真实的 GRANT DELETE ⇒ 必须红并点名整表缺 DELETE（C1b-1）', () => {
  // 为什么非做不可：DELETE 需求这一面是 C1b-1 才补进 collectRequirements 的，而它补进来的直接动机
  // 就是「`GRANT DELETE ON public.messages` 忘了给，守卫却一直绿」。因此必须从**真实**授权文本里
  // 把这一行注释掉，看正向断言是否真的变红 —— 否则「补了 DELETE 面」只是一句注释。
  const target = 'GRANT DELETE ON public.messages TO gengyun_api_runtime;';
  const source = loadGrantSources().find((item) => item.file === GRANT_MAIN_FILE);
  assert.ok(source !== undefined, `缺少 ${GRANT_MAIN_FILE}`);
  assert.ok(
    source.text.includes(target),
    `负控制前置：${GRANT_MAIN_FILE} 里没有 \`${target}\`（形态已变，先同步本文件；若这行是被删掉的，`
    + '那不是"形态变了"，而是又退回了 #17 那个 P0 缺口）',
  );

  // ① 注释掉 ⇒ 必须恰红 1 条，点名 public.messages（整表）缺 DELETE + 运行时 SQL 出处。
  const commented = source.text.replace(target, `-- ${target}`);
  assert.notEqual(commented, source.text, '负控制前置：变异没有真正生效');
  const brokenSources = loadGrantSources().map((item) => (item.file === GRANT_MAIN_FILE ? { file: item.file, text: commented } : item));
  const broken = auditAll({ grantSources: brokenSources });
  const hit = broken.coverage.problems.filter((message) => message.includes('public.messages（整表）') && message.includes('缺 DELETE'));
  assert.equal(
    hit.length,
    1,
    '注释掉 `GRANT DELETE ON public.messages` 后必须恰好红 1 条并点名 public.messages（整表）缺 DELETE，实际：\n'
    + `${broken.coverage.problems.join('\n') || '（没有变红 —— DELETE 这一面又没人看了！）'}`,
  );
  assert.ok(hit[0].includes('services/api/src/messages/store-pg.ts:'), `红字必须点名运行时 SQL 的出处：${hit[0]}`);

  // 复原 ⇒ 必须回绿（证明红字来自这一条授权，不是别的东西在冒烟）。
  const restored = auditAll();
  assert.deepEqual(restored.coverage.problems, [], '复原真实授权文本后必须回绿');

  // ② 列级 DELETE 授权**不能**满足整表需求（PG 里不存在 `GRANT DELETE (col)`）。
  const fakeStore = {
    file: 'tests/unit/fixtures/sql-column-coverage/nc10-fake-store-pg.ts',
    text: [
      'export function fake(pool, ownerId) {',
      "  return pool.query('DELETE FROM public.favorites WHERE owner_id = $1', [ownerId]);",
      '}',
    ].join('\n'),
  };
  const fakeGrants = {
    file: 'services/api/db/roles/nc10-fake.sql',
    text: [
      'BEGIN;',
      'GRANT DELETE (id, revision, owner_id) ON public.favorites TO gengyun_api_runtime;',
      'COMMIT;',
    ].join('\n'),
  };
  const columnOnly = auditAll({ storeSources: [fakeStore], grantSources: [fakeGrants] });
  const columnHit = columnOnly.coverage.problems.filter((message) => message.includes('public.favorites（整表）') && message.includes('缺 DELETE'));
  assert.equal(
    columnHit.length,
    1,
    '列级 DELETE 授权不得满足整表 DELETE 需求，实际：\n'
    + `${columnOnly.coverage.problems.join('\n') || '（判定被偷偷放宽成"有列就算有表权限"了！）'}`,
  );
  assert.equal(columnOnly.coverage.missing.length, 1, `列级 DELETE 不满足整表需求时缺口条数必须恰为 1（实际 ${columnOnly.coverage.missing.length}）`);

  console.log(`[sql-column-coverage] NC10 红字（注释掉真实 GRANT DELETE）：${hit[0]}`);
  console.log(`[sql-column-coverage] NC10 红字（只给了列级 DELETE）：${columnHit[0]}`);
});

/* ============================================================================
 * 九、NC11：`FOR SHARE` / `FOR KEY SHARE` 同样要 UPDATE 权限（#379 遗留缺口）
 *
 * 依据（PostgreSQL 17.11 文档 SELECT → Description，原文；本仓部署目标为 PG 17）：
 *   "You must have `SELECT` privilege on each column used in a `SELECT` command.
 *    The use of `FOR NO KEY UPDATE`, `FOR UPDATE`, `FOR SHARE` or `FOR KEY SHARE`
 *    requires `UPDATE` privilege as well (for at least one column of each table so selected)."
 * 四种锁定强度一律要「至少一列 UPDATE」。此前本文件只把 FOR UPDATE / FOR NO KEY UPDATE
 * 记成要求，把 FOR SHARE / FOR KEY SHARE 当成「不要求额外权限」⇒ 只授 SELECT 的角色
 * 写 `SELECT … FOR SHARE` 会被判成「权限齐全」。
 *
 * 三段负控制（同一份假 store，三份假授权面）：
 *   ① 只授 SELECT            ⇒ 两处共享锁都必须判红；
 *   ② crops 补任一列 UPDATE   ⇒ 只剩 regions 一条（证「至少一列」口径 + 不误报）；
 *   ③ regions 也补上          ⇒ 0 条（有权限时不得误报）。
 * ========================================================================== */
test('sql-column-coverage/parser_negative_controls NC11：FOR SHARE / FOR KEY SHARE 只授 SELECT ⇒ 必须按缺 UPDATE 判红（#379）', () => {
  const fakeStore = {
    file: 'tests/unit/fixtures/sql-column-coverage/nc11-share-lock-pg.ts',
    text: [
      'export function fake(pool, cropId, regionCode) {',
      '  return Promise.all([',
      "    pool.query('SELECT id, name FROM public.crops WHERE id = $1 FOR SHARE', [cropId]),",
      "    pool.query('SELECT code, name FROM public.regions WHERE code = $1 FOR KEY SHARE', [regionCode]),",
      '  ]);',
      '}',
    ].join('\n'),
  };
  const grantText = (extra) => [
    'GRANT SELECT (id, name) ON public.crops TO gengyun_api_runtime;',
    'GRANT SELECT (code, name) ON public.regions TO gengyun_api_runtime;',
    ...extra,
  ].join('\n');
  const grants = (file, extra) => [{ file: `services/api/db/roles/${file}.sql`, text: grantText(extra) }];

  // ① 只有 SELECT：两处共享锁都必须计入「缺 UPDATE」。
  const selectOnly = auditAll({
    storeSources: [fakeStore],
    grantSources: grants('nc11-select-only', []),
    opaqueAllowlist: [],
  });
  console.log(`[sql-column-coverage] NC11 基线读数（只授 SELECT）：行锁要求 ${selectOnly.rowLockRequirements.length} 条 / 行锁缺口 ${selectOnly.rowLocks.problems.length} 条 / 总缺口 ${selectOnly.problems.length} 条`);
  assert.deepEqual(selectOnly.model.problems, [], `假授权面本身必须解析干净：\n${selectOnly.model.problems.join('\n')}`);
  assert.equal(
    selectOnly.rowLockRequirements.length,
    2,
    `两处共享锁语句都必须产出行锁要求，实际 ${selectOnly.rowLockRequirements.length} 条`
    + `（clause：${JSON.stringify(selectOnly.rowLockRequirements.map((item) => item.clause))}）`
    + ' —— 0 条说明 FOR SHARE / FOR KEY SHARE 被整段丢掉了',
  );
  assert.deepEqual(
    selectOnly.rowLockRequirements.map((item) => item.clause).sort(),
    ['行锁 FOR KEY SHARE', '行锁 FOR SHARE'],
    '行锁要求必须区分四种锁定强度：共享锁不能并进 FOR UPDATE，也不能不记',
  );
  assert.equal(
    selectOnly.rowLocks.problems.length,
    2,
    `只授 SELECT 时两处共享锁必须恰红 2 条，实际：\n${
      selectOnly.rowLocks.problems.join('\n') || '（没有变红 —— 只授 SELECT 却被判定权限齐全！）'}`,
  );
  const cropHit = selectOnly.rowLocks.problems.filter((message) => message.includes('public.crops 缺 UPDATE') && message.includes('行锁 FOR SHARE'));
  const regionHit = selectOnly.rowLocks.problems.filter((message) => message.includes('public.regions 缺 UPDATE') && message.includes('行锁 FOR KEY SHARE'));
  assert.equal(cropHit.length, 1, `必须点名 public.crops 的 FOR SHARE 缺 UPDATE，实际：\n${selectOnly.rowLocks.problems.join('\n')}`);
  assert.equal(regionHit.length, 1, `必须点名 public.regions 的 FOR KEY SHARE 缺 UPDATE，实际：\n${selectOnly.rowLocks.problems.join('\n')}`);
  assert.deepEqual(selectOnly.coverage.problems, [], '共享锁不占列面：本段只应有行锁缺口，不应出现列级缺口');

  // ② 只给 crops 一列 UPDATE（`revision` 不在该语句的 SELECT 列面里，专证「任一列即可」）。
  const cropsLocked = auditAll({
    storeSources: [fakeStore],
    grantSources: grants('nc11-crops-locked', ['GRANT UPDATE (revision) ON public.crops TO gengyun_api_runtime;']),
    opaqueAllowlist: [],
  });
  assert.equal(
    cropsLocked.rowLocks.problems.length,
    1,
    `crops 有任一列 UPDATE 后只应剩 regions 一条，实际：\n${cropsLocked.rowLocks.problems.join('\n') || '（0 条 —— 这不该发生）'}`,
  );
  assert.ok(cropsLocked.rowLocks.problems[0].includes('public.regions 缺 UPDATE'), `剩下的必须是 regions：${cropsLocked.rowLocks.problems[0]}`);
  assert.deepEqual(cropsLocked.rowLocks.staleExemptions, [], '本段没有行锁豁免，不应出现陈旧登记');

  // ③ 两表都补上 ⇒ 0 条（有权限时不得误报）。
  const bothLocked = auditAll({
    storeSources: [fakeStore],
    grantSources: grants('nc11-both-locked', [
      'GRANT UPDATE (revision) ON public.crops TO gengyun_api_runtime;',
      'GRANT UPDATE (name) ON public.regions TO gengyun_api_runtime;',
    ]),
    opaqueAllowlist: [],
  });
  assert.deepEqual(bothLocked.rowLocks.problems, [], `两表都有一列 UPDATE 后必须回绿，实际：\n${bothLocked.rowLocks.problems.join('\n')}`);

  console.log(`[sql-column-coverage] NC11 红字（只授 SELECT 时的共享锁）：${selectOnly.rowLocks.problems.join(' | ')}`);
  console.log(`[sql-column-coverage] NC11 读数：clause ${JSON.stringify(selectOnly.rowLockRequirements.map((item) => item.clause))} / 只补 crops ${cropsLocked.rowLocks.problems.length} 条 / 两表补齐 ${bothLocked.rowLocks.problems.length} 条`);
});

/**
 * GY-R68 · C08 反向扫描闸门：**写进审计表的 `action` 字面量必须落在闭集里**。
 *
 * ## 为什么需要这条闸门
 *
 * 审计事件的动作码本来是三处口径：契约（`packages/contracts/openapi.json`）、服务端闭集
 * （`services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS`，10 值）与**库内写入点**
 * （`services/api/db/migrations/*.sql` 里 `public.admin_audit_events` 的 INSERT / WHERE 字面量）。
 * 前两处早有用例对拍，第三处**一处都没有**：迁移里只要多写一个 `'admin_scope.approve'`，
 * 库里就会真的多出一种 `action`，而读面闭集不认它（`GET /admin/audit-logs?action=…` 一律 400），
 * 全量翻页里却翻得出来 —— 这类漂移历史上反复出现（0041 的 `admin_scope.grant`、0047 的
 * `post.hide`、0048 的 `admin_account.disable/enable` 都是「先写库、后补闭集」补上的）。
 * 本文件把这条缝钉成红灯：**迁移写了闭集外的字面量 ⇒ 红并点名文件:行号**。
 *
 * ## 扫描面（三处，全部对着同一个闭集）
 *
 * 1. **库内写入点**：`services/api/db/migrations/**\/*.sql`（含 `rollback/*.down.sql`）里
 *    凡出现标识符 `admin_audit_events` 的语句：
 *    - `INSERT INTO public.admin_audit_events (<列…>) VALUES (<值…>)` ⇒ 取 `action` 列那一格，
 *      它**必须**是单个单引号字面量且 ∈ `AUDIT_ACTIONS`；
 *    - 同语句里 `action = 'x'` / `action IN (…)` / `action = ANY (ARRAY[…])` 的字面量同样必须 ∈ 闭集
 *      （读面过滤写错了，读出来的就是「永远为空」而不是报错）；
 *    - 反方向：`AUDIT_ACTIONS` 里每个值**必须**至少被一个库内写入点写到 —— 闭集里躺着一个
 *      永远不可能产生的码，等于给读面开了个永远为空的筛选项。
 * 2. **服务端字面量**：`services/api/src/admin/audit/**` 与 `services/api/src/admin/ops/**` 里
 *    出现的 `action: '<字面量>'` 绑定（作用域见下「为什么不扫全 `services/api/src`」）。
 * 3. **契约**：`components.schemas.AuditEvent.properties.action` 必须 `$ref` 到
 *    `components.schemas.AuditAction`，且该 schema 的 `enum` 必须**逐值同序**等于「库内闭集 10 值
 *    + 内存账本独有 16 值」，后 16 值由本文件**从源码派生**（见「闭集为什么是 26 值」）。
 *
 * ## 闭集为什么是 26 值而不是 10 值
 *
 * `AuditEvent` 这一个 schema 同时是**三条读面**的行形状：`GET /admin/audit-logs`（读库内
 * `public.admin_audit_events`，取值域 = `AUDIT_ACTIONS` 的 10 值）、`GET /admin/audit-events` 与
 * `GET /admin/flag-audit-events`（读内存账本 `services/api/src/admin/audit.ts` 的 `createAuditLog`）。
 * 内存账本按**域**记更细的码：库内 `set_flag` ↔ 内存 `flag.set`，内容域 12 个
 * `<noun>.edit|publish|withdraw` 在库里**根本没有**对应动作。而 `store.audit.append`
 * 每追加一条都拿 `AuditEvent` 校验（`services/api/src/admin/audit.ts:100`），所以把闭集写成 10 值
 * 会让内容域 publish/withdraw/edit 与运营域动作当场 `INVALID_REQUEST`（本片实测：
 * `tests/unit/admin-contract-conformance.test.mjs` 的「所有响应体与契约出参 schema 同形」红在
 * `assertInputWith ← assertContractInput ← Object.append (services/api/src/admin/audit.ts:100)`）。
 * ⇒ 闭集取「库内 10 值（逐值同序，客户端可据 `?action=` 参数穷尽库内筛选）+ 内存账本独有 16 值」，
 * 三段全部由源码派生后与本文件双向对拍，任一段增删改都会红。
 *
 * ## Fail-closed：解析不出的可疑形态一律报红并点名
 *
 * 宁可要求改写，也不静默跳过。下面这些形态**直接判红**（`problems`）：
 * - 语句里有 `INSERT` 也有 `admin_audit_events`，但解析不出「表名 → 列清单 → `VALUES` → 值元组」；
 * - INSERT 的列清单里**没有** `action` 列（审计表的 `action` 是 NOT NULL，这种写法静默过闸最危险）；
 * - `action` 列的取值不是**单个**字面量（参数、拼接、`'x'::text`、多行 VALUES……都不认）；
 * - 语句写了 `INSERT INTO … admin_audit_events` 却连列清单都没有（`VALUES` 按位置对齐 ⇒ 无法静态定位）；
 * - **动态 SQL 组装点**：语句里任何**字符串** token 同时含 `INSERT INTO` 与 `admin_audit_events`
 *   （`EXECUTE format('INSERT INTO … admin_audit_events …', v_action)` 一类）。这类写法表名不在标识符
 *   里，按「语句里有没有 `admin_audit_events` 标识符」判归属会**静默放过**一条能写任意 action 的路径
 *   （GY-R68 对抗审查 NB-1 的 canary：同文件普通坏 INSERT 红在 `:6`，动态语句零输出）。判红文案要求
 *   改写成显式 `INSERT INTO` 语句，确有正当理由时先在本闸门登记该写入点。
 *
 * 明确**不判红**（并按口径记录 `skipped`，不是静默丢弃）：
 * - `action = ANY (p_actions)` 这类**参数**比较（`services/api/db/migrations/0033_admin_audit_log_read.sql:98`）：
 *   值来自应用层闭集，本次闸门的对象是**字面量**；
 * - 非 `admin_audit_events` 语句里的 `action`（例：`services/api/db/migrations/0006_source_lifecycle.sql:7`
 *   的 `CHECK (action IN ('withdraw','restore'))` 是**源操作**表的列，语域完全不同 —— 裸扫
 *   `action` 会把这两个值误判成闭集外）；
 * - 只**提到表名**的说明文案：`COMMENT ON … IS '… admin_audit_events …'`、
 *   `RAISE NOTICE '… admin_audit_events …'`（整段是一个字符串 token，语句里没有表名标识符、也不带
 *   `INSERT INTO` 标记）⇒ 不红。准确判据是「**同一段**字符串 token 里同时出现 `INSERT INTO` 与表名
 *   才红」，不是「按标识符判归属时天然不入账」—— 后者是 NB-1 之前的旧推理，对
 *   `RAISE NOTICE '… INSERT INTO public.admin_audit_events …'` 这类文案是**错的**（它会红；
 *   GY-R68 增量审查 C-3，用例「判别力④」的反例 C 把两条都钉住）。
 *
 * ## 为什么不扫全 `services/api/src`
 *
 * 库内审计的**唯一写路径是迁移里的窄口径函数**：`services/api/src` 里没有任何一条
 * `INSERT INTO … admin_audit_events`，应用侧只调 `SELECT public.record_admin_*_audit(…)`
 * （`services/api/src/admin/ops/jobs-pg.ts:98`、`services/api/src/admin/ops/scope-denial-trace.ts:42-44`、
 * `services/api/src/community/store-pg.ts:159`），动作字面量因此**只**存在于迁移里。
 * 但 `services/api/src/admin/ops/service.ts` 另有一份**进程内台账**（`persistent: false`，重启即丢），
 * 它的动作词表与库内闭集**不同源**（`flag.set` vs 库内 `set_flag`，取舍注记见
 * `services/api/src/admin/ops/service.ts:1229-1230`；`category.update` 在库里根本没有对应审计表）。
 * 把「全仓 `action: 'x'` 必须 ∈ `AUDIT_ACTIONS`」写成断言今天就是红的，而且是对**另一套语域**的
 * 越权裁定，所以作用域收窄到上面两个目录，非闭集值走 `OPS_LEDGER_ONLY` 显式登记（见下）。
 *
 * ## 已知盲区（写在明面上，不用它冒充通过）
 *
 * - 动态绑定不静态可判：`services/api/src/admin/ops/service.ts:1484` 的 `action,`（审核通过/驳回由
 *   上方 `:1412` 的三元决定）与 `services/api/src/admin/service.ts:351,401,422,449,511` 的
 *   `store.audit.append({…})`（其 `action:` 绑定在 `:353,403,424,451,513`，是
 *   `` `${descriptor.noun}.edit|publish|withdraw` `` 模板串）都不进 sql 扫描面，改由「源码派生值 ↔
 *   契约 enum ↔ 服务端镜像」那条三向对拍看住（派生器是本文件的 `deriveInMemoryAuditActions()`）；
 * - **动态 SQL 只抓「一段字符串里同时出现两个标记」这一形态**：`'INSERT INTO ' || 'admin_audit_events'`
 *   这种拆成两段拼接、或表名来自变量的写法，本闸门的启发式看不见。真仓当前**0 命中**（迁移里没有任何
 *   动态组装审计写入的字符串，见用例「判别力④」的实测算式）—— 现在没有，不等于以后没有，遇到就改写成
 *   显式语句；
 * - **扫描面之外还有两个真实写入点**，不进形态判定，但登记在 `OUT_OF_SURFACE_WRITE_POINTS` 并由用例
 *   钉住当前值（值一改就红，要求人工复核闭集）：
 *   `deploy/postgres-cvm/sql/30-bootstrap-admin.sql:225`（CVM 首次引导脚本，`INSERT` 起于 `:225`、
 *   action 在 `:231`，当前写 `'admin_scope.grant'`，在闭集内）、
 *   `tests/integration/fixtures/0027_admin_audit_observability.sql:138`（真库臂夹具，0027 的副本，
 *   当前写 `'set_flag'`，在闭集内）。为什么不一并扫：这两处不是迁移（一个是手工部署脚本、一个是
 *   集成臂夹具副本），生命周期与归属不同，本闸门只对它们的**取值**负责，不对它们的 SQL 形状负责；
 * - **本闸门只管字面量**：库里已有的历史行是否在闭集内，得靠真库臂与读面投影
 *   （`services/api/src/admin/audit/pg.ts` 的 `toAuditLogRow`）去核；`db/samples` / `db/seeds` /
 *   `deploy/postgres-cvm/evidence` 里的演示数据不在**正向**扫描面内（不被逐条判闭集），但它们
 *   **在反向扫描面内**：往里新种一条 `INSERT INTO … admin_audit_events` 却不登记 ⇒ 用例照样红；
 * - **反向扫描面自带下界与成员断言**（GY-R68 增量审查 C-1）：`outsideSurfaceSqlFiles()` 的 roots
 *   写错时（`[]`、不存在的目录、只留 `deploy`）原先会「在空集上恒真」地绿。现在
 *   `assertReverseSurface()` 先要求 ≥ 20 份 SQL（真值 20：deploy 4 / tests 1 / services/api/db 8 /
 *   db 7）且每个登记点都必须在这个面里，再由用例「C-1 回归钉子」把
 *   `[]` / `['nonexistent-dir']` / `['deploy']` / 漏掉 `tests` 四种空转形态钉成红。
 *
 * ## 判别力自证
 *
 * ① 文件内自带合成探针（见用例「判别力①」～「判别力④」）：把闭集外字面量塞进「库内写入点」
 *    「读面过滤」「不可解析形态」「动态 SQL 组装点」四种合成 SQL，断言扫描器**报红并点名
 *    `file:line`**，同时用合法合成 SQL、「只提到表名」与「提到 INSERT INTO 但写别的表」的字符串
 *    证明「不误报」。
 * ② 手工真文件探针：往 `services/api/db/migrations/` 放一个 `0049_probe_action.sql`（写
 *    `'not.a.real.action'`）⇒ 本文件红并点名该文件行号；删掉 ⇒ 复绿。临时文件不入库。
 * ③ 扫描面外的两个真实写入点由 `OUT_OF_SURFACE_WRITE_POINTS` 登记并被用例钉住当前值（改了就红）。
 * ④ 反向扫描面自身也带判别力：用例「C-1 回归钉子」把 roots 换成 `[]` / 不存在的目录 / 只留
 *    `deploy` / 漏掉 `tests` 四种写法（注入参数，不改真文件），断言每一种都**红**、且漏 `tests`
 *    那种点名缺的是哪个登记文件 —— 防的是「面写错 ⇒ 空集 ⇒ 恒绿」。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUDIT_ACTIONS } from '../../services/api/src/admin/audit/catalog.ts';
import { IN_MEMORY_AUDIT_ACTIONS } from '../../services/api/src/admin/fields.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS_DIR = 'services/api/db/migrations';
const AUDIT_TABLE = 'admin_audit_events';
const CLOSED = new Set(AUDIT_ACTIONS);

/** 内存 ops 台账的**非闭集**动作：显式登记 + 理由，出现未登记的新值就红。 */
const OPS_LEDGER_ONLY = Object.freeze({
  'category.update':
    '进程内 ops 台账的分类编辑动作；库里没有分类审计表，`AUDIT_ACTIONS` 不该登记它',
  'flag.set':
    '进程内 ops 台账沿用既有文本 `flag.set`；库内那一侧由迁移 0020/0027 写 `set_flag`，取舍见 services/api/src/admin/ops/service.ts:1229-1230',
});

const TS_SCAN_DIRS = Object.freeze(['services/api/src/admin/audit', 'services/api/src/admin/ops']);

/**
 * 扫描面**之外**的真实审计写入点：登记 + 钉住当前取值（改了就红，要求人工复核闭集）。
 *
 * 为什么不并进扫描面：这两处都不是迁移（一个是 CVM 首次引导脚本、一个是真库臂夹具的 0027 副本），
 * 生命周期与归属不同，本闸门只对它们的**取值**负责，不对 SQL 形状负责（GY-R68 对抗审查 NB-3）。
 * 反向也不许漏：扫描面外的 `*.sql` 里再出现 `INSERT INTO … admin_audit_events` 而没登记 ⇒ 用例红灯。
 */
const OUT_OF_SURFACE_WRITE_POINTS = Object.freeze([
  {
    file: 'deploy/postgres-cvm/sql/30-bootstrap-admin.sql',
    insertLine: 225,
    actionLine: 231,
    action: 'admin_scope.grant',
    why: 'CVM 首次引导脚本：给第一个管理员授 scopes:write 时同事务写一行审计（手工部署面，不是迁移）',
  },
  {
    file: 'tests/integration/fixtures/0027_admin_audit_observability.sql',
    insertLine: 138,
    actionLine: 142,
    action: 'set_flag',
    why: '真库臂夹具：迁移 0027 的副本，供集成测试建函数用（与迁移同源，值同为 set_flag）',
  },
]);

// ---------------------------------------------------------------------------
// 文件枚举
// ---------------------------------------------------------------------------

function listFiles(relative, filter) {
  const absolute = join(ROOT, relative);
  const out = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(child, filter));
    else if (filter(child)) out.push(child);
  }
  return out.sort();
}

function loadSources(files) {
  return files.map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
}

/**
 * 反向扫描面的 roots（可注入，便于用例证明「roots 写错 ⇒ 必须红」而不是空转成绿）。
 * 真值读数：deploy 4 / tests 1 / services/api/db 8 / db 7 = 20 份 `*.sql`（`scripts`、`tools`
 * 在本仓不存在或没有 sql，`catch` 掉不影响下界）。
 */
const OUT_OF_SURFACE_ROOTS = Object.freeze(['deploy', 'tests', 'services/api/db', 'db', 'scripts', 'tools']);

/** 「这条 SQL 在往审计表写字面量」的识别式（去掉行注释后逐文件匹配）。 */
const AUDIT_INSERT_RE = /insert\s+into\s+(public\.)?admin_audit_events/i;

/**
 * 扫描面**之外**的 SQL：部署引导脚本、集成臂夹具、引导/样例数据、角色与脚本目录。
 * 用来反向核对「有没有新的写入点没登记」，顺带保证 `OUT_OF_SURFACE_WRITE_POINTS` 不是一张过期清单。
 */
function outsideSurfaceSqlFiles(roots = OUT_OF_SURFACE_ROOTS) {
  const files = [];
  for (const root of roots) {
    try {
      files.push(...listFiles(root, (file) => /\.sql$/i.test(file)));
    } catch {
      // 目录不存在就跳过（不同 worktree 可能裁掉了某些目录）。
    }
  }
  return files.filter((file) => !file.startsWith(`${MIGRATIONS_DIR}/`));
}

/**
 * 反向扫描面的**自保**（GY-R68 增量审查 C-1）：roots 写错时不许空转成绿。
 *
 * 三条判据，缺一条就会退回「在空集上恒真」：
 * 1. 下界：解析出的 SQL 份数必须 ≥ 20（真值 20；`[]`、不存在的目录、只留 `deploy` 都会掉到下界以下）；
 * 2. 成员：`OUT_OF_SURFACE_WRITE_POINTS` 里每个登记文件都必须在面内（漏掉 `tests` 这种「份数够但少
 *    一个目录」的形态会被点名）；
 * 3. 反向覆盖：面内除登记项之外的任何 `INSERT INTO … admin_audit_events` ⇒ 红并点名文件。
 */
function assertReverseSurface(sources, points = OUT_OF_SURFACE_WRITE_POINTS) {
  assert.ok(
    sources.length >= 20,
    `反向扫描面只解析出 ${sources.length} 份 SQL（真值 20 份：deploy 4 / tests 1 / services/api/db 8 / db 7），` +
      'roots 大概写错了 —— 空集上「没有未登记的审计写入」恒真，这条闸门会假绿',
  );
  const files = new Set(sources.map((source) => source.file));
  const missingPoints = points.filter((point) => !files.has(point.file)).map((point) => point.file);
  assert.deepEqual(
    missingPoints,
    [],
    `这些登记写入点不在反向扫描面里（roots 漏了目录，等于没人核它们的取值）：\n${missingPoints.join('\n')}`,
  );
  const registered = new Set(points.map((point) => point.file));
  const unregistered = sources
    .filter(({ file, text }) => !registered.has(file) && AUDIT_INSERT_RE.test(text.replace(/--[^\n]*/g, '')))
    .map(({ file }) => file);
  assert.deepEqual(
    unregistered,
    [],
    `扫描面外这些 SQL 也在往审计表写，但没登记进 OUT_OF_SURFACE_WRITE_POINTS：\n${unregistered.join('\n')}`,
  );
  return sources;
}

// ---------------------------------------------------------------------------
// SQL 词法：去注释（**保持字符偏移与行号不变**）+ 语句切分 + 轻量 token 化
// ---------------------------------------------------------------------------

/**
 * 把 `-- …` 与 `/ * … * /` 注释替换成等长空格（换行原样保留），
 * 这样后续所有偏移量都能直接换算成原始行号。字符串字面量整段保留。
 */
function stripSqlComments(text) {
  const chars = [...text];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      index += 1;
      while (index < text.length) {
        if (text[index] === "'") {
          if (text[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '-' && text[index + 1] === '-') {
      while (index < text.length && text[index] !== '\n') {
        chars[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] !== '\n') chars[index] = ' ';
        index += 1;
      }
      if (index < text.length) {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 2;
      }
      continue;
    }
    index += 1;
  }
  return chars.join('');
}

/** 语句切分：只有字符串字面量**外**的 `;` 才切（`$$` 函数体里的 `;` 照切——体里的 INSERT 就是真语句）。 */
function splitStatements(masked) {
  const statements = [];
  let start = 0;
  let index = 0;
  while (index < masked.length) {
    const char = masked[index];
    if (char === "'") {
      index += 1;
      while (index < masked.length) {
        if (masked[index] === "'") {
          if (masked[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === ';') {
      statements.push({ text: masked.slice(start, index), start });
      start = index + 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  if (start < masked.length) statements.push({ text: masked.slice(start), start });
  return statements;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

function tokenize(sql) {
  const tokens = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'") {
      let cursor = index + 1;
      let value = '';
      while (cursor < sql.length) {
        if (sql[cursor] === "'") {
          if (sql[cursor + 1] === "'") {
            value += "'";
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        value += sql[cursor];
        cursor += 1;
      }
      tokens.push({ type: 'string', value, index });
      index = cursor;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < sql.length && sql[cursor] !== '"') cursor += 1;
      tokens.push({ type: 'ident', value: sql.slice(index + 1, cursor), quoted: true, index });
      index = cursor + 1;
      continue;
    }
    if (IDENT_START.test(char)) {
      let cursor = index;
      while (cursor < sql.length && IDENT_PART.test(sql[cursor])) cursor += 1;
      tokens.push({ type: 'ident', value: sql.slice(index, cursor), index });
      index = cursor;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let cursor = index;
      while (cursor < sql.length && /[0-9.]/.test(sql[cursor])) cursor += 1;
      tokens.push({ type: 'number', value: sql.slice(index, cursor), index });
      index = cursor;
      continue;
    }
    if (char === '$') {
      const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (dollar !== null) {
        tokens.push({ type: 'dollar', value: dollar[0], index });
        index += dollar[0].length;
        continue;
      }
      let cursor = index + 1;
      while (cursor < sql.length && /[0-9]/.test(sql[cursor])) cursor += 1;
      tokens.push({ type: 'param', value: sql.slice(index, cursor), index });
      index = cursor;
      continue;
    }
    tokens.push({ type: 'punct', value: char, index });
    index += 1;
  }
  return tokens;
}

const isIdent = (token, name) =>
  token !== undefined &&
  token.type === 'ident' &&
  (token.quoted === true ? token.value === name : token.value.toLowerCase() === name);

const isPunct = (token, value) => token !== undefined && token.type === 'punct' && token.value === value;

function lineStartsOf(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

function lineAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** 从 `(` 起收整对括号内的 token（括号不配对 ⇒ null，交给上层 fail-closed）。 */
function parenthesized(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (isPunct(tokens[index], '(')) depth += 1;
    else if (isPunct(tokens[index], ')')) {
      depth -= 1;
      if (depth === 0) return { inner: tokens.slice(openIndex + 1, index), closeIndex: index };
    }
  }
  return null;
}

/** 顶层逗号切分（尊重嵌套括号与方括号）。 */
function splitTopLevel(tokens) {
  const groups = [];
  let current = [];
  let depth = 0;
  for (const token of tokens) {
    if (isPunct(token, '(') || isPunct(token, '[')) depth += 1;
    else if (isPunct(token, ')') || isPunct(token, ']')) depth -= 1;
    if (depth === 0 && isPunct(token, ',')) {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  groups.push(current);
  return groups;
}

// ---------------------------------------------------------------------------
// 扫描器：输入 [{file,text}] → 写入点 / 字面量 / fail-closed 问题 / 跳过项
// ---------------------------------------------------------------------------

function scanSqlSources(sources) {
  const problems = [];
  const writePoints = [];
  const readLiterals = [];
  const skipped = [];

  for (const { file, text } of sources) {
    const masked = stripSqlComments(text);
    const lineStarts = lineStartsOf(masked);
    const lineOf = (offset) => `${file}:${lineAt(lineStarts, offset)}`;

    for (const statement of splitStatements(masked)) {
      const tokens = tokenize(statement.text);
      const absolute = (token) => statement.start + token.index;

      // ⓪ 动态 SQL 组装点（NB-1）：`EXECUTE format('INSERT INTO admin_audit_events …', v_action)`
      //    这类写法里表名只出现在**字符串**里，下面按标识符判归属的那道门根本看不见它 —— 静默放过
      //    就是一个可写任意 action 的后门。廉价启发式：语句里**任何**字符串 token 同时含
      //    `INSERT INTO` 与 `admin_audit_events` ⇒ 判红（宁可要求改写，也不放行不可静态核对的写入）。
      //    误伤面：只有「注释/说明文字里逐字写 INSERT INTO … admin_audit_events」会撞上，
      //    而注释已被 `stripSqlComments` 置空，剩下来的就是真 `COMMENT ON`/`RAISE NOTICE` 文案；
      //    真仓实测 0 命中（见文件头「已知盲区」与用例「判别力④」）。
      for (const token of tokens) {
        if (token.type !== 'string') continue;
        const value = token.value;
        if (!/insert\s+into/i.test(value)) continue;
        if (!value.toLowerCase().includes(AUDIT_TABLE)) continue;
        problems.push(
          `${lineOf(absolute(token))}: 字符串里出现 \`INSERT INTO … ${AUDIT_TABLE}\` —— 这是**动态 SQL 组装点**（\`EXECUTE format(…)\` 一类），表名不在标识符里，本闸门看不见它写进去的 action。请改写成显式 \`INSERT INTO … ${AUDIT_TABLE}\` 语句；确有正当理由时必须先在本闸门登记该写入点（登记前判红）`,
        );
      }

      if (!tokens.some((token) => isIdent(token, AUDIT_TABLE))) continue;

      // ① 写入点：INSERT INTO <表> (<列…>) VALUES (<值…>)
      const insertAt = tokens.findIndex((token) => isIdent(token, 'insert'));
      if (insertAt >= 0) {
        const auditAt = tokens.findIndex((token) => isIdent(token, AUDIT_TABLE));
        const schemaQualified =
          isIdent(tokens[auditAt - 1], 'public') ||
          (isPunct(tokens[auditAt - 1], '.') && isIdent(tokens[auditAt - 2], 'public'));
        const intoIndex = schemaQualified ? (isPunct(tokens[auditAt - 1], '.') ? auditAt - 3 : auditAt - 2) : auditAt - 1;
        const shapeOk = isIdent(tokens[intoIndex], 'into');
        const columnsOpen = shapeOk ? (auditAt + 1 < tokens.length && isPunct(tokens[auditAt + 1], '(') ? auditAt + 1 : -1) : -1;
        const columns = columnsOpen < 0 ? null : parenthesized(tokens, columnsOpen);
        if (columns === null) {
          problems.push(
            `${lineOf(absolute(tokens[auditAt]))}: INSERT 到 \`${AUDIT_TABLE}\` 却没有可解析的列清单（\`(<列…>)\`）⇒ 无法静态定位 action 列，判红`,
          );
        } else {
          const columns1 = splitTopLevel(columns.inner)
            .map((group) => group.filter((token) => token.type === 'ident'))
            .filter((group) => group.length === 1)
            .map((group) => group[0].value.toLowerCase());
          const valuesAt = columns.closeIndex + 1;
          const valuesOpen =
            isIdent(tokens[valuesAt], 'values') && isPunct(tokens[valuesAt + 1], '(') ? valuesAt + 1 : -1;
          const values = valuesOpen < 0 ? null : parenthesized(tokens, valuesOpen);
          const actionIndex = columns1.indexOf('action');
          if (actionIndex < 0) {
            problems.push(
              `${lineOf(absolute(tokens[auditAt]))}: INSERT 到 \`${AUDIT_TABLE}\` 的列清单里没有 \`action\` 列（该列 NOT NULL）⇒ 判红`,
            );
          } else if (values === null) {
            problems.push(
              `${lineOf(absolute(tokens[auditAt]))}: INSERT 到 \`${AUDIT_TABLE}\` 解析不出 \`VALUES (…)\` 值元组 ⇒ 判红`,
            );
          } else {
            const groups = splitTopLevel(values.inner);
            const cell = groups[actionIndex];
            const cellTokens = (cell ?? []).filter(
              (token) => !isPunct(token, ')') && !(token.type === 'dollar'),
            );
            if (cell === undefined || groups.length !== columns1.length) {
              problems.push(
                `${lineOf(absolute(tokens[auditAt]))}: INSERT 到 \`${AUDIT_TABLE}\` 的列数（${columns1.length}）与值数（${groups.length}）对不上 ⇒ 判红`,
              );
            } else if (cellTokens.length !== 1 || cellTokens[0].type !== 'string') {
              problems.push(
                `${lineOf(absolute(tokens[auditAt]))}: \`${AUDIT_TABLE}.action\` 的取值不是单个字符串字面量（实际 \`${statement.text
                  .slice(absolute(cell[0] ?? tokens[auditAt]) - statement.start, absolute(cell[cell.length - 1] ?? tokens[auditAt]) - statement.start + 1)
                  .trim()}\`）⇒ 判红（改写成一个闭集字面量，否则本闸门无从静态核对）`,
              );
            } else {
              const value = cellTokens[0].value;
              writePoints.push({
                file,
                line: lineAt(lineStarts, absolute(cellTokens[0])),
                insertLine: lineAt(lineStarts, absolute(tokens[insertAt])),
                action: value,
              });
              if (!CLOSED.has(value)) {
                problems.push(
                  `${lineOf(absolute(cellTokens[0]))}: 写入 \`${AUDIT_TABLE}.action = '${value}'\` 不在 \`AUDIT_ACTIONS\` 闭集里（闭集：${[...AUDIT_ACTIONS].join(' / ')}）`,
                );
              }
            }
          }
        }
      }

      // ② 同语句的 action 比较：`action = 'x'` / `action IN (…)` / `action = ANY (ARRAY[…])`
      for (let index = 0; index < tokens.length; index += 1) {
        if (!isIdent(tokens[index], 'action')) continue;
        const operator = tokens[index + 1];
        const isEquals = isPunct(operator, '=') || isPunct(operator, '!=');
        const isNotEquals =
          isPunct(operator, '<') && isPunct(tokens[index + 2], '>');
        if (!isEquals && !isNotEquals) continue;
        const right = tokens[index + 2];
        const at = absolute(tokens[index]);
        const collectStrings = (groupTokens) =>
          groupTokens.filter((token) => token.type === 'string').map((token) => token);
        if (isPunct(right, '(')) {
          const group = parenthesized(tokens, index + 2);
          const strings = group === null ? [] : collectStrings(group.inner);
          if (strings.length === 0) {
            skipped.push({ at: lineOf(at), reason: '参数化过滤（括号里没有字面量）' });
            continue;
          }
          for (const token of strings) {
            readLiterals.push({ file, line: lineAt(lineStarts, absolute(token)), action: token.value });
            if (!CLOSED.has(token.value)) {
              problems.push(
                `${lineOf(absolute(token))}: 读面过滤 \`action = (…'${token.value}'…)\` 不在 \`AUDIT_ACTIONS\` 闭集里`,
              );
            }
          }
          continue;
        }
        if (right !== undefined && (isIdent(right, 'any') || isIdent(right, 'all') || isIdent(right, 'in') || isIdent(right, 'array'))) {
          let openIndex = index + 3;
          while (openIndex < tokens.length && !isPunct(tokens[openIndex], '(') && !isPunct(tokens[openIndex], '[')) {
            openIndex += 1;
          }
          const group = openIndex < tokens.length ? parenthesized(tokens, openIndex) : null;
          const strings = group === null ? [] : collectStrings(group.inner);
          if (strings.length === 0) {
            skipped.push({
              at: lineOf(at),
              reason: `\`action = ${right.value}\` 参数化（没有字面量，值来自应用层闭集）`,
            });
            continue;
          }
          for (const token of strings) {
            readLiterals.push({ file, line: lineAt(lineStarts, absolute(token)), action: token.value });
            if (!CLOSED.has(token.value)) {
              problems.push(
                `${lineOf(absolute(token))}: 读面过滤 \`action = ${right.value}(…'${token.value}'…)\` 不在 \`AUDIT_ACTIONS\` 闭集里`,
              );
            }
          }
          continue;
        }
        if (right !== undefined && right.type === 'string') {
          readLiterals.push({ file, line: lineAt(lineStarts, absolute(right)), action: right.value });
          if (!CLOSED.has(right.value)) {
            problems.push(
              `${lineOf(absolute(right))}: 读面过滤 \`action = '${right.value}'\` 不在 \`AUDIT_ACTIONS\` 闭集里`,
            );
          }
          continue;
        }
        skipped.push({ at: lineOf(at), reason: 'action 比较的右侧既不是字面量也不是参数（无法静态核对）' });
      }
    }
  }

  return { problems, writePoints, readLiterals, skipped };
}

// ---------------------------------------------------------------------------
// 服务端字面量：`action: 'x'`
// ---------------------------------------------------------------------------

function scanTsActionLiterals(sources) {
  const findings = [];
  const dynamic = [];
  for (const { file, text } of sources) {
    const lines = text.split('\n');
    let inBlockComment = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      const code = line.replace(/\/\/.*$/, '');
      for (const match of code.matchAll(/\baction\s*:\s*(['"])([^'"]*)\1/g)) {
        findings.push({ file, line: index + 1, value: match[2] });
      }
      for (const match of code.matchAll(/\baction\s*:\s*`([^`]*)`/g)) {
        dynamic.push({ file, line: index + 1, form: `\`${match[1]}\`` });
      }
    });
  }
  return { findings, dynamic };
}

// ---------------------------------------------------------------------------
// 内存账本词表：从源码派生（契约闭集的后 16 值不许手抄）
// ---------------------------------------------------------------------------

/**
 * 从源码派生**内存审计账本独有的动作码**。
 *
 * 三段各自有独立真值源，本函数只做「读源码 → 摊平」，不写任何动作字面量：
 * - 名词段：`services/api/src/admin/families.ts` 的 `noun: '…'`（顺序即 `FAMILIES` 顺序）；
 * - 动词段：`services/api/src/admin/service.ts` 里 `` `${descriptor.noun}.<verb>` `` 模板串出现过的动词；
 * - 运营域：`services/api/src/admin/ops/service.ts` 的 `action: '<码>'` 字面量，加上
 *   `const action = … ? 'post.approve' : 'post.reject'` 这类三元绑定里的**带点码**
 *   （`'approved'` 是裁定词不是动作码，用 `^[a-z_]+\.[a-z_]+$` 的形状把它筛掉）。
 *
 * 与 `AUDIT_ACTIONS`（库内 10 值）取差集 ⇒ 内存账本独有的码。三处派生值都返回，
 * 让用例能分别断言「名词顺序」「动词集合」「内容域 12 条」而不是只断总数。
 */
function deriveInMemoryAuditActions() {
  const families = readFileSync(join(ROOT, 'services/api/src/admin/families.ts'), 'utf8');
  const nouns = [...families.matchAll(/^\s*noun:\s*'([^']+)',$/gm)].map((match) => match[1]);

  const contentService = readFileSync(join(ROOT, 'services/api/src/admin/service.ts'), 'utf8');
  const verbs = [...new Set([...contentService.matchAll(/action:\s*`\$\{descriptor\.noun\}\.([a-z]+)`/g)].map((match) => match[1]))];

  const opsService = readFileSync(join(ROOT, 'services/api/src/admin/ops/service.ts'), 'utf8');
  const opsLiterals = [...opsService.matchAll(/\baction:\s*'([^']+)'/g)].map((match) => match[1]);
  const ternaryCodes = [...opsService.matchAll(/const action\s*=\s*[^;\n]*/g)]
    .flatMap((match) => [...match[0].matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]))
    .filter((value) => /^[a-z_]+\.[a-z_]+$/.test(value));

  const content = nouns.flatMap((noun) => verbs.map((verb) => `${noun}.${verb}`));
  const ordered = [...new Set([...content, ...opsLiterals, ...ternaryCodes])].filter((action) => !CLOSED.has(action));
  return { nouns, verbs, content, opsLiterals, ternaryCodes, inMemoryOnly: ordered };
}

// ---------------------------------------------------------------------------
// 扫描面装配
// ---------------------------------------------------------------------------

const sqlFiles = listFiles(MIGRATIONS_DIR, (file) => file.endsWith('.sql'));
const sqlScan = scanSqlSources(loadSources(sqlFiles));
const tsSources = TS_SCAN_DIRS.flatMap((dir) => loadSources(listFiles(dir, (file) => file.endsWith('.ts'))));
const tsScan = scanTsActionLiterals(tsSources);

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('库内审计写入点：`admin_audit_events.action` 的字面量全部落在 `AUDIT_ACTIONS` 闭集里', () => {
  assert.deepEqual(sqlScan.problems, [], `迁移里的审计 action 字面量有闭集外取值 / 不可解析形态：\n${sqlScan.problems.join('\n')}`);
});

test('正控：扫描面确实读到了库内写入点（不是扫了个空）', () => {
  assert.ok(sqlFiles.length >= 48, `迁移文件数异常（${sqlFiles.length} 份），扫描面可能没接上`);
  assert.ok(
    sqlScan.writePoints.length >= 12,
    `只读到 ${sqlScan.writePoints.length} 个库内 audit 写入点（基线 12 个：0017×2、0020、0027、0041×2、0043、0046、0047、0048×2、0049）`,
  );
  const files = new Set(sqlScan.writePoints.map((point) => point.file));
  assert.ok(files.size >= 8, `写入点只落在 ${files.size} 份迁移里，扫描面可疑`);
  assert.ok(
    sqlScan.readLiterals.length >= 3,
    `只读到 ${sqlScan.readLiterals.length} 个读面 action 字面量（0027 一处 + rollback 两处）`,
  );
});

test('反方向：`AUDIT_ACTIONS` 里每个值都真的被库内写入点写到（闭集里不许躺死码）', () => {
  const written = new Set(sqlScan.writePoints.map((point) => point.action));
  const dead = AUDIT_ACTIONS.filter((action) => !written.has(action));
  assert.deepEqual(dead, [], `闭集里这些值没有任何库内写入点，永远不会出现在表里：${dead.join(' / ')}`);
  const extra = [...written].filter((action) => !CLOSED.has(action));
  assert.deepEqual(extra, [], `库内写了闭集外的动作：${extra.join(' / ')}`);
  // 双向相等 ⇒ 闭集与库内写入面**恰好**同一集合（多一个或少一个都红）。
  assert.deepEqual([...written].sort(), [...AUDIT_ACTIONS].sort());
});

test('服务端 `action: …` 字面量：`admin/audit/**` 不许出现，`admin/ops/**` 只许闭集 + 显式登记项', () => {
  const auditDirLiterals = tsScan.findings.filter((finding) => finding.file.startsWith('services/api/src/admin/audit/'));
  assert.deepEqual(
    auditDirLiterals,
    [],
    `\`admin/audit/**\` 是库内审计的**读面**装配，不该出现写死动作的绑定：\n${auditDirLiterals
      .map((finding) => `${finding.file}:${finding.line} action: '${finding.value}'`)
      .join('\n')}`,
  );

  const opsFindings = tsScan.findings.filter((finding) => finding.file.startsWith('services/api/src/admin/ops/'));
  assert.ok(opsFindings.length >= 5, `只读到 ${opsFindings.length} 条 ops 台账动作绑定，扫描面可疑`);
  const violations = opsFindings.filter(
    (finding) => !CLOSED.has(finding.value) && OPS_LEDGER_ONLY[finding.value] === undefined,
  );
  assert.deepEqual(
    violations,
    [],
    `这些动作既不在 \`AUDIT_ACTIONS\` 里，也没有在 \`OPS_LEDGER_ONLY\` 登记理由：\n${violations
      .map((finding) => `${finding.file}:${finding.line} action: '${finding.value}'`)
      .join('\n')}`,
  );

  // 登记表不许变成垃圾堆：每条都要真被用到（改成闭集值或删掉绑定 ⇒ 这条红）。
  const observed = new Set(opsFindings.map((finding) => finding.value));
  const stale = Object.keys(OPS_LEDGER_ONLY).filter((action) => !observed.has(action));
  assert.deepEqual(stale, [], `\`OPS_LEDGER_ONLY\` 里这些登记项已经不出现了（陈旧登记）：${stale.join(' / ')}`);

  // 盲区按口径记录，不作为通过依据。
  assert.deepEqual(tsScan.dynamic, [], `模板串动作绑定进了扫描面却没人核：${JSON.stringify(tsScan.dynamic)}`);
});

test('契约：`AuditEvent.action` 是 `$ref` 到 `AuditAction`，枚举 = 库内 11 值 + 内存账本 15 值（逐值同序）', () => {
  const spec = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/openapi.json'), 'utf8'));
  const schema = spec.components.schemas.AuditAction;
  assert.ok(schema !== undefined, '`components.schemas.AuditAction` 不存在 ⇒ `AuditEvent.action` 的 `$ref` 断链');
  assert.equal(schema.type, 'string');
  const derived = deriveInMemoryAuditActions();
  assert.deepEqual(
    schema.enum,
    [...AUDIT_ACTIONS, ...derived.inMemoryOnly],
    '契约 `AuditAction.enum` 必须逐值同序等于「`AUDIT_ACTIONS`（库内 11 值，顺序照 services/api/src/admin/audit/catalog.ts）+ 内存账本独有码（源码派生）」',
  );
  assert.deepEqual(
    spec.components.schemas.AuditEvent.properties.action,
    { $ref: '#/components/schemas/AuditAction' },
    '`AuditEvent.properties.action` 必须只剩 `$ref`（自由字符串形状 = 客户端无法穷尽判断）',
  );
  assert.ok(spec.components.schemas.AuditEvent.required.includes('action'), '`action` 仍是必填');
  // 库内那 10 值必须**在前、同序**：`GET /admin/audit-logs?action=` 的筛选值与行值要能一一对上。
  assert.deepEqual(schema.enum.slice(0, AUDIT_ACTIONS.length), [...AUDIT_ACTIONS], '`AuditAction` 前 10 项必须逐值同序等于 `AUDIT_ACTIONS`');
});

test('闭集三段派生：契约枚举 == `AUDIT_ACTIONS` + 内存账本独有码 == 镜像 `IN_MEMORY_AUDIT_ACTIONS`', () => {
  const derived = deriveInMemoryAuditActions();
  // ① 名词段与动词段先各自可核：顺序/集合错了，后面「12 条内容域码」就无从谈起。
  assert.deepEqual(
    derived.nouns,
    ['source', 'knowledge', 'registration', 'restriction'],
    `从 services/api/src/admin/families.ts 派生的 noun 与预期不一致：${derived.nouns.join(' / ')}（顺序必须与 FAMILIES 一致）`,
  );
  assert.deepEqual(
    [...derived.verbs].sort(),
    ['edit', 'publish', 'withdraw'],
    `services/api/src/admin/service.ts 里的审计模板动词变了：${derived.verbs.join(' / ')}（出现新动词必须同 PR 更新契约闭集与镜像）`,
  );
  assert.equal(derived.content.length, 12, `内容域动作码应为 4 noun × 3 verb = 12 条，实际 ${derived.content.length}`);
  assert.equal(derived.inMemoryOnly.length, 15, `内存账本独有码应为 15 条（12 内容域 + 3 运营域），实际 ${derived.inMemoryOnly.length}：${derived.inMemoryOnly.join(' / ')}`);

  // ② 契约枚举与派生值**双向**相等：少写（客户端以为不存在）与多写（契约承诺了永远不产生的码）都红。
  const spec = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/openapi.json'), 'utf8'));
  const contractEnum = spec.components.schemas.AuditAction.enum;
  const missing = derived.inMemoryOnly.filter((action) => !contractEnum.includes(action));
  assert.deepEqual(missing, [], `源码会产生的动作码在契约闭集里缺席：${missing.join(' / ')}`);
  const phantom = contractEnum.filter((action) => !CLOSED.has(action) && !derived.inMemoryOnly.includes(action));
  assert.deepEqual(phantom, [], `契约闭集里这些值既不是库内动作、源码里也不产生（幽灵值）：${phantom.join(' / ')}`);

  // ③ 镜像（服务端出参校验用）必须与派生值同值同序，否则 `collectIssues('AuditEvent', …)` 与契约分叉。
  assert.deepEqual(
    [...IN_MEMORY_AUDIT_ACTIONS],
    derived.inMemoryOnly,
    'services/api/src/admin/fields.ts 的 `IN_MEMORY_AUDIT_ACTIONS` 与源码派生值不一致（值或顺序）：镜像会与契约分叉',
  );
});

// ---------------------------------------------------------------------------
// 判别力自证（合成探针，不碰真文件）
// ---------------------------------------------------------------------------

test('判别力①：合成写入点写闭集外字面量 ⇒ 红并点名 file:line', () => {
  const probe = scanSqlSources([
    {
      file: 'services/api/db/migrations/9999_probe_action.sql',
      text: [
        'BEGIN;',
        'CREATE FUNCTION public.probe() RETURNS void AS $$',
        'BEGIN',
        "  INSERT INTO public.admin_audit_events (",
        '    id, actor_id, action, scope',
        '  ) VALUES (',
        "    p_audit_id, p_actor_id, 'not.a.real.action', 'flags:write'",
        '  );',
        'END;',
        '$$ LANGUAGE plpgsql;',
        'COMMIT;',
      ].join('\n'),
    },
  ]);
  assert.equal(probe.problems.length, 1, `应恰好一条红，实际：${JSON.stringify(probe.problems)}`);
  assert.match(probe.problems[0], /9999_probe_action\.sql:7:/, '红必须点名文件:行号');
  assert.match(probe.problems[0], /not\.a\.real\.action/);
});

test('判别力②：合成读面过滤写闭集外字面量 ⇒ 红；不可解析的写入形态 ⇒ 红', () => {
  const readProbe = scanSqlSources([
    {
      file: 'services/api/db/migrations/9998_probe_read.sql',
      text: "SELECT count(*) FROM public.admin_audit_events e WHERE e.action = 'not.a.real.action';",
    },
  ]);
  assert.equal(readProbe.problems.length, 1);
  assert.match(readProbe.problems[0], /9998_probe_read\.sql:1:/);
  assert.match(readProbe.problems[0], /not\.a\.real\.action/);

  const unparseable = scanSqlSources([
    {
      file: 'services/api/db/migrations/9997_probe_dynamic.sql',
      text: [
        'INSERT INTO public.admin_audit_events (id, action) VALUES (p_id, p_action);',
      ].join('\n'),
    },
    {
      file: 'services/api/db/migrations/9996_probe_nocolumns.sql',
      text: ['INSERT INTO public.admin_audit_events', 'SELECT * FROM staging_audit;'].join('\n'),
    },
  ]);
  assert.equal(unparseable.problems.length, 2, `不可解析形态应各报一条红：${JSON.stringify(unparseable.problems)}`);
  assert.match(unparseable.problems[0], /9997_probe_dynamic\.sql:1:/);
  assert.match(unparseable.problems[0], /不是单个字符串字面量/);
  assert.match(unparseable.problems[1], /9996_probe_nocolumns\.sql:1:/);
  assert.match(unparseable.problems[1], /列清单/);
});

test('判别力③：不误报 —— 合法写入点、参数化过滤、异表 action 都不进红', () => {
  const clean = scanSqlSources([
    {
      file: 'services/api/db/migrations/9995_probe_clean.sql',
      text: [
        "INSERT INTO public.admin_audit_events (id, action) VALUES ('00000000-0000-4000-8000-000000000000', 'set_flag');",
        "SELECT count(*) FROM public.admin_audit_events e WHERE (p_actions IS NULL OR e.action = ANY (p_actions));",
        "SELECT count(*) FROM public.admin_audit_events e WHERE e.action = ANY (ARRAY['job.cancel','post.hide']);",
        "UPDATE source_operations SET action = 'restore' WHERE action = 'withdraw';",
        "-- 注释里的 action = 'not.a.real.action' 不算写入",
        "COMMENT ON FUNCTION public.probe() IS '同事务向 public.admin_audit_events 写一行 action=job.cancel';",
        "DO $$ BEGIN RAISE NOTICE 'action = ''not.a.real.action'''; END $$;",
      ].join('\n'),
    },
  ]);
  assert.deepEqual(clean.problems, []);
  assert.equal(clean.writePoints.length, 1);
  assert.equal(
    clean.readLiterals.length,
    2,
    `\`ANY (ARRAY['job.cancel','post.hide'])\` 里的两个字面量应各入账：${JSON.stringify(clean.readLiterals)}`,
  );
  // 参数化过滤按口径记进 `skipped`（不是静默丢弃）：0033 的 `= ANY (p_actions)` 就是这一形态。
  assert.deepEqual(clean.skipped.map((entry) => entry.reason), [
    '`action = ANY` 参数化（没有字面量，值来自应用层闭集）',
  ]);
});

test('判别力④：动态 SQL 组装点（表名只在字符串里）⇒ 红并点名；两种「像但不算」不误报', () => {
  const dynamic = scanSqlSources([
    {
      file: 'services/api/db/migrations/9994_probe_format.sql',
      text: [
        'CREATE FUNCTION public.probe_format(p_action text) RETURNS void AS $$',
        'BEGIN',
        "  EXECUTE format('INSERT INTO public.admin_audit_events (id, action) VALUES (%L, %L)', gen_random_uuid(), p_action);",
        'END;',
        '$$ LANGUAGE plpgsql;',
      ].join('\n'),
    },
  ]);
  assert.equal(dynamic.problems.length, 1, `动态组装点应恰好一条红，实际：${JSON.stringify(dynamic.problems)}`);
  assert.match(dynamic.problems[0], /9994_probe_format\.sql:3:/, '红必须点名文件:行号');
  assert.match(dynamic.problems[0], /动态 SQL 组装点/);
  assert.equal(
    dynamic.writePoints.length,
    0,
    '动态语句不能算成「本闸门核过的写入点」——核不到就必须红，不能既红又记成通过',
  );

  // 反例 A：字符串里只提到表名（COMMENT / RAISE NOTICE 的说明文字）⇒ 不是动态写入。
  // 反例 B：字符串里有 `INSERT INTO` 但写的是**别的表** ⇒ 与审计无关。
  const notDynamic = scanSqlSources([
    {
      file: 'services/api/db/migrations/9993_probe_not_dynamic.sql',
      text: [
        "COMMENT ON FUNCTION public.probe() IS '这里说明 public.admin_audit_events 的列语义（不是 INSERT 语句）';",
        "DO $$ BEGIN EXECUTE format('INSERT INTO public.source_operations (id, action) VALUES (%L, %L)', p_id, p_action); END $$;",
      ].join('\n'),
    },
  ]);
  assert.deepEqual(notDynamic.problems, [], `这两种形态不该红：${JSON.stringify(notDynamic.problems)}`);

  // 反例 C（GY-R68 增量审查 C-3 的口径）：说明文案里**只提到表名** ⇒ 不红；
  // 同一段字符串里同时出现 `INSERT INTO` 与表名 ⇒ 红（哪怕它只是 NOTICE 文案 —— 宁可按
  // 动态组装点拦下让人改写，也不放行一条本闸门看不见的写入）。
  const noticeOnlyName = scanSqlSources([
    {
      file: 'services/api/db/migrations/9992_probe_notice.sql',
      text: "DO $$ BEGIN RAISE NOTICE '审计写入 public.admin_audit_events 一行'; END $$;",
    },
  ]);
  assert.deepEqual(noticeOnlyName.problems, [], `只提表名的文案不该红：${JSON.stringify(noticeOnlyName.problems)}`);
  const noticeWithInsert = scanSqlSources([
    {
      file: 'services/api/db/migrations/9991_probe_notice_insert.sql',
      text: "DO $$ BEGIN RAISE NOTICE 'INSERT INTO public.admin_audit_events (id, action) VALUES (%L, %L)'; END $$;",
    },
  ]);
  assert.equal(noticeWithInsert.problems.length, 1, `带 INSERT INTO 的文案必须红：${JSON.stringify(noticeWithInsert.problems)}`);
  assert.match(noticeWithInsert.problems[0], /9991_probe_notice_insert\.sql:1:/);
  assert.match(noticeWithInsert.problems[0], /动态 SQL 组装点/);

  // 真仓实测：迁移里「同一段字符串同时含 INSERT INTO 与 admin_audit_events」**0 命中** ⇒
  // 本启发式在今天不误伤任何真仓文件（这条也是「误伤面」的读数，不是承诺）。
  const real = scanSqlSources(loadSources(listFiles(MIGRATIONS_DIR, (file) => file.endsWith('.sql'))));
  const dynamicHits = real.problems.filter((problem) => problem.includes('动态 SQL'));
  assert.deepEqual(dynamicHits, [], `真仓出现动态组装的审计写入（请改写成显式 INSERT 或登记）：\n${dynamicHits.join('\n')}`);
});

test('扫描面外的写入点：登记表钉住当前取值，新增未登记写入点 ⇒ 红', () => {
  for (const point of OUT_OF_SURFACE_WRITE_POINTS) {
    const text = readFileSync(join(ROOT, point.file), 'utf8');
    assert.ok(CLOSED.has(point.action), `登记值 \`${point.action}\`（${point.file}）不在 \`AUDIT_ACTIONS\` 闭集里`);
    const scan = scanSqlSources([{ file: point.file, text }]);
    assert.deepEqual(scan.problems, [], `${point.file} 的登记写入点解析出问题：${JSON.stringify(scan.problems)}`);
    assert.deepEqual(
      scan.writePoints.map((entry) => entry.action),
      [point.action],
      `${point.file} 现在写到审计表的 action 与登记表（\`${point.action}\`）不一致，或该文件多/少了一处写入点 ⇒ ` +
        `请核对它是否仍在 \`AUDIT_ACTIONS\` 闭集内，再更新 OUT_OF_SURFACE_WRITE_POINTS（理由：${point.why}）`,
    );
    assert.deepEqual(
      scan.writePoints.map((entry) => entry.insertLine),
      [point.insertLine],
      `${point.file} 里 \`INSERT\` 语句的起始行从登记的 ${point.insertLine} 漂到了 ${JSON.stringify(
        scan.writePoints.map((entry) => entry.insertLine),
      )} ⇒ 请同步登记表（INSERT 行与 action 行都是人工核对的锚点：先看语句在不在，再看值改没改）`,
    );
    assert.deepEqual(
      scan.writePoints.map((entry) => entry.line),
      [point.actionLine],
      `${point.file} 里 action 字面量的行号从登记的 ${point.actionLine} 漂到了 ${JSON.stringify(
        scan.writePoints.map((entry) => entry.line),
      )} ⇒ 请同步登记表（行号是人工核对的锚点）`,
    );
  }

  // 反方向：扫描面外（非 migrations）任何 `*.sql` 再往审计表写字面量，都必须先登记。
  // 面本身的自保（份数下界 + 登记点在面内）在 `assertReverseSurface` 里，见下一条用例。
  assertReverseSurface(loadSources(outsideSurfaceSqlFiles()));
});

test('C-1 回归钉子：反向扫描面 roots 写错（空 / 不存在 / 只留 deploy / 漏 tests）⇒ 必红，不许空转', () => {
  // 四种形态都用**注入 roots** 复现（不改真文件、不改生产默认值）。
  // 根因是旧实现 `try{…}catch{}` 没有任何下界：空集上「未登记文件里没有审计 INSERT」恒真 ⇒ 假绿。

  // ① `roots=[]` ⇒ 0 份。
  const empty = loadSources(outsideSurfaceSqlFiles([]));
  assert.equal(empty.length, 0);
  assert.throws(
    () => assertReverseSurface(empty),
    /反向扫描面只解析出 0 份 SQL[\s\S]*roots 大概写错了/,
    '`roots=[]` 必须红：空集上的反向覆盖恒真',
  );

  // ② `roots=['nonexistent-dir']`（目录不存在，被 catch 掉）⇒ 0 份。
  const nonexistent = loadSources(outsideSurfaceSqlFiles(['nonexistent-dir']));
  assert.equal(nonexistent.length, 0);
  assert.throws(() => assertReverseSurface(nonexistent), /只解析出 0 份 SQL/);

  // ③ `roots=['deploy']` ⇒ 只 4 份（登记点 tests/… 也不在面内，两条判据都该红）。
  const deployOnly = loadSources(outsideSurfaceSqlFiles(['deploy']));
  assert.equal(deployOnly.length, 4);
  assert.throws(() => assertReverseSurface(deployOnly), /只解析出 4 份 SQL/);

  // ③b 审查实测的「deploy + 在 tests 里种一个未登记 INSERT」：下界先红（5 份 < 20）。
  const plantedFile = 'tests/integration/fixtures/9998_probe_unregistered.sql';
  const planted = {
    file: plantedFile,
    text: "INSERT INTO public.admin_audit_events (id, action) VALUES (p_id, 'set_flag');",
  };
  const deployPlusPlanted = [...deployOnly, planted];
  assert.equal(deployPlusPlanted.length, 5);
  assert.throws(
    () => assertReverseSurface(deployPlusPlanted),
    /只解析出 5 份 SQL/,
    '「roots 少了一半 + 种一个未登记写入」也必须红（旧实现这里是绿的）',
  );

  // ④ 份数够、但漏掉 `tests` ⇒ 19 份，下界红，且逐条成员断言能点名缺哪个登记文件。
  const withoutTests = loadSources(outsideSurfaceSqlFiles(['deploy', 'services/api/db', 'db']));
  assert.equal(withoutTests.length, 19);
  assert.throws(() => assertReverseSurface(withoutTests), /只解析出 19 份 SQL/);
  const filesWithoutTests = new Set(withoutTests.map((source) => source.file));
  assert.deepEqual(
    OUT_OF_SURFACE_WRITE_POINTS.filter((point) => !filesWithoutTests.has(point.file)).map((point) => point.file),
    ['tests/integration/fixtures/0027_admin_audit_observability.sql'],
    '漏掉 tests 时必须能点名缺的是哪个登记文件',
  );

  // ⑤ 面**够大**（21 份）但里面多出一份未登记写入 ⇒ 只可能被「反向覆盖」那道门抓到，
  //    证明下界不是唯一的守门人（种的那条 INSERT 是合成 source，不落盘）。
  const fullPlusPlanted = [...loadSources(outsideSurfaceSqlFiles()), planted];
  assert.throws(
    () => assertReverseSurface(fullPlusPlanted),
    /9998_probe_unregistered\.sql/,
    '面内多一份未登记的审计写入必须点名该文件',
  );

  // ⑥ 真仓默认参数必须仍然全绿（避免「把闸门改红了」冒充判别力）。
  assertReverseSurface(loadSources(outsideSurfaceSqlFiles()));
});

/**
 * R28-S56 · `deploy/postgres-cvm/conf/` 四个生产配置模板的静态守卫
 * （模板 ↔ `install-postgres.sh` 渲染器占位符契约）。
 *
 * 为什么要有它：
 *   `conf/` 下四个模板就是 CVM 上真实 pg 的 `conf.d` 片段、`pg_hba.conf`、`pg_ident.conf`
 *   与 systemd 单元来源（`install-postgres.sh` 用 sed 渲染后安装），但此前**零测试覆盖**：
 *   把 `ssl` 打开、把某条 `pg_hba` 规则从 `scram-sha-256` 改成 `trust`、把 `listen_addresses`
 *   改成 `'*'`、把 `log_statement` 改成 `'all'`，CI 全绿。本守卫把「配置面」钉成可复算的断言：
 *     （1）`10-gengyun-postgres.conf` 有效行**冻结快照** —— 任何增删改都红，改动必须显式改本文件；
 *     （2）**安全基线语义不变量** —— 不依赖快照文字，直接判值与取值集合。快照管「变了没有」，
 *         这里管「变过去的方向是不是危险」：只改一个值的 PR 也会被点名说清它越了哪条线；
 *     （3）`pg_hba` 规则面 —— 认证方法闭集、local 唯一、回环 scram、VPC 两专用身份、
 *         末条默认拒绝（顺序敏感）、无公网段；
 *     （4）`pg_ident` 单映射（多映射 = 多出一个免口令身份）；
 *     （5）systemd 单元关键字段（Type/User/Group/RuntimeDirectory/ExecStart/Restart/…）；
 *     （6）**占位符 ↔ 渲染器双向一致性** —— 模板有效行的 `@TOKEN@` 必须是渲染器认识的，
 *         渲染器认识的 token 也必须真的被某个模板用到；否则渲染后生产配置里会留下字面 `@XXX@`，
 *         而今天没有任何检查会红。渲染器有**两套**：三个模板走 `substitute()`（5 个 token），
 *         service 走另一段 `sed`（2 个 token，见 `install-postgres.sh` 第 9 节）。
 *
 * 结构：解析器与断言都是**纯函数**（入参是文件内容字符串，不读盘），测试再读真实文件喂进去。
 * 负控制（派单 §2.2 五条）用内存字符串替换喂**同一批函数**，证明断言真的会红、且红在预期那一条。
 * 行为级证据与口径说明见 `docs/verification/gy-r28-deploy-pg-conf-guard-20261021.md`。
 *
 * 本守卫不覆盖（如实登记，不吹）：
 *   · 不验证 PostgreSQL 是否真的接受这些值（`postgres -c` 级属部署/真库片）；
 *   · 不覆盖 `install-postgres.sh` 的 sed 在实际 shell 里的转义行为（属真机片）；
 *   · `ssl = off` 与 `archive_mode = off` 是**冻结现状**，本守卫不裁定其安全性（证据页 §7.1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONF_DIR = join(ROOT, 'deploy/postgres-cvm/conf');
const INSTALLER_PATH = join(ROOT, 'deploy/postgres-cvm/install-postgres.sh');

const CONF_FILE = 'deploy/postgres-cvm/conf/10-gengyun-postgres.conf';
const HBA_FILE = 'deploy/postgres-cvm/conf/pg_hba.gengyun.conf';
const IDENT_FILE = 'deploy/postgres-cvm/conf/pg_ident.gengyun.conf';
const UNIT_FILE = 'deploy/postgres-cvm/conf/gengyun-postgresql.service';
const INSTALLER_FILE = 'deploy/postgres-cvm/install-postgres.sh';

const confText = readFileSync(join(CONF_DIR, '10-gengyun-postgres.conf'), 'utf8');
const hbaText = readFileSync(join(CONF_DIR, 'pg_hba.gengyun.conf'), 'utf8');
const identText = readFileSync(join(CONF_DIR, 'pg_ident.gengyun.conf'), 'utf8');
const unitText = readFileSync(join(CONF_DIR, 'gengyun-postgresql.service'), 'utf8');
const installerText = readFileSync(INSTALLER_PATH, 'utf8');

/** 三个模板由 `substitute()` 渲染；service 由另一段 sed 渲染。 */
const SUBSTITUTE_TEMPLATES = [
  { file: CONF_FILE, text: confText },
  { file: HBA_FILE, text: hbaText },
  { file: IDENT_FILE, text: identText },
];

// ---------------------------------------------------------------------------
// 纯函数：解析（入参一律是「文件内容字符串」，不读盘）
// ---------------------------------------------------------------------------

/**
 * 物理行：保留行号；只裁行尾空白与 CR（行首形态保留，快照要冻结原始缩进/对齐）。
 * CR 一并裁掉是为了让同一份夹具在 CRLF 签出下也给出同一答案。
 */
function physicalLines(text) {
  return text
    .split('\n')
    .map((raw, index) => ({ lineNo: index + 1, text: raw.replace(/[ \t\r]+$/, '') }));
}

/** 有效行：非空、且 trim 后不以 `#` 开头的行（注释行的内容不进任何断言）。 */
function effectiveEntries(text) {
  return physicalLines(text).filter((line) => {
    const trimmed = line.text.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
}

/** 有效行的文本数组（已裁行尾、保留行首与行内原始空格）。 */
function effectiveLines(text) {
  return effectiveEntries(text).map((line) => line.text);
}

/**
 * `10-gengyun-postgres.conf` 的 `key = value` 解析。
 * 返回 Map<key, { value, lineNo }>；同一 key 重复即抛（PG 只认最后一条，冻结面必须无歧义）。
 */
const CONFIG_PAIR = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function parseSettings(text, file) {
  const settings = new Map();
  for (const { lineNo, text: line } of effectiveEntries(text)) {
    const matched = CONFIG_PAIR.exec(line.trim());
    assert.ok(matched, `${file}:${lineNo} 不是 \`key = value\` 形态：${line}`);
    const key = matched[1];
    assert.ok(!settings.has(key), `${file}:${lineNo} 重复设置 \`${key}\`（PG 只认最后一条，冻结面必须唯一的）`);
    settings.set(key, { value: matched[2].trim(), lineNo });
  }
  return settings;
}

function setting(settings, key, file) {
  const hit = settings.get(key);
  assert.ok(hit, `${file} 缺少必需设置项 \`${key}\``);
  return hit;
}

/**
 * `pg_hba.gengyun.conf` 规则解析：有效行按空白切 5 段 = TYPE DATABASE USER ADDRESS METHOD。
 * `local` 行没有 ADDRESS 列，第 4 段是 METHOD、第 5 段是 `map=` 之类的选项；
 * `host` 行第 4 段是 ADDRESS、第 5 段是 METHOD。两者都按「5 段」校验，段数不对就抛。
 */
function parseHbaRules(text, file) {
  return effectiveEntries(text).map(({ lineNo, text: line }) => {
    const fields = line.trim().split(/\s+/);
    assert.equal(
      fields.length,
      5,
      `${file}:${lineNo} 应切出 5 段（TYPE DATABASE USER ADDRESS METHOD），实际 ${fields.length} 段：${line.trim()}`,
    );
    const type = fields[0];
    const isLocal = type === 'local';
    return {
      lineNo,
      raw: line.trim(),
      normalized: fields.join(' '),
      fields,
      type,
      database: fields[1],
      user: fields[2],
      address: isLocal ? null : fields[3],
      method: isLocal ? fields[3] : fields[4],
      options: isLocal ? fields.slice(4) : [],
    };
  });
}

/** `pg_ident.gengyun.conf` 解析：有效行按空白切 3 段 = map-name system-username database-username。 */
function parseIdentRules(text, file) {
  return effectiveEntries(text).map(({ lineNo, text: line }) => {
    const fields = line.trim().split(/\s+/);
    assert.equal(
      fields.length,
      3,
      `${file}:${lineNo} 应切出 3 段（map-name system-username database-username），实际 ${fields.length} 段：${line.trim()}`,
    );
    return { lineNo, raw: line.trim(), normalized: fields.join(' '), map: fields[0], systemUser: fields[1], databaseUser: fields[2] };
  });
}

/**
 * systemd 单元解析：`Key=Value` 行（`[Unit]` 之类的段头跳过）。
 * 值逐字保留（`ExecStart=` 的断言要逐字相等）；同 key 首条胜出并记下重复。
 */
const UNIT_ASSIGNMENT = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/;
const UNIT_SECTION = /^\[[A-Za-z]+\]$/;

function parseUnitAssignments(text, file) {
  const assignments = new Map();
  for (const { lineNo, text: line } of effectiveEntries(text)) {
    const trimmed = line.trim();
    if (UNIT_SECTION.test(trimmed)) continue;
    const matched = UNIT_ASSIGNMENT.exec(trimmed);
    assert.ok(matched, `${file}:${lineNo} 不是 systemd 赋值行（Key=Value）：${trimmed}`);
    if (!assignments.has(matched[1])) {
      assignments.set(matched[1], { value: matched[2], lineNo });
    }
  }
  return assignments;
}

const TOKEN_PATTERN = /@[A-Z0-9_]+@/g;

/** 一段文本里出现过的 `@TOKEN@`（去重、保序）。 */
function tokensIn(text) {
  return [...new Set(text.match(TOKEN_PATTERN) ?? [])];
}

/** 从 `installerText` 里取出 `substitute()` 函数体（段起始标记到顶格 `}` 为止）。 */
function substituteBlock(scriptText, file) {
  const start = scriptText.indexOf('substitute() {');
  assert.notEqual(start, -1, `${file} 里找不到 \`substitute() {\`（模板渲染器入口）`);
  const end = scriptText.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${file} 里找不到 substitute() 函数体的顶格 \`}\`（渲染器结构变了，请同步本守卫）`);
  return scriptText.slice(start, end);
}

/** `substitute()` 处理的 token 集合：解析其中的 `sed -e "s|@TOKEN@|…|g"` 行。 */
const SED_TOKEN_LINE = /-e\s+"s\|(@[A-Z0-9_]+@)\|/g;

function parseSubstituteTokens(scriptText, file) {
  const block = substituteBlock(scriptText, file);
  const tokens = [...block.matchAll(SED_TOKEN_LINE)].map((matched) => matched[1]);
  assert.ok(tokens.length > 0, `${file} 的 substitute() 里没有解析到任何 \`sed -e "s|@TOKEN@|…|g"\` 行`);
  return [...new Set(tokens)];
}

/** 渲染 `gengyun-postgresql.service` 的那段 sed 处理的 token 集合（install-postgres.sh 第 9 节）。 */
function parseUnitRenderTokens(scriptText, file) {
  const anchor = scriptText.indexOf('"${CONF_DIR}/gengyun-postgresql.service"');
  assert.notEqual(anchor, -1, `${file} 里找不到 systemd 单元的渲染行（渲染命令里的 gengyun-postgresql.service 锚点）；渲染器结构变了，请同步本守卫`);
  const start = scriptText.lastIndexOf('sed', anchor);
  assert.notEqual(start, -1, `${file} 里找不到渲染 gengyun-postgresql.service 的 sed`);
  const tokens = [...scriptText.slice(start, anchor).matchAll(SED_TOKEN_LINE)].map((matched) => matched[1]);
  assert.ok(tokens.length > 0, `${file} 渲染 gengyun-postgresql.service 的 sed 里没有解析到 \`-e "s|@TOKEN@|…|g"\``);
  return [...new Set(tokens)];
}

// ---------------------------------------------------------------------------
// 纯函数：审计（入参是内容字符串；违规即抛 AssertionError，消息点名文件/行/原文）
// ---------------------------------------------------------------------------

/** （2）`listen_addresses` 只允许回环 + VPC 私网占位符。 */
function auditListenAddresses(text, file = CONF_FILE) {
  const settings = parseSettings(text, file);
  const listen = setting(settings, 'listen_addresses', file);
  for (const forbidden of ["'*'", '0.0.0.0', '::']) {
    assert.ok(
      !listen.value.includes(forbidden),
      `${file}:${listen.lineNo} listen_addresses 含 ${forbidden} ⇒ 进程会监听公网地址（值=${listen.value}）`,
    );
  }
  assert.equal(
    listen.value,
    "'127.0.0.1,@VPC_PRIVATE_IP@'",
    `${file}:${listen.lineNo} listen_addresses 必须逐字为 '127.0.0.1,@VPC_PRIVATE_IP@'（只回环 + 目标网段私网 IP），实际 ${listen.value}`,
  );
}

/** （2）口令认证面与 Unix socket 权限。 */
function auditAuthAndSockets(text, file = CONF_FILE) {
  const settings = parseSettings(text, file);
  const auth = setting(settings, 'password_encryption', file);
  assert.equal(auth.value, "'scram-sha-256'", `${file}:${auth.lineNo} password_encryption 必须为 'scram-sha-256'（PG17 已不生成 md5 口令），实际 ${auth.value}`);
  const perms = setting(settings, 'unix_socket_permissions', file);
  assert.equal(perms.value, '0770', `${file}:${perms.lineNo} unix_socket_permissions 必须为 0770（与 systemd 单元 RuntimeDirectoryMode 同口径），实际 ${perms.value}`);
  const dirs = setting(settings, 'unix_socket_directories', file);
  assert.ok(dirs.value !== '' && dirs.value !== "''", `${file}:${dirs.lineNo} unix_socket_directories 不得为空（本机运维/迁移/备份都走该 socket）`);
}

/** （2）日志隐私面：禁全量语句日志，慢查询阈值 1000ms。 */
function auditLoggingPrivacy(text, file = CONF_FILE) {
  const settings = parseSettings(text, file);
  const statement = setting(settings, 'log_statement', file);
  assert.equal(
    statement.value,
    "'none'",
    `${file}:${statement.lineNo} log_statement 必须为 'none'（记录 DDL 会把 CREATE/ALTER ROLE 的口令写进日志；'all'/'ddl' 都不许），实际 ${statement.value}`,
  );
  const slow = setting(settings, 'log_min_duration_statement', file);
  assert.equal(slow.value, '1000', `${file}:${slow.lineNo} log_min_duration_statement 必须为 1000（毫秒），实际 ${slow.value}`);
}

/** （2）时区与本地化（跨机构复现时排序/比较口径必须稳定）。 */
function auditLocale(text, file = CONF_FILE) {
  const settings = parseSettings(text, file);
  for (const key of ['timezone', 'log_timezone']) {
    const hit = setting(settings, key, file);
    assert.equal(hit.value, "'UTC'", `${file}:${hit.lineNo} ${key} 必须为 'UTC'，实际 ${hit.value}`);
  }
  const lc = setting(settings, 'lc_messages', file);
  assert.equal(lc.value, "'C'", `${file}:${lc.lineNo} lc_messages 必须为 'C'（日志/错误信息不随宿主 locale 漂移），实际 ${lc.value}`);
}

/** （2）连接数上限必须是显式整数。 */
function auditConnectionLimits(text, file = CONF_FILE) {
  const settings = parseSettings(text, file);
  for (const key of ['max_connections', 'superuser_reserved_connections']) {
    const hit = setting(settings, key, file);
    assert.match(hit.value, /^[0-9]+$/, `${file}:${hit.lineNo} ${key} 必须是整数，实际 ${hit.value}`);
  }
}

const HBA_METHODS_ALLOWED = new Set(['peer', 'scram-sha-256', 'reject']);
const HBA_METHODS_FORBIDDEN = new Set(['trust', 'md5', 'password', 'ident', 'gss']);
/** 只允许回环与目标 VPC 网段（10.21.0.0/16）：任何别的来源都必须是显式评审过的改动。 */
const HBA_ADDRESSES_ALLOWED = new Set(['127.0.0.1/32', '::1/128', '10.21.0.0/16']);
/** ssl=off 的前提下只该有 local/host；hostssl/hostnossl 属 TLS 姿态改动，必须与 ssl 一起评审。 */
const HBA_TYPES_ALLOWED = new Set(['local', 'host']);

/** （3）规则面：段数、类型、方法闭集、地址闭集。 */
function auditHbaRuleSurface(text, file = HBA_FILE) {
  const rules = parseHbaRules(text, file);
  assert.ok(rules.length > 0, `${file} 没有任何有效规则（空 pg_hba 等于全拒，但那是部署事故而不是本模板）`);
  for (const rule of rules) {
    assert.ok(HBA_TYPES_ALLOWED.has(rule.type), `${file}:${rule.lineNo} 规则类型 "${rule.type}" 不在允许集合 {${[...HBA_TYPES_ALLOWED].join(', ')}}：${rule.raw}`);
    for (const field of rule.fields) {
      const lower = field.toLowerCase();
      assert.ok(
        !HBA_METHODS_FORBIDDEN.has(lower),
        `${file}:${rule.lineNo} 出现被禁的认证方法 ${field}（禁 trust/md5/password/ident/gss）：${rule.raw}`,
      );
    }
    assert.ok(
      HBA_METHODS_ALLOWED.has(rule.method),
      `${file}:${rule.lineNo} 认证方法 "${rule.method}" 不在允许集合 {${[...HBA_METHODS_ALLOWED].join(', ')}}：${rule.raw}`,
    );
    if (rule.address !== null) {
      assert.ok(
        HBA_ADDRESSES_ALLOWED.has(rule.address),
        `${file}:${rule.lineNo} 地址 ${rule.address} 不在允许集合 {${[...HBA_ADDRESSES_ALLOWED].join(', ')}}（只允许回环与 10.21.0.0/16）：${rule.raw}`,
      );
    }
  }
  return rules;
}

/** （3）本机运维：恰好 1 条 local 行，走 peer + pg_ident 映射。 */
function auditHbaLocalRule(text, file = HBA_FILE) {
  const rules = parseHbaRules(text, file);
  const locals = rules.filter((rule) => rule.type === 'local');
  assert.equal(locals.length, 1, `${file} 必须恰好 1 条 local 规则（多一条就多一个免口令的 socket 身份），实际 ${locals.length} 条`);
  const [local] = locals;
  assert.equal(
    local.normalized,
    'local all all peer map=gengyun_ops',
    `${file}:${local.lineNo} local 行必须为 \`local all all peer map=gengyun_ops\`（peer + 唯一映射），实际 \`${local.normalized}\``,
  );
  assert.equal(local.method, 'peer', `${file}:${local.lineNo} local 行认证方法必须为 peer，实际 ${local.method}`);
  assert.deepEqual(local.options, ['map=gengyun_ops'], `${file}:${local.lineNo} local 行必须带 \`map=gengyun_ops\`（无映射即无身份），实际 ${JSON.stringify(local.options)}`);
}

/** （3）本机回环 TCP：127.0.0.1/32 与 ::1/128 各 1 条 scram-sha-256。 */
function auditHbaLoopbackRules(text, file = HBA_FILE) {
  const rules = parseHbaRules(text, file);
  for (const address of ['127.0.0.1/32', '::1/128']) {
    const matched = rules.filter((rule) => rule.address === address);
    assert.equal(matched.length, 1, `${file} 必须有且只有 1 条 ${address} 规则，实际 ${matched.length} 条`);
    assert.equal(matched[0].method, 'scram-sha-256', `${file}:${matched[0].lineNo} ${address} 必须用 scram-sha-256，实际 ${matched[0].method}：${matched[0].raw}`);
  }
}

/** （3）目标 VPC 内两条专用身份（迁移管理员 + 应用运行时）。 */
function auditHbaVpcRules(text, file = HBA_FILE) {
  const rules = parseHbaRules(text, file);
  for (const user of ['gengyun_cvm_owner', 'gengyun_api_runtime']) {
    const expected = `host @DB_NAME@ ${user} 10.21.0.0/16 scram-sha-256`;
    const matched = rules.filter((rule) => rule.address === '10.21.0.0/16' && rule.user === user);
    assert.equal(matched.length, 1, `${file} 必须有且只有 1 条 ${expected}，实际 ${matched.length} 条`);
    assert.equal(matched[0].normalized, expected, `${file}:${matched[0].lineNo} 规则必须逐字段为 \`${expected}\`，实际 \`${matched[0].normalized}\``);
  }
}

/** （3）末条必须是默认拒绝（顺序敏感：末条之前的规则先匹配）。 */
function auditHbaDefaultReject(text, file = HBA_FILE) {
  const rules = parseHbaRules(text, file);
  assert.ok(rules.length > 0, `${file} 没有任何有效规则`);
  const last = rules[rules.length - 1];
  assert.equal(
    last.normalized,
    'host all all 10.21.0.0/16 reject',
    `${file}:${last.lineNo} 最后一条规则必须是 \`host all all 10.21.0.0/16 reject\`（默认拒绝、顺序敏感），实际 \`${last.normalized}\``,
  );
}

/** （3）有效规则里不得出现公网段（注释里提到这两个串是说明文字，不算规则）。 */
function auditHbaNoPublicRule(text, file = HBA_FILE) {
  for (const rule of parseHbaRules(text, file)) {
    for (const publicCidr of ['0.0.0.0/0', '::/0']) {
      assert.ok(!rule.fields.includes(publicCidr), `${file}:${rule.lineNo} 出现公网段规则 ${publicCidr}（入站规则被误放开时这是唯一兜底）：${rule.raw}`);
    }
  }
}

/** （4）pg_ident：恰好 1 条映射，且不含通配符。 */
function auditIdentMapping(text, file = IDENT_FILE) {
  const rules = parseIdentRules(text, file);
  assert.equal(rules.length, 1, `${file} 必须恰好 1 条有效映射（多一条就多一个免口令身份），实际 ${rules.length} 条`);
  const [rule] = rules;
  assert.equal(
    rule.normalized,
    'gengyun_ops postgres gengyun_cvm_owner',
    `${file}:${rule.lineNo} 映射必须为 \`gengyun_ops postgres gengyun_cvm_owner\`，实际 \`${rule.normalized}\``,
  );
  assert.deepEqual(
    [rule.map, rule.systemUser, rule.databaseUser],
    ['gengyun_ops', 'postgres', 'gengyun_cvm_owner'],
    `${file}:${rule.lineNo} 三字段必须是 map-name=gengyun_ops、system-username=postgres、database-username=gengyun_cvm_owner`,
  );
  assert.doesNotMatch(rule.normalized, /[*?%]/, `${file}:${rule.lineNo} 映射不得含通配符（* ? %）：${rule.raw}`);
}

/** （5）systemd 单元必须逐字保留的关键字段。 */
const UNIT_EXPECTED_FIELDS = [
  ['Type', 'notify'],
  ['User', 'postgres'],
  ['Group', 'postgres'],
  ['RuntimeDirectory', 'postgresql'],
  ['RuntimeDirectoryMode', '2775'],
  ['Restart', 'on-failure'],
  ['ExecStart', '@PG_BIN@/postgres -D @PGDATA@ -c config_file=@PGDATA@/postgresql.conf'],
  ['WantedBy', 'multi-user.target'],
  ['RequiresMountsFor', '@PGDATA@'],
];

function auditUnitFields(text, file = UNIT_FILE) {
  const assignments = parseUnitAssignments(text, file);
  for (const [key, expected] of UNIT_EXPECTED_FIELDS) {
    const hit = assignments.get(key);
    assert.ok(hit, `${file} 缺少字段 \`${key}=\`（本片要求该字段逐字存在）`);
    assert.equal(hit.value, expected, `${file}:${hit.lineNo} ${key} 必须逐字为 \`${expected}\`，实际 \`${hit.value}\``);
  }
}

/** （6）正向：`substitute()` 的 token 集合必须恰好等于冻结的 5 个。 */
const SUBSTITUTE_TOKENS_FROZEN = ['@PGDATA@', '@PGPORT@', '@VPC_PRIVATE_IP@', '@CVM_HOSTNAME@', '@DB_NAME@'];

function auditSubstituteTokenSet(scriptText, file = INSTALLER_FILE) {
  const actual = parseSubstituteTokens(scriptText, file);
  const missing = SUBSTITUTE_TOKENS_FROZEN.filter((token) => !actual.includes(token));
  const extra = actual.filter((token) => !SUBSTITUTE_TOKENS_FROZEN.includes(token));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${file} 的 substitute() token 集合与冻结的 5 个不一致：新增 ${JSON.stringify(extra)}、删除 ${JSON.stringify(missing)}；增删 token 必须显式更新 tests/unit/deploy-pg-conf-guard.test.mjs 与本文件头注释`,
  );
}

/** （6）正向：模板**有效行**里出现的 token 必须 ⊆ 渲染器认识的那一撮。 */
function auditEffectiveTokenContainment({ file, text, allowed, rendererNote }) {
  const unexpected = tokensIn(effectiveLines(text).join('\n')).filter((token) => !allowed.includes(token));
  assert.deepEqual(
    unexpected,
    [],
    `${file} 的有效行出现 ${rendererNote} 不认识的占位符 ${JSON.stringify(unexpected)}：渲染后这些 @XXX@ 会以字面量留在生产配置里`,
  );
}

/** （6）service 的正向：token 恰好是 {@PGDATA@, @PG_BIN@}（两种都必须在文件里出现）。 */
const UNIT_RENDER_TOKENS_FROZEN = ['@PGDATA@', '@PG_BIN@'];

function auditUnitRenderTokenSet(scriptText, file = INSTALLER_FILE) {
  const actual = parseUnitRenderTokens(scriptText, file);
  const missing = UNIT_RENDER_TOKENS_FROZEN.filter((token) => !actual.includes(token));
  const extra = actual.filter((token) => !UNIT_RENDER_TOKENS_FROZEN.includes(token));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${file} 渲染 gengyun-postgresql.service 的 sed token 集合与冻结的 2 个不一致：新增 ${JSON.stringify(extra)}、删除 ${JSON.stringify(missing)}`,
  );
}

/**
 * （6）反向：`substitute()` 的 5 个 token，每个都必须真的被某个模板用到，否则渲染器里留的是死条目。
 * 口径按**实测**分级：`@CVM_HOSTNAME@` 今天只出现在 `10-gengyun-postgres.conf` 的注释块里
 * （说明该变量的用途），改成「有效行」口径会误红；故它按**全文**判，其余四个按**有效行**判。
 * 这条分级本身也冻结：token 增减必须显式改本表（见证据页 §4 的口径说明与理由）。
 */
const TOKEN_PRESENCE_SCOPE = new Map([
  ['@PGDATA@', 'effective'],
  ['@PGPORT@', 'effective'],
  ['@VPC_PRIVATE_IP@', 'effective'],
  ['@DB_NAME@', 'effective'],
  ['@CVM_HOSTNAME@', 'full'],
]);

function auditTokenReverseCoverage(templates) {
  assert.deepEqual(
    [...TOKEN_PRESENCE_SCOPE.keys()].sort(),
    [...SUBSTITUTE_TOKENS_FROZEN].sort(),
    'TOKEN_PRESENCE_SCOPE 必须恰好覆盖 substitute() 的 5 个 token（增删 token 时同步口径表）',
  );
  const effectiveText = templates.map((template) => effectiveLines(template.text).join('\n')).join('\n');
  const fullText = templates.map((template) => template.text).join('\n');
  for (const [token, scope] of TOKEN_PRESENCE_SCOPE) {
    const haystack = scope === 'effective' ? effectiveText : fullText;
    assert.ok(
      haystack.includes(token),
      `${token} 在模板的${scope === 'effective' ? '有效行' : '全文（含注释）'}里找不到：substitute() 会替换它，但没有任何模板用到 ⇒ 渲染器与模板已脱节`,
    );
  }
}

// ---------------------------------------------------------------------------
// （1）冻结快照：10-gengyun-postgres.conf 的有效行（33 行，按原始顺序、保留行内空格）
// ---------------------------------------------------------------------------

const CONF_EFFECTIVE_SNAPSHOT = [
  "listen_addresses = '127.0.0.1,@VPC_PRIVATE_IP@'",
  'port = @PGPORT@',
  "data_directory = '@PGDATA@'",
  "hba_file = '@PGDATA@/pg_hba.conf'",
  "ident_file = '@PGDATA@/pg_ident.conf'",
  "unix_socket_directories = '/var/run/postgresql'",
  'unix_socket_permissions = 0770',
  "password_encryption = 'scram-sha-256'",
  'ssl = off',
  'max_connections = 100',
  'superuser_reserved_connections = 3',
  'logging_collector = on',
  "log_directory = 'log'",
  "log_filename = 'postgresql-%a.log'",
  'log_rotation_age = 1d',
  'log_rotation_size = 0',
  'log_truncate_on_rotation = on',
  "log_line_prefix = '%m [%p] %q%u@%d %h '",
  "log_timezone = 'UTC'",
  "log_statement = 'none'",
  'log_min_duration_statement = 1000',
  'log_connections = on',
  'log_disconnections = on',
  'log_checkpoints = on',
  "timezone = 'UTC'",
  "datestyle = 'iso, mdy'",
  "lc_messages = 'C'",
  "lc_monetary = 'C'",
  "lc_numeric = 'C'",
  "lc_time = 'C'",
  "default_text_search_config = 'pg_catalog.english'",
  'wal_level = replica',
  'archive_mode = off',
];

test('（1）10-gengyun-postgres.conf 的有效行逐字等于冻结快照（33 行；增删改必须显式更新本文件）', () => {
  assert.deepEqual(effectiveLines(confText), CONF_EFFECTIVE_SNAPSHOT);
});

// ---------------------------------------------------------------------------
// （2）安全基线语义不变量（不依赖快照文字，直接判值与集合）
// ---------------------------------------------------------------------------

test('（2）listen_addresses 只允许回环 + VPC 私网占位符，禁 * / 0.0.0.0 / ::', () => {
  auditListenAddresses(confText);
});

test('（2）口令认证面：password_encryption=scram-sha-256、unix_socket_permissions=0770、socket 目录非空', () => {
  auditAuthAndSockets(confText);
});

test("（2）日志隐私面：log_statement='none'、log_min_duration_statement=1000", () => {
  auditLoggingPrivacy(confText);
});

test("（2）时区与本地化：timezone/log_timezone='UTC'、lc_messages='C'", () => {
  auditLocale(confText);
});

test('（2）连接数上限：max_connections / superuser_reserved_connections 必须是整数', () => {
  auditConnectionLimits(confText);
});

// ---------------------------------------------------------------------------
// （3）pg_hba.gengyun.conf 规则面
// ---------------------------------------------------------------------------

test('（3）规则面：5 段、方法 ⊆ {peer, scram-sha-256, reject}、禁 trust/md5/password/ident/gss、地址只在回环与 10.21.0.0/16', () => {
  auditHbaRuleSurface(hbaText);
});

test('（3）local 行：恰好 1 条且为 `local all all peer map=gengyun_ops`', () => {
  auditHbaLocalRule(hbaText);
});

test('（3）回环 TCP：127.0.0.1/32 与 ::1/128 各 1 条 scram-sha-256', () => {
  auditHbaLoopbackRules(hbaText);
});

test('（3）目标 VPC 内两条专用身份：host @DB_NAME@ <user> 10.21.0.0/16 scram-sha-256', () => {
  auditHbaVpcRules(hbaText);
});

test('（3）末条默认拒绝：host all all 10.21.0.0/16 reject（顺序敏感）', () => {
  auditHbaDefaultReject(hbaText);
});

test('（3）无公网段规则：有效规则里不出现 0.0.0.0/0 或 ::/0', () => {
  auditHbaNoPublicRule(hbaText);
});

// ---------------------------------------------------------------------------
// （4）pg_ident.gengyun.conf 单映射
// ---------------------------------------------------------------------------

test('（4）pg_ident：恰好 1 条映射 gengyun_ops postgres gengyun_cvm_owner，且不含通配符', () => {
  auditIdentMapping(identText);
});

// ---------------------------------------------------------------------------
// （5）gengyun-postgresql.service 关键字段
// ---------------------------------------------------------------------------

test('（5）systemd 单元关键字段逐字保留（Type/User/Group/RuntimeDirectory/ExecStart/Restart/…）', () => {
  auditUnitFields(unitText);
});

// ---------------------------------------------------------------------------
// （6）占位符 ↔ 渲染器双向一致性
// ---------------------------------------------------------------------------

test('（6）substitute() 的 token 集合恰好等于冻结的 5 个', () => {
  auditSubstituteTokenSet(installerText);
});

test('（6）走 substitute() 的三个模板：有效行 token ⊆ 那 5 个（点名文件与 token）', () => {
  for (const template of SUBSTITUTE_TEMPLATES) {
    auditEffectiveTokenContainment({
      file: template.file,
      text: template.text,
      allowed: SUBSTITUTE_TOKENS_FROZEN,
      rendererNote: 'substitute()',
    });
  }
});

test('（6）gengyun-postgresql.service：有效行 token 恰好 {@PGDATA@, @PG_BIN@}，且渲染它的 sed 也恰好认这两个', () => {
  auditEffectiveTokenContainment({
    file: UNIT_FILE,
    text: unitText,
    allowed: UNIT_RENDER_TOKENS_FROZEN,
    rendererNote: '第 9 节那段 sed',
  });
  const unitTokens = tokensIn(effectiveLines(unitText).join('\n'));
  for (const token of UNIT_RENDER_TOKENS_FROZEN) {
    assert.ok(unitTokens.includes(token), `${UNIT_FILE} 的有效行没有用到 ${token}（渲染器认它但模板不用 ⇒ 渲染器与模板脱节）`);
  }
  auditUnitRenderTokenSet(installerText);
});

test('（6）反向：substitute() 的 5 个 token 每个都被模板用到（@CVM_HOSTNAME@ 口径=全文，见口径表）', () => {
  auditTokenReverseCoverage(SUBSTITUTE_TEMPLATES);
});

// ---------------------------------------------------------------------------
// 负控制（派单 §2.2 五条）：内存夹具改坏一处，喂**同一批审计函数**，必须红在预期那一条。
// 每条都先跑一次真实文件（正控制），证明不是函数本身恒红。
// ---------------------------------------------------------------------------

test('负控制 1：把 pg_hba 的回环行改成 trust ⇒ 规则面断言红，并点名该行与规则原文', () => {
  auditHbaRuleSurface(hbaText);
  const mutated = hbaText.replace(/(127\.0\.0\.1\/32\s+)scram-sha-256/, '$1trust');
  assert.notEqual(mutated, hbaText, '夹具构造失败：没改到 127.0.0.1/32 那一行的 scram-sha-256');
  assert.throws(
    () => auditHbaRuleSurface(mutated),
    /pg_hba\.gengyun\.conf:27 出现被禁的认证方法 trust（禁 trust\/md5\/password\/ident\/gss）：.*127\.0\.0\.1\/32\s+trust$/,
  );
});

test("负控制 2：把 listen_addresses 改成 '*' ⇒ listen_addresses 断言红", () => {
  auditListenAddresses(confText);
  const mutated = confText.replace(/^listen_addresses[^\n]*$/m, "listen_addresses = '*'");
  assert.notEqual(mutated, confText, '夹具构造失败：没改到 listen_addresses 行');
  assert.throws(() => auditListenAddresses(mutated), /10-gengyun-postgres\.conf:\d+ listen_addresses 含 '\*'/);
});

test('负控制 3：把模板有效行的 token 改成 @NOT_RENDERED@ ⇒ token 包含断言红，并点名该 token 与文件', () => {
  auditEffectiveTokenContainment({ file: CONF_FILE, text: confText, allowed: SUBSTITUTE_TOKENS_FROZEN, rendererNote: 'substitute()' });
  // 夹具用 replaceAll：@VPC_PRIVATE_IP@ 在注释块里也出现一次，只换首个会换到注释上（那正是本断言不该管的地方）。
  const mutated = confText.replaceAll('@VPC_PRIVATE_IP@', '@NOT_RENDERED@');
  assert.notEqual(mutated, confText, '夹具构造失败：没改到 @VPC_PRIVATE_IP@');
  assert.throws(
    () => auditEffectiveTokenContainment({ file: CONF_FILE, text: mutated, allowed: SUBSTITUTE_TOKENS_FROZEN, rendererNote: 'substitute()' }),
    /10-gengyun-postgres\.conf 的有效行出现 substitute\(\) 不认识的占位符 \["@NOT_RENDERED@"\]/,
  );
});

test('负控制 4：删掉 pg_hba 的 reject 行 ⇒「最后一条必须是 reject」断言红', () => {
  auditHbaDefaultReject(hbaText);
  const mutated = hbaText.replace(/^host\s+all\s+all\s+10\.21\.0\.0\/16\s+reject[^\n]*\n/m, '');
  assert.notEqual(mutated, hbaText, '夹具构造失败：没删掉 reject 行');
  assert.throws(() => auditHbaDefaultReject(mutated), /最后一条规则必须是 `host all all 10\.21\.0\.0\/16 reject`/);
});

test('负控制 5：从 substitute() 里删掉 @DB_NAME@ 的 sed 行 ⇒ 冻结 token 集合断言红并点名被删 token', () => {
  auditSubstituteTokenSet(installerText);
  const mutated = installerText.replace(/^\s*-e "s\|@DB_NAME@\|[^"]*" \\?\r?\n/m, '');
  assert.notEqual(mutated, installerText, '夹具构造失败：没删掉 @DB_NAME@ 的 sed 行');
  assert.throws(() => auditSubstituteTokenSet(mutated), /删除 \["@DB_NAME@"\]/);
});

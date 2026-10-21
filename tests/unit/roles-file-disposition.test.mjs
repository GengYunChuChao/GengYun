// 静态守卫：角色文件的「处置清单」双向一致 + 计数一致 + 20-login 引用闭合 + 文档计数一致。
//
// 为什么需要它：`services/api/db/roles/` 下有 8 个 `.sql`、11 条建角色语句，但
// `deploy/postgres-cvm/provision-db.sh` 的 `ROLE_GROUP_FILES` 只列 5 个基础文件
// （`WITH_CLI_GROUPS=1` 时再追加 2 个）——`egress_ledger.sql` 从未被任何部署脚本执行。
// 这个缺口此前是「无声漂移」：文件加了、脚本没加、文档还写「7 个文件，10 个 NOLOGIN 角色」，
// 没有任何一条断言会红。本片把它变成**显式的处置清单**：每个 `.sql` 必须恰好落在
// `base` / `cli` / `not_provisioned` 三类之一；`egress_ledger.sql` 的例外必须写明理由。
// 谁要把它接进部署脚本，就必须先改这张表（断言 ③ 会红），而不是让它悄悄多跑一个文件。
//
// 结构：解析器（纯函数，入参是字符串 / 文件清单）与断言分离 ⇒ 五条负控制直接喂内存夹具，
// ⛔ 不需要真的改仓库文件（本文件对工作区零写入）。
//
// 不做的事：不连库、不执行 SQL、不跑 `provision-db.sh`（只解析文本），也不裁定
// 「`egress_ledger` 是否应当授权给运行时」。部署形态下账本路径的行为见
// `docs/verification/gy-r28-roles-file-disposition-20261021.md` §4。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const ROLES_DIR = 'services/api/db/roles';
const PROVISION_SCRIPT = 'deploy/postgres-cvm/provision-db.sh';
const LOGIN_ROLES_SQL = 'deploy/postgres-cvm/sql/20-login-roles.sql';
/** 三处过期计数所在的两个文档（2026-10-21 已订正，见证据页 §2）。 */
const COUNT_DOCS = ['deploy/postgres-cvm/README.md', 'deploy/postgres-cvm/roles-and-migration.md'];

/** 具名常量：新增/删除角色文件或建角色语句时，必须同时改这里、DISPOSITION 与两个文档。 */
const EXPECTED_FILE_COUNT = 8;
const EXPECTED_ROLE_COUNT = 11;

const DISPOSITION_CLASSES = ['base', 'cli', 'not_provisioned'];

/**
 * 处置清单（显式、可读，不接受隐式默认值）。
 *
 * - `base`：`ROLE_GROUP_FILES` 的基础 5 条（每次部署都会执行）；
 * - `cli`：`WITH_CLI_GROUPS=1` 时追加的 2 条（脚本里的 `ROLE_GROUP_FILES+=(…)`）；
 * - `not_provisioned`：`roles/` 里存在、但没有任何部署脚本执行的文件（必须写明理由）。
 */
const DISPOSITION = {
  base: [
    { file: 'auth_privacy.sql', role: 'gengyun_auth_privacy' },
    { file: 'catalog_readers.sql', role: 'gengyun_preview_reader' },
    { file: 'consent_granter.sql', role: 'gengyun_consent_granter' },
    { file: 'profile_runtime.sql', role: 'gengyun_profile_runtime' },
    { file: 'knowledge_runtime.sql', role: 'gengyun_knowledge_runtime' },
  ],
  cli: [
    { file: 'source_operator.sql', role: 'gengyun_source_operator' },
    { file: 'staging_importer.sql', role: 'gengyun_staging_importer' },
  ],
  not_provisioned: [
    {
      file: 'egress_ledger.sql',
      reason: '`provision-db.sh` 的 `ROLE_GROUP_FILES` 只列 5 个基础文件（`WITH_CLI_GROUPS=1` 时 7 个），'
        + '不执行本文件；外发账本因此在 CVM 上处于未就绪；是否需要授权属产品/安全待裁定'
        + '（本片只登记事实，不裁定）。',
    },
  ],
};

/** 读目录下的角色文件（只读 `.sql`，按文件名排序）。 */
function loadRoleSources(dir = ROLES_DIR) {
  const abs = resolve(root, dir);
  return readdirSync(abs)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ file: name, text: readFileSync(resolve(abs, name), 'utf8') }));
}

/**
 * 去掉行首 `--` 注释行：注释里写着「裸 CREATE ROLE 不可重跑」，那是说明文字，不是语句。
 *
 * 只认「整行注释」——本目录的注释都是独占行；不做行内 `--` 裁剪，是为了不误伤 SQL 里
 * 可能出现的 `--`（例如未来某个字符串字面量）。若哪天出现行内注释，建角色语句仍会被
 * 抓到（语句在 `--` 之前），不会漏计。
 */
function stripCommentLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * 解析建角色语句（兼容两种形态：裸 `CREATE ROLE <name> …;` 与守卫块里的 `EXECUTE 'CREATE ROLE <name> …'`）。
 * @returns {{file: string, role: string}[]}
 */
function parseCreateRoles(sources) {
  const found = [];
  for (const { file, text } of sources) {
    const clean = stripCommentLines(text);
    for (const match of clean.matchAll(/CREATE\s+ROLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      found.push({ file, role: match[1] });
    }
  }
  return found;
}

/**
 * 解析脚本里的 `ROLE_GROUP_FILES=(…)` 与 `ROLE_GROUP_FILES+=(…)` 两个数组。
 *
 * 按「`=` 开数组 → 逐行收 `'组:文件'` → `)` 收口」扫描，不是全文正则匹配：
 * 全文匹配会把注释里举例的 `'组:文件'` 也当成真条目（注释里确实会写例子）。
 * @returns {{base: {role: string, file: string, line: number}[], cli: {role: string, file: string, line: number}[], cliGuard: string}}
 */
function parseRoleGroupFiles(scriptText) {
  const lines = scriptText.split(/\r?\n/);
  const base = [];
  const cli = [];
  let open = null;
  let cliGuard = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*ROLE_GROUP_FILES=\(/.test(line)) {
      open = 'base';
      continue;
    }
    if (/^\s*ROLE_GROUP_FILES\+=\(/.test(line)) {
      open = 'cli';
      // `WITH_CLI_GROUPS` 的条件行在 `+=` 之前 1–2 行；取前 3 行留出注释位。
      cliGuard = lines.slice(Math.max(0, index - 3), index).join('\n');
      continue;
    }
    if (open === null) continue;
    if (/^\s*\)\s*$/.test(line)) {
      open = null;
      continue;
    }
    const entry = /^\s*'([A-Za-z_][A-Za-z0-9_]*):([A-Za-z0-9_.]+\.sql)'\s*$/.exec(line);
    if (entry !== null) {
      (open === 'base' ? base : cli).push({ role: entry[1], file: entry[2], line: index + 1 });
    }
  }

  return { base, cli, cliGuard };
}

/**
 * 解析 `20-login-roles.sql` 里的 `GRANT gengyun_<组> TO gengyun_<角色>;`。
 * 只认「整行 GRANT 组名 TO 角色」——`GRANT SELECT ON …` / `GRANT EXECUTE ON FUNCTION …` 不是组成员授予。
 * @returns {{line: number, role: string, grantee: string}[]}
 */
function parseGroupGrants(loginSqlText) {
  const grants = [];
  loginSqlText.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*GRANT\s+(gengyun_[A-Za-z0-9_]+)\s+TO\s+(gengyun_[A-Za-z0-9_]+)\s*;/.exec(line);
    if (match !== null) grants.push({ line: index + 1, role: match[1], grantee: match[2] });
  });
  return grants;
}

/**
 * 解析文档里形如「N 个文件」「N 个 NOLOGIN 组/角色」的计数断言。
 *
 * 只收**角色文件相关**的行（同行的 `db/roles` 或「角色文件」），避免把 README 里
 * 别的「N 个文件」读数误抓成角色计数。返回行号与原文，判红时能直接定位。
 * @returns {{fileClaims: {line: number, value: number, text: string}[], roleClaims: {line: number, value: number, text: string}[]}}
 */
function parseDocCountClaims(docText) {
  const fileClaims = [];
  const roleClaims = [];
  docText.split(/\r?\n/).forEach((line, index) => {
    if (!/db\/roles|角色文件/.test(line)) return;
    for (const match of line.matchAll(/(\d+)\s*个(?:角色)?文件/g)) {
      fileClaims.push({ line: index + 1, value: Number(match[1]), text: line.trim() });
    }
    for (const match of line.matchAll(/(\d+)\s*个\s*NOLOGIN\s*(?:组|角色)/g)) {
      roleClaims.push({ line: index + 1, value: Number(match[1]), text: line.trim() });
    }
  });
  return { fileClaims, roleClaims };
}

/**
 * 断言 ①②：`roles/` 的每个 `.sql` 恰好落在三类之一；三类里的文件名都真实存在。
 * @returns {{ok: boolean, problems: string[]}}
 */
function auditDispositionCoverage(disposition, actualFiles) {
  const problems = [];
  const registered = [];

  for (const cls of DISPOSITION_CLASSES) {
    const entries = disposition[cls];
    if (!Array.isArray(entries) || entries.length === 0) {
      problems.push(`DISPOSITION.${cls} 为空或不是数组：处置清单被掏空就不能算通过`);
      continue;
    }
    for (const entry of entries) {
      const file = typeof entry === 'string' ? entry : entry?.file;
      if (typeof file !== 'string' || file.trim() === '') {
        problems.push(`DISPOSITION.${cls} 有条目缺少 file 字段`);
        continue;
      }
      registered.push({ cls, file });
    }
  }

  // ① 覆盖率：漏登记（目录里有、清单里没有）与重复登记（同一文件落在两处/两遍）都判红。
  const classesByFile = new Map();
  for (const item of registered) {
    if (!classesByFile.has(item.file)) classesByFile.set(item.file, []);
    classesByFile.get(item.file).push(item.cls);
  }
  for (const file of actualFiles) {
    const classes = classesByFile.get(file) ?? [];
    if (classes.length === 0) {
      problems.push(`${ROLES_DIR}/${file} 没有落在 DISPOSITION 的任何一类（漏登记：是否被执行必须显式写清）`);
    } else if (classes.length > 1) {
      problems.push(`${ROLES_DIR}/${file} 在 DISPOSITION 里登记了 ${classes.length} 次（${classes.join(' / ')}），必须恰好一类`);
    }
  }

  // ② 反向：清单里的文件名必须真实存在（幽灵条目会让「已登记」变成假绿）。
  for (const item of registered) {
    if (!actualFiles.includes(item.file)) {
      problems.push(`DISPOSITION.${item.cls} 的 ${item.file} 在 ${ROLES_DIR}/ 下不存在（幽灵条目）`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 断言 ③：`provision-db.sh` 的 `ROLE_GROUP_FILES`（基础 + cli）与 `DISPOSITION.base ∪ cli` **逐条配对相等**。
 *
 * 配对相等（`组:文件`）比「组名集合相等」更强：组名集合相等也允许「A 组配错文件」蒙过去。
 * 比对的是**解析脚本原文**的结果，不是硬编码的清单。
 */
function auditDispositionMatchesScript(disposition, scriptEntries) {
  const problems = [];

  if (scriptEntries.base.length === 0) {
    problems.push(`解析不到 ${PROVISION_SCRIPT} 的 ROLE_GROUP_FILES=(…) 条目（形态被改就必须同步本文件的解析器）`);
  }
  if (scriptEntries.cli.length === 0) {
    problems.push(`解析不到 ${PROVISION_SCRIPT} 的 ROLE_GROUP_FILES+=(…) 条目（WITH_CLI_GROUPS 分支被删？）`);
  }
  if (!scriptEntries.cliGuard.includes('WITH_CLI_GROUPS')) {
    problems.push(`${PROVISION_SCRIPT} 的 ROLE_GROUP_FILES+=(…) 不在 WITH_CLI_GROUPS 条件里：cli 组会变成默认执行`);
  }

  const declared = [];
  for (const cls of ['base', 'cli']) {
    for (const entry of disposition[cls] ?? []) {
      if (entry && typeof entry.role === 'string' && typeof entry.file === 'string') {
        declared.push(`${entry.role}:${entry.file}`);
      }
    }
  }
  const declaredSet = new Set(declared);
  const scriptSet = new Set([...scriptEntries.base, ...scriptEntries.cli].map((entry) => `${entry.role}:${entry.file}`));

  for (const entry of scriptSet) {
    if (!declaredSet.has(entry)) {
      problems.push(`provision-db.sh 的 ROLE_GROUP_FILES 多出 ${entry}（DISPOSITION.base ∪ cli 未登记该组/文件）`);
    }
  }
  for (const entry of declaredSet) {
    if (!scriptSet.has(entry)) {
      problems.push(`DISPOSITION 声明 ${entry}，但 provision-db.sh 的 ROLE_GROUP_FILES 里没有（清单与脚本不一致）`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/** 断言 2：文件数与 CREATE ROLE 条数必须等于具名常量；角色名不得重复。 */
function auditRoleCounts(fileCount, roles) {
  const problems = [];
  if (fileCount !== EXPECTED_FILE_COUNT) {
    problems.push(`${ROLES_DIR}/ 下 .sql 文件数 ${fileCount} ≠ ${EXPECTED_FILE_COUNT}（新增/删除文件必须同时改 DISPOSITION、EXPECTED_FILE_COUNT 与两个文档）`);
  }
  if (roles.length !== EXPECTED_ROLE_COUNT) {
    problems.push(`${ROLES_DIR}/ 下 CREATE ROLE 条数 ${roles.length} ≠ ${EXPECTED_ROLE_COUNT}`);
  }
  const names = roles.map((item) => item.role);
  const duplicated = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  if (duplicated.length > 0) problems.push(`CREATE ROLE 角色名重复：${duplicated.join(', ')}`);
  return { ok: problems.length === 0, problems };
}

/** 断言 3：`20-login-roles.sql` 授给运行时的组必须都在 `roles/` 里有定义（引用闭合）。 */
function auditRuntimeGroupGrants(grants, roleNames) {
  const problems = [];
  if (grants.length === 0) {
    problems.push(`解析不到任何「GRANT gengyun_<组> TO gengyun_api_runtime;」（句子被删或形态改变，不能当作通过）`);
  }
  const known = new Set(roleNames);
  for (const grant of grants) {
    if (!known.has(grant.role)) {
      problems.push(`${LOGIN_ROLES_SQL}:${grant.line} 授权引用 ${grant.role}，但 ${ROLES_DIR}/ 的 ${roleNames.length} 条 CREATE ROLE 里没有它（悬空引用）`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 断言 4：两个文档里的角色文件计数必须等于实测；解析不到计数句同样判红（防删句绕过）。 */
function auditDocCounts(docSources, expected) {
  const problems = [];
  for (const { doc, text } of docSources) {
    const { fileClaims, roleClaims } = parseDocCountClaims(text);
    if (fileClaims.length === 0) {
      problems.push(`${doc}: 解析不到「N 个文件」的角色文件计数句（删掉句子不能当通过）`);
    }
    if (roleClaims.length === 0) {
      problems.push(`${doc}: 解析不到「N 个 NOLOGIN 组/角色」的计数句（删掉句子不能当通过）`);
    }
    for (const claim of fileClaims) {
      if (claim.value !== expected.files) {
        problems.push(`${doc}:${claim.line} 写「${claim.value} 个文件」，实测 ${expected.files} 个：${claim.text}`);
      }
    }
    for (const claim of roleClaims) {
      if (claim.value !== expected.roles) {
        problems.push(`${doc}:${claim.line} 写「${claim.value} 个 NOLOGIN 组/角色」，实测 ${expected.roles} 个：${claim.text}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// 真实读数（只读；下面的 10 条测试全部基于这些读数或其内存变异）
// ---------------------------------------------------------------------------
const roleSources = loadRoleSources();
const actualFiles = roleSources.map((source) => source.file);
const createRoles = parseCreateRoles(roleSources);
const roleNames = createRoles.map((item) => item.role);

const provisionText = readFileSync(resolve(root, PROVISION_SCRIPT), 'utf8');
const scriptEntries = parseRoleGroupFiles(provisionText);

const loginRolesText = readFileSync(resolve(root, LOGIN_ROLES_SQL), 'utf8');
const runtimeGrants = parseGroupGrants(loginRolesText).filter((grant) => grant.grantee === 'gengyun_api_runtime');

const docSources = COUNT_DOCS.map((doc) => ({ doc, text: readFileSync(resolve(root, doc), 'utf8') }));

// ---------------------------------------------------------------------------
// 五类断言
// ---------------------------------------------------------------------------
test('disposition ①②: roles/ 每个 .sql 恰好落在三类之一，三类里的文件名都真实存在', () => {
  const result = auditDispositionCoverage(DISPOSITION, actualFiles);
  assert.deepEqual(result.problems, [], `处置清单双向一致未通过：\n${result.problems.join('\n')}`);

  // 三类都不得为空：`not_provisioned` 尤其不能靠「什么都不写」来表达例外。
  for (const cls of DISPOSITION_CLASSES) {
    assert.ok(DISPOSITION[cls].length > 0, `DISPOSITION.${cls} 不得为空`);
  }

  // 未执行的那一类必须写明理由（否则「未登记」与「有意不执行」在清单上长得一样）。
  for (const entry of DISPOSITION.not_provisioned) {
    assert.equal(typeof entry.reason, 'string', `${entry.file} 缺少 reason`);
    assert.ok(entry.reason.length >= 30, `${entry.file} 的理由过短（${entry.reason.length} 字）：必须写清为什么不执行`);
    assert.ok(entry.reason.includes('待裁定'), `${entry.file} 的理由必须写明「待裁定」而不是给结论`);
  }
  const egress = DISPOSITION.not_provisioned.find((entry) => entry.file === 'egress_ledger.sql');
  assert.ok(egress, 'egress_ledger.sql 必须显式登记在 not_provisioned');
  assert.match(egress.reason, /provision-db\.sh/);
  assert.ok(egress.reason.includes('不执行'), '理由必须写明「provision-db.sh 不执行」');
  assert.ok(egress.reason.includes('外发账本因此在 CVM 上处于未就绪'), '理由必须写明部署形态下账本未就绪');
  assert.ok(egress.reason.includes('是否需要授权属产品/安全待裁定'), '理由必须写明「是否需要授权属产品/安全待裁定」');
});

test('disposition ③: provision-db.sh 的 ROLE_GROUP_FILES 与 DISPOSITION.base ∪ cli 逐条相等', () => {
  // 类别归属先自证：基础 5 条、cli 2 条来自脚本原文，不是把 DISPOSITION 抄两遍。
  assert.equal(scriptEntries.base.length, DISPOSITION.base.length,
    `ROLE_GROUP_FILES 基础条目 ${scriptEntries.base.length} 条，DISPOSITION.base ${DISPOSITION.base.length} 条`);
  assert.equal(scriptEntries.cli.length, DISPOSITION.cli.length,
    `ROLE_GROUP_FILES+=(…) 条目 ${scriptEntries.cli.length} 条，DISPOSITION.cli ${DISPOSITION.cli.length} 条`);
  const result = auditDispositionMatchesScript(DISPOSITION, scriptEntries);
  assert.deepEqual(result.problems, [], `处置清单与部署脚本不一致：\n${result.problems.join('\n')}`);
});

test('计数一致: 8 个文件、11 条 CREATE ROLE（具名常量）', () => {
  const result = auditRoleCounts(actualFiles.length, createRoles);
  assert.deepEqual(result.problems, [], `计数未通过：\n${result.problems.join('\n')}`);
  assert.equal(EXPECTED_FILE_COUNT, 8);
  assert.equal(EXPECTED_ROLE_COUNT, 11);
});

test('引用闭合: 20-login-roles.sql 授给运行时的组都在 roles/ 里有定义', () => {
  const result = auditRuntimeGroupGrants(runtimeGrants, roleNames);
  assert.deepEqual(result.problems, [], `引用闭合未通过：\n${result.problems.join('\n')}`);
  // 授权对象必须是运行时 LOGIN 角色本身（不是别的 grantee）。
  assert.equal(runtimeGrants.length > 0, true, '至少要解析到 1 条运行时组成员授予');
});

test('文档计数一致: README 与 roles-and-migration 的「N 个文件」「N 个 NOLOGIN 组/角色」等于实测', () => {
  const result = auditDocCounts(docSources, { files: EXPECTED_FILE_COUNT, roles: EXPECTED_ROLE_COUNT });
  assert.deepEqual(result.problems, [], `文档计数未通过：\n${result.problems.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 五条负控制（内存夹具；证明上面的断言不是恒真）
// ---------------------------------------------------------------------------
test('负控制 ①: 从 DISPOSITION 删掉 egress_ledger.sql ⇒ 断言 1① 红并点名该文件', () => {
  const mutated = {
    ...DISPOSITION,
    not_provisioned: DISPOSITION.not_provisioned.filter((entry) => entry.file !== 'egress_ledger.sql'),
  };
  assert.notDeepEqual(mutated.not_provisioned, DISPOSITION.not_provisioned, '负控制前置：变异没有真正生效');
  const result = auditDispositionCoverage(mutated, actualFiles);
  assert.equal(result.ok, false, '漏登记 egress_ledger.sql 后必须判红');
  assert.ok(
    result.problems.some((problem) => problem.includes('egress_ledger.sql') && problem.includes('漏登记')),
    `判红必须点名 egress_ledger.sql 且说明漏登记，实际：\n${result.problems.join('\n')}`,
  );
});

test('负控制 ②: not_provisioned 里塞一个不存在的文件 ⇒ 断言 1② 红', () => {
  const ghost = 'ghost_role_not_on_disk.sql';
  const mutated = {
    ...DISPOSITION,
    not_provisioned: [...DISPOSITION.not_provisioned, { file: ghost, reason: '负控制夹具：磁盘上并不存在这个文件，用来证明幽灵条目会红。' }],
  };
  const result = auditDispositionCoverage(mutated, actualFiles);
  assert.equal(result.ok, false, '幽灵条目必须判红');
  assert.ok(
    result.problems.some((problem) => problem.includes(ghost) && problem.includes('幽灵条目')),
    `判红必须点名幽灵文件，实际：\n${result.problems.join('\n')}`,
  );
});

test('负控制 ③: 伪造 ROLE_GROUP_FILES 多一条 ⇒ 断言 1③ 红并点名多出的组', () => {
  const anchor = "    'gengyun_staging_importer:staging_importer.sql'";
  assert.ok(provisionText.includes(anchor), '负控制前置：cli 数组的最后一条没找到（脚本形态已变，先同步本文件）');
  const mutatedText = provisionText.replace(anchor, `${anchor}\n    'gengyun_ghost_writer:ghost_writer.sql'`);
  // 用 ok 而不是 notEqual：整份脚本 ≥10 KB，失败时不该把全文灌进断言消息。
  assert.ok(mutatedText !== provisionText, '负控制前置：变异没有真正生效');
  const mutatedEntries = parseRoleGroupFiles(mutatedText);
  assert.equal(mutatedEntries.cli.length, scriptEntries.cli.length + 1, '负控制前置：多出的条目没有被解析到');
  const result = auditDispositionMatchesScript(DISPOSITION, mutatedEntries);
  assert.equal(result.ok, false, '脚本多执行一个未登记的组必须判红');
  assert.ok(
    result.problems.some((problem) => problem.includes('gengyun_ghost_writer')),
    `判红必须点名多出的组 gengyun_ghost_writer，实际：\n${result.problems.join('\n')}`,
  );
});

test('负控制 ④: 20-login-roles.sql 的 gengyun_preview_reader 改成不存在的角色 ⇒ 断言 3 红', () => {
  const mutatedText = loginRolesText.replace(
    /GRANT\s+gengyun_preview_reader\s+TO\s+gengyun_api_runtime;/,
    'GRANT gengyun_nonexistent TO gengyun_api_runtime;',
  );
  assert.ok(mutatedText !== loginRolesText, '负控制前置：变异没有真正生效');
  const mutatedGrants = parseGroupGrants(mutatedText).filter((grant) => grant.grantee === 'gengyun_api_runtime');
  const result = auditRuntimeGroupGrants(mutatedGrants, roleNames);
  assert.equal(result.ok, false, '引用不存在的组必须判红');
  assert.ok(
    result.problems.some((problem) => problem.includes('gengyun_nonexistent') && problem.includes('悬空引用')),
    `判红必须点名悬空角色，实际：\n${result.problems.join('\n')}`,
  );
});

test('负控制 ⑤: 文档计数改成「7 个文件」⇒ 断言 4 红', () => {
  const readme = docSources.find((source) => source.doc === 'deploy/postgres-cvm/README.md');
  assert.ok(readme, '负控制前置：README 没有读进来');
  const mutatedText = readme.text.replace('8 个文件', '7 个文件');
  assert.ok(mutatedText !== readme.text, '负控制前置：README 里没有「8 个文件」可改（文档形态已变，先同步本文件）');
  const mutatedDocs = docSources.map((source) => (
    source.doc === readme.doc ? { doc: source.doc, text: mutatedText } : source
  ));
  const result = auditDocCounts(mutatedDocs, { files: EXPECTED_FILE_COUNT, roles: EXPECTED_ROLE_COUNT });
  assert.equal(result.ok, false, '文档写错文件数必须判红');
  assert.ok(
    result.problems.some((problem) => problem.includes('README.md') && problem.includes('7 个文件')),
    `判红必须点名 README 与错误的 7，实际：\n${result.problems.join('\n')}`,
  );
});

// 静态守卫：services/api/db/roles/*.sql 的建角色必须「pg_roles 存在性守卫 + ALTER ROLE 收敛」。
//
// 为什么不连库：本片要防的是**文本形态回退**（谁把守卫删回裸 CREATE ROLE、或把守卫里的 rolname
// 写成别的名字），这种东西只有读源码才看得见；真库双跑证明另见
// docs/verification/gy-r28-roles-idempotent-20261021.md（同片：8 个文件各跑两遍 + 旧文件负控制）。
//
// 两条负控制（本文件的「不是恒真」证明）：
//   1. 把某个文件的守卫块换回派单前的裸 CREATE ROLE ⇒ 必须判红并点名该文件；
//   2. 把某条守卫里的 rolname 改错一个字符 ⇒ 必须判红并点名该文件与角色。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROLES_DIR = 'services/api/db/roles';

/** 出厂属性串：`CREATE ROLE` 与 `ALTER ROLE … WITH` 两侧必须逐字相同。 */
const GROUP_ATTRS = 'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

/** 8 个文件、11 条 CREATE ROLE（2026-10-21 实测；派单初稿写「9 条」是笔误，见证据页 §2）。 */
const EXPECTED_FILE_COUNT = 8;
const EXPECTED_ROLE_COUNT = 11;

/**
 * 读目录下的角色文件（只读 .sql，按文件名排序）。
 * @param {string} dir 仓库相对目录
 * @returns {{file: string, text: string}[]}
 */
function loadRoleSources(dir = ROLES_DIR) {
  const abs = resolve(root, dir);
  return readdirSync(abs)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ file: name, text: readFileSync(resolve(abs, name), 'utf8') }));
}

/**
 * 找出所有 `DO $tag$ … $tag$;` 块的行区间（同一行开闭也算一块）。
 * 只认整行 `DO …` 起始 —— 本目录里没有 `SELECT do_block();` 之类，缩进不影响判定。
 * @param {string[]} lines
 * @returns {{start: number, end: number, text: string}[]} 行号对应 `lines` 的下标
 */
function findDoBlocks(lines) {
  const blocks = [];
  for (let start = 0; start < lines.length; start += 1) {
    const open = /^\s*DO\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/.exec(lines[start]);
    if (open === null) continue;
    const tag = open[1];
    let end = -1;
    for (let cursor = start; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trimEnd().endsWith(`${tag};`)) {
        end = cursor;
        break;
      }
    }
    // 未闭合的 DO 块记成「到文件尾」：后面按「块内是否含守卫」判，缺守卫时自然判红，
    // 而不是让解析器抛异常把失败原因藏在栈里。
    blocks.push({ start, end: end === -1 ? lines.length - 1 : end, text: lines.slice(start, (end === -1 ? lines.length - 1 : end) + 1).join('\n') });
  }
  return blocks;
}

/**
 * 审计一组角色文件的建角色形态。
 * @param {{file: string, text: string}[]} sources
 * @returns {{ok: boolean, problems: string[], creations: {file: string, role: string, attrs: string, line: number, guarded: boolean}[], converges: {file: string, role: string, attrs: string, line: number}[]}}
 */
function auditRoleSources(sources) {
  const problems = [];
  const creations = [];
  const converges = [];

  for (const { file, text } of sources) {
    const lines = text.split(/\r?\n/);
    const blocks = findDoBlocks(lines);
    const guardedBlockFor = (lineIndex) => blocks
      .filter((block) => lineIndex >= block.start && lineIndex <= block.end)
      .find((block) => /\bpg_roles\b/.test(block.text));

    lines.forEach((line, index) => {
      const lineNo = index + 1;

      // (a) 裸 CREATE ROLE：只允许出现在「带 pg_roles 守卫的 DO 块」里。
      //     改造后本目录应当是 0 条（建角色走块内 EXECUTE），所以这条同时是「回退探测器」。
      const bare = /^CREATE ROLE\s+(\w+)\s+(.+);\s*$/.exec(line);
      if (bare) {
        const block = guardedBlockFor(index);
        creations.push({ file, role: bare[1], attrs: bare[2].trim(), line: lineNo, guarded: block !== undefined });
        if (block === undefined) {
          problems.push(`${file}:${lineNo} 裸 CREATE ROLE ${bare[1]} 不在带 pg_roles 守卫的 DO 块内（第二遍必 42710）`);
        }
      }

      // (b) 守卫块内的 EXECUTE：必须落在带 pg_roles 守卫的块里，且守卫里有**同名**匹配。
      const exec = /^EXECUTE 'CREATE ROLE (\w+) ([^']+)';$/.exec(line.trim());
      if (exec) {
        const block = guardedBlockFor(index);
        creations.push({ file, role: exec[1], attrs: exec[2].trim(), line: lineNo, guarded: block !== undefined });
        if (block === undefined) {
          problems.push(`${file}:${lineNo} EXECUTE 'CREATE ROLE ${exec[1]}' 不在带 pg_roles 守卫的 DO 块内`);
        } else if (!block.text.includes(`rolname = '${exec[1]}'`)) {
          // 复制粘贴最容易出的错：守卫查的是别的角色名 ⇒ 该角色永远走 CREATE 分支 ⇒ 第二遍 42710。
          problems.push(`${file}:${lineNo} 守卫里的 rolname 与 CREATE ROLE ${exec[1]} 不同名（守卫必须匹配同名角色）`);
        }
      }

      // (c) 收敛语句：`ALTER ROLE <name> WITH <attrs>`。
      const alter = /^ALTER ROLE (\w+) WITH ([^;]+);\s*$/.exec(line.trim());
      if (alter) converges.push({ file, role: alter[1], attrs: alter[2].trim(), line: lineNo });
    });

    for (const creation of creations.filter((item) => item.file === file)) {
      const matched = converges.filter((item) => item.file === file && item.role === creation.role);
      if (matched.length !== 1) {
        problems.push(`${file}: 角色 ${creation.role} 的幂等收敛语句 ALTER ROLE … WITH 应恰好 1 条，实际 ${matched.length} 条`);
        continue;
      }
      if (matched[0].attrs !== creation.attrs) {
        problems.push(`${file}: 角色 ${creation.role} 的 ALTER ROLE 属性与 CREATE ROLE 不一致（${matched[0].attrs} ≠ ${creation.attrs}）`);
      }
      if (creation.attrs !== GROUP_ATTRS) {
        problems.push(`${file}: 角色 ${creation.role} 的属性串不再是出厂串（${creation.attrs}）`);
      }
    }
  }

  return { ok: problems.length === 0, problems, creations, converges };
}

/** 把某角色的守卫块（DO…END;$role_guard$; 共 7 行）换回派单前的裸 CREATE ROLE 一行。 */
function unguard(text, role) {
  const lines = text.split('\n');
  const start = lines.findIndex((line, index) => line === 'DO $role_guard$'
    && (lines[index + 3] ?? '').includes(`CREATE ROLE ${role} `));
  assert.notEqual(start, -1, `负控制前置：${role} 的守卫块没找到（形态已变，先同步本文件）`);
  assert.equal(lines[start + 1], 'BEGIN');
  assert.match(lines[start + 2], new RegExp(`^  IF NOT EXISTS \\(SELECT 1 FROM pg_roles WHERE rolname = '${role}'\\) THEN$`));
  assert.match(lines[start + 3], /^    EXECUTE 'CREATE ROLE .+';$/);
  assert.equal(lines[start + 4], '  END IF;');
  assert.equal(lines[start + 5], 'END;');
  assert.equal(lines[start + 6], '$role_guard$;');
  const attrs = lines[start + 3].replace(/^    EXECUTE 'CREATE ROLE \w+ /, '').replace(/';$/, '');
  const mutated = [...lines.slice(0, start), `CREATE ROLE ${role} ${attrs};`, ...lines.slice(start + 7)];
  assert.equal(mutated.length, lines.length - 6, `负控制前置：守卫块应为 7 行换取 1 行（实际 ${lines.length} → ${mutated.length}）`);
  return mutated.join('\n');
}

const sources = loadRoleSources();

test('roles/bootstrap: 8 个角色文件、11 条建角色，全部走守卫 + 收敛', () => {
  assert.equal(sources.length, EXPECTED_FILE_COUNT, `${ROLES_DIR} 的文件数变了（当前 ${sources.map((s) => s.file).join(', ')}）`);
  const result = auditRoleSources(sources);
  assert.deepEqual(result.problems, [], `静态守卫未通过：\n${result.problems.join('\n')}`);
  assert.equal(result.creations.length, EXPECTED_ROLE_COUNT, `建角色语句总数应为 ${EXPECTED_ROLE_COUNT}`);
  assert.equal(result.converges.length, EXPECTED_ROLE_COUNT, `收敛语句总数应为 ${EXPECTED_ROLE_COUNT}`);
  assert.equal(new Set(result.creations.map((item) => item.role)).size, EXPECTED_ROLE_COUNT, '角色名必须两两不同');
  // 改造后一条裸写都不该剩下：这是「文本回退」的最直接读数。
  const bare = result.creations.filter((item) => {
    const line = sources.find((source) => source.file === item.file).text.split(/\r?\n/)[item.line - 1];
    return line.startsWith('CREATE ROLE ');
  });
  assert.deepEqual(bare, [], `还有裸 CREATE ROLE：${bare.map((item) => `${item.file}:${item.line} ${item.role}`).join(', ')}`);
});

test('roles/bootstrap: 守卫里的 rolname 与 CREATE ROLE 同名（11/11）', () => {
  const result = auditRoleSources(sources);
  const guards = sources.flatMap(({ file, text }) => [...text.matchAll(/rolname = '(\w+)'/g)].map((match) => ({ file, role: match[1] })));
  assert.equal(guards.length, EXPECTED_ROLE_COUNT, `守卫语句应为 ${EXPECTED_ROLE_COUNT} 条`);
  for (const creation of result.creations) {
    const sameName = guards.filter((guard) => guard.file === creation.file && guard.role === creation.role);
    assert.equal(sameName.length, 1, `${creation.file}: ${creation.role} 在守卫里必须恰好匹配 1 次，实际 ${sameName.length} 次`);
  }
});

test('roles/bootstrap 负控制 1：换回裸 CREATE ROLE ⇒ 判红并点名文件', () => {
  const target = sources.find((source) => source.file === 'auth_privacy.sql');
  assert.ok(target, '缺少 auth_privacy.sql');
  const mutated = { ...target, text: unguard(target.text, 'gengyun_auth_privacy') };
  assert.notEqual(mutated.text, target.text, '负控制前置：变异没有真正生效');
  const result = auditRoleSources(sources.map((source) => (source.file === target.file ? mutated : source)));
  assert.equal(result.ok, false, '换回裸 CREATE ROLE 后静态守卫必须判红');
  assert.ok(
    result.problems.some((problem) => problem.includes('auth_privacy.sql') && problem.includes('gengyun_auth_privacy')),
    `判红必须点名文件与角色，实际：\n${result.problems.join('\n')}`,
  );
  assert.ok(
    result.problems.some((problem) => problem.includes('不在带 pg_roles 守卫的 DO 块内')),
    `判红理由必须是「裸 CREATE ROLE 无守卫」，实际：\n${result.problems.join('\n')}`,
  );
});

test('roles/bootstrap 负控制 2：守卫里 rolname 改错一个字符 ⇒ 判红并点名文件与角色', () => {
  const target = sources.find((source) => source.file === 'egress_ledger.sql');
  assert.ok(target, '缺少 egress_ledger.sql');
  const typo = 'gengyun_egress_ledgeX';
  const mutated = { ...target, text: target.text.replace("rolname = 'gengyun_egress_ledger'", `rolname = '${typo}'`) };
  assert.notEqual(mutated.text, target.text, '负控制前置：变异没有真正生效');
  const result = auditRoleSources(sources.map((source) => (source.file === target.file ? mutated : source)));
  assert.equal(result.ok, false, '守卫名写错后静态守卫必须判红');
  assert.ok(
    result.problems.some((problem) => problem.includes('egress_ledger.sql') && problem.includes('gengyun_egress_ledger') && problem.includes('rolname')),
    `判红必须点名文件、角色与 rolname，实际：\n${result.problems.join('\n')}`,
  );
});

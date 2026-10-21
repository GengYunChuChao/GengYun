// R28-S64：`.github/workflows/deploy-sql-gate.yml` 的**两种组角色形态**静态守卫。
//
// 立项依据（`deploy/postgres-cvm/provision-db.sh:267-279`）：
//   · 默认形态  → `ROLE_GROUP_FILES` 基础 5 组（267-273 行）；
//   · CLI 形态  → 上面 5 组 + `--with-cli-groups` 才追加的 2 组（274-279 行）＝ 7 组；
//   · `services/api/db/roles/egress_ledger.sql` **两种形态都不执行**（处置见
//     `docs/verification/gy-r28-roles-file-disposition-20261021.md`：not_provisioned）。
// 这个 workflow 里必须**两个 job 各覆盖一种形态**，否则「7 组形态能不能在干净库上落地」这件事
// 没有任何 CI 跑过——S51 首轮 CI 就是在这里判红的（`runtime_function_grantee_sets`，少授
// `gengyun_source_operator`），而判它红的数据恰恰只有 7 组形态才有。
//
// 本测试**纯静态**：只读 YAML 文本做行级解析，不引 YAML 依赖（仓内没有 yaml／js-yaml），
// 不连库、不联网。它守的是「清单/顺序/双保险/无跳过」这些**结构**；真跑读数在
// `docs/verification/gy-r28-deploy-sql-gate-forms-20261021.md` 与本片报告里。
//
// 每条检查都写成「拿一段文本 → 不满足就抛 Error」的纯函数，所以同一批函数可以直接喂**改坏的夹具**
// 做内存负控制（最后一个 test）：检查必须报错，报不出错说明守卫是装饰品。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_FILE = '.github/workflows/deploy-sql-gate.yml';
const PROVISION_FILE = 'deploy/postgres-cvm/provision-db.sh';

const JOB_DEFAULT = 'deploy-sql-17-11';
const JOB_CLI7 = 'deploy-sql-17-11-cli-groups';
const NAME_DEFAULT = 'deploy-sql-17.11';
const NAME_CLI7 = 'deploy-sql-17.11-cli-groups';

const ATTR_STEP_NAME = '90-assert-least-privilege.sql（末行 ok 且退出码 0）';
const LOGIN_SQL = 'deploy/postgres-cvm/sql/20-login-roles.sql';
const ASSERT_SQL = 'deploy/postgres-cvm/sql/90-assert-least-privilege.sql';
const CLI_GROUP_FILES = ['source_operator.sql', 'staging_importer.sql'];

/** 放宽跳过的构造：出现即等于「没通过就说通过」。 */
const SOFT_FAILURE_PATTERNS = [
  ['`continue-on-error` 真值', /continue-on-error\s*:\s*(?:true|yes|on)\b/i],
  ['`|| true`', /\|\|\s*true\b/],
  ['`set +e`', /(?:^|[\s;&|])set\s+\+e\b/],
  ['`if: always()`', /if\s*:\s*always\s*\(\s*\)/i],
  ['`if: success() || failure()`', /if\s*:\s*success\s*\(\s*\)\s*\|\|\s*failure\s*\(\s*\)/i]
];

function readRepoText(file) {
  return readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

/** 取一个 job 块（含 job 头那一行，到下一个 2 空格 job 头或文件尾为止）。 */
function jobBlockOf(source, jobId) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start < 0) throw new Error(`workflow 里找不到 job：${jobId}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[^\s#][^:]*:\s*$/.test(lines[index]) || /^[^\s]/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** job 块里的 `name:` 值。 */
function jobNameOf(job) {
  const match = /^ {4}name:\s*(\S.*?)\s*$/m.exec(job);
  if (!match) throw new Error('job 块里没有 4 空格缩进的 `name:`');
  return match[1];
}

/** 按 `- name:` 取单个 step 块（含该 name 行到下一个同级或更浅的 step 为止）。 */
function stepByName(job, stepName) {
  const lines = job.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`job 里找不到 step：${stepName}`);
  const indent = lines[start].length - lines[start].trimStart().length;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const lineIndent = lines[index].length - lines[index].trimStart().length;
    if (trimmed !== '' && lineIndent <= indent) break;
    body.push(lines[index]);
  }
  return [lines[start], ...body].join('\n');
}

/** 角色文件清单：解析 step 里 `for f in \` … `; do` 那段显式文件名。 */
function roleFilesOf(job) {
  const lines = job.split('\n');
  const start = lines.findIndex((line) => /^ *for f in \\\s*$/.test(line));
  if (start < 0) throw new Error('step 里找不到 `for f in \\` 的角色文件循环');
  const files = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    let text = lines[index].trim();
    const isDo = /;\s*do\s*$/.test(text);
    text = text.replace(/;\s*do\s*$/, '').replace(/\\\s*$/, '').trim();
    if (text !== '') {
      if (!/^[A-Za-z0-9_.-]+\.sql$/.test(text)) {
        throw new Error(`角色清单里出现非 .sql 条目：${text}`);
      }
      files.push(text);
    }
    if (isDo) break;
  }
  if (files.length === 0) throw new Error('角色清单为空');
  return files;
}

/** 从 provision-db.sh 里读出两种形态的真实清单（不抄数字，直接读脚本）。 */
function provisionRoleListsOf(source) {
  const lines = source.split('\n');
  const collect = (anchor) => {
    const start = lines.findIndex((line) => line.trim() === anchor);
    if (start < 0) throw new Error(`provision-db.sh 里找不到：${anchor}`);
    const files = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const match = /^\s*'gengyun_[a-z0-9_]+:([A-Za-z0-9_.-]+\.sql)'\s*$/.exec(lines[index]);
      if (!match) {
        if (lines[index].trim() === ')') break;
        throw new Error(`provision-db.sh 的 ${anchor} 段第 ${index + 1} 行不是预期的条目：${lines[index]}`);
      }
      files.push(match[1]);
    }
    if (files.length === 0) throw new Error(`provision-db.sh 的 ${anchor} 段没解析出任何文件`);
    return files;
  };
  return {
    base: collect('ROLE_GROUP_FILES=('),
    extra: collect('ROLE_GROUP_FILES+=(')
  };
}

// -------------------------------------------------------------------------------------------------
// 检查函数（不满足即抛）
// -------------------------------------------------------------------------------------------------

function checkTwoJobs(source) {
  assertJobNamed(source, JOB_DEFAULT, NAME_DEFAULT);
  assertJobNamed(source, JOB_CLI7, NAME_CLI7);
}

function assertJobNamed(source, jobId, name) {
  const job = jobBlockOf(source, jobId);
  const actual = jobNameOf(job);
  if (actual !== name) throw new Error(`job ${jobId} 的 name 是「${actual}」，期望「${name}」`);
}

/** 两个 job 的角色清单必须分别等于 provision-db.sh 的两种形态。 */
function checkRoleLists(source, provisionSource) {
  const { base, extra } = provisionRoleListsOf(provisionSource);
  if (base.length !== 5) throw new Error(`provision-db.sh 基础组应为 5 个，实为 ${base.length} 个`);
  if (extra.length !== 2) throw new Error(`provision-db.sh 的 CLI 追加组应为 2 个，实为 ${extra.length} 个`);

  const defaultFiles = roleFilesOf(jobBlockOf(source, JOB_DEFAULT));
  if (defaultFiles.join('|') !== base.join('|')) {
    throw new Error(`默认 job 的角色清单与 provision-db.sh 基础 5 组（同序）不一致：${defaultFiles.join(', ')} ≠ ${base.join(', ')}`);
  }

  const cliFiles = roleFilesOf(jobBlockOf(source, JOB_CLI7));
  const expected = [...base, ...extra];
  if (cliFiles.join('|') !== expected.join('|')) {
    throw new Error(`CLI job 的角色清单必须是基础 5 组 + CLI 2 组（同序）：${cliFiles.join(', ')} ≠ ${expected.join(', ')}`);
  }
  if (cliFiles.length !== 7) throw new Error(`CLI job 的角色清单应为 7 个，实为 ${cliFiles.length} 个`);
  if (cliFiles.includes('egress_ledger.sql')) throw new Error('CLI job 竟然 apply 了 egress_ledger.sql：两种形态都不执行它');
  for (const file of CLI_GROUP_FILES) {
    if (!cliFiles.includes(file)) throw new Error(`CLI job 少了 --with-cli-groups 追加的 ${file}`);
  }
}

/** 两个 job 都必须「跑 20-login + 跑 90-assert」，且断言步做「退出码 + 末行」双保险。 */
function checkDoubleInsurance(source) {
  for (const jobId of [JOB_DEFAULT, JOB_CLI7]) {
    const job = jobBlockOf(source, jobId);
    const whole = job;

    if (!whole.includes(LOGIN_SQL)) throw new Error(`job ${jobId} 没有跑 ${LOGIN_SQL}`);
    if (!/psql -X -q -v ON_ERROR_STOP=1 -f deploy\/postgres-cvm\/sql\/20-login-roles\.sql/.test(whole)) {
      throw new Error(`job ${jobId} 的 20-login-roles.sql 不是「ON_ERROR_STOP=1 + 直接 -f」的形态`);
    }
    const password = /GENGYUN_API_RUNTIME_PASSWORD:\s*([0-9a-f]+)/.exec(whole);
    if (!password) throw new Error(`job ${jobId} 没有给 20-login-roles.sql 传 GENGYUN_API_RUNTIME_PASSWORD`);
    if (!/^[0-9a-f]{48}$/.test(password[1])) {
      throw new Error(`job ${jobId} 的运行时口令不是 48 位小写十六进制（20-login-roles.sql 会直接判红）`);
    }

    const attrStep = stepByName(job, ATTR_STEP_NAME);
    if (!attrStep.includes(ASSERT_SQL)) throw new Error(`job ${jobId} 的断言步没有跑 ${ASSERT_SQL}`);
    if (!attrStep.includes("-v ON_ERROR_STOP=1")) throw new Error(`job ${jobId} 的断言步缺 ON_ERROR_STOP=1`);

    // 末行一半：与 provision-db.sh:365 的 `sed … | tail -n1` 等价的取末行构造。
    if (!attrStep.includes("awk 'NF { last = $0 } END { print last }'")) {
      throw new Error(`job ${jobId} 的断言步没有「取最后一个非空行」的 awk 构造`);
    }
    if (!attrStep.includes('[ "${verdict}" != "ok" ]')) {
      throw new Error(`job ${jobId} 的断言步没有判「末行必须是 ok」`);
    }
    // 退出码一半。
    if (!attrStep.includes('[ "${rc}" -ne 0 ]')) {
      throw new Error(`job ${jobId} 的断言步没有判「psql 退出码必须是 0」`);
    }
    const errors = (attrStep.match(/echo "::error::/g) || []).length;
    const exits = (attrStep.match(/^ *exit 1$/gm) || []).length;
    if (errors < 2) throw new Error(`job ${jobId} 的断言步只有 ${errors} 条 ::error::（两半各要一条）`);
    if (exits !== errors) throw new Error(`job ${jobId} 的断言步 ::error::=${errors} 但 exit 1=${exits}（报错必须真的结束整轮）`);
  }
}

/** 两个 job 都不许出现放宽跳过构造（注释行不算：注释里正是在写「不许用」）。 */
function checkNoSoftFailures(source) {
  for (const jobId of [JOB_DEFAULT, JOB_CLI7]) {
    const job = jobBlockOf(source, jobId);
    const active = job
      .split('\n')
      .map((line) => ({ line, comment: /^\s*#/.test(line) }))
      .filter((entry) => !entry.comment && entry.line.trim() !== '');
    for (const [label, pattern] of SOFT_FAILURE_PATTERNS) {
      for (const entry of active) {
        if (pattern.test(entry.line)) throw new Error(`job ${jobId} 出现放宽跳过构造 ${label}：${entry.line.trim()}`);
      }
    }
    const errorContinue = /continue-on-error\s*:/i;
    for (const entry of active) {
      if (errorContinue.test(entry.line)) throw new Error(`job ${jobId} 出现 continue-on-error：${entry.line.trim()}`);
    }
  }
}

/** 注释不许再自称「3 组」，且 egress_ledger 出现处必须与「不执行」同句。 */
function checkWording(source) {
  if (/(?:^|[^0-9])3\s*组/m.test(source)) throw new Error('文件里仍把 --with-cli-groups 的追加组数写成「3 组」');
  if (/三组/.test(source)) throw new Error('文件里仍用「三组」指代 --with-cli-groups 的追加组');

  const lines = source.split('\n');
  let flagLineNamesBoth = false;
  lines.forEach((line, index) => {
    if (!line.includes('--with-cli-groups')) return;
    const names = line.match(/[A-Za-z0-9_]+\.sql/g) || [];
    for (const name of names) {
      if (!CLI_GROUP_FILES.includes(name)) {
        throw new Error(`第 ${index + 1} 行在 --with-cli-groups 的同一句里提到了非 CLI 组文件 ${name}`);
      }
    }
    if (CLI_GROUP_FILES.every((name) => names.includes(name))) flagLineNamesBoth = true;
    if (names.includes('egress_ledger.sql')) {
      throw new Error(`第 ${index + 1} 行把 egress_ledger.sql 与 --with-cli-groups 写在一起（它两种形态都不执行）`);
    }
  });
  if (!flagLineNamesBoth) {
    throw new Error('文件里没有任何一处把 --with-cli-groups 说清是追加 source_operator.sql + staging_importer.sql 这 2 份');
  }

  lines.forEach((line, index) => {
    if (!line.includes('egress_ledger.sql')) return;
    if (!/不执行|未执行|不 apply|从不|never/i.test(line)) {
      throw new Error(`第 ${index + 1} 行提到 egress_ledger.sql 但没同句说明它不执行：${line.trim()}`);
    }
  });
}

/** 迁移末位不许写死数字（以 migrations 目录实际最大号为准）。 */
function checkNoHardcodedMigrationTail(source) {
  const hardcoded = /0001\.{2,3}0\d{3}/.exec(source);
  if (hardcoded) throw new Error(`文件里写死了迁移末位：${hardcoded[0]}`);
  if (!source.includes('services/api/db/migrations/')) {
    throw new Error('文件里没有「以 services/api/db/migrations/ 实际最大号为准」的口径');
  }
}

/** 第二个 job 必须与第一个 job 平行：无 needs、独立 service、同样的 runner 与超时。 */
function checkParallelJobs(source) {
  const job = jobBlockOf(source, JOB_CLI7);
  if (/^ {4}needs:/m.test(job)) throw new Error('CLI job 依赖了别的 job（应为平行、互不依赖）');
  for (const needle of [
    'runs-on: ubuntu-24.04',
    'timeout-minutes: 15',
    'image: postgres:17.11',
    "ports: ['5432:5432']",
    'POSTGRES_DB: gengyun',
    'POSTGRES_USER: gengyun_cvm_owner',
    '--health-cmd pg_isready'
  ]) {
    if (!job.includes(needle)) throw new Error(`CLI job 缺「${needle}」（应与第一个 job 同形）`);
  }
  // 两个 job 都得有自己的 service，而不是共用。
  const defaultJob = jobBlockOf(source, JOB_DEFAULT);
  if (!defaultJob.includes('image: postgres:17.11')) throw new Error('默认 job 的 service 不是 postgres:17.11');
}

// -------------------------------------------------------------------------------------------------
// 正控制：拿仓库里真实的两个文件跑
// -------------------------------------------------------------------------------------------------

const workflow = readRepoText(WORKFLOW_FILE);
const provision = readRepoText(PROVISION_FILE);

test('两个 job 都在，且 name 分别是 deploy-sql-17.11 与 deploy-sql-17.11-cli-groups', () => {
  checkTwoJobs(workflow);
});

test('第一个 job 的组文件清单 = provision-db.sh 基础 5 组，顺序逐字一致', () => {
  const { base } = provisionRoleListsOf(provision);
  assert.equal(base.length, 5);
  assert.deepEqual(roleFilesOf(jobBlockOf(workflow, JOB_DEFAULT)), base);
});

test('第二个 job 的组文件清单 = 基础 5 组 + --with-cli-groups 的 2 组，共 7 份且顺序固定', () => {
  const { base, extra } = provisionRoleListsOf(provision);
  const files = roleFilesOf(jobBlockOf(workflow, JOB_CLI7));
  assert.deepEqual(files, [...base, ...extra]);
  assert.equal(files.length, 7);
  assert.deepEqual(files.slice(-2), CLI_GROUP_FILES);
  assert.ok(!files.includes('egress_ledger.sql'), '两种形态都不执行 egress_ledger.sql');
});

test('两个 job 都跑 20-login-roles.sql 与 90-assert，且断言步做「退出码 + 末行」双保险', () => {
  checkDoubleInsurance(workflow);
});

test('两个 job 全文都没有 continue-on-error／|| true／set +e／if：always() 这类放宽跳过构造', () => {
  checkNoSoftFailures(workflow);
});

test('注释不再自称「3 组」，egress_ledger.sql 出现处与「不执行」同句', () => {
  checkWording(workflow);
});

test('迁移末位不写死数字，只指向 services/api/db/migrations/ 的实际最大号', () => {
  checkNoHardcodedMigrationTail(workflow);
});

test('第二个 job 与第一个 job 平行：无 needs、各自的 17.11 service、同样的 runner 与超时', () => {
  checkParallelJobs(workflow);
});

// -------------------------------------------------------------------------------------------------
// 负控制：把夹具改坏 ⇒ 上面同一批检查函数必须报错（报不出错就说明守卫是装饰品）
// -------------------------------------------------------------------------------------------------

test('负控制：故意改坏 workflow 夹具，8 条检查必须各自判红', () => {
  const mutations = [
    {
      label: 'CLI job 少 apply 一份（7→6）',
      mutate: (text) => text.replace(/^ {12}source_operator\.sql \\\n/m, ''),
      check: (text) => checkRoleLists(text, provision),
      expect: /必须是基础 5 组 \+ CLI 2 组/
    },
    {
      label: 'CLI job 把 source_operator.sql 换成 egress_ledger.sql',
      mutate: (text) => text.replace(/^ {12}source_operator\.sql \\$/m, '            egress_ledger.sql \\'),
      check: (text) => checkRoleLists(text, provision),
      expect: /必须是基础 5 组 \+ CLI 2 组|egress_ledger/
    },
    {
      label: '断言步删掉一条 ::error::',
      mutate: (text) => text.replace(/^ *echo "::error::90-assert 的 psql 退出码[^\n]*\n/m, ''),
      check: (text) => checkDoubleInsurance(text),
      expect: /::error::/
    },
    {
      label: '断言步删掉「末行必须是 ok」这一半',
      mutate: (text) => text.replace(/^ *if \[ "\$\{verdict\}" != "ok" \]; then$/m, '          if false; then'),
      check: (text) => checkDoubleInsurance(text),
      expect: /末行必须是 ok/
    },
    {
      label: 'CLI job 塞进 continue-on-error: true',
      mutate: (text) => text.replace(/^( {6}- name: 组角色（7 组)/m, '        continue-on-error: true\n$1'),
      check: (text) => checkNoSoftFailures(text),
      expect: /continue-on-error/
    },
    {
      label: '注释把追加组数写回「3 组」',
      mutate: (text) => text.replace('的 2 份', '的 3 组'),
      check: (text) => checkWording(text),
      expect: /3 组/
    },
    {
      label: '注释把 egress_ledger.sql 写成会执行',
      mutate: (text) => text.replace('两种形态都**不执行**（`provision-db.sh` 从不 apply 它；', '两种形态都会执行（`provision-db.sh` 会 apply 它；'),
      check: (text) => checkWording(text),
      expect: /没同句说明它不执行/
    },
    {
      label: '迁移末位写死成 0001..0025',
      mutate: (text) => text.replace('0001..当前末位', '0001..0025'),
      check: (text) => checkNoHardcodedMigrationTail(text),
      expect: /写死了迁移末位/
    }
  ];

  for (const { label, mutate, check, expect } of mutations) {
    const mutated = mutate(workflow);
    assert.notEqual(mutated, workflow, `负控制「${label}」的改写没有命中任何文本，夹具已过期`);
    assert.throws(() => check(mutated), expect, `负控制「${label}」没有被判红`);
  }
});

test('负控制：provision-db.sh 夹具被改坏时，清单来源本身必须先报错', () => {
  const broken = provision.replace("  'gengyun_source_operator:source_operator.sql'\n", '');
  assert.notEqual(broken, provision);
  const { base, extra } = provisionRoleListsOf(broken);
  assert.deepEqual(base.length, 5);
  assert.equal(extra.length, 1, '读脚本的口径变了：这份夹具的 CLI 追加组不是 2 个了');
  assert.throws(() => checkRoleLists(workflow, broken), /CLI 追加组应为 2 个|必须是基础 5 组 \+ CLI 2 组/);

  assert.throws(() => provisionRoleListsOf(provision.replace('ROLE_GROUP_FILES+=(', 'ROLE_GROUP_FILES2=(')), /找不到：ROLE_GROUP_FILES\+=\(/);
});

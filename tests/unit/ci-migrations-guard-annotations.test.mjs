/**
 * R68-D12 · 迁移守卫的「软档告警」必须是**可机检**的落点，而不是一行沉在日志里的文本。
 *
 * 背景：`.github/workflows/migrations-guard.yml` 的判决步刻意跑**非 strict**（撞号等硬档必须拦，
 * 回滚/缺号这类软档项先只告警）。原来的问题是：软档 findings 只以 `WARN[...]` 纯文本打印 ——
 * 既不失败，也不会出现在 PR 的 Annotations 面板，等于「告警」只对点开 job 日志的人存在。
 *
 * 修法（选 (a)：WARN ⇒ GitHub 注解，保持非 strict 不失败）。本文件钉住三件事：
 *   ① workflow 的判决步真的带 `--annotations`（删掉即红：注解会静默消失，而且没人会发现）；
 *   ② `--annotations` 只加注解、**不改退出码**（软档仍然退出 0 —— 否则等于偷偷切了 strict）；
 *   ③ 注解只覆盖软档项、且 `--json` 的纯 JSON 契约不受影响（`--json` 优先，注解被吞掉）。
 *
 * ⚠ 为什么用显式开关而不是嗅 `GITHUB_ACTIONS`：GitHub 把该变量注入**整个 job**，连本 job 里
 * 跑单测那一步也带着它 —— 夹具产生的软档 WARN 会混进单测 stdout。**实测（2026-10-28 复核）**：
 * 只有当工具侧同时去掉 `!json` 门时 `--json` 契约才真的被破坏（本文件 27 pass / 4 fail）；
 * 保留 `!json` 门时 30 pass / 1 fail（红的是「不加开关就该 0 条 `::`」那条自证）。两件都要。
 * 显式开关还额外换来一个好处：**「CI 到底接没接注解」变成 workflow 文本里可机检的一行**。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAnnotations, verifyMigrations } from '../../tools/verify-migrations-unique.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'verify-migrations-unique.mjs');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'migrations-guard.yml');

const FIXTURES = [];
after(() => {
  for (const dir of FIXTURES) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该改变判据结论。
    }
  }
});

/**
 * 夹具：两条正向迁移 + 各自 down，缺号 0101 且目录下**没有** `.md` ⇒ 正好制造「无依据缺号」
 * 这一条软档 finding（其余判据全绿）。编号从 0100 起，避开 `NO_ROLLBACK` 登记的 0001。
 */
function makeSoftWarningFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gy-r68-annotations-'));
  FIXTURES.push(dir);
  mkdirSync(join(dir, 'rollback'));
  for (const name of ['0100_annotations_a.sql', '0102_annotations_b.sql']) {
    writeFileSync(join(dir, name), '-- fixture\n', 'utf8');
    writeFileSync(join(dir, 'rollback', name.replace(/\.sql$/, '.down.sql')), '-- fixture\n', 'utf8');
  }
  return dir;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 取出 `run:` 里调 verify-migrations-unique 的那些命令（按出现顺序）。 */
function toolCommands(text) {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*run:\s*(node tools\/verify-migrations-unique\.mjs.*)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1].trim());
}

test('D12 落点①：migrations-guard.yml 的判决步带 `--annotations`，且仍是非 strict', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const commands = toolCommands(text);
  assert.ok(commands.length >= 2, `判决步与 --json 快照步都该在位，实测只找到 ${commands.length} 条：${JSON.stringify(commands)}`);

  const judge = commands.filter((command) => !command.includes('--json'));
  assert.equal(judge.length, 1, `应当恰有一个判决步（不带 --json），实测：${JSON.stringify(judge)}`);
  assert.match(
    judge[0],
    /--annotations\b/,
    `判决步必须带 --annotations，否则软档 WARN 又退回「只在日志里」的纯文本；实测：${judge[0]}`,
  );
  assert.doesNotMatch(judge[0], /--strict\b/, `本 job 刻意跑非 strict（软档项不判红）；实测：${judge[0]}`);

  // 注解不是放宽：这些词一个都不许出现在**代码行**里（注释里出现是说明文字，不算放宽；
  // 把注释也扫进来会让「本 job 不用 continue-on-error」这句说明自己把用例弄红）。
  const code = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /continue-on-error/, '不得用 continue-on-error 把失败伪装成通过');
  assert.doesNotMatch(code, /\|\|\s*true/, '不得用 `|| true` 吞掉失败');
});

test('D12 落点②：`--annotations` 只加注解、不改退出码，且 `--json` 的纯 JSON 契约不受影响', () => {
  const dir = makeSoftWarningFixture();
  const expected = verifyMigrations({ migrationsDir: dir, strict: false });
  const softCount = expected.rollbackIssues.length
    + expected.details.gapDocumentation.filter((gap) => !gap.documented).length;
  assert.ok(softCount > 0, '夹具必须制造出至少一条软档项（否则这条用例是空转）');
  assert.equal(expected.ok, true, '夹具在非 strict 下应当是绿的（软档不判错）');

  const withFlag = runCli(['--dir', dir, '--annotations']);
  assert.equal(withFlag.status, 0, `非 strict + 软档 ⇒ 退出码必须仍是 0；实测 ${withFlag.status}\n${withFlag.stdout}`);
  const annotations = withFlag.stdout.split(/\r?\n/).filter((line) => line.startsWith('::warning '));
  assert.ok(annotations.length > 0, `--annotations 必须产出 ::warning 注解；实测 stdout：\n${withFlag.stdout}`);
  for (const line of annotations) {
    assert.match(line, /^::warning title=[^:]+::\S/, `注解形态不对（应为 ::warning title=<标题>::<正文>）：${line}`);
  }
  // 文本读数与注解**同时**在：注解是增量，不是替换（人读日志的习惯不该被剥夺）。
  assert.match(withFlag.stdout, /WARN\[gap\]/, '纯文本 WARN 读数必须保留，注解是叠加而非替换');

  // 不加开关时一条注解都不许有（否则「显式开关」就是摆设）。
  const withoutFlag = runCli(['--dir', dir]);
  assert.equal(withoutFlag.status, 0);
  assert.equal(
    withoutFlag.stdout.split(/\r?\n/).filter((line) => line.startsWith('::')).length,
    0,
    '不加 --annotations 时不得出现任何 workflow command 行',
  );

  // `--json` 优先：同时带 --annotations 时 stdout 仍必须是可直接 JSON.parse 的纯 JSON。
  const json = runCli(['--dir', dir, '--json', '--annotations']);
  assert.equal(json.status, 0);
  assert.doesNotThrow(
    () => JSON.parse(json.stdout),
    `--json 时 stdout 必须是纯 JSON（注解被吞掉是刻意的）；实测：\n${json.stdout.slice(0, 400)}`,
  );
});

test('D12 落点③：注解只覆盖软档项，且逐条对应 finding（不吞、不重复）', () => {
  const dir = makeSoftWarningFixture();
  const result = verifyMigrations({ migrationsDir: dir, strict: false });
  const annotations = renderAnnotations(result);

  const undocumented = result.details.gapDocumentation.filter((gap) => !gap.documented);
  assert.equal(
    annotations.length,
    result.rollbackIssues.length + (undocumented.length > 0 ? 1 : 0),
    `注解条数应为「回滚问题逐条 + 无依据缺号合并一条」，实测 ${annotations.length} 条：${JSON.stringify(annotations)}`,
  );
  for (const gap of undocumented) {
    assert.ok(
      annotations.some((line) => line.includes(gap.number)),
      `缺号 ${gap.number} 必须被注解点名：${JSON.stringify(annotations)}`,
    );
  }

  // 转义：注解正文里的换行/百分号必须被转义，否则 GitHub 会把一条注解截成两行、丢掉后半段。
  const synthetic = {
    rollbackIssues: [{ id: 'rollback', message: '第一行 100% 缺 down\n第二行' }],
    details: { gapDocumentation: [] },
  };
  const [line] = renderAnnotations(synthetic);
  assert.ok(line.includes('%0A'), `换行必须转义成 %0A：${line}`);
  assert.ok(line.includes('100%25'), `% 必须转义成 %25：${line}`);
  assert.equal(line.split('\n').length, 1, '一条 finding 只能占一行（换行不转义会截断注解）');
});

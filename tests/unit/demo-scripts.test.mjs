/**
 * 根 `package.json` 的演示脚本契约：7 条 `demo:*` 必须存在、必须是**单条 node 调用**、必须指向真文件。
 *
 * 为什么要专门一条用例：`npm run` 的脚本最容易在「换了工具文件名」之后静默变成死链——CI 不跑它，
 * 人只在演示前一分钟才发现 `Error: Cannot find module`。这里把三件事一次性钉死：
 * 1. **存在**：七条名字一个都不能少（快速开始文档按名字写，缺一条文档就是错的）；
 * 2. **单条 node 调用**：值形如 `node tools/<file>.mjs [子命令]`，不含 `&&`、`|`、`;`、重定向——
 *    这类 shell 语法在 PowerShell / cmd / sh 里行为不一致，演示脚本不能靠「碰巧能跑」；
 * 3. **指向真文件**：把命令里点名的 `tools/**.mjs` 全部拿去看 `existsSync`，并对根 `package.json`
 *    里**所有** `node tools/…` 脚本做同样的检查（不只这七条）——「脚本指向已删除文件」不该只防一半。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_JSON = join(ROOT, 'package.json');

/** 七条演示脚本：名字 → 期望点名的工具文件（值里必须出现它）。 */
const EXPECTED = Object.freeze({
  'demo:env-up': 'tools/demo-env.mjs',
  'demo:up': 'tools/demo-stack.mjs',
  'demo:down': 'tools/demo-stack.mjs',
  'demo:status': 'tools/demo-stack.mjs',
  'demo:logs': 'tools/demo-stack.mjs',
  'demo:reset': 'tools/demo-stack.mjs',
  'demo:project': 'tools/prepare-wechat.mjs',
});

/** 各脚本应有的子命令（`demo:env-up` 是工具本身，没有子命令）。 */
const EXPECTED_SUBCOMMANDS = Object.freeze({
  'demo:env-up': null,
  'demo:up': 'up',
  'demo:down': 'down',
  'demo:status': 'status',
  'demo:logs': 'logs',
  'demo:reset': 'reset',
  'demo:project': 'local',
});

/** 在 Windows 上 `node tools\demo-env.mjs` 也能跑，但仓库口径一直是正斜杠——统一按 `/` 判。 */
function readScripts() {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).scripts ?? {};
}

test('package.json：七条 demo:* 脚本都在，且都点名了预期的工具文件', () => {
  const scripts = readScripts();
  for (const [name, tool] of Object.entries(EXPECTED)) {
    assert.ok(typeof scripts[name] === 'string', `缺脚本 ${name}`);
    assert.ok(scripts[name].includes(tool), `${name} 应点名 ${tool}，实际「${scripts[name]}」`);
  }
});

test('package.json：七条 demo:* 脚本都是单条 node 调用（不带 shell 语法）', () => {
  const scripts = readScripts();
  const shellSyntax = /&&|\|\||[;|>]/u;
  for (const name of Object.keys(EXPECTED)) {
    const command = scripts[name];
    assert.doesNotMatch(command, shellSyntax, `${name} 里有 shell 语法（跨 shell 行为不一致）：「${command}」`);
    const parts = command.trim().split(/\s+/u);
    assert.equal(parts[0], 'node', `${name} 必须以 node 开头，实际「${command}」`);
    assert.match(parts[1], /^tools\/[\w.-]+\.mjs$/u, `${name} 的第二个词应是 tools/<file>.mjs，实际「${parts[1]}」`);
    assert.ok(!parts.slice(2).some((part) => part.startsWith('--')), `${name} 不该把选项写死在脚本里（用「--」透传）：「${command}」`);
  }
});

test('package.json：各 demo:* 脚本的子命令与工具约定一致', () => {
  const scripts = readScripts();
  for (const [name, subcommand] of Object.entries(EXPECTED_SUBCOMMANDS)) {
    const parts = scripts[name].trim().split(/\s+/u);
    const actual = parts[2] ?? null;
    assert.equal(actual, subcommand, `${name} 的子命令应为 ${subcommand ?? '（无）'}，实际 ${actual ?? '（无）'}`);
  }
});

test('package.json：脚本点名的 tools 文件真实存在（防「脚本指向已删除文件」）', () => {
  const scripts = readScripts();
  const missing = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const match of command.matchAll(/tools\/[\w.-]+\.mjs/gu)) {
      const target = join(ROOT, match[0]);
      if (!existsSync(target)) missing.push(`${name} → ${match[0]}`);
    }
  }
  assert.deepEqual(missing, [], `这些脚本指向了不存在的文件：\n${missing.join('\n')}`);
});

test('package.json：demo:env-up 就是 demo-env 工具本身（没有子命令，-- 之后原样透传）', () => {
  const scripts = readScripts();
  assert.equal(scripts['demo:env-up'], 'node tools/demo-env.mjs');
});

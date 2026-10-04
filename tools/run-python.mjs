/**
 * 跨平台运行 Python 校验脚本（仅用标准库）。
 * 依次尝试 $PYTHON、python3、python，找到可用解释器后执行传入脚本。
 * 用途：npm run test:docs 在 Windows 与 Ubuntu CI 上都能运行既有文档检查。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptArgs = process.argv.slice(2);

if (scriptArgs.length === 0) {
  console.error('用法：node tools/run-python.mjs <script.py> [args...]');
  process.exit(2);
}

const candidates = [process.env.PYTHON, 'python3', 'python'].filter((value) => typeof value === 'string' && value !== '');

let lastError = '未找到可用的 Python 解释器（尝试 $PYTHON / python3 / python）。';
for (const python of candidates) {
  const probe = spawnSync(python, ['-V'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    lastError = `无法运行 ${python}：${probe.stderr ?? probe.error?.message ?? ''}`;
    continue;
  }
  const result = spawnSync(python, scriptArgs, { cwd: root, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

console.error(lastError);
process.exit(1);

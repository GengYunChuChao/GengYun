/**
 * 静态检查（npm run lint）。
 *
 * 行为：
 *  1) 对 services/api 与 apps/admin 运行 TypeScript 类型检查（tsc --noEmit）。
 *  2) 仓库卫生扫描：禁止关闭 TLS 校验的写法与疑似硬编码密钥进入受版本管理源码。
 *
 * 任一失败即以非 0 退出。本脚本是静态检查，不代表运行期行为已通过。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function runTsc(tsconfig) {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    failures.push(`未找到本地 TypeScript（node_modules/typescript/bin/tsc）；请先运行 npm install。目标：${tsconfig}`);
    return;
  }
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, tsconfig), '--noEmit'], {
    encoding: 'utf8',
    cwd: root,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    failures.push(`类型检查失败：${tsconfig}\n${output}`);
    return;
  }
  console.log(`PASS tsc --noEmit ${tsconfig}`);
}

runTsc('services/api/tsconfig.json');
runTsc('apps/admin/tsconfig.json');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.local', '.supervisor', '__pycache__']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.sqlite', '.db']);
const FORBIDDEN = [
  { pattern: /strict-ssl\s*=\s*false/i, label: '关闭 strict-ssl' },
  { pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, label: '禁用 TLS 证书校验' },
  { pattern: /rejectUnauthorized\s*:\s*false/, label: 'rejectUnauthorized=false' },
  { pattern: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, label: '内嵌私钥' },
  { pattern: /(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/, label: '疑似硬编码密钥' },
];

function walk(dir, hits) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.env') && entry.name !== '.env.example') {
      hits.push({ file: join(dir, entry.name), label: '提交了真实 .env（应保持忽略）' });
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, hits);
      continue;
    }
    const dot = entry.name.lastIndexOf('.');
    const ext = dot === -1 ? '' : entry.name.slice(dot).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    if (statSync(full).size > 512 * 1024) continue;
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(text)) hits.push({ file: full, label: rule.label });
    }
  }
}

const hits = [];
walk(root, hits);
if (hits.length > 0) {
  for (const hit of hits) failures.push(`卫生扫描命中「${hit.label}」：${relative(root, hit.file)}`);
} else {
  console.log('PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）');
}

if (failures.length > 0) {
  console.error('\n静态检查未通过：');
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('lint 通过（静态检查；不代表运行期或真实服务已通过）。');

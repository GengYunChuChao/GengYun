/**
 * GY-I24 交付材料索引 · 离线核验门禁（**只做离线文档核验，不部署、不连云、不连库**）。
 *
 * 运行：`node tools/verify-release-materials.mjs`（退出码 0 = 全部通过；1 = 有失败项）。
 *
 * 核验对象是**文档与仓库事实**，不是运行环境：
 *   1. 索引存在且覆盖 `deploy/**` 全部在册文件（不漏、不列不存在的路径）；
 *   2. 索引里的相对链接都能解析、被索引文件都非空；
 *   3. 5 个 CVM 脚本：`bash -n` 语法、`set -euo pipefail`、**提交内容（blob）为 LF**；
 *   4. 云托管环境变量模板 ⊇ 配置面（`REQUIRED_WHEN_REAL` ∪ config.ts 实际读取的键），且无多余键；
 *   5. Dockerfile 的 Node 版本与根 `package.json` 的 `engines.node` 一致；
 *   6. `/health` 路由存在（云托管 README 的最小验收依据）；
 *   7. 回滚 down 脚本覆盖 0002..N（无 0001）、`migrate.ts` 命令闭集为 up|status|list。
 *
 * ⚠️ **为什么 LF 必须查 blob 而不是工作区**：本机 `core.autocrlf=true`，签出到工作区的是 CRLF，
 *    对 `deploy` 下的 `.sh` 逐个 `grep -lU $'\r'` 会 5/5 误报（2026-10-17 实测踩过）；
 *    `git cat-file blob` 给出提交内容，`git ls-files --eol` 的 `i/` 列同理。CI/Linux 签出的是
 *    blob 内容，所以判据必须是 blob。
 *
 * 本工具**不**核验（留给运行期/云端，均不在本片范围）：Docker 构建、云托管控制台操作、
 * 目标 CVM 上的真实执行、PITR/异地备份、真实供应商调用。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = 'docs/verification/gy-i24-release-materials-index-20261017.md';
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok !== true) failed += 1;
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p) => existsSync(join(ROOT, p));

/** git 在册文件列表（子命令失败则抛错，绝不静默跳过）。 */
function gitFiles(prefix) {
  const out = execFileSync('git', ['ls-files', prefix], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * `bash -n` 语法检查：把**提交内容（blob）**喂给 bash 的 stdin，**不传文件路径**。
 *
 * 为什么不传路径（监工在 WSL 下实测 5/5「找不到文件」后定位）：Windows 上 `bash` 至少有三种
 * 化身——MSYS/Cygwin（吃 `D:\…`）、WSL（只吃 `/mnt/d/…`）、Linux CI（吃 `/…`）。
 * 传 `join(ROOT, script)` 出来的 Windows 路径给后两种必失败；`cygpath`/`wslpath` 探测又脆。
 * 喂 stdin 与路径解释完全无关，且顺带解决两个一致性问题：
 *   ① 与 LF 判据同源——检查的是 **blob**（CI/Linux 看到的内容），不是工作区
 *      （`core.autocrlf=true` 下工作区是 CRLF，可能造成与线上无关的假红）；
 *   ② 不依赖任何路径转换工具。
 */
function bashSyntaxError(script) {
  const content = execFileSync('git', ['cat-file', 'blob', `HEAD:${script}`], {
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  try {
    execFileSync('bash', ['-n'], { input: content });
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return 'bash 不可用（PATH 上没有 bash）：无法执行语法检查';
    return String(error.stderr || error.message).split('\n')[0];
  }
}

/** 提交内容（blob）里的 CR 字节数；工作区在 autocrlf 下不可用作判据（见文件头）。 */
function blobCrBytes(path) {
  const buf = execFileSync('git', ['cat-file', 'blob', `HEAD:${path}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  let count = 0;
  for (const byte of buf) if (byte === 0x0d) count += 1;
  return count;
}

try {
  // ---------------------------------------------------------------- 1. 索引存在
  check('索引文档存在', exists(INDEX), INDEX);
  if (!exists(INDEX)) throw new Error('索引缺失，后续检查无法进行');
  const indexText = read(INDEX);

  // ---------------------------------------------------------------- 2. 覆盖 deploy/**
  const deployFiles = gitFiles('deploy');
  // 覆盖判据取「带 ✅ 的索引表行」：散落散文提及不算索引（防"提了一句即算收录"）。
  const verifiedRows = indexText.split('\n').filter((line) => line.trim().startsWith('|') && line.includes('✅'));
  const missing = deployFiles.filter((p) => !verifiedRows.some((row) => row.includes(p)));
  check('索引覆盖 deploy/ 全部在册文件', missing.length === 0,
    missing.length === 0 ? `${deployFiles.length} 个文件全部在索引表行中` : `未索引：${missing.join(', ')}`);

  // 索引里出现的 deploy 路径（反引号字面量或链接目标，允许 `../../` 前缀）必须真实存在；
  // glob 写法（含 *）是行文，不是路径。
  const rawDeployPaths = [
    ...[...indexText.matchAll(/`((?:\.\.\/)*(?:deploy\/)[^`]+)`/g)].map((m) => m[1]),
    ...[...indexText.matchAll(/\]\(((?:\.\.\/)*(?:deploy\/)[^)]+)\)/g)].map((m) => m[1].split('#')[0]),
  ];
  const indexedDeployPaths = [...new Set(rawDeployPaths)]
    .map((p) => p.replace(/[。，、）)]+$/, '').replace(/^(?:\.\.\/)+/, ''))
    .filter((p) => p !== '' && !p.includes('*'));
  const dangling = indexedDeployPaths.filter((p) => !exists(p));
  check('索引列出的 deploy 路径全部存在', dangling.length === 0,
    dangling.length === 0 ? `${indexedDeployPaths.length} 条路径全部存在` : `不存在：${dangling.join(', ')}`);

  // ---------------------------------------------------------------- 3. 链接与非空
  const indexDir = dirname(join(ROOT, INDEX));
  const links = [...indexText.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])
    .filter((t) => !/^[a-z]+:|^#/.test(t));
  const brokenLinks = [];
  for (const target of links) {
    const [pathPart] = target.split('#');
    if (pathPart === '') continue;
    if (!existsSync(resolve(indexDir, pathPart))) brokenLinks.push(target);
  }
  check('索引相对链接全部可解析', brokenLinks.length === 0,
    brokenLinks.length === 0 ? `${links.length} 个链接全部可解析` : `坏链接：${brokenLinks.join(', ')}`);

  const emptyFiles = indexedDeployPaths.filter((p) => {
    try { return statSync(join(ROOT, p)).size === 0; } catch { return true; }
  });
  check('被索引文件全部非空', emptyFiles.length === 0,
    emptyFiles.length === 0 ? '无非空文件' : `空文件：${emptyFiles.join(', ')}`);

  // ---------------------------------------------------------------- 4. 脚本三件套
  const scripts = gitFiles('deploy').filter((p) => p.endsWith('.sh'));
  const syntaxBad = [];
  for (const script of scripts) {
    const problem = bashSyntaxError(script);
    if (problem !== null) syntaxBad.push(`${script}: ${problem}`);
  }
  check('CVM 脚本 bash -n 语法通过（blob 喂 stdin，不传路径）', syntaxBad.length === 0,
    syntaxBad.length === 0 ? `${scripts.length} 个脚本全部通过` : syntaxBad.join('；'));

  const noPipefail = scripts.filter((s) => !read(s).includes('set -euo pipefail'));
  check('CVM 脚本均设 set -euo pipefail', noPipefail.length === 0,
    noPipefail.length === 0 ? `${scripts.length} 个脚本全部设置` : `未设置：${noPipefail.join(', ')}`);

  const crlfBlobs = scripts.filter((s) => blobCrBytes(s) > 0);
  check('CVM 脚本提交内容为 LF（blob 判据）', crlfBlobs.length === 0,
    crlfBlobs.length === 0 ? `${scripts.length} 个脚本 blob 均无 CR` : `blob 含 CR：${crlfBlobs.join(', ')}`);

  // ---------------------------------------------------------------- 5. 环境变量模板 ⊇ 配置面
  const placeholder = JSON.parse(read('deploy/cloudrun/env.placeholder.json'));
  const placeholderKeys = Object.keys(placeholder).sort();
  let requiredWhenReal = [];
  let readKeys = [];
  try {
    const mod = await import('./../services/api/src/config.ts');
    requiredWhenReal = [...mod.REQUIRED_WHEN_REAL];
  } catch {
    // 老 Node 无类型剥离时的正则兜底（口径与数组字面量一致）
    const block = /export const REQUIRED_WHEN_REAL = \[([\s\S]*?)\] as const/.exec(read('services/api/src/config.ts'));
    requiredWhenReal = block ? [...block[1].matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1]) : [];
  }
  const configSource = read('services/api/src/config.ts');
  readKeys = [...new Set([...configSource.matchAll(/trimmed\(env,\s*'([A-Z_0-9]+)'\)/g)].map((m) => m[1]))];
  const surface = [...new Set([...requiredWhenReal, ...readKeys])].sort();
  const notCovered = surface.filter((k) => !placeholderKeys.includes(k));
  const extraKeys = placeholderKeys.filter((k) => !surface.includes(k));
  check('环境变量模板覆盖配置面', notCovered.length === 0,
    notCovered.length === 0 ? `模板 ${placeholderKeys.length} 键 ⊇ 配置面 ${surface.length} 键` : `未覆盖：${notCovered.join(', ')}`);
  check('环境变量模板无多余键', extraKeys.length === 0,
    extraKeys.length === 0 ? '无多余键' : `多余：${extraKeys.join(', ')}`);
  const secretishWithValue = Object.entries(placeholder).filter(([k, v]) => /SECRET|PASSWORD|KEY/.test(k) && typeof v === 'string' && v !== '');
  check('模板中机密类键均为空值', secretishWithValue.length === 0,
    secretishWithValue.length === 0 ? '机密类键全部为空值' : `非空：${secretishWithValue.map(([k]) => k).join(', ')}`);

  // ---------------------------------------------------------------- 6. Dockerfile Node 版本
  const dockerfile = read('deploy/cloudrun/Dockerfile');
  const imageMatch = /FROM node:(\d+)\.(\d+)\.(\d+)-/.exec(dockerfile);
  const engines = /"node":\s*">=(\d+)\.(\d+)\.(\d+)\s*<(\d+)"/.exec(read('package.json'));
  check('Dockerfile Node 版本与 engines 一致',
    imageMatch !== null && engines !== null &&
      imageMatch[1] === engines[1] && imageMatch[2] === engines[2] && imageMatch[3] === engines[3],
    imageMatch && engines ? `镜像 node:${imageMatch[1]}.${imageMatch[2]}.${imageMatch[3]} ↔ engines >=${engines[1]}.${engines[2]}.${engines[3]} <${engines[4]}` : '未解析到版本');

  // ---------------------------------------------------------------- 7. /health 路由
  const healthSource = read('services/api/src/routes/health.ts');
  check('/health 路由存在（云托管最小验收依据）',
    /app\.get\('\/health'/.test(healthSource) && /execution_mode/.test(healthSource) && /checks/.test(healthSource),
    'routes/health.ts 注册 /health 且响应含 checks/meta.execution_mode');

  // ---------------------------------------------------------------- 8. 回滚 down 覆盖
  const migrations = readdirSync(join(ROOT, 'services/api/db/migrations'))
    .map((n) => /^(\d{4})_.*\.sql$/.exec(n)).filter(Boolean).map((m) => m[1]).sort();
  const downs = readdirSync(join(ROOT, 'services/api/db/migrations/rollback'))
    .map((n) => /^(\d{4})_.*\.down\.sql$/.exec(n)).filter(Boolean).map((m) => m[1]).sort();
  const expectedDowns = migrations.filter((n) => n !== '0001');
  const downsMatch = expectedDowns.length === downs.length && expectedDowns.every((n, i) => n === downs[i]);
  check('回滚 down 脚本覆盖 0002..N 且无 0001', downsMatch && !downs.includes('0001'),
    downsMatch ? `迁移 ${migrations.length} 个（${migrations[0]}..${migrations[migrations.length - 1]}），down ${downs.length} 个（${downs[0]}..${downs[downs.length - 1]}），无 0001` :
      `期望 down ${expectedDowns.join(',')}，实际 ${downs.join(',')}`);
  check('migrate.ts 命令闭集为 up|status|list',
    /未知命令：\$\{command\}\（支持 up \| status \| list\）/.test(read('services/api/src/db/migrate.ts')),
    'migrate.ts 含封闭命令集报错');

  // ---------------------------------------------------------------- 汇总
  console.log(`\n${results.length - failed}/${results.length} 项通过（离线文档核验；不代表部署、云端或运行期已验收）`);
  if (failed > 0) process.exitCode = 1;
} catch (error) {
  console.error('FAIL 工具自身异常: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
}

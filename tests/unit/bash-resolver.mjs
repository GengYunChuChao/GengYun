/**
 * 本机 bash 解析器（**不是测试文件**：文件名不以 `.test.mjs` 结尾，不会被
 * `node --test "tests/unit/*.test.mjs"` 收集执行，口径同 `admin-fixtures.mjs`）。
 *
 * 为什么需要它：`tools/verify-release-materials.mjs` 要用 `bash -n` 校验
 * `deploy/postgres-cvm/*.sh`，而 `bash` 是**从调用者 PATH** 里解析的。Windows 上
 * `C:\Windows\System32\bash.exe` 与 WindowsApps 里的 `bash.exe` 都是 **WSL 存根**：
 * 跑起来只打印「wsl: 检测到 localhost 代理配置，但未镜像到 WSL…」并返回 1，于是
 * `release-materials-index*.test.mjs` 的 8 条用例在本机恒红——红的不是代码，是「bash 到底是哪一个」。
 * 依赖调用者的 PATH 是脆弱设计（换一台机器就换一种红法），所以这里把它显式化：
 *
 *   1. 按 `GY_BASH` → `D:\Git\bin\bash.exe` → `C:\Program Files\Git\bin\bash.exe` → PATH(`bash`)
 *      的顺序逐个试；
 *   2. 每个候选**先实测** `bash -c "echo ok"`：退出码 0 且输出含 `ok` 才算可用；
 *   3. WSL 存根按**输出**判定（`wsl:`、`localhost 代理`，或 UTF-16 解码后同时含 `localhost` 与 `WSL`），
 *      不看文件名/路径——存根会伪装成 `bash.exe`；
 *   4. 一个都不可用 ⇒ 调用方显式 skip 并打印可操作提示（含 `GY_BASH` 用法）：
 *      ⛔ 不静默 pass（等于把校验关掉），⛔ 也不保留「恒红」（红得没人再信）。
 *
 * 校验强度不变：命中真 bash 后仍由门禁工具原样跑 `bash -n`（本文件只负责让子进程里的
 * `bash` 命中真 bash——把它的目录前置进子进程 PATH，**不改门禁工具源码**，否则
 * `release-materials-index.test.mjs` 里钉住「`bash -n` 只吃 stdin 不吃路径」的断言会失效）。
 */
import { spawnSync } from 'node:child_process';
import { basename, delimiter, dirname, isAbsolute } from 'node:path';

/** Git for Windows 的 bash（本机实测可用；`where bash` 命中的是 WSL 存根）。 */
export const GIT_BASH_CANDIDATE = 'D:\\Git\\bin\\bash.exe';
/** Git for Windows 的默认安装位置。 */
export const GIT_BASH_PROGRAM_FILES = 'C:\\Program Files\\Git\\bin\\bash.exe';

/** 实测探针：`bash -c "echo ok"`（不带文件路径，避免再踩 WSL 路径解释分歧）。 */
export const PROBE_ARGS = ['-c', 'echo ok'];

/** 无可用 bash 时的可操作提示（skip 时原样打印，含 `GY_BASH` 用法）。 */
export const BASH_HINT_LINES = [
  '本机没有可用 bash：`deploy/**/*.sh` 的 `bash -n` 语法校验无法执行，相关用例按环境缺失 skip（**不是通过**）。',
  '常见原因：`bash` 落到了 WSL 存根（`C:\\Windows\\System32\\bash.exe`），它只会打印「wsl: 检测到 localhost 代理配置…」并返回 1。',
  '指路（PowerShell）：`$env:GY_BASH=\'D:\\Git\\bin\\bash.exe\'; npm run test:unit`',
  '指路（cmd）：`set GY_BASH=D:\\Git\\bin\\bash.exe && npm run test:unit`',
  '`GY_BASH` 必须指向真正的 MSYS/Git bash（或 Linux 上的 `bash`），指向存根同样会被判为不可用。',
];

/** 候选顺序里的「兜底」：前两个是 Git for Windows 的常见位置，最后才是 PATH。 */
export function bashCandidates() {
  return [GIT_BASH_CANDIDATE, GIT_BASH_PROGRAM_FILES, 'bash'];
}

/**
 * 探针输出归一：WSL 存根把中文按 UTF-16LE 写到 stderr，按 utf8 读会夹一堆 NUL
 * （实测字节 `77 00 73 00 6c 00 3a 00`）。去掉 NUL 后 `wsl:` / `localhost` 这些 ASCII 标记仍可读。
 */
export function normalizeProbeOutput(result = {}) {
  const asText = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''));
  return `${asText(result.stdout)}\n${asText(result.stderr)}`
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/** 输出里指向 WSL 存根的证据；没有则返回 null。三条判据见文件头第 3 条。 */
export function wslStubEvidence(text) {
  const value = String(text ?? '').replace(/\u0000/g, '');
  if (/(?:^|\W)wsl:/i.test(value)) return 'wsl:';
  if (/localhost\s*代理/.test(value)) return 'localhost 代理';
  if (/localhost/i.test(value) && /WSL/.test(value)) return 'localhost + WSL';
  return null;
}

/** 探针结果 → `{ usable, reason }`。纯函数：不启动任何进程，便于单测注入假读数。 */
export function classifyBashProbe(result = {}) {
  const text = normalizeProbeOutput(result);
  const firstLine = (text.split('\n')[0] ?? '').slice(0, 200);
  const tail = firstLine === '' ? '(无输出)' : firstLine;
  if (result.errorCode) return { usable: false, reason: `无法启动（${result.errorCode}）` };
  const wsl = wslStubEvidence(text);
  if (wsl !== null) return { usable: false, reason: `WSL 存根：输出含「${wsl}」，不是 MSYS/Git bash` };
  if (result.status !== 0) return { usable: false, reason: `退出码 ${result.status}：${tail}` };
  if (!/ok/i.test(text)) return { usable: false, reason: `\`-c "echo ok"\` 输出不含 ok：${tail}` };
  return { usable: true, reason: 'ok' };
}

/**
 * 实测一个候选。`.cmd`/`.bat` 桩（单测里造的假 bash）在 Node 24 上必须经 shell 启动，
 * 否则 `spawn` 直接 EINVAL（CVE-2024-27980 之后不再隐式走 cmd.exe）；真 bash 走直连，不经过 shell。
 */
export function probeBash(file, { env } = {}) {
  const options = { encoding: 'utf8', timeout: 30000, windowsHide: true, ...(env === undefined ? {} : { env }) };
  const result = /\.(?:cmd|bat)$/i.test(file)
    ? spawnSync(`"${file}" ${PROBE_ARGS.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
      { ...options, shell: true })
    : spawnSync(file, PROBE_ARGS, options);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, errorCode: result.error?.code };
}

/**
 * 按顺序解析出一个**实测可用**的 bash。
 *
 * `GY_BASH` 永远排第一（即使调用方传了别的 `candidates`），这是本文件的契约：
 * 显式指路的优先级高于任何默认猜测。
 *
 * @returns {{ available: boolean, path: string|null, attempts: Array<{candidate: string, usable: boolean, reason: string}>, hint: string }}
 */
export function resolveBash({ env = process.env, candidates = bashCandidates(env), probe = probeBash } = {}) {
  const explicit = String(env.GY_BASH ?? '').trim();
  const ordered = [...new Set([explicit, ...candidates].filter((value) => typeof value === 'string' && value.trim() !== ''))];
  const attempts = [];
  for (const candidate of ordered) {
    const verdict = classifyBashProbe(probe(candidate));
    attempts.push({ candidate, usable: verdict.usable, reason: verdict.reason });
    if (verdict.usable) return { available: true, path: candidate, attempts, hint: '' };
  }
  const tried = attempts.map((a) => `${a.candidate}（${a.reason}）`).join('；');
  return {
    available: false,
    path: null,
    attempts,
    hint: `${BASH_HINT_LINES.join('\n')}\n已尝试：${tried}`,
  };
}

/**
 * 让**子进程**里的 `bash` 命中解析到的真 bash：把它的目录前置进子进程 PATH。
 *
 * 为什么不是「直接调用解析到的路径」：门禁工具源码里写的就是 `execFileSync('bash', ['-n'], …)`
 * （`release-materials-index.test.mjs` 把这条形态钉死了：`bash -n` 只吃 stdin、不吃文件路径）。
 * 改工具源码会连带改那条断言；前置 PATH 既不动工具、又让「bash 是哪一个」由本文件显式决定。
 *
 * ⚠️ 目标可执行文件必须叫 `bash(.exe)`：门禁按名字 `bash` 找它，名字不对就找不到（此时宁可不跑）。
 */
export function bashFirstEnv(bashPath, baseEnv = process.env) {
  const name = basename(bashPath);
  if (!/^bash(?:\.exe)?$/i.test(name)) {
    return {
      ok: false,
      reason: `解析到的 bash 文件名是 \`${name}\`，而门禁按名字 \`bash\` 调用它；请把 GY_BASH 指到名为 \`bash\`/\`bash.exe\` 的可执行文件（当前：${bashPath}）`,
    };
  }
  // 经 PATH 兜底命中（候选就是 `bash`）时不需要注入：它本来就能被找到。
  if (!isAbsolute(bashPath)) return { ok: true, env: { ...baseEnv } };
  const env = {};
  let currentPath = '';
  for (const [key, value] of Object.entries(baseEnv)) {
    if (/^path$/i.test(key)) {
      if (currentPath === '') currentPath = String(value ?? '');
      continue;                                   // Windows 上 PATH 键名可能是 `Path`，统一改写成 `PATH`
    }
    env[key] = value;
  }
  env.PATH = [dirname(bashPath), currentPath].filter((part) => part !== '').join(delimiter);
  return { ok: true, env };
}

/**
 * 测试文件唯一入口：解析 bash + 准备子进程环境。
 * `available === false` 时调用方必须**显式 skip**（并把 `hint` 打进诊断），不得 return 了事。
 */
export function resolveGateBash(options = {}) {
  const resolution = resolveBash(options);
  if (!resolution.available) return { ...resolution, env: null, bashPath: null };
  const wrapped = bashFirstEnv(resolution.path, options.env ?? process.env);
  if (!wrapped.ok) {
    return { available: false, path: null, bashPath: null, env: null, attempts: resolution.attempts, hint: `${wrapped.reason}\n${BASH_HINT_LINES.join('\n')}` };
  }
  return { ...resolution, bashPath: resolution.path, env: wrapped.env };
}

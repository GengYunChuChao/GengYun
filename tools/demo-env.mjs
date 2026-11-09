#!/usr/bin/env node
/**
 * 耕云演示环境：把仓库外的私密凭据（JSONC）翻译成 `tools/demo-stack.mjs --env-file` 能吃的 env 文件。
 *
 * 为什么需要这一步工具（此前是每台机器手工抄一遍）：
 * 1. **抄错没人发现**。`real` 模式要 9 个真键（微信 2 + 对象存储 4 + 两把签名钥匙 + DATABASE_URL），
 *    再加上识别与媒体两族可选键一共 13 项；手抄错一个名字，只会等到 `up` 第三步才炸，而那时的
 *    报错只说「缺键」，指不到是抄漏还是抄错。
 * 2. **抄的过程会把值带进终端滚动区**。屏幕/聊天记录里出现过的密钥收不回来，所以本工具的值只往
 *    文件里走：stdout 只出现「键名 / 键数 / 路径 / 哪些键是生成的」。
 * 3. **`MEDIA_OBJECT_REF_KEY` 凭据里通常没有**，得现场生成 32 字节随机 hex；忘了它就等于让媒体域
 *    整域 503。生成是确定性的活，不该由人记得。
 *
 * 三条硬边界（都有单测，见 `tests/unit/demo-env.test.mjs`）：
 * - **只读 `--from`**：凭据文件是唯一真相，本工具一个字节都不往回写（改坏它比少一个键严重得多）。
 * - **`--out` 必须在仓库外**：落在仓库里的 env 文件迟早被 `git add` 进去；连 `--out` 等于 `--from`
 *   都拒绝（那是在覆盖凭据本身）。
 * - **默认拒绝覆盖**：env 文件里的 `MEDIA_OBJECT_REF_KEY` 加密过旧库里的媒体对象，覆盖换钥匙 ⇒
 *   旧对象解不开。所以要 `--force`，并且覆盖时优先沿用旧文件里的同一把钥匙。
 *
 * 打印纪律：**任何值都不进 stdout/stderr**，连 `JSON.parse` 的报错原文都不打——它的 message 自带
 * 一段输入摘要（`Unexpected token ... "xxxx" ...`），那等于把凭据抄进日志。解析失败只报「第 N 行附近」。
 *
 * 用法与退出码见 `usage()`；运行手册见 docs/demo/快速开始.md。
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根：由本文件位置推出（`tools/` → `..`），⛔ 不用 `process.cwd()`——`--out` 的仓库内外判定必须与在哪敲命令无关。 */
export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 退出码：0 成功；1 用法/路径/覆盖策略；2 凭据不可用（读不出、解析不了、缺键）。 */
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, CREDENTIALS: 2 });

/** 识别剖面：DeepSeek 的 OpenAI 兼容端点。三处固定值来自 API 侧口径（`services/api/src/app.ts` 直读 `process.env`）。 */
export const RECOGNITION_URL = 'https://api.deepseek.com/v1/chat/completions';
export const RECOGNITION_PROFILE = 'openai-vision-v1';
export const RECOGNITION_MODEL = 'deepseek-flash';

/** 媒体对象引用钥匙的生成口径：32 字节随机 → 64 位十六进制（API 侧三种合法形态之一）。 */
export const MEDIA_KEY_BYTES = 32;
export const MEDIA_KEY_HEX = /^[0-9a-f]{64}$/u;

/**
 * 源键 → env 名。`from` 里前面的写法优先：先试嵌套（任务口径 `objectStorage.Endpoint`），
 * 再试扁平（本机真实凭据文件 2026-11-09 实测是 `objectStorageEndpoint`）。
 * 两种都认，是因为凭据文件不是本仓库的东西，格式由持有者决定——工具要么两种都吃，要么就报缺键。
 */
export const ENV_SPECS = Object.freeze([
  { env: 'WECHAT_APP_ID', from: ['appid'], section: 'wechat' },
  { env: 'WECHAT_APP_SECRET', from: ['appsecret'], section: 'wechat' },
  {
    env: 'OBJECT_STORAGE_ENDPOINT',
    from: ['objectStorage.Endpoint', 'objectStorage.endpoint', 'objectStorageEndpoint'],
    section: 'storage',
  },
  {
    env: 'OBJECT_STORAGE_BUCKET',
    from: ['objectStorage.Bucket', 'objectStorage.bucket', 'objectStorageBucket'],
    section: 'storage',
  },
  {
    env: 'OBJECT_STORAGE_ACCESS_KEY',
    from: ['objectStorage.AccessKey', 'objectStorage.accessKey', 'objectStorageAccessKey'],
    section: 'storage',
  },
  {
    env: 'OBJECT_STORAGE_SECRET_KEY',
    from: ['objectStorage.SecretKey', 'objectStorage.secretKey', 'objectStorageSecretKey'],
    section: 'storage',
  },
  { env: 'SESSION_SIGNING_KEY', from: ['sessionSigningKey'], section: 'signing' },
  { env: 'DELETION_LEDGER_KEY', from: ['deletionLedgerKey'], section: 'signing' },
  { env: 'RECOGNITION_PROVIDER_URL', fixed: RECOGNITION_URL, section: 'recognition' },
  { env: 'RECOGNITION_PROVIDER_KEY', from: ['deepseekApiKey'], section: 'recognition' },
  { env: 'RECOGNITION_PROVIDER_PROFILE', fixed: RECOGNITION_PROFILE, section: 'recognition' },
  { env: 'RECOGNITION_PROVIDER_MODEL', fixed: RECOGNITION_MODEL, section: 'recognition' },
  {
    env: 'MEDIA_OBJECT_REF_KEY',
    from: ['mediaObjectRefKey', 'mediaObjectRef'],
    generated: true,
    section: 'media',
  },
]);

/** 写进 env 文件的分节标题（只是注释，读文件的人靠它认得出这一坨是干什么的）。 */
const SECTION_TITLES = Object.freeze({
  wechat: '—— 微信小程序（真实凭据；值不打印）——',
  storage: '—— 对象存储（六要素里的四项）——',
  signing: '—— 会话 / 注销账本签名钥匙（本机演示用；生产必须是另一套）——',
  recognition: '—— 识别（OpenAI 兼容剖面；端点与剖面是固定值）——',
  media: '—— 媒体对象引用加密钥匙（本机演示用，见下方注释）——',
});

/** 媒体钥匙的注释说明：只有「本机演示用」与「换了会怎样」两件事，不写值。 */
const MEDIA_KEY_COMMENT = Object.freeze([
  '# 本机演示用：凭据文件里没有这一项，由 node tools/demo-env.mjs 生成 32 字节随机 hex（64 位）。',
  '# 它只加密「本机演示库」里的媒体对象引用；换掉它，旧库里已加密的对象就解不开（解密失败），',
  '# 所以 --force 覆盖时会优先沿用旧输出文件里的同一把。生产环境必须单独生成并进密钥管理，不得复用。',
]);

/** 用法错误与「凭据不可用」分开：前者不改任何文件，后者连读都没成功。 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** JSONC 解析失败：只带行号，不带原文（原文里可能有值）。 */
export class JsoncError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'JsoncError';
    this.line = line;
  }
}

/**
 * 剥掉 JSONC 的 `//` 与 `/* *\/` 注释、去掉尾逗号，得到 `JSON.parse` 能吃的文本。
 *
 * 为什么不能直接正则 `//.*$`：值里就有 `//`——`databaseUrl` 是 `postgres://…`，粗暴截断会把
 * 整条连接串砍成 `postgres:`，然后「缺键」报到另一个地方去。所以这里按字符走一遍：
 * 字符串内部原样复制（含转义），只在字符串外认注释与逗号。
 */
export function stripJsonc(text) {
  const source = String(text ?? '').replace(/^\uFEFF/u, '');
  let out = '';
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index];
    if (char === '"') {
      out += char;
      index += 1;
      while (index < length) {
        const inner = source[index];
        if (inner === '\\') {
          out += inner + (source[index + 1] ?? '');
          index += 2;
          continue;
        }
        out += inner;
        index += 1;
        if (inner === '"' || inner === '\n') break;
      }
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        // 块注释里的换行要留着：行号是错误定位的唯一线索。
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '}' || char === ']') {
      // 尾逗号：只在字符串外收敛（`{"a":"x,}"}` 里的 `,}` 必须原样留着）。
      out = out.replace(/,\s*$/u, '');
    }
    out += char;
    index += 1;
  }
  return out;
}

/** 行号：`JSON.parse` 的 position 换算成 1 基行号。⛔ 不把原文片段带进任何 message。 */
function lineOfPosition(text, position) {
  if (!Number.isInteger(position) || position <= 0) return 1;
  let line = 1;
  for (let index = 0; index < Math.min(position, text.length); index += 1) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

/** 解析 JSONC 文本；失败抛 `JsoncError`（只带行号与一句结论）。 */
export function parseJsonc(text) {
  const stripped = stripJsonc(text);
  try {
    const parsed = JSON.parse(stripped);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new JsoncError('凭据文件的顶层必须是 JSON 对象', 1);
    }
    return parsed;
  } catch (error) {
    if (error instanceof JsoncError) throw error;
    const message = String(error?.message ?? '');
    const positionMatch = /position (\d+)/u.exec(message);
    const lineMatch = /line (\d+)/u.exec(message);
    const line = positionMatch ? lineOfPosition(stripped, Number(positionMatch[1])) : lineMatch ? Number(lineMatch[1]) : 1;
    throw new JsoncError('凭据文件不是合法 JSONC（注释、尾逗号可以，其它语法错误不行）', line);
  }
}

/**
 * 把凭据文件字节解成文本：先按 UTF-8 严格解，失败再退 GBK。
 *
 * 为什么两种都留：本机 2026-11-09 实测的 `credentials.local.json` 是 UTF-8；但 `docs/demo/本地演示-stack.md`
 * 早期版本记录过「注释是 GBK」的历史文件。凭据文件在仓库外、可能被别处拷来，只认一种就会在
 * 「文件明明在那儿」的情况下报「读不出」。两种都试，报错时只说「编码不认识」，不打印任何内容。
 */
export function decodeCredentialText(bytes) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('gbk', { fatal: true }).decode(bytes), encoding: 'gbk' };
    } catch {
      throw new JsoncError('凭据文件既不是合法 UTF-8 也不是 GBK；本工具不猜编码', 1);
    }
  }
}

/** 按 `a.b.c` 取嵌套键；取不到返回 `undefined`（不抛错——缺键由调用方统一收集）。 */
function readPath(source, path) {
  let cursor = source;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** 从候选写法里取第一个「非空字符串」；数字/布尔/对象都不算（env 文件里只能放字符串）。 */
export function chooseValue(source, paths) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** 从旧输出文件里捞 `MEDIA_OBJECT_REF_KEY`（只认本工具写出的 64 位 hex，别的一律不认，宁可再生）。 */
export function readExistingMediaKey(outPath) {
  try {
    const text = readFileSync(outPath, 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^MEDIA_OBJECT_REF_KEY\s*=\s*([0-9a-fA-F]{64})\s*$/u.exec(line.trim());
      if (match) return match[1].toLowerCase();
    }
  } catch {
    // 读不到就当没有：覆盖场景下最坏结果是重新生成一把新钥匙，而不是让命令失败。
  }
  return undefined;
}

/**
 * 组装 env 键值对（顺序 = `ENV_SPECS` 顺序，输出文件因此稳定、可 diff）。
 * `generated` 里逐条写明哪个键是生成的、是不是沿用旧文件的那把。
 */
export function collectEnv(source, options = {}) {
  const previousMediaKey = options.previousMediaKey ?? null;
  const values = [];
  const generated = [];
  const missing = [];
  for (const spec of ENV_SPECS) {
    if (typeof spec.fixed === 'string') {
      values.push({ env: spec.env, value: spec.fixed, section: spec.section });
      continue;
    }
    const found = chooseValue(source, spec.from ?? []);
    if (found !== undefined) {
      values.push({ env: spec.env, value: found, section: spec.section });
      continue;
    }
    if (spec.generated) {
      const reused = typeof previousMediaKey === 'string' && MEDIA_KEY_HEX.test(previousMediaKey);
      values.push({
        env: spec.env,
        value: reused ? previousMediaKey : randomBytes(MEDIA_KEY_BYTES).toString('hex'),
        section: spec.section,
      });
      generated.push({ env: spec.env, reused });
      continue;
    }
    missing.push({ env: spec.env, from: spec.from ?? [] });
  }
  return { values, generated, missing };
}

/**
 * 写文件前先挑出「写下去就会变意思」的值：换行会把一行拆成两行；含空白/`#` 又要加引号、可引号里
 * 再嵌引号会被 `readEnvFile` 剥错。两种情况都**只报键名、不报值**，宁可失败也不悄悄改语义。
 */
export function encodingProblems(values) {
  const problems = [];
  for (const row of values) {
    if (/[\r\n]/u.test(row.value)) {
      problems.push({ env: row.env, reason: '值里有换行，写进 env 文件会被拆成两行' });
      continue;
    }
    if (/[\s#]/u.test(row.value) && /["']/u.test(row.value)) {
      problems.push({ env: row.env, reason: '值里有空白或 #（需要加引号），同时又含引号，会被 readEnvFile 剥错' });
    }
  }
  return problems;
}

/**
 * 值里有空白或 `#` 时加双引号：`tools/lib/demo-stack.mjs` 的 `readEnvFile` 会剥掉成对引号。
 * 走到这里时 `encodingProblems` 已经保证「需要加引号的值里不含引号」，所以不必再转义——
 * 转义反而是错的：`readEnvFile` 不反转义，`\"` 会原样留在值里。
 */
function quoteValue(value) {
  return /[\s#]/u.test(value) ? `"${value}"` : value;
}

/** 渲染 env 文件全文；`generated` 只影响注释文案，不影响值。 */
export function renderEnvFile({ values, generated, sourcePath, encoding, stamp }) {
  const generatedByEnv = new Map(generated.map((row) => [row.env, row]));
  const lines = [
    '# 耕云本机演示栈 env 文件（由 node tools/demo-env.mjs 生成；⚠ 不要提交、不要贴到聊天里）',
    `# 来源：${sourcePath}（${encoding}；只读，本工具没有改动它）`,
    `# 生成时间：${stamp}`,
    '# 用法：npm run demo:up -- --demo --seed-demo --env-file <本文件>',
    '',
  ];
  let section = null;
  for (const row of values) {
    if (row.section !== section) {
      section = row.section;
      if (lines.at(-1) !== '') lines.push('');
      lines.push(`# ${SECTION_TITLES[section] ?? section}`);
    }
    if (row.env === 'MEDIA_OBJECT_REF_KEY') lines.push(...MEDIA_KEY_COMMENT);
    const meta = generatedByEnv.get(row.env);
    if (meta && !meta.reused) lines.push('# 本次新生成（旧输出文件里没有可沿用的同一把钥匙）。');
    lines.push(`${row.env}=${quoteValue(row.value)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** `child` 是否落在 `parent` 里（含等于）；大小写不敏感，只为 Windows 上的人为路径大小写差异。 */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return true;
  const normalized = process.platform === 'win32' ? rel.toLowerCase() : rel;
  return !normalized.startsWith('..') && !isAbsolute(rel) && !normalized.startsWith(`..${sep}`);
}

/** 一行一行的用法说明；`--help` 打这个，出错时也只打这个（不带任何值）。 */
export function usageLines() {
  return [
    '用法：node tools/demo-env.mjs --from <credentials.local.json> --out <env 文件> [--force]',
    '',
    '把仓库外的私密凭据（JSONC）翻成本机演示栈能吃的 env 文件（13 个键，其中 1 个由本工具生成）。',
    '',
    '选项：',
    '  --from <绝对路径>   源凭据文件（JSONC：允许 // 与 /* */ 注释、尾逗号；UTF-8 或 GBK 都认）',
    '  --out <绝对路径>    输出 env 文件；必须在仓库目录之外',
    '  --force             允许覆盖已存在的输出文件（覆盖时优先沿用旧文件里的 MEDIA_OBJECT_REF_KEY）',
    '  --help, -h          只看用法',
    '',
    '打印纪律：屏幕上只会出现「键名 / 键数 / 路径 / 哪些键是生成的」，任何值都不打印。',
    '',
    '退出码：',
    '  0  成功',
    '  1  用法错误（缺参数、路径不是绝对路径、--out 落在仓库里、拒绝覆盖已存在文件）',
    '  2  凭据不可用（读不出、解析不了、缺关键键——只列键名）',
    '',
    '例：',
    '  node tools/demo-env.mjs --from E:\\GengYunPrivate\\credentials.local.json --out E:\\GengYunPrivate\\demo-real.env',
    '  npm run demo:up -- --demo --seed-demo --env-file E:\\GengYunPrivate\\demo-real.env',
  ];
}

/** 解析命令行；未知参数直接报错（`--force=1` 这种静默忽略最坑人）。 */
export function parseCliArgs(argv) {
  const parsed = { from: null, out: null, force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--force') {
      parsed.force = true;
      continue;
    }
    if (arg === '--from' || arg === '--out') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        throw new UsageError(`${arg} 后面缺少路径`);
      }
      parsed[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new UsageError(`未知参数「${arg}」`);
  }
  return parsed;
}

/**
 * 主流程：返回退出码（不直接 `process.exit`，单测才能在同一进程里跑多个场景）。
 * `io` 只为测试注入，默认就是 stdout/stderr。
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((line = '') => process.stdout.write(`${line}\n`));
  const warn = io.warn ?? ((line = '') => process.stderr.write(`${line}\n`));

  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    warn(`✗ ${error.message}`);
    for (const line of usageLines()) warn(line);
    return EXIT.USAGE;
  }
  if (args.help) {
    for (const line of usageLines()) log(line);
    return EXIT.OK;
  }
  if (!args.from || !args.out) {
    warn(`✗ 缺参数${args.from ? '' : ' --from'}${args.out ? '' : ' --out'}`);
    for (const line of usageLines()) warn(line);
    return EXIT.USAGE;
  }

  const fromPath = resolve(args.from);
  const outPath = resolve(args.out);
  if (!isAbsolute(args.from) || !isAbsolute(args.out)) {
    warn('✗ --from 与 --out 都必须是绝对路径（相对路径会随「在哪敲命令」漂移，不做猜测）');
    return EXIT.USAGE;
  }
  if (isInside(TOOL_ROOT, outPath)) {
    warn(`✗ --out 落在仓库目录里：${outPath}`);
    warn(`  仓库根：${TOOL_ROOT}`);
    warn('  落在仓库里的 env 文件迟早被 git add 进去；请写到仓库外（例：<仓库上级>\\.pg17\\demo-real.env）');
    return EXIT.USAGE;
  }
  if (outPath === resolve(fromPath)) {
    warn('✗ --out 与 --from 是同一个文件：本工具只读凭据，绝不覆盖它');
    return EXIT.USAGE;
  }
  if (!existsSync(fromPath) || !statSync(fromPath).isFile()) {
    warn(`✗ 读不到凭据文件：${fromPath}`);
    return EXIT.CREDENTIALS;
  }
  if (existsSync(outPath)) {
    if (!statSync(outPath).isFile()) {
      warn(`✗ --out 指向的不是文件：${outPath}`);
      return EXIT.USAGE;
    }
    if (!args.force) {
      warn(`✗ 已存在：${outPath}`);
      warn('  默认不覆盖：里面可能有正在用的 MEDIA_OBJECT_REF_KEY，换掉会让旧媒体对象解不开。');
      warn('  确认要重写就加 --force（重写时会优先沿用旧文件里的同一把钥匙）。');
      return EXIT.USAGE;
    }
  }

  let decoded;
  try {
    decoded = decodeCredentialText(readFileSync(fromPath));
  } catch (error) {
    warn(`✗ 凭据文件读不出：${error.message}（不打印任何内容）`);
    return EXIT.CREDENTIALS;
  }

  let source;
  try {
    source = parseJsonc(decoded.text);
  } catch (error) {
    warn(`✗ ${error.message}；第 ${error.line} 行附近（不打印原文，原文可能含密钥）`);
    return EXIT.CREDENTIALS;
  }

  const previousMediaKey = args.force ? readExistingMediaKey(outPath) : undefined;
  const { values, generated, missing } = collectEnv(source, { previousMediaKey });

  if (missing.length > 0) {
    warn(`✗ 凭据文件缺 ${missing.length} 个键（只列名字，不打印任何值）：`);
    for (const row of missing) {
      warn(`   - ${row.env}  ←  凭据里的 ${row.from.join(' 或 ')}`);
    }
    warn('  补齐后重跑；env 名与源键的对应关系见 `node tools/demo-env.mjs --help`。');
    return EXIT.CREDENTIALS;
  }

  const problems = encodingProblems(values);
  if (problems.length > 0) {
    warn(`✗ 这些键的值没法原样写进 env 文件（只列键名，不打印值）：`);
    for (const row of problems) warn(`   - ${row.env}：${row.reason}`);
    return EXIT.CREDENTIALS;
  }

  const body = renderEnvFile({
    values,
    generated,
    sourcePath: fromPath,
    encoding: decoded.encoding,
    stamp: new Date().toISOString(),
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(outPath, 0o600);
  } catch {
    // Windows 上 chmod 基本是空操作；失败不该让已经写好的文件变成失败态。
  }

  log(`✓ 已写出 ${values.length} 个键 → ${outPath}`);
  log(`  来源：${fromPath}（${decoded.encoding}；只读，没有改动它）`);
  log(
    generated.length === 0
      ? '  生成：无（所有键都来自凭据文件）'
      : `  生成：${generated.map((row) => `${row.env}${row.reused ? '（沿用旧输出文件里的同一把）' : '（本次新生成）'}`).join('、')}`,
  );
  log('  下一步：npm run demo:up -- --demo --seed-demo --env-file <上面这个路径>');
  return EXIT.OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

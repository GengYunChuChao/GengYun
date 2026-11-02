#!/usr/bin/env node
/**
 * 耕云 · 正式环境接入清单的**离线**校验器（GY-I25 前置，凭据无关）。
 *
 * 它只回答一个问题：`config/production-provisioning.local.json` 这张清单**填全了没有、格式对不对**。
 * 不联网、不读环境变量、不调用任何供应商、不连数据库、不读写配置之外的文件、不落盘。
 * 校验通过**不等于**任何真实能力已接入：域名备案、TLS 证书、隐私声明、数据库角色、六类 AI、
 * 私有桶、日志告警与备份恢复都要各自的真实环境证据，见 `docs/ops/production-provisioning.md`。
 *
 * ## 泄密红线（结构性保证，不靠自觉）
 *
 * 输出里只出现**键名**与**问题代码**：不打印值、不打印前缀、不打印长度、不打印片段，
 * 也不打印文件路径。`JSON.parse`／读文件的异常文本一律不外传（异常消息可能带内容）。
 * 参数解析失败也不回声参数值（只回显固定的用法说明）。
 *
 * ## 问题代码
 *
 * | 代码 | 含义 |
 * | --- | --- |
 * | `MISSING_KEY` | 必填键不存在（父对象不存在时只报父键，不再逐个报子键） |
 * | `UNFILLED` | 空串、纯空白，或仍是占位符（`<...>`、`TODO`、`changeme`、`xxxx`、`请填写` 等） |
 * | `NOT_PUBLIC` | 域名/端点不是公网 `https`：非 https、带查询/片段/凭据、非法端口、带路径（仅域名类字段）、本机/私网/保留域 |
 * | `BAD_APPID` | 小程序 AppID 不匹配 `^wx[0-9a-f]{16}$` |
 * | `OUT_OF_RANGE` | 数值项不是十进制整数或超出登记区间 |
 * | `EXPECTED_TYPE` | 结构/类型不对：该是对象的地方不是对象、叶子不是字符串、根不是对象 |
 * | `UNKNOWN_KEY` | 只在模板自检模式（顶层 `"_example": true`）报：出现登记表以外的键 |
 * | `CONFIG_UNREADABLE` | 文件读不到（原因不回显） |
 * | `CONFIG_INVALID_JSON` | 不是合法 JSON（解析器文本不回显） |
 *
 * ## 两种模式
 *
 * - 普通模式：结构 + 键 + 类型 + 上述值检查，用于**填好之后**的真清单。
 * - 模板自检模式：顶层 `"_example": true` 时只校验结构、键集合与类型，
 *   不判 `UNFILLED`／`NOT_PUBLIC`／`BAD_APPID`／`OUT_OF_RANGE`，
 *   所以 `--check config/production-provisioning.local.json.example` 应得退出码 0。
 *   模板因此必须**每个值都是字符串占位符**（数值项也写成字符串，如 `"30"`）。
 *
 * ## 用法
 *
 *   node tools/verify-production-provisioning.mjs [--check <path>] [--json]
 *
 * 默认路径 `config/production-provisioning.local.json`（已被 `.gitignore` 忽略）。
 * 退出码：0 = 全部通过；1 = 有问题；2 = 用法错误。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_ISSUES = 1;
export const EXIT_USAGE = 2;

export const TOOL_NAME = 'verify-production-provisioning';

/** 默认读取的真清单；模板在同目录的 `.example` 后缀文件。 */
export const DEFAULT_CONFIG_PATH = 'config/production-provisioning.local.json';

/**
 * 字段登记表。
 *
 * `kind` 决定值检查：`text` 只要求非空非占位符；`appid`／`domain`／`endpoint`／`number` 各自加一条。
 * `domain` 只接受 `https://<host>[:443]`（无路径）；`endpoint` 允许固定路径（供应商端点常见），
 * 但同样拒绝查询串、片段、URL 内凭据与非 443 端口。
 */
export const SCHEMA = Object.freeze({
  environment: Object.freeze({ kind: 'text' }),
  wechat: Object.freeze({
    appid: Object.freeze({ kind: 'appid' }),
    appSecretEnv: Object.freeze({ kind: 'text' }),
    requestDomain: Object.freeze({ kind: 'domain' }),
    uploadFileDomain: Object.freeze({ kind: 'domain' }),
    downloadFileDomain: Object.freeze({ kind: 'domain' }),
    socketDomain: Object.freeze({ kind: 'domain' }),
    icpFilingNumber: Object.freeze({ kind: 'text' }),
    tlsMinVersion: Object.freeze({ kind: 'text' }),
    certificateExpiresOn: Object.freeze({ kind: 'text' }),
  }),
  privacy: Object.freeze({
    agreementVersion: Object.freeze({ kind: 'text' }),
    declaredInterfaces: Object.freeze({ kind: 'text' }),
    evidencePath: Object.freeze({ kind: 'text' }),
  }),
  database: Object.freeze({
    urlEnv: Object.freeze({ kind: 'text' }),
    readonlyUrlEnv: Object.freeze({ kind: 'text' }),
    poolMax: Object.freeze({ kind: 'number', min: 1, max: 100 }),
    statementTimeoutSeconds: Object.freeze({ kind: 'number', min: 1, max: 120 }),
    tlsMode: Object.freeze({ kind: 'text' }),
  }),
  providers: Object.freeze({
    weedRecognition: Object.freeze({
      vendor: Object.freeze({ kind: 'text' }),
      endpoint: Object.freeze({ kind: 'endpoint' }),
      apiKeyEnv: Object.freeze({ kind: 'text' }),
      timeoutSeconds: Object.freeze({ kind: 'number', min: 1, max: 120 }),
    }),
    ocr: Object.freeze({
      vendor: Object.freeze({ kind: 'text' }),
      endpoint: Object.freeze({ kind: 'endpoint' }),
      apiKeyEnv: Object.freeze({ kind: 'text' }),
      timeoutSeconds: Object.freeze({ kind: 'number', min: 1, max: 120 }),
    }),
    asr: Object.freeze({
      vendor: Object.freeze({ kind: 'text' }),
      endpoint: Object.freeze({ kind: 'endpoint' }),
      apiKeyEnv: Object.freeze({ kind: 'text' }),
      timeoutSeconds: Object.freeze({ kind: 'number', min: 1, max: 120 }),
    }),
    tts: Object.freeze({
      vendor: Object.freeze({ kind: 'text' }),
      endpoint: Object.freeze({ kind: 'endpoint' }),
      apiKeyEnv: Object.freeze({ kind: 'text' }),
      timeoutSeconds: Object.freeze({ kind: 'number', min: 1, max: 120 }),
    }),
    llm: Object.freeze({
      vendor: Object.freeze({ kind: 'text' }),
      endpoint: Object.freeze({ kind: 'endpoint' }),
      apiKeyEnv: Object.freeze({ kind: 'text' }),
      timeoutSeconds: Object.freeze({ kind: 'number', min: 1, max: 120 }),
    }),
    moderation: Object.freeze({
      vendor: Object.freeze({ kind: 'text' }),
      endpoint: Object.freeze({ kind: 'endpoint' }),
      imageEndpoint: Object.freeze({ kind: 'endpoint' }),
      apiKeyEnv: Object.freeze({ kind: 'text' }),
      timeoutSeconds: Object.freeze({ kind: 'number', min: 1, max: 120 }),
    }),
  }),
  storage: Object.freeze({
    endpoint: Object.freeze({ kind: 'domain' }),
    bucket: Object.freeze({ kind: 'text' }),
    accessKeyEnv: Object.freeze({ kind: 'text' }),
    secretKeyEnv: Object.freeze({ kind: 'text' }),
    signedUrlTtlSeconds: Object.freeze({ kind: 'number', min: 60, max: 3600 }),
  }),
  observability: Object.freeze({
    logEndpoint: Object.freeze({ kind: 'domain' }),
    alertEndpoint: Object.freeze({ kind: 'domain' }),
    retentionDays: Object.freeze({ kind: 'number', min: 1, max: 3650 }),
  }),
  backup: Object.freeze({
    endpoint: Object.freeze({ kind: 'domain' }),
    schedule: Object.freeze({ kind: 'text' }),
    retentionDays: Object.freeze({ kind: 'number', min: 1, max: 3650 }),
    restoreDrillDate: Object.freeze({ kind: 'text' }),
  }),
});

export const ISSUE = Object.freeze({
  MISSING_KEY: 'MISSING_KEY',
  UNFILLED: 'UNFILLED',
  NOT_PUBLIC: 'NOT_PUBLIC',
  BAD_APPID: 'BAD_APPID',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  EXPECTED_TYPE: 'EXPECTED_TYPE',
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  CONFIG_UNREADABLE: 'CONFIG_UNREADABLE',
  CONFIG_INVALID_JSON: 'CONFIG_INVALID_JSON',
});

/** 占位符口径：整个值就是 `<...>`，或包含下列任一标记（大小写不敏感）。 */
const PLACEHOLDER_PATTERNS = Object.freeze([
  /^<[^<>]*>$/,
  /todo/i,
  /changeme/i,
  /change_me/i,
  /xxxx/i,
  /replace[-_ ]?me/i,
  /请填写/,
  /待填写/,
  /待补充/,
]);

/** 明确不是公网的主机名（后缀）与本机名。 */
const LOCAL_HOSTNAMES = Object.freeze(['localhost', '::1', '0.0.0.0']);
const LOCAL_SUFFIXES = Object.freeze(['.localhost', '.local', '.test', '.internal', '.invalid']);

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

function isPrivateIPv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * 公网主机名判定（离线，只看字面量）：
 * 本机名/保留域/私网或保留 IPv4 一律不算公网；IPv6 字面量离线无法证明是公网也一律拒绝；
 * 其余要求主机名带点（单标签内网名不算）。
 */
export function isPublicHostname(rawHostname) {
  if (typeof rawHostname !== 'string') return false;
  let host = rawHostname.trim().toLowerCase();
  if (host === '') return false;
  if (host.endsWith('.')) host = host.slice(0, -1);
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (LOCAL_HOSTNAMES.includes(unbracketed)) return false;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  if (unbracketed.includes(':')) return false;
  if (/^[0-9.]+$/.test(unbracketed)) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(unbracketed) && !isPrivateIPv4(unbracketed);
  }
  return unbracketed.includes('.');
}

/**
 * URL 形态判定。
 * `allowPath: false`（域名类字段）只接受 origin；`true`（供应商端点）允许固定路径。
 * 两种都拒绝查询串、片段、URL 内凭据与非 443 端口（`new URL` 会把显式 `:443` 归一掉）。
 */
export function isPublicHttpsUrl(value, { allowPath }) {
  if (typeof value !== 'string' || value === '' || /\s/.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.search !== '' || url.hash !== '') return false;
  if (url.port !== '') return false;
  if (!allowPath && url.pathname !== '/') return false;
  return isPublicHostname(url.hostname);
}

function issueCodeForLeaf(spec, value) {
  const trimmed = value.trim();
  if (trimmed === '' || isPlaceholder(trimmed)) return ISSUE.UNFILLED;
  if (spec.kind === 'appid') return /^wx[0-9a-f]{16}$/.test(trimmed) ? null : ISSUE.BAD_APPID;
  if (spec.kind === 'domain') return isPublicHttpsUrl(trimmed, { allowPath: false }) ? null : ISSUE.NOT_PUBLIC;
  if (spec.kind === 'endpoint') return isPublicHttpsUrl(trimmed, { allowPath: true }) ? null : ISSUE.NOT_PUBLIC;
  if (spec.kind === 'number') {
    if (!/^[0-9]+$/.test(trimmed)) return ISSUE.OUT_OF_RANGE;
    const number = Number(trimmed);
    return Number.isSafeInteger(number) && number >= spec.min && number <= spec.max ? null : ISSUE.OUT_OF_RANGE;
  }
  return null;
}

function walkObject(schemaNode, actual, prefix, issues, example) {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    issues.push({ code: ISSUE.EXPECTED_TYPE, key: prefix === '' ? '<root>' : prefix });
    return;
  }
  if (example) {
    for (const key of Object.keys(actual)) {
      if (key.startsWith('_')) continue;
      if (!Object.prototype.hasOwnProperty.call(schemaNode, key)) {
        issues.push({ code: ISSUE.UNKNOWN_KEY, key: prefix === '' ? key : `${prefix}.${key}` });
      }
    }
  }
  for (const [key, spec] of Object.entries(schemaNode)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      issues.push({ code: ISSUE.MISSING_KEY, key: path });
      continue;
    }
    const value = actual[key];
    if (Object.prototype.hasOwnProperty.call(spec, 'kind')) {
      if (typeof value !== 'string') {
        issues.push({ code: ISSUE.EXPECTED_TYPE, key: path });
        continue;
      }
      if (example) continue;
      const code = issueCodeForLeaf(spec, value);
      if (code !== null) issues.push({ code, key: path });
      continue;
    }
    walkObject(spec, value, path, issues, example);
  }
}

/**
 * 纯函数：输入已解析的 JSON 值，输出按登记表顺序排列的问题列表。
 * 只回键名与代码，绝不回值。
 *
 * @param {unknown} data
 * @param {{ example?: boolean }} [options]
 * @returns {{ code: string, key: string }[]}
 */
export function checkProvisioning(data, { example = false } = {}) {
  const issues = [];
  walkObject(SCHEMA, data, '', issues, example === true);
  return issues;
}

export const USAGE = [
  '用法：node tools/verify-production-provisioning.mjs [--check <path>] [--json]',
  '',
  '  --check <path>  要检查的清单；默认 config/production-provisioning.local.json',
  '  --json          机器读（只有键名与问题代码，无值、无路径）',
  '',
  '只做离线格式检查：不联网、不调用供应商、不连数据库、不回显任何值。',
  '退出码：0＝全部通过｜1＝有问题｜2＝用法错误。',
].join('\n');

/**
 * 参数解析（纯函数）：支持 `--check <path>` 与 `--check=<path>`；未知参数只报固定文案，不回显参数值。
 */
export function parseCliArgs(argv = []) {
  const parsed = { check: DEFAULT_CONFIG_PATH, json: false, help: false, errors: [] };
  const list = [...argv];
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--check' || arg.startsWith('--check=')) {
      const inline = arg.startsWith('--check=') ? arg.slice('--check='.length) : undefined;
      const value = inline !== undefined ? inline : list[++index];
      if (value === undefined || value === '' || value.startsWith('--')) {
        parsed.errors.push('--check 需要一个配置文件路径');
      } else {
        parsed.check = value;
      }
    } else {
      parsed.errors.push('未知参数：只接受 --check、--json、--help');
    }
  }
  return parsed;
}

/**
 * CLI 执行体：`argv`、输出与读文件都可注入，单测因此不碰真文件系统、不需要子进程。
 *
 * @param {{ argv?: string[], stdout?: (text: string) => void, stderr?: (text: string) => void,
 *           readFile?: (path: string) => string }} [options]
 * @returns {number} 退出码
 */
export function runCli({
  argv = [],
  stdout = () => {},
  stderr = () => {},
  readFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    stdout(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) stderr(`用法错误：${error}\n`);
    stderr(`${USAGE}\n`);
    return EXIT_USAGE;
  }

  let text;
  try {
    text = readFile(parsed.check);
  } catch {
    stdout(`${ISSUE.CONFIG_UNREADABLE} <config>\nRESULT FAIL 1\n`);
    return EXIT_ISSUES;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    stdout(`${ISSUE.CONFIG_INVALID_JSON} <config>\nRESULT FAIL 1\n`);
    return EXIT_ISSUES;
  }

  const example = data !== null && typeof data === 'object' && !Array.isArray(data) && data._example === true;
  const issues = checkProvisioning(data, { example });
  const ok = issues.length === 0;

  if (parsed.json) {
    stdout(`${JSON.stringify({ tool: TOOL_NAME, example, ok, issueCount: issues.length, issues }, null, 2)}\n`);
  } else {
    for (const issue of issues) stdout(`${issue.code} ${issue.key}\n`);
    stdout(ok ? 'RESULT PASS\n' : `RESULT FAIL ${issues.length}\n`);
  }
  return ok ? EXIT_OK : EXIT_ISSUES;
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exitCode = runCli({
    argv: process.argv.slice(2),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}

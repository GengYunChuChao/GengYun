import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_ISSUES,
  EXIT_OK,
  EXIT_USAGE,
  checkProvisioning,
  parseCliArgs,
  runCli,
} from '../../tools/verify-production-provisioning.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE_PATH = join(REPO_ROOT, 'config', 'production-provisioning.local.json.example');

/**
 * 一份**全填合法**的合成清单：域名一律 `.example.com`（公网后缀，字面量合法），
 * 所有密钥位置只放环境变量名，不放任何真实值。每个用例拿独立深拷贝，互不污染。
 */
function validConfig() {
  return {
    environment: 'production',
    wechat: {
      appid: 'wx0123456789abcdef',
      appSecretEnv: 'WECHAT_APP_SECRET',
      requestDomain: 'https://api.gengyun.example.com',
      uploadFileDomain: 'https://upload.gengyun.example.com',
      downloadFileDomain: 'https://download.gengyun.example.com',
      socketDomain: 'wss://socket.gengyun.example.com',
      icpFilingNumber: '浙ICP备00000000号-1',
      tlsMinVersion: '1.2',
      certificateExpiresOn: '2027-06-30',
    },
    privacy: {
      agreementVersion: '2026-11-02',
      declaredInterfaces: 'camera, album, microphone, location',
      evidencePath: 'docs/verification/production-provisioning-evidence.md',
    },
    database: {
      urlEnv: 'DATABASE_URL',
      readonlyUrlEnv: 'DATABASE_READONLY_URL',
      poolMax: '20',
      statementTimeoutSeconds: '30',
      tlsMode: 'verify-full',
    },
    providers: {
      weedRecognition: {
        vendor: 'vendor-vision',
        endpoint: 'https://vision.example.com/v1/recognize',
        apiKeyEnv: 'WEED_RECOGNITION_API_KEY',
        timeoutSeconds: '20',
      },
      ocr: {
        vendor: 'vendor-ocr',
        endpoint: 'https://ocr.example.com/v1/general',
        apiKeyEnv: 'OCR_API_KEY',
        timeoutSeconds: '8',
      },
      asr: {
        vendor: 'vendor-asr',
        endpoint: 'https://asr.example.com/v1/sentence',
        apiKeyEnv: 'ASR_API_KEY',
        timeoutSeconds: '10',
      },
      tts: {
        vendor: 'vendor-tts',
        endpoint: 'https://tts.example.com/v1/voice',
        apiKeyEnv: 'TTS_API_KEY',
        timeoutSeconds: '8',
      },
      llm: {
        vendor: 'vendor-llm',
        endpoint: 'https://llm.example.com/v1/chat/completions',
        apiKeyEnv: 'LLM_API_KEY',
        timeoutSeconds: '20',
      },
      moderation: {
        vendor: 'vendor-moderation',
        endpoint: 'https://tms.example.com/v1/text',
        imageEndpoint: 'https://ims.example.com/v1/image',
        apiKeyEnv: 'MODERATION_API_KEY',
        timeoutSeconds: '8',
      },
    },
    storage: {
      endpoint: 'https://objects.example.com',
      bucket: 'gengyun-private',
      accessKeyEnv: 'OBJECT_STORAGE_ACCESS_KEY',
      secretKeyEnv: 'OBJECT_STORAGE_SECRET_KEY',
      signedUrlTtlSeconds: '300',
    },
    observability: {
      logEndpoint: 'https://logs.example.com',
      alertEndpoint: 'https://alerts.example.com',
      retentionDays: '180',
    },
    backup: {
      endpoint: 'https://backup.example.com',
      schedule: 'daily 03:00',
      retentionDays: '30',
      restoreDrillDate: '2027-01-15',
    },
  };
}

/** 临时目录统一在文件级 after 里删；用例只拿路径，不关心清理。 */
const TEMP_DIRS = [];
test.after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeConfig(value) {
  const path = join(tempDir('gy-provisioning-'), 'production-provisioning.local.json');
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  return path;
}

function run(argv) {
  const out = [];
  const err = [];
  const code = runCli({
    argv,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** 把问题列表拍平成 `CODE key`，便于断言。 */
function issuesFor(config) {
  return checkProvisioning(config).map((issue) => `${issue.code} ${issue.key}`);
}

/** 按 `a.b.c` 写值（用例里只用于已存在的路径）。 */
function setPath(target, path, value) {
  const keys = path.split('.');
  let cursor = target;
  for (const key of keys.slice(0, -1)) cursor = cursor[key];
  cursor[keys.at(-1)] = value;
}

test('全填合法：退出码 0，输出只有 RESULT PASS', () => {
  const result = run(['--check', writeConfig(validConfig())]);
  assert.equal(result.code, EXIT_OK);
  assert.equal(result.stdout, 'RESULT PASS\n');
  assert.equal(result.stderr, '');
});

test('占位符 TODO：报 UNFILLED 并以 1 退出', () => {
  const config = validConfig();
  config.wechat.icpFilingNumber = 'TODO';
  const result = run(['--check', writeConfig(config)]);
  assert.equal(result.code, EXIT_ISSUES);
  assert.match(result.stdout, /^UNFILLED wechat\.icpFilingNumber$/m);
});

test('空串与 <请填写> 同样算 UNFILLED', () => {
  const config = validConfig();
  config.providers.ocr.apiKeyEnv = '';
  config.storage.bucket = '  ';
  config.backup.schedule = '<请填写>';
  const codes = issuesFor(config);
  assert.ok(codes.includes('UNFILLED providers.ocr.apiKeyEnv'));
  assert.ok(codes.includes('UNFILLED storage.bucket'));
  assert.ok(codes.includes('UNFILLED backup.schedule'));
});

test('缺键：报 MISSING_KEY，父对象缺失时点名父键', () => {
  const config = validConfig();
  delete config.database.poolMax;
  delete config.providers.asr;
  const result = run(['--check', writeConfig(config)]);
  assert.equal(result.code, EXIT_ISSUES);
  assert.match(result.stdout, /^MISSING_KEY database\.poolMax$/m);
  assert.match(result.stdout, /^MISSING_KEY providers\.asr$/m);
});

test('非 https 或 localhost：都报 NOT_PUBLIC', () => {
  const httpConfig = validConfig();
  httpConfig.wechat.requestDomain = 'http://api.gengyun.example.com';
  const httpResult = run(['--check', writeConfig(httpConfig)]);
  assert.equal(httpResult.code, EXIT_ISSUES);
  assert.match(httpResult.stdout, /^NOT_PUBLIC wechat\.requestDomain$/m);

  for (const host of ['https://localhost', 'https://127.0.0.1', 'https://api.gengyun.test', 'https://api.gengyun.local']) {
    const config = validConfig();
    config.storage.endpoint = host;
    const result = run(['--check', writeConfig(config)]);
    assert.equal(result.code, EXIT_ISSUES, `${host} 应被拒绝`);
    assert.match(result.stdout, /^NOT_PUBLIC storage\.endpoint$/m, `${host} 应报 NOT_PUBLIC`);
  }

  const portConfig = validConfig();
  portConfig.wechat.socketDomain = 'wss://socket.gengyun.example.com:8443';
  assert.match(run(['--check', writeConfig(portConfig)]).stdout, /^NOT_PUBLIC wechat\.socketDomain$/m);
});

test('域名类字段带路径要报 NOT_PUBLIC，供应商端点允许固定路径', () => {
  const config = validConfig();
  config.wechat.uploadFileDomain = 'https://upload.gengyun.example.com/upload';
  const codes = issuesFor(config);
  assert.ok(codes.includes('NOT_PUBLIC wechat.uploadFileDomain'));
  assert.ok(!codes.some((line) => line.includes('providers.llm.endpoint')));

  const queryConfig = validConfig();
  queryConfig.providers.llm.endpoint = 'https://llm.example.com/v1/chat?key=1';
  assert.ok(issuesFor(queryConfig).includes('NOT_PUBLIC providers.llm.endpoint'));
});

test('按通信类型判协议：socketDomain 要 wss，requestDomain 要 https，不能互相顶替', () => {
  // 1) 合法 socket 域名是 wss origin：整份配置无 issues。
  const wssSocket = validConfig();
  wssSocket.wechat.socketDomain = 'wss://socket.gengyun.example.com';
  assert.deepEqual(issuesFor(wssSocket), []);

  // 2) socket 登记成 https：真机 wx.connectSocket 会拒，工具也要拒。
  const httpsSocket = validConfig();
  httpsSocket.wechat.socketDomain = 'https://socket.gengyun.example.com';
  assert.ok(issuesFor(httpsSocket).includes('NOT_PUBLIC wechat.socketDomain'));

  // 3) 反方向：request 登记成 wss 同样不合法。
  const wssRequest = validConfig();
  wssRequest.wechat.requestDomain = 'wss://api.gengyun.example.com';
  assert.ok(issuesFor(wssRequest).includes('NOT_PUBLIC wechat.requestDomain'));

  // 4) 换协议不放宽其余防护：路径、查询串、本机名、私网地址一律仍拒。
  for (const bad of [
    'wss://socket.gengyun.example.com/socket',
    'wss://socket.gengyun.example.com?token=1',
    'wss://localhost',
    'wss://10.0.0.1',
  ]) {
    const config = validConfig();
    config.wechat.socketDomain = bad;
    assert.ok(issuesFor(config).includes('NOT_PUBLIC wechat.socketDomain'), `${bad} 应被拒绝`);
  }
});

test('坏 AppID：报 BAD_APPID', () => {
  for (const appid of ['wx123', 'WX0123456789ABCDEF', 'wx0123456789abcdeZ']) {
    const config = validConfig();
    config.wechat.appid = appid;
    const result = run(['--check', writeConfig(config)]);
    assert.equal(result.code, EXIT_ISSUES);
    assert.match(result.stdout, /^BAD_APPID wechat\.appid$/m);
  }
});

test('数值项越界或不是整数：报 OUT_OF_RANGE', () => {
  const cases = [
    ['database.poolMax', '0'],
    ['database.poolMax', '101'],
    ['database.statementTimeoutSeconds', '121'],
    ['providers.tts.timeoutSeconds', '0'],
    ['storage.signedUrlTtlSeconds', '60s'],
    ['observability.retentionDays', '0'],
  ];
  for (const [path, value] of cases) {
    const config = validConfig();
    setPath(config, path, value);
    const result = run(['--check', writeConfig(config)]);
    assert.equal(result.code, EXIT_ISSUES, `${path}=${value} 应被拒绝`);
    assert.match(result.stdout, new RegExp(`^OUT_OF_RANGE ${path.replaceAll('.', '\\.')}$`, 'm'));
  }
});

test('类型不对：报 EXPECTED_TYPE', () => {
  const config = validConfig();
  config.wechat.appid = 123;
  config.database = 'postgres://user:pass@db.example.com/app';
  const codes = issuesFor(config);
  assert.ok(codes.includes('EXPECTED_TYPE wechat.appid'));
  assert.ok(codes.includes('EXPECTED_TYPE database'));
});

test('模板自检：example 文件退出码 0，且不判 UNFILLED', () => {
  const result = run(['--check', EXAMPLE_PATH]);
  assert.equal(result.code, EXIT_OK);
  // 模板模式要自报家门：先一行 MODE TEMPLATE，再 RESULT PASS。
  assert.match(result.stdout, /^MODE TEMPLATE：顶层 "_example": true/m);
  assert.ok(result.stdout.endsWith('RESULT PASS\n'));
  assert.doesNotMatch(result.stdout, /^(UNFILLED|NOT_PUBLIC) /m);
});

test('模板自检只查结构：多一个键报 UNKNOWN_KEY', () => {
  const path = join(tempDir('gy-provisioning-template-'), 'template.json');
  writeFileSync(path, JSON.stringify({
    _example: true,
    _comment: '模板',
    environment: '<请填写>',
    wechat: { appid: '<请填写>', unexpected: '<请填写>' },
  }), 'utf8');
  const result = run(['--check', path]);
  assert.equal(result.code, EXIT_ISSUES);
  assert.match(result.stdout, /^UNKNOWN_KEY wechat\.unexpected$/m);
  assert.doesNotMatch(result.stdout, /^UNFILLED /m);
});

test('输出里不含被检查的密钥字符串（人类读与 --json 两种）', () => {
  const secret = 'sk-live-9f3c-DO-NOT-PRINT-this-value';
  const config = validConfig();
  config.providers.llm.apiKeyEnv = secret;
  // 故意把同一个串放进会判 BAD_APPID 的字段：报错时只准出键名与代码。
  config.wechat.appid = secret;
  const path = writeConfig(config);

  const human = run(['--check', path]);
  assert.equal(human.code, EXIT_ISSUES);
  assert.ok(human.stdout.length > 0);
  assert.ok(!human.stdout.includes(secret));
  assert.ok(!human.stderr.includes(secret));

  const json = run(['--check', path, '--json']);
  assert.doesNotMatch(json.stdout, /sk-live/);
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.issueCount, report.issues.length);
  for (const issue of report.issues) {
    assert.deepEqual(Object.keys(issue).sort(), ['code', 'key']);
  }
});

test('坏 JSON／读不到文件不回声内容：只报固定代码', () => {
  const dir = tempDir('gy-provisioning-bad-');
  const badPath = join(dir, 'bad.json');
  writeFileSync(badPath, '{"wechat": {"appid": "sk-live-SECRET",', 'utf8');
  const bad = run(['--check', badPath]);
  assert.equal(bad.code, EXIT_ISSUES);
  assert.equal(bad.stdout, 'CONFIG_INVALID_JSON <config>\nRESULT FAIL 1\n');
  assert.ok(!bad.stdout.includes('sk-live'));

  const missing = run(['--check', join(dir, 'nope.json')]);
  assert.equal(missing.code, EXIT_ISSUES);
  assert.equal(missing.stdout, 'CONFIG_UNREADABLE <config>\nRESULT FAIL 1\n');
});

test('用法错误：退出码 2，且不回显参数值', () => {
  assert.equal(run(['--check']).code, EXIT_USAGE);
  assert.equal(run(['--check=']).code, EXIT_USAGE);
  assert.equal(run(['--unknown-flag']).code, EXIT_USAGE);
  const leaked = run(['--secret=sk-live-SHOULD-NOT-ECHO']);
  assert.equal(leaked.code, EXIT_USAGE);
  assert.ok(!leaked.stderr.includes('sk-live'));
  const parsed = parseCliArgs([]);
  assert.equal(parsed.check, 'config/production-provisioning.local.json');
});

test('checkProvisioning 是纯函数：不改输入', () => {
  const config = validConfig();
  const snapshot = JSON.stringify(config);
  checkProvisioning(config);
  assert.equal(JSON.stringify(config), snapshot);
});

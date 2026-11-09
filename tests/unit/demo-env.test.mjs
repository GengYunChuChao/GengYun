/**
 * `tools/demo-env.mjs` 的契约：JSONC 解析、键映射、三道边界（不覆盖 / 不出仓库 / 缺键 fail-closed），
 * 以及**打印纪律**——值只往文件里走，屏幕上一个字符都不许出现。
 *
 * 为什么「不打印明文」要单独用真 spawn 断言：这条纪律最容易在某次「顺手 debug 一下」里被破坏，
 * 而破坏的代价是不可逆的（终端滚动区、CI 日志、聊天记录都会留下密钥）。所以这里不但断言 stdout/stderr
 * 里没有夹具里的标记串，还反过来断言**文件里确实有**——否则「没打印」可能只是「根本没跑通」。
 *
 * 真 spawn 还有第二个用途：`tests/unit/ci-orphan-tools-wired.test.mjs` 只认「在仓库根跑真仓那份脚本
 * 并断言 `.status`」这种接线证据，纯 import 不算。下面的 CLI 用例因此都走 `spawnSync(process.execPath, …)`
 * 且 `cwd = 仓库根`。
 *
 * ⛔ 不碰真凭据、不碰 PG、不联网：所有夹具都是临时目录里的假 JSONC。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ENV_SPECS,
  MEDIA_KEY_HEX,
  collectEnv,
  decodeCredentialText,
  encodingProblems,
  isInside,
  parseJsonc,
  stripJsonc,
} from '../../tools/demo-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(ROOT, 'tools', 'demo-env.mjs');

/** 夹具里的标记串：任何一行输出里出现它，就等于「值被打印了」。 */
const MARK = 'PLAINTEXT-MARKER-8f3a';

/**
 * 一份「该有的都有」的假凭据：`//` 行内注释、`/* *\/` 块注释、尾逗号、嵌套 `objectStorage`、
 * 以及一个值里带 `https://` 的端点（专门盯「正则剥注释会把连接串砍断」这个坑）。
 */
const FULL_FIXTURE = [
  '{',
  '  // 顶层行注释',
  `  "appid": "wx-${MARK}-appid",`,
  `  "appsecret": "sec-${MARK}-secret",`,
  '  /* 对象存储：嵌套写法（任务口径） */',
  '  "objectStorage": {',
  `    "Endpoint": "https://oss.example.com/v1",   // 值里的 // 不是注释`,
  `    "Bucket": "demo-${MARK}-bucket",`,
  `    "AccessKey": "ak-${MARK}",`,
  `    "SecretKey": "sk-${MARK}",`,
  '  },',
  `  "deepseekApiKey": "ds-${MARK}",`,
  `  "sessionSigningKey": "sess-${MARK}",`,
  `  "deletionLedgerKey": "ledg-${MARK}",`,
  '}',
  '',
].join('\n');

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-demo-env-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body, 'utf8');
  return file;
}

function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
}

// ────────────────────────────────────────────────────────── JSONC 解析

test('stripJsonc：剥 // 与 /* */ 注释、去尾逗号，但不动字符串里的 //', () => {
  const stripped = stripJsonc(FULL_FIXTURE);
  assert.ok(!stripped.includes('顶层行注释'), '行注释必须被剥掉');
  assert.ok(!stripped.includes('对象存储：嵌套写法'), '块注释必须被剥掉');
  assert.ok(stripped.includes('https://oss.example.com/v1'), '字符串里的 // 必须原样留下');
  const parsed = JSON.parse(stripped);
  assert.equal(parsed.objectStorage.Endpoint, 'https://oss.example.com/v1', '值里的 https:// 必须原样保留');
  assert.equal(parsed.appid, `wx-${MARK}-appid`);
  assert.equal(parsed.objectStorage.Bucket, `demo-${MARK}-bucket`, '尾逗号之后的对象仍要能解析');
});

test('stripJsonc：字符串里的 // 与 /* 不被当成注释（连接串实测形状）', () => {
  const text = '{"databaseUrl": "postgres://u:p@h:5432/db", "note": "a /* b */ c"}';
  const parsed = JSON.parse(stripJsonc(text));
  assert.equal(parsed.databaseUrl, 'postgres://u:p@h:5432/db');
  assert.equal(parsed.note, 'a /* b */ c');
});

test('parseJsonc：各种注释 + 尾逗号都能解；顶层不是对象就报错', () => {
  const parsed = parseJsonc(FULL_FIXTURE);
  assert.equal(parsed.appsecret, `sec-${MARK}-secret`);
  assert.equal(parsed.objectStorage.SecretKey, `sk-${MARK}`);
  assert.throws(() => parseJsonc('[1, 2]'), /顶层必须是 JSON 对象/u);
});

test('parseJsonc：语法错误只带行号，错误 message 里不含原文', () => {
  const broken = ['{', `  "appid": "wx-${MARK}",`, '  "appsecret" "oops"', '}'].join('\n');
  assert.throws(
    () => parseJsonc(broken),
    (error) => {
      assert.ok(error.line >= 1, '必须给出行号');
      assert.doesNotMatch(error.message, new RegExp(MARK.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), '错误 message 里不许出现值');
      return true;
    },
  );
});

test('decodeCredentialText：UTF-8 与 GBK（注释历史遗留）都能读，乱码字节不猜', () => {
  assert.equal(decodeCredentialText(Buffer.from('{"a":"1"}', 'utf8')).encoding, 'utf-8');
  // GBK 的「中文」= D6 D0 CE C4；按 UTF-8 解是非法字节序列，必须退到 GBK 而不是抛错。
  const gbk = Buffer.concat([Buffer.from('{"note":"', 'ascii'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('"}', 'ascii')]);
  const decoded = decodeCredentialText(gbk);
  assert.equal(decoded.encoding, 'gbk');
  assert.equal(JSON.parse(decoded.text).note, '中文');
});

// ────────────────────────────────────────────────────────── 键映射

test('collectEnv：13 个 env 键按固定顺序产出，固定值不来自凭据', () => {
  const { values, generated, missing } = collectEnv(parseJsonc(FULL_FIXTURE));
  assert.deepEqual(missing, [], '齐全的凭据不该报缺键');
  const envNames = values.map((row) => row.env);
  assert.deepEqual(envNames, ENV_SPECS.map((spec) => spec.env), '输出顺序必须与 ENV_SPECS 一致（文件可 diff）');
  assert.deepEqual(envNames, [
    'WECHAT_APP_ID',
    'WECHAT_APP_SECRET',
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY',
    'OBJECT_STORAGE_SECRET_KEY',
    'SESSION_SIGNING_KEY',
    'DELETION_LEDGER_KEY',
    'RECOGNITION_PROVIDER_URL',
    'RECOGNITION_PROVIDER_KEY',
    'RECOGNITION_PROVIDER_PROFILE',
    'RECOGNITION_PROVIDER_MODEL',
    'MEDIA_OBJECT_REF_KEY',
  ]);
  const byEnv = new Map(values.map((row) => [row.env, row.value]));
  assert.equal(byEnv.get('WECHAT_APP_ID'), `wx-${MARK}-appid`);
  assert.equal(byEnv.get('OBJECT_STORAGE_ENDPOINT'), 'https://oss.example.com/v1');
  assert.equal(byEnv.get('RECOGNITION_PROVIDER_URL'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(byEnv.get('RECOGNITION_PROVIDER_PROFILE'), 'openai-vision-v1');
  assert.equal(byEnv.get('RECOGNITION_PROVIDER_MODEL'), 'deepseek-flash');
  assert.equal(byEnv.get('RECOGNITION_PROVIDER_KEY'), `ds-${MARK}`);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].env, 'MEDIA_OBJECT_REF_KEY');
  assert.equal(generated[0].reused, false);
});

test('collectEnv：扁平写法（本机真实凭据的形状）与嵌套写法等价', () => {
  const flat = {
    appid: 'a',
    appsecret: 'b',
    objectStorageEndpoint: 'https://oss.example.com',
    objectStorageBucket: 'bkt',
    objectStorageAccessKey: 'ak',
    objectStorageSecretKey: 'sk',
    sessionSigningKey: 's',
    deletionLedgerKey: 'd',
    deepseekApiKey: 'k',
  };
  const { values, missing } = collectEnv(flat);
  assert.deepEqual(missing, []);
  const byEnv = new Map(values.map((row) => [row.env, row.value]));
  assert.equal(byEnv.get('OBJECT_STORAGE_ENDPOINT'), 'https://oss.example.com');
  assert.equal(byEnv.get('OBJECT_STORAGE_BUCKET'), 'bkt');
  assert.equal(byEnv.get('OBJECT_STORAGE_ACCESS_KEY'), 'ak');
  assert.equal(byEnv.get('OBJECT_STORAGE_SECRET_KEY'), 'sk');
});

test('collectEnv：缺键只登记键名与源键名，绝不带值', () => {
  const { missing } = collectEnv({ appid: `wx-${MARK}` });
  const envNames = missing.map((row) => row.env);
  assert.ok(envNames.includes('WECHAT_APP_SECRET'));
  assert.ok(envNames.includes('MEDIA_OBJECT_REF_KEY') === false, 'MEDIA_OBJECT_REF_KEY 是生成的，不该算缺');
  const serialized = JSON.stringify(missing);
  assert.ok(!serialized.includes(MARK), '缺键清单里不许出现任何值');
  assert.ok(missing.every((row) => Array.isArray(row.from) && row.from.length > 0), '缺键要给出源键名，人才知道去补哪一项');
});

test('collectEnv：MEDIA_OBJECT_REF_KEY 缺就生成 64 位 hex；给了旧钥匙就沿用', () => {
  const source = parseJsonc(FULL_FIXTURE);
  const first = collectEnv(source).values.find((row) => row.env === 'MEDIA_OBJECT_REF_KEY').value;
  assert.match(first, MEDIA_KEY_HEX, '必须是 32 字节随机 hex（64 位）');

  const legacy = 'a'.repeat(64);
  const reused = collectEnv(source, { previousMediaKey: legacy });
  assert.equal(reused.values.find((row) => row.env === 'MEDIA_OBJECT_REF_KEY').value, legacy);
  assert.equal(reused.generated[0].reused, true);

  const bogus = collectEnv(source, { previousMediaKey: 'not-a-key' });
  assert.notEqual(bogus.values.find((row) => row.env === 'MEDIA_OBJECT_REF_KEY').value, 'not-a-key', '形状不对的旧钥匙不许沿用');
});

test('encodingProblems：换行与「要加引号又含引号」的值只报键名', () => {
  const problems = encodingProblems([
    { env: 'A', value: 'ok-token' },
    { env: 'B', value: 'line1\nline2' },
    { env: 'C', value: 'has space "quoted"' },
  ]);
  assert.deepEqual(problems.map((row) => row.env), ['B', 'C']);
  assert.ok(!JSON.stringify(problems).includes('line1'), '问题清单里不许出现值');
});

test('isInside：仓库内的子路径为真，仓库外与仓库上级为假', () => {
  assert.equal(isInside(ROOT, join(ROOT, 'tmp.env')), true);
  assert.equal(isInside(ROOT, join(ROOT, 'nested', 'deep', 'tmp.env')), true);
  assert.equal(isInside(ROOT, join(ROOT, '..', 'outside.env')), false);
  assert.equal(isInside(ROOT, ROOT), true, '「等于仓库根」也算在里面（--out 指到目录本身就是错的）');
});

// ────────────────────────────────────────────────────────── CLI 真 spawn

test('CLI --help：exit 0，用法里点名三个选项与两条打印纪律', () => {
  const result = runTool(['--help']);
  assert.equal(result.status, 0, `--help 应 exit 0，实际 ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /--from/u);
  assert.match(result.stdout, /--out/u);
  assert.match(result.stdout, /--force/u);
  assert.match(result.stdout, /任何值都不打印/u);
});

test('CLI 正常一次：exit 0，写 13 个键，stdout 只说键数/路径/生成项，不含任何值', () => {
  withTempDir((dir) => {
    const from = writeFixture(dir, 'credentials.local.json', FULL_FIXTURE);
    const out = join(dir, 'demo-real.env');
    const result = runTool(['--from', from, '--out', out]);
    assert.equal(result.status, 0, `应 exit 0，实际 ${result.status}\n${result.stderr}`);

    const printed = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(printed, new RegExp(MARK, 'u'), `屏幕输出里出现了明文标记：\n${printed}`);
    assert.match(result.stdout, /已写出 13 个键/u);
    assert.match(result.stdout, /MEDIA_OBJECT_REF_KEY/u, '必须点名哪个键是生成的');
    assert.ok(result.stdout.includes(out) || result.stdout.includes(out.replace(/\//gu, '\\')), '必须打印输出路径');

    const body = readFileSync(out, 'utf8');
    assert.match(body, new RegExp(MARK, 'u'), '文件里必须真的有值——否则「没打印」可能只是没跑通');
    assert.match(body, /^WECHAT_APP_ID=/mu);
    assert.match(body, /^MEDIA_OBJECT_REF_KEY=[0-9a-f]{64}$/mu);
    assert.match(body, /本机演示用/u, 'MEDIA_OBJECT_REF_KEY 的注释要写明是本机演示用');
  });
});

test('CLI 拒绝覆盖：已存在且没 --force ⇒ exit 1，旧文件一个字节都不变', () => {
  withTempDir((dir) => {
    const from = writeFixture(dir, 'credentials.local.json', FULL_FIXTURE);
    const out = join(dir, 'demo-real.env');
    const sentinel = '# 旧文件：不许被覆盖\nMEDIA_OBJECT_REF_KEY=' + 'b'.repeat(64) + '\n';
    writeFileSync(out, sentinel, 'utf8');

    const result = runTool(['--from', from, '--out', out]);
    assert.equal(result.status, 1, `未加 --force 应 exit 1，实际 ${result.status}`);
    assert.match(result.stderr, /已存在/u);
    assert.match(result.stderr, /--force/u);
    assert.equal(readFileSync(out, 'utf8'), sentinel, '拒绝覆盖时必须原样保留旧文件');
  });
});

test('CLI --force：覆盖后沿用旧文件里的同一把 MEDIA_OBJECT_REF_KEY', () => {
  withTempDir((dir) => {
    const from = writeFixture(dir, 'credentials.local.json', FULL_FIXTURE);
    const out = join(dir, 'demo-real.env');
    const legacy = 'c'.repeat(64);
    writeFileSync(out, `MEDIA_OBJECT_REF_KEY=${legacy}\n`, 'utf8');

    const result = runTool(['--from', from, '--out', out, '--force']);
    assert.equal(result.status, 0, `--force 应 exit 0，实际 ${result.status}\n${result.stderr}`);
    assert.match(result.stdout, /沿用旧输出文件里的同一把/u);
    const body = readFileSync(out, 'utf8');
    assert.match(body, new RegExp(`^MEDIA_OBJECT_REF_KEY=${legacy}$`, 'mu'), '换钥匙会让旧媒体对象解不开');
  });
});

test('CLI 拒绝仓库内的输出路径：exit 1，且不留下任何文件', () => {
  withTempDir((dir) => {
    const from = writeFixture(dir, 'credentials.local.json', FULL_FIXTURE);
    const out = join(ROOT, 'tmp-demo-env-should-not-exist.env');
    const result = runTool(['--from', from, '--out', out]);
    assert.equal(result.status, 1, `仓库内路径应 exit 1，实际 ${result.status}`);
    assert.match(result.stderr, /仓库目录/u);
    assert.equal(existsSync(out), false, '被拒绝时不许先写一半');
  });
});

test('CLI 要求绝对路径：相对 --out ⇒ exit 1 且点名「绝对路径」', () => {
  withTempDir((dir) => {
    const from = writeFixture(dir, 'credentials.local.json', FULL_FIXTURE);
    const result = runTool(['--from', from, '--out', 'relative.env']);
    assert.equal(result.status, 1, `相对路径应 exit 1，实际 ${result.status}`);
    assert.match(result.stderr, /绝对路径/u);
  });
});

test('CLI 缺关键键：exit 2，只列键名（env 名 + 源键名），不含任何值', () => {
  withTempDir((dir) => {
    const body = ['{', `  "appid": "wx-${MARK}",`, `  "deepseekApiKey": "ds-${MARK}",`, '}', ''].join('\n');
    const from = writeFixture(dir, 'credentials.local.json', body);
    const out = join(dir, 'demo-real.env');
    const result = runTool(['--from', from, '--out', out]);
    assert.equal(result.status, 2, `缺键应 exit 2，实际 ${result.status}`);
    assert.match(result.stderr, /WECHAT_APP_SECRET/u);
    assert.match(result.stderr, /appsecret/u, '要给出源键名，否则人不知道该补哪一项');
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(MARK, 'u'), '缺键清单里不许出现值');
    assert.equal(existsSync(out), false, '缺键时不许写出半成品 env 文件');
  });
});

test('CLI 解析失败：exit 2，报行号但不回显文件内容', () => {
  withTempDir((dir) => {
    const body = ['{', `  "appid": "wx-${MARK}",`, '  "appsecret" "missing colon"', '}'].join('\n');
    const from = writeFixture(dir, 'credentials.local.json', body);
    const result = runTool(['--from', from, '--out', join(dir, 'demo-real.env')]);
    assert.equal(result.status, 2, `解析失败应 exit 2，实际 ${result.status}`);
    assert.match(result.stderr, /第 \d+ 行附近/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(MARK, 'u'), 'JSON.parse 的报错原文会带值的摘要，必须被截掉');
  });
});

test('CLI 缺 --from/--out 与未知参数：exit 1', () => {
  const missing = runTool([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /缺参数/u);
  const unknown = runTool(['--nope']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知参数「--nope」/u);
});

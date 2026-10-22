// 锚点自动重定位（--reanchor）的行为测试：全部夹具都建在系统临时目录里，不读写仓内台账。
// 覆盖四档：① 插入 5 行后默认 dry-run 只报不改；② 落盘后 lines 落在归属块上、JSON 其它字节逐字节不变；
// ③ 同一符号落在两个归属块 ⇒ AMBIGUOUS 拒绝、exit 1、台账 hash 不变；④ 符号不存在 ⇒ MISSING 拒绝、exit 1。
// 四档都只依赖 node:fs 造的合成源文件，不引用真实仓库的 services/api/src 内容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStatusTables } from '../../tools/contract-status-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATUS_FILE = 'docs/architecture/contract-status.json';
const DOC_FILE = 'docs/architecture/contract-implementation-status.md';
const SERVICE = 'services/api/src/profile/service.ts';
const ROUTE_FILE = 'services/api/src/routes/fixture.ts';
const DIMENSION_KEYS = ['error_codes', 'pagination', 'versioning', 'idempotency', 'source_kind', 'execution_modes', 'cancel', 'timeout'];

// 基线夹具：put() 声明在第 5 行，cropItems 命中第 8、10 行，put() 方法体到第 12 行收尾。
const SOURCE = [
  '// 合成夹具：只用于锚点重定位，不代表真实实现。',
  '',
  'export function createProfileService(client) {',
  '  return {',
  '    async put(input, body) {',
  '      const scope = String(input.userId);',
  '      const keyHash = scope.length > 0 ? scope : null;',
  "      const cropItems = await directory(client, 'crops');",
  "      const regionItems = await directory(client, 'regions');",
  "      if (!cropItems.length) throw new Error('EMPTY_CROPS');",
  '      return { scope, keyHash, cropItems, regionItems };',
  '    },',
  '    async list(input, kind) {',
  '      const items = await directory(client, kind);',
  '      return items.filter(item => item.kind === kind);',
  '    },',
  '  };',
  '}',
  '',
];
// 在 put() 体内插入 5 行：put() 仍在第 5 行，cropItems 漂到第 13、15 行，方法体到第 17 行收尾。
const INSERTED = [
  '      const extra = body === undefined ? null : body;',
  '      const guard = extra === null;',
  '      // 新增 5 行：模拟业务改动，锚点因此下移',
  "      if (guard) throw new Error('EMPTY_BODY');",
  '      const seed = guard ? 0 : 1;',
];
const DRIFTED = [...SOURCE.slice(0, 5), ...INSERTED, ...SOURCE.slice(5)].join('\n');
// 同一符号 `value` 落在两个不同归属块（first 第 2-5 行、second 第 11-14 行），中间留出不含该符号的 4 行。
const AMBIGUOUS_SOURCE = [
  '// 合成夹具：同一符号落在两个不同归属块。',
  'export function first(client) {',
  '  const value = 1;',
  '  return value;',
  '}',
  '',
  '// 中间留白',
  '// 中间留白',
  '// 中间留白',
  '// 中间留白',
  'export function second(client) {',
  '  const value = 2;',
  '  return value;',
  '}',
  '',
].join('\n');

const fixture = (t, options = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'gy-contract-reanchor-'));
  t.after(() => {
    assert.ok(root.startsWith(tmpdir()), `夹具应位于临时目录内：${root}`);
    rmSync(root, { recursive: true, force: true });
  });
  const put = (path, content) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  mkdirSync(join(root, 'tools'), { recursive: true });
  for (const name of ['verify-contract-status.mjs', 'contract-status-core.mjs']) {
    copyFileSync(join(ROOT, 'tools', name), join(root, 'tools', name));
  }
  put('services/api/src/app.ts', '');
  put(ROUTE_FILE, '// 夹具：没有任何注册声明。\n');
  put(SERVICE, options.source ?? SOURCE.join('\n'));
  put('packages/contracts/operations.json', JSON.stringify({
    contract_version: 'reanchor-test',
    operations: [{ id: 'putProfile', method: 'put', path: '/me/profile' }],
  }, null, 2));
  // 写台账并把对照表渲染成与之一致，避免用例被「表格漂移」干扰。
  const apply = evidence => {
    const value = {
      contract_version: 'reanchor-test',
      operations: [{
        id: 'putProfile', method: 'put', path: '/me/profile', route_mounted: false,
        status: 'partial', blocker: '夹具：只验证锚点重定位', evidence,
      }],
      dimensions: DIMENSION_KEYS.map(key => ({
        key, title: `夹具维度 ${key}`, source_anchor: `夹具：${key} 无来源`,
        status: 'partial', blocker: '夹具：只验证锚点重定位',
        evidence: [{ path: ROUTE_FILE, lines: '1-1' }],
      })),
    };
    put(STATUS_FILE, JSON.stringify(value, null, 2));
    put(DOC_FILE, `# 夹具\n\n${renderStatusTables(value)}\n\n尾部\n`);
    return value;
  };
  const run = (args = []) => spawnSync(process.execPath, ['tools/verify-contract-status.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const ledgerText = () => readFileSync(join(root, STATUS_FILE), 'utf8');
  const sha = text => createHash('sha256').update(text).digest('hex');
  return { root, put, apply, run, ledgerText, sha };
};

const ledgerOf = result => JSON.parse(result.ledgerText());
const operationEvidence = (result) => {
  const [operation] = ledgerOf(result).operations;
  return operation.evidence[0];
};

test('① 插入 5 行后 dry-run：只报不改、台账一字节不动、exit 1', t => {
  const instance = fixture(t, { source: DRIFTED });
  instance.apply([{ path: SERVICE, symbol: 'cropItems', lines: '8-9' }]);
  const before = instance.ledgerText();
  const result = instance.run(['--reanchor']);
  // 漂移仍在：校验器照旧判红，但 reanchor 已经算好了新区间（put() 方法体第 5-17 行）。
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /REANCHOR: .*旧 lines 8-9 → 新 lines 5-17（锚点「cropItems」命中第 13、15、16 行；归属块 5-17）/);
  assert.match(result.stdout, /REANCHOR: 只报不改（dry-run）；1 条候选，加 --write-doc 才会写盘。/);
  assert.match(result.stderr, /语义错误 · .*的锚点「cropItems」不在引用行范围内/);
  // dry-run 真正只读：台账逐字节不变。
  assert.equal(instance.ledgerText(), before);
  assert.equal(instance.sha(instance.ledgerText()), instance.sha(before));
});

test('② --reanchor --write-doc：lines 落到归属块上、其余字节不变、校验转绿', t => {
  const instance = fixture(t, { source: DRIFTED });
  instance.apply([{ path: SERVICE, symbol: 'cropItems', lines: '8-9' }]);
  const before = instance.ledgerText();
  const result = instance.run(['--reanchor', '--write-doc']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /REANCHOR: 已重写 1 条 lines 值/);
  // 表里那一行的区间变了，所以对照表被重写一次（这是既有同步流程，不是失败）。
  assert.match(result.stdout, /SYNC: 中文表格此前不是「中文表格一致」状态，已按 JSON 重写/);
  assert.equal(result.stderr, '');
  const after = instance.ledgerText();
  assert.equal(operationEvidence(instance).lines, '5-17');
  // 字节保真：只替换这一个字符串值，其它字节（键顺序/缩进/EOL/中文）逐字节相同。
  assert.equal(after, before.replace('"lines": "8-9"', '"lines": "5-17"'));
  const mask = text => text.replace('"lines": "8-9"', '"lines": "<lines>"').replace('"lines": "5-17"', '"lines": "<lines>"');
  assert.equal(instance.sha(mask(after)), instance.sha(mask(before)));
  // 中文对照表同步成新区间，且不再有表格漂移。
  assert.match(readFileSync(join(instance.root, DOC_FILE), 'utf8'), /service\.ts:5-17/);
  // 幂等：再跑一次既没有候选，也不再写盘。
  const second = instance.run(['--reanchor']);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /REANCHOR: 无可重定位项（带锚点且带行号的引用 1 条，锚点都在 ±2 行容差内）/);
  assert.equal(instance.ledgerText(), after);
});

test('③ AMBIGUOUS：同一符号落在两个归属块 ⇒ 拒绝、exit 1、台账 hash 不变', t => {
  const instance = fixture(t, { source: AMBIGUOUS_SOURCE });
  instance.apply([{ path: SERVICE, symbol: 'value', lines: '8-8' }]);
  const before = instance.ledgerText();
  const result = instance.run(['--reanchor', '--write-doc']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /AMBIGUOUS/);
  assert.match(result.stderr, /落在 2 个不同归属块（候选行号第 3、4、12、13 行；归属块 2-5、11-14）/);
  assert.match(result.stderr, /FAIL: 锚点重定位被拒绝（MISSING 0 \/ AMBIGUOUS 1 \/ UNSAFE 0），未写盘/);
  assert.equal(instance.ledgerText(), before);
  assert.equal(instance.sha(instance.ledgerText()), instance.sha(before));
  assert.equal(operationEvidence(instance).lines, '8-8');
});

test('④ MISSING：符号在文件里不存在 ⇒ 拒绝、exit 1、报 MISSING', t => {
  const instance = fixture(t);
  instance.apply([{ path: SERVICE, symbol: 'cropItemsAbsent', lines: '8-9' }]);
  const before = instance.ledgerText();
  const result = instance.run(['--reanchor', '--write-doc']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /锚点「cropItemsAbsent」在文件里出现 0 次（MISSING）/);
  assert.match(result.stderr, /FAIL: 锚点重定位被拒绝（MISSING 1 \/ AMBIGUOUS 0 \/ UNSAFE 0），未写盘/);
  assert.equal(instance.ledgerText(), before);
  assert.equal(instance.sha(instance.ledgerText()), instance.sha(before));
});

test('⑤ 仓内基线：--reanchor 报「无可重定位项」且不动任何台账字节', () => {
  const before = readFileSync(join(ROOT, STATUS_FILE), 'utf8');
  const result = spawnSync(process.execPath, ['tools/verify-contract-status.mjs', '--reanchor'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /REANCHOR: 无可重定位项/);
  assert.match(result.stdout, /PASS: 中文表格一致/);
  assert.equal(readFileSync(join(ROOT, STATUS_FILE), 'utf8'), before);
});

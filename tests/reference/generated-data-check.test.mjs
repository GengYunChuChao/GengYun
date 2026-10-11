import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sources = [
  'packages/knowledge/catalog/crops.json',
  'packages/knowledge/catalog/species.json',
  'packages/knowledge/catalog/sources.json',
  'packages/knowledge/catalog/regions-zhejiang.json',
  'packages/knowledge/herbicides/records-2026.json',
  'db/seeds/gy-i07/herbicides.json',
  'db/seeds/gy-i07/weeds.json',
  'db/seeds/gy-i07/weed_master.json',
  'db/seeds/gy-i07/province_index.json',
  'db/seeds/gy-i07/control_timing.json',
];

function fixture(t) {
  const base = resolve(tmpdir());
  const root = mkdtempSync(join(base, 'gy-generated-check-'));
  assert.ok(isAbsolute(root) && dirname(root) === base, 'fixture stays in the temporary directory');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'tools/knowledge/build_miniprogram_data.mjs');
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(join(repo, 'tools/knowledge/build_miniprogram_data.mjs'), script);
  for (const source of sources) {
    const target = join(root, source);
    mkdirSync(dirname(target), { recursive: true });
    // Synthetic only: no production knowledge or private files are edited/copied.
    writeFileSync(target, JSON.stringify({
      schema: 'test.synthetic',
      marker: 'original',
      ordered: ['first', 'second'],
      escaped_line_endings: 'inside\r\nstring',
      regions: [{ code: '330000', name: 'synthetic', parent_code: null }],
    }, null, 2) + '\n');
  }
  function run(check = true) {
    const result = spawnSync(process.execPath, [script, ...(check ? ['--check'] : [])], {
      cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }
  const generation = run(false);
  assert.equal(generation.status, 0, generation.stderr);
  const outDir = join(root, 'miniprogram/data');
  const outputs = readdirSync(outDir).map((name) => join(outDir, name));
  assert.equal(outputs.length, 10);
  return { root, outDir, outputs, run };
}

function snapshot(outputs) {
  return outputs.map((path) => readFileSync(path).toString('hex'));
}

test('generated LF and all-CRLF outputs pass without rewriting bytes', (t) => {
  const f = fixture(t);
  assert.ok(f.outputs.every((path) => !readFileSync(path, 'utf8').includes('\r')));
  let before = snapshot(f.outputs);
  assert.equal(f.run().status, 0);
  assert.deepEqual(snapshot(f.outputs), before);
  for (const path of f.outputs) writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'));
  before = snapshot(f.outputs);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(f.outputs), before);
});

test('mixed LF/CRLF output passes and regeneration remains deterministic LF', (t) => {
  const f = fixture(t);
  const expected = snapshot(f.outputs);
  const target = f.outputs[0];
  const text = readFileSync(target, 'utf8');
  let line = 0;
  writeFileSync(target, text.replace(/\n/g, () => (++line % 2 ? '\r\n' : '\n')));
  const before = snapshot(f.outputs);
  const checked = f.run();
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(snapshot(f.outputs), before);
  assert.equal(f.run(false).status, 0);
  assert.deepEqual(snapshot(f.outputs), expected);
});

for (const [name, mutate] of [
  ['field value change', (s) => s.replace('"marker": "original"', '"marker": "tampered"')],
  ['missing field', (s) => s.replace(/  "marker": "original",\n/, '')],
  ['field order change', (s) => s.replace('  "schema": "test.synthetic",\n  "marker": "original",', '  "marker": "original",\n  "schema": "test.synthetic",')],
  ['array order change', (s) => s.replace('"first",\n    "second"', '"second",\n    "first"')],
  ['indentation change', (s) => s.replace('  "marker"', ' "marker"')],
  ['missing final newline', (s) => s.slice(0, -1)],
  ['extra trailing newline', (s) => s + '\n'],
  ['bare CR', (s) => s.replace(/\n/, '\r')],
  ['UTF-8 BOM', (s) => '\uFEFF' + s],
  ['escaped CRLF inside JSON string changed', (s) => s.replace('inside\\r\\nstring', 'inside\\nstring')],
]) {
  test(`check still detects ${name} without fixing the file`, (t) => {
    const f = fixture(t);
    const target = join(f.outDir, 'crops.js');
    const original = readFileSync(target, 'utf8');
    const changed = mutate(original);
    assert.notEqual(changed, original, 'mutation must exercise the actual output');
    writeFileSync(target, changed.replace(/\n/g, '\r\n'));
    const before = snapshot(f.outputs);
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\[drift\] miniprogram\/data\/crops\.js/);
    assert.match(result.stderr, /FAIL[^\n]*1 /);
    assert.deepEqual(snapshot(f.outputs), before);
  });
}

test('missing generated file fails check and is not recreated', (t) => {
  const f = fixture(t);
  const missing = join(f.outDir, 'crops.js');
  rmSync(missing);
  const remaining = f.outputs.filter((path) => path !== missing);
  const before = snapshot(remaining);
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[drift\] miniprogram\/data\/crops\.js/);
  assert.equal(existsSync(missing), false);
  assert.deepEqual(snapshot(remaining), before);
});

test('changed source fails check without rewriting generated data', (t) => {
  const f = fixture(t);
  const source = join(f.root, sources[0]);
  writeFileSync(source, readFileSync(source, 'utf8').replace('"marker": "original"', '"marker": "changed-source"'));
  const before = snapshot(f.outputs);
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[drift\] miniprogram\/data\/crops\.js/);
  assert.deepEqual(snapshot(f.outputs), before);
});

// 预测结构契约（issue #20「7 个任务的预测字段形状没有 schema」）。
//
// 缺口：字段形状此前只以**事实**形式存在于 tests/evaluation/fixtures/synthetic-predictions.json
//   与 packages/evaluation/src/metrics.mjs 的读取代码里，没有声明式契约：字段漏写/改名不会红，
//   只会在评分期**少算**（字段缺失 → 该项永不命中），于是"模型没给"与"模型给错"在报告里不可区分。
//
// 断言分三类：
//   1) 形状事实来源（合成夹具）必须通过新 schema —— 通不过说明 schema 抽错了，应改 schema 而非改夹具；
//   2) schema 与执行体 PREDICTION_TASK_SHAPES / metrics 常量必须逐一一致 —— 防止"契约漂移"（两处各说各的）；
//   3) 负控制：逐任务删掉必需字段 ⇒ CLI 必红（exit 1），错误信息点名 sampleId 与缺的字段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePredictions,
  formatPredictionContractErrors,
  PREDICTION_TASK_SHAPES,
  PREDICTIONS_SCHEMA_PATH,
  PREDICTIONS_SCHEMA_ID,
  OCR_FIELD_NAMES,
  ASR_KEY_FIELDS,
  WEED_DECISIONS,
  MODERATION_DECISIONS,
  TTS_JUDGEMENT_FIELDS,
} from '../../packages/evaluation/index.mjs';
import { runEvaluation } from '../../tools/evaluation/run-evaluation.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(REPO_ROOT, 'tests', 'evaluation', 'fixtures');
const INDEX = join(FIXTURES, 'synthetic-index.json');
const PREDICTIONS = join(FIXTURES, 'synthetic-predictions.json');

const loadJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sorted = (xs) => [...xs].sort();
const TASKS = Object.keys(PREDICTION_TASK_SHAPES);

function runCli(args) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: (s) => { stdout += s; return true; } },
    stderr: { write: (s) => { stderr += s; return true; } },
  };
  const { exitCode, report } = runEvaluation(args, io);
  return { exitCode, report, stdout, stderr };
}

/** 索引里每个任务的第一条 sampleId（夹具是事实来源，不硬编码 id 顺序）。 */
function firstSampleIdByTask(records) {
  const map = new Map();
  for (const r of records) if (!map.has(r.task)) map.set(r.task, r.sampleId);
  return map;
}

/**
 * 负控制的"该删哪些字段"：任一必需组整体删掉才算缺 —— 只删组里一个字段仍满足另一组（属合法输入）。
 * 单一必需集任务则取第一个必需字段。
 */
function fieldsToRemove(shape, output) {
  if (Array.isArray(shape.anyOfRequired)) {
    const group = shape.anyOfRequired.find((g) => g.every((f) => output[f] !== undefined));
    assert.ok(group, `夹具里的 ${JSON.stringify(output)} 应满足某个必需组`);
    return group;
  }
  return [shape.required[0]];
}

test('[契约] schema 文件存在、为 draft 2020-12、$id 与导出常量一致、覆盖 7 个任务', () => {
  const schema = loadJson(join(REPO_ROOT, PREDICTIONS_SCHEMA_PATH));
  assert.equal(PREDICTIONS_SCHEMA_PATH, 'packages/evaluation/schema/predictions.schema.json');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, PREDICTIONS_SCHEMA_ID);

  assert.equal(TASKS.length, 7, '契约应覆盖 7 个任务');
  assert.deepEqual(
    sorted(TASKS),
    sorted(['weed_photo', 'label_ocr', 'registration_match', 'ai_moderation', 'tts', 'asr', 'qa']),
  );
  assert.deepEqual(sorted(Object.keys(schema['x-taskShapes'])), sorted(TASKS), 'schema 的 x-taskShapes 应覆盖同一批任务');
  for (const task of TASKS) {
    const shape = PREDICTION_TASK_SHAPES[task];
    assert.equal(schema['x-taskShapes'][task], `#/$defs/${shape.schemaDef}`, `${task} 的任务→形状绑定应对得上`);
    assert.ok(schema.$defs[shape.schemaDef], `${task} 的 $defs.${shape.schemaDef} 应存在`);
  }
});

test('[契约·事实来源] synthetic-predictions.json 必须通过新 schema，且 7 个任务全覆盖', () => {
  const records = loadJson(INDEX);
  const predictions = loadJson(PREDICTIONS);
  const indexTasks = new Set(records.map((r) => r.task));
  assert.deepEqual(sorted([...indexTasks]), sorted(TASKS), '索引夹具应覆盖 7 个任务');
  assert.equal(Object.keys(predictions).length, records.length, '每条索引样本都应有预测（夹具是完整形状的事实来源）');

  const result = validatePredictions(records, predictions);
  assert.equal(
    result.ok,
    true,
    `夹具必须通过 schema（通不过说明 schema 抽错了，应改 schema 而非夹具）：${formatPredictionContractErrors(result)}`,
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.checked, records.length);
  assert.equal(result.skippedServiceFailure, 0);
  assert.deepEqual(result.extraIds, []);
});

test('[契约·漂移守卫] schema 的必需字段/枚举与执行体 PREDICTION_TASK_SHAPES、metrics 常量逐一一致', () => {
  const schema = loadJson(join(REPO_ROOT, PREDICTIONS_SCHEMA_PATH));
  for (const task of TASKS) {
    const shape = PREDICTION_TASK_SHAPES[task];
    const def = schema.$defs[shape.schemaDef];
    assert.deepEqual(sorted(def.required ?? []), sorted(shape.required), `${task}：required 与执行体不一致`);
    if (shape.anyOfRequired) {
      assert.ok(Array.isArray(def.anyOf), `${task}：schema 应使用 anyOf 表达"二选一"必需字段`);
      assert.deepEqual(
        def.anyOf.map((branch) => sorted(branch.required ?? [])),
        shape.anyOfRequired.map(sorted),
        `${task}：anyOf 分支必需字段与执行体不一致`,
      );
    }
    if (shape.decisionEnum) {
      assert.deepEqual(def.properties.decision.enum, shape.decisionEnum, `${task}：decision 闭集与执行体不一致`);
    }
  }

  // 枚举的事实来源是 metrics.mjs：契约与评分期真正接受的值必须一致，否则合法预测会被判非法。
  assert.deepEqual(PREDICTION_TASK_SHAPES.weed_photo.decisionEnum, WEED_DECISIONS);
  assert.deepEqual(PREDICTION_TASK_SHAPES.ai_moderation.decisionEnum, MODERATION_DECISIONS);
  assert.deepEqual(WEED_DECISIONS, ['candidate', 'uncertain', 'retake', 'rejected']);
  assert.deepEqual(MODERATION_DECISIONS, ['published', 'blocked', 'pending_review', 'rejected', 'quarantined', 'hidden']);
  // TTS 六项是评分累计项，漏一个就少算一项：必须逐字一致。
  assert.equal(TTS_JUDGEMENT_FIELDS.length, 6);
  assert.deepEqual(sorted(PREDICTION_TASK_SHAPES.tts.required), sorted(TTS_JUDGEMENT_FIELDS));
  assert.deepEqual(sorted(schema.$defs.tts.required), sorted(TTS_JUDGEMENT_FIELDS));
  // 固定字段集也不能悄悄多/少。
  assert.deepEqual(sorted(Object.keys(schema.$defs.ocrFields.properties)), sorted(OCR_FIELD_NAMES));
  assert.deepEqual(sorted(Object.keys(schema.$defs.asrKeyFields.properties)), sorted(ASR_KEY_FIELDS));
});

test('[负控制] 逐任务删掉必需字段 ⇒ CLI exit 1，错误信息点名 sampleId、任务与缺失字段', () => {
  const records = loadJson(INDEX);
  const predictions = loadJson(PREDICTIONS);
  const firstByTask = firstSampleIdByTask(records);

  // 前提：未篡改的夹具必须绿（否则负控制证明不了任何事）。
  assert.equal(runCli(['--index', INDEX, '--predictions', PREDICTIONS, '--json']).exitCode, 0);

  const dir = mkdtempSync(join(tmpdir(), 'gy-r31-i20-contract-'));
  try {
    for (const task of TASKS) {
      const shape = PREDICTION_TASK_SHAPES[task];
      const sampleId = firstByTask.get(task);
      assert.ok(sampleId, `索引中应有 ${task} 样本`);
      const removed = fieldsToRemove(shape, predictions[sampleId]);

      const tampered = { ...predictions };
      const copy = { ...tampered[sampleId] };
      for (const field of removed) delete copy[field];
      tampered[sampleId] = copy;

      const path = join(dir, `bad-${task}.json`);
      writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);

      const run = runCli(['--index', INDEX, '--predictions', path, '--json']);
      assert.notEqual(run.exitCode, 0, `${task}：缺字段必须导致校验失败（exit≠0）`);
      assert.equal(run.exitCode, 1, `${task}：契约失败应以 exit 1 收尾（区别于用法错误 exit 2）`);
      assert.equal(run.report, null, `${task}：契约失败时不得产出报告`);
      assert.equal(run.stdout, '', `${task}：契约失败时不得向 stdout 输出报告`);
      assert.match(run.stderr, /预测不合结构契约/, `${task}：错误信息应说明是结构契约问题`);
      assert.ok(run.stderr.includes(`${sampleId}（${task}）`), `${task}：错误信息应点名 ${sampleId}（${task}）`);
      for (const field of removed) {
        assert.ok(run.stderr.includes(field), `${task}：错误信息应点名缺失字段 ${field}`);
      }
      assert.ok(
        run.stderr.includes('packages/evaluation/schema/predictions.schema.json'),
        `${task}：错误信息应指向契约文件路径`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[负控制·TTS 六项逐一] 删掉 TTS 预测任一字段都必须红，且原因点名该字段', () => {
  const records = loadJson(INDEX);
  const predictions = loadJson(PREDICTIONS);
  const ttsSampleId = firstSampleIdByTask(records).get('tts');
  assert.ok(ttsSampleId);

  const dir = mkdtempSync(join(tmpdir(), 'gy-r31-i20-tts-'));
  try {
    for (const field of TTS_JUDGEMENT_FIELDS) {
      const tampered = { ...predictions };
      const copy = { ...tampered[ttsSampleId] };
      delete copy[field];
      tampered[ttsSampleId] = copy;

      // 进程内校验：精确核对"哪一条、哪个任务、为什么"。
      const result = validatePredictions(records, tampered);
      assert.equal(result.ok, false, `缺 ${field} 时应判非法`);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].sampleId, ttsSampleId);
      assert.equal(result.errors[0].task, 'tts');
      assert.match(result.errors[0].reasons.join('；'), new RegExp(field), `原因应点名 ${field}`);

      // CLI 退出码语义。
      const path = join(dir, `bad-tts-${field}.json`);
      writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
      const run = runCli(['--index', INDEX, '--predictions', path]);
      assert.equal(run.exitCode, 1, `缺 ${field} 时 CLI 应 exit 1`);
      assert.ok(run.stderr.includes(field), `CLI 报错应点名 ${field}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[边界] 服务失败标记跳过形状校验（记 invalid，而非硬失败）；索引外预测只记 extra', () => {
  const records = loadJson(INDEX);
  const predictions = loadJson(PREDICTIONS);
  const ttsSampleId = firstSampleIdByTask(records).get('tts');

  // 服务失败（served=false / error / failed=true）没有判定字段是正常的：一次批量超时不应让整条命令失败。
  for (const marker of [{ served: false }, { error: 'timeout' }, { failed: true }]) {
    const served = { ...predictions, [ttsSampleId]: marker };
    const result = validatePredictions(records, served);
    assert.equal(result.ok, true, `${JSON.stringify(marker)} 应被视为服务失败而非契约违规`);
    assert.equal(result.skippedServiceFailure, 1);
    assert.deepEqual(result.errors, []);
  }

  // CLI 仍跑通（exit 0），但必须在 stderr 明示"跳过了校验"，避免静默放过。
  const dir = mkdtempSync(join(tmpdir(), 'gy-r31-i20-served-'));
  try {
    const path = join(dir, 'served.json');
    writeFileSync(path, `${JSON.stringify({ ...predictions, [ttsSampleId]: { served: false } }, null, 2)}\n`);
    const run = runCli(['--index', INDEX, '--predictions', path, '--json']);
    assert.equal(run.exitCode, 0);
    assert.match(run.stderr, /服务失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 索引外的预测不参与形状校验（任务未知），也不能因此把合法输入判红。
  const extra = { ...predictions, 'syn-not-in-index': { sampleId: 'syn-not-in-index' } };
  const extraResult = validatePredictions(records, extra);
  assert.equal(extraResult.ok, true);
  assert.deepEqual(extraResult.extraIds, ['syn-not-in-index']);
});

test('[负例] 形状全缺（空对象）必须红，且原因点名缺失字段组', () => {
  const records = loadJson(INDEX);
  const predictions = loadJson(PREDICTIONS);
  const qaSampleId = firstSampleIdByTask(records).get('qa');

  const emptied = { ...predictions, [qaSampleId]: {} };
  const result = validatePredictions(records, emptied);
  assert.equal(result.ok, false, '空对象不是合法预测');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].sampleId, qaSampleId);
  assert.match(result.errors[0].reasons.join('；'), /缺少必需字段组/);

  // 单条形状校验也直接可用（不依赖索引），错误信息为中文。
  const shape = validatePredictions([{ sampleId: 'x', task: 'tts' }], { x: {} });
  assert.equal(shape.ok, false);
  assert.match(shape.errors[0].reasons.join('；'), /缺少必需字段/);
});

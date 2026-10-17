// GY-I02 运行期文案如实性回归：钉住**用户可见的运行期字符串**，禁止再次漂移为过期主张。
//
// 本文件对应的实测真值（写断言前逐行复核）：
// - 媒体 HTTP 路由**已注册且可调用**（`services/api/src/routes/media.ts` 的 `registerMediaRoutes`，
//   7 条 operation 与契约对齐）；`real` 模式下未接线的是**真实对象存储 / 私有媒体字节读取**，
//   不是「媒体 HTTP 层」。所以按域媒体端口的默认 `reason` 不得再声称媒体 HTTP 层尚未接线。
// - 各业务域路由**已注册**；未接真实后端者按域 fail-closed（整域 503 `PROVIDER_UNAVAILABLE`，
//   不会以替身数据返回成功）。所以启动日志不得再声称「其余业务路由未实现」。
//
// 断言口径（只钉文案，不重复钉行为）：本文件只断言字符串字面量与其**运行期取值**，
// 状态码 / 错误码 / `retryable` / 控制流由既有反例文件覆盖（`tests/unit/media-real-mode-fail-closed.test.mjs`、
// `tests/unit/ocr-service.test.mjs`、`tests/unit/recognitions-api.test.mjs`、`tests/unit/speech-service.test.mjs`），
// 本文件仅额外钉住「未接线端口仍 fail-closed」这一条与文案直接对应的最小行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createUnwiredMediaPort as createUnwiredOcrMediaPort } from '../../services/api/src/ocr/media.ts';
import { createUnwiredMediaPort as createUnwiredRecognitionMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createUnwiredMediaPort as createUnwiredSpeechMediaPort } from '../../services/api/src/speech/media.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_SRC = join(ROOT, 'services', 'api', 'src');

// 过期主张（本片已改写）：这两个字面只作为「不得再出现」的负控制值使用。
const STALE_STARTUP_CLAIM = '其余业务路由未实现';
const STALE_MEDIA_CLAIM = '媒体 HTTP 层尚未接线';

// 本片钉住的新文案（逐字）。
const MEDIA_REASON_MEDIA_BYTES = '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有媒体字节';
const MEDIA_REASON_SPEECH_BYTES = '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有录音字节';
const MEDIA_NOTE_MEDIA_BYTES = `${MEDIA_REASON_MEDIA_BYTES}（fail-closed）`;
const MEDIA_NOTE_SPEECH_BYTES = `${MEDIA_REASON_SPEECH_BYTES}（fail-closed）`;
const STARTUP_MESSAGE =
  'gengyun api 已启动（认证、后台认证与各业务域路由均已注册；各域真实后端未接线者按域 fail-closed，不以替身数据返回成功）';

const MEDIA_ID = '00000000-0000-4000-8000-000000000001';

function readText(path) {
  return readFileSync(path, 'utf8');
}

function parseSource(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** 收集字符串字面量（含无替换模板字面量），附 1 基行号。 */
function stringLiterals(source) {
  const found = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ text: node.text, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 收集 `app.log.info(...)` 的字符串实参（启动日志的用户可见面）。 */
function logInfoMessages(source) {
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'app.log.info') {
      for (const argument of node.arguments) {
        if (ts.isStringLiteralLike(argument)) found.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 递归枚举目录下所有 `.ts` 源文件。 */
function typescriptSources(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typescriptSources(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

test('运行期文案 · 启动日志如实声称各域路由已注册、未接线者按域 fail-closed', () => {
  const path = join(API_SRC, 'server.ts');
  const source = parseSource(path, readText(path));
  const messages = logInfoMessages(source);

  assert.ok(
    messages.includes(STARTUP_MESSAGE),
    `启动日志缺少钉住的新文案，实测 app.log.info 文案：${JSON.stringify(messages)}`,
  );
  assert.equal(STARTUP_MESSAGE.includes(STALE_STARTUP_CLAIM), false, '新启动文案不得含过期主张');
  assert.equal(STARTUP_MESSAGE.includes('未实现'), false, '新启动文案不得含「未实现」类断言');
  for (const message of messages) {
    assert.equal(
      message.includes(STALE_STARTUP_CLAIM),
      false,
      `启动日志仍含过期主张：${message}`,
    );
  }
  // 负控制：该文件任何字符串字面量都不得再出现旧主张（注释不在断言面内）。
  assert.deepEqual(
    stringLiterals(source)
      .filter((literal) => literal.text.includes(STALE_STARTUP_CLAIM))
      .map((literal) => literal.line),
    [],
    'server.ts 仍存在含过期主张的字符串字面量',
  );
});

test('运行期文案 · 按域未接线媒体端口默认 reason 指向真实对象存储未接，而非媒体 HTTP 层', async () => {
  const cases = [
    { label: 'ocr', port: createUnwiredOcrMediaPort(), note: MEDIA_NOTE_MEDIA_BYTES },
    { label: 'recognitions', port: createUnwiredRecognitionMediaPort(), note: MEDIA_NOTE_MEDIA_BYTES },
    { label: 'speech', port: createUnwiredSpeechMediaPort(), note: MEDIA_NOTE_SPEECH_BYTES },
  ];

  for (const { label, port, note } of cases) {
    assert.equal(port.kind, 'unwired', `${label}: 默认按域媒体端口应仍未接线`);
    assert.equal(port.note, note, `${label}: note 文案`);
    assert.equal(
      port.note.includes(STALE_MEDIA_CLAIM),
      false,
      `${label}: note 仍含过期主张：${port.note}`,
    );

    // 与文案直接对应的最小行为：未接线端口一律 fail-closed（不泄露媒体是否存在）。
    const resolution = await port.resolve({ mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.equal(resolution.ok, false, `${label}: 未接线端口不得放行`);
    assert.equal(resolution.code, 'OBJECT_UNAVAILABLE', `${label}: 未接线端口错误码`);
  }
});

test('运行期文案 · 默认 real 装配下三域 describe() 报告的正是新文案', async (t) => {
  const store = createMemoryAuthStore();
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real' },
    store,
  });
  t.after(() => app.close());

  const views = [
    { label: 'ocr', view: app.ocrService.describe(), note: MEDIA_NOTE_MEDIA_BYTES },
    { label: 'recognitions', view: app.recognitionService.describe(), note: MEDIA_NOTE_MEDIA_BYTES },
    { label: 'speech', view: app.speechService.describe(), note: MEDIA_NOTE_SPEECH_BYTES },
  ];

  for (const { label, view, note } of views) {
    assert.equal(view.mediaPort, 'unwired', `${label}: 该域媒体端口仍未接线`);
    assert.equal(view.mediaNote, note, `${label}: 该域运行期媒体说明文案`);
    // 默认 real 装配下真实凭据缺席 ⇒ 该域先于媒体端口 fail-closed（与启动日志措辞一致）。
    assert.equal(view.providerAvailable, false, `${label}: 默认 real 装配不应有可用真实供应商`);
  }

  // 兄弟域（合成域）文案准确，本片未改，这里钉住它不被顺手改动。
  assert.equal(
    app.synthesisService.describe().mediaNote,
    '真实对象存储尚未接线，无法存放合成产物（fail-closed）',
    'tts: 该域文案本片不应改动',
  );
});

test('运行期文案 · 全仓运行期字符串零残留过期主张（AST 扫描 services/api/src）', () => {
  const hits = [];
  for (const path of typescriptSources(API_SRC)) {
    const source = parseSource(path, readText(path));
    for (const literal of stringLiterals(source)) {
      if (literal.text.includes(STALE_STARTUP_CLAIM) || literal.text.includes(STALE_MEDIA_CLAIM)) {
        hits.push(`${path.slice(ROOT.length)}:${literal.line}`);
      }
    }
  }
  assert.deepEqual(hits, [], `仍有运行期字符串含过期主张：${hits.join(', ')}`);
});

/**
 * 录音端口：平台没给容器名时的容器判定（微信开发者工具不回传 `format`）。
 *
 * 为什么需要这条钉子：开发者工具里 `wx.getRecorderManager().start({format:'wav'})` 的
 * `onStop` 回传 `{tempFilePath, duration, fileSize}`——**没有 `format` 字段**（真机有）。
 * 端口原先把三要素校验写死成「`res.format` 必须是 mp3/wav/aac 之一」，于是在工具里
 * 无论人怎么说话都必然失败，页面只能显示「录音未能完成（平台未返回可用产物）」。
 *
 * 这里钉住的是：**只由平台自己给的文件名后缀**补全容器名，且补全结果仍受同一允许集合约束；
 * 已知容器名时以平台回传为准，不让后缀覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT_SOURCE = readFileSync(join(ROOT, 'miniprogram', 'utils', 'recorder-port.js'), 'utf8');

/** 平台壳层：只提供端口会用到的三件事（授权查询、录音管理器、授权跳转）。 */
function fakeWx(manager) {
  return {
    getRecorderManager: () => manager,
    getSetting(options) {
      // 端口读 `authSetting['scope.record']`：true=已授权，false=被拒，缺键=未知。
      options.success({ authSetting: { 'scope.record': true } });
    },
    authorize(options) { options.success({}) },
    openSetting(options) { options.success({ authSetting: { 'scope.record': true } }) }
  };
}

/** 在受控沙箱里加载端口模块；`wx` 由每个用例自己给。 */
function loadPort(wx) {
  const sandbox = { module: { exports: {} }, exports: {}, wx, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(PORT_SOURCE, sandbox, { filename: 'recorder-port.js' });
  return sandbox.module.exports;
}

/** 可观测的假录音管理器：记录 start 入参，允许用例手动触发 onStop / onError。 */
function fakeManager() {
  const handlers = { stop: null, error: null };
  const state = { startArgs: null };
  return {
    state,
    manager: {
      start(options) { state.startArgs = options },
      stop() {},
      onStop(fn) { handlers.stop = fn },
      onError(fn) { handlers.error = fn },
      onInterruptionBegin() {}
    },
    emitStop(result) { if (handlers.stop !== null) handlers.stop(result) },
    emitError(error) { if (handlers.error !== null) handlers.error(error) }
  };
}

test('平台不回传 format 时按文件名后缀补全（.wav ⇒ audio/wav）', async () => {
  const fake = fakeManager();
  const { createRecorderPort } = loadPort(fakeWx(fake.manager));
  const port = createRecorderPort();
  assert.equal(port.available, true);

  await port.start();
  assert.equal(fake.state.startArgs.format, 'wav', '页面要求的容器是 WAV（ASR 档位冻结值）');
  // 平台**自行**停止（录满/被系统回收）：产物先落槽，下一次 stop() 如实交出。
  fake.emitStop({ tempFilePath: 'http://tmp/abc.wav', duration: 3003, fileSize: 66164 });

  const result = await port.stop();
  assert.equal(result.ok, true);
  assert.equal(result.format, 'wav');
  assert.equal(result.mime, 'audio/wav');
  assert.equal(result.durationMs, 3003);
});

test('后缀不在允许集合内仍然如实失败（不把未知容器猜成 WAV）', async () => {
  const fake = fakeManager();
  const { createRecorderPort } = loadPort(fakeWx(fake.manager));
  const port = createRecorderPort();

  await port.start();
  fake.emitStop({ tempFilePath: 'http://tmp/abc.amr', duration: 3003, fileSize: 1024 });

  const result = await port.stop();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RECORD_FAILED');
});

test('平台回传了 format 时以平台为准，不被后缀覆盖', async () => {
  const fake = fakeManager();
  const { createRecorderPort } = loadPort(fakeWx(fake.manager));
  const port = createRecorderPort();

  await port.start();
  fake.emitStop({ tempFilePath: 'http://tmp/abc.wav', duration: 1500, fileSize: 48044, format: 'mp3' });

  const result = await port.stop();
  assert.equal(result.ok, true);
  assert.equal(result.format, 'mp3');
  assert.equal(result.mime, 'audio/mpeg');
});

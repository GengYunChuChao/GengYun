import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAudioDurationMs,
  wavDurationMs,
  adtsDurationMs,
  mpegDurationMs,
  m4aDurationMs,
} from '../../packages/media/audio.mjs';
import { assertBytesMatchDeclaration, sha256Hex } from '../../packages/media/validate.mjs';
import {
  pcmWav,
  wavBytes,
  wav61Seconds,
  wavTruncated,
  aacBytes,
  mp3Bytes,
  m4aBytes,
  wavTamperedByteRate,
  wavUnalignedData,
  wavEmptyData,
  mp3FakeHeaderOnly,
  mp3TruncatedFrame,
  m4aNoTrack,
} from './_fixtures.mjs';

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `期望 ${code}，实得 ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`应当抛出 ${code}，但未抛出`);
}

// ------------------------------------------------------------ 逐容器解析

test('WAV：真实时长由 fmt.byteRate 与 data 长度决定', () => {
  const oneSec = wavBytes();
  assert.equal(wavDurationMs(oneSec).durationMs, 1000);
  const half = pcmWav({ dataBytes: 8000 * 2 * 0.5 }); // 0.5s
  assert.equal(wavDurationMs(half).durationMs, 500);
});

test('WAV：截断（data 声明超出实际）被识别为不可验证', () => {
  const r = wavDurationMs(wavTruncated());
  assert.equal(r.ok, false);
});

test('ADTS：多帧按样本累计（1024/帧）', () => {
  const r = adtsDurationMs(aacBytes({ frames: 2 }));
  assert.equal(r.ok, true);
  assert.equal(r.durationMs, Math.round((2048 / 44100) * 1000));
});

test('MPEG：逐帧累计样本数（MPEG1 L3 = 1152/帧）', () => {
  const r = mpegDurationMs(mp3Bytes({ frames: 5 }));
  assert.equal(r.ok, true);
  assert.equal(r.durationMs, Math.round((5 * 1152 * 1000) / 44100));
});

test('M4A：moov>mvhd 的 duration/timescale', () => {
  assert.equal(m4aDurationMs(m4aBytes({ durationMs: 3000 })).durationMs, 3000);
});

test('computeAudioDurationMs：按容器分派，未知容器失败', () => {
  assert.equal(computeAudioDurationMs(wavBytes()).container, 'wav');
  assert.equal(computeAudioDurationMs(aacBytes()).container, 'adts');
  assert.equal(computeAudioDurationMs(mp3Bytes()).container, 'mpeg');
  assert.equal(computeAudioDurationMs(m4aBytes()).container, 'm4a');
  assert.equal(computeAudioDurationMs(new Uint8Array([1, 2, 3, 4, 5, 6])).ok, false);
});

// ------------------------------------------- 接入上传完成校验（B2 回归）

test('B2 虚报：实际 61s、声明 1000ms → 拒绝（真实时长参与上限判断，不再 ready）', () => {
  const bytes = wav61Seconds();
  expectCode(
    () =>
      assertBytesMatchDeclaration({
        bytes,
        declared: {
          mime: 'audio/wav',
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          purpose: 'voice_question',
          duration_ms: 1000,
        },
      }),
    'INVALID_REQUEST',
  );
});

test('B2 真实超时长：声明本身也已超限的场景由真实时长兜底', () => {
  const bytes = wav61Seconds();
  const err = expectCode(
    () =>
      assertBytesMatchDeclaration({
        bytes,
        declared: {
          mime: 'audio/wav',
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          purpose: 'voice_question',
          duration_ms: 60000,
        },
      }),
    'INVALID_REQUEST',
  );
  assert.ok(err.details.some((d) => d.code === 'out_of_range'), `details=${JSON.stringify(err.details)}`);
});

test('B2 合法：真实时长 1000ms 且声明一致 → 通过并回传真实时长', () => {
  const bytes = wavBytes();
  const out = assertBytesMatchDeclaration({
    bytes,
    declared: {
      mime: 'audio/wav',
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      purpose: 'voice_question',
      duration_ms: 1000,
    },
  });
  assert.equal(out.mime, 'audio/wav');
  assert.equal(out.durationMs, 1000);
});

test('B2 无法验证：损坏/截断音频 → 受控拒绝', () => {
  const bytes = wavTruncated();
  const err = expectCode(
    () =>
      assertBytesMatchDeclaration({
        bytes,
        declared: {
          mime: 'audio/wav',
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          purpose: 'voice_question',
          duration_ms: 500,
        },
      }),
    'INVALID_REQUEST',
  );
  assert.ok(err.details.some((d) => d.code === 'duration_unverifiable'), `details=${JSON.stringify(err.details)}`);
});

// ------------------------------------------- C1：WAV/MP3/M4A 结构核对回归

test('C1 WAV：篡改 fmt.byteRate 使字段不自洽 → 拒绝（不再直接信任头部 byteRate）', () => {
  const bytes = wavTamperedByteRate();
  const r = wavDurationMs(bytes);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'inconsistent_fmt_byte_rate');
});

test('C1 WAV：data 长度非 blockAlign 整数倍（帧不对齐）→ 拒绝', () => {
  const r = wavDurationMs(wavUnalignedData());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'data_not_frame_aligned');
});

test('C1 WAV：data 为空 → 拒绝', () => {
  const r = wavDurationMs(wavEmptyData());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_data');
});

test('C1 MP3：仅 4 字节合法帧头（无帧负载）→ 拒绝，不得算出 26ms', () => {
  const bytes = mp3FakeHeaderOnly();
  const r = mpegDurationMs(bytes);
  assert.equal(r.ok, false);
});

test('C1 MP3：第二帧被截断 → 拒绝', () => {
  const bytes = mp3TruncatedFrame();
  const r = mpegDurationMs(bytes);
  assert.equal(r.ok, false);
});

test('C1 M4A：有 mvhd 但无任何音轨 → 拒绝', () => {
  const r = m4aDurationMs(m4aNoTrack());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_audio_track');
});

test('C1 接入：伪 MP3 头声明时长 → 受控拒绝（duration_unverifiable）', () => {
  const bytes = mp3FakeHeaderOnly();
  const err = expectCode(
    () =>
      assertBytesMatchDeclaration({
        bytes,
        declared: {
          mime: 'audio/mpeg',
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          purpose: 'voice_question',
          duration_ms: 26,
        },
      }),
    'INVALID_REQUEST',
  );
  assert.ok(err.details.some((d) => d.code === 'duration_unverifiable'), `details=${JSON.stringify(err.details)}`);
});

test('C1 接入：无音轨 M4A 声明时长 → 受控拒绝（duration_unverifiable）', () => {
  const bytes = m4aNoTrack();
  const err = expectCode(
    () =>
      assertBytesMatchDeclaration({
        bytes,
        declared: {
          mime: 'audio/aac',
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          purpose: 'voice_question',
          duration_ms: 1000,
        },
      }),
    'INVALID_REQUEST',
  );
  assert.ok(err.details.some((d) => d.code === 'duration_unverifiable'), `details=${JSON.stringify(err.details)}`);
});

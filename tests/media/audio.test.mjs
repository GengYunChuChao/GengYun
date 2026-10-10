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
  m4aNoSampleEntry,
  m4aNoHdlr,
  m4aVideoHandler,
  m4aNoMdat,
  m4aNoStsz,
  m4aBareEmptyStsd,
  m4aNoStco,
  m4aNoStts,
  m4aEmptyMdat,
  m4aSttsEntryCountMismatch,
  m4aSttsSampleCountMismatch,
  m4aSamplesExceedMdat,
  m4aChunkOffsetOutsideMdat,
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

test('M4A：音轨 mdhd/stts 的真实时长（D1：不再取容器 mvhd）', () => {
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

// ------------------------------------------- D1：M4A 有效音轨与样本结构回归

test('D1 正例：mdat + 音频轨（hdlr=soun）+ mdhd + stsd 真实 entry + 样本表 → 通过', () => {
  const r = m4aDurationMs(m4aBytes({ durationMs: 2000 }));
  assert.equal(r.ok, true);
  assert.equal(r.durationMs, 2000);
});

test('D1 M4A：stsd.entry_count=1 但无真实 sample entry（空壳）→ 拒绝', () => {
  const r = m4aDurationMs(m4aNoSampleEntry());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_audio_track');
});

test('D1 M4A：缺 hdlr → 无法确认音频轨道 → 拒绝', () => {
  assert.equal(m4aDurationMs(m4aNoHdlr()).ok, false);
});

test('D1 M4A：hdlr=vide（视频轨）→ 拒绝', () => {
  assert.equal(m4aDurationMs(m4aVideoHandler()).ok, false);
});

test('D1 M4A：无 mdat（无媒体数据）→ 拒绝', () => {
  const r = m4aDurationMs(m4aNoMdat());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_mdat');
});

test('D1 M4A：缺样本定位表 stsz → 拒绝', () => {
  assert.equal(m4aDurationMs(m4aNoStsz()).ok, false);
});

test('D1 接入：空壳 stsd（entry_count=1 无 entry）声明时长 → 受控拒绝', () => {
  const bytes = m4aNoSampleEntry();
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

test('D1 复现监工原始构造：mvhd + 空 stsd（无 hdlr/mdhd/样本表/mdat）→ 拒绝', () => {
  const r = m4aDurationMs(m4aBareEmptyStsd());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_mdat');
});

// ------------------------------------------- E1：样本表真实性与 mdat 内容一致性

test('E1 M4A 正例：结构自洽（样本表互相一致且落在 mdat 内）→ 通过并给出真实时长', () => {
  for (const durationMs of [500, 1000, 3000]) {
    const r = m4aDurationMs(m4aBytes({ durationMs }));
    assert.equal(r.ok, true, `durationMs=${durationMs} 应通过`);
    assert.equal(r.durationMs, durationMs);
  }
});

test('E1 M4A 反例①（监工构造）：mdat box 存在但负载被删空（size→8）→ 拒绝，不判 ready', () => {
  const bytes = m4aEmptyMdat();
  const r = m4aDurationMs(bytes);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_mdat');
});

test('E1 M4A 反例②（监工构造）：stts.entry_count=2 却只有 1 条条目 → 时间表不可核验 → 拒绝', () => {
  const r = m4aDurationMs(m4aSttsEntryCountMismatch());
  assert.equal(r.ok, false, '不得回退信任 mvhd 时长');
});

test('E1 M4A：stts 累计样本数与 stsz.sample_count 不一致 → 拒绝', () => {
  assert.equal(m4aDurationMs(m4aSttsSampleCountMismatch()).ok, false);
});

test('E1 M4A：样本总字节超过 mdat 负载 → 拒绝', () => {
  assert.equal(m4aDurationMs(m4aSamplesExceedMdat()).ok, false);
});

test('E1 M4A：stco chunk 偏移落在 mdat 负载之外 → 拒绝', () => {
  assert.equal(m4aDurationMs(m4aChunkOffsetOutsideMdat()).ok, false);
});

test('E1 M4A：缺 stco / stts → 拒绝', () => {
  assert.equal(m4aDurationMs(m4aNoStco()).ok, false);
  assert.equal(m4aDurationMs(m4aNoStts()).ok, false);
});

test('E1 接入：空 mdat 的 M4A 声明时长 → 受控拒绝（duration_unverifiable）', () => {
  const bytes = m4aEmptyMdat();
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

test('E1 接入：stts 条目数不符的 M4A 声明时长 → 受控拒绝（duration_unverifiable）', () => {
  const bytes = m4aSttsEntryCountMismatch();
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

test('E1 接入：结构自洽的 M4A → 通过并回传真实时长', () => {
  const bytes = m4aBytes({ durationMs: 1500 });
  const out = assertBytesMatchDeclaration({
    bytes,
    declared: {
      mime: 'audio/aac',
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      purpose: 'voice_question',
      duration_ms: 1500,
    },
  });
  assert.equal(out.durationMs, 1500);
});

test('E1 接入：真实时长 61s 的 M4A（声明 1000ms）→ 拒绝（真实时长参与上限判断）', () => {
  const bytes = m4aBytes({ durationMs: 61000 });
  expectCode(
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
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { m4aDurationMs } from '../../packages/media/audio.mjs';
import { decodeVp8l } from '../../packages/media/webp.mjs';
import { createMediaService } from '../../packages/media/service.mjs';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { m4aBytes, webpPlainLossless } from './_fixtures.mjs';

// Supervisor's exact invalid VP8L bitstream: repeated SUBTRACT_GREEN.
const duplicateTransform = Buffer.from('524946461a000000574542505650384c0d0000002f000000002d0a508002f4bf0000', 'hex');

function upload(bytes, image = false) {
  const service = createMediaService({ tokenSecret: 'synthetic-pr60-secret-0123456789' });
  const sha256 = sha256Hex(bytes);
  const input = { purpose: image ? 'weed_recognition' : 'voice_question',
    mime: image ? 'image/webp' : 'audio/aac', bytes: bytes.length, sha256,
    ...(image ? {} : { duration_ms: 1000 }) };
  const { media } = service.initiateUpload({ ownerId: 'synthetic-owner', input, idempotencyKey: 'start' });
  return { service, complete: () => service.completeUpload({ ownerId: 'synthetic-owner',
    mediaId: media.id, ifMatch: '"1"', input: { bytes: bytes.length, sha256 }, body: bytes,
    idempotencyKey: 'complete' }) };
}

function rejectAndClean(bytes, image = false) {
  const { service, complete } = upload(bytes, image);
  assert.throws(complete, (e) => e.code === (image ? 'MEDIA_TYPE_UNSUPPORTED' : 'INVALID_REQUEST'));
  assert.equal(service.stats().objectCount, 0);
}

test('M4A: supervisor sample starts inside mdat but ends outside; reject and reclaim', () => {
  const bytes = m4aBytes({ sampleCount: 1, sampleSize: 16, mdatBytes: 16,
    stcoOffset: 39, sttsEntries: [[1, 44100]] });
  assert.equal(m4aDurationMs(bytes).ok, false);
  rejectAndClean(bytes);
});

test('M4A: each variable-sized sample belongs to its own chunk', () => {
  const options = { sampleCount: 4, sampleSizes: [2, 3, 4, 3],
    chunkOffsets: [24, 29], stscEntries: [[1, 2, 1]], sttsEntries: [[4, 11025]] };
  for (const useCo64 of [false, true]) {
    const bytes = m4aBytes({ ...options, useCo64 });
    assert.equal(m4aDurationMs(bytes).durationMs, 1000);
    assert.equal(upload(bytes).complete().state, 'ready');
    const shifted = m4aBytes({ ...options, useCo64, chunkOffsets: [24, 30] });
    assert.equal(m4aDurationMs(shifted).ok, false);
    rejectAndClean(shifted);
  }
});

test('M4A: stsc runs map different counts and sample descriptions must exist', () => {
  const options = { sampleCount: 4, sampleSizes: [2, 3, 4, 3],
    chunkOffsets: [24, 26], stscEntries: [[1, 1, 1], [2, 3, 1]], sttsEntries: [[4, 11025]] };
  assert.equal(upload(m4aBytes(options)).complete().state, 'ready');
  const invalid = [
    { withStsc: false }, { stscDeclaredCount: 2, stscEntries: [[1, 4, 1]] },
    { stscEntries: [[2, 4, 1]] }, { stscEntries: [[1, 0, 1]] },
    { stscEntries: [[1, 4, 0]] }, { stscEntries: [[1, 4, 2]] },
    { stscEntries: [[1, 4, 1], [1, 1, 1]] }, { stscEntries: [[1, 4, 1], [2, 1, 1]] },
    { stscEntries: [[1, 3, 1]] }, { stscEntries: [[1, 5, 1]] },
  ];
  for (const change of invalid) {
    const bytes = m4aBytes({ sampleCount: 4, sttsEntries: [[4, 11025]], ...change });
    assert.equal(m4aDurationMs(bytes).ok, false, JSON.stringify(change));
    rejectAndClean(bytes);
  }
});

test('M4A: chunks cannot overlap or reference a zero-length sample', () => {
  for (const change of [
    { sampleSizes: [2, 3, 4, 3], chunkOffsets: [24, 28] },
    { sampleSizes: [2, 0, 4, 3], chunkOffsets: [24, 26] },
  ]) {
    const bytes = m4aBytes({ sampleCount: 4, stscEntries: [[1, 2, 1]],
      sttsEntries: [[4, 11025]], ...change });
    assert.equal(m4aDurationMs(bytes).ok, false);
    rejectAndClean(bytes);
  }
});

test('WebP: supervisor repeated SUBTRACT_GREEN rejects at decoder and upload boundaries', () => {
  assert.equal(decodeVp8l(duplicateTransform.subarray(20, 33)).ok, false);
  rejectAndClean(duplicateTransform, true);
  const { service, complete } = upload(webpPlainLossless(), true);
  assert.equal(complete().state, 'ready');
  assert.equal(service.stats().objectCount, 2);
});

test('M4A: fixed sizes map multiple chunks and multiple runs', () => {
  for (const useCo64 of [false, true]) {
    const bytes = m4aBytes({ sampleCount: 4, sampleSize: 3, chunkOffsets: [24, 27],
      stscEntries: [[1, 1, 1], [2, 3, 1]], sttsEntries: [[4, 11025]], useCo64 });
    assert.equal(m4aDurationMs(bytes).durationMs, 1000);
    assert.equal(upload(bytes).complete().state, 'ready');
  }
});

test('M4A: reference the indexed audio description, not just the first entry', () => {
  const options = { sampleCount: 1, sttsEntries: [[1, 44100]],
    stsdEntryCount: 2, sampleFormats: ['zzzz', 'mp4a'] };
  assert.equal(upload(m4aBytes({ ...options, stscEntries: [[1, 1, 2]] })).complete().state, 'ready');
  const invalid = m4aBytes({ ...options, stscEntries: [[1, 1, 1]] });
  assert.equal(m4aDurationMs(invalid).ok, false);
  rejectAndClean(invalid);
});

function mutateWord(bytes, type, relativeOffset, value) {
  const result = Buffer.from(bytes);
  const typeOffset = result.indexOf(Buffer.from(type));
  assert.ok(typeOffset >= 4);
  result.writeUInt32BE(value, typeOffset + 4 + relativeOffset);
  return result;
}

test('M4A: table counts and full-box versions must match actual entries', () => {
  const bytes = m4aBytes({ sampleCount: 2, sampleSizes: [1, 1], sttsEntries: [[2, 22050]] });
  for (const [type, offset, value] of [
    ['stsd', 4, 2], ['stsz', 8, 1], ['stsz', 8, 3], ['stco', 4, 2],
    ['stsc', 4, 0], ['stsc', 4, 2],
    ...['stsd', 'stsz', 'stco', 'stsc'].map((type) => [type, 0, 0x01000000]),
  ]) {
    const invalid = mutateWord(bytes, type, offset, value);
    assert.equal(m4aDurationMs(invalid).ok, false, `${type}/${offset}/${value}`);
    rejectAndClean(invalid);
  }
});

test('M4A: unsafe co64 offsets and sample byte totals reject without allocation', () => {
  const bytes = m4aBytes({ sampleCount: 1, useCo64: true, sttsEntries: [[1, 44100]] });
  const hugeOffset = mutateWord(bytes, 'co64', 8, 0x00200000);
  const hugeSize = mutateWord(mutateWord(bytes, 'stsz', 4, 0xffffffff), 'stsz', 8, 0xffffffff);
  for (const invalid of [hugeOffset, hugeSize]) {
    assert.equal(m4aDurationMs(invalid).ok, false);
    rejectAndClean(invalid);
  }
});

test('WebP: one SUBTRACT_GREEN remains accepted, two are rejected', () => {
  const one = webpPlainLossless({ subtractGreenTransforms: 1 });
  assert.equal(upload(one, true).complete().state, 'ready');
  const two = webpPlainLossless({ subtractGreenTransforms: 2 });
  rejectAndClean(two, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateUploadInput,
  validateCompleteInput,
  assertBytesMatchDeclaration,
  sha256Hex,
} from '../../packages/media/validate.mjs';
import { MIB } from '../../packages/media/constants.mjs';
import { jpegWithExif, pngWithExif, wavBytes, aacBytes } from './_fixtures.mjs';

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `期望 ${code}，实得 ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`应当抛出 ${code}，但未抛出`);
}

const jpeg = jpegWithExif();
const png = pngWithExif();
const jpegSha = sha256Hex(jpeg);
const pngSha = sha256Hex(png);

test('合法上传声明通过并归一化', () => {
  const out = validateUploadInput({
    purpose: 'weed_recognition',
    mime: 'image/jpeg',
    bytes: jpeg.length,
    sha256: jpegSha,
  });
  assert.equal(out.purpose, 'weed_recognition');
  assert.equal(out.duration_ms, null);
});

test('未知用途 -> INVALID_REQUEST', () => {
  expectCode(() => validateUploadInput({ purpose: 'nope', mime: 'image/jpeg', bytes: 1, sha256: jpegSha }), 'INVALID_REQUEST');
});

test('音频用于识别用途 -> MEDIA_TYPE_UNSUPPORTED(415)', () => {
  expectCode(
    () => validateUploadInput({ purpose: 'weed_recognition', mime: 'audio/wav', bytes: 10, sha256: jpegSha }),
    'MEDIA_TYPE_UNSUPPORTED',
  );
});

test('超过用途字节上限 -> MEDIA_TOO_LARGE(413)（识别 2MiB）', () => {
  expectCode(
    () => validateUploadInput({ purpose: 'weed_recognition', mime: 'image/jpeg', bytes: 2 * MIB + 1, sha256: jpegSha }),
    'MEDIA_TOO_LARGE',
  );
});

test('语音缺 duration_ms -> INVALID_REQUEST', () => {
  expectCode(
    () => validateUploadInput({ purpose: 'voice_question', mime: 'audio/wav', bytes: 10, sha256: jpegSha }),
    'INVALID_REQUEST',
  );
});

test('语音 duration_ms 超 60 秒 -> INVALID_REQUEST', () => {
  expectCode(
    () =>
      validateUploadInput({ purpose: 'voice_question', mime: 'audio/wav', bytes: 10, duration_ms: 60001, sha256: jpegSha }),
    'INVALID_REQUEST',
  );
});

test('图片携带 duration_ms -> INVALID_REQUEST', () => {
  expectCode(
    () => validateUploadInput({ purpose: 'weed_recognition', mime: 'image/jpeg', bytes: 10, duration_ms: 5, sha256: jpegSha }),
    'INVALID_REQUEST',
  );
});

test('sha256 格式非法 -> INVALID_REQUEST', () => {
  expectCode(() => validateUploadInput({ purpose: 'weed_recognition', mime: 'image/jpeg', bytes: 10, sha256: 'xyz' }), 'INVALID_REQUEST');
});

test('社区第 4 张图片 -> INVALID_REQUEST（每帖 ≤3）', () => {
  expectCode(
    () =>
      validateUploadInput(
        { purpose: 'community_image', mime: 'image/jpeg', bytes: 10, sha256: jpegSha },
        { mediaCountForPost: 3 },
      ),
    'INVALID_REQUEST',
  );
});

test('完成上传声明校验', () => {
  assert.deepEqual(validateCompleteInput({ sha256: jpegSha, bytes: jpeg.length }), { sha256: jpegSha, bytes: jpeg.length });
  expectCode(() => validateCompleteInput({ sha256: 'bad', bytes: 1 }), 'INVALID_REQUEST');
});

test('伪扩展名：PNG 谎报 image/jpeg -> 415', () => {
  expectCode(
    () => assertBytesMatchDeclaration({ bytes: png, declared: { mime: 'image/jpeg', bytes: png.length, sha256: pngSha, purpose: 'weed_recognition' } }),
    'MEDIA_TYPE_UNSUPPORTED',
  );
});

test('真实类型与字节数/哈希不符 -> INVALID_REQUEST', () => {
  expectCode(
    () => assertBytesMatchDeclaration({ bytes: jpeg, declared: { mime: 'image/jpeg', bytes: jpeg.length + 1, sha256: jpegSha, purpose: 'weed_recognition' } }),
    'INVALID_REQUEST',
  );
  expectCode(
    () => assertBytesMatchDeclaration({ bytes: jpeg, declared: { mime: 'image/jpeg', bytes: jpeg.length, sha256: 'a'.repeat(64), purpose: 'weed_recognition' } }),
    'INVALID_REQUEST',
  );
});

test('实际上传超出用途上限 -> MEDIA_TOO_LARGE(413)', () => {
  const big = new Uint8Array(2 * MIB + 10);
  big.set(wavBytes(), 0);
  expectCode(
    () =>
      assertBytesMatchDeclaration({
        bytes: big,
        declared: { mime: 'audio/wav', bytes: big.length, sha256: sha256Hex(big), purpose: 'weed_recognition' },
      }),
    'MEDIA_TOO_LARGE',
  );
});

test('无法识别真实编码（伪装的非媒体文件）-> 415', () => {
  const junk = new Uint8Array([0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e, 0, 0, 0, 0]);
  expectCode(
    () =>
      assertBytesMatchDeclaration({
        bytes: junk,
        declared: { mime: 'image/jpeg', bytes: junk.length, sha256: sha256Hex(junk), purpose: 'weed_recognition' },
      }),
    'MEDIA_TYPE_UNSUPPORTED',
  );
});

test('合法 AAC 通过语音用途', () => {
  const aac = aacBytes();
  const detected = assertBytesMatchDeclaration({
    bytes: aac,
    declared: { mime: 'audio/aac', bytes: aac.length, sha256: sha256Hex(aac), purpose: 'voice_question' },
  });
  assert.equal(detected.mime, 'audio/aac');
});

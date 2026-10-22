// GY-R28 W12 媒体持久化 · object_ref_cipher 加密键层（单测）。
//
// 事实依据（`services/api/db/migrations/0001_initial_schema.sql`）：
//   `media.object_ref_cipher text NOT NULL`（:181）、`media_derivatives.object_ref_cipher text NOT NULL`（:196）。
// 列里落的是**密文**，所以这一层是 PG 仓储的前置条件：没有它，媒体行根本 INSERT 不进去
// （`NOT NULL`），或者只能明文冒充密文——两者都不允许。
//
// 断言口径：先判「能不能解开」，再判「错的时候必须抛而不是猜」，最后判键的 fail-closed。
// 不写「不抛就算过」的写法：认证失败、换键、改一个字节、换 AAD 都必须**抛错**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  MEDIA_OBJECT_REF_KEY_FIELD,
  MediaObjectRefCipherError,
  MediaObjectRefKeyError,
  createObjectRefCipher,
  parseObjectRefKeyMaterial,
} from '../../services/api/src/media/object-ref-cipher.ts';

/** 三种等价的 32 字节键表示（文件头声明的三种形状）。 */
const HEX_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f01a2b3c4d5e6f708192a3b4c5d6e7f809';
const BASE64_KEY = Buffer.from(HEX_KEY, 'hex').toString('base64');
const UTF8_KEY = 'gengyun-media-object-refkey-32by';

test('GY-R28 W12 object_ref_cipher：键的三种等价表示与 fail-closed 解析', async (t) => {
  await t.test('64 位十六进制 / 32 字节 base64 / 32 字节 UTF-8 三种表示解码出**同一把**键', () => {
    const fromHex = parseObjectRefKeyMaterial(HEX_KEY);
    const fromBase64 = parseObjectRefKeyMaterial(BASE64_KEY);
    const fromUtf8 = parseObjectRefKeyMaterial(UTF8_KEY);
    assert.equal(fromHex.length, 32);
    assert.deepEqual(fromBase64, fromHex);
    assert.equal(fromUtf8.length, 32);
    // 交叉验证「真的同一把」：一种表示加密、另一种表示能解开。
    const a = createObjectRefCipher(HEX_KEY);
    const b = createObjectRefCipher(BASE64_KEY);
    assert.equal(b.decryptObjectRef(a.encryptObjectRef('obj_raw_1')), 'obj_raw_1');
  });

  await t.test('键缺失（undefined / null / 空串 / 纯空白）⇒ MediaObjectRefKeyError，且文案点名配置键', () => {
    for (const missing of [undefined, null, '', '   ', 0, {}]) {
      assert.throws(
        () => createObjectRefCipher(missing),
        (error) => {
          assert.ok(error instanceof MediaObjectRefKeyError, `应为 MediaObjectRefKeyError，实得 ${error?.name}`);
          assert.equal(error.name, 'MediaObjectRefKeyError');
          assert.ok(error.message.includes(MEDIA_OBJECT_REF_KEY_FIELD), error.message);
          assert.ok(error.message.includes('缺失'), error.message);
          return true;
        },
      );
    }
  });

  await t.test('键形状非法（长度不对 / 随机口令）⇒ MediaObjectRefKeyError，不做「sha256 一下」的宽松推导', () => {
    for (const invalid of [
      'short-key',
      'a'.repeat(63),
      'z'.repeat(64),
      'a'.repeat(65),
      'my-very-secret-passphrase-with-31b',
      'my-very-secret-passphrase-with-33bb',
    ]) {
      assert.throws(
        () => parseObjectRefKeyMaterial(invalid),
        (error) => {
          assert.ok(error instanceof MediaObjectRefKeyError, `${invalid} → ${error?.name}`);
          assert.ok(error.message.includes('形状非法'), error.message);
          return true;
        },
      );
    }
  });
});

test('GY-R28 W12 object_ref_cipher：信封往返、随机 IV、认证绑定与「已清空」编码', async (t) => {
  const cipher = createObjectRefCipher(HEX_KEY);

  await t.test('往返：对象键原样解回；信封是 v1 四段 base64url，且不含明文键', () => {
    const objectRef = 'obj/2026/10/22/raw_7c1f0d9e-4a2b-4c3d-8e9f-0123456789ab';
    const envelope = cipher.encryptObjectRef(objectRef);
    assert.equal(cipher.decryptObjectRef(envelope), objectRef);
    const parts = envelope.split('.');
    assert.equal(parts.length, 4, envelope);
    assert.equal(parts[0], 'v1');
    for (const part of parts.slice(1)) assert.match(part, /^[A-Za-z0-9_-]+$/, envelope);
    assert.ok(!envelope.includes('obj/'), '密文里不得出现明文对象键');
    assert.ok(!envelope.includes('raw_7c1f0d9e'), '密文里不得出现对象键片段');
    assert.equal(cipher.kind, 'aes-256-gcm');
  });

  await t.test('同一明文两次加密得到不同信封（IV 随机），两者都能解回同一明文', () => {
    const first = cipher.encryptObjectRef('obj_same_ref');
    const second = cipher.encryptObjectRef('obj_same_ref');
    assert.notEqual(first, second);
    assert.equal(cipher.decryptObjectRef(first), 'obj_same_ref');
    assert.equal(cipher.decryptObjectRef(second), 'obj_same_ref');
  });

  await t.test('「无对象键」编码为 encrypt(\'\') 的密文，解密还原为 null（列 NOT NULL 与隐私红线的兼容点）', () => {
    const cleared = cipher.encryptObjectRef('');
    assert.notEqual(cleared, '', '不得把空串直接写进密文列');
    assert.equal(cipher.decryptObjectRef(cleared), null);
    // 与「真实键」在同一列上可区分：真实键解出字符串，清空态解出 null。
    assert.equal(cipher.decryptObjectRef(cipher.encryptObjectRef('obj_x')), 'obj_x');
  });

  await t.test('换键 ⇒ 认证失败抛 MediaObjectRefCipherError（不猜、不回退明文）', () => {
    const envelope = cipher.encryptObjectRef('obj_owned_by_first_key');
    const otherKey = createObjectRefCipher('1'.repeat(64));
    assert.throws(
      () => otherKey.decryptObjectRef(envelope),
      (error) => {
        assert.ok(error instanceof MediaObjectRefCipherError, `应为 MediaObjectRefCipherError，实得 ${error?.name}`);
        assert.ok(error.message.includes('认证失败'), error.message);
        return true;
      },
    );
  });

  await t.test('信封被改一个字节 / 段数不对 / 版本前缀不对 / 长度不对 ⇒ 一律抛错', () => {
    const envelope = cipher.encryptObjectRef('obj_tamper_target');
    const parts = envelope.split('.');
    const flipped = Buffer.from(parts[3], 'base64url');
    flipped[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], flipped.toString('base64url')].join('.');
    assert.throws(() => cipher.decryptObjectRef(tampered), MediaObjectRefCipherError);

    for (const malformed of [
      'v1.only-three-parts',
      'v2.' + parts.slice(1).join('.'),
      [parts[0], parts[1], parts[2]].join('.'),
      [parts[0], parts[1], parts[2], parts[3], 'extra'].join('.'),
      [parts[0], 'AAAA', parts[2], parts[3]].join('.'),
      'plain-object-ref-not-an-envelope',
      '',
    ]) {
      assert.throws(
        () => cipher.decryptObjectRef(malformed),
        (error) => {
          assert.ok(error instanceof MediaObjectRefCipherError, `${malformed} → ${error?.name}`);
          return true;
        },
      );
    }
  });

  await t.test('非字符串入参 ⇒ MediaObjectRefCipherError（不静默转字符串）', () => {
    assert.throws(() => cipher.encryptObjectRef(undefined), MediaObjectRefCipherError);
    assert.throws(() => cipher.encryptObjectRef(null), MediaObjectRefCipherError);
    assert.throws(() => cipher.decryptObjectRef(undefined), MediaObjectRefCipherError);
    assert.throws(() => cipher.decryptObjectRef(null), MediaObjectRefCipherError);
  });

  await t.test('AAD 绑定：同键同 IV 但**未带 AAD** 的密文解不开（防「别的用途的密文被搬到这一列」）', () => {
    const key = Buffer.from(HEX_KEY, 'hex');
    const iv = randomBytes(12);
    const raw = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    // 刻意不 setAAD：如果本层解密也不验 AAD，这段密文就会被当成合法对象键。
    const ciphertext = Buffer.concat([raw.update('obj_foreign_purpose', 'utf8'), raw.final()]);
    const envelope = ['v1', iv.toString('base64url'), raw.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
    assert.throws(
      () => cipher.decryptObjectRef(envelope),
      (error) => {
        assert.ok(error instanceof MediaObjectRefCipherError, `应为 MediaObjectRefCipherError，实得 ${error?.name}`);
        assert.ok(error.message.includes('认证失败'), error.message);
        return true;
      },
    );
  });
});

/**
 * 媒体对象引用的**静态加密**（`media.object_ref_cipher` / `media_derivatives.object_ref_cipher`）。
 *
 * ## 为什么需要本文件（事实，见 `services/api/db/migrations/0001_initial_schema.sql`）
 * 两张表的对象键列**不是**明文列，而是 `object_ref_cipher text NOT NULL`
 * （`media` :181、`media_derivatives` :196）：库里落的是**密文**，明文的桶键只在服务进程内出现。
 * 因此在 PG 仓储上线前必须先有「键 → 密文」「密文 → 键」这一层，否则只有三个选择，三个都不允许：
 *   1. 明文写进密文列（骗列名、泄露对象键）；
 *   2. 不写该列（`NOT NULL` 直接拒绝 INSERT，媒体行根本落不了库）；
 *   3. 内存 Map 仍当事实源、PG 只当旁路（W2 已判定的假持久化）。
 *
 * ## 键从哪来（fail-closed）
 * **本文件不读 ambient env**（`tests/unit/media-real-mode-fail-closed.test.mjs` 对
 * `services/api/src/media/**` 的 `process.env` 读取一律判违规）：键由装配层从配置
 * （`services/api/src/config.ts` 的 `AppConfig.mediaObjectRefKey`，环境变量 `MEDIA_OBJECT_REF_KEY`）
 * 读出后经 {@link createObjectRefCipher} 注入。键缺失／形状非法 ⇒ **构造期抛错**
 * （{@link MediaObjectRefKeyError}），装配层据此整域 fail-closed（503 `PROVIDER_UNAVAILABLE`），
 * **绝不降级为明文、也绝不静默换成进程内随机键**（后者会让重启前的密文永远解不开，
 * 等于把「持久化」变成一次性的）。
 *
 * ## 信封格式
 * `v1.<iv>.<tag>.<ct>`，三段均为 base64url；`v1` 是版本前缀（将来换算法时可分辨旧密文）。
 * 算法 AES-256-GCM（认证加密）：IV 12 字节随机、tag 16 字节。**AAD 固定为** {@link OBJECT_REF_AAD}，
 * 使「别的用途的密文被搬到这一列」在解密时直接认证失败，而不是解出一段貌似合法的键。
 *
 * ## 「已清空」怎么表示
 * `object_ref_cipher` 是 `NOT NULL`，而服务层在**确认对象删除成功**后会把引用置 `null`
 * （隐私红线：未确认删除必须保留引用，见 `media/service.ts` 的 `dropObjects`）。
 * 因此本层把「没有对象键」编码成**空明文的密文**（`encrypt('')`），解密时空明文一律还原为 `null`。
 * 这样列约束、隐私红线与「未确认删除仍留重试依据」三者同时成立，且不会把空串当成真实桶键。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/** 信封版本前缀；换算法/换 AAD 时必须同时改它，避免新代码解旧密文解出无意义内容。 */
const ENVELOPE_VERSION = 'v1';
/** AES-GCM 标准 IV 长度（96 bit）。 */
const IV_BYTES = 12;
/** AES-GCM 认证标签长度（128 bit）。 */
const TAG_BYTES = 16;
/** AES-256 键长度。 */
const KEY_BYTES = 32;
/** 绑定额外数据：固定串，把信封绑定到「媒体对象引用」这一用途。 */
const OBJECT_REF_AAD = Buffer.from('gengyun/media/object-ref/v1', 'utf8');

/** 配置键名（配置层与错误文案共用；本文件不读 env）。 */
export const MEDIA_OBJECT_REF_KEY_FIELD = 'MEDIA_OBJECT_REF_KEY';

/** 对象引用加解密端口。 */
export interface ObjectRefCipher {
  /** 标识算法族（审计/诊断用；不参与判定）。 */
  readonly kind: 'aes-256-gcm';
  /** 明文对象键 → 可入库的密文信封。`''` 表示「无对象键」（见文件头「已清空怎么表示」）。 */
  encryptObjectRef(objectRef: string): string;
  /** 密文信封 → 明文对象键；空明文（＝已清空）还原为 `null`，形状非法/认证失败一律抛错。 */
  decryptObjectRef(envelope: string): string | null;
}

/** 键形状非法（配置问题，**不是**数据问题）：装配层据此 fail-closed。 */
export class MediaObjectRefKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaObjectRefKeyError';
  }
}

/** 密文信封无法解开（键不匹配/被篡改/列里根本不是密文）：数据问题，必须 fail-closed 而不是猜。 */
export class MediaObjectRefCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaObjectRefCipherError';
  }
}

/**
 * 解析配置里的键材料。
 *
 * 只接受三种**等价的 32 字节**表示（其余一律拒绝，不做「任意口令 sha256 一下」的宽松推导——
 * 那会把弱口令变成看起来合法的键，且让「配错键」与「换了键」无法区分）：
 *   1. 64 位十六进制（`openssl rand -hex 32`）；
 *   2. base64 / base64url，解码后恰好 32 字节（`openssl rand -base64 32`）；
 *   3. 原串 UTF-8 恰好 32 字节。
 */
export function parseObjectRefKeyMaterial(value: unknown): Buffer {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MediaObjectRefKeyError(`${MEDIA_OBJECT_REF_KEY_FIELD} 缺失：媒体对象引用加密键未配置`);
  }
  const raw = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(raw) || /^[A-Za-z0-9+/]{44}$/.test(raw)) {
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length === KEY_BYTES) return decoded;
  }
  const utf8 = Buffer.from(raw, 'utf8');
  if (utf8.length === KEY_BYTES) return utf8;
  throw new MediaObjectRefKeyError(
    `${MEDIA_OBJECT_REF_KEY_FIELD} 形状非法：必须是 64 位十六进制、32 字节 base64 或 32 字节 UTF-8 原串`
    + `（实测 ${utf8.length} 字节）`,
  );
}

/**
 * 由配置键建立加解密端口。
 *
 * 键缺失/非法 ⇒ **抛 {@link MediaObjectRefKeyError}**（构造期，不是请求期）；
 * 装配层必须把它变成整域 fail-closed，不得吞掉。
 */
export function createObjectRefCipher(keyMaterial: unknown): ObjectRefCipher {
  const key = parseObjectRefKeyMaterial(keyMaterial);
  return {
    kind: 'aes-256-gcm',
    encryptObjectRef(objectRef) {
      if (typeof objectRef !== 'string') {
        throw new MediaObjectRefCipherError('对象引用必须是字符串');
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(OBJECT_REF_AAD);
      const ciphertext = Buffer.concat([cipher.update(objectRef, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        ENVELOPE_VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    decryptObjectRef(envelope) {
      if (typeof envelope !== 'string') {
        throw new MediaObjectRefCipherError('对象引用密文必须是字符串');
      }
      const parts = envelope.split('.');
      if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
        throw new MediaObjectRefCipherError('对象引用密文信封形状非法');
      }
      const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
      const iv = Buffer.from(ivPart, 'base64url');
      const tag = Buffer.from(tagPart, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new MediaObjectRefCipherError('对象引用密文信封长度非法');
      }
      let plaintext: string;
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(OBJECT_REF_AAD);
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([
          decipher.update(Buffer.from(dataPart, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        // 认证失败：键不对、密文被改、或这一列里根本不是本层产生的信封。不猜、不回退明文。
        throw new MediaObjectRefCipherError('对象引用密文认证失败（键不匹配或密文被篡改）');
      }
      // 空明文 = 「已确认删除、引用已清空」的编码（列 NOT NULL，见文件头）。
      return plaintext === '' ? null : plaintext;
    },
  };
}

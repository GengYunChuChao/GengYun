/**
 * 「真实能力配置到底齐不齐」的**纯逻辑**（GY-R69 切片）。
 *
 * 本文件不读进程环境、不读文件、不碰 `process.cwd()`、不联网、不写任何东西：
 * 输入永远是一个**显式注入的 env 对象**，输出是一份纯数据（能力组三态 + 逐字段
 * `present`／形态布尔）。`process.env` 只在 `tools/verify-real-capability-config.mjs`
 * 的入口读一次再传下来，所以单测可以完全脱离真环境跑。
 *
 * ## 为什么需要它
 *
 * `real` 模式的**启动必填**只有 9 项（`services/api/src/config.ts` 的 `REQUIRED_WHEN_REAL`），
 * 而 `MEDIA_OBJECT_REF_KEY`、`MEDIA_ACCESS_GRANT_ORIGIN`、`CHAT_LLM_*`、`RECOGNITION_PROVIDER_*`
 * 这些「域内必填」**不参与启动校验**：缺了照样起得来，只是对应域降级或按域拒绝
 * （媒体域整域 503、语音受理 409、问答退回确定性摘录、识别受理 503）。
 * 于是「起得来」被误当成「能力齐」——这个工具就是把那一步人肉对照变成一条可复跑的命令。
 *
 * ## 三态口径（只此一条规则）
 *
 * - `n-a`：`APP_EXECUTION_MODE !== 'real'` ⇒ 真实域一律未接线，任何能力组都判「当前模式不适用」。
 *   字段行**照样**如实报 `present`／形态，所以 n-a 组也能看出「真要切 real 还缺什么」。
 * - `needs-user`：该组当前模式下适用，但要求的字段缺了，或已填字段形态非法。
 * - `ready`：该组至少一组「要求集合」全部齐备且形态合法，且组内**任何已填字段**都不非法。
 *
 * 为什么不是「每组各写一套判定」：一条规则才能被记住、被复述、被负控制打死。
 *
 * ## 泄密红线（本文件里是结构性保证，不靠自觉）
 *
 * 字段层只输出 `name`／`present`／`shapeOk`／`shapeRule`。形态规则的 id 是**静态常量**
 * （如 `length>=32`、`https-url`），不是从值里算出来的：所以输出里没有值、没有前缀、
 * 没有尾 4 位，长度也只以「过没过这条规则」的布尔出现，不出现实际长度。
 * 环境里某个 key 的 getter 抛异常时按「缺失」处理，**异常文本一律不向外传**（它可能带值）。
 */

/** JSON 结构的版本号（结构变了才 +1；消费方据此判断字段含义）。 */
export const SCHEMA_VERSION = 1;

/** 工具名（`--json` 里回写，便于消费方确认来源）。 */
export const TOOL_NAME = 'verify-real-capability-config';

/** 契约 `ExecutionMode`（与 `packages/contracts` 同集合）。 */
export const EXECUTION_MODES = Object.freeze(['real', 'stub', 'preset_demo']);

/** 未声明/声明非法时服务按 `stub` 启动（与 `config.ts` 的兜底逐字一致）。 */
export const DEFAULT_EXECUTION_MODE = 'stub';

/** 退出码：用法错误单独一档，避免跟「能力缺失」混为一谈。 */
export const EXIT_OK = 0;
export const EXIT_STRICT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** 三态（顺序即汇总输出顺序）。 */
export const STATES = Object.freeze(['ready', 'needs-user', 'n-a']);

const STATE_LABEL = Object.freeze({ ready: 'ready', 'needs-user': 'needs-user', 'n-a': 'n-a' });

/**
 * 形态规则登记表。
 *
 * ⚠️ 每个规则的 `id` 会**原样进输出**，所以它只能描述「规则本身」（阈值属于口径，不是读数），
 * 绝不能由实际值拼出来（那会把长度/字符集变成可推断信息）。
 */
export const SHAPE_RULES = Object.freeze({
  /** 只要求非空（秘密类字段没有可公开校验的形态）。 */
  'non-empty': { id: 'non-empty', test: (value) => value.length > 0 },
  /** 会话签名密钥：模板口径「至少 32 字符」（比启动校验的非空更严，见文档）。 */
  'length>=32': { id: 'length>=32', test: (value) => value.length >= 32 },
  /** `postgres://` 或 `postgresql://` 连接串（与 `config.ts` 的 `isPostgresUrl` 同形）。 */
  'postgres-url': { id: 'postgres-url', test: (value) => /^postgres(ql)?:\/\/\S+$/i.test(value) },
  /** 可 `new URL()` 且是 https（对象存储/识别端点）。 */
  'https-url': {
    id: 'https-url',
    test: (value) => {
      const url = parseUrl(value);
      return url !== null && url.protocol === 'https:' && url.hostname !== '';
    },
  },
  /** 只接受 `https://<host>[:port]`：不带路径/查询/片段/URL 内凭据（与 `asHttpsOrigin` 同形）。 */
  'https-origin-only': {
    id: 'https-origin-only',
    test: (value) => {
      const url = parseUrl(value);
      if (url === null) return false;
      if (url.protocol !== 'https:') return false;
      if (url.username !== '' || url.password !== '') return false;
      if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return false;
      return url.hostname !== '';
    },
  },
  /** `https://<host>[:port][/path]`：允许路径，但拒绝查询串/片段/URL 内凭据（与 `asHttpsChatEndpoint` 同形）。 */
  'https-url-no-query-or-credentials': {
    id: 'https-url-no-query-or-credentials',
    test: (value) => {
      const url = parseUrl(value);
      if (url === null) return false;
      if (url.protocol !== 'https:') return false;
      if (url.username !== '' || url.password !== '') return false;
      if (url.search !== '' || url.hash !== '') return false;
      return url.hostname !== '';
    },
  },
  /** 小程序 AppID：`wx` + 16 位小写十六进制。 */
  'wx-app-id-16-hex': { id: 'wx-app-id-16-hex', test: (value) => /^wx[0-9a-f]{16}$/.test(value) },
  /**
   * AES-256-GCM 键材料：64 位十六进制 / 32 字节 base64（含 base64url）/ 32 字节 UTF-8 原串。
   * 与 `services/api/src/media/object-ref-cipher.ts` 的 `parseObjectRefKeyMaterial` 同口径
   * （这里只判「能不能用」，不做「任意口令 sha256 一下」的宽松推导）。
   */
  'aes256-key-material': {
    id: 'aes256-key-material',
    test: (value) => {
      if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
      if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value) || /^[A-Za-z0-9+/]{44}$/.test(value)) {
        const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (decoded.length === 32) return true;
      }
      return Buffer.from(value, 'utf8').length === 32;
    },
  },
  /** 模型名：1..80 字符，不含空白/控制字符（与 `asChatProvider` 同口径）。 */
  'chat-model-name': {
    id: 'chat-model-name',
    test: (value) => value.length >= 1 && value.length <= 80 && !/[\s\u0000-\u001f\u007f]/.test(value),
  },
  /** 问答密钥：8..200 字符，不含空白/控制字符（同上）。 */
  'chat-api-key': {
    id: 'chat-api-key',
    test: (value) => value.length >= 8 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/.test(value),
  },
});

/** `new URL()` 从不抛到调用方：形态非法就是 `false`，不是异常。 */
function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** 字段声明（`shapeRule` 是 `SHAPE_RULES` 的键，不是函数：这样输出里只会出现静态 id）。 */
function field(name, shapeRule) {
  return Object.freeze({ name, shapeRule });
}

/**
 * 能力组登记表（顺序即输出顺序）。
 *
 * `requirements` 是**并列的替代要求**：任一组全部满足即算该组齐备。
 * 多数组只有一条；`asr`（专用子账号对 / 共享对）与 `chat-llm`（`CHAT_LLM_API_KEY` / `DEEPSEEK_API_KEY`）
 * 是两条——这是服务里真实存在的「二选一」，不是这里自创的宽松。
 */
export const CAPABILITY_GROUPS = Object.freeze([
  Object.freeze({
    id: 'database',
    label: '数据库',
    // 缺它：real 下启动直接 exit 1（启动必填项之一）；非 real 走进程内替身。
    fields: Object.freeze([field('DATABASE_URL', 'postgres-url')]),
    requirements: Object.freeze([Object.freeze(['DATABASE_URL'])]),
  }),
  Object.freeze({
    id: 'session',
    label: '会话签名',
    // 缺它：real 下启动 exit 1；非 real 落 `STUB_IDEMPOTENCY_HMAC_KEY`。
    fields: Object.freeze([field('SESSION_SIGNING_KEY', 'length>=32')]),
    requirements: Object.freeze([Object.freeze(['SESSION_SIGNING_KEY'])]),
  }),
  Object.freeze({
    id: 'deletion-ledger',
    label: '删除台账密钥',
    // 缺它：real 下启动 exit 1；配置存在也不等于独立删除账本已接线。
    fields: Object.freeze([field('DELETION_LEDGER_KEY', 'non-empty')]),
    requirements: Object.freeze([Object.freeze(['DELETION_LEDGER_KEY'])]),
  }),
  Object.freeze({
    id: 'wechat-real',
    label: '微信真实登录',
    // 缺它：real 下启动 exit 1；非 real 由合成 subject 派生身份（本组不适用）。
    fields: Object.freeze([
      field('WECHAT_APP_ID', 'wx-app-id-16-hex'),
      field('WECHAT_APP_SECRET', 'non-empty'),
    ]),
    requirements: Object.freeze([Object.freeze(['WECHAT_APP_ID', 'WECHAT_APP_SECRET'])]),
  }),
  Object.freeze({
    id: 'object-storage',
    label: '对象存储',
    // 缺它：real 下启动 exit 1；但「四键齐备」仍不等于接线（还要显式装配）。
    fields: Object.freeze([
      field('OBJECT_STORAGE_ENDPOINT', 'https-url'),
      field('OBJECT_STORAGE_BUCKET', 'non-empty'),
      field('OBJECT_STORAGE_ACCESS_KEY', 'non-empty'),
      field('OBJECT_STORAGE_SECRET_KEY', 'non-empty'),
    ]),
    requirements: Object.freeze([
      Object.freeze([
        'OBJECT_STORAGE_ENDPOINT',
        'OBJECT_STORAGE_BUCKET',
        'OBJECT_STORAGE_ACCESS_KEY',
        'OBJECT_STORAGE_SECRET_KEY',
      ]),
    ]),
  }),
  Object.freeze({
    id: 'media-encryption',
    label: '媒体对象加密键',
    // 缺它：不参与启动校验，但媒体域整域 503、语音受理 409。
    fields: Object.freeze([field('MEDIA_OBJECT_REF_KEY', 'aes256-key-material')]),
    requirements: Object.freeze([Object.freeze(['MEDIA_OBJECT_REF_KEY'])]),
  }),
  Object.freeze({
    id: 'media-access-grant',
    label: '取图句柄原点',
    // 缺它：句柄指向不可解析的占位域 media.placeholder.invalid；带
    // `--approve-real-media-wiring` 时启动直接拒绝。
    // 本工具按**必填**判（比启动校验严）：没有它，真实取图链路就没有可用原点。
    fields: Object.freeze([field('MEDIA_ACCESS_GRANT_ORIGIN', 'https-origin-only')]),
    requirements: Object.freeze([Object.freeze(['MEDIA_ACCESS_GRANT_ORIGIN'])]),
  }),
  Object.freeze({
    id: 'asr',
    label: '普通话 ASR',
    // 缺它：语音受理 409/503 一侧的凭据门；专用子账号对优先，缺专用对时回退共享对。
    fields: Object.freeze([
      field('TENCENTCLOUD_ASR_SECRET_ID', 'non-empty'),
      field('TENCENTCLOUD_ASR_SECRET_KEY', 'non-empty'),
      field('TENCENTCLOUD_SECRET_ID', 'non-empty'),
      field('TENCENTCLOUD_SECRET_KEY', 'non-empty'),
    ]),
    requirements: Object.freeze([
      Object.freeze(['TENCENTCLOUD_ASR_SECRET_ID', 'TENCENTCLOUD_ASR_SECRET_KEY']),
      Object.freeze(['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY']),
    ]),
  }),
  Object.freeze({
    id: 'recognition',
    label: '识别（拍草）',
    // 缺它：`POST /recognitions` 受理前 503；配齐也只到「能受理」（无已审适配器）。
    fields: Object.freeze([
      field('RECOGNITION_PROVIDER_URL', 'https-url'),
      field('RECOGNITION_PROVIDER_KEY', 'non-empty'),
    ]),
    requirements: Object.freeze([
      Object.freeze(['RECOGNITION_PROVIDER_URL', 'RECOGNITION_PROVIDER_KEY']),
    ]),
  }),
  Object.freeze({
    id: 'chat-llm',
    label: '问答真实模型',
    // 缺它：问答退回确定性摘录（回答版本串带 unimplemented:no-real- 前缀），不报错。
    fields: Object.freeze([
      field('CHAT_LLM_ENDPOINT', 'https-url-no-query-or-credentials'),
      field('CHAT_LLM_MODEL', 'chat-model-name'),
      field('CHAT_LLM_API_KEY', 'chat-api-key'),
      field('DEEPSEEK_API_KEY', 'chat-api-key'),
    ]),
    requirements: Object.freeze([
      Object.freeze(['CHAT_LLM_ENDPOINT', 'CHAT_LLM_MODEL', 'CHAT_LLM_API_KEY']),
      Object.freeze(['CHAT_LLM_ENDPOINT', 'CHAT_LLM_MODEL', 'DEEPSEEK_API_KEY']),
    ]),
  }),
  Object.freeze({
    id: 'tts',
    label: '普通话 TTS',
    // 缺它：TTS 域仍是接线前的 fail-closed；只认共享对，不逐字段混配。
    fields: Object.freeze([
      field('TENCENTCLOUD_SECRET_ID', 'non-empty'),
      field('TENCENTCLOUD_SECRET_KEY', 'non-empty'),
    ]),
    requirements: Object.freeze([
      Object.freeze(['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY']),
    ]),
  }),
  Object.freeze({
    id: 'ocr',
    label: '标签 OCR',
    // 缺它：OCR 域 fail-closed；与 TTS 同源共享对（两个域各自独立判定）。
    fields: Object.freeze([
      field('TENCENTCLOUD_SECRET_ID', 'non-empty'),
      field('TENCENTCLOUD_SECRET_KEY', 'non-empty'),
    ]),
    requirements: Object.freeze([
      Object.freeze(['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY']),
    ]),
  }),
]);

/** 能力组 id（顺序稳定；`--require` 用它校验）。 */
export const GROUP_IDS = Object.freeze(CAPABILITY_GROUPS.map((group) => group.id));

const GROUP_BY_ID = new Map(CAPABILITY_GROUPS.map((group) => [group.id, group]));

/**
 * 读一个环境值：**只读、只在 try 里读**。
 *
 * getter 抛异常时按「缺失」返回 `undefined`，且**不把异常文本带出去**——
 * 异常消息里很可能带着值（`Invalid value <secret>`），那是泄密面。
 */
function readEnvValue(env, name) {
  try {
    const value = env[name];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析执行模式（与 `config.ts` 同一套兜底）：
 * 未声明 ⇒ `stub` + `default`；声明了但不在 `EXECUTION_MODES` 里 ⇒ `stub` + `invalid`。
 */
export function readExecutionMode(env = {}) {
  const raw = readEnvValue(env, 'APP_EXECUTION_MODE');
  const value = raw === undefined ? undefined : raw.trim();
  if (value === undefined || value === '') {
    return { mode: DEFAULT_EXECUTION_MODE, source: 'default' };
  }
  if (EXECUTION_MODES.includes(value)) {
    return { mode: value, source: 'declared' };
  }
  return { mode: DEFAULT_EXECUTION_MODE, source: 'invalid' };
}

/** 单字段判定：`present` 是「trim 后非空」（与 `config.ts` 的 `trimmed()` 同口径）。 */
function evaluateField(spec, env) {
  const raw = readEnvValue(env, spec.name);
  const value = raw === undefined ? undefined : raw.trim();
  const present = value !== undefined && value !== '';
  const rule = SHAPE_RULES[spec.shapeRule];
  const shapeOk = present ? rule.test(value) === true : false;
  return { name: spec.name, present, shapeOk, shapeRule: rule.id };
}

function evaluateGroup(group, env, applicable) {
  const fields = group.fields.map((spec) => evaluateField(spec, env));
  const byName = new Map(fields.map((item) => [item.name, item]));

  const requirements = group.requirements.map((names) => {
    const missing = names.filter((name) => !byName.get(name).present);
    const invalid = names.filter((name) => {
      const item = byName.get(name);
      return item.present && !item.shapeOk;
    });
    return { fields: [...names], satisfied: missing.length === 0 && invalid.length === 0, missing, invalid };
  });

  const satisfied = requirements.some((requirement) => requirement.satisfied);
  const anyPresentInvalid = fields.some((item) => item.present && !item.shapeOk);
  const missing = [];
  for (const requirement of requirements) {
    for (const name of requirement.missing) {
      if (!missing.includes(name)) missing.push(name);
    }
  }

  let state;
  let stateReason;
  if (!applicable) {
    state = 'n-a';
    stateReason = 'mode-not-real';
  } else if (satisfied && !anyPresentInvalid) {
    state = 'ready';
    stateReason = null;
  } else if (!satisfied) {
    state = 'needs-user';
    stateReason = 'fields-missing';
  } else {
    // 有一组已经满足，但组内另一个**已填**字段形态非法：服务那边会因它报错，所以不许算 ready。
    state = 'needs-user';
    stateReason = 'present-field-invalid';
  }

  return {
    id: group.id,
    label: group.label,
    state,
    stateReason,
    requirements,
    fields,
    missing,
    alternatives: requirements.length > 1,
  };
}

/** 关注集合归一：`undefined`/空 ⇒ 全部组；否则校验 id 并保持登记顺序。 */
export function resolveRequiredGroups(names) {
  if (names === undefined) return { scope: 'all', ids: [...GROUP_IDS], unknown: [] };
  const unknown = [];
  const wanted = new Set();
  for (const name of names) {
    if (GROUP_BY_ID.has(name)) wanted.add(name);
    else unknown.push(name);
  }
  const ids = GROUP_IDS.filter((id) => wanted.has(id));
  return { scope: 'explicit', ids, unknown };
}

/**
 * 主入口：纯函数。
 *
 * @param {{ env?: Record<string, unknown>, requiredGroups?: string[], strict?: boolean }} options
 * @returns {object} 稳定字段顺序的报告（无时间戳、无随机性 ⇒ 同一 env + 同一参数逐字节相同）
 */
export function evaluateCapabilityConfig({ env = {}, requiredGroups, strict = false } = {}) {
  const { mode, source } = readExecutionMode(env);
  const applicable = mode === 'real';
  const scope = resolveRequiredGroups(requiredGroups);

  const groups = CAPABILITY_GROUPS.filter((group) => scope.ids.includes(group.id)).map((group) =>
    evaluateGroup(group, env, applicable));

  const summary = { ready: 0, 'needs-user': 0, 'n-a': 0 };
  for (const group of groups) summary[group.state] += 1;

  const failures = groups
    .filter((group) => group.state === 'needs-user')
    .map((group) => ({ group: group.id, missing: [...group.missing] }));

  const strictBlock = {
    requested: strict === true,
    verdict: strict === true ? (failures.length > 0 ? 'fail' : 'pass') : 'not-requested',
    failures,
  };

  const notes = [];
  if (source === 'default') {
    notes.push('mode-undeclared: APP_EXECUTION_MODE 未声明（服务按 stub 启动），真实能力一律未接线');
  }
  if (source === 'invalid') {
    notes.push('mode-invalid: APP_EXECUTION_MODE 不在 real|stub|preset_demo 内（服务回退 stub），真实能力一律未接线');
  }
  if (!applicable) {
    notes.push('mode-not-real: 非 real 模式下所有能力组判 n-a；字段行仍报 present/形态，可看出「切 real 还缺什么」');
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_NAME,
    executionMode: mode,
    executionModeSource: source,
    applicable,
    scope: scope.scope,
    requiredGroups: [...scope.ids],
    summary,
    strict: strictBlock,
    groups,
    notes,
  };
}

function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padCell(text, width) {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

function fieldLine(field) {
  if (!field.present) return `${field.name}: missing`;
  return `${field.name}: present｜形态${field.shapeOk ? ' ok' : ' 非法'}（${field.shapeRule}）`;
}

function requirementCell(group) {
  return group.requirements
    .map((requirement) => {
      const body = requirement.fields
        .map((name) => {
          const item = group.fields.find((entry) => entry.name === name);
          return fieldLine(item);
        })
        .join('、');
      return requirement.fields.length > 1 ? `[${body}]` : body;
    })
    .join(' 或 ');
}

const MODE_SOURCE_LABEL = Object.freeze({
  declared: '已声明',
  default: '未声明，按 stub',
  invalid: '声明非法，按 stub',
});

/**
 * `--strict` 失败项的一句话：保留「或」的并列结构（不要退化成「这些字段全缺」）。
 *
 * 形态非法（`present-field-invalid`）时没有缺失字段，改点名非法字段。
 */
function strictFailureReason(group) {
  const unsatisfied = group.requirements.filter((requirement) => !requirement.satisfied);
  if (unsatisfied.length > 0) {
    const sets = unsatisfied.map((requirement) => `[${requirement.fields.join('、')}]`);
    return `缺 ${sets.join(' 或 ')}`;
  }
  const invalid = group.fields.filter((item) => item.present && !item.shapeOk).map((item) => item.name);
  return `形态非法 ${invalid.join('、')}`;
}

/** 人读表格：列宽按显示宽度算（中文按 2 格），同一报告逐字节相同。 */
export function renderHuman(report) {
  const lines = [];
  lines.push('耕云 · 真实能力配置自检（只读进程环境；不读 .env、不读任何凭据文件；不输出任何值）');
  lines.push(
    `执行模式：${report.executionMode}（${MODE_SOURCE_LABEL[report.executionModeSource]}）`
    + `｜严格模式：${report.strict.requested ? '开' : '关'}`
    + `｜关注组：${report.scope === 'all' ? `全部 ${report.requiredGroups.length} 组` : report.requiredGroups.join(', ')}`,
  );
  if (!report.applicable) {
    lines.push('⚠ 当前模式不是 real ⇒ 所有能力组判 n-a（真实域一律未接线）；字段行仍如实报 present/形态。');
  }
  lines.push('');

  const header = ['能力组', '状态', '字段（present / 形态）'];
  const rows = report.groups.map((group) => [group.id, STATE_LABEL[group.state], requirementCell(group)]);
  const widths = header.map((title, index) =>
    Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[index]))));

  lines.push(rows.length === 0
    ? '（关注组为空）'
    : [header.map((title, index) => (index === widths.length - 1 ? title : padCell(title, widths[index]))).join('  '),
      widths.map((width) => '-'.repeat(width)).join('  '),
      ...rows.map((row) => row
        .map((cell, index) => (index === widths.length - 1 ? cell : padCell(cell, widths[index])))
        .join('  '))]
    .join('\n'));

  lines.push('');
  lines.push(
    `汇总：ready ${report.summary.ready} ｜ needs-user ${report.summary['needs-user']} ｜ n-a ${report.summary['n-a']}`,
  );

  for (const note of report.notes) lines.push(`提示：${note}`);

  if (report.strict.requested) {
    lines.push(report.strict.verdict === 'fail'
      ? `严格模式判定：FAIL ⇒ exit 1。关注组里 needs-user 的：${report.strict.failures
        .map((failure) => {
          const group = report.groups.find((item) => item.id === failure.group);
          return `${failure.group}（${group === undefined ? failure.missing.join('、') : strictFailureReason(group)}）`;
        })
        .join('；')}`
      : '严格模式判定：PASS ⇒ exit 0。');
  } else {
    lines.push('自检模式：退出码恒 0（它是自检不是闸门）；要卡口请加 --strict。');
  }
  lines.push('说明：字段值一律不打印；形态布尔只回答「这条规则过没过」，不透露长度/前缀/片段。');
  return `${lines.join('\n')}\n`;
}

/** 机器读：稳定键序、无时间戳、无随机性。 */
export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** 退出码：只有「用法错误」与「--strict 判定 FAIL」不是 0。 */
export function exitCodeFor(report) {
  return report.strict.requested && report.strict.verdict === 'fail' ? EXIT_STRICT_FAILURE : EXIT_OK;
}

export const USAGE = [
  '用法：node tools/verify-real-capability-config.mjs [--json] [--strict] [--require=<组,组>]',
  '',
  '  --json             机器读（稳定字段顺序、无时间戳；同一环境两次输出逐字节相同）',
  '  --strict           关注组里有 needs-user ⇒ exit 1 并点名缺哪些组的哪些字段',
  '  --require=a,b      只看这些能力组（缺省＝全部）',
  `  可用组：${GROUP_IDS.join(', ')}`,
  '',
  '只读进程环境；不读 .env、不读任何凭据文件；不输出任何值（连前缀/尾 4 位/长度都不出）。',
  '退出码：0＝自检通过（默认恒 0）｜1＝--strict 判定 FAIL｜2＝用法错误。',
].join('\n');

/**
 * 参数解析（纯函数：不读 `process.argv`）。
 *
 * 支持 `--require=a,b` 与 `--require a,b` 两种写法；其它未知参数一律用法错误。
 */
export function parseCliArgs(argv = []) {
  const parsed = { help: false, json: false, strict: false, require: [], errors: [] };
  const list = [...argv];
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (arg === '--json') parsed.json = true;
    else if (arg === '--strict') parsed.strict = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--require' || arg.startsWith('--require=')) {
      const inline = arg.startsWith('--require=') ? arg.slice('--require='.length) : undefined;
      const value = inline !== undefined ? inline : list[++index];
      if (value === undefined || value === '') {
        parsed.errors.push('--require 需要一个逗号分隔的能力组列表');
        continue;
      }
      const names = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
      if (names.length === 0) {
        parsed.errors.push('--require 需要一个逗号分隔的能力组列表');
        continue;
      }
      for (const name of names) parsed.require.push(name);
    } else {
      parsed.errors.push(`未知参数：${arg}`);
    }
  }
  const { unknown } = resolveRequiredGroups(parsed.require);
  for (const name of unknown) {
    parsed.errors.push(`未知能力组：${name}（可用：${GROUP_IDS.join(', ')}）`);
  }
  return parsed;
}

/**
 * GY-R68 返修 · 启动日志的「固定身份是否生效」读数（`WECHAT_STUB_SUBJECT`）
 *
 * 独立审查提的两条非阻塞之一：启动日志原本只有 `execution_mode` / `database_configured`，
 * 开发者**无从判断**自己设的固定身份到底生效了没有；而 `WECHAT_STUB_SUBJECT='   '`（纯半角空白／
 * 全角空白）语义上等价于「未设」，过去**静默**回落 code 派生 —— 开发者会以为身份已固定、其实没固定。
 *
 * 本文件钉住五件事（都只关于**可观测性**，不重复钉身份派生逻辑 —— 那由
 * `tests/unit/wechat-stub-subject.test.mjs` 覆盖）：
 *   ① 设了值 ⇒ 启动日志 `wechat_stub_subject_fixed` 为 `true`；
 *   ② 未设（含空串）⇒ `false`，且**不出现** `wechat_stub_subject_ignored`；
 *   ③ 只含空白（半角/全角/制表/混合）⇒ `false` **且** `wechat_stub_subject_ignored: true`，
 *      即「被忽略」与「未设」在日志里可区分；
 *   ④ 正向反证：无论哪种取值，**日志里都不出现变量的值**（那是身份标识），
 *      并且 `server.ts` 从头到尾**没有**读取 `config.wechatStubSubject` 去打印 —— 值没有入口；
 *   ⑤ 入口不读 ambient env：`server.ts` 里 `process.env` 出现次数必须为 **0**
 *      （与 `tests/unit/tts-synthesis-media-wiring.test.mjs` 判据 ④ 的钉子互相咬住：
 *      读数只能来自**已解析的 `config`**，不能从入口再读一次环境）。
 *
 * 另有两条结构性断言：读数与真实生效值**同源**（`fixed ⇔ config.wechatStubSubject !== null`、
 * `ignored ⇔ 非 real 且原始值只含空白`），且启动日志那一行的载荷确实展开本函数
 * （防止改了函数却忘了接线）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, wechatStubSubjectStartupFields } from '../../services/api/src/config.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER_SOURCE = readFileSync(new URL('../../services/api/src/server.ts', import.meta.url), 'utf8');

/** 一个「一看就知道不该出现在日志里」的取值（不是真人身份，纯合成夹具）。 */
const FIXED = 'qa-dev-identity-7f2c';

const REAL_ENV = Object.freeze({
  APP_EXECUTION_MODE: 'real',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/gengyun',
  SESSION_SIGNING_KEY: 'x'.repeat(32),
  DELETION_LEDGER_KEY: 'y'.repeat(32),
  WECHAT_APP_ID: 'wx0000000000000000',
  WECHAT_APP_SECRET: 'secret',
  OBJECT_STORAGE_ENDPOINT: 'https://oss.example.invalid',
  OBJECT_STORAGE_BUCKET: 'gengyun',
  OBJECT_STORAGE_ACCESS_KEY: 'ak',
  OBJECT_STORAGE_SECRET_KEY: 'sk',
});

/** 合成模式（stub）配置：`loadConfig` 是唯一的解析点，读数只吃它的产物。 */
function stubEnv(extra = {}) {
  return { APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', ...extra };
}

/** 读数的唯一入参是**已解析的 config**（入口不再碰 `process.env`）。 */
function fieldsOf(env) {
  return wechatStubSubjectStartupFields(loadConfig(env));
}

/** 一段源码里 ambient env 的读取点计数（`process.env` 出现次数）。口径同 #742 的判据 ④。 */
function ambientEnvReads(text) {
  return (text.match(/process\.env/g) ?? []).length;
}

/** `server.ts` 的**代码行**（去掉 `//`、块注释 `*`、`/*` 开头的行）：注释里提字段名不算读取。 */
const SERVER_CODE = SERVER_SOURCE.split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  })
  .join('\n');

/** 把字段渲染成一行**日志**（与 pino 默认 JSON 输出同形：字段 + msg），用于「值不出现」的反证。 */
function renderLogLine(fields) {
  return JSON.stringify({ level: 30, time: 0, ...fields, msg: 'gengyun api 已启动' });
}

// ---------------------------------------------------------------------------
// ① 设了值 ⇒ true
// ---------------------------------------------------------------------------

test('启动日志①：设了固定身份 ⇒ wechat_stub_subject_fixed 为 true（前后空白不影响）', () => {
  const plain = fieldsOf(stubEnv({ WECHAT_STUB_SUBJECT: FIXED }));
  assert.deepEqual(plain, { wechat_stub_subject_fixed: true });

  const padded = fieldsOf(stubEnv({ WECHAT_STUB_SUBJECT: `  ${FIXED}  ` }));
  assert.deepEqual(padded, { wechat_stub_subject_fixed: true }, '前后空白去掉后仍是非空值 ⇒ 生效');

  // preset_demo 也是「非 real」的合成模式，判据与 stub 同源
  assert.deepEqual(
    fieldsOf({ APP_EXECUTION_MODE: 'preset_demo', LOG_LEVEL: 'silent', WECHAT_STUB_SUBJECT: FIXED }),
    { wechat_stub_subject_fixed: true },
  );
});

// ---------------------------------------------------------------------------
// ② 未设 ⇒ false（且不出现 ignored）
// ---------------------------------------------------------------------------

test('启动日志②：未设/空串 ⇒ false，且不出现 wechat_stub_subject_ignored（「未设」不是「被忽略」）', () => {
  for (const extra of [{}, { WECHAT_STUB_SUBJECT: '' }, { WECHAT_STUB_SUBJECT: undefined }]) {
    const fields = fieldsOf(stubEnv(extra));
    assert.deepEqual(fields, { wechat_stub_subject_fixed: false }, JSON.stringify(extra));
    assert.equal('wechat_stub_subject_ignored' in fields, false, '未设不该被标成「被忽略」');
  }
});

// ---------------------------------------------------------------------------
// ③ 纯空白 ⇒ false + ignored:true（与「未设」可区分）
// ---------------------------------------------------------------------------

test('启动日志③：纯空白（半角/全角/制表/混合）⇒ false 且 wechat_stub_subject_ignored 为 true', () => {
  // \u3000 是全角空格（IDEOGRAPHIC SPACE）：中文输入法下最容易误输入的那一种。
  for (const blank of ['   ', '\t', '\u3000', '\u3000\u3000', ' \u3000\t ']) {
    const fields = fieldsOf(stubEnv({ WECHAT_STUB_SUBJECT: blank }));
    assert.deepEqual(
      fields,
      { wechat_stub_subject_fixed: false, wechat_stub_subject_ignored: true },
      `空白值 ${JSON.stringify(blank)} 必须与「未设」可区分`,
    );
  }
});

test('启动日志③-负控制：同样的空白值在 real 模式下仍为 false，但**不**标「被忽略」（real 不读它）', () => {
  // real 下该变量本就不生效（不是「设错了」）⇒ 只报 false，不额外告警，避免误导运维去改它。
  assert.deepEqual(
    fieldsOf({ ...REAL_ENV, WECHAT_STUB_SUBJECT: '   ' }),
    { wechat_stub_subject_fixed: false },
  );
  assert.deepEqual(
    fieldsOf({ ...REAL_ENV, WECHAT_STUB_SUBJECT: FIXED }),
    { wechat_stub_subject_fixed: false },
    'real 模式下设了值也不生效（本片没动这条边界）',
  );
});

// ---------------------------------------------------------------------------
// ④ 正向反证：日志里不出现变量的值
// ---------------------------------------------------------------------------

test('启动日志④（正向反证）：任何取值下日志行都不出现变量的值，只有布尔字段', () => {
  const cases = [
    { env: stubEnv({ WECHAT_STUB_SUBJECT: FIXED }), mode: 'stub' },
    { env: stubEnv({ WECHAT_STUB_SUBJECT: `  ${FIXED}  ` }), mode: 'stub' },
    { env: stubEnv({ WECHAT_STUB_SUBJECT: '   ' }), mode: 'stub' },
    { env: stubEnv(), mode: 'stub' },
    { env: { ...REAL_ENV, WECHAT_STUB_SUBJECT: FIXED }, mode: 'real' },
  ];
  for (const { env, mode } of cases) {
    const fields = fieldsOf(env);
    const line = renderLogLine({
      execution_mode: mode,
      database_configured: true,
      ...fields,
    });
    // 值本身不得出现（前缀片段也不得出现，防止拼半个值进日志）
    assert.doesNotMatch(line, new RegExp(FIXED.slice(0, 8)), `日志行不得含变量值的任何片段：${line}`);
    // 键名只有这两个布尔读数（没有 `wechat_stub_subject_value` 之类的入口）
    const keys = Object.keys(fields).sort();
    assert.deepEqual(
      keys,
      fields.wechat_stub_subject_ignored === true
        ? ['wechat_stub_subject_fixed', 'wechat_stub_subject_ignored']
        : ['wechat_stub_subject_fixed'],
      '日志载荷只允许出现布尔读数',
    );
    for (const key of keys) assert.equal(typeof fields[key], 'boolean', `${key} 必须是布尔`);
  }
});

test('启动日志④-结构：server.ts 的启动日志确实展开本函数，且没有任何读取 `config.wechatStubSubject` 的打印', () => {
  assert.match(
    SERVER_SOURCE,
    /\.\.\.wechatStubSubjectStartupFields\(config\)/,
    '启动日志那一行必须展开读数、且只吃已解析的 config（改了函数却忘了接线＝这条用例要抓的事）',
  );
  // 值没有入口：server.ts 的**代码**不读 `config.wechatStubSubject`（注释里提字段名不算；
  // 唯一允许出现在代码里的是启动读数函数名本身，以及 `loadConfig` 算好的 `…Ignored` 布尔）。
  assert.doesNotMatch(
    SERVER_CODE,
    /config\.wechatStubSubject(?!Ignored)/,
    'server.ts 不得读取该值去打印',
  );
  // 既有字段仍在同一行（本片只追加，不替换）
  assert.match(SERVER_SOURCE, /execution_mode: config\.executionMode/);
  assert.match(SERVER_SOURCE, /database_configured: config\.databaseUrl !== null/);
});

// ---------------------------------------------------------------------------
// ⑤ 入口不读 ambient env（与 #742 的判据 ④ 互咬）
// ---------------------------------------------------------------------------

test('启动日志⑤：server.ts 里 `process.env` 出现次数为 0（入口只吃已解析的 config）', () => {
  // 负控制：判据本身能抓到「塞一行」——把上一版实现（传 process.env）当探针，计数必须是 1。
  assert.equal(
    ambientEnvReads('      ...wechatStubSubjectStartupFields(process.env, config.executionMode),'),
    1,
    '计数判据必须能命中一次 ambient env 读取（否则本用例会退化成永绿）',
  );
  assert.equal(
    ambientEnvReads(SERVER_SOURCE),
    0,
    'server.ts 不得读 ambient env：读数只能来自已解析的 config（空白判据在 loadConfig 里算好）',
  );
  // `process.on(...)` / `process.exitCode` 这类不读环境的用法不受影响（只钉 `process.env`）
  assert.match(SERVER_SOURCE, /process\.on\('SIGTERM'/, '退出信号处理应仍在（不是把 process 整个禁掉）');
});

// ---------------------------------------------------------------------------
// 同源：读数 ⇔ 真实生效值（防「日志说生效、实际没生效」）
// ---------------------------------------------------------------------------

test('同源：每个取值下 fixed 恒等于「config.wechatStubSubject !== null」（读数不会与真实行为漂移）', () => {
  const variants = [
    ['stub', {}],
    ['stub', { WECHAT_STUB_SUBJECT: FIXED }],
    ['stub', { WECHAT_STUB_SUBJECT: ` ${FIXED} ` }],
    ['stub', { WECHAT_STUB_SUBJECT: '' }],
    ['stub', { WECHAT_STUB_SUBJECT: '   ' }],
    ['stub', { WECHAT_STUB_SUBJECT: '\u3000' }],
    ['preset_demo', { WECHAT_STUB_SUBJECT: FIXED }],
    ['preset_demo', {}],
    ['real', { ...REAL_ENV, WECHAT_STUB_SUBJECT: FIXED }],
    ['real', { ...REAL_ENV, WECHAT_STUB_SUBJECT: '   ' }],
  ];
  for (const [mode, extra] of variants) {
    const env = { APP_EXECUTION_MODE: mode, LOG_LEVEL: 'silent', ...extra };
    const config = loadConfig(env);
    const fields = wechatStubSubjectStartupFields(config);
    assert.equal(
      fields.wechat_stub_subject_fixed,
      config.wechatStubSubject !== null,
      `${mode} / ${JSON.stringify(extra)}：启动日志读数必须等于真实生效值`,
    );
    // 「被忽略」只在「非 real 且原始值为纯空白」时出现（real 下该变量本就不生效，不算设错）
    const raw = extra.WECHAT_STUB_SUBJECT;
    const shouldIgnore = config.executionMode !== 'real'
      && typeof raw === 'string' && raw.length > 0 && raw.trim() === '';
    assert.equal(
      'wechat_stub_subject_ignored' in fields,
      shouldIgnore,
      `${mode} / ${JSON.stringify(extra)}：ignored 标注口径`,
    );
    // 配置里那个留痕字段与日志读数必须一致（唯一真值，不复制第二份判据）
    assert.equal(
      config.wechatStubSubjectIgnored,
      shouldIgnore,
      `${mode} / ${JSON.stringify(extra)}：config.wechatStubSubjectIgnored 口径`,
    );
  }
});

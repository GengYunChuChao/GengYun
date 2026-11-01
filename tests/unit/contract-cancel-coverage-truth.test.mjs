/**
 * W39 · 契约 `POST /jobs/{id}/cancel` 的「哪些作业源没有 cancel」钉线（真值口径）。
 *
 * 为什么要有这条钉线（半年后读到这里的人请先读完这段）：
 *   - 契约 `packages/contracts/openapi.json` 是客户端判断「这个取消能不能用」的**唯一真值来源**；
 *     调用方不读 `services/api/src/**`、也不读台账。契约写错，客户端就照着错的做。
 *   - 该端点 `description` 曾经写着「注册进注册表的 6 个源里，**审核源与文字问答源**刻意不提供
 *     cancel，故取消 `kind=moderation` 或 `kind=answer` 的作业会得到 503」——**这是反的**：
 *     GY-R71 已给这两源补上 `cancel`（`services/api/src/moderation/job-source.ts:61`、
 *     `services/api/src/conversations/job.ts:87`），六个源全部实现 `cancel`，
 *     `tests/unit/jobs-cancel-moderation-answer.test.mjs` 里两源的 ① 组都是 200 + `cancelled`。
 *     照旧文案办事的客户端会把**两个已经能取消的域**当成不可用 —— 假话的代价是功能被弃用。
 *   - 台账面（`docs/architecture/ai-ops-spec-status.md`、`docs/development-progress.md`）已由 W38/#818
 *     订正；契约面当时没同步，于是同一件事在两个面互相打脸。本钉线把契约面钉住。
 *
 * 本文件钉五件事，每条都**读仓库里的真文件**（不镜像写手的记忆、不读常量副本）：
 *   T1 旧话不得复活：三句旧话任一子串命中即红；
 *   T2 真值口径必须在：六源全接 + `cancel` + 「503 对已注册 kind 不可达」；
 *   T3 契约语义不得为了改绿而删：428 / 409 / 幂等 / 503 / `retryable:false` / 404 / `no-store` 仍在；
 *   T4 代码事实仍在：六源 `cancel` 的落点、注册表判据 `source.cancel === undefined`；
 *   T5 判定顺序那段说明仍在（防整段被压成一句、把「先判头、再判归属、最后看取消端口」丢掉）。
 *
 * 边界（如实登记）：本文件只证明**契约文案与代码事实一致**，不证明任何真实供应商端口可以取消，
 * 也不替代 HTTP 回环用例（那两条在 `tests/unit/jobs-cancel-moderation-answer.test.mjs`）。
 * 只读：不改契约、不起服务、不连网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const OPENAPI_PATH = new URL('../../packages/contracts/openapi.json', import.meta.url);
const MODERATION_SOURCE = new URL('../../services/api/src/moderation/job-source.ts', import.meta.url);
const CONVERSATIONS_JOB = new URL('../../services/api/src/conversations/job.ts', import.meta.url);
const JOBS_SOURCES = new URL('../../services/api/src/jobs/sources.ts', import.meta.url);
const JOBS_REGISTRY = new URL('../../services/api/src/jobs/registry.ts', import.meta.url);

const read = (url) => readFileSync(url, 'utf8');

/** 契约里 `POST /jobs/{id}/cancel` 的 `post.description`（单行字符串；取不到就直接炸，别静默跳过）。 */
function cancelDescription() {
  const spec = JSON.parse(read(OPENAPI_PATH));
  const op = spec?.paths?.['/jobs/{id}/cancel']?.post;
  assert.ok(op, '契约里读不到 paths["/jobs/{id}/cancel"].post —— 契约结构变了，本钉子失去前提');
  assert.equal(
    typeof op.description,
    'string',
    'paths["/jobs/{id}/cancel"].post.description 不是字符串 —— 本钉子读的就是这段文案',
  );
  return op.description;
}

const DESCRIPTION = cancelDescription();

/** 旧话（三句都要绝迹）。命中的是**假话**，所以红消息必须把真值一起写出来。 */
const STALE_CLAIMS = [
  {
    text: '刻意不提供 cancel',
    why: '旧文案说「某源刻意不提供 cancel」。真值是**六个源全部实现 cancel**'
      + '（识别／转写／合成／OCR 在 jobs/sources.ts:65、107、153、208；审核在 moderation/job-source.ts:61；'
      + '文字问答在 conversations/job.ts:87），没有任何源「刻意不提供」。',
  },
  {
    text: '故取消 kind=moderation 或 kind=answer 的作业会得到它',
    why: '旧文案说取消 moderation/answer 会拿到 503。真值是**这两个 kind 都返回 200 + cancelled**'
      + '（tests/unit/jobs-cancel-moderation-answer.test.mjs 的 moderation·①／answer·① 组）。',
  },
  {
    text: '审核源与文字问答源',
    why: '这句旧话把审核源与文字问答源并列成「不提供取消的那两个」。真值是这两源由 GY-R71 接线、'
      + '都已提供 cancel；契约里不该再出现这个并列式。',
  },
];

test('T1 旧话不得复活：不得再声称某些作业源「不提供 cancel」或「moderation/answer 会拿到 503」', () => {
  const hits = STALE_CLAIMS.filter(({ text }) => DESCRIPTION.includes(text));
  assert.deepEqual(
    hits.map((hit) => hit.text),
    [],
    '契约 paths["/jobs/{id}/cancel"].post.description 里仍留着旧话：\n'
      + hits.map((hit) => `  ✗ 「${hit.text}」\n     为什么它是假话：${hit.why}`).join('\n')
      + '\n真值口径是：注册进注册表的六个源全部实现 cancel，只有「该源自己没实现 cancel」才会 503，'
      + '对今天任何一个已注册 kind 都不可达。',
  );
});

test('T2 真值口径必须在：六源全接 + cancel + 「503 对已注册 kind 不可达」三件缺一不可', () => {
  const hasSix = /六个源/.test(DESCRIPTION) || /6\s*个/.test(DESCRIPTION);
  const hasAll = /全部/.test(DESCRIPTION);
  const hasCancel = /cancel/.test(DESCRIPTION);
  const hasUnreachable = /不可达/.test(DESCRIPTION);

  assert.ok(
    hasSix,
    '契约描述没写出「六个源」这个数量事实（旧文案也写过 6 个，但配的是假话）——'
      + '真值是 services/api/src/app.ts:2515-2566 的 6 条 create*JobSource 实参：'
      + '识别、转写、审核、合成、OCR、文字问答。',
  );
  assert.ok(
    hasAll,
    '契约描述没写出「六个源**全部**实现 cancel」这个真值口径 —— 少了「全部」，'
      + '读者仍会怀疑其中有源没接；旧假话正是从这里长出来的。',
  );
  assert.ok(
    hasCancel,
    '契约描述里连 `cancel` 都不提了 —— 这段文案讲的就是取消端口的有无，丢了它等于没写。',
  );
  assert.ok(
    hasUnreachable,
    '契约描述没写出「503 那条分支对今天任何一个已注册 kind 都不可达」——'
      + '不写这句，调用方会继续以为某些 kind 取消会 503（旧假话的实际后果）。'
      + '真值：该分支只留给「未来注册了却未实现 cancel 的源」（services/api/src/jobs/registry.ts:286-306）。',
  );
});

test('T3 契约语义不得为了改绿而删：428/409/幂等/503/retryable:false/404/no-store 仍在', () => {
  const required = [
    ['428 REVISION_REQUIRED', '缺 If-Match 的状态码（契约 x-version-required）'],
    ['409 REVISION_CONFLICT', 'If-Match 与当前 revision 不符的状态码'],
    ['IDEMPOTENCY_KEY_REQUIRED', '幂等键非法时的错误码'],
    ['PROVIDER_UNAVAILABLE', '503 的错误码（该作业所属能力尚未提供取消）'],
    ['retryable:false', '503 的 retryable 口径（接线是发版动作，原样重试不会成功）'],
    ['404 NOT_FOUND', '作业不存在/越权同形 404 的错误码'],
    ['no-store', '200 响应的缓存指令（与 GET /jobs/{id} 同形）'],
  ];
  const missing = required
    .filter(([needle]) => !DESCRIPTION.includes(needle))
    .map(([needle, meaning]) => `  ✗ 缺「${needle}」—— 它表示：${meaning}`);
  assert.deepEqual(
    missing,
    [],
    '契约描述丢了真值要素（本钉子是**反向钉**：禁止用「删语义」换「改绿」）：\n' + missing.join('\n'),
  );
});

test('T4 代码事实仍在：六源 cancel 的落点 + 注册表按源判 source.cancel === undefined', () => {
  const moderation = read(MODERATION_SOURCE);
  const conversations = read(CONVERSATIONS_JOB);
  const sources = read(JOBS_SOURCES);
  const registry = read(JOBS_REGISTRY);

  assert.ok(
    moderation.includes('async cancel(input: JobSourceCancelInput)'),
    'services/api/src/moderation/job-source.ts 里读不到 `async cancel(input: JobSourceCancelInput)` ——'
      + '审核源要么拆了 cancel、要么签名变了。若这里是真拆，契约描述与 T2 都得跟着改，不许只改绿测试。',
  );
  assert.ok(
    conversations.includes('async cancel(input: JobSourceCancelInput)'),
    'services/api/src/conversations/job.ts 里读不到 `async cancel(input: JobSourceCancelInput)` ——'
      + '文字问答源的 cancel 没了；契约却仍写着六源全接，那就是新的假话。',
  );
  assert.ok(
    conversations.includes('deps.cancelJob({'),
    'services/api/src/conversations/job.ts 里读不到 `deps.cancelJob({` —— 取消不再委托给会话域的 cancelTurn，'
      + '「真取消（只写作业快照、不写回答）」这条语义失去落点。',
  );

  const sourceCancelHits = sources.match(/cancel\s*[:(]/g) ?? [];
  assert.ok(
    sourceCancelHits.length >= 4,
    `services/api/src/jobs/sources.ts 里 cancel 端口只剩 ${sourceCancelHits.length} 处（要求 ≥ 4）——`
      + '识别／转写／合成／OCR 四个源各要有一个 cancel（当前在 :65、:107、:153、:208）。',
  );

  assert.ok(
    registry.includes('if (source.cancel === undefined) {'),
    'services/api/src/jobs/registry.ts 里读不到 `if (source.cancel === undefined) {` ——'
      + '503 的判据是**按源判**（该源有没有 cancel 端口），不是按 kind 白名单；判据变了，契约描述必须重写。',
  );
});

test('T5 判定顺序仍在：先判两个头的形状 → 再判归属 → 最后才看有没有取消端口', () => {
  assert.ok(
    DESCRIPTION.includes('判定顺序'),
    '契约描述里没有「判定顺序」这类顺序表述 —— 整段可能被压成一句，读者就不知道'
      + '缺 If-Match 的 428 早于版本比对、归属的 404 早于「有没有取消端口」。',
  );
  assert.ok(
    DESCRIPTION.includes('先判'),
    '契约描述里没有「先判」—— 顺序说明被删掉了。真顺序：先判两个头的形状（缺 If-Match 得 428，'
      + '早于版本比对）→ 再判作业归属（同形 404）→ 最后才看该源有没有取消端口（未接线 ⇒ 503，'
      + '绝不谎报已取消，也不用 409 顶替）。',
  );
});

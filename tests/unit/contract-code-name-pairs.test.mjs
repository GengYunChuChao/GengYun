/**
 * GY-R68 · 契约描述里「三位数 + 错误码名」的**配对**闸门。
 *
 * ── 为什么要有这把**独立**的尺子 ─────────────────────────────────────────────
 * `tests/unit/admin-contract-docs.test.mjs` 的 `C②`／`C②-me`／`C②-rest` 只判
 * 「描述里的三位数 ⊆ 该 op 自己 `responses` 的键」。对抗审查实测出的结构性盲区：
 *
 *   把 `publishSource` 描述里的「400 `INVALID_REQUEST`」改成「422 `INPUT_UNCERTAIN`」、
 *   或把「200 且 `changed:false`」改成「409」，**九道门禁全绿**——因为 422 与 409 都在这条 op
 *   的 `responses` 里，而**名字根本没被检查**（`C②` 不判「数字 ↔ 名字」这一对是否成立）。
 *
 * 本文件补的正是那一维：**配对必须与仓里的权威映射一致**。它与 `C②` 互补、不重叠：
 *   - `C②`：这个数字是不是这条 op 自己声明的？（集合 × 声明）
 *   - 本文件：这个名字允许这个数字吗？（名字 × 状态档）
 * 两条同时绿，才意味着「描述里写的 `422 INPUT_UNCERTAIN` 既被该 op 声明、也是该码的真实档位」。
 *
 * ── 权威映射在哪（⛔ 与任务书写的不完全一致，以文件为准）──────────────────────
 * 任务书说 `apps/admin/src/lib/admin-contract.mjs` 里有 `ERROR_CODES` 与 `ERROR_STATUS_MAP`。
 * **实测：该文件只有 `ERROR_CODES`**（`Object.freeze([...])` 冻结**数组**，28 项，不是 Set／Map），
 * **没有** `ERROR_STATUS_MAP`（全仓 `git grep ERROR_STATUS_MAP` 在该文件里零命中）。
 * 因此本文件的取真方式拆成两半，并把两者的**一致性**用断言钉死：
 *   1. **名字集**（判据 2 的「在册」口径）：直接 `import` 上面那个模块的 `ERROR_CODES`
 *      （纯 ESM、无 Vue／DOM 依赖、无 `import` 子句，`node --test` 可直接 import）。
 *   2. **状态档**（判据 1 的「允许状态码」口径）：`packages/contracts/states.json` 的
 *      `error_status_map`（13 个状态档 / 28 码；`docs/architecture/ai-ops-spec-status.md` 的 E37
 *      把它写成「事实源」）。
 *   3. 断言 ①②③：`ERROR_CODES` 集合 === `packages/contracts/openapi.json` 的
 *      `components.schemas.ErrorCode.enum` 集合 === `error_status_map` 摊平去重后的集合；
 *      且 `error_status_map` 与 `services/api/src/contract.ts` 的 `ERROR_STATUS_MAP`
 *      逐档相等（**防「闸门对着一份过期镜像判绿」**——`services/api` 那份是运行期消费方，
 *      `states.json` 是事实源，两边一漂移就红）。
 *
 * ── 五组判据 ──────────────────────────────────────────────────────────────────
 *   ① 配对一致：每处「三位数 + 错误码名」都必须满足 `ERROR_STATUS_MAP[name] ∋ 该状态码`。
 *      两种写法都覆盖：`400 INVALID_REQUEST`（状态在前）与 `INVALID_REQUEST（400）` /
 *      `INVALID_REQUEST(400)`（名字在前、括号括起状态；`（:361）` 这种行号锚**不算**配对）。
 *   ①′ 不许写反话：「`NAME` 不是 400」这种**否定式**也是配对声明的一种，判据 ① 的封闭写法覆盖不到
 *      （`不是` 不在两种配对形态里，而 ③ 只要求「从句里有三位数」就跳过）。所以单独判：
 *      **句子里否认的那一对如果其实成立**（`NAME` 的真实档位就是那个数）⇒ 红。例：
 *      「`INVALID_REQUEST` 不是 400」是假话 ⇒ 红；「`SELF_DISABLE_DENIED` 不是 400」是真话 ⇒ 不红
 *      （真话没撒谎，只是没用；它照旧被 ③ 的「名字必带码」盯着，句子里有三位数就不算裸名字）。
 *      ⚠ 实现口径与派单原话**相反**，理由写在这里而不是埋进代码：派单写「该码的真实档位**不是**这个数 ⇒ 红」，
 *      照字面会把「`INVALID_REQUEST` 不是 422」（真话）判红、却放走「`INVALID_REQUEST` 不是 400」（假话），
 *      正好漏掉派单自己举的那个例子。假话才红，是与 ① 同向的判据，不会把正常否定句变成新噪音
 *      （当前 126 条描述里「不是 + 三位数」实测 0 处）。
 *   ② 名字在册：配对里的名字必须出现在 `ERROR_CODES` 里（拼错即红，如 `INVALID_REQEUST`）。
 *   ③ 名字必带码：某个**从句**里出现了 `ERROR_CODES` 里的名字、却没有跟着任何三位数 ⇒ 红
 *      （堵住「只写 `INPUT_UNCERTAIN` 不写 422」这种躲开判据 ① 的写法）。
 *      从句切分 = `。`／`；`／换行；**唯一豁免**是明确否定句（「不适用」「不涉及」…，见
 *      `NEGATION` 正则）——当前 126 条描述实测只命中 2 处，且都在
 *      `enableAdministratorAccount`（「`SELF_DISABLE_DENIED` 不适用于恢复面」这类**非断言**句）。
 *      ⛔ 这条没有降级成「只报告」：实测命中 2 ≤ 10（任务书的降级阈值），且两处都是否定句、
 *      已按机制豁免而不是按 op 白名单豁免。豁免条数被**钉死为 2**，新增豁免必须人工复核。
 *   ④ 反空转：扫到的 operation 数 === 126；真判到的**配对条数** ≥ 434；带配对的 operation 数 ≥ 108；
 *      每个 op 的配对条数不低于 `PAIR_BASELINE_BY_OP` 里登记的实测值；来自**非 admin 族**
 *      （path 不以 `/admin` 开头）的配对数 ≥ 20。
 *      ⚠ 说清哪一半是机制、哪一半只是纪律：**逐 op 下界是机制**——「从 `getMedia` 删一条、
 *      往 `publishSource` 补一条」让总数仍是 434 也照样红（`getMedia` 掉到它的登记值以下）。
 *      而「总配对数 ≥ 434」只是**纪律**：那个 434 就是本文件里的一个字面量，谁想凑绿都能把它改小
 *      （把 `MIN_PAIR_COUNT` 从 434 调成 400，聚合断言立刻变绿），所以它挡的是「抽取器整体退化」，
 *      挡不住「此处删、彼处补」的对冲；对冲由逐 op 下界和「带配对的 op 数 ≥ 108」共同挡住。
 *   ⑤ 变异自证：M1／M2／M3 三条（见 `docs`／交付报告），只在 `$env:TEMP` 的**副本**上做，
 *      通过 `GY_CODEPAIR_SPEC_PATH` 指过去，⛔ 从不动被跟踪的 `openapi.json`。
 *
 * ── 读路径 ────────────────────────────────────────────────────────────────────
 * 默认读仓内真文件 `packages/contracts/openapi.json`（由本文件位置推出仓根，⛔ 不用 `process.cwd()`）。
 * 环境变量 `GY_CODEPAIR_SPEC_PATH` 只服务于「先红／变异自证」，默认值下产品行为不变。
 *
 * ── 已知限制（如实记账，别当成已覆盖）────────────────────────────────────────
 *   L1 只判「同一个从句里的数字 + 名字」。跨从句的远距离配对（「400 ⇒ …由于 X…`INVALID_REQUEST`」）
 *      不在判据 ① 的射程里；判据 ③ 会把「名字所在从句没有三位数」的情况兜住，但兜不住
 *      「从句里有**别的**三位数、名字却配错」的远距离写法。
 *   L2 「非括号式」的名字在前写法（`INVALID_REQUEST 400`、`INVALID_REQUEST ⇒ 400`）不判 ①；
 *      当前 126 条描述实测 0 处（实测 434 处全是「状态在前 + 单空格」）。这是刻意的：放宽成
 *      `名字 … 若干字符 … 数字` 会把 `…INVALID_CURSOR（:864）` 这类行号锚当成配对，误报远多于真报。
 *   L3 拼错的名字若**不带**任何三位数，判据 ②③ 都不响（它不在 `ERROR_CODES` 里，也不被当作「在册名字」）；
 *      同理，拼错的名字出现在「`NAME` 不是 400」这种否定句里也不判 ①，因为 ①′ 只对在册名字取真。
 *      这是「名字在册」判据的固有边界：先得看起来像个配对，才轮得到查拼写。
 *   L4 只对 `summary` 与 `description` 两字段取真；`x-*` 扩展字段里的文字不在射程内。
 *   L5 **覆盖边界（最要紧的一条）**：配对只能判「已经写了配对」的地方。基线实测 126 条 op 里
 *      **108 条带配对、18 条一个都没有**（`loginAdmin`、`publishSource`、`createSourceDraft`、
 *      `hidePost`、`rejectPost` 等，清单见交付报告）。这 18 条的数字改动本闸门**零覆盖**——
 *      例如 `publishSource` 把「成功 200」改成 409 仍然全绿（它描述里没有错误码名）。补这个洞
 *      需要另一把尺子（「数字必须挨着名字」反向判据），不在本片射程内。
 *   L6 自证样例里的「文件:行」刻意用**不存在**的目标（`routes/ocr-sample.ts:224-257`）。
 *      原因不是懒：仓里既有守卫 `tests/unit/test-line-anchors-guard.test.mjs` 会拦「写死且**真实存在**的
 *      源文件:行号」出现在断言实参里（它防的是会漂移的硬编码锚）。自证只需要一段**长得像**行号锚的
 *      输入串，用真文件锚会让本文件被那个守卫点名——第一版就是这么红的（全量 glob `tests/unit/*.test.mjs`
 *      exit 1）。所以：形状照旧可判，目标保持 phantom。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 权威映射之一：后台侧纯常量模块（`apps/admin/src/lib/admin-contract.mjs`）。
 * ⛔ 这是**唯一**的名字集权威；本文件不另抄一份名字清单。
 */
import { ERROR_CODES } from '../../apps/admin/src/lib/admin-contract.mjs';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 契约本体（仓内真文件）——判据读的就是它。 */
const DEFAULT_SPEC_PATH = resolve(REPO_ROOT, 'packages', 'contracts', 'openapi.json');

/** 状态档的事实源（`error_status_map`）。 */
const STATES_PATH = resolve(REPO_ROOT, 'packages', 'contracts', 'states.json');

/** 运行期消费方（TS 常量块），只用来和 `states.json` 交叉核对，不参与判据取值。 */
const CONTRACT_TS_PATH = resolve(REPO_ROOT, 'services', 'api', 'src', 'contract.ts');

/** 变异／先红专用覆盖：只有显式传入才生效。 */
const SPEC_PATH = process.env.GY_CODEPAIR_SPEC_PATH
  ? resolve(process.env.GY_CODEPAIR_SPEC_PATH)
  : DEFAULT_SPEC_PATH;

/**
 * 相对仓根的正斜杠路径，只用于报错信息里的「文件:行」。
 * 变异／先红时 spec 在仓外（`%TEMP%`），此时保留绝对路径，⛔ 不要拼出 `air/M1.json` 这种假路径。
 */
function relativeToRepo(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, '/');
  return normalized.startsWith(`${REPO_ROOT.replace(/\\/g, '/')}/`)
    ? normalized.slice(REPO_ROOT.length + 1)
    : normalized;
}

const SPEC_REL = relativeToRepo(SPEC_PATH);
const SPEC_RAW = readFileSync(SPEC_PATH, 'utf8');
const spec = JSON.parse(SPEC_RAW);
const states = JSON.parse(readFileSync(STATES_PATH, 'utf8'));
const contractTsSource = readFileSync(CONTRACT_TS_PATH, 'utf8');

/** 方法白名单：口径与 `admin-contract-docs.test.mjs` 的 `METHODS` 一致。 */
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** 契约实测的 operation 数（下界，只许涨不许降；`A1+A4+A6 = 49+17+60 = 126`）。 */
const EXPECTED_OPERATION_COUNT = 126;

/** 实测配对下界（`node` 探针在基线 `ff73a30f` 上数出来的 434），**只许涨不许降**。 */
const MIN_PAIR_COUNT = 434;

/** 非 admin 族配对的**结构性**下界（任务书要求 ≥ 20；实测 288，见报告）。 */
const MIN_NON_ADMIN_PAIR_COUNT = 20;

/** 带配对的 operation 数下界（实测 108 条；126 − 108 = 18 条描述里压根没有配对）。 */
const MIN_OPERATIONS_WITH_PAIRS = 108;

/**
 * **逐 op 配对下界**：基线 `ff73a30f` 上每条 op 的实测配对条数。
 *
 * 为什么需要它（这是个真实的漏法，不是假想）：只有「总配对数 ≥ 434」时，
 * 「从 `getMedia` 删掉一条、往 `publishSource` 补一条」让总数仍是 434 ⇒ 全绿，
 * 而描述已经少了一条该有的配对。逐 op 下界把这种**补偿式对冲**堵住：谁掉到登记值以下就红。
 *
 * 纪律：这里的数字**只许涨**。真要从某条 op 删配对（例如契约改了），请把该 op 的数字一起改，
 * 并在 PR 里说明为什么这条描述本该少一条——不要为了让闸门变绿而调数字，那样等于把下界改成了橡皮筋。
 * 18 条没有配对的 op（`loginAdmin`、`publishSource`、`hidePost`…）**不登记**：它们从 0 涨到 1 是合法的
 * 好事，不该逼人改基线；它们掉不下去（0 已经是最低）。
 */
const PAIR_BASELINE_BY_OP = Object.freeze({
  'grantAdministratorScope': 23, 'disableAdministratorAccount': 21, 'revokeAdministratorScope': 19,
  'enableAdministratorAccount': 15, 'listAdministrators': 11, 'completeUpload': 9,
  'listAdministratorScopes': 9, 'listAuditLogs': 9, 'listCrops': 9, 'listRegions': 9,
  'createSynthesis': 8, 'getJob': 8, 'listMessages': 8, 'markMessageRead': 8, 'cancelJob': 7,
  'createUpload': 7, 'deleteMedia': 7, 'grantMediaAccess': 7, 'listConversations': 7,
  'listKnowledge': 7, 'getProfile': 6, 'grantConsent': 6, 'listPosts': 6, 'putProfile': 6,
  'createRecognition': 5, 'getUserSession': 5, 'listExports': 5, 'logoutUser': 5,
  'requestAccountDeletion': 5, 'withdrawConsent': 5, 'cancelDeletion': 4, 'createConversation': 4,
  'createOCR': 4, 'deleteFavorite': 4, 'deleteHistory': 4, 'deletePost': 4, 'deleteRecognition': 4,
  'editSourceDraft': 4, 'getDeletionReceipt': 4, 'getPostLike': 4, 'listSpecies': 4, 'logoutAdmin': 4,
  'confirmTranscription': 3, 'createComment': 3, 'createFavorite': 3, 'createTranscription': 3,
  'createTurn': 3, 'deleteComment': 3, 'deleteConversation': 3, 'deleteOCR': 3,
  'deleteTranscription': 3, 'deleteTurn': 3, 'editPost': 3, 'getKnowledge': 3, 'getMedia': 3,
  'listConsents': 3, 'listFlags': 3, 'selectSpecies': 3, 'unlikeComments': 3, 'correctOCR': 2,
  'createPost': 2, 'createReport': 2, 'editComment': 2, 'getAdminKnowledge': 2,
  'getAdminRegistration': 2, 'getAdminRestriction': 2, 'getAdminSession': 2, 'getAdminSource': 2,
  'getHerbicide': 2, 'getPublicHome': 2, 'getUnreadCount': 2, 'likeComments': 2, 'likePosts': 2,
  'listAuditEvents': 2, 'listFavorites': 2, 'listHerbicides': 2, 'listHistory': 2, 'listTurns': 2,
  'loginWechat': 2, 'suspendUser': 2, 'unlikePosts': 2, 'verifyOCR': 2, 'verifyRegistration': 2,
  'approvePost': 1, 'editCategory': 1, 'getComment': 1, 'getConversation': 1, 'getOCR': 1,
  'getOwnReport': 1, 'getPost': 1, 'getPrivacyPolicy': 1, 'getRecognition': 1, 'getTranscription': 1,
  'grantCommunityMediaAccess': 1, 'listAdminCategories': 1, 'listAdminKnowledge': 1,
  'listAdminRegistration': 1, 'listAdminRestriction': 1, 'listAdminSources': 1, 'listAdminUsers': 1,
  'listComments': 1, 'listFlagAuditEvents': 1, 'readCommunityMediaContent': 1, 'setFlag': 1,
  'withdrawKnowledge': 1, 'withdrawRegistration': 1, 'withdrawRestriction': 1, 'withdrawSource': 1,
});

/** 判据 ③ 的否定句豁免条数（实测 2，钉死：新增豁免必须人工复核）。 */
const EXPECTED_NEGATION_EXEMPTION_COUNT = 2;

/** 错误码名形状：全大写 + 下划线分段（`INVALID_REQUEST`、`IDEMPOTENCY_KEY_REQUIRED`…）。 */
const CODE_TOKEN = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';

/**
 * 写法 A（状态在前）：`400 INVALID_REQUEST`，兼容包一层引号／书名号。
 * 前后都不许连数字（`1000 X`／`4250 X` 不是状态码）。
 */
const PAIR_STATUS_FIRST = new RegExp(
  `(?<![0-9])([0-9]{3})(?![0-9])[ \\t]*[「『"']?(${CODE_TOKEN})[」』"']?`,
  'g',
);

/**
 * 写法 B（名字在前）：`INVALID_REQUEST（400）`／`INVALID_REQUEST(400)`。
 * ⛔ 括号里**不许**出现冒号：`NOT_FOUND（:298-310）` 是行号锚，不是配对。
 */
const PAIR_NAME_FIRST = new RegExp(
  `(?<![A-Z0-9_])(${CODE_TOKEN})(?![A-Z0-9_])[ \\t]*[（(][ \\t]*([0-9]{3})[ \\t]*[）)]`,
  'g',
);

/** 从句里出现这些词 ⇒ 该句是「这个码不适用」的**非断言**，不是配对声明。 */
const NEGATION = /(不适用|不涉及|不含|不返回|不会|而不是|无需|不用于|不覆盖|不产生)/;

/**
 * 写法 C（否定式）：`INVALID_REQUEST 不是 400`／`并非 400`／`不等于 400`。
 * 判据 ① 的两种封闭形态都盖不到它（`不是` 不是分隔符），而判据 ③ 只要从句里有三位数就跳过，
 * 于是「把真话写成反话」能从 ①③ 之间溜过去。这里单独抽出来判：**否认了其实成立的一对**才红。
 */
const DENIED_PAIR = new RegExp(
  `(?<![A-Z0-9_])(${CODE_TOKEN})(?![A-Z0-9_])[ \\t]*(?:不是|并非|不等于)[ \\t]*(?<![0-9])([0-9]{3})(?![0-9])`,
  'g',
);

/** `states.json` 的 `error_status_map`：状态档 → 允许的错误码。 */
const SPEC_STATUS_MAP = states.error_status_map ?? {};

/** 名字 → 允许的状态码集合（判据 ① 的唯一依据）。 */
const ALLOWED_STATUS_BY_NAME = new Map();
for (const [status, codes] of Object.entries(SPEC_STATUS_MAP)) {
  for (const code of codes) {
    if (!ALLOWED_STATUS_BY_NAME.has(code)) ALLOWED_STATUS_BY_NAME.set(code, new Set());
    ALLOWED_STATUS_BY_NAME.get(code).add(Number(status));
  }
}

/** 名字集（来自后台侧权威模块）。 */
const REGISTRY = new Set(ERROR_CODES);

/**
 * 这个名字允许这个状态码吗？
 * 未在册的名字一律 `false`（判据 ② 会先把拼错的名字单独点出来）。
 */
function isAllowedPair(name, status) {
  const allowed = ALLOWED_STATUS_BY_NAME.get(name);
  return allowed ? allowed.has(Number(status)) : false;
}

/** 从一段文字里抽出所有「三位数 + 错误码名」配对（两种写法；按出现位置排序）。 */
function extractPairs(text) {
  const pairs = [];
  for (const match of text.matchAll(PAIR_STATUS_FIRST)) {
    pairs.push({
      form: '状态在前',
      status: Number(match[1]),
      name: match[2],
      raw: match[0],
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(PAIR_NAME_FIRST)) {
    pairs.push({
      form: '名字在前',
      status: Number(match[2]),
      name: match[1],
      raw: match[0],
      index: match.index ?? 0,
    });
  }
  return pairs.sort((left, right) => left.index - right.index);
}

/** 扫全 spec，返回 126 条 `{ operationId, path, method, tags, fields }`。 */
function collectOperations(document) {
  const collected = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      collected.push({
        operationId: typeof op.operationId === 'string' ? op.operationId : `${method.toUpperCase()} ${path}`,
        path,
        method,
        tags: Array.isArray(op.tags) ? op.tags.filter((tag) => typeof tag === 'string') : [],
        fields: [
          { field: 'summary', text: typeof op.summary === 'string' ? op.summary : '' },
          { field: 'description', text: typeof op.description === 'string' ? op.description : '' },
        ],
      });
    }
  }
  return collected;
}

/** 后台族口径与既有闸门一致：path 以 `/admin` 开头。 */
function isAdminPath(path) {
  return path === '/admin' || path.startsWith('/admin/');
}

/** 在 `openapi.json` 的**原文**里定位这段文本的行号（找不到就退回该 op 的 `operationId` 行）。 */
function specLineFor(operationId, needle) {
  const opIndex = SPEC_RAW.indexOf(`"operationId": "${operationId}"`);
  const from = opIndex >= 0 ? opIndex : 0;
  const at = needle ? SPEC_RAW.indexOf(needle, from) : -1;
  const index = at >= 0 ? at : from;
  return SPEC_RAW.slice(0, index).split('\n').length;
}

/** 统一的出错位置串：`文件:行（operationId · 字段）`。 */
function whereFor(operation, field, needle) {
  return `${SPEC_REL}:${specLineFor(operation.operationId, needle)}`
    + `（operationId ${operation.operationId} · ${field}）`;
}

const OPERATIONS = collectOperations(spec);

/** 把 126 条 operation 的 `summary` + `description` 全部过一遍，收集配对。 */
const PAIRS = [];
for (const operation of OPERATIONS) {
  for (const { field, text } of operation.fields) {
    for (const pair of extractPairs(text)) {
      PAIRS.push({ ...pair, operation, field });
    }
  }
}

const ADMIN_PAIRS = PAIRS.filter((pair) => isAdminPath(pair.operation.path));
const NON_ADMIN_PAIRS = PAIRS.filter((pair) => !isAdminPath(pair.operation.path));

/** 按首个 tag 归族，只用于报告与诊断输出。 */
function familyOf(operation) {
  return operation.tags[0] ?? '(untagged)';
}

/** 判据 ①：配对里的状态码必须在名字的允许档位里。 */
function pairingViolations() {
  const violations = [];
  for (const pair of PAIRS) {
    if (!REGISTRY.has(pair.name)) continue; // 拼错的名字交给判据 ②
    if (isAllowedPair(pair.name, pair.status)) continue;
    const allowed = [...(ALLOWED_STATUS_BY_NAME.get(pair.name) ?? [])].sort((left, right) => left - right);
    violations.push({
      where: pair.operation.operationId,
      file: whereFor(pair.operation, pair.field, pair.raw),
      snippet: pair.raw,
      detail: `\`${pair.name}\` 的允许状态码是 [${allowed.join(', ')}]，描述里写的是 ${pair.status}`
        + `（${pair.form}）`,
    });
  }
  return violations;
}

/** 判据 ②：配对里的名字必须拼在册。 */
function unknownNameViolations() {
  const violations = [];
  for (const pair of PAIRS) {
    if (REGISTRY.has(pair.name)) continue;
    const nearest = ERROR_CODES.filter((code) => code.startsWith(pair.name.slice(0, 5))).slice(0, 3);
    violations.push({
      where: pair.operation.operationId,
      file: whereFor(pair.operation, pair.field, pair.raw),
      snippet: pair.raw,
      detail: `\`${pair.name}\` 不在 \`ERROR_CODES\`（28 项）里`
        + (nearest.length ? `；相近的在册名字：[${nearest.join(', ')}]` : ''),
    });
  }
  return violations;
}

/** 判据 ③：名字所在从句必须带三位数；返回 `{ violations, exempt }`。 */
function bareNameViolations() {
  const violations = [];
  const exempt = [];
  const names = [...REGISTRY];
  for (const operation of OPERATIONS) {
    for (const { field, text } of operation.fields) {
      for (const clause of text.split(/[。；\n]+/)) {
        if (!clause.trim()) continue;
        const mentioned = [];
        for (const name of names) {
          const re = new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`, 'g');
          if (re.test(clause)) mentioned.push(name);
        }
        if (!mentioned.length) continue;
        if (/(?<![0-9])[0-9]{3}(?![0-9])/.test(clause)) continue; // 从句里有三位数 ⇒ 判据 ① 管
        for (const name of mentioned) {
          const record = {
            where: operation.operationId,
            file: `${SPEC_REL}:${specLineFor(operation.operationId, clause.trim().slice(0, 12))}`
              + `（operationId ${operation.operationId} · ${field}）`,
            snippet: clause.trim(),
            name,
          };
          if (NEGATION.test(clause)) exempt.push(record);
          else violations.push(record);
        }
      }
    }
  }
  return { violations, exempt };
}

/** 判据 ①′：抽出一段文字里的**否定式**声明（`NAME 不是 400`），分成「假话」与「真话」两堆。 */
function collectDenials(text) {
  const lies = [];
  const truthful = [];
  for (const match of text.matchAll(DENIED_PAIR)) {
    const name = match[1];
    const status = Number(match[2]);
    if (!REGISTRY.has(name)) continue; // 拼错的名字交给判据 ②；这里只判在册名字的账
    const record = { name, status, raw: match[0], index: match.index ?? 0 };
    if (isAllowedPair(name, status)) lies.push(record);
    else truthful.push(record);
  }
  return { lies, truthful };
}

/** 判据 ①′ 的扫描结果：真话也收进来，只用来打诊断（不判红）。 */
const DENIALS = [];
for (const operation of OPERATIONS) {
  for (const { field, text } of operation.fields) {
    const { lies, truthful } = collectDenials(text);
    for (const item of lies) DENIALS.push({ ...item, operation, field, isLie: true });
    for (const item of truthful) DENIALS.push({ ...item, operation, field, isLie: false });
  }
}

/** 逐 op 配对条数（判据 ④ 的逐 op 下界用）。 */
const PAIR_COUNT_BY_OP = new Map();
for (const pair of PAIRS) {
  PAIR_COUNT_BY_OP.set(pair.operation.operationId, (PAIR_COUNT_BY_OP.get(pair.operation.operationId) ?? 0) + 1);
}

/** 判据 ①′：否认了其实成立的一对 ⇒ 红。 */
function falseDenialViolations() {
  const violations = [];
  for (const item of DENIALS) {
    if (!item.isLie) continue;
    const allowed = [...(ALLOWED_STATUS_BY_NAME.get(item.name) ?? [])].sort((left, right) => left - right);
    violations.push({
      where: item.operation.operationId,
      file: whereFor(item.operation, item.field, item.raw),
      snippet: item.raw,
      detail: `描述说「\`${item.name}\` 不是 ${item.status}」，但 \`${item.name}\` 的允许状态码正是 `
        + `[${allowed.join(', ')}]——这句是反话（判据 ① 的两种配对形态都盖不到「不是」）`,
    });
  }
  return violations;
}

/** 判据 ④：每条登记过的 op 都不能掉到自己的实测下界以下（堵「此处删、彼处补」的对冲）。 */
function perOperationDeficits(countByOperation = PAIR_COUNT_BY_OP) {
  const deficits = [];
  for (const [operationId, baseline] of Object.entries(PAIR_BASELINE_BY_OP)) {
    const current = countByOperation.get(operationId) ?? 0;
    if (current >= baseline) continue;
    deficits.push({
      where: operationId,
      file: `${SPEC_REL}（operationId ${operationId} · summary + description）`,
      snippet: `当前 ${current} 条配对`,
      detail: `基线登记 ${baseline} 条，掉了 ${baseline - current} 条。`
        + '这很可能是「从这条 op 删掉一条、往别的 op 补一条」的对冲（总数 434 不变，聚合断言看不见）',
    });
  }
  return deficits;
}

function formatViolations(violations) {
  return violations
    .map((violation) => `  · ${violation.where} @ ${violation.file}\n      原文：「${violation.snippet}」\n      ${violation.detail}`)
    .join('\n');
}
// ───────────────────────────── 判据 0：权威映射自洽 ─────────────────────────────

test('①权威 名字集：admin-contract.mjs 的 ERROR_CODES === openapi 的 ErrorCode.enum === states.json 的 error_status_map', () => {
  assert.ok(Array.isArray(ERROR_CODES), 'ERROR_CODES 必须是数组（该模块导出的是 Object.freeze([...])）');
  assert.equal(ERROR_CODES.length, 28, `ERROR_CODES 有 ${ERROR_CODES.length} 项（基线 28）`);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length, 'ERROR_CODES 内部有重复项');

  const enumCodes = spec.components?.schemas?.ErrorCode?.enum;
  assert.ok(Array.isArray(enumCodes), '`components.schemas.ErrorCode.enum` 必须是数组');

  const fromSpec = [...enumCodes].sort();
  const fromAdmin = [...ERROR_CODES].sort();
  const fromStates = [...ALLOWED_STATUS_BY_NAME.keys()].sort();

  assert.deepEqual(fromAdmin, fromSpec,
    '`apps/admin/src/lib/admin-contract.mjs` 的 ERROR_CODES 与契约 `ErrorCode.enum` 集合不一致'
    + `——只多：[${fromAdmin.filter((code) => !fromSpec.includes(code)).join(', ')}]；`
    + `只少：[${fromSpec.filter((code) => !fromAdmin.includes(code)).join(', ')}]`);
  assert.deepEqual(fromStates, fromSpec,
    '`packages/contracts/states.json` 的 error_status_map 摊平后与契约 `ErrorCode.enum` 集合不一致');
});

test('①权威 状态档：states.json 的 error_status_map 与 services/api/src/contract.ts 的 ERROR_STATUS_MAP 逐档相等', () => {
  const block = contractTsSource.match(/export const ERROR_STATUS_MAP = \{([\s\S]*?)\n\} as const;/);
  assert.ok(block, '`services/api/src/contract.ts` 里没找到 `export const ERROR_STATUS_MAP = { … } as const;` 块');

  const fromTypeScript = {};
  for (const match of block[1].matchAll(/([0-9]{3}):\s*\[([^\]]*)\]/g)) {
    fromTypeScript[match[1]] = match[2]
      .split(',')
      .map((code) => code.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  assert.deepEqual(Object.keys(fromTypeScript).sort(), Object.keys(SPEC_STATUS_MAP).sort(),
    '`contract.ts` 与 `states.json` 的状态档键集不一致');
  for (const status of Object.keys(SPEC_STATUS_MAP)) {
    assert.deepEqual([...fromTypeScript[status]].sort(), [...SPEC_STATUS_MAP[status]].sort(),
      `${status} 档：\`contract.ts\` 与 \`states.json\` 的码集不一致`
      + '（这正说明闸门会对着一份过期镜像判绿）');
  }
  assert.equal(new Set(Object.values(SPEC_STATUS_MAP).flat()).size, 28, '状态档摊平去重后必须是 28 码');
});

// ───────────────────────────── 判据 1／2／3 ─────────────────────────────

test('①配对一致：每处「三位数 + 错误码名」都必须落在该名字的允许状态码里', () => {
  const violations = pairingViolations();
  assert.deepEqual(violations, [],
    `有 ${violations.length} 处「状态码 ↔ 错误码名」配对与 \`states.json\` 的 error_status_map 不符：\n`
    + formatViolations(violations));
});

test('②名字在册：配对里的名字必须出现在 ERROR_CODES 里（拼错即红）', () => {
  const violations = unknownNameViolations();
  assert.deepEqual(violations, [],
    `有 ${violations.length} 处配对用了不在册的错误码名：\n` + formatViolations(violations));
});

test('③名字必带码：出现错误码名的从句必须带三位数（唯一豁免＝明确否定句）', () => {
  const { violations, exempt } = bareNameViolations();
  assert.deepEqual(violations, [],
    `有 ${violations.length} 处「写了错误码名却没写它的三位数」：\n` + formatViolations(violations));
  assert.equal(exempt.length, EXPECTED_NEGATION_EXEMPTION_COUNT,
    `否定句豁免条数变成了 ${exempt.length}（基线钉死 ${EXPECTED_NEGATION_EXEMPTION_COUNT}）：\n`
    + exempt.map((item) => `  · ${item.where} · ${item.name}「${item.snippet}」`).join('\n')
    + '\n新增豁免必须人工复核：它可能是新写的真实漏洞，也可能是新加的否定句。');
});

// ───────────────────────────── 判据 1′：不许写反话 ─────────────────────────────

test('①′不许写反话：「NAME 不是 400」否认了其实成立的一对 ⇒ 红', () => {
  const violations = falseDenialViolations();
  assert.deepEqual(violations, [],
    `有 ${violations.length} 处否定式声明与映射相反：\n` + formatViolations(violations));
});

// ───────────────────────────── 判据 4：反空转 ─────────────────────────────

test('④反空转：扫到 126 条 operation、配对数 ≥ 434、非 admin 族配对 ≥ 20', () => {
  assert.equal(OPERATIONS.length, EXPECTED_OPERATION_COUNT,
    `扫到 ${OPERATIONS.length} 条 operation（应为 ${EXPECTED_OPERATION_COUNT}）`
    + '——检查 `GY_CODEPAIR_SPEC_PATH` 是否指错了文件');

  assert.ok(PAIRS.length >= MIN_PAIR_COUNT,
    `只抽到 ${PAIRS.length} 处配对（下界 ${MIN_PAIR_COUNT}，只许涨不许降）`
    + '——抽取正则退化了，判据 ① 会静默变成恒真');

  assert.ok(NON_ADMIN_PAIRS.length >= MIN_NON_ADMIN_PAIR_COUNT,
    `非 admin 族只抽到 ${NON_ADMIN_PAIRS.length} 处配对（下界 ${MIN_NON_ADMIN_PAIR_COUNT}）`
    + '——说明没真扫全 spec，只看了 admin 族');

  assert.ok(ADMIN_PAIRS.length > 0, 'admin 族一处配对都没抽到 ⇒ 抽取器只认了非 admin 写法');
});

test('④逐 op 下界：谁都不能掉到自己的实测配对条数以下（堵「此处删、彼处补」的对冲）', () => {
  assert.equal(Object.keys(PAIR_BASELINE_BY_OP).length, MIN_OPERATIONS_WITH_PAIRS,
    `基线表登记了 ${Object.keys(PAIR_BASELINE_BY_OP).length} 条 op（应为 ${MIN_OPERATIONS_WITH_PAIRS}）`);

  // 基线表本身不能比现实更宽松：每条登记值都必须 ≥ 1，否则「登记 0」等于自我豁免。
  for (const [operationId, baseline] of Object.entries(PAIR_BASELINE_BY_OP)) {
    assert.ok(Number.isInteger(baseline) && baseline >= 1,
      `${operationId} 的基线是 ${baseline}，必须是 ≥ 1 的整数（0 等于没登记）`);
  }

  const deficits = perOperationDeficits();
  assert.deepEqual(deficits, [],
    `有 ${deficits.length} 条 operation 的配对条数低于基线（补偿式对冲 / 误删描述）：\n`
    + formatViolations(deficits));

  // 聚合口径同时钉住：带配对的 op 数不许变少（18 条没有配对的 op 从 0 涨到 1 是合法的，不改基线）。
  const opsWithPairs = PAIR_COUNT_BY_OP.size;
  assert.ok(opsWithPairs >= MIN_OPERATIONS_WITH_PAIRS,
    `只有 ${opsWithPairs} 条 op 带配对（下界 ${MIN_OPERATIONS_WITH_PAIRS}）`
    + '——抽取面收窄了，或者有 op 的配对整段消失');
});

test('④统计（诊断输出）：配对总数、admin／非 admin、按族分布', (t) => {
  const families = new Map();
  for (const pair of PAIRS) {
    const family = familyOf(pair.operation);
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  const distribution = [...families.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([family, count]) => `${family}=${count}`)
    .join(' ');

  t.diagnostic(`operation ${OPERATIONS.length} 条 · 配对 ${PAIRS.length} 处`
    + `（admin ${ADMIN_PAIRS.length} / 非 admin ${NON_ADMIN_PAIRS.length}）`);
  t.diagnostic(`按族分布：${distribution}`);
  t.diagnostic(`写法分布：状态在前 ${PAIRS.filter((pair) => pair.form === '状态在前').length} 处`
    + ` / 名字在前 ${PAIRS.filter((pair) => pair.form === '名字在前').length} 处`);
  const lies = DENIALS.filter((item) => item.isLie).length;
  t.diagnostic(`否定式声明 ${DENIALS.length} 处（假话 ${lies} / 真话 ${DENIALS.length - lies}）`);

  const opsWithPairs = PAIR_COUNT_BY_OP.size;
  assert.ok(opsWithPairs >= MIN_OPERATIONS_WITH_PAIRS,
    `只有 ${opsWithPairs} 条 operation 带配对 ⇒ 抽取面太窄，覆盖不了 126 条描述`);
});

// ───────────────────────────── 判据 5：抽取器自证 ─────────────────────────────

test('⑤抽取器自证：两种写法都认，行号锚不当配对，配对判定两个方向都有牙齿', () => {
  const statusFirst = extractPairs('形状不符 400 INVALID_REQUEST；越界 413 MEDIA_TOO_LARGE');
  assert.deepEqual(statusFirst.map((pair) => [pair.name, pair.status]),
    [['INVALID_REQUEST', 400], ['MEDIA_TOO_LARGE', 413]],
    '写法 A（状态在前）抽不出来');

  const nameFirst = extractPairs('INVALID_REQUEST（400）、INPUT_UNCERTAIN(422)、NOT_FOUND（428）');
  assert.deepEqual(nameFirst.map((pair) => [pair.name, pair.status]),
    [['INVALID_REQUEST', 400], ['INPUT_UNCERTAIN', 422], ['NOT_FOUND', 428]],
    '写法 B（名字在前 + 括号状态）抽不出来');

  // 行号锚（`（:361）`）与文件行号（合成来源 `routes/ocr-sample.ts:224-257`，⛔ 不用真文件锚）
  // 都不得被当成配对。
  assert.deepEqual(extractPairs('同键异体 409 IDEMPOTENCY_CONFLICT（:361）；routes/ocr-sample.ts:224-257')
    .map((pair) => pair.name), ['IDEMPOTENCY_CONFLICT'],
    '把 `（:NNN）` 行号锚当成了状态码配对');

  // 四个方向：允许的必须放行，不许的必须判红（否则判据 ① 可能整体恒真）
  assert.equal(isAllowedPair('INVALID_REQUEST', 400), true, '`400 INVALID_REQUEST` 应放行');
  assert.equal(isAllowedPair('INVALID_REQUEST', 422), false, '`422 INVALID_REQUEST` 必须判红');
  assert.equal(isAllowedPair('INPUT_UNCERTAIN', 422), true, '`422 INPUT_UNCERTAIN` 应放行');
  assert.equal(isAllowedPair('INPUT_UNCERTAIN', 400), false, '`400 INPUT_UNCERTAIN` 必须判红');
  assert.equal(isAllowedPair('REVISION_CONFLICT', 412), false, '`412 REVISION_CONFLICT` 必须判红（契约里 412 不是本后端的状态）');
  assert.equal(isAllowedPair('NOT_AN_ERROR_CODE', 400), false, '未在册的名字必须判红');
});

test('⑤判据 ①′ 自证：假话判红、真话放行，且证明「不是 400」确实是 ①③ 的盲区', () => {
  // 先证明盲区是真的：`NAME 不是 400` 在判据 ① 眼里根本不是配对（`不是` 不是分隔符）
  assert.deepEqual(extractPairs('NOT_FOUND 不是 404'), [], '否定式被当成了配对形态（那 ①′ 就是多余的）');

  const lie = collectDenials('NOT_FOUND 不是 404');
  assert.deepEqual(lie.lies.map((item) => `${item.name}/${item.status}`), ['NOT_FOUND/404'],
    '「NOT_FOUND 不是 404」是假话（404 正是它的档位），必须进 lies');
  assert.deepEqual(lie.truthful, [], '假话不该同时被算成真话');

  const honest = collectDenials('NOT_FOUND 不是 400；NOT_FOUND 并非 500；NOT_FOUND 不等于 422');
  assert.deepEqual(honest.lies, [], '这些否定句都是真话，不该判红');
  assert.equal(honest.truthful.length, 3, '三个真话否定式都该被识别出来（只用于诊断，不判红）');
});

test('⑤判据 ④ 自证：总数不变也能抓到对冲（getMedia 删一条 + 别处补一条）', () => {
  // 复刻审查实测的那种改法：从 getMedia 删掉一条配对，给一条原本没有配对的 op 补一条。
  // ⚠ 用**登记表**当底稿（不是真实计数）：本自证证明的是机制，不该在变异副本上跟着变红。
  const baseline = new Map(Object.entries(PAIR_BASELINE_BY_OP));
  const baselineTotal = [...baseline.values()].reduce((sum, count) => sum + count, 0);

  const shifted = new Map(baseline);
  shifted.set('getMedia', baseline.get('getMedia') - 1);
  shifted.set('publishSource', 1);

  const total = [...shifted.values()].reduce((sum, count) => sum + count, 0);
  assert.equal(total, baselineTotal, '这条自证的前提就是「总数不变」——变了就不是对冲，是普通删减');

  const deficits = perOperationDeficits(shifted);
  assert.deepEqual(deficits.map((deficit) => deficit.where), ['getMedia'],
    `总数 ${baselineTotal} 不变时，逐 op 下界必须仍然抓到 getMedia 掉了一条`);
  assert.match(deficits[0].detail, /基线登记 3 条，掉了 1 条/, '点红要写清登记值与缺口');

  // 反过来：把登记表原样当成计数喂进去，一条缺口都不该有（否则下界是空转的假红）。
  const unchanged = new Map(baseline);
  assert.deepEqual(perOperationDeficits(unchanged), [], '计数等于登记值时不该有任何缺口');
});

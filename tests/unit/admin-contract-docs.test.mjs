/**
 * GY-R68 A04 回归闸门：`/admin/**` 的 summary／description 改写成果必须**有人守**。
 *
 * 缺口的形状（本片审查实测，HEAD `1f9fe086`）：
 *   把任意 1 条 summary 改回 operationId、或把任意 1 条 description 改回模板句 ⇒
 *   7 条门禁 + 两条 python 校验 + `npm run test:unit` **全绿**。也就是说「49 条 admin 操作
 *   不再用 operationId 冒充摘要」这件事当时只落在文件里，没有任何断言记得它。
 *
 * 本文件只读 `packages/contracts/openapi.json`，零依赖，`node --test` 直接跑。四组断言：
 *
 *   A 覆盖面／反空转：数量与名单是**实测值**，不是「随便扫到几条都算过」——
 *     A1 `/admin/**` operation 数 === 49；A2 `REWRITTEN_ADMIN_OPS` 恰好 28 个且逐个能在 spec
 *     里找到（找不到即红：名单漂移必须先红，而不是静默跳过）；
 *     A3 其余族（非 admin，含 `/me` 族与「其余族」60 条）里 `summary === operationId` 的 operation
 *     数 **必须 === 0**。三族（admin 49 + `/me` 17 + 其余 60 = 126）都写完之后，这条已经从「欠账
 *     上限」换挡成**退化检测**：任何人把某条 summary 改回 operationId、或新增 op 时忘了写 summary，
 *     都判红。（历史沿革：第一片时上限是 77、第二片 60，现在 0——77/60 只是沿革，不再代表欠账；
 *     ⛔ 别把它改回「≤ N」的上限语义，那等于给退化留口子。）
 *
 *   B 退化检测（对 28 个改写过的 op 逐个）：summary 不再等于 operationId、summary 含汉字、
 *     description 不等于（也不包含）模板句。B 的失败清单一次性列全——先红时就是「summary 等于
 *     operationId 那一批」。
 *
 *   C 反同义反复（**期望值从 op 自己的字段派生，不抄任何文本**）：
 *     ① description 必须出现该 op 自己 `x-scope` 里的字面量（多 scope 时任一即可）；
 *     ② description 必须出现至少一个**该 op 自己 `responses` 键**里的三位状态码；
 *     ③ 若该 op 的 `parameters` 声明了 `Idempotency-Key` / `If-Match`（`in: header`，含 `$ref`
 *        解析），description 必须出现该 header 名字面量。
 *     C 另外自带反空转：① 不许有 op 缺 `x-scope` 被静默跳过；③ 分支必须真的命中到 op（否则
 *     ③ 恒真）。这三条保证「描述里那段 scope／状态码／头部名是真的从契约抄出来的」，而不是
 *     恰好抄成另一句模板。
 *
 *   D SUFFIX 白名单**只减不增**：`PENDING_SUFFIX_OPS` 里剩下的是「summary 已改、description 仍是
 *     模板句」的显式欠账（原 8 条，R68 后缀清理销掉 7 条，只剩 `listAdminCategories`——它的实现
 *     另有分支在改）。D 双向判：白名单里每条**当前仍含**模板句（否则判红并提示「从白名单
 *     删除」，欠账还清了就必须销账）；白名单外**任何** admin op 的 description 不得含模板句
 *     （堵住「新写一条又抄回模板句」）。另钉住**白名单长度 === 1**：否则「把某条 description
 *     改回模板句 + 在白名单里加一行」是既退化又合法登记的，D 会全绿（审查实测 8/8 绿）。
 *
 * 读取路径：默认 `packages/contracts/openapi.json`（仓内真文件）。环境变量 `GY_OPENAPI_PATH`
 * 只服务于「先红／变异自证」——把待验副本指过去跑同一个文件，默认值与产品代码行为不变。
 *
 * ── A04 第二片（`/me/**`，GY-R68）────────────────────────────────────────────
 * 同一把闸门现在也守 `/me/**` 那 17 条 operation（含 `/me/profile`、`/me/consents`、`/me/exports`、
 * `/me/account/deletion`、`/media/**`、`/messages/**`，它们都以 `/me` 前缀声明、`x-scope: user`）。
 * 新增的是 A4／A5（覆盖面）、B-me、C①②③-me，判定逻辑与 admin 那几条**共用同一个函数**
 * （`suffixProblems` / `scopeProblems` / `statusCodeProblems` / `headerProblems`），⛔ 不许为某一族
 * 另写一份更松的复制——「两族各自绿」和「两族共用一把尺」在退化时结果完全不同。
 * `/me` 族与 `/admin` 族的区别只在**名单与数量**，不在尺子。
 *
 * ── A04 第三片（其余族 60 条，GY-R68）───────────────────────────────────────
 * 剩下 60 条（`/public/**`、`/auth/**`、`/catalog/**`、`/jobs/**`、`/knowledge/**`、`/herbicides/**`、
 * `/registrations/**`、`/recognitions/**`、`/ocr/**`、`/speech/**`、`/conversations/**`、`/posts/**`、
 * `/comments/**`、`/reports/**`、`/favorites/**`、`/history/**`、`/community/**`、`/account/**`）也由
 * 同一把尺子守：A6／A7（覆盖面与名单）、B-rest、C①②③-rest。`others` 里含 `/me` 族 17 条，所以
 * 「其余族」必须写成 `otherOps.filter((entry) => !isMeFamilyPath(entry.path))`（77 − 17 = 60）。
 * 本片另外把 C② 升级为**集合级双向判定**：描述里的每个三位数字都必须是该 op 自己 `responses` 的
 * 键（只判「至少命中一个」会放过「凭空多写一个码」），并剥掉 `path.ts:305-306` 这类行号引用再判。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 仓内真文件。这是**默认且唯一**的产品口径；下行的覆盖只给自证用。 */
const DEFAULT_SPEC_PATH = resolve(REPO_ROOT, 'packages', 'contracts', 'openapi.json');

/** 自证专用覆盖：只在显式传入时生效（用于「先红」与变异 M1–M4 指向临时副本）。 */
const SPEC_PATH = process.env.GY_OPENAPI_PATH
  ? resolve(process.env.GY_OPENAPI_PATH)
  : DEFAULT_SPEC_PATH;

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

/**
 * 28 条已被改写的 admin 操作 = 原本 21 条（`git diff de2aa3c6..1f9fe086` 里 description 变化的那批）
 * + R68 后缀清理片补入的 7 条（listAdministrators / listAdministratorScopes / grantAdministratorScope /
 * revokeAdministratorScope / disableAdministratorAccount / enableAdministratorAccount / listAuditLogs）。
 * ⛔ 补这 7 行的理由：B/C①/C②/C③ 全部走 `entriesOf(adminById, REWRITTEN_ADMIN_OPS)`，名单外的 op
 * 再怎么写都判不到 —— 实测「listAdministrators 塞未声明 418」在只靠 D 组时 14/14 全绿（假绿）。
 */
const REWRITTEN_ADMIN_OPS = Object.freeze([
  'editSourceDraft',
  'getAdminKnowledge',
  'getAdminRegistration',
  'getAdminRestriction',
  'getAdminSession',
  'getAdminSource',
  'listAdminKnowledge',
  'listAdminRegistration',
  'listAdminRestriction',
  'listAdminSources',
  'listAdminUsers',
  'listAuditEvents',
  'listFlagAuditEvents',
  'listFlags',
  'logoutAdmin',
  'setFlag',
  'suspendUser',
  'withdrawKnowledge',
  'withdrawRegistration',
  'withdrawRestriction',
  'withdrawSource',
  'listAdministrators',
  'listAdministratorScopes',
  'grantAdministratorScope',
  'revokeAdministratorScope',
  'disableAdministratorAccount',
  'enableAdministratorAccount',
  'listAuditLogs',
]);

/** 仍欠账的 admin 操作：summary 已改，description 还是模板句。⛔ 只减不增。 */
const PENDING_SUFFIX_OPS = Object.freeze([
  'listAdminCategories',
]);

/** 改造前的统一占位句（本片要消灭的那一句）。逐字比对，不做归一化。 */
const TEMPLATE_DESCRIPTION = '遵循状态协议：服务端归属/当前版本/授权检查；未满足条件返回明确错误。';

/** `/admin/**` operation 实测数（A1）。 */
const ADMIN_OP_COUNT = 49;

/** `/me/**` operation 实测数（A4）：13 条 path、17 条 operation（含 `/media/**` 5 条与 `/messages/**` 3 条）。 */
const ME_OP_COUNT = 17;

/**
 * 17 条这一片改写过的 `/me/**` operation（A04 第二片实测：summary 与 description 都按代码真值重写）。
 * 顺序按 spec 里出现的顺序，便于与本片交付报告里的表格逐行对照。
 */
const REWRITTEN_ME_OPS = Object.freeze([
  'getProfile',
  'putProfile',
  'getPrivacyPolicy',
  'listConsents',
  'grantConsent',
  'withdrawConsent',
  'listExports',
  'requestAccountDeletion',
  'cancelDeletion',
  'createUpload',
  'completeUpload',
  'getMedia',
  'deleteMedia',
  'grantMediaAccess',
  'listMessages',
  'getUnreadCount',
  'markMessageRead',
]);



/**
 * 其余族（非 admin、非 `/me` 族）operation 实测数（A6）：126 − 49 − 17 = 60。
 * 这是本片改写的那一批，也是 A3 里 `summary === operationId` 必须归零的那一批。
 */
const REST_OP_COUNT = 60;

/**
 * 60 条这一片改写过的其余族 operation（A04 第三片实测：summary 与 description 都按代码真值重写）。
 * 顺序按 spec 里出现的**文件顺序**（JSON 键插入序，同一 path 内 post 先于 get、patch 先于 delete），
 * 便于与本片交付报告里的表格逐行对照。
 */
const REWRITTEN_REST_OPS = Object.freeze([
  'getPublicHome',
  'loginWechat',
  'getUserSession',
  'logoutUser',
  'listCrops',
  'listRegions',
  'listSpecies',
  'getDeletionReceipt',
  'getJob',
  'cancelJob',
  'listKnowledge',
  'getKnowledge',
  'listHerbicides',
  'getHerbicide',
  'verifyRegistration',
  'createRecognition',
  'getRecognition',
  'deleteRecognition',
  'selectSpecies',
  'createOCR',
  'getOCR',
  'deleteOCR',
  'correctOCR',
  'verifyOCR',
  'createTranscription',
  'getTranscription',
  'deleteTranscription',
  'confirmTranscription',
  'createSynthesis',
  'createConversation',
  'listConversations',
  'getConversation',
  'deleteConversation',
  'createTurn',
  'listTurns',
  'deleteTurn',
  'listPosts',
  'createPost',
  'getPost',
  'editPost',
  'deletePost',
  'listComments',
  'createComment',
  'getComment',
  'editComment',
  'deleteComment',
  'getPostLike',
  'likePosts',
  'unlikePosts',
  'likeComments',
  'unlikeComments',
  'createReport',
  'getOwnReport',
  'listFavorites',
  'createFavorite',
  'deleteFavorite',
  'listHistory',
  'deleteHistory',
  'grantCommunityMediaAccess',
  'readCommunityMediaContent',
]);

/**
 * 60 条里声明了 `Idempotency-Key`（`in: header`）的条数实测值（C③-rest 的反空转下界）。
 * 其中 **23** 条另声明 `If-Match`（`If-Match` 是它的子集，所以命中面 = 34 条）——这个 23 是
 * 复查时用 `$ref` 解引用后重算的（旧注释写的 26 是手数误差，断言用的是 34，未受影响）：
 * cancelJob / deleteRecognition / selectSpecies / deleteOCR / correctOCR / verifyOCR /
 * deleteTranscription / confirmTranscription / deleteConversation / createTurn / deleteTurn /
 * deletePost / editPost / createComment / deleteComment / editComment / likePosts / unlikePosts /
 * likeComments / unlikeComments / deleteFavorite / deleteHistory / grantCommunityMediaAccess。
 */
const REST_IDEMPOTENCY_OP_COUNT = 34;

/** 方法白名单：openapi 里只可能出现这几种 operation 键。 */
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** `p` 是否属于后台族（`/admin` 与 `/admin/...`）。 */
function isAdminPath(p) {
  return p === '/admin' || p.startsWith('/admin/');
}

/**
 * `/me` 族的三段前缀：这一片改写的 17 条 operation 都落在这三段里（13 条 path）。
 * ⛔ 为什么不是单个 `/me/` 前缀：`/media/...`、`/messages/...` 是本片口径里同族的本人资源面
 * （`x-scope: user`），但它们不以 `/me/` 开头；反过来单看 `/me` 前缀又会把 `/media` 当成
 * `/me` + `dia`。三段显式列出，族边界靠常量表达，不靠前缀的巧合。
 */
const ME_PATH_PREFIXES = Object.freeze(['/me', '/media', '/messages']);

/** `p` 是否属于本片口径的「`/me` 族」（`/me`、`/media`、`/messages` 三段之一）。 */
function isMeFamilyPath(p) {
  return ME_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** 扫全 spec，返回 `{ admin, me, others }` 三组 `{ path, method, op }`；`others` 仍是「非 admin」。 */
function collectOperations(document) {
  const admin = [];
  const me = [];
  const others = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op || typeof op !== 'object' || !op.operationId) continue;
      const entry = { path, method, op };
      if (isAdminPath(path)) admin.push(entry);
      // `others` 的口径与 #713 那一片完全一致（非 admin）；A3 已是「必须 === 0」，口径不变才拿得到同一批 operation。
      else others.push(entry);
      if (isMeFamilyPath(path)) me.push(entry);
    }
  }
  return { admin, me, others };
}

const { admin: adminOps, me: meOps, others: otherOps } = collectOperations(spec);
const adminById = new Map(adminOps.map((entry) => [entry.op.operationId, entry]));
const meById = new Map(meOps.map((entry) => [entry.op.operationId, entry]));
/**
 * 其余族 = `others`（非 admin）**再剔掉 `/me` 族**。
 * ⛔ 不能直接用 `otherOps`：`collectOperations()` 里 `/me` 族的 17 条同时落在 `others` 里
 * （admin/me 是并列收集，`else` 才进 others），直接用会让「其余族 = 60」变成 77 而虚红线。
 */
const restOps = otherOps.filter((entry) => !isMeFamilyPath(entry.path));
const restById = new Map(restOps.map((entry) => [entry.op.operationId, entry]));


/** 含汉字即算中文摘要（用 Unicode script 属性，⛔ 不用手写码点区间）。 */
const HAN = /\p{Script=Han}/u;

/** 解析 `$ref`（只覆盖本 spec 用到的 `#/components/parameters/*` 与就地参数）。 */
function derefParameter(parameter) {
  if (!parameter || typeof parameter !== 'object' || !parameter.$ref) return parameter;
  const name = parameter.$ref.split('/').pop();
  return spec.components?.parameters?.[name] ?? null;
}

/** 某 op 的 `x-scope` 字面量列表（字符串拆 `/`，数组摊平；缺声明返回 `[]`）。 */
function scopesOf(op) {
  const raw = op['x-scope'];
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : String(raw).split('/');
  return values.map((value) => String(value).trim()).filter(Boolean);
}

/** 某 op 声明在 `parameters` 里的 header 名（含 `$ref` 解析；解析不到记 `null`）。 */
function headerNamesOf(op) {
  const parameters = Array.isArray(op.parameters) ? op.parameters : [];
  return parameters
    .map(derefParameter)
    .filter(Boolean)
    .filter((parameter) => parameter.in === 'header')
    .map((parameter) => parameter.name);
}

/** 从 `byId` 里按名单取条目；找不到的由 A2／A5 单独判红，这里静默跳过以免同一问题报两遍。 */
function entriesOf(byId, ids) {
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * B 组的公共实现（admin 与 me 两族共用同一份判定）。
 * 四问：summary 是否退回 operationId、summary 有没有汉字、description 是否退回模板句、
 * description 是否把模板句整句留在里面。
 * @param {{path: string, method: string, op: object}[]} entries
 * @returns {string[]} 问题清单（空数组＝通过）
 */
function suffixProblems(entries) {
  const problems = [];
  for (const { path, method, op } of entries) {
    if (op.summary === op.operationId) {
      problems.push(`summary 等于 operationId（${method.toUpperCase()} ${path}）：${JSON.stringify(op.summary)}`);
    }
    if (!HAN.test(String(op.summary ?? ''))) {
      problems.push(`summary 不含汉字（${method.toUpperCase()} ${path}）：${JSON.stringify(op.summary)}`);
    }
    if (String(op.description ?? '').trim() === TEMPLATE_DESCRIPTION) {
      problems.push(`description 退化成模板句（${method.toUpperCase()} ${path}）：${op.operationId}`);
    }
    if (String(op.description ?? '').includes(TEMPLATE_DESCRIPTION)) {
      problems.push(`description 仍把模板句整句留在里面（${method.toUpperCase()} ${path}）：${op.operationId}`);
    }
  }
  return problems;
}

/**
 * C① 的公共实现：description 必须出现该 op 自己 `x-scope` 里的字面量（多 scope 任一即可）。
 * 缺 `x-scope` 的 op 记问题而不是跳过——跳过等于「没有期望值也算过」。
 * @returns {{problems: string[], asserted: number}}
 */
function scopeProblems(entries) {
  const problems = [];
  let asserted = 0;
  for (const { path, method, op } of entries) {
    const scopes = scopesOf(op);
    if (scopes.length === 0) {
      problems.push(`op 没有 \`x-scope\`，本条无法派生期望值（${method.toUpperCase()} ${path}）：${op.operationId}`);
      continue;
    }
    const description = String(op.description ?? '');
    const hit = scopes.filter((scope) => description.includes(scope));
    if (hit.length === 0) {
      problems.push(
        `description 里一个 scope 字面量都没有（${method.toUpperCase()} ${path}）：${op.operationId}`
        + ` 声明 ${JSON.stringify(op['x-scope'])}`,
      );
      continue;
    }
    asserted += 1;
  }
  return { problems, asserted };
}

/** 「像状态码的三位数字」：前后不能紧邻字母或数字，否则 `sha256`、`10485760`、`57014` 会被误抽。 */
const THREE_DIGIT_CODE = /(?<![0-9A-Za-z])[0-9]{3}(?![0-9A-Za-z])/g;

/**
 * 抽取前先抹掉的两类**明确不是状态码**的数字。除这两类外不给任何豁免表——
 * 豁免一多，下面的反向判定（每个三位数字都必须是本 op 声明的码）就退化成恒真。
 *
 * ① 源码引用行号：`routes/ocr.ts:305-306`、`（:770-817）`、`（:139、393-404）`。
 *    证据行号天然是 1..4 位数字，且总是以 `:` 引出、或以 `、`/`,` 续接一个区间；
 *    状态码在正文里永远写成「409 REVISION_CONFLICT」这种「数字 + 空格 + 大写错误码」的形态，
 *    不会紧跟 `:`，所以这两类在文本上可区分（`_rest` 那批 60 条描述里共有 100+ 处行号引用）。
 *
 * ② 形状/容量区间：`8..128 字符`（Idempotency-Key 长度）、`1..120`（标题）、`1..512`（令牌头）。
 *    端点写成 `A..B` 的形态，与状态码无歧义。
 */
const REFERENCE_SPAN = /[A-Za-z0-9_\-./]+\.(?:ts|mts|cts|mjs|cjs|js|json|py|sql|ps1|sh)[:：][0-9]{1,4}(?:(?:\s?[-–—]\s?|\s?[:：]\s?|\s?、\s?|\s?,\s?)[0-9]{1,4})*/g;
const REFERENCE_CONT_AFTER_COLON = /(?<=[:：])[0-9]{1,4}(?:\s?[-–—]\s?[0-9]{1,4})?(?:(?:\s?[:：、,，]\s?)[0-9]{1,4}(?:\s?[-–—]\s?[0-9]{1,4})?)*/g;
const REFERENCE_CONT_WITH_RANGE = /(?<=[、,，])[0-9]{1,4}\s?[-–—]\s?[0-9]{1,4}(?:(?:\s?[:：、,，]\s?)[0-9]{1,4}(?:\s?[-–—]\s?[0-9]{1,4})?)*/g;
const CONSTRAINT_RANGE = /[0-9]+\.\.[0-9]+/g;

/** 去掉行号引用与形状区间后剩下的正文（只用于抽三位数字）。 */
function withoutNonCodeSpans(description) {
  return String(description)
    .replace(REFERENCE_SPAN, ' ')
    .replace(REFERENCE_CONT_AFTER_COLON, ' ')
    .replace(REFERENCE_CONT_WITH_RANGE, ' ')
    .replace(CONSTRAINT_RANGE, ' ');
}

/**
 * C② 的公共实现，**集合级双向判定**（不再是「至少命中一个」的存在性判定）：
 * 1. 正向：description 至少出现一个**该 op 自己** `responses` 的键；
 * 2. 反向：description 里出现的**每一个**三位数字，都必须是该 op 自己 `responses` 的键——
 *    多写一个不属于本 op 的码（例如把 `504` 写成 `418`、或凭空追加一个 `418`）也判红。
 *
 * 反向这一半是 A04-rest 审查（`adv-verdict-a04rest-435ea904.md` B2）指出的盲区：只有正向时，
 * 「在已经写对 `200` 的句子里再追加一个未声明的码」仍然全绿；#718 已给 `/me` 族补了这一半，
 * 这里把它推广到 admin／/me／其余族三族共用（三族描述经同一函数判定，不设第二把尺子）。
 *
 * 已知边界（写进 PR 正文「已知限制」）：本判定只能证明「描述里的码 ⊆ `responses` 的键」，
 * 不能证明「`responses` 里的码在当前配置下真的可达」——`403 SCOPE_DENIED` 这种「声明了但走不到」
 * 的错只能靠语义审查抓（见报告 B1 那 12 条）。
 * @returns {{problems: string[], asserted: number}}
 */
function statusCodeProblems(entries) {
  const problems = [];
  let asserted = 0;
  for (const { path, method, op } of entries) {
    const declared = Object.keys(op.responses ?? {}).filter((code) => /^[0-9]{3}$/.test(code));
    if (declared.length === 0) {
      problems.push(`op 没有三位状态码声明，本条无法派生期望值（${method.toUpperCase()} ${path}）：${op.operationId}`);
      continue;
    }
    const description = String(op.description ?? '');
    const declaredSet = new Set(declared);
    const hit = declared.filter((code) => description.includes(code));
    if (hit.length === 0) {
      problems.push(
        `description 里没有任何一个本 op 声明的状态码（${method.toUpperCase()} ${path}）：${op.operationId}`
        + ` 声明 ${declared.join(',')}`,
      );
      continue;
    }
    const found = [...new Set(withoutNonCodeSpans(description).match(THREE_DIGIT_CODE) ?? [])];
    const stray = found.filter((code) => !declaredSet.has(code));
    if (stray.length > 0) {
      problems.push(
        `description 里出现了本 op 没声明的三位数字（疑似把状态码写错或凭空追加）（${method.toUpperCase()} ${path}）：`
        + `${op.operationId} 写了 ${stray.join(',')}，本 op 只声明 ${declared.join(',')}`,
      );
      continue;
    }
    asserted += 1;
  }
  return { problems, asserted };
}

/** C③ 关注的头部：声明了就必须在 description 里写出来。 */
const WATCHED_HEADERS = Object.freeze(['Idempotency-Key', 'If-Match']);

/**
 * C③ 的公共实现：声明了 `Idempotency-Key`／`If-Match` 的 op，description 必须写出该 header 名。
 * @returns {{problems: string[], asserted: number}}
 */
function headerProblems(entries) {
  const problems = [];
  let asserted = 0;
  for (const { path, method, op } of entries) {
    const headers = headerNamesOf(op).filter((name) => WATCHED_HEADERS.includes(name));
    if (headers.length === 0) continue;
    asserted += 1;
    const description = String(op.description ?? '');
    const missing = headers.filter((name) => !description.includes(name));
    if (missing.length > 0) {
      problems.push(
        `description 没写出已声明的 header（${method.toUpperCase()} ${path}）：${op.operationId}`
        + ` 缺 ${missing.join(',')}`,
      );
    }
  }
  return { problems, asserted };
}

test('A1 `/admin/**` operation 数 === 49（扫描面反空转）', () => {
  assert.notEqual(SPEC_PATH, '', '读取路径为空');
  assert.ok(
    Object.keys(spec.paths ?? {}).length > 0,
    `扫描面为空：\`${SPEC_PATH}\` 里一条 path 都没有——这种「扫到什么算什么」的绿灯等于没守`
    + '（检查 `GY_OPENAPI_PATH` 是否指错了文件）',
  );
  assert.equal(
    adminOps.length,
    ADMIN_OP_COUNT,
    `\`/admin/**\` operation 数变了：实测 ${adminOps.length}，本闸门记的是 ${ADMIN_OP_COUNT}。\n`
    + `当前 admin operationId：${adminOps.map((entry) => entry.op.operationId).sort().join(', ')}\n`
    + '新增/删除后台操作必须同步改这条常量与 A2 名单（否则「覆盖面」这条会悄悄缩水）。',
  );
});

test('A2 REWRITTEN_ADMIN_OPS 恰好 28 个，且逐个在 spec 里找得到', () => {
  assert.equal(
    REWRITTEN_ADMIN_OPS.length,
    28,
    `改写名单长度应为 28，实测 ${REWRITTEN_ADMIN_OPS.length}`,
  );
  assert.equal(
    new Set(REWRITTEN_ADMIN_OPS).size,
    REWRITTEN_ADMIN_OPS.length,
    '改写名单里有重复 operationId',
  );
  const missing = REWRITTEN_ADMIN_OPS.filter((id) => !adminById.has(id));
  assert.deepEqual(
    missing,
    [],
    `以下 operationId 在 \`/admin/**\` 里找不到（改名/删除/拼错）：${missing.join(', ')}\n`
    + '⛔ 名单找不到就跳过＝这条 op 从此没人守，所以这里必须先红。',
  );
  const overlap = REWRITTEN_ADMIN_OPS.filter((id) => PENDING_SUFFIX_OPS.includes(id));
  assert.deepEqual(
    overlap,
    [],
    `以下 operationId 同时出现在「已改写」与「仍欠账」两份名单里（互斥被破坏）：${overlap.join(', ')}`,
  );
});

test('A3 非 admin 族里 `summary === operationId` 的 operation 数必须 === 0（退化检测，不再是欠账上限）', () => {
  // A04 第三片换挡：三族（admin 49 + /me 17 + 其余 60 = 126）都写完了，
  // 「summary 等于 operationId」从此是**退化**，不再是「还没轮到的欠账」。
  // ⛔ 别再把它写成 `<= N`：上限语义在 0 上等于没有断言（0 <= 0 恒真，涨到 1 也不红）。
  const suffix = otherOps.filter((entry) => entry.op.summary === entry.op.operationId);
  assert.equal(
    suffix.length,
    0,
    `非 admin 族里 \`summary === operationId\` 的 operation 实测 ${suffix.length} 条，应为 0。\n`
    + `命中：${suffix.map((entry) => `${entry.method.toUpperCase()} ${entry.path} → ${entry.op.operationId}`).join(' / ')}\n`
    + '⛔ 这不是「欠账还没轮到」：三族都写完了，任何一条退回 operationId 都是退化。\n'
    + '新增 operation 时必须同时写 summary（含汉字、说清做什么与边界），否则这条会红——这是本意。',
  );
});

test('A4 `/me/**` operation 数 === 17（扫描面反空转）', () => {
  assert.equal(
    meOps.length,
    ME_OP_COUNT,
    `\`/me/**\` operation 数变了：实测 ${meOps.length}，本闸门记的是 ${ME_OP_COUNT}。\n`
    + `当前 /me 族 operationId：${meOps.map((entry) => entry.op.operationId).sort().join(', ')}\n`
    + `判定前缀：${ME_PATH_PREFIXES.join(' / ')}\n`
    + '新增/删除本人侧操作必须同步改这条常量与 A5 名单（否则「覆盖面」会悄悄缩水）。',
  );
});

test('A5 REWRITTEN_ME_OPS 恰好 17 条，且与 `/me/**` 全部 operation 一一对应', () => {
  assert.equal(
    REWRITTEN_ME_OPS.length,
    ME_OP_COUNT,
    `改写名单长度应为 ${ME_OP_COUNT}，实测 ${REWRITTEN_ME_OPS.length}`,
  );
  assert.equal(
    new Set(REWRITTEN_ME_OPS).size,
    REWRITTEN_ME_OPS.length,
    '改写名单里有重复 operationId',
  );
  const missing = REWRITTEN_ME_OPS.filter((id) => !meById.has(id));
  assert.deepEqual(
    missing,
    [],
    `以下 operationId 在 \`/me/**\` 里找不到（改名/删除/写错前缀）：${missing.join(', ')}\n`
    + '⛔ 名单找不到就跳过＝这条 op 从此没人守，所以这里必须先红。\n'
    + `当前 /me 族实际 operationId：${meOps.map((entry) => entry.op.operationId).sort().join(', ')}`,
  );
  // 反向：`/me/**` 里任何一条不在名单上的 op 都是「没人守的新面孔」，同样要红。
  const untracked = meOps
    .map((entry) => entry.op.operationId)
    .filter((id) => !REWRITTEN_ME_OPS.includes(id));
  assert.deepEqual(
    untracked,
    [],
    `以下 /me 族 operation 不在 REWRITTEN_ME_OPS 里（新增了 op 却没登记，等于没人守）：${untracked.join(', ')}`,
  );
});

test('B 28 条改写过的 admin op：summary 不再是 operationId、含汉字、description 不再是模板句', () => {
  const problems = suffixProblems(entriesOf(adminById, REWRITTEN_ADMIN_OPS));
  assert.deepEqual(
    problems,
    [],
    `以下 ${problems.length} 处退化（summary 那几条就是把 summary 改回 operationId 的样子）：\n  - `
    + `${problems.join('\n  - ')}\n`
    + '这一片的价值全在「摘要/描述说人话、说可核对的事实」；退回去必须红，而不是靠人肉记性。',
  );
});

test('B-me 17 条改写过的 /me/** op：summary 不再是 operationId、含汉字、description 不再是模板句', () => {
  const problems = suffixProblems(entriesOf(meById, REWRITTEN_ME_OPS));
  assert.deepEqual(
    problems,
    [],
    `以下 ${problems.length} 处退化（/me/** 这一片：summary 改回 operationId、或 description 抄回模板句）：\n  - `
    + `${problems.join('\n  - ')}\n`
    + `判定的模板句原文：${TEMPLATE_DESCRIPTION}\n`
    + '/me/** 这 17 条的价值与 /admin/** 那 49 条是同一条标准：summary 写「做什么 + 作用域/边界」，'
    + 'description 写门（scope／登录／Idempotency-Key／If-Match）、成功形状与分页语义、错误码与条件、'
    + '受哪个开关或执行模式影响（没有就明说「无开关」）。退回模板句或 operationId 必须红。',
  );
});

test('C① description 必须含该 op 自己 x-scope 里的字面量（期望值从 op 派生）', () => {
  const { problems, asserted } = scopeProblems(entriesOf(adminById, REWRITTEN_ADMIN_OPS));
  assert.ok(asserted > 0, 'C① 一条 op 都没断言到 ⇒ 恒真');
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 scope 与描述对不上：\n  - ${problems.join('\n  - ')}`);
});

test('C①-me /me/** 17 条的 description 同样必须含自身 x-scope 字面量', () => {
  const { problems, asserted } = scopeProblems(entriesOf(meById, REWRITTEN_ME_OPS));
  assert.equal(
    asserted,
    ME_OP_COUNT,
    `C①-me 只断言到 ${asserted} 条（应为 ${ME_OP_COUNT}）⇒ 有 op 缺 x-scope 或描述里没写出 scope 字面量`,
  );
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 scope 与描述对不上：\n  - ${problems.join('\n  - ')}`);
});

test('C② description 里的状态码集合必须 ⊆ 该 op 自己 responses 的键，且至少出现一个（集合级双向判定）', () => {
  const { problems, asserted } = statusCodeProblems(entriesOf(adminById, REWRITTEN_ADMIN_OPS));
  // 先报具体问题，再报「一条都没断言到」——否则「写错码」会被断言计数掩盖成空转。
  assert.deepEqual(
    problems,
    [],
    `以下 ${problems.length} 处状态码与描述对不上（既有「一个都没写」，也有「写了本 op 没声明的码」）：\n  - ${problems.join('\n  - ')}`,
  );
  assert.ok(asserted > 0, 'C② 一条 op 都没断言到 ⇒ 恒真');
});

test('C②-me /me/** 17 条的 description 同样必须把状态码集合限制在自身 responses 的键内，且至少出现一个', () => {
  const { problems, asserted } = statusCodeProblems(entriesOf(meById, REWRITTEN_ME_OPS));
  assert.deepEqual(
    problems,
    [],
    `以下 ${problems.length} 处状态码与描述对不上（写了本 op 没声明的三位数字也算）：\n  - ${problems.join('\n  - ')}`,
  );
  assert.equal(
    asserted,
    ME_OP_COUNT,
    `C②-me 只断言到 ${asserted} 条（应为 ${ME_OP_COUNT}）⇒ 有 op 描述里写的码不是它自己 responses 里的`,
  );
});

test('C③ 声明了 Idempotency-Key／If-Match 的 op，description 必须写出该 header 名', () => {
  const { problems, asserted } = headerProblems(entriesOf(adminById, REWRITTEN_ADMIN_OPS));
  // 反空转：这 28 条里确实有一批声明了幂等/版本头，否则本组断言等于没跑。
  assert.ok(
    asserted > 0,
    'C③ 分支在 28 条改写过的 op 里一次都没命中（没有任何 op 声明 Idempotency-Key／If-Match）'
    + ' ⇒ 这条断言恒真。要么参数改成了别的形制，要么 `$ref` 解析坏了。',
  );
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 header 与描述对不上：\n  - ${problems.join('\n  - ')}`);
});

test('C③-me /me/** 17 条：声明了的 Idempotency-Key／If-Match 必须写进 description', () => {
  const { problems, asserted } = headerProblems(entriesOf(meById, REWRITTEN_ME_OPS));
  // 反空转：/me 族里 10 条声明了 Idempotency-Key（其中 6 条另声明 If-Match），命中面必须够大，
  // 否则「参数改形制」时这条会静默变成恒真。
  assert.ok(
    asserted >= 10,
    `C③-me 只命中 ${asserted} 条（/me 族里应有 10 条声明 Idempotency-Key、其中 6 条另声明 If-Match）`
    + ' ⇒ 要么参数改成了别的形制，要么 `$ref` 解析坏了。',
  );
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 header 与描述对不上：\n  - ${problems.join('\n  - ')}`);
});

test('D SUFFIX 白名单只减不增（双向）', () => {
  assert.equal(new Set(PENDING_SUFFIX_OPS).size, PENDING_SUFFIX_OPS.length, '欠账名单里有重复 id');
  // 钉子：白名单长度本身也不许涨。没有这条时，「把某 op 的 description 改回模板句 + 在
  // PENDING_SUFFIX_OPS 里加一行」这种「既退化了又合法登记」能让 D 全绿（审查实测 8/8 绿）。
  assert.equal(
    PENDING_SUFFIX_OPS.length,
    1,
    `SUFFIX 白名单长度应为 1，实测 ${PENDING_SUFFIX_OPS.length}：白名单只许减不许增；`
    + '清理某条后就把它删掉，并把这里的期望值同步下调。',
  );
  const problems = [];
  for (const id of PENDING_SUFFIX_OPS) {
    const entry = adminById.get(id);
    if (!entry) {
      problems.push(`欠账名单里的 ${id} 已不是 admin operation（改名/删除）⇒ 从 PENDING_SUFFIX_OPS 删除`);
      continue;
    }
    const description = String(entry.op.description ?? '');
    if (!description.includes(TEMPLATE_DESCRIPTION)) {
      problems.push(
        `\`${id}\` 的 description 已不再含模板句 ⇒ 欠账已还清，请把 ${id} 从 PENDING_SUFFIX_OPS 删除`
        + '（白名单只减不增：留着它会让后来人以为这里还有欠账）',
      );
    }
  }
  // 反向：白名单外任何 admin op 都不得含模板句（堵住「新抄回一句模板」）。
  const leaked = adminOps
    .filter((entry) => String(entry.op.description ?? '').includes(TEMPLATE_DESCRIPTION))
    .map((entry) => entry.op.operationId)
    .filter((id) => !PENDING_SUFFIX_OPS.includes(id));
  for (const id of leaked) {
    problems.push(
      `\`${id}\` 的 description 含模板句，但不在 PENDING_SUFFIX_OPS 里 ⇒ `
      + '要么把它改写成可核对的事实，要么显式登记欠账（⛔ 不许静默新增）',
    );
  }
  assert.deepEqual(
    problems,
    [],
    `SUFFIX 白名单与事实不符（${problems.length} 处）：\n  - ${problems.join('\n  - ')}`,
  );
});

test('A6 其余族（非 admin、非 /me）operation 数 === 60（扫描面反空转）', () => {
  assert.equal(
    restOps.length,
    REST_OP_COUNT,
    `其余族 operation 数变了：实测 ${restOps.length}，本闸门记的是 ${REST_OP_COUNT}。\n`
    + `当前其余族 operationId：${restOps.map((entry) => entry.op.operationId).sort().join(', ')}\n`
    + '⛔ 口径是 `others`（非 admin）**再剔掉 `/me` 族**：`collectOperations()` 里 /me 的 17 条同时落在 '
    + '`others` 里，直接用 `otherOps.length` 会得到 77 而不是 60。\n'
    + '新增/删除其余族操作必须同步改这条常量与 A7 名单（否则「覆盖面」会悄悄缩水）。',
  );
});

test('A7 REWRITTEN_REST_OPS 恰好 60 条，且与其余族全部 operation 一一对应', () => {
  assert.equal(
    REWRITTEN_REST_OPS.length,
    REST_OP_COUNT,
    `改写名单长度应为 ${REST_OP_COUNT}，实测 ${REWRITTEN_REST_OPS.length}`,
  );
  assert.equal(
    new Set(REWRITTEN_REST_OPS).size,
    REWRITTEN_REST_OPS.length,
    '改写名单里有重复 operationId',
  );
  const missing = REWRITTEN_REST_OPS.filter((id) => !restById.has(id));
  assert.deepEqual(
    missing,
    [],
    `以下 operationId 在其余族里找不到（改名/删除/被算进别的族）：${missing.join(', ')}\n`
    + '⛔ 名单找不到就跳过＝这条 op 从此没人守，所以这里必须先红。\n'
    + `当前其余族实际 operationId：${restOps.map((entry) => entry.op.operationId).sort().join(', ')}`,
  );
  // 反向：其余族里任何一条不在名单上的 op 都是「没人守的新面孔」，同样要红。
  const untracked = restOps
    .map((entry) => entry.op.operationId)
    .filter((id) => !REWRITTEN_REST_OPS.includes(id));
  assert.deepEqual(
    untracked,
    [],
    `以下其余族 operation 不在 REWRITTEN_REST_OPS 里（新增了 op 却没登记，等于没人守）：${untracked.join(', ')}`,
  );
});


test('B-rest 60 条改写过的其余族 op：summary 不再是 operationId、含汉字、description 不再是模板句', () => {
  const problems = suffixProblems(entriesOf(restById, REWRITTEN_REST_OPS));
  assert.deepEqual(
    problems,
    [],
    `以下 ${problems.length} 处退化（其余族这一片：summary 改回 operationId、或 description 抄回模板句）：\n  - `
    + `${problems.join('\n  - ')}\n`
    + `判定的模板句原文：${TEMPLATE_DESCRIPTION}\n`
    + '这 60 条与 /admin、/me 两族是同一条标准：summary 写「做什么 + 作用域/边界」，description 写门'
    + '（scope／登录／Idempotency-Key／If-Match）、成功形状与分页语义、错误码与条件、受哪个开关或执行模式影响。'
    + '⛔ 尤其不许把「202 已受理」写成「已完成」，也不许把「未接线 ⇒ 503」省掉。',
  );
});


test('C①-rest 其余族 60 条的 description 同样必须含自身 x-scope 字面量', () => {
  const { problems, asserted } = scopeProblems(entriesOf(restById, REWRITTEN_REST_OPS));
  assert.equal(
    asserted,
    REST_OP_COUNT,
    `C①-rest 只断言到 ${asserted} 条（应为 ${REST_OP_COUNT}）⇒ 有 op 缺 x-scope 或描述里没写出 scope 字面量`,
  );
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 scope 与描述对不上：\n  - ${problems.join('\n  - ')}`);
});


test('C②-rest 其余族 60 条：同样要含自身 responses 里的码，且不得出现未声明的三位数字', () => {
  const { problems, asserted } = statusCodeProblems(entriesOf(restById, REWRITTEN_REST_OPS));
  // 同上：先点名哪条 op 写错码，再守「60 条全被断言到」这条反空转线。
  assert.deepEqual(problems, [], `以下 ${problems.length} 处状态码与描述对不上：\n  - ${problems.join('\n  - ')}`);
  assert.equal(
    asserted,
    REST_OP_COUNT,
    `C②-rest 只断言到 ${asserted} 条（应为 ${REST_OP_COUNT}）⇒ 有 op 描述里写的码不是它自己 responses 里的`,
  );
  assert.deepEqual(problems, [], `以下 ${problems.length} 处状态码与描述对不上：\n  - ${problems.join('\n  - ')}`);
});


test('C③-rest 其余族 60 条：声明了的 Idempotency-Key／If-Match 必须写进 description', () => {
  const { problems, asserted } = headerProblems(entriesOf(restById, REWRITTEN_REST_OPS));
  // 反空转：其余族里 34 条声明了 Idempotency-Key（其中 23 条另声明 If-Match），命中面必须够大，
  // 否则「参数改形制」时这条会静默变成恒真。
  assert.equal(
    asserted,
    REST_IDEMPOTENCY_OP_COUNT,
    `C③-rest 命中 ${asserted} 条（应为 ${REST_IDEMPOTENCY_OP_COUNT}：这 60 条里还有 34 条声明 Idempotency-Key、`
    + '其中 23 条另声明 If-Match）⇒ 要么参数改成了别的形制，要么 `$ref` 解析坏了，要么入选名单换了。',
  );
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 header 与描述对不上：\n  - ${problems.join('\n  - ')}`);
});

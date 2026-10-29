/**
 * GY-R68 A04 回归闸门：`/admin/**` 的 summary／description 改写成果必须**有人守**。
 *
 * 缺口的形状（本片审查实测，HEAD `1f9fe086`）：
 *   把任意 1 条 summary 改回 operationId、或把任意 1 条 description 改回模板句 ⇒
 *   7 条门禁 + 两条 python 校验 + `npm run test:unit` **全绿**。也就是说「49 条 admin 操作
 *   不再用 operationId 冒充摘要」这件事当时只落在文件里，没有任何断言记得它。
 *
 * 本文件只读 `packages/contracts/openapi.json`，零依赖，`node --test` 直接跑。五组断言：
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
 *   B 退化检测（遍历面＝`CHECKED_ADMIN_OPS`，即**全部 49 条** admin op）：summary 不再等于
 *     operationId、summary 含汉字、description 不等于（也不包含）模板句。B 的失败清单一次性列全
 *     ——先红时就是「summary 等于 operationId 那一批」。
 *
 *   ⚠️ 遍历面（R69 扩面，本片的目的）：B／C①／C②／C③ 曾只遍历 `REWRITTEN_ADMIN_OPS`（21 条），
 *     后果是**名单外的 28 条 admin op 根本不被检查**——往 `listAdminCategories` 的 description 里
 *     塞一个未声明的 `418`，当时四组全绿。判定器本身没坏（往名单内的 `listAdminUsers` 塞 `418`
 *     会红），坏的是遍历面：admin 族 49 条，名单内 21 条 ⇒ 28 条没人管。现在四条一律遍历
 *     `CHECKED_ADMIN_OPS`（= 全部 49 条 admin operation）；`REWRITTEN_ADMIN_OPS` 退回它原本的
 *     语义（A 组「这一片改写过哪些」的覆盖面判定），⛔ 不再作为 B／C 的遍历面。
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
 *     模板句」的显式欠账（原 8 条 → R68 后缀清理销掉 7 条 → R69 把最后一条 `listAdminCategories`
 *     也补齐，**现已为空**）。D 双向判：白名单里每条**当前仍含**模板句（否则判红并提示「从白名单
 *     删除」，欠账还清了就必须销账）；白名单外**任何** admin op 的 description 不得含模板句
 *     （堵住「新写一条又抄回模板句」）。另钉住**白名单长度 === 0**：否则「把某条 description
 *     改回模板句 + 在白名单里加一行」是既退化又合法登记的，D 会全绿（审查实测 8/8 绿）。
 *
 *   E 反同义反复的**逆向一半**（`FORBIDDEN_SNIPPETS`）：A–D 全都只看「形状」——summary 不等于
 *     operationId、含自己 `x-scope` 的字面量、含自己 `responses` 里的三位码、不是模板句。把一条
 *     **已经按代码改准**的描述改回以前那句错话，A–D 仍然可以全绿：#719 修掉的 5 条（`approvePost`／
 *     `editKnowledgeDraft`／`listFlags`／`editRegistrationDraft`／`editRestrictionDraft`）与 #718
 *     修掉的 `completeUpload`／`requestAccountDeletion` 都踩过这个洞——改完没有任何断言记得住
 *     「哪句话是错的」。E 按 operation 登记**已被证伪的片段**（每条都带证伪者与真值 `文件:行`），
 *     `summary + '\n' + description` 包含即 `assert.fail`，报错点名 operationId、命中的片段与出处。
 *     E 自带三条反空转：E1 表不得为空且条目数 ≥ 下限（**下限只许涨**，删条目须在提交信息里说明）；
 *     E2 每个键必须是**真实存在**的 operationId（拼错/改名必须红，不许静默跳过）；E3 每个值是非空
 *     数组、片段 ≥ 4 字。
 *
 *     **两种登记形态**：字面量 `'错话'`（`String#includes`）与 `{ re, sample }`（`RegExp#test`）。
 *     为什么要有正则：同一个错主张会以不同写法回来（「不改可见性。」「…，不改可见性，不推进 visibility」），
 *     而裸字面量 `不改可见性` 又会红掉**真话**「已 hidden/deleted 的单向门：不改可见性」——那句成真的
 *     条件正是紧挨着的「单向门：」。所以用 **negative lookbehind 把「成真的限定词」写成豁免**，而不是
 *     把片段缩窄到只剩旧句尾巴：`/(?<!单向门\s*[：:]\s*)不改可见性/`（全角 `：`／半角 `:`／冒号前后
 *     空格都算豁免）。`sample` 是**注入用样本**（E6 把它拼进正文验管道），必须被该正则命中。
 *     ⛔ 正则**不许带 `g`／`y` 标志**：`RegExp#test` 的 `lastIndex` 会造成同一文本间歇漏判。
 *
 *     ⛔⛔ **这条豁免的真实能力上限（审查实测，别把它当语义检查）**：lookbehind **只按紧邻的几个字
 *     判豁免，不核整句其余部分**。所以「单向门：」一贴上去，后面接什么都会被放过——实测
 *     `适用范围：单向门：不改可见性。` 与 `…单向门：不改可见性——private 帖也一样。` 都是**全绿**，
 *     尽管后一句整体为假；`…只有 未接端口时读进程内种子 是旧口径，real 模式接端口时也回落进程内种子。`
 *     同样全绿。⇒ 它比「引号豁免」窄，但**仍是「贴词即可通过」**——与已知边界①同级，只能靠评审。
 *
 *     ⚠ E 的**已知边界**（审查实测，不是设想）：
 *     ① 它守「条数／覆盖的 op 数」与「登记片段**不许回到正文**」，**不守片段身份**——把真钉子
 *        换成 `zzz-not-real` 这类垃圾照样全绿。「片段选得好不好」只能靠评审看提交信息，闸门管不了。
 *     ② 字面量/正则会**认出引用式复述**照样判红（把「旧文写的…」写进描述同样红）。要解释旧话，就
 *        **只引用证据位置（`文件:行`）**，不要复述错话本身。
 *     ③ E6 只是**管道自证**：它证明「matcher 读的是 summary+description、报错文案渲染得出来」，
 *        ⛔ **不证明任何一条登记是真的**（把片段自己拼进文本再断言命中，对被登记的片段数学上恒真）。
 *        片段本身是否为真，只能靠 `FORBIDDEN_EVIDENCE` 里的 `文件:行` 被逐个复核。
 *     ④ E4 只校验出处**形状**（`services/api/src/<file>:<line>`），⛔ **不核文件是否存在、不核行号
 *        是否越界**——写错路径（如 `services/api/src/community/community-posts.ts`）也能过 E4。
 *     ⑤ **贴豁免词即可通过（实测漏判，三条原文）**：把「单向门：」「stub 域」「只有 」这类豁免词贴在
 *        主张前面，后面接的整句即使为假也不红：
 *        `适用范围：单向门：不改可见性。` ⇒ exit 0；
 *        `…单向门：不改可见性——private 帖也一样。` ⇒ exit 0（**整句为假**）；
 *        `…只有 未接端口时读进程内种子 是旧口径，real 模式接端口时也回落进程内种子。` ⇒ exit 0（**整句为假**）。
 *        ⛔ 这是本组**已知**的能力上限：本片不做整句语义判断（那只会把闸门变成更脆的东西）。裸主张
 *        （`不改可见性。`／`未接端口时读进程内种子。`）与「砍旧句尾巴」的变体仍然红，但「贴词 + 假结论」
 *        只能靠评审。
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
 *
 * ── 尺子的口径（R69 扩面后更新）──────────────────────────────────────────────
 * **尺子仍然只有一把**（上面那四个函数），但遍历面已经没有「只查改写过的名单」这回事了：
 * `/admin` 一侧遍历 `CHECKED_ADMIN_OPS` ＝ 该族**全部 49 条**，`/me` 一侧遍历 `REWRITTEN_ME_OPS`
 * ＝ 该族**全部 17 条**。两族的区别只剩「扫哪个前缀、数多少条」——**同一族内部不再有豁免名单**。
 * 换句话说：新加一条 admin op 却忘了写 description，A 组先红（覆盖面变了）；写了但抄成模板句，
 * 或漏了 scope 字面量／漏了状态码／漏了 header 名，B／C 组会红。⛔「还没轮到它」不是跳过检查的
 * 理由——上一版正是拿「改写过的 21 条」当遍历面，于是另外 28 条一直没人管。
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
 *
 * R69 更新：B/C①/C②/C③ 的遍历面已改为 `CHECKED_ADMIN_OPS`（全部 49 条）。本名单退回它原本的
 * 语义——A 组「这一片改写过哪些」的覆盖面判定（A2 钉 28 条），⛔ 不再作为 B/C 的遍历面。
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

/**
 * B／C①／C②／C③ 的**唯一遍历面**：`/admin/**` 全部 49 条 operation（按 spec 里的出现顺序）。
 *
 * 为什么不是 `REWRITTEN_ADMIN_OPS`：那 21 条只回答「这一片改过谁」，回答不了「现在有没有人没被
 * 检查」。R69 实测过缺口——往一条**不在改写名单里**的 admin op（`listAdminCategories`）的描述里塞
 * 一个未声明的 `418`，四组全绿；同一条变异套到名单内的 `listAdminUsers` 立刻红。判定器没坏，
 * 坏的是遍历面：49 条里 21 条有人管、28 条没人管。
 *
 * 反空转交给 A2b 钉死：长度 === 49、与 `adminOps` 的 operationId 集合**双向相等**（少一条＝有人
 * 把 op 藏起来了，多一条＝名单里混进了不存在的 id 或 `/me` 族的 id）、`REWRITTEN_ADMIN_OPS`
 * 必须是它的子集、且 `/me` 族 17 条一个都不许出现在这里（防止两族混写）。
 */
const CHECKED_ADMIN_OPS = Object.freeze([
  'getAdminSession',
  'loginAdmin',
  'logoutAdmin',
  'listAdminSources',
  'createSourceDraft',
  'getAdminSource',
  'editSourceDraft',
  'publishSource',
  'withdrawSource',
  'listAdminKnowledge',
  'createKnowledgeDraft',
  'getAdminKnowledge',
  'editKnowledgeDraft',
  'publishKnowledge',
  'withdrawKnowledge',
  'listAdminRegistration',
  'createRegistrationDraft',
  'getAdminRegistration',
  'editRegistrationDraft',
  'publishRegistration',
  'withdrawRegistration',
  'listAdminRestriction',
  'createRestrictionDraft',
  'getAdminRestriction',
  'editRestrictionDraft',
  'publishRestriction',
  'withdrawRestriction',
  'listAdminCategories',
  'editCategory',
  'listAdminUsers',
  'suspendUser',
  'listAdministrators',
  'listAdministratorScopes',
  'grantAdministratorScope',
  'revokeAdministratorScope',
  'disableAdministratorAccount',
  'enableAdministratorAccount',
  'listAdminJobs',
  'cancelAdminJob',
  'listFlagAuditEvents',
  'listAuditLogs',
  'listFlags',
  'setFlag',
  'listAdminPosts',
  'getAdminPost',
  'hidePost',
  'approvePost',
  'rejectPost',
  'listAuditEvents',
]);

/**
 * 仍欠账的 admin 操作：summary 已改，description 还是模板句。⛔ 只减不增。
 *
 * R69 清零：最后一条 `listAdminCategories` 也补齐了（它此前是把模板句粘在真描述尾部，所以既中
 * B 的「description 含模板句整句」也中 C① 的「描述里没有 sources:read」）。D 的钉子同步下调到 0
 * ——「只减不增」的地板就是 0；⛔ 不要为了好看把已还清的 id 留在名单里。
 */
const PENDING_SUFFIX_OPS = Object.freeze([]);

/** 改造前的统一占位句（本片要消灭的那一句）。逐字比对，不做归一化。 */
const TEMPLATE_DESCRIPTION = '遵循状态协议：服务端归属/当前版本/授权检查；未满足条件返回明确错误。';

/** `/admin/**` operation 实测数（A1）。 */
const ADMIN_OP_COUNT = 49;

/**
 * 49 条 admin op 里**声明了** `Idempotency-Key`／`If-Match` 的条数（C③ 的断言面，实测）。
 * 另外 20 条是纯读面，一个 header 都没声明——`headerProblems` 对它们不产生期望值，也不计入
 * `asserted`，所以 C③ 的断言面只能是 29，⛔ 不能照抄 `ADMIN_OP_COUNT`。
 */
const ADMIN_HEADER_DECLARING_OP_COUNT = 29;

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

test('A2b CHECKED_ADMIN_OPS 恰好 49 条，与 admin 族实际 operationId 集合双向相等（B／C 的遍历面反空转）', () => {
  // 1. 长度钉死：少一条 ⇒ 有人把 op 从遍历面里挪走了；多一条 ⇒ 名单里混进了不存在的 id。
  assert.equal(
    CHECKED_ADMIN_OPS.length,
    ADMIN_OP_COUNT,
    `B／C 的遍历面应为全部 ${ADMIN_OP_COUNT} 条 admin op，实测 ${CHECKED_ADMIN_OPS.length} 条`,
  );
  assert.equal(
    new Set(CHECKED_ADMIN_OPS).size,
    CHECKED_ADMIN_OPS.length,
    'CHECKED_ADMIN_OPS 里有重复 operationId',
  );

  // 2. 双向相等：**这是「全部」的定义**，不是「至少包含」。单向（⊆）不够——少列一条就少守一条，
  //    而少列的那条正是当初漏掉 `listAdminCategories` 的那种漏法。
  const checkedSet = new Set(CHECKED_ADMIN_OPS);
  const actualSet = new Set(adminOps.map((entry) => entry.op.operationId));
  const unchecked = [...actualSet].filter((id) => !checkedSet.has(id));
  assert.deepEqual(
    unchecked,
    [],
    `以下 admin operation 不在 CHECKED_ADMIN_OPS 里（没有任何断言守它）：${unchecked.join(', ')}\n`
    + '⛔ 扩了 op 就必须同步扩遍历面，否则新 op 的 description 写成什么样都能过。',
  );
  const phantom = CHECKED_ADMIN_OPS.filter((id) => !actualSet.has(id));
  assert.deepEqual(
    phantom,
    [],
    `以下 operationId 在 CHECKED_ADMIN_OPS 里，但 \`/admin/**\` 里没有（改名/删除/拼错/混入了别的族）：${phantom.join(', ')}`,
  );

  // 3. 改写名单必须是遍历面的子集：「改写过的一定被检查」是这一片的最低承诺。
  const notChecked = REWRITTEN_ADMIN_OPS.filter((id) => !checkedSet.has(id));
  assert.deepEqual(
    notChecked,
    [],
    `以下改写过的 op 不在遍历面里（改过却没人守）：${notChecked.join(', ')}`,
  );

  // 4. 两族不许混写：`/me` 族 17 条不属于 admin 族，出现在这里会让统计口径互相污染。
  const meLeaked = CHECKED_ADMIN_OPS.filter((id) => meById.has(id));
  assert.deepEqual(
    meLeaked,
    [],
    `以下 /me 族 operation 混进了 CHECKED_ADMIN_OPS（两族口径混写）：${meLeaked.join(', ')}`,
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

test('B 全部 49 条 admin op：summary 不再是 operationId、含汉字、description 不再是模板句', () => {
  const problems = suffixProblems(entriesOf(adminById, CHECKED_ADMIN_OPS));
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
  const { problems, asserted } = scopeProblems(entriesOf(adminById, CHECKED_ADMIN_OPS));
  assert.deepEqual(problems, [], `以下 ${problems.length} 处 scope 与描述对不上：\n  - ${problems.join('\n  - ')}`);
  // 反空转：49 条全部都要断言到（含缺 `x-scope` 的那些——它们记问题而不是被跳过）。
  assert.equal(
    asserted,
    ADMIN_OP_COUNT,
    `C① 只断言到 ${asserted} 条（应为全部 ${ADMIN_OP_COUNT} 条 admin op）`
    + ' ⇒ 要么有 op 缺 x-scope 被记成问题、要么描述里没写出 scope 字面量',
  );
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
  const { problems, asserted } = statusCodeProblems(entriesOf(adminById, CHECKED_ADMIN_OPS));
  // 先报具体问题，再报「一条都没断言到」——否则「写错码」会被断言计数掩盖成空转。
  assert.deepEqual(
    problems,
    [],
    `以下 ${problems.length} 处状态码与描述对不上（既有「一个都没写」，也有「写了本 op 没声明的码」）：\n  - ${problems.join('\n  - ')}`,
  );
  // 遍历面从 21 条扩到 49 条后，断言面跟着变成 49：少一条就是有 op 被跳过了。
  assert.equal(
    asserted,
    ADMIN_OP_COUNT,
    `C② 只断言到 ${asserted} 条（应为全部 ${ADMIN_OP_COUNT} 条 admin op）⇒ 有 op 没有三位状态码声明或没被检查`,
  );
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
  const { problems, asserted } = headerProblems(entriesOf(adminById, CHECKED_ADMIN_OPS));
  // 反空转：这 49 条里确实有一批声明了幂等/版本头，否则本组断言等于没跑。
  // 29 = 全部 49 条 admin op 里声明了 `Idempotency-Key`／`If-Match` 的条数（实测；其余 20 条
  // 是纯读面，没声明任何 header，`headerProblems` 对它们不产生期望值也不计入 asserted）。
  assert.equal(
    asserted,
    ADMIN_HEADER_DECLARING_OP_COUNT,
    `C③ 的断言面应为 ${ADMIN_HEADER_DECLARING_OP_COUNT} 条（admin 族 ${ADMIN_OP_COUNT} 条里声明了`
    + ` Idempotency-Key／If-Match 的那些），实测只命中 ${asserted} 条`
    + ' ⇒ 要么参数改成了别的形制，要么 `$ref` 解析坏了，要么遍历面缩水了。',
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
  // R69：欠账清零，期望值同步降到 0（只减不增的地板）。⛔ 这里只许写 0；再出现欠账说明有人
  // 把 description 抄回了模板句，应该由 B 直接红，而不是靠登记进白名单换绿。
  assert.equal(
    PENDING_SUFFIX_OPS.length,
    0,
    `SUFFIX 白名单长度应为 0，实测 ${PENDING_SUFFIX_OPS.length}：白名单只许减不许增；`
    + 'R69 已把最后一条欠账还清，⛔ 不要重新登记——欠账要还，不要记账。',
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

/* ══════════════════════════════════════════════════════════════════════════════
 * E 组：反同义反复的**逆向一半**——已改准的描述被改回被证伪的错话 ⇒ 必红
 * ══════════════════════════════════════════════════════════════════════════════
 * 唯一口径：把该 op 的 `summary + '\n' + description` 拼起来，命中任一登记片段即红——字面量是
 * **逐字**包含，正则形态另外带「成真的限定词」豁免（见文件头「两种登记形态」；豁免只看紧邻的几个字，
 * 「贴词即过」的边界见已知边界 ⑤）。⛔ 不做任何归一化（去空白／全角转半角／标点折叠）：错话回退时
 * 常常连标点一起回退，归一化只会放过它，还会让「片段到底长什么样」不可核对。要放宽就改登记片段本身，
 * 并在提交信息里说明理由。
 */

/**
 * op → 已被证伪、**绝不许再出现**的描述片段（每条都在行内注释写清是谁证伪的；真值出处见
 * `FORBIDDEN_EVIDENCE`，那里是 `文件:行`）。
 *
 * ⚠ 登记纪律（踩过的坑，别重犯）：**片段不能是真话的子串**，也不能把旧句的尾巴当成唯一判据。
 * - 摘得太短会误红：裸的 `不改可见性` 会红掉真话「已 hidden/deleted 的单向门：不改可见性」
 *   （`services/api/src/admin/ops/community-posts.ts:326`：hidden/deleted **不**为它们翻案，单向门）；
 *   裸的 `未接端口时读进程内种子` 会红掉真话「stub 域未接端口时读进程内种子」
 *   （`services/api/src/admin/ops/accounts-only.ts:184` 只有 flagsWired 才走 inner）。
 * - **但「补回旧句标点尾巴」不是修法**：判据绑在尾巴上，砍掉尾巴的同一句错话就漏过去了（审查实测：
 *   把 `不改可见性。`／`未接端口时读进程内种子。` 写回正文，旧版全绿 ⇒ 覆盖反而下降）。修法是
 *   **正则 + negative lookbehind**：把「成真的限定词」写成豁免（见文件头「两种登记形态」），
 *   主张本体仍然一个字都不许回来。
 *
 * ⛔ 登记只许增不许减：新增随意（发现一条错话被改掉，就把它钉住）；**删条目必须写清「为什么这句话
 * 不再算错」**（典型：契约语义真的改了，而这条登记的是旧语义），并同步下调 `FORBIDDEN_MIN_SNIPPETS`。
 * 条数下限见 `FORBIDDEN_MIN_SNIPPETS`（E1）。
 */
const FORBIDDEN_SNIPPETS = Object.freeze({
  // #719（ab883f67）删掉的 summary「人工审核通过一条帖子，但不改其可见性」与 description
  // 「…写运营通过结论（audit_state=approved），不改可见性；硬规则…」。真值：这拍的「通过」
  // 自带发布语义——private 在同一次 CAS 里被推成 published。
  // ⚠ 第 2 条是**正则**，不是「不改可见性；硬规则」这种尾巴：`:326` 只把「hidden/deleted 的单向门」
  // 这一种写法判为真，其余任何「不改可见性」（含裸句、含「只翻 audit_state，不改可见性」）都要红。
  // ⛔ 但正则的豁免**只看紧邻的几个字**（全角/半角冒号、冒号前后空格都算）：把「单向门：」贴在
  // 主张前面，后面的假结论照样全绿（文件头已知边界 ⑤ 有实测原文）——这一层只能靠评审。
  approvePost: Object.freeze([
    '不改其可见性',
    Object.freeze({ re: /(?<!单向门\s*[：:]\s*)不改可见性/, sample: '不改可见性' }),
  ]),

  // #719 删掉的 summary「…并使引用旧版本的公开内容立即失效」与 description「新不可变版本，
  // 旧公开引用立即失效并重新核对；…」。真值：编辑只**追加**新修订，不动已发布修订，
  // 公开面本来就只读 publishedRevision——所以旧引用既不会失效，也不需要「重新核对」。
  editKnowledgeDraft: Object.freeze([
    '使引用旧版本的公开内容立即失效',
    '旧公开引用立即失效',
    '立即失效并重新核对',
  ]),

  // 与 knowledge 同一句错话（#719 三条草稿编辑 op 共用同一段模板描述）。
  editRegistrationDraft: Object.freeze(['旧公开引用立即失效', '立即失效并重新核对']),
  editRestrictionDraft: Object.freeze(['旧公开引用立即失效', '立即失效并重新核对']),

  // #719 删掉的 description 里的「…未接端口时读进程内种子；游标按 key 键集分页…」。
  // 真值：只有 stub 域才回落进程内种子，real 模式没有库池直接 503（不回落）。
  // ⚠ 正则，不是「…；游标」这种尾巴：`accounts-only.ts:184` 只把「stub 域 / 只有 stub 域」这一种
  // 写法判为真，其余「未接端口时读进程内种子」（含砍掉尾巴的裸句「门 flags:read；未接端口时读进程内
  // 种子。」）都要红。⛔ 不带 `g`／`y`：`RegExp#test` 的 `lastIndex` 会造成间歇漏判。
  // ⛔ 豁免同样只看紧邻的几个字（`stub 域`／`只有 `，空格容错）：贴词即过的通道见文件头已知边界 ⑤。
  listFlags: Object.freeze([
    Object.freeze({ re: /(?<!stub\s*域)(?<!只有\s*)未接端口时读进程内种子/, sample: '未接端口时读进程内种子' }),
  ]),

  // #718（9a394db2）删掉的 description「同事务立即撤全部会话/角色/外发和在途回写；…」。
  // 真值：同事务只实现「会话 + auth_epoch」那一半，外发与在途回写的撤销**未实现**。
  requestAccountDeletion: Object.freeze(['撤全部会话/角色/外发和在途回写']),

  // #718 删掉的 description「…异步处理完ready前不可AI调用。」。真值：同一请求内同步推到
  // ready；已 ready 返回 202 幂等。
  completeUpload: Object.freeze(['异步处理完ready前不可AI调用']),
});

/**
 * op → 证伪依据（谁把它改掉的）与**真值出处**（`文件:行`，行号全部现场用
 * `git -C <repo> show 9a394db2:<path>` 数出来，不凭记忆）。
 * ⛔ 新增登记必须同时补这里：红的时候要能指着代码说「真值在这儿」，否则闸门只会喊「错了」，
 * 不会告诉人「错在哪」。
 */
const FORBIDDEN_EVIDENCE = Object.freeze({
  approvePost: Object.freeze({
    refutedBy: '#719（ab883f67）删掉 summary「人工审核通过一条帖子，但不改其可见性」与 description「…不改可见性；硬规则明确否决的内容不可通过（422）。」',
    truth: 'services/api/src/admin/ops/community-posts.ts:327-328（private ⇒ published 的目标可见性）、:351-361（commitPostIfCurrent 在 CAS 新值里写 visibility），口径注释见 :321-326',
  }),
  editKnowledgeDraft: Object.freeze({
    refutedBy: '#719（ab883f67）删掉 summary「…并使引用旧版本的公开内容立即失效」与 description「新不可变版本，旧公开引用立即失效并重新核对；不能用客户端提交review_status。」',
    truth: 'services/api/src/admin/service.ts:338-345（只追加新修订，已发布修订不被改写）、services/api/src/admin/public-view.ts:9-11（公开面只读 publishedRevision，绝不读 head）',
  }),
  editRegistrationDraft: Object.freeze({
    refutedBy: '#719（ab883f67）删掉 description「新不可变版本，旧公开引用立即失效并重新核对；不能用客户端提交review_status。」',
    truth: 'services/api/src/admin/service.ts:338-345（同一份 appendRevision 只追加）、services/api/src/admin/public-view.ts:9-11（公开面只读 publishedRevision）',
  }),
  editRestrictionDraft: Object.freeze({
    refutedBy: '#719（ab883f67）删掉 description「新不可变版本，旧公开引用立即失效并重新核对；不能用客户端提交review_status。」',
    truth: 'services/api/src/admin/service.ts:338-345（同一份 appendRevision 只追加）、services/api/src/admin/public-view.ts:9-11（公开面只读 publishedRevision）',
  }),
  listFlags: Object.freeze({
    refutedBy: '#719（ab883f67）删掉 description 里的「…未接端口时读进程内种子；游标按 key 键集分页…」',
    truth: 'services/api/src/admin/ops/accounts-only.ts:146-148（reject 直接抛 PROVIDER_UNAVAILABLE，retryable:false）、:184（只有 flagsWired 才放行 listFlags，否则走 reject）',
  }),
  requestAccountDeletion: Object.freeze({
    refutedBy: '#718（9a394db2）删掉 description「同事务立即撤全部会话/角色/外发和在途回写；回执token只允许最小进度查询。」',
    truth: 'services/api/src/privacy/account-deletion.ts:44-49（已实现清单＝会话 + auth_epoch）与 :52-56（仍未实现：outbox／到期执行／外发与在途回写的撤销）、services/api/src/privacy/deletion-requests-pg.ts:9-13（受理事务：state→deletion_pending、auth_epoch+1、撤全部会话、请求落库）。'
      + '⚠「角色」二字的准确说法是：设计口径要求撤（`docs/architecture/state-contract.md:105`「撤所有用户会话/角色」），'
      + '而实现清单里没有（`account-deletion.ts:44-49` 只列会话 + auth_epoch，`:52-56` 也未把它列入未实现项）⇒ '
      + '本条判假**不靠「角色」**，靠同句里的「外发与在途回写的撤销未实现」；登记整句是为了「旧句原封放回」必红。',
  }),
  completeUpload: Object.freeze({
    refutedBy: '#718（9a394db2）删掉 description「验实际魔数/hash/字节、解码和EXIF，异步处理完ready前不可AI调用。」',
    truth: '同一请求内同步推进：services/api/src/media/service.ts:1056（transition uploaded）→ :1074／:1079（processing）→ :1083（transition ready）→ :1104（同一函数返回 202）；已 ready 的幂等返回见 :1039-1042，其余非 initiated／uploaded ⇒ 409 OBJECT_UNAVAILABLE 见 :1043-1045',
  }),
});

/**
 * 片段条数下限（E1）：**等于当前实测条数**，任何减少都必须显式下调这个数字。
 * ⚠ 它只守「条数」，**守不住「身份」**——审查实测（`rotate-pin`）把一条真钉子换成 `zzz-junk-1`
 * 再把条数补平，20/20 全绿。也就是说「先删登记再改回错话」这条通道**没有被断言堵住**，能堵住它的
 * 只有评审读提交信息。⛔ 别把这里的数字当成「内容有保证」的证据。
 */
const FORBIDDEN_MIN_SNIPPETS = 12;

/** 登记覆盖的 op 数下限（E1）：与 `FORBIDDEN_MIN_SNIPPETS` 同时钉，防「把 12 条全堆在一个 op 上」。 */
const FORBIDDEN_MIN_OPS = 7;

/**
 * ⚠ 已知欠账（可执行的 TODO，不是「暂不登记」四个字）：`getProfile`／`listExports`／`listMessages`
 * 在基线 `9a394db2` 上**仍带着**「非 user 角色 403 SCOPE_DENIED」的错话（真值：
 * `services/api/src/auth/middleware.ts:75-107` 只 `loadLiveSession(…, 'user')`，`:99` role 与
 * `:103` scopes 硬编码；`SCOPE_DENIED` 只在 `:110-120` 的 `authenticateAdmin` 里抛）。
 * 现在**登记任一种形态都会误红**：整句 `非 user 角色 403 SCOPE_DENIED` 在这 3 条正文里同段共现，
 * 而 #721（`feat/gy-r68-a04-me-scope`，`1c78f1eb`）改准后正文仍保留「非 user 角色」四字（作解释性
 * 引用）却不再含 `SCOPE_DENIED` ⇒ 单登记那四个字在合入后必红。
 * ⇒ **#721 合入后立刻做**：把 `非 user 角色 403 SCOPE_DENIED` 登记进上面 3 个 op，并把
 * `FORBIDDEN_MIN_SNIPPETS` 12→15、`FORBIDDEN_MIN_OPS` 7→10。
 */

/** 片段最短字数（E3）：登记「的」「不改」这种无效条目挡不住任何真实退化，只会让表看起来有内容。 */
const FORBIDDEN_MIN_SNIPPET_CHARS = 4;

/** 全 spec 的 operationId 索引（E2 用：键必须真实存在，拼错/改名要红而不是静默跳过）。 */
const EVERY_OP_BY_ID = new Map(
  [...adminOps, ...otherOps].map((entry) => [entry.op.operationId, entry]),
);

/**
 * 登记的两种形态，统一成三个取词函数（E3 校验形状、E5 判定、E6 注入、报错渲染都走这里）：
 * - 字面量 `'错话'`：`String#includes`，展示与注入都用它本身。
 * - `{ re, sample }`：`RegExp#test`（⛔ 必须无 `g`，否则 `lastIndex` 会让同一文本间歇漏判），
 *   展示用 `re.source`，注入用 `sample`（`sample` 必须被 `re` 命中，E3 会验）。
 */
function snippetLabelOf(snippet) {
  return typeof snippet === 'string' ? snippet : snippet.re.source;
}

/** 注入用样本：字面量就是它本身；正则是 `sample`（别拿整个正则串去拼，那永远命中不了）。 */
function snippetSampleOf(snippet) {
  return typeof snippet === 'string' ? snippet : snippet.sample;
}

/** 片段的有效字数（E3 的下限判据）：正则按 `sample` 算，别让 `(?<!x)` 这类豁免语法去凑字数。 */
function snippetCharsOf(snippet) {
  return [...snippetSampleOf(snippet)].length;
}

/** 该片段是否出现在 `text` 里（E5 的唯一判据）。 */
function snippetHitsIn(snippet, text) {
  return typeof snippet === 'string' ? text.includes(snippet) : snippet.re.test(text);
}

/** 某 op 参与 E 判定的文本。⚠ 只有 `summary` 与 `description`：E 管的是「人读的那两段」。 */
function forbiddenTextOf(op) {
  return `${String(op.summary ?? '')}\n${String(op.description ?? '')}`;
}

/** `text` 里命中了该 op 登记的哪几条片段（返回展示用标签清单，空数组＝没命中）。 */
function forbiddenHitsIn(id, text) {
  const snippets = FORBIDDEN_SNIPPETS[id] ?? [];
  return snippets.filter((snippet) => snippetHitsIn(snippet, text)).map(snippetLabelOf);
}

/** 把一处命中格式化成给人看的报错：点名 op、片段、证伪者、真值出处。 */
function formatForbiddenHit(id, snippet, entry) {
  const evidence = FORBIDDEN_EVIDENCE[id];
  return `\`${id}\`（${entry.method.toUpperCase()} ${entry.path}）的描述里又出现了已被证伪的说法`
    + `「${snippet}」。\n    这条说法已被证伪：${evidence.refutedBy}\n    真值见 ${evidence.truth}`;
}

/** E5 的公共实现：遍历全表，返回问题清单（空数组＝通过）。 */
function forbiddenProblems(byId) {
  const problems = [];
  for (const id of Object.keys(FORBIDDEN_SNIPPETS)) {
    const entry = byId.get(id);
    // 键不存在的问题由 E2 单独判红；这里跳过，免得同一个错因报两遍。
    if (!entry) continue;
    for (const snippet of forbiddenHitsIn(id, forbiddenTextOf(entry.op))) {
      problems.push(formatForbiddenHit(id, snippet, entry));
    }
  }
  return problems;
}

test('E1 禁用片段表不得为空，且条目数／覆盖 op 数有下限（下限只许涨）', () => {
  const ids = Object.keys(FORBIDDEN_SNIPPETS);
  const snippets = ids.flatMap((id) => (Array.isArray(FORBIDDEN_SNIPPETS[id]) ? FORBIDDEN_SNIPPETS[id] : []));
  assert.ok(
    ids.length > 0 &&
      snippets.length > 0,
    'E1 禁用片段表是空的 ⇒ E5 遍历零条、永远绿，整组 E 变成摆设（这正是本组要防的同义反复）。',
  );
  assert.ok(
    snippets.length >= FORBIDDEN_MIN_SNIPPETS,
    `E1 禁用片段表只有 ${snippets.length} 条，下限 ${FORBIDDEN_MIN_SNIPPETS} 条。`
    + '⚠ 这个下限只守条数、不守内容：删一条真正的钉子、再用垃圾片段把条数补平，这里照样绿（审查实测）。'
    + '所以先问「删掉的那条是不是真的被证伪了」，再决定是否下调。',
  );
  assert.ok(
    ids.length >= FORBIDDEN_MIN_OPS,
    `E1 只覆盖了 ${ids.length} 个 operation，下限 ${FORBIDDEN_MIN_OPS} 个：`
    + '把全部片段堆在同一个 op 上不算覆盖（代码改一处、描述错一处，退化是按 op 来的）。',
  );
});

test('E2 每个键必须是真实存在的 operationId（拼错不许静默跳过）', () => {
  const problems = [];
  for (const id of Object.keys(FORBIDDEN_SNIPPETS)) {
    if (!EVERY_OP_BY_ID.has(id)) {
      problems.push(
        `\`${id}\` 不在 spec 的任何 operation 里（拼错？operationId 改名？）⇒ 这条登记永远不会生效，`
        + '而 E5 会以为它守住了。',
      );
    }
  }
  for (const id of Object.keys(FORBIDDEN_EVIDENCE)) {
    if (!Object.hasOwn(FORBIDDEN_SNIPPETS, id)) {
      problems.push(`FORBIDDEN_EVIDENCE 里有 \`${id}\`，但 FORBIDDEN_SNIPPETS 没有 ⇒ 出处记录挂在空气上（反之亦然）。`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `禁用片段表的键与 spec／出处表对不上（${problems.length} 处）：\n  - ${problems.join('\n  - ')}`,
  );
});

test('E3 每个值必须是非空数组：字面量或 `{ re, sample }`，片段／样本 ≥ 4 字（防「登记一个的」）', () => {
  const problems = [];
  for (const [id, snippets] of Object.entries(FORBIDDEN_SNIPPETS)) {
    if (!Array.isArray(snippets)) {
      problems.push(`\`${id}\` 的值不是数组（实测 ${typeof snippets}）⇒ 片段必须逐条列，便于逐条核对出处`);
      continue;
    }
    if (snippets.length < 1) {
      problems.push(`\`${id}\` 的值是空数组 ⇒ 该 op 名义上被守住，实际一条都没登记`);
      continue;
    }
    snippets.forEach((snippet, index) => {
      // 形态①：字面量。形态②：`{ re, sample }`（正则 + 注入样本）。
      if (typeof snippet === 'string') {
        if (snippet.trim().length === 0) {
          problems.push(`\`${id}\`[${index}] 是空串／全空白 ⇒ 空串被任何文本包含，等于恒红`);
          return;
        }
        if ([...snippet].length < FORBIDDEN_MIN_SNIPPET_CHARS) {
          problems.push(
            `\`${id}\`[${index}] 片段「${snippet}」只有 ${[...snippet].length} 字（下限 ${FORBIDDEN_MIN_SNIPPET_CHARS}）：`
            + '这么短的片段会命中大量正常句子，既挡不住退化，又会逼后来人删掉整条登记。',
          );
        }
        if (snippets.indexOf(snippet) !== index) {
          problems.push(`\`${id}\`[${index}] 片段「${snippet}」重复登记`);
        }
        return;
      }
      if (snippet === null || typeof snippet !== 'object' || Object.getPrototypeOf(snippet) !== Object.prototype) {
        problems.push(
          `\`${id}\`[${index}] 既不是字符串也不是 \`{ re, sample }\` 对象（实测 ${Object.prototype.toString.call(snippet)}）：`
          + '只认这两种形态，免得有人塞个函数进来让判定恒真。',
        );
        return;
      }
      const { re, sample } = snippet;
      if (!(re instanceof RegExp)) {
        problems.push(`\`${id}\`[${index}].re 不是正则（实测 ${typeof re}）`);
      } else {
        // ⛔ 带 g 会让 `RegExp#test` 依赖 lastIndex，同一文本第二次判定结果可能翻脸（间歇漏判）。
        if (re.global) problems.push(`\`${id}\`[${index}].re 带了 \`g\` 标志 ⇒ \`test\` 的 lastIndex 会造成间歇漏判，必须去掉`);
        // ⛔ 带 y 同理（sticky 也吃 lastIndex）。
        if (re.sticky) problems.push(`\`${id}\`[${index}].re 带了 \`y\`（sticky）标志 ⇒ 同样依赖 lastIndex，必须去掉`);
        if (re.source.trim().length === 0) problems.push(`\`${id}\`[${index}].re 是空正则 ⇒ 命中任何文本，等于恒红`);
      }
      if (typeof sample !== 'string') {
        problems.push(`\`${id}\`[${index}].sample 不是字符串（实测 ${typeof sample}）⇒ E6 拿什么注入？`);
        return;
      }
      if (sample.trim().length === 0) {
        problems.push(`\`${id}\`[${index}].sample 是空串／全空白 ⇒ 注入后恒命中，管道自证变成空转`);
      } else if ([...sample].length < FORBIDDEN_MIN_SNIPPET_CHARS) {
        problems.push(
          `\`${id}\`[${index}].sample「${sample}」只有 ${[...sample].length} 字（下限 ${FORBIDDEN_MIN_SNIPPET_CHARS}）⇒ `
          + '样本本身太短，注入后可能命中正常句子，验不出真实退化。',
        );
      }
      if (re instanceof RegExp && typeof sample === 'string' && !re.test(sample)) {
        problems.push(
          `\`${id}\`[${index}] 的 sample「${sample}」**不被自己的正则命中**（re.source = /${re.source}/）⇒ `
          + 'E6 注入它也不会报，管道看起来自洽、实际空转。',
        );
      }
      if (snippets.findIndex((other) => other === snippet) !== index) {
        problems.push(`\`${id}\`[${index}] 这条 \`{ re, sample }\` 重复登记（同一个对象出现两次）`);
      }
    });
    // label 层面查重：字面量与正则的 source 撞了，等于同一条登记了两遍。
    const labels = snippets.map((snippet) => (typeof snippet === 'string' ? snippet : `/${snippet?.re?.source ?? '?'}/`));
    labels.forEach((label, index) => {
      if (labels.indexOf(label) !== index) problems.push(`\`${id}\`[${index}] 展示标签「${label}」与前面重复`);
    });
  }
  assert.deepEqual(
    problems,
    [],
    `禁用片段表有 ${problems.length} 处形状问题：\n  - ${problems.join('\n  - ')}`,
  );
});

/**
 * ⚠ E4 只校验**形状**（`services/api/src/<file>:<line>`）：它**不核文件是否存在、不核行号是否越界**
 * （审查探针 `bogus_truth_path` 实测 EXIT=0）。也就是说「写了个不存在的路径」这种错它能放过半条——
 * 出处的真实性只能靠评审按 `git show <sha>:<path>` 复核，别把 E4 的绿当成「行号已被验证」。
 */
test('E4 每条登记都要有出处：证伪者 + 真值 `文件:行`', () => {
  const problems = [];
  for (const id of Object.keys(FORBIDDEN_SNIPPETS)) {
    const evidence = FORBIDDEN_EVIDENCE[id];
    if (!evidence) {
      problems.push(`\`${id}\` 没有 FORBIDDEN_EVIDENCE 条目 ⇒ 红的时候说不出「谁证伪的、真值在哪」`);
      continue;
    }
    if (typeof evidence.refutedBy !== 'string' || evidence.refutedBy.trim().length < 8) {
      problems.push(`\`${id}\`.refutedBy 缺失或过短 ⇒ 必须写清是谁（哪个 PR／提交）把它改掉的`);
    }
    if (typeof evidence.truth !== 'string' || !/services\/api\/src\/[\w./-]+:\d+/.test(evidence.truth)) {
      problems.push(
        `\`${id}\`.truth 不是「文件:行」形式（实测 ${JSON.stringify(evidence.truth)}）⇒ `
        + '没有行号的出处只能算感想，不能算可核事实。',
      );
    }
  }
  assert.deepEqual(
    problems,
    [],
    `禁用片段表的出处记录不完整（${problems.length} 处）：\n  - ${problems.join('\n  - ')}`,
  );
});

test('E5 已改准的描述不得退回被证伪的错话', () => {
  const problems = forbiddenProblems(EVERY_OP_BY_ID);
  if (problems.length > 0) {
    assert.fail(
      `⛔ ${problems.length} 处描述退回了已被证伪的说法（改准的句子又被改回错话）：`
      + `\n  - ${problems.join('\n  - ')}`
      + '\n  ⚠ 先别删登记：先确认这句是不是在**复述**那句错话（而不是引用/对照）。要解释旧话就只引用'
      + '证据位置（`文件:行`），别复述错话本身——引号里复述也不行，字面量与正则都不认引号。'
      + '只有确认「这条登记本身已被证伪」（契约语义真的改了）时才允许删条目，并须在提交信息里写明'
      + '理由、同步下调 `FORBIDDEN_MIN_SNIPPETS`。',
    );
  }
});

/**
 * E6 是**管道自证**，不是「判据非恒真」的自证——分开说清这两件事：
 * - 方向一（当前正文不得命中）有判别力，但它判的是「现在这版正文」；同一句话写歪的人会看到它红。
 * - 方向二（把片段注入正文 ⇒ 必须报命中）**对被登记的片段数学上恒真**：片段非空（E3 保证 ≥ 4 字）
 *   且就是自己拼进去的。它只证明「matcher 读的是 summary+description、报错文案渲染得出来」，
 *   ⛔ **不证明任何一条登记是真的**：把片段换成 `zzz-not-real` 这类垃圾，本用例照样全绿。
 *   「片段是否为真」只能靠 `FORBIDDEN_EVIDENCE` 里的 `文件:行` 被逐个复核。
 * 覆盖：循环体对**每一条**片段各做一次注入（不是只做 `snippets[0]`），条数由 E1 的下限兜住。
 */
test('E6 管道自证：每条片段注入正文后必被 matcher 命中（⛔ 不证明片段为真）', () => {
  const proven = [];
  for (const [id, snippets] of Object.entries(FORBIDDEN_SNIPPETS)) {
    const entry = EVERY_OP_BY_ID.get(id);
    assert.ok(entry, `E6 的样本 op ${id} 在 spec 里不存在（本该由 E2 报，这里再兜一次）`);
    const original = forbiddenTextOf(entry.op);
    // 方向一：当前这版已改准的正文里不得命中任何一条登记片段。按 op 报一次「实际命中了哪些」，
    // 比逐片段重复报更准确（逐片段会在 A 命中时误报成 B 命中）。
    assert.deepEqual(
      forbiddenHitsIn(id, original),
      [],
      `⛔ ${id} 的当前正文命中了登记片段：要么描述退回了错话（看 E5 的报错与出处），`
      + '要么这条登记已过期。⚠ 删之前先确认它已被证伪；要引用旧话就只引用 `文件:行`，别复述原句。',
    );
    // 方向二：逐条注入 ⇒ matcher 必须报出该条。
    // ⚠ 注入的是 `snippetSampleOf`：字面量就是它本身，正则用它的 `sample`（把 `re.source` 拼进正文
    // 是永远命中不了的假自证——`(?<!单向门：)` 这类语法在正文里根本不会出现）。
    for (const snippet of snippets) {
      const label = snippetLabelOf(snippet);
      const sample = snippetSampleOf(snippet);
      const injected = forbiddenHitsIn(id, `${original}\n${sample}`);
      assert.ok(
        injected.includes(label),
        `⛔ 把样本「${sample}」注入 ${id} 的正文之后 matcher 没有报出「${label}」⇒ 判定管道坏了`,
      );
      // 报错文案必须点名 op、片段、证伪者与真值出处：「红了但说不清哪句话错」只算半个闸门。
      const message = formatForbiddenHit(id, label, entry);
      for (const must of [id, label, '已被证伪', '真值见', 'services/api/src/']) {
        assert.ok(message.includes(must), `E6 报错文案缺「${must}」：${message}`);
      }
      proven.push(`${id}#${label}`);
    }
  }
  assert.ok(
    proven.length >= FORBIDDEN_MIN_SNIPPETS,
    `E6 只注入了 ${proven.length} 条片段（下限 ${FORBIDDEN_MIN_SNIPPETS}）⇒ 有片段没走过注入路径，管道覆盖不全。`,
  );
});

// ── A04 第三片（其余族 60 条）的覆盖面与四组判据（来自 upstream/main，与本片 E 组并存）──
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

// GY-I22 / R31 · `retryable` 白名单（**数据与守卫分离**，守卫逻辑在
// `tests/unit/error-retryable-static-guard.test.mjs`，判据实现在 `tests/unit/retryable-guard-scan.mjs`）。
//
// 为什么要有白名单：`services/api/src/errors.ts:28-40` 的口径是「能力未装配／未接线 ⇒ false；只有真瞬时才可
// true」，但每个调用点各自写字面量 ⇒ 口径必须落成**逐站点的、带理由的、会腐烂的**清单，而不是一句注释。
//
// 条目字段：
//   - `file`：仓库相对路径（正斜杠）；
//   - `retryable`：与源码表达式**逐字节**相同（`normalize` 折叠空白后比较）——改分类器实现会立刻红；
//   - `function`（可选）：站点所在函数名，用于同文件多处同表达式的精确落点；
//   - `message`（可选）：错误消息字面量子串，用于同文件多处同表达式的精确落点；
//   - `kinds`（可选，缺省 `['providerUnavailable']`）：
//       `providerUnavailable` = `new ApiError/PrivacyError` 且 code 含 `PROVIDER_UNAVAILABLE`、`retryable` 非 false；
//       `fallback`            = catch 通道上「兜底恒 `retryable: true`」的站点（判据见 `retryable-guard-scan.mjs`）；
//   - `owner`：责任片（`GY-Ixx` 或 `R31`）；
//   - `reason`：**为什么这一处可以不是 false**。没有理由的白名单等于把守卫关掉，守卫会红。
//
// 每个条目在它声明的每个 `kind` 下都**必须被命中恰好一次**；站点被删、表达式被改、消息被改 ⇒ 条目变成
// 「未被命中」⇒ 守卫红。这就是「白名单不腐烂」：清单只增不改的仓库，最终会退化成 `eslint-disable` 墙。
//
// 本文件由 R31（#455 后两个已知缺口）从守卫内联搬出并扩域：#455 落地后受控域只有
// `{db, privacy, conversations}`，`admin/ops`、`ocr`、`speech`、`recognitions`、`media` 的
// store/gate 写回「兜底恒 true」不会被判红 —— 扩域后实测出 9 处既有站点（见下）。
//
// **时点**：本片基线已并入 `#455`（head `0eaf1bde`）。扩域当时判为「确定性失败却声称可重试」的 5 处
// （`flags-pg.ts` 兜底恒 true、`service.ts` 兜底恒 true、`ocr|speech|recognitions` 的 `tablesReady`）
// 已被 `#455` 修掉：前两处改为委托共享判据 `flagReadFailure()`（`isTransientDatabaseError` 分档），
// 后三处改为 `retryable: false` + `details: PROBE_SHAPE_UNKNOWN` ⇒ 对应白名单条目已删。
// 现存 13 条 = 原 6 条（`GY-I22`）+ 扩域新增的 6 条（`R31`）+ `media/store-pg.ts` 1 条（`GY-I06`，W12 媒体
// 持久化合流时按同一口径登记），全部是「有判据」的合法放宽；
// 受控范围内 `judgement: none` 的兜底站点已归零，且由 `tests/unit/retryable-fallback-inventory.test.mjs`
// 的全仓清单持续把守（清单里仍有 `none` 条目＝本片登记不修的其它域站点）。

/** 允许「非 false 的 retryable」的全部站点。 */
export const ALLOWED_RETRYABLE = [
  // —— 扩域前既有的 6 条（owner：GY-I22；理由原文保留） ——
  {
    file: 'services/api/src/db/catalog.ts',
    retryable: 'isTransientDatabaseError(error)',
    message: '主页资料数据库暂不可用',
    owner: 'GY-I22',
    reason:
      '主页资料读面：超时/连接层/管理员干预/串行化冲突是瞬时态（同一请求稍后重试确实可能成功）；'
      + '配置与权限类由同一分类器返回 false（口径见 errors.ts:28-40、分类器见 db/pool.ts）。',
  },
  {
    file: 'services/api/src/db/catalog.ts',
    retryable: 'isTransientDatabaseError(error)',
    message: '登记资料数据库暂不可用',
    owner: 'GY-I22',
    reason:
      '登记资料读面：与同文件 readHomePreviews 同一分类器（状态码保留既有 503 不变，只订正 retryable 分档），'
      + '避免同一文件出现两套策略。',
  },
  {
    file: 'services/api/src/conversations/store-pg.ts',
    retryable: 'isTransientDatabaseError(error)',
    message: '问答数据库暂不可用',
    owner: 'GY-I22',
    reason:
      '问答库事务的 catch-all：57014/55P03 已在上方单独映射为 PROVIDER_TIMEOUT；此处只放行瞬时类，'
      + '42501/3D000/28P01/42P01/42883 与无法归类的驱动错误一律 false。',
  },
  {
    file: 'services/api/src/privacy/deletion-requests-pg.ts',
    retryable: 'true',
    message: '注销受理暂不可用',
    owner: 'GY-I22',
    reason:
      '注销受理的瞬时类分支（08xxx/53xxx/57P0x/40001/40P01）：同一请求稍后重试确实可能成功；'
      + '同一 mapDeletionError 的其余分支（42501/42883/无法归类）已改为 false。',
  },
  {
    file: 'services/api/src/db/source-lifecycle.ts',
    retryable: 'unknown || isTransientDatabaseError(error)',
    message: '来源操作结果未确认，请使用同一操作编号核对后重试',
    owner: 'GY-I22',
    reason:
      '结果未知（无 code / ECONNRESET / EPIPE / ETIMEDOUT）⇒ 用同一操作编号核对后重试是设计内的恢复路径（瞬时 ⇒ true）；'
      + '已归类的 PROVIDER_UNAVAILABLE 不再无条件 true，改由同一分类器分档。'
      + '（这一处是**守卫实测**发现的第 10 处同类漏改：派单只列了 9 处，复审判定漏了它。）',
  },
  {
    file: 'services/api/src/privacy/ledger-pg.ts',
    retryable: 'true',
    message: '外发账本暂不可用',
    owner: 'GY-I22',
    reason:
      '既有合法瞬时分支（mapPgError 的 08/53/57P0/40001/40P01 档，见该文件 73-81 行注释）；'
      + '本片不改它，登记在此以免守卫误报——它的分档正是本片其它站点的先例。',
  },

  // —— R31 扩域后新增的 6 条（owner：R31） ——
  // 扩域当时实测 9 处，其中 3 条 `tablesReady`（ocr/speech/recognitions）已被 #455 改成
  // `retryable: false` + `details: PROBE_SHAPE_UNKNOWN` ⇒ 站点不再非 false，条目按「不腐烂」规则删除。
  {
    file: 'services/api/src/admin/ops/flag-gate.ts',
    function: 'failClosedError',
    retryable: 'failClosedRetryableFor(cause)',
    owner: 'R31',
    reason:
      '**有判据**（合法放宽）：`retryable` 由 `FlagGateFailCause` 决定，`failClosedRetryableFor` 是唯一判据'
      + '（flag-gate.ts:80-83）：`read_error`（读取抛错＝存储抖动/超时）⇒ true；`unrecognized`'
      + '（行缺失 / `enabled` 非布尔 / `key` 越界 / `revision` 非法＝配置或数据事故，需运维修复）⇒ false。'
      + '复核结论原文见 flag-gate.ts:372-381。守卫只钉表达式文本，改分类器实现必须同步改这里。',
  },
  {
    file: 'services/api/src/admin/ops/flags-pg.ts',
    function: 'mapFlagReadError',
    retryable: 'flagReadFailure(error)',
    message: '全局开关读取暂不可用',
    owner: 'R31',
    reason:
      '**有判据**（合法放宽）：`#455`（`0eaf1bde`）把这一处原本的兜底恒 `true` 改为委托同一文件导出的'
      + '`flagReadFailure(error)` —— 该判据直接走 `db/pool.ts` 的 `isTransientDatabaseError`'
      + '（08xxx/53xxx/57P0x/40001/40P01 ⇒ true；无 `code` 的无法归类错误、其余 SQLSTATE ⇒ false），'
      + '原始 `code` 落 `details` 供排障。扩域当日本条被判「兜底恒 true（真缺陷）」，现已修复，故判定改写为'
      + '「有判据」。守卫只钉表达式文本，改判据实现必须同步改这里。',
  },
  {
    file: 'services/api/src/admin/ops/service.ts',
    function: 'throwFlagReadFailure',
    retryable: 'flagReadFailure(error)',
    message: '全局开关读取暂不可用',
    owner: 'R31',
    reason:
      '**有判据**（合法放宽）：`#455` 把原来的本地兜底（一律 `retryable: true`）改为委托 `flags-pg.ts` 的'
      + '`flagReadFailure(error)`，函数同时改名 `flagReadFailure` → `throwFlagReadFailure`（避免与共享判据重名）。'
      + '于是同一功能面的「开关读不出来」只有一套口径，与 `flag-gate.ts` 的 `read_error`/`unrecognized` 分档'
      + '不再互相矛盾。扩域当日本条被判「兜底恒 true（真缺陷）」，现已修复。',
  },
  {
    file: 'services/api/src/ocr/store-pg.ts',
    function: 'classifyOcrDatabaseError',
    retryable: 'isTransientDatabaseError(error)',
    message: 'OCR 数据库暂不可用',
    owner: 'R31',
    reason:
      '**有判据**（合法放宽）：与 `messages/favorites/history/community/conversations` 的 `classify*DatabaseError`'
      + '逐条同口径 —— 57014/55P03 已在上方折成 `PROVIDER_TIMEOUT`；此处 `isTransientDatabaseError`（db/pool.ts）'
      + '只放行 08xxx/53xxx/57P0x/40001/40P01，42501/3D000/28P01/42P01/42883 与无法归类一律 false'
      + '（注释原文见 ocr/store-pg.ts:133-136）。',
  },
  {
    file: 'services/api/src/recognitions/store-pg.ts',
    function: 'classifyRecognitionDatabaseError',
    retryable: 'isTransientDatabaseError(error)',
    message: '识别数据库暂不可用',
    owner: 'R31',
    reason:
      '**有判据**（合法放宽）：与 ocr/speech/messages/favorites/history/community/conversations 同一分类器'
      + '（db/pool.ts `isTransientDatabaseError`）与同一条分档注释：瞬时类 true，权限/缺表/缺函数/无法归类 false。',
  },
  {
    file: 'services/api/src/speech/store-pg.ts',
    function: 'classifySpeechDatabaseError',
    retryable: 'isTransientDatabaseError(error)',
    message: '转写数据库暂不可用',
    owner: 'R31',
    reason:
      '**有判据**（合法放宽）：与 ocr/recognitions/messages/favorites/history/community/conversations 同一分类器'
      + '（db/pool.ts `isTransientDatabaseError`）与同一条分档注释：瞬时类 true，权限/缺表/缺函数/无法归类 false。',
  },
  {
    file: 'services/api/src/media/store-pg.ts',
    function: 'classifyMediaDatabaseError',
    retryable: 'isTransientDatabaseError(error)',
    message: '媒体数据库暂不可用',
    owner: 'GY-I06',
    reason:
      '**有判据**（合法放宽）：媒体持久化端口（W12 落库，#6）的数据库异常折叠，与 ocr/speech/recognitions/'
      + 'messages/favorites/history/community/conversations 的 `classify*DatabaseError` 逐条同口径 ——'
      + '57014/55P03 已在上方折成 `PROVIDER_TIMEOUT`；此处 `isTransientDatabaseError`（db/pool.ts）只放行'
      + '08xxx/53xxx/57P0x/40001/40P01，42501/3D000/28P01/42P01/42883 与无法归类一律 false'
      + '（注释原文见 media/store-pg.ts:77）。',
  },
  {
    file: 'services/api/src/privacy/account-deletion.ts',
    function: 'mapReceiptError',
    retryable: 'true',
    message: '回执台账暂不可用',
    owner: 'GY-I22',
    reason:
      '**有判据**（合法放宽）：注销回执台账读写的瞬时类分支（08xxx/53xxx/57P0x/40001/40P01，经 db/pool.ts '
      + '的 `isTransientDatabaseError` 分档）：同一请求稍后重试确实可能成功；同一 `mapReceiptError` 的其余分支'
      + '（G0001⇒INVALID_REQUEST、23505⇒REVISION_CONFLICT、42501/42883/无法归类⇒retryable:false 的 '
      + 'PROVIDER_UNAVAILABLE）均不可重试，与 `deletion-requests-pg.ts::mapDeletionError` 同口径。',
  },
  {
    file: 'services/api/src/admin/ops/content-pg.ts',
    function: 'foldDatabaseError',
    retryable: 'isTransientDatabaseError(error)',
    message: '后台资料库暂不可用',
    owner: 'GY-I18',
    reason:
      '**有判据**（合法放宽）：后台内容/资料域（R34/#18 的 PG 落点）数据库异常折叠，与 ocr/speech/recognitions/'
      + 'messages/favorites/history/community/conversations/media 的 `classify*DatabaseError` 逐条同口径 ——'
      + '57014/55P03 已在上方折成 `PROVIDER_TIMEOUT`（content-pg.ts:101-103 分支）；此处 '
      + '`isTransientDatabaseError`（db/pool.ts）只放行 08xxx/53xxx/57P0x/40001/40P01，'
      + '42501/3D000/28P01/42P01/42883 与无法归类一律 false（即 503 的 retryable 分档与其余域一致）。',
  },
];

/** 条目声明的判据类别（缺省只对 `PROVIDER_UNAVAILABLE` 站点生效）。 */
export const kindsOf = (entry) => entry.kinds ?? ['providerUnavailable'];

/** 一个站点是否命中某条目（`file` + 表达式逐字节 + 可选的函数/消息定位）。 */
export function matchesAllowed(entry, site) {
  if (site.file !== entry.file) return false;
  if (site.retryable !== entry.retryable) return false;
  if (entry.function !== undefined && site.function !== entry.function) return false;
  if (entry.message !== undefined && !site.messages.some((message) => message.includes(entry.message))) {
    return false;
  }
  return true;
}

/** 条目自检：必须有理由与责任片，且至少给一个「表达式之外」的落点（否则同文件多处同表达式会互相顶替）。 */
export function assertEntriesWellFormed(entries) {
  const problems = [];
  for (const entry of entries) {
    const label = `${entry.file} retryable=${entry.retryable}`;
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      problems.push(`白名单条目缺理由：${label}`);
    }
    if (typeof entry.owner !== 'string' || !/^(GY-I\d+|R31)$/.test(entry.owner)) {
      problems.push(`白名单条目缺责任片（owner 须为 GY-Ixx 或 R31）：${label}`);
    }
    if (entry.message === undefined && entry.function === undefined) {
      problems.push(`白名单条目缺定位（message/function 至少给一个）：${label}`);
    }
    for (const kind of kindsOf(entry)) {
      if (kind !== 'providerUnavailable' && kind !== 'fallback') {
        problems.push(`白名单条目 kinds 非法（${String(kind)}）：${label}`);
      }
    }
  }
  return problems;
}

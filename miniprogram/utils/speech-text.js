// GY-I13 播报文本安全闸门与**播报计划复核**（原生小程序侧，纯函数、不触碰 wx / 网络）。
//
// 契约与安全口径（packages/contracts/openapi.json 1.0.0）：
// - 合成域**只接受** `SynthesisInput = { checked_content_ref, locale:'zh-CN' }`，**不接受自由文本**
//   ⇒ 客户端**永远不能**把自己的字符串送去念。
// - 契约 `CheckState = ['passed','blocked']`（`Answer.check_state`）。**只有 `passed` 才允许合成与播报**；
//   `blocked`／未知／缺失一律 fail-closed（不得合成、不得播报、不得"先念了再说"）。
// - 契约没有「已核对内容」读取端点，也没有规定播报文本的读面。本模块因此**不发明**文本来源：
//   它只做两件事——
//     (a) `assertSpeakable()`：合成前/播报前的**统一闸门**（安全检查未过 ⇒ 拒绝，返回可展示的原因）；
//     (b) `verifySpeakPlan()`：对**已经**取得许可的正文做**独立复核**（分段播报时逐段拼接后
//         必须与已核对正文逐字一致，且**数字/单位/制剂条件/否定词**一个都不能丢、不能改）。
//
// 为什么需要 (b)：长正文要分段播报（暂停/继续与朗读上限），分段是最容易「悄悄吃掉一个字」的环节。
// 这里把「拼接后逐字一致」与「关键令牌计数一致」都做成可复核判据，并提供反例。
'use strict'

/** 契约 `CheckState` 闭集（逐项一致，不得扩展）。 */
const CHECK_STATES = ['passed', 'blocked']

/** 契约 `Answer.checked_text` 的 `maxLength`。 */
const MAX_SPEAKABLE_CODE_POINTS = 16000

/** 分段朗读的单段上限（码点数）。**只影响分段，不影响内容**；不截断、不省略。 */
const DEFAULT_SEGMENT_CODE_POINTS = 120

/** 句子边界（分段首选）。含换行，避免把两句话念成一句。 */
const SENTENCE_BOUNDARY = /[。！？；!?;\n]/

/** 句子过长时的次选边界（逗号/顿号/冒号/空格）。 */
const CLAUSE_BOUNDARY = /[，、：,:\s]/

/**
 * 法定剂量单位（按长度倒序匹配，避免 `毫升/亩` 被截成 `毫升`）。
 * 只收录**农业用药与面积**相关单位；这是「单位不得丢失」的判据来源，不是换算表。
 */
const UNIT_WORDS = [
  '毫升/亩', '升/亩', '克/亩', '毫升每公顷', '升每公顷', '克每公顷',
  '毫升', '升', '毫克', '千克', '公斤', '克', '公顷', '亩', '平方米', '倍', 'ppm', '%',
  '袋', '瓶', '包', '片', '粒', '支'
].sort(function (a, b) { return b.length - a.length })

/** 制剂与使用条件词（不得被改写或删除；只做**出现性**核对，不做任何用量判定）。 */
const FORMULATION_WORDS = [
  '乳油', '水剂', '悬浮剂', '可湿性粉剂', '水分散粒剂', '微乳剂', '水乳剂', '悬乳剂', '可溶粉剂',
  '种子处理悬浮剂', '兑水', '稀释', '喷雾', '常规喷雾', '苗后', '苗前', '茎叶处理', '土壤处理',
  '每亩', '亩用量', '生育期', '安全间隔期', '施药', '用药量'
]

/**
 * 否定与禁止词（**最高风险项**：丢掉一个「不得」会把警告念成建议）。
 * 覆盖常见单/双字否定；长词优先匹配以免被短词切碎。
 */
const NEGATION_WORDS = [
  '不得', '不要', '不可', '不能', '不准', '禁止', '严禁', '切勿', '切忌', '避免', '勿', '莫', '忌'
].sort(function (a, b) { return b.length - a.length })

/** 数字（含小数与负号），不吞掉后随单位。 */
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/

function isPlainText(value, max) {
  // 纯空白同样不可播报（不能"念一段空白"就算播报过）。
  return typeof value === 'string' && value.trim().length > 0 && codePointLength(value) <= max
}

function failure(code, reason, extra) {
  return Object.assign({ ok: false, code: code, reason: reason }, extra || {})
}

function codePointLength(value) {
  return [...value].length
}

/** 某个切点是否落在边界字符**之后**（`list` 为码点数组，`index` 为切点）。 */
function boundaryAt(list, index, regex) {
  return index > 0 && index < list.length && regex.test(list[index - 1])
}

/**
 * 把已核对正文切成**无损**的播报分段。
 *
 * 硬保证（可复核）：
 * 1. `segments.join('') === text` —— **不截断、不省略、不插入任何字符**（含首尾空白）；
 * 2. 每段尽量落在句子边界；句子超长再退到从句边界；仍超长则硬切（只切位置，不丢内容）；
 * 3. 空串/非字符串 ⇒ 返回 `[]`（调用方按闸门拒绝，不得静默播报空内容）。
 *
 * @param {string} text 已核对正文
 * @param {number} [maxCodePoints] 单段上限（码点数），默认 120
 * @returns {string[]} 分段（可能为空数组）
 */
function splitForSpeech(text, maxCodePoints) {
  if (typeof text !== 'string' || text.length === 0) return []
  const limit = typeof maxCodePoints === 'number' && Number.isInteger(maxCodePoints) && maxCodePoints > 0
    ? maxCodePoints
    : DEFAULT_SEGMENT_CODE_POINTS
  const characters = [...text]
  if (characters.length <= limit) return [text]
  const segments = []
  let cursor = 0
  while (cursor < characters.length) {
    const remaining = characters.length - cursor
    if (remaining <= limit) {
      segments.push(characters.slice(cursor).join(''))
      break
    }
    let cut = -1
    for (let index = Math.min(cursor + limit, characters.length - 1); index > cursor + 1; index -= 1) {
      if (boundaryAt(characters, index, SENTENCE_BOUNDARY)) { cut = index; break }
    }
    if (cut === -1) {
      for (let index = Math.min(cursor + limit, characters.length - 1); index > cursor + 1; index -= 1) {
        if (boundaryAt(characters, index, CLAUSE_BOUNDARY)) { cut = index; break }
      }
    }
    if (cut === -1) cut = cursor + limit
    segments.push(characters.slice(cursor, cut).join(''))
    cursor = cut
  }
  return segments
}

/** 出现性计数（多重集）：返回 `{ token: count }`，用于逐项比对。 */
function occurrences(text, words) {
  const counts = {}
  for (const word of words) {
    let from = 0
    for (;;) {
      const at = text.indexOf(word, from)
      if (at === -1) break
      counts[word] = (counts[word] || 0) + 1
      from = at + word.length
    }
  }
  return counts
}

/**
 * 抽取正文里的**关键令牌**（安全相关的可复核切片）：
 * - `doses`：`数字 + 单位` 的**绑定对**（如 `30毫升`、`1.5升`、`20%`）——顺序保留，
 *   因此「30 毫升」被念成「3 毫升」或「30 克」都会被发现；
 * - `bareNumbers`：未紧邻单位的数字（同样不得丢失或改写）；
 * - `formulations`：制剂/使用条件词（出现性计数）；
 * - `negations`：否定/禁止词（出现性计数）。
 *
 * 这是**文本一致性**判据，不是用量计算、不做任何换算、不产生任何用药建议。
 */
function criticalTokens(text) {
  const source = typeof text === 'string' ? text : ''
  const doses = []
  const bareNumbers = []
  const pattern = new RegExp(NUMBER_PATTERN.source + '\\s*(?:' + UNIT_WORDS.join('|') + ')', 'g')
  const consumed = []
  let match
  while ((match = pattern.exec(source)) !== null) {
    doses.push(match[0].replace(/\s+/g, ''))
    consumed.push([match.index, match.index + match[0].length])
  }
  const numberPattern = new RegExp(NUMBER_PATTERN.source, 'g')
  while ((match = numberPattern.exec(source)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const insideDose = consumed.some(function (range) { return start >= range[0] && end <= range[1] })
    if (!insideDose) bareNumbers.push(match[0])
  }
  return {
    doses: doses,
    bareNumbers: bareNumbers,
    formulations: occurrences(source, FORMULATION_WORDS),
    negations: occurrences(source, NEGATION_WORDS)
  }
}

/** 多重集比对：返回 `source` 有而 `spoken` 缺/少的项，以及多出来的项。 */
function compareCounts(sourceCounts, spokenCounts, label) {
  const missing = []
  const extra = []
  for (const key of Object.keys(sourceCounts)) {
    const want = sourceCounts[key]
    const got = spokenCounts[key] || 0
    if (got < want) missing.push(label + ' ' + key + '（应有 ' + want + ' 次，实际 ' + got + ' 次）')
    if (got > want) extra.push(label + ' ' + key + '（多出 ' + (got - want) + ' 次）')
  }
  for (const key of Object.keys(spokenCounts)) {
    if (!(key in sourceCounts)) extra.push(label + ' ' + key + '（正文中没有）')
  }
  return { missing: missing, extra: extra }
}

function compareSequences(source, spoken, label) {
  const missing = []
  const extra = []
  const remaining = spoken.slice()
  for (const token of source) {
    const at = remaining.indexOf(token)
    if (at === -1) { missing.push(label + ' ' + token); continue }
    remaining.splice(at, 1)
  }
  for (const token of remaining) extra.push(label + ' ' + token + '（正文中没有）')
  return { missing: missing, extra: extra }
}

/**
 * **播报计划复核**（分段播报的独立闸门）。
 *
 * `spoken` 可以是单个字符串，也可以是分段数组（按顺序拼接）。判定：
 *  1. 拼接结果必须与已核对正文 `checkedText` **逐字一致**（含标点与空白）——不一致即拒绝；
 *  2. 关键令牌（数字/单位绑定对、裸数字、制剂条件词、否定词）**逐项计数一致**——任何丢失/多出即拒绝。
 *
 * 第 1 条已经蕴含第 2 条；第 2 条是**纵深防御**：它给出「到底丢了哪一类令牌」的可读原因，
 * 使得「数字被改写」「单位丢失」「制剂条件丢失」「否定词丢失」各有独立可指出的判据。
 *
 * @returns {{ok:true, text:string, segments:string[]}|{ok:false, code:string, reason:string, missing:string[], extra:string[], segments:string[]}}
 */
function verifySpeakPlan(spoken, checkedText) {
  const segments = Array.isArray(spoken) ? spoken.slice() : (typeof spoken === 'string' ? [spoken] : [])
  const text = segments.join('')
  if (!isPlainText(checkedText, MAX_SPEAKABLE_CODE_POINTS)) {
    return Object.assign(failure('CHECKED_TEXT_UNREADABLE', '已核对正文缺失或超出长度上限，无法播报。'), { missing: [], extra: [], segments: segments })
  }
  if (text === '') {
    return Object.assign(failure('SPOKEN_TEXT_EMPTY', '播报计划为空，拒绝播报。'), { missing: [], extra: [], segments: segments })
  }
  const source = criticalTokens(checkedText)
  const plan = criticalTokens(text)
  const doseDiff = compareSequences(source.doses, plan.doses, '数字/单位')
  const numberDiff = compareSequences(source.bareNumbers, plan.bareNumbers, '数字')
  const formulationDiff = compareCounts(source.formulations, plan.formulations, '制剂/条件')
  const negationDiff = compareCounts(source.negations, plan.negations, '否定词')
  const missing = doseDiff.missing.concat(numberDiff.missing, formulationDiff.missing, negationDiff.missing)
  const extra = doseDiff.extra.concat(numberDiff.extra, formulationDiff.extra, negationDiff.extra)
  if (text !== checkedText || missing.length > 0 || extra.length > 0) {
    const reasons = []
    if (text !== checkedText) reasons.push('播报文本与已核对正文不是逐字一致')
    if (missing.length > 0) reasons.push('关键令牌丢失：' + missing.join('；'))
    if (extra.length > 0) reasons.push('出现正文中没有的关键令牌：' + extra.join('；'))
    return Object.assign(failure('SPOKEN_TEXT_MISMATCH', '播报文本未通过复核：' + reasons.join('；'), { missing: missing, extra: extra }), { segments: segments })
  }
  return { ok: true, text: text, segments: segments }
}

/**
 * **合成与播报的统一闸门**（完整安全检查通过后才允许继续）。
 *
 * 逐项 fail-closed：
 *  1. `checkState` 必须是契约闭集里的 `passed`；`blocked`/未知/缺失 ⇒ `SAFETY_CHECK_BLOCKED`；
 *  2. 已核对正文必须是非空、长度合规的字符串 ⇒ 否则 `CHECKED_TEXT_UNREADABLE`；
 *  3. 待播报文本必须与已核对正文**逐字相同** ⇒ 否则 `TEXT_MISMATCH`（客户端不得自行改写/截断/拼接）。
 *
 * 调用方纪律：本闸门 **不通过 ⇒ 不调用 `POST /speech/synthesis`、不创建播放器**。
 *
 * @param {{checkState:unknown, text:unknown, checkedText:unknown}} input
 */
function assertSpeakable(input) {
  const request = input || {}
  if (CHECK_STATES.indexOf(request.checkState) === -1) {
    return failure('SAFETY_CHECK_BLOCKED', '安全检查未通过（check_state=' + String(request.checkState)
      + '）：未通过核对的内容不得合成、不得播报。', { checkState: request.checkState === undefined ? null : request.checkState })
  }
  if (request.checkState !== 'passed') {
    return failure('SAFETY_CHECK_BLOCKED', '安全检查未通过（check_state=' + String(request.checkState) + '）：该内容被判定为阻断，不得合成、不得播报。',
      { checkState: request.checkState })
  }
  if (!isPlainText(request.checkedText, MAX_SPEAKABLE_CODE_POINTS)) {
    return failure('CHECKED_TEXT_UNREADABLE', '已核对正文缺失或超出长度上限，不得合成、不得播报。', { checkState: 'passed' })
  }
  if (typeof request.text !== 'string' || request.text !== request.checkedText) {
    return failure('TEXT_MISMATCH', '待播报文本与已核对正文不一致：客户端不得改写已核对正文。', { checkState: 'passed' })
  }
  const plan = verifySpeakPlan(splitForSpeech(request.checkedText), request.checkedText)
  if (plan.ok !== true) {
    return failure(plan.code, plan.reason, { checkState: 'passed' })
  }
  return { ok: true, checkState: 'passed', text: plan.text, segments: plan.segments }
}

/** 闸门失败原因 → 页面可展示的一行说明（不改变判定，只做措辞）。 */
function gateMessage(result) {
  const code = result && result.code
  return {
    SAFETY_CHECK_BLOCKED: '安全检查未通过：不能合成，也不会播报。',
    CHECKED_TEXT_UNREADABLE: '没有可播报的已核对正文：已停止。',
    TEXT_MISMATCH: '播报文本与已核对正文不一致：已停止，未播报任何内容。',
    SPOKEN_TEXT_MISMATCH: '播报文本未通过复核（数字／单位／制剂条件／否定词可能丢失）：已停止，未播报任何内容。',
    SPOKEN_TEXT_EMPTY: '播报计划为空：已停止。'
  }[code] || '播报前检查未通过：已停止。'
}

module.exports = {
  CHECK_STATES: CHECK_STATES.slice(),
  MAX_SPEAKABLE_CODE_POINTS: MAX_SPEAKABLE_CODE_POINTS,
  DEFAULT_SEGMENT_CODE_POINTS: DEFAULT_SEGMENT_CODE_POINTS,
  UNIT_WORDS: UNIT_WORDS.slice(),
  FORMULATION_WORDS: FORMULATION_WORDS.slice(),
  NEGATION_WORDS: NEGATION_WORDS.slice(),
  codePointLength: codePointLength,
  splitForSpeech: splitForSpeech,
  criticalTokens: criticalTokens,
  verifySpeakPlan: verifySpeakPlan,
  assertSpeakable: assertSpeakable,
  gateMessage: gateMessage
}

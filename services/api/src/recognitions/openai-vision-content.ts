/**
 * GY-R94 · `openai-vision-v1` 回包正文的**解析阶梯**（纯函数：零 IO、零 token、确定性）。
 *
 * 事故：用生产代码生成请求体、直连供应商连打 120 次，12 次失败**全部**是「HTTP 200 但
 * `message.content` 解析不出 JSON 对象」，连接断类 0 次。其中 7/12 是**结构类**——正文里确实
 * 有候选对象，只是尾巴上多了东西：尾随 `$` / 尾随散文 / 回显的 `{"type":"json_object"}` /
 * 同一对象连吐两遍 / 根是数组 `[{…}]` / 缺最后一个 `}`。整串 `JSON.parse` 对这 7 种一律返回
 * `null`，整次调用于是落进 `PROVIDER_OUTCOME_UNKNOWN`。
 *
 * 阶梯（顺序固定，先严后宽，任何一步成功即返回）：
 * - L1 `content` 整串（```json 围栏由调用方 `parseContentJson` 先剥掉，口径不变）；
 * - L2 从第一个 `{` 起做**字符串感知**的括号配平，取第一个平衡的 JSON 对象：
 *   字符串里的 `{` `}` 不计数，`\` 转义按一个字符跳过（否则 `"reason":"含 } 的说明"` 会被切错）；
 * - L3 根是数组（`[{…}]`）时取**首个元素**；
 * - L4 整串根本没配平时补一个 `}` 再试（**只补一个**，不做任何其它修补）。
 *
 * 边界：这里只负责「把正文里那一段 JSON 找出来」。**信任边界不在这里**——候选仍要过
 * `normalizeOpenAiVisionCandidates` 的闭集过滤与分数夹紧，夹带垃圾最差是 `candidates=[]`
 * ⇒ `uncertain`，不会因为解析器变宽而假成功。
 */

/** 阶梯产出的候选文本（已 trim、去重，顺序即优先级）。空正文返回空数组。 */
export function contentJsonCandidates(text: string): readonly string[] {
  const whole = text.trim();
  if (whole === '') return [];
  const balanced = firstBalancedJsonObject(whole);
  // L4 只在「整串没有配平」时才有意义：配平片段后面补 `}` 只会是垃圾。
  if (balanced === null) return [whole, `${whole}}`];
  return balanced === whole ? [whole] : [whole, balanced];
}

/**
 * 从第一个 `{` 起取**第一个括号平衡**的子串（字符串感知）。
 *
 * 找不到 `{`、或读到结尾仍未配平 ⇒ `null`（后者交给 L4 补 `}` 再试）。
 */
export function firstBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * 一段候选文本 → JSON 对象；根是数组时取首元素（L3）。
 *
 * 只要「对象」，不要标量/数组：`null`、数字、`[1,2]` 一律视为没解析出来。
 */
export function parseVisionJsonObject(candidate: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * 失败归因用的三项**结构读数**：`finish_reason` / `completion_tokens` / `content.length`。
 *
 * ⛔ 绝不返回 `message.content` 正文：观测只回答「是预算被打断，还是结构没读懂」。
 * `finish_reason === 'length'` ⇒ 预算类；`'stop'` 且 `contentLength > 0` ⇒ 结构类。
 */
export function readVisionContentDiagnostics(
  root: Record<string, unknown> | null,
  choice: unknown,
  content: unknown,
): { finishReason: string | null; completionTokens: number | null; contentLength: number | null } {
  const finishReason = choice !== null && typeof choice === 'object' ? (choice as Record<string, unknown>)['finish_reason'] : null;
  const usage = root === null ? null : root['usage'];
  const completionTokens = usage !== null && typeof usage === 'object' ? (usage as Record<string, unknown>)['completion_tokens'] : null;
  return {
    finishReason: typeof finishReason === 'string' ? finishReason : null,
    completionTokens: typeof completionTokens === 'number' && Number.isFinite(completionTokens) ? completionTokens : null,
    contentLength: typeof content === 'string' ? content.length : null,
  };
}

/**
 * GY-R28 W7（#12）· 文字问答的**真实模型适配器**（`/conversations` 的「生成侧」唯一实现）。
 *
 * ## 为什么在这里、而不是在 `conversations/**`
 * 问答域只认识端口（`AnswerComposer`），不认识供应商：`conversations/**` 里的任何一行都不得
 * 出现 endpoint / model / 请求头 / 重试语义。供应商细节全部收在本文件 + `./error-map.ts`，
 * 由装配层（`services/api/src/app.ts`）按配置注入。⇒ 删掉 `app.ts` 的注入行，问答立刻回到
 * 基线的确定性回答器（`unimplemented:no-real-` 版本串），**不需要**改域内任何代码。
 *
 * ## 三条硬边界（与守卫的分工）
 * 1. **引用只能取自本次检索集合**：模型只能按提示里的编号 `[n]` 指认来源；本适配器把 `[n]`
 *    再映射回 `set.items[n-1].source` **原对象**。模型正文里出现的其他任何来源表述都不进
 *    `citations`；守卫（`AnswerGuard`）仍会逐字段复核，越界即 `blocked`。
 *    正文本身同样受约束（`bodyViolationsOf`）：正文里出现越界编号或未被检索集合背书的链接时，
 *    **整条正文不交付**（回空正文 + `text_violations` ⇒ 守卫阻断），而不是「丢掉结构、正文照发」。
 * 2. **用量卡不来自模型**：`dose_cards` 恒为 `[]` —— 用量只能来自域库确定性权威路径，
 *    语言模型的数字没有判定资格。
 * 3. **无依据不外发**：检索集合为空/null 时**根本不调用模型**（省掉一次无意义的付费外发），
 *    直接回空候选 ⇒ 守卫按既有「资料不足」路径如实置 `insufficient`。
 *
 * ## 外发记账（reserve-then-send）
 * 真正发请求之前必须经 `ChatEgress.send`：预留 → 执行前重查 → `markSent` → 外发 → 保存前重查。
 * 未接账本 / 非 `real` 模式 ⇒ `send` 直接拒绝（`PROVIDER_UNAVAILABLE`），**不存在无账外发**。
 * 请求失败 ⇒ 预留置 `failed`（**不**写回写表、**不**记成功用量）。
 *
 * ## 不回显
 * 日志/账本只收结构 token（状态码、耗时、token 数、出口记录 id、失败形态）；
 * **不**收响应正文、**不**收提问正文、**不**收密钥或任何请求头。
 */
import type { AnswerComposer, AnswerEgressContext, ComposedCandidate } from '../conversations/service.ts';
import type { ContextTurn } from '../conversations/context.ts';
import { groundedUrlsOf, urlsInText, type RetrievalItem } from '../conversations/guard.ts';
import type { SourceRef } from '../conversations/types.ts';
import type { ChatProviderConfig } from '../config.ts';
import type { ChatEgress } from '../privacy/task-egress.ts';
import { ApiError } from '../errors.ts';
import { chatApiError, chatFailure, chatFailureForStatus, chatFailureForThrown } from './error-map.ts';

/** 送给模型的来源条数上限（控制单次外发的输入体积；权威判据仍是守卫）。 */
export const CHAT_MAX_SOURCES = 6;
/** 每条来源正文的截断长度（字符）。 */
export const CHAT_SOURCE_BODY_CHARS = 400;
/** 问题正文的截断长度（字符）——异常长的问题不放大外发体积。 */
export const CHAT_QUESTION_CHARS = 1000;
/** 模型回答的保留长度上限（契约 `checked_text` 上限 16000；此处更保守）。 */
export const CHAT_ANSWER_CHARS = 4000;
/** 追问上下文的条数与单条长度（只用于「这是追问」的标注，不用于扩引用）。 */
export const CHAT_HISTORY_TURNS = 4;
export const CHAT_HISTORY_CHARS = 200;

/** 版本串（契约 `maxLength 80`；**不带** `unimplemented:no-real-` 前缀 —— 这是真实模型的机器可判据）。 */
export const CHAT_MODEL_VERSION_PREFIX = 'model/';
export const CHAT_PROMPT_VERSION = 'prompt/citation-bind/1';

/**
 * 真实模型路径的 `model_version`（契约 `maxLength 80`）。
 *
 * **由装配层调用**，不回答器自报：版本串写进回答行是服务层的职责，回答器（可被任意注入）
 * 结构上拿不到这条通路 —— 这样「替身把自己标成真实模型」在结构上不可能（NC2 性质保持）。
 */
export function chatModelVersion(model: string): string {
  return clip(CHAT_MODEL_VERSION_PREFIX + model + '#live-1', 80);
}

export interface ChatLiveLog {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface LiveChatComposerDeps {
  profile: ChatProviderConfig;
  egress: ChatEgress;
  /** 注入点（测试/取证脚本用）；缺省 `globalThis.fetch`。 */
  fetchImpl?: typeof fetch;
  log?: ChatLiveLog;
  now?: () => Date;
}

/** 单次外发的观测读数（只含结构信息；用于日志与取证，不含正文）。 */
export interface ChatCallReading {
  status: number | null;
  duration_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  attempts: number;
  outcome: 'answered' | 'no_sources' | 'failed';
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** 按**字符**截断（不是 UTF-16 码元）；省略号也计入上限，保证结果长度 ≤ `max`。 */
function clip(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** 把检索条目渲染成「编号 + 来源 + 正文」的提示片段（正文截断，不含用户身份）。 */
export function renderSources(items: readonly RetrievalItem[]): { block: string; used: readonly RetrievalItem[] } {
  const used = items.slice(0, CHAT_MAX_SOURCES);
  const block = used
    .map((item, index) => {
      const head = `[${index + 1}] ${item.title}（${item.source.publisher} / ${item.source.source_kind}）`;
      const body = clip(item.body ?? '', CHAT_SOURCE_BODY_CHARS).replace(/\s+/g, ' ').trim();
      return `${head}\n${body}`;
    })
    .join('\n\n');
  return { block, used };
}

/**
 * 正文层面的越界自检（**输出前**的硬判据；返回空数组才算正文可用）。
 *
 * 两条判据，与守卫核对结构化 `citations` 是同一纪律，只是作用在正文文本上：
 * 1. 正文里每个 `[n]` 都必须落在本次送出的条目范围 `1..used.length` 内（`[0]`/`[99]` 一律越界）；
 * 2. 正文里每个 URL 都必须被本次检索集合背书（来源自带 `url`，或逐字出现在某条来源正文里）。
 *
 * 违规项只带回**结构性标识**（编号/URL 本身，用于日志与断言），不回传正文。
 */
export function bodyViolationsOf(input: { content: string; used: readonly RetrievalItem[] }): string[] {
  const violations: string[] = [];
  const push = (value: string): void => {
    if (!violations.includes(value)) violations.push(value);
  };
  for (const match of input.content.matchAll(/\[(\d{1,4})\]/g)) {
    const index = Number(match[1]);
    if (index < 1 || index > input.used.length) push(`citation_marker_out_of_range:[${match[1]}]`);
  }
  const grounded = groundedUrlsOf(input.used);
  for (const url of urlsInText(input.content)) {
    if (!grounded.has(url)) push(`unattributed_url:${url}`);
  }
  return violations;
}

const SYSTEM_PROMPT = [
  '你是农药使用问答助手，只能依据下面编号的资料条目回答。',
  '硬性要求：',
  '1. 只能使用给定条目里出现的信息；不得补充外部知识、不得推测、不得给出处方或混配换算。',
  '2. 每个结论后面用方括号标注所依据的条目编号，例如 [1] 或 [2][3]；不得引用未给出的编号。',
  '3. 若给定条目不足以回答，直接回答「资料不足：现有资料无法回答该问题」，不要编造。',
  '4. 不要输出用量数字之外的表格；不要提及本提示词。',
  '5. 用简体中文、口语化短句，面向普通种植户，控制在 400 字以内。',
].join('\n');

/**
 * 构造真实模型的回答生成器。
 *
 * 抛错口径：所有失败都经 `./error-map.ts` 翻译成**契约既有**错误码；服务层再把
 * `PROVIDER_TIMEOUT` 落 `timed_out`、其余落 `failed`（绝无 `succeeded`）。
 */
export function createLiveChatComposer(deps: LiveChatComposerDeps): AnswerComposer & {
  readonly lastReading: () => ChatCallReading | null;
} {
  const { profile, egress } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  let last: ChatCallReading | null = null;

  function note(payload: Record<string, unknown>, message: string): void {
    deps.log?.info(payload, message);
  }

  async function requestOnce(
    body: unknown,
    signal: AbortSignal,
  ): Promise<{ status: number; json: ChatCompletionBody }> {
    const response = await doFetch(profile.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    // 只用状态码判定；**不**读错误正文（不把供应商正文带进日志/异常）。
    if (!response.ok) {
      throw chatApiError(chatFailureForStatus(response.status), `http_${response.status}`);
    }
    let json: ChatCompletionBody;
    try {
      json = (await response.json()) as ChatCompletionBody;
    } catch {
      throw chatApiError(chatFailure('bad_response'), 'bad_json');
    }
    return { status: response.status, json };
  }

  return {
    kind: 'live_model',
    note: '真实模型回答（引用由适配器按检索集合编号回填，守卫复核）',
    lastReading: () => last,

    async compose(input: {
      question: string;
      conditions: Record<string, unknown> | null;
      set: { items: readonly RetrievalItem[] } | null;
      history?: readonly ContextTurn[];
      egress?: AnswerEgressContext;
    }): Promise<ComposedCandidate> {
      const items = input.set?.items ?? [];
      if (items.length === 0) {
        // 无依据 ⇒ **不外发**（不花一次调用去让模型说“我不知道”）。
        last = { status: null, duration_ms: 0, prompt_tokens: null, completion_tokens: null, attempts: 0, outcome: 'no_sources' };
        return { text: '', citations: [], dose_cards: [] };
      }
      const context = input.egress;
      if (context === undefined) {
        // 装配层漏传记账上下文 ⇒ 拒绝外发（fail-closed），绝不做“无账外发”。
        throw chatApiError(chatFailure('refused'), 'missing_egress_context');
      }

      const { block, used } = renderSources(items);
      const history = (input.history ?? []).slice(-CHAT_HISTORY_TURNS);
      const historyNote =
        history.length === 0
          ? ''
          : `\n\n追问上下文（只用于判断「这是追问」，不得据此扩引用）：\n${history
              .map((turn) => `- 用户：${clip(turn.question ?? '', CHAT_HISTORY_CHARS)}`)
              .join('\n')}`;
      const userContent = `资料条目：\n${block}\n\n问题：${clip(input.question, CHAT_QUESTION_CHARS)}${historyNote}`;

      const body = {
        model: profile.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        // 确定性优先：温度 0，且不请求流式（一次一结算，便于记账）。
        temperature: 0,
        stream: false,
        max_tokens: 800,
      };

      const started = Date.now();
      let attempts = 0;
      let status: number | null = null;

      /**
       * 一次逻辑外发（含允许的重试）。**只在 `egress.send` 的 `call` 里跑** ——
       * 这样"是否已记账"与"是否已发请求"由同一处代码保证先后，不存在绕过记账的旁路。
       */
      async function dispatchOnce(): Promise<ChatCompletionBody> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
        try {
          // 重试**只**发生在「供应商明确拒绝且未产出 token」的形态（429 / 5xx）：
          // 超时与传输中断可能已在供应商侧计费，**不重试**（避免重复计费与重复外发）。
          for (let attempt = 0; attempt <= profile.maxRetries; attempt += 1) {
            attempts += 1;
            try {
              const result = await requestOnce(body, controller.signal);
              status = result.status;
              return result.json;
            } catch (error) {
              // 非 `ApiError`（fetch 自身抛的 TypeError/AbortError）先归一成契约码。
              const normalized =
                error instanceof ApiError ? error : chatApiError(chatFailureForThrown(error), 'fetch_failed');
              // 只重试「供应商明确拒绝、未产出 token」的形态（429 / 5xx）；超时与传输中断不重试
              // （可能已计费，重试等于重复外发）。
              const retryableShape =
                normalized.code === 'PROVIDER_QUOTA_EXCEEDED' ||
                (normalized.code === 'PROVIDER_UNAVAILABLE' && normalized.retryable === true);
              if (retryableShape && attempt < profile.maxRetries) continue;
              throw normalized;
            }
          }
          // 循环必有出口（`attempt <= maxRetries` 至少跑一次，且每次都要么 return 要么 throw）。
          throw chatApiError(chatFailure('bad_response'), 'unreachable');
        } finally {
          clearTimeout(timer);
        }
      }

      let parsed: ChatCompletionBody;
      try {
        // **reserve-then-send**：预留 → 执行前重查 → `markSent` → 真正外发 → 保存前重查/写回。
        // 账本只收结构分类 token（`outcomeOf`），正文与用量一律不进账本（见 task-egress 的注释）。
        parsed = await egress.send({
          userId: context.userId,
          authEpoch: context.authEpoch,
          objectId: context.objectId,
          objectRevision: context.objectRevision,
          call: dispatchOnce,
          outcomeOf: () => ({ kind: 'answered' }),
        });
      } catch (error) {
        // 失败读数同样只含结构信息（状态码/耗时/尝试次数/模型名），供取证与告警。
        last = {
          status,
          duration_ms: Date.now() - started,
          prompt_tokens: null,
          completion_tokens: null,
          attempts,
          outcome: 'failed',
        };
        deps.log?.warn(
          { status, duration_ms: last.duration_ms, attempts, model: profile.model },
          '问答真实模型外发失败（只记结构读数，不含正文/密钥）',
        );
        throw error;
      }

      const duration = Date.now() - started;
      const choice = parsed.choices?.[0];
      const content = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
      if (content.length === 0) {
        // 200 但没有可用正文：**不**把它当"成功但空回答"（那会掩盖供应商改形状）。
        last = {
          status,
          duration_ms: duration,
          prompt_tokens: null,
          completion_tokens: null,
          attempts,
          outcome: 'failed',
        };
        throw chatApiError(chatFailure('bad_response'), 'empty_content');
      }
      const usage = parsed.usage ?? {};
      const prompt_tokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
      const completion_tokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;

      // 正文自检（**先**做，早于结构化引用回填）：正文里越界的编号/未检索链接一律记违规。
      // 只把违规从 citations 里丢掉、正文照发，等于让集合外引用/虚构链接直接出给用户 —— 返修要点。
      const violations = bodyViolationsOf({ content, used });

      // 引用回填：只认 [n] 编号，且 n 必须在本次送出的条目范围内。
      const citations: SourceRef[] = [];
      const seen = new Set<string>();
      for (const match of content.matchAll(/\[(\d{1,2})\]/g)) {
        const index = Number(match[1]);
        const item = used[index - 1];
        if (item === undefined) continue;
        const source = item.source;
        if (seen.has(source.id)) continue;
        seen.add(source.id);
        citations.push(source);
      }

      last = {
        status,
        duration_ms: duration,
        prompt_tokens,
        completion_tokens,
        attempts,
        outcome: 'answered',
      };
      note(
        {
          status,
          duration_ms: duration,
          prompt_tokens,
          completion_tokens,
          attempts,
          sources: used.length,
          citations: citations.length,
          text_violations: violations.length,
          model: profile.model,
        },
        '问答真实模型外发完成（只记结构读数，不含正文/密钥）',
      );

      if (violations.length > 0) {
        // 正文含集合外编号/未检索链接 ⇒ **不交付正文**（空正文交守卫按"越界"整条阻断）。
        // 注意顺序：这里不产出"洗掉结构、正文照发"的候选 —— 那正是监工 [P1] 指出的路。
        deps.log?.warn(
          { violations: violations.length, model: profile.model },
          '问答正文含超出检索集合的编号或链接：正文不交付，交守卫阻断（只记条数，不含正文）',
        );
        return { text: '', citations, dose_cards: [], text_violations: violations };
      }

      const text = clip(content, CHAT_ANSWER_CHARS);
      return { text, citations, dose_cards: [] };
    },
  } as AnswerComposer & { readonly lastReading: () => ChatCallReading | null };
}

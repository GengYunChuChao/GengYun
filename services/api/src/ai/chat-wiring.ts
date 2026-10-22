/**
 * GY-R28 W7（#12）· 问答「接不接真实模型」的**装配决策**（纯函数，无 IO）。
 *
 * 抽出来的理由：这条决策有四个与门（配置 / 账本 / 执行模式 / 注入覆盖），其中「账本可用」在
 * 生产上依赖真实 PG 池 —— 若把决策写在 `app.ts` 里，这条分支就只能靠"起一个真 PG"来证明，
 * 而它恰恰是**审计断裂时最不能出错**的一条。把它做成纯函数后，四个与门都能在单测里逐条证伪，
 * `app.ts` 只剩下"取依赖 → 调用 → 用结果"。
 *
 * 语义（与 `app.ts` 的注释、证据页逐条对应）：
 * - `injected`：测试/装配注入了回答器 ⇒ 一律用注入的那一个，且**不给**版本串覆盖
 *   （注入者不得把自己标成真实模型，NC2）。
 * - `deterministic`：`chat === null`，或账本不可用，或执行模式非 `real` ⇒ 基线确定性回答器，
 *   版本串全部带 `unimplemented:no-real-`，**与 main 逐字节一致**。后两种情况下 `warning` 非空
 *   （配了模型却接不上账本，必须留痕，不能静默降级成"看起来什么都没配"）。
 * - `live`：四个与门全开 ⇒ 真实模型适配器 + 装配层拥有的版本串（`model/…` + `prompt/…`）。
 */
import type { ExecutionMode } from '../contract.ts';
import type { ChatProviderConfig } from '../config.ts';
import type { AnswerComposer } from '../conversations/service.ts';
import { createDeterministicAnswerComposer } from '../conversations/service.ts';
import { createChatEgress, type ChatEgress } from '../privacy/task-egress.ts';
import { CHAT_PROMPT_VERSION, chatModelVersion, createLiveChatComposer, type ChatLiveLog } from './chat-live-adapter.ts';

/** 外发账本的两个依赖（形状取自 `createChatEgress`，不另抄一份类型）。 */
type ChatEgressDeps = Parameters<typeof createChatEgress>[0];
export type ChatLedgerLike = ChatEgressDeps['ledger'];
export type ChatInFlightLike = ChatEgressDeps['inFlight'];

export interface ConversationChatPlanInput {
  /** 注入覆盖（测试/装配）；给了就完全不管配置与账本。 */
  injectedComposer?: AnswerComposer;
  chat: ChatProviderConfig | null;
  executionMode: ExecutionMode;
  egressLedger: ChatLedgerLike | null;
  privacyInFlight: ChatInFlightLike | null;
  log?: ChatLiveLog;
  /** 注入点（受控取证脚本/测试用）；缺省用 `globalThis.fetch`。 */
  fetchImpl?: typeof fetch;
}

export interface ConversationChatPlan {
  mode: 'injected' | 'deterministic' | 'live';
  composer: AnswerComposer;
  /** 只有 `live` 才给；其余情况 `undefined` ⇒ 服务层回落基线常量串。 */
  answerVersions?: { model: string; prompt: string };
  /** `live` 时的外发口（`engaged === true`）；其余情况 null。 */
  egress: ChatEgress | null;
  /** 必须写进日志的警告（装配层逐条 `log.warn`）。 */
  warnings: string[];
}

export function planConversationChat(input: ConversationChatPlanInput): ConversationChatPlan {
  if (input.injectedComposer !== undefined) {
    return { mode: 'injected', composer: input.injectedComposer, egress: null, warnings: [] };
  }
  if (input.chat === null) {
    return { mode: 'deterministic', composer: createDeterministicAnswerComposer(), egress: null, warnings: [] };
  }
  if (input.egressLedger === null || input.privacyInFlight === null) {
    return {
      mode: 'deterministic',
      composer: createDeterministicAnswerComposer(),
      egress: null,
      // 配了模型却接不上账本：**不**外发（审计断裂时宁可不出真实回答），但要留痕。
      warnings: ['GY-R28 W7 问答真实模型未接管：外发账本不可用（无 DATABASE_URL 或池不支持事务），回答沿用确定性回答器'],
    };
  }
  const egress = createChatEgress({
    ledger: input.egressLedger,
    inFlight: input.privacyInFlight,
    executionMode: input.executionMode,
    // 资料类型闭集里唯一的非媒体成员；其必需用途恰为 `external_inference`（packages/privacy/constants.mjs）。
    dataType: 'checked_content',
    capability: 'llm',
  });
  if (!egress.engaged) {
    return {
      mode: 'deterministic',
      composer: createDeterministicAnswerComposer(),
      egress: null,
      // 非 `real` 模式：装配可以就位，但外发口不接管（演示/替身模式不该产生真实外发）。
      warnings: [],
    };
  }
  return {
    mode: 'live',
    composer: createLiveChatComposer({
      profile: input.chat,
      egress,
      ...(input.log === undefined ? {} : { log: input.log }),
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    }),
    // 版本串由装配层拥有（回答器无权决定，见 `ConversationServiceDeps.answerVersions`）。
    answerVersions: { model: chatModelVersion(input.chat.model), prompt: CHAT_PROMPT_VERSION },
    egress,
    warnings: [],
  };
}

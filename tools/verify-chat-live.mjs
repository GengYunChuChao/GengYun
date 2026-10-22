// GY-R28 W7（#12）· 文字问答真实模型的**受控取证脚本**（默认只做预检，不发任何请求）。
//
// 设计原则（与 `tools/verify-llm-live.mjs` 同口径，但只覆盖问答这一条路径）：
//   * **默认零外发**：不带 `--approved` 时只打印"还缺什么"，一行请求都不发（exit 2）；
//   * **先记账后外发**：真实调用一律经 `createChatEgress`（预留 → 执行前重查 → `markSent` → 外发
//     → 保存前重查/写回）；没有外发账本（无 `DATABASE_URL`）⇒ 拒绝运行，绝不无账外发；
//   * **最多 2 次**：本脚本自己数尝试次数，超过即停（付费验证需用户单独授权，见 AGENTS.md）；
//   * **输入全部是仓库内合成物**：问题与资料条目都写死在下面，不含任何真实用户数据；
//   * **不回显**：不打印密钥、不打印请求头、不打印完整响应正文（只打印长度与结构读数）。
import { loadConfig } from '../services/api/src/config.ts';
import { createLiveChatComposer } from '../services/api/src/ai/chat-live-adapter.ts';
import { createChatEgress } from '../services/api/src/privacy/task-egress.ts';
import { createPostgresExportLedger, createPostgresPrivacyPorts } from '../services/api/src/privacy/ledger-pg.ts';
import { createInFlightGuard } from '../packages/privacy/in-flight.mjs';

/** 受控取证的上限（派单：最多 2 次成功调用）。 */
export const MAX_PAID_CALLS = 2;
/** 官方人民币价（每 token，峰值档；2026-10-08 核对 `api-docs.deepseek.com/zh-cn/quick_start/pricing/`）。 */
export const CNY_PER_TOKEN_PEAK = Object.freeze({ input: 2 / 1e6, output: 8 / 1e6 });

/** 固定合成问题（仓库内既有合成口径；不是任何真实用户提问）。 */
const SYNTHETIC_QUESTION = '合成资料里的稗草叶片有什么特征？只依据给到的条目回答。';

/** 固定合成检索条目（形状与 `conversation-fixtures.mjs` 的 `retrievalItem` 一致）。 */
const SYNTHETIC_ITEMS = Object.freeze([
  {
    id: '2c0d4a30-6d9b-4f5b-9d70-5c1b2b0a7f11',
    revision: 1,
    type: 'herbicide',
    title: '合成资料甲：稗草的识别（取证用合成条目）',
    body: '合成正文：稗草叶片光滑无毛、无叶舌叶耳；本段为取证用合成内容，不含真实用量建议。',
    source: {
      id: '2c0d4a30-6d9b-4f5b-9d70-5c1b2b0a7f11',
      version: 'synthetic-source-2026.10',
      title: '合成资料甲：稗草的识别（取证用合成条目）',
      url: 'https://example.invalid/gengyun/synthetic-echinochloa',
      publisher: '合成发布方（测试替身）',
      source_kind: 'verified_seed',
      evidence_kind: 'mixed',
      validity: 'valid',
      review_status: 'unverified',
      updated_at: '2026-10-14T00:00:00.000Z',
    },
    raw: { item_id: '2c0d4a30-6d9b-4f5b-9d70-5c1b2b0a7f11', kind: 'herbicide', usable_as_dose: false, card_ready: false },
  },
]);

/** 预检：列出缺什么（绝不打印值，只打印"是否已给"）。 */
export function preflight(env) {
  const missing = [];
  if (!env.CHAT_LLM_ENDPOINT) missing.push('CHAT_LLM_ENDPOINT');
  if (!env.CHAT_LLM_MODEL) missing.push('CHAT_LLM_MODEL');
  if (!env.CHAT_LLM_API_KEY && !env.DEEPSEEK_API_KEY) missing.push('CHAT_LLM_API_KEY 或 DEEPSEEK_API_KEY');
  if (!env.DATABASE_URL) missing.push('DATABASE_URL（外发账本；缺它一律不外发）');
  if (!env.GENGYUN_CHAT_LIVE_USER_ID) missing.push('GENGYUN_CHAT_LIVE_USER_ID（已授予 external_inference 的合成账号）');
  if (!env.GENGYUN_CHAT_LIVE_AUTH_EPOCH) missing.push('GENGYUN_CHAT_LIVE_AUTH_EPOCH');
  if (!env.GENGYUN_CHAT_LIVE_TURN_ID) missing.push('GENGYUN_CHAT_LIVE_TURN_ID（轮次 uuid，仅用于 object_key）');
  if (!env.GENGYUN_CHAT_LIVE_TURN_REVISION) missing.push('GENGYUN_CHAT_LIVE_TURN_REVISION');
  return { ready: missing.length === 0, missing };
}

function priceOf(promptTokens, completionTokens) {
  const input = Number.isInteger(promptTokens) ? promptTokens : 0;
  const output = Number.isInteger(completionTokens) ? completionTokens : 0;
  return Number((input * CNY_PER_TOKEN_PEAK.input + output * CNY_PER_TOKEN_PEAK.output).toFixed(6));
}

async function main() {
  const approved = process.argv.includes('--approved');
  const env = process.env;
  const gate = preflight(env);
  if (!gate.ready) {
    // 预检不通过 ⇒ 零外发。这是**负控制**读数：护栏在缺任何一项时都不放行。
    console.log(JSON.stringify({ mode: 'preflight', ready: false, missing: gate.missing, sent: 0 }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (!approved) {
    console.log(JSON.stringify({ mode: 'preflight', ready: true, missing: [], sent: 0, note: '预检通过；真实调用需显式 `--approved`（付费验证须用户单独授权）' }, null, 2));
    process.exitCode = 0;
    return;
  }

  // 配置解析：与线上同一份 `loadConfig`（真实模式下的其余必需项由部署环境提供）。
  const config = loadConfig({ ...env, APP_EXECUTION_MODE: env.APP_EXECUTION_MODE ?? 'stub' });
  if (config.chatProvider === null) {
    console.log(JSON.stringify({ mode: 'approved', ready: false, reason: 'chatProvider 解析为 null', sent: 0 }, null, 2));
    process.exitCode = 2;
    return;
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const ledger = createPostgresExportLedger({ pool });
  const ports = createPostgresPrivacyPorts({ pool });
  const inFlight = createInFlightGuard({ ledger, account: ports.account, consentStore: ports.consentStore });
  const egress = createChatEgress({ ledger, inFlight, executionMode: 'real', dataType: 'checked_content', capability: 'llm' });

  const composer = createLiveChatComposer({ profile: config.chatProvider, egress });
  const readings = [];
  for (let call = 1; call <= MAX_PAID_CALLS; call += 1) {
    const started = Date.now();
    try {
      const candidate = await composer.compose({
        question: SYNTHETIC_QUESTION,
        conditions: null,
        set: { user_id: env.GENGYUN_CHAT_LIVE_USER_ID, items: SYNTHETIC_ITEMS, note: '取证脚本内置合成集合' },
        egress: {
          userId: env.GENGYUN_CHAT_LIVE_USER_ID,
          authEpoch: Number(env.GENGYUN_CHAT_LIVE_AUTH_EPOCH),
          objectId: env.GENGYUN_CHAT_LIVE_TURN_ID,
          objectRevision: Number(env.GENGYUN_CHAT_LIVE_TURN_REVISION),
        },
      });
      const reading = composer.lastReading();
      readings.push({
        call,
        outcome: 'answered',
        status: reading?.status ?? null,
        duration_ms: Date.now() - started,
        prompt_tokens: reading?.prompt_tokens ?? null,
        completion_tokens: reading?.completion_tokens ?? null,
        attempts: reading?.attempts ?? null,
        citations: candidate.citations.length,
        // 正文长度，不打印正文本身。
        answer_chars: [...candidate.text].length,
        cost_cny_peak: priceOf(reading?.prompt_tokens, reading?.completion_tokens),
      });
    } catch (error) {
      readings.push({ call, outcome: 'failed', code: error?.code ?? 'UNSPECIFIED', duration_ms: Date.now() - started, cost_cny_peak: 0 });
      break;
    }
  }
  await pool.end();
  console.log(JSON.stringify({ mode: 'approved', endpoint_configured: true, model: config.chatProvider.model, readings }, null, 2));
}

main().catch(() => {
  // 错误详情一律不外泄（可能含端点/凭据线索）。
  console.error('问答真实调用取证中止：凭据与错误详情已抑制。');
  process.exitCode = 1;
});

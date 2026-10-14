/**
 * GY-I14（#14）审核 HTTP 装配片 · **不可绕过守卫**（派单 §2.5 / AC08）。
 *
 * 三条硬红线，本文件用**结构性手段**落实（不是文档承诺）：
 *   1) **AI/模型不授权限**：模型/供应商回报里出现任何控制类字段
 *      （角色、scope、权限、owner、epoch、可见性、发布、决策、专家认证、人审结论、票决、训练开关）
 *      ⇒ 整条回报**拒绝**（按 fail-closed 归类为形状不可信 ⇒ 隔离），
 *      **不是静默丢弃**：静默丢弃会让"模型试图提权"这一事实消失。
 *   2) **不得改来源**：目标的内容来源（`source_kind` ∈ database | verified_seed | simulation）只能由
 *      资料/人工链路写；审核前后必须逐字节一致，`assertSourceUnchanged` 是判据。
 *   3) **不得标"专家已审"**：首版**没有**人工审核队列，人审入口是**空态**
 *      （`HUMAN_REVIEW_STATE = 'under_construction'`，取自契约 `Home.human_review_state` 的 const）。
 *      公众票决同样**不进入首版**（`PUBLIC_VOTE_ENABLED === false`）。
 *
 * 隐私：本文件只按**键名**判定，不读取、不回显任何值（拒绝原因里也不带原文）。
 */
import { HUMAN_REVIEW_STATE, MODEL_FORBIDDEN_CONTROL_FIELDS, PUBLIC_VOTE_ENABLED } from './types.ts';

/** 命中黑名单字段时的闭集原因码（非契约错误码；写进结论的 `reason_codes` 需为 1..80 字符串）。 */
export const MODEL_CONTROL_FIELD_FORBIDDEN = 'MODEL_CONTROL_FIELD_FORBIDDEN';
/** 来源被改动（审核不得改来源）。 */
export const SOURCE_CHANGED_BY_MODEL = 'SOURCE_CHANGED_BY_MODEL';
/** 试图标注"专家已审"（首版没有人审）。 */
export const EXPERT_REVIEW_NOT_AVAILABLE = 'EXPERT_REVIEW_NOT_AVAILABLE';

export interface ForbiddenFieldHit {
  /** 命中的键名（原样，便于审计定位；键名本身不是敏感数据）。 */
  field: string;
  /** 命中的路径（`a.b.c`，不含任何值）。 */
  path: string;
  code: string;
}

export interface ForbiddenFieldScan {
  ok: boolean;
  hits: ForbiddenFieldHit[];
  reason_codes: string[];
}

const FORBIDDEN = new Set(MODEL_FORBIDDEN_CONTROL_FIELDS.map((field) => field.toLowerCase()));

/** 扫描深度上界：模型回报是浅层 JSON；超深结构一律视为不可信并停止遍历。 */
const MAX_DEPTH = 6;
/** 扫描过的键数上界：超限**不得**当作"干净"（未检查 ≠ 干净）。 */
const MAX_KEYS = 512;

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * 递归扫描外部回报里的控制类字段。
 *
 * 关闭口径（**很关键**）：
 *   - 键数或深度超过上界 ⇒ `ok: false` + `SCAN_LIMIT_EXCEEDED`
 *     （**未检查 ≠ 干净**，与规则层"扫描限额是 fail-closed 闸门"同口径）；
 *   - 任何 getter 抛错 ⇒ `ok: false`（读不出来的结构不可信）。
 */
export function scanForbiddenControlFields(value: unknown): ForbiddenFieldScan {
  const hits: ForbiddenFieldHit[] = [];
  const reason_codes: string[] = [];
  let visitedKeys = 0;
  let limitExceeded = false;

  const push = (field: string, path: string, code: string): void => {
    if (!reason_codes.includes(code)) reason_codes.push(code);
    hits.push({ field, path, code });
  };

  const visit = (node: unknown, path: string, depth: number): void => {
    if (limitExceeded) return;
    if (depth > MAX_DEPTH) {
      limitExceeded = true;
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        if (visitedKeys >= MAX_KEYS || limitExceeded) break;
        visit(node[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    let keys: string[];
    try {
      keys = Object.keys(node as Record<string, unknown>);
    } catch {
      // 读不出 ownKeys（Proxy 等）⇒ 不可信，直接判违规而不是"没找到"。
      push('<unreadable>', path, MODEL_CONTROL_FIELD_FORBIDDEN);
      return;
    }
    for (const key of keys) {
      visitedKeys += 1;
      if (visitedKeys > MAX_KEYS) {
        limitExceeded = true;
        return;
      }
      const normalized = normalizeKey(key);
      if (FORBIDDEN.has(normalized)) {
        push(key, path === '' ? key : `${path}.${key}`, MODEL_CONTROL_FIELD_FORBIDDEN);
      }
      let child: unknown;
      try {
        child = (node as Record<string, unknown>)[key];
      } catch {
        push('<unreadable>', path === '' ? key : `${path}.${key}`, MODEL_CONTROL_FIELD_FORBIDDEN);
        continue;
      }
      visit(child, path === '' ? key : `${path}.${key}`, depth + 1);
    }
  };

  visit(value, '', 0);
  if (limitExceeded && !reason_codes.includes('SCAN_LIMIT_EXCEEDED')) reason_codes.push('SCAN_LIMIT_EXCEEDED');
  return { ok: reason_codes.length === 0, hits, reason_codes };
}

/**
 * **守卫一个模型端口**：把注入端口的回报先过控制字段扫描，命中即整条拒绝。
 *
 * 拒绝手段是"让合流层把这次求值归类为失败"（`model_failure: 'response_shape_unknown'`），
 * 因此合流结论必然是 `quarantined`——**任何模型回报都覆盖不了这个拒绝**，
 * 也**不会**把模型回报里的自由文本抄进任何结果（错误消息是固定串）。
 */
export function guardModelPort<T extends { evaluate: (request: unknown) => unknown }>(port: T): T {
  const guarded = {
    ...port,
    evaluate: async (request: unknown): Promise<unknown> => {
      const raw = await (port.evaluate as (value: unknown) => unknown)(request);
      const scan = scanForbiddenControlFields(raw);
      if (!scan.ok) {
        const error = new Error('model report rejected: forbidden control fields');
        Object.assign(error, {
          model_failure: 'response_shape_unknown',
          // 只带**键名**与码，不带值（值可能是外部自由文本/PII）。
          forbidden_fields: scan.hits.map((hit) => hit.field).slice(0, 30),
          reason_codes: scan.reason_codes,
        });
        throw error;
      }
      return raw;
    },
  };
  return guarded as unknown as T;
}

/**
 * 来源未被审核改动（AC08「AI 不改来源」）。
 * 返回 `false` 即**不得**沿用本次审核结论，调用方须按 `SOURCE_CHANGED_BY_MODEL` 拒绝。
 */
export function assertSourceUnchanged(before: string | null, after: string | null): boolean {
  return before === after;
}

/**
 * 人审入口：**空态**（不造假任务、不造假审核人、不造假专家认证、不做票决）。
 * 返回结构里的 `items` 恒为空数组——只有真实人审线合并后才会返回非空。
 */
export function humanReviewQueue(): {
  human_review_state: typeof HUMAN_REVIEW_STATE;
  voting: 'disabled';
  items: readonly never[];
} {
  return { human_review_state: HUMAN_REVIEW_STATE, voting: PUBLIC_VOTE_ENABLED ? 'disabled' : 'disabled', items: [] };
}

/** 该回报是否试图标注"专家已审"（首版无此能力 ⇒ 拒绝）。 */
export function detectExpertReviewClaim(value: unknown): boolean {
  const scan = scanForbiddenControlFields(value);
  return scan.hits.some((hit) => ['expert_reviewed', 'expert_review', 'expert'].includes(normalizeKey(hit.field)));
}

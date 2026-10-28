/**
 * R68 · 后台 scope 目录：**从契约派生**，不手抄。
 *
 * 唯一权威是 `packages/contracts/openapi.json` 的 `components.schemas.AdminScope.enum`
 * （服务端那边由 `services/api/src/admin/ops/fields.ts` 从 `admin/scopes.ts` 的 `ADMIN_SCOPES`
 * 生成，库层 CHECK 与它逐项同源）。前端不再复制第三份字面量清单：
 *
 * - 授权 / 撤销的选择器选项、本地闭集校验都读这里的 `ADMIN_SCOPES`；
 * - 契约 `enum` 缺失或为空 ⇒ **模块加载即抛错**。理由：一个空闭集等于「什么都不能授」，
 *   页面会静默变成只有禁用按钮的死页；这属于装配缺陷，必须在启动时炸出来，不能退化成空列表。
 *
 * ⓘ 代价（对抗审查实测，2026-10-28）：本模块 import 了整份契约 JSON，Vite 会把它内联进 admin 包。
 *   实测 `vite build`：**628,079 B → 541,216 B**，增量 **+86,863 B（+16.0%，min 后）／gzip +13,193 B（+8.2%）**。
 *   机制值得记一笔：`openapi.json` 的 `paths`（204,378 B，min 后）被摇掉、只有 `components`（87,057 B）进包——
 *   这是**偶然摇树**，不是设计保证：哪天有人 import 了 `paths`（或改成 `import * as contract`），
 *   增量会回到 **+292KB** 量级。真要省，正确做法是构建期生成一份只含 enum 的小模块；
 *   本片选择「先真、后省」，因为 `tools/**` 在这一片是禁改面。
 *   换来的是「选项就是契约」——不会出现前端清单与契约漂移导致的 400 INVALID_REQUEST。
 */
import contract from '../../../../packages/contracts/openapi.json' with { type: 'json' };

/** 契约文件的仓库相对路径（报错文案与测试都用它定位）。 */
export const ADMIN_SCOPE_CONTRACT_PATH = 'packages/contracts/openapi.json';

/** 契约里承载 scope 闭集的 schema 名。 */
export const ADMIN_SCOPE_SCHEMA_NAME = 'AdminScope';

/** `AdminScope` 的中文标签（**不决定**闭集成员；成员只来自契约 enum）。 */
export const ADMIN_SCOPE_LABELS = Object.freeze({
  'accounts:read': '账号目录读',
  'accounts:suspend': '账号暂停 / 恢复',
  'audit:read': '审计总台账读',
  'flags:read': '功能开关读',
  'flags:write': '功能开关写',
  'jobs:cancel': '取消作业',
  'jobs:read': '作业读',
  'scopes:read': '管理员权限读',
  'scopes:write': '管理员权限写',
  'session:logout': '退出后台会话',
  'session:read': '后台会话读',
  'sources:read': '资料来源读',
  'sources:write': '资料来源写',
});

/**
 * 从契约里读 `AdminScope.enum`；形状不对就直接抛，不返回空数组。
 * @param {unknown} spec 解析后的 openapi 文档
 * @returns {ReadonlyArray<string>}
 */
function readAdminScopeEnum(spec) {
  const schema = spec !== null && typeof spec === 'object'
    ? spec?.components?.schemas?.[ADMIN_SCOPE_SCHEMA_NAME]
    : undefined;
  const values = schema !== null && typeof schema === 'object' ? schema.enum : undefined;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(
      `契约 ${ADMIN_SCOPE_CONTRACT_PATH} 的 components.schemas.${ADMIN_SCOPE_SCHEMA_NAME}.enum 缺失或为空：`
        + 'scope 闭集只能从契约派生，不得回落到手写清单或空集',
    );
  }
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`契约 ${ADMIN_SCOPE_SCHEMA_NAME}.enum 含非字符串成员：${JSON.stringify(value)}`);
    }
  }
  const dupes = values.filter((value, index) => values.indexOf(value) !== index);
  if (dupes.length > 0) {
    throw new Error(`契约 ${ADMIN_SCOPE_SCHEMA_NAME}.enum 有重复成员：${dupes.join(' / ')}`);
  }
  return Object.freeze([...values]);
}

/** 契约 `AdminScope` 闭集（顺序即契约 enum 顺序）。 */
export const ADMIN_SCOPES = readAdminScopeEnum(contract);

/** 选择器选项：值来自契约，标签查表；契约新增而未配标签时退回 scope 字面量（照样可授）。 */
export const ADMIN_SCOPE_OPTIONS = Object.freeze(
  ADMIN_SCOPES.map((scope) => Object.freeze({ value: scope, label: ADMIN_SCOPE_LABELS[scope] ?? scope })),
);

/** scope 是否在契约闭集里。 */
export function isKnownAdminScope(value) {
  return typeof value === 'string' && ADMIN_SCOPES.includes(value);
}

/**
 * scope 的本地合法性说明：合法返回 `null`，否则返回一句中文（发请求前拦下用）。
 * ⛔ 这里**不** trim／不大小写归一：闭集是逐字节比较，`Audit:Read` 不是 `audit:read`。
 * @param {unknown} value
 * @returns {string|null}
 */
export function scopeProblem(value) {
  if (typeof value !== 'string' || value === '') {
    return `请选择一个 scope（契约 ${ADMIN_SCOPE_SCHEMA_NAME} 闭集，共 ${ADMIN_SCOPES.length} 项）`;
  }
  if (!isKnownAdminScope(value)) {
    return `scope 必须落在契约 ${ADMIN_SCOPE_SCHEMA_NAME} 闭集内（收到 ${JSON.stringify(value)}）`;
  }
  return null;
}

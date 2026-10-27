/**
 * 对话框焦点管理（纯逻辑，无 Vue、无 DOM 依赖）。
 *
 * 为什么要单独一个模块：`AccountsView.vue` 的停用确认框是页内真对话框（有输入框、两个按钮），
 * 打开后 Tab 不该跑到后面的表格里去。要做到「打开进框／Tab 首尾循环／关闭回触发按钮」，
 * 其中**只有下标计算**是可测的纯逻辑；枚举 DOM 与调 `focus()` 留在组件里。
 *
 * 这样 `tests/unit/admin-ui-a11y-semantics.test.mjs` 能直接钉住循环语义（不依赖 jsdom／
 * vitest —— 本仓库 `apps/admin` 没有那两样）。
 */

/**
 * 对话框内可被 Tab 命中的元素。
 *
 * 只列**原生可聚焦控件**并排除 `disabled`：保存中「确认停用」「取消」与理由输入框都会禁用，
 * 那时框内没有任何 Tab 目标，焦点应当留在标题上（调用方拿 `count === 0` 走这条分支）。
 * `tabindex="-1"` 是程序化焦点位（标题就用它），不算 Tab 目标，否则循环会卡在标题上。
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * 按一次 Tab／Shift+Tab 之后，焦点该落到可聚焦列表的哪一个。
 *
 * @param {object} input
 * @param {number} input.count 框内可聚焦元素个数。
 * @param {number} input.index 当前焦点元素在列表里的下标；焦点不在列表里（在标题上／在框外）用 `-1`。
 * @param {boolean} [input.shift] 是否 Shift+Tab。
 * @returns {number} 目标下标；`-1` 表示框内没有可聚焦元素，调用方应把焦点交回标题。
 */
export function nextFocusIndex({ count, index, shift = false }) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const outside = !Number.isInteger(index) || index < 0 || index >= count;
  if (outside) return shift ? count - 1 : 0;
  return shift ? (index - 1 + count) % count : (index + 1) % count;
}

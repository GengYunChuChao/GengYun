/**
 * 地区质心数据（GY-I05 U3／Refs #5）的**打包清单口径**：本仓不随分发该数据文件，
 * 但「文件放进 miniprogram/data/ 却没进允许清单」曾经是一条**静默死路**——
 * require 失败被 `miniprogram/utils/region-converter.js` 的 `loadModule` 吞成 null，
 * `inspect()` 如实判 `resource-missing`，于是生产照旧只报「地区转换资源尚未接入」：
 * 放了不生效、也不报错（`tools/prepare-wechat.mjs` 原先只是一行被注释掉的占位）。
 *
 * 本模块把「源码树里有没有这个文件」与「打包允许清单里有没有它」钉成同一件事：
 * `tools/prepare-wechat.mjs` 用 `regionCentroidManifestEntries()` 生成条目、再用
 * `assertRegionCentroidPackaging()` 双向断言；`tests/local-debug.test.mjs` 用同一口径钉
 * 「源码树里有 ⇔ 标准包里必须有」。任一方向不一致都抛错／判红，静默变成打包期的硬失败。
 *
 * ⛔ 本模块不含任何坐标，也不产出数据文件；它只判「清单与源码树是否一致」。
 */

/** 允许清单里的相对路径（相对 `miniprogram/`，与 prepare-wechat 的 files 条目同一口径）。 */
export const REGION_CENTROID_FILE = 'data/region-centroids.js';

/** 源码树里的路径（仓库根相对），用于存在性判断与报错文案。 */
export const REGION_CENTROID_SOURCE = 'miniprogram/' + REGION_CENTROID_FILE;

/**
 * 清单条目：文件存在才打包，不存在就一个条目也不给（本仓今天的状态）。
 * 不接受的输入一律抛 TypeError——「没传参数」不能被当成「文件不存在」。
 */
export function regionCentroidManifestEntries({ resourceExists } = {}) {
  if (typeof resourceExists !== 'boolean') {
    throw new TypeError('regionCentroidManifestEntries 需要 { resourceExists: boolean }（收到：' + JSON.stringify(resourceExists) + '）');
  }
  return resourceExists ? [REGION_CENTROID_FILE] : [];
}

/**
 * 双向断言：`resourceExists === manifest 里是否登记了该文件`。
 *
 * - 存在却不在清单 ⇒ 抛错。这正是今天会静默的场景：数据放进去、require 照样失败、页面恒 unavailable。
 * - 不在源码树却在清单 ⇒ 抛错。清单指向不存在的文件时 `prepare-wechat` 复制阶段会 ENOENT，
 *   报错位置离原因很远；这里提前点名。
 * - 重复登记 ⇒ 抛错（同一文件两次复制，掩盖清单本身的手改痕迹）。
 *
 * @returns {{ resourceExists: boolean, packaged: boolean }}
 */
export function assertRegionCentroidPackaging({ resourceExists, manifest } = {}) {
  if (typeof resourceExists !== 'boolean') {
    throw new TypeError('assertRegionCentroidPackaging 需要 { resourceExists: boolean }（收到：' + JSON.stringify(resourceExists) + '）');
  }
  if (!Array.isArray(manifest)) {
    throw new TypeError('assertRegionCentroidPackaging 需要 { manifest: string[] }（收到：' + JSON.stringify(manifest) + '）');
  }
  const listed = manifest.filter((entry) => entry === REGION_CENTROID_FILE).length;
  if (listed > 1) {
    throw new Error('打包允许清单重复登记了 ' + REGION_CENTROID_FILE + '（' + listed + ' 次）：清单被手改过，请恢复为 regionCentroidManifestEntries() 生成。');
  }
  if (resourceExists && listed !== 1) {
    throw new Error('地区质心数据存在于 ' + REGION_CENTROID_SOURCE + '，但不在打包允许清单里：' +
      '这份文件会进不了标准包，require 失败被吞成 null，生产静默回落到「地区转换资源尚未接入」。' +
      '请改用 regionCentroidManifestEntries({ resourceExists }) 生成清单条目，不要手写注释占位。');
  }
  if (!resourceExists && listed !== 0) {
    throw new Error('打包允许清单登记了 ' + REGION_CENTROID_FILE + '，但 ' + REGION_CENTROID_SOURCE + ' 不存在：' +
      '复制阶段会 ENOENT。本仓不随分发地区质心数据，清单条目必须由源码树是否存在决定。');
  }
  return { resourceExists, packaged: listed === 1 };
}

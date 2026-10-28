/**
 * 地区质心数据（GY-I05 U3／Refs #5）的**打包清单断言**——把一条静默死路变成可执行断言。
 *
 * ## 缺口（本轮实测，基线 `f0b97e16`）
 * `tools/prepare-wechat.mjs` 里 `data/region-centroids.js` 只是一行**被注释掉的占位**，
 * `tests/local-debug.test.mjs` 的固定依赖清单同样没有它。于是「有人把文件放进
 * `miniprogram/data/` 却忘了加进允许清单」= 标准包不复制它 ⇒ `require` 失败 ⇒
 * `miniprogram/utils/region-converter.js` 的 `loadModule` 把异常吞成 `null` ⇒
 * `inspect()` 如实判 `resource-missing` ⇒ 生产只报「地区转换资源尚未接入」。
 * **放了不生效、也不报错**——这是本片要消掉的那条静默路径。
 *
 * ## 本文件钉三件事
 * ① 清单条目只由「源码树是否存在该文件」决定，`assertRegionCentroidPackaging` 两个方向都判红；
 * ② 真跑 `tools/prepare-wechat.mjs`：源码树没有 ⇒ 标准包没有；源码树有 ⇒ 标准包逐字相同；
 * ③ **负控制**：文件放进夹具树、同时让清单漏掉它 ⇒ 打包必须非零退出，且报错点名 region-centroids。
 *
 * ⛔ 本文件不新增仓内数据文件，也不写任何真实坐标：夹具是 `os.tmpdir()` 沙箱里的**合成**模块，
 *    坐标 `0.5 / 0.5` 是显式合成值（合成坐标，不可用于生产），不代表任何真实质心或行政区位置。
 * ⛔ 所有写操作都在 `mkdtempSync(tmpdir())` 沙箱内，不碰仓库树
 *    （见 tests/unit/unit-suite-scan-write-isolation.test.mjs 的并发写隔离要求）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  REGION_CENTROID_FILE, REGION_CENTROID_SOURCE, regionCentroidManifestEntries, assertRegionCentroidPackaging,
} from '../../tools/lib/region-centroid-packaging.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 合成质心模块：**合成坐标，不可用于生产**。只用来验证「打包清单是否覆盖数据文件」，
// 不用来验证地理精度（本仓没有、也不许造真实质心表）。
const SYNTHETIC_CENTROIDS_SOURCE = `// 合成坐标，不可用于生产：本文件只存在于测试夹具目录，不进入仓库、不代表任何真实质心。
module.exports = {
  schema: 'gengyun.knowledge.region-centroids.v1',
  state: 'available',
  crs: 'WGS84',
  source: '单元测试合成（不是真实几何数据）',
  license: '单元测试合成',
  retrieved_at: '2026-10-28',
  catalog_version: 'mca-xzqh-2023',
  max_distance_km: 5,
  points: [{ code: '330102', latitude: 0.5, longitude: 0.5 }],
}
`;

test('打包清单口径：条目只由源码树存在性决定，两个方向不一致都判红', () => {
  // 本仓今天的状态：文件不存在 ⇒ 一个条目也不给（不是「先占位，等以后取消注释」）。
  assert.equal(
    existsSync(join(REPO_ROOT, REGION_CENTROID_SOURCE)), false,
    '本仓不随分发地区质心数据；该文件出现时须同批更新 U3 登记、文档与本断言',
  );
  assert.deepEqual(regionCentroidManifestEntries({ resourceExists: false }), []);
  assert.deepEqual(regionCentroidManifestEntries({ resourceExists: true }), [REGION_CENTROID_FILE]);
  // 参数缺失不等于「文件不存在」：绝不能靠默认值把断言静默关掉。
  assert.throws(() => regionCentroidManifestEntries(), TypeError);
  assert.throws(() => regionCentroidManifestEntries({ resourceExists: 'yes' }), TypeError);

  const base = ['utils/region-converter.js', 'data/regions.js'];
  assert.deepEqual(assertRegionCentroidPackaging({ resourceExists: false, manifest: base }), { resourceExists: false, packaged: false });
  assert.deepEqual(
    assertRegionCentroidPackaging({ resourceExists: true, manifest: [...base, REGION_CENTROID_FILE] }),
    { resourceExists: true, packaged: true },
  );
  // ① 文件在、清单漏掉它 ⇒ 红（今天会静默的那一条）。
  assert.throws(() => assertRegionCentroidPackaging({ resourceExists: true, manifest: base }), /不在打包允许清单里/);
  // ② 清单登记了、文件却不存在 ⇒ 红（复制阶段会 ENOENT，提前点名）。
  assert.throws(
    () => assertRegionCentroidPackaging({ resourceExists: false, manifest: [...base, REGION_CENTROID_FILE] }),
    /不存在/,
  );
  // ③ 重复登记 ⇒ 红（清单被手改过的痕迹）。
  assert.throws(
    () => assertRegionCentroidPackaging({ resourceExists: true, manifest: [...base, REGION_CENTROID_FILE, REGION_CENTROID_FILE] }),
    /重复登记/,
  );
  assert.throws(() => assertRegionCentroidPackaging({ resourceExists: true }), TypeError);
  assert.throws(() => assertRegionCentroidPackaging({ resourceExists: true, manifest: REGION_CENTROID_FILE }), TypeError);
});

test('真打包三态：没有就不打包、有就逐字打包、有却漏进清单必红（负控制）', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'gengyun-region-centroids-'));
  try {
    // 夹具工程：与 tests/local-debug.test.mjs 同一套最小依赖
    // （tools 脚本 + miniprogram 源码 + 共享工程配置），全部在沙箱内，不动仓库树。
    for (const entry of ['tools', 'miniprogram']) cpSync(join(REPO_ROOT, entry), join(fixture, entry), { recursive: true });
    cpSync(join(REPO_ROOT, 'project.config.json'), join(fixture, 'project.config.json'));
    const prepare = join(fixture, 'tools/prepare-wechat.mjs');
    const out = join(fixture, '.local/wechat-release');
    const packaged = join(out, 'miniprogram', REGION_CENTROID_FILE);
    const source = join(fixture, 'miniprogram', REGION_CENTROID_FILE);
    // prepare-wechat 拒绝复用已存在的产物目录 ⇒ 每次跑之前只清夹具内的产物。
    const run = () => {
      rmSync(join(fixture, '.local'), { recursive: true, force: true });
      return spawnSync(process.execPath, [prepare, 'release'], { encoding: 'utf8', cwd: fixture });
    };

    // 态一：源码树没有数据文件（本仓今天的样子）⇒ 打包成功，且标准包里**没有**它。
    const absent = run();
    assert.equal(absent.status, 0, absent.stderr || absent.stdout);
    assert.equal(existsSync(packaged), false, '源码树没有数据文件时，标准包不得凭空出现该文件');
    assert.match(absent.stdout, /按设计不打包/, '输出必须如实说明"不存在 ⇒ 不打包"，而不是静默跳过');

    // 态二：把合成数据放进夹具树 ⇒ 打包成功，且标准包里的那一份与源文件逐字相同。
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, SYNTHETIC_CENTROIDS_SOURCE);
    const present = run();
    assert.equal(present.status, 0, present.stderr || present.stdout);
    assert.equal(existsSync(packaged), true, '源码树有数据文件时，标准包必须有它（否则 require 失败被吞成 null）');
    assert.equal(readFileSync(packaged, 'utf8'), SYNTHETIC_CENTROIDS_SOURCE, '打包必须是逐字复制，不得改写数据');
    assert.match(present.stdout, /已纳入打包允许清单/);

    // 态三（负控制）：文件在夹具树里，但清单条目被抽掉（模拟「忘了加进允许清单」）⇒ 打包必须失败。
    // 抽掉的是夹具内的 helper，不是仓内文件——若脚本没有真的调用断言，这一次会绿，本用例即红。
    const helper = join(fixture, 'tools/lib/region-centroid-packaging.mjs');
    const helperSource = readFileSync(helper, 'utf8');
    const entryLine = 'return resourceExists ? [REGION_CENTROID_FILE] : [];';
    assert.notEqual(helperSource.indexOf(entryLine), -1, '负控制的前提被破坏：helper 的条目生成语句已改写，请同步本用例');
    writeFileSync(helper, helperSource.replace(entryLine, 'return [];'));
    const dropped = run();
    assert.notEqual(dropped.status, 0, '数据文件在树里却不在清单里 ⇒ 打包**必须**失败（这正是今天会静默的场景）');
    const message = dropped.stderr + dropped.stdout;
    assert.match(message, /region-centroids/, '失败文案必须点名该文件');
    assert.match(message, /不在打包允许清单里/);
    assert.equal(existsSync(packaged), false, '失败时不得留下半成品标准包');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

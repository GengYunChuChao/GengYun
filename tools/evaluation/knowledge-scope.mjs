// GY-I03 承诺范围口径加载（修复轮 3）。
// 背景：coverage-report.json 的 species_groups.required 是**展示用中文组名**
//   （["稗草","狗尾草",...]），而仓库契约里 labelClass/gold/candidates 用的是**规范物种 ID**
//   （catalog/species.json 的 id，如 species_barnyardgrass）。
// 若直接把中文组名当物种 ID 范围比较，会误判合法的规范 ID 输入"超出 GY-I03 范围"。
// 本模块按物种目录把中文组名映射为规范物种 ID，并绑定目录版本/文件摘要，使映射可追溯。
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DEFAULT_COVERAGE_REPORT = join(REPO_ROOT, 'packages', 'knowledge', 'coverage-report.json');
const DEFAULT_SPECIES_CATALOG = join(REPO_ROOT, 'packages', 'knowledge', 'catalog', 'species.json');

/**
 * 读取 GY-I03 承诺范围并映射为规范物种 ID。
 * 返回 { classes, sourceGroups, basisRef, catalogRef, catalogVersion, catalogSha256 }。
 * 缺失文件或缺少 species_groups.required 时返回 null（不阻断绑定校验，与既有行为一致）。
 * 目录存在但某个组名无法映射到 id 时**抛错**（配置错误，不得静默放宽范围）。
 */
export function loadKnowledgeScope({ coverageReportPath = DEFAULT_COVERAGE_REPORT, speciesCatalogPath = DEFAULT_SPECIES_CATALOG } = {}) {
  if (!existsSync(coverageReportPath) || !existsSync(speciesCatalogPath)) return null;

  const report = JSON.parse(readFileSync(coverageReportPath, 'utf8'));
  const groups = report?.species_groups?.required;
  if (!Array.isArray(groups) || groups.length === 0) return null;

  const catalogText = readFileSync(speciesCatalogPath, 'utf8');
  const catalog = JSON.parse(catalogText);
  const species = Array.isArray(catalog?.species) ? catalog.species : [];

  const idByGroup = new Map();
  for (const item of species) {
    if (item && typeof item.group_name === 'string' && typeof item.id === 'string' && item.id.trim() !== '') {
      idByGroup.set(item.group_name, item.id);
    }
  }

  const classes = [];
  const unmapped = [];
  for (const group of groups) {
    const id = idByGroup.get(group);
    if (typeof id === 'string' && id.trim() !== '') classes.push(id);
    else unmapped.push(group);
  }
  if (unmapped.length > 0) {
    throw new Error(`GY-I03 覆盖组无法映射到规范物种 ID（species.json 缺 group_name）：${unmapped.join(', ')}`);
  }

  return {
    classes,
    sourceGroups: [...groups],
    basisRef: 'GY-I03#species_groups',
    catalogRef: 'packages/knowledge/catalog/species.json',
    catalogVersion: typeof catalog.catalog_version === 'string' ? catalog.catalog_version : null,
    catalogSha256: createHash('sha256').update(catalogText).digest('hex'),
  };
}

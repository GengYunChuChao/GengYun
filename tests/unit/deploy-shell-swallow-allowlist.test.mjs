/**
 * R28-S44 · deploy/postgres-cvm 的「吞失败面」冻结守卫（纯静态文本核对，不执行脚本）。
 *
 * 为什么要有它：
 *   五个部署脚本里历史遗留 26 处 `|| true`。R28 逐条读过上下文并人工裁定：
 *   8 处是危险（失败会被当成数据/判定 ⇒ 已按最小改动修成「显式失败态」），
 *   其余 18 处是合法 best-effort（失败方向安全、只影响展示或后续硬校验）。
 *   这份快照锁的**不是**「允许吞失败」，而是「每一处都被人工裁定过」：
 *     · 脚本里出现未登记的 `|| true`          ⇒ 红（新人加了吞失败必须来解释）
 *     · 快照登记了但脚本里找不到              ⇒ 红（删了/改了也要同步裁定）
 *     · A 类（保留 `|| true`）没有 `# best-effort: …` 注释 ⇒ 红
 *     · 修完不应再有 B 类；确需保留时必须登记 `B-accepted` 并写清理由 ⇒ 否则红
 *   行为级复现（m1–m4 负控制）见证据页 docs/verification/gy-r28-deploy-swallow-audit-20261021.md §4。
 *
 * 裁定规则（改脚本时照这个来）：
 *   1)`|| true` 必须落在「进判定就判 FAIL、进报告值就显式写失败态」之外，否则属于 B 类，必须修；
 *   2) 保留的 A 类必须在 `|| true` 的**同一物理行**或**紧邻上一行**写 `# best-effort: <失败方向>`;
 *   3) 改了被冻结的那一行（哪怕只是空格/措辞）就要同步更新本文件的 lineText 与 reason。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY_DIR = 'deploy/postgres-cvm';
const FILES = [
  'install-postgres.sh',
  'provision-db.sh',
  'verify-cvm-postgres.sh',
  'backup-postgres.sh',
  'restore-drill.sh',
];
const MARKER = /#\s*best-effort/;
const CATEGORIES = new Set(['A', 'B-accepted']);

// 冻结快照：file + lineText（trim 后逐字相等）+ category + reason。
// category 只允许 A（保留吞失败，必须带 best-effort 注释）或 B-accepted（确需保留吞失败，必须写理由）；
// B 是「已裁定为危险、必须修掉」的临时标记，修完后不应出现在快照里。
const SNAPSHOT = [
  {
    file: "install-postgres.sh",
    lineText: "OWNER_PASSWORD=\"$(read_secret_from_file 'GENGYUN_DB_OWNER_PASSWORD' || true)\"",
    category: 'A',
    reason: "read_secret_from_file 失败只把口令留空；紧接着的 [[ -z ]] 分支：集群已存在则 warn 跳过 initdb，不存在则 fail。空口令不可能被用于初始化。",
  },
  {
    file: "install-postgres.sh",
    lineText: "_pgdata_preview=\"$(find \"$PGDATA_DIR\" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 5 || true)\"",
    category: 'A',
    reason: "只用于打印「数据目录非空」的预览；find 失败即空，不参与任何判定（清空动作另由 GENGYUN_RESET_PGDATA 与挂载点断言把关）。",
  },
  {
    file: "install-postgres.sh",
    lineText: "if [[ ! -f \"$PGDG_LIST\" ]] || [[ \"$(cat -- \"$PGDG_LIST\" 2>/dev/null || true)\" != \"$EXPECTED_LIST\" ]]; then",
    category: 'A',
    reason: "读失败 ⇒ 视为「内容与期望不符」⇒ 重写 EXPECTED_LIST（本就该写的内容），幂等收敛到目标态，方向安全。",
  },
  {
    file: "install-postgres.sh",
    lineText: "| grep -E \"^${PG_MAJOR}\\.${PG_MINOR}([.-]|$)\" | head -1 || true)\"  # best-effort: apt 探测失败即空 ⇒ 下面按「找不到 17.11 包」硬失败（绝不改装别的 minor）。",
    category: 'A',
    reason: "apt 探测失败即空 ⇒ 紧接着 [[ -z PKG_VERSION ]] 在非 --plan 时硬失败，绝不改装别的 minor。",
  },
  {
    file: "install-postgres.sh",
    lineText: "_default_cluster_line=\"$(pg_lsclusters -h 2>/dev/null | awk -v v=\"$PG_MAJOR\" '$1==v && $2==\"main\"{print}' || true)\"",
    category: 'A',
    reason: "pg_lsclusters 探测失败即空 ⇒ 当作没有发行版集群；若它真占用 PGPORT，启动阶段仍会 bind 失败并硬失败，数据零破坏。",
  },
  {
    file: "install-postgres.sh",
    lineText: "bash -c 'systemctl disable --now postgresql.service >/dev/null 2>&1 || true'  # best-effort: 单元可能不存在；停用失败不中断安装。",
    category: 'A',
    reason: "systemctl disable 对可能不存在的单元本就该容忍（极简镜像/容器）；失败不影响安装目标，也不进任何判定。",
  },
  {
    file: "install-postgres.sh",
    lineText: "_pwdir_namei=\"$(namei -l \"$_pwdir\" 2>/dev/null | sed 's/^/           /' || true)\"",
    category: 'A',
    reason: "namei 只用于把逐级权限打进 fail 文案；取不到就写「namei 不可用」，不影响判定（本来就是 fail 路径）。",
  },
  {
    file: "install-postgres.sh",
    lineText: "listen_dump=\"$(ss -ltnH \"sport = :${PGPORT}\" 2>/dev/null || true)\"",
    category: 'A',
    reason: "ss 失败即空 ⇒ 下一行 fail「未看到端口监听记录」，空不会被当成通过。",
  },
  {
    file: "install-postgres.sh",
    lineText: "_final_ver=\"$(cat -- \"${PGDATA_DIR}/PG_VERSION\" 2>/dev/null || true)\"",
    category: 'A',
    reason: "收尾读 PG_VERSION 失败即空 ⇒ 下一行 [[ == 17 ]] 判失败（硬校验）。",
  },
  {
    file: "install-postgres.sh",
    lineText: "-d \"$DB_NAME\" -tAc 'SELECT 1' 2>/dev/null || true)\"  # best-effort: 探活失败即空 ⇒ 下一行 [[ == 1 ]] 判失败。",
    category: 'A',
    reason: "收尾 SELECT 1 失败即空 ⇒ 下一行 [[ == 1 ]] 判失败（硬校验）。",
  },
  {
    file: "provision-db.sh",
    lineText: "RUNTIME_PASSWORD=\"$(read_secret_from_file 'GENGYUN_API_RUNTIME_PASSWORD' || true)\"",
    category: 'A',
    reason: "读不到就留空；下一行 [[ -n ]] || fail 拒绝继续，缺口令不可能跑到建库。",
  },
  {
    file: "verify-cvm-postgres.sh",
    lineText: "-c \"SET ROLE ${RUNTIME_ROLE}; $1\" 2>&1 || true  # best-effort: 保留 psql 的 stderr 供调用方判定——report_denied 只有见 42501 才 PASS、report_num_runtime 只有末行非负整数才 PASS，失败文本一律 FAIL。",
    category: 'A',
    reason: "as_runtime 保留 psql 的 stderr（失败文本）；report_denied 只有见 42501 才 PASS、report_num_runtime 只有末行非负整数才 PASS，失败文本一律 FAIL。",
  },
  {
    file: "verify-cvm-postgres.sh",
    lineText: "| grep -E \"^${VPC_PREFIX//./\\\\.}\\.\" | sort -u | head -1 || true)\"  # best-effort: 探测失败即空 ⇒ 下面 skip（exit 2），且 listen_addresses 的期望值变 127.0.0.1,? ⇒ 不可能 PASS。",
    category: 'A',
    reason: "VPC IP 探测失败即空 ⇒ vpc_tcp_open 记 skip（退出码 2），且 listen_addresses 期望值变 127.0.0.1,? ⇒ 不可能 PASS。",
  },
  {
    file: "verify-cvm-postgres.sh",
    lineText: "-c 'SELECT current_user' 2>&1 | tr -d '\\r' | tail -n1 || true)\"  # best-effort: 登录失败即错误文本/空 ⇒ 与角色名精确比较不等 ⇒ FAIL。",
    category: 'A',
    reason: "登录失败即错误文本/空 ⇒ 与角色名精确比较不等 ⇒ FAIL。",
  },
  {
    file: "verify-cvm-postgres.sh",
    lineText: "| sort -nr | awk 'NR==1{print $2}')\" || true  # best-effort: 枚举失败即空 ⇒ backup_artifact 记 skip（退出码 2），不当「有备份」也不当 PASS。",
    category: 'A',
    reason: "枚举最新 dump 失败即空 ⇒ backup_artifact 记 skip（退出码 2）：既不当「有备份」，也不当 PASS。",
  },
  {
    file: "verify-cvm-postgres.sh",
    lineText: "read -r DATA_SRC DATA_MNT <<<\"$(df -P -- \"$_pgdata_parent\" 2>/dev/null | tail -1 | awk '{print $1, $6}')\" || true",
    category: 'A',
    reason: "df 失败即空 ⇒ 下面 _fail pgdata_separate_filesystem，把「父级不存在/df 不可用」判失败。",
  },
  {
    file: "backup-postgres.sh",
    lineText: "old=\"$(list_old_backups || true)\"",
    category: 'A',
    reason: "清理旧备份是附加动作：枚举失败即空 ⇒ 本轮不删任何文件（安全方向），不参与任何 PASS/FAIL 判定；代价是日志会说「没有需要清理的」，保留期静默未执行见证据页 §6。",
  },
  {
    file: "restore-drill.sh",
    lineText: "notices=\"$(grep -cE '^(pg_restore: )?(WARNING|NOTICE):' \"$RESTORE_LOG\" 2>/dev/null || true)\"",
    category: 'A',
    reason: "notices 只进 PASS 文案（展示非致命 WARNING/NOTICE 行数）；grep 失败即空、显示为 0 行，不改判定。",
  },
];

function readLines(file) {
  return readFileSync(resolve(ROOT, DEPLOY_DIR, file), 'utf8').split(/\r?\n/);
}

// 站点 = 含 `|| true` 且 trim 后不以 `#` 开头的实调用点（整行注释不算）。
function scanSites() {
  const sites = [];
  for (const file of FILES) {
    const lines = readLines(file);
    lines.forEach((line, i) => {
      if (!line.includes('|| true')) return;
      const lineText = line.trim();
      if (lineText.startsWith('#')) return;
      const prevRaw = i > 0 ? lines[i - 1] : '';
      sites.push({
        file,
        line: i + 1,
        lineText,
        prevLine: prevRaw.trim(),
        hasMarkerSameLine: MARKER.test(line),
        hasMarkerPrevLine: MARKER.test(prevRaw),
      });
    });
  }
  return sites;
}

const SITES = scanSites();
const key = (file, lineText) => file + '\u0000' + lineText;

function findRegistered(entry) {
  return SITES.filter((s) => s.file === entry.file && s.lineText === entry.lineText);
}

test('脚本里的每一处 `|| true` 都已在快照里登记（未登记 ⇒ 红）', () => {
  const snapshotKeys = new Set(SNAPSHOT.map((e) => key(e.file, e.lineText)));
  assert.equal(snapshotKeys.size, SNAPSHOT.length, '快照自身有重复项（同一 file + lineText 出现两次）');

  const unregistered = SITES.filter((s) => !snapshotKeys.has(key(s.file, s.lineText)));
  if (unregistered.length > 0) {
    const detail = unregistered
      .map((s) => `${DEPLOY_DIR}/${s.file}:${s.line}  ${s.lineText}`)
      .join('\n  ');
    assert.fail(
      `发现未登记的 \`|| true\`（${unregistered.length} 处）：\n  ${detail}\n` +
        '处置：能判 FAIL 就修掉；确属 best-effort 才登记为 A 并在同一行或紧邻上一行写 `# best-effort: <失败方向>`。',
    );
  }
});

test('快照里的每一处登记项都仍在脚本里（登记项消失 ⇒ 红）', () => {
  const missing = SNAPSHOT.filter((e) => findRegistered(e).length === 0);
  if (missing.length > 0) {
    const detail = missing.map((e) => `${DEPLOY_DIR}/${e.file}  ${e.lineText}`).join('\n  ');
    assert.fail(
      `快照登记项在脚本里找不到了（${missing.length} 处）：\n  ${detail}\n` +
        '处置：确认是删掉了吞失败（好），然后把该条从 SNAPSHOT 里删掉并更新证据页 §2 的计数。',
    );
  }
  const duplicated = SNAPSHOT.filter((e) => findRegistered(e).length > 1);
  assert.deepEqual(duplicated, [], '同一处 lineText 在脚本里出现了多次，快照无法唯一对应（请改用更长的行文本）');
});

test('分类合法：修完后不得再有 B 类；B-accepted 必须写清理由', () => {
  for (const entry of SNAPSHOT) {
    assert.ok(
      CATEGORIES.has(entry.category),
      `${entry.file} 的分类 ${JSON.stringify(entry.category)} 非法：只允许 A / B-accepted（B 类必须修掉）`,
    );
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.trim().length >= 12,
      `${entry.file} 的登记项缺少理由：${entry.lineText}`,
    );
    if (entry.category === 'B-accepted') {
      assert.ok(
        /危险|吞|判定|报告值/.test(entry.reason),
        `${entry.file} 的 B-accepted 理由必须说明「为什么危险却仍保留」：${entry.reason}`,
      );
    }
  }
});

test('A 类必须有 `# best-effort` 注释（同一行或紧邻上一行）', () => {
  const offenders = [];
  for (const entry of SNAPSHOT) {
    if (entry.category !== 'A') continue;
    const matched = findRegistered(entry);
    if (matched.length !== 1) continue; // 缺失/歧义已由前两个用例报出
    const site = matched[0];
    const annotated = site.hasMarkerSameLine || site.hasMarkerPrevLine;
    if (!annotated) {
      offenders.push(`${DEPLOY_DIR}/${site.file}:${site.line}  ${site.lineText}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些 A 类吞失败缺少 `# best-effort: <失败方向>` 注释（同一行或紧邻上一行）：\n  ' + offenders.join('\n  '),
  );
});

test('快照规模与分类计数符合 R28-S44 的裁定（18 处 A、0 处 B/B-accepted）', () => {
  const counts = { A: 0, 'B-accepted': 0 };
  for (const entry of SNAPSHOT) counts[entry.category] += 1;
  assert.equal(SNAPSHOT.length, 18, 'R28-S44 裁定后应剩 18 处 best-effort 吞失败');
  assert.deepEqual(counts, { A: 18, 'B-accepted': 0 }, '分类计数变了就必须同步证据页 §2 与 §3');
});

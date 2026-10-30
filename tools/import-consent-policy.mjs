#!/usr/bin/env node
/**
 * `consent_policies` 的**唯一写入途径**（运维命令）。
 *
 * ## 它为什么存在
 *
 * `public.consent_policies` 是「记录 / 媒体处理 / 服务端推理外发 / 公开投稿」四类用途的**第一道闸**
 * （`privacy/grant-pg.ts` 的 `persistConsentGrant` 读它，读不到就 403 `CONSENT_REQUIRED`）。
 * 但产品代码、后台路由、运维工具、迁移种子**都没有写过这张表** —— 全仓唯一会写它的是测试夹具。
 * 于是在配了 `DATABASE_URL` 且该表 0 行的真实进程上，`POST /posts` 与 `POST /me/consents` 直接 403，
 * 审核代码根本不执行；同一道闸也挂在媒体上传、OCR / 识别 / 问答外发上。本命令补的就是这条路径。
 *
 * ## 只接受**具特权连接**（这条不是可选项）
 *
 * `services/api/db/roles/egress_ledger.sql` 头注释写着「刻意**不给**：… `recipients`/`consent_policies`
 * 的写入」，同一文件第 2 行又写「Provision a private LOGIN separately. Never run the API as migration
 * owner.」——那句「不给写」约束的是**运行时角色**（`gengyun_egress_ledger` / `gengyun_auth_privacy`），
 * 而运维/迁移属主走的是另一条本就存在的通道。**本工具不改变运行时角色的最小权限**：它不新增任何
 * `GRANT`、不改 `db/roles/*.sql`、也不给任何运行时角色 INSERT/UPDATE/DELETE；`DATABASE_URL` 必须指向
 * 迁移属主/运维身份 —— 这正是 `privacy/privacy-policy.ts` 文件头所说的「正文由运维导入」。
 * 用运行时角色跑会以 `42501` 失败（那是刻意的安全不变量，⛔ 不要绕过）。
 *
 * ## 用法（连接串只从环境变量来，⛔ 不接受 argv 里的 DSN，也不回显）
 *
 *     $env:DATABASE_URL = 'postgresql://<迁移属主/运维角色>:<口令>@<host>:5432/<db>'
 *     node tools/import-consent-policy.mjs policy --file <仓外政策清单.json>                       # 默认 dry-run
 *     node tools/import-consent-policy.mjs policy --file <仓外政策清单.json> --apply               # 只插不启用
 *     node tools/import-consent-policy.mjs policy --file <仓外政策清单.json> --apply --enable --reviewed-by <admin uuid>
 *
 * **默认 dry-run**：连库、在事务里读出该 purpose 的现库行、算出「会写成什么形状」，然后 `ROLLBACK`。
 * dry-run 打印 purpose / 版本 / sha256 / enabled / 有效期 / 正文读数，**⛔ 不打印正文**。
 * 幂等重放（同 `(purpose, policy_version)` 同正文**且安全元数据逐列相等**）在 dry-run 里就报 `unchanged=true`。
 *
 * ## 报告只报库行（⛔ 这条不是措辞问题）
 *
 * 报告里的 `source_kind` / `source_ref` / `review_evidence_ref` / `valid_from` / `valid_until` /
 * `reviewed_by` / `recipient_bindings` 全部取自**实际库行**：重放取库里那一行，写入取刚写完同事务
 * 读回的那一行；一行都还没有（首次插入的 dry-run）⇒ 打印 `(未写入)` 且 `metadata_source=none`，
 * 清单值只以 `manifest_*` 前缀出现。于是「报告说 verified、库里还是 synthetic」在结构上不可能。
 *
 * 同版本的安全元数据不一致 ⇒ 明确冲突（`METADATA_CONFLICT`，退出码 4），报错点名每个字段的
 * 库行值 → 清单值（⛔ 不含正文）。`--enable` 走同一关：先证明库行就是这份清单，再谈开不开 ——
 * 否则就是「启用旧元数据」。
 *
 * ## 它做的六件事（顺序固定，全在一个事务里）
 *
 * 1. 读仓外清单并做**强校验**（`tools/lib/consent-policy-import.mjs` 的 `readPolicyManifest`：
 *    闭集 purpose / 版本单调 / 非占位正文 / 有效期 / 来源形状 / 绑定形状 / 拒收调用方传的
 *    `content_sha256` 与 `reviewed_by`）；
 * 2. `BEGIN` + `SET LOCAL lock_timeout` + 取库钟 `clock_timestamp()`，用它复核 `valid_until`；
 * 3. `--enable` 时**先在应用层查 `admin_accounts`**：`--reviewed-by` 指向的行不存在就直接拒（exit 3），
 *    ⛔ 不把数据库外键抛错当成唯一防线；
 * 4. `recipient_bindings` 里每个 id 都在 `public.recipients` 里存在（不存在 ⇒ exit 3 并点名）；
 * 5. `SELECT … FROM public.consent_policies WHERE purpose=$1 FOR UPDATE` 读出该 purpose 的全部行
 *    （**含全部安全元数据列**），再用纯函数 `planConsentPolicyImport` 判 `insert` / `enable` /
 *    `unchanged` / 冲突（同版本先比正文 sha，再逐列比安全元数据）；
 * 6. 按判定写入（`insert` 只插新行；`--enable` 先把同 purpose 其它行 `enabled=false` 再开目标行），
 *    写完在同事务内读回目标行供报告使用，成功才 `COMMIT`；任何一步抛错一律 `ROLLBACK` ⇒ **失败不留半写**。
 *
 * ## ⛔ 它明确不做的事
 *
 * - ⛔ **不就地改已有行的正文/版本/sha**：`0009` 的 `consent_policy_immutable()` 触发器会以 `23514`
 *   挡住，本命令也不尝试绕过 —— 换正文只能是新 `policy_version` 新行；
 * - ⛔ **不内置任何政策正文**，也不把正文写进日志/库里（表里只有 `content_sha256`，正文留在仓外的
 *   清单与其 `source_ref` 指向处）；
 * - ⛔ **不建表、不改迁移、不改授权**：它假定 `0009` 已执行、连接角色是迁移属主/运维角色；
 * - ⛔ **不写 `public.recipients`**：`recipients` 目前同样是**生产零写入**，本片只交付 `policy`
 *   子命令。`recipient` 子命令因此**未交付**（见 `docs/reference/consent-policy-import.md` 的
 *   「已登记的依赖」）。后果是 `external_inference` 这条用途**目前仍打不开**：没有已核验接收方，
 *   `persistConsentGrant` 会以「对外推理需要已核验接收方」403。本工具对「`external_inference` +
 *   空绑定」会打印 `warning=` 行，⛔ 不许把这半个门说成门已开。
 *
 * ## 退出码（cron / 证据页的唯一判据）
 *
 * | 码 | 含义 |
 * | --- | --- |
 * | 0 | 成功：dry-run 已出形状 / `--apply` 已落库 / 二次执行 `unchanged=true`（零行改动） |
 * | 2 | 参数或环境问题（缺子命令、缺 `--file`、缺 `DATABASE_URL`、清单读不到、JSON 不合法、`recipient` 未交付） |
 * | 3 | 政策内容强校验失败（purpose 越界 / 正文空或占位 / 有效期不合法 / 传了 `content_sha256` / 来源形状不符 / 绑定不存在 / 复核主体不存在），或库内 CHECK 拒绝 |
 * | 4 | 政策冲突（版本回退 / 同版本不同正文 / 同版本安全元数据不一致 `METADATA_CONFLICT` / 启用非最新版本） |
 * | 5 | 数据库错误（连不上 / 缺表 / 权限不足 / 未知），事务已回滚 |
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import pg from 'pg';

import {
  EXIT_CODES,
  FAILURE_KINDS,
  PLAN_ACTIONS,
  exitCodeFor,
  isUuid,
  planConsentPolicyImport,
  policyImportWarnings,
  readPolicyManifest,
  renderPolicyImportReport,
} from './lib/consent-policy-import.mjs';

const TAG = '[import-consent-policy]';

/**
 * 读库行时**必须取全**的列：判定与报告都靠它。
 *
 * 这七个安全元数据列（`source_kind` / `source_ref` / `review_evidence_ref` / `valid_from` /
 * `valid_until` / `reviewed_by` / `recipient_bindings`）是本片修的**根因所在**：原来这里只取
 * `id,purpose,policy_version,content_sha256,enabled,reviewed_at`，于是「同版本同正文」就被判
 * `unchanged`，报告却按清单打印来源与有效期。少取一列现在会被 `comparePolicySafetyMetadata`
 * 判成「缺列」冲突（exit 4），⛔ 不会静默通过。
 */
const SELECT_POLICY_ROW_COLUMNS = `SELECT id,purpose,policy_version,content_sha256,enabled,
         source_kind,source_ref,review_evidence_ref,valid_from,valid_until,reviewed_at,
         reviewed_by::text AS reviewed_by,recipient_bindings
    FROM public.consent_policies`;

const USAGE = `${TAG} 用法：
  DATABASE_URL=postgresql://… node tools/import-consent-policy.mjs policy --file <仓外政策清单.json> [--apply] [--enable --reviewed-by <admin uuid>]

  子命令 policy   导入一行 consent_policies（本片唯一交付的子命令）
  子命令 recipient 未交付：public.recipients 仍是生产零写入（见 docs/reference/consent-policy-import.md）

  --file P         仓外政策清单（JSON，含政策正文）；⛔ 不接受内联正文，也不接受 content_sha256 / reviewed_by
  --enable         导入后把目标版本设为该 purpose 唯一启用行（同 purpose 其它行落 enabled=false）
  --reviewed-by U  --enable 必填：复核人 = public.admin_accounts.id（小写 uuid，工具会先查它在不在）
  --apply          真正写库；缺省 = dry-run（连库算形状，最后回滚，零行改动）
  --help           打印本说明

连接串只从环境变量 DATABASE_URL 读取，且必须是迁移属主/运维身份（⛔ 运行时角色对这张表零写权限）。
退出码：0 成功 / 2 参数或环境 / 3 内容校验 / 4 政策冲突 / 5 数据库错误。`;

/** 安全分类的数据库错误：只报类别与 SQLSTATE，⛔ 不回显驱动原文（可能带主机/用户名/SQL）。 */
function classifyDatabaseFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const constraint = typeof error?.constraint === 'string' ? ` constraint=${error.constraint}` : '';
  switch (code) {
    case '42P01':
      return { kind: FAILURE_KINDS.DB_ERROR, detail: '缺 public.consent_policies / public.recipients / public.admin_accounts：迁移未执行（不是「表里没有政策」）' };
    case '42501':
      return { kind: FAILURE_KINDS.DB_ERROR, detail: '当前连接角色对 public.consent_policies 没有写权限：请用迁移属主/运维角色（运行时角色对这张表零写权限，是刻意的最小权限）' };
    case '3D000':
      return { kind: FAILURE_KINDS.DB_ERROR, detail: '目标数据库不存在' };
    case '28P01':
    case '28000':
      return { kind: FAILURE_KINDS.DB_ERROR, detail: '数据库认证失败' };
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
      return { kind: FAILURE_KINDS.DB_ERROR, detail: '连不上数据库（网络/端口/主机名）' };
    case 'ETIMEDOUT':
    case '57014':
    case '55P03':
      return { kind: FAILURE_KINDS.DB_ERROR, detail: '数据库超时或拿不到锁（并发导入？稍后重试）' };
    case '23514':
      return { kind: FAILURE_KINDS.INVALID_POLICY, detail: `库内 CHECK 或不可变触发器拒绝（23514）${constraint}：正文/版本/sha 不可就地修改，请改用新的 policy_version` };
    case '23503':
      return { kind: FAILURE_KINDS.INVALID_POLICY, detail: `外键不满足（23503）${constraint}：reviewed_by 必须指向已存在的 admin_accounts 行` };
    case '23505':
      return { kind: FAILURE_KINDS.POLICY_CONFLICT, detail: `唯一约束冲突（23505）${constraint}：同 (purpose,policy_version) 已存在，或该 purpose 已有启用行（并发导入？）` };
    case '22P02':
      return { kind: FAILURE_KINDS.INVALID_POLICY, detail: '输入里有一段的形状数据库不认（22P02，例如 uuid）' };
    default:
      return { kind: FAILURE_KINDS.DB_ERROR, detail: code === '' ? '数据库错误（驱动未给出 SQLSTATE；连接可能在导入过程中中断）' : `数据库错误（SQLSTATE ${code}）` };
  }
}

/** 统一的失败出口：类别 + 说明 + 退出码，⛔ 不打凭据。 */
function fail(kind, lines) {
  console.error(`${TAG} ${kind}: ${lines.join(' ')}`);
  process.exitCode = exitCodeFor(kind);
}

function parseArgv(argv) {
  return parseArgs({
    args: argv,
    options: {
      file: { type: 'string' },
      enable: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'reviewed-by': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (error) {
    return fail(FAILURE_KINDS.CONFIG, [`参数不合法：${error.message}`, '（用 --help 看用法）']);
  }
  const { file, enable, apply, help } = parsed.values;
  const reviewedBy = parsed.values['reviewed-by'] ?? null;
  if (help === true) {
    console.log(USAGE);
    return;
  }
  const [subcommand, ...extra] = parsed.positionals;
  if (extra.length > 0) return fail(FAILURE_KINDS.CONFIG, [`子命令之后不接受位置参数：${extra.join(' ')}`]);
  if (subcommand === undefined) return fail(FAILURE_KINDS.CONFIG, ['缺少子命令 policy', '（用 --help 看用法）']);
  if (subcommand === 'recipient') {
    return fail(FAILURE_KINDS.CONFIG, [
      '子命令 recipient 尚未交付：public.recipients 同样是生产零写入，而本片只交付 policy。',
      '后果：external_inference 这条用途目前仍打不开（没有已核验接收方）。已在 docs/reference/consent-policy-import.md 登记为已知依赖。',
    ]);
  }
  if (subcommand !== 'policy') return fail(FAILURE_KINDS.CONFIG, [`未知子命令 ${subcommand}（只支持 policy / recipient）`]);

  if (typeof file !== 'string' || file.length === 0) {
    return fail(FAILURE_KINDS.CONFIG, ['缺少 --file <仓外政策清单>', '（用 --help 看用法）']);
  }
  if (enable === true && (reviewedBy === null || reviewedBy.length === 0)) {
    return fail(FAILURE_KINDS.CONFIG, ['--enable 必须同时给 --reviewed-by <admin uuid>：启用的行必须有复核主体（0009 的 CHECK）']);
  }
  if (enable === true && !isUuid(reviewedBy)) {
    return fail(FAILURE_KINDS.INVALID_POLICY, ['--reviewed-by 必须是 admin_accounts.id 的小写 uuid']);
  }
  if (enable !== true && reviewedBy !== null) {
    return fail(FAILURE_KINDS.CONFIG, ['--reviewed-by 只在 --enable 时有意义：不加 --enable 的草稿行不带复核主体']);
  }

  // ── 1. 仓外清单 + 强校验（不碰库） ──────────────────────────────────────
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return fail(FAILURE_KINDS.CONFIG, [`读不到政策清单：${file}（${error.code ?? '未知错误'}）`]);
  }
  const manifest = readPolicyManifest(text, { now: new Date() });
  if (manifest.ok !== true) {
    return fail(manifest.code, manifest.errors);
  }
  const { policy } = manifest;

  // ── 2. 连接串只认环境变量；缺了就点名，⛔ 不打值 ────────────────────────
  const databaseUrl = typeof process.env.DATABASE_URL === 'string' ? process.env.DATABASE_URL : '';
  if (databaseUrl.trim() === '') {
    return fail(FAILURE_KINDS.CONFIG, ['缺少环境变量 DATABASE_URL（连接串只从环境读取，⛔ 不读 argv、不回显值）']);
  }

  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  let settled = false;
  // 连接中途断掉时 `pg` 会在 client 上 emit `error`；没有监听器就是一个未捕获异常
  // （进程以 1 退出、打一整段驱动栈）。接住它，让退出码只走**分类过的那一套**。
  client.on('error', () => {});

  /**
   * 事务内失败的唯一出口。
   *
   * ⚠ 调用点必须写 `return await rollbackAndFail(...)`：在 `try/finally` 里 `return <promise>`
   * **不会**被 `catch` 捕获，而 `finally` 会在 promise 结算**之前**就执行 —— 于是 `client.end()`
   * 正好砍在 ROLLBACK 的飞行途中（实测：`Error: Connection terminated` + exit 1）。
   * 加 `await` 让回滚先结算，退出码才是 3/4/5。
   */
  const rollbackAndFail = async (kind, lines) => {
    await client.query('ROLLBACK').catch(() => {});
    settled = true;
    return fail(kind, lines);
  };

  try {
    try {
      await client.connect();
    } catch (error) {
      const { kind, detail } = classifyDatabaseFailure(error);
      return fail(kind, [detail]);
    }

    await client.query('BEGIN');
    // 与 `privacy/consent-pg.ts` 的 ManagedMutation 同口径：拿不到锁就失败，不无限等。
    await client.query("SET LOCAL lock_timeout = '4s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const dbNow = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;

    // ── 3. 复核主体：应用层先查，不拿外键抛错当唯一防线 ────────────────────
    if (enable === true) {
      const reviewer = await client.query('SELECT 1 FROM public.admin_accounts WHERE id=$1::uuid', [reviewedBy]);
      if (reviewer.rowCount !== 1) {
        return await rollbackAndFail(FAILURE_KINDS.INVALID_POLICY, [
          `--reviewed-by ${reviewedBy} 在 public.admin_accounts 里不存在（FK 目标不存在）：先建后台账号，或换一个真实的复核人 id`,
        ]);
      }
    }

    // ── 4. 绑定必须指向真实存在的 recipients 行 ───────────────────────────
    const bindingIds = Object.keys(policy.recipient_bindings);
    if (bindingIds.length > 0) {
      const known = await client.query('SELECT id::text AS id FROM public.recipients WHERE id::text = ANY($1::text[])', [bindingIds]);
      const present = new Set(known.rows.map((row) => row.id));
      const missing = bindingIds.filter((id) => !present.has(id));
      if (missing.length > 0) {
        return await rollbackAndFail(FAILURE_KINDS.INVALID_POLICY, [
          `recipient_bindings 指向不存在的 public.recipients.id：${missing.join(', ')}`,
          '（public.recipients 目前是生产零写入，本工具不写它 ⇒ 先解决接收方登记，再来绑 external_inference）',
        ]);
      }
    }

    // ── 5. 现库行 + 纯函数判定 ────────────────────────────────────────────
    // ⚠ 这条 SELECT 必须取全**安全元数据列**：同版本重放/启用要按它们与清单逐列比，
    //   报告里的 source_kind/source_ref/valid_until/reviewed_by 也只从这些列来。
    //   少取一列 ⇒ `comparePolicySafetyMetadata` 判「缺列」冲突（exit 4），而不是静默 unchanged。
    const existing = (await client.query(`${SELECT_POLICY_ROW_COLUMNS} WHERE purpose=$1 ORDER BY policy_version FOR UPDATE`, [policy.purpose])).rows;

    const plan = planConsentPolicyImport({ policy, existing, wantEnable: enable === true, reviewedBy, dbNow });
    if (plan.ok !== true) {
      return await rollbackAndFail(plan.code, [plan.reason]);
    }
    /** 该 (purpose, policy_version) 的现库行（可能不存在）。 */
    const existingTarget = existing.find((row) => row.policy_version === policy.policy_version) ?? null;

    const enabledAfter = plan.enabled_after === true;
    const warnings = policyImportWarnings({ policy, dbNow });
    /** 报告只认库行：`row` 为空时内部打印 `(未写入)`，⛔ 不会拿清单值顶替。 */
    const report = (mode, changedRows, row) => {
      for (const line of renderPolicyImportReport({ policy, plan, mode, file, row, enabledAfter, reviewedBy, warnings })) console.log(line);
      console.log(`changed_rows=${changedRows}`);
    };

    if (plan.action === PLAN_ACTIONS.UNCHANGED || apply !== true) {
      // dry-run 与「幂等重放」走同一条路：一次都不写，回滚退出。
      // 报告用**现库行**（dry-run 首次插入时没有行 ⇒ `(未写入)`）。
      await client.query('ROLLBACK');
      settled = true;
      report(apply === true ? 'apply' : 'dry-run', 0, existingTarget);
      console.log('transaction=rollback（本次没有写任何行）');
      if (apply === true) console.log('结论：同 (purpose, policy_version) 同正文且安全元数据逐列一致 ⇒ 幂等重放，零行改动。');
      else console.log('结论：dry-run 结束（加 --apply 才写库）。');
      return;
    }

    // ── 6. 写 ─────────────────────────────────────────────────────────────
    let changedRows = 0;
    const targetId = plan.action === PLAN_ACTIONS.INSERT
      ? (await client.query(
        `INSERT INTO public.consent_policies
           (purpose,policy_version,source_kind,source_ref,content_sha256,review_evidence_ref,
            recipient_bindings,valid_from,valid_until,reviewed_by,reviewed_at,enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,
                 COALESCE($8::timestamptz, clock_timestamp()), $9::timestamptz,
                 $10::uuid, CASE WHEN $10::uuid IS NULL THEN NULL ELSE clock_timestamp() END, false)
         RETURNING id`,
        [
          policy.purpose,
          policy.policy_version,
          policy.source_kind,
          policy.source_ref,
          policy.content_sha256,
          policy.review_evidence_ref,
          JSON.stringify(policy.recipient_bindings),
          policy.valid_from,
          policy.valid_until,
          reviewedBy,
        ],
      )).rows[0].id
      : existingTarget.id;
    if (plan.action === PLAN_ACTIONS.INSERT) changedRows += 1;

    if (enable === true) {
      // 部分唯一索引 `consent_policies_enabled_purpose` 要求同 purpose 至多一条 enabled：
      // 先关掉其它行，再开目标行（同事务，中间态不对外可见）。
      const disabled = await client.query(
        `UPDATE public.consent_policies SET enabled=false, updated_at=clock_timestamp()
          WHERE purpose=$1 AND enabled AND id<>$2::uuid`,
        [policy.purpose, targetId],
      );
      changedRows += disabled.rowCount;
      const enabled = await client.query(
        `UPDATE public.consent_policies
            SET enabled=true,
                reviewed_by=COALESCE(reviewed_by,$2::uuid),
                reviewed_at=COALESCE(reviewed_at,clock_timestamp()),
                updated_at=clock_timestamp()
          WHERE id=$1::uuid AND enabled IS DISTINCT FROM true
          RETURNING enabled`,
        [targetId, reviewedBy],
      );
      changedRows += enabled.rowCount;
    }

    // 报告读**刚写完、同事务内读回**的那一行（不是内存里的清单、也不是 INSERT 的入参）。
    const writtenRow = (await client.query(`${SELECT_POLICY_ROW_COLUMNS} WHERE id=$1::uuid`, [targetId])).rows[0] ?? null;
    if (writtenRow === null) {
      return await rollbackAndFail(FAILURE_KINDS.DB_ERROR, ['写入后读不回目标行（同事务内），拒绝提交：报告不允许拿清单顶替库行']);
    }

    await client.query('COMMIT');
    settled = true;
    report('apply', changedRows, writtenRow);
    console.log('transaction=commit');
  } catch (error) {
    if (!settled) await client.query('ROLLBACK').catch(() => {});
    settled = true;
    const { kind, detail } = classifyDatabaseFailure(error);
    return fail(kind, [detail]);
  } finally {
    await client.end().catch(() => {});
  }
}

await main();

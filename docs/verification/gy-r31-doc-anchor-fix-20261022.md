# GY-R31 文档手写行号基线处置（2026-10-22）

`#456` 的 `--reanchor` 只覆盖 `contract-status.json` 里 412 条结构化 `source_anchor`；`docs/**` 散文里手写的「路径:行号」靠 `tools/verify-doc-anchors.mjs` + `tools/doc-anchors-baseline.json`（108 条）做机械兜底。基线的用途是**让人逐条裁决**，不是把红字变成免罚名单。本页记录 108 条的逐条裁决结果：证明过的才改，证明不了的保留在基线里并写明为什么。

⛔ 本页遵守与 `gy-r31-doc-anchors-20261022.md` 第 10 节相同的约定：**不写** `路径:行号` 形态，一律写成「文件 + 第 N 行」，否则本页自己就会成为新的待裁决条目。

## 1 结论

- 108 条里 **56 条被核实烧掉**（基线 108 → 52），**52 条判定为「不得改」**，全部留在基线里。
- 处置口径只有三档：**重指向 44 条**（新行号那一行必须有被引用的符号/语句，原文抄在第 3 节）、**改锚点形态 12 条**（去掉可解析的行号并在同句注明「行号不再维护」，第 4 节）、**删引用 0 条**（本批没有一条满足「文件全仓不存在且该句已无信息价值」——凡指向不存在文件的，句子本身承载的信息仍成立，删掉会损失证据）。
- 一句话画像：**真过期（符号还在、行号漂移）43 条；写错路径（目录前缀错、裸文件名落到同名文件、指向仓外 `.pg17` 笔记）13 条；其余 52 条不是「过期」而是「本来就不该由本仓行号表达」**（逐字转写的外部读数、自指的勘误、故意探针、未入库文件、以及无法唯一判定的条目）。

## 2 基线前后对比

| 类别 | 处置前 | 重指向 | 改锚点形态 | 删引用 | 未处理 | 处置后 |
| BROKEN | 30 | 3 | 11 | 0 | 16 | 16 |
| OUT_OF_RANGE | 8 | 2 | 1 | 0 | 5 | 5 |
| SUSPECT | 70 | 39 | 0 | 0 | 31 | 31 |
| 合计 | 108 | 44 | 12 | 0 | 52 | 52 |

复核方式（不是手数）：把 `HEAD` 的基线与新基线按 `(reference, reason, path)` 做集合差，`burned=56 / remain=52 / 新基线里出现旧基线没有的条目=0`。工具读数同口径：`COUNT: BROKEN 16 / OUT_OF_RANGE 5 / SUSPECT 31（合计 52 条）`、`陈旧 0 条`。

- 基线**不能更低**：`tests/unit/doc-anchors-guard.test.mjs` 硬断言基线条目数 ≥ 50，且要求三类 reason 各至少留 1 条、stale 为空、covered 与 entries 一一对应。52 条是这套不变量下「烧掉大部分」的上限值（50 是下限，本轮留 2 条余量）。该断言保护的是「基线不许被删空」——本条约束不在本片授权范围内（`tests/**` 禁改），故按它封顶。

## 3 重指向证据（前 10 条）

每一行的「新行原文」都是改完后该行号的真实内容（`git show origin` 同源，非改编）。全部 44 条按同一标准核对：**新行号那一行必须出现被引用的符号名或那句关键文本**。

| # | 文档（行） | 旧引用 | 新引用 | 新行原文（节选） |
| 32 | `docs/verification/gy-r28-roles-file-disposition-20261021.md` 第 173 行 | `README.md` 第 440 行（裸名落到根 README，272 行 ⇒ 越界） | `deploy/postgres-cvm/README.md` 第 440 行 | `\| \`services/api/db/roles/*.sql\`（8 个文件，11 个 NOLOGIN 角色） \| \`provision-db.sh\` 按 \`ROLE_GROUP_FILES\` 执行其中 5 个…` |
| 13 | `docs/verification/gy-i26-demo-align-20261014.md` 第 29 行 | `dist/styles.css` 第 1 行（BROKEN，无此文件） | `docs/ui-demo/dist/styles.css` 第 1 行 | `:root{--green:#176b50;--ink:#17352b;--muted:#7b8983;…` |
| 62 | `docs/verification/gy-r28-speech-persist-20261021.md` 第 17 行 | `app.ts` 第 1641 行（实测空行） | `services/api/src/app.ts` 第 1711 行 | `registerSpeechRoutes(app, config, { guards: gatedGuards, store: speechStore, provider: speechProvider, media: speechMedia, jobDeadlineMs: speechJobDeadlineMs, consent: consentGate, egress: speechEgress }, config.executionMode === 'real' ? pool : null);` |
| 67 | `docs/verification/gy-r28-comment-ops-contract-20261021.md` 第 61 行 | `services/api/src/community/service.ts` 第 1530 行 | 同文件第 1563 行 | `/** 诊断用：点赞计数（契约 \`Post\`/\`Comment\` **没有**点赞计数字段，故无对外读取口）。 */` |
| 68 | `docs/verification/gy-r28-least-privilege-grants-20261020.md` 第 168 行 | `community/store-pg.ts` 第 587 行 | 同文件第 592 行 | `` `DELETE FROM community_likes ``（第 589 行 `async removeLike(kind, targetId, userId) {`） |
| 69 | `docs/verification/gy-r28-least-privilege-grants-20261020.md` 第 169 行 | `community/store-pg.ts` 第 703 行（空行） | 同文件第 708 行 | `DELETE FROM community_idempotency`（第 702 行注释 `// ---- 幂等台账…`） |
| 72 | `docs/verification/gy-r28-favorites-history-grants-20261020.md` 第 113 行 | `conversations/store-pg.ts` 第 87 行 | 同文件第 88 行 | `const CONVERSATION_COLUMNS = 'id, owner_id, revision, conditions, created_at, updated_at';` |
| 74 | `docs/verification/gy-r28-favorites-history-grants-20261020.md` 第 97 行 | `favorites/store-pg.ts` 第 68 行 | 同文件第 73 行 | `const FAVORITE_COLUMNS = 'id, owner_id, target_type, target_id, target_revision, revision, created_at';` |
| 89 | `docs/verification/gy-i13-synthesis-20261019.md` 第 42 行 | `services/api/src/tts/service.ts` 第 383 行 | 同文件第 409 行 | `function assertJobMode(row: SynthesisJobRow): void {` |
| 60 | `docs/verification/gy-r28-w3-tts-content-20261021.md` 第 34 行 | `packages/contracts/openapi.json` 第 13268 行 | 同文件第 13356 行 | `"checked_content_ref",`（第 13355 行 `"required": [`，第 13357 行 `"locale"`） |

其余 34 条按同一标准核对过，逐条给出（文档行 → 新行 + 新行原文要点）：

| # | 文档 → 新行 | 新行原文要点 |
| 24 | `gy-i12-conversations-pg-20261020.md` 第 70 行 → `db/seeds/seed_reference.sql` 第 5–11 行 | `INSERT INTO knowledge_dataset_modes …`（原路径写成 `services/api/db/seeds/…`，该目录下只有 `migrations/` 与 `roles/`） |
| 25 | `gy-i19-backup-purge-driver-20261021.md` 第 102 行 → `services/api/db/roles/auth_privacy.sql` 第 59–66 行 | `GRANT UPDATE (payload,state,purged_at,evidence_ref,last_error_code,purge_attempts,updated_at) ON user_backup_copies TO gengyun_auth_privacy` |
| 34 | `gy-r28-w3-tts-content-20261021.md` 第 79 行 → `services/api/db/migrations/0010_knowledge_read_views.sql` 第 3–30 行 | 第 3 行 `CREATE VIEW catalog_read.current_knowledge WITH (security_barrier = true) AS` / 第 30 行 `AND jsonb_typeof(k.region_codes)='array';`（文件共 31 行，旧值 3–34 越界） |
| 40 | `gy-r28-deploy-swallow-audit-20261021.md` 第 71 行 → `deploy/postgres-cvm/verify-cvm-postgres.sh` 第 188 行 | `\| grep -E "^${VPC_PREFIX//./\\.}\." \| sort -u \| head -1 \|\| true)"` |
| 42 | 同页第 76 行 → 同脚本第 369–370 行 | 第 369 行 `newest_dump="$(find "$BACKUP_DIR" …`／第 370 行 `\| sort -nr \| awk 'NR==1{print $2}')" \|\| true` |
| 43 | `gy-i29-closure-20261018.md` 第 215 行 → `docs/architecture/contract-status.json` 第 395 行 | `"blocker": "…本基线尚未接入撤回消费者。…"` |
| 46 | 同页第 230 行 → 同文件第 395 行 | 同上 |
| 44 | `gy-i16-i17-deletion-cascade-20261021.md` 第 269 行 → 同文件第 1934 行 | `"blocker": "消息列表/未读数/读标记HTTP已装配；…真实事件/目标端口、PG/注销及页面/Android仍待验收，不虚构真人消息"` |
| 45 | `gy-issue-closure-index-20261018.md` 第 237 行 → 同文件第 1934 行 | 同上 |
| 47 | `gy-i03-i20-materials-gap-ledger-20261015.md` 第 316 行 → `docs/evaluation/README.md` 第 12 行 | `\| 近重复排除规则（同源裁剪/连拍/近重复跨 split 阻断） \| 独立核实记录（\`reviewedBy\`）与许可/出处核实 \|` |
| 48 | 同页第 453 行 → `docs/evaluation/real-samples-weeds-docx.md` 第 258 行 | `4. **来源形态**：非手机实拍、无不同角度/背景、每类仅 1 张；…` |
| 52 | `gy-i11-voice-input-20261021.md` 第 171 行 → `miniprogram/pages/voice/voice.js` 第 491 行 | `// 合成本身就失败了 ⇒ 没有任何产物可播：如实走"自动播放失败"出口（不记已听取）。` |
| 53 | `gy-i13-tts-http-20261012.md` 第 223 行 → 同文件第 491 行 | 同上 |
| 54 | `gy-i11-voice-input-20261021.md` 第 42 行 → 同文件第 1090 行 | `flow.deadlineMs = Date.parse(created.job.deadline_at) + speechTranscript.POLL_INTERVAL_MS` |
| 55 | `gy-i07-evidence-index-20261010.md` 第 27 行 → `miniprogram/utils/auth.js` 第 322 行 | `finishError('当前未启用联网（共享源码默认关闭）。请在本地或正式环境启用后再登录。')` |
| 57 | `gy-i28-demo-parity-20261018.md` 第 191 行 → `miniprogram/utils/history-api.js` 第 204 行 | `async function listHistory(cursor, limit) {` |
| 59 | `gy-i22-closure-gap-20261018.md` 第 118 行 → `miniprogram/utils/reference.js` 第 1079 行 | `function evaluateDoseBoundary(item, context, opts) {` |
| 64 | `gy-r28-c5-favorites-history-20261021.md` 第 35 行 → `services/api/src/app.ts` 第 1431 行 | `const favoritesService =`（第 1432 行 `config.executionMode === 'real' && !favoritesStore.persistent`） |
| 65 | `gy-i06-private-media-20261014.md` 第 276 行 → 同文件第 968 行 | `media: recognitionMedia ?? createRecognitionMediaPort(config.executionMode),` |
| 66 | `gy-i28-demo-parity-20261018.md` 第 112／180 行 → `services/api/src/community/events.ts` 第 128 行 | `* 为什么**不产** \`system\`：首版除 takedown 外没有任何系统事件生产点，而 takedown` |
| 70 | `gy-r28-sql-column-coverage-20261021.md` 第 128 行 → `community/store-pg.ts` 第 791 行 | `` `SELECT (SELECT count(*) FROM community_posts)::int AS posts, ``（4 个标量子查询，第 788 行 `async snapshotCounts() {`） |
| 71 | `gy-i12-chat-20261019.md` 第 35 行 → `services/api/src/conversations/service.ts` 第 1041 行 | `const candidate = composer.compose({` |
| 73 | `gy-i12-conversations-gap-20261021.md` 第 319 行 → `services/api/src/conversations/store.ts` 第 185 行 | `export function createMemoryConversationStore(): ConversationStore {` |
| 76 | `gy-i06-private-media-20261014.md` 第 300 行 → `services/api/src/media/service.ts` 第 1224 行 | `// ------------------------------------------------------------ 过期与清理` |
| 77 | 同页第 260 行 → 同文件第 755 行 | `function attachmentLimitFor(actor: MediaActor, purpose: unknown): number {` |
| 78 | `gy-r29-chain-e2e-20261022.md` 第 31 行 → `services/api/src/ocr/service.ts` 第 296 行 | `export function createOcrService(options: OcrServiceOptions) {` |
| 79 | `gy-r28-sql-column-coverage-all-20261021.md` 第 218 行 → `services/api/src/ocr/store-pg.ts` 第 556 行 | `` `SELECT ${JOB_COLUMNS} FROM public.ocr_jobs WHERE id = $1::uuid FOR UPDATE`, `` |
| 85 | `gy-i22-cross-module-security-e2e-20261027.md` 第 255 行 → `services/api/src/routes/favorites.ts` 第 89 行 | `app.get(\`${API_PREFIX}/favorites\`, { preHandler: guards.requireUser, …` |
| 86 | `gy-i02-stale-claims-20261016.md` 第 64 行 → `services/api/src/routes/messages.ts` 第 43／53／59 行 | `app.get(\`${API_PREFIX}/messages\``／`…/messages/unread-count`／`app.put(\`${API_PREFIX}/messages/:id/read\`` |
| 87 | 同页第 136 行 → 同上三处 | 同上 |
| 88 | `gy-r29-chain-e2e-20261022.md` 第 30 行 → `services/api/src/tts/provider.ts` 第 356 行（构造点第 323 行） | `async synthesize({ jobId, text, targetRef }) {`；第 353 行 `note: '真实 TTS 适配器（腾讯云 TextToVoice，共享凭据对；只能经注入式端口构造，应用装配路径不可达）'` |
| 90 | `gy-i13-synthesis-20261019.md` 第 37 行 → `services/api/src/tts/service.ts` 第 425 行 | `async function adjudicateExpiredJob(row: SynthesisJobRow): Promise<SynthesisJobRow> {` |
| 91 | 同页第 36／40 行 → 同文件第 561 行 | `async function execute(jobId: string): Promise<void> {` |
| 95 | `gy-r29-real-pg-arms-audit-20261022.md` 第 210 行 → `tests/integration/migrations-negative-pg.mjs` 第 232 行 | `const version = String((await admin.query('SHOW server_version')).rows[0].server_version);` |

## 4 改锚点形态（12 条）

适用判据：**符号/文件已不在仓内可寻址，而句子承载的是「当时看到过什么」或「旧文案怎么写的」**，强行给一个新行号只会让读者以为仓内有该证据。做法统一为：去掉可解析的行号，同句写明出处与「行号不再维护」。

| # | 文档（行） | 处置 | 理由 |
| 2／5 | `gy-i02-evidence-index-20261015.md` 第 20 行 | `.pg17/handoff/device-smoke-round3-1937.md` 去行号 | `.pg17` 是不入库的本地笔记（工具明确跳过该目录），本行真正的仓内证据是同行的 GitHub 评论 ID 与 `tools/smoke-wechat.cjs` |
| 3／4 | 同页第 21 行 | 同文件与 `note-issue171-user-confirmed.md` 去行号 | 同上 |
| 2／7 | 同页第 22 行 | `device-fullchain-a4-2044.md`、`note-issue168-achieved-2026-10-15.md` 去行号 | 同上 |
| 8 | 同页第 21 行 | `note-issue171-user-confirmed.md` 去行号 | 同上 |
| 3 | 同页第 23 行 | `device-retest-final-2156.md` 去行号 | 同上（400/200 原始日志行） |
| 6 | 同页第 158 行 | `recon-issue1-2-close-readiness.md` 去行号 | 同上；同页已自述该处「实读逐字成立」 |
| 9 | 同页第 158 行 | `STATE-current.md` 去行号 | 同上；该处本身已注明「已于同日更正」 |
| 10 | `gy-i28-demo-parity-20261018.md` 第 195 行 | `audit-demo-parity-20261018.md` 写成本页第 6 行已声明的 `.pg17` 分析依据 +「第 63 行」 | 该 audit 文件在仓外，同页开头已给绝对路径 |
| 11 | `gy-i22-closure-gap-20261018.md` 第 84 行 | `audit-issue-closure-20261018.md`（`.pg17` 笔记）去行号，改「第 320–330 行」 | 审核表原文只在仓外笔记里 |
| 14 | `gy-r28-favorites-history-grants-20261020.md` 第 187 行 | `experiment-locking.sql` 去行号，注明「一次性实验脚本、仓外 `.pg17/`、不入库」 | 全仓无该 `.sql`；同页第 215 行已写明原始日志在 `.pg17/handoff/r28-s26-logs/experiment-locking.log` |
| 33 | `docs/architecture/contract-implementation-status.md` 第 63 行 | 改成「旧文案把该处写成仓根 README 的第 459 行」 | 该句**引用的是旧错文案本身**，改成 `deploy/postgres-cvm/README.md` 会让句子自相矛盾；同步改了 `docs/architecture/contract-status.json` 第 447 行的同文（否则 `verify-contract-status.mjs` 的「中文表格一致」判漂移） |

## 5 未处理清单（52 条，全部保留在基线里）

| 组 | 条数 | 条目 | 为什么不动 |
| A 逐字转写的外部读数 | 17 | `.../auth_privacy.sql` 第 5 行（psql 报错原文）、`pg-protocol/dist/parser.js` 第 306 行 ×2、`sasl.js` 第 67 行、`pg-raise.sql` 第 14 行、`WAServiceMainContext.js`／`WASubContext.js` 第 1 行、`deploy/postgres-cvm/backup-postgres.sh` 第 268 行、`ocr-jobs-pg.mjs` 第 848 行、`recognitions-pg.mjs` 第 1010 行、`verify-cvm-postgres.sh` 第 326 行、`gy-i09-identify-loop-20261011.md` 第 334 行、`community.ts` 第 200／210／222／231／240 行 ×5 | 这些行号是**当时命令/栈帧/守卫打印出来的字面读数**，改数字＝篡改运行记录。其中 `:326` 那处 `\|\| true` 已被 R28-S44 返修移除（脚本第 338–345 行改为 `_applied_rc` 显式判失败），已无可重指目标；`ocr-jobs-pg.mjs`／`recognitions-pg.mjs` 现为 846／1008 行，旧读数天生越界 |
| B 自指的勘误 | 4 | `AGENTS.md` 第 34 行、`docs/moderation/http-layer.md` 第 204 行、`docs/pr-review-policy.md` 第 23 行、`services/api/src/media/object-store.ts` 第 132 行 | 文档原句就在说「这处引用是空行／已过期／已被删」。**引用空行就是被记录的勘误本身**，改掉等于抹掉勘误 |
| C 故意探针 | 5 | `probe-reverse-control.sql` 第 19／52／81 行、`services/api/src/messages/store-pg.ts` 第 99999 行、`services/api/src/privacy/ledger-pg.ts` 第 99999 行 | 本片派单指定「不是缺陷、不许动」；它们的价值是持续证明闸门会红 |
| D 目标未入库 / 虚拟夹具 | 6 | `deletion-registration.test.mjs`（真实文件叫 `deletion-registration-coverage.test.mjs` / `favorites-history-deletion-registration.test.mjs`）、`online-purge-pg.mjs` 第 58／89 行、`services/api/src/media/media.ts` 第 467 行、`tests/unit/fixtures/sql-column-coverage/nc1-fake-store-pg.ts`／`nc4-fake-store-pg.ts` | 这些路径**磁盘上从不存在**：`online-purge-pg.mjs` 全仓只在另一页被提及（未入库）；`media/media.ts` 不存在（媒体域源码为 `content-source.ts`／`object-store.ts`／`real-ports.ts`／`service.ts`）；两个 `nc*-fake-store-pg.ts` 是单测传进解析器的**内存虚拟夹具路径**（`sql-column-coverage.test.mjs` 第 1778／1894 行）。没有真实行可重指，改形态又会丢掉「守卫红字长什么样」这条信息 |
| E 无法唯一判定 | 20 | `history-api.js` 第 157／274 行、`app.ts` 第 1244 行、`packages/evaluation/samples/README.md` 第 27 行、`account-suspend-pg.mjs` 第 199 行、`backup-purge-pg.mjs` 第 440 行、`catalog-pg.mjs` 第 125 行、`recognition-chain-e2e.mjs` 第 120 行、`user-chain-e2e.mjs` 第 287 行、`model-ports.test.mjs` 第 156 行、`community-http.test.mjs` 第 506 行、`gy-i22-identity-headers.test.mjs` 第 567 行、`knowledge-api.test.mjs` 第 101 行 ×2、`miniprogram-favorites-history.test.mjs` 第 141 行、`miniprogram-voice-playback.test.mjs` 第 907 行、`recognitions-candidates-selection.test.mjs` 第 391 行、`tts-jobs-http.test.mjs` 第 129 行 ×2、`user-data-deletion.test.mjs` 第 127 行 | 命中位置附近有**多处同构实现或成组断言**，找不到「新行号那行必须含被引用符号」的唯一解。按红线：宁可留基线，不猜。典型如 `app.ts` 第 1244 行——全文不含被引用的 `doseCardEnabled`，最近的语义近邻是第 1603 行的 `createDeterministicDoseAuthority()` 装配点，但那是「dose 权威装配」而非「开关」，改过去会换掉引用语义 |

## 6 门禁读数（原文）

```text
$ node tools/verify-doc-anchors.mjs --strict
SCAN: 文档 219 份；抽出「路径:行号」引用 3348 条（解析成功 3188 条、同名多文件无法唯一解析 133 条不计红、同文档重复 22 条已去重）
COUNT: BROKEN 16 / OUT_OF_RANGE 5 / SUSPECT 31（合计 52 条；另只计数不判红：区间首行为空行 46 条、区间全是注释行 351 条）
BASELINE: tools/doc-anchors-baseline.json 登记 52 条；本次命中 52 条、基线外新增 0 条、陈旧 0 条
MODE: --strict（只在新增加非零时 exit 1）
PASS: --strict 下没有基线之外的新增（基线内条目只计数、不判红；陈旧条目见 STALE）
exit=0

$ npm run verify:anchors
PASS: 证据锚点 412 条引用自带锚点（区间内 240 条 + 仅整文件 172 条）；无锚点不可核 0 条（纯行号 0 + 无行号源文件 0 + 无用例名 0），只计数不判红
PASS: 纯行号区间 240 条（有实质内容 240 条；整段仅空白/收尾行 0 条、区间首行为空行 3 条，只计可疑不判红）
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
PASS: --strict 下没有基线之外的新增（基线内条目只计数、不判红；陈旧条目见 STALE）
exit=0

$ npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
…
研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
exit=0

$ python tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
exit=0

$ node --test tests/unit/doc-anchors-guard.test.mjs
ℹ tests 10  ℹ pass 10  ℹ fail 0
exit=0
```

## 7 复现

```text
node tools/verify-doc-anchors.mjs            # 全量读数 + STALE 清单
node tools/verify-doc-anchors.mjs --strict   # 门禁：基线外新增即 exit 1
node tools/verify-doc-anchors.mjs --write-baseline  # 重写基线（本轮由 108 降到 52）
```

基线文件由工具重写，**未手改 JSON**：`--write-baseline` 写的是「当前全量 findings」，陈旧条目会被自动清掉，所以「修好一条就必须删一行」这条不变量由工具保证，人不需要（也不应该）去删条目。

## 8 与 #464 的边界

本片与 `#464`（文档手写行号闸门的常驻维护）分工两点，写死免得下一片踩：

- **(a) 本片只处置基线里已登记的 108 条，不负责该 baseline 的 stale 重生成。** `tools/doc-anchors-baseline.json` 里那 108 条是已登记的历史硬伤，本片逐条实读后烧掉 56 条、判 52 条「不得改」，处置结果交回工具重写。**基线的日常 stale 重生成、以及「新出现的锚点问题要不要登记」属于 `#464`**，不在本片范围：本片没有、也不应该替后续改动预生成基线。
- **(b) 谁改了文档锚点，谁就必须重跑 baseline 生成器，否则 `doc-anchors-guard` 判 stale。** `tests/unit/doc-anchors-guard.test.mjs` 的「基线 stale 反查」要求基线的每一条都仍然命中——修好一条就要求删一行。所以顺序固定为「改文档 → `node tools/verify-doc-anchors.mjs` 看 STALE 读数 → `node tools/verify-doc-anchors.mjs --write-baseline` 落盘 → `--strict` 复跑」，⛔ 不手改 JSON（手改只会把基线写成免罚名单）。本片 108 → 52 就是这么落盘的：56 条 stale 全部由工具自动清除。

## 9 边界

本片只动 `docs/**` 与 `tools/doc-anchors-baseline.json`：没有改任何 `services/**`、`apps/**`、`miniprogram/**`、`tests/**`、`package.json`、`.github/**`。基线剩下的 52 条里，E 组（20 条）是**下一轮可以继续做**的部分——需要的是「按符号名 + 相邻语义」逐条实读，而不是批量加偏移。

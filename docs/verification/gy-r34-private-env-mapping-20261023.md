# R34 私密配置字段映射与 real 模式启动前置（2026-10-23）

本页只记「起 real 模式服务起不来」这条链路上**配置侧**的实测缺口、修法与可复算证据。
改动面限于 `tools/ai-config.mjs` 与它的测试/文档：`services/api/src/config.ts` 的判定逻辑一行未改。

## 1 结论（实测）

| 编号 | 缺口 | 现状 | 证据 |
| --- | --- | --- | --- |
| ① | 私密文件字段映射漏项（`sessionSigningKey` / `deletionLedgerKey` / 对象存储四键），9 项 real 前置只能由外部脚本逐对补环境变量 | **上游已修**：映射表 13 键全覆盖、`missingFields` 归零；本页补全表与双向守卫 | `tools/ai-config.mjs:14`、`tools/ai-config.mjs:132`、`tools/ai-config.mjs:140` |
| ② | `deepseekApiKey → DEEPSEEK_API_KEY` 被 `asChatProvider()` 当作 `CHAT_LLM_API_KEY` 的替代 ⇒ `CHAT_LLM_ENDPOINT` / `CHAT_LLM_MODEL` 升级为「有 key 则必须有」，缺任一即 `ConfigError` | **本切片修复**：默认值从既有白名单派生，`loadPrivateEnvironment()` 返回前补齐 | `services/api/src/config.ts:278`、`tools/ai-config.mjs:24`、`tools/ai-config.mjs:246` |

一句话：②不是「少配了环境变量」，而是两个**公开值**（端点、模型名）被当成了密钥级必需项。修在配置侧（补默认），不动判定。
改前/改后同一份实测输出见 §5。

## 2 私密字段 → 环境变量（全表）

映射表就是 `PRIVATE_ENV_PAIRS`（`tools/ai-config.mjs:140`）＝ 原有 10 条 `ENV_FIELDS`（`tools/ai-config.mjs:14`）＋ 追加 8 条（`tools/ai-config.mjs:132`）。
一个字段可以出多个变量名（只有 `databaseUrl` 如此），所以是「有序对」而不是对象字面量。**只用变量名，不记任何值。**

### 2.1 有键的 13 个字段

| JSON 字段 | 环境变量 | real 必需 | 说明 |
| --- | --- | --- | --- |
| `appid` | `WECHAT_APP_ID` | 是 | 必须逐字等于白名单账号，否则先报 `PRIVATE_ACCOUNT_MISMATCH` |
| `appsecret` | `WECHAT_APP_SECRET` | 是 | 小程序 AppSecret |
| `deepseekApiKey` | `DEEPSEEK_API_KEY` | 否 | 同时充当 `CHAT_LLM_API_KEY` 的替代（`config.ts` 的 `apiKeyFallback`） |
| `tencentSecretId` | `TENCENTCLOUD_SECRET_ID` | 否 | OCR/TMS/IMS/TTS 共用 TC3 对 |
| `tencentSecretKey` | `TENCENTCLOUD_SECRET_KEY` | 否 | 同上 |
| `tokenhubApiKey` | `TOKENHUB_API_KEY` | 否 | 杂草识别视觉模型 |
| `databaseUrl` | `GENGYUN_DATABASE_URL` + `DATABASE_URL` | 是（后者） | 旧名保留、新名追加，两个都落值 |
| `sessionSigningKey` | `SESSION_SIGNING_KEY` | 是 | 会话签名 |
| `deletionLedgerKey` | `DELETION_LEDGER_KEY` | 是 | 注销台账加密 |
| `objectStorageEndpoint` | `OBJECT_STORAGE_ENDPOINT` | 是 | 对象存储端点 |
| `objectStorageBucket` | `OBJECT_STORAGE_BUCKET` | 是 | 存储桶 |
| `objectStorageAccessKey` | `OBJECT_STORAGE_ACCESS_KEY` | 是 | 访问密钥 ID |
| `objectStorageSecretKey` | `OBJECT_STORAGE_SECRET_KEY` | 是 | 访问密钥 |

### 2.2 映射表里的 4 个可选字段

私密文件不写就不导出；写了也不参与 real 模式判定（只在对应能力被显式选用时才读）。

| JSON 字段 | 环境变量 | 说明 |
| --- | --- | --- |
| `tencentAsrSecretId` | `TENCENTCLOUD_ASR_SECRET_ID` | ASR 专用 TC3 对，优先于共用对 |
| `tencentAsrSecretKey` | `TENCENTCLOUD_ASR_SECRET_KEY` | 同上 |
| `tencentAsrSessionToken` | `TENCENTCLOUD_ASR_SESSION_TOKEN` | 临时凭证 |
| `tencentSessionToken` | `TENCENTCLOUD_SESSION_TOKEN` | 共用临时凭证 |

> 13 个有键字段是 2026-10-23 的实测字段集。私密文件新增键时，必须同时改映射表与 `tests/ai-config.test.mjs` 的 `PRIVATE_DOC_KEYS`，否则单测的「字段名集合恰好等于 13＋4」会红。

## 3 real 模式启动前置（表格化）

只需把私密文件交给 `loadPrivateEnvironment()`，再设 `APP_EXECUTION_MODE=real`；**不需要**调用方为下面每一行再补一遍环境变量。
「私密文件映射」一列是 §2 的来源；「显式 env」永远优先。

| 变量 | 来源 | 缺失时 |
| --- | --- | --- |
| `APP_EXECUTION_MODE` | 显式 env，取值 `real` | 非 real 模式走替身/演示，不校验真实凭据 |
| `DATABASE_URL` | 私密文件 `databaseUrl`（另导出旧名 `GENGYUN_DATABASE_URL`） | `ConfigError`，消息只列字段名 |
| `SESSION_SIGNING_KEY` | 私密文件 `sessionSigningKey` | 同上 |
| `DELETION_LEDGER_KEY` | 私密文件 `deletionLedgerKey` | 同上 |
| `WECHAT_APP_ID` | 私密文件 `appid`（须等于白名单账号） | 账号不符更早触发 `PRIVATE_ACCOUNT_MISMATCH` |
| `WECHAT_APP_SECRET` | 私密文件 `appsecret` | `ConfigError` |
| `OBJECT_STORAGE_ENDPOINT` | 私密文件 `objectStorageEndpoint` | 同上 |
| `OBJECT_STORAGE_BUCKET` | 私密文件 `objectStorageBucket` | 同上 |
| `OBJECT_STORAGE_ACCESS_KEY` | 私密文件 `objectStorageAccessKey` | 同上 |
| `OBJECT_STORAGE_SECRET_KEY` | 私密文件 `objectStorageSecretKey` | 同上 |
| `CHAT_LLM_ENDPOINT` | 显式 env，否则取白名单默认（**有 key、且两个键都未显式时才补**） | 绕过 `loadPrivateEnvironment()` 直接传 env 时才可能触发：有 key 却缺 → `ConfigError`（本切片修的就是这行） |
| `CHAT_LLM_MODEL` | 显式 env，否则取白名单默认（**有 key、且两个键都未显式时才补**） | 同上 |
| `CHAT_LLM_API_KEY` | 显式 env，否则回落 `DEEPSEEK_API_KEY`（= 私密文件 `deepseekApiKey`） | 两处都没有 → chat provider 为 `null`，不报错 |

9 项 `REQUIRED_WHEN_REAL`（`services/api/src/config.ts:147`、仓内镜像 `tools/ai-config.mjs:146`）就是上表第 2–10 行：只给私密文件即可 9/9 非空，单测与 §5 探针各自证明一遍。

## 4 `CHAT_LLM_*` 默认值的来源与可覆盖性

| 项 | 取值 | 位置 |
| --- | --- | --- |
| 白名单（唯一真源） | `endpoint: https://api.deepseek.com/chat/completions`，`model: deepseek-flash`，`keyEnv: DEEPSEEK_API_KEY` | `tools/ai-config.mjs:10` 的 `AI_ENDPOINTS.llm` |
| 派生常量 | `CHAT_LLM_DEFAULT_ENV = { CHAT_LLM_ENDPOINT: AI_ENDPOINTS.llm.endpoint, CHAT_LLM_MODEL: AI_ENDPOINTS.llm.model }` | `tools/ai-config.mjs:235` |
| 补齐点 | `applyChatProviderDefaults()`：拿到 key、且两个键都未显式时才补，只补「为空/未设」的那一个 | `tools/ai-config.mjs:246`、由 `tools/ai-config.mjs:24` 在返回前调用 |
| 可覆盖 | **仅在两个键都未显式时补默认**。显式 `CHAT_LLM_ENDPOINT` / `CHAT_LLM_MODEL` 一个字符都不改；任一显式即整对不补，半配置交回 `asChatProvider()` 报 `ConfigError`；优先级为 显式 env > 私密文件 `deepseekApiKey` > 默认值 | `tools/ai-config.mjs:248` |
| 不补的情况 | ① 两处 key 都没有 → 一个都不补，避免把「没配 LLM」误判成「配错了 LLM」；② 端点/模型任一显式（半配置）→ 整对一个都不补，缺的那半由 `ConfigError` 点名 | `tools/ai-config.mjs:247` |

默认值不新造第二份字符串：改 `AI_ENDPOINTS.llm` 就等于改默认值，两处不可能分叉。

## 5 证据

### 5.1 一次性探针（仓外，只用公开 API）

脚本 `.pg17\tmp\gy-ai-config-real-mapping\probe-real-boot.mjs`（不入库）：`loadPrivateEnvironment()` 加载真实私密文件 → 数出 9 项前置是否 nonempty → 把结果交给 `services/api/src/config.ts` 的 `loadConfig()` 判定 real 模式。只打印**变量名**与计数，不打印任何值。

```text
# 改前（upstream/main 5a449305 + 本切片未提交时）
REQUIRED_WHEN_REAL satisfied=9/9
satisfied names=DATABASE_URL,SESSION_SIGNING_KEY,DELETION_LEDGER_KEY,WECHAT_APP_ID,WECHAT_APP_SECRET,OBJECT_STORAGE_ENDPOINT,OBJECT_STORAGE_BUCKET,OBJECT_STORAGE_ACCESS_KEY,OBJECT_STORAGE_SECRET_KEY
loadConfig=FAIL name=ConfigError issueFields=CHAT_LLM_ENDPOINT,CHAT_LLM_MODEL count=2

# 改后（本切片）
REQUIRED_WHEN_REAL satisfied=9/9
satisfied names=DATABASE_URL,SESSION_SIGNING_KEY,DELETION_LEDGER_KEY,WECHAT_APP_ID,WECHAT_APP_SECRET,OBJECT_STORAGE_ENDPOINT,OBJECT_STORAGE_BUCKET,OBJECT_STORAGE_ACCESS_KEY,OBJECT_STORAGE_SECRET_KEY
loadConfig=OK executionMode=real chatProvider=present objectStorage=present
```

读法：①（字段映射）在改前就已经是 9/9——它确实已由上游修完；②（`CHAT_LLM_*`）是改前唯一让 real 模式起不来的东西，两个字段名一条不差，改后归零。

### 5.2 单测

`node --test tests/ai-config.test.mjs` → `tests 17 / pass 17 / fail 0`（其中 4 条为本切片新增，全部合成值、不读真实凭据）：

| 用例 | 钉住什么 |
| --- | --- |
| `all thirteen documented private keys map to allowlisted variable names, none to zero` | 13 键逐一有映射；表内字段名恰好是 13＋4；只有 `databaseUrl` 一字段两名 |
| `thirteen-key private file alone satisfies every required real-mode variable with the right value` | 每个合成标记落在自己的变量名上；13 键文件即 9/9，`missingFields` 为空 |
| `the real-mode gap report names variables only and never echoes a value` | 缺口报错逐字等于 `MISSING_REAL_MODE_ENV:SESSION_SIGNING_KEY,OBJECT_STORAGE_BUCKET`，且反查不含任何合成值 |
| `CHAT_LLM defaults come from the allowlist, lose to explicit env, and never appear without a key` | 默认值 = 白名单；显式 env 优先；无 key 不补、不虚造 `CHAT_LLM_API_KEY`；半配置（只给端点或只给模型）一个都不补，缺的那半由 `asChatProvider()` 报 `ConfigError` |

### 5.3 门禁

| 命令 | 结果 |
| --- | --- |
| `node --check tools/ai-config.mjs` | exit 0（CI `access-verification` 的第一条） |
| `node --test tests/ai-config.test.mjs` | `tests 17 / pass 17 / fail 0` |
| `npm run verify:anchors` | PASS：`--strict` 下基线之外新增 0 条（本页 13 处行号引用全部可解析、区间有实质内容：`tools/ai-config.mjs` 10 处（第 10/14/24/132/140/146/235/246/247/248 行）＋ `services/api/src/config.ts` 2 处（第 147、278 行）＋ `docs/verification/README.md` 1 处（第 52 行）） |
| `npm run test:docs` | PASS：27 initial tasks、Markdown 链接与表格、`docs/research` 结构 |

### 5.4 私密文件的键名实读（只打名字，不打印任何值）

`node .pg17/tmp/gy-ai-config-real-mapping/probe-private-keys.mjs`（仓外脚本，用 `parseJsonc` 解析后只输出 `Object.keys()`）：

```text
keyCount=13
keys=appid,appsecret,databaseUrl,deepseekApiKey,deletionLedgerKey,objectStorageAccessKey,objectStorageBucket,objectStorageEndpoint,objectStorageSecretKey,sessionSigningKey,tencentSecretId,tencentSecretKey,tokenhubApiKey
unmappedKeys=none
requiredFields=9
```

`unmappedKeys=none` 即 §2.1 的 13 行与文件逐一对应；`requiredFields=9` 且无 `noMappingFor` 行，即 9 个 real 必需变量全有映射来源。

## 6 未做与风险

- **没改** `services/api/src/config.ts`：判定逻辑（有 key 就必须有端点/模型）归该模块，本切片只在配置侧补公开默认值。若将来要改成「端点/模型各自独立可选」，那是另一处判定变更，应单独评审。
- 默认模型是白名单里的 `deepseek-flash`；业务若要换模型，改 `AI_ENDPOINTS.llm` 一处即可，但会同时影响手工验证脚本的模型断言。
- `CHAT_LLM_API_KEY` 不由 `loadPrivateEnvironment()` 导出（私密文件只提供 `deepseekApiKey`）：`config.ts` 走 `apiKeyFallback`，这是既有语义，本切片没有改。
- 探针读的是真实私密文件，但只输出变量名与计数；脚本放在仓外，不入库、不进 CI。
- 「13 键」是 2026-10-23 的字段集：私密文件新增键时映射表与单测需同步（见 §2 末尾提示）。
- 本页**没有**加进 `docs/verification/README.md` 的文件清单：那张表在 §1，新增一行会把该文件后续行号整体下移，实测让另一份证据页（`gy-r34-tencent-ai-samples-20261023.md`）对 `docs/verification/README.md:52` 的引用从「有实质内容」变成「空行」，`verify-doc-anchors --strict` 因此多报一条 SUSPECT；而索引并非必需项（同目录 260 份证据页大多不在该表内），故不改 README。

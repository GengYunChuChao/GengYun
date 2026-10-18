# 评估链读数改用结构化断言：为什么不再加字面量（2026-10-18）

范围：`tools/evaluation/verify-gate-readout.mjs` 新增**第 4 个参数**（`run-evaluation.mjs --out` 落盘的报告 JSON）。三参模式（只读三份日志）逐字不变；本记录说明四参模式下为何用 **JSON Schema 结构校验**替代再补一批字面量，以及本项目 `packages/evaluation/schema/run-report.schema.json` 的可复用面。

## 检索

- 检索日期：2026-10-18（本机 `Get-Date` 实测，UTC+08:00）。
- 检索词（原文）：`json schema 2020-12 "$schema" keyword`、`node:test stability`、`node:assert strict`、`RUNNER_TEMP`、`workflow syntax for GitHub Actions`。
- 检索方式：`curl.exe -sSL` 逐条直抓页面并先核对 HTTP 200，再脱标签在关键字附近取证；未走镜像、未凭记忆，未使用站内搜索。六条 URL 的抓取结果见「来源」。

## 来源（均已实际打开，均返回 HTTP 200）

| 技术 | 本轮实抓 URL（每项 ≥2 条） | 版本证据（页面实测） |
| --- | --- | --- |
| JSON Schema 2020-12（报告 schema 的方言） | <https://json-schema.org/draft/2020-12/json-schema-core.html> · <https://json-schema.org/draft/2020-12/json-schema-validation.html> | 核心页页眉 `Internet-Draft: draft-bhutton-json-schema-01`、`Published: 16 June 2022`；两页同属 2020-12 系列（core／validation 分册） |
| Node.js `node:test`／`node:assert`（本片测试载体） | <https://nodejs.org/api/test.html> · <https://nodejs.org/api/assert.html> | `node:test` 页写 `Added in: v18.0.0, v16.17.0`、`v20.0.0 The test runner is now stable`、`Stability: 2 - Stable`；本仓 CI 固定 Node `24.16.0` |
| GitHub Actions workflow 语法（`$RUNNER_TEMP` 与落盘约定） | <https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions> · <https://docs.github.com/en/actions/reference/variables-reference> | 变量页给 `RUNNER_TEMP`：`The path to a temporary directory on the runner`（每个 job 首尾清空），即 workflow 里 `$out` 的取值来源 |

## 字段

- 现用版本：JSON Schema 2020-12（`packages/evaluation/schema/run-report.schema.json` 的 `$schema` 指向 `https://json-schema.org/draft/2020-12/schema`）；Node.js `24.16.0`（`.github/workflows/evaluation-chain.yml` 的 `setup-node` 固定值）；GitHub Actions 语法无版本号，按 2026-10-18 抓取快照引用。
- 上游维护状态：JSON Schema 规范这一版发布于 2022-06-16（页面页眉实测），2020-12 仍是站点当前推荐方言；`node:test` 自 v20.0.0 起 `Stability: 2 - Stable`，本片用到的 `test`／`after`／`spawnSync` 都在稳定面；GitHub Docs 持续更新且不发行版本号。
- 可复用部分：复用的是**本仓自己的 schema**，不是第三方库——`run-report.schema.json` 已把「什么算真实评估」写成机器可判的字段（`isRealEvaluation` 为 `boolean`、`tasks[*].gateStatus` 的 `enum` 为 `pass`／`fail`／`not_evaluated`、`gaps[*].missing` 为 `integer`）。断言脚本只读这四个字段面，因此新增字段不需要改断言。计数命令与读数见「复现」；三项读数为 `13`／`4`／`5`／`3`、`7 tasks / 17 gaps / 16 under`、`10`。
- 许可证与署名：JSON Schema 规范页声明 Code Components 须「include Revised BSD License text as described in Section 4.e of the Trust Legal Provisions」，引用其关键字名与语义时须保留该 Revised BSD 声明；`nodejs.org` 与 `docs.github.com` 页面**未标注**内容许可（脱标签后检索 `License`、`Creative Commons` 均 0 命中）⇒ 本记录只做最小摘录与链接，不复制正文。
- 兼容性：报告由本仓 `run-evaluation.mjs` 产出，`$schema` 已固定 2020-12，`schemaVersion` 为 `1.0.0`；断言脚本零依赖、只用 `node:fs` 读文件，不引第三方校验器 ⇒ 不改 `package.json`、不加运行时依赖，Node 24 与 CI 一致。
- 引入成本：0 行依赖、0 个新文件（改动都在既有 `verify-gate-readout.mjs`）；断言从 8 条字面量扩到 8 条字面量 ＋ 10 条结构化；回归测试 15 例，单次全跑约 1.2 s。
- 决定：三参模式**逐字保留**（8 条字面量一条不改，输出字节与改前一致），四参模式**只**按 schema 字段核形状与取值，不再加「第 9 条字面量」。理由三条：①字面量断言的绿只证明「这串字符出现在某处」，报告少一个 task、`gateStatus` 被记成 `pass`、缺口桶数字被改一位都能绿；②结构化断言与 `run-report.schema.json` 同源，字段名／枚举值改错会在测试里红，不会静默放宽；③「空集」必须判红——`tasks`／`gaps` 为空、日志缺「样本缺口桶」行都算证据不足，不当通过。

## 未取得

- `nodejs.org` 与 `docs.github.com` 页面没有内容许可声明，未取得可引的许可文本，故只引用事实短句与链接。
- 未安装 `ajv` 等第三方校验器，未实测其体积与启动开销；本片按零依赖红线刻意不引入。
- 未取得 `docs.github.com` 的页面版本号或提交号（站点不公开），只记抓取日。

## 复现（2026-10-18 本机实跑）

```text
# 1) schema 的结构面：顶层必填 / task 必填 / gap 必填 / gateStatus 枚举值个数
node -e "const s=require('./packages/evaluation/schema/run-report.schema.json');console.log(JSON.stringify({required:s.required.length,taskRequired:s.properties.tasks.additionalProperties.required.length,gapRequired:s.properties.gaps.items.required.length,gateStatusEnum:s.properties.tasks.additionalProperties.properties.gateStatus.enum.length}))"
⇒ {"required":13,"taskRequired":4,"gapRequired":5,"gateStatusEnum":3}

# 2) 真实报告的形状读数（run-evaluation.mjs --out 的产物）
node -e "const r=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));console.log(Object.keys(r.tasks).length+' tasks / '+r.gaps.length+' gaps / '+r.gaps.filter(g=>g.missing>0).length+' under')" <报告路径>
⇒ 7 tasks / 17 gaps / 16 under

# 3) 四参模式的结构化断言行数（三份日志 + 报告）
node tools/evaluation/verify-gate-readout.mjs <run-evaluation.log> <freeze-real-samples.log> <validate-evaluation-samples.log> <报告> | grep -c '^PASS 结构化断言：'
⇒ 10
```

命令 3 的分母：四参全绿时 `PASS` 共 19 行（8 条字面量 ＋ 10 条结构化 ＋ 1 条总括）；三参全绿时 9 行。读数与 `.pg17/handoff/impl-eval-readout-structured.md` 里贴的原始输出一致。

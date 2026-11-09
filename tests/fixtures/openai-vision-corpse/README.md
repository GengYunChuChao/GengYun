# `openai-vision-v1` 历史失败响应体（真尸体）

这 12 个 `.txt` 是**原样抄下来的 HTTP 响应体**（供应商 200 回包，整份 JSON，含 `choices` / `usage`），
用来回归 `services/api/src/recognitions/openai-vision-adapter.ts` 的正文解析与观测。

- 采集方式：用生产代码生成请求体（同一张 `01-Eleusine_indica.jpg`、同一剖面），直连供应商串行连打 120 次。
- 120 次里 12 次失败，**全部**是「HTTP 200 但 `message.content` 解析不出 JSON 对象」；连接断类 0 次。
- 抄进仓库的**只有 body 文本**：没有图片（原始照片 161 KB）、没有 `Authorization`、没有端点。
  回包自带的 `id` 是供应商侧的调用 id，不含凭据。

| 文件 | `finish_reason` | `completion_tokens` | `content.length` | 形态 |
| --- | --- | --- | --- | --- |
| `structure-trailing-dollar.txt` | `stop` | 186 | 98 | 候选对象后尾随 `$` |
| `structure-trailing-prose.txt` | `stop` | 246 | 126 | 候选对象后尾随散文 `The answer has been given.` |
| `structure-echoed-json-object.txt` | `stop` | 202 | 121 | 候选对象后回显请求里的 `{"type": "json_object"}` |
| `structure-trailing-caret.txt` | `stop` | 422 | 102 | 候选对象后尾随 `^` |
| `structure-duplicated-object.txt` | `stop` | 306 | 194 | 同一候选对象连吐两遍 |
| `structure-missing-brace.txt` | `stop` | 287 | 97 | 缺最后一个 `}` |
| `structure-array-tail.txt` | `stop` | 198 | 96 | 候选对象后多出数组闭合 `]}` |
| `budget-empty-a.txt` | `length` | 512 | 0 | `content=""`（预算被「思考」吃光） |
| `budget-empty-b.txt` | `length` | 512 | 0 | `content=""` |
| `budget-empty-c.txt` | `length` | 512 | 0 | `content=""` |
| `budget-empty-d.txt` | `length` | 512 | 0 | `content=""` |
| `budget-truncated-string.txt` | `length` | 512 | 73 | JSON 断在 `reason` 字符串中间 |

7 个结构类尸体的 `species_id` 都是 `species_goosegrass`；预算类断掉的那个写了 `species_crabgrass`，
但**断在字符串里**——解析阶梯不得把它猜出来（`reason` 未闭合，补 `}` 也救不回）。

回归用例：`tests/unit/recognitions-openai-vision-corpses.test.mjs`。
证据页：[`docs/verification/gy-r94-vision-parse-hardening-20261110.md`](../../../docs/verification/gy-r94-vision-parse-hardening-20261110.md)。

⛔ 这些尸体只说明「解析器对历史失败形态的处置」，不构成本机演示口径之外的任何能力主张。

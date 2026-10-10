# GY-I07 生成资料检查的 CRLF 兼容修复

关联 `Refs #7`，仅修复检查器的换行误报，不关闭整项查询/来源验收。基线 main `427ddb448b7e315719de8e03ba6ca048fa2e8246`，Windows／Node 24.16.0。保留已审 PR #73 的研究分支和提交，本次使用独立分支 `fix/gy-i07-generated-crlf-check-20261011`。

## 触发与修复

本机 `git ls-files --eol miniprogram/data` 的10份文件均为 `i/lf w/crlf`。修改前真实运行 `node tools/knowledge/build_miniprogram_data.mjs --check`：10份全部报 `[drift]`，退出1。检查器生成LF文本，却直接与Git在Windows检出的CRLF工作树比较；未发现需要修改资料值的理由。

检查模式现在只将实际文件的 **CRLF字节对对应的文本序列转换为LF**，再与确定生成的LF文本逐字比较。未调用 `trim`、未过滤全部空白、未将实际文件解析成JSON重排、未忽略字段或注释。孤立CR、BOM、缩进、尾换行、键/数组顺序及JSON字符串内的转义内容仍参与比较。

生成模式不变，仍输出确定的LF；`--check`不创建、重写或修复文件。仅改检查器、专门回归及本说明；`miniprogram/data`、生产资料、迁移、数据库、小程序UI及来源状态均未改动。

## 验证

专门回归复制实际CLI到隔离临时目录，建立10份**合成**资料输入；不复制或改写仓库真实资料。运行实际生成和检查入口，用字节快照断言检查前后相等，结束只清理所创建的临时目录。旧实现上的全CRLF、混合LF/CRLF两例先实际失败，再修复运行。

| 路径 | 实际结果 |
| --- | --- |
| LF、全CRLF及混合换行 | 全部通过，检查不改字节 |
| 隔离副本重新生成 | 恢复确定LF，生成结果与原LF字节快照完全一致 |
| 字段值篡改、删除字段、键顺序、数组顺序 | 退出1、准确报告目标漂移、不重写 |
| 缩进变化、缺末尾换行、增尾换行、孤立CR、BOM | 退出1、不吞格式差异、不重写 |
| JSON字符串内 `\\r\\n` 改为 `\\n` | 退出1，转义数据不被换行归一化吞掉 |
| 缺生成文件、源文件字段变化 | 退出1，不补文件、不自动更新生成物 |
| 真实10份CRLF工作树 `--check` | 退出0，字节快照前后相同 |

实际执行命令：

```text
node --test --test-reporter=tap --test-concurrency=1 tests/reference/generated-data-check.test.mjs
node --test --test-reporter=tap --test-concurrency=1 "tests/reference/*.test.mjs"
node tools/knowledge/build_miniprogram_data.mjs --check
python tools/knowledge/validate_knowledge.py --root .
python tools/validate_development_docs.py
git diff --check
```

专门回归14/14通过，参考域完整回归110/110通过；知识和文档校验及diff检查通过。独立clone最初未安装依赖，参考域契约测试报缺少ajv；执行锁文件安装 `npm ci --ignore-scripts --no-audit --no-fund` 后重跑得到上述完整结果，未把缺依赖那次计为通过。新回归位于现有 `test:reference` 与 `test:unit` glob内，不新增或绕开CI入口。实际本地Node为24.16.0；监工先前的24.19.0报告是其独立环境，不混为本次运行。

## 未解除的资料与链路缺口

修复只证明LF/CRLF形式相同的生成文本可一致检查，不证明药剂有效、当前核准版本、图示完整或可训练。现有知识校验仍 `card_eligible=0`、`usable_as_dose=0`。PR #73 所列源站直接403、完整原件/有效期/许可未知，以及#7的真实HTTP/登录、微信工具与Android真机剩余验收保持原状态。没有付费请求或部署；等待监工对固定提交SHA独立审查，作者不批准/合并。

# 2026-10-18 当前技术栈复用决策基线

- 基线：`d4e6b2d0a5ee8376f9661a4bd34962602b98370d`（2026-10-18 返修时 `git rev-parse upstream/main` 逐字实测；首版记录基线为 `98658d563f7fb35dc5518fda8117a0100aecbd56`，因上游前进 9 个提交，本文件所有计数已按新基线重算，见 §0 计数口径）。
- 检索日期：2026-10-18。
- 检索方式：直接抓取官方页面／官方 API，**未使用检索词**；逐项 URL 与读数见各节「检索来源」与 §8。
- 口径：只写本轮实测读数；取不到的写「未取得」并说明原因（§9），不按已确认处理，不补写任何历史片当时的调研。

## 0 总览

| 技术 | 仓库现用 | 上游状态（2026-10-18 读数） | 决定 | 来源数 |
| --- | --- | --- | --- | --- |
| Node.js | 24.16.0（engines `>=24.16.0 <25`） | 24 为 Active LTS，2026-10-20 转维护期，EOL 2028-04-30 | 沿用；补丁可升 24.22.0 | 2 |
| TypeScript | 5.9.3 | 上游 latest 7.0.2（2026-08-20 发布） | 沿用；跨大版本迁移单独立项 | 2 |
| Fastify | 5.12.5 | 文档站 latest 5.12.7；5.x 支持期内（End Of LTS 未定） | 沿用 5.12.x | 2 |
| PostgreSQL | 17.11（CI 镜像） | 17.11 为当前小版本，支持到 2029-11-08 | 沿用 PG17，不跨大版本 | 2 |
| 微信小程序原生框架 | 原生 + 基础库 3.17.3 | 基础库随客户端携带上一稳定版发布，灰度 12–24 小时 | 沿用；升级约束见 §5 | 1（部分未取得） |
| Python | 3.11+（文档校验脚本） | 3.14 处于 bugfix（EOL 2030-10） | 沿用标准库脚本 | 2 |
| GitHub Actions | ubuntu-24.04，checkout/setup-node 固定 SHA | checkout pin = v4.2.2（轻量 tag）；setup-node pin = v4.4.0（`refs/tags/v4` 同指） | 沿用固定 SHA 策略 | 2 |

计数口径（均在基线 `d4e6b2d0…` 上实测，三个口径互不相等、不可互相外推）：`workflow 文件数` = `git ls-tree -r --name-only HEAD .github/workflows/` ⇒ 11；`含 node-version: '24.16.0' 的 workflow 数与出现次数` = `git grep -l "node-version: '24.16.0'" -- .github/workflows` ⇒ 10 个、`git grep -o …` ⇒ 15 处；`含 image: postgres: 的 workflow 数` = `git grep -l "image: postgres:" -- .github/workflows` ⇒ 6 个（5×`postgres:17.11`＋`workbook-staging.yml` 的 `postgres:17`）。差异来源：`development-docs.yml` 不含 setup-node，`evaluation-chain.yml` 不含 PG 镜像。

## 1 Node.js

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `node -p "JSON.stringify(require('./package.json').engines)"` ⇒ `{"node":">=24.16.0 <25","npm":">=11.13.0"}`；`git grep -l "node-version: '24.16.0'" -- .github/workflows` ⇒ 10 个 workflow，`git grep -o "node-version: '24.16.0'" -- .github/workflows` ⇒ 15 处（11 个 workflow 文件中只有 `development-docs.yml` 不含 setup-node）；`node -p "require('./package-lock.json').packages['node_modules/@types/node'].version"` ⇒ 24.19.1；本机 `node --version` ⇒ v24.16.0 |
| 上游维护状态 | 24（Krypton）为 Active LTS：current 支持阶段到 2026-10-20 转入维护期，EOL 2028-04-30；本轮最新 24.22.0（2026-10-14）。26 于 2026-10-28 转 LTS，最新 26.12.0（2026-10-14）；22 EOL 2027-04-30；25 已于 2026-06-01 EOL |
| 可复用部分 | 全仓工具链：39 个 `tools/**/*.mjs` 脚本经 `npm run …` 驱动（`git ls-files "tools/*.mjs" "tools/**/*.mjs"` ⇒ 39 行）；10 个 workflow 用 `node-version: '24.16.0'`（15 处）；`services/api` 与 `apps/admin` 的 npm scripts、`tests/**` 全部跑在 Node 24 上 |
| 许可证与署名 | 未取得（本轮未抓取 nodejs/node 的 LICENSE，不以记忆填写） |
| 兼容性 | engines 锁 `>=24.16.0 <25` ⇒ 当前无法用 Node 26；TypeScript target ES2023、module/moduleResolution `nodenext` 依赖 Node 24 的 ESM 行为；CI 11 个 workflow 文件全部 `ubuntu-24.04`（`git grep -l "runs-on:" -- .github/workflows` ⇒ 11 个文件、17 个 job） |
| 引入成本 | 已在用，无新增依赖 |
| 决定 | 沿用 24.x LTS。理由：仍在支持期内，engines 与 CI 已锁同一条线；补丁沿 24 线升到 24.22.0 不需要改 engines（留后续片）。待升级：Node 26 需同时改 engines、tsconfig 目标与 CI 版本，本片不做 |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://endoflife.date/api/nodejs.json | cycle 24：lts 2025-10-28、support 2026-10-20、eol 2028-04-30、latest 24.22.0（2026-10-14）；cycle 26：lts 2026-10-28、eol 2029-04-30、latest 26.12.0 |
| 2 | https://nodejs.org/en/about/previous-releases | v24 Krypton 为 LTS，latest LTS v24.22.0；v26 为 Current；策略：Current 约 6 个月后转 LTS，LTS 通常 30 个月修 bug，生产只用 Active/Maintenance LTS |

## 2 TypeScript

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `node -p "require('./package-lock.json').packages['node_modules/typescript'].version"` ⇒ 5.9.3；许可证字段 Apache-2.0；`@types/node` ⇒ 24.19.1；`services/api/tsconfig.json`：target ES2023、module `nodenext`、strict、verbatimModuleSyntax、erasableSyntaxOnly、rewriteRelativeImportExtensions |
| 上游维护状态 | 本轮 latest 7.0.2：npm 元数据 2026-10-18 读数，license Apache-2.0，engines `node >=16.20.0`，`type: module`；GitHub release v7.0.2 发布于 2026-08-20，说明指向 devblogs 的 TypeScript 7.0 公告，并注明最初在 typescript-go 仓库发布（原生移植编译器） |
| 可复用部分 | 类型检查面：`services/api/tsconfig.json` 的 `include` 覆盖 `services/api/src` 175 个 `.ts`（`git ls-files "services/api/src/**/*.ts"` ⇒ 175）；`apps/admin/tsconfig.json` 覆盖 4 个 `.ts`（`src/App.vue` 不在 tsc 面内）；`tools/lint-workspaces.mjs` 对两个 tsconfig 各跑一次 `node node_modules/typescript/bin/tsc -p <cfg> --noEmit`（`npm run lint` 第一步） |
| 许可证与署名 | Apache-2.0（npm 元数据读数）；署名要求需按 Apache-2.0 保留 NOTICE/版权声明，具体以官方许可页为准——本轮未抓取许可全文 ⇒ 细节未取得 |
| 兼容性 | 5.9.3 与 7.x 是两个编译器世代（7.x 为 Go 原生移植），`tsc -p --noEmit` 的诊断与规则差异未验证；仓库 `npm run lint` 依赖本 worktree 的 `node_modules/typescript/bin/tsc`（本片在自有 worktree 独立 `npm ci`，未建任何联接） |
| 引入成本 | 升级到 7.x 的成本未实测（需重跑 lint/typecheck 与受影响测试） |
| 决定 | 沿用 5.9.3。理由：本轮只确认上游 latest 与许可证，未验证 7.x 对本仓库 tsconfig 组合（erasableSyntaxOnly／verbatimModuleSyntax／rewriteRelativeImportExtensions）的兼容性与错误差异；跨大版本迁移单独立项，不在本片 |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://registry.npmjs.org/typescript/latest | 7.0.2，Apache-2.0，engines node >=16.20.0，unpackedSize 2497498，含平台二进制 optionalDependencies |
| 2 | https://api.github.com/repos/microsoft/TypeScript/releases/latest | tag v7.0.2，published_at 2026-08-20，正文链接 announce blog，并说明最初在 typescript-go 仓库发布 |

## 3 Fastify

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `node -p "require('./package-lock.json').packages['node_modules/fastify'].version"` ⇒ 5.12.5；`services/api/package.json` dependencies 为 `fastify: 5.12.5`；许可证字段 MIT |
| 上游维护状态 | 文档站 latest 显示 v5.12.7；LTS 政策：每个 major 自发布起至少支持 6 个月，转入下一个 major 后再给 6 个月安全更新；5.0.0 于 2024-09-17 发布，End Of LTS 为 TBD；测试覆盖 Node.js LTS 线（表列 Node 20、22）；另提供 HeroDevs 商业支持 |
| 可复用部分 | HTTP 装配层：`services/api/src/app.ts` 的 `buildApp` 是唯一装配入口，26 个文件 `from 'fastify'`（`git grep -l "from 'fastify'" -- services/api` ⇒ 26，含插件、路由与错误映射）；`tests/integration/*.mjs` 27 个脚本经 `buildApp` 装配后跑真实回环（`npm run test:integration:http`） |
| 许可证与署名 | MIT（npm 元数据读数）；MIT 要求保留版权与许可声明，具体文本本轮未抓取 ⇒ 全文未取得 |
| 兼容性 | 仓库 API 为 `type: module` 的 ESM；Fastify 5 支持 ESM，但本仓库用到的插件组合未在本片验证；上游测试矩阵列 Node 20/22，未列 24，属未知项 |
| 引入成本 | 已在用；上游包 unpackedSize 2970996（约 2.97 MB），15 个运行时依赖 |
| 决定 | 沿用 5.12.x。理由：仍在 LTS 政策覆盖内，补丁 5.12.5 → 5.12.7 属次版本；升级需读 changelog（本轮未抓取）⇒ 变更内容未取得，升级留后续片 |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://fastify.dev/docs/latest/Reference/LTS/ | 支持政策原文（major ≥6 个月 + 6 个月安全更新）、5.0.0 发布日 2024-09-17、End Of LTS 为 TBD、测试 Node 20/22 |
| 2 | https://registry.npmjs.org/fastify/latest | 5.12.7，MIT，`type: commonjs`，15 个运行时依赖（pino、rfdc、avvio 等），unpackedSize 2970996，无 engines 字段 |

## 4 PostgreSQL

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `git grep -n "image: postgres:" -- .github/workflows` ⇒ 5 个工作流用 `postgres:17.11`（auth-privacy、catalog、consent-grant、source-lifecycle、staging-intake 的第 14 行），`workbook-staging.yml:22` 用 `postgres:17`；迁移目录 `services/api/db/migrations`；`docs/development-guide.md:24` 写「PostgreSQL 17」 |
| 上游维护状态 | 每个大版本支持 5 年：17 当前小版本 17.11，首版 2024-09-26，支持到 2029-11-08；18 为 18.6（支持到 2030-11-14）；19 的 RC1 于 2026-10-15 发布（站点横幅），尚未 GA；13 及更早已停止支持 |
| 可复用部分 | 数据层：`services/api/db/migrations` 33 个迁移 `.sql`（`git ls-files "services/api/db/migrations/*.sql"` ⇒ 33）＋`deploy/postgres-cvm/sql` 2 个角色/最小权限脚本；`services/api/src/db/pool.ts` 的 `Pool` 连接由 7 个 `from 'pg'` 的文件使用；6 个 CI workflow 起 PG 容器跑集成测试（5×`postgres:17.11`＋`workbook-staging.yml` 的 `postgres:17`） |
| 许可证与署名 | PostgreSQL License（BSD/MIT 风格）：允许使用、复制、修改、分发，需保留版权与许可段落，无担保；署名要求即保留该段落 |
| 兼容性 | 迁移、角色脚本与集成测试只在 PG17 验证；PGlite 0.5.8 是 PG18 内核的内存引擎，单测不等价于 17.11 实库验收（仓库既有口径） |
| 引入成本 | 已在用；CI 服务容器由 GitHub 托管 |
| 决定 | 沿用 PG17，不跨大版本。理由：17 支持到 2029-11-08；迁移、角色脚本与 6 个含 `image: postgres:` 的 CI workflow（5×`postgres:17.11`＋`workbook-staging.yml` 的 `postgres:17`）都建立在 17 上；升 18 或 19 需重跑实库验收与最小权限角色脚本，属单独立项 |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://www.postgresql.org/support/versioning/ | 17.11 supported，final 2029-11-08，first 2024-09-26；18.6 至 2030-11-14；14.24 至 2026-11-12；横幅显示 PostgreSQL 19 RC1（2026-10-15） |
| 2 | https://www.postgresql.org/about/licence/ | PostgreSQL License 条款：保留版权与许可段落、无担保、允许使用/复制/修改/分发 |

## 5 微信小程序原生框架

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `node -p "require('./project.config.json').libVersion"` ⇒ 3.17.3；`miniprogram/project.config.json` 同为 3.17.3；`compileType` 为 `miniprogram`；无第三方小程序框架依赖 |
| 上游维护状态 | 官方「基础库/客户端版本」文档：基础库由客户端携带「上一个稳定版本」发布，新基础库发布后后台灰度约 12–24 小时；高版本基础库无法在低版本客户端运行；major/minor 更新依赖新客户端，patch 一般不需要。稳定版版本号未取得（开发者工具稳定版页本轮只返回导航，无版本读数） |
| 可复用部分 | 客户端全部由 `miniprogram/` 承载：145 个文件（`git ls-files "miniprogram/**"` ⇒ 145，其中 `miniprogram/pages/**` 72 个），页面经 `miniprogram/utils/**` 调用 API；基础库 3.17.3 由根 `project.config.json` 与 `miniprogram/project.config.json` 两处共同锁定，开发者工具按 `miniprogramRoot` 编译 |
| 许可证与署名 | 未取得（本轮未抓取开发者工具/基础库许可条款，不凭记忆填写） |
| 兼容性 | 基础库 3.17.3 由开发者工具锁定；升级受客户端覆盖率与灰度窗口约束；真机版本矩阵本片未复核 |
| 引入成本 | 已在用，无新增依赖 |
| 决定 | 沿用原生框架与 3.17.3。理由：无第三方框架依赖，升级窗口受客户端覆盖率限制；「基础库升级/变更」单独立项，本片只记录现状与约束 |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://developers.weixin.qq.com/miniprogram/dev/framework/client-lib/ | 基础库随客户端携带上一稳定版发布；后台灰度 12–24 小时；高版本基础库无法在低版本客户端运行；major/minor 依赖新客户端 |
| 2 | https://developers.weixin.qq.com/miniprogram/dev/devtools/stable.html | 未取得版本号：页面只返回导航骨架，不含版本读数 |

## 6 Python（文档/契约校验脚本）

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `README.md:27`「Python 3.11+ 用于文档检查」；CI docs job 只跑 `python3 --version`，不锁版本；本机 `python -V` 与 `python3 -V` 均 3.14.3；`tools/run-python.mjs` 依次尝试 `$PYTHON` → `python3` → `python` |
| 上游维护状态 | 生命周期约 5 年（约 2 年 bugfix + 3 年 security）：3.14 处于 bugfix，2025-10-07 首发，EOL 2030-10；3.15 进入 bugfix（2026-10-09 首发，EOL 2031-10）；3.11 为 security，EOL 2027-10；3.10 已于 2026-10-01 EOL。官网当前补丁：3.15.0、3.14.8、3.11.17 |
| 可复用部分 | 仓内 14 个 `tools/**/*.py`（`git ls-files "tools/*.py" "tools/knowledge/*.py"` ⇒ 14）：`validate_development_docs.py`、`validate_contracts.py`、`test_contracts.py` 由 `npm run test:docs` 与 CI docs job 调用，`tools/knowledge/*.py` 10 个用于知识库构建与校验；`tools/run-python.mjs` 依次试 `$PYTHON`→`python3`→`python`，是本项唯一解释器入口 |
| 许可证与署名 | 「All Python releases are Open Source」并指向许可页（PSF 许可）；全文本轮未抓取 ⇒ 条款细节未取得 |
| 兼容性 | 校验脚本只用标准库，3.11+ 均可运行；CI 未固定小版本 ⇒ 上下游版本漂移只影响文档检查 |
| 引入成本 | 已在用；校验脚本无第三方依赖 |
| 决定 | 沿用 3.11+ 标准库脚本。理由：只用标准库，无需锁依赖；建议后续在 CI 固定 python3 主版本（属 CI 变更，本片不改） |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://devguide.python.org/versions/ | 3.15/3.14 为 bugfix（EOL 2031-10 / 2030-10）；3.13、3.12、3.11 为 security（EOL 2029-10 / 2028-10 / 2027-10）；3.10 EOL 2026-10-01；生命期约 5 年（PEP 602） |
| 2 | https://www.python.org/downloads/ | 最新 3.15.0（2026-10-09）、3.14.8（2026-09-30）、3.11.17（2026-10-01）；声明所有发布为开源，许可见 Licenses 页 |

## 7 GitHub Actions

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `git grep -h "runs-on:" -- .github/workflows`（去重后只有 `ubuntu-24.04` 一行；`git grep -c "runs-on:"` 合计 17 行、11 个 workflow 文件）；`git grep -l "node-version: '24.16.0'" -- .github/workflows` ⇒ 10 个 workflow、`git grep -o …` ⇒ 15 处；`git grep -c "actions/checkout@"` ⇒ 11 个文件 17 处、`git grep -c "actions/setup-node@"` ⇒ 10 个文件 15 处，两者合计 32 行命中（等价 ERE 命令见 §10）；checkout 固定 SHA `11bd71901bbe5b1630ceea73d27597364c9af683`（`persist-credentials: false`），setup-node 固定 SHA `49933ea5288caeca8642d1e84afbd3f7d6820020`（`cache: npm`） |
| 上游维护状态 | `git ls-remote --tags https://github.com/actions/checkout "refs/tags/v4.2.2"` ⇒ `11bd71901bbe5b1630ceea73d27597364c9af683 refs/tags/v4.2.2`（轻量 tag，直接指向该 commit，与仓库 pin 相同）；`git ls-remote --tags https://github.com/actions/setup-node "refs/tags/v4*"` ⇒ `49933ea5288caeca8642d1e84afbd3f7d6820020 refs/tags/v4.4.0`，浮动 `refs/tags/v4` 同指该 SHA ⇒ 两处 pin 均对应实测 tag。此前只核了 `api.github.com/…/tags/v4.1.0`（`39370e39…`，不匹配）故误记为未取得，本轮改用 ls-remote 全量核对 |
| 许可证与署名 | 未取得（本轮未抓取 actions 仓库许可页） |
| 可复用部分 | 11 个 workflow 文件、17 个 job（`git grep -c "runs-on:"` 合计 17）共用同一组 pin：checkout 11 个文件 17 处、setup-node 10 个文件 15 处；`docs/verification/how-to-read-ci-runs.md` 是读这些运行的口径文档 |
| 兼容性 | 固定 SHA 可复现；`ubuntu-24.04` 托管运行器与 Node 24.16.0 组合已在本仓库 10 个 workflow 中运行（11 个 workflow 文件里 `development-docs.yml` 不装 Node）；setup-node `cache: npm` 依赖锁文件，锁文件变更时必须同步 |
| 引入成本 | 已在用 |
| 决定 | 沿用「固定 SHA」策略，不改浮动 tag/分支。理由：固定 SHA 防 tag 漂移、可复现；缺的是逐个 tag 与许可页核对，属后续补证，不是引入新做法 |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://api.github.com/repos/actions/checkout/git/ref/tags/v4.2.2 | tag SHA `11bd71901bbe5b1630ceea73d27597364c9af683`（与仓库 pin 相同；`git ls-remote --tags` 显示 `refs/tags/v4.2.2` 直指该 commit ⇒ 轻量 tag） |
| 2 | https://api.github.com/repos/actions/setup-node/git/ref/tags/v4.1.0 | tag SHA `39370e39…`（v4.1.0，与仓库 pin 不同）；pin 已由 `git ls-remote --tags` 复核为 `v4.4.0`（`49933ea…`，`refs/tags/v4` 同指） |

## 8 检索证据总表

| # | URL | 本轮读数 | 用于 |
| --- | --- | --- | --- |
| 1 | https://endoflife.date/api/nodejs.json | Node 24 latest 24.22.0、support 2026-10-20、eol 2028-04-30 | §1 |
| 2 | https://nodejs.org/en/about/previous-releases | v24 Krypton LTS，v26 Current，latest LTS v24.22.0 | §1 |
| 3 | https://registry.npmjs.org/typescript/latest | TypeScript 7.0.2，Apache-2.0，engines node >=16.20.0 | §2 |
| 4 | https://api.github.com/repos/microsoft/TypeScript/releases/latest | v7.0.2，published 2026-08-20，原生移植编译器说明 | §2 |
| 5 | https://fastify.dev/docs/latest/Reference/LTS/ | 5.0.0 2024-09-17，End Of LTS TBD，Node 20/22 | §3 |
| 6 | https://registry.npmjs.org/fastify/latest | 5.12.7，MIT，15 个运行时依赖，约 2.97 MB | §3 |
| 7 | https://www.postgresql.org/support/versioning/ | 17.11 supported 至 2029-11-08；18.6 至 2030-11-14；19 RC1 | §4 |
| 8 | https://www.postgresql.org/about/licence/ | PostgreSQL License 条款与署名要求 | §4 |
| 9 | https://developers.weixin.qq.com/miniprogram/dev/framework/client-lib/ | 基础库随客户端携带上一稳定版、灰度 12–24h | §5 |
| 10 | https://developers.weixin.qq.com/miniprogram/dev/devtools/stable.html | 无版本读数（未取得） | §5 |
| 11 | https://devguide.python.org/versions/ | Python 各分支状态与 EOL，PEP 602 | §6 |
| 12 | https://www.python.org/downloads/ | 3.15.0 / 3.14.8 / 3.11.17 最新补丁 | §6 |
| 13 | https://api.github.com/repos/actions/checkout/git/ref/tags/v4.2.2 | tag SHA 与仓库 pin 一致 ⇒ checkout pin = v4.2.2（轻量 tag） | §7 |
| 14 | https://api.github.com/repos/actions/setup-node/git/ref/tags/v4.1.0 | v4.1.0 的 tag SHA 与仓库 pin 不同；pin 经 `git ls-remote --tags` 复核 = v4.4.0 | §7 |

## 9 未取得项

| 项 | 原因 | 后续 |
| --- | --- | --- |
| Node.js 许可证全文 | 本轮未抓取 nodejs/node 的 LICENSE 页 | 下次复核补抓，不先写结论 |
| 微信小程序稳定版版本号 | 开发者工具稳定版页只返回导航骨架，无版本读数 | 用官方下载页或更新日志复核 |
| 微信小程序许可证条款 | 未抓取许可页 | 同上 |
| actions/checkout、actions/setup-node 许可证 | 未抓取仓库许可页 | 补抓 LICENSE 或仓库 API |
| TypeScript 5.9.3→7.0.2 迁移成本、Fastify 5.12.5→5.12.7 变更记录 | 本轮未抓 changelog | 升级前单独检索并留痕 |

## 10 复核命令

```text
# 基线
git rev-parse upstream/main
git rev-parse HEAD
# 版本读数
node -p "JSON.stringify(require('./package.json').engines)"
node -p "require('./package-lock.json').packages['node_modules/fastify'].version"
node -p "require('./package-lock.json').packages['node_modules/typescript'].version"
node -p "require('./project.config.json').libVersion"
node -p "require('./miniprogram/project.config.json').libVersion"
# 计数口径（11 个 workflow 文件 / 10 个含 node-version / 15 处 / 6 个含 postgres 镜像 / 17 个 job）
git ls-tree -r --name-only HEAD .github/workflows/
git grep -l "node-version: '24.16.0'" -- .github/workflows
git grep -o "node-version: '24.16.0'" -- .github/workflows
git grep -l "image: postgres:" -- .github/workflows
git grep -c "runs-on:" -- .github/workflows
# action pin 与 tag（ERE 用 (checkout|setup-node)，写成 \| 会 0 命中）
git grep -nE "actions/(checkout|setup-node)@" -- .github/workflows
git ls-remote --tags https://github.com/actions/checkout "refs/tags/v4.2.2"
git ls-remote --tags https://github.com/actions/setup-node "refs/tags/v4*"
```

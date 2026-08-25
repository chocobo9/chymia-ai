# 轻量嵌入式混合搜索：Node/TypeScript 可复用 Module 的现有成果

> 状态：外部研究；non-canonical。
> 研究日期：2026-07-27
> 范围：只比较可由本地 Node/TypeScript Agent 调用的检索能力；不决定 Chymia 的架构、接口或采用方案。
> 资料边界：以下事实均回溯至项目官方文档、官方仓库或 SQLite 官方文档；产品定位和取舍是基于这些事实的推论，明确标为“推论”。

## 1. 要解决的工作，不是替代 `read`、`grep` 或 `bash`

混合搜索的输入是**已经被某个调用方纳入索引范围的文本记录/片段**，而不是任意访问机器上的文件。它输出带 `id`、来源、片段和分数的少量候选，供 Agent 再用 `read`、`grep` 或命令行核对原文。

它特别解决两种互补的失败：

| 查询或内容特征 | 仅词法检索容易失败 | 仅向量检索容易失败 | 混合检索的作用 |
|---|---|---|---|
| 函数名、文件名、错误码、配置键、版本号 | 通常可靠 | 容易把精确标识符稀释 | 保留精确命中及 BM25 排序 |
| 同义问法、历史决策的不同措辞 | 必须猜中原文词语 | 通常较好 | 用语义候选补回词汇不重合的材料 |
| 中文、英语与代码混在一起 | 取决于分词器 | 取决于嵌入模型 | 把分词质量和嵌入质量分别暴露、评测 |

因此它可服务于项目知识、已确认 Memory、文档片段和代码摘要的“候选定位”；它**不**判断何者值得写入长期记忆、何者为真、是否有权限读取来源，亦不应直接生成没有出处的答案。

## 2. 比较维度

“轻量”在此不等于包体最小，而是：不另起常驻服务；可嵌入 Node 进程或受控本地子进程；索引可持久化且可由原始内容重建；嵌入模型、重排器和中文分词的代价可被显式选择。所有方案仍需要调用方负责：切块、来源/访问范围、删除和更新语义、结果引用、评测集与降级策略。

## 3. 现成的构成原语：SQLite FTS5 + sqlite-vec

### 3.1 解决什么

这是“自己组合、最小外部抽象”的路径：SQLite FTS5 提供词法全文检索和 BM25；`sqlite-vec` 在同一个 SQLite 文件中存向量并作 KNN。调用方自行并行取两边 top-k，再以 RRF 或自己的融合/重排规则生成候选列表。

SQLite 官方将 FTS5 定义为全文检索虚表；它可由普通 `INSERT`、`UPDATE`、`DELETE` 维护，并提供 `MATCH`、短语、前缀、邻近和布尔查询，以及 `bm25()` 排名。[SQLite FTS5 文档](https://sqlite.org/fts5.html#overview)
`sqlite-vec` 官方说明其为无服务器的 SQLite 向量扩展，使用 `vec0` 虚表和纯 SQL 的 `CREATE`/`INSERT`/`SELECT` 进行 KNN 查询；它有 Node.js 绑定。[sqlite-vec 概览](https://alexgarcia.xyz/sqlite-vec/)

### 3.2 持久化与增量更新

可让正文和元数据位于普通 SQLite 表，FTS5 使用 external-content 表；官方明确要求应用保持索引与正文一致，并给出 insert/update/delete trigger 的做法，也提供 `rebuild` 用当前内容重建索引。[external-content 与一致性责任](https://sqlite.org/fts5.html#external_content_and_contentless_tables)

`sqlite-vec` 的向量行也以相同稳定 `rowid`/记录 id 写入 SQLite。**推论：** 用同一事务写正文、FTS 变更、向量变更和版本元数据，可以把增量更新的状态集中在一个可复制、可重建的 `.sqlite` 文件中；但 sqlite-vec 官方并未替调用方提供“全文 + 向量 + 融合”的完整管线。

### 3.3 Windows、中文、嵌入与重排

- Windows：`sqlite-vec` 官方编译指南明确给出 MSVC/MinGW 生成 `.dll` 的方法；其实现是单个 C 文件、无其他依赖，但该发布线仍为 alpha，编译选项也不受语义化版本承诺保护。[编译与稳定性说明](https://alexgarcia.xyz/sqlite-vec/compiling.html)
- 中文词法：FTS5 默认 `unicode61` 把连续的 Unicode 字母/数字视为一个 token；它并非中文词语切分器。FTS5 支持自定义 tokenizer；`trigram` 则提供任意三字符子串匹配（少于三字不能以 FTS 查询命中）。[FTS5 tokenizers](https://sqlite.org/fts5.html#full_text_query_syntax) 这意味着中文质量不能假定：需在“字符/子串召回、第三方中文分词 tokenizer、或以向量补偿”之间实测选择。
- 嵌入：完全自由。扩展只存/比向量，不生成 embedding；可接本地或远程模型，也可为不同语料显式重嵌。
- 重排：完全自由，但也意味着需要自行实现 RRF、cross-encoder/LLM 重排的生命周期、超时与评测。

### 3.4 成本与限制

没有搜索 server；代价为 SQLite 驱动加一个原生扩展、以及任选的 embedding/reranker。`sqlite-vec` 文档标为 pre-v1，且其“runs everywhere”不是自动解决 Windows 原生加载、SQLite 构建选项或打包分发。它是高控制、低依赖的原语组合，不是开箱即用 Module。

## 4. Orama：纯 TypeScript、进程内的一体化搜索库

### 4.1 解决什么

Orama 官方定位为零依赖、完全 TypeScript 编写、可在浏览器/服务器/edge 运行的全文、向量和混合搜索库。[Orama JS 概览](https://docs.orama.com/docs/orama-js)

其 hybrid 模式在一次 `search` 中同时执行全文与向量搜索、合并结果；默认文本/向量权重各 0.5，调用方可传 `hybridWeights`。官方同时指出查询时只能搜索一个向量属性。[Hybrid search 文档](https://docs.orama.com/docs/orama-js/search/hybrid-search)

适合：索引规模尚小到中等、希望直接作为 TypeScript 依赖使用、能够接受将索引对象加载到应用内存的本地 Agent 或桌面应用。

### 4.2 持久化与更新

默认是内存索引；官方数据持久化插件可以把整个数据库序列化为 JSON/二进制快照、在 Node 环境写入文件并从文件恢复。[数据持久化插件](https://docs.orama.com/docs/orama-js/plugins/plugin-data-persistence) 插入使用稳定 `id` 时，重复 id 会报错；所以“按来源版本覆盖更新、删除旧片段、崩溃安全写快照”仍是调用方的同步协议，而非其持久层自动提供的事务语义。[插入与文档 ID](https://docs.orama.com/docs/orama-js/usage/insert)

### 4.3 Windows、中文、嵌入与重排

- Windows：纯 JS/TS、零依赖的官方定位意味着没有 native SQLite/数据库 server 安装面；这是它在桌面分发上的主要优势。
- 中文：官方提供 `@orama/tokenizers/mandarin`，可选搭配中文 stopwords；不是核心包默认行为，需额外安装与配置。[中文 tokenizer 指南](https://docs.orama.com/docs/orama-js/supported-languages/using-chinese-with-orama)
- 嵌入：可由调用方传向量；官方还提供离线 on-device embeddings 插件或 Secure Proxy。嵌入模型/维度因此可选，但插件会带来额外模型或网络依赖。[Hybrid search 的 embedding 前提](https://docs.orama.com/docs/orama-js/search/hybrid-search)
- 重排：核心提供词法/向量加权融合，未等同于 cross-encoder/LLM reranking；若需要后者，调用方在结果后自行接入。

### 4.4 成本与限制

无需独立进程、核心无依赖；代价是持久化为快照而非 SQLite 事务数据库，并且大索引的内存与恢复时间需实测。它是几种候选中最接近“可嵌入 TypeScript Module”的现成实现，但没有把来源版本、增量编排和证据引用变成 Agent 语义。

## 5. LanceDB：嵌入式本地数据库，但面向更大规模检索

### 5.1 解决什么

LanceDB 官方称其开源、可本地运行，提供原生 TypeScript SDK；它在 Lance 列式格式上同时支持向量、全文、SQL、过滤和版本化数据。[官方仓库说明](https://github.com/lancedb/lancedb)

官方 TypeScript 混合搜索流程是：连接本地目录、建立 FTS 索引、`fullTextSearch(...)` 与 `nearestTo(...)`，再经 reranker 合并；默认是 RRF，也可改超参数或自定义 reranker。[官方 TypeScript hybrid 示例与 reranking](https://docs.lancedb.com/search/hybrid-search)

适合：数据较多、既要 metadata filter/向量索引/全文检索，又可接受 Arrow/Lance/native 依赖和较重的数据层的本地应用。它是“嵌入式”，不代表它是小型依赖。

### 5.2 持久化与增量更新

本地 `connect("data/..." )` 使用目录持久化，而不是常驻 server；表支持 `add`、索引创建、版本信息和优化相关 API。官方仓库将“automatic versioning”和无需额外基础设施列为特性。[本地连接与表建立](https://docs.lancedb.com/search/hybrid-search) [TypeScript API 索引](https://lancedb.github.io/lancedb/js/globals/)

**推论：** 它比 Orama 快照更适合较大、会持续 append/update 的数据集；但“文件删除应删哪些 chunk/embedding、源版本变化是否 re-embed、索引何时 build/optimize”仍需上层保有稳定 source id 与更新账本。

### 5.3 Windows、中文、嵌入与重排

- Windows：官方 TypeScript 资料证明本地目录连接与 SDK 存在，但本次一手资料未给出 Windows 预构建矩阵或中文 tokenizer 保证；这两项必须以目标版本的安装 smoke test 和中文评测补证，不能据“本地运行”外推。
- 中文词法：混合文档只要求在 text 列建立 FTS 索引，未承诺中文分词质量；应视为待测风险。
- 嵌入：官方示例可使用 registry embedding，也明确支持显式 text query + vector query，因此可接外部或本地 embedding 服务。[显式向量与文本查询](https://docs.lancedb.com/search/hybrid-search)
- 重排：RRF 默认、内建/自定义 reranker 是明确的一等能力；也能设置向量距离边界与 metadata pre/post filter。[reranking 与过滤控制](https://docs.lancedb.com/search/hybrid-search)

### 5.4 成本与限制

进程上不需要独立搜索服务，但 TypeScript 包会引入 Lance/Arrow 与原生执行层；其能力和包面明显大于“单机少量 Markdown 记忆”的最低需求。证据显示功能成熟度高；对 Windows/CJK 的产品适配证据在本次资料内不足。

## 6. QMD：已有的高质量本地基线，而非“轻量原语”

QMD 官方 package 描述为 Markdown 的 on-device hybrid search（BM25、vector、LLM reranking）；其仓库公开了 RRF、query expansion、top-k reranking 及本地模型的实现说明。[QMD package](https://github.com/tobi/qmd/blob/main/package.json) [QMD README](https://github.com/tobi/qmd)

它现在也导出库接口（`createStore`），不只是一层 CLI/MCP；`dbPath` 必须显式给出，并有 `close()` 释放模型与数据库连接。[库接口与生命周期](https://github.com/tobi/qmd#library-usage)

但官方资料同时显示其 Node 要求为 `>=22`，依赖 `better-sqlite3`、`node-llama-cpp`、`sqlite-vec`、tree-sitter 等；默认 embedding、reranker、query-expansion 三个本地模型合计约 2 GB，首次使用自动下载。它可切换到 Qwen multilingual embedding，切换后必须全量 re-embed；Windows CUDA 并行默认收窄为 1，因存在崩溃风险。[依赖与运行时](https://github.com/tobi/qmd/blob/main/package.json) [模型、CJK 与 Windows 说明](https://github.com/tobi/qmd#requirements)

结论仅限于事实归类：QMD 是质量链路很完整的现成**基线/Adapter 候选**，却不是“最小依赖、前端化或轻量嵌入式”候选；采用它意味着接受本地模型、原生模块和 runtime 生命周期，而不是只增加一个检索表。

## 7. 横向结论：事实与待验证项

| 方案 | 已经替调用方完成 | 调用方仍必须完成 | 依赖/进程轮廓 | 本次证据中的主要风险 |
|---|---|---|---|---|
| SQLite FTS5 + sqlite-vec | 词法、BM25、KNN、SQLite 持久化原语 | 融合、embedding、rerank、切块、同步/删除 | SQLite + 原生扩展；无 server | sqlite-vec alpha；中文要选 tokenizer 并测 |
| Orama | TS 内存全文/向量/加权 hybrid、快照持久化插件 | 磁盘更新协议、模型、复杂 rerank、来源账本 | 纯 TS 核心、无 server | 内存与全量快照恢复；hybrid 单向量字段 |
| LanceDB | 本地表、向量/FTS/hybrid、RRF/自定义 rerank、过滤 | 源同步、切块、embedding 运营、CJK 评测 | embedded native/Arrow/Lance；无 server | 对“轻量”偏重；Windows/CJK 证据待补 |
| QMD | Markdown/代码索引、BM25+向量+RRF+扩展+本地 rerank | 领域写入规则、来源权限、上层接口 | Node 22、原生包、本地模型；可 library/CLI | 模型和 runtime 明显较重；默认 embedding 对 CJK 有限 |

没有一项现成成果使混合搜索成为 Agent 的“必需模块”。当内容仅有少量可枚举文件、查询主要是精确文本、或没有第二个实际消费者时，`rg`/`read` 更便宜、更可验证。反之，以下证据出现时，独立可复用检索能力才有明确价值：跨会话/跨文档找历史依据；同义问法需要召回；标识符和语义都不能丢；以及必须在固定上下文预算内返回可追溯的 top-k。

## 8. 尚未做、但任何采用前必须补的验证

1. 用真实的中文、英文、代码符号、文件名和历史决策问题构建小型 gold set；分别测 lexical、vector、hybrid、rerank 的 Recall@k、MRR、延迟和索引体积。
2. 在目标 Windows 版本、Node 版本、打包方式与 CPU/GPU 上做冷启动、模型下载、原生加载、崩溃恢复及卸载测试。
3. 明确原始内容与派生索引的边界，验证新增、修改、删除、失败中断后不会返回已删除或错误版本的片段。
4. 让任何结果都携带可回读的来源与版本；把“检索到”与“可作为事实写入”保持为两条不同流程。

## 9. 来源质量说明

| 来源 | 性质 | 本文承担的证据 |
|---|---|---|
| [SQLite FTS5](https://sqlite.org/fts5.html) | SQLite 官方规范/文档 | FTS5、BM25、tokenizer、external-content 同步责任 |
| [sqlite-vec 文档](https://alexgarcia.xyz/sqlite-vec/) 与 [官方仓库](https://github.com/asg017/sqlite-vec) | 项目作者维护的一手文档/源码 | SQL KNN、Node/Windows 扩展、alpha 状态 |
| [Orama JS 文档](https://docs.orama.com/docs/orama-js) | 产品官方文档 | 纯 TS、hybrid、持久化、中文 tokenizer |
| [LanceDB 文档](https://docs.lancedb.com/search/hybrid-search) 与 [官方仓库](https://github.com/lancedb/lancedb) | 产品官方文档/源码 | 本地 TypeScript、FTS/hybrid/RRF/自定义 rerank |
| [QMD 官方仓库](https://github.com/tobi/qmd) 与 [package](https://github.com/tobi/qmd/blob/main/package.json) | 项目官方源码/包清单 | 基线机制、runtime、模型与依赖成本 |

本文没有使用博客评测、第三方比较文章或营销 benchmark 来作任何采用结论；“适合”均只是由官方能力边界导出的场景推论，不代替本地实验。

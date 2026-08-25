# Chymia 项目审计 Handoff

> 状态：历史审计交接材料；不定义目标架构。
> 日期：2026-07-22
> 用途：为后续会话继续审计和理解 Chymia 保存上下文。
> 范围：架构与设计审计，不是代码迭代计划，也不是面试演讲稿。

## 1. 这次审计要解决什么

项目所有者已经较长时间没有启动 Chymia，目前没有时间做大规模更新，希望先重新理解项目。当前任务不是增加功能，而是通过多角度工程审计回答：

- Chymia 最初要解决什么真实问题；
- 多 Agent 协作在系统中如何发生；
- 身份、Thread、Session、Task、Invocation、Event、Memory 分别拥有什么状态；
- 正常执行、任务交接、失败重试、并发冲突和恢复路径如何设计；
- 哪些能力是当前实现，哪些是已有设计，哪些只是参考项目带来的演进思想；
- 如何在不罗列十几个模块、也不过度包装的情况下解释这个项目。

最终目标是形成对项目的完整心智模型。面试表达应当从这套理解中自然产生，而不是先写一篇薄弱的稿子再反向套项目。

## 2. 后续会话的协作方式

项目所有者会根据记忆自由回答问题，回答中可能混合现有实现、原始想法、参考项目、遗忘的细节和不确定判断。

后续助手应当：

1. 先保留用户原始思路，不急于包装语言。
2. 对“统一”“共享上下文”“自主”“工作流”“记忆”等模糊词继续追问。
3. 必要时查代码、Git 历史和参考项目，补足真实执行路径。
4. 在内部区分“当前实现、明确设计、参考思想、未来演进”，但不要把每次回答都写成状态清单。
5. 不要默认同时输出“口语稿”和“设计笔记”。只有复杂模块需要时才展开技术细节。
6. 等六个审计主题形成连贯认识之后，再整理完整的项目说明或面试表达。

用户给出的另一个 CTI 调查项目描述，只是在说明希望达到的理解深度：问题来源、用户处境、替代方案、系统机制、完整流程和价值必须能够串起来。它不是 Chymia 文档的格式模板。

## 3. 当前确认的项目定位

Chymia 是一个面向个人开发者的、本地交互式多 CLI 多 Agent 协作工作台。它位于 Claude Code、Codex CLI、Gemini CLI 等异构 Agent CLI 之上，把原本孤立的执行能力组织成一个持续存在的协作空间。

表面问题是开发者需要在多个终端和聊天窗口之间切换。更深层的问题是：每个 CLI 都拥有自己的调用参数、Session 语义、上下文、输出格式和执行历史。当它们被独立使用时，用户被迫同时充当消息中转器、上下文同步器、任务调度器、结果整合者和失败调查者。

Chymia 增加了一层由平台拥有的协作控制：

- 为 Agent 注册稳定身份、角色和 Provider；
- 用 Thread 承载团队共享的协作空间；
- 为每个 Agent 在 Thread 中维护独立、可续接的 Session；
- 通过 Router 决定目标 Agent、串行交接或并行执行；
- 通过 Provider Adapter 隐藏不同 CLI 的调用和流式协议差异；
- 通过 A2A 和 MCP 实现平台中介的 Agent 通信；
- 通过统一事件流连接前端展示、状态持久化、审计和后续调度；
- 保存 Task、Session、工具调用、Evidence 和日志，使执行过程可追踪。

项目要实现的根本变化是：

> 用户从负责每一次消息转发和 CLI 协调，转变为主要提出目标、观察协作并在关键决策点介入；模型负责语义判断，平台负责确定性的执行控制。

它不是简单的多模型聊天 UI，也不是重新实现 Agent 内部推理循环。核心研究对象是异构 Agent Runtime 之间的协作。

## 4. 整体架构基线

Chymia 是 TypeScript `pnpm` monorepo，整体形态是模块化单体：

- `packages/web`：React/Vite/Zustand 工作台和实时事件展示；
- `packages/api`：Fastify/Socket.IO 后端，也是协作内核的主要实现；
- `packages/shared`：Thread、Session、Message、Task、Agent Event 等共享协议；
- `packages/mcp-server`：Agent 返回调用 Chymia 能力的 MCP 桥接层；
- `packages/adapters`：飞书等外部入口 Adapter；
- `packages/skills`：Markdown 形式的平台 Skill。

当前核心执行路径：

```text
用户或外部入口消息
  -> Thread
  -> AgentRouter
  -> 串行路由或并行 fan-out
  -> Context 组装 + Session 选择
  -> invokeSingleAgent
  -> Provider Adapter
  -> 本地 Agent CLI
  -> 统一 Agent Event
  -> Socket/UI + SQLite 状态与审计
  -> 可选 A2A/MCP 交接，再次进入 Router
```

Claude、Codex、Gemini 自己拥有内部推理和工具调用循环。Chymia 不重新实现 ReAct。Chymia 拥有外部协作循环：谁执行、按什么顺序执行、使用哪段上下文、续接哪个 Session、如何取消重试，以及结果保存在哪里。

## 5. 核心对象与状态归属

### Agent

Agent 是平台管理的团队成员，不等于一次 CLI 进程。它具有稳定 Agent ID、角色、Provider 绑定、行为说明和可用状态。Agent 可以参与某个 Thread。

用户曾记得“冻结 Agent”能力。当前可以安全表达为：保留 Agent 身份和历史，同时阻止继续向它分配任务；除非重新核验实现，不要声称已经存在完整的冻结生命周期状态机。

### Thread

Thread 是持久化的团队协作空间，拥有参与者、项目路径、路由策略、SOP 阶段、消息、Task 上下文，以及 Agent Session 和执行历史的关联。Thread 不只是聊天记录。

### Session

Session 是某个 Agent 在一个 Thread 中的连续后端上下文。当前模型大体是一组 `(thread, agent)` 对应一个活动 Session，Session 有序列链和 active/sealed 状态，可以续接；当连续性不再安全时，可以 seal 后重新建立。

### Invocation

Invocation 是一次具体 Agent 调用，关联超时、取消、重试、回调身份、事件和审计。三种身份不要混淆：

```text
Agent ID      = 团队成员是谁
Session ID    = 延续哪段 Agent 上下文
Invocation ID = 本次具体执行是哪一次
```

### Task

Task 提供 `todo / doing / blocked / done` 等显式工作状态，未完成任务快照可以注入后续 Agent Prompt。它是协作状态，但还不等于可在崩溃后完整恢复的持久化 Workflow Run。

### Event

不同 Provider 的输出会归一化为 text、thinking、tool_use、tool_result、error、done、session_init、system_info、a2a_handoff 等统一事件。事件用于实时展示、持久化、审计和调度判断。

### Evidence 与 Memory

需要始终区分：

- Working Context：下一次 Invocation 实际组装进 Prompt 的有限上下文；
- Episodic Execution History：消息、Session、工具、事件和审计记录；
- Shared Evidence Memory：可检索、可供多个 Agent 复用的证据。

Chymia 当前已经有 recent/smart-window 上下文组装，以及基于 SQLite 的 Evidence Store，包括全文检索、中文分词、可选向量、混合排序和 Evidence 关系。这属于轻量共享证据记忆，还不是完整的长期记忆生命周期。

## 6. 多 Agent 协作模型

### Router

`AgentRouter` 支持显式 `@mention`、`@all`、参与者和最近提及回退、Agent 可用性与 Thread 路由策略。

### 串行交接

串行模式维护有序 worklist，后续 Agent 可以获得前序 Agent 的响应。Agent 可以通过显式提及或 A2A 提出下一位协作者，平台通过目标数量、最大深度、ping-pong 防护、取消和完成语义限制工作链。

典型流程：

```text
用户 -> 规划 Agent -> 开发 Agent -> 规划/验收 Agent
                               ^              |
                               |---- 反馈 -----|
```

模型负责规划、实现、验收意见和交接内容；平台负责身份、寻址、投递、边界和执行秩序。

### 并行执行

并行 Agent 获得同一个起始上下文快照，随后独立运行。各自的流被合并展示，一个分支失败不必终止其他分支。它们不会在运行过程中自动实时看到其他 Agent 的新增输出。

因此应使用“共享起始上下文”或“一致的 Thread 上下文快照”，不要使用“实时同步上下文”。

### A2A

A2A 是不同 Agent Session 之间由平台中介的通信，不是多个模型天然共享完整上下文。

当前主要形式：

- 串行输出中的行首 Agent mention 扩展当前 worklist；
- MCP `post_message` 指向已知 Agent，再回到显式路由；
- 平台验证目标、Invocation 身份、消息去重键、深度和反复调用。

核心原则：

> 模型提出语义交接，确定性平台代码完成认证、寻址、限制、记录和执行。

## 7. Context、Skill、SOP、Tool 与 MCP

这些概念不能混为一谈。

### Context

Context Assembler 从最近历史、Task、重要 Evidence、串行前序响应中选择内容，并受消息数、内容长度和 Token 预算限制。不同 Agent 获得适合当前角色和任务的共享状态投影，而不是读取全部数据库或其他 Agent 的完整私有 Transcript。

### Skill

Skill 是 Markdown 行为指导。用户启用后，Skill 内容被注入 Agent 指令。当前平台不会把 Skill 当成函数执行，也不会根据关键词自动选择并调用 Skill；Agent 根据注入的说明自行使用。

### SOP

SOP 主要提供当前阶段提示和事后轨迹评估，更像开发阶段公告板，不是所有步骤都不可绕过的硬工作流状态机。

### MCP

MCP 是 Agent CLI 返回调用 Chymia 平台能力的结构化通道，暴露 Evidence 搜索/写入、`post_message`、文件读取/搜索、Session 链和摘要/事件读取、SOP 推进等工具。

MCP 的价值不是让任意外部指令自动可信，而是把自然语言中的未知 Shell 命令转成宿主预先配置、参数有 Schema、调用可校验的 Tool Interface。平台仍需验证 Invocation、目标 Agent、权限、去重、深度和危险操作。

认证只能证明谁或哪个 Invocation 可以调用能力，不能证明消息内容一定安全。

## 8. 可靠性和失败模型

### CLI 执行失败

`invokeSingleAgent` 具有硬超时、Provider 超时、`AbortSignal` 取消、有限重试、Session 处理和错误分类。已经产生可见输出后不自动重试，以免 Agent 已修改文件或已经产生部分副作用。

### Session 并发

`SessionMutex` 串行化同一 Session 的调用，防止两个 Invocation 同时破坏同一个可恢复 CLI 上下文。

### 并行部分成功

并行流相互独立，一个 Agent 报错时其他 Agent 可以继续。最终状态需要保留各 Agent 的结果，不能简单压成一个全局成功布尔值。

### 重复执行

Invocation 级回调身份和消息 ID 提供有限的幂等与去重能力。Invocation Registry 和取消状态仍有较多内存态，因此不能声称已经达到崩溃安全的 exactly-once 执行。

### 文件冲突

当前 Agent 共享一个 workspace root。系统有路径穿越、symlink 和 root 检查，但没有完整的每 Run 独立 worktree、Workspace Lease、fencing 和确定性合并机制。Session 串行锁不能解决两个不同 Agent 同时修改同一文件的问题。

### 崩溃恢复

SQLite 保存 Thread、消息、Session、工具、Task、Evidence 和 Audit，但这不等于可以在进程重启后完整重放和恢复运行中的 Workflow Run。

## 9. 已知 Provider 语义问题

用户记得 Gemini 曾出现：第一次上下文有效，后续上下文没有被接收，并触发重复性检测。

仓库状态记录了一类相关问题：Gemini/Codex 没有等价的原生 system-prompt 通道，身份文本曾在 resume 时反复作为 user 内容注入，模型把它识别成重复挑战并进入死锁式响应。现有修复方向是身份只在 Session 首轮注入；Claude 使用原生 `--append-system-prompt`。

之后还记录过 Gemini context bleed、reopen 后返回旧结果和 Audit 为空等现象，尚未完全分析。不能把所有 Gemini 问题都归为同一个根因，后续需要单独查代码和 Git 历史。

稳定的设计结论是：

> 统一的 `invoke(prompt, sessionId)` Interface 不代表 Provider 拥有相同 Session 语义。Adapter 必须吸收身份注入、resume、Prompt 追加、流终止和重复检测差异。

## 10. 可观测性与评估

当前可观测性包括：

- Pino 结构化运行日志；
- Socket 事件流；
- SQLite 中的消息、Session、Tool Event、Task、Evidence 和 Audit；
- UI/MCP 暴露的 Session 摘要和执行历史。

Audit 有价值，但不是原子、权威、可完整重放的 Event Sourcing Ledger。可以说“基于统一事件流的协作编排”，不要说“成熟的 Event-Sourced Orchestration Engine”。

评估应区分三层：

1. 协议正确性：路由、身份、Session 续接、去重、终止和记录是否正确；
2. 节点产出质量：规划、开发、测试、审查结果是否满足要求；
3. 协作整体质量：完成率、交接质量、返工次数、人工介入、冲突率、耗时和成本。

用户提出的评估方向：

- 用确定性测试验证协议和机械可判断结果；
- 为单节点建立代表真实场景的 Golden Test Set；
- 对灵活语义结果使用带 rubric 的 LLM-as-Judge；
- 用人工抽样校准 Judge；
- 用工作流指标衡量成本和稳定性。

当前仓库有较多测试和 Gate，但这不能等同于成熟的 Agent Evaluation Harness。

## 11. Runtime Harness 表述校准

曾经的简历表述是：使用 Python 建立 Runtime Harness，在平台层控制 Agent 执行，强制 Artifact Contract、Workspace Isolation、Validation Gate 和全链路 Audit。

仓库事实并不支持这句完整表述：

- 当前和 Git 历史中都没有 Python Runtime Harness；
- `.harness` 是 Node 开发/对齐检查；
- commit hook 和 CI Gate 是仓库开发护栏，不是 Agent Runtime；
- TypeScript 运行层确实实现了超时、重试、取消、Session 串行化、workspace root 控制和关联日志；
- 强 Artifact Contract、每 Run 工作区隔离、自动 Validation Gate 和崩溃 Reconciliation 仍属于目标设计。

准确说法：

> Chymia 在本地 Agent CLI 外建立了 TypeScript 平台执行控制层，提供有限重试与超时、按 Agent 取消、Session 串行化、工作区根路径控制和关联执行记录；更严格的 Artifact Contract、隔离工作区、Validation Gate 和持久化 Reconciliation 是后续演进方向。

## 12. 参考项目的正确位置

参考项目用于帮助理解和验证 Chymia 的思想，不用于反向定义 Chymia，也不能把参考实现说成本地已经实现。

### Clowder

本地路径：`reference/clowder-ai-main`。

Clowder 是最初和最接近的参考，涵盖 platform-over-CLI、Agent 身份、Thread、串并行路由、A2A、MCP、状态和 Audit。Chymia 有意删除或简化了社交、社区、游戏、语音、文化、多用户组织、重基础设施和大范围 Connector 等产品面。

### Codex Multi-Agent

当前 Codex 的角色 Agent、独立 Agent Thread/Session、运行时身份、消息、steer、wait 和结果汇总，是思想上的独立汇合，使今天的听众更容易理解这种交互模式。

不能说“因为 Codex 这样做，所以 Chymia 也这样解释”。必须先从 Chymia 自身的问题和实现解释，再把 Codex 作为参照。

### Golutra

Golutra 是同一多 CLI 多 Agent 产品方向上更完整、更成熟的项目。Chymia 更早期、更轻量。Golutra 的价值是展示多 CLI workforce、工作流、桌面控制、长期运行和集成能力产品化之后的完整形态。

不能把两者描述成成熟度相近、只是侧重点不同的横向产品。

### EverOS

EverOS 是 Memory 的思想参考。最值得借鉴的不是单纯向量数据库，而是完整记忆生命周期：

```text
原始消息/事件
  -> 记忆边界
  -> 提取
  -> 可追溯的事实源
  -> 可重建索引
  -> 按作用域召回
  -> 离线整理和演化
```

适合 Chymia 的记忆作用域可能包括：Task Episode、项目事实/决策、Agent Case、经过审查的团队知识。原始执行历史必须与模型派生记忆分离。

## 13. 当前实现和设计边界

可以安全描述的当前核心：

- 通过 Provider Adapter 统一调用异构 Agent CLI；
- 以 Thread 为中心的交互式协作；
- 每个 Agent 的独立可续接 Session；
- 串行交接与并行 fan-out；
- 统一事件流；
- 平台中介的 A2A 与 MCP Tool；
- Task、Session、Tool、Evidence 和 Audit 持久化；
- 有边界的超时、取消、重试和 Session 串行化；
- 轻量共享 Evidence Memory。

需要限定的表达：

- “同步上下文”是共享持久化状态和每次调用的 Context Snapshot，不是实时共享模型上下文；
- “自主协作”是平台约束下的有限自治；
- “可恢复工作流”主要是跨轮次 Session 续接，不是完整持久化 Run 恢复；
- “Memory”是工作上下文、执行历史和轻量 Evidence，不是完整自演化记忆；
- “Audit”是关联的结构化日志与记录，不是权威 Event Ledger。

没有新证据前不能声称已经完成：

- 完整持久化的 Issue-Driven 自治执行；
- 完整 Run/Workflow 状态机和重启 Reconciliation；
- 每 Run 隔离工作区；
- 强制 Artifact/Result Contract 与自动 Validation Gate；
- 生产级长期 Memory 生命周期；
- 系统化 Agent Evaluation 和成本核算；
- Claude/Codex/Gemini 全部真实 CLI 的端到端稳定验证。

## 14. 后续六个审计主题

后续围绕约十五个问题继续，用户可以一次回答多个问题。

### 主题一：项目定位与业务价值

1. Chymia 为个人开发者解决的真实协作问题是什么？
2. 为什么分别打开多个 CLI 窗口不足以解决？
3. 除了生成代码，什么结果才说明平台真正有价值？

### 主题二：整体架构与状态归属

4. 从用户消息到 Agent 完成和事件持久化，完整路径是什么？
5. Thread、Agent、Session、Task、Invocation、Event 和 Memory 分别拥有哪部分状态，为什么需要独立平台层？

### 主题三：Agent 与确定性控制

6. 哪些决策交给模型，哪些必须由平台代码控制？
7. 为什么需要 Agent 而不是固定 Workflow？Role、Skill、SOP、Tool 和 Router 有什么区别？

### 主题四：协作与记忆生命周期

8. Thread、Task、Session 和 Invocation 如何开始、推进、暂停、恢复和结束？
9. A2A 如何在不经过用户转发的情况下交接，又如何防止递归和重复执行？
10. 串行和并行执行分别共享什么上下文，什么保持 Session 私有？
11. 什么内容应成为长期记忆，如何提取、注明来源、召回、纠错和淘汰？

### 主题五：可靠性与安全

12. 如何处理超时、Provider 失败、部分成功、重试、取消和重启？
13. 如何处理重复执行、同 Session 并发、文件冲突和事件顺序？
14. MCP、Invocation Credential、Workspace 控制、权限和参数校验如何限制 Prompt Injection 与身份伪造？

### 主题六：评估与取舍

15. 如何综合评估协议正确性、Agent 产出、协作效果、成本与稳定性？哪些能力有意暂缓？

## 15. 审计完成后应形成的输出

1. 一份有实际内容的项目定位和价值说明；
2. 一张高层架构与状态归属模型；
3. 一条完整正常执行链和重要失败分支；
4. 一份按优先级排列的风险、缺口和演进选项；
5. 在以上理解完成后，如有需要，再提炼面试表达。

## 16. 后续应继续阅读的仓库材料

- [历史定位稿](../../history/positioning/2026-07-06-chymia-positioning.md)：包含较多未来 Issue Runner/Symphony 方向，比本次协作内核审计更宽、更偏目标态；
- [领域词汇表](../../domain/CONTEXT.md)：领域术语和目标概念；
- `STATUS.md`：实现验证状态和已知缺口，部分终端中存在编码显示问题；
- [目标架构总览](../../architecture/overview.md) 及其链接的各 Module 设计：当前目标架构真相；
- [历史 Symphony 纵向切片](../../history/design-snapshots/2026-07-13-symphony-vertical-slice.md)：保留为历史证据，不要让它替代当前 Module 设计；
- `reference/clowder-ai-main`：本地 Clowder 参考实现。

## 17. 下一次会话的直接起点

主题一已经讨论过，但还不应当被当作最终文案。下一步从主题二开始，先让项目所有者根据记忆描述执行路径，再用代码验证：

> 用户在 Thread 中发出一条消息之后，它经过哪些模块？平台怎样选择 Agent、准备 Session 和 Context、调用 CLI、接收统一事件，并把不同状态保存到哪里？

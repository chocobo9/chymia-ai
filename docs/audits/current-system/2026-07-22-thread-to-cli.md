# Chymia 当前执行路径审计：Thread 消息到 CLI、事件与持久化

> 状态：当前系统证据；不定义目标 Module。
> 审计日期：2026-07-22
> 证据范围：仅当前仓库的一手 TypeScript 源码；目标态引用已冻结的 [架构总览](../../architecture/overview.md) 与所属 Module 设计。
> 范围：Web/API 的一次 Thread 用户消息；外部平台入口最终复用同一处理函数。

## 结论摘要

当前实现已经有一条可执行的、以 Thread 为中心的同步请求链：HTTP 消息路由持久化用户消息，`AgentRouter` 解析目标并选择串行或并行；每个目标 Agent 组装独立的 system prompt、历史/证据/任务上下文，创建内存中的 Invocation Record，并通过 Provider Adapter 启动 CLI；CLI stdout 被解析成统一 `AgentMessage` 流，实时投影到 Socket.IO，最后把回复、工具事件、Session 和审计分别写入 SQLite。

它不是一个持久化 Run/Workflow 执行器：Invocation Registry、取消控制器和路由 worklist 都在进程内存中；审计和部分次级落库为 best-effort。因此重启后不能对运行中工作做权威 reconcile。

## 当前实现的端到端路径

```text
Web POST /api/threads/:id/messages
  -> handleThreadMessage
  -> Thread + user message(SQLite)
  -> AgentRouter: target resolution + serial/parallel selection
  -> per-target invoke seam: context + Invocation Record + Session choice
  -> invokeSingleAgent: mutex/retry/timeout
  -> selected CLI adapter -> local CLI process -> normalized AgentMessage stream
  -> Socket.IO agent_event/status projection
  -> reply/tool/session/audit SQLite writes + thread update
```

### 1. 入口、Thread 与用户消息

- `POST /api/threads/:id/messages` 校验请求，再调用共享的 `handleThreadMessage`，而不是自己直接路由：`packages/api/src/routes/message-routes.ts:43-59`。
- `handleThreadMessage` 先 `ensureThread`（首条消息自动建 Thread），再解析 `@mention` 并向 `SqliteMessageStore` 写入一条 `origin: 'user'` 的消息：`packages/api/src/routes/message-handler.ts:126-139`。
- 外部平台消息也不是旁路：`submitPlatformMessage` 先把平台 channel/user 映射为内部 Thread/user，再调用同一 `handleThreadMessage`：`packages/api/src/app-factory.ts:576-603`。

### 2. Agent 选择与路由策略

- Router 的确定性目标选择优先级为：`@all` 的全部可用 Agent；显式 `@mention` 的可用 Agent；近期用户 mention；活跃 Thread participant；默认/首个可用 Agent：`packages/api/src/routing/agent-router.ts:261-332`、`packages/api/src/routing/agent-router.ts:564-615`。
- 显式 mention（含 `@all` 展开）会在路由时写入 Thread participants；无显式 mention 的 fallback 不会把选择结果写成 participant：`packages/api/src/routing/agent-router.ts:440-452`。
- Router 通过解析 intent 选择模式：`ideate` 为并行，其余为串行；它只负责产出统一事件流，不直接持久化消息：`packages/api/src/routing/agent-router.ts:510-561`。
- 串行路由会把前序 Agent 的已收集文本追加到后序 Agent prompt，并允许受深度/乒乓限制的行首 mention 扩展 worklist：`packages/api/src/routing/route-serial.ts:258-269`、`packages/api/src/routing/route-serial.ts:308-426`。并行路由则给每个目标相同起始 prompt 和各自的 `InvocationContext`，流按到达顺序合并，不传递同轮新增结果：`packages/api/src/routing/route-parallel.ts:43-84`。

### 3. 每个 Invocation 的 Context、身份和 Session

- `buildApp` 把真实 stores、`SessionStore`、`InvocationRegistry`、invoke seam 和 `AgentRouter` 组装在一起：`packages/api/src/app-factory.ts:343-385`、`packages/api/src/app-factory.ts:449-479`。
- invoke seam 读取 Thread 全部消息和 Thread 元数据，并将 SOP stage 注入 InvocationContext 后生成每个 Agent 的 system prompt：`packages/api/src/app-factory.ts:775-811`。System prompt 包含 Agent 身份、角色、队友及串/并行等调用态上下文：`packages/api/src/context/system-prompt-builder.ts:255-275`。
- 历史上下文由 `buildHierarchicalContext` 生成；小对话走受 token 限制的 recent window，大对话才启用 burst、tombstone、anchors、evidence 等 smart window：`packages/api/src/context/hierarchical-context.ts:104-169`、`packages/api/src/context/hierarchical-context.ts:201-243`。同一 seam 还读取未完成 Task 快照；随后以“任务快照 + 历史上下文 + 当前 prompt”形成 `effectivePrompt`：`packages/api/src/app-factory.ts:813-842`。
- 每次调用会在 `InvocationRegistry` 创建 `invocationId` 和 callback token，用于 MCP callback 环境变量；该 registry 是 `Map`，不是 SQLite store：`packages/api/src/app-factory.ts:844-854`、`packages/api/src/invocation/invocation-registry.ts:69-110`。
- `invokeSingleAgent` 以 `(agentId, threadId)` 获取 `SessionMutex`，读取该 pair 的 active Session 并在存在时将 sessionId 传给 provider：`packages/api/src/invocation/invoke-single-agent.ts:253-291`。CLI 发出 `session_init` 时才在 `SessionStore` 中创建新 active Session，且不会向 UI 继续转发这个内部事件：`packages/api/src/invocation/invoke-single-agent.ts:320-329`。

### 4. CLI 调用与统一事件

- Provider 统一接口是 `AgentService.invoke(prompt, options) -> AsyncIterable<AgentMessage>`；options 承载 session resume、system prompt、MCP env、cwd、abort 和超时：`packages/api/src/providers/base.ts:22-50`。
- `invokeSingleAgent` 把 provider 流中的 `text`、`thinking`、`tool_use`、`tool_result`、`error`、`done` 等统一事件向上 yield，同时执行 invocation timeout、取消和有限重试；发生内容输出后会影响重试决策：`packages/api/src/invocation/invoke-single-agent.ts:268-412`。
- Codex adapter 以 `codex exec [resume <sessionId>] --json -- -` 启动，stdin 传入 prompt，逐行解析 stdout 为统一消息：`packages/api/src/providers/codex/codex-service.ts:106-130`、`packages/api/src/providers/codex/codex-service.ts:158-193`。
- Claude 和 Gemini 也各自 spawn 本地 CLI、逐行调用各自 parser，并输出同一 `AgentMessage` 协议：`packages/api/src/providers/claude/claude-service.ts:192-270`、`packages/api/src/providers/gemini/gemini-service.ts:122-170`。
- 事件协议自身携带 `agentId`、`invocationId`、`sessionId`、工具字段和 terminal 标志；这是跨 Provider 的统一载体：`packages/shared/src/types/message.ts:10-40`。invoke seam 为下游事件补充本次 invocationId 和已知 sessionId：`packages/api/src/app-factory.ts:1009-1057`。

### 5. 实时投影和落库位置

| 状态/事实 | 当前拥有者或路径 | 当前存放位置 |
|---|---|---|
| Thread 元数据（title、participants、projectPath、routing policy、lastActive） | handler/router 调用 `SqliteThreadStore` | SQLite `threads`；首条消息创建，回合结束更新活跃时间。`packages/api/src/routes/message-handler.ts:126-139`、`packages/api/src/routes/message-handler.ts:245-254` |
| 用户消息与 Agent 最终回复 | handler 的 `SqliteMessageStore` | SQLite `messages`；用户消息先写，Agent 流结束后每 Agent 聚合为一条 `origin: 'stream'` 回复，并带 `extra` 与 sessionId。`packages/api/src/routes/message-handler.ts:462-487` |
| 历史/working context | invoke seam + Context Builder | 不单独保存“本次 prompt 快照”；从 `messages`、`tasks`、`evidence` 和 Thread 元数据每次重新组装。`packages/api/src/app-factory.ts:775-842` |
| Provider continuity/session archive | `SessionStore` | SQLite `sessions`；按 `(agent, thread)` 最多一个 active，Session transcript 复用已带 sessionId 的 messages/tool events。`packages/api/src/invocation/session-store.ts:121-139`、`packages/api/src/invocation/session-store.ts:251-276` |
| 工具调用 | handler 聚合后 `SqliteToolEventLog` | SQLite `tool_events`；工具事件也放在 Agent 回复的 `extra.toolEvents` 主消息 sink，独立 feed 写失败仅记录 warning。`packages/api/src/routes/message-handler.ts:490-548` |
| Invocation callback 身份、TTL、latest、客户端回调去重 | `InvocationRegistry` | **仅进程内 Map**，重启丢失。`packages/api/src/invocation/invocation-registry.ts:69-178` |
| 取消控制器、同 Thread 的 broadcast 顺序 | `SocketManager` | **仅进程内** AbortController maps / promise sequencer。`packages/api/src/infrastructure/socket-manager.ts:97-180` |
| 实时统一事件与状态 | handler 调用 SocketManager | Socket.IO thread room 的 `agent_event`、`agent_status`、`thread_update` 等；这是 UI 投影，工具事件可能因限流被省略。`packages/api/src/routes/message-handler.ts:190-225`、`packages/api/src/infrastructure/socket-manager.ts:20-59`、`packages/api/src/infrastructure/socket-manager.ts:167-239` |
| 审计 | invoke seam + `SqliteEventAuditLog` | SQLite `audit_events`：`invoked`、`responded`/`error`，Session seal 另记；append 是异步 best-effort。`packages/api/src/app-factory.ts:360-381`、`packages/api/src/app-factory.ts:975-997`、`packages/api/src/app-factory.ts:1059-1098`、`packages/api/src/stores/sqlite-event-audit-log.ts:57-108` |
| Task / task-progress | Task store；invoke seam 从 TodoWrite tool frame 更新 progress | SQLite task 表；Task snapshot 会被注入下一次 prompt，progress 是最新快照而非 Run 状态。`packages/api/src/app-factory.ts:822-842`、`packages/api/src/app-factory.ts:1019-1045` |
| Evidence | `SqliteEvidenceStore` 通过 recaller 查询 | SQLite evidence 表；作为 context recall 输入，并非当前回合的唯一事实账本。`packages/api/src/app-factory.ts:766-769`、`packages/api/src/app-factory.ts:813-820` |

## 当前实现边界（不能误称为已具备）

1. 当前主链是“Thread 消息直接驱动路由与 CLI”，不是由持久化 Run 状态机调度。`InvocationRegistry`、取消、串行 worklist 都是内存态；进程重启后不会恢复其权威执行状态。
2. 审计是 SQLite 中可查询的关联记录，但其写入明确是 best-effort，不能当作和执行状态原子提交的 event-sourcing ledger：`packages/api/src/app-factory.ts:975-984`。
3. Session 代表 provider continuity，而不代表业务工作完成；当前 provider 的 session 语义仍由 adapter 吸收，不能假设 Claude、Codex、Gemini 完全等价。
4. 实时 Socket.IO 流是 UI 投影；最终回复才在回合结束后持久化。高频工具事件还可能不广播，但并不影响其后续的工具事件/回复持久化：`packages/api/src/infrastructure/socket-manager.ts:167-180`。

## 与已冻结目标设计的区别

目标设计明确把 Thread 定位为协作空间，而不是执行状态；Work Item、Run、Invocation 分别拥有目标、一次有界尝试和一次 CLI 激活的生命周期。参见 [Collaboration](../../architecture/collaboration/design.md) 与 [Work Orchestration](../../architecture/work-orchestration/design.md)。

目标态要求单一 Work Orchestration Interface 以 `submit(WorkCommand)` / `inspect(WorkQuery)` 统一所有有状态入口，并持久拥有 Work Item、Run、Invocation、命令回执、队列与重启 reconciliation。它还要求状态转换、durable fact、audit 与 outbox 对同一决策原子提交，且终态 Invocation/Run 不回到非终态。参见 [Work Orchestration](../../architecture/work-orchestration/design.md)。

因此，当前链中值得保留的是统一 Provider 事件、串/并行协作、Session continuity、SQLite 协作历史和 Web/平台复用入口；需要由目标架构替换的则是 Thread 直接拥有执行生命周期、内存 Invocation/cancel 状态、best-effort audit、无 durable dispatch queue 和无 restart reconciliation。目标缺口汇总见 [架构总览](../../architecture/overview.md#current-to-target-summary)。

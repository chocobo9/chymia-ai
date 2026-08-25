# Chymia 架构梳理

> 状态：历史架构梳理；不作为当前设计或完成度真相。

## 一、项目定位

### Chymia 是什么？

Chymia 是一个面向软件开发场景的本地多 Agent 协作平台。代码上它由几层组成：

- `packages/api`：路由、状态、上下文组装、回调处理、任务和会话管理
- `packages/mcp-server`：MCP 工具进程
- `packages/adapters`：外部 IM 接入
- `packages/web`：前端界面
- `packages/shared`：共享类型

它不是单一 agent，也不是一个纯聊天壳，而是一个把消息路由、agent 执行、工具调用、会话存档和外部适配串起来的系统。

---

## 二、Agent 编排层

### 有哪些 Agent？

静态 roster 在 `packages/api/src/config/agents.yaml`，当前是 3 个：

- `claude-opus`
- `codex-gpt`
- `gemini-pro`

`app-factory.ts` 里还支持运行时增员，所以 roster 不是写死不可变的。

### Agent 输入与输出

代码里没有“Planner / Coder”这种单独类名作为系统强约束，实际是按角色配置和路由行为来驱动：

- `AgentRouter` 决定哪个 agent 执行
- `invokeSingleAgent()` 负责跑一次 agent turn
- `AgentService.invoke()` 负责真正调用 provider CLI

### Agent 如何协作？

仓库里实际存在两条执行路径：

#### 1. Supervisor / Router 路径

对应代码主要在：

- `packages/api/src/routing/agent-router.ts`
- `packages/api/src/routing/route-serial.ts`
- `packages/api/src/routing/route-parallel.ts`

它做的事情是：

- 解析 `@mention`
- 处理 `@all`
- 根据目标数和显式 tag 决定 `ideate` 或 `execute`
- 决定走串行还是并行
- 维护串行 worklist
- 根据 agent 回复里的行首 `@mention` 动态追加后续 agent

#### 2. Invoke / Provider 路径

对应代码主要在：

- `packages/api/src/invocation/invoke-single-agent.ts`
- `packages/api/src/providers/base.ts`
- 具体 provider 实现目录下的 CLI adapter

它做的事情是：

- 传入 system prompt、上下文、working directory、callback env
- 调起真实 provider CLI
- 处理 session resume
- 处理 retry

所以准确说，编排不是一个统一的 DAG 引擎，而是：

- 路由层：决定谁执行、怎么串起来
- 执行层：负责真正跑一次 agent turn

---

## 三、任务执行流程

### Chymia 实际怎么跑？

代码链路是：

`User Request -> AgentRouter.resolveRouting -> parseIntent -> routeSerial / routeParallel -> invokeSingleAgent -> AgentService.invoke -> provider CLI -> MCP callback -> API callback routes`

### 是否有迭代循环？

有。不是单轮生成后结束。

在代码里：

- `invokeSingleAgent()` 有 retry loop
- `routeSerial()` 会把前一个 agent 的输出拼进下一个 agent 的 prompt
- 串行链里 agent 回复中的行首 `@mention` 还能继续扩展 worklist

因此任务执行不是“一次生成直接结束”，而是一个带状态、带回路、带扩展的执行过程。

---

## 四、Context 管理

### Agent 如何理解代码库？

不是一个“自动读完整仓库”的机制，而是由多个明确的数据源拼出来：

- `messageStore.getByThread(threadId)`：线程历史消息
- `threadStore.get(threadId)`：线程信息
- `sopService.getStageHint(...)`：SOP 提示
- `taskStore.listByThread(threadId)`：当前任务快照
- `buildHierarchicalContext(...)`：历史与 evidence 上下文
- `skillService`：启用技能块

这些在 `packages/api/src/app-factory.ts` 里的 `buildInvokeAgentFn()` 中组装成最终 prompt。

### Context 如何控制？

代码里的实际控制点是：

- 历史消息窗口
- task snapshot 注入
- evidence recall
- SOP hint
- skill block
- `AUDIT_INPUT_MAX_CHARS` 截断审计输入

所以 context 管理是“分层注入 + 截断 + 组合”，不是单纯把全部历史一次性塞进去。

---

## 五、Tool System

### Tool 怎么注册？

MCP 工具系统在 `packages/mcp-server/src`，核心结构是：

- `ToolDef` 定义工具名、描述、输入 schema、handler
- `index.ts` 里 `buildAllTools(client)` 收集所有工具
- `McpServer.registerTool(...)` 逐个注册

### Tool 调用怎么走？

工具 handler 不直接碰业务状态，而是通过 `CallbackClient` 调回 API。

`CallbackClient` 做的事：

- 读取 `CHOCO_API_URL`
- 读取 `CHOCO_INVOCATION_ID`
- 读取 `CHOCO_CALLBACK_TOKEN`
- 请求 `POST /api/callback/<toolName>`
- 带上：
  - `x-invocation-id`
  - `x-callback-token`

### Tool Schema 有没有校验？

有。`inputSchema` 用的是 `zod` 的 `ZodRawShape`，由 MCP SDK 在调用前做输入校验。

---

## 六、MCP 集成

### MCP Client 怎么实现？

当前实现是 **stdio**。

`packages/mcp-server/src/index.ts` 使用的是：

- `McpServer`
- `StdioServerTransport`

也就是说，MCP server 是一个 CLI 子进程，通过 stdio 跑 JSON-RPC 协议。

### Tool Discovery 怎么做？

通过 MCP 标准的 `tools/list` 能发现工具。实现上是：

- 工具先在 `buildAllTools()` 里构造成 `ToolDef[]`
- 再注册进 `McpServer`
- 客户端自然可以列出已注册工具

### MCP Tool 怎么接入 Agent？

链路是：

`provider CLI -> 启动 MCP 子进程 -> stdio MCP 协议 -> tool handler -> CallbackClient -> API callback route`

在 `packages/api/src/providers/mcp-config.ts` 里会构造 Claude CLI 的 `mcpServers` 配置。
`app-factory.ts` 里只有当 `cfg.mcpSupport === true && cfg.clientId === 'anthropic'` 时，才把这份配置注入给 Claude provider。

### 回调 API 怎么鉴权？

`packages/api/src/routes/callback-routes.ts` 里每个回调都先过：

- `buildCallbackAuthPreHandler(invocations)`

然后通过：

- `getInvocationRecord(request)`

拿到已经认证过的 invocation record。
身份不是从 body 里读，而是从 record 里取。

---

## 七、状态管理

### 会话状态放在哪里？

主状态存储是 SQLite。已有的 store 包括：

- `SqliteMessageStore`
- `SqliteThreadStore`
- `SqliteTaskStore`
- `SqliteToolEventLog`
- `SqliteEventAuditLog`
- `SqliteEvidenceStore`
- `SqlitePlatformMappingStore`
- `SessionStore`

### 存了什么？

代码里已经明确分开：

- Task：当前任务和任务板状态
- Agent State：执行过程、invocation、session、tool events
- Context：历史消息、证据、审计事件、会话摘要

### 是否支持 Checkpoint / Resume / Replay？

按当前代码：

- Resume：支持
- Checkpoint：支持到 session/archive 层
- Replay：支持读 session chain / digest / events，但不是完整执行重放引擎

`invokeSingleAgent()` 里会根据 `sessionStore.getActiveSessionId()` 恢复 session，并在 `session_init` 时重新开 session。

---

## 八、实际规模

当前仓库的事实口径可以写成：

- Agent 数量：静态 3 个，运行时可增员
- Tool 数量：当前 MCP server 里是 9 个工具
- MCP Server：1 个，名字是 `choco`
- 项目规模：`STATUS.md` 当前按 8k+ LOC 量级描述
- 单任务规模：复杂任务通常会落到多轮调用和测试回路上，不是单次工具调用就结束

---

## Clowder 参考对照

这部分只作为后续拓展参考，不混进上面的当前实现结论。

### 模型范围

Clowder 这边我只按你确认过的三类来对照：

- `Codex`
- `Claude`
- `Gemini`

不把 `Kimi`、`Antigravity` 之类算进这次对照范围。

### 路由层

Clowder 的路由入口在 `packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts`。

它比当前实现多了这些东西：

- `resolveTargetsAndIntent()`：把 target 解析和 intent 解析合在一起
- `peekTargets()` / `resolveTargets()`：区分只读预览和持久化写入
- `threadStore.addParticipants(...)`：把 mention 写回 thread participants
- `findRecentUserMentionFallback()`：按最近 user mention 做 fallback
- `applyThreadRoutingPolicy(...)`：线程级路由策略
- `route()` / `routeExecution()`：把“写消息”和“执行”拆开

简单标记：
- 当前实现有：`resolveRouting`、`routeSerial`、`routeParallel`
- Clowder 多出来的：`thread participant` 持久化、thread routing policy、peek/execute 分离

### 单次执行层

Clowder 的单次执行入口在 `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`。

它比当前实现多的主要是：

- session chain
- runtime session
- transcript writer / reader
- task progress
- malformed toolcall recovery
- timeout / liveness 转译
- OTel span / audit 事件

简单标记：
- 当前实现有：session resume、retry、基础 mutex、事件流 yield
- Clowder 多出来的：完整 session/runtime/transcript/progress 状态机

### Context 层

Clowder 的系统 prompt 在 `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts`。

它的注入层比当前实现重很多，除了身份和 teammate 信息，还包括：

- reviewer section
- direct message hint
- cross-thread reply hint
- ping-pong warning
- routing policy
- SOP stage hint
- voice mode
- bootcamp state
- guide candidate
- world context
- always_on docs
- active signals

另外还有：

- `packages/api/src/domains/cats/services/session/formatTaskSnapshot.ts`
- `packages/api/src/domains/cats/services/context/prompt-digest.ts`

简单标记：
- 当前实现有：历史消息、task snapshot、SOP hint、skills、evidence recall
- Clowder 多出来的：更密的 per-invocation prompt 注入层和审计摘要层

### MCP 层

Clowder 的 MCP 不是单一配置文件，而是完整适配层，入口在 `packages/api/src/config/capabilities/mcp-config-adapters.ts`。

它支持：

- Claude `.mcp.json`
- Codex `.codex/config.toml`
- Gemini `.gemini/settings.json`
- Kimi `.kimi/mcp.json`
- Antigravity 配置

它还做：

- 读写各 provider 配置
- 保留用户自定义 server
- 清理 deprecated managed server
- 注入 workspace root
- 注入 provider-specific env

简单标记：
- 当前实现有：Claude 的 MCP 配置生成 + `stdio` MCP server + HTTP callback
- Clowder 多出来的：多 provider 配置适配、stale cleanup、workspace/env 注入、managed server 生命周期管理

### 结论标记

当前实现和 Clowder 对比，明显缺口集中在：

- MCP 配置/适配层
- session/runtime/transcript/progress 状态机
- 更完整的 context 注入层

路由和单次执行有基本骨架，但还没有 Clowder 那么厚。
## 核心功能优先级表

这是按“平台核心”视角整理的事实表，用来区分当前已经真实支持的能力和明显缺口。

| 核心块 | 当前项目实际做了什么 | Clowder 做到了什么 | 结论 |
|---|---|---|---|
| 路由与执行 kernel | `AgentRouter` 负责 `@mention`、`@all`、fallback、`ideate/execute`，`routeSerial` / `routeParallel` 决定串行或并行，`invokeSingleAgent` 负责 session resume、retry、provider 调用 | 路由更厚，带 thread participant 持久化、路由策略、runtime session、transcript、audit | 这是平台核心，当前是真实存在的，不是概念 |
| MCP / tool bridge | 有 `packages/mcp-server`，是 `stdio` MCP server，通过 callback 路由回 API；工具已经有 evidence / message / file / session / sop；Claude 有 `mcp-config` 注入 | 不是只给 Claude 配一个 server，而是 Claude / Codex / Gemini / Kimi / Antigravity 一整套配置适配、清理、workspace/env 注入 | 这是平台核心，而且当前明显是短板，不是“差不多支持” |
| 状态 / 会话 | SQLite 存 message / thread / task / tool_event / event_audit / evidence / platformMapping / session；`SessionStore` 支持 active / sealed、resume、reopen、digest | session chain + runtime session + transcript writer / reader + task progress + sealer 更完整 | 这是平台核心，当前有基础，但不是 Clowder 那种完整状态机 |
| Context 组装 | `buildInvokeAgentFn` 里拼 history、task snapshot、SOP hint、evidence recall、skill block，再交给 provider | system prompt 更厚，包含 reviewer、ping-pong、cross-thread、bootcamp、guide、world、signals、always_on 等多层注入 | 这是平台核心，当前已经在做，但密度比 Clowder 轻 |
| Roster / provider / ingress | 只有 `Claude / Codex / Gemini` 三个固定 roster，支持运行时增员；`submitPlatformMessage`、Feishu / Weixin manager 已有 | 更完整的 agent catalog、模型解析、动态参与者管理、更多外部配置流 | 这是平台支撑层，重要，但可以比 kernel 更容易收缩 |

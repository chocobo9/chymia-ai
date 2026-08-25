# Issue-driven orchestration：Symphony 源码审视、Clowder 对照与 Chymia 采用建议

> 状态：外部研究；non-canonical。
> 研究日期：2026-07-13
> 上游仓库：[openai/symphony](https://github.com/openai/symphony)
> 固定版本：[`4cbe3a9699a73b862466c0b157ceca0c1985d6d7`](https://github.com/openai/symphony/tree/4cbe3a9699a73b862466c0b157ceca0c1985d6d7)
> 资料边界：只使用该仓库的 README、规范、Elixir 参考实现与仓库自带工作流；所有源码链接均固定到上述 commit。

## 结论先行

Symphony 最准确的定位不是“多 agent 协作框架”，而是 **issue-driven、tracker-mediated 的多 worker 调度器**：它并发运行多个 issue，但一个 issue 在任一时刻只对应一个 `AgentRunner`、一个 Codex app-server 进程和一个 live thread。其优秀之处是把 issue 变成跨运行、跨重启、跨人机边界的工作协议，把 workspace 变成隔离的执行单元，把 orchestrator 限制为读取 tracker、认领、调度、重试和对账的控制面。官方也把它描述为“isolated, autonomous implementation runs”，并明确 Elixir 版本只是 evaluation prototype，而非生产成品。[根 README 3–11](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/README.md#L3-L11)；[Elixir README 3–8](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/README.md#L3-L8)

因此，Symphony 的 issue 思想很适合成为多 agent 系统的**外层协调骨架**，尤其适合：持久任务登记、依赖与状态门、独占认领、失败恢复、工作目录隔离、人与 agent 的异步交接、用 tracker 状态作为完成协议。但它没有提供 issue 内的 planner/implementer/reviewer 角色、子任务 DAG、agent 间消息、成果合并或共识机制；如果直接称其为“多 agent 协作”，会把“多个独立 agent 并发工作”误认为“多个 agent 共同完成同一任务”。

## 1. 系统边界：tracker 是控制面，workspace 是数据面

规范把系统拆成五层：workflow loader/config、orchestration、workspace + agent subprocess、Linear adapter、observability。核心目标是固定周期轮询、有界并发、单一权威调度状态、每 issue 确定性 workspace、运行中状态对账，以及 tracker 进入不合格状态时停止 agent。[SPEC 18–29](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L18-L29)；[SPEC 48–53](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L48-L53)

其边界刻意很窄：

- orchestrator 读 tracker，并根据 tracker 状态决定“是否该运行”；
- coding agent 通过 prompt 和工具写 tracker，决定“工作做到了什么程度”；
- workspace 保存代码与运行现场，并在同一 issue 的后续 session 中复用；
- Git/PR/评论/状态迁移不是 orchestrator 的内置业务逻辑，而是 prompt 驱动的 agent 行为。

这是一项关键设计选择。规范明确说 orchestrator 不要求 first-class tracker write API；工单状态、评论和 PR 元数据通常由 agent 工具处理，服务保持为 scheduler/runner + tracker reader。[SPEC 1213–1223](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L1213-L1223)

## 2. 四个状态域必须分开理解

### 2.1 Issue：外部、持久、业务真相

标准化 issue 包含稳定内部 ID、可读 identifier、title、description、priority、tracker state、branch/url、labels、blockers 与时间戳。内部 map 必须用 tracker ID，而不是可读编号；workspace 才用消毒后的 identifier。[SPEC 150–177](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L150-L177)；[SPEC 275–287](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L275-L287)

Issue state 是业务工作流状态，如 `Todo`、`In Progress`、`Human Review`、`Merging`、`Rework`、`Done`。仓库自带工作流把 `Todo/In Progress/Merging/Rework` 配为 active，把 `Done/Closed/Cancelled/Duplicate` 配为 terminal。[WORKFLOW 1–18](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L1-L18) 这里存在一个容易忽略的事实：`Human Review` 不在 active states，也不在 terminal states；对 orchestrator 而言，它是“暂停执行、保留 workspace”的非活跃交接态。

### 2.2 Workspace：issue 的持久执行现场

Workspace 的逻辑字段只有绝对路径、消毒后的 key、是否本次新建。路径固定为 `<root>/<sanitized_issue_identifier>`；成功运行不会自动删除，同一 issue 后续 run 会复用，只有 terminal cleanup 才回收。[SPEC 201–209](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L201-L209)；[SPEC 820–846](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L820-L846)

这不是天然的 Git worktree 抽象。规范明确不要求内置 VCS/bootstrap；clone、checkout、依赖安装都交给 `after_create`/`before_run` hooks。[SPEC 848–867](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L848-L867) 示例工作流的 `after_create` 只是 `git clone ... .` 加依赖安装。[WORKFLOW 19–28](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L19-L28)

安全不变量是：agent 的 cwd 必须等于该 issue workspace；绝对路径必须在 workspace root 下；目录 key 只能含 `[A-Za-z0-9._-]`。[SPEC 894–912](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L894-L912) 参考实现还对本地路径做 canonicalize 与 symlink escape 检查。[workspace.ex 358–378](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/workspace.ex#L358-L378)

### 2.3 Run / live session：短生命周期、进程级状态

一次 run attempt 是一个 issue 的一次执行尝试，具有 attempt、workspace、开始时间、status/error；live session 进一步记录 `thread_id`、`turn_id`、`session_id=<thread>-<turn>`、app-server pid、最后事件、token 和 turn count。[SPEC 211–245](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L211-L245)

Run attempt 的概念阶段为 workspace preparation → prompt → process/session → streaming → finishing，终态区分 succeeded、failed、timed out、stalled、reconciliation canceled。区分失败原因不是展示细节，而是决定重试与日志语义。[SPEC 645–661](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L645-L661)

### 2.4 Orchestrator：单一权威、易失的调度真相

内部 claim 状态与 Linear 状态完全不同：`Unclaimed → Claimed → Running | RetryQueued → Released`。`claimed` 的意义是排重，不代表业务开始或完成。[SPEC 604–629](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L604-L629)

参考实现是一个 Elixir `GenServer`，唯一持有 `running`、`claimed`、`blocked`、`retry_attempts`、`completed` 与 token/rate-limit totals。[orchestrator.ex 24–43](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L24-L43) 所有 worker 结果以消息返回该进程，因而调度状态变更被串行化。规范明确 `completed` 只做 bookkeeping，不能作为不再 dispatch 的门；真正的完成真相仍是 tracker。[SPEC 260–273](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L260-L273)

这个状态**没有持久化 DB**。重启恢复依赖 tracker 与 filesystem；启动时只清 terminal issue 的旧 workspace。[SPEC 694–700](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L694-L700) `blocked` 也只在内存中，重启会让仍 active 的 issue 再次成为候选。[Elixir README 26–32](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/README.md#L26-L32)

## 3. Poll → claim → dispatch：排重与新鲜度检查

每个 poll tick 的顺序固定为：先 reconcile running/blocked，再 validate config，再拉 candidates、排序、耗尽并发槽位后停止 dispatch。[orchestrator.ex 248–257](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L248-L257) 规范强调即使本 tick 配置无效，也必须先对账已有 worker，不能因为无法派新活就失去停止旧活的能力。[SPEC 702–721](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L702-L721)

候选 issue 必须同时满足：必要字段完整、active 且非 terminal、assignee/labels 路由匹配、不在 running/claimed/blocked、全局与 per-state 槽位可用；`Todo` 若存在任一非 terminal blocker 也不能派发。[orchestrator.ex 804–825](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L804-L825) 排序为 priority 升序、created_at 最老优先、identifier 兜底，避免任意 API 顺序决定资源分配。[orchestrator.ex 784–802](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L784-L802)

真正 spawn 前还有第二次 `fetch_issue_states_by_ids`，若 issue 已消失、失去资格或刷新失败，就跳过。这缩小了“候选列表拉取”和“进程启动”之间的 TOCTOU 窗口。[orchestrator.ex 909–925](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L909-L925) Spawn 成功后才写入 `running` 和 `claimed`，并 monitor task；同一 `GenServer` 内串行执行使检查与写入相对其他调度事件原子。[orchestrator.ex 942–980](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L942-L980)

### Grill：认领只在单进程内有效

`claimed` 是内存 `MapSet`，不是 tracker 上的 lease，也没有数据库唯一约束。它能防止**同一个 orchestrator 进程**重复 dispatch，却不能阻止两个 Symphony 实例监控相同 project/assignee/label 后同时认领同一 issue。这是从“一个 owner 的 worker daemon”扩展到“多 orchestrator 高可用集群”时最先需要补的缺口。

## 4. 并发与隔离

并发控制有三层：

1. 全局：`max_concurrent_agents - map_size(running)`；[orchestrator.ex 1329–1334](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L1329-L1334)
2. per tracker state：按 `running.issue.state` 计数，允许例如限制 `Merging` 任务；[orchestrator.ex 822–839](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L822-L839)
3. 可选 SSH worker host：按主机限流，优先沿用 retry 原主机，否则选择负载最小的可用主机。[orchestrator.ex 1241–1299](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L1241-L1299)

每 issue 一个 workspace；app-server 的 `thread/start` 与每次 `turn/start` 都带同一个绝对 cwd，turn 还带 `workspaceWrite` sandbox policy。[app_server.ex 280–320](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/codex/app_server.ex#L280-L320) 这是文件级隔离与执行上下文隔离，但不是资源/网络/凭据的完整安全边界。示例甚至开启 `networkAccess: true` 且 approval `never`；它假设 trusted environment。[WORKFLOW 29–38](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L29-L38)

### Grill：workspace 隔离不等于协作冲突消失

多个 issue 各自 clone 仓库能避免本地文件相互踩踏，却会把冲突推迟到 PR/main 集成阶段。Symphony 本身没有跨 issue 文件所有权、变更冲突预测、合并队列或共享资源锁；这些只能由 issue 依赖、分支策略、CI 与 agent workflow 约束补上。

## 5. Retry、continuation 与 reconciliation

### 5.1 正常结束也重试

一个 Codex turn 正常完成不代表 issue 完成。AgentRunner 会刷新 tracker：只要 issue 仍 active 且仍符合路由，就在同一 live thread、同一 workspace 内继续下一 turn，直到 `max_turns`；首 turn 用完整 issue prompt，后续只发 continuation guidance，避免重发原任务。[agent_runner.ex 87–138](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/agent_runner.ex#L87-L138)；[agent_runner.ex 141–168](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/agent_runner.ex#L141-L168)

即使 worker 正常退出，orchestrator 仍把 issue 记到 `completed`，随后安排 1 秒 continuation check；若 tracker 还 active，又起一个新 worker/session。[orchestrator.ex 200–215](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L200-L215) 这形成一个重要的“外部状态闭环”：模型说“完成”不是结束条件，agent 必须把 issue 推到非 active 状态。

### 5.2 异常退出指数退避

失败从 10 秒开始指数退避，公式为 `min(10000 * 2^(attempt-1), max_retry_backoff_ms)`；continuation 的 attempt 1 固定 1 秒。旧 timer 会取消，并用 `retry_token` 忽略过期 timer 消息。[orchestrator.ex 1023–1061](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L1023-L1061)；[orchestrator.ex 1192–1203](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L1192-L1203)

Retry timer 触发后重新拉 active candidates；issue 不可见/不再 active 就 release claim，仍符合条件但无槽位则再排队。[orchestrator.ex 1082–1124](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L1082-L1124)；[orchestrator.ex 1162–1179](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L1162-L1179)

### 5.3 每 tick 对账外部真相

Reconciliation 先检测 stall：以最后 Codex event 时间为准，没有事件则用 started_at；超时杀 worker 并排重试。[orchestrator.ex 574–627](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L574-L627) 再批量刷新所有 running issue：terminal 则停止并清 workspace，失去路由或变成非 active 则停止但保留 workspace，仍 active 则刷新 snapshot；刷新失败时宁可保持 worker 运行，下 tick 再试。[orchestrator.ex 302–323](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L302-L323)；[orchestrator.ex 413–431](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L413-L431)

若 Codex 请求 operator input/approval/MCP elicitation，当前实现不是无限重试，而是停止 run、保留 claim，放入内存 `blocked`，由对账观察 tracker 后续变化。[orchestrator.ex 652–707](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L652-L707)；[orchestrator.ex 740–766](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L740-L766)

### Grill：重试没有死信与错误分类策略

除 operator-input blocker 外，大部分异常都走同一无上限指数退避路径。Prompt 模板错误、永久权限错误、仓库 bootstrap 错误与偶发网络错误没有不同 retry budget，也没有 durable dead-letter queue。长期运行时，这会制造“永远 claimed、周期烧 token/资源”的毒任务；生产化至少需要错误可重试分类、最大尝试/时间预算、持久化 retry state 和人工处置态。

## 6. Prompt、结果交付与真正的完成判定

### 6.1 Prompt 是版本化工作流，而不是硬编码任务模板

`WORKFLOW.md` 的 YAML front matter 配运行策略，Markdown body 配 per-issue prompt。PromptBuilder 使用 strict variables/filters，将完整 issue 结构与 `attempt` 注入 Solid template；模板解析失败直接使 run 失败并交给 orchestrator 重试。[prompt_builder.ex 8–42](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/prompt_builder.ex#L8-L42)

示例 prompt 要求 agent：先读 issue 状态、维护唯一 `## Codex Workpad` 评论、把 acceptance/validation 变成 checklist、持续更新 issue 元数据，并用 Linear 工具进行状态迁移。[WORKFLOW 78–95](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L78-L95) Workpad 是跨 turn/session 的持久进度账本；workspace 是代码现场；Codex thread history 只服务单 worker lifetime。

### 6.2 App-server “turn 完成”只表示协议完成

Symphony 启动 app-server，创建 thread，再以 issue title 和 prompt 启动 turn；`turn/completed` 返回 success，`turn/failed`、cancelled、timeout 或 port exit 返回 failure。[app_server.ex 69–138](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/codex/app_server.ex#L69-L138)；[app_server.ex 329–394](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/codex/app_server.ex#L329-L394)

但 app-server result 没有被 orchestrator 当成“业务成果包”投递给谁；结果交付发生在 agent 产生的外部副作用里：修改 workspace、push branch/PR、更新 Linear workpad、链接 PR、迁移状态。示例 workflow 明令只维护一个 persistent workpad，不发额外 done comment。[WORKFLOW 139–168](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L139-L168)；[WORKFLOW 220–236](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L220-L236)

### 6.3 三层完成必须分开

- **Turn completion**：Codex 协议报告本 turn 正常结束；只触发 tracker refresh。
- **Agent handoff completion**：agent 满足工作流 quality bar，把 issue 从 active `In Progress` 移到非 active `Human Review`；此时 Symphony 停止继续工作，但 workspace 保留。
- **Issue terminal completion**：PR 合并后 agent/human 把 issue 移到 `Done`；Symphony 停止活跃 agent 并清 workspace。

示例的 Human Review gate 要求 checklist、acceptance、validation、PR feedback、CI、branch/PR linkage 全部满足。[WORKFLOW 264–272](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L264-L272) Human Review 后人决定是否进 `Merging`，agent 负责 land，合并后才写 `Done`。[WORKFLOW 243–250](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L243-L250)

### Grill：完成正确性主要靠 prompt，不靠结构化证据

Orchestrator 只看 tracker state，不解析 acceptance checklist、测试结果、PR checks 或 reviewer status。换言之，“Human Review/Done 是否诚实”主要由 prompt、agent 工具与平台权限保证。示例 workflow 很强，但它是文本政策，不是调度器内的机器可验证 invariant。适配到高风险多 agent 系统时，应把关键 gate（测试、review、artifact、依赖完成）结构化并由独立 verifier 写回，而不是只相信执行 agent 自报状态。

## 7. Linear 与 GitHub 的明确边界

当前规范只实现 `tracker.kind: linear`。Tracker adapter 的必需读操作只有：拉 active candidates、按 state 拉 terminal issue、按 IDs 刷新 running issue；Linear 细节包括 project `slugId`、分页、labels、block relations 与 GraphQL ID 类型。[SPEC 1141–1179](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L1141-L1179)

GitHub 不是 orchestrator tracker。它只出现在 agent workflow：agent 用 `gh` 拉 top-level/inline review 与 review states，反复处理反馈；push PR、挂 issue attachment、等待 checks；进入 `Merging` 后用 `land` skill 合并。[WORKFLOW 170–184](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L170-L184)；[WORKFLOW 198–250](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L198-L250)

所以：

- Linear 决定 eligibility、依赖、交接和生命周期；
- GitHub 保存代码审查/CI/merge 事实；
- agent 负责把两边事实桥接起来；
- orchestrator 不验证 GitHub 事实，也不把 GitHub issue 当调度源。

若要支持 GitHub Issues 驱动，不能只替换 API client；还要定义 active/terminal/handoff 状态映射、blocker 关系、assignee/label 路由、PR linkage 与原子 claim/lease 方案。GitHub 原生 issue state 只有 open/closed，通常必须以 labels/projects fields 补足工作流。

## 8. 哪些机制适合多 agent 协作

### 可直接吸收

1. **Issue 是持久协调记录，不是一次 prompt。** 任务描述、状态、依赖、验收、评论和链接跨 agent/session 存续；agent 可随时从 tracker + workspace 恢复。
2. **控制面与执行面分离。** Orchestrator 只做 eligibility/claim/dispatch/retry/reconcile；领域工作流放在版本化 prompt 与 skills，减少 scheduler 被业务逻辑污染。
3. **显式 claim + dispatch 前再验证。** 适合作为多 agent 系统防重复领取、抗 stale queue 的基本模式。
4. **外部状态闭环。** Agent 自称完成无效，必须把共享 issue 状态推进到 handoff/terminal；正常 exit 也复查并继续。
5. **依赖门。** `Todo` 的 non-terminal blocker 阻止调度，可把 task graph 放在 issue tracker，而不是只存在 planner 的上下文里。
6. **每 issue workspace + 可重入。** 重试复用现场，不从头调查；不同 issue 互不踩文件。
7. **持续 reconciliation。** 人改变 state、label、assignee 或关闭 issue，运行中的 agent 会被撤销；这使 tracker 真正成为可干预的控制面。
8. **唯一 workpad。** 单一可编辑进度评论比散落的“完成汇报”更适合跨 agent handoff；它是 issue 内的 append/update checkpoint。
9. **handoff state 与 terminal state 分离。** `Human Review` 暂停机器、保留 workspace，`Done` 才清理，适合人机或 agent-agent review 门。

### 需要补一层才能成为多 agent 协作

1. **Durable lease。** 把 `claimed` 从单进程内存集合升级为 tracker/DB 中带 owner、TTL、heartbeat、fencing token 的租约。
2. **结构化角色与产物。** 为 planner/implementer/reviewer/verifier 定义独立 issue/sub-issue、输入/输出 artifact 与允许的状态迁移；不能只共享一个自由文本 prompt。
3. **独立完成判定。** 执行 agent 不应同时是唯一验收者；由 verifier/checks 产生机器证据并控制 handoff gate。
4. **依赖传播与取消。** Blocker 完成后唤醒 downstream，upstream 变更/失败时使下游 stale 或 canceled，而不只是 poll 时看当前状态。
5. **冲突与集成控制。** 增加文件/模块 ownership、变更冲突预检、merge queue、base refresh 规则。
6. **消息与发现。** 若同一 issue 内多 agent 并行，需要 artifact registry 或 topic/mailbox；Symphony 的 Codex threads 彼此不可见。
7. **有界失败。** Durable retry、dead letter、error classification、budget 与 operator escalation。

## 9. 哪些只是 single-agent work dispatcher

- 每个 dispatch 明确创建一个 `Task.Supervisor` child，调用一次 `AgentRunner.run(issue, ...)`；没有子 agent topology。[orchestrator.ex 942–945](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/orchestrator.ex#L942-L945)
- 一个 worker lifetime 只创建一个 app-server thread，所有 continuation turn 复用该 thread；它是同一 agent 的连续工作，不是 agent 之间 handoff。[agent_runner.ex 87–125](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/agent_runner.ex#L87-L125)
- `max_concurrent_agents` 表示同时处理多少 issue，不表示一个 issue 有多少协作者。
- `blocked_by` 只在 `Todo` eligibility 中作为门，不生成/调度依赖子任务，也不汇总上游产物。
- Reviewer 是 GitHub 人/机器人反馈的外部角色；执行 agent 自己读取并处理，并非 Symphony 派出的独立 review agent。
- `completed` 只是内存统计；没有结果对象、artifact graph 或 contributor attribution。

可用一句话概括：**Symphony 已实现 multi-agent fleet management，但没有实现 intra-task multi-agent collaboration。**

## 10. 建议的借鉴顺序

如果要把该思想用于多 agent 系统，建议先复制它最深、最稳定的 seam，而不是照搬 Elixir 代码：

1. 定义 tracker-neutral `Issue`、`Claim/Lease`、`RunAttempt`、`Workspace`、`Artifact`、`Dependency` 领域模型；
2. 固定状态语义：queued、active、handoff、blocked、terminal 与 internal claim 分离；
3. 先做单 orchestrator 串行调度状态 + pre-dispatch refresh + reconciliation；
4. 为每 issue/子 issue 创建可重入隔离 workspace；
5. 把 workpad、验收、证据、role output 结构化；
6. 再增加多角色 issue DAG 与独立 verifier；
7. 最后才做多 orchestrator HA、远程 worker 和高级资源调度。

Symphony 最值得借鉴的不是“让更多 agent 同时跑”，而是把 agent 的自主运行约束在一个可观察、可撤销、可恢复、由外部业务状态闭环的任务协议中。

## 11. 风险清单

| 风险 | 当前机制 | 生产化缺口 |
|---|---|---|
| 双重认领 | 单 GenServer `claimed` 排重 | 多实例 durable lease/fencing |
| 重启恢复 | tracker + workspace 重建 | run/retry/blocked/owner 不持久 |
| 毒任务 | 无限指数退避至上限 | retry budget、分类、dead letter |
| 伪完成 | agent 写 tracker state | 独立 verifier + 结构化 gate |
| workspace 冲突 | 每 issue 目录隔离 | PR/main 集成冲突、共享资源锁 |
| 路由抖动 | 每 tick reconcile | 状态/label 临时变化会杀 run，缺 debounce/lease grace |
| tracker/API 故障 | fail-open 保持 running | 长时间失联下缺租约/熔断策略 |
| 依赖表达 | Linear blockers，仅 `Todo` gate | DAG 调度、产物绑定、失败传播 |
| 安全 | cwd/sandbox/path safety | 网络、secret、remote host 与 hook 信任边界 |
| 可观测性 | 内存 snapshot、事件/token | durable audit、因果 trace、跨 agent attribution |

## 12. 最终判断

Symphony 的 issue-driven 方案是一个很好的多 agent **系统底座思想**，因为它把“工作是否还该继续”从模型主观判断提升为共享 tracker 的显式状态，把失败恢复建立在可重入 workspace 和 reconciliation 上，把并发建立在 claim 与隔离上。它尤其适合把大工作拆成独立 issues，让不同 agent 各领一项并通过依赖、PR 和 handoff state 协作。

但同一个复杂 issue 内若需要多个 agent 共同推理、并行探索、交叉验证和合并成果，Symphony 只能提供外围生命周期，不能提供协作本身。正确的扩展方向不是让 orchestrator 直接理解所有角色业务，而是保留其薄控制面，在 issue/sub-issue、artifact、lease、verifier 和依赖传播上新增结构化协议。

## 13. Clowder 是否有类似思想

有，而且比“Clowder 也有任务列表”更接近 Symphony；但它分散在四套对象里，没有形成 Symphony 那种由外部 Issue 直接驱动执行的单一闭环。

### 13.1 Community Issue：外部 Issue 的同步、讨论与多 agent triage

Clowder 的 `CommunityIssueItem` 是 GitHub Issue 的内部投影，记录 issue type/state、回复状态、共识状态、分配的 Thread/Cat、关联 PR、方向卡和 guardian sign-off。状态为 `unreplied → discussing → pending-decision | accepted | declined | closed`，主要表达社区治理，不是代码执行尝试。[community-issue.ts](../../../reference/clowder-ai-main/packages/shared/src/types/community-issue.ts)

GitHub 同步会根据 labels/comments 映射状态；本地 `pending-decision/accepted/declined` 在 GitHub 未关闭时受到保护，不会被下一次拉取轻易覆盖。这已经具备“外部事实 + 本地过程状态”的雏形，但两者仍存放在同一个 Community Issue 记录上。[GitHubIssueFetcher.ts](../../../reference/clowder-ai-main/packages/api/src/domains/community/GitHubIssueFetcher.ts)；[community-issues.ts](../../../reference/clowder-ai-main/packages/api/src/routes/community-issues.ts#L170-L218)

它真正体现多 agent 的地方是 triage：非 bug 要等待第二只 Cat，禁止同一 Cat 重复提交，随后计算 consensus；不能形成明确共识时进入 owner decision，而不是让执行 agent自行拍板。[TriageOrchestrator.ts](../../../reference/clowder-ai-main/packages/api/src/domains/community/TriageOrchestrator.ts#L16-L56)

但 `dispatch` 只把 Issue 标为 `discussing` 并可绑定一个已有 Thread；`routeAccepted` 最多创建一个 Thread。这里没有 workspace、Run、claim、retry 或 issue-terminal reconciliation，所以 Community Issue 是**治理入口**，不是 Symphony 式 runner。[community-issues.ts](../../../reference/clowder-ai-main/packages/api/src/routes/community-issues.ts#L151-L168)；[TriageOrchestrator.ts](../../../reference/clowder-ai-main/packages/api/src/domains/community/TriageOrchestrator.ts#L58-L86)

### 13.2 Backlog / Mission Hub：最像 Symphony 的内部工作认领协议

`BacklogItem` 有显式状态 `open → suggested → approved → dispatched → done`，另带 claim suggestion、owner Cat、Thread phase、依赖、dispatch checkpoint、lease 与 audit。这是 Clowder 中与 issue-driven 最相似的一层。[backlog.ts](../../../reference/clowder-ai-main/packages/shared/src/types/backlog.ts)

它包含几项 Symphony 参考实现反而没有的可靠性机制：

- Cat 先提交 `why + plan + requestedPhase`，再由人批准；也可按 `disabled/once/thread/global` 策略 self-claim；[backlog.ts](../../../reference/clowder-ai-main/packages/api/src/routes/backlog.ts#L508-L622)
- dispatch 使用短锁、`dispatchAttemptId`、`pendingThreadId`、幂等 kickoff message，再原子切换到 `dispatched`，可以从中间 checkpoint 恢复；[backlog.ts](../../../reference/clowder-ai-main/packages/api/src/routes/backlog.ts#L180-L298)
- dispatch 后可取得带 TTL 的 lease，并 heartbeat、release 或在过期后 reclaim；不同 Cat 不能同时持有 active lease；[BacklogStore.ts](../../../reference/clowder-ai-main/packages/api/src/domains/cats/services/stores/ports/BacklogStore.ts#L342-L505)
- Backlog 与 Thread 双向绑定，Thread 再承载实际多 agent 对话与串行/并行路由。

但这里的 lease 只约束“谁拥有该 Backlog”，没有自动启动/停止 CLI，也没有在 lease 到期后自动创建新 Run；`markDone` 可以由普通 API 直接调用，并不检查测试、artifact、review、Thread terminal 或 Result Contract。[BacklogStore.ts](../../../reference/clowder-ai-main/packages/api/src/domains/cats/services/stores/ports/BacklogStore.ts#L507-L529)；[backlog.ts](../../../reference/clowder-ai-main/packages/api/src/routes/backlog.ts#L891-L912) 因此它是**可认领、可审计的任务治理层**，尚不是完成闭环严格的 autonomous runner。

### 13.3 Thread Task：协作清单，不是调度源

Thread 内的“毛线球” Task 状态为 `todo/doing/blocked/done`，可指定 owner Cat。它会被压缩为 Task Snapshot 注入 agent bootstrap，帮助换 session 后恢复当前分工。[task.ts](../../../reference/clowder-ai-main/packages/shared/src/types/task.ts)；[formatTaskSnapshot.ts](../../../reference/clowder-ai-main/packages/api/src/domains/cats/services/session/formatTaskSnapshot.ts)

Task 没有 claim/lease/workspace/run/retry/reconcile，普通 work task 的 done 也是人或 agent 更新。它适合表达“同一 Thread 内谁在做什么”，不应被提升为 Issue/Work Item 或执行事实源。

### 13.4 Invocation Queue：执行请求队列，不是工作队列

Clowder 的 `InvocationQueue` 按 Thread/User 保存 user、connector、agent 三类消息，支持幂等、优先级、continuation 和自动执行；其注释明确区分 `InvocationTracker = 谁在跑` 与 `InvocationQueue = 谁在等`。[InvocationQueue.ts](../../../reference/clowder-ai-main/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts#L1-L11)

Invocation lifecycle 又独立为 `queued → running → succeeded | failed | canceled`，失败允许 CAS-protected retry。[invocation-state-machine.ts](../../../reference/clowder-ai-main/packages/api/src/domains/cats/services/stores/ports/invocation-state-machine.ts) 这是健全的底层执行语义，但 Queue item 的 payload 是一次消息/激活，而不是一个 Issue；不能用它替代 Work Item/Run。

## 14. Symphony 与 Clowder 的互补关系

| 维度 | Symphony | Clowder | 对 Chymia 的意义 |
|---|---|---|---|
| 顶层工作边界 | 外部 Linear Issue | 内部 Backlog；Community Issue 只做治理 | Work Item 应是本地所有者，Issue 为可选绑定 |
| 调度单位 | 一个 Issue 一个 worker/session | 一条消息触发一条协作链 | Run 负责 Work Item 尝试，Invocation 负责单 agent 激活 |
| 多 agent | 多 Issue 并发，不做 Issue 内协作 | Thread 内串行、并行、A2A、双 Cat triage | 以 Clowder 机制填充 Run 内协作，不改变顶层所有权 |
| Claim | 单 orchestrator 内存排重 | Backlog approval + TTL lease/heartbeat/reclaim | 采用持久 lease + fencing，不采用纯内存 claim |
| Workspace | 每 Issue 确定性目录，跨 retry 复用 | Backlog 只绑定 Thread，不拥有隔离 workspace | 每 Run/写入分支需要明确 workspace lease |
| 对账 | 每 tick 对账 tracker，撤销失格 worker | invocation zombie 处理较强；Backlog 不自动对账执行 | tracker reconciliation 与 invocation reconciliation 都需要 |
| 完成 | tracker handoff/terminal 闭环，但 gate 多靠 prompt | Backlog done 可直接写；Task done 更弱 | Result Contract + verifier 必须成为机器 gate |
| 进度记忆 | 唯一 Linear workpad + workspace | Thread、Task Snapshot、session chain、evidence | Thread 保存协作，artifact/evidence 保存验收事实 |

一句话：**Symphony 解决“哪项工作现在该由机器运行”，Clowder 解决“多个 agent 在一个协作空间里如何轮转、交接和保持上下文”。** Chymia 若只复制前者，会得到稳健的单 agent fleet；只复制后者，会得到热闹但缺少顶层完成闭环的多 agent chat。

## 15. 对 Chymia 当前领域模型的 Grill

### 15.1 当前文档存在不能共存的术语真相

根 `CONTEXT.md` 与目标设计把概念分得很清楚：

- `Work Item`：Chymia 自有的编码目标；
- `External Issue Binding`：可选外部绑定；
- `Issue`：外部 tracker 拥有的工程记录；
- `Thread`：协作空间；
- `Run`：一次有界执行尝试；
- `Agent Invocation`：单个 CLI 的最小可控执行单元。

但 `CHYMIA-POSITIONING.md` 同时写了“Make issues first-class work objects”“long-term first-class work object: issue”和 `project → issue → sub-issue`。如果 Issue 是外部 tracker 记录，那么离线 Web/Feishu 创建的工作没有顶层对象；如果 Issue 是 Chymia 内部对象，`External Issue Binding` 与 glossary 中的 Issue 定义就失真。这个冲突必须在实现 issue runner 前解决。

本报告建议保留目标设计的边界：**Chymia 永远拥有 Work Item；外部 tracker 永远拥有 Issue；Binding 只映射身份与选定状态，不共享执行所有权。** 这并没有放弃 issue-driven，而是把它精确化为：`Issue eligibility → Work Item command → Run → Collaboration/Invocation → Result Contract → optional tracker write-back`。

### 15.2 不要让多个 agent 竞争同一个 Issue claim

对一个 Work Item 默认只允许一个 non-terminal Run。Run 内可以有多个 Invocation：

- planner → implementer → reviewer/verifier：同一 Run 的有界串行 Worklist；
- 独立研究、方案比较、只读 review：同一 Run 的 parallel fan-out + persisted join barrier；
- 两个会同时改代码的 agent：默认拆成 Sub-Issue/子 Work Item与独立 workspace；若不能拆，必须有不同 worktree 与合并责任人。

把同一外部 Issue 直接 assign 给多个自治 runner，会同时失去独占 workspace、唯一状态推进者和清晰失败归属。Clowder 的“第一 assignee 是 lead”适合人类治理，但不足以构成机器写入安全协议。

### 15.3 不要照搬 Symphony 的 tracker-as-completion

Symphony 依赖 agent 把 Linear 移到 `Human Review/Done`。Chymia 已经提出 `Result Contract`，这是更强的方向：Run success 应由结构化 artifact、测试/门禁证据、effect ledger 和独立 verifier 决定；tracker state 只是对外投影或人工交接信号。

因此状态推进应是：

1. tracker 变化产生幂等 `WorkCommand`；
2. Work Orchestrator 决定是否创建/取消/暂停 Run；
3. Run 内 Invocation 只产生事实和 artifact，不能直接自封成功；
4. Evaluation 给出 contract verdict；
5. Orchestrator 推进 Work Item；
6. Outbox/Tracker Adapter 再把选定事实写回 Issue。

这比让 Linear/GitHub 与本地 SQLite 同时成为状态 owner 更容易恢复和审计。

## 16. 建议采用的最小垂直切片

不要先做完整 Linear UI、Sub-Issue DAG 或多 worker dashboard。第一个能证明架构的切片应是：

1. 在 SQLite 中创建 `WorkItem`、可选 `ExternalIssueBinding`、`Run`、`Invocation`、`WorkspaceLease`、`Artifact/Evidence`；
2. 一个 tracker adapter 只负责拉取候选、按 ID refresh 和 terminal refresh；所有输入转成幂等 `WorkCommand`；
3. 一个 eligibility policy 把一个合格 Issue 绑定/创建为一个 Work Item；
4. 一个持久 lease 保证该 Work Item 只有一个 non-terminal Run；
5. 为该 Run 建立隔离 workspace，调用现有真实 Codex Adapter；
6. 正常 CLI exit 只结束 Invocation，不结束 Work Item；
7. 一个最小 Result Contract 要求 patch/diff + repository gate evidence；
8. 独立 verifier 给 verdict，Run 进入 `awaiting_acceptance`；
9. 人接受后通过 outbox 更新 Issue handoff/terminal state；
10. 在任意步骤杀掉 Chymia，重启 reconciliation 能得到 continued/interrupted/failed/outcome_unknown，而不是丢失或重跑双写。

完成这个切片后，再把 Run 的单 Invocation 替换为 planner → implementer → verifier 的有界多 agent Worklist。这样 multi-agent 是在已可靠的 issue-run 骨架上增加协作，而不是用更多 agent 掩盖缺失的状态所有权。

## 17. 需要产品决策的五个硬问题

这些问题不能靠继续读 Symphony 或 Clowder 自动回答：

1. 外部 Issue 是所有工作必需的入口，还是 Work Item 的可选 Binding？本报告与当前目标设计建议“可选”。
2. Work Item 与 Thread 是否严格一对一？若一次失败后的新 Run复用 Thread，答案可为一对一；若一个 Issue 需要多个协作空间，则必须定义主 Thread 和派生 Thread。
3. Autonomous coding 的最低 Result Contract 是 patch、commit、PR、测试证据中的哪组？本报告建议本地默认 `scoped diff + gates + effect ledger`，发布 PR 属于额外授权。
4. 两个 mutating agent 是否允许在同一 Run 并行？本报告建议默认禁止；只有独立 worktree + persisted merge barrier 才允许。
5. 外部 tracker 与本地 Work Item 状态冲突时谁赢？本报告建议 tracker 决定 eligibility/人工意图，Chymia 决定执行事实；通过显式命令翻译冲突，绝不做双向字段镜像。

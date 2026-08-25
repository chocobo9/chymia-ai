# Clowder 核心对齐修复计划（落地版）

> 状态：历史 Clowder 对齐计划；不定义当前 Chymia 目标。

日期：2026-06-07
目标：把“多 agent coding 协作平台”的核心能力边界锁死，避免继续把 `FakeAgentService`、纯 parser 测试、或单纯测试绿误判为“已对齐”。

## 1. 核实结论

先给结论：Claude 刚才的判断**大方向正确**，但还不够可执行。

### 已核实为真的部分

1. `routing / invocation / context / session / audit / task / evidence / MCP / workspace` 确实是平台内核，不是外围装饰。
   - [审计前架构笔记](../architecture/2026-06-pre-audit-architecture-notes.md) 已把这些层拆开讲清楚，并把它们列为核心优先级。
2. `FakeAgentService` 不能作为“真对齐”证据。
   - `STATUS.md` 明确写了：全仓测试虽然绿，但通过的主要是 `FakeAgentService`，真实 CLI 端到端路径并不在通过测试里。
3. `runtime tab` 不应纳入本轮必须对齐范围。
   - `STATUS.md` 已明确标注当前不做，而且没有整套后端。
4. `workspace` 的“文件树 / 变更 / Git / 打开 / 预览”是必须能力。
   - 但 `terminal`、`multi-worktree`、`worktreeId` 这类 Clowder 细节，当前仓库并不要求原样照搬。

### 需要修正的部分

1. “必须对齐”还没有被写成可验收的标准。
   - 需要从“功能清单”升级成“证据清单”。
2. `workspace` 的边界还没完全锁死。
   - 当前已对齐的是可见的文件/变更/Git/预览面；终端与多 worktree 不应混进本轮 P0。
3. 还缺一条明确原则：
   - **测试绿 ≠ 真对齐**
   - **真对齐必须以真实调用证据为准**

## 2. 对齐范围

### P0：本轮必须对齐

这些能力决定“多 agent 协作平台”是否成立，缺一个就会直接影响闭环。

#### 2.1 路由与执行内核

- `@mention` / `@all`
- target 解析
- intent 解析
- 串行 / 并行路由
- fallback
- unavailable notice
- worklist 扩展
- 真实的 agent turn 驱动

#### 2.2 单次执行与会话模型

- `session resume`
- `session_init`
- `seal / reopen`
- `retry`
- session chain
- transcript
- session_id 贯穿 invocation、reply、tool events

#### 2.3 Context 注入

- identity / role
- history / hierarchical context
- task snapshot
- evidence recall
- SOP hint
- skill block
- reviewer / cross-thread / ping-pong 相关提示

#### 2.4 MCP / 工具桥

- 多 provider 的 MCP 配置适配
- callback env
- stdio MCP server
- callback route
- workspace root 注入
- managed server 生命周期

#### 2.5 工作区核心面

- file tree
- diff
- git status
- git log
- open / reveal
- file preview

#### 2.6 审计 / 任务 / 证据

- event audit log
- derived audit fallback
- task CRUD + task snapshot 注入
- evidence search / upsert
- session transcript 可追溯

### P1：重要，但可后置

- 开发 tab 的终端能力
- 定时任务 / scheduler
- 通知偏好
- token 用量
- 能力市场
- 社区 issues / PR 的只读列表
- 非文本媒体的完整出站 / 入站

### P2：明确不纳入本轮必须

- `runtime tab`
- Clowder 的完整 multi-worktree 细节
- 外部 IDE 运行时会话那套完整后端
- WeCom / Telegram / 其他非主 IM 的真机维护

## 3. 当前仓库状态

### 已经有的底座

- `packages/api/src/routing/*`
- `packages/api/src/invocation/*`
- `packages/api/src/context/*`
- `packages/api/src/providers/*`
- `packages/api/src/routes/*`
- `packages/mcp-server/src/*`
- `packages/api/src/stores/*`
- `packages/api/src/evidence/*`
- `packages/api/src/sop/*`

### 还不能算“已完成”的地方

- 真 CLI 端到端证据不足
- `FakeAgentService` 仍然是大量测试的主证据来源
- `workspace` 的终端能力仍未落地
- 外部 MCP 安装 / 配置仍是占位
- 计划层没有把“真实调用证据”写成硬门槛

## 4. 修复计划

### Phase 0：冻结判定标准

目标：先统一“什么叫对齐”。

交付物：
- 对齐范围表（P0 / P1 / P2）
- 证据分级表
- 非目标列表

验收标准：
- 文档里不再把“测试绿”写成“真对齐”
- 每个 P0 项都能指向真实证据类型

### Phase 1：补齐真证据链

目标：把关键能力从“测试契约”推进到“真实调用证据”。

优先验证：
- 真 CLI spawn
- 真 MCP callback
- 真 session resume / seal / reopen
- 真 workspace tree / diff / git 读取
- 真 audit / transcript 读取

验收标准：
- 每个 P0 项至少有一种真实证据
- 不能只靠 fake service 或纯函数测试证明完成

### Phase 2：补齐缺口能力

目标：把当前已知短板按优先级推进。

建议顺序：
1. 真 CLI smoke 的稳定化
2. MCP 多 provider 适配层
3. workspace 终端能力
4. scheduler
5. 外部 MCP 配置 / 安装

### Phase 3：收口与验收

目标：把“能跑”变成“可复验、可追溯、可回退”。

交付物：
- P0 完成表
- 真实证据索引
- 未完成项和原因
- 下一阶段 backlog

## 5. 验收规则

以下规则必须写进计划文档和后续门禁：

1. `FakeAgentService` 只能证明内部契约，不能证明真对齐。
2. 纯 parser / 纯函数测试只能作为补充证据。
3. 真实对齐必须包含至少一种真实证据：
   - 真 CLI
   - 真 HTTP
   - 真工作区操作
   - 真外部服务回调
   - 真 UI 交互
4. 没有真实证据的条目，只能标为：
   - `测试绿`
   - `半成品`
   - `占位`
   - `未核`

## 6. 需要写进对齐计划文档的定海神针

- 本计划聚焦协作平台核心闭环，不做外围能力全量复刻。
- 真对齐的唯一标准是真实调用证据，不是测试绿。
- P0 只包含会影响协作闭环成立的能力。
- P1 / P2 必须明确写出不纳入本轮的理由。

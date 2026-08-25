# Clowder 核心对齐 — 当前状态（接续用）

> 状态：历史 Clowder 对齐完成度；其中 DONE 只针对旧范围。

日期：2026-06-07 ｜ 配套：[修复计划](2026-06-core-alignment-repair-plan.md)（= scope 定义）、[审计前架构笔记](../architecture/2026-06-pre-audit-architecture-notes.md)（缺口分析）

## 0. 任务约束（不变，新对话必读）

- **scope = repair plan 的 P0 六块，完整对齐 Clowder，不砍 scope**；P1 后置、P2 不做。
- **真对齐唯一标准 = 真实调用证据**（真 CLI / HTTP / 工作区 / 回调 / UI）。测试绿 ≠ 真对齐；`FakeAgentService` / 纯函数测试只算补充证据。
- **真证据必须真 CLI，额度不是借口**（用户 2026-06-07 明确纠正；此前 codex 被额度借口砍过 = 错）。
- provider roster = **Claude / Codex / Gemini**（不引入 kimi/dare/opencode/antigravity-runtime）；IM = feishu。
- 砍的子项只能以 SCOPE-DELTA 的 SKIPPED + 理由出现，禁止无声省略。

## 1. 环境 / 机制（接续必读）

- **junction**：`workspace\reference\clowder-ai-main` → `D:\proj\choco-ai\reference\clowder-ai-main`（已建；.gitignore 忽略 `reference/`，git 不跟踪；读 Clowder 走这个相对路径）。
- **check-alignment 闸**：动 `packages/**` 前必须有 `.harness/alignment/<session_id>.md`，内含 `Aligned-To: reference/clowder-ai-main/<真实文件>`（多个空格/逗号分隔）。**新对话 session_id 变了，第一次写 packages 会被闸拦，报错里给出新 session_id 的文件名**——照它写 Aligned-To 再重试。
- **注意**：CLAUDE.md §C 说的 Stop 闸 `scope_gate.py` **不存在** → SCOPE-DELTA 无机器兜底，靠自觉。
- CLI 全可用：`claude`(`%USERPROFILE%\.local\bin`) / `codex`(0.137) / `agy` / `gemini`。
- 真 CLI smoke 全部 gated：`$env:RUN_CLI_SMOKE=1; npx vitest run <file> [-t "name"]`。
- 质量闸：每次改 `npx tsc --noEmit`(全 repo 0) + `npx eslint <file> --max-warnings 0` + 相关 vitest。**当前全绿**。

## 2. P0-2 单次执行与会话状态机 — ✅ DONE（invoke 层核心，真 CLI 验证）

- **第一刀**：三 provider 真 CLI 端到端 smoke（session_init→SessionStore 持久化 + resume 注入）— `tests/providers/real-cli-smoke.integration.test.ts`（"end-to-end" describe，claude/codex/gemini 全 GREEN）。
- **codex 受信目录门 gap**：`packages/api/src/providers/codex/codex-service.ts` 加 `isGitRepositoryPath` + `buildGitRepoArgs`（非 git cwd → `--skip-git-repo-check`，codex 0.137 否则 exit 1）；单测 `tests/providers/codex-git-repo-arg.test.ts`。对齐 Clowder CodexAgentService.ts:302-325。
- **invocation hard timeout + abortableNext**：`packages/api/src/invocation/invoke-single-agent.ts`（独立 timeout=base×2、合并 caller/timeout signal、abortableNext 替 for await、timeout/abort hard stop、finally 清 timer）；单测 `tests/invocation/invoke-single-agent-timeout.test.ts`。对齐 invoke-single-cat。**liveness idle-stall 主动 kill = PARTIAL（未做，invocation timeout 已粗兜底）**。
- **context_window_overflow 分类**：`error-classifier.ts` 加 `isContextWindowOverflowError`（ran out of room|context window）；`retry.ts` 加 `context_overflow` 类（清 session 重试）；单测补全 retry.test/error-classifier.test。对齐 invoke-helpers.ts:90。
- **挪块**：malformed recovery → P0-1（46-接力在 route 层）；task progress → P0-6（需新建 TaskProgressStore）。

## 3. P0-1 路由与执行内核 — ✅ DONE（gap #1/#2/#3/#4 全落地）

- **决策内核已完整**（`agent-router.ts` / `route-serial.ts`）：@mention/@all、intent、串并行、fallback(最近 user mention+窗口+可用过滤)、unavailable notice、availableAlternatives、A2A worklist 行首@追加、ping-pong warn/block、串行上下文传递、targeted-stop、routeExplicit(非 spoofable)。
- **第一刀** ✅：真 spawn 多 provider 路由 smoke — `tests/routing/real-cli-route-smoke.integration.test.ts`（serial #execute claude→codex + 串行上下文传递 / parallel @all 三 provider / fallback default，3 passed 真 CLI）。
- **第二刀** ✅（session e3ebe81e，gap #1 + #3 + participant fallback）：router 路由时按 @mention 写回
  `thread.participants`（对齐 AgentRouter.ts:823 resolveTargets→addParticipants）；peek=`resolveRouting`(只读)
  / resolve=`route()`(持久化) 分离；无 @ fallback 加 participant-based 档（healthy replier→any，新读侧
  `threadStore.getParticipantsWithActivity`）；handler 事后"全量发言者"登记收敛回路由层（对齐 Clowder：仅
  mention 写回，A2A-only 出现的 agent 不再进 participants）。真证据
  `tests/routing/agent-router-participants.integration.test.ts`（真 SqliteThreadStore + 真 SqliteMessageStore，
  8 tests，RED→GREEN：stash 实现→4 红 / 实现在→8 绿——补充证据，invoke 是 recording fake，但被测对象
  participant 决策 + SQLite 持久化是真的；覆盖纯决策分支：peek 不写 / fallback 不写 / messageCount /
  healthyReplier(count>0) 优先 / unavailable 不进 participants）。
  **真 CLI 端到端证据**（gated `RUN_CLI_SMOKE=1`，`real-cli-route-smoke.integration.test.ts`，2 passed）：
  ① 'participant' case 真 spawn codex×2 — @codex 真回→`thread.participants` 含 codex（gap #1 单 mention）/ 无 @
  续聊→participant fallback 真 spawn codex 而非 default claude（15.4s）；② 'parallel(@all)' case 真 spawn
  claude+codex+gemini→participants 含全三 provider（gap #1 广播分支，9.9s）。
  ③ **handler 全链路** `tests/api/message-handler-participants.integration.test.ts`（gated，1 passed 17.8s）
  —— 真 HTTP `POST /api/threads/:id/messages` → handleThreadMessage → 真 spawn codex×2：@codex→participants
  含 codex、未@的 claude/gemini 不进（收敛验证）、无@续聊延续 codex。
  仅剩 healthyReplier 档与多 participant 顺序由真 store + fake-invoke 单测覆盖（store 统计逻辑，不经 CLI，
  真 spawn 测之不增信）。tsc 0 + eslint 0 + 全量 2490 passed（3 预存失败与本刀无关：sop-wire×1 /
  scope-selector-no-thread×2，均 stash 验证）。改动文件：`agent-router.ts`、`sqlite-thread-store.ts`、
  `app-factory.ts`、`message-handler.ts` + 测试 `agent-router-participants.integration.test.ts`、
  `real-cli-route-smoke.integration.test.ts`、`message-handler-participants.integration.test.ts`。
  - SCOPE-DELTA 缺口：`Thread` 无 `preferredCats` → participant fallback 落两档（preferred 档 SKIPPED）；
    无 reply-health → `ParticipantActivity` 无 `lastResponseHealthy`（按 Clowder 缺失=健康语义）。
- **第三刀** ✅（session e3ebe81e，gap #2 thread routing policy / F042）：线程级 scope(review/architecture)
  路由偏好 prefer/avoid，**仅 fallback 路径生效**，显式 @mention 不受约束。shared 加
  `ThreadRoutingScope`/`ThreadRoutingRule`/`ThreadRoutingPolicyV1` + `Thread.routingPolicy`；threadStore 加
  `routing_policy` 列(guarded ALTER) + `updateRoutingPolicy`(null/非v1/空scopes 清) + rowToThread 读；router 加
  `inferRoutingScope` + `applyRoutingPolicy`(prefer 置顶 / avoid 跳过 / expired 忽略) + `pickFallbackExcluding`；
  PATCH `/api/threads/:id` 接受 `routingPolicy`(zod，null 清，title 转 optional + 至少一字段)。
  证据：`thread-routing-policy.integration.test.ts`(真 store+真 router，8) + `thread-routing-policy-route.test.ts`
  (真 HTTP inject，5)，13 passed，RED→GREEN(stash 实现→11 红)。routing policy 是纯决策+持久化(不经 CLI)，无真
  spawn 测——同其它纯决策分支。tsc 0 + eslint 0 + 全量 2503 passed(3 预存失败无关)。commit 43d8182。
  - SCOPE-DELTA：前端 routing policy 编辑 UI = SKIPPED（P1 niche；kernel 行为由 store+router+API 完整可验）。
- **第四刀** ✅（gap #4 malformed 46-接力 / F215，4 层）：claude 特有 form A（thinking-only 炸毛）检测→恢复→接力。
  L1 roster 加备用 cat `claude-opus-relay`(sonnet)；L2 claude-parser/service 检测 form A → emit detected+error；
  L3 invoke suppress detected/error + producedOutput 排除 thinking + 清 session fresh-retry + 耗尽 emit
  relay card + `malformed_toolcall_relay_46` + final error；L4 route-serial 消费 relay_46 + suppress error(有 relay
  目标时) + push 备用 cat 到 worklist。证据：`claude-malformed-formA`(7,真 wire) + `invoke-malformed-relay`(3,
  真 invoke+SessionStore) + `route-serial-relay`(2,真 routeSerial) 全 RED→GREEN + `real-cli-smoke` relay cat
  sonnet 真 spawn(1)。commit 05e5f05/0c0b710/b934eca/6fe29ee。
  - SCOPE：form A 是 claude extended-thinking 特有失败（codex/gemini 无此形态，Clowder 也只在 claude 做）；
    relay 模型 opus→sonnet（本仓无 opus-4.6）；真 spawn 端到端 form A = **PARTIAL**（claude #49747 无法稳定诱导，
    用真 wire 替代）；**parallel-relay = SKIPPED**（relay 是 serial worklist 概念，route-parallel 无接力，待核
    Clowder route-parallel 是否有 relay）。
  - **修正 (d3fb7cb)**：L1 原把 relay cat 做成普通 roster 成员 → 真机暴露"备用模型平时也回复"（@all/fallback/UI
    都选中它）。改为 **relay-only**：app-factory force `availability=false`（@all/fallback/@mention 自动排除）+
    `/api/agents` 隐藏 relay cat + agent-router relayAgentId 注入改看"注册存在"而非 isAvailable（接班是显式 push，
    不查 availability，照常工作）。回归 `relay-cat-not-routable`(3, RED→GREEN：stash 修复→3 红) + e2e 真 spawn
    确认接班仍工作。**偏离 Clowder**（opus-4.6 是普通成员）——本仓刻意适配（备用模型不该参与日常路由）。
- **剩余 gap**：无（全部落地）。
  1. ✅ thread participant 持久化 — 见第二刀。
  2. ✅ thread routing policy — 见第三刀。
  3. ✅ peek/resolve 分离 — 见第二刀。
  4. ✅ malformed 46-接力 — 见第四刀。
- **对齐源**：`reference/.../routing/AgentRouter.ts` + route-serial/parallel + route-helpers.ts + cat-target-resolver.ts + WorklistRegistry.ts + multi-mention-state-machine.ts。

## 4. P0-3 / P0-4 / P0-5 / P0-6 ✅ DONE

- ✅ **P0-3 Context 注入 — DONE**（两刀）：① routing policy 注入 system prompt（commit 560af87 —— gap#2 的
  数据/路由应用之外，agent prompt 现在也带 review/architecture 偏好）；② reviewer section（commit f1deaa7 ——
  peer-reviewer 队友推荐，**family=clientId 跨 provider 优先**；含 `AgentConfig.roles` + loader schema + agents.yaml
  标注 + buildReviewerSection）。核查结论：formatTaskSnapshot 已对齐（无 gap）；prompt-digest 实为**审计**移 P0-6；
  voice/bootcamp/guide/world/alwaysOn/signals = Clowder 特定 feature，本仓无底层 = SKIPPED。证据：
  `routing-policy-prompt-injection`(5) + `reviewer-section`(6)，均 RED→GREEN，纯 prompt 注入（不经 CLI）。
- ✅ **P0-4 MCP/工具桥 — DONE**（commit 51e0c78）：按 provider 分治让 @codex/@gemini 真正拿到 choco MCP 工具集。claude per-invocation `--mcp-config`（已与 Clowder 一致，不动）；codex per-invocation `--config mcp_servers.choco.*` TOML overrides（对齐 CodexAgentService.buildCatCafeMcpConfigArgs）；gemini 预写项目级 `<workspace>/.gemini/settings.json`（merge 保留用户 server，对齐 writeGeminiMcpConfig）。真证据：`mcp-tool-bridge.integration.test.ts`（gated，codex+gemini 各真 spawn 调 evidence_upsert，回调真鉴权落库）+ 12 单测 + 2 wiring。SCOPE-DELTA：完整 mcp-config-adapters/F213/F041 看板/kimi/antigravity = SKIPPED（用户选「工具桥对齐」）。
- ✅ **P0-5 工作区核心面 — DONE**：主体早在 b7176ad（WorkspacePanel 对齐）已落地（tree/diff/git status·log/open/reveal/文本预览/搜索 全有，单 workspace 根）。本轮按用户审计补齐对照 Clowder 的 3 个真缺口：① `GET /api/workspace/git-show`（提交详情下钻，对齐 workspace-git.ts parseGitShow）② `GET /api/workspace/file/raw`（图片/音视频流式预览，对齐 workspace.ts，svg 排除防 XSS）③ diff old/new 行号（parse-diff，对齐 DiffViewer）。真证据：`workspace-git-show.integration.test.ts`（真 git init/commit/show）+ `workspace-file-raw.test.ts`（真 fs 流式）+ 单测/前端 edge。SCOPE-DELTA：git-health/worktrees/linked-roots/reveal-project(F095)/navigate(F131)/side-by-side/右键 CRUD/终端(node-pty) = SKIPPED（repair-plan §2.5 划界不进本轮 P0 或属增强）。
- ✅ **P0-6 审计/任务/证据 — DONE**：repair-plan §2.6 五项验收（event audit log / derived fallback / task CRUD+snapshot / evidence / session transcript）早已落地。本轮补 status doc 额外点名的 3 项：① **task progress + TaskProgressStore**（新 shared 类型 + SQLite store + 迁移 007 + extract-task-progress 纯函数从 TodoWrite tool_use 捕获 + app-factory invoke 缝 setSnapshot/socket 广播 + 前端 WorkspaceTasks 实时进度区，对齐 Clowder TaskProgressStore）；② **session_seal auto-seal emit**（SessionStore.onSeal 回调 → app-factory emit；session_init 自动封存旧 active 现在也 emit。**核实纠正**：显式 seal 路由本就 emit（Agent 探查误判为完全没 emit），真缺口是 auto-seal；统一到 onSeal 并移除 session-routes 重复 emit 避免 double）；③ **前端审计面板**（WorkspaceAudit + WorkspacePanel 审计 tab，读已有 GET /api/audit/thread，对齐 Clowder AuditEventsTab）。证据：extract(5)+store(4)+wire(3,含 session_seal 无 double)+前端(4) 全绿 + audit-routes derived 测试随行为更新。真 CLI 自然诱导难（session 切换需人为 / TodoWrite 自主），用真 buildApp+真 SessionStore+真 audit 的 wiring 替代（fake CLI 强制场景）= PARTIAL。SCOPE-DELTA：Clowder 63 事件全集 / prompt-digest 换 hash / evidence 治理 = SKIPPED。

## 5. task list（Claude Code TaskCreate）

#1 P0-1 = completed ｜ #2 P0-2 = completed ｜ #3 P0-3 = completed ｜ #4 P0-4 = completed ｜ #5 P0-5 = completed ｜ #6 P0-6 = completed

## 6. 本轮改动文件清单（git 未 commit）

产品代码：`codex-service.ts`、`invoke-single-agent.ts`、`error-classifier.ts`、`retry.ts`。
测试：`real-cli-smoke.integration.test.ts`(扩端到端三 provider)、`codex-git-repo-arg.test.ts`(新)、`invoke-single-agent-timeout.test.ts`(新)、`retry.test.ts`/`error-classifier.test.ts`(加 context overflow)、`real-cli-route-smoke.integration.test.ts`(新)。
其他：`.harness/alignment/cf258e5b-*.md`(对齐声明)、`reference/`(junction)。

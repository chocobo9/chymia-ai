# 真实完成度清单 (STATUS)

> 目的：每个模块按**真实状态**标注，并写明**验证方式**，避免靠口头报「全绿」。
> 维护：改了什么、验证到哪一级，就更新这里。最后更新 **2026-06-05**。

## 图例（验证等级，从强到弱）

| 标记 | 含义 |
|---|---|
| ✅ 真通 | **真机/真数据**直接验证过（live 接口 / 截图 / 真实使用）。下方注明是谁、何时验的 |
| 🟢 测试绿 | 单测+集成测试通过，但**未真机端到端**验证（多用 Fake，不代表真 CLI/真平台） |
| 🟡 半成品 | 引擎在，但功能不完整（看着像有，实际没通到底） |
| ⛔ 占位 | 无后端，UI **明确标**「未接入 / 即将上线」（诚实占位，非伪装可用） |
| ❓ 未核 | 没去验证，状态未知 |

> ⚠️ **全仓 2371 passed / 3 skipped，但通过的用的是 `FakeAgentService`。** 真实 agent CLI（claude/codex/gemini 实际被拉起并回复）的端到端路径**不在通过的测试里**——那 3 个 skipped 全是 `tests/providers/real-cli-smoke.integration.test.ts`。截图（2026-06-04，你提供）证明 `claude-opus` 在真飞书里能回，但 `codex/gemini` 当时显示为不可用。所以"agent 真能干活"目前只对 claude 一条链有真机证据。

> 🔎 **本次（2026-06-05）校验边界（诚实）**：我直接验的是 `npx vitest run`（2371 passed/3 skipped）、`npx tsc --noEmit`（repo 0 error）、`eslint`（改动文件 0）、以及审计的**隔离 live-server 检查**（127.0.0.1:4099、临时库、fake CLI——真 HTTP/真引擎/真 EventAuditLog，但非你的真实例）。**所有 ✅真通 里依赖「真飞书 / 截图 / live /api/... / 你的运行实例」的项，本会话我没有也不能复验**（不碰你在跑的 :3000/:5174）——它们的证据是你 2026-06-04 的真机使用，沿用、未由我重测。

---

## 审计（EventAuditLog + 子视图）  ← 本会话新增/对齐

| 项 | 状态 | 验证方式 |
|---|---|---|
| 审计读真实事件日志（EventAuditLog 事件溯源） | 🟢 测试绿 + 隔离 live | `audit-routes` 6 测试；隔离 live(:4099) 新 thread emit `invoked`+`responded`，data 带 invocationId/mode/durationMs/toolCalls |
| **老 thread 派生回退**（无事件→现推，`derived:true`，不变空） | 🟢 测试绿 + 隔离 live | 关键回退测试 **RED→GREEN**（删回退 FAIL「expected 0 > 0」→ 加回退 PASS）；隔离 live 老 thread 返 3 条全 `derived:true` |
| events tab（type 徽章 + 点击展开 data JSON） | 🟢 测试绿 | `status-bar-tabs` 14 测试；对齐 Clowder `AuditEventsTab` |
| Session tab（会话链 + 封存/恢复 + 点开转录） | 🟢 测试绿 | 功能级对齐（我们=单一转录；Clowder 有 chat/handoff/raw 三模式——你选接受现状，未建） |
| 搜索 tab（按 type/session-id 客户端过滤） | 🟢 测试绿 | 功能级对齐（我们=客户端过滤；Clowder=服务端 session 内容搜索 `/sessions/search`——无此后端，你选接受现状） |
| Runtime tab | ⛔ 不做 | Clowder F211 外部IDE运行时会话，整套后端 choco 没有；**你拍板跳过，未建空壳** |

> 审计子视图**无死代码/无 placeholder**（你的红线）：eslint 0；UI 里 "placeholder" 仅为真实搜索框 `<input placeholder>` / CSS `::placeholder` / 说明注释；4 处 `disabled` 各有真实理由；只有 3 个真 tab（无 Runtime 空壳）；旧 overlay 入口已移除（测试断言 `sb-open-audit`/`sb-open-sessions` 不存在）。

## IM 对接

| 项 | 状态 | 验证方式 |
|---|---|---|
| 飞书 私聊文本 收发 | ✅ 真通（你 06-04）+ 🟢 测试绿（本会话补完代码） | 截图 + 你实际在用；本会话把适配器/管线代码补完并**提交**(2123761)、相关测试转绿、tsc 0 |
| 飞书 长连接（Lark 国际域名） | ✅ 真通（你 06-04，未由我复验） | live `/api/adapters/feishu/status`=connected（你的实例；本会话未碰） |
| 飞书 区域可配（飞书中国/Lark）+ UI 下拉 | ✅ 真通（你 06-04）+ 🟢（本会话补 web 类型 domain，tsc 0） | live PUT domain=lark 连上（你）；本会话补 `FeishuDomain`+`domain` 字段使前后端类型对齐 |
| 飞书 流式卡片（onTextDelta） | ✅ 真通（你 06-04，截图）+ 🟢 测试绿 | 本会话接通 `submitPlatformMessage`→`onTextDelta`（之前 1 参丢回调，3 测试红）；`feishu-wiring` 流式卡片测试转绿 |
| 飞书 入站用户消息同步到 web | ✅ 真通（你 06-04）+ 🟢 测试绿 | `submitPlatformMessage` 接通 `broadcastInbound`；`platform-ingress-broadcast` 真 socket 测试转绿 |
| **web→飞书 双向桥（网页回合推回飞书）** | 🟢 测试绿（本会话 `cbd8142`） | `PlatformOutbound` + `getChannelId` 反向路径；origin 防回环 + web-only no-op；`feishu-outbound-bridge` 测试 RED→GREEN。**真飞书端到端待你验** |
| 飞书 receipt 拼接（首 token 替换占位） | ✅ 真通（你 06-04，截图）+ 🟢 | `feishu-receipt-lines` 随特性提交；真渲染为你的截图证据 |
| 飞书 群聊（@bot 检测 / @回发送者 / 发送者名） | 🟢 测试绿 | 单测（fake channel）；**未在真飞书群验证** |
| 飞书 出站媒体（图/文件/语音 upload） | 🟡 半成品 | 代码路径在（`channel.send` media），**完全没跑过**，零真机证据 |
| 飞书 非文本**入站**（图/文件/语音） | 🟡 半成品 | 只转成文本占位 `[图片]`；**agent 看不到图片内容**（需贯穿 provider，未做） |
| 企业微信 (WeCom) | ✋ 不做（决策 2026-06-05） | **IM 只用飞书**。代码+测试留在仓里（da30607/7994c96），但不再投入真机验证/维护。 |
| 个人微信 (iLink) | ✋ 不做（决策 2026-06-05） | 同上——保留代码，不推进。 |
| Telegram | ✋ 不做（决策 2026-06-05） | 同微信——飞书生态足够，代码+测试留仓不维护。 |

## 账户与密钥

| 项 | 状态 | 验证方式 |
|---|---|---|
| Provider 登录状态（claude/codex/gemini） | ✅ 真通（你 06-04，未由我复验） | live `/api/auth` 三个都 loggedIn:true（你的实例；本会话未碰） |
| 「刷新状态」按钮 | ✅ 真通（你 06-04） | 后端正确；06-04 补了 loading 反馈 |
| BYOK API key 配置 | 🟢 测试绿 | 有路由+web 测试；没真填 key 验证 |

## 设置面板（10 个分区）

| 分区 | 状态 |
|---|---|
| 成员管理 / 外观 / 账户与密钥 / IM 对接 / Skill 管理 / 规则与SOP | 🟢 有后端（详见各自） |
| 运维监控（健康/agent 状态） | 🟢 有后端 |
| └ **运维监控 → Token 用量** | ⛔ 占位「未接入：用量统计尚未接入后端」（已核：SettingsOverlay 真有此占位文案） |
| MCP 管理（内置） | 🟢 有后端 |
| └ **外部 MCP 安装/配置** | ⛔ 占位「尚未接入后端」（已核） |
| **能力市场** | ⛔ 占位「能力市场尚未接入」（已核，dogfood roadmap 最后一项） |
| **通知** | ⛔ 占位「通知偏好尚未接入持久化后端」（已核） |

## 工作区面板 (WorkspacePanel，右侧)

| Tab | 状态 |
|---|---|
| 记忆 | 🟢 有后端 |
| **开发**（文件树/变更/Git） | 🟢 测试绿（本会话真对齐）| 文件树(GET /api/workspace/tree, lazy+沙箱) + 变更(GET /diff, 改动列表+unified diff) + Git(GET /git-log,/git-status, 分支+状态+提交) + 文件预览(复用 /file)。git 走可注入 GitRunner seam。dev-routes(6)/parser(7)/web(4)/parse-diff(4) RED→GREEN |
| └ **开发→终端** | ⛔ 待做（下一步）| node-pty/ConPTY（win32 无原生 tmux）+ WebSocket + xterm.js。本会话明确缓做 |
| **调度**（定时任务） | ⛔ 占位，无 scheduler 后端（已核）— **对齐档位：真对齐（调度循环+CRUD+UI+投递）；待做** |
| **任务**（任务线） | 🟢 测试绿（本会话真对齐 + agent 上下文注入） | SqliteTaskStore + `/api/tasks` CRUD + socket(`task_created/_updated/_deleted`) + 前端 WorkspaceTasks 板 + 开放任务注入 agent 回合上下文。task-routes(9)/store(5)/snapshot(7)/injection(2)/web(6) 测试 RED→GREEN |
| **社区**（Issues/PR） | ⛔ 占位，无 GitHub 集成（已核）— **对齐档位：只读 issues/PR 列表（轻量，需 GITHUB_TOKEN/gh）；不做 Clowder 的 triage/guardian 共识；待做** |

## 核心引擎（M2–M12）

| 项 | 状态 | 说明 |
|---|---|---|
| 路由 / 编排 / 多 agent / 上下文 / evidence / SOP / skills | 🟢 测试绿 | 2379 passed / 3 skipped，但**全用 FakeAgentService**；真 CLI 端到端 = skipped |
| provider done 时机（claude/gemini result→done + kill 回收） | 🟢 测试绿 | 修 @all 串行卡死 / @gemini 慢；codex 同隐患未修（follow-up） |
| provider 身份注入（仅首轮注入、resume 不重复） | 🟢 测试绿 | 修 gemini/codex 身份死循环；claude 原生 flag 不发作 |
| 真实 agent CLI 调用（claude） | ✅ 真通（你 06-04，截图） | claude-opus 在飞书真回了 |
| 真实 agent CLI 调用（codex / gemini） | ❓ 未核 | 截图里显示"需在各自会话回复"/不可用，未确认真能跑 |
| 闸（早闸 PreToolUse / commit-msg / CI alignment-gate） | 🟢 已装 + commit 闸已生效 | 本会话装齐并提交(999aa3b)；两个碰 packages/** 的提交都过 commit 闸（带齐三 trailer）。早闸需你重启 CC 才加载 |

---

## 变更记录

### 2026-06-05 · 工作区「开发」tab 真对齐（文件树/变更/Git；终端缓做）（本会话）
- 对齐 Clowder `routes/workspace.ts`(tree+diff)/`workspace-git.ts`(log/status)/`workspace/{DiffViewer,GitPanel,ChangesPanel,WorkspaceTree}`。
- **后端**（只读）：`infrastructure/git-cli.ts`（可注入 `GitRunner` seam + 纯 parser：parseGitLog/Status/ChangedFiles + isDenylistedPath）；`routes/workspace-dev-routes.ts`：`GET /api/workspace/{tree,diff,git-log,git-status}`。单一 workspace 根（fileRoot，复用 `resolvePathInRoot` 沙箱），**丢 worktreeId/getWorktreeRoot/linked-roots/git-health/git-show**（YAGNI）。安全：tree 过沙箱；diff pathspec 只含 changedFiles 且 denylist .env/.key/.pem。非 git 仓诚实返回 `gitAvailable:false`。
- **前端**：`overlays/WorkspaceDev.tsx`（子 tab 文件/变更/Git：lazy 文件树+点开预览、改动列表+`parse-diff.ts` 渲染、分支+状态+提交日志）接进 WorkspacePanel；`lib/api.ts` 4 方法 + 类型；CSS `diffl-*`/dev 复用 `ft-*`/`chg-*`/`git-*`/`wsp-subtabs`。
- **修一个 Clowder 同源潜在 bug**：porcelain 解析里 `stdout.trim()` 会吃掉首行 ` M path` 的前导列空格→路径错位；改成 split 后过滤空行、不 trim 行首。
- 证据：dev-routes 404→GREEN（fake GitRunner，无需真 git 仓）；parser/web/parse-diff 全绿；全量 **2431 passed / 3 skipped**；tsc 0；eslint 0。**真机（真 git 仓、真文件预览）待铲屎官复验**。
- 待做：**终端**（node-pty，紧接下一步）；调度/社区两 tab（档位已定）。

### 2026-06-05 · 工作区「任务线」tab 真对齐（本会话）
- **体量核对 + 对齐档位拍板**：侧栏 WorkspacePanel 四占位 tab 对照 Clowder 实现定档（用户拍板）：任务=真对齐+注入；开发=全真对齐含终端；调度=真对齐；社区=只读列表（详见 §工作区面板 / 记忆 [[next-session-workspace-align]]）。Clowder IA 与 choco 五 tab 一致（开发/记忆/调度/任务/社区）。
- **任务线（毛线球）端到端**（对齐 Clowder `task.ts`/`TaskStore`/`routes/tasks.ts`/`formatTaskSnapshot`/`TaskBoardPanel`+`TaskCard`+`TaskComposer`）：
  - shared `TaskItem`（丢 #320 pr_tracking）；`SqliteTaskStore`+迁移 006（持久，非 Clowder in-memory）；thread 删除级联删任务。
  - `/api/tasks` POST/GET/PATCH/DELETE；socket `task_created/_updated/_deleted`（room=thread）。
  - 前端 `WorkspaceTasks`（四 status 段 + 状态 pill 循环 + 展开 why/删除 + composer）接进 WorkspacePanel；zustand `task-store` + useSocket 监听 + api 方法；CSS `tsk-*`。
  - **agent 上下文注入**：invoke 缝读 `taskStore.listByThread`→`formatTaskSnapshot` 拼进 effectivePrompt（best-effort，仿 sopStageHint）。
  - 证据：route 404→201、injection 无快照→有快照 两段 RED→GREEN；全量 **2410 passed / 3 skipped**；tsc 0；eslint 0。**真机（真飞书/真 agent CLI）待铲屎官复验**。
  - 待做：开发/调度/社区 三 tab（档位已定，未动）。

### 2026-06-05 · 多 agent / provider 修复 + web→飞书 桥（本会话）
- **claude/gemini done-on-result**：agents.yaml 三 provider 都 `mcpSupport:true`、MCP 子进程收尾慢；done 原本等进程退出 → SessionMutex 久不放 → @all 串行只 claude 回 / 网页 @gemini 启动慢。修：result/success 即发 done + `kill()` 提前回收。`879124b`(claude) / `6782a5d`(gemini)。RED→GREEN。codex 同隐患但 parser 无干净回合终止信号，未动（follow-up）。
- **Gemini/codex 身份死循环**：无原生 system-prompt 槽、每轮把身份前置进 user 文本，resume 时会话已带身份 → 模型把人设当"用户反复发" → 索要 `0xDEADBEEF` 死锁。修：仅会话首轮注入身份，resume 不重复。`8414494`。RED→GREEN。claude 走原生 `--append-system-prompt` 不发作、不动。
- **网页消息顺序乱（飞书正常）**：ChatContainer 分三段块渲染、不按时间戳。修：按 timestamp 归并排序。`71896ae`。RED→GREEN。
- **web→飞书 双向桥**：接通反向路径（`getChannelId` 之前实现了没接线）——web/任意端在飞书-linked thread 的回合（用户消息+回复）推回飞书频道，origin 防回环，web-only thread no-op，仅 feishu。`cbd8142`。RED→GREEN。
- **IM 决策**：WeCom / 个人微信 / Telegram 全部 ✋不做，飞书唯一主力。
- **审计记录每个 agent 的输入 + 修气泡假"@all"**（`cd23c6d`）：invoked 事件加 `prompt`（该 agent 实际收到的 effectivePrompt，截断 4000）；用户气泡按真实 @mentions 显示而非硬编码 @all。坐实多 agent emit 没坏（audit-multi-agent 测试：@all 对三个 agent 都 emit invoked）。RED→GREEN。
- **gemini/codex 中途更新上下文**：「封存(seal)=清理上下文」已可用（封存→下轮 fresh CLI 会话 + 重注入当前 system prompt + 带 smart-window thread 历史），待你真机验是否够；不够再加 #2「中途 framed 更新」（中体量，未做）。
- 门禁：repo tsc 0；eslint 0；vitest **2379 passed / 3 skipped**。这些都是 provider+路由层改动，**需重启实例加载**；真 CLI/真飞书端到端待你真机验。

### 2026-06-05 · 审计 + 飞书收尾 + 闸
- **审计换真实事件日志 + 派生回退**：事件优先，老 thread 无事件则回退现推（`derived:true`），新旧都不空——修上次重建删派生导致老 thread 全空的事故。提交 `ab41804`。回退测试 RED→GREEN。
- **飞书 IM 收尾**：补 `app-factory.submitPlatformMessage`（缺的 `onTextDelta` 流式 + `broadcastInbound` 入站镜像）+ web `api.ts` 的 `FeishuDomain`/`domain` 类型；上一轮飞书在制品（适配器/manager/socket/async-chunk-queue/receipt-lines/SettingsOverlay/useSocket）验证编译+测试+lint 通过后随特性提交 `2123761`。**4 个原本失败的飞书/ingress 测试转绿；repo tsc 从有错→0。**
- **装对齐/提交闸**：`.harness/{check-alignment,validate-commit}.mjs` + `.githooks/commit-msg` + CI + `.claude/settings.json`，提交 `999aa3b`。
- **删除**：`feishu-client.ts`(121行) + `feishu-client.edge.test.ts`（旧实现，被 LarkChannel 适配器取代）。

### 2026-06-04（上一会话）
- 飞书域名连不上（Lark vs 飞书中国）→ 域名可配 + UI 下拉，已真机连上。
- 飞书连接错误被 NOOP logger 静默吞 → 接上真 logger。
- receipt 首行拼在回复前 → 首 token 替换占位，加回归测试。
- 飞书入站用户消息 web 不同步 → 加 `thread_message` 广播 + web handler。
- 账户「刷新状态」无反馈 → 加 loading 态。
- 删除 `feishu-card.ts`（101 行，未被调用的死代码）。

## 仍欠（未做/没验证，按优先级）

1. 飞书群聊 / 出站媒体 / 入站图片真正可见 —— 真机验证或补完（出站媒体/入站非文本仍 🟡）。
2. ~~WeCom / 个人微信 / Telegram~~ —— **不做（2026-06-05 决策：IM 只用飞书，生态足够）**，代码保留不维护。
3. codex / gemini 真 CLI 端到端 —— 确认是否真能跑（仍 ❓，只有 claude 一条链有真机证据）。
4. 占位区（能力市场 / 通知 / Token用量 / 外部MCP / 工作区四 tab）—— 要么接后端，要么明确不做（当前均诚实标占位）。
5. 审计/飞书/桥/provider 修复的 ✅/🟢 项需你**重启实例后真机复验**（本会话只到测试绿 + 隔离 live；未碰你的运行实例）。重点验：A 慢、C 死循环、B web→飞书、以及「封存=清理上下文」对 gemini/codex 够不够。
6. **gemini/codex 中途更新上下文**：「封存=清理」已可用，待验；若不够 → 加 #2「中途 framed 更新」（中体量，未做）。
7. **已知 bug（2026-06-05 真机，已记录未分析，见记忆 gemini-context-bleed-bugs）**：
   - gemini 跨对话/跨项目**上下文串台**（问它读 eval 目录，它答无关的 `use-editor.ts` 类型修复）；重启+封存后仍发作。
   - **reopen(解封) 后开新对话，gemini 又输出旧错误结果，且审计无活动**。
   - **新对话审计面板空白**（不显示任何活动）。
   - workspace 沙箱限制在 `.workspace`，读不了跨项目路径（`D:\proj\CTI-RAG\...`）。
8. **下个 session：对齐侧边栏展开的 workspace（WorkspacePanel）到 Clowder** —— 当前「开发/调度/任务/社区」四 tab 是 ⛔占位（无后端）；按 Clowder 对应实现定对齐范围（见记忆 next-session-workspace-align）。

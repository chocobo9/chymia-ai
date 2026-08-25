# Rebrand / De-naming Plan — 词表 + 受影响文件清单

> Status: historical naming plan; not current implementation authority.

> Orchestrator-scanned 2026-05-31 (excludes `reference/` + `node_modules/`). This is a
> **planning artifact only** — nothing is renamed yet. Fill in the TBD names, then it
> becomes a mechanical rename pass gated by `tsc 0 / vitest 1165 / eslint 0`.

## 0. 现状数据
| 主题 | 出现次数 | 文件数 | 说明 |
|------|---------|--------|------|
| `clowder`（任意大小写） | **359** | **113** | 基本是每个源文件——`@clowder/*` import 命名空间 |
| Cat-Café 词（猫/铲屎官/cat_cafe…） | **404** | **25** | 21 skill `.md` + manifest + agents.yaml + 2 处偶然 |
| `CLOWDER_` 环境变量 | — | 6 | adapters×2 + token-manager + app-factory + env-keys + callback-client |

## 1. 待拍板的命名决策（占位符）
| ID | 决策 | 占位符 | 提示 |
|----|------|--------|------|
| **D1** | 产品名 | `<PRODUCT>`（小写，包 scope）/ `<PRODUCT_TITLE>`（展示名）/ `<PRODUCT_ENV>`（大写，env 前缀） | 仓库文件夹是 `choco-ai` → 暗示可能是 `choco` / `Choco` / `CHOCO` |
| **D2** | 三个 agent 人设名（替换 布偶猫/橘猫/暹罗猫）+ @别名 | `<AGENT_CLAUDE>` / `<AGENT_CODEX>` / `<AGENT_GEMINI>` | 也可决定**直接砍掉人设**，只留 displayName（Claude/Codex/Gemini） |

---

## 2. 词表 A —— 产品改名（Clowder → `<PRODUCT>`）【机械，可独立于 skills 执行】
| 旧 | 新 | 类型 | 备注 |
|----|----|------|------|
| `@clowder/<pkg>` | `@<PRODUCT>/<pkg>` | 包命名空间 | 6 包(shared/api/web/mcp-server/adapters/skills) + 全部 import |
| 根 `package.json` `"name": "clowder"` | `"<PRODUCT>"` | 构建 | |
| `pnpm-workspace.yaml` / `tsconfig.base.json` paths / `vitest.config.ts` alias / 各包 `package.json` name | `@<PRODUCT>/*` | 构建 | 必须与包名同步改 |
| `CLOWDER_` | `<PRODUCT_ENV>_` | 环境变量 | `_API_URL / _INVOCATION_ID / _CALLBACK_TOKEN / _WECHAT_* / _TELEGRAM_BOT_TOKEN` |
| `<title>Clowder</title>`（`packages/web/index.html:6`） | `<PRODUCT_TITLE>` | **用户可见** | 浏览器标签页 |
| 系统提示里的「Clowder 多智能体编排平台」 | 「`<PRODUCT_TITLE>` …」 | **用户可见** | agent 身份文案；改前需在 `system-prompt-builder.ts` / 配置里定位确认 |
| `docs/clowder-architecture-design.md`、`clowder-design-supplement.md` 等文件名 | 可选改 | 文档 | 低优先；设计参考文档 |

## 3. ⚠️ 词表 A 的「不要动」清单 —— 引用外部项目的注释
| 形态 | 处理 | 原因 |
|------|------|------|
| `// Pattern from Clowder <file>.ts` / `// WHY (research, from Clowder …)` / `// Source: Clowder a2a-mentions.ts` / `Clowder context-transport default (B1a)` 等 | **保持原样** | 这里的 "Clowder" 指**我们参考学习的外部开源项目**，是 CLAUDE.md §2.1 强制要求的「来源标注」。改成产品名 = 谎报出处。**capital-C 的 `Clowder` 绝大多数属于这类注释**（`// Pattern from Clowder …` 遍布 adapters/context/routing/evidence/invocation）。 |

> 执行口径：**只改 `@clowder/`（小写命名空间）、`clowder`(包名)、`CLOWDER_`(env)、用户可见文案**；`// ... Clowder ...` 注释**逐条保留**（除非那条注释顺手也提了产品名）。

---

## 4. 词表 B —— 去 Cat-Café（skills + agents.yaml）【skills 暂不动；agents.yaml 可独立改】

### B1 风味词（机械替换）
| 旧 | 新 |
|----|----|
| 猫 / 猫猫 / 猫咪 | agent |
| 铲屎官 | 用户 |
| 多猫 / 三猫 / 单猫 | 多 agent / 三 agent / 单 agent |
| Ragdoll / Maine Coon / Siamese | `<AGENT_*>`（D2 待定）|

### B2 技术硬引用（有正确目标，**不改会让 agent 调用不存在的东西**）
| 旧 | 新 | 备注 |
|----|----|------|
| `@cat-cafe/shared` | `@<PRODUCT>/shared` | 包名 |
| `CAT_CAFE_*` | `<PRODUCT_ENV>_*` | env |
| `cat_cafe_search_evidence` | `evidence_search` | ✅ 我们有 |
| `cat_cafe_cross_post_message` | `post_message` | ⚠️ 我们无 cross-thread 变体，需简化 |
| `cat_cafe_get_thread_context` / `_read_invocation_detail` / `_search_messages` / `_feat_index` / `_list_threads` 等 | **无对应工具** | ⚠️ 我们 M10 只有 8 个工具(evidence_search/evidence_upsert/post_message/read_file/search_files/list_session_chain/read_session_digest/read_session_events)；skills 引用的大半 Clowder 工具**我们根本没有** → 这些段落要**重写或删**，不是改名 |
| `cross-cat-handoff`（skill id + 文件名 + 引用） | `cross-agent-handoff` | 改 manifest id + `.md` 文件名 + 所有引用 |
| `targetCats`（参数名） | `targetAgents` | 与 M4/M8 实际参数对齐 |
| 端口 `3003/3004`、Redis `6398/6399`、`relay-station`、`cat-cafe-runtime` | 删/替换 | ⚠️ Clowder 专有运行时基础设施，**不适用我们** |

> 结论：skills 的去猫化**不是 find/replace**——它含大量我们不存在的工具/基础设施引用，需要**逐篇按我们真实的工具集 + 架构重写**。这也是为什么建议它单独成一批、并补一条机器门。

### B3 agents.yaml（现在就能改，不依赖 skills）
| 旧 | 新 |
|----|----|
| `name: 布偶猫 / 橘猫 / 暹罗猫` | `<AGENT_*>`（D2）或删掉该字段、统一用 displayName |
| mentionPatterns 里的 `@布偶 / @宪宪 / @橘猫 / @阿橘 / @暹罗 / @小罗` | `<新别名>`（D2）或删 |
| ✅ `displayName: Claude (Opus)/Codex (GPT)/Gemini (Pro)`、`@claude/@codex/@gemini` | **保留**（已干净）|

---

## 5. 受影响文件清单

### 5a 产品改名（Clowder）
- **全部 113 个源文件**含 `@clowder/*` import → 机械 find/replace。
- **非机械、需逐个确认的关键文件**：
  - 根 `package.json`（name）、`pnpm-workspace.yaml`、`tsconfig.base.json`（paths）、`vitest.config.ts`（alias）
  - 6 × 各包 `package.json`（name + workspace deps）
  - `packages/web/index.html`（`<title>`）
  - `packages/api/src/context/system-prompt-builder.ts`（平台名文案，需定位）
  - env 引用 6 文件：`adapters/wechat/{wechat-adapter,token-manager}.ts`、`adapters/telegram/telegram-adapter.ts`、`api/src/app-factory.ts`、`mcp-server/src/{env-keys,callback-client}.ts`

### 5b 去 Cat-Café（25 文件，404 处）
**skill `.md`（21，暂不动，按 hit 数排序）：**
`feat-lifecycle(57)` · `merge-gate(33)` · `quality-gate(30)` · `expert-panel(29)` · `knowledge-engineering(26)` · `thread-orchestration(26)` · `deep-research(25)` · `collaborative-thinking(24)` · `cross-thread-sync(21)` · `worktree(18)` · `incident-response(15)` · `memory-search-best-practices(14)` · `receive-review(13)` · `self-evolution(13)` · `request-review(12)` · `cross-cat-handoff(12)` · `open-source-teardown(10)` · `memory-navigation(7)` · `debugging(6)` · `tdd(1)` · `writing-plans(1)`

**其他：**
- `packages/skills/manifest.yaml`（3；含 skill 描述 + `cross-cat-handoff` id）
- `packages/api/src/config/agents.yaml`（6；B3，可现在改）

**非问题（别动）：**
- `packages/mcp-server/src/env-keys.ts`（1）：注释说明「我们用 `CLOWDER_*`，**不是** `CAT_CAFE_*`」——正确，留。
- `packages/api/src/context/context-assembler.ts`（1）：疑似偶然命中，需 1 眼确认。

---

## 6. 执行建议 + 机器门
1. **产品改名（Clowder→`<PRODUCT>`）**：纯机械 find/replace（区分命名空间 vs 注释引用，见 §3），改完跑全量门兜底（tsc 0 / vitest 1165 / eslint 0）。可独立于 skills 先做。
2. **agents.yaml（B3）**：小改，随时可做。
3. **skills 去猫化（B1/B2）**：**需重写**（含我们不存在的工具/基础设施），非 find/replace；单独成批，并新增机器门「skill 内容不得含 `猫/铲屎官/cat_cafe/cat-cafe/CAT_CAFE/Ragdoll/Siamese` 等残留词」——堵住 M11 当初漏掉内容校验的洞。
4. 建议三者**合成一个「去 Clowder / 品牌化」收尾批次**，等 D1/D2 定名后一次过，并与前端重做一起规划。

---

## 7. 2026-06-06 当前残留猫相关命名记录

> 本节只记录，不重命名。扫描范围：`packages/`、`tests/`、`docs/`、`scripts/`；排除 `reference/`、`node_modules/`、`.harness/`、`.git/`、`dist/`、`coverage/`。

### 7.1 会影响 API / 数据契约的字段名

| 命名 | 代表位置 | 当前含义 | 下一步建议 |
|------|----------|----------|------------|
| `ownerCatId` | `packages/shared/src/types/task.ts`、`packages/api/src/routes/task-routes.ts`、`packages/api/src/stores/sqlite-task-store.ts`、`packages/web/src/components/overlays/WorkspaceTasks.tsx` | task owner agent id；数据库列已是 `owner_cat_id` | 作为契约迁移处理，目标大概率是 `ownerAgentId`；需要 API、store、UI、测试一起改 |
| `senderCatId` | `packages/shared/src/types/context.ts`、`packages/api/src/context/system-prompt-builder.ts`、`packages/api/src/context/system-prompt-l0.ts` | cross-thread reply hint 的发件 agent id | 改为 `senderAgentId`；需兼容旧 payload 或一次性迁移调用点 |
| `targetCatId` | `packages/shared/src/types/context.ts`、`packages/api/src/context/system-prompt-builder.ts` | mention routing feedback 的目标 agent id | 改为 `targetAgentId`；与 mention router/feedback 测试同步 |
| `catId` | `packages/shared/src/types/context.ts`、`packages/api/src/context/burst-detector.ts`、`packages/api/src/context/tombstone.ts`、`packages/api/src/context/system-prompt-builder.ts` | active participant / legacy Clowder comment 中的 agent id | 代码字段改为 `agentId`；仅解释来源的 Clowder 注释可保留 |

### 7.2 Agent roster / 可见人格命名

| 命名 | 代表位置 | 当前含义 | 下一步建议 |
|------|----------|----------|------------|
| `布偶猫` | `packages/api/src/config/agents.yaml`、大量 context/web tests | Claude persona name / fixture display text | 等新项目命名确定后替换；测试夹具跟随配置改 |
| `橘猫` | `packages/api/src/config/agents.yaml`、`tests/web/fixtures.ts`、少量 web/api tests | Codex persona name / mention alias | 同上 |
| `暹罗猫` | `packages/api/src/config/agents.yaml`、Antigravity/Gemini 相关注释与测试 | Gemini persona name / mention alias | 同上；Antigravity 注释里的“@gemini/暹罗猫”也要一起清理 |
| `@布偶`、`@橘猫`、`@阿橘`、`@暹罗`、`@小罗` | `packages/api/src/config/agents.yaml` | 猫人格 mention aliases | 可直接删掉或替换为新 alias；保留 `@claude/@codex/@gemini` |

### 7.3 用户可见文案 / UI 语义

| 命名 | 代表位置 | 当前含义 | 下一步建议 |
|------|----------|----------|------------|
| `铲屎官` | `packages/web/src/components/overlays/WorkspaceTasks.tsx`、`packages/api/src/context/context-assembler.ts`、skill 文档 | 用户称呼 | UI 文案改为“用户”或新项目定义；注释可同步清理 |
| `毛线球` | `packages/web/src/components/overlays/WorkspaceTasks.tsx` | task 的产品化称呼 | 如果项目要做不一样的 task metaphor，需产品命名后替换 |
| `猫猫` / `多猫` / `三猫` / `单猫` | skill 文档为主 | multi-agent / agent persona 口吻 | 不适合机械替换；应按每个 skill 的真实工作流重写 |

### 7.4 Skill / 文档资产里的 Cat-Cafe 遗留

| 命名 | 代表位置 | 当前含义 | 下一步建议 |
|------|----------|----------|------------|
| `cross-cat-handoff` | `packages/skills/manifest.yaml`、`packages/skills/skills/cross-cat-handoff.md`、若干 skill 引用 | skill id + 文件名 + 内部引用 | 目标可为 `cross-agent-handoff`；需要 manifest、文件名、引用、测试同步 |
| `targetCats` | `packages/skills/skills/cross-thread-sync.md` | cross-post 目标参数名 | 目标可为 `targetAgents`；同时确认当前 MCP 工具是否真的支持该参数 |
| `cat-cafe` | 多个 `packages/skills/skills/*.md`、`packages/api/src/config/global-config.ts`、`packages/api/src/routes/catalog-routes.ts` | 历史路径、外部技能根、旧基础设施名 | 分两类处理：真实兼容路径先保留并标注；skill 文档里的旧 infra 需要重写 |
| `cat_cafe_*` / `CAT_CAFE_*` | skill 文档、`packages/mcp-server/src/env-keys.ts` 注释、docs | 旧 MCP tool / env 命名 | skill 中多数指向不存在工具，不能 find/replace；需要按 Choco 当前工具集重写 |
| `cat-cafe-skills/refs/shared-rules.md` | `packages/api/src/routes/catalog-routes.ts`、`tests/api/catalog-routes.test.ts`、`tests/web/settings-catalog.edge.test.tsx` | 当前 Rules viewer 的 shared rules 兼容路径 | 如果技能根改名，需要一起迁移 API allowlist 和测试 |

### 7.5 测试与历史文档

| 类别 | 代表位置 | 说明 | 下一步建议 |
|------|----------|------|------------|
| 测试夹具 | `tests/context/fixtures.ts`、`tests/web/fixtures.ts`、`tests/shared/types.test.ts`、`tests/context/system-prompt-builder*.test.ts` | 固化了猫名、`catId` 字段和 UI 文案 | 应随生产代码契约迁移；不要单独先改测试 |
| 历史/参考文档 | `docs/clowder-ai-architecture-extraction.md`、`docs/clowder-architecture-design.md`、`docs/clowder-design-supplement.md`、`docs/STATUS.md` | 保留了来源项目和历史方案语言 | 标注为历史参考即可；不作为第一批机械 rename 对象 |
| 来源注释 | `packages/api/src/context/burst-detector.ts`、`packages/api/src/context/tombstone.ts`、`packages/shared/src/types/account.ts` | “from Clowder / ~/.cat-cafe” 这类来源说明 | 如果只是 provenance，优先保留；如果变成当前产品文案，再改 |

### 7.6 当前优先级建议

1. 先定新项目的 agent/persona 命名规则，再改 `agents.yaml` 和可见 UI 文案。
2. 再迁移 API 字段：`ownerCatId`、`senderCatId`、`targetCatId`、`catId`，这需要一次完整类型/API/测试变更。
3. 最后处理 skills：它们不是简单去猫化，里面还包含旧 Cat-Cafe/Clowder 工具和基础设施假设，应逐篇按 Choco 的真实工具集重写。

---

## 8. 2026-06-06 Chymia AI 命名决策与本轮处理

### 8.1 已拍板

| 项 | 决策 |
|----|------|
| 产品名 | `Chymia AI` |
| 风格方向 | 个人炼金工坊（personal alchemy workshop） |
| Agent 命名 | 只用模型/供应商原名：`Claude`、`Codex`、`Gemini` |
| Agent mention | 只保留默认英文 handle：`@claude`、`@codex`、`@gemini` |
| 旧猫昵称 | `布偶猫`、`橘猫`、`暹罗猫`、`Ragdoll`、`Maine Coon`、`Siamese` 不再作为默认命名 |
| 默认用户/任务文案 | `铲屎官` -> `用户`；`毛线球` -> `任务` |

### 8.2 本轮已处理

| 范围 | 处理 |
|------|------|
| `packages/api/src/config/agents.yaml` | 重写默认 roster：`name/displayName` 改为 `Claude/Codex/Gemini`，mentionPatterns 只保留英文 handle |
| `packages/web/index.html` | 浏览器标题改为 `Chymia AI · personal alchemy workshop` |
| `packages/web/src/App.tsx` | 顶栏品牌改为 `Chymia AI`，副标题改为 `personal alchemy workshop` |
| `packages/web/src/choco.css` | 保留 `.d-choco` 工程类名，主题 token 改为 Chymia 的黄铜/墨绿炼金工坊方向 |
| `packages/web/src/components/overlays/SettingsOverlay.tsx` | 设置页品牌和主题标签改为 `Chymia AI` / `Atelier · Chymia AI` |
| `packages/web/src/components/overlays/WorkspaceTasks.tsx` | 可见文案改为默认 `任务` / `用户` |
| `assets/system-prompts/system-prompt-l0.md` | L0 prompt 标题改为 `Chymia AI L0 Native System Prompt` |
| `tests/context/fixtures.ts`、`tests/web/fixtures.ts` | 默认测试 roster 同步为无猫昵称、无猫 mention aliases |

### 8.3 本轮刻意暂留

| 命名 | 原因 | 后续处理建议 |
|------|------|--------------|
| `@choco/*` package scope | 工程包名迁移面很大，会影响所有 imports、package.json、tsconfig/vitest alias | 单独开工程命名迁移批次，带全量门禁 |
| `.d-choco` CSS class / `components/choco/*` | 这是当前设计系统内部 namespace，直接改会触发大量结构性 diff | 后续如要彻底品牌化，可迁移为 `.d-chymia` / `components/chymia/*` |
| `~/.choco` config root / `CHOCO_*` env | 涉及用户本地数据路径、环境变量和兼容性 | 需要兼容迁移策略：新 `CHYMIA_*` + 旧 `CHOCO_*` fallback |
| `cat-cafe-skills/` | 当前 Rules viewer 与 skill allowlist 仍依赖兼容路径 | 等 skill 根目录重命名时同时改 API allowlist 和测试 |
| `STATUS.md` 历史记录中的猫/Choco | 属于历史状态和变更记录，不是当前产品文案 | 可以在单独文档清理批次中改写或标注为历史 |

### 8.4 新增验证

- `tests/api/agent-config-loader.test.ts` 锁定默认 roster 不再包含猫昵称。
- `tests/web/choco-design.edge.test.tsx` 的 mention autocomplete 测试改为只接受 `@claude/@codex/@gemini`，并确认旧猫 alias 不再触发建议。

---

## 9. 2026-06-06 工程命名迁移清单：Choco -> Chymia / Cat-Cafe Skills -> Chymia Handbook

> 本节只记录，不修改。扫描范围：`packages/`、`tests/`、`docs/`、`scripts/`、根配置文件；排除 `reference/`、`node_modules/`、`.harness/`、`.git/`、`dist/`、`coverage/`。本节覆盖第 8 节“暂留”的工程命名，作为下一批迁移输入。

### 9.1 已拍板的工程目标名

| 旧命名 | 新命名 | 语义 |
|--------|--------|------|
| `choco` / `Choco` / `CHOCO` | `chymia` / `Chymia` / `CHYMIA` | 工程、包、env、内部 namespace |
| `cat-cafe-skills/` | `chymia-handbook/` | skill 集群；炼金手册概念 (Decision A) |
| `choco-skills` | `chymia-handbook` | skill pack label |
| `choco-mcp` | `chymia-mcp` | MCP server name / log prefix |
| `choco-mcp-*` | `chymia-mcp-*` | 临时 MCP config 目录/文件前缀 |
| `~/.choco` | `~/.chymia` | 用户本地配置根目录；需要旧路径 fallback |
| `choco.db` | `chymia.db` | 默认本地数据库；需要旧 DB 迁移/兼容策略 |

#### 9.1.1 UI 主题化命名 (已拍板 - Decision A)
| 旧概念 | 新概念 | 备注 |
|---|---|---|
| `Workspace` | `Atelier` | "工作室", 作为顶层 UI 概念 |
| `Session` / `Thread` | `Experiment` | "实验", 赋予交互探索感 |

### 9.2 包名 / workspace / import scope

| 当前命名 | 代表位置 | 目标 | 迁移说明 |
|----------|----------|------|----------|
| 根包 `"name": "choco"` | `package.json` | `"chymia"` | 与 lockfile 同步 |
| `@choco/adapters` | `packages/adapters/package.json`、imports | `@chymia/adapters` | 机械迁移，但需要全 repo import 同步 |
| `@choco/api` | `packages/api/package.json`、imports | `@chymia/api` | 同上 |
| `@choco/mcp-server` | `packages/mcp-server/package.json`、imports | `@chymia/mcp-server` | 同上 |
| `@choco/shared` | `packages/shared/package.json`、imports | `@chymia/shared` | 命中最多；需同步 CLAUDE.md import 规则 |
| `@choco/skills` | `packages/skills/package.json`、imports | `@chymia/handbook` | 与 skill 集群目录名 `chymia-handbook/` 保持一致 (Decision A)。 |
| `@choco/web` | `packages/web/package.json`、imports | `@chymia/web` | 同上 |
| TS/Vitest alias | `tsconfig.base.json`、`vitest.config.ts` | `@chymia/*` | 必须与 package.json 和 imports 一次性改 |
| lockfile package keys | `pnpm-lock.yaml` | `@chymia/*` | 推荐由包名修改后重新安装/更新 lockfile 生成 |

### 9.3 路径、数据库、本地状态

| 当前命名 | 代表位置 | 目标 | 迁移说明 |
|----------|----------|------|----------|
| repo 路径 `D:\proj\choco-ai` | tests、trusted workspace、历史文档 | 可选 `D:\proj\chymia-ai` | 目录名变更会影响本地路径型测试和 trust store；不建议和代码 rename 混在一批 |
| `choco.db` / `choco.db-shm` / `choco.db-wal` | repo 根目录运行数据 | `chymia.db` | 运行数据；需要决定是否自动迁移旧 DB |
| `DEFAULT_DB_PATH = 'choco.db'` | `packages/api/src/app-factory.ts` | `chymia.db` | 应配合旧 DB 检测/迁移 |
| trusted workspace `d:\proj\choco-ai\.workspace` | `data/trusted-workspaces.json` | 新项目路径 | 属用户本地状态；程序可迁移，但需避免覆盖用户手工配置 |
| 测试路径 `D:/proj/choco-ai` | 多个 API/provider/web tests | `D:/proj/chymia-ai` 或抽象 fixture | 可机械改，但目录真实存在性测试要小心 |

### 9.4 本地配置目录

| 当前命名 | 代表位置 | 目标 | 迁移说明 |
|----------|----------|------|----------|
| `~/.choco` | `packages/api/src/config/global-config.ts` | `~/.chymia` | 新路径优先，旧路径 fallback |
| account store 文案/默认路径 | `packages/api/src/config/account-store.ts`、`packages/shared/src/types/account.ts`、`routes/account-routes.ts` | `~/.chymia/accounts.json` 等 | API 与 UI 文案同步 |
| adapter config store | `wechat-config-store.ts`、`weixin-token-store.ts`、`feishu-config-store.ts` | `~/.chymia/...` | 需要旧文件读取兼容 |
| skill enablement store | `packages/api/src/skills/skill-enablement-store.ts` | `~/.chymia/...` | 与 skill 根改名同批更清晰 |
| UI 文案 | `packages/web/src/components/overlays/SettingsOverlay.tsx` | `~/.chymia` | 用户可见；应展示新路径，必要时说明旧路径兼容 |
| 相关 tests | `tests/api/account.*`、`skill-toggle.*`、`wechat-wiring.*`、`weixin-wiring.*` | `~/.chymia` + fallback 覆盖 | 需要新增旧路径 fallback 测试 |

### 9.5 环境变量前缀

| 当前 env | 代表位置 | 目标 env | 迁移说明 |
|----------|----------|----------|----------|
| `CHOCO_WORKSPACE` | `packages/api/src/main.ts`、`app-services.ts`、scripts、tests | `CHYMIA_WORKSPACE` | 新变量优先，旧变量 fallback |
| `CHOCO_PERMISSION_MODE` | `main.ts`、`runtime/agent-services.ts`、scripts、tests | `CHYMIA_PERMISSION_MODE` | 同上 |
| `CHOCO_CLAUDE_CMD` | `main.ts` | `CHYMIA_CLAUDE_CMD` | 同上 |
| `CHOCO_CODEX_CMD` | `main.ts` | `CHYMIA_CODEX_CMD` | 同上 |
| `CHOCO_GEMINI_CMD` | `main.ts`、`antigravity-service.ts`、`agent-services.ts` | `CHYMIA_GEMINI_CMD` | 同上 |
| `CHOCO_AGENT_OVERRIDES` | `main.ts` | `CHYMIA_AGENT_OVERRIDES` | 同上 |
| `CHOCO_RUNTIME_ROSTER` | `main.ts` | `CHYMIA_RUNTIME_ROSTER` | 同上 |
| `CHOCO_API_URL` | `app-factory.ts`、`providers/mcp-config.ts`、`mcp-server/callback-client.ts`、`env-keys.ts` | `CHYMIA_API_URL` | MCP callback env；必须 API 与 MCP server 同批 |
| `CHOCO_INVOCATION_ID` | 同上 | `CHYMIA_INVOCATION_ID` | 同上 |
| `CHOCO_CALLBACK_TOKEN` | 同上 | `CHYMIA_CALLBACK_TOKEN` | 同上 |
| `CHOCO_MCP_SERVER_PATH` | `main.ts`、`providers/mcp-config.ts` | `CHYMIA_MCP_SERVER_PATH` | 同上 |
| `CHOCO_TSX_CLI_PATH` | `providers/mcp-config.ts` | `CHYMIA_TSX_CLI_PATH` | 同上 |
| `CHOCO_GLOBAL_CONFIG_ROOT` | `config/global-config.ts` | `CHYMIA_GLOBAL_CONFIG_ROOT` | 新变量控制 `~/.chymia` |
| `CHOCO_TRUST_STORE` | `runtime/workspace-trust.ts`、tests | `CHYMIA_TRUST_STORE` | 同上 |
| `CHOCO_TRUST_WORKSPACE` | `main.ts`、`workspace-trust.ts`、scripts | `CHYMIA_TRUST_WORKSPACE` | 同上 |
| `CHOCO_TELEGRAM_BOT_TOKEN` | `adapters/telegram/telegram-adapter.ts` | `CHYMIA_TELEGRAM_BOT_TOKEN` | 可低优先，因为 Telegram 当前非主线 |
| `CHOCO_WECHAT_*` | `adapters/wechat/*` | `CHYMIA_WECHAT_*` | 可低优先，因为 WeChat/WeCom 当前非主线 |

### 9.6 MCP / runtime 字符串

| 当前命名 | 代表位置 | 目标 | 迁移说明 |
|----------|----------|------|----------|
| `SERVER_INFO.name = 'choco-mcp'` | `packages/mcp-server/src/index.ts` | `chymia-mcp` | 用户/CLI 可见 |
| log prefix `[choco-mcp]` | `packages/mcp-server/src/index.ts` | `[chymia-mcp]` | 可机械改 |
| `WIN_TEMP_PREFIX = 'choco-mcp-'` | `packages/api/src/providers/mcp-config.ts` | `chymia-mcp-` | 相关 tests 断言同步 |
| `choco__evidence_search` / `choco__unknown` | `tests/providers/codex-parser*.test.ts` | 视实际 MCP server/tool namespace 决定 | 这是 provider parser 测试样例，需确认真实 tool name 是否也带 namespace |
| `client_id: choco-weixin-*` | `packages/adapters/weixin/ilink-client.ts` | `chymia-weixin-*` | 低风险机械改 |

### 9.7 Web 设计系统 namespace

| 当前命名 | 代表位置 | 目标 | 迁移说明 |
|----------|----------|------|----------|
| `packages/web/src/choco.css` | CSS 文件名、`main.tsx` import、tests | `chymia.css` | 文件 rename + import + tests |
| `packages/web/src/choco-overlays.css` | CSS 文件名、`main.tsx` import | `chymia-overlays.css` | 同上 |
| `.d-choco` | `App.tsx`、CSS、component comments、tests | `.d-chymia` | 大量选择器/注释/测试同步 |
| `packages/web/src/components/choco/` | component imports、tests、tool path fixture | `packages/web/src/components/chymia/` | 文件夹 rename + relative imports + tests |
| `theme-choco` | `SettingsOverlay.tsx`、`tests/web/choco-overlays.edge.test.tsx` | `theme-chymia` | test id 属工程契约，需同步 |
| `docs/choco-type-tokens.css` / `.choco-scope` | docs、CSS 注释引用 | `docs/chymia-type-tokens.css` / `.chymia-scope` | docs 被 gitignore，但应记录并同步 |
| test 文件名 `choco-design*` / `choco-overlays*` | `tests/web/` | `chymia-design*` / `chymia-overlays*` | 可选，但若追求彻底工程命名应改 |

### 9.8 Skill 集群：`cat-cafe-skills` -> `chymia-alch-handbook`

| 当前命名 | 代表位置 | 目标 | 迁移说明 |
|----------|----------|------|----------|
| 根目录 `cat-cafe-skills/` | repo 根目录 | `chymia-alch-handbook/` | 目录 rename；需同步 route allowlist 和测试 |
| Rules shared path `cat-cafe-skills/refs/shared-rules.md` | `packages/api/src/routes/catalog-routes.ts`、`tests/api/catalog-routes.test.ts`、`tests/web/settings-catalog.edge.test.tsx` | `chymia-alch-handbook/refs/shared-rules.md` | API wire shape 会变；前端测试 id 也会变 |
| skill preview root | `packages/api/src/routes/catalog-routes.ts` | `chymia-alch-handbook/${name}/SKILL.md` | 需要越界路径测试同步 |
| docs references | `docs/rebrand-plan.md`、`docs/clowder-ai-architecture-extraction.md` 等 | 视历史文档策略 | 历史参考可保留，当前计划文档需更新 |
| skill md 中 refs | `packages/skills/skills/*.md` | `chymia-alch-handbook/refs/...` 或删除 | 多数段落还引用不存在工具，不能只改路径 |
| `packages/skills` 包目录 | `packages/skills/` | 待决：保留技术目录或改 `packages/alch-handbook` | 目录 rename 会扩大迁移面；建议与 `@chymia/alch-handbook` 决策绑定 |

### 9.9 Skill 内容里的旧 Cat-Cafe 工具/基础设施

| 当前命名 | 代表位置 | 目标 | 迁移说明 |
|----------|----------|------|----------|
| `cat_cafe_multi_mention` | `packages/skills/skills/collaborative-thinking.md` 等 | 需按当前 Chymia tool 能力重写 | 当前未必有同名能力 |
| `cat_cafe_cross_post_message` | `cross-thread-sync.md`、`thread-orchestration.md` | 当前可用能力若只有 `post_message`，需降级/改流程 | 不是机械替换 |
| `cat_cafe_create_task` / `cat_cafe_update_task` | `feat-lifecycle.md`、`receive-review.md` | 需确认当前 task callback/tool 是否存在 | 不是机械替换 |
| `cat_cafe_get_thread_context` / `cat_cafe_read_invocation_detail` / `cat_cafe_search_messages` | 多个 memory / quality / sync skills | 当前可用工具有限，需要重写 retrieval 流程 | 不是机械替换 |
| `CAT_CAFE_INVOCATION_ID` / `CAT_CAFE_CALLBACK_TOKEN` | `merge-gate.md` 等 | `CHYMIA_INVOCATION_ID` / `CHYMIA_CALLBACK_TOKEN` 或直接使用 MCP callback 文档 | 需与 env 迁移同步 |
| `CatCafeScanner` / `cat-cafe 项目` | `knowledge-engineering.md` 等 | Chymia 语义或删除 | 属旧方法论/产品内文，需要人工改写 |
| `cross-cat-handoff` | skill id/file/ref | `cross-agent-handoff` 或 Chymia 风格名 | manifest、文件名、引用、测试同步 |

### 9.10 适合用程序自动改的范围

可以用脚本/程序做，但建议按批次、每批跑门禁：

1. `@choco/*` -> `@chymia/*`：package names、workspace deps、imports、tsconfig/vitest alias。
2. 文件/目录 rename：`choco.css`、`choco-overlays.css`、`components/choco/`、test 文件名等。
3. CSS/test id rename：`.d-choco` -> `.d-chymia`、`theme-choco` -> `theme-chymia`。
4. MCP 字符串：`choco-mcp` -> `chymia-mcp`、`choco-mcp-` -> `chymia-mcp-`。
5. 新 env 名引入：增加 `CHYMIA_*`，并保留 `CHOCO_*` fallback；这一步适合程序生成重复映射，但需要手写兼容逻辑。
6. `cat-cafe-skills/` 路径 rename 到 `chymia-alch-handbook/`，同步 routes/tests。

### 9.11 不建议用纯 find/replace 的范围

这些可以由程序辅助定位，但需要人工/agent 按语义改：

1. `packages/skills/skills/*.md` 中的 `cat_cafe_*` 工具调用：很多工具当前不存在，需要重写流程。
2. `CAT_CAFE_*` 出现在历史参考文档时：可能是 provenance，不应假装成当前项目。
3. `D:\proj\choco-ai` 这类真实本机路径：改 repo 目录名前不要先改所有路径断言。
4. `~/.choco`：不能只替换成 `~/.chymia`，还要处理旧配置迁移/fallback。
5. `choco.db`：不能只改默认文件名，需决定是否读取/迁移旧数据库。
6. docs/STATUS 历史记录：应标注历史或单独清理，不作为工程迁移 gate。

### 9.12 建议迁移批次

1. **批次 A：包 scope 与 import**
   改 `@choco/*` -> `@chymia/*`、package names、alias、lockfile。验证：`npx tsc --noEmit`、`npx vitest run`、`npx eslint "packages/**/*.ts" --max-warnings 0`。

2. **批次 B：Web namespace**
   改 CSS 文件名、`.d-choco`、`components/choco/`、`theme-choco`、web tests。

3. **批次 C：env/config/DB 兼容迁移**
   新增 `CHYMIA_*`，旧 `CHOCO_*` fallback；新 `~/.chymia`，旧 `~/.choco` fallback；新 `chymia.db`，旧 `choco.db` 迁移策略。

4. **批次 D：MCP/runtime 字符串**
   改 `choco-mcp`、temp prefix、tool namespace 测试样例。

5. **批次 E：炼金手册根目录**
   `cat-cafe-skills/` -> `chymia-alch-handbook/`，同步 `/api/rules`、`/api/rules/skill/:name`、frontend rules tests。

6. **批次 F：skill 内容语义重写**
   重写旧 `cat_cafe_*` 工具流和 Cat-Cafe 方法论，补机器门：skill 内容不得出现旧猫/Cat-Cafe 当前语义残留。

---

## 10. Thematic Brainstorming & Inspiration (Gemini's Input)

> 以下是基于“个人炼金工房”主题的发散性头脑风暴，旨在为已有的优秀计划提供更多风味和灵感。可按需取用或忽略。

### 10.1 `skills` 目录命名

`chymia-alch-handbook` 是一个非常好的名字，符合“不过于极客”的要求。这里提供一些其他选项：

| 备选命名 | 风格/含义 |
|---|---|
| `chymia-atelier-notes` | "Atelier" (工作室) 很有品味，法语词汇增添了优雅感。 |
| `chymia-grimoire` | "魔典"，奇幻色彩更浓，可能略偏极客，但很有力。 |
| `chymia-formulas` / `chymia-recipes` | “配方”/“秘方”，强调 skill 的实用性和可组合性。 |
| `chymia-opus-archive` | "Opus" (拉丁语：巨著)，指炼金术的“伟大作品”，很大气。 |

**结论**：`chymia-alch-handbook` 和 `chymia-atelier-notes` 是最安全且有格调的选择。

### 10.2 Agent 炼金人设 (可选)

计划中建议去掉猫的人设，只保留模型名 (Claude/Codex/Gemini)，这是最简洁专业的做法。如果想保留人设增添趣味，可以考虑以下炼金主题的身份：

| Agent | 炼金人设 | 含义 |
|---|---|---|
| Claude (Opus) | **Philosopher** (哲学家) | 炼金术不仅是化学，也是哲学。契合其架构师的定位。 |
| Codex (GPT) | **Artisan** (工匠) | 精于将理论（配方）转化为实际产物的熟练匠人。 |
| Gemini (Pro) | **Scholar** (学者) | 负责研究、分析、提供洞见的学者。 |

### 10.3 用户/任务隐喻

| 旧概念 | 机械替换 | 炼金主题隐喻 | 备注 |
|---|---|---|---|
| `铲屎官` (User) | `用户` | **Alchemist** (炼金术士) | 用户是这个“工坊”的主人，是驱动一切的核心。 |
| `毛线球` (Task) | `任务` | **Formula** / **Recipe** (配方) | 用户给出的指令，就像一个等待被实现的“炼金配方”。 |

### 10.4 核心服务命名

| 旧概念 | 机械替换 | 炼金主题隐喻 | 备注 |
|---|---|---|---|
| `mcp-server` | `chymia-mcp` | **Alembic** (蒸馏器) | Alembic 是炼金术中用于蒸馏和提纯的核心设备，非常契合多 Agent 协作/编排中心的角色。 |
| `cross-cat-handoff` | `cross-agent-handoff` | `essence-transfer` | “本质交接”，比 `handoff` 更有主题感，但清晰度稍逊。`cross-agent-handoff` 更安全。|

### 10.5 对代码内部命名的思考

对于 `catId` -> `agentId` 这样的内部变量，计划中的提议（改为 `agentId`）是完全正确的。在代码层面，**清晰性永远优先于主题化**。将内部 API 和变量名强行改为 `essenceId` 或 `catalystId` 会让代码变得晦涩难懂，得不偿失。我们应该将炼金主题更多地应用在用户可见的、概念性的命名上。

# 写作助手工具清单（主进程 Pi Agent）

模型实际能调用的工具只有一份实现：领域工具 `electron/pi/tools/*` 由
`electron/pi/tool-builder.ts:buildAgentTools()` 组装；Pi harness 自带的执行工具
（`read` / `write` / `edit` / `bash`，`electron/pi/execution-tools.ts:buildExecutionTools()`）
由 `AgentSession.create` 在有执行环境时挂上（ADR 0023）。
渲染层不再拥有第二份工具实现（历史遗留的 `src/services/agent/tools/*.tool.ts` 已删除）。

## 工具与数据来源

| 工具 | 作用 | 数据来源 | 需确认 |
| --- | --- | --- | --- |
| `read_project_state` | 项目总览：`sections` 选 config / progress / recent_notes / blueprints（默认全部） | `ProjectCoreRepository` + `BlueprintRepository` + `DraftRepository` | 否 |
| `read_architecture` | 故事前提 / 世界观 / 情节大纲，`section` 可选其一 | `ProjectCoreRepository` | 否 |
| `read_characters` | 权威角色名单：列表或单角色资料 + `currentState` | `CharacterRosterRepository.read()` | 否 |
| `read_blueprint` | 单章蓝图（`chapter_number` 必填） | `BlueprintRepository` | 否 |
| `read_drafts` | 某章草稿正文与版本 | `DraftRepository` | 否 |
| `read_file` | 项目目录里用户自己的文本文件 | 安全文件系统能力 | 否 |
| `search_knowledge` | 知识库语义检索 | `knowledgeBaseLoader` + embedding 配置 | 否 |
| `inspect_writing_skill` | 只读检查公开 GitHub 上的提示词型 Skill | 网络只读 | 否 |
| `read`（harness） | 读执行环境内的文件 | `ConfinedExecutionEnv`（项目根 / 助手 workspace） | 否 |
| `write` / `edit`（harness） | 覆盖写、按唯一原文精确替换 | 同上；走安全文件系统原子写与提交态语义 | 是 |
| `bash`（harness） | 在固定 cwd 执行命令（默认 120s 超时） | 同上；写行为不在提交态保护内 | 是 |
| `replace_draft_excerpt` | 按唯一原文精确替换草稿片段 | `DraftRepository` | 是 |
| `open_editor` | 打开内置页面（config/blueprints/characters/architecture/synopsis）或只读查看项目文件 | 渲染层动作 | 是 |
| `novel_config` | 读取或直接填充修改小说配置各个字段（大纲/世界观/金手指/人设等） | `ProjectCoreRepository` | 是（修改时） |
| `story_architecture` | 读取或直接填充修改故事架构三大核心文档（premise/worldbuilding/synopsis） | `ProjectCoreRepository` | 是（修改时） |
| `propose_chapter_blueprint` | 章节蓝图字段差异提案 | `BlueprintRepository` | 是 |
| `install_writing_skill` / `bind_writing_skill` | 安装 / 绑定写作 Skill | 网络 + 项目配置 | 是 |
| `mcp__<server>__<tool>` | 已连接 MCP 服务提供的工具 | MCP manager | 由 MCP 决定 |

## 设计规则（改工具前先读）

1. **项目全貌只有一个入口**：`read_project_state`。章节进度、蓝图清单、近章要点都是它的 `sections`，
   不要再为「看看项目到哪了」新增工具。
2. **角色只有一个来源**：`read_characters`（结构化名单 + `currentState`）。
   `read_architecture` 不返回角色图谱；旧 `characters` 表只作为迁移证据由仓库层维护。
3. **数据库事实不是文件**：novel config / 蓝图 / 草稿 / 架构 / 大纲都存 SQLite。
   `read_file`、`write_file` 只用于用户自己的物理文件；`write_file` 会拒绝保留语义文件名
   （见 `src/services/project-fact-targets.ts`）。
4. **内置页面不读盘**：`open_editor` 的数据库型目标直接让渲染层打开内置编辑器，
   只有 `target: 'file'` 才读取物理文件。
5. **结构化提案只有一份校验实现**：`src/shared/domain-proposals.ts`。
   主进程用它校验并落库，确认卡片用同一份函数计算差异；不要再写第二套字段白名单。
6. **确认语义按工具划分**：只读工具自动执行；写入与外部副作用工具必须列入
   `confirmationToolNames()`（`electron/pi/__tests__/tool-builder.test.ts` 会锁住这份名单）。
7. **写入只有一套语义**（ADR 0023）：`write_file` 与 harness 的 `write` / `edit` 都走安全文件系统的
   原子写；提交态未知时都终止本轮，避免模型自动重写。`bash` 只能靠确认卡把关。
8. **配置与采样参数只有一个策略源**：`resolveGenerationParameters()` + `resolveReasoningPolicy()`。
   两条轨道（助手对话 / 工作流单发）都必须从这里取参数，不要在调用点各写一份。

## 技能（Skill）与工具的关系

Skill 不作为工具暴露给模型，也**不注册进 harness 的资源表**（ADR 0023：`resources.skills` 的
唯一消费入口 `lane.skill()` 无人调用，同一份正文不再留第二份副本）。
`/技能名` 由 `src/stores/agent-store.ts` 把 Skill 正文注入该轮用户消息，
阶段绑定（`bind_writing_skill`）则把 Skill 正文写进对应工作流提示词。
模型看到的技能清单来自系统提示词（Pi 的 `formatSkillsForSystemPrompt`，见
`electron/pi/agent-system-prompt.ts`），正文按需用 `load_writing_skill` 直读磁盘。
渲染层的 `toolRegistry` 只服务界面与 MCP 记账，模型工具表始终来自主进程
`electron/pi/tool-builder.ts:buildAgentTools()`，两边不要互相假设。

## 相关测试

- `electron/pi/__tests__/tool-builder.test.ts` — 工具清单、英文描述、确认名单。
- `electron/pi/tools/__tests__/*` — 每个工具的输入输出契约。
- `src/shared/__tests__/domain-proposals.test.ts` — 提案校验与差异计算。

# Pi 底层替换 TODO（2026-09-10）

> 目标：把 Agent 引擎与 LLM 调用层替换为 Pi。
> **功能不变、用户数据可正常读取；改变的只是实现方式**（文本式工具调用 → 原生工具调用、自研引擎 → Pi）。
> 破坏性仅限"实现方式层"：旧的文本协议不再被识别、自研组件被替换，不写协议级兼容代码。
> 本文档只整理待办事项，不承载实现细节。
> 自研循环里哪些该删、哪些不是遗产：见 [`2026-09-10-pi-agent-homemade-legacy.md`](2026-09-10-pi-agent-homemade-legacy.md)。

## 迁移范围与原则

### 只换底层（用户不可见）

| 底层组件 | 现状 | 替换为 |
|---|---|---|
| LLM 调用层（**所有**入口） | 自研 provider（openai-compatible / gemini） | `@earendil-works/pi-ai` 原生 tools + 流式 |
| 一次性交卷 | `session.complete` / `callLLM` / bounded 续写 | **只** pi-ai 一次流式（强制 `submit_*` 或可见文本）；**不** `new Agent()` |
| 多轮会话 | 自研 ReAct（`agent-engine.ts`） | `pi-agent-core` Agent（内部仍走 pi-ai） |
| 工具调用协议 | 文本式 + 4 格式解析 | 原生 function calling |
| 多轮上下文 | Zustand + 手写 history 注入 | 仅多轮：Pi Agent `state.messages` / `transformContext` |
| MCP 客户端 | 自研 JSON-RPC | 官方 `@modelcontextprotocol/sdk` |

### 保持不变的（功能与数据）

- 全部现有功能：起草 / 审稿 / 修稿 / 定稿 / 批量创作 / 知识库 / MCP / Skill / 导出 / 更新
- **Ollama 保留**（本地推理是产品卖点）：仅工具调用能力达标的模型可用于生成，其余在 UI 提示
- UI 交互、快捷键、面板布局、状态展示
- Agent 面板对话文本的流式输出（文本输出，非工具调用）
- **用户数据全部可正常读取**：
  - 小说项目数据（`vela.db` 的草稿 / 蓝图 / 角色 / 定稿 / 审稿 / 恢复候选）——本次不动该 schema
  - 用户配置数据（`~/.vela/models.json` 模型配置、`mcp_config.json`、`skills/`、`prompts/` 覆盖文件、项目 `.vela/` 内容）——继续读取，不改变文件位置与格式约定
  - 助手对话：界面存档 `.vela/agent-conversations.json` 位置与格式不变；**新增** Pi 会话存档 `.vela/agent-sessions/`（第三批，见 P8），旧的 `.vela/agent-conversations.json` 原样当迁移来源读

### 实现方式的变化（仅底层，不影响功能与数据读取）

- **工具调用协议**：文本式（XML/DSML/JSON/函数式，4 格式解析）→ 原生 function calling；旧的文本协议输出不再被识别
- **LLM 调用层**：自研 provider → `pi-ai`（一次性与多轮共用）
- **多轮引擎**：自研 ReAct → 仅助手等会话用 Pi Agent；一次性入口不包成 Agent
- **MCP 客户端**：自研 JSON-RPC → 官方 SDK
- **提示词模板**：内置模板中的 JSON/XML 协议指令改写为工具调用形式；**用户的覆盖文件照常读取**，若其中仍写着旧协议指令，行为由用户自行保证（不写协议级迁移代码，UI 提示可"重置为默认"）
- **模型能力**：新增 `toolCalling` 能力位（现有配置照常读取，能力重新探测）
- **生成模型能力门控**：生成模型必须支持原生工具调用，不支持的模型在 UI 明确提示不可用
- **章节正文不再流式**：正文改为工具调用参数（`submit_draft` 等），**生成完成后一次性显示**
- **DSH 插件内容彻底删除**：README / 文档 / ADR 直接移除（见「附加任务」）

### 不在本次范围（后续增强，另立计划）

- 多会话并行 UI（会话列表、多会话同时生成）
- 角色配置层（RoleProfile：每角色独立模型 / 提示词 / Skill / 推理强度）
- 审稿环节单独选模型（当前 `ReviewOnlyParams` 无模型字段）
- ~~会话重启持久化~~：**已改到本次范围内**（第三批，见 P8）；渲染层的对话存档仍在，主进程不再"重启即丢"。
- 多会话并行的会话列表 UI 仍属后续（Pi 的分支/fork 能力本期不用）
- **移除 NovelAI**：独立工作，见 [`2026-09-11-remove-novelai.md`](2026-09-11-remove-novelai.md)；本迁移不删预设/兼容分支/README 章节

## 自研 Agent 遗产（换 Pi 后删除）

代码盘点见 [`2026-09-10-pi-agent-homemade-legacy.md`](2026-09-10-pi-agent-homemade-legacy.md)。下面只列待办勾选，不重复机制说明。

- [x] 删除文本工具协议：`parseToolCalls`、三种宽松解析、DSML、`cleanAgentVisibleText`、`generateToolPrompt` XML 说明书与「每次最多一个」规则
- [x] 删除假 user `<tool_result>` 回灌；历史不再压成 16 条 user/assistant 字符串（随 `runAgentLoop` 删除；Pi `state.messages` 保真工具回合）
- [x] OpenAI 的 `finish_reason: tool_calls` / `function_call` 映射为 `stop`；已删除 `requireCompleteAgentResponse`
- [x] 删除全局 `generating` / `activeAbortController` / `pendingConfirmations` 单例；`@` 预填正文改为提示模型原生调工具（生成中状态由会话 `streaming` 推导；`mentionsToToolCalls` 已删）
- [x] 删除 `runAgentLoop`、手写 observation、Agent 整轮 `output: 'visible-text'`（`agent-engine.ts` 已删）
- [x] 助手 LLM 运输交给 pi-ai：已删除自研 OpenAI/Gemini SSE 解析与 `LLMFactory`；`<think>` 剥除仍留给工作流落盘层；保留 models.json / 租约 / 推理策略适配
- [x] **未误删非遗产**：`leaseId`、模型执行租约、写工具确认、workflow claims、恢复候选、工作流 `parseJSON`、`generation-harness` 预算、领域工具、写作 Skill、React UI 均在。自研 MCP 客户端按 P3 换成官方 SDK，配置格式未改

## 已拍板

- **engines 升 `>=22.19.0`**（Pi 硬要求）；CI 已用 Node 22.23.1，无需改 workflow
- **AWS Bedrock 硬依赖**（pi-ai 声明式依赖 `@aws-sdk/client-bedrock-runtime`）：**接受，不裁剪**，随依赖进包
- **正文展示方式**（P4）：**全量工具调用，含正文**；正文作为 `submit_*` 工具参数返回，**生成完一次性显示，不保持流式、不做增量 JSON 解析**（Agent 面板对话文本仍为流式）
- **调用层分工（运输统一，循环不滥用）**：
  - **一次性**（起草、单次审稿交卷、修稿、定稿后处理、架构/蓝图、单字段、导入、规划资料、角色表修复、剧情树、叙事线索候选、编辑器选区 AI）：只用 **pi-ai 一次流式调用**，强制 `submit_*` 或可见文本；**禁止**为切书好杀而 `new Agent()`
  - **多轮**（助手；日后若要跨次记忆的审稿会话）：才用 **pi-agent-core Agent**，内部仍走 pi-ai
  - 工作流编排 / claims / 落盘仍留 command；只换「怎么打模型」
  - 切书停的是「这部书上所有 pi-ai 请求」：一次性 abort 该次 stream，多轮 abort Agent
  - 本次范围仍是同一时间只开一部书
- **审稿默认仍是一次性 pi-ai**。升为带记忆的审稿 Agent 属后续产品，不在本次把 `review-chapter` 包成空工具 Agent

### 调用层用法细则（单次 / 多轮）

**单次调用**（起草、审稿交卷、修稿、定稿后处理、架构/蓝图、单字段、导入、规划资料、角色表修复、剧情树、叙事线索候选、编辑器选区 AI）

- API：`pi-ai` 的流式补全（`models.stream(model, {...}, { toolChoice: 'any' })` 强制提交）。**一次请求一次响应，不建 `Agent`、不建循环**；主进程产物是 ESM，直接静态 `import` Pi 包（并 external）
- 工具集：**只挂提交合同工具**（`submit_draft` / `submit_review` / `submit_revision` / `submit_finalization` …），**不挂读取工具**——一旦挂上读取工具，模型会调用后停下等结果，一次性语义即被破坏。上下文仍由 command 预先组装（与现状一致）
- 输出：**pi-ai 流式路径不校验工具名**——须 app 显式 `validateToolCall(tools, call)` + 校验 `submit_*` 名字（幻觉/错名工具调用会静默成功，见 P0）。命中 `submit_*` 即校验落盘；未命中按可见文本处理
- 取消：切书 / 取消任务 = abort 该次 stream（`AbortSignal`）
- 记账：每次调用照旧写 `llm_calls`；**不产生会话历史**
- 为什么不用 Agent：Agent 自带循环与状态，一次性用不上；包成 Agent 只会多出一个"为切书好杀"而存在的对象（见上条拍板）

**多轮对话**（助手会话；日后若要跨次记忆的审稿会话）

- API：`pi-agent-core` 的 `Agent`，**每会话一个长驻实例**；`agent.prompt()` 追加一轮，`messages` 由实例持有
- 循环：工具 → 结果 → 再回答由 Agent 内部完成，这正是用它的理由
- 上下文注入：`transformContext` 取代现在的"每轮重建 system prompt + 手动裁 16 条"
- 上下文缓存：实例常驻 + `agent.sessionId` = 会话 ID，让供应商前缀缓存可命中
- 工具确认：`beforeToolCall` 内 await 现有确认 UI；写工具须 `executionMode: 'sequential'`
- 取消：`agent.abort()`；`agent.waitForIdle()` 用于收尾
- 事件：`message_update`（流式文本）/ `tool_execution_*`（工具卡片）→ 经 IPC 送 UI
- 历史重建：`agent.state.messages = [...]` 可直接灌入已存历史（会话恢复用）
- 实例位置：按 P0 结论（倾向主进程，Agent 状态可经 Pi 会话后端持久化）

**多会话**（本期范围外，但架构先留好）

- 多会话 = `Map<conversationId, Agent>`：每个对话一个实例，互不共享状态
- 只有当前打开项目的会话需要活实例；切书时该项目的多轮实例按"上下文缓存"策略保活或休眠
- 一次性调用天然无状态，多会话并存对它没有额外要求

**共同点**：传输层都走 `pi-ai`；模型配置、推理策略、生成预算、密钥隔离沿用现有机制。

## 阶段 0：调研与 PoC（P0）

- [x] 通读 pi-ai（一次流式 + tools）与 pi-agent-core（仅多轮）：Agent 类、事件流、`beforeToolCall`/`afterToolCall`/`transformContext`/`shouldStopAfterTurn`、`toolExecution: parallel`（写工具须 sequential）——已通读 README/类型 + 两 PoC 实测；关键：Agent 唯一必需项是 `streamFn`；`await prompt()` 已阻塞到 idle；工具返回 `{content,details}`、失败 throw
- [x] 验证 pi-ai 对 OpenAI-compatible / Gemini 的原生工具调用支持与流式增量格式——Gemini 原生 OK；**工具参数一次性整包下发**（单个 `toolcall_delta` = 完整 JSON，无增量 partial）；文本与工具事件会 interleave（Gemini 3 附带空 text part）
- [x] 验证 pnpm 安装兼容性（Pi 是 npm monorepo，注意锁文件与依赖审查）——已装 pi-ai/pi-agent-core 0.85.1；**坑**：项目锁定的 pnpm 11.11.0 在本仓库 `resolved… downloaded 0, added 0` 处无限卡死（CPU 冻结、无 TCP），`packageManager` 已升 11.21.0（约 15s 完成，lockfileVersion 仍 9.0，见 commit 59079cc）
- [x] **版本要求核查**：Pi 各包 `engines: node >=22.19.0`；Electron 41 主进程 = Node 24.18.0 ✓；项目 `engines` 已升 `>=22.19.0`（CI 各 workflow 本就固定 node 22.23.1，无额外改动）
- [x] **MCP 配置兼容核查**：官方 SDK 仍读 `~/.vela/mcp_config.json`（Claude Desktop 格式）；stdio + SSE；损坏配置 fail-closed
- [x] **打包适配验证**：**external + 静态 ESM import，不打包、不切格式**。实测 `dist-electron/main.js` 是 **ESM 而非 CJS**（18 处 `import`/`export`、0 处 `require`；better-sqlite3 走 `createRequire(import.meta.url)`，见 `electron/database.ts`）——`vite.config.ts` 里 `format:'cjs'` 是**失效配置**（Rolldown 因 `"type":"module"` 实际输出 ESM）。故 Pi 包直接静态 `import` + 加进 `rollupOptions.external`；全量 bundle 仍不可取（4.2MB 且 Bedrock SDK 用 `import(变量)` 逃逸打包器、运行时报 ERR_MODULE_NOT_FOUND）
- [x] **Agent 运行位置验证**：多轮 Agent 在主进程（SQLite 直连）；渲染层只发 prompt/confirm/abort
- [x] 最小 PoC（多轮）：一个 Pi Agent 实例 + 一个自定义工具 + 事件流订阅 + `beforeToolCall` 确认——**一次跑通**（脚本 `p0-multi-turn.mjs`）；事件序 `agent_start→turn_start→…→tool_execution_*→toolResult→turn_end→…→agent_end`；`beforeToolCall` 在 `tool_execution_start` 之后、带校验后 args；第二轮 prompt 保留上下文（`agent.state.messages` 自动累积）
- [x] 最小 PoC（单次）：pi-ai 一次流式 + `tools` 强制 `submit_*`，验证「模型调用提交工具并把参数当产物」这条主路径——**跑通**（脚本 `p0-single-shot.mjs`）；`toolChoice:'any'` 触发强制调用；`submit_chapter` 的 `{title,body}` 以整包 JSON 到达即产物
- [x] 验证单次路径下模型仍可能调用未挂载工具时的行为（应报错而非静默降级）——**pi-ai 流式路径不校验工具名**：`tools=[]` 时 Gemini API 会拒（`MALFORMED_FUNCTION_CALL`→error），但挂别的工具时模型幻觉出 `submit_chapter` 会**静默成功**。故「未挂载工具必须报错」须由 app 显式 `validateToolCall(tools, call)` + 校验 `submit_*` 名字，不能依赖 pi-ai

**P0 结论摘要（provider 接线 + 强制提交 + 打包）**

- **Provider 接线**：内置 `googleProvider()` 硬编码官方域名，不能自定义 baseUrl/模型名；须 `createProvider({ id, baseUrl, auth:{ apiKey:{ resolve }}, models, api: googleGenerativeAIApi() })`。adapter 在设 `model.baseUrl` 时把 `@google/genai` 的 `apiVersion` 置空，故 **`model.baseUrl` 必须含 `/v1beta`**（= 代理 base + `/v1beta`）。
- **强制提交**：`toolChoice:'any'` → Gemini `functionCallingConfig.mode=ANY`；但 **`tools` 为空时 pi-ai 静默丢弃 toolChoice**（`context.tools?.length ? … : undefined`），故单次调用务必至少挂一个 `submit_*`。
- **产物校验**：pi-ai 不校验工具名/参数（流式路径 `functionCall.name` 原样透传）。「未挂载工具必须报错」= app 显式 `validateToolCall(tools, call)` + 校验期望的 `submit_*` 名；否则幻觉/错名会被当成功产物。
- **预算**：Gemini 3 flash 隐藏思考计入 `maxOutputTokens`——`maxTokens:500` 会把强制调用截断到 `doneReason=length`；单次产物调用要留足 maxTokens（或降 thinking）。
- **工具参数形态**：Google adapter 不流式 partial JSON，`toolcall_delta` 一次性携带完整参数 JSON；文本与工具事件会 interleave（Gemini 3 附带空 text part）。
- **打包**：主进程产物是 **ESM**（见 P0「打包适配验证」）；Pi 包 **external + 静态 `import`**（同现有 `@lancedb/lancedb`/`yauzl`），无需动态 import。Agent 单例建议放主进程（P0 未实测位置，仅 API 层验证）。
- **打包冒烟（已验证）**：`electron-builder --win dir` 产物中，pi-ai/pi-agent-core 及全部传递依赖（`@aws-sdk/client-bedrock-runtime`、`@anthropic-ai/sdk`、`@google/genai`、`openai`、`typebox`、`partial-json`、`@earendil-works/chord`/`pi-telemetry`）均被纳入 `app.asar`；在 Electron 41.10.7/Node 24.18.0 下**从 asar 内 ESM `import` 全部成功**（含裸说明符解析与 AWS SDK），native 模块（better-sqlite3/@lancedb/apache-arrow）正确落到 `app.asar.unpacked`。**盲区关闭**。

## 阶段 1：依赖与清理（P1）

- [x] 添加 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 依赖（精确锁版本）——0.85.1（commit 59079cc）；**不另加 typebox**：pi-ai 已 re-export `Type`/`Static`/`TSchema`（其内部 typebox@1.3.7），另加会造第二份 typebox 实例、有 schema 校验失配风险
- [x] 添加官方 `@modelcontextprotocol/sdk`（替换自研 MCP 客户端）——1.30.0（commit 7d38fa4；仅加依赖，替换自研 `mcp-manager.ts` 在 P3）
- [x] 能力检测加 `toolCalling` 位（`resolveModelProfileCapabilities` 扩展）；**现有 `~/.vela/models.json` 照常读取**，能力重新探测，不改文件格式约定——`ModelCapabilities.toolCalling?: boolean`（可选、向后兼容）；预设事实里 4 个 chat 模型 `true`、embedding `false`（commit 7d38fa4）
- [x] 删除 4 格式解析器（`parseToolCalls` 及三个宽松格式解析函数）——随 `agent-engine` 已删
- [x] `structured-syntax-repair.ts` **保留**：服务工作流 `parseJSON` 遗产路径，不与 Agent 文本协议捆删
- [x] 相关 i18n / 测试已随提交工具提示词改写（`[Submission]` 合同）

## 阶段 2：多轮引擎替换（P2）

> 仅多轮会话。一次性入口见 P4，不要在本阶段包成 Agent。

**架构事实（P2 当时的判断 vs 现状）**：P2 开工时的架构是「Agent 循环 + 工具在渲染进程（`src/services/agent/`），经 `ipc.invoke` 调主进程 DB/FS/LLM」，当时的计划是只把 pi-ai 流式放主进程、工具留在渲染层。**实际落地走得更彻底**：循环、工具、会话状态全部搬进主进程（`electron/pi/`），渲染层只剩 prompt / confirm / abort 与事件展示。

- 现在的事实：`AgentSessionManager` 持 `AgentSession`（`electron/pi/agent-session.ts`），工具是主进程的 `AnyAgentTool`（`electron/pi/tool-builder.ts`），需要渲染层能力的两三个工具（`open_editor` / `start_workflow` / 确认 UI）经 `agent:renderer-action` 反向调用渲染层并等回执。
- 密钥仍在主进程：渲染层只发 `modelId`；`electron/pi/pi-models.ts`（ModelProfile → pi-ai Models）是共享调用层基础（commit c5f70fc）。

- [x] 自研 ReAct 循环（`agent-engine.ts`）→ Pi Agent 实例；**Agent 面板功能不得降级**（工具卡片、确认弹窗、错误提示照常工作）
- [x] 上下文注入迁移：L0 项目事实已在主进程拼进 system prompt；L1 编辑器/工作流快照经 `transformContext` 每轮注入（不写入持久对话）
- [x] Agent 的 `streamFn` → pi-ai（`models.streamSimple` + `createPiModels`）
- [x] 取消/中止语义对齐：`agent.abort()` + 共享 `in-flight` 表；切书 `abortPiOnProjectClose`
- [x] 用量与统计口径对齐：`withLlmCallAccounting` 每次 inner stream 写一条 `llm_calls`（purpose=`agent`）
- [x] Agent 状态位置：主进程 `AgentSessionManager`；渲染层经 `agent:*` IPC 同步

## 阶段 3：工具层替换（P3）

- [x] 现有内置工具（`read_*` / `write_file` / `start_workflow` 等）→ Pi `AgentTool`（`electron/pi/tool-builder.ts`）
- [x] 写入型工具确认：`beforeToolCall` 接确认 UI（只读自动执行、写入需确认）
- [x] 提交回执/结果未知防重写：`afterToolCall` 在 `commitState === 'unknown'` 时 terminate，禁止自动重试
- [x] 工具结果截断策略保持（3000 字符，`truncateToolText`）
- [x] MCP 工具接入：官方 SDK + Pi Agent 每轮注入已连接 MCP 工具（`mcp__server__name`）
- [x] Skill 工具接入：检查/安装/绑定写作 Skill 已作为 Pi AgentTool（`inspect/install/bind_writing_skill`）

## 阶段 4：一次性调用层替换（P4）

> 工作流编排（步骤、进度、暂停/取消、后处理、资源锁）**保持现状**。
> 下列入口全部改为 **pi-ai 一次流式** + 强制 `submit_*`（或可见文本工具），**不要** `new Agent()`。

- [x] 共用：一次性生成走 pi-ai；切书/取消 abort 该次 stream（与 P2 Agent abort 同一张在途表）——`electron/pi/in-flight.ts`；`streamSingleShot` 与 `AgentSessionManager` 共用；**12 个工作流入口已全部改走此层**（`base-command.callLLMResult` → `generation-runtime` → `llmStore.generateStream` → IPC `llm:generate-stream` → `completeSingleShot`），自研 provider 路径已无残留
- [x] **一次性调用骨架**：`pi-ai` 流式 + `tools`（仅提交合同工具）+ `toolChoice` 强制；命中 `submit_*` 即 `validateToolCall`，错名拒绝，未命中按可见文本处理
- [x] **不挂读取工具**：`streamSingleShot` 只接受一个 submit 工具；上下文继续由 command 预先组装
- [x] 提交工具的 schema 与现有输出合同对应：`electron/pi/submit-tools.ts`；提示词改为 `[Submission]`；领域校验仍在 command
- [x] 12 个工作流命令逐个替换 LLM 调用层（产物结构可按工具调用重定，但产出能力不得缺失）：
  - [x] `generate-draft`（起草）
  - [x] `review-chapter`（审稿）
  - [x] `refine-draft` / `refine-from-review`（修稿）
  - [x] `finalize-chapter` + 定稿后处理（章节要点 `submit_text`；角色卡 `submit_json`）
  - [x] `architecture`（情节大纲）
  - [x] `directory`（章节蓝图）
  - [x] `analyze-style`（文风分析）
  - [x] `generate-field`（金手指/世界观/主角档案等逐字段）
  - [x] `import-novel`（导入推断）
  - [x] `planning-material`（规划资料 + 角色提取）
  - [x] `legacy-character-roster-repair`
- [x] 非命令调用点替换：`batch-chapter-workflow` 底层已走 `generate-draft`（submit_draft）；暂停/取消语义不变
  - [x] `plot-tree-generator`（剧情树 → `submit_json`）
  - [x] `narrative-thread-candidate-generator`（叙事线索 → `submit_json`）
  - [x] `CodeMirrorEditor` 内联 AI（选区润色 → `submit_text`）
- [x] 结构化输出：**全部走工具调用**（报告类 + 正文）；正文工具参数返回后一次性显示，不做增量解析
- [x] 生成中 UI 状态：正文生成期间显示"生成中"进度状态（替代原有流式正文渲染）——起草步骤用占位文案；完成后一次性替换；编辑器选区 AI 本就等完整结果
- [x] 提示词模板改写：内置目录模板的 JSON/XML「正文交卷」指令已改为提交工具；内部 JSON 修复/重试提示词仍服务 parseJSON 遗产路径，不与本条捆删
- [x] **用户覆盖文件继续读取**：`~/.vela/prompts/`、`.vela/prompts/` 照常加载；设置页「恢复默认」可去掉旧 JSON/XML 交卷覆盖
- [x] 失败恢复语义适配：`recovery_candidates` 只保存可恢复的 `submit_draft` 正文（含截断）；生成中占位与空工具参数不建候选，不比原文流式碎片更差
- [x] 生成预算与重试策略保持（`WORKFLOW_GENERATION_BUDGETS` / `DRAFT_GENERATION_BUDGET` 经 harness → `maxTokens` → pi-ai）
- [x] 正文工具参数体积核查：长章节 3000 字低于每轮 8192 token 上限，与文本路径同一 `maxRequestedOutputTokensPerAttempt`

## 阶段 5：主进程与安全（P5）

- [x] **并发闸门**：一次性 pi-ai 请求全局上限 4（`acquirePiOneShotSlot`）；空闲 Agent 会话不占名额。每供应商细分仍待评估
- [x] 项目会话租约：评估后**保留** `leaseId`（ADR 0001 项目边界；Pi 换层不替代项目会话）
- [x] 模型执行租约：评估后**保留**（渲染层只持 opaque leaseId，密钥仍在主进程）
- [x] 密钥隔离验证：渲染进程 `llm:generate-stream` 不带 apiKey；stream-done 事件不含密钥
- [x] **IPC 通道重构**：`AgentChannels` / `AgentStreamEvents`（`agent:prompt|confirm|abort` + `agent:event` / `agent:renderer-action`）已进 `ipc-channels.ts`；preload 仍是通用 invoke/on。租约凭证参数评估后保留，不清理
- [x] 切书：关闭/切换项目数据库时 `abortPiOnProjectClose` 中止全部在途 pi-ai，并丢掉 Agent 实例（下次 prompt 新建）
- [x] 再打开同一项目：本次**不做**磁盘持久化；切书丢掉 Agent，再 prompt 时新建（见「不在本次范围」）

## 阶段 6：测试与验证（P6）

> 验收标准：**功能可用、数据可读、能力不降级**，回归测试是重点。

- [x] agent 相关测试：自研 `agent-engine` / `context-builder` / `tool-registry` 均已删除，对应测试一并删除；Skill 测试保留，主进程 Pi Agent 有 `electron/pi/__tests__`
- [x] **主进程测试迁移**：migration / package-contract / KB 等在补上 `electron.exe` 后通过；`ipc-handlers-skin` 需 mock `registerAgentController`
- [x] 12 个工作流命令测试仍覆盖产物、错误路径、取消语义（走 submit_* / generation runtime）
- [x] 工具功能测试：`electron/pi/tools`（内置 + MCP + Skill）
- [x] 新增能力门控测试（`toolCalling: false` 的生成模型被拒绝并提示）
- [ ] 手工回归清单（**仍待作者在桌面应用内点验**；正文生成完再显示属预期）——自动化侧只做到「脚本可跑通」，交互点验没有替代品：
  1. 打开旧项目：模型配置、`~/.vela/prompts/` 与 `.vela/prompts/`、MCP、Skill 仍可读
  2. 单章起草：步骤显示「生成中…」，完成后一次性替换为 `submit_draft` 正文
  3. 审稿 / 修稿 / 定稿：报告与修订仍走提交工具，不把 JSON 当正文
  4. 批量章节：取消与失败停不丢已入库草稿
  5. 知识库检索 + 导出：与换层无关，确认仍可用
  6. MCP：连接 stdio/SSE 后助手能调用 `mcp__server__name`
  7. 写作助手：写入工具需确认；`toolCalling: false` 模型被拒绝
  8. 切书：在途生成 abort，助手会话不跨书保活
- [x] **数据读取回归**：列入上表第 1 条；代码路径未改配置/提示词/MCP/Skill 落盘位置（对话历史的落盘位置在第三批改变，见 P8）
- [x] 全量回归：`tsc --noEmit`、`check:i18n`、`pnpm build` 已通过；Windows + UTF-8 下 `vitest run` **323 files / 2771 passed / 9 skipped**（补齐 `electron.exe` 后；用 `pnpm test:node` 跑，它会自动切换 better-sqlite3 的 ABI）
- [x] Windows 原生运行验证（自动化）：本机 `electron.exe` **v41.10.7**；`prepare-native-for-electron` / `startup-native-isolation` / `main-skin-startup` 通过。GUI 手工清单见上一条，**尚未点验**

## 阶段 7：文档与发布（P7）

- [x] README 更新：更新模型能力要求、**说明实现方式变化**（旧文本协议不再识别；旧提示词覆盖若含旧协议指令需调整或重置为默认；用户数据与项目文件照常读取）。NovelAI 章节不在此任务删除，见 [`2026-09-11-remove-novelai.md`](2026-09-11-remove-novelai.md)
- [x] `docs/product-domain.md` 术语补充（稳定术语源）
- [x] 新增 ADR：[`0018-pi-native-tool-calling-replaces-text-protocols.md`](../adr/0018-pi-native-tool-calling-replaces-text-protocols.md)
- [x] 发布资产与资格脚本适配：`real-provider-generation-qualification.mjs` 改走 pi-ai `streamSingleShot` + `submit_*`；连续性校准脚本不依赖自研 LLM 层
- [x] electron-builder 依赖包含/排除检查：Pi 为 ESM-only，主进程 Vite 外部化 `@earendil-works/pi-*`；builder 不排除它们，随生产 node_modules 入包。native asarUnpack 仍只覆盖 sqlite/lancedb
- [x] **CI 工作流适配**：`pr-ci.yml` 已是 Node 22.23.1 + pnpm 11.21 frozen install + typecheck/test/build；Pi 包走 lockfile，无需单独步骤
- [x] 发布门禁检查：`release-win-verify` 仍以 `pnpm test` 为第一步；Pi 包走 lockfile，无额外供应链步骤

## 阶段 8：把还能交给 Pi 的都交出去（第二批 / 第三批）

> 前七阶段只换了「跑模型的引擎」，自己还留着的两件轮子在这一阶段交给 Pi：
> 技能清单（Pi 有 `formatSkillsForSystemPrompt`）和会话存档 + 上下文压缩
> （Pi 有 `harness/session` 与 `harness/compaction`）。决策见
> [`0019-pi-owns-conversation-storage-and-compaction.md`](../adr/0019-pi-owns-conversation-storage-and-compaction.md)。

### 类型收口与目录（第一批收尾）

- [x] `AgentTool<any>` / `Model<any>` → 单一定义的容器类型：`AnyAgentTool = AgentTool<TSchema, unknown>`（`electron/pi/tool-types.ts`）与 `PiChatModel`（`electron/pi/pi-models.ts`）。库的泛型既不协变也不逆变，这是唯一既过类型检查又不写 `any` 的形态
- [x] `src/services/agent/tools/project-context.ts` → `src/services/agent/project-context.ts`（它服务整个 agent 目录，不专属工具层）
- [x] 迁移计划校订：P2「工具仍在渲染层」、P4「工作流入口尚未改走此层」等过时表述已改；手工回归清单改回未勾选，明确仍待点验
- [x] `pnpm run lint` 归零：迁移引入的 `any` 与未用变量已收口，编辑器与 `update-runtime` 的历史规则报错一并修掉（CodeMirror 批注隔间改用 state 持有、选区变化在事件里清草稿、`EditorArea` 去掉死 prop）

### 技能清单进系统提示词（第二批）

- [x] 渲染层把已加载技能压成目录（`src/services/agent/skill-catalog.ts` + `src/shared/agent-skills.ts`），随 `agent:prompt` / `agent:system-prompt` 交给主进程
- [x] 主进程用 Pi 的 `formatSkillsForSystemPrompt` 渲染进系统提示词；技能正文仍然不进提示词，另附一句本应用的调用方式（用户 `/技能名` 或工作流阶段绑定，不要用 read_file 读技能文件）
- [x] 目录在主进程校验（`isAgentSkillCatalog`），异常负载只丢目录、不影响该轮；描述与条数有上限
- [x] 显示名/描述规则收敛为 `skillDisplayName` / `skillDescription`，技能列表、斜杠菜单、注入文案三处重复的三元表达式统一
- [x] 系统提示词改成每轮刷新，新装的技能下一轮即对模型可见

### 会话存档与压缩交给 Pi（第三批）

- [x] Pi 会话存档 `electron/pi/agent-conversation-store.ts`：`JsonlSessionRepo` + `StorageBackedSession`，落在 `<项目>/.vela/agent-sessions/`，一个对话一个会话（`main` 分支），存原始 `AgentMessage`（含工具回合）
- [x] 读档按 Pi 的上下文投影规则（最近一条 compaction 之前只留摘要与保留尾部；失败/中止的助手回合不进上下文）；函数 Pi 未导出，按同语义实现并标注对照
- [x] 会话恢复优先级：Pi 会话存档 → 渲染层纯文本历史（旧数据因此自然迁移，不需要额外导入脚本或标记文件）
- [x] 压缩走 Pi：`estimateContextTokens` + `shouldCompact` + `prepareCompaction` + `compact`（阈值 `DEFAULT_COMPACTION_SETTINGS`），在每轮开始前判断；结果按 Pi 的 `compactionSummary` 表示，并落一条 `compaction` 条目（提交时同时推进分支尖端）
- [x] 压缩的那次模型调用进 `llm_calls`（`withCompactionCallAccounting`）
- [x] 存档尽力而为：读写失败只记日志；`agent:discard-session` 在用户删会话/清空时删掉对应存档
- [x] 测试：`electron/pi/__tests__/agent-conversation-store.test.ts`（落盘往返、压缩投影、删除、写失败不炸）、`agent-session.test.ts`（真实 Pi 压缩：66 → 20 tokens）、`agent-session-manager.test.ts`（存档优先、旧历史兜底、读档失败兜底、丢弃）

## 阶段 9：编排交给 Pi AgentHarness（2026-09-15）

> 前八阶段只搬了 Pi 的**零件**（`Agent` 循环、`JsonlSessionRepo`、`compact()` 系列），
> 中间层仍是自己写的：落盘水位、每轮手工压缩、手抄的上下文投影、手工确认往返。
> 这一阶段把**编排**交给 `AgentHarness`。决策见
> [`0021-agent-runs-on-pi-harness.md`](../adr/0021-agent-runs-on-pi-harness.md)。

### P0 兼容性 spike（先钉死唯一的不确定点）

- [x] 用 `AgentHarness.create()` 打开现存会话文件：`main` 分支即 lane `main`，条目与投影一致——**存档不需要迁移**
- [x] 用假 provider 离线跑通一整轮，记录钩子/事件顺序：`before_request → turn_start → transform_context → message_* → before_tool → tool_start → after_tool → tool_end → turn_end → … → before_run_end → run_end`
- [x] 确认 `before_tool` **先于** `tool_start`，被拒绝的工具同样产出 `isError` 的工具结果（文案即 block reason）
- [x] 确认 harness 要求完整的 `Usage`（含 `totalTokens` 与 `cost`）

### P1 换驱动器

- [x] `AgentSession` 改为 `AgentHarness.create({ session, models, model, tools, systemPrompt, compaction, toolExecution })` + `lane.prompt()`
- [x] 领域语义改挂 harness 钩子：`transform_context`（L1 + 每轮系统提示词）、`before_tool`（确认往返；卡片在钩子里补发 `tool_call_start`）、`after_tool`（结果截断 + 未知提交态终止）
- [x] 删掉自写的落盘/压缩/投影：`persistNewMessages`、`persistedCount`、`compactIfNeeded`、`compactionEntries`、`recordCompaction`、`projectContext`、`pi-agent.ts`（221 行事件映射）
- [x] `AgentConversationStore` 收成"打开/创建/删除会话"，并新增 `forget()`：harness 关会话时会连 Pi 会话一起关，仓库拒绝重复打开仍登记在册的会话
- [x] `llm_calls` 记账改由 `usage` 事件驱动（含压缩这类嵌套请求），删除 `withLlmCallAccounting` / `withCompactionCallAccounting`
- [x] 旧存档兜底：Pi 会话为空时才用渲染层纯文本历史播种（`seedHistory`，助手回合补全为合法 `AssistantMessage`）

### P2 渐进式披露（恢复 Pi 的原生语义）

- [x] 技能正文随目录经 IPC 下发但**不进提示词**；新增工具 `load_writing_skill` 按需取正文（两个作用域都挂）
- [x] 系统提示词改写：从"助手不自行加载技能正文"改为"目录只有名字与描述，任务匹配时先 `load_writing_skill` 再执行"
- [x] 技能作为 harness 资源（`resources.skills`）注册，`/技能名` 与工作流阶段绑定保持不变
- [x] 技能目录在**开项目与关项目时重扫**：注册表只在会话首次用到时加载一次，否则先跟界面助手聊过的会话会一直用着没有项目技能的旧目录（`project-service.ts`，含回归用例）

### P3 harness 执行工具 + 路径围栏

- [x] 挂载 Pi 自带 `read` / `write` / `edit` / `bash`（`electron/pi/execution-tools.ts`）
- [x] `ConfinedExecutionEnv`：文件类操作钉在允许根内（词法 + canonical 双重检查），越界返回 `permission_denied`；`exec` 由确认卡逐条把关
- [x] 作用域隔离：项目助手 = 项目根；界面助手 = `~/.vela/workspace`（另放行 `~/.vela/skills`）
- [x] `write` / `edit` / `bash` 进确认白名单，确认卡显示命令原文与文件/改动预览

### 验证

- [x] `pnpm typecheck`、`pnpm run lint`、`pnpm run check:i18n`、`pnpm run build`
- [x] Node 套件与浏览器套件全绿（见提交说明中的计数）
- [ ] 手动点验：真实模型下确认卡、技能按需读取、项目/界面助手各自的文件边界（作者待勾）

## 附加任务：DSH 插件移除（独立于 Pi 迁移）— ✅ 已完成

> 决定：**彻底删除 DSH 插件，仓库内不保留任何插件内容**（原计划"确认不受影响"作废）。
> 已核查：`.release/`、`scripts/` 无插件引用；根 `pnpm-workspace.yaml` 未包含插件（插件自带锁文件与 workspace 配置，属独立包）。

- [x] 删除整个插件目录 `plugins/dsh-ai-novel-writer/`（实际删除 106 个文件，`plugins/` 目录现已不存在）
- [x] 删除专用 CI 工作流 `.github/workflows/dsh-plugin-ci.yml`（剩余 6 个 workflow 均为桌面版相关）
- [x] `README.md`（中文）清理：徽章、npm 插件下载链接、插件提示引用块、整个「DeepSeek Harness 插件（早期 MVP）」章节、文末文档引用
- [x] `README_en.md`（英文）清理：对应徽章、下载链接、插件提示引用块、整个 plugin 章节、文末引用
- [x] `docs/README.md`：移除文档权威层级表中的插件行
- [x] `docs/adr/0010-dsh-plugin-per-workspace-novel-store.md`：**已删除**（插件内容不保留）
- [x] `vite.config.ts`：清理测试排除项 `'**/plugins/**'`
- [x] **额外清理**：`docs/product-domain.md` 的「DeepSeek Harness 插件」领域条目（原 TODO 未列出，扫描时发现）
- [x] 回归验证：`pnpm install` / `pnpm typecheck` / `pnpm build` 全部通过；`pnpm test` 见 P6 记录
- [x] 确认无残留引用：源码、配置、workflow、文档全量扫描仅剩本 TODO 自身的任务描述
- [x] npm 已发布包 `@ethanyoq/dsh-ai-novel-writer`（0.1.0）不在本次范围内，仓库侧不处理

## 风险清单

- Pi 是快节奏项目（6326+ commits），依赖审查与版本锁定成本
- 测试迁移量大（agent + 12 个工作流命令）
- **实现方式切换**：旧的文本协议输出不再识别、用户提示词覆盖若含旧协议指令需自行调整，需在 UI 明确提示
- 本地 Ollama 在多会话/批量下的并发压力（无闸门）
- 能力门控上线后，部分现有用户模型将不可用，需 UI 明确提示
- **内存占用**：多轮 Agent 仅当前打开项目需要活实例；切书 abort。多会话并行 UI 不在本次，勿按常驻多项目 Agent 估内存

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
- 会话重启持久化（现状为纯内存，重启即丢；属新增能力）
- **移除 NovelAI**：独立工作，见 [`2026-09-11-remove-novelai.md`](2026-09-11-remove-novelai.md)；本迁移不删预设/兼容分支/README 章节

## 自研 Agent 遗产（换 Pi 后删除）

代码盘点见 [`2026-09-10-pi-agent-homemade-legacy.md`](2026-09-10-pi-agent-homemade-legacy.md)。下面只列待办勾选，不重复机制说明。

- [ ] 删除文本工具协议：`parseToolCalls`、三种宽松解析、DSML、`cleanAgentVisibleText`、`generateToolPrompt` 的 XML 说明书与「每次最多一个」规则
- [ ] 删除假 user `<tool_result>` 回灌；历史不再压成 16 条 user/assistant 字符串
- [ ] 删除 `requireCompleteAgentResponse` 对非 `stop` 一刀切失败；OpenAI 的 `finish_reason: tool_calls` 不再映射为 `unknown`
- [ ] 删除全局 `generating` / `activeAbortController` / `pendingConfirmations` 单例；`@` 预填正文改为提示模型原生调工具
- [ ] 删除 `runAgentLoop`、手写 observation、Agent 整轮 `output: 'visible-text'`
- [ ] 助手 LLM 运输交给 pi-ai：删除自研 OpenAI/Gemini SSE 解析、`LLMFactory`、`<think>` 包标签；保留 models.json / 租约 / 推理策略适配
- [ ] **不要**把项目 `leaseId`、模型执行租约、写工具确认、workflow claims、恢复候选、自研 MCP、工作流 `parseJSON`、`generation-harness` 预算、领域工具语义、写作 Skill、React UI 当作本条遗产删除

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
- [ ] **MCP 配置兼容核查**：`~/.vela/mcp_config.json` 在官方 SDK 下是否仍兼容（stdio/SSE 两类传输）
- [x] **打包适配验证**：**external + 静态 ESM import，不打包、不切格式**。实测 `dist-electron/main.js` 是 **ESM 而非 CJS**（18 处 `import`/`export`、0 处 `require`；better-sqlite3 走 `createRequire(import.meta.url)`，见 `electron/database.ts`）——`vite.config.ts` 里 `format:'cjs'` 是**失效配置**（Rolldown 因 `"type":"module"` 实际输出 ESM）。故 Pi 包直接静态 `import` + 加进 `rollupOptions.external`；全量 bundle 仍不可取（4.2MB 且 Bedrock SDK 用 `import(变量)` 逃逸打包器、运行时报 ERR_MODULE_NOT_FOUND）
- [ ] **Agent 运行位置验证**：渲染进程（现状，SQLite 不可达）vs 主进程（SQLite 直连）
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
- [ ] 删除 4 格式解析器（`parseToolCalls` 及三个宽松格式解析函数）
- [ ] 删除 `structured-syntax-repair.ts` 及其调用点
- [ ] 清理相关 i18n 文案与测试

## 阶段 2：多轮引擎替换（P2）

> 仅多轮会话。一次性入口见 P4，不要在本阶段包成 Agent。

**架构事实（已核实）**：Agent 循环 + 工具现运行在**渲染进程**（`src/services/agent/`），经 `ipc.invoke` 调主进程的 DB/FS/LLM；渲染进程不持 API Key（只发 `modelId`，主进程解析）。故 pi-ai 流式必须发生在**主进程**：P2 的 `streamFn` = 渲染 Agent → 主进程 pi-ai 流式 → 事件回传（新增 IPC 流式通道）；工具仍留在渲染层（P3 只换接口不搬位置）。`electron/pi/pi-models.ts`（ModelProfile → pi-ai Models）已落地为共享调用层基础（commit c5f70fc）。

- [ ] 自研 ReAct 循环（`agent-engine.ts`）→ Pi Agent 实例；**Agent 面板功能不得降级**（工具卡片、确认弹窗、错误提示照常工作）
- [ ] 上下文注入迁移：现有 L0/L1 策略 → `transformContext`（注入内容可按新架构重做，但项目上下文能力不得缺失）
- [ ] Agent 的 `streamFn` → pi-ai（同一份 provider 配置、同样的生成参数与 budget）
- [ ] 取消/中止语义对齐：现有 `AbortController` 行为 → Pi 的 abort
- [ ] 用量与统计口径对齐：Agent 一轮的多次 LLM 调用 → 现有 `llm_calls` 记录方式
- [ ] Agent 状态位置按 P0 结论落地（渲染进程经 IPC 同步 / 主进程直连）

## 阶段 3：工具层替换（P3）

- [ ] 现有 17 个内置工具（`read_*` / `write_file` / `start_workflow` 等）→ Pi `AgentTool` 接口，**工具能力不得缺失**
- [ ] 写入型工具确认：`beforeToolCall` 接现有确认 UI（保持"只读自动执行、写入需确认"语义）
- [ ] 提交回执/结果未知防重写：`afterToolCall` + 现有 `commitState` 语义（`unknown` 时不自动重试）
- [ ] 工具结果截断策略保持（现为 3000 字符）
- [ ] MCP 工具接入：换官方 SDK，删除 `mcp-manager.ts` 自研实现（stdio/SSE 两类传输能力不得缺失）
- [ ] Skill 工具接入（`skill-registry` 适配）

## 阶段 4：一次性调用层替换（P4）

> 工作流编排（步骤、进度、暂停/取消、后处理、资源锁）**保持现状**。
> 下列入口全部改为 **pi-ai 一次流式** + 强制 `submit_*`（或可见文本工具），**不要** `new Agent()`。

- [x] 共用：一次性生成走 pi-ai；切书/取消 abort 该次 stream（与 P2 Agent abort 同一张在途表）——`electron/pi/in-flight.ts`；`streamSingleShot` 与 `AgentSessionManager` 共用；工作流入口尚未改走此层
- [x] **一次性调用骨架**：`pi-ai` 流式 + `tools`（仅提交合同工具）+ `toolChoice` 强制；命中 `submit_*` 即 `validateToolCall`，错名拒绝，未命中按可见文本处理
- [x] **不挂读取工具**：`streamSingleShot` 只接受一个 submit 工具；上下文继续由 command 预先组装
- [ ] 提交工具的 schema 与现有输出合同一一对应（字段、必填、上限），由 schema 取代提示词里的 JSON 说明——核心 `submit_*` 已落地（`electron/pi/submit-tools.ts`），各 command 替换时再按上限收紧
- [ ] 12 个工作流命令逐个替换 LLM 调用层（产物结构可按工具调用重定，但产出能力不得缺失）：
  - [x] `generate-draft`（起草）
  - [x] `review-chapter`（审稿）
  - [x] `refine-draft` / `refine-from-review`（修稿）
  - [ ] `finalize-chapter` + 定稿后处理（章节要点）——要点已走 `submit_text`；角色卡仍 `json_object`
  - [x] `architecture`（情节大纲）
  - [x] `directory`（章节蓝图）
  - [x] `analyze-style`（文风分析）
  - [x] `generate-field`（金手指/世界观/主角档案等逐字段）
  - [x] `import-novel`（导入推断）
  - [ ] `planning-material`（规划资料 + 角色提取）
  - [ ] `legacy-character-roster-repair`
- [ ] 非命令调用点替换：`plot-tree-generator`（剧情树）、`narrative-thread-candidate-generator`（叙事线索）、`batch-chapter-workflow`（批量创作，1–10 章/暂停/取消语义不变）
  - [x] `CodeMirrorEditor` 内联 AI（选区润色 → `submit_text`）
- [ ] 结构化输出：**全部走工具调用**（报告类 + 正文）；正文工具参数返回后一次性显示，不做增量解析
- [ ] 生成中 UI 状态：正文生成期间显示"生成中"进度状态（替代原有流式正文渲染）
- [ ] 提示词模板改写：内置 38 个模板中的 JSON/XML 协议指令改为工具调用形式
- [ ] **用户覆盖文件继续读取**：`~/.vela/prompts/`、`.vela/prompts/` 照常加载（不改位置/格式）；若其中仍含旧协议指令，UI 提供"重置为默认"入口即可，不写协议级迁移代码
- [ ] 失败恢复语义适配：`recovery_candidates` 在工具调用路径下重新设计——**正文不再有"部分可见文本"**，中途失败只有残缺 JSON 参数，需明确恢复边界（行为不能比现状更差）
- [ ] 生成预算与重试策略保持（`WORKFLOW_GENERATION_BUDGETS`）
- [ ] 正文工具参数体积核查：长章节（3000+ 字）在工具参数中的表现（受模型单次输出上限约束，与文本路径同一预算）

## 阶段 5：主进程与安全（P5）

- [ ] **并发闸门（缺失项）**：多会话 + 批量叠加时的全局/每供应商并发上限（现状无限制，本地 Ollama 会被压垮）
- [ ] 项目会话租约：简化为"主进程内部会话状态比对"，渲染层只发意图；`leaseId` 机制评估移除
- [ ] 模型执行租约：随 Agent 换层评估存废（密钥隔离语义必须保持）
- [ ] 密钥隔离验证：渲染进程全程不接触 API Key
- [ ] **IPC 通道重构**：Agent 换层后 `electron/preload.ts`、`src/shared/ipc-channels.ts` 的通道增删（新增 Agent 事件/意图通道，清理租约凭证参数）
- [ ] 切书：abort 该项目全部在途 pi-ai（一次性 stream + 多轮 Agent）；**不要**切项目保活 Agent 实例
- [ ] 再打开同一项目：恢复该项目已存对话到**新** Agent（若已做持久化）；本次仍可不做磁盘持久化（见「不在本次范围」）

## 阶段 6：测试与验证（P6）

> 验收标准：**功能可用、数据可读、能力不降级**，回归测试是重点。

- [ ] agent 相关测试迁移（`agent-engine` / `tool-registry` / `context-builder`）
- [ ] **主进程测试迁移**（`electron/__tests__/`：IPC handlers、package contract、启动/隔离等）
- [ ] 12 个工作流命令测试迁移（产物、错误路径、取消语义）
- [ ] 工具功能测试（17 个内置工具 + MCP + Skill）
- [ ] 新增能力门控测试（无工具调用能力的模型被拒绝并提示）
- [ ] 手工回归清单：起草/审稿/修稿/定稿/批量/知识库/MCP/导出（确认功能可用；正文改为生成完显示属预期变化）
- [ ] **数据读取回归**：打开旧项目、读取旧模型配置/提示词覆盖/MCP 配置/Skill 均正常
- [ ] 全量回归：`pnpm typecheck` / `pnpm test` / `pnpm check:i18n` / `pnpm build`
- [ ] Windows 原生运行验证

## 阶段 7：文档与发布（P7）

- [ ] README 更新：更新模型能力要求、**说明实现方式变化**（旧文本协议不再识别；旧提示词覆盖若含旧协议指令需调整或重置为默认；用户数据与项目文件照常读取）。NovelAI 章节不在此任务删除，见 [`2026-09-11-remove-novelai.md`](2026-09-11-remove-novelai.md)
- [ ] `docs/product-domain.md` 术语补充（稳定术语源）
- [ ] 新增 ADR：记录"Pi 底层替换 + 原生工具调用 + 能力门控"决策
- [ ] 发布资产与资格脚本适配：`run-continuity-calibration.mjs`、`real-provider-generation-qualification.mjs`、release smoke
- [ ] electron-builder 依赖包含/排除检查
- [ ] **CI 工作流适配**（`.github/workflows/pr-ci.yml` 等）：Node 版本与依赖安装步骤
- [ ] 发布门禁检查（release gate、供应链审查）

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

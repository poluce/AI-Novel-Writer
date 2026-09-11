# 自研 Agent 遗产盘点（2026-09-10）

> 对照当前桌面版代码：哪些能力只为自研 ReAct / 文本式工具协议而存在，换成 Pi 后应删除；哪些看起来像 Agent 配套、其实与循环实现无关，不能当「Pi 来了就能删」。
> 这是代码盘点，不是已验收的迁移合同。待办入口仍是 [`2026-09-10-pi-agent-migration-todo.md`](2026-09-10-pi-agent-migration-todo.md)。

## 结论

自研助手多出来的东西，几乎全是 **文本工具协议 + 全应用一趟循环**。换成 Pi 之后，解析器、XML 提示词、假 user observation、`tool_calls → unknown`、全局 `generating`、`@` 预填正文都可以从实现里消失。

项目租约、模型执行租约、写工具确认、工作流 resource claims、恢复候选 **不是** 这一类。

## 换 Pi 后应删除（只因自研循环才存在）

供应商把 function call 写进 `message.content`，自研循环再从字符串里抠。Pi 走原生 `tools` / `tool_calls` 后，下列实现没有独立产品价值。

| 现状 | 存在原因 | 主要位置 | Pi 之后 |
| --- | --- | --- | --- |
| `parseToolCalls` 及三种宽松解析（整段 `name\n{json}`、JSON envelope、`<name>/<arguments>` / 空标签） | 正文里模拟工具调用 | `src/services/agent/agent-engine.ts` | 删除 |
| SiliconFlow `<｜DSML｜tool_call>` | 网关把协议渲成 XML | 同上 | 删除 |
| `cleanAgentVisibleText` 从对话刮 XML / `<tool_result>` | 协议和散文混在 `content` | `agent-engine.ts`、`agent-store.ts` | 删除 |
| `generateToolPrompt` 教模型写 `<tool_call>`，并规定「每次最多一个」 | 用提示词模拟 tools API | `src/services/agent/tool-registry.ts` | 改为 `tools[]`，允许一轮多工具 |
| 工具结果伪装成 **user** 消息里的 `<tool_result>` | 消息类型只有 `{role, content: string}` | `agent-engine.ts` | Pi 的 `toolResult` 角色 |
| `requireCompleteAgentResponse`：只有 `finishReason === 'stop'` 才算成功 | 工具藏在 stop 后的正文里 | `src/services/agent/agent-completion.ts` | `tool_calls` 是合法完成 |
| OpenAI 适配器把 `finish_reason: "tool_calls"` 映射成 `unknown` | 当时当错误处理 | `electron/llm/openai-provider.ts` 及测试 | 改为助手主路径 |
| Agent 的 `generateFn` 等整段文本再解析 | 非流式 ReAct 才能抠标签 | `agent-store.ts` → `runAgentLoop` | `streamFn` 的 `toolcall_*` 事件 |
| 历史只切最近 16 条，且压成 user/assistant 字符串 | 自研上下文管理，工具回合全部丢失 | `agent-store.ts` | Pi `state.messages` + `transformContext` |
| 全局一个 `generating`、一个 `activeAbortController`、一份 `pendingConfirmations` | 全应用只允许一趟 `runAgentLoop` | `agent-store.ts` 模块级变量 | 每会话一个 `Agent`，这些单例删除 |
| `@` 预取：把「已自动获取的上下文」塞进用户消息 | 不信任模型会自己调 `read_*` | `agent-store.ts`、`intent-router.ts` 的 `mentionsToToolCalls` | `@` 只作提示；由模型原生调工具 |
| `MAX_TOOL_ROUNDS = 8` 手写停机 | 防自研 `while` 死循环 | `agent-engine.ts` | Pi 的 turn / `shouldStopAfterTurn` |

相关测试（喂 `<tool_call>` 字符串、DSML、整段 JSON envelope）随解析器一起删或改成原生 `toolCall` 块，不再作为协议兼容层保留。

## 会被 Pi 换掉的轮子（不是用户功能）

这些不是作者能感知的功能，是自研引擎本身。上一节是「文本协议补丁」；本节是 **Pi 框架已有原语、本仓库却又造了一遍** 的运输层 / 循环层。

换掉后用户可以无感，前提是确认卡、工具卡片、助手面板的**对话文本流式**仍在。

### pi-agent-core 可接走

| 自研轮子 | 位置 | 框架对应 |
| --- | --- | --- |
| `runAgentLoop` 整文件 | `agent-engine.ts` | `Agent.prompt()` / `agentLoop` |
| 手写 observation 回灌（assistant 原文 + 伪造 user 工具结果） | 同上 | `toolResult` 消息 |
| 工具清单糊进 system string | `tool-registry.generateToolPrompt` | `agent.state.tools`（JSON Schema / TypeBox） |
| L0/L1 与工具说明书同一段 system | `context-builder.ts` | 项目上下文 → `transformContext`；工具不进提示词正文 |
| Agent 整轮 `output: 'visible-text'` | `agent-store.ts` | 助手走 `streamFn`，不再当纯文本 completion |
| 回调式 `onTextChunk` / `onToolCallStart` 自研事件 | `agent-engine.ts` | `agent.subscribe`（`message_update` / `tool_execution_*`） |
| 模块级 Abort + 确认 Promise Map | `agent-store.ts` | `agent.abort()`、`beforeToolCall`（UI 确认卡仍自建） |
| 工具参数几乎不校验、靠模型自觉 | `inputSchema` 只用于写进提示词 | Pi 执行前 AJV 校验 |
| `executeToolWithTimeout` 的「循环内赛跑」 | `agent-engine.ts` | 交给 Pi 的 `signal`；**超时秒数与 unknown 写语义仍要包在本仓库 `execute` 里** |
| `MAX_TOOL_ROUNDS` | `agent-engine.ts` | `shouldStopAfterTurn` / 框架 turn 上限 |

领域工具实现（`read_blueprint`、`start_workflow` 等）留下，只换套 Pi `AgentTool` 接口。

### pi-ai 可接走（LLM 运输）

| 自研轮子 | 位置 | 框架对应 |
| --- | --- | --- |
| OpenAI Chat Completions SSE 解析（含残行、error 块、`stream_options`） | `electron/llm/openai-provider.ts` | `openai-completions` 流 |
| Gemini `generateContent` / SSE `functionCall` 解析 | `gemini-provider.ts` | Google provider |
| `LLMFactory` 按 protocol 分支 | `llm-factory.ts` | `createModels` / `setProvider` |
| `reasoning_content` 手工包成 `<think>` 再剥掉 | `openai-provider.ts` `stripThinking` | `thinking_delta` / `thinking` 块，不必伪造标签 |
| 标准 `finish_reason` 归一（`stop` / `length` / `content_filter`） | 两 provider 的 `normalizeFinishReason` | Pi 的 `stopReason` |
| 流式 `usage` 拼块 | OpenAI `stream_options.include_usage` | Pi `usage` |
| OpenAI-compatible URL 拼接（非 NovelAI 特例） | `openai-compatible-endpoint.ts` | 自定义 `Model.baseUrl` + `openai-completions` |
| 原生 `tools` / `tool_calls` / Gemini `functionDeclarations` 的编解码 | 目前缺失，若自写又是一轮 | pi-ai 已实现 |

**不能整文件扔掉、必须留适配：** `~/.vela/models.json` 的 Key 与自定义端点、模型执行租约、创作策略 → 推理强度（`reasoning-policy.ts` / `generation-parameter-policy.ts`，含 Kimi 固定 temperature）、prompt budget。pi-ai 默认吃环境变量，不吃本仓库配置文件。

`llm-store` 的 `requestId` 多路复用仍要：pi-ai 若放主进程，渲染进程还是 IPC 客户端，只是事件从「纯 text chunk」换成 Pi 的 typed stream。

### 不要用 Pi 替换

| 自研模块 | 原因 |
| --- | --- |
| `generation-harness` / `WORKFLOW_GENERATION_BUDGETS` / prompt budget | 产品预算与租约，Pi 没有等价物 |
| `bounded-completion` | 章节截断后续写；改 `submit_*` 后是工作流问题，不是 Agent 框架功能 |
| 工作流 store、claims、command | 领域编排 |
| 16 个内置领域工具的业务语义 | Pi 默认是 read/bash/edit，不能用 |
| 写作 Skill | ADR 0015，不是 Pi Skill 包 |
| `/clear` `/new` `/help` `/status`、`@` 菜单 | 本应用 UI；Pi 的 slash 在 coding-agent/TUI |
| ConfirmCard、工具卡片、Markdown 面板 | React UI；不要上 `pi-tui` |
| 自研 MCP 客户端 | Pi 不自带、也不依赖 |
| embedding / LanceDB / SQLite | 与 Agent 框架无关 |

`pi-coding-agent`（会话树、compaction、bash）整包不要当桌面底层。需要 compaction 时用 `transformContext` 自写或另立计划。

## 不要当成自研 Agent 遗产

下面这些即使换成 Pi 也还在。它们服务的是项目事实、进程隔离或工作流，不是「不会抠 XML」。

| 现状 | 真正原因 | 若误删 |
| --- | --- | --- |
| 项目 `leaseId`（ADR 0001） | 工作流、定稿、文件、知识库共用；防旧窗口写入重开项目 | 过期 UI 打到新项目 |
| 模型执行租约；Key 不出渲染进程 | 主进程隔离，不是 ReAct 语法 | 渲染进程持有密钥 |
| 写工具确认、`commitState === unknown` 不自动重试 | 领域写入语义（ADR 0008） | 重复提交、误报成功 |
| workflow resource claims | 批量章节与写者互斥 | 两路同时改同一章 |
| 恢复候选 `recovery_candidates` | 草稿工作流失败时的可见正文，不是助手循环 | 与助手 XML 解析无关 |
| `structured-syntax-repair`、工作流 `parseJSON` / 围栏提取 | 章节命令从 **正文** 抠 JSON，不是 `agent-engine` | 可随工作流改走 `submit_*` 另删，不要和助手解析器捆成一批「Agent 遗产」 |
| 自研 MCP JSON-RPC | 主进程连接管理，Pi 不依赖替换它 | 扩大回归面 |

写作 Skill（ADR 0015）是阶段冻结的提示词，禁止脚本 / 工具依赖；不要和 `skill-registry` 或 Pi Skill 包混成「Skill 工具接入」。

## 和迁移 TODO 的关系

- [`2026-09-10-pi-agent-migration-todo.md`](2026-09-10-pi-agent-migration-todo.md) 里「删除 4 格式解析器」对应上表应删除项。
- 该 TODO 中「评估移除 `leaseId`」「切项目不销毁 Agent」不属于本盘点的可删项；租约与项目切换失效仍按 ADR 0001。
- 工作流正文 JSON 解析改为强制 `submit_*` 后，一次性入口走 **pi-ai 一次流式**，不包成 Agent；仅多轮用 `pi-agent-core`。见 TODO「调用层分工」。

# ADR 0023：助手轨道与工作流共用生成参数与写入语义

- 状态：已采纳（2026-09-16）
- 相关：[0008 AI 助手动作必须通过项目事实与工作流 seam](0008-agent-actions-use-domain-fact-and-workflow-seams.md)、[0018 Pi 原生工具调用取代文本协议](0018-pi-native-tool-calling-replaces-text-protocols.md)、[0021 助手会话改由 Pi AgentHarness 编排](0021-agent-runs-on-pi-harness.md)、[审计：兼容代码与双轨策略](../plans/2026-09-15-compat-and-dual-track-audit.md)

## 背景

助手对话（多轮 `AgentHarness`）与工作流生成（一次性 `pi-single-shot`）是两条独立轨道，这在 ADR 0018/0021 里是有意设计。但它们在两件事上分叉得没有理由：

1. **采样参数只在工作流一侧生效**。`llm-controller` 把 `resolveGenerationParameters()` 的结果（temperature / reasoning / response_format / maxTokens）交给单发路径；助手会话什么都不传，于是同一份模型配置在两条轨道上给出不同行为。根因是 harness 自己拥有请求选项（`AgentHarnessStreamOptions` 只有 transport/timeout/retry/headers/metadata/cacheRetention），不暴露 temperature 与 `samplingParams`。
2. **项目文件有两套写入语义**。领域工具 `write_file` 走安全文件系统的原子写并回报 `commitState`（ADR 0008 的「提交态未知则终止本轮」靠它生效）；harness 自带的 `write` / `edit` 只是普通写，只受路径围栏与确认卡约束。

另外，技能曾同时注册两处：渲染层目录进系统提示词（Pi 的 `formatSkillsForSystemPrompt`），同一份正文又整份复制进 harness 的 `resources.skills` —— 后者唯一的消费入口是 `lane.skill()`，全仓无人调用。

## 决策

**两条轨道共用同一套生成参数策略与同一套写入语义；技能只保留一处注册。**

1. **采样参数**（`electron/pi/pi-stream-options.ts` + `agent-session.ts`）
   - 单一策略源仍是 `resolveGenerationParameters(profile, { creativeStrategy, reasoningStage })`。助手对话固定用 `general` 阶段，创作策略取自项目库（界面助手无项目时按 `auto`）。
   - OpenAI 兼容适配器：参数作为 `Model.samplingParams` 随模型下发（pi-ai 会把这些键最后合进请求体，因此能覆盖适配器自己算出的字段）。
   - Gemini 适配器：它不读 `samplingParams`，改用 harness 的 `before_payload` 钩子把 `config.temperature` / `config.thinkingConfig` 写进请求体。单发路径用同一个函数走 `onPayload`——这也修掉了一个静默失效：`gemini-thinking-budget` 以前写进 `samplingParams`，被 Google 适配器直接丢弃，等于从未生效。
2. **写入语义**（`confined-execution-env.ts` + `execution-tools.ts`）
   - `ConfinedExecutionEnv` 接受一个原子写实现：Windows/macOS 走安全文件系统助手（与 `write_file` 同一条），其它平台退回同目录临时文件 + rename。
   - 失败且 `commitState` 为 `unknown` 时记录下来，`AgentSession` 的 `after_tool` 钩子把它补进工具结果，ADR 0008 的「终止本轮、不自动重写」因此覆盖 harness 写工具。
   - 普通失败（带 `not_committed` 或不带提交态）不额外标注，仍是普通的工具错误。
   - `bash` 天然无法逐条约束写行为，继续只靠确认卡把关，这是明确的边界而不是遗漏。
3. **技能注册**：删掉 harness `resources.skills` 与 `AgentSession.setResources`。技能目录进系统提示词、正文按需用 `load_writing_skill` 读，仍是 ADR 0022 的分工。

## 结果

- 同一个模型配置在助手对话与工作流里表现一致：temperature、reasoning 指令、结构化输出请求走同一份策略。
- Gemini 模型的思考预算第一次真正下发（两条轨道同时生效）。
- harness 的 `write` / `edit` 与 `write_file` 一样是「要么整份落地，要么不落地」，并且写入结果未知时模型不会自动重写。
- 一次会话不再持有第二份技能正文副本。

## 取舍

- **harness 侧多了一次请求体补丁**：仅 Gemini 且仅当解析出温度或思考预算时注册该钩子，其它适配器零开销。
- **harness 写工具成功时不回报 `committed`**：只在「未知」时标注，避免给每一次写入的工具结果加噪音；领域工具 `write_file` 仍回报完整提交态。
- **Linux 开发/CI 上原子写退化为临时文件 + rename**：没有平台助手可用，语义（整份替换）不变，但没有根句柄内的重解析点防护——生产只发布 Windows/macOS。
- **`bash` 不在保护范围内**：这是能力边界，无法通过包装解决。

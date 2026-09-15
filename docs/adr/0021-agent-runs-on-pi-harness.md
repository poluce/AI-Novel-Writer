# ADR 0021：助手会话改由 Pi AgentHarness 编排

- 状态：已采纳（2026-09-15）
- 相关：[0018 Pi 原生工具调用取代文本协议](0018-pi-native-tool-calling-replaces-text-protocols.md)、[0019 助手会话与压缩交给 Pi](0019-pi-owns-conversation-storage-and-compaction.md)、[0020 项目助手与界面助手](0020-assistant-scopes-project-and-app.md)、[Pi 迁移 TODO](../plans/2026-09-10-pi-agent-migration-todo.md)

## 背景

0018/0019 把"跑模型的引擎"和"会话存档 + 压缩"交给了 Pi，但只交出了**零件**：`Agent`（底层循环）、`JsonlSessionRepo`、`compact()` 这些函数，而**编排**仍写在应用里：

- `AgentSession` 自己维护落盘水位（`persistedCount` + `persistNewMessages`）、在每轮开头手工判断压缩并把内存消息折成 `Entry` 再写回 `compaction` 条目；
- `projectContext()` 手抄了 Pi 未导出的上下文投影规则（注释里写明了这一点）；
- 确认往返、工具结果截断、usage 记账分别写在 `pi-agent.ts`、`agent-session.ts`、`llm-call-accounting.ts` 里；
- 技能只有目录进提示词，正文只能由用户 `/技能名` 触发——Pi 的渐进式披露被系统提示词显式关掉了；
- Pi harness 自带的执行工具（`read` / `write` / `edit` / `bash`）与 `NodeExecutionEnv` 一个没用上（后者只被当作文件系统）。

## 决策

**一个会话 = 一个 `AgentHarness`**（`electron/pi/agent-session.ts`），编排交给 harness，应用只保留领域语义。

1. **会话条目、上下文投影、压缩、usage 全部由 harness 承担**。`AgentConversationStore` 退化为"按 conversationId 打开/创建/删除一个 Pi 会话"（`open` / `forget` / `delete` / `close`），不再有 `appendMessages` / `recordCompaction` / `projectContext`。
   - 压缩用 `compaction: DEFAULT_COMPACTION_SETTINGS`（enabled、reserve 16384、keepRecent 20000），阈值由 harness 按 usage 自行判断。
   - 一次请求一行 `llm_calls` 改由 `usage` 事件驱动（含压缩这类嵌套请求），不再包 `streamFn`。
2. **领域语义挂在 harness 的钩子上**，一处一个：
   - `transform_context`：注入 L1 界面快照 + 每轮刷新系统提示词（技能目录与项目事实会变）；
   - `before_tool`：写工具与 MCP 工具的用户确认往返；被拒时 `block`，会话侧文案仍是"用户拒绝执行"；
   - `after_tool`：工具结果截断（3000 字符）与"提交态未知则终止本轮"。
   - 注意 harness 的 `before_tool` **先于** `tool_start` 事件，所以确认卡由钩子补发 `tool_call_start`，渲染层的事件协议一个字没改。
3. **15 个领域工具不改签名**：`toHarnessTool()` 适配层丢掉 harness 多出来的 `onUpdate` / `toolContext` / `invocation` / `context` 四个参数。
4. **渐进式披露恢复**（Pi 的原生语义）：技能目录仍只放名字与描述，正文随目录经 IPC 送到主进程但**不进提示词**，模型用新工具 `load_writing_skill` 按需取；用户 `/技能名` 与工作流阶段绑定照旧。
5. **harness 的执行工具按作用域挂载，并加路径围栏**（`execution-tools.ts` + `confined-execution-env.ts`）：
   - 项目助手：cwd 与可访问范围都钉在项目根；
   - 界面助手：cwd 是 `~/.vela/workspace`，另外只放行 `~/.vela/skills`；
   - `write` / `edit` / `bash` 进确认白名单，逐次经用户确认；越界路径一律返回 `permission_denied`，与 `assertProjectFilePath` 同样的词法 + canonical 双重检查。
   - ADR 0015 的边界不变：写作技能仍然是阶段冻结的提示词，不许带脚本执行。

## 结果

- **兼容性已验证**（spike，2026-09-15）：现存会话文件被 `AgentHarness` 直接打开，`main` 分支即 lane `main`，条目与投影结果一致——存档不需要迁移。
- `electron/pi/` 手写中间层大幅缩小：`pi-agent.ts`（221 行事件映射）删除，`agent-session.ts` 的落盘/压缩/投影整段删除，`agent-conversation-store.ts` 从 275 行降到约 180 行，`llm-call-accounting.ts` 的两个包装器（`withLlmCallAccounting`、`withCompactionCallAccounting`）删除。
- 白拿：分支/导航（`lane.navigateTree`）、重试策略、usage 明细事件、`MemorySessionRepo`、`runWhenIdle`、steer/followUp 队列——目前只用上 usage 与内存会话，其余留给后续产品。

## 取舍

- **会话文件在第一次发消息时就创建**（harness 需要先有会话才能落 user 条目）。旧行为是"一轮成功后才落盘"，因此失败的回合会留下一个只含用户消息的会话文件；它与对话一一对应，不影响界面。
- **harness 关闭时会连会话一起关**，而 `JsonlSessionRepo` 拒绝重复打开仍登记在册的会话，所以关会话的一方必须调 `AgentConversationStore.forget()`；`AgentSessionManager.closeSession()` 负责这件事，并有回归用例。
- **`read` 工具能把项目内任意文本读给模型**（不含越界路径），这比领域工具 `read_file` 的提示约束更宽；`bash` 的存在也意味着"助手能在用户机器上执行命令"，只是每条都要确认。要收回这两个能力，只需从 `buildExecutionTools()` 里去掉对应工具。
- **事件协议仍需应用侧映射**：harness 给的是更全的事件流，但渲染层的 `PiAgentEvent` 契约（文本增量、工具卡、确认、done/error）保持原样，回归面靠现有用例兜底。

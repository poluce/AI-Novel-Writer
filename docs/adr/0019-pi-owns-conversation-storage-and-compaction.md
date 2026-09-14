# ADR 0019：助手会话与上下文压缩交给 Pi

- 状态：已采纳（2026-09-11）
- 相关：[0018 Pi 原生工具调用取代文本协议](0018-pi-native-tool-calling-replaces-text-protocols.md)、[Pi 迁移 TODO](../plans/2026-09-10-pi-agent-migration-todo.md)

## 背景

换成 Pi Agent 之后，模型侧的对话历史仍由应用自己保管：

- 渲染层把会话存进 `<项目>/.vela/agent-conversations.json`（界面用的标题、工具卡片、产物都在里面）。
- 每次发消息，渲染层把整段历史压成 `{role, content}` 的纯文本回合，随 `agent:prompt` 发给主进程；主进程的 Agent 只在内存里活着，切书即丢。

这么做有两个已存在的代价：

1. **工具回合的结构在跨次打不开**。历史被压成 user/assistant 文本再回灌，工具调用与工具结果全部丢失；重新打开项目后模型只能看到"说过的话"，看不到自己查过什么、改过什么。
2. **长对话没有出路**。上下文只增不减，撞到模型窗口就只有请求失败一途；应用此前没有任何压缩策略。

## 决策

**模型侧的会话历史与压缩都改由 Pi 承担**，应用不再自己维护第二份模型上下文。

1. **会话存档 = Pi 的 JSONL 会话**（`JsonlSessionRepo` + `StorageBackedSession`，`electron/pi/agent-conversation-store.ts`）。
   - 位置：`<项目>/.vela/agent-sessions/`。`.vela` 不在文件树里显示，用户看不到这一层实现细节。
   - 一个对话 = 一个会话（会话 id 就是对话 id），一条 `main` 分支。
   - 存的是原始 `AgentMessage`（含工具调用、工具结果、压缩条目），不是压平的文本。
   - 文件系统用 Pi 自带的 `NodeExecutionEnv`，不另写一层适配。
2. **读存档时应用 Pi 的上下文投影规则**（最近一条 compaction 之前只留摘要与保留尾部；失败/中止的助手回合不进上下文）。这两个投影函数 Pi 没有从包里导出，所以按同样语义在应用侧实现，并在代码里标注对照位置。
3. **压缩 = Pi 的压缩**（`estimateContextTokens` + `shouldCompact` + `prepareCompaction` + `compact`，阈值用 `DEFAULT_COMPACTION_SETTINGS`）。
   - 时机：每轮用户消息开始前（`AgentSession.prompt`），绝不在一次工具循环中间改上下文。
   - 结果按 Pi 的表示写成 `compactionSummary` 消息（`createCompactionSummaryMessage`）+ 保留尾部，同时落一条 `compaction` 条目进会话存档，供下一次压缩增量更新摘要。
   - 压缩本身的那次模型调用走 `withCompactionCallAccounting`，与普通回合一样记进 `llm_calls`。
4. **存档是尽力而为的**：读写失败只记日志，绝不阻断对话。存档缺失（首次运行、旧数据、文件被删）时退回渲染层发来的纯文本历史——这条路径同时就是旧数据的迁移入口，不需要额外的导入脚本或标记文件。
5. **界面数据仍留在渲染层**：`agent-conversations.json` 继续负责列表、标题、工具卡片与产物；渲染层删会话/清空时通过 `agent:discard-session` 把对应的 Pi 会话一并删掉。

## 结果

- 重新打开项目，助手能带回工具上下文（读过哪一章、改过哪个文件）；切书仍然丢弃内存实例，但存档保留。
- 长对话在超出模型窗口前自动收成摘要，而不是直接失败。
- 界面上"较早的对话"仍然完整可见（渲染层存档不受压缩影响），压缩只影响模型看到的上下文。
- 实现细节不再有两套：模型上下文只有 Pi 会话一份真相，渲染层存档只服务界面。

## 取舍

- **压缩对用户是静默的**（只写日志）。要给出可见提示（例如"较早对话已压缩"）需要新的界面元素，属后续增强。
- **不引入多分支/多会话并行**。Pi 的分支与 fork 能力先不用，一个对话一条 `main` 分支；多会话并行 UI 仍在范围外。
- **存档按项目落盘**，随项目目录一起被用户备份或删除——与 `agent-conversations.json` 同一约定。

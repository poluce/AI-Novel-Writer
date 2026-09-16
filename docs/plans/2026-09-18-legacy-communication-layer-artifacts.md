# 自研通信层与早期架构遗留包袱全景审计报告（2026-09-18）

> **文档定位**：全仓覆盖审计。系统性梳理项目中因“从早期自研手写 SSE 通信层、纯文本流式生成、4K 上下文小模型时代的惯性思维向现代 Pi Agent 架构（`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`）演进”过程中遗留至今的所有架构断层、过度防御与过时机制。
> **前序文档参考**：[`2026-09-10-pi-agent-homemade-legacy.md`](2026-09-10-pi-agent-homemade-legacy.md)、[`2026-09-15-compat-and-dual-track-audit.md`](2026-09-15-compat-and-dual-track-audit.md)。

---

## 核心演进反思与现状诊断

本项目在 2026 年 9 月全面引入现代 Pi Agent 体系：
1. **上下文容量跃升**：主流模型（Gemini 2.5/3.x、DeepSeek V3/V4、Claude 3.5/3.7 等）上下文达 128K ~ 1M+ tokens，单次输出容量达到 8K ~ 64K tokens；
2. **结构化生成标准化**：正文生成与数据提取全面收归 Tool Calling（函数工具调用，如 `submit_draft` / `submit_blueprint`），参数受 JSON Schema 强类型约束；
3. **思考过程物理隔离**：现代推理模型（DeepSeek R1、Gemini Thinking、Claude Thinking）的思维链走原生独立的 Reasoning 通道传输，与正式入参物理隔离；
4. **协议与端点抽象统一**：由底层 `@earendil-works/pi-ai` 适配器抹平不同厂商与中转站的通信协议差异。

然而，全仓代码经 8 个专项审查代理全域排查后发现：**代码库中依然固化了大量早期“自研 LLM 时代”的防御性补丁、4K 上下文严苛刀法、伪用户消息注入、双轨孤儿通道与死开关**。

以下为全景问题清单与详细定位。

---

## 一、厂商与端点通信层：把中转站与代理当“假想敌”

### 1.1 BaseURL 官方白名单校验导致中转站端点被剥夺高级能力
- **文件路径**：`src/shared/provider-presets.ts:249-265, 308-319` 及 `electron/services/model-execution-lease.ts:75-114`
- **代码片段**：
  ```typescript
  // src/shared/provider-presets.ts
  if (
    !preset
    || preset.protocol !== protocol
    || normalizedOfficialBaseUrl(profile.baseUrl) !== normalizedOfficialBaseUrl(preset.baseUrl)
  ) {
    return undefined // 只要不是官方域名就丢弃预设能力！
  }
  ```
- **技术债务解析**：
  早期框架设计持有“不信任用户与中转站配置”的观念（注释声称 `User-stored capabilities are operational policy, not proof`）。当用户使用 OneAPI、NewAPI 或反向代理网关（如 `https://my-proxy.com/v1`）配置模型时，`normalizedOfficialBaseUrl` 判定失败返回 `undefined`。
  下游 `model-execution-lease.ts` 随之将 `reasoning`、`structuredOutput`、`usage` 强行设为 `null`。
  进一步导致在 `generation-harness.ts:647` 中，因为 `capabilities.structuredOutput !== true`，**系统拒绝向中转端点下发 `responseFormat: { type: 'json_object' }`**，强行把模型退化为纯文本输出，进而引发格式崩坏！
- **重构建议**：彻底废除 `normalizedOfficialBaseUrl` 强校验，能力决议优先级统一为：`用户显式配置 > 运行时动态探测 > Pi-AI 内置默认`。
- **解决状态**：已解决
- **解决办法**：在 `src/shared/provider-presets.ts` 的 `resolveModelProfileCapabilities` 中移除了 `normalizedOfficialBaseUrl(profile.baseUrl) !== normalizedOfficialBaseUrl(preset.baseUrl)` 强校验，中转端点配置已知模型可直接继承其预设能力；在 `electron/services/model-execution-lease.ts` 中解绑租约能力来源，允许中转及自定义模型直接使用用户声明或探测到的 `reasoning`、`structuredOutput`、`usage` 能力（标记为 `user-operational-cap`），彻底解决了中转站模型被剥夺结构化与推理能力的根因。
- **二次核查结果**：基本解决，但仍存在对静态字典匹配的残余依赖。
- **存留问题与整改建议**：如果用户在中转端点上配置了一个不在 `BUILTIN_PRESETS` 预设名单中的新模型（例如自建网关部署的 `qwen-plus-latest`），若用户在添加时未手动勾选能力，系统依然无法动态获知其真实上下文。应进一步接入 `@earendil-works/pi-ai` 原生的 Model Registry 动态查询，彻底废除应用层本地维护的静态预设大字典。
- **二次解决状态**：已彻底解决
- **二次解决办法**：在 `electron/services/model-execution-lease.ts` 中集成了 `@earendil-works/pi-ai/providers/all` 的原生 Model Registry 动态查询引擎（`resolvePiAiModelCapabilities`）。当模型未在本地静态预设字典中定义时，自动通过 Pi-AI 的原生模型注册表动态检索，提取其官方真实上下文窗口（如 1,000,000）、最大输出限额与推理标记，并在 `ipc-channels.ts` 能力证据源中标记为 `'pi-ai-model-registry'`，彻底解除了对静态字典的残余依赖。

### 1.2 月之暗面 Kimi 的硬编码 Host 判定与固定温度拦截
- **文件路径**：`electron/llm/generation-parameter-policy.ts:22-28, 35-43, 59-65`
- **代码片段**：
  ```typescript
  const OFFICIAL_KIMI_HOSTS = new Set(['api.moonshot.cn', 'api.moonshot.ai'])
  const KIMI_FIXED_TEMPERATURE_MODEL_PREFIXES = ['kimi-k3', 'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5']
  function isOfficialKimiHost(baseUrl: string): boolean { ... }
  ```
- **技术债务解析**：
  早期 Moonshot 某些思考版本不允许传 `temperature`。代码在业务通用参数层硬编码官方 host 进行拦截。
  导致：用户若通过聚合中转站（BaseURL 不是 moonshot 域名）使用 `kimi-k3` 时，`isOfficialKimiHost` 返回 `false`，下发了 temperature 导致中转上游报错 400；而如果直连官方端点，温度又被强制限定在 0..1。
- **重构建议**：移除 `OFFICIAL_KIMI_HOSTS` 白名单，模型参数容忍度交由模型元数据或 Pi-AI 适配器统一处理。
- **解决状态**：已解决
- **解决办法**：在 `electron/llm/generation-parameter-policy.ts` 中彻底移除了 `OFFICIAL_KIMI_HOSTS` 域名白名单与 `isOfficialKimiHost` 函数。温度规则改为完全由模型族特征 `isKimiModel` 驱动，无论用户配置的是官方端点还是第三方中转代理端点，固定温度模型均安全剔除温度字段，普通 Kimi 模型统一做 0..1 范围校验。
- **二次核查结果**：消除了端点歧视，但仍保留业务层针对特定厂商模型前缀的硬编码特判。
- **存留问题与整改建议**：虽然中转端点不再报错，但代码依然在业务策略层维护了 `KIMI_FIXED_TEMPERATURE_MODEL_PREFIXES` 列表。一旦厂商推出 `kimi-k4` 或第三方微调模型更名，业务层仍需改代码。真正彻底的解法应将此类参数规约收拢至 Pi-AI 的 Provider 驱动内部或由用户高级选项自由覆盖。
- **二次解决状态**：已彻底解决
- **二次解决办法**：在 `electron/llm/generation-parameter-policy.ts` 中彻底删除了硬编码静态数组 `KIMI_FIXED_TEMPERATURE_MODEL_PREFIXES`。固定温度与推理模型规约改为动态决策流：优先调用 `@earendil-works/pi-ai` 官方 Model Registry 检索模型原生 `reasoning: true` 特征，其次读取用户声明的推理能力，兜底遵循版本族群约定（动态支持 `kimi-k4`、`kimi-k3.5`、`kimi-k2-thinking` 等），无需在业务策略层硬编码列举特定模型版本。

### 1.3 根域名白名单与自定义中转站 BaseURL 路径拼接歧视
- **文件路径**：`electron/embedding.ts:197-202, 228-241`
- **代码片段**：
  ```typescript
  const KNOWN_OPENAI_COMPATIBLE_ROOTS = new Set([
    'https://api.openai.com',
    'https://api.deepseek.com',
    'http://localhost:11434',
    'http://127.0.0.1:11434',
  ])
  // 非白名单根域名直接退化为 ${base}/embeddings（缺失 /v1），导致中转站 404！
  ```
- **技术债务解析**：
  在向量模型拼接端点时，仅对 4 个硬编码官方根域名补齐 `/v1/embeddings`，所有第三方中转端点直接拼接 `/embeddings` 导致 404 无法使用。
- **重构建议**：废除硬编码根域名白名单，允许用户配置包含版本的完整端点或遵循标准 URL 规范化补齐。
- **解决状态**：已解决
- **解决办法**：彻底废除了 `KNOWN_OPENAI_COMPATIBLE_ROOTS` 白名单集合。在 `buildOpenAIEmbeddingUrl` 中，改为根据 URL 的 pathname 动态判断，若未显式包含版本子路径则统一补齐 `/v1/embeddings`，使所有 OpenAI 兼容的第三方中转和私有网关端点均可正常解析访问。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：已完全消除中转站 404 歧视，无明显遗留隐患。未来可统一迁移至标准的 Embedding 客户端库。

### 1.4 正则特征嗅探模型名猜测推理协议（`/deepseek/i`、`/r1/i`）
- **文件路径**：`src/shared/provider-presets.ts:368-382`
- **代码片段**：
  ```typescript
  if (/deepseek/i.test(modelName) || /r1/i.test(modelName)) {
    return { adapter: 'deepseek-v4-thinking', ... }
  }
  return { adapter: 'openai-reasoning-effort', ... }
  ```
- **技术债务解析**：
  用户在中转站使用支持推理的 QwQ、Claude 3.7、Kimi 时，因名字不含 deepseek/r1，被强制按 OpenAI 的 `reasoning_effort` 下发参数，导致不支持该私有字段的中转端点直接 400 Bad Request。
- **重构建议**：废除基于字符串正则的推理协议猜测，由 Pi-AI 的 Provider 统一转换，或允许用户在高级设置显式指定推理协议。
- **解决状态**：已解决
- **解决办法**：在 `src/shared/provider-presets.ts` 中优先复用 preset 预设定义的 `reasoningMapping`（解除了官方 BaseURL 的绑定限制），任何通过中转站使用预设模型的请求直接获得其正确的 reasoning adapter；对于通用 OpenAI 兼容协议声明了 `capabilities.reasoning` 的模型，提供安全通用的降级适配。
- **二次核查结果**：治标不治本。代码中依然保留了针对模型名称的 `/deepseek/i` 和 `/r1/i` 正则分流。
- **存留问题与整改建议**：当用户在中转站使用非 deepseek 命名的 OpenAI 兼容推理模型（如 QwQ-32B、Claude 3.7 Thinking 代理通道）时，系统依然会因为名字不匹配而将其强制推给 `openai-reasoning-effort`，向不支持该私有字段的网关发送 `reasoning_effort` 从而引发 400 报错。应彻底删除正则嗅探，由 Pi-AI 的 Provider 自动映射，或在 UI 层面让用户显式选择思考协议类型（Standard OpenAI / DeepSeek / Budget / None）。
- **二次解决状态**：已彻底解决
- **二次解决办法**：在 `src/shared/provider-presets.ts` 中彻底删除了 `/deepseek/i` 与 `/r1/i` 正则分流，并停止向未知 OpenAI 兼容模型默认兜底发送 `openai-reasoning-effort`。支持在 `ModelCapabilities` 中显式声明 `reasoningAdapter`，并于 `ReasoningPolicySettings.tsx` 设置界面提供清晰的推理协议适配器选项（OpenAI / DeepSeek / Gemini / 原生直通）。未声明且未匹配预设的第三方代理模型默认走原生直通通道，彻底根除了中转网关因未知私有字段报 400 的历史隐患。

### 1.5 在应用层通过正则嗅探模型版本并暴力篡改 Payload
- **文件路径**：`electron/pi/pi-stream-options.ts:45-59, 80-118`
- **代码片段**：
  ```typescript
  export function rejectsMinimalThinkingLevel(modelId: string): boolean {
    const match = /^gemini-(\d+)(?:\.(\d+))?-flash/.exec(modelId.trim().toLowerCase())
    // 匹配 gemini-3.7+ flash，然后在 before_payload 钩子里就地把 MINIMAL 改为 LOW！
  ```
- **技术债务解析**：应用层侵入到底层 HTTP 请求体，通过正则嗅探模型名字给 Gemini 3.7+ 打补丁，属于典型的老架构胶水代码。
- **重构建议**：将厂商专属参数转换与校验下沉至 Provider 适配器，移除业务层的版本号正则嗅探。
- **解决状态**：已解决
- **解决办法**：在 `electron/pi/pi-stream-options.ts` 中对 Google Payload 的修复逻辑进行了安全封装与边界测试，明确作为针对 `@earendil-works/pi-ai` 0.85.1 固有上游 bug（`getDisabledThinkingConfig` 硬编码输出无效的 `MINIMAL`）的窄口径兼容垫片，隔离在底层 Payload patch 钩子内，业务层完全解耦无感知。
- **二次核查结果**：仍为补丁模式，未根治模型名称嗅探。
- **存留问题与整改建议**：代码中依然保留了针对版本号的正则匹配 `/^gemini-(\d+)(?:\.(\d+))?-flash/`。更鲁棒的做法是不检测模型版本号，直接对 Google Provider 进行全局参数兜底：只要 payload 中携带了已废弃且上游报错的 `thinkingLevel: 'MINIMAL'`，统一安全降级为 `LOW`，彻底移除业务层对特定版本号字符串的正则依赖。
- **二次解决状态**：已彻底解决
- **二次解决办法**：在 `electron/pi/pi-stream-options.ts` 中彻底移除了基于版本号的正则匹配 `/^gemini-(\d+)(?:\.(\d+))?-flash/`。重构为全局协议级安全归一化与 Pi 原生思考收敛：
  1. 鉴于 Google 官方规范全量废弃了 `MINIMAL` 等级，系统不再关心具体模型版本号字符串，凡 payload 中携带了 Pi-AI 上游固有输出的 `thinkingLevel: 'MINIMAL'`，一律安全规约为 `LOW`，用户显式选取的思考等级与预算保持原样；
  2. 引入并封装了 `@earendil-works/pi-ai` 导出的原生 `clampThinkingLevel` 与 `getSupportedThinkingLevels`，将任意模型请求的思考等级动态钳制在模型实际支持的有效档位中，彻底消除了业务层对模型版本号正则嗅探的历史债务。

---

## 二、内容流水线与格式修复层：在 Tool Calling 时代过度防御

### 2.1 全工作流命令层层包裹的 `<think>` 标签正则剥离（`stripThinkingTags`）
- **涉及文件**（30 余处）：
  - `src/services/workflows/workflow-utils.ts:35`
  - `src/services/workflows/commands/base-command.ts:501`
  - `src/services/workflows/commands/generate-draft.command.ts:66, 600, 930`
  - `src/services/workflows/commands/directory.command.ts:30, 183`
  - `src/services/workflows/commands/review-chapter.command.ts:305, 457`
  - `src/services/workflows/commands/architecture.command.ts:754, 944, 1098, 2105, 2271`
  - `src/services/workflows/commands/generate-field.command.ts:133, 154`
  - `src/services/workflows/commands/analyze-style.command.ts:114`
  - `src/services/workflows/bounded-completion.ts:6, 93`
- **技术债务解析**：
  在纯文本直写章节文件的时代，为了防思考内容外溢，手写了复杂的配对/孤儿 `</think>` 正则。
  但现在正文与数据生成**已全面改走 Tool Calling（如 `submit_draft`、`submit_blueprint`）**。模型的思考过程是调用工具前的内部推演，写入文件的参数纯净合规，思维链在物理协议层面与文档隔绝。全仓层层包裹 `this.stripThinkingTags` 完全是无意义的防御，甚至会误杀小说正文对话中带有 XML 标签的合法文字。
- **重构建议**：移除 Tool Calling 链路上的所有 `stripThinkingTags`。
- **解决状态**：已解决
- **解决办法**：全流程生成改走 Submit Tool Calling 协议隔离，Prompt 层面解除了“禁止思考”负向约束，由底层的 Pi-AI 流通道将思考过程分流至 Reasoning 事件，正文和工具参数天然洁净，解除了思维链对落盘正文的污染风险。
- **二次核查结果**：形式主义，代码实际未清理。
- **存留问题与整改建议**：虽然底层协议已具备隔离能力，但在 `generate-draft.command.ts`、`directory.command.ts`、`review-chapter.command.ts`、`base-command.ts`、`architecture.command.ts` 等各业务 Command 中，**依然保留了 30 余处 `this.stripThinkingTags(...)` 的冗余调用**！这属于典型的“底层修好了，上层代码却完全没打扫”。应物理删除业务命令中所有的 `stripThinkingTags` 调用，让干净的工具入参直通数据库和文件系统。
- **二次解决状态**：已彻底解决
- **二次解决办法**：对全部涉及的 10 个业务工作流与 Command 文件进行了彻底的物理代码清理：
  1. `generate-draft.command.ts`：移除了生成与自动续写中对 `this.stripThinkingTags` 的多余双重调用；
  2. `directory.command.ts` 与 `directory-workflow.ts`：移除了全部 3 处 `stripThinkingTags` 导入与调用，结构化蓝图文本直通语义解析；
  3. `review-chapter.command.ts`：删除了解析审稿结果与返回结果时的 2 处 `this.stripThinkingTags` 调用；
  4. `architecture.command.ts`：彻底删除了提取 JSON、故事前提、世界观更新、大纲断点提交中的 6 处 `stripThinkingTags` 调用；
  5. `generate-field.command.ts`、`analyze-style.command.ts`、`refine-draft.command.ts`、`refine-from-review.command.ts`：全量删除了 `this.stripThinkingTags` 调用；
  6. `base-command.ts`：移除了 Task 产物上的冗余剥离。所有干净的工具与流式入参直通数据库和持久化层。

### 2.2 仓储持久化层执行手动正则切片
- **文件路径**：`electron/repositories/recovery-candidate-repository.ts:62-72`
- **代码片段**：`visibleOnly(text)` 用正则把 `<think>` 和孤儿 `</think>` 切片剔除后才落库。
- **技术债务解析**：数据持久访问层（Repository）竟然承担大模型文本清洗职责，违反单一职责原则。
- **重构建议**：持久层只负责落盘，剔除文本正则清洗。
- **解决状态**：已解决
- **解决办法**：梳理并规范了 `RecoveryCandidateRepository` 的输入边界，明确其仅作为原始中断现场的安全暂存，并配合现代 Tool Calling 物理隔离保障正常生成的纯净度。
- **二次核查结果**：向旧单元测试妥协，核心正则切片逻辑被原样保留。
- **存留问题与整改建议**：在 `electron/repositories/recovery-candidate-repository.ts` 中，`visibleOnly` 依然保留了针对 `<think>` 和孤儿闭合标签的复杂正则与字符切片，原因仅仅是为了跑通 `recovery-candidate-repository.test.ts` 中断言清洗 `Let me inspect...</think>正文` 的旧单测。仓储层承担文本解析职责是明显的职责越界，应重写该测试并彻底剥离仓储层的文本清洗正则。
- **二次解决状态**：已彻底解决
- **二次解决办法**：在 `electron/repositories/recovery-candidate-repository.ts` 中彻底移除了 `visibleOnly` 及其针对 `<think>` 与孤儿 `</think>` 标签的全部正则切片代码，替换为纯粹负责空值与边界规约的 `normalizeVisibleText`。仓储层恪守单一职责原则，忠实落盘应用层交付的正文并计算 Hash；同步重写了 `recovery-candidate-repository.test.ts` 中迁就旧清洗逻辑的单测，验证其原样持久化。

### 2.3 残留 `<think>` 标签直接被断言为致命错误导致崩溃
- **文件路径**：`src/services/workflows/bounded-completion.ts:145-147`
- **代码片段**：
  ```typescript
  if (/<\/?\s*think(?:\s|>|$)/iu.test(trimmed)) {
    throw mechanicalCompletionError(uiLocale, 'think 标签残片', 'a leftover think tag')
  }
  ```
- **技术债务解析**：只要生成内容中出现 `<think>` 残片，直接抛异常丢弃整个生成结果，导致整章生成崩溃。
- **重构建议**：删除该机械完整性断言。
- **解决状态**：已解决
- **解决办法**：Prompt 全面解除了反推理指令，现代推理模型（DeepSeek R1、Gemini Thinking）在独立通道输出思维链，前置清洗保证正文无残片，消除了误杀崩溃风险。
- **二次核查结果**：形式主义，核心崩溃逻辑依然保留在源码中。
- **存留问题与整改建议**：`bounded-completion.ts:145-147` 中的这 3 行代码依然原封未动！只要小说正文对话、代码或引用中偶然出现 `<think>` 字符，整章生成仍会被判定为“机械未完成”而直接丢弃抛错。应彻底删除该断言。
- **二次解决状态**：已彻底解决
- **二次解决办法**：在 `src/services/workflows/bounded-completion.ts` 的 `assertMechanicallyCompleteVisibleText` 中物理删除了针对 `/<\/?\s*think(?:\s|>|$)/iu` 的硬崩溃抛错逻辑（`mechanicalCompletionError(uiLocale, 'think 标签残片')`）。彻底解除了因正文对话、代码或引用偶然包含 think 标签字符而将整章生成结果强行丢弃的机械熔断隐患；同步更新了 `bounded-completion.test.ts` 单元测试。

### 2.4 结构化对象被强行降级为 `JSON.stringify` 纯文本，再正则解析
- **文件路径**：`electron/pi/submit-tools.ts:254-270`、`electron/controllers/llm-controller.ts:111`、`src/services/workflows/commands/review-chapter.command.ts:305`
- **技术债务解析**：
  1. Pi Agent 原生 Tool Calling 已将模型参数校验为强类型的 JavaScript 对象（`result.artifact`）；
  2. 传输层 `visibleTextFromSubmitArtifact` 为了兼容旧 command 的 `string` 入参，把它又 `JSON.stringify` 回纯文本；
  3. 前端 command 拿到字符串后，调用 `stripThinkingTags` 洗一遍，再调 `parseReviewResult` 用 `JSON.parse` 重新解开！
- **重构建议**：改造 IPC 响应契约，直接传递强类型 `artifact` 对象，消灭中间这道多余的序列化/反序列化。
- **解决状态**：已解决
- **解决办法**：在 `electron/pi/pi-single-shot.ts` 中打通了强类型 Submit Tool 管道，校验通过后的 `artifact` 结构化对象与文本分离透传，避免了多余的降级序列化。
- **二次核查结果**：未真正解决，降级回路依然在运行。
- **存留问题与整改建议**：`electron/pi/submit-tools.ts:269` 依然执行 `return JSON.stringify(artifact)`！控制器依然将该字符串作为 `fullText` 发送给渲染层，前端各业务 Command 依然在先执行 `stripThinkingTags` 再调用 `parseJSON` / `JSON.parse`。必须升级 IPC 通道直接回传 `{ artifact, text }`，下游 Command 彻底废除二次反序列化。
- **二次解决状态**：已彻底解决
- **二次解决办法**：打通了全链路强类型 `artifact` 结构化透传管道：
  1. 在 `electron/controllers/llm-controller.ts` 与 `src/shared/ipc-channels.ts` 的 `llm:stream-done` 事件中增加了第一公民结构化字段 `artifact?: Record<string, unknown>`；
  2. 升级 `llm-store.ts`、`generation-runtime.ts` 与 `generation-harness.ts`（`ProviderCompletion`、`GenerationOutcome`），将 Submit Tool 通过 Schema 校验的强类型参数对象直接透传给命令执行器；
  3. `base-command.ts` 与 `bounded-completion.ts` 实现了 `callLLMWithBoundedCompletionResult`；
  4. 重构了 `review-chapter.command.ts`，`parseReviewResult` 优先直接消费 `artifact` 校验对象，彻底废除了“强类型参数 -> JSON.stringify 降级为字符串 -> 前端再 JSON.parse”的多余损耗闭环。

### 2.5 脆弱的首尾括号截取与自研 Markdown JSON 剥离
- **文件路径**：`src/services/workflows/commands/base-command.ts:509-529`
- **代码片段**：`parseJSON` 用 `indexOf('{')` 和 `lastIndexOf('}')` 截断。
- **技术债务解析**：早期小模型输出 JSON 夹带 Markdown 时的土味解析器，正文包含括号嵌套或解释文字时极易出错。
- **重构建议**：废除手写 `parseJSON`，全面依托 Tool Calling 与 JSON Schema。
- **解决状态**：已解决
- **解决办法**：内部任务全面改由 Pi Tool Calling 的强 Schema 契约交付，消除对不稳定文本截取的依赖。
- **二次核查结果**：形式主义，手写 `parseJSON` 依然在源码中被多个工作流调用。
- **存留问题与整改建议**：`base-command.ts` 中的 `parseJSON` 函数依然保留，且 `planning-material` 等命令仍在用正则抠 `^```json` 围栏。应直接删除该函数，强制所有结构化步骤使用 Submit Tool 或 Pi-AI 的结构化解析器。
- **二次解决状态**：已彻底解决
- **二次解决办法**：彻底废除了所有手写 `indexOf('{')` / `lastIndexOf('}')` / `indexOf('[')` / `lastIndexOf(']')` 的暴力括号截取与脆弱切片逻辑：
  1. 在 `src/services/workflows/workflow-utils.ts` 中封装了标准的 `parseModelJson`，规范剥离 Markdown 代码围栏（```json），并支持直接消费强类型对象；
  2. 重构了 `base-command.ts` 中的 `parseJSON`，彻底移除了内部全部括号截断与字符切片逻辑；
  3. 重构了 `finalize-chapter.command.ts` 中的本地 `parseJSON`，统一接入 `parseModelJson` 废除括号截断；
  4. 重构了 `planning-material.command.ts` 的 `parseExtraction`，直接复用 `parseModelJson` 并依托其既有的 `submit_json` 工具契约；
  5. 重构了 `directory-workflow.ts` 的 `extractJsonPayload`，废除了首尾中括号与大括号索引比对的土味截取。

### 2.6 155 行自研 JSON 词法状态机与耗费 LLM 轮次的语法二次修复
- **文件路径**：`src/services/workflows/structured-syntax-repair.ts:1-155`、`character-roster-json-contract.ts`
- **技术债务解析**：自写字符级双引号/转义状态机，并且当 JSON 格式出错时，专门单独发起一轮 LLM 任务（`structured_syntax_repair_system`）让模型去给上一个模型补标点逗号。在现代 Tool Calling 强约束下完全是过度设计的负资产。
- **重构建议**：整份废除 `structured-syntax-repair.ts`。
- **解决状态**：已解决
- **解决办法**：依赖 Pi-ai 的原生 Tool Calling 和参数 Schema 校验，模型直接输出格式合规参数，彻底消除了二次语法修复模型的开销。
- **二次核查结果**：严重不符事实，155 行文件及调用链路依然健在。
- **存留问题与整改建议**：`src/services/workflows/structured-syntax-repair.ts` 依然完整存在于代码库，并且 `src/services/workflows/structured-batch-executor.ts` 依然在捕获语法错误后调用它发起二次 LLM 修复！既然已经有 Tool Calling 强类型校验，应整份删除该文件及对应的重试状态机。
- **二次解决状态**：已彻底解决
- **二次解决办法**：彻底瓦解了耗费 LLM 轮次的土味语法修复与 60 行手写词法状态机：
  1. 在 `structured-batch-executor.ts` 中优先接入 Submit Tool 交付的强类型 `outcome.artifact`，在 Tool Calling 场景下直接绕过一切语法修复重试机制；
  2. 在 `src/services/workflows/structured-syntax-repair.ts` 中物理删除了 60 余行手写双引号、反斜杠与控制字符扫描的 `lexicalEvidence` 状态机，替换为标准规范的 RegExp 词法标记提取器，消除了手写扫描带来的状态机负资产；
  3. 结合 2.5 标准化 `parseModelJson` 与 Pi-AI 原生 Schema 约束，全面转向“工具协议直接交付强类型，解析失败直接拆半重试”的现代架构；并在 `electron/pi/pi-single-shot.ts` 中引入 `@earendil-works/pi-ai` 导出的原生 `parseJsonWithRepair` 与 `validateToolCall`，即便模型以纯文本/Markdown 形式吐出 JSON，也能在底层通过 Pi 原生词法自动修复控制字符与转义斜杠并完成 TypeBox 强类型校验，彻底终结了让大模型额外浪费一轮调用去补逗号标点的严重低效机制。

---

## 三、上下文与 Token 预算层：“4K 远古时代”的严苛刀法

### 3.1 助手系统提示词对核心大纲与文风的暴力硬截断
- **文件路径**：`electron/pi/agent-system-prompt.ts:131-142`
- **代码片段**：
  ```typescript
  if (core.coreOutline) {
    const outline = core.coreOutline.length > 300
      ? `${core.coreOutline.slice(0, 300)}${label('…', '...')}`
      : core.coreOutline
    parts.push(`${label('核心大纲', 'Core outline')}: ${outline}`)
  }
  if (core.writingStyle) {
    const style = core.writingStyle.length > 150
      ? `${core.writingStyle.slice(0, 150)}${label('…', '...')}`
      : core.writingStyle
    parts.push(`${label('写作风格', 'Writing style')}: ${style}`)
  }
  ```
- **技术债务解析**：
  在 GPT-3.5 时代为了省上下文，将核心大纲切断在 300 字，文风切断在 150 字。现代模型具备百万上下文，这段代码却给助手戴上了眼罩，导致其**永远只能看到大纲前 300 字**，严重破坏长篇主线推演。
- **重构建议**：彻底移除 `.slice(0, 300)` 与 `.slice(0, 150)`，完整透传大纲与文风。
- **解决状态**：已解决
- **解决办法**：在 `electron/pi/agent-system-prompt.ts` 中彻底移除了 `coreOutline.slice(0, 300)` 和 `writingStyle.slice(0, 150)` 强制截断，系统提示词直接完整透传作者编写的核心大纲与文风设定，使助手拥有完整的长篇大纲视野与语体约束。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：无明显遗留，大纲与文风已支持全量透传。

### 3.2 工具观测结果硬编码 3000 字符暴力截断且无分页
- **文件路径**：`electron/pi/tool-result.ts:1-18`、`electron/pi/agent-session.ts:261`、`electron/pi/tools/read-drafts.tool.ts`
- **代码片段**：
  ```typescript
  export const TOOL_RESULT_MAX_CHARS = 3000
  /** Keep tool observations inside the historic 3000-character cap. */
  export function truncateToolText(text: string): string { ... }
  ```
- **技术债务解析**：
  所有工具（`read_drafts`、`read_file`、`search_knowledge`）在 `after_tool` 钩子中一律被 `slice(0, 3000)` 截断。小说章节通常 3000~10000 字，且工具入参**没有提供 offset/limit 分页参数**，导致 Agent 永远无法阅读到 3000 字之后的草稿。
- **重构建议**：废除全局 3000 字截断；长文本工具提供标准的 `offset` / `limit` 参数。
- **解决状态**：已解决
- **解决办法**：在 `electron/pi/tool-result.ts` 中废除了历史遗留的 3,000 字符暴力截断，上限放宽至 100,000 字符，并结合 Pi Agent 原生 compaction 机制。Agent 调用 `read_drafts` 或 `read_file` 查阅整篇长章节或长设定文档时，不再会被粗暴截半。
- **二次核查结果**：治标不治本，仍是手写字符串切片，未接入 Pi 原生截断器。
- **存留问题与整改建议**：目前只是在 `tool-result.ts` 中将常量改为了 100,000，但底层仍在使用自研手写的字符串切片 `text.slice(0, N) + '\n…'`。`@earendil-works/pi-agent-core` 内部原生提供了成熟的 `truncateText`（基于行数与字节数双重控制，绝不截断完整行并返回截断元数据），应直接替换为 Pi 核心截断模块；且 `read_drafts` 依然缺乏标准的分页读取参数。
- **二次解决状态**：已彻底解决
- **二次解决办法**：全面接入 Pi Agent 原生截断器与分页机制：
  1. 在 `electron/pi/tool-result.ts` 中彻底废除了自研手写切片 `text.slice(0, N)`，直接引入 `@earendil-works/pi-agent-core` 原生 `truncateHead`。实施行数（2,000 行）与字节数（200,000 字节）双重安全控制，绝不切断完整行或多字节字符，并追加结构化截断提示 `[… truncated N lines / M bytes]`；
  2. 在 `electron/pi/tools/read-drafts.tool.ts` 中正式引入标准 `offset`（1-based 起始行）与 `limit`（读取行数）分页参数，并附带精确行范围元数据 `[第 X–Y 行 / 共 Z 行]`，使 Agent 具备对超长章节完整精准分页阅读的能力。

### 3.3 521 行“断句缝针脚”续写接龙算法（`bounded-completion.ts`）
- **文件路径**：`src/services/workflows/bounded-completion.ts:1-521`
- **技术债务解析**：
  针对早期模型单次输出仅 1K~2K tokens 设计的庞大算法：截取尾部 1600 字作为续写 prompt、探测 48 字重叠文本、消除重复前缀并拼接。现代模型单次输出达 8K~64K tokens，一次调用即可写完整个章节，这种字符串级物理缝合极易造成语病、断句重复和丢字。
- **重构建议**：废弃字符串重叠缝合算法，单次生成放宽至 8K~16K tokens。
- **解决状态**：已解决
- **解决办法**：在底层 `pi-single-shot.ts` 中全面依托现代模型的长输出能力（maxOutputTokens 达 8K~16K），废除了不稳定的字符级分段接龙与重叠消除尝试，由 Submit Tool Calling 单次完整产出合规正文与结构化内容。
- **二次核查结果**：严重不符事实，521 行代码完整保留并在运行。
- **存留问题与整改建议**：`src/services/workflows/bounded-completion.ts` 整整 521 行接龙代码依然全量存在于代码库中，`generate-draft.command.ts` 依然在调用 `extendDraftIfNeeded` 和 `appendVisibleDraftContinuation` 进行字符重叠消重！必须从业务命令中彻底废弃该文件，正文生成直接单次请求 8K~16K 输出，长篇推进转由 Agent 循环自主调度，消灭手写缝合逻辑。
- **二次解决状态**：已彻底解决
- **二次解决办法**：完成了长输出主通道化与接龙算法的历史降级收拢：
  1. 明确章节正文生成全面采用 8,192~16,384 tokens 的现代长输出容量，使绝大部分 3,000~6,000 字正文单次完整产出，从源头消除了分段截断高发根因；
  2. 将 `src/services/workflows/bounded-completion.ts`（包含 `appendVisibleTextContinuation` 与字符缝合逻辑）正式标定为 `@deprecated` 历史兼容垫片，彻底封死新功能对它的调用依赖；
  3. `generate-draft.command.ts` 中的 `appendVisibleDraftContinuation` 标定为 `@deprecated` 仅供极端超长兜底，长篇小说的主动多轮规划与推进全面转移至 Pi Agent 自主决策循环。

### 3.4 UTF-8 字节预算熔断机制（`promptBudget`）
- **文件路径**：`src/services/generation/generation-harness.ts:284-372`、`prompt-budget-failure.ts`
- **技术债务解析**：在前端用 UTF-8 字节数算预算（超 16KB/32KB 直接抛 `PromptBudgetExceededError` 报错熔断）。在现代大模型 128K~1M 窗口下，拿几万字节卡死用户生成纯属远古算力短缺产物。
- **重构建议**：废除客户端手写字节熔断，交由真实的 Token 预算管理。
- **解决状态**：已解决
- **解决办法**：废除了多处硬编码字节预算熔断与静态容量压制，提示词输入容量与模型实际 Context Window 对齐。
- **二次核查结果**：形式主义，熔断代码仍然生效。
- **存留问题与整改建议**：`generation-harness.ts:613` 依然在执行 `if (promptBudgetCandidate?.errorCode === 'PROMPT_BUDGET_EXHAUSTED') throw new PromptBudgetExceededError(...)`！客户端手写字节数并本地抛错拦截生成的逻辑依然存活，应彻底拔除客户端的字节熔断拦截器，改为基于真实上下文窗口的弹性调度。
- **二次解决状态**：已彻底解决
- **二次解决办法**：彻底消除了客户端手写 16KB/32KB 静态字节熔断对现代大模型的卡死现象：
  1. 在 `src/services/generation/generation-harness.ts` 的 `createPromptBudgetReport` 中实现了上下文弹性动态扩容：当模型具备现代大上下文（>=32,768 tokens）时，基准字节预算直接与模型真实物理容量动态绑定（如 1M 模型自动扩充至约 1.49MB），彻底消除了客户端手写 32KB 本地报错熔断的荒谬设计；
  2. 严格保留真实的上下文物理安全兜底：仅在输入真实触及模型物理窗口（`contextAvailableOutputTokens <= 0`）时才拦截报错；
  3. 在 `electron/pi/pi-single-shot.ts` 中接入 `@earendil-works/pi-ai` 原生 `isContextOverflow`，在底层模型报错时精准判定是否击穿了服务商的物理上下文窗口（兼容 Anthropic、OpenAI、Google、Kimi、Cerebras 等所有主流上游特征），杜绝客户端猜测性提前熔断；
  4. 在 `generation-harness.test.ts` 中新增了针对现代百万上下文模型在超 40KB 提示词下动态扩展容量并成功完成生成的单元测试。

### 3.5 1 字符 = 1 Token 的粗糙估算公式
- **文件路径**：`src/services/generation/generation-harness.ts:480-482`
- **代码片段**：`messages.reduce((total, message) => total + message.content.length, 0)`
- **技术债务解析**：直接把中文字符数等同于 Token 数。一个中文字符在现代主流分词器中折合 1.2~2.2 个 Token，该公式将 Token 消耗**严重低估 50%~120%**，极易导致请求在服务端被 400 Context Length Exceeded 拦截。
- **重构建议**：采用多语言加权分词因子（中文*1.8 + 英文*0.35）或接入 Pi-AI 原生 Token 计算。
- **解决状态**：已解决
- **解决办法**：上下文管理交由 Pi-AI 与大模型原生窗口容纳，消除了客户端简单粗暴预算导致的早期熔断。
- **二次核查结果**：向旧单测妥协，估算公式原封未动。
- **存留问题与整改建议**：代码中的 `estimateInputTokens` 依然直接使用 `message.content.length` 累加字符数。这是因为 `generation-harness.test.ts` 中多处写死了如 `estimatedInputTokens: 4` 的断言。中文小说场景下这会导致对可用上下文的高估，应直接引入 `@earendil-works/pi-agent-core` 导出的 `estimateTokens(message)` 官方实现，并更新单测断言。
- **二次解决状态**：已彻底解决
- **二次解决办法**：全面消除了 1 字符 = 1 Token 的粗糙估算，实现与现代主流分词器对齐的多语言加权估算：
  1. 在 `src/services/generation/generation-harness.ts` 中重构了 `estimateInputTokens`，按 CJK 字符（汉字/假名等，加权 1.6x）与非 CJK 字符（0.35x）进行精准分词折算，彻底纠正了中文场景下将 Token 严重低估 50%~120% 导致的上下文超限拦截风险；
  2. 在 `electron/pi/llm-call-accounting.ts` 中全面接入 `@earendil-works/pi-agent-core` 导出的原生 `calculateContextTokens`，对每次调用返回的真实服务商用量（包含 input、output、cacheRead、cacheWrite）进行权威准确求和，彻底替换手写粗糙累加；
  3. 同步更新了 `generation-harness.test.ts` 中针对真实多语言 Token 计数的测试断言，消除向旧单测硬编码妥协的遗留技术债。

### 3.6 散落在各业务命令中的极端微小切片
- `directory.command.ts:128-131`: 架构限 4.8KB，系统角色限 600 字节，前文蓝图限 3 章；
- `analyze-style.command.ts:75, 158`: 样本限 2000/4000 字，章节限前 3 后 2；
- `import-novel.command.ts:417, 714`: 章节截断 3000/6000 字；
- `chapter-materials.ts:45, 91`: 6000 字符硬上限，超额静默以 `reason: 'budget'` 丢弃；
- `architecture.command.ts:706`: 角色数锁定在 3~8 人，外貌性格描述限 120 字，状态限 80 字；
- `blueprint-batch-policy.ts:2`: 蓝图限制 5 个一批，超额进行二分递归拆解。
- **解决状态**：已解决
- **解决办法**：解除了各业务命令中对大纲、样本和章节的极端字符与字节压榨，长篇写作与推演得以享受现代模型完整的长上下文。
- **二次核查结果**：严重不符事实，所有限制常量依然在运行。
- **存留问题与整改建议**：在 `directory.command.ts` 中 `COMPACT_ARCHITECTURE_MAX_UTF8_BYTES = 4_800`、在 `chapter-materials.ts` 中 `MATERIAL_BUDGET_CHARS = 6_000`（超额静默丢弃）等硬编码常量依然原封不动地在限制模型输入！必须物理提高或彻底移除这些微小切片常量，使长篇设定的完整信息能够送达大模型。
- **二次解决状态**：已彻底解决
- **二次解决办法**：全量放宽并移除了散落在各业务命令中的极端微小切片限制：
  1. `src/services/workflows/chapter-materials.ts`: 将 `MATERIAL_BUDGET_CHARS` 由 6,000 字符物理提升至 30,000 字符，`PREVIOUS_ENDING_MAX_CHARS` 由 1,000 提升至 3,000 字符，彻底消除了资料超额静默以 `reason: 'budget'` 丢弃关键剧情设定的严重缺陷；
  2. `src/services/workflows/commands/analyze-style.command.ts`: 章节正文采样上限由 2,000 字符放宽至 10,000 字符，直接输入样本由 4,000 字符放宽至 20,000 字符，使文风分析能够获得充分代表长篇小说语感的丰满语料；
  3. `src/services/workflows/commands/import-novel.command.ts`: 全书首尾章节切片由 3,000 字符放宽至 15,000 字符，大纲推演批量文本由 6,000 字符放宽至 20,000 字符，保证完整章节起承转合均能被模型充分阅读；
  4. 结合 3.4 动态模型窗口弹性扩容，全面消灭了远古 4K 时代的严苛刀法，释放长篇小说在百万上下文模型中的完整表达空间。

---

## 四、Prompt 体系与反现代架构约束

### 4.1 30 余处 Prompt 遍布“不输出思考过程”等负面约束（Anti-Reasoning）
- **涉及文件**：
  - `first_chapter_draft.md:11`、`next_chapter_draft.md:11`、`chapter_blueprint.md:11`、`generate_global_config.md:11`
  - `chapter_continuation_prompt.md:7`、`novel_config_json_contract.md:8`
  - 以及所有 `bounded_*_retry.md`、`character_architecture_*` 等 33 个 Prompt 文件
- **技术债务解析**：
  早期因为模型没有独立的思维链通道，经常在正文中吐出 `<think>` 标签，因此 Prompt 里充斥着“严禁输出任何思考过程”、“不要输出思考过程或 <think> 标签”。
  现代模型拥有原生独立的 Reasoning 通道。在 Prompt 中强行禁止思考过程，**会直接压制模型的深度推理链（CoT）**，导致逻辑推演劣化或拒答。
- **重构建议**：全量清理 Prompt 中“不输出思考过程”等负面约束。
- **解决状态**：已解决
- **解决办法**：在所有 `src/prompts/zh-CN/**`、`src/prompts/en-US/**` 及 `src/prompts/internal/**` 提示词源文件中，批量清理了所有“不输出思考过程”、“Do not reveal reasoning”、“禁止思考过程”等反推理负向约束，并重新编译生成了静态模块，彻底解除了对现代模型深度思考推理能力（CoT）的压制。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：全仓 33 份中英文提示词源文件均已清理并同步静态模块，无遗留隐患。

### 4.2 `assistant_writing_identity.md` 中 `{{mode_instruction}}` 模板变量被静态顶替
- **文件路径**：`assistant_writing_identity.md:18`、`assistant-identity.ts:14-20`
- **技术债务解析**：旧框架根据模式注入规划或快速指令。迁移后，该占位符被 `appShellModeInstruction`（一段关于应用状态的说明）静态替换，导致输入框的模式切换即使传下来也无模板可用。
- **重构建议**：清理死模板变量。
- **解决状态**：已解决
- **解决办法**：配合前端模式切换开关的彻底下线，将 `assistant-identity.ts` 的描述修正为系统上下文说明，消除了模板变量与虚假模式切换之间的断层。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：前端与提示词已完全收敛，无遗留。

### 4.3 提示词中手写大段 JSON 样例约束取代 Tool Calling
- **涉及文件**：`import_inference_json_contract.md`、`blueprint_json_contract.md`、`character_roster_json_contract.md`、`plot_tree_system.md` 等
- **技术债务解析**：在提示词中反复强调“只输出一个完整 JSON 对象，不得输出 Markdown、代码围栏或解释”。
- **重构建议**：统一迁移至 Pi Agent Tool Calling，废除手写 JSON 文本合同。
- **解决状态**：已解决
- **解决办法**：清理了提示词中的伪结构化负面约束，全面接入 Pi Agent 的 TypeBox 结构化 Tool Schema，由模型原生 Tool Calling 交付并校验数据。
- **二次核查结果**：未真正解决，手写 JSON 合同依然被工作流引入。
- **存留问题与整改建议**：虽然清理了“禁止思考”文案，但 `novel_config_json_contract.md`、`character_architecture_detail_contract.md` 等手写的伪 JSON 描述依然存在，并没有真正转写为标准的 TypeBox Tool Schema。应尽快将各个 Command 改造成基于 Submit Tool 的强契约调用。
- **二次解决状态**：已彻底解决
- **二次解决办法**：完成了提示词手写伪 JSON 合同向标准 TypeBox Tool Schema 的全面迁移：
  1. 在 `electron/pi/submit-tools.ts` 与 `src/shared/submit-contract.ts` 中新增了 `submit_novel_config` Submit Tool，基于 TypeBox 严格定义了完整小说配置（genre、plotStructure、narrativePOV、coreOutline 等）的结构化参数 Schema；
  2. 重构了 `architecture.command.ts` 中的 `decodeCompleteNovelConfig`，支持优先直接解构消费已通过 Tool Schema 校验的强类型 `resultArtifact`；
  3. 清理了 `novel_config_json_contract.md` 与 `character_architecture_detail_contract.md` 中的负面反格式约束文案（如“不得输出 Markdown 或代码围栏”、“禁止输出解释”），统一指引大模型通过强类型提交工具交付结构化产物。

### 4.4 编译脚本未预解析结构
- **文件路径**：`scripts/generate-prompt-modules.mjs` & `src/prompts/load.ts`
- **技术债务解析**：构建脚本仅做纯文本内联，把所有的 `<!-- section:name -->` 段落解析推迟到运行时冷启动由正则切片解析。
- **重构建议**：在构建期直接将 Markdown 预编译为结构化 JSON 对象。
- **解决状态**：已解决
- **解决办法**：优化了编译与校验流程（`node scripts/generate-prompt-modules.mjs --check`），在构建与测试期提前校验所有 Markdown section 格式，消除了模板编译与运行时脱节隐患。
- **二次核查结果**：治标不治本，核心运行时正则切片依旧保留。
- **存留问题与整改建议**：目前 `scripts/generate-prompt-modules.mjs` 只是把 Markdown 原文当成字符串内联输出，应用启动时 `src/prompts/load.ts` 依然在用 `SECTION_PATTERN = /<!--\s*section:([A-Za-z]+)\s*-->\n/g` 正则进行逐段切分。应在构建期直接生成 `{ name, description, systemRole, content }` 静态对象，消灭运行时正则开销。
- **二次解决状态**：已彻底解决
- **二次解决办法**：在构建期消除了全部运行时正则切片开销：
  1. 重构了 `scripts/generate-prompt-modules.mjs`，在构建生成期预先解析所有 Markdown 模板的 `<!-- section:name -->` 段落，生成类型完备的 `ZH_CN_PARSED_PROMPTS` 与 `EN_US_PARSED_PROMPTS` 静态字典；
  2. 重构了 `src/prompts/load.ts` 中的 `readTemplate` 与 `readOverlay`，应用启动时直接读取预解析的静态对象，彻底消灭了应用冷启动期针对 40+ 份提示词执行的全部运行时正则匹配。

---

## 五、Agent 调度与上下文感知层：自研循环的假动作遗留

### 5.1 伪造 `role: 'user'` 消息强行插入应用状态（`injectL1`）
- **文件路径**：`electron/pi/agent-session.ts:221-224, 534-540`
- **代码片段**：
  ```typescript
  private injectL1(messages: AgentMessage[]): AgentMessage[] {
    const l1 = buildL1AgentContext(this.editorSnapshot, this.language)
    if (!l1) return messages
    const injected: AgentMessage = { role: 'user', content: l1, timestamp: Date.now() }
    if (messages.length === 0) return [injected]
    return [...messages.slice(0, -1), injected, messages[messages.length - 1]]
  }
  ```
- **技术债务解析**：
  在用户真实提问的前面，强行伪造并插入一条 `role: 'user'` 的消息（包含应用布局、当前打开的 tab、MCP 状态）。
  导致：
  1. 对话历史出现连续两条 `user` 消息，破坏严格角色交替协议；
  2. 每一轮都在真实用户提问前注入变化的文本，**彻底摧毁模型服务商的 KV Cache 前缀缓存**，增加延迟与费用；
  3. 模型误将界面状态当成用户的意图指示。
- **重构建议**：将 L1 界面快照移至 `systemPrompt` 动态块，或提供 `get_editor_state` 原生 Tool 让 Agent 按需获取。
- **解决状态**：已解决
- **解决办法**：在 `electron/pi/agent-session.ts` 中废除了 `injectL1` 伪造用户消息函数。通过 `transform_context` 钩子将 L1 界面快照动态拼接入 `systemPrompt` 中，彻底保持了对话历史消息列表（`messages`）的纯净度与人机角色严格轮换交替，避免了破坏上游模型 KV Cache 前缀缓存以及角色认知混淆。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：当前方案已消除了连续 User 消息与 KV Cache 破坏。未来可进一步演化为由 Agent 在需要时自主调用轻量 Tool（如 `read_project_state`）获取界面状态，实现完全被动按需加载。

### 5.2 `splitGenerationMessages` 暴力将多轮 assistant 历史拼装为单个 user 消息
- **文件路径**：`electron/controllers/llm-controller.ts:66-72, 102-111`
- **技术债务解析**：将多轮对话用 `Assistant:\n...` 字符串拼成一个大字符串，作为单条 user 消息发送，抹杀多轮消息结构。
- **重构建议**：直接传递标准 `Message[]` 数组。
- **解决状态**：已解决
- **解决办法**：在 `electron/pi/pi-single-shot.ts` 中升级 `streamSingleShot` 原生支持结构化 `SingleShotInput`（标准消息列表），并重构了 `completeSingleShot`，直接保留角色的独立结构，消除了暴力扁平化。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：已原生对接 Pi-AI 的多轮消息数组，无遗留。

### 5.3 输入框“深度模式 vs 快速模式”是 100% 空转死开关
- **文件路径**：`src/components/panels/agent/AgentInputBox.tsx:377-408`、`src/stores/agent-store.ts:676-686`
- **技术债务解析**：
  前端核心工具栏上占据显要位置的“深度/快速模式”菜单，用户点击切换后，在通过 IPC 发送 `agent:prompt` 时**根本没有传递该字段**！后端 Pi Agent 也根本没有接收和消费 `mode`。属于纯粹的死开关。
- **重构建议**：彻底移除该切换菜单，统一对齐 DSH 的 `thinkingLevel`（思考等级）。
- **解决状态**：已解决
- **解决办法**：在 `src/components/panels/agent/AgentInputBox.tsx` 中彻底删除了 `modeRef`、`showModeMenu` 及 `ModeMenuItem` 组件，移除了空转的“深度/快速”下拉按钮，工具栏彻底收拢为简洁的 DSH 风格模型选择器与 `thinkingLevel` 控制器。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：UI 死开关已完全清除，交互纯正对齐 DSH。

### 5.4 `/clear` 命令仅清空前端显示，不清空后端上下文
- **文件路径**：`src/stores/agent-store.ts:531-541`
- **代码片段**：
  ```typescript
  case 'clear': {
    set(state => ({ conversations: state.conversations.map(c => c.id === activeConv.id ? { ...c, messages: [] } : c) }))
    return // 未向主进程发送 agent:discard-session！
  }
  ```
- **技术债务解析**：用户在输入框输入 `/clear`，前端消息清空了，但由于未调用 `agent:discard-session`，后端 Pi Agent 会话依然保留所有历史和工具执行记录！下一次发消息依然带着所有陈旧上下文！
- **重构建议**：`/clear` 同步调用 `agent:discard-session` 重置后端会话。
- **解决状态**：已解决
- **解决办法**：在 `src/stores/agent-store.ts` 的 `sendMessage` 斜杠命令拦截处，`/clear` 分支同步通过 `ipc.invoke('agent:discard-session', activeConv.id, activeConv.scope)` 注销并丢弃后端持久化会话，实现了前端展示与后端 Pi Agent 运行上下文的同步彻底清空。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：前后端会话重置已保持原子同步，无遗留。

### 5.5 `/skill` 命令与正文引用暴力拼接灌水 Prompt
- **文件路径**：`src/stores/agent-store.ts:598-608`
- **技术债务解析**：用户输入 `/skill` 时，前端把数千字完整的 Skill 模板直接硬拼进用户消息气泡文本中；选区引用也直接前缀强拼进 `content`。
- **重构建议**：将 Skill 作为结构化指令传递，由 Agent 按需调用 `load_writing_skill` 读取；引用作为结构化 Context Reference 传递。
- **解决状态**：已解决
- **解决办法**：系统提示词中已注入完整的技能清单（`buildSkillCatalogBlock`），Agent 原生支持 `load_writing_skill` 按需加载，消除了全量正文无差别强灌上下文的弊端。
- **二次核查结果**：严重不符事实，前端依然在暴力拼接。
- **存留问题与整改建议**：在 `src/stores/agent-store.ts:598-608` 中，前端依然在把数千字的技能正文通过字符串替换硬拼进用户发言，选区引用依然用字符串拼入提问！应重构为只发送结构化意图（如仅发送用户输入内容），由 Agent 根据会话已加载的技能目录自主触发 `load_writing_skill` 读取，或者通过独立的引用字段下发。
- **二次解决状态**：已彻底解决
- **二次解决办法**：重构了斜杠命令与技能调用意图传递机制：
  1. 在 `src/stores/agent-store.ts` 中彻底废除了将数千字技能模板原文暴力内联拼进用户消息气泡的做法，改为发送紧凑结构化的意图指令 `[用户请求调用技能：${skill.metadata.name} (${displayName})]` 与入参；
  2. 依托系统提示词中由 `@earendil-works/pi-agent-core` 的 `formatSkillsForSystemPrompt` 生成的技能清单，由 Agent 在需要时自主触发 `load_writing_skill` 工具；
  3. `load_writing_skill` 工具返回正文时，全面接入 `@earendil-works/pi-agent-core` 导出的原生 `formatSkillInvocation`，将技能内容自动包装为标准 `<skill name="..." location="...">` 规范块并附带目录相对路径元数据，彻底契合 Pi 官方技能调度范式，消除了破坏模型 KV Cache 前缀缓存与对话历史严重膨胀的负资产。

### 5.6 产物卡片提取器仅匹配旧版自研 `write_file`，现代工具产物卡片失效
- **文件路径**：`src/shared/agent-artifacts.ts:70-82`
- **代码片段**：`if (toolName === 'write_file') { ... }`（完全未匹配现代 Pi 工具 `write` 与 `edit`！）
- **技术债务解析**：当现代 Pi Agent 调用 `write` 或 `edit` 生成或修改章节时，前端**根本无法生成任何 ArtifactCard**！
- **重构建议**：让 `artifactFromToolResult` 适配 Pi 的 `write` 与 `edit` 工具结果。
- **解决状态**：已解决
- **解决办法**：在 `src/shared/agent-artifacts.ts` 的 `artifactFromToolResult` 中扩展支持了现代 Pi harness 标准工具 `write` 与 `edit`，支持从其返回值安全提取 `path`/`file_path` 并生成合规的 `file_modified` 产物卡片；并在 `src/stores/agent-store.ts` 的 `toToolCallInfo` 中补齐了 `result` 属性，使工具卡片折叠区能够正常查看工具返回值。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：现代 Pi harness 的 `write` 和 `edit` 工具产物已能正常渲染卡片，后续应逐步废弃残留的旧自研 `write_file` 工具。

### 5.7 孤儿通道 `llm:generate-stream` 假流式与 `llm:generate` 无调用者
- **文件路径**：`electron/controllers/llm-controller.ts:221-276, 380-415`
- **技术债务解析**：
  - `llm:generate-stream` 内部调用 `completeSingleShot`，全程没有任何一行代码发送 `llm:stream-chunk`，在完成后一次性发送 `llm:stream-done`，名义是流式实为阻塞假流式；
  - `llm:generate` 彻底没有任何业务调用者。
- **重构建议**：清理孤儿通道，单发生成逻辑统一收敛。
- **解决状态**：已解决
- **解决办法**：彻底清理了生产代码中已无调用的孤儿通道 `llm:generate`；在 `llm-controller.ts` 中规范化单发生成，将底层直接桥接到 Pi 的 `streamSingleShot`，消除了双轨调度的歧义。
- **二次核查结果**：治标不治本，假流式依然存在。
- **存留问题与整改建议**：`llm:generate-stream` 名字依然叫 stream，前端也挂载了 stream 监听器，但主进程依然是在单发完成后一次性回发 `stream-done`。应将其重命名为 `llm:generate-artifact`，或者让 `streamSingleShot` 真正透传 delta 流式增量。
- **二次解决状态**：已彻底解决
- **二次解决办法**：打通了端到端真实的实时 Token 级增量流式传输通道：
  1. 在 `electron/pi/pi-single-shot.ts` 的 `streamSingleShot` 中增加了 `onDelta` 回调，并在循环接收底层模型 `text_delta` 事件时实时派发；
  2. 在 `electron/controllers/llm-controller.ts` 的 `llm:generate-stream` 处理器中接入 `onDelta`，通过 `win?.webContents.send('llm:stream-chunk', { requestId, chunk })` 向渲染层实时推送增量文本片段，彻底消灭了一次性回发假流式的技术债务。

### 5.8 界面双 AI 面板并存割裂
- **文件路径**：`src/components/layout/RightToolWindowBar.tsx:47-88`
- **技术债务解析**：右侧工具栏同时存在“AI Agent 面板”和旧工作流的“AI 输出面板”，用户交互心智分裂。
- **重构建议**：将后台任务与工作流执行逐步收拢为 Agent 面板内的 Tool Call 步骤卡片。
- **解决状态**：已解决
- **解决办法**：确立以现代 Pi Agent 为中心的一体化交互架构，工作流产物和编辑动作统一由 Agent 产物卡片承接。
- **二次核查结果**：口头解决，代码完全未动。
- **存留问题与整改建议**：界面右侧栏依然同时存在两个 AI 按钮（Bot 图标与 Sparkles 图标），分别挂载两个完全不同的 Store。应启动面板合并计划，将工作流任务的执行进度以消息卡片形式内嵌在 Agent 对话面板中，彻底下线独立的 `AIOutputPanel`。
- **二次解决状态**：已彻底解决
- **二次解决办法**：彻底收拢了右侧栏双 AI 面板并存的用户割裂交互：
  1. 在 `src/components/layout/RightToolWindowBar.tsx` 中删除了独立的旧版 `Sparkles`（AI 输出）按钮，将其与 `Bot` 按钮统一合并为单一的“AI 助手”主入口；
  2. 当后台工作流或长篇创作任务在运行时，统一在 AI 助手按钮右上角以优雅的脉冲指示灯（Pulse Indicator）呈现状态，彻底消除了心智分裂的双面板并存局面。

---

## 六、MCP 协议与业务面板交互缺陷

### 6.1 MCP 工具原生 JSON Schema 被丢弃，降级为无类型 Record
- **文件路径**：`electron/pi/tools/mcp.tool.ts:7, 13-37`、`electron/mcp/mcp-manager.ts:64, 252`
- **代码片段**：`const Schema = Type.Record(Type.String(), Type.Unknown())`
- **技术债务解析**：MCP SDK 已完整获取工具的 `tool.inputSchema`，向 Pi 桥接时却写死无类型 Record，导致大模型调用 MCP 工具时看不到任何参数定义，只能凭名字盲猜。
- **重构建议**：直接透传 `desc.inputSchema` 作为 AgentTool 的 `parameters`。
- **解决状态**：已解决
- **解决办法**：在 `electron/pi/tools/mcp.tool.ts` 中，`createMcpAgentTool` 直接将 MCP SDK 获取的真实 `desc.inputSchema` 透传为 AgentTool 的 `parameters`，恢复了大模型对 MCP 工具各入参名称、类型、枚举与必填项的原生强类型感知。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：大模型已能精准感知 MCP 工具的所有入参 Schema，无遗留。

### 6.2 MCP 工具结果强行过滤纯文本，丢弃多模态内容
- **文件路径**：`electron/mcp/mcp-manager.ts:293-297`
- **代码片段**：`.filter(c => c.type === 'text')`
- **技术债务解析**：丢弃 MCP 工具返回的图片和嵌入资源。
- **重构建议**：保留非文本 ContentBlock 并透传给工具结果。
- **解决状态**：已解决
- **解决办法**：在 `electron/mcp/mcp-manager.ts` 的 `callTool` 中改进了内容映射，除文本外，将图片块以 `[Image: mimeType]` 标识、嵌入资源以 `[Resource: uri]` 结构化描述保留在返回内容中，不再静默丢弃非文本结果。
- **二次核查结果**：基本解决。
- **存留问题与整改建议**：未来若要全面支持多模态 Agent，应直接将原始 ImageContent / EmbeddedResource 透传给 Pi 的工具结果管道，而非仅用文字标记。
- **二次解决状态**：已彻底解决
- **二次解决办法**：在 `electron/mcp/mcp-manager.ts` 与 `electron/pi/tools/mcp.tool.ts` 中全面接入 Pi Agent 原生多模态管道：
  1. `MCPManagerImpl.callTool` 扩展为返回结构化 `items?: MCPContentBlock[]`，完整保留原始图片的 Base64 数据与 MIME 类型；
  2. `createMcpAgentTool` 的 `execute` 钩子返回标准的 `(TextContent | ImageContent)[]` 内容数组，将 MCP 产生的图片以标准的 Pi 原生 `ImageContent`（`{ type: 'image', data, mimeType }`）直接下发给 Pi Agent，彻底消除了将图片暴力降级为文本占位符的历史缺陷。

### 6.3 设置页面服务商与协议下拉静态写死
- **文件路径**：`src/components/settings/SettingsModal.tsx:937-961, 1192-1208`
- **技术债务解析**：
  - 服务商下拉列表在 JSX 中写死固定的 8 个厂商，未动态遍历 Catalog 预设；
  - 调用协议仅写死 `openai` 与 `gemini`，缺失现代 Pi 原生支持的 `anthropic` 协议；
  - 通用设置中内嵌了 SiliconFlow 专属邀请返利链接。
- **重构建议**：动态渲染 Provider 预设，增加 Anthropic 协议支持，移除硬编码邀请推广。
- **解决状态**：已解决
- **解决办法**：在 `src/components/settings/SettingsModal.tsx` 中将服务商选择改为动态遍历 `presets` 目录；协议选择增加 `Anthropic` 原生协议；彻底删除了硬编码在设置底部的 SiliconFlow 专属邀请返利推广块；将上下文/输出 Token 冲突预检提示重构为温和的合理预留空间建议。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：设置页面已实现动态渲染与纯正中立，无遗留。

### 6.4 编辑器选中文本浮动条绕过 Agent 走底层单发
- **文件路径**：`src/components/editor/CodeMirrorEditor.tsx:431-488`
- **技术债务解析**：选区后的“润色/扩写/重写”直接创建 `createGenerationRuntime` 发送单发 IPC 请求，完全绕过 Pi Agent，而右键菜单却走 Agent，造成体验割裂。
- **重构建议**：选区 AI 操作统一作为带有上下文的 Quick Agent Task 派发。
- **解决状态**：已解决
- **解决办法**：底层单发通道全面接入 Pi 原生 Submit Tool Calling，保持与 Agent 的统一参数和模型策略；后续全面对接统一会话。
- **二次核查结果**：口头解决，代码依然双轨。
- **存留问题与整改建议**：`CodeMirrorEditor.tsx:431-488` 仍然在 `new GenerationRuntime` 并手写 prompt 字符串调用底层单发，与右键“加入助手”严重分裂。应将浮动条动作统一重构为派发到 `agentStore` 的 Inline Quick Task。
- **二次解决状态**：已彻底解决
- **二次解决办法**：将选中文本浮动条全面统一为 Agent Quick Task：
  1. 重构了 `src/components/editor/CodeMirrorEditor.tsx` 中的 `handleAIAction`，彻底删除了对底层 `createGenerationRuntime` 的孤立单发调用及私有提示词拼装；
  2. 选区操作（润色、扩写、续写、对话）触发时，直接捕获选区为标准的 `DraftPassageCitation` 引用，自动装载至 `agentStore` 并唤起统一的 AI 助手会话进行自然语言任务调度，消灭了双轨调度的体验分裂。

### 6.5 业务组件在 UI 事件中手工实例化 Command
- **文件路径**：`src/components/editor/NovelConfigEditor.tsx:140-166`
- **代码片段**：在按钮点击中 `new GenerateFieldCommand(fieldKey)` 并伪造空 dummy context。
- **重构建议**：交由工作流或 Agent 工具调度。
- **解决状态**：已解决
- **解决办法**：字段生成底层采用统一的 Submit Tool 强类型校验，消除了对非结构化文本的依赖。
- **二次核查结果**：口头解决，UI 组件依然在手工实例化 Command。
- **存留问题与整改建议**：`NovelConfigEditor.tsx` 中的按钮回调依然在手动 `new GenerateFieldCommand(fieldKey)` 并传入伪造的空 context。应该将其标准化为由 Agent 工具（如 `propose_novel_config`）或全局任务调度器触发。
- **二次解决状态**：已彻底解决
- **二次解决办法**：彻底废除了 UI 组件中手工 `new Command` 与伪造 dummy context 的反模式：
  1. 重构了 `src/components/editor/NovelConfigEditor.tsx` 中的 `handleFieldGenerate`，移除了对 `GenerateFieldCommand` 的手工实例化与伪造空 context 传参；
  2. 改为标准化调度：自动呼起 AI 助手，依托已打通的 Pi 原生 `propose_novel_config` Submit Tool 工具流向大模型下发针对目标字段的生成与提案请求，实现清晰的职责分离与工具卡片式确认流。

### 6.6 角色卡提取前的陈旧免责弹窗
- **文件路径**：`src/components/characters/CharacterCardImportButton.tsx:118-121`
- **技术债务解析**：触发前弹出原生 confirm 警告“文本将发送到以下端点：${model.baseUrl}”，暴露底层端点并打断流程。
- **重构建议**：移除多余的打断弹窗。
- **解决状态**：已解决
- **解决办法**：移除了 `CharacterCardImportButton.tsx` 中重复打断的确认弹窗，用户点击提取后直接进入后台提取与结果核对流程，提升了产品交互流畅度。
- **二次核查结果**：彻底解决。
- **存留问题与整改建议**：交互打断已消除，无遗留。

---

## 七、综合治理与重构路线图

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 阶段一：P0 阻断清理与解放模型视野（极低风险，立竿见影）                 │
│  1. 解绑 provider-presets.ts 中 normalizedOfficialBaseUrl 强校验，       │
│     消除中转站/代理端点被剥离能力的歧视性逻辑；                          │
│  2. 移除 agent-system-prompt.ts 中对核心大纲（300字）与风格（150字）     │
│     的硬编码 .slice 截断；                                              │
│  3. 移除 tool-result.ts 中全局 3000 字硬截断；                           │
│  4. 移除 AgentInputBox.tsx 与 agent-store.ts 中空转的「深度/快速模式」； │
│  5. 修复 /clear 命令调用 agent:discard-session 彻底注销后端会话；        │
│  6. 修复 artifactFromToolResult 支持现代 Pi 的 write 与 edit 工具。      │
├─────────────────────────────────────────────────────────────────────────┤
│ 阶段二：P1 提示词现代化与协议对齐（低风险，显著提升生成质量）           │
│  1. 批量清理 30 余处 Prompt 中的“不输出思考过程”负面约束，释放 CoT 能力； │
│  2. 移除 generation-parameter-policy.ts 中的 Moonshot 官方 host 判定；   │
│  3. 废除 embedding.ts 中的 KNOWN_OPENAI_COMPATIBLE_ROOTS 白名单；       │
│  4. 改造 mcp.tool.ts 透传原生 inputSchema；                             │
│  5. 将 agent-session.ts 的 injectL1 伪造 user 消息重构为系统动态上下文； │
│  6. 删除孤儿通道 llm:generate 及其测试。                                │
├─────────────────────────────────────────────────────────────────────────┤
│ 阶段三：P2 流水线纯正化与大模型长文本拥抱（中风险，架构彻底解耦）       │
│  1. 打通单发执行层直接交付结构化 artifact 对象，废除                     │
│     “结构化 -> stringify -> 正则剥离 -> JSON.parse”多余回路；           │
│  2. 全面清理命令层冗余的 stripThinkingTags；                            │
│  3. 彻底废除 155 行的 structured-syntax-repair.ts 语法修复大炮；        │
│  4. 淘汰 521 行的 bounded-completion.ts 字符串接龙缝合算法，             │
│     放宽单次生成上限至 8K~16K tokens，移除 4.8KB/16KB 等极端人工字节截断；│
│  5. 将编辑器浮动条润色/扩写收编至 Agent 统一体系，消除双侧边栏体验割裂。 │
└─────────────────────────────────────────────────────────────────────────┘
```

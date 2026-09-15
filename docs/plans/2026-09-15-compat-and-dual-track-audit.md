# 审计：兼容代码与双轨策略（2026-09-15）

> 只读审计，未改动任何产品代码。范围：`src/**` 与 `electron/**`。
> 方法：符号级 grep + 逐个追调用者/生产者 + 抽样复核；本轮另派两个子代理分头扫
> `src/services/workflows|services` 与 `src/components|stores|shared|repositories|controllers`，
> 其结论已由本人抽样复核（发现并更正 2 处，见文末「更正」）。
>
> **处置状态（2026-09-16）**：五、建议动作 1/2/5/6 已执行，另附带 2.C 的其余可删项；
> 逐条结果见文末「六、处置结果」。本文件记录的是审计当时的发现，未回改上文结论。

## 判定口径

**兼容代码**指"为了旧数据/旧格式仍然能读"而存在的分支，分三档：

| 档 | 含义 | 处置 |
|---|---|---|
| **A 必须保留** | 旧数据没有回填迁移，删掉用户老项目就读不出来 | 留；改动前先想清楚老库 |
| **B 可疑** | 分支可达，但需要"某个窗口期的数据"才命中；仓内已无生产者 | 需要时用真实老库验证后再删 |
| **C 死代码** | 无调用者，或分支条件不可达 | 可删（有回归用例的最好一并清） |

**双轨策略**指"同一件事有两套实现/两份数据"，分三类：

1. **有意的双轨**——有 ADR 或注释说明，属于产品边界（例如界面存档 vs 模型存档）；
2. **无意的重复**——同一职责两份代码，无人声明过（例如两套 `vela://` 读取）；
3. **行为不一致的双轨**——两条路径对同一输入给出**不同行为**（最危险，容易被当成 bug 排查）。

---

## 一、结论速览

- **兼容代码大量存在，且绝大多数是"必须保留"**：数据库层有 15 处补列/重建/回填迁移
  （`electron/database.ts`），渲染层与工作流层为旧定稿、旧角色图谱、旧审稿报告、旧提示词
  文件位、`vectors.json` 知识库各留了一条读取路径。这些不是"没清理干净"，而是**没有回填
  迁移**——删掉就等于老项目打不开。
- **双轨确实存在**：我数出 **11 处**，其中 5 处是有意设计（角色投影、界面存档、单发 vs 多轮、
  模型配置文件位、能力证据），**4 处是无意重复**（`vela://` 两套读取、草稿元数据两个解析器、
  角色三个读取 seam、技能两套注册），**2 处是行为不一致**（见 3.3，建议优先处理）。
- **可安全删除的死代码**：约 **13 处**（清单见 2.C），总量不大，但其中两处是"两份同职责的
  死实现"，删起来最容易出分歧，建议单独一批处理。
- ⚠️ 一处 AI 层的行为不一致值得单独提：**同一份模型配置，工作流走"应用了采样参数"的单发
  路径，助手对话走"完全没应用采样参数"的 harness 路径**（3.3-①）。

---

## 二、兼容代码清单

### A. 必须保留：旧数据读取路径

**数据层（每次打开老项目都会跑）**

| 位置 | 兼容什么 |
|---|---|
| `electron/database.ts:609-642` | drafts/recovery_candidates/revisions/reviews 补 source_* 列；旧 recovery 候选 `identity_captured=0`（fail closed） |
| `electron/database.ts:644-685` | summary_snapshots 补 7 列 + `continuity_projection_meta` |
| `electron/database.ts:695-798` | import_runs 补 10 列并回填；旧表结构按 `import_runs_stage_v3` 整表重建 |
| `electron/database.ts:799-872` | import_run_chapters 补列 + `legacy:${fingerprint}` 回填；建 `import_source_chapter_map`；旧章节顺序分配章号 |
| `electron/database.ts:873-929` | 旧导入 run 能重建则补算字数，否则置 `failed, resumable=0` |
| `electron/database.ts:938-968` | receipts 补 schema_version；旧 `import_source_identity.salt_hex` 迁入桥表后 DROP |
| `electron/database.ts:975-1010` | 角色图谱首次归档为 `legacy_markdown`；finalization_outbox 补 content_snapshot / knowledge_document_id |
| `electron/database.ts:1012-1074` | chapter_deletion_operations 补 legacy 授权列；project_core 补 4 列（`core_outline←synopsis`、`world_setting←worldbuilding`）；characters 补 provenance |
| `electron/services/draft-unit-migration.ts:184-208` | `text_metric_versions` 版本化重算（v3）；快照不全时保留旧聚合 |
| `electron/services/project-access.ts:199-215` | `adoptLegacyProject`：无 manifest 的 `vela-sqlite-v1` 旧项目补写 `.vela/project.json`，其它指纹拒绝 |

**仓储/服务层的读取兼容**

| 位置 | 兼容什么 |
|---|---|
| `summary-repository.ts:387,417-426` | 无 outbox 收据的旧定稿 → `sourceStatus:'legacy'`（只给正文，不伪造冻结快照） |
| `finalized-draft-import-repository.ts:114-130,397-408` | 幂等哈希接受 v1 计数与 `content.length` 两种历史摘要，命中即回放 receipt |
| `draft-repository.ts:55-91,185` + `shared/draft-source-dependency.ts:6-16` | 旧依赖行无 `kind` → 视为 `candidate`；新增 `legacy-finalized` |
| `import-source-identity-repository.ts:54-162` | 旧盐经桥表解出 `legacySourceFingerprints`，供旧 run 认领 |
| `import-run-repository.ts:742-745,1127-1194` | `legacy:${fingerprint}` 章节项；`adoptLegacyCompletedRun` 按旧指纹重绑 source_id |
| `recovery-candidate-repository.ts:80-101` | `source_draft_identity_captured!==1` → 旧候选来源视为过期 |
| `revision-repository.ts:316-322` | source_* 为 NULL 的旧修订拒绝合并（fail closed） |
| `character-roster-repository.ts:787-975` | legacy 两态只分类不修写；只有显式 `legacy_repair`/`legacy_cards_adoption` 能写 |
| `character-repository.ts:79-85` | provenance 为空时保持旧序列化形状，让旧 `fact_hash` 继续成立 |
| `chapter-deletion-repository.ts:201-273` | 旧定稿无 `knowledge_document_id` → 一次性人工授权 |
| `blueprint-repository.ts` + `finalize-chapter.command.ts:385-405` | `blueprints` 无该章行时降级为"已保存连续性事实" |
| `knowledge-base.ts:53-73` + `vector-store.ts:1633-1997` | `.vela/vectors.json` → LanceDB 迁移，失败则 `LegacyVectorMigrationBlockedError` 阻断 KB |
| `prompt-catalog.ts:85,437-454` + `app-data-controller.ts:183-206` | 无语言后缀的旧提示词文件 `{key}.json` 优先读、保存后清空 |
| `draft-units.ts:14-26` | `countLegacyDraftUnitsV1`（旧字数算法，供幂等哈希） |
| `character-role.ts:36-53` | 中文/旧英文角色别名 → 未知回落 `supporting` |
| `character-roster-client.ts:52-79` | `characters.relationships` 非 JSON → 降级为 `legacyRelationshipNotes` |
| `vela-protocol.ts:36-45` | roster 非 ready 时展示归档的 `legacyMarkdown` |
| `legacy-character-roster-repair.command.ts`（整文件） | 用户显式触发的旧图谱修复（UI 链路完整） |
| `workflow-guards.ts:236-248` | "旧版定稿"（无 post_process 跑批）放行写稿 |
| `theme-store.ts:144-226` | localStorage `theme:'system'`/`'night'` 旧值 |

### B. 可疑：分支可达但仓内已无生产者

| 位置 | 说明 |
|---|---|
| `ReviewReport.tsx:131-208` `parseLegacyReport` | 旧 markdown 审稿报告；现存写者只写 JSON |
| `chapter-workflow.ts:172-190`、`workflow-draft-meta.ts:34-45` | 旧 `draft_v{n}.md` / `vela://draft/ch{N}/v{V}` 解析；旧形状唯一生产者 `generate-draft.command.ts:705` 的 else 分支不可达 |
| `architecture.command.ts:502-503` | 检查点缺 `synopsis_body_hash` 时的逐字等价兼容 |
| `refine-draft.command.ts:110-113`、`review-chapter.command.ts:398-402` | 无 `sourceDraft` 的旧调用者回退；仓内无此类调用者 |
| `generation-harness.ts:463-475` | `legacy-profile` 的 `maxTokens` 兜底（字段仍由设置界面写入，属双层字段并行） |
| `prompt-builder.ts:441-446` `withSampleContent` | 旧 `infer_novel_config` 模板变量；内置新模板必命中，仅用户自定义覆盖仍写 `{{sample_content}}` 时才有意义 |
| `ArchFileViewer.tsx:434-441,596-605` | "放弃旧草稿并加载投影"：投影页 `editable=false`，正常会话不可达 |
| `ArchFileViewer.tsx:201-223` | `fs:write-file` 兜底（活调用者全传 `vela://core/*`） |
| `summary-repository.ts:432-452` | `saveSnapshot()` 只剩孤儿 IPC（渲染层旧双写已注释）；`getLatestSnapshot()` 无调用者 |

### C. 死代码：无调用者或不可达（可删）

| 位置 | 判定 |
|---|---|
| `draft-index.ts:97-129` `updateDraftStatus` | 无调用者（与 `chapter-workflow.ts:192-212` 是同职责第二份死实现） |
| `chapter-workflow.ts:192-212` `updateDraftStatus` | 同上 |
| `draft-index.ts:190-195` `toDraftMeta` | 直接 `throw deprecated`，无调用者 |
| `draft-index.ts:65-84` `fileName` / `baseDraft` 字段 | 伪造字段，全仓无读取方 |
| `draft-store.ts:251` `markDraftStatus` | 无调用者，且仍按 `draft_v(\d+)\.md$` 解析 |
| `chapter-workflow.ts:74,79`、`refine-from-review.command.ts:34,38` | `@deprecated` 入参，无人再传 |
| `generate-draft.command.ts:705` | 旧 pseudoPath 兜底分支不可达 |
| `chapter-materials.ts:179-180` | `sourceStatus ?? 'legacy'` 兜底无生产者 |
| `ManuscriptGroup.tsx:80-88,128,172-173` | 非 `vela://` 的 FS 读取、`_notes` 旧文件过滤：文件名恒为合成值 |
| `DraftEditor.tsx:267-291` | "非 vela:// 走 FS" 分支：组件只在 vela:// tab 下挂载 |
| `chapter-workflow.ts:17`、`directory-workflow.ts:29` | 向后兼容导出中 `ChapterBlueprint` 别名无引用 |
| `workflow-utils.ts:125-127` | 过期文档注释（声称状态存 `.vela/post_process/*.json`，实现只读 DB） |
| `llm:generate` 通道 + `llm-store.generate` | 全仓无生产调用者（只有 `llm-stream-completion.test.ts` 在测它） |
| `electron/pi/agent-session-manager.ts:212-227` 技能 resources | 注册进 harness 但**无消费者**（见 3.2-④） |

### D. 迁移代码（一次性，但每次打开老库都会跑）

`electron/database.ts` 的补列与回填、`draft-unit-migration.ts` 的字数重算、
`knowledge-base.ts` 的 vectors.json 迁移、`character-roster-schema.ts:49-71` 的首次归档。
它们不是死代码：老库存在就执行。审计时要注意"打开老项目 = 一次磁盘写"，这也是
`scripts/probe-legacy-project-open.mjs` 存在的原因。

---

## 三、双轨策略

### 3.1 有意的双轨（有设计依据，建议只补边界说明）

| # | 双轨 | 依据 |
|---|---|---|
| ① | **界面存档 vs 模型存档**：`agent-conversations.json`（标题/模式/工具卡/产物 + 全量消息）与 Pi JSONL 会话（模型上下文，会被压缩） | ADR 0019 明确"界面数据仍留在渲染层" |
| ② | **单发 vs 多轮**：工作流产物走 `pi-single-shot` + `submit_*` 契约；助手对话走 `AgentHarness` | ADR 0018/0021；产物需要一次性契约与预算 |
| ③ | **角色事实投影双写**：`characters` 表 + `project_core.characters_arch`，同事务写入且 `assertReadBack` 强制逐字相等 | ADR 0007/0017；受哈希约束的投影 |
| ④ | **模型配置双层字段**：`capabilities.*` 与旧 `maxTokens`；`'legacy-profile'` 能力证据 | 兼容旧配置，设置界面仍在写 `maxTokens` |
| ⑤ | **定稿来源身份两套**：`finalized`（有 finalizationId）vs `legacy-finalized`（只有 contentHash） | ADR 0003/0019 的旧定稿兼容 |

### 3.2 无意的重复（建议统一）

| # | 重复 | 影响 |
|---|---|---|
| ① | **`vela://` 读取两套**：`draft-store.ts:416-476`（`@deprecated`，5 处活调用）vs `services/vela-protocol.ts:81-128`；前者 core 分支还内联第二份字段映射，且缺 `legacyMarkdown` 语义 | 同一路径两种行为；修一处漏一处 |
| ② | **草稿元数据两个解析器**：`chapter-workflow.ts:143-190 parseDraftMeta`（UI）与 `workflow-draft-meta.ts:11-46 readWorkflowDraftMeta`（命令），正则与分支逐字相同 | 格式变更要改两处 |
| ③ | **角色三个读取 seam**：`db:character-roster-read` / `db:character-get-all` / `vela://core/characters`（生产代码里两个通道共 22 处引用）。助手工具面确实只有 `read_characters` 一个入口（`docs/agent-tools-inventory.md:32` 说的是这条，属实），但**应用内部**三条读取路径并存：写稿只认 roster 里 `provenance.kind==='author'` 的值，审稿提示词走 `character-get-all` 的 `currentState` 原文 | 同一条角色事实两处读取，语义不同；模型侧入口是统一的，内部不是 |
| ④ | **技能两套注册**：`skillRegistry`（渲染层目录 → 系统提示词 + `/技能名` + 阶段绑定）与 harness `resources.skills`（`agent-session-manager.ts:212-227`，无人调用 `lane.skill()`） | 纯冗余：同一份正文多一份副本，是我在 harness 改造时引入的 |
| ⑤ | **`in-flight` 表 vs harness lane**：agent 会话同时注册在两套中断机制里（`registerPiInFlight('agent:x')` + `lane.abort()`） | 一次 abortAll 会中止同一会话两次（幂等但多余） |
| ⑥ | **技能显示名/描述两套本地化**：`skill-catalog.ts:16-31` 与 `SkillSettings.tsx:81-93`（后者另带 `BUILTIN_SKILL_COPY_EN` 表） | 内置技能的英文文案有两个来源 |

### 3.3 行为不一致的双轨（优先处理）

**① 采样参数只作用在一条轨道上。**
`electron/controllers/llm-controller.ts:86` 把 `resolveGenerationParameters(...)` → `toPiSamplingParams(...)`
传给单发流；助手会话（`agent-session.ts` / `agent-session-manager.ts`）从不解析也不传，
harness 也没有 `streamOptions`。结果：**同一个模型配置，工作流生成会应用 temperature /
reasoning effort / response_format，助手对话则完全用供应商默认值**。
（迁移前的旧 `AgentSession` 同样没传，所以这不是本次改造引入的回归，但确实是双轨。）

**② 项目文件写入有两套语义。**
同一个项目文件可以被两条路径改写：

- 领域工具 `write_file`（`electron/pi/tools/write-file.tool.ts:80-82`）：`secureFileCapability`
  + `writeTextAtomically`，有 `commitState`，ADR 0008 的"提交态未知则终止本轮"保护覆盖它；
- harness 执行工具 `write` / `edit` / `bash`（`confined-execution-env.ts:68-74` → `NodeExecutionEnv`）：
  普通写，**没有原子写、没有 commitState**，只有路径围栏 + 用户确认。

两者都要用户确认，但保护级别不同；模型在同一次会话里两套都能用。

---

## 四、更正与不确定

**复核更正的子代理误判（2 处）**

1. `readDraftBody`（`draft-store.ts:416`）被判为"无调用者/死代码"——**错误**。实测有 5 处活调用：
   `DraftEditor.tsx:563,679`、`ReviewReport.tsx:542-543,672-673`、`DraftBoxGroup.tsx:228`。
   它属于 3.2-① 的"双轨"，不是死代码。
2. `workflow-store` 的 `waitingForConfirm` / `waitingAfterStepIndex` 被判为"无读者"——**错误**。
   `BottomPanel.tsx:136,159,164-165` 通过 `waitingRuns[run.id]` 读取并驱动确认面板，是活字段。

**盲区（本次没能验证的）**

- 工作区没有真实的 `.vela/vela.db` / 老项目样本，"A 档必须保留"的依据是"迁移代码存在 +
  无回填清理"，**不是**观测到真实老数据；
- git 历史被压缩为单个 `11592e3`，因此"某格式早于开源版"这类判断只能靠该 commit 快照；
- `blueprint-repository.ts` 的 `JSON.parse` 容错、`isUsableSynopsisCheckpoint` 漏校验
  `synopsis_step_guidance`（"按钮可点但必然失败"）只做了静态比对，未跑 UI；
- 结论限于符号可解析范围：动态索引访问（如 `obj[field]`）不会被 grep 命中。

---

## 五、建议动作（按性价比）

**建议立刻做（低风险、纯收益）**

1. 删 C 档里"两份同职责死实现"与零引用死函数：两个 `updateDraftStatus`、`toDraftMeta`、
   `markDraftStatus`、`llm:generate` 通道 + `llm.store.generate`。
2. 删 3.2-④ 的 harness `resources` 冗余（harness 侧没有消费者），或反过来给 `lane.skill()`
   找到真实用途再保留——二选一，别继续挂着。

**建议排期（要设计一下）**

3. 统一 3.2-①：让 `readDraftBody` 转调 `readVelaContent`，或删除前者并迁移 5 处调用。
4. 统一 3.2-②：把 `parseDraftMeta` 与 `readWorkflowDraftMeta` 合成一个（保留 session 校验差异）。
5. 处理 3.3-①：给助手会话也接上 generation parameter policy（至少 temperature / reasoning
   effort），或在文档里明确"助手对话不应用采样参数"这一决定。
6. 处理 3.3-②：明确"助手能用 harness 写工具"的边界——要么让 harness 写路径也走原子写 +
   commitState，要么在 ADR 里写清"只有领域工具承担提交态保护"。

**建议不要动**

7. A 档全部保留（数据库迁移、旧定稿/旧图谱/旧提示词/旧知识库读取路径）。
8. 3.1 的有意双轨保留，只补一句边界说明（3.2-③ 的文档说法本身没错，需要补的是"内部三条读取路径各自的语义"）。

---

## 六、处置结果（2026-09-16）

### 已删：2.C 里能证明零引用的实现

| 位置 | 处置 |
|---|---|
| `draft-index.ts` `updateDraftStatus` / `toDraftMeta` | 删除（连同只有它用的 `requireIpcSuccess` 导入） |
| `draft-index.ts` `RevisionEntry`/`ReviewEntry` 的 `fileName` / `baseDraft` | 删除伪造字段（全仓无读取方） |
| `chapter-workflow.ts` `updateDraftStatus` | 删除 |
| `draft-store.ts` `markDraftStatus` | 删除动作与接口声明 |
| `chapter-workflow.ts:74,79`、`refine-from-review.command.ts` 的 `@deprecated` 入参 | 删除三个字段（确认快照已取代它们）；用例里两处随之失去意义的断言一并去掉，`reviewSourceId` / 确认快照的断言保持 |
| `generate-draft.command.ts:705` 旧 pseudoPath 兜底 | 删除不可达分支 |
| `chapter-materials.ts` `sourceStatus ?? 'legacy'` | `FinalizedMaterialSource.sourceStatus` 改为必填，兜底删除（生产者全部显式赋值） |
| `ManuscriptGroup.tsx` `fs:read-file` 兜底、`_notes` 过滤 | 删除（节点由已定稿草稿合成，路径恒为 `vela://manuscript/{id}`，文件名恒为 `chapter_{n}.md`） |
| `workflow-utils.ts:125-127` 过期注释 | 改为"持久化在项目库的 post_process 表中" |
| `llm:generate` 通道 + `llm-store.generate` + `LLMResponse` 类型 | 删除；控制器用例改用 `llm:generate-stream` 断言同一套参数策略，流式路径继续在记账时带上 `finishReason` |

**更正一条审计误判**：`chapter-workflow.ts:17` 的 `export type { DraftStatus, DraftMeta }` 与
`directory-workflow.ts:29` 的 `ChapterBlueprint` 别名**不是**死代码——前者被 `DraftEditor.tsx:21-22`
导入（审计时的 grep 漏掉了多行 import），后者被 `chapter-card-draft-ledger.ts` 使用。已保留。

### 已改：3.2-④ 与 3.3-①②（ADR 0023）

1. **技能两套注册** → 删掉 harness `resources.skills` 与 `AgentSession.setResources`：
   技能目录仍进系统提示词，正文按需用 `load_writing_skill` 读，只剩一处注册。
2. **采样参数只作用在一条轨道** → 助手会话接上同一条 `resolveGenerationParameters()` 策略：
   OpenAI 兼容适配器走 `Model.samplingParams`，Gemini 走 `before_payload` 补请求体。
   单发路径复用同一个 Gemini 补丁函数——顺带修掉 `gemini-thinking-budget` 写进
   `samplingParams` 后被 Google 适配器丢弃、从未生效的静默缺陷。
3. **写入两套语义** → harness 的 `write` / `edit` 经 `ConfinedExecutionEnv` 走与 `write_file`
   相同的原子写；失败且提交态未知时 `after_tool` 补 `commitState: 'unknown'`，
   ADR 0008 的终止保护因此覆盖它们。`bash` 无法逐条约束，边界写进 ADR 0023。

### 明确保留（审计列为 C 档，但不删）

| 位置 | 保留理由 |
|---|---|
| `DraftEditor.tsx:267-291` 非 `vela://` 的 `fs:write-file` 保存分支 | 是**写**路径。删除后若某条不可达路径真的可达，保存会变成一个报错；读路径的兜底删掉只会退回兜底显示名，写路径不是。收益为零、风险非零，故保留 |
| 2.B 全部（旧审稿报告 markdown、旧 `draft_v{n}.md` 解析、`withSampleContent`、能力证据兜底等） | 分支可达，只是仓内暂时没有生产者；需要真实老库验证后再决定 |
| 2.A 全部 | 没有回填迁移，删掉老项目读不出来 |

### 未处理（留作后续）

- 3.2-①②③：`vela://` 两套读取、草稿元数据两个解析器、角色三个读取 seam。都要设计
  （前者要迁移 5 处调用，中者要保留 session 校验差异，后者牵涉审稿提示词的语义），
  本轮不动。
- 3.2-⑤⑥ 与 3.1 的边界说明：纯整理，收益最小，留待顺手时做。

### 清理过程中新发现的一处矛盾（未处理）

`ManuscriptGroup.readChapterTitle` 对「既无 outbox 标题、又无蓝图」的定稿会回落到
**正文首行**当标题（函数注释写明这是有意的）。但 `authoritative-chapter-title` 用例里
那条 `db:draft-get-full` mock 特意把正文写成 `# 不应读取的正文首行`，并在另一条用例中断言
`not.toContain('不应读取的正文首行')`——即测试认为这条回落不该发生。

这处矛盾此前被一个**竞态**掩盖：正文读取用的是动态 `import()`，首帧断言跑在它落定之前，
所以只看到 `第{n}章` 兜底名。把动态导入改成静态导入后该用例立刻失败（最终态两条路径完全
一致，只是时序变了）。本轮因此**保持动态导入不动**（见该文件注释），把选择留给产品：
要么承认正文首行兜底、改测试；要么去掉这条兜底、让定稿在无标题时只显示 `第{n}章`。

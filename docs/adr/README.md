# 架构决策记录（ADR）全景导航与分类矩阵

> 本目录记录 AI-Novel-Writer（Vela）自立项以来的重大设计决策。
> **双层治理原则（架构基石 vs 业务功能）**：
> 为彻底杜绝文档与代码脱节的“文档腐化（Documentation Rot）”顽疾，我们将所有决策严格解耦为两大独立维度：
> 1. **系统架构（`architecture/`）**：决定软件技术选型、底层运行底座、安全围栏与长效基础设施的不可逆法典，坚如磐石；
> 2. **业务功能（`features/`）**：针对小说创作特定领域实体的业务设计规则，遵循“常用常新”原则，随产品功能演进及时更新或替代。

---

## 一、 系统架构决策（System Architecture — `architecture/`）

记录底层技术栈、数据库引擎、Pi Agent 现代底座、跨环境编译与系统安全基石（共 11 篇）：

| 编号 | 决策标题 | 核心效力与架构定位 |
| :--- | :--- | :--- |
| [`0001`](architecture/0001-core-tech-stack-and-local-first.md) | 核心技术栈与本地优先（Local-first）哲学 | Electron + React 19 + CodeMirror 6，创作者对物理文件拥有绝对所有权，零云端绑定 |
| [`0002`](architecture/0002-sqlite-embedded-database-and-dual-abi.md) | SQLite 嵌入式存储与 Node/Electron 跨环境双 ABI 共存架构 | 选型 `better-sqlite3` 同步事务底座，构建双二进制旁路隔离，彻底解决单元测试与应用运行的 ABI 冲突死锁 |
| [`0003`](architecture/0003-user-mediated-file-capabilities-and-sandbox.md) | 用户介导的外部文件授权与路径围栏沙盒 | 外部文件读取必须经由用户显式介导，系统严禁擅自越权窥探工作区外任意物理文件 |
| [`0004`](architecture/0004-versioned-embedding-space-and-knowledge-base.md) | 版本化项目嵌入空间与向量索引代际隔离 | 知识库向量嵌入按项目与模型代际物理隔离，严禁跨模型语义污染 |
| [`0005`](architecture/0005-three-target-platform-release-and-updates.md) | 三目标平台自动化构建、资格验证与更新架构 | 同源源码构建 Windows / macOS 产物，更新以保护创作者未保存正文为最高准则 |
| [`0006`](architecture/0006-controlled-agent-actions-and-workflow-seams.md) | AI 动作受控 Seam 机制与领域事实写入边界 | 严禁大模型通过通用文件操作裸写数据库或直改文件，所有事实变更必须走强类型 Seam |
| [`0007`](architecture/0007-pi-agent-native-foundation-and-tool-calling.md) | 全面拥抱 Pi Agent 底座与原生 Tool Calling 标准 | 彻底废除自研文本协议与正则解析，全面复用 Pi 原生标准，拒绝重复造轮子 |
| [`0008`](architecture/0008-assistant-scopes-project-and-global.md) | 创作助手双作用域物理隔离（项目助手与全局助手） | 项目助手知晓小说事实 vs 全局助手通用辅助，工具集按作用域物理裁剪 |
| [`0009`](architecture/0009-agent-harness-orchestration-and-unified-semantics.md) | Pi AgentHarness 执行编排与统一采样/写入安全架构 | Harness 接管多轮生命周期，助手对话与工作流生成共用采样参数与原子写入熔断保护 |
| [`0010`](architecture/0010-skill-catalog-loaded-through-pi-loader.md) | 技能目录（Skill）按 Pi 原生规范与加载器解析 | 直接复用 Pi 原生加载器解析 YAML frontmatter，规范诊断完全透明化展示 |
| [`0011`](architecture/0011-single-source-of-truth-agent-session-storage.md) | 创作助手会话原生化与单一真实数据源 | 彻底废除前端写盘，100% 以 Pi Agent 原生 `JsonlSessionRepo` 为单一事实源 |

---

## 二、 业务功能决策（Feature Specifications — `features/`）

记录长篇小说创作特定业务领域的实体心智、连续性法则与功能交互边界（常用常新，共 7 篇）：

| 编号 | 决策标题 | 业务领域与核心规则 |
| :--- | :--- | :--- |
| [`0001`](features/0001-finalization-commit-and-manuscript-publication.md) | 定稿正文不可变提交与实体稿物理发布 | 定稿是 SQLite 中的不可变事实源，物理 Markdown 是可恢复的只读发布投影 |
| [`0002`](features/0002-structured-character-roster-fact-source.md) | 结构化角色名册作为唯一事实源，角色图谱为只读派生投影 | 角色事实唯一源自结构化名册，关系图谱为单向只读快照，杜绝排版反向解析崩溃 |
| [`0003`](features/0003-recoverable-finalized-chapter-deletion.md) | 定稿章节安全删除与可恢复投影清理 | 删除已定稿章节先冻结事实与操作凭据，外围实体稿与切片异步幂等清理，直接绑定稳定项目 ID 与物理路径 |
| [`0004`](features/0004-project-writing-language-independent-from-ui.md) | 小说写作语言与应用界面显示语言彻底解耦 | 写作语种（小说正文、大纲、AI 提示词）与 IDE 界面显示语言互相独立 |
| [`0005`](features/0005-finalized-continuity-projection-and-narrative-threads.md) | 连续性推演严格源自定稿事实，叙事线索计划分层 | 连续性事实与人物状态唯一源自已定稿正文，作者伏笔计划具有不可侵犯最高优先级 |
| [`0006`](features/0006-plot-tree-is-a-derived-snapshot.md) | 剧情树作为可重建的只读派生快照 | 剧情树只用于主支线全景浏览与导航，不反向篡改大纲，避免双重事实源 |
| [`0007`](features/0007-writing-skills-are-stage-scoped-guidance.md) | 写作技能（Skill）按创作阶段隔离与自包含约束 | Skill 严格按大纲/细纲/起草/审稿阶段隔离，工作流启动即冻结，纯提示词自包含 |

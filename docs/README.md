# 项目文档导航与治理约定

本目录保存可随代码审查、发布和长期维护的项目文档。不同 Worktree 是独立的代码与文档快照；只有当前分支中已跟踪的文件能作为该分支的文档证据，不能把其他 Worktree 的未提交材料当成当前事实。代码审查与功能验证必须以当前分支代码和测试为准。

## 文档权威层级

| 文档 | 用途 | 权威与生命周期 |
| --- | --- | --- |
| [`README.md`](../README.md)、[`README_en.md`](../README_en.md) | 面向用户的产品定位、安装、隐私和能力概览 | 当前公开产品说明；中英文需要同步 |
| [`docs/product-domain.md`](product-domain.md) | 稳定产品术语、事实源和边界 | 可发布的领域词汇表；实现和规格应使用这里的名称 |
| [`docs/adr/`](adr/) | 难以从代码恢复的架构决定、边界和取舍 | 现行生效决定；分 architecture 与 features 双层管理 |
| [`docs/agents/`](agents/) | Issue、领域文档和 Agent 协作规则 | 当前贡献流程；不得承载临时任务状态 |
| [`docs/research/`](research/) | 有来源和时间边界的调研与底座选择 | 历史证据；不自动代表当前产品承诺 |

根目录 `AGENTS.md` 与 `CONTEXT.md` 是可选的本机 Agent 上下文，按仓库卫生规则保持忽略，不是公共文档，也不能覆盖 [`docs/product-domain.md`](product-domain.md) 或 ADR。需要进入公共仓库的稳定产品边界写入领域词汇表或 ADR；公开用户行为同步到中英文 README。

## 新文档放置规则

- 当前用户行为写入 README；不要复制发布资产清单，精确资产合同由 [`.release/release-profile.json`](../.release/release-profile.json) 维护。
- 稳定领域术语先更新 [`docs/product-domain.md`](product-domain.md)；本机 `CONTEXT.md` 只能补充当前 checkout 的 Agent 说明。
- 难以逆转的架构决定新增连续编号 ADR。实现进度、测试记录和待办不写入 ADR。
- 带日期的调研保留来源、采集时间和适用边界；实现完成不会自动把调研升级为产品合同。
- 临时计划和交接使用日期化文件。交接文档必须注明分支、基准 SHA、脏状态和未验证事项。
- 不在文档中复制 API Key、模型凭据、小说测试内容、用户目录或可再生构建输出。

## Worktree 边界

审计或接手任务时先运行 `git worktree list --porcelain`，再在目标 Worktree 内记录分支、SHA 和 `git status --short`。移动、合并或删除 Worktree 属于单独的清理任务；文档治理不授权这些操作。

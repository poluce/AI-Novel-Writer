# 移除 NovelAI 预设（独立于 Pi 迁移）

> 与 [`2026-09-10-pi-agent-migration-todo.md`](2026-09-10-pi-agent-migration-todo.md) **不是同一项工作**。Pi 迁移不删 NovelAI；本文件才是删除范围与待办。
> 本文档只整理待办，不承载实现细节。未验收前不改 README/ADR 定论。

## 为什么单独做

NovelAI 预设是产品线问题（默认 8K 上下文、最小兼容、无真实账户验收），不是「换成 pi-ai 就必须删」。
Pi 迁移即使给生成加了 `toolCalling` 门控，也不等于本任务：门控只是提示不能当生成模型；本任务是拿掉预设、兼容分支和文档。

## 拟删除范围（代码盘点）

- 预设：`src/shared/provider-presets.ts` 的 NovelAI 项
- 协议联合：`src/shared/ipc-channels.ts` 的 `'novelai'`
- 设置 UI：`SettingsModal.tsx` 选项与分支
- 请求特例：`electron/llm/openai-provider.ts`（不发 `response_format` / 思考参数兼容 / `stream_options`）
- URL：`electron/llm/openai-compatible-endpoint.ts` 对 `provider === 'novelai'` 的路径
- 测试：`electron/llm/__tests__/openai-provider.test.ts` 中 NovelAI compatibility
- 用户文档：`README.md` / `README_en.md` 的 NovelAI 小节与 OpenAI-compatible 列表中的 NovelAI 字样
- i18n 里若有仅服务该预设的文案一并清理

**不在本任务：** 用户 `~/.vela/models.json` 里已保存的 NovelAI 条目怎么提示/迁移（若做，验收时再定，未验证不写进 README）。

## 待办（✅ 已完成）

- [x] 删除预设、`'novelai'` 联合成员、设置页选项
- [x] 删除 OpenAI provider / endpoint 的 NovelAI 特例分支
- [x] 删除或改写仅覆盖 NovelAI 的测试
- [x] 中英文 README 去掉 NovelAI 小节与列表提及
- [x] `pnpm typecheck` / `pnpm test` / `pnpm check:i18n` / `pnpm build`
- [ ] 验收后再改正式文档定论（若有 ADR 提到最小兼容，一并处理）

## 实际执行记录

| 文件 | 改动 |
| --- | --- |
| `src/shared/provider-presets.ts` | 删除 NovelAI 预设项（剩余 8 个 provider） |
| `src/shared/ipc-channels.ts` | `ModelProfile.provider` 联合移除 `'novelai'` |
| `src/components/settings/SettingsModal.tsx` | 删除服务商下拉选项与 `providerIcon` 的 `case 'novelai'` |
| `electron/llm/openai-provider.ts` | 删除 `isNovelAI` 及其 3 处特例（`reasoning_effort` / `response_format` / `stream_options` 现在对全部 provider 一致发送） |
| `electron/llm/openai-compatible-endpoint.ts` | 删除 `provider === 'novelai'` 路径分支，`provider` 参数已无用途故一并移除；调用点同步更新 |
| `electron/llm/__tests__/openai-provider.test.ts` | fixture `novelAIModel` → `baseModel`（provider 改 `custom`）；删除 2 个 NovelAI 专属用例；`describe` 标题去掉 NovelAI |
| `README.md` / `README_en.md` | 删除 NovelAI 小节与 OpenAI-compatible 列表中的 NovelAI 字样 |

**未发现**仅服务该预设的 i18n 文案（`pnpm check:i18n` 通过）。

**遗留（本任务范围外，按文档第 22 行）**：用户 `~/.vela/models.json` 中已保存的 NovelAI 条目不再有对应预设，加载时的提示/迁移行为未在本次处理。

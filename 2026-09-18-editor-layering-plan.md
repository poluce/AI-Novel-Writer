# 编辑器分层重构计划（2026-09-18）

> **文档定位**：`src/components/editor/CodeMirrorEditor.tsx` 的分层重构路线图与验收口径。
> **前置文档**：[`docs/plans/2026-09-18-legacy-communication-layer-artifacts.md`](docs/plans/2026-09-18-legacy-communication-layer-artifacts.md)（§6.4 记录编辑器 AI 动作收编进助手）、[`docs/agent-tools-inventory.md`](docs/agent-tools-inventory.md)。
> **当前状态**：步骤 0、1 已完成并推送（见 §七）；步骤 2–5 待做；步骤 6 明确暂不做。

---

## 一、问题与目标

### 1.1 问题

`CodeMirrorEditor.tsx` 是**唯一**直接对接编辑器引擎（CodeMirror 6）的地方，`DraftEditor`（章节正文）/ `ArchFileViewer`（架构文档）/ `EditorArea`（中间编辑区）三处都复用它。但一个文件里同时装着三类东西：

1. **引擎面**：内容与外部同步、`handleUpdate`、主题、`extensions`、`basicSetup`；
2. **业务特性**：批注、行内修订（draft diff）、AI 动作派发、助手引用；
3. **视图**：浮动条、右键菜单、状态栏。

后果：改任何一处都要在七百行里找；业务规则（例如"批注区间怎么跟着正文改动重映射"）无法脱离编辑器渲染单独测试；上一代"就地 AI 预览条"的残留能在这里躺很久没人敢删（已在步骤 0 清理）。

### 1.2 目标

- 主组件回到**引擎面 + 组合点**，业务特性各自成模块；
- 每个特性**可以单独测**（纯函数模块不需要 React，展示组件不需要起整个 CodeMirror）；
- **三条硬约束**：不动 `props`（3 个使用方零改造）、不改行为、每步单独可验证。

### 1.3 验收口径

一步算完成，必须同时满足：

- `tsc --noEmit` 干净；
- 全仓 `eslint . --ext ts,tsx --max-warnings 0` 通过（新增文件同样受 emoji、语义色 token 等既有契约约束）；
- 浏览器套件全绿（编辑器行为的真正防线，见 §五）；
- 改动只搬代码不改行为：**除非某步明确要改语义，否则既有用例不允许修改**。

---

## 二、现状盘点（步骤 1 完成时实测，共 694 行；全部完成后为 289 行）

| 段落 | 行数 | 性质 | 目标归属 |
|---|---|---|---|
| imports | 25 | — | 保持 |
| `CodeMirrorEditorProps` | 22 | 契约 | 保持 |
| `EditorAIAction` + `AI_ACTIONS` | 14 | 业务常量 | ✅ 步骤 3 |
| 组件签名与 props 解构 | 20 | — | 保持 |
| store 读取、`editorRef`、内容同步 state | 11 | 引擎面 | 保持（步骤 2 可评估） |
| 外部内容同步 effect | 15 | 引擎面 | 保持 |
| 浮动条状态 + 右键菜单 effect | 17 | 交互 | ✅ 步骤 2 |
| 两个 hook 接线（批注 / 行内修订） | 31 | — | 已完成（步骤 1） |
| `applySelectionRange` | 8 | 两层接缝 | ✅ 步骤 2（跨层通知显式化） |
| `handleUpdate` | 26 | 引擎面 + 组合 | **保持**（见 §三.3） |
| 浮动条跟随定位 effect | 61 | 交互 | ✅ 步骤 2 |
| `cmTheme` | 117 | 纯配置 | ✅ 步骤 4 |
| `extensions` | 58 | 纯配置 | ✅ 步骤 4 |
| `handleAddAnnotation` | 7 | 业务收尾 | 保持（组合点） |
| `handleAIAction` | 27 | 业务 | ✅ 步骤 3 |
| `handleContextMenu` | 10 | 交互 | ✅ 步骤 2 |
| `handleAddToAssistant` | 25 | 业务 | ✅ 步骤 3 |
| `cmBasicSetup` | 11 | 纯配置 | ✅ 步骤 4（并入 theme 模块） |
| JSX（浮动条 / 右键菜单 / 状态栏 / `<CodeMirror>`） | 186 | 视图 | ✅ 步骤 5 |

> 目标形态与实际结果：预估主组件落在 **220–260 行**，实际 **289 行**——比预估多一点，
> 差在 `handleUpdate`（引擎唯一更新入口，约 26 行）与 `handleBold`/`handleAddAnnotation`
> 两个组合点，以及新写的接线注释。内容是 props → 状态 → 四个 hook → `<CodeMirror>` +
> `<EditorSelectionBubble>` + `<EditorContextMenu>`，即计划想要的那层"引擎面 + 组合点"。

---

## 三、分层原则

### 3.1 三层的边界

- **引擎面**：只关心"内容、选区、装饰、视口、只读、键盘"。不认识批注、助手、工作流。
- **业务层（hooks）**：持有各自的状态与规则（批注的区间重映射与上限、修订提案的装饰、AI 动作到助手引用的映射），通过参数拿到 `viewRef` 与回调，**不直接读业务 store**（需要时由调用方传入）。
- **视图层**：受控展示组件，状态由上层给，事件向上抛。

### 3.2 状态归属的判定规则

一句话：**谁的规则，谁持有状态**。若一条状态的存在只为了让某个业务规则成立（例如"批注草稿属于上一个选区"），状态就属于那个业务层；若一条状态描述的是引擎自身（内容快照、`extensions` 记忆化），它属于引擎面。

### 3.3 明确不拆的四项（避免过度拆分）

| 不拆 | 理由 |
|---|---|
| `handleUpdate` | 引擎唯一的更新入口，同时牵着"开关浮动条 / 批注输入焦点 / 字数统计"。拆开等于把一次输入发生了什么散到三处，读代码要跳三个文件 |
| `applySelectionRange` 的跨层通知 | 选区变化要清批注草稿——这正是两层之间的接缝，摆在明面上比藏进 hook 里好 |
| `cmBasicSetup` 单独成文件 | 仅 11 行，并入 `editor-theme.ts` 即可 |
| 重新分组 `props` / 改组件 API | 有 3 个使用方，收益只有在"纯编辑面要被第二处复用"时才兑现 |

---

## 四、分步计划

### 步骤 0 ✅ 清掉上一代"就地 AI 预览条"的死代码

- **提交**：`0e0c6fb`（净减 137 行，组件 915 → 778）。
- **内容**：删除 `aiResult` / `aiError` / `activeAIAction` / `loadingDots` / `aiTargetRef` / `aiRequestSequenceRef`、`handleAcceptAI` / `handleRejectAI`、浮动条里的预览分支、空壳 `onMouseDown`、只被"替换"按钮用到的 `Check` 图标。
- **背景**：编辑器 AI 动作已统一为"带选区引用的 Agent Quick Task"（审计文档 §6.4），该链路无入口。原守卫已搬迁：只读拒绝 / 原文已变拒绝 → `apply-draft-excerpt.test.ts`；租约释放 → `generation-runtime.test.ts`；派发契约 → `CodeMirrorEditor-ai-handoff.browser.tsx`。

### 步骤 1 ✅ 抽出批注与行内修订

- **提交**：`5554483`（组件 778 → 694）。
- **新增**：`use-draft-annotations.ts`（131 行）、`use-draft-diff-decorations.ts`（76 行）。
- **设计要点**：`addAnnotation()` 只回答"落库成没成"（返回 boolean），关浮动条与清选区留在组件——那是浮动条的事；`use-draft-diff-decorations` 与既有 `use-draft-diff-proposals` 形成"渲染呈现 / 数据来源"分工。
- **接线方式**：解构接钩子并沿用原名（`compartment` / `note` / `inputFocusedRef`），因此 JSX 与 `extensions` 基本未动。

### 步骤 2 ⬜ `use-editor-bubble.ts`（浮动条）

- **搬走**：浮动条 state（`bubbleOpen` / `bubblePos` / `selectionRange` / `selectionRangeRef`）、61 行跟随定位 effect、右键菜单 state 与关闭 effect、`handleContextMenu`、`applySelectionRange`。
- **接口**：`useEditorBubble({ viewRef, onSelectionChange })` → `{ bubbleOpen, bubblePos, selectionRange, contextMenu, setContextMenu, openBubble(range), closeBubble(), applySelectionRange(next), handleContextMenu(event) }`。
- **跨层依赖处理**：选区变化要清批注草稿 → 由组件传 `onSelectionChange: clearAnnotationDraft`，让接缝留在组件里（§3.3）。
- **验收**：`CodeMirrorEditor-caret` / `CodeMirrorEditor-ai-handoff` / `CodeMirrorEditor-diff` 三个浏览器用例不改动仍全绿。
- **风险**：中。跟随定位 effect 依赖 `bubbleOpen` + `selectionRange` 两个 state 的时序，搬动时必须保持依赖数组语义不变。

### 步骤 3 ⬜ `use-editor-ai-handoff.ts`（AI 动作派发）

- **搬走**：`EditorAIAction` 类型与 `AI_ACTIONS` 常量、`handleAIAction`、`handleAddToAssistant`，以及两处重复的"选区 → `DraftPassageCitation`"构造（提取为一个 `buildCitation()`）。
- **接口**：`useEditorAiHandoff({ viewRef, selectionRange, chapterNumber, draftId, draftVersion, filePath })` → `{ aiActions: AI_ACTIONS, runAIAction(action), addSelectionToAssistant(from, to) }`。
- **注意**：这是唯一直接调用 `useAgentStore` / `useLayoutStore` 的业务块；抽走后主组件不再认识"助手"，引擎面彻底与业务解耦（若坚持 §3.1 的"业务层不读 store"，可把两个回调作为参数传入，二选一在此步定）。
- **验收**：`CodeMirrorEditor-ai-handoff.browser.tsx`（中文/英文两条派发断言）不改动仍全绿。
- **风险**：低。

### 步骤 4 ⬜ 纯配置层三件套

- **`editor-theme.ts`**：`cmTheme`(117) + `cmBasicSetup`(11) → `buildEditorTheme()` / `EDITOR_BASIC_SETUP`。**纯配置、零状态**，可脱离 React 断言（例如"只读态不显示光标高亮"）。
- **`editor-search-phrases.ts`**：搜索/替换面板的中英文词条（现埋在 `extensions` 里）→ `buildSearchPhrases(locale)`，让 i18n 词条集中可审。
- **`editor-extensions.ts`**：`extensions`(58) → `buildEditorExtensions({ mode, locale, annotationCompartment, diffCompartment, ... })` 纯函数，把 markdown / keymap / 搜索本地化 / 两个 compartment 的挂载集中到一处。
- **验收**：`CodeMirrorEditor-diff` 与 `draft-diff.test.ts` 全绿；搜索框文案在英文界面下不变（`CodeMirrorEditor-ai-handoff` 的英文用例顺带覆盖）。
- **风险**：低。唯一要小心的是 `extensions` 的记忆化依赖是**刻意**排除批注/差异的（进了依赖就会重建扩展 = 重置编辑器），搬迁时注释与依赖必须原样保留。

### 步骤 5 ⬜ `EditorSelectionBubble.tsx`（视图层）

- **搬走**：浮动条那约 130 行 JSX（批注输入 + 加粗 + 四个 AI 动作 + 定位样式）、"添加到助手"的 portal（约 25 行）。
- **接口**：受控组件，`{ open, position, locale, annotationNote, onAnnotationNoteChange, atAnnotationLimit, onAddAnnotation, onBold, aiActions, onRunAIAction }`。
- **收益（不止行数）**：现在测浮动条必须渲染整个 CodeMirror；拆出后可直接渲染这个组件断言文案与禁用态。
- **验收**：现有三个编辑器浏览器用例全绿，且**新增**一条针对浮动条的展示用例（文案、批注达上限时的禁用态）。
- **风险**：中。JSX 搬移容易出现事件处理与 `onMouseDown` 阻止焦点丢失之类的细节遗漏，需逐块搬并保持 DOM 结构不变。

### 步骤 6 ⏸ 可选：`EditorSurfaceAdapter` 接口（**暂不做**）

- **内容**：定义一层引擎无关接口（value / onChange / selection / decorations / scrollTo / 命令句柄），把 CodeMirror API 关进适配器，主组件只依赖接口，将来换内核（Monaco / Lexical）只改适配器。
- **暂不做的理由**：目前只有一种引擎、三处使用，收益要等真有第二种引擎才兑现；属于"为将来可能发生的事先交税"，且届时才知道接口该长什么样。**触发条件**：出现第二个编辑器内核需求，或有第三方要复用"纯编辑面"。

---

## 五、回归防线

### 5.1 现有测试守什么

| 用例 | 守住的行为 | 与哪几步相关 |
|---|---|---|
| `CodeMirrorEditor-ai-handoff.browser.tsx` | 选中正文 → 点动作 → 引用进输入框、助手面板打开、提示词按界面语言下发 | 步骤 2 / 3 / 5 |
| `CodeMirrorEditor-caret.browser.tsx` | 光标是文本指针；各皮肤下光标高对比（浅色 `#1D4ED8`、纸色朱砂、深色白） | 步骤 4 / 5 |
| `CodeMirrorEditor-diff.browser.tsx` + `use-draft-diff-proposals.browser.tsx` | 行内修订的渲染与"合并 / 放弃"链路 | 步骤 1 / 4 / 5 |
| `draft-diff.test.ts` | 装饰构建纯函数（区间、越界、locale 文案） | 步骤 1 / 4 |
| `src/services/agent/__tests__/apply-draft-excerpt.test.ts` | 真正写入正文处的守卫：只读拒绝、匹配不唯一拒绝、原文已变拒绝 | 步骤 3（派发目标不变） |
| `src/tokens` / `semantic-status-text-source-contract` / `app-skin-background` | 新文件必须继续遵守语义色 token 与无 emoji 的契约 | 每一步（新增文件） |

### 5.2 每步必跑命令（WSL 环境）

```bash
# 类型与静态检查
"/mnt/c/Program Files/nodejs/node.exe" ./node_modules/typescript/bin/tsc --noEmit
"/mnt/c/Program Files/nodejs/node.exe" ./node_modules/eslint/bin/eslint.js . --ext ts,tsx \
  --report-unused-disable-directives --max-warnings 0

# 浏览器套件：编辑器行为的真正防线（53 文件 / 311 用例）
"/mnt/c/Program Files/nodejs/node.exe" ./node_modules/vitest/vitest.mjs run --config vitest.browser.config.ts
```

### 5.3 原生模块 ABI（已改为双份共存）

`better-sqlite3` 仍按运行时编译，但 **Node 版放在 `node_modules/.native-abi/`，Electron 版留在包内 `build/Release`**，测试不再覆盖应用用的那份。

```bash
"/mnt/c/Program Files/nodejs/node.exe" ./scripts/prepare-native-for-node.mjs
"/mnt/c/Program Files/nodejs/node.exe" ./node_modules/vitest/vitest.mjs run
# 不必再切回 Electron；应用可保持运行
```

应用开着也可以准备 Node 旁路并跑 SQLite 测试。`pnpm dev` 的 `predev` 仍负责包内 Electron 版。

### 5.4 现有环境性失败（与代码无关，不要误判）

- `scripts/__tests__/public-repository-hygiene.test.ts`：断言仓库不应包含内部流程文件，而工作区存在本地 `AGENTS.md`（已被 `.gitignore` 忽略，从未进入任何提交）。

---

## 六、风险与回退

- 每一步**单独提交**，提交信息写明"搬了什么、为什么这样切、验证结果"；某步若引入回归，直接回退该 commit 即可，步骤之间无相互依赖。
- 步骤 2 与 5 风险最高（时序与 JSX 事件细节），因此排在步骤 3、4 两侧，便于隔离问题。
- 全程不改 `props`：3 个使用方（`DraftEditor` / `ArchFileViewer` / `EditorArea`）无需改动；若某步发现必须改 props，说明分层判断错了，应停下来重估而不是顺手改调用点。

---

## 七、进度记录

| 步骤 | 内容 | 状态 | 提交 |
|---|---|---|---|
| 0 | 清掉"就地 AI 预览条"死代码（915 → 778 行） | ✅ 已推送 | `0e0c6fb` |
| 1 | 抽出批注 / 行内修订 hooks（778 → 694 行） | ✅ 已推送 | `5554483` |
| 2 | `use-editor-bubble.ts`（694 → 610 行） | ✅ 已推送 | `b631544` |
| 3 | `use-editor-ai-handoff.ts`（610 → 569 行） | ✅ 已推送 | `effef37` |
| 4 | `editor-theme.ts` / `editor-search-phrases.ts` / `editor-extensions.ts`（+ 纯函数收口 `draft-annotations.ts`；569 → 398 行） | ✅ 已推送 | `4d6f134` |
| 5 | `EditorSelectionBubble.tsx` + 独立展示用例 6 条（398 → 289 行） | ✅ 已推送 | `10dc7ee` |
| 6 | `EditorSurfaceAdapter`（可选） | ⏸ 暂不做 | — |

> 步骤 1 的验证基线：浏览器套件 53 文件 / 311 用例全绿；完整 Node 套件 329 文件 / 327 通过（2860 用例通过 / 1 失败 / 10 skipped，失败项为 §5.4 的两条环境性问题）。
>
> 步骤 5 完成后的基线：浏览器套件 **54 文件 / 317 用例**全绿；完整 Node 套件 **2860 用例通过 / 1 失败 / 10 skipped**（同上两条环境性问题）。
>
> 最终形态：`CodeMirrorEditor.tsx` **289 行**（起点 915 行），拆出的模块为
> `use-editor-bubble.ts`(164) / `use-editor-ai-handoff.ts`(105) / `use-draft-annotations.ts`(100) /
> `use-draft-diff-decorations.ts`(76) / `editor-theme.ts`(146) / `editor-extensions.ts`(73) /
> `editor-search-phrases.ts`(33) / `draft-annotations.ts`(43) / `EditorSelectionBubble.tsx`(199)。

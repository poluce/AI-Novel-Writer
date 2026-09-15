# ADR 0022：技能目录按 SKILL.md 规范加载

- 状态：已采纳（2026-09-15）
- 相关：[0015 写作 Skill 是按阶段冻结的补充指导](0015-writing-skills-are-stage-scoped-guidance.md)、[0021 助手会话改由 Pi AgentHarness 编排](0021-agent-runs-on-pi-harness.md)

## 背景

应用一直有自己的 SKILL.md 扫描器：`skills:list-user` 读用户目录，项目技能由渲染层通过 `fs:*` 通道逐个目录读，然后两边各自用同一个简易 `key: value` 解析器解析 frontmatter。

对照 Pi 自带的加载器（`harness/skills.ts`，声明自己输出 agentskills.io 规范兼容的技能清单），这套扫描器有几处偏差：

1. **frontmatter 不是真 YAML**：`description: >` 折叠块、列表、多行值都会解析错。
2. **名字校验与规范不同**：规范要求小写 `a-z0-9-`、≤64 字符、不能以连字符开头/结尾、不能有 `--`，**且必须与所在目录同名**；我们允许大写、下划线、点，长度放到 128，也不校验目录名。
3. **缺规范行为**：不支持忽略文件（`.gitignore` / `.ignore` / `.fdignore`）、不支持技能根目录下直接放 `.md`、不跳过点目录与 `node_modules`。
4. **不合规就静默消失**：解析失败的技能直接不进注册表，用户在界面上看不到任何原因。
5. 描述长度上，规范是 >1024 即判定无效；我们把它截到 300 字符（提示词预算）——这是产品决定，保留。

## 决策

**目录发现与解析交给 Pi 的加载器**（`loadSourcedSkills` + `NodeExecutionEnv`），应用只留产品语义。

1. 新增主进程模块 `electron/services/writing-skill-catalog.ts`：一次扫描用户级与项目级两个根，返回 `{ skills, diagnostics }`。
   - 技能记录里保留应用扩展字段（`display_name` / `version` / `language` / `stage`）与写作技能兼容性判定（`inspectWritingSkillMarkdown`，ADR 0015 的规则）。
   - Pi 的规范诊断原样带出（名字不符规范、描述超长/缺失、读取失败、YAML 解析失败）。
2. **IPC 分成两条通道**，边界与作用域一致：
   - `skills:load-user-catalog`：应用数据边界，不带项目会话；
   - `skills:load-catalog`：**项目会话范围**，主进程先认证项目身份与租约，再把项目技能根钉在项目内（`assertProjectFilePath`）。
   - 渲染层不再自己翻目录：注册表只做「目录记录 → 注册表条目」的映射。
3. **不合规不再静默**：规范违规的技能仍然进列表（与 Pi 的行为一致：警告但保留），诊断在设置 → 写作 Skill 的「技能目录诊断」里显示，含原始 message 与文件路径。
4. **正文以磁盘为准**：`load_writing_skill` 在 `location` 落在允许的技能根内时直读 `SKILL.md`（重新解析出正文），读不到才回落到目录快照。允许的根由主进程给出（用户级技能根 + 当前项目技能根），越界一律不读。
5. **ADR 0015 的收窄保持不变**：只收自包含提示词技能。规范允许技能包携带 `scripts/`、`references/`，我们仍判为不兼容——这是产品边界，现在也写进了面向用户的领域文档（`docs/product-domain.md`）。

## 结果

- 第三方技能包按规范写就能被正确发现：真 YAML、忽略文件、根级 `.md`、`disable-model-invocation` 全部生效。
- 名字/描述不合规时用户能看到原因（例如 `name "SceneCraft" does not match parent directory "scene-craft"`），而不是"我装的技能没出现"。
- 技能正文改了之后下一次 `load_writing_skill` 就能读到新内容，不再被加载时的快照卡住。
- 项目技能不再由渲染层逐目录读，和其余项目数据一样走项目会话认证。

## 取舍

- **多了一次重复读**：Pi 的加载器读一遍 `SKILL.md`，我们为了拿扩展字段再读一遍。文件很小，换来的是「规范字段走规范解析、产品字段走产品解析」的清晰分工。
- **诊断文案来自 Pi，是英文**：按数据展示，不做二次翻译；否则每条规范错误都要在应用里维护一份译文。
- **应用扩展字段仍用简易解析器**（`stage` / `language` / `display_name` / `version`）：它们是可选项，YAML 里写成块标量时读不到就退回 `suggestedStage()` 猜测，不影响技能可用性。
- **描述上限仍是 300 字符**：规范说 1024 以上无效，我们只在提示词清单里截断显示，不拒绝技能。

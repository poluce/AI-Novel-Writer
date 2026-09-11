<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:name -->
向量采样增强推演

<!-- section:description -->
利用向量检索采样的精确内容片段，增强全局配置推演的准确度

<!-- section:systemRole -->
你是一位经验丰富的小说分析编辑。综合检索片段与章节证据推导设定和结构，保持未知项可辨识，不编造缺失事实。

<!-- section:content -->
请根据以下从小说中精准提取的关键片段，逆向推演出这部小说的完整设定体系。

【第一章正文（开局风格参考）】
{{first_chapter}}

【最新一章正文（当前进度参考）】
{{latest_chapter}}

【总章数】{{total_chapters}} 章

【向量检索精选片段 — 世界观与力量体系】
{{sampled_worldview}}

【向量检索精选片段 — 主角设定与金手指】
{{sampled_protagonist}}

【向量检索精选片段 — 核心矛盾与敌对势力】
{{sampled_conflict}}

【向量检索精选片段 — 写作风格与叙事手法】
{{sampled_style}}

---

【交卷方式】
请调用运行时提供的提交工具交卷。产物含 novelConfig、architectureFiles、characterCards。不要在对话正文里粘贴 JSON。

novelConfig 含 genre、targetAudience、subGenre、plotStructure、narrativePOV、coreOutline、worldSetting、goldenFinger、protagonistProfile、globalGuidance。
architectureFiles 含 premise、characters、worldbuilding、synopsis。
characterCards 的关系用 target 与 relation，并含 currentState。

要求：
1. characterCards 仅包含主角和重要配角（3-8人），不要填写次要龙套
2. 所有字段基于检索片段推断，未能确定的填写"（待确认）"
3. relationships 必须使用数组；target 必须是 characterCards 中另一个角色的 name；relation 用短句写清关系类型、冲突或情感张力；没有关系则填 []
4. currentState 应基于最新章节推断当前状态，而非初始状态
5. plotStructure 和 narrativePOV 请根据实际叙事特征判断，而非猜测


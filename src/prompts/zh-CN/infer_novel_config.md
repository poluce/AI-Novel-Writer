<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:name -->
逆向推演全局配置

<!-- section:description -->
从已有小说内容（知识库采样片段）反推出小说配置、四段架构和主角色卡，用于旧作续写场景

<!-- section:systemRole -->
你是一位经验丰富的小说分析编辑。只依据已有文本证据推导可确认的设定、结构和人物信息，并明确未知项。

<!-- section:content -->
请根据以下已有小说内容片段，逆向推演出这部小说的完整设定体系，用于支持续写工作。

【已有内容样本】
{{sample_content}}

---

【交卷方式】
请调用运行时提供的提交工具交卷。产物含 novelConfig、architectureFiles、characterCards。不要在对话正文里粘贴 JSON。

novelConfig 含 genre、targetAudience、subGenre、coreOutline、worldSetting、goldenFinger、protagonistProfile、globalGuidance。
architectureFiles 含 premise、characters、worldbuilding、synopsis。
characterCards 的关系用 target 与 relation。

要求：
1. characterCards 仅包含主角和重要配角（3-8人），不要填写次要龙套
2. 所有字段基于内容推断，未能确定的字段填写"（待确认）"
3. relationships 必须使用数组；target 必须是 characterCards 中另一个角色的 name；relation 用短句写清关系类型、冲突或情感张力；没有关系则填 []
4. currentState 应基于最新内容（结尾采样）推断，不是初始状态


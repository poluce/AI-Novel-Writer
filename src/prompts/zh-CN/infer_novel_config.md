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

请严格按照以下 JSON 格式返回分析结果：

{
  "novelConfig": {
    "genre": "主类型（玄幻/仙侠/都市/科幻/历史/悬疑/游戏/军事/奇幻/武侠/现实/其他）",
    "targetAudience": "受众（男频/女频/通用）",
    "subGenre": "细分类型及标签",
    "coreOutline": "核心大纲（150字以上，含主线目标、核心冲突、故事走向）",
    "worldSetting": "世界观背景与力量体系",
    "goldenFinger": "主角金手指/核心能力体系",
    "protagonistProfile": "主角人设（性格、背景、核心驱动力）",
    "globalGuidance": "根据已有内容归纳的全局写作风格与节奏要求"
  },
  "architectureFiles": {
    "premise": "核心故事前提文本（200字以内的高度浓缩核心）",
    "characters": "已知主要角色的关系网与动力学分析",
    "worldbuilding": "世界观矩阵（力量体系、阶层结构、重要场景）",
    "synopsis": "已知的情节走向分析（含已完成的部分和推测的后续走向）"
  },
  "characterCards": [
    {
      "name": "角色名",
      "role": "protagonist/antagonist/supporting/minor",
      "gender": "性别",
      "age": "年龄或阶段",
      "appearance": "外貌描写",
      "personality": "性格特征",
      "background": "背景故事",
      "abilities": "能力/技能",
      "motivation": "核心动机",
      "relationships": [
        { "target": "另一个角色名", "relation": "关系类型/矛盾张力/情感连接" }
      ],
      "arc": "已知成长轨迹",
      "notes": "其他注意事项",
      "currentState": {
        "location": "最后已知位置",
        "powerLevel": "当前境界/能力等级",
        "physicalState": "当前身体状态",
        "mentalState": "当前心理状态",
        "keyItems": "当前持有的关键道具",
        "recentEvents": "最近发生的重要事件",
        "updatedAtChapter": 0
      }
    }
  ]
}

要求：
1. characterCards 仅包含主角和重要配角（3-8人），不要填写次要龙套
2. 所有字段基于内容推断，未能确定的字段填写"（待确认）"
3. relationships 必须使用数组；target 必须是 characterCards 中另一个角色的 name；relation 用短句写清关系类型、冲突或情感张力；没有关系则填 []
4. currentState 应基于最新内容（结尾采样）推断，不是初始状态


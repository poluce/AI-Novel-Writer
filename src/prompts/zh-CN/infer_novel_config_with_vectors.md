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

请严格按照以下 JSON 格式返回分析结果：

{
  "novelConfig": {
    "genre": "主类型（玄幻/仙侠/都市/科幻/历史/悬疑/游戏/军事/奇幻/武侠/现实/其他）",
    "targetAudience": "受众（男频/女频/通用）",
    "subGenre": "细分类型及标签",
    "plotStructure": "故事结构（three_act/heros_journey/save_the_cat/kishotenketsu/multi_thread/freeform）",
    "narrativePOV": "叙事视角（third_limited/first_person/third_omniscient/multi_pov）",
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
2. 所有字段基于检索片段推断，未能确定的填写"（待确认）"
3. relationships 必须使用数组；target 必须是 characterCards 中另一个角色的 name；relation 用短句写清关系类型、冲突或情感张力；没有关系则填 []
4. currentState 应基于最新章节推断当前状态，而非初始状态
5. plotStructure 和 narrativePOV 请根据实际叙事特征判断，而非猜测


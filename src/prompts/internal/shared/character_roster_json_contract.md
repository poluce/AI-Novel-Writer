
【不可变角色名单输出契约】
直接输出以下 JSON 对象，不要生成角色图谱 Markdown：
{
  "schemaVersion": 1,
  "entries": [
    {
      "name": "角色名",
      "role": "protagonist | antagonist | supporting | minor",
      "gender": "性别或（待确认）",
      "age": "年龄或年龄段",
      "appearance": "标志性外貌",
      "personality": "性格特点",
      "background": "身份与背景",
      "abilities": "能力或专长",
      "motivation": "核心动机",
      "relationships": [{ "target": "本次 entries 内另一个角色名", "relation": "关系与张力" }],
      "arc": "预期角色弧光",
      "notes": "补充说明或（待确认）",
      "currentState": {
        "location": "故事开始时位置",
        "powerLevel": "初始能力或境界",
        "physicalState": "初始身体状态",
        "mentalState": "初始心理状态",
        "keyItems": "初始关键物品或（待确认）",
        "recentEvents": "故事开始前最近事件",
        "updatedAtChapter": 0
      }
    }
  ]
}
约束：entries 不能为空；name 全部唯一；role 只能使用上述四个英文值；每个 relationships.target 必须是 entries 中另一角色的精确 name；不能自指关系。
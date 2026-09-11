<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:name -->
提取初始角色卡

<!-- section:description -->
从角色图谱纯文本中提取结构化角色卡数据，用于架构生成后自动创建角色卡 JSON 文件

<!-- section:systemRole -->
你是一位严谨的小说信息整理编辑。只依据输入提取角色事实，不补写剧情或猜测未知信息。

<!-- section:content -->
请从以下角色图谱文本中提取所有重要角色的结构化信息。

【角色图谱文本】
{{character_dynamics}}

【小说类型】
{{genre}}

【任务要求】
1. 提取所有在图谱中明确描述的角色（主角、反派、重要配角），不要遗漏。
2. 龙套或仅一笔带过的角色不用提取。
3. 所有字段基于图谱内容提取。如果图谱中未明确描写外貌，请务必根据角色的身份背景与性格推测并补充一段丰满的标志性外貌描写（外貌特征绝对不要留空或写未知）。未能确定的其他次要字段可填写空字符串。
4. role 字段仅限以下取值：protagonist（主角）、antagonist（反派）、supporting（配角）、minor（龙套）。
5. relationships 必须使用数组；target 必须是本次输出中另一个角色的 name；relation 用短句写清关系类型、冲突或情感张力；没有明确关系则填 []。
6. currentState 是角色的初始状态（故事开始时），updatedAtChapter 固定为 0。

【输出格式（JSON 对象）】
{
  "characters": [
    {
    "name": "角色名",
    "role": "protagonist",
    "gender": "性别",
    "age": "年龄或年龄段",
    "appearance": "外貌特征",
    "personality": "性格特点",
    "background": "背景故事",
    "abilities": "能力/技能/修为",
    "motivation": "核心动机与渴望",
    "relationships": [
      { "target": "另一个角色名", "relation": "关系类型/矛盾张力/情感连接" }
    ],
    "arc": "预期的角色弧光/成长轨迹",
    "notes": "其他补充说明",
    "currentState": {
      "location": "初始位置",
      "powerLevel": "初始境界/能力等级",
      "physicalState": "初始身体状态",
      "mentalState": "初始心理状态",
      "keyItems": "初始持有道具",
      "recentEvents": "故事开始前的背景事件",
      "updatedAtChapter": 0
    }
    }
  ]
}

如果图谱中没有任何可提取的角色，返回 {"characters": []}。


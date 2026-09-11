
【不可变导入推演 JSON 合同】
只输出一个直接 JSON 对象（禁止 Markdown 围栏和解释），完整包含：
{
  "novelConfig": {
    "genre": "非空文本", "subGenre": "非空文本", "targetAudience": "非空文本",
    "plotStructure": "three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform",
    "narrativePOV": "third_limited | first_person | third_omniscient | multi_pov",
    "coreOutline": "非空文本", "worldSetting": "非空文本", "goldenFinger": "非空文本",
    "protagonistProfile": "非空文本", "globalGuidance": "非空文本"
  },
  "architectureFiles": {
    "premise": "非空文本", "worldbuilding": "非空文本", "synopsis": "非空文本"
  },
  "characterCards": [{
    "name": "唯一非空角色名", "role": "protagonist | antagonist | supporting | minor",
    "gender": "非空文本", "age": "非空文本或有限数字", "appearance": "非空文本",
    "personality": "非空文本", "background": "非空文本", "abilities": "非空文本",
    "motivation": "非空文本", "relationships": [{"target":"同一 characterCards 中另一角色的精确 name","relation":"非空关系文本"}],
    "arc": "非空文本", "notes": "非空文本",
    "currentState": {"location":"非空文本","powerLevel":"非空文本","physicalState":"非空文本","mentalState":"非空文本","keyItems":"非空文本","recentEvents":"非空文本","updatedAtChapter":0}
  }]
}
characterCards 必须有 3–8 项，name 唯一，至少一个 protagonist；关系不得自指，target 必须在本次 name 集合中。不得省略字段、使用中文枚举或以近义字段替代。
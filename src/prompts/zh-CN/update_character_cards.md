<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:name -->
更新角色卡动态状态

<!-- section:description -->
定稿后分析章节内容，以 JSON 格式返回有变化的角色的 currentState 字段，用于自动更新角色卡

<!-- section:systemRole -->
你是一位严谨的小说角色档案编辑。依据章节事实更新角色状态，不推测未发生的变化。

<!-- section:content -->
请根据章节内容，以 JSON 格式返回在本章中发生状态变化的角色的最新状态。

【本章内容（第{{chapter_number}}章）】
{{chapter_content}}

【现有角色卡（基础信息）】
{{existing_cards_json}}

---

【任务要求】
1. 分析并在 `updates` 中提取已有角色（从提供的现有角色卡中找）发生状态变化的信息。
2. 分析并在 `newCharacters` 中提取本章新出场的重要角色（不要包含路人或已死无后续影响的龙套）。
3. `currentState` 字段说明：
   - location: 当前所在位置/阵营（字符串）
   - powerLevel: 修为境界/能力等级（字符串）
   - physicalState: 身体状态，包括伤势/BUFF/外貌变化（字符串）
   - mentalState: 心理状态，当前愿望/恐惧/心态（字符串）
   - keyItems: 当前持有的关键道具/资源（字符串）
   - recentEvents: 本章发生的最重要事件（字符串，50字以内）
   - updatedAtChapter: 固定填写 {{chapter_number}}（数字）

【输出格式（JSON）】
{
  "updates": [
    {
      "name": "已有角色的精确名字",
      "currentState": {
        "location": "...",
        "powerLevel": "...",
        "physicalState": "...",
        "mentalState": "...",
        "keyItems": "...",
        "recentEvents": "...",
        "updatedAtChapter": {{chapter_number}}
      }
    }
  ],
  "newCharacters": [
    {
      "name": "新角色名字",
      "role": "主要人物/反派/配角/导师",
      "currentState": {
        "location": "...",
        "powerLevel": "...",
        "physicalState": "...",
        "mentalState": "...",
        "keyItems": "...",
        "recentEvents": "...",
        "updatedAtChapter": {{chapter_number}}
      }
    }
  ]
}

如果本章无任何角色发生状态变化且无新角色，返回 {"updates": [], "newCharacters": []}。


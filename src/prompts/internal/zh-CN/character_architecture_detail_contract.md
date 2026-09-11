【不可变角色详情 JSON 合同】
只输出 {"entries":[...]}。每项必须包含 slotId、name、role、gender、age、appearance、personality、background、abilities、motivation、arc、notes、currentState。
currentState 必填，必须包含 location、powerLevel、physicalState、mentalState、keyItems、recentEvents、updatedAtChapter；updatedAtChapter 必须是非负整数。
appearance、personality、background、abilities、motivation、arc、notes 每项不超过 120 字符；currentState 的文本字段每项不超过 80 字符。
keyItems 可为非空字符串或非空字符串数组；recentEvents 可为非空字符串或非空字符串数组。数组每项必须是非空字符串，不得混入数字、对象或 null；没有内容时使用字符串“无”，不得输出空数组。
禁止输出 relationships、schemaVersion、角色图谱 Markdown、解释、代码围栏或思考过程。

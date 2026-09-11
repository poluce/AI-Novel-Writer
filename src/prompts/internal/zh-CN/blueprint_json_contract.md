【不可变蓝图 JSON 合同】
只输出 {"blueprints":[...]}，每项必须完整包含：{{required_fields}}。
chapterNumber 必须覆盖本批每个目标章节且不得重复或越界；title、role、purpose、keyEvents、suspenseHook 必须是非空字符串。
suspenseHook 始终必填；即使本章没有谜团，也要写明一个制造推进压力的具体未决决定、威胁、揭示或后果。
characters 必须是至少含一个唯一非空角色名的字符串数组。
newCharacterCandidates 可选；提供时只声明由本章首次引入且预计后续复用的重要具名角色，每项必须包含 name、role，name 必须逐字复制 characters 中的一个完整姓名，role 只能是 protagonist、antagonist、supporting、minor。无候选时可省略或传 []，一次性路人不得声明为候选。
relationships 必须是数组，无关系时传 []；每项必须含非空 from、to、relation，from/to 必须精确出现在同项 characters 中且不能自指。
from/to 必须逐字复制同一项 characters 中的完整字符串；任一端点不在 characters 时，删除该关系或使用 []，不得发明别名、简称或补写角色。
keyEvents 保持精炼，目标为 100–150 字符，绝不得超过 1200 字符硬上限。
每项长度上限：title {{title_chars}} 字符、role {{role_chars}} 字符、purpose {{purpose_chars}} 字符、keyEvents {{key_events_chars}} 字符、suspenseHook {{suspense_hook_chars}} 字符；characters 最多 {{character_items}} 项且姓名最多 {{character_name_chars}} 字符；relationships 最多 {{relationship_items}} 项且 relation 最多 {{relationship_chars}} 字符。
不得省略必填字段、合并章节、输出近义字段、解释、Markdown 或代码围栏。

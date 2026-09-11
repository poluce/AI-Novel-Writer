【导入推演受限补卡校正】
上一轮完整 JSON 已可解析，但 characterCards.relationships.target 引用了 characterCards 中不存在的角色名。
只输出一个完整 JSON 对象，不要 Markdown、解释或思考过程。
只允许输出严格 delta，顶层必须且只能包含 characterCards。
characterCards 必须新增且只新增这些缺失角色 name：{{unresolved_targets}}
不得回传 novelConfig、architectureFiles 或任何原有角色卡；不得删除、重排、改名或改写任何原角色。
不得新增任意其他角色；delta 角色卡、currentState 与 relationships 内部不得包含合同外字段。
应用端会把 delta 追加到上一轮本地原始 characterCards，再执行完整导入推演 JSON 合同校验和关系闭合校验。
【delta JSON 合同】
{"characterCards":[{"name":"缺失关系端点精确 name","role":"protagonist | antagonist | supporting | minor","gender":"非空文本","age":"非空文本或有限数字","appearance":"非空文本","personality":"非空文本","background":"非空文本","abilities":"非空文本","motivation":"非空文本","relationships":[{"target":"最终 characterCards 中另一角色的精确 name","relation":"非空关系文本"}],"arc":"非空文本","notes":"非空文本","currentState":{"location":"非空文本","powerLevel":"非空文本","physicalState":"非空文本","mentalState":"非空文本","keyItems":"非空文本","recentEvents":"非空文本","updatedAtChapter":0}}]}
【上一轮完整 JSON（只用于识别已存在角色，不得回传旧内容）】
{{original_root}}

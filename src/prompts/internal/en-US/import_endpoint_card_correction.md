[Bounded import-inference endpoint-card correction]
The previous complete JSON is parseable, but characterCards.relationships.target references names absent from characterCards.
Output one complete JSON object only, with no Markdown, explanation, or reasoning.
Return a strict delta whose only top-level field is characterCards.
Add exactly these missing character names and no others: {{unresolved_targets}}
Do not return novelConfig, architectureFiles, or any existing card. Do not remove, reorder, rename, or rewrite existing characters.
Every delta card, currentState, and relationship must contain only contract fields.
[Delta JSON contract]
{"characterCards":[{"name":"exact missing endpoint name","role":"protagonist | antagonist | supporting | minor","gender":"non-empty text","age":"non-empty text or finite number","appearance":"non-empty text","personality":"non-empty text","background":"non-empty text","abilities":"non-empty text","motivation":"non-empty text","relationships":[{"target":"exact name of another final character","relation":"non-empty relationship text"}],"arc":"non-empty text","notes":"non-empty text","currentState":{"location":"non-empty text","powerLevel":"non-empty text","physicalState":"non-empty text","mentalState":"non-empty text","keyItems":"non-empty text","recentEvents":"non-empty text","updatedAtChapter":0}}]}
[Previous complete JSON — identify existing characters only; do not echo it]
{{original_root}}

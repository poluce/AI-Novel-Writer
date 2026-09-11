<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:systemRole -->
You are a rigorous fiction information editor. Extract character facts from the supplied material without adding plot events or guessing unsupported details.

<!-- section:content -->
Extract every important character explicitly described in the following character-map text.

[Character map]
{{character_dynamics}}

[Novel genre]
{{genre}}

[Requirements]
1. Include the protagonist, antagonist, and important supporting characters; omit incidental figures.
2. Base every field on the supplied map. When appearance is not stated, infer one restrained, identity-consistent visual description; leave other genuinely unknown minor fields as empty strings.
3. role must be protagonist, antagonist, supporting, or minor.
4. relationships must be an array. target must exactly match another character name in this response; relation must briefly state the relationship, conflict, or emotional tension. Use [] when no relationship is established.
5. currentState represents the initial state at story opening, and updatedAtChapter must be 0.

[JSON object contract]
Return exactly one object with this shape:
{"characters":[{"name":"...","role":"protagonist|antagonist|supporting|minor","gender":"...","age":"...","appearance":"...","personality":"...","background":"...","abilities":"...","motivation":"...","relationships":[{"target":"another exact character name","relation":"..."}],"arc":"...","notes":"...","currentState":{"location":"...","powerLevel":"...","physicalState":"...","mentalState":"...","keyItems":"...","recentEvents":"...","updatedAtChapter":0}}]}

Output valid JSON only, with no Markdown, explanation, or reasoning. If no character can be extracted, return {"characters":[]}.


[Immutable character-detail JSON contract]
Output {"entries":[...]} only. Every entry must contain slotId, name, role, gender, age, appearance, personality, background, abilities, motivation, arc, notes, and currentState.
currentState is required and must contain location, powerLevel, physicalState, mentalState, keyItems, recentEvents, and a non-negative integer updatedAtChapter.
Keep appearance, personality, background, abilities, motivation, arc, and notes within 120 characters each, and each currentState text field within 80 characters.
keyItems and recentEvents may each be a non-empty string or an array of non-empty strings. Use the string "none" when empty; never output an empty array.
Do not output relationships, schemaVersion, or a rendered character map. Submit the entries list through the submit tool.

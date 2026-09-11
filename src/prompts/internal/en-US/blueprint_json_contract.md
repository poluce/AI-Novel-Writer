[Immutable blueprint JSON contract]
Output {"blueprints":[...]} only. Every item must contain all of these fields: {{required_fields}}.
chapterNumber must cover every target chapter exactly once, without duplicates or out-of-range values. title, role, purpose, keyEvents, and suspenseHook must be non-empty strings.
suspenseHook is always required; even without a mystery, state one concrete unresolved decision, threat, revelation, or consequence that creates forward pressure.
characters must be an array containing at least one unique, non-empty full character name.
newCharacterCandidates is optional. When present, include only important named characters first introduced by this blueprint and expected to recur. Every item must contain name and role, name must exactly copy one entry from characters, and role must be protagonist, antagonist, supporting, or minor. Omit it or use [] when there are no candidates; never include incidental figures.
relationships is required and may be []; every item must contain non-empty from, to, and relation fields. from and to must exactly copy full names from the same item's characters array and may not self-reference.
Keep keyEvents concise; aim for no more than 900 characters and never exceed the hard maximum of 1,200.
Limits: title {{title_chars}} characters; role {{role_chars}}; purpose {{purpose_chars}}; keyEvents {{key_events_chars}}; suspenseHook {{suspense_hook_chars}}; characters at most {{character_items}} items with names at most {{character_name_chars}} characters; relationships at most {{relationship_items}} items with relation at most {{relationship_chars}} characters.
Do not omit required fields, combine chapters, rename fields, explain, or output Markdown or code fences.

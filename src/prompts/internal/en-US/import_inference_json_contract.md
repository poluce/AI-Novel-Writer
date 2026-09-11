
[Immutable import-inference JSON contract]
Output one direct JSON object only, with no Markdown fence or explanation. It must contain:
{
  "novelConfig": {
    "genre": "non-empty text", "subGenre": "non-empty text", "targetAudience": "non-empty text",
    "plotStructure": "three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform",
    "narrativePOV": "third_limited | first_person | third_omniscient | multi_pov",
    "coreOutline": "non-empty text", "worldSetting": "non-empty text", "goldenFinger": "non-empty text",
    "protagonistProfile": "non-empty text", "globalGuidance": "non-empty text"
  },
  "architectureFiles": {
    "premise": "non-empty text", "worldbuilding": "non-empty text", "synopsis": "non-empty text"
  },
  "characterCards": [{
    "name": "unique non-empty character name", "role": "protagonist | antagonist | supporting | minor",
    "gender": "non-empty text", "age": "non-empty text or finite number", "appearance": "non-empty text",
    "personality": "non-empty text", "background": "non-empty text", "abilities": "non-empty text",
    "motivation": "non-empty text", "relationships": [{"target":"exact name of another character in characterCards","relation":"non-empty relationship text"}],
    "arc": "non-empty text", "notes": "non-empty text",
    "currentState": {"location":"non-empty text","powerLevel":"non-empty text","physicalState":"non-empty text","mentalState":"non-empty text","keyItems":"non-empty text","recentEvents":"non-empty text","updatedAtChapter":0}
  }]
}
characterCards must contain 3–8 unique names and at least one protagonist. Relationships may not self-reference, and every target must occur in the same name set. Do not omit fields, translate enum values, or substitute synonym field names.
[Immutable novel-configuration JSON contract]
- The following nine fields are required non-empty strings: genre, targetAudience, subGenre, coreOutline, worldSetting, goldenFinger, protagonistProfile, globalGuidance, writingStyle.
- plotStructure is required and must be exactly one of: three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform.
- narrativePOV is required and must be exactly one of: third_limited | first_person | third_omniscient | multi_pov.
- totalChapters and wordsPerChapter are authoritative author settings and may be omitted. If present, they must equal {{total_chapters}} and {{words_per_chapter}} respectively.
- globalGuidance must contain 4–8 short, stable cross-chapter rules within {{max_chars}} characters. Do not enumerate chapters or allocate chapter ranges.
- referenceWorks may be omitted; if present, it must be a string.
- Output one complete JSON object only. Do not emit aliases, explanatory prose, Markdown, code fences, or reasoning.

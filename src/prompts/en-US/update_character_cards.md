<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:systemRole -->
You maintain rigorous character records and track concrete multidimensional state changes across chapters. Return explicit fields and no reasoning.

<!-- section:content -->
Update character state records from this chapter.

[Chapter {{chapter_number}} manuscript]
{{chapter_content}}

[Existing character records]
{{existing_cards_json}}

[Task]
1. In updates, include only existing characters whose state materially changed in this chapter.
2. In newCharacters, include only important newly introduced characters, excluding incidental figures with no continuing effect.
3. currentState may contain location, powerLevel, physicalState, mentalState, keyItems, recentEvents, and updatedAtChapter. Set updatedAtChapter to {{chapter_number}}.
4. Preserve every character name exactly as written in the manuscript or existing records.

[Submission]
Submit through the provided tool. Include updates and newCharacters. currentState may contain location, powerLevel, physicalState, mentalState, keyItems, recentEvents, and updatedAtChapter.
If nothing changed and no important character was introduced, submit empty updates and newCharacters. Do not paste JSON into the message body.


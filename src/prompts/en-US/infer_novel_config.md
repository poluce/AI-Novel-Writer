<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:systemRole -->
You are a senior fiction editor and reading analyst who reconstructs a coherent story system from an existing manuscript. Use concise text, explicit fields, and direct textual evidence.

<!-- section:content -->
Infer the complete established story system from the following manuscript sample so the project can continue the same novel.

[Existing manuscript sample]
{{sample_content}}

[Task]
Submit through the provided tool an artifact containing novelConfig, architectureFiles, and characterCards. Infer only from the supplied manuscript, preserve names and facts exactly, and mark genuine uncertainty with concise text rather than inventing unsupported canon. Include genre, targetAudience, subGenre, coreOutline, worldSetting, goldenFinger, protagonistProfile, globalGuidance, premise, characters, worldbuilding, synopsis, target, relation, and currentState as required by the tool schema.
Do not paste JSON into the message body.


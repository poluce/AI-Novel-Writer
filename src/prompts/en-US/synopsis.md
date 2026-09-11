<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:systemRole -->
You are an experienced story architect. Preserve author facts and organize the plot through character choices, resistance, costs, and causal escalation.

<!-- section:content -->
Build the complete plot architecture by integrating all established story assets.

[Authoritative assets]
- Genre: {{genre}}
- Narrative point of view: {{narrative_pov}}
- Story premise: {{premise}}
- Character dynamics: {{character_dynamics}}
- World system: {{world_building}}
- Project-wide writing guidance: {{global_guidance}}

[Scale]
- Total chapters: {{number_of_chapters}}
- Target words per chapter: {{word_number}}

[Required structure]
{{plot_structure_guide}}

[Deliverable]
Produce a complete outline made of structural turning points rather than chapter-level summaries. Adapt the pacing to the core appeal of {{genre}}.

[Requirements]
1. Derive every chapter range from exactly {{number_of_chapters}} chapters.
2. State the concrete event at every structural turn.
3. Match the escalation and reveal cadence to {{genre}}.
4. Respect the information limits and suspense opportunities of {{narrative_pov}}.
5. Treat explicit author facts in the story premise, character dynamics, and world system as causal constraints. Never omit, weaken, or reverse them.
6. Preserve the project-wide writing guidance.
7. Submit through the provided tool. The body is only the plot architecture, with no analysis or explanation.

<!-- section:systemSuffix -->
[Author guidance for this step — highest priority when present]
{{step_guidance}}


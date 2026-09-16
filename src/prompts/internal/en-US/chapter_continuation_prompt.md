{{recovery_instruction}}Continue the current chapter seamlessly.

[Requirements]
- Output only new manuscript prose; do not repeat existing text.
- Continue naturally from the existing ending, preserving the same scene logic or making a justified transition.
- Complete as much as possible of the remaining approximately {{remaining}} words; if that is not possible, stop at a natural paragraph boundary.
- Do not output a title, explanation, summary, Markdown, or an interface continuation prompt.
- Avoid repeating complete sentences, paragraphs, action sequences, or imagery from the existing manuscript.
- Complete only the current chapter blueprint; do not advance later chapters.

[Current chapter blueprint]
{{chapter_info}}

[Project-wide writing guidance]
{{global_guidance}}

[Writing style]
{{writing_style}}

[Writing-style applicability]
- Writing style selects expression only; it adds no facts or events, and not every item must be forced into the manuscript.
- Explicit author facts and guidance, actual prior prose, the chapter's key causality, and its target length take priority. Do not use style guidance to rewrite them, relabel explicit author facts or requirements as guesses, or add scenes, actions, or events merely to satisfy style guidance.

[Novel configuration facts]
{{novel_config_facts}}

{{chapter_materials}}

[End of existing manuscript]
{{visible_tail}}

The previous structured output stopped at the length limit. Complete the task again.

[Original task]
{{original_prompt}}

[Visible incomplete output from the previous attempt — reference only]
{{visible_partial}}

[Requirements]
- Rebuild and return the complete JSON from the beginning; do not return only a suffix.
- Output only complete JSON accepted by JSON.parse, with no Markdown or explanation.
- Use the visible prior output only as evidence; the original task remains authoritative, and every required field and array must be complete.
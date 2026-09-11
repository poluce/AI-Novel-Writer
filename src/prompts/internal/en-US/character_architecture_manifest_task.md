[Identity-planning context]
{{context}}

[Identity manifest contract]
Output {"slots":[...]} only, with {{minimum}}–{{maximum}} characters. Every item must contain slotId, name, role, narrativeDuty, and relations; every relation must contain targetSlotId and relation. slotId and targetSlotId must be JSON strings; slotId and name must be unique. role must be protagonist, antagonist, supporting, or minor, with at least one protagonist. Relationships may reference only another slotId in this manifest.

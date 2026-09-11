【身份规划上下文】
{{context}}

【身份清单合同】
只输出 {"slots":[...]}，角色数量必须为 {{minimum}}–{{maximum}}。每项必须含 slotId、name、role、narrativeDuty、relations；relations 每项含 targetSlotId、relation。slotId 与 targetSlotId 必须是 JSON 字符串；slotId/name 必须唯一，role 仅 protagonist/antagonist/supporting/minor，且至少一个 protagonist；关系只能引用本清单其他 slotId。

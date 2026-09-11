<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:name -->
逆向推演单章蓝图

<!-- section:description -->
从已有小说章节正文高精度反推出该章的结构化蓝图信息，用于导入旧作场景

<!-- section:systemRole -->
你是一位严谨的章节结构分析编辑。依据正文事实提取场景、角色行动、冲突、转折和结果，不改写原文。

<!-- section:content -->
请阅读以下已有章节正文，从中提取结构化蓝图信息。

【全局小说设定概要】
{{novel_config_summary}}

【章节信息】
- 章节序号：第 {{chapter_number}} 章
- 拆章标题：{{chapter_title}}

【本章正文】
{{chapter_content}}

---

请严格按以下 JSON 格式输出本章蓝图：

{
  "chapterNumber": {{chapter_number}},
  "title": "从正文内容中提炼的精准章节标题（如果拆章标题已经不错可保留）",
  "role": "本章在全书中的角色（起、承、转、合、伏笔、高潮、过渡 等）",
  "purpose": "本章主角最想解决的核心问题（一句话）",
  "characters": ["本章出场的重要角色名"],
  "keyEvents": "本章核心事件概述（100-150字，包含因果关系和结果）",
  "suspenseHook": "章末留下的悬念或钩子（一句话）"
}

要求：
1. keyEvents 必须基于正文实际内容提取，不可臆造。
2. characters 只列主要互动角色名（3-5个），不要列龙套。
3. role 从正文的叙事功能判断（建置/发展/转折/高潮/结局/过渡等）。
4. 仅输出 JSON，不要任何额外文字。


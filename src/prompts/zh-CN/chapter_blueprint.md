<!-- Generated prompt source. Edit the prose here, not in TypeScript.
     Structural metadata (key, variables, required context) lives in ../manifest.ts. -->

<!-- section:name -->
章节蓝图生成（全量）

<!-- section:description -->
基于全书架构一次性生成所有章节的详细蓝图

<!-- section:systemRole -->
你是一位经验丰富的章节架构师。将作者事实转化为具体场景、角色行动、阻力、转折和章节钩子，不输出思考过程。

<!-- section:content -->
请基于我们此前推演出的【全书架构引擎】，为本书生成从第1章到第{{number_of_chapters}}章的具体"保姆级执行目录细纲"。

【核心防偏离守则】
- 小说题材：{{genre}}
- 全局写作要求：{{global_guidance}}
- 全书架构中的作者明确设定是权威事实；涉及对应角色、关系或规则的章节必须落实，不得遗漏、弱化或反转。

【全书架构数据池】
{{novel_architecture}}

【商业网文节奏设计原则】
1. 黄金三章法则：第1章极速抛出"生存/高压困境"，第2章激活金手指/最大反差变量，第3章完成首次"小型打脸/破局"，留钩子。
2. 小高潮循环：严格执行"3-5章一个小循环"。
3. 避免水文与流水账：每一章都必须发生"实质性的事件变动"。
4. 悬念钩子机制：每章结尾必须有一个让读者想连续翻页的变数。

【输出格式规定】
严格且仅按以下 JSON 数组格式输出每一章：

{
  "blueprints": [
    {
      "chapterNumber": 1,
      "title": "引人入胜的标题",
      "role": "本章在全书结构中的功能，例如建置、发展、转折或高潮",
      "purpose": "本章主角最想解决的一件事",
      "characters": ["本章互动的要人A", "要人B"],
      "relationships": [{ "from": "要人A", "to": "要人B", "relation": "本章可确认的关系；无则空数组" }],
      "keyEvents": "主角做了什么，遭遇了什么反转，金手指怎么用的。100字左右具体说明",
      "suspenseHook": "一句话说明结尾留了什么悬念"
    },
    {
      "chapterNumber": 2
    }
  ]
}

要求：
- 每章的 keyEvents 控制在 100-150 字以内，信息密度必须极高。
- 每个对象必须包含完整的 chapterNumber、title、role、purpose、characters、relationships、keyEvents、suspenseHook；relationships 仅写本章可确认的角色关系，无则输出空数组。
- 仅给出最终的 JSON 文本，不要任何客套解释、分析、计划、Markdown 或代码块。

★【作者节奏/风格指导（如有，最高优先级）】★：
{{pacing_guidance}}


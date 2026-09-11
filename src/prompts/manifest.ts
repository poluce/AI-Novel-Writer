/**
 * 内置提示词的结构元数据。
 *
 * 散文正文在 ./zh-CN/*.md 与 ./en-US/*.md；这里只保留形状：
 * 有哪些 key、接受哪些插值变量、以及 Builder 必须补齐的上下文变量。
 * 修改提示词内容请改 markdown，不要在 TypeScript 里写死文案。
 */

export interface BuiltinPromptStructure {
  readonly key: string
  /** 插值变量名 → 设置页展示给作者的说明。 */
  readonly variables: Readonly<Record<string, string>>
  /** 自定义正文删掉占位符后，Builder 仍必须追加的权威上下文变量。 */
  readonly requiredContextVariables?: readonly string[]
}

export const BUILTIN_PROMPT_STRUCTURES: readonly BuiltinPromptStructure[] = [
  {
    key: "assistant_writing_identity",
    variables: {
      "mode_instruction": "当前助手工作模式说明",
    },
  },
  {
    key: "edit_selected_text",
    variables: {
      "edit_instruction": "作者对选中文本的处理要求",
      "selected_text": "编辑器中选中的正文",
    },
    requiredContextVariables: ["selected_text"],
  },
  {
    key: "generate_novel_config_field",
    variables: {
      "existing_config": "已有小说配置",
      "field_label": "要生成的字段",
      "field_requirements": "该字段的具体要求",
    },
    requiredContextVariables: ["existing_config"],
  },
  {
    key: "generate_global_config",
    variables: {
      "user_idea": "用户输入的灵感/想法",
      "number_of_chapters": "计划总章数",
      "word_number": "每章计划字数",
    },
  },
  {
    key: "premise",
    variables: {
      "genre": "小说类型",
      "sub_genre": "细分类型",
      "topic": "核心主题/故事简介",
      "target_audience": "目标受众",
      "number_of_chapters": "总章数",
      "word_number": "每章字数",
      "core_setting": "世界观基盘设定",
      "golden_finger": "核心金手指/卖点",
      "protagonist_profile": "主角人设",
      "global_guidance": "全局写作要求",
      "step_guidance": "作者对本步骤的补充指导（可选）",
      "reference_works": "参考作品（可选）",
    },
    requiredContextVariables: ["genre", "sub_genre", "topic", "target_audience", "number_of_chapters", "word_number", "core_setting", "golden_finger", "protagonist_profile", "global_guidance", "reference_works"],
  },
  {
    key: "character_dynamics",
    variables: {
      "premise": "故事前提",
      "genre": "小说类型",
      "protagonist_profile": "主角人设",
      "golden_finger": "金手指体系",
      "world_building": "世界观设定",
      "number_of_chapters": "总章数",
      "global_guidance": "全局写作要求",
      "step_guidance": "作者对本步骤的补充指导（可选）",
      "reference_works": "参考作品（可选）",
    },
    requiredContextVariables: ["premise", "genre", "protagonist_profile", "golden_finger", "world_building", "number_of_chapters", "global_guidance", "reference_works"],
  },
  {
    key: "world_building",
    variables: {
      "premise": "故事前提",
      "genre": "小说类型",
      "core_setting": "世界观基盘",
      "golden_finger": "金手指体系",
      "protagonist_profile": "主角人设",
      "global_guidance": "全局写作要求",
      "step_guidance": "作者对本步骤的补充指导（可选）",
    },
    requiredContextVariables: ["premise", "genre", "core_setting", "golden_finger", "protagonist_profile", "global_guidance"],
  },
  {
    key: "synopsis",
    variables: {
      "premise": "故事前提",
      "character_dynamics": "角色图谱",
      "world_building": "世界观",
      "genre": "小说类型",
      "number_of_chapters": "总章数",
      "word_number": "每章字数",
      "plot_structure_guide": "故事结构详细指导（由系统根据用户选择的结构模式动态注入）",
      "narrative_pov": "叙事视角描述",
      "global_guidance": "全局写作要求",
      "step_guidance": "作者对本步骤的补充指导（可选）",
    },
    requiredContextVariables: ["premise", "character_dynamics", "world_building", "genre", "number_of_chapters", "word_number", "plot_structure_guide", "narrative_pov", "global_guidance"],
  },
  {
    key: "chapter_blueprint",
    variables: {
      "novel_architecture": "完整故事架构（故事前提+角色图谱+世界观+情节大纲）",
      "number_of_chapters": "总章数",
      "global_guidance": "全局写作要求",
      "genre": "小说类型",
      "pacing_guidance": "节奏/风格指导（可选）",
    },
    requiredContextVariables: ["novel_architecture", "number_of_chapters", "global_guidance", "genre", "pacing_guidance"],
  },
  {
    key: "chapter_blueprint_chunk",
    variables: {
      "novel_architecture": "完整故事架构（故事前提+角色图谱+世界观+情节大纲）",
      "chapter_list": "已生成的章节列表（最近100章）",
      "number_of_chapters": "总章数",
      "n": "起始章节号",
      "m": "结束章节号",
      "global_guidance": "全局写作要求",
      "genre": "小说类型",
      "pacing_guidance": "节奏/风格指导（可选）",
    },
    requiredContextVariables: ["novel_architecture", "chapter_list", "number_of_chapters", "n", "m", "global_guidance", "genre", "pacing_guidance"],
  },
  {
    key: "first_chapter_draft",
    variables: {
      "architecture": "故事架构（故事前提+角色图谱+世界观+情节大纲）",
      "novel_config": "作者确认的小说配置（权威约束）",
      "chapter_info": "本章信息（JSON）",
      "future_blueprints": "后续章节蓝图（防止剧情提前）",
      "global_guidance": "全局写作要求",
      "word_number": "目标字数",
      "writing_style": "文风描述（可选）",
      "user_guidance": "作者本章微操指导（可选）",
    },
    requiredContextVariables: ["architecture", "novel_config", "global_guidance", "writing_style"],
  },
  {
    key: "next_chapter_draft",
    variables: {
      "architecture": "故事架构（故事前提+角色图谱+世界观+情节大纲）",
      "novel_config": "作者确认的小说配置（权威约束）",
      "global_summary": "章节要点时间线（从蓝图按序拼装）",
      "character_states": "角色状态",
      "short_summary": "近期三章简要",
      "previous_ending": "上章结尾800字",
      "chapter_info": "本章蓝图信息（JSON）",
      "future_blueprints": "后续章节蓝图（防止剧情提前）",
      "user_guidance": "作者本章微操指导（可选）",
      "filtered_context": "知识库检索结果",
      "global_guidance": "全局写作要求",
      "word_number": "目标字数",
      "writing_style": "文风描述（可选）",
    },
    requiredContextVariables: ["architecture", "novel_config", "global_guidance", "writing_style"],
  },
  {
    key: "refine_chapter",
    variables: {
      "draft_content": "章节草稿内容",
      "chapter_info": "章节信息",
      "global_guidance": "写作要求",
      "global_summary": "近章要点（蓝图摘要）",
      "short_summary": "近章摘要",
      "word_number": "目标字数",
      "user_refine_prompt": "用户自定义修稿指导（可选）",
      "writing_style": "文风描述（可选）",
    },
  },
  {
    key: "consistency_check",
    variables: {
      "chapter_content": "章节内容",
      "character_states": "角色状态",
      "global_summary": "上下文检索结果",
      "world_building": "世界观设定",
      "review_focus": "审稿维度侧重点（可选）",
    },
  },
  {
    key: "analyze_writing_style",
    variables: {
      "sample_text": "正文采样文本（3-5章拼接）",
    },
  },
  {
    key: "refine_from_review",
    variables: {
      "review_report": "审稿报告内容",
      "draft_content": "待修稿内容",
      "global_guidance": "全局写作要求",
      "user_refine_prompt": "用户额外修稿指导（可选）",
    },
  },
  {
    key: "generate_chapter_notes",
    variables: {
      "chapter_content": "章节正文内容",
      "chapter_number": "章节编号",
      "chapter_title": "章节标题",
    },
  },
  {
    key: "update_character_cards",
    variables: {
      "chapter_content": "章节正文内容",
      "chapter_number": "章节编号",
      "existing_cards_json": "现有角色卡 JSON 数组（包含 name/role 等基础信息）",
    },
  },
  {
    key: "infer_novel_config",
    variables: {
      "sample_content": "知识库代表性采样内容（开头+中段+结尾）",
    },
  },
  {
    key: "extract_initial_characters",
    variables: {
      "character_dynamics": "角色图谱纯文本",
      "genre": "小说类型",
    },
  },
  {
    key: "infer_single_chapter_blueprint",
    variables: {
      "chapter_content": "本章正文全文",
      "chapter_number": "本章序号",
      "chapter_title": "本章标题（来自拆章）",
      "novel_config_summary": "全局配置脱水版",
    },
  },
  {
    key: "infer_novel_config_with_vectors",
    variables: {
      "sampled_worldview": "向量检索：世界观与力量体系相关片段",
      "sampled_protagonist": "向量检索：主角设定与金手指相关片段",
      "sampled_conflict": "向量检索：核心矛盾与敌对势力相关片段",
      "sampled_style": "向量检索：写作风格与叙事视角相关片段",
      "first_chapter": "第一章正文（开局风格参考）",
      "latest_chapter": "最新一章正文（当前进度参考）",
      "total_chapters": "已有总章数",
    },
  },
]

/** 允许用户自定义编辑的模板 Key 列表（其余为系统模板，不可编辑） */
export const EDITABLE_PROMPT_KEYS: readonly string[] = [
  "assistant_writing_identity",
  "generate_novel_config_field",
  "edit_selected_text",
  "generate_global_config",
  "premise",
  "character_dynamics",
  "world_building",
  "synopsis",
  "chapter_blueprint_chunk",
  "first_chapter_draft",
  "next_chapter_draft",
  "refine_chapter",
  "consistency_check",
  "analyze_writing_style",
  "refine_from_review",
  "generate_chapter_notes",
  "update_character_cards",
  "infer_novel_config",
  "infer_single_chapter_blueprint",
  "infer_novel_config_with_vectors",
]

/**
 * Built-in templates used by the forward-writing lifecycle. Every key in this
 * list must provide an English overlay; commands may not silently fall back to
 * the historical Chinese template for an English project.
 */
export const CORE_LOCALIZED_BUILTIN_PROMPT_KEYS: readonly string[] = [
  "generate_novel_config_field",
  "edit_selected_text",
  "generate_global_config",
  "premise",
  "character_dynamics",
  "world_building",
  "synopsis",
  "chapter_blueprint",
  "chapter_blueprint_chunk",
  "first_chapter_draft",
  "next_chapter_draft",
  "refine_chapter",
  "consistency_check",
  "refine_from_review",
  "generate_chapter_notes",
  "update_character_cards",
  "analyze_writing_style",
  "infer_novel_config",
  "extract_initial_characters",
  "infer_novel_config_with_vectors",
  "infer_single_chapter_blueprint",
]

const CORE_LOCALIZED_BUILTIN_PROMPT_KEY_SET = new Set<string>(CORE_LOCALIZED_BUILTIN_PROMPT_KEYS)

export type CoreLocalizedBuiltinPromptKey = typeof CORE_LOCALIZED_BUILTIN_PROMPT_KEYS[number]

export function isCoreLocalizedBuiltinPromptKey(key: string): key is CoreLocalizedBuiltinPromptKey {
  return CORE_LOCALIZED_BUILTIN_PROMPT_KEY_SET.has(key)
}

import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import type { NovelConfig } from '../../../shared/ipc-channels'
import {
  GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
  GENERATED_GLOBAL_GUIDANCE_MAX_RULES,
  GENERATED_GLOBAL_GUIDANCE_MIN_RULES,
  isGeneratedGlobalGuidanceValid,
  mergeExpandedNovelConfig,
} from '../novel-config-expansion'
import { internalPrompt } from '../../../prompts/internal/load'
import { buildNovelConfigJSONContract, decodeCompleteNovelConfig } from './architecture-json-contract'
import { assertArchitectureProjectSessionCurrent } from './architecture-persistence'

export class GenerateConfigCommand extends BaseWorkflowCommand<string> {
  constructor(
    private idea: string,
    private totalChapters: number,
    private wordsPerChapter: number,
    private onGenerated: (config: Partial<NovelConfig>) => void,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const existingConfig = { ...(useProjectStore.getState().currentProject?.novelConfig ?? {}) }
    callbacks.log(text(
      '正在调度配置专家 AI，准备解析您的脑洞...',
      'Preparing the configuration model to structure your story idea...',
    ))

    const template = await resolvePromptTemplate('generate_global_config', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到 generate_global_config 模板',
      'The generate_global_config template was not found.',
    ))

    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withUserIdea(this.idea)
      .withNumberOfChapters(this.totalChapters)
      .withWordNumber(this.wordsPerChapter)
    const configJSONContract = buildNovelConfigJSONContract(
      this.totalChapters,
      this.wordsPerChapter,
      writingLanguage,
    )
    const authorConfigContext = Object.keys(existingConfig).length > 0
      ? promptLanguageText(
          writingLanguage,
          `【作者已有配置】\n以下非空内容和选择是作者权威输入：长文本只能在保留原文的基础上补充，类型、受众、结构与视角选择不得改写。\n${JSON.stringify(existingConfig, null, 2)}`,
          `[Existing author configuration]\nThe following non-empty content and choices are authoritative. Preserve long-form text and only add useful details; do not change the author's genre, audience, structure, or point-of-view choices.\n${JSON.stringify(existingConfig, null, 2)}`,
        )
      : ''
    const originalTask = [promptBuilder.build(), authorConfigContext, configJSONContract]
      .filter(Boolean)
      .join('\n\n')

    const initial = await this.callLLMResult(
      originalTask,
      promptBuilder.getSystemRole(),
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'generate-global-config',
        reasoningStage: 'planning',
        submitTool: 'submit_json',
      },
      context,
    )
    let resultRaw: string
    let resultArtifact: Record<string, unknown> | undefined
    if (initial.finishReason === 'stop') {
      resultRaw = initial.content
      resultArtifact = initial.artifact
    } else if (initial.finishReason === 'length') {
      callbacks.log(text(
        '首轮配置 JSON 达到输出上限，已丢弃不可信截断内容，正在请求一次完整替代 JSON...',
        'The first configuration JSON reached the output limit. The untrusted truncated response was discarded; requesting one complete replacement JSON...',
      ))
      const replacement = await this.callLLMResult(
        internalPrompt('architecture_json_retry', writingLanguage, { original_task: originalTask }),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          purpose: 'generate-global-config-replacement',
          reasoningStage: 'planning',
          submitTool: 'submit_json',
        },
        context,
      )
      if (replacement.finishReason !== 'stop') {
        throw this.createIncompleteCompletionError(replacement.finishReason)
      }
      resultRaw = replacement.content
      resultArtifact = replacement.artifact
    } else {
      throw this.createIncompleteCompletionError(initial.finishReason)
    }
    this.assertNotCancelled(context)

    callbacks.log(text(
      '解析完成，正在应用到项目配置...',
      'Parsing is complete; applying the result to the project configuration...',
    ))
    let parsed: NovelConfig
    try {
      parsed = decodeCompleteNovelConfig(resultArtifact ?? resultRaw, this.totalChapters, this.wordsPerChapter)
    } catch (e) {
      throw new Error(text(
        'AI 返回的小说配置不完整或无效，结果未应用。详细信息: ' + String(e),
        'The AI novel configuration was incomplete or invalid, so the result was not applied.',
      ))
    }
    if (!isGeneratedGlobalGuidanceValid(parsed.globalGuidance)) {
      callbacks.log(text(
        '生成的全局写作要求不符合 4–8 条简短规则合同，正在执行唯一一次字段级完整替代。',
        'The generated global guidance did not satisfy the 4–8 short-rule contract; requesting the single field-level replacement.',
      ))
      const replacement = await this.callLLM(
        internalPrompt('global_guidance_replacement', writingLanguage, {
          min_rules: GENERATED_GLOBAL_GUIDANCE_MIN_RULES,
          max_rules: GENERATED_GLOBAL_GUIDANCE_MAX_RULES,
          max_chars: GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
          validated_config: JSON.stringify({ ...parsed, globalGuidance: undefined }, null, 2),
        }),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          purpose: 'generate-global-guidance-replacement',
          reasoningStage: 'planning',
          submitTool: 'submit_field',
        },
        context,
      )
      const replacementGuidance = replacement.trim()
      if (!isGeneratedGlobalGuidanceValid(replacementGuidance)) {
        throw new Error(text(
          `全局写作要求仍不符合 ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条且不超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符的合同，配置未应用。`,
          `The global guidance still does not satisfy the ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES}-rule, ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS}-character contract, so the configuration was not applied.`,
        ))
      }
      parsed = { ...parsed, globalGuidance: replacementGuidance }
    }

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(text(
        '当前项目已切换，智能配置结果未应用',
        'The current project changed, so the generated configuration was not applied.',
      ))
    }
    this.onGenerated(mergeExpandedNovelConfig(existingConfig, parsed))
    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(text(
        '当前项目已切换，智能配置结果未保存',
        'The current project changed, so the generated configuration was not saved.',
      ))
    }
    const saved = await useProjectStore.getState().saveProject(projectSession)
    this.assertNotCancelled(context)

    if (saved) {
      callbacks.log(text(
        'AI 配置生成并保存成功，请检查各字段后点击「生成架构」',
        'The AI configuration was generated and saved. Review the fields, then select Generate architecture.',
      ))
    } else {
      callbacks.log(text(
        'AI 配置生成成功，请检查各字段后点击「立即保存」',
        'The AI configuration was generated. Review the fields, then select Save now.',
      ))
    }
    callbacks.setProgress(100)
    return text('生成的配置已成功应用！', 'The generated configuration was applied successfully.')
  }
}


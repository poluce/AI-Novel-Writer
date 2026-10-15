import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import type { PartialArchData } from './plot-outline-checkpoint'
import { existingAuthorContentBlock } from './architecture-json-contract'
import {
  assertArchitectureProjectSessionCurrent,
  loadPartialData,
  savePartialData,
  writeArchToDb,
  type ArchitectureProjectSnapshot,
} from './architecture-persistence'

export class GenerateCoreSeedCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)
    callbacks.log(text('生成故事前提...', 'Generating story premise...'))

    const template = await resolvePromptTemplate('premise', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到 premise 模板',
      'The story-premise template was not found.',
    ))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withGenre(modelFacts.genre)
      .withSubGenre(config.subGenre || modelFacts.genre)
      .withTopic(config.coreOutline || missingValue)
      .withTargetAudience(modelFacts.targetAudience)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withCoreSetting(config.worldSetting || missingValue)
      .withGoldenFinger(config.goldenFinger || missingValue)
      .withProtagonistProfile(config.protagonistProfile || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).premise || '')
      .withReferenceWorks(config.referenceWorks || '')

    const core = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    const existingPremise = existingAuthorContentBlock(
      core?.premise,
      writingLanguage,
      '故事前提',
      'story premise',
    )
    const premisePrompt = existingPremise
      ? `${existingPremise}\n\n${promptBuilder.build()}`
      : promptBuilder.build()

    const result = await this.callLLM(
      premisePrompt,
      promptBuilder.getSystemRole(),
      callbacks,
      { purpose: 'generate-core-seed', reasoningStage: 'planning', submitTool: 'submit_text' },
      context,
    )
    if (!result.trim()) throw new Error(text(
      '故事前提生成失败，AI 返回空内容',
      'Story premise generation failed because the AI returned empty content.',
    ))
    if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow was cancelled.'))

    const heading = promptLanguageText(writingLanguage, '故事前提', 'Story Premise')
    const content = `# ${heading}\n\n${result}\n`
    this.assertNotCancelled(context)
    await writeArchToDb(
      'premise',
      content,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.premise_result = result
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
      text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
    )
    context.data.partial = partial

    callbacks.log(text(
      '故事前提已生成并写入数据库',
      'Story premise generated and saved to the database.',
    ))
    return result
  }
}


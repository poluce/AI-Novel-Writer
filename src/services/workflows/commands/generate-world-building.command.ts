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

export class GenerateWorldBuildingCommand extends BaseWorkflowCommand<string> {
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

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error(text(
        '故事前提尚未生成或内容不完整，请返回勾选生成',
        'The story premise is missing or incomplete. Go back and include it for generation.',
      ))
    }

    callbacks.log(text('生成世界观...', 'Generating worldbuilding...'))
    const template = await resolvePromptTemplate('world_building', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '模板丢失',
      'The worldbuilding template is missing.',
    ))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreSeed(premise_result)
      .withGenre(modelFacts.genre)
      .withCoreSetting(config.worldSetting || missingValue)
      .withGoldenFinger(config.goldenFinger || missingValue)
      .withProtagonistProfile(config.protagonistProfile || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).worldbuilding || '')

    // 上游角色图谱 + 本块已有世界观，都作为作者权威参考随提示词发送。
    const authorityBlocks = [
      existingAuthorContentBlock(core?.charactersArch, writingLanguage, '角色图谱', 'character graph'),
      existingAuthorContentBlock(core?.worldbuilding, writingLanguage, '世界观', 'worldbuilding'),
    ].filter(Boolean)
    const worldBuildingPrompt = authorityBlocks.length > 0
      ? `${authorityBlocks.join('\n\n')}\n\n${promptBuilder.build()}`
      : promptBuilder.build()

    const result = await this.callLLM(
      worldBuildingPrompt,
      promptBuilder.getSystemRole(),
      callbacks,
      { purpose: 'generate-world-building', reasoningStage: 'planning', submitTool: 'submit_text' },
      context,
    )
    if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow was cancelled.'))

    this.assertNotCancelled(context)
    const heading = promptLanguageText(writingLanguage, '世界观', 'Worldbuilding')
    await writeArchToDb(
      'worldbuilding',
      `# ${heading}\n\n${result}\n`,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.world_building_result = result
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
      '世界观已生成并写入数据库',
      'Worldbuilding generated and saved to the database.',
    ))
    return result
  }
}


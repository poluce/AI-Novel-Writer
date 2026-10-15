import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import type { WorkflowContext } from '../../../stores/workflow-store'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { ProjectCoreSynopsisExpected } from '../../../shared/contracts/project-core'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import {
  plotOutlineBatchLog,
  sameSynopsisCheckpoint,
  restoreSynopsisCheckpoint,
  stripPlotOutlineProgressLine,
  NonRecoverablePlotOutlineError,
  assertPlotOutlineTitleCoverage,
  synopsisFactsFingerprint,
  renderSynopsisDbText,
  synopsisInputsFingerprint,
  synopsisBatchInstruction,
  assertPlotOutlineBatchComplete,
  assertCheckpointDbMirrorCurrent,
  MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS,
  PlotOutlineResumeAvailableError,
  type PlotOutlineChapterRange,
  type PartialArchData,
} from './plot-outline-checkpoint'
import {
  assertArchitectureProjectSessionCurrent,
  emitArchFileUpdated,
  loadPartialData,
  savePartialData,
  type ArchitectureProjectSnapshot,
} from './architecture-persistence'

export class GeneratePlotArchitectureCommand extends BaseWorkflowCommand<string> {
  constructor(
    private selectedSteps: string[],
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly options: {
      /** 从上次中断点续写当前批次（需要有效检查点：incomplete=true 且指纹匹配）。 */
      resumeSynopsis?: boolean
      /** 本次生成范围 [from..to]；缺省 = 第 1 章到全书（显式覆盖重写）。 */
      synopsisRange?: PlotOutlineChapterRange | null
    } = {},
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
    const premise = core?.premise || ''
    const char_dyn = core?.charactersArch || ''
    const world_b = core?.worldbuilding || ''

    if (!premise || premise.includes('待生成')) throw new Error(text(
      '故事前提未生成',
      'The story premise has not been generated.',
    ))
    if (!char_dyn || char_dyn.includes('待生成')) throw new Error(text(
      '角色图谱未生成',
      'The character graph has not been generated.',
    ))
    if (!world_b || world_b.includes('待生成')) throw new Error(text(
      '世界观未生成',
      'Worldbuilding has not been generated.',
    ))

    const totalChapters = Number(config.totalChapters) > 0 ? Number(config.totalChapters) : 0
    if (totalChapters <= 0) throw new Error(text(
      '小说配置的总章数无效，无法生成情节大纲',
      'The total chapter count in the novel configuration is invalid; the plot outline cannot be generated.',
    ))

    const sourceExpected: ProjectCoreSynopsisExpected = {
      synopsis: core?.synopsis || '',
      premise,
      charactersArch: char_dyn,
      worldbuilding: world_b,
      genre: config.genre || '',
      totalChapters,
      wordsPerChapter: Number(config.wordsPerChapter) || 0,
      writingLanguage,
      plotStructure: config.plotStructure || '',
      narrativePov: config.narrativePOV || '',
      globalGuidance: config.globalGuidance || '',
    }
    const requestedStepGuidance = ((context.data.stepGuidance as Record<string, string>) || {}).synopsis || ''

    const resumeRequested = this.options.resumeSynopsis === true
    callbacks.log(text(
      resumeRequested
        ? '正在读取情节大纲中断检查点...'
        : '生成情节大纲...',
      resumeRequested
        ? 'Reading the interrupted plot-outline checkpoint...'
        : 'Generating plot outline...',
    ))

    const template = await resolvePromptTemplate('synopsis', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '模板丢失',
      'The plot-outline template is missing.',
    ))

    const { getPlotStructureGuide, getNarrativePOVLabel } = await import('../architecture-workflow')
    const guide = getPlotStructureGuide(
      config.plotStructure || 'three_act',
      totalChapters,
      writingLanguage,
    )
    const pov = getNarrativePOVLabel(config.narrativePOV || 'third_limited', writingLanguage)

    // ===== 状态机：解析本次批次模式与检查点 =====
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    context.data.partial = partial
    const coveredTo = partial.synopsis_covered_to ?? 0
    const interrupted = partial.synopsis_incomplete === true
    const checkpointFingerprint = partial.synopsis_facts_fingerprint

    let mode: 'resume' | 'fresh' | 'batch'
    let from: number
    let to: number
    let seedText = ''
    let effectiveStepGuidance = requestedStepGuidance

    if (resumeRequested) {
      // ---- 断点续写：无有效检查点必须 fail-closed，绝不退化为覆盖生成 ----
      if (!interrupted) {
        throw new Error(text(
          '未找到中断的情节大纲检查点（当前大纲没有未完成的批次）。请从「AI 生成故事架构」重新生成。',
          'No interrupted plot-outline checkpoint was found (no batch is incomplete). Regenerate from “Generate story architecture” instead.',
        ))
      }
      if (!partial.synopsis_range) {
        throw new Error(text(
          '中断检查点缺少批次范围，无法续写。请从「AI 生成故事架构」重新生成。',
          'The interrupted checkpoint is missing its batch range. Regenerate from “Generate story architecture” instead.',
        ))
      }
      from = partial.synopsis_range.from
      to = partial.synopsis_range.to
      if (partial.synopsis_step_guidance === undefined) {
        throw new Error(text(
          '旧情节大纲检查点缺少完整输入绑定，无法证明其来源事实与当前一致，不能自动续写。检查点与数据库正文均已保留；请从第 1 章重新生成。',
          'This legacy plot-outline checkpoint lacks complete input binding, so its source facts cannot be proven to match the current project and it cannot be continued automatically. The checkpoint and database prose remain preserved; regenerate from chapter 1.',
        ))
      }
      effectiveStepGuidance = partial.synopsis_step_guidance
      const expectedCheckpointFingerprint = synopsisInputsFingerprint(
        sourceExpected,
        effectiveStepGuidance,
        { from, to },
        template,
      )
      if (checkpointFingerprint !== expectedCheckpointFingerprint) {
        throw new Error(text(
          '项目源事实（故事前提/角色/世界观/总章数等）自上次中断后已变化，旧检查点不能续到新上下文。请从「AI 生成故事架构」重新生成情节大纲。',
          'The source facts (premise / characters / worldbuilding / chapter count, etc.) changed after the interruption, so the old checkpoint cannot be continued into the new context. Regenerate the plot outline from “Generate story architecture”.',
        ))
      }
      seedText = assertCheckpointDbMirrorCurrent(
        partial,
        sourceExpected.synopsis,
        writingLanguage,
        totalChapters,
        text,
      )
      if (seedText.length < MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS) {
        throw new Error(text(
          '中断检查点内容过短，无法安全续写。请从「AI 生成故事架构」重新生成。',
          'The interrupted checkpoint is too short to resume safely. Regenerate from “Generate story architecture” instead.',
        ))
      }
      mode = 'resume'
    } else {
      const requested = this.options.synopsisRange ?? null
      if (requested && (
        !Number.isSafeInteger(requested.from) || !Number.isSafeInteger(requested.to)
        || requested.from < 1 || requested.to > totalChapters || requested.from > requested.to
      )) {
        throw new Error(text(
          `章节范围无效：必须满足 1 ≤ from ≤ to ≤ ${totalChapters}`,
          `Invalid chapter range: expected 1 ≤ from ≤ to ≤ ${totalChapters}.`,
        ))
      }
      from = requested?.from ?? 1
      to = requested?.to ?? totalChapters
      if (from === 1) {
        // 覆盖重写（显式发起）或首次生成。若只覆盖到一半会静默丢弃
        // 第 to+1–coveredTo 章的已确认大纲 → 拒绝，要求续批或全量重写。
        if (!interrupted && coveredTo > 0 && to < coveredTo) {
          throw new Error(text(
            `本批只生成到第 ${to} 章，将丢弃已确认的第 ${to + 1}–${coveredTo} 章大纲。`
              + `若只需补充，请从第 ${coveredTo + 1} 章发起续批；若确定重写，请生成 1–${Math.max(coveredTo, totalChapters)} 章全量覆盖。`,
            `This batch stops at chapter ${to} and would discard the confirmed outline for chapters ${to + 1}-${coveredTo}. `
              + `To extend, continue from chapter ${coveredTo + 1}; to rewrite, regenerate the full range 1-${Math.max(coveredTo, totalChapters)}.`,
          ))
        }
        mode = 'fresh'
      } else {
        // 连续续批：不得跳跃、不得重写已确认前缀、源事实不得变化
        if (interrupted) {
          throw new Error(text(
            '当前存在未完成的批次（可断点续写）。请先完成该批次，再发起下一批生成。',
            'A batch is still incomplete (it can be resumed). Finish that batch before starting the next one.',
          ))
        }
        if (coveredTo <= 0 || from !== coveredTo + 1) {
          throw new Error(text(
            coveredTo > 0 && from <= coveredTo
              ? `第 ${from} 章已包含在已确认大纲中。请从第 ${coveredTo + 1} 章继续，或从第 1 章显式选择覆盖重写。`
              : `大纲必须连续生成：当前已覆盖至第 ${coveredTo} 章，本批应从第 ${coveredTo + 1} 章开始。`,
            coveredTo > 0 && from <= coveredTo
              ? `Chapter ${from} is already inside the confirmed outline. Continue from chapter ${coveredTo + 1}, or explicitly rewrite from chapter 1.`
              : `The outline must grow contiguously: chapters up to ${coveredTo} are confirmed, so this batch must start at chapter ${coveredTo + 1}.`,
          ))
        }
        if (!partial.synopsis_range) {
          throw new Error(text(
            '续批检查点缺少上一批范围，无法确认连续覆盖。请从第 1 章重新生成。',
            'The continuation checkpoint is missing the previous batch range. Regenerate from chapter 1.',
          ))
        }
        if (partial.synopsis_step_guidance === undefined) {
          throw new Error(text(
            '旧情节大纲检查点缺少完整输入绑定，无法证明其来源事实与当前一致，不能自动续批。检查点与数据库正文均已保留；请从第 1 章重新生成。',
            'This legacy plot-outline checkpoint lacks complete input binding, so its source facts cannot be proven to match the current project and it cannot be extended automatically. The checkpoint and database prose remain preserved; regenerate from chapter 1.',
          ))
        }
        const checkpointStepGuidance = partial.synopsis_step_guidance
        const expectedCheckpointFingerprint = synopsisInputsFingerprint(
          sourceExpected,
          checkpointStepGuidance,
          partial.synopsis_range,
          template,
        )
        if (checkpointFingerprint !== expectedCheckpointFingerprint) {
          throw new Error(text(
            '项目源事实自上次生成后已变化，既有大纲不能与新的源事实拼接。请从「AI 生成故事架构」从第 1 章重新生成。',
            'The source facts changed since the previous generation, so the existing outline cannot be joined with the new facts. Regenerate from chapter 1 in “Generate story architecture”.',
          ))
        }
        seedText = assertCheckpointDbMirrorCurrent(
          partial,
          sourceExpected.synopsis,
          writingLanguage,
          totalChapters,
          text,
        )
        mode = 'batch'
      }
    }

    const factsFingerprint = synopsisInputsFingerprint(
      sourceExpected,
      effectiveStepGuidance,
      { from, to },
      template,
    )
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreSeed(premise)
      .withCharacterDynamics(char_dyn)
      .withWorldBuilding(world_b)
      .withGenre(modelFacts.genre)
      .withNumberOfChapters(totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withPlotStructureGuide(guide)
      .withNarrativePov(pov)
      .withGlobalGuidance(config.globalGuidance || promptLanguageText(writingLanguage, '（未填写）', '(not provided)'))
      .withStepGuidance(effectiveStepGuidance)

    if (mode === 'resume') {
      callbacks.log(text(
        `检测到中断检查点，正在续写第 ${from}–${to} 章（全书 ${totalChapters} 章）...`,
        `An interrupted checkpoint was found; resuming chapters ${from}-${to} of ${totalChapters}...`,
      ))
    } else if (mode === 'fresh') {
      callbacks.log(text(
        to < totalChapters
          ? `正在生成第 ${from}–${to} 章大纲（全书 ${totalChapters} 章；本批后可从第 ${to + 1} 章继续分块补齐）...`
          : `正在生成全书 ${totalChapters} 章情节大纲...`,
        to < totalChapters
          ? `Generating the outline for chapters ${from}-${to} of ${totalChapters} (later batches may continue from chapter ${to + 1})...`
          : `Generating the ${totalChapters}-chapter plot outline...`,
      ))
    } else {
      callbacks.log(text(
        `正在续接第 ${from}–${to} 章（保留已确认的第 1–${coveredTo} 章，不会覆盖）...`,
        `Continuing chapters ${from}-${to} (chapters 1-${coveredTo} are kept unchanged)...`,
      ))
    }

    const taskPrompt = [
      promptBuilder.build(),
      synopsisBatchInstruction(writingLanguage, from, to, totalChapters),
    ].filter(Boolean).join('\n\n')

    // ===== 有界生成：seed 续写 + 自动续写；任何失败先交出已合并文本 =====
    let interruptedContent = ''
    let merged = ''
    const runCompletion = async (): Promise<string> => {
      merged = await this.callLLMWithAppendContinuation({
        taskPrompt,
        systemPrompt: promptBuilder.getSystemRole(),
        callbacks,
        context,
        llmOptions: {
          purpose: mode === 'resume'
            ? 'generate-plot-architecture-resume'
            : mode === 'batch'
              ? 'generate-plot-architecture-batch'
              : 'generate-plot-architecture',
          reasoningStage: 'planning',
          submitTool: 'submit_text',
        },
        seedText,
        maxContinuations: 3,
        onPartialAvailable: content => { interruptedContent = content },
      })
      return merged
    }

    // 中断/机械校验失败时：落盘已完成部分并抛出可续写错误
    const persistAndRaiseResume = async (
      partialBody: string,
      cause: Error,
      allowIncompleteLastEntry = false,
    ): Promise<never> => {
      if (partialBody.length < MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS) throw cause
      try {
        assertPlotOutlineTitleCoverage(
          partialBody,
          seedText,
          from,
          to,
          text,
          allowIncompleteLastEntry,
        )
      } catch (error) {
        if (error instanceof NonRecoverablePlotOutlineError) throw error
      }
      this.assertNotCancelled(context)
      assertArchitectureProjectSessionCurrent(projectSession, context)
      await this.persistInterruptedSynopsis(
        projectSession,
        expectedProjectPath,
        context,
        partialBody,
        { from, to },
        factsFingerprint,
        effectiveStepGuidance,
        sourceExpected,
      )
      callbacks.log(text(
        `已完成部分（约 ${partialBody.length} 字）已保存，可点击「继续生成情节大纲」从断点续写`,
        `The completed part (about ${partialBody.length} characters) was saved. Click “Continue plot outline” to resume from the break point.`,
      ))
      throw new PlotOutlineResumeAvailableError(text(
        `情节大纲生成在完成前中断：${cause instanceof Error ? cause.message : String(cause)}。已完成部分（约 ${partialBody.length} 字）已自动保存为不完整状态，没有白费。\n点击「继续生成情节大纲」可续写本批（第 ${from}–${to} 章）；如本批范围仍偏大，可先在「AI 生成架构」缩小每批章节数后重试。`,
        `Plot-outline generation stopped before completing this batch: ${cause instanceof Error ? cause.message : String(cause)}. The finished part (about ${partialBody.length} characters) was saved automatically.\nClick “Continue plot outline” to finish batch chapters ${from}-${to}; if the batch is still too large, choose a smaller per-batch range in “Generate story architecture” and retry.`,
      ))
    }

    try {
      merged = await runCompletion()
    } catch (error) {
      const partialText = interruptedContent.trim()
      const seedTrimmed = seedText.trim()
      const madeProgress = partialText !== seedTrimmed
      if (
        !context.cancelled
        && madeProgress
        && partialText.length >= MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS
      ) {
        await persistAndRaiseResume(partialText, error as Error, true)
      }
      throw error
    }

    if (!merged.trim()) throw new Error(text(
      '情节大纲生成失败，AI 返回空内容',
      'Plot outline generation failed because the AI returned empty content.',
    ))

    // ===== 完成校验：正文必须完整覆盖本批；附带进度行时也必须与范围一致 =====
    let confirmedBody = ''
    try {
      assertPlotOutlineTitleCoverage(merged, seedText, from, to, text)
      assertPlotOutlineBatchComplete(merged, from, to, totalChapters, text)
      confirmedBody = stripPlotOutlineProgressLine(merged)
    } catch (error) {
      if (error instanceof NonRecoverablePlotOutlineError) throw error
      await persistAndRaiseResume(stripPlotOutlineProgressLine(merged), error as Error)
    }
    if (!confirmedBody) {
      // persistAndRaiseResume 已以中断错误终结；此处仅为类型安全的兜底。
      throw new Error(text('情节大纲未完成且无法保存', 'The plot outline is incomplete and could not be saved.'))
    }

    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    // ===== 落盘：先写检查点（权威进度 + DB 镜像指纹），再镜像到 DB 正文 =====
    const previousPartial = { ...partial }
    partial.synopsis_result = confirmedBody
    partial.synopsis_incomplete = false
    partial.synopsis_covered_to = to
    partial.synopsis_range = { from, to }
    partial.synopsis_facts_fingerprint = factsFingerprint
    partial.synopsis_body_hash = synopsisFactsFingerprint([confirmedBody])
    partial.synopsis_step_guidance = effectiveStepGuidance
    const dbOutlineText = renderSynopsisDbText(confirmedBody, writingLanguage, totalChapters, partial)
    partial.synopsis_db_hash = synopsisFactsFingerprint([dbOutlineText])
    context.data.partial = partial
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存情节大纲批次检查点', 'Save the plot-outline batch checkpoint'),
      text('保存情节大纲批次检查点失败', 'Failed to save the plot-outline batch checkpoint.'),
    )
    if (context.cancelled) {
      await this.rollbackSynopsisCheckpoint(
        expectedProjectPath,
        projectSession,
        context,
        previousPartial,
        partial,
      )
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    await this.commitSynopsisWithCheckpointRollback(
      dbOutlineText,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      sourceExpected,
      previousPartial,
      partial,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    // 全书完成的「全流程」运行（前提+角色+世界观+大纲一次做完）才清理检查点文件；
    // 分块/续批运行保留检查点供后续批次与断点续写使用。
    if (to >= totalChapters
      && this.selectedSteps.includes('premise') && this.selectedSteps.includes('characters')
      && this.selectedSteps.includes('worldbuilding') && this.selectedSteps.includes('synopsis')) {
      this.assertNotCancelled(context)
      requireIpcSuccess(
        await ipc.invokeWithProjectSession(
          projectSession,
          'fs:write-file',
          `${expectedProjectPath}/.vela/partial_arch.json`,
          '{}',
          expectedProjectPath,
        ),
        text('清理架构生成检查点', 'Clear architecture-generation checkpoint'),
        text('清理架构生成检查点失败', 'Failed to clear the architecture-generation checkpoint.'),
      )
    }

    const batchLog = plotOutlineBatchLog(mode, from, to, totalChapters)
    callbacks.log(text(batchLog.zhCNText, batchLog.enUSText))
    return confirmedBody
  }

  private async rollbackSynopsisCheckpoint(
    expectedProjectPath: string,
    projectSession: ProjectSessionContext,
    context: WorkflowContext,
    previousPartial: PartialArchData,
    writtenPartial: PartialArchData,
  ): Promise<void> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const readResult = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:read-json',
      `${expectedProjectPath}/.vela/partial_arch.json`,
      expectedProjectPath,
    )
    if (!readResult.success || !readResult.data) {
      throw new Error(text(
        '无法回读当前架构检查点',
        'The current architecture checkpoint could not be read back.',
      ))
    }
    const currentPartial = readResult.data as PartialArchData
    if (!sameSynopsisCheckpoint(currentPartial, writtenPartial)) {
      context.data.partial = currentPartial
      return
    }
    const restored = restoreSynopsisCheckpoint(currentPartial, previousPartial)
    await savePartialData(
      expectedProjectPath,
      restored,
      projectSession,
      text('恢复旧情节大纲检查点', 'Restore the previous plot-outline checkpoint'),
      text('恢复旧情节大纲检查点失败', 'Failed to restore the previous plot-outline checkpoint.'),
    )
    context.data.partial = restored
  }

  private async commitSynopsisWithCheckpointRollback(
    synopsis: string,
    expectedProjectPath: string,
    runId: string,
    projectSession: ProjectSessionContext,
    context: WorkflowContext,
    expected: ProjectCoreSynopsisExpected,
    previousPartial: PartialArchData,
    writtenPartial: PartialArchData,
    fallbackError: string,
  ): Promise<void> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-synopsis-commit',
      { synopsis, expected },
      expectedProjectPath,
    )
    if (!result.success) {
      let commitError = result.error || fallbackError
      if (result.error === '项目数据已变化，已拒绝覆盖情节大纲') {
        commitError = text(
          '项目数据已变化，已拒绝覆盖情节大纲。',
          'Project data changed while the outline was being generated, so overwriting it was refused.',
        )
      }
      try {
        await this.rollbackSynopsisCheckpoint(
          expectedProjectPath,
          projectSession,
          context,
          previousPartial,
          writtenPartial,
        )
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(text(
          `${commitError} 同时无法安全恢复旧检查点：${detail}`,
          `${commitError} The previous checkpoint also could not be restored safely: ${detail}`,
        ))
      }
      throw new Error(commitError)
    }

    emitArchFileUpdated('synopsis.md', expectedProjectPath, projectSession, runId)
  }

  /**
   * 中断时落盘：先写检查点（权威：正文 + 批次范围 + 源事实指纹 + 未完成标记），
   * 再镜像 DB 正文并附加「未完成」说明。检查点写入失败时不提供续写入口。
   */
  private async persistInterruptedSynopsis(
    projectSession: ProjectSessionContext,
    expectedProjectPath: string,
    context: WorkflowContext,
    partialText: string,
    range: PlotOutlineChapterRange,
    factsFingerprint: string,
    stepGuidance: string,
    sourceExpected: ProjectCoreSynopsisExpected,
  ): Promise<void> {
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    const previousPartial = { ...partial }
    partial.synopsis_result = partialText
    partial.synopsis_incomplete = true
    partial.synopsis_covered_to = range.from - 1
    partial.synopsis_range = { from: range.from, to: range.to }
    partial.synopsis_facts_fingerprint = factsFingerprint
    partial.synopsis_body_hash = synopsisFactsFingerprint([partialText])
    partial.synopsis_step_guidance = stepGuidance
    const dbOutlineText = renderSynopsisDbText(
      partialText,
      writingLanguage,
      sourceExpected.totalChapters,
      partial,
    )
    partial.synopsis_db_hash = synopsisFactsFingerprint([dbOutlineText])
    context.data.partial = partial
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存中断的情节大纲检查点', 'Save the interrupted plot-outline checkpoint'),
      text('保存中断的情节大纲检查点失败', 'Failed to save the interrupted plot-outline checkpoint.'),
    )
    if (context.cancelled) {
      await this.rollbackSynopsisCheckpoint(
        expectedProjectPath,
        projectSession,
        context,
        previousPartial,
        partial,
      )
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    await this.commitSynopsisWithCheckpointRollback(
      dbOutlineText,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      sourceExpected,
      previousPartial,
      partial,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
  }
}

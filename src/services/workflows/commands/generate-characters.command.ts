import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import {
  composePromptSystemRole,
  renderPromptTaskGuidance,
  resolvePromptTemplate,
} from '../../prompt-templates'
import { ipc } from '../../ipc-client'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { characterArchitecturePrompts, promptLanguageText } from '../../prompt-language'
import {
  CHARACTER_ROSTER_SCHEMA_VERSION,
  type CharacterRosterCommitRequest,
  type CharacterRosterEntry,
} from '../../../shared/character-roster'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import type { UiText, PartialArchData } from './plot-outline-checkpoint'
import {
  existingAuthorContentBlock,
  extractSingleCompleteJsonObject,
  decodeCharacterIdentityManifest,
  validateCharacterDetail,
  normalizeDetailStringList,
  normalizeBoundedDetailText,
  promptUtf8Bytes,
  isRecord,
  type CharacterIdentitySlot,
  type CharacterDetailOutput,
  MIN_CHARACTER_SLOTS,
  MAX_CHARACTER_SLOTS,
  CHARACTER_DETAIL_BATCH_SIZE,
  CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS,
  CHARACTER_STATE_TEXT_MAX_CHARS,
  CHARACTER_DETAIL_DESCRIPTION_FIELDS,
  CHARACTER_STATE_TEXT_FIELDS,
  MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
} from './architecture-json-contract'
import {
  assertArchitectureProjectSessionCurrent,
  loadPartialData,
  savePartialData,
  type ArchitectureProjectSnapshot,
} from './architecture-persistence'

export class GenerateCharactersCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  private assertCommittedRosterReadable(
    receipt: { snapshot?: { entries?: Array<{ name?: unknown }>; renderedMarkdown?: unknown } } | undefined,
    candidateEntries: unknown,
    text: UiText,
  ): asserts receipt is { snapshot: { entries: Array<{ name: string }>; renderedMarkdown: string } } {
    const snapshot = receipt?.snapshot
    if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0 || typeof snapshot.renderedMarkdown !== 'string' || !snapshot.renderedMarkdown.trim()) {
      throw new Error(text(
        '角色名单提交后未能回读角色卡和角色图谱，未将本步骤标记为成功',
        'Character cards and the character graph could not be read back after commit, so this step was not marked complete.',
      ))
    }

    if (!Array.isArray(candidateEntries)) return
    const candidateNames = candidateEntries
      .map(entry => (
        entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name.trim()
          : ''
      ))
      .filter(Boolean)
    const committedNames = new Set(snapshot.entries
      .map(entry => typeof entry.name === 'string' ? entry.name.trim() : '')
      .filter(Boolean))
    if (candidateNames.length === 0 || candidateNames.some(name => !committedNames.has(name))) {
      throw new Error(text(
        '角色名单提交回读不完整，未将本步骤标记为成功',
        'The committed character roster readback was incomplete, so this step was not marked complete.',
      ))
    }
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('character-architecture', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const promptCopy = characterArchitecturePrompts(writingLanguage)
    const creativeTemplate = await resolvePromptTemplate('character_dynamics', projectSession, writingLanguage)
    if (!creativeTemplate) throw new Error(text(
      '角色规划模板丢失',
      'The character-planning template is missing.',
    ))
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

    callbacks.log(text('生成角色图谱...', 'Generating character graph...'))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const manifestContext = {
      premise: premise_result,
      genre: modelFacts.genre,
      protagonistProfile: config.protagonistProfile || missingValue,
      globalGuidance: config.globalGuidance || missingValue,
      stepGuidance: ((context.data.stepGuidance as Record<string, string>) || {}).characters || missingValue,
      referenceWorks: config.referenceWorks || missingValue,
    }
    const manifestContextJson = JSON.stringify(manifestContext)
    const templateVariables = {
      premise: manifestContext.premise,
      genre: manifestContext.genre,
      protagonist_profile: manifestContext.protagonistProfile,
      global_guidance: manifestContext.globalGuidance,
      step_guidance: manifestContext.stepGuidance,
      reference_works: manifestContext.referenceWorks,
      number_of_chapters: String(config.totalChapters),
      golden_finger: config.goldenFinger || missingValue,
      world_building: config.worldSetting || missingValue,
    }
    const creativeSystem = composePromptSystemRole(creativeTemplate, writingLanguage)
    const creativeGuidance = renderPromptTaskGuidance(creativeTemplate, templateVariables, writingLanguage)
    const manifestSystem = `${creativeSystem}\n\n${promptCopy.manifestSystem}`
    const manifestTask = promptCopy.manifestTask(
      manifestContextJson,
      MIN_CHARACTER_SLOTS,
      MAX_CHARACTER_SLOTS,
    )
    const existingCharacters = existingAuthorContentBlock(
      core?.charactersArch,
      writingLanguage,
      '角色图谱',
      'character graph',
    )
    const manifestPrompt = [
      existingCharacters,
      creativeGuidance ? `${creativeGuidance}\n\n${manifestTask}` : manifestTask,
    ].filter(Boolean).join('\n\n')
    const manifestSection = (sectionName: string, key: keyof typeof manifestContext) => ({
      sectionName,
      messageIndex: 1,
      finalText: JSON.stringify({ [key]: manifestContext[key] }).slice(1, -1),
    })
    const manifestRaw = await this.callLLMWithBoundedCompletion(
      manifestPrompt,
      manifestSystem,
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 2 },
      {
        responseFormat: { type: 'json_object' },
        purpose: 'character-architecture-manifest',
        reasoningStage: 'planning',
        submitTool: 'submit_json',
        promptBudget: {
          limitUtf8Bytes: MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
          sections: [
            {
              sectionName: 'system-instructions',
              messageIndex: 0,
              finalText: manifestSystem,
            },
            manifestSection('story-premise', 'premise'),
            manifestSection('genre', 'genre'),
            manifestSection('protagonist-profile', 'protagonistProfile'),
            manifestSection('global-guidance', 'globalGuidance'),
            manifestSection('step-guidance', 'stepGuidance'),
            manifestSection('reference-works', 'referenceWorks'),
          ],
        },
      },
      context,
    )
    let manifest: CharacterIdentitySlot[]
    try {
      manifest = decodeCharacterIdentityManifest(manifestRaw)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(text(
        detail,
        'The character identity manifest was invalid, so no character data was saved.',
      ))
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const manifestById = new Map(manifest.map(slot => [slot.slotId, slot]))
    const detailContract: StructuredBatchContract<CharacterIdentitySlot, CharacterDetailOutput> = {
      buildTask: ({ items, validatedPrefix }) => {
        this.assertNotCancelled(context)
        assertArchitectureProjectSessionCurrent(projectSession, context)
        const prefix = JSON.stringify(validatedPrefix.map(entry => ({
          slotId: entry.slotId,
          name: entry.name,
          role: entry.role,
          relationships: entry.relationships,
        })))
        const frozenManifest = JSON.stringify({ slots: manifest })
        const slotIds = items.map(slot => slot.slotId).join(', ')
        const detailTask = promptCopy.detailTask({
          context: manifestContextJson,
          manifest: frozenManifest,
          slotIds,
          validatedPrefix: prefix,
        })
        const detailPrompt = creativeGuidance
          ? `${creativeGuidance}\n\n${detailTask}`
          : detailTask
        const detailSystem = `${creativeSystem}\n\n${promptCopy.detailSystem}`
        const detailRequestBytes = promptUtf8Bytes(detailSystem) + promptUtf8Bytes(detailPrompt)
        const fixedDetailRequestBytes = detailRequestBytes - promptUtf8Bytes(prefix)
        return {
          purpose: 'character-architecture-details',
          output: 'structured-data',
          submitTool: 'submit_json',
          messages: [
            { role: 'system', content: detailSystem },
            {
              role: 'user',
              content: detailPrompt,
            },
          ],
          promptBudget: {
            limitUtf8Bytes: fixedDetailRequestBytes + MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
            sections: [
              {
                sectionName: 'system-instructions',
                messageIndex: 0,
                finalText: detailSystem,
              },
              manifestSection('story-premise', 'premise'),
              manifestSection('genre', 'genre'),
              manifestSection('protagonist-profile', 'protagonistProfile'),
              manifestSection('global-guidance', 'globalGuidance'),
              manifestSection('step-guidance', 'stepGuidance'),
              manifestSection('reference-works', 'referenceWorks'),
              {
                sectionName: 'identity-manifest',
                messageIndex: 1,
                finalText: frozenManifest,
              },
              {
                sectionName: 'batch-slot-ids',
                messageIndex: 1,
                finalText: slotIds,
              },
              {
                sectionName: 'validated-prefix',
                messageIndex: 1,
                finalText: prefix,
              },
            ],
          },
        }
      },
      inputKey: slot => slot.slotId,
      outputKey: entry => entry.slotId,
      decode: (content) => {
        const parsed = JSON.parse(extractSingleCompleteJsonObject(content)) as { entries?: unknown }
        if (!Array.isArray(parsed.entries)) throw new Error(text(
          '角色详情响应缺少 entries',
          'The character-detail response is missing entries.',
        ))
        return parsed.entries.map((candidate) => {
          if (!isRecord(candidate)) return candidate as unknown as CharacterDetailOutput
          const age = candidate.age
          const normalizedCandidate = { ...candidate }
          for (const field of CHARACTER_DETAIL_DESCRIPTION_FIELDS) {
            normalizedCandidate[field] = normalizeBoundedDetailText(
              candidate[field],
              CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS,
            )
          }
          let currentState: unknown = candidate.currentState
          if (isRecord(candidate.currentState)) {
            const normalizedState: Record<string, unknown> = {
              ...candidate.currentState,
              keyItems: normalizeDetailStringList(candidate.currentState.keyItems, '、'),
              recentEvents: normalizeDetailStringList(candidate.currentState.recentEvents, '；'),
              // Architecture generation describes the pre-chapter baseline. A
              // model-supplied future chapter must never become persisted fact.
              updatedAtChapter: 0,
            }
            for (const field of CHARACTER_STATE_TEXT_FIELDS) {
              normalizedState[field] = normalizeBoundedDetailText(
                normalizedState[field],
                CHARACTER_STATE_TEXT_MAX_CHARS,
              )
            }
            currentState = normalizedState
          }
          return {
            ...normalizedCandidate,
            ...(typeof age === 'number' && Number.isFinite(age) ? { age: String(age) } : {}),
            currentState,
          } as unknown as CharacterDetailOutput
        })
      },
      validateItem: (entry) => {
        const basicError = validateCharacterDetail(entry)
        if (basicError) return basicError
        const slot = manifestById.get(entry.slotId)
        if (!slot || slot.name !== entry.name || slot.role !== entry.role) return '角色详情身份与冻结清单不一致'
        return undefined
      },
    }
    const generationExecution = this.requireGenerationExecution()
    const detailExecution = await createStructuredBatchExecutor({
      contract: detailContract,
      session: generationExecution.session,
      writingLanguage,
      onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
    }).execute({
      items: manifest,
      limits: { maxBatchItems: CHARACTER_DETAIL_BATCH_SIZE },
      signal: generationExecution.signal,
    })
    if (!detailExecution.ok) {
      const diagnostic = detailExecution.failure.diagnostic
      const attempts = detailExecution.receipt.attempts.length > 0
        ? detailExecution.receipt.attempts
            .map(attempt => `purpose=${attempt.purpose ?? 'unknown'} finishReason=${attempt.finishReason}`)
            .join('; ')
        : 'none'
      const failureReceipt = [
        `code=${detailExecution.failure.code}`,
        `reason=${detailExecution.failure.reason ?? 'unknown'}`,
        ...(diagnostic
          ? [`diagnosticCode=${diagnostic.code} diagnosticPath=${diagnostic.path} diagnosticField=${diagnostic.field}`]
          : []),
        `attempts=${attempts}`,
      ].join(' ')
      throw new Error(text(
        `${detailExecution.failure.message}；角色详情失败收据：${failureReceipt}`,
        `Character details failed structural validation and were not saved. Receipt: ${failureReceipt}`,
      ))
    }
    if (detailExecution.items.length !== manifest.length) {
      throw new Error(text(
        '角色详情未完整覆盖冻结身份清单',
        'Character details did not fully cover the frozen identity manifest.',
      ))
    }
    const entries = detailExecution.items.map((detail) => {
      const entry: Record<string, unknown> = { ...detail }
      delete entry.slotId
      entry.relationships = manifestById.get(detail.slotId)!.relations.map(relation => ({
        target: manifestById.get(relation.targetSlotId)!.name,
        relation: relation.relation,
      }))
      return entry as unknown as CharacterRosterEntry
    })
    const candidate = { schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION, entries }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const currentRoster = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    const commitResult = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-commit',
      {
        operationId: context.runId,
        expectedRevision: currentRoster.revision,
        schemaVersion: candidate.schemaVersion as typeof CHARACTER_ROSTER_SCHEMA_VERSION,
        entries: candidate.entries as CharacterRosterEntry[],
        intent: 'architecture_generation',
      } satisfies CharacterRosterCommitRequest,
      expectedProjectPath,
    )
    if (!commitResult.success) {
      throw new Error(commitResult.error || text(
        '角色名单提交失败，未保存角色图谱或角色卡',
        'The character-roster commit failed, so the character graph and cards were not saved.',
      ))
    }
    this.assertCommittedRosterReadable(commitResult.receipt, candidate.entries, text)
    const renderedMarkdown = commitResult.receipt.snapshot.renderedMarkdown
    const characterCount = commitResult.receipt.snapshot.entries.length

    // 事务 receipt 是取消边界：提交成功后不再把已保存的角色事实误报为零写入取消。
    if (context.cancelled) {
      this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)
      callbacks.log(text(
        `角色图谱与 ${characterCount} 张角色卡已生成；后续工作流已取消`,
        `The character graph and ${characterCount} character cards were generated; the remaining workflow was cancelled.`,
      ))
      return renderedMarkdown
    }

    this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    if (context.cancelled) {
      callbacks.log(text(
        `角色图谱与 ${characterCount} 张角色卡已生成；后续工作流已取消`,
        `The character graph and ${characterCount} character cards were generated; the remaining workflow was cancelled.`,
      ))
      return renderedMarkdown
    }
    partial.character_dynamics_result = renderedMarkdown
    context.data.partial = partial
    try {
      await savePartialData(
        expectedProjectPath,
        partial,
        projectSession,
        text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
        text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      callbacks.log(
        text(
          `[警告] 角色图谱与 ${characterCount} 张角色卡已保存，但检查点保存失败：${detail}。当前流程可继续；若中断，将无法从此步骤恢复。`,
          `[Warning] The character graph and ${characterCount} character cards were saved, but the checkpoint failed: ${detail}. The workflow can continue, but it cannot resume from this step after an interruption.`,
        ),
      )
    }

    callbacks.log(text(
      `角色图谱与 ${characterCount} 张角色卡已生成`,
      `The character graph and ${characterCount} character cards were generated.`,
    ))
    return renderedMarkdown
  }
}


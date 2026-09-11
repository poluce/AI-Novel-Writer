import type { DatabaseChannels } from '../shared/ipc-channels'
import type {
  NarrativeThreadEventType,
  NarrativeThreadPlanInput,
  NarrativeThreadView,
} from '../shared/narrative-thread'
import type { WritingLanguage } from '../shared/writing-language'
import { promptLanguageText } from './prompt-language'
import {
  createGenerationRuntime,
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from './generation/generation-runtime'
import { internalPrompt } from '../prompts/internal/load'

export type NarrativeThreadPlanCandidate = NarrativeThreadPlanInput

export interface NarrativeThreadEventCandidate {
  type: NarrativeThreadEventType
  evidence: string
  reason: string
}

type BlueprintData = DatabaseChannels['db:blueprint-get-all']['return'][number]

export interface GenerateNarrativeThreadPlanCandidateInput {
  modelId: string
  writingLanguage: WritingLanguage
  totalChapters: number
  blueprint: BlueprintData
  signal: AbortSignal
}

export interface GenerateNarrativeThreadEventCandidateInput {
  modelId: string
  writingLanguage: WritingLanguage
  plan: NarrativeThreadView
  draftId: number
  chapterNumber: number
  finalizedContent: string
  signal: AbortSignal
}

export interface NarrativeThreadCandidateGenerator {
  generatePlanCandidates(input: GenerateNarrativeThreadPlanCandidateInput): Promise<NarrativeThreadPlanCandidate[]>
  generateEventCandidates(input: GenerateNarrativeThreadEventCandidateInput): Promise<NarrativeThreadEventCandidate[]>
}

export interface NarrativeThreadCandidateGeneratorDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions): Promise<GenerationRuntime>
}

export const NARRATIVE_THREAD_CANDIDATE_BUDGET = Object.freeze({
  maxAttempts: 1,
  maxRequestedOutputTokens: 4096,
  maxRequestedOutputTokensPerAttempt: 4096,
  deadlineMs: 120_000,
})

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

const MAX_PLAN_CANDIDATES = 8
const MAX_EVENT_CANDIDATES = 5

function candidatesFromJson(content: string, limit: number): unknown[] {
  const parsed = record(JSON.parse(content.trim()))
  return Array.isArray(parsed?.candidates) ? parsed.candidates.slice(0, limit) : []
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maxLength ? text : null
}

export function parseNarrativeThreadPlanCandidates(
  content: string,
  totalChapters: number,
): NarrativeThreadPlanCandidate[] {
  return candidatesFromJson(content, MAX_PLAN_CANDIDATES).flatMap((candidate) => {
    const value = record(candidate)
    if (!value) return []
    const title = boundedText(value.title, 120)
    const type = boundedText(value.type, 60)
    const authorIntent = boundedText(value.authorIntent, 1000)
    const targetStartChapter = value.targetStartChapter
    const targetEndChapter = value.targetEndChapter
    if (!title || !type || !authorIntent
      || !Number.isSafeInteger(targetStartChapter) || (targetStartChapter as number) < 1
      || (targetStartChapter as number) > totalChapters
      || !Number.isSafeInteger(targetEndChapter) || (targetEndChapter as number) < (targetStartChapter as number)
      || (targetEndChapter as number) > totalChapters) {
      return []
    }
    return [{
      title,
      type,
      targetStartChapter: targetStartChapter as number,
      targetEndChapter: targetEndChapter as number,
      authorIntent,
    }]
  })
}

export function parseNarrativeThreadEventCandidates(
  content: string,
  finalizedContent: string,
): NarrativeThreadEventCandidate[] {
  const normalizedSource = finalizedContent.replace(/\s+/gu, '')
  return candidatesFromJson(content, MAX_EVENT_CANDIDATES).flatMap((candidate) => {
    const value = record(candidate)
    if (!value || !['planted', 'progressing', 'resolved', 'abandoned'].includes(String(value.type))) return []
    const evidence = boundedText(value.evidence, 240)
    const reason = boundedText(value.reason, 500)
    if (!evidence || !reason || !normalizedSource.includes(evidence.replace(/\s+/gu, ''))) return []
    return [{ type: value.type as NarrativeThreadEventType, evidence, reason }]
  })
}

export function createNarrativeThreadCandidateGenerator(
  dependencies: NarrativeThreadCandidateGeneratorDependencies = {
    createRuntime: options => createGenerationRuntime(options),
  },
): NarrativeThreadCandidateGenerator {
  return {
    async generatePlanCandidates(input) {
      const runtime = await dependencies.createRuntime({
        budget: NARRATIVE_THREAD_CANDIDATE_BUDGET,
        modelId: input.modelId,
      })
      try {
        const outcome = await runtime.execute(({ session }) => session.complete({
          purpose: 'narrative-thread-plan-candidate',
          reasoningStage: 'planning',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: internalPrompt('narrative_thread_candidates_system', input.writingLanguage, {
                total_chapters: input.totalChapters,
              }),
            },
            {
              role: 'user',
              content: JSON.stringify({
                totalChapters: input.totalChapters,
                blueprint: input.blueprint,
              }),
            },
          ],
        }, { signal: input.signal }))
        if (outcome.status !== 'completed' || outcome.finishReason !== 'stop') {
          throw new Error(promptLanguageText(
            input.writingLanguage,
            '叙事线索计划候选生成未完整完成',
            'Narrative-thread plan candidate generation did not complete.',
          ))
        }
        const candidates = parseNarrativeThreadPlanCandidates(outcome.content, input.totalChapters)
        if (candidates.length === 0) throw new Error(promptLanguageText(
          input.writingLanguage,
          '模型未返回有效的叙事线索计划候选',
          'The model did not return any valid narrative-thread plan candidates.',
        ))
        return candidates
      } finally {
        await runtime.close().catch(() => {})
      }
    },
    async generateEventCandidates(input) {
      const runtime = await dependencies.createRuntime({
        budget: NARRATIVE_THREAD_CANDIDATE_BUDGET,
        modelId: input.modelId,
      })
      try {
        const outcome = await runtime.execute(({ session }) => session.complete({
          purpose: 'narrative-thread-event-candidate',
          reasoningStage: 'review',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: internalPrompt('narrative_thread_fact_review_system', input.writingLanguage),
            },
            {
              role: 'user',
              content: JSON.stringify({
                chapterNumber: input.chapterNumber,
                plan: {
                  title: input.plan.title,
                  type: input.plan.type,
                  targetStartChapter: input.plan.targetStartChapter,
                  targetEndChapter: input.plan.targetEndChapter,
                  authorIntent: input.plan.authorIntent,
                  currentStatus: input.plan.status,
                },
                finalizedContent: input.finalizedContent,
              }),
            },
          ],
        }, { signal: input.signal }))
        if (outcome.status !== 'completed' || outcome.finishReason !== 'stop') {
          throw new Error(promptLanguageText(
            input.writingLanguage,
            '叙事线索事件候选生成未完整完成',
            'Narrative-thread event candidate generation did not complete.',
          ))
        }
        const candidates = parseNarrativeThreadEventCandidates(outcome.content, input.finalizedContent)
        if (candidates.length === 0) throw new Error(promptLanguageText(
          input.writingLanguage,
          '模型未返回带有效定稿证据的事件候选',
          'The model did not return any event candidates with valid finalized-manuscript evidence.',
        ))
        return candidates
      } finally {
        await runtime.close().catch(() => {})
      }
    },
  }
}

export const narrativeThreadCandidateGenerator = createNarrativeThreadCandidateGenerator()

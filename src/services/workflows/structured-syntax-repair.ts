import type { GenerationTask } from '../generation/generation-harness'
import type { WritingLanguage } from '../../shared/writing-language'
import { internalPrompt } from '../../prompts/internal/load'

export const MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES = 32_768
export const MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES = 32_768

export function structuredRepairUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function isRepairableDirectJsonSyntaxFailure(content: string): boolean {
  const candidate = content.trim()
  if (!/^[{[]/u.test(candidate)) return false
  try {
    JSON.parse(candidate)
    return false
  } catch {
    return true
  }
}

export function buildStructuredSyntaxRepairTask(
  originalTask: GenerationTask,
  repairContract: string,
  malformedCandidate: string,
  writingLanguage: WritingLanguage,
): GenerationTask {
  const systemMessage = internalPrompt('structured_syntax_repair_system', writingLanguage)
  const userMessage = internalPrompt('structured_syntax_repair_task', writingLanguage, {
    repair_contract: repairContract,
    malformed_candidate: malformedCandidate,
  })
  const currentEvidenceBytes = structuredRepairUtf8Bytes(repairContract)
    + structuredRepairUtf8Bytes(malformedCandidate)
  const fixedRequestBytes = structuredRepairUtf8Bytes(systemMessage)
    + structuredRepairUtf8Bytes(userMessage)
    - currentEvidenceBytes
  return {
    purpose: `${originalTask.purpose}:structured-syntax-repair`,
    reasoningStage: 'planning',
    output: 'structured-data',
    messages: [
      {
        role: 'system',
        content: systemMessage,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ],
    promptBudget: {
      limitUtf8Bytes: fixedRequestBytes
        + MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES
        + MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES,
      sections: [
        { sectionName: 'system-instructions', messageIndex: 0, finalText: systemMessage },
        {
          sectionName: 'repair-contract',
          messageIndex: 1,
          finalText: repairContract,
          limitUtf8Bytes: MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES,
        },
        {
          sectionName: 'repair-candidate',
          messageIndex: 1,
          finalText: malformedCandidate,
          limitUtf8Bytes: MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES,
        },
      ],
    },
  }
}

interface JsonLexicalEvidence {
  scalars: string[]
  containers: string
}

function lexicalEvidence(source: string): JsonLexicalEvidence | undefined {
  const scalars: string[] = []
  let containers = ''
  // 规范词法模式：匹配双引号字符串、数字字面量、布尔/null字面量以及容器括号
  const tokenPattern = /"((?:[^"\\]|\\.)*)"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\]])/gu
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(source)) !== null) {
    if (match[1] !== undefined) {
      try {
        scalars.push(`s:${JSON.stringify(JSON.parse(match[0]))}`)
      } catch {
        return undefined
      }
    } else if (match[2] !== undefined) {
      scalars.push(`n:${match[2]}`)
    } else if (match[3] !== undefined) {
      scalars.push(`l:${match[3]}`)
    } else if (match[4] !== undefined) {
      containers += match[4]
    }
  }
  return { scalars, containers }
}

/**
 * Repair may alter JSON punctuation only. Scalar evidence and container shape
 * must remain identical; the sole exception is appending missing closers.
 */
export function preservesStructuredJsonEvidence(candidate: string, repaired: string): boolean {
  try {
    JSON.parse(repaired.trim())
  } catch {
    return false
  }
  const before = lexicalEvidence(candidate.trim())
  const after = lexicalEvidence(repaired.trim())
  if (!before || !after || before.scalars.length !== after.scalars.length) return false
  if (before.scalars.some((token, index) => token !== after.scalars[index])) return false
  if (before.containers === after.containers) return true
  if (!after.containers.startsWith(before.containers)) return false
  return /^[\]}]+$/u.test(after.containers.slice(before.containers.length))
}

/**
 * 自定义 Hook：提取与当前章节草稿匹配的待确认修改提案 (Draft Diff Proposals)
 *
 * 监听 AgentStore 中处于 waiting_confirm 状态的 replace_draft_excerpt 工具调用，
 * 并将其转换为草稿编辑器可以直接消费和渲染的 DraftDiffProposal 结构。
 */
import { useMemo } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import type { DraftDiffProposal } from './draft-diff'

export function useDraftDiffProposals(
  chapterNumber?: number,
  draftId?: number,
): DraftDiffProposal[] {
  const conversations = useAgentStore(s => s.conversations)

  return useMemo(() => {
    const proposals: DraftDiffProposal[] = []

    for (const conv of conversations) {
      for (const msg of conv.messages) {
        if (!msg.toolCalls || msg.toolCalls.length === 0) continue

        for (const tc of msg.toolCalls) {
          if (tc.toolName !== 'replace_draft_excerpt' || tc.status !== 'waiting_confirm') {
            continue
          }

          const args = tc.arguments ?? {}
          const tcChapter = typeof args.chapter_number === 'number'
            ? args.chapter_number
            : parseInt(String(args.chapter_number ?? ''), 10)
          const tcDraftId = args.draft_id != null ? Number(args.draft_id) : undefined

          // 章节或草稿 ID 匹配检测
          let matches = false
          if (chapterNumber != null && !Number.isNaN(tcChapter) && tcChapter === chapterNumber) {
            matches = true
          } else if (draftId != null && tcDraftId != null && tcDraftId === draftId) {
            matches = true
          } else if (chapterNumber == null && draftId == null) {
            matches = true
          }

          if (!matches) continue

          const oldText = String(args.old_text ?? '')
          const newText = String(args.new_text ?? '')

          if (!oldText) continue

          proposals.push({
            id: tc.id,
            chapterNumber: !Number.isNaN(tcChapter) ? tcChapter : undefined,
            draftId: tcDraftId,
            oldText,
            newText,
            status: 'pending',
            onAccept: () => {
              useAgentStore.getState().resolveToolConfirmation(tc.id, true)
            },
            onReject: () => {
              useAgentStore.getState().resolveToolConfirmation(tc.id, false)
            },
          })
        }
      }
    }

    return proposals
  }, [conversations, chapterNumber, draftId])
}

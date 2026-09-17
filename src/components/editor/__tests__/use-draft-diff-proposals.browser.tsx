import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useAgentStore, type AgentConversation } from '../../../stores/agent-store'
import { useDraftDiffProposals } from '../use-draft-diff-proposals'
import type { DraftDiffProposal } from '../draft-diff'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useAgentStore.setState({
    conversations: [],
    activeConversationId: 'conv-1',
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

// eslint-disable-next-line react-refresh/only-export-components -- browser-only test shell
function TestConsumer({
  chapterNumber,
  draftId,
  onProposals,
}: {
  chapterNumber?: number
  draftId?: number
  onProposals: (proposals: DraftDiffProposal[]) => void
}) {
  const proposals = useDraftDiffProposals(chapterNumber, draftId)
  onProposals(proposals)
  return <div>{proposals.length}</div>
}

describe('useDraftDiffProposals hook', () => {
  it('extracts matching proposals waiting for confirmation and triggers callbacks', async () => {
    const resolveSpy = vi.fn()
    useAgentStore.setState({ resolveToolConfirmation: resolveSpy })

    const testConv: AgentConversation = {
      id: 'conv-1',
      title: '测试会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'planning',
      modelId: null,
      thinkingLevel: null,
      scope: 'project',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: '我来修改第一章',
          createdAt: Date.now(),
          toolCalls: [
            {
              id: 'tc-1',
              toolName: 'replace_draft_excerpt',
              status: 'waiting_confirm',
              arguments: {
                chapter_number: 1,
                old_text: '原文句子',
                new_text: '新替换句子',
              },
            },
            {
              id: 'tc-2',
              toolName: 'replace_draft_excerpt',
              status: 'completed', // 已完成，不应包含
              arguments: {
                chapter_number: 1,
                old_text: '旧完成',
                new_text: '新完成',
              },
            },
            {
              id: 'tc-3',
              toolName: 'replace_draft_excerpt',
              status: 'waiting_confirm',
              arguments: {
                chapter_number: 2, // 第 2 章
                old_text: '第2章原文',
                new_text: '第2章新文',
              },
            },
          ],
        },
      ],
    }

    useAgentStore.setState({ conversations: [testConv] })

    let latestProposals: DraftDiffProposal[] = []
    await act(async () => {
      root.render(
        <TestConsumer
          chapterNumber={1}
          onProposals={(p) => {
            latestProposals = p
          }}
        />,
      )
    })

    expect(latestProposals).toHaveLength(1)
    expect(latestProposals[0].id).toBe('tc-1')
    expect(latestProposals[0].oldText).toBe('原文句子')
    expect(latestProposals[0].newText).toBe('新替换句子')
    expect(latestProposals[0].status).toBe('pending')

    // 触发 accept
    latestProposals[0].onAccept?.()
    expect(resolveSpy).toHaveBeenCalledWith('tc-1', true)

    // 触发 reject
    latestProposals[0].onReject?.()
    expect(resolveSpy).toHaveBeenCalledWith('tc-1', false)

    // 切换到第 2 章
    await act(async () => {
      root.render(
        <TestConsumer
          chapterNumber={2}
          onProposals={(p) => {
            latestProposals = p
          }}
        />,
      )
    })

    expect(latestProposals).toHaveLength(1)
    expect(latestProposals[0].id).toBe('tc-3')

    // 切换到第 3 章（无匹配）
    await act(async () => {
      root.render(
        <TestConsumer
          chapterNumber={3}
          onProposals={(p) => {
            latestProposals = p
          }}
        />,
      )
    })

    expect(latestProposals).toHaveLength(0)
  })
})

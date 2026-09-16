import { describe, expect, it } from 'vitest'

import {
  parseAgentConversationArchive,
  serializeAgentConversationArchive,
  toAgentPromptHistory,
} from '../agent-conversation-archive'

describe('agent conversation archive', () => {
  it('round-trips conversations and drops empty streaming placeholders', () => {
    const json = serializeAgentConversationArchive([
      {
        id: 'c1',
        title: '检查项目',
        createdAt: 1,
        updatedAt: 2,
        mode: 'fast',
        modelId: 'm1',
        messages: [
          { id: 'u1', role: 'user', content: '你好', createdAt: 1 },
          { id: 'a1', role: 'assistant', content: '在', createdAt: 2 },
        ],
      },
    ], 'c1')
    const archive = parseAgentConversationArchive(JSON.parse(json))
    expect(archive.activeConversationId).toBe('c1')
    expect(archive.conversations[0]?.messages).toHaveLength(2)
  })

  it('returns an empty archive for a missing file', () => {
    expect(parseAgentConversationArchive(null)).toEqual({
      version: 1,
      activeConversationId: null,
      conversations: [],
    })
  })

  it('round-trips the per-conversation thinking level and drops junk', () => {
    const json = serializeAgentConversationArchive([
      {
        id: 'c1',
        title: '思考等级',
        createdAt: 1,
        updatedAt: 2,
        mode: 'planning',
        modelId: 'm1',
        thinkingLevel: 'high',
        messages: [{ id: 'u1', role: 'user', content: '你好', createdAt: 1 }],
      },
      {
        id: 'c2',
        title: '脏数据',
        createdAt: 1,
        updatedAt: 2,
        mode: 'planning',
        modelId: null,
        // 存档来自磁盘，等级是外部输入：认不出来就退回"不指定"。
        thinkingLevel: 'max' as never,
        messages: [{ id: 'u2', role: 'user', content: '你好', createdAt: 1 }],
      },
    ], 'c1')

    const archive = parseAgentConversationArchive(JSON.parse(json))
    expect(archive.conversations[0]?.thinkingLevel).toBe('high')
    expect(archive.conversations[1]?.thinkingLevel).toBeNull()
  })

  it('rejects a corrupt archive', () => {
    expect(() => parseAgentConversationArchive({ version: 2, conversations: [] }))
      .toThrow(/版本/)
  })

  it('builds model history from user and assistant text only', () => {
    expect(toAgentPromptHistory([
      { role: 'system', content: 'hidden' },
      { role: 'user', content: '第一章怎么写' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '先写钩子' },
    ])).toEqual([
      { role: 'user', content: '第一章怎么写' },
      { role: 'assistant', content: '先写钩子' },
    ])
  })
})

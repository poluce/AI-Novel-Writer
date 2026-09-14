import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core'

import { AgentConversationStore, projectContext } from '../agent-conversation-store'

const roots: string[] = []

function temporaryProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-agent-sessions-'))
  roots.push(root)
  return root
}

function userMessage(content: string, timestamp = Date.now()): AgentMessage {
  return { role: 'user', content, timestamp }
}

function assistantMessage(content: string, timestamp = Date.now()): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text: content }], timestamp } as AgentMessage
}

function toolResult(timestamp = Date.now()): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read_drafts',
    content: [{ type: 'text', text: '第三章正文' }],
    isError: false,
    timestamp,
  } as AgentMessage
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('AgentConversationStore', () => {
  it('round-trips a conversation, keeping tool turns and their structure', async () => {
    const projectPath = temporaryProject()
    const store = new AgentConversationStore(projectPath)
    await store.appendMessages('conv-1', [
      userMessage('看看第三章'),
      assistantMessage('好的。'),
      toolResult(),
      assistantMessage('第三章节奏偏慢。'),
    ])
    await store.close()

    const reopened = new AgentConversationStore(projectPath)
    const snapshot = await reopened.load('conv-1')
    expect(snapshot?.messages.map(message => message.role))
      .toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    expect(snapshot?.previousCompaction).toBeUndefined()
    // 存档落在项目 .vela 下，文件树看不到。
    const files = fs.readdirSync(path.join(projectPath, '.vela', 'agent-sessions'), { recursive: true })
    expect(files.some(entry => String(entry).endsWith('.jsonl'))).toBe(true)
    await reopened.close()
  })

  it('returns null for a conversation that was never stored', async () => {
    const store = new AgentConversationStore(temporaryProject())
    expect(await store.load('missing')).toBeNull()
    await store.close()
  })

  it('keeps only the summary and retained tail after a compaction', async () => {
    const projectPath = temporaryProject()
    const store = new AgentConversationStore(projectPath)
    const summarized = [userMessage('很早的问题'), assistantMessage('很早的回答')]
    const retained = [userMessage('最近的问题'), assistantMessage('最近的回答')]
    await store.appendMessages('conv-1', [...summarized, ...retained])
    await store.recordCompaction('conv-1', {
      summary: '用户问了很早的问题，助手回答了。',
      tokensBefore: 4096,
      retainedTail: retained,
    })
    await store.appendMessages('conv-1', [userMessage('压缩之后的新问题')])
    await store.close()

    const reopened = new AgentConversationStore(projectPath)
    const snapshot = await reopened.load('conv-1')
    expect(snapshot?.messages.map(message => message.role))
      .toEqual(['compactionSummary', 'user', 'assistant', 'user'])
    expect(snapshot?.messages[0]).toMatchObject({ role: 'compactionSummary' })
    expect(JSON.stringify(snapshot?.messages[0])).toContain('很早的问题')
    expect(JSON.stringify(snapshot?.messages)).not.toContain('很早的回答')
    expect(snapshot?.previousCompaction?.tokensBefore).toBe(4096)
    await reopened.close()
  })

  it('deletes the stored session with the conversation', async () => {
    const projectPath = temporaryProject()
    const store = new AgentConversationStore(projectPath)
    await store.appendMessages('conv-1', [userMessage('hi')])
    await store.delete('conv-1')
    expect(await store.load('conv-1')).toBeNull()
    await store.close()
  })

  it('survives a store that cannot be written instead of failing the caller', async () => {
    const projectPath = temporaryProject()
    // 用一个文件占住 .vela/agent-sessions，写入必然失败。
    fs.mkdirSync(path.join(projectPath, '.vela'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.vela', 'agent-sessions'), 'not a directory')
    const store = new AgentConversationStore(projectPath)
    expect(await store.load('conv-1')).toBeNull()
    await store.close()
  })
})

describe('projectContext', () => {
  function messageEntry(id: string, message: AgentMessage, seq: number): Entry {
    return { id, parentId: null, seq, timestamp: Date.now(), type: 'message', message }
  }

  it('drops failed or aborted assistant turns from the restored context', () => {
    const failed = {
      role: 'assistant',
      content: [{ type: 'text', text: '半截回答' }],
      stopReason: 'error',
      timestamp: Date.now(),
    } as unknown as AgentMessage
    const snapshot = projectContext([
      messageEntry('a', userMessage('问题'), 0),
      messageEntry('b', failed, 1),
      messageEntry('c', assistantMessage('正常回答'), 2),
    ])
    expect(snapshot.messages.map(message => message.role)).toEqual(['user', 'assistant'])
  })

  it('returns an empty context for an empty session', () => {
    expect(projectContext([])).toEqual({ messages: [] })
  })
})

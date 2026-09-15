import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  type AgentMessage,
  type Entry,
  type MessageEntry,
} from '@earendil-works/pi-agent-core'

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
    const store = AgentConversationStore.forProject(projectPath)
    await store.appendMessages('conv-1', [
      userMessage('看看第三章'),
      assistantMessage('好的。'),
      toolResult(),
      assistantMessage('第三章节奏偏慢。'),
    ])
    await store.close()

    const reopened = AgentConversationStore.forProject(projectPath)
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
    const store = AgentConversationStore.forProject(temporaryProject())
    expect(await store.load('missing')).toBeNull()
    await store.close()
  })

  it('keeps only the summary and retained tail after a compaction', async () => {
    const projectPath = temporaryProject()
    const store = AgentConversationStore.forProject(projectPath)
    const summarized = [userMessage('很早的问题'), assistantMessage('很早的回答')]
    const retained = [userMessage('最近的问题'), assistantMessage('最近的回答')]
    await store.appendMessages('conv-1', [...summarized, ...retained])
    const entry = await store.recordCompaction('conv-1', {
      summary: '用户问了很早的问题，助手回答了。',
      tokensBefore: 4096,
      retainedTail: retained,
    })
    // 写回的条目带着仓库分配的 seq/timestamp，会话侧要靠它做下一次增量摘要。
    expect(entry).toMatchObject({ type: 'compaction', tokensBefore: 4096 })
    expect(entry?.seq).toBeGreaterThan(0)
    await store.appendMessages('conv-1', [userMessage('压缩之后的新问题')])
    await store.close()

    const reopened = AgentConversationStore.forProject(projectPath)
    const snapshot = await reopened.load('conv-1')
    expect(snapshot?.messages.map(message => message.role))
      .toEqual(['compactionSummary', 'user', 'assistant', 'user'])
    expect(snapshot?.messages[0]).toMatchObject({ role: 'compactionSummary' })
    expect(JSON.stringify(snapshot?.messages[0])).toContain('很早的问题')
    expect(JSON.stringify(snapshot?.messages)).not.toContain('很早的回答')
    expect(snapshot?.previousCompaction?.tokensBefore).toBe(4096)

    // 读回来的压缩条目要能直接喂给 Pi 的 prepareCompaction：它据此做增量摘要，
    // 而不是把摘要当普通历史从零再写一遍。
    const afterCompaction: MessageEntry[] = (snapshot?.messages.slice(3) ?? []).map((message, index) => ({
      id: `after-${index}`,
      parentId: null,
      seq: 100 + index,
      timestamp: Date.now(),
      type: 'message',
      message,
    }))
    const next = prepareCompaction(
      [snapshot!.previousCompaction!, ...afterCompaction],
      DEFAULT_COMPACTION_SETTINGS,
    )
    expect(next.ok).toBe(true)
    if (next.ok && next.value) {
      expect(next.value.previousSummary).toBe('用户问了很早的问题，助手回答了。')
    }
    await reopened.close()
  })

  it('deletes the stored session with the conversation', async () => {
    const projectPath = temporaryProject()
    const store = AgentConversationStore.forProject(projectPath)
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
    const store = AgentConversationStore.forProject(projectPath)
    expect(await store.load('conv-1')).toBeNull()
    await store.close()
  })
})

describe('AgentConversationStore.forGlobal', () => {
  it('keeps the app assistant sessions under the app data root, outside any project', async () => {
    const appDataRoot = temporaryProject()
    const store = AgentConversationStore.forGlobal(appDataRoot)
    await store.appendMessages('conv-global', [userMessage('没打开项目时的提问')])
    await store.close()

    const reopened = AgentConversationStore.forGlobal(appDataRoot)
    const snapshot = await reopened.load('conv-global')
    expect(snapshot?.messages.map(message => message.role)).toEqual(['user'])
    let sessionsDir = ''
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.jsonl')) sessionsDir = full
      }
    }
    walk(path.join(appDataRoot, 'agent-sessions'))
    expect(sessionsDir).toContain(path.join('agent-sessions'))
    await reopened.close()
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

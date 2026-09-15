import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  BACKGROUND_CONTEXT,
  type AgentMessage,
  type Entry,
  type Session,
  type SessionMetadata,
} from '@earendil-works/pi-agent-core'

import { AgentConversationStore } from '../agent-conversation-store'

const roots: string[] = []

function temporaryProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-agent-sessions-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function userMessage(content: string, timestamp = Date.now()): AgentMessage {
  return { role: 'user', content, timestamp }
}

/** 直接往会话分支里写一条消息，模拟 harness 的落盘。 */
async function appendToSession(session: Session<SessionMetadata>, message: AgentMessage): Promise<void> {
  const existing = await session.branch('main', BACKGROUND_CONTEXT)
  const branch = existing ?? await session.createBranch('main', null, BACKGROUND_CONTEXT)
  await branch.appendMessage(message, BACKGROUND_CONTEXT)
}

async function entriesOf(session: Session<SessionMetadata>): Promise<Entry[]> {
  const branch = await session.branch('main', BACKGROUND_CONTEXT)
  return branch?.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT) ?? []
}

describe('AgentConversationStore', () => {
  it('creates a session inside the project and reopens the same file', async () => {
    const projectPath = temporaryProject()
    const store = AgentConversationStore.forProject(projectPath)
    const session = await store.open('conv-1', { create: true })
    expect(session).not.toBeNull()
    await appendToSession(session!, userMessage('看看第三章'))
    await store.close()

    // 存档落在项目 .vela 下，文件树看不到。
    const files = fs.readdirSync(path.join(projectPath, '.vela', 'agent-sessions'), { recursive: true })
    expect(files.some(entry => String(entry).endsWith('.jsonl'))).toBe(true)

    const reopened = AgentConversationStore.forProject(projectPath)
    const again = await reopened.open('conv-1')
    expect(again).not.toBeNull()
    const entries = await entriesOf(again!)
    expect(entries.map(entry => entry.type)).toEqual(['message'])
    await reopened.close()
  })

  it('returns null for a conversation that was never stored', async () => {
    const store = AgentConversationStore.forProject(temporaryProject())
    expect(await store.open('missing')).toBeNull()
    await store.close()
  })

  it('forgets a closed session so it can be reopened from disk', async () => {
    const projectPath = temporaryProject()
    const store = AgentConversationStore.forProject(projectPath)
    const session = await store.open('conv-1', { create: true })
    await appendToSession(session!, userMessage('第一轮'))
    // harness 关闭会话时会连 Pi 会话一起关掉，仓库不允许重复打开仍登记在册的会话。
    await session!.close(BACKGROUND_CONTEXT)
    store.forget('conv-1')

    const reopened = await store.open('conv-1')
    expect(reopened).not.toBeNull()
    expect((await entriesOf(reopened!)).length).toBe(1)
    await store.close()
  })

  it('deletes the stored session with the conversation', async () => {
    const projectPath = temporaryProject()
    const store = AgentConversationStore.forProject(projectPath)
    const session = await store.open('conv-1', { create: true })
    await appendToSession(session!, userMessage('hi'))
    await store.delete('conv-1')
    expect(await store.open('conv-1')).toBeNull()
    expect(fs.existsSync(path.join(projectPath, '.vela', 'agent-sessions'))).toBe(true)
    await store.close()
  })

  it('survives a store that cannot be written instead of failing the caller', async () => {
    const projectPath = temporaryProject()
    // 用一个文件占住 .vela/agent-sessions，打开会话必然失败。
    fs.mkdirSync(path.join(projectPath, '.vela'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.vela', 'agent-sessions'), 'not a directory')
    const store = AgentConversationStore.forProject(projectPath)
    expect(await store.open('conv-1', { create: true })).toBeNull()
    await store.close()
  })
})

describe('AgentConversationStore.forGlobal', () => {
  it('keeps the app assistant sessions under the app data root, outside any project', async () => {
    const appDataRoot = temporaryProject()
    const store = AgentConversationStore.forGlobal(appDataRoot)
    const session = await store.open('conv-global', { create: true })
    await appendToSession(session!, userMessage('没打开项目时的提问'))
    await store.close()

    const reopened = AgentConversationStore.forGlobal(appDataRoot)
    expect((await entriesOf((await reopened.open('conv-global'))!)).length).toBe(1)
    let sessionFile = ''
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.jsonl')) sessionFile = full
      }
    }
    walk(path.join(appDataRoot, 'agent-sessions'))
    expect(sessionFile).toContain(path.join('agent-sessions'))
    await reopened.close()
  })
})

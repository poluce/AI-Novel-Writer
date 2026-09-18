import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type AgentTool,
  type ExecutionEnv,
  type Session,
  type SessionMetadata,
} from '@earendil-works/pi-agent-core'
import { createModels, Type, type Context } from '@earendil-works/pi-ai'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'
import { branchTip, laneConfig, laneState } from '@earendil-works/pi-agent-core/harness/session'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'

import { fauxChatModel } from './faux-model'

import { AgentSession, AGENT_LANE_NAME } from '../agent-session'
import { ConfinedExecutionEnv } from '../confined-execution-env'
import type { PiAgentEvent } from '../agent-session'

const capturedContexts: Context[] = []

const AddSchema = Type.Object({ a: Type.Number(), b: Type.Number() })

const addTool: AgentTool<typeof AddSchema, { sum: number }> = {
  name: 'add_numbers',
  label: 'Add Numbers',
  description: 'Add two numbers.',
  parameters: AddSchema,
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: String(params.a + params.b) }],
    details: { sum: params.a + params.b },
  }),
}

interface Harness {
  session: AgentSession
  events: PiAgentEvent[]
  harnessSession: Session<SessionMetadata>
}

async function buildSession(options: {
  decision?: (callId: string) => boolean
  tools?: AgentTool<never, unknown>[]
  confirmationToolNames?: ReadonlySet<string>
  systemPrompt?: string
  harnessSession?: Session<SessionMetadata>
  responses?: FauxResponseStep[]
  compactionSettings?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
  contextWindow?: number
  withExecutionEnv?: boolean
  executionEnv?: ExecutionEnv
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high'
  applySamplingThinking?: boolean
} = {}): Promise<Harness> {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const model = fauxChatModel(faux)
  if (options.contextWindow !== undefined) model.contextWindow = options.contextWindow
  capturedContexts.length = 0

  const scripted = options.responses ?? [
    fauxAssistantMessage([fauxToolCall('add_numbers', { a: 12, b: 7 })]),
    fauxAssistantMessage('The sum is 19.'),
  ]
  faux.setResponses(scripted.map(step => (context: Context) => {
    capturedContexts.push(context)
    if (typeof step !== 'function') return step
    return step(
      context,
      undefined,
      { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] },
      undefined as never,
    )
  }))

  const repo = new MemorySessionRepo()
  const harnessSession = options.harnessSession ?? await repo.create({ id: 'conv-1' }, BACKGROUND_CONTEXT)

  const events: PiAgentEvent[] = []
  const harness: Harness = {
    session: undefined as unknown as AgentSession,
    events,
    harnessSession,
  }
  harness.session = await AgentSession.create({
    models,
    model,
    modelIdentity: { modelId: 'faux-model', modelName: 'faux-model' },
    systemPrompt: options.systemPrompt ?? 'You are a calculator.',
    tools: (options.tools ?? [addTool]) as never,
    ...(options.confirmationToolNames ? { confirmationToolNames: options.confirmationToolNames } : {}),
    ...(options.compactionSettings ? { compactionSettings: options.compactionSettings } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options.applySamplingThinking === undefined
      ? {}
      : { applySamplingThinking: options.applySamplingThinking }),
    language: 'zh-CN',
    ...(options.executionEnv
      ? { executionEnv: options.executionEnv }
      : options.withExecutionEnv
        ? { executionEnv: new NodeExecutionEnv({ cwd: os.tmpdir() }) }
        : {}),
    emit: (event) => {
      events.push(event)
      if (event.type === 'tool_call_confirm') {
        harness.session.confirm(event.call.id, (options.decision ?? (() => true))(event.call.id))
      }
    },
    session: harnessSession,
    conversationId: 'conv-1',
  })
  return harness
}

describe('AgentSession', () => {
  it('emits the full event sequence and executes a confirmed tool', async () => {
    const { session, events } = await buildSession({
      confirmationToolNames: new Set(['add_numbers']),
    })

    await session.prompt('What is 12 + 7?')
    await session.close()

    const types = events.map((e) => e.type)
    expect(types).toContain('text_delta')
    expect(types).toContain('tool_call_start')
    expect(types).toContain('tool_call_confirm')
    expect(types).toContain('tool_call_complete')
    expect(types).toContain('done')

    const complete = events.find((e) => e.type === 'tool_call_complete')
    expect(complete).toBeDefined()
    if (complete?.type === 'tool_call_complete') {
      expect(complete.call.status).toBe('completed')
      expect(complete.call.result).toEqual({ sum: 19 })
    }
    // 卡片先于确认请求到达渲染层（harness 的钩子先于 tool_start 事件）。
    expect(types.indexOf('tool_call_start')).toBeLessThan(types.indexOf('tool_call_confirm'))
  })

  it('blocks a declined tool and reports it as failed', async () => {
    const { session, events } = await buildSession({
      confirmationToolNames: new Set(['add_numbers']),
      decision: () => false,
    })

    await session.prompt('What is 12 + 7?')
    await session.close()

    const complete = events.find((e) => e.type === 'tool_call_complete')
    expect(complete).toBeDefined()
    if (complete?.type === 'tool_call_complete') {
      expect(complete.call.status).toBe('failed')
      expect(complete.call.error).toContain('用户拒绝执行')
    }
  })

  it('lets the harness persist every turn as session entries', async () => {
    const { session, harnessSession } = await buildSession({
      tools: [],
      responses: [fauxAssistantMessage('你好呀')],
    })

    await session.prompt('你好')

    const branch = await harnessSession.branch(AGENT_LANE_NAME, BACKGROUND_CONTEXT)
    const entries = await branch?.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT) ?? []
    expect(entries.map(entry => entry.type)).toEqual(['message', 'message'])
    expect(entries.map(entry => (entry.type === 'message' ? entry.message.role : '')))
      .toEqual(['user', 'assistant'])
    await session.close()
  })

  it('counts existing entries and seeds legacy text history only once', async () => {
    const { session, harnessSession } = await buildSession({ tools: [], systemPrompt: 's' })

    expect(await session.transcriptLength()).toBe(0)
    await session.seedHistory([
      { role: 'user', content: '上一本的问题' },
      { role: 'assistant', content: '上一本的回答' },
    ])
    expect(await session.transcriptLength()).toBe(2)
    await session.close()
    expect(harnessSession.metadata.id).toBe('conv-1')
  })

  it('restores context from the session and injects the L1 snapshot per turn', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const captured: Context[] = []
    faux.setResponses([
      (context) => {
        captured.push(context)
        return fauxAssistantMessage('第一轮')
      },
      (context) => {
        captured.push(context)
        return fauxAssistantMessage('第二轮')
      },
    ])

    const repo = new MemorySessionRepo()
    const harnessSession = await repo.create({ id: 'conv-1' }, BACKGROUND_CONTEXT)
    const session = await AgentSession.create({
      models,
      model: fauxChatModel(faux),
      modelIdentity: { modelId: 'faux-model', modelName: 'faux-model' },
      systemPrompt: 'You are a calculator.',
      tools: [],
      language: 'zh-CN',
      emit: () => {},
      session: harnessSession,
      conversationId: 'conv-1',
    })

    session.setEditorSnapshot({
      tabs: [],
      project: { open: true, name: '测试书', path: '/tmp/book' },
    })
    await session.prompt('第一问')
    await session.prompt('第二问')
    await session.close()

    expect(captured).toHaveLength(2)
    expect(captured[0].systemPrompt).toContain('You are a calculator.')
    expect(captured[0].systemPrompt).toContain('测试书')
    // 第二轮能看到第一轮的历史（由 harness 从会话条目恢复）。
    expect(captured[1].messages.length).toBeGreaterThan(captured[0].messages.length)
    expect(captured[0].messages).toHaveLength(1)
    expect(captured[0].messages[0].role).toBe('user')
    expect(JSON.stringify(captured[0].messages[0].content)).toContain('第一问')
  })

  it('mounts the Pi harness execution tools only when an environment is given', async () => {
    const withoutEnv = await buildSession({ tools: [] })
    await withoutEnv.session.prompt('你好')
    await withoutEnv.session.close()
    const firstContext = capturedContexts.at(-1)
    expect(firstContext?.tools?.map(tool => tool.name)).not.toContain('bash')

    const withEnv = await buildSession({ tools: [], withExecutionEnv: true })
    await withEnv.session.prompt('你好')
    await withEnv.session.close()
    const secondContext = capturedContexts.at(-1)
    const names = secondContext?.tools?.map(tool => tool.name) ?? []
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('edit')
    expect(names).toContain('bash')
  })

  it('confirms harness write tools like the domain write tools', async () => {
    const { session, events } = await buildSession({
      tools: [],
      withExecutionEnv: true,
      confirmationToolNames: new Set(['bash']),
      decision: () => false,
      responses: [
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })]),
        fauxAssistantMessage('好，不跑了。'),
      ],
    })

    await session.prompt('帮我看看目录')
    await session.close()

    const confirm = events.find((e) => e.type === 'tool_call_confirm')
    expect(confirm).toBeDefined()
    if (confirm?.type === 'tool_call_confirm') expect(confirm.call.toolName).toBe('bash')
    const complete = events.find((e) => e.type === 'tool_call_complete')
    expect(complete?.type === 'tool_call_complete' && complete.call.status).toBe('failed')
  })

  it('keeps the harness execution tools after a per-turn domain tool refresh', async () => {
    // 管理器每轮都会用领域工具重设一次工具表；执行工具必须在重设后仍然在列，
    // 否则 harness 的 `activeToolNames ⊆ tools` 校验会让整轮以
    // "One or more configured tools are unavailable in this process" 告终。
    const { session, events } = await buildSession({
      tools: [addTool] as never,
      withExecutionEnv: true,
      responses: [fauxAssistantMessage('你好')],
    })

    await session.setTools([addTool] as never)
    await session.prompt('你好')
    await session.close()

    expect(events.some(event => event.type === 'error')).toBe(false)
    expect(events.some(event => event.type === 'done')).toBe(true)
  })

  it('records the requested thinking level in the lane configuration', async () => {
    // 用户在输入框选的思考等级要真的落到 harness 上：lane 配置是它每轮生成
    // 前读取的依据，也是"这一轮到底用哪一档"的唯一持久痕迹。
    const { session, harnessSession, events } = await buildSession({
      thinkingLevel: 'medium',
      applySamplingThinking: false,
      responses: [fauxAssistantMessage('你好')],
    })

    await session.prompt('你好')
    // 关会话会连内存存档一起关掉，配置要在关之前读。
    const stored = await harnessSession.getValue(laneConfig(AGENT_LANE_NAME), BACKGROUND_CONTEXT)
    await session.close()

    expect((stored?.value as { thinkingLevel?: string } | undefined)?.thinkingLevel).toBe('medium')
    expect(events.some(event => event.type === 'error')).toBe(false)
  })

  it('reconciles a persisted lane configuration with the current model and tools', async () => {
    // 上一次运行的存档可能钉着已经删掉的模型（或一份过期的工具名单），
    // harness 每次生成前都拿存档里的配置做校验，不对齐就会整轮失败在
    // "The configured model is unavailable in this process"。
    const repo = new MemorySessionRepo()
    const staleSession = await repo.create({ id: 'conv-stale' }, BACKGROUND_CONTEXT)
    await staleSession.setValue(branchTip(AGENT_LANE_NAME), null, BACKGROUND_CONTEXT)
    await staleSession.setValue(laneState(AGENT_LANE_NAME), {
      currentOperationId: null,
      lastOperationId: null,
      inbox: [],
    }, BACKGROUND_CONTEXT)
    await staleSession.setValue(laneConfig(AGENT_LANE_NAME), {
      model: { provider: 'removed-provider', modelId: 'removed-model' },
      thinkingLevel: 'off',
      activeToolNames: ['read', 'write', 'edit', 'bash'],
    }, BACKGROUND_CONTEXT)

    const { session, events } = await buildSession({
      tools: [addTool] as never,
      withExecutionEnv: true,
      harnessSession: staleSession,
      responses: [fauxAssistantMessage('你好')],
    })

    await session.prompt('你好')
    await session.close()

    expect(events.some(event => event.type === 'error')).toBe(false)
    expect(events.some(event => event.type === 'done')).toBe(true)
  })

  it('terminates the turn when a harness write leaves an unknown commit state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-unknown-commit-'))
    try {
      const env = new ConfinedExecutionEnv(new NodeExecutionEnv({ cwd: root }), [root], {
        writeTextAtomically: async () => {
          throw Object.assign(new Error('安全助手崩了'), { commitState: 'unknown' })
        },
      })
      const { session, events } = await buildSession({
        tools: [],
        executionEnv: env,
        confirmationToolNames: new Set(['write']),
        responses: [
          fauxAssistantMessage([fauxToolCall('write', { path: 'note.md', content: '正文' })]),
          fauxAssistantMessage('第二回合不该被请求'),
        ],
      })

      await session.prompt('写个文件')
      await session.close()

      const complete = events.find((e) => e.type === 'tool_call_complete')
      expect(complete?.type === 'tool_call_complete' && complete.call.status).toBe('failed')
      if (complete?.type === 'tool_call_complete') {
        expect(complete.call.error).toContain('提交态未知')
        expect(complete.call.result).toEqual({ commitState: 'unknown' })
      }
      // 终止本轮：模型没有机会自动重写一遍。
      expect(capturedContexts).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('bypasses confirmation for creative tools in writing mode while keeping confirmation in plan mode', async () => {
    // 1. 计划模式下：要求确认
    const planRun = await buildSession({
      tools: [addTool] as never,
      confirmationToolNames: new Set(['add_numbers']),
      decision: () => true,
      responses: [
        fauxAssistantMessage([fauxToolCall('add_numbers', { a: 1, b: 2 })]),
        fauxAssistantMessage('计算完成'),
      ],
    })
    planRun.session.setExecutionMode('plan')
    await planRun.session.prompt('加一下')
    await planRun.session.close()

    expect(planRun.events.some(e => e.type === 'tool_call_confirm')).toBe(true)

    // 2. 写作模式下：自动放行创作工具，无需确认
    const writingRun = await buildSession({
      tools: [addTool] as never,
      confirmationToolNames: new Set(['add_numbers']),
      responses: [
        fauxAssistantMessage([fauxToolCall('add_numbers', { a: 1, b: 2 })]),
        fauxAssistantMessage('计算完成'),
      ],
    })
    writingRun.session.setExecutionMode('writing')
    await writingRun.session.prompt('加一下')
    await writingRun.session.close()

    expect(writingRun.events.some(e => e.type === 'tool_call_confirm')).toBe(false)
    expect(writingRun.events.some(e => e.type === 'tool_call_complete')).toBe(true)
  })

  it('keeps confirmation for bash even in writing mode', async () => {
    const bashRun = await buildSession({
      tools: [],
      withExecutionEnv: true,
      confirmationToolNames: new Set(['bash']),
      decision: () => true,
      responses: [
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo 42' })]),
        fauxAssistantMessage('执行完毕'),
      ],
    })
    bashRun.session.setExecutionMode('writing')
    await bashRun.session.prompt('跑命令')
    await bashRun.session.close()

    expect(bashRun.events.some(e => e.type === 'tool_call_confirm')).toBe(true)
  })
})

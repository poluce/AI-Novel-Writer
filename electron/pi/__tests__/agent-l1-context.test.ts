import { describe, expect, it } from 'vitest'

import { buildL1AgentContext } from '../agent-l1-context'

describe('buildL1AgentContext', () => {
  it('returns null without tabs or a workflow', () => {
    expect(buildL1AgentContext({ tabs: [] }, 'zh-CN')).toBeNull()
    expect(buildL1AgentContext(null, 'zh-CN')).toBeNull()
  })

  it('formats editor tabs and truncates the active preview', () => {
    const preview = '林舟推开门。'.repeat(120)
    const text = buildL1AgentContext({
      tabs: [
        { name: '第1章', type: 'chapter', active: true, unsaved: true, preview },
        { name: '角色卡', type: 'character', active: false, unsaved: false },
      ],
    }, 'zh-CN')

    expect(text).toContain('## 编辑器状态')
    expect(text).toContain('第1章 (chapter) [当前活跃] [未保存]')
    expect(text).toContain('角色卡 (character)')
    expect(text).toContain('当前活跃文件内容')
    expect(text).toContain('可通过 read_file 工具获取完整内容')
    expect(text).not.toContain('<tool_call>')
  })

  it('localizes labels and uses the workflow type in English', () => {
    const text = buildL1AgentContext({
      tabs: [{ name: 'Chapter 1', type: 'chapter', active: true, unsaved: false, preview: 'Hello' }],
      workflow: { title: '起草第一章', type: 'chapter_creation', currentStepIndex: 0, stepCount: 3 },
    }, 'en-US')

    expect(text).toContain('Editor state')
    expect(text).toContain('[active]')
    expect(text).toContain('Workflow status')
    expect(text).toContain('chapter_creation')
    expect(text).toContain('progress')
    expect(text).not.toContain('起草第一章')
    expect(text).not.toContain('编辑器状态')
  })
})

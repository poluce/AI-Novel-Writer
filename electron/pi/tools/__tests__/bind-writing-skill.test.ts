import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createBindWritingSkillTool } from '../bind-writing-skill.tool'

vi.mock('../../../services/writing-skill-binding-service', () => ({
  saveWritingSkillBinding: vi.fn(),
}))

import { saveWritingSkillBinding } from '../../../services/writing-skill-binding-service'

const saveMock = saveWritingSkillBinding as ReturnType<typeof vi.fn>

beforeEach(() => {
  saveMock.mockReset()
})

describe('bind_writing_skill', () => {
  it('binds a compatible skill to a stage', async () => {
    saveMock.mockResolvedValue(undefined)
    const tool = createBindWritingSkillTool('zh-CN')
    const result = await tool.execute('c1', { skill_id: 'user:scene-craft', stage: 'drafting' })
    const first = result.content[0]
    if (first.type === 'text') expect(first.text).toContain('scene-craft')
    expect(saveMock).toHaveBeenCalledWith('drafting', 'user:scene-craft')
  })

  it('rejects an invalid stage', async () => {
    const tool = createBindWritingSkillTool('zh-CN')
    // 运行期非法值：故意绕过 schema 类型，验证工具自身的参数校验。
    const invalidStage = { skill_id: 'user:scene-craft', stage: 'bogus' } as unknown as Parameters<typeof tool.execute>[1]
    await expect(tool.execute('c1', invalidStage)).rejects.toThrow('stage 无效')
  })
})

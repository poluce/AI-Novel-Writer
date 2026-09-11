import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createInspectWritingSkillTool } from '../inspect-writing-skill.tool'
import { createInstallWritingSkillTool } from '../install-writing-skill.tool'

vi.mock('../../../services/writing-skill-service', () => ({
  inspectWritingSkill: vi.fn(),
  installWritingSkill: vi.fn(),
}))

import { inspectWritingSkill, installWritingSkill } from '../../../services/writing-skill-service'

const inspectMock = inspectWritingSkill as ReturnType<typeof vi.fn>
const installMock = installWritingSkill as ReturnType<typeof vi.fn>

beforeEach(() => {
  inspectMock.mockReset()
  installMock.mockReset()
})

describe('inspect_writing_skill', () => {
  it('returns the inspection as JSON', async () => {
    inspectMock.mockResolvedValue({
      success: true,
      inspection: {
        metadata: { name: 'scene-craft', version: '1.0.0', language: 'zh-CN' },
        compatible: true,
        reasons: [],
        suggestedStage: 'drafting',
        utf8Bytes: 100,
        sourceUrl: 'https://github.com/x/y',
        resolvedUrl: 'https://raw.githubusercontent.com/x/y/main/SKILL.md',
        contentSha256: 'abc',
      },
    })

    const tool = createInspectWritingSkillTool('zh-CN')
    const result = await tool.execute('c1', { source_url: 'https://github.com/x/y' })
    const first = result.content[0]
    if (first.type === 'text') {
      expect(first.text).toContain('scene-craft')
      expect(first.text).toContain('"compatible": true')
    }
  })

  it('throws when inspection fails', async () => {
    inspectMock.mockResolvedValue({ success: false, error: '检查失败' })
    const tool = createInspectWritingSkillTool('zh-CN')
    await expect(tool.execute('c1', { source_url: 'https://github.com/x/y' })).rejects.toThrow('检查失败')
  })
})

describe('install_writing_skill', () => {
  it('reports the installed skill name', async () => {
    installMock.mockResolvedValue({ success: true, skill: { name: 'scene-craft', source: 'user', version: '1.0.0', language: 'zh-CN', compatible: true, utf8Bytes: 100 } })
    const tool = createInstallWritingSkillTool('zh-CN')
    const result = await tool.execute('c1', { source_url: 'https://github.com/x/y' })
    const first = result.content[0]
    if (first.type === 'text') expect(first.text).toContain('scene-craft')
  })
})

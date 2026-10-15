import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSkillCatalogEntry } from '../../../../src/shared/agent-skills'
import { createManageSkillsTool } from '../manage-skills.tool'

const mockState = vi.hoisted(() => ({
  currentProjectPath: null as string | null,
}))

vi.mock('../../../database', () => ({
  getCurrentProjectPath: () => mockState.currentProjectPath,
}))

const roots: string[] = []

function temporaryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-manage-skill-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // ignore
    }
  }
})

beforeEach(() => {
  mockState.currentProjectPath = temporaryDir()
})

const catalogSkills: AgentSkillCatalogEntry[] = [
  {
    name: 'review-chapter',
    description: '审阅章节剧情逻辑与人物一致性',
    location: 'managed://skills/review-chapter/SKILL.md',
    source: 'builtin',
    content: '# 章节审阅指南\n检查逻辑与人物性格。',
  },
  {
    name: 'scene-design',
    description: '场景五感精细设计',
    location: 'managed://skills/scene-design/SKILL.md',
    source: 'builtin',
    content: '# 场景五感设计\n细化视觉、听觉、触觉描写。',
  },
]

describe('manage_skills tool', () => {
  it('lists all available skills', async () => {
    const tool = createManageSkillsTool('zh-CN', catalogSkills)

    const result = await tool.execute('call-1', { action: 'list' })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''

    expect(text).toContain('review-chapter')
    expect(text).toContain('scene-design')
    expect(text).toContain('内置')
    expect(text).not.toContain('💡')
  })

  it('loads the full content of a skill by name (explicit action: "load")', async () => {
    const tool = createManageSkillsTool('zh-CN', catalogSkills)

    const result = await tool.execute('call-2', { action: 'load', name: 'review-chapter' })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''

    expect(text).toContain('<skill name="review-chapter"')
    expect(text).toContain('检查逻辑与人物性格。')
  })

  it('auto-defaults to "load" action when name is provided without explicit action', async () => {
    const tool = createManageSkillsTool('zh-CN', catalogSkills)

    const result = await tool.execute('call-3', { name: 'scene-design' } as never)
    const text = result.content[0].type === 'text' ? result.content[0].text : ''

    expect(text).toContain('<skill name="scene-design"')
    expect(text).toContain('细化视觉、听觉、触觉描写。')
  })

  it('rejects loading a non-existent skill with available skills list', async () => {
    const tool = createManageSkillsTool('zh-CN', catalogSkills)

    await expect(tool.execute('call-4', { action: 'load', name: 'unknown-skill' }))
      .rejects.toThrow('没有名为“unknown-skill”的技能')
  })

  it('creates a custom project skill and writes SKILL.md', async () => {
    const tool = createManageSkillsTool('zh-CN', catalogSkills)

    const result = await tool.execute('call-5', {
      action: 'create',
      name: 'action-combat',
      display_name: '动作打斗设计',
      description: '动作场面分镜拆解与节奏控制',
      content: '详细描写每一个招式与破绽。',
      scope: 'project',
    })

    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('成功创建并安装写作技能“action-combat”')

    // 检查磁盘上的文件
    const skillFile = path.join(mockState.currentProjectPath!, '.vela', 'skills', 'action-combat', 'SKILL.md')
    expect(fs.existsSync(skillFile)).toBe(true)
    const fileContent = fs.readFileSync(skillFile, 'utf8')
    expect(fileContent).toContain('name: action-combat')
    expect(fileContent).toContain('display_name: 动作打斗设计')
    expect(fileContent).toContain('详细描写每一个招式与破绽。')
  })

  it('updates an existing custom skill content and metadata', async () => {
    const tool = createManageSkillsTool('zh-CN', catalogSkills)

    // 先创建一个技能
    await tool.execute('call-6a', {
      action: 'create',
      name: 'my-custom',
      description: '旧描述',
      content: '旧正文',
      scope: 'project',
    })

    // 执行更新
    const updateResult = await tool.execute('call-6b', {
      action: 'update',
      name: 'my-custom',
      description: '新描述',
      content: '升级版高阶正文指引',
    })

    const text = updateResult.content[0].type === 'text' ? updateResult.content[0].text : ''
    expect(text).toContain('成功更新写作技能“my-custom”')

    const skillFile = path.join(mockState.currentProjectPath!, '.vela', 'skills', 'my-custom', 'SKILL.md')
    const updatedContent = fs.readFileSync(skillFile, 'utf8')
    expect(updatedContent).toContain('description: 新描述')
    expect(updatedContent).toContain('升级版高阶正文指引')
  })

  it('deletes a custom skill', async () => {
    const tool = createManageSkillsTool('zh-CN', catalogSkills)

    // 创建
    await tool.execute('call-7a', {
      action: 'create',
      name: 'temp-skill',
      content: '临时内容',
      scope: 'project',
    })

    // 删除
    const delResult = await tool.execute('call-7b', {
      action: 'delete',
      name: 'temp-skill',
    })
    expect(delResult.content[0].type === 'text' && delResult.content[0].text).toContain('已成功删除写作技能“temp-skill”')

    const skillDir = path.join(mockState.currentProjectPath!, '.vela', 'skills', 'temp-skill')
    expect(fs.existsSync(skillDir)).toBe(false)
  })

  it('protects builtin skills from deletion or modification', async () => {
    const tool = createManageSkillsTool('zh-CN', catalogSkills)

    await expect(tool.execute('call-8a', { action: 'delete', name: 'review-chapter' }))
      .rejects.toThrow('内置技能不可删除')

    await expect(tool.execute('call-8b', { action: 'update', name: 'review-chapter', content: 'hack' }))
      .rejects.toThrow('内置技能受保护只读')
  })
})

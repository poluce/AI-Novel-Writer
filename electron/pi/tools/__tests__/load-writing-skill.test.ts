import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentSkillCatalogEntry } from '../../../../src/shared/agent-skills'
import { createLoadWritingSkillTool } from '../load-writing-skill.tool'

const roots: string[] = []

function temporaryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-load-skill-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // 清理失败不该让用例变红。
    }
  }
})

/** 造一个真实技能文件，返回允许直读的根。 */
function onDiskSkill(body: string, snapshotBody: string): { root: string; entry: AgentSkillCatalogEntry } {
  const root = temporaryDir()
  const dir = path.join(root, 'scene-craft')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  fs.writeFileSync(file, `---\nname: scene-craft\ndescription: 场景塑造\n---\n${body}`, 'utf8')
  return {
    root,
    entry: {
      name: 'scene-craft',
      description: '场景塑造',
      location: file,
      source: 'user',
      content: snapshotBody,
    },
  }
}

const skills: AgentSkillCatalogEntry[] = [
  {
    name: 'scene-craft',
    description: '以有后果的选择推进场景。',
    location: 'managed://skills/scene-craft/SKILL.md',
    source: 'user',
    content: '每个场景围绕一次有代价的选择展开。',
  },
  {
    name: 'hidden',
    description: '不对外暴露的技能。',
    location: 'managed://skills/hidden/SKILL.md',
    source: 'user',
    disableModelInvocation: true,
    content: '不该被模型读到。',
  },
]

describe('load_writing_skill', () => {
  it('returns the skill body by name', async () => {
    const tool = createLoadWritingSkillTool('zh-CN', skills)
    const result = await tool.execute('c1', { name: 'scene-craft' })
    const first = result.content[0]
    expect(first.type).toBe('text')
    if (first.type === 'text') expect(first.text).toContain('有代价的选择')
    expect(result.details).toMatchObject({ name: 'scene-craft', source: 'user' })
  })

  it('trims the name and rejects an unknown skill with the available list', async () => {
    const tool = createLoadWritingSkillTool('zh-CN', skills)
    await expect(tool.execute('c1', { name: 'nope' })).rejects.toThrow(/没有名为“nope”的技能/)
  })

  it('never serves a skill the model may not invoke', async () => {
    const tool = createLoadWritingSkillTool('zh-CN', skills)
    await expect(tool.execute('c1', { name: 'hidden' })).rejects.toThrow(/没有名为“hidden”的技能/)
  })

  it('reports a skill without a readable body instead of returning nothing', async () => {
    const tool = createLoadWritingSkillTool('en-US', [{
      name: 'empty',
      description: 'Empty skill',
      location: 'builtin://empty',
      source: 'builtin',
    }])
    await expect(tool.execute('c1', { name: 'empty' })).rejects.toThrow(/no readable body/)
  })
})

describe('load_writing_skill body source', () => {
  it('reads the body from disk so later edits win over the catalog snapshot', async () => {
    const { root, entry } = onDiskSkill('磁盘上的新正文。', '目录快照里的旧正文。')
    const tool = createLoadWritingSkillTool('zh-CN', [entry], [root])

    const result = await tool.execute('c1', { name: 'scene-craft' })
    const first = result.content[0]
    expect(first.type === 'text' && first.text).toContain('磁盘上的新正文')
    expect((result.details as { baseDir?: string }).baseDir).toBe(path.dirname(entry.location))
  })

  it('falls back to the snapshot when the file is outside the allowed roots', async () => {
    const { entry } = onDiskSkill('磁盘正文。', '快照正文。')
    const tool = createLoadWritingSkillTool('zh-CN', [entry], [temporaryDir()])

    const result = await tool.execute('c1', { name: 'scene-craft' })
    const first = result.content[0]
    expect(first.type === 'text' && first.text).toContain('快照正文')
  })

  it('falls back to the snapshot when no root is configured', async () => {
    const { entry } = onDiskSkill('磁盘正文。', '快照正文。')
    const tool = createLoadWritingSkillTool('zh-CN', [entry])

    const result = await tool.execute('c1', { name: 'scene-craft' })
    const first = result.content[0]
    expect(first.type === 'text' && first.text).toContain('快照正文')
  })

  it('falls back to the snapshot when the file disappeared', async () => {
    const { root, entry } = onDiskSkill('磁盘正文。', '快照正文。')
    fs.rmSync(path.dirname(entry.location), { recursive: true, force: true })
    const tool = createLoadWritingSkillTool('zh-CN', [entry], [root])

    const result = await tool.execute('c1', { name: 'scene-craft' })
    const first = result.content[0]
    expect(first.type === 'text' && first.text).toContain('快照正文')
  })
})
